import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {computeProForma} from './proforma.mjs';
import {comparePrograms} from './feasibility.mjs';
import {buildUnderwritingDeck,renderDeckHtml} from './deliverable.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
const field=value=>({value,updated:1,provenance:{sources:[]}});
const shared={market:{submarket:'Hypothetical fixture',rents:[{bedrooms:1,rentPerSqftPerMonth:8,source:'User',retrievedAt:'2026-10-17'}],salePrices:[{bedrooms:1,pricePerSqft:3000,source:'User',retrievedAt:'2026-10-17'}]},program:{grossBuildingSqft:20000,units:[{bedrooms:1,count:20,netSqft:700}]},landPrice:2000000,hardCostPerSqft:200,softCostPerSqft:50,financing:{loanToCost:.6,interestRate:.08,termMonths:24},operating:{residentialVacancyRate:.05,residentialOpexPerUnitPerYear:10000,commercialVacancyRate:.1,commercialOpexPerSqftPerYear:0},capRate:.05,sellingCostRate:.06};
function fixture(){
  const comparison=comparePrograms({shared,variants:[{label:'Rental option',productType:'rental'},{label:'Condo option',productType:'condo',program:{grossBuildingSqft:12000,units:[{bedrooms:1,count:12,netSqft:700}]}}]});
  const reference=computeProForma({...shared,name:'Rental reference',productType:'rental'});
  return {comparison,reference,state:{proFormas:field([reference]),comparisons:field([comparison])}};
}
const documentOf=deck=>parseHTML(renderDeckHtml(deck)).document;
const coverFacts=doc=>Object.fromEntries([...doc.querySelectorAll('#executive-summary .key-facts div')].map(node=>[node.querySelector('dt').textContent,node.querySelector('dd').textContent]));
const facts=(doc,caption)=>{const table=[...doc.querySelectorAll('#pro-forma-and-feasibility table.facts')].find(table=>table.querySelector('caption')?.textContent===caption);return Object.fromEntries([...(table?.querySelectorAll('tbody tr')||[])].map(row=>[row.querySelector('th').textContent,row.querySelector('td').textContent]));};

