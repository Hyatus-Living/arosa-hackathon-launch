import test from 'node:test';
import assert from 'node:assert/strict';
import {computeEnvelope, conceptArguments, dwellingUnits, parking, polygonArea, inset, clipToArea, clipToDimension, describeStreets, transitZoneOf, storeyOutlines} from './envelope.mjs';
import {rules, describeDistrict, createZoningTools} from './zoning.mjs';
import {conceptDefinition} from './concepts.mjs';
import {residentialFarFor} from './market-store.mjs';

const rect = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];

test('geometry helpers clip from the right sides', () => {
  const lot = rect(100, 200);
  assert.equal(polygonArea(lot), 20000);
  assert.deepEqual(inset(lot, {front: 10, rear: 20, left: 5, right: 5}), [[5, 10], [95, 10], [95, 180], [5, 180]]);
  assert.deepEqual(inset(lot, {rear: 250}), []);
  const trimmed = clipToArea(lot, 13000);
  assert.ok(Math.abs(polygonArea(trimmed) - 13000) < 0.01);
  assert.equal(trimmed.every(p => p[1] <= 130.001), true);
  const narrowed = clipToDimension(lot, 175);
  const xs = narrowed.map(p => p[0]), zs = narrowed.map(p => p[1]);
  assert.ok(Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) <= 175.001);
  assert.equal(Math.min(...zs), 0);
  assert.deepEqual(clipToDimension(rect(50, 50), 175), rect(50, 50));
  const streets = describeStreets([{side: 'front', widthFeet: 100}, {side: 'left', widthFeet: 60}, {side: 'right'}], rules);
  assert.equal(streets.lotType, 'corner');
  assert.deepEqual(streets.streets.map(s => [s.wide, s.assumedNarrow]), [[true, false], [false, false], [false, true]]);
  assert.equal(describeStreets([{side: 'front'}, {side: 'rear'}], rules).lotType, 'through');
  assert.equal(describeStreets(undefined, rules).lotType, 'interior');
});

test('120 Broadway: C5-5 in the Special Lower Manhattan District on a full block', () => {
  // The PLUTO rectangle from the zoning tests; the 80 ft Broadway and 40 ft side streets are inputs, not verified widths.
  const envelope = computeEnvelope({rules, district: describeDistrict('C5-5'), specialDistricts: ['LM'], lot: rect(200, 330), frontages: [{side: 'front', name: 'Broadway', widthFeet: 80}, {side: 'left', widthFeet: 40}, {side: 'right', widthFeet: 40}, {side: 'rear', widthFeet: 40}], communityDistrict: '101'});
  assert.equal(envelope.regime, 'lower-manhattan');
  assert.equal(envelope.lot.type, 'block');
  assert.equal(envelope.floorArea.maxFar, 15);
  assert.equal(envelope.floorArea.maxFloorAreaSqft, 990000);
  // Base: 85 ft or 1.5 times the street width (ZR 91-31): 120 ft on Broadway, 85 ft on the 40 ft streets.
  assert.equal(envelope.controls.streetWall.bySide.front.maxBaseHeightFeet, 120);
  assert.equal(envelope.controls.streetWall.bySide.left.maxBaseHeightFeet, 85);
  assert.deepEqual(envelope.controls.streetWall.sections, ['ZR 91-31']);
  // Setback depth 20 ft for a lot over 30,000 sq ft (ZR 91-32); coverage 65% then 50% (ZR 91-33); 175 ft dimension above 300 ft (ZR 91-34).
  assert.equal(envelope.controls.setbacks.depthFeet, 20);
  assert.equal(envelope.controls.coverage.aboveBaseUpTo300FeetPercent, 65);
  assert.equal(envelope.controls.coverage.maxHorizontalDimensionAbove300Feet, 175);
  assert.equal(envelope.controls.yards.rearYard.requiredFeet, 0);
  // Six full-coverage storeys to 77.5 ft, then 65% towers of 42,900 sq ft until FAR 15 runs out at 19
  // storeys; the last 36,300 sq ft is a partial 20th storey, so the envelope holds the whole allowance.
  assert.equal(envelope.storeys[5].topFeet, 77.5);
  assert.equal(envelope.storeys[5].areaSqft, 66000);
  const seventh = envelope.storeys[6];
  assert.equal(seventh.areaSqft, 42900);
  assert.equal(seventh.coveragePercent, 65);
  assert.deepEqual(seventh.footprint, [[20, 0], [180, 0], [180, 268.1], [20, 268.1]]);
  assert.ok(seventh.controls.some(c => c.includes('ZR 91-33')));
  // Above 120 ft Broadway also sets back.
  const tenth = envelope.storeys[9];
  assert.equal(tenth.topFeet, 127.5);
  assert.ok(tenth.footprint.every(p => p[1] >= 20 && p[0] >= 20 && p[0] <= 180));
  assert.deepEqual(envelope.metrics, {storeys: 20, heightFeet: 252.5, floorAreaSqft: 990000, far: 15, remainingFloorAreaSqft: 0, stoppedBy: 'floor area ratio of 15'});
  assert.deepEqual([envelope.storeys[19].areaSqft, envelope.storeys[19].partial, envelope.storeys[19].label], [36300, true, 'Level 20 (partial)']);
  assert.equal(envelope.parking.required, 0);
  // Retail (Use Group VI) and other non-residential parking cap separately in ZR 13-12: 10 + 100.
  assert.deepEqual([envelope.parking.maxRetailSpaces, envelope.parking.maxOtherNonResidentialSpaces, envelope.parking.maxNonResidentialSpaces], [10, 100, 110]);
  assert.ok(envelope.parking.sections.includes('ZR 13-10'));
  assert.ok(envelope.checks.some(c => c.includes('Street wall types')));
  assert.ok(envelope.citations.includes('ZR 91-32') && envelope.citations.includes('ZR 33-26'));
  assert.match(envelope.note, /starting point to verify/);
  const concept = conceptArguments(envelope);
  assert.equal(concept.units, 'ft');
  assert.deepEqual(concept.lot, rect(200, 330));
  assert.equal(concept.levels.reduce((n, l) => n + (l.count || 1), 0), 20);
  assert.deepEqual(concept.levels[0], {label: 'Ground', use: 'retail', footprint: rect(200, 330), height: 15});
  assert.equal(concept.levels[1].count, 5);
  assert.equal(concept.maxFar, 15);
  assert.equal(concept.maxHeightFeet, undefined);
  assert.match(concept.summary, /ZR 91-31/);
});

