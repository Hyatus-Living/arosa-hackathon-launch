import {EventEmitter} from 'node:events';
import {research} from './research.mjs';
import {describe} from './project-state.mjs';
import {dealStoreAccess,isMarketAdmin} from './market-store.mjs';
import {Wallet,FirestoreWalletRepository,createUsageMeter} from './wallet.mjs';
import {decideListingFilters} from './listing-filter-jev.mjs';
import {listingSnapshotAfterUpdate} from './listing-filter-schema.mjs';
import {listingPageResearchContext} from './listing-page-context.mjs';
import {ResearchAdmission,researchSlots} from './admission.mjs';
import {abortable,withExecutionSignal,throwIfCancelled,stoppedError} from './execution-context.mjs';

export const SYSTEM_ERROR_MESSAGE='Arosa hit a server problem and could not finish this request. Try again in a minute.';

export class RunManager extends EventEmitter {
  // plans(account,conversation) gives a run's agent the plan tools' access to its project, or is null.
  // alerts(account,conversation) likewise binds the alert tools to the run's own account, or is null.
  constructor(store,secrets,execute=research,wallet=null,sessions=null,plans=null,filterDecider=decideListingFilters,alerts=null,admission=new ResearchAdmission(researchSlots(secrets))) {
    super(); this.filterDecider=filterDecider; this.sessions=sessions; this.plans=plans; this.alerts=alerts; this.store=store;this.secrets=secrets;this.execute=execute;this.active=new Map();this.wallet=wallet || (secrets.BILLING_ENABLED===true ? new Wallet(new FirestoreWalletRepository()) : null);store.recover();
    this.admission=admission;admission.onAvailable=()=>this.pump();
  }
  emitEvent(id,event,data={}) {const record=this.store.event(id,event,data);this.emit(id,record);return record;}
  enqueue(sender,conversation,message,id,listingFilters=null) {
    const run=this.store.createRun(sender,conversation,message,id,listingFilters);this.pump();return run;
  }
  pump() {
    if(this.draining||this.admission.closed)return;
    if(this.pumping){this.pumpRequested=true;return;}
    if(this.admission.active>=this.admission.limit)return;
    this.pumping=true;
    try {
      const pending=this.store.query("SELECT * FROM runs WHERE status='queued' ORDER BY created");
      while(this.admission.active<this.admission.limit&&pending.length) {
        const activeConversations=new Set([...this.active.values()].map(a=>a.run.conversation));
        const activeOwners=new Set([...this.active.values()].map(a=>a.run.owner));
        const eligible=pending.filter(r=>!activeConversations.has(r.conversation));
        if(!eligible.length)break;
        const run=eligible.find(r=>!activeOwners.has(r.owner))||eligible[0];
        pending.splice(pending.indexOf(run),1);
        const release=this.admission.acquire();
        const state={run,cancelled:false,finished:false,control:null,controller:new AbortController(),release};this.active.set(run.id,state);state.done=this.work(state);
      }
    } finally {
      this.pumping=false;
      if(this.pumpRequested){this.pumpRequested=false;this.pump();}
    }
  }
  work(state) {return withExecutionSignal(state.controller.signal,()=>this.runWork(state));}
  stopAdmission() { this.admission.close(); }
  async cancelActive() {
    await Promise.allSettled([...this.active.values()].map(state=>this.control(state.run.owner,state.run.id,'interrupt')));
  }
  settled() { return Promise.allSettled([...this.active.values()].map(state=>state.done)); }
  async runWork(state) {
    const {run}=state;
    const emit=(event,data)=>{if(!state.cancelled&&!state.finished)return this.emitEvent(run.id,event,data);};
    try {
      const listingFilters=this.store.runEvents?.(run.id)?.[0]?.listingFilters;
      const listingPage=listingFilters?.page??null;
      const history=this.store.begin(run,listingPage);
      const started=this.store.events(run.owner,run.id)?.at(-1);if(started)this.emit(run.id,started);
      const decision=listingFilters?await abortable(this.filterDecider(listingFilters,this.secrets)):null;
      throwIfCancelled();
      if(decision?.mode==='filters'){
        this.store.finish(run,state.cancelled?'interrupted':'completed',state.cancelled?null:{answer:decision.answer,sources:[],ui:[],filterContext:true,...(decision.filterUpdate?{filterUpdate:decision.filterUpdate}:{})},state.cancelled?'Stopped.':null);
        return;
      }
      const meter=this.wallet ? createUsageMeter({wallet:this.wallet,owner:run.owner,runId:run.id,rates:this.secrets.BILLING_RATES || {},emit,attempt:run.attempt}) : null;
      const composio=this.sessions?await abortable(this.sessions.forAccount(run.owner)):null;
      throwIfCancelled();
      const project=structuredClone(run.projectSnapshot.fields);
      const priorState=Object.fromEntries(Object.entries(project).filter(([,f])=>f&&f.stale===null&&f.value!==undefined).map(([k,f])=>[k,f.value]));
      const authorName=typeof this.store.harnessAuthorName==='function'?this.store.harnessAuthorName(run):null;
      const memories=typeof this.store.memoriesForRun==='function'?this.store.memoriesForRun(run.owner,run.conversation):[];
      const userHistory=this.store.userRequestContext?.(run)??null;
      // The run's account rides with its deal store access, so chat searches value deals at the account's saved costs.
      // The site page values the project's lot at its owner's costs whoever sends the message; siteAccount carries them.
      const dealStore={...dealStoreAccess(isMarketAdmin(this.store.personRow?.(run.owner)?.email)),account:run.owner,siteAccount:run.projectSnapshot.owner};
      const architecture=this.plans?.(run.owner,run.conversation)??null;
      const alerts=this.alerts?.(run.owner,run.conversation)??null;
      const listingContext=listingFilters?listingSnapshotAfterUpdate(listingFilters.snapshot,decision?.filterUpdate?.values||listingFilters.snapshot.values):null;
      const request=listingPage?`${listingPageResearchContext(listingPage)}\n\n${run.input}`:run.input;
      const message=listingContext?`[Authoritative listing filters for this request: ${JSON.stringify(listingContext)}]\nNative deal searches inherit these criteria, map area and costs. Requery for current matches; cards in the original page context may precede the requested changes. Use useCurrentFilters:false only for an explicitly broader or independent comparison. Research does not change the page controls.\n\n${request}`:request;
      const result=await this.execute({message,userMessage:run.input,history,userHistory,meter,composio,workflow:run.projectSnapshot.workflow,propertyBbl:project.property?.value?.bbl,project:describe(project),priorState,savedSources:()=>this.store.savedSources(run.projectSnapshot.id,project),authorName,memories,dealStore,architecture,listingContext,listingPage,alerts},this.secrets,status=>emit('status',{status}),emit,control=>{state.control=control;if(control&&state.cancelled)void control.interrupt().catch(e=>emit('control.failed',{error:e.message}));});
      if(decision){result.filterContext=true;if(decision.filterUpdate)result.filterUpdate=decision.filterUpdate;}
      if(state.cancelled)this.finalize(state,'interrupted',null,'Stopped.');
      else this.finalize(state,'completed',result);
    } catch(e) {
      // A system error (EACCES, ECONNRESET...) names server paths and means nothing to the reader;
      // they get a plain retry message and the log keeps the detail.
      const system=/^E[A-Z0-9_]+$/.test(String(e.code||''));
      if(system)console.error(JSON.stringify({event:'run_system_error',runId:run.id,code:e.code,message:String(e.message).slice(0,300)}));
      this.finalize(state,state.cancelled?'interrupted':'failed',null,state.cancelled?'Stopped.':system?SYSTEM_ERROR_MESSAGE:e.message,state.cancelled?null:e.partialResult);
    }
    finally {this.settle(state);}
  }
  // A run is finished once, by whichever arrives first: its own return, the interrupt watchdog, or
  // the sweep; a result that lands afterwards is dropped.
  finalize(state,status,result,error=null,partial=null) {
    if(state.finished)return false;
    state.finished=true;clearTimeout(state.watchdog);
    this.store.finish(state.run,status,result,error,partial);
    return true;
  }
  settle(state) {
    const {run}=state;
    if(!this.active.has(run.id))return;
    const last=this.store.runEvents?this.store.runEvents(run.id).at(-1):this.store.events(run.owner,run.id)?.at(-1);if(last)this.emit(run.id,last);
    this.active.delete(run.id);
    state.release();
    if(this.draining&&!this.active.size)this.drained();
    this.pump();
  }
  // Shutdown: start no further runs (new and queued ones stay queued in the database for the next
  // process) and resolve once every in-flight run has finished on its own deadline.
  drain() {
    this.draining=true;
    this.stopAdmission();
    this.drainedPromise??=new Promise(resolve=>{this.drained=resolve;if(!this.active.size)resolve();});
    return this.drainedPromise;
  }
  // A cancelled run that has not returned within the watchdog window is finalized as interrupted
  // so its conversation accepts new messages; the harness may still be winding down behind it.
  watchInterrupt(state) {
    const ms=Number(this.secrets?.INTERRUPT_WATCHDOG_MS)||15000;
    clearTimeout(state.watchdog);
    state.watchdog=setTimeout(()=>{if(this.finalize(state,'interrupted',null,'Stopped.'))this.settle(state);},ms);
    state.watchdog.unref?.();
  }
  async control(account,id,action,text) {
    const run=this.store.runRow?this.store.runRow(id):this.store.run(account,id);if(!run)return null;
    const access=typeof this.store.access==='function'?this.store.access(account,run.conversation):(run.owner===account?'owner':null);
    if(!access)return null;
    if(run.owner!==account&&access!=='owner'){const e=new Error('Only the sender or the conversation owner can control this run.');e.status=403;throw e;}
    const state=this.active.get(id);
    if(action==='interrupt') {
      if(run.status==='queued'){this.store.write("UPDATE runs SET status='interrupted',updated=? WHERE id=?",Date.now(),id);this.emitEvent(id,'run.interrupted',{error:'Removed from queue.'});return {status:'interrupted'};}
      if(!state)return {status:run.status};
      state.cancelled=true;state.controller.abort(stoppedError());this.watchInterrupt(state);await state.control?.interrupt();return {status:'interrupting'};
    }
    if(action==='steer') {
      if(!state?.control)throw new Error('This run is not ready for steering. Queue your message instead.');
      const multi=typeof this.store.isMultiAuthor==='function'&&this.store.isMultiAuthor(run.conversation,account);
      const harnessText=multi?`[${this.store.displayName(account)}] ${text}`:text;
      await state.control.steer(harnessText);
      this.store.addMessage(run.conversation,id,'user',text,{steer:true},account);this.emitEvent(id,'run.steered',{text});return {status:'steered'};
    }
    throw new Error('Unknown run control.');
  }
}
