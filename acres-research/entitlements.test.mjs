import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {entitlementScenarios, createEntitlementTools} from './entitlements.mjs';

const byId = (out, id) => out.scenarios.find(s => s.id === id);

test('UAP uplift is matched 1:1 by affordable floor area up to the QAH cap', () => {
  const max = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000});
  assert.equal(max.baseline.maxFloorAreaSqft, 75200);
  const uap = byId(max, 'universal-affordability-preference');
  assert.equal(uap.addedFloorAreaSqft, 15000);
  assert.equal(uap.affordableRequiredSqft, 15000);
  assert.equal(uap.resultingFar, 9.02);
  const partial = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, affordableFloorAreaSqft: 6000});
  assert.equal(byId(partial, 'universal-affordability-preference').addedFloorAreaSqft, 6000);
  assert.equal(byId(partial, 'universal-affordability-preference').resultingFar, 8.12);
});

test('landmark transfers respect the ZR 75-422 receiving caps', () => {
  const out = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, landmark: {lotAreaSqft: 20000, existingFloorAreaSqft: 20000, maxFar: 7.52}});
  const tdr = byId(out, 'landmark-transfer');
  assert.equal(tdr.transferableSqft, 130400);
  assert.equal(tdr.receivingCapPercent, 20);
  assert.equal(tdr.addedFloorAreaSqft, 15040);
  const high = entitlementScenarios({district: 'C5-5', lotAreaSqft: 10000, landmark: {lotAreaSqft: 20000, existingFloorAreaSqft: 0, maxFar: 15}});
  assert.equal(byId(high, 'landmark-transfer').receivingCapPercent, 30);
  // R6 community-facility FAR (4.8) is higher than its residential FAR (2.2); the receiving cap is a
  // share of the residential baseline the transfer adds to, not of the facility ceiling.
  const r6 = entitlementScenarios({district: 'R6', lotAreaSqft: 10000, landmark: {lotAreaSqft: 20000, existingFloorAreaSqft: 0, maxFar: 4.8}});
  assert.equal(byId(r6, 'landmark-transfer').receivingCapSqft, 4400);
  assert.equal(byId(r6, 'landmark-transfer').addedFloorAreaSqft, 4400);
});

test('mergers pool unused floor area and conversions respect the 1990 cutoff', () => {
  const out = entitlementScenarios({
    district: 'R9A', lotAreaSqft: 10000,
    mergerLots: [{lotAreaSqft: 5000, builtFloorAreaSqft: 10000, maxFar: 7.52}],
    conversion: {yearBuilt: 1960, nonResidentialSqft: 50000, mechanicalSqft: 2000},
  });
  assert.equal(byId(out, 'zoning-lot-merger').addedFloorAreaSqft, 27600);
  const conv = byId(out, 'residential-conversion');
  assert.equal(conv.eligible, true);
  assert.equal(conv.unlocksExistingSqft, 52000);
  const late = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, conversion: {yearBuilt: 2001, nonResidentialSqft: 50000}});
  assert.equal(byId(late, 'residential-conversion').eligible, false);
  assert.equal(byId(late, 'residential-conversion').addedFloorAreaSqft, 0);
  assert.doesNotMatch(JSON.stringify([out, late, entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, requestedFloorAreaSqft: 100000})]), /\u2014/);
});

test('sized merger, PLUTO conversion, mixed community facility and retain-or-rebuild paths are explicit', async () => {
  const merged = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, mergerLots: [{bbl: '1000000001', address: '2 Example Street', lotAreaSqft: 5000, builtFloorAreaSqft: 10000, maxFar: 7.52}]});
  assert.deepEqual(byId(merged, 'zoning-lot-merger').adjoiningLots[0], {bbl: '1000000001', address: '2 Example Street', lotAreaSqft: 5000, builtFloorAreaSqft: 10000, maxFar: 7.52, unusedFloorAreaSqft: 27600});
  const mixed = byId(entitlementScenarios({district: 'R6', lotAreaSqft: 10000}), 'mixed-residential-community-facility');
  assert.deepEqual([mixed.residentialFloorAreaSqft, mixed.communityFacilityFloorAreaSqft, mixed.totalFloorAreaSqft], [22000, 26000, 48000]);
  const over = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, existingFloorAreaSqft: 90000});
  assert.deepEqual([byId(over, 'retain-non-complying-building').retainedExcessSqft, byId(over, 'rebuild-to-current-maximum').reductionFromExistingSqft], [14800, 14800]);
  const tools = createEntitlementTools({enabled: true, getProperty: () => ({zonedist1: 'R9A', lotarea: '10000', bldgarea: '80000', resarea: '20000', garagearea: '5000', yearbuilt: '1960'})});
  const converted = await tools.handlers.acres_entitlement_scenarios({});
  assert.deepEqual([byId(converted, 'residential-conversion').eligible, byId(converted, 'residential-conversion').unlocksExistingSqft, byId(converted, 'residential-conversion').areaSource], [true, 55000, 'PLUTO building area less residential and garage area']);
});

