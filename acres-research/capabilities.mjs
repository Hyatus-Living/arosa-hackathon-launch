import {readFileSync} from 'node:fs';

// One registry for every capability the research agent can reach: native tools,
// computed specialist tools, and loadable skills. This file is deliberately data,
// not orchestration. research.mjs decides which capabilities are exposed in a
// mode; the agent searches this registry at run time for specialist tools and
// skills instead of the harness hard-coding a tool subset per lane.
//
// Every new tool or skill must be registered here. capabilities.test.mjs and
// lanes.test.mjs enforce that every registered tool is reachable in every mode
// and that every tool definition the service builds is registered, so a tool
// can never silently ship unreachable again (the #93/#94 failure mode).
//
// exposure:
//   direct   - shown to the lead agent as a native tool (core evidence path)
//   nyc      - direct when the run is about New York City (the records and
//              zoning compute most NYC runs need, so no discovery step comes
//              before the first figure); behind the gateway everywhere else,
//              so other cities do not carry their definitions on every turn
//   gateway  - not shown up front; found with acres_search_capabilities and
//              run with acres_execute_capability (specialist tools)
//   lane     - shown directly to spawned/legacy lanes when their tags match
//
// cost (the run budget in tools.mjs derives its compute cap from this tag):
//   compute  - in-process arithmetic over evidence already in hand: no network
//              call, no subprocess, no provider charge. Charged to the compute cap.
//   engine   - draws a design concept: massing, test-fit floor plans from the
//              planning engine (a subprocess with a 120 s limit), or a queued
//              Blender walkthrough render; the massing concept may read
//              footprints and Street View once per property.
//              Charged to the compute cap, so design never trades off against
//              records.
//   free     - no provider charge, but may read the network, write the project
//              or run a local engine that assembles records (site assembly).
//   metered  - a paid provider call.
//   Everything else that is not a fetch tool is charged to records.
//
// sizes: true marks the compute tools that size a development option (area,
// entitlement paths, units, returns, program comparison). Budget steers name
// only these, so an exhausted budget never invites, say, a plan audit the user
// has supplied no figures for.

const tool=(name,title,when,tags,extra={})=>({kind:'tool',name,title,when,tags,aliases:[],exposure:'direct',jurisdiction:'any',cost:'free',...extra});
const skill=(name,title,when,tags,file,aliases=[])=>({kind:'skill',name,title,when,tags,aliases,exposure:'skill',jurisdiction:'any',cost:'free',file});

