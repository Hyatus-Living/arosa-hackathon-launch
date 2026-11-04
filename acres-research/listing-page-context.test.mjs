import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {ChatStore} from './store.mjs';
import {RunManager} from './manager.mjs';
import {createResearchServer} from './service.mjs';
import {FILTER_SCHEMA_ID,defaultFilterValues} from './listing-filter-schema.mjs';
import {LISTING_PAGE_SCHEMA_ID,captureListingPage,validateListingPage,listingPageView} from '../app-starter/public/listing-page-context.js';
import {createListings} from '../app-starter/public/listings.js';
import {listingsContext,withListingsContext,defaultFilters} from '../app-starter/public/listings-model.js';

const costs={hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15};
const rows=(start=21)=>Array.from({length:20},(_,i)=>({id:`listing-${start+i}`,address:`${start+i} Reference Street`,bbl:`300966${String(start+i).padStart(4,'0')}`,zoningDistrict:'R7A',listPrice:i===0?0:i===19?null:1_000_000+i}));
const page=()=>captureListingPage({status:'ready',offset:20,total:51,deals:rows(),selected:null});
const filters=()=>({prompt:'Identify the last listing on this results page.',snapshot:{schema:FILTER_SCHEMA_ID,revision:1,values:{...defaultFilterValues(),...costs},baselineCosts:costs},page:page()});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'acres-page-context-')),path=join(dir,'chat.sqlite'),store=new ChatStore(path),owner='a'.repeat(24),conversation=store.createConversation(owner);t.after(()=>{store.close();rmSync(dir,{recursive:true});});return{dir,path,store,owner,conversation};}
const terminal=(manager,id)=>new Promise(resolve=>{const listener=event=>{if(['run.completed','run.failed','run.interrupted'].includes(event.event)){manager.off(id,listener);resolve(event);}};manager.on(id,listener);});

test('a complete loaded page retains all 20 identities, offset, zero and unknown prices and an independent inspector selection',()=>{
  const deals=rows(),selected=rows(91)[0],captured=captureListingPage({status:'ready',offset:20,total:51,deals,selected});
  assert.equal(captured.schema,LISTING_PAGE_SCHEMA_ID);assert.equal(captured.rows.length,20);assert.equal(captured.rows.at(-1).id,'listing-40');assert.equal(captured.offset,20);assert.equal(captured.total,51);
  assert.equal(captured.rows[0].listPrice,0);assert.equal(captured.rows.at(-1).listPrice,null);assert.equal(captured.selected.id,'listing-91');
  deals[19].address='Caller mutation';selected.address='Selection mutation';assert.equal(captured.rows[19].address,'40 Reference Street');assert.equal(captured.selected.address,'91 Reference Street');
});

test('page validation rejects unsupported, oversized and malformed identity data before queuing',t=>{
  const f=fixture(t),valid=page();
  for(const invalid of [{...valid,schema:'future/2'},{...valid,status:'invented'},{...valid,offset:-1},{...valid,total:1.5},{...valid,rows:[...valid.rows,valid.rows[0]]},{...valid,rows:[{...valid.rows[0],id:null}]},{...valid,rows:[{...valid.rows[0],listPrice:'100'}]}]){
    assert.throws(()=>validateListingPage(invalid));assert.throws(()=>f.store.createRun(f.owner,f.conversation.id,'Question',randomUUID(),{...filters(),page:invalid}));
  }
  assert.equal(f.store.conversation(f.owner,f.conversation.id).runs.length,0);
});

