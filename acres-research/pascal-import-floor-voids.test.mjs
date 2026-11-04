import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SceneBridge} from '@pascal-app/mcp';
import {pascalSceneToPlan} from './pascal-import.mjs';
import {ChatStore} from './store.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {Drawings} from './architecture-drawings.mjs';
import {createArchitectureTools} from './architecture-tools.mjs';
import {buildArchitectureRevision,planningCommand} from './planning.mjs';

// Produced by the native Acres exporter from test_floor_regions.courtyard(), including its
// explicit void room and linked floor opening. Kept as data so pure checks also run without Python.
const fixture=()=>JSON.parse(readFileSync(new URL('./testing/pascal-courtyard-scene.json',import.meta.url),'utf8'));
const originalRoomIds=scene=>Object.values(scene.nodes).filter(node=>node.type==='zone'&&!node.metadata.floorVoid).map(node=>node.metadata.acresId).sort();
const load=scene=>{const bridge=new SceneBridge();bridge.loadJSON(scene);assert.equal(bridge.validateScene().valid,true);return {...scene,nodes:structuredClone(bridge.getNodes())};};

test('an Acres floor void is excluded from raw scene rooms without dropping a legitimate room edit',()=>{
  const scene=fixture(),room=Object.values(scene.nodes).find(node=>node.type==='zone'&&!node.metadata.floorVoid);
  room.name='Reviewed living room';room.metadata.floorVoid=false;
  const {plan}=pascalSceneToPlan(scene);
  assert.deepEqual(plan.rooms.map(room=>room.id).sort(),originalRoomIds(scene));
  assert.equal(plan.rooms.find(row=>row.id===room.metadata.acresId).name,'Reviewed living room');
  assert.ok(plan.rooms.every(room=>room.name!=='Floor void 1'));
  assert.ok(plan.walls.every(wall=>wall.roomIds.every(id=>plan.rooms.some(room=>room.id===id))));
});

test('actual Pascal load normalization keeps the explicit void out of room identity and wall membership',()=>{
  const scene=load(fixture()),voids=Object.values(scene.nodes).filter(node=>node.type==='zone'&&node.metadata.floorVoid);
  assert.equal(voids.length,1);assert.equal(voids[0].hasFloor,false);assert.equal(voids[0].hasCeiling,false);
  const {plan}=pascalSceneToPlan(scene);
  assert.deepEqual(plan.rooms.map(room=>room.id).sort(),originalRoomIds(scene));
  assert.equal(plan.rooms.length,4);
  for(const wall of plan.walls)assert.ok(wall.roomIds.every(id=>plan.rooms.some(room=>room.id===id)));
});

const planningDir=fileURLToPath(new URL('../planning',import.meta.url)),{python}=planningCommand(planningDir);
const metricsCode=`import json,sys
import ifcopenshell,ifcopenshell.geom
from ifcopenshell.util.shape import get_volume
from shapely.ops import unary_union
from shapely.geometry import Point
from test_floor_regions import profile_polygon
import architecture as arch
p=json.load(open(sys.argv[1])); model=ifcopenshell.open(sys.argv[2]); slabs=model.by_type('IfcSlab')
floor=unary_union([profile_polygon(s) for s in slabs])
json.dump({'area':floor.area,'holes':sum(len(g.interiors) for g in ([floor] if floor.geom_type=='Polygon' else getattr(floor,'geoms',[]))), 'slabs':len(slabs),'netArea':sum(arch.net_area(p,r) for r in p['rooms']),'spaces':len(model.by_type('IfcSpace')),'volume':sum(get_volume(ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(),s).geometry) for s in slabs),'courtyardCovered':floor.covers(Point(5,5))},sys.stdout)`;

