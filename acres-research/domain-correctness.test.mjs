import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchTools} from './tools.mjs';
import {createMarketTools,deriveVelocityMix} from './market.mjs';
import {createProFormaTools,sensitivity} from './proforma.mjs';
import {aggregate} from './research.mjs';
import {comparePrograms} from './feasibility.mjs';
import {auditFloorplan} from './floorplan-audit.mjs';

const date='2026-10-18';
const market={submarket:'Controlled',rents:[{bedrooms:1,rentPerSqftPerMonth:4,source:'Captured rent survey',retrievedAt:date,url:'https://example.com/rents'}]};
const args={name:'Ten homes',productType:'rental',program:{grossBuildingSqft:10000,units:[{bedrooms:1,count:10,netSqft:700}]},landPrice:1000000,hardCostPerSqft:200,softCostPerSqft:50,financing:{loanToCost:.6,interestRate:.08,termMonths:24},operating:{residentialVacancyRate:.05,residentialOpexPerUnitPerYear:10000,commercialVacancyRate:.1,commercialOpexPerSqftPerYear:0},capRate:.05};

test('persisted market evidence remaps into a new citation pool and preserves its capture date and exact text',async()=>{
  const first=createResearchTools({});
  const capture=first.record({title:'Rent survey',url:market.rents[0].url,text:'Measured rent is $4 per square foot per month.',kind:'research',fetchedAt:'2026-10-01T10:00:00Z'});
  const a=createMarketTools({record:first.record});await a.handlers.acres_market_inputs(market);
  await a.handlers.acres_unit_mix({productType:'rental',residentialGrossSqft:10000});
  const second=createResearchTools({});second.record({title:'Parcel',url:'https://example.com/parcel',text:'An unrelated parcel record',kind:'parcel'});
  second.record({title:'New survey text',url:capture.url,text:'The new survey says eight dollars.',kind:'research',fetchedAt:'2026-10-18T10:00:00Z'});
  second.record({...capture,id:undefined,fetchedAt:'2026-10-18T10:00:00Z'});
  const b=createMarketTools({record:second.record,initialMarket:JSON.parse(JSON.stringify(a.market)),initialProgram:a.program});
  const row=b.effectiveMarket.rents[0],source=second.sources.find(s=>s.id===row.sourceId);
  assert.notEqual(row.sourceId,capture.id);assert.equal(source.url,capture.url);assert.equal(source.text,capture.text);assert.equal(source.fetchedAt,capture.fetchedAt);
  assert.equal(b.effectiveProgram.byBedrooms.find(r=>r.bedrooms===1).sourceId,row.sourceId);
  const pf=await createProFormaTools({getMarket:()=>b.effectiveMarket}).handlers.acres_pro_forma(args);
  assert.ok(pf.sources.some(s=>s.sourceId===row.sourceId));assert.equal(second.sources[0].kind,'parcel');
  const partial=await b.handlers.acres_market_inputs({submarket:market.submarket,absorption:{unitsPerMonth:2,source:'User',retrievedAt:date}});
  assert.equal(partial.rents[0].sourceId,row.sourceId);assert.ok(b.market.evidenceSources[row.sourceKey]);assert.equal(partial.evidenceSources,undefined);
});

test('legacy evidence without a snapshot loses its old pool index; model inputs cannot inject a trusted snapshot',async()=>{
  const tools=createResearchTools({});tools.record({title:'Other',url:'https://example.com/other',text:'Unrelated',kind:'research'});
  const restored=createMarketTools({record:tools.record,initialMarket:{...market,rents:[{...market.rents[0],sourceId:1}]},initialProgram:{byBedrooms:[{bedrooms:1,sourceId:1}]}});
  assert.equal(restored.effectiveMarket.rents[0].sourceId,null);assert.equal(restored.effectiveProgram.byBedrooms[0].sourceId,null);
  const untrusted=await restored.handlers.acres_market_inputs({...market,evidenceSources:{fake:{url:market.rents[0].url,text:'Fabricated',kind:'official_record'}}});
  assert.equal(untrusted.rents[0].sourceId,null);assert.equal(tools.sources.length,1);
});

test('aggregation cannot substitute the final program into independently calculated scenarios',async()=>{
  const pfTools=createProFormaTools({getMarket:()=>market});
  const a=await pfTools.handlers.acres_pro_forma({...args,sensitivity:{rent:[-.2,.2]}});
  const b=await pfTools.handlers.acres_pro_forma({...args,name:'Five homes',program:{...args.program,units:[{bedrooms:1,count:5,netSqft:700}]}});
  const result=aggregate([{tools:{},aux:{marketTools:{market,program:{productType:'rental',residentialGrossSqft:10000,byBedrooms:[{bedrooms:1,units:5,unitSqft:700}]}},proFormaTools:pfTools}}]);
  assert.deepEqual(result.proFormas,pfTools.proFormas);assert.equal(result.proFormas[0].returns.profit,a.returns.profit);assert.equal(result.proFormas[1].returns.profit,b.returns.profit);
  assert.equal(result.proFormas[0].inputs.program.units[0].count,10);assert.equal(result.proFormas[1].inputs.program.units[0].count,5);assert.deepEqual(result.proFormas[0].sensitivitySteps,{rent:[-.2,.2]});
});

