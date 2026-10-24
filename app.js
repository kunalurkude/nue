/* nue: news by interest + stock watchlist with technical analysis.
   Static app, no build step. Data is fetched in the browser; settings live in localStorage. */
(function () {
  'use strict';

  var I = window.NueIndicators;
  var V = window.NueViz;
  var UI = window.NueUI || { toast: function () {}, buzz: function () {}, setPull: function () {} };
  var root = document.documentElement;
  var currentTab = 'news';

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
  function themeIcon() { $('#themeBtn').replaceChildren(V.icon(isDark() ? 'sun' : 'moon')); }
  function themeChanged() { themeIcon(); window.dispatchEvent(new Event('nue:theme')); }
  themeIcon();
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
    sort: LS.get('nue.sort', 'priority') === 'newest' ? 'newest' : 'priority',
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

  // Bing wraps article links in a redirect (bing.com/news/apiclick...?url=<real address>). Use the real one.
  function realLink(href) {
    try {
      var u = new URL(href);
      if (/(^|\.)bing\.com$/.test(u.hostname)) {
        var real = u.searchParams.get('url');
        if (real && /^https?:\/\//i.test(real)) return real;
      }
    } catch (e) { /* keep the original */ }
    return href;
  }
  var WINDOW_MS = { '1d': 864e5, '3d': 3 * 864e5, '7d': 7 * 864e5 };

  function parseRss(xml) {
    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('The news feed could not be read.');
    var out = [];
    doc.querySelectorAll('item').forEach(function (it) {
      function tx(sel) { var e = it.querySelector(sel); return e ? e.textContent.trim() : ''; }
      var title = tx('title');
      // Google News uses <source>; Bing News (the relay's fallback) uses <News:Source>.
      var bingSrc = it.getElementsByTagName('News:Source')[0];
      var src = tx('source') || (bingSrc ? bingSrc.textContent.trim() : '');
      if (src && title.slice(-(src.length + 3)) === ' - ' + src) title = title.slice(0, -(src.length + 3));
      var link = realLink(tx('link'));
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
      var cutoff = Date.now() - (WINDOW_MS[win] || WINDOW_MS['7d']) - 36e5;
      var items = parseRss(xml).filter(function (it) { return !it.ts || it.ts >= cutoff; }).slice(0, 20);
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
    savedUI();
    UI.buzz(10);
    UI.toast(isSaved(it.link) ? 'Saved for later' : 'Removed from saved');
    renderFeed();
  }
  function savedUI() {
    $('#savedCount').textContent = N.saved.length;
    var b = $('#bnSaved');
    if (b) { b.hidden = !N.saved.length; b.textContent = N.saved.length; }
  }
  async function share(it) {
    try {
      if (navigator.share) { await navigator.share({ title: it.title, text: it.title, url: it.link }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(it.link); UI.toast('Link copied'); }
    catch (e) { UI.toast('Could not copy the link'); }
  }

  function renderInterests() {
    var list = $('#interestList');
    list.replaceChildren.apply(list, N.interests.map(function (q, i) {
      return h('li', null, h('span', { class: 'chip', style: '--h:' + V.hueFor(q) }, q,
        i > 0 ? h('button', { type: 'button', 'aria-label': 'Move ' + q + ' up in priority', title: 'Higher priority', onclick: function () { moveInterest(i); } }, '↑') : null,
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
  function moveInterest(i) {
    if (i < 1 || i >= N.interests.length) return;
    var t = N.interests[i - 1]; N.interests[i - 1] = N.interests[i]; N.interests[i] = t;
    LS.set('nue.interests', N.interests);
    renderInterests();
    renderFeed();
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
      type: 'button', class: 'filter', style: val === 'all' ? null : '--h:' + V.hueFor(val), 'aria-pressed': String(N.filter === val),
      onclick: function () { N.filter = val; N.show = PAGE; renderFeed(); }
    }, val === 'all' ? null : h('span', { class: 'd' }), label, h('small', null, n));
  }

  function row(it, lead, i) {
    var hue = V.hueFor((it.tags || [])[0] || '');
    var tags = (it.tags || []).slice(0, 2).map(function (t) { return h('span', { class: 'tag' }, t); });
    var saved = isSaved(it.link);
    return h('li', { class: 'row' + (lead ? ' lead' : ''), style: '--h:' + hue + ';--i:' + Math.min(i || 0, 12) },
      h('div', { class: 'c-body' },
        tags.length ? h('div', { class: 'tags' }, tags) : null,
        h('a', { class: 'hl', href: it.link, target: '_blank', rel: 'noopener noreferrer' }, it.title),
        h('div', { class: 'meta' },
          it.source ? h('span', { class: 'src' }, it.source) : null,
          it.ts ? h('span', null, ago(it.ts)) : null)),
      h('div', { class: 'acts' },
        h('button', {
          type: 'button', class: 'act save', 'aria-pressed': String(saved), title: saved ? 'Remove from saved' : 'Save for later',
          'aria-label': (saved ? 'Remove from saved: ' : 'Save for later: ') + it.title,
          onclick: function () { toggleSave(it); }
        }, V.icon('bookmark', saved)),
        h('button', {
          type: 'button', class: 'act share', title: 'Share', 'aria-label': 'Share: ' + it.title,
          onclick: function () { share(it); }
        }, V.icon('share'))),
      h('div', { class: 'c-art' }, V.art(it.title, hue)));
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

    // Priority order: your first interest (India) leads, then the rest in the order you list them.
    var prio = N.view === 'feed' && N.sort === 'priority' && N.filter === 'all';
    function rankOf(it) {
      var r = 99;
      (it.tags || []).forEach(function (t) { var k = N.interests.indexOf(t); if (k >= 0 && k < r) r = k; });
      return r;
    }
    if (prio) {
      list = list.slice().sort(function (a, b) { return rankOf(a) - rankOf(b) || b.ts - a.ts; });
    }

    var kids = [];
    if (!list.length) {
      if (N.loading && N.view === 'feed') {
        for (var s = 0; s < 6; s++) kids.push(h('li', { class: 'row skeleton', 'aria-hidden': 'true' },
          h('div', { class: 'c-body' }, h('div', { class: 'skel', style: 'width:28%' }), h('div', { class: 'skel', style: 'width:96%;height:18px' }), h('div', { class: 'skel', style: 'width:68%;height:18px' }), h('div', { class: 'skel', style: 'width:40%' })),
          h('div', { class: 'c-art skel' })));
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
    function groupOf(it) { return prio ? (N.interests[rankOf(it)] || 'Other') : (it.ts ? dayLabel(it.ts) : 'Earlier'); }
    var counts = {};
    list.forEach(function (it) { var g = groupOf(it); counts[g] = (counts[g] || 0) + 1; });
    var lastDay = '';
    shown.forEach(function (it, i) {
      var d = groupOf(it);
      if (d !== lastDay) {
        kids.push(h('li', { class: 'day', role: 'presentation', style: prio ? '--h:' + V.hueFor(d) : null },
          prio ? h('span', { class: 'd' }) : null,
          h('span', { class: 'name' }, d),
          h('span', { class: 'n' }, counts[d]),
          prio && d === N.interests[0] ? h('span', { class: 'badge' }, 'Top priority') : null));
        lastDay = d;
      }
      kids.push(row(it, i === 0 && N.view === 'feed' && !N.q, i));
    });
    feed.replaceChildren.apply(feed, kids);
    $('#moreBtn').hidden = list.length <= N.show;
  }

  function greeting() {
    var hr = new Date().getHours();
    return hr < 5 ? 'Late night' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  }
  function renderHero() {
    var kick = $('#heroKicker'), title = $('#heroTitle'), sub = $('#heroSub');
    if (!title) return;
    var date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    title.replaceChildren(greeting(), h('span', { class: 'dot' }, '.'));
    if (currentTab === 'install') {
      kick.textContent = 'Install · Phone, tablet and desktop';
      sub.textContent = 'Add nue to your home screen in under a minute.';
      title.replaceChildren('Get the app', h('span', { class: 'dot' }, '.'));
    } else if (currentTab === 'stocks') {
      kick.textContent = date + ' · Markets';
      sub.textContent = (S.updated ? 'Prices updated ' + hhmm(S.updated) + '. ' : '') + 'Technical reads use price history only.';
    } else {
      var ed = { IN: 'India', US: 'United States', GB: 'United Kingdom', AU: 'Australia' }[N.region];
      var total = merged().length;
      kick.textContent = date + ' · ' + ed + ' edition';
      sub.textContent = N.loading && !total ? 'Gathering your stories…'
        : total + ' stories across ' + N.interests.length + ' topic' + (N.interests.length === 1 ? '' : 's') + (N.updated ? ' · updated ' + hhmm(N.updated) : '') + '.';
    }
  }

  function renderNewsStatus(total) {
    var el = $('#newsStatus');
    renderHero();
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
    $('#refreshBtn').classList.add('spinning');
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
    $('#refreshBtn').classList.remove('spinning');
    renderFeed();
  }

  function initNews() {
    if (N.started) return;
    N.started = true;
    $('#regionSel').value = N.region;
    $('#winSel').value = N.win;
    savedUI();
    $('#sortPri').setAttribute('aria-pressed', String(N.sort === 'priority'));
    $('#sortNew').setAttribute('aria-pressed', String(N.sort === 'newest'));
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
    updateNav();
  }
  function setSort(s) {
    N.sort = s; N.show = PAGE; LS.set('nue.sort', s);
    $('#sortPri').setAttribute('aria-pressed', String(s === 'priority'));
    $('#sortNew').setAttribute('aria-pressed', String(s === 'newest'));
    renderFeed();
  }
  $('#sortPri').addEventListener('click', function () { setSort('priority'); });
  $('#sortNew').addEventListener('click', function () { setSort('newest'); });
  $('#viewFeed').addEventListener('click', function () { setView('feed'); });
  $('#viewSaved').addEventListener('click', function () { setView('saved'); });

  /* ----------------------------------------------------------------- stocks */

  var DEFAULT_WATCH = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'AAPL'];
  var INDEXES = [['^NSEI', 'Nifty 50'], ['^BSESN', 'Sensex'], ['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq']];
  var TICKER = INDEXES.concat([['^NSEBANK', 'Bank Nifty'], ['INR=X', 'USD/INR']]);
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

  /* Name lookup. People type "Infosys" or "INFY", not "INFY.NS". Popular Indian names resolve
     from this list instantly (works offline); anything else goes to Yahoo's symbol search. */
  var KNOWN = [
    ['RELIANCE.NS', 'reliance industries ril'], ['TCS.NS', 'tata consultancy services'], ['HDFCBANK.NS', 'hdfc bank'],
    ['INFY.NS', 'infosys'], ['ICICIBANK.NS', 'icici bank'], ['SBIN.NS', 'state bank of india sbi'],
    ['BHARTIARTL.NS', 'bharti airtel airtel'], ['ITC.NS', 'itc'], ['LT.NS', 'larsen and toubro l&t'],
    ['KOTAKBANK.NS', 'kotak mahindra bank kotak'], ['HINDUNILVR.NS', 'hindustan unilever hul'], ['AXISBANK.NS', 'axis bank'],
    ['BAJFINANCE.NS', 'bajaj finance'], ['BAJAJFINSV.NS', 'bajaj finserv'], ['MARUTI.NS', 'maruti suzuki maruti'],
    ['SUNPHARMA.NS', 'sun pharma sun pharmaceutical'], ['TATASTEEL.NS', 'tata steel'], ['WIPRO.NS', 'wipro'],
    ['HCLTECH.NS', 'hcl technologies hcl tech'], ['ASIANPAINT.NS', 'asian paints'], ['NTPC.NS', 'ntpc'],
    ['POWERGRID.NS', 'power grid'], ['ONGC.NS', 'ongc oil and natural gas'], ['ULTRACEMCO.NS', 'ultratech cement ultratech'],
    ['TITAN.NS', 'titan'], ['M&M.NS', 'mahindra and mahindra mahindra m&m'], ['ADANIENT.NS', 'adani enterprises'],
    ['ADANIPORTS.NS', 'adani ports'], ['COALINDIA.NS', 'coal india'], ['JSWSTEEL.NS', 'jsw steel'],
    ['NESTLEIND.NS', 'nestle india nestle'], ['TECHM.NS', 'tech mahindra'], ['HINDALCO.NS', 'hindalco'],
    ['GRASIM.NS', 'grasim'], ['CIPLA.NS', 'cipla'], ['DRREDDY.NS', 'dr reddys dr reddy'],
    ['EICHERMOT.NS', 'eicher motors royal enfield'], ['BRITANNIA.NS', 'britannia'], ['APOLLOHOSP.NS', 'apollo hospitals'],
    ['HEROMOTOCO.NS', 'hero motocorp hero'], ['BPCL.NS', 'bpcl bharat petroleum'], ['INDUSINDBK.NS', 'indusind bank'],
    ['SBILIFE.NS', 'sbi life'], ['HDFCLIFE.NS', 'hdfc life'], ['TATACONSUM.NS', 'tata consumer'],
    ['ETERNAL.NS', 'eternal zomato'], ['IRCTC.NS', 'irctc'], ['LICI.NS', 'lic life insurance corporation'],
    ['DMART.NS', 'dmart avenue supermarts'], ['VEDL.NS', 'vedanta'], ['IOC.NS', 'ioc indian oil'],
    ['GAIL.NS', 'gail'], ['BANKBARODA.NS', 'bank of baroda'], ['PNB.NS', 'punjab national bank pnb'],
    ['YESBANK.NS', 'yes bank'], ['IDEA.NS', 'vodafone idea vi'], ['PAYTM.NS', 'paytm one97'],
    ['HAL.NS', 'hal hindustan aeronautics'], ['BEL.NS', 'bel bharat electronics'], ['TRENT.NS', 'trent'],
    ['IDFCFIRSTB.NS', 'idfc first bank'], ['TATAPOWER.NS', 'tata power'], ['SUZLON.NS', 'suzlon'],
    ['^NSEI', 'nifty nifty50 nifty 50'], ['^BSESN', 'sensex bse sensex'], ['^NSEBANK', 'bank nifty banknifty nifty bank']
  ];
  function words(t) { return String(t).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function lookupKnown(q) {
    var w = words(q);
    if (!w) return null;
    var squashed = w.replace(/ /g, '');
    var i, k;
    for (i = 0; i < KNOWN.length; i++) { // exact: ticker or a full name
      k = KNOWN[i];
      var base = words(k[0].replace(/\.NS$/, '')).replace(/ /g, '');
      if (squashed === base) return k[0];
    }
    for (i = 0; i < KNOWN.length; i++) {
      k = KNOWN[i];
      if (words(k[1]) === w || (' ' + words(k[1]) + ' ').indexOf(' ' + w + ' ') >= 0) return k[0];
    }
    if (w.length >= 3) { // typing the start of a name: "infos", "tata st"
      for (i = 0; i < KNOWN.length; i++) if (words(KNOWN[i][1]).indexOf(w) === 0) return KNOWN[i][0];
    }
    return null;
  }

  // Ask Yahoo's search for the best match. Indian listings win ties because nue is India-first.
  async function searchSymbol(q) {
    var url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) +
      '&quotesCount=10&newsCount=0&listsCount=0';
    var text = await viaProxy(url, function (t) { return t.trim().charAt(0) === '{'; });
    var list = (JSON.parse(text).quotes || []).filter(function (x) {
      return x.symbol && /^(EQUITY|ETF|INDEX|MUTUALFUND|CURRENCY|FUTURE)$/.test(x.quoteType || '');
    });
    if (!list.length) return null;
    var up = String(q).trim().toUpperCase();
    function rank(x) {
      var sym = x.symbol.toUpperCase(), r = 0;
      if (sym === up) r += 4;
      if (sym === up + '.NS') r += 3;
      if (sym === up + '.BO') r += 2;
      if (/\.NS$/.test(sym)) r += 1.5; else if (/\.BO$/.test(sym)) r += 1;
      return r;
    }
    var best = list[0];
    list.forEach(function (x) { if (rank(x) > rank(best)) best = x; });
    return { symbol: best.symbol.toUpperCase(), name: best.longname || best.shortname || best.symbol };
  }

  // Turn whatever the person typed into a symbol. Returns { sym, name } or null.
  async function resolveInput(raw) {
    var t = String(raw).trim();
    if (!t) return null;
    if (/[.:^=]/.test(t) && !/\s/.test(t)) { var n = normSym(t); return validSym(n) ? { sym: n } : null; }
    var known = lookupKnown(t);
    if (known) return { sym: known };
    try {
      var hit = await searchSymbol(t);
      return hit ? { sym: hit.symbol, name: hit.name } : null; // searched fine, nothing matches
    } catch (e) { /* search unreachable: fall through and try it as a code */ }
    var plain = normSym(t);
    return /^[A-Z0-9\-&]{1,15}$/.test(plain) ? { sym: plain, guess: true } : null;
  }

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
    var note = S.note ? S.note + ' ' : '';
    if (S.pending > 0) { el.textContent = note + 'Loading prices… ' + (S.watch.length - S.pending) + ' of ' + S.watch.length; return; }
    var kids = note ? [note] : [];
    if (S.updated) kids.push('Updated ' + hhmm(S.updated) + '. ');
    var bad = S.watch.filter(function (s) { return S.data[s] && S.data[s].err; });
    if (bad.length) kids.push(h('span', { class: 'err' }, bad.length + ' symbol' + (bad.length === 1 ? '' : 's') + ' could not load. '));
    kids.push(h('button', { type: 'button', onclick: function () { loadAll(true); loadIndexes(true); } }, 'Refresh prices'));
    el.append.apply(el, kids);
    if (currentTab === 'stocks') renderHero();
  }

  // previous-close logic shared by the strip and the table
  function quoteOf(bars, livePrice) {
    var c = bars.c;
    var lastC = c[c.length - 1];
    var price = livePrice != null && isFinite(livePrice) ? livePrice : lastC;
    var prev = Math.abs(lastC - price) / price < 1e-6 ? c[c.length - 2] : lastC;
    return { price: price, prev: prev, pct: prev ? price / prev - 1 : null, chg: price - prev };
  }

  function loadIndexes(force) {
    if (S.idxP && !force) return S.idxP;
    S.idxP = pool(TICKER, 4, async function (pair) {
      var sym = pair[0];
      try {
        var res = await fetchChart(sym, '1mo', force);
        S.idx[sym] = { q: quoteOf(res.bars, res.meta.price), cur: res.meta.currency, closes: res.bars.c };
      } catch (e) { S.idx[sym] = { err: true }; }
      renderMarket();
      renderTicker();
    });
    return S.idxP;
  }

  function sparkOf(closes, t, w, hgt) {
    var sv = V.spark(closes.slice(-22), { w: w, h: hgt, label: 'Last month' });
    sv.setAttribute('class', 'spark ' + t);
    return sv;
  }

  function renderMarket() {
    var box = $('#marketStrip');
    box.replaceChildren.apply(box, INDEXES.map(function (pair) {
      var d = S.idx[pair[0]];
      if (!d) return h('div', { class: 'idx' }, h('div', { class: 'nm' }, pair[1]), h('div', { class: 'skel', style: 'width:70%;height:24px;margin-top:8px' }), h('div', { class: 'skel', style: 'width:40%;margin-top:8px' }));
      if (d.err) return h('div', { class: 'idx' }, h('div', { class: 'nm' }, pair[1]), h('div', { class: 'val flat' }, '–'), h('div', { class: 'chg flat' }, 'Unavailable'));
      var t = tone(d.q.pct);
      return h('div', { class: 'idx ' + t },
        h('div', { class: 'nm' }, pair[1]),
        h('div', { class: 'val' }, fmtNum(d.q.price, d.cur)),
        h('div', { class: 'chg ' + t }, fmtPct(d.q.pct) + '  (' + (d.q.chg >= 0 ? '+' : '−') + fmtNum(Math.abs(d.q.chg), d.cur) + ')'),
        sparkOf(d.closes, t, 72, 34));
    }));
  }

  function renderTicker() {
    var track = $('#tickerTrack');
    if (!track) return;
    var have = TICKER.filter(function (p) { return S.idx[p[0]] && !S.idx[p[0]].err; });
    if (!have.length) {
      var settled = TICKER.every(function (p) { return S.idx[p[0]]; });
      track.style.animation = 'none';
      track.replaceChildren(h('span', { class: 'tk-empty' }, settled ? 'Market snapshot unavailable right now.' : 'Loading markets…'));
      return;
    }
    track.style.animation = '';
    function set(hidden) {
      return have.map(function (p) {
        var d = S.idx[p[0]], t = tone(d.q.pct);
        var el = h('span', { class: 'tk' }, h('span', { class: 'tk-name' }, p[1]), h('span', { class: 'tk-val' }, fmtNum(d.q.price, d.cur)),
          h('span', { class: 'tk-chg ' + t }, (t === 'up' ? '▲ ' : t === 'down' ? '▼ ' : '') + fmtPct(d.q.pct)));
        if (hidden) el.setAttribute('aria-hidden', 'true');
        return el;
      });
    }
    track.replaceChildren.apply(track, set(false).concat(set(true), set(true), set(true)));
  }

  function renderTable() {
    var body = $('#watchBody');
    if (!S.watch.length) {
      body.replaceChildren(h('tr', null, h('td', { colspan: '8', class: 'empty' }, 'Your watchlist is empty. Add a symbol above to start.')));
      return;
    }
    body.replaceChildren.apply(body, S.watch.map(function (sym) {
      var d = S.data[sym];
      var selected = S.sel === sym;
      var tr = h('tr', { 'aria-selected': String(selected), onclick: function () { select(sym); } });
      tr.append(h('td', { class: 'c-sym' },
        h('button', { type: 'button', class: 'sym', onclick: function (e) { e.stopPropagation(); select(sym); } }, sym),
        d && d.meta ? h('span', { class: 'sym-name' }, d.meta.name) : null));
      if (!d || d.loading) {
        ['c-price', 'c-d1', 'c-m1', 'c-rsi', 'c-spark', 'c-read'].forEach(function (c, i) {
          tr.append(h('td', { class: c, 'aria-hidden': 'true' }, h('div', { class: 'skel', style: 'width:' + (i === 5 ? 90 : 56) + 'px' })));
        });
      } else if (d.err) {
        tr.append(h('td', { colspan: '6', class: 'c-wide' }, h('span', { class: 'row-err' }, d.err + ' '), h('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:2px 8px;font-size:12px', onclick: function (e) { e.stopPropagation(); loadSymbol(sym, true); } }, 'Retry')));
      } else {
        var a = d.a, isIdx = d.meta.type === 'INDEX';
        tr.append(
          h('td', { class: 'num c-price' }, fmtPrice(a.price, d.meta.currency, isIdx)),
          h('td', { class: 'num c-d1 ' + tone(a.chgPct) }, fmtPct(a.chgPct)),
          h('td', { class: 'num c-m1 ' + tone(a.ret.m1), 'data-l': '1 MONTH' }, fmtPct(a.ret.m1, 1)),
          h('td', { class: 'num c-rsi', 'data-l': 'RSI' }, a.rsi == null ? '–' : a.rsi.toFixed(0)),
          h('td', { class: 'c-spark' }, sparkOf(d.bars.c, a.tone, 96, 30)),
          h('td', { class: 'c-read' }, h('span', { class: 'pill ' + a.tone }, a.label)));
      }
      tr.append(h('td', { class: 'c-x' }, h('button', { type: 'button', class: 'x', 'aria-label': 'Remove ' + sym, onclick: function (e) { e.stopPropagation(); removeSymbol(sym); } }, '×')));
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

  var addBusy = false;
  $('#symForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (addBusy) return;
    var inp = $('#symInput'), status = $('#stockStatus');
    var parts = inp.value.split(/[,;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!parts.length) return;
    addBusy = true;
    status.textContent = 'Looking up ' + (parts.length > 1 ? parts.length + ' stocks' : parts[0]) + '…';
    var added = [], bad = [], dup = [], notes = [], full = false;
    for (var i = 0; i < parts.length; i++) {
      var r = await resolveInput(parts[i]);
      if (!r) { bad.push(parts[i]); continue; }
      if (S.watch.indexOf(r.sym) >= 0 || added.indexOf(r.sym) >= 0) { dup.push(r.sym); continue; }
      if (S.watch.length + added.length >= MAX_WATCH) { full = true; break; }
      added.push(r.sym);
      if (r.name && words(parts[i]) !== words(r.sym)) notes.push(r.name + ' (' + r.sym + ')');
    }
    addBusy = false;
    inp.value = '';
    var msg = [];
    if (added.length) msg.push('Added ' + (notes.length ? notes.join(', ') : added.join(', ')) + '.');
    if (dup.length) msg.push(dup.join(', ') + ' already in your list.');
    if (bad.length) msg.push('Could not find: ' + bad.join(', ') + '. Try the company name or its NSE code.');
    if (full) msg.push('Watchlist is full (' + MAX_WATCH + ').');
    S.note = msg.join(' ');
    clearTimeout(S.noteT); S.noteT = setTimeout(function () { S.note = ''; renderStockStatus(); }, 12000);
    if (!added.length) { renderStockStatus(); return; }
    S.watch = S.watch.concat(added);
    LS.set('nue.watch', S.watch);
    S.sel = added[0];
    renderTable();
    added.forEach(function (sym) { loadSymbol(sym, false); });
    renderStockStatus();
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

    var factors = h('ul', { class: 'factors' }, a.factors.map(function (f) {
      var t = f.score > 0 ? 'up' : f.score < 0 ? 'down' : 'flat';
      return h('li', null,
        h('span', { class: 'f-tag ' + t }, f.score > 0 ? 'Bullish' : f.score < 0 ? 'Bearish' : 'Neutral'),
        h('span', null, h('span', { class: 'f-name' }, f.name), h('span', { class: 'f-txt' }, f.text)));
    }));

    var read = h('div', { class: 'read' },
      h('div', { class: 'verdict-box' }, h('h3', null, 'Technical read'), V.gauge(a.norm), h('div', { class: 'verdict ' + a.tone }, a.label),
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
    renderTicker();
    loadIndexes(false);
    loadAll(false);
  }

  /* ------------------------------------------------------------- tabs, boot */

  var TABS = ['news', 'stocks', 'install'];
  function showTab(name, focus) {
    if (TABS.indexOf(name) < 0) name = 'news';
    currentTab = name;
    closeSheet();
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
    if (name === 'news') initNews(); else if (name === 'stocks') initStocks();
    renderHero();
    updateNav();
  }

  /* topics sheet (phones) and bottom navigation */
  function openSheet() {
    $('#side').classList.add('open');
    $('#scrim').classList.add('on');
    updateNav();
  }
  function closeSheet() {
    var side = $('#side');
    if (!side.classList.contains('open')) return;
    side.classList.remove('open');
    $('#scrim').classList.remove('on');
    updateNav();
  }
  function updateNav() {
    var sheetOpen = $('#side').classList.contains('open');
    var cur = sheetOpen ? 'topics' : currentTab === 'install' ? '' : currentTab === 'stocks' ? 'stocks' : N.view === 'saved' ? 'saved' : 'news';
    document.querySelectorAll('.bn').forEach(function (b) {
      if (b.getAttribute('data-go') === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function toTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  document.querySelectorAll('.bn').forEach(function (b) {
    b.addEventListener('click', function () {
      var go = b.getAttribute('data-go');
      UI.buzz(8);
      if (go === 'topics') { showTab('news'); openSheet(); return; }
      if (go === 'saved') { showTab('news'); setView('saved'); toTop(); return; }
      if (go === 'stocks') { showTab('stocks'); toTop(); return; }
      showTab('news'); setView('feed'); toTop();
    });
  });
  $('#topicsBtn').addEventListener('click', openSheet);
  $('#sideClose').addEventListener('click', closeSheet);
  $('#scrim').addEventListener('click', function () {
    closeSheet();
    var ios = $('#iosSheet');
    if (ios) ios.hidden = true;
    $('#scrim').classList.remove('on');
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  window.addEventListener('resize', function () { if (window.innerWidth >= 980) closeSheet(); });
  UI.setPull(function () {
    return currentTab === 'stocks' ? Promise.all([loadAll(true), loadIndexes(true)]) : refreshNews(true);
  });
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

  pruneCache();
  var start = location.hash.replace('#', '');
  showTab(TABS.indexOf(start) >= 0 ? start : LS.get('nue.tab', 'news'));
  renderTicker();
  loadIndexes(false); // the ticker under the masthead is visible on both tabs
})();
