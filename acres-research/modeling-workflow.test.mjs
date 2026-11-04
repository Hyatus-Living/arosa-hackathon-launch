import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';

const alice='a'.repeat(24),bob='b'.repeat(24);
function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-modeling-'));const store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
const property={value:{bbl:'3012340056',address:'Example Street'},provenance:{tool:'user'}};

test('run snapshots carry their server-owned workflow',t=>{
  const store=setup(t),model=store.createModel(alice,'1234 Fulton Street','A building');
  const modelChat=store.createConversation(alice,{projectId:model.id});
  const siteChat=store.createConversation(alice);
  const modelRun=store.createRun(alice,modelChat.id,'Explore');
  const siteRun=store.createRun(alice,siteChat.id,'Explore');
  store.begin(modelRun);store.begin(siteRun);
  assert.equal(modelRun.projectSnapshot.workflow,'modeling');
  assert.equal(siteRun.projectSnapshot.workflow,'underwriting');
});

test('a modeling project with an address is private, persistent and listed without a parcel or underwriting',t=>{
  const store=setup(t),model=store.createModel(alice,'1234 Fulton Street','Courtyard apartments');
  assert.equal(model.workflow,'modeling');assert.equal(model.bbl,null);
  assert.equal(model.fields.proFormas.value,null);assert.equal(model.fields.comparisons.value,null);
  assert.equal(store.projectView(bob,model.id),null);
  assert.deepEqual(store.projectPage(alice,{modelsOnly:true}).projects.map(p=>p.id),[model.id]);
  assert.deepEqual(store.projectPage(alice,{sitesOnly:true}).projects,[]);
  assert.deepEqual(store.projectPage(bob,{modelsOnly:true}).projects,[]);
  const conversation=store.createConversation(alice,{projectId:model.id});
  store.deleteConversation(alice,conversation.id,{onlyEmpty:true});
  assert.equal(store.projectView(alice,model.id).title,'Courtyard apartments','discarding an empty chat keeps the model');
});

test('a model and an underwriting for the same parcel remain independent in either creation order',t=>{
  const store=setup(t),model=store.createModel(alice,'1234 Fulton Street','A building');
  store.project.write(model.id,{property});
  assert.equal(store.projectView(alice,model.id).title,'A building','resolving a parcel preserves the model name');
  const site=store.createConversation(alice,{bbl:property.value.bbl});
  assert.notEqual(site.projectId,model.id);
  store.project.write(site.projectId,{property});
  assert.equal(store.projectView(alice,site.projectId).title,'Example Street','underwriting continues to use the resolved address');
  assert.deepEqual(store.convergeSite(model.id),[]);
  assert.deepEqual(store.convergeSite(site.projectId),[]);
  const another=store.createModel(alice,'1234 Fulton Street','Another design');store.project.write(another.id,{property});
  assert.deepEqual(store.convergeSite(another.id),[]);
  assert.equal(store.projectView(alice,model.id).workflow,'modeling');
  assert.equal(store.projectPage(alice,{modelsOnly:true}).projects.length,2);
  assert.deepEqual(store.projectPage(alice,{sitesOnly:true}).projects.map(p=>p.id),[site.projectId]);
  assert.equal(store.createConversation(alice,{bbl:property.value.bbl}).projectId,site.projectId);
  const chat=store.createConversation(alice,{projectId:model.id});
  assert.equal(chat.workflow,'modeling');
  const listed=store.list(alice).find(c=>c.id===chat.id);
  assert.equal(listed.site.id,model.id,'history does not relink the model conversation to its financial twin');
  assert.equal(listed.site.workflow,'modeling');
  const run=store.createRun(alice,chat.id,'Model this building');store.begin(run);
  const job=store.activeSiteRuns(alice).find(j=>j.id===run.id);
  assert.equal(job.workflow,'modeling');assert.equal(job.step,null,'modeling jobs have no underwriting step');
});

