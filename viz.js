/* nue: small visual helpers. Everything is drawn as SVG from data, so there are no image files
   to load. Story art is generated from the headline, so the same story always looks the same. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NueViz = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] != null) e.setAttribute(k, attrs[k]); });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.appendChild(arguments[i]);
    return e;
  }

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* A stable colour (hue, 0-359) for each topic. Well-known topics get hand-picked hues. */
  var KNOWN = { 'india': 22, 'technology': 238, 'artificial intelligence': 280, 'stock market': 152, 'cricket': 188,
    'business': 205, 'startups': 330, 'science': 170, 'space': 255, 'health': 350, 'climate': 130, 'politics': 8,
    'world': 215, 'football': 100, 'movies': 305, 'indian economy': 40 };
  function hueFor(name) {
    var k = String(name || '').toLowerCase().trim();
    return KNOWN[k] != null ? KNOWN[k] : hash(k) % 360;
  }

  /* Abstract poster art for a story: a graded background with circles, rings and bands. */
  function art(seed, hue) {
    var r = rng(hash(String(seed)));
    var id = 'nueg' + (++uid);
    var h2 = (hue + 28 + Math.floor(r() * 30)) % 360;
    var svg = el('svg', { viewBox: '0 0 120 120', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', focusable: 'false' });
    var defs = el('defs', null,
      el('linearGradient', { id: id, x1: '0', y1: '0', x2: '1', y2: '1' },
        el('stop', { offset: '0', 'stop-color': 'hsl(' + hue + ' 62% 17%)' }),
        el('stop', { offset: '1', 'stop-color': 'hsl(' + h2 + ' 72% 36%)' })));
    svg.appendChild(defs);
    svg.appendChild(el('rect', { width: '120', height: '120', fill: 'url(#' + id + ')' }));
    var n = 4 + Math.floor(r() * 3);
    for (var i = 0; i < n; i++) {
      var kind = Math.floor(r() * 4);
      var cx = Math.round(r() * 120), cy = Math.round(r() * 120), s = 14 + Math.round(r() * 38);
      var hh = (hue + Math.floor(r() * 70) - 15 + 360) % 360;
      if (kind === 0) {
        svg.appendChild(el('circle', { cx: cx, cy: cy, r: s, fill: 'hsl(' + hh + ' 88% ' + (52 + Math.floor(r() * 18)) + '%)', 'fill-opacity': (0.55 + r() * 0.35).toFixed(2) }));
      } else if (kind === 1) {
        svg.appendChild(el('circle', { cx: cx, cy: cy, r: s, fill: 'none', stroke: 'hsl(' + hh + ' 90% 74%)', 'stroke-width': (3 + Math.round(r() * 5)), 'stroke-opacity': '0.7' }));
      } else if (kind === 2) {
        svg.appendChild(el('rect', { x: cx - s, y: cy - 6, width: s * 2.4, height: 12 + Math.round(r() * 10), rx: '6', fill: 'hsl(' + hh + ' 92% 70%)', 'fill-opacity': '0.5', transform: 'rotate(' + (Math.floor(r() * 180) - 90) + ' ' + cx + ' ' + cy + ')' }));
      } else {
        svg.appendChild(el('path', { d: 'M' + cx + ' ' + (cy + s) + ' A' + s + ' ' + s + ' 0 0 1 ' + (cx + s * 1.6) + ' ' + (cy + s) + ' Z', fill: 'hsl(' + hh + ' 90% 66%)', 'fill-opacity': '0.65' }));
      }
    }
    return svg;
  }

  /* Tiny trend line. values: numbers, oldest first. Colour comes from CSS (currentColor). */
  function spark(values, opts) {
    opts = opts || {};
    var w = opts.w || 84, h = opts.h || 28, pad = 2;
    var v = values.filter(function (x) { return x != null && isFinite(x); });
    var svg = el('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, class: 'spark', role: 'img', 'aria-label': opts.label || 'Price trend' });
    if (v.length < 2) return svg;
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    var span = hi - lo || 1;
    var pts = v.map(function (y, i) {
      return [pad + (i / (v.length - 1)) * (w - pad * 2), pad + (1 - (y - lo) / span) * (h - pad * 2)];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
    var id = 'nues' + (++uid);
    svg.appendChild(el('defs', null,
      el('linearGradient', { id: id, x1: '0', y1: '0', x2: '0', y2: '1' },
        el('stop', { offset: '0', 'stop-color': 'currentColor', 'stop-opacity': '0.28' }),
        el('stop', { offset: '1', 'stop-color': 'currentColor', 'stop-opacity': '0' }))));
    svg.appendChild(el('path', { d: line + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + h + 'L' + pts[0][0].toFixed(1) + ' ' + h + 'Z', fill: 'url(#' + id + ')' }));
    svg.appendChild(el('path', { d: line, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    var last = pts[pts.length - 1];
    svg.appendChild(el('circle', { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: '2.2', fill: 'currentColor' }));
    return svg;
  }

  /* Half-circle gauge. norm runs from -1 (bearish) to +1 (bullish). */
  function arcPath(cx, cy, r, a0, a1) {
    function pt(a) { return (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy - r * Math.sin(a)).toFixed(2); }
    return 'M' + pt(a0) + ' A' + r + ' ' + r + ' 0 0 1 ' + pt(a1);
  }
  function gauge(norm) {
    norm = Math.max(-1, Math.min(1, norm || 0));
    var cx = 100, cy = 100, r = 78;
    var svg = el('svg', { viewBox: '0 0 200 118', class: 'gauge', role: 'img', 'aria-label': 'Signal strength gauge' });
    var colours = ['var(--down)', 'var(--down-soft)', 'var(--ink-3)', 'var(--up-soft)', 'var(--up)'];
    for (var i = 0; i < 5; i++) {
      var a0 = Math.PI - (i * Math.PI) / 5 - 0.035, a1 = Math.PI - ((i + 1) * Math.PI) / 5 + 0.035;
      svg.appendChild(el('path', { d: arcPath(cx, cy, r, a0, a1), fill: 'none', style: 'stroke:' + colours[i], 'stroke-width': '14', 'stroke-linecap': 'round' }));
    }
    var ang = Math.PI * (1 - (norm + 1) / 2);
    var x = cx + (r - 30) * Math.cos(ang), y = cy - (r - 30) * Math.sin(ang);
    svg.appendChild(el('line', { x1: cx, y1: cy, x2: x.toFixed(2), y2: y.toFixed(2), style: 'stroke:var(--ink)', 'stroke-width': '4', 'stroke-linecap': 'round' }));
    svg.appendChild(el('circle', { cx: cx, cy: cy, r: '8', style: 'fill:var(--ink)' }));
    svg.appendChild(el('circle', { cx: cx, cy: cy, r: '3', style: 'fill:var(--surface)' }));
    return svg;
  }

  var ICONS = {
    news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2V5z"/><path d="M17 8h3v9a2 2 0 0 1-2 2"/><path d="M7 9h7M7 12h7M7 15h4"/>',
    chart: '<path d="M3 17l5-6 4 3 8-9"/><path d="M15 5h5v5"/>',
    bookmark: '<path d="M7 4h10v16.5l-5-3.6-5 3.6z"/>',
    share: '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v6a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-6"/>',
    topics: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.4 5.8"/><path d="M20 4.5V11h-6.5"/>',
    install: '<path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M5 20h14"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    wifi: '<path d="M3 3l18 18"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 3.2-2.1M19 12.9a10 10 0 0 0-5.7-2.8"/><circle cx="12" cy="19" r="1"/>'
  };
  function icon(name, filled) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '20'); s.setAttribute('height', '20');
    s.setAttribute('fill', filled ? 'currentColor' : 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.innerHTML = ICONS[name] || '';
    return s;
  }

  return { art: art, spark: spark, gauge: gauge, icon: icon, hueFor: hueFor, hash: hash };
});
