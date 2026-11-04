import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,chmodSync,truncateSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ChatStore} from './store.mjs';
import {createResearchServer,architectureOptions} from './service.mjs';
import {buildArchitectureRevision} from './planning.mjs';
import {validatePlan,PLAN_MAX_BYTES,IFC_MAX_BYTES} from './architecture-artifacts.mjs';
import {createArchitectureTools} from './architecture-tools.mjs';
import {describe,fullGraph,dependents} from './project-state.mjs';

const alice='a'.repeat(24),bob='b'.repeat(24),carol='c'.repeat(24);
const sha=data=>createHash('sha256').update(data).digest('hex');

// A plan in the acres.architecture.plan/1 shape: one storey, one wall with a door, one room.
const plan=(southEnd=10)=>({schema:'acres.architecture.plan/1',name:'Two-bedroom sample',units:'m',
  levels:[{id:'L1',name:'Ground',elevation:0,height:2.8}],
  walls:[{id:'south',levelId:'L1',start:[0,0],end:[southEnd,0],thickness:0.18,height:2.8,material:'gypsum',roomIds:['living']},{id:'east',levelId:'L1',start:[southEnd,0],end:[southEnd,8],thickness:0.18,height:2.8}],
  openings:[{id:'entry',wallId:'south',kind:'door',offset:4.55,width:0.9,sill:0,height:2.1,swing:'in-left'}],
  rooms:[{id:'living',levelId:'L1',name:'Living',polygon:[[0,0],[7,0],[7,4],[0,4]],netAreaMethod:'interior-face'}],
  objects:[],sources:[{kind:'svg',ref:'sample-floorplan.svg',calibration:{pointA:[0,0],pointB:[10,0],distanceMetres:10}}]});

// Stands in for the geometry lane: writes the per-revision files into outDir and returns the contract.
const buildPlan=async(doc,{outDir})=>{
  const ifc=`ISO-10303-21;\n/* ${doc.id} r${doc.revision} south ${JSON.stringify(doc.walls[0].end)} */\nEND-ISO-10303-21;\n`;
  writeFileSync(join(outDir,'model.ifc'),ifc);
  writeFileSync(join(outDir,'plan.svg'),`<svg xmlns="http://www.w3.org/2000/svg"><title>r${doc.revision}</title></svg>`);
  writeFileSync(join(outDir,'pascal-scene.json'),JSON.stringify({revision:doc.revision}));
  writeFileSync(join(outDir,'idmap.json'),JSON.stringify({walls:{south:'GUID-south'}}));
  return {id:doc.id,revision:doc.revision,hasIfc:true,ifcPath:join(outDir,'model.ifc'),ifcSha256:sha(ifc),ifcBytes:Buffer.byteLength(ifc),
    svgPath:join(outDir,'plan.svg'),pascalScenePath:join(outDir,'pascal-scene.json'),idMapPath:join(outDir,'idmap.json')};
};

// A fake Blender/Bonsai worker. settings.mode picks its behaviour; it records its own pid and its
// child's pid so the tests can prove the whole process group is gone.
const WORKER=`#!/usr/bin/env node
const {readFileSync,writeFileSync,symlinkSync,renameSync}=require('node:fs');
const {join}=require('node:path');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const dir=process.argv[process.argv.indexOf('--job')+1];
const job=JSON.parse(readFileSync(join(dir,'job.json'),'utf8'));
const out=join(dir,'output');
const ifc=job.kind==='render'?'':readFileSync(join(dir,'input','model.ifc'),'utf8');
const mode=job.settings.mode||'ok';
const recordPids=child=>{
  writeFileSync(join(dir,'pids.tmp'),JSON.stringify({worker:process.pid,child:child.pid}));
  renameSync(join(dir,'pids.tmp'),join(dir,'pids.json'));
};
// A render job: two stills hashed under their artifact kinds, like render_job.py via the supervisor.
if(job.kind==='render'){
  const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const scene=readFileSync(join(dir,'input','scene.json'));
  const stills={street:Buffer.concat([png,Buffer.from('street'),scene]),aerial:Buffer.concat([png,Buffer.from('aerial'),scene])};
  for(const [view,bytes] of Object.entries(stills))writeFileSync(join(out,view+'.png'),bytes);
  const hashes=Object.fromEntries(Object.entries(stills).map(([view,bytes])=>['render-'+view+'Sha256',createHash('sha256').update(bytes).digest('hex')]));
  writeFileSync(join(out,'verification.json'),JSON.stringify(job.settings.render.samples===1?{status:'failed',reason:'Blender render phase exited with exit code 1'}:{status:'succeeded',kind:'render',hashes}));
  process.exit(job.settings.render.samples===1?1:0);
}
// Like worker/architecture_worker.py: settings.preview.{width,height} are required integers.
if(!job.settings.preview||![job.settings.preview.width,job.settings.preview.height].every(v=>Number.isInteger(v)&&v>=16&&v<=2048)){
  writeFileSync(join(out,'verification.json'),JSON.stringify({status:'failed',reason:"KeyError: 'preview'"}));
  process.exit(1);
}
if(mode==='graceful'||mode==='stubborn'){
  // graceful: cleans up and records why on SIGTERM; stubborn: ignores SIGTERM, so only SIGKILL stops it.
  const child=spawn('sleep',['60'],{stdio:'ignore'});
  recordPids(child);
  process.on('SIGTERM',()=>{
    if(mode==='stubborn')return writeFileSync(join(dir,'sigterm.txt'),'ignored');
    child.kill('SIGKILL');
    writeFileSync(join(out,'verification.json'),JSON.stringify({status:'failed',reason:'cancelled by SIGTERM'}));
    process.exit(143);
  });
  setInterval(()=>{},1000);
} else if(mode==='hang'){
  const child=spawn('sleep',['60'],{stdio:'ignore'});
  recordPids(child);
  setInterval(()=>{},1000);
} else if(mode==='unit-refused'){
  // bin/architecture-worker-unit when polkit refuses the unit: systemctl's error, no report.
  console.error('Failed to start acres-architecture-worker@x.service: Interactive authentication required.');
  process.exit(1);
} else if(mode==='fail'){
  writeFileSync(join(out,'verification.json'),JSON.stringify({status:'failed',reason:'Bonsai could not import the IFC.'}));
  process.exit(3);
} else {
  writeFileSync(join(out,'model.blend'),'BLENDER'+ifc);
  writeFileSync(join(out,'preview.png'),Buffer.from([0x89,0x50,0x4e,0x47]));
  if(mode==='symlink')symlinkSync('/etc/hosts',join(out,'model.glb'));
  else writeFileSync(join(out,'model.glb'),'glTF'+ifc);
  writeFileSync(join(out,'manifest.json'),JSON.stringify({rooms:{living:'living'}}));
  const hashes=Object.fromEntries([['blend','BLENDER'+ifc],['preview',Buffer.from([0x89,0x50,0x4e,0x47])],['glb','glTF'+ifc],['manifest',JSON.stringify({rooms:{living:'living'}})]].map(([kind,bytes])=>[kind+'Sha256',createHash('sha256').update(bytes).digest('hex')]));
  writeFileSync(join(out,'verification.json'),JSON.stringify({status:'succeeded',hashes,bonsai:{imported:true},elements:{walls:2},jobId:job.jobId,revision:job.revision,deadlineSeconds:job.deadlineSeconds,env:Object.keys(process.env)}));
}
`;

