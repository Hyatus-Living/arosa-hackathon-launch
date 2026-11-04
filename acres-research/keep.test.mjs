import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {KEEP_DEFAULTS, QUICK_KEEP, computeKeep, createKeepTools, keepDefinition, normalizeKeep, priceKeep, quickKeep, repriceKeep} from './keep.mjs';
import {loadSkill, searchCapabilities} from './capabilities.mjs';
import {ChatStore} from './store.mjs';
import {MarketStore} from './market-store.mjs';

// Hypothetical fixture: a three family house with one regulated apartment; every figure is invented.
const fig = value => ({value, source: 'Hypothetical fixture', retrievedAt: '2026-10-28'});
const base = {
  name: 'Keep the fixture house', purchasePrice: 1_626_500, priceBasis: 'Offer',
  building: {grossSqft: 3176, residentialUnits: 3},
  income: {rentRoll: [{label: 'Garden', units: 1, monthlyRentPerUnit: 2400}, {label: 'Parlor', units: 1, monthlyRentPerUnit: 2900, regulated: true}, {label: 'Top', units: 1, monthlyRentPerUnit: 3100}],
    rentRollSource: {source: 'Hypothetical rent roll', retrievedAt: '2026-10-28', sourceId: 4}},
  operating: {annualTaxes: 9800, taxBasis: 'Hypothetical tax bill'},
  valuation: {capRate: 0.055, asIsValuePerSqft: fig(560), afterRenovationValuePerSqft: {...fig(750), sourceId: 5}},
  renovation: {costPerSqft: 150, months: 6, rentPerSqftPerMonth: fig(4.4)},
};
const keep = (changes = {}) => computeKeep({...base, ...changes});
const way = (result, id) => result.strategies.find(s => s.id === id);
const near = (a, b, tolerance = 1) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);

test('holding as is nets the rent roll after vacancy, operating costs and taxes, on everything paid to own it', () => {
  const hold = way(keep(), 'hold');
  const gross = (2400 + 2900 + 3100) * 12, egi = gross * (1 - KEEP_DEFAULTS.vacancyRate);
  near(hold.noi, egi - egi * KEEP_DEFAULTS.operatingExpenseRatio - 9800);
  // A one to three family house at $1M or more pays the State's 1% mansion tax on top of closing and loan costs.
  const loan = 1_626_500 * KEEP_DEFAULTS.loanToValue;
  near(hold.allIn, 1_626_500 * (1 + KEEP_DEFAULTS.closingCostRate + 0.01) + loan * KEEP_DEFAULTS.loanCostRate);
  near(hold.capRateOnCost, hold.noi / hold.allIn, 0.0001);
  assert.ok(hold.dscr < 1 && hold.cashFlow < 0, 'a 65% loan at 7% is more than this rent carries');
  assert.equal(hold.salesValue, 560 * 3176);
});

test('a wholly commercial building is priced on its commercial rent alone, with no apartments to invent', () => {
  const retail = computeKeep({
    name: 'Keep the retail building', purchasePrice: 4_000_000, priceBasis: 'Asking price',
    building: {grossSqft: 20000, residentialUnits: 0, commercialSqft: 18000},
    income: {commercialRentPerSqftPerYear: fig(120)},
    operating: {annualTaxes: 80000, taxBasis: 'Hypothetical tax bill'},
    valuation: {capRate: 0.06},
  });
  const hold = way(retail, 'hold');
  const gross = 18000 * 120, egi = gross * (1 - KEEP_DEFAULTS.vacancyRate);
  near(hold.noi, egi - egi * KEEP_DEFAULTS.operatingExpenseRatio - 80000);
  assert.equal(retail.decision.id, 'hold', 'holding is the only priced way without a renovation');
  assert.throws(() => computeKeep({purchasePrice: 4_000_000, building: {grossSqft: 20000, residentialUnits: 0, commercialSqft: 18000}, income: {rentPerSqftPerMonth: fig(5), commercialRentPerSqftPerYear: fig(120)}, operating: {annualTaxes: 1, taxBasis: 'x'}, valuation: {capRate: 0.06}}), /no apartments; give income\.commercialRentPerSqftPerYear only/);
});

