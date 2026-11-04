import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {priceFixture} from '../../acres-research/testing/comparable-price.mjs';
import {mountDealsScreen} from '../public/deals.js';

async function screen(t,f,comps=f.comps()){
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const original={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};Object.assign(globalThis,{document,window});
  globalThis.fetch=async()=>{const payload=f.payload();payload.deals[0].similarComps=comps;return new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}});};
  t.after(()=>Object.assign(globalThis,original));
  await mountDealsScreen(document.querySelector('main'),{onUnderwrite:()=>{}});
  return [...document.querySelectorAll('.deals-comp-row')];
}

test('comparable rows distinguish asking and reported-sale prices and date kinds',async t=>{
  const f=priceFixture(t),asking=f.add('asking',{soldPrice:1_000_000,pricePerSqft:500}),sale=f.add('sale',{listingType:'sold',soldPrice:2_000_000,listDate:'2026-08-01',soldDate:'2026-09-10'});
  const comps=f.comps(),rows=await screen(t,f);
  const askingText=rows[comps.findIndex(c=>c.id===asking)].textContent,saleText=rows[comps.findIndex(c=>c.id===sale)].textContent;
  assert.match(askingText,/ASKING PRICE/);assert.match(askingText,/\$300\/BSF/);assert.match(askingText,/\$1,500\/exist SF/);assert.match(askingText,/Listed: 2026-10-17/);
  assert.match(saleText,/REPORTED SALE/);assert.match(saleText,/\$200\/BSF/);assert.match(saleText,/\$1,000\/exist SF/);assert.match(saleText,/Reported sale: 2026-09-10/);
  assert.doesNotMatch(askingText,/ACTIVE|Reported sale:/);assert.doesNotMatch(saleText,/Listed: 2026-08-01/);
});

test('comparable calendar dates do not shift and missing/invalid sale dates cannot borrow a listing date',async t=>{
  const f=priceFixture(t);f.add('sale',{listingType:'sold',soldPrice:2_000_000});
  const base=f.comps()[0];
  const comps=['2026-01-01','2026-01-01T00:00:00Z',null,'2026-02-30','invalid'].map((soldDate,i)=>({...base,id:`date-${i}`,soldDate,listingDate:'2026-08-01'}));
  const rows=await screen(t,f,comps);
  for(const row of rows.slice(0,2)){assert.match(row.textContent,/Reported sale: 2026-01-01/);assert.doesNotMatch(row.textContent,/2025-12-31/);}
  for(const row of rows.slice(2)){assert.match(row.textContent,/Sale date unavailable/);assert.doesNotMatch(row.textContent,/2026-08-01|2026-02-30|invalid/);}
});

test('a legacy or unknown price basis cannot display normalized prices as trustworthy comparable evidence',async t=>{
  const f=priceFixture(t);f.add('asking');const base=f.comps()[0];
  const comps=[undefined,'future_basis','toString','__proto__','reported_sale'].map((priceBasis,i)=>({...base,id:`legacy-${i}`,priceBasis}));
  const rows=await screen(t,f,comps);assert.equal(rows.length,5);
  for(const row of rows){assert.match(row.textContent,/Price source unavailable/);assert.match(row.textContent,/UNVERIFIED PRICE/);assert.doesNotMatch(row.textContent,/\$|\/BSF|\/est\. unit|\/exist SF|native code|function|\[object/);}
});
