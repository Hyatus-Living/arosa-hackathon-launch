import test from 'node:test';
import assert from 'node:assert/strict';
import {renderScene,validateRenderScene,hasConceptMassing,NYC_AFTERNOON_SUN} from './render-scene.mjs';

const FOOT = 0.3048;
const box = (w, d, x = 0, z = 0) => [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
// An envelope as acres_zoning_envelope returns it: feet, x along the frontage, z into the lot.
const envelope = ({storeys = 6, width = 50, depth = 80, groundUse = 'retail', streetFeet = 80} = {}) => ({
  lot: {polygon: box(width, 100), streets: [{side: 'front', widthFeet: streetFeet}]},
  storeys: Array.from({length: storeys}, (_, i) => ({footprint: box(width, depth), heightFeet: i ? 10 : 15, floorElevationFeet: i ? 15 + (i - 1) * 10 : 0, use: i ? 'residential' : groundUse})),
});
const scheme = (storeys, grossSqft) => ({id: 'max_bonus', label: 'Most floor area', program: {storeys, grossSqft}});
const area = ring => Math.abs(ring.reduce((s, [x1, z1], i) => { const [x2, z2] = ring[(i + 1) % ring.length]; return s + x1 * z2 - x2 * z1; }, 0)) / 2;
const context = {north: [0.6, -0.8], buildings: [
  {polygon: box(10, 10, 20, 0), height: 18, base: 0.4, existing: true},
  {polygon: box(12, 20, 16, 0), height: 21.3, base: 0, existing: false},
  {polygon: box(12, 20, -14, 0), height: 0, base: 0, existing: false},
]};

test('an envelope massing keeps the street wall and shortens storeys from the rear to the scheme\'s gross area', () => {
  const scene = validateRenderScene(renderScene({scheme: scheme(6, 12000), envelope: envelope(), context}));
  assert.equal(scene.volumes.length, 6);
  for (const v of scene.volumes) {
    assert.deepEqual([Math.min(...v.footprint.map(p => p[0])), Math.max(...v.footprint.map(p => p[0]))], [0, 15.24], 'full frontage');
    assert.equal(Math.min(...v.footprint.map(p => p[1])), 0, 'the street wall stays on the street line');
  }
  assert.ok(Math.abs(scene.floorAreaSqft - 12000) <= 2, `gross area ${scene.floorAreaSqft}`);
  assert.deepEqual(scene.volumes.map(v => v.use), ['retail', 'residential', 'residential', 'residential', 'residential', 'residential']);
  assert.deepEqual(scene.volumes.slice(0, 3).map(v => v.base), [0, 4.572, 7.62]);
  assert.equal(scene.streetWidthMeters, 24.4);
  assert.deepEqual(scene.sun, NYC_AFTERNOON_SUN);
  assert.deepEqual(scene.north, [0.6, -0.8]);
  // The existing building is replaced and a building with no height is dropped.
  assert.deepEqual(scene.context, [{footprint: box(12, 20, 16, 0), base: 0, height: 21.3}]);
});

test('an envelope massing never grows past the envelope, and extra storeys repeat its top storey', () => {
  const scene = renderScene({scheme: scheme(9, 1e6), envelope: envelope(), context: null});
  assert.equal(scene.volumes.length, 9);
  assert.deepEqual(scene.volumes.at(-1).footprint, scene.volumes[5].footprint);
  assert.ok(Math.abs(area(scene.volumes[0].footprint) - 50 * 80 * FOOT * FOOT) < 0.01);
  assert.deepEqual(scene.north, [0, -1], 'without context the street faces south');
  assert.equal(scene.context.length, 0);
  // A residential ground floor gets no storefront.
  assert.equal(renderScene({scheme: scheme(3, 9000), envelope: envelope({groundUse: 'residential'})}).volumes[0].use, 'residential');
});

test('a linked concept with storey footprints is drawn as modeled, in metres', () => {
  const concept = {lot: box(15, 30), levels: [
    {footprint: box(15, 22), floorElevationFeet: 0, heightFeet: 14, use: 'retail'},
    {footprint: box(15, 20), floorElevationFeet: 14, heightFeet: 10.5, use: 'residential'},
  ]};
  assert.equal(hasConceptMassing(concept), true);
  const scene = renderScene({scheme: scheme(6, 12000), concept, envelope: envelope(), context});
  assert.deepEqual(scene.volumes, [
    {footprint: box(15, 22), base: 0, height: 4.267, use: 'retail'},
    {footprint: box(15, 20), base: 4.267, height: 3.2, use: 'residential'},
  ]);
  assert.deepEqual(scene.lot, box(15, 30));
  // An older concept without footprints falls back to the envelope.
  const older = {levels: [{floorElevationFeet: 0, heightFeet: 14, use: 'commercial'}]};
  assert.equal(hasConceptMassing(older), false);
  assert.equal(renderScene({scheme: scheme(6, 12000), concept: older, envelope: envelope()}).volumes.length, 6);
});

test('a scheme with no massing is refused, and malformed scenes fail validation', () => {
  assert.throws(() => renderScene({scheme: scheme(6, 12000)}), e => e.status === 409 && /no massing/.test(e.message));
  const good = renderScene({scheme: scheme(2, 6000), envelope: envelope({storeys: 2})});
  for (const broken of [{...good, schema: 'other'}, {...good, volumes: []}, {...good, volumes: [{...good.volumes[0], height: -1}]},
    {...good, volumes: [{...good.volumes[0], use: 'office'}]}, {...good, north: [0, 0]}, {...good, context: Array(81).fill(good.volumes[0])},
    {...good, lot: [[0, 0], [1, 1]]}, {...good, streetWidthMeters: 0}]) {
    assert.throws(() => validateRenderScene(broken), e => e.status === 409);
  }
});