test('cover metrics bind to the recommended program rather than the separate latest pro forma',()=>{
  const {state}=fixture(),metrics=buildUnderwritingDeck({projectState:state}).slides[0].metrics;
  assert.equal(metrics.recommendedProgram,'Condo option');assert.equal(metrics.totalDevelopmentCostUsd,5336000);assert.equal(metrics.projectedProfitUsd,18352000);assert.equal(metrics.yieldOnCost,null);
});
test('rendering preserves a compiled cover snapshot instead of overwriting it with detail-model figures',()=>{
  const {state}=fixture(),deck=buildUnderwritingDeck({projectState:state});
  Object.assign(deck.slides[0].metrics,{totalDevelopmentCostUsd:5336000,projectedProfitUsd:18352000,yieldOnCost:null});
  const before=structuredClone(deck),values=coverFacts(documentOf(deck));
  assert.equal(values['Total development cost'],'$5,336,000');assert.equal(values['Projected profit'],'$18,352,000');assert.equal(values['Yield on cost'],undefined);assert.deepEqual(deck,before);
});
test('a comparison-only report can show the recommended programs recorded financial figures',()=>{
  const {comparison}=fixture(),deck=buildUnderwritingDeck({projectState:{comparisons:field([comparison])}}),values=coverFacts(documentOf(deck));
  assert.equal(deck.slides[0].metrics.totalDevelopmentCostUsd,5336000);assert.equal(values['Projected profit'],'$18,352,000');
});
test('an unmatched or legacy recommendation leaves its figures unknown instead of borrowing another model',()=>{
  const {reference}=fixture();
  for(const comparison of [{recommendation:{label:'Missing option'},variants:[]},{winner:{name:'Legacy option'}}]){
    const deck=buildUnderwritingDeck({projectState:{proFormas:field([reference]),comparisons:field([comparison])}}),metrics=deck.slides[0].metrics,doc=documentOf(deck);
    assert.equal(metrics.totalDevelopmentCostUsd,null);assert.equal(metrics.projectedProfitUsd,null);assert.equal(metrics.yieldOnCost,null);
    assert.equal(coverFacts(doc)['Total development cost'],undefined);assert.match(doc.querySelector('#executive-summary .financial-note')?.textContent||'',/unavailable/);
  }
});
test('duplicate program names do not choose the first matching financial record',()=>{
  const {comparison,reference}=fixture();for(const variant of comparison.variants)variant.label='Shared name';comparison.recommendation.label='Shared name';
  const deck=buildUnderwritingDeck({projectState:{comparisons:field([comparison]),proFormas:field([reference])}}),doc=documentOf(deck);
  assert.equal(deck.slides[0].metrics.totalDevelopmentCostUsd,null);assert.equal(deck.slides[0].metrics.projectedProfitUsd,null);
  assert.match(doc.querySelector('#executive-summary .financial-note')?.textContent||'',/distinct names/);
});
test('partial recommended-program figures remain partial even when a pro forma has the same name',()=>{
  const {reference}=fixture();reference.name='Selected option';
  const deck=buildUnderwritingDeck({projectState:{proFormas:field([reference]),comparisons:field([{recommendation:{label:'Selected option'},variants:[{label:'Selected option',profit:200}]}])}}),metrics=deck.slides[0].metrics;
  assert.equal(metrics.projectedProfitUsd,200);assert.equal(metrics.totalDevelopmentCostUsd,null);assert.equal(metrics.yieldOnCost,null);
});
test('recorded zero and negative recommended-program values are retained',()=>{
  const {reference}=fixture();
  for(const profit of [0,-200]){
    const deck=buildUnderwritingDeck({projectState:{proFormas:field([reference]),comparisons:field([{recommendation:{label:'Selected option'},variants:[{label:'Selected option',totalDevelopmentCost:0,yieldOnCost:0,profit}]}])}}),values=coverFacts(documentOf(deck));
    assert.equal(values['Total development cost'],'$0');assert.equal(values['Yield on cost'],'0.00%');assert.equal(values['Projected profit'],profit===0?'$0':'-$200');
  }
});
test('without a comparison recommendation the cover names the analyzed pro forma rather than inventing a recommendation',()=>{
  const {reference}=fixture();
  for(const name of ['Rental reference',null]){
    const pf={...reference,name},deck=buildUnderwritingDeck({projectState:{program:field({productType:'condo'}),proFormas:field([pf])}}),values=coverFacts(documentOf(deck));
    assert.equal(deck.slides[0].metrics.recommendedProgram,null);assert.equal(values['Recommended program'],undefined);assert.equal(values['Analyzed program'],name||'rental');assert.equal(values['Total development cost'],'$7,432,000');
  }
});
test('the separate financial detail remains labeled and retains its own values',()=>{
  const {state}=fixture(),doc=documentOf(buildUnderwritingDeck({projectState:state}));
  assert.match(doc.querySelector('#pro-forma-and-feasibility').textContent,/Financial model: Rental reference/);
  assert.equal(facts(doc,'Capital budget')['Total development cost'],'$7,432,000');assert.equal(facts(doc,'Returns')['Projected profit'],'$14,104,000');assert.equal(facts(doc,'Returns')['Yield on cost'],'14.49%');
});
test('a partial detail model never fills its missing figures from a different cover basis',()=>{
  const deck=buildUnderwritingDeck({projectState:{proFormas:field([{name:'Partial reference',productType:'rental',development:{landPrice:2000},returns:{value:3000}}])}});
  Object.assign(deck.slides[0].metrics,{totalDevelopmentCostUsd:50000,projectedProfitUsd:10000,yieldOnCost:.07});
  const doc=documentOf(deck);assert.equal(facts(doc,'Capital budget')['Land'],'$2,000');assert.equal(facts(doc,'Capital budget')['Total development cost'],undefined);assert.equal(facts(doc,'Returns')['Projected profit'],undefined);assert.equal(facts(doc,'Returns')['Yield on cost'],undefined);
});
test('an actual viewer report endpoint binds both JSON and HTML headlines to the recommendation',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-deck-financial-basis-')),store=new ChatStore(join(dir,'chat.sqlite')),owner='a'.repeat(24),viewer='b'.repeat(24),conversation=store.createConversation(owner),{state}=fixture();
  store.project.write(conversation.projectId,state,1000);store.grantMember(owner,conversation.id,'account',viewer,'viewer');
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'local-deck-fixture'},store,execute:async()=>{throw new Error('Reading a report must not run research.');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}/conversations/${conversation.id}/deck`,headers={authorization:'Bearer local-deck-fixture','x-acres-account':viewer};
  const response=await fetch(url,{headers});assert.equal(response.status,200);const deck=await response.json();assert.equal(deck.slides[0].metrics.totalDevelopmentCostUsd,5336000);
  const html=await fetch(url+'?format=html',{headers});assert.equal(html.status,200);const doc=parseHTML(await html.text()).document;assert.equal(coverFacts(doc)['Projected profit'],'$18,352,000');assert.equal(facts(doc,'Returns')['Projected profit'],'$14,104,000');
});