test('renaming a model is versioned, authorized, and recorded',t=>{
  const store=setup(t),model=store.createModel(alice,'123 Example Street','Existing conditions');
  const chat=store.createConversation(alice,{projectId:model.id});
  store.grantMember(alice,chat.id,'account',bob,'viewer');
  assert.throws(()=>store.renameModel(bob,model.id,{version:model.version,title:'Other'}),e=>e.status===403);
  assert.throws(()=>store.renameModel(alice,model.id,{version:model.version-1,title:'Other'}),e=>e.status===409);
  const renamed=store.renameModel(alice,model.id,{version:model.version,title:'  Synthetic geometry  '});
  assert.equal(renamed.title,'Synthetic geometry');assert.equal(renamed.version,model.version+1);
  assert.equal(renamed.fields.property.value.address,'123 Example Street');
  assert.ok(store.projectEvents(model.id).some(e=>e.event==='model.renamed'&&e.account===alice&&e.title==='Synthetic geometry'));
  const unchanged=store.renameModel(alice,model.id,{version:renamed.version,title:renamed.title});
  assert.equal(unchanged.version,renamed.version,'a no-op does not create a new version');
  const site=store.createConversation(alice);
  assert.throws(()=>store.renameModel(alice,site.projectId,{version:0,title:'Other'}),e=>e.status===404);
});

test('saved underwriting architecture is listed separately and remains accessible without pricing a model',t=>{
  const store=setup(t),site=store.createConversation(alice),model=store.createModel(alice,'123 Example Street','New model');
  store.project.write(site.projectId,{architecture:{value:{planId:'saved',revision:1},provenance:{tool:'user'}}});
  assert.deepEqual(store.projectPage(alice,{modelsOnly:true}).projects.map(p=>p.id),[model.id]);
  assert.deepEqual(store.projectPage(alice,{legacyModelsOnly:true}).projects.map(p=>p.id),[site.projectId]);
  assert.deepEqual(store.projectPage(bob,{legacyModelsOnly:true}).projects,[]);
  assert.equal(store.projectView(alice,site.projectId).fields.architecture.value.planId,'saved');
  assert.equal(store.projectView(alice,site.projectId).fields.proFormas.value,null);
  store.grantMember(alice,site.id,'account',bob,'viewer');
  assert.equal(store.projectPage(bob,{legacyModelsOnly:true}).projects[0].id,site.projectId);
});

test('the modeling library lists models and saved underwriting plans together, badged by origin',t=>{
  const store=setup(t),site=store.createConversation(alice),model=store.createModel(alice,'152 West 124 Street, New York, NY, USA','Harlem house','1019080056');
  store.project.write(site.projectId,{architecture:{value:{planId:'saved',revision:1},provenance:{tool:'user'}}});
  const plainSite=store.createConversation(alice);
  const library=store.projectPage(alice,{modelingLibrary:true}).projects;
  assert.deepEqual(new Set(library.map(p=>p.id)),new Set([model.id,site.projectId]));
  assert.equal(library.find(p=>p.id===model.id).modeling,true);
  assert.equal(library.find(p=>p.id===site.projectId).modeling,false);
  assert.equal(library.some(p=>p.id===plainSite.projectId),false,'a site without a saved plan or model stays out of the library');
  assert.deepEqual(store.projectPage(bob,{modelingLibrary:true}).projects,[]);
});

test('a model created from a verified NYC suggestion carries its parcel BBL',t=>{
  const store=setup(t),model=store.createModel(alice,'152 WEST 124 STREET, New York, NY, USA','152 WEST 124 STREET','1019080056');
  assert.equal(model.bbl,'1019080056');
  assert.equal(model.fields.property.value.bbl,'1019080056');
  assert.equal(model.fields.property.value.address,'152 WEST 124 STREET, New York, NY, USA');
  assert.throws(()=>store.createModel(alice,'Somewhere','Bad bbl','123'),e=>e.status===400);
  const noParcel=store.createModel(alice,'1234 Fulton Street','No parcel yet');
  assert.equal(noParcel.bbl,null);
});

test('the separate underwriting list paginates all matching plans, including parcel twins',t=>{
  const store=setup(t),ids=[];
  for(let i=0;i<102;i++){
    const site=store.createConversation(alice);ids.push(site.projectId);
    store.write('UPDATE projects SET title=?,bbl=?,updated=? WHERE id=?',`Plan 100%_ ${i}`,'3012340056',1000,site.projectId);
    store.project.write(site.projectId,{architecture:{value:{planId:`plan-${i}`},provenance:{tool:'user'}}});
  }
  const first=store.projectPage(alice,{legacyModelsOnly:true,q:'100%_'});
  const second=store.projectPage(alice,{legacyModelsOnly:true,q:'100%_',cursor:first.nextCursor});
  assert.equal(first.projects.length,100);assert.equal(second.projects.length,2);assert.equal(second.nextCursor,null);
  assert.deepEqual(new Set([...first.projects,...second.projects].map(p=>p.id)),new Set(ids));
  assert.deepEqual(store.projectPage(alice,{modelsOnly:true}).projects,[]);
});
