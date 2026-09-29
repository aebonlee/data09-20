-- ============================================================================
-- 로컬 검증 전용 — data09-20 프로젝트별 검증 (운영 실행 금지, 가드 내장)
--
--  사용자 흉내: set role authenticated + request.jwt.claim.sub 에 uuid 를 넣으면
--  스텁의 auth.uid() 가 그 값을 돌려줍니다. anon 은 set role anon.
-- ============================================================================
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다. 운영 데이터베이스에서 실행할 수 없습니다.';
  end if;
end;
$guard$;

-- 문장이 지정한 SQLSTATE 로 실패하는지 본다. (이름이 _assert 로 시작해 권한 검사에서 빠진다)
create or replace function public._assert_raises(p_sql text, p_state text, p_label text)
returns void language plpgsql set search_path = public as $fn$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
  end;
  if v_state is not distinct from p_state then raise notice '  OK   %', p_label;
  else raise exception 'FAIL  %  (기대 SQLSTATE %, 실제 %)', p_label, p_state, coalesce(v_state, '성공함');
  end if;
end;
$fn$;

-- 영향받은 행 수를 돌려준다 (RLS 로 가려진 UPDATE/DELETE 는 0 행)
create or replace function public._assert_rows(p_sql text, p_expected int, p_label text)
returns void language plpgsql set search_path = public as $fn$
declare v_n int;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  if v_n = p_expected then raise notice '  OK   %', p_label;
  else raise exception 'FAIL  %  (기대 % 행, 실제 % 행)', p_label, p_expected, v_n;
  end if;
end;
$fn$;

do $t$ begin raise notice '[프로젝트] 재실행 안전 · 정책 수'; end $t$;

do $t$
declare v_bad text;
begin
  select string_agg(c.relname || '=' || n, ', ') into v_bad from (
    select c.relname, count(p.oid) as n
      from pg_class c join pg_namespace s on s.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
     where s.nspname = 'public' and c.relkind = 'r'
     group by c.relname) c
   where n <> 4;
  perform public._assert(v_bad is null, '두 번 적용 후 표마다 정책 4개 (발견: ' || coalesce(v_bad, '없음') || ')');
  perform public._assert_eq(
    (select count(*) from pg_trigger where tgname like '%\_updated\_at' and not tgisinternal),
    3::bigint, '두 번 적용 후 updated_at 트리거 3개');
end $t$;

do $t$ begin raise notice '[프로젝트] 함수 권한(proacl)'; end $t$;

do $t$
declare v_acl text;
begin
  select array_to_string(proacl, ',') into v_acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and proname = 'set_updated_at';
  perform public._assert(v_acl is not null and v_acl not like '=X/%' and v_acl not like '%,=X/%',
    'set_updated_at: PUBLIC EXECUTE 없음 (' || coalesce(v_acl, 'null') || ')');
  perform public._assert(v_acl not like '%anon=%', 'set_updated_at: anon EXECUTE 없음');
  perform public._assert(v_acl like '%authenticated=X%', 'set_updated_at: authenticated EXECUTE 있음');
end $t$;

-- ----------------------------------------------------------------------------
-- 사용자 A — 코트·슬롯·검색 조건
-- ----------------------------------------------------------------------------
do $t$ begin raise notice '[프로젝트] 사용자 A — 자기 자료 쓰기·읽기'; end $t$;

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

do $t$
declare v_court bigint;
begin
  insert into public.courts (court_name, latitude, longitude, booking_available, slot_minutes)
    values ('예시 테니스장 A', 37.41, 127.12, 'yes', 60) returning id into v_court;
  insert into public.courts (court_name, latitude, longitude, naver_booking_url)
    values ('예시 테니스장 A', 37.42, 127.13, 'https://booking.naver.com/x')
    on conflict (owner_id, court_name) do update set latitude = excluded.latitude, naver_booking_url = excluded.naver_booking_url;
  perform public._assert_eq((select count(*) from public.courts), 1::bigint, '같은 이름 코트는 upsert(onConflict owner_id,court_name)로 한 행');
  perform public._assert_eq((select slot_minutes from public.courts), 60, 'upsert 가 슬롯 단위를 덮지 않는다');

  -- 기획서 5.2 표 10/01: 18~19, 20~22 (1시간 단위)
  insert into public.court_slots (court_id, slot_date, start_min, end_min) values
    (v_court, '2026-10-01', 1080, 1140), (v_court, '2026-10-01', 1200, 1260), (v_court, '2026-10-01', 1260, 1320);
  insert into public.court_slots (court_id, slot_date, start_min, end_min) values (v_court, '2026-10-01', 1200, 1260)
    on conflict (court_id, slot_date, start_min) do update set last_updated = now();
  perform public._assert_eq((select count(*) from public.court_slots), 3::bigint, '같은 슬롯은 upsert(onConflict court_id,slot_date,start_min)로 중복 없음');
  insert into public.court_slots (court_id, slot_date, start_min, end_min, is_none) values (v_court, '2026-10-03', 0, 0, true);
  perform public._assert_eq((select count(*) from public.court_slots where is_none), 1::bigint, '「확인했고 가능 슬롯 없음」 표시 행');

  insert into public.search_conditions (center_address, center_latitude, center_longitude, radius_km, start_date, end_date, start_time, end_time, minimum_duration)
    values ('판교역 부근', 37.3948, 127.1112, 5, '2026-10-01', '2026-10-07', 1080, 1320, 120);
  perform public._assert_eq((select owner_id from public.search_conditions),
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'owner_id 가 auth.uid() 로 채워진다');
end $t$;

