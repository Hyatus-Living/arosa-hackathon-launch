import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {architectureView, jobStatus, architectureEventAffects, followUpMessage} from '../public/core-model.js';
import {architectureStates as S, stateWithArchitecture, job} from './fixtures/architecture-states.mjs';
import {fullState} from './fixtures/project-state.mjs';

const {document, window} = parseHTML('<!doctype html><html><body><div id="core-page"></div><button id="plan-button" hidden></button></body></html>');
globalThis.document = document;
const {renderParcel, renderArchitecture} = await import('../public/core-view.js');
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();
// The card's text with a space between its elements, as a reader sees it.
const words = (node) => node.nodeType === 3 ? node.textContent.trim() : [...node.childNodes].map(words).filter(Boolean).join(' ');
const ready = (summary) => ({status: 'ready', summary, view: architectureView(fullState.id, summary)});
// The walkthrough panel renders on the floor plan page; the site page links there.
const render = (summary, ctx = {}) => {
  const mounts = [];
  const section = renderArchitecture(stateWithArchitecture, {canSend: true, canEdit: true, architecture: ready(summary), architectureViewer: (v) => { mounts.push(v); return document.createElement('canvas'); }, ...ctx});
  return {section, mounts};
};

test('architecture view: empty, plan facts, latest job and viewer inputs from the succeeded job', () => {
  assert.deepEqual(architectureView('proj_1234', S.empty), {kind: 'empty'});
  const v = architectureView('proj 1', S.succeeded);
  assert.equal(v.kind, 'plan');
  assert.equal(v.revision, 3);
  assert.equal(v.revisionCount, 3);
  assert.equal(v.rooms, 5);
  assert.equal(v.levels, 1);
  assert.equal(v.netAreaM2, 80);
  assert.equal(v.job.id, 'job_s', 'the newest job wins over an earlier failure');
  assert.deepEqual(v.viewer, {
    key: 'job_s',
    glbUrl: '/api/projects/proj%201/architecture/artifacts/job_s-glb',
    manifestUrl: '/api/projects/proj%201/architecture/artifacts/job_s-manifest',
    pascalSceneUrl: '/api/projects/proj%201/architecture/artifacts/a-pascal',
  });
  assert.deepEqual(v.preview, {url: '/api/projects/proj%201/architecture/artifacts/job_s-preview', bytes: 1024});
  assert.deepEqual(v.downloads.map((d) => d.kind), ['preview', 'glb', 'blend', 'ifc', 'svg', 'pascal-scene']);
  assert.equal(v.downloads.find((d) => d.kind === 'ifc').url, '/api/projects/proj%201/architecture/artifacts/a-ifc');
  assert.equal(v.downloads.find((d) => d.kind === 'pascal-scene').label, 'Pascal scene (JSON)');
  const planOnly = architectureView('p', S.planOnly);
  assert.equal(planOnly.preview, null, 'no finished job means no preview image');
  assert.deepEqual(planOnly.downloads.map((d) => d.kind), ['ifc', 'svg', 'pascal-scene']);
  assert.equal(architectureView('p', S.noModel).viewer, null, 'no GLB means nothing to walk through');
  assert.equal(architectureView('p', S.running).viewer, null);
  assert.equal(architectureView('p', S.planOnly).job, null);
});

test('job status reads every state honestly', () => {
  assert.deepEqual(jobStatus(null, 3), {status: 'none', text: 'No walkthrough has been built for revision 3.', running: false, failed: false, canRun: true});
  assert.match(jobStatus(job('q', 'queued'), 3).text, /^Queued/);
  assert.equal(jobStatus(job('q', 'queued'), 3).running, true);
  assert.equal(jobStatus(job('q', 'queued'), 3).canRun, false);
  const running = jobStatus(job('r', 'running', {startedAt: Date.UTC(2026, 9, 16, 15, 1)}), 3);
  assert.match(running.text, /^Building the walkthrough for revision 3/);
  assert.equal(running.running, true);
  const failed = jobStatus(job('f', 'failed', {reason: 'The IFC has no storeys to export.'}), 3);
  assert.equal(failed.text, 'The walkthrough job failed: The IFC has no storeys to export.');
  assert.equal(failed.failed, true);
  assert.equal(failed.canRun, true);
  assert.equal(jobStatus(job('f', 'failed'), 3).text, 'The walkthrough job failed. No reason was reported.');
  assert.equal(jobStatus(job('c', 'cancelled'), 3).text, 'The walkthrough job was cancelled.');
  assert.match(jobStatus(job('s', 'succeeded', {finishedAt: Date.UTC(2026, 9, 16, 15, 3)}), 3).text, /^Walkthrough built for revision 3 · Oct 16, 2026/);
});

