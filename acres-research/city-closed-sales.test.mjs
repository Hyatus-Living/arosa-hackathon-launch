import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore, computeDealValuation} from './market-store.mjs';
import {mapClosedSalesCsv, importClosedSales, addUnitAreas, CITY_CLOSED_SALES_SOURCE} from './city-closed-sales.mjs';

// Same property closing twice, plus a second condo, plus rows that must be skipped.
const CSV = [
  'address,city,zip,sold_price,sold_date,beds,sqft,property_type',
  '"10 Repeat St, Apt 2",New York,10001,800000,2024-03-01,1,1000,condo',
  '"10 Repeat St, Apt 2",New York,10001,950000,2026-06-15,1,1000,condo',
  '22 Other St,New York,10001,1000000,06/20/2026,1,1000,condo',
  '33 No Date St,New York,10001,700000,,1,900,condo',
  '44 No Price St,New York,10001,0,2026-01-01,1,900,condo',
].join('\n');

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'city-sales-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return store;
}

test('sold identity carries the sold date; asking identity does not', () => {
  const base = {propertyId: 'p1', address: '10 Repeat St', zipCode: '10001'};
  assert.notEqual(
    MarketStore.listingKey({...base, listingType: 'sold', soldDate: '2024-03-01'}),
    MarketStore.listingKey({...base, listingType: 'sold', soldDate: '2026-06-15'}));
  assert.equal(
    MarketStore.listingKey({...base, listingType: 'sold', soldDate: '2026-06-15T10:00:00Z'}),
    MarketStore.listingKey({...base, listingType: 'sold', soldDate: '2026-06-15'}));
  assert.equal(
    MarketStore.listingKey({...base, listingType: 'for_sale', soldDate: '2024-03-01'}),
    MarketStore.listingKey({...base, listingType: 'for_sale'}));
});

test('csv mapping accepts repeat closings and counts unusable rows', () => {
  const {rows, parsed, skipped} = mapClosedSalesCsv(CSV);
  assert.equal(parsed, 5);
  assert.equal(rows.length, 3);
  assert.deepEqual(skipped, {missing_or_bad_sold_date: 1, missing_or_bad_sold_price: 1});
  assert.equal(rows[0].source, CITY_CLOSED_SALES_SOURCE);
  assert.equal(rows[2].soldDate, '2026-06-20');
  assert.equal(rows[0].pricePerSqft, 800);
  assert.equal(new Set(rows.map(r => MarketStore.listingKey(r))).size, 3);
});

test('both closings of one property are kept, re-import updates, and the rollup counts sourced sales', t => {
  const store = tempStore(t);
  const {rows} = mapClosedSalesCsv(CSV);
  const first = importClosedSales(store, rows);
  assert.equal(first.inserted, 3);
  const stored = store.query("SELECT id, sold_price, sold_date FROM market_listings WHERE source = ? ORDER BY sold_date", CITY_CLOSED_SALES_SOURCE);
  assert.equal(stored.length, 3);
  assert.deepEqual(stored.map(r => r.sold_price), [800000, 950000, 1000000]);

  const again = importClosedSales(store, rows);
  assert.equal(again.inserted, 0);
  assert.equal(again.updated, 3);
  assert.equal(store.query('SELECT COUNT(*) AS n FROM market_listings')[0].n, 3);

  const bucket = store.getZipRollup('10001').byBedrooms['1'];
  assert.equal(bucket.closedSoldCount, 3);
  assert.equal(bucket.condoCoopClosedSoldPriceSampleCount, 3);
  assert.equal(bucket.medianCondoCoopClosedSoldPricePerSqft, 950);
});

test('a sourced asking row still stays out of the rollup', t => {
  const store = tempStore(t);
  store.ingestListings([{propertyId: 'ask-1', listingType: 'for_sale', address: '9 Ask St', zipCode: '10002', beds: 1, sqft: 1000, listPrice: 900000, pricePerSqft: 900, assetClass: 'condo_coop_apartment', source: 'broker:test'}], Date.UTC(2026, 9, 18));
  assert.equal(store.getZipRollup('10002'), null);
});

