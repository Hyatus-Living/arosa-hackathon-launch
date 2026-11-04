import http from 'node:http';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync,createReadStream} from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {research} from './research.mjs';
import {createTrace} from './trace.mjs';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {streamEvents} from './event-stream.mjs';
import {closeCodexPool} from './codex.mjs';
import {ResearchAdmission,researchSlots} from './admission.mjs';
import {ListingInvestigations,INVESTIGATION_TERMINAL} from './listing-investigations.mjs';
import {throwIfCancelled,withExecutionSignal,combinedSignal,abortable,executionSignal} from './execution-context.mjs';
import {createUsageMeter,validateRate} from './wallet.mjs';
import {Plans} from './plans.mjs';
import {processModelInput,MODEL_INPUT_MAX_BYTES} from './model-intake.mjs';
import {Crm} from './crm.mjs';
import {CrmEnrichment} from './crm-enrichment.mjs';
import {BetaTesters} from './beta.mjs';
import {Feedback} from './feedback.mjs';
import {runCodex} from './codex.mjs';
import {runMeta,resolveMetaModel} from './meta.mjs';
import {segmentHousingPhoto,illustrateHousing} from './meta-visual.mjs';
import {EvidenceStore} from './mcp-store.mjs';
import {createMcpDomain,createExaSearch} from './mcp-domain.mjs';
import {SessionStore} from './composio.mjs';
import {PublicToolError} from './public-http.mjs';
import {createGoogleMaps} from './places.mjs';
import {buildUnderwritingDeck,renderDeckHtml,selectReportSummary} from './deliverable.mjs';
import {openMarketStore,isMarketAdmin,dealStoreAccess,dealStoreEnabled,warmDealValuations, defaultGeosearchBbl} from './market-store.mjs';
import {pagePipeline} from './ledger.mjs';
import {budgetSplitOptions,fillSchemeBudgets,normalizeBudgetSplits} from './budget-lines.mjs';
import {requestSchemeRender,syncRenderPart} from './scheme-renders.mjs';
import {optionFiles} from './schemes.mjs';
import {quickKeep} from './keep.mjs';
import {createContextLoader} from './context.mjs';
import {Architecture,PLAN_MAX_BYTES} from './architecture-artifacts.mjs';
import {ArchitectureJobs} from './architecture-jobs.mjs';
import {SchemeDrafts} from './scheme-plans.mjs';
import {Drawings,DRAWING_MAX_BYTES,contentDisposition} from './architecture-drawings.mjs';
import {excludedSource,lotOf} from './architecture-tools.mjs';
import * as planning from './planning.mjs';
import {AlertStore} from './alerts.mjs';
import {mailerFromSecrets} from './alert-mailer.mjs';
import {startAlertSweeper} from './alert-runner.mjs';
// Architecture plans and jobs stay off until ACRES_ARCHITECTURE_ENABLED=true; jobs also need the
// worker executable. Plan builds use the same planning directory as the chat tools (research.mjs).
export function architectureOptions(secrets,env=process.env) {
  if(env.ACRES_ARCHITECTURE_ENABLED!=='true')return null;
  return {stateDir:'/home/openclaw/.openclaw/acres-state',emails:env.ACRES_ARCHITECTURE_EMAILS||'',worker:env.ACRES_ARCHITECTURE_WORKER||null,pipelineVersion:env.ACRES_ARCHITECTURE_PIPELINE_VERSION||'1',
    planningDir:secrets.ACRES_PLANNING_DIR||env.ACRES_PLANNING_DIR||undefined,buildPlan:planning.buildArchitectureRevision,lotPolygons:true};
}
// Each workflow can choose a provider without changing its project or tool boundary.
export function researchEngine(secrets,runner=research) {
  const engines={research:secrets.RESEARCH_ENGINE??'codex',modeling:secrets.MODELING_RESEARCH_ENGINE??secrets.RESEARCH_ENGINE??'codex',underwriting:secrets.UNDERWRITING_RESEARCH_ENGINE??secrets.RESEARCH_ENGINE??'codex'};
  for(const [workflow,engine] of Object.entries(engines)) {
    if(!['codex','meta'].includes(engine))throw new Error(`${workflow} research engine must be codex or meta, not ${engine}.`);
    if(engine==='meta') {
      if(!secrets.MODEL_API_KEY)throw new Error('The Meta research engine needs MODEL_API_KEY.');
      resolveMetaModel(secrets.META_MODEL);
    }
  }
  return (input,runSecrets,progress,emit,onControl)=>{
    const workflow=['modeling','underwriting'].includes(input.workflow)?input.workflow:'research';
    return runner(input,runSecrets,progress,emit,onControl,engines[workflow]==='meta'?runMeta:runCodex);
  };
}
export function createResearchServer({secrets,store,execute=researchEngine(secrets),wallet=null,mcp=null,sessions=null,maps=createGoogleMaps(secrets),marketStoreFactory=openMarketStore,architecture:architectureOptions=null,filterDecider,traceRoot,investigationProvider,investigationRecords,release=null,feedbackAgent=runCodex,crmEnrichment,visualFetch=fetch}) {
if(secrets.MCP_SERVICE_TOKEN&&(typeof secrets.MCP_SERVICE_TOKEN!=='string'||secrets.MCP_SERVICE_TOKEN.length<32))throw new Error('The MCP private API requires a strong separate service credential.');
if(secrets.MCP_SERVICE_TOKEN&&secrets.MCP_SERVICE_TOKEN===secrets.RESEARCH_TOKEN)throw new Error('The MCP private API must use a separate service credential.');
// Architecture plans, their drawings and processing jobs; absent when the service is not configured for them.
const architecture=architectureOptions?new Architecture(store,architectureOptions):null;
const architectureJobs=architecture?new ArchitectureJobs(architecture,architectureOptions):null;
const drawings=architecture?new Drawings(store,architectureOptions):null;
let modelIntakeBusy=false;
let visualJobs=0;
architectureJobs?.recover();
const renderContext=createContextLoader();
// Drafted plans are outlined on the city's tax-lot polygon, placed by the render context loader.
const schemeDrafts=architecture?new SchemeDrafts(architecture,architectureJobs,{loadContext:architectureOptions.loadContext??(architectureOptions.lotPolygons?renderContext.load:null),storedPolygonFor:bbl=>{const s=marketStoreFactory({readOnly:true});if(!s)return null;try{return s.lotPolygonFor(bbl);}finally{s.close();}}}):null;
schemeDrafts?.recover();
// A scheme's render part follows its render job; neighbours for envelope massings come from NYC footprints.
if(architectureJobs)architectureJobs.onRender=row=>syncRenderPart(store,row);
// The research agent works on the plan of the project its conversation belongs to, as the run's
// sender, when the sender is in the rollout list (ACRES_ARCHITECTURE_EMAILS, as in the web app).
// Entries mirror app-starter/auth.js: exact email, `@domain` suffix, or `*` for every verified
// account. An empty list admits everyone; a missing person row admits no one while a list is set.
const rollout=String(architectureOptions?.emails||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const rolloutAdmits=account=>{
  if(!rollout.length)return true;
  const email=String(store.personRow(account)?.email||'').trim().toLowerCase();
  return Boolean(email)&&rollout.some(entry=>entry==='*'||entry===email||(entry.startsWith('@')&&email.endsWith(entry)));
};
const planAccess=architecture?(account,conversation)=>{
  if(!rolloutAdmits(account))return null;
  const projectId=store.projectOf(conversation),view=architectureJobs.view;
  return {projectId,
    summary:scheme=>architecture.summary(account,projectId,view,scheme),
    drawings:()=>drawings.list(account,projectId),
    drawing:drawingId=>drawings.open(account,projectId,drawingId),
    attach:input=>{throwIfCancelled();return drawings.addFromUrl(account,projectId,{...input,by:'agent'});},
    save:({parentRevision,plan,scheme})=>{throwIfCancelled();return architecture.save(account,projectId,{parentRevision,plan,scheme,by:'agent'},view);},
    // One of the site's schemes as last priced (GET /projects/:id/schemes refreshes them), its lot, and its
    // storey outlines on the tax lot (null when the lot cannot be outlined), as Draft all three lays it out.
    scheme:async schemeId=>{
      const scheme=store.schemesView(projectId).schemes?.find(s=>s.id===schemeId);
      if(!scheme?.program)throw new Error(scheme?`The ${scheme.label} scheme has no building to lay out: ${scheme.note}`:'This site has no schemes yet; they are priced when the site page opens.');
      const state=store.project.read(projectId);
      return {scheme,lot:lotOf(state.property?.value),site:(await schemeDrafts.outlines(state,scheme)).site};
    },
    // The option card shows why a drafted plan was chosen and what it draws, until the plan is edited.
    describe:(schemeId,saved,fields)=>{
      const part=store.schemesView(projectId).schemes?.find(s=>s.id===schemeId)?.plan;
      if(part?.planId===saved.planId&&part.revision===saved.revision)store.setSchemePart(projectId,schemeId,'plan',{...part,...fields});
    },
    render:({planId,revision,settings})=>{throwIfCancelled();return architectureJobs.create(account,projectId,{planId,revision,settings});}};
}:null;
// Email alerts: rules live in the chat database; the handle binds every tool call to the
// run's own account, and delivery always goes to the verified email on that account.
const alertStore=new AlertStore(store);
const alertMailer=mailerFromSecrets(secrets);
const alertAccess=(account)=>{
  const email=store.personRow(account)?.email;
  if(!email)return null;
  return {email,
    prefs:()=>alertStore.prefs(account),
    setEnabled:enabled=>alertStore.setEnabled(account,enabled),
    list:()=>alertStore.list(account),
    create:input=>alertStore.create(account,input),
    update:(id,patch)=>alertStore.update(account,id,patch),
    remove:id=>alertStore.remove(account,id),
    deliveryConfigured:()=>alertMailer.configured,
    test:()=>alertStore.enqueue({account,dedupe:`test:${account}:${randomUUID()}`,subject:'Your Arosa alerts test email',body:'This is a test of your Arosa email alerts. If you received it, alerts are reaching this address.',cadence:'instant'})};
};
const admission=new ResearchAdmission(researchSlots(secrets));
const manager=new RunManager(store,secrets,execute,wallet,sessions,planAccess,filterDecider,alertAccess,admission);setImmediate(()=>manager.pump());
const investigations=new ListingInvestigations({store,secrets,wallet,...(investigationProvider?{provider:investigationProvider}:{}),...(investigationRecords?{records:investigationRecords}:{})});
setImmediate(()=>investigations.recover());
const betaTesters=new BetaTesters(store);
const plans=new Plans(store,{freeRunsPerMonth:secrets.FREE_RUNS_PER_MONTH,betaRunsPerMonth:secrets.BETA_RUNS_PER_MONTH,betaTesters,unmeteredEmails:secrets.PLAN_UNMETERED_EMAILS||[]});
const crm=new Crm(store);
const enrichment=new CrmEnrichment({store,crm,secrets,...(crmEnrichment||{})});
setImmediate(()=>enrichment.recover());
const feedback=new Feedback(store,{secrets,agent:feedbackAgent});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const accountRe=/^[a-f0-9]{24}$/;
const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function authenticated(header,token){if(!token)return false;const a=Buffer.from(header??''),b=Buffer.from(`Bearer ${token}`);return a.length===b.length&&timingSafeEqual(a,b);}
function respond(res,status,data){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
// The plan document is the one body allowed past 60 KB, up to its 2 MB cap.
async function planBody(req){
  let raw='',over=false;
  for await(const chunk of req){if(!over)raw+=chunk;if(raw.length>PLAN_MAX_BYTES+4096){over=true;raw='';}}
  if(over)fail(413,'The plan document exceeds 2 MB.');
  let input;try {input=JSON.parse(raw||'{}');}catch {fail(400,'Send the plan as valid JSON.');}
  if(Buffer.byteLength(JSON.stringify(input?.plan??null))>PLAN_MAX_BYTES)fail(413,'The plan document exceeds 2 MB.');
  return input;
}
const revisionRe=/^[1-9][0-9]{0,8}$/;
// A drawing upload: raw bytes up to the 25 MB PDF cap, or JSON {url, name} for the service to fetch.
async function drawingUpload(req,account,id) {
  store.requireProject(account,id,'participant');
  if(String(req.headers['content-type']||'').startsWith('application/json')) {
    const input=await body(req);
    return drawings.addFromUrl(account,id,{url:input.url,name:input.name,by:'user',allow:url=>!excludedSource(url)});
  }
  const chunks=[];let total=0;
  for await(const chunk of req){total+=chunk.length;if(total>DRAWING_MAX_BYTES)fail(413,'The drawing exceeds 25 MB.');chunks.push(chunk);}
  let name;try {name=decodeURIComponent(req.headers['x-drawing-name']||'');}catch {name='';}
  return drawings.add(account,id,{bytes:Buffer.concat(chunks),name,by:'user'});
}
const artifactExtension={plan:'json',svg:'svg',ifc:'ifc','pascal-scene':'json',idmap:'json','zd1-svg':'svg','zd1-pdf':'pdf',zoning:'json','drawings-pdf':'pdf',dxf:'dxf',schedules:'xlsx',selfcheck:'json',package:'zip',verification:'json',blend:'blend',preview:'png',glb:'glb',manifest:'json','render-street':'png','render-aerial':'png'};
const downloads=['ifc','blend','zd1-pdf','drawings-pdf','dxf','schedules','package'];
async function architectureRoute(req,res,account,id,rest) {
  if(!architecture)return respond(res,404,{error:'Not found.'});
  if(rest.length===1&&['visual-segment','visual-illustrate'].includes(rest[0])&&req.method==='POST') {
    const project=store.projectView(account,id);
    if(!project||project.workflow!=='modeling')return respond(res,404,{error:'Open a Modeling project to use image tools.'});
    store.requireProject(account,id,'participant');
    if(visualJobs>=2)return respond(res,429,{error:'Image tools are busy. Try again shortly.'});
    visualJobs++;
    const controller=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>22*1024*1024)fail(413,'Images exceed the upload limit.');chunks.push(chunk);}
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{fail(400,'Send valid image data.');}
      if(!input||typeof input!=='object')fail(400,'Send valid image data.');
      if(rest[0]==='visual-illustrate') {
        const concept=(project.fields.concepts?.value||[]).find(c=>c.id===input.conceptId&&(c.version??null)===input.conceptVersion);
        if(!concept)fail(409,'The selected building model has changed. Reload and try again.');
      }
      const operation=rest[0]==='visual-segment'?'meta_visual_segment':'meta_visual_illustrate';
      let rate=null,authorization=null,attempted=false;
      if(secrets.BILLING_ENABLED===true) {
        rate=validateRate(secrets.BILLING_RATES?.[operation]);
        if(rate.mode!=='estimated_call')fail(503,'Image pricing is not configured.');
        const quote=input.pricing;
        if(!quote||quote.version!==rate.version||quote.amountMicros!==rate.amountMicros||quote.reserveMicros!==rate.reserveMicros)fail(409,'Image pricing changed. Reload and review it before continuing.');
      }
      const idempotency=randomUUID();
      const fetcher=async(...args)=>{
        if(rate)authorization=await createUsageMeter({wallet:manager.wallet,owner:account,runId:idempotency,rates:{[operation]:rate}}).authorize('meta',operation,rate);
        const invoke=()=>{attempted=true;console.log(JSON.stringify({event:'visual_usage',phase:'dispatched',operation,account,requestId:idempotency}));return visualFetch(...args);};
        return authorization?authorization.invoke(invoke,{signal:controller.signal}):invoke();
      };
      try {
        const options={key:secrets.MODEL_API_KEY,signal:controller.signal,fetcher};
        const result=rest[0]==='visual-segment'?await segmentHousingPhoto(input,options):await illustrateHousing(input,options);
        if(rest[0]==='visual-illustrate')result.provenance={...result.provenance,conceptId:input.conceptId,conceptVersion:input.conceptVersion??null};
        if(authorization)await authorization.settle({});
        if(attempted)console.log(JSON.stringify({event:'visual_usage',phase:'completed',operation,account,requestId:idempotency}));
        return respond(res,200,result);
      } catch(error) {
        if(authorization)await authorization.pending('Image provider outcome needs reconciliation.');
        if(attempted)console.log(JSON.stringify({event:'visual_usage',phase:'unknown',operation,account,requestId:idempotency}));
        throw error;
      }
    } finally {visualJobs--;}
  }
  if(rest.length===1&&['import-ifc','validate-scan'].includes(rest[0])&&req.method==='POST') {
    const project=store.projectView(account,id);
    if(!project||project.workflow!=='modeling')return respond(res,404,{error:'Open a Modeling project to import a model or check a scan.'});
    store.requireProject(account,id,'participant');
    if(modelIntakeBusy)return respond(res,429,{error:'Another model is being processed. Try again shortly.'});
    modelIntakeBusy=true;
    try {
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>Math.ceil(MODEL_INPUT_MAX_BYTES/3)*4+3*1024*1024)fail(413,'The model upload exceeds 25 MB.');chunks.push(chunk);}
      let input;try {input=JSON.parse(Buffer.concat(chunks).toString());}catch {fail(400,'Send the model upload as JSON.');}
      if(!input||typeof input!=='object')fail(400,'Send the model upload as JSON.');
      return respond(res,200,await processModelInput(rest[0],input,{run:request=>planning.spawnPlanner(request,{planningDir:architectureOptions.planningDir}),retain:file=>drawings.add(account,id,{...file,by:'user'})}));
    } finally {modelIntakeBusy=false;}
  }
  const view=architectureJobs.view;
  // Every plan route reads or writes one scheme's plan, the as-of-right plan when none is named.
  const scheme=new URL(req.url,'http://localhost').searchParams.get('scheme')||undefined;
  if(rest.length===0&&req.method==='GET')return respond(res,200,architecture.summary(account,id,view,scheme));
  if(rest[0]==='plan'&&rest.length===1&&req.method==='PUT') {
    const input=await planBody(req);
    try {
      const saved=await architecture.save(account,id,{parentRevision:input.parentRevision,plan:input.plan,scheme:input.scheme??scheme,by:'user'},view);
      // An editor save delivers the walkthrough as the agent's saves do: queue (or reuse) the render
      // for the new revision. A render that cannot start never fails the save; the section shows
      // the revision without a job.
      try {await architectureJobs.create(account,id,{planId:saved.planId,revision:saved.revision});}
      catch(error) {console.error(JSON.stringify({event:'architecture_render_not_queued',projectId:id,revision:saved.revision,message:String(error.message).slice(0,300)}));}
      return respond(res,201,architecture.revision(account,id,saved.revision,view,saved.scheme));
    }
    catch(e) {
      if(e.status===409)return respond(res,409,{error:e.message,revision:e.revision});
      if(e.status===400&&e.validationErrors)return respond(res,400,{error:e.message,validationErrors:e.validationErrors});
      throw e;
    }
  }
  if(rest[0]==='schemes'&&rest[1]==='draft'&&rest.length===2&&req.method==='POST')return respond(res,202,schemeDrafts.start(account,id));
  if(rest[0]==='schemes'&&rest[1]==='draft'&&rest.length===2&&req.method==='GET')return respond(res,200,schemeDrafts.list(account,id));
  if(rest[0]==='drawings'&&rest.length===1&&req.method==='POST')return respond(res,201,await drawingUpload(req,account,id));
  if(rest[0]==='drawings'&&rest.length===1&&req.method==='GET')return respond(res,200,{drawings:drawings.list(account,id)});
  if(rest[0]==='drawings'&&rest.length===2&&req.method==='GET') {
    const file=uuid.test(rest[1])?drawings.open(account,id,rest[1]):null;
    if(!file)return respond(res,404,{error:'Drawing not found.'});
    const {drawing}=file,etag=`"${drawing.sha256}"`;
    const headers={'content-type':drawing.contentType,'etag':etag,'cache-control':'private, no-cache','x-content-type-options':'nosniff',
      'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox",'content-disposition':contentDisposition(drawing.name)};
    if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
    res.writeHead(200,{...headers,'content-length':drawing.bytes});
    file.stream().on('error',()=>res.destroy()).pipe(res);
    return;
  }
  if(rest[0]==='revisions'&&rest.length===2&&req.method==='GET') {
    if(!revisionRe.test(rest[1]))return respond(res,404,{error:'Revision not found.'});
    return respond(res,200,architecture.revision(account,id,Number(rest[1]),view,scheme));
  }
  if(rest[0]==='jobs'&&rest.length===1&&req.method==='POST') {
    const input=await body(req);
    const job=await architectureJobs.create(account,id,{scheme:input.scheme??scheme,revision:input.revision,settings:input.settings});
    return respond(res,job.reused?200:202,job);
  }
  if(rest[0]==='jobs'&&rest.length>=2&&!uuid.test(rest[1]))return respond(res,404,{error:'Job not found.'});
  if(rest[0]==='jobs'&&rest.length===2&&req.method==='GET') {
    const job=architectureJobs.get(account,id,rest[1]);
    return respond(res,job?200:404,job||{error:'Job not found.'});
  }
  if(rest[0]==='jobs'&&rest[2]==='cancel'&&rest.length===3&&req.method==='POST') {
    if(!architectureJobs.get(account,id,rest[1]))return respond(res,404,{error:'Job not found.'});
    return respond(res,200,architectureJobs.cancel(account,id,rest[1]));
  }
  if(rest[0]==='artifacts'&&rest.length===2&&req.method==='GET') {
    const file=uuid.test(rest[1])?architecture.open(account,id,rest[1]):null;
    if(!file)return respond(res,404,{error:'Artifact not found.'});
    return sendArtifact(req,res,file);
  }
  return respond(res,404,{error:'Not found.'});
}
function sendArtifact(req,res,{artifact,stream}) {
  const etag=`"${artifact.sha256}"`;
  const headers={'content-type':artifact.contentType,'etag':etag,'cache-control':'private, no-cache','x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox",'x-architecture-revision':String(artifact.revision),
    'content-disposition':`${downloads.includes(artifact.kind)?'attachment':'inline'}; filename="${artifact.kind}-r${artifact.revision}.${artifactExtension[artifact.kind]}"`};
  if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
  res.writeHead(200,{...headers,'content-length':artifact.bytes});
  stream().on('error',()=>res.destroy()).pipe(res);
}
// An option link (store.createOptionLink), relayed by the web app without a sign-in: the option as it
// was sent, or one of the files it names.
const optionPath=/^\/public\/options\/([\w-]{43})(?:\/files\/([0-9a-f-]{36}))?$/;
function optionRoute(req,res,match) {
  const option=store.optionLink(match[1]);
  if(!option)return respond(res,404,{error:'This link is not available.'});
  const {project,...shown}=option;
  if(!match[2])return respond(res,200,shown);
  const row=optionFiles(option).includes(match[2])?architecture?.artifactRow(project,match[2]):null;
  if(!row)return respond(res,404,{error:'File not found.'});
  return sendArtifact(req,res,{artifact:{kind:row.kind,revision:row.revision,sha256:row.sha256,bytes:row.bytes,contentType:row.content_type},stream:()=>createReadStream(row.path)});
}
function body(req,{signal,check=()=>signal?.throwIfAborted()}={}) {
  check();
  return new Promise((resolve,reject)=>{
    let raw='';
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);signal?.removeEventListener('abort',abort);};
    const error=reason=>{cleanup();req.pause();reject(reason);};
    const abort=()=>error(signal.reason);
    const aborted=()=>error(new DOMException('The request was cancelled.','AbortError'));
    const data=chunk=>{raw+=chunk;if(raw.length>60000)error(new Error('Request is too large.'));};
    const end=()=>{cleanup();try{check();resolve(JSON.parse(raw||'{}'));}catch(reason){reject(reason);}};
    req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
function message(value){if(typeof value!=='string'||!value.trim()||value.length>3000)throw new Error('Enter a question of up to 3,000 characters.');return value.trim();}
function fail(status,text){const e=new Error(text);e.status=status;throw e;}
function validEmail(value){if(typeof value!=='string')fail(400,'A valid email is required.');const email=value.trim().toLowerCase();if(email.length>320||!emailRe.test(email))fail(400,'A valid email is required.');return email;}
function optionalEmail(value){return value===undefined||value===null||value==='' ? undefined : validEmail(value);}
function validAccount(value){if(typeof value!=='string'||!accountRe.test(value))fail(400,'A valid account is required.');return value;}
function inviteeAccount(input){
  const candidate=input?.account||(input?.principalType==='account'?input?.principal:undefined);
  if(candidate)return validAccount(candidate);
  if(input?.email&&typeof store.personByEmail==='function'){const found=store.personByEmail(validEmail(input.email));if(found)return found.account;}
  fail(400,'A valid account is required.');
}
function validRole(value){if(value!=='viewer'&&value!=='participant')fail(400,'Role must be viewer or participant.');return value;}
function validName(value){if(typeof value!=='string'||!value.trim()||value.trim().length>80)fail(400,'Name must be 1 to 80 characters.');return value.trim();}
function expiresAt(input){const v=input?.expiresAt??input?.expires_at??null;if(v===null||v===undefined)return null;const n=typeof v==='number'?v:(typeof v==='string'&&v.trim()?Number(v):NaN);if(!Number.isFinite(n))fail(400,'Invalid link expiry.');return n;}
let draining=false,drainPromise;
const requests=new Map(),background=new Set(),responses=new Set();
const track=promise=>{background.add(promise);promise.then(()=>background.delete(promise),()=>background.delete(promise));return promise;};
// Aggregate totals for the public site's stats strip, recomputed at most every five minutes.
let publicStatsCache=null;
function publicStats(){
  if(publicStatsCache&&Date.now()-publicStatsCache.at<300000)return publicStatsCache.value;
  const market=marketStoreFactory();
  try {
    const value={...market?.publicCounts(),...store.publicCounts(),updatedAt:new Date().toISOString()};
    publicStatsCache={at:Date.now(),value};
    return value;
  } finally {market?.close?.();}
}
const server=http.createServer((req,res)=>{
  // A draining process keeps serving (new runs stay queued for the next one), but closes each
  // connection after its response so callers reconnect to the next process once this one stops listening.
  if(draining)res.setHeader('connection','close');
  const controller=new AbortController(),enteredAt=Date.now();
  responses.add(res);res.once('close',()=>responses.delete(res));
  const task=withExecutionSignal(controller.signal,()=>handle(req,res,enteredAt));
  requests.set(task,controller);
  task.catch(()=>{if(!res.headersSent)respond(res,500,{error:'The request could not be completed.'});else res.end();}).finally(()=>requests.delete(task));
});
// Connections accepted but still without a request, which a drain must not reset.
const fresh=new Set();
server.on('connection',socket=>{fresh.add(socket);socket.once('close',()=>fresh.delete(socket));});
server.on('request',req=>fresh.delete(req.socket));
async function handle(req,res,enteredAt){
  res.setHeader('cache-control','no-store');
  let url;try {url=new URL(req.url,'http://localhost');}catch {return respond(res,400,{error:'Invalid request URL.'});}
  if(url.pathname.startsWith('/mcp-api/')) {
    const requestId=/^[a-f0-9-]{36}$/.test(req.headers['x-request-id']||'')?req.headers['x-request-id']:randomUUID();
    res.setHeader('x-request-id',requestId);
    const disconnect=new AbortController(),budget=new AbortController();
    const upstream=Number(req.headers['x-acres-deadline']??enteredAt+27000);
    const deadline=Math.min(enteredAt+27000,upstream),remaining=deadline-Date.now();
    const timeout=new PublicToolError('REQUEST_TIMEOUT','The request exceeded its time limit.',504);
    const expire=()=>budget.abort(timeout);
    const timer=Number.isFinite(remaining)&&remaining>0?setTimeout(expire,remaining):null;
    if(!timer)expire();
    const signal=combinedSignal(executionSignal(),disconnect.signal,budget.signal);
    const check=()=>{signal.throwIfAborted();if(Date.now()>=deadline){expire();signal.throwIfAborted();}};
    const disconnected=()=>{if(!res.writableFinished)disconnect.abort();};
    req.once('aborted',disconnected);res.once('close',disconnected);
    try {
      if(!authenticated(req.headers.authorization,secrets.MCP_SERVICE_TOKEN)){res.setHeader('connection','close');return respond(res,401,{error:{code:'UNAUTHORIZED',message:'Unauthorized'}});}
      check();
      if(!mcp||req.method!=='POST'||!/^\/mcp-api\/tools\/[a-z_]+$/.test(url.pathname))throw new PublicToolError('TOOL_NOT_FOUND','This private operation is unavailable.',404);
      let payload;try {payload=await body(req,{signal,check});}catch {check();throw new PublicToolError('INVALID_INPUT','Send valid, bounded JSON tool arguments.',400);}
      if(!payload||Object.keys(payload).some(key=>key!=='arguments'))throw new PublicToolError('INVALID_INPUT','Only tool arguments are accepted.',400);
      check();
      const result=await withExecutionSignal(signal,()=>abortable(track(mcp.call(url.pathname.split('/').at(-1),payload.arguments,{accountId:req.headers['x-acres-account'],workspaceId:req.headers['x-acres-workspace'],requestId})),signal));
      check();
      return respond(res,200,{...result,requestId});
    } catch(error) {
      if(signal.aborted)error=signal.reason===timeout?timeout:new PublicToolError('REQUEST_CANCELLED','The request was cancelled.',504);
      if(!req.complete){req.pause();res.setHeader('connection','close');res.once('finish',()=>req.destroy());}
      if(res.destroyed)return;
      const known=error instanceof PublicToolError;
      const code=known?error.code:'SERVICE_UNAVAILABLE';
      console.error(JSON.stringify({event:'mcp_domain_failed',requestId,code}));
      return respond(res,known?error.status:503,{error:{code,message:known?error.message:'Arosa could not complete this operation.'},requestId});
    } finally {if(timer)clearTimeout(timer);req.off('aborted',disconnected);res.off('close',disconnected);}
  }
  // Deploy health: the installed release, whether this process is draining and the work a drain
  // waits for (runs and plan jobs; listing investigations resume in the next process).
  if(url.pathname==='/healthz'&&req.method==='GET')return respond(res,200,{ok:true,release,draining,
    active:manager.active.size+(architectureJobs?.active.size??0)});
  if(!authenticated(req.headers.authorization,secrets.RESEARCH_TOKEN))return respond(res,401,{error:'Unauthorized'});
  if(url.pathname==='/public-stats'&&req.method==='GET')return respond(res,200,publicStats());
  // Any other path under /public/options is a mistyped or truncated link, not an account route.
  if(req.method==='GET'&&url.pathname.startsWith('/public/options/')){
    const option=optionPath.exec(url.pathname);
    return option?optionRoute(req,res,option):respond(res,404,{error:'This link is not available.'});
  }
  // Applications from the public beta page on witharosa.ai, relayed by the web app.
  if(url.pathname==='/public/beta-applications'&&req.method==='POST') {
    try {return respond(res,200,crm.apply(await body(req)));}
    catch(error) {if(error.status)return respond(res,error.status,{error:error.message});throw error;}
  }
  let trace;
  try {
    // Keep the old release usable while its client migrates to durable runs.
    if(req.method==='POST'&&url.pathname==='/research') {
      if(secrets.BILLING_ENABLED===true)return respond(res,410,{error:'Use account-scoped research runs.'});
      const release=admission.acquire();
      if(!release)return respond(res,429,{error:'Research is busy. Please try again shortly.'});
      try {
      const input=await body(req);input.message=message(input.message);delete input.dealStore;delete input.workflow; // The run manager supplies trusted project workflow and deal access.
      if(!Array.isArray(input.history??[])||(input.history??[]).some(x=>!['user','assistant'].includes(x.role)||typeof x.text!=='string'||x.text.length>10000))return respond(res,400,{error:'Invalid conversation.'});
      trace=createTrace(input,traceRoot);
      const result=await execute(input,secrets,status=>trace.emit('status',{status}),trace.emit);trace.emit('run.completed',{result});return respond(res,200,{...result,traceId:trace.id});
      } finally {release();}
    }
    // The signed stop link in an alert email; the web app forwards it without a sign-in.
    if(url.pathname==='/alerts/unsubscribe'&&req.method==='POST')return respond(res,200,alertStore.unsubscribe((await body(req)).token));
    const account=req.headers['x-acres-account'];
    if(typeof account!=='string'||!accountRe.test(account))return respond(res,401,{error:'Account identity is required.'});
    const emailHeader=req.headers['x-acres-email'];
    let email;
    if(emailHeader!==undefined&&emailHeader!=='') {
      if(typeof emailHeader!=='string'||emailHeader.length>320||!emailRe.test(emailHeader.trim().toLowerCase()))return respond(res,401,{error:'Account identity is required.'});
      email=emailHeader.trim().toLowerCase();
    }
    if(email&&typeof store.touchPerson==='function')store.touchPerson(account,email);
    if(url.pathname==='/run-titles'&&req.method==='GET')return respond(res,200,{titles:store.runTitles(account,String(url.searchParams.get('ids')||'').split(',').filter(Boolean))});
    // The account's plan and this month's usage; the web app reads it and records Stripe subscription changes.
    const planEmail=()=>email||store.personRow(account)?.email;
    if(url.pathname==='/plan'&&req.method==='GET')return respond(res,200,plans.status(account,planEmail()));
    if(url.pathname==='/plan/subscription'&&req.method==='PUT'){plans.record(account,await body(req));return respond(res,200,plans.status(account,planEmail()));}
    if(url.pathname==='/billing-policy'&&req.method==='GET') {
      const rates={};
      for(const [name,value] of Object.entries(secrets.BILLING_RATES || {})) {
        try {
          const rate=validateRate(value);
          rates[name]={mode:rate.mode,version:rate.version,basis:rate.basis,reserveMicros:rate.reserveMicros,...(rate.mode==='estimated_call'?{amountMicros:rate.amountMicros}:{}),...(rate.mode==='estimated_tokens'?{inputMicrosPerMillion:rate.inputMicrosPerMillion,cachedInputMicrosPerMillion:rate.cachedInputMicrosPerMillion,outputMicrosPerMillion:rate.outputMicrosPerMillion}:{})};
        } catch { /* Unconfigured providers cannot spend. */ }
      }
      return respond(res,200,{enabled:secrets.BILLING_ENABLED===true,ready:Boolean(rates.codex),rates});
    }
    if(url.pathname==='/street-view'&&req.method==='GET') {
      if(!maps)return respond(res,404,{error:'Street photos are not configured.'});
      try {
        const image=await maps.streetViewImage({pano:url.searchParams.get('pano'),heading:url.searchParams.get('heading'),fov:url.searchParams.get('fov')||90});
        res.writeHead(200,{'content-type':image.contentType,'content-length':image.bytes.length,'cache-control':'private, max-age=86400'});return res.end(image.bytes);
      } catch(error) {
        const known=error instanceof PublicToolError;return respond(res,known?error.status:503,{error:known?error.message:'The street photo is unavailable.'});
      }
    }
    if(url.pathname==='/conversations') {
      if(req.method==='GET')return respond(res,200,{conversations:store.list(account,(url.searchParams.get('q')||'').slice(0,200))});
      if(req.method==='POST') {
        const input=await body(req);
        if(input.projectId!==undefined&&!uuid.test(input.projectId||''))return respond(res,404,{error:'Project not found.'});
        if(input.bbl!==undefined&&(input.projectId!==undefined||typeof input.bbl!=='string'||!/^\d{10}$/.test(input.bbl)))return respond(res,400,{error:'bbl must be a 10-digit BBL for a new site.'});
        if(input.clientDraftId!==undefined&&!uuid.test(input.clientDraftId||''))return respond(res,400,{error:'clientDraftId must be a UUID.'});
        return respond(res,201,store.createConversation(account,{projectId:input.projectId,bbl:input.bbl,clientDraftId:input.clientDraftId}));
      }
    }
    const parts=url.pathname.split('/').filter(Boolean).map(seg=>{try{return decodeURIComponent(seg);}catch{return seg;}});
    // DOB new buildings and major alterations around a site, from the development ledger.
    if(parts[0]==='nearby-pipeline'&&parts.length===1&&req.method==='GET') {
      const sp=url.searchParams;
      return respond(res,200,pagePipeline({latitude:Number(sp.get('lat')),longitude:Number(sp.get('lng')),zip:sp.get('zip'),bbl:sp.get('bbl')}));
    }
    if(parts[0]==='listing-investigations') {
      if(parts[1]==='policy'&&req.method==='GET')return respond(res,200,investigations.policy());
      if(parts.length===1&&req.method==='GET')return respond(res,200,{investigations:investigations.list(account,(url.searchParams.get('listingId')||'').slice(0,300))});
      if(parts.length===1&&req.method==='POST') {
        if(!dealStoreAccess(isMarketAdmin(email)).read)return respond(res,403,{error:'Listing access is unavailable.'});
        const input=await body(req);
        if(typeof input.listingId!=='string'||!input.listingId||input.listingId.length>300)return respond(res,400,{error:'Choose a listing.'});
        const mStore=marketStoreFactory();if(!mStore)return respond(res,503,{error:'Market store is unavailable.'});
        try {
          const page=mStore.searchDealsPage({listingId:input.listingId,includeSimilarComps:false});
          if(!page.deals.length)return respond(res,404,{error:'Listing not found.'});
          plans.assertCanRun(account,planEmail());
          return respond(res,202,investigations.create(account,input,page.deals[0]));
        }finally{mStore.close?.();}
      }
      const id=parts[1];if(!uuid.test(id||''))return respond(res,404,{error:'Investigation not found.'});
      const job=investigations.get(account,id);if(!job)return respond(res,404,{error:'Investigation not found.'});
      if(parts.length===2&&req.method==='GET')return respond(res,200,job);
      if(parts.length===3&&parts[2]==='cancel'&&req.method==='POST')return respond(res,200,await investigations.cancel(account,id));
      if(parts.length===3&&parts[2]==='resume'&&req.method==='POST')return respond(res,200,investigations.resume(account,id));
      if(parts.length===3&&parts[2]==='events'&&req.method==='GET') {
        const after=Number(req.headers['last-event-id']||url.searchParams.get('after')||0);
        if(!Number.isSafeInteger(after)||after<0)return respond(res,400,{error:'Invalid event cursor.'});
        streamEvents({res,after,readPage:(cursor,limit)=>investigations.events(account,id,cursor,limit),
          subscribe:listener=>{investigations.on(id,listener);return()=>investigations.off(id,listener);},
          allowed:()=>Boolean(investigations.get(account,id)),finished:()=>INVESTIGATION_TERMINAL.includes(investigations.get(account,id)?.status)});
        return;
      }
      return respond(res,404,{error:'Not found.'});
    }
    // Beta feedback: beta testers (and admins, to try it) talk with the feedback agent.
    if(parts[0]==='feedback') {
      if(!betaTesters.has(email)&&!isMarketAdmin(email))return respond(res,403,{error:'Feedback is open to beta testers.'});
      if(parts.length===1&&req.method==='POST')return respond(res,201,await feedback.start(account,email,await body(req)));
      if(parts.length===3&&uuid.test(parts[1])&&parts[2]==='messages'&&req.method==='POST')return respond(res,200,await feedback.send(account,parts[1],(await body(req)).text));
      if(parts.length===3&&uuid.test(parts[1])&&parts[2]==='finish'&&req.method==='POST')return respond(res,200,await feedback.finish(account,parts[1]));
      return respond(res,404,{error:'Not found.'});
    }
    // Beta testers and their feedback, for admins. Granting also marks matching outreach contacts invited.
    if(parts[0]==='admin'&&(parts[1]==='beta-testers'||parts[1]==='feedback')) {
      if(!isMarketAdmin(email))return respond(res,403,{error:'Admin access is required.'});
      if(parts[1]==='beta-testers'&&parts.length===2&&req.method==='GET')return respond(res,200,{betaTesters:betaTesters.list()});
      if(parts[1]==='beta-testers'&&parts.length===2&&req.method==='POST') {
        const granted=betaTesters.grant((await body(req)).email,email);
        return respond(res,200,{email:granted,invitedContacts:crm.markBetaInvited(granted),betaTesters:betaTesters.list()});
      }
      if(parts[1]==='beta-testers'&&parts.length===3&&req.method==='DELETE')return respond(res,200,{email:betaTesters.revoke(parts[2]),betaTesters:betaTesters.list()});
      if(parts[1]==='feedback'&&parts.length===2&&req.method==='GET')return respond(res,200,{sessions:feedback.list()});
      if(parts[1]==='feedback'&&parts.length===3&&uuid.test(parts[2])&&req.method==='GET')return respond(res,200,feedback.get(parts[2]));
      return respond(res,404,{error:'Not found.'});
    }
    // Outreach CRM: the team's contact list and reach-out log. Admins only.
    if(parts[0]==='admin'&&parts[1]==='crm') {
      if(!isMarketAdmin(email))return respond(res,403,{error:'Admin access is required.'});
      try {
        if(parts.length===2&&req.method==='GET')return respond(res,200,{...crm.list(),betaTesters:betaTesters.list(),enrichment:enrichment.status()});
        // Contact enrichment: per-contact actions, the bulk run's plan (count and estimate) and its confirmed start.
        if(parts.length===4&&parts[2]==='enrich'&&parts[3]==='plan'&&req.method==='GET'){const {items,...plan}=enrichment.plan();return respond(res,200,plan);}
        if(parts.length===3&&parts[2]==='enrich'&&req.method==='POST')return respond(res,200,enrichment.start((await body(req)).capUsd,email));
        if(parts.length===4&&uuid.test(parts[2])&&parts[3]==='enrich'&&req.method==='POST')return respond(res,200,enrichment.request(parts[2],(await body(req)).action,email));
        if(parts.length===3&&parts[2]==='import'&&req.method==='POST') {const input=await body(req);return respond(res,200,crm.import(input.source,input.contacts));}
        if(parts.length===3&&parts[2]==='segment'&&req.method==='POST') {const input=await body(req);return respond(res,200,crm.segment(input.source,input.segment));}
        if(parts.length===3&&uuid.test(parts[2])&&req.method==='PATCH')return respond(res,200,crm.update(parts[2],await body(req)));
        if(parts.length===4&&uuid.test(parts[2])&&parts[3]==='touches'&&req.method==='POST')return respond(res,200,crm.touch(parts[2],email,await body(req)));
        return respond(res,404,{error:'Not found.'});
      } catch(error) {
        if(error.status)return respond(res,error.status,{error:error.message});
        throw error;
      }
    }
    // Admin Market Store & Underwriting Configuration
    if(parts[0]==='admin'&&parts[1]==='market-store') {
      if(!isMarketAdmin(email))return respond(res,403,{error:'Admin access is required.'});
      const mStore=marketStoreFactory();
      if(!mStore)return respond(res,503,{error:'Market store is unavailable.'});
      try {
        if(parts.length===2&&req.method==='GET') {
          return respond(res,200,mStore.statusSummary());
        }
        if(parts.length===3&&parts[2]==='config'&&(req.method==='PUT'||req.method==='POST')) {
          const input=await body(req);
          const updated=mStore.updateAdminConfig({
            syncConfig:input.syncConfig||null,
            dealSettings:input.dealSettings||null,
            revalueDeals:input.revalueDeals!==false,
            updatedBy:email,
          });
          return respond(res,200,{...updated,storeStatus:mStore.statusSummary()});
        }
        if(parts.length===3&&parts[2]==='sync'&&req.method==='POST') {
          if(!dealStoreAccess(true).sync)return respond(res,403,{error:'Deal store syncing is disabled. Set ACRES_DEAL_STORE_ENABLED=true to allow it.'});
          const input=await body(req);
          const locations=Array.isArray(input.locations)&&input.locations.length?input.locations.map(String):null;
          const summary=await mStore.syncMarket({
            locations,
            listingTypes:Array.isArray(input.listingTypes)&&input.listingTypes.length?input.listingTypes:null,
            limitPerType:input.limitPerType!=null?Math.min(1000,Math.max(10,Number(input.limitPerType))):null,
            updatedInPastHours:input.updatedInPastHours!==undefined?(input.updatedInPastHours?Number(input.updatedInPastHours):null):undefined,
            pastDays:input.pastDays!=null?Number(input.pastDays):null,
            enrichPluto:input.enrichPluto!==undefined?Boolean(input.enrichPluto):null,
            fullForSalePull:input.fullForSalePull!==undefined?Boolean(input.fullForSalePull):null,
          });
          // Newly matched lots get their flood zone and MIH area (which revalues them) in the same run.
          const enriched=input.enrichPluto!==false?{flood:await mStore.backfillFloodZones(),mih:await mStore.assignMihAreas(),hpdRegistrations:await mStore.backfillHpdRegistrations(),rentStabilized:await mStore.backfillRentStabilizedUnits().catch(e=>({error:e.message})),frontStreets:await mStore.backfillFrontStreets().catch(e=>({error:e.message})),lotPolygons:await mStore.backfillLotPolygons().catch(e=>({error:e.message}))}:{};
          return respond(res,200,{...summary,...enriched,storeStatus:mStore.statusSummary()});
        }
        if(parts.length===3&&parts[2]==='revalue'&&req.method==='POST') {
          const input=await body(req);
          let pluto={matched:0,scanned:0};
          if(input.enrichPluto!==false) {
            // A re-match also retries listings no earlier run could place, by address.
            pluto=await mStore.enrichNycListingsWithPluto({limit:Number(input.limit)||1000,geosearchFetcher:defaultGeosearchBbl,retryUnmatched:true});
            await mStore.backfillFloodZones();
            await mStore.assignMihAreas();
            await mStore.backfillHpdRegistrations();
            await mStore.backfillRentStabilizedUnits().catch(()=>null);
            await mStore.backfillFrontStreets().catch(()=>null);
            await mStore.backfillLotPolygons().catch(()=>null);
          }
          const revalued=mStore.revalueDealsWithSettings(input.dealSettings||null,input.borough||null);
          return respond(res,200,{plutoMatched:pluto.matched,plutoScanned:pluto.scanned,revaluedCount:revalued.revalued,storeStatus:mStore.statusSummary()});
        }
        return respond(res,404,{error:'Not found.'});
      } finally {
        mStore.close?.();
      }
    }
    // Trade-press stories about a lot or its block, for the site page and the report.
    if(parts[0]==='news'&&parts[1]==='lots'&&parts.length===3&&req.method==='GET') {
      if(!/^[1-5]\d{9}$/.test(parts[2]))return respond(res,400,{error:'A 10-digit BBL is required.'});
      const mStore=marketStoreFactory();
      if(!mStore)return respond(res,503,{error:'Market store is unavailable.'});
      try {
        return respond(res,200,{bbl:parts[2],stories:mStore.newsForLot(parts[2])});
      } finally {
        mStore.close?.();
      }
    }
    // Market Store (HomeHarvest + NYC PLUTO FAR deal & comp store): internal-only, so non-admins see
    // nothing while ACRES_DEAL_STORE_ENABLED is off and only admins can sync.
    if(parts[0]==='market-store') {
      const access=dealStoreAccess(isMarketAdmin(email));
      if(!access.read)return respond(res,404,{error:'Not found.'});
      const mStore=marketStoreFactory();
      if(!mStore)return respond(res,503,{error:'Market store is unavailable.'});
      try {
        if(parts.length===2&&parts[1]==='status'&&req.method==='GET') {
          return respond(res,200,mStore.statusSummary());
        }
        if(parts.length===2&&parts[1]==='user-settings'&&req.method==='GET') {
          return respond(res,200,{...mStore.getUserDealSettings(account),budgetSplitOptions:budgetSplitOptions()});
        }
        if(parts.length===2&&parts[1]==='user-settings'&&(req.method==='PUT'||req.method==='POST')) {
          const input=await body(req);
          // budgetSplits alone saves the budget line shares and leaves the costs as they are.
          const budgetSplits=input.budgetSplits===undefined||input.budgetSplits===null?input.budgetSplits:normalizeBudgetSplits(input.budgetSplits);
          const updated=budgetSplits!==undefined&&!input.dealSettings&&!input.reset
            ?mStore.updateUserBudgetSplits(account,budgetSplits,{updatedBy:email})
            :mStore.updateUserDealSettings(
              account,
              input.dealSettings&&typeof input.dealSettings==='object'?input.dealSettings:input,
              {reset:Boolean(input.reset),updatedBy:email,budgetSplits}
            );
          return respond(res,200,{...updated,budgetSplitOptions:budgetSplitOptions()});
        }
        // The account's named listing searches: list, save, rename and delete.
        if(parts[1]==='saved-searches') {
          if(parts.length===2&&req.method==='GET')return respond(res,200,{searches:mStore.listSavedSearches(account)});
          if(parts.length===2&&req.method==='POST') {const input=await body(req);return respond(res,201,mStore.createSavedSearch(account,{name:input.name,search:input.search}));}
          if(parts.length===3&&req.method==='PATCH') {const input=await body(req);return respond(res,200,mStore.renameSavedSearch(account,parts[2],input.name));}
          if(parts.length===3&&req.method==='DELETE') {mStore.deleteSavedSearch(account,parts[2]);return respond(res,200,{deleted:true});}
          return respond(res,404,{error:'Not found.'});
        }
        // GET deals (a ranked page of cards), deals/pins (every match located on the map) and deals/:id (one listing with comps).
        if(parts[1]==='deals'&&parts.length>=2&&parts.length<=3&&req.method==='GET') {
          const sp=url.searchParams;
          const num=key=>sp.get(key)?Number(sp.get(key)):null;
          const userSettings=mStore.getUserDealSettings(account);
          const mergedCustom=userSettings.isCustom?{...userSettings.dealSettings}:{};
          for(const key of ['hardCostPerGrossSqft','rentalHardCostPerGrossSqft','condoHardCostPerGrossSqft','softCostPctOfHard','carryAndFinancingPct','zfaToGrossFactor'])if(sp.get(key))mergedCustom[key]=Number(sp.get(key));
          const hasCustom=Object.keys(mergedCustom).length>0;
          const bounds=sp.get('bounds')?Object.fromEntries(['south','west','north','east'].map((k,i)=>[k,Number(sp.get('bounds').split(',')[i])])):null;
          const filters={
            borough:sp.get('borough')||null,
            zipCode:sp.get('zipCode')||null,
            area:sp.get('area')||null,
            zoningPrefix:sp.get('zoningPrefix')||null,
            listingType:sp.get('listingType')||'for_sale',
            minUnusedZfa:sp.get('minUnusedZfa')!=null?Number(sp.get('minUnusedZfa')):500,
            minHeadroomFar:num('minHeadroomFar'),
            maxPricePerBuildableZfa:num('maxPricePerBuildableZfa'),
            maxPricePerBuildableAnyUse:num('maxPricePerBuildableAnyUse'),
            minListPrice:num('minListPrice'),
            maxListPrice:num('maxListPrice'),
            minLotArea:num('minLotArea'),
            maxLotArea:num('maxLotArea'),
            minBuildableZfa:num('minBuildableZfa'),
            minLotFront:num('minLotFront'),
            maxLotFront:num('maxLotFront'),
            minLotDepth:num('minLotDepth'),
            maxLotDepth:num('maxLotDepth'),
            minProjectCost:num('minProjectCost'),
            maxProjectCost:num('maxProjectCost'),
            styles:sp.get('styles')||null,
            dealVerdict:sp.get('dealVerdict')||null,
            bounds,
            excludeLandmarks:sp.get('excludeLandmarks')==='true',
            excludeHighStabilizedRisk:sp.get('excludeHighStabilizedRisk')==='true',
            mihArea:sp.get('mihArea')||null,
            sortBy:sp.get('sortBy')||'uap_price_per_buildable_zfa',
            customSettings:hasCustom?mergedCustom:null,
          };
          if(parts[2]==='pins')return respond(res,200,mStore.searchDealsPage({...filters,pins:true}));
          if(parts.length===3) {
            const page=mStore.searchDealsPage({listingId:parts[2],includeSimilarComps:true,customSettings:filters.customSettings});
            if(!page.deals.length)return respond(res,404,{error:'Listing not found.'});
            const deal=page.deals[0];
            // The listing kept as it stands, read instantly from the store's own figures; a failure leaves the page as it was.
            let keep=null;
            try{keep=quickKeep(mStore.listingKeepInputs(parts[2]));}catch(error){console.log(JSON.stringify({event:'listing_keep_read_failed',listing:parts[2],error:String(error?.message||error).slice(0,200)}));}
            return respond(res,200,{deal:{...deal,keep,nearbyPipeline:pagePipeline({latitude:deal.latitude,longitude:deal.longitude,zip:deal.zipCode,bbl:deal.bbl})},userSettings});
          }
          const page=mStore.searchDealsPage({
            ...filters,
            includeSimilarComps:sp.get('includeSimilarComps')!=='false',
            limit:sp.get('limit')?Number(sp.get('limit')):25,
            offset:sp.get('offset')?Number(sp.get('offset')):0,
          });
          return respond(res,200,{...page,userSettings,storeStatus:mStore.statusSummary()});
        }
        return respond(res,404,{error:'Not found.'});
      } finally {
        mStore.close?.();
      }
    }
    // People
    if(parts[0]==='people') {
      if(parts.length===1&&req.method==='GET')return respond(res,200,{people:store.searchPeople((url.searchParams.get('q')||'').slice(0,200))});
      if(parts.length===2&&parts[1]==='me'&&req.method==='POST') {
        const input=await body(req);
        const myEmail=email||(input&&typeof input==='object'&&input.email?validEmail(input.email):undefined);
        if(input&&typeof input==='object'&&'name' in input) {
          if(input.name!==null&&typeof input.name!=='string')fail(400,'Name must be 1 to 80 characters.');
          if(typeof input.name==='string'&&input.name.trim().length>80)fail(400,'Name must be 1 to 80 characters.');
          return respond(res,200,store.setMyName(account,myEmail,input.name));
        }
        return respond(res,200,store.setMyName(account,myEmail,undefined));
      }
      return respond(res,404,{error:'Not found.'});
    }
    // Share-link claim
    if(parts[0]==='shared') {
      if(parts.length===2&&req.method==='GET') {
        const claimed=store.claimLink(account,parts[1]);
        return respond(res,claimed?200:404,claimed||{error:'Share link not found.'});
      }
      return respond(res,404,{error:'Not found.'});
    }
    // Teams
    if(parts[0]==='teams') {
      if(parts.length===1) {
        if(req.method==='GET')return respond(res,200,{teams:store.listTeams(account)});
        if(req.method==='POST') {const input=await body(req);return respond(res,201,store.createTeam(account,validName(input.name)));}
        return respond(res,404,{error:'Not found.'});
      }
      const teamId=parts[1];if(!uuid.test(teamId||''))return respond(res,404,{error:'Not found.'});
      if(parts.length===2) {
        if(req.method==='GET') {const t=store.team(account,teamId);return respond(res,t?200:404,t||{error:'Team not found.'});}
        if(req.method==='PATCH') {const input=await body(req);return respond(res,200,store.renameTeam(account,teamId,validName(input.name)));}
        if(req.method==='DELETE')return respond(res,200,store.archiveTeam(account,teamId));
        return respond(res,404,{error:'Not found.'});
      }
      if(parts.length===3&&parts[2]==='members'&&req.method==='POST') {
        const input=await body(req);
        return respond(res,200,store.addTeamMember(account,teamId,inviteeAccount(input),optionalEmail(input.email)));
      }
      if(parts.length===4&&parts[2]==='members'&&req.method==='DELETE') {
        return respond(res,200,store.removeTeamMember(account,teamId,parts[3]));
      }
      return respond(res,404,{error:'Not found.'});
    }
    // Projects: the shared, site-keyed state that conversations attach to
    if(parts[0]==='projects') {
      if(parts.length===1&&req.method==='GET'){
        const sitesOnly=url.searchParams.get('sitesOnly');
        if(sitesOnly!==null&&sitesOnly!=='true'&&sitesOnly!=='false')return respond(res,400,{error:'sitesOnly must be true or false.'});
        const modelsOnly=url.searchParams.get('modelsOnly');
        if(modelsOnly!==null&&modelsOnly!=='true'&&modelsOnly!=='false')return respond(res,400,{error:'modelsOnly must be true or false.'});
        const legacyModelsOnly=url.searchParams.get('legacyModelsOnly');
        if(legacyModelsOnly!==null&&legacyModelsOnly!=='true'&&legacyModelsOnly!=='false')return respond(res,400,{error:'legacyModelsOnly must be true or false.'});
        const modelingLibrary=url.searchParams.get('modelingLibrary');
        if(modelingLibrary!==null&&modelingLibrary!=='true'&&modelingLibrary!=='false')return respond(res,400,{error:'modelingLibrary must be true or false.'});
        if([sitesOnly,modelsOnly,legacyModelsOnly,modelingLibrary].filter(value=>value==='true').length>1)return respond(res,400,{error:'Choose one workflow.'});
        return respond(res,200,store.projectPage(account,{q:(url.searchParams.get('q')||'').slice(0,200),cursor:url.searchParams.get('cursor'),sitesOnly:sitesOnly==='true',modelsOnly:modelsOnly==='true',legacyModelsOnly:legacyModelsOnly==='true',modelingLibrary:modelingLibrary==='true'}));
      }
      if(parts.length===1&&req.method==='POST'){
        if(!architecture||!rolloutAdmits(account))return respond(res,404,{error:'Modeling is not available for this account.'});
        const input=await body(req);
        if(input.workflow!=='modeling'||typeof input.address!=='string'||!input.address.trim()||input.address.trim().length>200)return respond(res,400,{error:'Enter the property address using 1 to 200 characters.'});
        if(input.title!==undefined&&(typeof input.title!=='string'||!input.title.trim()||input.title.trim().length>200))return respond(res,400,{error:'Name the modeling project using 1 to 200 characters.'});
        if(input.bbl!==undefined&&input.bbl!==null&&!/^\d{10}$/.test(input.bbl))return respond(res,400,{error:'Choose the property address from the New York City suggestions so the model links to its parcel.'});
        return respond(res,201,store.createModel(account,input.address.trim(),input.title?.trim()||input.address.trim(),input.bbl||null));
      }
      const id=parts[1];if(!uuid.test(id||''))return respond(res,404,{error:'Not found.'});
      if(parts[2]==='name'&&parts.length===3&&req.method==='PATCH') {
        const input=await body(req);
        let project;
        try {project=store.renameModel(account,id,{version:input.version,title:input.title});}
        catch(e) {if(e.status===409)return respond(res,409,{error:e.message,version:e.version});throw e;}
        res.setHeader('etag',`"${project.version}"`);return respond(res,200,project);
      }
      if(parts[2]==='state'&&parts.length===3&&req.method==='GET') {
        const project=store.projectView(account,id);if(!project)return respond(res,404,{error:'Project not found.'});
        res.setHeader('etag',`"${project.version}"`);return respond(res,200,project);
      }
      if(parts[2]==='state'&&parts.length===3&&req.method==='PATCH') {
        const input=await body(req);
        let project;
        try {project=store.updateProjectState(account,id,{version:input.version,fields:input.fields});}
        catch(e) {if(e.status===409)return respond(res,409,{error:e.message,version:e.version});throw e;}
        res.setHeader('etag',`"${project.version}"`);return respond(res,200,project);
      }
      if(parts[2]==='architecture')return await architectureRoute(req,res,account,id,parts.slice(3));
      // Three ways to build the site, priced by the deal valuation at the owner's deal settings.
      if(parts[2]==='schemes'&&parts.length===3&&req.method==='GET') {
        const project=store.projectView(account,id);if(!project)return respond(res,404,{error:'Project not found.'});
        const property=project.fields.property.value;
        // Each option's latest send to an architect or contractor, and whether this reader may send one.
        const withSends=view=>({...view,sends:store.optionSends(account,id)});
        if(!property?.bbl)return respond(res,200,withSends(store.schemesView(id)));
        if(!dealStoreAccess(isMarketAdmin(email)).read)return respond(res,404,{error:'Not found.'});
        const mStore=marketStoreFactory();if(!mStore)return respond(res,503,{error:'Market store is unavailable.'});
        let lot,budgetSplits;
        try {lot=mStore.lotValuation({bbl:property.bbl,property,account:project.owner.account,landPrice:project.fields.assumptions.value?.landPrice});budgetSplits=mStore.getUserDealSettings(project.owner.account).budgetSplits;}
        finally {mStore.close?.();}
        return respond(res,200,withSends(lot?fillSchemeBudgets(store,id,store.refreshSchemes(id,lot),budgetSplits):store.schemesView(id)));
      }
      // Send one option to an architect or contractor (a link to a copy of it), or withdraw every link to it.
      if(parts[2]==='schemes'&&parts[4]==='send'&&parts.length===5&&req.method==='POST') {
        return respond(res,201,store.createOptionLink(account,id,parts[3]));
      }
      if(parts[2]==='schemes'&&parts[4]==='send'&&parts.length===5&&req.method==='DELETE') {
        return respond(res,200,store.withdrawOptionLinks(account,id,parts[3]));
      }
      // Render one scheme: queues its presentation render (street and aerial stills) and returns its render part.
      if(parts[2]==='schemes'&&parts[4]==='render'&&parts.length===5&&req.method==='POST') {
        if(!architectureJobs?.worker)return respond(res,503,{error:'Rendering is not available.'});
        return respond(res,202,await requestSchemeRender({store,jobs:architectureJobs,loadContext:renderContext.load},account,id,parts[3]));
      }
      if(parts[2]==='events'&&parts.length===3&&req.method==='GET') {
        if(!store.canReadProject(account,id))return respond(res,404,{error:'Project not found.'});
        const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid event cursor.');
        streamEvents({res,after,readPage:(cursor,limit)=>store.projectEventPage(id,cursor,limit),
          allowed:()=>store.canReadProject(account,id),
          subscribe:listener=>{store.projectFeed.on(id,listener);return ()=>store.projectFeed.off(id,listener);}});
        return;
      }
      return respond(res,404,{error:'Not found.'});
    }
    // Conversations and their subresources
    if(parts[0]==='conversations') {
      const id=parts[1];if(!uuid.test(id||''))return respond(res,404,{error:'Not found.'});
      if(parts.length===2&&req.method==='GET') {
        const conversation=store.conversation(account,id);return respond(res,conversation?200:404,conversation||{error:'Conversation not found.'});
      }
      if(parts.length===2&&req.method==='DELETE') {
        if(url.searchParams.has('empty')&&url.searchParams.get('empty')!=='1')return respond(res,400,{error:'Use empty=1 to discard only an empty conversation.'});
        store.deleteConversation(account,id,{onlyEmpty:url.searchParams.get('empty')==='1'});return respond(res,200,{deleted:true,id});
      }
      if(parts[2]==='deck'&&parts.length===3&&req.method==='GET') {
        const conversation=store.conversation(account,id);
        if(!conversation)return respond(res,404,{error:'Conversation not found.'});
        const allSources=(conversation.messages||[]).flatMap(m=>m.sources||[]);
        const projectState=store.projectState(account,id);
        const deck=buildUnderwritingDeck({
          projectState,
          title:conversation.title?`${conversation.title}: Underwriting Package`:null,
          researchSummary:selectReportSummary(conversation.messages,projectState,conversation.projectId),
          sources:allSources,
        });
        const wantsHtml=url.searchParams.get('format')==='html'||String(req.headers.accept||'').includes('text/html');
        if(wantsHtml) {
          res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
          res.end(renderDeckHtml(deck));
          return;
        }
        return respond(res,200,deck);
      }
      if(parts[2]==='runs'&&parts.length===3&&req.method==='POST') {
        if(typeof store.access==='function'&&!store.access(account,id))return respond(res,404,{error:'Conversation not found.'});
        const input=await body(req);if(input.id&&!uuid.test(input.id))throw new Error('Invalid request ID.');
        // A retried request that already exists is not a new run.
        if(!(input.id&&store.one('SELECT 1 FROM runs WHERE id=?',input.id)))plans.assertCanRun(account,planEmail());
        return respond(res,202,manager.enqueue(account,id,message(input.message),input.id,input.listingFilters));
      }
      if(parts[2]==='members') {
        if(parts.length===3&&req.method==='GET') {
          store.requireAccess(account,id,'owner');
          return respond(res,200,{members:store.listGrants(id)});
        }
        if(parts.length===3&&req.method==='POST') {
          const input=await body(req),role=validRole(input.role);
          let member;
          if(input.teamId||input.team||input.principalType==='team') {
            const principal=input.teamId||input.team||input.principal;
            if(typeof principal!=='string'||!principal)fail(400,'A team is required.');
            member=store.grantMember(account,id,'team',principal,role);
          } else {
            const principal=inviteeAccount(input);
            member=store.grantMember(account,id,'account',principal,role,optionalEmail(input.email));
          }
          return respond(res,200,{member,members:store.listGrants(id)});
        }
        if(parts.length===5&&req.method==='PATCH') {
          const principalType=parts[3],principal=parts[4];
          if(!['account','team'].includes(principalType))return respond(res,404,{error:'Not found.'});
          const input=await body(req);
          const member=store.setGrantRole(account,id,principalType,principal,validRole(input.role));
          return respond(res,200,{member,members:store.listGrants(id)});
        }
        if(parts.length===5&&req.method==='DELETE') {
          const principalType=parts[3],principal=parts[4];
          if(!['account','team'].includes(principalType))return respond(res,404,{error:'Not found.'});
          store.removeGrant(account,id,principalType,principal);
          return respond(res,200,{removed:true,members:store.listGrants(id)});
        }
        return respond(res,404,{error:'Not found.'});
      }
      if(parts[2]==='links') {
        if(parts.length===3&&req.method==='POST') {
          const input=await body(req);
          return respond(res,201,store.createLink(account,id,expiresAt(input)));
        }
        if(parts.length===3&&req.method==='GET')return respond(res,200,{links:store.listLinks(account,id)});
        if(parts.length===4&&req.method==='DELETE') {
          store.revokeLink(account,id,parts[3]);return respond(res,200,{revoked:true});
        }
        return respond(res,404,{error:'Not found.'});
      }
      return respond(res,404,{error:'Not found.'});
    }
    // Runs
    if(parts[0]==='runs') {
      if(parts.length===1&&req.method==='GET')return respond(res,200,{runs:store.activeSiteRuns(account)});
      const id=parts[1];if(!uuid.test(id||''))return respond(res,404,{error:'Not found.'});
      if(parts[2]==='status'&&parts.length===3&&req.method==='GET'){const status=store.runStatus(account,id);return respond(res,status?200:404,status||{error:'Request not found.'});}
      const run=parts.length===2?store.run(account,id):store.runStatus(account,id);if(!run)return respond(res,404,{error:'Request not found.'});
      if(parts.length===2&&req.method==='GET')return respond(res,200,{...run,events:store.events(account,id)});
      if(['steer','interrupt'].includes(parts[2])&&parts.length===3&&req.method==='POST') {
        const input=await body(req);
        const result=await manager.control(account,id,parts[2],parts[2]==='steer'?message(input.message):null);
        return respond(res,result?200:404,result||{error:'Request not found.'});
      }
      if(parts[2]==='events'&&parts.length===3&&req.method==='GET') {
        const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid event cursor.');
        streamEvents({res,after,readPage:(cursor,limit)=>store.runEventPage(id,cursor,limit),
          allowed:()=>Boolean(store.access(account,run.conversation)),
          finished:()=>!['queued','running'].includes(store.runStatus(account,id)?.status),
          terminal:event=>/^run\.(completed|failed|interrupted)$/.test(event.event),
          subscribe:listener=>{manager.on(id,listener);return ()=>manager.off(id,listener);},
          onClose:cursor=>store.event(id,'delivery.closed',{cursor})});
        return;
      }
    }
    return respond(res,404,{error:'Not found.'});
  } catch(e) {
    trace?.emit('run.failed',{message:e.message});
    console.error(JSON.stringify({event:'request_failed',traceId:trace?.id,path:url.pathname,message:e.message.slice(0,250)}));
    if(!res.headersSent)respond(res,e.status || (trace?502:400),{error:e.message,...(e.code?{code:e.code}:{}),traceId:trace?.id});else res.end();
  }
}
server.architectureJobs=architectureJobs;server.schemeDrafts=schemeDrafts;
server.activeRuns=()=>manager.active.size;
server.alertStore=alertStore;
server.on('close',()=>{if(!draining){architectureJobs?.close();void investigations.close();void enrichment.close();}});
const within=async(promise,ms)=>{let timer;try{return await Promise.race([promise.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}};
// hurry() (SIGINT, the urgent deploy) ends a drain's wait for active work at once.
let hurry;const hurried=new Promise(resolve=>{hurry=()=>resolve(false);});
server.hurry=()=>hurry();
// Drain: start no new runs or jobs (they stay queued for the next process) but keep serving every
// request while the active ones finish on their own deadline. Then stop listening, so new
// connections wait in the systemd socket's backlog for the next process, finish the requests
// already received (each response closes its connection), and close the event feeds, whose
// clients reconnect from their last event.
server.drain=({graceMs=1290000,cleanupMs=15000,requestMs=30000}={})=>drainPromise??=(async()=>{
  draining=true;manager.stopAdmission();architectureJobs?.stopAdmission();
  const drainStarted=Date.now(),investigationShutdown=investigations.close(),enrichmentShutdown=enrichment.close();
  const inFlight=[...requests.keys()];
  const settled=async()=>{await Promise.allSettled([manager.settled(),architectureJobs?.settled(),investigationShutdown,enrichmentShutdown,...inFlight]);await Promise.allSettled([...background]);};
  const stopRequests=()=>{for(const controller of requests.values())controller.abort(new Error('Service is stopping.'));};
  if(!await Promise.race([within(settled(),graceMs),hurried])){
    stopRequests();void manager.cancelActive();architectureJobs?.cancelActive();
    if(!await within(settled(),cleanupMs))throw new Error('Shutdown cleanup exceeded its deadline.');
  }
  // A keep-alive connection left idle from before the drain closes from the client's side once its
  // keep-alive timeout passes; closing it here first could race a request the client is sending.
  const linger=Math.min(drainStarted+server.keepAliveTimeout+1000-Date.now(),graceMs);
  if(linger>0)await new Promise(resolve=>setTimeout(resolve,linger));
  // net.Server's close stops listening without http.Server's sweep of idle connections, which would
  // reset a connection accepted a moment ago whose request is still on its way.
  const closed=new Promise(resolve=>net.Server.prototype.close.call(server,resolve));
  const served=async()=>{
    await Promise.allSettled([...requests.keys(),...background]);
    while(fresh.size||requests.size)await new Promise(resolve=>setTimeout(resolve,50));
  };
  if(!await within(served(),Math.min(requestMs,graceMs))){stopRequests();await within(served(),cleanupMs);}
  // Close feeds while their stores are still open so cursors can be persisted.
  for(const res of responses)res.destroy();
  server.closeAllConnections();await closed;
  architectureJobs?.close();await closeCodexPool();
})();
return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const secrets=JSON.parse(readFileSync(process.env.ACRES_SECRETS_JSON||'/etc/acres-research/secrets.json','utf8'));
  const evidence=secrets.MCP_SERVICE_TOKEN?new EvidenceStore(process.env.ACRES_MCP_EVIDENCE_DB||'/home/openclaw/.openclaw/acres-state/mcp-evidence.sqlite'):null;
  const sessions=new SessionStore('/home/openclaw/.openclaw/acres-state/composio.sqlite',secrets);
  const store=new ChatStore('/home/openclaw/.openclaw/acres-state/chat.sqlite');
  const mcp=evidence?createMcpDomain({evidence,releasedSourceIds:secrets.MCP_RELEASED_SOURCE_IDS||[],searchWeb:secrets.MCP_ENABLE_EXA_SEARCH===true?createExaSearch(secrets,sessions):null,
    readState:(account,projectId)=>store.projectView(account,projectId),listProjects:(account,args)=>store.projectPage(account,args),
    writeState:(account,projectId,{version,assumptions})=>store.updateProjectState(account,projectId,{version,fields:{assumptions}})}):null;
  const releaseFile=new URL('./.deployed-commit',import.meta.url);
  const server=createResearchServer({secrets,store,mcp,sessions,architecture:architectureOptions(secrets),
    release:existsSync(releaseFile)?readFileSync(releaseFile,'utf8').trim():null});
  const alertSweeper=startAlertSweeper({store,alerts:server.alertStore,mailer:mailerFromSecrets(secrets),
    openMarket:async()=>openMarketStore({readOnly:true}),appUrl:process.env.ALERTS_APP_URL||'https://build.witharosa.ai'});
  // Under systemd the listener belongs to acres-research.socket and arrives as fd 3, so connections
  // made while one process hands over to the next wait in its backlog instead of being refused.
  const activated=process.env.LISTEN_FDS==='1'&&process.env.LISTEN_PID===String(process.pid);
  for(const name of ['LISTEN_FDS','LISTEN_PID','LISTEN_FDNAMES'])delete process.env[name];
  server.listen(activated?{fd:3}:{port:18800,host:'10.42.0.2'});
  if(dealStoreEnabled()) {
    const warm=()=>{try{warmDealValuations();}catch(error){console.error(JSON.stringify({event:'deal_warm_failed',message:error.message}));}};
    // Each warm is a cache hit unless the store or the day changed, so a short interval keeps a sync's
    // first recomputation out of the request path.
    setTimeout(warm,1000).unref();setInterval(warm,120000).unref();
  }
  let stopping=false;
  // SIGTERM drains; SIGINT (the urgent deploy) drains without waiting for active work, also when
  // it arrives during a drain.
  const stop=async signal=>{
    if(signal==='SIGINT')server.hurry();
    if(stopping)return;stopping=true;alertSweeper.stop();
    setTimeout(()=>process.exit(1),895000);
    // Exit as soon as the stores are closed: the next process starts only after this one exits,
    // so a leftover timer or idle keep-alive socket would otherwise delay the handover.
    try{await server.drain();evidence?.close();sessions.close();store.close();process.exit(0);}
    catch(error){console.error(JSON.stringify({event:'shutdown_failed',message:error.message}));process.exit(1);}
  };
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
