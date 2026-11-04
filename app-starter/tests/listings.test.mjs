import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';

const pub=new URL('../public/',import.meta.url);
const read=(name)=>readFileSync(new URL(name,pub),'utf8');
const {document,window}=parseHTML(read('index.html'));
globalThis.document=document;
globalThis.window=window;
const {createListings,parseAmount}=await import('../public/listings.js');
const {listingCard,photoAt}=await import('../public/listing-card.js');
const model=await import('../public/listings-model.js');
const {pinRows,pinsBounds}=await import('../public/listings-map.js');

const tick=()=>new Promise((r)=>setTimeout(r,0));
// Store rows as /market-store/deals returns them (camelCase).
const row=(id,{listPrice=2_400_000,bsf=240,verdict='good_deal'}={})=>({
  id,bbl:`30${id.padStart(8,'0')}`,address:`${id} Test Street`,borough:'BK',neighborhood:'Bushwick',zipCode:'11221',zoningDistrict:'R6A',style:'multi_family',
  latitude:40.69,longitude:-73.92,photoUrl:'https://ap.rdcpix.com/abc-m123s.jpg',url:'https://www.realtor.com/x',
  lotAreaSqft:2500,existingBldgAreaSqft:2000,builtFar:0.8,residFar:3,affResFar:3.9,maxStandardZfa:7500,maxUapZfa:9750,unusedUapZfa:7750,
  listPrice,uapPricePerBuildableZfa:listPrice?bsf:null,maxBuildableUnits:14,similarComps:[],
  flashcardValuation:{impliedYieldOnCostPct:6.4,impliedCondoMarginPct:21.5,dealVerdict:verdict,estimatedRedevValue:9_000_000,
    slidingScalePricePerBsf:{greatDealMaxBsf:150,goodDealMaxBsf:250,badDealMinBsf:350,greatDealMaxLandValue:1_500_000,goodDealMaxLandValue:2_500_000},
    basis:[{item:'hardCostPerGrossSqft',source:'House baseline',asOf:'2026-10-15'}]},
});
const settings={isCustom:false,dealSettings:{hardCostPerGrossSqft:375,softCostPctOfHard:.22,carryAndFinancingPct:.1,zfaToGrossFactor:1.15,greatDealCapRate:0.085,goodDealCapRate:0.0725,badDealCapRate:0.06,greatDealCondoMargin:0.28,goodDealCondoMargin:0.18,badDealCondoMargin:0.1}};
const page=(offset,count,total=45)=>({deals:Array.from({length:count},(_,i)=>row(String(offset+i+1))),total,offset,limit:20,userSettings:settings});

// Every request waits until the test answers it.
function stubStore(t){
  const requests=[];
  globalThis.fetch=(url,options={})=>new Promise((resolve)=>{
    const u=new URL(url,'http://x');
    requests.push({path:u.pathname,params:u.searchParams,options,answer:(body,ok=true)=>resolve({ok,headers:{get:()=>'application/json'},json:async()=>body})});
  });
  t.after(()=>{delete globalThis.fetch;});
  return requests;
}
const take=(requests,path)=>requests.filter((r)=>r.path===path);

// A map that records what the page asks of it.
function fakeMap(){
  const map={pins:null,fits:0,active:null,selected:null,handlers:null,
    setPins(p,{fit}={}){map.pins=p;if(fit)map.fits++;},setActive(id){map.active=id;},setSelected(id){map.selected=id;},
    bounds:()=>({south:40.6,west:-74,north:40.7,east:-73.9}),resize(){}};
  return {map,loadMap:async(_node,handlers)=>{map.handlers=handlers;return map;}};
}

function mount({canStart=()=>true,onUnderwrite=()=>{},onAsk=()=>{},onPlan}={}){
  const root=document.querySelector('#home-listings');
  root.replaceChildren();
  const {map,loadMap}=fakeMap();
  const listings=createListings({root,canStart,onUnderwrite,onAsk,onPlan,loadMap});
  return {root,listings,map};
}
const cardIds=(root)=>[...root.querySelectorAll('.listing-card')].map((c)=>c.dataset.listing);
const button=(root,name)=>[...root.querySelectorAll('button')].find((b)=>b.textContent.trim()===name);
const choose=(select,value)=>{
  for(const o of select.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);
  select.dispatchEvent(new window.Event('change'));
};

