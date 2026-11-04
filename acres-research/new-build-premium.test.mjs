import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore, computeDealValuation, measureNewBuildPremiums, newBuildBuildingKey, newBuildPremiumFor, newBuildPremiumTable, NEW_BUILD_PREMIUM} from './market-store.mjs';

const unit = (metric, zip_code, year_built, psf, borough = 'BK', building = undefined) => ({metric, zip_code, year_built, psf, borough, building});
// A ZIP with `existing` units at one price per SF and `recent` units built in 2020 at another.
const zip = (metric, zip_code, existing, recent, {count = 6, recentCount = 3, borough = 'BK'} = {}) => [
  ...Array.from({length: count}, () => unit(metric, zip_code, 1960, existing, borough)),
  ...Array.from({length: recentCount}, () => unit(metric, zip_code, 2020, recent, borough)),
];
// `zips` ZIPs of one borough, each with three recent units, each its own building, at `ratio` times the others (3 pairs a ZIP).
const manyZips = (metric, ratio, zips = 8, borough = 'BK') => Array.from({length: zips}, (_, i) => zip(metric, `${borough}${i}`, 4, 4 * ratio, {borough})).flat();
const scope = (premiums, metric, key) => premiums.find(p => p.metric === metric && p.scope === key);

test('a new building is compared with the other units in its own ZIP, and the median ratio is the premium', () => {
  const rows = [...manyZips('rent', 1.5), ...manyZips('sale', 1.25, 10)];
  const premiums = measureNewBuildPremiums(rows, '2026-10-22');
  const rent = scope(premiums, 'rent', 'city'), sale = scope(premiums, 'sale', 'city');
  assert.deepEqual([rent.ratio, rent.rawRatio, rent.buildingCount, rent.pairCount, rent.zipCount, rent.windowYears, rent.asOf], [1.5, 1.5, 24, 24, 8, NEW_BUILD_PREMIUM.windowYears, '2026-10-22']);
  assert.deepEqual([sale.ratio, sale.buildingCount, sale.pairCount, sale.zipCount], [1.25, 30, 30, 10]);
});

test('a ZIP is compared with itself: a dear ZIP and a cheap one with the same premium measure the same ratio', () => {
  const rows = [...zip('rent', '10001', 10, 15), ...zip('rent', '10002', 2, 3), ...manyZips('rent', 1.5, 6)];
  assert.equal(scope(measureNewBuildPremiums(rows, '2026-10-22'), 'rent', 'city').ratio, 1.5);
});

test('units with no year built or built before the window are existing stock', () => {
  const rows = [...manyZips('rent', 2), ...Array.from({length: 40}, (_, i) => unit('rent', '11299', i % 2 ? null : 2005, 100))];
  assert.equal(scope(measureNewBuildPremiums(rows, '2026-10-22'), 'rent', 'city').pairCount, 24, 'the unknown and older units are never counted as new');
  // A building completed 13 years before the as-of date is outside the 12-year window.
  assert.equal(measureNewBuildPremiums(manyZips('rent', 2), '2033-01-01').length, 0, 'by 2033 the 2020 buildings are no longer recent');
});

test('too few pairs, or too few other units in the ZIP, measure no premium', () => {
  assert.deepEqual(measureNewBuildPremiums(manyZips('rent', 1.5, 4), '2026-10-22'), [], '12 pairs are fewer than the minimum');
  const thin = Array.from({length: 10}, (_, i) => zip('sale', `1130${i}`, 4, 6, {count: NEW_BUILD_PREMIUM.minOtherUnits.sale - 3, recentCount: 3})).flat();
  assert.deepEqual(measureNewBuildPremiums(thin, '2026-10-22'), [], 'each new unit has four other closings in its ZIP, too few to compare with');
});

test('a borough with enough buildings gets its own premium, pulled toward the citywide one by its sample size', () => {
  // 180 Brooklyn buildings at 1.2 and 60 Manhattan buildings at 2.0: the citywide median is 1.2.
  const rows = [...manyZips('sale', 1.2, 60, 'BK'), ...manyZips('sale', 2, 20, 'MN')];
  const premiums = measureNewBuildPremiums(rows, '2026-10-22');
  assert.equal(scope(premiums, 'sale', 'city').ratio, 1.2);
  const manhattan = scope(premiums, 'sale', 'MN');
  assert.deepEqual([manhattan.rawRatio, manhattan.buildingCount, manhattan.zipCount], [2, 60, 20]);
  assert.equal(manhattan.ratio, 1.89, '(60 x 2.0 + 10 x 1.2) / 70');
  assert.equal(scope(premiums, 'sale', 'BK').ratio, 1.2);
});

