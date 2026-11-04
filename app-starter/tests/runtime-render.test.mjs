import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {Group,Mesh,BoxGeometry,MeshStandardMaterial} from 'three';
import {loadArchitectureModel} from '../frontend/architecture-loader.mjs';

test('live updates parse only changed answers and reset the cache for a new run',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const {document}=parseHTML('<main id="main"><div id="messages"></div></main>');let parses=0,lastLabel;
  const c={document,$:selector=>document.querySelector(selector),busy:true,submitPending:false,activeRun:'one',runStartedAt:1,runRecord:()=>null,liveTurn:null,liveMessages:new Map([['note',{phase:'commentary',text:'Checking'}]]),activity:[],navigator:{onLine:true},connectionInterrupted:false,Date,scrollState:{isFollowing:()=>false},runRecord:()=>null,runAuthorName:()=>null,isMultiParticipant:()=>false,createActivityView:()=>({root:document.createElement('div'),update(_events,label){lastLabel=label;}}),marked:{parse:text=>{parses++;return text;}},DOMPurify:{sanitize:text=>text},patchMarkup:(element,html)=>element.innerHTML=html,decorateAnswerHeader(){}};
  vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function renderLiveTurn()'),source.indexOf('\nfunction render()')),c);
  c.renderLiveTurn();assert.equal(parses,0);assert.equal(document.querySelectorAll('.answer').length,0);
  c.liveMessages.set('a',{text:'first'});c.renderLiveTurn();assert.equal(lastLabel,'Writing answer');
  c.liveMessages.set('b',{text:'second'});
  c.renderLiveTurn();assert.equal(parses,2);assert.equal(lastLabel,'Revising the answer');c.renderLiveTurn();assert.equal(parses,2);
  c.liveMessages.get('b').text+=' changed';c.renderLiveTurn();assert.equal(parses,3);
  assert.equal(document.querySelectorAll('.answer').length,1);
  c.liveMessages.set('c',{text:'replacement draft'});c.renderLiveTurn();assert.equal(parses,4);
  assert.equal(document.querySelectorAll('.answer').length,1);assert.equal(document.querySelector('.answer').textContent,'replacement draft');
  c.liveMessages.set('note2',{phase:'commentary',text:'Checking again'});c.renderLiveTurn();assert.equal(parses,4);
  c.activeRun='two';c.renderLiveTurn();assert.equal(parses,5);
});
const index={objects:new Map(),walls:new Set(),floors:new Set()},levels=[{id:'one',elevation:0}];
test('model download is abortable and parsed stale geometry is disposed',async()=>{
  const controller=new AbortController(),scene=new Group(),geometry=new BoxGeometry(),material=new MeshStandardMaterial();scene.add(new Mesh(geometry,material));let disposed=0;
  geometry.addEventListener('dispose',()=>disposed++);material.addEventListener('dispose',()=>disposed++);
  await assert.rejects(loadArchitectureModel('https://local/model.glb',index,levels,{signal:controller.signal,fetcher:async(_url,options)=>{assert.equal(options.signal,controller.signal);return {ok:true,arrayBuffer:async()=>new ArrayBuffer(0)};},loader:{parseAsync:async()=>{controller.abort();return {scene};}}}),{name:'AbortError'});
  assert.equal(disposed,2);
});
test('model disposal is idempotent and collision worlds are reused only on request',async()=>{
  const scene=new Group(),geometry=new BoxGeometry(),material=new MeshStandardMaterial();scene.add(new Mesh(geometry,material));let disposed=0;geometry.addEventListener('dispose',()=>disposed++);
  const model=await loadArchitectureModel('https://local/model.glb',index,levels,{fetcher:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)}),loader:{parseAsync:async()=>({scene})}});
  assert.equal(disposed,0);assert.equal(model.worlds.get('one'),model.worlds.get('one'));model.dispose();model.dispose();assert.equal(disposed,1);
});

test('opening the plan paints first; the manifest and model load in the background once idle',async()=>{
  const source=readFileSync(new URL('../frontend/architecture-view.jsx',import.meta.url),'utf8');
  const start=source.indexOf("  useEffect(() => { if (state.mode !== 'plan')");
  const end=source.indexOf('\n\n  const selection',start);let cleanup,fetches=0,models=0,idle=null;
  const c={requested3D:false,request3D:(value)=>{c.requested3D=value;},state:{mode:'plan',unavailable:null},glbUrl:'model',manifestUrl:'manifest',plan:{levels:[]},root:{dataset:{}},startedAt:0,performance,AbortController,selectionIndex:()=>({}),setManifest(){},setModel(){},dispatch(){},console,setTimeout,clearTimeout,window:{requestIdleCallback:(fn)=>{idle=fn;return 1;},cancelIdleCallback(){}},useEffect:effect=>{cleanup=effect();},fetch:async()=>{fetches++;return {ok:true,json:async()=>({})};},loadArchitectureModel:async()=>{models++;return {dispose(){}};}};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);assert.equal(fetches,0);assert.equal(models,0);
  assert.equal(typeof idle,'function','the background load waits for an idle browser');
  idle();assert.equal(c.requested3D,true);
  vm.runInContext(source.slice(start,end),c);await new Promise(resolve=>setImmediate(resolve));assert.equal(fetches,1);assert.equal(models,1);cleanup();
});
