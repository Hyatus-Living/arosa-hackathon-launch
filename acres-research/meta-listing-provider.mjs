import {MetaBackgroundProvider} from './meta-background.mjs';
import {resolveMetaModel} from './meta.mjs';
import {MASTER_PROMPT,REVIEW_PROMPT,REVIEW_VERSION,CONTRACT_AUDIT_PROMPT,DEPTH_POLICY,memoContract,modelContract} from './listing-investigation-prompt.mjs';
import {CRITICAL_AUDIT_PROMPT,applyAuditEdits,fetchReviewSources,reviewEvidence,reviewedReport,memoProblems,reportFromInteraction,providerTerminal} from './listing-investigation-provider.mjs';

const REVIEW_SCHEMA={type:'object',properties:{answer:{type:'string'},corrections:{type:'array',items:{type:'string'}}},required:['answer','corrections'],additionalProperties:false};
const AUDIT_SCHEMA={type:'object',properties:{approved:{type:'boolean'},edits:{type:'array',items:{type:'object',properties:{before:{type:'string'},after:{type:'string'},reason:{type:'string'}},required:['before','after','reason'],additionalProperties:false}}},required:['approved','edits'],additionalProperties:false};
const jsonBytes=text=>Buffer.byteLength(JSON.stringify(text))-2;
function prefixWithinBytes(text,limit){
  const chars=[];let used=0;
  for(const char of text){const bytes=jsonBytes(char);if(used+bytes>limit)break;chars.push(char);used+=bytes;}
  return chars.join('');
}
function boundedEvidence(evidence,sources){
  const limit=700*1024,readable=sources.filter(source=>typeof source.text==='string');
  const metadata=sources.map(source=>typeof source.text==='string'?{...source,text:'',modelExcerpted:false}:source);
  const available=limit-Buffer.byteLength(JSON.stringify({...evidence,webEvidence:metadata}));
  if(available<readable.length*512)throw new Error('The listing evidence metadata exceeds the Meta background request budget.');
  const perSource=Math.floor(available/Math.max(1,readable.length))-128;
  const webEvidence=sources.map(source=>{
    if(typeof source.text!=='string')return source;
    if(jsonBytes(source.text)<=perSource)return {...source,modelExcerpted:false};
    const note='\n[Excerpt shortened for the model request]\n',budget=perSource-jsonBytes(note);
    const entityExcerpt=source.text.indexOf('\n[Additional excerpt containing');
    const text=entityExcerpt<0?prefixWithinBytes(source.text,budget)+note:
      prefixWithinBytes(source.text.slice(0,entityExcerpt),Math.floor(budget/2))+note+prefixWithinBytes(source.text.slice(entityExcerpt),Math.floor(budget/2));
    return {...source,text,excerpted:true,modelExcerpted:true};
  });
  return {...evidence,webEvidence};
}