test('architecture events: job changes and plan saves for this project refresh the section', () => {
  assert.equal(architectureEventAffects({event: 'architecture.job', projectId: 'p1', status: 'running'}, 'p1'), true);
  assert.equal(architectureEventAffects({event: 'architecture.job', projectId: 'p2'}, 'p1'), false);
  assert.equal(architectureEventAffects({event: 'state.updated', projectId: 'p1', keys: ['architecture']}, 'p1'), true);
  assert.equal(architectureEventAffects({event: 'state.updated', projectId: 'p1', keys: ['assumptions']}, 'p1'), false);
  assert.match(followUpMessage({field: 'architecture', action: 'review'}), /^Review the architecture plan for this site/);
});

test('the site page links to the floor plan only when the session enables architecture', () => {
  const root = renderParcel(stateWithArchitecture, {canSend: true});
  assert.equal(root.querySelector('#core-architecture'), null);
  assert.equal(root.querySelector('[data-plan-open]'), null);
});

test('underwriting never embeds plan or walkthrough controls, regardless of saved modeling work',()=>{
  for(const summary of [S.empty,S.planOnly,S.succeeded]){
    const root=renderParcel(stateWithArchitecture,{canSend:true,architecture:ready(summary),architectureViewer:()=>{throw new Error('Underwriting must not mount 3D');}});
    assert.equal(root.querySelector('#core-architecture'),null);
    assert.equal(root.querySelector('#core-massing'),null);
    assert.equal(root.querySelector('[data-plan-open]'),null);
    assert.equal(root.querySelector('[data-follow-field=concepts]'),null);
    assert.equal(root.querySelector('[data-architecture-run]'),null);
  }
});
test('a drafted typical floor reads as units per floor', () => {
  const units = ['Unit 1, studio', 'Unit 2, 1 bedroom', 'Unit 3, 1 bedroom', 'Corridor'];
  const plan = {...S.planOnly.current.plan, rooms: S.planOnly.current.plan.rooms.slice(0, 4).map((r, i) => ({...r, name: units[i]}))};
  const summary = {...S.planOnly, current: {...S.planOnly.current, plan, revision: 1}};
  assert.equal(architectureView('p', summary).unitsPerFloor, 3);
  assert.equal(architectureView('p', S.planOnly).unitsPerFloor, 0, 'an apartment plan has rooms, not units');

});


