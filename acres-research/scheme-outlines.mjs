// The buildable outline of every storey of one of a site's options (schemes.mjs), for the planning
// engine to lay floors out in (planning/engine.py storey_outlines). The lot is the city's tax-lot
// polygon, placed in the concept frame by the same loader that places the walkthrough's neighbours,
// or PLUTO's frontage-by-depth rectangle when no polygon is on record. The option's envelope is the
// zoning envelope that holds its floor area on that lot: the affordable (UAP) envelope for a bonus
// building, the standard one otherwise, stacked to the option's zoning floor area in gross terms.
import {computeEnvelope, storeyOutlines, parking, polygonArea, bounds, transitZoneOf} from './envelope.mjs';
import {rules, describeDistrict, suggestedLot} from './zoning.mjs';
import {ZFA_GROSS_DEDUCTIONS} from './market-store.mjs';
import {pointInPolygon, projector, frameTransform} from './context.mjs';
import {districtParts as mappedDistrictParts} from './nyc-zoning-lookups.mjs';

const FOOT = 0.3048;
const round = (n, d = 2) => Number(n.toFixed(d));
const TAX_MAP_NOTE = 'Lot lines come from the city\'s tax map, not a survey.';
const RECTANGLE_NOTE = 'No tax-lot polygon was found for this lot, so its outline is a rectangle from the frontage and depth on record.';

const normalize = ring => {
  const {minX, minZ} = bounds(ring);
  return ring.map(([x, z]) => [round(x - minX), round(z - minZ)]);
};

// How open the ground just beyond one side of the lot is: the share of probe points 4 to 22 m
// outside that fall in no neighbouring building (streets are open, party walls are not).
function openness(ring, side, buildings) {
  const {minX, maxX, minZ, maxZ} = bounds(ring);
  let open = 0, total = 0;
  for (const t of [0.2, 0.4, 0.6, 0.8]) for (const out of [4, 10, 16, 22]) {
    const p = side === 'left' ? [minX - out, minZ + (maxZ - minZ) * t] : [maxX + out, minZ + (maxZ - minZ) * t];
    total++;
    if (!buildings.some(b => pointInPolygon(p, b.polygon))) open++;
  }
  return open / total;
}

// PLUTO marks a lot divided by a zoning district boundary (splitzone), or names a second district.
export const isSplitLot = property => property?.splitzone === true || String(property?.splitzone ?? '').toLowerCase() === 'true' || Boolean(String(property?.zonedist2 ?? '').trim());

// The districts on a split lot placed in the lot's concept frame: each DCP district polygon projected
// around the loader's origin, rotated onto the model frame, turned and offset as the ring is.
async function placedDistricts(property, context, place, districtParts) {
  const project = projector(context.origin.latitude, context.origin.longitude);
  const {toModel} = frameTransform({origin: context.frame.origin, into: context.frame.into}, context.frame.lotCenter);
  const at = point => place(toModel(project(point)));
  let parts;
  try {
    parts = await districtParts(property.bbl);
  } catch (error) {
    return {unavailable: `The zoning map could not be read for this split lot (${error.message}); it is outlined under ${property.zonedist1} alone.`};
  }
  return {districts: parts.map(d => ({code: d.code, sharePercent: d.sharePercent, parts: d.parts.map(p => ({exterior: p.polygon.map(at), holes: p.holes.map(h => h.map(at))}))}))};
}