test('native drawing import revisions retain courtyard IFC area and voids through raw, loaded and edited Pascal scenes',{skip:existsSync(python)?false:'planning/.venv is not installed',timeout:60000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-void-import-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const options={stateDir:join(dir,'state'),planningDir,buildPlan:buildArchitectureRevision},architecture=new Architecture(store,options),drawings=new Drawings(store,options);
  const plans=JSON.parse(execFileSync(python,['-c',`import json; from test_floor_regions import courtyard,detached; p=courtyard(); p['levels'].append({'id':'empty-upper','name':'Empty upper','elevation':2.8,'height':2.8,'slabThickness':.2}); json.dump([courtyard(),detached(),p],__import__('sys').stdout)`],{cwd:planningDir,encoding:'utf8'}));
  const report=[];
  for(const mode of ['raw-courtyard','loaded-courtyard','edited-courtyard','detached','empty-upper']){
    const input=structuredClone(plans[mode==='detached'?1:mode==='empty-upper'?2:0]);
    const projectId=store.createConversation(owner).projectId;
    await architecture.save(owner,projectId,{parentRevision:null,plan:input},row=>row);
    const summary=()=>architecture.summary(owner,projectId,row=>row),source=summary().current;
    const path=(current,kind)=>architecture.artifactRow(projectId,current.artifacts.find(row=>row.kind===kind).id).path;
    const measure=current=>JSON.parse(execFileSync(python,['-c',metricsCode,path(current,'plan'),path(current,'ifc')],{cwd:planningDir,encoding:'utf8',timeout:20000}));
    const before=measure(source),sourceMap=JSON.parse(readFileSync(path(source,'idmap'),'utf8'));
    let scene=JSON.parse(readFileSync(path(source,'pascal-scene'),'utf8'));
    if(mode!=='raw-courtyard')scene=load(scene);
    const editedRoom=Object.values(scene.nodes).find(node=>node.type==='zone'&&!node.metadata.floorVoid);
    if(mode==='edited-courtyard'){
      editedRoom.name='Reviewed living room';
      for(const node of Object.values(scene.nodes))if(node.type==='wall'||node.type==='level')node.height=3.2;
    }
    const drawing=drawings.add(owner,projectId,{bytes:Buffer.from(JSON.stringify(scene)),name:mode+'.pascal.json',by:'user'});
    const access={projectId,summary,drawings:()=>drawings.list(owner,projectId),drawing:id=>drawings.open(owner,projectId,id),save:args=>architecture.save(owner,projectId,{...args,by:'agent'},row=>row)};
    const tools=createArchitectureTools({plans:access});
    const result=await tools.handlers.acres_import_pascal_scene({drawingId:drawing.id,parentRevision:1});
    assert.equal(result.saved,true,JSON.stringify(result));assert.equal(result.revision,2);
    const current=summary().current,after=measure(current),targetMap=JSON.parse(readFileSync(path(current,'idmap'),'utf8'));
    assert.equal(current.plan.id,source.plan.id);assert.equal(current.plan.levels.length,source.plan.levels.length);
    assert.deepEqual(current.plan.rooms.map(room=>room.id).sort(),source.plan.rooms.map(room=>room.id).sort());
    for(const key of ['area','netArea','volume'])assert.ok(Math.abs(before[key]-after[key])<1e-6,`${mode} ${key}: ${before[key]} -> ${after[key]}`);
    for(const key of ['holes','slabs','spaces','courtyardCovered'])assert.equal(after[key],before[key],`${mode} ${key}`);
    for(const room of source.plan.rooms)assert.equal(targetMap.elements[room.id].ifcGlobalId,sourceMap.elements[room.id].ifcGlobalId);
    if(mode==='edited-courtyard'){
      assert.equal(current.plan.rooms.find(room=>room.id===editedRoom.metadata.acresId).name,'Reviewed living room');
      assert.equal(current.plan.levels[0].height,3.2);assert.ok(current.plan.walls.every(wall=>wall.height===3.2));
    }
    const conflict=await tools.handlers.acres_import_pascal_scene({drawingId:drawing.id,parentRevision:1});assert.equal(conflict.saved,false);assert.equal(summary().current.revision,2);
    report.push({mode,rooms:current.plan.rooms.length,...after});
  }
  console.log('VOID_ROUNDTRIP '+JSON.stringify(report));
});
