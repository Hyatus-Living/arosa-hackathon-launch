import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  LEDGER_DATASETS,FORMULA_VERSION,LedgerStore,ledgerPath,rowHash,deltaWindow,monthPatterns,
  deriveZfa,classifyDeed,parseBisFiling,parseDobNowFiling,parseAssessment,createDevelopmentLedgerTools,
  taxesFromAssessment,createSubjectLedger,NYC_TAX_RATES,filingStage,
} from './ledger.mjs';
import {syncLedger} from '../scripts/ledger-sync.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/ledger-socrata.json',import.meta.url),'utf8'));
const NOW=new Date('2026-10-16T06:00:00Z');

function tempStore(){return new LedgerStore(join(mkdtempSync(join(tmpdir(),'ledger-')),'ledger.sqlite'));}

function fakeSocrata({empty=[]}={}){
  const calls=[];
  async function request(url,{headers={}}={}){
    calls.push({url,headers});
    const u=new URL(url);
    const view=u.pathname.match(/^\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})\.json$/);
    if(view)return fixture.views[view[1]];
    const id=u.pathname.match(/^\/resource\/([a-z0-9]{4}-[a-z0-9]{4})\.json$/)[1];
    const rows=empty.includes(id)?[]:fixture[id];
    const offset=Number(u.searchParams.get('$offset')||0),limit=Number(u.searchParams.get('$limit'));
    return rows.slice(offset,offset+limit);
  }
  return {request,calls};
}

test('the assessment source is the verified DOF Property Valuation and Assessment dataset',()=>{
  assert.equal(LEDGER_DATASETS.assessments.id,'8y4t-faws');
  assert.equal(LEDGER_DATASETS.assessments.sourceUrl,'https://data.cityofnewyork.us/d/8y4t-faws');
  assert.match(LEDGER_DATASETS.assessments.name,/Property Valuation and Assessment Data/);
  assert.equal(LEDGER_DATASETS.acrisMaster.id,'bnx9-e6tj');
  assert.equal(LEDGER_DATASETS.dobNow.id,'w9ak-ipjd');
});

test('the ledger path resolves under acres-state and honors ACRES_LEDGER_DB',()=>{
  const saved=process.env.ACRES_LEDGER_DB;
  delete process.env.ACRES_LEDGER_DB;
  assert.match(ledgerPath(),/\.openclaw\/acres-state\/ledger\.sqlite$/);
  process.env.ACRES_LEDGER_DB='/tmp/x/ledger.sqlite';
  assert.equal(ledgerPath(),'/tmp/x/ledger.sqlite');
  if(saved===undefined)delete process.env.ACRES_LEDGER_DB;else process.env.ACRES_LEDGER_DB=saved;
});

test('raw Socrata rows parse into typed ledger rows',()=>{
  const bis=parseBisFiling(fixture['ic3t-wcy2'][0]);
  assert.deepEqual({...bis,query_url:undefined},{
    bbl:'1000150001',source:'dob_bis',job_number:'121000001',job_type:'NB',status:'APPROVED',zip:null,
    proposed_zoning_sqft:95000,proposed_dwelling_units:120,proposed_stories:30,initial_cost:45000000,
    filing_date:'2026-09-10',latest_action_date:'2026-10-02',existing_dwelling_units:null,floor_area:110000,latitude:40.72,longitude:-74.005,bin:'1000888',
    address:'10 WEST BROADWAY',query_url:undefined,
  });
  const now=parseDobNowFiling(fixture['w9ak-ipjd'][0]);
  assert.equal(now.source,'dob_now');
  assert.equal(now.job_number,'M00000001-I1');
  assert.equal(now.proposed_zoning_sqft,null,'DOB NOW publishes no zoning floor area');
  assert.equal(now.proposed_dwelling_units,40);
  assert.equal(now.initial_cost,9000000);
  assert.equal(now.filing_date,'2026-09-20');
  assert.equal(now.latest_action_date,'2026-10-05');
  assert.deepEqual([now.floor_area,now.latitude,now.longitude,now.bin,now.address],[52000,40.721,-74.006,'1000999','20 WEST BROADWAY']);
  assert.equal(parseDobNowFiling({...fixture['w9ak-ipjd'][0],latitude:'0',longitude:'0'}).latitude,null,'a zero coordinate is dropped, not placed off the coast');
  const a=parseAssessment(fixture['8y4t-faws'][1]);
  assert.deepEqual({...a,query_url:undefined},{bbl:'1000150001',fiscal_year:2027,period:3,assessed_value:4100000,market_value:9100000,tax_class:'4',zip:'10013',query_url:undefined});
});

test('row hashes ignore key order and fetch metadata',()=>{
  assert.equal(rowHash({a:1,b:'x'}),rowHash({b:'x',a:1}));
  assert.notEqual(rowHash({a:1}),rowHash({a:2}));
  assert.equal(rowHash({a:1,fetched_at:'t1',query_url:'u1',dataset_updated_at:'d1'}),rowHash({a:1,fetched_at:'t2',query_url:'u2',dataset_updated_at:'d2'}));
});

