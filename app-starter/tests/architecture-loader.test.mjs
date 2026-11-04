import test from 'node:test';
import assert from 'node:assert/strict';
import {BoxGeometry, Group, Mesh, MeshStandardMaterial} from 'three';
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
