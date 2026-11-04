// End to end, without live credentials or a deploy: open a decided site, choose
// "Draft it with Arosa", submit that intake to the real plan tool on a real local
// research server, see the revision, its artifacts and its walkthrough job, load
// the plan back through the editor's own transport, and draw a plan by hand in
// the real editor on a second site. Only the existing provider boundaries are
// faked, as in architecture.test.mjs: the geometry lane (buildPlan), the Blender
// worker executable, and the agent model itself (the execute stub hands back the
// run's real plan access; the tool call the intake message asks for is real).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {parseHTML} from 'linkedom';
import {ChatStore} from '../../acres-research/store.mjs';
import {createResearchServer} from '../../acres-research/service.mjs';
import {createArchitectureTools} from '../../acres-research/architecture-tools.mjs';
import {followUpMessage, architectureView} from '../public/core-model.js';
import {loadPlan, validatePlan} from '../public/plan-intake.js';
import {fullState} from './fixtures/project-state.mjs';
import {mountEditor, multiLevelPlan} from './fixtures/plan-editor.mjs';

const alice = 'a'.repeat(24);
const realFetch = globalThis.fetch;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const MIX = [{name: 'studio', share: 0.2, targetSqft: 450}, {name: '1 bedroom', share: 0.5, targetSqft: 650}, {name: '2 bedroom', share: 0.3, targetSqft: 950}];

