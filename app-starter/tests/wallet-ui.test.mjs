import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

// wallet.js and admin.js are page modules that wire themselves to the DOM on import, so each case
// installs a fresh document and imports a fresh copy of the module.
let copies=0;
async function mount(file,fetchImpl,{search=''}={}) {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document,window}=parseHTML(html);
  window.location={search,pathname:'/',hash:'',assign(){}};
  for(const id of ['#wallet-dialog','#admin-dialog']){const dialog=document.querySelector(id);dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};}
  Object.assign(globalThis,{document,window,history:{replaceState(){}},fetch:fetchImpl});
  await import(`../public/${file}?copy=${++copies}`);
  await new Promise(resolve=>setImmediate(resolve));
  return {document,window};
}
const json=(body,{ok=true,status=200}={})=>async()=>({ok,status,headers:{get:()=> 'application/json'},json:async()=>body});
// The plan dialog reads /api/plan and /api/wallet; each path answers with its own body.
const routes=bodies=>async url=>{const body=bodies[String(url).split('?')[0]];return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>body};};
const FREE={plan:'free',used:0,limit:null,resetsAt:Date.UTC(2026,10,1),subscription:null,manageable:false,checkoutAvailable:false};
const renderWallet=(wallet,plan=FREE)=>mount('wallet.js',routes({'/api/plan':plan,'/api/wallet':wallet}));

test('wallet leads with the balance, offers one default top-up and lists activity in plain words',async()=>{
  const now=Date.now();
  const wallet={enabled:true,checkoutAvailable:true,availableMicros:998766,heldMicros:1_000_000,balanceMicros:1998766,policy:{rates:{codex:{mode:'estimated_call',amountMicros:1234,reserveMicros:10000,basis:'Subscription allocation',version:'v1'}}},entries:[
    {kind:'usage',provider:'exa',operation:'EXA_SEARCH',estimated:false,basis:'<script>not executable</script>',deltaMicros:-1234,at:now,runId:'r1aaaaaaaa',conversationTitle:'120 Broadway'},
    {kind:'usage',provider:'codex',operation:'codex',estimated:true,basis:'Subscription allocation',deltaMicros:-2000,at:now,runId:'r1aaaaaaaa'},
    {kind:'usage',provider:'openai',operation:'research',estimated:true,basis:'token estimate',deltaMicros:-500,at:now,runId:'r2bbbbbbbb'},
    {kind:'topup',deltaMicros:10_000_000,at:new Date(now).setSeconds(42)},
  ]};
  const {document}=await renderWallet(wallet);const content=document.querySelector('#wallet-content');
  assert.match(content.querySelector('.wallet-balance:not(.plan-summary)').textContent,/\$0\.998766/);
  assert.match(content.querySelector('.plan-summary').textContent,/Free plan/);
  assert.equal(content.querySelectorAll('.wallet-primary').length,1,'one primary top-up action');
  assert.equal(content.querySelector('.wallet-primary').textContent,'Add $25','the default amount is preselected');
  assert.deepEqual([...content.querySelectorAll('.wallet-amount')].map(b=>b.getAttribute('aria-checked')),['false','true','false']);
  content.querySelector('.wallet-amount[data-cents="5000"]').click();
  assert.equal(content.querySelector('.wallet-primary').textContent,'Add $50');
  const rows=[...content.querySelectorAll('.wallet-transactions li')].map(li=>li.textContent);
  assert.equal(rows.length,3,'charges for one research request are combined');
  assert.match(rows[0],/Research on 120 Broadway/);assert.match(rows[0],/\$0\.003234/);assert.match(rows[0],/Estimated cost/);
  assert.match(rows[1],/Research request/);assert.match(rows[2],/Credits added/);
  assert.doesNotMatch(content.textContent,/r1aaaaaa|exa|codex|openai|token estimate|EXA_SEARCH|not executable/);
  assert.doesNotMatch(rows[2],/\d:\d\d:\d\d/,'times show no seconds');
  assert.equal(content.querySelectorAll('script').length,0);
});

