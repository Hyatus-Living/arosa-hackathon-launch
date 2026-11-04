import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCorePage} from '../public/core.js';

const flush = () => new Promise(setImmediate);
function setup(t) {
  const {document, window} = parseHTML('<html><body><main></main></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  globalThis.localStorage = {getItem: () => '0'};
  // Cards load their progress as they scroll into view; these tests never scroll.
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const requests = [];
  globalThis.fetch = (url) => {
    if (url === '/api/market-store/status') return Promise.resolve({ok: false, headers: {get: () => 'application/json'}, json: async () => ({error: 'Disabled in fixture'})});
    return new Promise((resolve) => requests.push({url, answer: (body, ok = true) => resolve({ok, status: ok ? 200 : 500, headers: {get: () => null}, json: async () => body})}));
  };
  t.mock.timers.enable({apis: ['setTimeout']});
  const root = document.querySelector('main');
  const page = createCorePage({root, navigate() {}, underwrite() {}, pendingBox: () => document.createElement('div'), conversationId: () => null, canSend: () => true, architectureEnabled: () => false});
  page.showScreen();
  const search = (value) => {
    const input = root.querySelector('input[type=search]');
    input.value = value;
    input.dispatchEvent(new window.Event('input'));
  };
  t.after(() => {page.leave(); delete globalThis.fetch;});
  return {root, page, requests, search};
}
const result = (id, title) => ({projects: [{id, title}]});

test('saved-site search keeps the newest query when responses arrive out of order', async (t) => {
  const {root, requests, search} = setup(t);
  search('Brooklyn');t.mock.timers.tick(250);
  search('Queens');t.mock.timers.tick(250);
  assert.equal(requests[2].url, '/api/projects?sitesOnly=true&q=Queens');
  requests[2].answer(result('q', 'Queens parcel'));await flush();
  requests[1].answer(result('b', 'Brooklyn parcel'));await flush();
  requests[0].answer(result('all', 'Unfiltered parcel'));await flush();
  assert.equal(root.querySelector('.core-site-list').textContent, 'Queens parcel');
});

test('obsolete search errors cannot replace current results, while current failures remain visible', async (t) => {
  const {root, requests, search} = setup(t);
  search('Queens');t.mock.timers.tick(250);
  requests[1].answer(result('q', 'Queens parcel'));await flush();
  requests[0].answer({error: 'Old request failed'}, false);await flush();
  assert.equal(root.querySelector('.core-site-list').textContent, 'Queens parcel');
  search('Bronx');t.mock.timers.tick(250);
  requests[2].answer({error: 'Search is unavailable',userFacing:true}, false);await flush();
  assert.equal(root.querySelector('.core-site-list').textContent, 'Search is unavailable');
});

test('typing invalidates pending results immediately and leaving cancels the debounce', async (t) => {
  const {root, page, requests, search} = setup(t);
  search('Queens');
  requests[0].answer(result('old', 'Obsolete parcel'));await flush();
  assert.doesNotMatch(root.querySelector('.core-site-list').textContent, /Obsolete/);
  page.leave();t.mock.timers.tick(250);await flush();
  assert.equal(requests.length, 1, 'leaving must not start a delayed query');
  assert.equal(root.textContent, '');
});
