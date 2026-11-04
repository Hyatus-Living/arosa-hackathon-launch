// The as-of-right zoning envelope as geometry: per-storey footprint polygons with heights, built from
// the lot outline, the streets it fronts and the curated bulk rules in zoning-rules.json. Pure
// functions; the caller supplies the rules table and a lot in feet, x along the front street and z
// into the lot with the street at z = 0. Every computed figure names the Zoning Resolution section
// it rests on, and the curated figures are starting points to verify, never a determination.
const round = (n, d = 1) => Number(n.toFixed(d));
const MAX_STOREYS = 60;
const EPS = 1e-6;

export function polygonArea(polygon) {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i], [x2, z2] = polygon[(i + 1) % polygon.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}

export function bounds(polygon) {
  const xs = polygon.map(p => p[0]), zs = polygon.map(p => p[1]);
  return {minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs)};
}

// Sutherland-Hodgman clip against one axis-aligned line: keep the part at or below `limit` on
// `axis` (0 = x, 1 = z), or at or above it when keepAbove is set.
function clip(polygon, axis, limit, keepAbove = false) {
  const inside = p => keepAbove ? p[axis] >= limit - EPS : p[axis] <= limit + EPS;
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (limit - a[axis]) / (b[axis] - a[axis]);
      const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      p[axis] = limit;
      out.push(p);
    }
  }
  return out.length >= 3 ? normalize(out) : [];
}

// Start the ring at the vertex nearest the street (minimum z, then minimum x) so equal footprints compare equal.
function normalize(polygon) {
  let start = 0;
  for (let i = 1; i < polygon.length; i++) if (polygon[i][1] < polygon[start][1] - EPS || (Math.abs(polygon[i][1] - polygon[start][1]) <= EPS && polygon[i][0] < polygon[start][0])) start = i;
  return [...polygon.slice(start), ...polygon.slice(0, start)];
}

// Two pieces of one polygon, cut apart along an axis line, joined back into one ring: each piece's
// chain off the line, end to end. The second piece must meet the line within the first's stretch of
// it; a piece that meets the line in more than one stretch is not joined (null).
function joinAcross(a, b, axis, value) {
  const on = p => Math.abs(p[axis] - value) <= 1e-6;
  const chain = ring => {
    const n = ring.length, starts = [];
    for (let i = 0; i < n; i++) if (on(ring[i]) && !on(ring[(i + 1) % n])) starts.push(i);
    if (starts.length !== 1) return null;
    const out = [];
    for (let k = 0, i = starts[0]; k <= n; k++, i = (i + 1) % n) { out.push(ring[i]); if (k > 0 && on(ring[i])) break; }
    return out;
  };
  const ca = chain(a), cb = chain(b);
  if (!ca || !cb) return null;
  const ring = [...ca, ...cb];
  // Drop repeated and collinear vertices so a further piece can join along the same line.
  const kept = ring.filter((p, i) => {
    const prev = ring[(i - 1 + ring.length) % ring.length], next = ring[(i + 1) % ring.length];
    return Math.abs((p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0])) > 1e-6;
  });
  return Math.abs(polygonArea(kept) - polygonArea(a) - polygonArea(b)) < 1e-3 * Math.max(1, polygonArea(a)) ? normalize(kept) : null;
}

const mergeIntervals = list => [...list].sort((p, q) => p[0] - q[0]).reduce((out, [lo, hi]) => {
  if (out.length && lo <= out.at(-1)[1] + EPS) out.at(-1)[1] = Math.max(out.at(-1)[1], hi); else out.push([lo, hi]);
  return out;
}, []);

// Set the footprint back from the lot edges: front is the street at minimum z, rear the maximum z,
// left and right the minimum and maximum x.
export function inset(polygon, {front = 0, rear = 0, left = 0, right = 0} = {}) {
  const {minX, maxX, minZ, maxZ} = bounds(polygon);
  let out = polygon;
  if (front > 0) out = clip(out, 1, minZ + front, true);
  if (rear > 0 && out.length) out = clip(out, 1, maxZ - rear);
  if (left > 0 && out.length) out = clip(out, 0, minX + left, true);
  if (right > 0 && out.length) out = clip(out, 0, maxX - right);
  return out;
}

// Trim the footprint from the rear until its area is at most maxArea, keeping the street side.
export function clipToArea(polygon, maxArea) {
  if (polygon.length < 3 || polygonArea(polygon) <= maxArea + EPS) return polygon;
  const {minZ, maxZ} = bounds(polygon);
  let lo = minZ, hi = maxZ;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (polygonArea(clip(polygon, 1, mid)) > maxArea) hi = mid; else lo = mid;
  }
  return clip(polygon, 1, lo);
}

// Shrink the footprint's bounding box in proportion until its diagonal is at most maxDimension,
// keeping the street side and centring across the frontage.
export function clipToDimension(polygon, maxDimension) {
  if (polygon.length < 3) return polygon;
  const {minX, maxX, minZ, maxZ} = bounds(polygon);
  const width = maxX - minX, depth = maxZ - minZ, diagonal = Math.hypot(width, depth);
  if (diagonal <= maxDimension + EPS) return polygon;
  const scale = maxDimension / diagonal, centre = (minX + maxX) / 2;
  let out = clip(polygon, 1, minZ + depth * scale);
  out = clip(out, 0, centre - width * scale / 2, true);
  return clip(out, 0, centre + width * scale / 2);
}

export function describeStreets(frontages, rules) {
  const minimum = rules.bulk.streets.wideStreetMinimumWidthFeet;
  const streets = (frontages && frontages.length ? frontages : [{side: 'front'}]).map(f => {
    const width = Number.isFinite(f.widthFeet) ? f.widthFeet : null;
    return {side: f.side, name: f.name ?? null, widthFeet: width, wide: width !== null && width >= minimum, assumedNarrow: width === null, streetWallType: f.streetWallType ?? null};
  });
  const sides = new Set(streets.map(s => s.side));
  const lotType = sides.size === 4 ? 'block' : sides.has('front') && sides.has('rear') && sides.size === 2 ? 'through' : sides.size >= 2 ? 'corner' : 'interior';
  return {streets, lotType, bySide: Object.fromEntries(streets.map(s => [s.side, s]))};
}

// ZR 23-342: an interior lot less than 95 ft deep (a depth it already had on December 15, 1961) may
// reduce each required rear yard by six inches per foot short of 95 ft, never below 10 ft.
export function shallowLotRearYardFeet(requiredFeet, lotDepthFeet, rules) {
  const shallow = rules.bulk.residentialCommon.shallowLot;
  if (!(lotDepthFeet < shallow.maxDepthFeet) || requiredFeet <= shallow.minimumFeet) return requiredFeet;
  return Math.max(shallow.minimumFeet, requiredFeet - (shallow.maxDepthFeet - lotDepthFeet) * shallow.reductionPerFootFeet);
}

// ZR 23-738: in the listed districts a sky exposure plane building whose street walls are under 45 ft wide in
// all rises no higher than the street it faces is wide (a corner lot: the narrowest street when every street is
// narrow, otherwise the widest), and never above 100 ft. The section belongs to ZR 23-73, the optional
// provisions for sky exposure plane buildings (ZR 23-731), so standard, tower and eligible-site buildings keep
// their ZR 23-43 heights and only the sky exposure plane form is limited.
// The district ZR 23-738 is tested against: an R district's own code (R7-1 borrows the R7-2 bulk row but
// is not one of the districts the section names), a commercial district's residential equivalent.
const narrowBuildingCode = district => (district.kind === 'residential' ? district.code : district.residentialEquivalent);

function narrowBuildingLimit({equivalentCode, equivalent, streets, lotType, lotWidth, lotDepth, rules}) {
  const rule = rules.bulk.residentialCommon.narrowBuilding;
  if (!equivalent.skyExposurePlane || !rule.districts.includes(equivalentCode)) return null;
  const streetWallWidthFeet = streets.reduce((sum, s) => sum + (s.side === 'front' || s.side === 'rear' ? lotWidth : lotDepth), 0);
  if (streetWallWidthFeet >= rule.maxStreetWallWidthFeet) return null;
  const widths = streets.map(s => s.widthFeet ?? rule.assumedNarrowStreetWidthFeet);
  const streetWidth = lotType === 'corner' && streets.some(s => s.wide) ? Math.max(...widths) : Math.min(...widths);
  return {streetWallWidthFeet: round(streetWallWidthFeet), streetWidthFeet: streetWidth, maxHeightFeet: Math.min(rule.maxHeightFeet, streetWidth), assumedStreetWidth: streets.some(s => s.widthFeet === null), sections: rule.citations};
}

function smallLotCoverage(table, lotArea) {
  for (const [maxArea, percent] of table.smallLotCoverage) if (lotArea <= maxArea) return percent;
  return table.maxCoveragePercent;
}

function groupLevels(storeys) {
  const levels = [];
  for (const storey of storeys) {
    const last = levels[levels.length - 1];
    const key = JSON.stringify([storey.footprint, storey.heightFeet, storey.use]);
    if (last && last.key === key) { last.count += 1; continue; }
    levels.push({key, label: storey.label, use: storey.use, footprint: storey.footprint, height: storey.heightFeet, count: 1});
  }
  return levels.map(({key, ...level}) => ({...level, label: level.count > 1 ? `${level.label} (x${level.count})` : level.label}));
}

import {unitThreshold485x} from './tax-485x.mjs';

// Maximum dwelling units from the residential floor area permitted on the lot: no factor in the special density areas
// (Manhattan Core, Special Downtown Brooklyn District), 680 elsewhere, three-quarters rounds up.
export function dwellingUnits({residentialFloorAreaSqft, specialDensityArea, rules}) {
  const density = rules.bulk.density;
  if (specialDensityArea) return {maxUnits: null, dwellingUnitFactor: null, sections: density.citations, note: 'No dwelling unit factor applies in the special density areas (Manhattan Core and the Special Downtown Brooklyn District); unit count is set by floor area, the building code and the market.'};
  const quotient = residentialFloorAreaSqft / density.dwellingUnitFactor;
  const units = Math.floor(quotient) + (quotient - Math.floor(quotient) >= density.roundUpFraction ? 1 : 0);
  const note = ['The maximum residential floor area permitted on the zoning lot divided by the dwelling unit factor (ZR 23-52); fractions of three-quarters or more count as a unit.', unitThreshold485x(units)].filter(Boolean).join(' ');
  return {maxUnits: units, dwellingUnitFactor: density.dwellingUnitFactor, residentialFloorAreaSqft: round(residentialFloorAreaSqft, 0), sections: density.citations, note};
}

function transitZoneRow(zone, districtCode) {
  return zone?.rows?.find(row => row.districts.includes(districtCode)) ?? null;
}

// Required residential spaces in one transit zone (ZR 25-211, 25-222, 25-232). Spaces are
// whole numbers, so fractional results round up before the Column C waiver comparison.
function transitZoneParking(zoneName, zones, districtCode, units, lotAreaSqft) {
  if (zoneName === 'inner') return {zone: 'inner', required: 0, sections: zones.inner.citations, note: zones.inner.note};
  const zone = zones[zoneName];
  const row = transitZoneRow(zone, districtCode);
  if (!row) return {zone: zoneName, required: null, sections: zone.citations, note: `No ${zoneName} transit zone row is curated for ${districtCode}.`};
  let percent = row.standardPercent, waived = false, adjusted = null;
  if (Number.isFinite(lotAreaSqft)) {
    if (zoneName === 'outer' && zone.smallLotWaiver.districts.includes(districtCode) && lotAreaSqft <= zone.smallLotWaiver.maxLotAreaSqft) { waived = true; adjusted = 'small-lot waiver'; }
    if (row.smallLotWaived && lotAreaSqft <= 10000) { waived = true; adjusted = 'small-lot waiver'; }
    else if (row.midLotStandardPercent && lotAreaSqft > 10000 && lotAreaSqft <= 15000) { percent = row.midLotStandardPercent; adjusted = 'mid-lot reduction'; }
    else if (row.smallLotStandardPercent && lotAreaSqft <= 10000) { percent = row.smallLotStandardPercent; adjusted = 'small-lot reduction'; }
  }
  const computed = Number.isFinite(units) ? Math.ceil(units * percent / 100) : null;
  const waiverApplied = !waived && computed !== null && computed <= row.waiverSpaces;
  return {
    zone: zoneName, required: waived || waiverApplied ? 0 : computed, standardPercent: percent,
    ...(zoneName === 'outer' ? {reducedPercent: row.reducedPercent} : {affordablePercent: row.affordablePercent, seniorPercent: row.seniorPercent, ancillaryPercent: row.ancillaryPercent}),
    waiverSpaces: row.waiverSpaces, waived: waived || waiverApplied, ...(adjusted ? {adjustment: adjusted} : {}),
    sections: zone.citations,
  };
}

// The lot's parking area from PLUTO's transitzone field (the city's Greater Transit Zone map applied
// to the tax lot). Special 25-241 lots lie in the Outer Transit Zone but take the requirements beyond
// the Greater Transit Zone for standard residences; the Long Island City area requires none (ZR 16-10).
const PLUTO_TRANSIT_ZONES = {'inner transit zone': 'inner', 'outer transit zone': 'outer', 'beyond the greater transit zone': 'beyond', 'special 25-241 parking provisions': 'special-25-241', 'manhattan core and long island city parking areas': 'core-or-lic'};
export function transitZoneOf(property) {
  return PLUTO_TRANSIT_ZONES[String(property?.transitzone ?? '').trim().toLowerCase()] ?? null;
}

