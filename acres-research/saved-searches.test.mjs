import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {FILTER_SCHEMA_ID, defaultFilterValues} from './listing-filter-schema.mjs';

const costs = {hardCostPerGrossSqft: 425, softCostPctOfHard: 0, carryAndFinancingPct: .12, zfaToGrossFactor: 1.2};
const search = (values = {}, bounds = {south: 40.67, west: -73.99, north: 40.72, east: -73.94}) => ({schema: FILTER_SCHEMA_ID, values: {...defaultFilterValues(), borough: 'BK', minPrice: null, maxPrice: 2000000, tiers: ['unpriced_opportunity'], ...costs, ...values}, bounds, condoHardCostPerGrossSqft: 575});
const owner = 'a'.repeat(24), other = 'b'.repeat(24);

function storeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-saved-searches-')), path = join(dir, 'market.sqlite');
  let store = new MarketStore(path);
  t.after(() => {store.close();rmSync(dir, {recursive: true});});
  return {dir, path, get store() {return store;}, reopen() {store.close();store = new MarketStore(path);}};
}

test('a named search keeps its filters, map area and costs per account, and can be renamed and deleted', t => {
  const f = storeFixture(t);
  const saved = f.store.createSavedSearch(owner, {name: '  Brooklyn under $2M  ', search: search()});
  assert.equal(saved.name, 'Brooklyn under $2M');assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(saved.search, search());
  f.store.createSavedSearch(owner, {name: 'Citywide land', search: search({types: ['land'], followMap: false}, null)});
  f.reopen();
  assert.deepEqual(f.store.listSavedSearches(owner).map(row => row.name), ['Brooklyn under $2M', 'Citywide land'], 'saved searches survive a restart, oldest first');
  assert.equal(f.store.listSavedSearches(owner)[1].search.bounds, null);
  assert.deepEqual(f.store.listSavedSearches(other), [], 'another account sees none');
  assert.throws(() => f.store.renameSavedSearch(other, saved.id, 'Mine now'), error => error.status === 404);
  assert.throws(() => f.store.deleteSavedSearch(other, saved.id), error => error.status === 404);
  const renamed = f.store.renameSavedSearch(owner, saved.id, 'Brooklyn deals');
  assert.equal(renamed.name, 'Brooklyn deals');assert.deepEqual(renamed.search, search());assert.ok(renamed.updatedAt >= saved.updatedAt);
  f.store.deleteSavedSearch(owner, saved.id);
  assert.deepEqual(f.store.listSavedSearches(owner).map(row => row.name), ['Citywide land']);
});

test('saving refuses a missing or duplicate name and an incomplete or invalid search, changing nothing', t => {
  const f = storeFixture(t);
  f.store.createSavedSearch(owner, {name: 'Brooklyn', search: search()});
  for (const name of ['', '   ', 'x'.repeat(81), 42]) assert.throws(() => f.store.createSavedSearch(owner, {name, search: search()}), /Name must be 1 to 80 characters/);
  assert.throws(() => f.store.createSavedSearch(owner, {name: 'brooklyn', search: search()}), error => error.status === 409 && /already have a saved search named/.test(error.message));
  assert.throws(() => f.store.createSavedSearch(owner, {name: 'No costs', search: search({hardCostPerGrossSqft: null})}), /complete cost assumptions/);
  assert.throws(() => f.store.createSavedSearch(owner, {name: 'Bad tier', search: search({tiers: ['bargain']})}), /Invalid filter: tiers/);
  assert.throws(() => f.store.createSavedSearch(owner, {name: 'Mixed', search: search({area: '11201, Williamsburg'})}), /"Williamsburg" is not a ZIP code/);
  assert.throws(() => f.store.createSavedSearch(owner, {name: 'Old', search: {...search(), schema: 'acres.listing-filters/0'}}), /Unsupported search/);
  f.store.createSavedSearch(owner, {name: 'Queens', search: search({borough: 'QN'})});
  assert.throws(() => f.store.renameSavedSearch(owner, f.store.listSavedSearches(owner)[1].id, 'BROOKLYN'), error => error.status === 409);
  assert.deepEqual(f.store.listSavedSearches(owner).map(row => row.name), ['Brooklyn', 'Queens']);
});

