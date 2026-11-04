import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

test('direct research cannot select a project workflow',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-direct-workflow-')),store=new ChatStore(join(dir,'chat.sqlite'));
  let received;
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,traceRoot:join(dir,'traces'),execute:async input=>{received=input;return {answer:'ok',sources:[],ui:[]};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/research`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({message:'Test',workflow:'modeling'})});
    assert.equal(response.status,200);
    assert.equal(received.workflow,undefined);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});}
});

test('restart resumes persisted queues and the interrupted run once, in order', {timeout:5000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-restart-')),path=join(dir,'chat.sqlite'),owner='a'.repeat(24);
  let store=new ChatStore(path);
  const first=store.createConversation(owner),other=store.createConversation(owner);
  const interrupted=store.createRun(owner,first.id,'already running');store.begin(interrupted);
  const a=store.createRun(owner,first.id,'first queued'),b=store.createRun(owner,first.id,'second queued'),c=store.createRun(owner,other.id,'other conversation');
  store.close();store=new ChatStore(path);
  const started=[],release=new Map();
  let twoStarted,secondStarted;
  const ready=new Promise(resolve=>{twoStarted=resolve;}),next=new Promise(resolve=>{secondStarted=resolve;});
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async input=>{
    started.push(input.message);
    const pending=new Promise(resolve=>release.set(input.message,resolve));
    if(started.length===2)twoStarted();
    if(input.message==='second queued')secondStarted();
    await pending;return {answer:input.message+' completed',sources:[],ui:[]};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=path=>fetch(`http://127.0.0.1:${server.address().port}`+path,{headers:{authorization:'Bearer test','x-acres-account':owner}});
  try {
    await ready;
    assert.deepEqual(new Set(started),new Set(['already running','other conversation']));
    assert.equal(store.run(owner,interrupted.id).status,'running');
    assert.equal(store.run(owner,a.id).status,'queued');
    release.get('already running')();
    await new Promise(resolve=>{const wait=()=>started.includes('first queued')?resolve():setTimeout(wait,5);wait();});
    assert.equal(store.run(owner,b.id).status,'queued');
    release.get('first queued')();await next;
    assert.equal(store.run(owner,a.id).status,'completed');
    assert.equal(store.run(owner,b.id).status,'running');
    release.get('second queued')();release.get('other conversation')();
    for(const run of [interrupted,a,b,c]) {
      assert.match(await (await request('/runs/'+run.id+'/events')).text(),/run.completed/);
      assert.equal(store.conversation(owner,run.conversation).messages.filter(m=>m.runId===run.id&&m.role==='user').length,1);
    }
    assert.equal(started.length,4);
  } finally {for(const finish of release.values())finish();await new Promise(resolve=>setImmediate(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true});}
});

test('HTTP authorization, durable disconnect recovery and owner-scoped event replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-api-'));const store=new ChatStore(join(dir,'chat.sqlite'));let complete;
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async(input,secrets,progress,emit)=>{emit('tool.started',{tool:'findProperty'});await new Promise(r=>{complete=r;});return {answer:'Verified answer',sources:[],ui:[]};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,method='GET',body,owner='a'.repeat(24))=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':owner,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try {
    assert.equal((await fetch(base+'/conversations')).status,401);
    assert.equal((await fetch(base+'/mcp-api/tools/get_account',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:'{"arguments":{}}'})).status,401);
    const conversation=await (await request('/conversations','POST',{})).json();
    assert.equal((await request('/conversations/'+conversation.id,'GET',null,'b'.repeat(24))).status,404);
    const response=await request('/conversations/'+conversation.id+'/runs','POST',{message:'120 Broadway'});assert.equal(response.status,202);const run=await response.json();
    const controller=new AbortController();const stream=await fetch(base+'/runs/'+run.id+'/events',{headers:{authorization:'Bearer test','x-acres-account':'a'.repeat(24)},signal:controller.signal});
    const reader=stream.body.getReader();let chunk='';while(!chunk.includes('tool.started'))chunk+=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/tool.started/);controller.abort();
    complete();await new Promise(r=>setTimeout(r,30));
    const saved=await (await request('/conversations/'+conversation.id)).json();assert.equal(saved.messages.at(-1).text,'Verified answer');
    const replay=await (await request('/runs/'+run.id+'/events?after=1')).text();assert.match(replay,/run.completed/);assert.doesNotMatch(replay,/run.queued/);
    assert.equal((await request('/runs/'+run.id,'GET',null,'b'.repeat(24))).status,404);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true});}
});

test('billing exposes only a validated policy and disables the unscoped legacy bypass',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-billing-api-')),store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test',BILLING_ENABLED:true,BILLING_RATES:{codex:{mode:'estimated_call',amountMicros:100,reserveMicros:200,version:'v1',basis:'Subscription allocation'},invalid:{mode:'reported_usd'}}},store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/billing-policy',{headers:{authorization:'Bearer test'}})).status,401);
    const policy=await (await fetch(base+'/billing-policy',{headers:{authorization:'Bearer test','x-acres-account':'a'.repeat(24)}})).json();
    assert.equal(policy.enabled,true);assert.equal(policy.ready,true);assert.deepEqual(Object.keys(policy.rates),['codex']);
    assert.equal((await fetch(base+'/research',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({message:'Do not bypass wallet'})})).status,410);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true});}
});

