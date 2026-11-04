import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {Plans,monthWindow} from './plans.mjs';
import {BetaTesters} from './beta.mjs';
import {createResearchServer} from './service.mjs';

const alice='a'.repeat(24),bob='b'.repeat(24);
const OCT=Date.UTC(2026,9,20,12),NOV=Date.UTC(2026,10,2);
const subscription=(over={})=>({status:'active',interval:'month',currentPeriodEnd:Date.UTC(2026,10,20),cancelAtPeriodEnd:false,customer:'cus_1',subscription:'sub_1',eventCreated:100,...over});

function fixture(t,options) {
  const dir=mkdtempSync(join(tmpdir(),'acres-plans-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const conversation=store.createConversation(alice).id;
  const addRuns=(owner,count,at)=>{for(let i=0;i<count;i++)store.write("INSERT INTO runs VALUES(?,?,?,'completed','x',NULL,NULL,?,?)",`${owner}-${at}-${i}`,owner,conversation,at,at);};
  return {store,plans:new Plans(store,options),addRuns};
}

test('free accounts get the monthly allowance, counted per sender and reset on the first of the month',t=>{
  const {plans,addRuns}=fixture(t,{freeRunsPerMonth:3});
  addRuns(alice,3,OCT);addRuns(bob,1,OCT);addRuns(alice,5,Date.UTC(2026,8,30));
  assert.deepEqual(monthWindow(OCT),{start:Date.UTC(2026,9,1),end:Date.UTC(2026,10,1)});
  const status=plans.status(alice,'alice@example.com',OCT);
  assert.equal(status.plan,'free');assert.equal(status.used,3);assert.equal(status.limit,3);assert.equal(status.resetsAt,Date.UTC(2026,10,1));
  assert.throws(()=>plans.assertCanRun(alice,'alice@example.com',OCT),e=>e.status===402&&e.code==='free_limit_reached'&&/3 free research runs/.test(e.message));
  plans.assertCanRun(bob,'bob@example.com',OCT);
  plans.assertCanRun(alice,'alice@example.com',NOV);
});

test('without a configured allowance nobody is limited',t=>{
  const {plans,addRuns}=fixture(t);
  addRuns(alice,50,OCT);
  assert.equal(plans.status(alice,'alice@example.com',OCT).limit,null);
  plans.assertCanRun(alice,'alice@example.com',OCT);
});

test('the Arosa team and listed accounts are unlimited',t=>{
  const {plans,addRuns}=fixture(t,{freeRunsPerMonth:1,unmeteredEmails:['Tester@Example.com']});
  addRuns(alice,4,OCT);
  for(const email of ['someone@witharosa.ai','michael@witharosa.ai','tester@example.com']) {
    assert.equal(plans.status(alice,email,OCT).plan,'team');plans.assertCanRun(alice,email,OCT);
  }
  assert.equal(plans.status(alice,'other@example.com',OCT).plan,'free');
});

test('an active subscription is unlimited; a cancelled one returns to free; older events never win',t=>{
  const {plans,addRuns}=fixture(t,{freeRunsPerMonth:1});
  addRuns(alice,2,OCT);
  plans.record(alice,subscription(),OCT);
  const pro=plans.status(alice,'alice@example.com',OCT);
  assert.equal(pro.plan,'pro');assert.equal(pro.limit,null);assert.equal(pro.customer,'cus_1');
  assert.deepEqual(pro.subscription,{status:'active',interval:'month',currentPeriodEnd:Date.UTC(2026,10,20),cancelAtPeriodEnd:false});
  plans.assertCanRun(alice,'alice@example.com',OCT);
  plans.record(alice,subscription({status:'past_due',eventCreated:200}),OCT);
  assert.equal(plans.status(alice,null,OCT).plan,'pro');
  plans.record(alice,subscription({status:'canceled',eventCreated:300}),OCT);
  plans.record(alice,subscription({status:'active',eventCreated:250}),OCT);
  assert.equal(plans.subscription(alice).status,'canceled');
  assert.equal(plans.status(alice,null,OCT).plan,'free');
  assert.throws(()=>plans.assertCanRun(alice,null,OCT),{status:402});
  plans.record(alice,subscription({interval:'year',subscription:'sub_2',eventCreated:400}),OCT);
  assert.equal(plans.status(alice,null,OCT).subscription.interval,'year');
  plans.record(alice,subscription({status:'canceled',subscription:'sub_1',eventCreated:500}),OCT);
  assert.equal(plans.status(alice,null,OCT).plan,'pro','the old subscription ending leaves the new one in force');
  for(const bad of [{status:'gone'},{interval:'week'},{customer:'x'},{subscription:'x'},{eventCreated:1.5},{cancelAtPeriodEnd:'no'}])
    assert.throws(()=>plans.record(alice,subscription(bad),OCT),{status:400});
});

test('the research service refuses runs past the free allowance with a code the app can act on',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-plans-http-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test',FREE_RUNS_PER_MONTH:1},store,execute:async()=>({answer:'x',sources:[],ui:[]}),maps:null});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(path,method='GET',body,email='alice@example.com')=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':alice,'x-acres-email':email,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const {id}=await (await api('/conversations','POST',{})).json();
  const first={message:'What can I build here?',id:crypto.randomUUID()};
  assert.equal((await api(`/conversations/${id}/runs`,'POST',first)).status,202);
  assert.equal((await api(`/conversations/${id}/runs`,'POST',first)).status,202,'a retried request is not a new run');
  const refused=await api(`/conversations/${id}/runs`,'POST',{message:'And next door?',id:crypto.randomUUID()});
  assert.equal(refused.status,402);
  assert.equal((await refused.json()).code,'free_limit_reached');
  assert.equal((await api(`/conversations/${id}/runs`,'POST',{message:'Team question',id:crypto.randomUUID()},'chaim@witharosa.ai')).status,202);
  const plan=await (await api('/plan')).json();
  assert.equal(plan.plan,'free');assert.equal(plan.limit,1);assert.equal(plan.used,2);
  const recorded=await (await api('/plan/subscription','PUT',subscription({eventCreated:Math.floor(Date.now()/1000)}))).json();
  assert.equal(recorded.plan,'pro');
  assert.equal((await api(`/conversations/${id}/runs`,'POST',{message:'Now unlimited',id:crypto.randomUUID()})).status,202);
});

test('beta testers have only a large safety cap while the free limit is on, and are unlimited while it is off',t=>{
  const {store,addRuns}=fixture(t);
  const betaTesters=new BetaTesters(store);betaTesters.grant('Alice@Example.com','michael@witharosa.ai',OCT);
  addRuns(alice,4,OCT);
  const limited=new Plans(store,{freeRunsPerMonth:2,betaRunsPerMonth:5,betaTesters});
  const status=limited.status(alice,'alice@example.com',OCT);
  assert.equal(status.plan,'beta');assert.equal(status.beta,true);assert.equal(status.limit,5);assert.equal(status.betaAllowance,5);
  limited.assertCanRun(alice,'alice@example.com',OCT);
  addRuns(alice,1,OCT+1);
  assert.throws(()=>limited.assertCanRun(alice,'alice@example.com',OCT),e=>e.status===402&&e.message==='You have reached the beta safety cap of 5 research runs this month. It resets on the first of next month.');
  assert.equal(limited.status(alice,'other@example.com',OCT).plan,'free');
  assert.equal(new Plans(store,{freeRunsPerMonth:2,betaTesters}).status(alice,'alice@example.com',OCT).limit,1000,'1,000 runs when the beta cap is unset');
  const open=new Plans(store,{betaRunsPerMonth:5,betaTesters}).status(alice,'alice@example.com',OCT);
  assert.equal(open.plan,'beta');assert.equal(open.limit,null);assert.equal(open.betaAllowance,5);
  assert.equal(limited.status(alice,'chaim@witharosa.ai',OCT).plan,'team');
  betaTesters.grant('chaim@witharosa.ai','michael@witharosa.ai',OCT);
  assert.deepEqual([limited.status(alice,'chaim@witharosa.ai',OCT).plan,limited.status(alice,'chaim@witharosa.ai',OCT).beta],['team',true],'the team stays unlimited and still sees the beta bar');
  limited.record(alice,subscription(),OCT);
  assert.equal(limited.status(alice,'alice@example.com',OCT).plan,'pro','Pro stays unlimited');
  limited.assertCanRun(alice,'alice@example.com',OCT);
});
