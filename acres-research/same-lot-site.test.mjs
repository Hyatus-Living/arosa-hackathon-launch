import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';

// Owner decision Q11: one owner, one lot, one site. Conversations about the same lot converge on
// the owner's oldest site for it, whichever way they were started.
const alice='a'.repeat(24),bob='b'.repeat(24),LOT='3011560001';
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-same-lot-')),path=join(dir,'chat.sqlite');
  const f={store:new ChatStore(path),reopen(){f.store.close();f.store=new ChatStore(path);return f.store;}};
  t.after(()=>{f.store.close();rmSync(dir,{recursive:true,force:true});});
  return f;
}
const research=(store,owner,conversation,result)=>{const run=store.createRun(owner,conversation,'Research the lot');store.begin(run);store.finish(run,'completed',{answer:'Done',sources:[],...result});return run;};
const lot=(bbl=LOT)=>({bbl,address:'10 Same St'});

test('two plain chats researching the same lot converge on one site, with both chats\' research',t=>{
  const {store}=setup(t),first=store.createConversation(alice),second=store.createConversation(alice);
  assert.notEqual(first.projectId,second.projectId);
  research(store,alice,first.id,{property:lot(),envelope:{maxFloorArea:1000}});
  const feed=[];store.projectFeed.on(first.projectId,e=>feed.push(e.event));
  research(store,alice,second.id,{property:lot(),entitlements:{summary:'As of right'}});
  assert.equal(store.conversation(alice,second.id).projectId,first.projectId,'the second chat attaches to the existing site');
  assert.equal(store.project.row(second.projectId),null,'the emptied project is removed');
  assert.deepEqual(store.query('SELECT id FROM projects WHERE owner=? AND bbl=?',alice,LOT).map(r=>r.id),[first.projectId]);
  for(const c of [first,second]){
    const state=store.projectState(alice,c.id);
    assert.equal(state.envelope.value.maxFloorArea,1000);assert.equal(state.entitlements.value.summary,'As of right');
  }
  assert.deepEqual(store.projectPage(alice,{sitesOnly:true}).projects.map(p=>[p.id,p.conversationCount]),[[first.projectId,2]]);
  assert.ok(feed.includes('site.merged'),'the site page hears that the other chat joined');
  const third=store.createConversation(alice);research(store,alice,third.id,{property:lot('1000010001')});
  assert.notEqual(store.conversation(alice,third.id).projectId,first.projectId,'another lot keeps its own site');
  const bobs=store.createConversation(bob);research(store,bob,bobs.id,{property:lot()});
  assert.notEqual(store.conversation(bob,bobs.id).projectId,first.projectId,'another account\'s site for the lot stays its own');
  assert.equal(store.projectState(bob,first.id),null);
});

test('a merge keeps the newest value of each field and marks what depends on a replaced field stale',t=>{
  const {store}=setup(t),older=store.createConversation(alice),newer=store.createConversation(alice);
  research(store,alice,older.id,{property:lot(),envelope:{maxFloorArea:1000},entitlements:{summary:'Old reading'}});
  store.write("UPDATE project_fields SET updated=updated-60000 WHERE project=?",older.projectId);
  research(store,alice,newer.id,{property:lot(),envelope:{maxFloorArea:2000}});
  const state=store.projectState(alice,older.id);
  assert.equal(state.envelope.value.maxFloorArea,2000,'the newer envelope wins');
  assert.equal(state.entitlements.value.summary,'Old reading','a field only the site had is kept');
  assert.ok(state.entitlements.stale,'what depended on the replaced envelope is marked stale');
  assert.equal(store.conversation(alice,newer.id).projectId,older.projectId);
});

test('a chat started for a lot joins the owner\'s site for it',t=>{
  const {store}=setup(t),site=store.createConversation(alice,{bbl:LOT});
  assert.equal(store.createConversation(alice,{bbl:LOT}).projectId,site.projectId);
  assert.notEqual(store.createConversation(bob,{bbl:LOT}).projectId,site.projectId);
});