test('a community-facility envelope is capped at the community-facility FAR and flags its uncurated bulk', () => {
  // R9 residential FAR is 7.52 and community-facility FAR is 10 in the curated table; the CF envelope
  // must take the 10, label its storeys community facility, count no dwelling units, and say plainly
  // that community-facility bulk is drawn with the residential regime as a starting point.
  const at = (code, extra = {}) => computeEnvelope({rules, district: describeDistrict(code), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 60}], communityDistrict: '301', ...extra});
  const e = at('R9', {use: 'community_facility'});
  assert.equal(e.use, 'community_facility');
  assert.equal(e.floorArea.maxFar, 10);
  assert.ok(e.metrics.floorAreaSqft <= 100000, 'floor area stays inside 10 FAR on a 10,000 sq ft lot');
  assert.ok(e.storeys.every(s => s.use === 'community facility'), 'every storey is community facility, none residential');
  assert.equal(e.density.maxUnits, null);
  assert.ok(e.checks.some(c => /Community facility: floor area is capped at the R9 community-facility FAR of 10/.test(c) && /ZR 24-522 setback plane/.test(c)), 'the ZR 24-522 basis is stated');
  assert.ok(e.checks.some(c => /hospitals and nursing or adult-care facilities are not drawn or priced/.test(c)), 'the CF scope boundary is stated');
  assert.equal(e.form, 'community-facility-setbacks');
  assert.equal(e.controls.streetWall.maxFrontWallFeet, 85);
  assert.deepEqual(e.controls.setbacks.skyExposurePlane, {startFeet: 85, slope: {narrow: 2.7, wide: 5.6}});
  // In a commercial district the CF cap is its own figure, not the commercial FAR (C6-1: 6.5 vs 6).
  assert.equal(at('C6-1', {use: 'community_facility'}).floorArea.maxFar, 6.5);
  assert.throws(() => at('R9', {use: 'community_facility', form: 'sky-exposure-plane'}), /residential alternative/);
  assert.throws(() => at('R9', {use: 'warehouse'}), /must be residential, commercial or community_facility/);
  // Residential envelopes are untouched by the new use.
  assert.equal(at('R9', {use: 'residential'}).floorArea.maxFar, 7.52);
});

test('community facility in residence districts draws ZR 24 coverage and yards', () => {
  const at = (code, extra = {}) => computeEnvelope({rules, district: describeDistrict(code), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 60}], communityDistrict: '301', use: 'community_facility', ...extra});
  // R7A (contextual): ZR 24-11 interior coverage is 65% and the rear yard is the flat 30 ft of
  // ZR 24-36, not the residential 20 ft a low building would take.
  const r7a = at('R7A');
  assert.equal(r7a.controls.yards.rearYard.requiredFeet, 30);
  assert.deepEqual(r7a.controls.yards.rearYard.sections, ['ZR 24-36']);
  assert.equal(r7a.controls.coverage.basePercent, 65);
  assert.ok(polygonArea(r7a.storeys[0].footprint) <= 6500, 'ground storey inside 65% coverage');
  assert.ok(r7a.checks.some(c => /ZR 24-50 directs/.test(c)), 'letter-suffix heights are the ZR-correct residential tables');
  // R4 (low rise): front yard 15 ft per ZR 24-34 where a residence takes 10, coverage 55% interior.
  const r4 = at('R4');
  assert.equal(r4.controls.yards.frontYard.requiredFeet, 15);
  assert.deepEqual(r4.controls.yards.frontYard.sections, ['ZR 24-34']);
  assert.equal(r4.controls.yards.rearYard.requiredFeet, 30);
  assert.equal(r4.controls.coverage.basePercent, 55);
  assert.ok(polygonArea(r4.storeys[0].footprint) <= 5500, 'ground storey inside 55% coverage');
  // Shallow interior lot, 60 ft deep: ZR 24-37 reduces the 30 ft rear yard a foot per foot under 70.
  const shallow = computeEnvelope({rules, district: describeDistrict('R7A'), lot: rect(100, 60), frontages: [{side: 'front', widthFeet: 60}], communityDistrict: '301', use: 'community_facility'});
  assert.equal(shallow.controls.yards.rearYard.requiredFeet, 20);
  assert.ok(shallow.controls.yards.rearYard.sections.includes('ZR 24-37'));
});

test('community-facility front heights follow the ZR 24-521 and 24-522 planes', () => {
  const at = (code) => computeEnvelope({rules, district: describeDistrict(code), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 60}], communityDistrict: '301', use: 'community_facility'});
  // R9 without a suffix (ZR 24-522): above the 85 ft plane start the front steps back at least the
  // 20 ft initial setback on a narrow street, and ground coverage stays inside the 65% interior cap.
  const r9 = at('R9');
  assert.equal(r9.form, 'community-facility-setbacks');
  assert.ok(polygonArea(r9.storeys[0].footprint) <= 6500, 'ground storey inside 65% coverage');
  const high = r9.storeys.filter(s => s.topFeet > 85);
  assert.ok(high.length > 0 && high.every(s => Math.min(...s.footprint.map(p => p[1])) >= 20), 'storeys above the plane start step back at least the initial setback');
  assert.ok(r9.storeys.some(s => s.controls.some(c => /ZR 24-522 sky exposure plane/.test(c))));
  // R5 (ZR 24-521): above the 35 ft front wall the plane rises 1 to 1 from the front yard line.
  const r5 = at('R5');
  assert.ok(r5.storeys.some(s => s.controls.some(c => /ZR 24-521/.test(c))), 'the R1-R5 plane is drawn and cited');
  const above = r5.storeys.filter(s => s.topFeet > 35);
  if (above.length) assert.ok(above.every(s => Math.min(...s.footprint.map(p => p[1])) >= 10 + (s.topFeet - 35) - 1), 'front depth grows a foot per foot above the wall');
});

test('conceptArguments satisfies the acres_model_concept input schema', () => {
  const envelope = computeEnvelope({rules, district: describeDistrict('C5-5'), specialDistricts: ['LM'], lot: rect(200, 330), frontages: [{side: 'front', widthFeet: 80}], communityDistrict: '101'});
  const args = conceptArguments(envelope);
  const schema = conceptDefinition.inputSchema;
  for (const key of schema.required) assert.ok(key in args, `missing ${key}`);
  for (const key of Object.keys(args)) assert.ok(key in schema.properties, `unexpected ${key}`);
  const level = schema.properties.levels.items;
  assert.ok(args.levels.length >= 1 && args.levels.length <= schema.properties.levels.maxItems);
  for (const l of args.levels) {
    for (const key of level.required) assert.ok(key in l, `level missing ${key}`);
    for (const key of Object.keys(l)) assert.ok(key in level.properties, `level has unexpected ${key}`);
    assert.ok(l.footprint.length >= 3 && l.footprint.every(p => p.length === 2));
    if ('count' in l) assert.ok(Number.isInteger(l.count) && l.count >= 1);
  }
  assert.ok(args.lot.length >= 3);
});

test('a curated gap returns the summary with a note instead of failing the tool', async () => {
  const property = {bbl: '1000010001', address: 'X', zonedist1: 'M1-5', lotarea: '5000', bldgarea: '0', lotfront: '50', lotdepth: '100', cd: '101'};
  const tools = createZoningTools({getProperty: () => property});
  const result = await tools.handlers.acres_zoning_envelope({use: 'residential'});
  assert.equal(result.envelope, null);
  assert.match(result.note, /No envelope: No residential bulk table for M1-5/);
  assert.equal(result.capacity.lotAreaSqft, 5000);
  const allTypeFive = computeEnvelope({rules, district: describeDistrict('C5-5'), specialDistricts: ['LM'], lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 80, streetWallType: '5'}], communityDistrict: '101'});
  assert.equal(allTypeFive.controls.setbacks.aboveFeet, null);
  assert.equal(allTypeFive.controls.setbacks.required, false);
});

