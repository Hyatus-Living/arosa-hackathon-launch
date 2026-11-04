import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SceneBridge} from '@pascal-app/mcp';
import {ChatStore} from './store.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {buildArchitectureRevision,planningCommand} from './planning.mjs';

const planningDir=fileURLToPath(new URL('../planning',import.meta.url)),{python}=planningCommand(planningDir);
const skip=existsSync(python)?false:'planning/.venv is not installed';
for(const name of [
  'disconnected_wall_preserves_both_regions_and_the_gap',
  'disconnected_rooms_classify_exterior_walls_without_crossing_the_gap',
  'disconnected_exports_keep_all_components_and_matching_element_ids',
  'courtyard_void_survives_ifc_mesh_and_pascal_polygon_holes',
  'empty_level_has_no_invented_slab_and_keeps_a_readable_svg_panel',
  'an_empty_draft_exports_structure_without_fabricating_floor_geometry',
  'region_order_and_existing_element_ids_survive_reordering_and_revision',
])test(`native floor export: ${name.replaceAll('_',' ')}`,{skip},()=>{
  const output=execFileSync(python,['-m','unittest',`test_floor_regions.FloorRegions.test_${name}`],{cwd:planningDir,encoding:'utf8',timeout:30000,stdio:'pipe'});
  assert.doesNotMatch(output,/FAILED/);
});

test('native multipart, courtyard and empty-level revisions persist and load in the actual Pascal scene contract',{skip},async()=>{
  const ring=points=>{
    const corners=points.filter(([x,z],i)=>{const a=points[(i+points.length-1)%points.length],b=points[(i+1)%points.length];return Math.abs((x-a[0])*(b[1]-z)-(z-a[1])*(b[0]-x))>1e-8;});
    return [corners,[...corners].reverse()].flatMap(points=>points.map((_,i)=>JSON.stringify([...points.slice(i),...points.slice(0,i)]))).sort()[0];
  };
  const dir=mkdtempSync(join(tmpdir(),'acres-floor-store-')),store=new ChatStore(join(dir,'chat.sqlite'));
  const architecture=new Architecture(store,{stateDir:dir,planningDir,buildPlan:buildArchitectureRevision});
  try{
    const plans=JSON.parse(execFileSync(python,['-c','import json; from test_floor_regions import detached, courtyard, rectangles; json.dump([detached(),courtyard(),rectangles([])],__import__("sys").stdout)'],{cwd:planningDir,encoding:'utf8',timeout:30000}));
    for(const plan of plans){
      const conversation=store.createConversation('controlled');
      await architecture.save('controlled',conversation.projectId,{parentRevision:null,plan},row=>row);
      const current=architecture.summary('controlled',conversation.projectId,row=>row).current;
      assert.equal(current.revision,1);assert.equal(current.plan.walls.length,plan.walls.length);
      const artifact=kind=>JSON.parse(readFileSync(architecture.artifactRow(conversation.projectId,current.artifacts.find(a=>a.kind===kind).id).path,'utf8'));
      const scene=artifact('pascal-scene'),idMap=artifact('idmap'),bridge=new SceneBridge();bridge.loadJSON(scene);
      assert.equal(bridge.validateScene().valid,true);assert.deepEqual(bridge.validateScene().errors,[]);
      const loaded=bridge.getNodes(),voids=Object.values(scene.nodes).filter(node=>node.type==='zone'&&node.metadata.floorVoid);
      assert.equal(Object.keys(loaded).length,Object.keys(scene.nodes).length);
      for(const node of voids){assert.equal(loaded[node.id].hasFloor,false);assert.equal(loaded[node.id].hasCeiling,false);}
      for(const [elementId,ids]of Object.entries(idMap.elements)){
        const node=loaded[ids.pascalNodeId];assert.equal(node.metadata.acresId,elementId);
        for(const key of ['polygon','holes','start','end','height','thickness'])if(scene.nodes[node.id][key]!==undefined&&!(node.type==='zone'&&key==='polygon')){
          if(key==='holes')assert.deepEqual(node.holes.map(ring).sort(),scene.nodes[node.id].holes.map(ring).sort());
          else assert.deepEqual(node[key],scene.nodes[node.id][key]);
        }
        if(node.type==='zone'){
          const room=plan.rooms.find(room=>room.id===elementId),gross=room.polygon.map(([x,y])=>[x,-y]).reverse();
          assert.equal(ring(node.polygon),ring(gross));
          assert.equal(node.metadata.netArea,scene.nodes[node.id].metadata.netArea);
          assert.deepEqual(node.boundaryWallIds.map(id=>loaded[id].metadata.acresId).sort(),scene.nodes[node.id].boundaryWallIds.map(id=>scene.nodes[id].metadata.acresId).sort());
        }
      }
    }
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
