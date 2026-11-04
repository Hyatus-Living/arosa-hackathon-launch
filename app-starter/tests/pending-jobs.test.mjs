import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createJobs,jobLine,jobTitle} from '../public/jobs.js';
import {siteSummary} from '../public/listing-card.js';

const job={id:'run-1',status:'running',created:Date.UTC(2026,9,19,12),conversationId:'c1',projectId:'p1',title:'Underwrite 6 Chatham Sq, MN in C6-1G, listed at $4,000,000',bbl:'1001620041',progress:{done:1,next:2},step:2};

test('a job names its site and says which step it is on and for how long',()=>{
  assert.equal(jobTitle(job),'6 Chatham Sq, MN');
  assert.equal(jobTitle({...job,title:'6 CHATHAM SQUARE'}),'6 Chatham Square');
  assert.equal(jobLine(job,job.created+3*60000),'Step 2 of 4 · 3 min');
  assert.equal(jobLine({...job,status:'queued',waitingFor:'slot',queueAhead:0},job.created+20000),'Waiting for a slot · under a minute');
  assert.equal(jobLine({...job,status:'queued',waitingFor:'slot',queueAhead:2},job.created+3*60000),'Waiting for a slot, 2 ahead · 3 min');
  assert.equal(jobLine({...job,status:'queued',waitingFor:'run',queueAhead:0},job.created+60000),'After your earlier request · 1 min');
  assert.equal(jobLine({...job,step:null},job.created+75*60000),'Researching · 1 h 15 min');
  // With a measured estimate, a running job says how long is left, and only elapsed time once it runs long.
  const timed={...job,status:'running',startedAt:job.created,typicalMs:7*60000};
  assert.equal(jobLine(timed,job.created+3*60000),'Step 2 of 4 · about 4 min left');
  assert.equal(jobLine(timed,job.created+6.5*60000),'Step 2 of 4 · finishing up');
  assert.equal(jobLine(timed,job.created+12*60000),'Step 2 of 4 · 12 min');
});

test('the rail keeps running jobs in view and turns an ended one into a link to its result',async t=>{
  const original={document:globalThis.document,window:globalThis.window};
  const {document,window}=parseHTML('<html><body><section class="rail-jobs" hidden><div class="rail-jobs-list"></div></section></body></html>');
  Object.assign(globalThis,{document,window});
  t.after(()=>Object.assign(globalThis,original));
  const root=document.querySelector('.rail-jobs'),opened=[],notes=[];
  let active=[job],changes=0;
  const jobs=createJobs({root,load:async()=>active,status:async()=>({status:'completed'}),open:j=>opened.push(j.projectId),notify:text=>notes.push(text),onChange:()=>changes++});
  t.after(()=>jobs.stop());
  await jobs.refresh();
  assert.equal(root.hidden,false);assert.equal(jobs.forProject('p1').conversationId,'c1');
  active=[{...job,step:3}];await jobs.refresh();
  assert.match(root.querySelector('.rail-job.is-running').textContent,/Step 3 of 4/);
  active=[job];await jobs.refresh();
  assert.match(root.querySelector('.rail-job.is-running').textContent,/6 Chatham Sq, MN.*Step 2 of 4/);
  active=[];
  await jobs.refresh();
  assert.deepEqual(notes,['Research finished for 6 Chatham Sq, MN.']);assert.equal(changes,4);assert.equal(jobs.forProject('p1'),null);
  const done=root.querySelector('.rail-job.is-done');
  assert.match(done.textContent,/Finished · Open/);
  done.click();
  assert.deepEqual(opened,['p1']);assert.equal(root.hidden,true);
});

test('a listing whose site is being underwritten says so instead of a date',()=>{
  assert.equal(siteSummary({id:'p1',running:job.created,updated:job.created,progress:{done:1,next:2}}),'Underwriting now, step 2 of 4');
  assert.equal(siteSummary({id:'p1',running:job.created,updated:job.created,progress:{done:4,next:null}}),'Underwriting now');
  assert.equal(siteSummary({id:'p1',running:job.created,updated:job.created,step:3,progress:{done:0,next:1}}),'Underwriting now, step 3 of 4');
});

test('a job that finished while the page was closed shows as ended, and opening it dismisses it on this browser',async t=>{
  const original={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage};
  const {document,window}=parseHTML('<html><body><section class="rail-jobs" hidden><div class="rail-jobs-list"></div></section></body></html>');
  const store=new Map();
  Object.assign(globalThis,{document,window,localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)}});
  t.after(()=>Object.assign(globalThis,original));
  const root=document.querySelector('.rail-jobs'),opened=[],notes=[];
  const listed=[{...job,status:'completed',endedAt:Date.now()-60000}];
  const jobs=createJobs({root,load:async()=>listed,status:async()=>{throw new Error('an ended job needs no status call');},open:j=>opened.push(j.projectId),notify:text=>notes.push(text)});
  t.after(()=>jobs.stop());
  await jobs.refresh();
  const done=root.querySelector('.rail-job.is-done');
  assert.match(done.textContent,/6 Chatham Sq, MN.*Finished · Open/);
  assert.deepEqual(notes,[],'no toast for a job that ended before this page saw it run');
  assert.equal(jobs.forProject('p1'),null,'an ended job is not the site\'s running job');
  done.click();
  assert.deepEqual(opened,['p1']);
  await jobs.refresh();
  assert.equal(root.querySelector('.rail-job'),null,'the dismissed job stays gone');
});
