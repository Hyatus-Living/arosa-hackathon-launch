import test from 'node:test';
import assert from 'node:assert/strict';
import {tenantFixture} from './testing/tenant-screening.mjs';

function fixture(t){
  const f=tenantFixture(t),a=f.add('first'),b=f.add('second'),c=f.add('queens'),d=f.add('no-zip');
  f.store.write('UPDATE market_listings SET neighborhood=?,latitude=?,longitude=? WHERE id=?','Bushwick',40.69,-73.99,a);
  f.store.write('UPDATE market_listings SET zip_code=?,neighborhood=?,latitude=?,longitude=? WHERE id=?','11211','Williamsburg',40.71,-73.96,b);
  f.store.write('UPDATE market_listings SET zip_code=?,borough=?,city=?,latitude=?,longitude=? WHERE id=?','11101','QN','Queens',40.75,-73.94,c);
  f.store.write('UPDATE market_listings SET zip_code=NULL,latitude=?,longitude=? WHERE id=?',40.70,-73.97,d);
  return {...f,a,b,c,d};
}
const ids=page=>page.deals.map(row=>row.id).sort();

test('area searches include every requested ZIP once across common list separators',t=>{
  const f=fixture(t);
  for(const area of ['11201,11211','11201; 11211','11201 11211','11201 and 11211','11201 OR 11211','11201,11211,11201']){
    const page=f.page({area});assert.equal(page.total,2,area);assert.deepEqual(ids(page),[f.a,f.b].sort(),area);
  }
  assert.deepEqual(ids(f.page({area:'11201,99999'})),[f.a]);
  assert.equal(f.page({area:'99999,99998'}).total,0);
});

test('ZIP lists preserve other filters, pagination and neighborhood search',t=>{
  const f=fixture(t),area='11201,11211';
  assert.deepEqual(ids(f.page({area:'11201,11101',borough:'QN'})),[f.c]);
  assert.deepEqual(ids(f.page({area,zipCode:'11201'})),[f.a]);
  assert.equal(f.page({area,minListPrice:3000000}).total,0);
  assert.deepEqual(ids(f.page({area,bounds:{south:40.68,north:40.70,west:-74,east:-73.98}})),[f.a]);
  const all=f.page({area}),next=f.page({area,limit:1,offset:1});
  assert.equal(next.total,2);assert.equal(next.deals[0].id,all.deals[1].id);
  assert.deepEqual(ids(f.page({area:'Bushwick'})),[f.a]);
  assert.deepEqual(ids(f.page({area:'Brooklyn'})),[f.a,f.b,f.d].sort());
  assert.equal(f.page({area:''}).total,4);
});

test('map pins and card results use the same complete ZIP set',t=>{
  const f=fixture(t),area='11201 and 11211',page=f.page({area}),pins=f.store.searchDealsPage({area,pins:true,minUnusedZfa:0});
  assert.equal(pins.total,page.total);assert.equal(pins.pins.id.length,2);
  assert.deepEqual([...pins.pins.id].sort(),ids(page));
});

test('area text that starts an address finds that listing by its own or the city record address',t=>{
  const f=fixture(t);
  f.store.write('UPDATE market_listings SET address=?,pluto_address=? WHERE id=?','6 Chatham Sq','6 CHATHAM SQUARE',f.a);
  f.store.write('UPDATE market_listings SET address=?,pluto_address=? WHERE id=?','16 Chatham Sq','16 CHATHAM SQUARE',f.b);
  assert.deepEqual(ids(f.page({area:'6 Chatham'})),[f.a],'a prefix, so 16 Chatham Sq is not a match');
  assert.deepEqual(ids(f.page({area:'6  chatham square'})),[f.a],'the spelled-out city record form also matches');
  assert.deepEqual(ids(f.page({area:'Bushwick'})),[f.a],'neighborhood search is unchanged');
});
