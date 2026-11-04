import test from 'node:test';
import assert from 'node:assert/strict';
import {createZoningTools, describeDistrict, capacity, suggestedLot, rules, headlineReconciliation, recordedBuildingArea} from './zoning.mjs';
import {createSubjectLedger} from './ledger.mjs';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const property = {bbl: '1000470001', address: '120 BROADWAY', zonedist1: 'C5-5', zonedist2: null, overlay1: null, spdist1: 'LM', lotarea: '66000', bldgarea: '1400000', builtfar: '21.21', residfar: '10', commfar: '15', facilfar: '15', numfloors: '40', yearbuilt: '1915', lotfront: '200', lotdepth: '330', landmark: 'EQUITABLE BUILDING', histdist: null, splitzone: false, zonemap: '12c', version: '25v2'};

test('the envelope combines PLUTO capacity, curated district rules and a suggested lot', async () => {
  const tools = createZoningTools({getProperty: () => property});
  assert.equal(tools.definitions[0].name, 'acres_zoning_envelope');
  const result = await tools.handlers.acres_zoning_envelope({});
  assert.deepEqual(result.parcel.districts, ['C5-5']);
  assert.deepEqual(result.parcel.specialDistricts, ['LM']);
  assert.equal(result.capacity.lotAreaSqft, 66000);
  assert.equal(result.capacity.byUse.commercial.maxFloorAreaSqft, 990000);
  assert.equal(result.capacity.byUse.commercial.remainingFloorAreaSqft, 0);
  assert.equal(result.capacity.byUse.commercial.builtShare, 1);
  assert.equal(result.capacity.byUse.residential.maxFar, 10);
  assert.equal(result.capacity.builtFar, 21.21);
  assert.equal(result.rules[0].code, 'C5-5');
  assert.equal(result.rules[0].farCommercial, 15);
  assert.ok(result.rules[0].citations.includes('ZR 91-21'));
  assert.equal(result.rules[1].code, 'LM');
  assert.equal(result.rules[1].kind, 'special');
  assert.deepEqual(result.suggestedLot.polygon, [[0, 0], [200, 0], [200, 330], [0, 330]]);
  assert.match(result.suggestedLot.note, /Rectangle/);
  assert.match(result.flags[0], /Landmark: EQUITABLE BUILDING/);
  assert.match(result.note, /starting points/i);
  assert.ok(result.mechanisms.some(m => m.name === 'Zoning lot merger'));
  assert.equal(tools.envelope?.district, 'C5-5');
  // The captured envelope (persisted as project state) keeps capacity, summary and the headline beside the geometry.
  const {capacity: capturedCapacity, summary: capturedSummary, headlineReconciliation: capturedHeadline, ...geometry} = tools.envelope;
  assert.deepEqual(geometry, result.envelope);
  assert.deepEqual(capturedCapacity, result.capacity);
  assert.deepEqual(capturedSummary, result.envelopeSummary);
  assert.deepEqual(capturedHeadline, result.headlineReconciliation);
});

test('district lookups, capacity edge cases and lot fallbacks', async () => {
  const tools = createZoningTools();
  const m15 = await tools.handlers.acres_zoning_envelope({district: 'm1-5'});
  assert.equal(m15.district, 'M1-5');
  assert.equal(m15.rules.farResidential, null);
  assert.equal(m15.rules.farCommercial, 5);
  const unknown = await tools.handlers.acres_zoning_envelope({district: 'M3-1'});
  assert.equal(unknown.rules, null);
  assert.match(unknown.note, /No curated entry/);
  await assert.rejects(tools.handlers.acres_zoning_envelope({}), /Select the subject property/);
  assert.equal(describeDistrict('C1-5').kind, 'overlay');
  assert.equal(describeDistrict('TMU').kind, 'special');
  assert.equal(capacity({lotarea: '0'}), null);
  const partial = capacity({lotarea: '5000', bldgarea: '20000', residfar: '0', commfar: '6', facilfar: 'n/a'});
  assert.deepEqual(Object.keys(partial.byUse), ['commercial']);
  assert.equal(partial.byUse.commercial.remainingFloorAreaSqft, 10000);
  assert.equal(partial.builtFar, 4);
  const irregular = suggestedLot({lotfront: '25', lotdepth: '100', lotarea: '4000'});
  assert.match(irregular.note, /not a simple rectangle/);
  const square = suggestedLot({lotarea: '10000'});
  assert.deepEqual(square.polygon[2], [100, 100]);
  assert.equal(suggestedLot({}), null);
  for (const [code, district] of Object.entries(rules.districts)) {
    assert.ok(Array.isArray(district.citations) && district.citations.length, `${code} needs citations`);
    assert.ok(['commercial', 'residential', 'manufacturing'].includes(district.kind), `${code} kind`);
  }
});

