// Explicit operator configuration for this isolated test deployment.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {priceFixture} from './testing/comparable-price.mjs';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

test('asking comparables use their asking amount across every normalized price metric',t=>{
  const f=priceFixture(t),id=f.add('asking',{soldPrice:1_000_000,pricePerSqft:500,soldDate:'2020-01-01'}),comp=f.get(id);
  assert.equal(comp.price,3_000_000);assert.equal(comp.priceBasis,'asking_price');
  assert.equal(comp.pricePerBuildableZfa,300);assert.equal(comp.pricePerExistingSqft,1500);assert.equal(comp.pricePerSqft,1500);
  assert.equal(comp.pricePerBuildableUnit,214286);assert.equal(comp.reportedPricePerSqft,500);
  assert.equal(comp.soldDate,null);assert.equal(comp.listingDate,'2026-10-17');
  const fractional=f.add('fractional-ask',{listPrice:3_000_000.25,soldPrice:1_000_000});
  assert.equal(f.get(fractional).price,3_000_000.25);
});

test('reported-sale comparables use their reported sale amount rather than the old ask or reported PSF',t=>{
  const f=priceFixture(t),id=f.add('sale',{listingType:'sold',soldPrice:2_000_000,listDate:'2026-08-01',soldDate:'2026-09-10'}),comp=f.get(id);
  assert.equal(comp.price,2_000_000);assert.equal(comp.priceBasis,'reported_sale');
  assert.equal(comp.pricePerBuildableZfa,200);assert.equal(comp.pricePerExistingSqft,1000);assert.equal(comp.pricePerSqft,1000);
  assert.equal(comp.pricePerBuildableUnit,142857);assert.equal(comp.reportedPricePerSqft,1500);
  assert.equal(comp.soldDate,'2026-09-10');assert.equal(comp.listingDate,'2026-08-01');
});

test('the wrong price kind cannot admit a listing as a priced comparable',t=>{
  const f=priceFixture(t);
  for(const [i,invalid] of [null,0,-1,Infinity].entries()){
    const sold=f.add(`sale-${i}`,{listingType:'sold',soldPrice:invalid,listPrice:3_000_000});
    const asking=f.add(`ask-${i}`,{listPrice:invalid,soldPrice:2_000_000});
    assert.equal(f.get(sold),undefined);assert.equal(f.get(asking),undefined);
  }
});

test('a zero historical sale field cannot suppress a valid asking comparable',t=>{
  const f=priceFixture(t),id=f.add('asking-zero-history',{soldPrice:0});
  assert.equal(f.get(id)?.price,3_000_000);assert.equal(f.get(id)?.priceBasis,'asking_price');
});

test('a missing reported sale date remains unknown instead of borrowing the listing date',t=>{
  const f=priceFixture(t),id=f.add('sale-undated',{listingType:'sold',soldPrice:2_000_000,soldDate:null});
  const comp=f.get(id);assert.equal(comp.soldDate,null);assert.equal(comp.listingDate,'2026-10-17');
  assert.equal(comp.priceBasis,'reported_sale');
});

test('a reported PSF remains separate when no valid existing-area denominator is available',t=>{
  const f=priceFixture(t),id=f.add('no-area',{sqft:0,pricePerSqft:1700}),comp=f.get(id);
  assert.equal(comp.existingSqft,null);assert.equal(comp.pricePerExistingSqft,null);assert.equal(comp.pricePerSqft,null);
  assert.equal(comp.reportedPricePerSqft,1700);assert.equal(comp.pricePerBuildableZfa,300);
});

test('price-kind admission happens before the bounded candidate pool is truncated',t=>{
  const f=priceFixture(t);
  for(let i=0;i<125;i++)f.add(`unpriced-sale-${i}`,{listingType:'sold',soldPrice:null,lastSeen:1000+i});
  const sale=f.add('priced-sale',{listingType:'sold',soldPrice:2_000_000,lastSeen:1});
  const asking=f.add('priced-asking',{soldPrice:0,lastSeen:1});
  assert.deepEqual(f.comps().map(comp=>comp.id).sort(),[sale,asking].sort());
});

test('a supported listing refresh preserves stored history while current asking comparisons use the new ask',t=>{
  const f=priceFixture(t),id=f.add('refreshed',{listPrice:2_000_000,soldPrice:1_000_000,pricePerSqft:500});
  f.store.ingestListings([{propertyId:'refreshed',listingType:'for_sale',listPrice:3_000_000,soldPrice:null,pricePerSqft:null}],20);
  const raw=f.store.one('SELECT * FROM market_listings WHERE id=?',id);
  assert.equal(raw.sold_price,1_000_000);assert.equal(raw.list_price,3_000_000);
  const comp=f.get(id);assert.equal(comp.price,3_000_000);assert.equal(comp.pricePerExistingSqft,1500);
});

