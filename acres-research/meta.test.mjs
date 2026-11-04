import test from 'node:test';
import assert from 'node:assert/strict';
import {runMeta,streamEvents,META_MODEL} from './meta.mjs';
import {researchEngine} from './service.mjs';
import {research} from './research.mjs';
import {runCodex} from './codex.mjs';

const secrets={MODEL_API_KEY:'test-key'};
const tool={name:'acres_lookup',description:'Look up a lot.',inputSchema:{type:'object',properties:{bbl:{type:'string'}},required:['bbl'],additionalProperties:false}};
const usage=(input,output)=>({input_tokens:input,input_tokens_details:{cached_tokens:10},output_tokens:output,output_tokens_details:{reasoning_tokens:5},total_tokens:input+output});

function sse(events,{split=false}={}) {
  const text=events.map(event=>`data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const chunks=split?[text.slice(0,7),text.slice(7)]:[text];
  return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}),{status:200,headers:{'content-type':'text/event-stream'}});
}
const calling=(id,calls)=>sse([
  {type:'response.created',response:{id}},
  ...calls.map(([call_id,name,args])=>({type:'response.output_item.done',item:{type:'function_call',call_id,name,arguments:JSON.stringify(args)}})),
  {type:'response.completed',response:{id,usage:usage(100,20)}},
]);
const answering=(id,text)=>sse([
  {type:'response.created',response:{id}},
  {type:'response.output_item.added',item:{type:'message',id:`${id}-m`}},
  {type:'response.output_text.delta',item_id:`${id}-m`,delta:text},
  {type:'response.output_item.done',item:{type:'reasoning',id:`${id}-r`,summary:[{type:'summary_text',text:'**Reading the lot**'}]}},
  {type:'response.output_item.done',item:{type:'message',id:`${id}-m`,content:[{type:'output_text',text}]}},
  {type:'response.completed',response:{id,usage:usage(200,40)}},
],{split:true});

// A fetch double that answers each request with the next scripted response and keeps the bodies.
function scripted(...responses) {
  const requests=[];
  const fetch=async(url,init)=>{
    requests.push({url,headers:init.headers,body:JSON.parse(init.body),signal:init.signal});
    const next=responses.shift();
    return typeof next==='function'?next(init):next;
  };
  return {fetch,requests};
}

test('a tool call round trip replays its call and result without stored responses',async()=>{
  const {fetch,requests}=scripted(calling('r1',[['c1','acres_lookup',{bbl:'3012340056'}]]),answering('r2','R6B allows 2.2 FAR.'));
  const events=[],executed=[];
  const answer=await runMeta({message:'What is the zoning of this lot?',secrets,dynamicTools:[tool],includeSkill:false,fetch,
    execute:async(name,args)=>{executed.push([name,args]);return {zoning:'R6B'};},emit:(event,data)=>events.push([event,data])});
  assert.equal(answer,'R6B allows 2.2 FAR.');
  assert.deepEqual(executed,[['acres_lookup',{bbl:'3012340056'}]]);
  assert.equal(requests[0].url,'https://api.meta.ai/v1/responses');
  assert.equal(requests[0].headers.authorization,'Bearer test-key');
  assert.equal(requests[0].body.model,META_MODEL);
  assert.equal(requests[0].body.stream,true);
  assert.deepEqual(requests[0].body.tools.find(t=>t.name==='acres_lookup'),{type:'function',name:'acres_lookup',description:'Look up a lot.',parameters:tool.inputSchema});
  assert.equal(requests[0].body.previous_response_id,undefined);
  assert.equal(requests[1].body.previous_response_id,undefined);
  assert.equal(requests[1].body.store,false);
  assert.deepEqual(requests[1].body.include,['reasoning.encrypted_content']);
  assert.ok(requests[1].body.instructions,'instructions go with every request');
  const output=requests[1].body.input.find(item=>item.type==='function_call_output');
  assert.equal(requests[1].body.input.find(item=>item.type==='function_call').call_id,'c1');
  assert.equal(output.type,'function_call_output');assert.equal(output.call_id,'c1');
  assert.deepEqual(JSON.parse(output.output),{zoning:'R6B'});
  assert.deepEqual(events.filter(([e])=>e==='tool.completed').map(([,d])=>[d.tool,d.success]),[['acres_lookup',true]]);
  assert.deepEqual(events.find(([e])=>e==='message.completed')[1],{id:'r2-m',phase:'final_answer',text:'R6B allows 2.2 FAR.'});
  assert.deepEqual(events.find(([e])=>e==='agent.phaseSummary')[1].summary,['**Reading the lot**']);
  const billed=events.filter(([e])=>e==='billing.usage').map(([,d])=>d);
  assert.ok(billed.every(d=>d.provider==='meta'&&d.usageSemantics==='cumulative'&&d.model===META_MODEL));
  assert.deepEqual(billed.at(-1).usage,{inputTokens:300,cachedInputTokens:20,outputTokens:60,reasoningOutputTokens:10});
  assert.deepEqual(events.filter(([e])=>e.startsWith('billing.agent')).map(([e,d])=>[e,d.outcome]),[['billing.agent.started',undefined],['billing.agent.completed','completed']]);
  assert.ok(events.filter(([e])=>e.startsWith('billing.agent')).every(([,d])=>d.model===META_MODEL));
});

test('Muse Wonder uses its Model API name',async()=>{
  const {fetch,requests}=scripted(answering('r1','Done.'));
  await runMeta({message:'q',secrets:{...secrets,META_MODEL:'muse-wonder-1.0'},includeSkill:false,fetch,execute:async()=>({})});
  assert.equal(requests[0].body.model,'muse-wonder-1.0');
});

test('Meta contributor API models remain supported',()=>{
  assert.equal(typeof researchEngine({RESEARCH_ENGINE:'meta',MODEL_API_KEY:'fixture',META_MODEL:'muse-spark-1.2-contributor'}),'function');
  assert.equal(typeof researchEngine({RESEARCH_ENGINE:'meta',MODEL_API_KEY:'fixture',META_MODEL:'muse-spark-1.3-contributor'}),'function');
});

test('unsupported Meta models fail before dispatch or usage',async()=>{
  let dispatched=0;
  const events=[];
  await assert.rejects(runMeta({message:'q',secrets:{...secrets,META_MODEL:'muse-wonder-full'},includeSkill:false,
    fetch:async()=>{dispatched++;throw new Error('must not dispatch');},execute:async()=>({}),emit:(event,data)=>events.push([event,data])}),/Wonder Full.*not through the Meta Model API/);
  assert.equal(dispatched,0);
  assert.deepEqual(events,[]);
  assert.throws(()=>researchEngine({RESEARCH_ENGINE:'meta',MODEL_API_KEY:'fixture',META_MODEL:'unlisted-model'}),/not supported/);
});

test('encrypted reasoning is replayed with the tool call and never replaced with a bare id',async()=>{
  const first=sse([
    {type:'response.created',response:{id:'r1'}},
    {type:'response.output_item.done',item:{type:'reasoning',id:'rs_1',summary:[],encrypted_content:'opaque'}},
    {type:'response.output_item.done',item:{type:'function_call',call_id:'c1',name:'acres_lookup',arguments:'{}'}},
    {type:'response.completed',response:{id:'r1',usage:usage(10,1)}}
  ]);
  const {fetch,requests}=scripted(first,answering('r2','Done.'));
  await runMeta({message:'q',secrets,dynamicTools:[tool],includeSkill:false,fetch,execute:async()=>({})});
  assert.deepEqual(requests[1].body.input.find(item=>item.type==='reasoning'),{type:'reasoning',id:'rs_1',summary:[],encrypted_content:'opaque'});
});

test('a tool outside the run and malformed arguments go back to the model as errors, never executed',async()=>{
  const {fetch,requests}=scripted(
    sse([{type:'response.created',response:{id:'r1'}},
      {type:'response.output_item.done',item:{type:'function_call',call_id:'c1',name:'shell_exec',arguments:'{"cmd":"ls"}'}},
      {type:'response.output_item.done',item:{type:'function_call',call_id:'c2',name:'acres_lookup',arguments:'{bbl:'}},
      {type:'response.completed',response:{id:'r1',usage:usage(10,1)}}]),
    answering('r2','Done.'));
  let executed=0;
  await runMeta({message:'q',secrets,dynamicTools:[tool],includeSkill:false,fetch,execute:async()=>{executed++;return {};}});
  assert.equal(executed,0);
  const outputs=requests[1].body.input.filter(item=>item.type==='function_call_output').map(item=>[item.call_id,JSON.parse(item.output)]);
  assert.match(outputs[0][1].error,/shell_exec is not a tool of this run/);
  assert.equal(outputs[0][1].retryable,false);
  assert.match(outputs[1][1].error,/not valid JSON/);
});

test('the wallet authorizes the first request only, and the engine names its provider',async()=>{
  const {fetch}=scripted(calling('r1',[['c1','acres_lookup',{bbl:'1'}]]),answering('r2','Done.'));
  let dispatches=0;
  await runMeta({message:'q',secrets,dynamicTools:[tool],includeSkill:false,fetch,execute:async()=>({}),invokeProvider:fn=>{dispatches++;return fn();}});
  assert.equal(dispatches,1);
  assert.equal(runMeta.provider,'meta');
  assert.equal(runMeta.handlesProviderDispatch,true);
});

test('an interrupt aborts the request in flight and the run reports it stopped',async()=>{
  let control,aborted;
  const {fetch}=scripted(calling('r1',[['c1','acres_lookup',{bbl:'1'}]]),init=>new Promise((_,reject)=>{
    aborted=init.signal;init.signal.addEventListener('abort',()=>reject(init.signal.reason));
    queueMicrotask(()=>control.interrupt());
  }));
  const events=[];
  await assert.rejects(runMeta({message:'q',secrets,dynamicTools:[tool],includeSkill:false,fetch,execute:async()=>({}),onControl:value=>{control??=value;},emit:(event,data)=>events.push([event,data])}),/Stopped/);
  assert.equal(aborted.aborted,true);
  assert.equal(events.find(([e])=>e==='billing.agent.completed')[1].outcome,'failed');
});

test('a steer during a tool call joins the next request as a user message',async()=>{
  let control;
  const {fetch,requests}=scripted(calling('r1',[['c1','acres_lookup',{bbl:'1'}]]),answering('r2','Done.'));
  await runMeta({message:'q',secrets,dynamicTools:[tool],includeSkill:false,fetch,onControl:value=>{control??=value;},
    execute:async()=>{await control.steer('Focus on the rear yard.');return {};}});
  const steer=requests[1].body.input.findLast(item=>item.role==='user');
  assert.deepEqual(steer.content,[{type:'input_text',text:'Focus on the rear yard.'}]);
  await assert.rejects(control.steer('late'),/finished/);
});

test('a citation failure gets one repair turn in the same conversation',async()=>{
  const {fetch,requests}=scripted(answering('r1','The lot is R6B [9].'),answering('r2','The lot is R6B [1].'));
  const events=[];
  const answer=await runMeta({message:'q',secrets,dynamicTools:[tool],includeSkill:false,fetch,execute:async()=>({}),emit:(event,data)=>events.push([event,data]),
    getSources:()=>[{id:1,title:'PLUTO',url:'https://example.test',text:'R6B'}],
    validateAnswer:text=>{if(text.includes('[9]'))throw new Error('Unknown citation [9].');}});
  assert.equal(answer,'The lot is R6B [1].');
  assert.equal(requests[1].body.previous_response_id,undefined);
  assert.match(requests[1].body.input.findLast(item=>item.role==='user').content[0].text,/failed citation validation \(Unknown citation \[9\]\.\)/);
  assert.ok(events.some(([e])=>e==='turn.repair'));
});

test('an API error is actionable and does not expose a provider body',async()=>{
  const raw='invalid model Bearer super-secret-value';
  const {fetch}=scripted(new Response(JSON.stringify({error:{message:raw}}),{status:400}));
  await assert.rejects(runMeta({message:'q',secrets,includeSkill:false,fetch,execute:async()=>({})}),error=>{
    assert.match(error.message,/rejected this request/);
    assert.ok(!error.message.includes(raw));
    assert.ok(!error.message.includes('super-secret-value'));
    return true;
  });
});

test('Meta HTTP failures identify the recovery path without provider details',async()=>{
  for(const [status,message] of [[401,/authenticate/],[404,/configured model/],[429,/rate limit/],[503,/temporarily unavailable/]]) {
    const raw=`provider detail Bearer secret-${status}`;
    const {fetch}=scripted(new Response(raw,{status}));
    await assert.rejects(runMeta({message:'q',secrets,includeSkill:false,fetch,execute:async()=>({})}),error=>{
      assert.match(error.message,message);
      assert.ok(!error.message.includes(raw));
      return true;
    });
  }
});

test('wallet errors and abort reasons are preserved while fetch failures are sanitized',async()=>{
  const walletError=Object.assign(new Error('wallet reconciliation required'),{name:'WalletAuthorizationError',code:'wallet_pending'});
  await assert.rejects(runMeta({message:'q',secrets,includeSkill:false,fetch:async()=>{throw new Error('must not fetch');},execute:async()=>({}),invokeProvider:()=>{throw walletError;}}),error=>error===walletError);
  const controller=new AbortController();
  const abortReason=Object.assign(new Error('Stopped by the user.'),{name:'AbortError',retryable:false});
  const aborted=runMeta({message:'q',secrets,includeSkill:false,signal:controller.signal,fetch:async(_url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    queueMicrotask(()=>controller.abort(abortReason));
  }),execute:async()=>({})});
  await assert.rejects(aborted,error=>error===abortReason);
  await assert.rejects(runMeta({message:'q',secrets,includeSkill:false,fetch:async()=>{throw new Error('network token secret-value');},execute:async()=>({})}),error=>{
    assert.match(error.message,/could not be completed/);
    assert.ok(!error.message.includes('secret-value'));
    return true;
  });
});

test('malformed and broken Meta streams do not expose provider details',async()=>{
  const raw='stream token secret-value';
  const malformed=new Response(`data: {"type":"response.completed","${raw}":\n\n`,{status:200,headers:{'content-type':'text/event-stream'}});
  const broken=new Response(new ReadableStream({start(controller){controller.error(new Error(raw));}}),{status:200,headers:{'content-type':'text/event-stream'}});
  for(const response of [malformed,broken]) {
    const {fetch}=scripted(response);
    await assert.rejects(runMeta({message:'q',secrets,includeSkill:false,fetch,execute:async()=>({})}),error=>{
      assert.match(error.message,/stream failed/);
      assert.ok(!error.message.includes(raw));
      return true;
    });
  }
});

test('a failed response stream fails the run',async()=>{
  const {fetch}=scripted(sse([{type:'response.created',response:{id:'r1'}},{type:'response.failed',response:{id:'r1',error:{message:'overloaded'}}}]));
  await assert.rejects(runMeta({message:'q',secrets,includeSkill:false,fetch,execute:async()=>({})}),/stream failed/);
});

test('the skill and the question go in the first request',async()=>{
  const {fetch,requests}=scripted(answering('r1','Done.'));
  await runMeta({message:'Could this lot hold more homes?',secrets,dynamicTools:[tool],fetch,execute:async()=>({})});
  const parts=requests[0].body.input[0].content.map(part=>part.text);
  assert.match(parts[0],/Could this lot hold more homes\?/);
  assert.match(parts[1],/name: creative-zoning/);
});

test('stream events are parsed across chunk boundaries and CRLF line endings',async()=>{
  const seen=[];
  for await (const event of streamEvents(answering('r1','Hi.').body))seen.push(event.type);
  assert.deepEqual(seen,['response.created','response.output_item.added','response.output_text.delta','response.output_item.done','response.output_item.done','response.completed']);
});

test('the service validates the optional Modeling engine and its key',()=>{
  assert.equal(typeof researchEngine({}),'function');
  assert.equal(typeof researchEngine({MODELING_RESEARCH_ENGINE:'meta',MODEL_API_KEY:'k'}),'function');
  assert.throws(()=>researchEngine({MODELING_RESEARCH_ENGINE:'meta'}),/MODEL_API_KEY/);
  assert.throws(()=>researchEngine({MODELING_RESEARCH_ENGINE:'meta',MODEL_API_KEY:''}),/MODEL_API_KEY/);
  assert.throws(()=>researchEngine({MODELING_RESEARCH_ENGINE:'llama'}),/codex or meta/);
});

test('Meta is confined to Modeling while underwriting and direct research use Codex',async()=>{
  const seen=[];
  const run=researchEngine({MODELING_RESEARCH_ENGINE:'meta',MODEL_API_KEY:'k'},async(...args)=>seen.push(args[5]));
  await run({workflow:'modeling'},{});
  await run({workflow:'underwriting'},{});
  await run({},{});
  assert.deepEqual(seen,[runMeta,runCodex,runCodex]);
});

test('the public setup can use Meta for both independent workflows and direct research',async()=>{
  const seen=[];
  const run=researchEngine({RESEARCH_ENGINE:'meta',MODEL_API_KEY:'fixture'},async(...args)=>seen.push([args[0],args[5]]));
  for(const workflow of ['modeling','underwriting',undefined])await run({workflow,projectId:workflow||'research'},{});
  assert.deepEqual(seen.map(row=>row[1]),[runMeta,runMeta,runMeta]);
  assert.deepEqual(seen.map(row=>row[0].projectId),['modeling','underwriting','research']);
  assert.throws(()=>researchEngine({RESEARCH_ENGINE:'meta'}),/MODEL_API_KEY/);
  assert.throws(()=>researchEngine({UNDERWRITING_RESEARCH_ENGINE:'unknown'}),/codex or meta/);
});

test('workflow provider overrides remain independent',async()=>{
  const seen=[];
  const run=researchEngine({RESEARCH_ENGINE:'meta',UNDERWRITING_RESEARCH_ENGINE:'codex',MODEL_API_KEY:'fixture'},async(...args)=>seen.push(args[5]));
  await run({workflow:'modeling'},{});await run({workflow:'underwriting'},{});await run({},{});
  assert.deepEqual(seen,[runMeta,runCodex,runMeta]);
});

test('research meters each agent call under the engine provider',async()=>{
  const operations=[];
  const meter={async authorize(provider,operation){operations.push([provider,operation]);return {invoke:fn=>fn(),settle:async()=>{},pending:async()=>{}};}};
  const agent=Object.assign(async()=>'Answer.',{provider:'meta'});
  await research({message:'What is the zoning?',meter},{},()=>{},()=>{},()=>{},agent);
  assert.deepEqual(operations.filter(([provider])=>provider==='meta'),[['meta','meta_research']]);
  assert.ok(!operations.some(([provider])=>provider==='codex'));
});
