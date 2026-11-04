import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {Crm} from './crm.mjs';
import {CrmEnrichment,OutOfBalance,enrichmentPatch,identityFromVerdict,parseVerdict,identityCostMicros,nameMatches,dayStart,STEP_ESTIMATE_MICROS,LANES} from './crm-enrichment.mjs';

const lookup={at:'2026-10-21',profileUrl:'https://linkedin.com/in/pat-buyer',workEmail:'pat@firm.com',workEmailVerified:true,personalEmail:'pat@mail.com',personalEmailVerified:true,phone:'+12125550100',phoneLineType:'mobile'};
const verdict=(same,email='unknown')=>identityFromVerdict({same_person:same,buyer_company:'Firm LLC',buyer_role:'Principal',website:'firm.com',evidence:['Profile names the firm.'],lookup_email_is_buyers:email},{checked:'2026-10-21'});
const contact=(over={})=>({name:'Pat Buyer',status:'new',email:null,phone:null,company:null,title:null,profile_url:null,details:{lookup},...over});

test('a confirmed identity fills empty email, phone and profile from the lookups, preferring a verified work email',()=>{
  const patch=enrichmentPatch(contact({details:{lookup,identity:verdict('high','yes')}}));
  assert.deepEqual(patch,{email:'pat@firm.com',phone:'+12125550100',profile_url:'https://linkedin.com/in/pat-buyer',company:'Firm LLC',title:'Principal'});
  const unverifiedWork=enrichmentPatch(contact({details:{lookup:{...lookup,workEmailVerified:false},identity:verdict('high')}}));
  assert.equal(unverifiedWork.email,'pat@mail.com','a verified personal email beats an unverified work email');
});

test('a mismatch keeps the lookups as reference only, moves a new contact to researching and fills company and role',()=>{
  for(const identity of [verdict('low'),verdict('high','no'),verdict('medium','no')]){
    assert.equal(identity.verdict,'mismatch');
    assert.deepEqual(enrichmentPatch(contact({details:{lookup,identity}})),{company:'Firm LLC',title:'Principal',status:'researching'});
  }
  assert.equal(enrichmentPatch(contact({status:'replied',details:{lookup,identity:verdict('low')}})).status,undefined,'only a new contact changes status');
});

test('medium or unparsed verdicts and lookups without an identity check change nothing',()=>{
  assert.equal(verdict('medium').verdict,'needs_review');
  assert.deepEqual(enrichmentPatch(contact({details:{lookup,identity:verdict('medium')}})),{});
  const unknown=identityFromVerdict(null,{checked:'2026-10-21'});
  assert.equal(unknown.verdict,'needs_review');
  assert.deepEqual(enrichmentPatch(contact({details:{lookup,identity:unknown}})),{});
  assert.deepEqual(enrichmentPatch(contact()),{});
});

test('fields a person edited, or that already hold a value, are never overwritten',()=>{
  const patch=enrichmentPatch(contact({email:'own@choice.com',details:{lookup,identity:verdict('high'),edited:['phone','company','status']}}));
  assert.deepEqual(patch,{profile_url:'https://linkedin.com/in/pat-buyer',title:'Principal'});
  assert.equal(enrichmentPatch(contact({details:{lookup,identity:verdict('low'),edited:['status']}})).status,undefined);
});

test('the verdict JSON, name matches, cost estimate and day boundary are read exactly',()=>{
  assert.deepEqual(parseVerdict('Report...\n{"same_person": "high", "evidence": ["a", "b"], "lookup_email_is_buyers": "yes"}'),{same_person:'high',evidence:['a','b'],lookup_email_is_buyers:'yes'});
  assert.equal(parseVerdict('no verdict here'),null);
  assert.ok(nameMatches('Pat Q Buyer','Pat Buyer - Firm LLC'));
  assert.ok(!nameMatches('Pat Buyer','Patricia Smith'));
  assert.equal(identityCostMicros({total_input_tokens:374706,total_cached_tokens:56684,total_output_tokens:14631,total_thought_tokens:34592}),1238057);
  const noonEastern=Date.parse('2026-10-21T16:00:00Z');
  assert.equal(new Date(dayStart(noonEastern)).toISOString(),'2026-10-21T04:00:00.000Z');
});

