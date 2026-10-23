/* nue: news by interest + stock watchlist with technical analysis.
   Static app, no build step. Data is fetched in the browser; settings live in localStorage. */
(function () {
  'use strict';

  var I = window.NueIndicators;
  var root = document.documentElement;

  /* ------------------------------------------------------------------ helpers */

  function $(s, r) { return (r || document).querySelector(s); }

  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // Tiny DOM builder. Strings become text nodes, so nothing from the network is ever parsed as HTML.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  function pool(list, n, fn) {
    var i = 0;
    var workers = [];
    for (var w = 0; w < Math.min(n, list.length); w++) {
      workers.push((async function () {
        while (i < list.length) { var k = i++; await fn(list[k], k); }
      })());
    }
    return Promise.all(workers);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function hhmm(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function dayLabel(ts) {
    var d = new Date(ts);
    var diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  function locFor(cur) { return cur === 'INR' ? 'en-IN' : 'en-US'; }
  function fmtNum(v, cur) {
    if (v == null || !isFinite(v)) return '–';
    var dp = Math.abs(v) < 1 ? 4 : 2;
    return v.toLocaleString(locFor(cur), { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  var SYMS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  function fmtPrice(v, cur, isIndex) {
    if (v == null || !isFinite(v)) return '–';
    if (isIndex) return fmtNum(v, cur);
    return (SYMS[cur] || (cur ? cur + ' ' : '')) + fmtNum(v, cur);
  }
  function fmtPct(v, dp) {
    if (v == null || !isFinite(v)) return '–';
    return (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(dp == null ? 2 : dp) + '%';
  }
  function tone(v) { return v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; }

  /* ----------------------------------------------------------- network layer */

  // Browsers block cross-site reads from these sources, so requests go through a relay.
  // RELAY is your own Cloudflare Worker (see worker/worker.js and the README), e.g.
  // 'https://nue-relay.yourname.workers.dev/'. Leave it empty to use only the public proxies below,
  // which are free but often blocked or rate limited. The public proxies stay as a backup.
  var RELAY = 'https://nue-relay.urkude449-kp.workers.dev/';
  var PROXIES = [
    function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
    function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); },
    function (u) { return 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u); }
  ];
  if (RELAY) PROXIES.unshift(function (u) { return RELAY.replace(/\/?$/, '/') + '?url=' + encodeURIComponent(u); });
  var proxyStart = 0; // remember which proxy worked last

  async function viaProxy(url, validate) {
    var lastErr = new Error('Could not reach the data source.');
    for (var n = 0; n < PROXIES.length; n++) {
      var idx = (proxyStart + n) % PROXIES.length;
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 14000);
      try {
        var res = await fetch(PROXIES[idx](url), { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('Source answered with HTTP ' + res.status + '.');
        var text = await res.text();
        if (!validate(text)) throw new Error('The source sent something unexpected.');
        proxyStart = idx;
        return text;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e.name === 'AbortError' ? new Error('The source took too long to answer.') : e;
      }
    }
    throw lastErr;
  }

  function pruneCache() {
    try {
      var now = Date.now();
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('nue.n.') === 0 || k.indexOf('nue.c.') === 0) {
          var v = JSON.parse(localStorage.getItem(k));
          if (!v || now - v.t > 864e5) localStorage.removeItem(k);
        }
      });
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ theme */

  function isDark() {
    var t = root.getAttribute('data-theme');
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function themeChanged() { window.dispatchEvent(new Event('nue:theme')); }
  $('#themeBtn').addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    LS.set('nue.theme', next);
    themeChanged();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);

  /* ------------------------------------------------------------------- news */

  var REGIONS = {
    IN: { hl: 'en-IN', gl: 'IN', ceid: 'IN:en' },
    US: { hl: 'en-US', gl: 'US', ceid: 'US:en' },
    GB: { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' },
    AU: { hl: 'en-AU', gl: 'AU', ceid: 'AU:en' }
  };
  var SUGGESTED = ['Technology', 'Artificial Intelligence', 'Business', 'Stock market', 'Startups', 'Science', 'Space',
    'Health', 'Climate', 'Politics', 'World', 'Cricket', 'Football', 'Movies', 'Gaming', 'Education', 'Cybersecurity',
    'Cryptocurrency', 'Electric vehicles', 'Real estate'];
  var MAX_INTERESTS = 12;
  var PAGE = 30;

  var N = {
    interests: LS.get('nue.interests', ['India', 'Technology', 'Artificial Intelligence', 'Stock market', 'Cricket']),
    region: LS.get('nue.region', 'IN'),
    win: LS.get('nue.win', '1d'),
    saved: LS.get('nue.saved', []),
    topic: {},       // interest -> items for the current edition and window
    errors: {},
    filter: 'all',
    view: 'feed',
    q: '',
    show: PAGE,
    loading: false,
    updated: 0,
    started: false,
    run: 0
  };
  if (!REGIONS[N.region]) N.region = 'IN';
  if (['1d', '3d', '7d'].indexOf(N.win) < 0) N.win = '1d';

  function norm(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 70); }

  function parseRss(xml) {
    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('The news feed could not be read.');
    var out = [];
    doc.querySelectorAll('item').forEach(function (it) {
      function tx(sel) { var e = it.querySelector(sel); return e ? e.textContent.trim() : ''; }
      var title = tx('title');
      var src = tx('source');
      if (src && title.slice(-(src.length + 3)) === ' - ' + src) title = title.slice(0, -(src.length + 3));
      var link = tx('link');
      var ts = Date.parse(tx('pubDate')) || 0;
      if (title && link) out.push({ title: title, link: link, source: src, ts: ts });
    });
    return out;
  }

  async function fetchTopic(q, opts) {
    opts = opts || {};
    var win = opts.win || N.win;
    var region = opts.region || N.region;
    var key = 'nue.n.' + region + '.' + win + '.' + q.toLowerCase();
    var cached = LS.get(key, null);
    if (!opts.force && cached && Date.now() - cached.t < 20 * 60e3) return cached.items;
    var r = REGIONS[region];
    var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:' + win) +
      '&hl=' + r.hl + '&gl=' + r.gl + '&ceid=' + encodeURIComponent(r.ceid);
    try {
      var xml = await viaProxy(url, function (t) { return /<rss[\s>]/.test(t); });
      var items = parseRss(xml).slice(0, 20);
      LS.set(key, { t: Date.now(), items: items });
      return items;
    } catch (e) {
      if (cached) return cached.items; // show older stories rather than nothing
      throw e;
    }
  }

  function merged() {
    var map = new Map();
    N.interests.forEach(function (q) {
      (N.topic[q] || []).slice(0, 12).forEach(function (it) {
        var k = norm(it.title);
        var e = map.get(k);
        if (e) { if (e.tags.indexOf(q) < 0) e.tags.push(q); }
        else map.set(k, { title: it.title, link: it.link, source: it.source, ts: it.ts, tags: [q] });
      });
    });
    return Array.from(map.values()).sort(function (a, b) { return b.ts - a.ts; });
  }

  function isSaved(link) { return N.saved.some(function (s) { return s.link === link; }); }
  function toggleSave(it) {
    if (isSaved(it.link)) N.saved = N.saved.filter(function (s) { return s.link !== it.link; });
    else N.saved.unshift({ title: it.title, link: it.link, source: it.source, ts: it.ts, tags: it.tags || [] });
    LS.set('nue.saved', N.saved.slice(0, 200));
    $('#savedCount').textContent = N.saved.length;
    renderFeed();
  }

  function renderInterests() {
    var list = $('#interestList');
    list.replaceChildren.apply(list, N.interests.map(function (q) {
      return h('li', null, h('span', { class: 'chip' }, q,
        h('button', { type: 'button', 'aria-label': 'Remove ' + q, onclick: function () { removeInterest(q); } }, '×')));
    }));
    var sug = $('#suggestList');
    var have = N.interests.map(function (x) { return x.toLowerCase(); });
    sug.replaceChildren.apply(sug, SUGGESTED.filter(function (s) { return have.indexOf(s.toLowerCase()) < 0; }).slice(0, 10).map(function (s) {
      return h('li', null, h('button', { class: 'chip-add', type: 'button', onclick: function () { addInterest(s); } }, '+ ' + s));
    }));
  }

  function addInterest(raw) {
    var q = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!q) return;
    if (N.interests.some(function (x) { return x.toLowerCase() === q.toLowerCase(); })) return;
    if (N.interests.length >= MAX_INTERESTS) {
      $('#newsStatus').textContent = 'You can follow up to ' + MAX_INTERESTS + ' interests. Remove one to add another.';
      return;
    }
    N.interests.push(q);
    LS.set('nue.interests', N.interests);
    renderInterests();
    refreshNews(false);
  }
  function removeInterest(q) {
    N.interests = N.interests.filter(function (x) { return x !== q; });
    delete N.topic[q]; delete N.errors[q];
    if (N.filter === q) N.filter = 'all';
    LS.set('nue.interests', N.interests);
    renderInterests();
    renderFeed();
  }

  function renderFilters(items) {
    var box = $('#topicFilters');
    if (N.view === 'saved' || !N.interests.length) { box.replaceChildren(); return; }
    var counts = {};
    items.forEach(function (it) { it.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
    var kids = [filterBtn('all', 'All', items.length)];
    N.interests.forEach(function (q) { kids.push(filterBtn(q, q, counts[q] || 0)); });
    box.replaceChildren.apply(box, kids);
  }
  function filterBtn(val, label, n) {
    return h('button', {
      type: 'button', class: 'filter', 'aria-pressed': String(N.filter === val),
      onclick: function () { N.filter = val; N.show = PAGE; renderFeed(); }
    }, label, h('small', null, n));
  }

  function row(it, lead) {
    var tags = (it.tags || []).slice(0, 2).map(function (t) { return h('span', { class: 'tag' }, t); });
    var saved = isSaved(it.link);
    return h('li', { class: 'row' + (lead ? ' lead' : '') },
      h('div', { class: 'time' }, it.ts ? hhmm(it.ts) : '--:--'),
      h('div', null,
        h('a', { class: 'hl', href: it.link, target: '_blank', rel: 'noopener noreferrer' }, it.title),
        h('div', { class: 'meta' },
          it.source ? h('span', null, it.source) : null,
          it.ts ? h('span', null, ago(it.ts)) : null,
          tags,
          h('button', {
            type: 'button', class: 'save', 'aria-pressed': String(saved),
            'aria-label': (saved ? 'Remove from saved: ' : 'Save for later: ') + it.title,
            onclick: function () { toggleSave(it); }
          }, saved ? 'Saved' : 'Save'))));
  }

  function renderFeed() {
    var feed = $('#feed');
    var all = merged();
    var list;
    if (N.view === 'saved') {
      list = N.saved.slice().sort(function (a, b) { return b.ts - a.ts; });
    } else {
      renderFilters(all);
      list = N.filter === 'all' ? all : all.filter(function (it) { return it.tags.indexOf(N.filter) >= 0; });
    }
    if (N.q) {
      var q = N.q.toLowerCase();
      list = list.filter(function (it) { return (it.title + ' ' + it.source).toLowerCase().indexOf(q) >= 0; });
    }
    renderNewsStatus(all.length);

    var kids = [];
    if (!list.length) {
      if (N.loading && N.view === 'feed') {
        for (var s = 0; s < 6; s++) kids.push(h('li', { class: 'row', 'aria-hidden': 'true' }, h('div', { class: 'skel', style: 'width:44px' }), h('div', null, h('div', { class: 'skel', style: 'width:92%;height:18px' }), h('div', { class: 'skel', style: 'width:40%;margin-top:10px' }))));
      } else if (N.view === 'saved') {
        kids.push(h('li', { class: 'empty' }, h('strong', null, 'Nothing saved yet'), 'Tap Save on any story to keep it here.'));
      } else if (!N.interests.length) {
        kids.push(h('li', { class: 'empty' }, h('strong', null, 'Pick something to follow'), 'Add an interest on the left and your stories appear here.'));
      } else if (N.q || N.filter !== 'all') {
        kids.push(h('li', { class: 'empty' }, h('strong', null, 'No matching stories'), 'Try another filter or a wider time window.'));
      } else if (Object.keys(N.errors).length) {
        kids.push(h('li', { class: 'empty' }, h('strong', null, 'Could not load stories'), 'Check your connection and press Refresh. Public proxy services can also be blocked on some networks.'));
      } else {
        kids.push(h('li', { class: 'empty' }, h('strong', null, 'No stories in this window'), 'Try the last 3 or 7 days.'));
      }
      feed.replaceChildren.apply(feed, kids);
      $('#moreBtn').hidden = true;
      return;
    }

    var shown = list.slice(0, N.show);
    var lastDay = '';
    shown.forEach(function (it, i) {
      var d = it.ts ? dayLabel(it.ts) : 'Earlier';
      if (d !== lastDay) { kids.push(h('li', { class: 'day', role: 'presentation' }, d)); lastDay = d; }
      kids.push(row(it, i === 0 && N.view === 'feed' && !N.q));
    });
    feed.replaceChildren.apply(feed, kids);
    $('#moreBtn').hidden = list.length <= N.show;
  }

  function renderNewsStatus(total) {
    var el = $('#newsStatus');
    el.replaceChildren();
    if (N.view === 'saved') return;
    if (N.loading) { el.textContent = 'Loading stories for ' + N.interests.length + ' interest' + (N.interests.length === 1 ? '' : 's') + '…'; return; }
    var parts = [];
    if (N.updated) parts.push('Updated ' + hhmm(N.updated) + ' · ' + total + ' stories');
    var bad = Object.keys(N.errors);
    if (bad.length) {
      parts.push(h('span', { class: 'err' }, ' Could not load: ' + bad.join(', ') + '. '));
      parts.push(h('button', { type: 'button', onclick: function () { refreshNews(true); } }, 'Try again'));
    }
    el.append.apply(el, parts);
  }

  async function refreshNews(force) {
    var my = ++N.run;
    N.loading = true;
    N.errors = {};
    $('#refreshBtn').disabled = true;
    renderFeed();
    var win = N.win, region = N.region;
    await pool(N.interests.slice(), 3, async function (q) {
      try {
        var items = await fetchTopic(q, { force: force, win: win, region: region });
        if (my === N.run) N.topic[q] = items;
      } catch (e) {
        if (my === N.run) N.errors[q] = e.message;
      }
      if (my === N.run) renderFeed();
    });
    if (my !== N.run) return;
    N.loading = false;
    N.updated = Date.now();
    $('#refreshBtn').disabled = false;
    renderFeed();
  }

  function initNews() {
    if (N.started) return;
    N.started = true;
    $('#regionSel').value = N.region;
    $('#winSel').value = N.win;
    $('#savedCount').textContent = N.saved.length;
    renderInterests();
    renderFeed();
    refreshNews(false);
  }

  $('#interestForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('#interestInput');
    addInterest(inp.value);
    inp.value = '';
  });
  $('#regionSel').addEventListener('change', function (e) {
    N.region = e.target.value; LS.set('nue.region', N.region); N.topic = {}; N.show = PAGE; refreshNews(false);
  });
  $('#winSel').addEventListener('change', function (e) {
    N.win = e.target.value; LS.set('nue.win', N.win); N.topic = {}; N.show = PAGE; refreshNews(false);
  });
  $('#refreshBtn').addEventListener('click', function () { refreshNews(true); });
  $('#moreBtn').addEventListener('click', function () { N.show += PAGE; renderFeed(); });
  $('#searchInput').addEventListener('input', function (e) { N.q = e.target.value.trim(); N.show = PAGE; renderFeed(); });
  function setView(v) {
    N.view = v; N.show = PAGE;
    $('#viewFeed').setAttribute('aria-pressed', String(v === 'feed'));
    $('#viewSaved').setAttribute('aria-pressed', String(v === 'saved'));
    renderFeed();
  }
  $('#viewFeed').addEventListener('click', function () { setView('feed'); });
  $('#viewSaved').addEventListener('click', function () { setView('saved'); });

  /* ----------------------------------------------------------------- stocks */

  var DEFAULT_WATCH = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'AAPL'];
  var INDEXES = [['^NSEI', 'Nifty 50'], ['^BSESN', 'Sensex'], ['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq']];
  var MAX_WATCH = 15;

  var S = {
    watch: LS.get('nue.watch', DEFAULT_WATCH),
    data: {},
    idx: {},
    sel: null,
    range: LS.get('nue.range', '6M'),
    started: false,
    pending: 0,
    updated: 0,
    ro: null
  };
  if (['3M', '6M', '1Y'].indexOf(S.range) < 0) S.range = '6M';
  S.sel = S.watch[0] || null;

  function normSym(s) {
    s = String(s).trim().toUpperCase().replace(/\s+/g, '');
    var m = s.match(/^(NSE|BSE):(.+)$/);
    if (m) return m[2] + (m[1] === 'NSE' ? '.NS' : '.BO');
    return s;
  }
  function validSym(s) { return /^[\^A-Z0-9.\-=&]{1,20}$/.test(s); }

  async function fetchChart(sym, range, force) {
    var key = 'nue.c.' + sym + '.' + range;
    var cached = LS.get(key, null);
    if (!force && cached && Date.now() - cached.t < 10 * 60e3) return cached;
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) +
      '?range=' + range + '&interval=1d&includePrePost=false';
    try {
      var text = await viaProxy(url, function (t) { return t.trim().charAt(0) === '{'; });
      var j = JSON.parse(text);
      var ch = j.chart;
      if (!ch || ch.error || !ch.result || !ch.result[0]) {
        var msg = ch && ch.error && ch.error.description ? ch.error.description : 'No data found for this symbol.';
        var err = new Error(msg); err.final = true; throw err;
      }
      var r = ch.result[0];
      var q = r.indicators && r.indicators.quote && r.indicators.quote[0];
      var ts = r.timestamp || [];
      if (!q || !ts.length) { var e2 = new Error('No price history for this symbol.'); e2.final = true; throw e2; }
      var bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
      for (var i = 0; i < ts.length; i++) {
        var c = q.close[i];
        if (c == null) continue;
        bars.t.push(ts[i] * 1000);
        bars.c.push(round(c));
        bars.o.push(round(q.open[i] != null ? q.open[i] : c));
        bars.h.push(round(q.high[i] != null ? q.high[i] : c));
        bars.l.push(round(q.low[i] != null ? q.low[i] : c));
        bars.v.push(q.volume[i] || 0);
      }
      var m = r.meta || {};
      var out = {
        t: Date.now(),
        bars: bars,
        meta: {
          symbol: m.symbol || sym,
          name: m.longName || m.shortName || sym,
          currency: m.currency || '',
          exchange: m.fullExchangeName || m.exchangeName || '',
          type: m.instrumentType || '',
          price: m.regularMarketPrice
        }
      };
      LS.set(key, out);
      return out;
    } catch (e) {
      if (!e.final && cached) return cached;
      throw e;
    }
  }
  function round(x) { return Math.round(x * 10000) / 10000; }

  async function loadSymbol(sym, force) {
    S.data[sym] = Object.assign({}, S.data[sym], { loading: true, err: null });
    renderTable();
    try {
      var res = await fetchChart(sym, '1y', force);
      var a = I.analyze(res.bars, res.meta.price);
      S.data[sym] = { meta: res.meta, bars: res.bars, a: a, loading: false, err: null };
    } catch (e) {
      S.data[sym] = { loading: false, err: e.message || 'Could not load this symbol.' };
    }
    renderTable();
    if (S.sel === sym) renderDetail();
  }

  async function loadAll(force) {
    S.pending = S.watch.length;
    renderStockStatus();
    await pool(S.watch.slice(), 3, async function (sym) {
      await loadSymbol(sym, force);
      S.pending--;
      renderStockStatus();
    });
    S.updated = Date.now();
    renderStockStatus();
  }

  function renderStockStatus() {
    var el = $('#stockStatus');
    el.replaceChildren();
    if (S.pending > 0) { el.textContent = 'Loading prices… ' + (S.watch.length - S.pending) + ' of ' + S.watch.length; return; }
    var kids = [];
    if (S.updated) kids.push('Updated ' + hhmm(S.updated) + '. ');
    var bad = S.watch.filter(function (s) { return S.data[s] && S.data[s].err; });
    if (bad.length) kids.push(h('span', { class: 'err' }, bad.length + ' symbol' + (bad.length === 1 ? '' : 's') + ' could not load. '));
    kids.push(h('button', { type: 'button', onclick: function () { loadAll(true); loadIndexes(true); } }, 'Refresh prices'));
    el.append.apply(el, kids);
  }

  // previous-close logic shared by the strip and the table
  function quoteOf(bars, livePrice) {
    var c = bars.c;
    var lastC = c[c.length - 1];
    var price = livePrice != null && isFinite(livePrice) ? livePrice : lastC;
    var prev = Math.abs(lastC - price) / price < 1e-6 ? c[c.length - 2] : lastC;
    return { price: price, prev: prev, pct: prev ? price / prev - 1 : null, chg: price - prev };
  }

  async function loadIndexes(force) {
    await pool(INDEXES, 4, async function (pair) {
      var sym = pair[0];
      try {
        var res = await fetchChart(sym, '5d', force);
        S.idx[sym] = { q: quoteOf(res.bars, res.meta.price), cur: res.meta.currency };
      } catch (e) { S.idx[sym] = { err: true }; }
      renderMarket();
    });
  }

  function renderMarket() {
    var box = $('#marketStrip');
    box.replaceChildren.apply(box, INDEXES.map(function (pair) {
      var d = S.idx[pair[0]];
      var inner;
      if (!d) inner = [h('div', { class: 'skel', style: 'width:70%;height:24px;margin-top:6px' }), h('div', { class: 'skel', style: 'width:40%;margin-top:8px' })];
      else if (d.err) inner = [h('div', { class: 'val flat' }, '–'), h('div', { class: 'chg flat' }, 'Unavailable')];
      else inner = [
        h('div', { class: 'val' }, fmtNum(d.q.price, d.cur)),
        h('div', { class: 'chg ' + tone(d.q.pct) }, fmtPct(d.q.pct) + '  (' + (d.q.chg >= 0 ? '+' : '−') + fmtNum(Math.abs(d.q.chg), d.cur) + ')')
      ];
      return h('div', { class: 'idx' }, h('div', { class: 'nm' }, pair[1]), inner);
    }));
  }

  function renderTable() {
    var body = $('#watchBody');
    if (!S.watch.length) {
      body.replaceChildren(h('tr', null, h('td', { colspan: '7', class: 'empty' }, 'Your watchlist is empty. Add a symbol above to start.')));
      return;
    }
    body.replaceChildren.apply(body, S.watch.map(function (sym) {
      var d = S.data[sym];
      var selected = S.sel === sym;
      var tr = h('tr', { 'aria-selected': String(selected), onclick: function () { select(sym); } });
      var symCell = h('td', null,
        h('button', { type: 'button', class: 'sym', style: 'appearance:none;background:none;border:0;color:inherit;padding:0;cursor:pointer;', onclick: function (e) { e.stopPropagation(); select(sym); } }, sym),
        d && d.meta ? h('span', { class: 'sym-name' }, d.meta.name) : null);
      var rm = h('td', null, h('button', { type: 'button', class: 'x', 'aria-label': 'Remove ' + sym, onclick: function (e) { e.stopPropagation(); removeSymbol(sym); } }, '×'));
      tr.append(symCell);
      if (!d || d.loading) {
        for (var i = 0; i < 5; i++) tr.append(h('td', { 'aria-hidden': 'true' }, h('div', { class: 'skel', style: 'width:' + (i === 4 ? 90 : 56) + 'px' })));
      } else if (d.err) {
        tr.append(h('td', { colspan: '5' }, h('span', { class: 'row-err' }, d.err + ' '), h('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:2px 8px;font-size:12px', onclick: function (e) { e.stopPropagation(); loadSymbol(sym, true); } }, 'Retry')));
      } else {
        var a = d.a, isIdx = d.meta.type === 'INDEX';
        tr.append(
          h('td', { class: 'num' }, fmtPrice(a.price, d.meta.currency, isIdx)),
          h('td', { class: 'num ' + tone(a.chgPct) }, fmtPct(a.chgPct)),
          h('td', { class: 'num ' + tone(a.ret.m1) }, fmtPct(a.ret.m1, 1)),
          h('td', { class: 'num' }, a.rsi == null ? '–' : a.rsi.toFixed(0)),
          h('td', null, h('span', { class: 'pill ' + a.tone }, a.label)));
      }
      tr.append(rm);
      return tr;
    }));
  }

  function select(sym) {
    S.sel = sym;
    renderTable();
    renderDetail();
  }

  function removeSymbol(sym) {
    S.watch = S.watch.filter(function (s) { return s !== sym; });
    delete S.data[sym];
    LS.set('nue.watch', S.watch);
    if (S.sel === sym) S.sel = S.watch[0] || null;
    renderTable();
    renderDetail();
    renderStockStatus();
  }

  $('#symForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('#symInput');
    var parts = inp.value.split(/[\s,;]+/).map(normSym).filter(Boolean);
    var added = [], bad = [];
    parts.forEach(function (s) {
      if (!validSym(s)) { bad.push(s); return; }
      if (S.watch.indexOf(s) >= 0 || added.indexOf(s) >= 0) return;
      if (S.watch.length + added.length >= MAX_WATCH) return;
      added.push(s);
    });
    inp.value = '';
    if (bad.length) $('#stockStatus').textContent = 'Skipped invalid symbol' + (bad.length > 1 ? 's' : '') + ': ' + bad.join(', ');
    if (!added.length) return;
    S.watch = S.watch.concat(added);
    LS.set('nue.watch', S.watch);
    S.sel = added[0];
    renderTable();
    added.forEach(function (s) { loadSymbol(s, false); });
  });

  /* ------------------------------------------------------------ stock detail */

  function metric(k, v, s, extra) {
    return h('div', { class: 'metric' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null, extra);
  }

  function renderDetail() {
    var box = $('#detail');
    if (S.ro) { S.ro.disconnect(); S.ro = null; }
    var d = S.sel && S.data[S.sel];
    if (!d || !d.a) { box.replaceChildren(); return; }
    var a = d.a, m = d.meta, cur = m.currency, isIdx = m.type === 'INDEX';
    var chgTxt = (a.chg >= 0 ? '+' : '−') + fmtNum(Math.abs(a.chg), cur) + '  (' + fmtPct(a.chgPct) + ')';

    var canvas = h('canvas', { role: 'img', 'aria-label': 'Price chart for ' + S.sel + ' with 50 and 200 day averages' });
    var wrap = h('div', { class: 'chart-wrap' }, canvas);

    var rangeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Chart range' },
      ['3M', '6M', '1Y'].map(function (r) {
        return h('button', {
          type: 'button', class: 'seg-btn', 'aria-pressed': String(S.range === r),
          onclick: function (e) {
            S.range = r; LS.set('nue.range', r);
            Array.prototype.forEach.call(e.target.parentNode.children, function (b) { b.setAttribute('aria-pressed', String(b === e.target)); });
            draw();
          }
        }, r);
      }));

    var legend = h('div', { class: 'legend' },
      h('span', null, h('b', { style: 'background:var(--accent)' }), 'Close'),
      h('span', null, h('b', { style: 'background:var(--warn)' }), '50-day'),
      h('span', null, h('b', { style: 'background:var(--ink-2)' }), '200-day'));

    var pos = Math.max(0, Math.min(1, a.pos52)) * 100;
    var rsiNote = a.rsi == null ? '' : a.rsi >= 70 ? 'Overbought' : a.rsi <= 30 ? 'Oversold' : 'Neutral range';

    var grid = h('div', { class: 'grid' },
      metric('52-week range', fmtNum(a.lo52, cur) + ' – ' + fmtNum(a.hi52, cur), Math.round(a.pos52 * 100) + '% of the way up',
        h('div', { class: 'rangebar', 'aria-hidden': 'true' }, h('i', { style: 'left:' + pos + '%' }))),
      metric('3-month return', fmtPct(a.ret.m3, 1),
        '1M ' + fmtPct(a.ret.m1, 1) + ' · 6M ' + fmtPct(a.ret.m6, 1) + (a.ret.y1 != null ? ' · 1Y ' + fmtPct(a.ret.y1, 1) : '')),
      metric('RSI (14)', a.rsi == null ? '–' : a.rsi.toFixed(1), rsiNote),
      metric('MACD', a.macd.line == null ? '–' : a.macd.line.toFixed(2),
        a.macd.signal == null ? '' : (a.macd.line > a.macd.signal ? 'Above' : 'Below') + ' signal line (' + a.macd.signal.toFixed(2) + ')'),
      metric('50-day average', fmtNum(a.sma50, cur), '20-day ' + fmtNum(a.sma20, cur) + ' · 200-day ' + fmtNum(a.sma200, cur)),
      metric('20-day low / high', fmtNum(a.support, cur) + ' / ' + fmtNum(a.resistance, cur), 'Nearby support and resistance'),
      metric('Volatility (annualised)', a.vol == null ? '–' : (a.vol * 100).toFixed(1) + '%', 'Worst drop in the last year ' + fmtPct(a.mdd, 1)));

    var n = a.factors.length;
    var meter = h('div', { class: 'meter', 'aria-hidden': 'true' });
    var onCount = Math.round(Math.abs(a.norm) * n);
    for (var i = 0; i < n; i++) {
      meter.append(h('i', { class: i < onCount ? 'on-' + a.tone : '' }));
    }
    var factors = h('ul', { class: 'factors' }, a.factors.map(function (f) {
      var t = f.score > 0 ? 'up' : f.score < 0 ? 'down' : 'flat';
      return h('li', null,
        h('span', { class: 'f-tag ' + t }, f.score > 0 ? 'Bullish' : f.score < 0 ? 'Bearish' : 'Neutral'),
        h('span', null, h('span', { class: 'f-name' }, f.name), h('span', { class: 'f-txt' }, f.text)));
    }));

    var read = h('div', { class: 'read' },
      h('div', null, h('h3', null, 'Technical read'), h('div', { class: 'verdict ' + a.tone }, a.label), meter,
        h('p', { class: 'hint' }, a.factors.filter(function (f) { return f.score > 0; }).length + ' bullish, ' + a.factors.filter(function (f) { return f.score < 0; }).length + ' bearish, ' + a.factors.filter(function (f) { return f.score === 0; }).length + ' neutral signals')),
      factors);

    var newsList = h('ul', { class: 'mini' }, h('li', null, h('div', { class: 'skel', style: 'width:80%;height:16px' })));
    var news = h('div', { class: 'news-h' }, h('h3', null, 'Recent headlines'), newsList);

    box.replaceChildren(
      h('div', { class: 'd-head' },
        h('div', null, h('h2', { class: 'd-title' }, m.name), h('div', { class: 'd-sub' }, S.sel + (m.exchange ? ' · ' + m.exchange : '') + (cur ? ' · ' + cur : ''))),
        h('div', { class: 'd-price' }, h('div', { class: 'big' }, fmtPrice(a.price, cur, isIdx)), h('div', { class: 'chg ' + tone(a.chg) }, chgTxt))),
      h('div', { class: 'ranges' }, rangeSeg, legend),
      wrap, grid, read, news);

    var hover = null;
    function draw() { drawChart(canvas, d, S.range, hover); }
    canvas.addEventListener('pointermove', function (e) {
      var g = canvas._g; if (!g) return;
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var i = Math.round((x - g.L) / g.pw * (g.len - 1));
      hover = Math.max(0, Math.min(g.len - 1, i));
      draw();
    });
    canvas.addEventListener('pointerleave', function () { hover = null; draw(); });
    if (window.ResizeObserver) { S.ro = new ResizeObserver(draw); S.ro.observe(wrap); }
    draw();

    // related headlines
    var sym = S.sel;
    var clean = m.name.replace(/\s*\b(Limited|Ltd\.?|Inc\.?|Corporation|Corp\.?|PLC|Co\.)\s*$/i, '').trim();
    var query = isIdx ? clean : clean + ' stock';
    fetchTopic(query, { win: '7d', region: N.region }).then(function (items) {
      if (S.sel !== sym) return;
      if (!items.length) { newsList.replaceChildren(h('li', null, h('span', null, 'No recent headlines found.'))); return; }
      newsList.replaceChildren.apply(newsList, items.slice(0, 5).map(function (it) {
        return h('li', null, h('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer' }, it.title),
          h('span', null, [it.source, it.ts ? ago(it.ts) : ''].filter(Boolean).join(' · ')));
      }));
    }).catch(function () {
      if (S.sel === sym) newsList.replaceChildren(h('li', null, h('span', null, 'Headlines could not be loaded right now.')));
    });
  }

  function drawChart(cv, d, rangeKey, hoverI) {
    var W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var cs = getComputedStyle(root);
    function col(n) { return cs.getPropertyValue(n).trim(); }
    var mono = col('--f-mono') || 'monospace';

    var bars = d.bars, total = bars.c.length;
    var n = rangeKey === '3M' ? 63 : rangeKey === '6M' ? 126 : total;
    var s0 = Math.max(0, total - n), len = total - s0;
    var ys = bars.c.slice(s0), ts = bars.t.slice(s0);
    var s50 = d.a.series.sma50.slice(s0), s200 = d.a.series.sma200.slice(s0);

    var lo = Infinity, hi = -Infinity;
    [ys, s50, s200].forEach(function (arr) {
      arr.forEach(function (v) { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } });
    });
    var padv = (hi - lo) * 0.06 || 1;
    lo -= padv; hi += padv;

    var L = 6, R = 64, T = 8, B = 22;
    var pw = W - L - R, ph = H - T - B;
    function X(i) { return L + (len <= 1 ? 0 : (i / (len - 1)) * pw); }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * ph; }
    var cur = d.meta.currency;

    // grid + y labels
    ctx.font = '11px ' + mono;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    for (var k = 0; k <= 4; k++) {
      var val = lo + (hi - lo) * k / 4;
      var y = Math.round(Y(val)) + 0.5;
      ctx.strokeStyle = col('--line');
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillStyle = col('--ink-2');
      ctx.fillText(val.toLocaleString(locFor(cur), { maximumFractionDigits: val < 10 ? 2 : 0 }), W - R + 8, y);
    }
    // x labels
    ctx.textBaseline = 'alphabetic';
    var ticks = 5;
    for (var t = 0; t < ticks; t++) {
      var idx = Math.round((len - 1) * t / (ticks - 1));
      var dt = new Date(ts[idx]);
      var lbl = rangeKey === '1Y' ? dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      ctx.fillStyle = col('--ink-2');
      ctx.textAlign = t === 0 ? 'left' : t === ticks - 1 ? 'right' : 'center';
      ctx.fillText(lbl, X(idx), H - 6);
    }

    function line(arr, color, width, dash) {
      ctx.beginPath();
      var started = false;
      arr.forEach(function (v, i) {
        if (v == null) return;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
      });
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // area under price
    ctx.beginPath();
    ys.forEach(function (v, i) { if (i === 0) ctx.moveTo(X(i), Y(v)); else ctx.lineTo(X(i), Y(v)); });
    ctx.lineTo(X(len - 1), T + ph); ctx.lineTo(X(0), T + ph); ctx.closePath();
    ctx.fillStyle = col('--accent-soft');
    ctx.fill();

    line(s200, col('--ink-2'), 1.25, [5, 4]);
    line(s50, col('--warn'), 1.25, []);
    line(ys, col('--accent'), 2, []);

    // latest point
    ctx.beginPath(); ctx.arc(X(len - 1), Y(ys[len - 1]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = col('--accent'); ctx.fill();

    cv._g = { L: L, pw: pw, len: len };

    // hover crosshair + tooltip
    if (hoverI != null && hoverI >= 0 && hoverI < len) {
      var hx = X(hoverI), hy = Y(ys[hoverI]);
      ctx.strokeStyle = col('--ink-2'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, T); ctx.lineTo(Math.round(hx) + 0.5, T + ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fillStyle = col('--surface'); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = col('--accent'); ctx.stroke();

      var label = new Date(ts[hoverI]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + '   ' + fmtNum(ys[hoverI], cur);
      ctx.font = '12px ' + mono;
      var tw = ctx.measureText(label).width + 16;
      var bx = hx + 12; if (bx + tw > W - R) bx = hx - 12 - tw; if (bx < L) bx = L;
      var by = T + 6;
      ctx.fillStyle = col('--surface'); ctx.strokeStyle = col('--line'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, tw, 24, 6) : ctx.rect(bx, by, tw, 24);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = col('--ink'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 8, by + 12.5);
    }
  }

  window.addEventListener('nue:theme', function () {
    if (S.started) renderDetail();
  });

  function initStocks() {
    if (S.started) return;
    S.started = true;
    renderMarket();
    renderTable();
    renderStockStatus();
    loadIndexes(false);
    loadAll(false);
  }

  /* ------------------------------------------------------------- tabs, boot */

  var TABS = ['news', 'stocks'];
  function showTab(name, focus) {
    if (TABS.indexOf(name) < 0) name = 'news';
    TABS.forEach(function (t) {
      var on = t === name;
      $('#panel-' + t).hidden = !on;
      var btn = $('#tab-' + t);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    });
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    LS.set('nue.tab', name);
    if (name === 'news') initNews(); else initStocks();
  }
  TABS.forEach(function (t) {
    $('#tab-' + t).addEventListener('click', function () { showTab(t); });
    $('#tab-' + t).addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var i = (TABS.indexOf(t) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
        showTab(TABS[i], true);
      }
    });
  });
  window.addEventListener('hashchange', function () {
    var name = location.hash.replace('#', '');
    if (TABS.indexOf(name) >= 0) showTab(name);
  });

  $('#today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  pruneCache();
  var start = location.hash.replace('#', '');
  showTab(TABS.indexOf(start) >= 0 ? start : LS.get('nue.tab', 'news'));
})();
