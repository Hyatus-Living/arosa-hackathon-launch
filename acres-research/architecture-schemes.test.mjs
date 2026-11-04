import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ChatStore} from './store.mjs';
import {Architecture,PACKAGE_KINDS} from './architecture-artifacts.mjs';
import {architectureFixture} from './testing/architecture-outputs.mjs';
import {unitMixOf} from './market-store.mjs';
import {validatePlan} from './plan-intake.mjs';

const plan=name=>({schema:'acres.architecture.plan/1',name,units:'m',levels:[{id:'ground',elevation:0,height:3}],
  walls:[{id:'wall',levelId:'ground',start:[0,0],end:[10,0],thickness:0.2,height:3}],rooms:[],openings:[],objects:[],sources:[]});
const buildPlan=async(doc,{outDir})=>{writeFileSync(join(outDir,'model.ifc'),`ISO-10303-21;\n/* ${doc.name} */\nEND-ISO-10303-21;\n`);return {hasIfc:true};};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-schemes-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return dir;
}

// The tables as they were with one plan per project.
const LEGACY=`
CREATE TABLE architecture_plans(project TEXT NOT NULL REFERENCES projects(id),plan_id TEXT NOT NULL,revision INTEGER NOT NULL,parent_revision INTEGER,document_path TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,input_hash TEXT NOT NULL,PRIMARY KEY(project,revision));
CREATE TABLE architecture_jobs(job_id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),reason TEXT,input_hash TEXT NOT NULL,pipeline_version TEXT NOT NULL,settings_hash TEXT NOT NULL,settings TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,job_dir TEXT NOT NULL,pid INTEGER,artifacts TEXT NOT NULL DEFAULT '[]');
CREATE TABLE architecture_artifacts(artifact_id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,job_id TEXT,kind TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,content_type TEXT NOT NULL,created_at INTEGER NOT NULL);`;