test('visual charges identify the action and preserve fractional-cent precision',async()=>{
  const now=Date.now(),wallet={enabled:true,checkoutAvailable:false,availableMicros:10000,heldMicros:0,balanceMicros:10000,policy:{rates:{}},entries:[
    {kind:'usage',operation:'meta_visual_segment',runId:'segment',deltaMicros:-2500,at:now},
    {kind:'usage',operation:'meta_visual_illustrate',runId:'illustration',deltaMicros:-1,at:now},
  ]};
  const {document}=await renderWallet(wallet);
  const rows=[...document.querySelectorAll('.wallet-transactions li')].map(li=>li.textContent);
  assert.match(rows[0],/Photo selection/);assert.match(rows[0],/\$0\.0025/);
  assert.match(rows[1],/Housing illustration/);assert.match(rows[1],/\$0\.000001/);
});

test('a free plan shows this month\'s usage and one upgrade, yearly first, with no credit top-ups',async()=>{
  const plan={...FREE,used:3,limit:10,checkoutAvailable:true};
  const {document,window}=await renderWallet({enabled:false,entries:[]},plan);
  const content=document.querySelector('#wallet-content');
  assert.match(content.querySelector('.plan-summary').textContent,/3 of 10 free research runs used/);
  assert.match(content.querySelector('.plan-summary').textContent,/Resets Nov 1/);
  assert.equal(content.querySelector('.plan-meter').getAttribute('aria-valuenow'),'3');
  assert.equal(content.querySelectorAll('.wallet-primary').length,1);
  assert.equal(content.querySelector('.wallet-primary').textContent,'Upgrade to Pro');
  assert.deepEqual([...content.querySelectorAll('.plan-interval')].map(b=>[b.dataset.interval,b.getAttribute('aria-checked')]),[['year','true'],['month','false']]);
  assert.match(content.textContent,/\$600 \/ year/);assert.match(content.textContent,/\$100 \/ month/);
  assert.doesNotMatch(content.textContent,/Add \$|not enabled|pilot/);
  assert.equal(document.querySelector('#wallet-button .rail-label').textContent,'Plan');
  assert.equal(document.querySelector('#wallet-balance').textContent,'3/10');
  let posted,assigned;
  globalThis.fetch=async(url,options)=>{posted={url,body:JSON.parse(options.body)};return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({url:'https://checkout.stripe.com/c/pay/cs_test'})};};
  window.location.assign=href=>{assigned=href;};
  content.querySelector('.plan-interval[data-interval="month"]').click();
  content.querySelector('.wallet-primary').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(posted.url,'/api/plan/checkout');assert.equal(posted.body.interval,'month');
  assert.equal(assigned,'https://checkout.stripe.com/c/pay/cs_test');
});

test('upgrades stay visible but closed until checkout is configured',async()=>{
  const {document}=await renderWallet({enabled:false,entries:[]},{...FREE,used:1,limit:10});
  assert.equal(document.querySelector('.wallet-primary').disabled,true);
  assert.match(document.querySelector('#wallet-content').textContent,/Upgrades open soon/);
});

test('Pro shows renewal and Manage billing; the team plan shows unlimited with no actions',async()=>{
  {
    const pro={...FREE,plan:'pro',used:42,subscription:{status:'active',interval:'year',currentPeriodEnd:Date.UTC(2027,9,20,15),cancelAtPeriodEnd:false},manageable:true};
    const {document}=await renderWallet({enabled:false,entries:[]},pro);
    const text=document.querySelector('#wallet-content').textContent;
    assert.match(text,/Arosa Pro/);assert.match(text,/Unlimited research/);assert.match(text,/Billed yearly/);assert.match(text,/Renews Oct 20, 2027/);assert.match(text,/42 research runs this month/);
    assert.equal(document.querySelectorAll('.plan-manage').length,1);assert.equal(document.querySelectorAll('.wallet-primary').length,0);
    assert.equal(document.querySelector('#wallet-balance').textContent,'Pro');
  }
  {
    const {document}=await renderWallet({enabled:false,entries:[]},{...FREE,plan:'team',used:109});
    const text=document.querySelector('#wallet-content').textContent;
    assert.match(text,/Team access/);assert.match(text,/109 research runs this month/);
    assert.equal(document.querySelectorAll('.plan-manage, .wallet-primary').length,0);
    assert.equal(document.querySelector('#wallet-balance').hidden,true);
  }
});

