import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextLoader, parseFootprints, projector, orientedBox, chooseFrame, frameTransform, simplify, polygonArea} from './context.mjs';

const LAT = 40.708, LON = -74.0107, FOOT = 0.3048;
// Build a GeoJSON ring from local metres (x east, z south) around the subject.
const k = 111320, kx = k * Math.cos((LAT * Math.PI) / 180);
const toLonLat = ([x, z]) => [LON + x / kx, LAT - z / k];
const box = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2], [x1, z1]].map(toLonLat);
const row = (ring, extra = {}) => ({bin: '1000001', base_bbl: '1000470099', height_roof: '60', ground_elevation: '20', construction_year: '1925', the_geom: {type: 'MultiPolygon', coordinates: [[ring]]}, ...extra});

// Subject 20 m by 30 m at the origin, neighbours on its east, west and south lot lines, open
// street to the north and a taller building across it.
const block = [
  row(box(-10, -15, 10, 15), {bin: '1', base_bbl: '1000470001', height_roof: '85', construction_year: '1910'}),
  row(box(10, -15, 30, 15), {bin: '2', base_bbl: '1000470002', height_roof: '40'}),
  row(box(-30, -15, -10, 15), {bin: '3', base_bbl: '1000470003', height_roof: '120', ground_elevation: '24'}),
  row(box(-10, 15, 10, 40), {bin: '4', base_bbl: '1000470004', height_roof: '30'}),
  row(box(-20, -70, 20, -40), {bin: '5', base_bbl: '1000470005', height_roof: '300', construction_year: '1970'}),
];
const property = {bbl: '1000470001', latitude: String(LAT), longitude: String(LON), numfloors: '8', bldgarea: '48000', yearbuilt: '1910'};
const near = (a, b, tolerance = 0.25) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);

test('context caches evict outages, share successful loads and expire genuine empty results',async()=>{
  let footprints=0,parcels=0,fail=true,now=0;
  const loader=createContextLoader({now:()=>now,negativeTtlMs:30,request:async url=>{
    if(url.href.includes('i38t-6if2')){parcels++;if(fail)throw new Error('parcel outage');return [];}
    footprints++;if(fail)throw new Error('footprint outage');return block;
  }});
  const args={property,lot:[[0,0],[20,0],[20,30],[0,30]]};
  await assert.rejects(loader.load(args),/footprint outage/);fail=false;
  await Promise.all([loader.load(args),loader.load(args)]);
  assert.equal(footprints,2);assert.equal(parcels,3);
  await loader.load(args);assert.equal(parcels,3);
  now=31;await loader.load(args);assert.equal(parcels,5);assert.equal(footprints,2);
  let emptyCalls=0;
  const empty=createContextLoader({now:()=>now,negativeTtlMs:30,request:async()=>{emptyCalls++;return [];}});
  await empty.load(args);const first=emptyCalls;await empty.load(args);assert.equal(emptyCalls,first);
  now=62;await empty.load(args);assert.ok(emptyCalls>first);
});

test('places the block in the concept frame with the street side at z = 0 and north on the plan', async () => {
  const requests = [];
  const loader = createContextLoader({request: async url => { requests.push(url); return block; }});
  const lot = [[0, 0], [20, 0], [20, 30], [0, 30]];
  const {context, source} = await loader.load({property, lot, radiusMeters: 120});
  // Footprints plus the tax-lot lookup: exact BBL query, then the containing-lot fallback (these
  // stub rows carry no bbl field, so no parcel matches and framing uses the existing building).
  assert.equal(requests.length, 3);
  assert.match(requests[0].href, /5zhs-2jue\.json/);
  assert.match(requests[1].href, /i38t-6if2\.json/);
  assert.equal(context.parcel, undefined);
  assert.equal(context.frameBasis, 'existing-building');
  assert.match(decodeURIComponent(requests[0].search), /within_circle\(the_geom,[+ ]40\.708,[+ ]-74\.0107,[+ ]120\)/);
  assert.equal(context.radiusMeters, 120);
  assert.equal(context.existing.heightFeet, 85);
  assert.equal(context.existing.storeys, 8);
  assert.equal(context.existing.floorAreaSqft, 48000);
  assert.equal(context.existing.yearBuilt, 1910);
  near(context.existing.footprintSqft, 600 / (FOOT * FOOT), 40);
  assert.equal(context.buildings.length, 5);
  const [subject] = context.buildings;
  assert.equal(subject.existing, true);
  near(Math.min(...subject.polygon.map(p => p[0])), 0); near(Math.max(...subject.polygon.map(p => p[0])), 20);
  near(Math.min(...subject.polygon.map(p => p[1])), 0); near(Math.max(...subject.polygon.map(p => p[1])), 30);
  const by = Object.fromEntries(context.buildings.map(b => [b.bin, b]));
  near(Math.min(...by[2].polygon.map(p => p[0])), 20); near(Math.max(...by[2].polygon.map(p => p[0])), 40);
  near(Math.max(...by[3].polygon.map(p => p[0])), 0);
  near(Math.min(...by[4].polygon.map(p => p[1])), 30);
  assert.ok(Math.max(...by[5].polygon.map(p => p[1])) < 0, 'the building across the street sits in front of the lot');
  near(by[5].height, 300 * FOOT, 0.01);
  near(by[3].base, 4 * FOOT, 0.01);
  assert.equal(by[2].base, 0);
  assert.deepEqual(context.north, [0, -1]);
  assert.equal(context.bearingDeg, 180);
  assert.equal(source.title, 'NYC building footprints near the property');
  assert.equal(source.url, requests[0].href);
  const text = JSON.parse(source.text);
  assert.equal(text.buildings, 4);
  assert.equal(text.existing.heightFeet, 85);
  // A second load for the same place reuses the fetched rows.
  await loader.load({property, lot, radiusMeters: 120});
  assert.equal(requests.length, 3);
});

