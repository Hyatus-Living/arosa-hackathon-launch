import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {normalizeMarketInputs} from './market.mjs';
import {createResearchServer} from './service.mjs';

const propertyA={bbl:'1000477501',address:'Prior parcel fixture'},propertyB={bbl:'3000010001',address:'New parcel fixture'};
const market=rate=>normalizeMarketInputs({submarket:'Synthetic market',rents:[{bedrooms:1,rentPerSqftPerMonth:rate,source:'User fixture',retrievedAt:'2026-10-17'}]});
const program=units=>({productType:'rental',residentialGrossSqft:10000,netResidentialSqft:8200,units,byBedrooms:[{bedrooms:1,units,unitSqft:650,netSqft:units*650}]});
const financial={name:'Prior financial fixture',costs:{totalDevelopmentCost:2000000},returns:{profit:100000},sources:[]};
function setup(t,owner='alice'){
  const dir=mkdtempSync(join(tmpdir(),'acres-publication-')),store=new ChatStore(join(dir,'chat.sqlite')),conversation=store.createConversation(owner);
  t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  const start=(message='Research',id=conversation.id)=>{const run=store.createRun(owner,id,message);store.begin(run);return run;};
  const finish=(run,output)=>store.finish(run,'completed',{answer:'Preserved research answer',sources:[],...output});
  const complete=output=>{const run=start();finish(run,output);return run;};
  const view=()=>store.projectView(owner,conversation.projectId),state=()=>store.projectState(owner,conversation.id);
  const edit=fields=>store.updateProjectState(owner,conversation.projectId,{version:view().version,fields});
  return {store,conversation,owner,start,finish,complete,view,state,edit};
}
const terminal=(manager,id)=>new Promise(resolve=>{const listen=event=>{if(['run.completed','run.failed','run.interrupted'].includes(event.event)){manager.off(id,listen);resolve(event);}};manager.on(id,listen);});

test('an older concurrent run cannot switch a newer saved parcel back to its prior subject',async t=>{
  const f=setup(t);f.complete({property:propertyA});const other=f.store.createConversation(f.owner,{projectId:f.conversation.projectId});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const manager=new RunManager(f.store,{},async input=>{if(input.message==='older'){await gate;return {answer:'Older answer',sources:[],property:input.priorState.property};}return {answer:'New answer',sources:[],property:propertyB};});
  const old=manager.enqueue(f.owner,f.conversation.id,'older'),oldDone=terminal(manager,old.id),newer=manager.enqueue(f.owner,other.id,'newer');
  await terminal(manager,newer.id);const before=f.view();release();await oldDone;
  assert.equal(f.view().bbl,propertyB.bbl);assert.equal(f.view().version,before.version);
  const result=f.store.run(f.owner,old.id).result;assert.equal(result.property.bbl,propertyA.bbl);assert.equal(result.projectUpdate.status,'not_applied');assert.ok(result.projectUpdate.skippedFields.includes('property'));
  assert.equal(f.store.conversation(f.owner,f.conversation.id).messages.at(-1).projectUpdate.status,'not_applied');
  assert.equal(manager.active.size,0);
});

test('a newer user market edit survives an older run returning its original market',t=>{
  const f=setup(t);f.complete({property:propertyA,market:market(7)});const run=f.start();
  f.edit({market:market(9)});const before=f.view();f.finish(run,{market:market(7)});
  assert.equal(f.state().market.value.rents[0].rentPerSqftPerMonth,9);assert.equal(f.state().market.provenance.tool,'user');assert.equal(f.view().version,before.version);
  assert.ok(f.store.run(f.owner,run.id).result.projectUpdate.skippedFields.includes('market'));
});

test('changed user unit mix protects both the program and its dependent financial output',t=>{
  const f=setup(t);f.complete({property:propertyA,program:program(10)});const run=f.start();
  f.edit({program:program(8)});f.finish(run,{program:program(10),proFormas:[financial]});
  assert.equal(f.state().program.value.units,8);assert.equal(f.state().proFormas,undefined);
  const result=f.store.run(f.owner,run.id).result;assert.deepEqual(new Set(result.projectUpdate.skippedFields),new Set(['program','proFormas']));assert.equal(result.proFormas[0].returns.profit,100000);
});

