import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore, FULL_PULL_LIMIT, WHOLE_LOT_PROPERTY_TYPES, isListingDataCheck} from './market-store.mjs';
import {createResearchServer} from './service.mjs';
import {ChatStore} from './store.mjs';
import {aggregate} from './research.mjs';
import {pinRows} from '../app-starter/public/listings-map.js';

// Four Brooklyn listings on four PLUTO lots, the store's home listings page reads.
const LOTS = [
  {n: 101, street: 'Kent Ave', zip: '11249', lot: 4000, bldg: 2000, far: 4.0, aff: 4.6, zone: 'R6A', style: 'multi_family', price: 1800000, lat: 40.7101, lon: -73.9671, hood: 'Williamsburg'},
  {n: 202, street: 'Kent Ave', zip: '11249', lot: 2500, bldg: 2400, far: 2.0, aff: 2.2, zone: 'R5', style: 'townhomes', price: 3900000, lat: 40.7112, lon: -73.9660, hood: 'Williamsburg'},
  {n: 303, street: 'Court St', zip: '11231', lot: 6000, bldg: 1000, far: 3.0, aff: 3.9, zone: 'R6', style: 'land', price: 950000, lat: 40.6800, lon: -73.9950, hood: 'Carroll Gardens'},
  {n: 404, street: 'Court St', zip: '11231', lot: 3000, bldg: 1500, far: 3.0, aff: 3.9, zone: 'R6', style: 'single_family', price: 60000, lat: 40.6810, lon: -73.9940, hood: 'Carroll Gardens'},
];

async function seededStore() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-listings-'));
  const dbPath = join(dir, 'market.sqlite');
  const store = new MarketStore(dbPath);
  store.ingestListings(LOTS.map(l => ({
    propertyId: `p-${l.n}`,
    listingType: 'for_sale',
    address: `${l.n} ${l.street}, Brooklyn, NY ${l.zip}`,
    streetLine: `${l.n} ${l.street}`,
    streetNumber: String(l.n),
    streetName: l.street.split(' ')[0],
    city: 'Brooklyn',
    state: 'NY',
    zipCode: l.zip,
    neighborhood: l.hood,
    latitude: l.lat,
    longitude: l.lon,
    style: l.style,
    isDevelopmentCandidate: true,
    sqft: l.bldg,
    lotSqft: l.lot,
    listPrice: l.price,
  })));
  await store.enrichNycListingsWithPluto({
    limit: 10,
    plutoFetcher: async () => LOTS.map((l, i) => ({
      bbl: `30000000${i + 1}0.00000000`, borough: 'BK', address: `${l.n} ${l.street.toUpperCase()}`, zipcode: l.zip, zonedist1: l.zone,
      lotarea: String(l.lot), bldgarea: String(l.bldg), builtfar: String(l.bldg / l.lot), residfar: String(l.far), affresfar: String(l.aff),
      commfar: '0', facilfar: String(l.far), unitsres: '1', unitstotal: '1', bldgclass: 'B1', lotfront: '25', lotdepth: '100', lottype: '5',
      latitude: String(l.lat), longitude: String(l.lon),
    })),
  });
  return {store, dbPath, cleanup: () => { store.close(); rmSync(dir, {recursive: true, force: true}); }};
}

const ids = page => page.deals.map(d => d.address.split(',')[0]);

