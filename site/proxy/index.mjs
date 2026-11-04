// Same-origin API bridge for witharosa.ai, deployed as Cloud Run service
// arosa-site-proxy in hyatus-openclaw. Firebase Hosting rewrites /api/** here.
// Public paths pass through to the app; every other /api path redirects there.
import http from 'node:http';

const APP = 'https://build.witharosa.ai';
const PUBLIC = new Set(['/api/public/stats', '/api/public/beta-apply']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
    return;
  }
  if (!PUBLIC.has(url.pathname)) {
    res.writeHead(302, {location: `${APP}${url.pathname}${url.search}`});
    res.end();
    return;
  }
  try {
    const headers = {};
    // The app checks Origin exactly and rate-limits on the first forwarded IP.
    if (req.headers.origin) headers.origin = req.headers.origin;
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) headers['x-forwarded-for'] = xff;
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) throw new Error('body too large');
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const upstream = await fetch(`${APP}${url.pathname}${url.search}`, {
      method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
    const out = {};
    const type = upstream.headers.get('content-type');
    if (type) out['content-type'] = type;
    const cache = upstream.headers.get('cache-control');
    if (cache) out['cache-control'] = cache;
    res.writeHead(upstream.status, out);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(503, {'content-type': 'application/json'});
    res.end('{"error":"We could not send your application. Try again in a minute."}');
  }
});

server.listen(Number(process.env.PORT || 8080));
