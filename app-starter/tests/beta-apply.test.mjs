import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {betaApplyAllowed, betaApplyClient} from '../beta-apply.mjs';
import {betaApplicationProblem} from '../../site/public/beta.js';
import {countText} from '../../site/public/beta-motion.js';

test('one address may apply five times an hour, then waits for the window to pass', () => {
  const log = new Map();
  for (let i = 0; i < 5; i++) assert.equal(betaApplyAllowed(log, '1.2.3.4', 1000 + i), true);
  assert.equal(betaApplyAllowed(log, '1.2.3.4', 2000), false);
  assert.equal(betaApplyAllowed(log, '5.6.7.8', 2000), true, 'another address is unaffected');
  assert.equal(betaApplyAllowed(log, '1.2.3.4', 1000 + 3600000), true, 'the window rolls');
});

test('the beta form asks for a name, a valid email and a role before sending', () => {
  assert.equal(betaApplicationProblem({name: '', email: 'a@b.co', role: 'developer'}), 'Enter your name.');
  assert.equal(betaApplicationProblem({name: 'Dana', email: 'dana@', role: 'developer'}), 'Enter a valid email address.');
  assert.equal(betaApplicationProblem({name: 'Dana', email: 'dana@example.com', role: ''}), 'Choose what best describes you.');
  assert.equal(betaApplicationProblem({name: 'Dana', email: 'dana@example.com', role: 'developer'}), '');
});

test('a counting figure starts at zero, rises without overshooting and lands on its exact text', () => {
  assert.equal(countText({to: 12000, suffix: '+'}, 0), '0+');
  assert.equal(countText({to: 12000, suffix: '+'}, 1), '12,000+');
  assert.equal(countText({to: 5, prefix: '$', suffix: 'M'}, 1), '$5M');
  assert.equal(countText({to: 50, suffix: '%'}, 2), '50%', 'progress past the end holds the final value');
  const shown = [0.1, 0.3, 0.5, 0.8].map((p) => Number(countText({to: 46000}, p).replace(/,/g, '')));
  assert.deepEqual(shown, [...shown].sort((a, b) => a - b));
  assert.ok(shown.every((n) => n > 0 && n < 46000));
});

test('the app accepts a relayed address only from its authenticated proxy or local tunnel', () => {
  const secret = 'test-only-'.repeat(4);
  const peer = '192.0.2.10', reported = '198.51.100.7';
  const headers = {'x-forwarded-for': reported, 'cf-connecting-ip': reported, 'x-arosa-client-ip': reported};
  const request = {headers, socket: {remoteAddress: peer}};
  assert.equal(betaApplyClient(request, secret), peer);
  assert.equal(betaApplyClient({...request, socket: {remoteAddress: '::ffff:127.0.0.1'}}, secret), reported);
  headers['x-arosa-site-proxy-key'] = secret;
  assert.equal(betaApplyClient(request, secret), reported);
  assert.equal(betaApplyClient(request, ''), null);
  assert.equal(betaApplyClient(request, 'x'.repeat(secret.length)), null);
  headers['x-arosa-client-ip'] = 'invalid';
  assert.equal(betaApplyClient(request, secret), null);
});

test('the site bridge ignores client-supplied forwarding and authentication headers', async t => {
  const secret = 'test-only-'.repeat(4);
  const upstream = [];
  let handleRequest;
  t.mock.method(http, 'createServer', handler => { handleRequest = handler; return {listen() {}}; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    upstream.push(options.headers);
    return new Response('{}');
  });
  const before = {...process.env};
  const config = {AROSA_SITE_PROXY_SECRET: secret, AROSA_APP_ORIGIN: 'https://example.invalid', K_SERVICE: 'test'};
  Object.assign(process.env, config);
  t.after(() => {
    for (const key of Object.keys(config)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
  await import('../../site/proxy/index.mjs');
  const req = {url: '/api/public/beta-apply', method: 'POST', async *[Symbol.asyncIterator]() {},
    headers: {'x-forwarded-for':'192.0.2.10, 198.51.100.7', 'x-arosa-site-proxy-key':'spoofed',
      'x-arosa-client-ip':'192.0.2.10'}, socket: {remoteAddress:'127.0.0.1'}};
  const res = {writeHead(status) { this.status = status; }, end() {}};
  await handleRequest(req, res);
  assert.equal(res.status, 200);
  assert.equal(betaApplyClient({headers: upstream[0], socket: req.socket}, secret), '198.51.100.7');
  req.headers['x-forwarded-for'] = '192.0.2.10, invalid';
  await handleRequest(req, res);
  assert.equal(res.status, 503);
  delete process.env.AROSA_SITE_PROXY_SECRET;
  req.headers['x-forwarded-for'] = '198.51.100.7';
  await handleRequest(req, res);
  assert.equal(res.status, 503);
  assert.equal(upstream.length, 1);
});

test('beta application quotas bound tracked addresses and release expired slots', () => {
  const log = new Map(Array.from({length: 10000}, (_, i) => [String(i), [1000]]));
  assert.equal(betaApplyAllowed(log, 'new', 2000), false);
  assert.equal(betaApplyAllowed(log, '0', 2000), true);
  assert.equal(log.size, 10000);
  assert.equal(betaApplyAllowed(log, 'new', 3601000), true);
  assert.deepEqual([...log.keys()], ['0', 'new']);
});
