import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {research} from './research.mjs';
import {installOfflinePublicWeb} from './testing/public-web.mjs';
import {dependents,describe} from './project-state.mjs';
import {sensitivity} from './proforma.mjs';

function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-project-'));const path=join(dir,'chat.sqlite');const store=new ChatStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,path};}
const pluto=(bbl,at='2026-10-13T10:00:00.000Z')=>({id:1,title:'NYC Planning PLUTO parcel records',url:'https://data.cityofnewyork.us/resource/64uk-42ks.json?bbl='+bbl,text:JSON.stringify([{bbl}]),kind:'property',fetchedAt:at});
const result=({bbl,concepts,places})=>({answer:'Answer [1]',property:bbl?{bbl,address:'ADDRESS '+bbl}:null,
  sources:[pluto(bbl||'0'),{id:2,title:'NYC building footprints',url:'https://data.cityofnewyork.us/footprints',text:'{}',kind:'context',fetchedAt:'2026-10-13T10:01:00.000Z'},{id:3,title:'Google Places near the property',url:'https://maps.google.com/x',text:'{}',kind:'places',fetchedAt:'2026-10-13T10:02:00.000Z'}],
  concepts:(concepts||[]).map(name=>({id:name,name,context:{sourceId:2}})),places:(places||[]).map(name=>({id:name,name,sourceId:3}))});
function complete(store,owner,conversation,input,output){const run=store.createRun(owner,conversation,input);store.begin(run);store.finish(run,'completed',output);return run;}

test('the graph lists every field derived from the property',()=>{
  assert.deepEqual(dependents(['property']).sort(),['concepts','envelope','market','places','proFormas','program']);
  assert.deepEqual(dependents(['concepts']).sort(),['proFormas','program']);
  assert.deepEqual(dependents(['envelope']).sort(),['concepts','proFormas','program']);
});

test('a finished run writes property, places and concepts with source and retrieval date',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const run=complete(store,'alice',c.id,'Model 120 Broadway',result({bbl:'1000477501',concepts:['As of right'],places:['Fulton St']}));
  const state=store.projectState('alice',c.id);
  assert.equal(state.property.value.bbl,'1000477501');
  assert.deepEqual(state.property.provenance,{tool:'acres_set_subject',run:run.id,sources:[{title:'NYC Planning PLUTO parcel records',url:'https://data.cityofnewyork.us/resource/64uk-42ks.json?bbl=1000477501',kind:'property',retrievedAt:'2026-10-13T10:00:00.000Z'}]});
  assert.equal(state.places.provenance.sources[0].retrievedAt,'2026-10-13T10:02:00.000Z');
  assert.equal(state.concepts.provenance.sources[0].title,'NYC building footprints');
  assert.equal(state.concepts.provenance.tool,'acres_model_concept');
  assert.ok(Object.values(state).every(f=>f.stale===null));
  assert.equal(store.conversation('alice',c.id).property.bbl,'1000477501');
  assert.equal(store.conversation('alice',c.id).messages.at(-1).concepts[0].name,'As of right');
  assert.equal(store.projectState('bob',c.id),null);
  store.grantMember('alice',c.id,'account','bob','viewer','bob@witharosa.ai');
  assert.equal(store.projectState('bob',c.id).property.value.bbl,'1000477501');
});

test('a run whose written answer fails citation validation still saves what its tools produced',async t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const {answer:_answer,...partialResult}=result({bbl:'1000477501',concepts:['As of right']});
  const manager=new RunManager(store,{},async()=>{throw Object.assign(new Error('The answer cited a source that does not support the claim. Please retry.'),{partialResult});});
  const run=manager.enqueue('alice',c.id,'Underwrite 120 Broadway');
  await new Promise(resolve=>{const check=()=>store.run('alice',run.id).status==='failed'?resolve():setTimeout(check,5);check();});
  const state=store.projectState('alice',c.id);
  assert.equal(state.property.value.bbl,'1000477501');
  assert.equal(state.concepts.provenance.run,run.id);
  assert.equal(store.run('alice',run.id).error,'The answer cited a source that does not support the claim. Please retry. The results this run calculated were saved to the site.');
  const message=store.conversation('alice',c.id).messages.at(-1);
  assert.equal(message.error,true);assert.equal(message.retryText,'Underwrite 120 Broadway');
  assert.deepEqual(message.savedFields.sort(),['concepts','property']);
  // Any other failure keeps saving nothing.
  const other=new RunManager(store,{},async()=>{throw new Error('The harness returned no answer.');});
  const failed=other.enqueue('alice',c.id,'Underwrite again');
  await new Promise(resolve=>{const check=()=>store.run('alice',failed.id).status==='failed'?resolve():setTimeout(check,5);check();});
  assert.equal(store.projectState('alice',c.id).property.provenance.run,run.id);
  assert.equal(store.run('alice',failed.id).error,'The harness returned no answer.');
});