// Parking requirement and as-of-right maximum. Manhattan Core plus the transit zones. transitZone is
// inner, outer or beyond (or the PLUTO areas above); source says where it came from.
export function parking({communityDistrict, dwellingUnits: units, nonResidentialFloorAreaSqft = 0, retailFloorAreaSqft = 0, districtCode = null, lotAreaSqft = null, transitZone = null, transitZoneSource = null, rules}) {
  const core = rules.bulk.parking.manhattanCore;
  const cd = communityDistrict === null || communityDistrict === undefined ? null : String(communityDistrict).padStart(3, '0');
  const zones = rules.bulk.parking.transitZones;
  if (!cd || !core.communityDistricts.includes(cd)) {
    if (transitZone === 'core-or-lic') return {required: 0, transitZone: 'lic', transitZoneSource, communityDistrict: cd, sections: ['ZR 16-10'], note: 'Long Island City area: no accessory parking is required (ZR 16-10).'};
    if (districtCode && zones) {
      const all = {inner: transitZoneParking('inner', zones, districtCode, units, lotAreaSqft), outer: transitZoneParking('outer', zones, districtCode, units, lotAreaSqft), beyond: transitZoneParking('beyond', zones, districtCode, units, lotAreaSqft)};
      const sections = [...zones.inner.citations, ...zones.outer.citations, ...zones.beyond.citations];
      const from = transitZoneSource ? ` (${transitZoneSource})` : '';
      if (transitZone === 'special-25-241') return {...all.beyond, transitZone, transitZoneSource, communityDistrict: cd, sections: [...all.beyond.sections, 'ZR 25-241'], note: `Outer Transit Zone area under ZR 25-241${from}: standard residences take the requirements beyond the Greater Transit Zone; qualifying affordable or senior housing keeps the Outer Transit Zone figures.`};
      if (transitZone && all[transitZone]) return {...all[transitZone], transitZone, transitZoneSource, communityDistrict: cd, sections, note: transitZoneSource ? `Computed for the ${transitZone} transit zone${from}.` : `Computed for the ${transitZone} transit zone as requested; confirm the lot's zone on the Greater Transit Zone map.`};
      return {required: null, communityDistrict: cd, transitZones: all, sections, note: 'Outside the Manhattan Core the requirement depends on the transit zone (Inner, Outer, or beyond the Greater Transit Zone); all three outcomes are reported; pass transitZone once the lot is located on the Greater Transit Zone map.'};
    }
    if (!cd) return {required: null, sections: core.citations, note: 'The property has no community district, so the Manhattan Core test could not be made.'};
    return {required: null, communityDistrict: cd, sections: core.citations, note: 'Outside the Manhattan Core; requirements and transit-zone waivers there are not encoded for this district.'};
  }
  const percent = cd <= '106' ? core.residentialMaxPercentOfNewUnits['101-106'] : core.residentialMaxPercentOfNewUnits['107-108'];
  const maxRetailSpaces = Math.min(core.retailMaxSpaces, Math.floor(retailFloorAreaSqft / core.nonResidentialSqftPerSpace));
  const maxOtherNonResidentialSpaces = Math.min(core.nonResidentialMaxSpaces, Math.floor(Math.max(0, nonResidentialFloorAreaSqft - retailFloorAreaSqft) / core.nonResidentialSqftPerSpace));
  return {
    required: core.requiredSpaces, communityDistrict: cd, manhattanCore: true,
    maxResidentialSpaces: Number.isFinite(units) ? Math.min(core.residentialMaxSpaces, Math.floor(units * percent / 100)) : null, residentialMaxPercentOfNewUnits: percent,
    maxRetailSpaces, maxOtherNonResidentialSpaces, maxNonResidentialSpaces: maxRetailSpaces + maxOtherNonResidentialSpaces,
    sections: core.citations, note: 'No parking is required in the Manhattan Core; accessory parking is capped as of right and anything more needs a special permit.',
  };
}

// Storeys the floor area did not need, up to the height limit (at most RESERVE_STOREYS), for the planning
// engine to draw when exact yards on the lot polygon hold less than these axis-aligned footprints; the
// option's storey count then follows the stack it draws (planning/outlines.py storey_outlines).
const RESERVE_STOREYS = 6;
function reserveAbove(storeys, stoppedBy, height, maxHeight, footprintAt, use) {
  const out = [];
  if (!String(stoppedBy).startsWith('floor area ratio')) return out;
  let bottom = storeys.at(-1).topFeet;
  for (let i = storeys.length; out.length < RESERVE_STOREYS; i++) {
    const top = bottom + height;
    if (maxHeight !== null && top > maxHeight + EPS) break;
    const {polygon, applied, shaped} = footprintAt({index: i, bottom, top});
    if (polygonArea(polygon) < 1) break;
    out.push({level: i + 1, label: `Level ${i + 1}`, use, footprint: polygon.map(p => [round(p[0]), round(p[1])]), heightFeet: height, floorElevationFeet: round(bottom), topFeet: round(top), areaSqft: round(polygonArea(polygon), 0), controls: applied, shapedBy: shaped, reserve: true});
    bottom = top;
  }
  return out;
}

const inside = ([x, z], ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

// The district cells of a split lot on this axis-aligned frame: the lot is sampled, each sample
// assigned the mapped district holding it, and the lot cut across x or z, whichever separates the
// districts with fewer misplaced samples, at the cut that misplaces fewest. Each district keeps one
// band; the planning engine draws the true boundary from the mapped polygons.
function districtCells(lot, portions) {
  const {minX, maxX, minZ, maxZ} = bounds(lot), n = 40, samples = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = [minX + (maxX - minX) * (i + 0.5) / n, minZ + (maxZ - minZ) * (j + 0.5) / n];
    if (!inside(p, lot)) continue;
    const d = portions.findIndex(q => q.parts.some(part => inside(p, part.exterior) && !part.holes.some(h => inside(p, h))));
    if (d >= 0) samples.push({p, d});
  }
  const fit = axis => {
    const mean = d => { const own = samples.filter(s => s.d === d); return own.length ? own.reduce((sum, s) => sum + s.p[axis], 0) / own.length : Infinity; };
    const order = portions.map((_, d) => d).sort((a, b) => mean(a) - mean(b));
    const cuts = [], [lo, hi] = axis === 0 ? [minX, maxX] : [minZ, maxZ];
    let misplaced = 0;
    for (let k = 0; k < order.length - 1; k++) {
      const left = order.slice(0, k + 1), candidates = [...new Set(samples.map(s => s.p[axis]))].sort((a, b) => a - b);
      const cost = t => samples.filter(s => (left.includes(s.d)) !== (s.p[axis] <= t)).length;
      const best = candidates.reduce((b, t) => (cost(t) < cost(b) ? t : b), candidates[0]);
      const at = (best + (candidates.find(c => c > best) ?? best)) / 2;
      cuts.push(Math.max(cuts.at(-1) ?? lo, at));
      misplaced = Math.max(misplaced, cost(best));
    }
    const edges = [lo, ...cuts, hi];
    return {axis, misplaced, cells: order.map((d, k) => ({d, lo: edges[k], hi: edges[k + 1]})).filter(c => c.hi > c.lo + EPS)};
  };
  const [x, z] = [fit(0), fit(1)];
  return x.misplaced <= z.misplaced ? x : z;
}

// A zoning lot divided by district boundaries (ZR 23-04, Article VII Chapter 7): each portion keeps
// its own district's yards, heights and setbacks (ZR 77-27, 77-28), so each district's envelope is
// drawn on the whole lot and kept within its portion; the floor area ratio is the area-weighted
// sum (ZR 77-22) and may be placed anywhere, the dwelling units are the sum of the portions' (ZR 77-25).
function splitEnvelope({districtPortions, ...args}) {
  const {rules, lot, maxFar} = args;
  const taxMapArea = polygonArea(lot), lotArea = args.recordedLotAreaSqft > 0 ? args.recordedLotAreaSqft : taxMapArea;
  const primary = districtPortions[0].district;
  const heights = {ground: args.storeyHeightsFeet?.ground ?? (primary.kind === 'residential' ? 10.5 : 15), typical: args.storeyHeightsFeet?.typical ?? ((args.use ?? (primary.kind === 'residential' ? 'residential' : 'commercial')) === 'residential' ? 10.5 : 12.5)};
  const total = districtPortions.reduce((sum, p) => sum + p.sharePercent, 0);
  const shares = districtPortions.map(p => p.sharePercent / total);
  const tables = districtPortions.map(p => computeEnvelope({...args, district: p.district, maxFar: undefined, storeyHeightsFeet: heights}));
  // Drawn with an unbounded floor area ratio, so each holds every storey its geometry and heights allow.
  const shapes = districtPortions.map(p => computeEnvelope({...args, district: p.district, maxFar: 60, storeyHeightsFeet: heights}));
  const adjustedFar = round(tables.reduce((sum, t, i) => sum + t.floorArea.maxFar * shares[i], 0), 3);
  const far = Number.isFinite(maxFar) ? maxFar : adjustedFar;
  const maxFloorArea = far * lotArea;
  const {axis, cells} = districtCells(lot, districtPortions);
  // One portion per district, or per district and wide-street portion where a district has those.
  const flat = shapes.flatMap((e, d) => (e.controls.portions ?? [null]).map(inner => ({d, inner})));
  const indexOf = (d, inner) => flat.findIndex(f => f.d === d && (f.inner?.index ?? null) === (inner ?? null));
  // Storey i: each district's footprint at that storey kept within its cell and the cells joined.
  const storeyAt = i => {
    const present = cells.filter(c => shapes[c.d].storeys[i] && !shapes[c.d].storeys[i].partial);
    if (!present.length) return null;
    const pieces = present.map(c => ({c, polygon: clip(clip(shapes[c.d].storeys[i].footprint, axis, c.lo, true), axis, c.hi)})).filter(p => p.polygon.length >= 3);
    const polygon = pieces.reduce((acc, p) => (acc.length < 3 ? p.polygon : joinAcross(acc, p.polygon, axis, p.c.lo) ?? (polygonArea(p.polygon) > polygonArea(acc) ? p.polygon : acc)), []);
    const ds = [...new Set(present.map(c => c.d))];
    return {polygon, first: shapes[ds[0]].storeys[i],
      shaped: ds.flatMap(d => shapes[d].storeys[i].shapedBy.map(c => ({...c, portion: indexOf(d, c.portion)}))),
      applied: ds.flatMap(d => shapes[d].storeys[i].controls.map(t => `${districtPortions[d].district.code} portion: ${t}`))};
  };
  const storeys = [];
  let bottom = 0, floorArea = 0, stoppedBy = 'storey limit';
  for (let i = 0; i < MAX_STOREYS; i++) {
    const at = storeyAt(i);
    if (!at) { stoppedBy = 'height and setback limits of every portion'; break; }
    let {polygon} = at;
    const {shaped, applied, first} = at;
    if (polygonArea(polygon) < 1) { stoppedBy = 'no footprint left after setbacks'; break; }
    const height = i === 0 ? heights.ground : heights.typical, top = bottom + height;
    let partial = false;
    if (floorArea + polygonArea(polygon) > maxFloorArea + EPS) {
      stoppedBy = `floor area ratio of ${far}`;
      const remainder = maxFloorArea - floorArea;
      if (remainder < 1) break;
      polygon = clipToArea(polygon, remainder); partial = true;
      shaped.push({control: 'max_area', areaSqft: round(remainder, 0), section: 'ZR 77-22', text: `partial storey holding the last ${round(remainder, 0)} sq ft of the floor area ratio`});
    }
    const area = polygonArea(polygon);
    storeys.push({level: i + 1, label: `${first.label.replace(' (partial)', '')}${partial ? ' (partial)' : ''}`, use: first.use, footprint: polygon.map(p => [round(p[0]), round(p[1])]), heightFeet: height, floorElevationFeet: round(bottom), topFeet: round(top), areaSqft: round(area, 0), coveragePercent: round(area / lotArea * 100), controls: applied, shapedBy: shaped, ...(partial ? {partial: true} : {})});
    floorArea += area; bottom = top;
    if (partial) break;
  }
  if (!storeys.length) throw new Error(`The envelope has no buildable storey (${stoppedBy}).`);
  const reserveStoreys = reserveAbove(storeys, stoppedBy, heights.typical, null, ({index}) => {
    const at = storeyAt(index);
    return at ? {polygon: at.polygon, applied: at.applied, shaped: at.shaped} : {polygon: [], applied: [], shaped: []};
  }, storeys.at(-1).use);
  const base = tables[0];
  const unitsOf = t => t.density.maxUnits;
  const units = tables.every(t => Number.isFinite(unitsOf(t))) ? tables.reduce((sum, t, i) => sum + dwellingUnits({residentialFloorAreaSqft: t.floorArea.maxFar * lotArea * shares[i], specialDensityArea: false, rules}).maxUnits, 0) : null;
  const density = {...base.density, maxUnits: units, sections: [...base.density.sections, 'ZR 77-25'], note: `The sum of each portion's dwelling units (ZR 77-25): ${districtPortions.map((p, i) => `${p.district.code} ${round(shares[i] * 100)}%`).join(', ')}.`};
  const parkingResult = parking({communityDistrict: args.communityDistrict, dwellingUnits: units, districtCode: primary.residentialEquivalent ?? primary.code, lotAreaSqft: lotArea, transitZone: args.transitZone, transitZoneSource: args.transitZoneSource, rules});
  const checks = [...new Set([
    `Split zoning lot: ${districtPortions.map((p, i) => `${p.district.code} on ${round(shares[i] * 100)}% (FAR ${tables[i].floorArea.maxFar})`).join(', ')} by the city's zoning map. The floor area ratio is the area-weighted ${adjustedFar} and may be placed anywhere on the lot (ZR 77-22); each portion keeps its own district's yards, heights and setbacks (ZR 77-27, 77-28); dwelling units are summed by portion (ZR 77-25) and residential parking weighted by area (ZR 77-321). The planning engine draws the mapped boundary; a lot that existed on December 15, 1961 may extend one district up to 25 ft across it (ZR 77-211).`,
    ...shapes.flatMap((e, d) => e.checks.map(c => `${districtPortions[d].district.code}: ${c}`)),
  ])];
  const portions = flat.map(({d, inner}, index) => ({index, kind: 'district', district: districtPortions[d].district.code, sharePercent: round(shares[d] * 100 * (inner ? inner.sharePercent / 100 : 1)),
    parts: districtPortions[d].parts, ...(inner ? {inner: {kind: inner.kind, inside: inner.inside, sides: inner.sides, withinFeet: inner.withinFeet}} : {}),
    label: `${districtPortions[d].district.code} portion${inner ? `, ${inner.label.toLowerCase()}` : ''}`,
    minBaseHeightFeet: inner?.minBaseHeightFeet ?? shapes[d].controls.streetWall.minBaseHeightFeet ?? null, maxBaseHeightFeet: inner?.maxBaseHeightFeet ?? shapes[d].controls.streetWall.maxBaseHeightFeet ?? shapes[d].controls.streetWall.maxFrontWallFeet ?? null,
    heightLimitFeet: inner?.heightLimitFeet ?? shapes[d].controls.heightLimitFeet ?? null, sections: ['ZR 77-27', 'ZR 77-28']}));
  const totalHeight = storeys.at(-1).topFeet;
  return {
    ...base, storeys, reserveStoreys, levels: groupLevels(storeys), storeyHeightsFeet: heights,
    floorArea: {maxFar: far, maxFloorAreaSqft: round(maxFloorArea, 0), sections: [...base.floorArea.sections, 'ZR 77-22']},
    metrics: {storeys: storeys.length, heightFeet: totalHeight, floorAreaSqft: round(floorArea, 0), far: round(floorArea / lotArea, 2), remainingFloorAreaSqft: round(maxFloorArea - floorArea, 0), stoppedBy},
    controls: {...base.controls, heightLimitFeet: shapes.some(e => e.controls.heightLimitFeet === null) ? null : Math.max(...shapes.map(e => e.controls.heightLimitFeet)), portions},
    districtPortions: districtPortions.map((p, i) => ({district: p.district.code, sharePercent: round(shares[i] * 100), maxFar: tables[i].floorArea.maxFar})),
    density, parking: parkingResult, checks,
    citations: [...new Set([...tables.flatMap(t => t.citations), 'ZR 23-04', 'ZR 77-22', 'ZR 77-25', 'ZR 77-27', 'ZR 77-28', 'ZR 77-321'])],
  };
}

