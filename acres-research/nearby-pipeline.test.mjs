import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  LedgerStore,pipelineProjects,projectTenure,pipelineTotals,normalizeAddress,filingLink,parseCondoDeclaration,
  createDevelopmentLedgerTools,FILING_FIELDS_VERSION,
} from './ledger.mjs';
import {syncLedger} from '../scripts/ledger-sync.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/ledger-socrata.json',import.meta.url),'utf8'));
const NOW=new Date('2026-10-16T06:00:00Z');
const tempPath=()=>join(mkdtempSync(join(tmpdir(),'nearby-')),'ledger.sqlite');

// The ledger fixture, plus ACRIS condominium declarations answered by document type and grouped legals.
function fakeSocrata({condoMaster=[],condoLegals=[]}={}){
  const calls=[];
  async function request(url){
    calls.push(url);
    const u=new URL(url);
    const view=u.pathname.match(/^\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})\.json$/);
    if(view)return fixture.views[view[1]];
    const id=u.pathname.match(/^\/resource\/([a-z0-9]{4}-[a-z0-9]{4})\.json$/)[1];
    const where=u.searchParams.get('$where')||'';
    const rows=id==='bnx9-e6tj'&&where.includes('CDEC')?condoMaster:id==='8h5j-fqxa'&&u.searchParams.get('$group')?condoLegals:fixture[id];
    const offset=Number(u.searchParams.get('$offset')||0),limit=Number(u.searchParams.get('$limit'));
    return rows.slice(offset,offset+limit);
  }
  return {request,calls};
}

async function syncedStore(options){
  const store=new LedgerStore(tempPath());
  const fake=fakeSocrata(options);
  await syncLedger({store,request:fake.request,now:NOW,appToken:'tok',log:()=>{},pageSize:50});
  return {store,calls:fake.calls};
}

const row=(over)=>({
  bbl:'3000010001',source:'dob_now',job_number:'B00000001-I1',job_type:'New Building',status:'Permit Entire',zip:'11201',
  proposed_dwelling_units:null,proposed_stories:null,floor_area:null,filing_date:'2025-01-01',latest_action_date:'2025-02-01',
  latitude:40.69,longitude:-73.99,bin:null,address:null,...over,
});

test('filings group into one project per lot: follow-on filings fold in and a new building governs over alterations',()=>{
  const projects=pipelineProjects([
    row({job_number:'B00000001-I1',proposed_dwelling_units:30,floor_area:28000}),
    row({job_number:'B00000001-P1',proposed_dwelling_units:34,floor_area:30000,latest_action_date:'2025-06-01',status:'Approved'}),
    row({job_number:'B00000002-I1',job_type:'Alteration CO',proposed_dwelling_units:8,filing_date:'2025-08-01'}),
    row({bbl:'3000010002',job_number:'B00000003-I1',status:'Filing Withdrawn',proposed_dwelling_units:99}),
    row({bbl:'3000010003',job_number:'B00000004-I1',job_type:'Full Demolition'}),
    row({bbl:'3000010004',job_number:'321000001',source:'dob_bis',job_type:'A1',status:'SIGNED OFF',proposed_dwelling_units:26,existing_dwelling_units:20}),
    row({bbl:'3000010005',job_number:'B00000005-I1',job_type:'Alteration CO',proposed_dwelling_units:100,existing_dwelling_units:100}),
  ]);
  assert.equal(projects.length,2,'the withdrawn job, the demolition and an alteration that adds no units are not projects');
  const nb=projects.find(p=>p.bbl==='3000010001');
  assert.deepEqual([nb.jobNumber,nb.newBuilding,nb.units,nb.floorArea,nb.stage,nb.filingDate],['B00000001',true,34,30000,'approved','2025-01-01']);
  assert.deepEqual([projects.find(p=>p.bbl==='3000010004').stage,projects.find(p=>p.bbl==='3000010004').units],['completed',6],'an alteration counts the units it adds');
});

