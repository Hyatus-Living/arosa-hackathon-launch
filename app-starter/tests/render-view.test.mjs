import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderSchemeRender} from '../public/render-view.js';

const flush = () => new Promise(setImmediate);
function dom() {
  const {document} = parseHTML('<!doctype html><html><body><div id="slot" data-project-id="p-1" data-scheme-id="max_bonus"></div></body></html>');
  globalThis.document = document;
  return document.querySelector('#slot');
}
// fetch answers in order; each call is recorded.
function respond(...answers) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({url, method: options.method || 'GET'});
    const [status, body] = answers.shift();
    return {ok: status < 400, status, json: async () => body, headers: {get: () => null}};
  };
  return calls;
}
const ready = {artifactId: 's1', status: 'succeeded', url: '/api/projects/p-1/architecture/artifacts/s1', jobId: 'j1', reason: null,
  views: [{view: 'street', artifactId: 's1', url: '/api/projects/p-1/architecture/artifacts/s1'}, {view: 'aerial', artifactId: 'a1', url: '/api/projects/p-1/architecture/artifacts/a1'}],
  renderSeconds: 82.4, at: 1};

test('an undrawn option offers one action, which queues the render and shows its progress', async () => {
  const slot = dom();
  const calls = respond([202, {artifactId: null, status: 'queued', url: null, jobId: 'j1', views: []}]);
  const changes = [];
  renderSchemeRender(slot, null, {onChange: render => changes.push(render.status)});
  assert.equal(slot.querySelector('.scheme-render-note').textContent, 'Not drawn yet.');
  const buttons = slot.querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'Render this option');
  buttons[0].dispatchEvent(new globalThis.document.defaultView.Event('click'));
  await flush();
  assert.deepEqual(calls, [{url: '/api/projects/p-1/schemes/max_bonus/render', method: 'POST'}]);
  assert.deepEqual(changes, ['queued']);
  assert.ok(slot.querySelector('.scheme-render-skel'));
  assert.equal(slot.querySelector('[role="status"]').textContent, 'Waiting to render, about two minutes once it starts.');
  clearTimeout(slot._renderPoll);
});

test('a finished render shows the street view and switches to the aerial view', () => {
  const slot = dom();
  renderSchemeRender(slot, ready);
  const img = slot.querySelector('img');
  assert.equal(img.getAttribute('src'), ready.views[0].url);
  assert.match(img.getAttribute('alt'), /^Street view/);
  const [street, aerial] = slot.querySelectorAll('.scheme-render-view');
  assert.equal(street.getAttribute('aria-pressed'), 'true');
  aerial.dispatchEvent(new globalThis.document.defaultView.Event('click'));
  assert.equal(img.getAttribute('src'), ready.views[1].url);
  assert.equal(aerial.getAttribute('aria-pressed'), 'true');
  assert.ok(!slot.textContent.includes('—'));
});

test('a failed render says so plainly and offers to try again; a refused request shows why', () => {
  const slot = dom();
  renderSchemeRender(slot, {status: 'failed', reason: 'Blender render phase exited with exit code 1', jobId: 'j2', views: []});
  assert.equal(slot.querySelector('.core-fail-text').textContent, 'The rendering did not finish.');
  assert.ok(!slot.textContent.includes('Blender'), 'no worker internals on the page');
  assert.equal(slot.querySelector('button').textContent, 'Try again');
  renderSchemeRender(slot, {status: 'failed', message: 'This option has no massing to render yet: model it or compute the zoning envelope first.', views: []});
  assert.match(slot.querySelector('.core-fail-text').textContent, /no massing/);
  renderSchemeRender(slot, null, {canRender: false});
  assert.equal(slot.querySelectorAll('button').length, 0, 'viewers get no render action');
});