test('full chat state updates every control and query together, including custom headroom and preview costs, and Undo restores the full state', async(t)=>{
  const requests=stubStore(t),{root,listings}=mount(); listings.show(); await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,1));await tick();
  const pinsRequest=take(requests,'/api/market-store/deals/pins')[0];
  assert.equal(pinsRequest.options.cache,'no-cache','Map pins revalidate against the browser cache instead of downloading again');
  pinsRequest.answer({total:1,pins:[]}); await tick();
  const base=listings.filterSnapshot();
  const values={...base.values,borough:'BK',area:'11221',minPrice:null,maxPrice:1250000,maxPpb:175,minLot:2500,maxLot:5000,zoning:'R6A',minFar:1.75,tiers:['great_deal','good_deal'],types:['multi_family','land'],excludeRisk:true,excludeLandmarks:true,sortBy:'implied_yield_on_cost',followMap:false,hardCostPerGrossSqft:425,softCostPctOfHard:.25,carryAndFinancingPct:0,zfaToGrossFactor:1.2};
  assert.equal(listings.applyFilterUpdate({base,values}),true);await tick();
  const query=take(requests,'/api/market-store/deals').at(-1).params;
  for(const [key,value] of Object.entries({borough:'BK',area:'11221',maxListPrice:'1250000',maxPricePerBuildableZfa:'175',minLotArea:'2500',maxLotArea:'5000',zoningPrefix:'R6A',minHeadroomFar:'1.75',dealVerdict:'great_deal,good_deal',styles:'multi_family,land',excludeHighStabilizedRisk:'true',excludeLandmarks:'true',sortBy:'implied_yield_on_cost',hardCostPerGrossSqft:'425',softCostPctOfHard:'0.25',carryAndFinancingPct:'0',zfaToGrossFactor:'1.2'}))assert.equal(query.get(key),value,key);
  assert.equal(query.has('minListPrice'),false);assert.equal(query.has('bounds'),false);
  assert.equal(root.querySelector('select[aria-label="FAR headroom"]')?.value||[...root.querySelectorAll('select')].find(s=>s.parentNode.textContent.includes('FAR headroom')).value,'1.75');
  assert.deepEqual(listings.filterSnapshot().values,values);
  assert.equal(requests.some(r=>r.options.method==='PUT'),false,'Chat previews never save baseline costs');
  button(root,'Undo').click();await tick();assert.deepEqual(listings.filterSnapshot().values,base.values);
});

test('invalid or late chat states do not overwrite manual edits; explicit apply uses the current baseline', async(t)=>{
  const requests=stubStore(t),{root,listings,map}=mount();listings.show();await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,1));await tick();
  const base=listings.filterSnapshot(), update={base,values:{...base.values,borough:'BK',maxPrice:1250000}};
  choose(root.querySelector('.listings-filters select'),'QN');await tick();
  const count=requests.length;
  assert.equal(listings.applyFilterUpdate(update),false);assert.equal(requests.length,count);
  assert.equal(listings.filterSnapshot().values.borough,'QN');
  assert.match(root.querySelector('.listings-receipt').textContent,/current values are kept/);
  button(root,'Apply chat filters').click();await tick();assert.equal(listings.filterSnapshot().values.borough,'BK');
  assert.equal(take(requests,'/api/market-store/deals').at(-1).params.has('bounds'),false,'A new borough is searched before reframing, outside the previous map bounds');
  take(requests,'/api/market-store/deals/pins').at(-1).answer({pins:[],total:0});await tick();assert.equal(map.fits,1,'Chat borough changes reframe the map like manual filters');
  const current=listings.filterSnapshot();map.handlers.onMove({south:40.6,west:-74,north:40.7,east:-73.9});await tick();
  assert.equal(listings.applyFilterUpdate({base:current,values:{...current.values,area:'11221'}}),false,'A map move also makes an earlier snapshot stale');
  const before=listings.filterSnapshot();assert.equal(listings.applyFilterUpdate({base:before,values:{...before.values,softCostPctOfHard:25}}),false);assert.deepEqual(listings.filterSnapshot(),before);
});

test('home has a listings page mount, and no separate screen-listings entry',()=>{
  assert.ok(document.querySelector('#home-listings'));
  assert.equal(document.querySelector('#home-deals'),null);
  assert.equal(document.querySelector('[data-core-entry]'),null);
  assert.match(read('index.html'),/listings\.css/);
});

