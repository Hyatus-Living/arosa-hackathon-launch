import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {createListings} from '../public/listings.js';
import {defaultFilterValues, validateFilterValues} from '../public/listing-filter-schema.js';
import {normalizeDealSettings} from '../../acres-research/market-store.mjs';

const defaults = {hardCostPerGrossSqft: 375, softCostPctOfHard: .22, carryAndFinancingPct: .1, zfaToGrossFactor: 1.15};
const keys = Object.keys(defaults), flush = () => new Promise(setImmediate);
const profile = (values = {}, isCustom = false) => ({isCustom, dealSettings: normalizeDealSettings(values), baselineSettings: normalizeDealSettings()});
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const dispatchStart = appSource.indexOf('  for (const m of state.messages) {', appSource.indexOf('function render() {'));
const dispatchEnd = appSource.indexOf('\n  if (route.view === "site" && coreCanSend', dispatchStart);
assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
function replyDispatcher(listings, filterUpdate) {
  const reply = {id: 'reply', role: 'assistant', runId: 'listing-run', filterUpdate};
  const context = {state: {messages: [{...reply, id: 'other-browser', runId: 'untracked'}, reply]}, listings,
    view: 'sites', listingRuns: new Set(['listing-run']), appliedSearches: new Set()};
  context.listingsMode = () => context.view === 'home';
  vm.createContext(context);
  vm.runInContext('function renderReplies() {\n' + appSource.slice(dispatchStart, dispatchEnd) + '\n}', context);
  return context;
}
const row = {id: 'one', bbl: '3009660001', address: '10 Context Street', borough: 'BK', zipCode: '11201', zoningDistrict: 'R7A', lotAreaSqft: 2500, existingBldgAreaSqft: 2000, maxUapZfa: 10000, maxStandardZfa: 10000, unusedUapZfa: 8000, listPrice: 2400000, maxBuildableUnits: 14, similarComps: [], flashcardValuation: {dealVerdict: 'good_deal', impliedYieldOnCostPct: 6.4, impliedCondoMarginPct: 21.5, estimatedConstructionCost: 5000000}};
const button = (root, name) => [...root.querySelectorAll('button')].find(node => node.textContent === name);
const chooseBorough = (c, value) => {
  const control=[...c.root.querySelectorAll('label.listings-control')].find(label=>label.querySelector('.sr-only')?.textContent==='Borough').querySelector('select');
  control.querySelector(`option[value="${value}"]`).selected=true;
  control.dispatchEvent(new c.window.Event('change',{bubbles:true}));
};

async function setup(t, bootstrap = true) {
  const {document, window} = parseHTML(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  globalThis.document = document; globalThis.window = window;
  const c = {document, window, root: document.querySelector('#home-listings'), requests: [], underwrites: []};
  globalThis.fetch = (url, options = {}) => new Promise(resolve => c.requests.push({url, method: options.method || 'GET', params: new URL(url, 'http://fixture').searchParams, path: new URL(url, 'http://fixture').pathname, body: options.body && JSON.parse(options.body), answered: false, answer(body, status = 200) {this.answered = true;resolve(new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}}));}}));
  t.after(() => {delete globalThis.fetch;});
  c.map = {handlers: null, setPins() {}, setActive() {}, setSelected() {}, resize() {}, bounds: () => ({south: 40.6, west: -74, north: 40.8, east: -73.9})};
  c.listings = createListings({root: c.root, canStart: () => true, onUnderwrite: (deal, prompt) => c.underwrites.push({deal, prompt}), onAsk() {}, onToggleChat() {}, isChatOpen: () => false, loadMap: async (_node, handlers) => {c.map.handlers = handlers;return c.map;}});
  c.listings.show(); await flush();
  c.costs = c.root.querySelector('.listings-costs');
  c.fields = Object.fromEntries(keys.map((key, i) => [key, c.costs.querySelectorAll('input')[i]]));
  c.type = (key, value) => {c.fields[key].value = String(value);c.fields[key].dispatchEvent(new window.Event('input', {bubbles: true}));};
  c.click = name => button(c.costs, name).click();
  c.preview = () => c.costs.querySelector('form').dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
  c.take = path => c.requests.filter(request => request.path === '/api/market-store/' + path);
  c.answerPage = async (request = c.take('deals').at(-1), settings = profile()) => {request.answer({deals: [row], total: 1, offset: 0, limit: 20, userSettings: settings});await flush();};
  c.answerPins = async () => {for (const request of c.take('deals/pins').filter(r => !r.answered)) request.answer({pins: [], total: 1});await flush();};
  c.summary = () => c.costs.closest('details').querySelector('summary').textContent;
  c.note = () => c.costs.querySelector('.listings-costs-note').textContent;
  if (bootstrap) {await c.answerPage();await c.answerPins();}
  return c;
}