test('tenure comes only from records: HPD counted units and condo declarations, else unknown',()=>{
  const project={bbl:'3000010020',bin:'3999999',address:'12 WEST 3RD ST'};
  const hpd=(over)=>({source:'hpd_production',record_id:'1/1',bbl:'3000010020',lot:20,bin:null,address:null,rental_units:null,ownership_units:null,...over});
  const decl=(over)=>({source:'acris_condo',record_id:'2026010100000001',bbl:'3000011001',lot:1001,address:'12 W 3 STREET',condo_units:0,multi_units:0,recorded_at:'2026-01-01',...over});
  assert.equal(projectTenure(project,[]).tenure,'unknown');
  assert.equal(projectTenure(project,[hpd({rental_units:40})]).tenure,'rental');
  assert.equal(projectTenure(project,[hpd({bbl:'3000010099',bin:'3999999',ownership_units:12})]).tenure,'condo','an HPD building on the same BIN counts');
  const sale=projectTenure(project,[decl({condo_units:48})]);
  assert.equal(sale.tenure,'condo','the declaration matches by normalized address');
  assert.match(sale.tenureBasis[0],/declares 48 residential condo units/);
  assert.equal(projectTenure(project,[decl({condo_units:1,multi_units:2})]).tenure,'rental','multi-apartment units are a rental split for financing');
  assert.equal(projectTenure(project,[decl({condo_units:2})]).tenure,'unknown','two condo units are a financing split, not apartments for sale');
  assert.equal(projectTenure(project,[hpd({rental_units:10}),decl({condo_units:30})]).tenure,'mixed');
  assert.equal(projectTenure(project,[decl({lot:7,address:'99 ELSEWHERE AVE',condo_units:30})]).tenure,'unknown','another building on the block does not count');
  assert.equal(normalizeAddress('12 West 3rd St.'),normalizeAddress('12 W 3 STREET'));
});

test('totals give the condo share of units with a recorded tenure and how much of the pipeline that covers',()=>{
  const totals=pipelineTotals([
    {units:100,floorArea:90000,newBuilding:true,stage:'approved',tenure:'rental'},
    {units:50,floorArea:60000,newBuilding:true,stage:'in_review',tenure:'condo'},
    {units:50,floorArea:40000,newBuilding:false,stage:'approved',tenure:'unknown'},
    {units:0,floorArea:20000,newBuilding:true,stage:'approved',tenure:'unknown'},
  ]);
  assert.deepEqual([totals.projects,totals.newBuildings,totals.alterations,totals.units,totals.floorArea],[4,3,1,200,210000]);
  assert.deepEqual(totals.byStage,{approved:{projects:3,units:150,floorArea:150000},in_review:{projects:1,units:50,floorArea:60000}},'units and floor area are bucketed by stage');
  assert.deepEqual(totals.approved,{projects:3,units:150,floorArea:150000});
  assert.deepEqual(pipelineTotals([{units:30,floorArea:9000,newBuilding:true,stage:'disapproved',tenure:'unknown'}]).approved,{projects:0,units:0,floorArea:0},'only approved is the pipeline');
  assert.deepEqual(totals.tenure.unknown,{projects:1,units:50},'a project with no units has no tenure to weigh');
  assert.equal(totals.condoShareOfStatedUnits,0.333);
  assert.equal(totals.statedShareOfUnits,0.75);
  assert.equal(pipelineTotals([]).condoShareOfStatedUnits,null);
});

