import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {buildArchitectureRevision, planningCommand} from './planning.mjs';

const owner = 'a'.repeat(24), editor = 'b'.repeat(24);
// The native builder test runs the real planning venv, exactly as the research service does.
const native = {skip: existsSync(planningCommand().python) ? false : 'planning/.venv is not installed'};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plan = {schema: 'acres.architecture.plan/1', name: 'Controlled access plan', units: 'm', levels: [{id: 'L1', name: 'Ground', elevation: 0, height: 2.8}], walls: [{id: 'wall', levelId: 'L1', start: [0, 0], end: [4, 0], thickness: .2, height: 2.8, material: 'generic', roomIds: []}], openings: [], rooms: [], objects: [], sources: []};
const tables = ['projects', 'project_fields', 'project_events', 'architecture_plans', 'architecture_artifacts', 'architecture_jobs'];
const state = store => Object.fromEntries(tables.map(name => [name, store.query(`SELECT * FROM ${name} ORDER BY rowid`)]));
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
async function controlledBuild(document, {outDir}) {
  const ifc = `ISO-10303-21;\n/* ${document.id} revision ${document.revision} */\nEND-ISO-10303-21;\n`;
  writeFileSync(join(outDir, 'model.ifc'), ifc);
  return {hasIfc: true, ifcSha256: sha(ifc)};
}

async function setup(t, builder = controlledBuild) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-plan-save-access-')), stateDir = join(dir, 'state'), store = new ChatStore(join(dir, 'chat.sqlite'));
  const conversation = store.createConversation(owner), projectId = conversation.projectId, gates = [];
  let nextGate = null;
  const buildPlan = async (document, options) => {
    const gate = nextGate;nextGate = null;
    let result;
    try {result = await builder(document, options);}
    catch (error) {gate?.failed(error);throw error;}
    if (gate) {gate.document = document;gate.outDir = options.outDir;gate.enter();await gate.wait;}
    return result;
  };
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'controlled-plan-access'}, store, maps: null, execute: async () => ({}), architecture: {stateDir, buildPlan, worker: null, pipelineVersion: 'controlled-access'}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = async (path, account = owner, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {method, headers: {authorization: 'Bearer controlled-plan-access', 'x-acres-account': account, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(30000)});
    return {status: response.status, body: await response.json()};
  };
  const route = `/projects/${projectId}/architecture`, save = (account, parentRevision, name = plan.name) => api(route + '/plan', account, 'PUT', {parentRevision, plan: {...plan, name}});
  const hold = (account, parentRevision) => {
    const gate = {};
    gate.entered = new Promise((resolve, reject) => {gate.enter = resolve;gate.failed = reject;});
    gate.wait = new Promise(resolve => {gate.release = resolve;});
    nextGate = gate;gates.push(gate);gate.result = save(account, parentRevision, 'Pending contributor edit');return gate;
  };
  t.after(async () => {for (const gate of gates) gate.release();await Promise.allSettled(gates.map(gate => gate.result));server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();rmSync(dir, {recursive: true});});
  const grant = role => store.grantMember(owner, conversation.id, 'account', editor, role);
  const noStaging = () => assert.ok(!files(join(stateDir, 'architecture')).some(path => path.includes('.staging-')), 'The denied build must leave no staged files');
  return {store, dir, stateDir, conversation, projectId, route, api, save, hold, grant, noStaging};
}

test('a saved underwriting plan remains accessible from its separate library entry', async t => {
  const f = await setup(t), saved = await f.save(owner, null);
  assert.equal(saved.status, 201);
  const before = (await f.api(f.route)).body.current;
  const models = await f.api('/projects?modelsOnly=true');
  const legacy = await f.api('/projects?legacyModelsOnly=true');
  assert.ok(!models.body.projects.some(project => project.id === f.projectId));
  assert.ok(legacy.body.projects.some(project => project.id === f.projectId));
  assert.deepEqual((await f.api(f.route)).body.current, before);
  assert.equal((await f.api(f.route, editor)).status, 404);
});

