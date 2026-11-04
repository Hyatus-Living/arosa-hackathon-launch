import test from 'node:test';
import assert from 'node:assert/strict';
import {comparePrograms,createFeasibilityTools,feasibilityDefinition} from './feasibility.mjs';
import {comparisonFixture} from './fixtures/comparison-ledger.mjs';

function setup(t) {const f=comparisonFixture();t.after(()=>f.close());return f;}
const variants=()=>[{label:'Market rental',productType:'rental'},{label:'Alternative',productType:'rental'}];
const args=(f,changes={})=>({shared:{...f.shared,market:f.market},variants:[variants()[0],{...variants()[1],...changes}]});
const ledgerShared=f=>{const shared={...f.shared,landPriceSource:'ledger',taxSource:'ledger'};delete shared.landPrice;return shared;};

test('comparison affordable fractions cannot invent above-market income through invalid shares or rent ratios',t=>{
  const f=setup(t);
  for(const [key,values] of [['affordableShare',[-.2,1.2,'0.2',NaN,Infinity]],['affordableRentScale',[-.1,-1,'0.4',NaN,Infinity]]]) {
    for(const value of values)assert.throws(()=>comparePrograms(args(f,{affordableShare:.2,affordableRentScale:.4,[key]:value})),new RegExp(`variants\\[1\\].${key}`));
  }
  assert.throws(()=>comparePrograms(args(f,{rentScale:1,affordableShare:-.2})),/variants\[1\].affordableShare/);
});

test('an affordable share on a condo exit is rejected with a clear error, never a silent no-op',t=>{
  const f=setup(t);
  const condo={shared:{...f.shared,market:f.market},variants:[variants()[0],{label:'Affordable condo',productType:'condo',affordableShare:.2,affordableRentScale:.4}]};
  assert.throws(()=>comparePrograms(condo),/variants\[1\]\.affordableShare requires a rental scenario/);
  // The same share on a rental variant still blends restricted rents and lowers profit.
  const market=comparePrograms(args(f)),affordable=comparePrograms(args(f,{affordableShare:.2,affordableRentScale:.4}));
  const alt=r=>r.variants.find(v=>v.label==='Alternative');
  assert.ok(alt(affordable).profit<alt(market).profit);
  // An explicit zero share on a condo is a plain market condo and stays valid.
  assert.ok(comparePrograms({shared:{...f.shared,market:f.market},variants:[{label:'Condo',productType:'condo',affordableShare:0}]}).variants[0].profit!==undefined);
});

test('comparison entitlement scores and approval months enforce their declared ranges without clamping or coercion',t=>{
  const f=setup(t);
  for(const [key,values] of [['entitlementScore',[-1,101,'65',NaN,Infinity]],['timelineMonths',[-1,61,'12',NaN,Infinity]]]) {
    for(const value of values)assert.throws(()=>comparePrograms(args(f,{[key]:value})),new RegExp(`variants\\[1\\].${key}`));
  }
});

test('comparison size overrides cannot silently treat zero or NaN as an omitted override',t=>{
  const f=setup(t);
  for(const grossBuildingSqft of [0,499,20_000_001,'10000',NaN,Infinity])assert.throws(()=>comparePrograms(args(f,{grossBuildingSqft})),/variants\[1\].grossBuildingSqft/);
});

test('comparison rent and sale price multipliers require finite positive numbers',t=>{
  const f=setup(t);
  for(const rentScale of [0,-1,2.01,'1',NaN,Infinity])assert.throws(()=>comparePrograms(args(f,{rentScale})),/variants\[1\].rentScale|variants\[1\] rent scaling/);
  for(const priceScale of [0,-1,'1',NaN,Infinity])assert.throws(()=>comparePrograms(args(f,{priceScale})),/variants\[1\].priceScale/);
});

test('invalid variant preflight performs no ledger reads or capture and leaves comparison capacity for corrected requests',async t=>{
  const f=setup(t),emitted=[],tool=createFeasibilityTools({getMarket:()=>f.market,ledger:f.ledger,record:f.tools.record,emit:(...event)=>emitted.push(event)});
  const shared=ledgerShared(f),base=variants();
  for(const bad of [{...base[1],affordableShare:-.2,affordableRentScale:.4},{...base[1],timelineMonths:120},{...base[1],grossBuildingSqft:0},null]) {
    await assert.rejects(()=>tool.handlers.acres_compare_programs({shared,variants:[...base,bad]}),/variants\[2\]/);
    assert.deepEqual(f.counts,{land:0,taxes:0});assert.equal(f.queries.length,0);assert.equal(f.tools.sources.length,0);
    assert.equal(tool.comparisons.length,0);assert.equal(emitted.length,0);
  }
  for(let i=0;i<3;i++){
    const result=await tool.handlers.acres_compare_programs({shared,variants:base});
    assert.ok(result.variants.every(v=>v.landPriceBasis.estimate===1000000&&v.realEstateTaxes.annualTaxes===20000));
  }
  assert.equal(tool.comparisons.length,3);assert.equal(emitted.length,3);assert.deepEqual(f.counts,{land:3,taxes:3});
  await assert.rejects(()=>tool.handlers.acres_compare_programs({shared,variants:base}),/At most three/);
  assert.deepEqual(f.counts,{land:3,taxes:3});
});

test('comparison schema agrees with runtime bounds and existing valid boundaries and null defaults retain their results',t=>{
  const f=setup(t),schema=feasibilityDefinition.inputSchema.properties.variants.items.properties;
  assert.equal(schema.rentScale.exclusiveMinimum,0);assert.equal(schema.rentScale.maximum,2);assert.equal(schema.priceScale.exclusiveMinimum,0);
  assert.equal(schema.affordableShare.minimum,0);assert.equal(schema.affordableShare.maximum,1);
  assert.equal(schema.affordableRentScale.minimum,0);assert.equal(schema.affordableRentScale.maximum,undefined);
  assert.equal(schema.grossBuildingSqft.minimum,500);assert.equal(schema.grossBuildingSqft.maximum,20_000_000);
  const baseline=comparePrograms(args(f));
  assert.deepEqual(comparePrograms(args(f,{rentScale:null,priceScale:null,affordableShare:null,affordableRentScale:null,entitlementScore:null,timelineMonths:null,grossBuildingSqft:null})),baseline);
  for(const changes of [{affordableShare:0,affordableRentScale:0},{affordableShare:1,affordableRentScale:1},{affordableShare:.2,affordableRentScale:1.2},{affordableShare:.2,affordableRentScale:3},{rentScale:2,priceScale:2},{entitlementScore:0,timelineMonths:0},{entitlementScore:100,timelineMonths:60}]) {
    const result=comparePrograms(args(f,changes));assert.ok(result.variants.every(v=>Number.isFinite(v.profit)&&Number.isFinite(v.rankingProfit)));
  }
});