test('the actual deals API distinguishes asking and reported-sale evidence with consistent metrics',async t=>{
  const cleanup=[],f=priceFixture({after:fn=>cleanup.push(fn)});
  const asking=f.add('asking',{soldPrice:1_000_000,pricePerSqft:500});
  const sale=f.add('sale',{listingType:'sold',soldPrice:2_000_000,soldDate:null});
  const unpriced=f.add('sale-unpriced',{listingType:'sold',soldPrice:null});
  const chat=new ChatStore(join(f.dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'fixture'},store:chat,maps:null,marketStoreFactory:()=>new MarketStore(f.path)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));chat.close();cleanup.forEach(fn=>fn());});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/market-store/deals?minUnusedZfa=0`,{headers:{authorization:'Bearer fixture','x-acres-account':'a'.repeat(24),'x-acres-email':'alex@witharosa.ai'}});
  assert.equal(response.status,200);const body=await response.json(),comps=body.deals.find(deal=>deal.id===f.subjectId).similarComps;
  assert.equal(comps.find(comp=>comp.id===asking).price,3_000_000);assert.equal(comps.find(comp=>comp.id===asking).priceBasis,'asking_price');
  assert.equal(comps.find(comp=>comp.id===sale).soldDate,null);assert.equal(comps.find(comp=>comp.id===sale).pricePerExistingSqft,1000);
  assert.equal(comps.some(comp=>comp.id===unpriced),false);
});

test('a current sale outranks the same sale in 2020, on the listing and on a page of deals, and the old one says why',t=>{
  const f=priceFixture(t),month=new Date().toISOString().slice(0,7);
  // The 2020 closing was seen later, which used to break the tie in its favour.
  const old=f.add('old',{listingType:'sold',soldPrice:2_000_000,soldDate:'2020-01-01',lastSeen:20});
  const current=f.add('current',{listingType:'sold',soldPrice:2_000_000,soldDate:`${month}-01`,lastSeen:10});
  const ranked=f.comps().filter(c=>[old,current].includes(c.id));
  assert.deepEqual(ranked.map(c=>c.id),[current,old]);
  const [now,then]=ranked;
  assert.ok(now.similarityScore>then.similarityScore);
  assert.match(then.similarityReasons[0],/^Sold 2020-01-01, over three years ago: no weight for recency$/);
  const pageComps=f.store.searchDealsPage({minUnusedZfa:0,includeSimilarComps:true,limit:100}).deals.find(d=>d.id===f.subjectId).similarComps.filter(c=>[old,current].includes(c.id));
  assert.deepEqual(pageComps.map(c=>[c.id,c.similarityScore,c.similarityReasons]),ranked.map(c=>[c.id,c.similarityScore,c.similarityReasons]));
  // A sale 24 months back sits between the two; an undated sale gets no recency weight and says so.
  const twoYears=new Date(Date.now()-24*30.44*86400000).toISOString().slice(0,10);
  const mid=f.get(f.add('mid',{listingType:'sold',soldPrice:2_000_000,soldDate:twoYears})),undated=f.get(f.add('undated',{listingType:'sold',soldPrice:2_000_000,soldDate:null}));
  assert.ok(then.similarityScore<mid.similarityScore&&mid.similarityScore<now.similarityScore);assert.match(mid.similarityReasons[0],/months ago: weighted down for age$/);
  assert.equal(undated.similarityScore,then.similarityScore);assert.match(undated.similarityReasons[0],/date unknown: no weight for recency/);
});

test('a sale dated in the future earns no recency weight and says so, instead of counting as current',t=>{
  const f=priceFixture(t);
  const future=new Date(Date.now()+400*86400000).toISOString().slice(0,10);
  const undated=f.get(f.add('undated',{listingType:'sold',soldPrice:2_000_000,soldDate:null}));
  const ahead=f.get(f.add('ahead',{listingType:'sold',soldPrice:2_000_000,soldDate:future}));
  assert.equal(ahead.similarityScore,undated.similarityScore,'a future date weights like no date, not like a current sale');
  assert.match(ahead.similarityReasons[0],new RegExp(`^Reported sale dated ${future}, in the future: no weight for recency$`));
});
