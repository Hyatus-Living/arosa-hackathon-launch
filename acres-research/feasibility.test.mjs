import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {comparePrograms, createFeasibilityTools} from './feasibility.mjs';

const retrievedAt = '2026-10-12';
const market = {
  submarket: 'Financial District, Manhattan',
  rents: [
    {bedrooms: 0, rentPerSqftPerMonth: 8, source: 'StreetEasy market report', url: 'https://streeteasy.com/blog/data-dashboard/', retrievedAt},
    {bedrooms: 1, rentPerSqftPerMonth: 7, source: 'StreetEasy market report', url: 'https://streeteasy.com/blog/data-dashboard/', retrievedAt},
    {bedrooms: 2, rentPerSqftPerMonth: 6.5, source: 'User', retrievedAt},
    {bedrooms: 3, rentPerSqftPerMonth: 6, source: 'User', retrievedAt},
  ],
  salePrices: [{bedrooms: 1, pricePerSqft: 1800, source: 'User', retrievedAt}, {bedrooms: 2, pricePerSqft: 2000, source: 'User', retrievedAt}, {bedrooms: 3, pricePerSqft: 2200, source: 'User', retrievedAt}],
  commercialRents: [{use: 'retail', rentPerSqftPerYear: 150, source: 'REBNY retail report', retrievedAt}],
};
const shared = {
  market,
  program: {grossBuildingSqft: 100000, units: [{bedrooms: 0, count: 20, netSqft: 450}, {bedrooms: 1, count: 40, netSqft: 650}, {bedrooms: 2, count: 30, netSqft: 950}, {bedrooms: 3, count: 10, netSqft: 1250}], commercial: [{use: 'retail', netSqft: 5000}]},
  landPrice: 20_000_000, hardCostPerSqft: 450, softCostPerSqft: 100,
  financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 30},
  operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 12000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 5},
  capRate: 0.05, sellingCostRate: 0.06,
};

test('a compared program whose net area is its gross keeps the pro forma\'s core flag', () => {
  const out = comparePrograms({shared, variants: [
    {label: 'Cored', productType: 'rental'},
    {label: 'No core', productType: 'rental', program: {...shared.program, grossBuildingSqft: 81000}},
  ]});
  assert.equal(out.variants.find(v => v.label === 'Cored').assumptions, undefined);
  assert.match(out.variants.find(v => v.label === 'No core').assumptions.join(' '), /no core or circulation is deducted/);
});

test('programs compare on shared inputs with ordinal entitlement scores shown separately', () => {
  const out = comparePrograms({
    shared,
    variants: [
      {label: 'Market rental', productType: 'rental'},
      {label: 'UAP affordable', productType: 'rental', affordableShare: 0.2, affordableRentScale: 0.4, entitlementScore: 81, entitlementLabel: 'Universal Affordability Preference'},
      {label: 'Condo', productType: 'condo', program: {grossBuildingSqft: 70000, units: [{bedrooms: 1, count: 20, netSqft: 800}, {bedrooms: 2, count: 20, netSqft: 1200}, {bedrooms: 3, count: 10, netSqft: 1700}]}},
    ],
  });
  const rental = out.variants.find(v => v.label === 'Market rental');
  assert.equal(rental.profit, 25549000);
  assert.equal(rental.rankingProfit, 25549000);
  assert.equal(rental.downsideRentMinus10Profit, 12474100);
  const uap = out.variants.find(v => v.label === 'UAP affordable');
  assert.equal(uap.effectiveRentScale, 0.88);
  assert.equal(uap.noi, 4608956);
  assert.equal(uap.profit, 11479120);
  assert.equal(uap.rankingProfit, 11479120);
  // Condo on the shared (cheaper) cost base: sellout 114.2M net of 6% = 107.348M; budget
  // 20M + 31.5M + 7M = 58.5M plus carry 0.12 x 39.25M = 4.71M; profit 44.138M beats rental.
  const condo = out.variants.find(v => v.label === 'Condo');
  assert.equal(condo.profit, 44138000);
  assert.equal(condo.downsideRentMinus10Profit, 33403200);
  assert.equal(out.recommendation.label, 'Condo');
  assert.match(out.recommendation.whatWouldChangeIt[0], /Condo leads Market rental by \$18,589,000/);
  assert.equal(out.sources.length, 3);
});

test('losses are not discounted away by entitlement certainty', () => {
  const out = comparePrograms({
    shared: {...shared, landPrice: 120_000_000},
    variants: [
      {label: 'Market rental', productType: 'rental'},
      {label: 'UAP affordable', productType: 'rental', rentScale: 0.88, entitlementScore: 50},
    ],
  });
  const uap = out.variants.find(v => v.label === 'UAP affordable');
  assert.ok(uap.profit < 0);
  assert.equal(uap.rankingProfit, uap.profit);
});

