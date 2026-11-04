// The architect's package through the real Python boundary: a drafted scheme plan saved as a revision
// registers the drawing set, DXF, schedules, self-check and zip beside its IFC and zoning sheet; the
// option names them on its plan part and an option link sends them. An edit keeps the layout checks it was
// drafted with, marked edited. The Python half is skipped where the planning venv is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildArchitectureRevision, planningCommand} from './planning.mjs';
import {schemePlan} from './architecture-tools.mjs';
import {exportPlan} from './plan-intake.mjs';
import {schemeOutlines} from './scheme-outlines.mjs';
import {Architecture, PACKAGE_KINDS, REVISION_FILES} from './architecture-artifacts.mjs';
import {ChatStore} from './store.mjs';
import {optionSnapshot, optionFiles} from './schemes.mjs';

const skip = existsSync(planningCommand().python) ? false : 'planning/.venv is not installed';
const program = {key: 'standard', zfa: 20000, storeys: 6, units: 24, unitMix: [{type: 'oneBedroom', netSqft: 650, units: 16}, {type: 'twoBedroom', netSqft: 950, units: 8}]};
const scheme = {id: 'as_of_right', label: 'As of right', summary: 'Rental', program};
const view = row => row;

function project(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acres-package-'));
  const store = new ChatStore(path.join(dir, 'chat.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const projectId = store.createConversation('a'.repeat(24)).projectId;
  store.project.write(projectId, {schemes: {value: {schemes: [scheme], basis: null}, provenance: {tool: 'schemes', sources: []}}});
  return {dir, store, projectId};
}

test('a drafted plan saves the architect\'s package and an option link sends it', {skip, timeout: 120000}, async t => {
  const {dir, store, projectId} = project(t);
  const property = {bbl: '3012340001', address: '10 EXAMPLE STREET', zonedist1: 'R7A', lotfront: '50', lotdepth: '100'};
  const site = schemeOutlines(scheme, {property, lot: {exterior: [[0, 0], [50, 0], [50, 100], [0, 100]], holes: [], source: 'tax-lot', note: 'Lot lines come from the city\'s tax map, not a survey.'}});
  const {doc, report} = await schemePlan(scheme, {frontFeet: 50, depthFeet: 100}, undefined, {site});
  const architecture = new Architecture(store, {stateDir: path.join(dir, 'state'), buildPlan: buildArchitectureRevision});
  const saved = await architecture.save('a'.repeat(24), projectId, {parentRevision: null, plan: {...exportPlan(doc), zoning: site, layout: {checks: report.checks, architect: report.why.architect}}, scheme: scheme.id, by: 'agent'}, view);
  const kinds = architecture.artifacts(projectId, saved.planId, saved.revision).map(a => a.kind);
  assert.deepEqual(kinds.sort(), REVISION_FILES.map(([, kind]) => kind).sort(), 'every revision file is registered');
  const part = store.project.read(projectId).schemes.value.schemes[0].plan;
  assert.deepEqual(Object.keys(part.files).sort(), [...PACKAGE_KINDS].sort());
  const rows = Object.fromEntries(PACKAGE_KINDS.map(kind => [kind, architecture.artifactRow(projectId, part.files[kind])]));
  assert.equal(rows.package.content_type, 'application/zip');
  assert.equal(readFileSync(rows['drawings-pdf'].path).subarray(0, 8).toString(), '%PDF-1.4');
  const check = JSON.parse(readFileSync(path.join(path.dirname(rows.package.path), 'selfcheck.json'), 'utf8'));
  assert.ok(check.passes.some(c => /NYC BC|MDL|ZR/.test(c.cite ?? '')), 'the layout checks reach the self-check');
  const option = optionSnapshot({scheme: store.project.read(projectId).schemes.value.schemes[0], basis: null, site: {address: '10 Example Street'}, sender: {name: 'A'}, at: 1});
  assert.deepEqual(optionFiles(option).sort(), [part.svg, ...Object.values(part.files)].sort());
});

test('an edit keeps the zoning and the drafted layout checks, marked edited', async t => {
  const {dir, store, projectId} = project(t);
  const built = [];
  const buildPlan = async (document, {outDir}) => { built.push(document); writeFileSync(path.join(outDir, 'model.ifc'), 'ISO-10303-21;\nEND-ISO-10303-21;\n'); return {hasIfc: true}; };
  const architecture = new Architecture(store, {stateDir: path.join(dir, 'state'), buildPlan});
  const plan = {schema: 'acres.architecture.plan/1', name: 'Typical floor', units: 'm', levels: [{id: 'level-1', elevation: 0, height: 3}],
    walls: [{id: 'wall', levelId: 'level-1', start: [0, 0], end: [10, 0], thickness: 0.2, height: 3}], rooms: [], openings: [], objects: [], sources: []};
  const layout = {checks: [{rule: 'exits', text: 'Two exits', value: '2', pass: true, cite: 'NYC BC 2022 1006.3.2', basis: 'law'}], architect: []};
  await architecture.save('a'.repeat(24), projectId, {parentRevision: null, plan: {...plan, zoning: {district: 'R7A'}, layout}, scheme: scheme.id}, view);
  await architecture.save('a'.repeat(24), projectId, {parentRevision: 1, plan, scheme: scheme.id}, view);
  assert.deepEqual(built[1].zoning, {district: 'R7A'});
  assert.deepEqual(built[1].layout, {...layout, edited: true});
  await architecture.save('a'.repeat(24), projectId, {parentRevision: 2, plan, scheme: scheme.id}, view);
  assert.equal(built[2].layout.edited, true);
});