test('the envelope section is computed from the bulk rules and shaped for acres_model_concept', async () => {
  const tools = createZoningTools({getProperty: () => ({...property, cd: '101'})});
  const result = await tools.handlers.acres_zoning_envelope({streets: [{side: 'front', name: 'Broadway', widthFeet: 80}, {side: 'left', widthFeet: 40}, {side: 'right', widthFeet: 40}, {side: 'rear', widthFeet: 40}]});
  assert.equal(result.envelope.regime, 'lower-manhattan');
  assert.equal(result.envelope.metrics.storeys, 20);
  assert.equal(result.envelope.concept.levels.reduce((n, l) => n + (l.count || 1), 0), 20);
  assert.deepEqual(result.envelope.concept.lot, result.suggestedLot.polygon);
  assert.equal(result.envelope.parking.required, 0);
  assert.ok(result.envelope.citations.includes('ZR 91-33'));
  assert.match(result.note, /envelope.concept/);
  const assumed = await tools.handlers.acres_zoning_envelope({});
  assert.ok(assumed.envelope.checks.some(c => c.includes('narrow-street rules applied')));
  assert.equal(assumed.envelope.lot.type, 'interior');
  const byDistrict = await tools.handlers.acres_zoning_envelope({district: 'R8', lot: [[0, 0], [25, 0], [25, 100], [0, 100]], streets: [{side: 'front', widthFeet: 60}]});
  // A 25 ft R8 lot keeps its ZR 23-432 heights (ZR 23-738 limits only sky exposure plane buildings) and its
  // 30 ft rear yard under 40 ft wide (ZR 23-342): 25 x 70 floors hold the 15,050 sq ft in nine storeys.
  assert.deepEqual([byDistrict.envelope.metrics.storeys, byDistrict.envelope.metrics.floorAreaSqft], [9, 15050]);
  // The unit cap divides the floor area permitted on the lot (6.02 x 2,500 = 15,050 sq ft), not what the stack holds (ZR 23-52).
  assert.equal(byDistrict.envelope.density.maxUnits, 22);
  // The optional ZR 23-73 rules draw in R8; an R7A lot is refused (ZR 23-731: no letter suffix).
  const plane = await tools.handlers.acres_zoning_envelope({district: 'R8', lot: [[0, 0], [100, 0], [100, 100], [0, 100]], form: 'sky-exposure-plane'});
  assert.equal(plane.envelope.form, 'sky-exposure-plane');
  assert.ok(plane.envelope.controls.heightFactor.value > 0);
  const refused = await tools.handlers.acres_zoning_envelope({district: 'R7A', lot: [[0, 0], [100, 0], [100, 100], [0, 100]], form: 'sky-exposure-plane'});
  assert.equal(refused.envelope, null);
  assert.match(refused.note, /ZR 23-731/);
  assert.match(byDistrict.envelope.parking.note, /transit zone/);
  assert.equal(byDistrict.envelope.parking.transitZones.inner.required, 0);
  const noLot = await tools.handlers.acres_zoning_envelope({district: 'C5-5'});
  assert.equal(noLot.envelope, null);
  assert.match(noLot.note, /Pass `lot`/);
  const midtown = createZoningTools({getProperty: () => ({...property, zonedist1: 'C5-2.5', spdist1: 'MiD'})});
  const skipped = await midtown.handlers.acres_zoning_envelope({});
  assert.equal(skipped.envelope, null);
  assert.match(skipped.note, /special district that is not encoded/);
  const unknown = createZoningTools({getProperty: () => ({...property, zonedist1: 'M3-1', spdist1: null})});
  assert.equal((await unknown.handlers.acres_zoning_envelope({})).envelope, null);
  for (const [code, district] of Object.entries(rules.districts)) {
    if (district.bulk === null) continue;
    assert.ok(district.bulk.skyExposurePlane === null || rules.bulk.skyExposurePlane[district.bulk.skyExposurePlane], `${code} sky exposure plane table`);
    assert.ok(district.bulk.towers === null || rules.bulk.towers[district.bulk.towers], `${code} tower table`);
    if (district.residentialEquivalent) assert.ok(rules.bulk.residential[district.residentialEquivalent], `${code} residential table`);
  }
  for (const [code, row] of Object.entries(rules.bulk.residential)) assert.ok(row.citations.includes(row.lowDensity ? 'ZR 23-421' : 'ZR 23-432'), `${code} cites its height table`);
});

