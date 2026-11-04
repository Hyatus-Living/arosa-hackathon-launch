import test from 'node:test';
import assert from 'node:assert/strict';
import {addWall,exportPlan,planFromJson,validatePlan} from '../public/plan-intake.js';
import {mountEditor,multiLevelPlan} from './fixtures/plan-editor.mjs';

const visible=c=>[...c.root.querySelectorAll('svg.plan-canvas [data-kind="wall"]')].map(e=>e.dataset.id);
const level=c=>c.root.querySelector('select[aria-label="Plan level"]').value;
const put=c=>c.requests.filter(r=>r.method==='PUT');
async function editor(t,plan){const c=await mountEditor(plan);t.after(()=>c.close());return c;}
async function coordinates(c,start,end){
  for(const[label,value]of [['Start east',start[0]],['Start north',start[1]],['End east',end[0]],['End north',end[1]]]){
    const input=[...c.root.querySelectorAll('label')].find(l=>l.textContent.startsWith(label)).querySelector('input');
    await c.action(input,'onChange',{target:{value:String(value)}});
  }
  const form=[...c.root.querySelectorAll('section')].find(s=>s.querySelector('h3')?.textContent==='Add a wall by coordinates').querySelector('form');
  await c.action(form,'onSubmit');
}

test('a real mounted multi-level editor shows the first level alone and fits its geometry',async t=>{
  const plan=multiLevelPlan();for(const w of plan.walls.filter(w=>w.levelId==='upper')){w.start=w.start.map(v=>v+100);w.end=w.end.map(v=>v+100);}plan.rooms.find(r=>r.levelId==='upper').polygon=plan.rooms.find(r=>r.levelId==='upper').polygon.map(p=>p.map(v=>v+100));
  const c=await editor(t,plan);
  assert.equal(level(c),'ground');assert.deepEqual(visible(c),['ground-0','ground-1','ground-2','ground-3']);
  assert.match(c.root.querySelector('svg.plan-canvas').getAttribute('aria-label'),/Ground floor/);
  assert.ok(Number(c.root.querySelector('svg.plan-canvas').getAttribute('viewBox').split(' ')[2])<10);
  assert.equal(c.root.querySelectorAll('.plan-list [aria-pressed]').length,6);
  assert.equal(c.root.querySelectorAll('svg.plan-canvas [data-kind="opening"]').length,1);
  assert.equal(c.root.querySelectorAll('svg.plan-canvas [data-kind="room"]').length,1);
  await c.level('upper');assert.ok(Number(c.root.querySelector('svg.plan-canvas').getAttribute('viewBox').split(' ')[0])>90);
});

test('changing levels clears hidden selection without editing or saving the document',async t=>{
  const c=await editor(t);await c.pointer(4,0,c.root.querySelector('[data-kind="wall"][data-id="ground-0"]'));
  assert.equal(c.root.querySelectorAll('.plan-handle').length,2);
  await c.level('upper');assert.equal(level(c),'upper');assert.ok(visible(c).every(id=>id.startsWith('upper-')));
  assert.equal(c.root.querySelectorAll('.plan-handle').length,0);assert.doesNotMatch(c.root.querySelector('.plan-status').textContent,/unsaved/);
  assert.equal(c.drafts.size,0);assert.equal(put(c).length,0);assert.equal(c.button('Undo').disabled,true);
  await c.key('Delete');assert.equal(c.drafts.size,0);
});

test('new walls belong to the requested level and use its height with compatible first-level default',()=>{
  const plan=multiLevelPlan();assert.equal(validatePlan(plan).filter(i=>i.severity==='error').length,0);
  const upper=addWall(plan,{start:[10,0],end:[12,0],levelId:'upper'}).walls.at(-1);
  assert.equal(upper.levelId,'upper');assert.equal(upper.height,3.2);
  const first=addWall(plan,{start:[10,0],end:[12,0]}).walls.at(-1);assert.equal(first.levelId,'ground');assert.equal(first.height,2.8);
  assert.throws(()=>addWall(plan,{start:[0,0],end:[1,0],levelId:'missing'}),/Choose a level/);
  assert.equal(plan.walls.length,8);
});

test('wall drawing ignores another level snapping points and resets its chain when changing levels',async t=>{
  const plan=multiLevelPlan();plan.walls.push({...plan.walls[0],id:'ground-snap',start:[20.123,20.234],end:[22.123,20.234]});
  const c=await editor(t,plan);await c.level('upper');await c.action(c.button('Wall'));
  await c.pointer(20.12,20.23);await c.pointer(22.12,20.23);
  const draft=JSON.parse([...c.drafts.values()][0]);const wall=draft.walls.at(-1);
  assert.equal(wall.levelId,'upper');assert.deepEqual(wall.start,[20.12,20.23]);assert.deepEqual(wall.end,[22.12,20.23]);assert.equal(wall.height,3.2);
  await c.level('ground');await c.pointer(30,10);await c.pointer(32,10);
  const next=JSON.parse([...c.drafts.values()][0]);assert.equal(next.walls.length,11);assert.equal(next.walls.at(-1).levelId,'ground');assert.deepEqual(next.walls.at(-1).start,[30,10]);
  assert.deepEqual(next.walls.find(w=>w.id==='ground-snap'),plan.walls.at(-1));
});