// ZR 23-22 and the 23-432 notes: the wide-street figures govern a zoning lot, or the portion of it,
// within 100 ft of a wide street, and the narrow-street figures beyond; different rules on portions of
// one lot follow Article VII Chapter 7 (ZR 23-04), so the floor area ratio is the area-weighted sum
// (ZR 77-22). On the lot's axis-aligned frame (front at the least z) the lot is cut into cells 100 ft from
// each wide street line; wideShare is the part of the lot's area within that distance.
export function wideStreetPortion(lot, wideSides, widePortionFeet) {
  const {minX, maxX, minZ, maxZ} = bounds(lot);
  const nearWide = ([x, z]) => wideSides.some(side => (side === 'front' ? z - minZ : side === 'rear' ? maxZ - z : side === 'left' ? x - minX : maxX - x) <= widePortionFeet + EPS);
  const cuts = (lo, hi, list) => [...new Set([lo, ...list.filter(v => v > lo + EPS && v < hi - EPS).sort((a, b) => a - b), hi])];
  const xs = cuts(minX, maxX, [...(wideSides.includes('left') ? [minX + widePortionFeet] : []), ...(wideSides.includes('right') ? [maxX - widePortionFeet] : [])]);
  const zs = cuts(minZ, maxZ, [...(wideSides.includes('front') ? [minZ + widePortionFeet] : []), ...(wideSides.includes('rear') ? [maxZ - widePortionFeet] : [])]);
  const streetCells = zs.slice(1).flatMap((z1, j) => xs.slice(1).map((x1, i) => {
    const [x0, z0] = [xs[i], zs[j]];
    return {i, j, x0, x1, z0, z1, near: nearWide([(x0 + x1) / 2, (z0 + z1) / 2]), area: polygonArea(clip(clip(clip(clip(lot, 0, x0, true), 0, x1), 1, z0, true), 1, z1))};
  })).filter(c => c.area >= 1);
  const wideShare = wideSides.length ? streetCells.filter(c => c.near).reduce((sum, c) => sum + c.area, 0) / polygonArea(lot) : 0;
  return {streetCells, wideShare};
}

