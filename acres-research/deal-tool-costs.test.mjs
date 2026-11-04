// Explicit operator configuration for this isolated test deployment.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createMarketTools} from './market.mjs';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {COST_KEYS, FILTER_SCHEMA} from './listing-filter-schema.mjs';
import {priceFixture} from './testing/comparable-price.mjs';

const query = {minUnusedZfa: 0, sortBy: 'best_deal', syncIfEmpty: false};
const costs = deal => Object.fromEntries(deal.flashcardValuation.basis.filter(row => COST_KEYS.includes(row.item)).map(row => [row.item, row.value]));
const financials = deals => deals.map(deal => ({id: deal.id, costs: costs(deal), construction: deal.estimatedConstructionCost, yield: deal.flashcardValuation.impliedYieldOnCostPct, margin: deal.flashcardValuation.impliedCondoMarginPct, verdict: deal.flashcardValuation.dealVerdict}));
const baseline = store => Object.fromEntries(COST_KEYS.map(key => [key, store.getAdminConfig().dealSettings[key]]));
const digests = store => Object.fromEntries(store.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({name}) => [name, createHash('sha256').update(JSON.stringify(store.query(`SELECT * FROM ${name} ORDER BY rowid`))).digest('hex')]));
function fixture(t) {
  const f = priceFixture(t), records = [];
  f.add('lower-ask', {listPrice: 1000000});f.add('higher-ask', {listPrice: 6000000});
  const tools = createMarketTools({marketStore: f.store, dealStoreAccess: {read: true, sync: false}, record: row => {records.push(row);return {id: records.length};}});
  return {...f, tools, records, search: overrides => tools.handlers.acres_search_deal_store({...query, ...overrides})};
}

test('the research search schema exposes the four canonical cost fields, ranges, nulls and precision', t => {
  const f = fixture(t), properties = f.tools.definitions.find(tool => tool.name === 'acres_search_deal_store').inputSchema.properties;
  for (const key of COST_KEYS) {
    const field = properties[key], canonical = FILTER_SCHEMA.properties[key];assert.ok(field, key);
    for (const property of ['type', 'minimum', 'maximum', 'multipleOf', 'default']) assert.deepEqual(field[property], canonical[property], `${key}.${property}`);
  }
});

test('explicit zero soft and carry fractions each reach the returned valuation without becoming defaults', async t => {
  const f = fixture(t), defaults = baseline(f.store);
  for (const overrides of [{softCostPctOfHard: 0}, {carryAndFinancingPct: 0}, {softCostPctOfHard: 0, carryAndFinancingPct: 0}]) {
    const out = await f.search(overrides);assert.equal(out.deals.length, 3);
    for (const deal of out.deals) assert.deepEqual(costs(deal), {...defaults, ...overrides});
  }
});

test('a gross-factor-only request changes construction calculations and matches the owning store', async t => {
  const f = fixture(t), original = await f.search({}), out = await f.search({zfaToGrossFactor: 1.3});
  const direct = f.store.searchDeals({...query, customSettings: {zfaToGrossFactor: 1.3}});
  assert.deepEqual(financials(out.deals), financials(direct));assert.ok(out.deals.every(deal => costs(deal).zfaToGrossFactor === 1.3));
  assert.notDeepEqual(out.deals.map(deal => deal.estimatedConstructionCost), original.deals.map(deal => deal.estimatedConstructionCost));
});

test('normalized cost precision is echoed and recorded without mutating the requested arguments', async t => {
  const f = fixture(t), args = {...query, hardCostPerGrossSqft: 478.49, softCostPctOfHard: .1234, carryAndFinancingPct: .0784, zfaToGrossFactor: 1.23456}, before = structuredClone(args);
  const out = await f.tools.handlers.acres_search_deal_store(args), expected = {hardCostPerGrossSqft: 478, condoHardCostPerGrossSqft: 478, softCostPctOfHard: .123, carryAndFinancingPct: .078, zfaToGrossFactor: 1.235}; // a named hard cost prices both exits
  assert.deepEqual(args, before);
  for (const key of COST_KEYS) assert.equal(out.filters[key], expected[key]);
  assert.deepEqual(costs(out.deals[0]), expected);
  const recorded = JSON.parse(f.records.at(-1).text);for (const key of COST_KEYS) assert.equal(recorded.filters[key], expected[key]);
});

test('canonical boundary values work and out-of-contract values fail before opening the store', async t => {
  const f = fixture(t);
  for (const overrides of [{hardCostPerGrossSqft: 100, softCostPctOfHard: 0, carryAndFinancingPct: 0, zfaToGrossFactor: 1}, {hardCostPerGrossSqft: 2500, softCostPctOfHard: 1, carryAndFinancingPct: 1, zfaToGrossFactor: 1.5}]) {
    const out = await f.search(overrides);assert.deepEqual(costs(out.deals[0]), {...overrides, condoHardCostPerGrossSqft: overrides.hardCostPerGrossSqft});
  }
  let opened = 0;
  const tools = createMarketTools({marketStoreFactory: () => {opened++;return new MarketStore(f.path);}, dealStoreAccess: {read: true, sync: false}});
  const before = digests(f.store);
  for (const invalid of [{hardCostPerGrossSqft: 99}, {hardCostPerGrossSqft: 2501}, {hardCostPerGrossSqft: '500'}, {softCostPctOfHard: -.001}, {softCostPctOfHard: 1.001}, {carryAndFinancingPct: Infinity}, {carryAndFinancingPct: NaN}, {zfaToGrossFactor: .999}, {zfaToGrossFactor: 1.501}]) await assert.rejects(tools.handlers.acres_search_deal_store({...query, ...invalid}), /Invalid cost/);
  assert.equal(opened, 0);assert.deepEqual(digests(f.store), before);
});

test('the actual deals HTTP API and research tool use identical explicit cost assumptions and financials', async t => {
  const cleanup = [], f = fixture({after: fn => cleanup.push(fn)}), chat = new ChatStore(join(f.dir, 'chat.sqlite'));
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'controlled-deal-costs'}, store: chat, maps: null, marketStoreFactory: () => new MarketStore(f.path)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));chat.close();cleanup.forEach(fn => fn());});
  const overrides = {hardCostPerGrossSqft: 500, softCostPctOfHard: 0, carryAndFinancingPct: 0, zfaToGrossFactor: 1.3}, before = digests(f.store);
  const params = new URLSearchParams({...query, ...overrides, includeSimilarComps: false});
  const response = await fetch(`http://127.0.0.1:${server.address().port}/market-store/deals?${params}`, {headers: {authorization: 'Bearer controlled-deal-costs', 'x-acres-account': 'a'.repeat(24), 'x-acres-email': 'alex@witharosa.ai'}});
  assert.equal(response.status, 200);const page = await response.json(), out = await f.search(overrides);
  assert.deepEqual(financials(out.deals), financials(page.deals));assert.deepEqual(costs(out.deals[0]), {...overrides, condoHardCostPerGrossSqft: overrides.hardCostPerGrossSqft});assert.deepEqual(digests(f.store), before);
});

test('null and omitted costs preserve the configured store baseline without saving overrides', async t => {
  const f = fixture(t), before = digests(f.store), defaults = baseline(f.store), initial = await f.search({});
  const out = await f.search(Object.fromEntries(COST_KEYS.map(key => [key, null])));
  assert.deepEqual(financials(out.deals), financials(initial.deals));assert.deepEqual(costs(out.deals[0]), defaults);assert.deepEqual(digests(f.store), before);
});
