import test from 'node:test';
import assert from 'node:assert/strict';
import {tenantFixture} from './testing/tenant-screening.mjs';

const observation=(propertyId,listPrice,lastUpdateDate)=>({propertyId,listingType:'for_sale',address:'Synthetic price property',city:'Brooklyn',state:'NY',zipCode:'11201',assetClass:'multifamily_small',isDevelopmentCandidate:true,listPrice,...(lastUpdateDate?{lastUpdateDate}:{})});
const raw=(f,id)=>({...f.store.one('SELECT list_price,existing_price_per_sqft,price_per_buildable_zfa,uap_price_per_buildable_zfa,price_per_buildable_sf,far_compression_pct,last_update_date,price_history_json FROM market_listings WHERE id=?',id)});
const metrics=row=>[row.existing_price_per_sqft,row.price_per_buildable_zfa,row.uap_price_per_buildable_zfa,row.price_per_buildable_sf,row.far_compression_pct];
function seed(f,id,price){
  // This 25 by 100 R6 lot holds 5,500 standard ZFA (2.2 FAR) and 9,750 with the affordability bonus.
  f.store.write("UPDATE market_listings SET list_price=?,existing_price_per_sqft=?,price_per_buildable_zfa=?,uap_price_per_buildable_zfa=?,price_per_buildable_sf=?,far_compression_pct=63.6,pluto_lot_front=25,pluto_lot_depth=100,aff_res_far=4,zoning_district='R6',bldg_class='C1',units_res=4,latitude=40.7,longitude=-73.95 WHERE id=?",price,Math.round(price/2000),Math.round(price/5500),Math.round(price/9750),Math.round(price/5500),id);
}

test('a price refresh updates cards, pins, price filtering, ordering and ZIP development metrics together',t=>{
  const f=tenantFixture(t),id=f.add('ask-change'),peer=f.add('price-peer');seed(f,id,2000000);seed(f,peer,3000000);
  f.store.ingestListings([observation('ask-change',4000000)]);
  const updated=raw(f,id);assert.equal(updated.list_price,4000000);assert.deepEqual(metrics(updated),[2000,727,410,727,63.6]);
  assert.equal(f.get(id).uapPricePerBuildableZfa,410);
  assert.deepEqual(f.page({sortBy:'uap_price_per_buildable_zfa'}).deals.map(d=>d.id),[peer,id]);
  assert.deepEqual(f.page({maxPricePerBuildableZfa:600}).deals.map(d=>d.id),[peer]);
  const pins=f.store.searchDealsPage({pins:true,minUnusedZfa:0}).pins;assert.equal(pins.listPrice[pins.id.indexOf(id)],4000000);
  assert.equal(f.page({}).deals.find(d=>d.id===id).uapPricePerBuildableZfa,410);
  assert.equal(f.store.getZipRollup('11201').devMetrics.medianPricePerBuildableZfa,359);
  assert.match(updated.price_history_json,/4000000/);
});

test('missing prices clear derived values and normal refresh repairs stale caches from the retained parcel',t=>{
  const f=tenantFixture(t),id=f.add('missing-ask');seed(f,id,2000000);f.store.write('UPDATE market_listings SET max_uap_zfa=NULL WHERE id=?',id);
  f.store.ingestListings([observation('missing-ask',null)]);assert.deepEqual(metrics(raw(f,id)),[null,null,null,null,null]);
  assert.equal(f.page({minListPrice:null,maxPricePerBuildableZfa:500}).total,0);
  f.store.ingestListings([observation('missing-ask',2500000)]);assert.deepEqual(metrics(raw(f,id)),[1250,455,256,455,63.6]);
  f.store.write('UPDATE market_listings SET pluto_lot_area=NULL,pluto_bldg_area=NULL,max_standard_zfa=NULL,max_uap_zfa=NULL WHERE id=?',id);
  f.store.ingestListings([observation('missing-ask',2500000)]);assert.deepEqual(metrics(raw(f,id)),[null,null,null,null,null]);
  f.store.write('UPDATE market_listings SET pluto_lot_area=2500,pluto_bldg_area=2000,max_standard_zfa=10000,max_uap_zfa=10000,existing_price_per_sqft=999,price_per_buildable_zfa=999,uap_price_per_buildable_zfa=999,price_per_buildable_sf=999,far_compression_pct=999 WHERE id=?',id);
  f.store.ingestListings([observation('missing-ask',2500000)]);assert.deepEqual(metrics(raw(f,id)),[1250,455,256,455,63.6]);
});

test('price-metric refresh respects source ordering and rolls back with the existing listing transaction',t=>{
  const f=tenantFixture(t),id=f.add('ordered-price');seed(f,id,2000000);
  f.store.write('UPDATE market_listings SET last_update_date=? WHERE id=?','2026-10-18T12:00:00Z',id);f.store.recomputeZipRollup('11201');
  const before=raw(f,id),rollup=f.store.getZipRollup('11201');
  f.store.ingestListings([observation('ordered-price',4000000,'2026-10-17T12:00:00Z')]);assert.deepEqual(raw(f,id),before);
  f.store.write("CREATE TEMP TRIGGER fail_price_rollup BEFORE UPDATE ON market_submarket_rollups BEGIN SELECT RAISE(ABORT,'controlled price rollup failure'); END");
  assert.throws(()=>f.store.ingestListings([observation('ordered-price',4000000,'2026-10-19T12:00:00Z')]),/controlled price rollup failure/);
  assert.deepEqual(raw(f,id),before);assert.deepEqual(f.store.getZipRollup('11201'),rollup);
});
