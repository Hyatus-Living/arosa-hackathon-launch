import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {ChatStore} from './store.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {SchemeDrafts} from './scheme-plans.mjs';

const IDS=['as_of_right','max_bonus','alternative'];
const doc=name=>({schema:'acres.architecture.plan/1',name,units:'m',levels:[{id:'ground',elevation:0,height:3}],
  walls:[{id:'wall',levelId:'ground',start:[0,0],end:[10,0],thickness:0.2,height:3}],rooms:[],openings:[],objects:[],sources:[]});
const report={checks:[],why:{summary:'Chosen from 1 layouts.',architect:null},drawn:{units:1}};
const buildPlan=async(_doc,{outDir})=>{writeFileSync(join(outDir,'model.ifc'),'ISO-10303-21;\nEND-ISO-10303-21;\n');return {hasIfc:true};};

// A site with three schemes, drafted by a planner that takes the given milliseconds per scheme or throws for it.
function fixture(t,planner){
  const dir=mkdtempSync(join(tmpdir(),'acres-scheme-plans-')),store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const account='owner',projectId=store.createConversation(account).projectId;
  const schemes=IDS.map(id=>({id,label:id,program:{zfa:10000,storeys:4,units:10,unitMix:[]},plan:null,budget:null,render:null}));
  store.project.write(projectId,{schemes:{value:{schemes,basis:{}},provenance:{tool:'schemes'}}});
  const renders=[];
  const jobs={view:row=>row,create:async(_account,_project,{planId,revision})=>{renders.push(planId);return {planId,revision};}};
  let active=0,peak=0;
  const plan=async scheme=>{
    peak=Math.max(peak,++active);
    const ms=planner[scheme.id];await sleep(ms==='fail'?5:ms);
    --active;
    if(ms==='fail')throw new Error('The floors do not fit.');
    return {doc:doc(scheme.id),report};
  };
  const drafts=new SchemeDrafts(new Architecture(store,{stateDir:dir,buildPlan}),jobs,{plan});
  const saved=()=>store.query('SELECT scheme,plan_id FROM architecture_plans WHERE project=? ORDER BY rowid',projectId);
  return {store,account,projectId,drafts,renders,saved,parallel:()=>peak};
}

test('Draft all three draws the schemes at once and saves them in scheme order',async t=>{
  const f=fixture(t,{as_of_right:100,max_bonus:100,alternative:100});
  assert.deepEqual(f.drafts.start(f.account,f.projectId).drafts.map(d=>d.status),['running','running','running']);
  await f.drafts.running;
  assert.equal(f.parallel(),3,'all three planners overlap; timing does not depend on host load');
  assert.deepEqual(f.drafts.list(f.account,f.projectId).drafts.map(d=>d.status),['succeeded','succeeded','succeeded']);
  assert.deepEqual(f.saved().map(r=>r.scheme),IDS);
});

test('a plan drawn first waits for the schemes before it, so revisions and renders keep scheme order',async t=>{
  const f=fixture(t,{as_of_right:120,max_bonus:60,alternative:10});
  f.drafts.start(f.account,f.projectId);
  await f.drafts.running;
  const saved=f.saved();
  assert.deepEqual(saved.map(r=>r.scheme),IDS);
  assert.deepEqual(f.renders,saved.map(r=>r.plan_id));
  const events=f.store.projectEvents(f.projectId).filter(e=>e.event==='architecture.draft'&&e.status==='succeeded').map(e=>e.scheme);
  assert.deepEqual(events,IDS);
});

test('a draft that fails leaves the other two saved',async t=>{
  const f=fixture(t,{as_of_right:30,max_bonus:'fail',alternative:10});
  f.drafts.start(f.account,f.projectId);
  await f.drafts.running;
  const drafts=f.drafts.list(f.account,f.projectId).drafts;
  assert.deepEqual(drafts.map(d=>d.status),['succeeded','failed','succeeded']);
  assert.equal(drafts[1].reason,'The floors do not fit.');
  assert.deepEqual(f.saved().map(r=>r.scheme),['as_of_right','alternative']);
});
