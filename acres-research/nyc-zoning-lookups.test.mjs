import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {coveredArea, triangulate, ringArea, parseStreetWidth, streetKey, currentZoning, districtParts, frontingStreets, mihAreaForPoint, filedExistingZfa, createParcelLookups,transitZoneForPoint,TRANSIT_ZONES_URL} from './nyc-zoning-lookups.mjs';
import {createZoningTools} from './zoning.mjs';
import {createEntitlementTools, entitlementScenarios} from './entitlements.mjs';

// Plane fixtures in feet, and the same shapes placed in lon/lat near lower Manhattan.
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const part = (polygon, holes = []) => ({polygon, holes});
const LAT0 = 40.7, LON0 = -74;
const lonLat = ([x, y]) => [LON0 + (x * 0.3048) / (111320 * Math.cos((LAT0 * Math.PI) / 180)), LAT0 + (y * 0.3048) / 111320];
const polygonFeature = (properties, ring) => ({type: 'Feature', properties, geometry: {type: 'Polygon', coordinates: [ring.map(lonLat)]}});
const lineFeature = (properties, line) => ({type: 'Feature', properties, geometry: {type: 'LineString', coordinates: line.map(lonLat)}});

test('covered area is exact for concave lots, concave districts and holes', () => {
  const lot = [part(square(0, 0, 100, 100))];
  assert.equal(coveredArea(lot, [part(square(-50, -50, 60, 150))]), 6000);
  // An L-shaped lot of 7,500 sq ft, half of each arm under the district.
  const ell = [part([[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100], [0, 0]])];
  assert.equal(triangulate(ell[0].polygon).reduce((s, t) => s + ringArea(t), 0), 7500);
  assert.equal(coveredArea(ell, [part(square(-10, -10, 25, 110))]), 2500);
  // A concave district with a hole over the lot.
  const district = part([[-10, -10], [110, -10], [110, 110], [90, 110], [90, 20], [-10, 20], [-10, -10]], [square(40, 0, 60, 10)]);
  assert.equal(Math.round(coveredArea(lot, [district])), 100 * 20 + 10 * 80 - 200);
});

test('mapped street widths settle wide or narrow only when the record does', () => {
  assert.deepEqual(parseStreetWidth('100'), {raw: '100', widthFeet: 100, wide: true});
  assert.deepEqual(parseStreetWidth('~60'), {raw: '~60', widthFeet: 60, wide: false, approximate: true});
  assert.deepEqual(parseStreetWidth('<60'), {raw: '<60', widthFeet: null, wide: false});
  assert.deepEqual(parseStreetWidth('<100'), {raw: '<100', widthFeet: null, wide: null});
  assert.deepEqual(parseStreetWidth('>100'), {raw: '>100', widthFeet: 100, wide: true, lowerBound: true});
  assert.deepEqual(parseStreetWidth('60-100'), {raw: '60-100', widthFeet: 60, wide: null, range: true});
  assert.deepEqual(parseStreetWidth('34.6-35.9'), {raw: '34.6-35.9', widthFeet: 34.6, wide: false, range: true});
  assert.equal(parseStreetWidth('').widthFeet, null);
  assert.equal(streetKey('W 42ND ST'), streetKey('West 42 Street'));
});

