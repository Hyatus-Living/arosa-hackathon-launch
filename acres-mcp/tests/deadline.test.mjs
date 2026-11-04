import test from 'node:test';
import http from 'node:http';
import {createBackend,requestBudget} from '../dist/backend.js';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture,call,toolError} from './fixture.mjs';
import {executionSignal} from '../../acres-research/execution-context.mjs';

const source={title:'Fixture',url:'https://www.nyc.gov/fixture',text:'Test evidence.'};
test('sequential provider stages share one gateway deadline and can both finish',async t=>{
  let stages=0;
  const f=await fixture({release:false,timeoutMs:1000,searchWeb:async()=>{for(let i=0;i<2;i++){await delay(80,null,{signal:executionSignal()});stages++;}return [source];}});t.after(()=>f.done());
  const result=await call(await f.connect(),'search',{query:'test'});assert.equal(stages,2);assert.equal(result.results.length,1);
});
test('deadline stops the remaining provider stage and prevents late evidence publication',async t=>{
  let signal,stages=0,finished;const stopped=new Promise(resolve=>finished=resolve);
  const f=await fixture({release:false,timeoutMs:120,searchWeb:async()=>{signal=executionSignal();try{for(let i=0;i<2;i++){await delay(80,null,{signal});stages++;}return [source];}finally{finished();}}});t.after(()=>f.done());
  const result=await toolError(await f.connect(),'search',{query:'test'});assert.equal(result.error.code,'REQUEST_TIMEOUT');await stopped;
  assert.equal(signal.aborted,true);assert.ok(stages<2);assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM evidence').get().n,0);
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const requestBody=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_account',arguments:{}}});
async function rawRequest(f,{partial=false}={}) {
  const token=await f.token(),done=deferred(),closed=deferred();
  const req=http.request(f.base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream','content-length':Buffer.byteLength(requestBody)}},res=>{
    let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>done.resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(body)}));
  });
  req.on('error',()=>done.resolve(null));req.once('close',closed.resolve);
  if(partial){req.write(requestBody.slice(0,10));req.flushHeaders();}else req.end(requestBody);
  return {req,response:done.promise,closed:closed.promise};
}
test('gateway times out an unfinished body before its remainder is sent and releases the reader',{timeout:3000},async t=>{
  const f=await fixture({release:false,timeoutMs:80});t.after(()=>f.done());let incoming;
  f.gateway.on('request',req=>incoming=req);
  const pending=await rawRequest(f,{partial:true});t.after(()=>pending.req.destroy());
  const response=await pending.response;
  assert.equal(response.status,504);assert.equal(response.body.error.code,'REQUEST_TIMEOUT');assert.equal(response.headers.connection,'close');
  await pending.closed;assert.equal(incoming.listenerCount('data'),0);assert.equal(incoming.listeners('end').some(listener=>listener.name==='end'),false);
  assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM usage').get().n,0);
  assert.equal(await new Promise(resolve=>f.gateway.getConnections((_error,count)=>resolve(count))),0);
});
for(const stop of ['deadline','disconnect'])test(`gateway ${stop} during authentication prevents late backend dispatch`,{timeout:3000},async t=>{
  const entered=deferred(),release=deferred(),authenticated=deferred();
  const f=await fixture({release:false,timeoutMs:stop==='deadline'?80:1000,beforeKey:()=>{entered.resolve();return release.promise;}});t.after(()=>f.done());
  const memberships=f.config.memberships;f.config.memberships=()=>{authenticated.resolve();return memberships();};
  const fetcher=globalThis.fetch;let backendCalls=0;
  t.mock.method(globalThis,'fetch',(...args)=>{if(String(args[0]).startsWith(f.config.backendUrl))backendCalls++;return fetcher(...args);});
  const pending=await rawRequest(f);t.after(()=>{pending.req.destroy();release.resolve();});await entered.promise;
  if(stop==='disconnect')pending.req.destroy();
  const response=await pending.response;
  if(stop==='deadline'){assert.equal(response.status,504);assert.equal(response.body.error.code,'REQUEST_TIMEOUT');}
  await pending.closed;release.resolve();await authenticated.promise;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(backendCalls,0);assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM usage').get().n,0);
});
test('gateway disconnect during body ingestion releases listeners without backend work',{timeout:3000},async t=>{
  const f=await fixture({release:false,timeoutMs:1000});t.after(()=>f.done());const entered=deferred();let incoming;
  f.gateway.on('request',req=>{incoming=req;entered.resolve();});
  const pending=await rawRequest(f,{partial:true});await entered.promise;pending.req.destroy();await pending.closed;
  await new Promise(resolve=>incoming.destroyed?resolve():incoming.once('close',resolve));
  assert.equal(incoming.listenerCount('data'),0);assert.equal(incoming.listeners('end').some(listener=>listener.name==='end'),false);
  assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM usage').get().n,0);
});
test('backend rejects expired or cancelled budgets before fetch, including delayed timer delivery',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw new Error('must not fetch');});
  const backend=createBackend({backendUrl:'https://fixture',serviceToken:'fixture'}),account={accountId:'a'.repeat(24),workspaceId:'pilot'};
  const expired=requestBudget(Date.now()-1);t.after(expired.close);
  await assert.rejects(backend('get_account',{},account,'request',expired),error=>error.code==='REQUEST_TIMEOUT');
  const cancelled=requestBudget(Date.now()+1000);t.after(cancelled.close);cancelled.cancel();
  await assert.rejects(backend('get_account',{},account,'request',cancelled),error=>error.code==='REQUEST_CANCELLED');
  const deadline=Date.now()+1000,late=requestBudget(deadline);t.after(late.close);
  t.mock.method(Date,'now',()=>deadline+1);
  await assert.rejects(backend('get_account',{},account,'request',late),error=>error.code==='REQUEST_TIMEOUT');
  assert.equal(calls,0);
});