test('the mounted page captures committed pagination, retained loading cards, failed pages and empty results honestly',async t=>{
  const {document,window}=parseHTML(readFileSync(new URL('../app-starter/public/index.html',import.meta.url),'utf8'));globalThis.document=document;globalThis.window=window;
  const originalFetch=globalThis.fetch,pending=[];globalThis.fetch=url=>new Promise(resolve=>{const u=new URL(url,'http://local');pending.push({u,answer:(body,ok=true)=>resolve({ok,headers:{get:()=> 'application/json'},json:async()=>body})});});t.after(()=>{globalThis.fetch=originalFetch;delete globalThis.document;delete globalThis.window;});
  const root=document.querySelector('#home-listings'),map={setPins(){},setActive(){},setSelected(){},bounds:()=>null,resize(){}};
  const listing=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},onToggleChat(){},isChatOpen:()=>false,loadMap:async()=>map});listing.show();assert.equal(listing.pageSnapshot().status,'loading');assert.equal(listing.pageSnapshot().rows.length,0);
  const last=()=>pending.filter(x=>x.u.pathname.endsWith('/deals')).at(-1),answer=(at,deals=rows(at+1))=>last().answer({deals,total:51,offset:at,userSettings:{dealSettings:costs,isCustom:false}});
  answer(0);await tick();await tick();assert.equal(listing.pageSnapshot().rows.length,20);
  const button=name=>[...root.querySelectorAll('button')].find(x=>x.textContent.trim()===name);button('Next').click();assert.equal(listing.pageSnapshot().status,'loading');assert.equal(listing.pageSnapshot().offset,0);
  answer(20);await tick();assert.equal(listing.pageSnapshot().offset,20);assert.equal(listing.pageSnapshot().rows.at(-1).id,'listing-40');
  button('Next').click();last().answer({error:'Read failed'},false);await tick();assert.equal(listing.pageSnapshot().status,'error');assert.equal(listing.pageSnapshot().rows.length,0);
  button('Try again').click();assert.equal(listing.pageSnapshot().rows.length,0);answer(40,[]);await tick();assert.equal(listing.pageSnapshot().status,'ready');assert.equal(listing.pageSnapshot().rows.length,0);
  for(const p of pending.filter(x=>x.u.pathname.endsWith('/pins')))p.answer({pins:[],total:0});await tick();
});

test('durable request identity includes the last captured row while preserving equivalent JSON key order',t=>{
  const f=fixture(t),id=randomUUID(),input=filters();f.store.createRun(f.owner,f.conversation.id,input.prompt,id,input);input.page.rows[19].address='External mutation';
  assert.equal(f.store.runEvents(id)[0].listingFilters.page.rows[19].address,'40 Reference Street');
  const reordered=filters();reordered.page=Object.fromEntries(Object.entries(reordered.page).reverse());assert.equal(f.store.createRun(f.owner,f.conversation.id,reordered.prompt,id,reordered).id,id);
  const different=filters();different.page.rows[19].id='different-last-listing';assert.throws(()=>f.store.createRun(f.owner,f.conversation.id,different.prompt,id,different),/different filters/);
});

test('queued restart, a full-length question, saved user messages and subsequent research history retain the complete page',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-page-resume-')),path=join(dir,'chat.sqlite'),owner='a'.repeat(24);let store=new ChatStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  const conversation=store.createConversation(owner),input=filters(),question='Which listing is last? '+ 'x'.repeat(2977);assert.equal(question.length,3000);
  const legacy=withListingsContext(question,listingsContext({filters:defaultFilters(),total:51,deals:rows()}));assert.equal(legacy,question);
  const run=store.createRun(owner,conversation.id,question,randomUUID(),{...input,prompt:question});store.close();store=new ChatStore(path);
  const calls=[],manager=new RunManager(store,{},async data=>{calls.push(data);return{answer:'Captured listing-40.',sources:[]};},null,null,null,async()=>({mode:'research',filterUpdate:null}));
  let done=terminal(manager,run.id);manager.pump();assert.equal((await done).event,'run.completed');
  assert.deepEqual(calls[0].listingPage,input.page);assert.ok(calls[0].message.includes(JSON.stringify(input.page)));assert.ok(calls[0].message.includes(question));
  const saved=store.conversation(owner,conversation.id).messages.find(x=>x.role==='user');assert.deepEqual(saved.listingPage,input.page);
  const second=store.createRun(owner,conversation.id,'Compare the last two properties from that captured page.');done=terminal(manager,second.id);manager.pump();assert.equal((await done).event,'run.completed');
  assert.equal(calls[1].listingPage,null);assert.ok(calls[1].history.some(m=>m.role==='user'&&m.text.includes('listing-40')&&m.text.includes('listing-39')));
});