test('a tower above 300 feet in Lower Manhattan is held to 50% coverage and a 175 ft dimension', () => {
  const envelope = computeEnvelope({rules, district: describeDistrict('C5-5'), specialDistricts: ['LM'], lot: rect(200, 330), frontages: [{side: 'front', widthFeet: 80, streetWallType: '1'}, {side: 'left', widthFeet: 40, streetWallType: '2A'}, {side: 'right', widthFeet: 40, streetWallType: '2A'}, {side: 'rear', widthFeet: 40, streetWallType: '2A'}], maxFar: 21.6, historicCore: true, communityDistrict: '101'});
  assert.equal(envelope.controls.streetWall.bySide.front.maxBaseHeightFeet, 250);
  assert.equal(envelope.controls.streetWall.bySide.front.minBaseHeightFeet, 150);
  assert.equal(envelope.controls.coverage.aboveBaseUpTo300FeetPercent, 75);
  const tall = envelope.storeys.find(s => s.topFeet > 300);
  assert.ok(tall);
  assert.ok(tall.areaSqft <= 0.6 * 66000);
  const xs = tall.footprint.map(p => p[0]), zs = tall.footprint.map(p => p[1]);
  assert.ok(Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) <= 175.1, 'within 0.1 ft rounding of the 175 ft dimension');
  assert.ok(tall.controls.some(c => c.includes('ZR 91-34')));
  assert.equal(envelope.checks.some(c => c.includes('Street wall types')), false);
});

test('a 25 by 100 ft mid-block R8A lot on a narrow street stacks under the base height table, the last storey partial', () => {
  const envelope = computeEnvelope({rules, district: describeDistrict('R8A'), lot: rect(25, 100), frontages: [{side: 'front', widthFeet: 60}], communityDistrict: '301'});
  assert.equal(envelope.regime, 'residential');
  assert.equal(envelope.form, 'base');
  assert.equal(envelope.lot.type, 'interior');
  assert.equal(envelope.floorArea.maxFloorAreaSqft, 15050);
  assert.deepEqual([envelope.controls.streetWall.minBaseHeightFeet, envelope.controls.streetWall.maxBaseHeightFeet, envelope.controls.heightLimitFeet], [60, 95, 125]);
  assert.equal(envelope.controls.streetWall.streetRow, 'narrow street');
  assert.equal(envelope.controls.coverage.basePercent, 80);
  // A lot under 40 ft wide keeps a 30 ft rear yard at every height (ZR 23-342).
  assert.deepEqual(envelope.controls.yards.rearYard, {requiredFeet: 30, above75FeetFeet: 30, narrowLot: true, sections: ['ZR 23-342']});
  assert.ok(envelope.checks.some(c => /Lot 25 ft wide, under 40 ft: .*30 ft rear yard at every height/.test(c)));
  // 25 x 70 = 1,750 sq ft a storey, within the 80% coverage; eight storeys hold 14,000 sq ft, and the remaining
  // 1,050 sq ft of FAR 6.02 is a ninth storey under the 95 ft base, trimmed from the rear.
  assert.deepEqual(envelope.storeys[0].footprint, rect(25, 70));
  assert.equal(envelope.storeys[0].areaSqft, 1750);
  assert.deepEqual(envelope.metrics, {storeys: 9, heightFeet: 94.5, floorAreaSqft: 15050, far: 6.02, remainingFloorAreaSqft: 0, stoppedBy: 'floor area ratio of 6.02'});
  const top = envelope.storeys[8];
  assert.deepEqual([top.areaSqft, top.partial, top.footprint], [1050, true, rect(25, 42)]);
  assert.ok(envelope.storeys.slice(0, 8).every(s => !s.partial));
  assert.deepEqual(envelope.density, {maxUnits: 22, dwellingUnitFactor: 680, residentialFloorAreaSqft: 15050, sections: ['ZR 23-52', 'ZR 12-10 (special density areas; Manhattan Core)'], note: envelope.density.note});
  assert.equal(envelope.parking.required, null);
  assert.match(envelope.parking.note, /Outside the Manhattan Core/);
  const concept = conceptArguments(envelope);
  assert.equal(concept.maxHeightFeet, 125);
  assert.deepEqual(concept.levels.at(-1), {label: 'Level 9 (partial)', use: 'residential', footprint: rect(25, 42), height: 10.5});
  // A 50 ft R8 lot on a wide street with affordable housing rises to the 145 ft row, and the setback bites above 105 ft.
  const wide = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(50, 100), frontages: [{side: 'front', widthFeet: 100}], affordable: true, maxFar: 12, communityDistrict: '101'});
  assert.deepEqual([wide.controls.streetWall.maxBaseHeightFeet, wide.controls.heightLimitFeet], [105, 145]);
  const setBack = wide.storeys.find(s => s.topFeet > 105);
  assert.deepEqual(setBack.footprint, [[0, 10], [50, 10], [50, 70], [0, 70]]);
  assert.equal(wide.metrics.stoppedBy, 'height limit of 145 ft');
  assert.equal(wide.controls.narrowBuilding, undefined, 'a 50 ft street wall is not a narrow building');
  assert.equal(wide.density.maxUnits, null);
  assert.match(wide.density.note, /special density areas/);
  assert.equal(wide.parking.maxResidentialSpaces, null);
});

test('a narrow building is held to the street width only in the sky exposure plane form', () => {
  const lot = rect(25, 100), frontages = [{side: 'front', widthFeet: 60}];
  // ZR 23-738 is one of the optional provisions for sky exposure plane buildings (ZR 23-73, ZR 23-731): the
  // standard form keeps its ZR 23-432 heights, and the 25 ft R8 lot holds its 15,050 sq ft.
  const r8 = computeEnvelope({rules, district: describeDistrict('R8'), lot, frontages});
  assert.equal(r8.controls.heightLimitFeet, rules.bulk.residential.R8.narrow.maxHeightFeet);
  assert.equal(r8.controls.narrowBuilding, undefined);
  assert.equal(r8.metrics.floorAreaSqft, 15050);
  assert.ok(!r8.checks.some(c => /Narrow building/.test(c)));
  assert.ok(!r8.citations.includes('ZR 23-738'));
  const plane = computeEnvelope({rules, district: describeDistrict('R8'), lot, frontages, form: 'sky-exposure-plane'});
  assert.deepEqual(plane.controls.narrowBuilding, {streetWallWidthFeet: 25, streetWidthFeet: 60, maxHeightFeet: 60, assumedStreetWidth: false, sections: ['ZR 23-738']});
  assert.ok(plane.metrics.heightFeet <= 60);
  assert.ok(plane.citations.includes('ZR 23-738'));
  // R8A is contextual: no sky exposure plane row, so its ZR 23-432 row governs and no narrow-building limit is drawn.
  const r8a = computeEnvelope({rules, district: describeDistrict('R8A'), lot, frontages});
  assert.equal(r8a.controls.heightLimitFeet, rules.bulk.residential.R8A.narrow.maxHeightFeet);
  assert.equal(r8a.controls.narrowBuilding, undefined);
  assert.ok(!r8a.citations.includes('ZR 23-738'));
  // R7-1 shares R7-2's bulk row but ZR 23-738 names R7-2, R8, R9 and R10 only: no narrow-building limit.
  const r71 = computeEnvelope({rules, district: describeDistrict('R7-1'), lot, frontages, use: 'residential', form: 'sky-exposure-plane'});
  assert.equal(r71.controls.narrowBuilding, undefined);
  const r72 = computeEnvelope({rules, district: describeDistrict('R7-2'), lot, frontages, use: 'residential', form: 'sky-exposure-plane'});
  assert.equal(r72.controls.narrowBuilding.maxHeightFeet, 60);
  // A 20 ft R10 lot: the tower and base forms keep the R10 heights; the plane form is held to the 60 ft street,
  // and a wide corner street raises the limit to 100 ft at most.
  for (const form of ['tower', 'base']) assert.equal(computeEnvelope({rules, district: describeDistrict('R10'), lot: rect(20, 100), frontages, form}).controls.narrowBuilding, undefined, form);
  assert.equal(computeEnvelope({rules, district: describeDistrict('R10'), lot: rect(20, 100), frontages, form: 'sky-exposure-plane'}).controls.narrowBuilding.maxHeightFeet, 60);
  const corner = computeEnvelope({rules, district: describeDistrict('R10'), lot: rect(20, 20), frontages: [{side: 'front', widthFeet: 60}, {side: 'left', widthFeet: 150}], maxFar: 40, form: 'sky-exposure-plane'});
  assert.equal(corner.controls.narrowBuilding.maxHeightFeet, 100);
  const unknownStreet = computeEnvelope({rules, district: describeDistrict('R9'), lot: rect(30, 100), form: 'sky-exposure-plane'});
  assert.deepEqual([unknownStreet.controls.narrowBuilding.maxHeightFeet, unknownStreet.controls.narrowBuilding.assumedStreetWidth], [60, true]);
});

