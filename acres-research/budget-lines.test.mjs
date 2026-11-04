import test from 'node:test';
import assert from 'node:assert/strict';
import {BUDGET_SPLITS, DEFAULT_BUDGET_SPLITS, budgetFor, normalizeBudgetSplits, proFormaBudget} from './budget-lines.mjs';

// A scheme as the valuation prices it: unrounded components whose sum, rounded, is the total cost.
function scheme({storeys = 8, grossSqft = 23_000, hardCostPerGrossSqft = 420, softPct = 0.22, premium = 0, carry = 0.1, landBasis = 'ask', land = 4_000_000.4, transferRate = 0.014, closingRate = 0.015} = {}) {
  const hardCost = hardCostPerGrossSqft * grossSqft;
  const softCost = hardCost * softPct;
  const wagePremium = (hardCost + softCost) * premium;
  const transferTax = land * transferRate, closingCosts = land * closingRate;
  const financing = (land + transferTax + closingCosts + hardCost + softCost + wagePremium) * carry;
  const totalCost = Math.round(land + transferTax + closingCosts + hardCost + softCost + wagePremium + financing);
  return {id: 'max_bonus', program: {storeys, grossSqft, exit: 'rental'}, returns: {landBasis, totalCost, costs: {hardCostPerGrossSqft, grossSqft, land, transferTax, closingCosts, hardCost, softCost, wagePremium, financing}}};
}
const group = (budget, key) => budget.lines.filter(l => l.group === key).reduce((a, l) => a + l.amount, 0);

