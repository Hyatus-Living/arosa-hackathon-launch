import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {FILTER_SCHEMA_ID, FILTER_SCHEMA, COST_KEYS, defaultFilterValues} from '../public/listing-filter-schema.js';
import {createListingSearchLink, readListingSearchLink} from '../public/listing-search-link.js';
import {createListings} from '../public/listings.js';
import {linkOrigin} from '../public/core-route.js';

const baseline={hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15};
const box={south:40.67,west:-73.99,north:40.72,east:-73.94};
const values=()=>({...defaultFilterValues(),borough:'BK',area:'Bedford & Stuyvesant / 東京',minPrice:0,maxPrice:2200000,maxPpb:300,minLot:1000,maxLot:5000,zoning:'R7A',minFar:1.75,tiers:['good_deal','great_deal'],types:['land','multi_family'],excludeRisk:true,excludeLandmarks:true,sortBy:'implied_yield_on_cost',hardCostPerGrossSqft:650,softCostPctOfHard:0,carryAndFinancingPct:0,zfaToGrossFactor:1.3});
const snapshot=(v=values(),bounds=box)=>({schema:FILTER_SCHEMA_ID,revision:9,values:v,baselineCosts:baseline,map:{revision:3,bounds,viewport:box}});
const url=(v=values(),bounds=box)=>createListingSearchLink('https://witharosa.ai/',snapshot(v,bounds));
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

async function mount(t,{searchUrl='https://witharosa.ai/',copyText=async()=>{}}={}) {
  const {document,window}=parseHTML(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));
  globalThis.document=document;globalThis.window=window;
  window.HTMLElement.prototype.showModal=function(){this.setAttribute('open','');};
  window.HTMLElement.prototype.close=function(){this.removeAttribute('open');};
  const calls=[];globalThis.fetch=async target=>{
    const u=new URL(target,'https://witharosa.ai');calls.push(u);
    const body=u.pathname.endsWith('/pins')?{pins:[],total:0}:{deals:[],total:0,offset:0,limit:20,userSettings:{isCustom:false,dealSettings:{...baseline}}};
    return {ok:true,headers:{get:()=> 'application/json'},json:async()=>body};
  };
  t.after(()=>{delete globalThis.fetch;delete globalThis.document;delete globalThis.window;});
  const root=document.querySelector('#home-listings'),map={restored:[],fits:0,setBounds(b){this.restored.push(b);},bounds:()=>box,setPins(_rows,{fit}){if(fit)this.fits++;},setSelected(){},setActive(){},resize(){}};
  const listings=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},onToggleChat(){},isChatOpen:()=>false,searchUrl,copyText,loadMap:async()=>map});
  listings.show();await tick();await tick();
  const button=name=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===name);
  const dialog=()=>root.querySelector('.listing-search-share');
  return {root,listings,map,calls,button,dialog};
}

test('a search link carries the condo hard cost, and the recipient prices the condo exit at it',async t=>{
  const link=createListingSearchLink('https://witharosa.ai/',{...snapshot(),condoHardCostPerGrossSqft:700});
  assert.equal(readListingSearchLink(link).condoHardCostPerGrossSqft,700);
  const {calls}=await mount(t,{searchUrl:link});
  const deals=calls.filter(u=>u.searchParams.has('condoHardCostPerGrossSqft'));
  assert.ok(deals.length);
  // The link's rental figure is 650 (values()); its condo figure is 700.
  for(const u of deals)assert.deepEqual([u.searchParams.get('hardCostPerGrossSqft'),u.searchParams.get('condoHardCostPerGrossSqft')],['650','700']);
  // A link from before the condo cost travelled carries the rental figure, which priced both exits.
  assert.equal(readListingSearchLink(url()).condoHardCostPerGrossSqft,undefined);
});

test('search links round-trip every canonical field and the selected map area',()=>{
  const result=readListingSearchLink(url());
  assert.deepEqual(result.values,values());assert.deepEqual(result.bounds,box);
  assert.deepEqual(Object.keys(result.values),FILTER_SCHEMA.required);
  assert.equal(readListingSearchLink('https://witharosa.ai/'),null);
  assert.equal(readListingSearchLink('https://witharosa.ai/chat'),null);
  assert.deepEqual(readListingSearchLink(url().replace('witharosa.ai/?','witharosa.ai/chat?')).values,values(),'the reader knows the link format; the app decides where links are read');
});

test('search links freeze effective costs including zero fractions instead of using the recipient baseline',()=>{
  const v={...defaultFilterValues(),softCostPctOfHard:0,carryAndFinancingPct:0};
  const state=readListingSearchLink(url(v,null));
  assert.deepEqual(Object.fromEntries(COST_KEYS.map(k=>[k,state.values[k]])),{...baseline,condoHardCostPerGrossSqft:null,softCostPctOfHard:0,carryAndFinancingPct:0});
  assert.throws(()=>createListingSearchLink('https://witharosa.ai/',{...snapshot(v),baselineCosts:{}}),/cost/i);
  const citywide=readListingSearchLink(url({...values(),followMap:false},box));assert.equal(citywide.bounds,null);
});

test('invalid, partial, unknown-schema and out-of-range search links fail validation',()=>{
  const raw=JSON.parse(new URL(url()).searchParams.get('search'));
  for(const data of [{...raw,schema:'future/2'},{...raw,values:{...raw.values,borough:'XX'}},{...raw,values:{borough:'BK'}},{...raw,values:{...raw.values,softCostPctOfHard:null}},{...raw,bounds:{...box,north:999}}]){
    const target=new URL('https://witharosa.ai/');target.searchParams.set('search',JSON.stringify(data));assert.throws(()=>readListingSearchLink(target.href));
  }
  assert.throws(()=>readListingSearchLink('https://witharosa.ai/?search=%7B'));
});