test('the store query carries every filter, a page slice or none for pins, and the map bounds for both',()=>{
  const f={...model.defaultFilters(),borough:'BK',area:' Bay Ridge ',zoning:'r6',minPrice:250000,maxPrice:3e6,minLot:2000,maxLot:9000,minFar:1,
    tiers:['great_deal','good_deal'],types:['land'],excludeRisk:true,excludeLandmarks:true};
  const box={south:40.6,west:-74.05,north:40.7,east:-73.9};
  const p=model.queryParams(f,{offset:40,bounds:box,costs:{hardCostPerGrossSqft:400}});
  assert.deepEqual(Object.fromEntries(p),{sortBy:'best_deal',minUnusedZfa:'250',borough:'BK',area:'Bay Ridge',zoningPrefix:'R6',minListPrice:'250000',maxListPrice:'3000000',
    minLotArea:'2000',maxLotArea:'9000',minHeadroomFar:'1',dealVerdict:'great_deal,good_deal',styles:'land',excludeHighStabilizedRisk:'true',excludeLandmarks:'true',
    hardCostPerGrossSqft:'400',limit:'20',offset:'40',includeSimilarComps:'false',bounds:'40.60000,-74.05000,40.70000,-73.90000'});
  const pins=model.queryParams(model.defaultFilters(),{bounds:box,pins:true});
  assert.equal(pins.get('bounds'),'40.60000,-74.05000,40.70000,-73.90000','pins cover the area the cards do, so their ranks are card numbers');
  assert.equal(model.queryParams(model.defaultFilters(),{pins:true}).get('bounds'),null,'without an area pins cover every match');
  assert.equal(pins.get('limit'),null);
  assert.equal(pins.get('minListPrice'),String(model.DEFAULT_MIN_PRICE),'the page starts above the price floor');
});

test('a deal store search from the chat becomes page filters, keeping defaults it left unset',()=>{
  const f=model.filtersFromSearch({borough:'Brooklyn',zipCode:'11215',dealVerdict:'great_deal,good_deal',maxListPrice:3e6,styles:['land','condos'],minHeadroomFar:1.5,sortBy:'implied_yield_on_cost',excludeHighStabilizedRisk:true,minUnusedZfa:500});
  assert.equal(f.borough,'BK');
  assert.equal(f.area,'11215');
  assert.deepEqual(f.tiers,['great_deal','good_deal']);
  assert.deepEqual(f.types,['land'],'only property types the page offers');
  assert.equal(f.minPrice,model.DEFAULT_MIN_PRICE);
  assert.equal(f.maxPrice,3e6);
  assert.equal(f.minFar,1.5);
  assert.equal(f.sortBy,'implied_yield_on_cost');
  assert.equal(f.excludeRisk,true);
  assert.equal(model.filtersFromSearch({borough:'MN',sortBy:'nonsense'}).sortBy,'best_deal');
  const ppb=model.filtersFromSearch({maxPricePerBuildableZfa:300,zipCode:'11211',area:'Williamsburg'});
  assert.equal(ppb.maxPpb,300);
  assert.equal(ppb.area,'11211','a ZIP is the narrower area');
  assert.equal(model.queryParams(ppb).get('maxPricePerBuildableZfa'),'300');
  assert.deepEqual(model.describeFilters(f),['Brooklyn','11215','ask $100K to $3M','at least +1.5 FAR unused','Great or Good deals','Land','no rent-stabilization risk']);
});

test('a message from the page carries the filters, the open listing and the first cards, and shows only the question',()=>{
  const deals=[row('1'),row('2',{listPrice:null})];
  const context=model.listingsContext({filters:{...model.defaultFilters(),borough:'QN'},total:42,deals,selected:deals[0]});
  assert.doesNotMatch(model.listingsContext({filters:{...model.defaultFilters(),area:'a]b['},total:1}),/[[\]]/,'no bracket ends the note early');
  assert.match(context,/^Deals page: 42 NYC listings for sale \(Queens, ask \$100K\+\), sorted by best deals\./);
  assert.match(context,/Open listing: 1 Test Street, BBL 3000000001, R6A, ask \$2\.4M\./);
  assert.match(context,/First on the page: 1 Test Street.*; 2 Test Street, BBL 3000000002, R6A, unpriced\./);
  const message=model.withListingsContext('Which is best?',context);
  assert.deepEqual(model.splitListingsContext(message),{context,text:'Which is best?'});
  assert.deepEqual(model.splitListingsContext('Plain question'),{context:null,text:'Plain question'});
  assert.equal(model.withListingsContext('x'.repeat(2990),context),'x'.repeat(2990),'too long with the context: the question alone');
});

test('amounts read with k and m suffixes, and map bounds wrap the pins or fall back to the city',()=>{
  assert.equal(parseAmount('250k'),250000);
  assert.equal(parseAmount('$1.5M'),1500000);
  assert.equal(parseAmount('2,000,000'),2000000);
  assert.equal(parseAmount(''),null);
  assert.equal(parseAmount('abc'),null);
  assert.deepEqual(pinsBounds([{latitude:40.6,longitude:-74},{latitude:40.7,longitude:-73.9}]),[[-74,40.6],[-73.9,40.7]]);
  assert.equal(pinsBounds([]).length,2);
  const rows=[{id:'1',latitude:40.6,longitude:-74}];
  assert.equal(pinRows(rows),rows,'pins from research before the columnar body pass through');assert.deepEqual(pinRows(undefined),[]);
});