test('the default shares add up to 100% in each group and come with a source and date', () => {
  for (const key of ['hard', 'soft']) assert.equal(Number(Object.values(DEFAULT_BUDGET_SPLITS[key]).reduce((a, b) => a + b, 0).toFixed(6)), 1);
  assert.match(BUDGET_SPLITS.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(BUDGET_SPLITS.source.length > 40);
});

test('the lines reconcile to the valuation total and to each cost component', () => {
  const s = scheme();
  const budget = budgetFor(s);
  const c = s.returns.costs;
  assert.equal(budget.total, s.returns.totalCost);
  assert.equal(budget.lines.reduce((a, l) => a + l.amount, 0), s.returns.totalCost);
  assert.ok(Math.abs(group(budget, 'hard') - c.hardCost) <= 1);
  assert.ok(Math.abs(group(budget, 'soft') - c.softCost) <= 1);
  assert.ok(Math.abs(group(budget, 'financing') - c.financing) <= 1);
  assert.ok(Math.abs(group(budget, 'land') - (c.land + c.transferTax + c.closingCosts)) <= 1);
  assert.deepEqual(budget.groups.map(g => g.amount), ['land', 'hard', 'soft', 'financing'].map(k => group(budget, k)));
  for (const line of budget.lines) assert.ok(Number.isInteger(line.amount) && line.basis, line.key);
  assert.equal(budget.basis.splits, 'default');
});

test('hard cost lines carry every category of a mid-rise and scale with the scheme', () => {
  const small = budgetFor(scheme({grossSqft: 11_000})), large = budgetFor(scheme({grossSqft: 44_000}));
  const keys = small.lines.filter(l => l.group === 'hard').map(l => l.key);
  assert.deepEqual(keys, ['siteWork', 'foundations', 'structure', 'facade', 'interiors', 'verticalTransportation', 'mep', 'generalConditions', 'hardContingency']);
  for (const key of keys) {
    const a = small.lines.find(l => l.key === key), b = large.lines.find(l => l.key === key);
    assert.ok(Math.abs(b.amount - 4 * a.amount) <= 4, key);
    assert.ok(Math.abs(a.perGsf - b.perGsf) < 0.01, key);
  }
});

test('a walk-up has no elevator line and its share goes to the other hard cost lines', () => {
  const s = scheme({storeys: 4});
  const budget = budgetFor(s);
  assert.ok(!budget.lines.some(l => l.key === 'verticalTransportation'));
  assert.ok(Math.abs(group(budget, 'hard') - s.returns.costs.hardCost) <= 1);
  const structure = budget.lines.find(l => l.key === 'structure');
  assert.equal(structure.basis.startsWith(`${Number((0.18 / 0.97 * 100).toFixed(1))}%`), true);
});

test('the wage floor and transfer taxes appear only where they apply', () => {
  const plain = budgetFor(scheme({landBasis: 'land_value', land: 3_000_000, transferRate: 0}));
  assert.ok(!plain.lines.some(l => l.key === 'wageFloorPremium'));
  assert.ok(!plain.lines.some(l => l.key === 'transferTax'));
  assert.equal(plain.lines.find(l => l.key === 'landPrice').label, 'Land value');
  const optionA = budgetFor(scheme({premium: 0.031}));
  const wage = optionA.lines.find(l => l.key === 'wageFloorPremium');
  assert.equal(wage.group, 'soft');
  assert.ok(wage.amount > 0);
  assert.ok(optionA.lines.some(l => l.key === 'transferTax'));
  assert.equal(optionA.total, optionA.lines.reduce((a, l) => a + l.amount, 0));
});

test('custom shares move dollars between lines but never the totals', () => {
  const s = scheme();
  const splits = normalizeBudgetSplits({hard: {...DEFAULT_BUDGET_SPLITS.hard, structure: 0.28, interiors: 0.08}, soft: DEFAULT_BUDGET_SPLITS.soft});
  const base = budgetFor(s), custom = budgetFor(s, {splits});
  assert.equal(custom.total, base.total);
  assert.equal(custom.basis.splits, 'custom');
  assert.ok(custom.lines.find(l => l.key === 'structure').amount > base.lines.find(l => l.key === 'structure').amount);
  assert.equal(group(custom, 'hard'), group(base, 'hard'));
});

test('shares that do not add up to 100% or fall outside 0 to 100% are refused', () => {
  assert.throws(() => normalizeBudgetSplits({hard: {...DEFAULT_BUDGET_SPLITS.hard, structure: 0.3}, soft: DEFAULT_BUDGET_SPLITS.soft}), /Hard cost shares add up to 112%/);
  assert.throws(() => normalizeBudgetSplits({hard: DEFAULT_BUDGET_SPLITS.hard, soft: {...DEFAULT_BUDGET_SPLITS.soft, design: -0.1}}), /must be from 0 to 100%/);
  assert.throws(() => normalizeBudgetSplits({hard: DEFAULT_BUDGET_SPLITS.hard}), /Soft cost share/);
});

test('components that do not add up to the total fail instead of showing wrong lines', () => {
  const s = scheme();
  s.returns.totalCost += 5;
  assert.throws(() => budgetFor(s), /not the valuation's/);
});

test('the pro forma budget splits into lines that add up to its total development cost', () => {
  const grossSqft = 30_000, baseHardCost = 400 * grossSqft;
  const dev = {landPrice: 5_000_000.4, hardCost: baseHardCost * 1.03, softCost: 95.5 * grossSqft, interestCarry: 1_234_567.89};
  dev.totalDevelopmentCost = dev.landPrice + dev.hardCost + dev.softCost + dev.interestCarry;
  const budget = proFormaBudget(dev, {grossSqft, storeys: 9, baseHardCost});
  assert.equal(budget.total, Math.round(dev.totalDevelopmentCost));
  assert.ok(budget.lines.some(l => l.key === 'wageFloorPremium'));
  assert.ok(Math.abs(group(budget, 'hard') - baseHardCost) <= 2);
  const noPremium = proFormaBudget({...dev, hardCost: baseHardCost, totalDevelopmentCost: dev.totalDevelopmentCost - baseHardCost * 0.03}, {grossSqft, storeys: 4, baseHardCost});
  assert.ok(!noPremium.lines.some(l => l.key === 'wageFloorPremium' || l.key === 'verticalTransportation'));
});

test('the pro forma tool reports line items when asked, at the account shares', async () => {
  const {createProFormaTools} = await import('./proforma.mjs');
  const splits = normalizeBudgetSplits({hard: {...DEFAULT_BUDGET_SPLITS.hard, structure: 0.23, interiors: 0.13}, soft: DEFAULT_BUDGET_SPLITS.soft});
  const market = {submarket: 'Test, Brooklyn', rents: [{bedrooms: 1, rentPerSqftPerMonth: 5, source: 'User', retrievedAt: '2026-10-01'}]};
  const tools = createProFormaTools({getMarket: () => market, getBudgetSplits: () => splits});
  const args = {productType: 'rental', program: {grossBuildingSqft: 20_000, units: [{bedrooms: 1, count: 25, netSqft: 600}]}, landPrice: 3_000_000, hardCostPerSqft: 400, softCostPerSqft: 90,
    financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 30}, operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 9000, commercialVacancyRate: 0, commercialOpexPerSqftPerYear: 0}, capRate: 0.06};
  const plain = await tools.handlers.acres_pro_forma(args);
  assert.equal(plain.development.lineItems, undefined);
  await assert.rejects(tools.handlers.acres_pro_forma({...args, lineItems: true}), /storeys is required/);
  const detailed = await tools.handlers.acres_pro_forma({...args, lineItems: true, storeys: 7});
  const items = detailed.development.lineItems;
  assert.equal(items.total, detailed.development.totalDevelopmentCost);
  assert.equal(items.lines.reduce((a, l) => a + l.amount, 0), detailed.development.totalDevelopmentCost);
  assert.equal(items.basis.splits, 'custom');
  assert.equal(group(items, 'hard'), 400 * 20_000);
  assert.ok(items.lines.some(l => l.key === 'verticalTransportation'));
});

