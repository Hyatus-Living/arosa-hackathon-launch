import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from '../market-store.mjs';

export function tenantFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-tenant-screening-'));
  const path=join(dir,'market.sqlite'),store=new MarketStore(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  let sequence=0;
  const add=(name,{unitsRes=null,unitsTotal=null,yearBuilt=null,bldgClass=null,specialDistrict=null}={})=>{
    const id=`${name}:for_sale`;
    store.ingestListings([{propertyId:name,listingType:'for_sale',address:`${++sequence} Review Street`,city:'Brooklyn',state:'NY',zipCode:'11201',assetClass:'multifamily_small',isDevelopmentCandidate:true,listPrice:2_000_000,sqft:2000,lotSqft:2500}]);
    store.write(`UPDATE market_listings SET bbl=?,units_res=?,units_total=?,year_built=?,bldg_class=?,special_district=?,pluto_lot_area=2500,pluto_bldg_area=2000,resid_far=4,max_standard_zfa=10000,max_uap_zfa=10000,unused_uap_zfa=8000,uap_price_per_buildable_zfa=200 WHERE id=?`,
      `300965${String(sequence).padStart(4,'0')}`,unitsRes,unitsTotal,yearBuilt,bldgClass,specialDistrict,id);
    return id;
  };
  const page=(filters={})=>store.searchDealsPage({minUnusedZfa:0,includeSimilarComps:false,limit:100,...filters});
  const get=id=>page().deals.find(deal=>deal.id===id);
  return {dir,path,store,add,page,get};
}
