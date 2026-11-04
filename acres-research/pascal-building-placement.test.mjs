import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Matrix4,Euler,Vector3} from 'three';
import {SceneBridge} from '@pascal-app/mcp';
import {sceneViewBounds} from '@pascal-app/core/agent-operations';
import {pascalSceneToPlan} from './pascal-import.mjs';
import {ChatStore} from './store.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {Drawings} from './architecture-drawings.mjs';
import {createArchitectureTools,draftPlan} from './architecture-tools.mjs';
import {buildArchitectureRevision,planningCommand} from './planning.mjs';

const fixture=()=>JSON.parse(readFileSync(new URL('./testing/pascal-courtyard-scene.json',import.meta.url)));
const close=(a,b,label='coordinate')=>assert.ok(Math.abs(a-b)<1e-5,`${label}: ${a} != ${b}`);
const vectorClose=(a,b)=>{assert.equal(a.length,b.length);a.forEach((n,i)=>close(n,b[i]));};
const matrix=pose=>new Matrix4().makeRotationFromEuler(new Euler(...pose.rotation)).setPosition(...pose.position);
// Independent Three.js XYZ Euler placement, converting between Pascal Y-up and plan Z-up.
const worldPoint=(point,pose)=>{const v=new Vector3(point[0],point[2],-point[1]).applyMatrix4(matrix(pose));return [v.x,-v.z,v.y];};

test('an upright Pascal building transform moves every wall, room and floor while openings remain wall-local',()=>{
  const scene=fixture(),original=pascalSceneToPlan(scene).plan;
  const building=Object.values(scene.nodes).find(node=>node.type==='building');
  const pose={position:[12,4,-7],rotation:[0,.63,0]};Object.assign(building,pose);
  const actual=pascalSceneToPlan(scene).plan;
  for(const wall of original.walls){const next=actual.walls.find(row=>row.id===wall.id);for(const end of ['start','end'])vectorClose(next[end],worldPoint([...wall[end],0],pose).slice(0,2));}
  for(const room of original.rooms){const next=actual.rooms.find(row=>row.id===room.id);room.polygon.forEach((point,i)=>vectorClose(next.polygon[i],worldPoint([...point,0],pose).slice(0,2)));}
  for(const level of original.levels)close(actual.levels.find(row=>row.id===level.id).elevation,level.elevation+4);
  assert.deepEqual(actual.openings,original.openings);
});

test('building transforms follow explicit parents or legacy membership and apply vertical translation only once per stack',()=>{
  const a={id:'a',type:'building',position:[10,3,5],rotation:[0,Math.PI/2,0],children:['a0','a1']};
  const b={id:'b',type:'building',position:[-8,-2,11],rotation:[0,-Math.PI/2,0],children:['legacy']};
  const level=(id,ordinal,parentId)=>({id,type:'level',level:ordinal,parentId,height:2.8,baseElevation:0,metadata:{acresId:id}});
  const wall=(id,parentId)=>({id,type:'wall',parentId,start:[0,0],end:[4,0],height:2.8,thickness:.2,metadata:{acresId:id}});
  const scene={nodes:{a,b,a0:level('a0',0,'a'),a1:level('a1',1,'a'),legacy:level('legacy',0,null),wa:wall('wa','a0'),wa1:wall('wa1','a1'),wb:wall('wb','legacy')}};
  const {plan}=pascalSceneToPlan(scene);
  for(const [id,pose] of [['wa',a],['wa1',a],['wb',b]])vectorClose(plan.walls.find(wall=>wall.id===id).end,worldPoint([4,0,0],pose).slice(0,2));
  for(const [id,elevation] of [['a0',3],['a1',5.8],['legacy',-2]])close(plan.levels.find(level=>level.id===id).elevation,elevation);
});

test('tilted Pascal buildings are refused rather than flattened into horizontal floors',()=>{
  for(const rotation of [[.2,0,0],[0,0,-.3],[.2,.6,.3]]){
    const scene=fixture();Object.values(scene.nodes).find(node=>node.type==='building').rotation=rotation;
    assert.throws(()=>pascalSceneToPlan(scene),/tilt|horizontal|upright/i);
  }
});

