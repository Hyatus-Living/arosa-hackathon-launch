import {requestSignal,throwIfCancelled} from './execution-context.mjs';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {providerJson} from './public-http.mjs';
import {projector} from './context.mjs';
import {planningCommand} from './planning.mjs';
import {rules as ZONING_RULES, describeDistrict, recordedBuildingArea} from './zoning.mjs';

const FOOT = 0.3048;
const MAPPLUTO_QUERY = 'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query';
const round = (n, d = 0) => Number(n.toFixed(d));
const validBbl = value => typeof value === 'string' && /^[1-5]\d{9}$/.test(value);
const canonicalBbl = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const bbl = String(value).trim().replace(/\.0+$/, '');
  return validBbl(bbl) ? bbl : null;
};
const validRing = ring => Array.isArray(ring) && ring.length >= 4
  && ring.every(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
  && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
const mapPolygon = (part, transform) => ({polygon: part.polygon.map(transform), holes: part.holes.map(ring => ring.map(transform))});

// Tax-lot polygons from NYC Planning's MapPLUTO service (the tabular PLUTO dataset has no
// geometry). Returns BBL -> polygons, each with an exterior and holes in lon/lat.
export async function fetchLotGeometry(bbls, request = providerJson) {
  if (!Array.isArray(bbls) || !bbls.length || bbls.some(bbl => !validBbl(bbl))) throw new Error('Use valid ten-digit NYC BBLs for the geometry query.');
  const requested = new Set(bbls);
  const url = new URL(MAPPLUTO_QUERY);
  url.searchParams.set('where', `BBL IN (${bbls.join(',')})`);
  url.searchParams.set('outFields', 'BBL,Address,LotArea');
  url.searchParams.set('f', 'geojson');
  const data = await request(url, {signal: requestSignal(20000)});
  const byBbl = new Map();
  for (const feature of data?.features || []) {
    const bbl = canonicalBbl(feature?.properties?.BBL);
    if (!requested.has(bbl)) continue;
    const geometry = feature?.geometry;
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
    if (!Array.isArray(polygons)) throw new Error(`Invalid MapPLUTO polygon rings for BBL ${bbl}.`);
    const parts = polygons.map(rings => {
      if (!Array.isArray(rings) || !rings.length || !rings.every(validRing)) throw new Error(`Invalid MapPLUTO polygon rings for BBL ${bbl}.`);
      return {polygon: rings[0], holes: rings.slice(1)};
    });
    if (parts.length) byBbl.set(bbl, [...(byBbl.get(bbl) || []), ...parts]);
  }
  return byBbl;
}

// Project every ring into one local frame in feet (x east, z south from true north), then
// translate so the assembly's north-west extent is the origin.
export function toLocalFeet(polygonsByBbl) {
  const points = [...polygonsByBbl.values()].flatMap(parts => parts.flatMap(part => [part.polygon, ...part.holes].flat()));
  const lons = points.map(p => p[0]), lats = points.map(p => p[1]);
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const project = projector(lat0, lon0);
  const converted = new Map();
  let minX = Infinity, minZ = Infinity;
  for (const [bbl, parts] of polygonsByBbl) {
    const feet = parts.map(part => mapPolygon(part, point => {
      const [x, z] = project(point);
      minX = Math.min(minX, x / FOOT); minZ = Math.min(minZ, z / FOOT);
      return [x / FOOT, z / FOOT];
    }));
    converted.set(bbl, feet);
  }
  for (const [bbl, parts] of converted) converted.set(bbl, parts.map(part => mapPolygon(part, ([x, z]) => [round(x - minX, 1), round(z - minZ, 1)])));
  return converted;
}

// One tax lot's MapPLUTO shape, snapped into the envelope frame: the chosen front edge lies on
// z = 0, x runs along it and z goes into the lot, the same frame suggestedLot's rectangle uses.
// The front edge is correctable: pass frontEdge as an edge index from a prior result's edges, or a
// compass side ('north', 'south', 'east', 'west') naming the way the front faces; the default is
// the edge whose length is closest to the PLUTO frontage, else the longest edge. Every edge is
// reported with its length and the compass way it faces so a wrong default can be named and fixed.
export function snapTaxLotOutline(parts, {frontageFeet = null, frontEdge = null} = {}) {
  if (!Array.isArray(parts) || parts.length !== 1) throw new Error(`A tax-lot outline needs exactly one MapPLUTO polygon part; this lot has ${Array.isArray(parts) ? parts.length : 'none'}, so its shape is not one envelope lot.`);
  const ring = parts[0].polygon.slice(0, -1);
  if (ring.length < 3) throw new Error('The MapPLUTO polygon for this lot has fewer than three corners.');
  let cross = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length], c = x1 * z2 - x2 * z1;
    cross += c; cx += (x1 + x2) * c; cz += (z1 + z2) * c;
  }
  const centroid = cross === 0 ? ring[0] : [cx / (3 * cross), cz / (3 * cross)];
  const cardinal = {north: 0, east: 90, south: 180, west: 270};
  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], vx = b[0] - a[0], vz = b[1] - a[1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let nx = vz, nz = -vx;
    if (nx * (centroid[0] - mid[0]) + nz * (centroid[1] - mid[1]) > 0) { nx = -nx; nz = -nz; }
    const bearing = (Math.atan2(nx, -nz) * 180 / Math.PI + 360) % 360;
    return {index: i, lengthFeet: round(Math.hypot(vx, vz), 1), bearingDegrees: round(bearing), compass: ['north', 'east', 'south', 'west'][Math.round(bearing / 90) % 4]};
  });
  let chosen;
  if (Number.isInteger(frontEdge)) {
    if (!edges[frontEdge]) throw new Error(`frontEdge ${frontEdge} is not an edge of this lot; it has ${edges.length} edges (0 to ${edges.length - 1}).`);
    chosen = frontEdge;
  } else if (typeof frontEdge === 'string' && frontEdge in cardinal) {
    const target = cardinal[frontEdge];
    const outward = {north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0]}[frontEdge];
    const extent = e => { const a = ring[e.index], b = ring[(e.index + 1) % ring.length]; return ((a[0] + b[0]) / 2) * outward[0] + ((a[1] + b[1]) / 2) * outward[1]; };
    chosen = edges.reduce((best, e) => {
      const diff = d => Math.min(Math.abs(d - target), 360 - Math.abs(d - target));
      // An inner step can face the same way as the true front; among equal bearings the street
      // edge is the one lying furthest out in that direction.
      return diff(e.bearingDegrees) < diff(edges[best].bearingDegrees) || (diff(e.bearingDegrees) === diff(edges[best].bearingDegrees) && extent(e) > extent(edges[best])) ? e.index : best;
    }, 0);
  } else if (frontEdge != null) throw new Error(`frontEdge must be an edge index or a compass side (${Object.keys(cardinal).join(', ')}).`);
  else if (Number.isFinite(frontageFeet) && frontageFeet > 0) chosen = edges.reduce((best, e) => (Math.abs(e.lengthFeet - frontageFeet) < Math.abs(edges[best].lengthFeet - frontageFeet) ? e.index : best), 0);
  else chosen = edges.reduce((best, e) => (e.lengthFeet > edges[best].lengthFeet ? e.index : best), 0);
  const a = ring[chosen], b = ring[(chosen + 1) % ring.length];
  let angle = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  const rotate = (points, by) => {
    const cos = Math.cos(by), sin = Math.sin(by);
    return points.map(([x, z]) => [(x - a[0]) * cos - (z - a[1]) * sin, (x - a[0]) * sin + (z - a[1]) * cos]);
  };
  let turned = rotate(ring, angle);
  const turnedCentroidZ = turned.reduce((sum, p) => sum + p[1], 0) / turned.length;
  if (turnedCentroidZ < 0) { angle += Math.PI; turned = rotate(ring, angle); }
  const shiftX = Math.min(turned[chosen][0], turned[(chosen + 1) % ring.length][0]);
  let polygon = turned.map(([x, z]) => [round(x - shiftX, 1) + 0, round(z, 1) + 0]);
  let signed = 0;
  for (let i = 0; i < polygon.length; i++) { const [x1, z1] = polygon[i], [x2, z2] = polygon[(i + 1) % polygon.length]; signed += x1 * z2 - x2 * z1; }
  if (signed < 0) polygon = [polygon[0], ...polygon.slice(1).reverse()];
  const depthFeet = round(Math.max(...polygon.map(p => p[1])), 1);
  return {
    polygon, widthFeet: edges[chosen].lengthFeet, depthFeet, frontEdgeIndex: chosen, edges,
    note: `Tax-lot outline from MapPLUTO geometry, snapped so edge ${chosen} (${edges[chosen].lengthFeet} ft, facing ${edges[chosen].compass}) is the front${frontEdge == null ? (Number.isFinite(frontageFeet) && frontageFeet > 0 ? `, picked as the edge closest to the PLUTO frontage of ${frontageFeet} ft` : ', picked as the longest edge') : ' as corrected'}. If that is not the street frontage, rerun with frontEdgeIndex or frontCompass naming the right edge from the edges list.${parts[0].holes.length ? ` The polygon's ${parts[0].holes.length} interior ring(s) are not drawn.` : ''}`,
  };
}

