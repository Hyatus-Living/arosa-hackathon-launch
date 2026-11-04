import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {recommendUnitMix,createMarketTools,BASELINES} from './market.mjs';
import {DEAL_UNIT_MIX,DEFAULT_NYC_DEV_SETTINGS,mostUnitsAllowed} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {buildUnderwritingDeck,renderDeckHtml} from './deliverable.mjs';

const available = result => result.residentialGrossSqft * result.efficiency;
function fits(result) {
  assert.ok(result.allocatedNetSqft <= available(result), `${result.allocatedNetSqft} allocated exceeds ${available(result)} available`);
  assert.equal(result.byBedrooms.reduce((sum,row)=>sum+row.units,0),result.units);
  assert.equal(result.byBedrooms.reduce((sum,row)=>sum+row.netSqft,0),result.allocatedNetSqft);
  assert.ok(result.unallocatedNetSqft >= 0);
  assert.ok(result.byBedrooms.every(row=>Number.isInteger(row.units)&&row.units>=0));
}
const custom = {productType:'condo',residentialGrossSqft:5000,efficiency:1,mixPercent:[0,49,51,0],unitSizesSqft:[500,500,2500,3000]};

test('a rental program cannot spend more net area than its whole-unit allocation has available',()=>{
  // 9,600 × 0.85 = 8,160 net over 582.5 a unit = 14; 4/6/4 needs 8,300, so 13 units at 4/6/3 = 7,500.
  const result=recommendUnitMix({productType:'rental',residentialGrossSqft:9600});fits(result);
  assert.equal(result.units,13);assert.deepEqual(result.byBedrooms.map(row=>row.units),[4,6,3,0]);
  assert.equal(result.allocatedNetSqft,7500);assert.equal(result.unallocatedNetSqft,660);
  assert.ok(result.assumptions.some(note=>/14 to 13 units/.test(note)));
});

test('small parcels receive a fitting whole-unit program rather than negative remaining area',()=>{
  // 1,800 × 0.85 = 1,530 net: two units, a studio and a one-bedroom, 1,000 sq ft.
  const result=recommendUnitMix({productType:'rental',residentialGrossSqft:1800});fits(result);
  assert.equal(result.units,2);assert.deepEqual(result.byBedrooms.map(row=>row.units),[1,1,0,0]);
  assert.equal(result.allocatedNetSqft,1000);assert.equal(result.unallocatedNetSqft,530);
});

test('custom condo target shares and sizes remain intact when the rounded program must shrink',()=>{
  const result=recommendUnitMix(custom);fits(result);
  assert.equal(result.units,2);assert.deepEqual(result.byBedrooms.map(row=>row.units),[0,1,1,0]);
  assert.equal(result.allocatedNetSqft,3000);
  assert.deepEqual(result.byBedrooms.map(row=>row.unitSqft),custom.unitSizesSqft);
  assert.deepEqual(result.byBedrooms.map(row=>row.mixPercent),custom.mixPercent);
});

test('a tolerated 99.5 percent target is normalized consistently for sizing and allocation',()=>{
  const result=recommendUnitMix({productType:'rental',residentialGrossSqft:9950,efficiency:1,mixPercent:[0,0,0,99.5],unitSizesSqft:[250,500,750,1000]});fits(result);
  assert.equal(result.averageUnitSqft,1000);assert.equal(result.units,9);
  assert.ok(result.assumptions.some(note=>/99\.5%/.test(note)&&/100%/.test(note)));
});

test('a tolerated 100.5 percent target does not artificially discard a fitting unit',()=>{
  const result=recommendUnitMix({productType:'rental',residentialGrossSqft:10000,efficiency:1,mixPercent:[0,0,.5,100],unitSizesSqft:[250,500,1000,1000]});fits(result);
  assert.equal(result.averageUnitSqft,1000);assert.equal(result.units,10);assert.equal(result.unallocatedNetSqft,0);
});

