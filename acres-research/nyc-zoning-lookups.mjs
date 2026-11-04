import {providerJson} from './public-http.mjs';
import {fetchLotGeometry} from './assembly.mjs';
import {projector} from './context.mjs';
import {transitZoneOf} from './envelope.mjs';
import {MIH_AREAS_URL, normalizeMihArea, mihAreaAt, availableMihOptions, MIH_RULES} from './mih-areas.mjs';

// Parcel facts PLUTO cannot give, read live from the agencies that map them: the zoning districts,
// commercial overlays and special districts covering the lot today and the share of the lot in
// each (DCP zoning map layers), the mapped widths of the streets the lot fronts (DCP Digital City
// Map), the Mandatory Inclusionary Housing area holding the lot (DCP, NYC Open Data), and the
// existing building's zoning floor area as stated on its DOB filings.
const DCP = 'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services';
export const ZONING_LAYERS = {
  districts: {url: `${DCP}/nyzd/FeatureServer/0`, field: 'ZONEDIST'},
  overlays: {url: `${DCP}/nyco/FeatureServer/0`, field: 'OVERLAY'},
  specialDistricts: {url: `${DCP}/nysp/FeatureServer/0`, field: 'SDLBL'},
};
export const STREET_CENTERLINES_URL = `${DCP}/DCM_Street_Center_Line/FeatureServer/0`;
export const TRANSIT_ZONES_URL = `${DCP}/Transit_Zones/FeatureServer/0`;
export async function transitZoneForPoint(latitude,longitude,{request=providerJson}={}) {
  const url=new URL(`${TRANSIT_ZONES_URL}/query`);
  for(const [key,value] of Object.entries({f:'json',geometry:JSON.stringify({x:Number(longitude),y:Number(latitude)}),geometryType:'esriGeometryPoint',inSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'TranstZone',returnGeometry:'false'}))url.searchParams.set(key,value);
  const out=await request(url.href);
  if(out.error)throw new Error(out.error.message);
  const labels=[...new Set(out.features.map(f=>f.attributes.TranstZone))];
  const zones={'Inner Transit Zone':'inner','Outer Transit Zone':'outer','Beyond the Greater Transit Zone':'beyond','Manhattan Core and Long Island City Parking Areas':'core-or-lic','Special 25-241 Parking Provisions':'special-25-241'};
  return {zone:labels.length===1?zones[labels[0]]??null:null,labels,sourceUrl:TRANSIT_ZONES_URL,note:'DCP Transit Zones Parking Geographies, point at the PLUTO location. Text controls in a boundary conflict (ZR 12-10). Multiple or unknown zones remain unresolved.'};
}
export const DOB_BIS_FILINGS_URL = 'https://data.cityofnewyork.us/resource/ic3t-wcy2.json';
const FOOT = 0.3048;
const WIDE_STREET_FEET = 75;
// Zoning boundaries and tax lots are digitized separately, so a lot shows thin slivers of the
// districts across its lot lines; shares under this are boundary noise, not a split.
export const SLIVER_SHARE = 0.01;
const round = (n, d = 0) => Number(n.toFixed(d));

// ---- Plane geometry in feet --------------------------------------------------------------------

