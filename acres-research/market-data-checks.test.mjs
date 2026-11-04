import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MarketStore, listingDataChecks, computeDealValuation, normalizeSyncConfig} from './market-store.mjs';
import {planningCommand} from './planning.mjs';

const clean = {lot_sqft: 2500, pluto_lot_area: 2500, sqft: 3000, pluto_bldg_area: 3200, price_far_below_estimate: 0, street_line: '120 Kent Ave', borough: 'BK'};
const ids = r => listingDataChecks(r).map(c => c.id);

test('listing data checks flag listings whose price likely does not buy exactly this lot', () => {
  assert.deepEqual(ids(clean), []);
  assert.deepEqual(ids({...clean, lot_sqft: 4000}), ['data_lot_size']);
  assert.deepEqual(ids({...clean, lot_sqft: 3100}), [], 'within 25% of the city lot area');
  assert.deepEqual(ids({...clean, sqft: 600}), ['data_building_size']);
  assert.deepEqual(ids({...clean, price_far_below_estimate: 1}), ['data_price']);
  assert.deepEqual(ids({...clean, pluto_lot_area: 300000, lot_sqft: null}), ['data_large_lot']);
  assert.deepEqual(ids({...clean, street_line: '15-17 E 62nd St', borough: 'MN'}), ['data_address_range']);
  assert.deepEqual(ids({...clean, street_line: '91-03 95th St', borough: 'QN'}), [], 'a Queens hyphenated number is one address');
  assert.ok(listingDataChecks({...clean, lot_sqft: 4000}).every(c => c.severity === 'restrict' && c.label && c.detail));
});

test('a listing under contract for months, long on the market or long unchanged at its source may not offer its ask', () => {
  const now = Date.parse('2026-10-26');
  const days = n => new Date(now - n * 86400000).toISOString().slice(0, 10);
  const fresh = {...clean, mls_status: 'Active', list_date: days(30), last_update_date: days(5)};
  const stale = r => listingDataChecks(r, {now}).filter(c => c.id === 'data_stale').map(c => c.detail);
  assert.deepEqual(stale(fresh), []);
  assert.deepEqual(stale({...fresh, mls_status: 'Pending', pending_date: days(60)}), [], 'a contract of two months is ordinary');
  assert.deepEqual(stale({...fresh, mls_status: 'Pending', pending_date: '2019-09-19', list_date: '2019-02-14', last_update_date: '2021-09-23'}), ['It has been under contract since 2019-09-19, so the ask may no longer be on offer.']);
  assert.deepEqual(stale({...fresh, mls_status: 'under_contract', pending_date: days(120)}).length, 1);
  assert.deepEqual(stale({...fresh, list_date: '2024-05-06'}), ['It has been on the market since 2024-05-06; confirm the asking price is still current.']);
  assert.deepEqual(stale({...fresh, last_update_date: '2025-09-08'}), ['Its source has not updated it since 2025-09-08, so it may have been withdrawn; confirm it is still for sale.']);
  assert.deepEqual(stale({...clean, mls_status: 'active'}), [], 'a feed listing with no dates is not judged');
});

test('an ask far under what standing buildings of its kind sold for in its ZIP is held for confirmation', () => {
  const sales = {pricePerSqft: 400, saleCount: 50, kind: 'one to three family', zipCode: '11207', months: 24};
  const check = r => listingDataChecks(r, {buildingSales: sales}).filter(c => c.id === 'data_price_vs_building');
  assert.deepEqual(check({...clean, list_price: 1_000_000}), [], '$313 per SF of building is over half of $400');
  const [held] = check({...clean, list_price: 300_000});
  assert.equal(held.severity, 'restrict');
  assert.equal(held.detail, 'The ask is $94 per SF of building; 50 one to three family buildings in ZIP 11207 sold for a median of $400 per SF in the last 24 months. Confirm the price is current and buys the whole building.');
  assert.deepEqual(listingDataChecks({...clean, list_price: 300_000}).filter(c => c.id === 'data_price_vs_building'), [], 'no measure, no check');
  assert.deepEqual(check({...clean, list_price: 300_000, pluto_bldg_area: 0}), [], 'a vacant lot has no building to price');
});

