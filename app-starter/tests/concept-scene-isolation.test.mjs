import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {Box3,ExtrudeGeometry,Group,Mesh,MeshStandardMaterial,Shape} from 'three';

const source=readFileSync(new URL('../frontend/concept-view.jsx',import.meta.url),'utf8');
const geometryStart=source.indexOf('function bounds('),geometryEnd=source.indexOf('\nfunction Camera(',geometryStart);
const groupStart=source.indexOf('function extrudedVolume('),groupEnd=source.indexOf('\n// Massing GLB',groupStart);
const glbStart=source.indexOf('async function buildConceptGlb('),glbEnd=source.indexOf('\n// PNG capture',glbStart);
assert.ok(geometryStart>=0&&geometryEnd>geometryStart&&groupStart>=0&&groupEnd>groupStart&&glbStart>=0&&glbEnd>glbStart);
const context={FOOT:.3048,EXPLODED_GAP:5,ExtrudeGeometry,Group,Mesh,MeshStandardMaterial,Shape,Blob,
  GLTFExporter:class{async parseAsync(group){context.exported=group;return new ArrayBuffer(8);}}};
vm.createContext(context);vm.runInContext(source.slice(geometryStart,geometryEnd)+'\n'+source.slice(groupStart,groupEnd)+'\n'+source.slice(glbStart,glbEnd),context);
const footprint=(x=0,w=8,d=8)=>[[x,0],[x+w,0],[x+w,d],[x,d]];
const model=(id,x=0)=>({id,name:`Model ${id}`,lot:footprint(x,12,20),levels:[
  {label:'L1',footprint:footprint(x),floorElevationFeet:0,heightFeet:10},
  {label:'L2',footprint:footprint(x),floorElevationFeet:20,heightFeet:10},
],scene:{nodes:{[id]:{id,type:'building'}}}});
const box=group=>{group.updateMatrixWorld(true);const b=new Box3().setFromObject(group);return [b.min.toArray(),b.max.toArray()];};
const group=(concept,options)=>{assert.equal(typeof context.buildConceptGroup,'function','the viewer needs an instance-owned scene builder');return context.buildConceptGroup(concept,options);};
const meshes=root=>{const out=[];root.traverse(node=>{if(node.isMesh)out.push(node);});return out;};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} differs from ${b}`);

test('mounting model B cannot replace the scene content owned by model A',async()=>{
  const a=model('A'),b=model('B',100);
  const loadStart=source.indexOf('  useEffect(() => {\n    let active = true;\n    void registryReady.then');
  if(loadStart>=0){
    const loadEnd=source.indexOf('\n  }, [concept]);',loadStart)+ '\n  }, [concept]);'.length;
    const shared={nodes:null};
    const mount=concept=>{
      const c={concept,registryReady:Promise.resolve(),useEffect:fn=>fn(),setReady(){},useScene:{getState:()=>({setScene:nodes=>{shared.nodes=nodes;}})},useViewer:{getState:()=>({setSelection(){}})}};
      vm.runInNewContext(source.slice(loadStart,loadEnd),c);
      return ()=>Object.keys(shared.nodes)[0];
    };
    const readA=mount(a);await new Promise(setImmediate);mount(b);await new Promise(setImmediate);
    assert.equal(readA(),'A','the old production scene effect loads both roots into one global store');
  }else{
    const sceneA=group(a),sceneB=group(b);
    assert.equal(sceneA.userData.conceptId,'A');assert.equal(sceneB.userData.conceptId,'B');
    near(box(sceneA)[1][0],12);near(box(sceneB)[0][0],100);
    assert.doesNotMatch(source,/useScene|useViewer|<Viewer\b/,'the independent canvas must not write shared scene/selection controls');
    const start=source.indexOf('function MassingModel('),end=source.indexOf('\n// Surrounding buildings',start);
    assert.ok(start>=0&&end>start);
    const c={buildConceptGroup:context.buildConceptGroup,disposeConceptGroup:context.disposeConceptGroup,useMemo:fn=>fn(),useEffect:fn=>fn(),useThree:fn=>fn({invalidate(){}}),React:{createElement:(type,props)=>({type,props})}};
    vm.createContext(c);vm.runInContext(transformSync(source.slice(start,end),{loader:'jsx'}).code,c);
    const rendered=c.MassingModel({concept:a,exploded:false,onReady(){}});
    assert.equal(rendered.type,'primitive');assert.equal(rendered.props.object.userData.conceptId,'A');
    assert.match(source,/<MassingModel concept=\{concept\}/,'the canvas receives its own concept props');
  }
});

test('concept scene bounds preserve metre footprints and explicit source floor elevations',()=>{
  const scene=group(model('A')),bounds=box(scene);
  near(bounds[0][0],0);near(bounds[1][0],12);near(bounds[1][2],20);
  near(bounds[0][1],-.3048);near(bounds[1][1],30*.3048);
  const extent=context.bounds(model('A'),false);
  near(extent.height,bounds[1][1]-bounds[0][1]);near(extent.center[1],(bounds[1][1]+bounds[0][1])/2);
  assert.deepEqual(meshes(scene).map(m=>m.name),['Lot','L1','L2']);
});

test('exploding another model cannot change the first scene or the saved concept data',()=>{
  const a=model('A'),b=model('B',100),saved=JSON.stringify({a,b});
  const sceneA=group(a),before=box(sceneA),sceneB=group(b,{exploded:true});
  near(box(sceneB)[1][1],30*.3048+5);
  assert.deepEqual(box(sceneA),before);assert.equal(JSON.stringify({a,b}),saved);
});

test('separate viewers own separate meshes, materials and disposal lifetimes',()=>{
  const a=group(model('A')),b=group(model('B'));
  const ma=meshes(a),mb=meshes(b);let disposedA=0;
  for(const mesh of ma){mesh.geometry.addEventListener('dispose',()=>disposedA++);mesh.material.addEventListener('dispose',()=>disposedA++);}
  assert.notEqual(ma[1].geometry,mb[1].geometry);assert.notEqual(ma[1].material,mb[1].material);
  assert.equal(typeof context.disposeConceptGroup,'function');context.disposeConceptGroup(b);
  assert.equal(disposedA,0);near(box(a)[1][1],30*.3048);
});

test('GLB construction and the stacked viewer use the same physical scene geometry',async()=>{
  const concept=model('A'),scene=group(concept);
  const blob=await context.buildConceptGlb(concept);
  assert.equal(blob.type,'model/gltf-binary');assert.deepEqual(box(context.exported),box(scene));
  assert.equal(context.exported.userData.conceptId,concept.id);
});

test('legacy concepts reconstruct scene footprints from their saved wall nodes',()=>{
  const concept=model('A');delete concept.levels[0].footprint;
  concept.levels[0].levelId='level-1';
  for(const [i,p] of footprint().entries())concept.scene.nodes[`wall-${i}`]={type:'wall',parentId:'level-1',start:p};
  const scene=group(concept),first=meshes(scene).find(mesh=>mesh.name==='L1');
  first.geometry.computeBoundingBox();near(first.geometry.boundingBox.max.x,8);
  near(box(scene)[1][1],30*.3048);
});