test('each way\'s highest price is where it just meets its target, the mansion tax bracket included', () => {
  const result = keep();
  for (const s of result.strategies.filter(x => x.priced)) {
    const at = way(priceKeep({...normalizeKeep(base), purchasePrice: s.maxPrice}), s.id), over = way(priceKeep({...normalizeKeep(base), purchasePrice: s.maxPrice + 2}), s.id);
    assert.ok(at.measure >= s.target - 1e-4, `${s.id} meets its target at its highest price`);
    assert.ok(over.measure < s.target + 1e-4, `${s.id} does not meet it above that price`);
  }
  // The hold earns its 5.5% only below $1M: at $1,000,000 the 1% transfer tax tips it under.
  assert.equal(way(result, 'hold').maxPrice, 999_999);
  assert.equal(way(result, 'hold').call, 'below_price');
});

test('the decision names the way that pays the most for the building against the price', () => {
  const result = keep();
  const lead = result.strategies.filter(s => s.priced).sort((a, b) => b.maxPrice - a.maxPrice)[0];
  assert.equal(result.decision.id, lead.id);
  assert.match(result.decision.verdict, new RegExp(`${lead.label.toLowerCase()} pays the most: up to \\$[\\d,]+ at your targets, against the \\$1,626,500 price`));
  assert.match(result.decision.verdict, /Standing buildings like it sell for about \$1,778,560, 109% of the price/);
  assert.ok(result.whatWouldChangeIt.some(line => /pays \$[\d,]+ more for the building than/.test(line)));
  // Cheap enough, every way supports the price.
  const cheap = keep({purchasePrice: 500_000});
  assert.ok(cheap.strategies.every(s => s.call === 'supports_price'));
});

test('regulated apartments keep their rent after the work, and the note says a renovated sale assumes delivery they prevent', () => {
  const regulated = way(keep(), 'renovate_rent');
  const free = way(keep({income: {...base.income, rentRoll: base.income.rentRoll.map(r => ({...r, regulated: false}))}}), 'renovate_rent');
  assert.ok(regulated.noi < free.noi);
  const rentable = Math.round(3176 * KEEP_DEFAULTS.rentableShare);
  near(regulated.grossRent, 2900 * 12 + rentable * (2 / 3) * 4.4 * 12);
  assert.ok(keep().notes.some(n => /1 rent-regulated unit keeps its rent/.test(n) && /delivered as priced/.test(n)));
});

test('planning defaults are listed by name and value; figures the caller gives are not', () => {
  const result = keep({financing: {loanToValue: 0.5}});
  assert.ok(!result.inputs.assumed.includes('financing.loanToValue'));
  assert.ok(result.inputs.assumed.includes('financing.interestRate'));
  const line = result.notes.find(n => n.startsWith('Planning assumptions'));
  assert.match(line, /vacancy 5%; operating costs 30% of income before taxes/);
  assert.doesNotMatch(line, /a 50% loan|a 65% loan/);
  assert.match(line, new RegExp(KEEP_DEFAULTS.asOf));
});

test('a way without its figures is not priced and says what it needs', () => {
  const {renovation: _r, ...noWork} = base;
  const holdOnly = computeKeep(noWork);
  assert.equal(way(holdOnly, 'hold').priced, true);
  assert.match(way(holdOnly, 'renovate_rent').reason, /No renovation was given/);
  const noResale = keep({valuation: {capRate: 0.055}});
  assert.match(way(noResale, 'renovate_sell').reason, /afterRenovationValuePerSqft/);
  assert.equal(noResale.comparable, null);
});

test('inputs are checked, never clamped or guessed', () => {
  assert.throws(() => keep({income: {...base.income, rentPerSqftPerMonth: fig(3)}}), /exactly one of income.rentRoll/);
  assert.throws(() => keep({operating: {}}), /exactly one of operating.annualTaxes/);
  assert.throws(() => keep({operating: {annualTaxes: 9800}}), /operating.taxBasis must be text/);
  assert.throws(() => keep({income: {...base.income, rentRoll: [{units: 4, monthlyRentPerUnit: 2000}]}}), /lists 4 units but the building has 3/);
  assert.throws(() => keep({building: {...base.building, commercialSqft: 400}}), /income.commercialRentPerSqftPerYear must be an object with value, source and retrievedAt/);
  assert.throws(() => keep({valuation: {...base.valuation, afterRenovationValuePerSqft: {value: 750, source: 'Fixture'}}}), /retrievedAt must be a date/);
  assert.throws(() => keep({renovation: {costPerSqft: 150, totalCost: 400000}}), /exactly one of renovation.costPerSqft/);
  assert.throws(() => keep({financing: {loanToValue: 0.95}}), /financing.loanToValue must be a number from 0 to 0.9/);
  assert.throws(() => computeKeep({...base, building: undefined}), /building is required/);
});