test('the store measures standing-building sales by ZIP and kind, and classes the lot by its building class', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-building-sales-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const insert = store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, asset_class, unit, sqft, sold_price, sold_date, first_seen_at, last_seen_at)
    VALUES (?, 'sold', ?, '11207', 'BK', ?, ?, ?, ?, ?, 1, 1)`);
  for (const n of [1, 2, 3, 4]) insert.run(`s${n}`, `${n} Linden Blvd`, 'townhouse_single_family', null, 2000, 700000 + n * 50000, recent);
  insert.run('old', '9 Linden Blvd', 'townhouse_single_family', null, 2000, 100000, '2023-01-01');
  insert.run('unit', '10 Linden Blvd', 'townhouse_single_family', '2A', 1000, 100000, recent);
  insert.run('apt', '11 Linden Blvd', 'multifamily_building', null, 9000, 900000, recent);
  const lot = {zip_code: '11207', bldg_class: 'B2', asset_class: 'land_development'};
  assert.equal(store.buildingSalesFor(lot), null, 'four recent whole-building sales are too few');
  insert.run('s5', '5 Linden Blvd', 'townhouse_single_family', null, 2000, 950000, recent);
  assert.equal(store.buildingSalesFor(lot), null, 'five are still too few: no composite is published from fewer than six sales');
  insert.run('s6', '6 Linden Blvd', 'townhouse_single_family', null, 2000, 850000, recent);
  assert.deepEqual(store.buildingSalesFor(lot), {pricePerSqft: 425, saleCount: 6, kind: 'one to three family', zipCode: '11207', months: 24});
  assert.equal(store.buildingSalesFor({...lot, bldg_class: 'R4'}), null, 'a condo unit lot is not a standing building');
  assert.equal(store.buildingSalesFor({...lot, bldg_class: 'V0'}), null);
  assert.equal(store.buildingSalesFor({zip_code: '11207', bldg_class: null, asset_class: 'townhouse_single_family'}).saleCount, 6, 'the listing type stands in when the lot has no class');

  store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, asset_class, bldg_class, pluto_lot_area, pluto_lot_front, pluto_lot_depth,
    pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, landmark_flag, flood_zone, units_res, year_built, mls_status, list_date, last_update_date, first_seen_at, last_seen_at)
    VALUES ('a', 'for_sale', '1753 Linden Blvd', '11207', 'BK', '3043210001', 250000, 'townhouse_single_family', 'B1', 2500, 25, 100, '5', 1610, 2, 2.2, 'R5', 0, 0, 2, 1930, 'Active', ?, ?, 1, 1)`).run(recent, recent);
  const deal = store.searchDeals({listingId: 'a', minUnusedZfa: 0})[0];
  const gate = deal.flashcardValuation.gates.find(g => g.id === 'data_price_vs_building');
  assert.match(gate.detail, /^The ask is \$155 per SF of building; 6 one to three family buildings in ZIP 11207 sold for a median of \$425 per SF/);
  assert.ok(!['great_deal', 'good_deal'].includes(deal.flashcardValuation.dealVerdict));
});

test('a data check holds the rating at Fair and keeps the price-only verdict', () => {
  const base = {listPrice: 2_000_000, lotArea: 5000, lotFront: 50, lotDepth: 100, bldgArea: 0, residFar: 4, affResFar: 5, zoningDistrict: 'R7A', borough: 'BK', zipCode: '11249', submarketSalePsf: 1400, submarketRentPsf: 5.5};
  const free = computeDealValuation(base);
  assert.ok(['great_deal', 'good_deal'].includes(free.dealVerdict), free.dealVerdict);
  const flagged = computeDealValuation({...base, dataChecks: listingDataChecks({...clean, lot_sqft: 9000, pluto_lot_area: 5000})});
  assert.equal(flagged.dealVerdict, 'fair_deal');
  assert.equal(flagged.priceVerdict, free.priceVerdict);
  assert.ok(flagged.gates.some(g => g.id === 'data_lot_size'));
});

test('the full whole-lot pull is on by default and can be switched off', () => {
  assert.equal(normalizeSyncConfig({}).fullForSalePull, true);
  assert.equal(normalizeSyncConfig({fullForSalePull: false}).fullForSalePull, false);
});

