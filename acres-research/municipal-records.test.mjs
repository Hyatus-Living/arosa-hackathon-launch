import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupMiamiDadeParcel,lookupNewHavenParcel,createMunicipalRecordsTools} from './municipal-records.mjs';
import {withExecutionSignal} from './execution-context.mjs';

const miami = (address, id, area = 2000) => ({attributes: {TRUE_SITE_ADDR: address, FOLIO: id, LOT_SIZE: area}});
const response = features => async () => ({features});
const id = '0123456789012';

test('municipal parcel selection matches full address identity instead of first prefix hit', async () => {
  const correct = miami('12 MAIN STREET', id), wrong = miami('120 MAIN ST', '0123456789013', 5000);
  for (const features of [[wrong,correct],[correct,wrong]]) {
    const out = await lookupMiamiDadeParcel({address:'12 Main St, Miami, FL',zoningCode:'T6-8-O',request:response(features)});
    assert.equal(out.parcel.folio,id); assert.equal(out.parcel.lotAreaSqft,2000);
    assert.equal(out.parcelResolution.status,'matched'); assert.match(out.parcelResolution.queryUrl,/PropertySearch/);
  }
});

test('duplicate addresses, units, conflicting IDs and capped results do not establish a parcel', async () => {
  for (const [args, features, status] of [
    [{address:'12 Main St'},[miami('12 MAIN ST',id),miami('12 MAIN ST','0123456789013')],'ambiguous'],
    [{address:'12 Main St Unit 2'},[miami('12 MAIN ST',id)],'not_found'],
    [{address:'12 Main St',folio:id},[miami('120 MAIN ST',id)],'identity_conflict'],
    [{address:'12 Main St',folio:id},[miami('12 MAIN ST','0123456789013')],'not_found'],
    [{address:'12 Main St'},Array.from({length:5},(_,i)=>miami(`${12+i} MAIN ST`,String(i))),'ambiguous'],
  ]) {
    const out=await lookupMiamiDadeParcel({...args,zoningCode:'T6-8-O',request:response(features)});
    assert.equal(out.parcelResolution.status,status);assert.equal(out.parcel.lotAreaSqft,null);
  }
});

test('New Haven uses explicit parcel identifiers and never labels an unrelated row with one', async () => {
  let query;
  const request=async url=>{query=new URL(url).searchParams.get('where');return {features:[
    {attributes:{Parcel_ID:'wrong',Location:'120 STATE ST',Shape_Area:900}},
    {attributes:{Parcel_ID:'requested',Location:'12 STATE STREET',Shape_Area:200}},
  ]};};
  const out=await lookupNewHavenParcel({parcelId:'requested',address:'12 State St, New Haven, CT',request});
  assert.match(query,/Parcel_ID='requested'/);assert.equal(out.parcel.parcelId,'requested');
  assert.equal(out.parcelResolution.status,'matched');
  const missing=await lookupNewHavenParcel({parcelId:'missing',request});
  assert.equal(missing.parcelResolution.status,'not_found');assert.equal(missing.parcel.lotAreaSqft,null);
});

test('municipal provider outages and supplied calculations remain explicitly unverified',async()=>{
  const recorded=[];
  const tools=createMunicipalRecordsTools({request:async()=>{throw new Error('offline');},record:src=>{recorded.push(src);return {id:1};}});
  const out=await tools.handlers.acres_municipal_parcel_records({address:'12 Main St, Miami, FL',zoningCode:'T6-8-O',lotAreaSqft:2000});
  assert.equal(out.parcelResolution.status,'unavailable');assert.equal(out.parcel.lotAreaSqft,2000);
  assert.equal(recorded[0].verified,false);
});

test('municipal cancellation cannot publish a swallowed provider failure',async()=>{
  const controller=new AbortController();let recorded=0;
  const tools=createMunicipalRecordsTools({request:async()=>{controller.abort(new Error('stopped'));throw controller.signal.reason;},record:()=>{recorded++;}});
  await assert.rejects(withExecutionSignal(controller.signal,()=>tools.handlers.acres_municipal_parcel_records({address:'12 Main St, Miami, FL'})),/stopped/);
  assert.equal(recorded,0);
});