test('the subject\'s PLUTO building stands in when building is omitted', () => {
  const property = {bbl: '3012180065', version: '25v3', bldgarea: 3176, unitsres: 3, comarea: 0};
  const result = computeKeep({...base, building: undefined}, {property});
  assert.equal(result.inputs.building.grossSqft, 3176);
  assert.equal(result.inputs.building.source, 'PLUTO 25v3 record for BBL 3012180065');
});

test('your numbers reprice the saved analysis from the run\'s inputs, and clearing one restores the run\'s', () => {
  const run = keep();
  const mine = repriceKeep(run, {landPrice: 1_500_000, keep: {renovationCostPerSqft: 200, interestRate: 0.065, capRate: 0.05}});
  assert.equal(mine.derived, true);
  assert.equal(mine.price, 1_500_000);
  assert.equal(mine.inputs.renovation.costPerSqft, 200);
  assert.equal(mine.inputs.valuation.capRate, 0.05);
  assert.equal(mine.inputs.targets.capRate, 0.05, 'a hold target that followed the cap rate follows the new one');
  assert.equal(mine.inputs.targets.yieldOnCost, 0.06, 'and the renovate-and-rent target keeps its one-point spread');
  assert.ok(!mine.inputs.assumed.includes('financing.interestRate'));
  const cleared = repriceKeep(mine, {});
  assert.equal(cleared.price, run.price);
  assert.equal(cleared.inputs.renovation.costPerSqft, 150);
  assert.deepEqual(cleared.strategies.map(s => s.maxPrice), run.strategies.map(s => s.maxPrice));
  // A renovation the run never priced can be set from the page.
  const {renovation: _r, ...noWork} = base;
  const added = repriceKeep(computeKeep(noWork), {keep: {renovationCostPerSqft: 120, renovatedRentPerSqftPerMonth: 4}});
  assert.equal(way(added, 'renovate_rent').priced, true);
  assert.ok(added.inputs.assumed.includes('renovation.months'));
  assert.equal(added.inputs.renovation.rentPerSqftPerMonth.source, 'Your input');
});

test('the tool reads the ledger tax bill as a cited official record and caps analyses per answer', async () => {
  const recorded = [];
  const ledger = {taxes: () => ({annualTaxes: 11_250, assessedValue: 56_000, marketValue: 1_250_000, taxClass: '1', rate: 0.2009, rateFiscalYear: '2026', assessmentFiscalYear: '2027', basis: 'Fixture basis', crossCheck: null, retrievedAt: '2026-10-28T12:00:00.000Z', sourceUrl: 'https://data.cityofnewyork.us/resource/8y4t-faws.json'})};
  const tools = createKeepTools({ledger, record: s => { recorded.push(s); return {id: 9}; }});
  const {operating: _o, ...rest} = base;
  const result = await tools.handlers.acres_keep_building({...rest, taxSource: 'ledger'});
  assert.equal(result.inputs.operating.annualTaxes, 11_250);
  assert.equal(recorded[0].kind, 'official_record');
  assert.ok(result.sourceIds.includes(9) && result.sourceIds.includes(4) && result.sourceIds.includes(5));
  assert.match(result.note, /not an IRR/);
  await tools.handlers.acres_keep_building(base);
  await tools.handlers.acres_keep_building(base);
  await assert.rejects(tools.handlers.acres_keep_building(base), /At most three/);
  assert.equal(tools.analyses.length, 3);
  assert.deepEqual(keepDefinition.inputSchema.required, ['purchasePrice', 'income', 'valuation']);
});

test('the registry finds the tool and its skill for buy-and-hold questions', () => {
  const {results} = searchCapabilities({query: 'buy and hold rental property, renovate, cash flow and what to offer'});
  assert.equal(results.find(r => r.kind === 'tool').name, 'acres_keep_building');
  assert.ok(results.some(r => r.kind === 'skill' && r.name === 'keep-building'));
  assert.match(loadSkill('keep-building').text, /acres_keep_building/);
  assert.ok(loadSkill('creative-zoning').text.length < 4000);
});

