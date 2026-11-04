import {timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';

// Only the authenticated site proxy may relay a client address. A local Cloudflare
// tunnel may supply its edge-verified address; direct callers use their socket peer.
export function betaApplyClient(req, secret = process.env.AROSA_SITE_PROXY_SECRET || '') {
  const supplied = String(req.headers['x-arosa-site-proxy-key'] || '');
  if (supplied) {
    const expected = Buffer.from(secret), actual = Buffer.from(supplied);
    if (expected.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const client = String(req.headers['x-arosa-client-ip'] || '');
    return isIP(client) ? client : null;
  }
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const cloudflare = String(req.headers['cf-connecting-ip'] || '');
  if ((peer === '::1' || peer.startsWith('127.')) && isIP(cloudflare)) return cloudflare;
  return isIP(peer) ? peer : 'unknown';
}

const nextCleanup = new WeakMap();
// How many beta applications one address may send per window: a few retries are fine, a flood is not.
export function betaApplyAllowed(log, client, now = Date.now(), limit = 5, windowMs = 3600000) {
  if (now >= (nextCleanup.get(log) || 0)) {
    for (const [key, times] of log) if (!times.length || now - times.at(-1) >= windowMs) log.delete(key);
    nextCleanup.set(log, now + 60000);
  }
  if (!log.has(client) && log.size >= 10000) return false;
  const recent = (log.get(client) || []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    log.set(client, recent);
    return false;
  }
  log.set(client, [...recent, now]);
  return true;
}
