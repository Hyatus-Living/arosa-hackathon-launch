import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
const pub=new URL('../public/',import.meta.url),{document,window}=parseHTML(readFileSync(new URL('index.html',pub),'utf8'));
globalThis.document=document;globalThis.window=window;
const {createListings}=await import('../public/listings.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const A={south:40.67,west:-73.99,north:40.68,east:-73.96},B={south:40.71,west:-73.97,north:40.72,east:-73.95};
const queryBox=box=>[box.south,box.west,box.north,box.east].map(n=>n.toFixed(5)).join(',');
const settings={isCustom:false,dealSettings:{hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15}};
const page={deals:[],total:0,offset:0,limit:20,userSettings:settings};
async function setup(t){
  const requests=[];
  globalThis.fetch=url=>new Promise(resolve=>{const u=new URL(url,'http://x');requests.push({path:u.pathname,params:u.searchParams,answer:body=>resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>body})});});
  t.after(()=>{delete globalThis.fetch;});
  const root=document.querySelector('#home-listings');root.replaceChildren();
  const map={box:A,handlers:null,fits:0,restored:[],pins:[],setPins(pins,{fit}={}){this.pins=pins;if(fit)this.fits++;},setBounds(box){this.box=box;this.restored.push({...box});},setActive(){},setSelected(){},bounds(){return {...this.box};},resize(){}};
  const listings=createListings({root,canStart:()=>true,onUnderwrite(){},onAsk(){},onToggleChat(){},isChatOpen:()=>false,loadMap:async(_node,handlers)=>{map.handlers=handlers;return map;}});
  const take=kind=>requests.filter(row=>row.path==='/api/market-store/deals'+(kind==='pins'?'/pins':''));
  const last=kind=>take(kind).at(-1),move=async box=>{map.box=box;map.handlers.onMove(box);await tick();};
  listings.show();await tick();last('page').answer(page);await tick();last('pins').answer({pins:[],total:0});await tick();
  return {root,map,listings,last,move};
}
const update=(listings,next)=>{const base=listings.filterSnapshot();return listings.applyFilterUpdate({base,values:{...base.values,...next}});};
const undo=root=>root.querySelector('[data-filter-action="undo"]').click();

test('chat snapshots capture the active query area separately from the visible viewport',async t=>{
  const {map,listings,move}=await setup(t);await move(A);
  const snapshot=listings.filterSnapshot();assert.deepEqual(snapshot.map,{revision:1,bounds:A,viewport:A});
  update(listings,{followMap:false});await tick();map.box=B;
  assert.deepEqual(listings.filterSnapshot().map,{revision:1,bounds:null,viewport:B});
});

test('a map move while following is off invalidates an older chat request to follow it',async t=>{
  const {listings,last,move}=await setup(t);update(listings,{followMap:false});await tick();
  const base=listings.filterSnapshot();await move(B);
  assert.equal(listings.applyFilterUpdate({base,values:{...base.values,followMap:true}}),false);
  assert.equal(listings.filterSnapshot().values.followMap,false);assert.equal(last('page').params.has('bounds'),false);
  const current=listings.filterSnapshot();assert.equal(listings.applyFilterUpdate({base:current,values:{...current.values,followMap:true}}),true);await tick();
  assert.equal(last('page').params.get('bounds'),queryBox(B));
});

test('enabling map scope uses the captured viewport even if a programmatic fit changes the map',async t=>{
  const {map,listings,last}=await setup(t);update(listings,{followMap:false});await tick();
  const base=listings.filterSnapshot();map.box=B;
  assert.equal(listings.applyFilterUpdate({base,values:{...base.values,followMap:true}}),true);await tick();
  assert.equal(last('page').params.get('bounds'),queryBox(A));assert.deepEqual(map.box,A);
});

test('chat price refinements and Undo retain the active map area without refitting pins',async t=>{
  const {root,map,listings,last,move}=await setup(t);await move({...A,south:A.south+.000000123});
  const fits=map.fits;assert.equal(update(listings,{maxPrice:500000}),true);await tick();
  assert.equal(last('page').params.get('bounds'),queryBox(A));
  assert.equal(last('page').params.get('maxListPrice'),'500000');
  last('pins').answer({pins:[],total:0});await tick();assert.equal(map.fits,fits);
  undo(root);await tick();assert.equal(last('page').params.get('bounds'),queryBox(A));assert.equal(map.restored.length,0);
});

