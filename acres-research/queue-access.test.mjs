import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {createResearchServer} from './service.mjs';

const terminalEvents=new Set(['run.completed','run.failed','run.interrupted']);
function fixture(t,onExecute=null){
  const dir=mkdtempSync(join(tmpdir(),'acres-queue-access-')),store=new ChatStore(join(dir,'chat.sqlite'));
  for(const name of ['alice','bob'])store.touchPerson(name,`${name}@witharosa.ai`);
  const conversation=store.createConversation('alice'),calls=[],gates=new Map();let manager;
  const wait=id=>{
    if(['completed','failed','interrupted'].includes(store.runRow(id).status))return Promise.resolve();
    return new Promise(resolve=>{const listen=event=>{if(terminalEvents.has(event.event)){manager.off(id,listen);resolve(event);}};manager.on(id,listen);});
  };
  const f={store,conversation,calls,wait,enqueue:(account,message,conversationId=conversation.id)=>manager.enqueue(account,conversationId,message),release:message=>gates.get(message)(),direct:()=>store.grantMember('alice',conversation.id,'account','bob','participant','bob@witharosa.ai'),team:()=>{const team=store.createTeam('alice','Research team');store.addTeamMember('alice',team.id,'bob','bob@witharosa.ai');store.grantMember('alice',conversation.id,'team',team.id,'participant');return team;}};
  manager=new RunManager(store,{},async input=>{
    calls.push(input);
    if(input.message.startsWith('hold-'))await new Promise(resolve=>gates.set(input.message,resolve));
    if(onExecute)return onExecute(input,f);
    return {answer:'Synthetic completion',sources:[]};
  });f.manager=manager;
  t.after(async()=>{
    for(const run of store.query("SELECT * FROM runs WHERE status='running'"))if(!manager.active.has(run.id))store.finish(run,'interrupted',null,'Fixture cleanup.');
    const pending=store.query("SELECT id FROM runs WHERE status IN ('queued','running')").map(run=>wait(run.id));
    manager.pump();for(const release of gates.values())release();await Promise.all(pending);
    assert.equal(manager.active.size,0);store.close();rmSync(dir,{recursive:true});
  });
  return f;
}
async function finishQueue(f,queued){const done=f.wait(queued.id);f.release('hold-main');await done;}
function denied(f,run){
  assert.equal(f.store.runRow(run.id).status,'failed');assert.ok(f.calls.every(call=>call.message!==run.input));
  assert.equal(f.store.runEvents(run.id).some(event=>event.event==='run.started'),false);
  assert.deepEqual(f.store.query('SELECT role FROM messages WHERE run=?',run.id).map(row=>row.role),['assistant']);
}

test('begin rechecks a removed participant before reading private history or claiming the queued run',t=>{
  const f=fixture(t);f.direct();const run=f.store.createRun('bob',f.conversation.id,'revoked-direct');
  f.store.removeGrant('alice',f.conversation.id,'account','bob');const reads=t.mock.method(f.store,'messageRows');
  assert.throws(()=>f.store.begin(run),{status:404});assert.equal(reads.mock.calls.length,0);
  assert.equal(f.store.runRow(run.id).status,'queued');assert.equal(f.store.runEvents(run.id).some(event=>event.event==='run.started'),false);
});

test('begin rejects a participant downgraded to viewer before reading history',t=>{
  const f=fixture(t);f.direct();const run=f.store.createRun('bob',f.conversation.id,'viewer-direct');
  f.store.setGrantRole('alice',f.conversation.id,'account','bob','viewer');const reads=t.mock.method(f.store,'messageRows');
  assert.throws(()=>f.store.begin(run),{status:403});assert.equal(reads.mock.calls.length,0);
  assert.equal(f.store.query('SELECT id FROM messages WHERE run=?',run.id).length,0);
});

test('a queued revoked sender never reaches execution with the conversation private history',{timeout:5000},async t=>{
  const f=fixture(t);f.direct();const seed=f.store.createRun('alice',f.conversation.id,'Seed');f.store.begin(seed);f.store.finish(seed,'completed',{answer:'PRIVATE_OWNER_RESEARCH',sources:[]});
  f.enqueue('alice','hold-main');const queued=f.enqueue('bob','revoked-queued');f.store.removeGrant('alice',f.conversation.id,'account','bob');
  await finishQueue(f,queued);denied(f,queued);
});

test('removing team membership blocks the queued team participant',{timeout:5000},async t=>{
  const f=fixture(t),team=f.team();f.enqueue('alice','hold-main');const queued=f.enqueue('bob','removed-team');
  f.store.removeTeamMember('alice',team.id,'bob');await finishQueue(f,queued);denied(f,queued);
});

test('archiving the granted team blocks its queued research sender',{timeout:5000},async t=>{
  const f=fixture(t),team=f.team();f.enqueue('alice','hold-main');const queued=f.enqueue('bob','archived-team');
  f.store.archiveTeam('alice',team.id);await finishQueue(f,queued);denied(f,queued);
});

test('a team grant downgraded to viewer cannot dispatch the queued request',{timeout:5000},async t=>{
  const f=fixture(t),team=f.team();f.enqueue('alice','hold-main');const queued=f.enqueue('bob','viewer-team');
  f.store.setGrantRole('alice',f.conversation.id,'team',team.id,'viewer');await finishQueue(f,queued);denied(f,queued);
});

test('a surviving team participant grant still authorizes dispatch after direct removal',async t=>{
  const f=fixture(t);f.direct();f.team();f.enqueue('alice','hold-main');const queued=f.enqueue('bob','via-team');
  f.store.removeGrant('alice',f.conversation.id,'account','bob');await finishQueue(f,queued);
  assert.equal(f.store.runRow(queued.id).status,'completed');assert.equal(f.calls.filter(call=>call.message==='via-team').length,1);
});

