import test from 'node:test';
import assert from 'node:assert/strict';
import {computeEnvelope, storeyOutlines, polygonArea, OUTLINES_SCHEMA} from './envelope.mjs';
import {rules, describeDistrict} from './zoning.mjs';
import {lotOutline, schemeOutlines} from './scheme-outlines.mjs';

const rect = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];
const FOOT = 0.3048;
const scheme = (key, zfa, storeys = 6) => ({id: key === 'standard' ? 'as_of_right' : 'max_bonus', label: 'Option', program: {key, zfa, storeys, units: 20}});

test('every envelope storey says, as data, which controls shaped it and its zoning floor area budget', () => {
  const cases = [
    ['R6B', rect(25, 100), [{side: 'front', widthFeet: 60}], 'residential'],
    ['R7A', rect(50, 100), [{side: 'front', widthFeet: 60}], 'residential'],
    ['R8', rect(100, 125), [{side: 'front', widthFeet: 100}, {side: 'left', widthFeet: 60}], 'residential'],
    ['R5', rect(40, 100), [{side: 'front', widthFeet: 60}], 'residential'],
    ['C6-2', rect(100, 100), [{side: 'front', widthFeet: 80}], 'commercial'],
  ];
  for (const [code, lot, frontages, use] of cases) {
    const envelope = computeEnvelope({rules, district: describeDistrict(code), lot, frontages, use});
    const out = storeyOutlines(envelope, {scheme: 'as_of_right', lot: {exterior: lot, holes: [], source: 'tax-lot'}, grossPerZfa: 1.058});
    assert.equal(out.schema, OUTLINES_SCHEMA);
    assert.equal(out.storeys.length, envelope.storeys.length, code);
    for (const s of out.storeys) {
      assert.ok(s.shapedBy.length, `${code} ${s.label} names its controls`);
      for (const c of s.shapedBy) assert.match(c.section, /^ZR \d/, `${code} ${c.control}`);
      assert.equal(s.zfaBudgetSqft, Math.round(s.grossBudgetSqft / 1.058));
    }
    const budget = out.storeys.reduce((sum, s) => sum + s.zfaBudgetSqft, 0);
    assert.ok(budget <= out.floorArea.maxZfaSqft + out.storeys.length, `${code}: the storeys hold at most the lot's zoning floor area`);
  }
});

test('the controls carry the numbers the engine redraws from: yards, per-street setbacks and caps', () => {
  // A floor area ratio above the table's, so the building rises past its base and sets back.
  const corner = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(100, 125), frontages: [{side: 'front', widthFeet: 100}, {side: 'left', widthFeet: 60}], maxFar: 9});
  const top = corner.storeys.at(-1).shapedBy, base = corner.storeys[0].shapedBy;
  // The last 25 ft lie beyond 100 ft of the wide front street, so each control names its portion (ZR 23-432 notes).
  assert.deepEqual(base.find(c => c.control === 'rear_yard'), {control: 'rear_yard', feet: 20, section: 'ZR 23-342', cornerPortionFeet: 100, cornerSection: 'ZR 23-344', text: 'rear yard 20 ft', portion: 0});
  assert.deepEqual(base.filter(c => c.control === 'rear_yard').map(c => c.portion), [0, 1]);
  assert.equal(base.find(c => c.control === 'street_wall').section, 'ZR 23-432');
  const setback = top.find(c => c.control === 'setback');
  assert.deepEqual(setback.feet, {front: 10, left: 15}, 'the wide front street sets back 10 ft and the narrow side street 15 ft');
  assert.ok(top.some(c => c.control === 'lot_coverage' && c.percent > 0));
  const low = computeEnvelope({rules, district: describeDistrict('R5'), lot: rect(40, 100), frontages: [{side: 'front', widthFeet: 60}]});
  assert.ok(low.storeys[0].shapedBy.some(c => c.control === 'front_yard' && c.feet > 0 && c.sides.includes('front')));
  const through = computeEnvelope({rules, district: describeDistrict('R7A'), lot: rect(40, 200), frontages: [{side: 'front'}, {side: 'rear'}]});
  assert.ok(through.storeys[0].shapedBy.some(c => c.control === 'rear_yard_equivalent' && c.section === 'ZR 23-343'));
});

