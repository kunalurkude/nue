# nue

A daily news wire built around your interests, with a stock watchlist and technical analysis in the same app.

No build step, no backend, no accounts. It is three static files, so it runs on GitHub Pages.

## What it does

**News**
- Follow any topics you like (up to 12). Add your own or tap a suggestion.
- Stories are merged into one feed, newest first, grouped by day, with duplicates across topics collapsed.
- Pick an edition (India, United States, United Kingdom, Australia) and a time window (24 hours, 3 days, 7 days).
- Filter by interest, search headlines, and save stories for later.

**Stocks**
- Market strip for Nifty 50, Sensex, S&P 500 and Nasdaq.
- A watchlist of up to 15 symbols. NSE stocks end in `.NS`, BSE in `.BO`, US tickers need no suffix, indices start with `^`. `NSE:INFY` and `BSE:INFY` are accepted too.
- Per symbol: price chart (3M, 6M, 1Y) with 50 and 200 day averages, returns, 52-week range, RSI(14), MACD, support and resistance, volatility, worst drawdown.
- A **technical read** (Bullish, Leaning bullish, Neutral, Leaning bearish, Bearish) with every signal that went into it listed in plain words.
- Recent headlines for the selected company.

The technical read looks at price history only. It ignores earnings, valuation and news, and it is not investment advice.

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works. Opening `index.html` straight from disk also works in most browsers.

## Deploy

Push to GitHub and turn on Pages (Settings, Pages, deploy from the `main` branch, root folder).

## Where the data comes from

- Headlines: Google News RSS search feeds.
- Prices: Yahoo Finance chart data, daily bars, usually delayed.

Neither source allows direct browser requests, so `app.js` fetches them through public CORS proxies (allorigins, corsproxy.io, codetabs) and falls back from one to the next. This is free and needs no keys, but it is the weak point: a proxy can be slow, rate limited, or blocked on some networks. Fetched data is cached in your browser for 10 to 20 minutes, and older stories are shown if a refresh fails.

For something sturdier, replace `viaProxy` in `app.js` with a small server or serverless function of your own that fetches the same URLs.

## Privacy

Interests, saved stories, watchlist and theme are stored in your browser's `localStorage`. Nothing is sent to any server of mine, because there is none. The proxies and data sources do see the requests your browser makes.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Design tokens, light and dark themes, layout |
| `app.js` | News and stocks UI, data fetching, chart drawing |
| `indicators.js` | SMA, EMA, RSI, MACD, volatility, drawdown and the technical read |
| `test/indicators.test.js` | Tests for the indicator maths (`node test/indicators.test.js`) |