// Serves DCP, MapPLUTO and NYC Open Data fixtures by URL, recording each request.
const LOT = square(0, 0, 100, 100);
const stubRequest = ({mih = [], dob = [], calls = []} = {}) => async url => {
  const u = decodeURIComponent(String(url));
  calls.push(u);
  if (u.includes('MAPPLUTO')) return {features: [polygonFeature({BBL: 1000470001}, LOT)]};
  if (u.includes('/nyzd/')) return {features: [polygonFeature({ZONEDIST: 'C6-4'}, square(-50, -50, 60, 150)), polygonFeature({ZONEDIST: 'R8'}, square(60, -50, 200, 150))]};
  if (u.includes('/nyco/')) return {features: [polygonFeature({OVERLAY: 'C1-5'}, square(99.5, -50, 200, 150))]};
  if (u.includes('/nysp/')) return {features: []};
  if (u.includes('DCM_Street_Center_Line')) return {features: [
    lineFeature({Street_NM: 'West 42 Street', Streetwidth: '80'}, [[-300, -40], [300, -40]]),
    lineFeature({Street_NM: 'West 43 Street', Streetwidth: '60'}, [[-300, 135], [300, 135]]),
    lineFeature({Street_NM: '8 Avenue', Streetwidth: '100'}, [[-35, -300], [-35, 300]]),
    lineFeature({Street_NM: '9 Avenue', Streetwidth: '100'}, [[400, -300], [400, 300]]),
  ]};
  if (u.includes('m79g-k9r4')) return mih;
  if (u.includes('ic3t-wcy2')) return dob;
  throw new Error(`unexpected request ${u}`);
};

test('current zoning reports each mapped district share of the lot and drops boundary slivers', async () => {
  const z = await currentZoning('1000470001', {request: stubRequest()});
  assert.deepEqual(z.districts, [{code: 'C6-4', sharePercent: 60}, {code: 'R8', sharePercent: 40}]);
  assert.deepEqual(z.overlays, []);
  assert.deepEqual(z.sliversIgnored, ['C1-5']);
  assert.equal(z.mappedLotAreaSqft, 10000);
});

test('district parts give each district on a split lot its share and its polygon around the lot', async () => {
  const parts = await districtParts('1000470001', {request: stubRequest()});
  assert.deepEqual(parts.map(d => [d.code, d.sharePercent]), [['C6-4', 60], ['R8', 40]]);
  // Each polygon is cut to a box about 20 m around the 100 ft lot, in longitude and latitude.
  const ring = parts[0].parts[0].polygon;
  const back = ([lon, lat]) => [(lon - LON0) * 111320 * Math.cos((LAT0 * Math.PI) / 180) / 0.3048, (lat - LAT0) * 111320 / 0.3048];
  const xs = ring.map(p => back(p)[0]), ys = ring.map(p => back(p)[1]);
  assert.ok(Math.min(...xs) < 0 && Math.min(...xs) > -80 && Math.abs(Math.max(...xs) - 60) < 0.01);
  assert.ok(Math.min(...ys) > -80 && Math.max(...ys) < 180);
});

test('fronting streets come from the Digital City Map: the address street is the front, a parallel one the rear', async () => {
  const s = await frontingStreets({bbl: '1000470001', address: '350 W 42ND ST'}, {request: stubRequest()});
  assert.deepEqual(s.streets.map(x => [x.side, x.name, x.widthFeet, x.wide]), [['front', 'West 42 Street', 80, true], ['rear', 'West 43 Street', 60, false], ['right', '8 Avenue', 100, true]]);
  assert.equal(s.frontMatchedAddress, true);
});

test('a street segment without a recorded width takes the same street\'s other segments, and the lot line may sit 15 ft off the street line', async () => {
  const stub = streetsFeatures => async url => {
    const u = decodeURIComponent(String(url));
    if (u.includes('MAPPLUTO')) return {features: [polygonFeature({BBL: 1000470001}, LOT)]};
    if (u.includes('DCM_Street_Center_Line')) return {features: streetsFeatures};
    throw new Error(`unexpected request ${u}`);
  };
  // The front segment says Unknown; another segment of the same street, past the lot, says 80.
  const unknown = await frontingStreets({bbl: '1000470001', address: '1 BROAD AVENUE'}, {request: stub([
    lineFeature({Street_NM: 'Broad Avenue', Streetwidth: 'Unknown'}, [[-50, -40], [150, -40]]),
    lineFeature({Street_NM: 'Broad Avenue', Streetwidth: '80'}, [[150, -40], [300, -40]]),
    lineFeature({Street_NM: 'Broad Avenue', Streetwidth: '60'}, [[250, -40], [300, -40]]),
  ])});
  assert.deepEqual(unknown.streets.map(s => [s.side, s.widthFeet, s.wide, s.widthFrom]), [['front', 80, true, 'nearest mapped segment of the same street']]);
  // A 60 ft street whose centerline sits 43 ft from the tax-lot line (13 ft of digitizing offset) still fronts the lot.
  const offset = await frontingStreets({bbl: '1000470001', address: '1 BROAD AVENUE'}, {request: stub([lineFeature({Street_NM: 'Broad Avenue', Streetwidth: '60'}, [[-50, -43], [150, -43]])])});
  assert.equal(offset.streets[0]?.widthFeet, 60);
  // Any other street gets 10 ft: one 13 ft off the lot line is behind a neighbour, not a side street.
  const side = await frontingStreets({bbl: '1000470001', address: '1 BROAD AVENUE'}, {request: stub([lineFeature({Street_NM: 'Broad Avenue', Streetwidth: '60'}, [[-50, -40], [150, -40]]), lineFeature({Street_NM: 'Cross Street', Streetwidth: '60'}, [[-43, -60], [-43, 160]])])});
  assert.deepEqual(side.streets.map(x => x.name), ['Broad Avenue']);
});