test('a merge waits for runs still in flight',t=>{
  const {store}=setup(t),site=store.createConversation(alice,{bbl:LOT});
  const plain=store.createConversation(alice),sibling=store.createConversation(alice,{projectId:plain.projectId});
  const inFlight=store.createRun(alice,sibling.id,'Still working');store.begin(inFlight);
  research(store,alice,plain.id,{property:lot()});
  assert.equal(store.conversation(alice,plain.id).projectId,plain.projectId,'a run still working on the joining site holds the merge');
  store.finish(inFlight,'completed',{answer:'Done',sources:[]});
  assert.equal(store.conversation(alice,plain.id).projectId,site.projectId,'its own finish completes the merge');
  assert.equal(store.conversation(alice,sibling.id).projectId,site.projectId);
});

test('sites already duplicated for one owner and lot converge on the oldest when the store opens',t=>{
  const f=setup(t),store=f.store,[a,b,c]=[0,1,2].map(()=>store.createConversation(alice));
  store.write("UPDATE projects SET bbl=?,created=? WHERE id=?",LOT,3000,a.projectId);
  store.write("UPDATE projects SET bbl=?,created=? WHERE id=?",LOT,1000,b.projectId);
  store.write("UPDATE projects SET bbl=?,created=? WHERE id=?",LOT,2000,c.projectId);
  store.project.write(a.projectId,{envelope:{value:{maxFloorArea:3},provenance:{tool:'acres_compute_envelope',sources:[]}}});
  const reopened=f.reopen();
  assert.deepEqual(reopened.query('SELECT id FROM projects WHERE bbl=?',LOT).map(r=>r.id),[b.projectId]);
  for(const conversation of [a,b,c])assert.equal(reopened.projectOf(conversation.id),b.projectId);
  assert.equal(reopened.project.read(b.projectId).envelope.value.maxFloorArea,3);
});

test('a listing investigation saved on a site that joins another follows it to the merged site',t=>{
  const {store}=setup(t),first=store.createConversation(alice),second=store.createConversation(alice);
  store.db.exec('CREATE TABLE IF NOT EXISTS listing_investigations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,listing TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL)');
  store.db.prepare('INSERT INTO listing_investigations VALUES(?,?,?,?,?,?,?)').run('inv1',alice,'listing-1','completed',1,1,JSON.stringify({projectId:second.projectId,depth:'standard'}));
  research(store,alice,first.id,{property:lot()});
  research(store,alice,second.id,{property:lot()});
  assert.equal(JSON.parse(store.one('SELECT data FROM listing_investigations WHERE id=?','inv1').data).projectId,first.projectId);
});

// The lossless merge: newest version of each entry, user edits by edit time, every replaced or
// unchosen value archived with the target, the joining site's history carried, grants reconciled.
// The first site given is the oldest.
const sameLot=(store,...ids)=>ids.forEach((id,i)=>store.write('UPDATE projects SET bbl=?,created=? WHERE id=?',LOT,1000+i,id));
const field=(value,tool,extra={})=>({value,provenance:{tool,sources:[],...extra}});

test('a merge keeps the newest version of each pro forma and concept and every entry either site had',t=>{
  const {store}=setup(t),older=store.createConversation(alice),newer=store.createConversation(alice);
  sameLot(store,older.projectId,newer.projectId);
  store.project.write(older.projectId,{proFormas:field([{name:'Rental',irr:5},{name:'Condo',irr:7}],'acres_pro_forma')},1000);
  store.project.write(newer.projectId,{proFormas:field([{name:'Rental',irr:6},{name:'Hotel',irr:4}],'acres_pro_forma')},2000);
  store.convergeSite(older.projectId);
  const kept=store.project.read(older.projectId).proFormas.value;
  assert.deepEqual(Object.fromEntries(kept.map(p=>[p.name,p.irr])),{Rental:6,Condo:7,Hotel:4});
  // A joining site's older concept loses its collision; its other concepts still join.
  store.project.write(older.projectId,{concepts:field([{name:'Tower',storeys:20}],'acres_model_concept')},5000);
  const late=store.createConversation(alice);sameLot(store,older.projectId,late.projectId);
  store.project.write(late.projectId,{concepts:field([{name:'Tower',storeys:12},{name:'Walk-up',storeys:5}],'acres_model_concept')},3000);
  store.convergeSite(older.projectId);
  assert.deepEqual(Object.fromEntries(store.project.read(older.projectId).concepts.value.map(c=>[c.name,c.storeys])),{Tower:20,'Walk-up':5});
  // The other way round, the older entry loses its collision but stays in the archive.
  const archived=store.query("SELECT value FROM project_field_archive WHERE project=? AND key='proFormas'",older.projectId).map(r=>JSON.parse(r.value));
  assert.ok(archived.some(v=>v.some(p=>p.name==='Rental'&&p.irr===5)));
});