test('search links omit source routes, credentials, unrelated query parameters and fragments',()=>{
  const target=new URL(createListingSearchLink('https://person:secret@witharosa.ai/sites/private?token=secret#conversation',snapshot()));
  assert.equal(target.origin,'https://witharosa.ai');assert.equal(target.pathname,'/');assert.equal(target.username,'');assert.equal(target.password,'');assert.equal(target.hash,'');
  assert.deepEqual([...target.searchParams.keys()],['search']);
  const payload=JSON.parse(target.searchParams.get('search'));assert.deepEqual(Object.keys(payload),['schema','values','bounds']);assert.equal(payload.revision,undefined);assert.equal(payload.baselineCosts,undefined);
});

test('opening a shared search applies all fields, costs and bounds before the first page and pin queries',async t=>{
  const f=await mount(t,{searchUrl:url()}),current=f.listings.filterSnapshot();
  assert.deepEqual(current.values,values());assert.deepEqual(current.map.bounds,box);
  const first=f.calls.find(u=>u.pathname.endsWith('/deals'));
  assert.equal(first.searchParams.get('borough'),'BK');assert.equal(first.searchParams.get('maxListPrice'),'2200000');assert.equal(first.searchParams.get('hardCostPerGrossSqft'),'650');assert.equal(first.searchParams.get('softCostPctOfHard'),'0');assert.equal(first.searchParams.get('bounds'),'40.67000,-73.99000,40.72000,-73.94000');
  assert.deepEqual(f.map.restored,[box]);assert.equal(f.map.fits,0);
  assert.equal(f.calls.every(u=>u.pathname==='/api/market-store/deals'||u.pathname==='/api/market-store/deals/pins'),true);
});

test('sharing uses applied values while leaving typed drafts, the current search and saved baselines intact',async t=>{
  const f=await mount(t,{searchUrl:url()}),before=f.listings.filterSnapshot();
  f.root.querySelector('#listing-cost-hardCostPerGrossSqft').value='900';
  f.root.querySelector('#listing-cost-hardCostPerGrossSqft').dispatchEvent(new window.Event('input',{bubbles:true}));
  f.button('Share search').click();
  const input=f.dialog().querySelector('input'),shared=readListingSearchLink(input.value);
  assert.equal(shared.values.hardCostPerGrossSqft,650);assert.deepEqual(shared.values,before.values);assert.equal(shared.condoHardCostPerGrossSqft,650,'the applied condo figure travels beside the values');
  assert.equal(f.root.querySelector('#listing-cost-hardCostPerGrossSqft').value,'900');
  assert.deepEqual(f.listings.filterSnapshot().values,before.values);
  assert.equal(f.calls.some(u=>u.pathname.includes('settings')),false);
});

test('copying a search link reports success or a recoverable failure and the dialog closes',async t=>{
  let copied=[],fail=false;const f=await mount(t,{copyText:async text=>{if(fail)throw Error('Clipboard denied');copied.push(text);}});
  f.button('Share search').click();f.button('Copy link').click();await tick();assert.equal(copied.length,1);assert.ok(readListingSearchLink(copied[0]));assert.match(f.dialog().textContent,/Link copied/);
  fail=true;f.button('Copy link').click();await tick();assert.match(f.dialog().textContent,/Could not copy/);assert.ok(f.dialog().querySelector('input').value);
  f.button('Close search link').click();assert.equal(f.dialog().hasAttribute('open'),false);
});

test('an invalid shared search shows a useful message and keeps default controls and queries',async t=>{
  const f=await mount(t,{searchUrl:'https://witharosa.ai/?search=%7B'});
  assert.deepEqual(f.listings.filterSnapshot().values,{...defaultFilterValues(),...baseline});
  assert.match(f.root.textContent,/search link is invalid/i);
  assert.equal(f.calls.find(u=>u.pathname.endsWith('/deals')).searchParams.get('borough'),null);
});

test('a search link that cannot be built reports why instead of throwing from the click',async t=>{
  const f=await mount(t,{searchUrl:'not a url'});
  const share=f.button('Share search');
  share.disabled=false;share.click();await tick();
  assert.equal(f.dialog(),null,'no dialog without a link');
  assert.match(f.root.querySelector('.listings-receipt').textContent,/invalid url/i);
});

test('a link shared before the MIH filter existed opens with it at its default',()=>{
  const link=new URL(url({...values(),mih:'inside'}));
  assert.equal(readListingSearchLink(link.href).values.mih,'inside');
  const data=JSON.parse(link.searchParams.get('search'));delete data.values.mih;
  link.searchParams.set('search',JSON.stringify(data));
  assert.equal(readListingSearchLink(link.href).values.mih,'');
});

test('links copied on app.witharosa.ai use the main address build.witharosa.ai',()=>{
  assert.equal(linkOrigin('https://app.witharosa.ai'),'https://build.witharosa.ai');
  assert.equal(linkOrigin('https://build.witharosa.ai'),'https://build.witharosa.ai');
  assert.equal(linkOrigin('http://localhost:8787'),'http://localhost:8787');
  assert.equal(new URL(createListingSearchLink('https://app.witharosa.ai/',snapshot())).origin,'https://build.witharosa.ai');
});
