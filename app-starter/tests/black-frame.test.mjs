import test from 'node:test';
import assert from 'node:assert/strict';
import {isBlackDetail} from '../frontend/black-frame.mjs';

test('rejects a mostly black detailed frame when the same scene is visibly lit',()=>{
  const raster=new Uint8Array(16*16*4).fill(180),detail=new Uint8Array(16*16*4);
  assert.equal(isBlackDetail(detail,raster),true);
  detail.fill(7);assert.equal(isBlackDetail(detail,raster),true);
  detail.fill(90);assert.equal(isBlackDetail(detail,raster),false);
  raster.fill(0);detail.fill(0);assert.equal(isBlackDetail(detail,raster),false);
  // A dim raster view must still expose a near-black detailed frame: at 70 vs 7 the
  // total-light ratio is .1, above the .08 branch, so only the near-black count catches it.
  raster.fill(70);detail.fill(7);assert.equal(isBlackDetail(detail,raster),true);
  raster.fill(70);detail.fill(40);assert.equal(isBlackDetail(detail,raster),false);
  assert.equal(isBlackDetail(new Uint8Array(0),new Uint8Array(0)),false,'an empty probe proves nothing');
});
