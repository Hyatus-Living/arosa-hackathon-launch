import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {fullGraph,describe} from './project-state.mjs';
import {sensitivity} from './proforma.mjs';

const alice='a'.repeat(24),bob='b'.repeat(24),eve='e'.repeat(24);
function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-projects-'));const path=join(dir,'chat.sqlite');const store=new ChatStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,path,dir};}
const pluto=bbl=>({id:1,title:'NYC Planning PLUTO parcel records',url:'https://data.cityofnewyork.us/resource/64uk-42ks.json?bbl='+bbl,text:JSON.stringify([{bbl}]),kind:'property',fetchedAt:'2026-10-13T10:00:00.000Z'});
const marketSource={id:4,title:'Fixture market',url:'https://example.com/m',text:'{}',kind:'market',fetchedAt:'2026-10-13T10:03:00.000Z'};
const subject=bbl=>({answer:'Answer [1]',property:{bbl,address:'ADDRESS '+bbl},sources:[pluto(bbl),marketSource]});
function complete(store,owner,conversation,input,output){const run=store.createRun(owner,conversation,input);store.begin(run);store.finish(run,'completed',output);return run;}

// A subject with market inputs, a unit mix and one stored rental pro forma computed by the real model.
const market=(rent=8)=>({submarket:'FiDi',rents:[{bedrooms:1,rentPerSqftPerMonth:rent,source:'Fixture',retrievedAt:'2026-10-13',sourceId:4}]});
const program={productType:'rental',residentialGrossSqft:50000,units:50,byBedrooms:[{bedrooms:1,units:50,unitSqft:700,sourceId:4}]};
function underwritten(){
  const args={name:'Base',productType:'rental',market:market(),program:{grossBuildingSqft:50000,units:[{bedrooms:1,count:50,netSqft:700}],commercial:[]},landPrice:10000000,hardCostPerSqft:400,softCostPerSqft:100,financing:{loanToCost:.6,interestRate:.08,termMonths:24},operating:{residentialVacancyRate:.05,residentialOpexPerUnitPerYear:10000,commercialVacancyRate:.1,commercialOpexPerSqftPerYear:5},capRate:.05};
  const {base,table}=sensitivity(args);
  return {...subject('1000477501'),market:market(),program,proFormas:[{...base,sensitivity:table,createdAt:'2026-10-13T10:03:00.000Z'}]};
}

test('every conversation gets a project, and two conversations attached to one project share one state',t=>{
  const {store}=setup(t);
  const first=store.createConversation(alice);
  assert.match(first.projectId,/^[0-9a-f-]{36}$/);
  const second=store.createConversation(alice,{projectId:first.projectId});
  assert.equal(second.projectId,first.projectId);
  const run=complete(store,alice,first.id,'Model 120 Broadway',subject('1000477501'));
  assert.equal(store.projectState(alice,second.id).property.value.bbl,'1000477501');
  assert.equal(store.conversation(alice,second.id).property.bbl,'1000477501');
  const project=store.projectView(alice,first.projectId);
  assert.equal(project.siteKey,'1000477501');assert.equal(project.bbl,'1000477501');assert.equal(project.title,'ADDRESS 1000477501');
  assert.equal(project.version,1);
  assert.equal(project.fields.property.provenance.run,run.id);
  assert.deepEqual(Object.keys(project.fields).sort(),[...new Set([...Object.keys(fullGraph),'publicRecords','floorplanAudits','assumptions'])].sort());
  assert.deepEqual(project.fields.envelope,{value:null,provenance:null,stale:null,updated:null});
  assert.deepEqual(store.listProjects(alice).map(p=>[p.id,p.conversationCount]),[[first.projectId,2]]);
  assert.equal(store.listProjects(alice,'ADDRESS 1000').length,1);
  assert.equal(store.listProjects(alice,'nothing like it').length,0);
  assert.equal(store.listProjects(bob).length,0);
});

