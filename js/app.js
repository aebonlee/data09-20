/* 예약 가능한 테니스 코트 조회 — 화면 (코트 검색 · 코트 목록 · 예약 슬롯 · 백업·복원 · 네이버 연계 준비) */
(function () {
  'use strict';
  var L = window.TCLogic;
  var S = window.TCStore;
  var Sample = window.TCSample;

  var db = S.loadDb();
  var last = null;          // 마지막 검색 결과
  var pickMode = false;     // 위치 그림을 눌러 기준점 옮기기
  var slotView = { courtId: '', start: '', days: 7 };
  var BOOKING = { yes: '가능', no: '불가', unknown: '미확인' };
  var STATUS_CLASS = { ok: 'ok', nomatch: 'info', nodata: 'muted', nobooking: 'error' };

  // ── 작은 도구 ─────────────────────────────────────────────
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, text) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
    if (text != null) el.textContent = text;
    return el;
  }
  function km(n) { return (n < 10 ? n.toFixed(2) : n.toFixed(1)) + ' km'; }
  function toast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function save() { if (!S.saveDb(db)) document.getElementById('storeBanner').hidden = false; }
  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
  }
  function select(name, options, value, attrs) {
    var s = h('select', Object.assign({ name: name }, attrs || {}));
    options.forEach(function (o) {
      var v = Array.isArray(o) ? o[0] : o, t = Array.isArray(o) ? o[1] : o;
      s.appendChild(h('option', { value: v, selected: String(v) === String(value) }, t));
    });
    return s;
  }
  function openDialog(title, content, actions) {
    var d = document.getElementById('dialog');
    document.getElementById('dialogTitle').textContent = title;
    var c = document.getElementById('dialogContent'); c.textContent = ''; add(c, content);
    var a = document.getElementById('dialogActions'); a.textContent = ''; add(a, actions);
    if (!d.open) d.showModal();
  }
  function closeDialog() { var d = document.getElementById('dialog'); if (d.open) d.close(); }
  function confirmDialog(title, text, okLabel, onOk) {
    openDialog(title, h('p', null, text), [
      h('button', { type: 'button', class: 'btn', onclick: closeDialog }, '취소'),
      h('button', { type: 'button', class: 'btn btn-danger', onclick: function () { closeDialog(); onOk(); } }, okLabel)]);
  }
  function download(name, blob) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function downloadCsv(name, aoa) { download(name, new Blob([L.toCsv(aoa)], { type: 'text/csv;charset=utf-8' })); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function stamp() { return new Date().toISOString(); }
  function tag() { return db._sample ? '_예시데이터' : ''; }
  function courtById(id) { return db.courts.filter(function (c) { return c.id === id; })[0]; }
  function nextId() { db.seq = (db.seq || 0) + 1; while (courtById('c' + db.seq)) db.seq++; return 'c' + db.seq; }
  // 엑셀에서 저장한 CSV 는 EUC-KR(CP949)인 경우가 많아, UTF-8 로 읽어 깨지면 다시 읽습니다
  function readText(file, cb) {
    var r = new FileReader();
    r.onload = function () {
      var buf = r.result, text = new TextDecoder('utf-8').decode(buf);
      if (text.indexOf('�') >= 0) { try { text = new TextDecoder('euc-kr').decode(buf); } catch (e) { /* 그대로 */ } }
      cb(text);
    };
    r.readAsArrayBuffer(file);
  }
  function bookingLink(c, label) {
    if (c.bookingUrl) return h('a', { class: 'btn btn-primary btn-sm', href: c.bookingUrl, target: '_blank', rel: 'noopener noreferrer' }, label || '네이버 예약 열기');
    var u = L.naverMapSearchUrl(c);
    return u ? h('a', { class: 'btn btn-sm', href: u, target: '_blank', rel: 'noopener noreferrer', title: '예약 URL 을 넣지 않아 네이버 지도 검색으로 엽니다' }, '네이버 지도에서 찾기') : null;
  }
  function badge(status) { return h('span', { class: 'badge ' + STATUS_CLASS[status] }, L.STATUS_LABEL[status]); }
  function timeOptions() {
    var out = [];
    for (var t = 0; t <= 1440; t += 30) out.push(L.fmtTime(t));
    return out;
  }

  // ── 예시 데이터 ────────────────────────────────────────────
  function loadSample() {
    db = Sample.sampleDb();
    save(); banner();
    toast('예시 데이터(가상 코트 7곳, 10/01~10/15 슬롯)를 불러왔습니다.');
    location.hash = '#/search';
    route();
  }
  function banner() { document.getElementById('sampleBanner').hidden = !db._sample; }
  function emptyGuide() {
    return h('div', { class: 'card' },
      h('h2', null, '먼저 코트를 등록해 주세요'),
      h('p', null, '이 도구는 네이버 예약 슬롯을 자동으로 가져오지 않습니다(기획서 12~14장의 선행 검증 전). 코트 목록과, 네이버 예약 페이지에서 확인한 예약 가능 시간을 넣으면 연속 이용시간을 판정해 줍니다.'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: loadSample }, '예시 데이터 불러오기'),
        h('a', { class: 'btn', href: '#/courts' }, '코트 직접 등록하기')));
  }

  // ── 1. 코트 검색 ───────────────────────────────────────────
  function renderSearch(main) {
    var c = db.cond;
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '예약 가능 코트 검색')));
    if (!db.courts.length) { main.appendChild(emptyGuide()); }

    var f = {};
    f.label = h('input', { type: 'text', value: c.center.label || '', placeholder: '예: 판교역' });
    f.lat = h('input', { type: 'text', inputmode: 'decimal', value: c.center.lat });
    f.lng = h('input', { type: 'text', inputmode: 'decimal', value: c.center.lng });
    f.paste = h('input', { type: 'text', placeholder: '37.3948, 127.1112', onchange: function () {
      var p = L.parseLatLngText(f.paste.value);
      if (!p) { toast('좌표를 읽지 못했습니다. 「위도, 경도」 형식으로 붙여 넣어 주세요.', true); return; }
      f.lat.value = p.lat; f.lng.value = p.lng; f.paste.value = '';
    } });
    f.fromCourt = select('fromCourt', [['', '— 코트 위치를 기준점으로 —']].concat(db.courts.map(function (x) { return [x.id, x.name]; })), '', {
      onchange: function () {
        var x = courtById(f.fromCourt.value);
        if (x) { f.lat.value = x.lat; f.lng.value = x.lng; f.label.value = x.name; }
      } });
    var geoBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: function () {
      if (!navigator.geolocation) { toast('이 브라우저는 현재 위치를 알려 주지 않습니다.', true); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        f.lat.value = pos.coords.latitude.toFixed(6); f.lng.value = pos.coords.longitude.toFixed(6); f.label.value = '내 현재 위치';
        toast('현재 위치를 기준점으로 넣었습니다. 「예약 가능 코트 검색」을 눌러 주세요.');
      }, function () { toast('현재 위치를 가져오지 못했습니다(권한 거부 또는 파일로 연 경우). 좌표를 직접 적어 주세요.', true); });
    } }, '내 현재 위치 쓰기');

    var presets = ['1', '2', '5', '10'];
    var isPreset = presets.indexOf(String(c.radiusKm)) >= 0;
    f.radiusSel = select('radiusSel', presets.map(function (x) { return [x, x + ' km']; }).concat([['custom', '직접 입력']]), isPreset ? String(c.radiusKm) : 'custom', {
      onchange: function () { f.radius.hidden = f.radiusSel.value !== 'custom'; if (f.radiusSel.value !== 'custom') f.radius.value = f.radiusSel.value; } });
    f.radius = h('input', { type: 'number', min: '0.1', max: '100', step: '0.1', value: c.radiusKm, hidden: isPreset, 'aria-label': '검색 반경(km) 직접 입력' });
    f.start = h('input', { type: 'date', value: c.startDate });
    f.end = h('input', { type: 'date', value: c.endDate });
    f.st = select('st', timeOptions(), c.startTime);
    f.et = select('et', timeOptions(), c.endTime);
    f.min = select('min', [60, 90, 120, 150, 180, 210, 240].map(function (m) { return [m, L.fmtDuration(m)]; }), c.minMinutes);
    f.bookingOnly = h('input', { type: 'checkbox', checked: c.bookingOnly !== false });
    f.matchOnly = h('input', { type: 'checkbox', checked: !!c.matchOnly });

    function readForm() {
      return {
        center: { lat: L.parseCoord(f.lat.value), lng: L.parseCoord(f.lng.value), label: f.label.value.trim() },
        radiusKm: Number(f.radiusSel.value === 'custom' ? f.radius.value : f.radiusSel.value),
        startDate: f.start.value, endDate: f.end.value, startTime: f.st.value, endTime: f.et.value,
        minMinutes: Number(f.min.value), bookingOnly: f.bookingOnly.checked, matchOnly: f.matchOnly.checked
      };
    }
    var errBox = h('div');
    var resultBox = h('div', { id: 'resultBox' });
    function run(silent) {
      var nc = readForm();
      var r = L.search(db.courts, db.slots, nc);
      errBox.textContent = '';
      if (r.errors.length) {
        errBox.appendChild(h('div', { class: 'alert error', role: 'alert' }, h('ul', { class: 'miss-list' }, r.errors.map(function (e) { return h('li', null, e); }))));
        return;
      }
      db.cond = nc; save();
      last = r;
      drawResults(resultBox);
      if (!silent) toast('검색했습니다. 조건 만족 ' + r.results.filter(function (x) { return x.status === 'ok'; }).length + '곳');
    }

    var form = h('form', { class: 'card', onsubmit: function (e) { e.preventDefault(); run(false); } },
      h('h2', null, '검색 조건'),
      h('div', { class: 'form-grid cond-grid' },
        h('fieldset', { class: 'span-all fs' }, h('legend', null, '기준 위치'),
          h('div', { class: 'loc-grid' },
            field('이름(메모)', f.label),
            field('위도', f.lat),
            field('경도', f.lng),
            field('좌표 한 줄 붙여 넣기', f.paste, '「위도, 경도」 — 붙여 넣으면 위 칸에 나눠 들어갑니다')),
          h('div', { class: 'btn-row loc-tools' }, f.fromCourt, geoBtn),
          h('p', { class: 'note' }, '주소를 좌표로 바꾸는 기능(지오코딩)은 네이버 지도 API 키가 필요해 2단계로 미뤘습니다. 지금은 좌표를 적거나, 아래 위치 그림에서 「그림을 눌러 기준점 옮기기」를 켜고 원하는 곳을 눌러 주세요.')),
        h('div', { class: 'field' }, h('span', null, '검색 반경'), h('div', { class: 'inline' }, f.radiusSel, f.radius)),
        h('div', { class: 'field' }, h('span', null, '최소 연속 이용시간'), f.min),
        h('div', { class: 'field' }, h('span', null, '검색 기간'), h('div', { class: 'inline' }, f.start, h('span', { 'aria-hidden': 'true' }, '~'), f.end)),
        h('div', { class: 'field' }, h('span', null, '희망 시간'), h('div', { class: 'inline' }, f.st, h('span', { 'aria-hidden': 'true' }, '~'), f.et)),
        h('div', { class: 'span-all btn-row' },
          h('label', { class: 'check' }, f.bookingOnly, '네이버 예약 가능 시설만'),
          h('label', { class: 'check' }, f.matchOnly, '조건을 만족하는 코트만 보기'))),
      errBox,
      h('div', { class: 'btn-row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, '예약 가능 코트 검색')));
    main.appendChild(form);
    main.appendChild(resultBox);
    renderSearch.run = run;
    if (db.courts.length) run(true);
  }

  function drawResults(box) {
    box.textContent = '';
    var cond = db.cond;
    var all = last.results;
    var shown = L.filterResults(all, cond);
    var outside = db.courts.filter(function (c) { return L.validLatLng(c.lat, c.lng); }).length - all.length;
    var cnt = function (s) { return all.filter(function (r) { return r.status === s; }).length; };
    box.appendChild(h('div', { class: 'kpis' },
      kpi('반경 안 코트', all.length, '곳'), kpi('조건 만족', cnt('ok'), '곳'), kpi('조건 미충족', cnt('nomatch'), '곳'),
      kpi('슬롯 미입력', cnt('nodata'), '곳'), kpi('네이버 예약 불가', cnt('nobooking'), '곳'), kpi('반경 밖', outside, '곳')));
    box.appendChild(h('p', { class: 'note' },
      '판정 기준: ' + cond.startDate + ' ~ ' + cond.endDate + ', 매일 ' + cond.startTime + ' ~ ' + cond.endTime +
      ' 안에서 예약 가능한 슬롯이 끊기지 않고 ' + L.fmtDuration(cond.minMinutes) + ' 이상 이어지는 날을 찾습니다. 희망 시간대를 걸쳐 나가는 슬롯은 세지 않습니다.'));

    var list = h('ol', { class: 'results', id: 'resultList' });
    if (!shown.length) list.appendChild(h('li', { class: 'result' }, all.length ? '거르기 조건에 맞는 코트가 없습니다. 「조건을 만족하는 코트만 보기」를 끄거나 조건을 바꿔 보세요.' : '반경 안에 등록된 코트가 없습니다. 반경을 늘리거나 코트를 등록해 주세요.'));
    shown.forEach(function (r, i) {
      var c = r.court;
      var lines = L.summarize(r, 4);
      list.appendChild(h('li', { class: 'result st-' + r.status, 'data-i': i,
        onmouseenter: function () { mark(i, true); }, onmouseleave: function () { mark(i, false); } },
        h('div', { class: 'result-head' },
          h('span', { class: 'no', 'aria-hidden': 'true' }, String(i + 1)),
          h('span', { class: 'title' }, c.name), badge(r.status)),
        h('dl', null,
          h('dt', null, '거리'), h('dd', null, km(r.distanceKm)),
          h('dt', null, '네이버 예약'), h('dd', null, BOOKING[c.booking] + (c.indoor ? ' · ' + c.indoor : '') + (c.courtCount ? ' · ' + c.courtCount + '면' : '')),
          h('dt', null, '예약 가능'), h('dd', null, lines.length ? lines.join('\n') : r.status === 'nodata' ? '이 기간 슬롯을 아직 입력하지 않았습니다' : '연속 ' + L.fmtDuration(cond.minMinutes) + ' 이상 비는 날이 없습니다'),
          h('dt', null, '최대 연속'), h('dd', null, r.maxMinutes ? L.fmtDuration(r.maxMinutes) : '—'),
          r.missingDays && r.status !== 'nodata' ? [h('dt', null, '미입력'), h('dd', null, r.missingDays + '일은 슬롯을 입력하지 않았습니다')] : null),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: function () { detail(r); } }, '날짜별 상세'),
          h('a', { class: 'btn btn-sm', href: '#/slots', onclick: function () { slotView.courtId = c.id; slotView.start = cond.startDate; } }, '슬롯 입력'),
          bookingLink(c))));
    });

    var plotCard = h('div', { class: 'card plot-card' },
      h('div', { class: 'plot-head' }, h('h2', null, '위치 그림'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: pickMode, onchange: function (e) { pickMode = e.target.checked; plotWrap.classList.toggle('picking', pickMode); } }), '그림을 눌러 기준점 옮기기')),
      h('p', { class: 'note' }, '지도 대신 기준점에서 본 방향·거리로 코트를 찍은 그림입니다(위쪽이 북쪽). 외부 지도 서비스를 부르지 않아 API 키 없이 동작합니다. 표시에 마우스를 올리면 요약이, 누르면 날짜별 상세가 나옵니다.'));
    var plotWrap = h('div', { class: 'plot-wrap' + (pickMode ? ' picking' : '') });
    plotCard.appendChild(plotWrap);
    plotCard.appendChild(legend());
    drawPlot(plotWrap, shown);

    box.appendChild(h('div', { class: 'split' },
      h('div', { class: 'card' },
        h('div', { class: 'plot-head' }, h('h2', null, '검색 결과 ' + shown.length + '곳'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: function () { downloadCsv('테니스코트_검색결과' + tag() + '_' + today() + '.csv', L.resultsCsv(shown, cond)); } }, '결과 CSV 저장')),
        list),
      plotCard));
  }
  function kpi(k, v, unit) { return h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v), h('small', null, unit))); }
  function legend() {
    function sym(status) {
      var s = sv('svg', { width: 18, height: 18, viewBox: '-9 -9 18 18', 'aria-hidden': 'true' });
      markerShape(s, status, 6);
      return s;
    }
    return h('div', { class: 'legend' },
      ['ok', 'nomatch', 'nodata', 'nobooking'].map(function (s) { return h('span', null, sym(s), L.STATUS_LABEL[s]); }),
      h('span', null, h('i', { class: 'center-dot' }), '기준 위치'));
  }
  function markerShape(g, status, r) {
    if (status === 'nobooking') {
      g.appendChild(sv('circle', { r: r + 2, class: 'mk-hit' }));
      g.appendChild(sv('path', { d: 'M' + (-r) + ' ' + (-r) + 'L' + r + ' ' + r + 'M' + r + ' ' + (-r) + 'L' + (-r) + ' ' + r, class: 'mk-x' }));
    } else {
      g.appendChild(sv('circle', { r: r, class: 'mk-' + status }));
    }
  }

  // 기준점 둘레 평면 그림(SVG). 외부 요청 없음.
  function drawPlot(wrap, shown) {
    var cond = db.cond, W = 560, M = 28, cx = W / 2, cy = W / 2;
    var extent = cond.radiusKm * 1.12;
    var scale = (W / 2 - M) / extent;
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + W, class: 'plot', role: 'img', 'aria-label': '기준 위치와 코트 위치 그림' });
    svg.appendChild(sv('rect', { x: 0, y: 0, width: W, height: W, class: 'plot-bg' }));
    svg.appendChild(sv('line', { x1: cx, y1: M / 2, x2: cx, y2: W - M / 2, class: 'plot-axis' }));
    svg.appendChild(sv('line', { x1: M / 2, y1: cy, x2: W - M / 2, y2: cy, class: 'plot-axis' }));
    [0.5, 1].forEach(function (k) {
      svg.appendChild(sv('circle', { cx: cx, cy: cy, r: cond.radiusKm * k * scale, class: k === 1 ? 'plot-radius' : 'plot-ring' }));
      svg.appendChild(sv('text', { x: cx + 4, y: cy - cond.radiusKm * k * scale - 4, class: 'plot-label' }, (cond.radiusKm * k) + ' km'));
    });
    svg.appendChild(sv('text', { x: cx + 6, y: 16, class: 'plot-label plot-n' }, '북'));
    // 축척 막대
    var nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50].filter(function (x) { return x <= extent / 2.5; }).pop() || 0.1;
    svg.appendChild(sv('line', { x1: 14, y1: W - 14, x2: 14 + nice * scale, y2: W - 14, class: 'plot-scale' }));
    svg.appendChild(sv('text', { x: 14, y: W - 20, class: 'plot-label' }, nice + ' km'));
    // 기준점
    svg.appendChild(sv('rect', { x: cx - 7, y: cy - 7, width: 14, height: 14, transform: 'rotate(45 ' + cx + ' ' + cy + ')', class: 'plot-center' }));

    var pop = h('div', { class: 'pop', hidden: true, role: 'tooltip',
      onmouseenter: function () { clearTimeout(drawPlot._t); }, onmouseleave: function () { hidePop(); } });
    function hidePop() { drawPlot._t = setTimeout(function () { pop.hidden = true; }, 200); }

    shown.forEach(function (r, i) {
      var p = L.projectKm(cond.center, r.court);
      var x = cx + p.x * scale, y = cy - p.y * scale;
      var g = sv('g', { class: 'mk', 'data-i': i, transform: 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')', tabindex: 0, role: 'button',
        'aria-label': (i + 1) + '. ' + r.court.name + ', ' + L.STATUS_LABEL[r.status] + ', ' + km(r.distanceKm) });
      markerShape(g, r.status, 9);
      g.appendChild(sv('text', { x: 12, y: -10, class: 'mk-no' }, String(i + 1)));
      function show() {
        clearTimeout(drawPlot._t);
        fillPop(pop, r);
        pop.hidden = false;
        var box = svg.getBoundingClientRect(), k = box.width / W;
        var px = x * k, py = y * k;
        pop.style.left = Math.max(4, Math.min(px + 14, box.width - pop.offsetWidth - 4)) + 'px';
        pop.style.top = (py + 14 + pop.offsetHeight > box.height ? Math.max(4, py - pop.offsetHeight - 14) : py + 14) + 'px';
        mark(i, true);
      }
      g.addEventListener('mouseenter', show);
      g.addEventListener('focus', show);
      g.addEventListener('mouseleave', function () { hidePop(); mark(i, false); });
      g.addEventListener('blur', function () { hidePop(); mark(i, false); });
      g.addEventListener('click', function (e) { e.stopPropagation(); detail(r); });
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); detail(r); } });
      svg.appendChild(g);
    });

    // 그림을 눌러 기준점 옮기기
    svg.addEventListener('click', function (e) {
      if (!pickMode) return;
      var pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      var q = pt.matrixTransform(svg.getScreenCTM().inverse());
      var ll = L.unprojectKm(cond.center, { x: (q.x - cx) / scale, y: (cy - q.y) / scale });
      db.cond.center = { lat: Math.round(ll.lat * 1e6) / 1e6, lng: Math.round(ll.lng * 1e6) / 1e6, label: '그림에서 지정한 위치' };
      save();
      toast('기준점을 옮겼습니다: ' + db.cond.center.lat + ', ' + db.cond.center.lng);
      route();
    });
    wrap.appendChild(svg);
    wrap.appendChild(pop);
  }
  function fillPop(pop, r) {
    pop.textContent = '';
    var lines = L.summarize(r, 3);
    add(pop, [
      h('strong', null, r.court.name),
      h('div', null, '거리: ' + km(r.distanceKm)),
      h('div', null, '네이버 예약: ' + BOOKING[r.court.booking]),
      lines.length ? lines.map(function (l) { return h('div', null, l); }) : h('div', { class: 'muted' }, L.STATUS_LABEL[r.status]),
      r.maxMinutes ? h('div', null, '최대 연속 ' + L.fmtDuration(r.maxMinutes)) : null,
      h('div', { class: 'pop-link' }, bookingLink(r.court))]);
  }
  // 목록 ↔ 표시 서로 강조 (기획서 8장 연동 동작)
  function mark(i, on) {
    var li = document.querySelector('#resultList li[data-i="' + i + '"]');
    var g = document.querySelector('.plot .mk[data-i="' + i + '"]');
    if (li) li.classList.toggle('hl', on);
    if (g) g.classList.toggle('hl', on);
  }

  function detail(r) {
    var cond = db.cond, c = r.court;
    var rows = r.days.map(function (d) {
      var avail = d.data ? d.runs.map(function (x) { return L.fmtTime(x.start) + '~' + L.fmtTime(x.end); }).join(', ') || '없음' : '미입력';
      var verdict = !d.data ? '네이버 예약 페이지에서 확인 필요' :
        d.ok ? d.okRuns.map(function (x) { return L.fmtTime(x.start) + '~' + L.fmtTime(x.end) + ' → ' + L.fmtDuration(x.minutes) + ' 가능'; }).join(', ') : '조건 미충족';
      var starts = d.ok ? d.okRuns.map(function (x) { return L.startTimes(x, cond.minMinutes, c.slotMin).map(L.fmtTime).join(' · '); }).join(' / ') : '';
      return h('tr', { class: d.ok ? 'row-ok' : '' },
        h('td', null, L.shortDate(d.date)), h('td', null, avail), h('td', null, verdict), h('td', null, starts));
    });
    openDialog(c.name, [
      h('p', null, km(r.distanceKm) + ' · 네이버 예약 ' + BOOKING[c.booking] + ' · 슬롯 단위 ' + c.slotMin + '분 · 필요 연속 슬롯 ' + L.requiredSlots(cond.minMinutes, c.slotMin) + '개 (' + L.fmtDuration(cond.minMinutes) + ' ÷ ' + c.slotMin + '분)'),
      c.address || c.phone || c.hours ? h('p', { class: 'note' }, [c.address, c.phone, c.hours ? '운영 ' + c.hours : ''].filter(Boolean).join(' · ')) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, '날짜'), h('th', null, cond.startTime + '~' + cond.endTime + ' 안 가능 시간'), h('th', null, '판정'), h('th', null, '시작 가능 시각'))),
        h('tbody', null, rows))),
      h('p', { class: 'note' }, '판정은 입력한 슬롯 기준입니다. 예약 직전에 네이버 예약 페이지에서 한 번 더 확인해 주세요.')
    ], [
      h('a', { class: 'btn', href: '#/slots', onclick: function () { slotView.courtId = c.id; slotView.start = cond.startDate; closeDialog(); } }, '슬롯 입력'),
      bookingLink(c),
      h('button', { type: 'button', class: 'btn', onclick: closeDialog }, '닫기')]);
  }

  // ── 2. 코트 목록 ───────────────────────────────────────────
  function renderCourts(main) {
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '코트 목록'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { editCourt(null); } }, '코트 추가')));
    main.appendChild(h('p', { class: 'note' }, '검색 대상 코트를 등록합니다(기획서 11.1 Court). 위도·경도가 있어야 거리를 잽니다. 네이버 예약 URL 은 네이버 예약 페이지 주소를 복사해 넣어 주세요 — 결과 화면의 「네이버 예약 열기」가 이 주소로 연결됩니다.'));
    if (!db.courts.length) main.appendChild(emptyGuide());
    else {
      var rows = db.courts.map(function (c) {
        var days = {};
        db.slots.forEach(function (s) { if (s.courtId === c.id) days[s.date] = 1; });
        return h('tr', null,
          h('td', null, h('strong', null, c.name), c.address ? h('div', { class: 'note' }, c.address) : null),
          h('td', { class: 'num' }, L.validLatLng(c.lat, c.lng) ? c.lat + ', ' + c.lng : h('span', { class: 'badge error' }, '좌표 없음')),
          h('td', null, BOOKING[c.booking]),
          h('td', null, [c.indoor, c.courtCount ? c.courtCount + '면' : '', c.hours].filter(Boolean).join(' · ')),
          h('td', { class: 'num' }, c.slotMin + '분'),
          h('td', { class: 'num' }, Object.keys(days).length + '일'),
          h('td', null, c.bookingUrl ? h('a', { href: c.bookingUrl, target: '_blank', rel: 'noopener noreferrer' }, '예약 페이지') : h('span', { class: 'muted' }, '없음')),
          h('td', null, h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn btn-sm', onclick: function () { editCourt(c); } }, '고치기'),
            h('a', { class: 'btn btn-sm', href: '#/slots', onclick: function () { slotView.courtId = c.id; } }, '슬롯'),
            h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: function () {
              confirmDialog('코트 지우기', '「' + c.name + '」와 이 코트의 예약 슬롯을 모두 지웁니다.', '지우기', function () {
                db.courts = db.courts.filter(function (x) { return x.id !== c.id; });
                db.slots = db.slots.filter(function (s) { return s.courtId !== c.id; });
                save(); route(); toast('지웠습니다.');
              });
            } }, '지우기'))));
      });
      main.appendChild(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['코트명', '위도, 경도', '네이버 예약', '시설', '슬롯 단위', '슬롯 입력', '예약 URL', ''].map(function (t) { return h('th', null, t); }))),
        h('tbody', null, rows)))));
    }

    var ta = h('textarea', { rows: 6, placeholder: '코트명,주소,위도,경도,네이버 예약,네이버 예약 URL,슬롯 단위(분)\n가 테니스장,○○시 ○○구,37.40,127.10,가능,https://…,30' });
    function doImport(text) {
      var r = L.importCourts(text, db.courts, nextId);
      if (!r.added && !r.updated) { toast(r.errors[0] || '가져온 코트가 없습니다.', true); return; }
      if (db._sample) { delete db._sample; banner(); }
      db.courts = r.courts; save(); route();
      toast('코트 ' + r.added + '곳 추가, ' + r.updated + '곳 갱신' + (r.errors.length ? ' · 건너뛴 행 ' + r.errors.length + '개' : ''));
      if (r.errors.length) openDialog('건너뛴 행', h('ul', { class: 'miss-list' }, r.errors.map(function (e) { return h('li', null, e); })), [h('button', { type: 'button', class: 'btn', onclick: closeDialog }, '닫기')]);
    }
    main.appendChild(h('div', { class: 'card' },
      h('h2', null, 'CSV 로 한꺼번에 넣기'),
      h('p', { class: 'note' }, '머리행에 「코트명」「위도」「경도」가 있어야 합니다. 그 밖에 주소·전화번호·네이버 예약(가능/불가)·네이버 예약 URL·실내/실외·코트 수·운영시간·슬롯 단위(분)를 읽습니다. 기획서 11.1 의 영문 필드명(court_name, latitude, longitude …)도 됩니다. 이름이 같은 코트는 새로 만들지 않고 고쳐 씁니다.'),
      field('CSV 붙여 넣기', ta),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { doImport(ta.value); } }, '붙여 넣은 내용 가져오기'),
        h('label', { class: 'btn file-btn' }, 'CSV 파일 고르기', h('input', { type: 'file', accept: '.csv,.txt,text/csv', onchange: function (e) {
          var file = e.target.files[0]; if (file) readText(file, doImport); e.target.value = '';
        } })),
        h('button', { type: 'button', class: 'btn', onclick: function () { downloadCsv('코트목록' + tag() + '_' + today() + '.csv', L.courtsCsv(db.courts)); } }, '코트 목록 CSV 저장'),
        h('button', { type: 'button', class: 'btn', onclick: function () { downloadCsv('코트목록_양식.csv', L.courtsCsv([])); } }, '빈 양식 받기'))));
  }

  function editCourt(c) {
    var x = c ? L.clone(c) : { id: '', name: '', address: '', lat: '', lng: '', phone: '', bookingUrl: '', placeUrl: '', booking: 'yes', indoor: '', courtCount: '', hours: '', slotMin: 30 };
    var f = {
      name: h('input', { type: 'text', value: x.name, required: true }),
      address: h('input', { type: 'text', value: x.address }),
      lat: h('input', { type: 'text', inputmode: 'decimal', value: x.lat == null ? '' : x.lat }),
      lng: h('input', { type: 'text', inputmode: 'decimal', value: x.lng == null ? '' : x.lng }),
      phone: h('input', { type: 'text', value: x.phone }),
      booking: select('booking', [['yes', '가능'], ['no', '불가'], ['unknown', '미확인']], x.booking),
      bookingUrl: h('input', { type: 'url', value: x.bookingUrl, placeholder: 'https://…' }),
      placeUrl: h('input', { type: 'url', value: x.placeUrl, placeholder: 'https://…' }),
      indoor: select('indoor', [['', '—'], '실내', '실외'], x.indoor),
      courtCount: h('input', { type: 'number', min: 1, value: x.courtCount == null ? '' : x.courtCount }),
      hours: h('input', { type: 'text', value: x.hours, placeholder: '06:00~23:00' }),
      slotMin: select('slotMin', [10, 15, 20, 30, 60, 90, 120].map(function (m) { return [m, m + '분']; }), x.slotMin)
    };
    var paste = h('input', { type: 'text', placeholder: '37.3948, 127.1112', onchange: function () {
      var p = L.parseLatLngText(paste.value);
      if (p) { f.lat.value = p.lat; f.lng.value = p.lng; paste.value = ''; } else toast('좌표를 읽지 못했습니다.', true);
    } });
    var err = h('div');
    openDialog(c ? '코트 고치기' : '코트 추가', [
      h('div', { class: 'form-grid' },
        field('코트명 (필수)', f.name), field('주소', f.address),
        field('위도 (필수)', f.lat), field('경도 (필수)', f.lng),
        h('div', { class: 'span-all' }, field('좌표 한 줄 붙여 넣기', paste, '「위도, 경도」')),
        field('네이버 예약', f.booking), field('슬롯 단위', f.slotMin, '네이버 예약 페이지의 예약 단위(30분·1시간 등)'),
        h('div', { class: 'span-all' }, field('네이버 예약 URL', f.bookingUrl, 'http·https 주소만 링크로 씁니다')),
        h('div', { class: 'span-all' }, field('네이버 플레이스 URL', f.placeUrl)),
        field('전화번호', f.phone), field('실내/실외', f.indoor),
        field('코트 수', f.courtCount), field('운영시간', f.hours, '예약 슬롯 입력 표의 시간 범위로 씁니다')),
      err
    ], [
      h('button', { type: 'button', class: 'btn', onclick: closeDialog }, '취소'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
        var raw = {}; Object.keys(f).forEach(function (k) { raw[k] = f[k].value; });
        raw.id = c ? c.id : '';
        if (raw.bookingUrl && !L.safeUrl(raw.bookingUrl)) { err.textContent = ''; err.appendChild(h('div', { class: 'alert error' }, '네이버 예약 URL 은 http:// 또는 https:// 로 시작하는 주소만 넣을 수 있습니다.')); return; }
        var n = L.cleanCourt(raw);
        var errs = L.validateCourt(n, db.courts);
        if (errs.length) { err.textContent = ''; err.appendChild(h('div', { class: 'alert error' }, errs.join(' '))); return; }
        if (!c) { n.id = nextId(); db.courts.push(n); } else db.courts[db.courts.indexOf(courtById(c.id))] = n;
        save(); closeDialog(); route(); toast(c ? '고쳤습니다.' : '코트를 추가했습니다.');
      } }, '저장')]);
  }

  // ── 3. 예약 슬롯 ───────────────────────────────────────────
  function renderSlots(main) {
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '예약 슬롯 입력')));
    main.appendChild(h('p', { class: 'note' }, '네이버 예약 페이지에서 확인한 예약 가능 시간을 코트·날짜별로 적습니다(기획서 11.3 Availability). 칸을 누르면 ○(예약 가능)·×(불가)가 바뀝니다. 한 번도 손대지 않은 날은 「미입력」으로 남아, 검색에서 조건 미충족과 구분됩니다.'));
    if (!db.courts.length) { main.appendChild(emptyGuide()); return; }
    if (!courtById(slotView.courtId)) slotView.courtId = db.courts[0].id;
    if (!L.isDate(slotView.start)) slotView.start = db.cond.startDate || today();
    var c = courtById(slotView.courtId);

    var pick = select('court', db.courts.map(function (x) { return [x.id, x.name]; }), c.id, { onchange: function () { slotView.courtId = pick.value; route(); } });
    var start = h('input', { type: 'date', value: slotView.start, onchange: function () { if (L.isDate(start.value)) { slotView.start = start.value; route(); } } });
    var days = select('days', [[7, '7일'], [14, '14일'], [31, '31일']], slotView.days, { onchange: function () { slotView.days = Number(days.value); route(); } });
    main.appendChild(h('div', { class: 'card' },
      h('div', { class: 'filters' }, field('코트', pick), field('시작 날짜', start), field('보이는 기간', days)),
      h('p', { class: 'note' }, '슬롯 단위 ' + c.slotMin + '분 · 표의 시간 범위는 운영시간(' + (c.hours || '미입력 — 06:00~24:00 으로 표시') + ') 기준 · 검색 희망 시간 ' + db.cond.startTime + '~' + db.cond.endTime + ' 은 굵게 표시합니다.')));

    var hr = L.parseRanges(c.hours).ranges[0] || { start: 360, end: 1440 };
    var S = c.slotMin, cols = [];
    for (var t = hr.start; t + S <= hr.end; t += S) cols.push(t);
    var ws = L.parseTime(db.cond.startTime), we = L.parseTime(db.cond.endTime);
    var dates = []; for (var i = 0; i < slotView.days; i++) dates.push(L.addDays(slotView.start, i));

    var thead = h('tr', null, h('th', { class: 'sticky-col' }, '날짜'),
      cols.map(function (t) { return h('th', { class: 'slot-th' + (t >= ws && t + S <= we ? ' in-win' : ''), title: L.fmtTime(t) + '~' + L.fmtTime(t + S) }, t % 60 === 0 ? L.fmtTime(t).slice(0, 2) + '시' : ':' + String(t % 60).padStart(2, '0')); }),
      h('th', null, '판정 (희망 시간 안)'), h('th', null, '가능 시간 한 줄로 적기'), h('th', null, ''));
    var body = dates.map(function (d) {
      var list = L.slotsFor(db.slots, c.id, d), has = list.length > 0, real = L.realSlots(list);
      var on = function (t) { return real.some(function (s) { return s.start <= t && s.end >= t + S; }); };
      var cells = cols.map(function (t) {
        var a = on(t);
        return h('td', { class: 'slot-td' }, h('button', { type: 'button', class: 'slot' + (a ? ' on' : has ? ' off' : ''), 'aria-pressed': a ? 'true' : 'false',
          title: L.shortDate(d) + ' ' + L.fmtTime(t) + '~' + L.fmtTime(t + S) + (a ? ' 예약 가능' : has ? ' 불가' : ' 미입력'),
          onclick: function () {
            var set = cols.filter(function (u) { return u === t ? !a : on(u); }).map(function (u) { return { start: u, end: u + S }; });
            // 표 밖(운영시간 밖)에 입력돼 있던 슬롯은 그대로 둡니다
            var outside = real.filter(function (s) { return s.end <= hr.start || s.start >= hr.end; });
            db.slots = L.setDaySlots(db.slots, c.id, d, set.concat(outside), stamp()); save(); route();
          } }, a ? '○' : has ? '×' : ''));
      });
      var j = L.judgeDay(real, ws, we, db.cond.minMinutes);
      var text = h('input', { type: 'text', class: 'ranges-input', value: L.runsOf(real).map(function (r) { return L.fmtTime(r.start) + '~' + L.fmtTime(r.end); }).join(', '),
        'aria-label': L.shortDate(d) + ' 가능 시간', placeholder: '18:00~20:00, 21:00~22:00',
        onchange: function () {
          var p = L.parseRanges(text.value);
          if (p.bad.length) { toast('읽지 못한 시간: ' + p.bad.join(', ') + ' — 같은 날 안의 「18:00~20:00」 형식으로 적어 주세요.', true); return; }
          db.slots = L.setDaySlots(db.slots, c.id, d, L.rangesToSlots(p.ranges, S), stamp()); save(); route();
        } });
      return h('tr', { class: has ? '' : 'row-empty' },
        h('th', { class: 'sticky-col', scope: 'row' }, L.shortDate(d), h('div', { class: 'note' }, has ? '입력됨' : '미입력')),
        cells,
        h('td', { class: 'verdict' }, !has ? h('span', { class: 'muted' }, '미입력') : j.ok ? h('span', { class: 'badge ok' }, L.fmtDuration(j.maxMinutes) + ' 가능') : h('span', { class: 'badge info' }, '미충족' + (j.maxMinutes ? ' (최대 ' + L.fmtDuration(j.maxMinutes) + ')' : ''))),
        h('td', null, text),
        h('td', null, h('div', { class: 'btn-row nowrap' },
          h('button', { type: 'button', class: 'btn btn-sm', title: '확인했는데 예약 가능한 시간이 없음', onclick: function () { db.slots = L.setDaySlots(db.slots, c.id, d, [], stamp()); save(); route(); } }, '가능 없음'),
          h('button', { type: 'button', class: 'btn btn-sm', title: '입력을 지우고 미입력으로 되돌림', onclick: function () { db.slots = L.clearDay(db.slots, c.id, d); save(); route(); } }, '비우기'))));
    });
    var wrap = h('div', { class: 'table-wrap' }, h('table', { class: 'list slot-table' }, h('thead', null, thead), h('tbody', null, body)));
    main.appendChild(h('div', { class: 'card' },
      wrap,
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'lg-on' }), '○ 예약 가능'), h('span', null, h('i', { class: 'lg-off' }), '× 불가(그날 입력됨)'), h('span', null, h('i', { class: 'lg-none' }), '빈칸 미입력'))));

    // 표가 가로로 길면 희망 시간대가 보이도록 스크롤을 옮겨 둡니다
    var firstWin = wrap.querySelector('.slot-th.in-win'), stick = wrap.querySelector('.sticky-col');
    if (firstWin && stick) wrap.scrollLeft = Math.max(0, firstWin.offsetLeft - stick.offsetWidth - 8);

    var ta = h('textarea', { rows: 6, placeholder: '코트명,날짜,예약 가능 시간\n' + c.name + ',' + slotView.start + ',"18:00~19:00, 20:00~22:00"' });
    function doImport(text) {
      var r = L.importSlots(text, db.courts, db.slots, stamp());
      if (!r.days) { toast(r.errors[0] || '가져온 슬롯이 없습니다.', true); return; }
      db.slots = r.slots; save(); route();
      toast(r.days + '개 날짜(코트별)의 슬롯을 넣었습니다' + (r.errors.length ? ' · 건너뛴 행 ' + r.errors.length + '개' : ''));
      if (r.errors.length) openDialog('건너뛴 행', h('ul', { class: 'miss-list' }, r.errors.map(function (e) { return h('li', null, e); })), [h('button', { type: 'button', class: 'btn', onclick: closeDialog }, '닫기')]);
    }
    main.appendChild(h('div', { class: 'card' },
      h('h2', null, 'CSV 로 한꺼번에 넣기'),
      h('p', { class: 'note' }, '두 형식을 받습니다. ① 하루 한 줄: 「코트명, 날짜, 예약 가능 시간」(기획서 5.2 표처럼 「18:00~19:00, 20:00~22:00」) ② 슬롯 한 줄: 「코트명, 날짜, 슬롯 시작, 슬롯 종료, 예약 가능(가능/불가)」(기획서 11.3). 파일에 나온 코트·날짜는 그날 슬롯을 파일 내용으로 바꿉니다. 자정을 넘는 슬롯은 받지 않습니다.'),
      field('CSV 붙여 넣기', ta),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { doImport(ta.value); } }, '붙여 넣은 내용 가져오기'),
        h('label', { class: 'btn file-btn' }, 'CSV 파일 고르기', h('input', { type: 'file', accept: '.csv,.txt,text/csv', onchange: function (e) {
          var file = e.target.files[0]; if (file) readText(file, doImport); e.target.value = '';
        } })),
        h('button', { type: 'button', class: 'btn', onclick: function () { downloadCsv('예약슬롯' + tag() + '_' + today() + '.csv', L.slotsCsv(db.courts, db.slots)); } }, '전체 슬롯 CSV 저장'))));
  }

  // ── 4. 백업·복원 ───────────────────────────────────────────
  function renderData(main) {
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '백업·복원')));
    main.appendChild(h('div', { class: 'kpis' }, kpi('코트', db.courts.length, '곳'), kpi('입력한 날짜(코트별)', Object.keys(db.slots.reduce(function (m, s) { m[s.courtId + s.date] = 1; return m; }, {})).length, '일'), kpi('예약 가능 슬롯', L.realSlots(db.slots).length, '개')));
    main.appendChild(h('div', { class: 'card' },
      h('h2', null, '백업 파일'),
      h('p', null, '데이터는 이 브라우저(localStorage)에만 저장됩니다. 브라우저 데이터를 지우면 사라지니 백업 파일(JSON)을 저장해 두세요. 다른 PC 로 옮길 때도 이 파일을 씁니다.'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { download('테니스코트_백업' + tag() + '_' + today() + '.json', new Blob([L.makeBackup(db)], { type: 'application/json' })); } }, '백업 파일 저장'),
        h('label', { class: 'btn file-btn' }, '백업 파일로 복원', h('input', { type: 'file', accept: '.json,application/json', onchange: function (e) {
          var file = e.target.files[0]; if (!file) return; e.target.value = '';
          readText(file, function (text) {
            try { var n = L.parseBackup(text); confirmDialog('복원', '지금 데이터를 백업 파일 내용(코트 ' + n.courts.length + '곳)으로 바꿉니다.', '복원', function () { db = n; save(); banner(); route(); toast('복원했습니다.'); }); }
            catch (err) { toast(err.message || '백업 파일을 읽지 못했습니다.', true); }
          });
        } })))));
    main.appendChild(h('div', { class: 'card' },
      h('h2', null, '예시 데이터'),
      h('p', null, '가상 코트 7곳과 10/01~10/15 예약 슬롯을 넣습니다. 「예시 테니스장 A」의 10/01~10/04 는 기획서 5.2 표, 「B」의 10/01 은 5.3 표 그대로입니다. 지금 데이터는 지워집니다.'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { if (db.courts.length) confirmDialog('예시 데이터', '지금 데이터를 지우고 예시 데이터를 넣습니다.', '불러오기', loadSample); else loadSample(); } }, '예시 데이터 불러오기'),
        h('button', { type: 'button', class: 'btn btn-danger', onclick: function () {
          confirmDialog('모두 지우기', '코트·슬롯·검색 조건을 모두 지웁니다. 되돌릴 수 없습니다.', '모두 지우기', function () { S.clearDb(); db = L.emptyDb(); save(); banner(); route(); toast('모두 지웠습니다.'); });
        } }, '모두 지우기'))));
  }

  // ── 5. 네이버 연계 준비 (2단계 PoC) ─────────────────────────
  function renderPoc(main) {
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '네이버 연계 준비 (2단계 PoC)')));
    main.appendChild(h('div', { class: 'alert info' }, '기획서 12~14장 결론대로, 날짜·시간별 네이버 예약 잔여 슬롯을 외부 프로그램이 가져올 수 있는 공식 경로가 확인되기 전에는 자동 수집을 하지 않습니다. 비공식 내부 호출·화면 긁어오기(스크래핑)는 이용약관·차단·유지보수 위험이 있어 쓰지 않습니다. 그 전까지는 「예약 슬롯」 화면에 확인한 값을 적고, 최종 예약은 네이버 예약 페이지에서 합니다.'));
    var gates = [
      ['① 좌표 변환', '주소 → 위도·경도', '좌표 직접 입력 · 그림 클릭 · 현재 위치', 'NAVER Cloud Maps Geocoding API 키 발급, 호출량·요금 확인'],
      ['② 시설 검색', '좌표 + 반경 → 테니스 코트 목록', '코트 목록 직접 등록·CSV + 하버사인 반경 거르기', '지역 검색 API 로 「테니스장」 검색 가능 범위·약관(저장·재표시 허용 여부) 확인'],
      ['③ 예약 여부', '코트 → 네이버 예약 제공 여부', '코트마다 가능/불가/미확인 입력', '공식 API 로 예약 제공 여부를 알 수 있는지 확인'],
      ['④ 예약 슬롯', '코트 + 날짜 + 시간 → 가능 슬롯', '예약 페이지에서 확인한 값을 표·CSV 로 입력', '공식 API·제휴·사업자 연계로 잔여 슬롯을 받을 수 있는지 확인 — 개발 착수 게이트'],
      ['⑤ 연속시간 판정', '슬롯 배열 → 연속 T시간 판정', '완료 — 슬롯 단위 S, 필요 연속 슬롯 T/S, 희망 시간대·기간 적용 (테스트 포함)', '④에서 받는 실제 슬롯 형식에 맞춰 입력 변환만 추가']
    ];
    main.appendChild(h('div', { class: 'card' },
      h('h2', null, '핵심 기술 검증 항목 (기획서 13장)과 1단계 대체 방식'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['검증 단계', '검증 내용', '1단계에서 한 것', '2단계에서 확인할 것'].map(function (t) { return h('th', null, t); }))),
        h('tbody', null, gates.map(function (g) { return h('tr', null, g.map(function (x) { return h('td', null, x); })); }))))));
    main.appendChild(h('div', { class: 'card' },
      h('h2', null, '2단계 착수 전 확인 목록'),
      h('ol', { class: 'miss-list' },
        h('li', null, '네이버 개발자센터·NAVER Cloud 에서 쓸 수 있는 공식 API 범위 — 지도 표시(Maps), 지오코딩, 지역(장소) 검색. 날짜·시간별 예약 슬롯을 주는 공개 API 가 있는지'),
        h('li', null, '이용약관 — 검색 결과를 저장·가공·다시 보여 줘도 되는지, 지도 위에 다른 데이터를 겹쳐 그려도 되는지'),
        h('li', null, 'API 키 발급과 보관 — 지도 키는 웹 서비스 URL(도메인)을 등록해야 하고, 서버용 키(Client Secret)는 공개 리포·브라우저 코드에 넣으면 안 됨'),
        h('li', null, '제휴·사업자 연계 — 코트 운영자가 네이버 스마트플레이스에서 예약 데이터를 내보내거나 공유할 수 있는지'),
        h('li', null, '위 경로가 없으면 범위 재정의(기획서 13장 게이트) — 지금처럼 사용자 확인 입력 + 네이버 예약 페이지 연결을 유지')),
      h('p', { class: 'note' }, '참고: 네이버 스마트플레이스 https://smartplace.naver.com/ · NAVER Cloud Maps API 문서 · 네이버 개발자센터 https://developers.naver.com/ (기획서 부록 A). 착수 시점의 최신 문서로 다시 확인해 주세요.')));
  }

  // ── 라우터 ────────────────────────────────────────────────
  var ROUTES = { search: renderSearch, courts: renderCourts, slots: renderSlots, data: renderData, poc: renderPoc };
  function route() {
    var name = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'search';
    if (!ROUTES[name]) name = 'search';
    var main = document.getElementById('main');
    main.textContent = '';
    document.querySelectorAll('#nav a').forEach(function (a) {
      if (a.getAttribute('data-route') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    ROUTES[name](main);
  }
  window.addEventListener('hashchange', function () { route(); window.scrollTo(0, 0); });
  if (!S.available()) document.getElementById('storeBanner').hidden = false;
  banner();
  route();
})();
