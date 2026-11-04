import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCorePage} from '../public/core.js';
import {fullState} from './fixtures/project-state.mjs';

const flush = () => new Promise(setImmediate);
async function setup(t) {
  const {document, window} = parseHTML('<html><body><main></main></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.localStorage = {getItem: () => null, setItem() {}};
  globalThis.EventSource = class { addEventListener() {} close() {} };
  Object.defineProperty(window.HTMLElement.prototype, 'elements', {configurable: true, get() {
    return this.tagName === 'FORM' ? [...this.querySelectorAll('input,select,textarea,button')] : undefined;
  }});
  const requests = [];
  globalThis.fetch = (url) => {
    if (url === '/api/market-store/status') return Promise.resolve({ok: false, status: 404, headers: {get: () => null}, json: async () => ({error: 'Fixture disabled'})});
    return new Promise((resolve) => requests.push({url, answer: (body, status = 200) => resolve({ok: status < 400, status, headers: {get: () => null}, json: async () => body})}));
  };
  const sent = [];
  document.addEventListener('acres-follow-up', (e) => sent.push(e.detail.ref));
  t.mock.timers.enable({apis: ['setTimeout']});
  const root = document.querySelector('main');
  const page = createCorePage({root, navigate() {}, underwrite() {}, pendingBox: () => document.createElement('div'), conversationId: () => 'c1', canSend: () => true, architectureEnabled: () => false, mountConcept: async () => {}});
  t.after(() => page.leave());
  page.showParcel('p1');
  return {root, page, requests, sent};
}

test('the site page holds its shape with a skeleton until the state arrives', async (t) => {
  const {root, requests} = await setup(t);
  assert.ok(root.querySelector('.uw-skeleton .uw-snapshot .skel'));
  assert.equal(root.querySelector('[role="status"]').textContent, 'Loading the site');
  assert.doesNotMatch(root.textContent, /Loading site…/);
  requests[0].answer(fullState);
  await flush();
  assert.equal(root.querySelector('.uw-skeleton'), null);
  assert.equal(root.querySelector('h1').textContent, '1234 Fulton Street');
});

test('a step action shows as starting in its step at once and clears when the run reports', async (t) => {
  const {root, page, requests, sent} = await setup(t);
  requests[0].answer(fullState);
  await flush();
  root.querySelector('#core-step-build .uw-menu [data-follow-action="recompute"]').click();
  assert.deepEqual(sent.at(-1), {conversation: 'c1', field: 'envelope', action: 'recompute'});
  assert.equal(root.querySelector('#core-step-build').className, 'uw-step is-starting');
  assert.match(root.querySelector('.uw-next').textContent, /Step 2 of 4 · Starting…/);
  page.setRun({label: 'Starting research', tools: []});
  assert.equal(root.querySelector('#core-step-build').className, 'uw-step is-running', 'a run with no tool yet shows in the step that asked for it');
  assert.match(root.querySelector('.uw-next').textContent, /Step 2 of 4 · Starting research/);
  page.setRun({label: 'Computing the zoning envelope', tools: ['acres_zoning_envelope']});
  assert.equal(root.querySelector('#core-step-build').className, 'uw-step is-running');
  t.mock.timers.tick(20000);
  assert.equal(root.querySelector('#core-step-build').className, 'uw-step is-running', 'a reported run is not timed out');
  page.setRun(null);
  assert.equal(root.querySelector('.uw-step.is-starting'), null, 'the finished run leaves no starting state behind');
});

test('a request that fails before its run starts clears the starting state and says so', async (t) => {
  const {root, page, requests} = await setup(t);
  requests[0].answer(fullState);
  await flush();
  root.querySelector('#core-step-decide .uw-menu [data-follow-action="recompute"]').click();
  assert.equal(root.querySelector('#core-step-decide').className, 'uw-step is-starting');
  page.setRun(null, {message: 'Arosa could not start.'});
  assert.equal(root.querySelector('.uw-step.is-starting'), null);
  assert.match(root.querySelector('.uw-next').textContent, /The last request did not finish\. Arosa could not start\./);
});

test('a request that never starts a run stops showing as starting', async (t) => {
  const {root, requests} = await setup(t);
  requests[0].answer(fullState);
  await flush();
  root.querySelector('#core-step-worth .uw-menu [data-follow-action="recompute"]').click();
  assert.equal(root.querySelector('#core-step-worth').className, 'uw-step is-starting');
  t.mock.timers.tick(20000);
  assert.equal(root.querySelector('.uw-step.is-starting'), null);
});

test('the More menu opens a step\'s notes', async (t) => {
  const {root, requests} = await setup(t);
  requests[0].answer(fullState);
  await flush();
  const notes = root.querySelector('details[data-disclosure="notes-worth"]');
  assert.equal(notes.hidden, true);
  root.querySelector('[data-notes-open="worth"]').click();
  assert.equal(notes.hidden, false);
  assert.equal(notes.open, true);
});

test('a site that fails to load says so in one line with Retry', async (t) => {
  const {root, requests} = await setup(t);
  requests[0].answer({error: 'The service is unavailable.',userFacing:true}, 503);
  await flush();
  assert.match(root.querySelector('.core-fail').textContent, /The service is unavailable\.\s*Retry/);
  root.querySelector('[data-site-retry]').click();
  assert.ok(root.querySelector('.uw-skeleton'));
  assert.equal(requests.at(-1).url, '/api/projects/p1/state');
});
