import test from 'node:test';
import assert from 'node:assert/strict';
import {BoxGeometry, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Raycaster, Vector3} from 'three';
import {dollhouseMeshVisible,loadArchitectureModel,setSpaceShellVisible} from '../frontend/architecture-loader.mjs';
import {selectionIndex} from '../frontend/architecture-model.mjs';

test('dollhouse removes an overhead IFC slab while keeping the selected floor and walls',()=>{
  const index=selectionIndex({objects:[{glbNodeName:'cap',kind:'slab'},{glbNodeName:'base',kind:'slab'},{glbNodeName:'wall',kind:'wall'}],collision:{walls:[],floors:[]}});
  const make=(node,y,level='ground')=>{
    const mesh=new Mesh(new BoxGeometry(10,.2,8));mesh.position.y=y;
    mesh.userData={node,levelId:level};mesh.updateMatrixWorld(true);return mesh;
  };
  const heights=new Map([['ground',0],['upper',3]]);
  assert.equal(dollhouseMeshVisible(make('cap',2.7),index,heights,0),false);
  assert.equal(dollhouseMeshVisible(make('base',-.1),index,heights,0),true);
  assert.equal(dollhouseMeshVisible(make('wall',1.4),index,heights,0),true);
  assert.equal(dollhouseMeshVisible(make('base',2.9,'upper'),index,heights,0),false);
  assert.equal(dollhouseMeshVisible(make('base',2.9,'upper'),index,heights,3),true);
});

test('unstyled IFC surfaces are readable without changing authored materials or hiding room contents',async()=>{
  const scene=new Group(),associations=new Map();
  const make=(name,mesh,material)=>{
    const object=new Mesh(new BoxGeometry(),new MeshStandardMaterial({metalness:1}));object.name=name;
    associations.set(object,{meshes:mesh,primitives:0});
    return object;
  };
  const wall=make('wall',0),metal=make('authored',1),room=new Group(),shell=make('space-primitive',2),chair=make('chair',3),floor=make('floor',4),window=make('window',5);
  room.name='space';room.add(shell,chair,floor);scene.add(wall,metal,room,window);associations.set(room,{meshes:2});
  const index=selectionIndex({objects:[{glbNodeName:'wall',kind:'wall'},{glbNodeName:'authored',kind:'door'},{glbNodeName:'space',kind:'space',roomId:'room'},{glbNodeName:'window',kind:'window'}],collision:{walls:[],floors:[]}});
  const parser={associations,json:{meshes:[{primitives:[{}]},{primitives:[{material:0}]},{primitives:[{}]},{primitives:[{}]},{primitives:[{}]},{primitives:[{}]}]}};
  const model=await loadArchitectureModel('https://example.test/model.glb',index,[{id:'L1',elevation:0}],{fetcher:async()=>new Response(new Uint8Array([1])),loader:{parseAsync:async()=>({scene,parser})}});
  assert.equal(wall.material.metalness,0,'unassigned materials are not dark metallic surfaces');
  assert.equal(metal.material.metalness,1,'explicitly authored metal is preserved');
  assert.equal(wall.userData.implicitWall,true,'only unstyled wall surfaces receive a visualization finish');
  assert.equal(metal.userData.implicitWall,false);
  assert.equal(metal.userData.implicitDoor,false,'authored door materials remain untouched');
  assert.equal(shell.userData.spaceShell,true,'the space primitive is identified');
  assert.equal(chair.userData.spaceShell,false,'furniture parented to a space remains visible');
  assert.equal(chair.userData.node,'space','room selection still resolves through the parent');
  assert.ok(model.authoredRooms.has('room'));
  assert.ok(model.authoredFloors.has('room'));
  assert.equal(window.material.transparent,true,'unstyled window glass admits light');
  assert.equal(wall.castShadow,true,'walls occlude the sun so daylight enters through openings');
  assert.equal(wall.receiveShadow,true);
  assert.equal(window.castShadow,false,'glass must not cast a solid pane shadow');
  assert.equal(shell.castShadow,false,'the invisible room volume never shadows its own room');
  assert.equal(chair.castShadow,true,'room contents still cast');
  setSpaceShellVisible(shell,true);setSpaceShellVisible(chair,true);
  assert.equal(shell.material.visible,false,'walk mode hides the room volume');
  assert.equal(chair.material.visible,true,'walk mode keeps room contents visible');
  setSpaceShellVisible(shell,false);
  assert.equal(shell.material.visible,true,'the room volume is restored for dollhouse selection');
  model.dispose();
});


