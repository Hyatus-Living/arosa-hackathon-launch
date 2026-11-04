import {pathToFileURL} from 'node:url';
import {
  LEDGER_DATASETS,LAND_DOC_TYPES,CONDO_DOC_TYPES,FORMULA_VERSION,FILING_FIELDS_VERSION,LedgerStore,ledgerPath,deltaWindow,monthPatterns,
  deriveZfa,classifyDeed,parseBisFiling,parseDobNowFiling,parseAssessment,parseHpdBuilding,parseCondoDeclaration,composeBbl,num,
  DEVELOPMENT_SITE_SALES,developmentSiteSale,
} from '../acres-research/ledger.mjs';

// Nightly delta sync of the NYC development ledger from NYC Open Data (Socrata).
// Each dataset pulls from its last successful watermark minus a look-back so late
// records are caught; upserts are hash-guarded, so re-reading a window is a no-op.

const BIS_JOB_TYPES=['NB','A1','DM'];
// Only the fields the parsers read, which keeps the multi-year citywide filing history light.
const BIS_FIELDS='job__,doc__,job_type,job_status_descrp,borough,block,lot,bin__,house__,street_name,proposed_zoning_sqft,proposed_dwelling_units,existing_dwelling_units,proposed_no_of_stories,initial_cost,pre__filing_date,latest_action_date,total_construction_floor_area,gis_latitude,gis_longitude';
const DOB_NOW_FIELDS='job_filing_number,job_type,filing_status,borough,block,lot,bin,house_no,street_name,postcode,proposed_dwelling_units,existing_dwelling_units,proposed_no_of_stories,initial_cost,filing_date,current_status_date,total_construction_floor_area,latitude,longitude';
const HPD_FIELDS='project_id,building_id,project_start_date,house_number,street_name,bbl,bin,counted_rental_units,counted_homeownership_units';
const DOB_NOW_JOB_TYPES=['New Building','ALT-CO - New Building with Existing Elements to Remain','Alteration CO','Full Demolition'];
const BATCH=100;

// A dropped connection (undici "fetch failed", ECONNRESET) or a timed-out request is
// transient like a 429 or 5xx; anything else (a 4xx, a bug) fails on the first try.
const networkFailure=err=>err instanceof TypeError||['AbortError','TimeoutError'].includes(err?.name)
  ||/^(UND_ERR|ECONN)/.test(err?.code??'')||/^(UND_ERR|ECONN)/.test(err?.cause?.code??'');