test('newer assumptions block old financial publication while independent nearby research can merge',t=>{
  const f=setup(t);f.complete({property:propertyA});f.edit({assumptions:{landPrice:1000000}});const run=f.start();
  f.edit({assumptions:{landPrice:1500000}});f.finish(run,{proFormas:[financial],places:[{id:'park',name:'Park',sourceId:null}]});
  assert.equal(f.state().assumptions.value.landPrice,1500000);assert.equal(f.state().proFormas,undefined);assert.equal(f.state().places.value[0].name,'Park');
  assert.equal(f.store.run(f.owner,run.id).result.projectUpdate.status,'partial');
  assert.equal(f.store.run(f.owner,run.id).result.projectUpdate.currentVersion,f.view().version);
  const next=f.start();f.edit({assumptions:{landPrice:2000000}});f.finish(next,{property:propertyA,proFormas:[financial]});
  const update=f.store.run(f.owner,next.id).result.projectUpdate;
  assert.equal(update.status,'partial');assert.ok(update.appliedFields.includes('property'));assert.ok(update.skippedFields.includes('proFormas'));assert.equal(update.currentVersion,f.view().version);
});

test('changed standing instructions prevent automatic publication from the prior instruction context',t=>{
  const f=setup(t);f.complete({property:propertyA});f.edit({instructions:{massing:'Include retail'}});const run=f.start();
  f.edit({instructions:{massing:'Omit retail'}});const before=f.view();f.finish(run,{property:propertyA,concepts:[{name:'Old massing'}]});
  assert.equal(f.state().concepts,undefined);assert.equal(f.view().version,before.version);assert.ok(f.store.run(f.owner,run.id).result.projectUpdate.changedInputs.includes('instructions'));
  f.complete({concepts:[{name:'Current massing'}]});assert.equal(f.state().concepts.value[0].name,'Current massing');
});

test('newer nearby-place facts survive while an independent new concept is published',t=>{
  const f=setup(t),oldPlace={id:'park',name:'Park',rating:3};f.complete({property:propertyA,places:[oldPlace]});const run=f.start();
  f.complete({places:[{...oldPlace,rating:5}]});f.finish(run,{places:[oldPlace],concepts:[{name:'Independent concept'}]});
  assert.equal(f.state().places.value.find(place=>place.id==='park').rating,5);assert.equal(f.state().concepts.value.at(-1).name,'Independent concept');
  assert.equal(f.store.run(f.owner,run.id).result.projectUpdate.status,'partial');
});

test('an immediate architecture update does not reject unrelated completion fields',t=>{
  const f=setup(t);f.complete({property:propertyA});const run=f.start();
  f.store.project.write(f.conversation.projectId,{architecture:{value:{planId:'agent-plan',revision:1},provenance:{tool:'acres_save_plan',run:run.id,sources:[]}}});
  f.finish(run,{concepts:[{name:'Current concept'}]});assert.equal(f.state().architecture.value.revision,1);assert.equal(f.state().concepts.value[0].name,'Current concept');
  assert.equal(f.store.run(f.owner,run.id).result.projectUpdate,undefined);
});

test('independent concept additions from concurrent runs still accumulate',t=>{
  const f=setup(t);f.complete({property:propertyA,concepts:[{name:'Base concept'}]});const run=f.start();
  f.complete({concepts:[{name:'Other concept'}]});f.finish(run,{concepts:[{name:'Independent addition'}]});
  assert.deepEqual(f.state().concepts.value.map(concept=>concept.name),['Base concept','Other concept','Independent addition']);
});

test('a newer concept entry survives an old copy while an independent incoming entry can merge',t=>{
  const f=setup(t),base={name:'Shared concept',heightFeet:60};f.complete({property:propertyA,concepts:[base]});const run=f.start();
  const newer=f.complete({concepts:[{...base,heightFeet:80}]});f.finish(run,{concepts:[base,{name:'Independent addition',heightFeet:50}]});
  assert.equal(f.state().concepts.value.find(concept=>concept.name==='Shared concept').heightFeet,80);
  assert.ok(f.state().concepts.value.some(concept=>concept.name==='Independent addition'));
  assert.equal(f.state().concepts.provenance.lineage.find(entry=>entry.name==='Shared concept').run,newer.id);
  assert.equal(f.store.run(f.owner,run.id).result.projectUpdate.status,'partial');
});