test('the settings route keeps the account budget shares beside its costs, validated and kept on cost saves', async t => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {MarketStore} = await import('./market-store.mjs');
  const {ChatStore} = await import('./store.mjs');
  const {createResearchServer} = await import('./service.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acres-budget-splits-'));
  const previous = process.env.ACRES_DEAL_STORE_ENABLED;
  process.env.ACRES_DEAL_STORE_ENABLED = 'true';
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'token'}, store: new ChatStore(join(dir, 'chat.sqlite')), maps: null, marketStoreFactory: () => new MarketStore(join(dir, 'market.sqlite'))});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); rmSync(dir, {recursive: true, force: true}); if (previous === undefined) delete process.env.ACRES_DEAL_STORE_ENABLED; else process.env.ACRES_DEAL_STORE_ENABLED = previous; });
  const url = `http://127.0.0.1:${server.address().port}/market-store/user-settings`;
  const headers = {authorization: 'Bearer token', 'x-acres-account': 'c'.repeat(24), 'x-acres-email': 'builder@example.com', 'content-type': 'application/json'};
  const call = async (method, body) => { const res = await fetch(url, {method, headers, ...(body ? {body: JSON.stringify(body)} : {})}); return {status: res.status, body: await res.json()}; };

  const first = await call('GET');
  assert.equal(first.body.budgetSplits, null);
  assert.deepEqual(first.body.budgetSplitOptions.defaults, DEFAULT_BUDGET_SPLITS);
  assert.equal(first.body.budgetSplitOptions.lines.hard.find(l => l.key === 'verticalTransportation').elevatorOnly, true);

  const splits = {hard: {...DEFAULT_BUDGET_SPLITS.hard, structure: 0.2, mep: 0.18}, soft: DEFAULT_BUDGET_SPLITS.soft};
  const saved = await call('PUT', {budgetSplits: splits});
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.budgetSplits, splits);
  assert.equal(saved.body.isCustom, false, 'saving shares alone leaves the house costs in place');

  const bad = await call('PUT', {budgetSplits: {hard: {...splits.hard, structure: 0.5}, soft: splits.soft}});
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /must add up to 100%/);

  const costs = await call('PUT', {dealSettings: {rentalHardCostPerGrossSqft: 450, condoHardCostPerGrossSqft: 500}});
  assert.equal(costs.body.dealSettings.rentalHardCostPerGrossSqft, 450);
  assert.deepEqual(costs.body.budgetSplits, splits, 'a cost save keeps the shares');
  assert.equal(costs.body.dealSettings.budgetSplits, undefined, 'the shares are no valuation cost setting');
  const reset = await call('PUT', {reset: true});
  assert.equal(reset.body.isCustom, false);
  assert.deepEqual(reset.body.budgetSplits, splits, 'resetting the costs keeps the shares');
  const defaults = await call('PUT', {budgetSplits: null});
  assert.equal(defaults.body.budgetSplits, null);
  assert.equal(defaults.body.costsConfirmed, true);
});

