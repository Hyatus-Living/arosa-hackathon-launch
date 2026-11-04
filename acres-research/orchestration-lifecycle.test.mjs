import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {runCodex,closeCodexPool} from './codex.mjs';
import {research,mergeLaneState} from './research.mjs';
import {SessionStore} from './composio.mjs';
import {createResearchTools} from './tools.mjs';
import {createUrlFetcher} from './fetch-url.mjs';
import {installOfflinePublicWeb} from './testing/public-web.mjs';
import {executionSignal,withExecutionSignal,abortable,stoppedError} from './execution-context.mjs';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {createResearchServer} from './service.mjs';
import {Drawings} from './architecture-drawings.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
function temp(t){const dir=mkdtempSync(join(tmpdir(),'acres-orchestration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

function fakeCodex(onTurn=(_turn,f)=>f.complete('Answer.'),{ignoreTerm=false}={}) {
  const requests=[],processes=[];let ws,thread='thread-1',turn=0;
  const f={requests,processes,get ws(){return ws;},send:m=>ws.emit('message',Buffer.from(JSON.stringify(m))),
    complete:(text,status='completed')=>{
      if(text)f.send({method:'item/completed',params:{threadId:thread,item:{type:'agentMessage',phase:'final_answer',text}}});
      f.send({method:'turn/completed',params:{threadId:thread,turn:{id:`turn-${turn}`,status}}});
    },
    tool:(name,args={})=>f.send({id:`tool-${turn}`,method:'item/tool/call',params:{threadId:thread,tool:name,arguments:args}}),
    options:{history:[],message:'Test',dynamicTools:[],secrets:{CODEX_BIN:'fake'},execute:async()=>({}),oauth:async()=>({accessToken:'fake',chatgptAccountId:'fake'}),deadlineMs:3000},
  };
  f.options.spawnProcess=(_bin,_args,options)=>{
    const child=new EventEmitter();Object.assign(child,{stderr:new EventEmitter(),exitCode:null,signalCode:null,dir:options.cwd,kills:[]});
    child.kill=signal=>{child.kills.push(signal);if(ignoreTerm&&signal==='SIGTERM')return;child.exitCode=0;child.signalCode=signal;queueMicrotask(()=>child.emit('exit',0,signal));};
    processes.push(child);setImmediate(()=>child.stderr.emit('data',Buffer.from('server started')));return child;
  };
  f.options.createWebSocket=()=>{
    ws=new EventEmitter();ws.readyState=1;ws.terminate=()=>{ws.readyState=3;ws.emit('close');};
    ws.send=raw=>{
      const m=JSON.parse(raw);requests.push(m);if(!m.method)return;
      queueMicrotask(()=>{
        if(m.method==='thread/start')f.send({id:m.id,result:{thread:{id:thread}}});
        else if(m.method==='turn/start'){
          turn++;f.send({id:m.id,result:{turn:{id:`turn-${turn}`}}});
          f.send({method:'turn/started',params:{threadId:thread,turn:{id:`turn-${turn}`}}});onTurn(turn,f);
        }else f.send({id:m.id,result:{}});
      });
    };
    setImmediate(()=>ws.emit('open'));return ws;
  };
  return f;
}

test('cancelling OAuth startup never starts a child or a model turn',{timeout:3000},async()=>{
  const auth=deferred(),entered=deferred(),controller=new AbortController(),f=fakeCodex();
  const done=assert.rejects(runCodex({...f.options,signal:controller.signal,oauth:()=>{entered.resolve();return auth.promise;}}),/Stopped/);
  await entered.promise;controller.abort(stoppedError());auth.resolve({accessToken:'fake',chatgptAccountId:'fake'});await done;
  assert.equal(f.processes.length,0);
});

test('interrupt with partial text is terminal and late tool results are suppressed',{timeout:3000},async()=>{
  const entered=deferred(),blocked=deferred(),events=[];let control,toolSignal;
  const f=fakeCodex((_n,f)=>f.tool('blocked'));
  const done=assert.rejects(runCodex({...f.options,checkDeliverables:true,onControl:c=>{if(c)control=c;},emit:e=>events.push(e),execute:async()=>{toolSignal=executionSignal();entered.resolve();await blocked.promise;return {late:true};}}),/Stopped/);
  await entered.promise;
  f.send({method:'item/completed',params:{threadId:'thread-1',item:{type:'agentMessage',text:'Partial answer'}}});
  await control.interrupt();await done;const before=events.length;
  blocked.resolve();await tick();
  assert.equal(toolSignal.aborted,true);assert.equal(events.length,before);
  assert.equal(f.requests.filter(r=>r.method==='turn/start').length,1);
  assert.equal(f.requests.filter(r=>r.id==='tool-1'&&r.result).length,0);
  assert.ok(f.processes.every(p=>p.exitCode!==null&&!existsSync(p.dir)));
});

test('an interrupted protocol completion never starts citation repair or a check',async()=>{
  const f=fakeCodex((_n,f)=>f.complete('Partial [99].','interrupted'));
  await assert.rejects(runCodex({...f.options,checkDeliverables:true,validateAnswer:()=>{throw new Error('bad citation');}}),/Stopped/);
  assert.equal(f.requests.filter(r=>r.method==='turn/start').length,1);
});

test('cancelling citation repair does not enter the deliverable check',{timeout:3000},async()=>{
  const entered=deferred(),controller=new AbortController();
  const f=fakeCodex((n,f)=>{if(n===1)f.complete('Invalid [99]');else entered.resolve();});
  const done=assert.rejects(runCodex({...f.options,signal:controller.signal,checkDeliverables:true,validateAnswer:()=>{throw new Error('bad citation');}}),/Stopped/);
  await entered.promise;controller.abort(stoppedError());await done;
  assert.equal(f.requests.filter(r=>r.method==='turn/start').length,2);
});

test('one root interrupt cancels all active lanes and prevents synthesis',{timeout:3000},async()=>{
  const started=deferred(),signals=[];let control;
  const agent=async({label,execute,onControl})=>{
    onControl({interrupt:async()=>{},steer:async()=>{}});
    if(label==='research'){
      await execute('acres_spawn_lanes',{lanes:[{title:'One',charter:'Evidence one'},{title:'Two',charter:'Evidence two'}]});
      assert.fail('must not synthesize after cancellation');
    }
    signals.push(executionSignal());if(signals.length===2)started.resolve();
    await abortable(new Promise(()=>{}));
  };
  const done=assert.rejects(research({message:'Research'}, {},()=>{},()=>{},c=>{if(c)control=c;},agent),/Stopped/);
  await started.promise;await control.interrupt();await done;
  assert.equal(signals.length,2);assert.ok(signals.every(s=>s.aborted));
});

test('warm daemon idle error disposes the child and directory exactly once',async()=>{
  await closeCodexPool();const f=fakeCodex();
  await runCodex({...f.options,secrets:{CODEX_BIN:'fake',CODEX_WARM_POOL:true}});
  f.ws.emit('error',new Error('idle transport failure'));await closeCodexPool();await closeCodexPool();
  assert.deepEqual(f.processes[0].kills,['SIGTERM']);assert.equal(existsSync(f.processes[0].dir),false);
});

test('a pooled socket error during OAuth checkout is handled and disposed',{timeout:3000},async()=>{
  const f=fakeCodex(),auth=deferred(),entered=deferred();
  await runCodex({...f.options,secrets:{CODEX_BIN:'fake',CODEX_WARM_POOL:true}});
  const done=assert.rejects(runCodex({...f.options,secrets:{CODEX_BIN:'fake',CODEX_WARM_POOL:true},oauth:()=>{entered.resolve();return auth.promise;}}),/pooled research harness stopped/);
  await entered.promise;f.ws.emit('error',new Error('checkout failure'));auth.resolve({accessToken:'fake',chatgptAccountId:'fake'});await done;await closeCodexPool();
  assert.equal(f.processes[0].exitCode,0);assert.equal(existsSync(f.processes[0].dir),false);
});

test('warm disposal escalates when SIGTERM does not stop the child',{timeout:4000},async()=>{
  const f=fakeCodex(undefined,{ignoreTerm:true});
  await runCodex({...f.options,secrets:{CODEX_BIN:'fake',CODEX_WARM_POOL:true}});
  await closeCodexPool();assert.deepEqual(f.processes[0].kills,['SIGTERM','SIGKILL']);assert.equal(existsSync(f.processes[0].dir),false);
});

test('idle error cleanup waits for a real daemon process to exit after SIGKILL',{timeout:5000},async()=>{
  const f=fakeCodex();let child,dir;
  f.options.spawnProcess=(_bin,_args,options)=>{
    dir=options.cwd;
    child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stderr.write('server started\\n');setInterval(()=>{},1000)"],{cwd:dir,stdio:['ignore','ignore','pipe']});
    return child;
  };
  try{
    await runCodex({...f.options,secrets:{CODEX_BIN:'fake',CODEX_WARM_POOL:true}});
    f.ws.emit('error',new Error('idle error'));await closeCodexPool();
    assert.equal(child.signalCode,'SIGKILL');assert.equal(existsSync(dir),false);
  }finally{if(child?.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}}
});

test('cold Composio initialization is single flight for both shared and account sessions',async t=>{
  const gate=deferred();let calls=0;
  const store=new SessionStore(join(temp(t),'sessions.sqlite'),{COMPOSIO_API_KEY:'fake-key-not-real-000000000'},async()=>{const n=++calls;await gate.promise;return {session_id:`session-${n}`};});t.after(()=>store.close());
  const pending=[store.forAccount('a'.repeat(24)),store.forAccount('b'.repeat(24)),store.forAccount('a'.repeat(24))];gate.resolve();
  const [a,b,again]=await Promise.all(pending);assert.equal(calls,3);assert.equal(a.exa,b.exa);assert.deepEqual(a,again);assert.equal(store.inFlight.size,0);
});

test('session failure is evicted and a cancelled waiter does not abort another account',async t=>{
  const gate=deferred(),controller=new AbortController();let calls=0;
  const store=new SessionStore(join(temp(t),'sessions.sqlite'),{COMPOSIO_API_KEY:'fake-key-not-real-000000000'},async()=>{calls++;await gate.promise;return {session_id:'shared'};});t.after(()=>store.close());
  const cancelled=assert.rejects(withExecutionSignal(controller.signal,()=>store.forService()),/Stopped/);
  const survivor=store.forService();controller.abort(stoppedError());gate.resolve();await cancelled;assert.equal(await survivor,'shared');assert.equal(calls,1);
  let attempts=0;store.request=async()=>{if(++attempts===1)throw new Error('temporary');return {session_id:'retry'};};
  await assert.rejects(store.session('other',{}),/temporary/);assert.equal(await store.session('other',{}),'retry');assert.equal(attempts,2);
});

function webFixture(t,respond) {
  const restore=installOfflinePublicWeb(),old=global.fetch;
  global.fetch=respond;t.after(()=>{global.fetch=old;restore();});
}
const html=()=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'text/html':null},body:(async function*(){yield Buffer.from('<main>'+'Verified text. '.repeat(40)+'</main>');})()});
const sharedTools=()=>{const shared={sources:[],retrievedParcels:new Map()};return {shared,a:createResearchTools({},()=>{},null,null,shared),b:createResearchTools({},()=>{},null,null,shared)};};

