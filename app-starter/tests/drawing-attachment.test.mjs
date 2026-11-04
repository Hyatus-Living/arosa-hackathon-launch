import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as intake from '../public/plan-intake.js';
import {mountEditor,multiLevelPlan} from './fixtures/plan-editor.mjs';
import {drawingFile} from './fixtures/plan-calibration.mjs';

const require=createRequire(new URL('../package.json',import.meta.url));
const {act}=require('react');
const scale=distance=>({pointA:[0,0],pointB:[100,0],distanceMetres:distance});

test('a delayed attachment links calibrated current and history plans before saving or reopening',async()=>{
  for(const name of ['Survey.SVG','Cost$&.SVG']) {
    let current=multiLevelPlan();current.sources=[{kind:'layout',ref:'Initial layout'}];
    const original=structuredClone(current),upload=Promise.withResolvers();
    const drawing={id:'uploaded-survey',name:name.slice(0,-4)+'.svg',kind:'svg',contentType:'image/svg+xml',by:'user'};
    const c=await mountEditor(current,{transport:async(url,options={})=>{
      if(url.endsWith('/drawings')&&options.method==='POST')return upload.promise;
      if(url.endsWith('/drawings'))return new Response(JSON.stringify({drawings:[]}));
      if(options.method==='PUT'){
        const input=JSON.parse(options.body);assert.equal(input.parentRevision,current.revision);
        current={...input.plan,revision:current.revision+1};
        return new Response(JSON.stringify({plan:current,revision:current.revision,parentRevision:input.parentRevision,planId:current.id}));
      }
      return new Response(JSON.stringify({current:{plan:current,revision:current.revision}}));
    }});
    const parser=globalThis.DOMParser;globalThis.DOMParser=c.window.DOMParser;
    try{
      await c.action(c.root.querySelector('[data-testid="drawing-input"]'),'onChange',{target:{files:[drawingFile(name)],value:name}});
      await c.pointer(0,0);await c.pointer(100,0);
      await c.action(c.root.querySelector('.plan-form input'),'onChange',{target:{value:'8'}});
      await c.action(c.root.querySelector('.plan-form'),'onSubmit');
      await c.action(c.button('Save'));
      assert.equal(current.sources.at(-1).ref,name,c.root.textContent.slice(0,450));
      await c.action(c.button('Recalibrate'));await c.pointer(0,0);await c.pointer(8,0);
      await c.action(c.root.querySelector('.plan-form input'),'onChange',{target:{value:'16'}});
      await c.action(c.root.querySelector('.plan-form'),'onSubmit');await c.action(c.button('Undo'));
      await act(async()=>{upload.resolve(new Response(JSON.stringify(drawing)));await upload.promise;});
      assert.equal(c.root.querySelector('.plan-drawing-name').textContent,drawing.name);
      assert.equal(c.button('Redo').disabled,false,'attachment metadata must not add an Undo step or clear Redo');
      assert.equal(c.button('Save').disabled,false,'the updated source still needs to be saved');
      await c.action(c.button('Save'));
      assert.equal(current.sources.at(-1).drawingId,drawing.id);
      assert.equal(current.sources.at(-1).ref,drawing.name);
      assert.equal(current.sources.at(-1).calibration.distanceMetres,8);
      await c.action(c.button('Redo'));assert.match(c.root.textContent,/1 px = 0\.1600 m/);
      await c.action(c.button('Save'));assert.equal(current.sources.at(-1).calibration.distanceMetres,16);
      assert.equal(current.sources.at(-1).drawingId,drawing.id);
      await c.action(c.button('Undo'));assert.match(c.root.textContent,/1 px = 0\.08000 m/);
      await c.action(c.button('Save'));
      assert.deepEqual(current.sources[0],original.sources[0]);assert.deepEqual(current.walls[0].end,original.walls[0].end);
      const reopened=intake.drawingSource(current,{kind:drawing.kind,ref:drawing.name,drawingId:drawing.id});
      assert.equal(reopened.calibration.distanceMetres,8);
    }finally{await c.close();if(parser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=parser;}
  }
});

test('linking an attachment retains PDF page scales and does not rewrite other identities or no-op plans',()=>{
  const plan=multiLevelPlan(),name='Survey$&.PDF';
  plan.sources=[{kind:'pdf',ref:name+'#page=1',calibration:scale(8)},{kind:'pdf',ref:name+'#page=2',calibration:scale(16)},
    {ref:name+'#page=3',calibration:scale(24)},{kind:'pdf',ref:name+'#page=1',drawingId:'another-upload',calibration:scale(32)},
    {kind:'svg',ref:name,calibration:scale(40)},{kind:'pdf',ref:'other.pdf',calibration:scale(48)}];
  const original=structuredClone(plan),drawing={kind:'pdf',id:'uploaded-pdf',name:'Survey$&.pdf'};
  const linked=intake.linkDrawingSources(plan,name,drawing);
  assert.deepEqual(plan,original);
  for(let i=0;i<3;i++){
    assert.equal(linked.sources[i].ref,drawing.name+`#page=${i+1}`);assert.equal(linked.sources[i].drawingId,drawing.id);
    assert.deepEqual(linked.sources[i].calibration,plan.sources[i].calibration);
  }
  assert.deepEqual(linked.sources.slice(3),plan.sources.slice(3));
  for(const key of ['walls','rooms','openings','objects','levels'])assert.equal(linked[key],plan[key]);
  assert.equal(intake.linkDrawingSources(linked,name,drawing),linked);
  assert.equal(intake.linkDrawingSources(plan,'missing.pdf',drawing),plan);
  assert.equal(intake.linkDrawingSources(null,name,drawing),null);
});