test('a ZIP median counts its new buildings, so each building is compared with every other unit in its ZIP', () => {
  // Each ZIP: six older units (four at 4, two at 6) and four new one-unit buildings at 8. Against the older
  // units alone a building would measure 8 / 4 = 2, but the ZIP median the premium scales counts the new
  // buildings too: the other units are 4, 4, 4, 4, 6, 6, 8, 8, 8, median 6, so each building measures 8 / 6.
  const zipOf = (zipCode, borough) => [
    ...Array.from({length: 4}, () => unit('sale', zipCode, 1960, 4, borough)),
    ...Array.from({length: 4}, (_, b) => unit('sale', zipCode, 2020, 8, borough, `${zipCode}|${b} MAIN ST`)),
    ...Array.from({length: 2}, () => unit('sale', zipCode, 1960, 6, borough)),
  ];
  const rows = Array.from({length: 6}, (_, i) => zipOf(`1120${i}`, 'BK')).flat();
  // Others: 4, 4, 4, 4, 6, 6, 8, 8, 8: median 6. Each building: 8 / 6.
  assert.equal(scope(measureNewBuildPremiums(rows, '2026-10-22'), 'sale', 'city').ratio, 1.33);
});

test('a tower counts once, by the median of its units, like a six-unit building', () => {
  // Every ZIP has one 60-unit tower at 3 times the others and four small buildings at 1.2 times.
  const zipOf = zipCode => [
    ...Array.from({length: 200}, () => unit('sale', zipCode, 1960, 5)),
    ...Array.from({length: 60}, () => unit('sale', zipCode, 2020, 15, 'BK', `${zipCode}|1 TOWER PL`)),
    ...Array.from({length: 4}, (_, b) => Array.from({length: 6}, () => unit('sale', zipCode, 2020, 6, 'BK', `${zipCode}|${b + 2} SMALL ST`))).flat(),
  ];
  const city = scope(measureNewBuildPremiums(Array.from({length: 5}, (_, i) => zipOf(`1121${i}`)).flat(), '2026-10-22'), 'sale', 'city');
  assert.deepEqual([city.ratio, city.buildingCount, city.pairCount], [1.2, 25, 420], 'by unit the 300 tower closings would have set it at 3');
});

test('a ZIP with enough new buildings follows its own premium, pulled toward its borough; a thin ZIP takes the borough', () => {
  // Brooklyn: 20 ZIPs at 1.2 (3 buildings each). One more ZIP with 10 buildings at 2.0, one with 2 buildings at 3.0.
  const rows = [
    ...manyZips('sale', 1.2, 20, 'BK'),
    ...zip('sale', '11222', 4, 8, {count: 12, recentCount: 10}),
    ...zip('sale', '11223', 4, 12, {count: 6, recentCount: 2}),
  ];
  const premiums = measureNewBuildPremiums(rows, '2026-10-22');
  const brooklyn = scope(premiums, 'sale', 'BK').ratio;
  const own = scope(premiums, 'sale', 'zip:11222');
  assert.deepEqual([own.rawRatio, own.buildingCount, own.zipCount], [2, 10, 1]);
  assert.equal(own.ratio, Number(((10 * 2 + NEW_BUILD_PREMIUM.shrinkBuildings * brooklyn) / (10 + NEW_BUILD_PREMIUM.shrinkBuildings)).toFixed(2)));
  assert.equal(scope(premiums, 'sale', 'zip:11223'), undefined, 'two buildings are too few for a ZIP figure');
  const table = newBuildPremiumTable(premiums);
  assert.deepEqual(Object.keys(table.sale.zips).includes('11222'), true);
  assert.equal(newBuildPremiumFor(table, 'BK', '11222').sale.ratio, own.ratio);
  assert.equal(newBuildPremiumFor(table, 'BK', '11222').sale.toward, 'BK');
  assert.equal(newBuildPremiumFor(table, 'BK', '11223').sale, table.sale.boroughs.BK);
  assert.equal(newBuildPremiumFor(table, 'SI', '10301').sale, table.sale, 'no borough or ZIP figure: the citywide one');
});

