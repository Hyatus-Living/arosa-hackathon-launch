import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {poolFixture,compatibilityFixture} from './testing/comparable-pool.mjs';
import {priceFixture} from './testing/comparable-price.mjs';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

test('two listings of one lot stand as one comp, the better record winning',t=>{
  const f=poolFixture(t,0);
  const twin=f.add('near-twin',{listingType:'sold',soldPrice:1150000,soldDate:'2026-10-02',lastSeen:3});
  f.store.write('UPDATE market_listings SET latitude=40.7004,longitude=-73.9904 WHERE id=?',twin);
  f.store.write('UPDATE market_listings SET bbl=(SELECT bbl FROM market_listings WHERE id=?) WHERE id=?',f.nearSale,twin);
  const out=f.store.getSimilarCompsForDeal(f.subject(),{limit:5});
  const ids=out.map(r=>r.id);
  assert.ok(ids.includes(f.nearSale) !== ids.includes(twin), 'exactly one of the same-lot pair is kept');
  assert.ok(ids.includes(twin), 'the better record by the ranker order stands for the lot');
});

test('stronger old sales and nearby asking peers survive more than120 newer weak sale candidates',t=>{
  const f=poolFixture(t),out=f.store.getSimilarCompsForDeal(f.subject(),{limit:5});
  assert.deepEqual(out.slice(0,2).map(r=>[r.id,r.similarityScore]),[[f.nearSale,99],[f.nearAsk,96]]);
  assert.equal(out.length,5);assert.equal(out[2].similarityScore,49);assert.equal(out[0].priceBasis,'reported_sale');assert.equal(out[1].priceBasis,'asking_price');
});

test('the complete eligible cohort is ranked beyond expanded fixed windows while subject aliases stay excluded',t=>{
  const f=poolFixture(t,1600),parcelAlias=f.add('same-parcel',{listingType:'sold',soldPrice:800000,lastSeen:900000}),propertyAlias=f.add('same-property',{listingType:'sold',soldPrice:800000,lastSeen:900001});
  f.store.write('UPDATE market_listings SET bbl=? WHERE id=?',f.subject().bbl,parcelAlias);f.store.write("UPDATE market_listings SET property_id='subject' WHERE id=?",propertyAlias);
  const out=f.store.getSimilarCompsForDeal(f.subject(),{limit:15});assert.equal(out.length,15);assert.deepEqual(out.slice(0,2).map(r=>r.id),[f.nearSale,f.nearAsk]);assert.ok(out.every(r=>![f.subjectId,parcelAlias,propertyAlias].includes(r.id)));
});

test('selection follows the existing weighted score rather than nearest-only candidate preselection',t=>{
  const f=priceFixture(t),near=f.add('near-wrong',{listPrice:1000000,lastSeen:100}),far=f.add('far-matching',{listPrice:1000000,lastSeen:1});
  f.store.write("UPDATE market_listings SET zoning_district='R2',resid_far=.4,max_uap_zfa=1000,max_standard_zfa=1000 WHERE id=?",near);
  f.store.write('UPDATE market_listings SET latitude=40.703 WHERE id=?',far);
  assert.deepEqual(f.store.getSimilarCompsForDeal(f.subject(),{limit:2}).map(r=>[r.id,r.similarityScore]),[[far,92],[near,68]]);
});

test('small-cohort output preserves the frozen original score, price, capacity, reason and missing-data contract',t=>{
  const f=compatibilityFixture(t),expected=JSON.parse(readFileSync(new URL('./testing/comparable-pool-compatibility.json',import.meta.url)));
  assert.deepEqual(f.store.getSimilarCompsForDeal(f.subject(),{limit:15}),expected);
});

test('full-population ranking preserves geography and actual transaction-price eligibility',t=>{
  const f=poolFixture(t),outside=f.add('other-borough',{listPrice:1000000,lastSeen:900000}),unreported=f.add('unreported',{listingType:'sold',soldPrice:null,listPrice:1000000,lastSeen:900001}),zero=f.add('zero',{listPrice:0,lastSeen:900002});
  f.store.write("UPDATE market_listings SET zip_code='11350',borough='QN' WHERE id=?",outside);
  const out=f.store.getSimilarCompsForDeal(f.subject(),{limit:15});assert.deepEqual(out.slice(0,2).map(r=>r.id),[f.nearSale,f.nearAsk]);assert.ok(out.every(r=>![outside,unreported,zero].includes(r.id)));
});