test('a new property marks derived fields stale until their tools run again',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  complete(store,'alice',c.id,'first',result({bbl:'1000477501',concepts:['As of right'],places:['Fulton St']}));
  complete(store,'alice',c.id,'same parcel again',result({bbl:'1000477501'}));
  assert.equal(store.projectState('alice',c.id).concepts.stale,null);
  complete(store,'alice',c.id,'switch site',result({bbl:'1000010001'}));
  let state=store.projectState('alice',c.id);
  assert.equal(state.property.value.bbl,'1000010001');
  assert.equal(state.concepts.stale,'property');assert.equal(state.places.stale,'property');
  assert.match(describe(state).concepts.stale,/re-run acres_model_concept/);
  complete(store,'alice',c.id,'model it',result({concepts:['Conversion']}));
  state=store.projectState('alice',c.id);
  assert.equal(state.concepts.stale,null);assert.equal(state.concepts.value[0].name,'Conversion');assert.equal(state.places.stale,'property');
  complete(store,'alice',c.id,'new site with concepts',result({bbl:'3000010001',concepts:['Tower']}));
  state=store.projectState('alice',c.id);
  assert.equal(state.concepts.stale,null);assert.equal(state.places.stale,'property');
});

test('the same parcel with its fields in another order is not a change',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  complete(store,'alice',c.id,'first',result({bbl:'1000477501',concepts:['As of right']}));
  const reordered=result({bbl:'1000477501'});reordered.property={address:'ADDRESS 1000477501',bbl:'1000477501'};
  complete(store,'alice',c.id,'again',reordered);
  assert.equal(store.projectState('alice',c.id).concepts.stale,null);
});

test('a failed state write leaves the run unfinished rather than completed',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const run=store.createRun('alice',c.id,'x');store.begin(run);
  store.project.write=()=>{throw new Error('boom');};
  assert.throws(()=>store.finish(run,'completed',result({bbl:'1000477501'})),/boom/);
  assert.equal(store.run('alice',run.id).status,'running');
  assert.equal(store.conversation('alice',c.id).messages.filter(m=>m.role==='assistant').length,0);
});

test('market inputs and pro formas join the state and go stale with their inputs',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const market={submarket:'FiDi',rents:[{bedrooms:1,rentPerSqftPerMonth:7,source:'StreetEasy',retrievedAt:'2026-10-12',url:'https://streeteasy.com/x',sourceId:3}]};
  const withMarket={...result({bbl:'1000477501',concepts:['As of right']}),market,proFormas:[{name:'Rental',sources:[{source:'StreetEasy',retrievedAt:'2026-10-12',sourceId:3}]}]};
  complete(store,'alice',c.id,'underwrite',withMarket);
  let state=store.projectState('alice',c.id);
  assert.equal(state.market.provenance.tool,'acres_market_inputs');
  assert.equal(state.market.provenance.sources[0].title,'Google Places near the property');
  assert.deepEqual(describe(state).proFormas.names,['Rental']);
  assert.deepEqual(describe(state).market.sections,['rents']);
  complete(store,'alice',c.id,'model again',result({concepts:['Tower']}));
  state=store.projectState('alice',c.id);
  assert.equal(state.proFormas.stale,'concepts');assert.equal(state.market.stale,null);
  assert.equal(store.conversation('alice',c.id).messages.filter(m=>m.role==='assistant')[0].proFormas[0].name,'Rental');
});

test('runs receive the property and a state summary',async t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  complete(store,'alice',c.id,'first',result({bbl:'1000477501',concepts:['As of right']}));
  const inputs=[];
  const manager=new RunManager(store,{},async input=>{inputs.push(input);return {answer:'Done',sources:[]};});
  const run=manager.enqueue('alice',c.id,'follow up');
  await new Promise(resolve=>{const check=()=>store.run('alice',run.id).status==='completed'?resolve():setTimeout(check,5);check();});
  assert.equal(inputs[0].propertyBbl,'1000477501');
  assert.deepEqual(inputs[0].project.property,{bbl:'1000477501',address:'ADDRESS 1000477501',updated:inputs[0].project.property.updated});
  assert.deepEqual(inputs[0].project.concepts.names,['As of right']);
  assert.equal(JSON.stringify(inputs[0].project).includes('scene'),false);
});

test('existing databases are backfilled once from stored runs and properties',t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-project-'));const path=join(dir,'chat.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new ChatStore(path);
  const a=store.createConversation('alice'),b=store.createConversation('alice');
  complete(store,'alice',a.id,'first',result({bbl:'1000477501',concepts:['As of right'],places:['Fulton St']}));
  complete(store,'alice',a.id,'switch',result({bbl:'1000010001'}));
  store.close();
  // Return the database to its pre-state shape: no state rows, a property only on the column.
  const db=new DatabaseSync(path);
  db.exec(`DROP TABLE project_fields; PRAGMA user_version=0;`);
  db.prepare('UPDATE conversations SET property=? WHERE id=?').run(JSON.stringify({bbl:'4000010001',address:'OLD'}),b.id);
  db.close();
  const reopened=new ChatStore(path);
  const state=reopened.projectState('alice',a.id);
  assert.equal(state.property.value.bbl,'1000010001');
  assert.equal(state.concepts.stale,'property');assert.equal(state.places.stale,'property');
  assert.equal(state.concepts.provenance.sources[0].retrievedAt,'2026-10-13T10:01:00.000Z');
  const migrated=reopened.projectState('alice',b.id).property;
  assert.equal(migrated.value.bbl,'4000010001');assert.equal(migrated.provenance.migrated,true);
  assert.equal(reopened.conversation('alice',b.id).property.address,'OLD');
  assert.equal(reopened.one('PRAGMA user_version').user_version,2);
  // A later column-only change is not replayed: the backfill runs once.
  reopened.write('DELETE FROM project_fields WHERE project=?',reopened.projectOf(b.id));reopened.close();
  const again=new ChatStore(path);
  try {assert.equal(again.projectState('alice',b.id).property,undefined);} finally {again.close();}
});

