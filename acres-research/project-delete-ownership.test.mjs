import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {Drawings} from './architecture-drawings.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {buildArchitectureRevision,planningCommand} from './planning.mjs';
import {createResearchServer} from './service.mjs';

const tables=['project_fields','project_events','architecture_artifacts','architecture_jobs','architecture_plans','architecture_drawings'];
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'acres-owner-delete-')),store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return{dir,store};}
const snapshot=(s,id)=>JSON.stringify({project:s.project.row(id),data:Object.fromEntries(tables.map(table=>[table,s.query(`SELECT * FROM ${table} WHERE project=? ORDER BY rowid`,id)]))});
function shared(s,owner='owner',collaborator='collaborator',role='viewer'){
  const first=s.createConversation(owner);s.project.write(first.projectId,{instructions:{value:{property:'Owner site notes'},provenance:{tool:'user',account:owner}}});
  s.grantMember(owner,first.id,'account',collaborator,role);
  return{first,own:s.createConversation(collaborator,{projectId:first.projectId})};
}

test('a collaborator can delete their own final conversation without deleting the original owners saved site',t=>{
  const {store:s}=fixture(t);
  for(const role of ['viewer','participant']){
    const {first,own}=shared(s,'owner','collaborator',role),run=s.createRun('collaborator',own.id,'Private research note');s.begin(run);s.finish(run,'completed',{answer:'Private answer',sources:[]});
    s.deleteConversation('owner',first.id);assert.equal(s.projectAccess('collaborator',first.projectId),'viewer');
    assert.throws(()=>s.requireProject('collaborator',first.projectId,'participant'),e=>e.status===403);
    const before=snapshot(s,first.projectId);assert.equal(s.deleteConversation('collaborator',own.id),true);
    assert.equal(snapshot(s,first.projectId),before);assert.equal(s.conversation('collaborator',own.id),null);assert.equal(s.runRow(run.id),null);
    assert.equal(s.projectAccess('owner',first.projectId),'owner');assert.equal(s.projectAccess('collaborator',first.projectId),null);
    assert.equal(s.projectPage('owner').projects.find(p=>p.id===first.projectId).conversationCount,0);
    assert.equal(s.createConversation('owner',{projectId:first.projectId}).projectId,first.projectId);
  }
});

test('conditional cleanup can discard an empty collaborators conversation while keeping the foreign owned site',t=>{
  const {store:s}=fixture(t),{first,own}=shared(s);s.deleteConversation('owner',first.id);const before=snapshot(s,first.projectId);
  assert.equal(s.deleteConversation('collaborator',own.id,{onlyEmpty:true}),true);assert.equal(snapshot(s,first.projectId),before);
  assert.equal(s.conversation('collaborator',own.id),null);assert.ok(s.projectView('owner',first.projectId));
});

test('an actual project owner retains the existing ability to remove their own last conversation and site',t=>{
  const {store:s}=fixture(t),c=s.createConversation('owner');s.project.write(c.projectId,{instructions:{value:{property:'Owned notes'},provenance:{tool:'user'}}});
  const run=s.createRun('owner',c.id,'Owned research');s.begin(run);s.finish(run,'completed',{answer:'Owned answer',sources:[]});
  assert.equal(s.deleteConversation('owner',c.id),true);assert.equal(s.project.row(c.projectId),null);
  for(const table of tables)assert.equal(s.query(`SELECT * FROM ${table} WHERE project=?`,c.projectId).length,0);
});

test('project ownership does not authorize deleting a collaborators private conversation or removing a site with other conversations',t=>{
  const {store:s}=fixture(t),{first,own}=shared(s),before=snapshot(s,first.projectId);
  assert.throws(()=>s.deleteConversation('owner',own.id),e=>e.status===404);
  s.grantMember('collaborator',own.id,'account','owner','viewer');assert.throws(()=>s.deleteConversation('owner',own.id),e=>e.status===403);
  assert.equal(s.deleteConversation('owner',first.id),true);assert.equal(snapshot(s,first.projectId),before);assert.ok(s.conversation('collaborator',own.id));
});