test('concurrent page and fragment reads share one dispatch and budget charge',async t=>{
  let calls=0;const gate=deferred();webFixture(t,async()=>{calls++;await gate.promise;return html();});
  const {a,b,shared}=sharedTools();const first=a.execute('acres_fetch_url',{url:'https://example.com/page'}),second=b.execute('acres_fetch_url',{url:'https://example.com/page#section'});gate.resolve();
  await Promise.all([first,second]);assert.equal(calls,1);assert.equal(shared.budget.used.fetch,1);assert.equal(shared.sources.length,1);assert.equal(shared.fetchesInFlight.size,0);
});

test('PDF and ordinary retrieval requirements do not share an incompatible flight',async t=>{
  let calls=0;const gate=deferred();webFixture(t,async()=>{calls++;await gate.promise;return html();});
  const {a,b,shared}=sharedTools();const first=a.execute('acres_fetch_url',{url:'https://example.com/document'}),second=assert.rejects(b.execute('acres_fetch_url',{url:'https://example.com/document',page:1}),/PDF/);gate.resolve();
  await Promise.all([first,second]);assert.equal(calls,2);assert.equal(shared.budget.used.fetch,2);
});

test('failed fetch is evicted and retry is charged once again',async t=>{
  let calls=0;webFixture(t,async()=>{if(++calls===1)throw new Error('offline failure');return html();});
  const {a,shared}=sharedTools();await assert.rejects(a.execute('acres_fetch_url',{url:'https://example.com/page'}),/offline failure/);
  await a.execute('acres_fetch_url',{url:'https://example.com/page'});assert.equal(calls,2);assert.equal(shared.budget.used.fetch,2);assert.equal(shared.fetchesInFlight.size,0);
});