test('underwriting ignores legacy plan flags and cannot request a design as a prerequisite',()=>{
  for(const action of ['all','regenerate']){
    const message=followUpMessage({action,plan:true,instructions:{architecture:'Draft a building',massing:'Model a tower'}});
    assert.match(message,/without requiring a building model/);
    assert.match(message,/Do not create or revise floor plans, massing models or 3D renders/);
    assert.doesNotMatch(message,/Then:|Draft a building|Model a tower/);
  }
});
test('a site Arosa is still resolving lays out as the site will, with the status where the parcel record appears', () => {
  const stub = {id: null, version: 0, title: '125 Shepherd Ave', fields: {}};
  const starting = {label: '125 Shepherd Ave', section: 'architecture'};
  const root = renderParcel(stub, {canSend: true, canEdit: false, starting, architecture: {status: 'ready', view: null}});
  assert.equal(root.querySelector('h1').textContent, '125 Shepherd Ave');
  const next = root.querySelector('.uw-next');
  assert.ok(next.classList.contains('is-running'));
  assert.match(text(next), /Identifying the parcel for 125 Shepherd Ave…/);
  assert.equal(next.querySelector('[data-open-chat]').textContent, 'Watch in chat');
  assert.equal(root.querySelector('[data-follow-action="all"]'), null, 'nothing to underwrite yet');
  const entry = root.querySelector('#core-architecture');
  assert.equal(entry,null);
  assert.deepEqual([...root.querySelectorAll('.uw-steps > li')].map((s) => s.className), ['uw-step is-todo', 'uw-step is-todo', 'uw-step is-todo', 'uw-step is-todo']);
  assert.match(text(root.querySelector('.uw-snapshot')), /Land price\s*Not set\s*Buildable floor area\s*After step 2/);

  const running = renderParcel(stub, {canSend: true, canEdit: false, starting, run: {label: 'Identifying the parcel', tools: []}, architecture: null});
  assert.equal(running.querySelector('#core-property').className, 'uw-step is-running', 'the run shows in step 1');
  assert.equal(running.querySelector('#core-architecture'), null, 'no floor plan entry without the architecture tools');

  const failed = renderParcel(stub, {canSend: true, canEdit: false, starting: {...starting, failed: true}, architecture: null});
  const outcome = failed.querySelector('.uw-next');
  assert.ok(outcome.classList.contains('is-failed'));
  assert.match(text(outcome), /Arosa could not identify a parcel for 125 Shepherd Ave\./);
  assert.equal(outcome.querySelector('[data-open-chat]').textContent, 'Open the conversation');
});

test('the walkthrough panel carries the plan facts, a provenance chip and its job controls', () => {
  const {section} = render(S.planOnly);
  assert.equal(section.id, 'core-architecture');
  assert.match(text(section.querySelector('.core-provenance')), /Architecture plan: Your input · Oct 16, 2026/);
  assert.match(text(section), /Two-bedroom workflow test/);
  assert.match(text(section), /Revision 3 of 3/);
  assert.match(text(section), /Net room area861 sq ft/);
  assert.match(text(section), /No walkthrough has been built for revision 3\./);
  const run = section.querySelector('[data-architecture-run]');
  assert.equal(run.textContent, 'Render the 3D walkthrough');
  assert.equal(run.disabled, false);
  assert.equal(section.querySelector('[data-follow-field="architecture"]').dataset.followAction, 'review');
  assert.equal(section.querySelector('[data-plan-open]'), null, 'the editor is on the same page');
  assert.equal(section.querySelector('textarea'), null);
});

test('a stale architecture field shows its refresh chip', () => {
  const state = {...stateWithArchitecture, fields: {...stateWithArchitecture.fields, architecture: {...stateWithArchitecture.fields.architecture, stale: 'property'}}};
  const section = renderArchitecture(state, {canSend: true, architecture: ready(S.planOnly), architectureViewer: () => document.createElement('div')});
  assert.match(text(section.querySelector('.core-provenance')), /Needs refresh: the parcel record changed/);
});

test('empty state: the panel says there is no plan yet, leaves the draft to the editor and shows no job control', () => {
  const {section} = render(S.empty);
  assert.match(text(section), /No floor plan yet\./);
  assert.equal(section.querySelector('[data-follow-action="draft"]'), null, 'the editor below carries the draft action');
  assert.match(followUpMessage({field: 'architecture', action: 'draft'}), /^Draft the architecture plan for this site: find a published floor plan .* then render the 3D walkthrough\./);
  assert.equal(section.querySelector('[data-architecture-run]'), null);
  assert.equal(section.querySelector('.core-run'), null);
});

test('loading and failed loads render their own messages', () => {
  const loading = renderArchitecture(stateWithArchitecture, {canSend: true, architecture: {status: 'loading'}});
  assert.equal(loading.querySelector('[role="status"]').textContent, 'Loading the floor plan');
  assert.ok(loading.querySelector('.skel'), 'the panel holds its shape while it loads');
  const failed = renderArchitecture(stateWithArchitecture, {canSend: true, architecture: {status: 'error', error: 'The request timed out.'}});
  assert.match(text(failed.querySelector('.core-fail')), /The floor plan did not load\. The request timed out\.\s*Retry/);
  assert.ok(failed.querySelector('[data-architecture-retry]'), 'one line with a way to try again');
});

