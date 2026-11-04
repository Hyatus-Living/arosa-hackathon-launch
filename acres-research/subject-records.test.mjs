import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BUDGET} from './tools.mjs';
import {research} from './research.mjs';
import {validateCitations} from './lanes.mjs';
import {installOfflinePublicWeb} from './testing/public-web.mjs';
import {fetchNycPublicRecords,publicRecordsDigest} from './nycdb.mjs';

// Scripted underwriting runs on a synthetic Manhattan lot. Zoning map lookups (ArcGIS and the existing
// floor area query) and NYC Open Data records answer after timed delays; the PLUTO row answers at once.
const briefBbl='1000470012';
const briefRow={bbl:briefBbl,address:'1 EXAMPLE STREET',borough:'MN',block:'47',lot:'12',zonedist1:'R9A',lotarea:'10000',lotfront:'100',lotdepth:'100',bldgarea:'5000',yearbuilt:'1960',zipcode:'10004'};
const briefRecords={
  'ic3t-wcy2':[{job__:'121000009',doc__:'01',job_type:'NB',job_status:'R',job_status_descrp:'PERMIT ISSUED - ENTIRE JOB/WORK',latest_action_date:'05/01/2026',proposed_zoning_sqft:'72000',proposed_dwelling_units:'80',proposed_no_of_stories:'20',lot:'12'},
    {job__:'120000001',doc__:'01',job_type:'A1',job_status:'R',job_status_descrp:'PERMIT ISSUED - ENTIRE JOB/WORK',latest_action_date:'03/15/1993',lot:'12'}],
  'w9ak-ipjd':[{job_filing_number:'M00000001-I1',job_type:'ALT-CO - New Building with Existing Elements to Remain',filing_status:'Permit Entire',filing_date:'2025-02-01T00:00:00.000',current_status_date:'2025-09-01T00:00:00.000',lot:'12'},
    {job_filing_number:'M00000002-I1',job_type:'New Building',filing_status:'CO Issued',current_status_date:'2025-06-01T00:00:00.000',lot:'12'},
    {job_filing_number:'M00000003-I1',job_type:'New Building',filing_status:'LL 158-2017-Denied',current_status_date:'2025-07-01T00:00:00.000',lot:'12'}],
  'bs8b-p36w':[{job_number:'100000001',job_type:'NB',c_o_issue_date:'1961-03-01T00:00:00.000',issue_type:'Final',pr_dwelling_unit:'40'}],
  '3h2n-5cm9':[{number:'V1',issue_date:'20250101',violation_type:'C-CONSTRUCTION',violation_category:'V-DOB VIOLATION - ACTIVE'},{number:'V2',issue_date:'20200101',violation_type:'C-CONSTRUCTION',violation_category:'V*-DOB VIOLATION - DISMISSED'}],
  '6bgk-3dad':[{ecb_violation_number:'E1',ecb_violation_status:'ACTIVE',severity:'CLASS - 1',violation_type:'Construction',balance_due:'2500'}],
  'wvxf-dwi5':[{violationid:'H1',class:'C',violationstatus:'Open',inspectiondate:'2026-01-01T00:00:00.000'}],
  '8h5j-fqxa':[{document_id:'D1',borough:'1',block:'47',lot:'12',air_rights:'N',easement:'N'},{document_id:'D2',borough:'1',block:'47',lot:'12',air_rights:'N',easement:'N'}],
  'bnx9-e6tj':[{document_id:'D1',doc_type:'DEED',crfn:'2020000001',document_date:'2020-01-01T00:00:00.000',recorded_datetime:'2020-01-10T00:00:00.000',document_amt:'9000000'},
    {document_id:'D2',doc_type:'MTGE',crfn:'2022000002',document_date:'2022-03-01T00:00:00.000',recorded_datetime:'2022-03-10T00:00:00.000',document_amt:'5000000'}],
  '636b-3b5g':[{document_id:'D1',party_type:'1',name:'PRIOR SELLER LLC'},{document_id:'D1',party_type:'2',name:'EXAMPLE OWNER LLC'}],
};
async function underwritingRun({recordsDelay,act}){
  const restoreWeb=installOfflinePublicWeb();
  const dir=mkdtempSync(join(tmpdir(),'research-brief-')),original=global.fetch,savedLedger=process.env.ACRES_LEDGER_DB;
  process.env.ACRES_LEDGER_DB=join(dir,'ledger.sqlite');
  const delays={zoning:500,records:recordsDelay},spans={zoning:[],records:[]},recordsUrls=[];
  const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  global.fetch=async url=>{
    const href=decodeURIComponent(String(url).replace(/\+/g,' '));
    if(href.includes('64uk-42ks'))return json([briefRow]);
    const kind=href.includes('arcgis')||href.includes('existing_zoning_sqft > 0')?'zoning':'records';
    if(kind==='records')recordsUrls.push(String(url));
    const start=performance.now();
    await new Promise(resolve=>setTimeout(resolve,delays[kind]));
    spans[kind].push([start,performance.now()]);
    if(kind==='zoning')return json({features:[]});
    return json(briefRecords[href.match(/resource\/([a-z0-9]{4}-[a-z0-9]{4})/)?.[1]]??[]);
  };
  const run={spans,recordsUrls,recordsCalls:0};
  const agent=async({execute,onControl})=>{
    onControl({steer:async()=>{},interrupt:async()=>{}});
    run.found=await execute('acres_find_property',{bbl:briefBbl});
    const started=performance.now();
    run.subject=await execute('acres_set_subject',{bbl:briefBbl});
    run.briefEnd=performance.now();run.briefMs=run.briefEnd-started;
    return act(execute,run);
  };
  try{
    run.out=await research({message:'Underwrite this site.'},{ENABLE_CURATED_ZONING:true},()=>{},()=>{},()=>{},agent);
    return run;
  }finally{
    global.fetch=original;restoreWeb();
    if(savedLedger===undefined)delete process.env.ACRES_LEDGER_DB;else process.env.ACRES_LEDGER_DB=savedLedger;
    rmSync(dir,{recursive:true,force:true});
  }
}
const busy=list=>Math.max(...list.map(([,end])=>end))-Math.min(...list.map(([start])=>start));

