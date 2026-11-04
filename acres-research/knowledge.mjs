import {DatabaseSync} from 'node:sqlite';
import {throwIfCancelled,abortable} from './execution-context.mjs';
import {extractPdfPages,pdfPageUrl,pdfPageTitle,PDF_EXTRACTOR} from './pdf-pages.mjs';
import {mkdirSync, chmodSync, existsSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {NYC_JURISDICTION, normalizeJurisdictionInput, resolveSearchJurisdiction, inferUrlJurisdiction} from './jurisdiction.mjs';

export const knowledgePath = () => process.env.ACRES_KNOWLEDGE_DB || '/home/openclaw/.openclaw/acres-state/knowledge.sqlite';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function knowledgeFreshness(row,now=Date.now()) {
  const checked=Date.parse(row.last_success);
  return {lastChecked:row.last_success||null,lastAttempted:row.last_checked||null,refreshFailed:Boolean(row.error),
    stale:Boolean(row.error)||!Number.isFinite(checked)||now-checked>48*3600000};
}
export const topics = {
  short_term_rentals:'short-term rentals, vacation rentals, Airbnb and transient occupancy',
  registration:'registration, licenses and filing requirements',
  permitted_uses:'permitted uses, prohibited uses and occupancy classifications',
  development_capacity:'floor area, height, setbacks and development capacity',
  air_rights:'development rights, zoning-lot mergers and transfers',
  variances:'variances, special permits and administrative approvals',
  tenant_protection:'rent regulation, tenant protection and affordable housing',
  land_use_review:'ULURP, rezonings, special permits and City Planning Commission review',
};

export function jurisdictionScope(city) {
  const normalized = normalizeJurisdictionInput(city);
  const parts=normalized.split('-');return parts.map((_,i)=>parts.slice(0,i+1).join('-'));
}

const CITY_DISPLAY_NAMES = {
  NYC: 'New York City', NEWYORK: 'New York City', WESTPALMBEACH: 'West Palm Beach',
  PALMBEACH: 'Palm Beach', FORTLAUDERDALE: 'Fort Lauderdale', BOCARATON: 'Boca Raton',
  MIAMIBEACH: 'Miami Beach', LOSANGELES: 'Los Angeles', SANFRANCISCO: 'San Francisco',
  SANDIEGO: 'San Diego', SANJOSE: 'San Jose', SANTAMONICA: 'Santa Monica',
  BEVERLYHILLS: 'Beverly Hills', SANANTONIO: 'San Antonio', FORTWORTH: 'Fort Worth',
  NEWORLEANS: 'New Orleans', KANSASCITY: 'Kansas City', STLOUIS: 'St. Louis',
  WASHINGTON: 'Washington, DC', LASVEGAS: 'Las Vegas', SALTLAKELCITY: 'Salt Lake City',
  JERSEYCITY: 'Jersey City', NEWHAVEN: 'New Haven', WHITEPLAINS: 'White Plains',
  NEWROCHELLE: 'New Rochelle',
};

export function parseJurisdictionParts(jurisdiction) {
  const norm = normalizeJurisdictionInput(jurisdiction || NYC_JURISDICTION);
  const [country = 'US', state = null, rawCity = null] = norm.split('-');
  const city = rawCity
    ? (CITY_DISPLAY_NAMES[rawCity] || rawCity.charAt(0) + rawCity.slice(1).toLowerCase())
    : null;
  return {country, state, city, jurisdiction: norm};
}

const HEADING_RE=/^(?:#{1,6}\s+\S.*|(?:ZR|Section|Sec\.|§|Article|Chapter|Title|Part|Rule)\s+[0-9A-Za-z§.-]+[^\n]{0,100})$/i;

export function extractSectionSummary(text, maxChars=360) {
  if(!text||typeof text!=='string')return null;
  const out=[],seen=new Set();
  const nonEmpty=text.split('\n').map(l=>l.trim().replace(/\s+/g,' ')).filter(Boolean);
  for(let i=0;i<nonEmpty.length;i++) {
    const line=nonEmpty[i];
    if(line.length>110)continue;
    let candidate=null;
    if(/^\d{1,3}-\d{1,3}[a-z]?$/i.test(line)){
      const next=nonEmpty[i+1]||'';
      if(next&&next.length<=95&&!/^(?:Last Amended|History|Print|Copy|http)/i.test(next)){
        candidate=`${line} ${next}`;
        i+=1;
      }
    } else {
      const cleanLine=line.replace(/^#+\s*/,'');
      if(HEADING_RE.test(line)||/^\d{1,3}-\d{1,3}[a-z]?\s+[A-Z][\w\s,()/-]{2,80}$/.test(cleanLine)){
        candidate=cleanLine;
      }
    }
    if(!candidate)continue;
    const clean=candidate.replace(/\s*Last Amended.*$/i,'').trim();
    const key=clean.toLowerCase();
    if(!clean||seen.has(key))continue;
    seen.add(key);
    out.push(clean);
    if(out.join('; ').length>=maxChars)break;
  }
  if(!out.length){
    const fallback=nonEmpty.filter(l=>l.length>=35&&!/^(?:Last Amended|History|Print|Copy|http)/i.test(l)).slice(0,2).join(' ');
    return fallback?fallback.slice(0,maxChars):null;
  }
  return out.join('; ').slice(0,maxChars)||null;
}

export function chunkText(text, size=3500) {
  const paragraphs=text.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean),chunks=[];
  let current='',activeHeading='';
  for(const paragraph of paragraphs) {
    const firstLine=paragraph.split('\n')[0].trim();
    const isHeading=firstLine.length<=120&&HEADING_RE.test(firstLine);
    if(isHeading)activeHeading=firstLine.replace(/^#+\s*/,'').slice(0,100);
    for(let start=0;start<paragraph.length;start+=size) {
      const part=paragraph.slice(start,start+size);
      if(current.length+part.length+2>size){
        if(current)chunks.push(current);
        const prefix=activeHeading&&!isHeading?`[${activeHeading}]\n\n`:'';
        current=prefix+part;
        continue;
      }
      current+=(current?'\n\n':'')+part;
    }
  }
  if(current)chunks.push(current);return chunks.filter(Boolean);
}

export function chunkSourceText(text,pdfPages) {
  if(!pdfPages)return chunkText(text);
  return pdfPages.flatMap(page=>chunkText(text.slice(page.start,page.end)).map(chunk=>`[PDF page ${page.page} of ${pdfPages.length}]\n\n${chunk}`));
}

const GENERAL_SYNONYMS=[
  [/airbnb|vrbo|vacation rental|short[- ]term rental/i,'short term rental registration host transient occupancy'],
  [/\btdr\b|air rights/i,'development rights transfer zoning lot merger landmark'],
  [/\bflood\b|\bfirm\b|\bpfirm\b|\bresilienc/i,'flood zone flood-resistant construction elevation'],
  [/\bnon-?comply|\bdemolition|\boverbuilt/i,'non-complying buildings reconstruction'],
  [/\bconversion\b|\badaptive reuse\b/i,'residential conversion non-residential buildings'],
  [/\btransit bonus\b|\beasement\b/i,'mass transit station improvements volume easement'],
  [/\bsplit lot\b|\bdistrict boundary/i,'zoning lots divided by district boundaries'],
];

const NYC_SYNONYMS=[
  [/\buap\b|universal affordability/i,'universal affordability preference qualifying affordable housing 23-22 27-111'],
  [/\bmih\b|mandatory inclusionary/i,'mandatory inclusionary housing affordable'],
  [/\bqah\b|qualifying affordable/i,'qualifying affordable housing universal affordability preference'],
  [/\bgtz\b|transit zone/i,'greater transit zone inner transit zone parking'],
  [/\bbsa\b/i,'board of standards and appeals variance 72-21'],
  [/\bulurp\b/i,'uniform land use review procedure 197-c rezoning'],
  [/\btdr\b|air rights/i,'74-79 75-422 12-10'],
  [/\b(?:485-?x|421-?a)\b/i,'affordable neighborhoods tax exemption'],
  [/\bsliver\b/i,'23-738 height limitations narrow buildings sky exposure plane'],
  [/\bflood\b|\bfirm\b|\bpfirm\b|\bresilienc/i,'64-312 64-321 reference plane'],
  [/\bnon-?comply|\bdemolition|\boverbuilt/i,'54-31 54-41 75 percent'],
  [/\bconversion\b|\badaptive reuse\b/i,'15-01 15-11 123-67 143-21'],
  [/\btransit bonus\b|\beasement\b/i,'66-51'],
  [/\bsplit lot\b|\bdistrict boundary/i,'77-11 77-22'],
];

const STOP_WORDS=new Set('the and for with from that this what which when where can could would should does need have has are was were will how while about into my our your their am is it do as at on in of to an be by if or me we us'.split(' '));

// Generic real-estate/zoning boilerplate tokens that appear across nearly all indexed documents.
// Matching ONLY these words without any specific subject token should not pull a source into search results.
const GENERIC_SEARCH_TERMS=new Set([
  'nyc','new','york','city','state','department','office','agency','board','commission',
  'zoning','zone','district','districts','resolution','rule','rules','law','laws','code',
  'section','sections','chapter','article','title','part','appendix',
  'building','buildings','development','property','properties','parcel','parcels','lot','lots','site',
  'area','floor','use','uses','commercial','residential','manufacturing','mixed','general','special',
  'full','including','allowed','allow','permit','permits','permitted','require','required','requirement','requirements',
  'regulation','regulations','provision','provisions','standard','standards','guide','guidance','manual','technical',
  'copy','published','current','final','prospective','options','apply','applies','under','maximum','minimum',
]);

export function extractStatutoryTokens(query) {
  return [...new Set((String(query||'').toLowerCase().match(/\b\d{1,3}-[0-9a-z]{1,4}\b/g)||[]))];
}

function collectExpansionText(query, extraExpansions=null, includeNyc=true) {
  let added='';
  const text=String(query||'');
  for(const [re,expansion] of GENERAL_SYNONYMS)if(re.test(text))added+=` ${expansion}`;
  if(includeNyc){
    for(const [re,expansion] of NYC_SYNONYMS)if(re.test(text))added+=` ${expansion}`;
  }
  if(extraExpansions){
    const lower=text.toLowerCase();
    const entries=typeof extraExpansions.entries==='function'?[...extraExpansions.entries()]:Object.entries(extraExpansions);
    for(const [term,expansion] of entries){
      if(term&&expansion&&lower.includes(String(term).toLowerCase()))added+=` ${expansion}`;
    }
  }
  return added.trim();
}

export function lexicalQuery(query, extraExpansions=null, {includeNyc=true}={}) {
  const base=String(query||'');
  const added=collectExpansionText(base,extraExpansions,includeNyc);
  const text=added?`${base} ${added}`:base;
  const phrases=extractStatutoryTokens(text);
  const words=[...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[])].filter(w=>!STOP_WORDS.has(w)).slice(0,24);
  const clauses=[...phrases.map(p=>`"${p}"`),...words.map(w=>`"${w}"`)];
  return [...new Set(clauses)].slice(0,28).join(' OR ');
}
function similarity(a,b) {
  if(a.length!==b.length)throw new Error('Embedding dimensions do not match.');
  let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return aa&&bb?dot/Math.sqrt(aa*bb):0;
}

const EXPANSION_COLUMNS="id TEXT PRIMARY KEY,term TEXT NOT NULL,expansion TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('account','team','jurisdiction','global')),principal TEXT NOT NULL,account TEXT,team TEXT,jurisdiction TEXT,source_runs TEXT NOT NULL DEFAULT '[]',confidence REAL NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','rejected')),approved_by TEXT,approved_at TEXT,rejected_by TEXT,rejected_at TEXT,updated TEXT NOT NULL,UNIQUE(scope,principal,term,expansion)";
const STAGED_REVIEW_COLUMNS=["cited_runs TEXT NOT NULL DEFAULT '[]'","review_status TEXT NOT NULL DEFAULT 'proposed'",'candidate_text TEXT','candidate_kind TEXT','approved_by TEXT','approved_at TEXT','rejected_by TEXT','rejected_at TEXT'];
// Vectors are immutable for a text hash + embedding space. Share decoded arrays across
// short-lived handles, bounded across all databases, without retaining SQLite connections.
const sharedVectors=new Map(),initializedSchemas=new Map();
let cachedVectorBytes=0;
const VECTOR_CACHE_BYTES=32*1024*1024;
function vectorCache(prefix) {
  return {
    has(key){return sharedVectors.has(`${prefix}:${key}`);},
    get(key){const full=`${prefix}:${key}`,value=sharedVectors.get(full);if(value){sharedVectors.delete(full);sharedVectors.set(full,value);}return value;},
    set(key,value){
      const full=`${prefix}:${key}`,previous=sharedVectors.get(full);
      if(previous)cachedVectorBytes-=previous.length*8;
      sharedVectors.delete(full);
      if(value.length*8>VECTOR_CACHE_BYTES)return;
      const copy=[...value];sharedVectors.set(full,copy);cachedVectorBytes+=copy.length*8;
      while(cachedVectorBytes>VECTOR_CACHE_BYTES||sharedVectors.size>5000){const oldest=sharedVectors.keys().next().value;cachedVectorBytes-=sharedVectors.get(oldest).length*8;sharedVectors.delete(oldest);}
    },
  };
}

export class KnowledgeStore {
  constructor(path,{readOnly=false}={}) {
    if(!readOnly)mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path,{readOnly});
    const file=statSync(path,{bigint:true}),identity=`${file.dev}:${file.ino}:${file.birthtimeNs}`;
    this.vectorCache=vectorCache(identity);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if(readOnly)return;
    if(initializedSchemas.get(identity)===this.one('PRAGMA schema_version').schema_version)return;
    chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,url TEXT NOT NULL,metadata TEXT NOT NULL,current_version TEXT,last_checked TEXT,last_success TEXT,error TEXT,etag TEXT,modified TEXT,active INTEGER NOT NULL DEFAULT 1,country TEXT,state TEXT,city TEXT,jurisdiction TEXT,section_summary TEXT);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES sources(id),raw_hash TEXT NOT NULL,raw BLOB NOT NULL,text TEXT NOT NULL,metadata TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,version TEXT NOT NULL REFERENCES versions(id),ordinal INTEGER NOT NULL,text TEXT NOT NULL,text_hash TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS vectors(text_hash TEXT NOT NULL,space TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(text_hash,space));
      CREATE TABLE IF NOT EXISTS ingestion_runs(id TEXT PRIMARY KEY,started TEXT NOT NULL,finished TEXT,status TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh_requests(source TEXT PRIMARY KEY REFERENCES sources(id),requested TEXT NOT NULL,completed TEXT);
      CREATE TABLE IF NOT EXISTS retrievals(id TEXT PRIMARY KEY,created TEXT NOT NULL,query TEXT NOT NULL,trace TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learned_expansions(${EXPANSION_COLUMNS});
      CREATE TABLE IF NOT EXISTS staged_sources(url TEXT PRIMARY KEY,title TEXT NOT NULL,jurisdiction TEXT NOT NULL,host TEXT NOT NULL,authority REAL NOT NULL,times_cited INTEGER NOT NULL DEFAULT 1,sample_run TEXT,status TEXT NOT NULL DEFAULT 'staged',updated TEXT NOT NULL,${STAGED_REVIEW_COLUMNS.join(',')});
      CREATE INDEX IF NOT EXISTS chunk_version ON chunks(version);
      CREATE INDEX IF NOT EXISTS version_source ON versions(source,observed_at);`);
    const cols=new Set(this.all('PRAGMA table_info(sources)').map(column=>column.name));
    if(!cols.has('active'))this.db.exec('ALTER TABLE sources ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
    for(const col of ['country','state','city','jurisdiction','section_summary']){
      if(!cols.has(col))this.db.exec(`ALTER TABLE sources ADD COLUMN ${col} TEXT`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS sources_geo_idx ON sources(active,country,state,jurisdiction)');
    this.db.exec(`CREATE INDEX IF NOT EXISTS sources_url_active ON sources(url,active);
      CREATE INDEX IF NOT EXISTS version_jurisdiction ON versions(json_extract(metadata,'$.jurisdiction'),source,observed_at);
      CREATE INDEX IF NOT EXISTS retrieval_created ON retrievals(created);`);
    this.migrateDreamReview();
    initializedSchemas.set(identity,this.one('PRAGMA schema_version').schema_version);
    if(initializedSchemas.size>32)initializedSchemas.delete(initializedSchemas.keys().next().value);
  }
  // Learned expansions and staged-source promotions are gated on review. Rows written before the
  // gate existed were already live, so they are approved once by 'migration'.
  migrateDreamReview(now=new Date().toISOString()){
    const expansionCols=new Set(this.all('PRAGMA table_info(learned_expansions)').map(c=>c.name));
    if(!expansionCols.has('status')){
      this.db.exec('BEGIN');
      try{
        this.db.exec(`CREATE TABLE learned_expansions_reviewed(${EXPANSION_COLUMNS})`);
        this.write(`INSERT INTO learned_expansions_reviewed(id,term,expansion,scope,principal,source_runs,confidence,status,approved_by,approved_at,updated)
          SELECT lower(hex(randomblob(16))),term,expansion,'global','global',CASE WHEN source_run IS NULL THEN '[]' ELSE json_array(source_run) END,confidence,'approved','migration',?,updated FROM learned_expansions`,now);
        this.db.exec('DROP TABLE learned_expansions; ALTER TABLE learned_expansions_reviewed RENAME TO learned_expansions; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    const stagedCols=new Set(this.all('PRAGMA table_info(staged_sources)').map(c=>c.name));
    if(!stagedCols.has('review_status')){
      this.db.exec('BEGIN');
      try{
        for(const col of STAGED_REVIEW_COLUMNS)this.db.exec(`ALTER TABLE staged_sources ADD COLUMN ${col}`);
        this.write(`UPDATE staged_sources SET review_status='approved',approved_by='migration',approved_at=?,
          cited_runs=CASE WHEN sample_run IS NULL THEN '[]' ELSE json_array(sample_run) END`,now);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
  }
  one(sql,...args){return this.db.prepare(sql).get(...args);}
  all(sql,...args){return this.db.prepare(sql).all(...args);}
  write(sql,...args){return this.db.prepare(sql).run(...args);}
  close(){this.db.close();}
  register(source) {
    jurisdictionScope(source.jurisdiction);
    const geo=parseJurisdictionParts(source.jurisdiction);
    const enriched={...source,country:source.country||geo.country,state:source.state||geo.state,city:source.city||geo.city,jurisdiction:geo.jurisdiction};
    this.write(`INSERT INTO sources(id,url,metadata,country,state,city,jurisdiction) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET url=excluded.url,metadata=excluded.metadata,country=excluded.country,state=excluded.state,city=excluded.city,jurisdiction=excluded.jurisdiction,active=1`,
      source.id,source.url,JSON.stringify(enriched),enriched.country,enriched.state,enriched.city,enriched.jurisdiction);
  }
  source(id){return this.one('SELECT * FROM sources WHERE id=?',id);}
  acquire(owner,now=Date.now()) {
    return this.write('INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE lease.expires<?',owner,now+30*60*1000,now).changes===1;
  }
  release(owner){this.write('DELETE FROM lease WHERE owner=?',owner);}
  beginRun(id,now){this.write('INSERT INTO ingestion_runs VALUES(?,?,NULL,?,NULL)',id,now,'running');}
  finishRun(id,result){this.write('UPDATE ingestion_runs SET finished=?,status=?,result=? WHERE id=?',new Date().toISOString(),result.failed?'partial':'completed',JSON.stringify(result),id);}
  checked(id,now,{etag=null,modified=null}={}) {
    this.write('UPDATE sources SET last_checked=?,last_success=?,error=NULL,etag=COALESCE(?,etag),modified=COALESCE(?,modified) WHERE id=?',now,now,etag,modified,id);
  }
  failed(id,now,error){this.write('UPDATE sources SET last_checked=?,error=? WHERE id=?',now,error,id);}
  vector(textHash,space){
    const key=`${space}:${textHash}`;
    if(this.vectorCache.has(key))return this.vectorCache.get(key);
    const row=this.one('SELECT vector FROM vectors WHERE text_hash=? AND space=?',textHash,space);
    if(!row)return null;
    const parsed=JSON.parse(row.vector);
    this.vectorCache.set(key,parsed);
    return parsed;
  }
  vectorsForHashes(hashes,space){
    const unique=[...new Set(hashes)],out=new Map(),missing=[];
    for(const h of unique){
      const key=`${space}:${h}`;
      if(this.vectorCache.has(key))out.set(h,this.vectorCache.get(key));
      else missing.push(h);
    }
    for(let i=0;i<missing.length;i+=200){
      const batch=missing.slice(i,i+200);
      const rows=this.all(`SELECT text_hash,vector FROM vectors WHERE space=? AND text_hash IN (${batch.map(()=>'?').join(',')})`,space,...batch);
      for(const r of rows){
        const parsed=JSON.parse(r.vector);
        this.vectorCache.set(`${space}:${r.text_hash}`,parsed);
        out.set(r.text_hash,parsed);
      }
    }
    return out;
  }
  // Inserts a proposed expansion, or adds new run evidence to an existing one without touching its
  // review status. Replaying a run already in the evidence changes nothing.
  addExpansion(term,expansion,options={}){
    const opts=typeof options==='string'?{sourceRun:options}:(options||{});
    const {sourceRun=null,confidence=1,scope='global',account=null,team=null,jurisdiction=null,now=new Date().toISOString()}=opts;
    const cleanTerm=String(term||'').trim().toLowerCase(),cleanExpansion=String(expansion||'').trim();
    if(!cleanTerm||cleanTerm.length>80||!cleanExpansion||cleanExpansion.length>400)throw new Error('Invalid query expansion.');
    const principal={global:'global',account,team,jurisdiction}[scope];
    if(!principal)throw new Error(`Expansion scope ${scope} needs its ${scope} principal.`);
    const existing=this.one('SELECT * FROM learned_expansions WHERE scope=? AND principal=? AND term=? AND expansion=?',scope,principal,cleanTerm,cleanExpansion);
    if(existing){
      const runs=JSON.parse(existing.source_runs);
      if(!sourceRun||runs.includes(sourceRun))return {...existing,created:false,changed:false};
      this.write('UPDATE learned_expansions SET source_runs=?,confidence=MAX(confidence,?),updated=? WHERE id=?',JSON.stringify([...runs,sourceRun]),confidence,now,existing.id);
      return {...this.expansion(existing.id),created:false,changed:true};
    }
    const id=randomUUID();
    this.write(`INSERT INTO learned_expansions(id,term,expansion,scope,principal,account,team,jurisdiction,source_runs,confidence,status,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,'proposed',?)`,
      id,cleanTerm,cleanExpansion,scope,principal,account,team,jurisdiction,JSON.stringify(sourceRun?[sourceRun]:[]),confidence,now);
    return {...this.expansion(id),created:true,changed:true};
  }
  expansion(id){return this.one('SELECT * FROM learned_expansions WHERE id=?',id);}
  listExpansions({status=null}={}){
    return this.all('SELECT * FROM learned_expansions WHERE (? IS NULL OR status=?) ORDER BY updated DESC',status,status);
  }
  // Approving with scope 'global' is the only way an expansion reaches other accounts.
  reviewExpansion(id,{decision,by,scope=null,now=new Date().toISOString()}={}){
    if(!this.expansion(id))throw new Error(`Expansion not found: ${id}`);
    if(decision==='approved'){
      if(scope==='global')this.write("UPDATE learned_expansions SET scope='global',principal='global',account=NULL,team=NULL WHERE id=?",id);
      this.write("UPDATE learned_expansions SET status='approved',approved_by=?,approved_at=? WHERE id=?",by,now,id);
    }else{
      this.write("UPDATE learned_expansions SET status='rejected',rejected_by=?,rejected_at=? WHERE id=?",by,now,id);
    }
    return this.expansion(id);
  }
  // Approved expansions that apply to the caller: global ones, plus account, team and jurisdiction
  // ones whose principal matches. Jurisdiction rows bound to an originating account stay with it.
  expansionsMap({account=null,teams=[],jurisdictions=[]}={}){
    const rows=this.all(`SELECT term,expansion FROM learned_expansions WHERE status='approved' AND confidence>=0.5 AND (
        scope='global'
        OR (scope='account' AND principal=?)
        OR (scope='team' AND principal IN (SELECT value FROM json_each(?)))
        OR (scope='jurisdiction' AND principal IN (SELECT value FROM json_each(?)) AND (account IS NULL OR account=?)))
      ORDER BY confidence DESC,updated DESC`,account,JSON.stringify(teams),JSON.stringify(jurisdictions),account);
    const map=new Map();
    for(const r of rows)map.set(r.term,map.has(r.term)?`${map.get(r.term)} ${r.expansion}`:r.expansion);
    return map;
  }
  // Records one citation per run (replays do not inflate the count) and keeps the latest full text
  // as the promotion candidate. Promotion itself needs review approval.
  stageOfficialSource({url,title,jurisdiction,city,authority=0.9,sampleRun=null,sourceRun=null,text=null,kind=null,now=new Date().toISOString()}={}){
    const urlJur=inferUrlJurisdiction(url);
    const rawInput=jurisdiction||city||urlJur||NYC_JURISDICTION;
    const normJur=normalizeJurisdictionInput(String(rawInput));
    jurisdictionScope(normJur);
    const parsed=new URL(url);
    if(parsed.protocol!=='https:')throw new Error('Staged source must use HTTPS.');
    const runRef=sampleRun||sourceRun||null;
    const candidate=typeof text==='string'&&text.trim().length>=200?text.trim():null;
    const existing=this.one('SELECT * FROM staged_sources WHERE url=?',url);
    if(!existing){
      this.write(`INSERT INTO staged_sources(url,title,jurisdiction,host,authority,times_cited,sample_run,status,updated,cited_runs,candidate_text,candidate_kind)
        VALUES(?,?,?,?,?,1,?,'staged',?,?,?,?)`,
        url,title||url,normJur,parsed.hostname.toLowerCase(),authority,runRef,now,JSON.stringify(runRef?[runRef]:[]),candidate,candidate?kind:null);
      return {...this.one('SELECT * FROM staged_sources WHERE url=?',url),newCitation:true};
    }
    const runs=JSON.parse(existing.cited_runs);
    const newCitation=!runRef||!runs.includes(runRef);
    if(!newCitation)return {...existing,newCitation};
    this.write(`UPDATE staged_sources SET title=?,jurisdiction=?,times_cited=times_cited+1,sample_run=COALESCE(?,sample_run),cited_runs=?,
        candidate_text=COALESCE(?,candidate_text),candidate_kind=CASE WHEN ? IS NULL THEN candidate_kind ELSE ? END,updated=? WHERE url=?`,
      title||existing.title,existing.jurisdiction===NYC_JURISDICTION&&normJur!==NYC_JURISDICTION?normJur:existing.jurisdiction,
      runRef,JSON.stringify(runRef?[...runs,runRef]:runs),candidate,candidate,kind,now,url);
    return {...this.one('SELECT * FROM staged_sources WHERE url=?',url),newCitation};
  }
  promoteStagedSource(url,{text,raw=null,topics:sourceTopics=['zoning'],kind,vectors=[],space='none',now=new Date().toISOString()}={}){
    const row=this.one('SELECT * FROM staged_sources WHERE url=?',url);
    if(!row)throw new Error('Staged source not found.');
    if(row.review_status!=='approved')throw new Error('Staged source has not been approved for promotion.');
    const cleanText=String(text??row.candidate_text??'').trim();
    if(cleanText.length<200)throw new Error('Promoted source text must be at least 200 characters.');
    const source={
      id:`staged-${hash(url).slice(0,12)}`,
      title:row.title||url,
      url:row.url,
      jurisdiction:row.jurisdiction||inferUrlJurisdiction(row.url)||NYC_JURISDICTION,
      topics:sourceTopics.filter(t=>Object.hasOwn(topics,t)),
      authority:'agency_guidance',
      kind:kind||row.candidate_kind||'official-reference',
    };
    if(!source.topics.length)source.topics=['zoning'];
    this.register(source);
    const published=this.publish(source,raw||Buffer.from(cleanText),cleanText,source,vectors,space,now);
    this.write("UPDATE staged_sources SET status='promoted',updated=? WHERE url=?",now,url);
    return {sourceId:source.id,url:row.url,status:'promoted',...published};
  }
  // Approval promotes at once when full text is on hand; otherwise the next qualifying citation does.
  reviewStagedSource(url,{decision,by,now=new Date().toISOString()}={}){
    const row=this.one('SELECT * FROM staged_sources WHERE url=?',url);
    if(!row)throw new Error(`Staged source not found: ${url}`);
    if(decision==='approved'){
      this.write("UPDATE staged_sources SET review_status='approved',approved_by=?,approved_at=? WHERE url=?",by,now,url);
      if(row.status==='staged'&&row.candidate_text)this.promoteStagedSource(url,{now});
    }else{
      this.write("UPDATE staged_sources SET review_status='rejected',rejected_by=?,rejected_at=? WHERE url=?",by,now,url);
    }
    return this.one('SELECT * FROM staged_sources WHERE url=?',url);
  }
  stagedSources(filter=1){
    if(typeof filter==='string'){
      return this.all('SELECT * FROM staged_sources WHERE status=? ORDER BY times_cited DESC,authority DESC',filter);
    }
    return this.all('SELECT * FROM staged_sources WHERE times_cited>=? ORDER BY times_cited DESC,authority DESC',filter);
  }
  publish(source,raw,text,metadata,vectors,space,now,headers={}) {
    const rawHash=hash(raw),id=hash(`${source.id}:${rawHash}:${hash(JSON.stringify(metadata))}:extract-v1`),chunks=chunkSourceText(text,metadata.pdfPages);
    const sectionSummary=extractSectionSummary(text),committedVectors=[];
    // Inside a caller's transaction (the dream cycle's savepoint), nest with a savepoint.
    const nested=this.db.isTransaction;
    this.db.exec(nested?'SAVEPOINT publish':'BEGIN IMMEDIATE');
    try {
      this.write('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?,?)',id,source.id,rawHash,raw,text,JSON.stringify(metadata),now);
      chunks.forEach((content,index)=>{
        const chunkId=`${id}:${index}`,textHash=hash(content);
        const inserted=this.write('INSERT OR IGNORE INTO chunks VALUES(?,?,?,?,?)',chunkId,id,index,content,textHash).changes;
        if(inserted)this.write('INSERT INTO chunk_fts VALUES(?,?)',chunkId,content);
        if(vectors[index]){
          const insertedVector=this.write('INSERT OR IGNORE INTO vectors VALUES(?,?,?)',textHash,space,JSON.stringify(vectors[index])).changes;
          if(insertedVector)committedVectors.push([`${space}:${textHash}`,vectors[index]]);
        }
      });
      this.write('UPDATE sources SET current_version=?,section_summary=COALESCE(?,section_summary) WHERE id=?',id,sectionSummary,source.id);
      this.checked(source.id,now,headers);
      this.write('UPDATE refresh_requests SET completed=? WHERE source=?',now,source.id);
      this.db.exec(nested?'RELEASE publish':'COMMIT');
      for(const [key,vector] of committedVectors)this.vectorCache.set(key,vector);
      return {versionId:id,chunks:chunks.length};
    } catch(error){this.db.exec(nested?'ROLLBACK TO publish; RELEASE publish':'ROLLBACK');throw error;}
  }
  syncIndexMetadata() {
    const missing=this.all(`SELECT s.id,s.metadata,s.country,s.state,s.city,s.jurisdiction,s.section_summary,v.text
      FROM sources s LEFT JOIN versions v ON v.id=s.current_version
      WHERE s.active=1 AND (s.country IS NULL OR s.state IS NULL OR s.jurisdiction IS NULL OR s.section_summary IS NULL)`);
    if(!missing.length)return 0;
    for(const row of missing){
      const meta=JSON.parse(row.metadata||'{}');
      const geo=parseJurisdictionParts(row.jurisdiction||meta.jurisdiction);
      const summary=row.section_summary||extractSectionSummary(row.text||'');
      const enriched={...meta,country:meta.country||geo.country,state:meta.state||geo.state,city:meta.city||geo.city,jurisdiction:geo.jurisdiction};
      this.write('UPDATE sources SET metadata=?,country=?,state=?,city=?,jurisdiction=?,section_summary=? WHERE id=?',
        JSON.stringify(enriched),enriched.country,enriched.state,enriched.city,enriched.jurisdiction,summary,row.id);
    }
    return missing.length;
  }
  indexCatalog({query='',hintJurisdiction=null,limit=60}={}) {
    this.syncIndexMetadata();
    const rows=this.all(`SELECT id,url,metadata,country,state,city,jurisdiction,section_summary
      FROM sources WHERE active=1 AND current_version IS NOT NULL`);
    const items=rows.map(r=>{
      const meta=JSON.parse(r.metadata||'{}');
      const geo=parseJurisdictionParts(r.jurisdiction||meta.jurisdiction);
      return {
        id:r.id,
        title:meta.title||r.id,
        url:r.url,
        country:r.country||meta.country||geo.country,
        state:r.state||meta.state||geo.state,
        city:r.city||meta.city||geo.city,
        jurisdiction:r.jurisdiction||meta.jurisdiction||geo.jurisdiction,
        topics:meta.topics||[],
        kind:meta.kind||'zoning_text',
        authority:meta.authority||'statute',
        coverageNote:meta.coverageNote||null,
        sectionSummary:r.section_summary||null,
      };
    });
    if(items.length<=limit)return items;
    const hintParts=hintJurisdiction?parseJurisdictionParts(hintJurisdiction):null;
    const qWords=[...new Set(String(query||'').toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu)||[])].filter(w=>!STOP_WORDS.has(w));
    return items
      .map(item=>{
        let preScore=0;
        if(hintParts){
          if(item.jurisdiction===hintParts.jurisdiction)preScore+=5;
          else if(item.state===hintParts.state)preScore+=2;
        }
        const hay=`${item.id} ${item.title} ${item.coverageNote||''} ${item.sectionSummary||''} ${item.topics.join(' ')}`.toLowerCase();
        for(const w of qWords){if(hay.includes(w))preScore+=1;}
        return {item,preScore};
      })
      .sort((a,b)=>b.preScore-a.preScore)
      .slice(0,limit)
      .map(x=>x.item);
  }
  requestRefresh(source) {
    if(!this.source(source)?.active)throw new Error('Choose an existing knowledge source identifier.');
    const recent=this.one('SELECT requested,completed FROM refresh_requests WHERE source=?',source);
    if(recent&&(!recent.completed||Date.now()-Date.parse(recent.requested)<3600000))return {source,status:recent.completed?'recently_refreshed':'queued'};
    this.write('INSERT INTO refresh_requests VALUES(?,?,NULL) ON CONFLICT(source) DO UPDATE SET requested=excluded.requested,completed=NULL',source,new Date().toISOString());
    return {source,status:'queued'};
  }
  status() {
    return {sources:this.all('SELECT id,url,country,state,city,jurisdiction,section_summary,current_version,last_success,error,active FROM sources'),latestRun:this.one('SELECT * FROM ingestion_runs ORDER BY started DESC LIMIT 1')||null};
  }
  findByUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const hashSection = parsed.hash.replace(/^#/, '').match(/^\d{2,3}-\d{2,3}[a-z]?$/i)?.[0] || null;
      parsed.hash = '';
      if (parsed.pathname.length > 1) parsed.pathname.replace(/\/+$/, '');
      const cleanPathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
      const basePaths = [cleanPathname];
      if (hashSection && !cleanPathname.endsWith(`/${hashSection}`)) {
        basePaths.unshift(`${cleanPathname}/${hashSection}`);
      }
      const chapterPrefix = cleanPathname.match(/^(\/article-[a-z0-9-]+\/chapter-[a-z0-9-]+)\/\d{2,3}-\d{2,3}[a-z]?$/i)?.[1];
      if (chapterPrefix) basePaths.push(chapterPrefix);

      const isZrHost = parsed.hostname === 'zr.planning.nyc.gov' || parsed.hostname === 'zoningresolution.planning.nyc.gov';
      const hostsToTry = isZrHost ? ['zoningresolution.planning.nyc.gov', 'zr.planning.nyc.gov'] : [parsed.hostname];

      for (const pathCandidate of basePaths) {
        const candidates = hostsToTry.map(h => `https://${h}${pathCandidate}${parsed.search}`);
        const row = this.one(
          `SELECT s.id AS sourceId, s.url,s.last_success,s.last_checked,s.error, v.id AS versionId, v.text, v.metadata, v.observed_at,substr(v.raw,1,4) AS signature
           FROM sources s JOIN versions v ON v.id = s.current_version
           WHERE s.active = 1 AND s.url IN (${candidates.map(() => '?').join(',')})
           LIMIT 1`,
          ...candidates
        );
        if (row && row.text) {
          const meta = JSON.parse(row.metadata || '{}');
          let document={text:row.text,pdfPages:meta.pdfPages};
          if(!document.pdfPages&&Buffer.from(row.signature).toString()==='%PDF')document=extractPdfPages(Buffer.from(this.one('SELECT raw FROM versions WHERE id=?',row.versionId).raw));
          return {
            sourceId: row.sourceId,
            versionId: row.versionId,
            url: row.url,
            title: meta.title || row.url,
            text: document.text,
            ...(document.pdfPages?{pdfPages:document.pdfPages}:{}),
            publishedAt: meta.publishedAt || null,
            observedAt: row.observed_at || null,
            ...knowledgeFreshness(row),
            effectiveFrom:meta.effectiveFrom||null,effectiveTo:meta.effectiveTo||null,
            kind: meta.kind || 'zoning_text',
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  async search({query,city,topic,asOf,limit=8,sourceIds=null,sourceScores=null,recordRetrieval=true},embedder,jevRouter=null) {
    if(typeof query!=='string'||!query.trim()||query.length>2000)throw new Error('Provide a search query of 1 to 2,000 characters.');
    if(!Number.isInteger(limit)||limit<1||limit>15)throw new Error('Use a limit between 1 and 15.');
    if(topic!==undefined&&(typeof topic!=='string'||!topic.trim()||topic.length>100))throw new Error('Unknown topic.');
    if(sourceIds!==null&&(!Array.isArray(sourceIds)||sourceIds.length>100||sourceIds.some(id=>typeof id!=='string'||!id)))throw new Error('Use a bounded list of released source identifiers.');
    if(asOf&&(!/^\d{4}-\d{2}-\d{2}$/.test(asOf)||Number.isNaN(Date.parse(asOf))||new Date(asOf).toISOString().slice(0,10)!==asOf))throw new Error('Use an as-of date in YYYY-MM-DD format.');

    const started=performance.now(),id=randomUUID();
    let resolvedCity=resolveSearchJurisdiction({city,query});

    let effectiveSourceIds=sourceIds;
    let effectiveSourceScores=sourceScores;
    let jevRoute=null;
    if(jevRouter&&typeof jevRouter.route==='function'&&sourceIds===null){
      const catalog=this.indexCatalog({query,hintJurisdiction:resolvedCity,limit:60});
      if(catalog.length){
        jevRoute=await abortable(jevRouter.route({query,city:city||resolvedCity,catalog}));
        throwIfCancelled();
        if(jevRoute){
          effectiveSourceIds=jevRoute.selectedSourceIds;
          effectiveSourceScores=jevRoute.sourceScores||null;
          if(!city&&effectiveSourceIds.length){
            const topSource=catalog.find(c=>c.id===effectiveSourceIds[0]);
            if(topSource?.jurisdiction)resolvedCity=topSource.jurisdiction;
          }
        }
      }
    }

    const scope=jurisdictionScope(resolvedCity);
    const includeNyc=scope.includes(NYC_JURISDICTION);

    if(Array.isArray(effectiveSourceIds)&&effectiveSourceIds.length===0){
      const trace={
        city:resolvedCity,scope,topic:topic||null,asOf:asOf||null,mode:'jev-filtered',embeddingError:null,
        candidateChunks:0,durationMs:Math.round(performance.now()-started),
        jevRoute:jevRoute?{hasDirectIndexedMatch:jevRoute.hasDirectIndexedMatch,needsWebFanout:jevRoute.needsWebFanout,selectedSourceIds:[],directPullSourceIds:[]}:null,
        results:[],
      };
      if(recordRetrieval){
        throwIfCancelled();
        this.write('INSERT INTO retrievals VALUES(?,?,?,?)',id,new Date().toISOString(),query,JSON.stringify(trace));
      }
      return {
        traceId:id,...trace,results:[],
        note:'Jev index router determined no released sources in the knowledge index match this query or jurisdiction.',
      };
    }

    // Filter before computing exact similarities. Known effective ranges are required for historical questions.
    const effectiveDate=asOf||new Date().toISOString().slice(0,10);
    const eligible=this.all(`SELECT v.id AS version,v.source,v.metadata,v.observed_at,s.url,s.last_success,s.last_checked,s.error FROM versions v JOIN sources s ON s.id=v.source
      WHERE s.active=1 AND json_extract(v.metadata,'$.jurisdiction') IN (${scope.map(()=>'?').join(',')})
      AND ((? IS NULL AND s.current_version=v.id AND json_extract(v.metadata,'$.effectiveFrom') IS NULL) OR (json_extract(v.metadata,'$.effectiveFrom')<=? AND (json_extract(v.metadata,'$.effectiveTo') IS NULL OR json_extract(v.metadata,'$.effectiveTo')>?)))
      ${effectiveSourceIds===null?'':effectiveSourceIds.length?`AND s.id IN (${effectiveSourceIds.map(()=>'?').join(',')})`:'AND 0'}`, ...scope,asOf||null,effectiveDate,effectiveDate,...(effectiveSourceIds||[]));
    const newest=new Map();
    for(const row of eligible){const previous=newest.get(row.source);if(!previous||row.observed_at>previous.observed_at)newest.set(row.source,row);}
    const versions=new Map([...newest.values()].map(row=>[row.version,{...row,metadata:JSON.parse(row.metadata)}]));
    const versionIds=JSON.stringify([...versions.keys()]);
    const rows=this.all('SELECT id,version,ordinal,text_hash FROM chunks WHERE version IN (SELECT value FROM json_each(?)) ORDER BY rowid',versionIds)
      .map(row=>({...versions.get(row.version),...row}));
    const byId=new Map(rows.map(r=>[r.id,r])),expansions=this.expansionsMap({jurisdictions:scope});
    const fts=lexicalQuery(query,expansions,{includeNyc});
    const lexical=fts&&rows.length?this.all(`SELECT chunk_fts.id,bm25(chunk_fts) AS rank FROM chunk_fts
      JOIN chunks c ON c.id=chunk_fts.id WHERE chunk_fts MATCH ? AND c.version IN (SELECT value FROM json_each(?)) ORDER BY rank`,fts,versionIds):[];

    // Separate distinctive subject tokens from generic zoning/real-estate boilerplate.
    const rawWords=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[])].filter(w=>!STOP_WORDS.has(w));
    const distinctiveWords=rawWords.filter(w=>!GENERIC_SEARCH_TERMS.has(w));
    const specificWords=distinctiveWords.length?distinctiveWords:rawWords;
    const expansionText=collectExpansionText(query,expansions,includeNyc);
    const expansionWords=[...new Set(expansionText.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[])].filter(w=>!STOP_WORDS.has(w)&&!GENERIC_SEARCH_TERMS.has(w));
    const statutoryTokens=extractStatutoryTokens(`${query} ${expansionText}`);

    let semantic=[],mode='lexical',embeddingError=null,isHighDim=false;
    const simById=new Map();
    if(embedder&&rows.length){
      try {
        const [vector]=await abortable(embedder.embed([query]));
        throwIfCancelled();
        isHighDim=Array.isArray(vector)&&vector.length>16;
        const minSim=isHighDim?0.30:0.05;
        const storedByHash=this.vectorsForHashes(rows.map(r=>r.text_hash),embedder.space);
        semantic=rows.flatMap(row=>{
          const stored=storedByHash.get(row.text_hash);
          if(!stored)return [];
          const sim=similarity(vector,stored);
          simById.set(row.id,sim);
          return sim>minSim?[{id:row.id,rank:sim}]:[];
        }).sort((a,b)=>b.rank-a.rank);
        if(semantic.length)mode='hybrid';
      } catch {throwIfCancelled();embeddingError='Semantic search unavailable; keyword results only.';}
    }

    const scores=new Map();
    for(const [ranking,weight] of [[lexical,semantic.length?0.35:1],[semantic,0.65]]){
      ranking.slice(0,120).forEach((r,i)=>scores.set(r.id,(scores.get(r.id)||0)+weight/(60+i+1)));
    }
    // Also ensure chunks whose source metadata directly matches statutory tokens, distinctive subject terms, or Jev-selected sources are evaluated.
    for(const row of rows){
      if(scores.has(row.id))continue;
      const meta=row.metadata;
      const header=`${row.source} ${meta.title||''} ${meta.coverageNote||''} ${row.url||''}`.toLowerCase();
      const jevScore=effectiveSourceScores&&typeof effectiveSourceScores[row.source]==='number'?effectiveSourceScores[row.source]:0;
      if(jevScore>=0.65||statutoryTokens.some(tok=>header.includes(tok))||distinctiveWords.some(w=>header.includes(w))){
        scores.set(row.id,0.002);
      }
    }

    // Text is only needed for the exact ranking candidates. No eligible semantic
    // peer or metadata match is dropped to save work.
    const texts=new Map(this.all('SELECT id,text FROM chunks WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify([...scores.keys()])).map(row=>[row.id,row.text]));
    const ranked=[];
    for(const [key,baseScore] of scores){
      const row=byId.get(key),meta=row.metadata;
      const sourceHeader=`${row.source} ${meta.title||''} ${meta.coverageNote||''} ${(meta.topics||[]).join(' ')} ${row.url||''}`.toLowerCase();
      const text=texts.get(key),chunkLower=text.toLowerCase();
      const combinedLower=`${sourceHeader} ${chunkLower}`;

      const matchedSpecific=specificWords.filter(w=>combinedLower.includes(w)).length;
      const matchedSourceSpecific=specificWords.filter(w=>sourceHeader.includes(w)).length;
      const matchedExpansion=expansionWords.some(w=>combinedLower.includes(w));
      const statutoryInSource=statutoryTokens.some(tok=>sourceHeader.includes(tok));
      const statutoryInChunk=statutoryTokens.some(tok=>chunkLower.includes(tok));
      const sim=simById.get(key)||0;
      const jevScore=effectiveSourceScores&&typeof effectiveSourceScores[row.source]==='number'?effectiveSourceScores[row.source]:null;

      const hasSubjectMatch=matchedSpecific>0||matchedExpansion||statutoryInSource||statutoryInChunk||(jevScore!==null&&jevScore>=0.70);

      const specificRatio=distinctiveWords.length?matchedSpecific/distinctiveWords.length:(specificWords.length?matchedSpecific/specificWords.length:0);
      const hasStrongSubjectMatch=
        specificRatio>=0.5||
        matchedSourceSpecific>0||
        matchedExpansion||
        statutoryInSource||
        statutoryInChunk||
        (jevScore!==null&&jevScore>=0.75);

      // Smart Relevance Gate: do not include indexed sources that only matched generic words ("nyc", "rules", "commercial")
      // or a single incidental word in a multi-concept query without strong semantic, Jev, or source-metadata alignment.
      if(!hasSubjectMatch){
        if(isHighDim&&sim<0.54)continue;
        if(!isHighDim&&sim<=0.5)continue;
      } else if(!hasStrongSubjectMatch){
        if(isHighDim&&sim<0.48)continue;
        if(!isHighDim&&distinctiveWords.length>=3&&sim<=0.5)continue;
      }

      const simBoost=isHighDim?sim*0.016:0;
      const specificBoost=specificWords.length?(matchedSpecific/specificWords.length)*0.014:0;
      const sourceMetaBoost=specificWords.length?(matchedSourceSpecific/specificWords.length)*0.012:0;
      const statutoryBoost=(statutoryInSource?0.015:0)+(statutoryInChunk?0.006:0);
      const topicBoost=topic&&(meta.topics?.includes(topic)||sourceHeader.includes(topic.toLowerCase()))?0.003:0;
      const jevBoost=jevScore!==null?jevScore*0.03:0;

      ranked.push({
        ...row,
        text,
        metadata:meta,
        score:baseScore+simBoost+specificBoost+sourceMetaBoost+statutoryBoost+topicBoost+jevBoost,
      });
    }
    ranked.sort((a,b)=>b.score-a.score);

    const counts=new Map();
    const results=ranked.filter(r=>{const count=counts.get(r.source)||0;counts.set(r.source,count+1);return count<3;}).slice(0,limit).map(r=>{
      const match=r.metadata.pdfPages&&r.text.match(/^\[PDF page (\d+) of (\d+)\]/),pdf=match?{page:Number(match[1]),pageCount:Number(match[2]),extractor:PDF_EXTRACTOR}:null;
      return {chunkId:r.id,ordinal:r.ordinal,versionId:r.version,sourceId:r.source,title:pdf?pdfPageTitle(r.metadata.title,pdf.page,pdf.pageCount):r.metadata.title,url:pdf?pdfPageUrl(r.url,pdf.page):r.url,text:r.text,score:r.score,...(pdf?{pdf}:{}),
      jurisdiction:r.metadata.jurisdiction,topics:r.metadata.topics,authority:r.metadata.authority,kind:r.metadata.kind,
      coverageNote:r.metadata.coverageNote||null,
      publishedAt:r.metadata.publishedAt||null,effectiveFrom:r.metadata.effectiveFrom||null,effectiveTo:r.metadata.effectiveTo||null,
      observedAt:r.observed_at,...knowledgeFreshness(r),
    };});
    const trace={
      city:resolvedCity,scope,topic:topic||null,asOf:asOf||null,mode,embeddingError,candidateChunks:rows.length,loadedTextChunks:texts.size,
      durationMs:Math.round(performance.now()-started),
      jevRoute:jevRoute?{hasDirectIndexedMatch:jevRoute.hasDirectIndexedMatch,needsWebFanout:jevRoute.needsWebFanout,selectedSourceIds:jevRoute.selectedSourceIds,directPullSourceIds:jevRoute.directPullSourceIds}:null,
      results:results.map(({chunkId,versionId,score})=>({chunkId,versionId,score})),
    };
    if(recordRetrieval) {
      throwIfCancelled();
      this.write('INSERT INTO retrievals VALUES(?,?,?,?)',id,new Date().toISOString(),query,JSON.stringify(trace));
      this.write('DELETE FROM retrievals WHERE created < ?',new Date(Date.now()-30*86400000).toISOString());
    }
    return {traceId:id,...trace,results,note:asOf?'Only sources with a known effective date were considered; historical coverage may be incomplete.':'Unknown effective dates remain unknown. Check source authority and applicability; snapshots do not establish legal validity.'};
  }
}

export function openKnowledge() {return existsSync(knowledgePath())?new KnowledgeStore(knowledgePath()):null;}
