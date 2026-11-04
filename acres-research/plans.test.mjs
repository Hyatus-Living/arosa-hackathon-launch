import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {Plans,dayWindow,DAILY_LIMITS} from './plans.mjs';
import {BetaTesters} from './beta.mjs';
import {createResearchServer} from './service.mjs';

const alice='a'.repeat(24),bob='b'.repeat(24);
const OCT=Date.UTC(2026,9,20,12),NOV=Date.UTC(2026,10,2);
const subscription=(over={})=>({status:'active',interval:'month',currentPeriodEnd:Date.UTC(2026,10,20),cancelAtPeriodEnd:false,customer:'cus_1',subscription:'sub_1',eventCreated:100,...over});
function fixture(t,options) {
  const dir=mkdtempSync(join(tmpdir(),'acres-plans-')),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const conversation=store.createConversation(alice).id;
  const addRuns=(owner,count,at)=>{for(let i=0;i<count;i++){
    const id=`${owner}-${at}-${i}`;
    store.write("INSERT INTO runs VALUES(?,?,?,'completed','x',NULL,NULL,?,?)",id,owner,conversation,at,at);
    store.write("INSERT INTO daily_usage VALUES(?,'research',?,?)",owner,`run:${id}`,at);
  }};
  return {store,plans:new Plans(store,options),addRuns};
}
test('daily windows reset at New York midnight across normal, spring and fall days',()=>{
  for(const [now,start,end] of [
    ['2026-11-04T12:00Z','2026-11-04T05:00Z','2026-11-05T05:00Z'],
    ['2026-03-08T12:00Z','2026-03-08T05:00Z','2026-03-09T04:00Z'],
    ['2026-11-01T12:00Z','2026-11-01T04:00Z','2026-11-02T05:00Z'],
    ['2026-12-31T23:00Z','2026-12-31T05:00Z','2027-01-01T05:00Z'],
  ]) assert.deepEqual(dayWindow(Date.parse(now)),{start:Date.parse(start),end:Date.parse(end)});
});
test('all accounts receive the same generous default daily allowances',t=>{
  const {plans,addRuns}=fixture(t);
  addRuns(alice,2,OCT);
  for(const email of ['alice@example.com','michael@witharosa.ai']) {
    const status=plans.status(alice,email,OCT);
    assert.equal(status.plan,'community');assert.equal(status.period,'day');assert.equal(status.timeZone,'America/New_York');
    assert.equal(status.used,2);assert.equal(status.limit,50);assert.equal(status.remaining,48);
    for(const [kind,limit] of Object.entries(DAILY_LIMITS))assert.equal(status.limits[kind].limit,limit);
  }
});
test('research is counted by sender, including listing investigations, and resets without a job',t=>{
  const {store,plans,addRuns}=fixture(t,{dailyLimits:{research:3}}),{start,end}=dayWindow(OCT);
  store.db.exec('CREATE TABLE listing_investigations(id TEXT,owner TEXT,created INTEGER)');
  addRuns(alice,2,OCT);addRuns(bob,1,OCT);addRuns(alice,5,start-1);
  store.write('INSERT INTO listing_investigations VALUES(?,?,?)','listing-1',alice,OCT);
  plans.admitResearch(alice,'listing:listing-1',OCT);
  const status=plans.status(alice,'alice@example.com',OCT);
  assert.equal(status.used,3);assert.equal(status.remaining,0);assert.equal(status.resetsAt,end);
  assert.throws(()=>plans.assertCanRun(alice,null,OCT),e=>e.status===429&&e.code==='daily_limit_reached'&&e.resetsAt===end&&!/upgrade|subscribe|pay/i.test(e.message));
  plans.assertCanRun(bob,null,OCT);plans.assertCanRun(alice,null,end);
  assert.equal(plans.status(alice,null,end).remaining,3);
});
test('image and render allowances survive reopening, isolate accounts and do not charge a replay',t=>{
  const {store,plans}=fixture(t,{dailyLimits:{selections:1,illustrations:1,renders:1}});
  for(const kind of ['selections','illustrations','renders']) {
    assert.equal(plans.consume(alice,kind,'first',OCT),true);
    assert.equal(plans.consume(alice,kind,'first',OCT),false);
    const reopened=new Plans(store,{dailyLimits:{[kind]:1}});
    assert.equal(reopened.status(alice,null,OCT).limits[kind].used,1);
    assert.throws(()=>reopened.consume(alice,kind,'blocked',OCT),{code:'daily_limit_reached',kind});
    assert.equal(plans.consume(bob,kind,'first',OCT),true);
    assert.equal(plans.consume(alice,kind,'tomorrow',dayWindow(OCT).end),true);
  }
});
test('beta feedback eligibility survives and does not create a paid or unlimited tier',t=>{
  const {store,addRuns}=fixture(t),betaTesters=new BetaTesters(store);
  betaTesters.grant('Alice@Example.com','michael@witharosa.ai',OCT);
  const plans=new Plans(store,{dailyLimits:{research:1},betaTesters});addRuns(alice,1,OCT);
  assert.equal(plans.status(alice,'alice@example.com',OCT).beta,true);
  assert.equal(plans.status(alice,'alice@example.com',OCT).plan,'community');
  assert.throws(()=>plans.assertCanRun(alice,'alice@example.com',OCT),{status:429});
});
test('historical subscription records remain ordered without buying more access',t=>{
  const {plans,addRuns}=fixture(t,{dailyLimits:{research:1}});
  addRuns(alice,2,OCT);
  plans.record(alice,subscription(),OCT);
  const pro=plans.status(alice,'alice@example.com',OCT);
  assert.equal(pro.plan,'community');assert.equal(pro.limit,1);assert.equal(pro.customer,'cus_1');
  assert.deepEqual(pro.subscription,{status:'active',interval:'month',currentPeriodEnd:Date.UTC(2026,10,20),cancelAtPeriodEnd:false});
  assert.throws(()=>plans.assertCanRun(alice,'alice@example.com',OCT),{code:'daily_limit_reached'});
  plans.record(alice,subscription({status:'past_due',eventCreated:200}),OCT);
  assert.equal(plans.status(alice,null,OCT).plan,'community');
  plans.record(alice,subscription({status:'canceled',eventCreated:300}),OCT);
  plans.record(alice,subscription({status:'active',eventCreated:250}),OCT);
  assert.equal(plans.subscription(alice).status,'canceled');
  assert.equal(plans.status(alice,null,OCT).plan,'community');
  assert.throws(()=>plans.assertCanRun(alice,null,OCT),{status:429});
  plans.record(alice,subscription({interval:'year',subscription:'sub_2',eventCreated:400}),OCT);
  assert.equal(plans.status(alice,null,OCT).subscription.interval,'year');
  plans.record(alice,subscription({status:'canceled',subscription:'sub_1',eventCreated:500}),OCT);
  assert.equal(plans.subscription(alice).subscription,'sub_2','the old subscription ending leaves the newer record in force');
  for(const bad of [{status:'gone'},{interval:'week'},{customer:'x'},{subscription:'x'},{eventCreated:1.5},{cancelAtPeriodEnd:'no'}])
    assert.throws(()=>plans.record(alice,subscription(bad),OCT),{status:400});
});