test('the MIH lookup tests the point against the mapped area and drops a lapsed Workforce Option', async () => {
  const row = {the_geom: {type: 'MultiPolygon', coordinates: [[square(-500, -500, 500, 500).map(lonLat)]]}, boro: '1', cd: '4', project_nam: 'Hudson Yards test', date_adopte: '2016-03-22T00:00:00.000', mih_option: 'Option 1, Option 2, and Workforce Option'};
  const inside = await mihAreaForPoint(LAT0, LON0, {request: stubRequest({mih: [row]}), now: Date.parse('2026-10-18')});
  assert.equal(inside.inMihArea, true);
  assert.deepEqual(inside.availableOptions.map(o => o.key), ['option1', 'option2']);
  const outside = await mihAreaForPoint(LAT0, LON0, {request: stubRequest()});
  assert.equal(outside.inMihArea, false);
});

const bis = (job, type, filed, {signoff = '', existing = '', proposed = '', status = 'SIGNED OFF'} = {}) => ({job__: job, job_type: type, job_status_descrp: status, pre__filing_date: filed, signoff_date: signoff, existing_zoning_sqft: existing, proposed_zoning_sqft: proposed});

test('filed existing ZFA prefers a later signed-off building, and skips work-area figures', async () => {
  const property = {bbl: '1000470001', bldgarea: '10000'};
  const workArea = bis('A2-1', 'A2', '06/01/2015', {existing: '3000'});
  const stated = bis('A1-1', 'A1', '03/01/2012', {existing: '9200', status: 'PERMIT ISSUED'});
  const picked = await filedExistingZfa(property, {request: stubRequest({dob: [workArea, stated]})});
  assert.equal(picked.existingZfaSqft, 9200);
  assert.match(picked.basis, /A1 job A1-1/);
  assert.deepEqual(picked.implausibleJobs, ['A2-1']);
  const built = bis('NB-1', 'NB', '02/01/2016', {signoff: '09/30/2018', proposed: '9500'});
  assert.equal((await filedExistingZfa(property, {request: stubRequest({dob: [stated, built]})})).existingZfaSqft, 9500);
  const none = await filedExistingZfa(property, {request: stubRequest()});
  assert.equal(none.existingZfaSqft, null);
  assert.match(none.basis, /no DOB BIS filing/);
});

test('parcel lookups settle independently and run once per lot', async () => {
  const calls = [];
  const failing = async url => { if (String(url).includes('m79g-k9r4')) throw new Error('Socrata HTTP 503'); return stubRequest({calls})(url); };
  const lookups = createParcelLookups({request: failing});
  const property = {bbl: '1000470001.00000000', address: '350 W 42ND ST', latitude: LAT0, longitude: LON0, bldgarea: '10000'};
  const found = await lookups(property);
  assert.equal(found.zoning.districts.length, 2);
  assert.equal(found.streets.streets[0].side, 'front');
  assert.equal(found.mih, null);
  assert.match(found.unavailable.mih, /503/);
  const count = calls.length;
  await lookups(property);
  assert.equal(calls.length, count);
});

