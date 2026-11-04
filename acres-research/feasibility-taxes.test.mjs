import test from 'node:test';
import assert from 'node:assert/strict';
import {comparePrograms, JOINT_DOWNSIDE} from './feasibility.mjs';
import {computeProForma} from './proforma.mjs';

const market = {submarket: 'Hypothetical fixture', rents: [0, 1, 2].map(bedrooms => ({bedrooms, rentPerSqftPerMonth: 8, source: 'User', retrievedAt: '2026-10-17'}))};
const shared = {
  market, landPrice: 5_000_000, hardCostPerSqft: 400, softCostPerSqft: 100, capRate: 0.055,
  financing: {loanToCost: 0.6, interestRate: 0.07, termMonths: 30},
  operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 9000, commercialVacancyRate: 0, commercialOpexPerSqftPerYear: 0},
  program: {grossBuildingSqft: 99 * 900, units: [{bedrooms: 0, count: 30, netSqft: 450}, {bedrooms: 1, count: 50, netSqft: 650}, {bedrooms: 2, count: 19, netSqft: 900}]},
};
const fullTaxes = 99 * 12_000;
const incentive = {program: '485-x', option: 'B', location: {borough: 'BK', ntaCode: 'BK0101'}, fullAnnualTaxes: fullTaxes, baseAnnualTaxes: 150_000, discountRate: 0.07, construction: {start: '2026-07-01', months: 12}};
const marketRental = {label: 'Market rental', productType: 'rental', annualTaxes: fullTaxes};
const exempt = {label: '485-x Option B', productType: 'rental', taxIncentive: incentive};
const blend = {label: 'Affordable blend at full taxes', productType: 'rental', affordableShare: 0.2, affordableRentScale: 0.6, annualTaxes: fullTaxes};

test('an affordable variant carries its 485-x tax benefit and wins only because of it, with each variant\'s taxes disclosed', () => {
  const out = comparePrograms({shared, variants: [marketRental, blend, exempt]});
  assert.deepEqual(out.variants.map(v => v.label), ['485-x Option B', 'Market rental', 'Affordable blend at full taxes']);
  // The single pro forma is the oracle: the 485-x variant is that pro forma, and the market rental at the
  // same full taxes is the same deal without 485-x.
  const single = computeProForma({...shared, productType: 'rental', taxIncentive: incentive});
  const [winner, market, affordable] = out.variants;
  assert.equal(winner.profit, single.returns.profit);
  assert.equal(market.profit, single.taxIncentive.without485x.profit);
  assert.equal(winner.taxIncentive.profitWithout485x, market.profit);
  assert.ok(affordable.profit < market.profit, 'restricted rents without the exemption lose to market rents');
  assert.deepEqual([winner.taxIncentive.option, winner.taxIncentive.year1Taxes, winner.taxIncentive.fullAnnualTaxes], ['B', 150_000, fullTaxes]);
  assert.match(winner.taxBasis, /^485-x Option B: 20 restricted units at 80% AMI; year-one taxes \$150,000 against full taxes of \$1,188,000/);
  assert.equal(market.taxBasis, 'Real estate taxes stated for this variant: $1,188,000 a year on the completed building, no exemption.');
  assert.match(out.note, /taxBasis states the taxes it carries/);
  assert.equal(out.recommendation.label, '485-x Option B');
});

test('per-variant taxes are validated so every rental pays taxes on the same basis', () => {
  assert.throws(() => comparePrograms({shared, variants: [exempt, {label: 'Market rental', productType: 'rental'}]}), /485-x Option B carries its own real estate taxes.*give Market rental annualTaxes/);
  assert.throws(() => comparePrograms({shared, variants: [{...exempt, affordableShare: 0.2}, marketRental]}), /485-x sets its own restricted units/);
  assert.throws(() => comparePrograms({shared: {...shared, sellingCostRate: 0.06}, variants: [marketRental, {label: 'Condo', productType: 'condo', annualTaxes: 1000}]}), /taxes apply to rental and commercial variants only/);
  assert.throws(() => comparePrograms({shared, variants: [{...exempt, annualTaxes: fullTaxes}, marketRental]}), /taxIncentive or annualTaxes, not both/);
});

