import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketTools} from './market.mjs';
import {COST_KEYS, FILTER_SCHEMA, FILTER_SCHEMA_ID, defaultFilterValues, validateFilterSnapshot, acceptsFilterUpdate, listingSnapshotAfterUpdate} from './listing-filter-schema.mjs';
import {research} from './research.mjs';
import {priceFixture} from './testing/comparable-price.mjs';
import {queryParams} from '../app-starter/public/listings-model.js';

const box = {south: 40.69, west: -74, north: 40.71, east: -73.98};
const costs = {hardCostPerGrossSqft: 650, softCostPctOfHard: .3, carryAndFinancingPct: .15, zfaToGrossFactor: 1.4};
const snapshot = (values = {}) => ({schema: FILTER_SCHEMA_ID, revision: 7, values: {...defaultFilterValues(), ...values}, baselineCosts: {...costs}, map: {revision: 3, bounds: box, viewport: box}});
function capture(listingContext) {
  const queries = [], records = [];
  const marketStore = {searchDeals(query) {queries.push(query);return [{address: '1 Test St', url: 'https://example.com/1'}];}, getAdminConfig: () => ({dealSettings: {...costs}, syncConfig: {onDemandSyncIfEmpty: true}}), statusSummary: () => ({})};
  const tools = createMarketTools({listingContext, marketStore, dealStoreAccess: {read: true, sync: false}, record: row => {records.push(row);return {id: 1};}});
  return {queries, records, search: args => tools.handlers.acres_search_deal_store(args)};
}

test('native research inherits every listing criterion, map area, ranking and resolved cost assumption', async () => {
  const input = snapshot({borough: 'BK', area: '11201', minPrice: 0, maxPrice: 4000000, maxPpb: 700, minLot: 500, maxLot: 9000, zoning: 'R7', minFar: 1.25, tiers: ['good_deal', 'fair_deal'], types: ['multi_family', 'land'], excludeRisk: true, excludeLandmarks: true, sortBy: 'implied_yield_on_cost', softCostPctOfHard: 0});
  const before = structuredClone(input), f = capture(input), out = await f.search({limit: 20});
  assert.deepEqual(f.queries[0], {borough: 'BK', zipCode: null, area: '11201', zoningPrefix: 'R7', minListPrice: 0, maxListPrice: 4000000, maxPricePerBuildableZfa: 700, maxPricePerBuildableAnyUse: null, minLotArea: 500, maxLotArea: 9000, minBuildableZfa: null, minLotFront: null, maxLotFront: null, minLotDepth: null, maxLotDepth: null, minProjectCost: null, maxProjectCost: null, minHeadroomFar: 1.25, dealVerdict: 'good_deal,fair_deal', styles: ['multi_family', 'land'], excludeHighStabilizedRisk: true, excludeLandmarks: true, mihArea: null, sortBy: 'implied_yield_on_cost', minUnusedZfa: 250, listingType: 'for_sale', limit: 20, bounds: box, customSettings: {...costs, rentalHardCostPerGrossSqft: costs.hardCostPerGrossSqft, softCostPctOfHard: 0}});
  assert.deepEqual(input, before);
  assert.deepEqual(JSON.parse(f.records[0].text).filters, out.filters);
  assert.deepEqual(out.filters.bounds, box);assert.equal(out.filters.hardCostPerGrossSqft, 650);
});

test('an explicit independent search clears inherited criteria and map scope but keeps captured costs', async () => {
  const f = capture(snapshot({borough: 'QN', maxPrice: 1000000, types: ['land'], excludeRisk: true}));
  await f.search({useCurrentFilters: false, borough: 'BK', softCostPctOfHard: 0, sortBy: 'unused_uap_zfa'});
  const query = f.queries[0];
  assert.equal(query.borough, 'BK');assert.equal(query.maxListPrice, null);assert.equal(query.styles, null);assert.equal(query.excludeHighStabilizedRisk, false);assert.equal(query.bounds, null);
  assert.deepEqual(query.customSettings, {...costs, rentalHardCostPerGrossSqft: costs.hardCostPerGrossSqft, softCostPctOfHard: 0});assert.equal(query.sortBy, 'unused_uap_zfa');
});