test('the nearby read finds projects within the radius and the ZIP, sets the subject lot apart and links each filing',async()=>{
  const {store}=await syncedStore();
  const read=store.nearbyPipeline({latitude:40.72,longitude:-74.005,zip:'10013',bbl:'1000150001',now:NOW});
  assert.deepEqual(read.onSubjectLot.map(p=>p.jobNumber),['121000001'],'the BIS job on the subject lot');
  assert.deepEqual(read.projects.map(p=>[p.jobNumber,p.units,p.floorArea,p.tenure]),[['M00000001',40,52000,'rental']],'the withdrawn job is gone and Staten Island is out of range');
  assert.ok(read.projects[0].distanceMiles>0&&read.projects[0].distanceMiles<0.1);
  assert.match(read.projects[0].tenureBasis[0],/HPD counts 12 rental units/);
  assert.match(read.projects[0].link,/w9ak-ipjd\.json\?%24where=starts_with%28job_filing_number%2C%27M00000001%27%29/);
  assert.match(filingLink({source:'dob_bis',jobNumber:'121000001'}),/bisweb\/JobsQueryByNumberServlet\?passjobnumber=121000001&passdocnumber=01/);
  assert.deepEqual([read.nearby.projects,read.nearby.units,read.nearby.tenure.rental.units,read.nearby.condoShareOfStatedUnits],[1,40,40,0]);
  assert.equal(read.sameZip.projects,1,'the ZIP read also leaves the subject lot out');
  assert.equal(read.retrievedAt,store.lastSyncedAt('dob_bis','dob_now'));
  assert.match(read.basis,/hg8x-zxpr/);
  const tight=store.nearbyPipeline({latitude:40.72,longitude:-74.005,radiusMiles:0.05,now:NOW});
  assert.deepEqual(tight.projects.map(p=>p.jobNumber),['121000001'],'without a subject lot every project in range counts');
  assert.equal(tight.sameZip,null);
  assert.throws(()=>store.nearbyPipeline({latitude:0,longitude:0}),/NYC latitude and longitude/);
  store.close();
});

test('condo declarations sync with their land lot, address and residential unit counts',async()=>{
  const {store,calls}=await syncedStore({
    condoMaster:[{document_id:'2026091500783001',doc_type:'CDEC',recorded_datetime:'2026-09-17T00:00:00.000'}],
    condoLegals:[
      {document_id:'2026091500783001',borough:'1',block:'16',street_number:'20',street_name:'WEST BROADWAY',property_type:'VN',min_lot:'10',n:'1'},
      {document_id:'2026091500783001',borough:'1',block:'16',street_number:'20',street_name:'WEST BROADWAY',property_type:'SC',min_lot:'1001',n:'38'},
      {document_id:'2026091500783001',borough:'1',block:'16',street_number:'20',street_name:'WEST BROADWAY',property_type:'PS',min_lot:'1039',n:'4'},
    ],
  });
  const legals=new URL(calls.find(u=>u.includes('/resource/8h5j-fqxa')&&u.includes('%24group')));
  assert.match(legals.searchParams.get('$where'),/document_id in \('2026091500783001'\)/);
  const rows=store.db.prepare("SELECT * FROM tenure_records WHERE source='acris_condo'").all();
  assert.deepEqual(rows.map(r=>[r.bbl,r.lot,r.address,r.condo_units,r.multi_units]),[['1000160010',10,'20 WEST BROADWAY',38,0]]);
  const read=store.nearbyPipeline({latitude:40.72,longitude:-74.005,now:NOW});
  assert.equal(read.projects.find(p=>p.jobNumber==='M00000001').tenure,'mixed','HPD rental units and a for-sale declaration on one lot disagree');
  store.close();
});

test('parseCondoDeclaration keys a declaration to the lot it names',()=>{
  const r=parseCondoDeclaration({document_id:'D1',recorded_datetime:'2026-01-02T00:00:00.000'},{borough:'2',block:'3273',lot:122,street_number:'410',street_name:'BEDFORD PARK BOULEVARD'},{single:0,multiple:1});
  assert.deepEqual([r.bbl,r.lot,r.address,r.recorded_at,r.multi_units],['2032730122',122,'410 BEDFORD PARK BOULEVARD','2026-01-02',1]);
});

