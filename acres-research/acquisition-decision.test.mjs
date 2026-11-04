import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {comparePrograms, createFeasibilityTools, feasibilityDefinition} from './feasibility.mjs';
import {computeProForma} from './proforma.mjs';

// Hypothetical fixture: a small for-sale program on a stated land price.
const shared = {
  market: {submarket: 'Hypothetical fixture', salePrices: [{bedrooms: 3, pricePerSqft: 900, source: 'User', retrievedAt: '2026-10-19'}], rents: [{bedrooms: 3, rentPerSqftPerMonth: 3, source: 'User', retrievedAt: '2026-10-19'}]},
  program: {grossBuildingSqft: 14000, units: [{bedrooms: 3, count: 7, netSqft: 1900}]},
  landPrice: 1_300_000, hardCostPerSqft: 400, softCostPerSqft: 80,
  financing: {loanToCost: 0.6, interestRate: 0.09, termMonths: 24},
  operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 9000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 0},
  capRate: 0.06, sellingCostRate: 0.06, targetReturnOnCost: 0.2,
};
const proForma = (changes = {}) => {
  const {targetReturnOnCost: _t, ...args} = {...shared, ...changes};
  return computeProForma({productType: 'condo', ...args});
};

test('one viable program is enough for an acquisition decision', () => {
  const out = comparePrograms({shared, variants: [{label: 'Sell the homes', productType: 'condo'}]});
  assert.equal(out.variants.length, 1);
  assert.equal(out.recommendation.label, 'Sell the homes');
  assert.deepEqual(out.recommendation.whatWouldChangeIt, []);
  assert.equal(out.decision.call, 'supports_price');
  assert.equal(out.decision.landPrice, 1_300_000);
  assert.match(out.decision.verdict, /supports the \$1,300,000 land price at a 20% return on cost/);
});

test('the highest land price earns exactly the target return and the revenue change reaches it at the stated price', () => {
  const [v] = comparePrograms({shared, variants: [{label: 'Sell', productType: 'condo'}]}).variants;
  assert.ok(Math.abs(proForma({landPrice: v.maxLandPrice}).returns.unleveredReturnOnCost - 0.2) < 0.0005);
  assert.equal(v.landHeadroom, v.maxLandPrice - 1_300_000);
  const scaled = {...shared.market, salePrices: shared.market.salePrices.map(p => ({...p, pricePerSqft: p.pricePerSqft * (1 + v.requiredRevenueChange)}))};
  assert.ok(Math.abs(proForma({market: scaled}).returns.unleveredReturnOnCost - 0.2) < 0.0005);
  assert.ok(v.requiredRevenueChange < 0, 'a supported price has room for rents and prices to fall');
});

test('a price above the residual says what the land is worth and what revenue the price needs', () => {
  const below = comparePrograms({shared: {...shared, landPrice: 4_000_000}, variants: [{label: 'Sell', productType: 'condo'}]}).decision;
  assert.equal(below.call, 'below_price');
  assert.ok(below.maxLandPrice > 0 && below.maxLandPrice < 4_000_000 && below.requiredRevenueChange > 0);
  assert.match(below.verdict, /does not support \$4,000,000 at a 20% return on cost: it justifies at most \$[\d,]+, or needs rents and prices \+[\d.]+%/);
  const none = comparePrograms({shared: {...shared, market: {...shared.market, salePrices: [{...shared.market.salePrices[0], pricePerSqft: 450}]}}, variants: [{label: 'Sell', productType: 'condo'}]}).decision;
  assert.equal(none.call, 'no_land_value');
  assert.ok(none.maxLandPrice < 0, 'a negative residual is reported, not floored');
  assert.match(none.verdict, /leaves no land value at a 20% return on cost \(residual -\$[\d,]+\)/);
});

test('incremental approval carry lowers the land price a target allows, and an unstated hurdle is break-even', () => {
  const variants = [{label: 'As of right', productType: 'condo'}, {label: 'After approval', productType: 'condo', timelineMonths: 18, entitlementScore: 50}];
  const out = comparePrograms({shared, variants});
  const plain = out.variants.find(v => v.label === 'As of right'), delayed = out.variants.find(v => v.label === 'After approval');
  assert.ok(delayed.maxLandPrice < plain.maxLandPrice);
  assert.equal(out.decision.label, out.recommendation.label);
  const {targetReturnOnCost: _t, ...noHurdle} = shared;
  const even = comparePrograms({shared: noHurdle, variants: [{label: 'Sell', productType: 'condo'}]}).decision;
  assert.equal(even.targetReturnOnCost, 0);
  assert.match(even.verdict, /at break-even/);
  assert.ok(Math.abs(proForma({landPrice: even.maxLandPrice}).returns.profit) < 2);
  assert.throws(() => comparePrograms({shared: {...shared, targetReturnOnCost: 2}, variants: [{label: 'Sell', productType: 'condo'}]}), /targetReturnOnCost must be a number from 0 to 1/);
});

test('the tool schema takes a target return and a single variant, and the saved comparison carries the decision', async () => {
  assert.equal(feasibilityDefinition.inputSchema.properties.variants.minItems, 1);
  assert.equal(feasibilityDefinition.inputSchema.properties.shared.properties.targetReturnOnCost.maximum, 1);
  const tools = createFeasibilityTools();
  const result = await tools.handlers.acres_compare_programs({shared, variants: [{label: 'Sell', productType: 'condo'}]});
  assert.equal(tools.comparisons[0].decision.call, result.decision.call);
});

test('the site page decision step shows the verdict and each program\'s land price at the target', async () => {
  const {document} = parseHTML('<html><head></head><body></body></html>'); globalThis.document = document;
  const {renderParcel} = await import('../app-starter/public/core-view.js');
  const comparison = comparePrograms({shared: {...shared, landPrice: 4_000_000}, variants: [{label: 'Sell', productType: 'condo'}, {label: 'Rent', productType: 'rental'}]});
  const root = renderParcel({id: 'fixture', title: 'Hypothetical site', version: 1, fields: {comparisons: {value: [comparison], updated: 1, provenance: {sources: []}}}}, {canSend: false, canEdit: false});
  assert.ok(root.textContent.includes(comparison.decision.verdict));
  const rows = [...root.querySelectorAll('#core-decide .core-compare tr')];
  const land = rows.find(row => row.querySelector('th')?.textContent === 'Highest land price at the target return');
  assert.equal(land.querySelectorAll('td').length, 2);
  const revenue = rows.find(row => row.querySelector('th')?.textContent === 'Rent and price change the land price needs');
  assert.match(revenue.querySelector('td').textContent, /^\+\d/);
});