test('missing floorplan measurements stay unknown, partial losses reconcile, and depth screens never claim code approval',()=>{
  const unknown=auditFloorplan({grossFloorAreaSqft:10000});
  assert.equal(unknown.summaryMetrics.currentNetAreaSqft,null);assert.equal(unknown.codeAndLivabilityAudit.deadEndStatus,'NOT_SUPPLIED');
  assert.equal(unknown.proFormaValueUplift.rentalScenario.capitalizedAssetValueUpliftUsd,null);
  const partial=auditFloorplan({grossFloorAreaSqft:10000,netRentableOrSellableSqft:9000,corridorCirculationSqft:400,coreToWindowDepthFeet:31});
  assert.equal(partial.lossFactorBreakdown.unallocatedLossSqft,600);assert.equal(partial.lossFactorBreakdown.elevatorStairCoreSqft,null);assert.equal(partial.codeAndLivabilityAudit.habitableDepthStatus,'WARNING_DEEP_FLOORPLATE');
  assert.throws(()=>auditFloorplan({grossFloorAreaSqft:10000,netRentableOrSellableSqft:9000,corridorCirculationSqft:1400}),/loss/i);
  const measured=auditFloorplan({grossFloorAreaSqft:10000,deadEndCorridorFeet:31,sprinklered:false});
  assert.equal(measured.codeAndLivabilityAudit.deadEndStatus,'EXCEEDS_SCREENING_THRESHOLD');
});

test('invalid sensitivity axes reject before ledger reads and every allowed result is finite',async()=>{
  let reads=0;const tools=createProFormaTools({getMarket:()=>market,ledger:{landEstimate(){reads++;throw Error('unexpected');}}});
  for(const steps of [{capRateBps:[-500]},{cost:[-2]},{rent:[-1.01]},{entitlement:[0]},{rent:[Infinity]}]){
    assert.throws(()=>sensitivity(args,market,steps),/sensitivity|cap rate|capitalization|finite/i);
    await assert.rejects(tools.handlers.acres_pro_forma({...args,landPriceSource:'ledger',sensitivity:steps}),/sensitivity|cap rate|capitalization|finite/i);
  }
  assert.equal(reads,0);assert.equal(tools.proFormas.length,0);
  const out=sensitivity(args,market,{rent:[-1,0],cost:[-1,0],capRateBps:[-499],entitlement:[.5,1]});
  const numbers=value=>{if(typeof value==='number')assert.ok(Number.isFinite(value));else if(value&&typeof value==='object')Object.values(value).forEach(numbers);};numbers(out);
});

test('approval carry reverses the winner, scores do not multiply dollars, and financed months are not counted twice',()=>{
  const out=comparePrograms({shared:{...args,market},variants:[{label:'Quick',productType:'rental',timelineMonths:0,entitlementScore:0},{label:'Delayed',productType:'rental',timelineMonths:60,entitlementScore:100,rentScale:1.03}]});
  const quick=out.variants.find(v=>v.label==='Quick'),delayed=out.variants.find(v=>v.label==='Delayed');
  assert.ok(delayed.profit>quick.profit);assert.ok(delayed.profitAfterCarry<quick.profitAfterCarry);assert.equal(out.recommendation.label,'Quick');
  assert.equal(delayed.entitlementCarryCost,240000);assert.equal(quick.rankingProfit,quick.profit);assert.equal(delayed.totalDevelopmentCostAfterCarry,delayed.totalDevelopmentCost+240000);
  const covered=comparePrograms({shared:{...args,market},variants:[{label:'Covered',productType:'rental',timelineMonths:24,approvalMonthsIncludedInFinancing:24},{label:'Missing',productType:'rental'}]});
  assert.equal(covered.variants.find(v=>v.label==='Covered').entitlementCarryCost,0);assert.deepEqual(covered.unpricedApprovalTiming,['Missing']);
});

test('asking stock and listing age cannot masquerade as sales or rental absorption',async()=>{
  const buckets={'0':{saleSampleCount:100,closedSoldCount:1,medianSaleDaysOnMls:1},'1':{saleSampleCount:10,closedSoldCount:10,medianSaleDaysOnMls:100}};
  assert.deepEqual(deriveVelocityMix(buckets,'sale'),[9,91,0,0]);assert.equal(deriveVelocityMix(buckets,'rent'),null);
  const tools=createMarketTools({compRunner:async()=>({location:'10001',totalComps:110,byBedrooms:{'1':{...buckets['1'],medianSalePricePerSqft:5000,condoCoopClosedSoldPriceSampleCount:1,medianCondoCoopClosedSoldPricePerSqft:900}},sampleComps:[]})});
  const out=await tools.handlers.acres_market_comps({location:'10001'});assert.equal(out.autoRecordedMarket,false);assert.equal(tools.market,null);assert.equal(out.recommendedRentalMixByVelocity,null);
});
