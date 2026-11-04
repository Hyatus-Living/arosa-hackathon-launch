import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {comparableFixture} from '../../acres-research/testing/comparable-capacity.mjs';
import {mountDealsScreen} from '../public/deals.js';

async function inspector(t,fixture,comps=fixture.comps()) {
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const original={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  Object.assign(globalThis,{document,window});
  const row=fixture.subject();
  globalThis.fetch=async()=>new Response(JSON.stringify({deals:[{id:row.id,address:row.address,zipCode:'11201',borough:'Brooklyn',lotAreaSqft:2500,maxUapZfa:10000,unusedUapZfa:8000,listPrice:2_000_000,similarComps:comps}],total:1,userSettings:{dealSettings:{},baselineSettings:{},isCustom:false}}),{headers:{'content-type':'application/json'}});
  t.after(()=>Object.assign(globalThis,original));
  await mountDealsScreen(document.querySelector('main'),{onUnderwrite:()=>{}});
  return document;
}

test('the inspector keeps unavailable comparable capacity separate from existing-area pricing',async t=>{
  const f=comparableFixture(t),document=await inspector(t,f);
  const row=document.querySelector('.deals-comp-row');assert.ok(row);
  assert.match(row.textContent,/\$2\.00M/);
  assert.match(row.textContent,/\$1,000\/exist SF/);
  assert.match(row.textContent,/Buildable area unavailable/);assert.match(row.textContent,/Zoning unavailable/);
  assert.doesNotMatch(row.textContent,/\/BSF|\/unit|\/est\. unit|% Match/);
  assert.match(row.textContent,/Match score \d+\/100/);
});

test('the inspector labels supported comparable ZFA and allowed-unit denominators',async t=>{
  const f=comparableFixture(t);
  f.set(f.compId,{zoning_district:'R6',resid_far:2,pluto_lot_area:900});
  const document=await inspector(t,f),row=document.querySelector('.deals-comp-row');assert.ok(row);
  assert.match(row.textContent,/\$1,111\/BSF/);assert.match(row.textContent,/\$1,000,000\/allowed unit/);
  assert.match(row.textContent,/Lot × residential FAR estimate/);
  assert.match(row.textContent,/Most units zoning allows, 680 SF a unit/);
  assert.doesNotMatch(row.textContent,/Buildable area unavailable|Zoning unavailable/);
});

test('legacy or unknown capacity provenance cannot revive a comparable buildable-price claim',async t=>{
  const f=comparableFixture(t),comp=f.comp();
  const comps=[undefined,'future_basis','toString','__proto__'].map((basis,i)=>({...comp,id:`legacy-${i}`,buildableZfa:10000,pricePerBuildableZfa:200,pricePerBuildableUnit:133333,buildableZfaBasis:basis}));
  const document=await inspector(t,f,comps),rows=[...document.querySelectorAll('.deals-comp-row')];
  assert.equal(rows.length,4);
  for(const row of rows){assert.match(row.textContent,/Buildable area unavailable/);assert.doesNotMatch(row.textContent,/\/BSF|\/est\. unit|native code|function|\[object/);}
});