test('flood flags, community district and building class ride along from PLUTO', async () => {
  const flooded = {...property, cd: '101', bldgclass: 'O4', firm07_flag: '1', pfirm15_flag: '1'};
  const tools = createZoningTools({getProperty: () => flooded});
  const result = await tools.handlers.acres_zoning_envelope({});
  assert.equal(result.parcel.communityDistrict, '101');
  assert.equal(result.parcel.buildingClass, 'O4');
  assert.ok(result.flags.some(f => f.includes('2007 FIRM')));
  assert.ok(result.envelope.checks.some(c => c.includes('Article VI Chapter 4')));
  // The PLUTO community district feeds Manhattan Core parking without a model-supplied district.
  assert.equal(result.envelope.parking.required, 0);
  assert.equal(result.envelope.parking.maxNonResidentialSpaces, 110);
  const dry = await createZoningTools({getProperty: () => property}).handlers.acres_zoning_envelope({});
  assert.ok(!dry.flags.some(f => f.includes('Flood zone')));
});

test('R6 through R12 districts carry verified FAR rows', () => {
  assert.equal(describeDistrict('R6A').farResidential, 3.0);
  assert.equal(describeDistrict('R6').farResidentialAffordable, 3.9);
  assert.equal(describeDistrict('R12').farResidentialAffordable, 18.0);
  assert.equal(describeDistrict('R9-1').farCommunityFacility, 10.0);
  assert.equal(describeDistrict('R7-1').residentialEquivalent, 'R7-2');
  assert.equal(describeDistrict('R11A').farResidential, 12.0);
  assert.equal(describeDistrict('M3-1'), null);
});

test('R1 through R5 districts carry the December 2024 FARs, qualifying-site FARs and community facility FARs', () => {
  assert.deepEqual(['R1-2', 'R2', 'R2X', 'R3-2', 'R4', 'R4B', 'R5', 'R5D'].map(code => {
    const d = describeDistrict(code);
    return [code, d.farResidential, d.farResidentialQualifyingSite, d.farCommunityFacility, d.farResidentialAffordable];
  }), [['R1-2', 0.75, 1, 1, null], ['R2', 0.75, 1, 1, null], ['R2X', 1, 1, 1, null], ['R3-2', 0.75, 1, 1, null], ['R4', 1, 1.5, 2, null], ['R4B', 1, 1.5, 2, null], ['R5', 1.5, 2, 2, null], ['R5D', 2, 2, 2, null]]);
  for (const code of ['R1-1', 'R1-2A', 'R2A', 'R3-1', 'R3A', 'R3X', 'R4-1', 'R4A', 'R5A', 'R5B']) assert.ok(rules.bulk.residential[code].lowDensity, code);
});

test('envelopeSummary, ZFA vs GFA sensitivity band, and auto-recorded sourceId ride along on acres_zoning_envelope', async () => {
  const recorded = [];
  const tools = createZoningTools({
    getProperty: () => ({...property, cd: '101'}),
    record: s => { const entry = {...s, id: recorded.length + 1}; recorded.push(entry); return entry; },
  });
  const result = await tools.handlers.acres_zoning_envelope({});
  assert.equal(result.sourceId, 1);
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].text, /ZR 91-21/);
  assert.equal(recorded[0].url, 'https://zr.planning.nyc.gov/article-ix/chapter-1');
  assert.ok(result.envelopeSummary);
  assert.equal(result.envelopeSummary.modeledStoreys, result.envelope.metrics.storeys);
  assert.ok(result.envelopeSummary.wideVsNarrowStreetComparison);
  assert.ok(result.envelopeSummary.lotGeometrySensitivity);
  assert.equal(result.envelopeSummary.lotGeometrySensitivity.cornerLotScenario.maxResidentialCoveragePercent, 100);
  assert.equal(result.capacity.zfaVsGfaGuidance.overbuiltAgainstPlutoGfa, true);
  assert.equal(result.capacity.zfaVsGfaGuidance.sensitivityBand.assumedZfaAt95PercentGfaSqft, 1330000);
  assert.equal(result.capacity.zfaVsGfaGuidance.sensitivityBand.assumedZfaAt85PercentGfaSqft, 1190000);
  assert.equal(result.capacity.byUse.commercial.apparentOverageSqft, 410000);
});

const filedNow = () => new Date('2026-10-16T12:00:00Z');
const stubLedger = (filings, {retrievedAt = '2026-10-16T05:00:00Z', calls = [], subject = property} = {}) => createSubjectLedger({getProperty: () => subject, now: filedNow, openLedger: () => ({filedCapacityForParcel: bbl => { calls.push(bbl); return {bbl: subject.bbl, filings, retrievedAt, sourceUrl: 'https://data.cityofnewyork.us/d/ic3t-wcy2'}; }})});
const reconcile = async (ledger, subject = property) => (await createZoningTools({getProperty: () => subject, ledger}).handlers.acres_zoning_envelope({})).headlineReconciliation;
const nb = {bbl: property.bbl, source: 'dob_bis', jobNumber: '121234567', jobType: 'NB', status: 'PERMIT ISSUED - ENTIRE JOB/WORK', proposedZoningSqft: 912500, proposedDwellingUnits: 640, proposedStories: 44, filingDate: '2023-02-14', latestActionDate: '2024-05-01'};

