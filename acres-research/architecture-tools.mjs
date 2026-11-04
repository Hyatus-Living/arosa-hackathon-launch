import {requestSignal,throwIfCancelled} from './execution-context.mjs';
// The research agent's floor plan tools: find a published 2D plan for a building, attach it to
// the project's drawings, read the current plan revision, and save a new revision. Saves go
// through the same Architecture.save as the editor (parent revision guard, geometry build), so
// an open editor sees the agent's revision on the project event stream. The plan document
// helpers come from the editor's own intake module so both sides draw and validate alike.
import {lookup as dnsLookup} from 'node:dns/promises';
import {parseHTML,DOMParser} from 'linkedom';
import {publicUrl} from './public-url.mjs';
import {SceneBridge} from '@pascal-app/mcp';
import {fetchDrawing,sniffDrawing} from './architecture-drawings.mjs';
import {pascalSceneToPlan} from './pascal-import.mjs';
import {extractText} from './knowledge-refresh.mjs';
import {SCHEME_IDS} from './schemes.mjs';
import {spawnPlanner} from './planning.mjs';
import {PLAN_SCHEMA,DEFAULTS,detectRooms,validatePlan,exportPlan,nearestWall,wallLength,roomArea,sanitizeSvg,extractPrimitives,proposeFromPrimitives,readingLosses,calibrate,planFromDrawing} from './plan-intake.mjs';

// Short-term and furnished rental platforms and their analytics are never plan sources.
const EXCLUDED = /(^|\.)(airbnb\.[a-z.]+|muscache\.com|insideairbnb\.com|mashvisor\.com|vacasa\.com|evolve\.com|vrbo\.com|homeaway\.[a-z.]+|booking\.com|expedia\.[a-z.]+|hotels\.com|tripadvisor\.[a-z.]+|furnishedfinder\.com|blueground\.com|sonder\.com|airdna\.co|zeusliving\.com|kasa\.com|mindtheapp\.com|anyplace\.com|outsite\.co)$|furnished|corporatehousing/;
export function excludedSource(url) {
  try { return EXCLUDED.test(new URL(url).hostname.toLowerCase()); } catch { return true; }
}

const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };
const FLOOR = /floor[\s_-]*plans?|floorplan|\bfp[\s_-]?\d*\b|\blayout\b/i;
const OFFERING = /brochure|offering|memorandum|\bom\b|setup|marketing|leasing|plans?\b/i;
const kindOf = url => {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.pdf')) return 'pdf';
  if (path.endsWith('.svg')) return 'svg';
  return /\.(png|jpe?g|webp|gif)$/.test(path) ? 'image' : null;
};