test('raw cost drafts survive initial loading, map/filter refreshes and preserve their input nodes', async t => {
  const c = await setup(t, false), hard = c.fields.hardCostPerGrossSqft;
  c.type('hardCostPerGrossSqft', '478.5'); await c.answerPage(); await c.answerPins();
  assert.equal(hard.value, '478.5'); assert.ok(c.costs.querySelector('input') === hard, 'The same input node stays mounted');
  c.map.handlers.onMove(c.map.bounds()); await c.answerPage(undefined, profile({hardCostPerGrossSqft: 600}, true));
  assert.equal(hard.value, '478.5'); assert.equal(c.listings.filterSnapshot().values.hardCostPerGrossSqft, 375);
  assert.match(c.note(), /not applied/i);
});

test('preview normalizes owner precision, preserves zero, freezes query costs and labels only completed results', async t => {
  const c = await setup(t);
  c.type('hardCostPerGrossSqft', '478.5'); c.type('softCostPctOfHard', 0); c.type('carryAndFinancingPct', 0); c.type('zfaToGrossFactor', '1.2346');c.preview();await flush();
  const request = c.take('deals').at(-1);
  assert.equal(request.params.get('hardCostPerGrossSqft'), '479');assert.equal(request.params.get('rentalHardCostPerGrossSqft'), '479');assert.equal(request.params.get('condoHardCostPerGrossSqft'), '375', 'the untouched condo hard cost rides along at the house figure');assert.equal(request.params.get('softCostPctOfHard'), '0');assert.equal(request.params.get('zfaToGrossFactor'), '1.235');
  assert.equal(c.summary(), 'Costs: $375/GSF', 'Old cards retain their cost context while the preview loads');
  c.type('hardCostPerGrossSqft', 900);assert.match(c.note(), /not applied/i);await c.answerPage(request);
  assert.equal(c.summary(), 'Costs: $479 R · $375 C /GSF');assert.equal(c.fields.hardCostPerGrossSqft.value, '900');
  c.map.handlers.onMove(c.map.bounds()); const next = c.take('deals').at(-1);
  assert.equal(next.params.get('hardCostPerGrossSqft'), '479');assert.equal(next.params.get('carryAndFinancingPct'), '0');
  await c.answerPage(next, profile({hardCostPerGrossSqft: 600}, true));
  assert.equal(c.summary(), 'Costs: $479 R · $375 C /GSF');assert.equal(c.listings.filterSnapshot().values.hardCostPerGrossSqft, 479);
  assert.equal(c.listings.filterSnapshot().baselineCosts.hardCostPerGrossSqft, 600);
});

test('detail underwriting uses the response query costs rather than a newer saved baseline or raw draft', async t => {
  const c = await setup(t);c.root.querySelector('.listing-card-open').click();await flush();
  const detail = c.take('deals/one').at(-1);assert.equal(detail.params.get('hardCostPerGrossSqft'), '375');
  c.type('hardCostPerGrossSqft', 900);c.map.handlers.onMove(c.map.bounds());await c.answerPage(undefined, profile({hardCostPerGrossSqft: 600}, true));
  detail.answer({deal: row, userSettings: profile()});await flush();
  button(c.root, 'Underwrite').click();assert.match(c.underwrites[0].prompt, /\$375\/GSF hard cost/);
  assert.equal(c.fields.hardCostPerGrossSqft.value, '900');
});