test('a card shows the photo at a usable size, the tier, address, place and the four figures',()=>{
  const card=listingCard(row('7',{verdict:'great_deal'}),{onOpen:()=>{}});
  assert.equal(card.querySelector('.verdict-pill').textContent,'Great deal');
  assert.equal(card.querySelector('.listing-card-open').textContent,'7 Test Street');
  assert.equal(card.querySelector('.listing-card-place').textContent,'Bushwick 11221 · R6A · Multifamily');
  assert.equal(card.querySelector('img').getAttribute('src'),'https://ap.rdcpix.com/abc-m123rd-w480_h360.jpg');
  const figures=Object.fromEntries([...card.querySelectorAll('.listing-card-figures > div')].map((d)=>[d.querySelector('dt').textContent,d.querySelector('dd').textContent]));
  assert.deepEqual(figures,{Ask:'$2.40M','$/BSF':'$240',Headroom:'+3.10 FAR',Returns:'6.4% yield, 22% margin'});
  const unpriced=listingCard(row('8',{listPrice:null,verdict:'unpriced_opportunity'}),{onOpen:()=>{}});
  assert.equal(unpriced.querySelector('dd').textContent,'Unpriced');
  assert.equal(photoAt('https://example.com/a.jpg',480,360),'https://example.com/a.jpg');
});

test('a whole card is one target: the address button covers it, takes the one tab stop, and lifts its pin',async(t)=>{
  const requests=stubStore(t);
  const {root,listings,map}=mount();
  listings.show();await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,20));await tick();
  take(requests,'/api/market-store/deals/pins')[0].answer({total:45,pins:[]});
  await tick();await tick();
  const card=root.querySelector('.listing-card');
  const open=card.querySelector('.listing-card-open');
  assert.equal(open.tagName,'BUTTON','a native button, so Enter and Space open it');
  assert.equal(open.type,'button');
  assert.equal(open.textContent,'1 Test Street','named by the address');
  const stops=[...card.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((n)=>!n.disabled&&Number(n.getAttribute('tabindex')??0)>=0);
  assert.deepEqual(stops,[open],'one tab stop per card');
  open.dispatchEvent(new window.Event('focusin',{bubbles:true}));
  assert.equal(map.active,'1','focus lifts the pin');
  open.dispatchEvent(new window.Event('focusout',{bubbles:true}));
  assert.equal(map.active,null);
  card.dispatchEvent(new window.Event('pointerenter'));
  assert.equal(map.active,'1','hover lifts the pin');
  open.click();await tick();
  assert.ok(take(requests,'/api/market-store/deals/1')[0],'the button opens the listing');

  const tagged=row('9');
  tagged.flashcardValuation={...tagged.flashcardValuation,mih:{status:'inside',area:'Area 1',appliedOption:'Option 1'}};
  const opened=[];
  const taggedCard=listingCard(tagged,{onOpen:(id)=>opened.push(id)});
  const tag=taggedCard.querySelector('.listing-card-mih');
  assert.ok(tag.title,'the tag keeps its explanation on hover');
  tag.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.deepEqual(opened,['9'],'a click on the tag above the button still opens the listing');

  // Every stylesheet that restyles the card: nothing between the card and the button may become the
  // containing block of the button's ::after, or the target shrinks back to the address.
  const rules=(name)=>[...read(name).replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,sel,body])=>({sel:sel.trim(),body}));
  const subject=(sel)=>sel.split(',').map((s)=>s.trim().split(/[\s>+~]+/).pop());
  const all=['listings.css','surfaces.css','workspace-shell.css'].flatMap((name)=>rules(name).map((r)=>({...r,name})));
  for(const {sel,body,name} of all)for(const part of subject(sel)){
    if(/\.listing-card-(body|title|open)(?![-\w])/.test(part)&&!part.includes('::'))assert.doesNotMatch(body,/(^|;)\s*position:\s*(?!static)/,`${name}: ${sel} leaves the card as the target's bounds`);
  }
  const one=(sel)=>all.filter((r)=>r.name==='listings.css'&&r.sel===sel).map((r)=>r.body);
  assert.match(one('.listing-card')[0],/position: relative;/,'the card bounds the button\'s target');
  assert.match(one('.listing-card-open::after')[0],/content: "";[^}]*position: absolute;[^}]*inset: 0;/,'the button\'s target fills the card');
  assert.doesNotMatch(one('.listing-card-open::after')[0],/z-index/,'the target stays under the tag');
  assert.match(one('.listing-card-mih')[0],/position: absolute;[^}]*z-index: 1;/,'the tag sits above the target');
  const css=read('listings.css');
  const supports=css.match(/@supports selector\(:has\(\*\)\) \{([\s\S]*?)\n\}/)?.[1]||'';
  assert.match(supports,/\.listing-card:has\(\.listing-card-open:focus-visible\) \{[^}]*outline: 2px solid[^}]*outline-offset: -\d+px;/,'keyboard focus rings the whole card, inside its edge');
  assert.match(supports,/\.listing-card-open:focus-visible \{ outline: none; \}/,'the card ring replaces the button ring only where :has() works');
  assert.match(one('.listing-card-open:focus-visible')[0],/outline: 2px solid/,'without :has() the button keeps its own ring');
});

