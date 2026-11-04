import test from 'node:test';
import assert from 'node:assert/strict';
import {createParcelOperations,buildParcelDiagnostics} from './parcels.mjs';
import {defaultPlutoBatchFetcher} from './market-store.mjs';
import {listingParcelFixture,parcel} from './fixtures/listing-parcel-match.mjs';
import {withExecutionSignal} from './execution-context.mjs';

const rows=n=>Array.from({length:n},(_,i)=>({bbl:String(1000000001+i),lot:String(i+1),latitude:'40.75',longitude:'-73.94',address:`${i+1} TEST STREET`}));
test('nearby reports complete versus capped coverage without exceeding its 50-record contract',async()=>{
  for(const n of [49,50,51]){
    const ops=createParcelOperations({request:async url=>{
      if(url.searchParams.has('bbl'))return [{bbl:'1000000000',latitude:'40.75',longitude:'-73.94'}];
      assert.equal(url.searchParams.get('$order'),'bbl ASC');assert.equal(url.searchParams.get('$limit'),'51');return rows(n);
    }});
    const result=await ops.nearby({bbl:'1000000000'});
    assert.equal(result.records.length,Math.min(n,50));assert.equal(result.truncated,n>50);assert.equal(result.coverage.complete,n<=50);
  }
});
test('block discovery includes later-page landmarks and marks an offset-ignoring provider incomplete',async()=>{
  const all=rows(600);all[599].landmark='Later landmark';let calls=0;
  const ops=createParcelOperations({request:async url=>{calls++;const offset=Number(url.searchParams.get('$offset'));assert.equal(url.searchParams.get('$order'),'bbl ASC');return all.slice(offset,offset+500);}});
  const result=await ops.sameBlock({bbl:'1000000000',borough:'MN',block:1,lot:600});
  assert.equal(calls,2);assert.equal(result.adjacentBlockLots[0].lot,600);assert.equal(result.landmarksOnSameBlock[0].landmark,'Later landmark');assert.equal(result.coverage.complete,true);
  const capped=createParcelOperations({request:async()=>all.slice(0,500)});
  assert.equal((await capped.sameBlock({bbl:'1000000000',borough:'MN',block:1})).coverage.complete,false);
});
test('PLUTO enrichment finds a match after the first 500 candidates',async t=>{
  const f=listingParcelFixture();t.after(()=>f.close());const offsets=[];
  const first=rows(500).map(row=>({...row,latitude:'40.9'}));
  const result=await f.store.enrichNycListingsWithPluto({plutoFetcher:async(_where,limit,{offset})=>{assert.equal(limit,500);offsets.push(offset);return offset===0?first:[parcel('QN','12-34 TEST AVENUE')];}});
  assert.deepEqual(offsets,[0,500]);assert.equal(result.matched,1);assert.equal(f.row().bbl,f.expected);
});
test('incomplete and failed candidate sets stay retryable instead of committing an unmatched verdict',async t=>{
  for(const mode of ['capped','repeated','failed']){
    const f=listingParcelFixture();t.after(()=>f.close());let calls=0;
    const result=await f.store.enrichNycListingsWithPluto({plutoFetcher:async(_where,_limit,{offset})=>{calls++;if(mode==='failed'&&offset)throw new Error('offline');return rows(500).map(row=>({...row,bbl:String(Number(row.bbl)+(mode==='repeated'?0:offset)),latitude:'40.9'}));}});
    assert.equal(result.matched,0);assert.notEqual(f.row().deal_verdict,'unmatched_parcel');assert.equal(f.row().bbl,null);
    assert.equal(mode==='failed'?result.failedBatches:result.incompleteBatches,1);assert.ok(calls<=4);
    assert.equal((await f.enrich([parcel('QN','12-34 TEST AVENUE')])).matched,1);
  }
});
test('default PLUTO fetch uses stable pages and never retries after parent cancellation',async t=>{
  const original=global.fetch;t.after(()=>{global.fetch=original;});let calls=0;
  global.fetch=async url=>{calls++;assert.equal(url.searchParams.get('$offset'),'500');assert.equal(url.searchParams.get('$order'),'bbl ASC');return Response.json([]);};
  await defaultPlutoBatchFetcher("borough='QN'",500,{offset:500});assert.equal(calls,1);
  const controller=new AbortController();calls=0;global.fetch=async()=>{calls++;controller.abort(new Error('stopped'));throw controller.signal.reason;};
  await assert.rejects(withExecutionSignal(controller.signal,()=>defaultPlutoBatchFetcher('true')),/stopped/);assert.equal(calls,1);
});

test('a lot PLUTO shows a building on without its area is unknown in the diagnostics and the block, not vacant',async()=>{
  const lot={bbl:'1000470001',lot:'1',lotarea:'10000',residfar:'6',commfar:'2',numfloors:'4',builtfar:'0'};
  const gap=buildParcelDiagnostics({...lot,bldgarea:'0',numbldgs:'2',yearbuilt:'1925'});
  assert.equal(gap.isVacantInPluto,false);
  assert.equal(gap.vacantOrMergedLotAdvisory,null);
  assert.match(gap.existingFloorAreaUnknownAdvisory,/unknown rather than zero.*Do not present this lot as vacant/);
  assert.equal(gap.bulkComplianceAndZfaBands.plutoGrossBldgArea,null);
  assert.equal(gap.bulkComplianceAndZfaBands.plutoBuiltFar,null);
  assert.equal(gap.bulkComplianceAndZfaBands.estimatedDobZfaBands.at100PctOfPlutoGfa,null);
  const residential=gap.bulkComplianceAndZfaBands.ceilingsAndHeadroomByUse.residentialStandard;
  assert.equal(residential.maxZfa,60000);
  assert.deepEqual([residential.netUnusedAt100PctGfa,residential.netUnusedAt85PctGfa,residential.equivalentFloorsAtImpliedFloorplate],[null,null,undefined]);
  for(const vacant of [{bldgarea:'0'},{bldgarea:'0',yearbuilt:'2019',bldgclass:'V1',landuse:'11'}]){
    const diag=buildParcelDiagnostics({...lot,...vacant});
    assert.equal(diag.isVacantInPluto,true,JSON.stringify(vacant));
    assert.match(diag.vacantOrMergedLotAdvisory,/vacant baseline/);
    assert.equal(diag.existingFloorAreaUnknownAdvisory,undefined);
    assert.equal(diag.bulkComplianceAndZfaBands.ceilingsAndHeadroomByUse.residentialStandard.netUnusedAt100PctGfa,60000);
  }
  const block=[{...lot,bldgarea:'0',numbldgs:'1',builtfar:'0'},{...lot,bbl:'1000470002',lot:'2',bldgarea:'0'}];
  const result=await createParcelOperations({request:async()=>block}).sameBlock({bbl:'1000470009',borough:'MN',block:47,lot:9});
  const gapLot=result.adjacentBlockLots.find(l=>l.lot===1),vacantLot=result.adjacentBlockLots.find(l=>l.lot===2);
  assert.deepEqual([gapLot.bldgarea,gapLot.builtfar,gapLot.estimatedUnusedStandardZfa],[null,null,null]);
  assert.deepEqual([vacantLot.bldgarea,vacantLot.estimatedUnusedStandardZfa],[0,60000]);
  assert.match(result.proseInstruction,/null bldgarea is unrecorded, not vacant/);
});