test('envelope and program are captured and go stale with their inputs',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const base={...result({bbl:'1000477501',concepts:['As of right']}),
    envelope:{district:'C5-5',regime:'lower-manhattan',metrics:{far:14.8,heightFeet:240}},
    market:{submarket:'Financial District',rents:[{bedrooms:1,rentPerSqftPerMonth:6,source:'Fixture',retrievedAt:'2026-10-13',sourceId:3}]},
    program:{productType:'rental',residentialGrossSqft:100000,units:103,byBedrooms:[{bedrooms:1,units:103,sourceId:3}]},
    proFormas:[{name:'Base',sources:[{sourceId:3}]}]};
  complete(store,'alice',c.id,'Envelope, program and pro forma',base);
  let state=store.projectState('alice',c.id);
  assert.equal(state.envelope.value.district,'C5-5');
  assert.equal(state.envelope.provenance.tool,'acres_zoning_envelope');
  assert.equal(state.envelope.provenance.sources[0].kind,'property');
  assert.equal(state.program.value.units,103);
  assert.equal(state.program.provenance.tool,'acres_unit_mix');
  assert.equal(state.program.provenance.sources[0].title,'Google Places near the property');
  assert.ok(Object.values(state).every(f=>f.stale===null));
  const summary=describe(state);
  assert.deepEqual([summary.envelope.district,summary.envelope.far,summary.program.units],['C5-5',14.8,103]);
  // A new envelope marks concepts, program and pro formas stale until re-run.
  complete(store,'alice',c.id,'New envelope',{...result({bbl:'1000477501'}),envelope:{district:'C5-5',regime:'lower-manhattan',metrics:{far:12,heightFeet:200}}});
  state=store.projectState('alice',c.id);
  assert.equal(state.envelope.stale,null);
  assert.equal(state.concepts.stale,'envelope');
  assert.equal(state.program.stale,'envelope');
  assert.equal(state.proFormas.stale,'envelope');
});

test('publishing new market evidence leaves prior pro formas unchanged and stale',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const mk=mult=>({submarket:'Financial District',rents:[0,1,2,3].map(b=>({bedrooms:b,rentPerSqftPerMonth:(8-b*0.5)*mult,source:'Fixture',retrievedAt:'2026-10-13',sourceId:4}))});
  const rental={name:'Base',productType:'rental',market:mk(1),program:{grossBuildingSqft:100000,units:[{bedrooms:0,count:20,netSqft:450},{bedrooms:1,count:40,netSqft:650},{bedrooms:2,count:30,netSqft:950},{bedrooms:3,count:10,netSqft:1250}],commercial:[]},landPrice:20000000,hardCostPerSqft:450,softCostPerSqft:100,financing:{loanToCost:.6,interestRate:.08,termMonths:30},operating:{residentialVacancyRate:.05,residentialOpexPerUnitPerYear:12000,commercialVacancyRate:.1,commercialOpexPerSqftPerYear:5},capRate:.05};
  const {base,table}=sensitivity(rental);
  const stored={...base,sensitivity:table,createdAt:'2026-10-13T10:03:00.000Z'};
  const source4={id:4,title:'Fixture market',url:'https://example.com/m',text:'{}',kind:'market',fetchedAt:'2026-10-13T10:03:00.000Z'};
  const withSources=r=>({...r,sources:[...r.sources,source4]});
  const program={productType:'rental',residentialGrossSqft:100000,units:100,byBedrooms:rental.program.units.map(u=>({bedrooms:u.bedrooms,units:u.count,unitSqft:u.netSqft,sourceId:4}))};
  complete(store,'alice',c.id,'Run the numbers',{...withSources(result({bbl:'1000477501'})),market:mk(1),program,proFormas:[stored]});
  let state=store.projectState('alice',c.id);
  assert.equal(state.proFormas.stale,null);
  const noi1=state.proFormas.value[0].operations.noi;
  complete(store,'alice',c.id,'Rents rose',{...withSources(result({bbl:'1000477501'})),market:mk(1.5)});
  state=store.projectState('alice',c.id);
  assert.equal(state.proFormas.stale,'market');
  assert.equal(state.proFormas.value[0].operations.noi,noi1);
  assert.equal(state.program.stale,'market');
});

