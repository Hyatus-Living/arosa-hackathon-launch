import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {resolveMetaModel} from './meta.mjs';

const API='https://api.meta.ai/v1';
const TERMINAL=new Set(['completed','failed','cancelled','incomplete']);
const MAX_BODY_BYTES=1024*1024;

export class MetaBackgroundError extends Error {
  constructor(statusCode,{ambiguous=false,responseId=null}={}) {
    super(statusCode?`Meta background research returned HTTP ${statusCode}.`:'Meta background research connection or response was interrupted.');
    this.name='MetaBackgroundError';this.statusCode=statusCode;this.ambiguous=ambiguous;this.responseId=responseId;
  }
}

// Research may be silent for minutes. The caller's persisted deadline bounds the
// stream, without fetch's body-idle timeout ending a still-running provider job.
function openStream(url,{headers,signal}) {
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{headers,signal},response=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,contentType:response.headers['content-type'],body:Readable.toWeb(response)}));
    request.once('error',reject);request.end();
  });
}

// This is a cumulative snapshot, not a charge or an increment. Persist with an
// upsert keyed by id; replayed GETs/events must replace, never add, the record.
export function metaUsageRecord(response) {
  if(!response.usage)return null;
  const usage=response.usage;
  return {id:`meta:${response.id}`,provider:'meta',responseId:response.id,model:response.model,semantics:'cumulative_per_response',
    usage:{inputTokens:usage.input_tokens,cachedInputTokens:usage.input_tokens_details?.cached_tokens??0,
      outputTokens:usage.output_tokens,reasoningOutputTokens:usage.output_tokens_details?.reasoning_tokens??0}};
}

export function normalizeMetaResponse(response) {
  if(typeof response.id!=='string'||!response.id||typeof response.model!=='string'||typeof response.status!=='string'||!Array.isArray(response.output)) {
    throw new MetaBackgroundError(null,{responseId:response.id??null});
  }
  const texts=[],citations=[],searchCalls=[];
  for(const [outputIndex,item] of response.output.entries()) {
    if(item.type==='web_search_call')searchCalls.push(item);
    if(item.type!=='message')continue;
    for(const [contentIndex,part] of item.content.entries()) {
      if(part.type!=='output_text')continue;
      texts.push(part.text);
      for(const citation of part.annotations??[])if(citation.type==='url_citation')citations.push({...citation,outputIndex,contentIndex});
    }
  }
  // Preserve native output, citation offsets and usage for evidence/recovery.
  // Meta offsets are characters, unlike Gemini's UTF-8 byte offsets.
  return {...response,provider:'meta',output_text:texts.join('\n\n'),citations,searchCalls,usageRecord:metaUsageRecord(response)};
}

