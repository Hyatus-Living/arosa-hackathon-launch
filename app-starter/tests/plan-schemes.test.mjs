import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';

const {document, window} = parseHTML('<!doctype html><html><body><div id="core-page"></div></body></html>');
globalThis.document = document;
globalThis.window = window;
globalThis.EventSource = class { addEventListener() {} close() {} };
const {renderSchemeSwitcher, schemeFromSearch, schemePlanPath, draftSchemePlans, draftSummary, renderSchemePlan} = await import('../public/plan-schemes.js');
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();
const heads = (revisions) => ({schemes: ['as_of_right', 'max_bonus', 'alternative'].map((scheme, i) => ({scheme, revision: revisions[i] ?? null}))});
const report = (fit = {fits: true, issues: []}) => ({unitsPerFloor: 4, storeys: 6, typicalFloorUnits: 24, buildingUnits: 26, netToGross: 0.8, fit});

test('the scheme address and the links the schemes card uses', () => {
  assert.equal(schemeFromSearch('?scheme=max_bonus'), 'max_bonus');
  assert.equal(schemeFromSearch('?scheme=nope'), 'as_of_right');
  assert.equal(schemeFromSearch(''), 'as_of_right');
  assert.equal(schemePlanPath('proj 1', 'alternative'), '/modeling/proj%201?scheme=alternative');
});

test('draftSchemePlans prices the schemes before queuing the drafts', async () => {
  const calls = [];
  const api = {get: async (path) => { calls.push(['GET', path]); return {}; }, post: async (path, body) => { calls.push(['POST', path, body]); return {drafts: []}; }};
  assert.deepEqual(await draftSchemePlans(api, 'proj_1'), {drafts: []});
  assert.deepEqual(calls, [['GET', '/projects/proj_1/schemes'], ['POST', '/projects/proj_1/architecture/schemes/draft', {}]]);
});

test('a new Modeling project has no inherited financial variants or draft-all action',()=>{
  const root=renderSchemeSwitcher({scheme:'as_of_right',summary:heads([]),existingOnly:true});
  assert.deepEqual([...root.querySelectorAll('[data-plan-scheme]')].map(b=>b.dataset.planScheme),['as_of_right']);
  assert.equal(root.querySelector('[data-plan-draft]'),null);
});

test('the switcher names each scheme with its state, and Draft all three stays secondary to the current plan action', () => {
  const none = renderSchemeSwitcher({scheme: 'as_of_right', summary: heads([]), drafts: [], drafting: false, error: null});
  assert.deepEqual([...none.querySelectorAll('[data-plan-scheme]')].map(text), ['As of right Not drawn yet', 'Most floor area Not drawn yet', 'Alternative Not drawn yet']);
  const action = none.querySelector('[data-plan-draft]');
  assert.equal(text(action), 'Draft all three');assert.equal(action.classList.contains('primary'),false);assert.equal(action.disabled, false);
  assert.equal(none.querySelector('[role="status"]').hidden, true);

  const drafts = [{scheme: 'as_of_right', status: 'succeeded', revision: 3, report: report()}, {scheme: 'max_bonus', status: 'running'}, {scheme: 'alternative', status: 'queued'}];
  const busy = renderSchemeSwitcher({scheme: 'as_of_right', summary: heads([3]), drafts, drafting: false, error: null});
  assert.deepEqual([...busy.querySelectorAll('.core-plan-scheme-state')].map(text), ['4 units a floor', 'Drawing', 'Waiting to draw']);
  assert.equal(busy.querySelector('[data-plan-draft]').disabled, true);
  assert.equal(text(busy.querySelector('[role="status"]')), "4 units a floor over 6 storeys, 24 of the scheme's 26 units. 80% of the floor is in units.");

  const misfit = renderSchemeSwitcher({scheme: 'alternative', summary: heads([3, 1, 1]), drafts: [{scheme: 'alternative', status: 'succeeded', revision: 1, report: report({fits: false, issues: ['10 units do not fit this plate.']})}], drafting: false, error: null});
  const note = misfit.querySelector('[role="status"]');
  assert.match(text(note), /The mix does not fit: 10 units do not fit this plate\.$/);assert.ok(note.classList.contains('tone-warning'));
  const done = misfit.querySelector('[data-plan-draft]');
  assert.equal(text(done), 'Redraw all three');assert.equal(done.classList.contains('primary'), false);

  const failed = renderSchemeSwitcher({scheme: 'max_bonus', summary: heads([3]), drafts: [{scheme: 'max_bonus', status: 'failed', reason: 'A 8 by 12 ft plate is too small for a stair and units.'}], drafting: false, error: null});
  assert.equal(text(failed.querySelector('[role="status"]')), 'This scheme could not be drawn: A 8 by 12 ft plate is too small for a stair and units.');
  // A revision saved after the draft (an edit) is not described by the draft's report.
  const edited = renderSchemeSwitcher({scheme: 'as_of_right', summary: heads([4]), drafts: [{scheme: 'as_of_right', status: 'succeeded', revision: 3, report: report()}], drafting: false, error: null});
  assert.equal(text(edited.querySelector('.core-plan-scheme-state')), 'Revision 4');assert.equal(edited.querySelector('[role="status"]').hidden, true);
});

