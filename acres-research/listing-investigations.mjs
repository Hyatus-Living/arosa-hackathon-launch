import {EventEmitter} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {MASTER_PROMPT,PROMPT_VERSION,DEPTH_POLICY,OBJECTIVE_POLICY,memoContract,modelContract} from './listing-investigation-prompt.mjs';
import {ListingResearchProvider,RESEARCH_AGENTS,reportFromInteraction,providerTerminal} from './listing-investigation-provider.mjs';
import {fetchNycPublicRecords} from './nycdb.mjs';
import {Wallet,FirestoreWalletRepository,validateRate} from './wallet.mjs';

export const INVESTIGATION_OBJECTIVES=Object.keys(OBJECTIVE_POLICY);
export const INVESTIGATION_TERMINAL=['completed','failed','cancelled','needs_attention'];
// A job left needing attention keeps the account lock only this long; after that it auto-fails
// (billing left exactly as recorded) so an abandoned reconciliation cannot block research forever.
const ATTENTION_TTL_MS=7*86400000;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys=['id','listing_id','address','bbl','borough','city','zipCode','zip_code','url','listingType','listingSourceName','mlsStatus','listDate','listPrice','list_price','soldDate','soldPrice','priceHistory','style','yearBuilt','buildingClass','existingUnitsRes','existingUnitsTotal','lotAreaSqft','lot_area_sqft','existingBldgAreaSqft','building_sqft','plutoAddress','zoningDistrict','zoning_district_1','maxStandardZfa','maxUapZfa','unusedStandardZfa','unusedUapZfa','landmarkFlag','rentStabilization','updatedAt','lastSeenAt'];

export function listingInvestigationSnapshot(deal){
  const snapshot=Object.fromEntries(keys.filter(k=>deal[k]!==undefined).map(k=>[k,deal[k]]));
  if(typeof deal.ownerName==='string'&&/\b(?:LLC|L\.L\.C\.|INC\.?|CORP\.?|L\.P\.|LLP)\b/i.test(deal.ownerName))snapshot.ownerEntityLead={name:deal.ownerName,status:'Unverified business-entity name from listing-feed parcel enrichment; check latest recorded deed.'};
  return snapshot;
}
export function investigationEvidencePacket(records){
  if(!records)return {status:'not supplied'};
  const data=records.records?Object.fromEntries(Object.entries(records.records).filter(([key])=>!['proseReportingMandate','submittalForensics'].includes(key))):undefined;
  const master=records.queries?.find(query=>query.dataset==='ACRIS document master');
  if(data?.sourceIds?.acris&&master)data.sourceIds={...data.sourceIds,acrisParcelRecords:data.sourceIds.acris,acris:master.sourceId};
  if(data?.hpdViolationSummary)data.sourceIds={...data.sourceIds,hpdViolations:records.queries?.find(query=>query.dataset==='HPD violations')?.sourceId||data.sourceIds?.hpd};
  return {...records,records:data,sources:records.sources?.map(({id,title,url,kind})=>({id,title,url,kind}))};
}
export function investigationPrompt(job){
  const packet=investigationEvidencePacket(job.records);
  return `${MASTER_PROMPT}\n\n## Supplied investigation brief\n${JSON.stringify({researchDate:new Date(job.created).toISOString(),deadline:new Date(job.deadline).toISOString(),depth:job.depth,objective:job.objective,questions:job.question||'Identify the highest-impact acquisition questions for this listing.',memoContract:modelContract(memoContract({...job,publicRecords:packet})),listing:job.snapshot,listingEvidenceStatus:'Listing and screening data, not verified legal conclusions. Calculated ZFA and tenant flags require confirmation.',publicRecords:packet,sourceGuide:'For NYC use exact BBL/BIN; ACRIS excludes Staten Island land records, which require Richmond County Clerk. Use official entity, court, building and property systems for the actual jurisdiction. All unprovided facts are unknown.'},null,2)}`;
}