test('the page loads ranked cards and every pin, and shows the count',async(t)=>{
  const requests=stubStore(t);
  const {root,listings,map}=mount();
  assert.equal(requests.length,0,'nothing loads until home shows the page');
  listings.show();listings.show();
  await tick();
  const [deals]=take(requests,'/api/market-store/deals');
  assert.equal(take(requests,'/api/market-store/deals').length,1,'showing home twice loads once');
  assert.equal(deals.params.get('sortBy'),'best_deal');
  assert.equal(deals.params.get('offset'),'0');
  assert.equal(take(requests,'/api/market-store/deals/pins').length,0,'Initial pins wait for the page cost baseline');
  const shuffled=page(0,20);shuffled.deals.reverse();
  deals.answer(shuffled);await tick();
  const [pins]=take(requests,'/api/market-store/deals/pins');
  assert.equal(pins.params.get('limit'),null);
  assert.equal(pins.params.get('hardCostPerGrossSqft'),'375','The map uses the page cost snapshot');
  pins.answer({total:45,pins:{id:['1'],rank:[1],address:['1 Main St'],latitude:[40.69],longitude:[-73.92],dealVerdict:['good_deal'],listPrice:[900000]}});
  await tick();await tick();
  assert.deepEqual(cardIds(root),shuffled.deals.map((d)=>d.id),'cards keep the store order');
  assert.equal(root.querySelector('.listings-status').textContent,'45 listings');
  assert.equal(root.querySelector('.listings-range').textContent,'1 to 20 of 45');
  assert.deepEqual(map.pins,[{id:'1',rank:1,address:'1 Main St',latitude:40.69,longitude:-73.92,dealVerdict:'good_deal',listPrice:900000}],'columnar pins reach the map as one row per pin');
  assert.equal(map.fits,1,'the first pins frame the map');
  assert.equal(root.querySelector('.listings-pop.is-set summary').textContent,'Price: $100K+');
});

test('a filter change reloads the first page and the pins; a map move reloads both in its bounds',async(t)=>{
  const requests=stubStore(t);
  const {root,listings,map}=mount();
  listings.show();await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,20));await tick();
  take(requests,'/api/market-store/deals/pins')[0].answer({total:45,pins:[]});
  await tick();await tick();
  choose(root.querySelector('.listings-filters select'),'QN');
  await tick();
  const [,deals]=take(requests,'/api/market-store/deals');
  const [,pins]=take(requests,'/api/market-store/deals/pins');
  assert.equal(deals.params.get('borough'),'QN');
  assert.equal(pins.params.get('borough'),'QN');
  deals.answer(page(0,3,3));pins.answer({total:3,pins:[]});
  await tick();await tick();
  assert.equal(map.fits,2,'new results frame the map again');
  map.handlers.onMove({south:40.7,west:-73.95,north:40.75,east:-73.9});
  await tick();
  const moved=take(requests,'/api/market-store/deals').at(-1);
  assert.equal(moved.params.get('bounds'),'40.70000,-73.95000,40.75000,-73.90000');
  const movedPins=take(requests,'/api/market-store/deals/pins');
  assert.equal(movedPins.length,3,'a move reloads the pins for the area the cards cover');
  assert.equal(movedPins.at(-1).params.get('bounds'),'40.70000,-73.95000,40.75000,-73.90000');
  moved.answer(page(0,2,2));await tick();
  assert.equal(root.querySelector('.listings-status').textContent,'2 listings in the map area');
});

test('a newer request wins over a slower one',async(t)=>{
  const requests=stubStore(t);
  const {root,listings}=mount();
  listings.show();await tick();
  choose(root.querySelector('.listings-filters select'),'MN');await tick();
  const [slow,fast]=take(requests,'/api/market-store/deals');
  fast.answer(page(0,1,1));await tick();
  slow.answer(page(0,20));await tick();
  assert.equal(cardIds(root).length,1);
});