test('manual nonlocation refinements retain the selected area and reset only pagination',async t=>{
  const {root,map,listings,last,move}=await setup(t);await move(A);const fits=map.fits;
  const select=[...root.querySelectorAll('label')].find(label=>label.querySelector('.sr-only')?.textContent==='Sort').querySelector('select');
  const value=[...select.querySelectorAll('option')].find(option=>option.value!==listings.filterSnapshot().values.sortBy).value;
  for(const option of select.querySelectorAll('option'))option.toggleAttribute('selected',option.value===value);
  select.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();
  assert.equal(listings.filterSnapshot().values.sortBy,value);assert.equal(last('page').params.get('sortBy'),value);
  assert.equal(last('page').params.get('bounds'),queryBox(A));assert.equal(last('page').params.get('offset'),'0');
  last('pins').answer({pins:[],total:0});await tick();assert.equal(map.fits,fits);
});

test('a chat location change searches outside the old area and Undo restores both area and viewport',async t=>{
  const {root,map,listings,last,move}=await setup(t);await move(A);
  assert.equal(update(listings,{borough:'QN'}),true);await tick();assert.equal(last('page').params.has('bounds'),false);
  last('pins').answer({pins:[],total:0});await tick();const fits=map.fits;
  undo(root);await tick();assert.equal(last('page').params.get('bounds'),queryBox(A));assert.deepEqual(map.restored,[A]);
  last('pins').answer({pins:[],total:0});await tick();assert.equal(map.fits,fits);
});

test('a late pin response never overrides a later reader map move; the pins for the new area do, without refitting',async t=>{
  const {map,listings,last,move}=await setup(t);await move(A);
  update(listings,{borough:'BK'});await tick();const pending=last('pins'),fits=map.fits;
  await move(B);const moved=last('pins'),pins=[{id:'new-match',rank:1,latitude:40.715,longitude:-73.96}];
  assert.notEqual(moved,pending);assert.equal(moved.params.get('bounds'),queryBox(B));
  pending.answer({pins:[{id:'stale',rank:1,latitude:40.6,longitude:-73.9}],total:1});moved.answer({pins,total:1});await tick();
  assert.deepEqual(map.pins,pins);assert.equal(map.fits,fits);assert.equal(last('page').params.get('bounds'),queryBox(B));
});

test('a reader map move also prevents late fitting when map-following is disabled',async t=>{
  const {map,listings,last,move}=await setup(t);
  update(listings,{borough:'BK',followMap:false});await tick();const pending=last('pins'),fits=map.fits;
  await move(B);pending.answer({pins:[],total:0});await tick();
  assert.equal(map.fits,fits);assert.equal(last('page').params.has('bounds'),false);
});

test('Undo keeps a newer reader-selected area instead of restoring an older chat viewport',async t=>{
  const {root,map,listings,last,move}=await setup(t);await move(A);update(listings,{maxPrice:500000});await tick();
  await move(B);undo(root);await tick();
  assert.equal(last('page').params.get('bounds'),queryBox(B));assert.equal(map.restored.length,0);
  assert.equal(listings.filterSnapshot().values.maxPrice,null);
});

test('clearing the map area invalidates a pending chat snapshot and searches the whole city',async t=>{
  const {root,listings,last,move}=await setup(t);await move(A);last('page').answer(page);await tick();
  const base=listings.filterSnapshot();
  const clear=[...root.querySelectorAll('button')].find(button=>button.textContent==='Search the whole city');clear.click();await tick();
  assert.equal(last('page').params.has('bounds'),false);assert.ok(listings.filterSnapshot().revision>base.revision);
  assert.equal(listings.applyFilterUpdate({base,values:{...base.values,maxPrice:500000}}),false);
});

test('manually changing map-following ends the old chat Undo group',async t=>{
  const {root,listings,last,move}=await setup(t);await move(A);update(listings,{maxPrice:500000});await tick();
  const follow=root.querySelector('.listings-follow input');follow.checked=false;follow.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();
  assert.equal(listings.filterSnapshot().values.followMap,false);assert.equal(last('page').params.has('bounds'),false);
  assert.equal(!!root.querySelector('[data-filter-action="undo"]'),false);
});

