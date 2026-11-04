import test from 'node:test';
import assert from 'node:assert/strict';
import {PLAN_SCHEMA,wallLength,validatePlan,exportPlan,planFromJson} from '../public/plan-intake.js';
import {openingController} from './fixtures/opening-controller.mjs';
import {mountEditor,multiLevelPlan} from './fixtures/plan-editor.mjs';

const round=value=>Math.round(value*1e6)/1e6;
const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]};
const axes=[[[0,0],[5,0]],[[5,0],[0,0]],[[0,0],[0,5]],[[0,5],[0,0]],[[0,0],[3,4]],[[3,4],[0,0]],[[0,4],[3,0]],[[3,0],[0,4]],[[0,0],[3,3]],[[3,3],[0,0]]];
function fixture(start=[0,0],end=[5,0],{kind='window',offset=1,width=.6}={}) {
  const levels=[{id:'ground',name:'Ground',elevation:0,height:2.8},{id:'upper',name:'Upper',elevation:3,height:2.8}];
  return {schema:PLAN_SCHEMA,id:'opening-edit',revision:1,parentRevision:null,name:'Opening edit fixture',units:'m',levels,
    walls:levels.map(level=>({id:level.id,levelId:level.id,start:[...start],end:[...end],height:2.8,thickness:.18,material:'generic',roomIds:[]})),
    openings:levels.map(level=>({id:level.id+'-opening',wallId:level.id,kind,offset:level.id==='ground'?offset:0,width,height:kind==='window'?1.2:2.1,sill:kind==='window'?.9:0,swing:null})),rooms:[],objects:[],sources:[]};
}
const errors=plan=>validatePlan(plan).filter(issue=>issue.severity==='error');

test('keyboard opening movement projects world arrows onto forward, reversed and diagonal host walls',()=>{
  for(const [start,end]of axes)for(const [key,delta]of Object.entries(arrows))for(const shift of [false,true])for(const kind of ['window','door']) {
    const initial=fixture(start,end,{kind}),before=structuredClone(initial),c=openingController(initial),len=wallLength(initial.walls[0]),step=shift?.1:.01;
    const along=((end[0]-start[0])*delta[0]+(end[1]-start[1])*delta[1])*step/len,expected=round(1+along);
    c.key(key,shift);assert.equal(c.plan.openings[0].offset,expected,`${start}/${end} ${key} ${shift} ${kind}`);
    assert.deepEqual(c.plan.openings[1],initial.openings[1]);assert.strictEqual(c.plan.walls,initial.walls);
    assert.deepEqual(initial,before);assert.deepEqual(errors(c.plan),[]);
    if(along===0){assert.strictEqual(c.plan,initial);assert.equal(c.historyState.past.length,0);}
  }
});

test('edge nudges clamp to both wall ends, stay exportable and do not add repeated history entries',()=>{
  for(const kind of ['window','door'])for(const [offset,key,expected]of [[.05,'ArrowLeft',0],[4.35,'ArrowRight',4.4]]) {
    const initial=fixture([0,0],[5,0],{kind,offset}),c=openingController(initial);c.key(key,true);
    assert.equal(c.plan.openings[0].offset,expected);assert.deepEqual(errors(c.plan),[]);
    const bounded=c.plan;for(let i=0;i<10;i++)c.key(key,true);
    assert.strictEqual(c.plan,bounded);assert.equal(c.historyState.past.length,1);
    const loaded=planFromJson(JSON.parse(JSON.stringify(exportPlan(c.plan))),{ref:'opening-edit.json'});
    assert.deepEqual(loaded.openings,c.plan.openings);assert.deepEqual(errors(loaded),[]);
  }
});

test('pointer and keyboard opening movement use the same projection and preserve the rest of the document',()=>{
  for(const [start,end]of axes)for(const [key,delta]of Object.entries(arrows)) {
    const initial=fixture(start,end),keyboard=openingController(initial),pointer=openingController(initial);
    keyboard.key(key);pointer.drag(delta.map(value=>value*.01));
    assert.deepEqual(pointer.plan.openings,keyboard.plan.openings);assert.deepEqual(errors(pointer.plan),[]);
    assert.strictEqual(pointer.plan.walls,initial.walls);assert.strictEqual(pointer.plan.levels,initial.levels);assert.strictEqual(pointer.plan.rooms,initial.rooms);
  }
});

