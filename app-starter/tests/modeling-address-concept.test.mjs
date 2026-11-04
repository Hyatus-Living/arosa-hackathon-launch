import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {architectureStates} from './fixtures/architecture-states.mjs';

const {document,window}=parseHTML('<!doctype html><html><body><div id="core-page"></div></body></html>');
Object.defineProperty(window,'location',{value:new URL('http://localhost/modeling/model_1?view=massing'),writable:true});
window.history={state:null,pushState(state,_title,path){this.state=state;window.location=new URL(path,window.location);}};
window.acresPlanEditor={unmount(){}};
globalThis.window=window;
globalThis.document=document;
globalThis.CustomEvent=window.CustomEvent;
globalThis.localStorage={getItem:()=>null,setItem(){}};
const streams=[];
globalThis.EventSource=class {constructor(){this.listeners={};streams.push(this);} addEventListener(name,fn){this.listeners[name]=fn;} close(){}};

const {createCorePage}=await import('../public/core.js');
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
const root=document.querySelector('#core-page');

async function openModel({address='123 Example Street',canSend=true,access='owner'}={}) {
  let state={id:'model_1',title:'Test model',access,version:1,fields:{property:{value:address?{address}:{}},concepts:{value:null}}};
  globalThis.fetch=async url=>({ok:true,status:200,headers:{get:()=>null},json:async()=>url.endsWith('/state')?state:architectureStates.empty});
  const chat=[];
  const page=createCorePage({root,navigate(){},underwrite(){},pendingBox:()=>document.createElement('div'),conversationId:()=>null,canSend:()=>typeof canSend==='function'?canSend():canSend,mountConcept:async()=>{},mountArchitecture:async()=>{},mountPlan:async()=>{},architectureEnabled:()=>true,setChatOpen:open=>chat.push(open)});
  page.showPlan('model_1');
  await settle();
  return {page,chat,update:next=>{state=next;}};
}

test('an address offers zoning-based massing in the Modeling conversation and shows progress',async t=>{
  const {page,chat,update}=await openModel();
  t.after(()=>page.leave());
  const events=[];
  const listener=e=>events.push(e.detail);
  document.addEventListener('acres-follow-up',listener);
  t.after(()=>document.removeEventListener('acres-follow-up',listener));
  const button=root.querySelector('[data-zoning-concept]');
  assert.ok(button);
  assert.equal(button.disabled,false);
  button.click();
  assert.deepEqual(chat,[true]);
  assert.equal(events.length,1);
  assert.match(events[0].text,/123 Example Street/);
  assert.match(events[0].text,/as-of-right zoning.*preliminary 3D building shape/);
  assert.match(events[0].text,/skip financial analysis/i);
  assert.match(events[0].text,/missing instead of guessing/i);
  assert.match(root.querySelector('[role="status"]').textContent,/Researching/);
  assert.equal(root.querySelector('[data-zoning-concept]'),null);
  page.setRun({label:'Researching'});
  page.setRun(null,'Research failed');
  assert.ok(root.querySelector('[data-zoning-concept]'),'a failed run can be retried');
  root.querySelector('[data-zoning-concept]').click();
  page.setRun({label:'Researching'});
  update({id:'model_1',title:'Test model',version:2,fields:{property:{value:{address:'123 Example Street'}},concepts:{value:[{id:'concept_1',name:'Zoning envelope',version:1,levels:[]}]}}});
  streams.at(-1).listeners['state.updated']({type:'state.updated',data:JSON.stringify({projectId:'model_1',version:2,keys:['concepts']})});
  await settle();
  assert.match(root.querySelector('#core-massing').textContent,/Zoning envelope/,'the saved concept replaces the offer');
});

test('read-only access and older models without an address do not start zoning research',async t=>{
  let opened=await openModel({access:'viewer'});
  assert.equal(root.querySelector('[data-zoning-concept]').disabled,true);
  opened.page.leave();
  let allowed=true;
  opened=await openModel({canSend:()=>allowed});
  const events=[];const listener=e=>events.push(e.detail);
  document.addEventListener('acres-follow-up',listener);
  t.after(()=>document.removeEventListener('acres-follow-up',listener));
  allowed=false;
  root.querySelector('[data-zoning-concept]').click();
  assert.deepEqual(events,[],'a permission change before click cannot start a request');
  assert.equal(root.querySelector('.modeling-empty [role="status"]'),null);
  opened.page.leave();
  opened=await openModel({address:''});
  t.after(()=>opened.page.leave());
  assert.equal(root.querySelector('[data-zoning-concept]'),null);
  assert.match(root.querySelector('.modeling-empty').textContent,/Describe a building/);
});

test('housing goals and preferences reach only the Modeling request and survive a failed run',async t=>{
  const {page}=await openModel({address:'28 Example Avenue, Portland'});
  t.after(()=>page.leave());
  const events=[];const listener=e=>events.push(e.detail);
  document.addEventListener('acres-follow-up',listener);
  t.after(()=>document.removeEventListener('acres-follow-up',listener));
  const select=root.querySelector('[name="housing-goal"]');
  for(const option of select.querySelectorAll('option'))option.removeAttribute('selected');
  select.querySelector('[value="another-home"]').setAttribute('selected','');
  select.dispatchEvent(new window.Event('change'));
  const notes=root.querySelector('[name="housing-notes"]');
  notes.value='Keep the garden and make space for a parent.';
  notes.dispatchEvent(new window.Event('input'));
  const start=root.querySelector('[data-zoning-concept]');start.click();start.click();
  assert.equal(events.length,1,'a starting request cannot be duplicated by its old button');
  assert.match(events[0].text,/28 Example Avenue, Portland/);
  assert.match(events[0].text,/accessory dwelling.*keeping the existing building/);
  assert.match(events[0].text,/do not assume an ADU is allowed/);
  assert.match(events[0].text,/Keep the garden and make space for a parent/);
  assert.match(events[0].text,/survey, professional review or approval/);
  assert.match(events[0].text,/Keep my existing floor plan and skip financial analysis/);
  assert.equal(root.querySelector('[name="housing-goal"]').disabled,true);
  page.setRun({label:'Researching'});page.setRun(null,'Research failed');
  assert.equal(root.querySelector('[name="housing-goal"]').value,'another-home');
  assert.equal(root.querySelector('[name="housing-notes"]').value,notes.value);
  assert.equal(root.querySelector('[name="housing-goal"]').disabled,false);
});

test('a different project starts with its own housing goal and permission state',async t=>{
  const first=await openModel();
  const notes=root.querySelector('[name="housing-notes"]');notes.value='Private first project goal';
  notes.dispatchEvent(new window.Event('input'));
  first.page.leave();
  const second=await openModel({address:'9 Example Road, Austin',access:'viewer'});
  t.after(()=>second.page.leave());
  assert.equal(root.querySelector('[name="housing-goal"]').value,'capacity');
  assert.equal(root.querySelector('[name="housing-notes"]').value,'');
  assert.equal(root.querySelector('[name="housing-goal"]').disabled,true);
  assert.equal(root.querySelector('[name="housing-notes"]').disabled,true);
});