// The NYC Department of Finance rolling-sales layout: spaced upper-case headers, comma numbers,
// M/D/YYYY dates, borough/block/lot instead of a BBL and the unit either in its own column or the address.
const DOF_HEADER = 'BOROUGH,NEIGHBORHOOD,BUILDING CLASS CATEGORY,TAX CLASS AT PRESENT,BLOCK,LOT,EASE-MENT,BUILDING CLASS AT PRESENT,ADDRESS,APARTMENT NUMBER,ZIP CODE,RESIDENTIAL UNITS,COMMERCIAL UNITS,TOTAL UNITS,LAND SQUARE FEET,GROSS SQUARE FEET,YEAR BUILT,TAX CLASS AT TIME OF SALE,BUILDING CLASS AT TIME OF SALE,SALE PRICE,SALE DATE';
const dofRow = ({boro = 1, block = 384, lot, cls, address, apt = '', zip = '10009', units = 1, land = '', gross = '', price, date = '01/08/2026'}) =>
  [boro, 'EAST VILLAGE', 'CATEGORY', '2', block, lot, '', cls, `"${address}"`, apt, zip, units, '', units, land && `"${land}"`, gross && `"${gross}"`, 2005, '2', cls, price && `"${price}"`, date].join(',');
const DOF_CSV = [
  DOF_HEADER,
  dofRow({lot: 1215, cls: 'R4', address: '310 EAST HOUSTON STREET, 5A', apt: '5A', price: '800,000'}),
  dofRow({block: 390, lot: 1007, cls: 'R4', address: '217 EAST 7TH STREET, 2B', price: '1,212,000', date: '3/9/2026'}),
  dofRow({block: 389, lot: 22, cls: 'C7', address: '208 EAST 7TH STREET', units: 20, land: '4,544', gross: '19,418', price: '8,600,000'}),
  dofRow({block: 376, lot: 41, cls: 'C4', address: '745 EAST 6TH STREET, 1B', units: 28, land: '4,542', gross: '18,254', price: '540,000'}),
  dofRow({block: 400, lot: 50, cls: 'D4', address: '100 AVENUE A, 4C', zip: '10009', price: '650,000'}),
  dofRow({block: 372, lot: 9, cls: 'C7', address: '272 EAST 3 STREET', price: '0'}),
  dofRow({block: 373, lot: 10, cls: 'A4', address: '1 FAMILY PLACE', price: '10'}),
  dofRow({block: 491, lot: 1001, cls: 'R4', address: '1 BULK TOWER, 1A', price: '170,256,052'}),
  dofRow({block: 491, lot: 1002, cls: 'R4', address: '1 BULK TOWER, 1B', price: '170,256,052'}),
].join('\n');

test('a DOF rolling-sales file maps to sold comps with BBL identity, units, styles and counted skips', () => {
  const {rows, parsed, skipped} = mapClosedSalesCsv(DOF_CSV);
  assert.equal(parsed, 9);
  assert.deepEqual(skipped, {missing_or_bad_sold_price: 1, below_min_sale_price: 1, multi_lot_sale: 2});
  const [unit, suffixUnit, building, partial, coop] = rows;
  assert.deepEqual(
    {id: unit.propertyId, unit: unit.unit, address: unit.address, price: unit.soldPrice, date: unit.soldDate, style: unit.style, asset: unit.assetClass, sqft: unit.sqft},
    {id: 'city-sale:1003841215:5a', unit: '5A', address: '310 EAST HOUSTON STREET, 5A', price: 800000, date: '2026-01-08', style: 'condos', asset: 'condo_coop_apartment', sqft: null});
  assert.equal(suffixUnit.unit, '2B');
  assert.equal(suffixUnit.soldDate, '2026-03-09');
  assert.equal(building.propertyId, 'city-sale:1003890022');
  assert.equal(building.assetClass, 'multifamily_building');
  assert.equal(building.sqft, 19418);
  assert.equal(building.lotSqft, 4544);
  assert.equal(building.pricePerSqft, 443);
  // A unit named on a whole-building class still sold less than the building: no building area for it.
  assert.equal(partial.unit, '1B');
  assert.equal(partial.sqft, null);
  // Co-op units share the building's lot, so the unit joins the identity.
  assert.equal(coop.propertyId, 'city-sale:1004000050:4c');
  assert.equal(coop.style, 'coop');
  assert.ok(rows.every(r => r.source === CITY_CLOSED_SALES_SOURCE && !('bbl' in r)));
  assert.equal(mapClosedSalesCsv(DOF_CSV, {minSalePrice: 1}).skipped.below_min_sale_price, undefined);
});

