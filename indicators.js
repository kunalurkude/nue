/* nue: technical indicators and the "technical read" for a price series.
   Pure functions, no DOM. Works in the browser (window.NueIndicators) and in Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NueIndicators = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sma(a, n) {
    const out = new Array(a.length).fill(null);
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i];
      if (i >= n) sum -= a[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(a, n) {
    const out = new Array(a.length).fill(null);
    if (a.length < n) return out;
    const k = 2 / (n + 1);
    let prev = 0;
    for (let i = 0; i < n; i++) prev += a[i];
    prev /= n;
    out[n - 1] = prev;
    for (let i = n; i < a.length; i++) {
      prev = a[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder's RSI
  function rsi(a, n) {
    n = n || 14;
    const out = new Array(a.length).fill(null);
    if (a.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) {
      const d = a[i] - a[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function macd(a, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    const ef = ema(a, fast), es = ema(a, slow);
    const line = a.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const signal = new Array(a.length).fill(null);
    const first = line.findIndex(v => v != null);
    if (first >= 0) {
      const part = line.slice(first);
      const e = ema(part, sig);
      for (let i = 0; i < part.length; i++) signal[first + i] = e[i];
    }
    const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
    return { line, signal, hist };
  }

  function last(a) { return a.length ? a[a.length - 1] : null; }

  // Annualised volatility from daily log returns over the last `n` bars.
  function volatility(c, n) {
    n = n || 252;
    const s = c.slice(-(n + 1));
    if (s.length < 20) return null;
    const r = [];
    for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / s[i - 1]));
    const m = r.reduce((x, y) => x + y, 0) / r.length;
    const v = r.reduce((x, y) => x + (y - m) * (y - m), 0) / (r.length - 1);
    return Math.sqrt(v) * Math.sqrt(252);
  }

  function maxDrawdown(c) {
    let peak = -Infinity, mdd = 0;
    for (const v of c) {
      if (v > peak) peak = v;
      const dd = v / peak - 1;
      if (dd < mdd) mdd = dd;
    }
    return mdd;
  }

  function retBack(c, k) {
    if (c.length <= k) return null;
    return c[c.length - 1] / c[c.length - 1 - k] - 1;
  }

  /* bars: { t:[ms], o:[], h:[], l:[], c:[], v:[] } cleaned of nulls.
     livePrice: optional latest price (otherwise the last close). */
  function analyze(bars, livePrice) {
    const c = bars.c;
    if (!c || c.length < 30) throw new Error('Not enough price history to analyse (need at least 30 days).');
    const lastClose = last(c);
    const price = livePrice != null && isFinite(livePrice) ? livePrice : lastClose;
    // If the last bar already is the live price, the previous close is the bar before it.
    const prev = Math.abs(lastClose - price) / price < 1e-6 ? c[c.length - 2] : lastClose;

    const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200);
    const r14 = rsi(c, 14);
    const m = macd(c);

    const hiBars = bars.h && bars.h.length === c.length ? bars.h : c;
    const loBars = bars.l && bars.l.length === c.length ? bars.l : c;
    const year = Math.min(c.length, 252);
    const hi52 = Math.max.apply(null, hiBars.slice(-year));
    const lo52 = Math.min.apply(null, loBars.slice(-year));
    const pos52 = hi52 > lo52 ? (price - lo52) / (hi52 - lo52) : 0.5;

    const w = Math.min(20, c.length);
    const support = Math.min.apply(null, loBars.slice(-w));
    const resistance = Math.max.apply(null, hiBars.slice(-w));

    const a = {
      price: price,
      prev: prev,
      chg: price - prev,
      chgPct: price / prev - 1,
      ret: {
        m1: retBack(c, 21),
        m3: retBack(c, 63),
        m6: retBack(c, 126),
        y1: c.length >= 240 ? retBack(c, Math.min(252, c.length - 1)) : null
      },
      hi52: hi52, lo52: lo52, pos52: pos52,
      support: support, resistance: resistance,
      sma20: last(s20), sma50: last(s50), sma200: last(s200),
      rsi: last(r14),
      macd: { line: last(m.line), signal: last(m.signal), hist: last(m.hist) },
      vol: volatility(c, 252),
      mdd: maxDrawdown(c.slice(-252)),
      series: { sma50: s50, sma200: s200 },
      factors: [], score: 0, label: 'Neutral', tone: 'flat'
    };

    const f = a.factors;
    function add(name, score, text) { f.push({ name: name, score: score, text: text }); }

    if (a.sma200 != null) {
      add('Long-term trend', price > a.sma200 ? 1 : -1,
        price > a.sma200 ? 'Price is above its 200-day average.' : 'Price is below its 200-day average.');
    }
    if (a.sma50 != null) {
      add('Medium-term trend', price > a.sma50 ? 1 : -1,
        price > a.sma50 ? 'Price is above its 50-day average.' : 'Price is below its 50-day average.');
    }
    if (a.sma50 != null && a.sma200 != null) {
      add('Average crossover', a.sma50 > a.sma200 ? 1 : -1,
        a.sma50 > a.sma200 ? 'The 50-day average sits above the 200-day (bullish structure).' : 'The 50-day average sits below the 200-day (bearish structure).');
    }
    if (a.rsi != null) {
      const r = a.rsi;
      let sc, tx;
      if (r >= 70) { sc = 0; tx = 'RSI ' + r.toFixed(0) + ': overbought. Momentum is strong but stretched.'; }
      else if (r >= 55) { sc = 1; tx = 'RSI ' + r.toFixed(0) + ': healthy upward momentum.'; }
      else if (r >= 45) { sc = 0; tx = 'RSI ' + r.toFixed(0) + ': neutral momentum.'; }
      else if (r >= 30) { sc = -1; tx = 'RSI ' + r.toFixed(0) + ': weak momentum.'; }
      else { sc = 0; tx = 'RSI ' + r.toFixed(0) + ': oversold. A bounce is possible, but the trend is weak.'; }
      add('Momentum (RSI)', sc, tx);
    }
    if (a.macd.line != null && a.macd.signal != null) {
      const up = a.macd.line > a.macd.signal;
      add('MACD', up ? 1 : -1, up ? 'MACD is above its signal line.' : 'MACD is below its signal line.');
    }
    if (a.ret.m3 != null) {
      const r3 = a.ret.m3;
      const sc = r3 >= 0.05 ? 1 : r3 <= -0.05 ? -1 : 0;
      add('3-month move', sc, 'Price changed ' + (r3 * 100).toFixed(1) + '% over about three months.');
    }
    {
      const sc = a.pos52 >= 0.8 ? 1 : a.pos52 <= 0.2 ? -1 : 0;
      add('52-week position', sc, 'Price sits at ' + Math.round(a.pos52 * 100) + '% of its 52-week range.');
    }

    const total = f.reduce((x, y) => x + y.score, 0);
    const norm = f.length ? total / f.length : 0;
    a.score = total;
    a.norm = norm;
    if (norm >= 0.55) { a.label = 'Bullish'; a.tone = 'up'; }
    else if (norm >= 0.25) { a.label = 'Leaning bullish'; a.tone = 'up'; }
    else if (norm > -0.25) { a.label = 'Neutral'; a.tone = 'flat'; }
    else if (norm > -0.55) { a.label = 'Leaning bearish'; a.tone = 'down'; }
    else { a.label = 'Bearish'; a.tone = 'down'; }
    return a;
  }

  return { sma: sma, ema: ema, rsi: rsi, macd: macd, volatility: volatility, maxDrawdown: maxDrawdown, analyze: analyze };
});