test('opening a listing shows the inspector with its envelope, scale, projections, comps and basis; Back returns to the cards',async(t)=>{
  const requests=stubStore(t);
  const underwrites=[];const asks=[];
  const {root,listings,map}=mount({onUnderwrite:(deal,prompt)=>underwrites.push([deal.address,prompt]),onAsk:(deal)=>asks.push(deal.address)});
  listings.show();await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,20));await tick();
  take(requests,'/api/market-store/deals/pins')[0].answer({total:45,pins:[]});
  await tick();await tick();
  root.querySelector('.listing-card .listing-card-open').click();
  await tick();
  const [detail]=take(requests,'/api/market-store/deals/1');
  assert.ok(detail,'the listing loads with its comparables');
  assert.equal(map.selected,'1');
  detail.answer({deal:{...row('1'),similarComps:[{address:'9 Comp Ave',listingType:'sold',priceBasis:'reported_sale',price:2100000,buildableZfa:10000,buildableZfaBasis:'uap_zfa',soldDate:'2026-09-01',zoningDistrict:'R6',distanceMiles:0.31,pricePerBuildableZfa:210,similarityScore:82}]},userSettings:settings});
  await tick();
  const inspector=root.querySelector('.listing-inspector');
  assert.ok(inspector);
  assert.equal(root.querySelector('.listings-list').hidden,true);
  // The More menu names the other actions with a line on each; section headings exclude its summary.
  const menu=inspector.querySelector('.inspector-menu');
  assert.deepEqual([...menu.querySelectorAll('.inspector-menu-item > .home-follow')].map((b)=>b.textContent),['Underwrite to keep','Ask about this listing','Copy link','View listing']);
  assert.equal(menu.querySelectorAll('.inspector-menu-what').length,4);
  assert.match(inspector.querySelector('.inspector-action-reason').textContent,/what you can build/);
  const headings=[...inspector.querySelectorAll('h3, summary:not(.inspector-more > summary)')].map((h)=>h.textContent);
  assert.deepEqual(headings,['How the tier is set','Price per buildable SF scale','Zoning envelope','Projections at your costs','Delivery','Comparables','Basis for these figures']);
  assert.match(inspector.querySelector('.inspector-comps').textContent,/9 Comp Ave.*Sold 2026-09-01 · R6 · 0\.31 mi.*\$210\/BSF.*Match score 82\/100/);
  assert.doesNotMatch(inspector.querySelector('.inspector-comps').textContent,/% similar/);
  assert.match(listings.context(),/Open listing: 1 Test Street/);
  button(inspector,'Underwrite').click();
  assert.equal(underwrites[0][0],'1 Test Street');
  assert.match(underwrites[0][1],/^Underwrite 1 Test Street/);
  button(inspector,'Ask about this listing').click();
  assert.deepEqual(asks,['1 Test Street']);
  button(inspector,'Back to results').click();
  assert.equal(root.querySelector('.listing-inspector'),null);
  assert.equal(root.querySelector('.listings-list').hidden,false);
  assert.equal(map.selected,null);
});

test('Floor plan & 3D shows on a listing only when the account has the architecture tools, and asks for a drafted plan and walkthrough',async(t)=>{
  for(const enabled of [false,true]){
    const requests=stubStore(t);
    const plans=[];
    const {root,listings}=mount({onPlan:()=>enabled?(deal,prompt)=>plans.push([deal.address,prompt]):null});
    listings.show();await tick();
    take(requests,'/api/market-store/deals')[0].answer(page(0,20));await tick();
    take(requests,'/api/market-store/deals/pins')[0].answer({total:45,pins:[]});
    await tick();await tick();
    root.querySelector('.listing-card .listing-card-open').click();await tick();
    take(requests,'/api/market-store/deals/1')[0].answer({deal:row('1'),userSettings:settings});await tick();
    const plan=[...root.querySelectorAll('.listing-inspector button')].find(b=>b.textContent==='Model this property');
    if(!enabled){assert.equal(plan,undefined);continue;}
    plan.click();
    assert.equal(plans[0][0],'1 Test Street');
    assert.match(plans[0][1],/^Model 1 Test Street \(BBL 3000000001\): draft a floor plan from a published drawing or recorded dimensions, then a 3D walkthrough\. On record: lot 2,500 SF, R6A, 9,750 SF buildable, 14 most units allowed\. State the drawing and assumptions\. Skip underwriting\. Listing: https:\/\/www\.realtor\.com\/x$/);
    // The lot and program it carries add a line; the request still reads as a short message.
    assert.ok(plans[0][1].length<330,'the request reads in the chat as a short message');
  }
});

