import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {underwritingChecklist, followUpMessage} from '../public/core-model.js';
import {architectureStates as S} from './fixtures/architecture-states.mjs';
import {fullState} from './fixtures/project-state.mjs';

const {document, window} = parseHTML('<!doctype html><html><body><div id="core-page"></div><button id="plan-button" hidden></button></body></html>');
globalThis.document = document;
const words = (node) => node.nodeType === 3 ? node.textContent.trim() : [...node.childNodes].map(words).filter(Boolean).join(' ');
const {parcel, envelope} = {parcel: fullState.fields.property, envelope: fullState.fields.envelope};
const since = Date.UTC(2026, 9, 20, 12, 0);
// A site with only its parcel record, and the same site after an agent that produced only an envelope.
const before = {...fullState, version: 1, fields: {property: parcel}};
const after = {...fullState, version: 2, fields: {property: parcel, envelope: {...envelope, updated: since + 60000}}};

test('the checklist marks each section produced, kept, stale or missing against when the run was sent', () => {
  const statuses = (state, plan) => Object.fromEntries(underwritingChecklist(state, since, plan).items.map((i) => [i.id, i.status]));
  assert.deepEqual(statuses(after), {property: 'kept', publicRecords: 'missing', envelope: 'produced', entitlements: 'missing', market: 'missing', program: 'missing', proFormas: 'missing', comparisons: 'missing', keep: 'missing'});
  assert.equal(statuses(fullState).proFormas, 'stale');
  assert.equal(statuses(after, 'missing').architecture, undefined);
  assert.match(underwritingChecklist(after, since).exclusions[0], /^Site assembly is not part of a full underwriting/);
});

test('controller: after a full underwriting where the agent produced only an envelope, the page reports massing, unit mix and pro forma not produced', async () => {
  const follows = [];
  let state = before;
  globalThis.window = window;
  // linkedom has no form.elements; the controller reads it to keep unsaved assumption edits.
  Object.defineProperty(window.HTMLElement.prototype, 'elements', {configurable: true, get() { return this.tagName === 'FORM' ? [...this.querySelectorAll('input, select, textarea, button, fieldset')] : undefined; }});
  globalThis.localStorage = {getItem: () => null, setItem() {}};
  globalThis.EventSource = class { addEventListener() {} close() {} };
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.fetch = async (url) => ({ok: true, status: 200, json: async () => (url.endsWith('/state') ? state : S.empty), headers: {get: () => null}});
  document.addEventListener('acres-follow-up', (e) => { if (e.detail.ref) follows.push(e.detail.ref); });
  const {createCorePage} = await import('../public/core.js');
  const root = document.querySelector('#core-page');
  window.acresPlanEditor = {unmount() {}};
  const page = createCorePage({root, navigate() {}, underwrite() {}, pendingBox: () => document.createElement('div'), conversationId: () => 'conv_1', canSend: () => true, mountConcept: async () => {}, mountArchitecture: async () => {}, mountPlan: async () => {}, architectureEnabled: () => true});
  const settle = () => new Promise((r) => setTimeout(r, 20));
  page.showParcel(fullState.id);
  await settle();
  root.querySelector('.uw-next [data-follow-field="all"]').dispatchEvent(new window.Event('click', {bubbles: true}));
  await settle();
  assert.equal(follows.at(-1).action, 'all');
  assert.match(followUpMessage(follows.at(-1)), /Leave site assembly out/);
  page.setRun({label: 'Sizing the zoning', tools: ['acres_zoning_envelope']});
  assert.equal(root.querySelector('.core-checklist'), null, 'no report while the run works');
  // The agent saves the envelope while the run works.
  state = {...after, fields: {...after.fields, envelope: {...envelope, updated: Date.now()}}};
  page.refresh();
  await settle();
  page.setRun(null);
  await settle();
  const report = root.querySelector('.core-checklist');
  assert.ok(report, 'the page reports the run once it ends');
  const line = (id) => words(report.querySelector(`[data-section="${id}"]`));
  assert.equal(line('envelope'), 'Zoning envelope: Produced in this run');
  assert.equal(line('property'), 'Parcel record: Kept, still current');
  for (const [id, label] of [['program', 'Unit mix'], ['proFormas', 'Pro forma'], ['publicRecords', 'Property history and public records'], ['comparisons', 'Program comparison and acquisition decision']]) assert.equal(line(id), `${label}: Not produced`);
  assert.equal(report.querySelector('[data-section=architecture]'),null);
  assert.match(words(report), /Site assembly is not part of a full underwriting: it needs the neighboring lots to combine/);
  page.leave();
});