test('project access mirrors the owning conversation, and attaching never widens it',t=>{
  const {store}=setup(t);
  const owned=store.createConversation(alice);
  assert.throws(()=>store.createConversation(bob,{projectId:owned.projectId}),e=>e.status===404);
  assert.equal(store.projectView(bob,owned.projectId),null);
  store.grantMember(alice,owned.id,'account',bob,'viewer');
  assert.equal(store.projectView(bob,owned.projectId).access,'viewer');
  const attached=store.createConversation(bob,{projectId:owned.projectId});
  // Bob owns his conversation but is still a viewer of Alice's project, so his runs read the shared
  // state without writing it, and a member of his conversation gains nothing on the project.
  assert.equal(store.projectView(bob,owned.projectId).access,'viewer');
  complete(store,bob,attached.id,'look at another parcel',subject('3000010001'));
  assert.equal(store.projectState(bob,attached.id).property,undefined);
  store.grantMember(bob,attached.id,'account',eve,'participant');
  assert.equal(store.projectView(eve,owned.projectId).access,'viewer');
  store.setGrantRole(alice,owned.id,'account',bob,'participant');
  assert.equal(store.projectView(bob,owned.projectId).access,'participant');
  assert.deepEqual(store.listProjects(eve).map(p=>p.id),[owned.projectId]);
});

test('existing conversations each get a project and their fields move over on open',t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-projects-'));const path=join(dir,'chat.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new ChatStore(path);
  const sited=store.createConversation(alice),blank=store.createConversation(alice);
  complete(store,alice,sited.id,'Model 120 Broadway',subject('1000477501'));
  store.write("UPDATE conversations SET title='Blank deal' WHERE id=?",blank.id);
  store.close();
  // Return the database to the conversation-keyed shape it had before projects.
  const db=new DatabaseSync(path);
  db.exec(`ALTER TABLE project_fields RENAME TO project_fields_new;
    CREATE TABLE project_fields(conversation TEXT NOT NULL REFERENCES conversations(id),key TEXT NOT NULL,value TEXT NOT NULL,provenance TEXT NOT NULL,stale TEXT,updated INTEGER NOT NULL,PRIMARY KEY(conversation,key));
    INSERT INTO project_fields SELECT c.id,f.key,f.value,f.provenance,f.stale,f.updated FROM project_fields_new f JOIN conversations c ON c.project=f.project;
    DROP TABLE project_fields_new; DROP TABLE project_events; DROP INDEX IF EXISTS conversation_project; DROP INDEX IF EXISTS conversation_owner_project; ALTER TABLE conversations DROP COLUMN project; DROP TABLE projects;`);
  db.close();
  const reopened=new ChatStore(path);
  try {
    const a=reopened.conversation(alice,sited.id),b=reopened.conversation(alice,blank.id);
    assert.notEqual(a.projectId,b.projectId);
    const pa=reopened.projectView(alice,a.projectId),pb=reopened.projectView(alice,b.projectId);
    assert.equal(pa.siteKey,'1000477501');assert.equal(pa.title,'ADDRESS 1000477501');assert.equal(pa.fields.property.value.bbl,'1000477501');
    assert.equal(pb.siteKey,blank.id);assert.equal(pb.bbl,null);assert.equal(pb.title,'Blank deal');
    assert.equal(pa.owner.account,alice);
    reopened.close();
    const again=new ChatStore(path);
    try {assert.equal(again.listProjects(alice).length,2);assert.equal(again.conversation(alice,sited.id).projectId,a.projectId);}
    finally {again.close();}
  } finally {if(reopened.db.isOpen)reopened.close();}
});

test('user edits are versioned, limited to user-owned keys and validated with the pro forma ranges',t=>{
  const {store}=setup(t);
  const c=store.createConversation(alice);
  store.grantMember(alice,c.id,'account',bob,'viewer');
  const edit=(account,body)=>store.updateProjectState(account,c.projectId,body);
  assert.throws(()=>edit(eve,{version:0,fields:{assumptions:{}}}),e=>e.status===404);
  assert.throws(()=>edit(bob,{version:0,fields:{assumptions:{}}}),e=>e.status===403);
  assert.throws(()=>edit(alice,{version:3,fields:{assumptions:{landPrice:1}}}),e=>e.status===409&&e.version===0);
  assert.throws(()=>edit(alice,{version:0,fields:{envelope:{}}}),e=>e.status===400&&/envelope/.test(e.message));
  assert.throws(()=>edit(alice,{version:0,fields:{assumptions:{hardCostPerSqft:10}}}),e=>e.status===400&&/hardCostPerSqft must be a number from 50 to 3000/.test(e.message));
  assert.throws(()=>edit(alice,{version:0,fields:{assumptions:{financing:{termMonths:6.5}}}}),e=>e.status===400&&/termMonths/.test(e.message));
  assert.throws(()=>edit(alice,{version:0,fields:{assumptions:{discountRate:.1}}}),e=>e.status===400&&/discountRate/.test(e.message));
  assert.throws(()=>edit(alice,{version:0,fields:{market:{submarket:'FiDi'}}}),e=>e.status===400);
  const state=edit(alice,{version:0,fields:{assumptions:{landPrice:12000000,capRate:.055,financing:{loanToCost:.65}}}});
  assert.equal(state.version,1);
  assert.deepEqual(state.fields.assumptions.value,{landPrice:12000000,capRate:.055,financing:{loanToCost:.65}});
  assert.equal(state.fields.assumptions.provenance.tool,'user');
  assert.equal(state.fields.assumptions.provenance.account,alice);
  assert.equal(typeof state.fields.assumptions.provenance.at,'string');
  assert.equal(state.fields.assumptions.stale,null);
  assert.equal(describe(store.projectState(alice,c.id)).assumptions.values.landPrice,12000000);
  assert.equal(edit(alice,{version:1,fields:{assumptions:{landPrice:12000000,capRate:.055,financing:{loanToCost:.65}}}}).version,1,'an unchanged write is not a new version');
});