test('a lot under 40 ft wide keeps a 30 ft rear yard at every height, and a 40 ft lot the 20 ft yard', () => {
  const at = width => computeEnvelope({rules, district: describeDistrict('R7A'), lot: rect(width, 100), frontages: [{side: 'front', widthFeet: 60}]});
  assert.deepEqual(at(39.9).controls.yards.rearYard, {requiredFeet: 30, above75FeetFeet: 30, narrowLot: true, sections: ['ZR 23-342']});
  assert.deepEqual(at(40).controls.yards.rearYard, {requiredFeet: 20, above75FeetFeet: 30, sections: ['ZR 23-342']});
  // The same 4.0 FAR on the narrower lot needs a sixth storey: 25 x 70 a storey against 25 x 80.
  assert.deepEqual([at(25).metrics.storeys, at(25).storeys[0].footprint], [6, rect(25, 70)]);
});

test('the residential sky exposure plane form draws the plane in eligible districts and is refused elsewhere', () => {
  const lot = rect(100, 100);
  const plane = computeEnvelope({rules, district: describeDistrict('R8'), lot, form: 'sky-exposure-plane', maxFar: 20});
  assert.ok(plane.storeys.some(s => s.shapedBy.some(c => c.plane && c.section === 'ZR 23-736')));
  assert.throws(() => computeEnvelope({rules, district: describeDistrict('C6-2'), lot, use: 'residential', form: 'sky-exposure-plane'}), /ZR 23-731/);
  assert.throws(() => computeEnvelope({rules, district: describeDistrict('R8'), lot, form: 'height-factor'}), /use base, tower, eligible or sky-exposure-plane/);
  const base = computeEnvelope({rules, district: describeDistrict('R8'), lot, form: 'base', maxFar: 20});
  assert.deepEqual([base.metrics.heightFeet, base.metrics.stoppedBy], [105, 'height limit of 115 ft']);
});

test('a shallow interior lot draws the ZR 23-342 reduced rear yard', () => {
  // 90 ft deep: five feet short of 95 ft, so each yard is 2.5 ft shallower: 17.5 ft up to 75 ft, 27.5 ft above.
  const shallow = computeEnvelope({rules, district: describeDistrict('R8A'), lot: rect(40, 90), frontages: [{side: 'front', widthFeet: 60}], maxFar: 20});
  assert.deepEqual(shallow.controls.yards.rearYard, {requiredFeet: 17.5, above75FeetFeet: 27.5, shallowLot: true, sections: ['ZR 23-342']});
  const above75 = shallow.storeys.find(s => s.topFeet > 75);
  assert.deepEqual(above75.footprint, rect(40, 90 - 27.5));
  assert.ok(above75.controls.includes('rear yard 27.5 ft'));
  assert.ok(shallow.checks.some(c => /Shallow interior lot 90 ft deep.*December 15, 1961/.test(c)));
  // Never below 10 ft, and corner, through and 95 ft lots keep the full yards.
  assert.equal(computeEnvelope({rules, district: describeDistrict('R8A'), lot: rect(40, 54), frontages: [{side: 'front', widthFeet: 60}]}).controls.yards.rearYard.requiredFeet, 10);
  assert.equal(computeEnvelope({rules, district: describeDistrict('R8A'), lot: rect(40, 95), frontages: [{side: 'front', widthFeet: 60}]}).controls.yards.rearYard.requiredFeet, 20);
  // A narrow lot reduces its 30 ft yard the same way: 27.5 ft at every height on a 25 by 90 ft lot.
  const narrowShallow = computeEnvelope({rules, district: describeDistrict('R8A'), lot: rect(25, 90), frontages: [{side: 'front', widthFeet: 60}]});
  assert.deepEqual(narrowShallow.controls.yards.rearYard, {requiredFeet: 27.5, above75FeetFeet: 27.5, shallowLot: true, narrowLot: true, sections: ['ZR 23-342']});
  assert.ok(narrowShallow.checks.some(c => /shallow-lot reduction starts from the 30 ft rear yard/.test(c)));
  // A low-density lot takes the same reduction from its own rear yard: 30 ft for an attached building under 40 ft wide, less 5 ft.
  const low = computeEnvelope({rules, district: describeDistrict('R5'), lot: rect(25, 85), frontages: [{side: 'front', widthFeet: 60}]});
  assert.deepEqual(low.controls.yards.rearYard, {requiredFeet: 25, shallowLot: true, sections: ['ZR 23-342']});
});

test('commercial sky exposure plane and tower forms outside the special district', () => {
  const sep = computeEnvelope({rules, district: describeDistrict('C6-2'), lot: rect(50, 100), frontages: [{side: 'front', widthFeet: 60}], communityDistrict: '101'});
  assert.equal(sep.form, 'sky-exposure-plane');
  assert.equal(sep.controls.streetWall.maxFrontWallFeet, 77.5);
  assert.deepEqual(sep.storeys[0].footprint, rect(50, 100));
  assert.deepEqual(sep.storeys[1].footprint, rect(50, 80));
  // Above the six-storey front wall the seventh storey (top 90 ft) needs max(20, (90 - 85) / 2.7) = 20 ft.
  assert.deepEqual(sep.storeys[6].footprint, [[0, 20], [50, 20], [50, 80], [0, 80]]);
  // FAR 6 runs out part way through the eighth storey, built as a partial storey to 102.5 ft.
  assert.deepEqual([sep.metrics.heightFeet, sep.metrics.floorAreaSqft, sep.metrics.remainingFloorAreaSqft, sep.storeys.at(-1).partial], [102.5, 30000, 0, true]);
  const tower = computeEnvelope({rules, district: describeDistrict('C5-5'), lot: rect(100, 150), frontages: [{side: 'front', widthFeet: 60}], communityDistrict: '101'});
  assert.equal(tower.form, 'tower');
  assert.equal(tower.controls.coverage.towerPercent, 45);
  assert.equal(tower.storeys[6].areaSqft, 6750);
  assert.equal(tower.storeys[6].footprint[0][1], 15);
  assert.deepEqual([tower.metrics.storeys, tower.metrics.remainingFloorAreaSqft, tower.storeys.at(-1).partial], [28, 0, true]);
  assert.ok(tower.checks.some(c => c.includes('1,875 sq ft cap (ZR 33-451)')));
  assert.equal(tower.checks.some(c => c.includes('ZR 33-455')), false);
  const twoStreets = computeEnvelope({rules, district: describeDistrict('C5-5'), lot: rect(100, 150), frontages: [{side: 'front', widthFeet: 60}, {side: 'left', widthFeet: 100}]});
  assert.ok(twoStreets.checks.some(c => c.includes('ZR 33-455')));
  assert.equal(twoStreets.parking.required, null);
  const manufacturing = computeEnvelope({rules, district: describeDistrict('M1-5'), lot: rect(100, 200), frontages: [{side: 'front', widthFeet: 100}], communityDistrict: '101'});
  assert.equal(manufacturing.regime, 'manufacturing');
  assert.deepEqual(manufacturing.storeys.map(s => s.areaSqft), [20000, 18000, 18000, 18000, 18000, 8000]);
  assert.deepEqual(manufacturing.controls.yards.rearYard.sections, ['ZR 43-26', 'ZR 43-23']);
  assert.throws(() => computeEnvelope({rules, district: describeDistrict('C6-2'), lot: rect(50, 100), form: 'tower'}), /Towers are not permitted in C6-2/);
  assert.throws(() => computeEnvelope({rules, district: describeDistrict('M1-5'), lot: rect(50, 100), use: 'residential'}), /no curated residential equivalent/);
});