test('queued and running jobs use the live run strip and block a second run', () => {
  for (const state of ['queued', 'running']) {
    const {section, mounts} = render(S[state]);
    const strip = section.querySelector('.core-run');
    assert.ok(strip.classList.contains('is-running'), state);
    assert.equal(strip.querySelectorAll('.research-dots i').length, 3);
    assert.equal(strip.querySelector('[role="status"]').textContent, jobStatus(S[state].current.jobs.at(-1), 3).text);
    assert.equal(section.querySelector('[data-architecture-run]').disabled, true);
    assert.equal(mounts.length, 0);
  }
});

test('a failed job shows its reason and can run again', () => {
  const {section, mounts} = render(S.failed);
  const strip = section.querySelector('.core-run');
  assert.ok(strip.classList.contains('is-failed'));
  assert.match(text(strip), /The walkthrough job failed: The IFC has no storeys to export\./);
  assert.equal(section.querySelector('[data-architecture-run]').textContent, 'Render the 3D walkthrough again');
  assert.equal(section.querySelector('[data-architecture-run]').disabled, false);
  assert.equal(mounts.length, 0);
});

test('a succeeded job mounts the walkthrough inline with the job artifacts', () => {
  const {section, mounts} = render(S.succeeded);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].viewer.glbUrl, '/api/projects/proj_1234/architecture/artifacts/job_s-glb');
  assert.ok(section.querySelector('.core-arch-view canvas'));
  assert.match(text(section.querySelector('.core-run')), /Walkthrough built for revision 3/);
  const img = section.querySelector('img.core-arch-preview-img');
  assert.ok(img, 'the finished preview still is shown without opening the walkthrough');
  assert.match(img.getAttribute('src'), /job_s-preview/);
  assert.match(img.getAttribute('alt'), /Two-bedroom workflow test/);
  const links = [...section.querySelectorAll('.core-arch-downloads a')];
  assert.deepEqual(links.map((a) => a.textContent), ['Preview (PNG)', '3D model (GLB)', 'Blender file', 'IFC model', 'Plan (SVG)', 'Pascal scene (JSON)']);
  assert.ok(links.every((a) => a.hasAttribute('download')), 'every finished product downloads');
  assert.doesNotMatch(text(section), /To edit the model/, 'the files are listed without instructions');
  assert.match(links.find((a) => a.textContent === 'IFC model').getAttribute('href'), /a-ifc/);
  const noModel = render(S.noModel);
  assert.equal(noModel.mounts.length, 0);
  assert.match(text(noModel.section), /The last render produced no 3D model/);
});

test('viewers can read the section but not run jobs', () => {
  const {section} = render(S.failed, {canSend: false});
  const run = section.querySelector('[data-architecture-run]');
  assert.equal(run.disabled, true);
  assert.match(run.title, /Viewers/);
});

test('a run in flight or a start error shows on the strip', () => {
  const starting = render(S.planOnly, {architecture: {...ready(S.planOnly), starting: true}}).section;
  assert.equal(starting.querySelector('[data-architecture-run]').disabled, true);
  assert.equal(starting.querySelector('.core-run [role="status"]').textContent, 'Starting the walkthrough…');
  const failed = render(S.planOnly, {architecture: {...ready(S.planOnly), runError: 'Jobs are switched off.'}}).section;
  assert.match(text(failed.querySelector('.core-run')), /The walkthrough did not start\. Jobs are switched off\./);
});

