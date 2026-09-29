/*
 * 예약 가능한 테니스 코트 조회 — 순수 로직 모듈 (화면·저장소와 무관)
 * 브라우저에서는 window.TCLogic, Node(테스트)에서는 module.exports 로 씁니다.
 * ES module 이 아닌 이유: index.html 을 로컬 파일(file://)로 열었을 때
 * 브라우저가 module 스크립트를 막기 때문입니다.
 *
 * 데이터 구조 (기획서 11장 Court · SearchCondition · Availability 를 따름)
 *   courts[] = { id, name, address, lat, lng, phone, bookingUrl, placeUrl,
 *                booking: 'yes'|'no'|'unknown',   // 네이버 예약 제공 여부
 *                indoor: '실내'|'실외'|'', courtCount, hours, slotMin }
 *   slots[]  = { courtId, date:'YYYY-MM-DD', start:분, end:분, updated:'ISO 시각' }
 *              — 「예약 가능」인 슬롯만 적습니다. 없는 슬롯 = 예약 불가 또는 미확인
 *   cond     = { center:{lat,lng,label}, radiusKm, startDate, endDate,
 *                startTime:'HH:MM', endTime:'HH:MM', minMinutes }
 *
 * 시간은 그 날 0시부터의 분(0~1440)으로 다룹니다. 24:00 = 1440.
 * 자정을 넘는 슬롯·시간대(예: 23:30~00:30)는 1단계에서 받지 않습니다.
 */