test('the subject brief takes as long as its slowest part, and the public records digest rides cited and uncharged on the next result',async()=>{
  // The model reads the brief before its next call; the records are read meanwhile.
  const run=await underwritingRun({recordsDelay:150,act:async(execute,run)=>{
    await new Promise(resolve=>setTimeout(resolve,1500));
    run.next=await execute('acres_entitlement_scenarios',{});
    if(!run.next.recordsDigest){run.recordsCalls++;await execute('acres_nyc_public_records',{});}
    run.answer=`EXAMPLE OWNER LLC holds the latest deed on the lot [${run.next.recordsDigest?.sourceId}].`;
    return run.answer;
  }});
  const {subject,next,found,spans,out}=run,zoning=busy(spans.zoning);
  assert.ok(zoning>=500&&run.briefMs<zoning+250,`brief ${run.briefMs} ms against zoning ${zoning} ms`);
  // The records are read only once the brief's lookups are done, so they never slow it.
  assert.ok(spans.records.length>=3);
  assert.ok(Math.min(...spans.records.map(([start])=>start))>=Math.max(...spans.zoning.map(([,end])=>end)));
  assert.equal(subject.recordsDigest,undefined);
  assert.match(subject.recordsNote,/recordsDigest/);
  const digest=next.recordsDigest;
  assert.deepEqual(digest.ownerOfRecord.names,['EXAMPLE OWNER LLC']);
  assert.equal(digest.ownerOfRecord.deed.crfn,'2020000001');
  assert.match(digest.ownerOfRecord.caveat,/1 document\(s\) were recorded on the lot after it/);
  assert.deepEqual(digest.openViolations,{dob:1,ecb:1,ecbOpenBalanceDue:2500,hpdOpenInLatestInspections:1,hpdInspectionsRead:1});
  // A permit not acted on in years has lapsed; a finished or denied DOB NOW job is not in progress.
  assert.deepEqual(digest.majorFilingsInProgress.latest.map(f=>[f.jobNumber,f.lastAction]),[['121000009','2026-05-01'],['M00000001-I1','2025-09-01']]);
  assert.equal(digest.majorFilingsInProgress.lapsedUnresolvedCount,1);
  assert.equal(digest.latestCertificateOfOccupancy.jobNumber,'100000001');
  assert.match(next.recordsGuidance,/countsAreAtLeast/);
  // Only the digest is recorded: one cited source, none for the datasets nobody asked for.
  const recordSources=out.sources.filter(s=>s.kind==='official_record');
  assert.deepEqual(recordSources.map(s=>s.id),[digest.sourceId]);
  assert.deepEqual(validateCitations(run.answer,out.sources),[digest.sourceId]);
  // Selecting the subject charges its one records call; the brief and the digest add none.
  assert.equal(found.budget.specialist-subject.budget.specialist,1);
  assert.equal(next.budget.specialist,subject.budget.specialist);
  assert.equal(subject.budget.compute,BUDGET.compute);
  assert.equal(run.recordsCalls,0);
});