export function computeEnvelope({rules, district, specialDistricts = [], lot, frontages, use, affordable = false, qualifyingSeniorHousing = false, limitedHeightDistrict = null, form, historicCore = false, maxFar, communityDistrict = null, transitZone = null, transitZoneSource = null, storeyHeightsFeet = {}, recordedLotAreaSqft = null, districtPortions = null} = {}) {
  if (districtPortions?.length > 1) return splitEnvelope({districtPortions, rules, specialDistricts, lot, frontages, use, affordable, qualifyingSeniorHousing, limitedHeightDistrict, form, historicCore, maxFar, communityDistrict, transitZone, transitZoneSource, storeyHeightsFeet, recordedLotAreaSqft});
  if (!district || !district.kind) throw new Error('The envelope needs a curated district with its kind.');
  if (!Array.isArray(lot) || lot.length < 3) throw new Error('The envelope needs a lot polygon of at least three [x, z] points in feet.');
  const bulk = rules.bulk;
  // Floor area, coverage and every lot-size threshold rest on the lot area on record when one is
  // given (a tax-map polygon can differ from it by 10% or more); the polygon only shapes the geometry.
  const taxMapArea = polygonArea(lot);
  const lotArea = recordedLotAreaSqft > 0 ? recordedLotAreaSqft : taxMapArea;
  const {minX, maxX, minZ, maxZ} = bounds(lot);
  const lotWidth = maxX - minX, lotDepth = maxZ - minZ;
  const {streets, lotType, bySide} = describeStreets(frontages, rules);
  const streetSides = streets.map(s => s.side);
  const resolvedUse = use ?? (district.kind === 'residential' ? 'residential' : 'commercial');
  if (!['residential', 'commercial', 'community_facility'].includes(resolvedUse)) throw new Error(`Envelope use must be residential, commercial or community_facility, not ${resolvedUse}.`);
  // Community facility has no curated bulk table of its own yet (ZR 24 in residence districts): its
  // floor area is capped at the district's community-facility FAR below, and its massing is drawn with
  // the district kind's bulk regime as a starting point, flagged in checks, never as a determination.
  const bulkUse = resolvedUse === 'community_facility' ? (district.kind === 'residential' ? 'residential' : 'commercial') : resolvedUse;
  if (resolvedUse === 'community_facility' && form === 'sky-exposure-plane') throw new Error('The optional sky exposure plane rules are a residential alternative; a community-facility envelope is drawn in the district bulk form. Omit form for community_facility.');
  const special = specialDistricts.map(s => String(s).toUpperCase());
  const lowerManhattan = special.includes('LM');
  const equivalent = district.residentialEquivalent ? bulk.residential[district.residentialEquivalent] : null;
  if (bulkUse === 'residential' && !equivalent) throw new Error(`No residential bulk table for ${district.code}; it has no curated residential equivalent.`);
  const regime = lowerManhattan ? 'lower-manhattan' : bulkUse === 'residential' ? 'residential' : district.kind === 'manufacturing' ? 'manufacturing' : 'commercial';
  const checks = [], sections = new Set();
  const cite = list => { for (const s of list) sections.add(s); };

  // ZR 23-22 and the 23-432 notes: the wide-street figures govern the portion within 100 ft of a wide
  // street (wideStreetPortion).
  const widePortionFeet = bulk.streets.widePortionFeet;
  const wideSides = streets.filter(s => s.wide).map(s => s.side);
  const {streetCells, wideShare} = wideStreetPortion(lot, wideSides, widePortionFeet);
  const wideRow = resolvedUse === 'residential' && district.farResidentialWideStreet && wideSides.length ? district.farResidentialWideStreet : null;
  const narrowFar = resolvedUse === 'residential' ? (affordable ? district.farResidentialAffordable ?? district.farResidentialQualifyingSite ?? district.farResidential : district.farResidential) : null;
  const wideFar = wideRow ? (affordable ? wideRow.affordable : wideRow.standard) : null;
  const far = Number.isFinite(maxFar) ? maxFar : resolvedUse === 'community_facility' ? district.farCommunityFacility : resolvedUse === 'residential' ? (wideRow ? round(wideFar * wideShare + narrowFar * (1 - wideShare), 3) : narrowFar) : district.farCommercial;
  if (!Number.isFinite(far) || far <= 0) throw new Error(`No ${resolvedUse} floor area ratio is curated for ${district.code}.`);
  let farCap = lowerManhattan && resolvedUse === 'residential' ? Math.min(far, bulk.lowerManhattan.residentialMaxFar) : far;
  let maxFloorArea = farCap * lotArea;
  if (wideRow && !Number.isFinite(maxFar)) checks.push(wideShare >= 1 - 1e-6
    ? `Wide-street floor area ratio ${wideFar} applied (ZR 23-22): the whole lot lies within ${widePortionFeet} ft of a wide street${affordable ? '; the affordable figure holds only outside Mandatory Inclusionary Housing areas' : ''}.`
    : `Wide-street floor area ratio ${wideFar} on the ${round(wideShare * 100)}% of the lot within ${widePortionFeet} ft of a wide street and ${narrowFar} beyond (ZR 23-22), so the lot's floor area ratio is ${far} (ZR 77-22); the floor area may be placed anywhere on the lot, the wide-street portion holding up to 20% more than its own ratio.`);
  cite(district.citations);
  if (lowerManhattan) cite(bulk.lowerManhattan.citations);


  const heights = {ground: storeyHeightsFeet.ground ?? (district.kind === 'residential' ? 10.5 : 15), typical: storeyHeightsFeet.typical ?? (resolvedUse === 'residential' ? 10.5 : 12.5)};
  const heightAtStoreys = n => heights.ground + (n - 1) * heights.typical;
  const groundUse = resolvedUse === 'community_facility' ? 'community facility' : district.kind === 'residential' ? 'residential' : 'retail';
  const typicalUse = resolvedUse === 'community_facility' ? 'community facility' : resolvedUse === 'residential' ? 'residential' : district.kind === 'manufacturing' ? 'light industrial or office' : 'office';
  // Community facility in a Residence District (Article II, Chapter 4): curated coverage (ZR 24-11),
  // front yards (ZR 24-34) and the 30 ft rear yard with its own shallow rule (ZR 24-36, 24-37).
  const cfBulk = resolvedUse === 'community_facility' && district.kind === 'residential' ? bulk.communityFacility : null;
  const cfCoverage = cfBulk ? cfBulk.coveragePercentByDistrict[district.code] ?? null : null;
  const cfCoveragePercent = cfCoverage ? (lotType === 'corner' ? cfCoverage.corner : cfCoverage.interior) : null;
  const cfFrontYardFeet = cfBulk ? cfBulk.frontYardFeet[district.code] ?? cfBulk.frontYardFeet[(district.code.match(/^R\d+/) || [])[0]] ?? 0 : 0;
  const cfRearYardFeet = () => {
    const shallow = cfBulk.rearYard.shallowInteriorLot;
    if (lotType === 'interior' && lotDepth < shallow.underFeet) return lotDepth <= shallow.minAtOrUnderFeet ? shallow.minFeet : cfBulk.rearYard.feet - (shallow.underFeet - lotDepth) * shallow.reductionPerFootUnder;
    return cfBulk.rearYard.feet;
  };
  if (cfBulk) cite(cfBulk.citations);
  const cfFamilyNumber = Number((district.code.match(/^R(\d+)/) || [])[1]);
  const cfSuffixed = /^R\d+(?:-\d+)?[A-Z]/.test(district.code);
  const cfNonContextual = Boolean(cfBulk) && cfFamilyNumber >= 6 && !cfSuffixed;
  if (resolvedUse === 'community_facility') {
    const heightNote = !cfBulk ? `Community-facility bulk in ${district.kind} districts is not separately curated, so the massing is drawn with the ${bulkUse} bulk regime as a starting point only.`
      : cfSuffixed ? 'Height and setback follow the residential tables as ZR 24-50 directs for letter-suffix districts (and R5D).'
      : cfFamilyNumber <= 5 ? `Front heights follow the ZR 24-521 plane (${cfBulk.frontSetbackR1ThroughR5.wallHeightFeet[`R${cfFamilyNumber}`]} ft front wall, then 1 to 1); the overall height still stops at the residential table height as a starting point.`
      : 'Front heights follow the ZR 24-522 setback plane; the ZR 24-53 alternate and ZR 24-54 towers are not drawn.';
    checks.push(`Community facility: floor area is capped at the ${district.code} community-facility FAR of ${farCap} (ZR 24-11)${cfBulk ? `, with ZR 24-11 lot coverage and ZR 24-34/24-36 yards drawn` : ''}. ${heightNote} This envelope draws ordinary community-facility bulk (schools, houses of worship, medical offices and similar floors PLUTO records floor area for); hospitals and nursing or adult-care facilities are not drawn or priced as this envelope, so confirm their permit and bulk path separately.`);
  }
  for (const s of streets) if (s.assumedNarrow) checks.push(`${s.side} street width unknown; narrow-street rules applied (ZR 12-10: a wide street is ${bulk.streets.wideStreetMinimumWidthFeet} ft or more).`);
  cite(bulk.streets.citations);

  // Yards from the underlying district, independent of the height and setback regime.
  const common = bulkUse === 'residential' ? bulk.residentialCommon : district.kind === 'manufacturing' ? bulk.manufacturingCommon : bulk.commercialCommon;
  cite(common.citations);
  const rearIsLotLine = !streetSides.includes('rear');
  // ZR 12-10: the corner portion of a corner lot is bounded by the intersecting street lines and lines
  // 100 ft from each; it needs no rear yard (ZR 23-344, 33-301, 43-311). On this axis-aligned frame it is
  // the column within 100 ft of each side street, up to 100 ft from the front street; the planning
  // engine draws it exactly on the lot polygon (planning/outlines.py corner_portions).
  const corner = bulk.cornerLot;
  const regimeKey = bulkUse === 'residential' ? 'residential' : district.kind === 'manufacturing' ? 'manufacturing' : 'commercial';
  const cornerSection = corner.rearYardExemption[regimeKey];
  const cornerColumns = lotType === 'corner' && bySide.front ? mergeIntervals(streets.filter(s => s.side === 'left' || s.side === 'right').map(s => (s.side === 'left' ? [minX, minX + corner.portionFeet] : [maxX - corner.portionFeet, maxX]))) : [];
  const cornerExempt = cornerColumns.length === 1 && cornerColumns[0][0] <= minX + EPS && cornerColumns[0][1] >= maxX - EPS && lotDepth <= corner.portionFeet;
  const cornerPortionDepth = Math.min(maxZ, minZ + corner.portionFeet);
  // The lot less a rear yard of the given depth, except within the corner portion.
  const rearCut = (polygon, depth) => {
    if (!(depth > 0)) return polygon;
    const cut = maxZ - depth;
    let out = clip(polygon, 1, cut);
    if (cornerPortionDepth <= cut + EPS) return out;
    for (const [x0, x1] of cornerColumns) {
      const piece = clip(clip(clip(clip(polygon, 1, cut, true), 1, cornerPortionDepth), 0, x0, true), 0, x1);
      if (piece.length >= 3 && out.length >= 3) out = joinAcross(out, piece, 1, cut) ?? out;
    }
    return out;
  };
  const rearYardItem = feet => ({control: 'rear_yard', feet: round(feet, 2), section: rearSection, ...(cornerColumns.length ? {cornerPortionFeet: corner.portionFeet, cornerSection} : {})});
  // ZR 23-342(b): shallow interior lots, or interior portions of a corner lot, under 95 ft deep.
  const shallowLot = bulkUse === 'residential' && (lotType === 'interior' || (lotType === 'corner' && cornerColumns.length > 0)) && lotDepth < bulk.residentialCommon.shallowLot.maxDepthFeet;
  const residentialRear = feet => (shallowLot ? shallowLotRearYardFeet(feet, lotDepth, rules) : feet);
  // ZR 23-342: an attached or semi-detached building on a lot under 40 ft wide keeps a 30 ft rear yard at every
  // height; the buildings drawn here fill the lot's width.
  const narrowLot = bulkUse === 'residential' && !equivalent?.lowDensity && lotWidth < common.rearYardFeet.narrowLotWidthFeet;
  const rearYardAt = top => {
    if (!rearIsLotLine || cornerExempt) return 0;
    if (cfBulk) return cfRearYardFeet();
    if (bulkUse === 'residential') return residentialRear(narrowLot ? common.rearYardFeet.attachedNarrowLotFeet : top <= 75 ? common.rearYardFeet.upTo75Feet : common.rearYardFeet.above75Feet);
    return top <= common.rearYardObstructionMaxFeet ? 0 : common.rearYardFeet;
  };
  // ZR 23-343: a through lot 110 ft or more deep keeps a rear yard equivalent, 40 ft up to 75 ft of height
  // and 60 ft above on lots 190 ft or more deep; a shallower lot reduces it a foot per foot short, never
  // below 20 ft (the shallow-lot condition of December 15, 1961, flagged as for interior lots).
  const equivalentRule = bulk.residentialCommon.rearYardEquivalentFeet;
  const shallowThrough = lotType === 'through' && lotDepth >= equivalentRule.minLotDepthFeet && lotDepth < equivalentRule.standardLotDepthFeet;
  const throughEquivalentAt = top => {
    if (lotType !== 'through' || lotDepth < equivalentRule.minLotDepthFeet) return 0;
    const full = top <= 75 ? equivalentRule.upTo75Feet : equivalentRule.above75Feet;
    return shallowThrough ? Math.max(equivalentRule.shallowMinimumFeet, full - (equivalentRule.standardLotDepthFeet - lotDepth) * equivalentRule.shallowReductionPerFootFeet) : full;
  };
  const yards = {
    rearYard: !rearIsLotLine ? {requiredFeet: 0, reason: lotType === 'block' ? 'The lot occupies the whole block, so it has no rear lot line.' : 'Through lot: no rear yard at a street line; see rearYardEquivalent.', sections: common.citations}
      : cornerExempt ? {requiredFeet: 0, reason: `The whole lot lies within ${corner.portionFeet} ft of both intersecting street lines, the corner portion, where no rear yard is required.`, sections: [cornerSection, ...corner.citations]}
      : cfBulk ? {requiredFeet: round(rearYardAt(75), 2), above75FeetFeet: round(rearYardAt(Infinity), 2), sections: ['ZR 24-36', ...(lotType === 'interior' && lotDepth < cfBulk.rearYard.shallowInteriorLot.underFeet ? ['ZR 24-37'] : [])]}
      : bulkUse === 'residential' ? {requiredFeet: round(rearYardAt(75), 2), above75FeetFeet: round(rearYardAt(Infinity), 2), ...(shallowLot ? {shallowLot: true} : {}), ...(narrowLot ? {narrowLot: true} : {}), sections: ['ZR 23-342']}
      : {requiredFeet: common.rearYardFeet, occupiableToFeet: common.rearYardObstructionMaxFeet, sections: district.kind === 'manufacturing' ? ['ZR 43-26', 'ZR 43-23'] : ['ZR 33-26', 'ZR 33-23']},
    frontYard: cfBulk ? {requiredFeet: cfFrontYardFeet, sections: ['ZR 24-34']} : {requiredFeet: 0, sections: bulkUse === 'residential' ? ['ZR 23-322'] : ['ZR 33-20']},
    sideYards: {requiredFeet: 0, sections: cfBulk ? ['ZR 24-35'] : bulkUse === 'residential' ? ['ZR 23-335'] : ['ZR 33-20']},
  };
  if (streets.length === 3) checks.push(`The lot fronts three streets; it is treated as a corner lot for coverage across the whole lot, although only the portions within ${corner.portionFeet} ft of each intersecting street line are corner portions (ZR 12-10).`);
  if (!cfBulk && bulkUse === 'residential' && rearIsLotLine && !cornerExempt && !equivalent.lowDensity) checks.push(shallowLot
    ? `Shallow interior lot ${round(lotDepth)} ft deep: the rear yard is drawn at ${round(rearYardAt(75), 2)} ft up to 75 ft of height and ${round(rearYardAt(Infinity), 2)} ft above, reduced six inches per foot under 95 ft (ZR 23-342); the reduction holds only where the lot already had this depth on December 15, 1961.`
    : narrowLot ? `Lot ${round(lotWidth)} ft wide, under 40 ft: the attached building keeps a 30 ft rear yard at every height (ZR 23-342).`
    : 'Rear yard drawn as 20 ft up to 75 ft of height and 30 ft above, as curated from ZR 23-342; verify against the current text before relying on it.');
  if (narrowLot && shallowLot && rearIsLotLine && !cornerExempt) checks.push(`Lot ${round(lotWidth)} ft wide, under 40 ft: the shallow-lot reduction starts from the 30 ft rear yard an attached building keeps at every height (ZR 23-342).`);
  if (cornerColumns.length && !cornerExempt && rearIsLotLine) checks.push(`Corner lot: no rear yard is drawn within the corner portion, within ${corner.portionFeet} ft of each intersecting street line (ZR 12-10, ${cornerSection}); beyond it the rear yard is kept along the lines facing the rear. A side lot line beyond ${corner.portionFeet} ft of the street it meets counts as a rear lot line (${corner.beyondPortion[regimeKey]}), which needs ${regimeKey === 'residential' && equivalent?.lowDensity ? 'only a 5 ft yard' : 'no rear yard'} where it meets an adjoining side lot line; the tax map does not say which, so the yard is kept. The planning engine checks the 135 degree angle on the lot polygon.`);
  if (lotType === 'through') {
    if (bulkUse === 'residential') {
      yards.rearYardEquivalent = throughEquivalentAt(75) ? {requiredFeet: throughEquivalentAt(75), above75FeetFeet: throughEquivalentAt(Infinity), location: 'midway between the street lines', ...(shallowThrough ? {shallowLot: true} : {}), sections: ['ZR 23-343']} : {requiredFeet: 0, reason: `Through lot shallower than ${common.rearYardEquivalentFeet.minLotDepthFeet} ft needs no rear yard equivalent.`, sections: ['ZR 23-343']};
      if (throughEquivalentAt(75)) checks.push(`Through lot: the planning engine draws the ${throughEquivalentAt(75)} ft rear yard equivalent midway between the street lines (ZR 23-343); this envelope takes the same area from the rear to stack its storeys.${shallowThrough ? ` The lot is ${round(lotDepth)} ft deep, under 190 ft, so the equivalent is reduced a foot for each foot short, never below 20 ft; that holds only where the lot already had this depth on December 15, 1961.` : ''}`);
    }
    else if (district.kind === 'manufacturing') { yards.rearYardEquivalent = lotDepth >= common.rearYardEquivalentMinLotDepthFeet ? {requiredFeet: common.rearYardEquivalentFeet, location: 'midway between the street lines', sections: ['ZR 43-28']} : {requiredFeet: 0, reason: `Through lot shallower than ${common.rearYardEquivalentMinLotDepthFeet} ft needs no rear yard equivalent.`, sections: ['ZR 43-28']}; if (lotDepth >= common.rearYardEquivalentMinLotDepthFeet) checks.push('Through lot: the 40 ft rear yard equivalent (ZR 43-28) is drawn as a depth reduction from the rear street; it actually sits midway between the street lines.'); }
    else if ((common.throughLotNoRearYardDistricts || []).some(d => district.code === d || district.code.startsWith(`${d}-`))) yards.rearYardEquivalent = {requiredFeet: 0, reason: 'Through lots in C4-2 and higher, C5 and C6 districts need no rear yard equivalent.', sections: ['ZR 33-281']};
    else { yards.rearYardEquivalent = {requiredFeet: 40, location: 'midway between the street lines', sections: ['ZR 33-283']}; checks.push('Through lot: the 40 ft rear yard equivalent (ZR 33-283) is reported but not subtracted from the footprints.'); }
  }

  // Lot coverage and street-line setbacks by regime.
  let footprintAt, maxHeight = null, resolvedForm, controls;
  const widthSetback = (table, s) => table[s.wide ? 'wide' : 'narrow'];
  const insetStreets = (polygon, depthFor) => inset(polygon, Object.fromEntries(streets.map(s => [s.side, depthFor(s)])));
  const streetDepths = depthFor => Object.fromEntries(streets.map(s => [s.side, round(depthFor(s), 2)]).filter(([, feet]) => feet > 0));
  // Beside its plain-words controls each footprint records the controls that shaped it as data, so the
  // planning engine can redraw the outline on the exact lot polygon (planning/outlines.py).
  const shaping = () => { const applied = [], shaped = []; return {applied, shaped, add: (text, item) => { applied.push(text); shaped.push({...item, text}); }}; };
  const rearSection = cfBulk ? 'ZR 24-36' : bulkUse === 'residential' ? 'ZR 23-342' : district.kind === 'manufacturing' ? 'ZR 43-26' : 'ZR 33-26';

  if (regime === 'lower-manhattan') {
    const lm = bulk.lowerManhattan;
    resolvedForm = 'lower-manhattan';
    const setbackDepth = lm.setbackDepthByLotArea.find(row => row.maxLotAreaSqft === null || lotArea <= row.maxLotAreaSqft).depthFeet;
    const baseFor = s => {
      const type = s.streetWallType ? lm.streetWallTypes[s.streetWallType] : null;
      const fallback = Math.max(lm.defaultMaxBaseHeight.minimumFeet, lm.defaultMaxBaseHeight.streetWidthMultiplier * (s.widthFeet ?? 0));
      return {maxBase: type?.noSetbacks ? Infinity : type?.maxBaseFeet ?? fallback, minBase: type?.minBaseFeet ?? null, type: s.streetWallType};
    };
    const bases = Object.fromEntries(streets.map(s => [s.side, baseFor(s)]));
    const lowestBase = Math.min(...Object.values(bases).map(b => b.maxBase));
    const coverage = historicCore ? lm.coverage.historicCore : lm.coverage.standard;
    footprintAt = ({top}) => {
      const {applied, shaped, add} = shaping();
      let polygon = rearCut(lot, rearYardAt(top));
      if (rearYardAt(top)) add(`rear yard ${round(rearYardAt(top), 2)} ft`, rearYardItem(rearYardAt(top)));
      polygon = insetStreets(polygon, s => top > bases[s.side].maxBase ? setbackDepth : 0);
      if (streets.some(s => top > bases[s.side].maxBase)) add(`${setbackDepth} ft setback above the base (ZR 91-32)`, {control: 'setback', feet: streetDepths(s => top > bases[s.side].maxBase ? setbackDepth : 0), section: 'ZR 91-32'});
      if (top > lowestBase) {
        const percent = top <= 300 ? coverage.upTo300FeetPercent : coverage.above300FeetPercent;
        polygon = clipToArea(polygon, lotArea * percent / 100);
        add(`${percent}% lot coverage (ZR 91-33)`, {control: 'lot_coverage', percent, section: 'ZR 91-33'});
      }
      if (top > 300) { polygon = clipToDimension(polygon, lm.maxHorizontalDimensionAbove300Feet); add(`${lm.maxHorizontalDimensionAbove300Feet} ft maximum horizontal dimension (ZR 91-34)`, {control: 'max_dimension', feet: lm.maxHorizontalDimensionAbove300Feet, section: 'ZR 91-34'}); }
      return {polygon, applied, shaped};
    };
    controls = {
      streetWall: {bySide: Object.fromEntries(streets.map(s => [s.side, {streetWallType: s.streetWallType, maxBaseHeightFeet: bases[s.side].maxBase === Infinity ? null : round(bases[s.side].maxBase), minBaseHeightFeet: bases[s.side].minBase, rule: s.streetWallType ? `Street wall Type ${s.streetWallType} (Appendix A ${lm.streetWallTypes[s.streetWallType].map})` : `No street wall type supplied: maximum base height is ${lm.defaultMaxBaseHeight.minimumFeet} ft or ${lm.defaultMaxBaseHeight.streetWidthMultiplier} times the street width, whichever is greater`}])), sections: ['ZR 91-31']},
      setbacks: {depthFeet: setbackDepth, aboveFeet: lowestBase === Infinity ? null : round(lowestBase), required: lowestBase !== Infinity, minimumHeightFeet: lm.setbackMinimumHeightFeet, sections: ['ZR 91-32'], note: historicCore ? 'Within the Historic and Commercial Core a sky exposure plane rising 6:1 from 100 ft may be used instead of the setback; not drawn.' : null},
      coverage: {aboveBaseUpTo300FeetPercent: coverage.upTo300FeetPercent, above300FeetPercent: coverage.above300FeetPercent, historicCore, maxHorizontalDimensionAbove300Feet: lm.maxHorizontalDimensionAbove300Feet, basePercent: 100, sections: ['ZR 91-33', 'ZR 91-34']},
      heightLimitFeet: null,
    };
    if (streets.some(s => !s.streetWallType)) checks.push('Street wall types (ZR 91-31, Appendix A Maps 2 and 3) and Historic and Commercial Core membership (Map 1) were not supplied; the default base height rule and the standard coverage were used.');
    if (resolvedUse === 'residential') checks.push('Residential use in the Special Lower Manhattan District: the 80% residential lot coverage of ZR 23-362 was not applied below the base; verify whether it governs alongside ZR 91-33.');
    if (new Set(Object.values(bases).map(b => b.maxBase)).size > 1) checks.push('Streets with different maximum base heights: coverage limits were applied above the lowest base height over the whole lot; ZR 91-33 allows separate planes beyond 100 ft of the higher-base street.');
  } else if (regime === 'residential' && equivalent.lowDensity) {
    // R1 through R5: front and side yards, a rear yard, lot coverage by residence type and low height
    // limits (ZR 23-321, 23-332, 23-342, 23-361, 23-42). On a qualifying residential site ("affordable")
    // any residence type is permitted, so the multiple dwelling coverage applies, with the ZR 23-424 heights.
    const low = equivalent.lowDensity;
    const multiple = low.multipleDwellings || affordable;
    resolvedForm = multiple ? 'multiple-dwelling' : low.detachedOnly ? 'detached' : 'detached-or-semi-detached';
    const row = equivalent[(bySide.front ?? streets[0]).wide ? 'wide' : 'narrow'];
    const maxBase = affordable ? row.affordableMaxBaseFeet : row.maxBaseFeet;
    maxHeight = affordable ? row.affordableMaxHeightFeet : row.maxHeightFeet;
    const sideYardFeet = multiple && low.sideYards.multipleDwellingFeet !== null ? low.sideYards.multipleDwellingFeet : low.sideYards.detachedEachFeet;
    const sideLotLines = ['left', 'right'].filter(side => !streetSides.includes(side));
    const attachedNarrow = multiple && sideYardFeet === 0 && lotWidth < low.narrowLotWidthFeet;
    const rearFeet = cfBulk ? cfRearYardFeet() : residentialRear(attachedNarrow ? low.rearYardAttachedNarrowLotFeet : low.rearYardFeet);
    const frontYardFeet = cfBulk ? cfFrontYardFeet : low.frontYardFeet;
    const coverageTable = multiple ? low.multipleDwellingCoveragePercent ?? low.lotCoveragePercent : low.lotCoveragePercent;
    const coveragePercent = cfBulk ? cfCoveragePercent : coverageTable ? coverageTable[lotType === 'interior' || lotType === 'through' ? 'interior' : 'corner'] : null;
    // The floor area spreads over the full storeys that fit under the wall or base height, as a low-rise
    // building is designed, instead of one oversized storey that leaves the rest unbuilt.
    let baseStoreys = 1;
    while (heightAtStoreys(baseStoreys + 1) <= maxBase + EPS) baseStoreys++;
    const storeyCap = maxFloorArea / baseStoreys;
    cite(equivalent.citations);
    yards.frontYard = {requiredFeet: frontYardFeet, streets: streetSides, sections: cfBulk ? ['ZR 24-34'] : ['ZR 23-321']};
    yards.sideYards = {requiredFeet: sideYardFeet, lotLines: sideLotLines, sections: cfBulk ? ['ZR 24-35'] : ['ZR 23-332']};
    if (rearIsLotLine && !cornerExempt) yards.rearYard = {requiredFeet: round(rearFeet, 2), ...(shallowLot && !cfBulk ? {shallowLot: true} : {}), ...(cornerColumns.length ? {cornerPortionFeet: corner.portionFeet} : {}), sections: cfBulk ? ['ZR 24-36', ...(lotType === 'interior' && lotDepth < cfBulk.rearYard.shallowInteriorLot.underFeet ? ['ZR 24-37'] : [])] : ['ZR 23-342']};
    if (!cfBulk && shallowLot && rearIsLotLine) checks.push(`Shallow interior lot ${round(lotDepth)} ft deep: the rear yard is drawn at ${round(rearFeet, 2)} ft, reduced six inches per foot under 95 ft (ZR 23-342); the reduction holds only where the lot already had this depth on December 15, 1961.`);
    footprintAt = ({top}) => {
      const {applied, shaped, add} = shaping();
      const rear = rearIsLotLine && !cornerExempt ? rearFeet : 0;
      let polygon = inset(rearCut(lot, rear), Object.fromEntries(sideLotLines.map(side => [side, sideYardFeet])));
      if (rear) add(`rear yard ${round(rear, 2)} ft (${rearSection})`, rearYardItem(rear));
      if (sideYardFeet && sideLotLines.length) add(`side yards ${sideYardFeet} ft (${cfBulk ? 'ZR 24-35' : 'ZR 23-332'})`, {control: 'side_yard', feet: sideYardFeet, sides: sideLotLines, section: cfBulk ? 'ZR 24-35' : 'ZR 23-332'});
      polygon = insetStreets(polygon, () => frontYardFeet);
      add(`front yard ${frontYardFeet} ft on each street (${cfBulk ? 'ZR 24-34' : 'ZR 23-321'})`, {control: 'front_yard', feet: frontYardFeet, sides: streetSides, section: cfBulk ? 'ZR 24-34' : 'ZR 23-321'});
      // ZR 24-521: above the front wall height the plane rises 1 to 1 from the front yard line.
      const cfWallFeet = cfBulk && district.code !== 'R5D' ? cfBulk.frontSetbackR1ThroughR5.wallHeightFeet[`R${cfFamilyNumber}`] ?? null : null;
      if (cfWallFeet && top > cfWallFeet) {
        const extra = (top - cfWallFeet) * cfBulk.frontSetbackR1ThroughR5.slope.horizontal / cfBulk.frontSetbackR1ThroughR5.slope.vertical;
        polygon = insetStreets(polygon, () => extra);
        add(`front setback plane above ${cfWallFeet} ft at 1 to 1 (ZR 24-521)`, {control: 'setback', feet: streetDepths(() => frontYardFeet + extra), aboveFeet: cfWallFeet, plane: true, section: 'ZR 24-521'});
      } else if (!cfWallFeet && top > maxBase) { polygon = insetStreets(polygon, s => widthSetback(bulk.residentialCommon.setbackFeet, s)); add(`setback above ${maxBase} ft (ZR 23-423${low.roof === 'pitched' && !affordable ? ', standing in for the ZR 23-421 pitched-roof planes' : ''})`, {control: 'setback', feet: streetDepths(s => frontYardFeet + widthSetback(bulk.residentialCommon.setbackFeet, s)), aboveFeet: maxBase, section: 'ZR 23-423'}); }
      if (coveragePercent) { polygon = clipToArea(polygon, lotArea * coveragePercent / 100); add(`${coveragePercent}% lot coverage (${cfBulk ? 'ZR 24-11' : 'ZR 23-361'})`, {control: 'lot_coverage', percent: coveragePercent, section: cfBulk ? 'ZR 24-11' : 'ZR 23-361'}); }
      if (top <= maxBase + EPS && polygonArea(polygon) > storeyCap) { polygon = clipToArea(polygon, storeyCap); add(`floor area spread over ${baseStoreys} storeys`, {control: 'max_area', areaSqft: round(storeyCap, 0), section: district.citations[0]}); }
      return {polygon, applied, shaped};
    };
    controls = {
      streetWall: {minBaseHeightFeet: null, maxBaseHeightFeet: maxBase, roof: low.roof, location: `Behind a ${frontYardFeet} ft front yard`, sections: cfBulk ? ['ZR 24-34'] : ['ZR 23-321', low.roof === 'pitched' && !affordable ? 'ZR 23-421' : 'ZR 23-422']},
      setbacks: {aboveFeet: maxBase, depthFeet: bulk.residentialCommon.setbackFeet, sections: ['ZR 23-423']},
      coverage: {basePercent: coveragePercent, lotType, residenceType: resolvedForm, sections: cfBulk ? ['ZR 24-11'] : ['ZR 23-361']},
      heightLimitFeet: maxHeight,
    };
    if (low.roof === 'pitched' && !affordable) checks.push(`Pitched-roof district: perimeter walls up to ${maxBase} ft and a roof to a ${maxHeight} ft ridge under ZR 23-421; storeys above ${maxBase} ft are drawn with the ZR 23-423 setback as a stand-in for the sloping roof planes, so attic floor area is approximate.`);
    if (!coveragePercent) checks.push(`${district.residentialEquivalent}: lot coverage is whatever the required yards leave (ZR 23-361).`);
    if (lotType === 'corner') checks.push('Corner lot: one front yard may be 5 ft shallower than the table (ZR 23-321); both are drawn at full depth.');
    if (affordable) checks.push(`Qualifying residential site assumed (ZR 12-10): ${district.farResidentialQualifyingSite} FAR, any residence type and the ZR 23-424 heights. Confirm the lot meets the definition (transit zone, lot size and frontage, existing community facility floor space, or qualifying senior housing).`);
    else if (!low.multipleDwellings) checks.push(`${district.residentialEquivalent} allows ${low.detachedOnly ? 'only detached' : 'only one- or two-family'} residences outside qualifying residential sites (ZR 22-122); the envelope is drawn as one detached building with side yards.`);
    if (district.farResidential === 0.75 && !affordable && lotArea >= 4000) checks.push('Standard zoning lot of 4,000 sq ft or more: any single dwelling unit is capped at 0.60 FAR of residential floor area (ZR 23-21, note 1).');
  } else if (cfNonContextual) {
    // R6 through R12 without a letter suffix: ZR 24-522 front setbacks. A front wall rises within the
    // initial setback distance to the table height, then the sky exposure plane governs; ZR 24-11
    // coverage and ZR 24-36 rear yard apply throughout. No overall height limit (ZR 24-54 towers and
    // the ZR 24-53 alternate are not drawn).
    const table = cfBulk.frontSetbacksNonContextualR6Plus;
    const band = cfFamilyNumber <= 7 ? 'R6-R7' : 'R8-R12';
    const wall = table.frontWallMax[band];
    const frontWallMax = Math.min(wall.feet, heightAtStoreys(wall.storeys));
    const planeStart = table.skyExposurePlane.startFeet[band];
    resolvedForm = 'community-facility-setbacks';
    footprintAt = ({top}) => {
      const {applied, shaped, add} = shaping();
      let polygon = rearCut(lot, rearYardAt(top));
      if (rearYardAt(top)) add(`rear yard ${round(rearYardAt(top), 2)} ft`, rearYardItem(rearYardAt(top)));
      if (top <= frontWallMax) {
        add(`front wall up to ${round(frontWallMax)} ft within the initial setback distance (ZR 24-522)`, {control: 'street_wall', maxBaseFeet: round(frontWallMax), section: 'ZR 24-522'});
      } else {
        const planeDepth = s => Math.max(widthSetback(table.initialSetbackFeet, s), (top - planeStart) / widthSetback(table.skyExposurePlane.slope, s));
        polygon = insetStreets(polygon, planeDepth);
        add(`under the ZR 24-522 sky exposure plane rising ${table.skyExposurePlane.slope.narrow}:1 (narrow) or ${table.skyExposurePlane.slope.wide}:1 (wide) from ${planeStart} ft`, {control: 'setback', feet: streetDepths(planeDepth), aboveFeet: planeStart, plane: true, section: 'ZR 24-522'});
      }
      if (cfCoveragePercent) { polygon = clipToArea(polygon, lotArea * cfCoveragePercent / 100); add(`${cfCoveragePercent}% lot coverage (ZR 24-11)`, {control: 'lot_coverage', percent: cfCoveragePercent, section: 'ZR 24-11'}); }
      return {polygon, applied, shaped};
    };
    controls = {
      streetWall: {maxFrontWallFeet: round(frontWallMax), maxFrontWallStoreys: wall.storeys, initialSetbackFeet: table.initialSetbackFeet, sections: ['ZR 24-522']},
      setbacks: {skyExposurePlane: {startFeet: planeStart, slope: table.skyExposurePlane.slope}, initialSetbackFeet: table.initialSetbackFeet, sections: ['ZR 24-522']},
      coverage: {basePercent: cfCoveragePercent, lotType, sections: ['ZR 24-11']},
      heightLimitFeet: null,
    };
    if (lotType === 'through') checks.push('Through lot: the rear yard equivalent of ZR 24-38 is not drawn for community facility yet; verify the open area midway between the street lines.');
  } else if (regime === 'residential' && form === 'sky-exposure-plane') {
    // Sky exposure plane buildings (ZR 23-73): optional rules for R6 through R10 districts without a
    // letter suffix. The height factor sets the floor area ratio and the open space (ZR 23-732, 23-733);
    // a front wall rises within the initial setback, then the building stays under the plane
    // (ZR 23-736), or in R9 and R10 a tower penetrates it (ZR 23-737); no lot coverage limit (ZR 23-735).
    const sep = bulk.residentialSkyExposurePlane;
    if (!sep.eligibleDistricts.includes(district.code) || sep.excludedDistricts.includes(district.code)) throw new Error(`The sky exposure plane rules apply to R6 through R10 districts without a letter suffix, other than R6-1, R6-2, R7-3 and R9-1, not ${district.code} (ZR 23-731).`);
    if (special.some(sd => /^LH/.test(sd))) throw new Error('The sky exposure plane rules do not apply in Limited Height Districts (ZR 23-731).');
    resolvedForm = 'sky-exposure-plane';
    const family = `R${district.code.match(/^R(\d+)/)[1]}`;
    const front = sep.frontSetback[['R6', 'R7'].includes(family) ? 'R6-R7' : 'R8-R10'];
    const frontWallMax = Math.min(front.frontWallMaxFeet, heightAtStoreys(front.frontWallMaxStoreys));
    const tower = sep.towers.districts.includes(family);
    const towerPercent = lotArea > 20000 ? sep.towers.maxCoveragePercent.lotsOver20000Sqft : sep.towers.maxCoveragePercent.other;
    const openSpaceRatio = hf => (hf <= 21 ? sep.heightFactor[family][hf - 1][0] : sep.highBuildings[family].openSpaceRatioAt21 + (hf - 21) * sep.highBuildings[family].perHeightFactor);
    const farAt = hf => (family === 'R10' ? (affordable ? sep.r10Far.affordable : sep.r10Far.standard) : hf <= 21 ? sep.heightFactor[family][hf - 1][1] : hf / (1 + hf * openSpaceRatio(hf) / 100));
    const narrowLimit = narrowBuildingLimit({equivalentCode: narrowBuildingCode(district), equivalent: {skyExposurePlane: true}, streets, lotType, lotWidth, lotDepth, rules});
    maxHeight = narrowLimit ? narrowLimit.maxHeightFeet : null;
    if (narrowLimit) {
      cite(narrowLimit.sections);
      checks.push(`Narrow building: its street walls are ${narrowLimit.streetWallWidthFeet} ft wide, under 45 ft, so as a sky exposure plane building in ${district.residentialEquivalent} it rises no higher than ${maxHeight} ft, the width of the street it faces (ZR 23-738).`);
    }
    const equivalentAlternatives = lotType === 'through';
    const under = top => {
      const {applied, shaped, add} = shaping();
      let polygon = rearCut(lot, rearYardAt(top));
      if (rearYardAt(top)) add(`rear yard ${round(rearYardAt(top), 2)} ft`, rearYardItem(rearYardAt(top)));
      if (throughEquivalentAt(top)) { polygon = clip(polygon, 1, maxZ - throughEquivalentAt(top)); add(`rear yard equivalent ${throughEquivalentAt(top)} ft kept open (ZR 23-343)`, {control: 'rear_yard_equivalent', feet: throughEquivalentAt(top), section: 'ZR 23-343', ...(equivalentAlternatives ? {alternatives: ['street_lines', 'side_lot_lines']} : {})}); }
      if (top <= frontWallMax) { add(`front wall up to ${round(frontWallMax)} ft (ZR 23-736)`, {control: 'street_wall', maxBaseFeet: round(frontWallMax), section: 'ZR 23-736'}); return {polygon, applied, shaped}; }
      if (tower) {
        polygon = clipToArea(insetStreets(polygon, s => widthSetback(sep.towers.setbackFeet, s)), lotArea * towerPercent / 100);
        add(`tower penetrating the sky exposure plane: ${towerPercent}% of the lot, set back ${sep.towers.setbackFeet.wide} ft from a wide and ${sep.towers.setbackFeet.narrow} ft from a narrow street (ZR 23-737)`, {control: 'setback', feet: streetDepths(s => widthSetback(sep.towers.setbackFeet, s)), aboveFeet: round(frontWallMax), section: 'ZR 23-737'});
        shaped.push({control: 'lot_coverage', percent: towerPercent, section: 'ZR 23-737', text: `${towerPercent}% tower coverage`});
        return {polygon, applied, shaped};
      }
      const planeDepth = s => Math.max(widthSetback(front.initialSetbackFeet, s), (top - front.planeStartFeet) * 1 / widthSetback(front.slope, s));
      polygon = insetStreets(polygon, planeDepth);
      add(`under the sky exposure plane rising ${front.slope.narrow}:1 (narrow) or ${front.slope.wide}:1 (wide) from ${front.planeStartFeet} ft (ZR 23-736)`, {control: 'setback', feet: streetDepths(planeDepth), aboveFeet: front.planeStartFeet, plane: true, section: 'ZR 23-736'});
      return {polygon, applied, shaped};
    };
    // The height factor that holds the most floor area: its ratio and the coverage it implies
    // (floor area over the height factor), each storey kept within that coverage.
    const held = hf => {
      const cap = farAt(hf) * lotArea / hf, allowance = farAt(hf) * lotArea;
      let sum = 0;
      for (let i = 0, bottom = 0; i < MAX_STOREYS && sum < allowance; i++) {
        const top = bottom + (i === 0 ? heights.ground : heights.typical);
        if (maxHeight !== null && top > maxHeight + EPS) break;
        const area = Math.min(cap, polygonArea(under(top).polygon));
        if (area < 1) break;
        sum += area; bottom = top;
      }
      return Math.min(sum, allowance);
    };
    // R10 has a fixed ratio and no open space ratio (ZR 23-733), so no height factor caps its coverage.
    const factors = Array.from({length: 40}, (_, i) => i + 1);
    const heightFactor = family === 'R10' ? null : factors.reduce((best, hf) => (held(hf) > held(best) + 1 ? hf : best), 1);
    const coverageCap = family === 'R10' ? lotArea : farAt(heightFactor) * lotArea / heightFactor;
    if (!Number.isFinite(maxFar)) { farCap = round(farAt(heightFactor), 2); maxFloorArea = farCap * lotArea; }
    cite(sep.citations);
    footprintAt = ({top}) => {
      const out = under(top);
      if (heightFactor === null) return out;
      const polygon = clipToArea(out.polygon, coverageCap);
      out.shaped.push({control: 'max_area', areaSqft: round(coverageCap, 0), section: 'ZR 23-732', text: `coverage of ${round(coverageCap, 0)} sq ft at height factor ${heightFactor}`});
      return {polygon, applied: [...out.applied, `height factor ${heightFactor}: open space ratio ${openSpaceRatio(heightFactor)} (ZR 23-732)`], shaped: out.shaped};
    };
    controls = {
      streetWall: {maxFrontWallFeet: round(frontWallMax), maxFrontWallStoreys: front.frontWallMaxStoreys, initialSetbackFeet: front.initialSetbackFeet, sections: ['ZR 23-736']},
      setbacks: tower ? {towerSetbackFeet: sep.towers.setbackFeet, aboveFeet: round(frontWallMax), sections: ['ZR 23-737']} : {skyExposurePlane: {startFeet: front.planeStartFeet, slope: front.slope}, initialSetbackFeet: front.initialSetbackFeet, sections: ['ZR 23-736']},
      coverage: {basePercent: null, note: 'No lot coverage limit for sky exposure plane buildings (ZR 23-735); the open space ratio sets the open space.', sections: ['ZR 23-735', 'ZR 23-732']},
      heightFactor: {value: heightFactor, openSpaceRatio: heightFactor === null ? null : openSpaceRatio(heightFactor), maxFar: round(farAt(heightFactor), 2), requiredOpenSpaceSqft: heightFactor === null ? null : round(openSpaceRatio(heightFactor) / 100 * farAt(heightFactor) * lotArea, 0), sections: ['ZR 23-732', 'ZR 23-733']},
      heightLimitFeet: maxHeight,
      ...(narrowLimit ? {narrowBuilding: narrowLimit} : {}),
    };
    checks.push(`Sky exposure plane building (ZR 23-73, optional): ${heightFactor === null ? `a floor area ratio of ${round(farAt(null), 2)} (ZR 23-733)` : `height factor ${heightFactor} gives a floor area ratio of ${round(farAt(heightFactor), 2)} and an open space ratio of ${openSpaceRatio(heightFactor)}`}, which supersede ZR 23-22 for every residence, including qualifying affordable housing (ZR 23-732); a front wall to ${round(frontWallMax)} ft within the initial setback, then ${tower ? 'a tower penetrating the plane (ZR 23-737)' : 'the sky exposure plane (ZR 23-736)'}. In Manhattan Community District 9 north of West 125th Street R8 lots cannot use these rules (ZR 23-731).`);
  } else if (regime === 'residential') {
    resolvedForm = form ?? (equivalent.towers ? 'tower' : 'base');
    if (!['base', 'tower', 'eligible'].includes(resolvedForm)) throw new Error(`The ${resolvedForm} form is not drawn for residential use in ${district.residentialEquivalent}; use base, tower, eligible or sky-exposure-plane.`);
    if (resolvedForm === 'tower' && !equivalent.towers) throw new Error(`Towers are not permitted in ${district.residentialEquivalent} (ZR 23-435).`);
    if (resolvedForm === 'eligible' && !equivalent.eligibleSiteMaxHeightFeet) throw new Error(`Eligible site provisions are not available in ${district.residentialEquivalent} (ZR 23-434: districts without a letter suffix only).`);
    const eligible = resolvedForm === 'eligible';
    // ZR 23-343(c)(2): the equivalent may instead lie along the street lines or the side lot lines on
    // eligible sites, with towers, under the R10 provisions and on shallow through lots.
    const equivalentAlternatives = lotType === 'through' && (equivalentRule.alternativeForms.includes(resolvedForm) || equivalentRule.alternativeDistricts.includes(district.residentialEquivalent) || shallowThrough);
    if (equivalentAlternatives && throughEquivalentAt(75)) checks.push('The rear yard equivalent may instead be open areas along the street lines with the same combined depth, or half its depth along each side lot line (ZR 23-343(c)(2)); the planning engine draws whichever holds the most floor area.');
    // Coverage when utilizing an eligible site (ZR 23-362): 65% at 30,000 sq ft+, 50% on large
    // sites (1.5 acres, ZR 12-10); below 30,000 sq ft the standard coverage still governs.
    const eligiblePercent = eligible ? (lotArea >= 65340 ? 50 : lotArea >= 30000 ? 65 : null) : null;
    const front = bySide.front ?? streets[0];
    // The ZR 23-432 row: the wide-street row within 100 ft of a wide street (note 1), the narrow-street
    // row beyond it (note 2). A lot wholly on one side of that line takes one row.
    const rowOf = key => { const r = equivalent[key]; return {key, minBase: r.minBaseFeet, maxBase: affordable ? r.affordableMaxBaseFeet : r.maxBaseFeet, maxBuilding: affordable ? r.affordableMaxHeightFeet : r.maxHeightFeet}; };
    const nearRow = rowOf(wideSides.length ? 'wide' : 'narrow'), beyondRow = rowOf('narrow');
    const rowsDiffer = ['minBase', 'maxBase', 'maxBuilding'].some(k => nearRow[k] !== beyondRow[k]);
    const split = wideSides.length > 0 && wideShare < 1 - 1e-6 && rowsDiffer;
    const row = nearRow;
    const {minBase, maxBase} = row;
    const coveragePercent = cfCoveragePercent ?? bulk.residentialCommon.lotCoveragePercent[lotType === 'block' ? 'corner' : lotType];
    const towerRules = bulk.towers.residential;
    const heightOf = r => (eligible ? equivalent.eligibleSiteMaxHeightFeet : resolvedForm === 'base' ? r.maxBuilding : null);
    maxHeight = heightOf(row);
    cite(equivalent.citations); cite(['ZR 23-433', 'ZR 23-362', 'ZR 34-112', 'ZR 35-23']);
    if (resolvedForm === 'tower') cite(towerRules.citations);
    if (eligible) cite(['ZR 23-434']);
    const footprintFor = ({minBase, maxBase}) => ({top}) => {
      const {applied, shaped, add} = shaping();
      let polygon = rearCut(lot, rearYardAt(top));
      add(`rear yard ${round(rearYardAt(top), 2)} ft`, rearYardItem(rearYardAt(top)));
      if (throughEquivalentAt(top)) {
        const equiv = throughEquivalentAt(top);
        polygon = clip(polygon, 1, maxZ - equiv);
        add(`rear yard equivalent ${equiv} ft kept open (ZR 23-343)`, {control: 'rear_yard_equivalent', feet: equiv, section: 'ZR 23-343', ...(equivalentAlternatives ? {alternatives: ['street_lines', 'side_lot_lines']} : {})});
      }
      if (top > maxBase) { polygon = insetStreets(polygon, s => widthSetback(bulk.residentialCommon.setbackFeet, s)); add('setback above the maximum base height (ZR 23-433)', {control: 'setback', feet: streetDepths(s => widthSetback(bulk.residentialCommon.setbackFeet, s)), aboveFeet: maxBase, section: 'ZR 23-433'}); }
      else add(`street wall up to ${maxBase} ft (ZR 23-432)`, {control: 'street_wall', minBaseFeet: minBase, maxBaseFeet: maxBase, section: 'ZR 23-432'});
      let percent = eligiblePercent ?? coveragePercent, section = cfBulk ? 'ZR 24-11' : 'ZR 23-362';
      if (resolvedForm === 'tower' && top > maxBase) { percent = top <= 300 ? towerRules.coverage[0].maxPercent : towerRules.coverage[1].maxPercent; section = 'ZR 23-435'; }
      polygon = clipToArea(polygon, lotArea * percent / 100);
      add(`${percent}% lot coverage (${section})`, {control: 'lot_coverage', percent, section});
      return {polygon, applied, shaped};
    };
    // A split lot is drawn cell by cell under each cell's row and the cells joined back into one footprint,
    // storeys above the beyond row's height holding only the wide-street portion. Each control names its
    // portion (0 within 100 ft of a wide street, 1 beyond) so the planning engine clips each exactly.
    const portionRows = [nearRow, beyondRow];
    footprintAt = !split ? footprintFor(row) : ({top}) => {
      const cells = streetCells.filter(c => heightOf(c.near ? nearRow : beyondRow) === null || top <= heightOf(c.near ? nearRow : beyondRow) + EPS);
      const drawn = new Map();
      for (const p of [0, 1]) if (cells.some(c => c.near === (p === 0))) drawn.set(p, footprintFor(portionRows[p])({top}));
      const piece = c => clip(clip(clip(clip(drawn.get(c.near ? 0 : 1).polygon, 0, c.x0, true), 0, c.x1), 1, c.z0, true), 1, c.z1);
      const joinRun = (pieces, axis, at) => pieces.reduce((acc, p) => (acc.polygon.length < 3 ? p : p.polygon.length < 3 ? acc : {polygon: joinAcross(acc.polygon, p.polygon, axis, at(p)) ?? (polygonArea(p.polygon) > polygonArea(acc.polygon) ? p.polygon : acc.polygon), cell: p.cell}), {polygon: []});
      const rowsOfCells = [...new Set(cells.map(c => c.j))].sort((a, b) => a - b).map(j => joinRun(cells.filter(c => c.j === j).sort((a, b) => a.i - b.i).map(c => ({polygon: piece(c), cell: c})), 0, p => p.cell.x0));
      const polygon = joinRun(rowsOfCells, 1, p => p.cell.z0).polygon;
      const labels = ['within 100 ft of a wide street', 'beyond 100 ft of a wide street'];
      return {polygon, applied: [...drawn].flatMap(([p, f]) => f.applied.map(t => `${labels[p]}: ${t}`)), shaped: [...drawn].flatMap(([p, f]) => f.shaped.map(c => ({...c, portion: p})))};
    };
    if (split) {
      maxHeight = portionRows.some(r => heightOf(r) === null) ? null : Math.max(...portionRows.map(heightOf));
      checks.push(`The ${round(wideShare * 100)}% of the lot within ${widePortionFeet} ft of a wide street takes the wide-street heights (base ${nearRow.minBase} to ${nearRow.maxBase} ft, building ${heightOf(nearRow) ?? 'set by the tower rules'} ft) and the rest the narrow-street heights (base ${beyondRow.minBase} to ${beyondRow.maxBase} ft, building ${heightOf(beyondRow) ?? 'set by the tower rules'} ft) (ZR 23-432 notes 1 and 2, ZR 77-28).`);
    }
    controls = {
      ...(split ? {portions: portionRows.map((r, p) => ({index: p, kind: 'wide-street', inside: p === 0, sides: wideSides, withinFeet: widePortionFeet, label: p === 0 ? `Within ${widePortionFeet} ft of a wide street` : `Beyond ${widePortionFeet} ft of a wide street`, sharePercent: round((p === 0 ? wideShare : 1 - wideShare) * 100), row: r.key, minBaseHeightFeet: r.minBase, maxBaseHeightFeet: r.maxBase, heightLimitFeet: heightOf(r), sections: ['ZR 23-432', 'ZR 77-28']}))} : {}),
      streetWall: {minBaseHeightFeet: minBase, maxBaseHeightFeet: maxBase, streetRow: row.key === 'wide' ? 'wide street' : 'narrow street', affordable, location: `At least ${bulk.residentialCommon.streetWall.percentWithinFeet}% of the street wall within ${bulk.residentialCommon.streetWall.withinFeet[front.wide ? 'wide' : 'narrow']} ft of the street line up to the minimum base height`, sections: ['ZR 23-432', 'ZR 23-431', 'ZR 35-631']},
      setbacks: {aboveFeet: maxBase, depthFeet: bulk.residentialCommon.setbackFeet, sections: ['ZR 23-433']},
      coverage: {basePercent: eligiblePercent ?? coveragePercent, lotType, ...(eligible ? {eligibleSitePercent: eligiblePercent} : {}), ...(resolvedForm === 'tower' ? {towerUpTo300FeetPercent: towerRules.coverage[0].maxPercent, towerAbove300FeetPercent: towerRules.coverage[1].maxPercent} : {}), sections: cfBulk ? ['ZR 24-11', ...(resolvedForm === 'tower' ? ['ZR 23-435'] : [])] : resolvedForm === 'tower' ? ['ZR 23-362', 'ZR 23-435'] : ['ZR 23-362']},
      heightLimitFeet: maxHeight,
      eligibleSiteMaxHeightFeet: equivalent.eligibleSiteMaxHeightFeet,
      // Court minimums are reported, not drawn: whether a court is needed and where depends on
      // the window-wall layout, which the envelope does not model (ZR 23-352, 23-353).
      courts: {
        innerCourt: {withLegallyRequiredWindows: {upTo75Feet: {minAreaSqft: 800, minDimensionFeet: 20}, above75Feet: {minAreaSqft: 1200, minDimensionFeet: 30}}, withoutLegallyRequiredWindows: {upTo75Feet: {minAreaSqft: 200, minDimensionFeet: 10}, above75Feet: {minAreaSqft: 300, minDimensionFeet: 15}}, recess: 'Width at least equal to depth, up to the applicable minimum dimension', section: 'ZR 23-352'},
        outerCourt: {withLegallyRequiredWindows: {rule: 'Width at least equal to depth, except any depth where the width is at least 20 ft at or below 75 ft or 30 ft above 75 ft'}, withoutLegallyRequiredWindows: {upTo75Feet: {minAreaSqft: 200, minDimensionFeet: 10}, above75Feet: {minAreaSqft: 300, minDimensionFeet: 15}}, recess: 'Width at least equal to depth, except where the width permits any depth', section: 'ZR 23-353'},
        sections: ['ZR 23-351', 'ZR 23-352', 'ZR 23-353'],
      },
    };
    if (eligible) checks.push(`Eligible-site form drawn at the ${equivalent.eligibleSiteMaxHeightFeet} ft ZR 23-434 height; the lot must actually meet ZR 23-434(a) (transportation-infrastructure-adjacent frontage, a listed irregularity, or at least 20,000 sq ft / an entire block), and lots of 40,000 sq ft or more may add up to 25 percent where an existing building already meets the table height. Base heights and setbacks still follow ZR 23-432/23-433.`);
    else if (equivalent.eligibleSiteMaxHeightFeet && lotArea >= 20000) checks.push(`Lot of 20,000 sq ft or more may qualify as an eligible site with a ${equivalent.eligibleSiteMaxHeightFeet} ft maximum height (ZR 23-434); utilizing it caps lot coverage at 65% on lots of 30,000 sq ft or more that are not large sites and 50% on large sites (ZR 23-362); re-run with form 'eligible' to draw it.`);
    if (resolvedForm === 'tower' && front.wide) checks.push('Tower on a wide street with more than 25% residential floor area must follow the tower-on-a-base rules: at least 30% coverage and 55% to 60% of floor area below 150 ft (ZR 23-441); reported, not drawn.');
    checks.push('Court minimums (ZR 23-352 inner courts, 23-353 outer courts) are reported in controls.courts and not carved from the drawn envelope; which courts a design needs depends on where legally required windows face.');
  } else {
    const sep = bulk.skyExposurePlane[district.bulk?.skyExposurePlane];
    if (!sep) throw new Error(`No sky exposure plane table is curated for ${district.code}.`);
    const towerTable = district.bulk?.towers ? bulk.towers[district.bulk.towers] : null;
    resolvedForm = form ?? (towerTable ? 'tower' : 'sky-exposure-plane');
    if (resolvedForm === 'tower' && !towerTable) throw new Error(`Towers are not permitted in ${district.code} (ZR 33-451).`);
    const frontWallMax = Math.min(sep.frontWallMaxFeet, heightAtStoreys(sep.frontWallMaxStoreys));
    cite(sep.citations);
    if (resolvedForm === 'tower') cite(towerTable.citations);
    const towerPercent = towerTable && lotArea < towerTable.smallLotThresholdSqft ? smallLotCoverage(towerTable, lotArea) : towerTable?.maxCoveragePercent ?? null;
    footprintAt = ({top}) => {
      const {applied, shaped, add} = shaping();
      let polygon = rearCut(lot, rearYardAt(top));
      if (rearYardAt(top)) add(`rear yard ${round(rearYardAt(top), 2)} ft`, rearYardItem(rearYardAt(top)));
      if (district.kind === 'manufacturing' && lotType === 'through' && lotDepth >= bulk.manufacturingCommon.rearYardEquivalentMinLotDepthFeet) {
        polygon = clip(polygon, 1, maxZ - bulk.manufacturingCommon.rearYardEquivalentFeet);
        add(`rear yard equivalent ${bulk.manufacturingCommon.rearYardEquivalentFeet} ft kept open (ZR 43-28)`, {control: 'rear_yard_equivalent', feet: bulk.manufacturingCommon.rearYardEquivalentFeet, section: 'ZR 43-28'});
      }
      if (top <= frontWallMax) {
        add(`front wall up to ${round(frontWallMax)} ft (${sep.citations[0]})`, {control: 'street_wall', maxBaseFeet: round(frontWallMax), section: sep.citations[0]});
        return {polygon, applied, shaped};
      }
      if (resolvedForm === 'tower') {
        polygon = insetStreets(polygon, s => widthSetback(towerTable.setbackFeet, s));
        polygon = clipToArea(polygon, lotArea * towerPercent / 100);
        add(`tower: ${towerPercent}% lot coverage, set back ${towerTable.setbackFeet.narrow} ft (narrow) and ${towerTable.setbackFeet.wide} ft (wide) from street lines (${towerTable.citations.join(', ')})`, {control: 'setback', feet: streetDepths(s => widthSetback(towerTable.setbackFeet, s)), aboveFeet: round(frontWallMax), section: towerTable.citations[0]});
        shaped.push({control: 'lot_coverage', percent: towerPercent, section: towerTable.citations[0], text: `${towerPercent}% tower lot coverage`});
        return {polygon, applied, shaped};
      }
      const planeDepth = s => Math.max(widthSetback(sep.initialSetbackFeet, s), (top - sep.planeStartFeet) / widthSetback(sep.slope, s));
      polygon = insetStreets(polygon, planeDepth);
      add(`under the sky exposure plane rising ${sep.slope.narrow}:1 (narrow) or ${sep.slope.wide}:1 (wide) from ${sep.planeStartFeet} ft (${sep.citations.join(', ')})`, {control: 'setback', feet: streetDepths(planeDepth), aboveFeet: sep.planeStartFeet, plane: true, section: sep.citations[0]});
      return {polygon, applied, shaped};
    };
    controls = {
      streetWall: {maxFrontWallFeet: round(frontWallMax), maxFrontWallStoreys: sep.frontWallMaxStoreys, initialSetbackFeet: sep.initialSetbackFeet, sections: sep.citations},
      setbacks: resolvedForm === 'tower' ? {towerSetbackFeet: towerTable.setbackFeet, aboveFeet: round(frontWallMax), sections: towerTable.citations} : {skyExposurePlane: {startFeet: sep.planeStartFeet, slope: sep.slope}, initialSetbackFeet: sep.initialSetbackFeet, sections: sep.citations},
      coverage: {basePercent: 100, ...(resolvedForm === 'tower' ? {towerPercent} : {}), sections: resolvedForm === 'tower' ? towerTable.citations : ['ZR 33-20'], note: 'Commercial and manufacturing buildings have no lot coverage limit below the sky exposure plane; residential portions follow the residential equivalent.'},
      heightLimitFeet: null,
    };
    if (resolvedForm === 'tower' && district.bulk?.towerAlternate && streets.length >= 2) checks.push(`Lot bounded by two or more streets may use the alternate tower rules: coverage up to ${bulk.towers[district.bulk.towerAlternate].maxCoveragePercent}% as FAR falls below the maximum (${bulk.towers[district.bulk.towerAlternate].citations.join(', ')}); not drawn.`);
  }

  const limitedHeight = rules.bulk.limitedHeightDistricts?.[String(limitedHeightDistrict || '').trim().toUpperCase()] ?? null;
  if (limitedHeight && regime === 'residential' && !affordable && !qualifyingSeniorHousing) {
    maxHeight = maxHeight === null ? limitedHeight.maxHeightFeet : Math.min(maxHeight, limitedHeight.maxHeightFeet);
    controls.limitedHeight = {district: String(limitedHeightDistrict).trim().toUpperCase(), maxHeightFeet: limitedHeight.maxHeightFeet, sections: [rules.bulk.limitedHeightDistricts.citation], sourceUrl: rules.bulk.limitedHeightDistricts.sourceUrl};
    cite([rules.bulk.limitedHeightDistricts.citation]);
    checks.push(`${controls.limitedHeight.district} caps building height at ${limitedHeight.maxHeightFeet} ft (ZR 23-739); the cap is not applied to a zoning lot containing qualifying affordable housing or qualifying senior housing.`);
  } else if (limitedHeight && regime === 'residential') {
    checks.push(`${String(limitedHeightDistrict).trim().toUpperCase()} is recorded, but the ZR 23-739 cap is not applied because this envelope represents ${affordable ? 'qualifying affordable housing' : 'qualifying senior housing'}; confirm the qualifying status.`);
  }

  // Stack storeys until the floor area, a height limit or the geometry runs out. When the floor area
  // ratio stops a storey part way, its remainder is built as a partial top storey trimmed from the rear,
  // so the envelope holds the full allowance (the height limit is checked first, so it fits).
  const storeys = [];
  let bottom = 0, floorArea = 0, stoppedBy = 'storey limit';
  const addStorey = (i, polygon, height, top, applied, shaped, partial) => {
    const area = polygonArea(polygon);
    storeys.push({level: i + 1, label: `${i === 0 ? 'Ground' : `Level ${i + 1}`}${partial ? ' (partial)' : ''}`, use: i === 0 ? groundUse : typicalUse, footprint: polygon.map(p => [round(p[0]), round(p[1])]), heightFeet: height, floorElevationFeet: round(bottom), topFeet: round(top), areaSqft: round(area, 0), coveragePercent: round(area / lotArea * 100), controls: applied, shapedBy: shaped, ...(partial ? {partial: true} : {})});
    floorArea += area; bottom = top;
  };
  for (let i = 0; i < MAX_STOREYS; i++) {
    const height = i === 0 ? heights.ground : heights.typical;
    const top = bottom + height;
    if (maxHeight !== null && top > maxHeight + EPS) { stoppedBy = `height limit of ${maxHeight} ft`; break; }
    const {polygon, applied, shaped} = footprintAt({index: i, bottom, top});
    const area = polygonArea(polygon);
    if (area < 1) { stoppedBy = 'no footprint left after setbacks'; break; }
    if (floorArea + area > maxFloorArea + EPS) {
      stoppedBy = `floor area ratio of ${farCap}`;
      const remainder = maxFloorArea - floorArea;
      const partialText = `partial storey holding the last ${round(remainder, 0)} sq ft of the floor area ratio`;
      if (remainder >= 1) addStorey(i, clipToArea(polygon, remainder), height, top, [...applied, partialText], [...shaped, {control: 'max_area', areaSqft: round(remainder, 0), section: district.citations[0], text: partialText}], true);
      break;
    }
    addStorey(i, polygon, height, top, applied, shaped, false);
  }
  if (!storeys.length) throw new Error(`The envelope has no buildable storey (${stoppedBy}).`);
  const reserveStoreys = reserveAbove(storeys, stoppedBy, heights.typical, maxHeight, footprintAt, typicalUse);

  // Near-street area caps for commercial towers are checked, not enforced.
  if (regime === 'commercial' && resolvedForm === 'tower') {
    const caps = bulk.towers[district.bulk.towers].areaCapNearStreet;
    for (const s of streets) {
      const cap = s.wide ? caps.wide : caps.narrow;
      const tower = storeys.find(st => st.topFeet > controls.setbacks.aboveFeet);
      if (!tower) continue;
      const band = s.side === 'front' ? clip(tower.footprint, 1, minZ + cap.withinFeet) : s.side === 'rear' ? clip(tower.footprint, 1, maxZ - cap.withinFeet, true) : s.side === 'left' ? clip(tower.footprint, 0, minX + cap.withinFeet) : clip(tower.footprint, 0, maxX - cap.withinFeet, true);
      const bandArea = polygonArea(band);
      if (bandArea > cap.maxSqft) checks.push(`Tower area within ${cap.withinFeet} ft of the ${s.side} street is ${round(bandArea, 0).toLocaleString('en-US')} sq ft, above the ${cap.maxSqft.toLocaleString('en-US')} sq ft cap (ZR 33-451); narrow the tower there or take the deeper setback option.`);
    }
  }
  const baseHeight = storeys.filter(s => !s.controls.some(c => c.includes('setback'))).at(-1)?.topFeet ?? 0;
  if (controls.streetWall.minBaseHeightFeet && baseHeight < controls.streetWall.minBaseHeightFeet) checks.push(`The street wall reaches ${baseHeight} ft, below the ${controls.streetWall.minBaseHeightFeet} ft minimum base height (${controls.streetWall.sections[0]}); raise the base before setting back.`);
  if (regime === 'lower-manhattan') for (const [side, base] of Object.entries(controls.streetWall.bySide)) if (base.minBaseHeightFeet && baseHeight < base.minBaseHeightFeet) checks.push(`The street wall on the ${side} street reaches ${baseHeight} ft, below the ${base.minBaseHeightFeet} ft minimum base height for Type ${base.streetWallType} (ZR 91-31).`);

  const totalHeight = storeys.at(-1).topFeet;
  const residentialFloorArea = storeys.filter(s => s.use === 'residential').reduce((sum, s) => sum + s.areaSqft, 0);
  const nonResidentialFloorArea = round(floorArea, 0) - residentialFloorArea;
  const specialDensityArea = bulk.parking.manhattanCore.communityDistricts.includes(communityDistrict === null ? '' : String(communityDistrict).padStart(3, '0')) || special.includes('DB');
  const perLot = regime === 'residential' && !affordable ? equivalent?.lowDensity?.dwellingUnitsPerLot : null;
  const density = perLot ? {maxUnits: perLot, sections: ['ZR 22-122', 'ZR 23-51'], note: `${perLot === 1 ? 'Single-family' : 'One- or two-family'} residences only outside qualifying residential sites (ZR 22-122); the dwelling unit factor does not apply to them (ZR 23-51).`}
    : resolvedUse === 'residential' ? dwellingUnits({residentialFloorAreaSqft: maxFloorArea, specialDensityArea, rules}) : {maxUnits: null, sections: bulk.density.citations, note: 'Not a residential envelope; request use "residential" for dwelling units.'};
  const retailFloorArea = storeys.filter(s => s.use === 'retail').reduce((sum, s) => sum + s.areaSqft, 0);
  const parkingResult = parking({communityDistrict, dwellingUnits: density.maxUnits, nonResidentialFloorAreaSqft: nonResidentialFloorArea, retailFloorAreaSqft: retailFloorArea, districtCode: district.residentialEquivalent ?? district.code, lotAreaSqft: lotArea, transitZone, transitZoneSource, rules});
  cite(density.sections); cite(parkingResult.sections);
  // Where the optional sky exposure plane rules are open to the lot (ZR 23-05, 23-731), what they would
  // hold, for comparison; they are not priced here.
  const sep = bulk.residentialSkyExposurePlane;
  let alternatives;
  if (regime === 'residential' && resolvedUse === 'residential' && !equivalent.lowDensity && resolvedForm !== 'sky-exposure-plane' && !Number.isFinite(maxFar) && sep.eligibleDistricts.includes(district.code) && !sep.excludedDistricts.includes(district.code) && !limitedHeightDistrict && !special.some(sd => /^LH/.test(sd))) {
    try {
      const e = computeEnvelope({rules, district, specialDistricts, lot, frontages, use, affordable, form: 'sky-exposure-plane', communityDistrict, transitZone, transitZoneSource, storeyHeightsFeet, recordedLotAreaSqft});
      alternatives = {skyExposurePlane: {maxFar: e.floorArea.maxFar, floorAreaSqft: e.metrics.floorAreaSqft, heightFeet: e.metrics.heightFeet, storeys: e.metrics.storeys, heightFactor: e.controls.heightFactor.value, openSpaceRatio: e.controls.heightFactor.openSpaceRatio, sections: e.controls.heightFactor.sections}};
      checks.push(`The optional sky exposure plane rules (ZR 23-73) would hold ${e.metrics.floorAreaSqft.toLocaleString('en-US')} sq ft at a floor area ratio of ${e.floorArea.maxFar} in ${e.metrics.storeys} storeys to ${e.metrics.heightFeet} ft, against ${round(maxFloorArea, 0).toLocaleString('en-US')} sq ft here; run form 'sky-exposure-plane' to draw them.`);
    } catch (error) {
      alternatives = {skyExposurePlane: {unavailable: error.message}};
    }
  }

  return {
    ...(alternatives ? {alternatives} : {}),
    regime, form: resolvedForm, district: district.code, residentialEquivalent: district.residentialEquivalent ?? null, specialDistricts: special, use: resolvedUse, affordable,
    lot: {polygon: lot.map(p => [round(p[0]), round(p[1])]), areaSqft: round(lotArea, 0), taxMapAreaSqft: round(taxMapArea, 0), widthFeet: round(lotWidth), depthFeet: round(lotDepth), type: lotType, streets},
    floorArea: {maxFar: farCap, maxFloorAreaSqft: round(maxFloorArea, 0), sections: [...(lowerManhattan && resolvedUse === 'residential' ? ['ZR 91-21'] : []), ...district.citations.slice(0, 1)]},
    storeyHeightsFeet: heights,
    storeys, reserveStoreys,
    levels: groupLevels(storeys),
    metrics: {storeys: storeys.length, heightFeet: totalHeight, floorAreaSqft: round(floorArea, 0), far: round(floorArea / lotArea, 2), remainingFloorAreaSqft: round(maxFloorArea - floorArea, 0), stoppedBy},
    controls: {...controls, yards},
    density, parking: parkingResult, checks,
    citations: [...sections],
    note: `Computed from the curated bulk table and the supplied lot and streets: it is an as-of-right starting point to verify against the current Zoning Resolution, the zoning maps and a survey, never a determination. Areas are gross footprint areas, not zoning floor area. ${rules.caveat}`,
  };
}

