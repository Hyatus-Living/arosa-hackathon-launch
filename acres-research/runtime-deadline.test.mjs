import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {EvidenceStore} from './mcp-store.mjs';
import {createMcpDomain} from './mcp-domain.mjs';
import {createResearchServer} from './service.mjs';
import {executionSignal,withExecutionSignal} from './execution-context.mjs';
import {providerJson} from './public-http.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
for(const mode of ['deadline','disconnect'])test(`${mode} cancels domain work and suppresses evidence from a late provider`,{timeout:3000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'deadline-')),store=new ChatStore(join(dir,'chat.sqlite')),evidence=new EvidenceStore(join(dir,'evidence.sqlite'));
  const entered=deferred(),release=deferred(),aborted=deferred();let signal;
  const mcp=createMcpDomain({evidence,searchWeb:async()=>{signal=executionSignal();signal.addEventListener('abort',aborted.resolve,{once:true});entered.resolve();await release.promise;return [{url:'https://www.nyc.gov/fixture',title:'Late result',text:'Evidence'}];}});
  const server=createResearchServer({store,mcp,secrets:{RESEARCH_TOKEN:'web',MCP_SERVICE_TOKEN:'private-fixture-token-0000000000000000'}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{release.resolve();await server.drain({graceMs:100,cleanupMs:500});store.close();evidence.close();rmSync(dir,{recursive:true,force:true});});
  const controller=new AbortController(),request=fetch(`http://127.0.0.1:${server.address().port}/mcp-api/tools/search`,{method:'POST',signal:controller.signal,headers:{authorization:'Bearer private-fixture-token-0000000000000000','content-type':'application/json','x-acres-account':'a'.repeat(24),'x-acres-workspace':'pilot','x-acres-deadline':String(Date.now()+(mode==='deadline'?80:2000))},body:JSON.stringify({arguments:{query:'test'}})}).then(async response=>({status:response.status,...await response.json()})).catch(()=>null);
  await entered.promise;if(mode==='disconnect')controller.abort();await aborted.promise;
  const result=await request;if(mode==='deadline')assert.equal(result.error.code,'REQUEST_TIMEOUT');
  release.resolve();await server.drain({graceMs:500,cleanupMs:500});assert.equal(signal.aborted,true);assert.equal(evidence.db.prepare('SELECT count(*) AS n FROM evidence').get().n,0);
});
test('provider requests compose caller cancellation with execution cancellation',async()=>{
  const controller=new AbortController();let signal;
  const pending=withExecutionSignal(new AbortController().signal,()=>providerJson('https://fixture',{signal:controller.signal},async(_url,options)=>{signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}));
  controller.abort();await assert.rejects(pending,error=>error.code==='PROVIDER_TIMEOUT');assert.equal(signal.aborted,true);
});

const owner='a'.repeat(24),privateToken='private-correction-fixture-token-00000000';
async function privateFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'deadline-correction-')),store=new ChatStore(join(dir,'chat.sqlite')),evidence=new EvidenceStore(join(dir,'evidence.sqlite'));
  const mcp=createMcpDomain({evidence,writeState:(account,id,{version,assumptions})=>store.updateProjectState(account,id,{version,fields:{assumptions}})});
  let calls=0;const call=mcp.call.bind(mcp);mcp.call=(...args)=>{calls++;return call(...args);};
  const server=createResearchServer({store,mcp,secrets:{RESEARCH_TOKEN:'web',MCP_SERVICE_TOKEN:privateToken}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await server.drain({graceMs:0,cleanupMs:500});store.close();evidence.close();rmSync(dir,{recursive:true,force:true});});
  const conversation=store.createConversation(owner),before=store.projectView(owner,conversation.projectId);
  const body=JSON.stringify({arguments:{projectId:conversation.projectId,version:before.version,assumptions:{hardCostPerSqft:321}}});
  const headers=deadline=>({authorization:`Bearer ${privateToken}`,'content-type':'application/json','x-acres-account':owner,'x-acres-workspace':'fixture','x-acres-deadline':String(deadline)});
  const unchanged=()=>{const after=store.projectView(owner,conversation.projectId);assert.equal(calls,0);assert.equal(after.version,before.version);assert.deepEqual(after.fields,before.fields);assert.equal(evidence.db.prepare('SELECT count(*) AS n FROM usage').get().n,0);};
  return {server,store,evidence,body,headers,unchanged,url:`http://127.0.0.1:${server.address().port}/mcp-api/tools/set_project_assumptions`};
}
for(const at of ['entry','dispatch'])test(`private expired budget at ${at} cannot dispatch, charge quota or change project assumptions`,{timeout:3000},async t=>{
  const f=await privateFixture(t),deadline=Date.now()+(at==='entry'?-1000:100);
  if(at==='dispatch')f.server.on('request',req=>req.prependOnceListener('end',()=>{while(Date.now()<=deadline){};}));
  const response=await fetch(f.url,{method:'POST',headers:f.headers(deadline),body:f.body});
  assert.equal(response.status,504);assert.equal((await response.json()).error.code,'REQUEST_TIMEOUT');f.unchanged();
});
for(const stop of ['deadline','disconnect','drain'])test(`private ${stop} cleans an unfinished body without waiting for its remainder`,{timeout:3000},async t=>{
  const f=await privateFixture(t),entered=deferred(),closed=deferred(),done=deferred();let incoming;
  f.server.on('request',req=>{incoming=req;entered.resolve();});
  const req=http.request(f.url,{method:'POST',headers:{...f.headers(Date.now()+(stop==='deadline'?80:2000)),'content-length':Buffer.byteLength(f.body)}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>done.resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)}));
  });
  req.on('error',()=>done.resolve(null));req.once('close',closed.resolve);t.after(()=>req.destroy());
  req.write(f.body.slice(0,10));req.flushHeaders();await entered.promise;
  if(stop==='disconnect')req.destroy();
  const draining=stop==='drain'?f.server.drain({graceMs:0,cleanupMs:500}):null;
  const response=await done.promise;
  if(stop!=='disconnect'){assert.equal(response.status,504);assert.equal(response.body.error.code,stop==='deadline'?'REQUEST_TIMEOUT':'REQUEST_CANCELLED');assert.equal(response.headers.connection,'close');}
  await closed.promise;if(draining)await draining;
  await new Promise(resolve=>incoming.destroyed?resolve():incoming.once('close',resolve));
  assert.equal(incoming.listenerCount('data'),0);assert.equal(incoming.listeners('end').some(listener=>listener.name==='end'),false);f.unchanged();
});