test('a search recorded before newer filters joined the schema still applies, missing filters at their defaults', t => {
  const f = storeFixture(t);
  const stale = search();
  delete stale.values.mih;
  delete stale.values.maxProjectCost;
  delete stale.values.excludeLandmarks;
  const saved = f.store.createSavedSearch(owner, {name: 'Recorded earlier', search: stale});
  assert.deepEqual(saved.search, search(), 'missing keys come back at schema defaults, the rest kept as recorded');
  const current = f.store.listSavedSearches(owner)[0];
  assert.deepEqual(current.search, search());
});

test('the saved-search routes act for the signed-in account only', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-saved-search-http-')), chat = new ChatStore(join(dir, 'chat.sqlite'));
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store: chat, maps: null, marketStoreFactory: () => new MarketStore(join(dir, 'market.sqlite'))});
  const previous = process.env.ACRES_DEAL_STORE_ENABLED;process.env.ACRES_DEAL_STORE_ENABLED = 'true';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (previous === undefined) delete process.env.ACRES_DEAL_STORE_ENABLED;else process.env.ACRES_DEAL_STORE_ENABLED = previous;
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));chat.close();rmSync(dir, {recursive: true});
  });
  const api = (account, path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/market-store/saved-searches${path}`, {method, headers: {authorization: 'Bearer test', 'x-acres-account': account, 'x-acres-email': 'reader@example.com', 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  const created = await api(owner, '', 'POST', {name: 'Brooklyn', search: search()});
  assert.equal(created.status, 201);const saved = await created.json();assert.deepEqual(saved.search, search());
  assert.deepEqual((await (await api(owner, '')).json()).searches.map(row => row.id), [saved.id]);
  assert.deepEqual((await (await api(other, '')).json()).searches, []);
  assert.equal((await api(owner, '', 'POST', {name: 'Brooklyn', search: search()})).status, 409);
  assert.equal((await api(owner, '', 'POST', {name: 'Bad', search: search({minPrice: -1})})).status, 400);
  assert.equal((await api(other, `/${saved.id}`, 'PATCH', {name: 'Taken'})).status, 404);
  const renamed = await api(owner, `/${saved.id}`, 'PATCH', {name: 'Brooklyn deals'});
  assert.equal(renamed.status, 200);assert.equal((await renamed.json()).name, 'Brooklyn deals');
  assert.equal((await api(other, `/${saved.id}`, 'DELETE')).status, 404);
  assert.equal((await api(owner, `/${saved.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await (await api(owner, '')).json()).searches, []);
});

test('the web server passes only the saved search name and search on to research', () => {
  const source = readFileSync(new URL('../app-starter/server.js', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/api\/market-store\/saved-searches',\(req,res\)=>proxy\(req,res,'\/market-store\/saved-searches'\)\);/);
  assert.match(source, /app\.post\('\/api\/market-store\/saved-searches',\(req,res\)=>proxy\(req,res,'\/market-store\/saved-searches',\{name:req\.body\.name,search:req\.body\.search\}\)\);/);
  assert.match(source, /app\.patch\('\/api\/market-store\/saved-searches\/:id',\(req,res\)=>proxy\(req,res,`\/market-store\/saved-searches\/\$\{encodeURIComponent\(req\.params\.id\)\}`,\{name:req\.body\.name\}\)\);/);
  assert.match(source, /app\.delete\('\/api\/market-store\/saved-searches\/:id',\(req,res\)=>proxy\(req,res,`\/market-store\/saved-searches\/\$\{encodeURIComponent\(req\.params\.id\)\}`\)\);/);
});