update public.courts set hours = '06:00~23:00';
do $t$ begin
  perform public._assert((select updated_at > created_at from public.courts), 'UPDATE 하면 updated_at 이 갱신된다');
end $t$;

-- ----------------------------------------------------------------------------
-- 사용자 B — A 와 격리
-- ----------------------------------------------------------------------------
do $t$ begin raise notice '[프로젝트] 사용자 B — A 와 격리'; end $t$;

set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';

do $t$
declare t text;
begin
  foreach t in array array['courts','court_slots','search_conditions']
  loop
    perform public._assert_rows(format('select 1 from public.%I', t), 0, 'B 에게 A 의 ' || t || ' 가 안 보인다');
    perform public._assert_rows(format('update public.%I set updated_at = now()', t), 0, 'B 는 A 의 ' || t || ' 를 못 고친다');
    perform public._assert_rows(format('delete from public.%I', t), 0, 'B 는 A 의 ' || t || ' 를 못 지운다');
  end loop;
  perform public._assert_raises(
    $q$insert into public.courts (owner_id, court_name, latitude, longitude) values ('aaaaaaaa-0000-0000-0000-000000000001', 'x', 37, 127)$q$,
    '42501', 'B 가 owner_id 를 A 로 속여 넣으면 RLS 가 막는다');
  perform public._assert_eq((select min(id) from public.courts), null::bigint, 'B 에게는 A 의 코트 id 가 보이지 않는다');
end $t$;
reset role;
-- 코트 id 를 알아냈다고 가정(postgres 로 읽어 B 에게 넘김)해도 RLS 가 막는가
do $t$
declare v_a bigint;
begin
  select id into v_a from public.courts where court_name = '예시 테니스장 A';
  perform set_config('test.a_court', v_a::text, false);
end $t$;
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
do $t$
begin
  perform public._assert_raises(
    format('insert into public.court_slots (court_id, slot_date, start_min, end_min) values (%s, %L, 1080, 1140)', current_setting('test.a_court'), '2026-10-02'),
    '42501', 'B 는 A 의 코트 id 를 알아도 슬롯을 달 수 없다');
  insert into public.courts (court_name, latitude, longitude) values ('예시 테니스장 A', 37.5, 127.0);
  perform public._assert_eq((select count(*) from public.courts), 1::bigint, 'B 는 A 와 같은 이름으로 자기 코트를 따로 가진다');
end $t$;

-- ----------------------------------------------------------------------------
-- anon(비로그인)은 아무것도 못 보고 못 쓴다
-- ----------------------------------------------------------------------------
do $t$ begin raise notice '[프로젝트] anon — 읽기·쓰기 불가'; end $t$;

set role anon;
set request.jwt.claim.sub = '';
do $t$
declare t text;
begin
  foreach t in array array['courts','court_slots','search_conditions']
  loop
    perform public._assert_rows(format('select 1 from public.%I', t), 0, 'anon 에게 ' || t || ' 가 안 보인다');
  end loop;
  perform public._assert_raises($q$insert into public.courts (court_name, latitude, longitude) values ('x', 37, 127)$q$,
    '42501', 'anon 은 courts 에 쓰지 못한다');
  perform public._assert_raises($q$insert into public.search_conditions (center_latitude, center_longitude, radius_km, start_date, end_date, start_time, end_time, minimum_duration) values (37, 127, 5, '2026-10-01', '2026-10-01', 1080, 1320, 120)$q$,
    '42501', 'anon 은 search_conditions 에 쓰지 못한다');
  perform public._assert_raises('select public.set_updated_at()', '42501', 'anon 은 set_updated_at 을 실행하지 못한다');
end $t$;
reset role;

-- ----------------------------------------------------------------------------
-- CHECK · UNIQUE (postgres 로 — RLS 와 무관하게 제약만 본다)
-- ----------------------------------------------------------------------------
do $t$ begin raise notice '[프로젝트] CHECK · UNIQUE 제약'; end $t$;