test('controller: the plan page loads the walkthrough, runs a job for the current revision and refreshes on job events', async () => {
  const calls = [];
  let summary = S.planOnly;
  Object.defineProperty(window,'location',{value:new URL('http://localhost/sites/proj_1234/plan'),writable:true,configurable:true});
  window.history={state:null,pushState(state,_title,path){this.state=state;window.location=new URL(path,window.location);}};
  globalThis.window = window;
  // linkedom has no form.elements; the controller reads it to keep unsaved assumption edits.
  Object.defineProperty(window.HTMLElement.prototype, 'elements', {get() { return this.tagName === 'FORM' ? [...this.querySelectorAll('input, select, textarea, button, fieldset')] : undefined; }});
  globalThis.localStorage = {getItem: () => null, setItem() {}};
  window.innerWidth = 1280;
  const sources = [];
  globalThis.EventSource = class { constructor(url) { this.url = url; this.listeners = {}; sources.push(this); } addEventListener(name, fn) { this.listeners[name] = fn; } close() {} };
  globalThis.fetch = async (url, options = {}) => {
    calls.push([options.method || 'GET', url, options.body ? JSON.parse(options.body) : null]);
    const body = url.endsWith('/state') ? stateWithArchitecture : url.endsWith('/architecture') ? summary : url.endsWith('/architecture/jobs') ? job('job_new', 'queued') : {};
    return {ok: true, status: 200, json: async () => body, headers: {get: () => null}};
  };
  const {createCorePage} = await import('../public/core.js');
  const root = document.querySelector('#core-page');
  window.acresPlanEditor = {unmount() {}};
  const page = createCorePage({root, navigate() {}, underwrite() {}, pendingBox: () => document.createElement("div"), conversationId: () => null, canSend: () => true, mountConcept: async () => {}, mountArchitecture: async () => {}, mountPlan: async () => {}, architectureEnabled: () => true});
  const settle = () => new Promise((r) => setTimeout(r, 20));
  page.showParcel('proj_1234');
  await settle();
  assert.equal(root.querySelector('#core-architecture'),null);
  page.showPlan('proj_1234');
  await settle();
  assert.ok(calls.some(([m, u]) => m === 'GET' && u === '/api/projects/proj_1234/architecture'));
  assert.ok(root.querySelector('.core-plan-stage > .core-plan-massing + .core-plan-mount'), 'the walkthrough and the editor share one stage');
  assert.equal(root.querySelector('.core-plan-walkthrough .core-plan-3d-empty').textContent, 'The 3D walkthrough appears here once it is rendered.');
  assert.match(text(root.querySelector('.core-plan-walkthrough #core-architecture')), /No walkthrough has been built/);

  root.querySelector('[data-architecture-run]').dispatchEvent(new window.Event('click', {bubbles: true}));
  await settle();
  assert.deepEqual(calls.find(([m]) => m === 'POST'), ['POST', '/api/projects/proj_1234/architecture/jobs', {revision: 3}]);

  summary = S.running;
  const before = calls.length;
  sources.at(-1).onmessage({data: JSON.stringify({event: 'architecture.job', projectId: 'proj_1234', jobId: 'job_r', revision: 3, status: 'running'})});
  await settle();
  assert.ok(calls.slice(before).some(([, u]) => u === '/api/projects/proj_1234/architecture'));
  assert.ok(root.querySelector('.core-plan-walkthrough #core-architecture .core-run.is-running'));
  page.leave();
});