test('a merge orders user edits by their edit time',t=>{
  const {store}=setup(t),site=store.createConversation(alice),joining=store.createConversation(alice);
  sameLot(store,site.projectId,joining.projectId);
  store.project.write(site.projectId,{program:field({units:10},'user',{account:alice,at:new Date(7000).toISOString()})},7000);
  // Edited earlier, though its row was saved again later.
  store.project.write(joining.projectId,{program:field({units:12},'user',{account:alice,at:new Date(5000).toISOString()})},9000);
  store.convergeSite(site.projectId);
  assert.equal(store.project.read(site.projectId).program.value.units,10);
});

test('a merge archives every value it replaces or leaves, and carries the joining site\'s history',t=>{
  const {store}=setup(t),site=store.createConversation(alice),joining=store.createConversation(alice);
  research(store,alice,site.id,{property:lot(),envelope:{maxFloorArea:1000}});
  store.write("UPDATE project_fields SET updated=updated-60000 WHERE project=?",site.projectId);
  const history=store.projectEvents(joining.projectId).length;
  research(store,alice,joining.id,{property:lot(),envelope:{maxFloorArea:2000}});
  assert.equal(store.project.row(joining.projectId),null);
  const rows=store.query('SELECT key,value,from_project FROM project_field_archive WHERE project=?',site.projectId);
  assert.ok(rows.some(r=>r.key==='envelope'&&JSON.parse(r.value).maxFloorArea===1000&&r.from_project===site.projectId),'the replaced envelope');
  assert.ok(rows.some(r=>r.key==='envelope'&&JSON.parse(r.value).maxFloorArea===2000&&r.from_project===joining.projectId),'the joining site\'s own field');
  assert.ok(store.one('SELECT COUNT(*) AS n FROM project_event_archive WHERE project=? AND from_project=?',site.projectId,joining.projectId).n>history,'the joining site\'s events, its last research included');
});

test('a merge waits while a joining chat is shared, so its participant never gains the target',t=>{
  const {store}=setup(t),site=store.createConversation(alice),shared=store.createConversation(alice);
  research(store,alice,site.id,{property:lot(),envelope:{maxFloorArea:1000}});
  store.grantMember(alice,shared.id,'account',bob,'participant');
  research(store,alice,shared.id,{property:lot(),envelope:{maxFloorArea:2000}});
  assert.equal(store.projectOf(shared.id),shared.projectId,'the shared chat keeps its own site');
  assert.equal(store.projectAccess(bob,site.projectId),null);
  assert.throws(()=>store.requireProject(bob,site.projectId,'participant'),e=>e.status===404);
  // Once the owner ends the grant, the next write converges; a share link holds it the same way.
  const link=store.createConversation(alice);store.createLink(alice,link.id);
  store.removeGrant(alice,shared.id,'account',bob);
  research(store,alice,shared.id,{property:lot(),envelope:{maxFloorArea:2500}});
  assert.equal(store.projectOf(shared.id),site.projectId);
  assert.equal(store.projectAccess(bob,site.projectId),null);
  research(store,alice,link.id,{property:lot()});
  assert.notEqual(store.projectOf(link.id),site.projectId,'a live share link holds the merge');
});