(function (root) {
  'use strict';

  var DAY = 1440;
  var MAX_DAYS = 62;       // 한 번에 조회할 수 있는 최대 기간(일)
  var R_EARTH = 6371.0088; // 지구 평균 반지름(km)

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function norm(s) { return str(s).toLowerCase().replace(/[\s_\-.·/()]+/g, ''); }

  // ── 시간 ──────────────────────────────────────────────────
  // 'HH:MM' → 분. 24:00 까지 허용, 형식이 틀리면 null
  function parseTime(s) {
    var m = /^(\d{1,2})\s*[:시]\s*(\d{2})?\s*분?$/.exec(str(s));
    if (!m) return null;
    var hh = Number(m[1]), mm = Number(m[2] || 0);
    if (mm > 59 || hh > 24 || (hh === 24 && mm > 0)) return null;
    return hh * 60 + mm;
  }
  function fmtTime(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }
  function fmtDuration(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + '시간' : '') + (m ? (h ? ' ' : '') + m + '분' : '') || '0분';
  }

  // ── 날짜 ──────────────────────────────────────────────────
  function isDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  // 2026-10-1, 2026.10.01, 2026/10/01 → 2026-10-01
  function normDate(s) {
    var m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/.exec(str(s));
    if (!m) return null;
    var d = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    return isDate(d) ? d : null;
  }
  function addDays(date, n) {
    var d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dateRange(start, end) {
    var out = [];
    for (var d = start; d <= end && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d);
    return out;
  }
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  function weekday(date) { return WEEK[new Date(date + 'T00:00:00Z').getUTCDay()]; }
  function shortDate(date) { return date.slice(5, 7) + '/' + date.slice(8, 10) + '(' + weekday(date) + ')'; }

  // ── 거리 (기획서 3.2) ─────────────────────────────────────
  function haversineKm(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  // 기준점 둘레를 평면으로 펼친 좌표(km). 동쪽 +x, 북쪽 +y. 반경 수십 km 까지는 오차가 작습니다.
  function projectKm(center, p) {
    var rad = Math.PI / 180;
    return {
      x: (p.lng - center.lng) * rad * R_EARTH * Math.cos(center.lat * rad),
      y: (p.lat - center.lat) * rad * R_EARTH
    };
  }
  function unprojectKm(center, xy) {
    var rad = Math.PI / 180;
    return {
      lat: center.lat + xy.y / (R_EARTH * rad),
      lng: center.lng + xy.x / (R_EARTH * rad * Math.cos(center.lat * rad))
    };
  }
  function parseCoord(v) {
    var n = Number(str(v).replace(/,/g, '.').replace(/[^\d.+\-eE]/g, ''));
    return str(v) === '' || !isFinite(n) ? null : n;
  }
  function validLatLng(lat, lng) {
    return typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }
  // 「37.3948, 127.1112」 한 줄로 붙여 넣은 좌표
  function parseLatLngText(s) {
    var m = /(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/.exec(str(s));
    if (!m) return null;
    var lat = Number(m[1]), lng = Number(m[2]);
    // 경도·위도 순으로 적은 경우(127.x, 37.x)를 바로잡음 — 위도는 ±90 을 넘지 못함
    if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) { var t = lat; lat = lng; lng = t; }
    return validLatLng(lat, lng) ? { lat: lat, lng: lng } : null;
  }

  // ── 링크 ──────────────────────────────────────────────────
  // 사용자가 넣은 URL 은 http/https 만 링크로 씁니다(javascript: 등 차단)
  function safeUrl(u) {
    var s = str(u);
    if (!s) return '';
    if (/^(www\.|m\.|map\.|booking\.|naver\.me)/i.test(s)) s = 'https://' + s;
    return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : '';
  }
  // 예약 URL 이 없을 때 쓰는 네이버 지도 검색 링크(사용자가 눌러서 이동하는 일반 링크, API 호출 아님)
  function naverMapSearchUrl(court) {
    var q = str(court.name) + (court.address ? ' ' + str(court.address) : '');
    return q ? 'https://map.naver.com/p/search/' + encodeURIComponent(q) : '';
  }

  // ── 조건 검증 ──────────────────────────────────────────────
  function defaultCond() {
    // 기획서 5.1 검색 조건 예시 + 16장 시나리오(판교역 5 km). 좌표는 판교역 부근 어림값입니다.
    return {
      center: { lat: 37.3948, lng: 127.1112, label: '판교역 부근 (예시)' },
      radiusKm: 5, startDate: '2026-10-01', endDate: '2026-10-07',
      startTime: '18:00', endTime: '22:00', minMinutes: 120,
      bookingOnly: true, matchOnly: false
    };
  }
  function validateCond(c) {
    var errs = [];
    if (!c.center || !validLatLng(c.center.lat, c.center.lng)) errs.push('기준 위치의 위도·경도를 확인해 주세요 (위도 -90~90, 경도 -180~180).');
    if (!(c.radiusKm > 0) || c.radiusKm > 100) errs.push('검색 반경은 0 km 보다 크고 100 km 이하로 적어 주세요.');
    if (!isDate(c.startDate) || !isDate(c.endDate)) errs.push('검색 기간의 날짜를 확인해 주세요.');
    else if (c.endDate < c.startDate) errs.push('검색 기간의 끝 날짜가 시작 날짜보다 앞입니다.');
    else if (dateRange(c.startDate, c.endDate).length > MAX_DAYS) errs.push('검색 기간은 한 번에 ' + MAX_DAYS + '일까지 조회할 수 있습니다.');
    var s = parseTime(c.startTime), e = parseTime(c.endTime);
    if (s == null || e == null) errs.push('희망 시간을 00:00 ~ 24:00 형식으로 적어 주세요.');
    else if (e <= s) errs.push('희망 시간이 자정을 넘거나 끝이 시작보다 빠릅니다. 1단계에서는 같은 날 안의 시간대만 조회합니다.');
    else if (c.minMinutes > e - s) errs.push('최소 연속 이용시간이 희망 시간대보다 깁니다.');
    if (!(c.minMinutes > 0)) errs.push('최소 연속 이용시간을 골라 주세요.');
    return errs;
  }

  // ── 연속 예약 판정 (기획서 5장) ─────────────────────────────
  // 최소 이용시간 T 와 슬롯 단위 S → 필요 연속 슬롯 수 = T / S (나누어떨어지지 않으면 올림)
  function requiredSlots(minMinutes, slotMin) {
    if (!(slotMin > 0) || !(minMinutes > 0)) return null;
    return Math.ceil(minMinutes / slotMin - 1e-9);
  }
  // 「18:00~19:00, 20:00~22:00」 같은 가능 시간 → 슬롯 단위 S 로 자른 슬롯 목록.
  // 슬롯 하나를 다 채우지 못하는 자투리(예: 30분 단위에서 19:00~19:15)는 예약 단위가 아니므로 버립니다.
  function parseRanges(text) {
    var out = [], bad = [];
    str(text).split(/[,;\n]+/).forEach(function (part) {
      var p = str(part);
      if (!p) return;
      var m = /^(\d{1,2}:\d{2})\s*[~\-–]\s*(\d{1,2}:\d{2})$/.exec(p);
      var s = m ? parseTime(m[1]) : null, e = m ? parseTime(m[2]) : null;
      if (s == null || e == null || e <= s) bad.push(p);
      else out.push({ start: s, end: e });
    });
    return { ranges: out, bad: bad };
  }
  function rangesToSlots(ranges, slotMin) {
    var out = [];
    ranges.forEach(function (r) {
      for (var t = r.start; t + slotMin <= r.end; t += slotMin) out.push({ start: t, end: t + slotMin });
    });
    return dedupSlots(out);
  }
  function dedupSlots(list) {
    var seen = {};
    return list.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; })
      .filter(function (s) { var k = s.start + '-' + s.end; if (seen[k]) return false; seen[k] = true; return true; });
  }
  // 이어진(앞 슬롯의 끝 = 다음 슬롯의 시작) 가능 슬롯을 한 덩어리로 묶습니다.
  function runsOf(slots) {
    var runs = [];
    dedupSlots(slots).forEach(function (s) {
      var last = runs[runs.length - 1];
      if (last && s.start === last.end) { last.end = s.end; last.count++; }
      else if (last && s.start < last.end) { last.end = Math.max(last.end, s.end); } // 겹친 입력은 합침
      else runs.push({ start: s.start, end: s.end, count: 1 });
    });
    runs.forEach(function (r) { r.minutes = r.end - r.start; });
    return runs;
  }
  // 하루치 판정: 희망 시간대 [ws, we] 안에 「통째로」 들어가는 슬롯만 보고, 이어진 길이가 T 이상인 덩어리를 찾습니다.
  function judgeDay(slots, ws, we, minMinutes) {
    var inWin = slots.filter(function (s) { return s.start >= ws && s.end <= we && s.end > s.start && s.end <= DAY; });
    var runs = runsOf(inWin);
    var ok = runs.filter(function (r) { return r.minutes >= minMinutes; });
    var max = runs.reduce(function (m, r) { return Math.max(m, r.minutes); }, 0);
    return { runs: runs, okRuns: ok, ok: ok.length > 0, maxMinutes: max, slotCount: inWin.length };
  }
  // 덩어리 안에서 T 시간 예약을 시작할 수 있는 시각들(슬롯 경계마다)
  function startTimes(run, minMinutes, slotMin) {
    var out = [];
    for (var t = run.start; t + minMinutes <= run.end; t += slotMin) out.push(t);
    return out;
  }

  // ── 슬롯 저장소 조작 ──────────────────────────────────────
  function slotsFor(slots, courtId, date) {
    return slots.filter(function (s) { return s.courtId === courtId && s.date === date; });
  }
  function hasDataFor(slots, courtId, date) { return slots.some(function (s) { return s.courtId === courtId && s.date === date; }); }
  // 하루치 가능 슬롯을 통째로 바꿈. 비어 있으면 「그날은 가능 슬롯 없음」을 남기려고 빈 표시 행을 둡니다.
  function setDaySlots(slots, courtId, date, daySlots, stamp) {
    var rest = slots.filter(function (s) { return !(s.courtId === courtId && s.date === date); });
    var list = dedupSlots(daySlots).filter(function (s) { return s.start >= 0 && s.end <= DAY && s.end > s.start; });
    if (!list.length) rest.push({ courtId: courtId, date: date, start: 0, end: 0, none: true, updated: stamp || '' });
    list.forEach(function (s) { rest.push({ courtId: courtId, date: date, start: s.start, end: s.end, updated: stamp || '' }); });
    return rest;
  }
  function clearDay(slots, courtId, date) {
    return slots.filter(function (s) { return !(s.courtId === courtId && s.date === date); });
  }
  function realSlots(list) { return list.filter(function (s) { return !s.none; }); }

  // ── 검색 (기획서 4·5·6장) ─────────────────────────────────
  // 결과 상태: ok = 조건 만족(●), nomatch = 슬롯은 있으나 조건 미충족(○),
  //           nodata = 기간 중 슬롯을 하나도 입력하지 않음(?), nobooking = 네이버 예약 불가(×)
  function search(courts, slots, cond) {
    var errs = validateCond(cond);
    if (errs.length) return { errors: errs, results: [] };
    var ws = parseTime(cond.startTime), we = parseTime(cond.endTime);
    var dates = dateRange(cond.startDate, cond.endDate);
    var results = [];
    courts.forEach(function (c) {
      if (!validLatLng(c.lat, c.lng)) return;
      var dist = haversineKm(cond.center, c);
      if (dist > cond.radiusKm + 1e-9) return;
      var days = [], anyData = false;
      dates.forEach(function (d) {
        var list = slotsFor(slots, c.id, d);
        if (!list.length) { days.push({ date: d, data: false, ok: false, okRuns: [], runs: [], maxMinutes: 0 }); return; }
        anyData = true;
        var j = judgeDay(realSlots(list), ws, we, cond.minMinutes);
        j.date = d; j.data = true;
        days.push(j);
      });
      var okDays = days.filter(function (d) { return d.ok; });
      var status = c.booking === 'no' ? 'nobooking' : okDays.length ? 'ok' : anyData ? 'nomatch' : 'nodata';
      results.push({
        court: c, distanceKm: dist, days: days, okDays: okDays, status: status,
        maxMinutes: days.reduce(function (m, d) { return Math.max(m, d.maxMinutes); }, 0),
        missingDays: days.filter(function (d) { return !d.data; }).length
      });
    });
    var rank = { ok: 0, nomatch: 1, nodata: 2, nobooking: 3 };
    results.sort(function (a, b) { return rank[a.status] - rank[b.status] || a.distanceKm - b.distanceKm; });
    return { errors: [], results: results, dates: dates };
  }
  function filterResults(results, cond) {
    return results.filter(function (r) {
      if (cond.bookingOnly && r.status === 'nobooking') return false;
      if (cond.matchOnly && r.status !== 'ok') return false;
      return true;
    });
  }
  // 「10/02(금) 18:00~22:00」 한 줄 요약 목록
  function summarize(r, limit) {
    var out = [];
    r.okDays.forEach(function (d) {
      d.okRuns.forEach(function (run) { out.push(shortDate(d.date) + ' ' + fmtTime(run.start) + '~' + fmtTime(run.end)); });
    });
    return limit && out.length > limit ? out.slice(0, limit).concat(['외 ' + (out.length - limit) + '건']) : out;
  }

  // ── CSV ──────────────────────────────────────────────────
  // 따옴표·줄바꿈이 든 칸, 쉼표·탭 구분자를 모두 받습니다.
  function parseCsv(text) {
    var t = String(text || '').replace(/^﻿/, '');
    var first = t.split(/\r?\n/)[0] || '';
    var delim = (first.split('\t').length > first.split(',').length) ? '\t' : ',';
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t[i];
      if (q) {
        if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && t[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(function (r) { return r.map(str); }).filter(function (r) { return r.some(function (c) { return c !== ''; }); });
  }
  function toCsv(aoa) {
    return '﻿' + aoa.map(function (r) {
      return r.map(function (v) {
        var s = v == null ? '' : String(v);
        // 수식으로 해석될 수 있는 칸(=, +, -, @ 로 시작)은 엑셀에서 실행되지 않게 작은따옴표를 붙입니다
        if (/^[=+@]/.test(s) || /^-[^\d]/.test(s)) s = "'" + s;
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  // 열 이름 → 코트 항목 (기획서 11.1 영문 필드명과 한글 이름 둘 다)
  var COURT_COLS = {
    name: ['코트명', '시설명', '이름', 'court_name', 'name'],
    address: ['주소', 'address'],
    lat: ['위도', 'latitude', 'lat'],
    lng: ['경도', 'longitude', 'lng', 'lon'],
    phone: ['전화번호', '전화', 'telephone', 'phone', 'tel'],
    bookingUrl: ['네이버예약url', '예약url', 'naver_booking_url', 'booking_url'],
    placeUrl: ['네이버플레이스url', '플레이스url', 'naver_place_url', 'place_url'],
    booking: ['네이버예약', '예약가능여부', 'booking_available', 'booking'],
    indoor: ['실내실외', '실내/실외', 'indoor_outdoor', 'indoor'],
    courtCount: ['코트수', 'court_count'],
    hours: ['운영시간', 'hours'],
    slotMin: ['슬롯단위', '슬롯단위분', '예약단위', 'slot_minutes', 'slot_min']
  };
  var SLOT_COLS = {
    court: ['코트명', '코트', '시설명', 'court_name', 'court', 'court_id'],
    date: ['날짜', '예약날짜', 'date'],
    start: ['슬롯시작', '시작', 'slot_start', 'start'],
    end: ['슬롯종료', '종료', '끝', 'slot_end', 'end'],
    available: ['예약가능', '가능', '예약가능여부', 'available'],
    ranges: ['예약가능시간', '가능시간', 'available_times', 'ranges']
  };
  function mapHeader(header, spec) {
    var idx = {};
    header.forEach(function (h, i) {
      var n = norm(h);
      Object.keys(spec).forEach(function (k) {
        if (idx[k] == null && spec[k].some(function (a) { return norm(a) === n; })) idx[k] = i;
      });
    });
    return idx;
  }
  function yesNo(v) {
    var n = norm(v);
    if (!n) return null;
    if (/^(가능|예|y|yes|true|1|o|○|●|있음|제공)$/.test(n)) return true;
    if (/^(불가|불가능|아니오|n|no|false|0|x|×|없음|미제공)$/.test(n)) return false;
    return null;
  }
  function bookingOf(v) { var b = yesNo(v); return b === true ? 'yes' : b === false ? 'no' : 'unknown'; }
  function cleanCourt(c) {
    var slot = Number(c.slotMin);
    return {
      id: c.id, name: str(c.name), address: str(c.address),
      lat: typeof c.lat === 'number' ? c.lat : parseCoord(c.lat),
      lng: typeof c.lng === 'number' ? c.lng : parseCoord(c.lng),
      phone: str(c.phone), bookingUrl: safeUrl(c.bookingUrl), placeUrl: safeUrl(c.placeUrl),
      booking: ['yes', 'no', 'unknown'].indexOf(c.booking) >= 0 ? c.booking : bookingOf(c.booking),
      indoor: /실내|indoor/i.test(str(c.indoor)) ? '실내' : /실외|outdoor/i.test(str(c.indoor)) ? '실외' : '',
      courtCount: str(c.courtCount).replace(/[^\d]/g, '') ? Number(str(c.courtCount).replace(/[^\d]/g, '')) : null,
      hours: str(c.hours),
      slotMin: [10, 15, 20, 30, 60, 90, 120].indexOf(slot) >= 0 ? slot : 30
    };
  }
  function validateCourt(c, courts) {
    var errs = [];
    if (!c.name) errs.push('코트명을 적어 주세요.');
    if (!validLatLng(c.lat, c.lng)) errs.push('위도·경도를 숫자로 적어 주세요 (예: 37.3948, 127.1112).');
    if (courts && c.name && courts.some(function (o) { return o.id !== c.id && norm(o.name) === norm(c.name); })) errs.push('같은 이름의 코트가 이미 있습니다.');
    return errs;
  }
  // 코트 CSV → { courts:[새 코트], errors:[행 번호·이유] }
  function importCourts(text, existing, nextId) {
    var rows = parseCsv(text);
    if (rows.length < 2) return { courts: [], errors: ['머리행과 자료가 한 줄 이상 있어야 합니다.'], updated: 0 };
    var idx = mapHeader(rows[0], COURT_COLS);
    if (idx.name == null || idx.lat == null || idx.lng == null) {
      return { courts: [], errors: ['「코트명」「위도」「경도」 열을 찾지 못했습니다. 머리행 이름을 확인해 주세요.'], updated: 0 };
    }
    var list = (existing || []).slice(), errors = [], added = [], updated = 0;
    rows.slice(1).forEach(function (r, i) {
      var raw = {};
      Object.keys(idx).forEach(function (k) { raw[k] = r[idx[k]]; });
      var same = list.filter(function (o) { return norm(o.name) === norm(raw.name); })[0];
      raw.id = same ? same.id : nextId();
      var c = cleanCourt(raw);
      var e = validateCourt(c, null);
      if (e.length) { errors.push((i + 2) + '행: ' + e.join(' ')); return; }
      if (same) { list[list.indexOf(same)] = c; updated++; } else { list.push(c); added.push(c); }
    });
    return { courts: list, added: added.length, updated: updated, errors: errors };
  }
  function courtsCsv(courts) {
    var aoa = [['코트명', '주소', '위도', '경도', '전화번호', '네이버 예약', '네이버 예약 URL', '네이버 플레이스 URL', '실내/실외', '코트 수', '운영시간', '슬롯 단위(분)']];
    courts.forEach(function (c) {
      aoa.push([c.name, c.address, c.lat, c.lng, c.phone, { yes: '가능', no: '불가', unknown: '미확인' }[c.booking],
        c.bookingUrl, c.placeUrl, c.indoor, c.courtCount == null ? '' : c.courtCount, c.hours, c.slotMin]);
    });
    return aoa;
  }
  // 슬롯 CSV — 두 형식:
  //   ① 슬롯 한 줄씩  : 코트명, 날짜, 슬롯 시작, 슬롯 종료, 예약 가능(가능/불가)   (기획서 11.3 Availability)
  //   ② 하루 한 줄씩  : 코트명, 날짜, 예약 가능 시간(「18:00~19:00, 20:00~22:00」)   (기획서 5.2 표)
  // 가져온 (코트, 날짜)는 그날 슬롯을 파일 내용으로 통째로 바꿉니다.
  function importSlots(text, courts, slots, stamp) {
    var rows = parseCsv(text);
    if (rows.length < 2) return { slots: slots, errors: ['머리행과 자료가 한 줄 이상 있어야 합니다.'], days: 0 };
    var idx = mapHeader(rows[0], SLOT_COLS);
    var mode = idx.ranges != null ? 'ranges' : (idx.start != null && idx.end != null) ? 'slots' : null;
    if (idx.court == null || idx.date == null || !mode) {
      return { slots: slots, errors: ['「코트명」「날짜」와 「예약 가능 시간」(또는 「슬롯 시작」「슬롯 종료」) 열이 필요합니다.'], days: 0 };
    }
    var byName = {};
    courts.forEach(function (c) { byName[norm(c.name)] = c; byName[norm(c.id)] = c; });
    var errors = [], bucket = {};
    rows.slice(1).forEach(function (r, i) {
      var line = (i + 2) + '행: ';
      var c = byName[norm(r[idx.court])];
      if (!c) { errors.push(line + '코트 목록에 없는 코트입니다 (' + r[idx.court] + ').'); return; }
      var d = normDate(r[idx.date]);
      if (!d) { errors.push(line + '날짜 형식을 확인해 주세요 (' + r[idx.date] + ').'); return; }
      var key = c.id + '|' + d;
      if (!bucket[key]) bucket[key] = { courtId: c.id, date: d, list: [] };
      if (mode === 'ranges') {
        var pr = parseRanges(r[idx.ranges]);
        if (pr.bad.length) errors.push(line + '시간 형식을 읽지 못했습니다 (' + pr.bad.join(', ') + '). 자정을 넘는 시간은 받지 않습니다.');
        bucket[key].list = bucket[key].list.concat(rangesToSlots(pr.ranges, c.slotMin));
      } else {
        var s = parseTime(r[idx.start]), e = parseTime(r[idx.end]);
        if (s == null || e == null || e <= s) { errors.push(line + '슬롯 시간을 확인해 주세요. 자정을 넘는 슬롯은 받지 않습니다.'); return; }
        var av = idx.available == null ? true : yesNo(r[idx.available]);
        if (av === null) { errors.push(line + '예약 가능 칸은 「가능/불가」로 적어 주세요.'); return; }
        if (av) bucket[key].list.push({ start: s, end: e });
      }
    });
    var out = slots, n = 0;
    Object.keys(bucket).forEach(function (k) {
      var b = bucket[k];
      out = setDaySlots(out, b.courtId, b.date, b.list, stamp);
      n++;
    });
    return { slots: out, errors: errors, days: n };
  }
  function slotsCsv(courts, slots) {
    var name = {};
    courts.forEach(function (c) { name[c.id] = c.name; });
    var aoa = [['코트명', '날짜', '슬롯 시작', '슬롯 종료', '예약 가능', '최종 갱신']];
    slots.slice().sort(function (a, b) {
      return (name[a.courtId] || '').localeCompare(name[b.courtId] || '') || a.date.localeCompare(b.date) || a.start - b.start;
    }).forEach(function (s) {
      if (!name[s.courtId] || s.none) return;
      aoa.push([name[s.courtId], s.date, fmtTime(s.start), fmtTime(s.end), '가능', s.updated || '']);
    });
    return aoa;
  }
  function resultsCsv(results, cond) {
    var aoa = [['상태', '코트명', '거리(km)', '네이버 예약', '조건 만족 날짜 수', '최대 연속', '예약 가능 시간(연속 ' + fmtDuration(cond.minMinutes) + ' 이상)', '슬롯 미입력 날짜 수', '네이버 예약 URL']];
    results.forEach(function (r) {
      aoa.push([STATUS_LABEL[r.status], r.court.name, r.distanceKm.toFixed(2), { yes: '가능', no: '불가', unknown: '미확인' }[r.court.booking],
        r.okDays.length, fmtDuration(r.maxMinutes), summarize(r).join(' / '), r.missingDays, r.court.bookingUrl]);
    });
    return aoa;
  }
  var STATUS_LABEL = { ok: '조건 만족', nomatch: '조건 미충족', nodata: '슬롯 미입력', nobooking: '네이버 예약 불가' };

  // ── 백업 ──────────────────────────────────────────────────
  function emptyDb() { return { courts: [], slots: [], seq: 0, cond: defaultCond() }; }
  function makeBackup(db) {
    return JSON.stringify({ app: 'data09-20', version: 1, savedAt: new Date().toISOString(), courts: db.courts, slots: db.slots, seq: db.seq, cond: db.cond, sample: !!db._sample }, null, 2);
  }
  function parseBackup(text) {
    var p = JSON.parse(text);
    if (!p || p.app !== 'data09-20' || !Array.isArray(p.courts) || !Array.isArray(p.slots)) throw new Error('이 도구의 백업 파일이 아닙니다.');
    var db = emptyDb();
    db.courts = p.courts.map(cleanCourt);
    db.slots = p.slots.filter(function (s) { return s && isDate(s.date) && typeof s.start === 'number' && typeof s.end === 'number'; });
    db.seq = typeof p.seq === 'number' ? p.seq : db.courts.length;
    if (p.cond && p.cond.center) db.cond = Object.assign(defaultCond(), p.cond);
    if (p.sample) db._sample = true;
    return db;
  }

  var api = {
    DAY: DAY, MAX_DAYS: MAX_DAYS, STATUS_LABEL: STATUS_LABEL,
    clone: clone, norm: norm,
    parseTime: parseTime, fmtTime: fmtTime, fmtDuration: fmtDuration,
    isDate: isDate, normDate: normDate, addDays: addDays, dateRange: dateRange, weekday: weekday, shortDate: shortDate,
    haversineKm: haversineKm, projectKm: projectKm, unprojectKm: unprojectKm, parseCoord: parseCoord,
    validLatLng: validLatLng, parseLatLngText: parseLatLngText,
    safeUrl: safeUrl, naverMapSearchUrl: naverMapSearchUrl,
    defaultCond: defaultCond, validateCond: validateCond,
    requiredSlots: requiredSlots, parseRanges: parseRanges, rangesToSlots: rangesToSlots, runsOf: runsOf,
    judgeDay: judgeDay, startTimes: startTimes,
    slotsFor: slotsFor, hasDataFor: hasDataFor, setDaySlots: setDaySlots, clearDay: clearDay, realSlots: realSlots,
    search: search, filterResults: filterResults, summarize: summarize,
    parseCsv: parseCsv, toCsv: toCsv, cleanCourt: cleanCourt, validateCourt: validateCourt,
    importCourts: importCourts, courtsCsv: courtsCsv, importSlots: importSlots, slotsCsv: slotsCsv, resultsCsv: resultsCsv,
    emptyDb: emptyDb, makeBackup: makeBackup, parseBackup: parseBackup
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TCLogic = api;
})(typeof window !== 'undefined' ? window : this);
