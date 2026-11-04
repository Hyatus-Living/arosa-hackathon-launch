import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MarketStore} from './market-store.mjs';
import {planningCommand} from './planning.mjs';
const rows=[
  {listingType:'for_sale',listPrice:5000000,soldPrice:null,pricePerSqft:5000},
  {listingType:'sold',listPrice:3000000,soldPrice:null,pricePerSqft:3000},
  {listingType:'sold',listPrice:2000000,soldPrice:800000,pricePerSqft:2000},
  {listingType:'sold',listPrice:2100000,soldPrice:1000000,pricePerSqft:2100},
].map((row,i)=>({...row,propertyId:`closed-${i}`,address:`${i+1} Controlled St`,city:'New York',state:'NY',zipCode:'10001',beds:1,sqft:1000,assetClass:'condo_coop_apartment',style:'CONDOS',daysOnMls:30,rentPerSqftPerMonth:null}));
function verify(bucket){
  assert.equal(bucket.closedSoldCount,3);assert.equal(bucket.activeForSaleCount,1);
  assert.equal(bucket.condoCoopClosedSoldPriceSampleCount,2);
  assert.equal(bucket.medianCondoCoopClosedSoldPricePerSqft,900);assert.equal(bucket.medianClosedSoldPricePerSqft,900);
}
test('stored aggregates count actual closed prices separately from asking prices and sold rows without prices',t=>{
  const dir=mkdtempSync(join(tmpdir(),'closed-prices-')),store=new MarketStore(join(dir,'market.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.ingestListings(rows,Date.UTC(2026,9,18));verify(store.getZipRollup('10001').byBedrooms['1']);
});
const {python}=planningCommand();
test('the Python provider bridge agrees with stored aggregates on actual closed prices',{skip:!existsSync(python)},()=>{
  const script="import importlib.util,json,sys; s=importlib.util.spec_from_file_location('bridge',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.summarize_bedroom_bucket(1,json.load(sys.stdin))))";
  const result=execFileSync(python,['-c',script,fileURLToPath(new URL('./homeharvest-bridge.py',import.meta.url))],{input:JSON.stringify(rows),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  verify(JSON.parse(result));
});