// Floor plan candidates on one HTML page: images and links whose address or text names a plan,
// and linked PDFs that read like brochures or offering memoranda.
export function planCandidates(html, pageUrl) {
  const {document} = parseHTML(html);
  const out = new Map();
  const add = (raw, text, tag) => {
    let url;
    try { url = new URL(raw.trim(), pageUrl).href; } catch { return; }
    if (!publicUrl(url) || excludedSource(url) || out.has(url)) return;
    const kind = tag === 'img' ? 'image' : kindOf(url);
    if (!kind) return;
    const label = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const haystack = `${decoded(new URL(url).pathname)} ${label}`;
    const score = (FLOOR.test(haystack) ? 3 : 0) + (kind === 'pdf' && OFFERING.test(haystack) ? 2 : 0);
    if (score >= 2) out.set(url, {url, kind, foundOn: pageUrl, foundVia: tag === 'a' ? 'page link' : 'page image', label: label || null, score});
  };
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || (img.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
    if (src && !src.startsWith('data:')) add(src, [img.getAttribute('alt'), img.getAttribute('title')].filter(Boolean).join(' '), 'img');
  }
  for (const a of document.querySelectorAll('a[href]')) add(a.getAttribute('href'), a.textContent || a.getAttribute('title'), 'a');
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

// Rectangular rooms to a plan document: every room edge becomes wall, collinear edges merge so a
// shared wall is drawn once, rooms are the closed faces of the walls, named by the rectangle
// whose centre lies inside them, and openings sit on the wall nearest their point.
export function draftPlan({name, units = 'ft', height, wallThickness, rooms, openings = []}) {
  if (!['ft', 'm'].includes(units)) throw new Error('units must be ft or m.');
  if (!Array.isArray(rooms) || !rooms.length || rooms.length > 200) throw new Error('Give 1 to 200 rooms.');
  const f = units === 'm' ? 1 : 0.3048, r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const num = (v, what) => { if (!Number.isFinite(v)) throw new Error(`${what} must be a number.`); return v; };
  const rects = rooms.map((r, i) => {
    if (typeof r?.name !== 'string' || !r.name.trim() || r.name.length > 80) throw new Error(`rooms[${i}].name must be 1 to 80 characters.`);
    const [x, y, w, d] = ['x', 'y', 'width', 'depth'].map(k => num(r[k], `rooms[${i}].${k}`));
    if (w <= 0 || d <= 0) throw new Error(`rooms[${i}] needs a width and depth above zero.`);
    return {name: r.name.replace(/\s*[\u2013\u2014]\s*/g, ', ').trim(), x0: r6(x * f), y0: r6(y * f), x1: r6((x + w) * f), y1: r6((y + d) * f)};
  });
  // Edges within 2 cm of each other are one edge, so rooms read off rounded dimensions still meet.
  const snap = () => { const seen = []; return v => seen.find(s => Math.abs(s - v) <= 0.02) ?? (seen.push(v), v); };
  const sx = snap(), sy = snap();
  for (const r of rects) { r.x0 = sx(r.x0); r.x1 = sx(r.x1); r.y0 = sy(r.y0); r.y1 = sy(r.y1); }
  rects.forEach((a, i) => rects.slice(i + 1).forEach(b => {
    if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.02 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.02)
      throw new Error(`${a.name} and ${b.name} overlap; lay rooms edge to edge, with a closet as its own rectangle beside the room it opens from.`);
  }));
  const h = height === undefined ? DEFAULTS.height : r6(num(height, 'height') * f);
  const t = wallThickness === undefined ? DEFAULTS.thickness : r6(num(wallThickness, 'wallThickness') * f);
  const lines = new Map();
  const edge = (axis, c, a, b) => {
    const key = `${axis}:${Math.round(c * 1000)}`;
    if (!lines.has(key)) lines.set(key, {axis, c, spans: []});
    lines.get(key).spans.push([Math.min(a, b), Math.max(a, b)]);
  };
  for (const r of rects) { edge('h', r.y0, r.x0, r.x1); edge('h', r.y1, r.x0, r.x1); edge('v', r.x0, r.y0, r.y1); edge('v', r.x1, r.y0, r.y1); }
  const walls = [];
  for (const {axis, c, spans} of [...lines.values()].sort((a, b) => a.axis.localeCompare(b.axis) || a.c - b.c)) {
    spans.sort((a, b) => a[0] - b[0]);
    let [lo, hi] = spans[0];
    const emit = () => walls.push({id: `wall-${walls.length + 1}`, levelId: 'level-1', start: axis === 'h' ? [lo, c] : [c, lo], end: axis === 'h' ? [hi, c] : [c, hi], thickness: t, height: h, material: 'generic', roomIds: []});
    for (const [a, b] of spans.slice(1)) {
      if (a <= hi + 0.001) hi = Math.max(hi, b);
      else { emit(); [lo, hi] = [a, b]; }
    }
    emit();
  }
  const plan = {schema: PLAN_SCHEMA, id: null, revision: null, parentRevision: null, name: String(name || 'Floor plan').slice(0, 200), units: 'm',
    levels: [{id: 'level-1', name: 'Level 1', elevation: 0, height: h}], walls, openings: [], rooms: [], objects: [], sources: []};
  plan.rooms = detectRooms(plan, {labels: rects.map(r => ({text: r.name, at: [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]}))});
  if (!Array.isArray(openings) || openings.length > 500) throw new Error('Give at most 500 openings.');
  plan.openings = openings.map((o, i) => {
    if (o?.kind !== 'door' && o?.kind !== 'window') throw new Error(`openings[${i}].kind must be door or window.`);
    const p = [num(o.x, `openings[${i}].x`) * f, num(o.y, `openings[${i}].y`) * f];
    const wall = nearestWall(plan, p, 0.6);
    if (!wall) throw new Error(`openings[${i}] is not on a wall; put its point on a room edge.`);
    const len = wallLength(wall), d = DEFAULTS[o.kind];
    const width = o.width === undefined ? Math.min(d.width, len) : r6(num(o.width, `openings[${i}].width`) * f);
    const u = [(wall.end[0] - wall.start[0]) / len, (wall.end[1] - wall.start[1]) / len];
    const along = (p[0] - wall.start[0]) * u[0] + (p[1] - wall.start[1]) * u[1];
    return {id: `opening-${i + 1}`, wallId: wall.id, kind: o.kind, offset: r6(Math.min(len - width, Math.max(0, along - width / 2))), width, sill: d.sill, height: d.height, swing: null};
  });
  return plan;
}

