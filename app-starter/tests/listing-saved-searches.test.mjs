import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const pub=new URL('../public/',import.meta.url),{document,window}=parseHTML(readFileSync(new URL('index.html',pub),'utf8'));
globalThis.document=document;globalThis.window=window;
window.HTMLElement.prototype.showModal=function(){this.setAttribute('open','');};window.HTMLElement.prototype.close=function(){this.removeAttribute('open');};
const {createListings}=await import('../public/listings.js');
const {FILTER_SCHEMA_ID,COST_KEYS,defaultFilterValues,listingSearchFilters}=await import('../public/listing-filter-schema.js');
const {listingSearchesView}=await import('../public/listing-search-view.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const house={hardCostPerGrossSqft:375,rentalHardCostPerGrossSqft:375,condoHardCostPerGrossSqft:450,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15};
const A={south:40.67,west:-73.99,north:40.68,east:-73.96},B={south:40.71,west:-73.97,north:40.72,east:-73.95};
const queryBox=box=>[box.south,box.west,box.north,box.east].map(n=>n.toFixed(5)).join(',');

async function setup(t){
  const requests=[];
  globalThis.fetch=(url,options={})=>new Promise(resolve=>{const u=new URL(url,'http://x');requests.push({path:u.pathname,method:options.method||'GET',params:u.searchParams,body:options.body?JSON.parse(options.body):null,answer:(body,status=200)=>resolve({ok:status<300,status,headers:{get:()=>'application/json'},json:async()=>body})});});
  t.after(()=>{delete globalThis.fetch;});
  const root=document.querySelector('#home-listings');root.replaceChildren();
  const map={box:A,handlers:null,restored:[],setPins(){},setBounds(box){this.box=box;this.restored.push({...box});},setActive(){},setSelected(){},bounds(){return {...this.box};},resize(){}};
  const listings=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},loadMap:async(_node,handlers)=>{map.handlers=handlers;return map;}});
  const take=path=>requests.filter(r=>r.path===path);
  const last=path=>take(path).at(-1),pending=path=>requests.filter(r=>r.path===path&&!r.done);
  const answer=(path,body,status)=>{const r=last(path);r.done=true;r.answer(body,status);return r;};
  listings.show();await tick();answer('/api/market-store/deals',{deals:[],total:0,offset:0,limit:20,userSettings:{isCustom:false,dealSettings:house}});await tick();await tick();
  answer('/api/market-store/deals/pins',{pins:[],total:0});await tick();
  map.handlers.onMove(A);await tick();
  const button=(name,scope=root)=>[...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===name||b.getAttribute('aria-label')===name);
  const choose=(label,value)=>{const select=[...root.querySelectorAll('.listings-drawer label')].find(l=>l.querySelector('.sr-only')?.textContent===label).querySelector('select');for(const o of select.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);select.dispatchEvent(new window.Event('change'));};
  const openDrawer=async(searches=[])=>{root.querySelector('.listings-all').click();await tick();assert.equal(last('/api/market-store/saved-searches').method,'GET');answer('/api/market-store/saved-searches',{searches});await tick();};
  const saved=()=>[...root.querySelectorAll('.listings-saved-apply')].map(b=>b.textContent);
  return {root,map,listings,requests,take,last,answer,button,choose,openDrawer,saved,drawer:root.querySelector('.listings-drawer')};
}