test('coordinate wall entry uses the displayed level and clears unfinished coordinates on a level change',async t=>{
  const c=await editor(t);const input=c.root.querySelector('input[type="number"]');await c.action(input,'onChange',{target:{value:'777'}});
  await c.level('upper');assert.equal(c.root.querySelector('input[type="number"]').value,'');
  assert.match(c.root.querySelector('aside').textContent,/3.2 m high/);
  await coordinates(c,[10,10],[12,10]);const wall=JSON.parse([...c.drafts.values()][0]).walls.at(-1);
  assert.equal(wall.levelId,'upper');assert.equal(wall.height,3.2);assert.deepEqual(wall.start,[10,10]);
});

test('split, door and window tools target only the displayed level when floors overlap',async()=>{
  for(const target of ['ground','upper'])for(const tool of ['Split','Door','Window']){
    const plan=multiLevelPlan(),c=await mountEditor(plan);
    try{
      await c.level(target);await c.action(c.button(tool));await c.pointer(4,0);
      const doc=JSON.parse([...c.drafts.values()][0]),other=target==='ground'?'upper':'ground';
      assert.deepEqual(doc.walls.filter(w=>w.levelId===other),plan.walls.filter(w=>w.levelId===other));
      if(tool==='Split')assert.equal(doc.walls.filter(w=>w.levelId===target).length,5);
      else{assert.equal(doc.openings.at(-1).wallId,`${target}-0`);assert.equal(doc.openings.at(-1).kind,tool.toLowerCase());}
    }finally{await c.close();}
  }
});

test('whole-document checks remain visible and selecting a check opens its own level',async t=>{
  const plan=multiLevelPlan();plan.walls.find(w=>w.id==='upper-1').height=0;const c=await editor(t,plan);
  assert.equal(level(c),'ground');assert.equal(c.button('Save').disabled,true);
  const issue=[...c.root.querySelectorAll('.plan-issue')].find(b=>b.textContent.includes('upper-1')&&b.textContent.includes('height'));
  assert.ok(issue);await c.action(issue);assert.equal(level(c),'upper');assert.equal(c.root.querySelectorAll('.plan-handle').length,2);
  assert.equal(c.root.querySelector('.plan-handle').dataset.id,'upper-1');
});

test('undo, redo, save and JSON replacement preserve the full document and a valid active level',async t=>{
  const plan=multiLevelPlan(),c=await editor(t,plan);await c.level('upper');await coordinates(c,[10,10],[12,10]);
  await c.action(c.button('Undo'));assert.equal(level(c),'upper');assert.equal(c.drafts.size,1);
  await c.action(c.button('Redo'));assert.equal(level(c),'upper');assert.equal(c.button('Save').disabled,false);
  await c.action(c.button('Save'));assert.equal(put(c).length,1);assert.equal(c.saved.levels.length,2);assert.equal(c.saved.walls.length,9);
  assert.deepEqual(c.saved.walls.filter(w=>w.levelId==='ground'),plan.walls.filter(w=>w.levelId==='ground'));
  assert.deepEqual(c.saved.openings,plan.openings);assert.equal(c.saved.rooms.length,2);assert.equal(c.saved.revision,2);assert.equal(level(c),'upper');
  assert.doesNotMatch(c.root.querySelector('.plan-status').textContent,/unsaved/);
  const exported=exportPlan(c.saved);assert.equal(planFromJson(exported,{ref:'two-level.plan.json'}).walls.length,9);
  const one=structuredClone(plan);one.levels=one.levels.slice(0,1);one.walls=one.walls.filter(w=>w.levelId==='ground');one.rooms=one.rooms.filter(r=>r.levelId==='ground');one.openings=one.openings.filter(o=>o.wallId.startsWith('ground-'));
  const text=JSON.stringify(one),file={name:'one-level.plan.json',size:Buffer.byteLength(text),text:async()=>text};
  await c.action(c.root.querySelector('[data-testid="json-input"]'),'onChange',{target:{files:[file],value:''}});
  assert.equal(level(c),'ground');assert.ok(visible(c).every(id=>id.startsWith('ground-')));assert.equal(c.root.querySelectorAll('select[aria-label="Plan level"] option').length,1);
});