// The fixed parts of a typical residential floor plate, in feet, and the bands left for units. A
// plate wide enough for two unit bands gets a double-loaded corridor along its long axis, an exit
// stair at each end and the elevator core at mid-plate on one side; a narrower plate gets one stair
// hall across its middle with units front and back. A floor of one unit (units, when given) gets the
// stair hall at one end and the unit through the rest of the plate. split places a central stair hall:
// the front band's share of the plate depth outside the hall. Each segment's place(name, s, e) draws a unit
// (or any room on that band) from s to e along it, with its door and window.
const TYPICAL = {corridor: 5.5, stair: 10, core: 16, hall: 12, minUnit: 14, minBand: 20};
function floorFrame(width, depth, cw, units = Infinity, split = 0.5) {
  const swap = depth > width, L = Math.max(width, depth), S = Math.min(width, depth);
  // u runs along the long axis, v across it; rooms come back as x east and y north.
  const rooms = [], openings = [];
  const rect = (name, u0, u1, v0, v1) => rooms.push(swap ? {name, x: v0, y: u0, width: v1 - v0, depth: u1 - u0} : {name, x: u0, y: v0, width: u1 - u0, depth: v1 - v0});
  const at = (kind, u, v, w) => openings.push({kind, ...(swap ? {x: v, y: u} : {x: u, y: v}), ...(w ? {width: w} : {})});
  const window = (s, e) => Math.min(6, (e - s) / 3);
  if (units >= 3 && S >= 2 * TYPICAL.minBand + cw && L >= 2 * TYPICAL.stair + TYPICAL.core + 2 * TYPICAL.minUnit) {
    const band = (S - cw) / 2, lo = band, hi = band + cw, mid = L / 2;
    rect('Corridor', 0, L, lo, hi);
    rect('Stair A', 0, TYPICAL.stair, hi, S); at('door', TYPICAL.stair / 2, hi);
    rect('Stair B', L - TYPICAL.stair, L, hi, S); at('door', L - TYPICAL.stair / 2, hi);
    rect('Elevator core', mid - TYPICAL.core / 2, mid + TYPICAL.core / 2, hi, S); at('door', mid, hi);
    const south = (name, s, e) => { rect(name, s, e, 0, lo); at('door', (s + e) / 2, lo); at('window', (s + e) / 2, 0, window(s, e)); };
    const north = (name, s, e) => { rect(name, s, e, hi, S); at('door', (s + e) / 2, hi); at('window', (s + e) / 2, S, window(s, e)); };
    return {rooms, openings, plateSqft: L * S, layout: 'double-loaded corridor',
      segments: [{a: 0, b: L, depth: band, place: south}, {a: TYPICAL.stair, b: mid - TYPICAL.core / 2, depth: band, place: north}, {a: mid + TYPICAL.core / 2, b: L - TYPICAL.stair, depth: band, place: north}]};
  }
  if (S < TYPICAL.minUnit || L < TYPICAL.hall + (units < 2 ? 1 : 2) * TYPICAL.minUnit) throw new Error(`A ${Math.round(width)} by ${Math.round(depth)} ft plate is too small for a stair and units.`);
  if (units < 2) {
    rect('Stair hall', 0, TYPICAL.hall, 0, S);
    const through = (name, s, e) => { rect(name, TYPICAL.hall, L, s, e); at('door', TYPICAL.hall, (s + e) / 2); at('window', L, (s + e) / 2, window(s, e)); };
    return {rooms, openings, plateSqft: L * S, layout: 'end stair hall', segments: [{a: 0, b: S, depth: L - TYPICAL.hall, place: through}]};
  }
  const a = (L - TYPICAL.hall) * split, b = a + TYPICAL.hall;
  rect('Stair hall', a, b, 0, S);
  const front = (name, s, e) => { rect(name, 0, a, s, e); at('door', a, (s + e) / 2); at('window', 0, (s + e) / 2, window(s, e)); };
  const back = (name, s, e) => { rect(name, b, L, s, e); at('door', b, (s + e) / 2); at('window', L, (s + e) / 2, window(s, e)); };
  return {rooms, openings, plateSqft: L * S, layout: 'central stair hall', segments: [{a: 0, b: S, depth: a, place: front}, {a: 0, b: S, depth: L - b, place: back}]};
}
const checkMix = mix => {
  if (!Array.isArray(mix) || !mix.length || mix.length > 8) throw new Error('typicalFloor needs 1 to 8 unit types in mix.');
  mix.forEach((t, i) => { if (typeof t?.name !== 'string' || !t.name.trim() || !(t.share > 0) || !(t.targetSqft >= 200)) throw new Error(`mix[${i}] needs a name, a share above zero and a targetSqft of at least 200.`); });
  const total = mix.reduce((s, t) => s + t.share, 0);
  return mix.map(t => ({name: t.name.trim(), share: t.share / total, targetSqft: t.targetSqft}));
};
// The unit type furthest below its share once `count` units are placed.
const nextType = (types, counter, count) => types.reduce((best, t) => (t.share * count - counter.get(t.name) > best.share * count - counter.get(best.name) ? t : best));

// A typical residential floor of a priced program as draft rooms, in feet. Unit types are picked by
// largest share deficit, sized to their target area over the band depth, then stretched so each
// segment fills exactly (the planning engine's method, in rectangles).
export function typicalFloor({width, depth, mix, corridorWidth = TYPICAL.corridor, height}) {
  if (!(Number.isFinite(width) && Number.isFinite(depth) && width > 0 && depth > 0)) throw new Error('typicalFloor needs the floor plate width and depth in feet.');
  const types = checkMix(mix), frame = floorFrame(width, depth, corridorWidth);
  const counter = new Map(types.map(t => [t.name, 0]));
  let n = 0;
  for (const {a, b, depth: bandDepth, place} of frame.segments) {
    const length = b - a, picks = [];
    let used = 0;
    while (used < length) {
      const kind = nextType(types, counter, n + picks.length + 1);
      const w = Math.max(kind.targetSqft / bandDepth, TYPICAL.minUnit);
      if (used + w > length && used + w - length > w / 2) break;
      picks.push([kind, w]); counter.set(kind.name, counter.get(kind.name) + 1); used += w;
    }
    while (picks.length && length / used * Math.min(...picks.map(p => p[1])) < TYPICAL.minUnit) {
      const [kind, w] = picks.pop(); counter.set(kind.name, counter.get(kind.name) - 1); used -= w;
    }
    let s = a;
    for (const [kind, w] of picks) {
      const e = s + w * length / used;
      place(`Unit ${++n}, ${kind.name}`, s, e);
      s = e;
    }
  }
  if (!n) throw new Error('No unit of this mix fits the plate; give a smaller target size or a larger plate.');
  return {units: 'ft', ...(height === undefined ? {} : {height}), rooms: frame.rooms, openings: frame.openings, unitsPerFloor: n};
}

