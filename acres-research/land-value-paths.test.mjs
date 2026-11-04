import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LedgerStore, developmentSiteSale, subjectLandPrice, DEVELOPMENT_SITE_SALES} from './ledger.mjs';
import {MarketStore, computeDealValuation, nearbyLandModel, nearbyLandSubject, parcelListingRow, NEARBY_LAND_MODEL, NYC_SUBSIDIZED_RENTAL} from './market-store.mjs';
import {nearbyLandLine, subsidizedLine} from '../app-starter/public/schemes-view.js';

const deed = (over = {}) => ({document_id: 'D1', doc_type: 'DEED', document_amt: '1500000', percent_trans: '100', recorded_datetime: '2025-06-01T00:00:00.000', ...over});
const filing = (date, type = 'New Building') => ({job_number: `J${date}`, job_type: type, filing_date: date});

test('a development-site sale is a whole-lot deed at a real price followed by a building or demolition filing', () => {
  const sale = developmentSiteSale({deed: deed(), lotCount: 1, filings: [filing('2026-02-10'), filing('2025-09-01', 'Full Demolition')]});
  assert.deepEqual(sale, {doc_id: 'D1', recorded_at: '2025-06-01', price: 1500000, filing_job: 'J2025-09-01', filing_type: 'Full Demolition', filed_at: '2025-09-01'});
  assert.ok(developmentSiteSale({deed: deed(), lotCount: 1, filings: [filing('2025-04-01')]}), 'a filing up to 90 days before the deed records counts');
  for (const [why, args] of [
    ['several lots', {deed: deed(), lotCount: 2, filings: [filing('2025-09-01')]}],
    ['nominal price', {deed: deed({document_amt: String(DEVELOPMENT_SITE_SALES.minAmount - 1)}), lotCount: 1, filings: [filing('2025-09-01')]}],
    ['part interest', {deed: deed({percent_trans: '50'}), lotCount: 1, filings: [filing('2025-09-01')]}],
    ['not a deed', {deed: deed({doc_type: 'MTGE'}), lotCount: 1, filings: [filing('2025-09-01')]}],
    ['filed long before', {deed: deed(), lotCount: 1, filings: [filing('2024-12-01')]}],
    ['filed long after', {deed: deed(), lotCount: 1, filings: [filing('2028-09-01')]}],
  ]) assert.equal(developmentSiteSale(args), null, why);
});

// Sales placed east of a point, 0.1 mile apart (about 0.00191 degrees of longitude at NYC's latitude).
const sales = (prices, {bbl = n => `30000000${String(n).padStart(2, '0')}`} = {}) => prices.map((pricePerBsf, i) => ({
  docId: `S${i}`, bbl: bbl(i), recordedAt: '2025-08-01', price: pricePerBsf * 10000, latitude: 40.68, longitude: -73.95 + (i + 1) * 0.00191, pricePerBsf,
}));
const here = {latitude: 40.68, longitude: -73.95, bbl: '3999990001'};

// Comps with the traits the nearby model compares: 5,000 SF lots with 10,000 SF as of right and nothing standing.
const traitSales = prices => sales(prices).map(c => ({...c, lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0}));
const twin = {...here, lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0, corner: false};

test('the nearby model adjusts each sale to the lot and takes the median weighted by distance', () => {
  const m = NEARBY_LAND_MODEL, centre = Math.exp(m.constant);
  // Twins of the lot: no adjustment. Weights e^-0.1 ... e^-0.5 reach half their total at the third price.
  const plain = nearbyLandModel(traitSales([100, 200, 300, 400, 500, 600]), twin);
  assert.equal(plain.pricePerBsf, Math.round(300 * centre));
  assert.deepEqual(plain.model.comps.map(c => c.adjustments), Array(6).fill({building: 1, far: 1, units: 1, lotArea: 1}));
  assert.deepEqual(plain.model.comps.map(c => c.weight), [0.905, 0.819, 0.741, 0.67, 0.606, 0.549]);
  // Each trait moves the price by its measured factor.
  const at = subject => nearbyLandModel(traitSales([300, 300, 300, 300, 300, 300]), {...twin, ...subject}).pricePerBsf;
  assert.equal(at({corner: true}), Math.round(300 * Math.exp(m.corner) * centre), 'a corner lot, 19% more');
  assert.equal(at({existingSf: 5000}), Math.round(300 * Math.exp(m.existingShare * 0.5) * centre), 'a building half the buildable area, 41% more');
  assert.equal(at({zfa: 20000}), Math.round(300 * 2 ** m.far * centre), 'twice the FAR, 23% less per SF');
  assert.equal(at({unitsRes: 10}), Math.round(300 * 11 ** m.units * centre), 'ten apartments, 30% less');
  assert.equal(at({lotArea: 10000, zfa: 20000}), Math.round(300 * 2 ** m.lotArea * centre), 'a lot twice as large at the same FAR, 8% less per SF');
  // A far sale with an extreme price weighs less than the near ones.
  assert.equal(nearbyLandModel(traitSales([300, 300, 300, 1000, 1000, 1000]), twin).pricePerBsf, Math.round(300 * centre));
  assert.equal(nearbyLandModel(traitSales([300, 300, 300, 300, 300]), twin), null, 'five sales say nothing: no composite from fewer than six');
  assert.equal(nearbyLandModel(traitSales([300, 300, 300, 300, 300, 300]), {...twin, zfa: 0}), null, 'no as-of-right area, no figure');
  // The 200% standing-building ceiling states itself where it binds.
  const capped = nearbyLandModel(traitSales([300, 300, 300, 300, 300, 300]), {...twin, existingSf: 25000});
  assert.equal(capped.model.existingShareCappedAt, 2);
  assert.equal(capped.model.existingShareUncapped, 2.5);
  assert.equal(capped.pricePerBsf, Math.round(300 * Math.exp(m.existingShare * 2) * centre));
});