test('cancelling one fetch waiter preserves the other and publishes no cancelled result',async t=>{
  const entered=deferred(),gate=deferred(),controller=new AbortController();let calls=0,providerSignal;
  webFixture(t,async(_url,options)=>{calls++;providerSignal=options.signal;entered.resolve();await gate.promise;return html();});
  const {a,b,shared}=sharedTools();const first=assert.rejects(withExecutionSignal(controller.signal,()=>a.execute('acres_fetch_url',{url:'https://example.com/page'})),/Stopped/);
  const second=b.execute('acres_fetch_url',{url:'https://example.com/page'});await entered.promise;controller.abort(stoppedError());await first;
  assert.equal(providerSignal.aborted,false);gate.resolve();await second;assert.equal(calls,1);assert.equal(shared.budget.used.fetch,1);
});

test('run cancellation aborts the provider and never retries another retrieval method',async()=>{
  const controller=new AbortController(),entered=deferred();let render=0,direct=0;
  const fetcher=createUrlFetcher({CLOUDFLARE_ACCOUNT_ID:'fake-account',CLOUDFLARE_API_TOKEN:'fake-token-not-real'}, {
    lookup:async()=>[{address:'93.184.216.34',family:4}],
    request:async(_url,{signal})=>{render++;entered.resolve();return abortable(new Promise(()=>{}),signal);},
    directRequest:async()=>{direct++;return html();},
  });
  const done=assert.rejects(withExecutionSignal(controller.signal,()=>fetcher({url:'https://example.com/page'})),/Stopped/);
  await entered.promise;controller.abort(stoppedError());await done;assert.equal(render,1);assert.equal(direct,0);
});

