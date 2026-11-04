import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCorePage} from '../public/core.js';
const flush=()=>new Promise(setImmediate);
const started=[];
function setup(t){
  const {document,window}=parseHTML('<html><body><main></main></body></html>');globalThis.document=document;globalThis.window=window;globalThis.localStorage={getItem:()=> '0'};
  // Cards load their progress as they scroll into view: the test reveals them through this stub.
  const observed=[];globalThis.IntersectionObserver=class{constructor(callback){this.callback=callback;}observe(node){observed.push({node,observer:this});}unobserve(){}disconnect(){}};
  const requests=[];globalThis.fetch=url=>url==='/api/market-store/status'?Promise.resolve({ok:false,status:404,headers:{get:()=> 'application/json'},json:async()=>({error:'Disabled fixture'})}):new Promise(resolve=>requests.push({url,answer:(body,ok=true)=>resolve({ok,status:ok?200:500,headers:{get:()=>null},json:async()=>body})}));
  t.mock.timers.enable({apis:['setTimeout']});const root=document.querySelector('main');
  const page=createCorePage({root,navigate(){},underwrite(...args){started.push(args);return new Promise(()=>{});},pendingBox:()=>document.createElement('div'),conversationId:()=>null,canSend:()=>true,architectureEnabled:()=>false});page.showScreen();
  t.after(()=>{page.leave();delete globalThis.fetch;});
  const reveal=()=>{for(const {node,observer} of observed.splice(0))observer.callback([{target:node,isIntersecting:true}]);};
  return {root,page,requests,window,reveal,search(value){const input=root.querySelector('input[type=search]');input.value=value;input.dispatchEvent(new window.Event('input'));}};
}
const result=(id,title,nextCursor=null)=>({projects:id?[{id,title}]:[],nextCursor});
const more=root=>root.querySelector('[data-load-sites]');
const cursor='1000:00000000-0000-0000-0000-000000000001';

test('the saved-site list appends later pages and prevents duplicate in-flight requests',async t=>{
  const {root,requests}=setup(t);assert.equal(new URL(requests[0].url,'http://fixture').searchParams.get('sitesOnly'),'true');requests[0].answer(result('a','First site',cursor));await flush();
  const button=more(root);assert.ok(button);assert.equal(button.hidden,false);button.click();button.click();
  assert.equal(requests.length,2);assert.equal(button.disabled,true);assert.equal(new URL(requests[1].url,'http://fixture').searchParams.get('cursor'),cursor);
  requests[1].answer(result('b','Older site'));await flush();
  assert.equal(root.querySelector('.core-site-list').textContent,'First siteOlder site');assert.equal(button.hidden,true);assert.equal(root.querySelector('.core-site-list').getAttribute('aria-busy'),'false');
});
test('search immediately invalidates an old continuation and starts from the new query',async t=>{
  const {root,requests,search}=setup(t);requests[0].answer(result('a','Old site',cursor));await flush();more(root).click();
  search('Queens %_');assert.equal(more(root).hidden,true);requests[1].answer(result('old','Stale older site',cursor));await flush();
  assert.doesNotMatch(root.querySelector('.core-site-list').textContent,/Stale/);t.mock.timers.tick(250);
  assert.equal(requests[2].url,'/api/projects?sitesOnly=true&q=Queens%20%25_');requests[2].answer(result('q','Queens site',cursor));await flush();more(root).click();
  const query=new URL(requests[3].url,'http://fixture').searchParams;assert.equal(query.get('q'),'Queens %_');assert.equal(query.get('cursor'),cursor);
  requests[3].answer(result('q2','Queens older'));await flush();assert.equal(root.querySelector('.core-site-list').textContent,'Queens siteQueens older');
});
test('a failed continuation retains loaded sites and retries the same position',async t=>{
  const {root,requests}=setup(t);requests[0].answer(result('a','First site',cursor));await flush();more(root).click();requests[1].answer({error:'Temporary page error'},false);await flush();
  assert.equal(root.querySelector('.core-site-list').textContent,'First site');assert.equal(more(root).textContent,'Retry');assert.equal(more(root).disabled,false);
  more(root).click();assert.equal(requests[2].url,requests[1].url);requests[2].answer(result('b','Older site'));await flush();assert.equal(root.querySelector('.core-site-list').textContent,'First siteOlder site');
});
test('an initial list failure has a working retry without requiring a different search',async t=>{
  const {root,requests}=setup(t);requests[0].answer({error:'Initial list error'},false);await flush();assert.equal(more(root)?.textContent,'Retry');assert.equal(more(root).hidden,false);
  more(root).click();assert.equal(requests[1].url,'/api/projects?sitesOnly=true');requests[1].answer(result('a','Recovered site'));await flush();assert.equal(root.querySelector('.core-site-list').textContent,'Recovered site');
});
test('a continuation cannot repaint another screen after leaving the site list',async t=>{
  const {root,page,requests}=setup(t);requests[0].answer(result('a','First site',cursor));await flush();more(root).click();page.leave();root.textContent='Other screen';requests[1].answer(result('b','Late older site'));await flush();assert.equal(root.textContent,'Other screen');
});
test('an empty continuation after access changes preserves earlier rows and closes pagination',async t=>{
  const {root,requests}=setup(t);requests[0].answer(result('a','First site',cursor));await flush();more(root).click();requests[1].answer(result(null,null));await flush();assert.equal(root.querySelector('.core-site-list').textContent,'First site');assert.equal(more(root).hidden,true);
});