test('court minimums come with each residential storey at its height', () => {
  const envelope = computeEnvelope({rules, district: describeDistrict('R8'), lot: rect(100, 150), frontages: [{side: 'front', widthFeet: 100}]});
  const out = storeyOutlines(envelope, {lot: {exterior: rect(100, 150), holes: [], source: 'tax-lot'}});
  assert.deepEqual(out.storeys[0].courts.inner.withWindows, {minAreaSqft: 800, minDimensionFeet: 20});
  assert.deepEqual(out.storeys.find(s => s.topFeet > 75).courts.inner.withWindows, {minAreaSqft: 1200, minDimensionFeet: 30});
});

test('the lot outline is the tax-lot ring in feet with the front at z = 0, or the PLUTO rectangle', async () => {
  const property = {bbl: '3012340001', lotfront: '50', lotdepth: '100', lotarea: '5000'};
  const fallback = await lotOutline(property, {});
  assert.equal(fallback.source, 'rectangle');
  assert.deepEqual(fallback.exterior, rect(50, 100));
  assert.match(fallback.note, /No tax-lot polygon/);
  // The outline stored at market ingest (feet, front on z = 0) stands for the lot when no loader runs.
  const stored = await lotOutline(property, {storedPolygon: [[5, 0], [55, 0], [55, 90], [5, 100]]});
  assert.equal(stored.source, 'tax-lot');
  assert.deepEqual(stored.exterior, [[0, 0], [50, 0], [50, 90], [0, 100]]);
  assert.match(stored.note, /tax map, not a survey/);
  // A trapezoid in metres, placed by the loader away from the origin.
  const parcel = [[10, 20], [10 + 50 * FOOT, 20], [10 + 50 * FOOT, 20 + 90 * FOOT], [10, 20 + 105 * FOOT]];
  const loadContext = async () => ({context: {parcel: {bbl: '3012340001', polygon: parcel}, buildings: []}});
  const lot = await lotOutline(property, {loadContext});
  assert.equal(lot.source, 'tax-lot');
  assert.match(lot.note, /tax map, not a survey/);
  assert.equal(Math.min(...lot.exterior.map(p => p[1])), 0);
  assert.equal(Math.min(...lot.exterior.map(p => p[0])), 0);
  assert.ok(Math.abs(polygonArea(lot.exterior) - 50 * 97.5) < 1);
});

test('a corner lot fronts its frontage on record and puts the side street on the open side', async () => {
  const property = {bbl: '3012340001', lotfront: '40', lotdepth: '100', lottype: '3'};
  // The loader fronted the 100 ft side: the lot is 100 wide and 40 deep in its frame.
  const sideways = [[0, 0], [100 * FOOT, 0], [100 * FOOT, 40 * FOOT], [0, 40 * FOOT]];
  const turned = await lotOutline(property, {corner: true, loadContext: async () => ({context: {parcel: {bbl: 'x', polygon: sideways}, buildings: []}})});
  const xs = turned.exterior.map(p => p[0]), zs = turned.exterior.map(p => p[1]);
  assert.deepEqual([Math.round(Math.max(...xs)), Math.round(Math.max(...zs))], [40, 100]);
  assert.equal(turned.sideStreet, 'left');
  // Fronted right, with a neighbour against the left side: the side street is on the right.
  const upright = [[0, 0], [40 * FOOT, 0], [40 * FOOT, 100 * FOOT], [0, 100 * FOOT]];
  const neighbour = {existing: false, polygon: [[-30, -5], [-0.5, -5], [-0.5, 40], [-30, 40]]};
  const right = await lotOutline(property, {corner: true, loadContext: async () => ({context: {parcel: {bbl: 'x', polygon: upright}, buildings: [neighbour]}})});
  assert.equal(right.sideStreet, 'right');
});