test('residential towers in an R10 equivalent and the density and parking helpers', () => {
  const envelope = computeEnvelope({rules, district: describeDistrict('C6-4'), use: 'residential', lot: rect(100, 200), frontages: [{side: 'front', widthFeet: 100}, {side: 'left', widthFeet: 60}], communityDistrict: '102'});
  assert.equal(envelope.residentialEquivalent, 'R10');
  assert.equal(envelope.form, 'tower');
  assert.equal(envelope.controls.streetWall.maxBaseHeightFeet, 155);
  assert.equal(envelope.controls.coverage.basePercent, 100);
  assert.equal(envelope.controls.coverage.towerUpTo300FeetPercent, 65);
  assert.ok(envelope.checks.some(c => c.includes('ZR 23-441')) && envelope.checks.some(c => c.includes('ZR 23-434')));
  assert.equal(envelope.metrics.stoppedBy, 'floor area ratio of 10');
  assert.equal(dwellingUnits({residentialFloorAreaSqft: 68510, specialDensityArea: false, rules}).maxUnits, 101);
  assert.equal(dwellingUnits({residentialFloorAreaSqft: 68170, specialDensityArea: false, rules}).maxUnits, 100);
  assert.equal(dwellingUnits({residentialFloorAreaSqft: 68000, specialDensityArea: false, rules}).maxUnits, 100);
  assert.equal(dwellingUnits({residentialFloorAreaSqft: 68000, specialDensityArea: true, rules}).maxUnits, null);
  const core = parking({communityDistrict: 107, dwellingUnits: 100, nonResidentialFloorAreaSqft: 50000, rules});
  assert.deepEqual([core.required, core.maxResidentialSpaces, core.residentialMaxPercentOfNewUnits, core.maxNonResidentialSpaces], [0, 35, 35, 12]);
  assert.equal(parking({communityDistrict: null, rules}).required, null);
});

test('qualifying affordable FARs and the R8 wide-street row (ZR 23-22)', () => {
  const narrow = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(25, 100), frontages: [{side: 'front', widthFeet: 50}]});
  assert.equal(narrow.floorArea.maxFloorAreaSqft, 15050);
  const wide = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(25, 100), frontages: [{side: 'front', widthFeet: 100}]});
  assert.equal(wide.floorArea.maxFloorAreaSqft, 18000);
  assert.ok(wide.checks.some(c => c.includes('Wide-street floor area ratio')));
  const wideAffordable = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(25, 100), frontages: [{side: 'front', widthFeet: 100}], affordable: true});
  assert.equal(wideAffordable.floorArea.maxFloorAreaSqft, 21600);
  const r9 = computeEnvelope({rules, district: describeDistrict('R9'), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 100}], affordable: true});
  assert.equal(r9.floorArea.maxFloorAreaSqft, 90200);
  const c62 = computeEnvelope({rules, district: describeDistrict('C6-2'), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 50}], use: 'residential', affordable: true});
  assert.equal(c62.floorArea.maxFloorAreaSqft, 72000);
});

test('R6 takes 2.2 on a narrow street and 3.0 within 100 ft of a wide street (ZR 23-22)', () => {
  const at = widthFeet => computeEnvelope({rules, district: describeDistrict('R6'), lot: rect(50, 100), frontages: [{side: 'front', widthFeet}]}).floorArea.maxFar;
  assert.equal(at(60), 2.2);
  assert.equal(at(80), 3);
});

test('R7-1 and R7-2 take 4.0 within 100 ft of a wide street, on a wide side street too (ZR 23-22)', () => {
  const far = (district, frontages) => computeEnvelope({rules, district: describeDistrict(district), lot: rect(50, 100), frontages}).floorArea.maxFar;
  for (const district of ['R7-1', 'R7-2']) {
    assert.equal(far(district, [{side: 'front', widthFeet: 60}]), 3.44);
    assert.equal(far(district, [{side: 'front', widthFeet: 80}]), 4);
    // A corner lot whose front street is narrow still lies within 100 ft of its wide side street.
    assert.equal(far(district, [{side: 'front', widthFeet: 60}, {side: 'left', widthFeet: 80}]), 4);
    assert.equal(far(district, [{side: 'front', widthFeet: 60}, {side: 'left', widthFeet: 60}]), 3.44);
  }
});

test('through lots keep the rear yard equivalent open', () => {
  const through = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(50, 200), frontages: [{side: 'front', widthFeet: 50}, {side: 'rear', widthFeet: 50}], maxFar: 12});
  assert.equal(through.lot.type, 'through');
  assert.deepEqual(through.controls.yards.rearYardEquivalent.requiredFeet, 40);
  // 40 ft equivalent below 75 ft: drawn depth 200 - 40 = 160, which is also exactly the 80% coverage.
  assert.deepEqual(through.storeys[0].footprint, rect(50, 160));
  assert.ok(through.storeys[0].controls.some(c => c.includes('rear yard equivalent 40 ft kept open (ZR 23-343)')));
  const high = through.storeys.find(s => s.topFeet > 75);
  assert.ok(high.footprint.every(p => p[1] <= 140 + 1e-6));
  assert.ok(through.checks.some(c => c.includes('midway between the street lines (ZR 23-343)')));
  assert.equal(through.storeys[0].shapedBy.find(c => c.control === 'rear_yard_equivalent').alternatives, undefined, 'R8 base form: midway only');
  const shallow = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(50, 100), frontages: [{side: 'front', widthFeet: 50}, {side: 'rear', widthFeet: 50}]});
  assert.equal(shallow.controls.yards.rearYardEquivalent.requiredFeet, 0);
});

