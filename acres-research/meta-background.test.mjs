import test from 'node:test';
import assert from 'node:assert/strict';
import {MetaBackgroundProvider,MetaBackgroundError,normalizeMetaResponse,metaUsageRecord} from './meta-background.mjs';

const secrets={MODEL_API_KEY:'fixture-key',META_MODEL:'muse-spark-1.3'};
const response=(status='completed',extra={})=>({id:'resp_1',object:'response',model:'muse-spark-1.3',background:true,status,output:[],usage:null,...extra});
const json=value=>({ok:true,status:200,json:async()=>value});
const signal=()=>new AbortController().signal;
const stream=(events,{chunkSize=19,tail='data: [DONE]\n\n'}={})=>{
  const encoded=new TextEncoder().encode(events.map(event=>`data: ${JSON.stringify(event)}\r\n\r\n`).join('')+tail);
  return {ok:true,status:200,body:new ReadableStream({start(controller){for(let i=0;i<encoded.length;i+=chunkSize)controller.enqueue(encoded.slice(i,i+chunkSize));controller.close();}})};
};
const collect=async iterator=>{const out=[];for await(const item of iterator)out.push(item);return out;};

test('stream completion races returning JSON reconcile by ID and retain the cursor',async()=>{
  let cancelled=false;
  const provider=new MetaBackgroundProvider(secrets,{streamRequest:async()=>({ok:true,status:200,contentType:'application/json; charset=utf-8',body:new ReadableStream({cancel(){cancelled=true;}})}),fetch:async()=>json(response('completed',{output:[{type:'message',content:[{type:'output_text',text:'Saved answer',annotations:[]}]}]}))});
  const events=await collect(provider.events('resp_1','3',signal()));
  assert.equal(cancelled,true);assert.equal(events.length,1);assert.equal(events[0].cursor,'3');
  assert.equal(events[0].event.status,'completed');assert.equal(events[0].event.response.output_text,'Saved answer');
});

test('JSON and clean empty streams wait for the original active response without spending reconnect attempts',async()=>{
  for(const jsonMode of [true,false]){
    let gets=0,streams=0,waits=0;
    const provider=new MetaBackgroundProvider(secrets,{
      streamRequest:async()=>{streams++;return jsonMode?{...stream([]),contentType:'application/json'}:stream([]);},
      fetch:async(url,options)=>{assert.equal(options.method,'GET');assert.ok(url.endsWith('/resp_1'));return json(response(++gets<8?'in_progress':'completed'));},
      wait:async(ms,_value,{signal})=>{assert.equal(ms,3000);signal.throwIfAborted();waits++;}
    });
    const events=await collect(provider.events('resp_1','4',signal()));
    assert.equal(streams,1);assert.equal(gets,8);assert.equal(waits,7);
    assert.deepEqual(events.map(item=>[item.cursor,item.event.status]),[['4','in_progress'],['4','completed']]);
  }
});

test('active JSON retrieval respects the caller cancellation and preserves the response identity',async()=>{
  const controller=new AbortController();let gets=0;
  const provider=new MetaBackgroundProvider(secrets,{
    streamRequest:async()=>({...stream([]),contentType:'application/json'}),
    fetch:async()=>{gets++;return json(response('in_progress'));},
    wait:async(_ms,_value,{signal})=>{controller.abort(new Error('deadline reached'));signal.throwIfAborted();}
  });
  await assert.rejects(collect(provider.events('resp_1',null,controller.signal)),/deadline reached/);
  assert.equal(gets,1);
});

test('create dispatches one stored background response with hosted search evidence',async()=>{
  const requests=[];
  const provider=new MetaBackgroundProvider({...secrets,META_BASE_URL:'https://meta.example/v1/'},{fetch:async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return json(response('queued'));}});
  const result=await provider.create('Find current public records',{instructions:'Cite the sources.',reasoning:{effort:'high'},metadata:{job:'one'}});
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://meta.example/v1/responses');
  assert.deepEqual(requests[0].body,{model:secrets.META_MODEL,input:'Find current public records',background:true,store:true,stream:false,tools:[{type:'web_search'}],include:['web_search_call.results'],instructions:'Cite the sources.',reasoning:{effort:'high'},metadata:{job:'one'}});
  assert.equal(requests[0].options.headers.authorization,'Bearer fixture-key');assert.equal(requests[0].options.redirect,'error');
  assert.equal(result.provider,'meta');assert.equal(result.id,'resp_1');assert.equal(result.status,'queued');assert.equal(result.usageRecord,null);
});

test('continuations resend instructions and only caller-supplied new input',async()=>{
  let body;
  const provider=new MetaBackgroundProvider(secrets,{fetch:async(_url,options)=>{body=JSON.parse(options.body);return json(response('queued'));}});
  const input=[{type:'function_call_output',call_id:'call_1',output:'Evidence'}];
  await assert.rejects(provider.create(input,{previousResponseId:'resp_prior'}),/Resend instructions/);
  await provider.create(input,{instructions:'Cite sources.',previousResponseId:'resp_prior',tools:[],text:{format:{type:'json_object'}}});
  assert.deepEqual(body.input,input);assert.equal(body.previous_response_id,'resp_prior');assert.equal(body.instructions,'Cite sources.');assert.equal(body.include,undefined);assert.deepEqual(body.text,{format:{type:'json_object'}});
});