test('rentScale on a condo variant is refused instead of silently changing nothing', () => {
  const condo = {label: 'Condo', productType: 'condo', program: {grossBuildingSqft: 70000, units: [{bedrooms: 1, count: 20, netSqft: 800}]}};
  assert.throws(() => comparePrograms({shared, variants: [{...condo, rentScale: 0.8}]}), /rentScale scales residential rents.*priceScale/);
  const out = comparePrograms({shared, variants: [{...condo, rentScale: 1}]});
  assert.equal(out.variants.length, 1, 'an explicit market rentScale of 1 stays allowed');
});

test('a commercial variant compares against residential on the same land, and rentScale moves its commercial rents', () => {
  const program = {grossBuildingSqft: 20000, units: [], commercial: [{use: 'retail', netSqft: 15000}]};
  const out = comparePrograms({shared, variants: [
    {label: 'Retail building', productType: 'commercial', program},
    {label: 'Retail at 80% rents', productType: 'commercial', program, rentScale: 0.8},
    {label: 'Market rental', productType: 'rental'},
  ]});
  const retail = out.variants.find(v => v.label === 'Retail building');
  const scaled = out.variants.find(v => v.label === 'Retail at 80% rents');
  assert.equal(retail.productType, 'commercial');
  assert.ok(retail.noi > 0 && retail.maxLandPrice != null, 'the commercial variant prices and solves a land price');
  assert.ok(scaled.noi < retail.noi, 'rentScale moves commercial rents on a commercial variant');
  assert.equal(scaled.effectiveRentScale, 0.8);
  assert.ok(out.recommendation, 'a recommendation still ranks every variant');
  // Residential-only terms are refused rather than silently priced around.
  assert.throws(() => comparePrograms({shared, variants: [{label: 'X', productType: 'commercial', program, affordableShare: 0.2}]}), /affordableShare requires a rental scenario/);
  assert.throws(() => comparePrograms({shared, variants: [{label: 'X', productType: 'commercial', program, priceScale: 1.1}]}), /priceScale moves condo sale prices/);
});

test('the tool wraps comparisons and the installer ships the module', async () => {
  const tools = createFeasibilityTools({getMarket: () => null});
  const out = await tools.handlers.acres_compare_programs({shared, variants: [{label: 'Rental', productType: 'rental'}, {label: 'Condo', productType: 'condo', program: {grossBuildingSqft: 70000, units: [{bedrooms: 1, count: 20, netSqft: 800}]}}]});
  assert.equal(out.variants.length, 2);
  assert.equal(tools.comparisons.length, 1);
  const installer = readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8');
  assert.match(installer, /\bfeasibility\.mjs\b/);
});

test('comparePrograms models explicit approval timeline carry cost and risk tiers alongside ordinal score', () => {
  const out = comparePrograms({
    shared,
    variants: [
      {label: 'As-of-right rental', productType: 'rental'},
      {label: 'Rezoning ULURP', productType: 'rental', entitlementScore: 50, timelineMonths: 18},
    ],
  });
  const aor = out.variants.find(v => v.label === 'As-of-right rental');
  const ulurp = out.variants.find(v => v.label === 'Rezoning ULURP');
  assert.equal(aor.entitlementRiskTier, 'unassessed');
  assert.equal(aor.entitlementCarryCost, 0);
  assert.equal(aor.profitAfterCarry, aor.profit);
  assert.equal(ulurp.entitlementRiskTier, 'discretionary-high');
  assert.equal(ulurp.approvalTimelineMonths, 18);
  // 20M land * 0.6 LTC * 0.08 rate * (18 / 12) = 1,440,000 carry cost
  assert.equal(ulurp.entitlementCarryCost, 1440000);
  assert.equal(ulurp.profitAfterCarry, ulurp.profit - 1440000);
});