test('a user saves instructions per page section and the agent sees them without anything going stale',t=>{
  const {store}=setup(t);
  const alice='a'.repeat(24);
  const c=store.createConversation(alice);
  const edit=body=>store.updateProjectState(alice,c.projectId,body);
  assert.throws(()=>edit({version:0,fields:{instructions:{lobby:'x'}}}),e=>e.status===400&&/lobby is not a section/.test(e.message));
  assert.throws(()=>edit({version:0,fields:{instructions:{massing:7}}}),e=>e.status===400&&/instructions.massing must be text/.test(e.message));
  assert.throws(()=>edit({version:0,fields:{instructions:{massing:'x'.repeat(2001)}}}),e=>e.status===400&&/2000 characters/.test(e.message));
  const state=edit({version:0,fields:{instructions:{envelope:'  Assume a wide street on Atlantic Ave. ',massing:'',revenue:'Condo only.'}}});
  assert.deepEqual(state.fields.instructions.value,{envelope:'Assume a wide street on Atlantic Ave.',revenue:'Condo only.'});
  assert.equal(state.fields.instructions.provenance.tool,'user');
  assert.deepEqual(describe(store.projectState(alice,c.id)).instructions.bySection,{'Zoning envelope and scenarios':'Assume a wide street on Atlantic Ave.','Usable area and revenue':'Condo only.'});
});

test('editing assumptions, market or program recomputes every stored pro forma in code with its lineage',t=>{
  const {store}=setup(t);
  const c=store.createConversation(alice);
  const run=complete(store,alice,c.id,'underwrite',underwritten());
  const before=store.projectView(alice,c.projectId);
  const prior=before.fields.proFormas.value[0];
  let state=store.updateProjectState(alice,c.projectId,{version:before.version,fields:{assumptions:{landPrice:20000000,financing:{interestRate:.09}}}});
  let pf=state.fields.proFormas;
  assert.equal(pf.stale,null);assert.equal(pf.provenance.derived,true);
  assert.deepEqual(pf.provenance.lineage,[{id:null,name:'Base',run:run.id}]);
  assert.equal(pf.value[0].derived,true);
  assert.equal(pf.value[0].inputs.landPrice,20000000);
  assert.equal(pf.value[0].inputs.financing.interestRate,.09);
  assert.equal(pf.value[0].inputs.financing.loanToCost,.6,'inputs the user did not edit stay as the pro forma stated them');
  assert.equal(pf.value[0].inputs.hardCostPerSqft,400);
  assert.ok(pf.value[0].development.totalDevelopmentCost>prior.development.totalDevelopmentCost);
  assert.ok(pf.value[0].sensitivity.rent.length>0);
  state=store.updateProjectState(alice,c.projectId,{version:state.version,fields:{market:market(12)}});
  pf=state.fields.proFormas;
  assert.equal(pf.stale,null);
  assert.ok(pf.value[0].operations.noi>prior.operations.noi);
  assert.equal(pf.value[0].inputs.landPrice,20000000,'assumptions keep applying after a market edit');
  assert.equal(state.fields.market.provenance.tool,'user');
  state=store.updateProjectState(alice,c.projectId,{version:state.version,fields:{program:{...program,units:40,byBedrooms:[{bedrooms:1,units:40,unitSqft:700}]}}});
  assert.equal(state.fields.proFormas.value[0].inputs.program.units[0].count,40);
  assert.equal(state.fields.proFormas.value[0].inputs.program.grossBuildingSqft,50000);
});