test('every variant reports a joint downside and a changed leader under it is named', () => {
  // Downside fixture of feasibility-downside.test.mjs: 20 one-bedrooms of 700 sq ft at $8, 20,000 gross sq ft.
  // Joint downside: rent $7.20 → GPR 1,209,600, EGI 1,149,120, NOI 949,120, value at 5.5% 17,256,727;
  // hard $220 and soft $55 → 5,500,000, interest 8% × 2 × 60% × (2,000,000 + 2,750,000) = 456,000,
  // cost 7,956,000; profit 9,300,727.
  const base = {
    market: {submarket: 'Hypothetical fixture', rents: [{bedrooms: 1, rentPerSqftPerMonth: 8, source: 'User', retrievedAt: '2026-10-17'}], salePrices: [{bedrooms: 1, pricePerSqft: 1200, source: 'User', retrievedAt: '2026-10-17'}]},
    program: {grossBuildingSqft: 20000, units: [{bedrooms: 1, count: 20, netSqft: 700}]}, landPrice: 2_000_000, hardCostPerSqft: 200, softCostPerSqft: 50,
    financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 24},
    operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 10000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 0}, capRate: 0.05, sellingCostRate: 0.06,
  };
  assert.deepEqual(JOINT_DOWNSIDE, {revenueScale: 0.9, costScale: 1.1, capRateBps: 50});
  const out = comparePrograms({shared: base, variants: [{label: 'Rental', productType: 'rental'}, {label: 'Condo', productType: 'condo'}]});
  const rental = out.variants.find(v => v.label === 'Rental');
  assert.equal(rental.jointDownsideProfit, 9_300_727);
  assert.equal(rental.jointDownsideProfitAfterCarry, 9_300_727);
  assert.ok(out.variants.every(v => Number.isFinite(v.jointDownsideProfit)));
  assert.match(out.rubric, /joint downside shocks every program at once/);
  // A condo at 1.35 times the sale price trails at base (net sellout 21,319,200 less 7,432,000 = 13,887,200)
  // but leads the joint downside, which spares it the cap rate: 20,412,000 less 6% = 19,187,280 less 7,956,000.
  const flipped = comparePrograms({shared: base, variants: [{label: 'Rental', productType: 'rental'}, {label: 'Condo', productType: 'condo', priceScale: 1.35}]});
  assert.deepEqual(flipped.variants.map(v => [v.label, v.rankingProfit, v.jointDownsideProfitAfterCarry]), [['Rental', 14_104_000, 9_300_727], ['Condo', 13_887_200, 11_231_280]]);
  assert.ok(flipped.recommendation.whatWouldChangeIt.includes("In the joint downside applied to every program (rents and prices 10% lower, hard and soft cost 10% higher, cap rate 50 bps higher), Condo would lead at $11,231,280 of profit after incremental approval carry against Rental's $9,300,727."));
  assert.ok(out.recommendation.whatWouldChangeIt.every(line => !/joint downside/.test(line)), 'no line when the leader holds');
});

test('Core shows each variant\'s taxes and joint downside', async () => {
  const {parseHTML} = await import('linkedom');
  globalThis.document = parseHTML('<html><head></head><body></body></html>').document;
  const {renderParcel} = await import('../app-starter/public/core-view.js');
  const comparison = comparePrograms({shared, variants: [marketRental, exempt]});
  const root = renderParcel({id: 'fixture', title: 'Hypothetical site', version: 1, fields: {comparisons: {value: [comparison], updated: 1, provenance: {sources: []}}}}, {canSend: false, canEdit: false});
  const row = name => [...root.querySelectorAll('#core-decide .core-compare tr')].find(tr => tr.querySelector('th')?.textContent === name);
  assert.deepEqual([...row('Taxes').querySelectorAll('td')].map(td => td.textContent), comparison.variants.map(v => v.taxBasis));
  assert.equal(row('Joint downside profit after approval carry').querySelectorAll('td').length, 2);
});