test('a surviving direct participant grant still authorizes dispatch after team removal',async t=>{
  const f=fixture(t);f.direct();const team=f.team();f.enqueue('alice','hold-main');const queued=f.enqueue('bob','via-direct');
  f.store.removeTeamMember('alice',team.id,'bob');await finishQueue(f,queued);
  assert.equal(f.store.runRow(queued.id).status,'completed');assert.equal(f.calls.filter(call=>call.message==='via-direct').length,1);
});

test('dispatch uses a restored current role rather than a frozen intermediate downgrade',async t=>{
  const f=fixture(t);f.direct();f.enqueue('alice','hold-main');const queued=f.enqueue('bob','restored');
  f.store.setGrantRole('alice',f.conversation.id,'account','bob','viewer');f.store.setGrantRole('alice',f.conversation.id,'account','bob','participant');
  await finishQueue(f,queued);assert.equal(f.store.runRow(queued.id).status,'completed');
});

test('the conversation owner can still dispatch queued follow-up research',async t=>{
  const f=fixture(t);f.enqueue('alice','hold-main');const queued=f.enqueue('alice','owner-followup');
  await finishQueue(f,queued);assert.equal(f.store.runRow(queued.id).status,'completed');assert.equal(f.calls.filter(call=>call.message==='owner-followup').length,1);
});

test('ownership of an attached conversation still permits research with viewer project scope',async t=>{
  const f=fixture(t);f.store.grantMember('alice',f.conversation.id,'account','bob','viewer','bob@witharosa.ai');
  const attached=f.store.createConversation('bob',{projectId:f.conversation.projectId});assert.equal(f.store.projectAccess('bob',attached.projectId),'viewer');
  const run=f.enqueue('bob','own-attached',attached.id);await f.wait(run.id);
  assert.equal(f.store.runRow(run.id).status,'completed');assert.equal(f.calls.filter(call=>call.message==='own-attached').length,1);
});

test('a batch of denied starts finishes once each and does not duplicate errors or block unrelated work',{timeout:5000},async t=>{
  const f=fixture(t);f.direct();const other=f.store.createConversation('alice'),later=f.store.createConversation('alice');
  f.enqueue('alice','hold-main');f.enqueue('alice','hold-other',other.id);
  const deniedRuns=Array.from({length:8},(_,index)=>f.enqueue('bob',`denied-${index}`));
  f.store.removeGrant('alice',f.conversation.id,'account','bob');const all=Promise.all(deniedRuns.map(run=>f.wait(run.id)));
  f.release('hold-main');await all;
  for(const run of deniedRuns){denied(f,run);assert.equal(f.store.runEvents(run.id).filter(event=>event.event==='run.failed').length,1);}
  const allowed=f.enqueue('alice','allowed-later',later.id);await f.wait(allowed.id);
  assert.equal(f.store.runRow(allowed.id).status,'completed');assert.equal(f.calls.filter(call=>call.message==='allowed-later').length,1);
});

test('a synchronous nested enqueue still starts in the free worker slot',{timeout:5000},async t=>{
  let childConversation;
  const f=fixture(t,async(input,current)=>{
    if(input.message==='parent'){const child=current.enqueue('alice','child',childConversation.id);await current.wait(child.id);}
    return {answer:'Synthetic completion',sources:[]};
  });childConversation=f.store.createConversation('alice');const parent=f.enqueue('alice','parent');await f.wait(parent.id);
  assert.equal(f.store.runRow(parent.id).status,'completed');assert.deepEqual(f.calls.map(call=>call.message),['parent','child']);
});

test('actual HTTP grant removal prevents queued execution and publishes one terminal failure to the owner',{timeout:5000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-http-queue-access-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24),sender='b'.repeat(24),calls=[];
  for(const [account,name]of [[owner,'alice'],[sender,'bob']])store.touchPerson(account,`${name}@witharosa.ai`);
  const conversation=store.createConversation(owner);store.grantMember(owner,conversation.id,'account',sender,'participant','bob@witharosa.ai');
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'fixture'},store,maps:null,execute:async input=>{calls.push(input.message);if(input.message==='hold')await gate;return {answer:'Synthetic completion',sources:[]};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true});});
  const base=`http://127.0.0.1:${server.address().port}`,headers=account=>({authorization:'Bearer fixture','x-acres-account':account,'content-type':'application/json'});
  const post=async(account,message)=>{const response=await fetch(`${base}/conversations/${conversation.id}/runs`,{method:'POST',headers:headers(account),body:JSON.stringify({message})});assert.equal(response.status,202);return response.json();};
  await post(owner,'hold');const queued=await post(sender,'queued-revoked');
  const stream=await fetch(`${base}/runs/${queued.id}/events`,{headers:headers(owner)});assert.equal(stream.status,200);const events=stream.text();
  const removed=await fetch(`${base}/conversations/${conversation.id}/members/account/${sender}`,{method:'DELETE',headers:headers(owner)});assert.equal(removed.status,200);
  release();const body=await events;assert.match(body,/"event":"run.failed"/);assert.doesNotMatch(body,/"event":"run.started"/);
  const result=await fetch(`${base}/runs/${queued.id}`,{headers:headers(owner)});assert.equal(result.status,200);assert.equal((await result.json()).status,'failed');
  assert.equal((await fetch(`${base}/runs/${queued.id}`,{headers:headers(sender)})).status,404);
  assert.deepEqual(calls,['hold']);
});
