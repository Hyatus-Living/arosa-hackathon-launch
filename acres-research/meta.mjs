import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {skillPath,reportingTables} from './tools.mjs';
import {executionSignal,withExecutionSignal,combinedSignal,stoppedError} from './execution-context.mjs';
import {baseInstructions} from './instructions.mjs';
import {createPromptContext,contextReadTool} from './prompt-context.mjs';
import {selectEffort,toolError,followUpTurns,followUpLimits,sanitizeAnswerFormatting,decisionInputs} from './codex.mjs';

// Research on Meta's Model API (Responses protocol) under runCodex's contract: the same registered
// tools, prompt context, follow-up turns, controls and run events. A failed Meta call fails the run
// and never falls back to another model.
const API='https://api.meta.ai/v1';
export const META_MODEL='muse-spark-1.3';
export const META_API_MODELS=new Set(['muse-spark-1.1','muse-spark-1.2','muse-spark-1.2-contributor','muse-spark-1.3','muse-spark-1.3-contributor','muse-wonder-1.0']);

export function resolveMetaModel(value=META_MODEL) {
  const model=value||META_MODEL;
  if(META_API_MODELS.has(model))return model;
  if(/^muse-wonder-full(?:[.-]|$)/.test(model))throw new Error('META_MODEL Muse Wonder Full is available only with an eligible Muse Code subscription, not through the Meta Model API. Use muse-wonder-1.0 or a Muse Spark API model.');
  throw new Error(`META_MODEL ${JSON.stringify(model)} is not supported by the Meta Model API. Use muse-wonder-1.0, muse-spark-1.1, muse-spark-1.2, muse-spark-1.2-contributor, muse-spark-1.3, or muse-spark-1.3-contributor.`);
}

function providerError(status) {
  if(status===401||status===403)return new Error('The Meta Model API could not authenticate this request. Check MODEL_API_KEY and its API access.');
  if(status===400)return new Error('The Meta Model API rejected this request. Check the request configuration.');
  if(status===404)return new Error('The Meta Model API could not serve the configured model. Confirm META_MODEL is available to this API key.');
  if(status===429)return new Error('The Meta Model API rate limit was reached. Try again shortly.');
  if(status>=500)return new Error('The Meta Model API is temporarily unavailable. Try again shortly.');
  return new Error(`The Meta Model API request failed with HTTP ${status}.`);
}

const streamError=()=>new Error('The Meta Model API stream failed. Try again shortly.');

export async function runMeta(options) {
  const model=resolveMetaModel(options.secrets?.META_MODEL);
  const controller=new AbortController();
  const signal=combinedSignal(executionSignal(),options.signal,controller.signal);
  const usageStreamId=options.usageStreamId??randomUUID(),emit=options.emit??(()=>{});
  let lastUsage,outcome='failed';
  emit('billing.agent.started',{provider:'meta',usageStreamId,label:options.label??'research',model});
  try{
    const result=await withExecutionSignal(signal,()=>runMetaTurns({...options,model,usageStreamId,controller,signal,onUsage:usage=>{lastUsage=usage;options.onUsage?.(usage);}}));
    outcome='completed';return result;
  }finally{
    if(lastUsage)emit('billing.usage',{provider:'meta',usageStreamId,usageSemantics:'cumulative',model,usage:lastUsage});
    emit('billing.agent.completed',{provider:'meta',usageStreamId,model,outcome});
  }
}
runMeta.provider='meta';
runMeta.handlesProviderDispatch=true;

// The JSON events of one streamed response.
export async function* streamEvents(body) {
  let buffer='';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer+=chunk.replace(/\r/g,'');
    let end;
    while((end=buffer.indexOf('\n\n'))>=0) {
      const data=buffer.slice(0,end).split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      buffer=buffer.slice(end+2);
      if(data&&data!=='[DONE]')yield JSON.parse(data);
    }
  }
}

const userInput=parts=>({role:'user',content:parts.map(text=>({type:'input_text',text}))});