test('the listings filters narrow by price, lot size, headroom, property type, tier, area and map bounds', async () => {
  const {store, cleanup} = await seededStore();
  try {
    const all = {minUnusedZfa: 0, includeSimilarComps: false};
    assert.equal(store.searchDealsPage(all).total, 4);
    assert.deepEqual(ids(store.searchDealsPage({...all, minListPrice: 100000, maxListPrice: 2000000})).sort(), ['101 Kent Ave', '303 Court St']);
    assert.deepEqual(ids(store.searchDealsPage({...all, minLotArea: 3000, maxLotArea: 4500})).sort(), ['101 Kent Ave', '404 Court St']);
    assert.deepEqual(ids(store.searchDealsPage({...all, styles: 'land,townhomes'})).sort(), ['202 Kent Ave', '303 Court St']);
    assert.deepEqual(ids(store.searchDealsPage({...all, area: 'carroll'})).sort(), ['303 Court St', '404 Court St']);
    assert.deepEqual(ids(store.searchDealsPage({...all, area: '11249'})).sort(), ['101 Kent Ave', '202 Kent Ave']);
    // Unused floor area over lot area: 303 Court St has 6,000 SF of lot and 22,400 SF unused with the bonus.
    for (const d of store.searchDealsPage({...all, minHeadroomFar: 3}).deals) assert.ok(d.unusedUapZfa / d.lotAreaSqft >= 3, d.address);
    assert.ok(store.searchDealsPage({...all, minHeadroomFar: 3}).total < 4);
    const box = {south: 40.705, west: -73.97, north: 40.715, east: -73.96};
    assert.deepEqual(ids(store.searchDealsPage({...all, bounds: box})).sort(), ['101 Kent Ave', '202 Kent Ave']);
    const verdicts = [...new Set(store.searchDealsPage(all).deals.map(d => d.flashcardValuation.dealVerdict))];
    const two = verdicts.slice(0, 2).join(',');
    const kept = store.searchDealsPage({...all, dealVerdict: two});
    assert.ok(kept.deals.every(d => verdicts.slice(0, 2).includes(d.flashcardValuation.dealVerdict)));
    // At the reader's own costs the tier filter keeps exactly the listings shown with that tier.
    const costly = {...all, customSettings: {hardCostPerGrossSqft: 1400}};
    for (const verdict of ['great_deal', 'good_deal', 'fair_deal', 'full_price']) {
      const shown = store.searchDealsPage(costly).deals.filter(d => d.flashcardValuation.dealVerdict === verdict).map(d => d.id).sort();
      assert.deepEqual(store.searchDealsPage({...costly, dealVerdict: verdict}).deals.map(d => d.id).sort(), shown, verdict);
    }
  } finally {
    cleanup();
  }
});

