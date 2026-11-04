import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from '../market-store.mjs';

export function comparableFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'acres-comparable-capacity-'));
  const store=new MarketStore(join(dir,'market.sqlite'));
  const close=()=>{store.close();rmSync(dir,{recursive:true});};
  t.after(close);
  const set=(id,fields)=>store.write(`UPDATE market_listings SET zoning_district=?,resid_far=?,max_uap_zfa=?,max_standard_zfa=?,pluto_lot_area=?,pluto_bldg_area=?,comm_far=?,units_total=?,beds=? WHERE id=?`,
    fields.zoning_district??null,fields.resid_far??null,fields.max_uap_zfa??null,fields.max_standard_zfa??null,fields.pluto_lot_area??null,fields.pluto_bldg_area??null,fields.comm_far??null,fields.units_total??null,fields.beds??null,id);
  const add=(name,fields={})=>{
    const id=`${name}:for_sale`;
    store.ingestListings([{propertyId:name,listingType:'for_sale',address:`${name==='subject'?'10':'12'} Evidence Street`,city:'Brooklyn',state:'NY',zipCode:'11201',borough:'Brooklyn',latitude:40.7,longitude:-73.99,assetClass:'multifamily_small',isDevelopmentCandidate:true,listPrice:2_000_000,sqft:2000,lotSqft:2500}]);
    set(id,{pluto_lot_area:2500,pluto_bldg_area:2000,comm_far:0,...fields});
    return id;
  };
  const subjectId=add('subject',{zoning_district:'R7A',resid_far:4,max_uap_zfa:10000,max_standard_zfa:10000});
  const compId=add('unknown');
  const subject=()=>store.one('SELECT * FROM market_listings WHERE id=?',subjectId);
  const comps=()=>store.getSimilarCompsForDeal(subject(),{limit:15});
  const comp=()=>comps().find(c=>c.id===compId);
  return {store,dir,subjectId,compId,set,add,subject,comps,comp};
}