test('an impossible target allocation fails without replacing the last valid tool program',async()=>{
  const emitted=[],tools=createMarketTools({emit:(event,data)=>emitted.push({event,data})});
  await tools.handlers.acres_unit_mix({productType:'rental',residentialGrossSqft:100000});
  const prior=tools.program,events=emitted.length;
  await assert.rejects(tools.handlers.acres_unit_mix({productType:'rental',residentialGrossSqft:3000,efficiency:1,mixPercent:[49,0,0,51],unitSizesSqft:[250,500,750,5000]}),/target mix|whole-unit allocation/);
  assert.equal(tools.program,prior);assert.equal(emitted.length,events);
});

test('fractional net area is not rounded upward to admit an apartment that does not fit',()=>{
  const result=recommendUnitMix({productType:'rental',residentialGrossSqft:1499.8,efficiency:.5,mixPercent:[100,0,0,0],unitSizesSqft:[250,500,750,1000]});fits(result);
  assert.equal(result.netResidentialSqft,749.9);assert.equal(result.units,2);
  assert.throws(()=>recommendUnitMix({productType:'rental',residentialGrossSqft:999.8,efficiency:.5,mixPercent:[100,0,0,0],unitSizesSqft:[500,750,1000,1250]}),/smaller than one unit|whole-unit allocation/);
});

test('whole-unit area and count invariants hold across rental and condo floor-area boundaries',()=>{
  for(const productType of ['rental','condo'])for(let residentialGrossSqft=1800;residentialGrossSqft<50000;residentialGrossSqft+=137){
    const args={productType,residentialGrossSqft},result=recommendUnitMix(args);fits(result);
    assert.deepEqual(recommendUnitMix(args),result);
  }
});

test('market tool output and emitted state price only the apartments that fit',async()=>{
  const emitted=[],tools=createMarketTools({emit:(event,data)=>emitted.push({event,data})});
  await tools.handlers.acres_market_inputs({submarket:'Synthetic allocation scenario',rents:[0,1,2,3].map(bedrooms=>({bedrooms,rentPerSqftPerMonth:8,source:'User scenario',retrievedAt:'2026-10-17'}))});
  // 10,000 × 0.85 = 8,500 net: 14 units at 4/6/4 = 8,300 sq ft × $8 × 12.
  const result=await tools.handlers.acres_unit_mix({productType:'rental',residentialGrossSqft:10000});fits(result);
  assert.equal(result.annualGrossPotentialRent,796800);assert.equal(tools.program.units,14);
  assert.equal(emitted.find(row=>row.event==='unitmix.computed').data.annualGrossPotentialRent,796800);
  assert.match(result.note,/200 net sq ft is left over/);
});

test('saved project and actual deck HTTP responses retain the fitting area budget and its explanation',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-unit-budget-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24);
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'fixture'},store,maps:null});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true});});
  const tools=createMarketTools();await tools.handlers.acres_unit_mix({productType:'rental',residentialGrossSqft:9600});
  const conversation=store.createConversation(owner),run=store.createRun(owner,conversation.id,'Program the residential area');
  store.begin(run);store.finish(run,'completed',{answer:'Residential program',program:tools.program,sources:[]});
  const saved=store.projectState(owner,conversation.id).program.value;fits(saved);
  const url=`http://127.0.0.1:${server.address().port}/conversations/${conversation.id}/deck`,headers={authorization:'Bearer fixture','x-acres-account':owner};
  const response=await fetch(url,{headers});assert.equal(response.status,200);const deck=await response.json();
  const program=deck.slides.find(slide=>slide.id==='market-and-unit-mix').program;
  assert.equal(program.allocatedNetSqft,7500);assert.equal(program.unallocatedNetSqft,660);assert.deepEqual(program.assumptions,saved.assumptions);
  const html=await fetch(url+'?format=html',{headers});assert.equal(html.status,200);
  const document=parseHTML(await html.text()).document,section=document.querySelector('#market-and-unit-mix');
  assert.match(section.textContent,/Allocated net residential area/);assert.match(section.textContent,/Unallocated net residential area/);
  assert.match(section.textContent,/14 to 13 units/);assert.match(section.textContent,/Target mix/);
});

