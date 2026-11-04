import test from 'node:test';
import assert from 'node:assert/strict';
import {comparableFixture} from './testing/comparable-capacity.mjs';

test('a comparable cannot inherit the subject zoning, FAR or buildable denominators',t=>{
  const f=comparableFixture(t),comp=f.comp();
  assert.equal(comp.zoningDistrict,null);
  assert.equal(comp.buildableZfa,null);assert.equal(comp.buildableZfaBasis,null);
  assert.equal(comp.buildableUnits,null);assert.equal(comp.pricePerBuildableZfa,null);assert.equal(comp.pricePerBuildableUnit,null);
  assert.equal(comp.existingSqft,2000);assert.equal(comp.pricePerExistingSqft,1000);
});

test('changing the subject assumptions cannot change an unknown comparable physical metrics',t=>{
  const f=comparableFixture(t);
  const metrics=()=>{const c=f.comp();return [c.zoningDistrict,c.buildableZfa,c.buildableUnits,c.pricePerBuildableZfa,c.pricePerBuildableUnit,c.similarityScore];};
  const first=metrics();
  f.set(f.subjectId,{zoning_district:'R10',resid_far:8,max_uap_zfa:20000,pluto_lot_area:2500,comm_far:0});
  assert.deepEqual(metrics(),first);
  assert.doesNotMatch(f.comp().similarityReasons.join(' '),/Similar residential FAR|Comparable buildable scale/);
});

test('comparable stored positive ZFA retains its own UAP or standard screening basis',t=>{
  const f=comparableFixture(t);
  for(const [fields,area,basis] of [
    [{max_uap_zfa:12000,max_standard_zfa:10000},12000,'uap_zfa'],
    [{max_uap_zfa:0,max_standard_zfa:10000},10000,'standard_zfa'],
    [{max_standard_zfa:10000},10000,'standard_zfa'],
  ]) {
    f.set(f.compId,fields);const comp=f.comp();
    assert.equal(comp.buildableZfa,area);assert.equal(comp.buildableZfaBasis,basis);
    assert.equal(comp.pricePerBuildableZfa,Math.round(2_000_000/area));
  }
});

test('comparable lot times its own residential FAR is labeled and uses the same screening unit rule',t=>{
  const f=comparableFixture(t);
  f.set(f.compId,{pluto_lot_area:900,resid_far:2,zoning_district:'R6'});
  const comp=f.comp();
  assert.equal(comp.zoningDistrict,'R6');assert.equal(comp.buildableZfa,1800);assert.equal(comp.buildableZfaBasis,'lot_residential_far');
  assert.equal(comp.buildableUnits,2);assert.equal(comp.pricePerBuildableUnit,1_000_000);
  f.set(f.compId,{pluto_lot_area:-1,resid_far:4});
  const listingLot=f.comp();
  assert.equal(listingLot.buildableZfa,10000);assert.equal(listingLot.buildableZfaBasis,'lot_residential_far');
});

test('existing area, bedrooms and existing units cannot masquerade as development capacity',t=>{
  const f=comparableFixture(t);
  for(const fields of [{pluto_bldg_area:3000,units_total:8,beds:20},{pluto_lot_area:2500},{max_uap_zfa:Infinity,max_standard_zfa:-1}]) {
    f.set(f.compId,fields);const comp=f.comp();
    assert.equal(comp.buildableZfa,null);assert.equal(comp.buildableUnits,null);
    assert.equal(comp.pricePerBuildableZfa,null);assert.equal(comp.pricePerBuildableUnit,null);
  }
});

test('missing subject capacity earns no claimed FAR or buildable-scale match',t=>{
  const f=comparableFixture(t);
  f.set(f.subjectId,{pluto_bldg_area:5000});
  f.set(f.compId,{resid_far:2.5,max_uap_zfa:5000});
  const comp=f.comp();
  assert.doesNotMatch(comp.similarityReasons.join(' '),/Similar residential FAR|Comparable buildable scale/);
  assert.equal(comp.buildableZfa,5000);
});

test('evidence-backed comparable matches outrank an otherwise identical sparse record',t=>{
  const f=comparableFixture(t);
  const knownId=f.add('known',{zoning_district:'R7A',resid_far:4,max_uap_zfa:10000});
  const rows=f.comps(),known=rows.find(c=>c.id===knownId),unknown=f.comp();
  assert.equal(rows[0].id,knownId);assert.equal(known.similarityScore,96);
  assert.ok(unknown.similarityScore<=60,JSON.stringify(unknown));
  assert.ok(known.similarityReasons.some(reason=>reason.includes('Same R7A zoning')));
});