const UNIT_TYPE_NAMES = {studio: 'Studio', oneBedroom: '1 bedroom', twoBedroom: '2 bedroom', threeBedroom: '3 bedroom'};
// PLUTO lot types the layout distinguishes (parcels.mjs LOT_TYPE_MAP): a corner lot fronts two streets, a through lot two parallel ones.
const LOT_TYPES = {'3': 'corner', '4': 'through'};
// The floors of a scheme (schemes.mjs) on its lot, laid out by the planning engine (planning/layout.py):
// many layouts inside the storey outlines (Thread A's acres.outlines/1 export when site is given, else the
// PLUTO rectangle less a rear yard), each checked against cited light and air, room size and egress rules
// and scored, the best returned as a plan document with one level per distinct floor plate and its report.
// The floors aim at the scheme's zoning floor area and its units, at its unit mix (whole-building counts per
// type, affordable rows apart) and net sizes. lot is lotOf(property); run is the planner. typicalFloorUnits
// is the units the whole plan draws.
export async function schemeTypicalFloor(scheme, lot = {}, {site = null, run = request => spawnPlanner(request)} = {}) {
  const {program} = scheme;
  if (!(program?.storeys >= 1 && program.units >= 1)) throw new Error(`The ${scheme.label} scheme has no storeys or units to lay out.`);
  if (!Array.isArray(program.unitMix) || !program.unitMix.length) throw new Error(`The ${scheme.label} scheme has no unit mix.`);
  const units = Math.max(1, Math.round(program.units / program.storeys));
  // Affordable rows (rented at their own sizes, on condo exits too) are a unit type of their own.
  const mix = program.unitMix.filter(u => u.units > 0).map(u => ({name: `${UNIT_TYPE_NAMES[u.type]}${u.affordable ? ', affordable' : ''}`, type: u.type, share: u.units, targetSqft: u.netSqft}));
  const {plan, report} = await run({typicalFloor: {
    lot: {frontFeet: lot.frontFeet > 10 ? lot.frontFeet : 25, depthFeet: lot.depthFeet > 15 ? lot.depthFeet : 100, lotType: lot.lotType || 'interior'},
    ...(site ? {outlines: site} : {}), district: lot.district || '', overlay: lot.overlay || '',
    plateSqft: program.zfa / program.storeys, unitsPerFloor: units, storeys: program.storeys, buildingUnits: program.units, zfa: program.zfa, mix,
    // The deal model prices a commercial overlay's ground floor as retail, except in a city-financed building.
    groundRetail: program.taxProgram?.kind !== 'city-financed',
    name: `${scheme.label}: floor plans`}});
  // The storeys drawn: the scheme's, or more where the outlines recover storeys exact yards cost.
  return {...report, doc: plan, scheme: scheme.id, storeys: report.storeysDrawn, buildingUnits: program.units, typicalFloorUnits: report.unitsDrawn};
}

// A plan traced from a stored SVG drawing, scaled so its walls span widthMetres east to west (the
// overall width a listing or brochure states), with the south-west wall corner as the origin.
export function planFromSvg(svgText, {widthMetres, name, ref}) {
  if (!(Number.isFinite(widthMetres) && widthMetres > 0)) throw new Error('widthMetres must be the overall width of the walls, in metres.');
  const proposal = proposeFromPrimitives(extractPrimitives(sanitizeSvg(svgText, {DOMParser}).svg, {DOMParser}));
  if (!proposal.walls.length) throw new Error('No wall lines were found in the drawing.');
  const xs = proposal.walls.flatMap(w => [w.a[0], w.b[0]]), bottom = Math.max(...proposal.walls.flatMap(w => [w.a[1], w.b[1]]));
  const calibration = calibrate([Math.min(...xs), bottom], [Math.max(...xs), bottom], widthMetres);
  const plan = planFromDrawing({proposal, calibration, source: {kind: 'svg', ref}});
  return {...plan, name: String(name || plan.name).slice(0, 200), scale: {metresPerDrawingUnit: calibration.metresPerPixel}};
}

const sqft = m2 => Math.round(m2 * 10.7639);
const round2 = v => Math.round(v * 100) / 100;
const roomsOf = plan => plan.rooms.map(r => ({id: r.id, name: r.name, areaSqm: round2(roomArea(r)), areaSqft: sqft(roomArea(r))}));
const issuesOf = plan => validatePlan(plan).map(i => ({severity: i.severity, code: i.code, ref: i.ref, message: i.message}));

// A scheme's typical floor on its lot as a plan document to save, and the layout's report (units per
// floor, net-to-gross, unit mix and fit). The lot comes from the site's PLUTO record.
export const lotOf = property => ({frontFeet: Number(property?.lotfront) || null, depthFeet: Number(property?.lotdepth) || null,
  lotType: LOT_TYPES[String(property?.lottype ?? '').trim()] || 'interior', district: property?.zonedist1 || '', overlay: property?.overlay1 || ''});
export async function schemePlan(scheme, lot, name, options) {
  const {doc: drawn, ...report} = await schemeTypicalFloor(scheme, lot, options);
  const doc = {...drawn, name: name || `${scheme.label}: floor plans, ${report.typicalFloorUnits} unit${report.typicalFloorUnits === 1 ? '' : 's'}`};
  const errors = issuesOf(doc).filter(i => i.severity === 'error');
  if (errors.length) throw new Error(`The ${scheme.label} floor did not validate: ${errors[0].message}`);
  return {doc, report};
}