test('daily HTTP admission keeps retries free and cannot be bypassed with a subscription or team email',async t=>{
  const {store}=fixture(t),server=createResearchServer({secrets:{RESEARCH_TOKEN:'test',DAILY_LIMITS:{research:1},FREE_RUNS_PER_MONTH:0,BILLING_ENABLED:true},store,execute:async()=>({answer:'x',sources:[],ui:[]}),maps:null});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(path,method='GET',body,email='alice@example.com')=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':alice,'x-acres-email':email,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const {id}=await (await api('/conversations','POST',{})).json();
  const first={message:'What can I build here?',id:crypto.randomUUID()};
  assert.equal((await api(`/conversations/${id}/runs`,'POST',first)).status,202);
  assert.equal((await api(`/conversations/${id}/runs`,'POST',first)).status,202);
  for(const email of ['alice@example.com','michael@witharosa.ai']) {
    const refused=await api(`/conversations/${id}/runs`,'POST',{message:'Next?',id:crypto.randomUUID()},email);
    assert.equal(refused.status,429);const error=await refused.json();
    assert.equal(error.code,'daily_limit_reached');assert.equal(error.resetsAt,dayWindow().end);assert.equal(error.kind,'research');
  }
  const recorded=await (await api('/plan/subscription','PUT',subscription({eventCreated:Math.floor(Date.now()/1000)}))).json();
  assert.equal(recorded.plan,'community');assert.equal(recorded.remaining,0);
  assert.equal((await api(`/conversations/${id}/runs`,'POST',{message:'Still limited'})).status,429);
  assert.equal((await api(`/conversations/${id}`)).status,200,'saved work remains available');
  assert.equal((await api('/research','POST',{message:'Bypass'})).status,410);
  assert.equal((await api(`/conversations/${id}`,'DELETE')).status,200);
  assert.equal((await (await api('/plan')).json()).used,1,'deleting a conversation cannot replenish usage');
  const fresh=await (await api('/conversations','POST',{})).json();
  assert.equal((await api(`/conversations/${fresh.id}/runs`,'POST',first)).status,409,'a deleted request ID cannot be replayed for free');
  assert.equal((await api(`/conversations/${fresh.id}/runs`,'POST',{message:'New'})).status,429);
});

test('existing saved requests migrate once and usage survives content deletion',t=>{
  const {store,addRuns}=fixture(t);addRuns(alice,2,OCT);
  store.write('DELETE FROM daily_usage');
  const migrated=new Plans(store);assert.equal(migrated.used(alice,OCT),2);
  new Plans(store);assert.equal(migrated.used(alice,OCT),2,'migration is idempotent');
  store.write('DELETE FROM runs');assert.equal(migrated.used(alice,OCT),2);
});
