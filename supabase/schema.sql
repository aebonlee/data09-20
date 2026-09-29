-- ============================================================================
-- data09-20 — 예약 가능한 테니스 코트 조회
-- Supabase(PostgreSQL) 스키마 + RLS
--
--  무엇인가 : 지금 브라우저 localStorage 에 두는 코트·예약 슬롯·검색 조건을 DB 로 옮길 때 쓸
--             표 구조입니다(기획서 11장 Court · Availability · SearchCondition). 앱 연결은 다음 단계입니다.
--  실행 위치 : 수강생 본인 Supabase 프로젝트의 SQL Editor 에서 실행
--  재실행    : 안전합니다 (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS 선행)
--
--  본인 프로젝트에 올리는 것을 전제로 하므로 표 이름에 접두사를 붙이지 않았습니다.
--  Supabase 주소·키, 네이버 API 키는 이 파일 어디에도 없습니다.
--
--  표 목록                                          ← 지금 앱의 저장 위치
--    courts             코트 (기획서 11.1 Court)       ← localStorage 'data09-20.db' .courts
--    court_slots        예약 가능 슬롯 (11.3)          ← .slots
--    search_conditions  검색 조건 (11.2)               ← .cond (최근 조건, 여러 개 저장 가능)
--
--  설계 메모
--    · 기획서 11.1 의 distance(기준점과의 거리)는 검색마다 달라지는 계산값이라 칸을 두지 않았습니다.
--    · 시간은 그 날 0시부터의 분(0~1440)으로 둡니다. 자정을 넘는 슬롯은 CHECK 로 막습니다(앱과 같은 규칙).
--    · court_slots 에는 「예약 가능」 슬롯만 적습니다. 그날을 확인했는데 가능 슬롯이 없으면
--      is_none = true 인 표시 행 하나를 둡니다(「미입력」과 「확인했고 없음」을 구분하기 위함).
--
--  보안
--    모든 표 RLS 켬. 행은 만든 사람(owner_id = auth.uid())만 보고 고칩니다.
--    슬롯은 자기 코트에만 달 수 있습니다(남의 court_id 로 넣으면 RLS 가 막음).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

create table if not exists public.courts (
  id                bigint generated always as identity primary key,
  owner_id          uuid not null default auth.uid(),
  court_name        text not null check (length(btrim(court_name)) > 0),
  address           text,
  latitude          double precision not null check (latitude between -90 and 90),
  longitude         double precision not null check (longitude between -180 and 180),
  telephone         text,
  naver_place_url   text check (naver_place_url is null or naver_place_url ~* '^https?://'),
  naver_booking_url text check (naver_booking_url is null or naver_booking_url ~* '^https?://'),
  booking_available text not null default 'unknown' check (booking_available in ('yes', 'no', 'unknown')),
  indoor_outdoor    text check (indoor_outdoor is null or indoor_outdoor in ('실내', '실외')),
  court_count       int check (court_count is null or court_count > 0),
  hours             text,                                               -- 운영시간 '06:00~23:00'
  slot_minutes      int not null default 30 check (slot_minutes in (10, 15, 20, 30, 60, 90, 120)),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- 앱은 같은 이름의 코트를 한 곳으로 봅니다(CSV 가져오기에서 고쳐 씀). ⚠ upsert 시 onConflict: 'owner_id,court_name'
  constraint courts_owner_name_key unique (owner_id, court_name)
);

create table if not exists public.court_slots (
  id            bigint generated always as identity primary key,
  owner_id      uuid not null default auth.uid(),
  court_id      bigint not null references public.courts(id) on delete cascade,
  slot_date     date not null,
  start_min     int not null check (start_min between 0 and 1440),
  end_min       int not null check (end_min between 0 and 1440),
  is_none       boolean not null default false,                       -- 「확인했고 가능 슬롯 없음」 표시 행
  last_updated  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- 자정 넘김 금지: 보통 슬롯은 끝 > 시작, 표시 행은 0~0
  constraint court_slots_range check ((not is_none and end_min > start_min) or (is_none and start_min = 0 and end_min = 0)),
  -- ⚠ upsert 시 onConflict: 'court_id,slot_date,start_min'
  constraint court_slots_key unique (court_id, slot_date, start_min)
);
create index if not exists court_slots_owner_date_idx on public.court_slots (owner_id, slot_date);

create table if not exists public.search_conditions (
  id                bigint generated always as identity primary key,
  owner_id          uuid not null default auth.uid(),
  center_address    text,                                             -- 기준 위치 이름(메모)
  center_latitude   double precision not null check (center_latitude between -90 and 90),
  center_longitude  double precision not null check (center_longitude between -180 and 180),
  radius_km         numeric not null check (radius_km > 0 and radius_km <= 100),
  start_date        date not null,
  end_date          date not null,
  start_time        int not null check (start_time between 0 and 1440),   -- 분
  end_time          int not null check (end_time between 0 and 1440),
  minimum_duration  int not null check (minimum_duration > 0),            -- 분
  booking_only      boolean not null default true,
  match_only        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- 앱 validateCond 와 같은 규칙
  constraint search_conditions_dates check (end_date >= start_date and end_date - start_date < 62),
  constraint search_conditions_times check (end_time > start_time and minimum_duration <= end_time - start_time)
);

-- ----------------------------------------------------------------------------
-- 2. 함수 · 트리거 (search_path 고정)
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

do $trg$
declare t text;
begin
  foreach t in array array['courts','court_slots','search_conditions']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()', t || '_updated_at', t);
  end loop;
end;
$trg$;

-- ----------------------------------------------------------------------------
-- 3. RLS — 본인 행만. 슬롯은 자기 코트에만.
-- ----------------------------------------------------------------------------

alter table public.courts            enable row level security;
alter table public.court_slots       enable row level security;
alter table public.search_conditions enable row level security;

do $rls$
declare t text;
begin
  foreach t in array array['courts','search_conditions']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = auth.uid())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (owner_id = auth.uid())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid())', t || '_delete', t);
  end loop;
end;
$rls$;

drop policy if exists court_slots_select on public.court_slots;
drop policy if exists court_slots_insert on public.court_slots;
drop policy if exists court_slots_update on public.court_slots;
drop policy if exists court_slots_delete on public.court_slots;
create policy court_slots_select on public.court_slots for select to authenticated using (owner_id = auth.uid());
create policy court_slots_insert on public.court_slots for insert to authenticated
  with check (owner_id = auth.uid()
              and exists (select 1 from public.courts c where c.id = court_id and c.owner_id = auth.uid()));
create policy court_slots_update on public.court_slots for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid()
              and exists (select 1 from public.courts c where c.id = court_id and c.owner_id = auth.uid()));
create policy court_slots_delete on public.court_slots for delete to authenticated using (owner_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 4. 함수 실행 권한
--
--  GRANT 만으로는 제한되지 않습니다. PostgreSQL 이 PUBLIC 에, Supabase 가
--  ALTER DEFAULT PRIVILEGES 로 anon 에 EXECUTE 를 미리 붙이므로 둘 다 끊습니다.
-- ----------------------------------------------------------------------------

revoke all on function public.set_updated_at() from public, anon;
-- 트리거 전용 함수는 authenticated 를 남깁니다(트리거 발화 시 호출자 권한 검사 대비).
grant execute on function public.set_updated_at() to authenticated;

-- ----------------------------------------------------------------------------
-- 끝.
-- ----------------------------------------------------------------------------