test('presentation surfaces inherit source visibility without entering collision geometry',async()=>{
  const scene=new Group(),wall=new Mesh(new BoxGeometry(.2,3,5),new MeshStandardMaterial());
  wall.name='wall';wall.position.set(0,1.5,0);
  const finish=new Mesh(new BoxGeometry(3,3,3),new MeshStandardMaterial());
  finish.name='arosa-finish-facade-0';finish.position.x=4;wall.add(finish);scene.add(wall);
  const roof=new Mesh(new BoxGeometry(5,.2,5),new MeshStandardMaterial());roof.name='roof';roof.position.y=3;
  const roofFinish=new Mesh(new BoxGeometry(5,.01,5),new MeshStandardMaterial());roofFinish.name='arosa-finish-roof-1';roofFinish.position.y=.11;roof.add(roofFinish);scene.add(roof);
  const index=selectionIndex({objects:[{glbNodeName:'wall',kind:'wall',levelId:'ground'},{glbNodeName:'roof',kind:'slab',levelId:'ground'}],collision:{walls:[{glbNodeName:'wall'}],floors:[{glbNodeName:'roof'}]}});
  const model=await loadArchitectureModel('https://example.test/model.glb',index,[{id:'ground',elevation:0}],{fetcher:async()=>new Response(new Uint8Array([1])),loader:{parseAsync:async()=>({scene})}});
  assert.equal(finish.userData.presentationOnly,true);
  assert.equal(finish.userData.node,'wall');
  assert.equal(finish.userData.levelId,'ground');
  assert.equal(wall.userData.presentationOnly,false);
  assert.equal(dollhouseMeshVisible(roofFinish,index,new Map([['ground',0]]),0),false);
  assert.equal(dollhouseMeshVisible(finish,index,new Map([['ground',0]]),0),true);
  const world=model.worlds.get('ground');
  assert.ok(world.segments.length>0);
  assert.ok(world.segments.every(([x1,,x2])=>Math.abs(x1)<.11&&Math.abs(x2)<.11),'only the original wall enters movement collision');
  assert.equal(world.floors.length,roof.geometry.index.count*3,'the decorative roof is excluded from floor triangles');
  model.dispose();
});


test('rays over adjacent wall finishes retain separate source selection and highlight scope',async()=>{
  const scene=new Group(),objects=[];
  for(const [name,x] of [['wall-a',1],['wall-b',3]]){
    const owner=new Group();owner.name=name;owner.position.set(x,1.5,0);
    const wall=new Mesh(new BoxGeometry(2,3,.2),new MeshStandardMaterial());
    const finish=new Mesh(new PlaneGeometry(2,3),new MeshStandardMaterial());
    finish.name=`arosa-finish-facade-${name}`;finish.position.z=.103;
    owner.add(wall,finish);scene.add(owner);objects.push({glbNodeName:name,kind:'wall',levelId:'ground'});
  }
  const index=selectionIndex({objects,collision:{walls:objects.map(row=>({glbNodeName:row.glbNodeName})),floors:[]}});
  const model=await loadArchitectureModel('https://example.test/adjacent.glb',index,[{id:'ground',elevation:0}],{fetcher:async()=>new Response(new Uint8Array([1])),loader:{parseAsync:async()=>({scene})}});
  for(const [owner,x] of [['wall-a',1],['wall-b',3]]){
    const hit=new Raycaster(new Vector3(x,1.5,2),new Vector3(0,0,-1)).intersectObjects(model.meshes,false)[0];
    assert.equal(hit.object.userData.presentationOnly,true,'the visible decorative surface receives the ray');
    assert.equal(hit.object.userData.node,owner,'the ray selects the source wall beneath it');
    const highlightedFinishes=model.meshes.filter(mesh=>mesh.userData.presentationOnly&&mesh.userData.node===hit.object.userData.node);
    assert.deepEqual(highlightedFinishes.map(mesh=>mesh.name),[`arosa-finish-facade-${owner}`],'selection does not highlight the adjacent wall');
  }
  model.dispose();
});
