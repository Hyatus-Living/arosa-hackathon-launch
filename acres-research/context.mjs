import {providerJson} from './public-http.mjs';
import {throwIfCancelled} from './execution-context.mjs';

// Neighbourhood context for concept models: the buildings around the subject parcel, from the
// NYC building footprints dataset, placed in the concept's own frame (x along the frontage,
// z into the lot, metres) so a massing reads as part of its block.
export const footprintDataset = 'https://data.cityofnewyork.us/resource/5zhs-2jue.json';
// NYC digital tax map lot polygons, keyed by BBL. The recorded tax lot anchors placement far
// better than the existing building's box; it is still not necessarily the zoning lot.
export const parcelDataset = 'https://data.cityofnewyork.us/resource/i38t-6if2.json';
const FOOT = 0.3048;
const MAX_BUILDINGS = 80, MAX_VERTICES = 48, MIN_AREA = 8, MAX_FETCH = 160;

const round = (n, d = 2) => Number(n.toFixed(d));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

export function polygonArea(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i], [x2, z2] = polygon[(i + 1) % polygon.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}
export function centroid(polygon) {
  let x = 0, z = 0, area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i], [x2, z2] = polygon[(i + 1) % polygon.length], cross = x1 * z2 - x2 * z1;
    x += (x1 + x2) * cross; z += (z1 + z2) * cross; area += cross;
  }
  if (Math.abs(area) < 1e-9) return [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];
  return [x / (3 * area), z / (3 * area)];
}
export function pointInPolygon([x, z], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segmentDistance(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a), len = dot(ab, ab);
  const t = len ? Math.max(0, Math.min(1, dot(ap, ab) / len)) : 0;
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}
export function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  let index = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance(points[i], points[0], points.at(-1));
    if (d > max) { max = d; index = i; }
  }
  if (max <= tolerance) return [points[0], points.at(-1)];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}
function cleanRing(ring) {
  const closed = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  let points = simplify([...closed, closed[0]], 0.4).slice(0, -1);
  for (let tolerance = 1; points.length > MAX_VERTICES && tolerance <= 8; tolerance *= 2) points = simplify([...points, points[0]], tolerance).slice(0, -1);
  return points.length > MAX_VERTICES ? points.filter((_, i) => i % Math.ceil(points.length / MAX_VERTICES) === 0) : points;
}

// Equirectangular projection around the subject: x east, z south, metres. With y up this is a
// right-handed frame in which a plan drawn with z downward has north at the top.
export function projector(lat0, lon0) {
  const k = 111320, kx = k * Math.cos((lat0 * Math.PI) / 180);
  return ([lon, lat]) => [(lon - lon0) * kx, -(lat - lat0) * k];
}
function rings(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates?.[0]];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).map(polygon => polygon?.[0]);
  return [];
}
const validRing = ring => Array.isArray(ring) && ring.length >= 4 && ring.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));

export function parseFootprints(rows, project) {
  const buildings = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const height = Number(row.height_roof) * FOOT;
    if (!Number.isFinite(height) || height <= 0) continue;
    for (const ring of rings(row.the_geom).filter(validRing)) {
      const polygon = cleanRing(ring.map(project));
      if (polygon.length < 3 || polygonArea(polygon) < MIN_AREA) continue;
      buildings.push({
        bin: typeof row.bin === 'string' || typeof row.bin === 'number' ? String(row.bin) : null,
        // MapPLUTO identifies condo tax lots such as 120 Broadway (7501); base_bbl
        // can instead identify the underlying lot (0001). Match the selected PLUTO row.
        bbl: /^\d{10}$/.test(String(row.mappluto_bbl)) ? String(row.mappluto_bbl) : /^\d{10}$/.test(String(row.base_bbl)) ? String(row.base_bbl) : null,
        polygon,
        height: Math.min(height, 600),
        groundElevation: Number.isFinite(Number(row.ground_elevation)) ? Number(row.ground_elevation) * FOOT : null,
        yearBuilt: Number.isFinite(Number(row.construction_year)) && Number(row.construction_year) > 1600 ? Number(row.construction_year) : null,
      });
    }
  }
  return buildings;
}