test('discretionary paths carry the five findings and rank below as-of-right paths', () => {
  const out = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, requestedFloorAreaSqft: 100000});
  const variance = byId(out, 'bsa-variance');
  assert.equal(variance.addedFloorAreaSqft, 24800);
  assert.match(variance.conditions[0], /unique physical conditions/);
  assert.match(variance.conditions[0], /minimum variance necessary/);
  const quantified = out.scenarios.filter(s => s.addedFloorAreaSqft !== null);
  for (let i = 1; i < quantified.length; i++) assert.ok(quantified[i - 1].feasibilityScore >= quantified[i].feasibilityScore);
  assert.equal(quantified.at(-1).id, 'rezoning-ulurp');
});

test('a modest upzoning within the 30% limit takes ELURP and ranks above ULURP', () => {
  const out = entitlementScenarios({district: 'R6A', lotAreaSqft: 10000});
  const elurp = byId(out, 'rezoning-elurp');
  assert.equal(elurp.approval, 'elurp');
  assert.equal(elurp.risk, 'medium');
  assert.equal(elurp.elurpCeilingFar, 5.07);
  assert.equal(elurp.addedFloorAreaSqft, 20700);
  assert.ok(elurp.feasibilityScore > byId(out, 'bsa-variance').feasibilityScore);
  assert.ok(elurp.feasibilityScore > byId(out, 'rezoning-ulurp').feasibilityScore);
  assert.equal(elurp.illustrativeQualifyingDistricts[0].district, 'R7A');
  const [r7a, r7d] = out.contextualRezoningBenchmarks.benchmarks;
  assert.deepEqual([r7a.illustrativeDistrict, r7a.reviewPath, r7a.maxResidentialFloorAreaIncreasePercent], ['R7A', 'ELURP', 28.5]);
  assert.deepEqual([r7d.illustrativeDistrict, r7d.reviewPath], ['R7D', 'ULURP']);
  assert.match(r7d.ulurpBecause[0], /above the 30% limit/);
});

test('ELURP is capped at the 30% ceiling and excludes new tower planes and new commercial bulk', () => {
  const within = byId(entitlementScenarios({district: 'R6A', lotAreaSqft: 10000, requestedFloorAreaSqft: 45000}), 'rezoning-elurp');
  assert.equal(within.coversRequestedProgram, true);
  assert.equal(within.totalFloorAreaSqft, 45000);
  const beyond = entitlementScenarios({district: 'R6A', lotAreaSqft: 10000, requestedFloorAreaSqft: 60000});
  assert.equal(byId(beyond, 'rezoning-elurp').coversRequestedProgram, false);
  assert.equal(byId(beyond, 'rezoning-elurp').totalFloorAreaSqft, 50700);
  assert.equal(byId(beyond, 'rezoning-ulurp').totalFloorAreaSqft, 60000);
  const qualifying = byId(entitlementScenarios({district: 'R7D', lotAreaSqft: 10000}), 'rezoning-elurp').illustrativeQualifyingDistricts.map(d => d.district);
  assert.ok(qualifying.includes('R8A'));
  assert.ok(!qualifying.includes('R8'));
  assert.ok(!qualifying.includes('C6-2A'));
});

test('districts without R6-equivalent residence stay on ULURP, and MIH cites ZR 27-131', () => {
  const out = entitlementScenarios({district: 'M1-5', lotAreaSqft: 10000});
  assert.equal(byId(out, 'rezoning-elurp'), undefined);
  assert.match(byId(out, 'rezoning-ulurp').conditions[0], /cannot use the medium- and high-density ELURP path/);
  assert.ok(out.contextualRezoningBenchmarks.benchmarks.every(b => b.reviewPath === 'ULURP'));
  const text = JSON.stringify(entitlementScenarios({district: 'R6A', lotAreaSqft: 10000}));
  assert.doesNotMatch(text, /23-90/);
  assert.match(text, /ZR 27-131 \(MIH\)/);
  assert.match(text, /confirm the current district list/);
});

