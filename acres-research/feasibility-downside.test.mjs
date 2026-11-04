import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {comparePrograms,createFeasibilityTools} from './feasibility.mjs';
import {buildUnderwritingDeck,renderDeckHtml} from './deliverable.mjs';

const shared={
  market:{submarket:'Hypothetical fixture',rents:[{bedrooms:1,rentPerSqftPerMonth:8,source:'User',retrievedAt:'2026-10-17'}],salePrices:[{bedrooms:1,pricePerSqft:1200,source:'User',retrievedAt:'2026-10-17'}]},
  program:{grossBuildingSqft:20000,units:[{bedrooms:1,count:20,netSqft:700}]},
  landPrice:2000000,hardCostPerSqft:200,softCostPerSqft:50,
  financing:{loanToCost:.6,interestRate:.08,termMonths:24},
  operating:{residentialVacancyRate:.05,residentialOpexPerUnitPerYear:10000,commercialVacancyRate:.1,commercialOpexPerSqftPerYear:0},capRate:.05,sellingCostRate:.06,
};
const variants=scores=>scores.map((score,index)=>({label:`Program ${'ABC'[index]}`,productType:'rental',...(score===null?{}:{entitlementScore:score})}));
const compare=(scores=[80,20],changes={})=>comparePrograms({shared:{...shared,...changes},variants:variants(scores)});
const reversals=comparison=>comparison.recommendation.whatWouldChangeIt.filter(line=>/ranking flips|then leads/.test(line));
const field=value=>({value,updated:1,provenance:{sources:[]}});
const {document}=parseHTML('<html><head></head><body></body></html>');globalThis.document=document;
const {renderParcel}=await import('../app-starter/public/core-view.js');
const core=comparison=>renderParcel({id:'fixture',title:'Hypothetical site',version:1,fields:{comparisons:field([comparison])}},{canSend:false,canEdit:false});
const report=comparison=>parseHTML(renderDeckHtml(buildUnderwritingDeck({projectState:{comparisons:field([comparison])}}))).document;