test('assembly, entitlements, plans, and comparisons are persisted and go stale with their upstream inputs',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const full={
    ...result({bbl:'1000477501',concepts:['Tower']}),
    assembly:{bbls:['1000477501','1000477502'],mergedLotAreaSqft:25000,sourceIds:[1]},
    entitlements:{paths:[{id:'as-of-right',name:'As-of-Right'},{id:'uap',name:'UAP Bonus'}]},
    plans:[{name:'Typical Floor',levels:[{name:'L2'}],sourceId:2}],
    comparisons:[{name:'Option Matrix',winner:{name:'UAP Bonus'},options:[{name:'As-of-Right'},{name:'UAP Bonus'}],sourceIds:[1]}],
  };
  complete(store,'alice',c.id,'Full feasibility',full);
  let state=store.projectState('alice',c.id);
  assert.deepEqual(state.assembly.value.bbls,['1000477501','1000477502']);
  assert.equal(state.entitlements.value.paths.length,2);
  assert.equal(state.plans.value[0].name,'Typical Floor');
  assert.equal(state.comparisons.value[0].winner.name,'UAP Bonus');
  const summary=describe(state);
  assert.deepEqual(summary.assembly.bbls,['1000477501','1000477502']);
  assert.deepEqual(summary.entitlements.paths,['As-of-Right','UAP Bonus']);
  assert.deepEqual(summary.plans.names,['Typical Floor']);
  assert.equal(summary.comparisons.winner,'UAP Bonus');

  complete(store,'alice',c.id,'Switch parcel',result({bbl:'1000010001'}));
  state=store.projectState('alice',c.id);
  assert.equal(state.assembly.stale,'property');
  assert.equal(state.entitlements.stale,'property');
  assert.equal(state.plans.stale,'property');
  assert.equal(state.comparisons.stale,'property');
});

test('probe 5: changing assembly or plans invalidates downstream envelope, concepts, program, proFormas, and comparisons',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const full={
    ...result({bbl:'1000477501',concepts:['Tower']}),
    assembly:{bbls:['1000477501','1000477502'],mergedLotAreaSqft:25000,sourceIds:[1]},
    envelope:{district:'C5-5',regime:'lower-manhattan',metrics:{far:14.8,heightFeet:250},sources:{parcelSourceId:1}},
    entitlements:{paths:[{id:'as-of-right',name:'As-of-Right'}]},
    plans:[{name:'Typical Floor',levels:[{name:'L2'}],sourceId:2}],
    program:{productType:'rental',residentialGrossSqft:200000,units:100,byBedrooms:[]},
    proFormas:[{name:'Base',sources:[]}],
    comparisons:[{name:'Option Matrix',winner:{name:'As-of-Right'},options:[{name:'As-of-Right'}]}],
  };
  complete(store,'alice',c.id,'Initial full run',full);
  complete(store,'alice',c.id,'Add third lot to assembly',{
    ...result({bbl:'1000477501'}),
    assembly:{bbls:['1000477501','1000477502','1000477503'],mergedLotAreaSqft:35000,sourceIds:[1]},
  });
  let state=store.projectState('alice',c.id);
  assert.equal(state.assembly.stale,null);
  assert.equal(state.envelope.stale,'assembly');
  assert.equal(state.entitlements.stale,'assembly');
  assert.equal(state.concepts.stale,'assembly');
  assert.equal(state.plans.stale,'assembly');
  assert.equal(state.program.stale,'assembly');
  assert.equal(state.proFormas.stale,'assembly');
  assert.equal(state.comparisons.stale,'assembly');

  // Re-establish clean state, then change only plans
  complete(store,'alice',c.id,'Reset full run',full);
  complete(store,'alice',c.id,'Revise floorplate plan',{
    ...result({bbl:'1000477501'}),
    plans:[{name:'Revised Floorplate',levels:[{name:'L2'},{name:'L3'}],sourceId:2}],
  });
  state=store.projectState('alice',c.id);
  assert.equal(state.plans.stale,null);
  assert.equal(state.program.stale,'plans');
  assert.equal(state.proFormas.stale,'plans');
  assert.equal(state.comparisons.stale,'plans');
});

test('probe 6: co-writing an unchanged dependent alongside a changed upstream field still marks the dependent stale',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  complete(store,'alice',c.id,'First parcel',result({bbl:'1000477501',concepts:['Old Tower']}));
  assert.equal(store.projectState('alice',c.id).concepts.stale,null);

  // Co-writing the identical old concept array while switching property BBL must mark concepts stale
  complete(store,'alice',c.id,'Switch parcel but echo old concepts',result({bbl:'1000010001',concepts:['Old Tower']}));
  const state=store.projectState('alice',c.id);
  assert.equal(state.property.value.bbl,'1000010001');
  assert.equal(state.concepts.stale,'property');
});