test('neighbouring buildings come in the lot\'s frame, in feet, for the site plan', async () => {
  const property = {bbl: '3012340001', lotfront: '50', lotdepth: '100', lotarea: '5000', zonedist1: 'R7A'};
  const parcel = [[10, 20], [10 + 50 * FOOT, 20], [10 + 50 * FOOT, 20 + 100 * FOOT], [10, 20 + 100 * FOOT]];
  const next = {existing: false, height: 12, polygon: [[10 + 50 * FOOT, 20], [10 + 75 * FOOT, 20], [10 + 75 * FOOT, 20 + 60 * FOOT], [10 + 50 * FOOT, 20 + 60 * FOOT]]};
  const own = {existing: true, height: 9, polygon: parcel};
  const lot = await lotOutline(property, {loadContext: async () => ({context: {parcel: {bbl: 'x', polygon: parcel}, buildings: [own, next]}})});
  assert.deepEqual(lot.context, [{polygon: [[50, 0], [75, 0], [75, 60], [50, 60]], height: 39.4}], 'the subject\'s own buildings are left out');
  assert.deepEqual(schemeOutlines(scheme('standard', 20000), {property, lot}).context, lot.context);
  // A corner lot turned a quarter carries its neighbours with it.
  const corner = {...property, lotfront: '40', lottype: '3'};
  const sideways = [[0, 0], [100 * FOOT, 0], [100 * FOOT, 40 * FOOT], [0, 40 * FOOT]];
  const beside = {existing: false, height: 6, polygon: [[0, 40 * FOOT], [100 * FOOT, 40 * FOOT], [100 * FOOT, 60 * FOOT], [0, 60 * FOOT]]};
  const turned = await lotOutline(corner, {corner: true, loadContext: async () => ({context: {parcel: {bbl: 'x', polygon: sideways}, buildings: [beside]}})});
  assert.deepEqual(turned.context[0].polygon, [[40, 100], [40, 0], [60, 0], [60, 100]]);
  assert.deepEqual((await lotOutline(property, {})).context, undefined, 'a rectangle from PLUTO has no neighbours placed');
});

test('north is carried from the loader\'s frame, turned with a corner lot\'s ring', async () => {
  const property = {bbl: '3012340001', lotfront: '40', lotdepth: '100', lottype: '3'};
  const north = [0.6, -0.8];
  const sideways = [[0, 0], [100 * FOOT, 0], [100 * FOOT, 40 * FOOT], [0, 40 * FOOT]];
  const turned = await lotOutline(property, {corner: true, loadContext: async () => ({context: {parcel: {bbl: 'x', polygon: sideways}, buildings: [], north}})});
  // The quarter turn (x, z) -> (z, -x) applies to the direction as well as the ring.
  assert.deepEqual(turned.north, [-0.8, -0.6]);
  const upright = [[0, 0], [40 * FOOT, 0], [40 * FOOT, 100 * FOOT], [0, 100 * FOOT]];
  const kept = await lotOutline(property, {loadContext: async () => ({context: {parcel: {bbl: 'x', polygon: upright}, buildings: [], north}})});
  assert.deepEqual(kept.north, north);
  assert.equal((await lotOutline(property, {})).north, undefined, 'a rectangle has no placed north');
  const site = schemeOutlines(scheme('standard', 12000), {property: {...property, zonedist1: 'R7A'}, lot: kept});
  assert.deepEqual(site.lot.north, north);
});