do $t$
declare a uuid := 'aaaaaaaa-0000-0000-0000-000000000001'; v_c bigint;
begin
  select id into v_c from public.courts where owner_id = a;
  perform public._assert_raises(format('insert into public.courts (owner_id, court_name, latitude, longitude) values (%L, %L, 37, 127)', a, '예시 테니스장 A'),
    '23505', '같은 사용자·같은 코트명은 UNIQUE 가 막는다');
  perform public._assert_raises(format('insert into public.courts (owner_id, court_name, latitude, longitude) values (%L, %L, 127, 37)', a, 'z'),
    '23514', '위도 127(경도와 뒤바뀜)은 CHECK 가 막는다');
  perform public._assert_raises(format('insert into public.courts (owner_id, court_name, latitude, longitude, naver_booking_url) values (%L, %L, 37, 127, %L)', a, 'z', 'javascript:alert(1)'),
    '23514', '예약 URL 은 http·https 만');
  perform public._assert_raises(format('insert into public.courts (owner_id, court_name, latitude, longitude, slot_minutes) values (%L, %L, 37, 127, 45)', a, 'z'),
    '23514', '슬롯 단위는 앱 선택지(10·15·20·30·60·90·120분)만');
  perform public._assert_raises(format('insert into public.courts (owner_id, court_name, latitude, longitude, booking_available) values (%L, %L, 37, 127, %L)', a, 'z', 'maybe'),
    '23514', '네이버 예약 여부는 yes/no/unknown 만');
  perform public._assert_raises(format('insert into public.courts (owner_id, court_name, latitude, longitude) values (%L, %L, 37, 127)', a, '  '),
    '23514', '빈 코트명은 CHECK 가 막는다');
  perform public._assert_raises(format('insert into public.court_slots (owner_id, court_id, slot_date, start_min, end_min) values (%L, %s, %L, 1410, 30)', a, v_c, '2026-10-05'),
    '23514', '자정을 넘는 슬롯(23:30~00:30)은 CHECK 가 막는다');
  perform public._assert_raises(format('insert into public.court_slots (owner_id, court_id, slot_date, start_min, end_min) values (%L, %s, %L, 1380, 1500)', a, v_c, '2026-10-05'),
    '23514', '24:00 을 넘는 끝 시각은 CHECK 가 막는다');
  perform public._assert_raises(format('insert into public.court_slots (owner_id, court_id, slot_date, start_min, end_min) values (%L, %s, %L, 1380, 1440)', a, v_c, '2026-10-05'),
    null, '23:00~24:00 은 허용');
  perform public._assert_raises(format('insert into public.court_slots (owner_id, court_id, slot_date, start_min, end_min, is_none) values (%L, %s, %L, 60, 120, true)', a, v_c, '2026-10-06'),
    '23514', '「없음」 표시 행은 0~0 만');
  perform public._assert_raises(format('insert into public.court_slots (owner_id, court_id, slot_date, start_min, end_min) values (%L, %s, %L, 1080, 1140)', a, v_c, '2026-10-01'),
    '23505', '같은 코트·날짜·시작 시각 슬롯은 UNIQUE 가 막는다');
  perform public._assert_raises(format('insert into public.search_conditions (owner_id, center_latitude, center_longitude, radius_km, start_date, end_date, start_time, end_time, minimum_duration) values (%L, 37, 127, 5, %L, %L, 1320, 120, 60)', a, '2026-10-01', '2026-10-01'),
    '23514', '자정을 넘는 희망 시간(22:00~02:00)은 CHECK 가 막는다');
  perform public._assert_raises(format('insert into public.search_conditions (owner_id, center_latitude, center_longitude, radius_km, start_date, end_date, start_time, end_time, minimum_duration) values (%L, 37, 127, 5, %L, %L, 1200, 1260, 120)', a, '2026-10-01', '2026-10-01'),
    '23514', '최소 연속시간이 희망 시간대보다 길면 CHECK 가 막는다');
  perform public._assert_raises(format('insert into public.search_conditions (owner_id, center_latitude, center_longitude, radius_km, start_date, end_date, start_time, end_time, minimum_duration) values (%L, 37, 127, 5, %L, %L, 1080, 1320, 120)', a, '2026-10-07', '2026-10-01'),
    '23514', '끝 날짜가 시작보다 앞이면 CHECK 가 막는다');
  perform public._assert_raises(format('insert into public.search_conditions (owner_id, center_latitude, center_longitude, radius_km, start_date, end_date, start_time, end_time, minimum_duration) values (%L, 37, 127, 0, %L, %L, 1080, 1320, 120)', a, '2026-10-01', '2026-10-01'),
    '23514', '반경 0 은 CHECK 가 막는다');
  -- 코트를 지우면 슬롯도 함께 지워진다(on delete cascade)
  delete from public.courts where id = v_c;
  perform public._assert_eq((select count(*) from public.court_slots where court_id = v_c), 0::bigint, '코트를 지우면 그 슬롯도 지워진다');
end $t$;

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;