test('unit abbreviations and New Haven Link aliases retain exact identity',async()=>{
  const out=await lookupMiamiDadeParcel({address:'12 Main St Unit 2',request:response([miami('12 MAIN STREET #2',id)])});
  assert.equal(out.parcelResolution.status,'matched');
  await assert.rejects(lookupMiamiDadeParcel({folio:'bad-id',address:'12 Main St',request:response([miami('12 MAIN ST',id)])}),/13-digit/);
  const alias=await lookupNewHavenParcel({parcelId:'link-id',request:response([{attributes:{Parcel_ID:'canonical-id',Link:'link-id',Location:'12 STATE ST'}}])});
  assert.equal(alias.parcelResolution.status,'matched');assert.equal(alias.parcel.parcelId,'canonical-id');
});

for (const adapter of [
  {name:'Miami',locality:'Miami, FL',identifier:{folio:id},lookup:lookupMiamiDadeParcel,row:address=>miami(address,id,12000)},
  {name:'New Haven',locality:'New Haven, CT',identifier:{parcelId:'unit-test'},lookup:lookupNewHavenParcel,row:address=>({attributes:{Parcel_ID:'unit-test',Location:address,Shape_Area:1200}})},
]) {
  const lookup=(address,returned,{explicit=false}={})=>adapter.lookup({address,...(explicit?adapter.identifier:{}),request:response([adapter.row(returned)])});
  test(`${adapter.name} retains comma Unit/Apt/# identity and refuses missing or different units`,async()=>{
    for(const suffix of ['Unit 2','Apt. 2','#2'])for(const locality of ['',`, ${adapter.locality}`])for(const returned of ['12 MAIN STREET','12 MAIN STREET UNIT 3']) {
      const address=`12 Main St, ${suffix}${locality}`;
      const ordinary=await lookup(address,returned);
      assert.equal(ordinary.parcelResolution.status,'not_found',`${address} versus ${returned}`);
      assert.equal(ordinary.parcel.lotAreaSqft,null);
      const explicit=await lookup(address,returned,{explicit:true});
      assert.equal(explicit.parcelResolution.status,'identity_conflict',`${address} with explicit ID versus ${returned}`);
      assert.equal(explicit.parcel.lotAreaSqft,null);
    }
  });
  test(`${adapter.name} matches equivalent unit aliases and preserves comma locality parsing`,async()=>{
    for(const suffix of ['Unit 2b','Apt. 2B','#2B'])for(const returned of ['12 MAIN STREET UNIT 2B',`12 MAIN STREET, #2b, ${adapter.locality}`])for(const explicit of [false,true]) {
      const out=await lookup(`12 Main St, ${suffix}, ${adapter.locality}`,returned,{explicit});
      assert.equal(out.parcelResolution.status,'matched');assert.ok(out.parcel.lotAreaSqft>0);
    }
    for(const explicit of [false,true]){
      const ordinary=await lookup(`12 Main St, ${adapter.locality}`,`12 MAIN STREET, ${adapter.locality}`,{explicit});
      assert.equal(ordinary.parcelResolution.status,'matched');assert.ok(ordinary.parcel.lotAreaSqft>0);
      const inline=await lookup(`12 Main St Apt 2B, ${adapter.locality}`,'12 MAIN STREET, Unit 2b',{explicit});
      assert.equal(inline.parcelResolution.status,'matched');
      const missing=await lookup(`12 Main St, ${adapter.locality}`,'12 MAIN STREET, Unit 2',{explicit});
      assert.equal(missing.parcelResolution.status,explicit?'identity_conflict':'not_found');
    }
  });
  test(`${adapter.name} refuses unresolved or conflicting unit qualifiers even with a matching identifier`,async()=>{
    for(const address of [
      `12 Main St, Unit, ${adapter.locality}`,
      `12 Main St, #, ${adapter.locality}`,
      `12 Main St Unit 2, Apt 3, ${adapter.locality}`,
      `12 Main St, Unit 2 / Unit 3, ${adapter.locality}`,
    ])for(const explicit of [false,true]){
      const out=await lookup(address,'12 MAIN STREET UNIT 2',{explicit});
      assert.equal(out.parcelResolution.status,explicit?'identity_conflict':'not_found',address);assert.equal(out.parcel.lotAreaSqft,null);
    }
    const malformedRecord=await lookup('12 Main St, Unit 2','12 MAIN STREET, Unit 2, Apt 3',{explicit:true});
    assert.equal(malformedRecord.parcelResolution.status,'identity_conflict');
  });
}