const {NYC_EXTENT}=await import('../public/core-model.js');
const {NYC_LIMITS,inCity}=await import('../public/nyc-boroughs.js');
const {mapOptions,outsideCity,addListingLayers,PALETTE,pinsBounds}=await import('../public/listings-map.js');
const signedArea=ring=>ring.reduce((sum,[x1,y1],i)=>{const [x2,y2]=ring[(i+1)%ring.length];return sum+(x2-x1)*(y2+y1);},0);
const inRing=([x,y],ring)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>y)!==(yj>y)&&x<((xj-xi)*(y-yi))/(yj-yi)+xi)inside=!inside;}return inside;};
const masked=(point,[outer,...holes])=>inRing(point,outer)&&!holes.some(hole=>inRing(point,hole));

test('with no saved view the map opens on the city limits with no padding',()=>{
  const {bounds,fitBoundsOptions}=mapOptions({},'light'),e=NYC_EXTENT;
  assert.deepEqual(bounds,[[e.west,e.south],[e.east,e.north]]);assert.equal(fitBoundsOptions.padding,0);
  const xs=NYC_LIMITS.flat().map(([x])=>x),ys=NYC_LIMITS.flat().map(([,y])=>y);
  const dx=(e.east-e.west)*.02,dy=(e.north-e.south)*.02;
  for(const [edge,limit,tolerance] of [[e.west,Math.min(...xs),dx],[e.east,Math.max(...xs),dx],[e.south,Math.min(...ys),dy],[e.north,Math.max(...ys),dy]])
    assert.ok(Math.abs(edge-limit)<=tolerance,'the opening extent frames the city limits within 2% on every side');
  const pin=(latitude,longitude)=>({latitude,longitude});
  assert.deepEqual(pinsBounds([pin(0,0),pin(40.744,-74.032),pin(40.68,-73.95),pin(null,null),pin(40.70,-73.90)]),[[-73.95,40.68],[-73.90,40.70]],'a pin geocoded across the Hudson does not widen the fit');
  assert.deepEqual(pinsBounds([pin(0,0)]),bounds);
});

// Neighborhoods and islands at the city's edges, and places just across its borders.
const EDGE_OF_CITY=[[-73.820,40.608],[-73.845,40.786],[-73.775,40.792],[-73.820,40.818],[-73.706,40.737],[-73.779,40.641],[-73.917,40.881],[-74.010,40.577],[-74.058,40.601],[-74.240,40.530],[-74.243,40.508],[-73.853,40.898],[-73.787,40.847],[-74.016,40.689],[-73.885,40.793],[-74.045,40.690]];
const ACROSS_BORDERS=[[-74.172,40.735],[-74.172,40.917],[-73.640,40.749],[-74.034,40.718],[-74.032,40.744],[-74.114,40.669],[-73.899,40.931],[-73.700,40.700],[-73.837,40.913]];
test('a mask dims everything outside the city limits and leaves every neighborhood clear',()=>{
  const rings=outsideCity().geometry.coordinates;
  for(const point of ACROSS_BORDERS){assert.ok(masked(point,rings),`${point} is dimmed`);assert.equal(inCity(point),false);}
  for(const point of EDGE_OF_CITY){assert.ok(!masked(point,rings),`${point} is clear`);assert.ok(inCity(point));}
  const outer=Math.sign(signedArea(rings[0]));
  assert.ok(rings.length===NYC_LIMITS.length+1&&rings.slice(1).every(hole=>Math.sign(signedArea(hole))===-outer),'holes wind against the outer ring');
});

test('the mask sits over the basemap in both themes, with pins and clusters drawn above it',()=>{
  for(const mode of ['light','dark']){
    const layers=[],map={addSource(){},addLayer(layer,before){layers.push({...layer,before});}};
    addListingLayers(map,PALETTE[mode],{listings:{type:'FeatureCollection',features:[]},active:{type:'FeatureCollection',features:[]},selected:{type:'FeatureCollection',features:[]}});
    const ids=layers.map(layer=>layer.id),mask=layers[ids.indexOf('outside-city')];
    assert.equal(mask.type,'fill');assert.equal(mask.before,undefined);
    assert.equal(mask.paint['fill-color'],PALETTE[mode].mask);assert.ok(mask.paint['fill-opacity']>=.4&&mask.paint['fill-opacity']<1);
    for(const id of ['clusters','cluster-count','pins','pin-active','pin-selected','pin-rank'])assert.ok(ids.indexOf(id)>ids.indexOf('outside-city'),`${id} draws above the mask`);
  }
});