test('score ties preserve reported-sale priority and observation order at every requested result limit',t=>{
  const f=poolFixture(t);f.store.write('UPDATE market_listings SET latitude=40.703,longitude=-73.99 WHERE id=?',f.nearSale);
  const asks=[];for(let i=0;i<17;i++)asks.push(f.add(`ask-tie-${i}`,{listPrice:1200000,lastSeen:100+i}));
  const all=f.store.getSimilarCompsForDeal(f.subject(),{limit:1000});assert.equal(all.length,15);assert.equal(all[0].id,f.nearSale);assert.deepEqual(all.slice(1,5).map(r=>r.id),asks.slice(-4).reverse());assert.ok(all.every(r=>r.similarityScore===96));
  for(const limit of [1,2.9,5,15])assert.deepEqual(f.store.getSimilarCompsForDeal(f.subject(),{limit}),all.slice(0,Math.trunc(limit)));
  assert.deepEqual(f.store.getSimilarCompsForDeal(f.subject(),{limit:0}),all.slice(0,5));
});

test('the normal detail HTTP path exposes the complete-cohort peers used by the inspector',async t=>{
  const f=poolFixture(t),previous=process.env.ACRES_DEAL_STORE_ENABLED;process.env.ACRES_DEAL_STORE_ENABLED='true';
  t.after(()=>{if(previous===undefined)delete process.env.ACRES_DEAL_STORE_ENABLED;else process.env.ACRES_DEAL_STORE_ENABLED=previous;});
  const store=new ChatStore(join(f.dir,'chat.sqlite')),server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,marketStoreFactory:()=>new MarketStore(f.path)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/market-store/deals/${encodeURIComponent(f.subjectId)}`,{headers:{authorization:'Bearer test','x-acres-account':'a'.repeat(24)}});assert.equal(response.status,200);const data=await response.json();assert.equal(data.deal.id,f.subjectId);assert.deepEqual(data.deal.similarComps.slice(0,2).map(r=>[r.id,r.similarityScore]),[[f.nearSale,99],[f.nearAsk,96]]);}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
});

test('read-only reopen and ID/BBL lookup preserve bounded public results and missing-subject behavior',t=>{
  const f=poolFixture(t),expected=f.store.getSimilarCompsForDeal(f.subjectId,{limit:5}),reopened=new MarketStore(f.path,{readOnly:true});
  try{assert.deepEqual(reopened.getSimilarCompsForDeal(f.subject().bbl,{limit:5}),expected);assert.deepEqual(reopened.getSimilarCompsForDeal('missing-listing'),[]);for(const r of expected)for(const key of ['rowid','last_seen_at','price_history_json','photos_json'])assert.equal(Object.hasOwn(r,key),false);}
  finally{reopened.close();}
});

test('nearby peers that beat the distant ceiling settle the ranking without reading distant rows; sparse areas still rank the whole cohort',t=>{
  const scans=f=>{const seen=[],prepare=f.store.db.prepare.bind(f.store.db);f.store.db.prepare=sql=>{seen.push(sql);return prepare(sql);};return()=>seen.filter(sql=>sql.includes('candidate_order')).length;};
  const dense=priceFixture(t),count=scans(dense);
  for(let i=0;i<6;i++)dense.add(`near-${i}`,{listingType:'sold',soldPrice:1100000,soldDate:'2026-10-02',lastSeen:50+i});
  const far=dense.add('far-match',{listingType:'sold',soldPrice:1100000,soldDate:'2026-10-03',lastSeen:1});dense.store.write('UPDATE market_listings SET latitude=40.75 WHERE id=?',far);
  const out=dense.store.getSimilarCompsForDeal(dense.subject(),{limit:5});
  assert.equal(out.length,5);assert.ok(out.every(r=>r.similarityScore===99&&r.id!==far));assert.equal(count(),2,'the nearby box and the unlocated rows, no distant pass');
  const sparse=priceFixture(t),sparseCount=scans(sparse),near=sparse.add('near-sale',{listingType:'sold',soldPrice:1100000,soldDate:'2026-10-02',lastSeen:5}),distant=sparse.add('far-match',{listingType:'sold',soldPrice:1100000,soldDate:'2026-10-03',lastSeen:1});
  sparse.store.write('UPDATE market_listings SET latitude=40.75 WHERE id=?',distant);
  const unlocated=sparse.add('unlocated',{listPrice:1200000,lastSeen:3});sparse.store.write('UPDATE market_listings SET latitude=NULL,longitude=NULL WHERE id=?',unlocated);
  assert.deepEqual(sparse.store.getSimilarCompsForDeal(sparse.subject(),{limit:5}).map(r=>[r.id,r.similarityScore]),[[near,99],[unlocated,89],[distant,77]]);
  assert.equal(sparseCount(),3,'the nearby reads plus the distant pass');
  const unplaced=sparse.store.getSimilarCompsForDeal({...sparse.subject(),latitude:null,longitude:null},{limit:5});
  assert.equal(unplaced.length,3);assert.equal(sparseCount(),4,'a subject without coordinates reads its ZIP and borough once');
});
