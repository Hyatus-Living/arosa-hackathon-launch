import {createParcelOperations,buildParcelDiagnostics} from './parcels.mjs';
import {abortable,executionSignal,withExecutionSignal,combinedSignal,requestSignal,throwIfCancelled,stoppedError} from './execution-context.mjs';
import {publicUrl} from './public-url.mjs';
import {composioHeaders,root,exaTools as pinnedExaTools} from './composio.mjs';
import {fanoutSearch,serperProvider,exaProvider,deepseekProvider,localProvider} from './fanout.mjs';
import {createUrlFetcher} from './fetch-url.mjs';
import {requestedPdfPage,selectPdfPage,isPdfUrl} from './pdf-pages.mjs';
import {openKnowledge} from './knowledge.mjs';
import {embeddingProvider,jevRouterProvider} from './knowledge-providers.mjs';
import {resolveSearchJurisdiction,inferQueryJurisdiction} from './jurisdiction.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export {publicUrl} from './public-url.mjs';
const exaTools = new Set(pinnedExaTools);
export const skillPath = new URL('./skills/creative-zoning/SKILL.md', import.meta.url);

function resolveKnowledgeEmbedder(secrets, configPath=process.env.ACRES_KNOWLEDGE_CONFIG||'/etc/acres-research/knowledge.json') {
  try {
    const fileCfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    return embeddingProvider({...fileCfg, ...secrets});
  } catch { return null; }
}

function resolveJevRouter(secrets, configPath=process.env.ACRES_KNOWLEDGE_CONFIG||'/etc/acres-research/knowledge.json') {
  try {
    const fileCfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    return jevRouterProvider({...fileCfg, ...secrets});
  } catch { return null; }
}

async function json(url, options = {}) {
  const r = await fetch(url, {...options, signal:requestSignal(45000)});
  const p = await r.json();
  if (!r.ok || p.error || p.result_type === 'failed') {
    const detail = typeof p.error === 'string' ? p.error : p.error?.message;
    const error = new Error(r.status === 402 ? 'This research provider has no remaining credits. Use another available tool.' : detail || `Research provider returned HTTP ${r.status}`);
    error.providerResult = p; throw error;
  }
  return p;
}

function definition(name, description, properties, required) {
  return {name, description, inputSchema:{type:'object', properties, required, additionalProperties:false}};
}

const shortHash = text => createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);

// One run-wide budget split by purpose, so broad fetching cannot starve the
// records that ground the answer, sizing and design never trade off against
// either, and a small reserve is held back for the deliverable check's fill
// turn (research.mjs unlocks it). The sum, 36, caps the budget-charged calls.
// Saved-knowledge search and reads are fetch calls. Not charged: a fetch served
// from cached saved-knowledge text, a free re-read (below), capability search,
// skill loads, generated interface and the subject brief.
export const BUDGET = Object.freeze({fetch: 12, specialist: 9, compute: 12, reserve: 3});
// A re-read of a page already fetched in the run (another find, offset or #fragment
// of the same URL) costs no fetch budget, up to this many successful re-reads per
// run and only while fetch budget remains. A re-read that fails keeps its slot.
export const FREE_REREADS = 4;
const FETCH_TOOLS = new Set(['acres_find_floor_plan','acres_attach_drawing','acres_fetch_url','acres_fanout_search','acres_search_knowledge','acres_get_knowledge_source','acres_search_source_registry','acres_refresh_knowledge','acres_discover_tools','acres_execute_tool']);
// The compute cap is derived from the capability registry's cost tags: 'compute'
// tools are in-process arithmetic over evidence already in hand (no network,
// subprocess or provider charge), and 'engine' tools draw a design concept:
// massing, test-fit floor plans (the planning engine can run up to 120 s) or a
// queued Blender walkthrough render.
// Every other specialist tool, including site assembly and plan saves, is
// charged to records. Budget steers name only the compute tools the registry
// marks with `sizes`, the ones that size a development option.
const registryTools = CAPABILITIES.filter(c => c.kind === 'tool');
export {COMPUTE_TOOL_NAMES};
export const SIZING_TOOL_NAMES = new Set(registryTools.filter(c => c.cost === 'compute' && c.sizes).map(c => c.name));
const BUDGET_LABELS = Object.freeze({fetch: 'fetch and search', specialist: 'records', compute: 'compute'});
export const budgetCategory = name => FETCH_TOOLS.has(name) ? 'fetch' : COMPUTE_TOOL_NAMES.has(name) ? 'compute' : 'specialist';

function tabularRecords(value, path = '', depth = 0, found = []) {
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sources' || key === 'budget') continue;
    if (Array.isArray(child)) {
      if (child.length && child.every(row => row && typeof row === 'object' && !Array.isArray(row))) found.push({table: `${path}${key}`, rows: child});
    } else if (child && typeof child === 'object' && depth < 2) tabularRecords(child, `${path}${key}.`, depth + 1, found);
  }
  return found;
}

// Generalises the nycdb proseReportingMandate: any records or specialist result
// that carries tables must be reported or explicitly dismissed in the answer.
export function reportingMandate(name, result) {
  if (budgetCategory(name) === 'fetch' || !result || typeof result !== 'object' || result.proseReportingMandate) return null;
  const tables = tabularRecords(result);
  if (!tables.length) return null;
  return `This ${name} result contains tabular records: ${tables.slice(0, 6).map(t => `${t.table} (${t.rows.length})`).join(', ')}. In the answer, report the records that bear on the question with their figures and source IDs, or explicitly dismiss them with the reason; never retrieve records and leave them unmentioned.`;
}