test('a merge waits while the target is shared and the joining site is not, so its work never reaches the target\'s participant',t=>{
  const {store}=setup(t),shared=store.createConversation(alice),own=store.createConversation(alice);
  store.grantMember(alice,shared.id,'account',bob,'participant');
  research(store,alice,shared.id,{property:lot(),envelope:{maxFloorArea:1000}});
  research(store,alice,own.id,{property:lot(),envelope:{maxFloorArea:2000},entitlements:{summary:'Private reading'}});
  assert.equal(store.projectOf(own.id),own.projectId,'the private site keeps its own work');
  assert.equal(store.projectAccess(bob,own.projectId),null);
  assert.notEqual(store.project.read(shared.projectId).entitlements?.value.summary,'Private reading');
  // On a restart the same pair still waits, whichever way round the ids fall.
  const f=setup(t);
  const [a,b]=[f.store.createConversation(alice),f.store.createConversation(alice)];
  f.store.grantMember(alice,b.id,'account',bob,'participant');
  for(const [c,created] of [[a,2000],[b,1000]])f.store.write('UPDATE projects SET bbl=?,created=? WHERE id=?',LOT,created,c.projectId);
  f.store.project.write(a.projectId,{entitlements:{value:{summary:'Private A'},provenance:{tool:'acres_entitlement_scenarios',sources:[]}}});
  const reopened=f.reopen();
  assert.equal(reopened.query('SELECT id FROM projects WHERE bbl=?',LOT).length,2);
  assert.equal(reopened.projectAccess(bob,a.projectId),null);
});

test('sites shared with exactly the same people in the same roles still converge',t=>{
  const {store}=setup(t),first=store.createConversation(alice),second=store.createConversation(alice);
  for(const c of [first,second])store.grantMember(alice,c.id,'account',bob,'viewer');
  research(store,alice,first.id,{property:lot(),envelope:{maxFloorArea:1000}});
  research(store,alice,second.id,{property:lot(),envelope:{maxFloorArea:2000}});
  assert.equal(store.projectOf(second.id),first.projectId);
  assert.equal(store.projectAccess(bob,first.projectId),'viewer');
});

test('sites that both hold saved plans converge with one renumbered revision history, and the old site id opens the survivor',t=>{
  const f=setup(t),store=f.store,[a,b]=[0,1].map(()=>store.createConversation(alice));
  store.write("UPDATE projects SET bbl=?,created=? WHERE id=?",LOT,3000,a.projectId);
  store.write("UPDATE projects SET bbl=?,created=? WHERE id=?",LOT,1000,b.projectId);
  const plan=(project,planId,revision,parent,created)=>store.write("INSERT INTO architecture_plans(project,plan_id,revision,parent_revision,document_path,created_by,created_at,input_hash,scheme) VALUES(?,?,?,?,?,?,?,?, 'as_of_right')",project,planId,revision,parent,'/p/'+planId+'-'+revision+'.json',alice,created,'h'+planId+revision);
  plan(b.projectId,'plan-b',1,null,100);plan(b.projectId,'plan-b',2,1,300);
  plan(a.projectId,'plan-a',1,null,200);plan(a.projectId,'plan-a',2,1,400);
  store.write("INSERT INTO architecture_artifacts(artifact_id,project,revision,job_id,kind,path,sha256,bytes,content_type,created_at,plan_id) VALUES('art-a1',?,1,NULL,'plan_svg','/p/a1.svg','s',1,'image/svg+xml',200,'plan-a')",a.projectId);
  const reopened=f.reopen();
  assert.deepEqual(reopened.query('SELECT id FROM projects WHERE bbl=?',LOT).map(r=>r.id),[b.projectId],'one site remains');
  const plans=reopened.query('SELECT plan_id,revision,parent_revision FROM architecture_plans WHERE project=? ORDER BY revision',b.projectId);
  assert.deepEqual(plans.map(r=>[r.plan_id,r.revision,r.parent_revision]),[['plan-b',1,null],['plan-a',2,null],['plan-b',3,1],['plan-a',4,2]],'both histories interleave by save time with parents intact');
  assert.equal(reopened.one("SELECT revision FROM architecture_artifacts WHERE artifact_id='art-a1'").revision,2,'the artifact follows its revision');
  const view=reopened.projectView(alice,a.projectId);
  assert.equal(view.id,b.projectId);assert.equal(view.mergedFrom,a.projectId,'the merged-away site opens the survivor');
});