test('the option\'s parking follows the lot\'s transit zone on record in PLUTO', () => {
  const property = {bbl: '3012340001', zonedist1: 'R7A', lotfront: '100', lotdepth: '100', lottype: '5', cd: '402'};
  const lot = {exterior: rect(100, 100), holes: [], source: 'tax-lot'};
  const program = s => ({id: 'as_of_right', label: 'Option', program: {key: 'standard', zfa: 40000, storeys: 8, units: s}});
  const beyond = schemeOutlines(program(60), {property: {...property, transitzone: 'Beyond the Greater Transit Zone'}, lot});
  assert.deepEqual([beyond.parking.transitZone, beyond.parking.transitZoneSource, beyond.parking.transitZones], ['beyond', 'PLUTO transit zone', undefined]);
  assert.ok(beyond.parking.required > 0);
  const special = schemeOutlines(program(60), {property: {...property, transitzone: 'Special 25-241 Parking Provisions'}, lot});
  assert.equal(special.parking.required, beyond.parking.required, 'ZR 25-241: standard residences take the beyond-zone requirement');
  assert.ok(special.parking.sections.includes('ZR 25-241'));
  const inner = schemeOutlines(program(60), {property: {...property, transitzone: 'Inner Transit Zone'}, lot});
  assert.equal(inner.parking.required, 0);
  const lic = schemeOutlines(program(60), {property: {...property, transitzone: 'Manhattan Core and Long Island City Parking Areas'}, lot});
  assert.deepEqual([lic.parking.required, lic.parking.sections], [0, ['ZR 16-10']]);
  const blank = schemeOutlines(program(60), {property, lot});
  assert.equal(blank.parking.required, null);
  assert.ok(blank.parking.transitZones.beyond);
});

test('an option is outlined on its own envelope: the bonus option on the affordable one, stacked to its floor area', () => {
  const property = {bbl: '3012340001', zonedist1: 'R7A', lotfront: '50', lotdepth: '100', lottype: '5'};
  const lot = {exterior: rect(50, 100), holes: [], source: 'tax-lot', note: 'Lot lines come from the city\'s tax map, not a survey.'};
  const standard = schemeOutlines(scheme('standard', 20000), {property, lot});
  const bonus = schemeOutlines(scheme('uap', 26000, 9), {property, lot});
  assert.equal(standard.affordable, false);
  assert.equal(bonus.affordable, true);
  assert.ok(Math.abs(standard.floorArea.maxZfaSqft - 20000) <= 1);
  assert.ok(Math.abs(bonus.floorArea.maxZfaSqft - 26000) <= 1);
  assert.ok(Math.abs(bonus.storeys.reduce((sum, s) => sum + s.zfaBudgetSqft, 0) - 26000) <= bonus.storeys.length);
  assert.equal(standard.lot.source, 'tax-lot');
  // Floor area on the recorded lot area when the tax-map polygon measures differently.
  const recorded = schemeOutlines(scheme('standard', 18000), {property: {...property, lotarea: '4500'}, lot});
  assert.deepEqual([recorded.lot.areaSqft, recorded.lot.taxMapAreaSqft, recorded.lot.recordedAreaSqft, recorded.zoningFloorArea.allowedSqft, recorded.zoningFloorArea.optionFar], [4500, 5000, 4500, 18000, 4]);
  // Coverage caps rest on the recorded area too: a 4,500 sq ft lot covers at most 80% of 4,500 (ZR 23-362).
  assert.ok(recorded.storeys.every(st => st.grossBudgetSqft <= 3600 + 1));
  assert.deepEqual(standard.program, {zfa: 20000, storeys: 6, units: 20, affordableZfa: 0});
  // The zoning sheet's figures: the table allowance in zoning floor area, the option's own, and parking for its units.
  assert.deepEqual([standard.zoningFloorArea.allowedFar, standard.zoningFloorArea.allowedSqft, standard.zoningFloorArea.optionFar], [4, 20000, 4]);
  assert.equal(bonus.zoningFloorArea.allowedFar, 5.01);
  assert.ok(bonus.zoningFloorArea.sections.some(s => /Universal Affordability Preference/.test(s)));
  assert.equal(standard.parking.transitZones.outer.waiverSpaces, 15, 'R7A outer transit zone: 15 percent, waived at 15 spaces or fewer (ZR 25-222)');
  assert.equal(standard.parking.transitZones.outer.required, 0);
  assert.ok(standard.floorAreaRules.excluded.some(e => e.kind === 'refuse' && e.section === 'ZR 23-233'));
  assert.throws(() => schemeOutlines({label: 'Empty', program: null}, {property, lot}), /no floor area/);
});