test('authenticated HTTP keeps the orphaned site browsable and reusable by its owner while removing collaborator access',async t=>{
  const {store:s}=fixture(t),owner='a'.repeat(24),collaborator='b'.repeat(24),outsider='c'.repeat(24),{first,own}=shared(s,owner,collaborator);
  const unrelated=s.createConversation(collaborator);s.project.write(unrelated.projectId,{instructions:{value:{property:'Unrelated site'},provenance:{tool:'user'}}});
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'controlled-local-test'},store:s,maps:null,execute:async()=>({answer:'',sources:[],ui:[]})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const request=(account,path,options={})=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{...options,headers:{'content-type':'application/json',authorization:'Bearer controlled-local-test','x-acres-account':account}});
  assert.equal((await request(owner,`/conversations/${first.id}`,{method:'DELETE'})).status,200);
  const before=snapshot(s,first.projectId),otherBefore=snapshot(s,unrelated.projectId);
  assert.equal((await request(collaborator,`/conversations/${own.id}`,{method:'DELETE'})).status,200);
  assert.equal(snapshot(s,first.projectId),before);assert.equal(snapshot(s,unrelated.projectId),otherBefore);
  const state=await request(owner,`/projects/${first.projectId}/state`);assert.equal(state.status,200);assert.equal((await state.json()).fields.instructions.value.property,'Owner site notes');
  const list=await(await request(owner,'/projects')).json();assert.equal(list.projects.find(p=>p.id===first.projectId).conversationCount,0);
  assert.equal((await request(collaborator,`/projects/${first.projectId}/state`)).status,404);assert.equal((await request(outsider,`/projects/${first.projectId}/state`)).status,404);
  const reopened=await request(owner,'/conversations',{method:'POST',body:JSON.stringify({projectId:first.projectId})});assert.equal(reopened.status,201);assert.equal((await reopened.json()).projectId,first.projectId);
});

test('native plan artifacts, actual drawing bytes and project audit history survive the collaborator deleting their last chat',{skip:existsSync(planningCommand().python)?false:'planning/.venv is not installed'},async t=>{
  const {dir,store:s}=fixture(t),{first,own}=shared(s);
  const architecture=new Architecture(s,{stateDir:dir,buildPlan:buildArchitectureRevision});
  const plan=JSON.parse(readFileSync(new URL('../planning/fixtures/sample-plan.json',import.meta.url),'utf8'));
  const saved=await architecture.save('owner',first.projectId,{parentRevision:null,plan},row=>row);
  const drawings=new Drawings(s,{stateDir:dir}),drawing=drawings.add('owner',first.projectId,{bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0"/></svg>'),name:'Site reference.svg',by:'user'});
  const ifc=saved.artifacts.find(a=>a.kind==='ifc');
  s.write('INSERT INTO architecture_jobs(job_id,project,revision,status,reason,input_hash,pipeline_version,settings_hash,settings,created_by,created_at,started_at,finished_at,job_dir,pid,artifacts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)','controlled-job-history',first.projectId,1,'failed','Controlled historical job fixture',ifc.sha256,'history-fixture','settings','{}','owner',1,1,2,join(dir,'job-history'),null,'[]');
  s.deleteConversation('owner',first.id);const before=snapshot(s,first.projectId);
  const files=saved.artifacts.map(a=>{const row=architecture.artifactRow(first.projectId,a.id);return{path:row.path,sha:createHash('sha256').update(readFileSync(row.path)).digest('hex')};});
  const drawingBefore=drawings.open('owner',first.projectId,drawing.id).read();
  for(const table of tables)assert.ok(s.query(`SELECT * FROM ${table} WHERE project=?`,first.projectId).length>0,table+' fixture must contain saved data');
  s.deleteConversation('collaborator',own.id);assert.equal(snapshot(s,first.projectId),before);
  assert.equal(architecture.summary('owner',first.projectId,row=>row).current.revision,1);
  assert.ok(drawings.open('owner',first.projectId,drawing.id).read().equals(drawingBefore));
  for(const file of files)assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'),file.sha);
});