function setup(t,{deadlineSeconds=30,killGraceMs=10000,planningDir}={}){
  const dir=mkdtempSync(join(tmpdir(),'acres-arch-'));
  const worker=join(dir,'fake-worker.js');writeFileSync(worker,WORKER);chmodSync(worker,0o755);
  const stateDir=join(dir,'state');
  const path=join(dir,'chat.sqlite');
  const ctx={dir,stateDir,worker,path,servers:[]};
  ctx.open=async(build=buildPlan,execute=async()=>({answer:'x',sources:[],ui:[]}),options={})=>{
    const store=new ChatStore(path);
    const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test',...options.secrets},store,execute,wallet:options.wallet,visualFetch:options.visualFetch,
      architecture:{stateDir,buildPlan:build,worker,pipelineVersion:'test-1',deadlineSeconds,killGraceMs,planningDir}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const api=(path,method='GET',body,account=alice,headers={})=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':account,'content-type':'application/json',...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
    const instance={store,server,api,close:async()=>{server.architectureJobs?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
    ctx.servers.push(instance);return instance;
  };
  t.after(async()=>{for(const s of ctx.servers)if(s.server.listening)await s.close();rmSync(dir,{recursive:true,force:true});});
  return ctx;
}
const json=async response=>({status:response.status,body:await response.json()});
const project=async api=>(await (await api('/conversations','POST',{})).json());
test('visual tools are restricted to authorized Modeling projects',async t=>{
  const f=setup(t),{api}=await f.open();
  const model=await (await api('/projects','POST',{workflow:'modeling',address:'123 Main Street'})).json();
  const site=await project(api);
  for(const operation of ['visual-segment','visual-illustrate']){
    assert.equal((await api(`/projects/${model.id}/architecture/${operation}`,'POST',{},bob)).status,404);
    assert.equal((await api(`/projects/${site.projectId}/architecture/${operation}`,'POST',{})).status,404);
  }
  assert.equal((await api(`/projects/${model.id}/architecture/visual-segment`,'POST',{})).status,400);
  assert.equal((await api(`/projects/${model.id}/architecture/visual-illustrate`,'POST',{conceptId:'missing',conceptVersion:1})).status,409);
});

test('visual tools do not bypass enabled billing',async t=>{
  const f=setup(t),{store,api}=await f.open(buildPlan,async()=>({}),{secrets:{BILLING_ENABLED:true},wallet:{}});
  const model=store.createModel(alice,'123 Main Street','Housing');
  const response=await api(`/projects/${model.id}/architecture/visual-segment`,'POST',{});
  assert.equal(response.status,503);
});

test('billed image requests require the quoted rate and settle only after the provider succeeds',async t=>{
  const f=setup(t),calls=[];
  const wallet={reserve:async(...args)=>calls.push(['reserve',...args]),dispatch:async()=>calls.push(['dispatch']),settle:async(_owner,_key,amount)=>calls.push(['settle',amount]),pending:async()=>calls.push(['pending']),releaseBeforeAttempt:async()=>calls.push(['release'])};
  const rate={mode:'estimated_call',version:'test-1',basis:'test rate',reserveMicros:5000,amountMicros:2500};
  const visualFetch=async()=>new Response('data: {"type":"response.output_text.done","item_id":"m1","output_index":0,"content_index":0,"text":""}\n\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n');
  const {store,api}=await f.open(buildPlan,async()=>({}),{secrets:{BILLING_ENABLED:true,MODEL_API_KEY:'test',BILLING_RATES:{meta_visual_segment:rate}},wallet,visualFetch});
  const model=store.createModel(alice,'123 Main Street','Housing');
  const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const url=`/projects/${model.id}/architecture/visual-segment`,input={photo,subject:'building'};
  assert.equal((await api(url,'POST',input)).status,409);assert.equal(calls.length,0);
  assert.equal((await api(url,'POST',{...input,pricing:{version:rate.version,amountMicros:rate.amountMicros,reserveMicros:rate.reserveMicros}})).status,200);
  assert.deepEqual(calls.map(call=>call[0]),['reserve','dispatch','settle']);assert.equal(calls[0][1],alice);assert.equal(calls[2][1],2500);
});

test('a billed image provider failure leaves the reservation pending',async t=>{
  const f=setup(t),calls=[];
  const wallet={reserve:async()=>calls.push('reserve'),dispatch:async()=>calls.push('dispatch'),pending:async()=>calls.push('pending'),releaseBeforeAttempt:async()=>calls.push('release')};
  const rate={mode:'estimated_call',version:'test-1',basis:'test rate',reserveMicros:5000,amountMicros:2500};
  const {store,api}=await f.open(buildPlan,async()=>({}),{secrets:{BILLING_ENABLED:true,MODEL_API_KEY:'test',BILLING_RATES:{meta_visual_segment:rate}},wallet,visualFetch:async()=>new Response('',{status:503})});
  const model=store.createModel(alice,'123 Main Street','Housing');
  const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const response=await api(`/projects/${model.id}/architecture/visual-segment`,'POST',{photo,subject:'building',pricing:{version:rate.version,amountMicros:rate.amountMicros,reserveMicros:rate.reserveMicros}});
  assert.equal(response.status,502);assert.deepEqual(calls,['reserve','dispatch','pending']);
});

test('an authorized Modeling photo request does not modify the project',async t=>{
  const f=setup(t);let sent;
  const visualFetch=async(_url,init)=>{sent=JSON.parse(init.body);return new Response('data: {"type":"response.output_text.done","item_id":"m1","output_index":0,"content_index":0,"text":""}\n\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n');};
  const {store,api}=await f.open(buildPlan,async()=>({}),{secrets:{MODEL_API_KEY:'test-key'},visualFetch});
  const model=store.createModel(alice,'123 Main Street','Housing'),before=store.projectView(alice,model.id);
  const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const result=await json(await api(`/projects/${model.id}/architecture/visual-segment`,'POST',{photo,subject:'building'}));
  assert.equal(result.status,200);assert.deepEqual(result.body.masks,[]);assert.equal(sent.model,'sam-3.1');
  assert.deepEqual(store.projectView(alice,model.id),before);
});

test('illustration uses the current concept and leaves project state unchanged',async t=>{
  const f=setup(t),png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const visualFetch=async()=>Response.json({data:[{b64_json:png.split(',')[1]}]});
  const {store,api}=await f.open(buildPlan,async()=>({}),{secrets:{MODEL_API_KEY:'test-key'},visualFetch});
  const model=store.createModel(alice,'123 Main Street','Housing');
  store.project.write(model.id,{concepts:{value:[{id:'concept-1',version:1}],provenance:{tool:'user'}}});
  const before=store.projectView(alice,model.id);
  const input={photo:png,modelImage:png,goal:'adu',conceptId:'concept-1',conceptVersion:1};
  assert.equal((await api(`/projects/${model.id}/architecture/visual-illustrate`,'POST',{...input,conceptVersion:2})).status,409);
  const result=await json(await api(`/projects/${model.id}/architecture/visual-illustrate`,'POST',input));
  assert.equal(result.status,200);assert.equal(result.body.image,png);
  assert.deepEqual(store.projectView(alice,model.id),before);
});
test('Modeling creates and saves an authenticated plan before any parcel research or underwriting',async t=>{
  const f=setup(t),{api,store}=await f.open();
  assert.equal((await api('/projects','POST',{workflow:'modeling',title:' '})).status,400);
  const created=await json(await api('/projects','POST',{workflow:'modeling',address:'1234 Fulton Street',title:'Independent design'}));
  assert.equal(created.status,201);assert.equal(created.body.fields.property.value.address,'1234 Fulton Street');assert.equal(created.body.workflow,'modeling');
  const id=created.body.id;
  assert.equal((await api(`/projects/${id}/state`,'GET',undefined,bob)).status,404);
  assert.equal((await api(`/projects/${id}/name`,'PATCH',{version:created.body.version,title:' '},alice)).status,400);
  assert.equal((await api(`/projects/${id}/name`,'PATCH',{version:created.body.version,title:'Other'},bob)).status,404);
  const renamed=await json(await api(`/projects/${id}/name`,'PATCH',{version:created.body.version,title:'Existing conditions'}));
  assert.equal(renamed.status,200);assert.equal(renamed.body.title,'Existing conditions');
  assert.equal((await api(`/projects/${id}/name`,'PATCH',{version:created.body.version,title:'Outdated'})).status,409);
  const saved=await json(await api(`/projects/${id}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(saved.status,201);assert.equal(saved.body.revision,1);
  const state=store.projectView(alice,id);
  for(const field of ['program','market','proFormas','comparisons'])assert.equal(state.fields[field].value,null,field);
  assert.equal(store.query('SELECT * FROM runs').length,0,'saving a model does not start research or underwriting');
  assert.equal((await api('/projects?modelsOnly=true&sitesOnly=true')).status,400);
});
async function until(read,done,ms=8000){
  const end=Date.now()+ms;
  for(;;){const value=await read();if(done(value))return value;if(Date.now()>end)throw new Error('Timed out waiting: '+JSON.stringify(value));await sleep(50);}
}
const jobOf=(api,projectId,jobId,account=alice)=>api(`/projects/${projectId}/architecture/jobs/${jobId}`,'GET',undefined,account).then(r=>r.json());
const finished=(api,projectId,jobId)=>until(()=>jobOf(api,projectId,jobId),j=>['succeeded','failed','cancelled'].includes(j.status));
const gone=pid=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
const groupGone=pgid=>{try{process.kill(-pgid,0);return false;}catch(e){return e.code==='ESRCH';}};

test('validatePlan accepts the v1 document and rejects malformed ones with bounded messages',()=>{
  const ok=validatePlan(plan());
  assert.equal(ok.schema,'acres.architecture.plan/1');assert.equal(ok.walls.length,2);
  const bad=[
    [{...plan(),schema:'acres.architecture.plan/2'},/schema/],
    [{...plan(),units:'ft'},/units/],
    [{...plan(),name:''},/name/],
    [{...plan(),walls:'nope'},/walls/],
    [{...plan(),walls:[{levelId:'L1'}]},/walls\[0\]\.id/],
    [{...plan(),walls:[...plan().walls,{...plan().walls[0]}]},/duplicate/i],
    [{...plan(),openings:[{id:'x',wallId:'missing'}]},/openings\[0\]\.wallId/],
    [{...plan(),walls:[{...plan().walls[0],roomIds:['nowhere']}]},/roomIds/],
    [{...plan(),sources:['drawing.svg']},/sources\[0\]/],
    [{...plan(),rooms:[{id:'r',levelId:'L9'}]},/rooms\[0\]\.levelId/],
    [{...plan(),levels:[]},/level/],
    [[],/object/],
  ];
  for(const [doc,message] of bad)assert.throws(()=>validatePlan(doc),e=>e.status===400&&message.test(e.message)&&e.message.length<300,JSON.stringify(message));
  assert.equal(PLAN_MAX_BYTES,2*1024*1024);assert.equal(IFC_MAX_BYTES,50*1024*1024);
});

test('architecture is a project-state node that downstream staleness and the deck summary can see',()=>{
  assert.deepEqual(fullGraph.architecture.dependsOn,['property']);
  assert.ok(dependents(['property'],fullGraph).includes('architecture'));
  const summary=describe({architecture:{value:{planId:'p',revision:3,name:'Sample',artifacts:{ifc:{id:'i',sha256:'x'}}},updated:Date.now(),stale:null}});
  assert.deepEqual({planId:summary.architecture.planId,revision:summary.architecture.revision,name:summary.architecture.name},{planId:'p',revision:3,name:'Sample'});
});

test('plan revisions: optimistic concurrency, stored documents, a project-state node and exact reopen',{timeout:20000},async t=>{
  const ctx=setup(t);
  let {store,api,close}=await ctx.open();
  const c=await project(api);const pid=c.projectId;
  const empty=await json(await api(`/projects/${pid}/architecture`));
  assert.equal(empty.status,200);assert.equal(empty.body.current,null);assert.deepEqual(empty.body.revisions,[]);

  const first=await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(first.status,201);
  assert.equal(first.body.revision,1);assert.equal(first.body.parentRevision,null);assert.match(first.body.planId,/^[0-9a-f-]{36}$/);
  assert.equal(first.body.plan.id,first.body.planId);assert.equal(first.body.plan.revision,1);
  assert.match(first.body.inputHash,/^[0-9a-f]{64}$/);
  assert.deepEqual(first.body.artifacts.map(a=>a.kind).sort(),['idmap','ifc','pascal-scene','plan','svg']);
  assert.ok(first.body.artifacts.every(a=>a.revision===1&&a.jobId===null&&/^[0-9a-f]{64}$/.test(a.sha256)));
  const planDir=join(ctx.stateDir,'architecture','plans',first.body.planId,'1');
  assert.deepEqual(readdirSync(planDir).sort(),['idmap.json','model.ifc','pascal-scene.json','plan.json','plan.svg']);
  assert.equal(JSON.parse(readFileSync(join(planDir,'plan.json'),'utf8')).revision,1);

  const stale=await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(stale.status,409);assert.equal(stale.body.revision,1);
  const ancient=await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:7,plan:plan()}));
  assert.equal(ancient.status,409);

  // Revision B moves the south/east corner; its artifacts replace A's as current.
  const second=await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:1,plan:plan(11)}));
  assert.equal(second.status,201);assert.equal(second.body.revision,2);assert.equal(second.body.parentRevision,1);
  assert.equal(second.body.planId,first.body.planId);
  const state=(await json(await api(`/projects/${pid}/state`))).body;
  assert.equal(state.fields.architecture.value.revision,2);assert.equal(state.fields.architecture.value.planId,first.body.planId);
  assert.equal(state.fields.architecture.provenance.account,alice);assert.equal(state.fields.architecture.provenance.revision,2);
  const ifcB=second.body.artifacts.find(a=>a.kind==='ifc'),ifcA=first.body.artifacts.find(a=>a.kind==='ifc');
  assert.equal(state.fields.architecture.value.artifacts.ifc.id,ifcB.id);
  assert.notEqual(ifcA.sha256,ifcB.sha256);
  const events=store.projectEvents(pid).filter(e=>e.event==='state.updated'&&e.keys.includes('architecture'));
  assert.equal(events.length,2);

  const summary=(await json(await api(`/projects/${pid}/architecture`))).body;
  assert.equal(summary.current.revision,2);
  assert.ok(summary.current.artifacts.every(a=>a.revision===2),'revision A artifacts are never presented as current');
  assert.deepEqual(summary.revisions.map(r=>[r.revision,r.parentRevision]),[[2,1],[1,null]]);

  // Reopening (a new store and server on the same database) restores the exact revisions.
  await close();
  ({api,close}=await ctx.open());
  const reopened=(await json(await api(`/projects/${pid}/architecture`))).body;
  assert.equal(reopened.current.revision,2);assert.deepEqual(reopened.current.plan.walls[0].end,[11,0]);
  const oldRev=await json(await api(`/projects/${pid}/architecture/revisions/1`));
  assert.equal(oldRev.status,200);assert.equal(oldRev.body.current,false);assert.deepEqual(oldRev.body.plan.walls[0].end,[10,0]);
  assert.equal(oldRev.body.artifacts.find(a=>a.kind==='ifc').sha256,ifcA.sha256);
  const download=await api(`/projects/${pid}/architecture/artifacts/${ifcA.id}`);
  assert.equal(download.headers.get('x-architecture-revision'),'1');
  assert.match(await download.text(),/\[10,0\]/);
  assert.equal((await api(`/projects/${pid}/architecture/revisions/9`)).status,404);
  assert.equal((await api(`/projects/${pid}/architecture/revisions/abc`)).status,404);
});

test('plan saves: viewers are refused, malformed and oversize documents and failed builds are bounded',{timeout:20000},async t=>{
  const ctx=setup(t);
  const {store,api}=await ctx.open();
  const c=await project(api);const pid=c.projectId;
  store.grantMember(alice,c.id,'account',bob,'viewer');
  assert.equal((await api(`/projects/${pid}/architecture`,'GET',undefined,bob)).status,200);
  assert.equal((await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()},bob)).status,403);
  const malformed=await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:{...plan(),openings:[{id:'o',wallId:'ghost'}]}}));
  assert.equal(malformed.status,400);assert.match(malformed.body.error,/openings\[0\]\.wallId/);
  assert.equal((await api(`/projects/${pid}/architecture/plan`,'PUT','{not json')).status,400);
  const big={parentRevision:null,plan:{...plan(),objects:[{id:'blob',note:'x'.repeat(PLAN_MAX_BYTES)}]}};
  const oversize=await json(await api(`/projects/${pid}/architecture/plan`,'PUT',big));
  assert.equal(oversize.status,413);assert.ok(oversize.body.error.length<200);
  assert.equal((await json(await api(`/projects/${pid}/architecture`))).body.current,null);

  // The geometry lane rejects invalid geometry with a 400; anything else is a bounded 502. Neither leaves a revision.
  const ctx2=setup(t);
  const geometry=await ctx2.open(async()=>{throw Object.assign(new Error('Opening entry overlaps opening window.'),{status:400,validationErrors:[{code:'opening_overlap',id:'entry',message:'Opening entry overlaps opening window.'},...Array.from({length:80},(_,i)=>({code:'x',id:'w'+i,message:'m'.repeat(1000)}))]});});
  const p2=(await project(geometry.api)).projectId;
  const rejected=await json(await geometry.api(`/projects/${p2}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(rejected.status,400);assert.match(rejected.body.error,/overlaps/);
  assert.deepEqual(rejected.body.validationErrors[0],{code:'opening_overlap',id:'entry',message:'Opening entry overlaps opening window.'});
  assert.equal(rejected.body.validationErrors.length,50);assert.ok(rejected.body.validationErrors.every(v=>v.message.length<=300));
  const ctx3=setup(t);
  const broken=await ctx3.open(async()=>{throw new Error('python exploded at /secret/path');});
  const p3=(await project(broken.api)).projectId;
  const failed=await json(await broken.api(`/projects/${p3}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(failed.status,502);assert.doesNotMatch(failed.body.error,/secret/);
  assert.equal((await json(await broken.api(`/projects/${p3}/architecture`))).body.current,null);
  assert.deepEqual(readdirSync(join(ctx3.stateDir,'architecture','plans')).flatMap(d=>readdirSync(join(ctx3.stateDir,'architecture','plans',d))),[],'a failed build leaves no revision directory');

  // A generated IFC over 50 MB is refused rather than stored.
  const ctx4=setup(t);
  const huge=await ctx4.open(async(doc,opts)=>{const r=await buildPlan(doc,opts);truncateSync(r.ifcPath,IFC_MAX_BYTES+1);return {...r,ifcSha256:undefined,ifcBytes:IFC_MAX_BYTES+1};});
  const p4=(await project(huge.api)).projectId;
  const tooBig=await json(await huge.api(`/projects/${p4}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(tooBig.status,413);assert.match(tooBig.body.error,/50 MB/);
});

test('jobs: a detached worker produces artifacts bound to the revision, completed jobs are reused, events stream',{timeout:30000},async t=>{
  const ctx=setup(t);
  const {store,api}=await ctx.open();
  const pid=(await project(api)).projectId;
  const rev=(await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}))).body;
  const created=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'ok',quality:'draft'}}));
  assert.equal(created.status,202);
  assert.equal(created.body.revision,1);assert.ok(['queued','running'].includes(created.body.status));
  assert.equal(created.body.inputHash,rev.artifacts.find(a=>a.kind==='ifc').sha256);
  assert.equal(created.body.pipelineVersion,'test-1');assert.match(created.body.settingsHash,/^[0-9a-f]{64}$/);
  assert.equal(created.body.jobDir,undefined);assert.equal(created.body.pid,undefined);
  const job=await finished(api,pid,created.body.id);
  assert.equal(job.status,'succeeded',job.reason);
  assert.deepEqual(job.artifacts.map(a=>a.kind).sort(),['blend','glb','manifest','preview','verification']);
  assert.ok(job.artifacts.every(a=>a.revision===1&&a.jobId===job.id));
  const jobDir=join(ctx.stateDir,'architecture','jobs',job.id);
  assert.equal(readFileSync(join(jobDir,'input','model.ifc'),'utf8'),readFileSync(join(ctx.stateDir,'architecture','plans',rev.planId,'1','model.ifc'),'utf8'));
  const jobFile=JSON.parse(readFileSync(join(jobDir,'job.json'),'utf8'));
  assert.deepEqual(jobFile,{jobId:job.id,projectId:pid,planId:rev.planId,revision:1,settings:{mode:'ok',quality:'draft',preview:{width:1280,height:720}},deadlineSeconds:30});
  const verification=JSON.parse(readFileSync(join(jobDir,'output','verification.json'),'utf8'));
  assert.ok(!verification.env.includes('RESEARCH_TOKEN')&&!verification.env.some(k=>/SECRET|TOKEN|KEY/.test(k)),'the worker gets no service credentials');

  // The GLB streams with its content type and an ETag of its sha256; a matching If-None-Match is a 304.
  const glb=job.artifacts.find(a=>a.kind==='glb');
  const download=await api(`/projects/${pid}/architecture/artifacts/${glb.id}`);
  assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'model/gltf-binary');
  assert.equal(download.headers.get('etag'),`"${glb.sha256}"`);
  const bytes=Buffer.from(await download.arrayBuffer());assert.equal(sha(bytes),glb.sha256);assert.equal(bytes.length,glb.bytes);
  assert.equal((await api(`/projects/${pid}/architecture/artifacts/${glb.id}`,'GET',undefined,alice,{'if-none-match':`"${glb.sha256}"`})).status,304);
  const svg=rev.artifacts.find(a=>a.kind==='svg');
  const svgDownload=await api(`/projects/${pid}/architecture/artifacts/${svg.id}`);
  assert.equal(svgDownload.headers.get('content-type'),'image/svg+xml');
  assert.match(svgDownload.headers.get('content-security-policy')||'',/default-src 'none'/);

  // The same input, pipeline and settings reuse the completed job; other settings make a new one.
  const again=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{quality:'draft',mode:'ok'}}));
  assert.equal(again.status,200);assert.equal(again.body.id,job.id);assert.equal(again.body.reused,true);
  const summary=(await json(await api(`/projects/${pid}/architecture`))).body;
  assert.deepEqual(summary.current.jobs.map(j=>j.id).sort(),[rev.jobs[0].id,job.id].sort(),'the save\'s own render and the draft one');
  assert.ok(summary.current.artifacts.some(a=>a.kind==='glb'&&a.id===glb.id));

  const statuses=store.projectEvents(pid).filter(e=>e.event==='architecture.job'&&e.jobId===job.id).map(e=>e.status);
  assert.deepEqual(statuses,['queued','running','succeeded']);

  // Revision B: its job is new, and none of A's artifacts become B's.
  await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:1,plan:plan(12)});
  const jobB=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:2,settings:{mode:'ok',quality:'draft'}}));
  assert.equal(jobB.status,202);assert.notEqual(jobB.body.id,job.id);
  const doneB=await finished(api,pid,jobB.body.id);
  assert.equal(doneB.status,'succeeded');
  const current=(await json(await api(`/projects/${pid}/architecture`))).body.current;
  assert.equal(current.revision,2);assert.ok(current.artifacts.every(a=>a.revision===2));
  assert.match(await (await api(`/projects/${pid}/architecture/artifacts/${current.artifacts.find(a=>a.kind==='glb').id}`)).text(),/\[12,0\]/);
});

