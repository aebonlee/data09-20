/*
 * 예시 데이터 — 모두 가상입니다. 코트 이름·주소·전화번호·예약 슬롯은 지어낸 값이고,
 * 위치는 기준점(판교역 부근 어림 좌표)에서 동서남북으로 몇 km 떨어진 가상의 점입니다.
 * 예약 URL 은 넣지 않았습니다(실제 예약 페이지로 착각하지 않도록). 링크 자리에는
 * 「네이버 지도에서 이름으로 찾기」가 대신 나옵니다.
 *
 * 「예시 테니스장 A」의 10/01~10/04 가능 시간은 기획서 5.2 표를 그대로 옮겼고,
 * 「예시 테니스장 B」의 10/01 은 기획서 5.3 표(30분 슬롯 ○○○○×)를 옮겼습니다.
 */
(function (root) {
  'use strict';
  var L = root.TCLogic || (typeof require === 'function' ? require('./logic.js') : null);

  // 고정 씨앗 난수 — 열 때마다 같은 예시가 나오게
  function rng(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  var CENTER = { lat: 37.3948, lng: 127.1112 };
  // [이름, 동쪽 km, 북쪽 km, 네이버 예약, 실내/실외, 코트 수, 운영시간, 슬롯 단위(분)]
  var COURTS = [
    ['예시 테니스장 A', 1.2, 1.8, 'yes', '실외', 6, '06:00~23:00', 60],
    ['예시 테니스장 B', -2.1, 0.6, 'yes', '실내', 4, '06:00~24:00', 30],
    ['예시 테니스장 C', 0.4, -3.2, 'yes', '실외', 8, '06:00~22:00', 60],
    ['예시 테니스장 D', 3.6, -1.9, 'yes', '실외', 3, '07:00~22:00', 30],
    ['예시 테니스장 E', -1.5, -1.1, 'no', '실외', 2, '06:00~21:00', 60],
    ['예시 테니스장 F', -3.4, 2.9, 'unknown', '실내', 5, '06:00~23:00', 60],
    ['예시 테니스장 G', 6.1, 3.8, 'yes', '실외', 6, '06:00~22:00', 60]
  ];

  function courts() {
    return COURTS.map(function (a, i) {
      var p = L.unprojectKm(CENTER, { x: a[1], y: a[2] });
      return {
        id: 'c' + (i + 1), name: a[0], address: '가상 주소 ' + (i + 1) + '번지',
        lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6,
        phone: '000-0000-000' + (i + 1), bookingUrl: '', placeUrl: '',
        booking: a[3], indoor: a[4], courtCount: a[5], hours: a[6], slotMin: a[7]
      };
    });
  }

  function slots(cs) {
    var r = rng(20260929);
    var stamp = '2026-09-29T09:00:00+09:00 (예시)';
    var out = [];
    var dates = L.dateRange('2026-10-01', '2026-10-15');
    function put(courtId, date, text, slotMin) {
      out = L.setDaySlots(out, courtId, date, L.rangesToSlots(L.parseRanges(text).ranges, slotMin), stamp);
    }
    // 기획서 5.2 표 (예시 테니스장 A, 1시간 단위)
    var docA = { '2026-10-01': '18:00~19:00, 20:00~22:00', '2026-10-02': '18:00~22:00', '2026-10-03': '19:00~20:00', '2026-10-04': '18:00~21:00' };
    // 기획서 5.3 표 (예시 테니스장 B, 30분 단위) — 20:00 슬롯이 ×
    var docB = { '2026-10-01': '18:00~20:00, 21:00~22:00' };
    cs.forEach(function (c) {
      if (c.name === '예시 테니스장 F') return; // 슬롯을 아직 입력하지 않은 코트(미입력 상태 보기용)
      dates.forEach(function (d) {
        if (c.id === 'c1' && docA[d]) return put(c.id, d, docA[d], c.slotMin);
        if (c.id === 'c2' && docB[d]) return put(c.id, d, docB[d], c.slotMin);
        if (c.id === 'c4' && d <= '2026-10-07') return put(c.id, d, r() < 0.5 ? '19:00~20:00' : '18:00~18:30, 21:00~22:00', c.slotMin);
        // 그 밖의 날: 저녁 시간대(17~23시)를 슬롯마다 가능/불가로 흩뿌림
        var avail = [];
        for (var t = 17 * 60; t + c.slotMin <= 23 * 60; t += c.slotMin) if (r() < 0.55) avail.push({ start: t, end: t + c.slotMin });
        out = L.setDaySlots(out, c.id, d, avail, stamp);
      });
    });
    return out;
  }

  function sampleDb() {
    var db = L.emptyDb();
    db.courts = courts();
    db.slots = slots(db.courts);
    db.seq = db.courts.length;
    db.cond = L.defaultCond();
    db._sample = true;
    return db;
  }

  var api = { sampleDb: sampleDb, CENTER: CENTER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TCSample = api;
})(typeof window !== 'undefined' ? window : this);