test('aligns a wide model lot to the long side and a vacant lot to the open direction', async () => {
  // The same block rotated: the street is east of the subject, so a frontage along the
  // subject's 30 m side runs north to south.
  const rotated = [
    row(box(-15, -10, 15, 10), {bin: '1', base_bbl: '1000470001', height_roof: '85'}),
    row(box(-15, 10, 15, 30), {bin: '2', base_bbl: '1000470002'}),
    row(box(-15, -30, 15, -10), {bin: '3', base_bbl: '1000470003'}),
    row(box(-40, -10, -15, 10), {bin: '4', base_bbl: '1000470004'}),
    row(box(45, -20, 75, 20), {bin: '5', base_bbl: '1000470005'}),
  ];
  const loader = createContextLoader({request: async () => rotated});
  const {context} = await loader.load({property, lot: [[0, 0], [100, 0], [100, 60], [0, 60]]});
  assert.equal(context.bearingDeg, 270);
  const by = Object.fromEntries(context.buildings.map(b => [b.bin, b]));
  assert.ok(Math.max(...by[5].polygon.map(p => p[1])) < 0);
  near(Math.min(...by[1].polygon.map(p => p[1])), 30 - 15); near(Math.max(...by[1].polygon.map(p => p[1])), 30 + 15);
  // Facing west from an eastern street, north runs along the negative x axis.
  assert.deepEqual(context.north, [-1, 0]);

  const vacant = createContextLoader({request: async () => rotated.slice(1)});
  const result = await vacant.load({property, lot: [[0, 0], [20, 0], [20, 30], [0, 30]]});
  assert.equal(result.context.existing, null);
  assert.equal(result.context.buildings.length, 4);
  assert.equal(result.context.bearingDeg, 270);
  assert.ok(result.context.buildings.every(b => !b.existing));
});

test('uses the published NYC fields and matches condo parcels through MapPLUTO BBL', async () => {
  const published = row(box(-10, -15, 10, 15), {bin: '1001026', base_bbl: '1000470001', mappluto_bbl: '1000477501', height_roof: '544', ground_elevation: '36', construction_year: '1915'});
  const loader = createContextLoader({request: async url => {
    assert.equal(url.searchParams.get('$select'), 'bin,base_bbl,mappluto_bbl,height_roof,ground_elevation,construction_year,the_geom');
    return [published, ...block.slice(1)];
  }});
  const {context} = await loader.load({property: {...property, bbl: '1000477501'}, lot: [[0,0],[20,0],[20,30],[0,30]]});
  assert.equal(context.existing.heightFeet, 544);
  assert.equal(context.existing.yearBuilt, 1915);
  assert.equal(context.buildings.find(b=>b.existing).bbl, '1000477501');
  assert.equal(context.buildings.filter(b=>b.existing).length, 1);
  const fallback = parseFootprints([{...published,mappluto_bbl:null}],projector(LAT,LON));
  assert.equal(fallback[0].bbl,'1000470001');
});