test('explicit search arguments override inherited values, including false and zero', async () => {
  const f = capture(snapshot({minPrice: 500000, excludeRisk: true, excludeLandmarks: true, types: ['land']}));
  await f.search({minListPrice: 0, excludeHighStabilizedRisk: false, excludeLandmarks: false, styles: [], minUnusedZfa: 0, carryAndFinancingPct: 0});
  assert.equal(f.queries[0].minListPrice, 0);assert.equal(f.queries[0].excludeHighStabilizedRisk, false);assert.equal(f.queries[0].excludeLandmarks, false);assert.equal(f.queries[0].styles, null);assert.equal(f.queries[0].minUnusedZfa, 0);assert.equal(f.queries[0].customSettings.carryAndFinancingPct, 0);
});

test('unavailable captured cost assumptions fail before searching instead of silently using house costs', async () => {
  const input = snapshot();delete input.baselineCosts.hardCostPerGrossSqft;
  const f = capture(input);
  await assert.rejects(f.search({}), /captured.*hardCostPerGrossSqft/i);assert.equal(f.queries.length, 0);
  await f.search({hardCostPerGrossSqft: 500});assert.equal(f.queries[0].customSettings.hardCostPerGrossSqft, 500);
});

test('nonlisting research retains its existing search defaults', async () => {
  const f = capture(null);await f.search({});
  assert.equal(f.queries[0].minUnusedZfa, 500);assert.equal(f.queries[0].sortBy, 'uap_price_per_buildable_zfa');assert.equal(f.queries[0].customSettings, null);
});

test('explicit null cost resets use the captured baseline and snapshots remain immutable', async () => {
  const input = snapshot({hardCostPerGrossSqft: 800, softCostPctOfHard: .5}), f = capture(input);
  input.baselineCosts.hardCostPerGrossSqft = 100;input.values.maxPrice = 1;
  await f.search({hardCostPerGrossSqft: null, softCostPctOfHard: null});
  assert.equal(f.queries[0].customSettings.hardCostPerGrossSqft, 650);assert.equal(f.queries[0].customSettings.softCostPctOfHard, .3);assert.equal(f.queries[0].maxListPrice, null);
});

test('an empty listing-scoped search never starts a market sync by default', async () => {
  let syncs = 0;
  const tools = createMarketTools({listingContext: snapshot(), dealStoreAccess: {read: true, sync: true}, marketStore: {searchDeals: () => [], getAdminConfig: () => ({dealSettings: {...costs}, syncConfig: {onDemandSyncIfEmpty: true}}), statusSummary: () => ({}), syncMarket: async () => {syncs++;}}});
  await tools.handlers.acres_search_deal_store({});assert.equal(syncs, 0);
  await tools.handlers.acres_search_deal_store({syncIfEmpty: true});assert.equal(syncs, 1);
});

test('snapshot map metadata is canonical, read only, and participates in stale update detection', () => {
  const raw = snapshot(), saved = validateFilterSnapshot(raw);
  assert.deepEqual(saved.map, raw.map);assert.equal(Object.keys(saved.values).length, FILTER_SCHEMA.required.length);
  assert.equal(acceptsFilterUpdate(saved, {base: raw, values: raw.values}), true);
  assert.equal(acceptsFilterUpdate({...saved, map: {...saved.map, revision: 4}}, {base: raw, values: raw.values}), false);
  for (const map of [{...raw.map, revision: -1}, {...raw.map, bounds: {...box, south: '40'}}, {...raw.map, viewport: {...box, east: NaN}}]) assert.throws(() => validateFilterSnapshot({...raw, map}), /map/i);
  const legacy = {...raw};delete legacy.map;assert.equal(validateFilterSnapshot(legacy).map, undefined);
});