const definition = (name, description, properties, required) => ({name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}});
const point = {type: 'number'};
const schemeArg = {scheme: {type: 'string', enum: SCHEME_IDS, description: 'Which of the site\'s three schemes the plan belongs to: as_of_right (As of right, the default), max_bonus (Most floor area) or alternative. Each scheme has its own plan with its own revision numbers.'}};
export const architectureDefinitions = [
  definition('acres_find_floor_plan', 'Find published 2D floor plans for a building from an address or building name, a building website, or a listing link. Searches the web and images and reads the given pages for floor plan images and brochure or offering memorandum PDFs. Returns candidate file URLs with the page each came from; short-term and furnished rental platforms are excluded. Attach the best candidate with acres_attach_drawing.',
    {query: {type: 'string', description: 'Address with city, or building name, for example "245 W 25th St, New York, NY".'}, url: {type: 'string', description: 'A building website or listing page to read for plans.'}}, []),
  definition('acres_attach_drawing', 'Attach a floor plan file (SVG, PDF, PNG, JPEG or WebP) by URL to this project\'s drawings. The service downloads it, and the plan editor on screen lists it at once so the user can trace over it.',
    {url: {type: 'string', description: 'Direct URL of the plan file, from acres_find_floor_plan or the user.'}, name: {type: 'string', description: 'Short display name, for example "Unit 4B plan".'}, foundOn: {type: 'string', description: 'The page the file was found on.'}}, ['url']),
  definition('acres_view_drawing', 'Look at an attached drawing to read its room names and printed dimensions: a PNG, JPEG or WebP plan is shown to you as an image, a PDF as its text, an SVG as its text labels. Use it before drafting from a drawing; say which values you read from it.',
    {drawingId: {type: 'string', description: 'A drawing id from acres_attach_drawing or acres_read_plan.'}}, ['drawingId']),
  definition('acres_read_plan', 'Read one scheme\'s current floor plan revision (rooms with areas, walls, openings, validation issues, the latest walkthrough job), which schemes have plans, and the project\'s attached drawings. Read before editing; the user may have saved changes in the editor.', {...schemeArg}, []),
  definition('acres_save_plan', 'Save a new floor plan revision to the project; the plan editor on screen updates at once. Give parentRevision (the revision you read, or 0 for the first plan) and exactly one of: draft (rectangular rooms laid out from dimensions you read, x east and y north from the south-west corner; shared edges become one wall; doors and windows sit on the nearest room edge), plan (a full acres.architecture.plan/1 document, for edits to what acres_read_plan returned), fromDrawing (trace an attached SVG drawing, scaled so its walls span the published overall width), or typicalFloor (the typical residential floor of a priced program, laid out as code: a double-loaded corridor, a stair at each end, an elevator core and units sized to the unit mix). With scheme and an empty typicalFloor, the planning engine lays the scheme\'s floors out many ways on the lot\'s storey outlines (the tax lot with its yards and setbacks; double-loaded corridor, central core, L-plan, courtyard), checks each against cited light and air, room size and egress rules, and saves the best: a cellar, a ground floor with the lobby, refuse room and any retail, and a level for each distinct floor plate, with units, rooms, doors and windows holding the scheme\'s floor area and units at its unit mix; the result reports units drawn, the levels, net-to-gross, whether the mix fits and why this plan was chosen. The revision is saved to the scheme\'s plan. Invalid geometry or a newer revision is reported back without saving.',
    {parentRevision: {type: 'integer', minimum: 0, description: 'The revision you read with acres_read_plan, or 0 when there is no plan yet.'}, name: {type: 'string'}, ...schemeArg,
      draft: {type: 'object', additionalProperties: false, required: ['rooms'], properties: {units: {type: 'string', enum: ['ft', 'm']}, height: point, wallThickness: point,
        rooms: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['name', 'x', 'y', 'width', 'depth'], properties: {name: {type: 'string'}, x: point, y: point, width: point, depth: point}}},
        openings: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['kind', 'x', 'y'], properties: {kind: {type: 'string', enum: ['door', 'window']}, x: point, y: point, width: point}}}}},
      plan: {type: 'object', additionalProperties: true},
      fromDrawing: {type: 'object', additionalProperties: false, required: ['drawingId', 'widthMetres'], properties: {drawingId: {type: 'string'}, widthMetres: {type: 'number', description: 'Overall width of the walls east to west in metres, as published for the unit or floor.'}}},
      typicalFloor: {type: 'object', additionalProperties: false, description: 'A rectangular residential floor plate in feet, from the massing or envelope storey, and the priced unit mix; or {} with scheme to lay out that scheme.',
        properties: {width: point, depth: point, corridorWidth: point, height: {type: 'number', description: 'Floor-to-floor height in feet.'},
          mix: {type: 'array', minItems: 1, maxItems: 8, items: {type: 'object', additionalProperties: false, required: ['name', 'share', 'targetSqft'], properties: {name: {type: 'string', description: 'Unit type, for example "1 bedroom".'}, share: {type: 'number', description: 'Relative share of the unit count.'}, targetSqft: {type: 'number'}}}}}}},
    ['parentRevision']),
  definition('acres_render_plan', 'Queue (or reuse) the walkthrough finished products for a plan revision: a Blender preview image, the 3D walkthrough model (GLB with its manifest) and the editable Blender file, built on the server from the revision IFC. Saving a plan with acres_save_plan already queues this; call it to render a revision saved earlier (for example in the editor) or to check on its products. Rendering runs in the background: a queued or running job is not finished, so say so, and read the plan again with acres_read_plan to confirm it succeeded before telling the user the preview or walkthrough is ready.',
    {revision: {type: 'integer', minimum: 1, description: 'Plan revision to render. Defaults to the current revision.'}, ...schemeArg}, []),
  definition('acres_import_pascal_scene', 'Import an edited Pascal scene JSON (uploaded as a drawing, kind pascal-scene) as a new plan revision. This is the return leg of the Pascal hand-off: the user downloads Pascal scene (JSON) from the Architecture section, edits it in Pascal, uploads the edited JSON as a drawing, and you import it with the drawingId from acres_read_plan and the revision it was edited from as parentRevision (0 when there is no plan yet). Walls, doors, windows, levels and room zones convert back to the plan, keeping element ids where the scene carries them; node kinds with no plan meaning are dropped and reported. Like every save it is parent-guarded, geometry-checked, and queues the walkthrough products.',
    {drawingId: {type: 'string', description: 'The uploaded Pascal scene drawing id, from acres_read_plan.'},
     parentRevision: {type: 'integer', minimum: 0, description: 'The revision the scene was edited from, or 0 when there is no plan yet.'},
     name: {type: 'string', description: 'Optional plan name override.'}, ...schemeArg},
    ['drawingId', 'parentRevision']),
];

