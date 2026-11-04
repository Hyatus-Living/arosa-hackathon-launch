import {readFileSync} from 'node:fs';
import {KnowledgeStore,knowledgePath,jurisdictionScope,hash} from './knowledge.mjs';
import {resolveSearchJurisdiction} from './jurisdiction.mjs';

const manifestUrl=new URL('./zoning-facts.json',import.meta.url);
const kinds=['fact','guideline'];
const topics=['residential-bulk','building-envelope','floor-area-exclusions','dwelling-units','definitions','use-districts','development-rights','bonuses','affordable-housing-uap','affordable-housing-mih','tax-incentive-485x','land-use-review','due-diligence'];
const authorities=['zoning_resolution','city_charter','state_statute','agency_rule','agency_guidance','practice'];
const statuses=['verified','needs_confirmation','reviewed'];
const isDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value));

// Additive migration in the existing knowledge database: curated, source-cited zoning facts
// and practitioner guidelines. Facts summarize controlling text; they never replace it.
export function migrateZoningFacts(store) {
  if(store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='zoning_facts_sync'"))return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS zoning_facts (
      id TEXT PRIMARY KEY,
      jurisdiction TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('fact','guideline')),
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      statement TEXT NOT NULL,
      authority TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('verified','needs_confirmation','reviewed')),
      verified_at TEXT NOT NULL,
      source_amended_at TEXT,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      metadata TEXT NOT NULL CHECK(json_valid(metadata))
    );
    CREATE INDEX IF NOT EXISTS zoning_facts_scope ON zoning_facts(jurisdiction,enabled,topic,kind);
    CREATE VIRTUAL TABLE IF NOT EXISTS zoning_facts_fts USING fts5(
      id UNINDEXED,title,statement,questions,keywords,tokenize='porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS zoning_facts_sync(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL,fact_ids TEXT NOT NULL);
  `);
}

function validate(entry) {
  if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('Invalid zoning fact.');
  if(!/^[a-z0-9][a-z0-9-]+$/.test(entry.id))throw new Error('Invalid zoning fact identifier.');
  if(typeof entry.jurisdiction!=='string')throw new Error(`Invalid jurisdiction: ${entry.id}`);
  jurisdictionScope(entry.jurisdiction);
  if(!kinds.includes(entry.kind)||!topics.includes(entry.topic)||!authorities.includes(entry.authority)||!statuses.includes(entry.status))throw new Error(`Invalid zoning fact classification: ${entry.id}`);
  if(['title','statement'].some(key=>typeof entry[key]!=='string'||!entry[key].trim()))throw new Error(`Zoning fact needs a title and statement: ${entry.id}`);
  for(const key of ['qualifiers','misconceptions','districts','questions','keywords']) {
    if(!Array.isArray(entry[key])||entry[key].some(value=>typeof value!=='string'||!value.trim()))throw new Error(`Invalid zoning fact list ${key}: ${entry.id}`);
  }
  if(!Array.isArray(entry.citations))throw new Error(`Missing citations: ${entry.id}`);
  for(const citation of entry.citations) {
    const url=new URL(citation.url);
    if(typeof citation.label!=='string'||!citation.label.trim()||url.protocol!=='https:'||url.username||url.password)throw new Error(`Citations need a label and an HTTPS URL: ${entry.id}`);
  }
  if(entry.kind==='fact'&&(!entry.citations.length||entry.status==='reviewed'||entry.authority==='practice'))throw new Error(`Facts need citations to a controlling source: ${entry.id}`);
  if(entry.kind==='guideline'&&entry.status!=='reviewed')throw new Error(`Guidelines are reviewed, not verified: ${entry.id}`);
  if(!isDate(entry.verifiedAt)||(entry.sourceAmendedAt!==null&&!isDate(entry.sourceAmendedAt)))throw new Error(`Invalid zoning fact dates: ${entry.id}`);
  if(entry.data!==undefined&&(typeof entry.data!=='object'||entry.data===null||Array.isArray(entry.data)))throw new Error(`Zoning fact data must be an object: ${entry.id}`);
  if(entry.enabled!==undefined&&typeof entry.enabled!=='boolean')throw new Error(`Zoning fact enabled must be boolean: ${entry.id}`);
}

export function syncZoningFacts(store,entries) {
  if(!Array.isArray(entries))throw new Error('Zoning facts manifest must be an array.');
  const revision=hash(JSON.stringify(entries)),previous=store.one('SELECT revision,fact_ids FROM zoning_facts_sync WHERE id=1');
  if(previous?.revision===revision)return {changed:false,revision};
  entries.forEach(validate);
  if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new Error('Duplicate zoning fact identifiers.');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for(const entry of entries) {
      const metadata=JSON.stringify(entry),enabled=entry.enabled===false?0:1;
      const existing=store.one('SELECT metadata,enabled FROM zoning_facts WHERE id=?',entry.id);
      if(existing?.metadata===metadata&&existing.enabled===enabled)continue;
      store.write(`INSERT INTO zoning_facts VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        jurisdiction=excluded.jurisdiction,kind=excluded.kind,topic=excluded.topic,title=excluded.title,
        statement=excluded.statement,authority=excluded.authority,status=excluded.status,verified_at=excluded.verified_at,
        source_amended_at=excluded.source_amended_at,enabled=excluded.enabled,metadata=excluded.metadata`,
      entry.id,entry.jurisdiction,entry.kind,entry.topic,entry.title,entry.statement,entry.authority,entry.status,entry.verifiedAt,entry.sourceAmendedAt,enabled,metadata);
      store.write('DELETE FROM zoning_facts_fts WHERE id=?',entry.id);
      store.write('INSERT INTO zoning_facts_fts VALUES(?,?,?,?,?)',entry.id,entry.title,entry.statement,entry.questions.join(' '),
        [...entry.keywords,...entry.districts,entry.topic,...entry.qualifiers,...entry.misconceptions,...entry.citations.map(c=>c.label)].join(' '));
    }
    const ids=JSON.stringify(entries.map(entry=>entry.id));
    if(previous){
      // Retire only facts managed by the prior manifest; unrelated rows stay intact.
      store.write('DELETE FROM zoning_facts_fts WHERE id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))',previous.fact_ids,ids);
      store.write('UPDATE zoning_facts SET enabled=0 WHERE id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))',previous.fact_ids,ids);
    }
    store.write('INSERT INTO zoning_facts_sync VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,fact_ids=excluded.fact_ids',revision,ids);
    store.db.exec('COMMIT');return {changed:true,revision};
  } catch(error) {store.db.exec('ROLLBACK');throw error;}
}

const stop=new Set('a an the what which where when how is are of for to in on at can i my do does this that and or with find about there much many'.split(' '));
export function searchZoningFacts(store,{query,city,topic,kind,district,limit=5},now=Date.now()) {
  if(typeof query!=='string'||!query.trim()||query.length>2000)throw new Error('Zoning facts query must contain 1 to 2000 characters.');
  if(!Number.isInteger(limit)||limit<1||limit>10)throw new Error('Zoning facts limit must be 1 to 10.');
  if(city!==undefined&&typeof city!=='string')throw new Error('Use a jurisdiction identifier such as US-NY-NYC.');
  if(topic!==undefined&&!topics.includes(topic))throw new Error(`Topic must be one of: ${topics.join(', ')}.`);
  if(kind!==undefined&&!kinds.includes(kind))throw new Error('Kind must be fact or guideline.');
  if(district!==undefined&&(typeof district!=='string'||!/^[A-Za-z0-9.-]{1,12}$/.test(district)))throw new Error('District must be a zoning district code such as R7A.');
  const scope=jurisdictionScope(resolveSearchJurisdiction({city,query}));
  const words=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[])].filter(w=>!stop.has(w)).slice(0,32);
  if(!words.length)return {results:[],note:'Use a subject, question, district code or section number.'};
  const filters=[],params=[];
  if(topic){filters.push('f.topic=?');params.push(topic);}
  if(kind){filters.push('f.kind=?');params.push(kind);}
  if(district){filters.push("EXISTS(SELECT 1 FROM json_each(f.metadata,'$.districts') WHERE upper(value)=upper(?))");params.push(district);}
  const rows=store.all(`SELECT f.metadata,bm25(zoning_facts_fts,0,5,2,4,3) AS rank
    FROM zoning_facts_fts JOIN zoning_facts f ON f.id=zoning_facts_fts.id
    WHERE zoning_facts_fts MATCH ? AND f.enabled=1 AND f.jurisdiction IN (${scope.map(()=>'?').join(',')})
    ${filters.map(filter=>`AND ${filter}`).join(' ')}
    ORDER BY rank,f.id LIMIT ?`,words.map(w=>`"${w}"`).join(' OR '),...scope,...params,limit);
  return {results:rows.map(row=>{
    const {enabled,...entry}=JSON.parse(row.metadata);
    return {...entry,reviewDue:now-Date.parse(entry.verifiedAt)>180*86400000};
  }),note:'Curated summaries checked against the cited sources on verifiedAt. Facts marked needs_confirmation and guidelines are not settled law. Before stating a figure for a specific parcel, read the cited section (acres_fetch_url or acres_search_knowledge) and check special districts and later amendments, which control.'};
}

export const zoningFactsDefinitions=[{
  name:'acres_search_zoning_facts',
  description:'Search curated, source-cited zoning and development facts and guidelines by question, district code or section: residential FAR and height tables, envelope rules (setbacks, rear yards, coverage, towers), floor area exclusions, unit counts, use districts, air rights and bonuses, UAP and MIH, 485-x, land use review (ULURP, ELURP, Fast Track) and due-diligence checklists. Each result gives a corrected statement, qualifiers, common misconceptions, structured values, citations and its verification date. Use for orientation and to choose sections to read; cite the underlying source, not this tool.',
  inputSchema:{type:'object',additionalProperties:false,required:['query'],properties:{
    query:{type:'string'},
    city:{type:'string',description:'Optional jurisdiction identifier or city/state name (e.g. US-NY-NYC); inferred from the query or active site when omitted.'},
    topic:{type:'string',enum:topics},
    kind:{type:'string',enum:kinds,description:'fact for rules and figures, guideline for review methods and checklists.'},
    district:{type:'string',description:'Optional exact zoning district code, e.g. R7A or C6.'},
    limit:{type:'integer',minimum:1,maximum:10},
  }},
}];

export function createZoningFactsHandlers({open=()=>new KnowledgeStore(knowledgePath()),entries,getCity=null}={}) {
  return {acres_search_zoning_facts:args=>{
    const store=open();
    try {
      migrateZoningFacts(store);
      syncZoningFacts(store,entries||JSON.parse(readFileSync(manifestUrl,'utf8')));
      const city=args?.city!==undefined?args.city:resolveSearchJurisdiction({query:args?.query,fallbackCity:getCity?.()||null});
      return searchZoningFacts(store,{...args,city});
    } finally {store.close();}
  }};
}