// Lookups as the zoning and entitlement tools receive them.
const property = {bbl: '1000470001', address: '350 W 42ND ST', zonedist1: 'C6-4', zonedist2: 'R8', overlay1: null, spdist1: null, lotarea: '10000', bldgarea: '30000', residfar: '10', affresfar: '12', commfar: '10', facilfar: '10', lotfront: '100', lotdepth: '100', numfloors: '6', splitzone: true, version: '26v2'};
const found = (over = {}) => async () => ({
  zoning: {districts: [{code: 'C6-4', sharePercent: 60}, {code: 'R9', sharePercent: 40}], overlays: [], specialDistricts: [], sliversIgnored: [], mappedLotAreaSqft: 10050, source: 'DCP'},
  streets: {streets: [{side: 'front', name: 'West 42 Street', widthFeet: 80, wide: true}], frontMatchedAddress: true, source: 'DCM'},
  mih: {inMihArea: true, name: 'Hudson Yards test', adopted: '2016-03-22', mappedOptions: ['option1', 'option2'], availableOptions: [{key: 'option1', label: 'Option 1', affordableShare: 0.25, amiPct: 60}, {key: 'option2', label: 'Option 2', affordableShare: 0.3, amiPct: 80}], smallProjectExemption: {maxUnits: 10, maxResidentialSqft: 12500}},
  existingZfa: {existingZfaSqft: 27000, basis: 'A1 job 120000001 (SIGNED OFF, filed 2012-03-01) states this existing zoning floor area', filing: {jobNumber: '120000001'}},
  unavailable: {},
  ...over,
});

test('lotShape tax_lot draws the envelope on the snapped MapPLUTO polygon and falls back by name without geometry', async () => {
  const polygon = [[0, 0], [80, 0], [80, 60], [40, 60], [40, 90], [0, 90]];
  const seen = [];
  const snapped = {polygon, widthFeet: 80, depthFeet: 90, frontEdgeIndex: 0, edges: [{index: 0, lengthFeet: 80, bearingDegrees: 180, compass: 'south'}], note: 'Tax-lot outline from MapPLUTO geometry.'};
  const tools = createZoningTools({getProperty: () => property, lookups: found(), taxLotOutline: async (bbl, opts) => { seen.push([bbl, opts]); return snapped; }});
  const out = await tools.handlers.acres_zoning_envelope({lotShape: 'tax_lot', frontCompass: 'south'});
  assert.deepEqual(seen, [['1000470001', {frontageFeet: 100, frontEdge: 'south'}]]);
  assert.deepEqual(out.envelope.lot.polygon, polygon, 'the envelope massing sits on the tax-lot shape, not the PLUTO rectangle');
  assert.equal(out.envelope.lotOutline.frontEdgeIndex, 0);
  assert.equal(out.envelope.lotOutline.edges[0].compass, 'south');
  const missing = createZoningTools({getProperty: () => property, lookups: found(), taxLotOutline: async () => null});
  const fallback = await missing.handlers.acres_zoning_envelope({lotShape: 'tax_lot'});
  assert.deepEqual(fallback.envelope.lot.polygon, [[0, 0], [100, 0], [100, 100], [0, 100]], 'no geometry keeps the PLUTO rectangle');
  assert.ok(fallback.flags.some(f => /Tax-lot shape requested but MapPLUTO has no geometry/.test(f)));
  assert.equal(fallback.envelope.lotOutline, undefined);
});