export async function defaultRequest(url,{headers={},fetchImpl=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let lastErr;
  for(let attempt=0;attempt<3;attempt++){
    let res;
    try{
      res=await fetchImpl(url,{headers,signal:AbortSignal.timeout(60000)});
    }catch(err){
      if(!networkFailure(err))throw err;
      lastErr=err;
    }
    if(res?.ok)return res.json();
    if(res){
      lastErr=new Error(`NYC Open Data returned HTTP ${res.status} for ${url}`);
      if(res.status!==429&&res.status<500)break;
    }
    if(attempt<2)await sleep(2000*(attempt+1));
  }
  throw lastErr;
}

const quoted=values=>values.map(v=>`'${v}'`).join(',');
const chunks=(list,size)=>Array.from({length:Math.ceil(list.length/size)},(_,i)=>list.slice(i*size,(i+1)*size));
const resourceUrl=(ds,params)=>`${ds.resourceUrl}?${new URLSearchParams(params)}`;

export async function syncLedger({
  store,request=defaultRequest,now=new Date(),clock=()=>new Date(),appToken=process.env.ACRES_SOCRATA_APP_TOKEN,log=console.log,pageSize=5000,
  minDeedAmount=Number(process.env.ACRES_LEDGER_MIN_DEED_AMT||100000),backfillDays=Number(process.env.ACRES_LEDGER_BACKFILL_DAYS||90),lookbackDays=7,
  filingHistoryDays=Number(process.env.ACRES_LEDGER_FILING_HISTORY_DAYS||1100),
}){
  const headers=appToken?{'X-App-Token':appToken}:{};
  if(!appToken)log('WARN ACRES_SOCRATA_APP_TOKEN is not set; querying NYC Open Data anonymously, which is throttled.');
  const fetchedAt=now.toISOString();
  const runId=`ledger-${fetchedAt}`;
  const updatedAt={};
  const datasetUpdatedAt=async ds=>updatedAt[ds.id]??=new Date((await request(`https://data.cityofnewyork.us/api/views/${ds.id}.json`,{headers})).rowsUpdatedAt*1000).toISOString();

  async function pageAll(ds,params){
    const rows=[];
    for(let offset=0;;offset+=pageSize){
      const page=await request(resourceUrl(ds,{...params,$limit:pageSize,$offset:offset}),{headers});
      rows.push(...page);
      if(page.length<pageSize)return rows;
    }
  }

  const datasets={};
  function finish(name,ds,window,counts,startedAt,fieldsVersion=null){
    const alert=counts.fetched===0?`ALERT ledger dataset ${name} (${ds.id}) returned 0 rows for ${window.since} to ${window.until}`:null;
    if(alert)log(alert);
    log(`ledger dataset ${name} (${ds.id}) fetched=${counts.fetched} inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged} trimmed=${counts.trimmed} bundled=${counts.bundled} skipped=${counts.skipped}`);
    store.recordRun({
      run_id:runId,dataset:name,dataset_id:ds.id,since:window.since,until:window.until,rows_fetched:counts.fetched,inserted:counts.inserted,
      updated:counts.updated,unchanged:counts.unchanged,trimmed:counts.trimmed,skipped:counts.skipped,status:'ok',alert,started_at:startedAt,finished_at:clock().toISOString(),
      fields_version:fieldsVersion,
    });
    datasets[name]={...counts,alert};
  }
  async function plutoParcels(bbls){
    const parcels=new Map();
    for(const ids of chunks([...new Set(bbls)],BATCH)){
      for(const p of await pageAll(LEDGER_DATASETS.pluto,{$select:'bbl,lotarea,zonedist1,zipcode',$where:`bbl in (${ids.join(',')})`,$order:'bbl'})){
        parcels.set(String(Math.round(Number(p.bbl))),{lotAreaSqft:num(p.lotarea),zoneDist:p.zonedist1??null,zip:p.zipcode??null});
      }
    }
    return parcels;
  }
  const tally=()=>({fetched:0,inserted:0,updated:0,unchanged:0,trimmed:0,bundled:0,skipped:0});
  const window=name=>deltaWindow({lastUntil:store.lastUntil(name),now,backfillDays,lookbackDays});
  // The nearby pipeline reads years of filings citywide: a dataset with no run at the current fields
  // version reads the whole history once, then only the delta.
  const historyWindow=name=>deltaWindow({lastUntil:store.lastUntil(name,FILING_FIELDS_VERSION),now,backfillDays:filingHistoryDays,lookbackDays});
  const historyStart=deltaWindow({lastUntil:null,now,backfillDays:filingHistoryDays,lookbackDays}).since;
  const touched=new Set();

  // ACRIS: master rows published or corrected in the window (recordings appear weeks
  // after recorded_datetime, so the delta keys on the Socrata update time), their lots
  // from Legals, lot area and district from PLUTO.
  {
    const w=window('acris'),c=tally(),startedAt=clock().toISOString();
    const masterParams={$where:`:updated_at >= '${w.since}' AND :updated_at < '${w.until}' AND doc_type in (${quoted(LAND_DOC_TYPES)})`,$order:'document_id'};
    const master=await pageAll(LEDGER_DATASETS.acrisMaster,masterParams);
    c.fetched=master.length;
    const queryUrl=resourceUrl(LEDGER_DATASETS.acrisMaster,masterParams);
    const lotsByDoc=new Map();
    for(const ids of chunks(master.map(m=>m.document_id),BATCH)){
      for(const l of await pageAll(LEDGER_DATASETS.acrisLegals,{$where:`document_id in (${quoted(ids)})`,$order:'document_id,borough,block,lot'})){
        const bbl=composeBbl(l.borough,l.block,l.lot);
        const lots=lotsByDoc.get(l.document_id)??new Map();
        if(!lots.has(bbl))lots.set(bbl,{bbl,borough:String(l.borough),block:Number(l.block),lot:Number(l.lot),unit:l.unit||null});
        lotsByDoc.set(l.document_id,lots);
      }
    }
    const parcels=await plutoParcels([...lotsByDoc.values()].flatMap(lots=>[...lots.keys()]));
    const datasetUpdated=await datasetUpdatedAt(LEDGER_DATASETS.acrisMaster);
    for(const m of master){
      const lots=[...(lotsByDoc.get(m.document_id)?.values()??[])];
      const amount=num(m.document_amt),percentTrans=num(m.percent_trans);
      const deed=classifyDeed({docType:m.doc_type,amount,percentTrans,lotCount:lots.length,unit:lots.some(l=>l.unit),minAmount:minDeedAmount});
      if(deed.armsLength===false)c.trimmed++;
      if(deed.bundled&&deed.armsLength)c.bundled++;
      const zfa=lots.map(l=>({...l,...parcels.get(l.bbl),...deriveZfa(parcels.get(l.bbl)??{})}));
      let pricePerZfa=null,reason;
      if(deed.armsLength===null)reason='not a sale instrument';
      else if(!deed.armsLength)reason=`excluded: ${deed.trimReason}`;
      else{
        const missing=zfa.find(l=>l.maxZfaStandard===null);
        if(missing)reason=lots.length>1?`lot ${missing.bbl}: ${missing.reason}`:missing.reason;
        else pricePerZfa=Math.round(amount/zfa.reduce((s,l)=>s+l.maxZfaStandard,0)*100)/100;
      }
      for(const l of zfa){
        if(deed.armsLength!==false)touched.add(l.bbl);
        c[store.upsertLandSale({
          bbl:l.bbl,block:l.block,lot:l.lot,borough:l.borough,doc_id:m.document_id,doc_type:m.doc_type,document_amt:amount,
          recorded_at:m.recorded_datetime.slice(0,10),lot_area_sqft:l.lotAreaSqft??null,zone_dist:l.zoneDist??null,zip:l.zip??null,
          percent_trans:percentTrans,lot_count:lots.length,bundled:deed.bundled?1:0,arms_length:deed.armsLength===null?null:deed.armsLength?1:0,
          trim_reason:deed.trimReason,max_zfa_standard:l.maxZfaStandard,max_zfa_affordable:l.maxZfaAffordable,price_per_zfa:pricePerZfa,
          price_per_zfa_reason:reason??null,query_url:queryUrl,dataset_updated_at:datasetUpdated,fetched_at:fetchedAt,formula_version:FORMULA_VERSION,
        })]++;
      }
    }
    finish('acris',LEDGER_DATASETS.acrisMaster,w,c,startedAt);
  }

  async function syncFilings(name,ds,params,parse){
    const w=historyWindow(name),c=tally(),startedAt=clock().toISOString();
    // A history read touches every lot filed on in years; their assessments arrive with later deltas.
    const delta=Boolean(store.lastUntil(name,FILING_FIELDS_VERSION));
    const p=params(w);
    const rows=await pageAll(ds,p);
    c.fetched=rows.length;
    const queryUrl=resourceUrl(ds,p),datasetUpdated=await datasetUpdatedAt(ds);
    const keyed=rows.map(parse);
    const parsed=keyed.filter(r=>r.bbl);
    c.skipped=keyed.length-parsed.length;
    // DOB BIS publishes no ZIP; the pipeline read is by ZIP, so take it from PLUTO.
    const parcels=await plutoParcels(parsed.filter(r=>!r.zip).map(r=>r.bbl));
    // One transaction per dataset: a history read writes a hundred thousand filings.
    store.db.exec('BEGIN');
    for(const row of parsed){
      if(delta)touched.add(row.bbl);
      c[store.upsertDobFiling({...row,zip:row.zip??parcels.get(row.bbl)?.zip??null,query_url:queryUrl,dataset_updated_at:datasetUpdated,fetched_at:fetchedAt})]++;
    }
    store.db.exec('COMMIT');
    finish(name,ds,w,c,startedAt,FILING_FIELDS_VERSION);
  }
  await syncFilings('dob_bis',LEDGER_DATASETS.dobBis,w=>{
    const months=monthPatterns(w.since,w.until).flatMap(m=>[`pre__filing_date like '${m}'`,`latest_action_date like '${m}'`]);
    return {$select:BIS_FIELDS,$where:`doc__='01' AND job_type in (${quoted(BIS_JOB_TYPES)}) AND (${months.join(' OR ')})`,$order:'job__'};
  },parseBisFiling);
  await syncFilings('dob_now',LEDGER_DATASETS.dobNow,w=>({
    $select:DOB_NOW_FIELDS,
    $where:`job_type in (${quoted(DOB_NOW_JOB_TYPES)}) AND (filing_date >= '${w.since}' OR current_status_date >= '${w.since}')`,$order:'job_filing_number',
  }),parseDobNowFiling);

  // Tenure records for the pipeline: HPD counted rental and homeownership units by building, the
  // whole table on the first run and the rows HPD changed afterwards.
  {
    const name='hpd_production',ds=LEDGER_DATASETS.hpdProduction,c=tally(),startedAt=clock().toISOString();
    const last=store.lastUntil(name,FILING_FIELDS_VERSION),w=historyWindow(name);
    const params={$select:HPD_FIELDS,$where:`bbl IS NOT NULL${last?` AND :updated_at >= '${w.since}'`:''}`,$order:'project_id,building_id'};
    const rows=await pageAll(ds,params);
    c.fetched=rows.length;
    const queryUrl=resourceUrl(ds,params),datasetUpdated=await datasetUpdatedAt(ds);
    const parsed=rows.map(parseHpdBuilding).filter(r=>r.bbl);
    c.skipped=rows.length-parsed.length;
    for(const row of parsed)c[store.upsertTenureRecord({...row,query_url:queryUrl,dataset_updated_at:datasetUpdated,fetched_at:fetchedAt})]++;
    finish(name,ds,w,c,startedAt,FILING_FIELDS_VERSION);
  }

  // ACRIS condominium declarations recorded within the filing history, keyed to their land lot and
  // address, with the declaration's residential unit lots counted by type.
  {
    const name='acris_condo',ds=LEDGER_DATASETS.acrisMaster,c=tally(),startedAt=clock().toISOString();
    const last=store.lastUntil(name,FILING_FIELDS_VERSION),w=historyWindow(name);
    const params={$select:'document_id,doc_type,recorded_datetime',$where:`doc_type in (${quoted(CONDO_DOC_TYPES)}) AND recorded_datetime >= '${historyStart}'${last?` AND :updated_at >= '${w.since}'`:''}`,$order:'document_id'};
    const master=(await pageAll(ds,params)).filter(m=>CONDO_DOC_TYPES.includes(m.doc_type));
    c.fetched=master.length;
    const queryUrl=resourceUrl(ds,params),datasetUpdated=await datasetUpdatedAt(ds);
    const byDoc=new Map(master.map(m=>[m.document_id,m]));
    const groups=new Map(),units=new Map();
    for(const ids of chunks([...byDoc.keys()],BATCH)){
      const legals=await pageAll(LEDGER_DATASETS.acrisLegals,{
        $select:'document_id,borough,block,street_number,street_name,property_type,min(lot) as min_lot,count(*) as n',
        $where:`document_id in (${quoted(ids)})`,$group:'document_id,borough,block,street_number,street_name,property_type',
        $order:'document_id,borough,block,street_number,street_name,property_type',
      });
      for(const l of legals){
        const u=units.get(l.document_id)??{single:0,multiple:0};
        if(l.property_type==='SC')u.single+=Number(l.n);
        if(l.property_type==='MC')u.multiple+=Number(l.n);
        units.set(l.document_id,u);
        // A declaration names its land lot (under 1001) beside the new unit lots; without one the lowest unit lot stands in.
        const key=[l.document_id,l.borough,l.block,l.street_number??'',l.street_name??''].join('|'),lot=Number(l.min_lot),held=groups.get(key);
        const land=lot<1001,heldLand=held&&held.lot<1001;
        if(!held||(land&&!heldLand)||(land===heldLand&&lot<held.lot))groups.set(key,{...l,lot});
      }
    }
    for(const l of groups.values()){
      c[store.upsertTenureRecord({...parseCondoDeclaration(byDoc.get(l.document_id),l,units.get(l.document_id)),query_url:queryUrl,dataset_updated_at:datasetUpdated,fetched_at:fetchedAt})]++;
    }
    finish(name,ds,w,c,startedAt,FILING_FIELDS_VERSION);
  }

  // Development-site sales: deeds on lots with a new-building or demolition filing, re-read over the whole
  // window each night (the filing can follow the deed by years), with each lot's PLUTO record for its envelope.
  {
    const name='development_site_sales',ds=LEDGER_DATASETS.acrisMaster,c=tally(),startedAt=clock().toISOString();
    const D=DEVELOPMENT_SITE_SALES,since=new Date(now.getTime()-D.months*30.4375*86400000).toISOString().slice(0,10);
    const w={since,until:fetchedAt};
    const filings=new Map();
    for(const f of store.developmentFilingLots({since:new Date(Date.parse(since)-D.filingLeadDays*86400000).toISOString().slice(0,10)})){
      if(!filings.has(f.bbl))filings.set(f.bbl,[]);
      filings.get(f.bbl).push(f);
    }
    const lotOf=l=>composeBbl(l.borough,l.block,l.lot);
    const docLots=new Map();
    for(const lots of chunks([...filings.keys()],BATCH)){
      const where=lots.map(b=>`(borough='${b[0]}' AND block='${Number(b.slice(1,6))}' AND lot='${Number(b.slice(6))}')`).join(' OR ');
      for(const l of await pageAll(LEDGER_DATASETS.acrisLegals,{$select:'document_id,borough,block,lot',$where:where,$order:'document_id'})){
        if(!docLots.has(l.document_id))docLots.set(l.document_id,lotOf(l));
      }
    }
    const deeds=[];
    for(const ids of chunks([...docLots.keys()],BATCH)){
      deeds.push(...await pageAll(ds,{$select:'document_id,doc_type,document_amt,recorded_datetime,percent_trans',
        $where:`document_id in (${quoted(ids)}) AND doc_type in (${quoted(D.deedTypes)}) AND recorded_datetime >= '${since}'`,$order:'document_id'}));
    }
    const lotCounts=new Map();
    for(const ids of chunks(deeds.map(d=>d.document_id),BATCH)){
      for(const r of await pageAll(LEDGER_DATASETS.acrisLegals,{$select:'document_id,count(*) as n',$where:`document_id in (${quoted(ids)})`,$group:'document_id',$order:'document_id'})){
        lotCounts.set(r.document_id,Number(r.n));
      }
    }
    const sales=deeds.map(deed=>{
      const bbl=docLots.get(deed.document_id);
      const sale=developmentSiteSale({deed,lotCount:lotCounts.get(deed.document_id),filings:filings.get(bbl)});
      return sale&&{...sale,bbl};
    }).filter(Boolean);
    c.fetched=deeds.length;c.skipped=deeds.length-sales.length;
    const pluto=new Map();
    for(const ids of chunks([...new Set(sales.map(s=>s.bbl))],BATCH)){
      for(const p of await pageAll(LEDGER_DATASETS.pluto,{$where:`bbl in (${ids.join(',')})`,$order:'bbl'}))pluto.set(String(Math.round(Number(p.bbl))),p);
    }
    const queryUrl=resourceUrl(ds,{$where:`doc_type in (${quoted(D.deedTypes)}) AND recorded_datetime >= '${since}'`}),datasetUpdated=await datasetUpdatedAt(ds);
    for(const sale of sales){
      const p=pluto.get(sale.bbl);
      if(!p){c.skipped++;continue;}
      c[store.upsertDevelopmentSiteSale({...sale,zip:p.zipcode??null,latitude:num(p.latitude),longitude:Number(p.longitude)||null,
        pluto_json:JSON.stringify({...p,bbl:sale.bbl}),query_url:queryUrl,dataset_updated_at:datasetUpdated,fetched_at:fetchedAt})]++;
    }
    finish(name,ds,w,c,startedAt);
  }

  // Assessments: rows DOF changed in the window, plus every parcel this run touched.
  {
    const w=window('assessments'),c=tally(),ds=LEDGER_DATASETS.assessments,startedAt=clock().toISOString();
    const deltaParams={$where:`:updated_at >= '${w.since}'`,$order:'parid,year,period'};
    const batches=[{params:deltaParams,rows:await pageAll(ds,deltaParams)}];
    for(const ids of chunks([...touched].sort(),BATCH)){
      const params={$where:`parid in (${quoted(ids)})`,$order:'parid,year,period'};
      batches.push({params,rows:await pageAll(ds,params)});
    }
    const datasetUpdated=await datasetUpdatedAt(ds);
    for(const {params,rows} of batches){
      c.fetched+=rows.length;
      const queryUrl=resourceUrl(ds,params);
      for(const raw of rows)c[store.upsertAssessment({...parseAssessment(raw),query_url:queryUrl,dataset_updated_at:datasetUpdated,fetched_at:fetchedAt})]++;
    }
    finish('assessments',ds,w,c,startedAt);
  }

  return {runId,datasets};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const store=new LedgerStore(ledgerPath());
  const summary=await syncLedger({store});
  store.close();
  console.log(JSON.stringify({event:'ledger_sync_completed',...summary}));
}
