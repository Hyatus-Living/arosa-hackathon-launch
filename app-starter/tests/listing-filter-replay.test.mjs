import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createListings} from '../public/listings.js';
import {FILTER_SCHEMA_ID, COST_KEYS, defaultFilterValues} from '../public/listing-filter-schema.js';

const flush=()=>new Promise(setImmediate);
const recorded={hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15};
const saved=values=>({base:{schema:FILTER_SCHEMA_ID,revision:2,values:defaultFilterValues(),baselineCosts:recorded},values:{...defaultFilterValues(),borough:'BK',maxPrice:2000000,types:['land'],followMap:false,...values}});
async function setup(t,{baseline=recorded,mount=true}={}){
  const {document,window}=parseHTML('<!doctype html><html><body><section id="home-listings"></section></body></html>');
  const previous={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  Object.assign(globalThis,{document,window});t.after(()=>Object.assign(globalThis,previous));
  const requests=[],root=document.querySelector('#home-listings');
  globalThis.fetch=async path=>{const url=new URL(path,'http://fixture');requests.push(url);return Response.json(url.pathname.endsWith('/pins')?{pins:[]}:{deals:[],total:0,offset:0,userSettings:{dealSettings:baseline,baselineSettings:baseline,isCustom:true}});};
  const listings=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},onToggleChat(){},isChatOpen:()=>false,loadMap:async()=>({setPins(){},resize(){},bounds:()=>({south:40.6,west:-74,north:40.8,east:-73.9})})});
  if(mount){listings.show();await flush();await flush();}
  return {root,window,requests,listings,snapshot:()=>listings.filterSnapshot()};
}

test('reusing a saved result applies every filter and explicit zero cost through the listing query',async t=>{
  const c=await setup(t),values={...defaultFilterValues(),borough:'BK',area:'11231',minPrice:0,maxPrice:2000000,maxPpb:220,minLot:2000,maxLot:6500,zoning:'R6',minFar:.5,tiers:['good_deal'],types:['land'],excludeRisk:true,excludeLandmarks:true,sortBy:'unused_uap_zfa',followMap:false,hardCostPerGrossSqft:400,softCostPctOfHard:0,carryAndFinancingPct:0,zfaToGrossFactor:1.3};
  assert.equal(c.listings.applySavedFilterUpdate(saved(values)),true);await flush();
  assert.deepEqual(c.snapshot().values,values);
  const query=c.requests.findLast(url=>url.pathname.endsWith('/deals')).searchParams;
  assert.equal(query.get('maxListPrice'),'2000000');assert.equal(query.get('minListPrice'),'0');
  for(const key of COST_KEYS)assert.equal(query.get(key),key==='condoHardCostPerGrossSqft'?'375':String(values[key])); // condo unspecified: recorded baseline rental figure
});

test('unspecified saved costs resolve to the recorded baseline rather than a later profile',async t=>{
  const baseline={hardCostPerGrossSqft:650,softCostPctOfHard:.3,carryAndFinancingPct:.15,zfaToGrossFactor:1.5},c=await setup(t,{baseline});
  assert.equal(c.listings.applySavedFilterUpdate(saved({})),true);await flush();
  for(const key of COST_KEYS)assert.equal(c.snapshot().values[key],recorded[key]??null);
  assert.deepEqual(c.snapshot().baselineCosts,baseline);
});

test('explicit history replay accepts an old revision and Undo restores the current search',async t=>{
  const c=await setup(t),borough=c.root.querySelector('.listings-filters select');
  for(const option of borough.querySelectorAll('option'))option.selected=false;
  borough.querySelector('option[value="QN"]').selected=true;
  borough.dispatchEvent(new c.window.Event('change'));await flush();const before=c.snapshot();
  assert.notEqual(before.revision,2);assert.equal(before.values.borough,'QN');
  assert.equal(c.listings.applySavedFilterUpdate(saved({})),true);await flush();
  c.root.querySelector('[data-filter-action="undo"]').click();await flush();
  assert.deepEqual(c.snapshot().values,before.values);
});

test('an incomplete saved filter result leaves the current search and query untouched',async t=>{
  const c=await setup(t),before=c.snapshot(),count=c.requests.length,update=saved({});delete update.values.maxPrice;
  assert.equal(c.listings.applySavedFilterUpdate(update),false);await flush();
  assert.deepEqual(c.snapshot(),before);assert.equal(c.requests.length,count);assert.match(c.root.textContent,/complete filter state.*No filters changed/i);
});

test('an obsolete saved schema is rejected without changing filters or issuing another query',async t=>{
  const c=await setup(t),before=c.snapshot(),count=c.requests.length,update=saved({});update.base.schema='acres.listing-filters/0';
  assert.equal(c.listings.applySavedFilterUpdate(update),false);await flush();
  assert.deepEqual(c.snapshot(),before);assert.equal(c.requests.length,count);assert.match(c.root.textContent,/Invalid filter snapshot.*No filters changed/i);
});

test('a saved search can open from history before the listing controls have mounted',async t=>{
  const c=await setup(t,{mount:false,baseline:{...recorded,hardCostPerGrossSqft:650}});
  assert.equal(c.listings.applySavedFilterUpdate(saved({})),true);await flush();await flush();
  assert.equal(c.snapshot().values.borough,'BK');assert.deepEqual(c.snapshot().values.types,['land']);
  for(const key of COST_KEYS)assert.equal(c.snapshot().values[key],recorded[key]??null);
  assert.ok(c.root.querySelector('.listings-filters'));
});

test('explicit replay clears pending manual drafts and Undo recovers the prior cost draft',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const c=await setup(t),field=label=>[...c.root.querySelectorAll('label')].find(node=>node.querySelector('span')?.textContent===label).querySelector('input');
  const area=field('ZIP or neighborhood');area.value='Unapplied area';area.dispatchEvent(new c.window.Event('input',{bubbles:true}));
  const hard=field('Rental hard cost, $ per gross SF');hard.value='777';hard.dispatchEvent(new c.window.Event('input',{bubbles:true}));
  assert.equal(c.listings.applySavedFilterUpdate(saved({})),true);t.mock.timers.tick(351);await flush();
  assert.equal(c.snapshot().values.area,'');assert.equal(area.value,'');assert.equal(hard.value,'375');
  c.root.querySelector('[data-filter-action="undo"]').click();await flush();assert.equal(hard.value,'777');
});
