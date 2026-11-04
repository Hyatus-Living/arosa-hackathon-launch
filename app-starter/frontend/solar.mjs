// Schematic sun study math for the concept plan: solar position (NOAA approximation) and plan
// shadow polygons swept from building footprints. Pure functions, no DOM. Accuracy is about a
// degree — right for "which neighbours does the massing shade, roughly when", useless for a
// shadow-impact filing, and every surface using it says so.

const RAD = Math.PI / 180;

// Solar position for a UTC instant at (latitude, longitude), degrees. Azimuth is measured from
// true north, clockwise (east 90, south 180). Below-horizon sun returns altitude < 0.
export function solarPosition(dateUtc, latitude, longitude) {
  const start = Date.UTC(dateUtc.getUTCFullYear(), 0, 0);
  const doy = Math.floor((dateUtc - start) / 86400000);
  const hours = dateUtc.getUTCHours() + dateUtc.getUTCMinutes() / 60 + dateUtc.getUTCSeconds() / 3600;
  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (hours - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)); // minutes
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma); // radians
  const tst = (hours * 60 + eqtime + 4 * longitude) % 1440; // true solar time, minutes (UTC zone)
  let ha = tst / 4 <= 0 ? tst / 4 + 180 : tst / 4 - 180; // hour angle, degrees
  if (ha < -180) ha += 360;
  const lat = latitude * RAD, haRad = ha * RAD;
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(haRad);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  const altitude = 90 - zenith / RAD;
  const azimuth = ((Math.atan2(Math.sin(haRad), Math.cos(haRad) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / RAD) + 180 + 360) % 360;
  return {altitudeDeg: altitude, azimuthDeg: azimuth};
}

// Preset study moments (local solar framing, expressed as UTC for US Eastern). Labels state the
// local clock time; the offset follows US DST rules approximately via fixed seasonal offsets.
export const SUN_MOMENTS = [
  {id: 'jun-9', label: 'Jun 21 · 9 am', utc: '2026-06-21T13:00:00Z'},
  {id: 'jun-12', label: 'Jun 21 · noon', utc: '2026-06-21T16:00:00Z'},
  {id: 'jun-15', label: 'Jun 21 · 3 pm', utc: '2026-06-21T19:00:00Z'},
  {id: 'equ-9', label: 'Mar/Sep · 9 am', utc: '2026-09-22T13:00:00Z'},
  {id: 'equ-12', label: 'Mar/Sep · noon', utc: '2026-09-22T16:00:00Z'},
  {id: 'equ-15', label: 'Mar/Sep · 3 pm', utc: '2026-09-22T19:00:00Z'},
  {id: 'dec-9', label: 'Dec 21 · 9 am', utc: '2026-12-21T14:00:00Z'},
  {id: 'dec-12', label: 'Dec 21 · noon', utc: '2026-12-21T17:00:00Z'},
  {id: 'dec-15', label: 'Dec 21 · 3 pm', utc: '2026-12-21T20:00:00Z'},
];

// Shadow cast direction in a true-north plan frame (x east, z south): opposite the sun azimuth,
// scaled by height / tan(altitude). Returns null at night or for degenerate input.
export function shadowVector(heightM, altitudeDeg, azimuthDeg) {
  if (!(heightM > 0) || !(altitudeDeg > 0.5) || !Number.isFinite(azimuthDeg)) return null;
  const length = heightM / Math.tan(altitudeDeg * RAD);
  const az = azimuthDeg * RAD;
  // Sun direction (from sun toward ground origin) in (east, south): sun sits at azimuth, so the
  // shadow falls toward azimuth + 180: dx = -sin(az), dz = +cos(az) in x-east/z-south coords.
  return [-Math.sin(az) * length, Math.cos(az) * length];
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 1) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}

// Plan shadow of one footprint at one height: the footprint swept along the shadow vector
// (convex hull of footprint + translated footprint — exact for a prism's ground shadow union
// outline when the footprint is convex, a close overestimate otherwise; schematic by design).
export function shadowPolygon(footprint, heightM, altitudeDeg, azimuthDeg) {
  if (!Array.isArray(footprint) || footprint.length < 3) return null;
  const v = shadowVector(heightM, altitudeDeg, azimuthDeg);
  if (!v) return null;
  const moved = footprint.map(([x, z]) => [x + v[0], z + v[1]]);
  const hull = convexHull([...footprint, ...moved]);
  return hull.length >= 3 ? hull : null;
}

// Rotate a true-north shadow vector into a concept frame whose +z axis (into the lot) has the
// given compass bearing. Concept frame: x along frontage, z into lot; world: x east, z south.
// into-the-lot unit vector in world coords is (sin(bearing), -cos(bearing)) in (east, south)
// with z south positive... derived from frameTransform: world -> model uses ex=(into.z,-into.x)
// style rotation; here we express the world shadow vector in model axes directly.
export function shadowVectorInFrame(heightM, altitudeDeg, azimuthDeg, intoBearingDeg) {
  const world = shadowVector(heightM, altitudeDeg, azimuthDeg);
  if (!world) return null;
  if (!Number.isFinite(intoBearingDeg)) return world;
  const b = intoBearingDeg * RAD;
  // Matches context frameTransform: into = [sin B, -cos B] in world (east, south) coords
  // (bearing = atan2(into.x, -into.z)), ex = [into.z, -into.x], model = [d·ex, d·ez].
  const ez = [Math.sin(b), -Math.cos(b)];
  const ex = [ez[1], -ez[0]];
  return [world[0] * ex[0] + world[1] * ex[1], world[0] * ez[0] + world[1] * ez[1]];
}

export function shadowPolygonInFrame(footprint, heightM, altitudeDeg, azimuthDeg, intoBearingDeg) {
  if (!Array.isArray(footprint) || footprint.length < 3) return null;
  const v = shadowVectorInFrame(heightM, altitudeDeg, azimuthDeg, intoBearingDeg);
  if (!v) return null;
  const moved = footprint.map(([x, z]) => [x + v[0], z + v[1]]);
  const hull = convexHull([...footprint, ...moved]);
  return hull.length >= 3 ? hull : null;
}
