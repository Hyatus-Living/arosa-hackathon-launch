import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {planningCommand,buildArchitectureRevision} from './planning.mjs';
import {processModelInput} from './model-intake.mjs';

const owner='a'.repeat(24),stranger='b'.repeat(24),viewer='c'.repeat(24),native={skip:!existsSync(planningCommand().python)&&'Planning environment is not installed'};

test('modeling IFC import, source access and scan checks are independent of underwriting',native,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'arosa-model-test-')),store=new ChatStore(join(directory,'chat.sqlite'));
  const model=store.createModel(owner,'123 Example Street','Existing conditions');
  const conversation=store.createConversation(owner,{projectId:model.id});
  store.grantMember(owner,conversation.id,'account',viewer,'viewer');
  const site=store.createConversation(owner).projectId;
  const before=store.projectView(owner,site);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,architecture:{stateDir:join(directory,'state'),buildPlan:buildArchitectureRevision,worker:null,pipelineVersion:'test'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.architectureJobs.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});});
  const api=(project,operation,input,account=owner,method='POST')=>fetch(`http://127.0.0.1:${server.address().port}/projects/${project}/architecture/${operation}`,{
    method,headers:{authorization:'Bearer test','x-acres-account':account,'content-type':'application/json'},body:JSON.stringify(input),
  });
  const path=join(directory,'existing.ifc');
  execFileSync(planningCommand().python,['-W','ignore','-c','import sys; from test_model_intake import sample; from exporters.ifc import write_plan; write_plan(sys.argv[1],sample())',path],{cwd:planningCommand().dir,stdio:'pipe'});
  const bytes=readFileSync(path),input={name:'existing.ifc',data:bytes.toString('base64')};
  assert.equal((await api(site,'import-ifc',input)).status,404);
  assert.equal((await api(model.id,'import-ifc',input,stranger)).status,404);
  assert.equal((await api(model.id,'import-ifc',input,viewer)).status,403);
  const response=await api(model.id,'import-ifc',input),result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(result.plan.walls.length,8);assert.equal(result.plan.openings.length,9);
  assert.equal(result.plan.sources[0].drawingId,result.source.id);
  const source=`http://127.0.0.1:${server.address().port}/projects/${model.id}/architecture/drawings/${result.source.id}`;
  assert.deepEqual(Buffer.from(await (await fetch(source,{headers:{authorization:'Bearer test','x-acres-account':owner}})).arrayBuffer()),bytes);
  assert.equal((await fetch(source,{headers:{authorization:'Bearer test','x-acres-account':stranger}})).status,404);
  const scan={name:'aligned.xyz',data:Buffer.from('3000 -90 2500\n3000 -190 2500\n').toString('base64'),plan:result.plan,units:'mm',tolerance:.025};
  const checked=await api(model.id,'validate-scan',scan),report=await checked.json();
  assert.equal(checked.status,200,JSON.stringify(report));
  assert.equal(report.testedPoints,2);assert.equal(report.withinTolerance,1);
  assert.ok(report.file.sha256);assert.ok(report.modelFingerprint);
  assert.equal((await api(site,'validate-scan',scan)).status,404);
  assert.equal((await api(model.id,'validate-scan',{...scan,tolerance:0})).status,400);
  assert.equal((await api(model.id,'import-ifc',{name:'broken.ifc',data:Buffer.from('ISO-10303-21;garbage').toString('base64')})).status,422);
  assert.equal(store.projectView(owner,model.id).fields.architecture.value,null,'import review does not silently save a revision');
  const saved=await api(model.id,'plan',{parentRevision:null,plan:result.plan},owner,'PUT'),revision=await saved.json();
  assert.equal(saved.status,201,JSON.stringify(revision));
  assert.equal(revision.revision,1);assert.equal(revision.plan.walls.length,8);
  assert.equal(revision.plan.sources[0].drawingId,result.source.id,'the saved revision keeps source provenance');
  assert.deepEqual(store.projectView(owner,site),before,'underwriting state is untouched');
});

test('invalid uploads fail before execution or retention',async()=>{
  let called=false;const options={run:()=>{called=true;},retain:()=>{called=true;}};
  for(const input of [{name:'x.ifc',data:'%%%%'}, {name:'x.ifc',data:''},{name:'x.txt',data:Buffer.from('ISO-10303-21;').toString('base64')}]){
    await assert.rejects(processModelInput('import-ifc',input,options));
  }
  assert.equal(called,false);
});