test('cost previews refresh the open property and label its completed figures even if the list refresh fails', async t => {
  const c = await setup(t);c.root.querySelector('.listing-card-open').click();await flush();
  c.take('deals/one').at(-1).answer({deal: row, userSettings: profile()});await flush();
  c.type('hardCostPerGrossSqft', 900);c.preview();await flush();
  const detail = c.take('deals/one').at(-1);assert.equal(detail.params.get('hardCostPerGrossSqft'), '900');
  detail.answer({deal: {...row, estimatedConstructionCost: 9000000}, userSettings: profile()});
  c.take('deals').at(-1).answer({error: 'List refresh failed'}, 503);await flush();
  assert.equal(c.summary(), 'Costs: $900 R · $375 C /GSF');button(c.root, 'Underwrite').click();assert.match(c.underwrites[0].prompt, /\$900\/GSF rental hard cost, \$375\/GSF condo hard cost/);
});

test('saving defaults is serialized, keeps newer typing and waits for new results before relabeling them', async t => {
  const c = await setup(t);c.type('hardCostPerGrossSqft', 420);c.click('Save as my costs');await flush();
  const write = c.take('user-settings').at(-1);assert.equal(write.body.dealSettings.hardCostPerGrossSqft, 420);
  assert.equal(button(c.costs, 'Reset to house costs').disabled, true);
  c.click('Reset to house costs');c.preview();assert.equal(c.take('user-settings').length, 1);
  c.type('hardCostPerGrossSqft', 500);assert.match(c.note(), /saving.*newer edits/i);write.answer(profile({hardCostPerGrossSqft: 420}, true));await flush();
  assert.equal(c.fields.hardCostPerGrossSqft.value, '500');assert.equal(c.summary(), 'Costs: $375/GSF');
  assert.match(c.note(), /saved.*updating/i);assert.equal(c.take('deals').at(-1).params.get('hardCostPerGrossSqft'), '420');
  await c.answerPage(undefined, profile({hardCostPerGrossSqft: 420}, true));assert.equal(c.summary(), 'Costs: $420/GSF');assert.equal(c.fields.hardCostPerGrossSqft.value, '500');
});

test('invalid cost forms do not silently remove overrides or send partial/default-changing writes', async t => {
  const c = await setup(t), before = c.requests.length, original = c.listings.filterSnapshot().values;
  for (const value of ['', -1, 99, 2501, 'not a number']) {
    c.type('hardCostPerGrossSqft', value);c.preview();c.click('Save as my costs');await flush();
    assert.equal(c.requests.length, before, String(value));assert.equal(c.fields.hardCostPerGrossSqft.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(c.listings.filterSnapshot().values, original);
  }
});

test('failed default writes or failed result refreshes keep drafts and distinguish saved defaults from displayed results', async t => {
  const c = await setup(t);c.type('hardCostPerGrossSqft', 420);c.click('Save as my costs');await flush();
  c.take('user-settings').at(-1).answer({error: 'Could not save'}, 503);await flush();
  assert.equal(c.fields.hardCostPerGrossSqft.value, '420');assert.equal(button(c.costs, 'Save as my costs').disabled, false);assert.equal(c.summary(), 'Costs: $375/GSF');
  c.click('Save as my costs');await flush();c.take('user-settings').at(-1).answer(profile({hardCostPerGrossSqft: 420}, true));await flush();
  c.take('deals').at(-1).answer({error: 'Could not fetch'}, 503);await flush();
  assert.equal(c.summary(), 'Costs: $375/GSF');assert.match(c.note(), /saved.*could not update/i);
  assert.equal(c.listings.filterSnapshot().values.hardCostPerGrossSqft, 420);
});

test('chat preserves unrelated cost drafts, clears changed fields and Undo restores the draft as well as applied values', async t => {
  const c = await setup(t);c.type('hardCostPerGrossSqft', 900);c.type('softCostPctOfHard', 0);
  let base = c.listings.filterSnapshot();assert.equal(c.listings.applyFilterUpdate({base, values: {...base.values, borough: 'BK'}}), true);
  assert.equal(c.fields.hardCostPerGrossSqft.value, '900');assert.equal(c.fields.softCostPctOfHard.value, '0');
  base = c.listings.filterSnapshot();assert.equal(c.listings.applyFilterUpdate({base, values: {...base.values, hardCostPerGrossSqft: 450}}), true);
  assert.equal(c.fields.hardCostPerGrossSqft.value, '450');assert.equal(c.fields.softCostPctOfHard.value, '0');
  button(c.root, 'Undo').click();assert.equal(c.fields.hardCostPerGrossSqft.value, '900');assert.equal(c.listings.filterSnapshot().values.hardCostPerGrossSqft, 375);
});

test('successive chat commands retain the documented grouped Undo restore point',async t=>{
  const c=await setup(t),before=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:before,values:{...before.values,maxPrice:750000}});
  const next=c.listings.filterSnapshot();c.listings.applyFilterUpdate({base:next,values:{...next.values,borough:'BK',hardCostPerGrossSqft:450}});
  button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,before.values);
});

