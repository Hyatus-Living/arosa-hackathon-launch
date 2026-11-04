import test from 'node:test';
import assert from 'node:assert/strict';
import {BoxGeometry,Group,Mesh,MeshBasicMaterial,MeshStandardMaterial,PointLight,Scene,ShaderMaterial} from 'three';
import {lightState,makeTraceScene,syncTraceLights} from '../frontend/photo-scene.mjs';
import {daylightEnvironment} from '../frontend/daylight-environment.mjs';

test('the lighting scene excludes hidden room volumes without dropping authored furniture',()=>{
  const scene=new Scene(),geometry=new BoxGeometry(),shell=new Mesh(geometry,new MeshStandardMaterial()),chair=new Mesh(geometry,new MeshStandardMaterial());
  shell.name='room';shell.userData.spaceShell=true;shell.material.visible=false;chair.name='authored chair';shell.add(chair);scene.add(shell);
  const light=new PointLight();scene.add(light);
  const environment=daylightEnvironment(8,4);scene.environment=environment;
  const sky=new Mesh(geometry,new ShaderMaterial());sky.name='sky';sky.userData.photoBackground=true;scene.add(sky);
  const trace=makeTraceScene(scene),room=trace.copy.getObjectByName('room'),copiedChair=trace.copy.getObjectByName('authored chair');
  assert.ok(room.isGroup);assert.ok(copiedChair.isMesh);assert.equal(copiedChair.parent,room);
  assert.equal(shell.visible,true);assert.equal(chair.parent,shell);assert.equal(shell.material.visible,false);
  assert.equal(trace.pairs[0][0],light);assert.notEqual(trace.pairs[0][1],light);
  light.position.set(2,3,4);light.intensity=9;syncTraceLights(trace);
  assert.deepEqual(trace.pairs[0][1].position.toArray(),[2,3,4]);assert.equal(trace.pairs[0][1].intensity,9);
  assert.deepEqual(trace.pairs[0][1].matrixWorld.elements.slice(12,15),[2,3,4]);
  assert.equal(trace.copy.environment,environment);
  assert.equal(trace.copy.background,environment);
  assert.ok(lightState(scene).ids.includes(light.uuid));
  assert.ok(!trace.copy.getObjectByName('sky').isMesh);assert.equal(sky.visible,true);
  geometry.dispose();shell.material.dispose();chair.material.dispose();sky.material.dispose();environment.dispose();
});

test('unsupported authored materials trigger a fallback rather than removing real geometry',()=>{
  const scene=new Scene(),mesh=new Mesh(new BoxGeometry(),new MeshBasicMaterial());scene.add(mesh);
  assert.throws(()=>makeTraceScene(scene),/materials not supported/);
  assert.equal(mesh.visible,true);assert.equal(mesh.parent,scene);
  mesh.geometry.dispose();mesh.material.dispose();
});

test('the daylight environment puts a bright sun at the Sky sun position and keeps the ground dim',()=>{
  const width=512,height=256,texture=daylightEnvironment(width,height),data=texture.image.data;
  // Invert three.js equirectUv for the walkthrough Sky sunPosition [100,35,100].
  const sun=[100,35,100],length=Math.hypot(...sun),dir=sun.map(v=>v/length);
  const u=Math.atan2(dir[2],dir[0])/(2*Math.PI)+.5,v=Math.asin(dir[1])/Math.PI+.5;
  const texel=(uu,vv)=>data[(Math.floor(vv*height)*width+Math.floor(uu*width))*4];
  assert.ok(texel(u,v)>2,`sun texel should be HDR-bright, got ${texel(u,v)}`);
  assert.ok(texel(u-.5,v)<1.2,'the opposite azimuth stays ordinary sky');
  assert.ok(texel(.25,.02)<texel(.25,.98),'the ground half is dimmer than the zenith');
  texture.dispose();
});
