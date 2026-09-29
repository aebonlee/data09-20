// 가져오기 연습용 예시 CSV 를 만듭니다(모두 가상):  node scripts/make-samples.js
const fs = require('fs');
const path = require('path');
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');
const db = Sample.sampleDb();
const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '예시_코트목록.csv'), L.toCsv(L.courtsCsv(db.courts)));
fs.writeFileSync(path.join(out, '예시_예약슬롯_슬롯별.csv'), L.toCsv(L.slotsCsv(db.courts, db.slots)));
// 하루 한 줄 형식(기획서 5.2 표) — 예시 테니스장 A 의 10/01~10/04
fs.writeFileSync(path.join(out, '예시_예약슬롯_하루한줄.csv'), L.toCsv([['코트명', '날짜', '예약 가능 시간'],
  ['예시 테니스장 A', '2026-10-01', '18:00~19:00, 20:00~22:00'], ['예시 테니스장 A', '2026-10-02', '18:00~22:00'],
  ['예시 테니스장 A', '2026-10-03', '19:00~20:00'], ['예시 테니스장 A', '2026-10-04', '18:00~21:00']]));
// 다시 읽어 원본과 같은 판정이 나오는지 확인
const courts = L.importCourts(fs.readFileSync(path.join(out, '예시_코트목록.csv'), 'utf8'), [], (() => { let n = 0; return () => 'c' + (++n); })()).courts;
const slots = L.importSlots(fs.readFileSync(path.join(out, '예시_예약슬롯_슬롯별.csv'), 'utf8'), courts, [], 's').slots;
const a = L.search(courts, slots, db.cond).results.filter((r) => r.status === 'ok').map((r) => r.court.name + r.okDays.length).join();
const b = L.search(db.courts, db.slots, db.cond).results.filter((r) => r.status === 'ok').map((r) => r.court.name + r.okDays.length).join();
if (a !== b) { console.error('다시 읽은 판정이 다릅니다', a, b); process.exit(1); }
console.log('samples/ 3개 생성, 다시 읽어 판정 일치:', a);
