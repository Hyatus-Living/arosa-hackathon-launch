import {createParcelOperations,parcelDataset} from './parcels.mjs';
import {pilotLimits} from './mcp-store.mjs';
import {openKnowledge} from './knowledge.mjs';
import {providerJson,PublicToolError} from './public-http.mjs';
import {throwIfCancelled} from './execution-context.mjs';
import {composioHeaders,root} from './composio.mjs';
import {CAPABILITIES,capability} from './capabilities.mjs';

// The gateway enforces these scopes; here they select the admission counter.
export const toolScopes={get_account:'acres:read',resolve_property:'acres:read',get_property:'acres:read',find_nearby_properties:'acres:read',search:'acres:read',fetch:'acres:read',
  list_projects:'acres:state:read',get_project_state:'acres:state:read',set_project_assumptions:'acres:state:write',list_memberships:'acres:admin'};
export const publicToolNames=Object.keys(toolScopes);
const counters={'acres:read':'tool','acres:state:read':'state','acres:state:write':'state','acres:admin':'admin'};
// Coverage is whatever jurisdictions the capability registry names; parcel
// tools state the jurisdiction of the registry tool that backs them.
const jurisdictionCodes=text=>String(text).match(/\bUS-[A-Z]{2}(?:-[A-Z]+)?\b/g)||[];
export const coverageJurisdictions=()=>[...new Set(CAPABILITIES.flatMap(entry=>jurisdictionCodes(entry.jurisdiction)))].sort();
const jurisdictionOf=name=>{const code=jurisdictionCodes(capability(name).jurisdiction)[0];if(!code)throw new Error(`${name} has no registry jurisdiction.`);return code;};
const parcelJurisdiction=jurisdictionOf('acres_find_property'),nearbyJurisdiction=jurisdictionOf('acres_nearby_properties');
const coverageFor=jurisdiction=>({jurisdiction,notes:['NYC only. Reported parcel data is not a legal entitlement calculation.']});
const bblPattern=/^[1-5]\d{9}$/,projectIdPattern=/^[A-Za-z0-9_-]{1,64}$/;
const requiredString=(value,max)=>typeof value==='string'&&!!value.trim()&&value.length<=max;
const invalid=()=>{throw new PublicToolError('INVALID_INPUT','Use the documented NYC tool inputs; account and workspace arguments are not accepted.',400);};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const money=value=>Number.isFinite(value)&&value>=0&&value<=1e11,rate=value=>Number.isFinite(value)&&value>=0&&value<=1,months=value=>Number.isInteger(value)&&value>=1&&value<=600;
const assumptionShape={landPrice:money,hardCostPerSqft:money,softCostPerSqft:money,capRate:rate,sellingCostRate:rate,
  financing:{loanToCost:rate,interestRate:rate,termMonths:months},
  operating:{residentialVacancyRate:rate,residentialOpexPerUnitPerYear:money,commercialVacancyRate:rate,commercialOpexPerSqftPerYear:money}};
const validShape=(value,shape)=>plain(value)&&Object.keys(value).length>0&&Object.entries(value).every(([key,item])=>Object.hasOwn(shape,key)&&(typeof shape[key]==='function'?shape[key](item):validShape(item,shape[key])));
const notImplemented=message=>{throw new PublicToolError('NOT_IMPLEMENTED',message,501);};
const projectNotFound=()=>{throw new PublicToolError('PROJECT_NOT_FOUND','This project is unavailable for this account.',404);};
const iso=value=>new Date(value).toISOString();
// A project view lists every graph key; only fields a run or user has produced are returned.
const stateView=view=>({projectId:view.id,version:view.version,fields:Object.fromEntries(Object.entries(view.fields).filter(([,field])=>field.updated!=null).map(([key,field])=>[key,{value:field.value,provenance:field.provenance,stale:field.stale??null,updated:iso(field.updated)}]))});
// The project store signals refusals with an HTTP status; map them to public codes.
const storeRefusal=error=>{
  if(error.status===404)return new PublicToolError('PROJECT_NOT_FOUND','This project is unavailable for this account.',404);
  if(error.status===403)return new PublicToolError('PROJECT_READ_ONLY','This account can read but not change this project.',403);
  if(error.status===409)return new PublicToolError('VERSION_CONFLICT','The project changed since it was read. Read it again and reapply the assumptions.',409);
  if(error.status===400)return new PublicToolError('INVALID_INPUT',error.message,400);
  return error;
};

