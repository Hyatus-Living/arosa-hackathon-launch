import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneBridge} from '@pascal-app/mcp';
import {pascalSceneToPlan} from './pascal-import.mjs';
import {ChatStore} from './store.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {Drawings} from './architecture-drawings.mjs';
import {createArchitectureTools,draftPlan} from './architecture-tools.mjs';
import {buildArchitectureRevision,planningCommand} from './planning.mjs';

// Use the installed Pascal runtime as the independent vertical-placement oracle.
const {getAuthoredLevelElevations}=await import(new URL('./services/storey.js',import.meta.resolve('@pascal-app/core')));
const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<1e-6,`${label}: ${actual} != ${expected}`);
const level=(id,ordinal,height,baseElevation,parentId=null)=>({id,type:'level',name:id,level:ordinal,height,baseElevation,parentId,children:[],metadata:{acresId:id}});
const withWall=nodes=>({nodes:{...nodes,wall_test:{id:'wall_test',type:'wall',parentId:Object.values(nodes).find(node=>node.type==='level').id,start:[0,0],end:[8,0],height:2.5,thickness:.2}}});
const elevations=plan=>Object.fromEntries(plan.levels.map(level=>[level.id,level.elevation]));
const oracle=nodes=>Object.fromEntries([...getAuthoredLevelElevations(nodes)].map(([id,value])=>[nodes[id].metadata?.acresId??id,value.baseY]));
const sameElevations=(actual,expected)=>{
  assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort());
  for(const [id,value] of Object.entries(expected))close(actual[id],value,id);
};

test('Pascal level ordinals and cumulative offsets preserve basements and gaps despite reversed scene order',()=>{
  const scene=withWall({top:level('top',4,3.1,.7),middle:level('middle',0,2.5,0),bottom:level('bottom',-2,3,-3)});
  const expected={bottom:-3,middle:0,top:3.2};
  sameElevations(oracle(scene.nodes),expected);
  const {plan}=pascalSceneToPlan(scene);
  sameElevations(elevations(plan),expected);
  assert.deepEqual(plan.levels.map(level=>level.id),['bottom','middle','top']);
});

test('Pascal stacks resolve explicit building parents, legacy membership and unowned levels independently',()=>{
  const scene=withWall({
    a:{id:'a',type:'building',children:['a0','a1','explicit']},
    b:{id:'b',type:'building',children:['b0','b1']},
    b1:level('b1',1,3,1),a1:level('a1',1,3,0,'a'),
    legacy1:level('legacy1',1,3,0),explicit:level('explicit',2,3,-1,'b'),
    a0:level('a0',0,3,0,'a'),b0:level('b0',0,2.5,5,'b'),legacy0:level('legacy0',0,2,-2),
  });
  const expected={a0:0,a1:3,b0:5,b1:8.5,explicit:10.5,legacy0:-2,legacy1:0};
  sameElevations(oracle(scene.nodes),expected);
  sameElevations(elevations(pascalSceneToPlan(scene).plan),expected);
});

const profiles={stacked:[[0,2.8],[2.8,3.4],[6.2,2.6]],basement:[[-3,3],[0,2.8],[2.8,2.6]],raisedGapped:[[4,3],[9,3.2],[12.2,2.8]],reorderedOverlap:[[9,2.7],[0,3],[2.5,3.5]]};
const native={skip:existsSync(planningCommand().python)?false:'planning/.venv is not installed',timeout:60000};
const measureCode=`import json,sys,ifcopenshell,ifcopenshell.geom
from ifcopenshell.util.placement import get_local_placement
f=ifcopenshell.open(sys.argv[1]); s=ifcopenshell.geom.settings(); s.set(s.USE_WORLD_COORDS,True)
storeys={x.Name:{'declared':x.Elevation,'world':float(get_local_placement(x.ObjectPlacement)[2,3])} for x in f.by_type('IfcBuildingStorey')}
walls={}
for x in f.by_type('IfcWall'):
 shape=ifcopenshell.geom.create_shape(s,x); v=shape.geometry.verts
 walls[x.Name]={'bottom':min(v[2::3]),'top':max(v[2::3])}
json.dump({'storeys':storeys,'walls':walls},sys.stdout)`;

