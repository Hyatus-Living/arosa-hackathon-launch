import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketStore, computeDealValuation, measureUnitSizes, unitSizesFor, ASSUMED_UNIT_SIZES, DEAL_UNIT_MIX, UNIT_SIZE_SAMPLE} from './market-store.mjs';

// Apartments for rent in one ZIP: studios near 500 SF, one-bedrooms near 650, two-bedrooms near 900.
const rentals = (zip, counts, {neighborhood = null, prefix = zip} = {}) => {
  const rows = [];
  const sizes = {0: 500, 1: 650, 2: 900};
  for (const [beds, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) rows.push({id: `${prefix}-${beds}-${i}`, property_id: `${prefix}-${beds}-${i}`, listing_type: 'for_rent', zip_code: zip, borough: 'BK', neighborhood, beds: Number(beds), sqft: sizes[beds] + (i % 3) * 10 - 10});
  }
  return rows;
};
const lookup = measured => new Map(measured.map(m => [`${m.exit}|${m.scope}`, m]));
const vacantLot = {
  listPrice: 2_000_000, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 0,
  residFar: 4.0, affResFar: 5.01, zoningDistrict: 'R7A', address: '2 EXAMPLE AVENUE', borough: 'BK', zipCode: '11216',
  submarketSalePsf: 500, submarketRentPsf: 6,
};

test('unit sizes are medians by bedroom count, weighted by the mix, with outliers and repeat units dropped', () => {
  const rows = [
    ...rentals('11216', {0: 9, 1: 13, 2: 8}),
    // A one-bedroom stated at 4,800 SF is outside the citywide fences for its type.
    {id: 'big', property_id: 'big', listing_type: 'for_rent', zip_code: '11216', borough: 'BK', beds: 1, sqft: 4800},
    // The same condominium sold and listed again counts once.
    ...Array.from({length: 3}, (_, i) => ({id: `c${i}`, property_id: `c${i}`, listing_type: 'sold', zip_code: '11216', borough: 'BK', beds: 1, sqft: 750})),
    {id: 'c0-again', property_id: 'c0', listing_type: 'for_sale', zip_code: '11216', borough: 'BK', beds: 1, sqft: 750},
    // Records with no bedroom count (city closed sales, whole buildings) are not studios.
    ...Array.from({length: 40}, (_, i) => ({id: `dof${i}`, property_id: `dof${i}`, listing_type: 'sold', zip_code: '11216', borough: 'BK', beds: null, sqft: 1200})),
    ...Array.from({length: 40}, (_, i) => ({id: `rent-nobeds${i}`, property_id: `rent-nobeds${i}`, listing_type: 'for_rent', zip_code: '11216', borough: 'BK', beds: '', sqft: 1300})),
  ];
  const measured = measureUnitSizes(rows, '2026-10-21');
  const zip = measured.find(m => m.exit === 'rental' && m.scope === 'zip:11216');
  assert.deepEqual(zip.mix.map(u => [u.type, u.netSqft, u.listings]), [['studio', 500, 9], ['oneBedroom', 650, 13], ['twoBedroom', 900, 8]]);
  assert.equal(zip.sampleCount, 30, 'the outlier is not counted');
  assert.equal(zip.averageNetSqft, Math.round(0.30 * 500 + 0.45 * 650 + 0.25 * 900));
  assert.equal(zip.asOf, '2026-10-21');
  assert.deepEqual(measured.filter(m => m.exit === 'rental').map(m => m.scope).sort(), ['borough:BK', 'city', 'zip:11216']);
  // Three condominiums are too few for any area.
  assert.equal(measured.some(m => m.exit === 'condo'), false);
});

test('a listing takes its ZIP, then its neighborhood, borough and the city, then the assumed mix', () => {
  const rows = [
    ...rentals('11216', {0: 9, 1: 13, 2: 8}),
    ...rentals('11225', {0: 1, 1: 2, 2: 1}, {neighborhood: 'Crown Heights'}),
    ...rentals('11213', {0: 9, 1: 12, 2: 8}, {neighborhood: 'Crown Heights', prefix: '11213'}),
  ];
  const table = lookup(measureUnitSizes(rows, '2026-10-21'));
  const at = (zip_code, neighborhood, borough = 'BK') => unitSizesFor(table, {zip_code, neighborhood, borough}).rental;
  assert.equal(at('11216', null).label, 'ZIP 11216');
  // ZIP 11225 has four rentals, so its Crown Heights listings use the neighborhood.
  assert.equal(at('11225', 'Crown Heights').label, 'Crown Heights');
  assert.equal(at('11225', null).label, 'Brooklyn');
  assert.equal(at('10451', null, 'BX').label, 'New York City');
  assert.equal(unitSizesFor(new Map(), {zip_code: '11216', borough: 'BK'}).rental, ASSUMED_UNIT_SIZES.rental);
  assert.equal(unitSizesFor(table, {zip_code: '11216', borough: 'BK'}).condo, ASSUMED_UNIT_SIZES.condo);
  for (const scope of [at('11225', 'Crown Heights'), at('11225', null)]) {
    assert.ok(scope.sampleCount >= UNIT_SIZE_SAMPLE.minListings && scope.mix.every(u => u.listings >= UNIT_SIZE_SAMPLE.minPerType));
  }
});

