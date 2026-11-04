import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';

const pub=new URL('../public/',import.meta.url),{document,window}=parseHTML(readFileSync(new URL('index.html',pub),'utf8'));
globalThis.document=document;globalThis.window=window;
Object.defineProperty(document,'activeElement',{value:document.body,writable:true,configurable:true});window.HTMLElement.prototype.focus=function(){document.activeElement=this;};
const {createListings}=await import('../public/listings.js');
const {pinRows,pinsGeoJson}=await import('../public/listings-map.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settings={isCustom:false,dealSettings:{hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15}};
const row=n=>({id:String(n),bbl:`30${String(n).padStart(8,'0')}`,address:`${n} Rank Street`,borough:'BK',zipCode:'11221',zoningDistrict:'R6A',latitude:40.6+n/1000,longitude:-73.92,listPrice:900000+n,uapPricePerBuildableZfa:100+n,unusedUapZfa:7000,similarComps:[],flashcardValuation:{dealVerdict:'good_deal',basis:[]}});
const page=(offset,total=45)=>({deals:Array.from({length:Math.min(20,total-offset)},(_,i)=>row(offset+i+1)),total,offset,limit:20,userSettings:settings});
const pins=total=>{const all=Array.from({length:total},(_,i)=>row(i+1));return {total,pins:{id:all.map(r=>r.id),rank:all.map((_,i)=>i+1),address:all.map(r=>r.address),latitude:all.map(r=>r.latitude),longitude:all.map(r=>r.longitude),dealVerdict:all.map(()=>'good_deal'),listPrice:all.map(r=>r.listPrice)}};};

async function setup(t){
  const requests=[];
  globalThis.fetch=url=>new Promise(resolve=>{const u=new URL(url,'http://x');requests.push({path:u.pathname,params:u.searchParams,answer:body=>resolve({ok:true,headers:{get:()=>'application/json'},json:async()=>body})});});
  t.after(()=>{delete globalThis.fetch;});
  const root=document.querySelector('#home-listings');root.replaceChildren();
  const map={box:{south:40.6,west:-74,north:40.8,east:-73.9},pins:[],fits:0,active:null,handlers:null,setPins(p,{fit}={}){this.pins=p;if(fit)this.fits++;},setActive(id){this.active=id;},setSelected(){},setBounds(box){this.box=box;},bounds(){return {...this.box};},resize(){}};
  const listings=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},loadMap:async(_node,handlers)=>{map.handlers=handlers;return map;}});
  const take=kind=>requests.filter(r=>r.path==='/api/market-store/deals'+(kind==='pins'?'/pins':''));
  listings.show();await tick();take('page')[0].answer(page(0));await tick();await tick();
  take('pins')[0].answer(pins(45));await tick();
  return {root,map,listings,take};
}
const numbers=root=>[...root.querySelectorAll('.listing-card')].map(card=>card.querySelector('.listing-card-rank').textContent);

test('pins carry the number of their card, and the card shows the same number on every page',async t=>{
  const {root,map,take}=await setup(t);
  assert.deepEqual(map.pins.slice(0,2).map(pin=>[pin.id,pin.rank]),[['1',1],['2',2]]);
  assert.equal(map.pins[24].rank,25);
  assert.deepEqual(numbers(root),Array.from({length:20},(_,i)=>String(i+1)));
  root.querySelector('.listings-pager button:last-child').click();await tick();
  take('page').at(-1).answer(page(20));await tick();
  assert.deepEqual(numbers(root).slice(0,2),['21','22']);
  assert.equal(map.handlers.describe(pinsGeoJson(map.pins).features[24].properties),'25. 25 Rank Street · $900K · Good deal');
  assert.deepEqual(pinsGeoJson(pinRows({id:['a'],rank:[7],address:['7 A St'],latitude:[40.7],longitude:[-73.9],dealVerdict:['great_deal'],listPrice:[null]})).features[0].properties,{id:'a',rank:7,verdict:'great_deal',address:'7 A St',price:null});
});

test('clicking the pin ranked 25th turns the list to page 2 with that card marked, and Back returns to it',async t=>{
  const {root,map,take}=await setup(t),pages=take('page').length;
  map.handlers.onPick('25');await tick();
  const turned=take('page').at(-1);assert.equal(take('page').length,pages+1);assert.equal(turned.params.get('offset'),'20');
  turned.answer(page(20));await tick();
  const card=root.querySelector('[data-listing="25"]');
  assert.ok(card,'the pin\'s card is on the list behind the open listing');assert.ok(card.classList.contains('is-selected'));
  assert.equal(root.querySelector('.listings-range').textContent,'21 to 40 of 45');
  const detail=take('page').length;
  [...root.querySelectorAll('button')].find(b=>b.textContent==='Back to results').click();await tick();
  assert.equal(root.querySelector('.listings-list').hidden,false);assert.equal(document.activeElement,card.querySelector('.listing-card-open'));
  assert.equal(take('page').length,detail,'Back shows the page already loaded');
  map.handlers.onPick('30');await tick();assert.equal(take('page').length,detail,'a pin whose card is on the page keeps the page');assert.ok(root.querySelector('[data-listing="30"]').classList.contains('is-selected'));assert.equal(card.classList.contains('is-selected'),false);
});

test('while the list follows the map, the pins cover the same area, so every pin number is a card number',async t=>{
  const {map,listings,take}=await setup(t),area={south:40.61,west:-73.95,north:40.62,east:-73.9};
  assert.equal(take('pins')[0].params.has('bounds'),false,'before a move both cover the whole city');
  map.box=area;map.handlers.onMove(area);await tick();
  const query='40.61000,-73.95000,40.62000,-73.90000';
  assert.equal(take('page').at(-1).params.get('bounds'),query);
  assert.equal(take('pins').at(-1).params.get('bounds'),query);
  const fits=map.fits;take('pins').at(-1).answer(pins(3));await tick();assert.equal(map.fits,fits,'a reader move never refits the map');
  const base=listings.filterSnapshot();listings.applyFilterUpdate({base,values:{...base.values,followMap:false}});await tick();
  assert.equal(take('pins').at(-1).params.has('bounds'),false,'searching the whole city maps the whole city');
});

test('the live map draws each pin\'s number and puts it in the popup',()=>{
  const source=readFileSync(new URL('listings-map.js',pub),'utf8');
  assert.match(source,/id: "pin-rank",\s*type: "symbol",\s*source: "listings",\s*filter: \["!", \["has", "point_count"\]\]/);
  assert.match(source,/"text-field": \["to-string", \["get", "rank"\]\]/);
});