test('a through lot under 190 ft deep reduces its rear yard equivalent and may place it along the street or side lot lines', () => {
  const at = (depth, code = 'R8', form) => computeEnvelope({rules, district: describeDistrict(code), lot: rect(50, depth), frontages: [{side: 'front', widthFeet: 60}, {side: 'rear', widthFeet: 60}], maxFar: 12, ...(form ? {form} : {})});
  // 170 ft: 40 less 20 is 20 ft up to 75 ft of height, 60 less 20 is 40 ft above (ZR 23-343(b)(2)).
  const mid = at(170);
  assert.deepEqual([mid.controls.yards.rearYardEquivalent.requiredFeet, mid.controls.yards.rearYardEquivalent.above75FeetFeet, mid.controls.yards.rearYardEquivalent.shallowLot], [20, 40, true]);
  assert.ok(mid.checks.some(c => /December 15, 1961/.test(c)));
  // 130 ft: never below 20 ft.
  assert.equal(at(130).controls.yards.rearYardEquivalent.requiredFeet, 20);
  // A shallow through lot may use the alternative locations (ZR 23-343(c)(2)); a standard one only with a tower, an eligible site or R10.
  assert.deepEqual(mid.storeys[0].shapedBy.find(c => c.control === 'rear_yard_equivalent').alternatives, ['street_lines', 'side_lot_lines']);
  assert.equal(at(200).storeys[0].shapedBy.find(c => c.control === 'rear_yard_equivalent').alternatives, undefined);
  assert.deepEqual(at(200, 'R10').storeys[0].shapedBy.find(c => c.control === 'rear_yard_equivalent').alternatives, ['street_lines', 'side_lot_lines']);
  assert.ok(at(200, 'R9', 'tower').checks.some(c => c.includes('ZR 23-343(c)(2)')));
});

test('expanded districts compute with their own height rows', () => {
  const r6b = computeEnvelope({rules, district: describeDistrict('R6B'), lot: rect(50, 100), frontages: [{side: 'front', widthFeet: 50}]});
  assert.equal(r6b.controls.heightLimitFeet, 55);
  assert.equal(r6b.floorArea.maxFloorAreaSqft, 10000);
  const r12 = computeEnvelope({rules, district: describeDistrict('R12'), lot: rect(200, 100), frontages: [{side: 'front', widthFeet: 100}]});
  assert.equal(r12.floorArea.maxFloorAreaSqft, 300000);
  assert.equal(r12.controls.coverage.towerUpTo300FeetPercent, 65);
  assert.ok(r12.checks.some(c => c.includes('495 ft maximum height')));
  assert.throws(() => computeEnvelope({rules, district: describeDistrict('R9X'), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 100}], form: 'tower'}), /Towers are not permitted in R9X/);
});

test('eligible-site form draws ZR 23-434 heights with ZR 23-362 coverage tiers', () => {
  const small = computeEnvelope({rules, district: describeDistrict('R10'), lot: rect(200, 100), frontages: [{side: 'front', widthFeet: 100}], form: 'eligible'});
  assert.equal(small.form, 'eligible');
  assert.equal(small.controls.heightLimitFeet, 355);
  assert.equal(small.controls.coverage.basePercent, 80);
  assert.ok(small.checks.some(c => c.includes('ZR 23-434(a)')));
  assert.ok(!small.checks.some(c => c.includes('not drawn')));
  const mid = computeEnvelope({rules, district: describeDistrict('R10'), lot: rect(200, 200), frontages: [{side: 'front', widthFeet: 100}], form: 'eligible'});
  assert.equal(mid.controls.coverage.eligibleSitePercent, 65);
  assert.ok(mid.storeys[0].areaSqft <= 26000 + 1);
  const large = computeEnvelope({rules, district: describeDistrict('R10'), lot: rect(300, 250), frontages: [{side: 'front', widthFeet: 100}], form: 'eligible'});
  assert.equal(large.controls.coverage.eligibleSitePercent, 50);
  assert.ok(large.storeys[0].areaSqft <= 37500 + 1);
  assert.throws(() => computeEnvelope({rules, district: describeDistrict('R9A'), lot: rect(200, 100), frontages: [{side: 'front', widthFeet: 100}], form: 'eligible'}), /not available in R9A/);
});

test('court minimums ride along as reported controls (ZR 23-352, 23-353)', () => {
  const out = computeEnvelope({rules, district: describeDistrict('R9A'), lot: rect(200, 100), frontages: [{side: 'front', widthFeet: 100}]});
  assert.deepEqual(out.controls.courts.innerCourt.withLegallyRequiredWindows, {upTo75Feet: {minAreaSqft: 800, minDimensionFeet: 20}, above75Feet: {minAreaSqft: 1200, minDimensionFeet: 30}});
  assert.deepEqual(out.controls.courts.outerCourt.withoutLegallyRequiredWindows, {upTo75Feet: {minAreaSqft: 200, minDimensionFeet: 10}, above75Feet: {minAreaSqft: 300, minDimensionFeet: 15}});
  assert.match(out.controls.courts.outerCourt.withLegallyRequiredWindows.rule, /Width at least equal to depth/);
  assert.ok(out.checks.some(c => c.includes('controls.courts')));
  assert.deepEqual(out.controls.courts.sections, ['ZR 23-351', 'ZR 23-352', 'ZR 23-353']);
});

test('Limited Height Districts cap ordinary envelopes but not qualifying affordable or senior housing', () => {
  const base = {rules, district: describeDistrict('R8B'), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 60}], use: 'residential', limitedHeightDistrict: 'LH-1A'};
  const ordinary = computeEnvelope(base);
  assert.equal(ordinary.metrics.heightFeet, 52.5);
  assert.equal(ordinary.controls.limitedHeight.maxHeightFeet, 60);
  assert.match(ordinary.checks.join(' '), /ZR 23-739/);
  const affordable = computeEnvelope({...base, affordable: true});
  assert.equal(affordable.controls.limitedHeight, undefined);
  assert.ok(affordable.metrics.heightFeet > ordinary.metrics.heightFeet);
  const senior = computeEnvelope({...base, qualifyingSeniorHousing: true});
  assert.equal(senior.controls.limitedHeight, undefined);
});

test('market residential FAR and envelope FAR agree across curated R6-R10 and commercial-equivalent lot grid', () => {
  const districts = ['R6A', 'R7A', 'R8A', 'R9A', 'R10A', 'C4-2A', 'C4-5A', 'C6-2A', 'C6-3A', 'C1-9A'];
  for (const code of districts) for (const width of [25, 40, 60, 100]) for (const streetWidth of [60, 100]) {
    const district = describeDistrict(code);
    const market = residentialFarFor({zoningDistrict: code, lotFront: width, lotDepth: 200, frontStreetFeet: streetWidth});
    const env = computeEnvelope({rules, district, lot: rect(width, 200), frontages: [{side: 'front', widthFeet: streetWidth}], use: 'residential'});
    assert.ok(Math.abs(market.residFar - env.floorArea.maxFar) <= 0.01, `${code} ${width} ft lot on ${streetWidth} ft street: market ${market.residFar}, envelope ${env.floorArea.maxFar}`);
  }
});