// Record identifiers and figures a reader could quote from one row: compact
// codes with at least three digits (job numbers, CRFNs, dates), numbers of at
// least three digits, and short names, addresses or titles.
function rowTokens(row) {
  const tokens = [];
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'number' && Number.isFinite(value) && (String(value).match(/\d/g) || []).length >= 3) tokens.push(String(value));
    else if (typeof value !== 'string') continue;
    else if (/^[A-Za-z0-9][\w./-]{2,30}$/.test(value) && (value.match(/\d/g) || []).length >= 3) tokens.push(value);
    else if (/(?:name|address|title)$/i.test(key) && value.trim().length >= 5 && value.length <= 80) tokens.push(value.trim());
  }
  return tokens;
}

// The tables of a result that carries a reporting mandate, with the identifiers
// and figures whose appearance in an answer shows the table was reported.
export function reportingTables(result) {
  if (!result || typeof result !== 'object' || !(result.reportingMandate || result.proseReportingMandate)) return [];
  return tabularRecords(result).map(({table, rows}) => ({table, rows: rows.length, tokens: [...new Set(rows.flatMap(rowTokens))]})).filter(t => t.tokens.length);
}

// With computed set, the selection already carries the envelope and baseline, so the guidance
// points only at parcel-specific records instead of asking for the same computation again.
export function subjectResearchGuidance(property,{computed=false}={}){
  const addrHint=property.address?`"${property.address}"`:`BBL ${property.bbl}`;
  const search=`For site-specific diligence, run a targeted acres_fanout_search on ${addrHint} (BBL ${property.bbl}, Block ${property.block || ''}, Lot ${property.lot || ''}) for parcel-specific ULURP/City Council actions, LPC filings, BSA variances, ACRIS development-rights transfers, or DOB zoning floor area filings`;
  return computed?`${search}.`:`${search}, and run acres_zoning_envelope / acres_entitlement_scenarios (which auto-record citable statutory sources) instead of fetching generic ZR chapters one by one.`;
}

// Sources the project's saved fields cite, by URL and character offset; the newest read wins.
const savedPageKey = (url, offset = 0) => JSON.stringify([url, offset]);
export function savedPageIndex(sources = []) {
  const pages = new Map();
  for (const source of sources) {
    const key = savedPageKey(source.url, source.offset ?? 0), held = pages.get(key);
    if (!held || held.fetchedAt < source.fetchedAt) pages.set(key, source);
  }
  return pages;
}

