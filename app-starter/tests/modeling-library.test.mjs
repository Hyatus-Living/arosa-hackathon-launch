import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createModeling} from '../public/modeling.js';

const flush = () => new Promise(setImmediate);

function setup(t, {suggest} = {}) {
  const {document, window} = parseHTML('<html><body><main></main></body></html>');
  globalThis.document = document;
  const requests = [];
  globalThis.fetch = (url, init) => new Promise(resolve => requests.push({url, init, answer: (body, ok = true) => resolve({ok, status: ok ? 200 : 500, headers: {get: () => null}, json: async () => body})}));
  const navigated = [];
  const root = document.querySelector('main');
  const page = createModeling({root, navigate: path => navigated.push(path), canStart: () => true, ...(suggest ? {suggest} : {})});
  t.after(() => { page.leave(); delete globalThis.fetch; delete globalThis.document; });
  return {document, window, root, requests, navigated, page};
}

test('one library lists models and saved underwriting plans together with search and pagination', async t => {
  const {window, root, requests, page} = setup(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  page.show();
  assert.equal(requests.length, 1, 'a single library request, not one per origin');
  assert.match(requests[0].url, /modelingLibrary=true/);
  requests[0].answer({projects: [
    {id: 'model', title: 'New model', modeling: true},
    {id: 'old', title: 'Saved underwriting plan', modeling: false},
  ], nextCursor: 'next'});
  await flush();
  const rows = [...root.querySelectorAll('#modeling-projects a')];
  assert.deepEqual(rows.map(a => a.getAttribute('href')), ['/modeling/model', '/modeling/old']);
  assert.equal(root.querySelectorAll('.modeling-search').length, 1, 'one search box');
  assert.equal(rows[0].querySelector('.modeling-row-origin'), null);
  assert.equal(rows[1].querySelector('.modeling-row-origin').textContent, 'From underwriting');
  const more = root.querySelector('[aria-controls="modeling-projects"]');
  assert.equal(more.hidden, false);
  more.click();
  assert.match(requests[1].url, /cursor=next/);
  requests[1].answer({projects: [{id: 'old2', title: 'Older plan', modeling: false}], nextCursor: null});
  await flush();
  assert.equal(root.querySelectorAll('#modeling-projects a').length, 3);
  const search = root.querySelector('.modeling-search input');
  search.value = 'Saved';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(more.hidden, true);
  assert.equal(more.disabled, true, 'an old cursor cannot be used with a new search');
  t.mock.timers.tick(200);
  assert.match(requests[2].url, /modelingLibrary=true&q=Saved/);
  requests[2].answer({projects: [{id: 'old', title: 'Saved underwriting plan', modeling: false}], nextCursor: null});
  await flush();
  assert.equal(root.querySelectorAll('#modeling-projects a').length, 1);
});

test('a model is created only from a picked NYC address, carrying its BBL', async t => {
  const suggestion = {label: '152 WEST 124 STREET, New York, NY, USA', borough: 'Manhattan', postalcode: '10027', bbl: '1019080056'};
  const {window, root, requests, navigated, page} = setup(t, {suggest: async () => [suggestion]});
  t.mock.timers.enable({apis: ['setTimeout']});
  page.show();
  requests[0].answer({projects: [], nextCursor: null});
  await flush();
  root.querySelector('.core-screen-head button').click();
  const address = root.querySelector('input[name="address"]');
  const submit = [...root.querySelectorAll('button')].find(b => b.textContent === 'Create model');
  assert.equal(submit.disabled, true, 'free text alone cannot create a model');
  address.value = '152 w 124';
  address.dispatchEvent(new window.Event('input'));
  t.mock.timers.tick(200);
  await flush();
  const option = root.querySelector('.modeling-suggestion');
  assert.match(option.textContent, /152 WEST 124 STREET/);
  assert.match(option.textContent, /BBL 1019080056/);
  option.click();
  assert.equal(submit.disabled, false);
  root.querySelector('form').dispatchEvent(new window.Event('submit'));
  const created = JSON.parse(requests[1].init.body);
  assert.equal(created.address, suggestion.label);
  assert.equal(created.bbl, '1019080056');
  requests[1].answer({id: 'new-model'});
  await flush();
  assert.deepEqual(navigated, ['/modeling/new-model?view=massing']);
});

test('an address with no NYC match can only proceed through the labeled no-parcel path', async t => {
  const {window, root, requests, page} = setup(t, {suggest: async () => []});
  t.mock.timers.enable({apis: ['setTimeout']});
  page.show();
  requests[0].answer({projects: [], nextCursor: null});
  await flush();
  root.querySelector('.core-screen-head button').click();
  const address = root.querySelector('input[name="address"]');
  address.value = '1 Nowhere Lane';
  address.dispatchEvent(new window.Event('input'));
  t.mock.timers.tick(200);
  await flush();
  const noParcel = [...root.querySelectorAll('button')].find(b => b.textContent === 'Create without a parcel link');
  assert.equal(noParcel.hidden, false);
  noParcel.click();
  const created = JSON.parse(requests[1].init.body);
  assert.equal(created.address, '1 Nowhere Lane');
  assert.equal(created.bbl, null);
  requests[1].answer({id: 'loose-model'});
  await flush();
});