// Arguments for acres_model_concept: the lot and the grouped storeys, in feet.
export function conceptArguments(envelope, name = 'As-of-right envelope') {
  const {streetWall, setbacks, coverage} = envelope.controls;
  const sections = [...new Set([...streetWall.sections, ...setbacks.sections, ...coverage.sections])];
  return {
    name,
    summary: `As-of-right envelope for ${envelope.district}${envelope.specialDistricts.length ? ` in ${envelope.specialDistricts.join(', ')}` : ''}: ${envelope.form} form, FAR ${envelope.floorArea.maxFar}, ${envelope.metrics.storeys} storeys to ${envelope.metrics.heightFeet} ft (${sections.join(', ')}). Starting point to verify, not a determination.`,
    units: 'ft',
    lot: envelope.lot.polygon,
    levels: envelope.levels.map(({label, use, footprint, height, count}) => ({label, use, footprint, height, ...(count > 1 ? {count} : {})})),
    maxFar: envelope.floorArea.maxFar,
    ...(envelope.controls.heightLimitFeet ? {maxHeightFeet: envelope.controls.heightLimitFeet} : {}),
  };
}

export const OUTLINES_SCHEMA = 'acres.outlines/1';
// Court minimums for a storey, from the envelope's reported controls: the band at or below 75 ft
// or the one above, for courts that legally required windows face and for those they do not.
function courtMinimums(courts, top) {
  if (!courts) return null;
  const band = top <= 75 ? 'upTo75Feet' : 'above75Feet';
  return {
    inner: {withWindows: courts.innerCourt.withLegallyRequiredWindows[band], withoutWindows: courts.innerCourt.withoutLegallyRequiredWindows[band], section: courts.innerCourt.section},
    outer: {withWindows: {minWidthFeet: top <= 75 ? 20 : 30, rule: courts.outerCourt.withLegallyRequiredWindows.rule}, withoutWindows: courts.outerCourt.withoutLegallyRequiredWindows[band], section: courts.outerCourt.section},
  };
}

