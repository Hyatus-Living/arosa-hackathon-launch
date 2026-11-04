import {Box3, DoubleSide} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {collisionWorld, worldTriangles} from './architecture-model.mjs';

const DEFAULT_FINISH={wall:'#eeeae3',slab:'#bcb5aa',door:'#b49c82',window:'#bdd4dc'};

export function dollhouseMeshVisible(mesh,index,storeyHeights,floorElevation) {
  const height=storeyHeights.get(mesh.userData.levelId);
  if(height!==undefined&&height>floorElevation+1e-6)return false;
  // IFC roofs can be IfcSlab elements on the same storey as its floor. Remove the
  // overhead slab by its geometry, without relying on a name or hiding the floor.
  return index.objects.get(mesh.userData.node)?.kind!=='slab'||
    new Box3().setFromObject(mesh).min.y<=floorElevation+0.35;
}

export function setSpaceShellVisible(mesh,walking) {
  if(!mesh.userData.spaceShell)return;
  for(const material of [mesh.material].flat())material.visible=walking?false:material.userData.spaceOriginalVisible;
}

export function disposeScene(scene) {
  const resources=new Set();
  scene.traverse(object=>{
    if(object.geometry)resources.add(object.geometry);
    for(const material of [object.material].flat().filter(Boolean)) {
      resources.add(material);
      for(const value of Object.values(material))if(value?.isTexture)resources.add(value);
    }
  });
  for(const resource of resources)resource.dispose();
}

export async function loadArchitectureModel(url,index,levels,{signal,fetcher=fetch,loader=new GLTFLoader()}={}) {
  const response=await fetcher(url,{credentials:'same-origin',signal});
  if(!response.ok)throw new Error(`model ${response.status}`);
  const bytes=await response.arrayBuffer();
  signal?.throwIfAborted();
  const gltf=await loader.parseAsync(bytes,new URL('.',new URL(url,globalThis.location?.href)).href);
  const scene=gltf.scene;
  if(signal?.aborted){disposeScene(scene);signal.throwIfAborted();}
  scene.updateMatrixWorld(true);
  const meshes=[],originals=new Set(),authoredRooms=new Set(),authoredFloors=new Set();
  scene.traverse(object=>{
    if(!object.isMesh)return;
    let name=null,owner=null;
    for(let node=object;node;node=node.parent)if(index.objects.has(node.name)){name=node.name;owner=node;break;}
    const association=gltf.parser?.associations;
    const primitive=association?.get(object);
    const source=primitive&&gltf.parser.json?.meshes?.[primitive.meshes]?.primitives?.[primitive.primitives];
    const clone=material=>{
      originals.add(material);
      const copy=material.clone();
      // glTF's implicit material is metallic. Older unstyled IFC exports have no
      // environment map, so that default makes their walls render black indoors.
      if(source&&source.material===undefined&&copy.isMeshStandardMaterial){
        copy.metalness=0;
        const color=DEFAULT_FINISH[index.objects.get(name)?.kind];
        if(color)copy.color.set(color);
        if(index.objects.get(name)?.kind==='window'){
          copy.transparent=true;copy.opacity=.28;copy.depthWrite=false;copy.side=DoubleSide;copy.roughness=.15;
        }
      }
      return copy;
    };
    object.material=Array.isArray(object.material)?object.material.map(clone):clone(object.material);
    object.userData.node=name;
    object.userData.levelId=name?index.objects.get(name).levelId??null:null;
    object.userData.implicitWall=Boolean(source&&source.material===undefined&&index.objects.get(name)?.kind==='wall');
    object.userData.implicitDoor=Boolean(source&&source.material===undefined&&index.objects.get(name)?.kind==='door');
    // A space is an IFC room volume, not a surface. Keep its children (such as furniture and
    // floor finishes) visible; only the primitives belonging to the space mesh are its shell.
    object.userData.spaceShell=Boolean(name&&index.objects.get(name).kind==='space'&&
      (object===owner||(association?.get(object)?.meshes!==undefined&&association.get(object).meshes===association.get(owner)?.meshes)));
    if(object.userData.spaceShell)for(const material of [object.material].flat())material.userData.spaceOriginalVisible=material.visible;
    // The shell must occlude the sun or daylight falls through walls and roof as if
    // they were absent. Glass stays out of the shadow map (its depth material would
    // otherwise cast a solid pane shadow) and the invisible room volume never casts.
    object.castShadow=!object.userData.spaceShell&&index.objects.get(name)?.kind!=='window';
    object.receiveShadow=!object.userData.spaceShell;
    if(name&&index.objects.get(name).kind==='space'&&!object.userData.spaceShell){
      const roomId=index.objects.get(name).roomId;
      if(roomId&&/floor/i.test(object.name))authoredFloors.add(roomId);
      if(roomId&&/sofa|bed|chair|vanity|table|counter|tub/i.test(object.name))authoredRooms.add(roomId);
    }
    meshes.push(object);
  });
  for(const material of originals)material.dispose();
  // Walking requests collision for only the level underfoot. Dollhouse and plan
  // views do not triangulate meshes or allocate collision worlds.
  let triangles=null,disposed=false;
  const cache=new Map(),base=Math.min(...levels.map(level=>level.elevation));
  const worlds={get(id){
    if(cache.has(id))return cache.get(id);
    if(!triangles){
      triangles={walls:[],floors:[]};
      for(const mesh of meshes){
        const name=mesh.userData.node;
        const target=index.walls.has(name)?triangles.walls:index.floors.has(name)?triangles.floors:null;
        if(target)target.push(...worldTriangles(mesh.geometry.attributes.position.array,mesh.geometry.index?.array??null,mesh.matrixWorld.elements));
      }
    }
    const level=levels.find(level=>level.id===id);
    const world=collisionWorld({...triangles,elevation:level.elevation,baseElevation:base});
    cache.set(id,world);return world;
  }};
  return {scene,meshes,worlds,authoredRooms,authoredFloors,legacyUnstyled:!(gltf.parser?.json?.materials?.length),dispose(){if(disposed)return;disposed=true;cache.clear();triangles=null;disposeScene(scene);}};
}
