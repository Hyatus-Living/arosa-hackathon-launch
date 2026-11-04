import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';

const pub=new URL('../public/',import.meta.url);
const read=(name)=>readFileSync(new URL(name,pub),'utf8');
const {document,window}=parseHTML(read('index.html'));
globalThis.document=document;
globalThis.window=window;
const {dealCard}=await import('../public/deal-card.js');

// Store rows as /market-store/deals returns them (camelCase), priced unless asked otherwise.
const row=(id,{listPrice=2_400_000,bsf=240}={})=>({
  id,bbl:`30${id.padStart(8,'0')}`,address:`${id} Test Street`,borough:'Brooklyn',zipCode:'11221',zoningDistrict:'R6A',
  lotAreaSqft:2500,maxUapZfa:10000,unusedUapZfa:7500,listPrice,uapPricePerBuildableZfa:listPrice?bsf:null,maxBuildableUnits:14,
  flashcardValuation:{impliedYieldOnCostPct:6.4,impliedCondoMarginPct:21.5,dealVerdict:'good_deal',
    slidingScalePricePerBsf:{greatDealMaxBsf:150,goodDealMaxBsf:250,badDealMinBsf:350,goodDealMaxLandValue:2_500_000}},
});
const dealSettings={greatDealCapRate:0.07,goodDealCapRate:0.06,badDealCapRate:0.05,greatDealCondoMargin:0.25,goodDealCondoMargin:0.18,badDealCondoMargin:0.1};
const cards=(...deals)=>{const root=document.createElement('div');root.append(...deals.map((d)=>dealCard(d,{dealSettings})));return root;};

test('deal cards name the most units the zoning allows',()=>{
  const root=cards(row('1'));
  assert.match(root.textContent,/14 most units allowed/);
  assert.doesNotMatch(root.textContent,/units possible/);
});

test('home has the current listings workspace outside the conversation',()=>{
  const listings=document.querySelector('#home-listings');
  assert.ok(listings);assert.equal(listings.closest('#main'),null);
});

test('a deal card leads with address and district, then ask, headroom and price per buildable, the scale with the ask marked, and projections',()=>{
  const [card,unpriced]=cards(row('7'),row('8',{listPrice:null})).querySelectorAll('[data-deal-card]');
  assert.match(card.querySelector('h3').textContent,/7 Test Street/);
  assert.match(card.textContent,/R6A/);
  const figures=[...card.querySelectorAll('.deal-figure dt')].map((d)=>d.textContent);
  assert.deepEqual(figures.slice(0,3),['Ask','Headroom','Price per buildable SF']);
  const values=[...card.querySelectorAll('.deal-figure dd')].map((d)=>d.textContent);
  assert.match(values[0],/\$2\.40M/);assert.match(values[1],/3\.00 FAR/);assert.match(values[2],/\$240/);
  const scale=card.querySelector('.deal-scale');
  assert.match(scale.getAttribute('aria-label'),/\$240.*good deal/i,'the scale says where the ask sits');
  const marker=scale.querySelector('.deal-scale-ask');
  const left=parseFloat(marker.style.left);
  assert.ok(left>40&&left<60,`a $240 ask between $150 great and $350 full price sits mid scale, got ${left}`);
  assert.match(scale.textContent,/Great.*\$150/);assert.match(scale.textContent,/Full price.*\$350/);
  assert.match(card.textContent,/Yield on cost\s*6\.4%/);assert.match(card.textContent,/Condo margin\s*21\.5%/);
  assert.equal(unpriced.querySelector('.deal-scale-ask'),null,'an unpriced listing has no ask to mark');
  assert.match(unpriced.querySelector('.deal-figure dd').textContent,/Unpriced/);
  for(const c of [card,unpriced])assert.doesNotMatch(c.textContent,/[—–]|\s-\s/,'no dashes in the copy');
});

test('Underwrite on a card starts that parcel with its underwriting prompt, and waits while a site cannot start',()=>{
  const started=[];
  const waiting=dealCard(row('1'),{dealSettings,canStart:()=>false,onUnderwrite:()=>started.push('early')}).querySelector('button');
  assert.equal(waiting.textContent,'Underwrite');
  assert.equal(waiting.disabled,true);
  const go=dealCard(row('1'),{dealSettings,canStart:()=>true,onUnderwrite:(deal,prompt)=>started.push([deal,prompt])}).querySelector('button');
  assert.equal(go.disabled,false);
  go.click();
  assert.equal(started.length,1);
  assert.equal(started[0][0].address,'1 Test Street');
  assert.match(started[0][1],/Underwrite 1 Test Street, Brooklyn/);
});