test('invalid configuration, oversize bodies and pre-dispatch cancellation make no request',async()=>{
  let requests=0;
  assert.throws(()=>new MetaBackgroundProvider({}),/MODEL_API_KEY/);
  assert.throws(()=>new MetaBackgroundProvider({...secrets,META_MODEL:'muse-wonder-full'}),/Muse Code/);
  assert.throws(()=>new MetaBackgroundProvider({...secrets,META_BASE_URL:'http://meta.example/v1'}),/HTTPS/);
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>{requests++;}});
  await assert.rejects(provider.create('é'.repeat(1024*1024)),/1 MiB/);
  const controller=new AbortController();controller.abort(new Error('stopped before dispatch'));
  await assert.rejects(provider.create('Question',{signal:controller.signal}),/stopped before dispatch/);
  assert.equal(requests,0);
});

test('an interrupted or unparseable POST remains ambiguous and is never retried',async()=>{
  for(const request of [async()=>{throw new Error('connection closed');},async()=>({ok:true,json:async()=>{throw new Error('bad JSON');}}),async()=>json({status:'queued'})]) {
    let calls=0;
    const provider=new MetaBackgroundProvider(secrets,{fetch:async(...args)=>{calls++;return request(...args);}});
    await assert.rejects(provider.create('Question'),error=>error instanceof MetaBackgroundError&&error.ambiguous===true);
    assert.equal(calls,1);
  }
});

test('HTTP dispatch ambiguity distinguishes server errors and explicit request rejections',async()=>{
  for(const [status,ambiguous] of [[400,false],[401,false],[403,false],[429,false],[408,true],[500,true],[504,true]]) {
    let calls=0;
    const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>{calls++;return {ok:false,status};}});
    await assert.rejects(provider.create('Question'),error=>error.statusCode===status&&error.ambiguous===ambiguous);
    assert.equal(calls,1);
  }
});

test('a malformed acknowledged response retains its known ID for recovery',async()=>{
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>json({id:'resp_1',status:'queued'})});
  await assert.rejects(provider.create('Question'),error=>error.ambiguous&&error.responseId==='resp_1');
});

test('GET retries temporary persistence 404s within a bounded budget',async()=>{
  let attempts=0;const waits=[];
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>++attempts<3?{ok:false,status:404}:json(response()),retrieveRetryDelays:[10,20],wait:async ms=>waits.push(ms)});
  assert.equal((await provider.get('resp_1')).status,'completed');assert.equal(attempts,3);assert.deepEqual(waits,[10,20]);
  attempts=0;waits.length=0;
  provider.request=async()=>{attempts++;return {ok:false,status:404};};
  await assert.rejects(provider.get('resp_1'),error=>error.statusCode===404&&!error.ambiguous);
  assert.equal(attempts,3);assert.deepEqual(waits,[10,20]);
});

test('GET does not retry other failures and rejects a mismatched identity',async()=>{
  let calls=0;
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>{calls++;return {ok:false,status:503};}});
  await assert.rejects(provider.get('resp_1'),error=>error.statusCode===503&&!error.ambiguous);assert.equal(calls,1);
  provider.request=async()=>json(response('completed',{id:'resp_other'}));
  await assert.rejects(provider.get('resp_1'),error=>error.responseId==='resp_1');
});

test('cancellation races return authoritative output and usage rather than the empty acknowledgment',async()=>{
  const final=response('completed',{output:[{type:'message',content:[{type:'output_text',text:'Saved result',annotations:[]}]}],usage:{input_tokens:50,output_tokens:12,total_tokens:62}});
  const calls=[];
  const provider=new MetaBackgroundProvider(secrets,{fetch:async(url,options)=>{calls.push({url,method:options.method});return json(options.method==='POST'?response('completed'):final);}});
  const result=await provider.cancel('resp_1');
  assert.deepEqual(calls.map(call=>call.method),['POST','GET']);assert.ok(calls[0].url.endsWith('/resp_1/cancel'));
  assert.equal(result.output_text,'Saved result');assert.deepEqual(result.usage,final.usage);assert.equal(result.usageRecord.id,'meta:resp_1');
});

test('failed cancellation reconciliation never returns an empty completed report',async()=>{
  const provider=new MetaBackgroundProvider(secrets,{fetch:async(_url,options)=>options.method==='POST'?json(response('completed')):{ok:false,status:503}});
  await assert.rejects(provider.cancel('resp_1'),error=>error.statusCode===503);
});

