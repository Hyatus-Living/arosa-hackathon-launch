import test from 'node:test';
import assert from 'node:assert/strict';
import {markScriptRequests, SIGN_IN_EXPIRED} from '../public/access-fetch.js';

function page(respond) {
  const target = new EventTarget();
  const calls = [];
  target.location = {href: 'https://app.witharosa.ai/sites/1', origin: 'https://app.witharosa.ai'};
  target.fetch = async (input, init) => {calls.push({input, init}); return respond(input);};
  markScriptRequests(target);
  return {target, calls};
}

test('API requests are marked as script requests so an expired sign-in answers 401, not a redirect', async () => {
  const {target, calls} = page(() => new Response('{}', {status: 200}));
  await target.fetch('/api/session', {headers: {'content-type': 'application/json'}});
  assert.equal(calls[0].init.headers.get('x-requested-with'), 'XMLHttpRequest');
  assert.equal(calls[0].init.headers.get('content-type'), 'application/json');
});

test('other requests pass through untouched', async () => {
  const {target, calls} = page(() => new Response('', {status: 200}));
  const init = {mode: 'no-cors'};
  await target.fetch('/cdn-cgi/access/logout', init);
  await target.fetch('https://tiles.example.com/a.png');
  assert.equal(calls[0].init, init);
  assert.equal(calls[1].init.headers, undefined);
});

test('an Access 401 announces the expired sign-in; an app 401 does not', async () => {
  let status = {'www-authenticate': 'Cloudflare-Access resource_metadata="x"'};
  const {target} = page(() => new Response('<html>401</html>', {status: 401, headers: status}));
  let expired = 0;
  target.addEventListener(SIGN_IN_EXPIRED, () => expired++);
  await target.fetch('/api/runs');
  assert.equal(expired, 1);
  status = {};
  await target.fetch('/api/runs');
  assert.equal(expired, 1);
});