test('condominium unit sales take their area from the assessment roll', async () => {
  const {mapped} = mapClosedSalesCsv(DOF_CSV);
  const requested = [];
  const fetcher = async url => {
    requested.push(url.searchParams.get('$where'));
    return {ok: true, json: async () => [{parid: '1003841215', gross_sqft: '635'}, {parid: '1003901007', gross_sqft: '40'}]};
  };
  assert.deepEqual(await addUnitAreas(mapped, {fetcher}), {condoUnitsWithoutArea: 2, filled: 1});
  assert.deepEqual(requested, ["parid in ('1003841215','1003901007')"]);
  const unit = mapped.find(m => m.row.unit === '5A').row;
  assert.equal(unit.sqft, 635);
  assert.equal(unit.pricePerSqft, 1260);
  assert.equal(mapped.find(m => m.row.unit === '2B').row.sqft, null);
});

const DEAL = {propertyId: 'deal-1', listingType: 'for_sale', address: '509 Pacific St, Brooklyn, NY 11217', streetNumber: '509', streetName: 'Pacific', city: 'Brooklyn', state: 'NY', zipCode: '11217', latitude: 40.6838, longitude: -73.9805, isDevelopmentCandidate: true, listPrice: 2200000};
const PLUTO = async () => [{bbl: '3009280034', borough: 'BK', address: '509 PACIFIC STREET', zonedist1: 'R7A', lotarea: '2500', bldgarea: '3200', residfar: '4.0', affresfar: '4.6', latitude: '40.6838', longitude: '-73.9805'}];
const citySale = (i, extra) => ({propertyId: `city-sale:30092800${10 + i}`, listingType: 'sold', address: `${i} Dean St, ${i}A`, unit: `${i}A`, zipCode: '11217', soldDate: `2026-0${1 + i}-15`, source: CITY_CLOSED_SALES_SOURCE, ...extra});

test('city closings price the ZIP condo sale and name their source, while counts and deal search ignore them', async t => {
  const store = tempStore(t);
  store.ingestListings([
    DEAL,
    {propertyId: 'ask-1', listingType: 'for_sale', address: '1 Ask St, 2A', zipCode: '11217', assetClass: 'condo_coop_apartment', sqft: 1000, listPrice: 2500000, pricePerSqft: 2500},
  ], Date.UTC(2026, 9, 18));
  await store.enrichNycListingsWithPluto({plutoFetcher: PLUTO});
  const publicBefore = store.publicCounts();
  const statusBefore = store.statusSummary();
  const dealsBefore = store.searchDeals({zipCode: '11217', minUnusedZfa: 0}).map(d => d.id);

  importClosedSales(store, [
    ...[1, 2, 3, 4, 5].map(i => citySale(i, {assetClass: 'condo_coop_apartment', style: 'condos', sqft: 1000, soldPrice: 1000000 + i * 100000, pricePerSqft: 1000 + i * 100})),
    citySale(7, {assetClass: 'condo_coop_apartment', style: 'condos', sqft: 1000, soldPrice: 1300000, pricePerSqft: 1300}),
    citySale(6, {address: '600 Dean St', unit: null, assetClass: 'multifamily_building', style: 'apartment_building', sqft: 10000, lotSqft: 2500, soldPrice: 3000000, pricePerSqft: 300}),
  ], {now: Date.UTC(2026, 9, 19)});

  assert.deepEqual(store.publicCounts(), publicBefore);
  const status = store.statusSummary();
  assert.equal(status.totalListings, statusBefore.totalListings);
  assert.equal(status.closedSold, statusBefore.closedSold);
  assert.equal(status.cityClosedSales, 7);
  assert.deepEqual(store.searchDeals({zipCode: '11217', minUnusedZfa: 0}).map(d => d.id), dealsBefore);
  assert.deepEqual(store.searchDeals({zipCode: '11217', listingType: 'sold', minUnusedZfa: 0}), []);

  // Closings outnumber the threshold, so the ask and the whole-building sale stay out of the condo price.
  const {devMetrics} = store.getZipRollup('11217');
  assert.equal(devMetrics.blendedCondoSalePsf, 1300);
  assert.deepEqual(devMetrics.condoSaleSample, {basis: 'closed', count: 6, cityClosedCount: 6, earliestSoldDate: '2026-02-15', latestSoldDate: '2026-08-15', windowMonths: 24});

  store.revalueDealsWithSettings();
  const [deal] = store.searchDeals({zipCode: '11217', minUnusedZfa: 0});
  assert.equal(deal.flashcardValuation.submarketSalePsf, 1300);
  const basis = deal.flashcardValuation.basis.find(b => b.item === 'submarketSalePsf');
  assert.equal(basis.asOf, '2026-08-15');
  assert.match(basis.source, /across 6 closings from 2026-02-15 to 2026-08-15, the last 24 months: 6 from NYC Department of Finance recorded sales\. Asking prices are left out\./);

  // A unit's sale is not a site comp; the whole-building closing is.
  const comps = store.getSimilarCompsForDeal(deal.id, {limit: 10}).map(c => c.address);
  assert.ok(comps.includes('600 Dean St'));
  assert.ok(!comps.some(a => /Dean St, \dA/.test(a)));
});