const lot = {listPrice: 2_000_000, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 3, affResFar: 3.9, zoningDistrict: 'R6A', borough: 'BX', zipCode: '10456'};
// A lot large enough for 50 or more units at low rents and sale prices, appraised by nearby sales; and at high ones.
const appraisedLand = {pricePerBsf: 120, saleCount: 9, withinMiles: 0.7, months: DEVELOPMENT_SITE_SALES.months, asOf: '2026-09-30', inBorough: true};

test('the nearby land value is the nearby price on the lot\'s as-of-right area', () => {
  const v = computeDealValuation({...lot, appraisedLand});
  assert.deepEqual(v.nearbyLand, {perBuildableSqft: 120, sales: 9, radiusMiles: 0.7, months: DEVELOPMENT_SITE_SALES.months, asOf: '2026-09-30', inBorough: true, value: 120 * v.maxStandardZfa, model: null});
  assert.equal(computeDealValuation(lot).nearbyLand, null, 'fewer than five nearby sales, none');
});
const large = {...lot, listPrice: 6_000_000, lotArea: 20000, lotFront: 200, submarketRentPsf: 3.2, submarketSalePsf: 520, appraisedLand};
const highMarket = {...large, submarketRentPsf: 9, submarketSalePsf: 2200};
const uncapped = v => ({...v, appraisedLand: {...appraisedLand, pricePerBsf: 1e6}});

test('a building of 50 or more units may be a city-financed rental at the program rents, with the loans and credits set against its cost', () => {
  const f = NYC_SUBSIDIZED_RENTAL;
  assert.equal(computeDealValuation({...lot, appraisedLand}).subsidizedRental, null, 'HDC finances no building under 50 units');
  assert.equal(computeDealValuation({...large, appraisedLand: null}).subsidizedRental, null, 'without nearby sales to appraise the land the path is not priced');
  const v = computeDealValuation({...uncapped(large), withCandidates: true});
  const s = v.subsidizedRental;
  assert.ok(s.units >= f.minUnits && Number.isInteger(s.landValue) && !s.capped);
  assert.equal(s.amiPct, f.amiPct);
  assert.equal(s.subsidyPerUnit, Math.round((s.units * f.hpdSubsidyPerUnit + Math.min(s.units * f.hdcSubsidyPerUnit, f.hdcSubsidyCapPerProject)) / s.units));
  assert.match(s.basis, /HPD ELLA term sheet, updated 2020-03-10.*HDC ELLA term sheet/);
  assert.ok(s.taxCreditEquity > 0, 'the 4% credits pay into the building');
  const c = v.candidates.find(x => x.taxProgram?.kind === 'city-financed' && x.zfa === s.zfa);
  assert.equal(c.returns.landValue, s.landValue);
  assert.equal(c.affordableZfa, c.zfa, 'every unit is affordable');
  assert.ok(c.unitMix.filter(u => u.units > 0).every(u => u.affordable));
  assert.equal(c.returns.profit, c.returns.completedValue + c.returns.publicFunding - c.returns.totalCost);
  // The loans are worth their full amount on the land: more subsidy, more land value, unit for unit, up to HDC's cap.
  const terms = {...f};
  f.hpdSubsidyPerUnit += 10000;
  try { assert.ok(Math.abs(computeDealValuation(uncapped(large)).subsidizedRental.landValue - (s.landValue + 10000 * s.units)) <= 1); }
  finally { Object.assign(f, terms); }
  f.hdcSubsidyCapPerProject = 0;
  try { assert.ok(Math.abs(computeDealValuation(uncapped(large)).subsidizedRental.landValue - (s.landValue - s.units * f.hdcSubsidyPerUnit)) <= 1, 'the HDC loan is capped per project'); }
  finally { Object.assign(f, terms); }
  assert.ok(v.basis.some(b => b.item === 'cityFinancedRental'));
});