test('migration: every existing plan becomes the as-of-right plan with its history, and jobs and artifacts gain its plan_id',t=>{
  const dir=fixture(t),path=join(dir,'chat.sqlite');
  let store=new ChatStore(path);
  const a=store.createConversation('owner').projectId,b=store.createConversation('owner').projectId;
  store.project.write(a,{architecture:{value:{planId:'plan-a',revision:2,parentRevision:1,name:'Typical floor',inputHash:'h2',artifacts:{}},provenance:{tool:'user'}}});
  store.close();
  const db=new DatabaseSync(path);
  db.exec('DROP TABLE architecture_plans;DROP TABLE architecture_jobs;DROP TABLE architecture_artifacts;'+LEGACY);
  const plans=[[a,'plan-a',1,null],[a,'plan-a',2,1],[b,'plan-b',1,null]];
  for(const [project,id,revision,parent] of plans)db.prepare('INSERT INTO architecture_plans VALUES(?,?,?,?,?,?,?,?)').run(project,id,revision,parent,`/plans/${id}/${revision}/plan.json`,'owner',revision,`h${revision}`);
  db.prepare('INSERT INTO architecture_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('job-a2',a,2,'succeeded',null,'ifc','1','s','{}','owner',3,3,4,'/jobs/job-a2',null,'[]');
  db.prepare('INSERT INTO architecture_artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run('art-a1',a,1,null,'ifc','/p','x',1,'application/x-step',1);
  db.prepare('INSERT INTO architecture_artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run('art-b1',b,1,null,'ifc','/p','x',1,'application/x-step',1);
  db.close();

  store=new ChatStore(path);
  t.after(()=>store.close());
  assert.deepEqual(store.query('SELECT project,plan_id,revision,parent_revision,created_by,input_hash,scheme FROM architecture_plans ORDER BY project=?,plan_id,revision',b).map(r=>({...r})),[
    {project:a,plan_id:'plan-a',revision:1,parent_revision:null,created_by:'owner',input_hash:'h1',scheme:'as_of_right'},
    {project:a,plan_id:'plan-a',revision:2,parent_revision:1,created_by:'owner',input_hash:'h2',scheme:'as_of_right'},
    {project:b,plan_id:'plan-b',revision:1,parent_revision:null,created_by:'owner',input_hash:'h1',scheme:'as_of_right'}]);
  assert.equal(store.one('SELECT plan_id FROM architecture_jobs WHERE job_id=?','job-a2').plan_id,'plan-a');
  assert.deepEqual(store.query('SELECT artifact_id,plan_id FROM architecture_artifacts ORDER BY artifact_id').map(r=>({...r})),[{artifact_id:'art-a1',plan_id:'plan-a'},{artifact_id:'art-b1',plan_id:'plan-b'}]);
  const architecture=new Architecture(store,{stateDir:dir,buildPlan});
  assert.equal(architecture.currentRevision(a,'as_of_right'),2,'a state saved before schemes still names the as-of-right plan');
  assert.equal(architecture.currentRevision(a,'max_bonus'),null);
  // A second plan in the same project may now reuse revision 1.
  store.write("INSERT INTO architecture_plans(project,plan_id,revision,parent_revision,document_path,created_by,created_at,input_hash,scheme) VALUES(?,?,?,?,?,?,?,?,'max_bonus')",a,'plan-a-bonus',1,null,'/p','owner',9,'h');
  store.close();
  store=new ChatStore(path);
  assert.equal(store.query('SELECT 1 FROM architecture_plans').length,4,'reopening a migrated database changes nothing');
});

test('plans per scheme: revisions, guards, artifacts and the project state are kept apart',async t=>{
  const dir=fixture(t),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>store.close());
  const projectId=store.createConversation('owner').projectId,architecture=new Architecture(store,{stateDir:dir,buildPlan}),view=row=>row;
  const save=(scheme,parentRevision,name)=>architecture.save('owner',projectId,{parentRevision,plan:plan(name),scheme},view);
  const base1=await save(undefined,null,'As of right 1'),base2=await save('as_of_right',1,'As of right 2');
  const bonus=await save('max_bonus',null,'Most floor area 1');
  assert.equal(base1.scheme,'as_of_right');assert.equal(bonus.scheme,'max_bonus');
  assert.equal(bonus.revision,1,'each scheme numbers its own revisions');
  assert.equal(base2.planId,base1.planId);assert.notEqual(bonus.planId,base1.planId);
  await assert.rejects(save('alternative',1,'No parent'),e=>e.status===409&&e.revision===null);
  await assert.rejects(save('max_bonus',null,'Second first plan'),e=>e.status===409&&e.revision===1);
  await assert.rejects(save('unknown',null,'Bad'),e=>e.status===400);
  assert.notDeepEqual(bonus.artifacts.map(a=>a.id),base1.artifacts.map(a=>a.id));
  assert.ok(bonus.artifacts.every(a=>a.planId===bonus.planId&&a.revision===1));

  const base=architecture.summary('owner',projectId,view),most=architecture.summary('owner',projectId,view,'max_bonus');
  assert.deepEqual(base.revisions.map(r=>r.revision),[2,1]);assert.equal(base.current.plan.name,'As of right 2');
  assert.deepEqual(most.revisions.map(r=>r.revision),[1]);assert.equal(most.current.plan.name,'Most floor area 1');
  assert.equal(architecture.summary('owner',projectId,view,'alternative').current,null);
  assert.deepEqual(base.schemes.map(s=>[s.scheme,s.revision]),[['as_of_right',2],['max_bonus',1],['alternative',null]]);
  assert.equal(architecture.revision('owner',projectId,1,view,'max_bonus').plan.name,'Most floor area 1');
  assert.equal(architecture.revision('owner',projectId,1,view).plan.name,'As of right 1');
  assert.throws(()=>architecture.revision('owner',projectId,2,view,'max_bonus'),e=>e.status===404);

  const state=store.project.read(projectId).architecture.value;
  assert.equal(state.scheme,'max_bonus','the top-level fields name the plan saved last');
  assert.deepEqual(state.plans,{as_of_right:{planId:base1.planId,revision:2,name:'As of right 2'},max_bonus:{planId:bonus.planId,revision:1,name:'Most floor area 1'}});
  const events=store.projectEvents(projectId).filter(e=>e.event==='architecture.revision').map(e=>[e.scheme,e.revision,e.planId]);
  assert.deepEqual(events,[['as_of_right',1,base1.planId],['as_of_right',2,base1.planId],['max_bonus',1,bonus.planId]]);
});

test('jobs are keyed by plan_id: the same revision number in two schemes gets its own job and artifacts',async t=>{
  const f=await architectureFixture(t),account='a'.repeat(24);
  const asOfRight=f.jobs.architecture.head(f.projectId,'as_of_right');
  const bonus=await f.jobs.architecture.save(account,f.projectId,{parentRevision:null,plan:plan('Most floor area'),scheme:'max_bonus'},f.jobs.view);
  const first=await f.create({});
  assert.equal(first.response.status,202);assert.equal(first.body.planId,asOfRight.plan_id);
  assert.equal((await f.terminal(first.body.id)).status,'succeeded');
  const second=await f.api(`/projects/${f.projectId}/architecture/jobs`,'POST',{scheme:'max_bonus',revision:1,settings:{}});
  assert.equal(second.body.planId,bonus.planId);
  const done=await f.terminal(second.body.id);
  assert.equal(done.status,'succeeded');
  assert.notEqual(done.id,first.body.id,'a revision 1 job of another plan is never returned as this plan\'s job');
  assert.ok(done.artifacts.every(a=>a.planId===bonus.planId));
  const jobsOf=planId=>f.store.query('SELECT job_id FROM architecture_jobs WHERE plan_id=?',planId).map(r=>r.job_id);
  assert.deepEqual(jobsOf(asOfRight.plan_id),[first.body.id]);assert.deepEqual(jobsOf(bonus.planId),[done.id]);
  const revision=(await f.api(`/projects/${f.projectId}/architecture/revisions/1?scheme=max_bonus`)).body;
  assert.deepEqual(revision.jobs.map(j=>j.id),[done.id]);
  assert.equal((await f.api(`/projects/${f.projectId}/architecture?scheme=max_bonus`)).body.current.planId,bonus.planId);
  assert.equal((await f.api(`/projects/${f.projectId}/architecture/jobs`,'POST',{scheme:'alternative',revision:1,settings:{}})).response.status,404);
});

const RENTAL=[{type:'studio',share:0.30,netSqft:450},{type:'oneBedroom',share:0.45,netSqft:550},{type:'twoBedroom',share:0.25,netSqft:800}];
const CONDO=[{type:'studio',share:0.15,netSqft:550},{type:'oneBedroom',share:0.45,netSqft:750},{type:'twoBedroom',share:0.30,netSqft:1100},{type:'threeBedroom',share:0.10,netSqft:1450}];
// The deal model's count: 85% of the zoning floor area over the mix's average unit.
const scheme=(id,zfa,storeys,mix)=>{
  const units=Math.floor(zfa*0.85/mix.reduce((a,u)=>a+u.share*u.netSqft,0));
  return {id,label:id,program:{zfa,storeys,units,unitMix:unitMixOf({mix},units)}};
};
// Units the plan draws: each level's units on every storey it stands for.
const unitsDrawn=plan=>plan.levels.reduce((sum,l)=>sum+new Set(plan.rooms.filter(r=>r.levelId===l.id).map(r=>r.unitId).filter(Boolean)).size*(l.storeys?.length??1),0);

test('scheme floors: the planning engine lays out narrow, standard and wide corner lots at the scheme\'s units, mix and floor area',async()=>{
  const {schemeTypicalFloor}=await import('./architecture-tools.mjs');
  // On a 25 ft lot the corridor runs across the lot, a unit on the street and one on the rear yard each floor: all the
  // scheme's units whole, where a central core leaves spaces too small for a unit.
  const cases=[
    ['narrow 25 ft rental',{frontFeet:25,depthFeet:100},scheme('as_of_right',5500,4,RENTAL),'double-loaded corridor'],
    ['standard 50 ft rental',{frontFeet:50,depthFeet:100},scheme('max_bonus',18000,6,RENTAL),'central core'],
    ['standard 50 ft condo',{frontFeet:50,depthFeet:100},scheme('alternative',18000,6,CONDO),'central core'],
    ['wide corner rental',{frontFeet:100,depthFeet:100,lotType:'corner',district:'R8',overlay:'C2-5'},scheme('max_bonus',54000,9,RENTAL),'double-loaded corridor'],
  ];
  for(const [name,lot,s,layout] of cases){
    const floor=await schemeTypicalFloor(s,lot);
    const plate=s.program.zfa/s.program.storeys;
    assert.equal(floor.layout,layout,name);
    assert.ok(floor.plate.sqft<=plate*1.031,`${name}: the plate stays within zfa over storeys`);
    assert.ok(floor.drawn.zfaSqft>=s.program.zfa*0.97&&floor.drawn.zfaSqft<=s.program.zfa*1.03,`${name}: the floors hold the scheme's floor area (${floor.drawn.zfaSqft})`);
    // On a commercial overlay the ground floor is the lobby and shops, as the deal model prices it, so it holds no units.
    const expected=lot.overlay?s.program.units*(s.program.storeys-1)/s.program.storeys:s.program.units;
    assert.ok(Math.abs(floor.typicalFloorUnits-expected)<=s.program.storeys,`${name}: about the scheme's units (${floor.typicalFloorUnits} of ${s.program.units})`);
    assert.equal(unitsDrawn(floor.doc),floor.typicalFloorUnits);
    assert.equal(floor.levels.reduce((a,l)=>a+l.units*l.storeys,0),floor.typicalFloorUnits);
    assert.equal(floor.mix.reduce((a,m)=>a+m.count,0),floor.typicalFloorUnits);
    assert.ok(floor.netToGross>0.65&&floor.netToGross<0.9,`${name}: net-to-gross ${floor.netToGross}`);
    assert.deepEqual(floor.checks.filter(c=>!c.pass&&c.basis==='law').map(c=>c.rule),[],name);
    assert.match(floor.why.summary,/chosen from \d+ layouts/);
    assert.deepEqual(validatePlan(floor.doc).filter(i=>i.severity==='error'),[],name);
  }
});

test('scheme floors flag what does not fit: more units than the floor holds, and a floor larger than its lot',async()=>{
  const {schemeTypicalFloor}=await import('./architecture-tools.mjs');
  const crowded={...scheme('max_bonus',18000,6,RENTAL)};crowded.program={...crowded.program,units:60};
  const tight=await schemeTypicalFloor(crowded,{frontFeet:50,depthFeet:100});
  assert.equal(tight.fit.fits,false);assert.ok(tight.fit.issues.some(i=>/^The floors hold \d+ units against the scheme's 60: at the scheme's sizes they need [\d,]+ SF in units, and the floors put [\d,]+ SF \(\d+%\) in units on [\d,]+ SF\.$/.test(i)),tight.fit.issues.join(' '));
  const big=await schemeTypicalFloor(scheme('as_of_right',12000,2,RENTAL),{frontFeet:25,depthFeet:100});
  assert.ok(big.fit.issues.some(i=>/^The floors draw about [\d,]+ SF of the scheme's 12,000 SF of zoning floor area\.$/.test(i)),big.fit.issues.join(' '));
  await assert.rejects(schemeTypicalFloor({id:'x',label:'Alternative',program:{zfa:0,storeys:0,units:0,unitMix:[]}},{}),/Alternative scheme has no storeys/);
});


test('Draft all three: one job per scheme saves its plan, names it on the scheme, and the drafts report fit and progress',async t=>{
  const f=await architectureFixture(t),account='a'.repeat(24);
  const schemes=[scheme('as_of_right',18000,6,RENTAL),scheme('max_bonus',24000,8,RENTAL),scheme('alternative',18000,6,CONDO)].map(s=>({...s,label:{as_of_right:'As of right',max_bonus:'Most floor area',alternative:'Alternative'}[s.id],plan:null,budget:null,render:null}));
  f.store.project.write(f.projectId,{property:{value:{bbl:'3012340001',zonedist1:'R7A',lotfront:'50',lotdepth:'100'},provenance:{tool:'acres_set_subject'}},
    schemes:{value:{schemes,basis:{}},provenance:{tool:'schemes'}}});
  const base=f.jobs.architecture.head(f.projectId,'as_of_right');
  const started=await f.api(`/projects/${f.projectId}/architecture/schemes/draft`,'POST',{});
  assert.equal(started.response.status,202);
  assert.deepEqual(started.body.drafts.map(d=>[d.scheme,d.status]),[['as_of_right','running'],['max_bonus','running'],['alternative','running']]);
  assert.deepEqual((await f.api(`/projects/${f.projectId}/architecture/schemes/draft`,'POST',{})).body.drafts.map(d=>d.id),started.body.drafts.map(d=>d.id),'a second click while drafting returns the same drafts');
  await f.server.schemeDrafts.running;
  const {body:{drafts}}=await f.api(`/projects/${f.projectId}/architecture/schemes/draft`);
  assert.deepEqual(drafts.map(d=>d.status),['succeeded','succeeded','succeeded'],JSON.stringify(drafts.map(d=>d.reason)));
  const stored=f.store.schemesView(f.projectId).schemes;
  for(const draft of drafts){
    const s=schemes.find(x=>x.id===draft.scheme),summary=(await f.api(`/projects/${f.projectId}/architecture?scheme=${draft.scheme}`)).body;
    assert.equal(summary.current.planId,draft.planId);
    const svg=summary.current.artifacts.find(a=>a.kind==='svg')?.id??null;
    const files=Object.fromEntries(summary.current.artifacts.filter(a=>PACKAGE_KINDS.includes(a.kind)).map(a=>[a.kind,a.id]));
    assert.deepEqual(stored.find(x=>x.id===draft.scheme).plan,{planId:draft.planId,revision:draft.revision,svg,files,why:draft.report.why.summary,drawn:draft.report.drawn},'the scheme names its plan, its package files, why it was chosen and what it draws');
    const units=unitsDrawn(summary.current.plan);
    // The test schemes count units at 85% of the floor area; the floors also give the ground floor's lobby and refuse room
    // their share and never draw more than the scheme's floor area, so they hold within 30% of that count in whole units.
    assert.ok(Math.abs(units-s.program.units)<=Math.max(s.program.storeys,0.3*s.program.units),`${draft.scheme}: the drawn floors hold about the scheme's units (${units} of ${s.program.units})`);
    assert.ok(draft.report.drawn.zfaSqft<=s.program.zfa,`${draft.scheme}: within the scheme's zoning floor area`);
    assert.equal(draft.report.typicalFloorUnits,units);assert.equal(draft.report.drawn.units,units);assert.equal(draft.report.buildingUnits,s.program.units);
    assert.equal(draft.report.fit.fits,!draft.report.fit.issues.length);
    assert.deepEqual(draft.report.checks.filter(c=>!c.pass&&c.basis==='law').map(c=>c.rule),[],`${draft.scheme}: every code and zoning check is met`);
    assert.match(draft.report.why.summary,/chosen from \d+ layouts/);
    assert.ok(draft.report.netToGross>0.7);
    assert.equal(draft.report.outline.source,'rectangle','without a tax-lot polygon the storeys are outlined on the PLUTO rectangle, and the report says so');
    assert.equal(summary.current.plan.zoning.storeys.length,draft.report.outline.storeys,'the plan carries its storey outlines');
  }
  // An edit saved without the outlines keeps its parent's, so the edited revision has a zoning sheet too.
  const parent=(await f.api(`/projects/${f.projectId}/architecture?scheme=max_bonus`)).body.current;
  const {zoning,id:_id,revision:_revision,parentRevision:_parent,...edited}=parent.plan;
  const saved=await f.jobs.architecture.save(account,f.projectId,{parentRevision:parent.revision,plan:{...edited,name:'Edited floor'},scheme:'max_bonus'},f.jobs.view);
  assert.deepEqual(saved.plan.zoning,zoning);
  assert.equal(drafts[0].revision,base.revision+1,'the as-of-right plan drawn earlier keeps its history');
  assert.equal(drafts[1].revision,1);assert.equal(drafts[2].revision,1);
  for(const draft of drafts)await f.terminal(f.store.one('SELECT job_id FROM architecture_jobs WHERE plan_id=? AND revision=?',draft.planId,draft.revision).job_id);
  const events=f.store.projectEvents(f.projectId).filter(e=>e.event==='architecture.draft').map(e=>`${e.scheme}:${e.status}`);
  assert.deepEqual(events.filter(e=>e.endsWith('succeeded')),['as_of_right:succeeded','max_bonus:succeeded','alternative:succeeded']);
});

test('Draft all three refuses a site without schemes and fails a scheme whose building cannot be drawn',async t=>{
  const f=await architectureFixture(t);
  assert.equal((await f.api(`/projects/${f.projectId}/architecture/schemes/draft`,'POST',{})).response.status,409);
  const empty={id:'max_bonus',label:'Most floor area',program:null,note:'No affordability bonus or 485-x building fits this lot.'};
  const tiny={...scheme('as_of_right',400,4,RENTAL),label:'As of right'};
  f.store.project.write(f.projectId,{property:{value:{bbl:'3012340002',lotfront:'8',lotdepth:'12'},provenance:{tool:'acres_set_subject'}},
    schemes:{value:{schemes:[tiny,empty],basis:{}},provenance:{tool:'schemes'}}});
  const {body}=await f.api(`/projects/${f.projectId}/architecture/schemes/draft`,'POST',{});
  assert.deepEqual(body.drafts.map(d=>d.scheme),['as_of_right'],'a scheme with no building is not drafted');
  await f.server.schemeDrafts.running;
  const [draft]=(await f.api(`/projects/${f.projectId}/architecture/schemes/draft`)).body.drafts;
  assert.equal(draft.status,'failed');assert.match(draft.reason,/no storeys or units|too small/);
});

test('the agent\'s acres_save_plan lays a scheme out on its storey outlines and saves them with the plan, as Draft all three does',async()=>{
  const {createArchitectureTools}=await import('./architecture-tools.mjs');
  const outlines=JSON.parse(readFileSync(new URL('../planning/fixtures/outlines.json',import.meta.url)))['through-40x200-R6B'];
  const s={...scheme('as_of_right',outlines.storeys.reduce((a,x)=>a+x.zfaBudgetSqft,0),outlines.storeys.length,RENTAL),label:'As of right'};
  const saved=[],described=[];
  const plans={scheme:async()=>({scheme:s,lot:{frontFeet:40,depthFeet:200,lotType:'through',district:'R6B'},site:outlines}),
    save:async({plan,scheme:id})=>{saved.push(plan);return {planId:'p1',revision:1,parentRevision:null,scheme:id,plan};},
    describe:(id,row,fields)=>described.push([id,row.planId,fields])};
  const out=await createArchitectureTools({plans}).handlers.acres_save_plan({parentRevision:0,typicalFloor:{},scheme:'as_of_right'});
  assert.equal(out.saved,true,JSON.stringify(out.issues??out.error));
  assert.deepEqual(saved[0].zoning,outlines,'the plan carries the outlines it was drawn on, so its zoning sheet is drawn too');
  assert.deepEqual(saved[0].levels.map(l=>l.use).slice(0,2),['cellar','ground']);
  const level=saved[0].levels.find(l=>l.use==='residential').id;
  const stairs=saved[0].rooms.filter(r=>r.levelId===level&&r.kind==='stair').map(r=>Math.min(...r.polygon.map(p=>p[1])));
  assert.ok(stairs.some(y=>y<30)&&stairs.some(y=>y>30),'a building on each street of the through lot, not one on the PLUTO rectangle');
  assert.deepEqual(described,[['as_of_right','p1',{why:out.layout.why.summary,drawn:out.layout.drawn}]],'the option card says why and what it draws');
});

test('a city-financed scheme draws apartments on a commercial overlay\'s ground floor, as it is priced',async()=>{
  const {schemeTypicalFloor}=await import('./architecture-tools.mjs');
  const lot={frontFeet:100,depthFeet:100,lotType:'corner',district:'R8',overlay:'C2-5'};
  const ground=floor=>{const id=floor.doc.levels.find(l=>l.use==='ground').id;return new Set(floor.doc.rooms.filter(r=>r.levelId===id).map(r=>r.kind));};
  const market=scheme('max_bonus',54000,9,RENTAL);
  assert.ok(ground(await schemeTypicalFloor(market,lot)).has('retail'));
  const financed=await schemeTypicalFloor({...market,program:{...market.program,taxProgram:{kind:'city-financed',amiPct:60}}},lot);
  assert.ok(!ground(financed).has('retail')&&ground(financed).has('living'));
});

test('affordable rows of a condo scheme are their own unit type, drawn at their rental size',async()=>{
  const {schemeTypicalFloor}=await import('./architecture-tools.mjs');
  const unitMix=[{type:'oneBedroom',netSqft:750,units:12},{type:'twoBedroom',netSqft:1100,units:6},{type:'studio',netSqft:450,units:3,affordable:true},{type:'oneBedroom',netSqft:550,units:3,affordable:true}];
  const floor=await schemeTypicalFloor({id:'max_bonus',label:'Most floor area',program:{zfa:20670,storeys:6,units:24,unitMix}},{frontFeet:50,depthFeet:106});
  assert.deepEqual(floor.mix.map(m=>[m.name,m.targetSqft]),[['1 bedroom',750],['2 bedroom',1100],['Studio, affordable',450],['1 bedroom, affordable',550]]);
  assert.equal(floor.mix.reduce((a,m)=>a+m.count,0),floor.typicalFloorUnits);
  assert.ok(floor.mix.some(m=>/affordable/.test(m.name)&&m.count>0),'a quarter of the units are affordable, so the floors hold some');
});