const owner = 'k'.repeat(24);
function site(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keep-site-')), store = new ChatStore(join(dir, 'chat.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const conversation = store.createConversation(owner), run = store.createRun(owner, conversation.id, 'Should I buy and keep it?');
  store.begin(run);
  store.finish(run, 'completed', {answer: 'Fixture answer', property: {bbl: '3012180065'}, keep: keep(), sources: []});
  const view = () => store.projectView(owner, conversation.projectId);
  const edit = fields => store.updateProjectState(owner, conversation.projectId, {version: view().version, fields});
  return {store, run, view, edit};
}

test('a run saves the analysis to the site, and your numbers reprice it in code without going stale', t => {
  const s = site(t), saved = s.view().fields.keep;
  assert.equal(saved.provenance.tool, 'acres_keep_building');
  assert.equal(saved.value.price, 1_626_500);
  const after = s.edit({assumptions: {landPrice: 1_400_000, keep: {renovationCostPerSqft: 100}}}).fields.keep;
  assert.equal(after.stale, null);
  assert.equal(after.value.derived, true);
  assert.equal(after.value.price, 1_400_000);
  assert.equal(after.value.inputs.renovation.costPerSqft, 100);
  assert.deepEqual(s.store.run(owner, s.run.id).result.keep.price, 1_626_500, 'the narrated run keeps its own figures');
  assert.throws(() => s.edit({assumptions: {keep: {loanToValue: 0.97}}}), /keep.loanToValue must be a number from 0 to 0.9/);
  assert.throws(() => s.edit({assumptions: {keep: {anything: 1}}}), /keep.anything is not an assumption a user can set/);
});

test('the site page answers "Should you buy it" from keeping the building alone', async () => {
  const {document} = parseHTML('<html><head></head><body></body></html>'); globalThis.document = document;
  const {renderParcel} = await import('../app-starter/public/core-view.js');
  const result = keep();
  const property = {bbl: '3012180065', address: '1 FIXTURE STREET', zonedist1: 'R6', lotarea: 2061, bldgarea: 3176};
  const field = value => ({value, updated: 1, stale: null, provenance: {tool: 'acres_keep_building', sources: []}});
  const root = renderParcel({id: 'fixture', title: 'Fixture house', version: 1, fields: {property: field(property), keep: field(result)}}, {canSend: true, canEdit: true});
  const decide = root.querySelector('#core-step-decide');
  assert.match(decide.className, /is-done/);
  assert.ok(decide.querySelector('.uw-answer').textContent.includes(result.decision.verdict));
  const heads = [...root.querySelectorAll('#core-keep .core-compare thead th')].map(th => th.textContent);
  assert.deepEqual(heads, ['', 'Hold as is', 'Renovate and rent', 'Renovate and sell']);
  const row = name => [...root.querySelectorAll('#core-keep .core-compare tr')].find(tr => tr.querySelector('th')?.textContent === name);
  assert.equal(row('Highest price at your target').querySelectorAll('td')[0].textContent, '$1.00M');
  assert.ok(root.querySelector('#core-keep').textContent.includes('What would change it'));
  const keepBlock = root.querySelector('#core-keep');
  assert.ok(keepBlock.querySelector('.core-recommendation').compareDocumentPosition(keepBlock.querySelector('.core-compare')) & 4, 'the answer comes before the table');
  assert.ok(keepBlock.querySelector('[data-numbers-open="keep"]'), 'a button opens the numbers that reprice it');
  assert.deepEqual([...decide.querySelectorAll('.uw-menu [data-follow-field="keep"]')].map(b => b.textContent), ['Reprice keeping the building']);
  assert.ok(root.querySelector('#core-assumptions-form [name="keep.renovationCostPerSqft"]'));
});