test('probe 9: ChatStore.finish rolls back project_fields on failure and preserves narrated proFormas without post-answer recalculation',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const run1=store.createRun('alice',c.id,'Fail after project.write');
  store.begin(run1);
  const origAddMessage=store.addMessage.bind(store);
  store.addMessage=()=>{throw new Error('message insert failed');};
  assert.throws(()=>store.finish(run1,'completed',result({bbl:'1000477501',concepts:['Rollback Tower']})),/message insert failed/);
  store.addMessage=origAddMessage;
  assert.equal(store.projectState('alice',c.id).property,undefined,'SAVEPOINT must roll back project_fields when finish() fails');

  // A market-only answer must not acquire uncomputed pro formas during publication.
  const mk=mult=>({submarket:'FiDi',rents:[{bedrooms:1,rentPerSqftPerMonth:8*mult,source:'Fixture',retrievedAt:'2026-10-13',sourceId:4}]});
  const rental={name:'Base',productType:'rental',market:mk(1),program:{grossBuildingSqft:50000,units:[{bedrooms:1,count:50,netSqft:700}],commercial:[]},landPrice:10000000,hardCostPerSqft:400,softCostPerSqft:100,financing:{loanToCost:.6,interestRate:.08,termMonths:24},operating:{residentialVacancyRate:.05,residentialOpexPerUnitPerYear:10000,commercialVacancyRate:.1,commercialOpexPerSqftPerYear:5},capRate:.05};
  const {base,table}=sensitivity(rental);
  const stored={...base,sensitivity:table,createdAt:'2026-10-13T10:03:00.000Z'};
  const source4={id:4,title:'Fixture market',url:'https://example.com/m',text:'{}',kind:'market',fetchedAt:'2026-10-13T10:03:00.000Z'};
  const withSources=r=>({...r,sources:[...r.sources,source4]});
  const program={productType:'rental',residentialGrossSqft:50000,units:50,byBedrooms:[{bedrooms:1,units:50,unitSqft:700,sourceId:4}]};
  complete(store,'alice',c.id,'Base run',{...withSources(result({bbl:'1000477501'})),market:mk(1),program,proFormas:[stored]});
  const run3=complete(store,'alice',c.id,'Update market only',{...withSources(result({bbl:'1000477501'})),market:mk(1.5)});
  const statePf=store.projectState('alice',c.id).proFormas.value;
  const runPf=store.run('alice',run3.id).result.proFormas;
  const msgPf=store.conversation('alice',c.id).messages.at(-1).proFormas;
  assert.equal(runPf,undefined);assert.equal(msgPf,undefined);
  assert.deepEqual(statePf,[stored]);
  assert.equal(store.projectState('alice',c.id).proFormas.stale,'market');
});

test('ChatStore.event preserves immutable message.delta chunks and RunManager.pump schedules fairly across accounts while hydrating priorState',async t=>{
  const {store}=setup(t);
  const cAlice=store.createConversation('alice');
  const runDelta=store.createRun('alice',cAlice.id,'Stream delta test');
  store.begin(runDelta);
  const s1=store.event(runDelta.id,'message.delta',{delta:'Hello '});
  const s2=store.event(runDelta.id,'message.delta',{delta:'world!'});
  assert.ok(s2.seq>s1.seq,'delta events must have strictly increasing seq numbers');
  const persistedDeltas=store.runEvents(runDelta.id).filter(e=>e.event==='message.delta');
  assert.equal(persistedDeltas.length,2,'durable deltas must remain immutable for cursor replay');
  assert.deepEqual(persistedDeltas.map(event=>event.delta),['Hello ','world!']);
  assert.equal(store.runEvents(runDelta.id,s1.seq).filter(event=>event.event==='message.delta')[0].delta,'world!');
  store.finish(runDelta,'completed',{
    ...result({bbl:'1000477501',concepts:['Tower']}),
    market:{submarket:'FiDi',rents:[{bedrooms:1,rentPerSqftPerMonth:8,source:'StreetEasy',retrievedAt:'2026-10-13',sourceId:3}]},
    proFormas:[{name:'Rental Base',costs:{totalDevelopmentCost:50000000},returns:{profit:8500000},capRate:0.0525,sources:[{sourceId:3}]}],
  });

  const summary=describe(store.projectState('alice',cAlice.id));
  assert.equal(summary.market.rents[0].rentPerSqftPerMonth,8);
  assert.equal(summary.proFormas.latest.totalDevelopmentCost,50000000);
  assert.equal(summary.proFormas.latest.profit,8500000);

  // Fair per-account scheduling + priorState hydration
  const cAlice2=store.createConversation('alice');
  const cAlice3=store.createConversation('alice');
  const cBob=store.createConversation('bob');
  const order=[];
  const seenPriorStates=[];
  let releaseFirstTwo;
  const gate=new Promise(r=>{releaseFirstTwo=r;});

  const manager=new RunManager(store,{RESEARCH_CONCURRENCY:2},async input=>{
    order.push(input.message);
    seenPriorStates.push(input.priorState);
    if(order.length<=2)await gate;
    return {answer:'OK',sources:[]};
  });

  const r1=manager.enqueue('alice',cAlice.id,'alice-1');
  const r2=manager.enqueue('alice',cAlice2.id,'alice-2');
  const r3=manager.enqueue('alice',cAlice3.id,'alice-3');
  const r4=manager.enqueue('bob',cBob.id,'bob-1');
  releaseFirstTwo();

  await new Promise(resolve=>{
    const check=()=>[r1,r2,r3,r4].every(r=>store.run(r.owner,r.id).status==='completed')?resolve():setTimeout(check,5);
    check();
  });

  assert.equal(order[0],'alice-1');
  assert.equal(order[2],'bob-1','bob-1 must be scheduled ahead of alice-3 when alice still has an active run');
  assert.equal(seenPriorStates[0].property.bbl,'1000477501','non-stale priorState must be hydrated into follow-up run');
  assert.equal(seenPriorStates[0].market.submarket,'FiDi');
});



