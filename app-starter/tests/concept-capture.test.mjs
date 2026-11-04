import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../frontend/concept-view.jsx',import.meta.url),'utf8');
const start=source.indexOf('function CaptureBridge()');
const end=source.indexOf('\nasync function planPng(',start);
assert.ok(start>=0&&end>start);
const clickStart=source.indexOf('          const base = slugify(concept.name);');
const clickEnd=source.indexOf('\n        }}>PNG</button>',clickStart);
assert.ok(clickStart>=0&&clickEnd>clickStart);
class CustomEvent extends Event{constructor(type,options={}){super(type);this.detail=options.detail;}}

function setup(){
  const window=new EventTarget(),downloads=[],renders=[],cleanups=[];
  const context={window,CustomEvent,downloadBlob:(blob,name)=>downloads.push({blob,name}),useEffect:fn=>cleanups.push(fn()),useThree:fn=>fn(context.current)};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const mount=id=>{
    const canvas={toBlob(fn,type){assert.equal(type,'image/png');fn(`image-${id}`);}};
    const scene={id},camera={id:`camera-${id}`};
    context.current={gl:{domElement:canvas,render:(s,c)=>renders.push({id,scene:s,camera:c})},scene,camera};
    context.CaptureBridge();return canvas;
  };
  const request=(canvas,filename='chosen.png')=>window.dispatchEvent(new CustomEvent('acres:capture-view',{detail:{canvas,filename}}));
  return {context,mount,request,downloads,renders,cleanups};
}

test('PNG capture renders and downloads only the requested mounted model',()=>{
  const {mount,request,downloads,renders}=setup();
  mount('A');const target=mount('B');request(target,'model-b.png');
  assert.deepEqual(downloads,[{blob:'image-B',name:'model-b.png'}]);
  assert.deepEqual(renders.map(r=>r.id),['B']);
  assert.equal(renders[0].scene.id,'B');
});

test('an unscoped capture event cannot download every mounted model',()=>{
  const {mount,request,downloads}=setup();mount('A');mount('B');request(undefined);
  assert.deepEqual(downloads,[]);
});

test('the production PNG button addresses its own canvas and uses its model filename',()=>{
  const {context,mount,downloads}=setup();const canvas=mount('A');mount('B');
  Object.assign(context,{rootRef:{current:{querySelector:selector=>{assert.equal(selector,'.concept-canvas canvas');return canvas;}}},concept:{name:'Chosen Model'},view:'3d',slugify:()=> 'chosen-model',planPng:()=>assert.fail('3D capture must not export a plan')});
  vm.runInContext(`function clickPng(){${source.slice(clickStart,clickEnd)}};clickPng()`,context);
  assert.deepEqual(downloads,[{blob:'image-A',name:'chosen-model-3d.png'}]);
});

test('unmount cleanup removes the old capture listener',()=>{
  const {mount,request,downloads,cleanups}=setup();const canvas=mount('A');cleanups[0]();request(canvas);
  assert.deepEqual(downloads,[]);
});