test('normalization retains native character citations, search evidence and cumulative usage identity',()=>{
  const native=response('completed',{output:[
    {type:'web_search_call',id:'search_1',status:'completed',action:{type:'search',queries:['zoning']},results:[{url:'https://city.example/zoning',title:'Zoning',snippet:'Current rules'}]},
    {type:'message',content:[{type:'output_text',text:'Café housing',annotations:[{type:'url_citation',url:'https://city.example/zoning',title:'Zoning',start_index:0,end_index:4}]}]}
  ],usage:{input_tokens:100,input_tokens_details:{cached_tokens:20},output_tokens:40,output_tokens_details:{reasoning_tokens:12},total_tokens:140}});
  const result=normalizeMetaResponse(native);
  assert.equal(result.output_text,'Café housing');assert.deepEqual(result.output,native.output);assert.deepEqual(result.usage,native.usage);
  assert.deepEqual(result.citations,[{...native.output[1].content[0].annotations[0],outputIndex:1,contentIndex:0}]);
  assert.deepEqual(result.searchCalls,[native.output[0]]);
  assert.deepEqual(result.usageRecord,{id:'meta:resp_1',provider:'meta',responseId:'resp_1',model:secrets.META_MODEL,semantics:'cumulative_per_response',usage:{inputTokens:100,cachedInputTokens:20,outputTokens:40,reasoningOutputTokens:12}});
  // A durable consumer upserts by this stable key across GETs, replays and restart.
  const ledger=new Map();for(const item of [native,native,{...native,usage:{...native.usage,output_tokens:50}}]){const record=metaUsageRecord(item);ledger.set(record.id,record);}
  assert.equal(ledger.size,1);assert.equal(ledger.get('meta:resp_1').usage.outputTokens,50);
  assert.equal(metaUsageRecord(response()),null);
});

test('SSE resumes by stored sequence, ignores heartbeat counters and skips replayed events',async()=>{
  let streamUrl;let gets=0;
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>{gets++;return json(response('completed'));},streamRequest:async url=>{streamUrl=url;return stream([
    {type:'keepalive',sequence_number:999},
    {type:'response.created',sequence_number:4,response:response('in_progress')},
    {type:'response.in_progress',sequence_number:5,response:response('in_progress')},
    {type:'response.completed',sequence_number:6,response:response('completed')}
  ]);}});
  const events=await collect(provider.events('resp_1','4',signal()));
  assert.equal(new URL(streamUrl).searchParams.get('starting_after'),'4');assert.equal(new URL(streamUrl).searchParams.get('stream'),'true');
  assert.deepEqual(events.map(item=>item.cursor),['5','6']);assert.equal(events.at(-1).event.response.provider,'meta');assert.equal(gets,1);
});

test('SSE preserves cursor zero and replaces terminal payload with final GET state',async()=>{
  let url;
  const final=response('completed',{output:[{type:'message',content:[{type:'output_text',text:'Authoritative saved report',annotations:[]}]}]});
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>json(final),streamRequest:async value=>{url=value;return stream([{type:'response.completed',sequence_number:1,response:response('completed')}]);}});
  const events=await collect(provider.events('resp_1',0,signal()));
  assert.equal(new URL(url).searchParams.get('starting_after'),'0');assert.equal(events[0].event.response.output_text,'Authoritative saved report');
});

test('SSE terminal reconciliation retries lagging persistence and never trusts the event alone',async()=>{
  let gets=0;
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>++gets===1?{ok:false,status:404}:json(response('incomplete')),wait:async()=>{},streamRequest:async()=>stream([{type:'response.completed',sequence_number:2,response:response('completed')}])});
  const events=await collect(provider.events('resp_1',null,signal()));
  assert.equal(gets,2);assert.equal(events[0].event.type,'response.incomplete');assert.equal(events[0].event.status,'incomplete');
});

test('SSE ending without a terminal event reconciles stored state',async()=>{
  const provider=new MetaBackgroundProvider(secrets,{fetch:async()=>json(response('completed')),streamRequest:async()=>stream([{type:'keepalive',sequence_number:99}])});
  const events=await collect(provider.events('resp_1',null,signal()));
  assert.equal(events.length,1);assert.equal(events[0].cursor,null);assert.equal(events[0].event.type,'response.retrieved');assert.equal(events[0].event.status,'completed');
});

test('SSE rejects corrupt or mismatched events without advancing a persisted cursor',async()=>{
  for(const event of [{type:'response.in_progress',response:response('in_progress')},{type:'response.in_progress',sequence_number:2,response:response('in_progress',{id:'wrong'})},{type:'error',sequence_number:2,code:'server_error',message:'Provider error'}]) {
    const provider=new MetaBackgroundProvider(secrets,{streamRequest:async()=>stream([event]),fetch:async()=>{assert.fail('invalid stream must not claim final state');}});
    await assert.rejects(collect(provider.events('resp_1','1',signal())),MetaBackgroundError);
  }
});

test('SSE interrupted frames and invalid cursors fail without resubmitting work',async()=>{
  let streams=0;
  const provider=new MetaBackgroundProvider(secrets,{streamRequest:async()=>{streams++;return stream([],{tail:'data: {"type":"response.created"'});},fetch:async()=>{assert.fail('must not dispatch another response');}});
  await assert.rejects(collect(provider.events('resp_1','not-a-cursor',signal())),/cursor/);assert.equal(streams,0);
  await assert.rejects(collect(provider.events('resp_1','1',signal())),MetaBackgroundError);assert.equal(streams,1);
});