test('public records, floor-plan audits and envelope capacity persist with short summaries and go stale with their inputs',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const records={bbl:'1000477501',sourceIds:{dobBis:2},submittalForensics:{totalFilingsReturned:7,majorFilings:[{jobType:'NB'}]},dobBisFilings:[{jobNumber:'1'}],hpdViolationSummary:{openInSample:3,classCInSample:1},eDesignations:[{edesignum:'E-1'}],proseReportingMandate:'Cite every filing.'};
  const audit=(pct,recoverable)=>({productType:'rental',summaryMetrics:{currentEfficiencyPercent:pct,targetBenchmarkEfficiencyPercent:85,recoverableNetSqft:recoverable},lossFactorBreakdown:{corridorCirculationShare:0.1}});
  const envelope={district:'C5-5',metrics:{far:15,heightFeet:500},capacity:{lotAreaSqft:40000,builtFloorAreaSqft:100000,byUse:{residential:{maxFar:10,remainingFloorAreaSqft:300000},commercial:{maxFar:15,remainingFloorAreaSqft:500000}}},summary:{maxBuildingHeightFeet:null,maxDwellingUnits:600,stoppedBy:'floor area'}};
  complete(store,'alice',c.id,'Full diligence',{...result({bbl:'1000477501',concepts:['Tower']}),envelope,nycPublicRecords:records,floorplanAudits:[audit(78,12000)]});
  let state=store.projectState('alice',c.id);
  assert.equal(state.publicRecords.value.submittalForensics.totalFilingsReturned,7);
  assert.equal(state.publicRecords.value.proseReportingMandate,undefined);
  assert.equal(state.publicRecords.provenance.tool,'acres_nyc_public_records');
  assert.equal(state.publicRecords.provenance.sources[0].title,'NYC building footprints');
  assert.equal(state.floorplanAudits.value[0].summaryMetrics.recoverableNetSqft,12000);
  assert.equal(state.floorplanAudits.provenance.tool,'acres_audit_floorplan');
  assert.equal(state.envelope.value.capacity.byUse.residential.remainingFloorAreaSqft,300000);
  assert.equal(state.envelope.value.summary.maxDwellingUnits,600);
  const summary=describe(state);
  assert.deepEqual(summary.publicRecords,{bbl:'1000477501',totalFilings:7,majorFilings:1,openHpdViolations:3,classCHpdViolations:1,eDesignations:1,updated:summary.publicRecords.updated});
  assert.deepEqual(summary.floorplanAudits,{count:1,latest:{productType:'rental',currentEfficiencyPercent:78,targetBenchmarkEfficiencyPercent:85,recoverableNetSqft:12000},updated:summary.floorplanAudits.updated});
  assert.deepEqual(summary.envelope.remainingFloorAreaSqft,{residential:300000,commercial:500000});
  assert.equal(summary.envelope.maxDwellingUnits,600);
  assert.ok(JSON.stringify(summary).length<1500);

  complete(store,'alice',c.id,'New massing',result({concepts:['Slab']}));
  state=store.projectState('alice',c.id);
  assert.equal(state.floorplanAudits.stale,'concepts');assert.equal(state.publicRecords.stale,null);
  complete(store,'alice',c.id,'Switch parcel',result({bbl:'1000010001'}));
  state=store.projectState('alice',c.id);
  assert.equal(state.publicRecords.stale,'property');
  assert.match(describe(state).publicRecords.stale,/re-run acres_nyc_public_records/);
});

test('concepts and pro formas accumulate across answers with lineage, replacing same id or name, bounded, and reset on a new subject',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const run1=complete(store,'alice',c.id,'two options',result({bbl:'1000477501',concepts:['As of right','Tower']}));
  const run2=complete(store,'alice',c.id,'revise the tower, add a slab',{...result({concepts:[]}),concepts:[{id:'tower-v2',name:'Tower',context:{sourceId:2}},{id:'Slab',name:'Slab',context:{sourceId:2}}]});
  let state=store.projectState('alice',c.id);
  assert.deepEqual(state.concepts.value.map(x=>x.id),['As of right','tower-v2','Slab']);
  assert.deepEqual(state.concepts.provenance.lineage,[{id:'As of right',name:'As of right',run:run1.id},{id:'tower-v2',name:'Tower',run:run2.id},{id:'Slab',name:'Slab',run:run2.id}]);
  assert.equal(state.concepts.provenance.run,run2.id);
  assert.equal(state.concepts.provenance.sources.length,1);

  const pf=name=>({name,productType:'rental',sources:[{sourceId:1}]});
  for(let i=0;i<14;i++)complete(store,'alice',c.id,'pro forma '+i,{...result({}),proFormas:[pf('Option '+i)]});
  state=store.projectState('alice',c.id);
  assert.equal(state.proFormas.value.length,12);
  assert.equal(state.proFormas.value[0].name,'Option 2');
  assert.equal(state.proFormas.value.at(-1).name,'Option 13');
  assert.equal(describe(state).proFormas.names.at(-1),'Option 13');
  assert.equal(state.proFormas.provenance.lineage.length,12);

  complete(store,'alice',c.id,'new site with its own concept',result({bbl:'1000010001',concepts:['Infill']}));
  state=store.projectState('alice',c.id);
  assert.deepEqual(state.concepts.value.map(x=>x.name),['Infill']);
  complete(store,'alice',c.id,'switch again',result({bbl:'3000010001'}));
  complete(store,'alice',c.id,'model the new site',result({concepts:['Courtyard']}));
  assert.deepEqual(store.projectState('alice',c.id).concepts.value.map(x=>x.name),['Courtyard']);
});