test('an already fitting baseline retains its established unit mix, area and pricing',()=>{
  const result=recommendUnitMix({productType:'rental',residentialGrossSqft:100000});fits(result);
  assert.equal(result.units,145);assert.deepEqual(result.byBedrooms.map(row=>row.units),[44,65,36,0]);
  assert.equal(result.allocatedNetSqft,84350);assert.equal(result.unallocatedNetSqft,650);
  assert.ok(result.assumptions.every(note=>!/reduced/.test(note)));
});

test('a saved over-budget program warns in the report while preserving its historical counts and figures',()=>{
  const program={productType:'rental',residentialGrossSqft:10000,efficiency:.82,netResidentialSqft:8200,allocatedNetSqft:8250,unallocatedNetSqft:-50,units:11,annualGrossPotentialRent:792000,byBedrooms:[],assumptions:[]};
  const original=structuredClone(program),deck=buildUnderwritingDeck({projectState:{program:{value:program,updated:1,provenance:{sources:[]}}}});
  const document=parseHTML(renderDeckHtml(deck)).document,section=document.querySelector('#market-and-unit-mix');
  assert.match(section.textContent,/saved apartment allocation exceeds the recorded net residential area/);
  assert.match(section.textContent,/Recompute the unit mix before using these figures/);
  assert.equal(deck.slides.find(slide=>slide.id==='market-and-unit-mix').program.units,11);
  assert.equal(deck.slides.find(slide=>slide.id==='market-and-unit-mix').program.annualGrossPotentialRent,792000);
  assert.deepEqual(program,original);
});

test('the unit mix baseline is the deal screen assumed mix and efficiency, so both count the same units',()=>{
  for(const exit of ['rental','condo']){
    const types=['studio','oneBedroom','twoBedroom','threeBedroom'],screen=DEAL_UNIT_MIX[exit];
    assert.deepEqual(BASELINES[exit].mixPercent,types.map(type=>Math.round((screen.find(u=>u.type===type)?.share??0)*100)));
    assert.deepEqual(BASELINES[exit].unitSizesSqft,types.map(type=>screen.find(u=>u.type===type)?.netSqft??null));
    assert.equal(BASELINES[exit].efficiency,DEFAULT_NYC_DEV_SETTINGS.zfaToNetEfficiency);
  }
  // The screen's rental count for 20,000 sq ft: min(most units allowed 29, floor(20,000 × 0.85 / 583) = 29).
  const zfa=20000,screenUnits=Math.min(mostUnitsAllowed(zfa),Math.floor(zfa*DEFAULT_NYC_DEV_SETTINGS.zfaToNetEfficiency/583));
  assert.equal(screenUnits,29);
  assert.equal(recommendUnitMix({productType:'rental',residentialGrossSqft:zfa,maxDwellingUnits:mostUnitsAllowed(zfa)}).units,screenUnits);
});

test('the unit count is capped at the legal density supplied, and says so when no density was supplied',()=>{
  // 20,000 × 0.85 = 17,000 net fits 29 units; the zoning allows 20.
  const capped=recommendUnitMix({productType:'rental',residentialGrossSqft:20000,maxDwellingUnits:20});fits(capped);
  assert.equal(capped.units,20);assert.equal(capped.maxDwellingUnits,20);assert.deepEqual(capped.byBedrooms.map(row=>row.units),[6,9,5,0]);
  assert.ok(capped.assumptions.some(note=>/Capped at 20 dwelling units, the legal density supplied; 29 would fit/.test(note)));
  assert.ok(capped.assumptions.every(note=>!/Legal density was not checked/.test(note)));
  const open=recommendUnitMix({productType:'rental',residentialGrossSqft:20000});
  assert.equal(open.units,29);assert.equal(open.maxDwellingUnits,null);
  assert.ok(open.assumptions.some(note=>/Legal density was not checked/.test(note)));
  assert.throws(()=>recommendUnitMix({productType:'rental',residentialGrossSqft:20000,maxDwellingUnits:2.5}),/maxDwellingUnits must be a whole number/);
  assert.throws(()=>recommendUnitMix({productType:'rental',residentialGrossSqft:20000,mixPercent:[25,25,25,25]}),/rental planning baseline has no three bedroom size/);
});

