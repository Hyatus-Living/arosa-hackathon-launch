import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
const filters={borough:'BK',zipCode:null,area:'11249',zoningPrefix:'R6',minListPrice:0,maxListPrice:2000000,maxPricePerBuildableZfa:500,minLotArea:1000,maxLotArea:9000,minHeadroomFar:1.5,dealVerdict:'great_deal,good_deal',styles:['multi_family'],excludeLandmarks:true,excludeHighStabilizedRisk:true,listingType:'for_sale',minUnusedZfa:250,sortBy:'best_deal',limit:15,bounds:{south:40.7,west:-74,north:40.72,east:-73.95},hardCostPerGrossSqft:650,softCostPctOfHard:0,carryAndFinancingPct:.15,zfaToGrossFactor:1.4};
const queries=[{sourceId:1,filters,returnedCount:1,searchedAt:'2026-10-18T12:00:00Z'},{sourceId:2,filters:{...filters,borough:'QN',area:null,bounds:null,hardCostPerGrossSqft:800},returnedCount:0,searchedAt:'2026-10-18T12:01:00Z'}];

test('the actual assistant rendering branch restores saved search evidence with the answer',async()=>{
  const {listingSearchesView}=await import('../public/listing-search-view.js'),source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const anchor=source.indexOf('messages.forEach((m, i) => {'),start=source.indexOf('    if (m.role === "user") {',anchor),end=source.indexOf('    if (m.role === "assistant" && !m.error) {',start);assert.ok(start>anchor&&end>start);
  const el=document.createElement('article'),context={document,el,m:{role:'assistant',text:'Comparison answer',dealSearches:queries},i:4,dealsOnHome:true,runRecord:()=>null,answerHtml:()=>'<p>Comparison answer</p>',decorateAnswerHeader(){},listingSearchesView};
  vm.createContext(context);vm.runInContext('(()=>{'+source.slice(start,end)+'})()',context);
  assert.equal(el.querySelectorAll('.listing-searches details').length,2);assert.match(el.querySelector('.answer').textContent,/Comparison answer/);assert.match(el.textContent,/Queens/);assert.match(el.textContent,/\$800/);
});

test('saved answers render each distinct search scope, costs and empty result count with source access',async()=>{
  const {listingSearchesView}=await import('../public/listing-search-view.js'),node=listingSearchesView(queries,7),text=node.textContent;
  assert.equal(node.querySelectorAll('details').length,2);assert.match(text,/Brooklyn/);assert.match(text,/Queens/);assert.match(text,/1 returned/);assert.match(text,/0 returned/);assert.match(text,/Selected map area/);assert.match(text,/No map boundary/);
  for(const fragment of ['$650','$800','0%','15%','1.4','250','2,000,000','1,000','9,000','1.5','R6','Multifamily','Great','Good','15'])assert.ok(text.includes(fragment),fragment);
  assert.equal(node.querySelectorAll('button[data-source]').length,2);assert.equal(node.querySelector('button[data-source="2"]').dataset.message,'7');
  assert.ok(text.includes('$0 to $2,000,000'));
  assert.match(node.querySelector('summary').textContent,/\$650\/GSF/);
});

test('copied research includes the same scope and assumptions, and legacy answers remain empty',async()=>{
  const {listingSearchesText,listingSearchesView}=await import('../public/listing-search-view.js');
  const text=listingSearchesText(queries);for(const fragment of ['Brooklyn','Queens','$650','$800','Selected map area','No map boundary','0 returned','0%'])assert.ok(text.includes(fragment),fragment);
  assert.equal(listingSearchesView(undefined,0),null);assert.equal(listingSearchesText(undefined),'');assert.equal(listingSearchesView([],0),null);
  assert.match(listingSearchesText([{...queries[0],filters:{...filters,sortBy:'unused_far'}}]),/Most unused FAR/);
});

test('query descriptions render untrusted area text safely without changing the original evidence',async()=>{
  const {listingSearchesView}=await import('../public/listing-search-view.js'),input=structuredClone(queries);input[0].filters.area='<img src=x onerror=alert(1)>';
  const before=structuredClone(input),node=listingSearchesView(input,0);assert.equal(node.querySelector('img'),null);assert.ok(node.textContent.includes('<img'));assert.deepEqual(input,before);
});