test('street photos are served through the service with the key kept on the host',{timeout:5000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-street-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24);
  const calls=[];
  const maps={async streamingUnused(){},async streetViewImage(args){calls.push(args);if(args.pano==='missing')throw new Error('upstream');return {bytes:Buffer.from('jpeg!'),contentType:'image/jpeg'};}};
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[],ui:[]}),maps});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/street-view?pano=abcdefghij&heading=90')).status,401);
    const ok=await fetch(base+'/street-view?pano=abcdefghij&heading=90',{headers:{authorization:'Bearer test','x-acres-account':owner}});
    assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'image/jpeg');assert.equal(await ok.text(),'jpeg!');
    assert.deepEqual(calls[0],{pano:'abcdefghij',heading:'90',fov:90});
    const failed=await fetch(base+'/street-view?pano=missing&heading=90',{headers:{authorization:'Bearer test','x-acres-account':owner}});
    assert.equal(failed.status,503);assert.match((await failed.json()).error,/unavailable/);
    const none=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[],ui:[]}),maps:null});
    await new Promise(resolve=>none.listen(0,'127.0.0.1',resolve));
    try {assert.equal((await fetch(`http://127.0.0.1:${none.address().port}/street-view?pano=abcdefghij&heading=90`,{headers:{authorization:'Bearer test','x-acres-account':owner}})).status,404);}
    finally {none.close();}
  } finally {server.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('the deck route builds slides from the persisted project state for viewers only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-deck-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24),viewer='b'.repeat(24),stranger='c'.repeat(24);
  const conversation=store.createConversation(owner);
  const field=value=>({value,provenance:{tool:'test',run:null,sources:[{title:'NYC PLUTO',url:'https://data.cityofnewyork.us/pluto',kind:'property',retrievedAt:null}]}});
  store.project.write(store.projectOf(conversation.id),{
    property:field({bbl:'1000477501',address:'120 BROADWAY',borough:'MN',lotarea:40000}),
    envelope:field({district:'C5-5',floorArea:{maxFar:15,maxFloorAreaSqft:600000},metrics:{storeys:40}}),
    entitlements:field({district:'C5-5',scenarios:[{id:'uap',name:'UAP Bonus',maxFar:18}]}),
    market:field({submarket:'Financial District',rents:[{bedrooms:1,rentPerSqftPerMonth:7.5}]}),
    program:field({productType:'rental',units:420,residentialGrossSqft:500000}),
    proFormas:field([{name:'Rental tower',productType:'rental',development:{totalDevelopmentCost:420000000},returns:{profit:90000000}}]),
    comparisons:field([{recommendation:{label:'UAP rental',rationale:'Bonus floor area pays for itself.'},variants:[{label:'UAP rental',productType:'rental',totalDevelopmentCost:420000000,profit:90000000}]}]),
  });
  store.grantMember(owner,conversation.id,'account',viewer,'viewer','viewer@witharosa.ai');
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[],ui:[]})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const deck=account=>fetch(`http://127.0.0.1:${server.address().port}/conversations/${conversation.id}/deck`,{headers:{authorization:'Bearer test','x-acres-account':account}});
  try {
    const response=await deck(viewer);assert.equal(response.status,200);
    const {slides}=await response.json();
    assert.equal(slides[0].metrics.bbl,'1000477501');
    assert.equal(slides[0].metrics.recommendedProgram,'UAP rental');
    assert.equal(slides[0].metrics.totalDevelopmentCostUsd,420000000);
    assert.equal(slides[2].envelope.district,'C5-5');
    assert.equal(slides[2].envelope.maxFar,15);
    assert.equal(slides[2].entitlementScenarios[0].name,'UAP Bonus');
    assert.equal(slides[4].market.submarket,'Financial District');
    assert.equal(slides[4].program.units,420);
    assert.equal(slides[5].proForma.name,'Rental tower');
    assert.equal(slides[5].comparison.recommendation.label,'UAP rental');
    assert.equal(slides[6].sources[0].title,'NYC PLUTO');
    assert.equal((await deck(stranger)).status,404);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});}
});

test('public stats return only aggregate counts, need the service token and no account',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-public-stats-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='c'.repeat(24);
  const conversation=store.createConversation(owner),run=store.createRun(owner,conversation.id,'What can I build here?');
  store.begin(run);store.finish(run,'completed',{answer:'Cited answer',sources:[{title:'Zoning Resolution'},{title:'PLUTO'}],ui:[]});
  let closed=0;
  const market={publicCounts:()=>({listingsScreened:120,lotsMatched:80}),close:()=>{closed++;}};
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,marketStoreFactory:()=>market});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=headers=>fetch(`http://127.0.0.1:${server.address().port}/public-stats`,{headers});
  try {
    assert.equal((await get({})).status,401);
    const stats=await (await get({authorization:'Bearer test'})).json();
    assert.deepEqual(Object.keys(stats).sort(),['listingsScreened','lotsMatched','propertiesResearched','researchRuns','sitesUnderwritten','sourcesCited','updatedAt']);
    assert.equal(stats.listingsScreened,120);
    assert.equal(stats.researchRuns,1);
    assert.equal(stats.sourcesCited,2);
    await get({authorization:'Bearer test'});
    assert.equal(closed,1,'a second request inside five minutes is served from the cache');
  } finally {server.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
