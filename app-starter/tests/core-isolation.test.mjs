import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCorePage} from '../public/core.js';
import {architectureStates} from './fixtures/architecture-states.mjs';

const flush=()=>new Promise(setImmediate);
const site=(id,version=1)=>({id,title:`Site ${id}`,version,fields:{}});

function setup(t,{architecture=false}={}){
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  globalThis.document=document;globalThis.window=window;globalThis.CustomEvent=window.CustomEvent;
  globalThis.localStorage={getItem:()=>null,setItem(){}};
  // linkedom lacks the native form collection, including its named lookup.
  Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){
    if(this.tagName!=='FORM')return undefined;
    const elements=[...this.querySelectorAll('input,select,textarea,button,fieldset')];
    for(const element of elements)if(element.name)elements[element.name]=element;
    return elements;
  }});
  const sources=[];
  globalThis.EventSource=class{
    constructor(url){this.url=url;this.listeners={};sources.push(this);}
    addEventListener(name,fn){this.listeners[name]=fn;}
    close(){this.closed=true;}
  };
  const requests=[];
  globalThis.fetch=(url,options={})=>{
    const response=(body,status=200)=>({ok:status<400,status,headers:{get:()=>null},json:async()=>body});
    if(url==='/api/market-store/status')return Promise.resolve(response({error:'Fixture disabled'},404));
    return new Promise(resolve=>requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,answer:(body,status)=>resolve(response(body,status))}));
  };
  const root=document.querySelector('main');
  let activeId;
  const page=createCorePage({root,navigate(){},underwrite(){},pendingBox:()=>document.createElement('div'),conversationId:()=>`chat-${activeId}`,canSend:()=>true,architectureEnabled:()=>architecture});
  const show=id=>{activeId=id;page.showParcel(id);};
  const find=(id,method='GET',suffix='state')=>requests.filter(r=>r.url===`/api/projects/${id}/${suffix}`&&r.method===method);
  const load=async(id)=>{show(id);const request=find(id).at(-1);assert.ok(request,`state request started for ${id}`);request.answer(site(id));await flush();};
  const edit=value=>{const box=root.querySelector('textarea[data-instructions="envelope"]');box.value=value;box.dispatchEvent(new window.Event('change',{bubbles:true}));};
  t.after(()=>page.leave());
  return {root,page,show,find,load,edit,requests,sources,document,window};
}

test('switching sites starts the new load immediately and obsolete cleanup cannot clear it',async(t)=>{
  const {root,page,show,find,sources}=setup(t);
  show('A');show('B');
  assert.equal(find('B').length,1,'B must not wait for A');
  assert.equal(sources[0].closed,true,'the previous site event stream is closed');
  find('A')[0].answer(site('A'));await flush();
  page.refresh();
  assert.equal(find('B').length,1,'old cleanup must not clear B pending-request deduplication');
  find('B')[0].answer(site('B'));await flush();
  assert.equal(root.querySelector('h1').textContent,'Site B');
  assert.equal(find('B').length,2,'a refresh requested during B loading runs once afterward');
  find('B')[1].answer(site('B',2));await flush();
  assert.equal(root.querySelector('h1').textContent,'Site B');
});

test('revisiting the same site rejects the previous visit response and errors',async(t)=>{
  const {root,show,find}=setup(t);
  show('A');show('B');show('A');
  assert.equal(find('A').length,2,'a new visit has its own request');
  const latest={...site('A',3),title:'Current visit'};
  find('A')[1].answer(latest);await flush();
  find('A')[0].answer({...site('A'),title:'Obsolete visit'});await flush();
  find('B')[0].answer({error:'Not shared'},403);await flush();
  assert.equal(root.querySelector('h1').textContent,'Current visit');
  assert.equal(document.title,'Current visit · Arosa');
});

test('underwriting navigation never loads architecture or embeds a modeling workspace',async t=>{
  const {root,load,find}=setup(t,{architecture:true});
  await load('A');await load('B');
  assert.equal(find('A','GET','architecture').length,0);
  assert.equal(find('B','GET','architecture').length,0);
  assert.equal(root.querySelector('#core-architecture'),null);
  assert.equal(root.querySelector('h1').textContent,'Site B');
});
for(const outcome of ['success','failure'])test(`an old assumption-save ${outcome} cannot change the next site`,async(t)=>{
  const {root,load,find,window}=setup(t);
  await load('A');
  const form=root.querySelector('#core-assumptions-form');
  form.elements.landPrice.value='1200000';
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(find('A','PATCH').length,1);
  assert.equal(find('A','PATCH')[0].body.fields.assumptions.landPrice,1200000);
  await load('B');
  if(outcome==='success')find('A','PATCH')[0].answer(site('A',2));
  else find('A','PATCH')[0].answer({error:'Old save failed'},500);
  await flush();
  assert.equal(root.querySelector('h1').textContent,'Site B');
  assert.equal(root.querySelector('.core-form-status').textContent,'');
  assert.equal(root.querySelector('#core-assumptions-form').elements.landPrice.value,'');
});

test('queued instructions remain bound to their site and a new site saves without waiting for an old request',async(t)=>{
  const {root,load,edit,find}=setup(t);
  await load('A');edit('A first instruction');await flush();
  assert.equal(find('A','PATCH').length,1);
  edit('A queued instruction');
  await load('B');edit('B instruction');await flush();
  assert.equal(find('B','PATCH').length,1,'B has an independent save queue');
  assert.equal(find('B','PATCH')[0].body.fields.instructions.envelope,'B instruction');
  find('A','PATCH')[0].answer(site('A',2));await flush();
  assert.equal(root.querySelector('h1').textContent,'Site B');
  assert.equal(find('A','PATCH').length,1,'a queued write from the old visit is cancelled');
  assert.equal(find('B','PATCH').length,1,'the old queue cannot write the new site');
  find('B','PATCH')[0].answer({...site('B',2),fields:{instructions:{value:{envelope:'B instruction'},provenance:{tool:'user'}}}});await flush();
  assert.equal(root.querySelector('textarea[data-instructions="envelope"]').value,'B instruction');
});

test('an underwriting action awaiting an old site save cannot dispatch into the next conversation',async(t)=>{
  const {root,load,find,document,window}=setup(t);
  const followups=[];
  document.addEventListener('acres-follow-up',event=>followups.push(event.detail));
  await load('A');
  root.querySelector('textarea[data-instructions="envelope"]').value='Keep A low';
  root.querySelector('[data-follow-action="all"]').dispatchEvent(new window.Event('click',{bubbles:true}));
  await flush();
  assert.equal(find('A','PATCH').length,1);
  await load('B');
  find('A','PATCH')[0].answer(site('A',2));await flush();
  assert.deepEqual(followups,[]);
  assert.equal(root.querySelector('h1').textContent,'Site B');
});
