// Line-item development budget. The deal valuation prices a scheme as land, hard cost, soft cost, the
// 485-x wage floor and carry; this splits those same dollars into the lines a developer's budget shows,
// so the lines always add up to the valuation's total cost. The default shares are planning figures
// kept with their source in budget-splits.json; an account may set its own shares.
import {readFileSync} from 'node:fs';
import {DEAL_SCREEN_ASSUMPTIONS} from './market-store.mjs';

export const BUDGET_SPLITS = JSON.parse(readFileSync(new URL('./budget-splits.json', import.meta.url), 'utf8'));

const GROUPS = [
  {key: 'land', label: 'Land and acquisition'},
  {key: 'hard', label: 'Hard costs'},
  {key: 'soft', label: 'Soft costs'},
  {key: 'financing', label: 'Financing and carry'},
];
const SPLIT_GROUPS = {hard: 'Hard cost', soft: 'Soft cost'};

export const DEFAULT_BUDGET_SPLITS = Object.fromEntries(Object.keys(SPLIT_GROUPS).map(group => [group, Object.fromEntries(BUDGET_SPLITS[group].map(l => [l.key, l.share]))]));

const usd = n => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (n, d = 1) => `${Number((n * 100).toFixed(d))}%`;

// An account's own shares: every line of each group, each from 0 to 100%, adding up to 100%.
export function normalizeBudgetSplits(input) {
  if (!input || typeof input !== 'object') throw new Error('Budget shares must list the hard and soft cost lines.');
  return Object.fromEntries(Object.entries(SPLIT_GROUPS).map(([group, name]) => {
    const given = input[group] || {};
    const shares = Object.fromEntries(BUDGET_SPLITS[group].map(line => {
      const share = Number(given[line.key]);
      if (given[line.key] === null || given[line.key] === '' || !Number.isFinite(share) || share < 0 || share > 1) throw new Error(`${name} share for ${line.label.toLowerCase()} must be from 0 to 100%.`);
      return [line.key, Number(share.toFixed(4))];
    }));
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.0005) throw new Error(`${name} shares add up to ${pct(sum)}; they must add up to 100%.`);
    return [group, shares];
  }));
}

// Whole dollars in proportion to the weights, adding up exactly to the total (largest remainder).
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error('Budget shares leave nothing to allocate.');
  const raw = weights.map(w => total * w / sum);
  const out = raw.map(Math.floor);
  const order = raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]);
  const short = total - out.reduce((a, b) => a + b, 0);
  for (let k = 0; k < short; k++) out[order[k][1]] += 1;
  return out;
}

// A group split by its shares; the elevator line drops out of a walk-up and its share goes to the rest.
function splitLines(group, amount, shares, {elevator, of}) {
  const rows = BUDGET_SPLITS[group].filter(line => elevator || !line.elevatorOnly);
  const weights = rows.map(line => shares[group][line.key]);
  const sum = weights.reduce((a, b) => a + b, 0);
  return allocate(amount, weights).map((value, i) => ({group, key: rows[i].key, label: rows[i].label, amount: value, basis: `${pct(weights[i] / sum)} of ${of}`, note: rows[i].note}));
}

function assemble({grossSqft, elevator, splits, parts, landLines, hardOf, softOf, wageBasis, financingBasis}) {
  const shares = splits ?? DEFAULT_BUDGET_SPLITS;
  const lines = [
    ...landLines.map((line, i) => ({group: 'land', ...line, amount: parts.land[i]})).filter(line => line.amount > 0 || line.key === 'landPrice'),
    ...splitLines('hard', parts.hard, shares, {elevator, of: hardOf}),
    ...splitLines('soft', parts.soft, shares, {elevator, of: softOf}),
    ...(parts.wagePremium > 0 ? [{group: 'soft', key: 'wageFloorPremium', label: '485-x construction wage floor', amount: parts.wagePremium, basis: wageBasis}] : []),
    {group: 'financing', key: 'financing', label: 'Financing and carry', amount: parts.financing, basis: financingBasis},
  ];
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const shaped = lines.map(l => ({...l, perGsf: Number((l.amount / grossSqft).toFixed(2)), pct: Number((l.amount / total).toFixed(4))}));
  const groups = GROUPS.map(g => {
    const amount = shaped.filter(l => l.group === g.key).reduce((a, l) => a + l.amount, 0);
    return {...g, amount, perGsf: Number((amount / grossSqft).toFixed(2)), pct: Number((amount / total).toFixed(4))};
  });
  return {lines: shaped, groups, total, grossSqft, basis: {asOf: BUDGET_SPLITS.asOf, source: BUDGET_SPLITS.source, splits: splits ? 'custom' : 'default'}};
}