test('why this plan: the line names the layout chosen, and the details list the rules met, assumed and left to the architect', () => {
  const why = {summary: 'Central core, chosen from 87 layouts: score 85 of 100, 75% of the floor in units, 19 of 19 code and zoning checks met.',
    satisfied: ['Every habitable room has a window on a street, or on a yard or court that meets the zoning minimums (MDL 30(2); NYC BC 2022 1205.2.5)'],
    failed: [], assumed: ['A refuse room on every storey: drawn (Practice)'], architect: ['Lot lines come from the city tax map, not a survey.']};
  const bar = renderSchemeSwitcher({scheme: 'as_of_right', summary: heads([3]), drafts: [{scheme: 'as_of_right', status: 'succeeded', revision: 3, report: {...report(), why}}], drafting: false, error: null});
  assert.equal(text(bar.querySelector('[role="status"]')), `4 units a floor over 6 storeys, 24 of the scheme's 26 units. ${why.summary}`);
  const details = bar.querySelector('.core-plan-scheme-why');
  assert.equal(text(details.querySelector('summary')), 'Why this plan');
  assert.deepEqual([...details.querySelectorAll('h4')].map(text), ['Rules met', 'Assumed, not set by code', 'For the architect to check']);
  // An edited revision is not described by the draft's report.
  assert.equal(renderSchemeSwitcher({scheme: 'as_of_right', summary: heads([4]), drafts: [{scheme: 'as_of_right', status: 'succeeded', revision: 3, report: {...report(), why}}], drafting: false, error: null}).querySelector('.core-plan-scheme-why'), null);
  const card = renderSchemePlan({id: 'as_of_right', label: 'As of right', plan: {planId: 'p1', revision: 3, svg: null, why: why.summary}}, {projectId: 'proj_1'});
  assert.equal(text(card.querySelector('.uw-scheme-plan-why')), why.summary);
  assert.equal(renderSchemePlan({id: 'as_of_right', label: 'As of right', plan: {planId: 'p1', revision: 4, svg: null}}, {projectId: 'proj_1'}).querySelector('.uw-scheme-plan-why'), null);
});

test('a one-unit floor that holds the whole scheme reads naturally', () => {
  assert.equal(draftSummary({unitsPerFloor: 1, storeys: 4, typicalFloorUnits: 4, buildingUnits: 4, netToGross: 0.8, fit: {fits: true, issues: []}}), "1 unit a floor over 4 storeys, the scheme's 4 units. 80% of the floor is in units.");
});

test('floors drawn as plates of their own read as a range of units a floor, and more units than the scheme say so', () => {
  const levels = [{name: 'Cellar', use: 'cellar', storeys: 1, units: 0}, {name: 'Ground floor', use: 'ground', storeys: 1, units: 0},
    {name: 'Level 2 to Level 3', use: 'residential', storeys: 2, units: 11}, {name: 'Level 4 to Level 6', use: 'residential', storeys: 3, units: 10}];
  assert.equal(draftSummary({...report(), levels, typicalFloorUnits: 63, buildingUnits: 63}), "10 to 11 units a floor over 6 storeys, the scheme's 63 units. 80% of the floor is in units.");
  assert.equal(draftSummary({...report(), levels: [{units: 4, storeys: 3}], storeys: 3, typicalFloorUnits: 12, buildingUnits: 11}), "4 units a floor over 3 storeys, 12 units against the scheme's 11. 80% of the floor is in units.");
  const bar = renderSchemeSwitcher({scheme: 'as_of_right', summary: heads([2]), drafts: [{scheme: 'as_of_right', status: 'succeeded', revision: 2, report: {...report(), levels}}], drafting: false, error: null});
  assert.equal(text(bar.querySelector('.core-plan-scheme-state')), '10 to 11 units a floor');
});

