import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMihOptions, normalizeMihArea, mihAreaAt, availableMihOptions} from './mih-areas.mjs';

const square = (west, south, size) => [[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]];
const row = (name, adopted, rings, extra = {}) => ({
  project_nam: name, date_adopte: `${adopted}T00:00:00.000`, boro: '3', cd: '9', mih_option: 'Option 1 and Option 2',
  the_geom: {type: 'MultiPolygon', coordinates: [rings]}, ...extra,
});

test('DCP option text maps to the ZR 27-131 options, including the Workforce Option as Option 4', () => {
  assert.deepEqual(parseMihOptions('Option1 and Option 3'), ['option1', 'option3']);
  assert.deepEqual(parseMihOptions('Option 1, Option 2, and Workforce Option'), ['option1', 'option2', 'option4']);
  assert.throws(() => parseMihOptions('Deep affordability'), /Unrecognized MIH option/);
});

test('a point is in an area inside its outer ring and outside its holes; overlapping areas take the latest adopted', () => {
  const areas = [
    row('Older rezoning', '2017-01-01', [square(-74, 40, 0.01), square(-73.996, 40.004, 0.002)]),
    row('Newer rezoning', '2022-06-30', [square(-73.992, 40.002, 0.004)], {mih_option: 'Option 3'}),
  ].map(normalizeMihArea);
  assert.equal(mihAreaAt(areas, 40.001, -73.999).name, 'Older rezoning');
  assert.equal(mihAreaAt(areas, 40.005, -73.995), null, 'inside the hole');
  assert.equal(mihAreaAt(areas, 40.02, -73.999), null);
  const newer = mihAreaAt(areas, 40.004, -73.9905);
  assert.deepEqual({...newer}, {name: 'Newer rezoning', projectId: null, ulurp: null, adopted: '2022-06-30', borough: '3', communityDistrict: 9, options: ['option3']});
});

test('Option 4 drops out in the Manhattan Core and ten years after the area was mapped', () => {
  const area = (borough, cd, adopted) => normalizeMihArea(row('x', adopted, [square(-74, 40, 0.01)], {boro: borough, cd: String(cd), mih_option: 'Option 1 and Workforce Option'}));
  const now = Date.parse('2026-10-18');
  assert.deepEqual(availableMihOptions(area('3', 9, '2024-11-21'), now), ['option1', 'option4']);
  assert.deepEqual(availableMihOptions(area('1', 8, '2024-11-21'), now), ['option1']);
  assert.deepEqual(availableMihOptions(area('1', 9, '2024-11-21'), now), ['option1', 'option4']);
  assert.deepEqual(availableMihOptions(area('3', 9, '2016-09-01'), now), ['option1']);
});