test('a site never takes its own lot\'s closing or any unit\'s sale as a comp', async t => {
  const store = tempStore(t);
  store.ingestListings([DEAL], Date.UTC(2026, 9, 18));
  await store.enrichNycListingsWithPluto({plutoFetcher: PLUTO});
  importClosedSales(store, [
    // The deal's own lot (3009280034) sold as land in 2025, and a commercial condo unit nearby.
    {propertyId: 'city-sale:3009280034', listingType: 'sold', address: '509 Pacific St', unit: null, zipCode: '11217', soldDate: '2025-06-01', soldPrice: 1200000, lotSqft: 2500, assetClass: 'land_development', style: 'land', source: CITY_CLOSED_SALES_SOURCE},
    citySale(1, {address: '515 Pacific St, UNIT CU1', unit: 'UNIT CU1', assetClass: 'commercial_investment', style: 'commercial_condo', sqft: 900, soldPrice: 650000}),
    citySale(2, {address: '600 Dean St', unit: null, assetClass: 'multifamily_building', style: 'apartment_building', sqft: 10000, lotSqft: 2500, soldPrice: 3000000}),
  ], {now: Date.UTC(2026, 9, 19)});
  const [deal] = store.searchDeals({zipCode: '11217', minUnusedZfa: 0});
  assert.deepEqual(store.getSimilarCompsForDeal(deal.id, {limit: 10}).map(c => c.address), ['600 Dean St']);
  assert.deepEqual(store.getSimilarCompsForDeals([store.one('SELECT * FROM market_listings WHERE id = ?', deal.id)], {limit: 10}).values().next().value.map(c => c.address), ['600 Dean St']);
});