test('the list holds card placeholders while it loads, and each card shows its progress once it is in view',async t=>{
  const {root,requests,reveal}=setup(t);
  assert.ok(root.querySelectorAll('.core-site-skeleton').length>0,'card placeholders hold the grid');
  assert.doesNotMatch(root.querySelector('.core-site-list').textContent,/Loading/);
  requests[0].answer({projects:[{id:'a',title:'1 MAIN STREET',bbl:'1000010001',version:4},{id:'b',title:null,bbl:'3000020002',version:1},{id:'c',title:null,version:1}],nextCursor:null});await flush();
  const cards=[...root.querySelectorAll('.core-site')];
  assert.deepEqual(cards.map(c=>c.querySelector('strong').textContent),['1 Main Street','BBL 3000020002','Untitled site'],'an untitled site is named by its BBL when it has one');
  assert.ok(cards[0].querySelector('.core-site-progress .skel'),'progress holds its line until it loads');
  reveal();
  assert.equal(requests.length,4);assert.equal(requests[1].url,'/api/projects/a/state');
  const {fullState}=await import('./fixtures/project-state.mjs');
  requests[1].answer(fullState);requests[2].answer({id:'b',fields:{}});requests[3].answer({error:'Gone'},false);await flush();
  assert.equal(cards[0].querySelector('.core-site-progress').textContent,'2 of 4 stepsNeeds a refreshLand $4.50MProfit $1.83M');
  assert.equal(cards[1].querySelector('.core-site-progress').textContent,'0 of 4 steps');
  assert.equal(cards[2].querySelector('.core-site-progress').textContent,'','a card whose state did not load keeps only its name and date');
});
test('the sites list starts a new site from an address through the same flow as home',async t=>{
  const {root,requests}=setup(t);requests[0].answer({projects:[],nextCursor:null});await flush();
  const head=root.querySelector('.core-screen-head');
  assert.equal([...head.querySelectorAll('button.primary')].filter(b=>!b.closest('[hidden]')).length,1,'one primary action');
  assert.equal(root.querySelector('.core-screen-head .core-note'),null,'no intro paragraph');
  const open=head.querySelector('[aria-controls="core-new-site-form"]');assert.equal(open.textContent,'New site');open.click();
  const form=root.querySelector('#core-new-site-form');assert.equal(form.hidden,false);assert.equal(open.hidden,true);
  form.querySelector('input').value='3000020002';
  form.dispatchEvent(new (globalThis.window.Event)('submit',{cancelable:true}));
  assert.deepEqual(started.at(-1),['3000020002','Underwrite BBL 3000020002: resolve the parcel, then compute its zoning envelope, entitlement scenarios, unit mix and pro forma. Complete the underwriting without requiring or generating floor plans, massing models or 3D renders.','3000020002',null,{open:true}]);
  assert.equal(form.querySelector('[type=submit]').textContent,'Starting…');
});
