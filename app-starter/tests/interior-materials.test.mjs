import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BoxGeometry} from 'three';
import {addWallUV} from '../frontend/wall-uv.mjs';

test('untextured wall geometry receives UV coordinates without altering its shape',()=>{
  const source=new BoxGeometry(2,3,.2);source.deleteAttribute('uv');
  const original=Array.from(source.attributes.position.array),copy=addWallUV(source.clone());
  assert.equal(copy.attributes.uv.count,copy.attributes.position.count);
  assert.deepEqual(Array.from(copy.attributes.position.array),original);
  assert.ok(Array.from(copy.attributes.uv.array).every(Number.isFinite));
  assert.equal(source.attributes.uv,undefined);
  source.dispose();copy.dispose();
});

test('the walkthrough ships self-contained furniture and texture assets',async()=>{
  const dir=new URL('../public/architecture-assets/',import.meta.url);
  for(const file of ['bed.glb','sofa.glb','sink.glb','toilet.glb','vanity.glb','nightstand.glb']){
    const bytes=await readFile(new URL(file,dir));
    assert.ok(bytes.length<=2*1024*1024,`${file} must remain suitable for interactive loading`);
    assert.equal(bytes.toString('ascii',0,4),'glTF');
    assert.equal(bytes.readUInt32LE(8),bytes.length);
    const json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
    assert.ok(json.meshes.length>0);
    assert.ok((json.buffers||[]).every(buffer=>!buffer.uri),'model data must be embedded');
    assert.ok((json.images||[]).every(image=>!image.uri),'textures must be embedded');
  }
  for(const file of ['wood-color.jpg','wood-normal.jpg','wood-roughness.jpg','tile-color.jpg','tile-normal.jpg','tile-roughness.jpg','plaster-normal.jpg','plaster-roughness.jpg','door-color.jpg','door-normal.jpg','door-roughness.jpg']){
    const bytes=await readFile(new URL(file,dir));
    assert.ok(bytes.length<=2*1024*1024,`${file} must fit the repository security scan limit`);
    assert.equal(bytes.readUInt16BE(0),0xffd8,`${file} must be a JPEG`);
  }
});