test('upserts are idempotent and only rewrite rows whose content changed',()=>{
  const store=tempStore();
  const row={...parseAssessment(fixture['8y4t-faws'][1]),query_url:'https://data.cityofnewyork.us/resource/8y4t-faws.json',dataset_updated_at:'2026-09-14T00:00:00.000Z',fetched_at:'2026-10-16T06:00:00.000Z'};
  assert.equal(store.upsertAssessment(row),'inserted');
  assert.equal(store.upsertAssessment({...row,fetched_at:'2026-10-17T06:00:00.000Z'}),'unchanged');
  assert.equal(store.upsertAssessment({...row,assessed_value:4200000}),'updated');
  assert.equal(store.count('assessments'),1);
  assert.equal(store.assessmentForParcel('1000150001').latest.assessedValue,4200000);
  store.close();
});

test('delta windows backfill on the first run and overlap the last watermark afterwards',()=>{
  const first=deltaWindow({lastUntil:null,now:NOW,backfillDays:90,lookbackDays:7});
  assert.equal(first.since,'2026-07-18T06:00:00.000');
  assert.equal(first.until,'2026-10-16T06:00:00.000');
  const next=deltaWindow({lastUntil:'2026-10-15T06:00:00.000',now:NOW,backfillDays:90,lookbackDays:7});
  assert.equal(next.since,'2026-10-08T06:00:00.000');
  assert.deepEqual(monthPatterns('2026-09-28T00:00:00.000','2026-11-02T00:00:00.000'),['09/%/2026','10/%/2026','11/%/2026']);
});

test('max ZFA comes from the curated district table; uncurated districts give a reason instead',()=>{
  assert.deepEqual(deriveZfa({lotAreaSqft:10000,zoneDist:'C6-4'}),{maxZfaStandard:100000,maxZfaAffordable:120000,reason:null});
  assert.deepEqual(deriveZfa({lotAreaSqft:10000,zoneDist:'M1-5'}),{maxZfaStandard:50000,maxZfaAffordable:null,reason:null});
  const uncurated=deriveZfa({lotAreaSqft:4000,zoneDist:'M3-1'});
  assert.equal(uncurated.maxZfaStandard,null);
  assert.match(uncurated.reason,/M3-1 is not curated/);
  assert.match(deriveZfa({lotAreaSqft:null,zoneDist:'C6-4'}).reason,/no PLUTO lot area/);
});

test('deed trimming drops nominal, partial and unit conveyances and flags bundled deeds',()=>{
  const base={docType:'DEED',amount:5000000,percentTrans:100,lotCount:1,unit:null,minAmount:100000};
  assert.deepEqual(classifyDeed(base),{armsLength:true,trimReason:null,bundled:false});
  assert.deepEqual(classifyDeed({...base,amount:10}),{armsLength:false,trimReason:'below_floor',bundled:false});
  assert.deepEqual(classifyDeed({...base,percentTrans:50}),{armsLength:false,trimReason:'partial_interest',bundled:false});
  assert.deepEqual(classifyDeed({...base,unit:'7B'}),{armsLength:false,trimReason:'unit_conveyance',bundled:false});
  assert.deepEqual(classifyDeed({...base,lotCount:2}),{armsLength:true,trimReason:null,bundled:true});
  assert.deepEqual(classifyDeed({...base,docType:'ZONE',amount:0}),{armsLength:null,trimReason:'not_a_sale',bundled:false});
});