test('the last cancelled fetch waiter evicts the flight and cannot publish a source',async t=>{
  const gate=deferred(),entered=deferred(),controller=new AbortController();let signal;
  webFixture(t,async(_url,options)=>{signal=options.signal;entered.resolve();await gate.promise;return html();});
  const {a,shared}=sharedTools();
  const done=assert.rejects(withExecutionSignal(controller.signal,()=>a.execute('acres_fetch_url',{url:'https://example.com/page'})),/Stopped/);
  await entered.promise;controller.abort(stoppedError());await done;assert.equal(signal.aborted,true);assert.equal(shared.fetchesInFlight.size,0);
  gate.resolve();await tick();await tick();assert.equal(shared.sources.length,0);assert.equal(shared.fetchedPages.size,0);
});

test('cancelled drawing retrieval never reaches the persisted attachment write',async()=>{
  const gate=deferred(),entered=deferred(),controller=new AbortController();let writes=0;
  const drawings={store:{requireProject(){}},fetchDrawing:async()=>{entered.resolve();await gate.promise;return {bytes:Buffer.from('data'),finalUrl:'https://example.com/plan.pdf'};},add:()=>{writes++;}};
  const done=assert.rejects(withExecutionSignal(controller.signal,()=>Drawings.prototype.addFromUrl.call(drawings,'account','project',{url:'https://example.com/plan.pdf'})),/Stopped/);
  await entered.promise;controller.abort(stoppedError());gate.resolve();await done;assert.equal(writes,0);
});