test('transit-zone parking computes per ZR 25-211, 25-222 and 25-232', () => {
  const base = {communityDistrict: '301', rules};
  // No zone named: all three outcomes reported.
  const all = parking({...base, dwellingUnits: 400, districtCode: 'R8', lotAreaSqft: 40000});
  assert.equal(all.required, null);
  assert.equal(all.transitZones.inner.required, 0);
  assert.equal(all.transitZones.outer.required, 48);
  assert.equal(all.transitZones.beyond.required, 160);
  // Outer zone waiver: 100 units at 12% is 12 spaces, within the 30-space waiver.
  const waived = parking({...base, dwellingUnits: 100, districtCode: 'R8', lotAreaSqft: 40000, transitZone: 'outer'});
  assert.equal(waived.required, 0);
  assert.equal(waived.waived, true);
  // Beyond GTZ lot-area tiers for R8: small lot waived, mid lot at 20%, standard 40%.
  assert.equal(parking({...base, dwellingUnits: 100, districtCode: 'R8', lotAreaSqft: 9000, transitZone: 'beyond'}).required, 0);
  assert.equal(parking({...base, dwellingUnits: 100, districtCode: 'R8', lotAreaSqft: 12000, transitZone: 'beyond'}).required, 20);
  assert.equal(parking({...base, dwellingUnits: 100, districtCode: 'R8', lotAreaSqft: 20000, transitZone: 'beyond'}).required, 40);
  // R6 beyond GTZ has no lot-area relief: 50% of 100 units.
  assert.equal(parking({...base, dwellingUnits: 100, districtCode: 'R6', lotAreaSqft: 9000, transitZone: 'beyond'}).required, 50);
  // Inner zone never requires parking for new units.
  assert.equal(parking({...base, dwellingUnits: 500, districtCode: 'R10', lotAreaSqft: 50000, transitZone: 'inner'}).required, 0);
});

test('the transit zone is read from PLUTO\'s transitzone field, and a zoning envelope uses it unasked', () => {
  const zones = ['Inner Transit Zone', 'Outer Transit Zone', 'Beyond the Greater Transit Zone', 'Special 25-241 Parking Provisions', 'Manhattan Core and Long Island City Parking Areas', '', null];
  assert.deepEqual(zones.map(z => transitZoneOf({transitzone: z})), ['inner', 'outer', 'beyond', 'special-25-241', 'core-or-lic', null, null]);
  const e = computeEnvelope({rules, district: describeDistrict('R6'), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 60}], use: 'residential', communityDistrict: '411', transitZone: 'beyond', transitZoneSource: 'PLUTO transit zone'});
  assert.deepEqual([e.parking.transitZone, e.parking.transitZoneSource, e.parking.transitZones], ['beyond', 'PLUTO transit zone', undefined]);
  assert.match(e.parking.note, /PLUTO transit zone/);
  // In the Manhattan Core the community district governs whatever the field says.
  const core = parking({communityDistrict: '105', dwellingUnits: 100, districtCode: 'R10', transitZone: 'core-or-lic', rules});
  assert.equal(core.manhattanCore, true);
});

test('an R2 lot draws one detached single-family house behind its yards, under the pitched-roof heights', () => {
  const e = computeEnvelope({rules, district: describeDistrict('R2'), lot: rect(40, 100), frontages: [{side: 'front', widthFeet: 60}], use: 'residential'});
  assert.equal(e.form, 'detached');
  assert.equal(e.floorArea.maxFar, 0.75);
  assert.deepEqual([e.controls.yards.frontYard.requiredFeet, e.controls.yards.sideYards.requiredFeet, e.controls.yards.rearYard.requiredFeet], [15, 5, 20]);
  assert.equal(e.controls.heightLimitFeet, 35);
  assert.equal(e.controls.coverage.basePercent, 40);
  assert.deepEqual(e.storeys.map(s => s.areaSqft), [1500, 1500], 'the 3,000 sq ft spreads over the two storeys under the 25 ft perimeter wall');
  assert.equal(e.density.maxUnits, 1);
  // Every storey sits inside the yards: 15 ft front, 5 ft sides, 20 ft rear.
  for (const s of e.storeys) for (const [x, z] of s.footprint) assert.ok(x >= 5 - 1e-6 && x <= 35 + 1e-6 && z >= 15 - 1e-6 && z <= 80 + 1e-6);
  assert.ok(e.checks.some(c => c.includes('ZR 23-421')));
  assert.ok(conceptArguments(e).levels.length);
});

test('an R4 lot takes multiple dwellings at the standard FAR, and a qualifying residential site reaches 1.5 FAR and 45 ft', () => {
  const lot = rect(50, 100), frontages = [{side: 'front', widthFeet: 80}];
  const standard = computeEnvelope({rules, district: describeDistrict('R4'), lot, frontages, use: 'residential'});
  assert.equal(standard.form, 'multiple-dwelling');
  assert.deepEqual([standard.floorArea.maxFar, standard.metrics.floorAreaSqft, standard.controls.heightLimitFeet, standard.controls.coverage.basePercent], [1, 5000, 35, 80]);
  assert.equal(standard.controls.yards.sideYards.requiredFeet, 0);
  const qualifying = computeEnvelope({rules, district: describeDistrict('R4'), lot, frontages, use: 'residential', affordable: true});
  assert.deepEqual([qualifying.floorArea.maxFar, qualifying.metrics.floorAreaSqft, qualifying.controls.heightLimitFeet], [1.5, 7500, 45]);
  assert.ok(qualifying.checks.some(c => c.includes('Qualifying residential site')));
  // Attached on a lot under 40 ft wide: the 30 ft rear yard of ZR 23-342.
  const narrow = computeEnvelope({rules, district: describeDistrict('R4'), lot: rect(25, 100), frontages, use: 'residential'});
  assert.equal(narrow.controls.yards.rearYard.requiredFeet, 30);
});

test('floor area, coverage and the unit cap rest on the lot area on record; the polygon shapes the geometry', () => {
  const inputs = {rules, district: describeDistrict('R7A'), lot: rect(50, 110), frontages: [{side: 'front', widthFeet: 60}], use: 'residential'};
  const polygon = computeEnvelope(inputs);
  const recorded = computeEnvelope({...inputs, recordedLotAreaSqft: 5000});
  assert.deepEqual([polygon.lot.areaSqft, polygon.lot.taxMapAreaSqft], [5500, 5500]);
  assert.deepEqual([recorded.lot.areaSqft, recorded.lot.taxMapAreaSqft], [5000, 5500]);
  assert.equal(recorded.floorArea.maxFloorAreaSqft, 4 * 5000);
  // 80% interior coverage of the recorded 5,000 sq ft (ZR 23-362), not of the 5,500 the tax map draws.
  assert.ok(recorded.storeys.every(s => s.areaSqft <= 4000 + 1));
  // ZR 23-52: 20,000 sq ft permitted over the 680 factor is 29.4, so 29 units, whatever the stack holds.
  assert.equal(recorded.density.maxUnits, 29);
  const short = computeEnvelope({...inputs, recordedLotAreaSqft: 5000, storeyHeightsFeet: {ground: 30, typical: 30}});
  assert.ok(short.metrics.floorAreaSqft < 20000);
  assert.equal(short.density.maxUnits, 29);
});