// On a lot with a 900,000 sq ft building, an alteration covering at least 85 percent of it is lot wide.
const altered = {...property, bldgarea: '900000'};
const wholeA1 = {...nb, jobNumber: '121555555', jobType: 'A1', proposedZoningSqft: 980000};
const reconcileAltered = filings => reconcile(stubLedger(filings, {subject: altered}), altered);

test('headlineReconciliation sets the zoning maximum, the governing DOB filed proposal and the GFA bands beside the operative figure', async () => {
  const withdrawnNb = {...nb, jobNumber: '121000001', status: 'WITHDRAWN', proposedZoningSqft: 1200000, filingDate: '2025-01-10', latestActionDate: '2025-02-01'};
  const table = await reconcileAltered([withdrawnNb, wholeA1]);
  assert.deepEqual(table.rows.map(r => r.label), ['Zoning maximum ZFA', 'DOB filed proposed ZFA (governing NB/A1)', 'Existing building as ZFA (PLUTO GFA at 100/95/90/85 percent)', 'Operative figure']);
  assert.equal(table.rows[0].valueSqft, 990000);
  assert.equal(table.rows[0].basis, 'pluto_far_x_lot_area');
  assert.equal(table.rows[1].valueSqft, 980000);
  assert.equal(table.rows[1].jobNumber, '121555555');
  assert.equal(table.rows[1].outcome, 'PERMIT ISSUED - ENTIRE JOB/WORK');
  assert.equal(table.rows[1].stage, 'approved');
  assert.equal(table.rows[1].date, '2023-02-14');
  assert.equal(table.rows[1].proposedDwellingUnits, 640);
  assert.equal(table.rows[1].operative, true);
  assert.equal(table.rows[1].shareOfZoningMaximumPercent, 99);
  assert.deepEqual(table.rows[2].bandsSqft, {'100': 900000, '95': 855000, '90': 810000, '85': 765000});
  assert.equal(table.operativeFigure.valueSqft, 980000);
  assert.equal(table.operativeFigure.basis, 'dob_filed_proposal');
  assert.match(table.operativeFigure.reason, /121555555.*matches the zoning maximum/);
  assert.equal(table.rows[3].valueSqft, 980000);
  for (const row of table.rows) assert.doesNotMatch(String(row.reason ?? ''), /\bsay so\b|\bstate\b/i);

  const zoningOnly = (await createZoningTools({getProperty: () => property}).handlers.acres_zoning_envelope({})).headlineReconciliation;
  assert.equal(zoningOnly.rows[1].valueSqft, null);
  assert.match(zoningOnly.rows[1].reason, /ledger/);
  assert.equal(zoningOnly.operativeFigure.basis, 'zoning_maximum');
  assert.equal(zoningOnly.operativeFigure.maximumBasis, 'pluto_far_x_lot_area');
  assert.equal(zoningOnly.operativeFigure.valueSqft, 990000);
  assert.match(zoningOnly.operativeFigure.reason, /zoning maximum stands, PLUTO commercial FAR 15 x 66,000 sq ft of lot area/);
});

test('an approved current new building, even at 150 percent of the zoning maximum, is qualified context while its lot span is unproven', async () => {
  const nb150 = {...nb, proposedZoningSqft: 1485000};
  const table = await reconcile(stubLedger([nb150]));
  const filedRow = table.rows.find(r => r.label === 'DOB filed proposed ZFA (governing NB/A1)');
  assert.equal(filedRow.valueSqft, 1485000);
  assert.equal(filedRow.operative, false);
  assert.equal(filedRow.shareOfZoningMaximumPercent, 150);
  assert.match(filedRow.reason, /^Context, not the headline: the ledger records no zoning lot span.*150 percent of the zoning maximum/);
  assert.equal(table.operativeFigure.basis, 'zoning_maximum');
  assert.equal(table.operativeFigure.valueSqft, 990000);
  assert.match(table.operativeFigure.reason, /DOB job 121234567 is not operative because the ledger records no zoning lot span/);
  // A lot-wide alteration above the maximum by more than 2 percent with no documented bonus is context too.
  const overA1 = await reconcileAltered([{...wholeA1, proposedZoningSqft: 1250000}]);
  assert.equal(overA1.operativeFigure.valueSqft, 990000);
  assert.match(overA1.rows[1].reason, /126 percent of the zoning maximum, so it likely relies on a bonus, transfer or merger/);
});