const open = ring => (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring);
const signedArea = ring => ring.reduce((sum, [x1, y1], i) => { const [x2, y2] = ring[(i + 1) % ring.length]; return sum + x1 * y2 - x2 * y1; }, 0) / 2;
export const ringArea = ring => Math.abs(signedArea(open(ring)));
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// Ear clipping of a simple ring into triangles, counter-clockwise.
export function triangulate(ring) {
  let pts = open(ring);
  if (signedArea(pts) < 0) pts = [...pts].reverse();
  const tris = [];
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  while (pts.length > 3) {
    let clipped = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const turn = cross(a, b, c);
      if (turn < 0) continue;
      if (turn > 0 && pts.some(p => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      if (turn > 0) tris.push([a, b, c]);
      pts = pts.filter((_, j) => j !== i);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('Lot outline is not a simple polygon, so it cannot be split by district.');
  }
  if (pts.length === 3 && cross(...pts) > 0) tris.push(pts);
  return tris;
}

// Sutherland-Hodgman: any ring clipped to a counter-clockwise triangle. The result's area is exact
// even for a concave subject; its degenerate edges along the triangle carry no area.
export function clipToTriangle(ring, tri) {
  let out = open(ring);
  for (let i = 0; i < 3 && out.length; i++) {
    const a = tri[i], b = tri[(i + 1) % 3], input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const pIn = cross(a, b, p) >= 0, qIn = cross(a, b, q) >= 0;
      if (pIn) out.push(p);
      if (pIn !== qIn) {
        const t = cross(a, b, p) / (cross(a, b, p) - cross(a, b, q));
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

// Area of the lot parts that a set of polygons covers; parts and polygons are {polygon, holes}.
export function coveredArea(lotParts, polygons) {
  const within = tri => polygons.reduce((sum, {polygon, holes}) => sum + ringArea(clipToTriangle(polygon, tri)) - holes.reduce((h, hole) => h + ringArea(clipToTriangle(hole, tri)), 0), 0);
  const over = ring => triangulate(ring).reduce((sum, tri) => sum + within(tri), 0);
  return lotParts.reduce((sum, {polygon, holes}) => sum + over(polygon) - holes.reduce((h, hole) => h + over(hole), 0), 0);
}

const lotArea = parts => parts.reduce((sum, {polygon, holes}) => sum + ringArea(polygon) - holes.reduce((h, r) => h + ringArea(r), 0), 0);

const segmentDistance = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const segmentsIntersect = (a, b, c, d) => cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
const edges = ring => open(ring).map((p, i, r) => [p, r[(i + 1) % r.length]]);
// Shortest distance between a polyline and a ring's boundary, with the polyline segment it is on.
function lineToRing(line, ring) {
  let best = {distance: Infinity, segment: null};
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    for (const [c, d] of edges(ring)) {
      const distance = segmentsIntersect(a, b, c, d) ? 0 : Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b));
      if (distance < best.distance) best = {distance, segment: [a, b]};
    }
  }
  return best;
}

// ---- Shared fetch and projection -----------------------------------------------------------------

const toParts = geometry => (geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []).map(rings => ({polygon: rings[0], holes: rings.slice(1)}));
const mapParts = (parts, f) => parts.map(({polygon, holes}) => ({polygon: polygon.map(f), holes: holes.map(r => r.map(f))}));
const bounds = parts => {
  const pts = parts.flatMap(p => p.polygon);
  return {west: Math.min(...pts.map(p => p[0])), east: Math.max(...pts.map(p => p[0])), south: Math.min(...pts.map(p => p[1])), north: Math.max(...pts.map(p => p[1]))};
};

async function layerFeatures(url, box, outFields, request, where = '1=1') {
  const q = new URL(`${url}/query`);
  Object.entries({where, geometry: `${box.west},${box.south},${box.east},${box.north}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields, outSR: '4326', geometryPrecision: '7', f: 'geojson'}).forEach(([k, v]) => q.searchParams.set(k, v));
  const data = await request(q);
  if (!Array.isArray(data?.features)) throw new Error(`DCP layer ${url} returned no feature collection.`);
  return data.features;
}

// The lot outline from MapPLUTO in feet, with the projection used for every other layer.
async function lotFrame(bbl, request) {
  const parts = (await fetchLotGeometry([bbl], request)).get(bbl);
  if (!parts?.length) throw new Error(`MapPLUTO has no lot outline for BBL ${bbl}.`);
  const box = bounds(parts);
  const project = projector((box.south + box.north) / 2, (box.west + box.east) / 2);
  const feet = point => project(point).map(v => v / FOOT);
  return {parts, box, feet, lot: mapParts(parts, feet)};
}

// ---- Current zoning and split-lot shares -----------------------------------------------------------

// The districts, overlays and special districts on the lot as DCP maps them now, each with its share
// of the lot; shares are of the lot's mapped outline and are applied to PLUTO's lot area by callers.
export async function currentZoning(bbl, {request = providerJson} = {}) {
  const frame = await lotFrame(bbl, request);
  const total = lotArea(frame.lot);
  const shares = async ({url, field}) => {
    const byCode = new Map();
    for (const f of await layerFeatures(url, frame.box, field, request)) {
      const code = String(f.properties?.[field] ?? '').trim();
      if (code) byCode.set(code, [...(byCode.get(code) || []), ...mapParts(toParts(f.geometry), frame.feet)]);
    }
    const all = [...byCode].map(([code, polygons]) => ({code, share: coveredArea(frame.lot, polygons) / total})).filter(s => s.share > 0);
    return {
      kept: all.filter(s => s.share >= SLIVER_SHARE).sort((a, b) => b.share - a.share).map(s => ({code: s.code, sharePercent: round(s.share * 100, 1)})),
      slivers: all.filter(s => s.share < SLIVER_SHARE).map(s => s.code),
    };
  };
  const [districts, overlays, specialDistricts] = await Promise.all(Object.values(ZONING_LAYERS).map(shares));
  return {
    bbl, mappedLotAreaSqft: round(total), districts: districts.kept, overlays: overlays.kept, specialDistricts: specialDistricts.kept,
    sliversIgnored: [...districts.slivers, ...overlays.slivers, ...specialDistricts.slivers],
    source: 'NYC Department of City Planning zoning map layers (nyzd, nyco, nysp) intersected with the MapPLUTO lot outline',
    sourceUrl: ZONING_LAYERS.districts.url,
  };
}

// The ring's part inside an axis-aligned box (Sutherland-Hodgman, one side at a time).
function clipRingToBox(ring, {west, east, south, north}) {
  const side = (pts, inside, cut) => pts.flatMap((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return [...(inside(a) ? [a] : []), ...(inside(a) !== inside(b) ? [cut(a, b)] : [])];
  });
  const at = axis => v => (a, b) => { const t = (v - a[axis]) / (b[axis] - a[axis]); return axis === 0 ? [v, a[1] + t * (b[1] - a[1])] : [a[0] + t * (b[0] - a[0]), v]; };
  let pts = open(ring);
  pts = side(pts, p => p[0] >= west, at(0)(west));
  pts = pts.length ? side(pts, p => p[0] <= east, at(0)(east)) : pts;
  pts = pts.length ? side(pts, p => p[1] >= south, at(1)(south)) : pts;
  pts = pts.length ? side(pts, p => p[1] <= north, at(1)(north)) : pts;
  return pts.length >= 3 ? pts : null;
}

// Each district mapped on a split lot, with its share of the lot and its polygons around the lot in
// longitude and latitude, cut to a box about 20 m larger than the lot. The planning engine intersects
// them with the lot to draw each portion under its own district (ZR 77-27, 77-28).
export async function districtParts(bbl, {request = providerJson} = {}) {
  const frame = await lotFrame(bbl, request);
  const total = lotArea(frame.lot), pad = 0.0002;
  const box = {west: frame.box.west - pad, east: frame.box.east + pad, south: frame.box.south - pad, north: frame.box.north + pad};
  const byCode = new Map();
  for (const f of await layerFeatures(ZONING_LAYERS.districts.url, frame.box, ZONING_LAYERS.districts.field, request)) {
    const code = String(f.properties?.[ZONING_LAYERS.districts.field] ?? '').trim();
    if (code) byCode.set(code, [...(byCode.get(code) || []), ...toParts(f.geometry)]);
  }
  return [...byCode].map(([code, parts]) => ({code, share: coveredArea(frame.lot, mapParts(parts, frame.feet)) / total, parts}))
    .filter(d => d.share >= SLIVER_SHARE).sort((a, b) => b.share - a.share)
    .map(({code, share, parts}) => ({code, sharePercent: round(share * 100, 1), parts: parts.map(({polygon, holes}) => ({polygon: clipRingToBox(polygon, box), holes: holes.map(h => clipRingToBox(h, box)).filter(Boolean)})).filter(p => p.polygon)}));
}

// ---- Street widths ---------------------------------------------------------------------------------

// DCM widths are numbers, approximations (~60), bounds (<60, >100) or ranges (60-100). A width is
// taken from a stated, approximate or ranged width; a bound gives one only when it settles a wide street.
export function parseStreetWidth(raw) {
  const text = String(raw ?? '').trim();
  const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return {raw: text || null, widthFeet: null, wide: null};
  if (/^</.test(text)) return {raw: text, widthFeet: null, wide: nums[0] <= WIDE_STREET_FEET ? false : null};
  if (/^>/.test(text)) return {raw: text, widthFeet: nums[0] >= WIDE_STREET_FEET ? nums[0] : null, wide: nums[0] >= WIDE_STREET_FEET ? true : null, lowerBound: true};
  const lo = Math.min(...nums), hi = Math.max(...nums);
  if (lo === hi) return {raw: text, widthFeet: lo, wide: lo >= WIDE_STREET_FEET, ...(text.startsWith('~') ? {approximate: true} : {})};
  // A range is the street's least and greatest mapped width along its length; the least governs.
  return {raw: text, widthFeet: lo, wide: lo >= WIDE_STREET_FEET ? true : hi < WIDE_STREET_FEET ? false : null, range: true};
}

const STREET_WORDS = {ST: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', PL: 'PLACE', RD: 'ROAD', DR: 'DRIVE', BLVD: 'BOULEVARD', PKWY: 'PARKWAY', LN: 'LANE', TER: 'TERRACE', CT: 'COURT', SQ: 'SQUARE', HWY: 'HIGHWAY', N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST'};
export const streetKey = name => String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  .map(w => STREET_WORDS[w] ?? w.replace(/^(\d+)(ST|ND|RD|TH)$/, '$1')).join(' ');
const addressStreet = address => streetKey(String(address || '').replace(/^\s*[\d-]+[A-Z]?\s+/i, ''));

// Mapped streets the lot fronts: a street fronts the lot when its centerline lies within half its
// width (30 ft when unknown) plus 10 ft of the lot line. The PLUTO address street is the front; a
// fronting street roughly parallel to it is the rear (a through lot), any other is a side (a corner).
export async function frontingStreets(property, {request = providerJson} = {}) {
  const frame = await lotFrame(String(property.bbl).split('.')[0], request);
  const pad = 200 * FOOT / 111320;
  const box = {west: frame.box.west - pad / Math.cos(frame.box.south * Math.PI / 180), east: frame.box.east + pad / Math.cos(frame.box.south * Math.PI / 180), south: frame.box.south - pad, north: frame.box.north + pad};
  const features = await layerFeatures(STREET_CENTERLINES_URL, box, 'Street_NM,Streetwidth,Feat_Type', request, "Feat_Type='Mapped_St'");
  const ring = frame.lot[0].polygon;
  const target = addressStreet(property.address);
  const byName = new Map(), widthsByName = new Map();
  for (const f of features) {
    const width = parseStreetWidth(f.properties?.Streetwidth), name = String(f.properties?.Street_NM || '').trim();
    if (Number.isFinite(width.widthFeet)) {
      const lines=f.geometry?.type==='LineString'?[f.geometry.coordinates]:f.geometry?.type==='MultiLineString'?f.geometry.coordinates:[];
      const distance=Math.min(...lines.map(line=>lineToRing(line.map(frame.feet),ring).distance));
      widthsByName.set(name,[...(widthsByName.get(name)||[]),{...width,distance}]);
    }
  }
  for (const f of features) {
    const lines = f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates : [];
    const width = parseStreetWidth(f.properties?.Streetwidth);
    // Tax lots and centerlines are digitized separately and can disagree by more than 10 ft at a street line;
    // the address street, known to front the lot, gets 15 ft, any other street 10 ft.
    const reach = (width.widthFeet ?? 60) / 2 + (streetKey(f.properties?.Street_NM) === target ? 15 : 10);
    for (const line of lines) {
      const near = lineToRing(line.map(frame.feet), ring);
      if (near.distance > reach) continue;
      const name = String(f.properties?.Street_NM || '').trim();
      const prior = byName.get(name);
      if (!prior || near.distance < prior.distance) byName.set(name, {name, ...width, distance: near.distance, segment: near.segment});
    }
  }
  // A segment with no width uses the nearest mapped width on that same street in the search box.
  // Equidistant segments use the lower width.
  const streets = [...byName.values()].map(s => {
    const others = Number.isFinite(s.widthFeet) || s.wide !== null ? null : widthsByName.get(s.name);
    if (!others?.length) return s;
    const least = others.reduce((a,b)=>b.distance<a.distance||(b.distance===a.distance&&b.widthFeet<a.widthFeet)?b:a);
    return {...s, widthFeet: least.widthFeet, wide: least.wide, widthFrom: 'nearest mapped segment of the same street'};
  });
  if (!streets.length) return {streets: [], note: 'The Digital City Map shows no mapped street along this lot.'};
  const front = streets.find(s => streetKey(s.name) === target) ?? [...streets].sort((a, b) => a.distance - b.distance)[0];
  const angle = s => Math.atan2(s.segment[1][1] - s.segment[0][1], s.segment[1][0] - s.segment[0][0]);
  const sides = ['right', 'left'];
  const placed = streets.map(s => {
    if (s === front) return {...s, side: 'front'};
    const turn = Math.abs(Math.sin(angle(s) - angle(front)));
    return {...s, side: turn < 0.5 ? 'rear' : sides.shift() ?? 'left'};
  });
  const ranked = placed.sort((a, b) => ['front', 'rear', 'right', 'left'].indexOf(a.side) - ['front', 'rear', 'right', 'left'].indexOf(b.side));
  const seen = new Set();
  return {
    streets: ranked.filter(s => !seen.has(s.side) && seen.add(s.side)).map(({segment, distance, ...s}) => ({...s, distanceFromLotFeet: round(distance, 1)})),
    frontMatchedAddress: streetKey(front.name) === target,
    source: 'NYC Department of City Planning Digital City Map street centerlines (mapped widths)',
    sourceUrl: STREET_CENTERLINES_URL,
  };
}

// ---- Mandatory Inclusionary Housing ----------------------------------------------------------------

export async function mihAreaForPoint(latitude, longitude, {request = providerJson, now = Date.now()} = {}) {
  const url = new URL(MIH_AREAS_URL);
  url.searchParams.set('$select', 'the_geom,boro,cd,project_nam,project_id,zr_ulurpno,date_adopte,mih_option');
  url.searchParams.set('$where', `intersects(the_geom, 'POINT (${Number(longitude)} ${Number(latitude)})')`);
  const rows = await request(url);
  const area = mihAreaAt(rows.map(normalizeMihArea), latitude, longitude);
  if (!area) return {inMihArea: false, source: MIH_RULES.source, sourceUrl: MIH_AREAS_URL};
  const available = availableMihOptions(area, now);
  return {
    inMihArea: true, name: area.name, ulurp: area.ulurp, adopted: area.adopted, mappedOptions: area.options,
    availableOptions: available.map(key => ({key, ...MIH_RULES.options[key]})),
    smallProjectExemption: MIH_RULES.smallProject,
    source: MIH_RULES.source, sourceUrl: MIH_AREAS_URL,
  };
}

// ---- Existing zoning floor area from DOB filings ---------------------------------------------------

const BOROUGHS = {1: 'MANHATTAN', 2: 'BRONX', 3: 'BROOKLYN', 4: 'QUEENS', 5: 'STATEN ISLAND'};
const mdy = text => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(text || '')); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
// ZFA is gross floor area less exclusions, so a stated existing ZFA well outside this share of the
// PLUTO building area describes a work area or another building, not the whole existing building.
const ZFA_SHARE_OF_GFA = [0.5, 1.1];

// The existing building's zoning floor area as its owner's architect stated it to DOB: a signed-off
// new building or major alteration states the as-built ZFA as its proposal; otherwise the latest
// filing that states an existing ZFA. DOB NOW publishes no ZFA, so only BIS-era filings qualify.
export async function filedExistingZfa(property, {request = providerJson} = {}) {
  const bbl = String(property.bbl).split('.')[0];
  const url = new URL(DOB_BIS_FILINGS_URL);
  url.searchParams.set('$select', 'job__,doc__,job_type,job_status_descrp,pre__filing_date,latest_action_date,signoff_date,existing_zoning_sqft,proposed_zoning_sqft');
  // BIS keys blocks and lots both zero-padded and bare.
  const block = bbl.slice(1, 6), lot = String(Number(bbl.slice(6)));
  url.searchParams.set('$where', `borough='${BOROUGHS[bbl[0]]}' AND block IN ('${block}','${Number(block)}') AND lot IN ('${lot.padStart(5, '0')}','${lot}') AND (existing_zoning_sqft > 0 OR proposed_zoning_sqft > 0)`);
  url.searchParams.set('$limit', '200');
  const rows = await request(url);
  const filings = rows.map(r => ({
    jobNumber: r.job__, doc: r.doc__, jobType: r.job_type, status: r.job_status_descrp, filingDate: mdy(r.pre__filing_date), signoffDate: mdy(r.signoff_date),
    existingZoningSqft: Number(r.existing_zoning_sqft) || null, proposedZoningSqft: Number(r.proposed_zoning_sqft) || null,
  })).sort((a, b) => String(b.filingDate).localeCompare(String(a.filingDate)));
  const gfa = Number(property.bldgarea) || 0;
  const plausible = sqft => !(gfa > 0) || (sqft >= gfa * ZFA_SHARE_OF_GFA[0] && sqft <= gfa * ZFA_SHARE_OF_GFA[1]);
  const completed = filings.find(f => /^(NB|A1)$/.test(f.jobType) && f.signoffDate && f.proposedZoningSqft && plausible(f.proposedZoningSqft));
  const stated = filings.find(f => f.existingZoningSqft && plausible(f.existingZoningSqft));
  const pick = completed && (!stated || completed.filingDate >= stated.filingDate)
    ? {existingZfaSqft: completed.proposedZoningSqft, basis: `signed-off ${completed.jobType} job ${completed.jobNumber} (signed off ${completed.signoffDate}) proposed this zoning floor area, which is the building as built`, filing: completed}
    : stated ? {existingZfaSqft: stated.existingZoningSqft, basis: `${stated.jobType} job ${stated.jobNumber} (${stated.status || 'status not recorded'}, filed ${stated.filingDate || 'on an unrecorded date'}) states this existing zoning floor area`, filing: stated} : null;
  const rejected = [...new Set(filings.filter(f => f.existingZoningSqft && !plausible(f.existingZoningSqft)).map(f => f.jobNumber))].slice(0, 5);
  return {
    ...(pick ?? {existingZfaSqft: null, basis: filings.length ? 'no DOB filing states an existing zoning floor area consistent with the PLUTO building area' : 'no DOB BIS filing on this lot states a zoning floor area'}),
    ...(rejected.length ? {implausibleJobs: rejected} : {}),
    plutoGrossSqft: gfa || null,
    source: 'NYC DOB Job Application Filings (BIS), existing and proposed zoning floor area as filed', sourceUrl: DOB_BIS_FILINGS_URL,
  };
}

// The four lookups for one parcel, each settled on its own so one outage never hides the others,
// and memoized per BBL for the run.
export function createParcelLookups({request = providerJson, now = () => Date.now()} = {}) {
  const memo = new Map();
  return property => {
    const bbl = String(property?.bbl || '').split('.')[0];
    if (!/^[1-5]\d{9}$/.test(bbl)) return Promise.resolve(null);
    if (!memo.has(bbl)) {
      memo.set(bbl, Promise.allSettled([
        currentZoning(bbl, {request}),
        frontingStreets(property, {request}),
        Number(property.latitude) && Number(property.longitude) ? mihAreaForPoint(property.latitude, property.longitude, {request, now: now()}) : Promise.reject(new Error('PLUTO has no coordinates for this lot')),
        filedExistingZfa(property, {request}),
        transitZoneOf(property) ? Promise.resolve(null) : Number(property.latitude) && Number(property.longitude) ? transitZoneForPoint(property.latitude, property.longitude, {request}) : Promise.reject(new Error('PLUTO has no coordinates for this lot')),
      ]).then(([zoning, streets, mih, existing, transitZone]) => {
        const value = r => (r.status === 'fulfilled' ? r.value : null), why = r => (r.status === 'rejected' ? r.reason?.message || String(r.reason) : null);
        return {
          zoning: value(zoning), streets: value(streets), mih: value(mih), existingZfa: value(existing), transitZone: value(transitZone),
          unavailable: Object.fromEntries(Object.entries({zoning, streets, mih, existingZfa: existing, transitZone}).filter(([, r]) => r.status === 'rejected').map(([k, r]) => [k, why(r)])),
        };
      }));
    }
    return memo.get(bbl);
  };
}