export function validatePublicInput(tool,args) {
  if(!publicToolNames.includes(tool))throw new PublicToolError('TOOL_NOT_FOUND','This public operation is unavailable.',404);
  const keys={get_account:[],resolve_property:['address','borough'],get_property:['bbl'],find_nearby_properties:['bbl','radiusMeters'],search:['query'],fetch:['id','offset'],
    list_projects:['q','cursor'],get_project_state:['projectId'],set_project_assumptions:['projectId','version','assumptions'],list_memberships:[]}[tool];
  if(!keys)throw new PublicToolError('TOOL_NOT_FOUND','This public operation is unavailable.',404);
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!keys.includes(key)))invalid();
  if(tool==='resolve_property'&&(!requiredString(args.address,300)||(args.borough!==undefined&&!['Manhattan','Brooklyn','Queens','Bronx','Staten Island'].includes(args.borough))))invalid();
  if(tool==='resolve_property'&&args.borough){const suffix=args.address.match(/(?:^|[,\s])(Manhattan|Brooklyn|Queens|Bronx|Staten Island)\s*$/i)?.[1];if(suffix&&suffix.toLowerCase()!==args.borough.toLowerCase())throw new PublicToolError('BOROUGH_CONFLICT','Clarify the NYC borough: the address and selected borough disagree.',400);}
  if(['get_property','find_nearby_properties'].includes(tool)&&(typeof args.bbl!=='string'||!bblPattern.test(args.bbl)))invalid();
  if(tool==='find_nearby_properties'&&args.radiusMeters!==undefined&&(!Number.isFinite(args.radiusMeters)||args.radiusMeters<10||args.radiusMeters>500))invalid();
  if(tool==='search'&&!requiredString(args.query,2000))invalid();
  if(tool==='fetch'&&!/^src_[a-f0-9]{64}$/.test(args.id||''))invalid();
  if(tool==='fetch'&&args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0))invalid();
  if(tool==='list_projects'&&((args.q!==undefined&&(typeof args.q!=='string'||args.q.length>200))||(args.cursor!==undefined&&!requiredString(args.cursor,80))))invalid();
  if(['get_project_state','set_project_assumptions'].includes(tool)&&(typeof args.projectId!=='string'||!projectIdPattern.test(args.projectId)))invalid();
  if(tool==='set_project_assumptions'&&(!Number.isInteger(args.version)||args.version<0||!validShape(args.assumptions,assumptionShape)))invalid();
}

// Only this reviewed operation is available to the MCP pilot. Provider discovery,
// arbitrary tool arguments, Instant, browser actions and custom headers stay private.
export function createExaSearch(secrets,sessions,request=providerJson) {
  const headers=composioHeaders(secrets);
  return async (query,{requestId}={})=>{
    const session=encodeURIComponent(await sessions.forService());
    const result=await request(`${root}/tool_router/session/${session}/execute`,{
      method:'POST',headers:{...headers,...(requestId?{'x-request-id':requestId}:{})},
      body:JSON.stringify({tool_slug:'EXA_SEARCH',arguments:{query:`New York City property, zoning and development research: ${query}`,numResults:5,contents:{text:{maxCharacters:12000}}}}),
    });
    const records=[];
    function collect(value,depth=0) {
      if(depth>5||records.length>=5||!value||typeof value!=='object')return;
      if(typeof value.url==='string') {
        const text=typeof value.text==='string'?value.text:typeof value.snippet==='string'?value.snippet:typeof value.description==='string'?value.description:Array.isArray(value.highlights)?value.highlights.filter(x=>typeof x==='string').join('\n'):null;
        if(text)records.push({title:typeof value.title==='string'?value.title:value.url,url:value.url,text:`Public search extract, not verified complete operative text:\n${text.slice(0,12000)}`,kind:'search_extract',publishedAt:typeof value.publishedDate==='string'?value.publishedDate:null,coverageNote:'Public search is bounded and is not a legal citator or exhaustive case-law corpus.'});
      }
      for(const child of Object.values(value))collect(child,depth+1);
    }
    collect(result.data);return records;
  };
}