export const CAPABILITIES=[
  // Core evidence and property path: direct on the lead agent.
  tool('acres_search_knowledge','Search saved knowledge','Saved official sources already in the local corpus, with freshness and provenance.',['evidence','legal','zoning'],{aliases:['corpus','statute','zoning resolution','zr','mdl','rcny','local law']}),
  tool('acres_get_knowledge_source','Read a saved source','Full text of a source version found by knowledge search, paged when long.',['evidence','legal','zoning'],{aliases:['read','page','offset','version']}),
  tool('acres_refresh_knowledge','Refresh a saved source','Queue a background refresh of a registered source; does not change this answer.',['evidence'],{aliases:['update','stale','reindex']}),
  tool('acres_search_source_registry','Search the source registry','Find which external datasets and official sites exist for a jurisdiction and how to access them.',['evidence','discovery'],{aliases:['catalog','datasets','portal','zola','acris','dob','bis']}),
  tool('acres_search_zoning_facts','Search zoning facts and guidelines','Curated, source-cited zoning facts and practitioner guidelines: FAR and height tables, envelope rules, UAP/MIH, 485-x, land use review and due-diligence checklists, with misconceptions corrected.',['evidence','zoning','legal','entitlement'],{aliases:['facts','rules','cheat sheet','far table','rear yard','setback','uap','mih','485-x','ulurp','elurp','fast track','dwelling unit factor','air rights','guidelines']}),
  tool('acres_find_property','Find a property','Resolve an address, borough or BBL to NYC PLUTO parcel candidates; detects non-NYC jurisdiction.',['evidence','property','zoning'],{jurisdiction:'US-NY-NYC for parcels; detects other US jurisdictions',aliases:['parcel','lot','bbl','address','pluto','geosearch']}),
  tool('acres_set_subject','Select the subject property','Make a retrieved NYC parcel the property this conversation is about.',['property'],{jurisdiction:'US-NY-NYC',aliases:['select','confirm','main property','subject']}),
  tool('acres_nearby_properties','Nearby properties','PLUTO parcel candidates near a BBL for comparison and assembly research.',['property','zoning'],{jurisdiction:'US-NY-NYC',aliases:['neighbors','adjacent','radius','comparables','nearby']}),
  tool('acres_discover_tools','Discover external tools','Search Composio for public read-only research tools (including Exa) beyond the native set.',['evidence','discovery','legal'],{cost:'metered',aliases:['composio','exa','external']}),
  tool('acres_execute_tool','Execute a discovered tool','Run a tool returned by acres_discover_tools with its exact schema.',['evidence','discovery','legal'],{cost:'metered',aliases:['composio','exa','run']}),
  tool('acres_fanout_search','Fan-out web search','One query across saved knowledge, Serper/Google, Exa and DeepSeek; deduplicated, authority-ranked URLs. Snippets are leads, not evidence.',['evidence','discovery','legal','market'],{cost:'metered',aliases:['web','google','serper','exa','deepseek','search']}),
  tool('acres_fetch_url','Fetch a URL in full','Read one public HTTPS page as full citable text before relying on it.',['evidence','legal','market'],{cost:'metered when browser rendering is configured',aliases:['scrape','read page','url','markdown','pdf']}),

  // The project's floor plan: direct when the architecture feature is on for the run, absent otherwise.
  tool('acres_find_floor_plan','Find a published floor plan','Search an address, building website or listing link for 2D floor plan images and brochure or offering memorandum PDFs.',['design','property'],{cost:'metered',aliases:['floor plan','floorplan','listing','brochure','offering memorandum','unit plan','layout']}),
  tool('acres_attach_drawing','Attach a plan drawing','Download a floor plan file by URL into the project drawings shown in the plan editor.',['design','property'],{aliases:['attach','drawing','underlay','trace','upload plan']}),
  tool('acres_view_drawing','Look at a plan drawing','See an attached raster plan as an image (PDF as text, SVG as labels) to read room names and printed dimensions.',['design','property'],{aliases:['view','look','read dimensions','image','vision']}),
  tool('acres_read_plan','Read the project floor plan','The current plan revision: rooms and areas, walls, openings, issues, walkthrough status and attached drawings.',['design'],{aliases:['plan editor','revision','rooms','walls','current plan']}),
  tool('acres_save_plan','Save a floor plan revision','Draft or edit the project plan from dimensions, a full plan document, or an attached SVG; the editor on screen updates.',['design'],{aliases:['draw plan','draft plan','edit plan','walls','rooms','doors','windows']}),
  tool('acres_render_plan','Render plan finished products','Queue or reuse the Blender walkthrough job for a plan revision: preview image, 3D walkthrough model (GLB), editable Blender file and manifest from its IFC.',['design'],{cost:'engine',aliases:['render','walkthrough','preview','glb','blender','finished products','3d model']}),
  tool('acres_import_pascal_scene','Import an edited Pascal scene','Convert an uploaded Pascal scene JSON drawing back into a new plan revision, keeping element ids where the scene carries them.',['design'],{aliases:['pascal','import scene','pascal json','round-trip','edited in pascal']}),

  // Specialist tools: found through capability search, run through the gateway
  // (the nyc ones are direct when the run is about New York City).
  tool('acres_nyc_public_records','Query NYC public records (nycdb)','Prior and active DOB BIS & DOB NOW job/plan submittals (with approved/disapproved status), Certificates of Occupancy, ACRIS air-rights/easement instruments, HPD affordable-housing/violation records, HPD multiple dwelling registration, and DOB and ECB/OATH violations with penalties due by BBL.',['evidence','property','zoning','entitlement','legal'],{exposure:'nyc',jurisdiction:'US-NY-NYC',cost:'free',aliases:['nycdb','dob','bis','dob now','filings','permits','submittals','disapproved','objections','acris','hpd','certificate of occupancy','violations','ecb','oath','registration']}),
  tool('acres_development_ledger','NYC development ledger (land sales, filed capacity, assessments, pipeline)','Nightly-synced parcel ledger for the subject and its block: arm\'s-length ACRIS land sales with price per maximum ZFA, DOB filed zoning floor area and units, DOF assessed and market value with tax class, the DOB new-building pipeline in the ZIP, and the nearby pipeline: new buildings and major alterations around the subject with units, floor area and recorded condo or rental tenure.',['records','comps','land','pipeline','taxes','property','market','finance'],{exposure:'nyc',jurisdiction:'US-NY-NYC',cost:'free',aliases:['land sales','land comps','price per zfa','price per buildable','deeds','assessed value','assessment','property tax','tax class','dof','new buildings','filed capacity','ledger','nearby pipeline','what is being built nearby','new development nearby','condo or rental','construction pipeline']}),
  tool('acres_trade_press','NYC trade press on the lot and block','Recent Real Deal, New York YIMBY and Commercial Observer stories naming the subject lot or its block: reported sales, filings, financings and construction, with publisher, date and link.',['records','evidence','market','comps','land','pipeline'],{exposure:'gateway',jurisdiction:'US-NY-NYC',cost:'free',aliases:['news','press','trade press','the real deal','trd','yimby','commercial observer','reported deal','financing','in the news']}),
  tool('acres_far_precedents','Find NYC floor-area precedents','Past projects in a community district that filed more zoning floor area than their standard FAR allows, with the merger, air-rights, affordable-bonus and City Planning records that may explain how.',['zoning','entitlement','records','evidence'],{exposure:'gateway',jurisdiction:'US-NY-NYC',cost:'free',aliases:['precedent','precedents','comparable projects','beat far','exceeded far','bonus','air rights deals','zoning lot merger','special permit','zap','how did they build more']}),
  tool('acres_municipal_parcel_records','Query multi-city parcel & zoning adapter','Live municipal parcel/GIS lookup and curated zoning capacity for Miami / Miami-Dade (Miami 21 + Florida Live Local Act SB 102/SB 328), Fort Lauderdale (ULDR Ch. 47), and New Haven, CT (Title III Zoning).',['evidence','property','zoning','entitlement'],{exposure:'gateway',jurisdiction:'US-FL-MIAMI, US-FL-FORTLAUDERDALE, US-CT-NEWHAVEN',cost:'free',aliases:['miami','miami 21','transect','live local act','sb 102','sb 328','fort lauderdale','uldr','new haven','folio','gis']}),
  tool('acres_assemble_site','Assemble a multi-lot site','Union two to eight NYC tax lots from MapPLUTO polygons and PLUTO records, with contiguity, shared boundary feet and combined area.',['property','zoning','design','entitlement'],{exposure:'gateway',jurisdiction:'US-NY-NYC',cost:'free',aliases:['assemblage','merge','merger','combine','lots','contiguous','adjoining','polygon','mappluto']}),
  tool('acres_zoning_envelope','Compute the zoning envelope','NYC as-of-right envelope: FAR, per-storey footprints, coverage, units and parking with ZR sections, from the curated rules.',['zoning','design','entitlement'],{exposure:'nyc',jurisdiction:'US-NY-NYC',cost:'compute',sizes:true,aliases:['bulk','setback','sky exposure','height','yard','far','parking','dwelling units','as of right']}),
  tool('acres_entitlement_scenarios','Size entitlement paths','How a site could build more: UAP uplift, landmark transfers, zoning-lot mergers, conversions, variances, ELURP and ULURP rezonings, each sized and ranked.',['zoning','entitlement','finance'],{exposure:'nyc',jurisdiction:'US-NY-NYC',cost:'compute',sizes:true,aliases:['air rights','tdr','uap','mih','qah','bonus','landmark','74-79','75-422','72-21','variance','ulurp','elurp','rezoning','conversion','maximize']}),
  tool('acres_model_concept','Model a massing concept','2D/3D massing of a development concept from lot outline and per-storey footprints, with areas, FAR and height.',['design','zoning'],{exposure:'gateway',cost:'engine',aliases:['3d','massing','tower','podium','viewer','pascal','glb','render','building model']}),
  tool('acres_plan_concept','Test-fit floor plans','Per-storey test-fit layouts with units, cores, egress checks and takeoffs; optional IFC export.',['design'],{exposure:'gateway',cost:'engine',aliases:['floorplan','floorplate','layout','corridor','stairs','elevator','core','egress','ifc','bim','efficiency']}),
  tool('acres_audit_floorplan','Audit floor-plan efficiency (Upload & Critique)','Evaluate an architectural floor plan or survey for net-to-gross efficiency, corridor/core loss factors, IBC/NYC BC egress and light-and-air compliance, and recoverable net sq ft + pro-forma value uplift.',['design','finance','zoning'],{exposure:'gateway',cost:'compute',aliases:['upload and critique','floor plan audit','efficiency','loss factor','corridor waste','core ratio','dead end corridor','lease span','value engineering']}),
  tool('acres_nearby_places','Nearby places','Transit, retail, parks and schools near the selected property from Google Places.',['context','market'],{exposure:'gateway',cost:'metered',aliases:['subway','station','amenities','schools','parks','retail','neighborhood','walkability']}),
  tool('acres_market_comps','Harvest live MLS market comps (HomeHarvest)','Pull live Realtor.com / MLS sold, for-sale and rental comparables for any US location, with median $/sqft, unit sizes, and days-on-MLS absorption velocity by bedroom count.',['market','finance','evidence'],{exposure:'gateway',cost:'free',aliases:['homeharvest','mls','realtor','comparables','comps','sold','rentals','days on market','velocity']}),
  tool('acres_search_deal_store','Search NYC FAR & redevelopment deal store','Search the updating HomeHarvest + NYC broker listings + LoopNet + PLUTO deal store for live properties on the market ranked by unused buildable FAR, price per buildable square foot ($/ZFA), and Great/Good/Fair Deal valuation flashcards.',['market','finance','property','zoning'],{exposure:'gateway',jurisdiction:'US-NY-NYC',cost:'free',aliases:['deal store','deals','sourcing','broker listings','loopnet','investment sales','development sites','unused far','price per buildable','buildable sqft','bsf','undervalued','listings','flashcard']}),
  tool('acres_market_inputs','Record market inputs','Record submarket rents, sale prices, supply, pipeline and absorption with sources; never estimates a missing figure.',['market','finance'],{exposure:'gateway',aliases:['comps','rents','psf','condo prices','absorption','vacancy','pipeline','submarket']}),
  tool('acres_unit_mix','Compute a unit mix','Whole unit counts by bedroom type from residential gross area, mix and target sizes.',['market','finance','design'],{exposure:'gateway',cost:'compute',sizes:true,aliases:['studios','bedrooms','1br','2br','3br','apartments','allocation','unit count']}),
  tool('acres_pro_forma','Run a pro forma','Development budget (optionally as line items), revenue, NOI, returns and sensitivities as code from program, market inputs and user assumptions.',['finance','market'],{exposure:'gateway',cost:'compute',sizes:true,aliases:['underwriting','noi','yield on cost','cap rate','irr','roe','equity multiple','budget','line items','line-item budget','budget breakdown','hard cost','soft cost','dscr','sensitivity']}),
  tool('acres_compare_programs','Compare programs and decide the acquisition','Compare rental, condo, commercial, mixed-use and affordable variants by profit after incremental approval land carry, and record the acquisition decision: the highest land price at a target return and the revenue the stated price needs. Ordinal entitlement scores are separate from dollars; missing timing stays unpriced and rankings provisional.',['finance','market','entitlement'],{exposure:'gateway',cost:'compute',sizes:true,aliases:['acquisition decision','should I buy','buy or pass','offer price','max bid','residual land value','break-even','feasibility','highest and best use','rental vs condo','mixed use','mixed-use','commercial','retail','office','community facility','affordable','485-x','downside','flip']}),
  tool('acres_keep_building','Keep the building: hold, renovate and rent, or renovate and sell','Underwrite buying a property as it stands instead of building new: hold it as is, renovate and rent it, or renovate and sell it, each with cash flow, debt coverage, value or sale price and the highest price at the buyer\'s target, plus the way that pays the most.',['finance','market','property'],{exposure:'gateway',cost:'compute',aliases:['buy and hold','hold','rental property','value-add','value add','renovate','renovation','rehab','fix and flip','flip','as is','existing building','keep the building','cash flow','cash on cash','dscr','debt coverage','cap rate','rent roll','after repair value','arv','mortgage','investment property','offer']}),
  tool('acres_generate_deck','Generate institutional underwriting deck','Compile the conversation project state into a 7-slide Institutional Underwriting Package (executive summary, parcel forensics, zoning/entitlements, massing & floorplan audit, comps/unit mix, pro forma, and citation trail).',['finance','presentation','market','zoning'],{exposure:'gateway',cost:'free',aliases:['deck','deliverable','memo','export','presentation','ic memo','investment committee','pdf','slides']}),
  tool('acres_manage_alerts','Manage my email alerts','Create, list, pause, resume or delete the signed-in user\'s email alerts (finished runs and renders, collaborator changes to their sites, new matching deal-store listings), sent to the email on their account, instantly or as a daily digest.',['alerts','market'],{exposure:'direct',cost:'free',aliases:['alerts','notifications','notify me','email me','digest','watch','subscribe']}),

  tool('generateSandboxedUi','Generate an interface','An interactive comparison, calculator, timeline or checklist when it is genuinely clearer than prose.',['presentation'],{exposure:'direct',aliases:['widget','chart','table','calculator','interactive']}),

  // Skills: reusable methods, loaded on demand with acres_load_skill. The
  // creative-zoning index is also attached natively at turn start.
  skill('creative-zoning','Creative zoning research (index)','The overall evidence standards, coverage tiers and capability map for property and zoning research.',['zoning','evidence','property'],'skills/creative-zoning/SKILL.md',['overview','methodology']),
  skill('nyc-statutory-playbooks','NYC statutory and parcel playbooks','NYC development-capacity diagnostics and statutory research leads; load for special districts, transfers, conversions or a consequential NYC entitlement decision.',['zoning','entitlement','property'],'skills/nyc-statutory-playbooks/SKILL.md',['nyc','new york city','statutory','parcel diagnostics','special district','uap','landmark','air rights','conversion']),
  skill('case-law','Case law and decisions','Finding and stating court opinions, BSA and administrative decisions without overstating coverage.',['legal','evidence'],'skills/case-law/SKILL.md',['precedent','article 78','bsa','court','holding','litigation','variance']),
  skill('entitlement-paths','Entitlement paths and creative mechanisms','Generating then falsifying ways a site could build more: transfers, mergers, bonuses, conversions, variances, ELURP and ULURP rezonings.',['entitlement','zoning'],'skills/entitlement-paths/SKILL.md',['air rights','tdr','uap','mih','bonus','ulurp','elurp','landmark','maximize']),
  skill('massing-and-plans','Massing, concepts and test-fit plans','Modeling concepts in 2D/3D and laying out floor plans, and how to report modeled numbers honestly.',['design','zoning'],'skills/massing-and-plans/SKILL.md',['3d','floorplan','layout','egress','ifc','envelope']),
  skill('market-and-proforma','Market inputs, unit mix and pro forma','Recording evidenced market figures, deriving unit mix, running and reporting the pro forma, program comparison and acquisition decision.',['market','finance'],'skills/market-and-proforma/SKILL.md',['underwriting','noi','yield','cap rate','comps','feasibility','acquisition decision','should I buy']),
  skill('keep-building','Keeping the building: hold, renovate, resell','Underwriting a purchase of what stands on the lot rather than building new: where the rents, comparable sales, taxes and renovation budget come from, regulated units, and reporting the three ways to own it.',['finance','market','property'],'skills/keep-building/SKILL.md',['buy and hold','value-add','renovate','flip','rental property','existing building','not develop','without building','cash flow','offer']),
  skill('floor-plans','Finding and drafting floor plans','Where published 2D plans for a building come from, how to judge a candidate, and drafting the project plan from it with the user.',['design','property'],'skills/floor-plans/SKILL.md',['floor plan','floorplan','listing','brochure','offering memorandum','plan editor','trace']),
  skill('non-nyc-research','Research-tier cities outside NYC','Working in a US city without a parcel adapter or curated rules: live official sources, named gaps, no imported NYC rules.',['evidence','zoning'],'skills/non-nyc-research/SKILL.md',['austin','miami','boston','chicago','los angeles','other city','national']),
];

