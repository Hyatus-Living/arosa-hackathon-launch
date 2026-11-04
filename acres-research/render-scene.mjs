// Presentation render scenes: one scheme's massing among its neighbours, as the
// acres.render.scene/1 document that the worker's render_job.py builds in Blender. Everything is
// in the concept frame (x along the frontage, z into the lot, metres, the street at z = 0).
// The massing comes from the scheme's linked concept when it has storey footprints, otherwise
// from the zoning envelope's storeys trimmed to the scheme's storeys and gross floor area.
// See docs/architecture-jobs.md.
export const RENDER_SCENE_SCHEMA = 'acres.render.scene/1';
// A fixed New York afternoon: sun in the south-west, 35 degrees up (mid-afternoon in spring and autumn).
export const NYC_AFTERNOON_SUN = {azimuthDeg: 225, elevationDeg: 35};

const FOOT = 0.3048, SQFT = FOOT * FOOT;
const MAX_VOLUMES = 120, MAX_CONTEXT = 80, MAX_VERTICES = 48, MAX_COORD = 2000;
const DEFAULT_STREET_FEET = 60;
const RETAIL = /retail|commercial|store|shop/i;

const round = (n, d = 3) => Number(n.toFixed(d));
const bad = message => Object.assign(new Error(message), {status: 409});
const ring = (points, scale = 1) => points.map(([x, z]) => [round(x * scale), round(z * scale)]);
function area(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i], [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}
const validRing = points => Array.isArray(points) && points.length >= 3 && points.length <= MAX_VERTICES
  && points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= MAX_COORD));
// Ground floors with a retail or commercial use get storefront glazing; every other storey is residential.
const useOf = (use, base) => base < 1 && RETAIL.test(use || '') ? 'retail' : 'residential';

// The storeys of a concept modeled with acres_model_concept (footprints already in metres).
function conceptVolumes(concept) {
  if (!concept.levels?.length || !concept.levels.every(level => validRing(level.footprint)) || !validRing(concept.lot)) return null;
  return {lot: ring(concept.lot), volumes: concept.levels.map(level => {
    const base = level.floorElevationFeet * FOOT;
    return {footprint: ring(level.footprint), base: round(base), height: round(level.heightFeet * FOOT), use: useOf(level.use, base)};
  })};
}

// Whether renderScene draws this concept's own storeys (and so its own neighbours).
export const hasConceptMassing = concept => Boolean(concept && conceptVolumes(concept));

// The envelope's storeys (feet), cut or extended to the scheme's storeys, with every footprint
// shortened from the rear by one factor so the gross area matches the scheme (never deeper than the
// envelope). The street wall keeps its full width, as most NYC infill does.
function envelopeVolumes(envelope, program) {
  const storeys = envelope.storeys;
  if (!storeys?.length || !storeys.every(s => validRing(s.footprint)) || !validRing(envelope.lot?.polygon)) return null;
  const count = Math.max(1, Math.min(MAX_VOLUMES, Math.round(program.storeys) || storeys.length));
  const picked = Array.from({length: count}, (_, i) => storeys[Math.min(i, storeys.length - 1)]);
  const envelopeSqft = picked.reduce((sum, s) => sum + area(s.footprint), 0);
  const factor = Number.isFinite(program.grossSqft) && program.grossSqft > 0 ? Math.min(1, program.grossSqft / envelopeSqft) : 1;
  let base = 0;
  const volumes = picked.map(storey => {
    const front = Math.min(...storey.footprint.map(p => p[1]));
    const footprint = storey.footprint.map(([x, z]) => [x, front + (z - front) * factor]);
    const volume = {footprint: ring(footprint, FOOT), base: round(base), height: round(storey.heightFeet * FOOT), use: useOf(storey.use, base)};
    base += storey.heightFeet * FOOT;
    return volume;
  });
  return {lot: ring(envelope.lot.polygon, FOOT), volumes};
}

// scheme: a scheme from schemes.mjs; concept: the project's concept named by scheme.massing, if
// any; envelope: the project's zoning envelope; context: a context.mjs context in the same lot frame
// (a concept's own, or loaded for the lot), or null for a massing with no neighbours.
export function renderScene({scheme, concept = null, envelope = null, context = null}) {
  const massing = (concept && conceptVolumes(concept)) || (envelope && envelopeVolumes(envelope, scheme.program));
  if (!massing) throw bad('This option has no massing to render yet: model it or compute the zoning envelope first.');
  if (massing.volumes.length > MAX_VOLUMES) throw bad(`A render takes at most ${MAX_VOLUMES} storeys.`);
  const neighbours = (context?.buildings || [])
    .filter(b => !b.existing && b.height > 0 && validRing(b.polygon))
    .slice(0, MAX_CONTEXT)
    .map(b => ({footprint: ring(b.polygon), base: round(b.base || 0), height: round(b.height)}));
  const front = (envelope?.lot?.streets || []).find(street => street.side === 'front');
  return {
    schema: RENDER_SCENE_SCHEMA, units: 'm', scheme: scheme.id, label: scheme.label,
    lot: massing.lot, volumes: massing.volumes, context: neighbours,
    north: context?.north ?? [0, -1], sun: NYC_AFTERNOON_SUN,
    streetWidthMeters: round((front?.widthFeet || DEFAULT_STREET_FEET) * FOOT, 1),
    floorAreaSqft: Math.round(massing.volumes.reduce((sum, v) => sum + area(v.footprint), 0) / SQFT),
  };
}

// The check the service applies to any scene before writing it for the worker.
export function validateRenderScene(scene) {
  if (scene?.schema !== RENDER_SCENE_SCHEMA || scene.units !== 'm') throw bad(`The render scene must be ${RENDER_SCENE_SCHEMA} in metres.`);
  if (!validRing(scene.lot)) throw bad('The render scene needs a lot outline.');
  if (!Array.isArray(scene.volumes) || !scene.volumes.length || scene.volumes.length > MAX_VOLUMES) throw bad(`The render scene needs 1 to ${MAX_VOLUMES} volumes.`);
  if (!Array.isArray(scene.context) || scene.context.length > MAX_CONTEXT) throw bad(`The render scene takes at most ${MAX_CONTEXT} neighbours.`);
  for (const item of [...scene.volumes, ...scene.context]) {
    if (!validRing(item.footprint) || !Number.isFinite(item.base) || !(item.height > 0 && item.height <= 500)) throw bad('Every render volume needs a footprint, a base and a height.');
  }
  if (scene.volumes.some(v => !['residential', 'retail'].includes(v.use))) throw bad('Render volumes are residential or retail.');
  if (!(Array.isArray(scene.north) && scene.north.length === 2 && scene.north.every(Number.isFinite) && Math.hypot(...scene.north) > 0.5)) throw bad('The render scene needs a north direction.');
  if (!(scene.streetWidthMeters > 3 && scene.streetWidthMeters < 100)) throw bad('The render scene needs a street width.');
  return scene;
}
