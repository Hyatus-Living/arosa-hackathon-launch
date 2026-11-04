import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRentStabilizedCsv} from './rent-stabilized-units.mjs';
import {MarketStore, computeRentStabilizationProfile} from './market-store.mjs';
import {fetchNycPublicRecords} from './nycdb.mjs';

const CSV = ['ucbbl,uc2018,pdfsoa2018,uc2019,pdfsoa2019,uc2024,pdfsoa2024',
  '3001000010,12,https://x/soa-2018.pdf,12,https://x/soa-2019.pdf,11,https://x/soa-2024.pdf',
  '3001000020,6,https://x/b-2018.pdf,6,https://x/b-2019.pdf,,',
  '3001000030,0,,0,,0,https://x/c-2024.pdf',
  'bad,1,,1,,1,'].join('\n');

test('the CSV parses to the latest year with a stated count per lot', () => {
  const {rows, years} = parseRentStabilizedCsv(CSV);
  assert.deepEqual(years, [2024, 2019, 2018]);
  assert.deepEqual(rows, [
    {bbl: '3001000010', units: 11, year: 2024, statementUrl: 'https://x/soa-2024.pdf'},
    {bbl: '3001000020', units: 6, year: 2019, statementUrl: 'https://x/b-2019.pdf'},
    {bbl: '3001000030', units: 0, year: 2024, statementUrl: 'https://x/c-2024.pdf'},
  ]);
});

test('a registered count makes the tenant screen high with the year; zero stays on the other signals', () => {
  const high = computeRentStabilizationProfile({unitsRes: 4, yearBuilt: 1990, rentStabilizedUnits: 11, rentStabilizedYear: 2024});
  assert.equal(high.riskLevel, 'high');
  assert.deepEqual([high.estStabilizedUnits, high.rentStabilizedYear], [11, 2024]);
  assert.ok(high.reasons.some(f => /11 rent-stabilized units registered with HCR per the 2024 DOF statement of account/.test(f)));
  const zero = computeRentStabilizationProfile({unitsRes: 4, yearBuilt: 1990, rentStabilizedUnits: 0, rentStabilizedYear: 2024, hpdRegistrationCheckedAt: 1});
  assert.equal(zero.riskLevel, 'low');
  assert.ok(zero.reasons.some(f => /lists no rent-stabilized units; owner filings can lag/.test(f)));
  assert.equal(computeRentStabilizationProfile({unitsRes: 8, yearBuilt: 1960}).riskLevel, 'high');
});

test('the store keeps a monthly copy, stamps every matched lot, revalues it and serves the subject lookup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-rentstab-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = n => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${n} Court St, Brooklyn, NY 11231`, city: 'Brooklyn', state: 'NY', zipCode: '11231', latitude: 40.68, longitude: -73.99, listPrice: 2000000, style: 'multi_family', assetClass: 'townhouse_single_family', isDevelopmentCandidate: true});
  store.ingestListings([row(1), row(2)], Date.now());
  for (const n of [1, 2]) store.write("UPDATE market_listings SET bbl = ?, pluto_lot_area = 2500, pluto_bldg_area = 6000, units_res = 4, year_built = 1990, resid_far = 2, aff_res_far = 2.4 WHERE property_id = ?", (n === 1 ? "3001000010" : "3001000099"), `p-${n}`);
  let fetches = 0;
  const fetcher = async () => { fetches++; return parseRentStabilizedCsv(CSV); };
  const first = await store.backfillRentStabilizedUnits({fetcher, now: 1_700_000_000_000});
  assert.deepEqual([first.checked, first.withUnits, first.source.skipped, fetches], [2, 1, false, 1]);
  const rows = store.query('SELECT property_id, rent_stabilized_units u, rent_stabilized_year y, deal_verdict v FROM market_listings ORDER BY property_id');
  assert.deepEqual(rows.map(r => [r.property_id, r.u, r.y]), [['p-1', 11, 2024], ['p-2', null, null]]);
  const deal = store.searchDeals({minUnusedZfa: 0}).find(d => d.propertyId === 'p-1');
  assert.deepEqual([deal.rentStabilizedUnits, deal.rentStabilizedYear], [11, 2024]);
  assert.ok(deal.flashcardValuation.gates.some(g => g.id === 'tenants' && g.severity === 'restrict'));
  // Within a month the copy is reused and already-stamped lots are left alone.
  const second = await store.backfillRentStabilizedUnits({fetcher, now: 1_700_000_000_000 + 86400000});
  assert.deepEqual([second.checked, second.source.skipped, fetches], [0, true, 1]);
  // A failed download keeps the copy.
  await assert.rejects(store.syncRentStabilizedUnits({fetcher: async () => { throw new Error('offline'); }, now: 1_700_000_000_000 + 40 * 86400000}), /offline/);
  assert.equal(store.lookupRentStabilizedUnits('3001000010').units, 11);
  assert.equal(store.lookupRentStabilizedUnits('3001000099'), null);
});

test('the public-records tool reports the registered count with its statement, or says the lot is absent', async () => {
  const stub = async () => [];
  const recorded = [];
  const withCount = await fetchNycPublicRecords({bbl: '3001000010'}, {request: stub, record: s => { recorded.push(s); return {id: recorded.length}; }, rentStabilizedLookup: async () => ({units: 11, year: 2024, statementUrl: 'https://x/soa-2024.pdf'})});
  assert.deepEqual([withCount.rentStabilizedUnits.status, withCount.rentStabilizedUnits.units, withCount.rentStabilizedUnits.year], ['ok', 11, 2024]);
  assert.match(withCount.proseReportingMandate, /11 rent-stabilized unit\(s\) registered with HCR per the 2024 DOF statement of account/);
  assert.ok(recorded.some(s => s.url === 'https://x/soa-2024.pdf'));
  const absent = await fetchNycPublicRecords({bbl: '3001000099'}, {request: stub, rentStabilizedLookup: async () => null});
  assert.equal(absent.rentStabilizedUnits.status, 'none');
  assert.match(absent.proseReportingMandate, /no entry for this lot; say so rather than reporting zero/);
  const none = await fetchNycPublicRecords({bbl: '3001000099'}, {request: stub});
  assert.equal(none.rentStabilizedUnits.status, 'unavailable');
});

test('the research host installer ships the rent-stabilized module', () => {
  assert.match(readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8'), /\brent-stabilized-units\.mjs\b/);
});