test('the full report carries keeping the building as its own chapter', async () => {
  const {document} = parseHTML('<html><head></head><body></body></html>'); globalThis.document = document;
  const {renderReport, reportModel} = await import('../app-starter/public/report-view.js');
  const result = keep();
  const field = value => ({value, updated: 1, stale: null, provenance: {tool: 'acres_keep_building', sources: []}});
  const project = {id: 'fixture', title: 'Fixture house', version: 1, fields: {property: field({bbl: '3012180065', address: '1 FIXTURE STREET'}), keep: field(result)}};
  const chapter = renderReport(reportModel({project})).querySelector('#report-keep');
  assert.ok(chapter.textContent.includes(result.decision.verdict));
  assert.deepEqual([...chapter.querySelectorAll('thead th')].map(th => th.textContent), ['', 'Hold as is', 'Renovate and rent', 'Renovate and sell']);
  assert.match(chapter.textContent, /What would change it/);
  assert.doesNotMatch(chapter.textContent, /—/, 'the report never prints an em dash');
});

// The instant read a listing gets from the deal store's own figures, without a run.
const storeFigures = {price: 1_088_888, grossSqft: 2_400, residentialUnits: 2, annualTax: 8_700, regulatedUnits: 0, zipCode: '11367',
  rent: {perSqftPerMonth: 3.4, sampleCount: 41, asOf: '2026-10-27T03:00:00.000Z'},
  buildingSales: {pricePerSqft: 610, saleCount: 12, kind: 'one to three family', months: 24, zipCode: '11367'}};