test('ordinal score differences do not change dollar profits or downside reversals',()=>{
  const result=compare(),[winner,runner]=result.variants;
  assert.equal(winner.profit,14104000);assert.equal(winner.downsideRentMinus10Profit,11550400);
  assert.equal(winner.rankingProfit,14104000);assert.equal(winner.downsideProfitAfterCarry,11550400);
  assert.equal(runner.rankingProfit,14104000);assert.equal(reversals(result).length,1);
});
test('a genuine reversal compares profits after approval carry and states that only the leading program misses',()=>{
  const result=compare([80,70]),lines=reversals(result);
  assert.equal(lines.length,1);assert.match(lines[0],/Program A alone/);assert.match(lines[0],/profit after incremental approval carry/);
  assert.match(lines[0],/\$11,550,400/);assert.match(lines[0],/base profit after incremental approval carry of \$14,104,000/);
  assert.match(lines[0],/Program B then leads/);
});
test('missing entitlement assessment remains unpriced and preserves full downside',()=>{
  const result=compare([null,20]),[winner]=result.variants;
  assert.equal(winner.downsideProfitAfterCarry,11550400);assert.equal(winner.downsideProfitAfterCarry,winner.downsideRentMinus10Profit);
  assert.equal(reversals(result).length,1);
});
test('an explicit zero entitlement score never zeros a positive dollar profit',()=>{
  const result=compare([80,0]),other=result.variants.find(variant=>variant.label==='Program B');
  assert.equal(other.rankingProfit,14104000);assert.equal(other.downsideProfitAfterCarry,11550400);assert.equal(reversals(result).length,1);
});
test('a downside loss is not discounted away and the reversal states the full loss',()=>{
  const result=compare([80,70],{landPrice:14000000}),[winner]=result.variants;
  assert.equal(winner.downsideRentMinus10Profit,-1601600);assert.equal(winner.downsideProfitAfterCarry,-1601600);
  assert.match(reversals(result)[0],/-\$1,601,600/);
});
test('a downside tie does not claim a strict ranking reversal',()=>{
  const result=comparePrograms({shared,variants:[{label:'Program A',productType:'rental'},{label:'Program B',productType:'rental',rentScale:.9}]});
  assert.equal(result.variants[0].downsideRentMinus10Profit,result.variants[1].rankingProfit);
  assert.deepEqual(reversals(result),[]);
});
test('condo sale-price downside uses the same after-carry ranking rule',()=>{
  const result=comparePrograms({shared,variants:variants([80,20]).map(variant=>({...variant,productType:'condo'}))}),[winner]=result.variants;
  assert.equal(winner.profit,8360000);assert.equal(winner.downsideRentMinus10Profit,6780800);
  assert.equal(winner.downsideProfitAfterCarry,6780800);assert.equal(reversals(result).length,1);
});
test('a reversal names the best unchanged alternative regardless of input order',()=>{
  const input=variants([80,70,60]);
  for(const ordered of [input,[...input].reverse()]){
    const result=comparePrograms({shared,variants:ordered});
    assert.equal(result.recommendation.label,'Program A');assert.match(reversals(result)[0],/Program B then leads/);
  }
});
test('the actual tool emits and retains the adjusted downside without changing its base recommendation',async()=>{
  const events=[],tools=createFeasibilityTools({emit:(name,result)=>events.push({name,result})});
  const result=await tools.handlers.acres_compare_programs({shared,variants:variants([80,20])});
  assert.equal(result.recommendation.label,'Program A');assert.equal(result.variants[0].downsideProfitAfterCarry,11550400);
  assert.equal(tools.comparisons[0],result);assert.equal(events[0].result,result);assert.equal(events[0].name,'feasibility.compared');
});
test('the Core comparison labels rent and price downside and distinguishes raw from adjusted profit',()=>{
  const root=core(compare()),rows=[...root.querySelectorAll('#core-decide .core-compare tr')];
  const raw=rows.find(row=>row.querySelector('th')?.textContent==='Profit if rents/prices fall 10%');
  const adjusted=rows.find(row=>row.querySelector('th')?.textContent==='Downside profit after approval carry');
  assert.ok(raw);assert.deepEqual([...raw.querySelectorAll('td')].map(cell=>cell.textContent),['$11.55M','$11.55M']);
  assert.ok(adjusted);assert.deepEqual([...adjusted.querySelectorAll('td')].map(cell=>cell.textContent),['$11.55M','$11.55M']);
  assert.match(root.textContent,/ordinal index rather than an actuarial probability/);assert.match(root.textContent,/leading program alone/);
});
test('the actual exported comparison includes correctly labeled raw and adjusted downside figures',()=>{
  const doc=report(compare()),table=[...doc.querySelectorAll('table')].find(table=>table.querySelector('caption')?.textContent==='Program comparison');
  const headers=[...table.querySelectorAll('thead th')].map(cell=>cell.textContent);
  const raw=headers.indexOf('Profit if rents/prices fall 10%'),adjusted=headers.indexOf('Downside profit after approval carry');
  assert.ok(raw>=0);assert.ok(adjusted>=0);
  const cells=[...table.querySelectorAll('tbody tr')[0].querySelectorAll('td')];
  assert.equal(cells[raw].textContent,'$11,550,400');assert.equal(cells[adjusted].textContent,'$11,550,400');
  assert.match(doc.body.textContent,/ordinal index rather than an actuarial probability/);assert.match(doc.body.textContent,/leading program alone/);
});
test('historic comparison snapshots retain raw downside and leave unavailable adjusted downside unknown',()=>{
  const legacy=structuredClone(compare());delete legacy.rankingBasis;for(const variant of legacy.variants){variant.riskAdjustedProfit=variant.rankingProfit*.8;delete variant.downsideProfitAfterCarry;}
  const root=core(legacy);
  assert.match(root.textContent,/Profit if rents\/prices fall 10%/);assert.doesNotMatch(root.textContent,/Risk-adjusted downside profit/);
  const doc=report(legacy),table=[...doc.querySelectorAll('table')].find(table=>table.querySelector('caption')?.textContent==='Program comparison');
  const headers=[...table.querySelectorAll('thead th')].map(cell=>cell.textContent),adjusted=headers.indexOf('Risk-adjusted downside profit');
  assert.ok(adjusted>=0);assert.equal(table.querySelectorAll('tbody tr')[0].querySelectorAll('td')[adjusted].textContent,'n/a');
});

test('recommended program headlines and comparison costs include incremental approval carry',()=>{
  const result=comparePrograms({shared,variants:[{label:'Delayed winner',productType:'rental',rentScale:1.2,timelineMonths:12},{label:'Quick',productType:'rental',timelineMonths:0}]}),winner=result.variants[0];
  assert.equal(winner.label,'Delayed winner');assert.equal(winner.entitlementCarryCost,96000);
  const deck=buildUnderwritingDeck({projectState:{comparisons:field([result])}}),metrics=deck.slides[0].metrics;
  assert.equal(metrics.projectedProfitUsd,winner.profit-96000);assert.equal(metrics.totalDevelopmentCostUsd,winner.totalDevelopmentCost+96000);assert.equal(metrics.yieldOnCost,winner.yieldOnCostAfterCarry);
  const root=core(result);assert.match(root.textContent,/Development cost including approval carry/);assert.doesNotMatch(root.textContent,/Risk-adjusted comparison/);
  const doc=report(result);assert.match(doc.body.textContent,/Development cost including approval carry/);
});