// The geometry lane stand-in and fake Blender worker, as in architecture.test.mjs.
const buildPlan = async (doc, {outDir}) => {
  const ifc = `ISO-10303-21;\n/* ${doc.id} r${doc.revision} */\nEND-ISO-10303-21;\n`;
  writeFileSync(join(outDir, 'model.ifc'), ifc);
  writeFileSync(join(outDir, 'plan.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><title>r${doc.revision}</title></svg>`);
  writeFileSync(join(outDir, 'pascal-scene.json'), JSON.stringify({revision: doc.revision}));
  writeFileSync(join(outDir, 'idmap.json'), JSON.stringify({walls: {}}));
  return {hasIfc: true, ifcSha256: sha(ifc)};
};
const WORKER = `#!/usr/bin/env node
const {readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const dir=process.argv[process.argv.indexOf('--job')+1];
const job=JSON.parse(readFileSync(join(dir,'job.json'),'utf8'));
const out=join(dir,'output');
const ifc=readFileSync(join(dir,'input','model.ifc'),'utf8');
writeFileSync(join(out,'model.blend'),'BLENDER'+ifc);
writeFileSync(join(out,'preview.png'),Buffer.from([0x89,0x50,0x4e,0x47]));
writeFileSync(join(out,'model.glb'),'glTF'+ifc);
writeFileSync(join(out,'manifest.json'),JSON.stringify({rooms:{}}));
const hashes=Object.fromEntries([['blend','BLENDER'+ifc],['preview',Buffer.from([0x89,0x50,0x4e,0x47])],['glb','glTF'+ifc],['manifest',JSON.stringify({rooms:{}})]].map(([kind,bytes])=>[kind+'Sha256',createHash('sha256').update(bytes).digest('hex')]));
writeFileSync(join(out,'verification.json'),JSON.stringify({status:'succeeded',hashes,jobId:job.jobId,revision:job.revision}));
`;

async function until(read, done, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error('Timed out waiting: ' + JSON.stringify(value)?.slice(0, 400)); await sleep(50); }
}

// A decided site: the underwriting fields the fixture carries, written to the real
// project state so GET /state and the site page see a site that can be drafted.
// bbl names another lot: one owner's sites for the same lot converge on one project.
function seedDecided(store, projectId, bbl = null) {
  const fields = {};
  for (const key of ['property', 'envelope', 'concepts', 'program', 'market', 'proFormas', 'entitlements', 'comparisons', 'assumptions'])
    fields[key] = {value: fullState.fields[key].value, provenance: fullState.fields[key].provenance};
  if (bbl) fields.property = {...fields.property, value: {...fields.property.value, bbl}};
  store.project.write(projectId, fields, Date.now());
}

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-draft-e2e-'));
  const worker = join(dir, 'fake-worker.js'); writeFileSync(worker, WORKER); chmodSync(worker, 0o755);
  const store = new ChatStore(join(dir, 'chat.sqlite'));
  store.touchPerson(alice, 'alice@example.com');
  let seen = null;
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store,
    execute: async (input) => { seen = input.architecture; return {answer: 'x', sources: [], ui: []}; },
    architecture: {stateDir: join(dir, 'state'), buildPlan, worker, pipelineVersion: 'test-1', emails: 'alice@example.com'}});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (path, method = 'GET', body) => realFetch(base + path, {method, headers: {authorization: 'Bearer test', 'x-acres-account': alice, 'content-type': 'application/json'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  // The web app's /api prefix, mapped onto the research service with the account attached.
  const webFetch = (url, options = {}) => realFetch(base + String(url).replace(/^\/api/, ''), {...options, headers: {authorization: 'Bearer test', 'x-acres-account': alice, ...(options.headers || {})}});
  t.after(async () => { server.architectureJobs?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close(); rmSync(dir, {recursive: true, force: true}); });
  // One project with its run's real plan access captured, as the agent receives it.
  async function project(bbl = null) {
    const model=await (await api('/projects','POST',{workflow:'modeling',address:bbl?`Address for ${bbl}`:'1234 Fulton Street'})).json();
    const conversation = await (await api('/conversations', 'POST', {projectId:model.id})).json();
    const run = await (await api(`/conversations/${conversation.id}/runs`, 'POST', {message: followUpMessage({field: 'architecture', action: 'typical'})})).json();
    await until(() => api(`/runs/${run.id}`).then((r) => r.json()), (r) => ['completed', 'failed'].includes(r.status));
    assert.ok(seen, 'the run received plan access for its project');
    return {projectId: conversation.projectId, plans: seen};
  }
  return {store, api, webFetch, project};
}

test('Draft it with Arosa: intake message, real save, artifacts and a finished walkthrough job', {timeout: 30000}, async (t) => {
  const {api, webFetch, project} = await setup(t);
  const {projectId, plans} = await project();
  const empty = await (await api(`/projects/${projectId}/architecture`)).json();
  assert.equal(empty.current, null, 'the site opens with no floor plan');
  assert.match(followUpMessage({field: 'architecture', action: 'typical'}), /^Draft a typical residential floor plan from the dimensions and design brief/);

  const tools = createArchitectureTools({plans});
  const saved = await tools.handlers.acres_save_plan({parentRevision: 0, typicalFloor: {width: 100, depth: 60, mix: MIX}});
  assert.equal(saved.saved, true);
  assert.equal(saved.revision, 1);
  assert.ok(saved.unitsPerFloor >= 6, `units per floor ${saved.unitsPerFloor}`);
  assert.equal(saved.walkthrough.status, 'queued', 'saving queues the walkthrough, never reports it ready');

  const summary = await until(() => api(`/projects/${projectId}/architecture`).then((r) => r.json()), (s) => s.current?.jobs.at(-1)?.status === 'succeeded');
  const view = architectureView(projectId, summary);
  assert.equal(view.kind, 'plan');
  assert.equal(view.unitsPerFloor, saved.unitsPerFloor);
  assert.ok(view.viewer, 'a succeeded job makes the walkthrough openable');
  assert.ok(view.preview, 'and its preview still shows on the card');
  assert.deepEqual(view.downloads.map((d) => d.kind), ['preview', 'glb', 'blend', 'ifc', 'svg', 'pascal-scene']);
  for (const download of view.downloads) {
    const file = await webFetch(download.url);
    assert.equal(file.status, 200, download.kind);
    assert.ok((await file.arrayBuffer()).byteLength > 0, download.kind);
  }
  // The editor's own load reads the drafted plan back, valid and at revision 1.
  const loaded = await loadPlan({fetch: webFetch, projectId});
  assert.equal(loaded.revision, 1);
  assert.ok(loaded.rooms.some((r) => r.name.startsWith('Unit ')));
  assert.deepEqual(validatePlan(loaded).filter((i) => i.severity === 'error'), []);
  // Drafting again keeps the plan that is there.
  const again = await tools.handlers.acres_save_plan({parentRevision: 0, typicalFloor: {width: 100, depth: 60, mix: MIX}});
  assert.deepEqual({saved: again.saved, conflict: again.conflict}, {saved: false, conflict: true});
});

test('Modeling opens directly, saves a plan and refreshes its walkthrough without underwriting', {timeout:30000},async t=>{
  const {webFetch,project,store}=await setup(t);const model=await project();
  const {document,window}=parseHTML('<html><body><main id="core-page"></main></body></html>');
  globalThis.document=document;globalThis.window=window;
  Object.defineProperty(window,'location',{value:new URL('http://localhost/modeling/'+model.projectId),writable:true,configurable:true});
  window.history={state:null,pushState(){}};
  globalThis.localStorage={getItem:()=>null,setItem(){}};
  const sources=[];globalThis.EventSource=class{constructor(){sources.push(this);}addEventListener(){}close(){}};
  globalThis.fetch=webFetch;t.after(()=>globalThis.fetch=realFetch);
  const mounted=[];window.acresPlanEditor={unmount(){}};
  const {createCorePage}=await import('../public/core.js');const root=document.querySelector('main');
  const page=createCorePage({root,navigate(){},underwrite(){throw new Error('No underwriting');},pendingBox:()=>document.createElement('div'),conversationId:()=>null,canSend:()=>true,architectureEnabled:()=>true,mountPlan:async(node,props)=>mounted.push(props),mountArchitecture:async()=>{},mountConcept:async()=>{}});
  t.after(()=>page.leave());page.showPlan(model.projectId);
  await until(()=>root.querySelector('h1')?.textContent,title=>title==='1234 Fulton Street');
  assert.equal(mounted[0].projectId,model.projectId);
  assert.equal(root.querySelector('.uw-steps'),null);
  assert.equal(root.querySelector('[data-plan-draft]'),null);
  const tools=createArchitectureTools({plans:model.plans});
  const saved=await tools.handlers.acres_save_plan({parentRevision:0,typicalFloor:{width:100,depth:60,mix:MIX}});
  assert.equal(saved.saved,true);
  sources.at(-1).onmessage({data:JSON.stringify({event:'state.updated',projectId:model.projectId,keys:['architecture']})});
  await until(()=>root.querySelector('.core-plan-walkthrough')?.textContent,text=>text?.includes('Revision 1'));
  for(const field of ['program','market','proFormas','comparisons'])assert.equal(store.projectView(alice,model.projectId).fields[field].value,null,field);
});
