import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ChatStore} from '../store.mjs';
import {createResearchServer} from '../service.mjs';

const account='a'.repeat(24);
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const outputNames=['model.blend','preview.png','model.glb','manifest.json'];
export const outputKinds=['blend','preview','glb','manifest'];
const plan={schema:'acres.architecture.plan/1',name:'Output integrity fixture',units:'m',
  levels:[{id:'ground',elevation:0,height:3}],walls:[{id:'wall',levelId:'ground',start:[0,0],end:[10,0],thickness:0.2,height:3}],
  rooms:[],openings:[],objects:[],sources:[]};

const workerSource=`#!/usr/bin/env node
const {readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const dir=process.argv[process.argv.indexOf('--job')+1];
const job=JSON.parse(readFileSync(join(dir,'job.json'),'utf8'));
const settings=job.settings,out=join(dir,'output');
const files={'model.blend':'BLENDER fixture','preview.png':'PNG fixture','model.glb':'glTF fixture','manifest.json':'{"objects":[],"levels":[]}'};
const kinds=['blend','preview','glb','manifest'];
const hashes={};
Object.entries(files).forEach(([name,bytes],i)=>{
  hashes[kinds[i]+'Sha256']=createHash('sha256').update(bytes).digest('hex');
  if(settings.omit!==name)writeFileSync(join(out,name),settings.empty===name?'':bytes);
});
const verification={status:'succeeded',hashes};
if(settings.status==='missing')delete verification.status;
else if(settings.status)verification.status=settings.status;
if(settings.noHashes)delete verification.hashes;
if(settings.wrongHash)hashes[settings.wrongHash+'Sha256']='0'.repeat(64);
if(settings.tamper)writeFileSync(join(out,settings.tamper),'X'.repeat(files[settings.tamper].length));
if(settings.omit!=='verification.json')writeFileSync(join(out,'verification.json'),settings.empty==='verification.json'?'':JSON.stringify(settings.nullVerification?null:verification));
if(settings.exitCode)process.exitCode=settings.exitCode;
`;

// Uses the real service, SQLite revisions, supervisor and detached process. Geometry and
// worker output bytes are fixtures; these checks make no Blender or model-validity claim.
export async function architectureFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-output-integrity-'));
  const worker=join(dir,'worker.cjs');writeFileSync(worker,workerSource);chmodSync(worker,0o755);
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const buildPlan=async(_plan,{outDir})=>{
    const bytes='ISO-10303-21;\n/* identical geometry fixture */\nEND-ISO-10303-21;\n';
    writeFileSync(join(outDir,'model.ifc'),bytes);
    return {hasIfc:true,ifcSha256:sha(bytes)};
  };
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'fixture'},store,execute:async()=>({answer:'fixture',sources:[],ui:[]}),
    architecture:{stateDir:dir,buildPlan,worker,pipelineVersion:'output-fixture-1',deadlineSeconds:10,killGraceMs:50}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const api=async(path,method='GET',body)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,
      headers:{authorization:'Bearer fixture','x-acres-account':account,'content-type':'application/json'},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {response,body:await response.json()};
  };
  const {body:conversation}=await api('/conversations','POST',{});
  const projectId=conversation.projectId;
  const jobs=server.architectureJobs;
  const terminal=jobId=>new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);store.projectFeed.off(projectId,check);if(error)reject(error);};
    const check=()=>{
      const row=jobs.row(jobId);
      if(!['succeeded','failed','cancelled'].includes(row.status))return;
      finish();resolve(jobs.get(account,projectId,jobId));
    };
    const timer=setTimeout(()=>finish(new Error('Fixture worker did not reach a terminal event.')),12000);
    store.projectFeed.on(projectId,check);check();
  });
  // Revisions are saved through the store, not the editor's PUT route, which also queues a render:
  // every job in these checks is one the test starts itself.
  const save=(parentRevision,name=plan.name)=>jobs.architecture.save(account,projectId,{parentRevision,plan:{...plan,name},by:'user'},jobs.view);
  const create=(settings={},revision=1)=>api(`/projects/${projectId}/architecture/jobs`,'POST',{revision,settings});
  const close=async()=>{
    assert.equal(jobs.active.size,0,'every fixture worker must finish before cleanup');
    jobs.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});
  };
  t.after(close);
  await save(null);
  return {dir,store,server,api,projectId,jobs,terminal,save,create};
}
