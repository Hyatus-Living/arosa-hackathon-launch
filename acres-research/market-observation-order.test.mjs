import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from './market-store.mjs';

const older = '2026-10-15T12:00:00Z', newer = '2026-10-16T12:00:00Z';
const row = (extra = {}) => ({propertyId:'ordered',listingType:'for_sale',address:'10 Order St, Brooklyn, NY 11201',city:'Brooklyn',zipCode:'11201',beds:1,sqft:1000,listPrice:750000,pricePerSqft:750,mlsStatus:'Pending',lastUpdateDate:newer,...extra});
const get = (s,id='ordered:for_sale') => s.one('SELECT * FROM market_listings WHERE id = ?',id);
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-market-order-')), store=new MarketStore(join(dir,'market.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;
}

test('a delayed older observation cannot roll back a listing price, status or history', t=>{
  const s=setup(t);s.ingestListings([row()],1000);const before=get(s);
  const result=s.ingestListings([row({listPrice:500000,pricePerSqft:500,mlsStatus:'Active',lastUpdateDate:older})],2000);
  assert.deepEqual(get(s),before);
  assert.deepEqual(result,{inserted:0,updated:0,rollupsUpdated:0,touchedZips:[]});
});

test('older observations cannot migrate a listing ZIP or contaminate its market rollups', t=>{
  const s=setup(t);s.ingestListings([row()],1000);const before=s.getZipRollup('11201');
  const result=s.ingestListings([row({zipCode:'11217',listPrice:200000,pricePerSqft:200,lastUpdateDate:older}),row({propertyId:'neighbor',zipCode:'11215',listPrice:900000,pricePerSqft:900})],2000);
  assert.equal(get(s).zip_code,'11201');assert.deepEqual(s.getZipRollup('11201'),before);
  assert.equal(s.getZipRollup('11217'),null);assert.equal(s.getZipRollup('11215').byBedrooms['1'].medianSalePricePerSqft,900);
  assert.deepEqual(result,{inserted:1,updated:0,rollupsUpdated:1,touchedZips:['11215']});
});

test('unordered observations in the same batch converge to the latest source values', t=>{
  const s=setup(t),old=row({listPrice:500000,mlsStatus:'Active',lastUpdateDate:older});
  for(const [id,observations] of [['forward',[old,row()]],['reverse',[row(),old]]]){
    s.ingestListings(observations.map(r=>({...r,propertyId:id})),1000);
    const saved=get(s,`${id}:for_sale`);assert.equal(saved.list_price,750000);assert.equal(saved.mls_status,'Pending');assert.equal(saved.last_update_date,newer);
  }
});

test('equal source instants permit corrections even when timezone text differs', t=>{
  const s=setup(t);s.ingestListings([row({lastUpdateDate:older})],1000);
  const result=s.ingestListings([row({lastUpdateDate:'2026-10-15T08:00:00-04:00',listPrice:725000})],2000);
  assert.equal(result.updated,1);assert.equal(get(s).list_price,725000);assert.equal(get(s).last_seen_at,2000);
});

test('a genuinely newer source observation still updates prices, status and history', t=>{
  const s=setup(t);s.ingestListings([row()],1000);
  const result=s.ingestListings([row({lastUpdateDate:'2026-10-16T12:00:00.001Z',listPrice:800000,mlsStatus:'Active'})],2000),saved=get(s);
  assert.equal(result.updated,1);assert.equal(saved.list_price,800000);assert.equal(saved.mls_status,'Active');
  const history=JSON.parse(saved.price_history_json);assert.deepEqual(history.map(x=>x.listPrice),[750000,800000]);
});

test('unknown source dates retain the existing observation and correction contract', t=>{
  const s=setup(t);s.ingestListings([row()],1000);
  assert.equal(s.ingestListings([row({lastUpdateDate:null,listPrice:700000})],2000).updated,1);
  assert.equal(get(s).list_price,700000);assert.equal(get(s).last_update_date,newer);
  s.ingestListings([row({propertyId:'unknown',lastUpdateDate:'unknown'})],1000);
  assert.equal(s.ingestListings([row({propertyId:'unknown',lastUpdateDate:older,listPrice:600000})],2000).updated,1);
  assert.equal(get(s,'unknown:for_sale').list_price,600000);
});

test('observation ordering is scoped to the listing key and preserves independent historical sales', t=>{
  const s=setup(t);s.ingestListings([row()],1000);
  s.ingestListings([row({listingType:'sold',listPrice:null,soldPrice:400000,mlsStatus:'Sold',lastUpdateDate:older}),row({propertyId:'other',lastUpdateDate:older,listPrice:650000})],2000);
  assert.equal(get(s).list_price,750000);assert.equal(get(s,'ordered:sold').sold_price,400000);assert.equal(get(s,'other:for_sale').list_price,650000);
});