test('state writes emit state.updated on the run stream and the project feed',t=>{
  const {store}=setup(t);
  const c=store.createConversation(alice);
  const live=[];store.projectFeed.on(c.projectId,e=>live.push(e));
  const run=complete(store,alice,c.id,'Model 120 Broadway',subject('1000477501'));
  const events=store.runEvents(run.id).map(e=>e.event);
  assert.ok(events.indexOf('state.updated')>=0&&events.indexOf('state.updated')<events.indexOf('run.completed'));
  const onRun=store.runEvents(run.id).find(e=>e.event==='state.updated');
  assert.equal(onRun.projectId,c.projectId);assert.equal(onRun.version,1);assert.deepEqual(onRun.keys,['property']);
  store.updateProjectState(alice,c.projectId,{version:1,fields:{assumptions:{landPrice:5000000}}});
  const feed=store.projectEvents(c.projectId);
  assert.deepEqual(feed.map(e=>[e.seq,e.event,e.version,e.keys]),[[1,'state.updated',1,['property']],[2,'state.updated',2,['assumptions']]]);
  assert.deepEqual(store.projectEvents(c.projectId,1).map(e=>e.seq),[2]);
  assert.deepEqual(live.map(e=>e.seq),[1,2]);
  complete(store,alice,c.id,'same parcel again',subject('1000477501'));
  assert.equal(store.projectEvents(c.projectId).length,2,'a run that changes nothing emits nothing');
});

test('the project API serves state with an ETag, guards edits by version and streams state.updated',{timeout:5000},async t=>{
  const {store}=setup(t);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[],ui:[]})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,method='GET',body,account=alice)=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':account,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const first=await (await request('/conversations','POST',{})).json();
  assert.match(first.projectId,/^[0-9a-f-]{36}$/);
  assert.equal((await request('/conversations','POST',{projectId:first.projectId},bob)).status,404);
  const second=await (await request('/conversations','POST',{projectId:first.projectId})).json();
  assert.equal(second.projectId,first.projectId);
  assert.equal((await (await request('/conversations/'+second.id)).json()).projectId,first.projectId);
  complete(store,alice,first.id,'underwrite',underwritten());

  const read=await request('/projects/'+first.projectId+'/state');
  assert.equal(read.status,200);assert.equal(read.headers.get('etag'),'"1"');
  const state=await read.json();
  assert.equal(state.id,first.projectId);assert.equal(state.siteKey,'1000477501');assert.equal(state.bbl,'1000477501');
  assert.equal(state.title,'ADDRESS 1000477501');assert.equal(state.owner.account,alice);assert.equal(state.version,1);assert.equal(typeof state.updated,'number');
  assert.equal(state.fields.market.value.submarket,'FiDi');assert.equal(state.fields.assumptions.value,null);
  assert.equal((await request('/projects/'+first.projectId+'/state','GET',null,bob)).status,404);
  const listed=await (await request('/projects?q=ADDRESS')).json();
  assert.deepEqual(listed.projects.map(p=>({id:p.id,siteKey:p.siteKey,bbl:p.bbl,title:p.title,version:p.version,conversationCount:p.conversationCount})),[{id:first.projectId,siteKey:'1000477501',bbl:'1000477501',title:'ADDRESS 1000477501',version:1,conversationCount:2}]);

  const controller=new AbortController();t.after(()=>controller.abort());
  const stream=await fetch(base+'/projects/'+first.projectId+'/events?after=1',{headers:{authorization:'Bearer test','x-acres-account':alice},signal:controller.signal});
  assert.equal(stream.headers.get('content-type'),'text/event-stream');
  const conflict=await request('/projects/'+first.projectId+'/state','PATCH',{version:0,fields:{assumptions:{landPrice:1}}});
  assert.equal(conflict.status,409);assert.equal((await conflict.json()).version,1);
  assert.equal((await request('/projects/'+first.projectId+'/state','PATCH',{version:1,fields:{concepts:[]}})).status,400);
  const patched=await request('/projects/'+first.projectId+'/state','PATCH',{version:1,fields:{assumptions:{landPrice:15000000}}});
  assert.equal(patched.status,200);assert.equal(patched.headers.get('etag'),'"2"');
  const after=await patched.json();
  assert.equal(after.version,2);assert.equal(after.fields.proFormas.value[0].inputs.landPrice,15000000);
  const reader=stream.body.getReader();let chunk='';
  while(!chunk.includes('state.updated'))chunk+=new TextDecoder().decode((await reader.read()).value);
  const [event]=chunk.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  assert.equal(event.event,'state.updated');assert.equal(event.projectId,first.projectId);assert.equal(event.version,2);
  assert.ok(event.keys.includes('assumptions')&&event.keys.includes('proFormas'));
  assert.doesNotMatch(chunk,/"version":1/,'the after cursor skips events already seen');

  const deck=await (await request('/conversations/'+second.id+'/deck')).json();
  assert.equal(deck.slides[0].metrics.bbl,'1000477501','the deck of an attached conversation reads the shared project');
});