test('combined requests carry the resulting map scope, and legacy snapshots stay compatible', () => {
  const input = snapshot({borough: 'BK'}), other = {...box, south: 40.6};input.map.viewport = other;
  assert.deepEqual(listingSnapshotAfterUpdate(input, {...input.values, maxPrice: 2000000}).map.bounds, box);
  assert.equal(listingSnapshotAfterUpdate(input, {...input.values, borough: 'QN'}).map.bounds, null);
  assert.equal(listingSnapshotAfterUpdate(input, {...input.values, followMap: false}).map.bounds, null);
  input.values.followMap = false;input.map.bounds = null;
  assert.deepEqual(listingSnapshotAfterUpdate(input, {...input.values, followMap: true}).map.bounds, other);
  delete input.map;assert.equal(listingSnapshotAfterUpdate(input).map, undefined);
});

test('native MarketStore research matches the applied page query, scope, order and financials', async t => {
  const f = priceFixture(t), low = f.add('lower', {listPrice: 1000000}), outside = f.add('outside', {listPrice: 950000}), tiny = f.add('tiny', {listPrice: 60000});
  f.store.write('UPDATE market_listings SET latitude=40.8 WHERE id=?', outside);
  const input = snapshot({borough: 'BK', maxPrice: 4000000, sortBy: 'implied_yield_on_cost', ...costs});
  const p = queryParams(input.values, {bounds: box, costs});
  const expected = f.store.searchDeals({borough: p.get('borough'), minListPrice: Number(p.get('minListPrice')), maxListPrice: Number(p.get('maxListPrice')), minUnusedZfa: Number(p.get('minUnusedZfa')), sortBy: p.get('sortBy'), bounds: box, customSettings: costs, limit: 20});
  const tools = createMarketTools({listingContext: input, marketStore: f.store, dealStoreAccess: {read: true, sync: false}}), result = await tools.handlers.acres_search_deal_store({limit: 20});
  assert.deepEqual(result.deals.map(d => d.id), expected.map(d => d.id));assert.ok(result.deals.some(d => d.id === low));assert.ok(!result.deals.some(d => [outside, tiny].includes(d.id)));
  for (const [i, deal] of result.deals.entries()) {
    assert.deepEqual(Object.fromEntries(deal.flashcardValuation.basis.filter(row => COST_KEYS.includes(row.item)).map(row => [row.item, row.value])), {...costs, condoHardCostPerGrossSqft: costs.hardCostPerGrossSqft});
    assert.deepEqual(deal.flashcardValuation, expected[i].flashcardValuation);
  }
});

test('lead, spawned and fixed research lanes all use the same immutable listing context', async t => {
  const f = priceFixture(t), previous = process.env.ACRES_MARKET_DB;process.env.ACRES_MARKET_DB = f.path;
  t.after(() => {if (previous === undefined) delete process.env.ACRES_MARKET_DB;else process.env.ACRES_MARKET_DB = previous;});
  const input = snapshot({borough: 'BK', maxPrice: 4000000}), contexts = [];
  for (const mode of ['lead', 'lanes']) {
    let spawned = false;const results = [];
    const search = async execute => {const result = await execute('acres_search_deal_store', {limit: 20});results.push(result);return `Listed property [${result.sourceId}].`;};
    const result = await research({message: 'Compare NYC listed deals at my captured costs.', listingContext: input, dealStore: {read: true, sync: false}}, {RESEARCH_MODE: mode}, () => {}, () => {}, () => {}, async ({dynamicTools, execute}) => {
      if (dynamicTools.some(tool => tool.name === 'acres_spawn_lanes')) {
        const answer = await search(execute);const lanes = await execute('acres_spawn_lanes', {lanes: [{title: 'Current listing comparison', charter: 'Compare the captured listings and costs.', tools: ['acres_search_deal_store']}]});
        assert.equal(lanes.lanes[0].status, 'completed');spawned = true;return answer;
      }
      if (dynamicTools.some(tool => tool.name === 'acres_search_deal_store')) return search(execute);
      return 'Listing evidence [1].';
    });
    assert.ok(result.sources.length > 0);assert.equal(results.length, 2);if (mode === 'lead') assert.equal(spawned, true);
    for (const row of results) {assert.equal(row.deals.length, 1);assert.deepEqual(row.filters.bounds, box);for (const key of COST_KEYS) assert.equal(row.filters[key], costs[key]);contexts.push(row.filters);}
  }
  for (const context of contexts) assert.deepEqual(context, contexts[0]);
});
