import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrate,exportPlan,planFromFixture} from '../public/plan-intake.js';
import {readFileSync} from 'node:fs';
import {calibrationController,drawingFile} from './fixtures/plan-calibration.mjs';
import {mountEditor,multiLevelPlan} from './fixtures/plan-editor.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/sample-floorplan.json',import.meta.url),'utf8'));
const plain=value=>JSON.parse(JSON.stringify(value));
const scale=distance=>({pointA:[0,0],pointB:[100,0],distanceMetres:distance});
function plan(sources) {const p=planFromFixture(fixture,{ref:'original.json'});p.sources=sources;p.revision=1;return p;}
const open=(c,name='survey.svg',id='drawing-survey',type='image/svg+xml')=>c.onDrawing(drawingFile(name,type),{id,name});

test('reopening a saved drawing restores its source after an unrelated first source',async()=>{
  const c=calibrationController(plan([{kind:'layout',ref:'Original layout'},{kind:'svg',ref:'survey.svg',calibration:scale(8)}]));
  await open(c);
  assert.equal(c.calibration?.distanceMetres,8);
  assert.equal(c.tool,'select');
  assert.match(c.notices.at(-1).text,/Saved scale restored/);
});

test('PDF calibration stays on its recorded page when opening and switching pages',async()=>{
  const c=calibrationController(plan([{kind:'pdf',ref:'survey.pdf#page=2',calibration:scale(8)}]));
  await open(c,'survey.pdf','pdf-id','application/pdf');
  assert.equal(c.calibration,null,'page two must not calibrate page one');
  await c.onPdfPage(2);assert.equal(c.calibration?.distanceMetres,8);
  assert.equal(c.tool,'select');
  await c.onPdfPage(3);assert.equal(c.calibration,null);assert.equal(c.tool,'calibrate');
  await c.onPdfPage(2);assert.equal(c.calibration?.distanceMetres,8);
});

test('calibrating another drawing records it without moving existing geometry',async()=>{
  const original=plan([{kind:'layout',ref:'Original layout'}]),c=calibrationController(original);
  await open(c);c.apply(8);
  assert.equal(c.commits.length,1);
  const saved=exportPlan(c.plan);
  assert.deepEqual(c.plan.sources[0],original.sources[0]);
  assert.deepEqual(plain(saved.sources),[original.sources[0],{kind:'svg',ref:'survey.svg',drawingId:'drawing-survey',calibration:scale(8)}]);
  for(const key of ['walls','openings','rooms','objects','levels'])assert.deepEqual(c.plan[key],original[key]);
  const reopened=calibrationController(saved);await open(reopened);
  assert.equal(reopened.calibration?.distanceMetres,8);
});

test('recalibrating a selected source preserves other drawings and updates the saved scale',async()=>{
  const original=plan([{kind:'svg',ref:'other.svg',calibration:scale(4)},{kind:'svg',ref:'survey.svg',calibration:scale(8)}]);
  const c=calibrationController(original);await open(c);c.apply(16);
  const saved=exportPlan(c.plan);
  assert.deepEqual(saved.sources[0],original.sources[0]);
  assert.equal(saved.sources[1].calibration.distanceMetres,16);
  assert.equal(saved.sources[1].drawingId,'drawing-survey');
  assert.deepEqual(saved.walls[0].end,original.walls[0].end.map(n=>n*2));
  const reopened=calibrationController(saved);await open(reopened);
  assert.equal(reopened.calibration?.distanceMetres,16);
});

test('saved drawing identity outranks a legacy filename and rejects another same-named drawing',async()=>{
  const c=calibrationController(plan([{kind:'svg',ref:'survey.svg',calibration:scale(4)},{kind:'svg',ref:'survey.svg',drawingId:'right',calibration:scale(8)}]));
  await open(c,'survey.svg','right');assert.equal(c.calibration?.distanceMetres,8);
  c.plan.sources=c.plan.sources.slice(1);
  await open(c,'survey.svg','wrong');assert.equal(c.calibration,null);
  c.plan.sources=[{kind:'svg',ref:'right',calibration:scale(12)}];
  await open(c,'renamed.svg','right');assert.equal(c.calibration?.distanceMetres,12);
});