export class MetaBackgroundProvider {
  constructor(secrets,{fetch:request=fetch,streamRequest=openStream,timeoutMs=60000,retrieveRetryDelays=[250,1000,2000],wait=delay}={}) {
    if(!secrets.MODEL_API_KEY)throw new Error('MODEL_API_KEY is required for Meta background research.');
    this.model=resolveMetaModel(secrets.META_MODEL);this.key=secrets.MODEL_API_KEY;
    this.base=(secrets.META_BASE_URL||API).replace(/\/+$/,'');
    if(new URL(this.base).protocol!=='https:')throw new Error('META_BASE_URL must use HTTPS.');
    this.request=request;this.streamRequest=streamRequest;this.timeoutMs=timeoutMs;this.retrieveRetryDelays=retrieveRetryDelays;this.wait=wait;
    this.provider='meta';
  }
  headers(){return {authorization:`Bearer ${this.key}`,'content-type':'application/json'};}
  async call(method,path,body,signal) {
    signal?.throwIfAborted();
    const encoded=body===undefined?undefined:JSON.stringify(body);
    if(method==='POST'&&Buffer.byteLength(encoded??'')>MAX_BODY_BYTES)throw new Error('Meta background requests must be no larger than 1 MiB.');
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs);
    let response;
    try {response=await this.request(`${this.base}/responses${path}`,{method,headers:this.headers(),...(encoded===undefined?{}:{body:encoded}),signal:requestSignal,redirect:'error'});}
    catch {throw new MetaBackgroundError(null,{ambiguous:method==='POST'});}
    if(!response.ok)throw new MetaBackgroundError(response.status,{ambiguous:method==='POST'&&(response.status>=500||response.status===408)});
    try {return await response.json();}
    catch {throw new MetaBackgroundError(null,{ambiguous:method==='POST'});}
  }
  async create(input,{instructions,previousResponseId,tools=[{type:'web_search'}],reasoning,metadata,text,signal}={}) {
    if(previousResponseId&&!instructions)throw new Error('Resend instructions when continuing a stored Meta response.');
    const body={model:this.model,input,background:true,store:true,stream:false,tools,
      ...(tools.some(tool=>tool.type==='web_search'||tool.type==='web_search_2025_08_26')?{include:['web_search_call.results']}:{}),
      ...(instructions?{instructions}:{}),...(previousResponseId?{previous_response_id:previousResponseId}:{}),
      ...(reasoning?{reasoning}:{}),...(metadata?{metadata}:{}),...(text?{text}:{})};
    const response=await this.call('POST','',body,signal);
    try {return normalizeMetaResponse(response);}
    catch(error) {error.ambiguous=true;throw error;}
  }
  async get(id,signal) {
    let response;
    for(let attempt=0;;attempt++) {
      try {response=await this.call('GET',`/${encodeURIComponent(id)}`,undefined,signal);break;}
      catch(error) {
        if(error.statusCode!==404||attempt>=this.retrieveRetryDelays.length)throw error;
        await this.wait(this.retrieveRetryDelays[attempt],undefined,{signal});
      }
    }
    if(response.id!==id)throw new MetaBackgroundError(null,{responseId:id});
    return normalizeMetaResponse(response);
  }
  async cancel(id,signal) {
    await this.call('POST',`/${encodeURIComponent(id)}/cancel`,{},signal);
    // The cancel acknowledgment always has empty output, even when completion
    // wins the race. It must never overwrite the stored final report or usage.
    return this.get(id,signal);
  }
  async *events(id,cursor,signal) {
    signal?.throwIfAborted();
    let sequence=cursor==null?null:Number(cursor);
    if(sequence!==null&&(!Number.isSafeInteger(sequence)||sequence<0))throw new Error('Meta event cursor must be a non-negative integer.');
    const params=new URLSearchParams({stream:'true'});if(sequence!==null)params.set('starting_after',String(sequence));
    let response;
    try {response=await this.streamRequest(`${this.base}/responses/${encodeURIComponent(id)}?${params}`,{headers:this.headers(),signal});}
    catch {throw new MetaBackgroundError(null,{responseId:id});}
    if(!response.ok){await response.body?.cancel();throw new MetaBackgroundError(response.status,{responseId:id});}
    // A completed response can win the stream-opening race and return JSON.
    // Reconcile by ID instead of feeding that document into the SSE parser.
    if(response.contentType?.includes('application/json')) {
      await response.body?.cancel();
      const final=await this.get(id,signal);
      yield {cursor:sequence===null?null:String(sequence),event:{type:'response.retrieved',status:final.status,response:final}};
      return;
    }
    for await(const event of readEvents(response.body)) {
      if(event.type==='keepalive')continue;
      const next=event.sequence_number;
      if(!Number.isSafeInteger(next)||next<0)throw new MetaBackgroundError(null,{responseId:id});
      if(sequence!==null&&next<=sequence)continue;
      if(event.type==='error')throw new MetaBackgroundError(null,{responseId:id});
      if(event.response&&event.response.id!==id)throw new MetaBackgroundError(null,{responseId:id});
      sequence=next;
      if(event.response&&TERMINAL.has(event.response.status)) {
        const final=await this.get(id,signal);
        yield {cursor:String(sequence),event:{...event,type:`response.${final.status}`,status:final.status,response:final}};
        return;
      }
      yield {cursor:String(sequence),event:{...event,...(event.response?{status:event.response.status,response:normalizeMetaResponse(event.response)}:{})}};
    }
    // A cleanly ended stream is not completion proof; reconcile the stored state.
    const final=await this.get(id,signal);
    yield {cursor:sequence===null?null:String(sequence),event:{type:'response.retrieved',status:final.status,response:final}};
  }
}

async function* readEvents(body) {
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done){if(buffer.trim())throw new MetaBackgroundError(null);return;}
      buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');
      if(buffer.length>12*1024*1024)throw new Error('Meta research event exceeded the size limit.');
      let end;
      while((end=buffer.indexOf('\n\n'))>=0) {
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(!data)continue;
        if(data==='[DONE]')return;
        yield JSON.parse(data);
      }
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