test('a client connected to a run stream receives state.updated before run.completed',{timeout:5000},async t=>{
  const {store}=setup(t);
  let release;const held=new Promise(resolve=>{release=resolve;});
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async(input,secrets,progress,emit)=>{emit('tool.started',{tool:'acres_set_subject'});await held;return subject('1000477501');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:'Bearer test','x-acres-account':alice,'content-type':'application/json'};
  const conversation=await (await fetch(base+'/conversations',{method:'POST',headers,body:'{}'})).json();
  const run=await (await fetch(base+'/conversations/'+conversation.id+'/runs',{method:'POST',headers,body:JSON.stringify({message:'120 Broadway'})})).json();
  const stream=await fetch(base+'/runs/'+run.id+'/events',{headers});
  const reader=stream.body.getReader();let text='';
  while(!text.includes('tool.started'))text+=new TextDecoder().decode((await reader.read()).value);
  release();
  for(let chunk=await reader.read();!chunk.done;chunk=await reader.read())text+=new TextDecoder().decode(chunk.value);
  const events=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  const names=events.map(e=>e.event);
  assert.ok(names.includes('state.updated'),names.join(','));
  assert.ok(names.indexOf('state.updated')<names.indexOf('run.completed'));
  assert.deepEqual(events.find(e=>e.event==='state.updated').keys,['property']);
  assert.equal(events.find(e=>e.event==='state.updated').projectId,conversation.projectId);
});

test('publication preserves distinct scenario identities; user market edits reprice each own program and ambiguous program edits stay stale',t=>{
  const {store}=setup(t),c=store.createConversation(alice),full=underwritten(),a=full.proFormas[0];
  const {market:echo,...inputs}=a.inputs;
  const {base,table}=sensitivity({...inputs,name:'Half the homes',program:{...inputs.program,units:[{bedrooms:1,count:25,netSqft:700}]}},full.market,{rent:[-.2,.2]});
  const b={...base,sensitivity:table,sensitivitySteps:{rent:[-.2,.2]}};
  full.proFormas.push(b);full.program={...program,units:25,byBedrooms:[{bedrooms:1,units:25,unitSqft:700}]};
  const run=complete(store,alice,c.id,'Compare distinct programs',full),published=store.projectView(alice,c.projectId);
  assert.deepEqual(published.fields.proFormas.value,[a,b]);assert.deepEqual(store.run(alice,run.id).result.proFormas,[a,b]);
  const updated=store.updateProjectState(alice,c.projectId,{version:published.version,fields:{market:market(9)}});
  assert.deepEqual(updated.fields.proFormas.value.map(p=>p.inputs.program.units[0].count),[50,25]);
  assert.ok(updated.fields.proFormas.value[0].operations.noi>a.operations.noi);assert.ok(updated.fields.proFormas.value[1].operations.noi>b.operations.noi);
  assert.deepEqual(updated.fields.proFormas.value[1].sensitivitySteps,{rent:[-.2,.2]});assert.equal(updated.fields.proFormas.value[1].sensitivity.rent.length,3);
  const changed=store.updateProjectState(alice,c.projectId,{version:updated.version,fields:{program:{...program,units:40,byBedrooms:[{bedrooms:1,units:40,unitSqft:700}]}}});
  assert.equal(changed.fields.proFormas.stale,'program');assert.deepEqual(changed.fields.proFormas.value,updated.fields.proFormas.value);
});

test('program edits that change product or building area cannot silently reuse the old financial model',t=>{
  const {store}=setup(t);
  for(const patch of [{...program,productType:'condo'},{...program,residentialGrossSqft:60000}]){
    // Each pass researches the same lot, so the second chat joins the first one's site.
    const c=store.createConversation(alice);complete(store,alice,c.id,'Base',underwritten());const site=store.projectOf(c.id),before=store.projectView(alice,site);
    const after=store.updateProjectState(alice,site,{version:before.version,fields:{program:patch}});
    assert.equal(after.fields.proFormas.stale,'program');assert.deepEqual(after.fields.proFormas.value,before.fields.proFormas.value);
  }
});
