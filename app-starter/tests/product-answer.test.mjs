import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {fullState,subjectOnlyState} from './fixtures/project-state.mjs';

const read=(name)=>readFileSync(new URL(`../public/${name}`,import.meta.url),'utf8');
const {document,window}=parseHTML(read('index.html'));
globalThis.document=document;
globalThis.window=window;
const {renderParcel,answerLine}=await import('../public/core-view.js');
const {stepView}=await import('../public/core-model.js');
const {createListings}=await import('../public/listings.js');

const option=(landValue)=>({id:'x',label:'X',program:{},returns:{landValue}});
const schemes=(values,basis=null)=>({schemes:[...values.map(option),{id:'empty',label:'Empty',program:null,returns:null}],basis});

test('the welcome names the job and who it serves above the address entry; the listings lead with search and filters',()=>{
  const welcome=document.querySelector('#welcome');
  const intro=welcome.querySelector('.intro');
  assert.match(intro.textContent,/what current zoning lets you build, three ways to build it, and what the land is worth at your costs/);
  assert.match(intro.textContent,/developers sizing a bid, brokers marketing a site and investors screening deal flow/);
  assert.doesNotMatch(intro.textContent,/—|accura/i);
  // The line sits above the address entry; the welcome keeps its controls.
  const order=[...welcome.children];
  assert.ok(order.indexOf(intro)<order.indexOf(welcome.querySelector('#home-address')));
  assert.ok(welcome.querySelector('.example-link'));
  assert.ok(welcome.querySelector('#home-sites'));
  // Over the listings, no description: the place search and the filters share the header.
  const root=document.createElement('div');
  const listings=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},loadMap:async()=>null});
  const head=listings.addressMount.parentElement;
  assert.deepEqual([...head.children].map((n)=>n.className),['sr-only','listings-find','listings-filters','listings-address']);
  assert.equal(head.querySelector('h1').textContent,'Explore NYC');
  assert.equal(head.querySelector('.listings-lede'),null);
});

test('the site header answers in one line once all four steps have results',()=>{
  const steps=stepView(fullState);
  const basis={ask:4_500_000,askFrom:'assumptions'};
  assert.equal(answerLine(fullState,steps,schemes([1_200_000,3_400_000],basis)),
    'You can build 20,000 sq ft. Land value: a developer earning your target return at your costs could pay up to $3.40M. Your land price is $4.50M.');
  assert.equal(answerLine(fullState,steps,schemes([3_400_000],{ask:6_000_000,askFrom:'listing'})),
    'You can build 20,000 sq ft. Land value: a developer earning your target return at your costs could pay up to $3.40M. The asking price is $6.00M.');
  assert.equal(answerLine(fullState,steps,schemes([3_400_000])),
    'You can build 20,000 sq ft. Land value: a developer earning your target return at your costs could pay up to $3.40M.');
  // When the city-financed option pays the most, the line names it and its cap.
  const city=schemes([1_200_000,3_400_000],{ask:6_000_000,askFrom:'listing'});
  city.schemes[1].program={taxProgram:{kind:'city-financed'}};
  assert.equal(answerLine(fullState,steps,city),
    'You can build 20,000 sq ft. Land value: a developer earning your target return at your costs could pay up to $3.40M with city financing, capped at appraised land value (nearby sales). The asking price is $6.00M.');
  city.schemes[1].returns.landValue=1_000_000;
  assert.match(answerLine(fullState,steps,city),/could pay up to \$1\.20M\. The asking/,'named only when it pays the most');
});

test('an answer where no option pays for the land names no land figure',()=>{
  const steps=stepView(fullState);
  const line=answerLine(fullState,steps,schemes([-800_000,0],{ask:6_000_000,askFrom:'listing'}));
  assert.equal(line,'You can build 20,000 sq ft. Land value: none of the three ways to build it pays for the land at your costs and target return. The asking price is $6.00M.');
  assert.doesNotMatch(line,/\$0|-\$/);
  assert.equal(answerLine(fullState,steps,schemes([])),'You can build 20,000 sq ft. Land value: none of the three ways to build it pays for the land at your costs and target return.');
});

test('the answer waits for the four steps and the three options, and follows the options when assumptions change',()=>{
  assert.equal(renderParcel(subjectOnlyState,{canSend:true,canEdit:true,schemes:schemes([3_400_000])}).querySelector('.uw-verdict'),null,'unfinished steps');
  assert.equal(renderParcel(fullState,{canSend:true,canEdit:true,schemes:{loading:true}}).querySelector('.uw-verdict'),null,'options still loading');
  const before=renderParcel(fullState,{canSend:true,canEdit:true,schemes:schemes([3_400_000])}).querySelector('.uw-header .uw-verdict');
  assert.match(before.textContent,/could pay up to \$3\.40M/);
  // New assumptions reprice the options; the page draws the line from the new read.
  const after=renderParcel({...fullState,version:fullState.version+1},{canSend:true,canEdit:true,schemes:schemes([2_100_000])}).querySelector('.uw-header .uw-verdict');
  assert.match(after.textContent,/could pay up to \$2\.10M/);
});
