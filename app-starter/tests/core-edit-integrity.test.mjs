import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCorePage} from '../public/core.js';

const flush=()=>new Promise(setImmediate);
const state=(version,instructions={},assumptions={})=>({id:'A',title:'Site A',version,fields:{instructions:{value:instructions,provenance:{tool:'user'}},assumptions:{value:assumptions,provenance:{tool:'user'}}}});
async function setup(t,initial){
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  globalThis.document=document;globalThis.window=window;globalThis.CustomEvent=window.CustomEvent;
  globalThis.localStorage={getItem:()=>null,setItem(){}};
  Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){
    if(this.tagName!=='FORM')return undefined;
    const elements=[...this.querySelectorAll('input,select,textarea,button')];
    for(const element of elements)if(element.name)elements[element.name]=element;
    return elements;
  }});
  globalThis.EventSource=class{addEventListener(){}close(){}};
  const requests=[];
  const response=(body,status=200)=>({ok:status<400,status,headers:{get:()=>null},json:async()=>body});
  globalThis.fetch=(url,options={})=>{
    if(url==='/api/market-store/status')return Promise.resolve(response({error:'Fixture disabled'},404));
    return new Promise(resolve=>requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,answer:(body,status)=>resolve(response(body,status))}));
  };
  const root=document.querySelector('main');
  const page=createCorePage({root,navigate(){},underwrite(){},pendingBox:()=>document.createElement('div'),conversationId:()=>null,canSend:()=>true,architectureEnabled:()=>false});
  t.after(()=>page.leave());
  page.showParcel('A');requests[0].answer(initial);await flush();
  const find=method=>requests.filter(r=>r.method===method);
  const box=id=>root.querySelector(`textarea[data-instructions="${id}"]`);
  const change=id=>box(id).dispatchEvent(new window.Event('change',{bubbles:true}));
  return {root,page,requests,find,box,change,window};
}

test('a live refresh updates untouched instructions while retaining the local unsaved section',async(t)=>{
  const {page,find,box}=await setup(t,state(1,{envelope:'Original',revenue:'Rental'}));
  box('envelope').value='Local draft';
  page.refresh();find('GET')[1].answer(state(2,{envelope:'Original',revenue:'Condo'}));await flush();
  assert.equal(box('envelope').value,'Local draft');
  assert.equal(box('revenue').value,'Condo');
  assert.equal(box('revenue').dataset.initial,'Condo');
});

test('assumption edits made while a save is pending survive its response and later refreshes',async(t)=>{
  const {root,page,find,window}=await setup(t,state(1,{}, {landPrice:1000000}));
  const form=root.querySelector('form');form.elements.landPrice.value='1100000';
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  form.elements.landPrice.value='1300000';
  find('PATCH')[0].answer(state(2,{}, {landPrice:1100000}));await flush();
  assert.equal(root.querySelector('form').elements.landPrice.value,'1300000');
  assert.equal(root.querySelector('form').elements.landPrice.dataset.initial,'1100000');
  assert.match(root.querySelector('.core-form-status').textContent,/unsaved edits/);
  page.refresh();find('GET')[1].answer(state(2,{}, {landPrice:1100000}));await flush();
  assert.equal(root.querySelector('form').elements.landPrice.value,'1300000');
});

test('an instruction save applies merged remote sections and preserves text typed after submission',async(t)=>{
  const {find,box,change}=await setup(t,state(1,{envelope:'Original',revenue:'Rental'}));
  box('envelope').value='Submitted';change('envelope');await flush();
  box('envelope').value='Later draft';
  find('PATCH')[0].answer(state(2,{envelope:'Submitted',revenue:'Condo'}));await flush();
  assert.equal(box('envelope').value,'Later draft');
  assert.equal(box('envelope').dataset.initial,'Submitted');
  assert.equal(box('revenue').value,'Condo');
  change('envelope');await flush();
  assert.equal(find('PATCH')[1].body.fields.instructions.revenue,'Condo');
  assert.equal(find('PATCH')[1].body.version,2);
  find('PATCH')[1].answer(state(3,{envelope:'Later draft',revenue:'Condo'}));await flush();
});

test('an overlapping instruction conflict keeps the draft, refreshes untouched sections and waits for an explicit save',async(t)=>{
  const {root,find,box,change}=await setup(t,state(1,{envelope:'Original',revenue:'Rental'}));
  box('envelope').value='My draft';change('envelope');await flush();
  find('PATCH')[0].answer({error:'Version changed'},409);await flush();
  find('GET')[1].answer(state(2,{envelope:'Other draft',revenue:'Condo'}));await flush();
  assert.equal(find('PATCH').length,1,'conflicting input is not silently resubmitted');
  assert.equal(box('envelope').value,'My draft');
  assert.equal(box('envelope').dataset.initial,'Other draft');
  assert.equal(box('revenue').value,'Condo');
  assert.match(root.querySelector('.core-instructions-status').textContent,/changed while you were saving/);
  change('envelope');await flush();
  assert.equal(find('PATCH')[1].body.fields.instructions.revenue,'Condo');
  assert.equal(find('PATCH')[1].body.version,2);
  find('PATCH')[1].answer(state(3,{envelope:'My draft',revenue:'Condo'}));await flush();
});

test('a refresh started before a save cannot roll back the saved assumptions afterward',async(t)=>{
  const {root,page,find,window}=await setup(t,state(1,{}, {landPrice:1000000}));
  page.refresh();
  const form=root.querySelector('form');form.elements.landPrice.value='1100000';
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  find('PATCH')[0].answer(state(2,{}, {landPrice:1100000}));await flush();
  find('GET')[1].answer(state(1,{}, {landPrice:1000000}));await flush();
  assert.equal(root.querySelector('form').elements.landPrice.value,'1100000');
  assert.equal(root.querySelector('form').elements.landPrice.dataset.initial,'1100000');
});

test('a late save response cannot replace a newer live project snapshot or its next write version',async(t)=>{
  const {root,page,find,box,window}=await setup(t,state(1,{revenue:'Rental'}, {landPrice:1000000}));
  const form=root.querySelector('form');form.elements.landPrice.value='1100000';
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  page.refresh();find('GET')[1].answer(state(3,{revenue:'Condo'}, {landPrice:1100000,capRate:.06}));await flush();
  find('PATCH')[0].answer(state(2,{revenue:'Rental'}, {landPrice:1100000}));await flush();
  assert.equal(box('revenue').value,'Condo');
  assert.equal(root.querySelector('form').elements.capRate.value,'6');
  const next=root.querySelector('form');next.elements.landPrice.value='1200000';
  next.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(find('PATCH')[1].body.version,3);
  find('PATCH')[1].answer(state(4,{revenue:'Condo'}, {landPrice:1200000,capRate:.06}));await flush();
});