test('a unit mix that deducts no core or circulation says so in its assumptions',()=>{
  const flagged=recommendUnitMix({productType:'rental',residentialGrossSqft:10000,efficiency:1});
  assert.ok(flagged.assumptions.some(note=>/efficiency 1 is above 0\.9: no core or circulation is deducted/.test(note)));
  for(const efficiency of [undefined,0.9,0.85])
    assert.ok(!recommendUnitMix({productType:'rental',residentialGrossSqft:10000,efficiency}).assumptions.some(note=>/no core or circulation/.test(note)),String(efficiency));
});

test('the unit mix deducts the deal screen\'s floorplate core from the storeys, and flags when it cannot', async () => {
  const {computeDealValuation} = await import('./market-store.mjs');
  // A 25 ft R7A lot: seven storeys of about 1,430 SF, each losing a 400 SF elevator core.
  const v = computeDealValuation({listPrice: 1_000_000, lotArea: 2500, lotFront: 25, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 4.0, affResFar: 5.01, zoningDistrict: 'R7A', address: '2 EXAMPLE AVENUE', borough: 'BK', zipCode: '11216'});
  const cored = recommendUnitMix({productType: 'rental', residentialGrossSqft: v.buildableZfa, storeys: v.valueDriver.storeys});
  assert.equal(Number(cored.efficiency.toFixed(3)), v.valueDriver.netEfficiency);
  assert.ok(cored.assumptions.some(a => /400 SF stair and elevator core on each of 7 floors/.test(a)));
  const plain = recommendUnitMix({productType: 'rental', residentialGrossSqft: v.buildableZfa});
  assert.equal(plain.efficiency, BASELINES.rental.efficiency);
  assert.ok(plain.assumptions.some(a => /No floorplate core was deducted/.test(a)));
});

test('the unit mix uses the deal screen\'s measured unit sizes for the site\'s area', async () => {
  const {measureUnitSizes} = await import('./market-store.mjs');
  const sizes = {0: 500, 1: 650, 2: 900}, rows = [];
  for (const [beds, n] of Object.entries({0: 9, 1: 13, 2: 8})) for (let i = 0; i < n; i++) rows.push({id: `r${beds}${i}`, property_id: `r${beds}${i}`, listing_type: 'for_rent', zip_code: '11216', borough: 'BK', neighborhood: null, beds: Number(beds), sqft: sizes[beds] + (i % 3) * 10 - 10});
  const table = new Map(measureUnitSizes(rows, '2026-10-21').map(x => [`${x.exit}|${x.scope}`, x]));
  const tools = createMarketTools({getProperty: () => ({zipcode: '11216', borough: 'BK'}), marketStore: {getUnitSizes: () => table}});
  const measured = await tools.handlers.acres_unit_mix({productType: 'rental', residentialGrossSqft: 20_000, efficiency: 0.8});
  assert.deepEqual(measured.byBedrooms.map(r => r.unitSqft), [500, 650, 900, null]);
  assert.ok(measured.assumptions.some(a => /measured ZIP 11216 rentals, median \d+ SF \(30 listings\)/.test(a)));
  assert.ok(!measured.assumptions.some(a => /planning baseline, the sizes the deal screen assumes\./.test(a)));
  // Without a site the baseline stands, as the screen's assumed mix.
  const away = createMarketTools({getProperty: () => null, marketStore: {getUnitSizes: () => table}});
  const assumed = await away.handlers.acres_unit_mix({productType: 'rental', residentialGrossSqft: 20_000, efficiency: 0.8});
  assert.deepEqual(assumed.byBedrooms.map(r => r.unitSqft), BASELINES.rental.unitSizesSqft);
});