// Smallest-area rectangle around a polygon, tried at the orientation of each edge.
export function orientedBox(polygon) {
  let best = null;
  for (let i = 0; i < polygon.length; i++) {
    const edge = sub(polygon[(i + 1) % polygon.length], polygon[i]), len = Math.hypot(...edge);
    if (len < 1e-6) continue;
    const u = [edge[0] / len, edge[1] / len], v = [-u[1], u[0]];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of polygon) { const a = dot(p, u), b = dot(p, v); minU = Math.min(minU, a); maxU = Math.max(maxU, a); minV = Math.min(minV, b); maxV = Math.max(maxV, b); }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = {area, u, v, minU, maxU, minV, maxV};
  }
  if (!best) return null;
  const {u, v, minU, maxU, minV, maxV} = best;
  const corner = (a, b) => [u[0] * a + v[0] * b, u[1] * a + v[1] * b];
  const c = [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)];
  // Four sides, each with its outward normal and length.
  const sides = [
    {a: c[0], b: c[1], normal: [-v[0], -v[1]], length: maxU - minU},
    {a: c[1], b: c[2], normal: u, length: maxV - minV},
    {a: c[2], b: c[3], normal: v, length: maxU - minU},
    {a: c[3], b: c[0], normal: [-u[0], -u[1]], length: maxV - minV},
  ];
  return {center: corner((minU + maxU) / 2, (minV + maxV) / 2), sides, width: maxU - minU, depth: maxV - minV};
}

// How much open ground lies just beyond a side: the share of probe points, 4 to 22 m outside the
// side, that fall in no other building. Streets are open; neighbours on a lot line are not.
function openness(side, others) {
  let open = 0, total = 0;
  const along = sub(side.b, side.a);
  for (const t of [0.2, 0.4, 0.6, 0.8]) for (const out of [4, 10, 16, 22]) {
    const p = [side.a[0] + along[0] * t + side.normal[0] * out, side.a[1] + along[1] * t + side.normal[1] * out];
    total++;
    if (!others.some(b => pointInPolygon(p, b.polygon))) open++;
  }
  return total ? open / total : 0;
}

// Choose the frame: the lot's street side is the most open side of the existing building (or, on
// an empty lot, the most open direction from the parcel centroid); z runs from it into the lot.
export function chooseFrame({existing, others, lotWidth, lotDepth}) {
  if (existing.length) {
    const box = orientedBox(existing.flatMap(b => b.polygon));
    const best = streetSide(box, others, lotWidth, lotDepth);
    const n = best.side.normal;
    return {origin: box.center, into: [-n[0], -n[1]], confidence: best.score};
  }
  let best = null;
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI) / 6, normal = [Math.cos(angle), Math.sin(angle)];
    const side = {a: [-normal[1] * 8, normal[0] * 8], b: [normal[1] * 8, -normal[0] * 8], normal};
    const score = openness(side, others);
    if (!best || score > best.score) best = {score, normal};
  }
  return {origin: [0, 0], into: [-best.normal[0], -best.normal[1]], confidence: best.score};
}

// Map a world point into the concept frame: x along the frontage, z into the lot, with the
// subject's centre at the model lot's centre. A proper rotation, so the block is not mirrored.
export function frameTransform({origin, into}, lotCenter) {
  const ez = into, ex = [into[1], -into[0]];
  const toModel = p => { const d = sub(p, origin); return [round(dot(d, ex) + lotCenter[0]), round(dot(d, ez) + lotCenter[1])]; };
  // World north is -z (south is +z); express it in model coordinates for the plan's north arrow.
  const north = [-ex[1], -ez[1]];
  // Compass bearing of the direction from the street into the lot (x east, z south).
  const bearing = ((Math.atan2(into[0], -into[1]) * 180) / Math.PI + 360) % 360;
  return {toModel, north: north.map(n => round(n, 4)), bearingDeg: round(bearing, 1)};
}

// The street side of an oriented box: most open side wins, with a nudge toward the side whose
// length matches the model lot's aspect (wide lots front on their long side).
function streetSide(box, others, lotWidth, lotDepth) {
  const wide = lotWidth >= lotDepth;
  let best = null;
  for (const side of box.sides) {
    const matchesAspect = Math.abs(side.length - (wide ? Math.max(box.width, box.depth) : Math.min(box.width, box.depth))) < 1e-6;
    const score = openness(side, others) + (matchesAspect ? 0.2 : 0);
    if (!best || score > best.score) best = {score, side};
  }
  return best;
}