test('reaching the free allowance opens the plan with the reason',async()=>{
  const {document,window}=await renderWallet({enabled:false,entries:[]},{...FREE,used:10,limit:10,checkoutAvailable:true});
  const dialog=document.querySelector('#wallet-dialog');assert.equal(Boolean(dialog.open),false);
  window.dispatchEvent(new window.CustomEvent('acres:plan-limit',{detail:{message:'You have used your 10 free research runs this month.'}}));
  assert.equal(dialog.open,true);
  assert.match(document.querySelector('#wallet-notice').textContent,/10 free research runs/);
});

test('wallet shows a skeleton while loading, refreshes when opened and offers Retry when it fails',async()=>{
  let calls=0,fail=true;
  const {document}=await mount('wallet.js',async url=>{calls++;if(fail)throw new Error('Your plan could not load.');return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>(String(url)==='/api/plan'?FREE:{enabled:false,entries:[]})};});
  const content=document.querySelector('#wallet-content');
  assert.match(content.textContent,/could not connect/);assert.doesNotMatch(content.textContent,/Loading…/);
  fail=false;content.querySelector('.wallet-retry').click();
  assert.ok(content.querySelector('.skel'),'the retry shows a skeleton in place');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(content.textContent,/Free plan/);
  const before=calls;document.querySelector('#wallet-button').click();
  assert.equal(calls,before+2,'opening the plan refreshes it');
});

test('admin button stays hidden for non-admin sessions and renders grouped market data settings for admins',async()=>{
  {
    const {document}=await mount('admin.js',json({error:'Admin access is required.'},{ok:false,status:403}));
    assert.equal(document.querySelector('#admin-button').hidden,true);
  }
  {
    const mockStatus={
      totalListings:1420,activeForSale:600,closedSold:520,activeRentals:300,plutoMatchedParcels:1180,highPotentialDeals:312,submarketRollups:24,
      recentSyncs:[{id:'sync-1',locations:['Brooklyn, NY'],fetchedCount:850,insertedCount:800,plutoMatchedCount:420,status:'completed',startedAt:1700000000000}],
      adminConfig:{
        syncConfig:{autoSyncEnabled:false,writeThroughComps:true,onDemandSyncIfEmpty:true,locations:['Brooklyn, NY','Manhattan, NY'],listingTypes:['for_sale','sold','for_rent'],pastDays:180,limitPerType:300,enrichPluto:true},
        dealSettings:{zfaToGrossFactor:1.15,zfaToNetEfficiency:0.85,hardCostPerGrossSqft:375,softCostPctOfHard:0.22,carryAndFinancingPct:0.10},
        updatedAt:1700000000000,updatedBy:'michael@witharosa.ai',
      },
    };
    const requests=[];
    const {document}=await mount('admin.js',async(url,options={})=>{requests.push({url,method:options.method||'GET',body:options.body});return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>mockStatus};});
    const btn=document.querySelector('#admin-button');
    assert.equal(btn.hidden,false);
    btn.click();
    await new Promise(resolve=>setImmediate(resolve));
    const content=document.querySelector('#admin-content');
    assert.match(content.textContent,/1,420/);
    assert.deepEqual([...content.querySelectorAll('.admin-section > h3')].map(h=>h.textContent),['Listing refresh','Deal scoring','Run now','Recent refreshes']);
    assert.doesNotMatch(content.textContent,/HomeHarvest|acres_market_comps|PLUTO|Write-through|Beta|COMPLETED/);
    assert.equal(content.querySelectorAll('.admin-primary').length,1,'one primary Save');
    assert.equal(content.querySelector('#admin-save-config').textContent,'Save settings');
    content.querySelector('#admin-hard-cost').value='410';
    content.querySelector('#admin-save-config').click();
    await new Promise(resolve=>setImmediate(resolve));
    const save=requests.find(r=>r.method==='PUT');
    const payload=JSON.parse(save.body);
    assert.equal(payload.dealSettings.hardCostPerGrossSqft,410);
    assert.equal(payload.syncConfig.writeThroughComps,true);
    assert.deepEqual(payload.syncConfig.locations,['Brooklyn, NY','Manhattan, NY']);
    assert.equal(payload.revalueDeals,true);
  }
});