// Tools charged to the run's compute cap: in-process arithmetic ('compute') and
// design concepts ('engine'). The budget and trace analysis both read this set.
export const COMPUTE_TOOL_NAMES=new Set(CAPABILITIES.filter(c=>c.kind==='tool'&&(c.cost==='compute'||c.cost==='engine')).map(c=>c.name));

export const GATEWAY_TOOL_NAMES=['acres_search_capabilities','acres_execute_capability','acres_load_skill','acres_spawn_lanes'];

const byName=new Map(CAPABILITIES.map(c=>[c.name,c]));
export function capability(name){return byName.get(name)||null;}
export function registeredToolNames(){return CAPABILITIES.filter(c=>c.kind==='tool').map(c=>c.name);}
export function registeredSkillNames(){return CAPABILITIES.filter(c=>c.kind==='skill').map(c=>c.name);}
// nyc: whether the run is about New York City (see runInNyc in jurisdiction.mjs).
const isDirect=(entry,nyc)=>entry.exposure==='direct'||(nyc&&entry.exposure==='nyc');
export function directToolNames({nyc=true}={}){return CAPABILITIES.filter(c=>c.kind==='tool'&&isDirect(c,nyc)).map(c=>c.name);}
export function gatewayToolNames({nyc=true}={}){return CAPABILITIES.filter(c=>c.kind==='tool'&&(c.exposure==='gateway'||(!nyc&&c.exposure==='nyc'))).map(c=>c.name);}
export function toolsForTags(tags=[]){
  const wanted=new Set(tags);
  return CAPABILITIES.filter(c=>c.kind==='tool'&&c.tags.some(t=>wanted.has(t))).map(c=>c.name);
}
export function laneDefaultToolNames(){
  // A spawned lane gets direct access to the specialist set its charter needs;
  // by default that is every registered tool except the presentation tool and
  // the meta/gateway tools (lanes never spawn lanes).
  return registeredToolNames().filter(n=>n!=='generateSandboxedUi');
}

