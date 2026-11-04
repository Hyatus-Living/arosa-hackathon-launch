import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {fullState} from '../app-starter/tests/fixtures/project-state.mjs';
import {shouldRefetch} from '../app-starter/public/core-model.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-project-refresh-')),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  const owner='a'.repeat(24),conversation=store.createConversation(owner),project=conversation.projectId;
  store.project.write(project,fullState.fields,1000);
  const view=()=>store.projectView(owner,project);
  const stale=()=>store.project.write(project,{property:{value:{...fullState.fields.property.value,address:'1234 Fulton St'},provenance:{tool:'acres_set_subject',run:'address-correction',sources:[]}}},2000);
  const recheck=()=>{const run=store.createRun(owner,conversation.id,'Recheck this envelope');store.begin(run);store.finish(run,'completed',{answer:'Rechecked the same envelope.',sources:[],envelope:fullState.fields.envelope.value});return run;};
  return {store,owner,conversation,project,view,stale,recheck};
}

test('an unchanged envelope recheck publishes its cleared stale marker and new provenance',t=>{
  const f=fixture(t);f.stale();const before=f.view(),notifications=[];
  assert.equal(before.fields.envelope.stale,'property');
  f.store.projectFeed.on(f.project,event=>notifications.push(event));
  const run=f.recheck(),after=f.view();
  assert.deepEqual(after.fields.envelope.value,before.fields.envelope.value);
  assert.equal(after.fields.envelope.stale,null);assert.equal(after.fields.envelope.provenance.run,run.id);
  assert.equal(after.version,before.version+1);assert.equal(notifications.length,1);
  assert.deepEqual(notifications[0].keys,['envelope']);assert.equal(notifications[0].version,after.version);
  assert.equal(shouldRefetch(notifications[0],before),true);
  assert.equal(f.store.projectEvents(f.project).at(-1).run,run.id);
  assert.ok(f.store.events(f.owner,run.id).some(event=>event.event==='state.updated'));
  assert.equal(after.fields.concepts.stale,before.fields.concepts.stale,'Other stale findings stay stale');
});

test('direct and derived provenance-only refreshes advance the revision without invalidating calculations',t=>{
  for(const derived of [false,true]) {
    const f=fixture(t),before=f.view(),envelope=before.fields.envelope;
    const fields={envelope:{value:envelope.value,provenance:{...envelope.provenance,run:'fresh-evidence',sources:[{title:'New evidence fixture',url:'https://example.com/synthetic-evidence',kind:'fixture',retrievedAt:'2026-10-17T12:00:00Z'}]}}};
    const keys=derived?f.store.project.write(f.project,{},2000,()=>fields):f.store.project.write(f.project,fields,2000);
    const after=f.view();
    assert.deepEqual(keys,['envelope']);assert.equal(after.version,before.version+1);
    assert.equal(after.fields.envelope.updated,2000);assert.equal(after.fields.envelope.provenance.run,'fresh-evidence');
    assert.equal(after.fields.concepts.stale,null,'Unchanged envelope values do not stale the concepts');
    assert.equal(after.fields.proFormas.stale,null,'Unchanged envelope values do not stale the pro forma');
  }
});

test('direct and derived writes with only incidental run/time changes preserve prior metadata and versions',t=>{
  for(const derived of [false,true]) {
    const f=fixture(t),before=f.view(),envelope=before.fields.envelope;
    const provenance={...Object.fromEntries(Object.entries(envelope.provenance).reverse()),run:'same-evidence-new-run',at:'2026-10-17T12:00:00Z'};
    const fields={envelope:{value:envelope.value,provenance}};
    const keys=derived?f.store.project.write(f.project,{},2000,()=>fields):f.store.project.write(f.project,fields,2000);
    const after=f.view();
    assert.deepEqual(keys,[]);assert.equal(after.version,before.version);
    assert.deepEqual(after.fields.envelope,before.fields.envelope);
    assert.equal(after.updated,before.updated);
  }
});

test('authenticated HTTP freshness updates change ETags, reach live SSE and reject stale edit versions',{timeout:5000},async t=>{
  const f=fixture(t);f.stale();
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store:f.store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/projects/${f.project}`;
  const headers={authorization:'Bearer test','x-acres-account':f.owner,'content-type':'application/json'};
  let reader;
  try {
    const original=await fetch(base+'/state',{headers}),before=await original.json();
    const stream=await fetch(base+'/events',{headers,signal:AbortSignal.timeout(3000)});reader=stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value),/connected/);
    f.recheck();
    const response=await fetch(base+'/state',{headers}),after=await response.json();
    assert.equal(response.status,200);assert.notEqual(response.headers.get('etag'),original.headers.get('etag'));
    assert.equal(after.version,before.version+1);assert.equal(after.fields.envelope.stale,null);
    const wire=new TextDecoder().decode((await reader.read()).value);
    const event=JSON.parse(wire.split('\n').find(line=>line.startsWith('data: ')).slice(6));
    assert.equal(event.event,'state.updated');assert.equal(shouldRefetch(event,before),true);
    const edit=await fetch(base+'/state',{method:'PATCH',headers,body:JSON.stringify({version:before.version,fields:{instructions:'Old editor snapshot'}})});
    assert.equal(edit.status,409);assert.equal((await edit.json()).version,after.version);
    assert.deepEqual(f.view().fields.instructions,before.fields.instructions);
  } finally {await reader?.cancel();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