test('plan page: the section opens the plan route, which mounts the editor and unmounts it on leave', async () => {
  const navigated = [], mounted = [], unmounted = [], notes = [];
  window.acresPlanEditor = {unmount: (node) => unmounted.push(node)};
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.fetch = async (url) => ({ok: true, status: 200, json: async () => (url.endsWith('/state') ? stateWithArchitecture : S.empty), headers: {get: () => null}});
  document.addEventListener('acres-follow-up', (e) => notes.push(e.detail));
  const {createCorePage} = await import('../public/core.js');
  const root = document.querySelector('#core-page');
  const page = createCorePage({root, navigate: (path) => navigated.push(path), underwrite() {}, pendingBox: () => document.createElement("div"), conversationId: () => 'conv_1', canSend: () => true, mountConcept: async () => {}, mountArchitecture: async () => {}, mountPlan: async (node, props) => mounted.push([node, props]), architectureEnabled: () => true});
  page.showParcel('proj_1234');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(root.querySelector('[data-plan-open]'),null);

  page.showPlan('proj_1234');
  assert.equal(document.title, 'Floor plan · Arosa');
  const back=root.querySelector('.core-plan-head .core-back');
  assert.equal(back.dataset.route,'/modeling');
  assert.equal(back.textContent,'Modeling');
  assert.equal(root.querySelectorAll('.core-plan-head .core-back').length,1);
  assert.equal(root.querySelector('.core-plan-head h1').textContent,'Modeling');
  assert.equal(root.querySelector('.core-plan-head .core-chat-toggle'), null, 'the docked chat is opened from the top bar on every page');
  const pressed = () => [...root.querySelectorAll('.core-plan-head [data-plan-view]')].map((b) => [b.textContent, b.getAttribute('aria-selected')]);
  assert.deepEqual(pressed(), [['Floor plan', 'true'], ['3D walkthrough', 'false'], ['Building model','false']], 'the page opens on the editor');
  assert.equal(root.querySelector('.core-plan-walkthrough').hidden, true);
  assert.equal(root.querySelector('.core-plan-mount').hidden, false);
  assert.ok(root.querySelector('.core-plan-head + .core-plan-schemes-slot + .core-plan-stage'), 'header, scheme switcher, then one stage');
  assert.equal(root.querySelector('.core-plan-head [data-open-chat]'), null, 'the chat opens from the ask handle, as on every page');
  root.querySelector('[data-plan-view="walkthrough"]').dispatchEvent(new window.Event('click', {bubbles: true}));
  assert.deepEqual(pressed(), [['Floor plan', 'false'], ['3D walkthrough', 'true'], ['Building model','false']]);
  assert.equal(root.querySelector('.core-plan-walkthrough').hidden, false);
  assert.equal(root.querySelector('.core-plan-mount').hidden, true, 'the editor stays mounted, only hidden');
  root.querySelector('[data-plan-view="editor"]').dispatchEvent(new window.Event('click', {bubbles: true}));
  assert.equal(root.querySelector('.core-plan-mount').hidden, false);
  assert.deepEqual([...root.querySelectorAll('[data-plan-scheme]')].map((b) => [b.dataset.planScheme, b.getAttribute('aria-pressed')]), [['as_of_right', 'true']]);
  assert.equal(mounted.length, 1);
  const [node, props] = mounted[0];
  assert.ok(node.classList.contains('core-plan-mount') && node.isConnected);
  assert.equal(props.projectId, 'proj_1234');
  assert.equal(props.scheme, 'as_of_right', 'the plan page opens the as-of-right plan by default');
  page.showPlan('proj_1234');
  assert.equal(mounted.length, 1, 'showing the same plan again keeps the editor');

  props.onAction({kind: 'revision', revision: 4});
  assert.deepEqual(notes, [{projectId: 'proj_1234', planNote: {kind: 'revision', revision: 4}}]);

  page.showParcel('proj_1234');
  assert.deepEqual(unmounted, [node]);
  // A plan started from a listing also leads back to that listing.
  page.showPlan('proj_1234', {listingPath: '/listings/broker%3Aripco%3A11%3Afor_sale?search=x'});
  const crumbs = [...root.querySelectorAll('.core-plan-head .core-back')].map((a) => [a.textContent, a.dataset.route]);
  assert.deepEqual(crumbs, [['Modeling','/modeling'], ['Back to listing', '/listings/broker%3Aripco%3A11%3Afor_sale?search=x']]);
  page.leave();
  assert.equal(unmounted.length, 2);
  assert.equal(root.children.length, 0);
});


test('plan notes carry the project and stop once the editor is gone', async () => {
  const mounted = [], notes = [];
  window.acresPlanEditor = {unmount() {}};
  globalThis.CustomEvent = window.CustomEvent;
  document.addEventListener('acres-follow-up', (e) => notes.push(e.detail));
  const {createCorePage} = await import('../public/core.js');
  const root = document.querySelector('#core-page');
  const page = createCorePage({root, navigate() {}, underwrite() {}, pendingBox: () => document.createElement("div"), conversationId: () => 'conv_1', canSend: () => true, mountConcept: async () => {}, mountArchitecture: async () => {}, mountPlan: async (node, props) => mounted.push(props), architectureEnabled: () => true});
  page.showPlan('proj_notes');
  mounted[0].onAction({kind: 'revision', revision: 4});
  assert.deepEqual(notes.at(-1), {projectId: 'proj_notes', planNote: {kind: 'revision', revision: 4}});
  const count = notes.length;
  page.showPlan('proj_other');
  mounted[0].onAction({kind: 'drawing', name: 'late.png'});
  assert.equal(notes.length, count, 'a late note from the unmounted editor is dropped');
  page.leave();
});