test('ingest stores whether the asking price is far below the listing estimate, never the estimate', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-data-checks-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = flag => ({propertyId: `p-${flag}`, listingType: 'for_sale', address: `${flag ? 1 : 2} Kent Ave, Brooklyn, NY 11249`, city: 'Brooklyn', state: 'NY', zipCode: '11249', listPrice: 900000, style: 'multi_family', assetClass: 'townhouse_single_family', priceFarBelowEstimate: flag});
  store.ingestListings([row(true), row(false)], Date.UTC(2026, 9, 19));
  assert.deepEqual(store.query("SELECT property_id, price_far_below_estimate f FROM market_listings ORDER BY property_id").map(r => [r.property_id, r.f]), [['p-false', 0], ['p-true', 1]]);
  assert.ok(!store.query('PRAGMA table_info(market_listings)').some(c => /estimate_value|avm_estimate/.test(c.name)));
});

const {python} = planningCommand();
test('the bridge compares the asking price with the listing estimate', {skip: !existsSync(python)}, () => {
  const script = "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('bridge',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); c=json.load(sys.stdin); print(json.dumps([m.price_far_below_estimate(raw, price) for raw, price in c]))";
  const cases = [[{current_estimates: [{estimate: 1000000}]}, 150000], [{current_estimates: [{estimate: 1000000}]}, 250000], [{estimated_value: 2000000}, 300000], [{}, 300000]];
  const out = execFileSync(python, ['-c', script, fileURLToPath(new URL('./homeharvest-bridge.py', import.meta.url))], {input: JSON.stringify(cases), encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
  assert.deepEqual(JSON.parse(out), [true, false, true, null]);
});

test('the any-use FAR prices the lot at the highest FAR of any use and can rank and filter deals', t => {
  const val = computeDealValuation({listPrice: 1000000, lotArea: 2000, lotFront: 20, lotDepth: 100, bldgArea: 0, residFar: 2, affResFar: 2.4, commFar: 1, facilFar: 4, mnfFar: 5, zoningDistrict: 'M1-2', borough: 'BK', zipCode: '11231'});
  assert.deepEqual([val.anyUseFar, val.maxAnyUseZfa, val.anyUsePricePerBuildableZfa], [5, 10000, 100]);
  const dir = mkdtempSync(join(tmpdir(), 'acres-any-use-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const lot = (n, price, mnf) => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${n} Court St, Brooklyn, NY 11231`, streetLine: `${n} Court St`, streetNumber: String(n), city: 'Brooklyn', state: 'NY', zipCode: '11231', latitude: 40.68, longitude: -73.99, listPrice: price, style: 'land', assetClass: 'land_development', isDevelopmentCandidate: true, _mnf: mnf});
  store.ingestListings([lot(1, 1000000, 5), lot(2, 1000000, 0)], Date.UTC(2026, 9, 19));
  for (const [n, mnf] of [[1, 5], [2, 0]]) store.write("UPDATE market_listings SET bbl = ?, pluto_lot_area = 2000, pluto_bldg_area = 0, resid_far = 2, aff_res_far = 2.4, comm_far = 1, facil_far = 2, mnf_far = ?, zoning_district = 'M1-2' WHERE property_id = ?", `300100000${n}`, mnf, `p-${n}`);
  store.revalueDealsWithSettings(null, null);
  assert.deepEqual(store.query('SELECT property_id, any_use_price_per_buildable_zfa p FROM market_listings ORDER BY property_id').map(r => [r.property_id, r.p]), [['p-1', 100], ['p-2', 208]]);
  const ranked = store.searchDeals({minUnusedZfa: 0, sortBy: 'any_use_price_per_buildable_zfa'});
  assert.deepEqual(ranked.map(d => [d.propertyId, d.anyUseFar, d.anyUsePricePerBuildableZfa]), [['p-1', 5, 100], ['p-2', 2.4, 208]]);
  assert.deepEqual(store.searchDeals({minUnusedZfa: 0, maxPricePerBuildableAnyUse: 150}).map(d => d.propertyId), ['p-1']);
});

test('a for-sale listing the last all-borough scrape did not return leaves the deals; broker listings stay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-stale-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = (n, extra = {}) => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${n} Court St, Brooklyn, NY 11231`, streetLine: `${n} Court St`, city: 'Brooklyn', state: 'NY', zipCode: '11231', latitude: 40.68, longitude: -73.99, listPrice: 900000, style: 'land', assetClass: 'land_development', isDevelopmentCandidate: true, ...extra});
  const tenDaysAgo = Date.now() - 10 * 24 * 3600 * 1000;
  store.ingestListings([row(1), row(2), row(3, {source: 'broker:ariel', sourceName: 'Ariel'})], tenDaysAgo);
  for (const n of [1, 2, 3]) store.write('UPDATE market_listings SET bbl = ?, pluto_lot_area = 2000, resid_far = 2, aff_res_far = 2.4 WHERE property_id = ?', `300100000${n}`, `p-${n}`);
  store.revalueDealsWithSettings(null, null);
  const visible = () => store.searchDeals({minUnusedZfa: 0}).map(d => d.propertyId).sort();
  assert.deepEqual(visible(), ['p-1', 'p-2', 'p-3'], 'no scrape yet, so nothing is stale');
  // A full scrape returns only lot 1 again.
  await store.syncMarket({enrichPluto: false, bridgeRunner: async payload => ({allRows: payload.listingTypes[0] === 'for_sale' && payload.locations[0] === 'Brooklyn, NY' ? [row(1)] : []})});
  assert.deepEqual(visible(), ['p-1', 'p-3']);
  assert.ok(store.forSaleStaleCutoff() > tenDaysAgo);
  // A one-borough scrape is not the all-borough reference.
  const before = store.forSaleStaleCutoff();
  await store.syncMarket({locations: ['Queens, NY'], enrichPluto: false, bridgeRunner: async () => ({allRows: []})});
  assert.equal(store.forSaleStaleCutoff(), before);
});

test('an incremental sync returns only what changed, so it never sweeps or moves the read-time cutoff', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-incremental-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = n => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${n} Court St, Brooklyn, NY 11231`, streetLine: `${n} Court St`, city: 'Brooklyn', state: 'NY', zipCode: '11231', latitude: 40.68, longitude: -73.99, listPrice: 900000, style: 'land', assetClass: 'land_development', isDevelopmentCandidate: true});
  store.ingestListings([row(1), row(2)], Date.now() - 10 * 24 * 3600 * 1000);
  for (const n of [1, 2]) store.write('UPDATE market_listings SET bbl = ?, pluto_lot_area = 2000, resid_far = 2, aff_res_far = 2.4 WHERE property_id = ?', `300100000${n}`, `p-${n}`);
  const hours = [];
  const res = await store.syncMarket({enrichPluto: false, updatedInPastHours: 24, bridgeRunner: async payload => { hours.push(payload.updatedInPastHours); return {allRows: []}; }});
  assert.ok(hours.length && hours.every(h => h === 24));
  assert.equal(res.staleForSaleSwept, undefined);
  assert.equal(store.forSaleStaleCutoff(), 0);
  assert.deepEqual(store.query('SELECT listing_type FROM market_listings ORDER BY property_id').map(r => r.listing_type), ['for_sale', 'for_sale']);
  store.revalueDealsWithSettings(null, null);
  assert.equal(store.searchDeals({minUnusedZfa: 0}).length, 2);
});

test('a complete all-borough sync takes listings it no longer returns off the market; a partial one sweeps nothing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-sweep-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = (n, extra = {}) => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${n} Court St, Brooklyn, NY 11231`, streetLine: `${n} Court St`, city: 'Brooklyn', state: 'NY', zipCode: '11231', latitude: 40.68, longitude: -73.99, listPrice: 900000, beds: 3, style: 'land', assetClass: 'land_development', isDevelopmentCandidate: true, ...extra});
  const tenDaysAgo = Date.now() - 10 * 24 * 3600 * 1000;
  store.ingestListings([row(1), row(2), row(3, {source: 'broker:ariel', sourceName: 'Ariel'})], tenDaysAgo);
  for (const n of [1, 2, 3]) store.write('UPDATE market_listings SET bbl = ?, pluto_lot_area = 2000, resid_far = 2, aff_res_far = 2.4 WHERE property_id = ?', `300100000${n}`, `p-${n}`);
  const type = n => store.one('SELECT listing_type FROM market_listings WHERE property_id = ?', `p-${n}`).listing_type;
  const brooklyn = rows => async payload => ({allRows: payload.listingTypes.includes('for_sale') && payload.locations[0] === 'Brooklyn, NY' ? rows : []});
  // A sync in which Queens fails is not complete: nothing is swept, though the read-time cutoff still applies.
  const partial = await store.syncMarket({enrichPluto: false, bridgeRunner: async payload => (payload.locations[0] === 'Queens, NY' ? {error: 'timeout'} : brooklyn([row(1)])(payload))});
  assert.equal(partial.staleForSaleSwept, undefined);
  assert.deepEqual([type(1), type(2)], ['for_sale', 'for_sale']);
  // A complete sync that returns only lot 1 takes lot 2 off the market for good; the broker listing is its feed's to sweep.
  const complete = await store.syncMarket({enrichPluto: false, bridgeRunner: brooklyn([row(1)])});
  assert.equal(complete.staleForSaleSwept, 1);
  assert.deepEqual([type(1), type(2), type(3)], ['for_sale', 'off_market', 'for_sale']);
  assert.equal(store.getZipRollup('11231').byBedrooms['3'].activeForSaleCount, 1);
  assert.ok(!store.getSimilarCompsForDeal(store.one("SELECT * FROM market_listings WHERE property_id = 'p-1'"), {limit: 10}).some(c => c.id === 'p-2:for_sale'));
  // Returned again, it is back on the market.
  await store.syncMarket({enrichPluto: false, bridgeRunner: brooklyn([row(1), row(2)])});
  assert.equal(type(2), 'for_sale');
});