// A fake lookup provider and identity provider that record what was called and when.
function fakes({balance=Infinity,searchPeople,holdUntil=0}={}){
  const calls=[];let running=0,maxRunning=0;
  const treg={async call(endpoint,body,options){
    calls.push({endpoint,body,key:options.key});running++;maxRunning=Math.max(maxRunning,running);
    await new Promise(resolve=>setTimeout(resolve,2));running--;
    if(calls.length>balance)throw new OutOfBalance('out');
    if(endpoint==='treg.people.search')return {output:{people:searchPeople??[{url:'https://www.linkedin.com/in/pat-buyer',entities:[{properties:{name:'Pat Buyer',location:'Brooklyn',workHistory:[{title:'Principal',company:{name:'Firm LLC'}}]}}]}]},servedBy:'search',charged:10000,error:null};
    if(endpoint==='treg.people.phone.find')return {output:{phone:'+12125550100',line_type:'mobile'},servedBy:'p',charged:30000,error:null};
    if(endpoint==='treg.people.email.find')return {output:{email:'pat@firm.com',verified:true},servedBy:'w',charged:20000,error:null};
    return {output:{email:'pat@mail.com',verified:true},servedBy:'m',charged:20000,error:null};
  },get calls(){return calls;},get maxRunning(){return maxRunning;}};
  const interactions=new Map();let active=0,maxActive=0;
  const research={
    async call(method,path,body){const id=`i${interactions.size+1}`;interactions.set(id,{polls:0,prompt:body.input});active++;maxActive=Math.max(maxActive,active);return {id,status:'in_progress'};},
    async get(id){const item=interactions.get(id);if(++item.polls<2||(interactions.size<holdUntil&&item.polls<2000))return {id,status:'in_progress'};if(!item.done){item.done=true;active--;}
      return {id,status:'completed',usage:{total_input_tokens:100000,total_cached_tokens:0,total_output_tokens:1000,total_thought_tokens:0},
        steps:[{type:'model_output',content:[{type:'text',text:'Done.\n{"same_person": "high", "buyer_company": "Firm LLC", "buyer_role": "Principal", "website": null, "professional_contact": null, "evidence": ["Same firm."], "lookup_email_is_buyers": "yes"}',annotations:[{type:'url_citation',url:'https://firm.com/team',title:'Team'}]}]}]};},
    async cancel(){},get interactions(){return interactions;},get maxActive(){return maxActive;}};
  return {treg,research};
}