test('a deferred reply after manual selection starts Undo from the latest reader state',async t=>{
  const c=await setup(t),initial=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:initial,values:{...initial.values,maxPrice:750000}});
  const request=c.listings.filterSnapshot();chooseBorough(c,'MN');const manual=c.listings.filterSnapshot();
  assert.equal(c.listings.applyFilterUpdate({base:request,values:{...request.values,borough:'BK'}}),false);
  button(c.root,'Apply chat filters').click();assert.equal(c.listings.filterSnapshot().values.borough,'BK');
  button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,manual.values);
});

test('new raw cost work and explicit previews become the reader restore point for the next chat group',async t=>{
  const c=await setup(t),initial=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:initial,values:{...initial.values,borough:'BK',hardCostPerGrossSqft:450}});
  c.type('hardCostPerGrossSqft',900);let manual=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:manual,values:{...manual.values,borough:'MN'}});
  button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,manual.values);assert.equal(c.fields.hardCostPerGrossSqft.value,'900');
  c.preview();manual=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:manual,values:{...manual.values,borough:'QN',hardCostPerGrossSqft:600}});
  button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,manual.values);assert.equal(c.fields.hardCostPerGrossSqft.value,'900');
});

test('a successful baseline write re-enables its deferred Apply and Undo keeps the persisted baseline',async t=>{
  const c=await setup(t),initial=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:initial,values:{...initial.values,borough:'BK',hardCostPerGrossSqft:450}});
  const request=c.listings.filterSnapshot();c.click('Save as my costs');await flush();
  assert.equal(c.listings.applyFilterUpdate({base:request,values:{...request.values,borough:'MN'}}),false);
  const apply=button(c.root,'Apply chat filters');assert.equal(apply.disabled,true);
  c.take('user-settings').at(-1).answer(profile({hardCostPerGrossSqft:450},true));await flush();
  assert.equal(apply.disabled,false);assert.doesNotMatch(c.root.querySelector('.listings-receipt').textContent,/still saving/,c.root.querySelector('.listings-receipt').innerHTML);
  apply.click();assert.equal(c.listings.filterSnapshot().values.borough,'MN');
  button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,initial.values);
  assert.equal(c.listings.filterSnapshot().baselineCosts.hardCostPerGrossSqft,450);
});

test('invalid modern and legacy replies retain the current valid grouped Undo action',async t=>{
  const c=await setup(t),initial=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:initial,values:{...initial.values,borough:'BK',hardCostPerGrossSqft:450}});
  const base=c.listings.filterSnapshot();
  for(let i=0;i<2;i++)assert.equal(c.listings.applyFilterUpdate({base,values:{...base.values,minPrice:2000000,maxPrice:1000000}}),false);
  assert.ok(button(c.root,'Undo'));button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,initial.values);
  c.listings.applySearch({borough:'BK',maxListPrice:750000});
  assert.equal(c.listings.applySearch({minListPrice:2000000,maxListPrice:1000000}),false);
  assert.ok(button(c.root,'Undo'));button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,initial.values);
});