test('Save search names the current filters, map area and costs without a chat message, and the library reapplies them in one click',async t=>{
  const c=await setup(t);
  c.choose('Borough','BK');await tick();c.map.handlers.onMove(A);await tick();
  await c.openDrawer();
  assert.match(c.drawer.querySelector('.listings-saved').textContent,/No saved searches yet/);
  const name=c.drawer.querySelector('.listings-save input');name.value='Brooklyn deals';
  c.drawer.querySelector('.listings-save').dispatchEvent(new window.Event('submit',{cancelable:true}));await tick();
  const post=c.last('/api/market-store/saved-searches');
  assert.equal(post.method,'POST');assert.equal(post.body.name,'Brooklyn deals');
  assert.deepEqual(post.body.search,{schema:FILTER_SCHEMA_ID,values:{...defaultFilterValues(),borough:'BK',...Object.fromEntries(COST_KEYS.map(key=>[key,house[key]]))},bounds:A,condoHardCostPerGrossSqft:450});
  assert.equal(c.take('/api/conversations').length,0);
  const record={id:'s1',name:'Brooklyn deals',search:post.body.search,createdAt:'2026-10-21T12:00:00.000Z',updatedAt:'2026-10-21T12:00:00.000Z'};
  c.answer('/api/market-store/saved-searches',record,201);await tick();
  assert.deepEqual(c.saved(),['Brooklyn deals']);assert.equal(name.value,'');assert.match(c.drawer.querySelector('.listings-saved-note').textContent,/Saved/);

  // Move away: another borough, map area and cost, then reapply.
  c.drawer.close();c.choose('Borough','QN');await tick();c.map.box=B;c.map.handlers.onMove(B);await tick();
  const hard=root=>root.querySelector('#listing-cost-hardCostPerGrossSqft');hard(c.root).value='500';hard(c.root).dispatchEvent(new window.Event('input',{bubbles:true}));hard(c.root).dispatchEvent(new window.Event('change',{bubbles:true}));await tick();
  assert.equal(c.last('/api/market-store/deals').params.get('hardCostPerGrossSqft'),'500');
  await c.openDrawer([record]);c.button('Brooklyn deals',c.drawer).click();await tick();
  assert.equal(c.drawer.hasAttribute('open'),false,'applying closes the drawer onto the results');
  const query=c.last('/api/market-store/deals').params,pins=c.last('/api/market-store/deals/pins').params;
  assert.equal(query.get('borough'),'BK');assert.equal(query.get('bounds'),queryBox(A));assert.equal(pins.get('bounds'),queryBox(A));
  for(const key of COST_KEYS)assert.equal(query.get(key),String(house[key]),key);
  assert.equal(query.get('condoHardCostPerGrossSqft'),'450');
  assert.deepEqual(c.map.restored.at(-1),A,'the map returns to the saved area');
  assert.match(c.root.querySelector('.listings-receipt').textContent,/Saved search Brooklyn deals applied: Brooklyn/);
  c.button('Undo').click();await tick();
  assert.equal(c.last('/api/market-store/deals').params.get('borough'),'QN');assert.equal(c.last('/api/market-store/deals').params.get('bounds'),queryBox(B));
  assert.equal(c.last('/api/market-store/deals').params.get('hardCostPerGrossSqft'),'500');
});

test('a saved search is renamed and deleted from the library, and a refused save says why',async t=>{
  const c=await setup(t),search={schema:FILTER_SCHEMA_ID,values:{...defaultFilterValues(),...Object.fromEntries(COST_KEYS.map(key=>[key,house[key]]))},bounds:null};
  const record={id:'s1',name:'Citywide',search,createdAt:'2026-10-21T12:00:00.000Z',updatedAt:'2026-10-21T12:00:00.000Z'};
  await c.openDrawer([record,{...record,id:'s2',name:'Queens'}]);
  assert.deepEqual(c.saved(),['Citywide','Queens']);
  c.button('Rename Citywide',c.drawer).click();
  const input=c.drawer.querySelector('.listings-saved-rename input');assert.equal(input.value,'Citywide');input.value='All of NYC';
  c.drawer.querySelector('.listings-saved-rename').dispatchEvent(new window.Event('submit',{cancelable:true}));await tick();
  const patch=c.last('/api/market-store/saved-searches/s1');assert.equal(patch.method,'PATCH');assert.deepEqual(patch.body,{name:'All of NYC'});
  c.answer('/api/market-store/saved-searches/s1',{...record,name:'All of NYC'});await tick();
  assert.deepEqual(c.saved(),['All of NYC','Queens']);
  c.button('Delete Queens',c.drawer).click();await tick();
  assert.equal(c.last('/api/market-store/saved-searches/s2').method,'DELETE');
  c.answer('/api/market-store/saved-searches/s2',{deleted:true});await tick();
  assert.deepEqual(c.saved(),['All of NYC']);assert.match(c.drawer.querySelector('.listings-saved-note').textContent,/Deleted Queens/);
  const name=c.drawer.querySelector('.listings-save input');name.value='All of NYC';
  c.drawer.querySelector('.listings-save').dispatchEvent(new window.Event('submit',{cancelable:true}));await tick();
  c.answer('/api/market-store/saved-searches',{error:'You already have a saved search named All of NYC.'},409);await tick();
  assert.match(c.drawer.querySelector('.listings-saved-note').textContent,/already have a saved search named All of NYC/);assert.deepEqual(c.saved(),['All of NYC']);
  assert.equal(name.value,'All of NYC','the name stays to correct');
});