const native={skip:existsSync(planningCommand().python)?false:'planning/.venv is not installed',timeout:60000};
const poses={moved:{position:[12,4,-7],rotation:[0,0,0]},quarterTurn:{position:[12,4,-7],rotation:[0,Math.PI/2,0]},oblique:{position:[-10,-2,6],rotation:[0,-.63,0]},identity:{position:[0,0,0],rotation:[0,0,0]},tilted:{position:[12,4,-7],rotation:[.2,.4,0]}};
const measureCode=`import json,sys,ifcopenshell,ifcopenshell.geom
from ifcopenshell.util.shape import get_volume,get_area
f=ifcopenshell.open(sys.argv[1]); s=ifcopenshell.geom.settings(); s.set(s.USE_WORLD_COORDS,True)
out={}
for kind in ['IfcWall','IfcSlab','IfcSpace','IfcDoor','IfcWindow']:
 for element in f.by_type(kind):
  shape=ifcopenshell.geom.create_shape(s,element); vertices=shape.geometry.verts
  points=sorted(set(tuple(round(float(v),8) for v in vertices[i:i+3]) for i in range(0,len(vertices),3)))
  out[element.GlobalId]={'class':kind,'name':element.Name,'points':points,'volume':float(get_volume(shape.geometry)),'surfaceArea':float(get_area(shape.geometry))}
json.dump(out,sys.stdout)`;