test('a ledger synced before the nearby fields gains them and reads its filing history again',async()=>{
  const path=tempPath();
  const old=new DatabaseSync(path);
  old.exec("CREATE TABLE dob_filings(bbl TEXT NOT NULL,source TEXT NOT NULL,job_number TEXT PRIMARY KEY,job_type TEXT,status TEXT,zip TEXT,proposed_zoning_sqft REAL,proposed_dwelling_units REAL,proposed_stories REAL,initial_cost REAL,filing_date TEXT,latest_action_date TEXT,query_url TEXT NOT NULL,dataset_updated_at TEXT,fetched_at TEXT NOT NULL,row_hash TEXT NOT NULL)");
  old.exec("CREATE TABLE ledger_sync_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,dataset TEXT NOT NULL,dataset_id TEXT NOT NULL,since TEXT NOT NULL,until TEXT NOT NULL,rows_fetched INTEGER NOT NULL,inserted INTEGER NOT NULL,updated INTEGER NOT NULL,unchanged INTEGER NOT NULL,trimmed INTEGER NOT NULL,skipped INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,alert TEXT,started_at TEXT NOT NULL,finished_at TEXT NOT NULL)");
  old.exec("INSERT INTO ledger_sync_runs(run_id,dataset,dataset_id,since,until,rows_fetched,inserted,updated,unchanged,trimmed,status,started_at,finished_at) VALUES('r','dob_now','w9ak-ipjd','2026-07-01T00:00:00.000','2026-10-15T06:00:00.000',1,1,0,0,0,'ok','t','2026-10-15T06:00:00.000')");
  old.close();
  const store=new LedgerStore(path);
  const columns=store.db.prepare('PRAGMA table_info(dob_filings)').all().map(c=>c.name);
  assert.ok(['floor_area','latitude','longitude','bin','address'].every(c=>columns.includes(c)));
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='dob_filings_geo'").get());
  assert.equal(store.lastSyncedAt('dob_now'),'2026-10-15T06:00:00.000','reads stay synced while the history is read again');
  assert.equal(store.lastUntil('dob_now',FILING_FIELDS_VERSION),null);
  const fake=fakeSocrata();
  await syncLedger({store,request:fake.request,now:NOW,appToken:'tok',log:()=>{},pageSize:50});
  const dobNow=new URL(fake.calls.find(u=>u.includes('/resource/w9ak-ipjd')));
  assert.match(dobNow.searchParams.get('$where'),/filing_date >= '2023-10-12T06:00:00.000'/);
  store.close();
});

test('the ledger tool reads the nearby pipeline around a located subject and cites it',async()=>{
  const {store}=await syncedStore();
  const recorded=[];
  const tools=createDevelopmentLedgerTools({
    getProperty:()=>({bbl:'1000150001',zipcode:'10013',latitude:'40.72',longitude:'-74.005'}),
    record:s=>{recorded.push(s);return {id:`S${recorded.length}`};},openLedger:()=>store,now:()=>NOW,
  });
  const out=await tools.handlers.acres_development_ledger({nearbyRadiusMiles:0.25});
  assert.equal(out.nearby.radiusMiles,0.25);
  assert.equal(out.nearby.projectCount,1);
  assert.ok(out.sourceIds.nearby);
  assert.match(recorded.find(s=>s.id===out.sourceIds.nearby)?.title??recorded.at(-1).title,/within 0.25 mile of BBL 1000150001/);
  assert.match(out.proseReportingMandate,/nearby pipeline/);
  const unlocated=createDevelopmentLedgerTools({getProperty:()=>({bbl:'1000150001',zipcode:'10013'}),record:()=>null,openLedger:()=>store,now:()=>NOW});
  const plain=await unlocated.handlers.acres_development_ledger({});
  assert.equal(plain.nearby,null);
  assert.match(plain.proseReportingMandate,/no coordinates, so the nearby pipeline was not read/);
  store.close();
});
