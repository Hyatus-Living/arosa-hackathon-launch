import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {createListings} from '../public/listings.js';
import {normalizeDealSettings} from '../../acres-research/market-store.mjs';

const baseline=normalizeDealSettings(),settings={dealSettings:baseline,baselineSettings:baseline,isCustom:false};
const row=(id,n)=>({id,address:`${n} Address Street`,bbl:`300966${String(n).padStart(4,'0')}`,borough:'BK',zipCode:'11201',zoningDistrict:'R7A',latitude:40.7,longitude:-73.99,listPrice:1_000_000,lotAreaSqft:2500,existingBldgAreaSqft:2000,maxUapZfa:10000,maxStandardZfa:10000,unusedUapZfa:8000,similarComps:[],flashcardValuation:{dealVerdict:'good_deal',basis:[]}});
const rows=[row('one',1),row('two',2)];
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function setup(t){
  const {document,window}=parseHTML(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));globalThis.document=document;globalThis.window=window;
  Object.defineProperty(document,'activeElement',{value:document.body,writable:true,configurable:true});window.HTMLElement.prototype.focus=function(){document.activeElement=this;};
  const originalFetch=globalThis.fetch,requests=[];
  globalThis.fetch=target=>{const u=new URL(target,'http://local');requests.push(u);
    const body=u.pathname==='/api/market-store/deals'?{deals:rows,total:2,offset:0,limit:20,userSettings:settings}:u.pathname.endsWith('/pins')?{pins:[],total:0}:{deal:row(decodeURIComponent(u.pathname.split('/').pop()),9),userSettings:settings};
    return Promise.resolve({ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>body});};
  t.after(()=>{globalThis.fetch=originalFetch;delete globalThis.document;delete globalThis.window;});
  const root=document.querySelector('#home-listings'),inspected=[];
  const map={setPins(){},setActive(){},setSelected(){},bounds:()=>({south:40.6,west:-74,north:40.8,east:-73.9}),resize(){},setBounds(){}};
  const listings=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},onInspect:id=>inspected.push(id),loadMap:async()=>map});
  listings.show();for(let i=0;i<4;i++)await tick();
  const details=()=>requests.filter(u=>u.pathname.startsWith('/api/market-store/deals/')&&!u.pathname.endsWith('/pins')).map(u=>decodeURIComponent(u.pathname.split('/').pop()));
  const back=()=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Back to results');
  return {root,listings,inspected,details,back};
}

test('the viewer opening and closing a listing is reported so the address can follow',async t=>{
  const f=await setup(t);
  f.root.querySelector('[data-listing="one"] .listing-card-open').click();await tick();await tick();
  assert.deepEqual(f.inspected,['one']);
  f.back().click();
  assert.deepEqual(f.inspected,['one',null]);
  assert.equal(f.root.querySelector('.listings-list').hidden,false);
});

test('an address-driven listing opens and closes without being reported back',async t=>{
  const f=await setup(t);
  f.listings.inspect('broker:ripco:11:for_sale');await tick();await tick();
  assert.deepEqual(f.details(),['broker:ripco:11:for_sale']);
  assert.equal(f.root.querySelector('.listings-inspector').hidden,false);
  f.listings.inspect('broker:ripco:11:for_sale');
  assert.equal(f.details().length,1,'the listing already open is not fetched again');
  f.listings.inspect(null);
  assert.equal(f.root.querySelector('.listings-inspector').hidden,true);
  assert.deepEqual(f.inspected,[]);
});