test('plan page: switching schemes reopens the editor and walkthrough on that scheme\'s plan, and Draft all three queues the drafts', async () => {
  const requests = [], mounted = [], replaced = [];
  globalThis.history = {state: null, replaceState: (_state, _title, url) => replaced.push(url)};
  window.acresPlanEditor = {unmount() {}};
  globalThis.fetch = async (url, options = {}) => {
    requests.push([options.method || 'GET', url]);
    const body = url.includes('/schemes/draft') ? {drafts: options.method === 'POST' ? [{scheme: 'as_of_right', status: 'running'}] : []} : {title:'Model',fields:{},current: null, revisions: [], schemes: ['as_of_right','max_bonus','alternative'].map(scheme=>({scheme,revision:1}))};
    return {ok: true, status: 200, json: async () => body, headers: {get: () => null}};
  };
  Object.defineProperty(window, 'location', {value: {hash: '', pathname: '/modeling/proj_1', search: '?scheme=max_bonus'}, configurable: true});
  const {createCorePage} = await import('../public/core.js');
  const root = document.querySelector('#core-page');
  const page = createCorePage({root, navigate() {}, underwrite() {}, pendingBox: () => document.createElement('div'), conversationId: () => 'conv_1', canSend: () => true,
    mountConcept: async () => {}, mountArchitecture: async () => {}, mountPlan: async (_node, props) => mounted.push(props), architectureEnabled: () => true});
  const settle = () => new Promise((r) => setTimeout(r, 20));
  page.showPlan('proj_1');
  await settle();
  assert.equal(mounted.at(-1).scheme, 'max_bonus', 'the address names the scheme the page opens');
  assert.ok(requests.some(([m, u]) => m === 'GET' && u === '/api/projects/proj_1/architecture?scheme=max_bonus'));
  assert.equal(root.querySelector('[data-plan-scheme="max_bonus"]').getAttribute('aria-pressed'), 'true');

  root.querySelector('[data-plan-scheme="alternative"]').dispatchEvent(new window.Event('click', {bubbles: true}));
  await settle();
  assert.equal(mounted.at(-1).scheme, 'alternative');
  assert.deepEqual(replaced, ['/modeling/proj_1?scheme=alternative']);
  assert.ok(requests.some(([m, u]) => m === 'GET' && u === '/api/projects/proj_1/architecture?scheme=alternative'));
  assert.equal(root.querySelector('[data-plan-scheme="alternative"]').getAttribute('aria-pressed'), 'true');

  assert.equal(root.querySelector('[data-plan-draft]'),null);
  assert.equal(requests.some(([m,u])=>m==='POST'||u.endsWith('/schemes')),false,'opening saved modeling variants never prices or drafts an underwriting');
  page.leave();
  delete window.location;
});

test('the schemes card\'s floor plan slot shows the drawn floor and opens that scheme\'s plan', async () => {
  const {renderSchemePlan} = await import('../public/plan-schemes.js');
  const node = renderSchemePlan({id: 'max_bonus', label: 'Most floor area', plan: {planId: 'p', revision: 2, svg: '0f1e2d3c-0000-4000-8000-000000000001'}}, {projectId: 'proj_1'});
  assert.equal(node.querySelector('img').getAttribute('src'), '/api/projects/proj_1/architecture/artifacts/0f1e2d3c-0000-4000-8000-000000000001');
  assert.equal(node.querySelector('img').getAttribute('alt'), 'Floor plans of the Most floor area option');
  const link = node.querySelector('a');
  assert.equal(text(link), 'Open the floor plan, revision 2');assert.equal(link.getAttribute('href'), '/modeling/proj_1?scheme=max_bonus');assert.equal(link.dataset.route, link.getAttribute('href'));
  assert.equal(renderSchemePlan({id: 'alternative', label: 'Alternative', plan: {planId: 'p', revision: 1, svg: null}}, {projectId: 'proj_1'}).querySelector('img'), null);
});