test('an identical late value cannot replace newer provenance for the same fact',t=>{
  const f=setup(t);f.complete({property:propertyA});const run=f.start();
  const fresh=f.complete({property:propertyA,sources:[{id:1,kind:'property',title:'New source',url:'https://example.com/new',text:JSON.stringify(propertyA),fetchedAt:'2026-10-17T12:00:00Z'}]});
  f.finish(run,{property:propertyA,concepts:[{name:'New concept'}]});
  assert.equal(f.state().property.provenance.run,fresh.id);assert.equal(f.state().property.provenance.sources[0].title,'New source');assert.equal(f.state().concepts.value[0].name,'New concept');
});

test('a run with unchanged context can still intentionally select a new subject and publish its work',t=>{
  const f=setup(t);f.complete({property:propertyA});const run=f.start();f.finish(run,{property:propertyB,concepts:[{name:'New subject concept',context:{bbl:propertyB.bbl}}]});
  assert.equal(f.view().bbl,propertyB.bbl);assert.equal(f.state().concepts.value[0].name,'New subject concept');assert.equal(f.state().concepts.stale,null);assert.equal(f.store.run(f.owner,run.id).result.projectUpdate,undefined);
});

test('research uses its captured start context even when account setup yields before execution',async t=>{
  const f=setup(t);f.complete({property:propertyA});let release,observed;const gate=new Promise(resolve=>{release=resolve;});
  const manager=new RunManager(f.store,{},async input=>{observed=input.priorState.property.bbl;return {answer:'Snapshot answer',property:input.priorState.property,sources:[]};},null,{forAccount:async()=>{await gate;return null;}});
  const run=manager.enqueue(f.owner,f.conversation.id,'Delayed setup'),done=terminal(manager,run.id);
  f.complete({property:propertyB});release();await done;
  assert.equal(observed,propertyA.bbl);assert.equal(f.view().bbl,propertyB.bbl);assert.equal(f.store.run(f.owner,run.id).result.projectUpdate.status,'not_applied');assert.equal(manager.active.size,0);
});

test('executor mutations cannot change the baseline used to reconcile publication',async t=>{
  const f=setup(t);f.complete({property:propertyA});let release;const gate=new Promise(resolve=>{release=resolve;});
  const manager=new RunManager(f.store,{},async input=>{input.priorState.property.address='Executor mutation';await gate;return {answer:'Answer',sources:[]};});
  const run=manager.enqueue(f.owner,f.conversation.id,'Mutation'),done=terminal(manager,run.id);
  const captured=manager.active.get(run.id).run.projectSnapshot?.fields?.property?.value?.address;release();await done;
  assert.equal(captured,propertyA.address);assert.equal(manager.active.size,0);
});

test('actual HTTP/SSE and reloaded conversation preserve the newer subject and the skipped-update notice',{timeout:5000},async t=>{
  const owner='a'.repeat(24),f=setup(t,owner),other=f.store.createConversation(owner,{projectId:f.conversation.projectId});f.complete({property:propertyA});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'fixture'},store:f.store,maps:null,execute:async input=>{if(input.message==='older'){await gate;return {answer:'Prior parcel answer',property:input.priorState.property,sources:[]};}return {answer:'New parcel answer',property:propertyB,sources:[]};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer fixture','x-acres-account':owner,'content-type':'application/json'};
  const request=async path=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200);return response.json();};
  const post=async(id,message)=>{const response=await fetch(`${base}/conversations/${id}/runs`,{method:'POST',headers,body:JSON.stringify({message})});assert.equal(response.status,202);return response.json();};
  const older=await post(f.conversation.id,'older'),newer=await post(other.id,'newer');
  await(await fetch(`${base}/runs/${newer.id}/events`,{headers})).text();const before=await request(`/projects/${f.conversation.projectId}/state`);
  const stream=await fetch(`${base}/runs/${older.id}/events`,{headers}),events=stream.text();release();const body=await events;
  const current=await request(`/projects/${f.conversation.projectId}/state`),conversation=await request(`/conversations/${f.conversation.id}`),run=await request(`/runs/${older.id}`);
  assert.equal(current.bbl,propertyB.bbl);assert.equal(current.version,before.version);assert.match(body,/"status":"not_applied"/);
  assert.equal(conversation.messages.at(-1).text,'Prior parcel answer');assert.equal(conversation.messages.at(-1).projectUpdate.status,'not_applied');assert.equal(run.result.projectUpdate.status,'not_applied');assert.equal(run.projectSnapshot,undefined);
});