test('a records call made while the digest is still being read reuses its reads and takes its place',async()=>{
  const run=await underwritingRun({recordsDelay:300,act:async(execute,run)=>{
    run.records=await execute('acres_nyc_public_records',{});
    run.next=await execute('acres_entitlement_scenarios',{});
    return `EXAMPLE OWNER LLC holds the latest deed on the lot [${run.records.sourceIds.acrisParties}].`;
  }});
  // Every records query is sent once, though the digest and the call both read them.
  assert.equal(new Set(run.recordsUrls).size,run.recordsUrls.length);
  assert.ok(run.records.sourceIds.acrisParties);
  assert.deepEqual(run.records.currentOwner.names,['EXAMPLE OWNER LLC']);
  assert.equal(run.next.recordsDigest,undefined);
});

test('undated pending filings are preserved without being called lapsed',async()=>{
  const out=await fetchNycPublicRecords(briefRow,{request:async url=>{
    const dataset=String(url).match(/resource\/([^/.]+)/)?.[1];
    return dataset==='w9ak-ipjd'?[{job_filing_number:'Q00000001-I1',job_type:'New Building',filing_status:'Plan Examiner Review',lot:'12'}]:briefRecords[dataset]??[];
  }});
  const digest=publicRecordsDigest(out,{now:new Date('2026-10-01T00:00:00Z')});
  assert.equal(digest.majorFilingsInProgress.lapsedUnresolvedCount,1);
  assert.equal(digest.majorFilingsInProgress.undatedUnresolvedCount,1);
  assert.deepEqual(digest.majorFilingsInProgress.undated.map(f=>f.jobNumber),['Q00000001-I1']);
});

test('the records digest stays compact and keeps the caveats of the full records',async()=>{
  const filings=Array.from({length:30},(_,i)=>({job_filing_number:`Q0000${String(i).padStart(4,'0')}-I1`,job_type:'New Building',filing_status:'Plan Examiner Review',filing_date:'2026-01-01T00:00:00.000',current_status_date:`2026-02-${String(i%28+1).padStart(2,'0')}T00:00:00.000`,lot:'12'}));
  const violations=Array.from({length:1000},(_,i)=>({number:`V${i}`,issue_date:'20250101',violation_type:'C-CONSTRUCTION',violation_category:'V-DOB VIOLATION - ACTIVE'}));
  const rows={...briefRecords,'w9ak-ipjd':filings,'3h2n-5cm9':violations};
  const out=await fetchNycPublicRecords({bbl:briefBbl},{request:async url=>rows[decodeURIComponent(url).match(/resource\/([a-z0-9]{4}-[a-z0-9]{4})/)?.[1]]??[]});
  const digest=publicRecordsDigest(out,{now:new Date('2026-10-01T00:00:00Z')});
  assert.deepEqual(digest.openViolations.countsAreAtLeast,['dob']);
  assert.equal(digest.majorFilingsInProgress.latest.length,5);
  assert.ok(digest.majorFilingsInProgress.count>5);
  assert.ok(JSON.stringify(digest).length<2500,`${JSON.stringify(digest).length} characters`);
});

 test('records carry retrieval time without claiming a dataset as-of date',async()=>{
 const sources=[];const records=await fetchNycPublicRecords({bbl:briefBbl},{request:async url=>briefRecords[String(url).match(/resource\/([a-z0-9]{4}-[a-z0-9]{4})/)?.[1]]??[],record:source=>{sources.push(source);return {id:sources.length};},rentStabilizedLookup:async()=>({status:'unavailable'})});
 assert.match(records.freshness.retrievedAt,/^\d{4}-\d{2}-\d{2}T/);assert.equal(records.freshness.dataAsOf,null);assert.ok(sources.length>0);for(const source of sources)assert.equal(JSON.parse(source.text).freshness.retrievedAt,records.freshness.retrievedAt);
});
