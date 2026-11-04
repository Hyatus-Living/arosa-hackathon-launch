import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {createListings} from '../public/listings.js';
import {normalizeDealSettings} from '../../acres-research/market-store.mjs';

const baseline=normalizeDealSettings(),settings={dealSettings:baseline,baselineSettings:baseline,isCustom:false};
const row=id=>{const n=id==='one'?1:id==='two'?2:id==='outside'?99:Number(id.split('-')[1])+3;return{id,address:`${n} Recovery Street`,bbl:`300966${String(n).padStart(4,'0')}`,borough:'BK',zipCode:'11201',zoningDistrict:'R7A',latitude:40.7,longitude:-73.99,listPrice:1_000_000+n*1000,lotAreaSqft:2500,existingBldgAreaSqft:2000,maxUapZfa:10000,maxStandardZfa:10000,unusedUapZfa:8000,similarComps:[],flashcardValuation:{dealVerdict:'good_deal',basis:[]}};};
const rows=[row('one'),row('two'),...Array.from({length:18},(_,i)=>row(`extra-${i}`))],box={south:40.6,west:-74,north:40.8,east:-73.9};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function setup(t,{canStart=()=>true}={}){
  const {document,window}=parseHTML(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));globalThis.document=document;globalThis.window=window;
  Object.defineProperty(document,'activeElement',{value:document.body,writable:true,configurable:true});window.HTMLElement.prototype.focus=function(){document.activeElement=this;};
  const originalFetch=globalThis.fetch,requests=[];globalThis.fetch=(target,options)=>new Promise((resolve,reject)=>{const u=new URL(target,'http://local');requests.push({u,options,settled:false,answer(body,ok=true){assert.equal(this.settled,false);this.settled=true;resolve({ok,status:ok?200:503,headers:{get:()=> 'application/json'},json:async()=>body});},reject(error){this.settled=true;reject(error);}});});
  t.after(()=>{globalThis.fetch=originalFetch;delete globalThis.document;delete globalThis.window;});
  const root=document.querySelector('#home-listings'),map={handlers:null,selected:null,box,selectionCalls:[],setPins(){},setActive(){},setSelected(id,options){this.selected=id;this.selectionCalls.push({id,options});},bounds(){return this.box;},resize(){},setBounds(b){this.box=b;}};
  const listings=createListings({root,canStart,onUnderwrite(){},onAsk(){},onToggleChat(){},isChatOpen:()=>false,loadMap:async(_node,handlers)=>{map.handlers=handlers;return map;}});
  const button=name=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===name),click=node=>{assert.ok(node,'Expected an available control');node.focus();node.click();};
  const pages=()=>requests.filter(r=>r.u.pathname==='/api/market-store/deals'),details=id=>requests.filter(r=>r.u.pathname==='/api/market-store/deals/'+id);
  const answerPage=(offset=0)=>pages().at(-1).answer({deals:rows,total:41,offset,limit:20,userSettings:settings}),answerPins=()=>{for(const r of requests.filter(r=>r.u.pathname.endsWith('/pins')&&!r.settled))r.answer({pins:[],total:0});};
  const answerDetail=(request,id)=>request.answer({deal:row(id),userSettings:settings});
  listings.show();await tick();answerPage();await tick();await tick();answerPins();await tick();
  const open=(id,fromMap=false)=>{if(fromMap)map.handlers.onPick(id);else click(root.querySelector(`[data-listing="${id}"] .listing-card-open`));return details(id).at(-1);};
  const hardCost=(value,apply=false)=>{const input=root.querySelector('#listing-cost-hardCostPerGrossSqft');input.value=String(value);input.dispatchEvent(new window.Event('input',{bubbles:true}));if(apply)input.closest('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));return input;};
  return{document,window,root,map,listings,requests,button,click,pages,details,answerPage,answerPins,answerDetail,open,hardCost};
}

test('pending and failed listing inspection always expose Back, and failure exposes a retry without losing results',async t=>{
  const f=await setup(t),before=f.listings.filterSnapshot(),request=f.open('one');
  assert.ok(f.button('Back to results'));assert.equal(f.root.querySelector('.listings-inspector').getAttribute('aria-busy'),'true');assert.ok(f.root.querySelector('.listings-inspector [role="status"]'));
  request.answer({error:'Details unavailable',userFacing:true},false);await tick();assert.ok(f.button('Back to results'));assert.ok(f.button('Try again'));assert.match(f.root.querySelector('.listings-inspector [role="alert"]').textContent,/Details unavailable/);
  assert.equal(f.listings.pageSnapshot().selected,null);f.click(f.button('Back to results'));assert.equal(f.root.querySelector('.listings-list').hidden,false);assert.equal(f.root.querySelector('.listings-pager').hidden,false);
  assert.deepEqual(f.listings.filterSnapshot(),before);assert.deepEqual(f.listings.pageSnapshot().rows.map(r=>r.id),rows.map(r=>r.id));assert.equal(f.map.selected,null);
});

test('Back while loading ignores both late success and late failure without making another page request',async t=>{
  const f=await setup(t);for(const ok of [true,false]){const request=f.open('one'),pages=f.pages().length;f.click(f.button('Back to results'));if(ok)f.answerDetail(request,'one');else request.answer({error:'Late failure'},false);await tick();assert.equal(f.root.querySelector('.listings-inspector').hidden,true);assert.equal(f.listings.pageSnapshot().selected,null);assert.equal(f.pages().length,pages);assert.equal(f.map.selected,null);assert.equal(f.document.activeElement===f.root.querySelector('[data-listing="one"] .listing-card-open'),true);}
});

test('retry uses the same requested property and can recover after repeated read failures',async t=>{
  const f=await setup(t);f.open('two').answer({error:'First failure'},false);await tick();f.click(f.button('Try again'));let next=f.details('two').at(-1);next.reject(new Error('Network offline'));await tick();assert.equal(f.root.querySelector('.listings-inspector [role="alert"]').textContent,'Could not reach the market store. Check your connection and try again.');
  f.click(f.button('Try again'));next=f.details('two').at(-1);f.answerDetail(next,'two');await tick();assert.equal(f.root.querySelector('.listing-inspector').dataset.listing,'two');assert.equal(f.listings.pageSnapshot().selected.id,'two');assert.equal(f.details('two').length,3);assert.equal(f.requests.some(r=>r.options?.method&&r.options.method!=='GET'),false);
});

test('a different map property cannot inherit the previous inspector selection during loading or error',async t=>{
  const f=await setup(t);f.answerDetail(f.open('one'),'one');await tick();assert.equal(f.listings.pageSnapshot().selected.id,'one');const request=f.open('outside',true);
  assert.equal(f.listings.pageSnapshot().selected,null);assert.doesNotMatch(f.listings.context(),/Open listing:/);request.answer({error:'Map property unavailable'},false);await tick();assert.equal(f.listings.pageSnapshot().selected,null);assert.equal(f.map.selected,'outside');
  f.click(f.button('Back to results'));assert.equal(f.map.selected,null);assert.equal(f.document.activeElement===f.root.querySelector('button[data-view="map"]'),true);
});

test('out-of-order detail responses cannot replace the newest target or redirect its retry',async t=>{
  const f=await setup(t),older=f.open('one'),newer=f.open('two',true);newer.answer({error:'Latest target failed',userFacing:true},false);await tick();f.answerDetail(older,'one');await tick();assert.match(f.root.querySelector('.listings-inspector [role="alert"]').textContent,/Latest target failed/);assert.equal(f.listings.pageSnapshot().selected,null);
  f.click(f.button('Try again'));assert.equal(f.details('two').length,2);assert.equal(f.details('one').length,1);f.answerDetail(f.details('two').at(-1),'two');await tick();assert.equal(f.listings.pageSnapshot().selected.id,'two');
});

test('inspection focuses its recovery controls but a response does not steal focus from another field',async t=>{
  const f=await setup(t),request=f.open('one');assert.equal(f.document.activeElement===f.button('Back to results'),true);request.answer({error:'Failed read'},false);await tick();assert.equal(f.document.activeElement===f.button('Try again'),true);
  f.click(f.button('Try again'));const input=f.root.querySelector('input[aria-label="Zoning district"]');input.focus();f.answerDetail(f.details('one').at(-1),'one');await tick();assert.equal(f.document.activeElement===input,true);
  f.click(f.button('Back to results'));const next=f.open('one');f.answerDetail(next,'one');await tick();assert.equal(f.document.activeElement===f.root.querySelector('#inspector-title'),true);
});

test('previewing costs while an outside-page property loads refreshes that same target and retains later drafts on Back',async t=>{
  const f=await setup(t);f.map.handlers.onMove(box);await tick();f.answerPage(20);await tick();const old=f.open('outside',true);f.hardCost(650,true);await tick();const current=f.details('outside').at(-1);assert.notEqual(current,old);assert.equal(current.u.searchParams.get('hardCostPerGrossSqft'),'650');
  f.answerPage(0);f.answerPins();f.answerDetail(current,'outside');await tick();f.answerDetail(old,'outside');await tick();assert.equal(f.listings.filterSnapshot().values.hardCostPerGrossSqft,650);assert.equal(f.listings.pageSnapshot().selected.id,'outside');
  const input=f.hardCost(900),before=f.listings.filterSnapshot();f.click(f.button('Back to results'));assert.equal(input.value,'900');assert.deepEqual(f.listings.filterSnapshot().values,before.values);assert.deepEqual(f.listings.filterSnapshot().map.bounds,before.map.bounds);assert.equal(f.listings.filterSnapshot().baselineCosts.hardCostPerGrossSqft,375);
});

test('failure text remains literal, busy state clears and retry respects the existing ability to start underwriting',async t=>{
  const f=await setup(t,{canStart:()=>false}),request=f.open('one');assert.equal(f.root.querySelector('.listings-inspector').getAttribute('aria-busy'),'true');request.answer({error:'<img src=x onerror=alert(1)> unavailable',userFacing:true},false);await tick();assert.equal(f.root.querySelector('.listings-inspector img'),null);assert.match(f.root.querySelector('.listings-inspector [role="alert"]').textContent,/<img/);assert.equal(f.root.querySelector('.listings-inspector').getAttribute('aria-busy'),'false');
  f.click(f.button('Try again'));f.answerDetail(f.details('one').at(-1),'one');await tick();assert.equal(f.button('Underwrite').disabled,true);assert.equal(f.root.querySelector('.listings-inspector').getAttribute('aria-busy'),'false');
});
