// Run with: node test/indicators.test.js
const assert = require('assert');
const I = require('../indicators.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// SMA
assert.deepStrictEqual(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);

// EMA seeds with the SMA of the first n values
const e = I.ema([1, 2, 3, 4, 5], 3);
assert.strictEqual(e[1], null);
near(e[2], 2, 1e-12, 'ema seed');
near(e[3], 3, 1e-12, 'ema step');

// RSI: strictly rising series is 100, strictly falling is 0
const up = Array.from({ length: 60 }, (_, i) => 100 + i);
const down = up.slice().reverse();
near(I.rsi(up, 14).pop(), 100, 1e-9, 'rsi up');
near(I.rsi(down, 14).pop(), 0, 1e-9, 'rsi down');

// RSI: textbook example (Wilder / StockCharts sample), first RSI value ~ 70.53
const sample = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
near(I.rsi(sample, 14)[14], 70.53, 0.1, 'rsi textbook');

// MACD: rising series gives MACD above zero
const m = I.macd(up);
assert.ok(m.line[m.line.length - 1] > 0, 'macd positive on uptrend');

// Max drawdown
near(I.maxDrawdown([100, 120, 90, 110]), -0.25, 1e-12, 'mdd');

// analyze(): uptrend should read bullish, downtrend bearish
function bars(closes) {
  return { t: closes.map((_, i) => i * 864e5), o: closes, h: closes.map(x => x * 1.01), l: closes.map(x => x * 0.99), c: closes, v: closes.map(() => 1e6) };
}
const wavy = (i, base, slope) => base + slope * i + Math.sin(i / 3) * 2;
const upBars = bars(Array.from({ length: 260 }, (_, i) => wavy(i, 100, 0.5)));
const dnBars = bars(Array.from({ length: 260 }, (_, i) => wavy(i, 300, -0.5)));
const a1 = I.analyze(upBars);
const a2 = I.analyze(dnBars);
assert.ok(['Bullish', 'Leaning bullish'].includes(a1.label), 'uptrend label ' + a1.label);
assert.ok(['Bearish', 'Leaning bearish'].includes(a2.label), 'downtrend label ' + a2.label);
assert.ok(a1.pos52 > 0.8 && a2.pos52 < 0.2, '52w position');
assert.ok(a1.vol > 0 && a1.mdd <= 0, 'vol / drawdown');

// Short history: no 200-day factors, still works
const short = I.analyze(bars(Array.from({ length: 80 }, (_, i) => wavy(i, 50, 0.3))));
assert.ok(short.factors.every(f => !/Long-term|crossover/.test(f.name)), 'short history skips 200d factors');

// Live price different from last close: previous close is the last bar
const live = I.analyze(upBars, upBars.c[259] * 1.02);
near(live.prev, upBars.c[259], 1e-9, 'prev with live price');
near(live.chgPct, 0.02, 1e-9, 'change pct with live price');

// Too little data throws
assert.throws(() => I.analyze(bars([1, 2, 3])), /Not enough/);

console.log('indicators: all tests passed');