// Meta citations address characters, whereas the existing Gemini parser addresses
// UTF-8 bytes. Convert each native text block before sharing reference validation.
export function reportFromMetaResponse(response,options){
  const outputs=response.output.filter(item=>item.type==='message').flatMap(item=>item.content).filter(part=>part.type==='output_text').map(part=>{
    const characters=Array.from(part.text),byteIndex=index=>Buffer.byteLength(characters.slice(0,index).join(''));
    const annotations=(part.annotations||[]).filter(annotation=>annotation.type==='url_citation'&&Number.isInteger(annotation.start_index)&&Number.isInteger(annotation.end_index)&&annotation.start_index>=0&&annotation.end_index>=annotation.start_index&&annotation.end_index<=characters.length)
      .map(annotation=>({...annotation,start_index:byteIndex(annotation.start_index),end_index:byteIndex(annotation.end_index)}));
    // Some completed responses cite explicit Markdown links without annotations.
    // Retain only links the answer actually contains, never all search results.
    for(const match of part.text.matchAll(/(!?)\[([^\]\n]+)\]\((https:\/\/(?:[^()<>\s]|\([^()<>\s]*\))+)(?:\s+"[^"]*")?\)/g)){
      if(match[1])continue;
      const start=Buffer.byteLength(part.text.slice(0,match.index)),end=start+Buffer.byteLength(match[0]);
      if(annotations.some(annotation=>annotation.start_index<end&&annotation.end_index>start))continue;
      annotations.push({type:'url_citation',url:match[3],title:match[2],start_index:start,end_index:end});
    }
    return {type:'text',text:part.text,annotations};
  });
  return {...reportFromInteraction({outputs},options),provider:'meta',model:response.model,responseId:response.id};
}

export class MetaListingResearchProvider {
  constructor(secrets,{transport,sourceFetcher,...transportOptions}={}){
    this.secrets=secrets;this.model=resolveMetaModel(secrets.META_MODEL);this.provider='meta';
    this.transport=transport;this.transportOptions=transportOptions;this.sourceFetcher=sourceFetcher;
  }
  client(){return this.transport??=new MetaBackgroundProvider(this.secrets,this.transportOptions);}
  create(depth,prompt){
    if(!Object.hasOwn(DEPTH_POLICY,depth))throw new Error('Choose a valid research depth.');
    return this.client().create(prompt,{tools:[{type:'web_search',search_context_size:depth==='max'?'high':'medium'}],metadata:{workflow:'listing_research',depth}});
  }
  get(id){return this.client().get(id);}
  cancel(id){return this.client().cancel(id);}
  events(id,cursor,signal){return this.client().events(id,cursor,signal);}
  report(response,options){return reportFromMetaResponse(response,options);}
  async review(report,context,signal,callbacks={}){
    const webEvidence=await fetchReviewSources(report.sources,context,signal,this.sourceFetcher);
    const checkedReport={...report,sources:report.sources.map(source=>{const check=webEvidence.find(item=>item.reference===`W${source.id}`);return check?.status==='retrieved'?{...source,url:check.url,title:check.title}:source;})};
    const evidence=boundedEvidence({...context,memoContract:memoContract(context),publicRecords:reviewEvidence(context.publicRecords),draft:report.answer.replace(/\[(\d+)\]/g,'[W$1]'),webSources:checkedReport.sources.map(source=>({...source,reference:`W${source.id}`}))},webEvidence);
    const state={provider:'meta',stage:'review',evidence,sourceEvidence:webEvidence,report:checkedReport,records:context.publicRecords,listing:context.listing,reviewed:null,pending:null,rounds:[],metadata:{version:REVIEW_VERSION,provider:'meta',model:this.model,sourceChecks:evidence.webEvidence.map(({text,...check})=>check)}};
    await callbacks.checkpoint?.(state);
    return this.finishReview(state,signal,callbacks);
  }
  async response(state,input,schema,signal,{checkpoint=()=>{}}){
    const client=this.client();
    signal=signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000);
    if(state.pending?.dispatching&&!state.pending.id)throw Object.assign(new Error('The Meta review dispatch needs reconciliation before it can be retried.'),{ambiguous:true});
    if(!state.pending){
      signal?.throwIfAborted();
      state.pending={stage:state.stage,dispatching:true,id:null,cursor:null,raw:null};await checkpoint(state);
      let created;
      try{created=await client.create(input,{tools:[],text:{format:{type:'json_schema',name:state.stage==='review'?'listing_review':'listing_audit',strict:true,schema}},metadata:{workflow:'listing_review',stage:state.stage},signal});}
      catch(error){
        if(error.responseId){state.pending.id=error.responseId;state.pending.dispatching=false;}
        else if(!error.ambiguous)state.pending=null;
        await checkpoint(state);throw error;
      }
      state.pending={...state.pending,dispatching:false,id:created.id,raw:providerTerminal(created.status)?created:null};await checkpoint(state,created);
    }
    let response=state.pending.raw||await client.get(state.pending.id,signal);
    for(let reconnect=0;!providerTerminal(response.status)&&reconnect<4;reconnect++){
      await checkpoint(state,response);
      for await(const {cursor,event} of client.events(state.pending.id,state.pending.cursor,signal)){
        if(cursor!==null&&cursor!==undefined)state.pending.cursor=cursor;
        if(event.response)response=event.response;
        if(providerTerminal(response.status))state.pending.raw=response;
        await checkpoint(state,event.response);
        if(providerTerminal(response.status))break;
      }
      if(!providerTerminal(response.status))response=await client.get(state.pending.id,signal);
    }
    if(!providerTerminal(response.status))throw new Error('The Meta review is still running. Reconnect to retrieve its saved response.');
    state.pending.raw=response;await checkpoint(state,response);
    if(response.status!=='completed')throw new Error(`The Meta ${state.stage} ended ${response.status}. Its response is retained for review.`);
    return response;
  }
  async finishReview(state,signal,callbacks={}){
    try{
      if(state.stage==='done')return state.result;
      if(state.stage==='review'){
        const response=await this.response(state,MASTER_PROMPT+'\n\n'+REVIEW_PROMPT+'\n\n'+JSON.stringify({...state.evidence,memoContract:modelContract(state.evidence.memoContract)}),REVIEW_SCHEMA,signal,callbacks);
        let reviewed;try{reviewed=JSON.parse(response.output_text);}catch{throw new Error('Evidence review returned an invalid report. Its response is retained for review.');}
        if(typeof reviewed.answer!=='string'||!Array.isArray(reviewed.corrections))throw new Error('Evidence review returned an invalid report.');
        state.reviewed=reviewed;state.stage='audit';state.pending=null;
        state.metadata={...state.metadata,model:response.model,interactionId:response.id,usage:response.usage||null};await callbacks.checkpoint?.(state);
      }
      const {draft,...facts}=state.evidence;
      for(let round=0;round<DEPTH_POLICY[state.evidence.depth].auditRounds;round++){
        const problems=memoProblems(state.reviewed.answer,state.evidence.memoContract,state.evidence.webEvidence);
        const response=await this.response(state,CRITICAL_AUDIT_PROMPT+'\n'+CONTRACT_AUDIT_PROMPT+'\n\n'+JSON.stringify({...facts,memoContract:modelContract(state.evidence.memoContract),contractProblems:problems,answer:state.reviewed.answer}),AUDIT_SCHEMA,signal,callbacks);
        let verdict;try{verdict=JSON.parse(response.output_text);}catch{throw new Error('Source audit returned an invalid result. Its response is retained for review.');}
        if(typeof verdict.approved!=='boolean'||!Array.isArray(verdict.edits))throw new Error('Source audit returned an invalid result.');
        if(verdict.edits.length)state.reviewed=applyAuditEdits(state.reviewed,verdict.edits);
        state.rounds.push({provider:'meta',model:response.model,interactionId:response.id,usage:response.usage||null,approved:verdict.approved&&!problems.length,corrections:[...problems,...verdict.edits.map(edit=>edit.reason)]});
        state.pending=null;
        if(verdict.approved&&verdict.edits.length===0&&!problems.length){
          state.result=reviewedReport(state.reviewed,state.report,state.records,{...state.metadata,audits:state.rounds},state.listing,state.evidence.memoContract);
          state.stage='done';await callbacks.checkpoint?.(state);return state.result;
        }
        await callbacks.checkpoint?.(state);
        if(!verdict.edits.length)break;
      }
      throw new Error('The source audit found unresolved claims. Reconnect to review the saved research.');
    }catch(error){error.reviewState=state;throw error;}
  }
  async cancelReview(state,{checkpoint=()=>{}}={}){
    if(!state?.pending)return;
    if(!state.pending.id)throw Object.assign(new Error('The Meta review dispatch needs reconciliation before cancellation can be confirmed.'),{ambiguous:true});
    const response=await this.client().cancel(state.pending.id);
    state.pending.raw=response;await checkpoint(state,response);
    if(!providerTerminal(response.status))throw new Error('The Meta review is still running after cancellation.');
  }
}