test('a cancelled preflight never dispatches research or writes late events',async t=>{
  const dir=temp(t),store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>store.close());
  const gate=deferred(),entered=deferred();let executions=0;
  const manager=new RunManager(store,{},async()=>{executions++;return {answer:'late'};},null,{forAccount:async()=>{entered.resolve();await gate.promise;return {};}});
  const conversation=store.createConversation('alice'),run=manager.enqueue('alice',conversation.id,'Research');await entered.promise;
  const finished=new Promise(resolve=>manager.on(run.id,e=>{if(e.event==='run.interrupted')resolve();}));
  await manager.control('alice',run.id,'interrupt');await finished;const count=store.runEvents(run.id).length;
  gate.resolve();await tick();assert.equal(executions,0);assert.equal(store.runEvents(run.id).length,count);assert.equal(manager.active.size,0);
});

test('slow legacy bodies reserve the shared slots and release them to durable work',{timeout:5000},async t=>{
  const store=new ChatStore(join(temp(t),'chat.sqlite')),owner='a'.repeat(24),conversation=store.createConversation(owner),other=store.createConversation(owner),started=deferred(),gate=deferred();let starts=0;
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test',RESEARCH_CONCURRENCY:2},store,execute:async()=>{if(++starts===2)started.resolve();await gate.promise;return {answer:'Done',sources:[]};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{gate.resolve();await tick();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const pending=[];
  for(let n=0;n<2;n++){
    const arrived=once(server,'request');
    const request=http.request(base+'/research',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'}},response=>response.resume());
    request.on('error',()=>{});request.write('{');await arrived;pending.push(request);
  }
  const busy=await fetch(base+'/research',{method:'POST',headers:{authorization:'Bearer test'},body:'{}'});assert.equal(busy.status,429);
  const queued=await fetch(base+`/conversations/${conversation.id}/runs`,{method:'POST',headers:{authorization:'Bearer test','x-acres-account':owner,'content-type':'application/json'},body:JSON.stringify({message:'Research'})});
  assert.equal(queued.status,202);const run=await queued.json();assert.equal(store.runRow(run.id).status,'queued');
  const queuedOther=await fetch(base+`/conversations/${other.id}/runs`,{method:'POST',headers:{authorization:'Bearer test','x-acres-account':owner,'content-type':'application/json'},body:JSON.stringify({message:'Second research'})});assert.equal(queuedOther.status,202);
  // Invalid input finishes before trace creation, so this test touches no host trace directory.
  for(const request of pending)request.end('}');await started.promise;
  assert.equal(store.runRow(run.id).status,'running');
  const full=await fetch(base+'/research',{method:'POST',headers:{authorization:'Bearer test'},body:'{}'});assert.equal(full.status,429);
  gate.resolve();await tick();
});

const marketInput=value=>({submarket:'Test market',rents:[{bedrooms:0,rentPerSqftPerMonth:value,source:'User',retrievedAt:'2026-10-18'}]});
test('completed lane market inputs are available to lead unit mix and deck before final aggregation',async()=>{
  let laneMarket;
  const agent=async({label,execute})=>{
    if(label!=='research'){laneMarket=await execute('acres_market_inputs',marketInput(8));return 'Market inputs recorded.';}
    const spawn=await execute('acres_spawn_lanes',{lanes:[{title:'Market',charter:'Record market inputs',tools:['acres_market_inputs']}]});
    assert.deepEqual(spawn.stateMerge.conflicts,[]);
    const mix=await execute('acres_execute_capability',{name:'acres_unit_mix',arguments:{productType:'rental',residentialGrossSqft:10000,mixPercent:[100,0,0,0]}});
    assert.equal(mix.byBedrooms[0].rentPerSqftPerMonth,8);
    const deck=await execute('acres_execute_capability',{name:'acres_generate_deck',arguments:{}});
    assert.match(JSON.stringify(deck),/Test market/);return 'Inputs recorded.';
  };
  const result=await research({message:'Model the market'}, {},()=>{},()=>{},()=>{},agent);
  assert.equal(result.market.rents[0].rentPerSqftPerMonth,laneMarket.rents[0].rentPerSqftPerMonth);
});

test('conflicting lane markets block dependent tools until the lead explicitly resolves them',async()=>{
  const agent=async({label,execute})=>{
    if(label!=='research'){await execute('acres_market_inputs',marketInput(label.endsWith('one')?7:9));return 'Recorded.';}
    const spawn=await execute('acres_spawn_lanes',{lanes:[{title:'One',charter:'Market one',tools:['acres_market_inputs']},{title:'Two',charter:'Market two',tools:['acres_market_inputs']}]});
    assert.ok(spawn.stateMerge.conflicts.some(c=>c.field==='market'&&c.resolution==='unresolved'));
    await assert.rejects(execute('acres_execute_capability',{name:'acres_unit_mix',arguments:{residentialGrossSqft:10000}}),/disagree/);
    await execute('acres_execute_capability',{name:'acres_market_inputs',arguments:marketInput(8)});
    const mix=await execute('acres_execute_capability',{name:'acres_unit_mix',arguments:{productType:'rental',residentialGrossSqft:10000,mixPercent:[100,0,0,0]}});assert.equal(mix.byBedrooms[0].rentPerSqftPerMonth,8);
    return 'Inputs resolved.';
  };
  const out=await research({message:'Compare market inputs'}, {},()=>{},()=>{},()=>{},agent);assert.equal(out.market.rents[0].rentPerSqftPerMonth,8);
});

test('lane merging excludes failed and other-subject state and rejects unknown citation references',()=>{
  const lead={status:'completed',tools:{property:{bbl:'1000010001'}},aux:{}};
  const lane=(id,status,bbl,market)=>({id,status,tools:{property:{bbl}},aux:{marketTools:{market}}});
  const out=mergeLaneState(lead,[lane('failed','failed','1000010001',{rents:[{sourceId:1}]}),lane('other','completed','2000010001',{rents:[{sourceId:1}]}),lane('invalid','completed','1000010001',{rents:[{sourceId:99}]})],null,[{id:1}]);
  assert.equal(out.state.market,null);assert.deepEqual(out.excludedLanes,['other']);assert.ok(out.conflicts.some(c=>c.field==='market'&&c.resolution==='unresolved'));
});

test('lane merging preserves scenario objects and their stable citation identities',()=>{
  const program={id:'program-a',productType:'rental',annualGrossRent:123,sourceIds:[1]},scenario={id:'scenario-a',sourceId:1,program,inputs:{label:'Original assumptions'},noi:456};
  const lead={status:'completed',tools:{},aux:{}};
  const lanes=[{id:'market',status:'completed',tools:{},aux:{marketTools:{market:{submarket:'New inputs'}}}},{id:'model',status:'completed',tools:{},aux:{marketTools:{program},proFormaTools:{proFormas:[scenario]}}}];
  const out=mergeLaneState(lead,lanes,null,[{id:1}]);assert.equal(out.state.program,program);assert.equal(out.state.proFormas[0],scenario);assert.deepEqual(out.conflicts,[]);
  program.sourceIds=[99];const invalid=mergeLaneState(lead,lanes,null,[{id:1}]);assert.equal(invalid.state.program,null);assert.deepEqual(invalid.state.proFormas,[]);
});