test('every scheme of varied lots gets a budget that adds up to its total cost at the account costs', async () => {
  const {computeDealValuation, DEFAULT_NYC_DEV_SETTINGS} = await import('./market-store.mjs');
  const {buildSchemes} = await import('./schemes.mjs');
  // Lots across densities, boroughs and exits, one large enough for 485-x Option A; none tuned to an answer.
  const lots = [
    {listPrice: 1_400_000, lotArea: 2000, lotFront: 20, lotDepth: 100, lotTypeCode: '5', bldgArea: 1600, residFar: 2.2, affResFar: 3.9, zoningDistrict: 'R6', address: '10 EXAMPLE PLACE', borough: 'BK', zipCode: '11221'},
    {listPrice: 6_000_000, lotArea: 10000, lotFront: 100, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 3.44, affResFar: 5.01, zoningDistrict: 'R7-1', address: '20 EXAMPLE AVENUE', borough: 'QN', zipCode: '11373', frontStreetFeet: 80},
    {listPrice: 700_000, lotArea: 4000, lotFront: 40, lotDepth: 100, lotTypeCode: '5', bldgArea: 1200, residFar: 0.5, affResFar: 0.6, zoningDistrict: 'R3-2', address: '30 EXAMPLE ROAD', borough: 'SI', zipCode: '10314'},
    {lotArea: 30000, lotFront: 200, lotDepth: 150, lotTypeCode: '5', bldgArea: 0, residFar: 6.02, affResFar: 7.2, zoningDistrict: 'R8', address: '60 EXAMPLE BOULEVARD', borough: 'BX', zipCode: '10451', frontStreetFeet: 100},
  ];
  const settings = {...DEFAULT_NYC_DEV_SETTINGS, rentalHardCostPerGrossSqft: 410, condoHardCostPerGrossSqft: 480, softCostPctOfHard: 0.25, carryAndFinancingPct: 0.12};
  const seen = new Set();
  for (const lot of lots) {
    const v = computeDealValuation({...lot, settings, withCandidates: true});
    for (const c of v.candidates) {
      const budget = budgetFor({program: c, returns: c.returns});
      assert.equal(budget.total, c.returns.totalCost, c.id);
      assert.equal(budget.lines.reduce((a, l) => a + l.amount, 0), c.returns.totalCost, c.id);
      assert.equal(budget.basis.hardCostPerGrossSqft >= (c.exit === 'condo' ? 480 : 410), true, c.id);
      assert.match(budget.basis.hardCostBasis, /^your hard cost/, c.id);
      assert.equal(budget.lines.some(l => l.key === 'wageFloorPremium'), c.taxProgram?.option === 'A', c.id);
      assert.equal(budget.lines.some(l => l.key === 'verticalTransportation'), c.storeys > 5, c.id);
      seen.add(c.exit).add(c.taxProgram ? `485-x ${c.taxProgram.option}` : 'full').add(c.returns.landBasis);
    }
    for (const s of buildSchemes({candidates: v.candidates}).filter(s => s.program)) assert.equal(budgetFor(s).total, s.returns.totalCost);
  }
  for (const kind of ['rental', 'condo', 'full', '485-x A', '485-x B', 'ask', 'land_value']) assert.ok(seen.has(kind), kind);
  // At the house costs the budget names the published range it priced the building from.
  const house = computeDealValuation({...lots[1], withCandidates: true}).candidates[0];
  assert.match(budgetFor({program: house, returns: house.returns}).basis.hardCostBasis, /^published New York cost range for a (wood or light-gauge steel low-rise|concrete mid-rise) at this price level/);
});

test('the schemes route fills each scheme budget at the owner shares and refreshes it when they change', async t => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {MarketStore} = await import('./market-store.mjs');
  const {ChatStore} = await import('./store.mjs');
  const {createResearchServer} = await import('./service.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acres-scheme-budgets-'));
  const previous = process.env.ACRES_DEAL_STORE_ENABLED;
  process.env.ACRES_DEAL_STORE_ENABLED = 'true';
  const chat = new ChatStore(join(dir, 'chat.sqlite'));
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'token'}, store: chat, maps: null, marketStoreFactory: () => new MarketStore(join(dir, 'market.sqlite'))});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); chat.close(); rmSync(dir, {recursive: true, force: true}); if (previous === undefined) delete process.env.ACRES_DEAL_STORE_ENABLED; else process.env.ACRES_DEAL_STORE_ENABLED = previous; });
  const account = 'd'.repeat(24);
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization: 'Bearer token', 'x-acres-account': account, 'x-acres-email': 'builder@example.com', 'content-type': 'application/json'};
  const call = async (path, method = 'GET', body) => (await fetch(base + path, {method, headers, ...(body ? {body: JSON.stringify(body)} : {})})).json();
  const {projectId} = chat.createConversation(account);
  const parcel = {bbl: '4012340001', address: '20 EXAMPLE AVENUE', borough: 'QN', zipcode: '11373', zonedist1: 'R7-1', lotarea: 10000, lotfront: 100, lotdepth: 100, lottype: '5', bldgarea: 0, residfar: 3.44, affresfar: 5.01, commfar: 0, facilfar: 4.8};
  chat.project.write(projectId, {property: {value: parcel, provenance: {tool: 'acres_set_subject', sources: []}}});
  const first = await call(`/projects/${projectId}/schemes`);
  const built = first.schemes.filter(s => s.program);
  assert.ok(built.length >= 2);
  for (const s of built) {
    assert.equal(s.budget.total, s.returns.totalCost, s.id);
    assert.equal(s.budget.basis.splits, 'default');
  }
  const version = first.version;
  assert.equal((await call(`/projects/${projectId}/schemes`)).version, version, 'an unchanged budget is not written again');
  await call('/market-store/user-settings', 'PUT', {budgetSplits: {hard: {...DEFAULT_BUDGET_SPLITS.hard, structure: 0.22, interiors: 0.14}, soft: DEFAULT_BUDGET_SPLITS.soft}});
  const after = await call(`/projects/${projectId}/schemes`);
  for (const s of after.schemes.filter(s => s.program)) {
    assert.equal(s.budget.basis.splits, 'custom');
    assert.equal(s.budget.total, s.returns.totalCost);
  }
});