test('normal HTTP rejects malformed page data and returns full captured references from a completed saved chat',async t=>{
  const f=fixture(t),server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store:f.store,filterDecider:async()=>({mode:'research',filterUpdate:null}),execute:async()=>({answer:'Captured last listing.',sources:[]})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer test','x-acres-account':f.owner,'content-type':'application/json'},post=data=>fetch(base+'/conversations/'+f.conversation.id+'/runs',{method:'POST',headers,body:JSON.stringify(data)});
  try{
    const invalid=await post({message:'Question',listingFilters:{...filters(),page:{...page(),rows:[{}]}}});assert.equal(invalid.status,400);
    const id=randomUUID(),response=await post({message:'Which listing is last?',id,listingFilters:filters()});assert.equal(response.status,202);
    const events=await(await fetch(base+'/runs/'+id+'/events',{headers,signal:AbortSignal.timeout(5000)})).text();assert.match(events,/"event":"run.completed"/);
    const chat=await(await fetch(base+'/conversations/'+f.conversation.id,{headers})).json();assert.deepEqual(chat.messages.find(m=>m.role==='user').listingPage,page());
    assert.equal((await fetch(base+'/conversations/'+f.conversation.id,{headers:{...headers,'x-acres-account':'b'.repeat(24)}})).status,404);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('the saved page disclosure shows all ordered references, selection and literal safe source text',()=>{
  const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
  const p=page();p.rows[1].address='<img src=x onerror=alert(1)>';p.selected={...p.rows[0],address:'Inspector selection'};const view=listingPageView(p);
  assert.match(view.querySelector('summary').textContent,/results 21 to 40 of 51/);assert.equal(view.querySelectorAll('li').length,20);assert.equal(view.querySelector('ol').getAttribute('start'),'21');
  assert.match(view.querySelectorAll('li')[0].textContent,/ask \$0/);assert.match(view.querySelectorAll('li')[19].textContent,/40 Reference Street.*unpriced/i);assert.equal(view.querySelector('img'),null);assert.match(view.textContent,/Inspector selection/);delete globalThis.document;
});

test('loading, failed and empty page disclosures do not claim an absent last listing is ready',()=>{
  const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
  const loading=listingPageView({...page(),status:'loading'});assert.match(loading.querySelector('summary').textContent,/updating/);assert.match(loading.textContent,/previously loaded/i);
  for(const [status,expected]of [['error',/failed to load/],['ready',/empty results/]]){const view=listingPageView({...page(),status,rows:[]});assert.match(view.querySelector('summary').textContent,expected);assert.equal(view.querySelectorAll('li').length,0);}delete globalThis.document;
});

test('research history keeps the rows of only the latest captured page; earlier pages shrink to a note',async t=>{
  const f=fixture(t),calls=[],manager=new RunManager(f.store,{},async data=>{calls.push(data);return{answer:'Noted.',sources:[]};},null,null,null,async()=>({mode:'research',filterUpdate:null}));
  const ask=async(prompt,input=null)=>{const run=f.store.createRun(f.owner,f.conversation.id,prompt,randomUUID(),input);const done=terminal(manager,run.id);manager.pump();assert.equal((await done).event,'run.completed');};
  await ask('Which is last?',{...filters(),prompt:'Which is last?'});
  const later=captureListingPage({status:'ready',offset:40,total:51,deals:rows(41).slice(0,11),selected:rows(41)[2]});
  await ask('And on this page?',{...filters(),prompt:'And on this page?',page:later});
  await ask('Compare the two pages.');
  const [first,second]=calls[2].history.filter(m=>m.role==='user').map(m=>m.text);
  assert.ok(!first.includes('listing-21')&&!first.includes('listing-40'),'the older page carries no rows');
  assert.match(first,/results 21 to 40 of 51/);assert.ok(first.endsWith('Which is last?'));
  assert.ok(second.includes(JSON.stringify(later)),'the latest page keeps its rows');assert.match(second,/43 Reference Street/);
});