test('best deals rank listings to confirm last, then by verdict tier and lowest price per buildable SF, and pins cover every located match', async () => {
  const {store, cleanup} = await seededStore();
  try {
    const order = ['great_deal', 'good_deal', 'unpriced_opportunity', 'fair_deal', 'full_price'];
    const page = store.searchDealsPage({sortBy: 'best_deal', minUnusedZfa: 0, includeSimilarComps: false});
    const keys = page.deals.map(d => [d.flashcardValuation.gates.some(isListingDataCheck) ? 1 : 0, order.indexOf(d.flashcardValuation.dealVerdict), d.uapPricePerBuildableZfa]);
    assert.ok(keys.some(([check]) => check) && keys.some(([check]) => !check), `both kinds seeded ${JSON.stringify(keys)}`);
    for (let i = 1; i < keys.length; i++) {
      const [ca, a, pa] = keys[i - 1], [cb, b, pb] = keys[i];
      assert.ok(ca < cb || (ca === cb && (a < b || (a === b && pa <= pb))), `rank ${JSON.stringify(keys)}`);
    }
    const pins = store.searchDealsPage({sortBy: 'best_deal', minUnusedZfa: 0, pins: true});
    assert.equal(pins.total, 4);
    assert.deepEqual(pins.pins.id, page.deals.map(d => d.id), 'pins come in the same rank order');
    for (const p of pinRows(pins.pins)) {
      assert.ok(Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
      assert.ok(p.address && p.dealVerdict);
    }
    const one = store.searchDealsPage({listingId: page.deals[0].id, includeSimilarComps: true});
    assert.equal(one.total, 1);
    assert.equal(one.deals[0].id, page.deals[0].id);
    assert.ok(Array.isArray(one.deals[0].similarComps));
  } finally {
    cleanup();
  }
});

test('a sync calls the listing bridge per location, with a full whole-lot for-sale pull beside the capped one', async () => {
  const {store, cleanup} = await seededStore();
  try {
    const calls = [];
    const summary = await store.syncMarket({
      locations: ['Bronx, NY', 'Staten Island, NY'],
      enrichPluto: false,
      bridgeRunner: async payload => {
        calls.push([payload.locations[0], payload.listingTypes.join('+'), payload.limit, payload.propertyTypes?.length ?? 0]);
        return {allRows: [], errors: {[`for_sale:${payload.locations[0]}`]: 'none'}};
      },
    });
    assert.deepEqual(calls, [
      ['Bronx, NY', 'for_sale+sold+for_rent', 300, 6], ['Bronx, NY', 'for_sale', FULL_PULL_LIMIT, WHOLE_LOT_PROPERTY_TYPES.length],
      ['Staten Island, NY', 'for_sale+sold+for_rent', 300, 6], ['Staten Island, NY', 'for_sale', FULL_PULL_LIMIT, WHOLE_LOT_PROPERTY_TYPES.length],
    ]);
    assert.deepEqual(summary.wholeLotsForSaleFetched, {'Bronx, NY': 0, 'Staten Island, NY': 0});
    // Turned off, or with no for-sale listings requested, only the capped pull runs.
    calls.length = 0;
    await store.syncMarket({locations: ['Bronx, NY'], enrichPluto: false, fullForSalePull: false, bridgeRunner: async payload => { calls.push(payload.listingTypes.join('+')); return {allRows: []}; }});
    await store.syncMarket({locations: ['Bronx, NY'], listingTypes: ['sold'], enrichPluto: false, bridgeRunner: async payload => { calls.push(payload.listingTypes.join('+')); return {allRows: []}; }});
    assert.deepEqual(calls, ['for_sale+sold+for_rent', 'sold']);
    assert.deepEqual(Object.keys(summary.errors), ['for_sale:Bronx, NY', 'for_sale:Staten Island, NY']);
    // A borough whose scrape fails is reported; the others are still ingested.
    const partial = await store.syncMarket({
      locations: ['Queens, NY', 'Staten Island, NY'],
      enrichPluto: false,
      bridgeRunner: async payload => {
        if (payload.locations[0] === 'Staten Island, NY') throw new Error('timed out');
        return {allRows: [{propertyId: 'q-1', listingType: 'for_sale', address: '1 Main St, Queens, NY 11354', city: 'Queens', state: 'NY', zipCode: '11354', listPrice: 900000}]};
      },
    });
    assert.equal(partial.insertedCount, 1);
    assert.equal(partial.errors['Staten Island, NY'], 'timed out');
    await assert.rejects(store.syncMarket({locations: ['Bronx, NY'], enrichPluto: false, bridgeRunner: async () => ({error: 'blocked'})}), /blocked/);
  } finally {
    cleanup();
  }
});

test('the research service serves pins and one listing with its comparables', async () => {
  const {dbPath, cleanup} = await seededStore();
  const dir = mkdtempSync(join(tmpdir(), 'acres-listings-chat-'));
  const previous = process.env.ACRES_DEAL_STORE_ENABLED;
  process.env.ACRES_DEAL_STORE_ENABLED = 'true';
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 't'}, store: new ChatStore(join(dir, 'chat.sqlite')), maps: null, marketStoreFactory: () => new MarketStore(dbPath)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization: 'Bearer t', 'x-acres-account': 'a'.repeat(24), 'x-acres-email': 'someone@example.com'};
  try {
    const pins = await (await fetch(`${base}/market-store/deals/pins?minUnusedZfa=0&minListPrice=100000&sortBy=best_deal`, {headers})).json();
    assert.equal(pins.total, 3);
    const page = await (await fetch(`${base}/market-store/deals?minUnusedZfa=0&styles=land&bounds=40.6,-74.1,40.8,-73.9&limit=5`, {headers})).json();
    assert.deepEqual(page.deals.map(d => d.style), ['land']);
    const detail = await (await fetch(`${base}/market-store/deals/${encodeURIComponent(pins.pins.id[0])}`, {headers})).json();
    assert.equal(detail.deal.id, pins.pins.id[0]);
    assert.ok(Array.isArray(detail.deal.similarComps));
    assert.equal((await fetch(`${base}/market-store/deals/nope`, {headers})).status, 404);
  } finally {
    if (previous === undefined) delete process.env.ACRES_DEAL_STORE_ENABLED;
    else process.env.ACRES_DEAL_STORE_ENABLED = previous;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
    cleanup();
  }
});