test('coinciding PLUTO and envelope products still reconcile their sources and the entitlement baseline', async () => {
  // P4: PLUTO 6.0 FAR over its 10,000 sq ft lot (60,000) against the curated 7.52 over the
  // 8,000 sq ft outline (60,160): within 2 percent by coincidence, so the note must fire on
  // source difference, and the 75,200 entitlement baseline must be named beside the headline.
  const lot = {bbl: '1000477502', zonedist1: 'R9A', lotarea: '10000', lotfront: '80', lotdepth: '100', residfar: '6', bldgarea: '5000'};
  const table = (await createZoningTools({getProperty: () => lot}).handlers.acres_zoning_envelope({})).headlineReconciliation;
  assert.equal(table.operativeFigure.valueSqft, 60000);
  assert.match(table.rows[0].reason, /similar totals do not mean the sources agree/);
  const baseline = table.rows.find(row => row.label.startsWith('Entitlement baseline'));
  assert.ok(baseline, 'the entitlement baseline row is present');
  assert.equal(baseline.valueSqft, 75200);
  assert.equal(baseline.basis, 'curated_far_x_pluto_lot_area');
  assert.match(baseline.reason, /verify the district FAR against current Zoning Resolution text/);
});

test('a lot without PLUTO FARs headlines the envelope maximum with its basis instead of no figure', async () => {
  const r9a = {bbl: '1000477501', zonedist1: 'R9A', lotarea: '10000', lotfront: '100', lotdepth: '100', bldgarea: '5000'};
  const result = await createZoningTools({getProperty: () => r9a}).handlers.acres_zoning_envelope({});
  const table = result.headlineReconciliation;
  assert.deepEqual(result.capacity.byUse, {});
  assert.equal(table.rows[0].valueSqft, 75200);
  assert.equal(table.rows[0].basis, 'curated_far_x_lot_outline');
  assert.match(table.rows[0].reason, /PLUTO states no maximum FAR.*envelope fits [\d,]+ sq ft of gross floor area/);
  assert.equal(table.operativeFigure.valueSqft, result.envelope.floorArea.maxFloorAreaSqft);
  assert.equal(table.operativeFigure.basis, 'zoning_maximum');
  assert.match(table.operativeFigure.reason, /curated R9A FAR 7\.52 x the 10,000 sq ft modeled lot outline/);
  assert.deepEqual(table.operativeFigure.remainingRangeSqft, {atFull: 70200, at85Percent: 70950});
  assert.doesNotMatch(JSON.stringify(table), /No ZFA figure is computed/);
});

test('a community facility FAR is a conditional row, never the operative figure', async () => {
  const cf = {...property, lotarea: '10000', bldgarea: '20000', residfar: '3.44', commfar: '2', facilfar: '4.8', numfloors: '4'};
  const table = (await createZoningTools({getProperty: () => cf}).handlers.acres_zoning_envelope({})).headlineReconciliation;
  assert.equal(table.operativeFigure.valueSqft, 34400);
  assert.equal(table.rows[0].use, 'residential');
  const conditional = table.rows.find(r => r.conditional);
  assert.equal(conditional.label, 'Community facility maximum ZFA (conditional)');
  assert.equal(conditional.valueSqft, 48000);
  assert.match(conditional.reason, /qualifying community facility program/);
  assert.notEqual(table.operativeFigure.valueSqft, 48000);
});

test('a filed ZFA is operative only when the governing filing is approved, current and lot wide', async () => {
  const curatedStands = (table, why) => {
    assert.equal(table.operativeFigure.basis, 'zoning_maximum');
    assert.equal(table.operativeFigure.valueSqft, 990000);
    assert.equal(table.rows[1].operative, false);
    assert.match(table.rows[1].reason, why);
    assert.match(table.operativeFigure.reason, why);
  };
  const signedOff = {...nb, jobNumber: '120000009', status: 'SIGNED OFF', proposedZoningSqft: 800000, filingDate: '2009-03-01', latestActionDate: '2012-06-01'};
  const dobNow = {bbl: property.bbl, source: 'dob_now', jobNumber: 'B00999999-I1', jobType: 'New Building', status: 'Plan Examiner Review', proposedZoningSqft: null, proposedDwellingUnits: 700, filingDate: '2025-06-01', latestActionDate: '2026-01-10'};
  const newer = await reconcile(stubLedger([signedOff, dobNow]));
  assert.equal(newer.rows[1].jobNumber, 'B00999999-I1');
  assert.equal(newer.rows[1].valueSqft, null);
  assert.equal(newer.rows[1].earlierWithZfa.jobNumber, '120000009');
  assert.match(newer.rows[1].reason, /120000009/);
  curatedStands(newer, /not approved it yet/);

  const approvedDobNow = await reconcile(stubLedger([signedOff, {...dobNow, status: 'Permit Entire'}]));
  curatedStands(approvedDobNow, /DOB NOW publishes no proposed zoning floor area/);
  curatedStands(await reconcile(stubLedger([signedOff])), /signed off/);
  curatedStands(await reconcile(stubLedger([{...nb, status: 'PLAN EXAM - DISAPPROVED', proposedZoningSqft: 1500000}])), /not approved it/);
  curatedStands(await reconcile(stubLedger([{...nb, status: 'PRE-FILING', filingDate: '2026-09-01', latestActionDate: '2026-09-01'}])), /pre-filing/);
  curatedStands(await reconcile(stubLedger([{...nb, filingDate: '2012-02-14', latestActionDate: '2014-05-01'}])), /lapsed/);
  const smallA1 = {...nb, jobNumber: '121777777', jobType: 'A1', proposedZoningSqft: 2500, filingDate: '2025-04-01', latestActionDate: '2025-08-01'};
  curatedStands(await reconcile(stubLedger([signedOff, smallA1])), /work area/);

  // A current approved new building governs over a later alteration and over a later job stalled in
  // pre-filing, and stays context while its zoning lot span is unrecorded.
  const governed = await reconcile(stubLedger([{...smallA1, filingDate: '2025-09-01'}, {...nb, jobNumber: '121888888', status: 'PRE-FILING', proposedZoningSqft: 400000, filingDate: '2026-01-05', latestActionDate: '2026-01-05'}, nb]));
  assert.equal(governed.rows[1].jobNumber, '121234567');
  curatedStands(governed, /no zoning lot span/);
  // A current approved lot-wide alteration governs over a later stalled job and headlines.
  const alteration = await reconcileAltered([{...nb, jobNumber: '121888888', status: 'PRE-FILING', filingDate: '2026-01-05', latestActionDate: '2026-01-05'}, wholeA1]);
  assert.equal(alteration.rows[1].jobNumber, '121555555');
  assert.equal(alteration.operativeFigure.basis, 'dob_filed_proposal');
});

