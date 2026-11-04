import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PLAN_SCHEMA,translateWall,moveJoint,snapPoint,wallLength,exportPlan,planFromJson,detectRooms,validatePlan,roomArea} from '../public/plan-intake.js';

const round=v=>Math.round(v*1e6)/1e6+0;
const point=(p,d)=>p.map((v,i)=>round(v+d[i]));
function fixture(start=[0,0],end=[1,0]) {
  const wall=(id,a,b,levelId='ground')=>({id,levelId,start:a,end:b,thickness:0.18,height:2.8,material:'generic',roomIds:[]});
  return {schema:PLAN_SCHEMA,id:'wall-edit',revision:1,parentRevision:null,name:'Wall edit',units:'m',levels:[{id:'ground',name:'Ground',elevation:0,height:2.8}],walls:[wall('moving',start,end),wall('left',start,[start[0]-2,start[1]+2]),wall('right',end,[end[0]+2,end[1]+2])],openings:[{id:'window',wallId:'moving',kind:'window',offset:0.2,width:0.4,height:1.2,sill:0.9,swing:null}],rooms:[],objects:[],sources:[]};
}
const get=(plan,id)=>plan.walls.find(w=>w.id===id);
function controller(initial) {
  const source=readFileSync(new URL('../frontend/plan-editor.jsx',import.meta.url),'utf8');
  const c={plan:initial,translateWall,moveJoint,snapPoint,detectRooms,wallLength,tool:'select',metric:true,labels:[],radius:0.02,svgRef:{current:{setPointerCapture(){}}},samePoint:(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<=0.005,dragRef:{current:null},selection:{kind:'wall',id:'moving'},fromView:p=>p,pointer:e=>[e.x,e.y],setHover(){},useRef:value=>({current:value}),useState:value=>[value,next=>{c.plan=next.plan;}],prevented:0};
  Object.defineProperty(c,'visiblePlan',{get:()=>c.plan});
  c.level={id:initial.levels[0].id};
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function useHistory('),source.indexOf('async function renderPdfPage('))+'\n'+source.split('\n').find(line=>line.startsWith('  const geometry ='))+'\n'+source.slice(source.indexOf('  function onPointerDown('),source.indexOf('  function chooseTool(')),c);
  c.history=c.useHistory(initial);
  return c;
}

test('translating onto the old end preserves the wall and moves each original joint only once',()=>{
  const plan=fixture(),moved=translateWall(plan,'moving',[1,0]);
  assert.deepEqual(get(moved,'moving').start,[1,0]);assert.deepEqual(get(moved,'moving').end,[2,0]);assert.equal(wallLength(get(moved,'moving')),1);
  assert.deepEqual(get(moved,'left').start,[1,0]);assert.deepEqual(get(moved,'right').start,[2,0]);
  assert.deepEqual(get(moved,'left').end,[-2,2]);assert.deepEqual(get(moved,'right').end,[3,2]);
  assert.deepEqual(validatePlan(moved).filter(i=>i.severity==='error'),[]);
});

test('translations within joint tolerance of the old end do not recapture a moved endpoint',()=>{
  for(const d of [[0.996,0],[1.004,0],[1,0.004]]){
    const plan=fixture(),moved=translateWall(plan,'moving',d);
    assert.deepEqual(get(moved,'moving').start,point([0,0],d));assert.deepEqual(get(moved,'moving').end,point([1,0],d));
    assert.ok(Math.abs(wallLength(get(moved,'moving'))-1)<1e-6);
  }
});

test('wall vectors survive 160 signed, diagonal, short-wall and partial translations',()=>{
  const failures=[],vectors=[[1,0],[0,1],[-1,0],[0,-1],[3,4],[-3,4],[3,-4],[-3,-4],[0.1,0],[0.06,0.08]];
  for(const start of [[0,0],[12.345,-8.5]])for(const vector of vectors)for(const factor of [0,0.5,1,1.004,1.01,-1,2,0.996]){
    const end=start.map((v,i)=>round(v+vector[i])),delta=vector.map(v=>v*factor),plan=fixture(start,end),moved=translateWall(plan,'moving',delta),wall=get(moved,'moving');
    if(JSON.stringify(wall.start)!==JSON.stringify(point(start,delta))||JSON.stringify(wall.end)!==JSON.stringify(point(end,delta)))failures.push({start,end,delta,actual:[wall.start,wall.end]});
  }
  assert.deepEqual(failures,[]);
});

test('wall translation preserves nearby joint offsets and leaves coincident walls on other levels unchanged',()=>{
  const plan=fixture();plan.levels.push({id:'upper',name:'Upper',elevation:3,height:2.8});
  plan.walls.push({...get(plan,'moving'),id:'upper-wall',levelId:'upper'},{...get(plan,'left'),id:'upper-left',levelId:'upper'},{...get(plan,'left'),id:'near-joint',start:[0.003,0.002]});
  const moved=translateWall(plan,'moving',[1,0]);
  assert.deepEqual(get(moved,'upper-wall'),get(plan,'upper-wall'));assert.deepEqual(get(moved,'upper-left'),get(plan,'upper-left'));
  assert.deepEqual(get(moved,'near-joint').start,[1.003,0.002]);
});

test('translation keeps inputs, openings, metadata and zero-motion geometry intact through plan JSON',()=>{
  const plan=fixture(),before=structuredClone(plan),moved=translateWall(plan,'moving',[0,2]);
  assert.deepEqual(plan,before);assert.deepEqual(moved.openings,plan.openings);assert.equal(moved.revision,1);assert.equal(moved.id,plan.id);
  assert.deepEqual(translateWall(plan,'moving',[0,0]),plan);
  const loaded=planFromJson(JSON.parse(JSON.stringify(exportPlan(moved))),{ref:'wall-edit.json'});
  assert.deepEqual(loaded.walls.map(w=>[w.id,w.start,w.end]),moved.walls.map(w=>[w.id,w.start,w.end]));assert.deepEqual(loaded.openings,moved.openings);
});

test('actual editor pointer translation commits the correct wall and undo/redo restores both states',()=>{
  const initial=fixture(),c=controller(initial);
  c.dragRef.current={type:'wall',id:'moving',start:[0,0],base:initial,moved:false};
  c.onPointerMove({x:1,y:0});assert.deepEqual(get(c.plan,'moving').start,[1,0]);assert.deepEqual(get(c.plan,'moving').end,[2,0]);
  c.onPointerUp();assert.equal(c.dragRef.current,null);assert.equal(wallLength(get(c.history.current(),'moving')),1);
  c.history.undo();assert.deepEqual(c.plan,initial);c.history.redo();assert.deepEqual(get(c.plan,'moving').start,[1,0]);assert.deepEqual(get(c.plan,'moving').end,[2,0]);
});

test('actual editor Shift-arrow nudge does not collapse a valid ten-centimetre wall',()=>{
  const initial=fixture([0,0],[0.1,0]);initial.openings=[];const c=controller(initial);
  c.onKeyDown({target:{closest:()=>null},key:'ArrowRight',shiftKey:true,metaKey:false,ctrlKey:false,preventDefault(){c.prevented++;}});
  assert.equal(c.prevented,1);assert.deepEqual(get(c.plan,'moving').start,[0.1,0]);assert.deepEqual(get(c.plan,'moving').end,[0.2,0]);assert.equal(wallLength(get(c.plan,'moving')),0.1);
  c.history.undo();assert.deepEqual(c.plan,initial);
});

test('translating a room boundary along itself preserves its enclosed area after editor room detection',()=>{
  const plan=fixture();plan.openings=[];
  plan.walls=[['south',[0,0],[10,0]],['moving',[10,0],[10,8]],['north',[10,8],[0,8]],['west',[0,8],[0,0]]].map(([id,start,end])=>({...plan.walls[0],id,start,end}));
  plan.rooms=detectRooms(plan,{labels:[]});assert.equal(roomArea(plan.rooms[0]),80);
  const c=controller(plan);c.dragRef.current={type:'wall',id:'moving',start:[10,4],base:plan,moved:false};
  c.onPointerMove({x:10,y:12});c.onPointerUp();
  assert.equal(c.plan.rooms.length,1);assert.equal(roomArea(c.plan.rooms[0]),80);assert.equal(wallLength(get(c.plan,'moving')),8);
  assert.deepEqual(validatePlan(c.plan).filter(i=>i.severity==='error'),[]);
});

test('joint movement uses the explicitly selected level while keeping same-floor corners joined',()=>{
  const plan=fixture();plan.levels.push({id:'upper',name:'Upper',elevation:3,height:2.8});plan.walls.push({...get(plan,'moving'),id:'upper-wall',levelId:'upper'});
  const moved=moveJoint(plan,[0,0],[0.25,0.5],'ground');
  assert.deepEqual(get(moved,'moving').start,[0.25,0.5]);assert.deepEqual(get(moved,'left').start,[0.25,0.5]);assert.deepEqual(get(moved,'upper-wall'),get(plan,'upper-wall'));
  const upstairs=moveJoint(plan,[0,0],[-0.25,0.5],'upper');
  assert.deepEqual(get(upstairs,'upper-wall').start,[-0.25,0.5]);assert.deepEqual(get(upstairs,'moving'),get(plan,'moving'));
});

test('actual corner drag captures its floor and ignores snapping targets from another floor',()=>{
  const plan=fixture();plan.levels.push({id:'upper',name:'Upper',elevation:3,height:2.8});plan.walls.push({...get(plan,'moving'),id:'upper-wall',levelId:'upper'},{...get(plan,'moving'),id:'upper-snap',levelId:'upper',start:[0.18,0.28],end:[0.4,0.5]});
  const c=controller(plan),target={dataset:{kind:'joint',id:'moving',end:'start'}};
  c.onPointerDown({button:0,x:0,y:0,pointerId:1,target:{closest:()=>target}});assert.equal(c.dragRef.current.levelId,'ground');
  c.onPointerMove({x:0.17,y:0.27});c.onPointerUp();
  assert.deepEqual(get(c.plan,'moving').start,[0.17,0.27]);assert.deepEqual(get(c.plan,'left').start,[0.17,0.27]);
  assert.deepEqual(get(c.plan,'upper-wall'),get(plan,'upper-wall'));assert.deepEqual(get(c.plan,'upper-snap'),get(plan,'upper-snap'));
  c.history.undo();assert.deepEqual(c.plan,plan);c.history.redo();assert.deepEqual(get(c.plan,'moving').start,[0.17,0.27]);
});