for(const [mode,pose] of Object.entries(poses))test(`native ${mode} Pascal scene retains physical world placement or refuses unsupported tilt without saving`,native,async t=>{
  const retained=process.env.ACRES_PASCAL_PLACEMENT_EVIDENCE;
  const dir=retained?join(resolve(retained),mode):mkdtempSync(join(tmpdir(),'acres-placement-'));
  if(retained){assert.equal(existsSync(dir),false,'evidence directories must not be overwritten');mkdirSync(dir,{recursive:true});}
  const store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24);
  t.after(()=>{store.close();if(!retained)rmSync(dir,{recursive:true,force:true});});
  const options={stateDir:join(dir,'state'),buildPlan:buildArchitectureRevision};
  const architecture=new Architecture(store,options),drawings=new Drawings(store,options);
  const base=draftPlan({name:mode,units:'m',height:2.8,rooms:[{name:'Living',x:0,y:0,width:8,depth:6}],openings:[{kind:'door',x:3,y:0,width:.9,height:2.1}]}),plan={...base,levels:[],walls:[],rooms:[],openings:[]};
  for(let i=0;i<2;i++){
    const levelId='floor'+i,id=old=>old+'-f'+i,height=i?3.2:2.8;
    plan.levels.push({id:levelId,name:'Floor '+i,elevation:i?2.8:0,height,slabThickness:.2});
    plan.walls.push(...base.walls.map(wall=>({...wall,id:id(wall.id),levelId,height,roomIds:wall.roomIds.map(id)})));
    plan.rooms.push(...base.rooms.map(room=>({...room,id:id(room.id),levelId,name:'Floor '+i+' living'})));
    plan.openings.push(...base.openings.map(opening=>({...opening,id:id(opening.id),wallId:id(opening.wallId)})));
  }
  const projectId=store.createConversation(owner).projectId;
  await architecture.save(owner,projectId,{parentRevision:null,plan,by:'user'},row=>row);
  const summary=()=>architecture.summary(owner,projectId,row=>row),before=summary().current;
  const artifact=(revision,kind)=>architecture.artifactRow(projectId,revision.artifacts.find(row=>row.kind===kind).id).path;
  const scene=JSON.parse(readFileSync(artifact(before,'pascal-scene')));
  const building=Object.values(scene.nodes).find(node=>node.type==='building');Object.assign(building,pose);
  const bridge=new SceneBridge();bridge.loadJSON(scene);assert.equal(bridge.validateScene().valid,true);
  scene.nodes=structuredClone(bridge.getNodes());
  const drawing=drawings.add(owner,projectId,{bytes:Buffer.from(JSON.stringify(scene)),name:mode+'.json',by:'user'});
  const tools=createArchitectureTools({plans:{projectId,summary,drawings:()=>drawings.list(owner,projectId),drawing:id=>drawings.open(owner,projectId,id),save:args=>architecture.save(owner,projectId,{...args,by:'agent'},row=>row)}});
  const result=await tools.handlers.acres_import_pascal_scene({drawingId:drawing.id,parentRevision:1});
  const after=summary().current,sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const readIfc=revision=>JSON.parse(execFileSync(planningCommand().python,['-c',measureCode,artifact(revision,'ifc')],{encoding:'utf8',timeout:20000}));
  const beforeIfc=readIfc(before),afterIfc=readIfc(after);
  if(retained){
    const files=Object.fromEntries([['before',before],['after',after]].map(([phase,revision])=>[phase,Object.fromEntries(revision.artifacts.map(item=>{const path=architecture.artifactRow(projectId,item.id).path;return [item.kind,{path,sha256:sha(path)}];}))]));
    writeFileSync(join(dir,'result.json'),JSON.stringify({mode,pose,result,beforeIfc,afterIfc,files},null,2)+'\n');
  }
  if(mode==='tilted'){
    assert.equal(result.saved,false);assert.match(result.error,/tilt|horizontal|upright/i);
    assert.equal(after.revision,1);assert.deepEqual(after.plan,before.plan);assert.equal(summary().revisions.length,1);
    assert.equal(existsSync(join(options.stateDir,'architecture','plans',before.plan.id,'2')),false);
    return;
  }
  assert.equal(result.saved,true,JSON.stringify(result));assert.equal(after.revision,2);
  assert.deepEqual(Object.keys(afterIfc).sort(),Object.keys(beforeIfc).sort());
  for(const [id,original] of Object.entries(beforeIfc)){
    const target=afterIfc[id],expected=original.points.map(point=>worldPoint(point,pose));
    assert.equal(target.class,original.class);
    // Coordinates and derived wall-face intersections are stored at six decimals in metres.
    // Bound volume change by surface area times that spatial resolution, rather than a fixed
    // cubic-metre threshold that becomes stricter as a room grows. Check every vertex too.
    const resolution=2e-6;
    assert.ok(Math.abs(target.volume-original.volume)<=original.surfaceArea*resolution,id+' volume at plan precision');
    const near=(a,b)=>Math.hypot(...a.map((n,i)=>n-b[i]))<resolution;
    assert.ok(target.points.every(point=>expected.some(candidate=>near(point,candidate))),original.class+' actual vertices');
    assert.ok(expected.every(point=>target.points.some(candidate=>near(point,candidate))),original.class+' expected vertices');
  }
  const returnedScene=JSON.parse(readFileSync(artifact(after,'pascal-scene')));
  for(const level of Object.values(scene.nodes).filter(node=>node.type==='level')){
    const originalBounds=sceneViewBounds(scene.nodes,level.id),returnedLevel=Object.values(returnedScene.nodes).find(node=>node.type==='level'&&node.metadata.acresId===level.metadata.acresId);
    const returnedBounds=sceneViewBounds(returnedScene.nodes,returnedLevel.id);
    vectorClose(returnedBounds.min,originalBounds.min);vectorClose(returnedBounds.max,originalBounds.max);
  }
  assert.deepEqual(after.plan.openings,before.plan.openings);
  assert.deepEqual(architecture.revision(owner,projectId,1,row=>row).plan,before.plan);
  const conflict=await tools.handlers.acres_import_pascal_scene({drawingId:drawing.id,parentRevision:1});
  assert.equal(conflict.conflict,true);assert.equal(summary().current.revision,2);
  console.log('BUILDING_PLACEMENT '+JSON.stringify({mode,pose,elements:Object.keys(afterIfc).length,revision:after.revision,vertexSetsAndVolumesMatch:true,reexportedPascalBoundsMatch:true}));
});
