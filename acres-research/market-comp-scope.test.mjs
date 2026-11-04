import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMarketTools} from './market.mjs';
import {MarketStore} from './market-store.mjs';
import {planningCommand} from './planning.mjs';

const listingUrl='https://www.realtor.com/realestateandhomes-detail/controlled';
const bucket={saleSampleCount:3,closedSoldCount:2,activeForSaleCount:1,condoCoopClosedSoldPriceSampleCount:2,medianCondoCoopClosedSoldPricePerSqft:900,medianSalePricePerSqft:900,medianSaleDaysOnMls:30,rentSampleCount:2,medianRentPerSqftPerMonth:4,medianRentDaysOnMls:20};
const live=(location,extra={})=>({location,retrievedAt:'2026-10-17',totalComps:4,byBedrooms:{'1':bucket},resolvedLocationsByType:{for_sale:location,for_rent:location},sampleComps:[{url:listingUrl}],...extra});
const emptyProvider=async()=>{throw new Error('Controlled provider unavailable');};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'acres-comp-scope-')),store=new MarketStore(join(dir,'market.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const add=(zip,price=1500000)=>store.ingestListings([{propertyId:'listing-'+zip,listingType:'for_sale',address:'Controlled listing',city:zip==='11215'?'Brooklyn':'New York',state:'NY',zipCode:zip,beds:1,sqft:1000,listPrice:price,pricePerSqft:price/1000,url:listingUrl}],Date.UTC(2020,0,1));
  const records=[],events=[],calls=[],reads=[];
  const get=store.getZipRollup.bind(store);store.getZipRollup=zip=>{reads.push(zip);return get(zip);};
  const tools=runner=>createMarketTools({marketStore:store,dealStoreAccess:{read:true,sync:false},getProperty:()=>({address:'Selected subject',zipcode:'10001'}),record:s=>{records.push(s);return{id:records.length};},emit:(event,data)=>events.push({event,data}),compRunner:async args=>{calls.push(args);return(runner||emptyProvider)(args);}});
  return{store,add,records,events,calls,reads,tools};
}
async function seed(tools){await tools.handlers.acres_market_inputs({submarket:'Saved subject market',salePrices:[{bedrooms:1,pricePerSqft:700,source:'Controlled input',retrievedAt:'2020-01-01'}]});return structuredClone(tools.market);}

test('a requested ZIP uses its own cache key instead of the selected propertys unrelated ZIP',async t=>{
  const f=fixture(t);f.add('10001');const tools=f.tools(),before=await seed(tools);
  await assert.rejects(tools.handlers.acres_market_comps({location:'11215',submarket:'Brooklyn requested'}),/Controlled provider unavailable/);
  assert.equal(f.calls[0].zipCode,'11215');assert.deepEqual(f.reads,['11215']);assert.deepEqual(tools.market,before);assert.equal(f.records.length,0);
});

test('named comparison locations never inherit a ZIP from another active subject',async t=>{
  const f=fixture(t);f.add('10001');const tools=f.tools(),before=await seed(tools);
  for(const location of ['Miami, FL','Selected subject'])await assert.rejects(tools.handlers.acres_market_comps({location}),/Controlled provider unavailable/);
  assert.ok(f.calls.every(call=>call.zipCode===undefined));assert.deepEqual(f.reads,[]);assert.deepEqual(tools.market,before);
});

test('invalid and conflicting explicit ZIPs fail before provider, cache or market effects',async t=>{
  const f=fixture(t),tools=f.tools(),before=await seed(tools);
  for(const zipCode of ['','1000','AB001','10001'])await assert.rejects(tools.handlers.acres_market_comps({location:'11215',zipCode}),/ZIP/);
  assert.equal(f.calls.length,0);assert.equal(f.reads.length,0);assert.equal(f.records.length,0);assert.deepEqual(tools.market,before);
});

test('matching live provider results keep existing auto-recording and real listing citation behavior',async t=>{
  const f=fixture(t),tools=f.tools(async({location})=>live(location));
  const out=await tools.handlers.acres_market_comps({location:'11215',zipCode:'11215',submarket:'Requested Brooklyn market'});
  assert.equal(out.autoRecordedMarket,true);assert.equal(out.location,'11215');assert.equal(tools.market.submarket,'Requested Brooklyn market');
  assert.equal(tools.market.salePrices[0].pricePerSqft,900);assert.equal(tools.market.rents[0].rentPerSqftPerMonth,4);assert.ok(out.sourceId);assert.ok(f.records.every(record=>record.url===listingUrl));
});

test('a matching stored ZIP rollup is an aged reference and cannot overwrite saved market inputs',async t=>{
  const f=fixture(t);f.add('10001');const tools=f.tools(),before=await seed(tools);
  const out=await tools.handlers.acres_market_comps({location:'10001',autoRecordMarketInputs:true});
  assert.equal(out.totalComps,1);assert.equal(out.provenance.source,'market-store-cache');assert.equal(out.provenance.referenceOnly,true);assert.equal(out.provenance.cachedAt,'2020-01-01T00:00:00.000Z');
  assert.equal(out.retrievedAt,null);assert.equal(out.autoRecordedMarket,false);assert.deepEqual(tools.market,before);assert.equal(out.sourceId,null);assert.equal(f.records.length,0);assert.match(out.provenance.scopeNote,/radius, date window or listing types/);
  assert.deepEqual(out.recommendedCondoMixByVelocity,[]);assert.deepEqual(out.recommendedRentalMixByVelocity,[]);
});

test('an explicit ZIP fallback is labeled with its actual geography rather than the requested city',async t=>{
  const f=fixture(t);f.add('10001');const tools=f.tools(),before=await seed(tools);
  const out=await tools.handlers.acres_market_comps({location:'Miami, FL',zipCode:'10001',submarket:'Requested Miami market'});
  assert.equal(out.location,'10001');assert.equal(out.submarket,'10001');assert.equal(out.requestedLocation,'Miami, FL');assert.equal(out.requestedSubmarket,'Requested Miami market');
  assert.equal(out.autoRecordedMarket,false);assert.deepEqual(tools.market,before);assert.equal(f.records.length,0);assert.match(out.proseReportingMandate,/not a completed request/);
  const event=f.events.findLast(e=>e.event==='market.comps_harvested');assert.equal(event.data.submarket,'10001');assert.equal(event.data.referenceOnly,true);
});

test('mixed provider fallback locations remain citable references without relabeling or applying them to the requested market',async t=>{
  const f=fixture(t),location='120 Broadway, New York, NY',tools=f.tools(async()=>live(location,{resolvedLocationsByType:{for_sale:'10005',for_rent:location}})),before=await seed(tools);
  const out=await tools.handlers.acres_market_comps({location,zipCode:'10005',submarket:'Requested address'});
  assert.equal(out.provenance.referenceOnly,true);assert.deepEqual(out.provenance.actualLocations,['10005',location]);assert.equal(out.autoRecordedMarket,false);assert.deepEqual(tools.market,before);
  assert.match(f.records[0].title,/10005/);assert.deepEqual(JSON.parse(f.records[0].text).actualLocations,['10005',location]);assert.equal(f.records[0].url,listingUrl);
  assert.deepEqual(out.recommendedCondoMixByVelocity,[]);assert.deepEqual(out.recommendedRentalMixByVelocity,[]);
});

test('provider results without listing URLs do not invent a Realtor homepage citation',async t=>{
  const f=fixture(t),tools=f.tools(async({location})=>live(location,{sampleComps:[]}));
  const out=await tools.handlers.acres_market_comps({location:'11215',zipCode:'11215'});
  assert.equal(out.autoRecordedMarket,true);assert.equal(out.sourceId,null);assert.equal(f.records.length,0);assert.equal(tools.market.salePrices[0].sourceId,null);assert.equal(tools.market.salePrices[0].url,null);assert.match(out.proseReportingMandate,/URLs are unavailable/);
});

const python=planningCommand().python,native={skip:existsSync(python)?false:'planning/.venv is not installed'};
const bridge=payload=>JSON.parse(execFileSync(python,[fileURLToPath(new URL('./testing/homeharvest-scope.py',import.meta.url))],{input:JSON.stringify({...payload,listingTypes:['for_sale'],limit:2}),encoding:'utf8',timeout:30000,stdio:'pipe'}));
test('the actual bridge never drops a requested city to scrape its state instead',native,()=>{
  for(const location of ['Miami, FL','Austin, TX'])assert.deepEqual(bridge({location}).calls.map(call=>call.location),[location]);
  assert.deepEqual(bridge({locations:['Miami, FL','Austin, TX'],zipCode:'10001'}).calls.map(call=>call.location),['Miami, FL','Austin, TX']);
});

test('the actual bridge keeps an address exact unless an explicit ZIP fallback was supplied',native,()=>{
  const location='120 Broadway, New York, NY';assert.deepEqual(bridge({location}).calls.map(call=>call.location),[location]);
  assert.deepEqual(bridge({location,zipCode:'10005'}).calls.map(call=>call.location),[location,'10005']);
  assert.deepEqual(bridge({location:'10005',zipCode:'10005'}).calls.map(call=>call.location),['10005']);
});

test('actual bridge execution and SQLite choose the requested ZIP reference without applying a different subjects market',native,async t=>{
  const f=fixture(t);f.add('10001',1500000);f.add('11215',900000);let observed;
  const tools=f.tools(async args=>{observed=bridge(args);return observed.result;}),before=await seed(tools);
  const out=await tools.handlers.acres_market_comps({location:'11215'});
  assert.deepEqual(observed.calls.map(call=>call.location),['11215']);assert.deepEqual(f.reads,['11215']);assert.equal(out.byBedrooms['1'].medianSalePricePerSqft,900);assert.equal(out.location,'11215');assert.equal(out.autoRecordedMarket,false);assert.deepEqual(tools.market,before);
});

test('an explicit no-auto-record flag still keeps matching live results from changing saved inputs',async t=>{
  const f=fixture(t),tools=f.tools(async({location})=>live(location)),before=await seed(tools);
  const out=await tools.handlers.acres_market_comps({location:'11215',zipCode:'11215',autoRecordMarketInputs:false});
  assert.equal(out.autoRecordedMarket,false);assert.deepEqual(tools.market,before);assert.equal(out.totalComps,4);assert.ok(out.sourceId);
});