test('a city closing and a listing in one building share its key; a unit with no street has none', () => {
  assert.equal(newBuildBuildingKey({zip_code: '10011', address: '500 WEST 18TH STREET, W8C'}), '10011|500 W 18 ST');
  assert.equal(newBuildBuildingKey({zip_code: '10011', address: '500 W 18th St (Unit #8C)', street_line: '500 W 18th St'}), '10011|500 W 18 ST');
  assert.equal(newBuildBuildingKey({zip_code: '10013', address: '330 Grand St # 4A # 4A', street_line: '330 Grand St # 4A'}), '10013|330 GRAND ST');
  assert.equal(newBuildBuildingKey({zip_code: '11211', address: '2100 Bedford Ave Apt 6H Apt 6H', street_line: '2100 Bedford Ave Apt 6H'}), '11211|2100 BEDFORD AVE');
  assert.equal(newBuildBuildingKey({zip_code: '11101', address: '23-15 44TH DRIVE, PH201'}), '11101|23-15 44 DR');
  assert.equal(newBuildBuildingKey({zip_code: '11101', address: ''}), null);
});

test('a borough with fewer buildings than the minimum has none and takes the citywide premium', () => {
  const rows = [...manyZips('rent', 1.4, 10, 'BK'), ...manyZips('rent', 3, 2, 'SI')];
  const premiums = measureNewBuildPremiums(rows, '2026-10-22');
  assert.equal(scope(premiums, 'rent', 'SI'), undefined, 'six Staten Island buildings');
  assert.ok(scope(premiums, 'rent', 'BK') && scope(premiums, 'rent', 'city'));
  assert.equal(scope(premiums, 'rent', 'city').pairCount, 36, 'they still count toward the citywide figure');
  const stored = {rent: {...scope(premiums, 'rent', 'city'), boroughs: {BK: scope(premiums, 'rent', 'BK')}}};
  assert.equal(newBuildPremiumFor(stored, 'SI').rent, stored.rent);
  assert.equal(newBuildPremiumFor(stored, 'BK').rent, stored.rent.boroughs.BK);
  assert.deepEqual(newBuildPremiumFor({}, 'BK'), {rent: null, sale: null});
  assert.deepEqual(newBuildPremiumFor(null, null), {rent: null, sale: null});
});

const lot = {
  listPrice: null, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 0,
  residFar: 4.0, affResFar: 5.01, zoningDistrict: 'R7A', address: '2 EXAMPLE AVENUE', borough: 'BK', zipCode: '11216',
  submarketSalePsf: 800, submarketSaleSample: {basis: 'closed', count: 40, cityClosedCount: 40, earliestSoldDate: '2024-10-02', latestSoldDate: '2026-09-30', windowMonths: 24}, submarketRentPsf: 4,
};
const premium = {rent: {scope: 'city', ratio: 1.25, rawRatio: 1.25, buildingCount: 80, pairCount: 134, zipCount: 50, windowYears: 12, asOf: '2026-10-22'}, sale: {scope: 'city', ratio: 1.5, rawRatio: 1.5, buildingCount: 300, pairCount: 900, zipCount: 40, windowYears: 12, asOf: '2026-10-22'}};