test('creating a traced plan records the saved drawing identity for later reopening',async()=>{
  const c=calibrationController(null);await open(c);c.apply(8);c.createFromDrawing(false);
  assert.equal(c.plan.sources[0].drawingId,'drawing-survey');
  assert.equal(c.plan.sources[0].calibration.distanceMetres,8);
});

test('reloading a saved plan restores only the selected drawing and PDF page',async()=>{
  const initial=plan([{kind:'layout',ref:'layout'}]),c=calibrationController(initial);
  await open(c,'survey.pdf','pdf-id','application/pdf');
  const current=plan([...initial.sources,{kind:'pdf',ref:'survey.pdf#page=2',drawingId:'pdf-id',calibration:scale(8)}]);current.revision=2;
  c.fetch=async()=>new Response(JSON.stringify({current:{plan:current,revision:current.revision}}));
  await c.onPdfPage(2);await c.reloadLatest('user');
  assert.equal(c.calibration?.distanceMetres,8);assert.equal(c.underlay.page,2);
  current.sources[1].calibration=scale(16);current.revision=3;
  await c.reloadLatest('user');assert.equal(c.calibration?.distanceMetres,16);
  c.calibration=null;c.underlay={...c.underlay,ref:'survey.pdf#page=1',page:1};
  await c.reloadLatest('user');assert.equal(c.underlay,null);
});

test('toolbar and keyboard history keep the drawing scale aligned with the plan and saved revision',async()=>{
  let current=multiLevelPlan();current.sources=[{kind:'layout',ref:'Original layout'},{kind:'svg',ref:'survey.svg',drawingId:'survey',calibration:scale(8)}];
  const drawing={id:'survey',name:'survey.svg',kind:'svg',contentType:'image/svg+xml',by:'user'};
  const c=await mountEditor(current,{transport:async(url,options={})=>{
    if(url.endsWith('/drawings'))return new Response(JSON.stringify({drawings:[drawing]}));
    if(url.endsWith('/drawings/survey'))return new Response(await drawingFile('survey.svg').text());
    if(options.method==='PUT'){current={...JSON.parse(options.body).plan,revision:current.revision+1};return new Response(JSON.stringify({plan:current,revision:current.revision,planId:current.id}));}
    return new Response(JSON.stringify({current:{plan:current,revision:current.revision}}));
  }});
  const parser=globalThis.DOMParser;globalThis.DOMParser=c.window.DOMParser;
  try{
    await c.action(c.root.querySelector('.plan-drawings button'));
    assert.match(c.root.textContent,/1 px = 0\.08000 m/);
    await c.action(c.button('Recalibrate'));await c.pointer(0,0);await c.pointer(8,0);
    await c.action(c.root.querySelector('.plan-form input'),'onChange',{target:{value:'16'}});
    await c.action(c.root.querySelector('.plan-form'),'onSubmit');
    assert.match(c.root.textContent,/1 px = 0\.1600 m/);
    await c.action(c.button('Undo'));assert.match(c.root.textContent,/1 px = 0\.08000 m/);
    await c.action(c.button('Redo'));assert.match(c.root.textContent,/1 px = 0\.1600 m/);
    await c.key('z',{metaKey:true});assert.match(c.root.textContent,/1 px = 0\.08000 m/);
    await c.key('z',{ctrlKey:true,shiftKey:true});assert.match(c.root.textContent,/1 px = 0\.1600 m/);
    await c.action(c.button('Save'));
    assert.equal(current.sources[1].calibration.distanceMetres,16);
    assert.deepEqual(current.sources[0],{kind:'layout',ref:'Original layout'});
    assert.deepEqual(current.walls[0].end,[16,0]);
  }finally{await c.close();if(parser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=parser;}
});