test('a listing reads instantly as a building to keep: held at ZIP rents, at a planning cap rate, beside nearby building sales', () => {
  const read = quickKeep(storeFigures);
  assert.equal(read.priced, true);
  const rentable = Math.round(2_400 * KEEP_DEFAULTS.rentableShare);
  const egi = rentable * 3.4 * 12 * (1 - KEEP_DEFAULTS.vacancyRate);
  near(read.hold.noi, egi * (1 - KEEP_DEFAULTS.operatingExpenseRatio) - 8_700);
  const at = way(priceKeep(normalizeKeep({purchasePrice: read.hold.maxPrice, building: {grossSqft: 2400, residentialUnits: 2, rentableSqft: rentable}, income: {rentPerSqftPerMonth: fig(3.4)}, operating: {annualTaxes: 8700, taxBasis: 'Fixture'}, valuation: {capRate: QUICK_KEEP.capRate}})), 'hold');
  assert.ok(at.capRateOnCost >= QUICK_KEEP.capRate - 1e-4, 'it pays up to the price that earns the planning cap rate');
  assert.equal(read.comparable.value, 610 * 2_400);
  assert.match(read.sentence, /^Kept as a rental at ZIP asking rents, it nets about \$[\d,]+ a year after vacancy, operating costs and the listing's \$8,700 taxes/);
  assert.match(read.sentence, /One to three family buildings in ZIP 11367 sold for a median \$610 per sq ft over 24 months \(12 sales\), about \$1,464,000 for this building, 134% of the ask\./);
  assert.equal(read.rent.asOf, '2026-10-27');
  assert.ok(read.assumptions[0].startsWith('a 6% cap rate'));
  assert.match(read.caveat, /older apartments often rent for less/);
});

test('the instant read says why it cannot price, and still gives nearby building sales', () => {
  assert.equal(quickKeep(null), null);
  const noTax = quickKeep({...storeFigures, annualTax: null});
  assert.equal(noTax.priced, false);
  assert.match(noTax.reason, /no annual tax/);
  assert.ok(noTax.comparable && /sold for a median/.test(noTax.sentence));
  assert.match(quickKeep({...storeFigures, residentialUnits: 0}).reason, /No apartments are on record/);
  assert.match(quickKeep({...storeFigures, rent: null}).reason, /No apartments are listed for rent in ZIP 11367/);
  assert.match(quickKeep({...storeFigures, price: null}).reason, /no asking price/);
  assert.match(quickKeep({...storeFigures, rent: {...storeFigures.rent, perSqftPerMonth: 90}}).reason, /out of range for a quick read/);
});

function keepStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keep-market-')), store = new MarketStore(join(dir, 'market.sqlite'));
  // Windows can keep SQLite's files locked for a moment after close; a temp folder left behind there is harmless.
  t.after(() => { store.close(); try { rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); } catch (error) { if (error.code !== 'EPERM') throw error; } });
  const insert = store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, sold_price, sqft, sold_date, unit, asset_class,
    pluto_lot_area, pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, landmark_flag, flood_zone,
    units_res, bldg_class, annual_tax, year_built, first_seen_at, last_seen_at) VALUES (?, ?, ?, '11367', 'QN', ?, ?, ?, ?, ?, '', 'townhouse_single_family',
    3491, 35, 100, '5', ?, 0.5, 0.5, 'R2A', 0, 0, 2, 'B1', ?, 1950, 1, 1)`);
  insert.run('listing', 'for_sale', '138-33 62nd Rd', '4063970080', 1_088_888, null, null, null, 2400, 8700);
  const recent = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < 6; i++) insert.run(`sold-${i}`, 'sold', `${i} Comparable Rd`, `40639700${90 + i}`, null, 1_200_000 + i * 50_000, 2000, recent, 2000, null);
  store.db.prepare(`INSERT INTO market_submarket_rollups (scope_key, scope_type, zip_code, city, state, sample_count, by_bedrooms_json, dev_metrics_json, updated_at)
    VALUES ('zip:11367', 'zip', '11367', 'Queens', 'NY', 60, ?, ?, ?)`).run(JSON.stringify({1: {rentSampleCount: 30}, 2: {rentSampleCount: 11}}), JSON.stringify({blendedRentPsfMonth: 3.4}), '2026-10-27T03:00:00.000Z');
  return store;
}

test('the deal store supplies a listing\'s figures for the instant read', t => {
  const store = keepStore(t);
  const inputs = store.listingKeepInputs('listing');
  assert.equal(store.listingKeepInputs('missing'), null);
  const {buildingSales, ...rest} = inputs;
  assert.deepEqual(rest, {price: 1_088_888, grossSqft: 2400, residentialUnits: 2, annualTax: 8700, regulatedUnits: 0, zipCode: '11367',
    rent: {perSqftPerMonth: 3.4, sampleCount: 41, asOf: '2026-10-27T03:00:00.000Z'}});
  assert.equal(buildingSales.saleCount, 6);
  assert.equal(buildingSales.kind, 'one to three family');
  assert.equal(quickKeep(inputs).priced, true);
});

test('the listing page asks what you are buying for: keeping leads with the instant read and starts the keep underwriting', async t => {
  const store = keepStore(t);
  const deal = {...store.searchDeals({listingId: 'listing'})[0], keep: quickKeep(store.listingKeepInputs('listing'))};
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  const previous = {document: globalThis.document, window: globalThis.window};
  Object.assign(globalThis, {document, window});
  t.after(() => Object.assign(globalThis, previous));
  const {renderInspector} = await import('../app-starter/public/listing-inspector.js');
  const started = [], goals = [];
  const view = goal => renderInspector(deal, {goal, onGoal: g => goals.push(g), canStart: () => true, onUnderwrite: (_d, prompt) => started.push(prompt), onAsk() {}, onClose() {}});
  const order = root => [...root.children].map(n => (n.classList.contains('inspector-keep') ? 'keep' : n.classList.contains('inspector-figures') ? 'build' : null)).filter(Boolean);
  const keep = view('keep');
  assert.deepEqual(order(keep), ['keep', 'build'], 'keeping the building leads');
  assert.equal(keep.querySelector('[data-goal="keep"]').getAttribute('aria-pressed'), 'true');
  const primary = keep.querySelector('.inspector-actions .primary');
  assert.equal(primary.textContent, 'Underwrite to keep');
  primary.click();
  assert.match(started[0], /^Underwrite keeping 138-33 62nd Rd \(BBL 4063970080\) as it stands: I am buying to keep the building, not to build new\./);
  assert.match(started[0], /at the \$1,088,888 asking price with acres_keep_building/);
  const labels = [...keep.querySelectorAll('.inspector-keep .deal-figure dt')].map(dt => dt.textContent);
  assert.deepEqual(labels, ['Pays up to', 'Net income at ZIP rents', 'Nearby building sales', 'Cash flow with a mortgage']);
  keep.querySelector('[data-goal="build"]').click();
  assert.deepEqual(goals, ['build']);
  const build = view('build');
  assert.equal(build.querySelector('.inspector-actions .primary').textContent, 'Underwrite');
  assert.deepEqual(order(build), ['build', 'keep']);
  assert.ok([...build.querySelectorAll('.inspector-menu .home-follow')].some(b => b.textContent === 'Underwrite to keep'), 'the other underwriting stays one click away');
});