const STOP=new Set('a an the what which where when how is are of for to in on at can i my do does this that and or with find about'.split(' '));
function words(text){return [...new Set(String(text||'').toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu)||[])].filter(w=>!STOP.has(w));}

export function searchCapabilities({query,kind,limit=8}={},definitions=new Map(),expansions=null,{nyc=true}={}){
  if(typeof query!=='string'||!query.trim()||query.length>500)throw new Error('Provide a capability search query of 1 to 500 characters.');
  if(kind!==undefined&&!['tool','skill','any'].includes(kind))throw new Error('Capability kind must be tool, skill, or omitted.');
  if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('Capability limit must be between 1 and 20.');
  const defs=definitions||new Map();
  const rawTerms=words(query);
  const lowerQuery=query.toLowerCase();
  const expandedTerms=new Set(rawTerms);
  if(expansions){
    const entries=typeof expansions.entries==='function'?[...expansions.entries()]:Object.entries(expansions);
    for(const [k,v] of entries){
      const key=String(k||'').toLowerCase().trim();
      if(key&&(rawTerms.includes(key)||lowerQuery.includes(key))){
        for(const w of words(String(v||'')))expandedTerms.add(w);
      }
    }
  }
  const terms=[...expandedTerms];
  const scored=[];
  for(const entry of CAPABILITIES){
    if(kind&&kind!=='any'&&entry.kind!==kind)continue;
    const definition=defs.get(entry.name);
    // A caller that passes the run's real definitions gets only capabilities
    // this host actually built (curated zoning, planning sidecar, Places key).
    if(entry.kind==='tool'&&defs.size&&!definition)continue;
    const titleWords=new Set(words(entry.title));
    const aliasList=entry.aliases||[];
    const aliasWords=new Set(words(aliasList.join(' ')));
    const textWords=new Set(words(`${entry.name} ${entry.when} ${definition?.description||''}`));
    let score=0;
    for(const alias of aliasList){
      if(alias.includes(' ')&&lowerQuery.includes(alias.toLowerCase()))score+=5;
    }
    for(const term of terms){
      if(entry.name.toLowerCase().includes(term))score+=6;
      if(entry.tags.includes(term))score+=4;
      if(titleWords.has(term))score+=3;
      if(aliasWords.has(term))score+=3;
      if(textWords.has(term))score+=1;
    }
    if(score>0)scored.push({entry,score,definition});
  }
  scored.sort((a,b)=>b.score-a.score||a.entry.name.localeCompare(b.entry.name));
  return {
    results:scored.slice(0,limit).map(({entry,score,definition})=>({
      kind:entry.kind,name:entry.name,title:entry.title,when:entry.when,tags:entry.tags,exposure:entry.kind==='tool'?(isDirect(entry,nyc)?'direct':'gateway'):entry.exposure,
      jurisdiction:entry.jurisdiction,cost:entry.cost,score,
      ...(entry.kind==='tool'?{description:definition?.description||entry.when,inputSchema:definition?.inputSchema||null,
        how:isDirect(entry,nyc)?'Call it directly by name.':'Run it with acres_execute_capability using this inputSchema.'}
        :{how:'Load the full skill text with acres_load_skill, then follow it as a method, adapting it to the question.'}),
    })),
    note:'Search results describe capabilities that already exist. Pick what fits the question; searching is never a required first step when a direct tool already does the job.',
  };
}