test('the zoning envelope takes mapped street widths, current zoning, split-lot floor area, MIH and filed existing ZFA', async () => {
  const out = await createZoningTools({getProperty: () => property, lookups: found()}).handlers.acres_zoning_envelope({});
  assert.match(out.envelopeSummary.streetAssumption, /^front: wide/);
  assert.deepEqual(out.parcel.currentZoning.districts.map(d => d.code), ['C6-4', 'R9']);
  assert.ok(out.flags.some(f => /Current zoning map differs from PLUTO 26v2: the map shows district R9 on 40% of the lot, which PLUTO does not list; PLUTO lists district R8, which the map no longer shows on the lot\./.test(f)));
  const split = out.parcel.splitLotApportionment;
  assert.deepEqual(split.portions.map(p => [p.district, p.lotAreaSqft]), [['C6-4', 6000], ['R9', 4000]]);
  assert.equal(split.maxFloorAreaSqft.commercial, 6000 * 10);
  assert.ok(split.maxFloorAreaSqft.residential > 0);
  assert.ok(out.flags.some(f => /Mandatory Inclusionary Housing area: Hudson Yards test .*Universal Affordability Preference is unavailable/.test(f)));
  assert.equal(out.capacity.existingFloorArea.basis, 'dob_filed_zfa');
  assert.equal(out.capacity.byUse.commercial.remainingFloorAreaSqft, 100000 - 27000);
  const filedRow = out.headlineReconciliation.rows.find(r => r.label === 'Existing building ZFA (DOB filing)');
  assert.equal(filedRow.valueSqft, 27000);
  assert.match(out.headlineReconciliation.operativeFigure.reason, /filed zoning floor area of 27,000 sq ft \(DOB job 120000001\)/);
  // Caller-supplied streets win over the mapped ones.
  const narrow = await createZoningTools({getProperty: () => property, lookups: found()}).handlers.acres_zoning_envelope({streets: [{side: 'front', widthFeet: 60}]});
  assert.match(narrow.envelopeSummary.streetAssumption, /^front: narrow/);
});

test('a minor mapped portion is apportioned without reading as a rezoning, and no filing leaves PLUTO area as the existing building', async () => {
  const minor = {zoning: {districts: [{code: 'C6-4', sharePercent: 95}, {code: 'R8', sharePercent: 5}], overlays: [], specialDistricts: [], sliversIgnored: [], mappedLotAreaSqft: 10000, source: 'DCP'}, existingZfa: {existingZfaSqft: null, basis: 'no DOB BIS filing on this lot states a zoning floor area'}};
  const out = await createZoningTools({getProperty: () => ({...property, zonedist2: null}), lookups: found(minor)}).handlers.acres_zoning_envelope({});
  assert.equal(out.flags.some(f => /Current zoning map differs/.test(f)), false);
  assert.deepEqual(out.parcel.splitLotApportionment.portions.map(p => p.lotAreaSqft), [9500, 500]);
  assert.equal(out.capacity.existingFloorArea.basis, 'pluto_gross');
  assert.equal(out.capacity.byUse.commercial.remainingFloorAreaSqft, 100000 - 30000);
  assert.equal(out.headlineReconciliation.rows.some(r => r.label === 'Existing building ZFA (DOB filing)'), false);
});