test('an editor save queues exactly one walkthrough render, and saves still succeed with rendering off',{timeout:30000},async t=>{
  const ctx=setup(t);
  const {store,api}=await ctx.open();
  const pid=(await project(api)).projectId;
  const first=await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(first.status,201);
  assert.equal(first.body.jobs.length,1);assert.equal(first.body.jobs[0].revision,1);assert.ok(['queued','running'].includes(first.body.jobs[0].status));
  assert.equal((await finished(api,pid,first.body.jobs[0].id)).status,'succeeded');
  const second=(await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:1,plan:plan(12)}))).body;
  assert.equal(second.jobs.length,1);await finished(api,pid,second.jobs[0].id);
  assert.deepEqual(store.query('SELECT revision FROM architecture_jobs WHERE project=? ORDER BY revision',pid).map(r=>r.revision),[1,2],'one render per saved revision');
  const dir=mkdtempSync(join(tmpdir(),'acres-arch-off-')),offStore=new ChatStore(join(dir,'chat.sqlite'));
  const off=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store:offStore,execute:async()=>({answer:'x',sources:[]}),architecture:{stateDir:join(dir,'state'),buildPlan,worker:null,pipelineVersion:'test-1'}});
  await new Promise(resolve=>off.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{off.architectureJobs?.close();off.closeAllConnections();await new Promise(resolve=>off.close(resolve));offStore.close();rmSync(dir,{recursive:true,force:true});});
  const offApi=(path,method='GET',body)=>fetch(`http://127.0.0.1:${off.address().port}${path}`,{method,headers:{authorization:'Bearer test','x-acres-account':alice,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const offProject=(await (await offApi('/conversations','POST',{})).json()).projectId;
  const unrendered=await json(await offApi(`/projects/${offProject}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}));
  assert.equal(unrendered.status,201);assert.deepEqual(unrendered.body.jobs,[]);
});

test('jobs: a failed worker reports its reason, and symlinked outputs fail without being served',{timeout:30000},async t=>{
  const ctx=setup(t);
  const {api}=await ctx.open();
  const pid=(await project(api)).projectId;
  await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()});
  const failed=await finished(api,pid,(await (await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'fail'}})).json()).id);
  assert.equal(failed.status,'failed');assert.equal(failed.reason,'Bonsai could not import the IFC.');assert.deepEqual(failed.artifacts,[]);
  // A worker that exits without a report (systemd refused its unit) fails with what it printed.
  const refused=await finished(api,pid,(await (await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'unit-refused'}})).json()).id);
  assert.equal(refused.status,'failed');assert.equal(refused.reason,'The worker exited 1 without a verification report: Failed to start acres-architecture-worker@x.service: Interactive authentication required.');
  const linked=await finished(api,pid,(await (await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'symlink'}})).json()).id);
  assert.equal(linked.status,'failed');assert.match(linked.reason,/model\.glb is not a regular file/);assert.deepEqual(linked.artifacts,[]);
  // A failed job is never reused: the same request runs again.
  const retry=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'fail'}}));
  assert.equal(retry.status,202);assert.notEqual(retry.body.id,failed.id);
  await finished(api,pid,retry.body.id);
  // Bounded input errors.
  assert.equal((await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:5,settings:{}})).status,404);
  assert.equal((await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:'1; rm -rf /',settings:{}})).status,400);
  assert.equal((await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:'fast'})).status,400);
  assert.equal((await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{blob:'x'.repeat(20000)}})).status,400);
  assert.equal((await api(`/projects/${pid}/architecture/jobs/..%2F..%2Fetc`)).status,404);
  assert.equal((await api(`/projects/${pid}/architecture/artifacts/..%2Fplans`)).status,404);
});

test('jobs: timeout and cancel kill the whole process group, and a later job still succeeds',{timeout:30000},async t=>{
  const ctx=setup(t,{deadlineSeconds:1});
  const {api}=await ctx.open();
  const pid=(await project(api)).projectId;
  await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()});
  const pids=async jobId=>until(()=>{const f=join(ctx.stateDir,'architecture','jobs',jobId,'pids.json');return existsSync(f)?JSON.parse(readFileSync(f,'utf8')):null;},Boolean);

  const slow=(await (await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'hang'}})).json());
  const slowPids=await pids(slow.id);
  const timedOut=await finished(api,pid,slow.id);
  assert.equal(timedOut.status,'failed');assert.match(timedOut.reason,/deadline/);
  await until(()=>gone(slowPids.worker)&&gone(slowPids.child)&&groupGone(slowPids.worker),Boolean,5000);

  const ctx2=setup(t,{deadlineSeconds:60});
  const second=await ctx2.open();
  const p2=(await project(second.api)).projectId;
  await second.api(`/projects/${p2}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()});
  const hanging=await (await second.api(`/projects/${p2}/architecture/jobs`,'POST',{revision:1,settings:{mode:'hang'}})).json();
  // One job runs at a time: a second request waits in the queue and can be cancelled there.
  const waiting=await (await second.api(`/projects/${p2}/architecture/jobs`,'POST',{revision:1,settings:{mode:'ok'}})).json();
  const hangPids=await until(()=>{const f=join(ctx2.stateDir,'architecture','jobs',hanging.id,'pids.json');return existsSync(f)?JSON.parse(readFileSync(f,'utf8')):null;},Boolean);
  assert.equal((await jobOf(second.api,p2,waiting.id)).status,'queued');
  const cancelledQueued=await json(await second.api(`/projects/${p2}/architecture/jobs/${waiting.id}/cancel`,'POST',{}));
  assert.equal(cancelledQueued.body.status,'cancelled');
  const cancel=await json(await second.api(`/projects/${p2}/architecture/jobs/${hanging.id}/cancel`,'POST',{}));
  assert.equal(cancel.status,200);
  const cancelled=await finished(second.api,p2,hanging.id);
  assert.equal(cancelled.status,'cancelled');
  await until(()=>gone(hangPids.worker)&&gone(hangPids.child)&&groupGone(hangPids.worker),Boolean,5000);
  assert.equal((await second.api(`/projects/${p2}/architecture/jobs/${hanging.id}/cancel`,'POST',{})).status,409);
  const later=await finished(second.api,p2,(await (await second.api(`/projects/${p2}/architecture/jobs`,'POST',{revision:1,settings:{mode:'ok'}})).json()).id);
  assert.equal(later.status,'succeeded');
});

test('jobs: stopping a worker sends SIGTERM first, then SIGKILL after the grace period',{timeout:30000},async t=>{
  const ctx=setup(t,{deadlineSeconds:60,killGraceMs:700});
  const {api}=await ctx.open();
  const pid=(await project(api)).projectId;
  await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()});
  const pidsOf=jobId=>until(()=>{const f=join(ctx.stateDir,'architecture','jobs',jobId,'pids.json');return existsSync(f)?JSON.parse(readFileSync(f,'utf8')):null;},Boolean);
  // A worker that handles SIGTERM gets to clean up and record why before it exits.
  const graceful=await (await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'graceful'}})).json();
  const gracefulPids=await pidsOf(graceful.id);
  await api(`/projects/${pid}/architecture/jobs/${graceful.id}/cancel`,'POST',{});
  const cancelled=await finished(api,pid,graceful.id);
  assert.equal(cancelled.status,'cancelled');
  assert.equal(JSON.parse(readFileSync(join(ctx.stateDir,'architecture','jobs',graceful.id,'output','verification.json'),'utf8')).reason,'cancelled by SIGTERM');
  await until(()=>gone(gracefulPids.worker)&&gone(gracefulPids.child),Boolean,5000);
  // A worker that ignores SIGTERM is still killed, group and all, once the grace period ends.
  const stubborn=await (await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'stubborn'}})).json();
  const stubbornPids=await pidsOf(stubborn.id);
  const started=Date.now();
  await api(`/projects/${pid}/architecture/jobs/${stubborn.id}/cancel`,'POST',{});
  await until(()=>existsSync(join(ctx.stateDir,'architecture','jobs',stubborn.id,'sigterm.txt')),Boolean,3000);
  assert.equal(gone(stubbornPids.worker),false,'SIGTERM alone does not stop it');
  assert.equal((await finished(api,pid,stubborn.id)).status,'cancelled');
  assert.ok(Date.now()-started>=600,'SIGKILL waits for the grace period');
  await until(()=>gone(stubbornPids.worker)&&gone(stubbornPids.child)&&groupGone(stubbornPids.worker),Boolean,5000);
});