test('a corner lot needs no rear yard within its corner portion, 100 ft from each street line, and keeps one beyond it', () => {
  const at = (lot, code = 'R7A') => computeEnvelope({rules, district: describeDistrict(code), lot, frontages: [{side: 'front', widthFeet: 60}, {side: 'left', widthFeet: 60}], use: 'residential'});
  // 150 ft along the front street, 90 deep: the 50 ft beyond 100 ft of the side street is an interior
  // portion with a rear yard (ZR 12-10, 23-342), 17.5 ft as a shallow portion 5 ft under 95 ft deep;
  // the corner portion has none (ZR 23-344).
  const wide = at(rect(150, 90));
  assert.equal(wide.storeys[0].areaSqft, 150 * 90 - 50 * 17.5);
  const yard = wide.storeys[0].shapedBy.find(c => c.control === 'rear_yard');
  assert.deepEqual([yard.feet, yard.cornerPortionFeet, yard.cornerSection], [17.5, 100, 'ZR 23-344']);
  assert.ok(wide.checks.some(c => /corner portion, within 100 ft of each intersecting street line/.test(c)));
  // 150 by 60: the interior portion is a shallow lot portion, so its yard is reduced six inches a foot
  // under 95 ft, never below 10 ft (ZR 23-342(b)).
  assert.equal(at(rect(150, 60)).storeys[0].areaSqft, 150 * 60 - 50 * 10);
  // 40 by 110: the yard would reach 20 ft into the lot, but the first 100 ft from the front street are corner portion.
  const deep = at(rect(40, 110));
  assert.equal(deep.storeys[0].areaSqft, 40 * 100);
  // Wholly within 100 ft of both streets: no rear yard at all.
  const small = at(rect(60, 95));
  assert.equal(small.controls.yards.rearYard.requiredFeet, 0);
  assert.ok(small.controls.yards.rearYard.sections.includes('ZR 23-344'));
  // Commercial and manufacturing lots cite their own sections (ZR 33-301, 43-311).
  const commercial = computeEnvelope({rules, district: describeDistrict('C6-2'), lot: rect(150, 120), frontages: [{side: 'front', widthFeet: 80}, {side: 'left', widthFeet: 60}], use: 'commercial'});
  const top = commercial.storeys.find(s => s.shapedBy.some(c => c.control === 'rear_yard'));
  assert.equal(top.shapedBy.find(c => c.control === 'rear_yard').cornerSection, 'ZR 33-301');
  // An interior lot is unchanged.
  const interior = computeEnvelope({rules, district: describeDistrict('R7A'), lot: rect(50, 100), frontages: [{side: 'front', widthFeet: 60}], use: 'residential'});
  assert.equal(interior.storeys[0].shapedBy.find(c => c.control === 'rear_yard').cornerPortionFeet, undefined);
});

test('the wide-street figures govern within 100 ft of a wide street and the narrow ones beyond', () => {
  const at = (lot, frontages, extra = {}) => computeEnvelope({rules, district: describeDistrict('R8'), lot, frontages, use: 'residential', ...extra});
  // 50 by 150 on a wide street: two thirds within 100 ft take 7.20, the rest 6.02 (ZR 23-22 note 1), weighted (ZR 77-22).
  const deep = at(rect(50, 150), [{side: 'front', widthFeet: 100}]);
  assert.equal(deep.floorArea.maxFar, Number((7.2 * 2 / 3 + 6.02 / 3).toFixed(3)));
  assert.ok(deep.checks.some(c => /ZR 77-22/.test(c)));
  // Heights by portion (ZR 23-432 notes 1 and 2): 135 ft within 100 ft, 115 ft beyond.
  const portions = deep.controls.portions;
  assert.deepEqual(portions.map(p => [p.label, p.sharePercent, p.heightLimitFeet, p.maxBaseHeightFeet]), [['Within 100 ft of a wide street', 66.7, 135, 95], ['Beyond 100 ft of a wide street', 33.3, 115, 85]]);
  const tall = at(rect(50, 150), [{side: 'front', widthFeet: 100}], {maxFar: 12});
  const high = tall.storeys.filter(s => s.topFeet > 115);
  assert.ok(high.length && high.every(s => s.footprint.every(p => p[1] <= 100 + 1e-6) && s.shapedBy.every(c => c.portion === 0)), 'above 115 ft only the wide-street portion rises');
  const low = tall.storeys[0];
  assert.deepEqual([...new Set(low.shapedBy.map(c => c.portion))], [0, 1]);
  assert.ok(low.footprint.some(p => p[1] > 100), 'below 115 ft the whole lot builds');
  // Wholly within 100 ft of the wide street, or on a narrow street only: one row, no portions.
  const shallow = at(rect(50, 100), [{side: 'front', widthFeet: 100}]);
  assert.deepEqual([shallow.floorArea.maxFar, shallow.controls.portions, shallow.controls.heightLimitFeet], [7.2, undefined, 135]);
  const narrow = at(rect(50, 150), [{side: 'front', widthFeet: 60}]);
  assert.deepEqual([narrow.floorArea.maxFar, narrow.controls.portions, narrow.controls.heightLimitFeet], [6.02, undefined, 115]);
  // A narrow front street with a wide side street: the 100 ft column along the side street is the wide-street portion.
  const side = at(rect(150, 100), [{side: 'front', widthFeet: 60}, {side: 'left', widthFeet: 100}]);
  assert.equal(side.controls.portions[0].sharePercent, 66.7);
  // The outlines export names the portions for the planning engine.
  const out = storeyOutlines(deep, {lot: {exterior: rect(50, 150), holes: [], source: 'tax-lot'}});
  assert.deepEqual(out.portions.map(p => [p.kind, p.inside, p.sides, p.withinFeet]), [['wide-street', true, ['front'], 100], ['wide-street', false, ['front'], 100]]);
});

test('sky exposure plane buildings take the height factor ratio, a front wall and the plane (ZR 23-73)', () => {
  const at = (code, lot, width, extra = {}) => computeEnvelope({rules, district: describeDistrict(code), lot, frontages: [{side: 'front', widthFeet: width}], use: 'residential', form: 'sky-exposure-plane', ...extra});
  // R6: the table's best ratio is 2.43 at height factors 13 to 15 (ZR 23-732); the lowest is drawn.
  const r6 = at('R6', rect(100, 100), 60);
  assert.deepEqual([r6.controls.heightFactor.value, r6.floorArea.maxFar, r6.controls.heightFactor.openSpaceRatio], [13, 2.43, 33.5]);
  assert.equal(r6.controls.coverage.basePercent, null, 'no lot coverage limit (ZR 23-735)');
  // A front wall to 60 ft within the 20 ft initial setback on a narrow street, then the 2.7:1 plane (ZR 23-736).
  const above = r6.storeys.find(s => s.topFeet > 100);
  const setback = above.shapedBy.find(c => c.control === 'setback');
  assert.equal(setback.section, 'ZR 23-736');
  assert.ok(Math.abs(setback.feet.front - Math.max(20, (above.topFeet - 60) / 2.7)) < 0.02);
  // Every storey within the coverage the height factor allows: floor area over the height factor.
  assert.ok(r6.storeys.every(s => s.areaSqft <= 2.43 * 10000 / 13 + 1));
  // R9: a tower penetrates the plane above the 85 ft front wall (ZR 23-737); R10 takes 10.0 (ZR 23-733).
  const r9 = at('R9', rect(100, 200), 100);
  assert.ok(r9.storeys.some(s => s.shapedBy.some(c => c.section === 'ZR 23-737')));
  assert.equal(at('R10', rect(100, 100), 100).floorArea.maxFar, 10);
  // Not for districts with a letter suffix or the excluded ones (ZR 23-731).
  assert.throws(() => at('R7A', rect(100, 100), 60), /ZR 23-731/);
  assert.throws(() => at('R7-3', rect(100, 100), 60), /ZR 23-731/);
  // A standard R6 envelope reports the alternative without pricing it.
  const standard = computeEnvelope({rules, district: describeDistrict('R6'), lot: rect(100, 100), frontages: [{side: 'front', widthFeet: 60}], use: 'residential'});
  assert.deepEqual([standard.floorArea.maxFar, standard.alternatives.skyExposurePlane.maxFar, standard.alternatives.skyExposurePlane.heightFactor], [2.2, 2.43, 13]);
  assert.ok(standard.checks.some(c => /optional sky exposure plane rules/.test(c)));
});