async function runMetaTurns({controller,signal,usageStreamId,model,invokeProvider=fn=>fn(),message,userMessage=message,effortMessage=userMessage,history=[],userHistory=null,propertyBbl,project={},memories=[],authorName=null,secrets={},dynamicTools=[],execute,emit=()=>{},onControl=()=>{},onUsage=()=>{},onOutcome=()=>{},instructions=null,effort=null,deadlineMs=300000,includeSkill=true,label='research',validateAnswer=null,getSources=null,checkDeliverables=false,unlockReserve=()=>{},followUp=null,fetch=globalThis.fetch}) {
  signal.throwIfAborted();
  let closed=false,active=false,checking=false,announce=false,dispatched=false,threadId=null;
  const output=emit;emit=(event,data)=>{if(!closed&&!signal.aborted)output(event,data);};
  const resolvedEffort=selectEffort({message:effortMessage,label,effort});
  const context=createPromptContext({enabled:dynamicTools.length>0||typeof userHistory?.read==='function',userHistory});
  const modelTools=context.enabled?[...dynamicTools,contextReadTool]:dynamicTools;
  const offered=new Set(modelTools.map(tool=>tool.name));
  const tools=modelTools.map(tool=>({type:'function',name:tool.name,description:tool.description,parameters:tool.inputSchema}));
  const retrieved=[],ran=new Set(),steers=[];
  const conversation=[];
  let decision={storeOptions:null,comparison:null};
  const totals={inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0};
  const startedAt=Date.now();
  const deadline=setTimeout(()=>controller.abort(Object.assign(stoppedError('Research timed out. Try a narrower question.'),{deadline:true})),deadlineMs);
  followUp??=followUpLimits(deadlineMs);
  const remainingMs=()=>deadlineMs-(Date.now()-startedAt)-followUp.marginMs;

  // Replay encrypted reasoning and tool outputs locally so chaining does not depend on stored responses.
  async function respond(input,turnEffort,turnSignal) {
    conversation.push(...input);
    const body={model,instructions:instructions||baseInstructions(),input:conversation,...(tools.length?{tools}:{}),reasoning:{effort:turnEffort,summary:'concise'},stream:true,store:false,include:['reasoning.encrypted_content']};
    const send=async()=>{
      try{return await fetch(`${API}/responses`,{method:'POST',signal:turnSignal,headers:{authorization:`Bearer ${secrets.MODEL_API_KEY}`,'content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify(body)});}
      catch(error){if(turnSignal.aborted)throw turnSignal.reason;throw new Error('The Meta Model API request could not be completed. Try again shortly.');}
    };
    // The wallet authorizes one provider dispatch per agent call; it covers the call's first request.
    const res=await (dispatched?send():invokeProvider(send,{signal}));
    dispatched=true;
    if(!res.ok)throw providerError(res.status);
    const calls=[],messages=[],items=[];let response=null;
    try {
      for await (const event of streamEvents(res.body)) {
        if(event.type==='response.created'&&announce){announce=false;emit('turn.started',{threadId:threadId??event.response.id,turnId:event.response.id,label,effort:turnEffort,model,toolCount:tools.length});}
        else if(event.type==='response.output_item.added'&&event.item.type==='message'&&!checking)emit('message.started',{id:event.item.id});
        else if(event.type==='response.output_text.delta'&&!checking)emit('message.delta',{id:event.item_id,delta:event.delta});
        else if(event.type==='response.output_item.done') {
          const item=event.item;
          items.push(item);
          if(item.type==='function_call')calls.push(item);
          if(item.type==='message')messages.push({id:item.id,text:item.content.filter(part=>part.type==='output_text').map(part=>part.text).join('')});
          if(item.type==='reasoning'&&item.summary?.length)emit('agent.phaseSummary',{id:item.id,summary:item.summary.map(part=>part.text)});
        }
        else if(event.type==='response.completed')response=event.response;
        else if(event.type==='response.failed'||event.type==='response.incomplete'||event.type==='error')throw streamError();
      }
    } catch(error) {if(turnSignal.aborted)throw turnSignal.reason;throw streamError();}
    if(!response)throw new Error('The Meta response stream ended before the response completed.');
    threadId??=response.id;
    for(const item of items) {
      if(item.type==='function_call')conversation.push({type:'function_call',name:item.name,arguments:item.arguments,call_id:item.call_id});
      else if(item.type==='reasoning'&&item.encrypted_content)conversation.push({type:'reasoning',id:item.id,summary:item.summary??[],encrypted_content:item.encrypted_content});
      else if(item.type==='message')conversation.push({type:'message',role:'assistant',...(item.phase||calls.length?{phase:item.phase||'commentary'}:{}),content:item.content.filter(part=>part.type==='output_text').map(({text})=>({type:'output_text',text}))});
    }
    // Text written beside tool calls is progress; the text of a response without calls is the answer.
    if(!checking)for(const {id,text} of messages)emit('message.completed',{id,phase:calls.length?'commentary':'final_answer',text});
    const usage=response.usage;
    totals.inputTokens+=usage.input_tokens;
    totals.cachedInputTokens+=usage.input_tokens_details?.cached_tokens??0;
    totals.outputTokens+=usage.output_tokens;
    totals.reasoningOutputTokens+=usage.output_tokens_details?.reasoning_tokens??0;
    const record={...totals};
    onUsage(record);emit('billing.usage',{provider:'meta',usageStreamId,usageSemantics:'cumulative',threadId,label,model,usage:record});
    return {calls,answer:messages.at(-1)?.text??''};
  }

  async function runTool({name,call_id,arguments:raw}) {
    const toolStartedAt=Date.now();
    let args=null,invalid=false,result,success=true,images=[];
    try{args=JSON.parse(raw||'{}');}catch{invalid=true;}
    emit('tool.started',{tool:name,arguments:args});
    try {
      if (invalid) throw Object.assign(new Error(`The arguments for ${name} are not valid JSON.`),{retryable:false});
      if (checking) throw Object.assign(new Error('Tools are unavailable during the deliverable check. Return only the JSON verdict.'),{retryable:false});
      if (!offered.has(name)) throw Object.assign(new Error(`${name} is not a tool of this run.`),{retryable:false});
      // A tool may hand the model images (contentImages: data URLs); they go as input images and
      // the text and trace carry only their count.
      const {contentImages=[],...value}=(name===contextReadTool.name?await context.read(args):await execute(name,args))??{};
      signal.throwIfAborted();
      if(name!==contextReadTool.name)retrieved.push(...reportingTables(value));
      const toolName=name==='acres_execute_capability'?args?.name:name;
      ran.add(toolName);
      decision=decisionInputs(decision,toolName,value);
      images=contentImages;
      result=contentImages.length?{...value,images:contentImages.length}:value;
    } catch (e) {
      if(signal.aborted)throw signal.reason;
      console.log(JSON.stringify({event:'research_tool_failed',tool:name,slug:args?.slug,message:e.message.slice(0,200)}));
      result=toolError(e);success=false;
    }
    emit('tool.completed',{tool:name,arguments:args,durationMs:Date.now()-toolStartedAt,success,result});
    const text=JSON.stringify(success&&name!==contextReadTool.name?context.pack(result,`Result of ${name}`):result);
    return {type:'function_call_output',call_id,output:images.length?[{type:'input_text',text},...images.map(image_url=>({type:'input_image',image_url}))]:text};
  }

  // One turn: requests until the model answers without calling a tool. A steer joins the next
  // request, and one that arrives with the answer gets a further request of its own.
  async function turn(turnEffort,input,turnSignal) {
    announce=true;
    let next=input;
    for(;;) {
      next=[...next,...steers.splice(0).map(text=>userInput([text]))];
      const {calls,answer}=await respond(next,turnEffort,turnSignal);
      if(calls.length){next=await Promise.all(calls.map(runTool));continue;}
      if(!steers.length)return answer;
      next=[];
    }
  }

  onControl({steer:async text=>{if(!active)throw new Error('This turn has finished or is not ready. Queue your message instead.');steers.push(text);},interrupt:async()=>{
    if(signal.aborted)return;
    controller.abort(stoppedError());
  }});
  try {
    console.log(JSON.stringify({event:'meta_research_started',label,model,effort:resolvedEffort,toolCount:tools.length,skill:includeSkill?'creative-zoning':null}));
    active=true;
    const skill=includeSkill?[await readFile(skillPath,'utf8')]:[];
    const answer=await turn(resolvedEffort,[userInput([context.input({message,userMessage,history,propertyBbl,project,memories,authorName}),...skill])],signal);
    // A follow-up turn that outlives budgetMs is stopped and rejects with expired set.
    let followUpExpired=false;
    async function runTurn(turnEffort,text,budgetMs=remainingMs()) {
      signal.throwIfAborted();
      if(followUpExpired||budgetMs<=0)throw Object.assign(new Error('No time is left for another turn.'),{expired:true});
      const limit=new AbortController();
      const timer=setTimeout(()=>{followUpExpired=true;limit.abort(Object.assign(new Error('The follow-up turn ran out of time.'),{expired:true}));},budgetMs);
      try{return await turn(turnEffort,[userInput([text])],combinedSignal(signal,limit.signal));}
      catch(error){if(limit.signal.aborted&&!signal.aborted)throw limit.signal.reason;throw error;}
      finally{clearTimeout(timer);}
    }
    const finished=await followUpTurns({answer,runTurn,setChecking:value=>{checking=value;},effort:resolvedEffort,userMessage,validateAnswer,getSources,context,emit,secrets,retrieved,ran,decision,checkDeliverables,unlockReserve,followUp,remainingMs});
    onOutcome({effort:resolvedEffort,repaired:finished.repaired,repairFailed:finished.repairFailed,check:finished.check});
    if (!finished.answer.trim()) throw new Error('The model returned no answer.');
    signal.throwIfAborted();
    return sanitizeAnswerFormatting(finished.answer);
  } finally {
    closed=true;active=false;
    onControl(null);
    clearTimeout(deadline);
    controller.abort(stoppedError());
  }
}