// Public-record rows per query: the depth's budget weighted by what the objective needs most.
export function recordPlan({depth,objective}){return {rowLimit:Math.min(30,Math.round(DEPTH_POLICY[depth].recordRows*OBJECTIVE_POLICY[objective].recordWeight))};}
export async function collectListingRecords(snapshot,{rowLimit},{fetcher=fetch}={}){
  if(!/^\d{10}$/.test(String(snapshot.bbl||'')))return {status:'not supplied',reason:'No exact NYC BBL in the listing.'};
  const sources=[],queries=[];
  const labels={'ic3t-wcy2':'DOB BIS filings','w9ak-ipjd':'DOB NOW filings','bs8b-p36w':'DOB certificates of occupancy','8h5j-fqxa':'ACRIS real-property legals','bnx9-e6tj':'ACRIS document master','636b-3b5g':'ACRIS deed and mortgage parties','hg8x-zxpr':'HPD affordable housing','wvxf-dwi5':'HPD violations','tesw-yqqr':'HPD registrations','3h2n-5cm9':'DOB violations','6bgk-3dad':'ECB violations','hxm3-23vy':'E-designations','ncre-qhxs':'Nearby LPC landmarks'};
  const records=await fetchNycPublicRecords({bbl:String(snapshot.bbl),limit:rowLimit},{record:source=>{const entry={...source,id:sources.length+1};sources.push(entry);return entry;},request:async url=>{
    const parsed=new URL(url),dataset=parsed.pathname.split('/').pop().replace('.json',''),sourceId=sources.length+1;
    sources.push({id:sourceId,title:`${labels[dataset]||dataset}: bounded query`,url,kind:'public_record_query'});
    const query={sourceId,dataset:labels[dataset]||dataset,url,status:'unavailable',returnedRows:null,rowLimit:Number(parsed.searchParams.get('$limit'))||null};queries.push(query);
    const response=await fetcher(url,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(`Public records HTTP ${response.status}`);const rows=await response.json();
    Object.assign(query,{status:'retrieved',returnedRows:rows.length});return rows;
  }});
  return {status:'retrieved',retrievedAt:new Date().toISOString(),queries,coverage:{scope:'Bounded public-data prefetch, not a title, permit, occupancy or landmark clearance.',defaultRowLimit:rowLimit,emptyRows:'No rows returned by these queries. This does not establish that no filings, approvals, violations or obligations exist.',nearbyLandmarks:'Nearby parcel context only. Neither inclusion of nearby landmarks nor absence of this BBL establishes the subject parcel designation or exemption.',sourceMatching:'Each sourceIds entry supports only its named dataset. An ACRIS citation does not substantiate a DOB, HPD or LPC claim.',documentImages:'Index metadata only unless an actual document image is separately retrieved.',currentTitle:'Later deeds, satisfactions, releases and dockets may be missing. Do not call the packet complete or infer current liens/ownership from the latest returned row.'},records,sources};
}

export class ListingInvestigations extends EventEmitter {
  constructor({store,secrets,provider=new ListingResearchProvider(secrets.GEMINI_RESEARCH_API_KEY),wallet=null,records=collectListingRecords}){
    super();this.store=store;this.secrets=secrets;this.provider=provider;this.wallet=wallet||(secrets.BILLING_ENABLED===true?new Wallet(new FirestoreWalletRepository()):null);this.records=records;this.active=new Map();this.deadlineTimers=new Map();this.closed=false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS listing_investigations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,listing TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS listing_investigations_owner ON listing_investigations(owner,listing,created);
      CREATE TABLE IF NOT EXISTS listing_investigation_events(job TEXT NOT NULL REFERENCES listing_investigations(id),seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job,seq));`);
  }
  policy(){
    const enabled=this.secrets.LISTING_RESEARCH_ENABLED===true&&Boolean(this.secrets.GEMINI_RESEARCH_API_KEY),modes={};
    for(const depth of Object.keys(RESEARCH_AGENTS)){
      const rate=this.secrets.BILLING_RATES?.[`listing_research_${depth}`];let configured=!this.wallet;
      if(this.wallet&&rate){try{validateRate(rate);configured=rate.mode==='estimated_call';}catch{configured=false;}}
      const budget=DEPTH_POLICY[depth];
      modes[depth]={enabled:enabled&&configured,agent:RESEARCH_AGENTS[depth],deadlineMinutes:budget.deadlineMs/60000,reviewSourceCap:budget.reviewSourceCap,maxWords:budget.maxWords,chargeMicros:this.wallet&&configured?rate.amountMicros:null,reserveMicros:this.wallet&&configured?rate.reserveMicros:null};
    }
    return {enabled,defaultDepth:'standard',modes,objectives:INVESTIGATION_OBJECTIVES,billed:Boolean(this.wallet)};
  }
  row(id){const row=this.store.one('SELECT data FROM listing_investigations WHERE id=?',id);return row?JSON.parse(row.data):null;}
  public(job){if(!job)return null;const {id,listingId,projectId,snapshot,depth,objective,question,status,created,updated,deadline,result,error,usage,promptVersion,billing}=job;return {id,listingId,projectId,address:snapshot.address||`BBL ${snapshot.bbl}`,bbl:snapshot.bbl||null,depth,objective,question,status,created,updated,deadline,result,error,usage,promptVersion,billing,eventSeq:this.latestEventSeq(id),canCancel:status==='needs_attention'&&Boolean(job.providerId)};}
  latestEventSeq(id){return this.store.one('SELECT COALESCE(MAX(seq),0) AS seq FROM listing_investigation_events WHERE job=?',id).seq;}
  get(owner,id){const row=this.row(id);return row?.owner===owner?this.public(row):null;}
  list(owner,listingId){return this.store.query('SELECT data FROM listing_investigations WHERE owner=? AND listing=? ORDER BY created DESC LIMIT 20',owner,listingId).map(r=>this.public(JSON.parse(r.data)));}
  events(owner,id,after=0,limit=32){if(!this.get(owner,id))return [];return this.store.query('SELECT data FROM listing_investigation_events WHERE job=? AND seq>? ORDER BY seq LIMIT ?',id,after,limit).map(r=>JSON.parse(r.data));}
  save(job,patch={}){
    Object.assign(job,patch,{updated:Date.now()});
    this.store.write('UPDATE listing_investigations SET status=?,updated=?,data=? WHERE id=?',job.status,job.updated,JSON.stringify(job),job.id);
    const seq=this.store.one('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM listing_investigation_events WHERE job=?',job.id).seq;
    const event={seq,event:'investigation.updated',job:{...this.public(job),eventSeq:seq}};
    this.store.write('INSERT INTO listing_investigation_events VALUES(?,?,?)',job.id,seq,JSON.stringify(event));this.emit(job.id,event);
    return this.public(job);
  }
  create(owner,input,deal){
    if(input.question!==undefined&&typeof input.question!=='string')throw fail('Use a research question of up to 1,000 characters.');
    const depth=input.depth??'standard',objective=input.objective??'acquisition screening',question=(input.question??'').trim();
    if(!uuid.test(input.id||''))throw fail('A valid request ID is required.');
    if(input.projectId!==undefined&&input.projectId!==null&&(typeof input.projectId!=='string'||!uuid.test(input.projectId)))throw fail('A valid project ID is required.');
    if(!Object.hasOwn(RESEARCH_AGENTS,depth)||!INVESTIGATION_OBJECTIVES.includes(objective))throw fail('Choose a valid research depth and investment objective.');
    if(question.length>1000)throw fail('Use a research question of up to 1,000 characters.');
    const listingId=String(deal.id||deal.listing_id||'');if(!listingId||listingId!==input.listingId)throw fail('Listing identity does not match.');
    const requestHash=hash({listingId,depth,objective,question,projectId:input.projectId||null}),old=this.row(input.id);
    if(old){if(old.owner!==owner||old.requestHash!==requestHash)throw fail('This request ID belongs to another investigation.',409);return this.public(old);}
    if(!this.policy().modes[depth].enabled)throw fail('Listing research is not configured for this depth.',503);
    if(input.projectId&&!this.store.projectView(owner,input.projectId))throw fail('Project not found.',404);
    for(const row of this.store.query("SELECT data FROM listing_investigations WHERE owner=? AND status='needs_attention'",owner)){const stuck=JSON.parse(row.data);this.expireProviderlessAttention(stuck)||this.expireAttention(stuck);}
    const active=this.store.query("SELECT data FROM listing_investigations WHERE owner=? AND status NOT IN ('completed','failed','cancelled')",owner).map(r=>JSON.parse(r.data));
    if(active.length)throw fail('An investigation is already active or needs attention. Open it before starting another.',409);
    if(this.store.one('SELECT COUNT(*) AS count FROM listing_investigations WHERE owner=? AND created>?',owner,Date.now()-86400000).count>=10)throw fail('Daily listing research limit reached.',429);
    const now=Date.now(),job={id:input.id,owner,listingId,projectId:input.projectId||null,requestHash,snapshot:listingInvestigationSnapshot(deal),depth,objective,question,status:'queued',created:now,updated:now,deadline:now+DEPTH_POLICY[depth].deadlineMs,promptVersion:PROMPT_VERSION,providerId:null,cursor:null,billing:'not_started',rate:this.wallet?this.secrets.BILLING_RATES[`listing_research_${depth}`]:null,dispatchGuard:randomUUID(),cancelRequested:false,result:null,error:null,usage:null};
    this.store.write('INSERT INTO listing_investigations VALUES(?,?,?,?,?,?,?)',job.id,owner,listingId,job.status,now,now,JSON.stringify(job));this.save(job);queueMicrotask(()=>this.pump());return this.public(job);
  }
  // A provider-less needs_attention job can never be cancelled or reconnected (no provider interaction
  // exists to act on), so past its deadline it auto-fails and frees the account lock. Billing is left
  // exactly as recorded (a pending hold stays pending) for reconciliation; nothing is settled or released.
  expireProviderlessAttention(job,now=Date.now()){
    if(!job||job.status!=='needs_attention'||job.providerId||now<job.deadline)return false;
    this.save(job,{status:'failed',error:'This investigation expired without a provider interaction to reconcile. Any billing hold stays pending for reconciliation; start a new investigation when ready.'});
    return true;
  }
  attentionExpiry(job){return job.attentionExpiresAt??job.deadline+ATTENTION_TTL_MS;}
  expireAttention(job,now=Date.now()){
    if(!job||job.status!=='needs_attention'||!job.providerId||now<this.attentionExpiry(job))return false;
    this.save(job,{status:'failed',error:'This investigation was left needing attention and expired. Any billing hold stays pending for reconciliation; start a new investigation when ready.'});
    return true;
  }
  recover(){
    // Jobs parked here first, so their deadlines are armed with every other needs_attention job.
    for(const row of this.store.query("SELECT data FROM listing_investigations WHERE status NOT IN ('completed','failed','cancelled','needs_attention')")){
      const job=JSON.parse(row.data);
      if(job.status==='reviewing'||(!job.providerId&&(job.status==='creating'||job.billing!=='not_started')))this.save(job,{status:'needs_attention',attentionExpiresAt:job.attentionExpiresAt??Date.now()+ATTENTION_TTL_MS,error:'The server restarted during dispatch. Provider or billing reconciliation is required before another run.'});
    }
    for(const row of this.store.query("SELECT data FROM listing_investigations WHERE status='needs_attention'")){const job=JSON.parse(row.data);if(!this.expireProviderlessAttention(job)&&!this.expireAttention(job))this.armAttentionDeadline(job);}
    this.pump();
  }
  armAttentionDeadline(job){
    if(job.raw?.status==='completed'||this.closed||this.deadlineTimers.has(job.id))return;
    // Two stages: at the run deadline, start cancelling (or expire a provider-less job); at the
    // attention expiry, fail whatever is still parked so the account lock always ends.
    const fireAt=!job.providerId||!job.deadlineCancellationAttempted?Math.min(job.deadline,this.attentionExpiry(job)):this.attentionExpiry(job);
    const timer=setTimeout(()=>{
      this.deadlineTimers.delete(job.id);const live=this.row(job.id);
      if(this.closed||live.status!=='needs_attention')return;
      if(this.expireProviderlessAttention(live,Math.max(Date.now(),live.deadline)))return; // a timer can fire a moment early
      if(this.expireAttention(live))return;
      if(!live.providerId||live.deadlineCancellationAttempted)return;
      this.save(live,{status:'cancelling',cancelRequested:true,deadlineCancellationAttempted:true});this.pump();
    },Math.max(1,fireAt-Date.now()));
    timer.unref?.();this.deadlineTimers.set(job.id,timer);
  }
  pump(){
    if(this.closed)return;
    const jobs=this.store.query("SELECT data FROM listing_investigations WHERE status NOT IN ('completed','failed','cancelled','needs_attention') ORDER BY created").map(r=>JSON.parse(r.data));
    for(const job of jobs){
      if(this.active.size>=2)break;if(this.active.has(job.id))continue;
      const state={controller:new AbortController(),done:null};this.active.set(job.id,state);
      state.done=this.work(job,state).finally(()=>{this.active.delete(job.id);this.pump();});
    }
  }
  async cancel(owner,id){
    const job=this.row(id);if(job?.owner!==owner)throw fail('Investigation not found.',404);
    if(['completed','failed','cancelled'].includes(job.status))return this.public(job);
    if(job.status==='needs_attention'&&!job.providerId)throw fail('Provider reconciliation is required before cancellation can be confirmed.',409);
    if(job.status==='queued'&&!this.active.has(id))return this.save(job,{status:'cancelled'});
    this.save(job,{cancelRequested:true,status:job.providerId?'cancelling':job.status});this.active.get(id)?.controller.abort(new Error('Cancellation requested.'));this.pump();return this.get(owner,id);
  }
  resume(owner,id){
    const job=this.row(id);if(job?.owner!==owner)throw fail('Investigation not found.',404);
    if(job.status!=='needs_attention'||!job.providerId)throw fail('This investigation cannot be reconnected automatically.',409);
    // Resuming is a fresh intent to retrieve: a cancel asked for earlier (by the user or the run
    // deadline) must not fire again in work(), and retrieval gets a fresh deadline window.
    const timer=this.deadlineTimers.get(id);if(timer){clearTimeout(timer);this.deadlineTimers.delete(id);}
    this.save(job,{status:'in_progress',error:null,cancelRequested:false,cancelSent:false,deadlineCancellationAttempted:false,attentionExpiresAt:null,deadline:Date.now()+DEPTH_POLICY[job.depth].deadlineMs});this.pump();return this.get(owner,id);
  }
  async settle(job,amount=job.rate?.amountMicros,details={}){
    if(this.wallet&&['dispatched','pending'].includes(job.billing)){
      await this.wallet.settle(job.owner,job.id,amount,{provider:'gemini_deep_research',depth:job.depth,usage:job.usage,estimated:true,...details});this.save(job,{billing:'settled'});
    }
  }
  async work(initial,state){
    let job=initial;
    const timer=job.raw?.status==='completed'?null:setTimeout(()=>{const live=this.row(job.id);if(INVESTIGATION_TERMINAL.includes(live.status))return;this.save(live,{cancelRequested:true,deadlineCancellationAttempted:true});state.controller.abort(new Error('Research deadline reached.'));},Math.max(1,job.deadline-Date.now()));timer?.unref?.();
    try{
      if(!job.providerId){
        this.save(job,{status:'preparing'});
        try{job.records=await this.records(job.snapshot,recordPlan(job));}catch{job.records={status:'unavailable',reason:'Public-record prefetch did not complete. Verify official sources during research.'};}
        const latest=this.row(job.id);if(latest.cancelRequested||this.closed){this.save({...job,...latest},{status:this.closed?'queued':'cancelled'});return;}
        job.prompt=investigationPrompt(job);job.promptHash=hash(job.prompt);this.save(job);
        if(this.wallet){
          this.save(job,{billing:'reserving'});
          try{await this.wallet.reserve(job.owner,job.id,job.rate.reserveMicros,{provider:'gemini_deep_research',runId:job.id,operation:`listing_research_${job.depth}`,dispatchGuardHash:createHash('sha256').update(job.dispatchGuard).digest('hex'),rateVersion:job.rate.version,basis:job.rate.basis,estimated:true});}
          catch(error){if(error.status===402)this.save(job,{billing:'not_started'});throw error;}
          job={...job,...this.row(job.id),billing:'reserved'};this.save(job);
          if(job.cancelRequested||this.closed){await this.wallet.releaseBeforeAttempt(job.owner,job.id,job.dispatchGuard);this.save(job,{status:'cancelled',billing:'released'});return;}
          await this.wallet.dispatch(job.owner,job.id);job={...job,...this.row(job.id),billing:'dispatched'};this.save(job);
        }
        this.save(job,{status:'creating'});
        const response=await this.provider.create(job.depth,job.prompt);
        if(!response.id)throw Object.assign(new Error('Research provider did not return an interaction ID.'),{ambiguous:true});
        job={...job,...this.row(job.id)};this.save(job,{providerId:response.id,status:'in_progress'});
      }
      let reconnects=0;
      while(!this.closed){
        job=this.row(job.id);
        if(job.cancelRequested&&job.raw?.status==='completed'){this.save(job,{status:'cancelled'});return;}
        if(job.cancelRequested&&!job.cancelSent){
          this.save(job,{status:'cancelling'});await this.provider.cancel(job.providerId);this.save(job,{cancelSent:true});
        }
        const response=job.raw?.status==='completed'?job.raw:await this.provider.get(job.providerId);
        job={...job,...this.row(job.id)};
        if(providerTerminal(response.status)){
          clearTimeout(timer);
          this.save(job,{raw:response,usage:response.usage||null});await this.settle(job,response.status==='failed'?0:job.rate?.amountMicros,response.status==='failed'?{outcome:'provider_failed'}:{});
          if(response.status==='completed'){
            if(job.cancelRequested){this.save(job,{status:'cancelled'});return;}
            const draft=reportFromInteraction(response,{recordSources:job.records?.sources||[]});this.save(job,{status:'reviewing'});state.controller=new AbortController();
            const result=job.reviewState?await this.provider.finishReview(job.reviewState,state.controller.signal):await this.provider.review(draft,{listing:job.snapshot,depth:job.depth,objective:job.objective,question:job.question,researchDate:new Date(job.created).toISOString(),publicRecords:investigationEvidencePacket(job.records)},state.controller.signal);
            if(this.closed)return;job=this.row(job.id);this.save(job,job.cancelRequested?{status:'cancelled'}:{status:'completed',result,error:null,reviewState:null});
          }
          else this.save(job,{status:response.status==='failed'?'failed':'cancelled',error:response.status==='failed'?'The research provider could not finish this investigation.':null});
          return;
        }
        if(this.closed)return;
        if(job.cancelRequested&&!job.cancelSent)continue;
        state.controller=new AbortController();
        try{
          for await(const {cursor,event} of this.provider.events(job.providerId,job.cursor,state.controller.signal)){
            job=this.row(job.id);if(cursor)job.cursor=cursor;
            const kind=event.event_type||event.type||'';
            if(kind==='interaction.status_update'||kind==='interaction.completed'||kind==='interaction.failed'||kind==='interaction.cancelled')this.save(job);
            else if(cursor)this.store.write('UPDATE listing_investigations SET data=? WHERE id=?',JSON.stringify(job),job.id);
            if(providerTerminal(event.status||event.interaction?.status))break;
          }
        }catch(error){
          if(this.closed)return;
          this.save(this.row(job.id),{lastStreamError:{name:error.name,code:error.code||error.cause?.code||null,status:error.statusCode||null}});
          if(this.row(job.id).cancelRequested&&!this.row(job.id).cancelSent)continue;
          if(++reconnects>2)throw new Error('Progress connection was interrupted. Reconnect to retrieve the existing investigation.');
        }
        if(++reconnects>4)throw new Error('Progress connection ended repeatedly. Reconnect to retrieve the existing investigation.');
      }
    }catch(error){
      if(error.reviewState)this.save(this.row(job.id),{reviewState:error.reviewState});
      if(this.closed)return;
      job=this.row(job.id);
      if(job.cancelRequested&&job.raw?.status==='completed'){this.save(job,{status:'cancelled'});return;}
      if(this.wallet&&job.billing==='dispatched'){
        await this.wallet.pending(job.owner,job.id,'Provider result requires reconciliation.').catch(()=>{});job.billing='pending';
      }
      // A stop the provider refuses (its interaction is gone or already finished) leaves nothing to reconcile
      // with it, so the job closes here; billing stays as recorded for reconciliation.
      if(job.cancelRequested&&[400,404,409,410].includes(error.statusCode)){this.save(job,{status:'cancelled',error:'The research provider no longer had this investigation running, so it was closed here. Any billing hold stays pending for reconciliation.'});return;}
      const needsAttention=Boolean(job.providerId||error.ambiguous||['reserving','reserved','dispatched','pending'].includes(job.billing));
      this.save(job,{status:needsAttention?'needs_attention':'failed',error:error.message,...(needsAttention&&!job.attentionExpiresAt?{attentionExpiresAt:Date.now()+ATTENTION_TTL_MS}:{})});
      if(needsAttention)this.armAttentionDeadline(job);
    }finally{clearTimeout(timer);}
  }
  async close(){this.closed=true;for(const timer of this.deadlineTimers.values())clearTimeout(timer);this.deadlineTimers.clear();for(const state of this.active.values())state.controller.abort(new Error('Server restarting.'));await Promise.allSettled([...this.active.values()].map(s=>s.done));}
}