test('an envelope recomputed with only another parking analysis or prose updates in place without staling what was derived from its bulk',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const bulk={district:'R2',regime:'residential',floorArea:{maxFar:0.75,maxFloorAreaSqft:62400},metrics:{far:0.75,heightFeet:21,storeys:2},lot:{areaSqft:83200}};
  const envelope=(parking,note,extra={})=>({...bulk,...extra,parking,note,citations:[{section:'ZR 23-21'}],
    summary:{maxDwellingUnits:16,modeledFar:0.75,parkingRequired:parking.required??null,parkingTransitZones:parking.transitZones??null,proseGuidance:note,...(extra.summary||{})}});
  const first={...result({bbl:'5006180260',concepts:['Detached homes']}),
    envelope:envelope({zone:'beyond',required:null,note:'Computed for the beyond transit zone as requested.'},'Computed from the curated bulk table.'),
    market:{submarket:'Grymes Hill',salePrices:[{bedrooms:3,pricePerSqft:900,source:'Fixture',retrievedAt:'2026-10-19',sourceId:3}]},
    program:{productType:'condo',residentialGrossSqft:14000,units:7,byBedrooms:[{bedrooms:3,units:7,sourceId:3}]},
    proFormas:[{name:'Seven homes',sources:[{sourceId:3}]}],
    entitlements:{district:'R2',scenarios:[{id:'as-of-right'}],sourceId:1}};
  complete(store,'alice',c.id,'Underwrite',first);
  assert.ok(Object.values(store.projectState('alice',c.id)).every(f=>f.stale===null));
  // The next pass reruns the envelope without naming a transit zone: only parking and prose differ.
  const parkingOnly=envelope({required:null,transitZones:{inner:{required:0},outer:{required:null},beyond:{required:null}}},'Outside the Manhattan Core the requirement depends on the transit zone.');
  complete(store,'alice',c.id,'Finish the underwriting',{...result({bbl:'5006180260'}),envelope:parkingOnly});
  let state=store.projectState('alice',c.id);
  assert.deepEqual(state.envelope.value.parking,parkingOnly.parking,'the stored envelope takes the new parking analysis');
  for(const key of ['concepts','entitlements','program','proFormas'])assert.equal(state[key].stale,null,`${key} stays current`);
  // A change to the buildable bulk still invalidates everything derived from it.
  complete(store,'alice',c.id,'Corrected lot',{...result({bbl:'5006180260'}),envelope:envelope(parkingOnly.parking,parkingOnly.note,{floorArea:{maxFar:0.75,maxFloorAreaSqft:60000},summary:{maxDwellingUnits:15}})});
  state=store.projectState('alice',c.id);
  for(const key of ['concepts','entitlements','program','proFormas'])assert.equal(state[key].stale,'envelope',`${key} goes stale with the bulk`);
});

test('saved sources come from the citing run, public kinds only, and the project state holds no source text',t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const page={id:2,title:'Queens rental market report',url:'https://www.example.org/queens-rents',kind:'research',verified:true,fetchedAt:'2026-10-20T12:00:00.000Z',publishedDate:'2026-10-01',offset:24000,totalCharacters:61000,pdf:{page:2},text:'Two bedroom asking rent was $5,100 per month.'};
  const dealModel={id:3,title:'Deal model valuation',url:'https://www.example.org/method',kind:'deal_store',verified:true,fetchedAt:'2026-10-20T12:01:00.000Z',text:'{"landValue":1}'};
  const knowledge={id:4,title:'Saved zoning text',url:'https://zr.planning.nyc.gov/article-ii',kind:'research',verified:true,fetchedAt:'2026-10-20T12:02:00.000Z',text:'Old version.',knowledge:{versionId:'v1',stale:true}};
  const unverified={id:5,title:'Unverified note',url:'https://www.example.org/note',kind:'research',verified:false,fetchedAt:'2026-10-20T12:03:00.000Z',text:'A guess.'};
  const market={submarket:'Long Island City',rents:[2,3,4,5].map(sourceId=>({bedrooms:2,rentPerMonth:5100,sourceId}))};
  complete(store,'alice',c.id,'Model 120 Broadway',{...result({bbl:'1000477501'}),market,sources:[pluto('1000477501'),page,dealModel,knowledge,unverified]});
  const project=store.projectOf(c.id),fields=store.project.read(project);
  assert.ok(!JSON.stringify(fields).includes(page.text),'source text stays with the run, not the project fields');
  const saved=store.savedSources(project,fields);
  assert.deepEqual(Object.fromEntries(saved.map(s=>[s.title,s.fields])),{'NYC Planning PLUTO parcel records':['property'],[page.title]:['market']});
  assert.deepEqual(saved.map(s=>s.title),[page.title,'NYC Planning PLUTO parcel records'],'equally cited sources list newest first');
  const read=saved.find(s=>s.url===page.url);
  assert.equal(read.text,page.text);assert.equal(read.fetchedAt,page.fetchedAt);assert.equal(read.publishedDate,page.publishedDate);assert.equal(read.offset,24000);assert.equal(read.totalCharacters,61000);assert.deepEqual(read.pdf,page.pdf);
  const other=store.createConversation('bob');
  assert.deepEqual(store.savedSources(store.projectOf(other.id),fields),[],'another project cannot read these runs');
});