export function createResearchTools(secrets, progress = () => {}, meter = null, sessions = null, shared = null) {
  // Parallel lanes pass one shared pool so citation IDs and the run-wide call budget
  // stay server-assigned and enforced across concurrent children.
  if (shared) {
    if (typeof shared.calls !== 'number') shared.calls = 0;
    shared.budget ??= {used:{fetch:0, specialist:0, compute:0, reserve:0}, reserveUnlocked:false, exhausted:false};
    shared.fetchedPages ??= new Map();
    shared.fetchesInFlight ??= new Map();
    shared.signal ??= executionSignal();
  }
  const budget = shared?.budget ?? {used:{fetch:0, specialist:0, compute:0, reserve:0}, reserveUnlocked:false, exhausted:false};
  budget.freeRereads ??= 0;
  const sources = shared?.sources ?? [], discovered = new Map(), retrievedParcels = shared?.retrievedParcels ?? new Map();
  const seenKnowledge = shared?.seenKnowledge ?? new Set();
  if (shared && !shared.seenKnowledge) shared.seenKnowledge = seenKnowledge;
  const savedPages = shared?.savedPages ?? new Map();
  let property = null, sameBlockContext = null, detectedCity = shared?.detectedCity ?? null;
  const headers = () => composioHeaders(secrets);
  const router = (id, path) => `${root}/tool_router/session/${id}${path}`;
  async function paidJson(url, options, provider, operation) {
    throwIfCancelled();
    if (!meter) return json(url, options);
    const authorization = await meter.authorize(provider, operation);
    let result;
    try { result = await authorization.invoke(()=>json(url, options)); }
    catch (error) {
      // Failed calls can still incur cost. Never release a dispatched hold on a timeout.
      if (error.providerResult) await authorization.settle(error.providerResult);
      else await authorization.pending();
      throw error;
    }
    await authorization.settle(result);
    return result;
  }
  const canonicalSourceUrl = u => String(u || '').replace(/^https:\/\/zoningresolution\.planning\.nyc\.gov\b/i, 'https://zr.planning.nyc.gov');
  function evidence({title, url, text, kind = 'research', publishedDate = null, knowledge = null, verified = null, offset = 0, pdf = null, completeJson = false, fetchedAt = null, totalCharacters = null}) {
    throwIfCancelled();
    if (!publicUrl(url) || !text?.trim()) {
      if (completeJson) throw new Error('Complete JSON evidence requires a public URL and nonempty text.');
      return null;
    }
    if (kind === 'search') return null;
    const canonUrl = canonicalSourceUrl(url);
    if (kind === 'market') {
      return sources.find(s => canonicalSourceUrl(s.url) === canonUrl && s.kind !== 'market' && s.kind !== 'search' && s.verified !== false) || null;
    }
    const sourceUnits = shared ? 80 : 40;
    const capacityError = () => new Error('Complete JSON evidence exceeds the source text budget. Reduce the result limit or narrow the query.');
    if (completeJson && text.length > sourceUnits * 24000) throw capacityError();
    if (completeJson) JSON.parse(text);
    const capturedText = completeJson ? text : text.slice(0, 24000);
    const contentHash = shortHash(capturedText);
    const isVerified = verified !== null ? Boolean(verified) : (kind !== 'assumption');
    const pageOffset = knowledge?.offset ?? offset ?? 0;
    // Reuse only the same captured evidence; later reads cannot rewrite an existing citation.
    const old = sources.find(s => (fetchedAt === null || s.fetchedAt === fetchedAt) && canonicalSourceUrl(s.url) === canonUrl && s.text === capturedText && s.kind === kind
      && (s.verified !== false) === isVerified && (s.publishedDate ?? null) === publishedDate
      && (s.knowledge?.offset ?? s.offset ?? 0) === pageOffset
      && (s.knowledge?.versionId ?? null) === (knowledge?.versionId ?? null)
      && (s.knowledge?.observedAt ?? null) === (knowledge?.observedAt ?? null)
      && ['lastChecked','lastAttempted','refreshFailed','stale','effectiveFrom','effectiveTo','superseded'].every(key=>(s.knowledge?.[key]??null)===(knowledge?.[key]??null))
      && JSON.stringify(s.pdf ?? s.knowledge?.pdf ?? null) === JSON.stringify(pdf ?? knowledge?.pdf ?? null));
    if (old) return old;
    // A complete document uses the same text allowance as multiple ordinary excerpts.
    const units = value => Math.max(1, Math.ceil(value.length / 24000));
    const usedUnits = sources.reduce((total, source) => total + units(source.text), 0);
    if (usedUnits + units(capturedText) > sourceUnits) {
      if (completeJson) throw capacityError();
      return null;
    }
    const s = {id:sources.length+1, title, url, text:capturedText, contentHash, ...(completeJson?{completeJson:true}:{}), verified:isVerified, kind, publishedDate, fetchedAt:knowledge?.observedAt||fetchedAt||new Date().toISOString(),...(pageOffset>0?{offset:pageOffset}:{}),...(totalCharacters!==null&&!completeJson?{totalCharacters}:{}),...(knowledge?{knowledge:structuredClone(knowledge)}: {}),...(pdf?{pdf:structuredClone(pdf)}:{})};
    sources.push(s); return s;
  }
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    const url = value.url || value.id || value.metadata?.sourceURL;
    const text = value.text || value.markdown || value.content;
    if (typeof url === 'string' && typeof text === 'string') {
      const s = evidence({url, text, title:value.title || value.metadata?.title || url, publishedDate:value.publishedDate});
      if (s) value.sourceId = s.id;
    } else if (typeof url === 'string' && (value.description || value.snippet || value.highlights?.length)) {
      const excerpt=value.description || value.snippet || value.highlights.join('\n');
      const s = evidence({url, title:value.title || url, text:`Search excerpt, not a complete document:\n${excerpt}`, kind:'search'});
      if (s) value.sourceId = s.id;
    }
    for (const child of Object.values(value)) if (typeof child === 'object') collect(child);
  }
  const {findProperty:rawFindProperty,nearby,sameBlock}=createParcelOperations({request:json,record:evidence,onParcel:(bbl,row)=>retrievedParcels.set(bbl,row)});
  async function findProperty(args) {
    const out = await rawFindProperty(args);
    const jid = out?.jurisdiction?.jurisdiction || out?.jurisdiction?.id;
    if (jid) {
      detectedCity = jid;
      if (shared) shared.detectedCity = detectedCity;
    }
    return out;
  }
  async function discover({query}) {
    if(!sessions)throw new Error('Public research is unavailable for this request.');
    const ids=[sessions.exa,sessions.public];
    const settled=await Promise.allSettled(ids.map(id=>paidJson(router(id,'/search'),{method:'POST',headers:headers(),body:JSON.stringify({queries:[{use_case:query}],search_strategy:'tool_search'})},'composio','composio_discovery')));
    const firstErr=settled.find(s=>s.status==='rejected')?.reason;
    if(settled.every(s=>s.status==='rejected'))throw firstErr;
    const options=settled.flatMap((s,i)=>s.status==='fulfilled'?Object.entries(s.value.tool_schemas??{}).filter(([slug])=>i===1 || exaTools.has(slug)).map(([slug,schema])=>({slug,schema,session:ids[i]})):[]);
    const unique=[...new Map(options.map(t=>[t.slug,t])).values()].slice(0,10);
    const tools=await Promise.all(unique.map(async tool=>{
      const meta=await paidJson(`${root}/tools/${tool.slug}?toolkit_versions=latest&include_pricing=true`,{headers:headers()},'composio','composio_metadata');
      const allowed=exaTools.has(tool.slug) || (meta.tags.includes('readOnlyHint') && !meta.tags.includes('destructiveHint') && (meta.no_auth===true || meta.instant?.supported===true));
      if (!allowed) return null;
      const session=exaTools.has(tool.slug)?sessions.exa:sessions.public;
      discovered.set(tool.slug,{session});
      return {slug:tool.slug,description:tool.schema.description,inputSchema:tool.schema.input_schema,instant:meta.instant,note:exaTools.has(tool.slug)?'Pinned shared Exa research account.':'Public read-only research. Instant calls may fail if the wallet has no credits.'};
    }));
    return {tools:tools.filter(Boolean),note:'Choose relevant tools and arguments. Private accounts, account linking, arbitrary proxy requests and workbench execution are unavailable.'};
  }
  function validateUrls(value) {
    if (typeof value==='string' && /^(https?:|file:|ftp:)/i.test(value) && !publicUrl(value)) throw new Error('Research tools accept public HTTPS URLs only.');
    if (Array.isArray(value)) value.forEach(validateUrls);
    else if (value && typeof value==='object') Object.values(value).forEach(validateUrls);
  }
  async function executeTool({slug,arguments:args}) {
    const tool=discovered.get(slug);
    if (!tool) throw new Error('Discover this tool before executing it. Only public research tools are available.');
    validateUrls(args);
    if (args.actions?.length || args.headers || args.cookies) throw new Error('Browser actions and custom authentication are unavailable in public research.');
    if (slug==='EXA_SEARCH' || slug==='EXA_FIND_SIMILAR') {
      args={...args,numResults:Math.min(args.numResults??5,8),contents:args.contents??{text:{maxCharacters:12000}}};
    }
    if (slug==='EXA_GET_CONTENTS_ACTION' && args.text===undefined) args={...args,text:true};
    const result=await paidJson(router(tool.session,'/execute'),{method:'POST',headers:headers(),body:JSON.stringify({tool_slug:slug,arguments:args})},exaTools.has(slug)?'exa':'composio',slug);
    collect(result.data);
    return {data:result.data,sources:sources.map(s=>({id:s.id,title:s.title,url:s.url})),instantCharge:result.instant_charge};
  }
  async function metered(provider,operation,fn){
    throwIfCancelled();
    if(!meter)return fn();
    const auth=await meter.authorize(provider,operation);
    try{throwIfCancelled();const out=await auth.invoke(fn);await auth.settle(out&&typeof out==='object'?out:{});return out;}
    catch(e){await auth.pending().catch(()=>{});throw e;}
  }
  const fetchUrlDirect=createUrlFetcher(secrets,{meterRender:render=>metered('cloudflare','cloudflare_markdown',render)});
  async function fanout({query,city}){
    const meterWrap=(p,provider,operation)=>p&&{...p,search:(q,o)=>metered(provider,operation,()=>p.search(q,o))};
    let knowledgeSearch=null,localItems=[],jevRoute=null;
    const store=openKnowledge();
    const embedder=store?resolveKnowledgeEmbedder(secrets):null;
    const jevRouter=store?resolveJevRouter(secrets):null;
    let targetCity=resolveSearchJurisdiction({city,query,fallbackCity:detectedCity});
    if(!detectedCity&&(city||inferQueryJurisdiction(query))){
      detectedCity=targetCity;
      if(shared)shared.detectedCity=detectedCity;
    }
    try{
      // Routing only gates the local corpus search. Independent web providers start
      // at the same time, and a router score never silently narrows broad discovery.
      if(store){
        knowledgeSearch=async args=>{
          if(jevRouter){
            const catalog=store.indexCatalog({query,hintJurisdiction:targetCity,limit:60});
            if(catalog.length){
              jevRoute=await abortable(jevRouter.route({query,city:city||targetCity,catalog}));
              throwIfCancelled();
              if(jevRoute&&!city&&jevRoute.selectedSourceIds.length){
                const topSource=catalog.find(c=>c.id===jevRoute.selectedSourceIds[0]);
                if(topSource?.jurisdiction)targetCity=topSource.jurisdiction;
              }
            }
          }
          const activeProp=property||shared?.subjectProperty||null;
          const res=await store.search({
            ...args,
            city:targetCity,
            sourceIds:jevRoute?jevRoute.selectedSourceIds:null,
            sourceScores:jevRoute?jevRoute.sourceScores:null,
            recordRetrieval:false,
          },embedder);
          throwIfCancelled();
          if(res?.results)res.results=res.results.filter(item=>!isIrrelevantSpecialDistrictSource(item.url,query,activeProp));
          localItems=res?.results||[];
          for(const item of localItems)if(item.versionId)seenKnowledge.add(item.versionId);
          return res;
        };
      }
      const providers=[
        localProvider(knowledgeSearch),
        meterWrap(serperProvider(secrets),'serper','SERPER_SEARCH'),
        meterWrap(exaProvider(secrets,sessions),'exa','EXA_SEARCH'),
        meterWrap(deepseekProvider(secrets),'deepseek','DEEPSEEK_SEARCH'),
      ];
      const out=await fanoutSearch({query,providers,limit:12});
      const directSources=[];
      const citationByUrl=new Map();
      if(jevRoute?.directPullSourceIds?.length&&localItems.length){
        const pullSet=new Set(jevRoute.directPullSourceIds);
        const activeProp=property||shared?.subjectProperty||null;
        for(const item of localItems){
          if(!pullSet.has(item.sourceId))continue;
          if(isIrrelevantSpecialDistrictSource(item.url,query,activeProp))continue;
          const src=evidence({
            title:item.title,
            url:item.url,
            text:item.text,
            kind:item.kind,
            publishedDate:item.publishedAt,
            knowledge:item,
          });
          if(src){
            citationByUrl.set(item.url,src.id);
            directSources.push({
              citationId:src.id,
              sourceId:item.sourceId,
              versionId:item.versionId,
              title:item.title,
              url:item.url,
              text:item.text.slice(0,4000),
            });
          }
        }
      }
      return {
        ...out,
        city:targetCity,
        ...(jevRoute?{jevRoute:{
          hasDirectIndexedMatch:jevRoute.hasDirectIndexedMatch,
          needsWebFanout:jevRoute.needsWebFanout,
          selectedSourceIds:jevRoute.selectedSourceIds,
          directPullSourceIds:jevRoute.directPullSourceIds,
        }}:{}),
        ...(directSources.length?{
          directSources,
          directPullNote:'High-confidence indexed sources were pulled directly and recorded as citable sources (see citationId in directSources). Cite them directly without re-fetching unless you need additional offset pages.',
        }:{}),
        results:out.results.map(r=>({
          rank:r.rank,
          url:r.url,
          title:r.title,
          snippet:r.snippet.slice(0,400),
          providers:r.providers,
          authority:r.authority,
          ...(citationByUrl.has(r.url)?{citationId:citationByUrl.get(r.url)}:{}),
        })),
      };
    }finally{store?.close();}
  }
  const fetchedPages = shared?.fetchedPages ?? new Map();
  const fetchesInFlight = shared?.fetchesInFlight ?? new Map();
  // Fragment variants of one URL are the same page.
  const pageKey = url => url.split('#')[0];
  const fetchKey = (url,requiresPdf) => `${requiresPdf||isPdfUrl(url)?'pdf':'document'}:${pageKey(url)}`;
  async function fetchDocument(url,requiresPdf) {
    throwIfCancelled();
    const key=fetchKey(url,requiresPdf);
    let flight=fetchesInFlight.get(key);
    if(!flight){
      flight={controller:new AbortController(),waiters:0};
      fetchesInFlight.set(key,flight);
      flight.promise=withExecutionSignal(combinedSignal(shared?.signal,flight.controller.signal),async()=>{
        try{
          const doc=await fetchUrlDirect({url,requirePdf:requiresPdf});
          throwIfCancelled();
          if(doc.url)fetchedPages.set(doc.url,doc);
          if(!fetchedPages.has(pageKey(url))||doc.pdfPages)fetchedPages.set(pageKey(url),doc);
          return doc;
        }finally{if(fetchesInFlight.get(key)===flight)fetchesInFlight.delete(key);}
      });
    }
    flight.waiters++;
    try{return await abortable(flight.promise);}
    finally{
      if(--flight.waiters===0){
        if(fetchesInFlight.get(key)===flight)fetchesInFlight.delete(key);
        flight.controller.abort(stoppedError());
      }
    }
  }
  const literalFindIndex=(text,term,offset=0)=>{
    const pattern=new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');
    pattern.lastIndex=offset;return pattern.exec(text)?.index??-1;
  };
  // True when the page is served from saved knowledge (now or earlier in the run);
  // such reads cost no network and no budget.
  function knowledgeCached(url,requiresPages=false) {
    const hit = fetchedPages.get(url);
    if (hit) return hit.method === 'knowledge-cache'&&(!requiresPages||Boolean(hit.pdfPages));
    if (!publicUrl(url)) return false;
    const store = openKnowledge();
    try {
      const cached = store?.findByUrl?.(url);
      if (!cached) return false;
      const doc={url:cached.url, title:cached.title, text:cached.text, method:'knowledge-cache', publishedAt:cached.publishedAt, browserMs:null,knowledge:{versionId:cached.versionId,sourceId:cached.sourceId,observedAt:cached.observedAt,lastChecked:cached.lastChecked,lastAttempted:cached.lastAttempted,refreshFailed:cached.refreshFailed,stale:cached.stale,effectiveFrom:cached.effectiveFrom,effectiveTo:cached.effectiveTo},...(cached.pdfPages?{pdfPages:cached.pdfPages}:{})};
      fetchedPages.set(cached.url, doc);
      fetchedPages.set(url, zrSectionView(url, doc));
      const usable=!requiresPages||Boolean(doc.pdfPages);
      if(usable)seenKnowledge.add(cached.versionId);
      return usable;
    } finally { store?.close(); }
  }
  // A section URL answered by its parent chapter (a cached chapter or a #section link)
  // returns that section alone, from its heading line to the next section heading,
  // cited to the section URL, as the live section page would be.
  function zrSectionView(url, doc) {
    const section = url.match(/(?:#|\/)(\d{2,3}-\d{2,3}[a-z]?)(?:$|[?#])/i)?.[1]?.toLowerCase();
    if (!section || !/(?:^|\/\/)(?:zr|zoningresolution)\.planning\.nyc\.gov\b/i.test(url)) return doc;
    if (new RegExp(`/${section}(?:$|[?#])`, 'i').test(doc.url)) return doc;
    const heads = [...doc.text.matchAll(/^[ \t#*]*(\d{2,3}-\d{2,3}[a-z]?)[ \t*]*$/gim)];
    const at = heads.findIndex(h => h[1].toLowerCase() === section);
    if (at < 0) return doc;
    const start = heads[at].index;
    const end = heads.slice(at + 1).find(h => h[1].toLowerCase() !== section)?.index ?? doc.text.length;
    const text = doc.text.slice(start, end).trim();
    const heading = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ');
    return {...doc, url, title: `ZR ${heading}`, text};
  }
  function extractZrSectionIndex(text) {
    const matches = [];
    const seen = new Set();
    const lines = String(text || '').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.length > 110) continue;
      const secMatch = line.match(/^(\d{2,3}-\d{2,3}[a-z]?)\s+[A-Z][\w\s,()/-]{2,80}$/);
      const termMatch = line.match(/^([A-Z][A-Za-z0-9 ,()-]{2,50})\s+\((?:see|See)\b|^([A-Z][a-z]+(?: [a-z]+){0,4})$/);
      const label = secMatch ? line.replace(/\s*Last Amended.*$/i, '').trim() : (termMatch ? line : null);
      if (label && !seen.has(label)) {
        seen.add(label);
        matches.push(label);
        if (matches.length >= 60) break;
      }
    }
    return matches;
  }
  async function fetchUrl({url,offset=0,find,page}){
    validateUrls(url);
    const requestedPage=requestedPdfPage(url,page);
    if(offset!==undefined&&(!Number.isSafeInteger(offset)||offset<0))throw new Error('Use a non-negative whole-number character offset.');
    if(find!==undefined&&(typeof find!=='string'||find.length>200))throw new Error('Use a search phrase of up to 200 characters for find.');
    const isPlanningHost = /(?:^|\/\/)(?:zr|zoningresolution)\.planning\.nyc\.gov\b/i.test(url);
    const hasFind = typeof find === 'string' && find.trim().length > 0;
    if (isPlanningHost && offset >= 48000 && !hasFind) {
      throw new Error('Sequential offset paging past 48,000 characters on NYC Zoning Resolution chapters is disabled because it fills the research context with text unrelated to the question. Call acres_fetch_url with the `find` parameter (for example `find: "23-692"` or `find: "qualifying affordable housing"`) to jump directly to the target section or defined term, or use acres_search_knowledge.');
    }
    let out=fetchedPages.get(url)||null;
    if(!out&&knowledgeCached(url))out=fetchedPages.get(url);
    if(!out&&fetchedPages.has(pageKey(url)))out=zrSectionView(url,fetchedPages.get(pageKey(url)));
    if(!out||(requestedPage!==undefined&&!out.pdfPages)){
      out=await fetchDocument(url,requestedPage!==undefined);
      throwIfCancelled();
      out=zrSectionView(url,out);
    }
    fetchedPages.set(url,out);
    let physicalPage=requestedPage;
    if(physicalPage===undefined&&hasFind&&offset===0&&out.pdfPages){
      const needle=find.trim(),index=literalFindIndex(out.text,needle);
      physicalPage=out.pdfPages.find(p=>index>=p.start&&index+needle.length<=p.end)?.page;
    }
    if(physicalPage!==undefined)out=selectPdfPage(out,physicalPage);
    let effectiveOffset=offset;
    let searchTerm=hasFind?find.trim():null;
    if(!searchTerm&&offset===0&&out.text.length>24000){
      const urlSection=url.match(/(?:#|\/)(\d{2,3}-\d{2,3}[a-z]?)(?:$|[?#])/i)?.[1];
      if(urlSection)searchTerm=urlSection;
    }
    let matchedIndex=null;
    if(searchTerm){
      let idx=literalFindIndex(out.text,searchTerm,offset);
      if(idx<0&&offset>0)idx=literalFindIndex(out.text,searchTerm);
      if(idx>=0){
        matchedIndex=idx;
        if(find||(idx>18000&&offset===0)){
          const rawStart=Math.max(0,idx-300);
          const nl=out.text.indexOf('\n',rawStart);
          effectiveOffset=nl>=0&&nl<=idx?nl+1:rawStart;
        }
      }
    }
    if(effectiveOffset>0&&effectiveOffset>=out.text.length)throw new Error('Character offset is past the end of the fetched document.');
    const pageText=out.text.slice(effectiveOffset,effectiveOffset+24000);
    const s=evidence({title:effectiveOffset>0?`${out.title} (offset ${effectiveOffset})`:out.title,url:out.url,text:pageText,publishedDate:out.publishedAt||null,offset:effectiveOffset,totalCharacters:out.text.length,...(out.pdf?{pdf:out.pdf}:{}),...(out.knowledge?{knowledge:{...out.knowledge,offset:effectiveOffset,totalCharacters:out.text.length,...(out.pdf?{pdf:out.pdf}:{})}}:{})});
    if(!s)throw new Error('Fetched text could not be recorded as a source. Try another URL.');
    const nextOffset=effectiveOffset+24000<out.text.length?effectiveOffset+24000:null;
    const extraMeta = (isPlanningHost && out.text.length > 24000)
      ? {
          sectionIndex: extractZrSectionIndex(out.text),
          pagingHint: 'Do NOT page sequentially with offset >= 48000 on NYC Zoning Resolution chapters. Pass `find: "<section number or defined term>"` to jump directly to any section in this document, or use `acres_search_knowledge`.',
        }
      : {};
    return {sourceId:s.id,url:out.url,title:out.title,method:out.method,browserMs:out.browserMs||null,offset:effectiveOffset,matchedIndex,...(hasFind?{findMatched:matchedIndex!==null,findTerm:find.trim(),...(matchedIndex===null?{sectionIndex:extractZrSectionIndex(out.text)}:{})}:{}),totalCharacters:out.text.length,nextOffset,text:pageText,truncated:nextOffset!==null,...extraMeta,...(out.knowledge?{knowledge:out.knowledge}:{}),...(out.pdfPages?{pdfPageCount:out.pdfPages.length}:{}),...(out.pdf?{pdf:out.pdf}:{}),note:out.pdf?'Cite this source ID for this physical PDF page. Printed page labels may differ.':'Cite this source ID for claims from this page.'};
  }
  async function setSubject({bbl}) {
    const row=retrievedParcels.get(bbl);
    if (!row) throw new Error('Retrieve this parcel first, then select it only if it is the property the user means.');
    property={...row,bbl};
    detectedCity='US-NY-NYC';
    if(shared){
      shared.detectedCity='US-NY-NYC';
      if(!shared.subjectBbl){shared.subjectBbl=bbl;shared.subjectProperty=property;}
    }
    sameBlockContext = null;
    try {
      sameBlockContext = await sameBlock?.({bbl, borough: row.borough, block: row.block, lot: row.lot});
    } catch {}
    return {
      property,
      parcelDiagnostics: buildParcelDiagnostics(row),
      ...(sameBlockContext ? {sameBlockContext} : {}),
      note:'This is the property under discussion. Looking up comparisons does not change it.',
      researchGuidance:subjectResearchGuidance(property),
    };
  }
  const definitions=[
    ...knowledgeDefinitions,
    ...registryDefinitions,
    ...zoningFactsDefinitions,
    definition('acres_find_property','Resolve a property in the deep-coverage market (New York City) by normalized or approximate street address, borough or BBL, returning PLUTO records or GeoSearch candidates. Always include the city and state in the address when known: a clearly non-NYC US address returns its detected jurisdiction and research-tier coverage instead of parcel rows, so continue with live official-source research for that jurisdiction and do not retry parcel lookups there. If the prompt specifies a lot area in sq ft and the address is a street name without a house number (or has multiple candidate lots), pass `lotAreaSqft` to disambiguate the exact PLUTO tax lot. Try normalized abbreviations. Never infer identity from confidence alone.',{address:{type:'string'},borough:{type:'string'},bbl:{type:'string'},lotAreaSqft:{type:'number',description:'Optional lot area in sq ft from the prompt to disambiguate multiple parcels on the same street.'}},[]),
    definition('acres_set_subject','NYC only: select a previously retrieved PLUTO parcel as the main property the user means, after resolving ambiguity. This updates the property panel. Do not select comparison properties as the subject. Research-tier cities have no parcel panel yet.',{bbl:{type:'string'}},['bbl']),
    definition('acres_nearby_properties','NYC only: find live PLUTO parcel candidates near a BBL for comparative development and assembly research. Distance does not establish adjacency or available rights.',{bbl:{type:'string'},radiusMeters:{type:'number',minimum:10,maximum:500}},['bbl']),
    definition('acres_discover_tools','Search Composio for relevant public research tools and schemas, including Exa, public search, source fetching and eligible Instant tools. Discover as needed instead of loading the entire catalog.',{query:{type:'string'}},['query']),
    definition('acres_execute_tool','Execute a tool returned by acres_discover_tools using its exact schema. Returns source IDs for citations. No private connected accounts, messages, edits or account management.',{slug:{type:'string'},arguments:{type:'object',additionalProperties:true}},['slug','arguments']),
    definition('acres_fanout_search','Run one discovery query across every configured search provider in parallel (saved knowledge, Serper/Google, Exa, DeepSeek) and return one deduplicated, authority-ranked URL list with snippets. Prefer this for finding sources; snippets are not citable evidence. Fetch relied-on URLs with acres_fetch_url.',{query:{type:'string'},city:{type:'string',description:'Optional jurisdiction identifier such as US-NY-NYC or US-TX-AUSTIN; defaults to the detected jurisdiction or US-NY-NYC.'}},['query']),
    definition('acres_fetch_url','Read one public HTTPS URL and record citable text, using saved knowledge when available. For PDFs use a physical page number starting at 1, or a #page=N URL. A PDF find match returns its physical page. Character offsets are local to a selected PDF page; otherwise they address the full document. A URL in the project\'s savedSources, read at its listed offset without find, page or live, returns the text saved with the site and its age at no fetch cost. Pass live:true when the question needs current figures or the saved text is too old for it.',{url:{type:'string'},live:{type:'boolean',description:'Read the current page even when the project\'s savedSources hold this URL.'},offset:{type:'integer',minimum:0,description:'Character offset in the document or selected PDF page.'},find:{type:'string',description:'Section number or phrase to find in the document or selected PDF page.'},page:{type:'integer',minimum:1,description:'Physical PDF page number, starting at 1; printed labels may differ.'}},['url']),
  ];
  const handlers={...createKnowledgeHandlers({record:evidence,seen:seenKnowledge,getCity:()=>detectedCity,getProperty:()=>property||shared?.subjectProperty||null}),...createRegistryHandlers({getCity:()=>detectedCity}),...createZoningFactsHandlers({getCity:()=>detectedCity}),acres_find_property:findProperty,acres_set_subject:setSubject,acres_nearby_properties:nearby,acres_discover_tools:discover,acres_execute_tool:executeTool,acres_fanout_search:fanout,acres_fetch_url:fetchUrl};
  // Tools the calling agent can actually run (host-built and, in a lane, allowed),
  // so budget steers never name a tool that would only fail. Nothing is named
  // until the caller offers its tool set.
  let offered=new Set();
  const sizingOffered=()=>[...SIZING_TOOL_NAMES].filter(name=>offered.has(name));
  function budgetState(){
    const left=category=>BUDGET[category]-budget.used[category];
    return {fetch:left('fetch'),specialist:left('specialist'),compute:left('compute'),reserve:left('reserve'),reserveLocked:!budget.reserveUnlocked,
      remainingToolCalls:left('fetch')+left('specialist')+left('compute')+(budget.reserveUnlocked?left('reserve'):0)};
  }
  function consumeCall(name){
    throwIfCancelled();
    const category=budgetCategory(name);
    const state=budgetState();
    if(state[category]>0)budget.used[category]++;
    else if(!state.reserveLocked&&state.reserve>0)budget.used.reserve++;
    else{
      budget.exhausted=true;
      const others=Object.keys(BUDGET_LABELS).filter(other=>other!==category&&state[other]>0).map(other=>`${state[other]} ${BUDGET_LABELS[other]}`);
      const sizing=sizingOffered();
      const computeLeft=category!=='compute'&&state.compute>0&&sizing.length
        ?` The compute calls still work, and these size the options locally: ${sizing.join(', ')}. Use them to size the options the evidence supports.`:'';
      const message=!others.length
        ?'The research tool budget is exhausted. Summarize the evidence and remaining gaps.'
        :`The research tool budget is exhausted for ${BUDGET_LABELS[category]} calls. ${others.join(' and ')} calls remain.${computeLeft} ${computeLeft?'Then write':'Write'} the answer from the evidence gathered and name the remaining gaps.`;
      const error=new Error(message);error.retryable=false;throw error;
    }
    if(shared)shared.calls++;
    return budgetState();
  }
  // Adds budget state (total and per category), the fetch wrap-up steer and the
  // reporting mandate to a tool result.
  function annotate(name,result,state){
    const {remainingToolCalls,...perCategory}=state;
    const sizing=sizingOffered();
    const sizeOptions=sizing.length&&state.compute>0?`the ${state.compute} remaining compute calls to size each option you name (${sizing.join(', ')}) and `:'';
    const wrapUp=budgetCategory(name)==='fetch'&&state.fetch<=1?{wrapUp:{fetchRemaining:state.fetch,specialistRemaining:state.specialist,computeRemaining:state.compute,
      steer:`Fetch and search budget: ${state.fetch} call(s) left. Stop broad searching and fetch only what would change the decision. Use ${sizeOptions}the ${state.specialist} remaining records calls only where a record would change the decision, then write the answer.`}}:{};
    const mandate=reportingMandate(name,result);
    return {...result,remainingToolCalls,budget:perCategory,...wrapUp,...(mandate?{reportingMandate:mandate}:{})};
  }
  // A page fetched earlier in the run is read again from memory. The re-read is free
  // while fetch budget remains and the run's free re-reads last; the slot is held
  // here and returned in execute when the read fails.
  function freeReread(url,requiresPages=false){
    if(!(fetchedPages.has(url)||fetchedPages.has(pageKey(url)))||budget.exhausted||budgetState().fetch<=0||budget.freeRereads>=FREE_REREADS)return false;
    if(requiresPages&&!(fetchedPages.get(url)||fetchedPages.get(pageKey(url))).pdfPages)return false;
    budget.freeRereads++;
    return true;
  }
  // A plain read of a URL the site's saved fields cite, at the offset they cite (or anywhere in a
  // saved complete JSON record), returns the text the citing run recorded, at no fetch cost and with
  // its original retrieval date. A find, a page selection, live:true or an earlier live read of the
  // URL in this run reads the current document.
  function savedPage({url,offset=0,find,page,live}){
    if(live||find!==undefined||page!==undefined||typeof url!=='string'||fetchedPages.has(url))return null;
    const exact=savedPages.get(savedPageKey(url,offset));
    if(exact)return {source:exact,offset};
    const whole=savedPages.get(savedPageKey(url,0));
    return whole?.completeJson&&Number.isSafeInteger(offset)&&offset<whole.text.length?{source:whole,offset}:null;
  }
  function readSaved({source:saved,offset}){
    const s=evidence({title:saved.title,url:saved.url,text:saved.text,kind:saved.kind,publishedDate:saved.publishedDate??null,offset:saved.offset??0,pdf:saved.pdf??null,completeJson:Boolean(saved.completeJson),fetchedAt:saved.fetchedAt,totalCharacters:saved.totalCharacters??null,verified:true});
    if(!s)throw new Error('This saved source does not fit the remaining source text budget. Cite the sources already read.');
    // Offsets address the document the excerpt came from; a complete JSON record is the whole document.
    const start=s.completeJson?offset:0,text=s.text.slice(start,start+24000),end=s.completeJson?start+text.length:(s.offset??0)+s.text.length;
    const total=s.completeJson?s.text.length:saved.totalCharacters??null;
    // An excerpt saved before document lengths were recorded may continue past its last character.
    const nextOffset=total!==null?(end<total?end:null):(s.text.length>=24000?end:null);
    const ageDays=Math.max(0,Math.floor((Date.now()-Date.parse(s.fetchedAt))/86400000));
    return {sourceId:s.id,url:s.url,title:s.title,method:'saved-source',retrievedAt:s.fetchedAt,ageDays,offset,totalCharacters:total,nextOffset,text,truncated:nextOffset!==null,...(s.pdf?{pdf:s.pdf}:{}),savedWith:saved.fields,
      note:`Text recorded ${ageDays} day${ageDays===1?'':'s'} ago, when this source was read for the saved site. Cite this source ID for claims from it. Call again with live:true when the question needs current figures or this text is too old for it; use find or nextOffset for text it does not hold.`};
  }
  return {definitions,sources,record:evidence,consumeCall,annotate,offer(names){offered=new Set(names);},unlockReserve(){budget.reserveUnlocked=true;},get budget(){return {...budgetState(),exhausted:budget.exhausted};},get property(){return property;},get sameBlockContext(){return sameBlockContext;},get detectedCity(){return detectedCity;},async execute(name,args){
    throwIfCancelled();
    if (!handlers[name]) throw new Error('This tool is unavailable.');
    const fetchArg=name==='acres_fetch_url'&&typeof args?.url==='string';
    const requiresPages=fetchArg&&(args.page!==undefined||(publicUrl(args.url)&&requestedPdfPage(args.url)!==undefined));
    const knowledgeHit=fetchArg&&knowledgeCached(args.url,requiresPages);
    const saved=fetchArg&&!knowledgeHit?savedPage(args):null;
    const reread=fetchArg&&!knowledgeHit&&!saved&&freeReread(args.url,requiresPages);
    const inFlight=fetchArg&&!saved&&fetchesInFlight.has(fetchKey(args.url,requiresPages));
    const cacheHit=knowledgeHit||Boolean(saved)||reread||inFlight;
    // Errors carry whether the call spent budget, so traces count only real charges.
    let state;
    const category=budgetCategory(name);
    const chargedCategory=cacheHit?null:(budgetState()[category]>0?category:'reserve');
    try{state=cacheHit?budgetState():consumeCall(name);}
    catch(error){error.charged=false;throw error;}
    progress(name==='acres_find_property'?'Identifying the property':name==='acres_nearby_properties'?'Comparing nearby properties':'Researching sources');
    let result;
    try{result=saved?readSaved(saved):await handlers[name](args);throwIfCancelled();}
    catch(error){
      if(reread)budget.freeRereads--;
      error.charged=!cacheHit;
      throw error;
    }
    if(fetchArg&&result.findMatched===false){
      if(chargedCategory){budget.used[chargedCategory]--;if(shared)shared.calls--;}
      if(reread)budget.freeRereads--;
      state=budgetState();
      result={...result,fetchBudgetRefunded:Boolean(chargedCategory),note:'The phrase was not found. Use the section index or another phrase. This miss consumes no research fetch slot; provider usage is unchanged.'};
    }
    console.log(JSON.stringify({event:'research_tool_completed',tool:name,slug:args.slug,sourceCount:sources.length}));
    return annotate(name,cacheHit?{...result,cacheHit:true}:result,state);
  }};
}
import {knowledgeDefinitions,createKnowledgeHandlers,isIrrelevantSpecialDistrictSource} from './knowledge-tools.mjs';
import {registryDefinitions,createRegistryHandlers} from './source-registry.mjs';
import {zoningFactsDefinitions,createZoningFactsHandlers} from './zoning-facts.mjs';
import {CAPABILITIES,COMPUTE_TOOL_NAMES} from './capabilities.mjs';
