import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from './market-store.mjs';
import {createMarketTools} from './market.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-rollup-refresh-')), path = join(dir, 'market.sqlite');
  const store = new MarketStore(path);
  t.after(() => {store.close();rmSync(dir, {recursive: true});});
  return {store, path};
}

function rental(propertyId, zipCode, listPrice = 2000) {
  return {propertyId, zipCode, listingType: 'for_rent', address: propertyId + ' Test Street', city: 'Brooklyn', state: 'NY', beds: 1, sqft: 1000, listPrice, rentPerSqftPerMonth: listPrice / 1000};
}

function tableState(store) {
  return Object.fromEntries(store.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(({name}) => [name, store.query(`SELECT * FROM ${name} ORDER BY rowid`)]));
}

test('price refreshes that omit the ZIP update the retained ZIP summary and persist after reopening', t => {
  const {store, path} = fixture(t);
  store.ingestListings([rental('retained', '11201')], 1000);
  for (const [index, zip] of [undefined, null, ''].entries()) {
    const price = 3000 + index * 1000, time = 2000 + index;
    const result = store.ingestListings([rental('retained', zip, price)], time);
    assert.deepEqual(result, {inserted: 0, updated: 1, rollupsUpdated: 1, touchedZips: ['11201']});
    const summary = store.getZipRollup('11201');
    assert.equal(summary.byBedrooms['1'].medianMonthlyRent, price);
    assert.equal(summary.devMetrics.blendedRentPsfMonth, price / 1000);
    assert.equal(summary.updatedAt, time);
  }
  const reopened = new MarketStore(path);
  try {
    assert.equal(reopened.getZipRollup('11201').byBedrooms['1'].medianMonthlyRent, 5000);
    const listing = reopened.one('SELECT zip_code,first_seen_at,last_seen_at,price_history_json FROM market_listings WHERE id=?', 'retained:for_rent');
    assert.equal(listing.zip_code, '11201');assert.equal(listing.first_seen_at, 1000);assert.equal(listing.last_seen_at, 2002);
    assert.equal(JSON.parse(listing.price_history_json).length, 4);
  } finally {reopened.close();}
});

test('a ZIP correction recomputes both populations and leaves unrelated market data untouched', t => {
  const {store} = fixture(t);
  store.ingestListings([rental('moving', '11201', 2000), rental('remaining', '11201', 6000), rental('destination', '11215', 8000), rental('unrelated', '11385', 10000)], 1000);
  const control = store.getZipRollup('11385'), unrelated = store.one('SELECT * FROM market_listings WHERE id=?', 'unrelated:for_rent');
  const result = store.ingestListings([rental('moving', ' 11215 ', 4000)], 2000);
  assert.deepEqual(result.touchedZips, ['11201', '11215']);assert.equal(result.rollupsUpdated, 2);
  const old = store.getZipRollup('11201'), next = store.getZipRollup('11215');
  assert.equal(old.sampleCount, 1);assert.equal(old.byBedrooms['1'].medianMonthlyRent, 6000);
  assert.equal(next.sampleCount, 2);assert.equal(next.byBedrooms['1'].medianMonthlyRent, 6000);
  assert.equal(old.updatedAt, 2000);assert.equal(next.updatedAt, 2000);
  assert.deepEqual(store.getZipRollup('11385'), control);assert.deepEqual(store.one('SELECT * FROM market_listings WHERE id=?', 'unrelated:for_rent'), unrelated);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM market_listings').n, 4);
});

test('moving the last ZIP listing removes its cache and the real comp handler cannot reuse phantom evidence', async t => {
  const {store} = fixture(t);
  store.ingestListings([rental('moving', '11201')], 1000);
  store.ingestListings([rental('moving', '11215', 4000)], 2000);
  assert.equal(store.getZipRollup('11201'), null);
  const records = [], tools = createMarketTools({marketStore: store, dealStoreAccess: {read: true, sync: false}, getProperty: () => ({}), record: row => {records.push(row);return {id: records.length};}, emit: () => {}, compRunner: async () => {throw new Error('Controlled provider unavailable');}});
  await assert.rejects(tools.handlers.acres_market_comps({location: '11201'}), /Controlled provider unavailable/);
  const out = await tools.handlers.acres_market_comps({location: '11215'});
  assert.equal(out.provenance.source, 'market-store-cache');assert.equal(out.provenance.referenceOnly, true);
  assert.equal(out.totalComps, 1);assert.equal(out.byBedrooms['1'].medianRentPerSqftPerMonth, 4);
  assert.equal(out.autoRecordedMarket, false);assert.equal(records.length, 0);
});

test('several corrections of one listing in a batch leave only the final ZIP populated', t => {
  const {store} = fixture(t);
  store.ingestListings([rental('moving', '11201'), rental('control', '11385')], 1000);
  const control = store.getZipRollup('11385');
  const result = store.ingestListings([rental('moving', '11215', 3000), rental('moving', '11217', 4000), rental('moving', null, 5000)], 2000);
  assert.deepEqual(result.touchedZips, ['11201', '11215', '11217']);assert.equal(result.rollupsUpdated, 3);
  assert.equal(store.getZipRollup('11201'), null);assert.equal(store.getZipRollup('11215'), null);
  const summary = store.getZipRollup('11217');assert.equal(summary.sampleCount, 1);assert.equal(summary.byBedrooms['1'].medianMonthlyRent, 5000);
  assert.deepEqual(store.getZipRollup('11385'), control);
});

test('a real SQLite summary-write failure rolls back the entire listing batch and its other summaries', t => {
  const {store} = fixture(t);
  store.ingestListings([rental('moving', '11201'), rental('destination', '11215', 3000)], 1000);
  const before = tableState(store);
  store.db.exec("CREATE TRIGGER refuse_summary BEFORE INSERT ON market_submarket_rollups WHEN NEW.scope_key='zip:11215' BEGIN SELECT RAISE(ABORT, 'Controlled summary failure'); END;");
  assert.throws(() => store.ingestListings([rental('new', '11217', 5000), rental('moving', '11215', 4000)], 2000), /Controlled summary failure/);
  assert.deepEqual(tableState(store), before, 'No new listing, moved listing or previously processed ZIP summary may survive the failed batch');
  store.db.exec('DROP TRIGGER refuse_summary');
  store.ingestListings([rental('moving', '11215', 4000)], 3000);
  assert.equal(store.getZipRollup('11201'), null);assert.equal(store.getZipRollup('11215').sampleCount, 2);
});