test('deals explorer mounts on the Core screen with the SVG pin map, $/BSF sliding scale, badges, comps, FAR headroom ranking and an underwrite handoff',async(t)=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document,window}=parseHTML(html);
  globalThis.document=document;
  globalThis.window=window;
  globalThis.Event=window.Event;
  assert.equal(document.querySelector('#deals-dialog'),null,'the explorer is a route, not a dialog');
  assert.equal(document.querySelector('#deals-button'),null);
  const entries=[...document.querySelectorAll('#navigation .app-nav [data-route]')];
  assert.deepEqual(entries.map(b=>b.textContent.trim()),['Home','Underwriting','Modeling',"What's new"]);
  assert.deepEqual(entries.map(b=>b.dataset.route),['/','/sites','/modeling','/whats-new'],"home, saved sites and what's new have distinct destinations");

  const {mountDealsScreen,buildDealUnderwritePrompt}=await import('../public/deals.js');

  const sampleDeal={
    listing_id:'ave-clean:for_sale',
    address:'412 4th Ave, Brooklyn, NY 11215',
    borough:'Brooklyn',
    zip_code:'11215',
    bbl:'3009650010',
    zoning_district_1:'R8A',
    lot_area_sqft:2500,
    building_sqft:2400,
    built_far:0.96,
    resid_far:6.02,
    uap_far:7.2,
    max_buildable_zfa:15050,
    unused_residential_zfa:12650,
    uap_max_buildable_zfa:18000,
    uap_unused_zfa:15600,
    estimated_gross_buildable_sqft:20700,
    maxBuildableUnits:26,
    list_price:2200000,
    price_per_existing_sqft:917,
    price_per_buildable_zfa:146,
    uap_price_per_buildable_zfa:122,
    pricePerBuildableUnit:84615,
    estimated_construction_cost:10246500,
    estimated_stabilized_value:16800000,
    estimated_condo_sellout:21400000,
    implied_cap_rate:0.094,
    implied_condo_margin:0.41,
    deal_verdict:'great_deal',
    flashcardValuation:{basis:[
      {item:'submarketSalePsf',asOf:'2026-10-15',source:'No recorded sale benchmark for this ZIP: 2 priced condo and co-op closings, fewer than the 5 needed; asking prices are never used. In its place, Prime Brownstone & North Brooklyn: Arosa analyst estimate by submarket; unsourced, not a market survey'},
      {item:'hardCostPerGrossSqft',value:410,asOf:null,source:'Override from admin or user deal settings'},
      {item:'greatDealCapRate',value:0.09,asOf:'2026-10-15',source:'Arosa planning assumption for the deal store; not from a published dataset or cost index'},
    ]},
    latitude:40.6725,
    longitude:-73.9842,
    slidingScale:{
      greatDealMaxPricePerBsf:245,
      goodDealMaxPricePerBsf:310,
      badDealMinPricePerBsf:420,
      greatDealMaxLandValue:4410000,
      goodDealMaxLandValue:5580000,
      badDealMinLandValue:7560000,
    },
    corridorProfile:{
      hasRetailUplift:true,
      corridorLabel:'Commercial Overlay (C2-4)',
      groundFloorRetailSqft:1875,
      retailRentPsfYear:110,
      retailAnnualNoiUplift:80625,
      retailValueUplift:1290000,
    },
    rentStabilization:{
      riskLevel:'clean',
      estStabilizedUnits:0,
      conhRequired:false,
      badgeLabel:'Clean Delivery · 2 Free-Market Units',
      summary:'2 residential units (<6-unit threshold); free-market tenant buyout / vacant delivery likely.',
    },
    similarComps:[
      {
        listingId:'comp-ave-sold:sold',
        listingType:'sold',
        address:'420 4th Ave, Brooklyn, NY 11215',
        price:2450000,
        priceBasis:'reported_sale',
        zoningDistrict:'R8A',
        buildableZfa:18000,
        buildableZfaBasis:'uap_zfa',
        pricePerExistingSqft:942,
        pricePerBuildableZfa:136,
        pricePerBuildableUnit:94231,
        similarityScore:96,
        similarityReasons:['0.04 mi away','Same R8A zoning','Both on commercial avenue','Similar buildable scale'],
      },
    ],
  };

  const dealSettings={
    hardCostPerGrossSqft:410,
    softCostPctOfHard:0.22,
    carryAndFinancingPct:0.10,
    zfaToGrossFactor:1.15,
    greatDealCapRate:0.09,
    goodDealCapRate:0.075,
    badDealCapRate:0.0575,
    greatDealCondoMargin:0.3,
    goodDealCondoMargin:0.2,
    badDealCondoMargin:0.12,
  };
  const payload={
    deals:[sampleDeal,{...sampleDeal,listing_id:'full:for_sale',address:'1 Full Price Pl',deal_verdict:'full_price',uap_unused_zfa:9000}],
    userSettings:{isCustom:true,dealSettings,baselineSettings:{...dealSettings,hardCostPerGrossSqft:375}},
  };
  const requested=[];
  globalThis.fetch=async(url)=>{requested.push(url);return {ok:true,headers:{get:()=>'application/json'},json:async()=>payload};};
  t.after(()=>{delete globalThis.fetch;});
  const handoffs=[];
  const container=document.createElement('div');
  document.body.append(container);
  await mountDealsScreen(container,{onUnderwrite:(deal,prompt)=>handoffs.push({deal,prompt})});
  assert.match(requested[0],/sortBy=unused_uap_zfa/,'the default keeps the existing unused-floor-area ranking');
  assert.deepEqual([...document.querySelectorAll('[data-deal-card]')].map(c=>c.dataset.dealCard),['ave-clean:for_sale','full:for_sale']);
  assert.match(document.querySelector('[data-deal-card="ave-clean:for_sale"]').textContent,/#1/);
  assert.match(document.querySelector('[data-deal-card="ave-clean:for_sale"]').textContent,/\+6\.24 FAR headroom/);

  const content=document.querySelector('#deals-content');
  assert.ok(document.querySelector('#deals-map-canvas'));
  assert.equal(document.querySelectorAll('.deal-map-pin').length,2);
  // Thresholds come from the active deal settings, not static text
  const legend=document.querySelector('.deals-map-legend').textContent;
  assert.match(legend,/Great Deal \(ask ≤70% of nearby land sales, or ≥9% yield or ≥30% margin without them\)/);
  assert.match(legend,/Full Price \(ask above nearby land sales, or <5\.75% yield and <12% margin without them\)/);
  assert.doesNotMatch(content.textContent,/8\.5%|7\.25%/);
  // The store's full_price verdict gets the full-price style
  assert.ok(document.querySelector('[data-deal-card="full:for_sale"]').className.includes('verdict-bad'));
  assert.match(document.querySelector('[data-deal-card="full:for_sale"]').textContent,/Full Price/);
  // Sort options are exactly the store's orderings
  assert.deepEqual([...document.querySelectorAll('#deals-sort-by option')].map(o=>o.value),['unused_uap_zfa','unused_far','uap_price_per_buildable_zfa','any_use_price_per_buildable_zfa','implied_yield_on_cost','implied_condo_margin']);
  assert.ok([...document.querySelectorAll('#deals-verdict-filter option')].some(o=>o.value==='full_price'));
  // Basis is shown with dates and says when the ZIP has no recorded sale benchmark
  const basisText=document.querySelector('.deals-basis').textContent;
  assert.match(basisText,/No recorded sale benchmark for this ZIP/);
  assert.match(basisText,/Great deal yield 0\.09: .*\(as of 2026-10-15\)/);
  assert.match(content.textContent,/412 4th Ave/);
  assert.match(content.textContent,/\$122\/BSF/);
  assert.match(content.textContent,/\$84,615\/unit/);
  assert.match(content.textContent,/Commercial Overlay \(C2-4\)/);
  assert.match(content.textContent,/Tenant review: unassessed/);
  assert.doesNotMatch(content.textContent,/Clean Delivery · 2 Free-Market Units/);
  assert.match(content.textContent,/Match score 96\/100/);
  assert.match(content.textContent,/\$136\/BSF/);
  assert.match(content.textContent,/\$94,231\/allowed unit/);
  assert.match(content.textContent,/UAP ZFA estimate/);
  assert.match(content.textContent,/Custom Saved Profile/);

  const promptText=buildDealUnderwritePrompt(sampleDeal,{hardCostPerGrossSqft:410,softCostPctOfHard:0.22,carryAndFinancingPct:0.10,zfaToGrossFactor:1.15});
  assert.match(promptText,/Underwrite 412 4th Ave/);
  assert.match(promptText,/\$410\/GSF hard cost/);

  const underwriteBtn=document.querySelector('#deals-underwrite-btn');
  assert.ok(underwriteBtn);
  underwriteBtn.click();
  assert.equal(handoffs.length,1);
  assert.equal(handoffs[0].deal.bbl,'3009650010');
  assert.match(handoffs[0].prompt,/BBL 3009650010/);
});