test('a measured ZIP median is scaled by the premium and the basis says how', () => {
  const plain = computeDealValuation(lot);
  const scaled = computeDealValuation({...lot, newBuildPremium: premium});
  assert.deepEqual([plain.valueDriver.landValue < scaled.valueDriver.landValue, plain.submarketRentPsf, scaled.submarketRentPsf, plain.submarketSalePsf, scaled.submarketSalePsf], [true, 4, 5, 800, 1200]);
  assert.deepEqual(scaled.newBuildPremium, {rent: 1.25, sale: 1.5});
  assert.deepEqual(plain.newBuildPremium, {rent: 1, sale: 1});
  const basis = Object.fromEntries(scaled.basis.map(b => [b.item, b]));
  assert.match(basis.submarketSalePsf.source, /^Median closed condo and co-op sale price per SF in this ZIP across 40 closings from 2024-10-02 to 2026-09-30, the last 24 months: .* Asking prices are left out\. Scaled by 1\.50, the median new-building premium citywide: 300 buildings completed in the last 12 years \(900 condominium and co-op closing prices per SF\), each building's median against the median of other units in its ZIP, across 40 ZIPs\.$/);
  assert.match(basis.submarketRentPsfMonth.source, /\(Realtor\.com via HomeHarvest\)\. Scaled by 1\.25, the median new-building premium citywide: 80 buildings completed in the last 12 years \(134 asking rents\), each building's median against the median of other units in its ZIP, across 50 ZIPs\.$/);
  assert.equal(basis.submarketRentPsfMonth.asOf, '2026-10-22');
  assert.doesNotMatch(JSON.stringify(scaled.basis), /—/);
  assert.doesNotMatch(JSON.stringify(plain.basis), /new-building premium/);
});

test('a borough premium is stated as the borough figure pulled toward the citywide one', () => {
  const manhattan = {scope: 'MN', ratio: 1.52, rawRatio: 1.53, buildingCount: 250, pairCount: 1340, zipCount: 40, windowYears: 12, asOf: '2026-10-22'};
  const valuation = computeDealValuation({...lot, borough: 'MN', newBuildPremium: {rent: premium.rent, sale: manhattan}});
  assert.equal(valuation.submarketSalePsf, 1216);
  const sale = valuation.basis.find(b => b.item === 'submarketSalePsf').source;
  assert.match(sale, /Scaled by 1\.52, the median new-building premium in Manhattan, 1\.53 from 250 buildings completed in the last 12 years \(1340 condominium and co-op closing prices per SF\), each building's median against the median of other units in its ZIP, across 40 ZIPs, pulled toward the citywide figure by 10 buildings' weight\.$/);
  assert.doesNotMatch(sale, /—/);
});

test('a ZIP premium is stated as the ZIP figure pulled toward its borough', () => {
  const zipPremium = {scope: 'zip:10027', ratio: 1.18, rawRatio: 1.1, buildingCount: 6, pairCount: 40, zipCount: 1, windowYears: 12, asOf: '2026-10-22', toward: 'MN'};
  const valuation = computeDealValuation({...lot, borough: 'MN', zipCode: '10027', newBuildPremium: {rent: premium.rent, sale: zipPremium}});
  assert.equal(valuation.submarketSalePsf, 944);
  const sale = valuation.basis.find(b => b.item === 'submarketSalePsf').source;
  assert.match(sale, /Scaled by 1\.18, the median new-building premium in ZIP 10027, 1\.10 from 6 buildings completed in the last 12 years \(40 condominium and co-op closing prices per SF\), each building's median against the median of other units in its ZIP, pulled toward Manhattan's figure by 10 buildings' weight\.$/);
  const city = computeDealValuation({...lot, newBuildPremium: {rent: premium.rent, sale: {...zipPremium, toward: 'city'}}}).basis.find(b => b.item === 'submarketSalePsf').source;
  assert.match(city, /pulled toward the citywide figure by 10 buildings' weight\.$/);
});

test('analyst tier figures are not measured medians, so the premium leaves them alone', () => {
  const tier = {...lot, submarketSalePsf: null, submarketSaleSample: null, submarketRentPsf: null};
  const scaled = computeDealValuation({...tier, newBuildPremium: premium});
  const plain = computeDealValuation(tier);
  assert.deepEqual([scaled.submarketRentPsf, scaled.submarketSalePsf], [plain.submarketRentPsf, plain.submarketSalePsf]);
  assert.deepEqual(scaled.newBuildPremium, {rent: 1, sale: 1});
  assert.doesNotMatch(JSON.stringify(scaled.basis), /new-building premium/);
});

test('a sync measures the premium by borough and the revalue path values listings with it', t => {
  const store = new MarketStore(':memory:');
  t.after(() => store.close());
  const rows = [];
  // Brooklyn: 24 buildings at 1.25. Queens: 9 buildings at 1.25, too few for its own figure. Every ZIP has
  // three new buildings (no street given, so each unit stands alone), enough for a ZIP figure.
  for (const [borough, zips, first] of [['BK', 8, 11210], ['QN', 3, 11430]]) {
    for (let z = 0; z < zips; z++) {
      const zipCode = String(first + z);
      for (let i = 0; i < 6; i++) rows.push({propertyId: `${zipCode}-old-${i}`, listingType: 'for_rent', zipCode, borough, beds: 1, sqft: 700, listPrice: 2800, rentPerSqftPerMonth: 4, yearBuilt: 1950, assetClass: 'condo_coop_apartment', lastUpdateDate: '2026-10-20'});
      for (let i = 0; i < 3; i++) rows.push({propertyId: `${zipCode}-new-${i}`, listingType: 'for_rent', zipCode, borough, beds: 1, sqft: 700, listPrice: 3500, rentPerSqftPerMonth: 5, yearBuilt: 2021, assetClass: 'condo_coop_apartment', lastUpdateDate: '2026-10-20'});
    }
  }
  store.ingestListings(rows, Date.parse('2026-10-22T12:00:00Z'));
  const stored = store.getNewBuildPremiums();
  assert.deepEqual(Object.keys(stored), ['rent'], 'no closings were ingested, so no sale premium');
  assert.deepEqual({...stored.rent, boroughs: undefined, zips: undefined}, {scope: 'city', ratio: 1.25, rawRatio: 1.25, buildingCount: 33, pairCount: 33, zipCount: 11, windowYears: 12, asOf: '2026-10-22', boroughs: undefined, zips: undefined});
  assert.deepEqual(Object.keys(stored.rent.boroughs), ['BK']);
  assert.deepEqual(stored.rent.boroughs.BK, {scope: 'BK', ratio: 1.25, rawRatio: 1.25, buildingCount: 24, pairCount: 24, zipCount: 8, windowYears: 12, asOf: '2026-10-22'});
  assert.equal(Object.keys(stored.rent.zips).length, 11);
  assert.deepEqual(stored.rent.zips['11430'], {scope: 'zip:11430', ratio: 1.25, rawRatio: 1.25, buildingCount: 3, pairCount: 3, zipCount: 1, windowYears: 12, asOf: '2026-10-22'});
  store.db.exec('DELETE FROM market_new_build_premiums');
  assert.deepEqual(store.getNewBuildPremiums(), {});
  store.revalueDealsWithSettings();
  assert.equal(store.getNewBuildPremiums().rent.ratio, 1.25, 'a revalue re-measures it');
});

test('a store with the first, citywide-only premiums table is upgraded', t => {
  const dir = mkdtempSync(join(tmpdir(), 'premiums-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, 'market.sqlite');
  const first = new MarketStore(path);
  first.db.exec(`DROP TABLE market_new_build_premiums; CREATE TABLE market_new_build_premiums (metric TEXT PRIMARY KEY, ratio REAL NOT NULL, pair_count INTEGER NOT NULL, zip_count INTEGER NOT NULL, window_years INTEGER NOT NULL, as_of TEXT NOT NULL);
    INSERT INTO market_new_build_premiums VALUES ('rent', 1.17, 134, 50, 12, '2026-10-22')`);
  first.close();
  const upgraded = new MarketStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.getNewBuildPremiums(), {}, 'the old rows are dropped; a revalue rebuilds them');
  upgraded.recomputeNewBuildPremiums();
  assert.equal(upgraded.query('PRAGMA table_info(market_new_build_premiums)').some(c => c.name === 'scope_key'), true);
});

test('a store with premiums counted by unit measures them again by building when it opens', t => {
  const dir = mkdtempSync(join(tmpdir(), 'premiums-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, 'market.sqlite');
  const first = new MarketStore(path);
  const rows = [];
  for (let z = 0; z < 8; z++) {
    const zipCode = String(11210 + z);
    for (let i = 0; i < 6; i++) rows.push({propertyId: `${zipCode}-old-${i}`, listingType: 'for_rent', zipCode, borough: 'BK', beds: 1, sqft: 700, listPrice: 2800, rentPerSqftPerMonth: 4, yearBuilt: 1950, assetClass: 'condo_coop_apartment', lastUpdateDate: '2026-10-20'});
    for (let i = 0; i < 3; i++) rows.push({propertyId: `${zipCode}-new-${i}`, listingType: 'for_rent', zipCode, borough: 'BK', beds: 1, sqft: 700, listPrice: 3500, rentPerSqftPerMonth: 5, yearBuilt: 2021, assetClass: 'condo_coop_apartment', lastUpdateDate: '2026-10-20'});
  }
  first.ingestListings(rows, Date.parse('2026-10-22T12:00:00Z'));
  first.db.exec(`DROP TABLE market_new_build_premiums; CREATE TABLE market_new_build_premiums (metric TEXT NOT NULL, scope_key TEXT NOT NULL, ratio REAL NOT NULL, raw_ratio REAL NOT NULL, pair_count INTEGER NOT NULL, zip_count INTEGER NOT NULL, window_years INTEGER NOT NULL, as_of TEXT NOT NULL, PRIMARY KEY (metric, scope_key));
    INSERT INTO market_new_build_premiums VALUES ('rent', 'city', 1.17, 1.17, 134, 50, 12, '2026-10-22')`);
  first.close();
  const upgraded = new MarketStore(path);
  t.after(() => upgraded.close());
  const rent = upgraded.getNewBuildPremiums().rent;
  assert.deepEqual([rent.ratio, rent.buildingCount, rent.pairCount], [1.25, 24, 24], 'measured again from the listings, with no revalue in between');
});