// The lot ring in feet in the concept frame (x along the front street, z into the lot, the front
// street line at z = 0), and the side its side street runs along on a corner lot. The loader's frame
// fronts the most open side; when that side matches the lot depth on record rather than the
// frontage, the ring is turned a quarter so the frontage faces the front. north is the unit vector
// pointing to true north in the same frame (x, z), turned with the ring, for the sheet's north arrow.
// context is the nearest neighbouring buildings in the same frame, footprints and heights in feet,
// for the site plan of the architect's drawing set. On a split lot, districts are the zoning map's
// districts placed in the same frame (or unavailable says why they are not).
export async function lotOutline(property, {loadContext, corner = false, districtParts = mappedDistrictParts, storedPolygon = null} = {}) {
  const rect = suggestedLot(property);
  if (!rect) return null;
  const fallback = {exterior: rect.polygon, holes: [], source: 'rectangle', bbl: property.bbl ?? null, sideStreet: corner ? 'left' : null, note: RECTANGLE_NOTE};
  const loaded = loadContext ? await loadContext({property, lot: rect.polygon.map(([x, z]) => [x * FOOT, z * FOOT])}) : null;
  const parcel = loaded?.context?.parcel;
  if (!(parcel?.polygon?.length >= 3)) {
    // The outline stored at market ingest (already in feet, front on z = 0) stands for the lot when the
    // context loader placed no parcel; it carries no neighbours or north, which only the loader knows.
    const stored = Array.isArray(storedPolygon) ? storedPolygon : storedPolygon?.polygon;
    if (Array.isArray(stored) && stored.length >= 3 && stored.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      return {exterior: normalize(stored), holes: [], source: 'tax-lot', bbl: property.bbl ?? null, sideStreet: corner ? 'left' : null, north: null, note: TAX_MAP_NOTE};
    }
    return fallback;
  }
  const others = (loaded.context.buildings || []).filter(b => !b.existing);
  let ring = parcel.polygon, sideStreet = null, north = loaded.context.north ?? null, turn = p => p;
  if (corner) {
    const {minX, maxX, minZ, maxZ} = bounds(ring), front = Number(property.lotfront) * FOOT;
    const turned = front > 0 && Math.abs(maxZ - minZ - front) < Math.abs(maxX - minX - front);
    // A quarter turn (x, z) -> (z, -x) carries the loader's front side to the left.
    if (turned) { turn = ([x, z]) => [z, -x]; ring = ring.map(turn); north = north && [north[1], -north[0]]; sideStreet = 'left'; }
    else sideStreet = openness(ring, 'left', others) >= openness(ring, 'right', others) ? 'left' : 'right';
  }
  const {minX, minZ} = bounds(ring.map(([x, z]) => [x / FOOT, z / FOOT]));
  const place = point => { const [x, z] = turn(point); return [round(x / FOOT - minX), round(z / FOOT - minZ)]; };
  const context = others.slice(0, 40).map(b => ({polygon: b.polygon.map(place), height: round(b.height / FOOT, 1)}));
  const split = isSplitLot(property) && loaded.context.frame && loaded.context.origin ? await placedDistricts(property, loaded.context, place, districtParts) : null;
  return {exterior: normalize(ring.map(([x, z]) => [x / FOOT, z / FOOT])), holes: [], source: 'tax-lot', bbl: parcel.bbl, sideStreet, north, context, note: TAX_MAP_NOTE, ...(split ?? {})};
}

// The streets for the option's envelope: the site envelope's mapped streets when it has them,
// otherwise PLUTO's lot type, with a corner lot's side street on the side the lot outline found.
function frontages(envelope, property, sideStreet) {
  const mapped = envelope?.lot?.streets?.length ? envelope.lot.streets.map(({side, name, widthFeet, streetWallType}) => ({side, ...(name ? {name} : {}), ...(Number.isFinite(widthFeet) ? {widthFeet} : {}), ...(streetWallType ? {streetWallType} : {})})) : null;
  const lotType = String(property?.lottype ?? '').trim();
  const streets = mapped ?? [{side: 'front'}, ...(lotType === '3' ? [{side: 'left'}] : []), ...(lotType === '4' ? [{side: 'rear'}] : [])];
  return sideStreet ? streets.map(s => (s.side === 'left' || s.side === 'right' ? {...s, side: sideStreet} : s)) : streets;
}

export const isCornerSite = (envelope, property) => envelope?.lot?.type === 'corner' || (!envelope?.lot?.type && String(property?.lottype ?? '').trim() === '3');