test('a split lot is outlined district by district from the zoning map, its floor area ratio weighted by area', async () => {
  const property = {bbl: '3012340001', zonedist1: 'R7A', zonedist2: 'R6', lotfront: '100', lotdepth: '100', lotarea: '10000', lottype: '5', cd: '302'};
  const upright = [[0, 0], [100 * FOOT, 0], [100 * FOOT, 100 * FOOT], [0, 100 * FOOT]];
  // The loader's frame: origin at the lot centre, x east, z south; the lot is placed as is.
  const context = {parcel: {bbl: 'x', polygon: upright}, buildings: [], north: [0, -1], origin: {latitude: 40.7, longitude: -74}, frame: {origin: [0, 0], into: [0, 1], lotCenter: [50 * FOOT, 50 * FOOT]}};
  const lonLat = ([x, z]) => [-74 + x / (111320 * Math.cos(40.7 * Math.PI / 180)), 40.7 - z / 111320];
  // R7A on the west 40 ft, R6 on the east 60 ft (x in metres about the lot centre).
  const ring = (x0, x1) => [[x0, -20], [x1, -20], [x1, 20], [x0, 20]].map(([x, z]) => lonLat([x * FOOT, z * FOOT]));
  const districtParts = async () => [{code: 'R6', sharePercent: 60, parts: [{polygon: ring(-10, 70), holes: []}]}, {code: 'R7A', sharePercent: 40, parts: [{polygon: ring(-70, -10), holes: []}]}];
  const lot = await lotOutline(property, {loadContext: async () => ({context}), districtParts});
  assert.deepEqual(lot.districts.map(d => d.code), ['R6', 'R7A']);
  const r7a = lot.districts[1].parts[0].exterior;
  assert.ok(Math.abs(Math.max(...r7a.map(p => p[0])) - 40) < 0.2, 'the R7A part ends 40 ft into the lot');
  const site = schemeOutlines({id: 'as_of_right', label: 'As of right', program: {key: 'standard', zfa: 28000, storeys: 8, units: 30}}, {property, lot});
  // ZR 77-22: 2.2 on 60% and 4.0 on 40%.
  assert.equal(site.zoningFloorArea.allowedFar, Number((2.2 * 0.6 + 4 * 0.4).toFixed(3)));
  assert.deepEqual(site.districtPortions.map(p => [p.district, p.sharePercent]), [['R6', 60], ['R7A', 40]]);
  assert.deepEqual(site.portions.map(p => [p.kind, p.district, p.heightLimitFeet]), [['district', 'R6', 55], ['district', 'R7A', 85]]);
  // Storeys above R6's 55 ft stand only on the R7A portion (ZR 77-28).
  const tall = computeEnvelope({rules, lot: lot.exterior, frontages: [{side: 'front'}], use: 'residential', maxFar: 5, districtPortions: lot.districts.map(d => ({...d, district: describeDistrict(d.code)}))});
  const high = tall.storeys.filter(s => s.topFeet > 55);
  assert.ok(high.length && high.every(s => s.shapedBy.every(c => c.portion === 1) && s.footprint.every(p => p[0] <= 40 + 1e-6)));
  assert.ok(site.checks.some(c => /Split zoning lot/.test(c) && /ZR 77-22/.test(c)));
  // Without the map's placement the lot keeps its first district and says why.
  const failed = await lotOutline(property, {loadContext: async () => ({context}), districtParts: async () => { throw new Error('timeout'); }});
  assert.match(failed.unavailable, /could not be read/);
  assert.equal(schemeOutlines({id: 'as_of_right', label: 'As of right', program: {key: 'standard', zfa: 20000, storeys: 6, units: 20}}, {property, lot: failed}).portions, null);
});