test('jobs: settings get the worker\'s preview defaults before hashing, so explicit defaults reuse the job',{timeout:30000},async t=>{
  const ctx=setup(t);
  const {api}=await ctx.open();
  const pid=(await project(api)).projectId;
  const saved=(await json(await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}))).body;
  const jobFile=id=>JSON.parse(readFileSync(join(ctx.stateDir,'architecture','jobs',id,'job.json'),'utf8'));
  // The save queued the default render, so asking for it with empty settings reuses that job.
  const bare=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{}}));
  assert.equal(bare.status,200);assert.equal(bare.body.id,saved.jobs[0].id);
  const done=await finished(api,pid,bare.body.id);
  assert.equal(done.status,'succeeded',done.reason);
  assert.deepEqual(jobFile(done.id).settings,{preview:{width:1280,height:720}});
  const omitted=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1}));
  assert.equal(omitted.status,200);assert.equal(omitted.body.id,done.id);
  const explicit=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{preview:{width:1280,height:720}}}));
  assert.equal(explicit.status,200);assert.equal(explicit.body.id,done.id);assert.equal(explicit.body.settingsHash,bare.body.settingsHash);
  const narrow=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{preview:{width:640}}}));
  assert.equal(narrow.status,202);
  await finished(api,pid,narrow.body.id);
  assert.deepEqual(jobFile(narrow.body.id).settings.preview,{width:640,height:720});
  for(const preview of [{width:0},{width:4096},{height:'720'},{width:12.5},'large',[1280,720]]){
    const refused=await json(await api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{preview}}));
    assert.equal(refused.status,400,JSON.stringify(preview));assert.match(refused.body.error,/preview/);
  }
});