// Frame from the recorded tax-lot ring: its oriented box picks the street side, its centroid is
// the anchor. Returns null when the ring has no usable box.
export function chooseParcelFrame({parcel, others, lotWidth, lotDepth}) {
  const box = orientedBox(parcel);
  if (!box) return null;
  const best = streetSide(box, others, lotWidth, lotDepth);
  const n = best.side.normal;
  return {origin: centroid(parcel), into: [-n[0], -n[1]], confidence: best.score, basis: 'tax-lot'};
}

export function createContextLoader({request = providerJson,now=Date.now,negativeTtlMs=30000} = {}) {
  const cache = new Map();
  const parcelCache = new Map();
  async function fetchParcel(bbl, project, lat, lon) {
    if (!/^\d{10}$/.test(bbl)) return null;
    const key=`${bbl}:${lat}:${lon}`;
    if(parcelCache.get(key)?.expires<=now())parcelCache.delete(key);
    if (!parcelCache.has(key)) {
      const largestRing = (rows, onlyBbl) => {
        let best = null;
        for (const row of Array.isArray(rows) ? rows : []) {
          if (!row || (onlyBbl && String(row.bbl) !== onlyBbl) || !/^\d{10}$/.test(String(row.bbl))) continue;
          for (const ring of rings(row.the_geom).filter(validRing)) {
            const polygon = cleanRing(ring.map(project));
            if (polygon.length < 3) continue;
            const area = polygonArea(polygon);
            if (area >= MIN_AREA && (!best || area > best.area)) best = {polygon, area, bbl: String(row.bbl)};
          }
        }
        return best;
      };
      const lookup = async () => {
        const url = new URL(parcelDataset);
        url.searchParams.set('$select', 'bbl,the_geom');
        url.searchParams.set('bbl', bbl);
        url.searchParams.set('$limit', '5');
        const exact = largestRing(await request(url), bbl);
        throwIfCancelled();
        if (exact) return exact;
        // Condo billing lots (PLUTO lot 7501+) have no tax-map polygon of their own: fall back to
        // the recorded lot that contains the subject point, and report its BBL as found.
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const near = new URL(parcelDataset);
        near.searchParams.set('$select', 'bbl,the_geom');
        // within_circle returns nothing on this dataset; intersects does the point-in-lot test.
        near.searchParams.set('$where', `intersects(the_geom, 'POINT (${lon} ${lat})')`);
        near.searchParams.set('$limit', '20');
        const rows = await request(near);
        throwIfCancelled();
        let containing = null;
        for (const row of Array.isArray(rows) ? rows : []) {
          if (!row || !/^\d{10}$/.test(String(row.bbl))) continue;
          for (const ring of rings(row.the_geom).filter(validRing)) {
            const polygon = cleanRing(ring.map(project));
            if (polygon.length < 3 || !pointInPolygon([0, 0], polygon)) continue;
            const area = polygonArea(polygon);
            if (area >= MIN_AREA && (!containing || area < containing.area)) containing = {polygon, area, bbl: String(row.bbl)};
          }
        }
        return containing;
      };
      const entry={expires:Infinity};
      entry.promise=lookup().then(value=>{if(!value)entry.expires=now()+negativeTtlMs;return value;}).catch(()=>{
        if(parcelCache.get(key)===entry)parcelCache.delete(key);
        throwIfCancelled();return null;
      });
      parcelCache.set(key,entry);
    }
    return parcelCache.get(key).promise;
  }
  async function fetchFootprints(lat, lon, radiusMeters) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)},${radiusMeters}`;
    if(cache.get(key)?.expires<=now())cache.delete(key);
    if (!cache.has(key)) {
      const url = new URL(footprintDataset);
      url.searchParams.set('$select', 'bin,base_bbl,mappluto_bbl,height_roof,ground_elevation,construction_year,the_geom');
      url.searchParams.set('$where', `within_circle(the_geom, ${lat}, ${lon}, ${radiusMeters})`);
      url.searchParams.set('$limit', String(MAX_FETCH));
      const entry={expires:Infinity};
      entry.promise=request(url).then(rows => {throwIfCancelled();if(!rows.length)entry.expires=now()+negativeTtlMs;return {url:url.href,rows};}).catch(error=>{
        if(cache.get(key)===entry)cache.delete(key);throw error;
      });
      cache.set(key,entry);
    }
    return cache.get(key).promise;
  }
  // property: a PLUTO row with bbl, latitude, longitude and optional numfloors, bldgarea,
  // yearbuilt. lot: the concept's lot polygon in metres. Returns null when nothing is usable.
  async function load({property, lot, radiusMeters = 120}) {
    const lat = Number(property?.latitude), lon = Number(property?.longitude), bbl = String(property?.bbl || '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const radius = Math.max(50, Math.min(250, Number(radiusMeters) || 120));
    const project = projector(lat, lon);
    const [{url, rows}, parcel] = await Promise.all([fetchFootprints(lat, lon, radius), fetchParcel(bbl, project, lat, lon)]);
    throwIfCancelled();
    const buildings = parseFootprints(rows, project);
    const existing = buildings.filter(b => b.bbl && b.bbl === bbl);
    const others = buildings.filter(b => !existing.includes(b));
    const xs = lot.map(p => p[0]), zs = lot.map(p => p[1]);
    const lotWidth = Math.max(...xs) - Math.min(...xs), lotDepth = Math.max(...zs) - Math.min(...zs);
    // The recorded tax lot, when found, anchors the frame; otherwise fall back as before.
    const parcelFrame = parcel ? chooseParcelFrame({parcel: parcel.polygon, others, lotWidth, lotDepth}) : null;
    const frame = parcelFrame || chooseFrame({existing, others, lotWidth, lotDepth});
    const frameBasis = parcelFrame ? 'tax-lot' : existing.length ? 'existing-building' : 'open-direction';
    const {toModel, north, bearingDeg} = frameTransform(frame, centroid(lot));
    const datum = existing.find(b => b.groundElevation !== null)?.groundElevation ?? others.find(b => b.groundElevation !== null)?.groundElevation ?? 0;
    const place = b => ({
      bin: b.bin, bbl: b.bbl, polygon: b.polygon.map(toModel), height: round(b.height),
      base: b.groundElevation === null ? 0 : round(Math.max(-15, Math.min(15, b.groundElevation - datum))),
      yearBuilt: b.yearBuilt,
    });
    const nearest = others
      .map(b => ({b, distance: Math.hypot(...sub(centroid(b.polygon), frame.origin))}))
      .sort((p, q) => p.distance - q.distance)
      .slice(0, MAX_BUILDINGS)
      .map(({b}) => ({...place(b), existing: false}));
    const subject = existing.map(b => ({...place(b), existing: true}));
    const existingHeight = subject.length ? Math.max(...subject.map(b => b.height)) : null;
    const summary = subject.length ? {
      buildings: subject.length,
      heightFeet: round(existingHeight / FOOT, 0),
      footprintSqft: round(subject.reduce((s, b) => s + polygonArea(b.polygon), 0) / (FOOT * FOOT), 0),
      yearBuilt: subject.map(b => b.yearBuilt).find(Boolean) ?? (Number(property.yearbuilt) > 1600 ? Number(property.yearbuilt) : null),
      storeys: Number(property.numfloors) > 0 ? Number(property.numfloors) : null,
      floorAreaSqft: Number(property.bldgarea) > 0 ? Number(property.bldgarea) : null,
    } : null;
    const parcelOut = parcel ? {
      bbl: parcel.bbl, sourceId: 'i38t-6if2',
      areaSqft: round(parcel.area / (FOOT * FOOT), 0),
      polygon: parcel.polygon.map(toModel),
    } : null;
    return {
      source: {title: 'NYC building footprints near the property', url, text: JSON.stringify({bbl, radiusMeters: radius, buildings: nearest.length, existing: summary, parcel: parcelOut ? {bbl: parcelOut.bbl, areaSqft: parcelOut.areaSqft, dataset: parcelOut.sourceId, frameBasis} : null, neighbours: nearest.slice(0, 40).map(b => ({bbl: b.bbl, heightFeet: round(b.height / FOOT, 0), yearBuilt: b.yearBuilt}))})},
      context: {
        origin: {latitude: lat, longitude: lon}, radiusMeters: radius, north, bearingDeg, frameConfidence: round(frame.confidence), frameBasis,
        ...(parcelOut ? {parcel: parcelOut} : {}),
        // Enough to place any further geographic point in the concept frame: project it around the
        // origin (x east, z south, metres), then rotate about the subject's centre onto the lot's.
        frame: {origin: frame.origin.map(n => round(n)), into: frame.into.map(n => round(n, 4)), lotCenter: centroid(lot).map(n => round(n))},
        buildings: [...subject, ...nearest], existing: summary,
      },
    };
  }
  return {load};
}