// Project state callbacks are injected by the service: readState(accountId, projectId)
// returns the project view ({id, version, fields}) or null, listProjects(accountId, args) the
// visible page ({projects, nextCursor}), and writeState(accountId, projectId, {version, assumptions}) the view
// after a user write, throwing a status error on refusal or a version mismatch.
export function createMcpDomain({evidence,releasedSourceIds=[],openCorpus=openKnowledge,searchWeb=null,request=providerJson,readState=null,listProjects=null,writeState=null}) {
  if(!Array.isArray(releasedSourceIds)||releasedSourceIds.length>100||releasedSourceIds.some(id=>!requiredString(id,200)))throw new Error('Configure up to 100 reviewed public corpus source IDs.');
  let active=0;
  return {async call(tool,args,{accountId,workspaceId,requestId}) {
    throwIfCancelled();
    validatePublicInput(tool,args);
    if(typeof accountId!=='string'||typeof workspaceId!=='string'||!/^[a-f0-9]{24}$/.test(accountId)||!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId))throw new PublicToolError('FORBIDDEN','An authorized Arosa membership is required.',403);
    const owner=`${workspaceId}:${accountId}`;
    evidence.admit(owner,{publicWeb:tool==='search'&&!!searchWeb,kind:counters[toolScopes[tool]]});
    if(tool==='get_account')return {accountId,workspaceId,coverage:coverageJurisdictions(),limits:pilotLimits,sourceSearch:{corpus:releasedSourceIds.length?'configured':'unreleased',publicWeb:searchWeb?'enabled':'disabled'}};
    // The gateway attaches the reviewed membership rows it owns.
    if(tool==='list_memberships')return {workspaceId};
    if(tool==='list_projects') {
      if(!listProjects)notImplemented('Project listing is not available yet.');
      let page;try{page=await listProjects(accountId,args);}catch(error){throw storeRefusal(error);}
      return {projects:page.projects.map(project=>({projectId:project.id,title:String(project.title).slice(0,300),access:project.access??null,version:project.version,updated:iso(project.updated)})),nextCursor:page.nextCursor};
    }
    if(tool==='get_project_state') {
      if(!readState)notImplemented('Project state is not available yet.');
      const view=await readState(accountId,args.projectId);if(!view)projectNotFound();
      return stateView(view);
    }
    if(tool==='set_project_assumptions') {
      if(!writeState)notImplemented('Setting project assumptions is not available yet: the project state service does not accept user fields. Read the state with get_project_state.');
      let view;
      try {throwIfCancelled();view=await writeState(accountId,args.projectId,{version:args.version,assumptions:args.assumptions});}
      catch(error){throw storeRefusal(error);}
      return stateView(view);
    }
    if(tool==='fetch') {
      const source=evidence.fetch(owner,args.id,{offset:args.offset});
      if(!source)throw new PublicToolError('SOURCE_NOT_FOUND','This source is unavailable for this account or its retention period has ended.',404);
      return source;
    }
    if(active>=2)throw new PublicToolError('SERVICE_BUSY','Arosa is handling the pilot request limit. Try again shortly.',503);
    active++;
    try {
      const refs=new Map();
      const record=value=>{throwIfCancelled();const source=evidence.record(owner,value);if(source)refs.set(source.id,{id:source.id,title:source.title,url:source.url});return source;};
      const parcels=createParcelOperations({request,record});
      if(tool==='resolve_property') {
        const result=await parcels.findProperty(args);
        const candidates=(result.candidates||result.rows||[]).map(row=>({bbl:String(Math.trunc(Number(row.bbl))),label:String(row.label||row.address||row.bbl).slice(0,300),borough:String(row.borough||''),address:String(row.address||'').slice(0,300),confidence:typeof row.confidence==='number'?row.confidence:null,version:row.version?String(row.version):null}));
        return {candidates,confirmed:result.confirmed,note:result.note,source:refs.get(result.candidatesSourceId??result.sourceId)||null,coverage:coverageFor(parcelJurisdiction)};
      }
      if(tool==='get_property') {
        const result=await parcels.findProperty(args),parcel=result.rows?.[0]||null;
        return {bbl:args.bbl,parcel,dataset:{name:'NYC Planning PLUTO',version:parcel?.version?String(parcel.version):null,url:parcelDataset},source:refs.get(result.sourceId)||null,coverage:coverageFor(parcelJurisdiction)};
      }
      if(tool==='find_nearby_properties') {
        const result=await parcels.nearby(args);
        return {bbl:args.bbl,radiusMeters:args.radiusMeters??150,records:result.records,method:'centroid_bounding_box',limit:50,truncated:result.truncated,note:result.note,source:refs.get(result.sourceId)||null,coverage:coverageFor(nearbyJurisdiction)};
      }
      const results=new Map(),issues=[];
      let corpusAvailable=false;
      if(releasedSourceIds.length) {
        const store=openCorpus();
        if(store) {
          try {
            const eligible=store.all(`SELECT id FROM sources WHERE active=1 AND current_version IS NOT NULL AND id IN (${releasedSourceIds.map(()=>'?').join(',')})`,...releasedSourceIds);
            corpusAvailable=eligible.length>0;
            const found=await store.search({query:args.query,city:parcelJurisdiction,limit:8,sourceIds:releasedSourceIds,recordRetrieval:false});
            const versions=new Map();
            for(const item of found.results) {
              if(!versions.has(item.versionId))versions.set(item.versionId,store.one('SELECT text,metadata,observed_at FROM versions WHERE id=?',item.versionId));
              const row=versions.get(item.versionId);if(!row)continue;
              const metadata=JSON.parse(row.metadata),source=record({title:item.title||metadata.title,url:item.url||metadata.url,text:row.text,pdfPages:metadata.pdfPages,excerpt:{text:item.text,chunkId:item.chunkId,ordinal:item.ordinal,...(item.pdf?{pdf:item.pdf}:{})},kind:item.kind,jurisdiction:item.jurisdiction,versionId:item.versionId,observedAt:row.observed_at,lastChecked:item.lastChecked,lastAttempted:item.lastAttempted,refreshFailed:item.refreshFailed,stale:item.stale,publishedAt:metadata.publishedAt||null,effectiveFrom:metadata.effectiveFrom||null,effectiveTo:metadata.effectiveTo||null,coverageNote:metadata.coverageNote||'Released snapshot. Unknown effective dates remain unknown; verify applicability and subsequent changes.'});
              if(source)results.set(source.id,refs.get(source.id));
            }
          } catch {throwIfCancelled();issues.push({code:'CORPUS_UNAVAILABLE',message:'The released corpus could not be searched.'});corpusAvailable=false;}
          finally {store.close();}
        }
        if(!corpusAvailable)issues.push({code:'CORPUS_EMPTY',message:'No released source snapshots are currently available.'});
      }else issues.push({code:'CORPUS_UNRELEASED',message:'No public source set has been approved for this pilot.'});
      if(searchWeb) {
        try {for(const item of (await searchWeb(args.query,{requestId})).slice(0,5)){const source=record(item);if(source)results.set(source.id,refs.get(source.id));}}
        catch(error){throwIfCancelled();issues.push({code:error instanceof PublicToolError?error.code:'PROVIDER_UNAVAILABLE',message:error instanceof PublicToolError?error.message:'Public research search is unavailable.'});}
      }else issues.push({code:'PUBLIC_SEARCH_DISABLED',message:'Public web search is disabled for this pilot.'});
      return {results:[...results.values()].slice(0,10),coverage:{jurisdiction:parcelJurisdiction,corpus:{releasedSourceCount:releasedSourceIds.length,available:corpusAvailable,mode:'lexical'},publicWeb:{enabled:!!searchWeb},exhaustive:false},issues};
    } finally {active--;}
  }};
}
