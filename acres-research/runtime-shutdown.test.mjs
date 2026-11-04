import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {executionSignal,abortable} from './execution-context.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const owner='a'.repeat(24),answer={answer:'Done',sources:[],ui:[]};
async function fixture(t,execute,release=null){
  const dir=mkdtempSync(join(tmpdir(),'shutdown-')),store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute,traceRoot:join(dir,'traces'),release});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await server.drain({graceMs:0,cleanupMs:500});store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,server,base};
}
test('drain finishes active work, closes project feeds and preserves queued runs without replay',{timeout:3000},async t=>{
  const entered=deferred(),release=deferred(),started=[];
  const {store,server,base}=await fixture(t,async input=>{started.push(input.message);entered.resolve();await release.promise;return answer;});
  const c=store.createConversation(owner),run=store.createRun(owner,c.id,'first');
  // Creation precedes the manager startup tick.
  const queued=store.createRun(owner,c.id,'second');await entered.promise;
  const stream=await fetch(base+'/runs/'+run.id+'/events',{headers:{authorization:'Bearer test','x-acres-account':owner}});
  const reader=stream.body.getReader();await reader.read();
  const done=server.drain({graceMs:1000,cleanupMs:500});release.resolve();await done;
  assert.equal(store.runStatus(owner,run.id).status,'completed');
  assert.equal(store.runStatus(owner,queued.id).status,'queued');assert.deepEqual(started,['first']);
  await reader.cancel().catch(()=>{});
});
test('drain deadline cancels durable execution and keeps the next request queued',{timeout:3000},async t=>{
  const entered=deferred();let signal;
  const {store,server}=await fixture(t,async()=>{signal=executionSignal();entered.resolve();await abortable(new Promise(()=>{}));return answer;});
  const c=store.createConversation(owner),run=store.createRun(owner,c.id,'active'),queued=store.createRun(owner,c.id,'queued');await entered.promise;
  await server.drain({graceMs:15,cleanupMs:500});
  assert.equal(signal.aborted,true);assert.equal(store.runStatus(owner,run.id).status,'interrupted');assert.equal(store.runStatus(owner,queued.id).status,'queued');
});
test('legacy execution participates in shutdown cancellation',{timeout:3000},async t=>{
  const entered=deferred();let signal;
  const {server,base}=await fixture(t,async()=>{signal=executionSignal();entered.resolve();await abortable(new Promise(()=>{}));return answer;});
  const pending=fetch(base+'/research',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({message:'legacy'})}).then(r=>r.text()).catch(()=>null);
  await entered.promise;await server.drain({graceMs:15,cleanupMs:500});await pending;assert.equal(signal.aborted,true);
});
const headers={authorization:'Bearer test','x-acres-account':owner,'content-type':'application/json'};
const health=async base=>(await fetch(base+'/healthz')).json();
test('a draining service keeps serving and queues new runs for the next process',{timeout:3000},async t=>{
  const entered=deferred(),release=deferred(),started=[];
  const {store,server,base}=await fixture(t,async input=>{started.push(input.message);entered.resolve();await release.promise;return answer;},'abc123');
  const c=store.createConversation(owner),run=store.createRun(owner,c.id,'first');await entered.promise;
  assert.deepEqual(await health(base),{ok:true,release:'abc123',draining:false,active:1});
  const done=server.drain({graceMs:2000,cleanupMs:500});
  assert.deepEqual(await health(base),{ok:true,release:'abc123',draining:true,active:1});
  const created=await fetch(base+'/conversations/'+c.id+'/runs',{method:'POST',headers,body:JSON.stringify({message:'second'})});
  assert.equal(created.status,202);assert.equal(created.headers.get('connection'),'close');
  const queued=await created.json();
  const status=await fetch(base+'/runs/'+run.id,{headers});assert.equal(status.status,200);
  release.resolve();await done;
  assert.equal(store.runStatus(owner,run.id).status,'completed');assert.equal(store.runStatus(owner,queued.id).status,'queued');
  assert.deepEqual(started,['first']);
  await assert.rejects(fetch(base+'/healthz'),'a drained service stops listening');
});
test('hurry ends a drain without waiting for active runs',{timeout:3000},async t=>{
  const entered=deferred();
  const {store,server}=await fixture(t,async()=>{entered.resolve();await abortable(new Promise(()=>{}));return answer;});
  const c=store.createConversation(owner),run=store.createRun(owner,c.id,'active');await entered.promise;
  await new Promise(resolve=>setImmediate(resolve));
  // The drain still outlasts the keep-alive timeout (shortened here) before it stops listening.
  server.keepAliveTimeout=100;const started=Date.now();
  const done=server.drain({graceMs:60000,cleanupMs:500});server.hurry();await done;
  assert.equal(store.runStatus(owner,run.id).status,'interrupted');
  const took=Date.now()-started;assert.ok(took>=1100&&took<2500,`drain took ${took} ms`);
});
test('a connection accepted before the listener closes still gets its answer',{timeout:5000},async t=>{
  const {server}=await fixture(t);server.keepAliveTimeout=100;
  const port=server.address().port,socket=net.connect(port,'127.0.0.1');
  await new Promise(resolve=>socket.once('connect',resolve));
  const done=server.drain({graceMs:5000,cleanupMs:500});
  // Wait until the drain has stopped listening, then send the request on the early connection.
  for(;;){const probe=net.connect(port,'127.0.0.1');if(await new Promise(resolve=>{probe.once('connect',()=>{probe.destroy();resolve(false);});probe.once('error',()=>resolve(true));}))break;await new Promise(r=>setTimeout(r,20));}
  let reply='';socket.on('data',chunk=>reply+=chunk);
  socket.write('GET /healthz HTTP/1.1\r\nHost: research\r\n\r\n');
  await new Promise(resolve=>socket.once('close',resolve));await done;
  assert.match(reply,/^HTTP\/1\.1 200/);assert.match(reply,/connection: close/i);assert.match(reply,/"draining":true/);
});