const storeRentalMix = (n0, n1, n2, affordable = false) => [{type: 'studio', netSqft: 450, units: n0}, {type: 'oneBedroom', netSqft: 550, units: n1}, {type: 'twoBedroom', netSqft: 800, units: n2}].map(u => affordable ? {...u, affordable} : u);
const storeOptions = [
  {id: 'max_bonus', label: 'Most floor area', summary: 'Rental with 485-x Option B, 24,000 SF', program: {exit: 'rental', zfa: 24000, grossSqft: 27600, unitMix: [...storeRentalMix(8, 13, 7), ...storeRentalMix(2, 3, 2, true)], affordableZfa: 4000, affordableRentPsf: 2.8, taxProgram: {kind: '485-x', option: 'B'}}},
  {id: 'alternative', label: 'Alternative', summary: 'Rental, 20,000 SF', program: {exit: 'rental', zfa: 20000, grossSqft: 23000, unitMix: storeRentalMix(9, 14, 7), affordableZfa: 0, taxProgram: null}},
];
const storeIncentive = {program: '485-x', location: {borough: 'BK', ntaCode: 'BK0101'}, dofCapRate: 0.06, discountRate: 0.07, construction: {start: '2026-07-01', months: 24}};
const storeLedger = {taxes: () => ({annualTaxes: 150_000, assessedValue: 1_000_000, marketValue: 2_000_000, taxClass: '4', rate: 0.1, rateFiscalYear: 2026, assessmentFiscalYear: 2026, basis: 'fixture', crossCheck: null, sourceUrl: 'https://example.test', retrievedAt: '2026-10-20'})};
const storeMarket = {...market, salePrices: [{bedrooms: 0, pricePerSqft: 1700, source: 'User', retrievedAt}, ...market.salePrices]};
const {market: ignoredMarket, program: ignoredProgram, ...storeCosts} = shared;

test('site-option comparison reverses the ledger-tax ranking with completed-building taxes and saves each basis', async () => {
  const tools = createFeasibilityTools({getMarket: () => storeMarket, getStoreOptions: () => storeOptions, ledger: storeLedger});
  assert.ok(!tools.definitions[0].inputSchema.properties.shared.required.includes('program'), 'the public tool schema permits omitted-variant store comparisons without an agent-invented program');
  const out = await tools.handlers.acres_compare_programs({shared: {...storeCosts, taxSource: 'ledger'}, taxIncentive: storeIncentive});
  const bonus = out.variants.find(v => v.storeOption === 'max_bonus');
  const alternative = out.variants.find(v => v.storeOption === 'alternative');
  // The historical bad basis uses the lot's $150k current assessment for the finished alternative.
  const legacy = comparePrograms({shared: {...storeCosts, program: {grossBuildingSqft: 23000, units: [{bedrooms: 0, count: 9, netSqft: 450}, {bedrooms: 1, count: 14, netSqft: 550}, {bedrooms: 2, count: 7, netSqft: 800}]}}, variants: [
    {label: '485-x option', productType: 'rental', program: bonus.program, taxIncentive: {...storeIncentive, option: 'B'}},
    {label: 'Alternative', productType: 'rental', program: alternative.program, annualTaxes: 150_000},
  ]}, storeMarket, {taxes: storeLedger.taxes()});
  assert.equal(legacy.recommendation.label, 'Alternative', 'the undeveloped-lot tax line produces the known false winner');
  assert.equal(out.recommendation.label, bonus.label, 'completed-building taxes restore the 485-x winner');
  assert.match(bonus.taxBasis, /^485-x Option B/);
  assert.match(alternative.taxBasis, /completed building, no exemption/);
  assert.doesNotMatch(alternative.taxBasis, /Shared real estate taxes/);
  assert.ok(alternative.profit < legacy.variants.find(v => v.label === 'Alternative').profit);
});

test('site-option comparison rejects an explicit 485-x full-tax amount when it cannot price another building', async () => {
  const tools = createFeasibilityTools({getMarket: () => storeMarket, getStoreOptions: () => storeOptions, ledger: storeLedger});
  await assert.rejects(
    tools.handlers.acres_compare_programs({shared: {...storeCosts, taxSource: 'ledger'}, taxIncentive: {...storeIncentive, fullAnnualTaxes: 1_000_000, dofCapRate: undefined}}),
    /requires taxIncentive\.dofCapRate.*fullAnnualTaxes applies only to the 485-x building/,
  );
});

test('site-option comparison keeps partial-market options explicit rather than ranking them', async () => {
  const rentOnly = {...storeMarket, salePrices: undefined};
  const tools = createFeasibilityTools({getMarket: () => rentOnly, getStoreOptions: () => [...storeOptions, {id: 'condo', label: 'Condo', summary: 'Condo', program: {exit: 'condo', zfa: 10000, grossSqft: 12000, unitMix: storeRentalMix(2, 3, 1), affordableZfa: 0, taxProgram: null}}]});
  const out = await tools.handlers.acres_compare_programs({shared: storeCosts});
  assert.deepEqual(out.variants.map(v => v.storeOption), ['alternative']);
  assert.match(out.skippedStoreOptions.find(v => v.storeOption === 'condo').reason, /no sale price/);
});