test('a search from the chat replaces the filters with a receipt, and Undo restores the reader\'s own',async(t)=>{
  const requests=stubStore(t);
  const {root,listings}=mount();
  listings.show();await tick();
  choose(root.querySelector('.listings-filters select'),'MN');await tick();
  listings.applySearch({borough:'Brooklyn',dealVerdict:'great_deal'});
  await tick();
  const last=take(requests,'/api/market-store/deals').at(-1);
  assert.equal(last.params.get('borough'),'BK');
  assert.equal(last.params.get('dealVerdict'),'great_deal');
  const receipt=root.querySelector('.listings-receipt');
  assert.equal(receipt.hidden,false);
  assert.match(receipt.textContent,/^Filters updated from the chat: Brooklyn, ask \$100K\+, Great deals\.Undo$/);
  listings.applySearch({borough:'Queens',listingType:'sold'});await tick();
  assert.match(receipt.textContent,/Queens.*This page shows listings for sale\./);
  button(receipt,'Undo').click();await tick();
  assert.equal(take(requests,'/api/market-store/deals').at(-1).params.get('borough'),'MN','Undo returns to the reader\'s own filters');
  assert.equal(receipt.hidden,true);
});

test('a failed page says why with Try again, and an empty result offers to clear the filters',async(t)=>{
  const requests=stubStore(t);
  const {root,listings}=mount();
  listings.show();await tick();
  take(requests,'/api/market-store/deals')[0].answer({error:'The store is busy.',userFacing:true},false);
  await tick();await tick();
  assert.equal(root.querySelector('.listings-error [role="alert"]').textContent,'The store is busy.');
  button(root,'Try again').click();await tick();
  take(requests,'/api/market-store/deals')[1].answer(page(0,0,0));
  await tick();await tick();
  assert.equal(root.querySelector('.listings-empty p').textContent,'No listings match these filters.');
  assert.ok(button(root,'Clear filters'));
  assert.equal(root.querySelector('.listings-pager').hidden,true);
});

test('saving costs stores them as the reader\'s baseline and reloads the listings',async(t)=>{
  const requests=stubStore(t);
  const {root,listings}=mount();
  listings.show();await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,20));await tick();await tick();
  const costs=root.querySelector('.listings-costs');
  const hard=costs.querySelector('input');
  assert.equal(hard.value,'375');
  hard.value='420';hard.dispatchEvent(new window.Event('input',{bubbles:true}));
  button(costs,'Save as my costs').click();await tick();
  const [put]=take(requests,'/api/market-store/user-settings');
  assert.equal(put.options.method,'PUT');
  assert.equal(JSON.parse(put.options.body).dealSettings.hardCostPerGrossSqft,420);
  put.answer({isCustom:true,dealSettings:{...settings.dealSettings,hardCostPerGrossSqft:420}});
  await tick();await tick();
  assert.equal(take(requests,'/api/market-store/deals').length,2,'the listings reload at the saved costs');
  assert.equal(root.querySelector('.listings-pop.listings-costs, .listings-costs').closest('details').querySelector('summary').textContent,'Costs: $375/GSF','Old results are not relabeled by a saved-default acknowledgement');
  take(requests,'/api/market-store/deals')[1].answer({...page(0,20),userSettings:{isCustom:true,dealSettings:{...settings.dealSettings,hardCostPerGrossSqft:420}}});await tick();
  assert.equal(root.querySelector('.listings-pop.listings-costs, .listings-costs').closest('details').querySelector('summary').textContent,'Costs: $420/GSF');
});

test('the legend keeps its items across result refreshes and explains tiers without a native title tooltip', async(t)=>{
  const requests=stubStore(t),{root,listings}=mount(); listings.show(); await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,20));await tick();
  const legend=root.querySelector('.listings-legend');
  const great=legend.querySelector('.verdict-great');
  assert.equal(great.getAttribute('title'),null,'a title would be a native tooltip, which Chrome leaves on screen when the legend is rebuilt under the pointer');
  assert.equal(great.dataset.note,'ask ≤70% of nearby land sales, or ≥8.5% yield or ≥28% margin without them');
  assert.match(great.textContent,/≥8\.5% yield or ≥28% margin/,'the note is in the item for assistive technology');
  listings.applyFilterUpdate({base:listings.filterSnapshot(),values:{...listings.filterSnapshot().values,borough:'BK'}});await tick();
  take(requests,'/api/market-store/deals').at(-1).answer(page(0,20));await tick();
  assert.equal(legend.querySelector('.verdict-great'),great,'same thresholds, same legend item');
});