test('the ZIP condo sale benchmark reads the last 24 months of closings and states its window', () => {
  const store = new MarketStore(':memory:');
  const sold = store.db.prepare(`INSERT INTO market_listings (id, listing_type, asset_class, zip_code, borough, sold_price, sqft, sold_date, address, first_seen_at, last_seen_at)
    VALUES (?, 'sold', 'condo_coop_apartment', '11211', 'BK', ?, 1000, ?, ?, 0, 0)`);
  for (let i = 0; i < 6; i++) sold.run(`old${i}`, 700_000, `2015-0${i + 1}-15`, `${i} Old St`);
  for (let i = 0; i < 6; i++) sold.run(`new${i}`, 1_450_000, `2026-0${i + 1}-15`, `${i} New St`);
  store.recomputeZipRollup('11211', Date.UTC(2026, 9, 25));
  const {devMetrics} = store.getZipRollup('11211');
  assert.equal(devMetrics.blendedCondoSalePsf, 1450, 'the 2015 closings at $700 describe another market');
  assert.deepEqual(devMetrics.condoSaleSample, {basis: 'closed', count: 6, cityClosedCount: 0, earliestSoldDate: '2026-01-15', latestSoldDate: '2026-06-15', windowMonths: 24});
  const lot = {listPrice: null, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 4.0, affResFar: 5.01, zoningDistrict: 'R7A', address: '1 EXAMPLE STREET', borough: 'BK', zipCode: '11211'};
  const basis = computeDealValuation({...lot, submarketSalePsf: 1450, submarketSaleSample: devMetrics.condoSaleSample}).basis.find(b => b.item === 'submarketSalePsf');
  assert.match(basis.source, /across 6 closings from 2026-01-15 to 2026-06-15, the last 24 months:/);
  // Two years on, three closings are in the window: too few, and the count says which window.
  store.recomputeZipRollup('11211', Date.UTC(2028, 3, 1));
  assert.deepEqual(store.getZipRollup('11211').devMetrics.condoSaleSample, {basis: 'too_few_closings', count: 3, required: 6, windowMonths: 24});
  store.close();
});

test('the ZIP condo sale benchmark is closings only: asks never set it and a thin ZIP has none', async t => {
  const store = tempStore(t);
  const ask = i => ({propertyId: `ask-${i}`, listingType: 'for_sale', address: `${i} Ask St, ${i}A`, zipCode: '11217', assetClass: 'condo_coop_apartment', sqft: 1000, listPrice: 5000000, pricePerSqft: 5000});
  store.ingestListings([DEAL, ...[1, 2, 3, 4, 5, 6].map(ask)], Date.UTC(2026, 9, 18));
  await store.enrichNycListingsWithPluto({plutoFetcher: PLUTO});
  importClosedSales(store, [
    ...[1, 2, 3, 4, 5, 7].map(i => citySale(i, {assetClass: 'condo_coop_apartment', sqft: 1000, soldPrice: 900000, pricePerSqft: 900})),
    citySale(6, {address: '600 Dean St', unit: null, assetClass: 'multifamily_building', sqft: 10000, soldPrice: 3000000, pricePerSqft: 300}),
  ], {now: Date.UTC(2026, 9, 19)});
  assert.equal(store.getZipRollup('11217').devMetrics.blendedCondoSalePsf, 900);

  // Without the closings the asks at $5,000 and the building sale leave no benchmark, rather than standing in.
  store.write("DELETE FROM market_listings WHERE listing_type = 'sold' AND asset_class = 'condo_coop_apartment'");
  store.recomputeZipRollup('11217', Date.UTC(2026, 9, 19));
  const {devMetrics} = store.getZipRollup('11217');
  assert.equal(devMetrics.blendedCondoSalePsf, null);
  assert.deepEqual(devMetrics.condoSaleSample, {basis: 'too_few_closings', count: 0, required: 6, windowMonths: 24});
  // Four closings are still too few.
  importClosedSales(store, [1, 2, 3, 4].map(i => citySale(i, {assetClass: 'condo_coop_apartment', sqft: 1000, soldPrice: 900000, pricePerSqft: 900})), {now: Date.UTC(2026, 9, 19)});
  assert.equal(store.getZipRollup('11217').devMetrics.blendedCondoSalePsf, null);

  // The condo exit is priced on the submarket tier figure, never the asks, and the basis says the benchmark is missing.
  store.revalueDealsWithSettings();
  const [deal] = store.searchDeals({zipCode: '11217', minUnusedZfa: 0});
  assert.notEqual(deal.flashcardValuation.submarketSalePsf, 5000);
  const basis = deal.flashcardValuation.basis.find(b => b.item === 'submarketSalePsf');
  assert.match(basis.source, /^No recorded sale benchmark for this ZIP: 4 priced condo and co-op closings in the last 24 months, fewer than the 6 needed; asking prices are never used\. In its place, /);
});
