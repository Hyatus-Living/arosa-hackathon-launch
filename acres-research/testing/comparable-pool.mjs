import {priceFixture} from './comparable-price.mjs';

export function poolFixture(t, count=160) {
  const f=priceFixture(t);
  const nearSale=f.add('near-sale',{listingType:'sold',soldPrice:1100000,soldDate:'2026-10-02',lastSeen:1});
  const nearAsk=f.add('near-ask',{listPrice:1200000,lastSeen:2});
  f.store.write('UPDATE market_listings SET latitude=40.7004,longitude=-73.9904 WHERE id IN (?,?)',nearSale,nearAsk);
  f.store.ingestListings(Array.from({length:count},(_,i)=>({propertyId:`far-${i}`,listingType:'sold',address:`${1000+i} Distant Street`,city:'Brooklyn',state:'NY',zipCode:'11201',latitude:40.85,longitude:-73.99,assetClass:'multifamily_small',isDevelopmentCandidate:true,listPrice:900000,soldPrice:900000,soldDate:'2026-10-01',sqft:2000,lotSqft:2500})),10000);
  f.store.write("UPDATE market_listings SET bbl=CAST(3000000100+rowid AS TEXT),zoning_district='R2',pluto_lot_area=2500,pluto_bldg_area=2000,resid_far=.4,max_uap_zfa=1000,max_standard_zfa=1000,unused_uap_zfa=0,comm_far=0,last_seen_at=10000+rowid WHERE property_id LIKE 'far-%'");
  return {...f,nearSale,nearAsk,count};
}

export function compatibilityFixture(t) {
  const f=priceFixture(t),add=(name,values={},sql=null)=>{const id=f.add(name,{lastSeen:20,...values});if(sql)f.store.write(`UPDATE market_listings SET ${sql} WHERE id=?`,id);return id;};
  add('sale',{listingType:'sold',soldPrice:1100000,soldDate:'2026-10-02',lastSeen:30});
  add('ask',{listPrice:1200000,lastSeen:29});
  add('no-coordinates',{},'latitude=NULL,longitude=NULL');
  add('same-borough',{},"latitude=NULL,longitude=NULL,zip_code='11202'");
  add('no-zoning',{},'zoning_district=NULL,resid_far=NULL');
  add('commercial',{},"overlay1='C1-2'");
  add('no-capacity',{},'max_uap_zfa=NULL,max_standard_zfa=NULL,pluto_lot_area=NULL,lot_sqft=NULL');
  add('standard',{},'max_uap_zfa=NULL');
  add('lot-far',{},'max_uap_zfa=NULL,max_standard_zfa=NULL');
  add('unknown-measurements',{},"max_uap_zfa=NULL,max_standard_zfa=NULL,resid_far='unknown',pluto_lot_area=NULL,lot_sqft=NULL,pluto_bldg_area=NULL,sqft=NULL");
  add('listing-with-sale-history',{soldPrice:9000000,listPrice:1250000,lastSeen:28});
  add('zulu-tie',{lastSeen:15});add('alpha-tie',{lastSeen:15});
  add('same-property-sold',{listingType:'sold',soldPrice:800000},`property_id='subject',bbl='3009660001'`);
  add('unreported-sale',{listingType:'sold',soldPrice:null});
  return f;
}