for(const [mode,profile] of Object.entries(profiles))test(`native ${mode} plan keeps physical floor elevations through Pascal export and saved return import`,native,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-level-stack-')),owner='a'.repeat(24);
  const store=new ChatStore(join(dir,'chat.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const options={stateDir:join(dir,'state'),buildPlan:buildArchitectureRevision};
  const architecture=new Architecture(store,options),drawings=new Drawings(store,options);
  const base=draftPlan({name:mode,units:'m',height:2.8,rooms:[{name:'Living',x:0,y:0,width:8,depth:6}]}),plan={...base,levels:[],walls:[],rooms:[],openings:[]};
  profile.forEach(([elevation,height],index)=>{
    const levelId='floor'+index,elementId=id=>id+'-f'+index;
    plan.levels.push({id:levelId,name:'Floor '+index,elevation,height,slabThickness:.2});
    plan.walls.push(...base.walls.map(wall=>({...wall,id:elementId(wall.id),levelId,height,roomIds:wall.roomIds.map(elementId)})));
    plan.rooms.push(...base.rooms.map(room=>({...room,id:elementId(room.id),levelId,name:'Floor '+index+' living'})));
  });
  const projectId=store.createConversation(owner).projectId;
  await architecture.save(owner,projectId,{parentRevision:null,plan,by:'user'},row=>row);
  const summary=()=>architecture.summary(owner,projectId,row=>row),before=summary().current;
  const artifact=(revision,kind)=>architecture.artifactRow(projectId,revision.artifacts.find(row=>row.kind===kind).id).path;
  const scene=JSON.parse(readFileSync(artifact(before,'pascal-scene'))),bridge=new SceneBridge();
  bridge.loadJSON(scene);assert.equal(bridge.validateScene().valid,true);
  scene.nodes=Object.fromEntries(Object.entries(structuredClone(bridge.getNodes())).reverse());
  const expected=elevations(before.plan);
  sameElevations(oracle(scene.nodes),expected);
  const tools=createArchitectureTools({plans:{projectId,summary,drawings:()=>drawings.list(owner,projectId),
    drawing:id=>drawings.open(owner,projectId,id),save:args=>architecture.save(owner,projectId,{...args,by:'agent'},row=>row)}});
  const importScene=async parentRevision=>{
    const drawing=drawings.add(owner,projectId,{bytes:Buffer.from(JSON.stringify(scene)),name:mode+'.json',by:'user'});
    const result=await tools.handlers.acres_import_pascal_scene({drawingId:drawing.id,parentRevision});
    assert.equal(result.saved,true,JSON.stringify(result));return summary().current;
  };
  const after=await importScene(1);
  assert.equal(after.revision,2);assert.equal(after.parentRevision,1);
  sameElevations(elevations(after.plan),expected);
  assert.deepEqual(after.plan.levels.map(level=>level.id),before.plan.levels.map(level=>level.id));
  const ids=revision=>JSON.parse(readFileSync(artifact(revision,'idmap'))).elements;
  const beforeIds=ids(before),afterIds=ids(after);
  for(const entity of [...before.plan.levels,...before.plan.walls,...before.plan.rooms])assert.equal(afterIds[entity.id].ifcGlobalId,beforeIds[entity.id].ifcGlobalId);
  const readIfc=revision=>JSON.parse(execFileSync(planningCommand().python,['-c',measureCode,artifact(revision,'ifc')],{encoding:'utf8',timeout:20000}));
  const measure=readIfc(after);
  for(const level of before.plan.levels){
    close(measure.storeys[level.name].declared,level.elevation,level.id+' declared IFC');
    close(measure.storeys[level.name].world,level.elevation,level.id+' placed IFC');
  }
  for(const wall of before.plan.walls){
    close(measure.walls[wall.id].bottom,expected[wall.levelId],wall.id+' physical bottom');
    close(measure.walls[wall.id].top,expected[wall.levelId]+wall.height,wall.id+' physical top');
  }
  if(mode==='stacked'){
    const levels=Object.values(scene.nodes).filter(node=>node.type==='level').sort((a,b)=>a.level-b.level);
    levels[1].height+=.5;levels[2].baseElevation+=.25;
    scene.nodes=structuredClone(scene.nodes);
    const editedExpected=oracle(scene.nodes),edited=await importScene(2),editedMeasure=readIfc(edited);
    sameElevations(elevations(edited.plan),editedExpected);
    close(editedExpected.floor2,6.95,'edited upper floor');
    for(const level of edited.plan.levels)close(editedMeasure.storeys[level.name].world,editedExpected[level.id],level.id+' edited placement');
  }
  const staleDrawing=drawings.add(owner,projectId,{bytes:Buffer.from(JSON.stringify(scene)),name:'stale.json',by:'user'});
  const latest=summary().current.revision;
  const conflict=await tools.handlers.acres_import_pascal_scene({drawingId:staleDrawing.id,parentRevision:1});
  assert.equal(conflict.conflict,true);assert.equal(summary().current.revision,latest);
  sameElevations(elevations(architecture.revision(owner,projectId,1,row=>row).plan),expected);
  console.log('LEVEL_STACK '+JSON.stringify({mode,expected,pascal:oracle(JSON.parse(readFileSync(artifact(before,'pascal-scene'))).nodes),imported:elevations(after.plan),ifc:measure.storeys,revisions:latest}));
});