test('a contributor downgraded through the API during a plan build cannot publish or replace the saved revision', async t => {
  const f = await setup(t), initial = await f.save(owner, null);assert.equal(initial.status, 201);f.grant('participant');
  const ifc = f.store.one("SELECT path FROM architecture_artifacts WHERE project=? AND kind='ifc'", f.projectId), beforeFile = sha(readFileSync(ifc.path));
  const pending = f.hold(editor, 1);await pending.entered;
  const changed = await f.api(`/conversations/${f.conversation.id}/members/account/${editor}`, owner, 'PATCH', {role: 'viewer'});assert.equal(changed.status, 200);
  const before = state(f.store);pending.release();const denied = await pending.result;
  assert.equal(denied.status, 403);assert.deepEqual(state(f.store), before);assert.equal(sha(readFileSync(ifc.path)), beforeFile);
  assert.equal((await f.api(f.route, editor)).body.current.revision, 1);assert.equal(existsSync(join(f.stateDir, 'architecture', 'plans', pending.document.id, '2')), false);f.noStaging();
});

test('a removed contributor cannot publish a first plan and receives no revision metadata', async t => {
  const f = await setup(t);f.grant('participant');const pending = f.hold(editor, null);await pending.entered;
  f.store.removeGrant(owner, f.conversation.id, 'account', editor);const before = state(f.store);pending.release();const denied = await pending.result;
  assert.equal(denied.status, 404);assert.equal(denied.body.revision, undefined);assert.deepEqual(state(f.store), before);
  assert.equal((await f.api(f.route)).body.current, null);assert.equal(files(join(f.stateDir, 'architecture', 'plans')).length, 0);f.noStaging();
});

test('team membership removal and team archival revoke pending plan publication', async t => {
  for (const mode of ['membership', 'archive']) {
    const f = await setup(t), team = f.store.createTeam(owner, 'Controlled editors');f.store.addTeamMember(owner, team.id, editor);
    f.store.grantMember(owner, f.conversation.id, 'team', team.id, 'participant');
    const pending = f.hold(editor, null);await pending.entered;
    if (mode === 'membership') f.store.removeTeamMember(owner, team.id, editor);else f.store.archiveTeam(owner, team.id);
    const before = state(f.store);pending.release();const denied = await pending.result;
    assert.equal(denied.status, 404, mode);assert.deepEqual(state(f.store), before);assert.equal(files(join(f.stateDir, 'architecture', 'plans')).length, 0);f.noStaging();
  }
});

test('a remaining participant grant or restored authority still permits the completed plan save', async t => {
  for (const mode of ['remaining-team', 'restored']) {
    const f = await setup(t);f.grant('participant');
    if (mode === 'remaining-team') {const team = f.store.createTeam(owner, 'Alternate editors');f.store.addTeamMember(owner, team.id, editor);f.store.grantMember(owner, f.conversation.id, 'team', team.id, 'participant');}
    const pending = f.hold(editor, null);await pending.entered;f.store.removeGrant(owner, f.conversation.id, 'account', editor);
    if (mode === 'restored') f.grant('participant');
    pending.release();const saved = await pending.result;assert.equal(saved.status, 201, mode);assert.equal(saved.body.revision, 1);
    assert.equal((await f.api(f.route, editor)).body.current.plan.name, 'Pending contributor edit');f.noStaging();
  }
});

test('lost access hides conflict metadata from a newer owner revision', async t => {
  const f = await setup(t);assert.equal((await f.save(owner, null)).status, 201);f.grant('participant');
  const pending = f.hold(editor, 1);await pending.entered;assert.equal((await f.save(owner, 1, 'Newer owner plan')).status, 201);
  f.store.removeGrant(owner, f.conversation.id, 'account', editor);const before = state(f.store);pending.release();const denied = await pending.result;
  assert.equal(denied.status, 404);assert.equal(denied.body.revision, undefined);assert.deepEqual(state(f.store), before);
  assert.equal((await f.api(f.route)).body.current.plan.name, 'Newer owner plan');f.noStaging();
});

test('the actual native planning builder output is discarded when its contributor loses write access', {timeout: 40000, ...native}, async t => {
  const f = await setup(t, buildArchitectureRevision);f.grant('participant');const pending = f.hold(editor, null);await pending.entered;
  assert.ok(readFileSync(join(pending.outDir, 'model.ifc')).length > 100);f.store.setGrantRole(owner, f.conversation.id, 'account', editor, 'viewer');
  const before = state(f.store);pending.release();const denied = await pending.result;
  assert.equal(denied.status, 403);assert.deepEqual(state(f.store), before);assert.equal(files(join(f.stateDir, 'architecture', 'plans')).length, 0);f.noStaging();
});