test('a listing with an ask but no matched parcel says so instead of reading as unpriced',()=>{
  const unmatched=row('9');unmatched.uapPricePerBuildableZfa=null;unmatched.flashcardValuation.dealVerdict='unmatched_parcel';
  const card=cards(unmatched).querySelector('[data-deal-card]');
  const [ask,,ppb]=[...card.querySelectorAll('.deal-figure dd')].map((d)=>d.textContent);
  assert.match(ask,/\$2\.40M.*Not matched to a parcel/);
  assert.match(ppb,/Unknown.*Not matched to a parcel/);
  assert.doesNotMatch(card.textContent,/Unpriced|unmatched_parcel/);
  const label=card.querySelector('.deal-scale').getAttribute('aria-label');
  assert.match(label,/not matched to a parcel/);
  assert.doesNotMatch(label,/Unpriced/);
});

test('a price in a better range than its rating explains that headroom held the rating back',()=>{
  const thin=row('3',{bsf:120});thin.unusedUapZfa=600;thin.flashcardValuation.dealVerdict='fair_deal';
  const roomy=row('4',{bsf:120});roomy.flashcardValuation.dealVerdict='great_deal';
  const [thinCard,roomyCard]=cards(thin,roomy).querySelectorAll('[data-deal-card]');
  const note=thinCard.querySelector('.deal-scale-note');
  assert.match(note.textContent,/Great range.*rated Fair Deal.*600 SF/);
  assert.match(thinCard.querySelector('.deal-scale').getAttribute('aria-label'),/rated Fair Deal.*Great range.*600 SF/);
  assert.equal(roomyCard.querySelector('.deal-scale-note'),null,'a rating that matches its price needs no note');
});

test('a card never shows a verdict identifier the store did not define, and reads a scale sent as numeric strings',()=>{
  const odd=row('9');odd.flashcardValuation.dealVerdict='some_new_verdict';
  const strings=row('10');strings.flashcardValuation.slidingScalePricePerBsf={greatDealMaxBsf:'150',goodDealMaxBsf:'250',badDealMinBsf:'350'};
  strings.uapPricePerBuildableZfa='240';
  const blank=row('11');blank.flashcardValuation.slidingScalePricePerBsf={greatDealMaxBsf:'',goodDealMaxBsf:'250',badDealMinBsf:'300'};
  const [oddCard,stringCard,blankCard]=cards(odd,strings,blank).querySelectorAll('[data-deal-card]');
  assert.doesNotMatch(oddCard.textContent,/some_new_verdict/);
  assert.doesNotMatch(oddCard.querySelector('.deal-scale').getAttribute('aria-label'),/some_new_verdict|rated/);
  // An empty Great threshold is missing, never $0: the scale starts at Good.
  assert.doesNotMatch(blankCard.querySelector('.deal-scale').textContent,/Great/);
  assert.match(blankCard.querySelector('.deal-scale').textContent,/Good ≤ \$250\/BSF/);
  assert.deepEqual([...blankCard.querySelectorAll('.deal-scale-zone')].map((z)=>z.className.split('zone-')[1]),['good','fair','full']);
  const zones=[...stringCard.querySelectorAll('.deal-scale-zone')].map((z)=>[parseFloat(z.style.left),parseFloat(z.style.width)]);
  assert.deepEqual(zones.map(([l])=>Math.round(l)),[0,17,50,83],'zones sit where the numeric thresholds put them');
  assert.ok(zones.every(([,w])=>w>=0&&w<=100));
  const left=parseFloat(stringCard.querySelector('.deal-scale-ask').style.left);
  assert.ok(left>40&&left<60,`a $240 ask sits mid scale, got ${left}`);
  assert.match(stringCard.querySelector('.deal-scale').textContent,/Great ≤ \$150\/BSF/);
});

test('the inspector states no great-deal land value when no price earns Great',async()=>{
  const {renderInspector}=await import('../public/listing-inspector.js');
  const deal=row('12');
  deal.flashcardValuation.slidingScalePricePerBsf={greatDealMaxBsf:null,goodDealMaxBsf:250,badDealMinBsf:350,greatDealMaxLandValue:null,goodDealMaxLandValue:2_500_000,badDealMinLandValue:3_500_000};
  const view=renderInspector(deal,{canStart:()=>true,onUnderwrite(){},onAsk(){},onClose(){}});
  assert.match(view.textContent,/No price is a great deal at your costs; good up to \$2\.50M\./);
  assert.doesNotMatch(view.textContent,/great deal at your costs is –/);
});
