import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DOMParser} from 'linkedom';
import * as intake from '../public/plan-intake.js';

const source=readFileSync(new URL('../frontend/plan-editor.jsx',import.meta.url),'utf8');
const start=source.indexOf('  // A drawing from disk is also stored');
const end=source.indexOf('\n  // ---- Calibration ----',start);
assert.ok(start>=0&&end>start);
const svg=readFileSync(new URL('./fixtures/sample-floorplan.svg',import.meta.url),'utf8');
const fixture=readFileSync(new URL('./fixtures/sample-floorplan.json',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(setImmediate);
const drawing=id=>({id,name:`${id}.svg`});
const file=(name='drawing.svg',type='image/svg+xml')=>new File([type==='image/svg+xml'?svg:'fixture bytes'],name,{type});

function setup(){
  let nextUrl=0;
  const context={...intake,DOMParser,Blob,
    projectId:'project-A',plan:null,saved:{revision:0},underlay:null,drawings:[],notices:[],uploads:[],pages:[],images:[],commits:[],actions:[],revoked:[],drawingGeneration:{current:0},pdfPageGeneration:{current:0},
    baseRef:ref=>ref.split('#')[0],fetch:()=>assert.fail('no real network in intake fixture'),
    URL:{createObjectURL:()=>`blob:test-${++nextUrl}`,revokeObjectURL:url=>context.revoked.push(url)},
    setUnderlay:value=>{context.underlay=typeof value==='function'?value(context.underlay):value;},
    setDrawings:value=>{context.drawings=typeof value==='function'?value(context.drawings):value;},
    setScene:value=>{context.scene=typeof value==='function'?value(context.scene):value;},
    setCalibration:value=>{context.calibration=value;},setPicks:value=>{context.picks=value;},setLabels:value=>{context.labels=value;},setSelection(){},setTool:value=>{context.tool=value;},
    say:(tone,text)=>context.notices.push({tone,text}),onAction:value=>context.actions.push(value),
    renderPdfPage:(f,n)=>{const request=deferred();context.pages.push({...request,file:f,n});return request.promise;},
    imageSize:url=>{const request=deferred();context.images.push({...request,url});return request.promise;},
    uploadDrawing:args=>{const request=deferred();context.uploads.push({...request,...args});return request.promise;},
    listDrawings:async()=>[],fetchDrawing:()=>assert.fail('fetchDrawing must be assigned for this scenario'),
    history:{commit:doc=>{context.plan=doc;context.commits.push(doc);},linkDrawing:(name,drawing)=>{context.plan=intake.linkDrawingSources(context.plan,name,drawing);}},
  };
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const pageStart=source.indexOf('  async function onPdfPage('),pageEnd=source.indexOf('\n  async function onJson(',pageStart);
  assert.ok(pageStart>=0&&pageEnd>pageStart);
  // Each React render closes over that render's underlay; refs and state setters remain shared.
  context.onPdfPage=n=>{
    context.pageUnderlay=context.underlay;
    const handler=vm.runInContext(`(function(underlay){${source.slice(pageStart,pageEnd)};return onPdfPage;})(pageUnderlay)`,context);
    return handler(n);
  };
  return context;
}

test('a slower SVG selection cannot replace the latest drawing or its status',async()=>{
  const c=setup(),read=deferred(),old=file('old.svg');old.text=()=>read.promise;
  const pending=c.onDrawing(old,drawing('old'));
  await c.onDrawing(file('new.svg'),drawing('new'));
  const notice=c.notices.at(-1);read.resolve(svg);await pending;
  assert.equal(c.underlay.ref,'new.svg');assert.equal(c.underlay.drawingId,'new');
  assert.equal(c.notices.at(-1),notice);
});

test('an obsolete file-read error cannot replace the current drawing notice',async()=>{
  const c=setup(),read=deferred(),old=file('old.svg');old.text=()=>read.promise;
  const pending=c.onDrawing(old,drawing('old'));
  await c.onDrawing(file('new.svg'),drawing('new'));
  const notice=c.notices.at(-1);read.reject(new Error('Obsolete read failed'));await pending;
  assert.equal(c.notices.at(-1),notice);assert.equal(c.underlay.ref,'new.svg');
});

test('a replaced PDF render is discarded and its unused image URL released',async()=>{
  const c=setup(),pending=c.onDrawing(file('old.pdf','application/pdf'),drawing('old'));
  await c.onDrawing(file('new.svg'),drawing('new'));
  c.pages[0].resolve({url:'blob:obsolete-pdf',width:100,height:200,pages:4});await pending;
  assert.equal(c.underlay.ref,'new.svg');assert.ok(c.revoked.includes('blob:obsolete-pdf'));
});

test('PDF page responses retain the newest page and release an obsolete rendered page',async()=>{
  const c=setup();c.underlay={file:file('survey.pdf','application/pdf'),kind:'pdf',ref:'survey.pdf#page=1',page:1,url:'blob:page-1'};
  const p2=c.onPdfPage(2),p3=c.onPdfPage(3);
  c.pages[1].resolve({url:'blob:page-3',width:120,height:200,pages:4});await p3;
  c.pages[0].resolve({url:'blob:page-2',width:100,height:200,pages:4});await p2;
  assert.equal(c.underlay.page,3);assert.equal(c.underlay.ref,'survey.pdf#page=3');
  assert.ok(c.revoked.includes('blob:page-2'));
});

test('a PDF page failure from a replaced drawing cannot alter the latest selection',async()=>{
  const c=setup();c.underlay={file:file('survey.pdf','application/pdf'),ref:'survey.pdf#page=1',page:1};
  const pending=c.onPdfPage(2);
  await c.onDrawing(file('new.svg'),drawing('new'));const notice=c.notices.at(-1);
  c.pages[0].reject(new Error('Old PDF page failed'));await pending;
  assert.equal(c.underlay.ref,'new.svg');assert.equal(c.notices.at(-1),notice);
});

test('upload completion for a replaced same-named file cannot attach its ID to the new underlay',async()=>{
  const c=setup();await c.onDrawing(file('same.svg'));await c.onDrawing(file('same.svg'));
  assert.equal(c.uploads.length,2);
  c.uploads[0].resolve({id:'old-upload',name:'same.svg'});await flush();
  assert.notEqual(c.underlay.drawingId,'old-upload');assert.equal(c.actions.length,0);
  c.uploads[1].resolve({id:'new-upload',name:'same.svg'});await flush();
  assert.equal(c.underlay.drawingId,'new-upload');assert.equal(c.actions.length,1);
});

test('a pending JSON import cannot clear a more recently selected drawing',async()=>{
  const c=setup(),read=deferred(),old=file('old.json','application/json');old.text=()=>read.promise;
  const pending=c.onJson(old);await c.onDrawing(file('new.svg'),drawing('new'));
  read.resolve(fixture);await pending;
  assert.equal(c.underlay.ref,'new.svg');assert.equal(c.commits.length,0);
});

test('a current PDF page failure is reported while preserving the last successful page',async()=>{
  const c=setup();c.underlay={file:file('survey.pdf','application/pdf'),ref:'survey.pdf#page=1',page:1};
  const pending=c.onPdfPage(2);c.pages[0].reject(new Error('Could not render this page'));await pending;
  assert.equal(c.underlay.page,1);assert.equal(c.notices.at(-1).tone,'danger');
  assert.match(c.notices.at(-1).text,/Could not render this page/);
});

test('a slow saved-drawing fetch cannot become the selection after a later local file',async()=>{
  const c=setup(),read=deferred();c.fetchDrawing=()=>read.promise;
  const pending=c.openDrawing(drawing('old'));await c.onDrawing(file('new.svg'),drawing('new'));
  read.resolve(file('old.svg'));await pending;
  assert.equal(c.underlay.ref,'new.svg');assert.equal(c.underlay.drawingId,'new');
});

test('a raster replaced during image decoding releases its URL without changing the new drawing',async()=>{
  const c=setup(),pending=c.onDrawing(file('old.png','image/png'),drawing('old'));
  const url=c.images[0].url;await c.onDrawing(file('new.svg'),drawing('new'));
  c.images[0].resolve([800,600]);await pending;
  assert.equal(c.underlay.ref,'new.svg');assert.ok(c.revoked.includes(url));
});

test('a current raster decode failure releases its URL and keeps the prior underlay',async()=>{
  const c=setup();c.underlay={ref:'prior.svg',url:'blob:prior'};
  const priorScale={pointA:[0,0],pointB:[100,0],distanceMetres:10};
  c.calibration=priorScale;c.picks=[[10,10]];c.labels=[{text:'Prior room'}];
  const pending=c.onDrawing(file('bad.png','image/png'),drawing('bad')),url=c.images[0].url;
  assert.equal(c.calibration,priorScale,'the active drawing keeps its scale while the next file is loading');
  c.images[0].reject(new Error('Image decoding failed'));await pending;
  assert.equal(c.underlay.ref,'prior.svg');assert.ok(c.revoked.includes(url));
  assert.equal(c.calibration,priorScale);assert.equal(c.picks.length,1);assert.equal(c.labels[0].text,'Prior room');
  assert.match(c.notices.at(-1).text,/Image decoding failed/);
});

test('activating a fetched drawing cancels page work started on the previous visible PDF while fetching',async()=>{
  const c=setup(),read=deferred();c.fetchDrawing=()=>read.promise;
  c.underlay={file:file('old.pdf','application/pdf'),ref:'old.pdf#page=1',page:1};
  const opening=c.openDrawing(drawing('new')),page=c.onPdfPage(2);
  read.resolve(file('new.svg'));await opening;
  c.pages[0].resolve({url:'blob:old-page',width:100,height:200,pages:4});await page;
  assert.equal(c.underlay.ref,'new.svg');assert.ok(c.revoked.includes('blob:old-page'));
});

test('a JSON import cancels page work started on the previous visible PDF during its read',async()=>{
  const c=setup(),read=deferred(),json=file('plan.json','application/json');json.text=()=>read.promise;
  c.underlay={file:file('old.pdf','application/pdf'),ref:'old.pdf#page=1',page:1};
  const importing=c.onJson(json),page=c.onPdfPage(2);
  read.resolve(fixture);await importing;
  c.pages[0].resolve({url:'blob:old-page',width:100,height:200,pages:4});await page;
  assert.equal(c.underlay,null);assert.equal(c.commits.length,1);assert.ok(c.revoked.includes('blob:old-page'));
});

test('page rendering preserves upload metadata received since that React render began',async()=>{
  const c=setup(),pdf=file('SURVEY.PDF','application/pdf');
  c.underlay={file:pdf,ref:'SURVEY.PDF#page=1',page:1,drawingId:null};
  const pending=c.onPdfPage(2);
  c.setUnderlay(u=>({...u,ref:'survey.pdf#page=1',drawingId:'saved-drawing'}));
  c.pages[0].resolve({url:'blob:page-2',width:100,height:200,pages:4});await pending;
  assert.equal(c.underlay.drawingId,'saved-drawing');assert.equal(c.underlay.ref,'survey.pdf#page=2');
});

test('a matching saved drawing restores its scale and reports that restoration accurately',async()=>{
  const c=setup(),stored={pointA:[0,0],pointB:[100,0],distanceMetres:10};
  c.plan={sources:[{ref:'saved.svg',calibration:stored}]};
  await c.onDrawing(file('saved.svg'),drawing('saved'));
  assert.equal(c.calibration.metresPerPixel,.1);
  assert.match(c.notices.at(-1).text,/saved scale restored/i);
  assert.doesNotMatch(c.notices.at(-1).text,/calibrate next/i);
});