// One job as the agent may state it: only a succeeded job has finished products, and their
// kinds and sizes are the evidence. Job views name the id `id` (the service) or `jobId` (tests).
const walkthroughOf = job => job ? {status: job.status, jobId: job.id ?? job.jobId ?? null, reason: job.reason ?? null,
  outputs: (Array.isArray(job.artifacts) ? job.artifacts : []).map(a => ({kind: a.kind, bytes: a.bytes}))} : null;
const renderNote = walkthrough => !walkthrough ? ''
  : walkthrough.status === 'succeeded' ? ' The walkthrough finished products (preview image, 3D model and Blender file) are ready in the Architecture section.'
  : walkthrough.status === 'queued' || walkthrough.status === 'running' ? ` Walkthrough rendering is ${walkthrough.status}; the user sees its progress in the Architecture section. Do not say the preview or walkthrough is ready until acres_read_plan reports it succeeded.`
  : walkthrough.status === 'unavailable' ? ` Walkthrough rendering is unavailable on this host (${walkthrough.reason || 'no reason reported'}), so no preview or 3D model was queued.`
  : ` The walkthrough job ${walkthrough.status}${walkthrough.reason ? `: ${walkthrough.reason}` : ''}.`;

// plans: the run's access to its project's plan (service.mjs planAccess), or null when the
// architecture feature is off. search: optional Serper key for web and image search.
export function createArchitectureTools({plans, secrets = {}, meter = null, emit = () => {}, request = null, lookup = dnsLookup}) {
  if (!plans) return {definitions: [], handlers: {}};
  const metered = async fn => {
    if (!meter) return fn();
    const auth = await meter.authorize('serper', 'SERPER_SEARCH');
    try { const out = await auth.invoke(fn); await auth.settle({}); return out; } catch (e) { await auth.pending().catch(() => {}); throw e; }
  };
  const serper = async (kind, q) => {
    const r = await (request || fetch)(`https://google.serper.dev/${kind}`, {method: 'POST', headers: {'x-api-key': secrets.SERPER_API_KEY, 'content-type': 'application/json'}, body: JSON.stringify({q, num: 10}), signal: requestSignal(30000)});
    if (!r.ok) throw new Error(`Search returned HTTP ${r.status}.`);
    return r.json();
  };
  const readPage = async url => {
    const {bytes, finalUrl, contentType} = await fetchDrawing(url, {...(request ? {request} : {}), lookup, accept: 'text/html,application/xhtml+xml,*/*;q=0.5', allow: u => !excludedSource(u)});
    const kind = sniffDrawing(bytes);
    if (kind) return [{url: finalUrl, kind: kind === 'pdf' ? 'pdf' : kind === 'svg' ? 'svg' : 'image', foundOn: url, foundVia: 'given link', label: null, score: 5}];
    if (!/html|xml|text/i.test(contentType)) return [];
    return planCandidates(bytes.toString('utf8'), finalUrl);
  };

  async function findFloorPlan({query, url} = {}) {
    if (!query && !url) throw new Error('Give an address or building name, or a website or listing link.');
    if (url && (!publicUrl(url) || excludedSource(url))) throw new Error('That link is not a usable plan source; short-term and furnished rental platforms are excluded.');
    const searchable = typeof secrets.SERPER_API_KEY === 'string' && secrets.SERPER_API_KEY.length >= 10 && query;
    const q = `${String(query || '').slice(0, 300)} floor plan`;
    const [web, images] = searchable ? await Promise.all([metered(() => serper('search', q)), metered(() => serper('images', q))]) : [null, null];
    const candidates = new Map(), pages = [];
    const keep = c => { if (!excludedSource(c.url) && !excludedSource(c.foundOn || c.url) && !candidates.has(c.url)) candidates.set(c.url, c); };
    for (const img of images?.images || []) {
      if (!publicUrl(img.imageUrl) || !publicUrl(img.link)) continue;
      keep({url: img.imageUrl, kind: kindOf(img.imageUrl) === 'svg' ? 'svg' : 'image', foundOn: img.link, foundVia: 'image search', label: img.title || null, score: FLOOR.test(`${img.title} ${img.imageUrl}`) ? 3 : 1});
    }
    const organic = (web?.organic || []).filter(o => publicUrl(o.link) && !excludedSource(o.link));
    for (const o of organic) if (kindOf(o.link) === 'pdf') keep({url: o.link, kind: 'pdf', foundOn: o.link, foundVia: 'web search', label: o.title || null, score: FLOOR.test(o.title) || OFFERING.test(o.title) ? 3 : 1});
    const scan = [...(url ? [url] : []), ...organic.filter(o => kindOf(o.link) !== 'pdf').slice(0, 3).map(o => o.link)];
    await Promise.all(scan.map(async page => {
      try { const found = await readPage(page); found.forEach(keep); pages.push({url: page, candidates: found.length}); }
      catch (e) { pages.push({url: page, error: String(e.message).slice(0, 160)}); }
    }));
    const list = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 12).map(({score, ...c}) => ({...c, confidence: score >= 3 ? 'named a floor plan' : 'possible'}));
    emit('architecture.find', {query: query || null, url: url || null, candidates: list.length});
    return {candidates: list, pagesRead: pages, searched: Boolean(searchable),
      note: list.length ? 'Candidates are leads: a file named a floor plan may still be another unit, floor or building. Attach the one that matches the unit or floor the user means and say where it came from.'
        : 'No plan files were found. Ask the user for a listing link, brochure or offering memorandum, or draft the plan from room dimensions published in the listing text.'};
  }

  async function attachDrawing({url, name, foundOn} = {}) {
    if (typeof url !== 'string' || excludedSource(url) || (foundOn && excludedSource(foundOn))) throw new Error('Attach a public plan file; short-term and furnished rental platforms are excluded.');
    const drawing = await plans.attach({url, name, foundOn: foundOn && publicUrl(foundOn) ? foundOn : null, allow: u => !excludedSource(u)});
    throwIfCancelled();
    return {drawing, note: 'The drawing now appears in the plan editor. Look at it with acres_view_drawing, then draft the plan from the dimensions you can read.'};
  }

  async function viewDrawing({drawingId} = {}) {
    const file = plans.drawing(String(drawingId ?? ''));
    if (!file) throw new Error('That drawing is not attached to this project.');
    const {id, name, kind, contentType, bytes, sourceUrl, foundOn} = file.drawing, drawing = {id, name, kind, sourceUrl, foundOn};
    const note = 'Read only what is legible. Marketing plans may be not to scale, mirrored or another unit; treat unreadable dimensions as unknown.';
    if (kind === 'svg') {
      // What a trace of this drawing would leave out (curved walls, stray marks) is said up front.
      const primitives = extractPrimitives(file.read().toString('utf8'), {DOMParser}), losses = readingLosses(proposeFromPrimitives(primitives));
      return {drawing, labels: primitives.labels.map(l => l.text).slice(0, 300), note: losses ? `${note} ${losses}` : note};
    }
    if (kind === 'pdf') {
      const text = extractText(file.read(), contentType).text;
      return {drawing, text: text.slice(0, 20000), note: text.trim() ? note : 'This PDF has no readable text, so it is likely a scanned image. Its dimensions cannot be read here; ask the user for them or for a vector copy of the plan.'};
    }
    if (bytes > 5 * 1024 * 1024) throw new Error('This image is over 5 MB, too large to view; ask the user for the dimensions or a smaller file.');
    return {drawing, note, contentImages: [`data:${contentType};base64,${file.read().toString('base64')}`]};
  }

  // Queues (or reuses) the finished-product job for one revision. A host with rendering off
  // answers `unavailable` instead of throwing: the plan itself is unaffected either way.
  async function queueRender(planId, revision) {
    if (typeof plans.render !== 'function') return {status: 'unavailable', jobId: null, reason: 'Architecture processing is not enabled.', outputs: []};
    try { return walkthroughOf(await plans.render({planId, revision})); }
    catch (e) { return {status: 'unavailable', jobId: null, reason: String(e.message || e).slice(0, 300), outputs: []}; }
  }

  function readPlan({scheme} = {}) {
    const summary = plans.summary(scheme), drawings = plans.drawings().map(({id, name, kind, sourceUrl, foundOn, by, createdAt}) => ({id, name, kind, sourceUrl, foundOn, by, createdAt}));
    const schemes = summary.schemes?.map(s => ({scheme: s.scheme, revision: s.revision}));
    if (!summary.current) return {scheme: summary.scheme, revision: null, schemes, drawings, note: 'This scheme has no plan yet. Save the first one with parentRevision 0.'};
    const {plan, revision, parentRevision, createdAt, jobs} = summary.current;
    const job = jobs.at(-1);
    return {scheme: summary.scheme, schemes, revision, parentRevision, createdAt, savedBy: summary.current.createdBy, name: plan.name, levels: plan.levels,
      rooms: roomsOf(plan), walls: plan.walls.map(({id, start, end, thickness, height}) => ({id, start, end, thickness, height})),
      openings: plan.openings.map(({id, wallId, kind, offset, width}) => ({id, wallId, kind, offset, width})), issues: issuesOf(plan),
      walkthrough: walkthroughOf(job), drawings, document: exportPlan(plan),
      note: 'Coordinates are metres, x east and y north. To edit, change document and send it back to acres_save_plan as plan, with parentRevision set to this revision.'};
  }

  async function renderPlan({revision, scheme} = {}) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('revision must be a plan revision number.');
    const summary = plans.summary(scheme), target = revision ?? summary.current?.revision ?? null;
    if (target === null || !summary.planId) throw new Error('There is no plan revision to render yet. Save a plan first.');
    const walkthrough = await queueRender(summary.planId, target);
    emit('architecture.render', {revision: target, status: walkthrough.status});
    return {queued: walkthrough.status === 'queued' || walkthrough.status === 'running', revision: target, walkthrough,
      note: `Revision ${target}:${renderNote(walkthrough) || ' no walkthrough job was started.'}`.trim()};
  }

  async function savePlan({parentRevision, name, draft, plan, fromDrawing, typicalFloor: typical, scheme} = {}) {
    if (!Number.isSafeInteger(parentRevision) || parentRevision < 0) throw new Error('parentRevision is required: the revision you read, or 0 for the first plan.');
    if ([draft, plan, fromDrawing, typical].filter(Boolean).length !== 1) throw new Error('Give exactly one of draft, plan, fromDrawing or typicalFloor.');
    let doc, scale = null, unitsPerFloor = null, layout = null, zoning = null;
    if (typical && typical.width === undefined && typical.depth === undefined && typical.mix === undefined) {
      if (!scheme) throw new Error('Give scheme to lay out a scheme\'s typical floor, or the plate width, depth and mix.');
      // The scheme on its storey outlines, as Draft all three draws it; the PLUTO rectangle only when the lot has none.
      const site = await plans.scheme(scheme);
      ({doc, report: layout} = await schemePlan(site.scheme, site.lot, name, {site: site.site ?? null, run: request => spawnPlanner(request, {planningDir: secrets.ACRES_PLANNING_DIR || undefined})}));
      zoning = site.site ?? null;
      unitsPerFloor = layout.unitsPerFloor;
    } else if (typical) {
      const {unitsPerFloor: count, ...rooms} = typicalFloor(typical);
      unitsPerFloor = count;
      doc = draftPlan({...rooms, name: name || `Typical floor, ${count} units`});
    } else if (draft) doc = draftPlan({...draft, name});
    else if (fromDrawing) {
      const file = plans.drawing(fromDrawing.drawingId);
      if (!file) throw new Error('That drawing is not attached to this project.');
      if (file.drawing.kind !== 'svg') throw new Error('Only SVG drawings can be traced automatically; draft raster and PDF plans from their dimensions.');
      const {scale: traced, ...rest} = planFromSvg(file.read().toString('utf8'), {widthMetres: fromDrawing.widthMetres, name, ref: file.drawing.name});
      doc = rest;
      scale = traced;
    } else doc = {...plan, ...(name ? {name} : {}), objects: plan.objects ?? [], sources: plan.sources ?? []};
    const issues = issuesOf(doc), errors = issues.filter(i => i.severity === 'error');
    if (errors.length) return {saved: false, issues: errors.slice(0, 30), note: 'Nothing was saved. Fix these issues and save again.'};
    try {
      const parent = parentRevision || null;
      const saved = await plans.save({parentRevision: parent, plan: {...exportPlan(doc), ...(zoning ? {zoning} : {}), parentRevision: parent}, scheme});
      throwIfCancelled();
      if (layout && typeof plans.describe === 'function') plans.describe(saved.scheme, saved, {why: layout.why.summary, drawn: layout.drawn});
      // The agent's saves deliver finished products, not just geometry: queue the walkthrough
      // job for the new revision. Best-effort — a disabled worker never fails the save.
      const walkthrough = typeof plans.render === 'function' ? await queueRender(saved.planId, saved.revision) : null;
      return {saved: true, scheme: saved.scheme, revision: saved.revision, parentRevision: saved.parentRevision, rooms: roomsOf(saved.plan), warnings: issues.slice(0, 20), ...(scale ? {scale} : {}),
        ...(unitsPerFloor === null ? {} : {unitsPerFloor}),
        ...(layout ? {layout: {plate: layout.plate, netToGross: layout.netToGross, mix: layout.mix, storeys: layout.storeys, buildingUnits: layout.buildingUnits, typicalFloorUnits: layout.typicalFloorUnits, levels: layout.levels, drawn: layout.drawn, fit: layout.fit, why: layout.why}} : {}),
        ...(walkthrough ? {walkthrough} : {}),
        note: `Saved. The editor on screen shows this revision; tell the user what you drew, what you assumed, and what to check.${renderNote(walkthrough)}`};
    } catch (e) {
      if (e.status === 409) return {saved: false, conflict: true, currentRevision: e.revision, note: typical ? 'This scheme already has a floor plan. Keep it; do not draft another.' : 'The plan changed since you read it, likely an edit by the user. Read it again and apply your change to the current revision.'};
      if (e.status === 400) return {saved: false, issues: e.validationErrors || [], error: e.message};
      throw e;
    }
  }

  async function importPascalScene({drawingId, parentRevision, name, scheme} = {}) {
    if (!Number.isSafeInteger(parentRevision) || parentRevision < 0) throw new Error('parentRevision is required: the revision the scene was edited from, or 0 for the first plan.');
    const file = plans.drawing(drawingId);
    if (!file) throw new Error('That drawing is not attached to this project.');
    if (file.drawing.kind !== 'pascal-scene') throw new Error('That drawing is not a Pascal scene JSON. Ask the user to upload the edited .pascal.json file as a drawing.');
    let scene;
    try { scene = JSON.parse(file.read().toString('utf8')); }
    catch { return {saved: false, error: 'The uploaded file is not valid JSON, so it cannot be a Pascal scene.'}; }
    try {
      const bridge = new SceneBridge();
      bridge.loadJSON(scene);
      const validation = bridge.validateScene();
      if (!validation.valid) return {saved: false, issues: (validation.errors || []).slice(0, 20), note: 'Pascal itself rejects this scene; nothing was saved. Ask for a scene exported from Pascal without further hand edits.'};
    } catch (e) { return {saved: false, error: `Pascal rejected the scene: ${String(e.message || e).slice(0, 300)}`}; }
    let converted;
    try { converted = pascalSceneToPlan(scene, {name}); }
    catch (e) { return {saved: false, error: String(e.message || e).slice(0, 300)}; }
    converted.plan.sources = [{kind: 'pascal-scene', ref: file.drawing.name,
      drawingId: file.drawing.id, sha256: file.drawing.sha256}];
    const result = await savePlan({parentRevision, plan: converted.plan, scheme});
    const counts = `${converted.plan.walls.length} walls, ${converted.plan.openings.length} openings, ${converted.plan.rooms.length} rooms`;
    return {...result, importWarnings: converted.warnings.slice(0, 20),
      note: result.saved ? `${result.note} Imported from Pascal scene ${file.drawing.name} (${counts}).${converted.warnings.length ? ` Import notes: ${converted.warnings.slice(0, 5).join(' ')}` : ''}` : result.note};
  }

  return {definitions: architectureDefinitions, handlers: {acres_find_floor_plan: findFloorPlan, acres_attach_drawing: attachDrawing, acres_view_drawing: viewDrawing, acres_read_plan: readPlan, acres_save_plan: savePlan, acres_render_plan: renderPlan, acres_import_pascal_scene: importPascalScene}};
}
