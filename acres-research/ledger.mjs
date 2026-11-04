import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {describeDistrict} from './zoning.mjs';
import {parseNycBbl,PROPOSAL_JOB,PROPOSAL_STALE_YEARS} from './nycdb.mjs';

// NYC development ledger: a parcel-keyed SQLite copy of the public records that
// underwriting calculations consume (ACRIS land sales with price per zoning floor
// area, DOB filed capacity and pipeline, DOF assessments). scripts/ledger-sync.mjs
// refreshes it nightly from NYC Open Data; this module owns the schema, the pure
// derivations, and the read API the research agent cites as official records.

const SOCRATA='https://data.cityofnewyork.us';
const dataset=(id,name)=>({id,name,resourceUrl:`${SOCRATA}/resource/${id}.json`,sourceUrl:`${SOCRATA}/d/${id}`});

// Dataset ids verified against data.cityofnewyork.us on 2026-10-16. 8y4t-faws is the
// DOF roll that is still published; the older yjxr-fw8i stopped updating in 2020.
export const LEDGER_DATASETS={
  acrisMaster:dataset('bnx9-e6tj','ACRIS - Real Property Master'),
  acrisLegals:dataset('8h5j-fqxa','ACRIS - Real Property Legals'),
  dobBis:dataset('ic3t-wcy2','DOB Job Application Filings'),
  dobNow:dataset('w9ak-ipjd','DOB NOW: Build - Job Application Filings'),
  assessments:dataset('8y4t-faws','Property Valuation and Assessment Data Tax Classes 1,2,3,4'),
  pluto:dataset('64uk-42ks','Primary Land Use Tax Lot Output (PLUTO)'),
  hpdProduction:dataset('hg8x-zxpr','Affordable Housing Production by Building'),
};

export const LAND_DOC_TYPES=['DEED','DEEDO','ZONE','AIRRIGHT','DEVR','DECL','EASE'];

// A development-site sale: a deed for the whole of one tax lot, at a real price, followed by a new
// building or full demolition filing on that lot (filed up to 90 days before the deed records, since
// buyers file before closing, and up to 36 months after). The filing is what shows the buyer bought to build.
export const DEVELOPMENT_SITE_SALES={
  months:24,minAmount:250000,filingLeadDays:90,filingWithinMonths:36,deedTypes:['DEED','DEEDO'],
  filingTypes:['New Building','Full Demolition'],
};
export function developmentSiteSale({deed,lotCount,filings}){
  const amount=num(deed.document_amt),pct=num(deed.percent_trans)??100;
  if(!DEVELOPMENT_SITE_SALES.deedTypes.includes(deed.doc_type)||lotCount!==1||!(amount>=DEVELOPMENT_SITE_SALES.minAmount)||pct<100)return null;
  const recorded=Date.parse(deed.recorded_datetime);
  const after=filings.filter(f=>f.filing_date&&Date.parse(f.filing_date)>=recorded-DEVELOPMENT_SITE_SALES.filingLeadDays*DAY
    &&Date.parse(f.filing_date)<=recorded+DEVELOPMENT_SITE_SALES.filingWithinMonths*30.4375*DAY)
    .sort((a,b)=>a.filing_date.localeCompare(b.filing_date));
  if(!after.length)return null;
  return {doc_id:deed.document_id,recorded_at:deed.recorded_datetime.slice(0,10),price:amount,filing_job:after[0].job_number,filing_type:after[0].job_type,filed_at:after[0].filing_date.slice(0,10)};
}
// ACRIS condominium declarations (a condo in a condo included); their unit lots say how a building is held.
export const CONDO_DOC_TYPES=['CDEC','SCDEC'];
export const SALE_DOC_TYPES=['DEED','DEEDO'];
export const FORMULA_VERSION='zfa-v1';
// The DOB filing fields the sync keeps. A sync run records it, and a dataset whose runs predate the
// current version is read again over the full filing history, so new fields reach every stored filing.
export const FILING_FIELDS_VERSION='filings-v2';

export const ledgerPath=()=>process.env.ACRES_LEDGER_DB||join(homedir(),'.openclaw','acres-state','ledger.sqlite');
// One read connection per ledger file for the process; WAL readers see each nightly sync commit.
const openStores=new Map();
export function openSharedLedger(){
  const path=ledgerPath();
  if(!openStores.has(path))openStores.set(path,new LedgerStore(path));
  return openStores.get(path);
}

// DOF class tax rates by fiscal year, a dated fact file kept beside the code.
export const NYC_TAX_RATES=JSON.parse(readFileSync(new URL('./nyc-tax-rates.json',import.meta.url),'utf8'));

const META_KEYS=new Set(['query_url','dataset_updated_at','fetched_at','row_hash']);
export function rowHash(row){
  const keys=Object.keys(row).filter(k=>!META_KEYS.has(k)).sort();
  return createHash('sha256').update(JSON.stringify(keys.map(k=>[k,row[k]??null]))).digest('hex');
}

const DAY=86400000;
// Socrata floating timestamps have no zone suffix.
const floating=ms=>new Date(ms).toISOString().slice(0,23);
export function deltaWindow({lastUntil,now,backfillDays,lookbackDays}){
  const since=lastUntil?Date.parse(`${lastUntil}Z`)-lookbackDays*DAY:now.getTime()-backfillDays*DAY;
  return {since:floating(since),until:floating(now.getTime())};
}

// DOB BIS stores dates as MM/DD/YYYY text, so a date window becomes month LIKE patterns.
export function monthPatterns(since,until){
  const out=[];
  let y=Number(since.slice(0,4)),m=Number(since.slice(5,7));
  const endY=Number(until.slice(0,4)),endM=Number(until.slice(5,7));
  while(y<endY||(y===endY&&m<=endM)){
    out.push(`${String(m).padStart(2,'0')}/%/${y}`);
    m++;if(m>12){m=1;y++;}
  }
  return out;
}

const round=(n,d=0)=>Math.round(n*10**d)/10**d;
const usd=n=>`$${Math.round(n).toLocaleString('en-US')}`;
const pct=(n,d=2)=>`${(n*100).toFixed(d)}%`;
export function deriveZfa({lotAreaSqft,zoneDist}){
  if(!lotAreaSqft)return {maxZfaStandard:null,maxZfaAffordable:null,reason:'no PLUTO lot area for this lot'};
  const district=describeDistrict(zoneDist);
  if(!district||!['residential','commercial','manufacturing'].includes(district.kind)){
    return {maxZfaStandard:null,maxZfaAffordable:null,reason:`district ${zoneDist||'(none)'} is not curated in zoning-rules.json`};
  }
  const far=Math.max(district.farResidential??0,district.farCommercial??0);
  if(!far)return {maxZfaStandard:null,maxZfaAffordable:null,reason:`curated district ${zoneDist} has no residential or commercial FAR`};
  return {
    maxZfaStandard:round(lotAreaSqft*far),
    maxZfaAffordable:district.farResidentialAffordable?round(lotAreaSqft*district.farResidentialAffordable):null,
    reason:null,
  };
}

export function classifyDeed({docType,amount,percentTrans,lotCount,unit,minAmount}){
  if(!SALE_DOC_TYPES.includes(docType))return {armsLength:null,trimReason:'not_a_sale',bundled:false};
  const bundled=lotCount>1;
  if(!(amount>=minAmount))return {armsLength:false,trimReason:'below_floor',bundled};
  if(percentTrans!==null&&percentTrans<100)return {armsLength:false,trimReason:'partial_interest',bundled};
  if(unit)return {armsLength:false,trimReason:'unit_conveyance',bundled};
  return {armsLength:true,trimReason:null,bundled};
}

