import assert from 'node:assert/strict';
import test from 'node:test';
import {solarPosition, shadowVector, shadowVectorInFrame, shadowPolygon, SUN_MOMENTS} from '../frontend/solar.mjs';

const NYC = [40.7128, -74.0060];
const near = (a, b, t) => assert.ok(Math.abs(a - b) <= t, `${a} not within ${t} of ${b}`);

test('solar position matches known NYC values within schematic tolerance', () => {
  // December solstice, noon EST: max altitude 90 - 40.71 - 23.44 ≈ 25.9, sun due south-ish.
  const dec = solarPosition(new Date('2026-12-21T17:00:00Z'), ...NYC);
  near(dec.altitudeDeg, 25.9, 1.5);
  near(dec.azimuthDeg, 180, 8);
  // June solstice mid-morning EDT: sun in the east, already high.
  const jun9 = solarPosition(new Date('2026-06-21T13:00:00Z'), ...NYC);
  near(jun9.azimuthDeg, 90, 12);
  assert.ok(jun9.altitudeDeg > 30 && jun9.altitudeDeg < 48);
  // Night: altitude below the horizon, and no shadow.
  const night = solarPosition(new Date('2026-06-21T05:00:00Z'), ...NYC);
  assert.ok(night.altitudeDeg < 0);
  assert.equal(shadowVector(30, night.altitudeDeg, night.azimuthDeg), null);
  assert.equal(SUN_MOMENTS.length, 9);
  for (const m of SUN_MOMENTS) {
    const p = solarPosition(new Date(m.utc), ...NYC);
    assert.ok(p.altitudeDeg > 2, `${m.id} sun is up (${p.altitudeDeg})`);
  }
});

test('shadows fall opposite the sun with length height / tan(altitude)', () => {
  // Noon sun due south at 45°: a 10 m wall casts 10 m due north (world z south-positive => -z).
  const v = shadowVector(10, 45, 180);
  near(v[0], 0, 1e-9); near(v[1], -10, 1e-9);
  // Morning sun in the east: shadow points west (-x).
  const east = shadowVector(10, 45, 90);
  near(east[0], -10, 1e-9); near(east[1], 0, 1e-9);
  const hull = shadowPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 10, 45, 180);
  near(Math.min(...hull.map(p => p[1])), -10, 1e-6);
  near(Math.max(...hull.map(p => p[1])), 10, 1e-6);
  assert.equal(shadowPolygon([[0, 0], [1, 1]], 10, 45, 180), null);
  assert.equal(shadowPolygon([[0, 0], [10, 0], [10, 10]], 0, 45, 180), null);
});

test('frame rotation matches the concept frame bearing convention', () => {
  // Lot extends south from its street (into bearing 180): noon shadow (due north in the world)
  // falls toward the street, i.e. negative model z. Flip the lot (bearing 0) and it reverses.
  const south = shadowVectorInFrame(30, 72, 180, 180);
  near(south[0], 0, 1e-9); assert.ok(south[1] < 0);
  const north = shadowVectorInFrame(30, 72, 180, 0);
  near(north[1], -south[1], 1e-9);
  // Rotation preserves length.
  near(Math.hypot(...north), Math.hypot(...shadowVector(30, 72, 180)), 1e-9);
  // Unknown bearing leaves the world vector untouched rather than guessing.
  assert.deepEqual(shadowVectorInFrame(30, 72, 180, null), shadowVector(30, 72, 180));
});
