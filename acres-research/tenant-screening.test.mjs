// Explicit operator configuration for this isolated test deployment.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {computeRentStabilizationProfile,MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {tenantFixture} from './testing/tenant-screening.mjs';

const unverified=profile=>{
  assert.equal(profile.assessment,'screening');
  assert.equal(profile.estStabilizedUnits,null);assert.equal(profile.conhRequired,null);
  assert.equal(profile.rentRegulationStatus,'unverified');assert.equal(profile.occupancyStatus,'unverified');assert.equal(profile.conhStatus,'not_assessed');
  assert.doesNotMatch(profile.badgeLabel+' '+profile.summary,/Clean Delivery|Free-Market|statutorily exempt|CONH Required|subject to NYC rent stabilization|no rent-stabilized tenant holdover risk/i);
  assert.deepEqual(profile.verificationLinks.map(link=>new URL(link.url).hostname),['hcr.ny.gov','www.nyc.gov']);
};

test('missing or invalid residential counts remain unassessed rather than zero and clean',()=>{
  for(const value of [undefined,null,'',false,-1,8.5,Infinity,'unavailable']){
    const profile=computeRentStabilizationProfile({unitsRes:value,yearBuilt:1920});
    unverified(profile);assert.equal(profile.existingUnitsRes,null);assert.equal(profile.riskLevel,'unknown');
  }
});

test('an explicit zero count stays recorded zero without proving vacant delivery or no regulation',()=>{
  const profile=computeRentStabilizationProfile({unitsRes:0});unverified(profile);
  assert.equal(profile.existingUnitsRes,0);assert.equal(profile.existingUnitsTotal,null);
  assert.equal(profile.riskLevel,'low');assert.match(profile.summary,/0 residential units/);
});

test('older six-plus-unit metadata raises screening attention without determining unit coverage or CONH',()=>{
  const profile=computeRentStabilizationProfile({unitsRes:8,unitsTotal:8,yearBuilt:1920,bldgClass:'C1'});
  unverified(profile);assert.equal(profile.riskLevel,'high');assert.equal(profile.existingUnitsRes,8);
  assert.match(profile.summary,/1920/);assert.match(profile.summary,/HCR|rent histor/i);
});

test('a missing construction year cannot become a claimed pre-1974 building',()=>{
  for(const yearBuilt of [undefined,null,0,1900.5,Infinity,9999]){
    const profile=computeRentStabilizationProfile({unitsRes:8,yearBuilt});unverified(profile);
    assert.equal(profile.yearBuilt,null);assert.equal(profile.riskLevel,'unknown');
    assert.doesNotMatch(profile.summary,/Pre-1974 8-unit|built before 1974/i);
  }
});

test('a newer building screens moderate unless its DOF statement registers stabilized units, and invents no active benefit',()=>{
  const newer=computeRentStabilizationProfile({unitsRes:10,yearBuilt:2000});
  unverified(newer);assert.equal(newer.riskLevel,'moderate');
  assert.doesNotMatch(newer.badgeLabel+' '+newer.summary,/Active 421|Active J-51|5 rent.stabilized|10 rent.stabilized/i);
  // A 421-a, J-51 or 485-x building registers its stabilized units with HCR, so the DOF count carries the tax-benefit signal.
  const benefit=computeRentStabilizationProfile({unitsRes:10,yearBuilt:2000,rentStabilizedUnits:3,rentStabilizedYear:2024});
  assert.equal(benefit.riskLevel,'high');assert.doesNotMatch(benefit.summary,/Active 421|Active J-51/i);
});

test('small counts and tax building classes cannot prove free-market, SRO or a CONH exemption',()=>{
  for(const [unitsRes,bldgClass,specialDistrict] of [[2,'A1',null],[3,'S2',null],[5,'C7','CL']]){
    const profile=computeRentStabilizationProfile({unitsRes,yearBuilt:1920,bldgClass,specialDistrict});
    unverified(profile);assert.equal(profile.existingUnitsRes,unitsRes);assert.equal(profile.buildingClass,bldgClass);
    assert.doesNotMatch(profile.badgeLabel+' '+profile.summary,/\d+ SRO Units|requires HPD|statutorily|free.market units/i);
  }
});

test('count parsing keeps valid counts and exposes inconsistent totals for review',()=>{
  const zero=computeRentStabilizationProfile({unitsRes:0,yearBuilt:1920});unverified(zero);assert.equal(zero.existingUnitsRes,0);
  const recorded=computeRentStabilizationProfile({unitsRes:'8',yearBuilt:1920});unverified(recorded);assert.equal(recorded.existingUnitsRes,8);
  const conflict=computeRentStabilizationProfile({unitsRes:8,unitsTotal:2,yearBuilt:1920});unverified(conflict);
  assert.equal(conflict.existingUnitsTotal,2);assert.equal(conflict.riskLevel,'unknown');assert.match(conflict.summary,/conflict|inconsistent/i);
});

test('the high-screening filter retains explicit unknowns and pages the filtered population consistently',t=>{
  const f=tenantFixture(t),unknown=f.add('unknown'),low=f.add('zero',{unitsRes:0}),high=f.add('older',{unitsRes:8,yearBuilt:1920}),newer=f.add('newer',{unitsRes:10,yearBuilt:2000});
  assert.equal(f.get(unknown).rentStabilization.riskLevel,'unknown');assert.equal(f.get(high).rentStabilization.riskLevel,'high');
  const all=f.page({excludeHighStabilizedRisk:true});assert.equal(all.total,3);
  assert.deepEqual(all.deals.map(row=>row.id).sort(),[unknown,low,newer].sort());
  const ids=[];for(let offset=0;offset<all.total;offset++){const page=f.page({excludeHighStabilizedRisk:true,limit:1,offset});assert.equal(page.total,3);ids.push(page.deals[0].id);}
  assert.deepEqual(ids,all.deals.map(row=>row.id));
});

test('the actual research API returns screening evidence and nullable legal status, including under filtering',async t=>{
  const cleanup=[],f=tenantFixture({after:fn=>cleanup.push(fn)}),unknown=f.add('unknown'),high=f.add('older',{unitsRes:8,yearBuilt:1920});
  const chat=new ChatStore(join(f.dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'fixture'},store:chat,maps:null,marketStoreFactory:()=>new MarketStore(f.path)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));chat.close();cleanup.forEach(fn=>fn());});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/market-store/deals?minUnusedZfa=0&excludeHighStabilizedRisk=true`,{headers:{authorization:'Bearer fixture','x-acres-account':'a'.repeat(24),'x-acres-email':'alex@witharosa.ai'}});
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.total,1);assert.equal(body.deals[0].id,unknown);assert.notEqual(body.deals[0].id,high);
  unverified(body.deals[0].rentStabilization);assert.equal(body.deals[0].rentStabilization.existingUnitsRes,null);
});