function fixture(t,{secrets={},...options}={}){
  const dir=mkdtempSync(join(tmpdir(),'acres-crm-enrich-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const crm=new Crm(store);
  const make=(extra={})=>new CrmEnrichment({store,crm,secrets,pollMs:1,retryMs:1,...options,...extra});
  const enrichment=make();
  t.after(async()=>{await enrichment.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,crm,enrichment,make};
}
async function until(check,ms=3000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('timed out');await new Promise(r=>setTimeout(r,5));}}
const settledJobs=(e)=>e.status().jobs.every(j=>!['queued','running'].includes(j.status));

test('finding contact info searches for a profile first, records each charge, and leaves fields empty until identity is checked',async t=>{
  const f=fakes();const {crm,enrichment}=fixture(t,f);
  crm.import('buyers',[{name:'Pat Buyer',sourceRef:'BP1',borough:'Brooklyn'}],1);
  const [c]=crm.list().contacts;
  enrichment.request(c.id,'contacts','admin@witharosa.ai');
  await until(()=>settledJobs(enrichment));
  const jobs=enrichment.status().jobs;
  assert.deepEqual(jobs.map(j=>[j.step,j.status,j.costMicros]),[['profile','done',10000],['contacts','done',70000]]);
  const after=crm.get(c.id);
  assert.equal(after.candidates[0].name_match,true);
  assert.equal(after.details.lookup.workEmail,'pat@firm.com');
  assert.equal(after.email,null,'no identity check yet, so nothing is filled');
  enrichment.request(c.id,'identity','admin@witharosa.ai');
  await until(()=>settledJobs(enrichment));
  const done=crm.get(c.id);
  assert.equal(done.details.identity.verdict,'confirmed');
  assert.deepEqual(done.details.identity.sources,[{url:'https://firm.com/team',title:'Team'}]);
  assert.equal(done.email,'pat@firm.com');
  assert.equal(done.phone,'+12125550100');
  assert.equal(done.company,'Firm LLC');
  assert.match(f.research.interactions.get('i1').prompt,/work email domain firm\.com/);
  assert.equal(enrichment.status().jobs.find(j=>j.step==='identity').costMicros,212000);
});

test('enrich all queues every step at once and runs eight lookups and ten identity checks in parallel, skipping contacts with no profile',async t=>{
  const f=fakes({holdUntil:12});const {crm,enrichment}=fixture(t,f);
  crm.import('buyers',Array.from({length:12},(_,i)=>({name:`Pat Buyer`,sourceRef:`BP${i}`})),1);
  crm.import('others',[{name:'Sam Nobody',sourceRef:'X1'}],1);
  const plan=enrichment.plan();
  assert.equal(plan.contacts,13);
  assert.equal(plan.estimateMicros,13*(STEP_ESTIMATE_MICROS.profile+STEP_ESTIMATE_MICROS.contacts+STEP_ESTIMATE_MICROS.identity));
  const realCall=f.treg.call;
  f.treg.call=async(endpoint,body,options)=>endpoint==='treg.people.search'&&body.q.startsWith('Sam')?{output:{people:[]},charged:5000,error:null}:realCall(endpoint,body,options);
  const queued=enrichment.start(100,'admin@witharosa.ai');
  assert.equal(queued.jobs.length,13*3,'every step is queued before anything runs');
  await until(()=>settledJobs(enrichment),5000);
  const jobs=enrichment.status().jobs;
  assert.equal(jobs.filter(j=>j.status==='done').length,12*3+1);
  assert.deepEqual(jobs.filter(j=>j.status==='skipped').map(j=>j.step).sort(),['contacts','identity']);
  assert.equal(f.treg.maxRunning,LANES.lookup);
  assert.equal(f.research.maxActive,LANES.identity);
  assert.equal(enrichment.status().spend.run.active,0);
  assert.throws(()=>enrichment.start(100),{status:400},'nothing left to enrich');
});

test('a run stops at its spending limit and the day stops at the daily limit',async t=>{
  const f=fakes();const {crm,enrichment}=fixture(t,{...f,secrets:{CRM_ENRICH_DAILY_CAP_USD:1}});
  crm.import('buyers',[{name:'Pat Buyer',sourceRef:'A'},{name:'Pat Buyer',sourceRef:'B'}],1);
  enrichment.start(1,'admin@witharosa.ai');
  await until(()=>settledJobs(enrichment));
  const stopped=enrichment.status().jobs.filter(j=>j.status==='stopped');
  assert.ok(stopped.length>0);
  assert.ok(stopped.every(j=>/spending limit/.test(j.error)));
  const [c]=crm.list().contacts;
  assert.throws(()=>enrichment.request(c.id,'identity'),{status:429});
});

test('when the lookup balance runs out, the lookup and every queued lookup stop cleanly',async t=>{
  const f=fakes({balance:2});const {crm,enrichment}=fixture(t,f);
  crm.import('buyers',[{name:'Pat Buyer',sourceRef:'A'},{name:'Pat Buyer',sourceRef:'B'}],1);
  enrichment.start(100);
  await until(()=>settledJobs(enrichment));
  const jobs=enrichment.status().jobs;
  assert.ok(jobs.some(j=>j.status==='stopped'&&/balance ran out/.test(j.error)));
  assert.ok(f.treg.calls.length<=2+LANES.lookup,'only lookups already in flight are sent after the balance runs out');
  assert.equal(jobs.filter(j=>j.step!=='identity'&&j.status==='queued').length,0);
  assert.equal(f.research.interactions.size,0,'identity checks wait on the stopped lookups');
});

test('after a restart a lookup resumes with its request keys, an identity check reconnects, and an unstarted check fails cleanly',async t=>{
  const f=fakes();const {store,crm,enrichment,make}=fixture(t,{...f});
  crm.import('buyers',[{name:'Pat Buyer',sourceRef:'A',candidates:[{name:'Pat Buyer',url:'https://linkedin.com/in/pat',name_match:true}]},{name:'Pat Buyer',sourceRef:'B'},{name:'Pat Buyer',sourceRef:'C'}],1);
  const [a,b,c]=crm.list().contacts;
  await enrichment.close();
  const insert=(id,contact,step,state,provider)=>store.write("INSERT INTO crm_jobs(id,contact,step,status,provider_id,state,created,started) VALUES(?,?,?,'running',?,?,?,?)",id,contact,step,provider,JSON.stringify(state),Date.now(),Date.now());
  insert('j1',a.id,'contacts',{keys:{work:'k-work'},found:{}},null);
  insert('j2',b.id,'identity',{},'i-existing');
  insert('j3',c.id,'identity',{},null);
  f.research.interactions.set('i-existing',{polls:0,prompt:''});
  const next=make();t.after(()=>next.close());
  next.recover();
  await until(()=>settledJobs(next));
  const jobs=Object.fromEntries(next.status().jobs.map(j=>[j.id,j]));
  assert.equal(jobs.j1.status,'done');
  assert.equal(f.treg.calls.find(call=>call.endpoint==='treg.people.email.find').key,'k-work','the same request key is reused');
  assert.equal(jobs.j2.status,'done');
  assert.equal(crm.get(b.id).details.identity.verdict,'confirmed');
  assert.equal(jobs.j3.status,'failed');
  assert.match(jobs.j3.error,/restarted/);
});

test('a busy provider is retried with backoff: a rate-limited lookup and a rate-limited identity start both succeed',async t=>{
  const f=fakes();const {crm,enrichment}=fixture(t,f);
  crm.import('buyers',[{name:'Pat Buyer',sourceRef:'A',candidates:[{name:'Pat Buyer',url:'https://linkedin.com/in/pat',name_match:true}]}],1);
  const [c]=crm.list().contacts;
  let busyLookups=2,busyStarts=2;
  const realCall=f.treg.call,realStart=f.research.call;
  f.treg.call=async(...args)=>{if(busyLookups-->0)throw Object.assign(new Error('busy'),{retryable:true});return realCall(...args);};
  f.research.call=async(...args)=>{if(busyStarts-->0)throw Object.assign(new Error('HTTP 429'),{statusCode:429});return realStart(...args);};
  enrichment.request(c.id,'contacts');
  enrichment.request(c.id,'identity');
  await until(()=>settledJobs(enrichment));
  const jobs=enrichment.status().jobs;
  assert.deepEqual(jobs.map(j=>[j.step,j.status]),[['contacts','done'],['identity','done']]);
  assert.ok(jobs.every(j=>j.attempts===3),'each step needed two retries');
  assert.equal(crm.get(c.id).email,'pat@firm.com');
});

test('the enrich-all plan leaves parked contacts out',t=>{
  const {crm,enrichment}=fixture(t);
  crm.import('buyers',[{name:'Pat Buyer',sourceRef:'BP1'},{name:'Sam Buyer',sourceRef:'BP2'}],1);
  crm.import('developers',[{name:'Dee Veloper',sourceRef:'D1'}],1);
  crm.segment('buyers','parked',2);
  const plan=enrichment.plan();
  assert.equal(plan.contacts,1);
  assert.equal(plan.estimateMicros,STEP_ESTIMATE_MICROS.profile+STEP_ESTIMATE_MICROS.contacts+STEP_ESTIMATE_MICROS.identity);
});