const skillCache=new Map();
export function loadSkill(name){
  const entry=byName.get(name);
  if(!entry||entry.kind!=='skill')throw new Error(`Unknown skill: ${name}. Search skills with acres_search_capabilities.`);
  if(!skillCache.has(name))skillCache.set(name,readFileSync(new URL(`./${entry.file}`,import.meta.url),'utf8'));
  return {name,title:entry.title,text:skillCache.get(name),note:'A skill is a reusable method and evidence standard, not a mandatory sequence. Adapt it to this question and skip parts that do not apply.'};
}

const definition=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});

export const gatewayDefinitions=[
  definition('acres_search_capabilities','Search the Arosa capability registry: native tools, specialist tools, and loadable skills, by what you need to do. Returns when to use each match, its tags, jurisdiction and cost, and (for tools) the exact input schema. Use it to find the right specialist tool or skill for this question instead of guessing; the core evidence and property tools are already direct and need no search.',{query:{type:'string',description:'What you need to do, for example "how much more can this site build" or "floor plans".'},kind:{type:'string',enum:['tool','skill','any'],description:'Restrict to tools or skills. Defaults to both.'},limit:{type:'integer',minimum:1,maximum:20}},['query']),
  definition('acres_execute_capability','Execute a specialist tool found with acres_search_capabilities, using the exact inputSchema it returned. Only registered Arosa specialist tools can run this way; core evidence and property tools are called directly by name.',{name:{type:'string',description:'The tool name from acres_search_capabilities, for example acres_pro_forma.'},arguments:{type:'object',additionalProperties:true,description:'Arguments matching that tool inputSchema.'}},['name','arguments']),
  definition('acres_load_skill','Load the full text of one skill from the registry (found with acres_search_capabilities, kind skill). A skill is a reusable method and evidence standard to adapt to the question, never a mandatory sequence.',{name:{type:'string',description:'Skill name, for example case-law or market-and-proforma.'}},['name']),
  definition('acres_spawn_lanes','Optionally spawn 1 to 4 parallel research lanes, each a separate agent working from a charter you write, all sharing this run citation pool. Use ONLY when independent lines of inquiry could change the answer (for example operative text, contrary authority, and feasibility in parallel) and the decision justifies the cost; never for a simple fact or follow-up. Each lane returns a cited draft with decision-changers and gaps; YOU verify them against the sources and write the final answer. Lanes cannot spawn lanes. At most one spawn call per run.',{reason:{type:'string',description:'One sentence: why parallel work could change this answer.'},lanes:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,required:['title','charter'],properties:{title:{type:'string',description:'Short lane title, for example "Contrary authority".'},charter:{type:'string',description:'What this lane must establish, preferring what evidence, and what it should explicitly try to falsify.'},question:{type:'string',description:'The exact sub-question for this lane. Defaults to the user question.'},tags:{type:'array',items:{type:'string'},description:'Capability tags this lane needs (evidence, property, zoning, legal, market, finance, design, entitlement, context). Defaults to all tools.'},tools:{type:'array',items:{type:'string'},description:'Exact tool names for this lane instead of tags. Use sparingly; defaults to all tools.'}}}}},['lanes']),
];

// Names acres_execute_capability must never run: the meta/gateway surface
// itself, so a gateway call can never recurse or spawn.
export const NON_EXECUTABLE=new Set([...GATEWAY_TOOL_NAMES]);
export function assertExecutable(name){
  if(NON_EXECUTABLE.has(name))throw new Error(`${name} is called directly, not through acres_execute_capability.`);
  const entry=byName.get(name);
  if(!entry||entry.kind!=='tool')throw new Error(`Unknown capability: ${name}. Search with acres_search_capabilities first.`);
  return entry;
}