// The buildable outline of every storey of one option, for the planning engine (planning/engine.py
// storey_outlines): the lot ring and holes in feet in the concept frame, each storey's controls as
// data (yards, street setbacks, street wall, coverage and area caps, with their sections), the court
// minimums at its height, and its zoning floor area budget, the storey's gross footprint over
// grossPerZfa (the envelope stacks gross area). The engine draws the outline exactly on the lot
// polygon from these; footprint is the envelope's own axis-aligned approximation. lot.source says
// whether the ring is the city's tax-lot polygon or a frontage by depth rectangle; lot.north is the
// direction of true north in that frame when the tax-lot loader placed it.
const outlineStorey = (s, index, controls, grossPerZfa) => ({
  index, label: s.label, use: s.use, bottomFeet: s.floorElevationFeet, topFeet: s.topFeet, heightFeet: s.heightFeet,
  grossBudgetSqft: s.areaSqft, zfaBudgetSqft: round(s.areaSqft / grossPerZfa, 0),
  shapedBy: s.shapedBy, courts: courtMinimums(controls.courts, s.topFeet), footprint: s.footprint,
});

export function storeyOutlines(envelope, {scheme = null, lot, grossPerZfa = 1} = {}) {
  const ring = lot?.exterior ?? envelope.lot.polygon;
  const {controls} = envelope;
  return {
    schema: OUTLINES_SCHEMA, scheme, frame: 'acres_model_concept', units: 'ft',
    lot: {exterior: ring, holes: lot?.holes ?? [], areaSqft: envelope.lot.areaSqft, taxMapAreaSqft: envelope.lot.taxMapAreaSqft, widthFeet: envelope.lot.widthFeet, depthFeet: envelope.lot.depthFeet,
      type: envelope.lot.type, source: lot?.source ?? 'rectangle', bbl: lot?.bbl ?? null, north: lot?.north ?? null, note: lot?.note ?? null},
    streets: envelope.lot.streets.map(({side, name, widthFeet, wide}) => ({side, name, widthFeet, wide})),
    district: envelope.district, residentialEquivalent: envelope.residentialEquivalent, specialDistricts: envelope.specialDistricts,
    regime: envelope.regime, form: envelope.form, use: envelope.use, affordable: envelope.affordable,
    floorArea: {maxFar: envelope.floorArea.maxFar, maxGrossSqft: envelope.floorArea.maxFloorAreaSqft, grossPerZfa, maxZfaSqft: round(envelope.floorArea.maxFloorAreaSqft / grossPerZfa, 0), sections: envelope.floorArea.sections},
    heightLimitFeet: controls.heightLimitFeet ?? null,
    streetWall: controls.streetWall, setbacks: controls.setbacks, coverage: controls.coverage, yards: controls.yards, portions: controls.portions ?? null,
    storeys: envelope.storeys.map((s, index) => outlineStorey(s, index, controls, grossPerZfa)),
    reserveStoreys: (envelope.reserveStoreys ?? []).map((s, k) => outlineStorey(s, envelope.storeys.length + k, controls, grossPerZfa)),
    metrics: envelope.metrics, density: envelope.density, parking: envelope.parking,
  };
}
