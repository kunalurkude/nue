// nue relay: a tiny Cloudflare Worker that fetches Google News and Yahoo Finance data
// for the nue web app. Browsers cannot fetch those sites directly, so the app asks this
// Worker instead. It only fetches Google News search feeds (with Bing News, then Yahoo News, as
// fallbacks when Google refuses), Yahoo Finance chart data and Yahoo symbol search, and only answers nue's own site.
//
// Usage: GET https://<your-worker>.workers.dev/?url=<encoded source url>

const ALLOWED_ORIGINS = [
  'https://kunalurkude.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

function allowedSource(u) {
  if (u.protocol !== 'https:') return false;
  if (u.hostname === 'news.google.com') return u.pathname === '/rss/search';
  if (u.hostname === 'query1.finance.yahoo.com' || u.hostname === 'query2.finance.yahoo.com') {
    return u.pathname.startsWith('/v8/finance/chart/') || u.pathname === '/v1/finance/search';
  }
  return false;
}

// Fetch one URL. For news feeds, a 200 that is not RSS (a block page) counts as a failure.
async function getFrom(url, expectRss) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; nue-relay/1.0)',
        'Accept': 'application/rss+xml, application/xml, application/json, */*'
      }
    });
    const type = r.headers.get('Content-Type') || 'text/plain';
    const body = await r.text();
    const ok = r.ok && (!expectRss || /<rss[\s>]/.test(body));
    return {
      ok: ok, status: r.ok && !ok ? 503 : r.status, type: type, body: body, from: new URL(url).hostname,
      note: ok ? 'ok' : r.status + ' ' + body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
    };
  } catch (e) {
    return { ok: false, error: true, status: 502, type: 'text/plain', body: '', from: new URL(url).hostname, note: 'network error' };
  }
}

// Other news searches that match a Google News RSS search, tried in this order if Google refuses.
function newsFallbacks(g) {
  const q = (g.searchParams.get('q') || '').replace(/\s+when:\w+\s*$/i, '').trim();
  if (!q) return [];
  const mkt = g.searchParams.get('hl') || 'en-US';
  return [
    'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss&setmkt=' + encodeURIComponent(mkt),
    'https://news.search.yahoo.com/rss?p=' + encodeURIComponent(q)
  ];
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const originOk = !origin || ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': origin && originOk ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Expose-Headers': 'X-Nue-Source',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!originOk) return new Response('Origin not allowed', { status: 403, headers: cors });

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) return new Response('nue relay is running (v3). Pass ?url=<encoded source url>.', { status: 200, headers: cors });

    let target;
    try { target = new URL(raw); } catch (e) { return new Response('Bad url', { status: 400, headers: cors }); }
    if (!allowedSource(target)) return new Response('Source not allowed', { status: 403, headers: cors });

    // Keep results for 10 minutes so repeat requests do not hit the sources again.
    const cache = caches.default;
    const cacheKey = new Request(target.toString(), { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (!res) {
      const isNews = target.hostname === 'news.google.com';
      let got = await getFrom(target.toString(), isNews);
      const tried = [got];
      // Google News often refuses requests from shared cloud addresses ("automated queries").
      // When that happens, ask other news searches for the same topic instead.
      if (!got.ok && isNews) {
        for (const alt of newsFallbacks(target)) {
          const b = await getFrom(alt, true);
          tried.push(b);
          if (b.ok) { got = b; break; }
        }
      }
      if (!got.ok && isNews) {
        // Plain-text report of what each source answered, so a failure can be diagnosed.
        const report = 'nue relay: every news source refused this search.\n' + tried.map(t => '- ' + t.from + ': ' + t.note).join('\n');
        return new Response(report, { status: 503, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      if (got.error) return new Response('Could not reach the source', { status: 502, headers: cors });
      res = new Response(got.body, {
        status: got.ok ? 200 : got.status,
        headers: {
          'Content-Type': got.type,
          'Cache-Control': got.ok ? 'public, max-age=600' : 'no-store',
          'X-Nue-Source': got.from || 'origin'
        }
      });
      if (got.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    Object.keys(cors).forEach(k => out.headers.set(k, cors[k]));
    return out;
  }
};