test('the land price basis names the lot\'s borough only where its sales were kept to it', () => {
  const store = {landPriceEstimate: () => ({estimate: null, reason: 'no deeds on the block', sales: []}), lastSyncedAt: () => '2026-10-01'};
  const basis = inBorough => subjectLandPrice(store, {bbl: '3000010001', lotarea: '5000', zonedist1: 'R6A'}, {now: new Date('2026-10-26'),
    nearbyLand: () => ({value: 1_200_000, perBuildableSqft: 120, buildableSqft: 10000, sales: 9, radiusMiles: 0.7, months: 24, asOf: '2026-09-30', inBorough, model: {comps: []}})}).basis;
  assert.match(basis(true), /9 development-site sales in the lot's borough within 0\.7 miles/);
  assert.match(basis(false), /9 development-site sales within 0\.7 miles/);
});

test('the city-financed land value is capped at the appraised value nearby sales give the lot', () => {
  const free = computeDealValuation(uncapped(large)).subsidizedRental;
  const v = computeDealValuation(large);
  const cap = appraisedLand.pricePerBsf * v.maxStandardZfa;
  assert.ok(free.landValue > cap, 'the program terms alone would pay more than the land appraises at');
  assert.deepEqual([v.subsidizedRental.landValue, v.subsidizedRental.capped], [Math.round(cap), true]);
  assert.ok(v.subsidizedRental.uncappedLandValue > cap && v.subsidizedRental.uncappedLandValue <= free.landValue, 'what the building would pay without the cap');
  assert.match(v.subsidizedRental.basis, /capped at appraised land value \(nearby sales\): \$[\d,]+, \$120 per as-of-right buildable SF, the median of 9 development-site sales in the lot's borough within 0\.7 miles/);
  assert.match(v.gates.find(g => g.id === 'city_financing').detail, /capped at appraised land value \(nearby sales\)/);
  assert.match(v.basis.find(b => b.item === 'cityFinancedRental').source, /development-site sales in its borough within a mile;/);
  // A lot without a BBL reads every borough's sales, and neither basis claims otherwise.
  const anywhere = computeDealValuation({...large, appraisedLand: {...appraisedLand, inBorough: false}});
  assert.match(anywhere.subsidizedRental.basis, /the median of 9 development-site sales within 0\.7 miles/);
  assert.match(anywhere.basis.find(b => b.item === 'cityFinancedRental').source, /development-site sales within a mile;/);
  assert.equal(v.valueDriver.cityFinancing.appraisal.landCap, Math.round(cap));
  // The cap holds at every return target, so a lower target cannot lift the land above the appraisal.
  assert.ok(v.badDealMinLandValue < computeDealValuation(uncapped(large)).badDealMinLandValue, 'the fair threshold rests on the capped land, not the uncapped residual');
});

test('the city-financed rental sets the land value only where it pays the most, and holds the tier for review', () => {
  const low = computeDealValuation(large);
  assert.deepEqual([low.valueDriver.exit, low.valueDriver.taxes], ['rental', 'city-financed']);
  assert.equal(low.valueDriver.landValue, low.subsidizedRental.landValue);
  assert.ok(low.subsidizedRental.leads);
  assert.deepEqual([low.valueDriver.cityFinancing.units, low.valueDriver.cityFinancing.amiPct], [low.subsidizedRental.units, NYC_SUBSIDIZED_RENTAL.amiPct]);
  assert.equal(low.valueDriver.taxShareOfNoi, 0, 'no real estate taxes');
  assert.match(low.gates.find(g => g.id === 'city_financing').detail, /award these loans project by project/);
  assert.notEqual(low.dealVerdict, 'great_deal', 'an award to confirm caps the tier at Good');
  const marketOnly = computeDealValuation({...large, appraisedLand: null});
  assert.ok(low.valueDriver.landValue > marketOnly.valueDriver.landValue, 'chosen because it pays more than any market-rate building');
  const high = computeDealValuation(highMarket);
  assert.notEqual(high.valueDriver.taxes, 'city-financed');
  assert.ok(high.subsidizedRental && !high.subsidizedRental.leads && high.valueDriver.landValue > high.subsidizedRental.landValue);
  assert.ok(!high.gates.some(g => g.id === 'city_financing'));
});

test('the store prices each ledger sale per buildable SF of its own lot and serves the nearby price with a lot\'s valuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-comps-'));
  try {
    const ledger = new LedgerStore(join(dir, 'ledger.sqlite'));
    // Six sales a month ago and one recorded today, which no buyer could have known of yet.
    for (const [i, s] of sales([150, 250, 200, 300, 100, 200, 900]).entries()) {
      ledger.upsertDevelopmentSiteSale({doc_id: s.docId, bbl: s.bbl, recorded_at: new Date(Date.now() - (i === 6 ? 0 : 30) * 86400000).toISOString().slice(0, 10), price: s.price,
        filing_job: `J${i}`, filing_type: 'New Building', filed_at: '2026-01-01', zip: '11216', latitude: s.latitude, longitude: s.longitude,
        pluto_json: JSON.stringify({bbl: s.bbl, lotarea: '2500', lotfront: '25', lotdepth: '100', lottype: '5', residfar: '2', affresfar: '0', zonedist1: 'R6B', borough: 'BK', zipcode: '11216', latitude: s.latitude, longitude: s.longitude}),
        query_url: 'https://data.cityofnewyork.us', fetched_at: '2026-10-22'});
    }
    assert.equal(ledger.developmentSiteSales().length, 7);
    ledger.close();
    const market = new MarketStore(join(dir, 'market.sqlite'));
    market.ledgerPath = join(dir, 'ledger.sqlite');
    const comps = market.landComps();
    assert.equal(comps.length, 7);
    const another = new MarketStore(join(dir, 'market-2.sqlite'));
    another.ledgerPath = join(dir, 'ledger.sqlite');
    assert.equal(another.landComps(), comps, 'priced once and shared by every store until the ledger changes');
    another.close();
    assert.ok(comps.every(c => c.pricePerBsf > 0 && Math.abs(c.pricePerBsf * 5000 - c.price) / c.price < 0.2), 'each sale over its own lot\'s as-of-right floor area');
    const parcel = {bbl: here.bbl, lotarea: '5000', lotfront: '50', lotdepth: '100', lottype: '5', residfar: '3', affresfar: '3.9', zonedist1: 'R6A', borough: 'BK', zipcode: '11216', latitude: '40.68', longitude: '-73.95'};
    const result = market.lotValuation({bbl: null, property: parcel});
    assert.equal('marketLand' in result, false, 'one nearby land figure: the adjusted one the tier uses');
    // The nearby price, the appraisal for the city-financed path and the tier's basis, count only sales
    // recorded before today, read once per lot.
    const today = new Date().toISOString().slice(0, 10), monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    // Each ledger sale carries the traits the nearby model compares.
    assert.ok(comps.every(c => c.zfa > 0 && c.lotArea === 2500 && c.existingSf === 0 && c.unitsRes === 0));
    const row = {...parcelListingRow(parcel), bbl: here.bbl};
    const expected = nearbyLandModel(comps.filter(c => c.recordedAt < today), nearbyLandSubject(row));
    const appraisal = market.appraisedLandFor(row);
    assert.deepEqual(appraisal, expected);
    assert.deepEqual([appraisal.saleCount, appraisal.months, appraisal.asOf], [6, DEVELOPMENT_SITE_SALES.months, monthAgo], 'today\'s sale is left out');
    assert.deepEqual(result.nearbyLand, {perBuildableSqft: expected.pricePerBsf, sales: 6, radiusMiles: expected.withinMiles, months: DEVELOPMENT_SITE_SALES.months, asOf: monthAgo, inBorough: true,
      value: expected.pricePerBsf * result.valuation.maxStandardZfa, model: expected.model});
    assert.equal(market.appraisedLandFor(row), market.appraisedLandFor(row), 'read once per lot');
    assert.equal(market.appraisedLandFor({...row, latitude: 40.9}), null, 'no sales within a mile, no appraisal');
    market.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the options section says what land sells for nearby and what the city-financed rental pays', () => {
  assert.equal(nearbyLandLine({perBuildableSqft: 162, sales: 12, radiusMiles: 0.84, months: 24, value: 1940000, asOf: '2026-10-23'}),
    '12 development-site sales within 0.8 miles over the last 24 months put this lot at $162 per buildable SF, about $1.94M for this site\'s as-of-right floor area.');
  assert.match(nearbyLandLine({perBuildableSqft: 214, sales: 15, radiusMiles: 0.53, months: 24, value: 2495240, asOf: '2026-06-24', model: {comps: []}}),
    / Each nearby sale is adjusted to this lot for its standing building, FAR, existing apartments and lot size, then weighted by distance\.$/);
  assert.equal(nearbyLandLine(null), null);
  assert.match(subsidizedLine({landValue: 850000, units: 40, amiPct: 54, subsidyPerUnit: 187500, taxCreditEquity: 6200000}), /^With city financing, an all-affordable rental of 40 units at 54% AMI rents pays \$0\.85M for the land, counting up to \$187,500 a unit of HPD and HDC loans and \$6\.20M of 4% tax credit equity\.$/);
  assert.match(subsidizedLine({landValue: -5, units: 40, amiPct: 54, subsidyPerUnit: 187500, taxCreditEquity: 1}), /pays nothing for the land/);
});