test('Back restoration keeps the feed page, scroll, card focus and map size',async(t)=>{
  const requests=stubStore(t),{root,listings,map}=mount(); let resizes=0; map.resize=()=>{resizes++;}; listings.show(); await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,10,30));await tick();
  button(root,'Next').click();await tick();take(requests,'/api/market-store/deals')[1].answer(page(10,10,30));await tick();
  take(requests,'/api/market-store/deals/pins')[0].answer({total:1,pins:[]}); await tick();
  const section=root.querySelector('.listings');
  const pane=root.querySelector('.listings-results');pane.scrollTop=340;const opener=root.querySelector('.listing-card .listing-card-open');let focused=false;opener.focus=options=>{assert.equal(options.preventScroll,true);focused=true;};opener.click();await tick();
  assert.equal(section.classList.contains('is-inspecting'),true,'the inspector replaces the search page, map included');
  take(requests,'/api/market-store/deals/11')[0].answer({deal:row('11'),userSettings:settings}); await tick();
  const before=resizes;
  listings.inspect(null);await tick();
  assert.equal(pane.scrollTop,340);assert.equal(focused,true);assert.match(root.querySelector('nav[aria-label="Result pages"]').textContent,/11 to 20 of 30/);assert.equal(take(requests,'/api/market-store/deals').length,2);
  assert.equal(section.classList.contains('is-inspecting'),false);
  assert.equal(resizes,before+1,'the map is resized once it is visible again');
});

test('the MIH filter reaches the store query and the chat, and MIH-priced listings show their option',async(t)=>{
  assert.equal(model.queryParams(model.defaultFilters()).get('mihArea'),null);
  assert.equal(model.queryParams({...model.defaultFilters(),mih:'inside'}).get('mihArea'),'inside');
  assert.equal(model.filtersFromSearch({mihArea:'outside'}).mih,'outside');
  assert.equal(model.filtersFromSearch({mihArea:'nearby'}).mih,'');
  assert.deepEqual(model.describeFilters({...model.defaultFilters(),mih:'inside'}),['ask $100K+','in MIH areas']);

  const mih={status:'inside',area:'Example Rezoning',adopted:'2018-01-31',mappedOptions:['Option 1','Option 3'],appliedOption:'Option 3',affordableShare:0.2,amiPct:40,
    note:"Priced on Option 3, the least restrictive at this site's rents and costs of the mapped options (Option 1, Option 3)."};
  const inside=row('9');inside.flashcardValuation={...inside.flashcardValuation,mih,valueDriver:{program:'option3',exit:'rental',buildableZfa:9750,affordableZfa:1950,storeys:7,floorplateSqft:1400,netEfficiency:0.8,heightClass:'mid-rise',hardCostPerGrossSqft:420}};
  const badge=listingCard(inside,{onOpen:()=>{}}).querySelector('.listing-card-mih');
  assert.equal(badge.textContent,'MIH · Option 3');
  assert.match(badge.title,/Example Rezoning\. Priced on Option 3, the least restrictive/);
  assert.equal(listingCard(row('10'),{onOpen:()=>{}}).querySelector('.listing-card-mih'),null);
  const {valueDriverLabel}=await import('../public/deals.js');
  assert.equal(valueDriverLabel({program:'option3',exit:'rental'}),'Rental with MIH Option 3');
  assert.equal(valueDriverLabel({program:'mih_exempt',exit:'condo'}),'Condo sales under the MIH small-project exemption');

  const requests=stubStore(t);
  const {root,listings}=mount();
  listings.show();await tick();
  take(requests,'/api/market-store/deals')[0].answer(page(0,20));await tick();
  take(requests,'/api/market-store/deals/pins')[0].answer({total:45,pins:[]});
  await tick();await tick();
  const select=[...root.querySelectorAll('.listings-drawer select')].find((s)=>[...s.options].some((o)=>o.value==='inside'));
  choose(select,'inside');
  await tick();
  assert.equal(take(requests,'/api/market-store/deals')[1].params.get('mihArea'),'inside');
  root.querySelector('.listing-card .listing-card-open').click();
  await tick();
  take(requests,'/api/market-store/deals/1')[0].answer({deal:{...inside,id:'1'},userSettings:settings});
  await tick();
  const inspector=root.querySelector('.listing-inspector');
  assert.ok([...inspector.querySelectorAll('.inspector-pill')].some((p)=>p.textContent==='MIH · Option 3'));
  assert.match(inspector.textContent,/MIH set-asideOption 3: 20% of residential floor area at 40% AMI on average/);
  assert.match(inspector.textContent,/With MIH affordable housing/);
});

test('on a phone the find and filter fields are 16px, so focusing one does not zoom the page', () => {
  const css = read('listings.css');
  const phone = css.slice(css.indexOf('@media (max-width: 850px)'));
  assert.match(phone, /\.listings-find-field input, \.listings-field input \{ font-size: 16px; \}/);
});

test('an open listing shows only its way back above it, and on phones its More menu rises as a sheet', () => {
  const css = read('listings.css');
  assert.match(css, /\.listings\.is-inspecting \.listings-bar \{ display: none; \}/, 'the result count and sort do not sit above a single listing');
  const phone = css.slice(css.indexOf('Phones: the listing\'s More menu rises as a bottom sheet'));
  assert.match(phone, /@media \(max-width: 600px\) \{\s*\.inspector-menu:popover-open \{\s*inset: auto 0 0 0 !important;/);
});