// One scheme's budget from the deal valuation's cost components (scheme.returns.costs, unrounded) at
// the account's costs, in whole dollars that add up exactly to the scheme's total cost; costs.splits
// holds the account's own shares, or null for the defaults.
export function budgetFor(scheme, costs = {}) {
  const {returns: {costs: c, totalCost, landBasis}} = scheme;
  const weights = [c.land, c.transferTax, c.closingCosts, c.hardCost, c.softCost, c.wagePremium, c.financing];
  const exact = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(exact - totalCost) > 1) throw new Error(`Budget components total ${usd(exact)}, not the valuation's ${usd(totalCost)}.`);
  const [land, transferTax, closingCosts, hard, soft, wagePremium, financing] = allocate(totalCost, weights);
  const ask = landBasis === 'ask';
  const budget = assemble({
    grossSqft: c.grossSqft,
    elevator: scheme.program.storeys > DEAL_SCREEN_ASSUMPTIONS.walkUpMaxStoreys,
    splits: costs.splits ?? null,
    parts: {land: [land, transferTax, closingCosts], hard, soft, wagePremium, financing},
    landLines: [
      {key: 'landPrice', label: ask ? 'Purchase price' : 'Land value', basis: ask ? 'The asking price' : 'What this building can pay for the land at your good-deal return'},
      {key: 'transferTax', label: 'Transfer taxes', basis: `${pct(c.transferTax / c.land, 2)} of the price`},
      {key: 'closingCosts', label: 'Closing costs', basis: `${pct(c.closingCosts / c.land, 2)} of the price`},
    ],
    hardOf: 'hard cost',
    softOf: `soft cost, itself ${pct(c.softCost / c.hardCost)} of hard cost`,
    wageBasis: `${pct(c.wagePremium / (c.hardCost + c.softCost), 2)} on hard and soft cost for the Option A construction wage floor`,
    financingBasis: `${pct(c.financing / (c.land + c.transferTax + c.closingCosts + c.hardCost + c.softCost + c.wagePremium))} of land, hard and soft cost`,
  });
  return {...budget, basis: {...budget.basis, hardCostPerGrossSqft: c.hardCostPerGrossSqft, ...(c.hardCostBasis ? {hardCostBasis: c.hardCostBasis} : {}), land: ask ? 'ask' : 'land_value'}};
}

// Each built scheme's budget at the owner's shares, saved through setSchemePart only when it changed, so
// a cost or share change reaches a scheme that kept its part because the building stayed the same.
// store is the ChatStore; view its schemesView. Returns the view after any writes.
export function fillSchemeBudgets(store, projectId, view, splits = null) {
  let out = view;
  for (const scheme of view.schemes || []) {
    if (!scheme.program) continue;
    const budget = budgetFor(scheme, {splits});
    if (JSON.stringify(budget) !== JSON.stringify(scheme.budget)) out = store.setSchemePart(projectId, scheme.id, 'budget', budget);
  }
  return out;
}

// The acres_pro_forma development budget as lines: dev is its unrounded budget, baseHardCost the hard
// cost before any wage floor premium. The lines add up to the rounded total development cost.
export function proFormaBudget(dev, {grossSqft, storeys, baseHardCost, splits = null}) {
  const [land, hard, wagePremium, soft, financing] = allocate(Math.round(dev.totalDevelopmentCost), [dev.landPrice, baseHardCost, dev.hardCost - baseHardCost, dev.softCost, dev.interestCarry]);
  return assemble({
    grossSqft,
    elevator: storeys > DEAL_SCREEN_ASSUMPTIONS.walkUpMaxStoreys,
    splits,
    parts: {land: [land], hard, soft, wagePremium, financing},
    landLines: [{key: 'landPrice', label: 'Land', basis: 'Land price in the pro forma'}],
    hardOf: `hard cost at ${usd(baseHardCost / grossSqft)} a gross sf`,
    softOf: `soft cost at ${usd(dev.softCost / grossSqft)} a gross sf`,
    wageBasis: `${pct(wagePremium / hard, 2)} on hard cost for the 485-x construction wage floor`,
    financingBasis: 'Interest carry on the construction loan',
  });
}

// What the cost setup shows: each line with its default share and what it covers.
export function budgetSplitOptions() {
  return {asOf: BUDGET_SPLITS.asOf, source: BUDGET_SPLITS.source, defaults: DEFAULT_BUDGET_SPLITS,
    lines: Object.fromEntries(Object.keys(SPLIT_GROUPS).map(group => [group, BUDGET_SPLITS[group].map(({key, label, note, elevatorOnly}) => ({key, label, note, elevatorOnly: Boolean(elevatorOnly)}))]))};
}