test('a question sent with a page note keeps the question as the conversation title', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-listings-title-'));
  const chat = new ChatStore(join(dir, 'chat.sqlite'));
  try {
    const account = 'b'.repeat(24);
    const conversation = chat.createConversation(account);
    chat.createRun(account, conversation.id, '[Deals page: 12 NYC listings for sale (Brooklyn).]\n\nWhich of these has the most room to build?');
    assert.equal(chat.list(account, '').find(c => c.id === conversation.id).title, 'Which of these has the most room to build?');
  } finally {
    chat.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the answer carries the filters of the deal store search the run made', () => {
  const filters = {borough: 'Brooklyn', dealVerdict: 'great_deal,good_deal', maxListPrice: 3000000};
  const out = aggregate([{status: 'completed', tools: {}, aux: {marketTools: {deals: {filters}}}}]);
  assert.deepEqual(out.dealSearch, filters);
  assert.equal(aggregate([{status: 'completed', tools: {}, aux: {}}]).dealSearch, null);
});

test('lot width and depth, buildable area and project cost narrow the listings', async () => {
  const {store, cleanup} = await seededStore();
  try {
    const all = {minUnusedZfa: 0, includeSimilarComps: false};
    for (const [street, front, depth] of [['101 Kent Ave', 40, 100], ['202 Kent Ave', 25, 100], ['303 Court St', 60, 100], ['404 Court St', 30, 120]]) {
      store.write('UPDATE market_listings SET pluto_lot_front=?, pluto_lot_depth=? WHERE address LIKE ?', front, depth, `${street}%`);
    }
    assert.deepEqual(ids(store.searchDealsPage({...all, minLotFront: 30, maxLotFront: 45})).sort(), ['101 Kent Ave', '404 Court St']);
    assert.deepEqual(ids(store.searchDealsPage({...all, minLotDepth: 110})), ['404 Court St']);
    assert.deepEqual(ids(store.searchDealsPage({...all, maxLotDepth: 100})).sort(), ['101 Kent Ave', '202 Kent Ave', '303 Court St']);
    // Buildable is the larger envelope: 303 Court St allows 6,000 SF x 3.9 = 23,400 SF.
    assert.deepEqual(ids(store.searchDealsPage({...all, minBuildableZfa: 20000})), ['303 Court St']);
    // Project cost is the ask plus the construction cost at the request's costs.
    const deals = store.searchDealsPage(all).deals;
    const cost = Object.fromEntries(deals.map(d => [d.address.split(',')[0], d.listPrice + (d.estimatedConstructionCost || 0)]));
    const middle = Object.values(cost).sort((a, b) => a - b)[1];
    const below = ids(store.searchDealsPage({...all, maxProjectCost: middle})).sort();
    assert.deepEqual(below, Object.keys(cost).filter(k => cost[k] <= middle).sort());
    assert.deepEqual(ids(store.searchDealsPage({...all, minProjectCost: middle + 1})).sort(), Object.keys(cost).filter(k => cost[k] > middle).sort());
    // A cheaper cost profile lowers the construction cost, so more projects fit under the same cap.
    const cheaper = store.searchDealsPage({...all, maxProjectCost: middle, customSettings: {hardCostPerGrossSqft: 150}}).total;
    assert.ok(cheaper >= below.length);
    // A listing with no ask is figured at its good-deal land threshold, so the cost filter keeps it
    // when that project cost fits and drops it when it does not.
    store.write("UPDATE market_listings SET list_price=NULL WHERE address LIKE '101 Kent Ave%'");
    const unpriced = store.searchDealsPage(all).deals.find(d => d.address.startsWith('101 Kent Ave'));
    const unpricedCost = unpriced.flashcardValuation.slidingScalePricePerBsf.goodDealMaxLandValue + unpriced.estimatedConstructionCost;
    assert.ok(unpricedCost > 0, 'the unpriced row carries a threshold and a construction cost');
    assert.ok(ids(store.searchDealsPage({...all, maxProjectCost: unpricedCost})).includes('101 Kent Ave'));
    assert.ok(!ids(store.searchDealsPage({...all, maxProjectCost: unpricedCost - 1})).includes('101 Kent Ave'));
  } finally { cleanup(); }
});
