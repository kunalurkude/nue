// nue relay: a tiny Cloudflare Worker that fetches Google News and Yahoo Finance data
// for the nue web app. Browsers cannot fetch those sites directly, so the app asks this
// Worker instead. It only fetches the two allowed sources and only answers nue's own site.
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
    return u.pathname.startsWith('/v8/finance/chart/');
  }
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const originOk = !origin || ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': origin && originOk ? origin : ALLOWED_ORIGINS[0],
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!originOk) return new Response('Origin not allowed', { status: 403, headers: cors });

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) return new Response('nue relay is running. Pass ?url=<encoded source url>.', { status: 200, headers: cors });

    let target;
    try { target = new URL(raw); } catch (e) { return new Response('Bad url', { status: 400, headers: cors }); }
    if (!allowedSource(target)) return new Response('Source not allowed', { status: 403, headers: cors });

    // Keep results for 10 minutes so repeat requests do not hit the sources again.
    const cache = caches.default;
    const cacheKey = new Request(target.toString(), { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (!res) {
      let upstream;
      try {
        upstream = await fetch(target.toString(), {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; nue-relay/1.0)',
            'Accept': 'application/rss+xml, application/xml, application/json, */*'
          },
          cf: { cacheTtl: 600, cacheEverything: true }
        });
      } catch (e) {
        return new Response('Could not reach the source', { status: 502, headers: cors });
      }
      res = new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'text/plain',
          'Cache-Control': upstream.ok ? 'public, max-age=600' : 'no-store'
        }
      });
      if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    Object.keys(cors).forEach(k => out.headers.set(k, cors[k]));
    return out;
  }
};
