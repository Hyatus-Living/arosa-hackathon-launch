import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/concept-view.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function levelRuns(');
const end = source.indexOf('\n// Massing GLB', start);
assert.ok(start >= 0 && end > start);
const levelRuns = vm.runInNewContext(source.slice(start, end) + ';levelRuns');
const footprint = [[0, 0], [10, 0], [10, 10], [0, 10]];
const level = (base, height) => ({footprint, floorElevationFeet: base, heightFeet: height});
const spans = (levels) => Array.from(levelRuns(levels), (r) => [r.baseFeet, r.topFeet]);

test('concept exports preserve intentional gaps between identical floor plates', () => {
  assert.deepEqual(spans([level(0, 10), level(20, 10)]), [[0, 10], [20, 30]]);
});

test('overlapping source levels are not stretched into a fabricated taller volume', () => {
  assert.deepEqual(spans([level(0, 15), level(10, 10)]), [[0, 15], [10, 20]]);
});

test('touching identical plates still merge with their true source top elevation', () => {
  assert.deepEqual(spans([level(0, 10), level(10, 15)]), [[0, 25]]);
  const levels = [level(0, 10.1), level(10.10000001, 9.9)];
  const before = JSON.stringify(levels);
  const runs = spans(levels);
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0][1] - 20.00000001) < 1e-6);
  assert.equal(JSON.stringify(levels), before);
});