test('a sync pulls deltas, derives price per ZFA and records counts per dataset',async()=>{
  const store=tempStore();
  const {request,calls}=fakeSocrata();
  const log=[];
  let timestamp=Date.parse('2026-10-18T10:00:00Z');
  const summary=await syncLedger({store,request,now:NOW,clock:()=>new Date(timestamp+=1000),appToken:'tok',log:l=>log.push(l),pageSize:2});
  const timingRows=store.db.prepare('SELECT started_at,finished_at FROM ledger_sync_runs WHERE run_id=? ORDER BY started_at').all(summary.runId);
  assert.equal(timingRows.length,7);assert.ok(summary.datasets.development_site_sales,'development-site sales are read every night');assert.ok(timingRows.every(row=>Date.parse(row.finished_at)-Date.parse(row.started_at)===1000));
  assert.ok(timingRows.every(row=>row.started_at!==NOW.toISOString()));
  assert.ok(calls.filter(c=>c.url.includes('/resource/')).every(c=>c.headers['X-App-Token']==='tok'));
  const master=new URL(calls.find(c=>c.url.includes('/resource/bnx9-e6tj')).url);
  assert.match(master.searchParams.get('$where'),/:updated_at >= '2026-07-18T06:00:00.000'/,'ACRIS publishes weeks late, so the delta keys on the Socrata update time');
  assert.match(master.searchParams.get('$where'),/doc_type in \('DEED','DEEDO','ZONE','AIRRIGHT','DEVR','DECL','EASE'\)/);
  const dobNow=new URL(calls.find(c=>c.url.includes('/resource/w9ak-ipjd')).url);
  assert.match(dobNow.searchParams.get('$where'),/filing_date >= '2023-10-12T06:00:00.000'/,'the first filing read covers the whole multi-year history');
  assert.match(dobNow.searchParams.get('$select'),/latitude,longitude/);
  const condo=new URL(calls.find(c=>c.url.includes('/resource/bnx9-e6tj')&&c.url.includes('CDEC')).url);
  assert.match(condo.searchParams.get('$where'),/doc_type in \('CDEC','SCDEC'\) AND recorded_datetime >= '2023-10-12T06:00:00.000'$/);
  assert.equal(summary.datasets.hpd_production.inserted,1);
  assert.equal(summary.datasets.hpd_production.skipped,1,'an HPD building with no BBL cannot be placed');
  assert.equal(store.db.prepare("SELECT fields_version FROM ledger_sync_runs WHERE run_id=? AND dataset='dob_now'").get(summary.runId).fields_version,'filings-v2');
  assert.deepEqual(summary.datasets.acris,{fetched:7,inserted:8,updated:0,unchanged:0,trimmed:3,bundled:1,skipped:0,alert:null});
  assert.equal(summary.datasets.dob_bis.inserted,1);
  assert.equal(summary.datasets.dob_now.inserted,5);
  assert.equal(summary.datasets.dob_now.skipped,1,'a DOB NOW row with no borough, block and lot is skipped, not fatal');
  assert.equal(store.db.prepare("SELECT bbl FROM dob_filings WHERE job_number='S00000003-I1'").get().bbl,'5052560009');
  assert.equal(store.db.prepare("SELECT skipped FROM ledger_sync_runs WHERE run_id=? AND dataset='dob_now'").get(summary.runId).skipped,1);
  assert.equal(store.db.prepare("SELECT zip FROM dob_filings WHERE job_number='121000001'").get().zip,'10013','BIS publishes only the owner ZIP, so the lot ZIP comes from PLUTO');
  assert.equal(summary.datasets.assessments.inserted,3);

  const sale=store.db.prepare("SELECT * FROM land_sales WHERE doc_id='2026100100000001'").get();
  assert.equal(sale.price_per_zfa,120);
  assert.equal(sale.max_zfa_standard,100000);
  assert.equal(sale.max_zfa_affordable,120000);
  assert.equal(sale.formula_version,FORMULA_VERSION);
  assert.equal(sale.dataset_updated_at,new Date(1791489000*1000).toISOString());
  const bundled=store.db.prepare("SELECT * FROM land_sales WHERE doc_id='2026100100000003' ORDER BY bbl").all();
  assert.equal(bundled.length,2,'one row per distinct lot');
  assert.ok(bundled.every(r=>r.bundled===1&&r.lot_count===2&&r.price_per_zfa===1363.64));
  const uncurated=store.db.prepare("SELECT * FROM land_sales WHERE doc_id='2026100100000004'").get();
  assert.equal(uncurated.price_per_zfa,null);
  assert.match(uncurated.price_per_zfa_reason,/M3-1 is not curated/);
  const nominal=store.db.prepare("SELECT * FROM land_sales WHERE doc_id='2026100100000002'").get();
  assert.equal(nominal.trim_reason,'below_floor');
  assert.equal(nominal.price_per_zfa,null);

  const runs=store.db.prepare('SELECT dataset,status,rows_fetched,inserted FROM ledger_sync_runs WHERE run_id=? ORDER BY dataset').all(summary.runId);
  assert.deepEqual(runs.map(r=>r.dataset),['acris','acris_condo','assessments','development_site_sales','dob_bis','dob_now','hpd_production']);
  assert.ok(runs.every(r=>r.status==='ok'));

  const again=await syncLedger({store,request,now:new Date('2026-10-17T06:00:00Z'),appToken:'tok',log:()=>{},pageSize:2});
  assert.equal(again.datasets.acris.inserted,0);
  assert.equal(again.datasets.acris.unchanged,8);
  assert.equal(again.datasets.dob_now.unchanged,5);
  assert.equal(store.count('land_sales'),8);
  // The land-sale delta, not the development-site sales step, which reads its deeds by document id.
  const second=new URL(calls.filter(c=>c.url.includes('/resource/bnx9-e6tj')&&c.url.includes('DEED')&&!new URL(c.url).searchParams.get('$where').startsWith('document_id in')).at(-1).url);
  assert.match(second.searchParams.get('$where'),/:updated_at >= '2026-10-09T06:00:00.000'/,'the second run overlaps the first watermark by the lookback');
  const secondFilings=new URL(calls.filter(c=>c.url.includes('/resource/w9ak-ipjd')).at(-1).url);
  assert.match(secondFilings.searchParams.get('$where'),/filing_date >= '2026-10-09T06:00:00.000'/,'after the history read, filings sync by delta');
  store.close();
});