test('the deal map pins only listings located in the five boroughs and the list pages through every match',async(t)=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const {document,window}=parseHTML(html);
  globalThis.document=document;
  globalThis.window=window;
  globalThis.Event=window.Event;
  const {mountDealsScreen}=await import('../public/deals.js');
  const deal=(id,latitude,longitude,uap_unused_zfa)=>({listing_id:id,address:`${id} Test St`,borough:'Staten Island',zip_code:'10307',lot_area_sqft:2500,uap_unused_zfa,latitude,longitude,deal_verdict:'fair_deal'});
  const pages={
    0:{deals:[deal('tottenville',40.5085,-74.2390,9000),deal('swapped',-73.95,40.7,8000),deal('missing',null,null,7000)],total:5,offset:0,limit:3},
    3:{deals:[deal('glen-oaks',40.747,-73.711,6000),deal('zero',0,0,5000)],total:5,offset:3,limit:3},
  };
  const requested=[];
  globalThis.fetch=async(url)=>{
    requested.push(url);
    const body=pages[new URL(url,'http://x').searchParams.get('offset')];
    return {ok:true,headers:{get:()=>'application/json'},json:async()=>body};
  };
  t.after(()=>{delete globalThis.fetch;});
  const container=document.createElement('div');
  document.body.append(container);
  await mountDealsScreen(container,{onUnderwrite:()=>{}});

  assert.match(requested[0],/offset=0/);
  const pins=()=>[...document.querySelectorAll('.deal-map-pin')];
  assert.deepEqual(pins().map(p=>p.getAttribute('data-deal-id')),['tottenville'],'swapped and missing geocodes get no pin');
  const [x,y]=pins()[0].getAttribute('transform').match(/-?\d+/g).map(Number);
  assert.ok(x>24&&x<40&&y>190&&y<208,`south Staten Island is drawn inside the map at ${x},${y}`);
  assert.match(document.querySelector('.deals-map-header').textContent,/1 of 3 parcels mapped/);
  assert.match(document.querySelector('.deals-map-hint').textContent,/Click a parcel pin/);
  assert.match(document.querySelector('.deals-more').textContent,/Showing 3 of 5 matching listings/);

  document.querySelector('#deals-more-btn').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(requested[1],/offset=3/,'the next page starts after the loaded listings');
  assert.deepEqual([...document.querySelectorAll('[data-deal-card]')].map(c=>c.dataset.dealCard),['tottenville','swapped','missing','glen-oaks','zero']);
  assert.deepEqual(pins().map(p=>p.getAttribute('data-deal-id')),['tottenville','glen-oaks']);
  assert.match(document.querySelector('.deals-map-header').textContent,/2 of 5 parcels mapped/);
  assert.equal(document.querySelector('.deals-more'),null,'every match is loaded');

  pages[0]={deals:[deal('missing',null,null,7000),deal('zero',0,0,5000)],total:2,offset:0,limit:30};
  const borough=document.querySelector('#deals-borough-filter');
  for(const o of borough.querySelectorAll('option'))o.toggleAttribute('selected',o.value==='Staten Island');
  borough.dispatchEvent(new window.Event('change'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(requested[2],/borough=Staten\+Island/);
  assert.match(requested[2],/offset=0/,'a new filter starts from the first page');
  assert.equal(pins().length,0);
  assert.match(document.querySelector('.deals-map-header').textContent,/0 of 2 parcels mapped/);
  assert.doesNotMatch(document.querySelector('.deals-map-hint').textContent,/Click a parcel pin/,'no pin hint over an empty map');
});

test('plan dialog turns 404 and 500 responses into recovery instructions',async()=>{
 for(const status of [404,500]){const {document}=await mount('wallet.js',json({error:status===404?'Not found.':'Internal Server Error'},{ok:false,status}));const text=document.querySelector('#wallet-content').textContent;assert.doesNotMatch(text,/Not found\.|Internal Server Error/);assert.match(text,/Return|Try again/);assert.ok(document.querySelector('.wallet-retry'));}
});
