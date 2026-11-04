import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from '../market-store.mjs';

export function priceFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-comparable-price-')),path=join(dir,'market.sqlite');
  const store=new MarketStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  let sequence=0;
  const add=(name,{listingType='for_sale',listPrice=3_000_000,soldPrice=null,pricePerSqft=1500,listDate='2026-10-17',soldDate=null,sqft=2000,lastSeen=10}={})=>{
    const row={propertyId:name,listingType,address:`${++sequence} Price Street`,city:'Brooklyn',state:'NY',zipCode:'11201',latitude:40.7,longitude:-73.99,assetClass:'multifamily_small',isDevelopmentCandidate:true,listPrice,soldPrice,pricePerSqft,listDate,soldDate,sqft,lotSqft:2500};
    const id=MarketStore.listingKey(row);
    store.ingestListings([row],lastSeen);
    store.write(`UPDATE market_listings SET bbl=?,zoning_district='R7A',pluto_lot_area=2500,pluto_bldg_area=?,resid_far=4,max_uap_zfa=10000,max_standard_zfa=10000,unused_uap_zfa=8000,uap_price_per_buildable_zfa=300,comm_far=0 WHERE id=?`,
      `300966${String(sequence).padStart(4,'0')}`,sqft,id);
    return id;
  };
  const subjectId=add('subject');
  const subject=()=>store.one('SELECT * FROM market_listings WHERE id=?',subjectId);
  const comps=()=>store.getSimilarCompsForDeal(subject(),{limit:15});
  const get=id=>comps().find(comp=>comp.id===id);
  const payload=()=>{const row=store.searchDealsPage({minUnusedZfa:0,includeSimilarComps:false,limit:100}).deals.find(deal=>deal.id===subjectId);return {deals:[{...row,similarComps:comps()}],total:1,userSettings:{dealSettings:{},baselineSettings:{},isCustom:false}};};
  return {dir,path,store,add,subjectId,subject,comps,get,payload};
}