test('a filed ZFA with no zoning maximum to check it against is the filer\'s figure, unverified, never the headline', async () => {
  // A lot split between two districts with no per-district apportionment has no lot maximum to compare.
  const split = {...altered, zonedist1: 'R6A', zonedist2: 'C6-4', splitzone: 'Y', lotarea: '20000', lotfront: '100', lotdepth: '200', residfar: '3', commfar: '6.5', bldgarea: '50000'};
  const table = await reconcile(stubLedger([{...wholeA1, proposedZoningSqft: 200000}], {subject: split}), split);
  const filedRow = table.rows.find(r => r.label === 'DOB filed proposed ZFA (governing NB/A1)');
  assert.equal(filedRow.valueSqft, 200000);
  assert.equal(filedRow.operative, false);
  assert.match(filedRow.reason, /^Context, not the headline: no zoning maximum is available to check it against, so it is the filer's own figure, unverified/);
  assert.equal(table.operativeFigure.valueSqft, null);
  assert.equal(table.operativeFigure.basis, null);
  assert.match(table.operativeFigure.reason, /^No ZFA figure is computed: the lot is split.*DOB job 121555555 is not operative because no zoning maximum is available/);
  // The same holds wherever the maximum is missing, split lot or not.
  const unbounded = headlineReconciliation(null, {proposal: {...wholeA1, proposedZoningSqft: 200000}, stage: 'approved', notOperative: null});
  assert.equal(unbounded.operativeFigure.valueSqft, null);
  assert.equal(unbounded.rows.find(r => r.jobNumber === '121555555').operative, false);
});

test('the headline reconciliation degrades to the zoning maximum when the ledger is unsynced, unreadable or absent, and the subject brief reads it without capturing', async () => {
  const unsynced = await reconcile(stubLedger([nb], {retrievedAt: null}));
  assert.equal(unsynced.rows[1].valueSqft, null);
  assert.match(unsynced.rows[1].reason, /not been synced/);
  assert.equal(unsynced.operativeFigure.basis, 'zoning_maximum');
  assert.match(unsynced.operativeFigure.reason, /not been synced/);

  const broken = createSubjectLedger({getProperty: () => property, openLedger: () => { throw new Error('database is locked'); }});
  const unreadable = await reconcile(broken);
  assert.match(unreadable.rows[1].reason, /could not be read \(database is locked\)/);
  assert.equal(unreadable.operativeFigure.valueSqft, 990000);

  const calls = [];
  const briefTools = createZoningTools({getProperty: () => property, ledger: stubLedger([nb], {calls})});
  const brief = await briefTools.handlers.acres_zoning_envelope({}, {capture: false});
  assert.equal(brief.headlineReconciliation.rows[1].jobNumber, '121234567');
  assert.deepEqual(calls, [property.bbl]);
  assert.equal(briefTools.envelope, null);

  const dir = mkdtempSync(join(tmpdir(), 'zoning-ledger-')), saved = process.env.ACRES_LEDGER_DB;
  process.env.ACRES_LEDGER_DB = join(dir, 'ledger.sqlite');
  try {
    const absent = await reconcile(createSubjectLedger({getProperty: () => property}));
    assert.match(absent.rows[1].reason, /not been synced/);
    assert.equal(existsSync(process.env.ACRES_LEDGER_DB), false);
  } finally {
    if (saved === undefined) delete process.env.ACRES_LEDGER_DB; else process.env.ACRES_LEDGER_DB = saved;
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a commercial district resolves to its own residential equivalent (ZR 34-112), never its unsuffixed district', () => {
  const equivalent = code => describeDistrict(code)?.residentialEquivalent;
  assert.deepEqual(['C6-4A', 'C5-2A', 'C6-4X', 'C6-3D', 'C6-3X', 'C6-1A', 'C4-4A', 'C4-5D'].map(equivalent), ['R10A', 'R10A', 'R10X', 'R9D', 'R9X', 'R6', 'R7A', 'R7D']);
  assert.deepEqual([describeDistrict('C6-4A').farResidential, describeDistrict('C6-4A').farResidentialAffordable], [10, 12]);
  // A curated commercial row takes its equivalent's wide-street row: C6-2 within 100 ft of a wide street is R8's 7.2 and 8.64.
  assert.deepEqual(describeDistrict('C6-2').farResidentialWideStreet, rules.districts.R8.farResidentialWideStreet);
  // Every curated commercial row agrees with the table.
  for (const [code, district] of Object.entries(rules.districts)) {
    const listed = rules.commercialResidentialEquivalents.districts[code];
    if (district.kind === 'commercial' && listed) assert.equal(district.residentialEquivalent, listed, code);
  }
  assert.equal(describeDistrict('C6-2M'), null);
});

test('a lot whose building area PLUTO does not record reads as unknown, not vacant', async () => {
  const lot = {bbl: '1000470001', zonedist1: 'R9A', lotarea: '10000', lotfront: '100', lotdepth: '100', residfar: '6'};
  for (const gap of [{}, {bldgarea: ''}, {bldgarea: '0', numbldgs: '1'}, {bldgarea: '0', yearbuilt: '1920'}]) {
    const cap = capacity({...lot, ...gap});
    assert.equal(cap.builtFloorAreaSqft, null, JSON.stringify(gap));
    assert.equal(cap.builtFar, null);
    assert.equal(cap.byUse.residential.maxFloorAreaSqft, 60000);
    assert.equal(cap.byUse.residential.remainingFloorAreaSqft, null);
    assert.equal(cap.existingFloorArea.basis, 'unknown');
    assert.match(cap.existingFloorArea.reason, /does not record.*building area.*certificate of occupancy/i);
  }
  const vacant = capacity({...lot, bldgarea: '0', numbldgs: '0', yearbuilt: '0'});
  assert.equal(vacant.builtFloorAreaSqft, 0);
  assert.equal(vacant.byUse.residential.remainingFloorAreaSqft, 60000);
  const filed = capacity(lot, {existingZfaSqft: 45000, basis: 'A1 states it'});
  assert.equal(filed.existingFloorArea.basis, 'dob_filed_zfa');
  assert.equal(filed.byUse.residential.remainingFloorAreaSqft, 15000);
  const result = await createZoningTools({getProperty: () => ({...lot, numbldgs: '2'})}).handlers.acres_zoning_envelope({});
  assert.equal(result.headlineReconciliation.operativeFigure.valueSqft, 60000);
  assert.equal(result.headlineReconciliation.operativeFigure.remainingRangeSqft, undefined);
  assert.match(result.headlineReconciliation.operativeFigure.reason, /remaining capacity is unknown/);
  const bandRow = rows => rows.find(r => r.label.startsWith('Existing building as ZFA (PLUTO GFA'));
  assert.match(bandRow(result.headlineReconciliation.rows).reason, /does not record a building area/);
  assert.doesNotMatch(bandRow(result.headlineReconciliation.rows).reason, /vacant/);
  assert.match(result.note, /does not record/);
  // A DOB filing states the existing floor area, so remaining is measured, but PLUTO's gap is still not a vacant lot.
  const gap = {...lot, bldgarea: '0', numbldgs: '2'};
  const withFiling = headlineReconciliation(capacity(gap, {existingZfaSqft: 45000, basis: 'A1 states it'}), {proposal: null, reason: 'none'});
  assert.equal(withFiling.rows.find(r => r.label === 'Existing building ZFA (DOB filing)').valueSqft, 45000);
  assert.doesNotMatch(bandRow(withFiling.rows).reason, /vacant/);
  assert.match(bandRow(headlineReconciliation(capacity({...lot, bldgarea: '0'}), {proposal: null, reason: 'none'}).rows).reason, /reads as vacant/);
});

test('PLUTO classing a lot as vacant land or an open lot settles it as vacant, whatever its year built', () => {
  const lot = {zonedist1: 'R9A', lotarea: '10000', residfar: '6', bldgarea: '0', yearbuilt: '2019'};
  for (const vacant of [{bldgclass: 'V1', landuse: '11'}, {landuse: '11'}, {bldgclass: 'V0'}, {bldgclass: 'G7', numbldgs: '1'}, {bldgclass: 'V1', bldgarea: ''}]) {
    const cap = capacity({...lot, ...vacant});
    assert.equal(cap.builtFloorAreaSqft, 0, JSON.stringify(vacant));
    assert.equal(cap.existingFloorArea.basis, 'pluto_gross');
    assert.equal(cap.byUse.residential.remainingFloorAreaSqft, 60000);
    assert.match(headlineReconciliation(cap, {proposal: null, reason: 'none'}).rows.find(r => r.label.startsWith('Existing building as ZFA (PLUTO GFA')).reason, /reads as vacant/);
  }
  // A garage or any other building class still counts the year built as a building whose area is missing.
  assert.equal(recordedBuildingArea({...lot, bldgclass: 'G0', landuse: '10'}), null);
  assert.equal(recordedBuildingArea({...lot, bldgclass: 'V1', bldgarea: '1200'}), 1200);
  assert.equal(recordedBuildingArea({...lot, landuse: '11', bldgarea: '-5'}), null);
});

test('the envelope summary of a split lot says it models one district over the whole lot', async () => {
  const split = {bbl: '1000470001', zonedist1: 'R6A', zonedist2: 'C6-4', splitzone: 'Y', lotarea: '20000', lotfront: '100', lotdepth: '200', residfar: '3', commfar: '6.5', bldgarea: '0'};
  const unapportioned = await createZoningTools({getProperty: () => split}).handlers.acres_zoning_envelope({});
  assert.equal(unapportioned.headlineReconciliation.operativeFigure.valueSqft, null);
  assert.deepEqual({...unapportioned.envelopeSummary.splitLot, note: undefined}, {wholeLotBound: true, modeledDistrict: 'R6A', apportioned: false, note: undefined});
  assert.match(unapportioned.envelopeSummary.splitLot.note, /^The lot is split between zoning districts.*R6A.*not the lot's capacity.*No per-district apportionment/);
  const lookups = async () => ({zoning: {districts: [{code: 'R6A', sharePercent: 70}, {code: 'C6-4', sharePercent: 30}], overlays: [], specialDistricts: [], sliversIgnored: [], mappedLotAreaSqft: 20000, source: 'DCP'}, existingZfa: {existingZfaSqft: null, basis: 'none'}});
  const apportioned = await createZoningTools({getProperty: () => split, lookups}).handlers.acres_zoning_envelope({});
  assert.equal(apportioned.envelopeSummary.splitLot.apportioned, true);
  assert.match(apportioned.envelopeSummary.splitLot.note, /per-district apportionment \(ZR 77-22\)/);
  const uncuratedLookups = async () => ({zoning: {districts: [{code: 'R6A', sharePercent: 60}, {code: 'M1-6', sharePercent: 40}], overlays: [], specialDistricts: [], sliversIgnored: [], mappedLotAreaSqft: 20000, source: 'DCP'}, existingZfa: {existingZfaSqft: null, basis: 'none'}});
  const uncurated = await createZoningTools({getProperty: () => ({...split, zonedist2: 'M1-6'}), lookups: uncuratedLookups}).handlers.acres_zoning_envelope({});
  assert.deepEqual(uncurated.parcel.splitLotApportionment.portions.map(p => p.sharePercent), [60, 40]);
  assert.equal(uncurated.envelopeSummary.splitLot.apportioned, false);
  assert.deepEqual(uncurated.envelopeSummary.splitLot.uncuratedDistricts, ['M1-6']);
  assert.match(uncurated.envelopeSummary.splitLot.note, /splitLotApportionment gives each district's share of the lot\. The split-lot total is open because M1-6 has no curated floor area ratio/);
  assert.doesNotMatch(uncurated.envelopeSummary.splitLot.note, /No per-district apportionment|find each district's share/);
  const supplied = await createZoningTools({getProperty: () => split}).handlers.acres_zoning_envelope({maxFar: 4.2});
  assert.match(supplied.envelopeSummary.splitLot.note, /R6A height and setback rules to the whole lot at the supplied FAR 4\.2, so its storeys are a bound for that district and its floor area is the lot's capacity only if that FAR is the lot's area-weighted FAR/);
  assert.doesNotMatch(supplied.envelopeSummary.splitLot.note, /storeys and floor area are a bound/);
  const single = await createZoningTools({getProperty: () => ({...split, zonedist2: null, splitzone: 'N'})}).handlers.acres_zoning_envelope({});
  assert.equal('splitLot' in single.envelopeSummary, false);
});
