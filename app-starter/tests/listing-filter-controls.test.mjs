import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {createListings, searchChoices, mergeArea, listingMatch} from '../public/listings.js';
import {defaultFilterValues, validateFilterSnapshot} from '../public/listing-filter-schema.js';

const flush = () => new Promise(setImmediate);
const defaults = {hardCostPerGrossSqft: 375, softCostPctOfHard: .22, carryAndFinancingPct: .1, zfaToGrossFactor: 1.15};

async function setup(t) {
  const {document, window} = parseHTML(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  const prior = {document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch};
  globalThis.document = document;globalThis.window = window;
  t.after(() => Object.assign(globalThis, prior));
  t.mock.timers.enable({apis: ['setTimeout']});
  const requests = [], root = document.querySelector('#home-listings');
  globalThis.fetch = async path => {
    const url = new URL(path, 'http://fixture');requests.push(url);
    const body = url.pathname.endsWith('/pins') ? {pins: []} : {deals: [], total: 0, offset: 0, userSettings: {dealSettings: defaults, baselineSettings: defaults, isCustom: false}};
    return Response.json(body);
  };
  const listings = createListings({root, canStart: () => true, onUnderwrite() {}, onAsk() {}, onToggleChat() {}, isChatOpen: () => false, loadMap: async () => ({setPins() {}, setSelected() {}, resize() {}, bounds: () => ({south: 40.6, west: -74, north: 40.8, east: -73.9})})});
  listings.show();await flush();await flush();
  const field = label => [...root.querySelectorAll('label')].find(node => node.querySelector('span')?.textContent === label).querySelector('input');
  const type = (label, value) => {const input = field(label);input.value = value;input.dispatchEvent(new window.Event('input', {bubbles: true}));return input;};
  const change = (label, value) => {const input = type(label, value);input.dispatchEvent(new window.Event('change', {bubbles: true}));return input;};
  const tick = async () => {t.mock.timers.tick(350);await flush();await flush();};
  const snapshot = () => listings.filterSnapshot();
  const note = input => {const id = input.getAttribute('aria-describedby');assert.ok(id, 'The invalid field must identify its error');return document.getElementById(id);};
  return {document, window, root, requests, listings, field, type, change, tick, snapshot, note};
}

test('manual zoning uses the canonical schema and normalizes case before the next chat snapshot', async t => {
  const c = await setup(t);c.type('Zoning district', ' r6 ');await c.tick();
  assert.doesNotThrow(() => validateFilterSnapshot(c.snapshot()));assert.equal(c.snapshot().values.zoning, 'R6');
  assert.equal(c.field('Zoning district').value, 'R6');assert.equal(c.requests.at(-1).searchParams.get('zoningPrefix'), 'R6');
});

test('a contradictory manual price range stays unapplied with feedback and can be corrected in place', async t => {
  const c = await setup(t);c.change('Maximum ask', '1m');await flush();const before = c.requests.length;
  const minimum = c.change('Minimum ask', '2m');await flush();
  assert.equal(c.requests.length, before);assert.equal(c.snapshot().values.minPrice, 100000);assert.equal(minimum.value, '2m');
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');assert.match(c.note(minimum).textContent, /minimum price.*maximum price/i);
  assert.doesNotThrow(() => validateFilterSnapshot(c.snapshot()));
  c.change('Maximum ask', '3m');await flush();
  assert.equal(c.snapshot().values.minPrice, 2000000);assert.equal(c.snapshot().values.maxPrice, 3000000);assert.equal(minimum.hasAttribute('aria-invalid'), false);
  assert.equal(c.note(minimum).hidden, true);
});

test('malformed numbers do not clear a limit, unrelated changes preserve the draft, and zero/fractions match the schema', async t => {
  const c = await setup(t);c.change('Maximum ask', '1m');await flush();const maximum = c.change('Maximum ask', '1,2,3');await flush();
  assert.equal(c.snapshot().values.maxPrice, 1000000);assert.equal(maximum.getAttribute('aria-invalid'), 'true');
  const borough = c.root.querySelector('.listings-filters select');for (const option of borough.querySelectorAll('option')) option.selected = false;borough.querySelector('option[value="BK"]').selected = true;borough.dispatchEvent(new c.window.Event('change'));await flush();
  assert.equal(maximum.value, '1,2,3');assert.equal(c.note(maximum).hidden, false);assert.equal(c.snapshot().values.borough, 'BK');
  c.change('Minimum ask', '0');c.change('Maximum ask', '0');await flush();
  assert.equal(c.snapshot().values.minPrice, 0);assert.equal(c.snapshot().values.maxPrice, 0);assert.equal(maximum.value, '0');
  assert.equal(c.requests.at(-1).searchParams.get('maxListPrice'), '0');
  c.change('Maximum $ per buildable SF', '0');await flush();
  assert.match(c.root.querySelector('.listings-pop summary').textContent, /\$0 to \$0/);assert.match(c.listings.context(), /up to \$0\/BSF/);
  c.change('Minimum lot, SF', '2500.5');await flush();assert.equal(c.snapshot().values.minLot, 2500.5);assert.equal(c.requests.at(-1).searchParams.get('minLotArea'), '2500.5');
});

test('manual text constraints reject unsupported zoning and overlong areas without poisoning the snapshot', async t => {
  const c = await setup(t), before = c.requests.length, zoning = c.type('Zoning district', 'R6%');await c.tick();
  assert.equal(c.requests.length, before);assert.equal(c.snapshot().values.zoning, '');assert.equal(zoning.getAttribute('aria-invalid'), 'true');
  assert.match(c.note(zoning).textContent, /zoning prefix/i);
  const area = c.type('ZIP or neighborhood', 'x'.repeat(101));await c.tick();
  assert.equal(c.requests.length, before);assert.equal(c.snapshot().values.area, '');assert.equal(area.getAttribute('aria-invalid'), 'true');
  assert.match(c.note(area).textContent, /100/);assert.doesNotThrow(() => validateFilterSnapshot(c.snapshot()));
});

test('typing invalidates an in-flight Jev update before the text debounce has run', async t => {
  const c = await setup(t), base = c.snapshot();c.type('ZIP or neighborhood', 'Astoria');
  assert.equal(c.listings.applyFilterUpdate({base, values: {...base.values, borough: 'BK'}}), false);
  assert.equal(c.field('ZIP or neighborhood').value, 'Astoria');assert.equal(c.snapshot().values.borough, '');
  await c.tick();assert.equal(c.snapshot().values.area, 'Astoria');
  const next = c.snapshot();assert.equal(c.listings.applyFilterUpdate({base: next, values: {...next.values, minFar: 0}}), true);
  assert.ok(c.root.querySelector('option[value="0"]')?.selected);assert.match(c.listings.context(), /\+0 FAR/);
});

test('explicit clear cancels pending text work and removes invalid numeric drafts and feedback', async t => {
  const c = await setup(t);c.change('Maximum ask', '1m');await flush();const minimum = c.change('Minimum ask', '2m');
  c.type('Zoning district', 'R7A');c.root.querySelector('.listings-clear').click();await flush();const afterClear = c.requests.length;
  await c.tick();assert.equal(c.requests.length, afterClear);assert.equal(c.snapshot().values.zoning, '');assert.equal(c.snapshot().values.minPrice, defaultFilterValues().minPrice);
  assert.equal(minimum.value, '100000');assert.equal(minimum.hasAttribute('aria-invalid'), false);assert.equal(c.note(minimum).hidden, true);
});

test('a legacy chat search with contradictory filters is rejected instead of claiming it was applied', async t => {
  const c = await setup(t);c.change('Maximum ask', '5m');await flush();const before = c.requests.length, values = c.snapshot().values;
  assert.equal(c.listings.applySearch({minListPrice: 2000000, maxListPrice: 1000000}), false);await flush();
  assert.deepEqual(c.snapshot().values, values);assert.equal(c.requests.length, before);
  assert.match(c.root.querySelector('.listings-receipt').textContent, /cannot exceed/i);assert.equal(c.root.querySelector('.listings-receipt').querySelector('button'), null);
  assert.equal(c.listings.applySearch({borough: 'QN'}), true);c.root.querySelector('.listings-receipt button').click();
  assert.deepEqual(c.snapshot().values, values);
});

test('a cost-only Jev update preserves an unrelated invalid manual draft until its own correction', async t => {
  const c = await setup(t);c.change('Maximum ask', '1m');await flush();const minimum = c.change('Minimum ask', '2m'), base = c.snapshot();
  assert.equal(c.listings.applyFilterUpdate({base, values: {...base.values, hardCostPerGrossSqft: 450}}), true);await flush();
  assert.equal(minimum.value, '2m');assert.equal(c.note(minimum).hidden, false);assert.equal(c.snapshot().values.minPrice, 100000);
  c.change('Maximum ask', '3m');await flush();assert.equal(c.snapshot().values.minPrice, 2000000);assert.equal(c.snapshot().values.hardCostPerGrossSqft, 450);
});

test('the place search reads boroughs, ZIPs, zoning and addresses, and its tokens are the location filters', async t => {
  assert.deepEqual(['Brooklyn', '11211, 11206', 'c4-4d', '267 West 23 Street', '1007730009', 'Bushwick'].map(text => searchChoices(text)[0].kind), ['borough', 'area', 'zoning', 'underwrite', 'underwrite', 'area']);
  assert.equal(mergeArea('11211', '11206'), '11211, 11206');assert.equal(mergeArea('Bushwick', '11206'), '11206');
  const c = await setup(t), input = c.root.querySelector('.listings-find input');
  const pick = text => {input.value = text;input.dispatchEvent(new c.window.Event('input', {bubbles: true}));c.document.getElementById('listings-find-option-0').click();};
  pick('Brooklyn');pick('11211');pick('11206');pick('r6');await flush();
  assert.deepEqual([c.snapshot().values.borough, c.snapshot().values.area, c.snapshot().values.zoning], ['BK', '11211, 11206', 'R6']);
  assert.equal(c.requests.at(-1).searchParams.get('zoningPrefix'), 'R6');assert.equal(input.value, '');
  const tokens = () => [...c.root.querySelectorAll('.listings-token')].map(node => node.textContent);
  assert.deepEqual(tokens(), ['Brooklyn', 'ZIP 11211, 11206', 'Zoning R6']);assert.equal(c.root.querySelector('.listings-all-count').textContent, '3');
  c.root.querySelector('.listings-token').click();await flush();
  assert.equal(c.snapshot().values.borough, '');assert.deepEqual(tokens(), ['ZIP 11211, 11206', 'Zoning R6']);
});

test('free text offers one suggestion row: the likelier action first and the other reading as a quiet second choice', async t => {
  assert.deepEqual(searchChoices('267 West 23 Street').map(({kind, label, secondary}) => [kind, label, Boolean(secondary)]), [['underwrite', 'Underwrite 267 West 23 Street', false], ['area', 'Search the area', true]]);
  assert.deepEqual(searchChoices('267 West 23 Street', {underwrite: false}).map(({kind}) => kind), ['area'], 'verified city-directory rows replace underwriting the raw typed text');
  assert.deepEqual(searchChoices('Bushwick').map(({kind, label, secondary}) => [kind, label, Boolean(secondary)]), [['area', 'Search Bushwick', false], ['underwrite', 'Underwrite as an address', true]]);
  const c = await setup(t), input = c.root.querySelector('.listings-find input');
  input.value = '267 West 23 Street';input.dispatchEvent(new c.window.Event('input', {bubbles: true}));
  const rows = c.root.querySelectorAll('.listings-find-options > li');
  assert.equal(rows.length, 1, 'one row per typed address');
  const options = [...rows[0].querySelectorAll('[role="option"]')];
  assert.deepEqual(options.map(node => node.textContent), ['Underwrite 267 West 23 Street', 'Search the area']);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  const key = name => {const event = new c.window.Event('keydown');event.key = name;input.dispatchEvent(event);};
  key('ArrowDown');
  assert.equal(options[1].getAttribute('aria-selected'), 'true');assert.equal(input.getAttribute('aria-activedescendant'), options[1].id);
  key('Enter');await flush();
  assert.equal(c.snapshot().values.area, '267 West 23 Street', 'the second choice searches the area');
});

test('the drawer reports the live count beside Done, and map-following is a labelled switch', async t => {
  const c = await setup(t), drawer = c.root.querySelector('.listings-drawer');
  const done = drawer.querySelector('.listings-drawer-done');
  assert.equal(done.textContent, 'Done');
  assert.equal(drawer.querySelector('.listings-drawer-count').textContent, 'No matches');
  assert.equal(drawer.querySelector('.listings-drawer-reset').textContent, 'Clear all');
  const follow = c.root.querySelector('.listings-follow input');
  assert.equal(follow.type, 'checkbox');assert.equal(follow.getAttribute('role'), 'switch');
  assert.match(follow.closest('label').textContent, /Search as I move the map/);
});

test('a typed address finds the listing itself first, and opening it shows that listing', async t => {
  assert.deepEqual(listingMatch({id: 'l6', address: '6 Chatham Sq', neighborhood: 'Chinatown', zipCode: '10038', listPrice: 4000000}), {kind: 'listing', value: 'l6', label: '6 Chatham Sq', meta: 'Chinatown · 10038 · $4M'});
  const c = await setup(t), input = c.root.querySelector('.listings-find input');
  const fixture = globalThis.fetch;
  globalThis.fetch = async path => {
    const url = new URL(path, 'http://fixture');
    if (url.searchParams.get('area') === '6 Chatham' && url.searchParams.get('limit') === '5') {c.requests.push(url);return Response.json({deals: [{id: 'l6', address: '6 Chatham Sq', neighborhood: 'Chinatown', zipCode: '10038', listPrice: 4000000}], total: 1});}
    return fixture(path);
  };
  input.focus();input.value = '6 Chatham';input.dispatchEvent(new c.window.Event('input', {bubbles: true}));
  await c.tick();
  const lookup = c.requests.find(url => url.searchParams.get('limit') === '5');
  assert.equal(lookup.searchParams.get('minUnusedZfa'), '0', 'every listing at the address, not only ones with headroom');
  const first = c.document.getElementById('listings-find-option-0');
  assert.match(first.textContent, /Listing6 Chatham SqChinatown · 10038 · \$4M/);
  assert.match(c.document.getElementById('listings-find-option-1').textContent, /Underwrite 6 Chatham/);
  first.click();await flush();await flush();
  assert.ok(c.requests.some(url => url.pathname.endsWith('/market-store/deals/l6')), 'picking it opens the listing');
  assert.equal(input.value, '');
});

test('an area token is labelled ZIP only for ZIP codes', async t => {
  const c = await setup(t), input = c.root.querySelector('.listings-find input');
  input.value = 'Bushwick';input.dispatchEvent(new c.window.Event('input', {bubbles: true}));c.document.getElementById('listings-find-option-0').click();await flush();
  assert.deepEqual([...c.root.querySelectorAll('.listings-token')].map(node => node.textContent), ['Bushwick']);
});

test('a ZIP+4 searches its ZIP, and ZIP codes mixed with a place name show a field error naming the word', async t => {
  const c = await setup(t);
  assert.deepEqual(searchChoices('11201-1234').map(({kind, kindLabel}) => [kind, kindLabel]), [['area', 'ZIP']]);
  assert.equal(mergeArea('11201', '11211-1234'), '11201, 11211');
  c.type('ZIP or neighborhood', '11201-1234');await c.tick();
  assert.equal(c.snapshot().values.area, '11201-1234');assert.equal(c.requests.at(-1).searchParams.get('area'), '11201-1234');
  const before = c.requests.length, input = c.type('ZIP or neighborhood', '11201, Williamsburg');await c.tick();
  assert.equal(c.requests.length, before, 'nothing is searched');assert.equal(c.snapshot().values.area, '11201-1234');
  assert.equal(input.getAttribute('aria-invalid'), 'true');assert.match(c.note(input).textContent, /"Williamsburg" is not a ZIP code/);
  const find = c.root.querySelector('.listings-find input');find.value = '11211, Bushwick';find.dispatchEvent(new c.window.Event('input', {bubbles: true}));
  const enter = new c.window.Event('keydown');enter.key = 'Enter';find.dispatchEvent(enter);await flush();
  assert.match(c.root.querySelector('#listings-find-note').textContent, /"Bushwick" is not a ZIP code/);assert.equal(c.snapshot().values.area, '11201-1234');
});