export const num=v=>{
  if(v===undefined||v===null)return null;
  const clean=String(v).replace(/[$,\s]/g,'');
  return clean===''||!Number.isFinite(Number(clean))?null:Number(clean);
};
const zip=v=>/^\d{5}$/.test(String(v??''))&&v!=='00000'?String(v):null;
const mdy=v=>{const m=String(v??'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);return m?`${m[3]}-${m[1]}-${m[2]}`:null;};
const isoDate=v=>v?String(v).slice(0,10):null;
const BORO_CODES={MANHATTAN:'1',BRONX:'2',BROOKLYN:'3',QUEENS:'4','STATEN ISLAND':'5'};
export const composeBbl=(boro,block,lot)=>`${boro}${String(Number(block)).padStart(5,'0')}${String(Number(lot)).padStart(4,'0')}`;
// DOB filings name the borough (BIS in upper case, DOB NOW in title case) and often
// leave the published bbl empty, so both key on borough, block and lot. A row that
// cannot be keyed gets a null bbl and the sync skips it.
function filingBbl(borough,block,lot){
  const boro=BORO_CODES[String(borough??'').trim().toUpperCase()];
  const b=Number(block),l=Number(lot);
  return boro&&Number.isInteger(b)&&b>0&&Number.isInteger(l)&&l>0?composeBbl(boro,b,l):null;
}

// NYC coordinates only; a zero or out-of-city point is dropped rather than placed in the ocean.
const coord=(v,min,max)=>{const n=num(v);return n!==null&&n>=min&&n<=max?n:null;};
const lat=v=>coord(v,40.4,41),lng=v=>coord(v,-74.3,-73.6);
const address=(house,street)=>[house,street].map(v=>String(v??'').trim().replace(/\s+/g,' ')).filter(Boolean).join(' ')||null;

export function parseBisFiling(raw){
  return {
    bbl:filingBbl(raw.borough,raw.block,raw.lot),source:'dob_bis',job_number:raw.job__,job_type:raw.job_type,
    // BIS publishes only the owner's mailing ZIP; the sync takes the lot's ZIP from PLUTO.
    status:raw.job_status_descrp,zip:null,proposed_zoning_sqft:num(raw.proposed_zoning_sqft),
    proposed_dwelling_units:num(raw.proposed_dwelling_units),proposed_stories:num(raw.proposed_no_of_stories),
    initial_cost:num(raw.initial_cost),filing_date:mdy(raw.pre__filing_date),latest_action_date:mdy(raw.latest_action_date),
    existing_dwelling_units:num(raw.existing_dwelling_units),floor_area:num(raw.total_construction_floor_area),latitude:lat(raw.gis_latitude),longitude:lng(raw.gis_longitude),
    bin:raw.bin__??null,address:address(raw.house__,raw.street_name),
  };
}

export function parseDobNowFiling(raw){
  return {
    bbl:filingBbl(raw.borough,raw.block,raw.lot),source:'dob_now',job_number:raw.job_filing_number,job_type:raw.job_type,status:raw.filing_status,
    zip:zip(raw.postcode),proposed_zoning_sqft:null,proposed_dwelling_units:num(raw.proposed_dwelling_units),
    proposed_stories:num(raw.proposed_no_of_stories),initial_cost:num(raw.initial_cost),
    filing_date:isoDate(raw.filing_date),latest_action_date:isoDate(raw.current_status_date),
    existing_dwelling_units:num(raw.existing_dwelling_units),floor_area:num(raw.total_construction_floor_area),latitude:lat(raw.latitude),longitude:lng(raw.longitude),
    bin:raw.bin??null,address:address(raw.house_no,raw.street_name),
  };
}

// HPD-financed or incentive buildings say how their counted units are held: rental or homeownership.
export function parseHpdBuilding(raw){
  const bbl=/^[1-5]\d{9}$/.test(String(raw.bbl??''))?String(raw.bbl):null;
  return {
    source:'hpd_production',record_id:`${raw.project_id}/${raw.building_id}`,bbl,borough:bbl?.[0]??null,block:bbl?Number(bbl.slice(1,6)):null,
    lot:bbl?Number(bbl.slice(6)):null,bin:raw.bin??null,address:address(raw.house_number,raw.street_name),
    rental_units:num(raw.counted_rental_units),ownership_units:num(raw.counted_homeownership_units),condo_units:null,multi_units:null,
    recorded_at:isoDate(raw.project_start_date),
  };
}

// One condominium declaration on one tax lot, with the declaration's residential unit lots counted:
// single residential condo units (ACRIS property type SC) are apartments declared for separate sale,
// multiple residential condo units (MC) hold many apartments in one unit, as a rental floor does.
export function parseCondoDeclaration(master,legal,units){
  return {
    source:'acris_condo',record_id:master.document_id,bbl:composeBbl(legal.borough,legal.block,legal.lot),borough:String(legal.borough),
    block:Number(legal.block),lot:Number(legal.lot),bin:null,address:address(legal.street_number,legal.street_name),
    rental_units:null,ownership_units:null,condo_units:units.single,multi_units:units.multiple,recorded_at:isoDate(master.recorded_datetime),
  };
}

export function parseAssessment(raw){
  return {
    bbl:raw.parid,fiscal_year:Number(raw.year),period:Number(raw.period),assessed_value:num(raw.curacttot),
    market_value:num(raw.curmkttot),tax_class:raw.curtaxclass,zip:zip(raw.zip_code),
  };
}

const SCHEMA=`
CREATE TABLE IF NOT EXISTS land_sales(
  bbl TEXT NOT NULL,block INTEGER NOT NULL,lot INTEGER NOT NULL,borough TEXT NOT NULL,doc_id TEXT NOT NULL,doc_type TEXT NOT NULL,
  document_amt REAL,recorded_at TEXT NOT NULL,lot_area_sqft REAL,zone_dist TEXT,zip TEXT,percent_trans REAL,lot_count INTEGER NOT NULL,
  bundled INTEGER NOT NULL,arms_length INTEGER,trim_reason TEXT,max_zfa_standard REAL,max_zfa_affordable REAL,price_per_zfa REAL,
  price_per_zfa_reason TEXT,query_url TEXT NOT NULL,dataset_updated_at TEXT,fetched_at TEXT NOT NULL,row_hash TEXT NOT NULL,
  formula_version TEXT NOT NULL,PRIMARY KEY(doc_id,bbl));
CREATE INDEX IF NOT EXISTS land_sales_block ON land_sales(borough,block,recorded_at);
CREATE TABLE IF NOT EXISTS dob_filings(
  bbl TEXT NOT NULL,source TEXT NOT NULL,job_number TEXT PRIMARY KEY,job_type TEXT,status TEXT,zip TEXT,proposed_zoning_sqft REAL,
  proposed_dwelling_units REAL,proposed_stories REAL,initial_cost REAL,filing_date TEXT,latest_action_date TEXT,query_url TEXT NOT NULL,
  dataset_updated_at TEXT,fetched_at TEXT NOT NULL,row_hash TEXT NOT NULL,floor_area REAL,latitude REAL,longitude REAL,bin TEXT,address TEXT,
  existing_dwelling_units REAL);
CREATE INDEX IF NOT EXISTS dob_filings_bbl ON dob_filings(bbl);
CREATE INDEX IF NOT EXISTS dob_filings_zip ON dob_filings(zip,filing_date);
CREATE TABLE IF NOT EXISTS assessments(
  bbl TEXT NOT NULL,fiscal_year INTEGER NOT NULL,period INTEGER NOT NULL,assessed_value REAL,tax_class TEXT,market_value REAL,zip TEXT,
  query_url TEXT NOT NULL,dataset_updated_at TEXT,fetched_at TEXT NOT NULL,row_hash TEXT NOT NULL,PRIMARY KEY(bbl,fiscal_year,period));
CREATE TABLE IF NOT EXISTS ledger_sync_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,dataset TEXT NOT NULL,dataset_id TEXT NOT NULL,since TEXT NOT NULL,
  until TEXT NOT NULL,rows_fetched INTEGER NOT NULL,inserted INTEGER NOT NULL,updated INTEGER NOT NULL,unchanged INTEGER NOT NULL,
  trimmed INTEGER NOT NULL,skipped INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,alert TEXT,started_at TEXT NOT NULL,finished_at TEXT NOT NULL,
  fields_version TEXT);
CREATE TABLE IF NOT EXISTS tenure_records(
  source TEXT NOT NULL,record_id TEXT NOT NULL,bbl TEXT NOT NULL,borough TEXT NOT NULL,block INTEGER NOT NULL,lot INTEGER NOT NULL,bin TEXT,
  address TEXT,rental_units REAL,ownership_units REAL,condo_units REAL,multi_units REAL,recorded_at TEXT,query_url TEXT NOT NULL,
  dataset_updated_at TEXT,fetched_at TEXT NOT NULL,row_hash TEXT NOT NULL,PRIMARY KEY(source,record_id,bbl));
CREATE INDEX IF NOT EXISTS tenure_records_block ON tenure_records(borough,block);
CREATE TABLE IF NOT EXISTS development_site_sales(
  doc_id TEXT PRIMARY KEY,bbl TEXT NOT NULL,recorded_at TEXT NOT NULL,price REAL NOT NULL,filing_job TEXT NOT NULL,filing_type TEXT NOT NULL,
  filed_at TEXT NOT NULL,zip TEXT,latitude REAL,longitude REAL,pluto_json TEXT NOT NULL,query_url TEXT NOT NULL,dataset_updated_at TEXT,
  fetched_at TEXT NOT NULL,row_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS development_site_sales_recorded ON development_site_sales(recorded_at);
CREATE INDEX IF NOT EXISTS tenure_records_bin ON tenure_records(bin);`;

// Columns added after a table was first created, in the order they were added.
const ADDED_COLUMNS={
  ledger_sync_runs:[['skipped','INTEGER NOT NULL DEFAULT 0'],['fields_version','TEXT']],
  dob_filings:[['floor_area','REAL'],['latitude','REAL'],['longitude','REAL'],['bin','TEXT'],['address','TEXT'],['existing_dwelling_units','REAL']],
};

const KEYS={land_sales:['doc_id','bbl'],dob_filings:['job_number'],assessments:['bbl','fiscal_year','period'],tenure_records:['source','record_id','bbl'],development_site_sales:['doc_id']};

const sale=r=>({
  bbl:r.bbl,docId:r.doc_id,docType:r.doc_type,documentAmt:r.document_amt,recordedAt:r.recorded_at,lotAreaSqft:r.lot_area_sqft,
  zoneDist:r.zone_dist,maxZfaStandard:r.max_zfa_standard,maxZfaAffordable:r.max_zfa_affordable,pricePerZfa:r.price_per_zfa,
  pricePerZfaReason:r.price_per_zfa_reason,bundled:r.bundled===1,lotCount:r.lot_count,trimReason:r.trim_reason,queryUrl:r.query_url,
});
const filing=r=>({
  bbl:r.bbl,source:r.source,jobNumber:r.job_number,jobType:r.job_type,status:r.status,zip:r.zip,proposedZoningSqft:r.proposed_zoning_sqft,
  proposedDwellingUnits:r.proposed_dwelling_units,proposedStories:r.proposed_stories,initialCost:r.initial_cost,
  filingDate:r.filing_date,latestActionDate:r.latest_action_date,floorArea:r.floor_area??null,address:r.address??null,queryUrl:r.query_url,
});
const assessment=r=>({
  bbl:r.bbl,fiscalYear:r.fiscal_year,period:r.period,periodLabel:r.period===3?'final':r.period===1?'tentative':`period ${r.period}`,
  assessedValue:r.assessed_value,marketValue:r.market_value,taxClass:r.tax_class,zip:r.zip,queryUrl:r.query_url,
});
const withdrawn=r=>/withdraw/i.test(r.status||'');
// DOB NOW files one job as an initial filing (-I1) plus follow-on filings (-P, -S, -A,
// -B, -Z...) that repeat its program, so the pipeline counts each job number once.
const jobBase=r=>r.job_number.split('-')[0];
const monthsBefore=(now,months)=>new Date(now.getTime()-months*30.4375*DAY).toISOString().slice(0,10);

export class LedgerStore{
  constructor(path){
    mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.db.exec('PRAGMA busy_timeout=10000;PRAGMA journal_mode=WAL;');
    // The research service and the nightly sync open one ledger; the schema and its added columns
    // change in one write transaction, so two processes opening it at once cannot both add a column.
    this.db.exec('BEGIN IMMEDIATE');
    this.db.exec(SCHEMA);
    for(const [table,columns] of Object.entries(ADDED_COLUMNS)){
      const have=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
      for(const [name,type] of columns)if(!have.has(name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS dob_filings_geo ON dob_filings(latitude,longitude)');
    this.db.exec('COMMIT');
  }
  close(){this.db.close();}
  count(table){return this.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;}

  upsert(table,row){
    const keys=KEYS[table];
    const hash=rowHash(row);
    const existing=this.db.prepare(`SELECT row_hash FROM ${table} WHERE ${keys.map(k=>`${k}=?`).join(' AND ')}`).get(...keys.map(k=>row[k]));
    if(existing?.row_hash===hash)return 'unchanged';
    const full={...row,row_hash:hash};
    const cols=Object.keys(full);
    this.db.prepare(`INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>full[c]??null));
    return existing?'updated':'inserted';
  }
  upsertLandSale(row){return this.upsert('land_sales',row);}
  upsertDobFiling(row){return this.upsert('dob_filings',row);}
  upsertAssessment(row){return this.upsert('assessments',row);}
  upsertTenureRecord(row){return this.upsert('tenure_records',row);}
  upsertDevelopmentSiteSale(row){return this.upsert('development_site_sales',row);}

  // Lots whose new-building or demolition filings could follow a development-site sale in the window.
  developmentFilingLots({since}){
    return this.db.prepare(`SELECT bbl,job_number,job_type,filing_date FROM dob_filings WHERE source='dob_now' AND job_type IN (${DEVELOPMENT_SITE_SALES.filingTypes.map(()=>'?').join(',')}) AND filing_date>=? ORDER BY bbl,filing_date`)
      .all(...DEVELOPMENT_SITE_SALES.filingTypes,since);
  }
  // Development-site sales recorded in the last months, each with the PLUTO record of its lot.
  developmentSiteSales({months=DEVELOPMENT_SITE_SALES.months,now=new Date()}={}){
    return this.db.prepare('SELECT * FROM development_site_sales WHERE recorded_at>=? ORDER BY recorded_at').all(monthsBefore(now,months))
      .map(r=>({docId:r.doc_id,bbl:r.bbl,recordedAt:r.recorded_at,price:r.price,filingJob:r.filing_job,filingType:r.filing_type,filedAt:r.filed_at,
        zip:r.zip,latitude:r.latitude,longitude:r.longitude,pluto:JSON.parse(r.pluto_json),queryUrl:r.query_url}));
  }

  recordRun(run){
    const cols=Object.keys(run);
    this.db.prepare(`INSERT INTO ledger_sync_runs(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>run[c]??null));
  }
  lastUntil(datasetName,fieldsVersion=null){
    return this.db.prepare(`SELECT max(until) v FROM ledger_sync_runs WHERE dataset=? AND status='ok'${fieldsVersion?' AND fields_version=?':''}`).get(datasetName,...(fieldsVersion?[fieldsVersion]:[])).v;
  }
  lastSyncedAt(...datasetNames){
    // The oldest of the datasets a read depends on; null until every one has synced.
    const times=datasetNames.map(d=>this.db.prepare("SELECT max(finished_at) v FROM ledger_sync_runs WHERE dataset=? AND status='ok'").get(d).v);
    return times.includes(null)?null:times.sort()[0];
  }

  landSalesForBlock(bbl,{months=36,now=new Date()}={}){
    const p=parseNycBbl(bbl);
    const cutoff=monthsBefore(now,months);
    const rows=this.db.prepare('SELECT * FROM land_sales WHERE borough=? AND block=? AND recorded_at>=? ORDER BY recorded_at DESC,doc_id,bbl').all(p.boroCode,Number(p.blockNum),cutoff);
    return {
      borough:p.boroughTitle,block:Number(p.blockNum),since:cutoff,
      sales:rows.filter(r=>r.arms_length===1).map(sale),
      instruments:rows.filter(r=>r.arms_length===null).map(sale),
      trimmedCount:rows.filter(r=>r.arms_length===0).length,
      basis:`ACRIS Real Property Master (${LEDGER_DATASETS.acrisMaster.id}) joined to Legals (${LEDGER_DATASETS.acrisLegals.id}) for ${LAND_DOC_TYPES.join('/')} documents recorded on ${p.boroughTitle} block ${Number(p.blockNum)} since ${cutoff}. Deeds below the sale floor, partial-interest and unit conveyances are excluded from sales; multi-lot deeds are flagged bundled. Max ZFA is PLUTO (${LEDGER_DATASETS.pluto.id}) lot area times the curated district FAR (formula ${FORMULA_VERSION}); price per ZFA is null with a reason when the district is not curated. Deeds record price and parties, not unit counts: any unit count shown with a sale comes from PLUTO or DOB filings, never from the deed itself.`,
      sourceUrl:LEDGER_DATASETS.acrisMaster.sourceUrl,
      retrievedAt:this.lastSyncedAt('acris'),
    };
  }

  filedCapacityForParcel(bbl){
    const p=parseNycBbl(bbl);
    const rows=this.db.prepare('SELECT * FROM dob_filings WHERE bbl=? ORDER BY latest_action_date DESC,job_number').all(p.bbl);
    const live=rows.filter(r=>!withdrawn(r));
    const max=k=>{const v=live.map(r=>r[k]).filter(x=>x!==null);return v.length?Math.max(...v):null;};
    return {
      bbl:p.bbl,filings:rows.map(filing),
      maxEverFiledZoningSqft:max('proposed_zoning_sqft'),
      maxEverFiledDwellingUnits:max('proposed_dwelling_units'),
      basis:`DOB BIS job filings (${LEDGER_DATASETS.dobBis.id}, document 01 of NB/A1/DM jobs) and DOB NOW Build filings (${LEDGER_DATASETS.dobNow.id}, new building, ALT-CO, Alteration CO and demolition jobs) for BBL ${p.bbl}. Proposed zoning floor area is published by BIS only. Max ever filed figures are the largest stated among filings not withdrawn, each taken separately whatever the approval; they are never the lot's capacity.`,
      sourceUrl:LEDGER_DATASETS.dobNow.sourceUrl,
      retrievedAt:this.lastSyncedAt('dob_bis','dob_now'),
    };
  }

  assessmentForParcel(bbl){
    const p=parseNycBbl(bbl);
    const history=this.db.prepare('SELECT * FROM assessments WHERE bbl=? ORDER BY fiscal_year DESC,period DESC').all(p.bbl).map(assessment);
    return {
      bbl:p.bbl,latest:history[0]??null,history,
      basis:`DOF ${LEDGER_DATASETS.assessments.name} (${LEDGER_DATASETS.assessments.id}) for BBL ${p.bbl}: current actual assessed value (curacttot), market value (curmkttot) and tax class, final roll (period 3) preferred over tentative (period 1).`,
      sourceUrl:LEDGER_DATASETS.assessments.sourceUrl,
      retrievedAt:this.lastSyncedAt('assessments'),
    };
  }

  pipelineForZip(zipCode,{months=24,now=new Date()}={}){
    const cutoff=monthsBefore(now,months);
    const rows=this.db.prepare('SELECT * FROM dob_filings WHERE zip=? AND filing_date>=? ORDER BY filing_date DESC,job_number').all(zipCode,cutoff);
    const jobs=new Map();
    for(const r of rows)jobs.set(jobBase(r),[...(jobs.get(jobBase(r))??[]),r]);
    // Each job stands where its latest filing stands in DOB review.
    const live=[...jobs.values()].map(fs=>fs.filter(r=>!withdrawn(r))).filter(fs=>fs.length).map(fs=>({
      stage:filingStage([...fs].sort((a,b)=>String(b.latest_action_date??b.filing_date??'').localeCompare(String(a.latest_action_date??a.filing_date??'')))[0].status),
      units:Math.max(...fs.map(r=>r.proposed_dwelling_units??0)),
    }));
    const byStage={};
    for(const j of live){byStage[j.stage]??={jobs:0,proposedDwellingUnits:0};byStage[j.stage].jobs++;byStage[j.stage].proposedDwellingUnits+=j.units;}
    return {
      zip:zipCode,months,since:cutoff,filings:rows.map(filing),
      totals:{
        approvedJobs:byStage.approved?.jobs??0,
        approvedDwellingUnits:byStage.approved?.proposedDwellingUnits??0,
        byStage,
        activeJobs:live.length,
        proposedDwellingUnitsAllStages:live.reduce((s,j)=>s+j.units,0),
        withdrawnJobs:jobs.size-live.length,
      },
      basis:`DOB BIS (${LEDGER_DATASETS.dobBis.id}) and DOB NOW (${LEDGER_DATASETS.dobNow.id}) new building, major alteration and demolition filings in ZIP ${zipCode} filed since ${cutoff}. Totals count each job number once (DOB NOW follow-on filings repeat the job's program), take the largest proposed unit count among its filings, exclude withdrawn jobs and are bucketed by where each job's latest filing stands in DOB review. Only approved or permitted jobs are the permitted pipeline; jobs in review, in pre-filing, with objections or signed off are listed by stage, not counted in it.`,
      sourceUrl:LEDGER_DATASETS.dobNow.sourceUrl,
      retrievedAt:this.lastSyncedAt('dob_bis','dob_now'),
    };
  }

  // DOB new buildings and major alterations filed or acted on within the look-back, as one project per
  // lot, within radiusMiles of a point and in its ZIP, with how each is held where a record says so.
  nearbyPipeline({latitude,longitude,zip:zipCode=null,bbl=null,radiusMiles=NEARBY_RADIUS_MILES,months=NEARBY_MONTHS,now=new Date(),limit=60}={}){
    const center={latitude:Number(latitude),longitude:Number(longitude)};
    if(!lat(center.latitude)||!lng(center.longitude))throw new Error('A nearby pipeline needs NYC latitude and longitude.');
    const since=monthsBefore(now,months);
    const dLat=radiusMiles/69,dLng=radiusMiles/(69*Math.cos(center.latitude*Math.PI/180));
    const recent='(filing_date>=? OR latest_action_date>=?)';
    const ring=this.db.prepare(`SELECT * FROM dob_filings WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND ${recent}`)
      .all(center.latitude-dLat,center.latitude+dLat,center.longitude-dLng,center.longitude+dLng,since,since);
    const near=pipelineProjects(ring).map(p=>({...p,distance:milesBetween(center,p)})).filter(p=>p.distance<=radiusMiles)
      .map(({distance,...p})=>({...p,distanceMiles:round(distance,2)}));
    const inZip=zipCode?pipelineProjects(this.db.prepare(`SELECT * FROM dob_filings WHERE zip=? AND ${recent}`).all(zipCode,since,since)):[];
    const tenure=this.tenureLookup([...near,...inZip]);
    const withTenure=p=>({...p,...tenure(p),isSubject:Boolean(bbl)&&p.bbl===String(bbl),link:filingLink(p)});
    const nearProjects=near.map(withTenure).sort((a,b)=>(b.units??0)-(a.units??0)||a.distanceMiles-b.distanceMiles);
    const around=nearProjects.filter(p=>!p.isSubject);
    return {
      center,radiusMiles,zip:zipCode,months,since,
      nearby:pipelineTotals(around),
      sameZip:zipCode?pipelineTotals(inZip.map(withTenure).filter(p=>!p.isSubject)):null,
      onSubjectLot:nearProjects.filter(p=>p.isSubject),
      projects:around.slice(0,limit),projectCount:around.length,
      basis:`DOB BIS (${LEDGER_DATASETS.dobBis.id}) and DOB NOW (${LEDGER_DATASETS.dobNow.id}) new building and major alteration jobs filed or acted on since ${since}, within ${radiusMiles} mile${radiusMiles===1?'':'s'} of the site${zipCode?` and in ZIP ${zipCode}`:''}. Each lot counts once: its latest new building job, else its latest alteration; follow-on filings of a job are not counted again and withdrawn jobs are excluded. Units and floor area are the largest proposed figures among a job's filings (floor area is DOB total construction floor area); an alteration counts the units it adds over the existing ones and is left out when it adds none. A project reads as rental or condo only where a record says so: HPD Affordable Housing Production by Building (${LEDGER_DATASETS.hpdProduction.id}) counted rental or homeownership units on the lot or building, or an ACRIS condominium declaration (${CONDO_DOC_TYPES.join(', ')}) on the lot or address that declares separate residential condo units (condo) or only multi-apartment units (rental). The site's own lot is listed apart and left out of the totals.`,
      sourceUrl:LEDGER_DATASETS.dobNow.sourceUrl,
      retrievedAt:this.lastSyncedAt('dob_bis','dob_now'),
      tenureRetrievedAt:this.lastSyncedAt('hpd_production','acris_condo'),
    };
  }

  // Tenure for projects from the records on their blocks: HPD counted units on the lot or building,
  // and condominium declarations on the lot or at the address.
  tenureLookup(projects){
    const byBlock=new Map();
    for(const p of projects){
      const key=p.bbl.slice(0,6);
      if(!byBlock.has(key))byBlock.set(key,this.db.prepare('SELECT * FROM tenure_records WHERE borough=? AND block=?').all(p.bbl[0],Number(p.bbl.slice(1,6))));
    }
    return p=>projectTenure(p,byBlock.get(p.bbl.slice(0,6))??[]);
  }

  // Block land price for the subject: median price per max ZFA of the priced arm's-length deeds
  // (each deed once, so a bundled multi-lot deed is one sample) times the subject's own max ZFA.
  landPriceEstimate(bbl,{months=36,now=new Date(),lotAreaSqft=null,zoneDist=null}={}){
    const block=this.landSalesForBlock(bbl,{months,now});
    const byDoc=new Map();
    for(const s of block.sales){
      if(s.pricePerZfa===null||s.pricePerZfaReason!==null||byDoc.has(s.docId))continue;
      byDoc.set(s.docId,{docId:s.docId,documentAmt:s.documentAmt,pricePerZfa:s.pricePerZfa,recordedAt:s.recordedAt});
    }
    const sales=[...byDoc.values()];
    const prices=sales.map(s=>s.pricePerZfa).sort((a,b)=>a-b);
    const mid=prices.length>>1;
    const median=prices.length?round(prices.length%2?prices[mid]:(prices[mid-1]+prices[mid])/2,2):null;
    const zfa=deriveZfa({lotAreaSqft,zoneDist});
    const where=`${block.borough} block ${block.block} since ${block.since}`;
    const reason=!block.retrievedAt?'the development ledger has not been synced for ACRIS land sales'
      :sales.length<3?`fewer than three priced arm's-length deeds on ${where} (${sales.length})`
      :zfa.reason?`no curated max ZFA for the subject: ${zfa.reason}`:null;
    const estimate=reason?null:Math.round(median*zfa.maxZfaStandard);
    return {
      pricePerZfaMedian:median,pricePerZfaRange:prices.length?[prices[0],prices.at(-1)]:null,sampleSize:sales.length,sales,
      maxZfa:zfa.maxZfaStandard,estimate,reason,since:block.since,
      basis:`Land price = median ${median===null?'(none)':`${usd(median)}`} per max ZFA of ${sales.length} arm's-length ACRIS deeds on ${where} (${sales.map(s=>s.docId).join(', ')||'no deeds'}) x the subject max ZFA ${zfa.maxZfaStandard===null?'(not curated)':zfa.maxZfaStandard.toLocaleString('en-US')} (PLUTO lot area x curated district FAR, formula ${FORMULA_VERSION})${estimate===null?'':` = ${usd(estimate)}`}. Deeds without a price per ZFA are excluded and a bundled multi-lot deed counts once.`,
      sourceUrl:block.sourceUrl,retrievedAt:block.retrievedAt,
    };
  }
}

export const NEARBY_RADIUS_MILES=0.5;
export const NEARBY_MONTHS=36;
// Condo declarations with fewer separately declared apartments than this are a financing or
// commercial split of one building, not apartments for sale.
export const CONDO_SALE_MIN_UNITS=3;

const milesBetween=(a,b)=>{
  const rad=x=>x*Math.PI/180,dLat=rad(b.latitude-a.latitude),dLng=rad(b.longitude-a.longitude);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLng/2)**2;
  return 2*3958.8*Math.asin(Math.sqrt(h));
};

// Filings grouped into one project per lot: a job's filings share its job number base, and a lot's
// latest new building job governs over its alterations and older jobs (refilings of one project).
// An alteration's proposed units are the whole building after the work, so it counts the units it
// adds over the existing ones, and an alteration that adds none is not a project.
export function pipelineProjects(rows){
  const jobs=new Map();
  for(const r of rows){
    if(!PROPOSAL_JOB.test(r.job_type||'')||withdrawn(r))continue;
    jobs.set(jobBase(r),[...(jobs.get(jobBase(r))??[]),r]);
  }
  const lots=new Map();
  for(const [job,fs] of jobs){
    const latest=[...fs].sort((a,b)=>String(b.latest_action_date??b.filing_date??'').localeCompare(String(a.latest_action_date??a.filing_date??'')))[0];
    const first=[...fs].sort((a,b)=>String(a.filing_date??'').localeCompare(String(b.filing_date??'')))[0];
    const most=k=>{const v=fs.map(r=>r[k]).filter(x=>x!==null&&x!==undefined);return v.length?Math.max(...v):null;};
    const located=fs.find(r=>r.latitude!==null&&r.longitude!==null);
    const newBuilding=NEW_BUILDING_JOB.test(latest.job_type||'');
    const proposed=most('proposed_dwelling_units'),existing=most('existing_dwelling_units')??0;
    const units=newBuilding?proposed:proposed===null?null:Math.max(0,proposed-existing);
    if(!newBuilding&&!(units>0))continue;
    const project={
      bbl:latest.bbl,bin:fs.find(r=>r.bin)?.bin??null,address:fs.find(r=>r.address)?.address??null,zip:fs.find(r=>r.zip)?.zip??null,
      source:latest.source,jobNumber:job,jobType:latest.job_type,newBuilding,
      status:latest.status,stage:filingStage(latest.status),units,floorArea:most('floor_area'),
      stories:most('proposed_stories'),filingDate:first.filing_date,latestActionDate:latest.latest_action_date,
      latitude:located?.latitude??null,longitude:located?.longitude??null,
    };
    const held=lots.get(project.bbl);
    const newer=!held||(project.newBuilding!==held.newBuilding?project.newBuilding:String(project.filingDate??'')>String(held.filingDate??''));
    if(newer)lots.set(project.bbl,project);
  }
  return [...lots.values()].filter(p=>p.stage!=='withdrawn');
}

const STREET_WORDS={ST:'STREET',STR:'STREET',AVE:'AVENUE',AV:'AVENUE',PL:'PLACE',RD:'ROAD',BLVD:'BOULEVARD',PKWY:'PARKWAY',DR:'DRIVE',
  LN:'LANE',CT:'COURT',TER:'TERRACE',E:'EAST',W:'WEST',N:'NORTH',S:'SOUTH'};
export const normalizeAddress=a=>String(a??'').toUpperCase().replace(/[^A-Z0-9\- ]/g,' ').replace(/\b(\d+)(ST|ND|RD|TH)\b/g,'$1')
  .split(/\s+/).filter(Boolean).map((w,i)=>i&&STREET_WORDS[w]?STREET_WORDS[w]:w).join(' ');

// How a project is held, only where a record says so. HPD counted units are the program's own
// tenure; a condominium declaration that declares apartments one by one means apartments for sale,
// while one that declares only multi-apartment units is a rental building split for financing.
export function projectTenure(project,records){
  const lot=Number(project.bbl.slice(6)),address=normalizeAddress(project.address);
  const hpd=records.filter(r=>r.source==='hpd_production'&&(r.bbl===project.bbl||(project.bin&&r.bin===project.bin)));
  const condo=records.filter(r=>r.source==='acris_condo'&&(r.lot===lot||(address&&normalizeAddress(r.address)===address)));
  const says=new Set(),basis=[];
  const rental=hpd.reduce((n,r)=>n+(r.rental_units??0),0),owned=hpd.reduce((n,r)=>n+(r.ownership_units??0),0);
  if(rental>0){says.add('rental');basis.push(`HPD counts ${rental} rental unit${rental===1?'':'s'}`);}
  if(owned>0){says.add('condo');basis.push(`HPD counts ${owned} homeownership unit${owned===1?'':'s'}`);}
  const declared=new Map();
  for(const r of condo)if(!declared.has(r.record_id))declared.set(r.record_id,r);
  for(const r of declared.values()){
    if((r.condo_units??0)>=CONDO_SALE_MIN_UNITS){says.add('condo');basis.push(`ACRIS condo declaration ${r.record_id} (${r.recorded_at}) declares ${r.condo_units} residential condo units`);}
    else if((r.multi_units??0)>0){says.add('rental');basis.push(`ACRIS condo declaration ${r.record_id} (${r.recorded_at}) declares the apartments as ${r.multi_units} multi-apartment unit${r.multi_units===1?'':'s'}`);}
  }
  return {tenure:says.size===1?[...says][0]:says.size?'mixed':'unknown',tenureBasis:basis};
}

export function pipelineTotals(projects){
  const units=ps=>ps.reduce((n,p)=>n+(p.units??0),0);
  const tenure=Object.fromEntries(['condo','rental','mixed','unknown'].map(t=>{
    const ps=projects.filter(p=>p.tenure===t&&p.units>0);
    return [t,{projects:ps.length,units:units(ps)}];
  }));
  const housing=units(projects);
  const floorArea=ps=>ps.reduce((n,p)=>n+(p.floorArea??0),0);
  // Units and floor area by where each project stands in DOB review; only approved is the permitted pipeline.
  const byStage={};
  for(const stage of [...new Set(projects.map(p=>p.stage))]){
    const ps=projects.filter(p=>p.stage===stage);
    byStage[stage]={projects:ps.length,units:units(ps),floorArea:floorArea(ps)};
  }
  return {
    projects:projects.length,newBuildings:projects.filter(p=>p.newBuilding).length,alterations:projects.filter(p=>!p.newBuilding).length,
    units:housing,floorArea:floorArea(projects),byStage,approved:byStage.approved??{projects:0,units:0,floorArea:0},tenure,
    condoShareOfStatedUnits:tenure.condo.units+tenure.rental.units?round(tenure.condo.units/(tenure.condo.units+tenure.rental.units),3):null,
    statedShareOfUnits:housing?round((tenure.condo.units+tenure.rental.units)/housing,3):null,
  };
}

// The public record of a job: the DOB BIS job page, or the DOB NOW filing in NYC Open Data
// (DOB NOW has no public page per job).
export function filingLink(project){
  if(project.source==='dob_bis')return `https://a810-bisweb.nyc.gov/bisweb/JobsQueryByNumberServlet?passjobnumber=${encodeURIComponent(project.jobNumber)}&passdocnumber=01`;
  return `${LEDGER_DATASETS.dobNow.resourceUrl}?${new URLSearchParams({$where:`starts_with(job_filing_number,'${project.jobNumber}')`})}`;
}

// New building and major alteration filings (PROPOSAL_JOB) state a proposed zoning floor area, the
// filer's own ZFA computation for the lot; DOB NOW publishes no proposed ZFA.
export const NEW_BUILDING_JOB=/^NB$|new building/i;

// Where a filing stands in DOB review. BIS and DOB NOW word their statuses differently; both map
// here, and "disapproved" is tested before "approved" because it contains it.
export function filingStage(status){
  const s=String(status||'');
  if(/withdraw/i.test(s))return 'withdrawn';
  if(/disapprov|objection|reject/i.test(s))return 'disapproved';
  if(/sign(ed)?[- ]?off|LOC issued|letter of completion|certificate of occupancy/i.test(s))return 'completed';
  if(/pre-?filing/i.test(s))return 'pre_filing';
  if(/permit|approved/i.test(s))return 'approved';
  return s?'in_review':'unknown';
}

const stageWhy={
  completed:'the job is signed off, so its floor area is the existing building rather than a proposal',
  disapproved:'plan examination has not approved it',
  pre_filing:'it is still in pre-filing and DOB has not reviewed it',
  in_review:'DOB has not approved it yet',
  unknown:'its status is not recorded, so approval cannot be confirmed',
};

// The governing NB or A1 proposal on the lot and whether its stated ZFA can stand as the operative
// figure: only an approved or permitted filing with recent activity and a stated ZFA qualifies, a new
// building never while its zoning lot span is unrecorded, and an alteration only when its ZFA covers
// the existing building (builtSqft, PLUTO GFA) rather than a work area. Filings are ordered by filing date alone. A current job (in review or approved within the
// staleness window) governs over a later job that has stalled, and a current new building governs
// over a current alteration.
export function latestFiledProposal(filings,{now=new Date(),builtSqft=null}={}){
  const cutoff=new Date(now.getTime()-PROPOSAL_STALE_YEARS*365.25*DAY).toISOString().slice(0,10);
  const jobs=filings.filter(f=>PROPOSAL_JOB.test(f.jobType||'')).map(f=>{
    const stage=filingStage(f.status);
    const lastActivity=[f.filingDate,f.latestActionDate].filter(Boolean).sort().at(-1)??null;
    return {filing:f,stage,lastActivity,stale:stage!=='completed'&&(!lastActivity||lastActivity<cutoff)};
  }).filter(j=>j.stage!=='withdrawn').sort((a,b)=>String(b.filing.filingDate??'').localeCompare(String(a.filing.filingDate??'')));
  const current=j=>!j.stale&&(j.stage==='approved'||j.stage==='in_review');
  const newBuilding=j=>NEW_BUILDING_JOB.test(j.filing.jobType||'');
  const chosen=jobs.find(j=>current(j)&&newBuilding(j))??jobs.find(current)??jobs[0];
  if(!chosen)return null;
  const f=chosen.filing,status=f.status||'status not recorded';
  let notOperative=null;
  if(chosen.stale)notOperative=`its last recorded action was ${chosen.lastActivity??'never dated'}, more than ${PROPOSAL_STALE_YEARS} years ago, so the filing has most likely lapsed`;
  else if(chosen.stage!=='approved')notOperative=`${stageWhy[chosen.stage]} (${status})`;
  else if(!(f.proposedZoningSqft>0))notOperative=f.source==='dob_now'?'DOB NOW publishes no proposed zoning floor area for its filings':'the filing states no proposed zoning floor area';
  // A new building's ZFA stands for this lot only with evidence of the zoning lot it was filed for;
  // the ledger holds one BBL per filing and no zoning lot area, so it stays context until that exists.
  else if(NEW_BUILDING_JOB.test(f.jobType||''))notOperative='the ledger records no zoning lot span for new building filings, so its ZFA may cover a merged zoning lot or only part of this tax lot';
  else if(!(builtSqft>0&&f.proposedZoningSqft>=builtSqft*0.85))notOperative=builtSqft>0
    ?`as an alteration it states ${Math.round(f.proposedZoningSqft).toLocaleString('en-US')} sq ft, under 85 percent of the existing ${Math.round(builtSqft).toLocaleString('en-US')} sq ft building, so it describes the work area rather than the lot's zoning floor area`
    :'as an alteration on a lot with no recorded building area, its floor area cannot be read as the lot\'s zoning floor area';
  // When the governing job states no ZFA, the most recent other filing that did is named for context.
  const earlier=f.proposedZoningSqft>0?null:jobs.find(j=>j!==chosen&&j.filing.proposedZoningSqft>0)?.filing??null;
  return {
    proposal:f,stage:chosen.stage,lastActivity:chosen.lastActivity,notOperative,
    earlierWithZfa:earlier&&{jobNumber:earlier.jobNumber,jobType:earlier.jobType,status:earlier.status,filingDate:earlier.filingDate,proposedZoningSqft:earlier.proposedZoningSqft},
  };
}

// Current-assessment real estate taxes: DOF actual assessed value x the class rate for the roll's
// fiscal year, or the latest earlier published rate, stated as such. Market value is a cross-check.
export function taxesFromAssessment(assessment,rates=NYC_TAX_RATES){
  const a=assessment.latest;
  if(!a||a.assessedValue===null)return {annualTaxes:null,reason:`no DOF assessment in the ledger${assessment.bbl?` for BBL ${assessment.bbl}`:''}${assessment.retrievedAt?'':' (the ledger has not been synced for assessments)'}`};
  const rateYear=Object.keys(rates.fiscalYears).map(Number).filter(y=>y<=a.fiscalYear).sort((x,y)=>y-x)[0];
  const taxClass=String(a.taxClass??'').charAt(0);
  const rate=rateYear?rates.fiscalYears[rateYear].rates[taxClass]:undefined;
  if(!rate)return {annualTaxes:null,reason:`no DOF rate for tax class ${a.taxClass} in FY${a.fiscalYear} or earlier in nyc-tax-rates.json`};
  const annualTaxes=Math.round(a.assessedValue*rate);
  const older=rateYear<a.fiscalYear?` The FY${rateYear} rate is older than the roll because DOF had not published an FY${a.fiscalYear} rate when the rate file was retrieved (${rates.retrievedAt}).`:'';
  return {
    annualTaxes,assessedValue:a.assessedValue,marketValue:a.marketValue,taxClass:a.taxClass,rate,rateFiscalYear:rateYear,assessmentFiscalYear:a.fiscalYear,reason:null,
    basis:`Real estate taxes = DOF FY${a.fiscalYear} assessment (${a.periodLabel} roll) actual assessed value ${usd(a.assessedValue)} x class ${taxClass}${taxClass==='4'?' (commercial)':''} FY${rateYear} rate ${pct(rate,3)} = ${usd(annualTaxes)}, before exemptions, abatements and transitional phase-ins, for the parcel as currently assessed.${older}`,
    crossCheck:a.marketValue?`Taxes are ${pct(annualTaxes/a.marketValue)} of the DOF market value ${usd(a.marketValue)}.`:null,
    sourceUrl:assessment.sourceUrl,rateSourceUrl:rates.sourceUrl,retrievedAt:assessment.retrievedAt,
  };
}

// The subject's land price: what nearby development sites sold for, each sale adjusted to the lot (the
// backtested model its site page leads with, from nearbyLand), and the block's median deed price per max
// ZFA only where that model gives no figure, with the reason it gives none. Each says which basis it used
// and its window: the nearby model reads its fixed development-site window, the block median `months`.
export function subjectLandPrice(store,property,{nearbyLand=null,months=36,now=new Date()}={}){
  const block=store.landPriceEstimate(property.bbl,{months,now,lotAreaSqft:num(property.lotarea),zoneDist:property.zonedist1??null});
  const near=nearbyLand?nearbyLand(property,{now}):{value:null,reason:'the market store holding the nearby development-site sales is not available'};
  if(!(near.value>0)){
    return {...block,method:'block_median',source:'NYC development ledger: ACRIS land sales (bnx9-e6tj)',docIds:block.sales.map(s=>s.docId),nearbyModelReason:near.reason,
      basis:`${block.basis} The nearby development-site model gives no figure: ${near.reason}.`};
  }
  const asOf=new Date(now).toISOString().slice(0,10);
  const blockLine=block.estimate===null?`The block median gives no figure: ${block.reason}.`
    :`The block median, ${usd(block.pricePerZfaMedian)} per max ZFA of ${block.sampleSize} arm's-length deeds on the block since ${block.since}, would give ${usd(block.estimate)}.`;
  return {
    method:'nearby_model',estimate:near.value,reason:null,pricePerBsf:near.perBuildableSqft,buildableSqft:near.buildableSqft,sampleSize:near.sales,withinMiles:near.radiusMiles,months:near.months,
    sales:near.model.comps.map(c=>({docId:c.docId,bbl:c.bbl,recordedAt:c.recordedAt,price:c.price,miles:c.miles,pricePerBsf:c.pricePerBsf,adjustedPricePerBsf:c.adjustedPricePerBsf})),
    docIds:near.model.comps.map(c=>c.docId),
    blockMedian:{estimate:block.estimate,pricePerZfaMedian:block.pricePerZfaMedian,sampleSize:block.sampleSize,since:block.since,reason:block.reason},
    source:'NYC development ledger: nearby development-site sales (ACRIS bnx9-e6tj, DOB filings)',
    basis:`Land price = ${usd(near.perBuildableSqft)} per as-of-right buildable SF x the lot's ${near.buildableSqft.toLocaleString('en-US')} as-of-right buildable SF = ${usd(near.value)}, the figure the site page shows: the distance-weighted median of ${near.sales} development-site sales ${near.inBorough?"in the lot's borough ":''}within ${near.radiusMiles} miles recorded in the ${near.months} months before ${asOf}, each adjusted to this lot for its standing building, FAR, existing apartments and lot size, a method backtested on sold development sites. ${blockLine}`,
    sourceUrl:LEDGER_DATASETS.acrisMaster.sourceUrl,retrievedAt:store.lastSyncedAt('development_site_sales')??near.asOf,
  };
}

// The ledger reads the calculation tools use, keyed to the selected subject property. nearbyLand(property,{now})
// returns what nearby development sites sold for on the lot's as-of-right area, or {value:null,reason}
// (MarketStore.lotNearbyLand).
export function createSubjectLedger({getProperty=()=>null,openLedger=openSharedLedger,now=()=>new Date(),rates=NYC_TAX_RATES,nearbyLand=null}={}){
  let store=null;
  const open=()=>store??=openLedger();
  const subject=()=>{
    const p=getProperty();
    if(!p?.bbl)throw new Error('Select a subject property with acres_set_subject before using a ledger source.');
    return p;
  };
  return {
    landPriceEstimate:({months=36}={})=>subjectLandPrice(open(),subject(),{nearbyLand,months,now:now()}),
    taxes:()=>taxesFromAssessment(open().assessmentForParcel(subject().bbl),rates),
    // The subject's DOB filed capacity: maxima, the filing count and the latest filings inline, the
    // full list in the recorded source; an unsynced ledger returns the reason so it never reads as zero,
    // and a parcel with no filing returns a note instead of empty figures it could not cite.
    filedCapacity:({record=()=>null,inline=3}={})=>{
      const p=subject(),read=open().filedCapacityForParcel(p.bbl);
      if(!read.retrievedAt)return {ledgerUnsynced:'The development ledger has not been synced for DOB filings, so filed capacity for this parcel is unknown; say so and never report it as zero.'};
      if(!read.filings.length)return {filedCapacityNote:`The development ledger (DOB filings synced ${read.retrievedAt}) holds no DOB filing for this parcel, so there is no filed capacity to report.`};
      const source=record({title:`NYC development ledger: DOB filed capacity for BBL ${p.bbl}`,url:read.sourceUrl,text:JSON.stringify(read,null,2),kind:'official_record'});
      const {filings,...rest}=read;
      return {filedCapacity:{...rest,filingCount:filings.length,latestFilings:filings.slice(0,inline)},sourceId:source?.id??null};
    },
    // The governing filed ZFA proposal for the zoning envelope's headline reconciliation. The
    // envelope never creates the shared ledger: an absent ledger file reads as unsynced.
    latestProposal:()=>{
      const unsynced={proposal:null,reason:'the development ledger has not been synced for DOB filings, so filed ZFA is unknown, not zero'};
      if(!store&&openLedger===openSharedLedger&&!existsSync(ledgerPath()))return unsynced;
      const p=subject(),read=open().filedCapacityForParcel(p.bbl);
      if(!read.retrievedAt)return unsynced;
      const found=latestFiledProposal(read.filings,{now:now(),builtSqft:num(p.bldgarea)});
      return {...(found??{proposal:null}),reason:found?null:`the development ledger has no NB or A1 filing that is not withdrawn for BBL ${p.bbl}`,retrievedAt:read.retrievedAt,sourceUrl:read.sourceUrl};
    },
    pipeline:({months=24}={})=>{
      const p=subject(),z=zip(p.zipcode);
      if(!z)throw new Error(`The subject property ${p.bbl} has no ZIP, so the ledger pipeline cannot be read; record the pipeline with its source instead.`);
      return open().pipelineForZip(z,{months,now:now()});
    },
  };
}

// The nearby pipeline for a listing or site page: unavailable, never empty, when the ledger has no
// synced filings or the place has no NYC coordinates.
export function pagePipeline({latitude,longitude,zip:zipCode=null,bbl=null,openLedger=openSharedLedger,now=new Date()}={}){
  if(!lat(latitude)||!lng(longitude))return {available:false,reason:'no_location'};
  if(openLedger===openSharedLedger&&!existsSync(ledgerPath()))return {available:false,reason:'unsynced'};
  const read=openLedger().nearbyPipeline({latitude,longitude,zip:zip(zipCode),bbl:/^\d{10}$/.test(String(bbl??''))?String(bbl):null,now,limit:12});
  return read.retrievedAt?{available:true,...read}:{available:false,reason:'unsynced'};
}

export const developmentLedgerDefinition={
  name:'acres_development_ledger',
  description:'NYC development ledger (nightly-synced NYC Open Data, parcel keyed) for the subject parcel and its block: arm\'s-length ACRIS land sales on the block with price per maximum zoning floor area (PLUTO lot area x curated district FAR), zoning-lot and easement instruments, DOB filed capacity (proposed zoning floor area, dwelling units, stories, initial cost) for the parcel, the DOF assessed and market value with tax class, the subject\'s land price (nearby development-site sales adjusted to the lot, as its site page shows, or the block median per max ZFA where that gives no figure), the DOB new-building pipeline in the parcel ZIP, and the nearby pipeline: DOB new buildings and major alterations filed or acted on around the subject (default 0.5 mile, 36 months) with units, floor area, stage and whether each reads as condo or rental where an HPD or ACRIS record says so. Records each non-empty read as a citable official record with its ledger retrieval time.',
  inputSchema:{
    type:'object',additionalProperties:false,required:[],
    properties:{
      bbl:{type:'string',description:'Optional 10-digit NYC BBL; defaults to the selected subject property.'},
      zip:{type:'string',pattern:'^\\d{5}$',description:'Optional ZIP for the pipeline read; defaults to the subject property ZIP.'},
      landSaleMonths:{type:'integer',minimum:1,maximum:120,description:'Look-back for block land sales and the block median (default 36); the nearby land price keeps its fixed development-site window.'},
      pipelineMonths:{type:'integer',minimum:1,maximum:120,description:'Look-back for the ZIP pipeline (default 24).'},
      nearbyRadiusMiles:{type:'number',minimum:0.1,maximum:2,description:'Radius of the nearby pipeline around the subject (default 0.5).'},
      nearbyMonths:{type:'integer',minimum:1,maximum:36,description:'Look-back for the nearby pipeline (default 36, the synced filing history).'},
    },
  },
};

export function createDevelopmentLedgerTools({getProperty=()=>null,record=()=>null,emit=()=>{},openLedger=openSharedLedger,now=()=>new Date(),nearbyLand=null}={}){
  let store=null;
  async function run(args={}){
    const property=getProperty();
    const target=args.bbl||property?.bbl;
    if(!target)throw new Error('Supply a 10-digit NYC BBL or select a subject property with acres_set_subject first.');
    const p=parseNycBbl(target);
    store??=openLedger();
    const at=now();
    const landSales=store.landSalesForBlock(p.bbl,{months:args.landSaleMonths??36,now:at});
    const filedCapacity=store.filedCapacityForParcel(p.bbl);
    const assessment=store.assessmentForParcel(p.bbl);
    const zipCode=args.zip??(property?.bbl===p.bbl?zip(property.zipcode):null)??assessment.latest?.zip??null;
    const pipeline=zipCode?store.pipelineForZip(zipCode,{months:args.pipelineMonths??24,now:at}):null;
    const isSubject=property?.bbl===p.bbl;
    const located=isSubject&&lat(property.latitude)&&lng(property.longitude);
    const nearby=located?store.nearbyPipeline({latitude:property.latitude,longitude:property.longitude,zip:zipCode,bbl:p.bbl,radiusMiles:args.nearbyRadiusMiles??NEARBY_RADIUS_MILES,months:args.nearbyMonths??NEARBY_MONTHS,now:at}):null;
    const landPriceEstimate=isSubject?subjectLandPrice(store,property,{nearbyLand,months:args.landSaleMonths??36,now:at})
      :store.landPriceEstimate(p.bbl,{months:args.landSaleMonths??36,now:at});
    const taxes=taxesFromAssessment(assessment);

    const sourceIds={};
    const cite=(key,read,count,title)=>{
      if(!read||!count)return;
      const src=record({title,url:read.sourceUrl,text:JSON.stringify(read,null,2),kind:'official_record'});
      if(src?.id)sourceIds[key]=src.id;
    };
    cite('landSales',landSales,landSales.sales.length+landSales.instruments.length,`NYC development ledger: ACRIS land sales on ${landSales.borough} block ${landSales.block}`);
    cite('filedCapacity',filedCapacity,filedCapacity.filings.length,`NYC development ledger: DOB filed capacity for BBL ${p.bbl}`);
    cite('assessment',assessment,assessment.history.length,`NYC development ledger: DOF assessment for BBL ${p.bbl}`);
    cite('pipeline',pipeline,pipeline?.filings.length,`NYC development ledger: DOB pipeline in ZIP ${zipCode}`);
    cite('landPriceEstimate',landPriceEstimate,landPriceEstimate.method==='nearby_model'?landPriceEstimate.sales.length:0,`NYC development ledger: nearby development-site sales, land price estimate for BBL ${p.bbl}`);
    cite('nearby',nearby,nearby&&nearby.projectCount+nearby.onSubjectLot.length,`NYC development ledger: DOB pipeline within ${nearby?.radiusMiles} mile of BBL ${p.bbl}`);
    emit('development_ledger.read',{bbl:p.bbl,zip:zipCode,sourceIds});

    const unsynced=[['land sales',landSales],['DOB filings',filedCapacity],['assessments',assessment]].filter(([,r])=>!r.retrievedAt).map(([n])=>n);
    return {
      bbl:p.bbl,zip:zipCode,landSales,landPriceEstimate,filedCapacity,assessment,taxes,pipeline,nearby,sourceIds,
      freshness: Object.fromEntries(Object.entries({landSales,filedCapacity,assessment,pipeline,nearby}).filter(([,read])=>read).map(([name,read])=>[name,{retrievedAt:read.retrievedAt,dataAsOf:null,note:'Ledger sync time, not the official dataset update date. Individual record and fiscal dates are reported separately.'}])),
      proseReportingMandate:`IMPORTANT: You called acres_development_ledger. In your final answer, report and cite (using the sourceIds above) the block's arm's-length land sales with ACRIS document ids, amounts, dates and price per ZFA (and why any price per ZFA is null), how many deeds were trimmed and which sales were bundled multi-lot deeds, any zoning-lot or easement instruments, the parcel's DOB filings by job number with proposed zoning floor area, dwelling units and stories (filedCapacity maxEverFiled figures are the largest ever filed, approval not checked, and never the lot's capacity), the latest DOF assessed and market value with tax class and fiscal year, the land price estimate with the basis it states (nearby development-site sales adjusted to the lot, with their count, radius, window and price per buildable SF, cited with sourceIds.landPriceEstimate, or else the block median per ZFA with its sample size and range and the reason the nearby model gave no figure) and the estimate or why it is null, the current-assessment tax estimate with its rate fiscal year and market-value cross-check, the ZIP pipeline totals with approved or permitted units as the pipeline and other stages named as such, and the nearby pipeline: approved or permitted projects, units and floor area within the radius and in the ZIP, with units in review or other stages labelled by stage, how many units read as condo or rental and that the rest have no tenure on record, and the largest nearby projects by DOB job number. Weigh condo against rental by what is going up nearby only on those recorded tenures. State each read's retrievedAt as the ledger retrieval date. These are recorded figures, not appraisals.${unsynced.length?` WARNING: the development ledger has not been synced for ${unsynced.join(', ')}; say the ledger has not been synced for those datasets, never that they returned zero records.`:''}${zipCode?'':' No ZIP was available, so the pipeline read was skipped; say so.'}${nearby?'':' The subject has no coordinates, so the nearby pipeline was not read; say so.'}`,
    };
  }
  return {definitions:[developmentLedgerDefinition],handlers:{acres_development_ledger:run}};
}