test('a closing retires the property\'s for-sale listing at ingestion; an older closing does not', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-sold-twin-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = (n, extra = {}) => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${n} Court St, Brooklyn, NY 11231`, zipCode: '11231', latitude: 40.68, longitude: -73.99, listPrice: 900000, assetClass: 'land_development', isDevelopmentCandidate: true, ...extra});
  store.ingestListings([row(1, {listDate: '2026-03-01'}), row(2, {listDate: '2026-03-01'})], Date.now());
  const type = id => store.one('SELECT listing_type FROM market_listings WHERE id = ?', id).listing_type;
  store.ingestListings([row(1, {listingType: 'sold', soldPrice: 850000, soldDate: '2026-09-15'}), row(2, {listingType: 'sold', soldPrice: 600000, soldDate: '2020-01-01'})], Date.now());
  assert.equal(type('p-1:for_sale'), 'off_market');
  assert.equal(type('p-1:sold:2026-09-15'), 'sold');
  assert.equal(type('p-2:for_sale'), 'for_sale', 'a 2020 closing does not end a 2026 listing');
  // A stale for-sale observation from before the sale stays off; a relisting after it comes back.
  store.ingestListings([row(1, {listDate: '2026-03-01', lastUpdateDate: '2026-08-01'})], Date.now());
  assert.equal(type('p-1:for_sale'), 'off_market');
  store.ingestListings([row(1, {listDate: '2026-10-01', lastUpdateDate: '2026-10-02'})], Date.now());
  assert.equal(type('p-1:for_sale'), 'for_sale');
  assert.deepEqual(store.searchDeals({minUnusedZfa: 0}).filter(d => d.propertyId === 'p-1').length, 0, 'unmatched rows are not deals');
});

test('a whole-lot closing matched to the lot retires a for-sale listing there; unit sales in the building do not', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-sold-lot-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = (id, extra) => ({propertyId: id, listingType: 'for_sale', address: '5 Court St, Brooklyn, NY 11231', zipCode: '11231', latitude: 40.68, longitude: -73.99, listPrice: 900000, assetClass: 'land_development', isDevelopmentCandidate: true, listDate: '2026-03-01', ...extra});
  store.ingestListings([row('listed'), row('lot-sale', {listingType: 'sold', soldPrice: 800000, soldDate: '2026-09-01'}), row('unit-sale', {listingType: 'sold', soldPrice: 700000, soldDate: '2026-09-02', assetClass: 'condo_coop_apartment'})], Date.now());
  store.write("UPDATE market_listings SET bbl = '3001000005' WHERE property_id IN ('listed', 'unit-sale')");
  store.retireSupersededListings();
  assert.equal(store.one("SELECT listing_type FROM market_listings WHERE property_id = 'listed'").listing_type, 'for_sale', 'a unit sale does not end the lot listing');
  store.write("UPDATE market_listings SET bbl = '3001000005' WHERE property_id = 'lot-sale'");
  assert.deepEqual(store.retireSupersededListings(), {brokerTwins: 0, soldTwins: 1});
  assert.equal(store.one("SELECT listing_type FROM market_listings WHERE property_id = 'listed'").listing_type, 'off_market');
});

test('the research host installer turns the market timer on; the service gates itself', () => {
  const installer = readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8');
  assert.match(installer, /systemctl enable --now acres-market\.timer/);
  assert.doesNotMatch(installer, /disable --now acres-market\.timer/);
});

test('a listing the coordinate match misses is placed by address through GeoSearch, and an earlier miss can be retried', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-geosearch-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const row = (n, num) => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${num} Jamaica Ave, Queens, NY 11421`, streetLine: `${num} Jamaica Ave`, streetNumber: num, streetName: 'Jamaica', city: 'Queens', state: 'NY', zipCode: '11421', fipsCode: '36081', latitude: 40.694, longitude: -73.85, listPrice: 2500000, style: 'multi_family', assetClass: 'townhouse_single_family', isDevelopmentCandidate: true});
  store.ingestListings([row(1, '95-27'), row(2, '95-29'), row(3, '95-31')], Date.now());
  const pluto = {bbl: '4088830084.00000000', address: '95-27 JAMAICA AVENUE', borough: 'QN', lotarea: '5000', bldgarea: '11348', residfar: '3', affresfar: '3.9', commfar: '0', facilfar: '3', mnffar: '0', zonedist1: 'R6A', latitude: '40.694672', longitude: '-73.849558'};
  const plutoFetcher = async where => (where.startsWith('bbl=') ? [pluto] : []);
  const geo = async item => ({'95-27': {bbl: '4088830084', label: '95-27 JAMAICA AVENUE, Woodhaven, NY, USA', latitude: 40.694667, longitude: -73.849559}, '95-29': {bbl: '4088830084', label: '95-27 JAMAICA AVENUE, Woodhaven, NY, USA', latitude: 40.694667, longitude: -73.849559}, '95-31': {bbl: '4088830084', label: '95-31 JAMAICA AVENUE, Woodhaven, NY, USA', latitude: 40.72, longitude: -73.849559}}[item.street_number]);
  // Without an address fetcher nothing is matched and every listing is marked unmatched.
  assert.deepEqual(await store.enrichNycListingsWithPluto({plutoFetcher}), {matched: 0, geosearched: 0, scanned: 3, incompleteBatches: 0, failedBatches: 0});
  assert.deepEqual(store.query("SELECT property_id FROM market_listings WHERE deal_verdict = 'unmatched_parcel' ORDER BY property_id").map(r => r.property_id), ['p-1', 'p-2', 'p-3']);
  // Unmatched listings are left alone unless retried; the retry places p-1 only: p-2's hit has another
  // house number and p-3's lies far from the listing pin.
  assert.equal((await store.enrichNycListingsWithPluto({plutoFetcher, geosearchFetcher: geo})).scanned, 0);
  const retried = await store.enrichNycListingsWithPluto({plutoFetcher, geosearchFetcher: geo, retryUnmatched: true});
  assert.deepEqual([retried.matched, retried.geosearched], [1, 1]);
  const placed = store.query("SELECT property_id, bbl, zoning_district z, mnf_far m, deal_verdict v FROM market_listings ORDER BY property_id");
  assert.deepEqual(placed.map(r => [r.property_id, r.bbl, r.z, r.m]), [['p-1', '4088830084', 'R6A', 0], ['p-2', null, null, null], ['p-3', null, null, null]]);
  assert.notEqual(placed[0].v, 'unmatched_parcel');
});