test('a dataset that returns zero rows raises an alert line and anonymous access warns',async()=>{
  const store=tempStore();
  const {request,calls}=fakeSocrata({empty:['ic3t-wcy2']});
  const log=[];
  const summary=await syncLedger({store,request,now:NOW,appToken:null,log:l=>log.push(l),pageSize:50});
  assert.ok(log.some(l=>/WARN .*ACRES_SOCRATA_APP_TOKEN/.test(l)));
  assert.ok(calls.every(c=>!('X-App-Token' in c.headers)));
  assert.match(summary.datasets.dob_bis.alert,/ALERT ledger dataset dob_bis \(ic3t-wcy2\) returned 0 rows/);
  assert.ok(log.some(l=>l===summary.datasets.dob_bis.alert));
  assert.equal(store.db.prepare("SELECT alert FROM ledger_sync_runs WHERE dataset='dob_bis'").get().alert,summary.datasets.dob_bis.alert);
  store.close();
});

async function syncedStore(){
  const store=tempStore();
  await syncLedger({store,request:fakeSocrata().request,now:NOW,appToken:'tok',log:()=>{},pageSize:50});
  return store;
}

test('the read API returns typed rows with a basis and retrievedAt',async()=>{
  const store=await syncedStore();
  const block=store.landSalesForBlock('1000150001',{months:12,now:NOW});
  assert.deepEqual(block.sales.map(s=>s.docId).sort(),['2026100100000001','2026100100000003','2026100100000003']);
  assert.deepEqual(block.instruments.map(s=>s.docType),['ZONE']);
  assert.equal(block.trimmedCount,3);
  assert.equal(typeof block.sales[0].documentAmt,'number');
  assert.match(block.basis,/ACRIS .*bnx9-e6tj.*8h5j-fqxa/);
  assert.equal(block.retrievedAt,store.lastSyncedAt('acris'));

  const filed=store.filedCapacityForParcel('1000150001');
  assert.equal(filed.filings.length,1);
  assert.equal(filed.maxEverFiledZoningSqft,95000);
  assert.match(filed.basis,/never the lot's capacity/);
  assert.equal(filed.filings[0].proposedDwellingUnits,120);

  const assessment=store.assessmentForParcel('1000150001');
  assert.deepEqual({fy:assessment.latest.fiscalYear,period:assessment.latest.period,av:assessment.latest.assessedValue},{fy:2027,period:3,av:4100000});
  assert.equal(assessment.history.length,3);
  assert.match(assessment.basis,/8y4t-faws/);

  const pipeline=store.pipelineForZip('10013',{months:24,now:NOW});
  assert.equal(pipeline.filings.length,5);
  assert.equal(pipeline.totals.proposedDwellingUnitsAllStages,160,'withdrawn jobs and follow-on filings (-A1, -P1) of one job are not double counted');
  assert.equal(pipeline.totals.activeJobs,2);
  assert.equal(Object.values(pipeline.totals.byStage).reduce((n,b)=>n+b.proposedDwellingUnits,0),160);
  store.close();
});

test('the ZIP pipeline counts only approved jobs as the pipeline and buckets the rest by stage',()=>{
  const store=tempStore();
  const job=(n,status,units)=>store.upsertDobFiling({bbl:`10001500${n}`,source:'dob_bis',job_number:`12100000${n}`,job_type:'NB',status,zip:'10013',proposed_zoning_sqft:50000,proposed_dwelling_units:units,
    filing_date:'2026-03-01',latest_action_date:'2026-06-01',query_url:'https://data.cityofnewyork.us/resource/ic3t-wcy2.json',fetched_at:'2026-10-16T06:00:00.000Z'});
  job(11,'PERMIT ISSUED - ENTIRE JOB/WORK',40);
  job(12,'PLAN EXAM - DISAPPROVED',300);
  const t=store.pipelineForZip('10013',{months:24,now:NOW}).totals;
  assert.deepEqual(t.byStage,{approved:{jobs:1,proposedDwellingUnits:40},disapproved:{jobs:1,proposedDwellingUnits:300}});
  assert.equal(t.approvedDwellingUnits,40);
  assert.equal(t.approvedJobs,1);
  assert.equal(t.proposedDwellingUnitsAllStages,340);
  store.close();
});

test('the development ledger capability returns the four reads as official-record sources',async()=>{
  const store=await syncedStore();
  const recorded=[];
  const tools=createDevelopmentLedgerTools({
    getProperty:()=>({bbl:'1000150001',zipcode:'10013'}),
    record:s=>{recorded.push(s);return {id:`S${recorded.length}`};},
    emit:()=>{},
    openLedger:()=>store,
    now:()=>NOW,
  });
  assert.deepEqual(tools.definitions.map(d=>d.name),['acres_development_ledger']);
  const out=await tools.handlers.acres_development_ledger({});
  assert.deepEqual(Object.keys(out).sort(),['assessment','bbl','filedCapacity','freshness','landPriceEstimate','landSales','nearby','pipeline','proseReportingMandate','sourceIds','taxes','zip']);
  assert.equal(out.bbl,'1000150001');
  assert.equal(out.freshness.assessment.retrievedAt,out.assessment.retrievedAt);
  assert.equal(out.freshness.assessment.dataAsOf,null);
  assert.deepEqual(Object.keys(out.sourceIds).sort(),['assessment','filedCapacity','landSales','pipeline']);
  assert.equal(recorded.length,4);
  assert.ok(recorded.every(s=>s.kind==='official_record'&&s.url.startsWith('https://data.cityofnewyork.us/')&&s.title&&s.text));
  assert.match(out.proseReportingMandate,/acres_development_ledger/);
  assert.match(out.proseReportingMandate,/price per ZFA/i);
  store.close();
});

test('the capability says the ledger is unsynced instead of reporting zero records',async()=>{
  const store=tempStore();
  const tools=createDevelopmentLedgerTools({getProperty:()=>({bbl:'1000150001',zipcode:'10013'}),record:()=>null,openLedger:()=>store,now:()=>NOW});
  const out=await tools.handlers.acres_development_ledger({});
  assert.equal(out.landSales.retrievedAt,null);
  assert.match(out.proseReportingMandate,/not been synced/);
  store.close();
});

test('capability search finds the ledger for land comps and tax questions',async()=>{
  const {searchCapabilities}=await import('./capabilities.mjs');
  assert.equal(searchCapabilities({query:'land sales price per zfa on the block',kind:'tool'}).results[0].name,'acres_development_ledger');
  assert.equal(searchCapabilities({query:'assessed value and property tax class',kind:'tool'}).results[0].name,'acres_development_ledger');
});

// A priced arm's-length deed on block 15 beside the fixture's two, so the estimate has its minimum sample.
function addSale(store,{docId,lot,amount,pricePerZfa,reason=null,recordedAt='2026-09-15'}){
  store.upsertLandSale({
    bbl:`100015${String(lot).padStart(4,'0')}`,block:15,lot,borough:'1',doc_id:docId,doc_type:'DEED',
    document_amt:amount,recorded_at:recordedAt,lot_area_sqft:4000,zone_dist:'C6-4',zip:'10013',percent_trans:100,lot_count:1,bundled:0,
    arms_length:1,trim_reason:null,max_zfa_standard:reason?null:40000,max_zfa_affordable:null,price_per_zfa:pricePerZfa,
    price_per_zfa_reason:reason,query_url:'https://data.cityofnewyork.us/resource/bnx9-e6tj.json',dataset_updated_at:null,
    fetched_at:'2026-10-16T06:00:00.000Z',formula_version:FORMULA_VERSION,
  });
}
const SUBJECT={lotAreaSqft:10000,zoneDist:'C6-4'};

test('the land price estimate needs three priced arm\'s-length deeds and says why it is null otherwise',async()=>{
  const store=await syncedStore();
  const thin=store.landPriceEstimate('1000150001',{months:12,now:NOW,...SUBJECT});
  assert.equal(thin.sampleSize,2,'the bundled two-lot deed counts once');
  assert.deepEqual(thin.sales.map(s=>s.docId),['2026100100000003','2026100100000001']);
  assert.equal(thin.estimate,null);
  assert.match(thin.reason,/fewer than three/);
  assert.equal(thin.maxZfa,100000);

  addSale(store,{docId:'2026090100000009',lot:6,amount:8000000,pricePerZfa:200});
  addSale(store,{docId:'2026090100000010',lot:8,amount:3000000,pricePerZfa:null,reason:'district M1-1 is not curated in zoning-rules.json'});
  const est=store.landPriceEstimate('1000150001',{months:12,now:NOW,...SUBJECT});
  assert.equal(est.sampleSize,3,'rows with a pricePerZfaReason are excluded');
  assert.ok(!est.sales.some(s=>s.docId==='2026090100000010'));
  assert.deepEqual(est.sales[0],{docId:'2026100100000003',documentAmt:30000000,pricePerZfa:1363.64,recordedAt:'2026-10-03'});
  assert.equal(est.pricePerZfaMedian,200);
  assert.deepEqual(est.pricePerZfaRange,[120,1363.64]);
  assert.equal(est.estimate,20000000,'median price per ZFA x the subject max ZFA');
  assert.equal(est.reason,null);
  assert.match(est.basis,/median .*3 arm's-length/);
  assert.match(est.basis,/2026090100000009/);
  assert.equal(est.retrievedAt,store.lastSyncedAt('acris'));

  const uncurated=store.landPriceEstimate('1000150001',{months:12,now:NOW,lotAreaSqft:10000,zoneDist:'M3-1'});
  assert.equal(uncurated.estimate,null);
  assert.equal(uncurated.pricePerZfaMedian,200,'the block median is still reported');
  assert.match(uncurated.reason,/M3-1 is not curated/);
  store.close();
});

test('an unsynced ledger gives no land price estimate',()=>{
  const store=tempStore();
  const est=store.landPriceEstimate('1000150001',{months:12,now:NOW,...SUBJECT});
  assert.equal(est.estimate,null);
  assert.match(est.reason,/not been synced/);
  store.close();
});

test('the tax rate file carries DOF class rates with provenance for two fiscal years',()=>{
  assert.equal(NYC_TAX_RATES.sourceUrl,'https://www.nyc.gov/site/finance/property/property-tax-rates.page');
  assert.match(NYC_TAX_RATES.retrievedAt,/^\d{4}-\d{2}-\d{2}$/);
  const years=Object.keys(NYC_TAX_RATES.fiscalYears).map(Number).sort();
  assert.ok(years.length>=2);
  for(const y of years)for(const c of ['1','2','3','4'])assert.ok(NYC_TAX_RATES.fiscalYears[y].rates[c]>0.05&&NYC_TAX_RATES.fiscalYears[y].rates[c]<0.3);
});

test('taxes come from assessed value times the class rate, with market value as a cross-check',()=>{
  const rates={sourceUrl:'https://www.nyc.gov/site/finance/property/property-tax-rates.page',retrievedAt:'2026-10-16',
    fiscalYears:{2026:{label:'tax year 2025/26',rates:{1:0.19843,2:0.12439,3:0.11108,4:0.10848}},2025:{label:'tax year 2024/25',rates:{1:0.20085,2:0.125,3:0.11181,4:0.10762}}}};
  const latest={bbl:'1000150001',fiscalYear:2027,period:3,periodLabel:'final',assessedValue:4100000,marketValue:9100000,taxClass:'4'};
  const t=taxesFromAssessment({latest,retrievedAt:'2026-10-16T06:00:00.000Z'},rates);
  assert.equal(t.annualTaxes,444768);
  assert.equal(t.rate,0.10848);
  assert.equal(t.taxClass,'4');
  assert.equal(t.rateFiscalYear,2026);
  assert.equal(t.assessmentFiscalYear,2027);
  assert.match(t.basis,/FY2027 assessment .*FY2026 rate/,'a rate year older than the roll is stated, not hidden');
  assert.match(t.basis,/class 4 \(commercial\)/,'a class 4 figure is labelled commercial');
  assert.equal(t.marketValue,9100000);
  assert.match(t.crossCheck,/4\.89% of the DOF market value/);

  const sameYear=taxesFromAssessment({latest:{...latest,fiscalYear:2026,taxClass:'2A',assessedValue:1000000}},rates);
  assert.equal(sameYear.rate,0.12439,'subclasses take their class rate');
  assert.equal(sameYear.annualTaxes,124390);
  assert.doesNotMatch(sameYear.basis,/older/);

  assert.match(taxesFromAssessment({latest:null},rates).reason,/no DOF assessment/);
  assert.match(taxesFromAssessment({latest:{...latest,fiscalYear:2020}},rates).reason,/no DOF rate/);
});

test('the subject ledger reads the selected property and the tool surfaces the land estimate',async()=>{
  const store=await syncedStore();
  addSale(store,{docId:'2026090100000009',lot:6,amount:8000000,pricePerZfa:200});
  const property={bbl:'1000150001',zipcode:'10013',lotarea:'10000',zonedist1:'C6-4'};
  const ledger=createSubjectLedger({getProperty:()=>property,openLedger:()=>store,now:()=>NOW});
  assert.equal(ledger.landPriceEstimate().estimate,20000000);
  assert.equal(ledger.taxes().assessedValue,4100000);
  assert.equal(ledger.pipeline().totals.proposedDwellingUnitsAllStages,160);
  assert.equal(ledger.pipeline().months,24);
  assert.throws(()=>createSubjectLedger({getProperty:()=>null,openLedger:()=>store}).landPriceEstimate(),/acres_set_subject/);

  const tools=createDevelopmentLedgerTools({getProperty:()=>property,record:()=>({id:'S1'}),openLedger:()=>store,now:()=>NOW});
  const out=await tools.handlers.acres_development_ledger({landSaleMonths:12});
  assert.equal(out.landPriceEstimate.estimate,20000000);
  assert.equal(out.taxes.annualTaxes,taxesFromAssessment(out.assessment,NYC_TAX_RATES).annualTaxes);
  assert.match(out.proseReportingMandate,/land price estimate/i);
  store.close();
});

test('the subject land price leads with the nearby development-site model and states the block median beside it',async()=>{
  const store=await syncedStore();
  addSale(store,{docId:'2026090100000009',lot:6,amount:8000000,pricePerZfa:200});
  const property={bbl:'1000150001',zipcode:'10013',lotarea:'10000',zonedist1:'C6-4',latitude:'40.72',longitude:'-74.0'};
  const near={perBuildableSqft:300,sales:7,radiusMiles:0.6,months:24,asOf:'2026-10-01',value:30000000,buildableSqft:100000,
    model:{comps:[{docId:'S1',bbl:'1000160001',recordedAt:'2026-10-01',price:5000000,miles:0.2,weight:0.819,pricePerBsf:280,adjustedPricePerBsf:300,adjustments:{}}]}};
  const asked=[];
  const est=createSubjectLedger({getProperty:()=>property,openLedger:()=>store,now:()=>NOW,nearbyLand:(p,o)=>{asked.push(o.now);return near;}}).landPriceEstimate();
  assert.deepEqual(asked,[NOW],'the nearby model is read as of the ledger date');
  assert.deepEqual([est.method,est.estimate,est.pricePerBsf,est.buildableSqft,est.sampleSize,est.docIds],['nearby_model',30000000,300,100000,7,['S1']]);
  assert.deepEqual(est.blockMedian,{estimate:20000000,pricePerZfaMedian:200,sampleSize:3,since:'2023-10-16',reason:null});
  assert.match(est.basis,/^Land price = \$300 per as-of-right buildable SF x the lot's 100,000 as-of-right buildable SF = \$30,000,000/);
  assert.match(est.basis,/recorded in the 24 months before 2026-10-16/);
  assert.match(est.basis,/The block median, \$200 per max ZFA of 3 arm's-length deeds on the block since 2023-10-16, would give \$20,000,000\.$/);
  // The fallback states the reason the nearby model gave, never a fixed one.
  const reason="the lot's zoning gives it no as-of-right residential floor area to price";
  const fallback=createSubjectLedger({getProperty:()=>property,openLedger:()=>store,now:()=>NOW,nearbyLand:()=>({value:null,reason})}).landPriceEstimate();
  assert.deepEqual([fallback.method,fallback.estimate,fallback.nearbyModelReason],['block_median',20000000,reason]);
  assert.ok(fallback.basis.endsWith(`The nearby development-site model gives no figure: ${reason}.`));
  assert.doesNotMatch(fallback.basis,/fewer than five/);
  assert.match(createSubjectLedger({getProperty:()=>property,openLedger:()=>store,now:()=>NOW}).landPriceEstimate().basis,/market store holding the nearby development-site sales is not available/);
  const recorded=[];
  const tools=createDevelopmentLedgerTools({getProperty:()=>property,record:s=>{recorded.push(s);return {id:`S${recorded.length}`};},openLedger:()=>store,now:()=>NOW,nearbyLand:()=>near});
  const out=await tools.handlers.acres_development_ledger({landSaleMonths:12});
  assert.equal(out.landPriceEstimate.method,'nearby_model');
  const cited=recorded[Number(out.sourceIds.landPriceEstimate.slice(1))-1];
  assert.match(cited.title,/nearby development-site sales, land price estimate for BBL 1000150001/);
  assert.deepEqual(JSON.parse(cited.text).docIds,['S1'],'the nearby comps are the cited record');
  assert.equal(out.landPriceEstimate.blockMedian.since,'2025-10-16','landSaleMonths sets the block window');
  assert.match(out.landPriceEstimate.basis,/24 months before 2026-10-16/,'the nearby model keeps its own window, named');
  assert.match(out.proseReportingMandate,/sourceIds\.landPriceEstimate/);
  store.close();
});

test('DOB NOW filings key on borough, block and lot because the published bbl is often empty',()=>{
  const base={job_filing_number:'S01343161-I1',job_type:'New Building',filing_status:'Approved',block:'5256',lot:'9',bin:'5000001'};
  assert.equal(parseDobNowFiling({...base,borough:'Staten Island'}).bbl,'5052560009','no bbl field, mixed-case borough');
  assert.equal(parseDobNowFiling({...base,borough:'Brooklyn',block:'4430',lot:'1',bbl:'3044300001'}).bbl,'3044300001');
  assert.equal(parseDobNowFiling({...base,borough:'QUEENS',block:'4972',lot:'59',bbl:''}).bbl,'4049720059');
  assert.equal(parseDobNowFiling({...base,borough:'Manhattan',block:undefined,lot:undefined}).bbl,null,'an unkeyable row parses to a null bbl');
  assert.equal(parseDobNowFiling({...base,borough:'Nowhere'}).bbl,null);
  assert.equal(parseBisFiling({...fixture['ic3t-wcy2'][0],borough:'Manhattan'}).bbl,'1000150001','BIS borough lookup is case-insensitive too');
});

test('opening a ledger created before the skipped column adds it in place',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const path=join(mkdtempSync(join(tmpdir(),'ledger-old-')),'ledger.sqlite');
  const old=new DatabaseSync(path);
  old.exec("CREATE TABLE ledger_sync_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,dataset TEXT NOT NULL,dataset_id TEXT NOT NULL,since TEXT NOT NULL,until TEXT NOT NULL,rows_fetched INTEGER NOT NULL,inserted INTEGER NOT NULL,updated INTEGER NOT NULL,unchanged INTEGER NOT NULL,trimmed INTEGER NOT NULL,status TEXT NOT NULL,alert TEXT,started_at TEXT NOT NULL,finished_at TEXT NOT NULL)");
  old.exec("INSERT INTO ledger_sync_runs(run_id,dataset,dataset_id,since,until,rows_fetched,inserted,updated,unchanged,trimmed,status,started_at,finished_at) VALUES('r','dob_bis','ic3t-wcy2','a','b',1,1,0,0,0,'ok','t','t')");
  old.close();
  const store=new LedgerStore(path);
  assert.equal(store.db.prepare('SELECT skipped FROM ledger_sync_runs').get().skipped,0);
  store.close();
  new LedgerStore(path).close();
});

function scriptedFetch(steps){
  const calls=[];
  const fetchImpl=async url=>{
    calls.push(url);
    const step=steps[Math.min(calls.length-1,steps.length-1)];
    if(step instanceof Error)throw step;
    return {ok:step.status<400,status:step.status,json:async()=>step.body};
  };
  return {fetchImpl,calls};
}
const socketError=()=>new TypeError('fetch failed',{cause:Object.assign(new Error('other side closed'),{code:'UND_ERR_SOCKET'})});

test('the sync request retries a dropped connection with the same backoff',async()=>{
  const {defaultRequest}=await import('../scripts/ledger-sync.mjs');
  const {fetchImpl,calls}=scriptedFetch([socketError(),{status:200,body:[{parid:'1'}]}]);
  const sleeps=[];
  const rows=await defaultRequest('https://data.cityofnewyork.us/resource/8y4t-faws.json',{fetchImpl,sleep:async ms=>{sleeps.push(ms);}});
  assert.deepEqual(rows,[{parid:'1'}]);
  assert.equal(calls.length,2);
  assert.deepEqual(sleeps,[2000]);
});

test('the sync request retries timeouts and reset connections, then rethrows the last network error',async()=>{
  const {defaultRequest}=await import('../scripts/ledger-sync.mjs');
  const timeout=new DOMException('The operation was aborted due to timeout','TimeoutError');
  const reset=Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'});
  const last=new Error('fetch failed',{cause:{code:'ECONNREFUSED'}});
  const {fetchImpl,calls}=scriptedFetch([timeout,reset,last]);
  const sleeps=[];
  await assert.rejects(defaultRequest('https://x.test/a',{fetchImpl,sleep:async ms=>{sleeps.push(ms);}}),err=>err===last);
  assert.equal(calls.length,3);
  assert.deepEqual(sleeps,[2000,4000]);
});

test('the sync request does not retry a 404 or an error that is not a network failure',async()=>{
  const {defaultRequest}=await import('../scripts/ledger-sync.mjs');
  const notFound=scriptedFetch([{status:404}]);
  const sleeps=[];
  await assert.rejects(defaultRequest('https://x.test/missing',{fetchImpl:notFound.fetchImpl,sleep:async ms=>{sleeps.push(ms);}}),/HTTP 404/);
  assert.equal(notFound.calls.length,1);
  const bug=scriptedFetch([new RangeError('bad header')]);
  await assert.rejects(defaultRequest('https://x.test/b',{fetchImpl:bug.fetchImpl,sleep:async ms=>{sleeps.push(ms);}}),RangeError);
  assert.equal(bug.calls.length,1);
  assert.deepEqual(sleeps,[]);
  const throttled=scriptedFetch([{status:429},{status:503},{status:200,body:[]}]);
  assert.deepEqual(await defaultRequest('https://x.test/c',{fetchImpl:throttled.fetchImpl,sleep:async()=>{}}),[]);
  assert.equal(throttled.calls.length,3,'429 and 5xx keep retrying as before');
});

test('filing stages read BIS and DOB NOW statuses alike',()=>{
  const cases={
    'PERMIT ISSUED - ENTIRE JOB/WORK':'approved','APPROVED':'approved','Permit Entire':'approved','Approved':'approved',
    'PLAN EXAM - DISAPPROVED':'disapproved','Objections':'disapproved','SIGNED OFF':'completed','Signed-off':'completed','LOC Issued':'completed',
    'PRE-FILING':'pre_filing','Pre-Filing':'pre_filing','PLAN EXAM - IN PROCESS':'in_review','Plan Examiner Review':'in_review',
    'WITHDRAWN':'withdrawn','Withdrawn':'withdrawn','':'unknown',
  };
  for(const [status,stage] of Object.entries(cases))assert.equal(filingStage(status),stage,status);
});
