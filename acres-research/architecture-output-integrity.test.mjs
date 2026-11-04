import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {architectureFixture,outputNames,outputKinds,sha} from './testing/architecture-outputs.mjs';
import {architectureView,jobStatus} from '../app-starter/public/core-model.js';

async function failed(f,settings,reason) {
  const created=await f.create(settings);
  assert.equal(created.response.status,202,JSON.stringify(created.body));
  const job=await f.terminal(created.body.id);
  assert.equal(job.status,'failed',JSON.stringify(job));
  assert.match(job.reason,reason);
  assert.deepEqual(job.artifacts,[]);
  assert.equal(f.store.query('SELECT artifact_id FROM architecture_artifacts WHERE job_id=?',job.id).length,0);
  assert.equal(f.jobs.active.size,0);
  const summary=await f.api(`/projects/${f.projectId}/architecture`);
  const view=architectureView(f.projectId,summary.body);
  assert.equal(view.viewer,null);
  assert.equal(jobStatus(job,1).failed,true);
  return job;
}

test('architecture publishes a complete successfully verified output set and reuses healthy work',async t=>{
  const f=await architectureFixture(t);
  const created=await f.create();
  const job=await f.terminal(created.body.id);
  assert.equal(job.status,'succeeded',job.reason);
  assert.deepEqual(job.artifacts.map(a=>a.kind).sort(),[...outputKinds,'verification'].sort());
  for(const artifact of job.artifacts) {
    const row=f.jobs.architecture.artifactRow(f.projectId,artifact.id);
    const bytes=readFileSync(row.path);
    assert.ok(bytes.length>0);assert.equal(artifact.bytes,bytes.length);assert.equal(artifact.sha256,sha(bytes));
  }
  const retry=await f.create();
  assert.equal(retry.response.status,200);assert.equal(retry.body.id,job.id);assert.equal(retry.body.reused,true);
});

test('architecture requires an explicit succeeded verification report before publication',async t=>{
  const f=await architectureFixture(t);
  for(const settings of [{status:'unknown'},{status:'passed'},{status:'missing'},{nullVerification:true},{status:'failed'}]) {
    await failed(f,settings,/verification|verify|succeed/i);
  }
});

test('architecture missing outputs fail atomically and cannot be reused as completed work',async t=>{
  const f=await architectureFixture(t);
  for(const name of ['verification.json',...outputNames]) {
    const job=await failed(f,{omit:name},/missing|produce|verification/i);
    const retry=await f.create({omit:name});
    assert.equal(retry.response.status,202);assert.notEqual(retry.body.id,job.id);
    await f.terminal(retry.body.id);
  }
});

test('architecture empty outputs cannot form a successful job',async t=>{
  const f=await architectureFixture(t);
  for(const name of ['verification.json',...outputNames]) await failed(f,{empty:name},/empty|verification/i);
});

test('architecture requires worker hashes to match the published output bytes',async t=>{
  const f=await architectureFixture(t);
  for(const settings of [{noHashes:true},...outputKinds.map(wrongHash=>({wrongHash})),{tamper:'model.glb'}]) {
    await failed(f,settings,/hash|checksum/i);
  }
});

test('architecture nonzero worker exit overrides an otherwise successful verification report',async t=>{
  const f=await architectureFixture(t);
  await failed(f,{exitCode:7},/code 7|exit/i);
});

test('architecture retries rebuild cached jobs with missing, changed or invalid verified outputs',async t=>{
  const f=await architectureFixture(t);
  const mutations={
    missing:dir=>unlinkSync(join(dir,'model.glb')),
    changed:dir=>{const path=join(dir,'model.glb');writeFileSync(path,'X'.repeat(readFileSync(path).length));},
    report:dir=>writeFileSync(join(dir,'verification.json'),JSON.stringify({status:'unknown'})),
    changedReportAndModel:dir=>{
      const model=join(dir,'model.glb'),report=join(dir,'verification.json');
      const bytes='X'.repeat(readFileSync(model).length);writeFileSync(model,bytes);
      const verification=JSON.parse(readFileSync(report,'utf8'));verification.hashes.glbSha256=sha(bytes);
      writeFileSync(report,JSON.stringify(verification));
    },
  };
  for(const [variant,mutate] of Object.entries(mutations)) {
    const settings={variant};
    const first=await f.create(settings),old=await f.terminal(first.body.id);
    assert.equal(old.status,'succeeded',old.reason);
    mutate(join(f.jobs.row(old.id).job_dir,'output'));
    const retry=await f.create(settings);
    assert.equal(retry.response.status,202,JSON.stringify(retry.body));assert.notEqual(retry.body.id,old.id);
    assert.equal(f.jobs.row(old.id).status,'failed');
    assert.match(f.jobs.row(old.id).reason,/output|verification|hash|missing/i);
    const rebuilt=await f.terminal(retry.body.id);
    assert.equal(rebuilt.status,'succeeded',rebuilt.reason);
    assert.equal(rebuilt.artifacts.length,5);
    const again=await f.create(settings);assert.equal(again.body.id,rebuilt.id);assert.equal(again.body.reused,true);
  }
});

test('architecture invalid cross-revision cache cannot publish changed files as a new successful job',async t=>{
  const f=await architectureFixture(t);
  const first=await f.create(),old=await f.terminal(first.body.id);
  assert.equal(old.status,'succeeded',old.reason);
  const file=join(f.jobs.row(old.id).job_dir,'output','manifest.json');
  writeFileSync(file,'X'.repeat(readFileSync(file).length));
  await f.save(1,'Same geometry, second revision');
  const created=await f.create({},2);
  assert.equal(created.response.status,202,JSON.stringify(created.body));
  assert.notEqual(created.body.reused,true);
  const job=await f.terminal(created.body.id);
  assert.equal(job.status,'succeeded',job.reason);
  assert.ok(job.artifacts.every(a=>a.revision===2&&a.jobId===job.id));
  assert.equal(f.jobs.row(old.id).status,'failed');
});

test('architecture healthy cross-revision reuse retains verified bytes and revision-bound artifacts',async t=>{
  const f=await architectureFixture(t);
  const first=await f.create(),old=await f.terminal(first.body.id);
  assert.equal(old.status,'succeeded',old.reason);
  await f.save(1,'Same geometry, second revision');
  const created=await f.create({},2);
  assert.equal(created.response.status,200,JSON.stringify(created.body));
  assert.equal(created.body.reused,true);assert.equal(created.body.status,'succeeded');assert.notEqual(created.body.id,old.id);
  assert.equal(f.jobs.row(created.body.id).job_dir,f.jobs.row(old.id).job_dir);
  assert.equal(f.jobs.active.size,0);
  assert.ok(created.body.artifacts.every(a=>a.revision===2&&a.jobId===created.body.id));
  assert.deepEqual(created.body.artifacts.map(a=>[a.kind,a.sha256]),old.artifacts.map(a=>[a.kind,a.sha256]));
});