test('the tool is gated, defaults from the selected property, and records a citable statutory source', async () => {
  assert.deepEqual(createEntitlementTools({}).definitions, []);
  const recorded = [];
  const tools = createEntitlementTools({
    enabled: true,
    getProperty: () => ({zonedist1: 'R9A', lotarea: '10000', bldgarea: '5000', yearbuilt: '1960'}),
    record: s => { const entry = {...s, id: recorded.length + 1}; recorded.push(entry); return entry; },
  });
  const out = await tools.handlers.acres_entitlement_scenarios({conversion: {nonResidentialSqft: 40000}});
  assert.equal(out.baseline.remainingFloorAreaSqft, 70200);
  assert.equal(byId(out, 'residential-conversion').eligible, true);
  assert.equal(byId(out, 'universal-affordability-preference').affordableShareOfTotalPercent, 16.6);
  assert.ok(out.contextualRezoningBenchmarks.benchmarks.length > 0);
  assert.equal(out.sourceId, 1);
  assert.equal(recorded.length, 1);
});

test('the research host installer ships the entitlements module research imports', () => {
  const installer = readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8');
  assert.match(installer, /\bentitlements\.mjs\b/);
  assert.match(installer, /\bresearch\.mjs\b/);
});


test('low-density districts get scenarios: no UAP, and a qualifying residential site where it adds floor area', () => {
  const r2 = entitlementScenarios({district: 'R2', lotAreaSqft: 8000});
  const ids = r2.scenarios.map(s => s.id);
  assert.ok(ids.includes('as-of-right') && !ids.includes('universal-affordability-preference'));
  assert.equal(r2.scenarios.find(s => s.id === 'as-of-right').totalFloorAreaSqft, 6000);
  assert.equal(r2.scenarios.find(s => s.id === 'qualifying-residential-site').totalFloorAreaSqft, 8000);
  const r4 = entitlementScenarios({district: 'R4', lotAreaSqft: 5000}).scenarios.find(s => s.id === 'qualifying-residential-site');
  assert.deepEqual([r4.resultingFar, r4.addedFloorAreaSqft, r4.approval], [1.5, 2500, 'as-of-right']);
  assert.ok(r4.citations.includes('ZR 23-21'));
  assert.ok(!entitlementScenarios({district: 'R5D', lotAreaSqft: 5000}).scenarios.some(s => s.id === 'qualifying-residential-site'), 'R5D has the same FAR either way');
});

test('a lot whose building area PLUTO does not record has an unknown baseline, not a vacant one', async () => {
  const lot = {zonedist1: 'R9A', lotarea: '10000'};
  for (const gap of [{}, {bldgarea: '0', numbldgs: '2'}, {bldgarea: '0', yearbuilt: '1920'}]) {
    const out = await createEntitlementTools({enabled: true, getProperty: () => ({...lot, ...gap})}).handlers.acres_entitlement_scenarios({});
    assert.equal(out.baseline.maxFloorAreaSqft, 75200, JSON.stringify(gap));
    assert.equal(out.baseline.existingFloorAreaSqft, null);
    assert.equal(out.baseline.remainingFloorAreaSqft, null);
    assert.match(out.baseline.existingFloorAreaReason, /unknown.*certificate of occupancy/);
  }
  const vacant = await createEntitlementTools({enabled: true, getProperty: () => ({...lot, bldgarea: '0'})}).handlers.acres_entitlement_scenarios({});
  assert.deepEqual([vacant.baseline.existingFloorAreaSqft, vacant.baseline.remainingFloorAreaSqft], [0, 75200]);
  const filed = await createEntitlementTools({enabled: true, getProperty: () => ({...lot, bldgarea: '0', numbldgs: '2'}), lookups: async () => ({existingZfa: {existingZfaSqft: 45000}})}).handlers.acres_entitlement_scenarios({});
  assert.deepEqual([filed.baseline.existingFloorAreaSqft, filed.baseline.remainingFloorAreaSqft], [45000, 30200]);
  const stated = await createEntitlementTools({enabled: true, getProperty: () => ({...lot, numbldgs: '2'})}).handlers.acres_entitlement_scenarios({existingFloorAreaSqft: 20000});
  assert.equal(stated.baseline.remainingFloorAreaSqft, 55200);
});

 test('same-block candidates size merger automatically, omit unknown built area, and retain provenance',async()=>{
 const tools=createEntitlementTools({enabled:true,getProperty:()=>({zonedist1:'R9A',lotarea:10000,bldgarea:20000}),getSameBlock:()=>({sourceId:7,adjacentBlockLots:[{bbl:'1000000002',address:'2 Example',lotarea:5000,bldgarea:10000,estimatedUnusedStandardZfa:27600},{bbl:'1000000003',lotarea:4000,bldgarea:null,estimatedUnusedStandardZfa:null}]})});
 const out=await tools.handlers.acres_entitlement_scenarios({});
 assert.equal(byId(out,'zoning-lot-merger').addedFloorAreaSqft,27600);assert.equal(byId(out,'zoning-lot-merger').adjoiningLots.length,1);assert.equal(out.mergerSourceId,7);assert.match(out.mergerBasis,/contiguity.*unverified/);
 });