test('plan builds receive the configured planning directory, from secrets before the environment',{timeout:20000},async t=>{
  const seen=[];
  const ctx=setup(t,{planningDir:'/srv/acres/planning'});
  const {api}=await ctx.open(async(doc,options)=>{seen.push(options.planningDir);return buildPlan(doc,options);});
  const pid=(await project(api)).projectId;
  assert.equal((await api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()})).status,201);
  assert.deepEqual(seen,['/srv/acres/planning']);

  const on={ACRES_ARCHITECTURE_ENABLED:'true',ACRES_PLANNING_DIR:'/env/planning',ACRES_ARCHITECTURE_WORKER:'/opt/w'};
  assert.equal(architectureOptions({},{}),null,'off unless enabled');
  const configured=architectureOptions({ACRES_PLANNING_DIR:'/secret/planning'},on);
  assert.equal(configured.planningDir,'/secret/planning');
  assert.equal(configured.buildPlan,buildArchitectureRevision);
  assert.equal(configured.worker,'/opt/w');
  assert.equal(architectureOptions({},on).planningDir,'/env/planning');
});

test('restart: a job running when the service stopped is marked interrupted, its group is killed, queued jobs resume',{timeout:30000},async t=>{
  const ctx=setup(t,{deadlineSeconds:60});
  let instance=await ctx.open();
  const pid=(await project(instance.api)).projectId;
  await instance.api(`/projects/${pid}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()});
  const running=await (await instance.api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'hang'}})).json();
  const queued=await (await instance.api(`/projects/${pid}/architecture/jobs`,'POST',{revision:1,settings:{mode:'ok'}})).json();
  const pids=await until(()=>{const f=join(ctx.stateDir,'architecture','jobs',running.id,'pids.json');return existsSync(f)?JSON.parse(readFileSync(f,'utf8')):null;},Boolean);
  // Simulate a crash: the service goes away without touching its worker.
  await instance.close();
  assert.equal(gone(pids.worker),false,'the detached worker outlives the service');
  instance=await ctx.open();
  const interrupted=await jobOf(instance.api,pid,running.id);
  assert.equal(interrupted.status,'failed');assert.match(interrupted.reason,/restarted/);
  await until(()=>gone(pids.worker)&&gone(pids.child)&&groupGone(pids.worker),Boolean,5000);
  const resumed=await finished(instance.api,pid,queued.id);
  assert.equal(resumed.status,'succeeded');
  assert.ok(instance.store.projectEvents(pid).some(e=>e.event==='architecture.job'&&e.jobId===running.id&&e.status==='failed'));
});

test('isolation: another account cannot reach a project\'s plan, revisions, jobs or artifacts by guessing IDs',{timeout:30000},async t=>{
  const ctx=setup(t);
  const {api}=await ctx.open();
  const mine=(await project(api)).projectId;
  const theirs=(await project((p,m,b,a=carol,h)=>api(p,m,b,a,h))).projectId;
  const rev=(await json(await api(`/projects/${mine}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()}))).body;
  const job=await finished(api,mine,(await (await api(`/projects/${mine}/architecture/jobs`,'POST',{revision:1,settings:{mode:'ok'}})).json()).id);
  const artifact=job.artifacts.find(a=>a.kind==='glb'),ifc=rev.artifacts.find(a=>a.kind==='ifc');
  const asCarol=(path,method='GET',body)=>api(path,method,body,carol);
  for(const [path,method,body] of [
    [`/projects/${mine}/architecture`,'GET'],
    [`/projects/${mine}/architecture/revisions/1`,'GET'],
    [`/projects/${mine}/architecture/plan`,'PUT',{parentRevision:1,plan:plan()}],
    [`/projects/${mine}/architecture/jobs`,'POST',{revision:1,settings:{mode:'ok'}}],
    [`/projects/${mine}/architecture/jobs/${job.id}`,'GET'],
    [`/projects/${mine}/architecture/jobs/${job.id}/cancel`,'POST',{}],
    [`/projects/${mine}/architecture/artifacts/${artifact.id}`,'GET'],
    // Carol's own project does not open Alice's job or artifacts either.
    [`/projects/${theirs}/architecture/jobs/${job.id}`,'GET'],
    [`/projects/${theirs}/architecture/jobs/${job.id}/cancel`,'POST',{}],
    [`/projects/${theirs}/architecture/artifacts/${artifact.id}`,'GET'],
    [`/projects/${theirs}/architecture/artifacts/${ifc.id}`,'GET'],
  ]){
    const response=await asCarol(path,method,body);
    assert.equal(response.status,404,`${method} ${path}`);
    assert.doesNotMatch(await response.text(),/glTF|ISO-10303/);
  }
  // Carol's project gets its own job, which reuses nothing from Alice's.
  await asCarol(`/projects/${theirs}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()});
  const carolJob=await json(await asCarol(`/projects/${theirs}/architecture/jobs`,'POST',{revision:1,settings:{mode:'ok'}}));
  assert.equal(carolJob.status,202);assert.notEqual(carolJob.body.id,job.id);
  await finished((p,m,b)=>asCarol(p,m,b),theirs,carolJob.body.id);
  // Without a configured worker, jobs are disabled and nothing runs.
  const off=setup(t);
  const store=new ChatStore(off.path);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({}),architecture:{stateDir:off.stateDir,buildPlan,worker:null,pipelineVersion:'x'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(p,m='GET',b)=>fetch(base+p,{method:m,headers:{authorization:'Bearer test','x-acres-account':alice,'content-type':'application/json'},...(b?{body:JSON.stringify(b)}:{})});
  const p=(await (await call('/conversations','POST',{})).json()).projectId;
  await call(`/projects/${p}/architecture/plan`,'PUT',{parentRevision:null,plan:plan()});
  assert.equal((await call(`/projects/${p}/architecture/jobs`,'POST',{revision:1,settings:{}})).status,503);
  assert.equal(existsSync(join(off.stateDir,'architecture','jobs')),false);
});

test('agent-first: an agent save queues the job through the service and its finished products are served',async t=>{
  const ctx=setup(t);
  let seen;
  const {store,api}=await ctx.open(buildPlan,async input=>{seen=input.architecture;return {answer:'x',sources:[],ui:[]};});
  store.touchPerson(alice,'alice@example.com');
  const conversation=await (await api('/conversations','POST',{})).json();
  const run=await (await api(`/conversations/${conversation.id}/runs`,'POST',{message:'Draw the plan'})).json();
  await until(async()=>(await (await api(`/runs/${run.id}`)).json()).status,s=>['completed','failed'].includes(s));
  assert.ok(seen,'the run carries plan access');
  const tools=createArchitectureTools({plans:seen});
  const saved=await tools.handlers.acres_save_plan({parentRevision:0,name:'Unit 4B',draft:{units:'ft',rooms:[{name:'Living',x:0,y:0,width:15,depth:12},{name:'Bedroom',x:15,y:0,width:10,depth:12}]}});
  assert.equal(saved.saved,true);
  assert.equal(saved.walkthrough.status,'queued','the save itself queued the finished products, no button press');
  const job=await finished((p,m,b)=>api(p,m,b),conversation.projectId,saved.walkthrough.jobId);
  assert.equal(job.status,'succeeded');
  assert.deepEqual(job.artifacts.map(a=>a.kind).sort(),['blend','glb','manifest','preview','verification']);
  const read=tools.handlers.acres_read_plan({});
  assert.equal(read.walkthrough.status,'succeeded');
  assert.deepEqual(read.walkthrough.outputs.map(o=>o.kind).sort(),['blend','glb','manifest','preview','verification']);
  const preview=job.artifacts.find(a=>a.kind==='preview');
  const response=await api(`/projects/${conversation.projectId}/architecture/artifacts/${preview.id}`);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual([...Buffer.from(await response.arrayBuffer())],[0x89,0x50,0x4e,0x47]);
  const again=await tools.handlers.acres_render_plan({revision:1});
  assert.equal(again.walkthrough.jobId,job.id,'re-rendering a finished revision reuses its products');
  assert.match(again.note,/ready/i);
});

// A site with three schemes over a zoning envelope (feet), as the schemes route and the envelope tool save them.
function seedSchemes(store,projectId){
  const box=(w,d)=>[[0,0],[w,0],[w,d],[0,d]];
  const envelope={lot:{polygon:box(50,100),streets:[{side:'front',widthFeet:60}]},storeys:Array.from({length:6},(_,i)=>({footprint:box(50,80),heightFeet:10,floorElevationFeet:i*10,use:i?'residential':'retail'}))};
  const program=(storeys,grossSqft)=>({key:'standard',exit:'rental',zfa:grossSqft*0.9,grossSqft,storeys,units:20,unitMix:null,affordableZfa:0,taxProgram:null});
  const schemes=[{id:'as_of_right',label:'As of right',program:program(5,15000)},{id:'max_bonus',label:'Most floor area',program:program(6,20000)},{id:'alternative',label:'Alternative',program:null}]
    .map(s=>({...s,summary:'',best:false,note:null,candidateId:null,returns:null,massing:null,plan:null,budget:null,render:null}));
  store.project.write(projectId,{property:{value:{bbl:'3001230045',address:'1 Sample St'},provenance:{tool:'acres_set_subject',sources:[]}},
    envelope:{value:envelope,provenance:{tool:'acres_zoning_envelope',sources:[]}}});
  store.project.write(projectId,{schemes:{value:{schemes,basis:null},provenance:{tool:'schemes',sources:[]}}});
}

test('scheme renders: a render job draws one scheme, fills its render part, serves the stills and is reused',{timeout:30000},async t=>{
  const ctx=setup(t);
  const {api,store}=await ctx.open();
  const pid=(await project(api)).projectId;
  seedSchemes(store,pid);
  const render=scheme=>api(`/projects/${pid}/schemes/${scheme}/render`,'POST',{});
  const queued=await json(await render('max_bonus'));
  assert.equal(queued.status,202);assert.equal(queued.body.status,'queued');assert.deepEqual(queued.body.views,[]);
  const done=await finished(api,pid,queued.body.jobId);
  assert.equal(done.status,'succeeded',done.reason);
  assert.deepEqual([done.kind,done.scheme,done.revision],['render','max_bonus',0]);
  assert.deepEqual(done.artifacts.map(a=>a.kind).sort(),['render-aerial','render-street','verification']);
  const jobDir=join(ctx.stateDir,'architecture','jobs',done.id);
  const jobFile=JSON.parse(readFileSync(join(jobDir,'job.json'),'utf8'));
  assert.deepEqual([jobFile.kind,jobFile.scheme,jobFile.settings],['render','max_bonus',{render:{width:1280,height:800,samples:24}}]);
  const scene=JSON.parse(readFileSync(join(jobDir,'input','scene.json'),'utf8'));
  assert.equal(scene.volumes.length,6);assert.equal(scene.volumes[0].use,'retail');assert.equal(scene.floorAreaSqft,20000);
  // The scheme's render part followed the job to its finished stills.
  const part=store.schemesView(pid).schemes.find(s=>s.id==='max_bonus').render;
  assert.equal(part.status,'succeeded');assert.equal(part.jobId,done.id);
  assert.deepEqual(part.views.map(v=>v.view),['street','aerial']);
  assert.equal(part.artifactId,part.views[0].artifactId);assert.equal(part.url,`/api/projects/${pid}/architecture/artifacts/${part.artifactId}`);
  const image=await api(part.url.replace('/api',''));
  assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  assert.match(image.headers.get('content-disposition'),/^inline; filename="render-street-r0\.png"$/);
  // The same scene and settings reuse the finished render; the other scheme is untouched.
  const again=await json(await render('max_bonus'));
  assert.equal(again.status,202);assert.equal(again.body.jobId,done.id);assert.equal(again.body.status,'succeeded');
  assert.equal(store.schemesView(pid).schemes.find(s=>s.id==='as_of_right').render,null);
  // Events say which kind of job changed, for alerts.
  const events=store.query("SELECT data FROM project_events WHERE project=? AND event='architecture.job'",pid).map(r=>JSON.parse(r.data));
  assert.ok(events.length>=3&&events.every(e=>e.kind==='render'&&e.scheme==='max_bonus'));
  // An option with no building, an unknown option and another account are refused.
  assert.equal((await render('alternative')).status,409);
  assert.equal((await render('tallest')).status,404);
  assert.equal((await api(`/projects/${pid}/schemes/as_of_right/render`,'POST',{},bob)).status,404);
});

test('scheme renders: a failed render leaves a failed part, and a finished render of an earlier request never overwrites a newer one',{timeout:30000},async t=>{
  const ctx=setup(t);
  const {api,store,server}=await ctx.open();
  const pid=(await project(api)).projectId;
  seedSchemes(store,pid);
  const jobs=server.architectureJobs;
  const scene=JSON.parse(JSON.stringify((await import('./render-scene.mjs')).renderScene({scheme:{id:'as_of_right',label:'As of right',program:{storeys:2,grossSqft:4000}},envelope:store.project.read(pid).envelope.value})));
  const failing=await jobs.create(alice,pid,{kind:'render',scheme:'as_of_right',scene,settings:{render:{samples:1}}});
  const failed=await finished(api,pid,failing.id);
  assert.equal(failed.status,'failed');assert.match(failed.reason,/exit code 1/);
  assert.equal(store.schemesView(pid).schemes[0].render.status,'failed');
  // A newer request names its own job; the older one finishing leaves the part alone.
  const newer=await json(await api(`/projects/${pid}/schemes/as_of_right/render`,'POST',{}));
  const older=await jobs.create(alice,pid,{kind:'render',scheme:'as_of_right',scene,settings:{render:{samples:2}}});
  await finished(api,pid,newer.body.jobId);await finished(api,pid,older.id);
  assert.equal(store.schemesView(pid).schemes[0].render.jobId,newer.body.jobId);
  // Render settings are bounded before a job is queued.
  for(const render of [{width:100},{samples:65},{height:'800'}])await assert.rejects(jobs.create(alice,pid,{kind:'render',scheme:'as_of_right',scene,settings:{render}}),e=>e.status===400);
  await assert.rejects(jobs.create(alice,pid,{kind:'render',scheme:'as_of_right',scene:{...scene,volumes:[]}}),e=>e.status===409);
});