test('a follow-up run reads a saved source through the run manager and store without fetching it',async t=>{
  const {store}=setup(t),c=store.createConversation('alice');
  const page={id:2,title:'Queens rental market report',url:'https://www.example.org/queens-rents',kind:'research',verified:true,fetchedAt:'2026-10-20T12:00:00.000Z',publishedDate:'2026-10-01',totalCharacters:52000,text:'Two bedroom asking rent was $5,100 per month.'};
  complete(store,'alice',c.id,'Model 120 Broadway',{...result({bbl:'1000477501'}),market:{submarket:'Long Island City',rents:[{bedrooms:2,rentPerMonth:5100,sourceId:2}]},sources:[pluto('1000477501'),page]});
  const original=global.fetch,restore=installOfflinePublicWeb();let network=0;
  global.fetch=async()=>{network++;throw new Error('A saved source must not be fetched again.');};
  t.after(()=>{restore();global.fetch=original;});
  let listed,read;
  const manager=new RunManager(store,{},(input,secrets,progress,emit,onControl)=>research(input,secrets,progress,emit,onControl,async({project,execute,validateAnswer})=>{
    listed=project.savedSources;
    read=await execute('acres_fetch_url',{url:page.url});
    const answer=`Two bedroom asking rent was $5,100 per month [${read.sourceId}].`;
    validateAnswer(answer);return answer;
  }));
  const run=manager.enqueue('alice',c.id,'What rent should the two bedrooms assume?');
  await new Promise(resolve=>{const check=()=>['completed','failed'].includes(store.run('alice',run.id).status)?resolve():setTimeout(check,5);check();});
  assert.equal(store.run('alice',run.id).status,'completed');
  assert.deepEqual(listed.map(s=>s.url).sort(),[pluto('1000477501').url,page.url].sort());
  assert.equal(read.method,'saved-source');assert.equal(read.text,page.text);assert.equal(read.totalCharacters,52000);assert.equal(read.nextOffset,page.text.length);
  assert.equal(network,0);
});

test('a merge keeps a newer stale user edit and marks imported fields built on other inputs stale',t=>{
  const {store}=setup(t),target=store.project.create('alice','site-t','Target',1000),source=store.project.create('alice','site-s','Source',900);
  const user=(units,at)=>({program:{value:{units},provenance:{tool:'user',at:new Date(at).toISOString(),sources:[]}}});
  store.project.write(target,{concepts:{value:{v:'new'},provenance:{tool:'acres_model_concept',sources:[]}}},5000);
  store.project.write(target,user(42,5000),5000);
  store.write("UPDATE project_fields SET stale='concepts' WHERE project=? AND key='program'",target);
  store.project.write(source,{concepts:{value:{v:'old'},provenance:{tool:'acres_model_concept',sources:[]}}},2000);
  store.project.write(source,user(10,2000),2000);
  store.project.mergeFields(source,target,6000);
  assert.equal(store.project.read(target).program.value.units,42,'the newer user edit stands even though it is stale');

  const target2=store.project.create('alice','site-t2','Target2',1000),source2=store.project.create('alice','site-s2','Source2',900);
  store.project.write(target2,{concepts:{value:{v:'new'},provenance:{tool:'acres_model_concept',sources:[]}}},5000);
  store.project.write(source2,{concepts:{value:{v:'old'},provenance:{tool:'acres_model_concept',sources:[]}}},2000);
  store.project.write(source2,{program:{value:{units:7},provenance:{tool:'acres_unit_mix',sources:[]}}},2500);
  store.project.mergeFields(source2,target2,6000);
  const imported=store.project.read(target2).program;
  assert.equal(imported.value.units,7,'the source-only program arrives');
  assert.equal(imported.stale,'concepts','built on the other site concepts, so it is marked stale on arrival');
});

test('a merge carries a newer stale user edit from the joining site live, marked stale',t=>{
  const {store}=setup(t),target=store.project.create('alice','site-mt','Target mirrored',1000),source=store.project.create('alice','site-ms','Source mirrored',900);
  const user=(units,at)=>({program:{value:{units},provenance:{tool:'user',at:new Date(at).toISOString(),sources:[]}}});
  store.project.write(target,user(10,2000),2000);
  store.project.write(source,user(42,5000),5000);
  store.write("UPDATE project_fields SET stale='concepts' WHERE project=? AND key='program'",source);
  store.project.mergeFields(source,target,6000);
  const merged=store.project.read(target).program;
  assert.equal(merged.value.units,42,'the newer user instruction is not dropped just for being stale');
  assert.equal(merged.stale,'concepts','its stale reason survives the move');
});
