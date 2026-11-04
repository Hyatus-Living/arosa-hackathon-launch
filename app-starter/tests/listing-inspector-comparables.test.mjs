import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderInspector} from '../public/listing-inspector.js';
import {poolFixture} from '../../acres-research/testing/comparable-pool.mjs';

function render(t,similarComps){
  const previous={document:globalThis.document,window:globalThis.window};
  const {document,window}=parseHTML('<html><body></body></html>');
  Object.assign(globalThis,{document,window});t.after(()=>Object.assign(globalThis,previous));
  return renderInspector({id:'subject',address:'Synthetic subject',bbl:'3009660001',borough:'BK',maxUapZfa:10000,flashcardValuation:{},similarComps},{canStart:()=>true,onUnderwrite(){},onAsk(){},onClose(){}});
}

test('home inspector suppresses legacy or wrong-kind comparable price claims',t=>{
  const base={address:'Synthetic comparable',listingType:'sold',price:1200000,pricePerBuildableZfa:120,buildableZfa:10000,buildableZfaBasis:'uap_zfa',soldDate:'2026-10-01'};
  const comps=[undefined,'asking_price','toString','__proto__'].map(priceBasis=>({...base,priceBasis}));
  const rows=[...render(t,comps).querySelectorAll('.inspector-comps li')];
  for(const row of rows){assert.match(row.textContent,/Price source unavailable/);assert.doesNotMatch(row.textContent,/\$|\/BSF|2026-10-01/);}
});

test('home inspector keeps a supported price separate from unsupported buildable capacity',t=>{
  const base={address:'Synthetic comparable',listingType:'sold',priceBasis:'reported_sale',price:1200000,pricePerBuildableZfa:120,buildableZfa:10000,soldDate:'2026-10-01'};
  const rows=[...render(t,[undefined,'future_basis','toString','__proto__'].map(buildableZfaBasis=>({...base,buildableZfaBasis}))).querySelectorAll('.inspector-comps li')];
  for(const row of rows){assert.match(row.textContent,/\$1\.20M/);assert.match(row.textContent,/Buildable area unavailable/);assert.doesNotMatch(row.textContent,/\/BSF/);}
});

test('home inspector never renders an invalid sale date or substitutes the listing date',t=>{
  const base={address:'Synthetic comparable',listingType:'sold',priceBasis:'reported_sale',price:1200000,buildableZfa:10000,buildableZfaBasis:'uap_zfa',pricePerBuildableZfa:120,listingDate:'2026-08-01'};
  const rows=[...render(t,['2026-99-99','2026-02-30',null,'2026-01-01T00:00:00Z'].map(soldDate=>({...base,soldDate}))).querySelectorAll('.inspector-comps li')];
  for(const row of rows.slice(0,3)){assert.match(row.textContent,/Sale date unavailable/);assert.doesNotMatch(row.textContent,/2026-99-99|2026-02-30|2026-08-01/);}
  assert.match(rows[3].textContent,/Sold 2026-01-01/);
});

test('actual current comparable payloads retain their price, capacity basis and match evidence',t=>{
  const f=poolFixture(t),comps=f.store.getSimilarCompsForDeal(f.subject()),before=JSON.stringify(comps);
  assert.equal(comps[0].priceBasis,'reported_sale');assert.equal(comps[1].priceBasis,'asking_price');
  assert.equal(comps[0].buildableZfaBasis,'uap_zfa');assert.ok(comps[0].buildableZfa>0);
  const rows=[...render(t,comps).querySelectorAll('.inspector-comps li')];
  assert.match(rows[0].textContent,/Sold 2026-10-02/);assert.match(rows[0].textContent,/\$110\/BSF/);assert.match(rows[1].textContent,/\$120\/BSF/);
  for(let i=0;i<comps.length;i++){assert.match(rows[i].textContent,/UAP ZFA estimate/);for(const reason of comps[i].similarityReasons)assert.ok(rows[i].textContent.includes(reason));}
  assert.equal(JSON.stringify(comps),before);
});