// The snapped tax-lot outline for one BBL, or null when MapPLUTO has no geometry for it.
export async function taxLotOutline(bbl, {frontageFeet = null, frontEdge = null, request} = {}) {
  const geometry = await fetchLotGeometry([bbl], request);
  const parts = geometry.get(bbl);
  if (!parts?.length) return null;
  return snapTaxLotOutline(toLocalFeet(new Map([[bbl, parts]])).get(bbl), {frontageFeet, frontEdge});
}

export function spawnAssembler(request, {planningDir, timeoutMs = 60000} = {}) {
  throwIfCancelled();
  const signal = requestSignal(timeoutMs);
  const {dir, python} = planningCommand(planningDir);
  const script = path.join(dir, 'assemble.py');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, {once:true});
    if(signal.aborted) abort();
    child.stdout.on('data', d => { out += d; if (out.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', error => { signal.removeEventListener('abort', abort); reject(error.code === 'ENOENT' ? new Error('The planning environment is not installed on this host (planning/.venv is missing).') : error); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(signal.reason);
      try {
        const parsed = JSON.parse(out);
        if (code === 0 && !parsed.error) return resolve(parsed);
        reject(new Error(`Assembly failed: ${parsed.error || err.trim() || `exit ${code}`}`));
      } catch { reject(new Error(`Assembly failed: ${err.trim().slice(-300) || `exit ${code}`}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };

export const STREET_SIDES = ['north', 'south', 'east', 'west'];
// Inner court minimums for courts that serve legally required windows (ZR 23-352), as the envelope reports them.
const INNER_COURT = {upTo75Feet: {minAreaSqft: 800, minDimensionFeet: 20}, above75Feet: {minAreaSqft: 1200, minDimensionFeet: 30}};

// The open areas the district requires on an assemblage, by height band, from the curated bulk rules:
// rear yards, rear yard equivalents, low-density front and side yards and residential inner courts.
export function openAreaRules(code, use, rules = ZONING_RULES) {
  const district = describeDistrict(code);
  if (!district || !['residential', 'commercial', 'manufacturing'].includes(district.kind)) throw new Error(`No curated bulk rules for ${code}; give a curated district to draw the assemblage open areas.`);
  const resolvedUse = use ?? (district.kind === 'residential' ? 'residential' : 'commercial');
  const bulk = rules.bulk;
  if (resolvedUse === 'residential') {
    const equivalent = district.residentialEquivalent ? bulk.residential[district.residentialEquivalent] : null;
    if (!equivalent) throw new Error(`No residential bulk table for ${district.code}; it has no curated residential equivalent.`);
    const yards = bulk.residentialCommon.rearYardFeet, equivalents = bulk.residentialCommon.rearYardEquivalentFeet, low = equivalent.lowDensity;
    const rule = {district: district.code, use: resolvedUse, rearYardEquivalentMinLotDepthFeet: equivalents.minLotDepthFeet};
    if (low) return {...rule, sections: ['ZR 12-10', 'ZR 23-321', 'ZR 23-332', 'ZR 23-342', 'ZR 23-343', 'ZR 23-352'], bands: [{fromFeet: 0, toFeet: null, rearYardFeet: low.rearYardFeet, rearYardEquivalentFeet: equivalents.upTo75Feet, frontYardFeet: low.frontYardFeet, sideYardFeet: low.multipleDwellings && low.sideYards.multipleDwellingFeet !== null ? low.sideYards.multipleDwellingFeet : low.sideYards.detachedEachFeet, court: INNER_COURT.upTo75Feet}]};
    return {...rule, sections: ['ZR 12-10', 'ZR 23-342', 'ZR 23-343', 'ZR 23-352'], bands: [
      {fromFeet: 0, toFeet: 75, rearYardFeet: yards.upTo75Feet, rearYardEquivalentFeet: equivalents.upTo75Feet, court: INNER_COURT.upTo75Feet},
      {fromFeet: 75, toFeet: null, rearYardFeet: yards.above75Feet, rearYardEquivalentFeet: equivalents.above75Feet, court: INNER_COURT.above75Feet},
    ]};
  }
  // Commercial and manufacturing floors may fill the rear yard up to one storey (ZR 33-23, 43-23).
  const manufacturing = district.kind === 'manufacturing', common = manufacturing ? bulk.manufacturingCommon : bulk.commercialCommon;
  const noEquivalent = !manufacturing && (common.throughLotNoRearYardDistricts || []).some(d => district.code === d || district.code.startsWith(`${d}-`));
  const equivalentFeet = noEquivalent ? 0 : manufacturing ? common.rearYardEquivalentFeet : 40;
  return {
    district: district.code, use: resolvedUse, rearYardEquivalentMinLotDepthFeet: manufacturing ? common.rearYardEquivalentMinLotDepthFeet : 0,
    sections: ['ZR 12-10', ...common.citations, manufacturing ? 'ZR 43-28' : 'ZR 33-283'],
    bands: [
      {fromFeet: 0, toFeet: common.rearYardObstructionMaxFeet, rearYardFeet: 0, rearYardEquivalentFeet: 0, court: null},
      {fromFeet: common.rearYardObstructionMaxFeet, toFeet: null, rearYardFeet: common.rearYardFeet, rearYardEquivalentFeet: equivalentFeet, court: null},
    ],
  };
}

function openAreaChecks(rule) {
  const checks = [
    'Street lines are the outline\'s lot lines facing the stated street sides. Rear lot lines are the other lot lines within 45 degrees of parallel to a street line that do not meet one (ZR 12-10), the lot lines around land the assembly encloses included, and each takes the full rear yard depth. The rest are side lot lines.',
    'Through portions keep the rear yard equivalent as one strip midway between the street lines; the alternatives at the street lines are not drawn.',
    'Permitted obstructions, the narrow-lot and corner-lot rear yard provisions, lot coverage, setbacks and height limits are not applied: each band\'s footprint is the most it can cover after the required open areas.',
  ];
  if (rule.bands.some(band => band.court)) checks.push('Every open area the footprint encloses on all sides is held to the inner court minimums for courts serving legally required windows (ZR 23-352) and widened into the footprint where it falls short. Land outside the assembly inside a court counts as court area, although its owner may build on it.');
  if (rule.use !== 'residential') checks.push(`Commercial and manufacturing floors may fill the rear yard up to ${rule.bands[0].toFeet} ft, so the lowest band has no rear yard.`);
  return checks;
}

export async function assembleSite({bbls, treatAsOneZoningLot = false, streets, district, use} = {}, {findParcel, fetchGeometry = fetchLotGeometry, run} = {}) {
  if (!Array.isArray(bbls) || bbls.length < 2 || bbls.length > 8) throw new Error('Assemble two to eight parcels by BBL.');
  if (new Set(bbls).size !== bbls.length) throw new Error('Each BBL may appear once.');
  for (const bbl of bbls) if (!validBbl(bbl)) throw new Error(`Use valid ten-digit NYC BBLs; ${bbl} is not one.`);
  if (streets !== undefined && (!Array.isArray(streets) || !streets.length || streets.length > 4 || new Set(streets).size !== streets.length || streets.some(side => !STREET_SIDES.includes(side)))) throw new Error(`streets lists the sides the assembly fronts, each once: ${STREET_SIDES.join(', ')}.`);
  if (use !== undefined && !['residential', 'commercial'].includes(use)) throw new Error('use must be residential or commercial.');
  if (typeof findParcel !== 'function' || typeof run !== 'function') throw new Error('Assembly dependencies are unavailable.');

  throwIfCancelled();
  const rows = new Map();
  let next = 0, failed = false;
  const workers = await Promise.allSettled(Array.from({length: Math.min(4,bbls.length)}, async () => {
    while (!failed && next < bbls.length) {
      throwIfCancelled();
      const bbl = bbls[next++];
      try {
        const result = await findParcel(bbl);
        throwIfCancelled();
        const matches = (result.rows || []).filter(row => canonicalBbl(row.bbl) === bbl);
        if (!matches.length) throw new Error(`No PLUTO parcel matched BBL ${bbl}.`);
        if (matches.length > 1) throw new Error(`Ambiguous PLUTO records for BBL ${bbl}; resolve the duplicate records before assembling.`);
        rows.set(bbl, matches[0]);
      } catch(error) { failed = true; throw error; }
    }
  }));
  const failure = workers.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  let openRule = null;
  if (streets) {
    const zoned = [...new Set(bbls.flatMap(bbl => {const row = rows.get(bbl); return [row.zonedist1, row.zonedist2, row.zonedist3, row.zonedist4].filter(Boolean);}))];
    if (!district && zoned.length !== 1) throw new Error(`The parcels are zoned ${zoned.join(', ') || 'with no district on record'}; give district to draw the open areas.`);
    openRule = openAreaRules(district ?? zoned[0], use);
  }
  throwIfCancelled();
  const fetchedGeometry = await fetchGeometry(bbls);
  const geometry = new Map(bbls.map(bbl => [bbl, fetchedGeometry.get(bbl)]));
  for (const bbl of bbls) if (!geometry.get(bbl)?.length) throw new Error(`MapPLUTO returned no lot polygon for BBL ${bbl}; the assembly cannot be drawn.`);
  const local = toLocalFeet(geometry);
  throwIfCancelled();
  const assembled = await run({parcels: bbls.map(bbl => ({bbl, polygons: local.get(bbl)})), ...(openRule ? {openAreas: {streets, bands: openRule.bands, rearYardEquivalentMinLotDepthFeet: openRule.rearYardEquivalentMinLotDepthFeet}} : {})});
  throwIfCancelled();
  if (assembled?.error) throw new Error(`Assembly failed: ${assembled.error}`);

  const parcels = bbls.map(bbl => {
    const row = rows.get(bbl), built = recordedBuildingArea(row);
    return {
      bbl, address: row.address || null, borough: row.borough || null,
      zoning: [row.zonedist1, row.zonedist2, row.zonedist3, row.zonedist4].filter(Boolean),
      lotAreaSqft: num(row.lotarea), builtFloorAreaSqft: built, builtFar: built === null ? null : num(row.builtfar),
      polygons: local.get(bbl),
    };
  });
  const plutoTotal = parcels.reduce((sum, p) => sum + (p.lotAreaSqft ?? 0), 0);
  const hasHoles = assembled.parts.some(part => part.holes.length > 0);
  return {
    parcels,
    assembled: {
      polygon: assembled.singlePolygon && !hasHoles ? assembled.parts[0]?.polygon || null : null,
      parts: assembled.parts,
      partsCount: assembled.parts.length,
      singlePolygon: assembled.singlePolygon,
      hasHoles,
      totalAreaSqft: assembled.totalAreaSqft,
      plutoLotAreaTotalSqft: round(plutoTotal),
      areaDeltaSqft: round(assembled.totalAreaSqft - plutoTotal),
      pairs: assembled.pairs,
      frame: 'Local feet: x east, z south from true north, origin at the assembly’s north-western extent.',
    },
    zoningDistricts: [...new Set(parcels.flatMap(p => p.zoning))],
    ...(openRule ? {openAreas: {district: openRule.district, use: openRule.use, ...assembled.openAreas, sections: openRule.sections, checks: openAreaChecks(openRule)}} : {}),
    treatAsOneZoningLot: treatAsOneZoningLot === true,
    note: 'Tax-lot polygons include their interior voids and are unioned with a 0.8 ft sliver tolerance; shared-boundary lengths are approximate within that tolerance and areas are GIS areas, not survey areas. A single outline is supplied only for one part without interior voids. Assembling lots here does not create a zoning lot; that takes common ownership or party-in-interest control and a recorded zoning lot development agreement. The geometry is true-north, not rotated to a street wall: confirm which sides face streets before modeling. With streets given, openAreas holds the yards and courts the district requires on the merged geometry and the footprint left in each height band, as GIS geometry to verify against a survey and the current Zoning Resolution.',
    sources: [{title: 'NYC Planning MapPLUTO tax lot polygons (ArcGIS)', url: MAPPLUTO_QUERY}, {title: 'NYC Planning PLUTO parcel records', url: 'https://data.cityofnewyork.us/resource/64uk-42ks.json'}],
  };
}

export const assemblyDefinition = {
  name: 'acres_assemble_site',
  description: 'Assemble two to eight NYC tax lots by BBL using their MapPLUTO geometry and PLUTO records. Returns polygon exteriors with their interior holes in one local feet frame, net GIS area against PLUTO, pairwise contiguity and zoning districts; a parcel’s builtFloorAreaSqft is null when PLUTO does not record the area of a building it shows. Give streets (the compass sides the assembly fronts, confirmed from the map) to get openAreas: the open areas the zoning requires on the merged geometry, holes and separate parts included (rear yards along every rear lot line, rear yard equivalents on through portions, low-density front and side yards, residential inner court minimums), with the buildable footprint left in each height band. Use assembled.polygon for envelope or concept input only when it is present, after confirming street frontages. A null polygon means the site has holes or separate parts: preserve assembled.parts and their holes, and use openAreas for the yards and courts, since the envelope and concept tools accept one outer ring. Assembling here does not create a zoning lot; flag non-contiguity and the recorded-instrument requirement.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      bbls: {type: 'array', minItems: 2, maxItems: 8, items: {type: 'string'}, description: 'Ten-digit NYC BBLs of the parcels to assemble. Resolve addresses with acres_find_property first.'},
      treatAsOneZoningLot: {type: 'boolean', description: 'Set only when the user states the lots are (or will be) one zoning lot under common control; the result records the assertion, it does not create the merger.'},
      streets: {type: 'array', minItems: 1, maxItems: 4, items: {type: 'string', enum: STREET_SIDES}, description: 'Compass sides of the assembly that front streets (the frame is true north). Required for openAreas.'},
      district: {type: 'string', description: 'Zoning district whose yard and court rules apply, e.g. R7A. Defaults to the parcels\' district when they share one.'},
      use: {type: 'string', enum: ['residential', 'commercial'], description: 'Use whose open-area rules apply; defaults to residential in residence districts and commercial elsewhere.'},
    },
    required: ['bbls'],
  },
};

export function createAssemblyTools({findParcel, planningDir, run, available, emit = () => {}} = {}) {
  const {dir, python} = planningCommand(planningDir);
  const ready = available ?? (existsSync(python) && existsSync(path.join(dir, 'assemble.py')));
  const runner = run || (request => spawnAssembler(request, {planningDir}));
  let assembly = null;
  async function assemble(args = {}) {
    const out = await assembleSite(args, {findParcel, run: runner});
    assembly = out;
    emit('assembly.completed', {bbls: out.parcels.map(p => p.bbl), totalAreaSqft: out.assembled.totalAreaSqft});
    return out;
  }
  return {definitions: ready ? [assemblyDefinition] : [], handlers: ready ? {acres_assemble_site: assemble} : {}, get assembly() { return assembly; }};
}