test('a failed baseline write also re-enables deferred Apply and retains the existing Undo group',async t=>{
  const c=await setup(t),initial=c.listings.filterSnapshot();
  c.listings.applyFilterUpdate({base:initial,values:{...initial.values,borough:'BK',hardCostPerGrossSqft:450}});
  const request=c.listings.filterSnapshot();c.click('Save as my costs');await flush();
  c.listings.applyFilterUpdate({base:request,values:{...request.values,borough:'MN'}});
  const apply=button(c.root,'Apply chat filters');assert.equal(apply.disabled,true);
  c.take('user-settings').at(-1).answer({error:'Synthetic write failure',userFacing:true},500);await flush();
  assert.equal(apply.disabled,false);assert.match(c.note(),/Synthetic write failure/);
  assert.ok(button(c.root,'Undo'));button(c.root,'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values,initial.values);
  assert.equal(c.listings.filterSnapshot().baselineCosts.hardCostPerGrossSqft,375);
});

test('underwriting preserves noninteger cost percentages from the applied response snapshot', async t => {
  const c = await setup(t);c.type('softCostPctOfHard', 12.3);c.type('carryAndFinancingPct', 7.8);c.preview();await flush();
  assert.equal(c.take('deals').at(-1).params.get('softCostPctOfHard'), '0.123');
  await c.answerPage();c.root.querySelector('.listing-card-open').click();await flush();
  c.take('deals/one').at(-1).answer({deal: row, userSettings: profile()});await flush();
  button(c.root, 'Underwrite').click();assert.match(c.underwrites[0].prompt, /12\.3% soft cost, 7\.8% carry/);
});

test('canonical filter cost precision matches the owning model for manual and Jev values', () => {
  const raw = {...defaultFilterValues(), hardCostPerGrossSqft: 478.5, softCostPctOfHard: .12345, carryAndFinancingPct: 0, zfaToGrossFactor: 1.2346};
  const expected = normalizeDealSettings(raw), actual = validateFilterValues(raw);
  for (const key of keys) assert.equal(actual[key], expected[key], key);
});

test('a filter reply completed on Sites stays pending until the map returns and applies once with Undo', async t => {
  const c = await setup(t), base = c.listings.filterSnapshot();
  const values = {...base.values, borough: 'BK', maxPrice: 2000000, types: ['land'], softCostPctOfHard: 0};
  const dispatch = replyDispatcher(c.listings, {base, values}), initialRequests = c.take('deals').length;
  dispatch.renderReplies();
  assert.equal(dispatch.appliedSearches.size, 0, 'A reply has not been applied while the map is hidden');
  assert.deepEqual(c.listings.filterSnapshot().values, base.values);
  assert.equal(c.take('deals').length, initialRequests);
  dispatch.view = 'home';dispatch.renderReplies();
  assert.deepEqual(c.listings.filterSnapshot().values, values);
  assert.equal(c.take('deals').length, initialRequests + 1);
  assert.equal(c.take('deals').at(-1).params.get('styles'), 'land');
  assert.equal(c.take('deals').at(-1).params.get('softCostPctOfHard'), '0');
  assert.equal(dispatch.appliedSearches.has('other-browser'), false);
  dispatch.renderReplies();assert.equal(c.take('deals').length, initialRequests + 1);
  button(c.root, 'Undo').click();
  assert.deepEqual(c.listings.filterSnapshot().values, base.values);
  dispatch.renderReplies();assert.equal(c.take('deals').length, initialRequests + 2, 'An undone reply is not replayed');
});

test('a deferred reply preserves intervening manual filters and offers explicit Apply with Undo', async t => {
  const c = await setup(t), base = c.listings.filterSnapshot();
  const values = {...base.values, borough: 'BK', maxPrice: 2000000};
  const dispatch = replyDispatcher(c.listings, {base, values});
  dispatch.renderReplies();
  const borough = c.root.querySelector('select');
  for (const option of borough.querySelectorAll('option')) option.selected = false;
  borough.querySelector('option[value="QN"]').selected = true;
  borough.dispatchEvent(new c.window.Event('change', {bubbles: true}));
  const manual = c.listings.filterSnapshot();assert.equal(manual.values.borough, 'QN');
  dispatch.view = 'home';dispatch.renderReplies();
  assert.deepEqual(c.listings.filterSnapshot().values, manual.values);
  const apply = button(c.root, 'Apply chat filters');assert.ok(apply, 'The deferred reply remains available');
  apply.click();assert.deepEqual(c.listings.filterSnapshot().values, values);
  button(c.root, 'Undo').click();assert.deepEqual(c.listings.filterSnapshot().values, manual.values);
  const requests = c.take('deals').length;dispatch.renderReplies();
  assert.equal(c.take('deals').length, requests);
});

test('costs apply when a field changes, with one save action and a quiet reset only once costs differ from the house', async t => {
  const c = await setup(t), before = c.take('deals').length;
  assert.equal(c.costs.querySelector('form').classList.contains('is-loading'), false);
  assert.deepEqual([...c.costs.querySelectorAll('button')].map(node => node.textContent), ['Save as my costs', 'Reset to house costs']);
  assert.equal(button(c.costs, 'Save as my costs').disabled, true, 'nothing to save at the house costs');
  assert.equal(button(c.costs, 'Reset to house costs').hidden, true);assert.equal(c.note(), 'House costs.');
  c.type('hardCostPerGrossSqft', 520);assert.equal(c.take('deals').length, before, 'typing alone does not search');
  c.fields.hardCostPerGrossSqft.dispatchEvent(new c.window.Event('change', {bubbles: true}));await flush();
  assert.equal(c.take('deals').length, before + 1);assert.equal(c.take('deals').at(-1).params.get('hardCostPerGrossSqft'), '520');assert.equal(c.take('deals').at(-1).params.get('condoHardCostPerGrossSqft'), '375');
  await c.answerPage();assert.equal(c.summary(), 'Costs: $520 R · $375 C /GSF');
  assert.match(c.note(), /not saved/i);assert.equal(button(c.costs, 'Save as my costs').disabled, false);assert.equal(button(c.costs, 'Reset to house costs').hidden, false);
});

test('the snapshot chat analysis receives carries the page\'s condo hard cost beside the rental figure', async t => {
  const c = await setup(t), condo = c.costs.querySelector('input[name="condoHardCostPerGrossSqft"], input[id*="condo"]');
  condo.value = '700';condo.dispatchEvent(new c.window.Event('input', {bubbles: true}));condo.dispatchEvent(new c.window.Event('change', {bubbles: true}));await flush();
  assert.equal(c.take('deals').at(-1).params.get('condoHardCostPerGrossSqft'), '700');
  await c.answerPage();
  assert.equal(c.listings.filterSnapshot().condoHardCostPerGrossSqft, 700);
});

test('before the first results the cost fields hold their shape and the chip keeps its name', async t => {
  const c = await setup(t, false), form = c.costs.querySelector('form');
  assert.equal(form.classList.contains('is-loading'), true);assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(c.costs.querySelectorAll('.skel-field').length, 5);assert.equal(c.note(), '');
  assert.equal(c.summary(), 'Costs');assert.ok(c.costs.closest('details').querySelector('summary .skel-chip'));
  await c.answerPage();assert.equal(form.classList.contains('is-loading'), false);assert.equal(c.summary(), 'Costs: $375/GSF');
});

test('Set your costs on a listing page opens the Costs control above the listing, and saved costs are named', async t => {
  const c = await setup(t);c.root.querySelector('.listing-card-open').click();await flush();
  const driver = {program: 'standard', exit: 'condo', buildableZfa: 10000, affordableZfa: 0, storeys: 6, floorplateSqft: 1700, netEfficiency: 0.85, heightClass: 'low-rise', narrowLot: false, hardCostPerGrossSqft: 410, baseHardCostPerGrossSqft: 410, heightClassFactor: 1, narrowLotFactor: 1, grossFactor: 1.15};
  c.take('deals/one').at(-1).answer({deal: {...row, flashcardValuation: {...row.flashcardValuation, valueDriver: driver}}, userSettings: profile({hardCostPerGrossSqft: 410}, true)});await flush();
  const section = c.root.querySelector('.listings');
  assert.ok(section.classList.contains('is-inspecting'));
  assert.match(c.root.querySelector('.listing-inspector').textContent, /Hard cost\$410\/GSF, your saved costs for low-rise/);
  const pop = c.costs.closest('details');
  assert.ok(!pop.open);
  button(c.root.querySelector('.listing-inspector'), 'Set your costs').click();
  assert.equal(pop.open, true);
  assert.ok(section.classList.contains('is-costs-open'), 'the Costs control shows above the listing while open');
});