// One option's acres.outlines/1 export: its envelope on the lot outline, stacked to its zoning floor
// area. lot is lotOutline's result; envelope is the site's saved zoning envelope (for the district
// and the mapped streets), or null to read them from PLUTO.
export function schemeOutlines(scheme, {property, lot, envelope = null}) {
  const program = scheme?.program;
  if (!(program?.zfa > 0)) throw new Error(`The ${scheme?.label ?? 'requested'} option has no floor area to outline.`);
  const code = envelope?.district ?? ['zonedist1', 'zonedist2', 'zonedist3', 'zonedist4'].map(k => property?.[k]).find(v => typeof v === 'string' && v.trim());
  const district = describeDistrict(code);
  if (!district) throw new Error(`No curated zoning district for ${code ?? 'this lot'}, so its storeys cannot be outlined.`);
  const specialDistricts = envelope?.specialDistricts ?? ['spdist1', 'spdist2', 'spdist3'].map(k => property?.[k]).filter(v => typeof v === 'string' && v.trim());
  const affordable = Boolean(program.key) && program.key !== 'standard';
  const d = ZFA_GROSS_DEDUCTIONS;
  const grossPerZfa = 1 + (affordable ? d.recreationUapPct : d.recreationPct) + d.exteriorWallPct;
  const lotArea = polygonArea(lot.exterior), recordedArea = Number(property?.lotarea) > 0 ? Number(property.lotarea) : lotArea;
  const transitZone = transitZoneOf(property), transitZoneSource = transitZone ? 'PLUTO transit zone' : null;
  // A split lot is outlined district by district when the zoning map placed each district on the lot
  // and every one has curated bulk rules; otherwise under the lot's first district, as it says.
  const mapped = (lot.districts ?? []).map(d => ({...d, district: describeDistrict(d.code)}));
  const districtPortions = mapped.length > 1 && mapped.every(d => d.district) ? mapped : null;
  const inputs = {rules, district, specialDistricts, lot: lot.exterior, frontages: frontages(envelope, property, lot.sideStreet), use: 'residential', affordable, communityDistrict: property?.cd ?? null, transitZone, transitZoneSource, recordedLotAreaSqft: recordedArea, districtPortions};
  const computed = computeEnvelope({...inputs, maxFar: program.zfa * grossPerZfa / recordedArea});
  // The table allowance in zoning floor area, beside the option's own floor area (the envelope above stacks gross).
  const table = computeEnvelope(inputs).floorArea;
  const units = parking({communityDistrict: property?.cd ?? null, dwellingUnits: program.units, districtCode: district.residentialEquivalent ?? district.code, lotAreaSqft: recordedArea, transitZone, transitZoneSource, rules});
  const exported = storeyOutlines(computed, {scheme: scheme.id, lot, grossPerZfa});
  return {...exported, lot: {...exported.lot, recordedAreaSqft: Math.round(recordedArea)}, label: scheme.label ?? null, address: property?.address ?? null, context: lot.context ?? [],
    // Floor area rests on the lot area on record (what the deal model prices); the tax-map polygon only shapes the geometry.
    zoningFloorArea: {allowedFar: table.maxFar, allowedSqft: Math.round(table.maxFar * recordedArea), sections: [...table.sections, ...(affordable ? ['ZR 23-22 (Universal Affordability Preference)'] : [])], optionSqft: program.zfa, optionFar: round(program.zfa / recordedArea), affordableSqft: program.affordableZfa ?? 0},
    parking: units, floorAreaRules: rules.bulk.floorAreaExclusions,
    // The exclusions the deal model prices the option with until a plan draws them: shares of zoning floor area.
    assumedExclusions: {amenityShare: affordable ? d.recreationUapPct : d.recreationPct, exteriorWallShare: d.exteriorWallPct, source: d.source},
    exteriorWallSection: 'ZR 12-10 (qualifying exterior wall thickness)',
    program: {zfa: program.zfa, storeys: program.storeys, units: program.units, affordableZfa: program.affordableZfa ?? 0},
    ...(districtPortions ? {districtPortions: computed.districtPortions} : {}),
    checks: [...computed.checks, ...(lot.unavailable ? [lot.unavailable] : []), ...(mapped.length > 1 && !districtPortions ? [`Split lot: ${mapped.filter(d => !d.district).map(d => d.code).join(', ')} has no curated bulk rules, so the lot is outlined under ${code} alone; read that district's rules for its portion.`] : [])]};
}
