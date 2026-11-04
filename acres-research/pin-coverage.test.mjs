// Explicit operator configuration for this isolated test deployment.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pinCoverageFixture} from './testing/pin-coverage.mjs';
import {pinRows, pinsGeoJson, pinsBounds} from '../app-starter/public/listings-map.js';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

const all = {minUnusedZfa: 0, sortBy: 'uap_price_per_buildable_zfa', includeSimilarComps: false};
const ids = result => result.pins.id;

test('the complete located match set reaches GeoJSON and bounds beyond 3000 pins, including a low-ranked distant property', t => {
  const f = pinCoverageFixture(t), result = f.store.searchDealsPage({...all, pins: true});
  assert.equal(result.total, f.rows.length);assert.equal(result.pins.id.length, f.rows.length - 3);
  assert.equal(result.locatedTotal, result.pins.id.length);assert.equal(result.unlocatedTotal, 3);
  assert.deepEqual(new Set(ids(result)), new Set(f.rows.filter(row => !f.invalidIds.has(row.id)).map(row => row.id)));
  assert.equal(ids(result).at(-1), f.far.id, 'The lowest-ranked property is still represented');
  const data = pinsGeoJson(pinRows(result.pins));
  assert.equal(data.features.length, result.locatedTotal);assert.ok(data.features.some(feature => feature.properties.id === f.far.id));
  assert.deepEqual(pinsBounds(pinRows(result.pins))[0], [-74.24, 40.5], 'Fit bounds include the formerly omitted property');
});

test('complete pin coverage retains page ordering and verdicts under live and stored sorts and custom costs', t => {
  const f = pinCoverageFixture(t);
  for (const sortBy of ['uap_price_per_buildable_zfa', 'best_deal', 'implied_yield_on_cost']) {
    const filters = {...all, sortBy, customSettings: {hardCostPerGrossSqft: 650, softCostPctOfHard: .3, carryAndFinancingPct: .15, zfaToGrossFactor: 1.25}};
    const map = f.store.searchDealsPage({...filters, pins: true}), byId = new Map(pinRows(map.pins).map(pin => [pin.id, pin]));
    assert.equal(map.pins.id.length, f.rows.length - 3, sortBy);
    for (const offset of [0, 3000]) {
      const page = f.store.searchDealsPage({...filters, offset, limit: 100}), pageIds = new Set(page.deals.map(deal => deal.id));
      const located = page.deals.filter(deal => !f.invalidIds.has(deal.id));
      assert.deepEqual(map.pins.id.filter(id => pageIds.has(id)), located.map(deal => deal.id));
      for (const deal of located) assert.equal(byId.get(deal.id).dealVerdict, deal.flashcardValuation.dealVerdict);
    }
  }
});

test('pin completeness preserves borough, style, bounds, price, landmark and tenant-review filters', t => {
  const f = pinCoverageFixture(t);
  const filters = {...all, pins: true, borough: 'BK', styles: 'land', maxListPrice: 2500000, excludeLandmarks: true, excludeHighStabilizedRisk: true};
  const expected = f.rows.filter(row => row.borough === 'BK' && row.style === 'land' && row.listPrice <= 2500000 && !row.landmark && !row.highRisk);
  const result = f.store.searchDealsPage(filters), located = expected.filter(row => !f.invalidIds.has(row.id));
  assert.equal(result.total, expected.length);assert.equal(result.unlocatedTotal, expected.length - located.length);
  assert.deepEqual(new Set(ids(result)), new Set(located.map(row => row.id)));
  const box = {south: 40.6, west: -74.1, north: 40.8, east: -73.7};
  const bounded = f.store.searchDealsPage({...filters, bounds: box});
  assert.deepEqual(ids(bounded), ids(result));assert.equal(bounded.unlocatedTotal, 0);assert.equal(bounded.total, located.length);
});

test('unlocated and empty matches report exact coverage without inventing map positions', t => {
  const f = pinCoverageFixture(t);
  for (const id of f.invalidIds) {
    const result = f.store.searchDealsPage({...all, pins: true, listingId: id});
    assert.deepEqual({total: result.total, located: result.locatedTotal, unlocated: result.unlocatedTotal, pins: pinRows(result.pins)}, {total: 1, located: 0, unlocated: 1, pins: []});
  }
  const empty = f.store.searchDealsPage({...all, pins: true, borough: 'ZZ'});
  assert.deepEqual({total: empty.total, located: empty.locatedTotal, unlocated: empty.unlocatedTotal, pins: pinRows(empty.pins)}, {total: 0, located: 0, unlocated: 0, pins: []});
});

test('the authenticated pin endpoint delivers every located match regardless of card-page limit and offset', async t => {
  const cleanup = [], f = pinCoverageFixture({after: fn => cleanup.push(fn)}), chat = new ChatStore(join(f.dir, 'chat.sqlite'));
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'fixture'}, store: chat, maps: null, marketStoreFactory: () => new MarketStore(f.path)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));chat.close();cleanup.forEach(fn => fn());});
  const response = await fetch(`http://127.0.0.1:${server.address().port}/market-store/deals/pins?minUnusedZfa=0&sortBy=best_deal&limit=1&offset=3000`, {headers: {authorization: 'Bearer fixture', 'x-acres-account': 'a'.repeat(24), 'x-acres-email': 'alex@witharosa.ai'}});
  assert.equal(response.status, 200);const result = await response.json();
  assert.equal(result.total, f.rows.length);assert.equal(result.locatedTotal, f.rows.length - 3);assert.equal(result.unlocatedTotal, 3);
  assert.equal(pinsGeoJson(pinRows(result.pins)).features.length, f.rows.length - 3);
  assert.ok(result.pins.id.includes(f.far.id));
});