test('blocked keyboard and perpendicular pointer moves preserve Redo and do not consume Undo',()=>{
  const initial=fixture([0,0],[5,0],{offset:0}),c=openingController(initial);
  c.key('ArrowRight');c.history.undo();assert.equal(c.plan.openings[0].offset,0);assert.equal(c.historyState.future.length,1);
  c.key('ArrowLeft');assert.equal(c.historyState.future.length,1);assert.equal(c.historyState.past.length,0);
  c.drag([0,1]);assert.equal(c.historyState.future.length,1);assert.equal(c.historyState.past.length,0);
  c.history.redo();assert.equal(c.plan.openings[0].offset,.01);
  c.key('ArrowUp');c.history.undo();assert.equal(c.plan.openings[0].offset,0);
});

test('an invalid zero-length host stays unchanged and an oversized opening keeps its visible validation error',()=>{
  const zero=fixture([0,0],[0,0],{offset:.05}),c=openingController(zero);c.drag([.2,.2]);
  assert.strictEqual(c.plan,zero);assert.equal(c.historyState.past.length,0);assert.equal(Number.isFinite(c.plan.openings[0].offset),true);assert.ok(errors(c.plan).length);
  const oversized=fixture([0,0],[.5,0],{width:.9,offset:.05}),wide=openingController(oversized);wide.drag([-1,0]);
  assert.equal(wide.plan.openings[0].offset,0);assert.equal(wide.plan.openings[0].width,.9);
  assert.ok(errors(wide.plan).some(issue=>issue.code==='opening-outside-wall'));
});

async function selectOpening(c) {
  const svg=c.root.querySelector('svg.plan-canvas'),opening=svg.querySelector('[data-kind="opening"]');assert.ok(opening);
  await c.pointer(0,0,opening);await c.action(svg,'onPointerUp');
}
const offsetInput=c=>[...c.root.querySelectorAll('label')].find(label=>label.textContent.startsWith('Offset from wall start')).querySelector('input');

test('the mounted editor keeps a boundary nudge saveable and saves the other floor unchanged',async t=>{
  const initial=multiLevelPlan();initial.openings[0].offset=.05;
  const c=await mountEditor(initial);t.after(()=>c.close());await selectOpening(c);await c.key('ArrowLeft',{shiftKey:true});
  assert.equal(Number(offsetInput(c).value),0);assert.equal(c.button('Save').disabled,false);
  await c.action(c.button('Save'));assert.equal(c.saved.revision,2);assert.equal(c.saved.openings[0].offset,0);
  assert.deepEqual(c.saved.openings[1],initial.openings[1]);assert.deepEqual(c.saved.walls,initial.walls);assert.deepEqual(c.saved.rooms,initial.rooms);
  assert.deepEqual(errors(planFromJson(exportPlan(c.saved),{ref:'saved-opening.json'})),[]);
});

test('the mounted editor retains Redo after blocked arrow and perpendicular drag gestures',async t=>{
  const initial=multiLevelPlan();initial.openings[0].offset=0;
  const c=await mountEditor(initial);t.after(()=>c.close());await selectOpening(c);
  await c.key('ArrowRight');await c.key('z',{ctrlKey:true});assert.equal(c.button('Redo').disabled,false);
  await c.key('ArrowLeft');assert.equal(Number(offsetInput(c).value),0);assert.equal(c.button('Redo').disabled,false);
  const svg=c.root.querySelector('svg.plan-canvas');await c.pointer(0,0,svg.querySelector('[data-kind="opening"]'));
  await c.action(svg,'onPointerMove',{clientX:0,clientY:-100});await c.action(svg,'onPointerUp');assert.equal(c.button('Redo').disabled,false);
  await c.key('z',{ctrlKey:true,shiftKey:true});assert.equal(Number(offsetInput(c).value),.01);
  await c.key('ArrowUp');await c.key('z',{ctrlKey:true});assert.equal(Number(offsetInput(c).value),0);
});