test('parses polygons and multipolygons, drops unusable rows and limits vertices', () => {
  const circle = Array.from({length: 200}, (_, i) => toLonLat([Math.cos((i / 200) * 2 * Math.PI) * 30, Math.sin((i / 200) * 2 * Math.PI) * 30]));
  const rows = [
    {bin: 7, base_bbl: 1000470007, height_roof: 50, the_geom: {type: 'Polygon', coordinates: [[...circle, circle[0]]]}},
    row(box(0, 0, 1, 1)),
    row(box(0, 0, 10, 10), {height_roof: '0'}),
    row(box(0, 0, 10, 10), {height_roof: 'tall'}),
    {height_roof: '20', the_geom: {type: 'Point', coordinates: [LON, LAT]}},
    {height_roof: '20', the_geom: {type: 'MultiPolygon', coordinates: [[[[LON, LAT], [LON, 'x']]]]}},
    null,
  ];
  const buildings = parseFootprints(rows, projector(LAT, LON));
  assert.equal(buildings.length, 1);
  assert.equal(buildings[0].bin, '7');
  assert.equal(buildings[0].bbl, '1000470007');
  assert.ok(buildings[0].polygon.length <= 48 && buildings[0].polygon.length >= 12);
  near(polygonArea(buildings[0].polygon), Math.PI * 900, 60);
  assert.equal(buildings[0].groundElevation, null);
  assert.equal(buildings[0].yearBuilt, null);
  assert.deepEqual(simplify([[0, 0], [1, 0.01], [2, 0]], 0.1), [[0, 0], [2, 0]]);
  const oriented = orientedBox([[0, 0], [4, 3], [-2, 11], [-6, 8]]);
  near(oriented.width * oriented.depth, 50, 0.01);
});

test('anchors the frame to the recorded tax lot and degrades when that lookup fails', async () => {
  // Tax lot 22 m by 32 m around the 20 m by 30 m existing building, street open to the north.
  const parcelRows = [{bbl: '1000470001', the_geom: {type: 'MultiPolygon', coordinates: [[box(-11, -16, 11, 16)]]}}];
  const loader = createContextLoader({request: async url => (url.href.includes('i38t-6if2') ? parcelRows : block)});
  const lot = [[0, 0], [20, 0], [20, 30], [0, 30]];
  const {context, source} = await loader.load({property, lot, radiusMeters: 120});
  assert.equal(context.frameBasis, 'tax-lot');
  assert.equal(context.bearingDeg, 180);
  assert.equal(context.parcel.bbl, '1000470001');
  assert.equal(context.parcel.sourceId, 'i38t-6if2');
  near(context.parcel.areaSqft, (22 * 32) / (FOOT * FOOT), 80);
  near(Math.min(...context.parcel.polygon.map(p => p[0])), -1);
  near(Math.max(...context.parcel.polygon.map(p => p[0])), 21);
  near(Math.min(...context.parcel.polygon.map(p => p[1])), -1);
  near(Math.max(...context.parcel.polygon.map(p => p[1])), 31);
  assert.equal(JSON.parse(source.text).parcel.dataset, 'i38t-6if2');
  // A failing tax-lot lookup must not lose the building context.
  const failing = createContextLoader({request: async url => { if (url.href.includes('i38t-6if2')) throw new Error('down'); return block; }});
  const degraded = await failing.load({property, lot, radiusMeters: 120});
  assert.equal(degraded.context.parcel, undefined);
  assert.equal(degraded.context.frameBasis, 'existing-building');
  assert.equal(degraded.context.buildings.length, 5);
  // Condo billing lots have no tax-map polygon: the containing recorded lot answers instead,
  // under its own BBL.
  const condo = createContextLoader({request: async url => {
    if (!url.href.includes('i38t-6if2')) return block;
    if (decodeURIComponent(url.search).includes('intersects')) return parcelRows;
    return [];
  }});
  const withCondo = await condo.load({property: {...property, bbl: '1000477501'}, lot, radiusMeters: 120});
  assert.equal(withCondo.context.frameBasis, 'tax-lot');
  assert.equal(withCondo.context.parcel.bbl, '1000470001');
});

test('returns nothing without coordinates and keeps the transform a rotation', async () => {
  const loader = createContextLoader({request: async () => block});
  assert.equal(await loader.load({property: {bbl: '1000470001'}, lot: [[0, 0], [1, 0], [1, 1]]}), null);
  assert.equal(await loader.load({property: {latitude: '95', longitude: '0'}, lot: [[0, 0], [1, 0], [1, 1]]}), null);
  const frame = chooseFrame({existing: [], others: [], lotWidth: 10, lotDepth: 20});
  const {toModel, north} = frameTransform({origin: [0, 0], into: frame.into}, [5, 10]);
  const [ax, az] = toModel([1, 0]), [bx, bz] = toModel([0, 1]);
  near((ax - 5) * (bz - 10) - (bx - 5) * (az - 10), 1, 1e-6);
  near(Math.hypot(...north), 1, 1e-3);
});
