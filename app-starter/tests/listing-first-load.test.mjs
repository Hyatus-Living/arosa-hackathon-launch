import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {createListings} from '../public/listings.js';
import {normalizeDealSettings} from '../../acres-research/market-store.mjs';

const baseline=normalizeDealSettings(),settings={dealSettings:baseline,baselineSettings:baseline,isCustom:false};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Every request stays pending, as on a slow first load: only the order they start in is checked.
async function firstRequests(t,options){
  const {document,window}=parseHTML(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));globalThis.document=document;globalThis.window=window;
  const originalFetch=globalThis.fetch,requests=[];
  globalThis.fetch=target=>{requests.push(new URL(target,'http://local').pathname);return new Promise(()=>{});};
  t.after(()=>{globalThis.fetch=originalFetch;delete globalThis.document;delete globalThis.window;});
  const listings=createListings({root:document.querySelector('#home-listings'),canStart:()=>true,onUnderwrite(){},onAsk(){},loadMap:()=>new Promise(()=>{}),...options});
  listings.show();for(let i=0;i<4;i++)await tick();
  return requests;
}

test('settings from boot start the pins beside the first page, before the map has loaded',async t=>{
  assert.deepEqual(await firstRequests(t,{settings}),['/api/market-store/deals','/api/market-store/deals/pins']);
});

test('without settings from boot the pins wait for the costs the first page reports',async t=>{
  assert.deepEqual(await firstRequests(t,{}),['/api/market-store/deals']);
});