test('planned units divide by the area unit size and say which area it came from', () => {
  const table = lookup(measureUnitSizes(rentals('11216', {0: 9, 1: 13, 2: 8}), '2026-10-21'));
  const unitSizes = unitSizesFor(table, {zip_code: '11216', borough: 'BK'});
  const measured = computeDealValuation({...vacantLot, unitSizes});
  const assumed = computeDealValuation(vacantLot);
  assert.equal(measured.valueDriver.exit, 'rental');
  assert.equal(measured.plannedUnitBasis.unitNetSqft, unitSizes.rental.averageNetSqft);
  assert.ok(unitSizes.rental.averageNetSqft > ASSUMED_UNIT_SIZES.rental.averageNetSqft);
  assert.ok(measured.plannedUnits < assumed.plannedUnits, 'larger units here plan fewer of them');
  assert.equal(measured.plannedUnitBasis.unitSizes.summary, `ZIP 11216 rentals, median ${unitSizes.rental.averageNetSqft} SF (30 listings)`);
  assert.equal(assumed.plannedUnitBasis.unitSizes.summary, `the citywide assumed mix, about ${ASSUMED_UNIT_SIZES.rental.averageNetSqft} SF a rental (too few measured listings nearby)`);
  const basis = measured.basis.find(b => b.item === 'plannedUnitMix');
  assert.equal(basis.asOf, '2026-10-21');
  assert.match(basis.source, /^Realtor\.com apartments for rent in ZIP 11216: median SF by bedroom count \(studio 500, one-bedroom 650, two-bedroom 900\) weighted by the planned mix \(30%, 45%, 25%\) to \d+ SF a unit, from 30 listings$/);
  assert.equal(assumed.basis.find(b => b.item === 'plannedUnitMix').asOf, DEAL_UNIT_MIX.asOf);
  for (const v of [measured, assumed]) assert.doesNotMatch(JSON.stringify(v.basis) + v.plannedUnitBasis.unitSizes.summary, /—/);
});

test('a sync measures unit sizes and the revalue and search paths plan with them', t => {
  const store = new MarketStore(':memory:');
  t.after(() => store.close());
  const listing = (zip, beds, i, sqft) => ({propertyId: `${zip}-${beds}-${i}`, listingType: 'for_rent', zipCode: zip, beds, sqft, listPrice: 3000, assetClass: 'condo_coop_apartment', lastUpdateDate: '2026-10-20'});
  const rows = [];
  for (const [beds, n, sqft] of [[0, 9, 520], [1, 13, 700], [2, 8, 980]]) for (let i = 0; i < n; i++) rows.push(listing('11216', beds, i, sqft + (i % 3) * 20));
  rows.push(listing('11225', 1, 0, 710), {...listing('11216', 1, 99, 700), source: 'loopnet'});
  store.ingestListings(rows, Date.parse('2026-10-21T12:00:00Z'));
  const stored = store.getUnitSizes();
  assert.equal(stored.get('rental|zip:11216').sampleCount, 30, 'sourced feed rows carry no unit sizes');
  assert.equal(stored.has('rental|zip:11225'), false);
  assert.equal(stored.get('rental|borough:BK').asOf, '2026-10-21');

  const insert = store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, pluto_address, zip_code, borough, bbl, list_price, pluto_lot_area,
    pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, first_seen_at, last_seen_at)
    VALUES (?, 'for_sale', ?, ?, ?, 'BK', ?, 2000000, 5000, 50, 100, '5', 0, 4.0, 5.01, 'R7A', 1, 1)`);
  insert.run('in-zip', '2 Example Ave', '2 EXAMPLE AVENUE', '11216', '3000010001');
  insert.run('thin-zip', '4 Example Ave', '4 EXAMPLE AVENUE', '11225', '3000010002');
  store.revalueDealsWithSettings();
  const deals = Object.fromEntries(store.searchDealsPage({minUnusedZfa: 0, includeSimilarComps: false}).deals.map(d => [d.id, d]));
  assert.equal(deals['in-zip'].plannedUnitBasis.rentalUnitNetSqft, stored.get('rental|zip:11216').averageNetSqft);
  assert.equal(deals['thin-zip'].plannedUnitBasis.rentalUnitNetSqft, stored.get('rental|borough:BK').averageNetSqft);
  // A condominium lead with no measured condos plans on the assumed condo size, its affordable floor area at Brooklyn's rental size.
  assert.equal(deals['thin-zip'].plannedUnitBasis.exit, 'condo');
  assert.equal(deals['thin-zip'].plannedUnitBasis.unitNetSqft, ASSUMED_UNIT_SIZES.condo.averageNetSqft);
  assert.match(deals['thin-zip'].flashcardValuation.basis.find(b => b.item === 'plannedUnitMix').source, /too few measured listings nearby; affordable floor area at the rental size, Brooklyn rentals, median \d+ SF \(31 listings\)$/);
});
