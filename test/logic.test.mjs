// 실행: node test/logic.test.mjs   (의존성 없음)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const T = L.parseTime;
const slotsOf = (text, S) => L.rangesToSlots(L.parseRanges(text).ranges, S);
const cond = (over) => Object.assign(L.defaultCond(), over || {});

console.log('시간·날짜');
test('HH:MM ↔ 분, 24:00 허용, 틀린 형식은 null', () => {
  assert.equal(T('18:00'), 1080);
  assert.equal(T('9:30'), 570);
  assert.equal(T('24:00'), 1440);
  assert.equal(T('24:30'), null);
  assert.equal(T('18:75'), null);
  assert.equal(T('저녁'), null);
  assert.equal(L.fmtTime(1260), '21:00');
});
test('기간 → 날짜 목록 (월 경계 포함)', () => {
  assert.deepEqual(L.dateRange('2026-09-29', '2026-10-02'), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(L.normDate('2026.10.1'), '2026-10-01');
  assert.equal(L.normDate('2026-02-30'), null);
  assert.equal(L.shortDate('2026-10-01'), '10/01(목)');
});
test('시간 길이 표기', () => {
  assert.equal(L.fmtDuration(120), '2시간');
  assert.equal(L.fmtDuration(90), '1시간 30분');
  assert.equal(L.fmtDuration(30), '30분');
});

console.log('거리 (하버사인)');
test('위도 1도 ≈ 111.2 km, 같은 점은 0', () => {
  assert.ok(Math.abs(L.haversineKm({ lat: 37, lng: 127 }, { lat: 38, lng: 127 }) - 111.2) < 0.1);
  assert.equal(L.haversineKm({ lat: 37.39, lng: 127.11 }, { lat: 37.39, lng: 127.11 }), 0);
});
test('서울시청 ↔ 부산시청 ≈ 325 km (알려진 거리와 비교)', () => {
  const d = L.haversineKm({ lat: 37.5663, lng: 126.9779 }, { lat: 35.1798, lng: 129.0750 });
  assert.ok(d > 320 && d < 330, String(d));
});
test('평면 펼침 좌표 ↔ 위경도 왕복, 펼침 거리 ≈ 하버사인 거리(10 km 안에서 0.1% 이내)', () => {
  const c = { lat: 37.3948, lng: 127.1112 };
  const p = L.unprojectKm(c, { x: 3, y: -4 });
  const back = L.projectKm(c, p);
  assert.ok(Math.abs(back.x - 3) < 1e-9 && Math.abs(back.y + 4) < 1e-9);
  const d = L.haversineKm(c, p);
  assert.ok(Math.abs(d - 5) / 5 < 0.001, String(d));
});
test('좌표 한 줄 붙여 넣기 — 경도·위도 순서로 적어도 바로잡음', () => {
  assert.deepEqual(L.parseLatLngText('37.3948, 127.1112'), { lat: 37.3948, lng: 127.1112 });
  assert.deepEqual(L.parseLatLngText('127.1112 37.3948'), { lat: 37.3948, lng: 127.1112 });
  assert.equal(L.parseLatLngText('판교역'), null);
});

console.log('필요 연속 슬롯 (기획서 5.4 표)');
test('T / S — 1시간·1.5시간·2시간·3시간 ÷ 30분 = 2·3·4·6', () => {
  assert.deepEqual([60, 90, 120, 180].map((t) => L.requiredSlots(t, 30)), [2, 3, 4, 6]);
});
test('나누어떨어지지 않으면 올림 (1.5시간 ÷ 1시간 슬롯 = 2개)', () => {
  assert.equal(L.requiredSlots(90, 60), 2);
  assert.equal(L.requiredSlots(120, 60), 2);
});

console.log('가능 시간 → 슬롯');
test('「18:00~19:00, 20:00~22:00」 1시간 단위 → 슬롯 3개', () => {
  assert.deepEqual(slotsOf('18:00~19:00, 20:00~22:00', 60).map((s) => L.fmtTime(s.start)), ['18:00', '20:00', '21:00']);
});
test('슬롯을 다 채우지 못하는 자투리는 버림 (30분 단위에서 19:00~19:15)', () => {
  assert.deepEqual(slotsOf('18:00~19:15', 30).map((s) => L.fmtTime(s.start)), ['18:00', '18:30']);
});
test('자정을 넘는 시간(23:00~01:00)·거꾸로 된 시간은 읽지 않고 알려 줌', () => {
  const p = L.parseRanges('23:00~01:00, 20:00~19:00, 21:00-22:00');
  assert.deepEqual(p.bad, ['23:00~01:00', '20:00~19:00']);
  assert.equal(p.ranges.length, 1);
});

console.log('연속 예약 판정 (기획서 5.2·5.3 표)');
const W = [T('18:00'), T('22:00')];
test('5.2 표 10/01: 18~19, 20~22 → 20:00~22:00 한 덩어리가 2시간 가능', () => {
  const j = L.judgeDay(slotsOf('18:00~19:00, 20:00~22:00', 60), W[0], W[1], 120);
  assert.equal(j.ok, true);
  assert.deepEqual(j.okRuns.map((r) => [L.fmtTime(r.start), L.fmtTime(r.end)]), [['20:00', '22:00']]);
});
test('5.2 표 10/02: 18~22 → 4시간 가능', () => {
  assert.equal(L.judgeDay(slotsOf('18:00~22:00', 60), W[0], W[1], 120).maxMinutes, 240);
});
test('5.2 표 10/03: 19~20 → 조건 미충족', () => {
  assert.equal(L.judgeDay(slotsOf('19:00~20:00', 60), W[0], W[1], 120).ok, false);
});
test('5.2 표 10/04: 18~21 → 3시간 가능', () => {
  const j = L.judgeDay(slotsOf('18:00~21:00', 60), W[0], W[1], 120);
  assert.equal(j.ok, true); assert.equal(j.maxMinutes, 180);
});
test('5.3 표: 30분 슬롯 ○○○○× → 18:00~20:00 연속 2시간 (슬롯 4개)', () => {
  const j = L.judgeDay(slotsOf('18:00~20:00', 30), W[0], W[1], 120);
  assert.equal(j.ok, true);
  assert.equal(j.okRuns[0].count, 4);
  assert.equal(L.fmtTime(j.okRuns[0].end), '20:00');
});
test('30분 슬롯 ○○○× 는 1시간 30분이라 2시간 미충족', () => {
  assert.equal(L.judgeDay(slotsOf('18:00~19:30', 30), W[0], W[1], 120).ok, false);
});
test('한 칸이 비면 끊김: 18:00~19:00 + 19:30~21:00 은 이어지지 않음', () => {
  const j = L.judgeDay(slotsOf('18:00~19:00, 19:30~21:00', 30), W[0], W[1], 120);
  assert.equal(j.ok, false); assert.equal(j.maxMinutes, 90);
});
test('경계: 희망 시간 끝(22:00)에 딱 맞게 끝나는 20:00~22:00 은 포함', () => {
  assert.equal(L.judgeDay(slotsOf('20:00~22:00', 30), W[0], W[1], 120).ok, true);
});
test('경계: 희망 시간을 걸쳐 나가는 슬롯(21:30~22:30)은 통째로 빠짐', () => {
  const j = L.judgeDay(slotsOf('20:30~22:30', 60), W[0], W[1], 120);
  assert.equal(j.ok, false); assert.equal(j.maxMinutes, 60);
});
test('경계: 희망 시작 전 슬롯(17:00~18:00)은 세지 않음', () => {
  assert.equal(L.judgeDay(slotsOf('17:00~19:00', 60), W[0], W[1], 120).ok, false);
});
test('예약을 시작할 수 있는 시각: 18~22 덩어리, 2시간, 30분 단위 → 18:00·18:30·19:00·19:30·20:00', () => {
  const run = L.judgeDay(slotsOf('18:00~22:00', 30), W[0], W[1], 120).okRuns[0];
  assert.deepEqual(L.startTimes(run, 120, 30).map(L.fmtTime), ['18:00', '18:30', '19:00', '19:30', '20:00']);
});
test('최소 이용시간을 바꾸면 결과가 바뀜 (1시간이면 10/03 도 가능)', () => {
  assert.equal(L.judgeDay(slotsOf('19:00~20:00', 60), W[0], W[1], 60).ok, true);
});

console.log('조건 검증');
test('기본 조건(기획서 5.1 예시)은 통과', () => { assert.deepEqual(L.validateCond(cond()), []); });
test('자정을 넘는 희망 시간(22:00~02:00)은 거절', () => {
  assert.ok(L.validateCond(cond({ startTime: '22:00', endTime: '02:00' })).some((e) => e.includes('자정')));
});
test('최소 연속시간이 희망 시간대보다 길면 거절', () => {
  assert.ok(L.validateCond(cond({ startTime: '20:00', endTime: '21:00', minMinutes: 120 })).length > 0);
});
test('끝 날짜가 앞이거나, 반경 0, 기간 62일 초과는 거절', () => {
  assert.ok(L.validateCond(cond({ startDate: '2026-10-07', endDate: '2026-10-01' })).length);
  assert.ok(L.validateCond(cond({ radiusKm: 0 })).length);
  assert.ok(L.validateCond(cond({ startDate: '2026-01-01', endDate: '2026-12-31' })).length);
});

console.log('날짜 넘김 — 하루 단위로 따로 판정');
test('10/01 23:00~24:00 과 10/02 00:00~01:00 은 이어 붙이지 않음', () => {
  const courts = [{ id: 'x', name: 'X', lat: 37.3948, lng: 127.1112, booking: 'yes', slotMin: 60 }];
  let s = L.setDaySlots([], 'x', '2026-10-01', slotsOf('23:00~24:00', 60));
  s = L.setDaySlots(s, 'x', '2026-10-02', slotsOf('00:00~01:00', 60));
  const r = L.search(courts, s, cond({ startDate: '2026-10-01', endDate: '2026-10-02', startTime: '00:00', endTime: '24:00' }));
  assert.equal(r.results[0].status, 'nomatch');
  assert.equal(r.results[0].maxMinutes, 60);
});

console.log('검색 (반경·상태·정렬)');
const db = Sample.sampleDb();
const res = L.search(db.courts, db.slots, db.cond);
const byName = Object.fromEntries(res.results.map((r) => [r.court.name, r]));
test('예시 데이터 기본 조건: 반경 5 km 밖 G 는 빠지고 6곳', () => {
  assert.deepEqual(res.errors, []);
  assert.equal(res.results.length, 6);
  assert.equal(byName['예시 테니스장 G'], undefined);
  assert.ok(L.haversineKm(db.cond.center, db.courts[6]) > 5);
});
test('반경을 10 km 로 늘리면 G 도 들어옴', () => {
  assert.equal(L.search(db.courts, db.slots, cond({ radiusKm: 10 })).results.length, 7);
});
test('예시 A = 기획서 5.2 표 그대로: 10/01·02·04 가능, 10/03 불가, 최대 연속 4시간', () => {
  const a = byName['예시 테니스장 A'];
  assert.equal(a.status, 'ok');
  const ok = a.days.filter((d) => d.ok).map((d) => d.date);
  assert.ok(ok.includes('2026-10-01') && ok.includes('2026-10-02') && ok.includes('2026-10-04'));
  assert.ok(!ok.includes('2026-10-03'));
  assert.equal(a.days.find((d) => d.date === '2026-10-02').maxMinutes, 240);
});
test('상태: E=네이버 예약 불가, F=슬롯 미입력, D=슬롯은 있으나 조건 미충족', () => {
  assert.equal(byName['예시 테니스장 E'].status, 'nobooking');
  assert.equal(byName['예시 테니스장 F'].status, 'nodata');
  assert.equal(byName['예시 테니스장 D'].status, 'nomatch');
});
test('정렬: 조건 만족 먼저, 같은 상태끼리는 가까운 순', () => {
  const rank = { ok: 0, nomatch: 1, nodata: 2, nobooking: 3 };
  for (let i = 1; i < res.results.length; i++) {
    const a = res.results[i - 1], b = res.results[i];
    assert.ok(rank[a.status] < rank[b.status] || (rank[a.status] === rank[b.status] && a.distanceKm <= b.distanceKm));
  }
});
test('거르기: 네이버 예약 가능 시설만 / 조건 만족만', () => {
  assert.ok(!L.filterResults(res.results, { bookingOnly: true }).some((r) => r.status === 'nobooking'));
  assert.ok(L.filterResults(res.results, { matchOnly: true }).every((r) => r.status === 'ok'));
});
test('슬롯을 비운 날(가능 슬롯 없음)은 「미입력」이 아니라 「확인했고 없음」', () => {
  const s = L.setDaySlots([], 'c1', '2026-10-01', []);
  assert.equal(L.hasDataFor(s, 'c1', '2026-10-01'), true);
  assert.equal(L.realSlots(s).length, 0);
  assert.equal(L.clearDay(s, 'c1', '2026-10-01').length, 0);
});
test('요약 문구: 「10/02(금) 18:00~22:00」', () => {
  assert.ok(L.summarize(byName['예시 테니스장 A']).includes('10/02(금) 18:00~22:00'));
});

console.log('링크 안전');
test('http/https 만 링크로 씀, javascript: 는 버림', () => {
  assert.equal(L.safeUrl('https://booking.naver.com/booking/10/bizes/1'), 'https://booking.naver.com/booking/10/bizes/1');
  assert.equal(L.safeUrl('naver.me/abc'), 'https://naver.me/abc');
  assert.equal(L.safeUrl('javascript:alert(1)'), '');
  assert.equal(L.safeUrl('https://a.b/"onmouseover=x'), '');
});
test('예약 URL 이 없으면 네이버 지도 검색 링크(이름+주소)', () => {
  assert.equal(L.naverMapSearchUrl({ name: '가 테니스장', address: '' }), 'https://map.naver.com/p/search/' + encodeURIComponent('가 테니스장'));
});

console.log('CSV');
test('따옴표·쉼표·줄바꿈이 든 칸, 탭 구분자', () => {
  assert.deepEqual(L.parseCsv('a,b\n"1,2","x ""y"""\n'), [['a', 'b'], ['1,2', 'x "y"']]);
  assert.deepEqual(L.parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});
test('내보낼 때 수식으로 읽힐 칸(=, +, @)은 작은따옴표로 막음', () => {
  assert.ok(L.toCsv([['=HYPERLINK("x")']]).includes("'=HYPERLINK"));
});
let n = 0;
const nextId = () => 'n' + (++n);
test('코트 CSV 가져오기 — 한글 머리행, 같은 이름은 고쳐 씀, 좌표 없는 행은 알려 줌', () => {
  const csv = '코트명,주소,위도,경도,네이버 예약,네이버 예약 URL,슬롯 단위(분)\n' +
    '가 테니스장,어딘가,37.40,127.10,가능,https://booking.naver.com/x,30\n' +
    '나 테니스장,,37.41,,불가,,60\n' +
    '예시 테니스장 A,,37.39,127.12,가능,javascript:alert(1),60\n';
  const r = L.importCourts(csv, db.courts, nextId);
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith('3행'));
  const a = r.courts.find((c) => c.name === '예시 테니스장 A');
  assert.equal(a.id, 'c1');
  assert.equal(a.bookingUrl, '');
  assert.equal(r.courts.find((c) => c.name === '가 테니스장').slotMin, 30);
});
test('코트 CSV 가져오기 — 기획서 11.1 영문 필드명(court_name, latitude, longitude)', () => {
  const r = L.importCourts('court_name,latitude,longitude,booking_available\nZ,37.4,127.1,true\n', [], nextId);
  assert.equal(r.added, 1); assert.equal(r.courts[0].booking, 'yes');
});
test('코트 CSV 내보내기 → 다시 가져오기 하면 같은 값', () => {
  const back = L.importCourts(L.toCsv(L.courtsCsv(db.courts)), [], nextId).courts;
  assert.deepEqual(back.map((c) => [c.name, c.lat, c.lng, c.booking, c.slotMin]), db.courts.map((c) => [c.name, c.lat, c.lng, c.booking, c.slotMin]));
});
test('슬롯 CSV ② 하루 한 줄(예약 가능 시간) — 코트 슬롯 단위로 자름', () => {
  const r = L.importSlots('코트명,날짜,예약 가능 시간\n예시 테니스장 B,2026-10-20,"18:00~19:00, 20:00~21:00"\n', db.courts, [], 's');
  assert.equal(r.days, 1); assert.deepEqual(r.errors, []);
  assert.equal(r.slots.length, 4); // B 는 30분 단위
});
test('슬롯 CSV ① 슬롯 한 줄씩(기획서 11.3) — 불가 행은 빼고, 자정 넘김·모르는 코트는 알려 줌', () => {
  const csv = 'court_name,date,slot_start,slot_end,available\n' +
    '예시 테니스장 A,2026-10-20,18:00,19:00,가능\n' +
    '예시 테니스장 A,2026-10-20,19:00,20:00,불가\n' +
    '예시 테니스장 A,2026-10-20,23:00,00:00,가능\n' +
    '없는 코트,2026-10-20,18:00,19:00,가능\n';
  const r = L.importSlots(csv, db.courts, [], 's');
  assert.equal(L.realSlots(r.slots).length, 1);
  assert.equal(r.errors.length, 2);
});
test('슬롯 CSV 내보내기 → 다시 가져오기 하면 같은 판정', () => {
  const back = L.importSlots(L.toCsv(L.slotsCsv(db.courts, db.slots)), db.courts, [], 's').slots;
  const again = L.search(db.courts, back, db.cond).results.map((r) => [r.court.name, r.status, r.okDays.length]);
  // 「가능 슬롯 없음」으로 확인한 날은 내보내기에 줄이 없으므로 미입력으로 돌아옵니다 — 조건 만족 판정은 같아야 합니다
  assert.deepEqual(again.filter((x) => x[1] === 'ok'), res.results.map((r) => [r.court.name, r.status, r.okDays.length]).filter((x) => x[1] === 'ok'));
});

console.log('백업');
test('백업 → 복원 왕복', () => {
  const back = L.parseBackup(L.makeBackup(db));
  assert.equal(back.courts.length, db.courts.length);
  assert.equal(back.slots.length, db.slots.length);
  assert.equal(back._sample, true);
  assert.throws(() => L.parseBackup('{"app":"other"}'));
});

console.log('\n' + passed + '개 통과' + (process.exitCode ? ' (실패 있음)' : ''));