const receipt=(filters={})=>({sourceId:3,returnedCount:4,searchedAt:'2026-10-21T12:00:00Z',filters:{...listingSearchFilters({...defaultFilterValues(),borough:'BK',area:'11231',minPrice:0,maxPrice:2000000,maxPpb:220,zoning:'R6',minFar:.5,tiers:['good_deal','unpriced_opportunity'],types:['land'],excludeRisk:true,mih:'outside',sortBy:'unused_uap_zfa'}),zipCode:null,listingType:'for_sale',limit:15,maxPricePerBuildableAnyUse:null,bounds:A,hardCostPerGrossSqft:400,softCostPctOfHard:0,carryAndFinancingPct:0,zfaToGrossFactor:1.3,...filters}});

test('Use these filters on a listing search receipt restores the identical query, map area and costs',async t=>{
  const c=await setup(t),search=receipt();
  c.choose('Borough','QN');await tick();
  assert.equal(c.listings.applyListingSearch(search),true);await tick();
  const query=c.last('/api/market-store/deals').params;
  const expected={borough:'BK',area:'11231',zoningPrefix:'R6',minListPrice:'0',maxListPrice:'2000000',maxPricePerBuildableZfa:'220',minHeadroomFar:'0.5',dealVerdict:'good_deal,unpriced_opportunity',styles:'land',excludeHighStabilizedRisk:'true',mihArea:'outside',sortBy:'unused_uap_zfa',minUnusedZfa:'250',bounds:queryBox(A),hardCostPerGrossSqft:'400',softCostPctOfHard:'0',carryAndFinancingPct:'0',zfaToGrossFactor:'1.3'};
  for(const [key,value] of Object.entries(expected))assert.equal(query.get(key),value,key);
  for(const key of ['minLotArea','maxLotArea','excludeLandmarks','minProjectCost'])assert.equal(query.has(key),false,key);
  assert.deepEqual(c.map.restored.at(-1),A);
  assert.doesNotMatch(c.root.querySelector('.listings-receipt').textContent,/Not on this page/);
  c.button('Undo').click();await tick();assert.equal(c.last('/api/market-store/deals').params.get('borough'),'QN');
});

test('a receipt the page cannot show exactly applies what it can and names the rest; an invalid one changes nothing',async t=>{
  const c=await setup(t);
  assert.equal(c.listings.applyListingSearch(receipt({minUnusedZfa:500,listingType:'sold',sortBy:'unused_far',bounds:null})),true);await tick();
  const text=c.root.querySelector('.listings-receipt').textContent;
  assert.match(text,/Not on this page: the order Most unused FAR; sold listings, as this page shows listings for sale; at least 500 SF of unused floor area, as this page keeps 250 SF\./);
  assert.equal(c.last('/api/market-store/deals').params.has('bounds'),false);
  const count=c.take('/api/market-store/deals').length,before=c.listings.filterSnapshot().values;
  assert.equal(c.listings.applyListingSearch(receipt({dealVerdict:'bargain'})),false);await tick();
  assert.match(c.root.querySelector('.listings-receipt').textContent,/Invalid filter: tiers\. No filters changed\./);
  assert.equal(c.take('/api/market-store/deals').length,count);assert.deepEqual(c.listings.filterSnapshot().values,before);
});

test('each saved listing search offers Use these filters where the listings page exists',()=>{
  const searches=[receipt(),receipt({borough:'QN'})];
  const node=listingSearchesView(searches,6,{reuse:true}),buttons=[...node.querySelectorAll('button[data-listing-search]')];
  assert.deepEqual(buttons.map(b=>[b.textContent,b.dataset.listingSearch,b.dataset.message]),[['Use these filters','0','6'],['Use these filters','1','6']]);
  assert.equal(listingSearchesView(searches,6).querySelector('[data-listing-search]'),null);
  const source=readFileSync(new URL('app.js',pub),'utf8'),start=source.indexOf('const reuseSearch = e.target.closest("[data-listing-search]");'),end=source.indexOf('\n  }',start);
  assert.ok(start>0);
  const calls=[],context={e:{target:{closest:selector=>selector==='[data-listing-search]'?{dataset:{message:'6',listingSearch:'1'}}:null}},state:{messages:{6:{dealSearches:searches}}},navigate:path=>calls.push(['navigate',path]),setChatDock(){},window:{innerWidth:1200},listings:{applyListingSearch:search=>calls.push(['apply',search.filters.borough])}};
  vm.createContext(context);vm.runInContext('(()=>{'+source.slice(start,end)+'\n  }})()',context);
  assert.deepEqual(calls,[['navigate','/'],['apply','QN']]);
  assert.match(source,/listingSearchesView\(m\.dealSearches, i, \{ reuse: dealsOnHome \}\)/);
});
