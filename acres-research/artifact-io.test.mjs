import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyFile,assertVerifiedFile} from './artifact-io.mjs';
import {architectureFixture} from './testing/architecture-outputs.mjs';

test('large artifact hashes yield to the event loop and reject replacement, oversized and symlink files',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'artifact-io-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'large.bin'),bytes=Buffer.alloc(16*1024*1024,23);writeFileSync(path,bytes);
  let heartbeat=false;setImmediate(()=>{heartbeat=true;});
  const file=await verifyFile(path,bytes.length);assert.equal(heartbeat,true);
  assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(file.bytes,bytes.length);
  assertVerifiedFile(path,file);writeFileSync(path,Buffer.alloc(bytes.length,24));assert.throws(()=>assertVerifiedFile(path,file),/changed/);
  await assert.rejects(verifyFile(path,1),/size limit/);
  symlinkSync(path,join(dir,'link'));await assert.rejects(verifyFile(join(dir,'link'),bytes.length));
});
test('aborted artifact verification never produces publication metadata',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'artifact-cancel-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'file');writeFileSync(path,Buffer.alloc(16*1024*1024));
  const controller=new AbortController(),pending=verifyFile(path,32*1024*1024,{signal:controller.signal});
  setImmediate(()=>controller.abort());await assert.rejects(pending,{name:'AbortError'});
});
test('cancel while verifying worker outputs retains the slot and publishes no artifacts',async t=>{
  const f=await architectureFixture(t),original=f.jobs.architecture.prepare.bind(f.jobs.architecture);
  let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.jobs.architecture.prepare=async(...args)=>{if(args[1].some(file=>file[1]==='glb')){entered();await gate;}return original(...args);};
  const {body:job}=await f.create();await started;assert.equal(f.jobs.active.size,1);
  const cancelled=await f.api(`/projects/${f.projectId}/architecture/jobs/${job.id}/cancel`,'POST',{});assert.equal(cancelled.response.status,200);
  release();const result=await f.terminal(job.id);assert.equal(result.status,'cancelled');assert.deepEqual(result.artifacts,[]);
  assert.equal(f.store.query('SELECT * FROM architecture_artifacts WHERE job_id=?',job.id).length,0);
});
test('file replacement between hashing and publication cannot publish a partial artifact set',async t=>{
  const f=await architectureFixture(t),original=f.jobs.architecture.prepare.bind(f.jobs.architecture);
  f.jobs.architecture.prepare=async(...args)=>{
    const files=await original(...args);
    if(args[1].some(file=>file[1]==='glb')){const path=join(args[0],'model.glb'),bytes=readFileSync(path);bytes[0]^=1;writeFileSync(path,bytes);}
    return files;
  };
  const {body:job}=await f.create(),result=await f.terminal(job.id);assert.equal(result.status,'failed');assert.match(result.reason,/changed/);
  assert.deepEqual(result.artifacts,[]);assert.equal(f.store.query('SELECT * FROM architecture_artifacts WHERE job_id=?',job.id).length,0);
});
test('simultaneous healthy reuse requests for a new revision publish one reusable job',async t=>{
  const f=await architectureFixture(t),{body:first}=await f.create();assert.equal((await f.terminal(first.id)).status,'succeeded');
  await f.save(1,'Second revision');const [a,b]=await Promise.all([f.create({},2),f.create({},2)]);
  assert.equal(a.body.id,b.body.id);assert.equal(a.body.reused,true);assert.equal(a.body.artifacts.length,5);
});

test('shutdown cancels a worker group and preserves an unstarted architecture job',async t=>{
  const f=await architectureFixture(t),worker=join(f.dir,'worker.cjs');
  writeFileSync(worker,readFileSync(worker,'utf8')+"\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n");
  let entered;const started=new Promise(resolve=>entered=resolve),prepare=f.jobs.prepareWorker.bind(f.jobs);
  f.jobs.prepareWorker=async(...args)=>{await prepare(...args);entered();};
  const {body:first}=await f.create();await started;
  const pid=f.jobs.active.get(first.id).child.pid;
  const {body:queued}=await f.create({fixture:'queued'});
  await f.server.drain({graceMs:15,cleanupMs:1000});
  assert.equal(f.jobs.row(first.id).status,'cancelled');assert.equal(f.jobs.row(queued.id).status,'queued');assert.equal(f.jobs.active.size,0);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('shutdown during output verification prevents artifact publication',async t=>{
  const f=await architectureFixture(t),prepare=f.jobs.architecture.prepare.bind(f.jobs.architecture);let entered;
  const started=new Promise(resolve=>entered=resolve);
  f.jobs.architecture.prepare=async(...args)=>{
    if(args[1].some(file=>file[1]==='glb')){entered();await new Promise(resolve=>args[2].signal.addEventListener('abort',resolve,{once:true}));}
    return prepare(...args);
  };
  const {body:job}=await f.create();await started;await f.server.drain({graceMs:15,cleanupMs:1000});
  assert.equal(f.jobs.row(job.id).status,'cancelled');assert.equal(f.store.query('SELECT * FROM architecture_artifacts WHERE job_id=?',job.id).length,0);
});