test('an unavailable lookup is flagged instead of read as a result, and an uncurated portion leaves the split total open', async () => {
  const out = await createZoningTools({getProperty: () => property, lookups: found({mih: null, unavailable: {mih: 'Socrata HTTP 503'}, zoning: {districts: [{code: 'C6-4', sharePercent: 70}, {code: 'M3-1', sharePercent: 30}], overlays: [], specialDistricts: [], sliversIgnored: [], mappedLotAreaSqft: 10000, source: 'DCP'}})}).handlers.acres_zoning_envelope({});
  assert.ok(out.flags.some(f => /Mandatory Inclusionary Housing area lookup unavailable \(Socrata HTTP 503\)/.test(f)));
  assert.equal(out.parcel.splitLotApportionment.maxFloorAreaSqft.residential, null);
  assert.deepEqual(out.parcel.splitLotApportionment.uncuratedDistricts, ['M3-1']);
  assert.equal(out.headlineReconciliation.operativeFigure.valueSqft, null);
  assert.match(out.headlineReconciliation.operativeFigure.reason, /split lot's per-district total is open/);
});

test('a split lot headlines its per-district apportionment and marks whole-lot maxima as bounds', async () => {
  const out = await createZoningTools({getProperty: () => property, lookups: found()}).handlers.acres_zoning_envelope({});
  const split = out.parcel.splitLotApportionment, table = out.headlineReconciliation;
  assert.equal(out.capacity.splitLot.wholeLotBound, true);
  assert.deepEqual(out.capacity.splitLot.apportionment, split);
  assert.equal(out.capacity.byUse.commercial.maxFloorAreaSqft, 100000, 'PLUTO whole-lot bound stays visible as a bound');
  assert.equal(table.rows[0].basis, 'split_lot_apportionment');
  assert.equal(table.operativeFigure.valueSqft, Math.max(split.maxFloorAreaSqft.residential, split.maxFloorAreaSqft.commercial));
  assert.notEqual(table.operativeFigure.valueSqft, 100000);
  assert.match(table.operativeFigure.reason, /apportioned across the split lot \(C6-4 on 60%, R9 on 40%\)/);
  // Without the current map a PLUTO split lot has no apportionment, so no whole-lot maximum headlines.
  const unmapped = await createZoningTools({getProperty: () => property}).handlers.acres_zoning_envelope({});
  assert.equal(unmapped.capacity.splitLot.apportionment, null);
  assert.equal(unmapped.headlineReconciliation.operativeFigure.valueSqft, null);
  assert.match(unmapped.headlineReconciliation.operativeFigure.reason, /split between zoning districts and no per-district apportionment/);
});

test('inside a mapped MIH area the MIH scenario replaces the UAP, sized against the filed existing ZFA', async () => {
  const tools = createEntitlementTools({enabled: true, getProperty: () => ({zonedist1: 'R9A', lotarea: '10000', bldgarea: '5000', bbl: '1000470001'}), lookups: found()});
  const out = await tools.handlers.acres_entitlement_scenarios({});
  assert.equal(out.baseline.existingFloorAreaSqft, 27000);
  assert.equal(out.scenarios.some(s => s.id === 'universal-affordability-preference'), false);
  const mih = out.scenarios.find(s => s.id === 'mandatory-inclusionary-housing');
  assert.deepEqual(mih.mihOptions.map(o => [o.key, o.affordableRequiredSqft]), [['option1', Math.round(mih.totalFloorAreaSqft * 0.25)], ['option2', Math.round(mih.totalFloorAreaSqft * 0.3)]]);
  assert.equal(mih.affordableRequiredSqft, mih.mihOptions[0].affordableRequiredSqft);
  assert.match(out.scenarios.find(s => s.id === 'as-of-right').conditions.join(' '), /must meet a mapped MIH option even at the standard FAR/);
  const outside = entitlementScenarios({district: 'R9A', lotAreaSqft: 10000, mihArea: {inMihArea: false}});
  assert.match(outside.scenarios.find(s => s.id === 'universal-affordability-preference').conditions.join(' '), /outside every mapped Mandatory Inclusionary Housing area/);
});

test('the research host installer ships the parcel lookups module', () => {
  const installer = readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8');
  assert.match(installer, /\bnyc-zoning-lookups\.mjs\b/);
});

 test('blank PLUTO transit geography resolves from the published map with provenance, while boundary ambiguity stays unknown',async()=>{
 let queried;const inner=await transitZoneForPoint(40.7,-74,{request:async url=>{queried=new URL(url);return {features:[{attributes:{TranstZone:'Inner Transit Zone'}}]};}});
 assert.equal(inner.zone,'inner');assert.equal(inner.sourceUrl,TRANSIT_ZONES_URL);assert.equal(queried.searchParams.get('inSR'),'4326');assert.deepEqual(JSON.parse(queried.searchParams.get('geometry')),{x:-74,y:40.7});
 const boundary=await transitZoneForPoint(40.7,-74,{request:async()=>({features:[{attributes:{TranstZone:'Inner Transit Zone'}},{attributes:{TranstZone:'Outer Transit Zone'}}]})});assert.equal(boundary.zone,null);
});
