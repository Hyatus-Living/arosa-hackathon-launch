import {randomUUID} from 'node:crypto';
import {throwIfCancelled} from './execution-context.mjs';
import {createPascalMcpServer, SceneBridge} from '@pascal-app/mcp';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createContextLoader} from './context.mjs';

const FOOT = 0.3048, SQFT = 1 / (FOOT * FOOT);
const MAX_CONCEPTS = 4, MAX_LEVELS = 60, MAX_VERTICES = 24;

function polygonArea(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i], [x2, z2] = polygon[(i + 1) % polygon.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}
function validPolygon(value) {
  return Array.isArray(value) && value.length >= 3 && value.length <= MAX_VERTICES && value.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 5000));
}
const round = (n, d = 1) => Number(n.toFixed(d));

function pointSegmentDistance([x, z], [x1, z1], [x2, z2]) {
  const dx = x2 - x1, dz = z2 - z1;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / lengthSq));
  return Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz));
}
function pointInOrOnPolygon(point, polygon, eps = 2e-3) { // built footprints are rounded to millimetres, envelope bands are not
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (pointSegmentDistance(point, polygon[j], polygon[i]) <= eps) return true;
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if ((zi > point[1]) !== (zj > point[1]) && point[0] < (xj - xi) * (point[1] - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function expandBands(levels, scale) {
  const bands = [];
  let elevation = 0;
  for (const level of levels) {
    const footprint = level.footprint.map(([x, z]) => [x * scale, z * scale]);
    const heightFeet = level.height * scale / FOOT;
    for (let i = 0; i < Math.min(level.count || 1, MAX_LEVELS); i++) {
      bands.push({footprint, areaSqft: polygonArea(footprint) * SQFT, floorFeet: elevation, topFeet: elevation + heightFeet});
      elevation += heightFeet;
    }
  }
  return bands;
}

// Screening check of modeled storeys against a supplied as-of-right envelope: every storey
// footprint vertex must sit inside (or on) the envelope footprint at that height and the area
// must not exceed it. Vertex containment can miss an edge crossing between vertices, so this
// flags clear breaches rather than proving compliance.
export function checkEnvelopeCompliance(built, envelopeLevels, scale) {
  const bands = expandBands(envelopeLevels, scale);
  const envelopeHeightFeet = bands.at(-1)?.topFeet ?? 0;
  const violations = [];
  for (const storey of built) {
    const midFeet = storey.floorElevationFeet + storey.heightFeet / 2;
    const band = bands.find(b => midFeet >= b.floorFeet && (midFeet < b.topFeet || (b === bands.at(-1) && midFeet <= b.topFeet)));
    if (!band) { violations.push({level: storey.label, reason: storey.floorElevationFeet >= envelopeHeightFeet ? `sits above the envelope top of ${round(envelopeHeightFeet, 1)} ft` : 'no envelope storey covers this height'}); continue; }
    if (!storey.footprint.every(point => pointInOrOnPolygon(point, band.footprint))) violations.push({level: storey.label, reason: 'footprint extends outside the envelope at this height'});
    else if (storey.areaSqft > band.areaSqft * 1.002) violations.push({level: storey.label, reason: `footprint area ${storey.areaSqft.toLocaleString('en-US')} sq ft exceeds the envelope's ${round(band.areaSqft, 0).toLocaleString('en-US')} sq ft at this height`});
  }
  return {compliant: violations.length === 0, violations, envelopeStoreys: bands.length, envelopeHeightFeet: round(envelopeHeightFeet, 1),
    // Expanded bands in scene metres so the viewer can draw the envelope as a translucent limit.
    levels: bands.map(b => ({footprint: b.footprint.map(p => p.map(n => round(n, 3))), floorElevationFeet: round(b.floorFeet, 1), heightFeet: round(b.topFeet - b.floorFeet, 1), areaSqft: round(b.areaSqft, 0)}))};
}

export const conceptDefinition = {
  name: 'acres_model_concept',
  description: 'Build a 2D/3D massing model of one development concept for the property under discussion in any US city, so the user can view it in the Arosa interface. Supply the lot outline and one footprint polygon per storey with its floor-to-floor height. Coordinates are in feet by default, x along the street frontage and z into the lot, with the street at z = 0. Use setbacks by shrinking upper footprints. When an NYC subject property is selected (deep coverage), the surrounding buildings and the existing building on the lot are added from NYC building footprints, and the existing building\'s height and footprint come back for comparison; in research-tier cities the model stands on the supplied lot without footprint neighbours. Returns computed areas, FAR against the lot and a concept ID. Model at most four concepts per answer: the as-of-right envelope and the alternatives worth comparing. The model illustrates a zoning hypothesis and does not prove an entitlement.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: {type: 'string', description: 'Short concept name, e.g. "As-of-right envelope" or "Assembly with 120 Broadway lot".'},
      summary: {type: 'string', description: 'One or two sentences on what the concept assumes and which rule or mechanism it relies on.'},
      units: {type: 'string', enum: ['ft', 'm'], description: 'Unit of every coordinate and height. Defaults to feet.'},
      lot: {type: 'array', description: 'Lot outline polygon as [x, z] pairs.', items: {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2}, minItems: 3},
      levels: {
        type: 'array', minItems: 1, maxItems: MAX_LEVELS,
        description: 'Storeys from the ground up. Repeat identical storeys explicitly; use "count" to repeat one footprint.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            label: {type: 'string'},
            use: {type: 'string', description: 'Primary use, e.g. residential, retail, office, mechanical.'},
            footprint: {type: 'array', items: {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2}, minItems: 3},
            height: {type: 'number', description: 'Floor-to-floor height in the chosen units.'},
            count: {type: 'integer', minimum: 1, maximum: MAX_LEVELS, description: 'Repeat this storey this many times.'},
            units: {type: 'integer', minimum: 0, maximum: 200, description: 'Dwelling units on this storey, when the program is residential and a unit count is part of the concept.'},
          },
          required: ['footprint', 'height'],
        },
      },
      maxFar: {type: 'number', description: 'Applicable maximum FAR when known, to report remaining capacity.'},
      envelope: {type: 'object', additionalProperties: false, properties: {levels: {type: 'array', minItems: 1, maxItems: MAX_LEVELS, items: {type: 'object', additionalProperties: false, properties: {footprint: {type: 'array', items: {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2}, minItems: 3}, height: {type: 'number'}, count: {type: 'integer', minimum: 1, maximum: MAX_LEVELS}}, required: ['footprint', 'height']}}}, required: ['levels'], description: 'As-of-right envelope storeys to check this concept against, typically the levels from acres_zoning_envelope\'s envelope.concept, in the same units. Each modeled storey is screened against the envelope footprint at its height and breaches are reported.'},
      maxHeightFeet: {type: 'number', description: 'Applicable height limit in feet when known.'},
      context: {type: 'boolean', description: 'Include the surrounding buildings from NYC building footprints (NYC deep coverage only). Defaults to true when an NYC subject property is selected.'},
      contextRadiusMeters: {type: 'number', minimum: 50, maximum: 250, description: 'Radius of surrounding buildings to include, 50 to 250 m. Defaults to 120.'},
      parentConceptId: {type: 'string', description: 'When this concept revises an earlier one, the earlier concept ID. The new concept is recorded as its next version with metric deltas; reverting or branching is modeling again from an older parent.'},
      parentName: {type: 'string', description: 'Name of the concept being revised, when it was modeled in an earlier answer.'},
      parentVersion: {type: 'integer', minimum: 1, description: 'Version number of the concept being revised, when known from its result.'},
      parentMetrics: {type: 'object', additionalProperties: false, properties: {grossFloorAreaSqft: {type: 'number'}, far: {type: 'number'}, heightFeet: {type: 'number'}, storeys: {type: 'number'}, units: {type: 'number'}}, description: 'Headline metrics of the earlier concept copied from its result, so deltas can be computed across answers.'},
      revisionNote: {type: 'string', description: 'What changed in this revision, e.g. "tower raised three storeys, retail podium removed".'},
    },
    required: ['name', 'lot', 'levels'],
  },
};

// getProperty returns the selected PLUTO row (with latitude, longitude and bbl) or null; record
// adds an evidence source and returns it with an id, or null; request fetches public JSON.
// streetView, when configured, returns the nearest outdoor Street View panorama for coordinates.
export function createConceptTools({emit = () => {}, getProperty = () => null, record = () => null, request, streetView = null} = {}) {
  const concepts = [];
  const loader = createContextLoader(request ? {request} : {});
  const panoramas = new Map();
  async function panorama(property) {
    if (!streetView) return null;
    const key = `${property.latitude},${property.longitude}`;
    if (!panoramas.has(key)) panoramas.set(key, streetView({latitude: property.latitude, longitude: property.longitude}).catch(error => { console.log(JSON.stringify({event: 'concept_street_view_failed', message: error.message})); return null; }));
    return panoramas.get(key);
  }
  async function surroundings(args, lot) {
    const property = getProperty();
    if (args.context === false || !property) return {context: null, note: args.context === false ? null : 'No subject property is selected, so the model has no surrounding buildings.'};
    try {
      const [loaded, view] = await Promise.all([loader.load({property, lot, radiusMeters: args.contextRadiusMeters}), panorama(property)]);
      if (!loaded) return {context: null, note: 'The subject property has no coordinates, so the model has no surrounding buildings.'};
      const source = record(loaded.source);
      return {context: {...loaded.context, sourceId: source?.id ?? null, streetView: view}, note: null};
    } catch (error) {
      console.log(JSON.stringify({event: 'concept_context_failed', message: error.message}));
      return {context: null, note: 'Surrounding buildings were unavailable for this model.'};
    }
  }
  async function model(args) {
    if (concepts.length >= MAX_CONCEPTS) throw new Error(`At most ${MAX_CONCEPTS} concepts per answer. Compare the existing ones instead.`);
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80) throw new Error('Give the concept a short name.');
    if (!validPolygon(args.lot)) throw new Error('The lot must be a polygon of 3 to 24 [x, z] points.');
    const scale = args.units === 'm' ? 1 : FOOT;
    const storeys = [];
    for (const level of args.levels || []) {
      if (!validPolygon(level.footprint)) throw new Error('Each storey needs a footprint polygon of 3 to 24 [x, z] points.');
      if (!(Number.isFinite(level.height) && level.height > 0 && level.height * scale <= 12)) throw new Error('Each storey needs a positive floor-to-floor height of at most 12 m (about 39 ft).');
      if (level.units !== undefined && !(Number.isInteger(level.units) && level.units >= 0 && level.units <= 200)) throw new Error('Units per storey must be a whole number from 0 to 200.');
      for (let i = 0; i < Math.min(level.count || 1, MAX_LEVELS); i++) storeys.push(level);
    }
    if (!storeys.length || storeys.length > MAX_LEVELS) throw new Error(`Supply 1 to ${MAX_LEVELS} storeys.`);
    if (args.envelope !== undefined) {
      if (!Array.isArray(args.envelope?.levels) || !args.envelope.levels.length) throw new Error('The envelope check needs envelope levels.');
      for (const level of args.envelope.levels) {
        if (!validPolygon(level.footprint)) throw new Error('Each envelope storey needs a footprint polygon of 3 to 24 [x, z] points.');
        if (!(Number.isFinite(level.height) && level.height > 0)) throw new Error('Each envelope storey needs a positive height.');
      }
    }

    const bridge = new SceneBridge(); bridge.loadDefault();
    const server = createPascalMcpServer({bridge});
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: 'acres', version: '1.0.0'});
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name, arguments_) => {
      throwIfCancelled();
      const response = await client.callTool({name, arguments: arguments_});
      if (response.isError) throw new Error(`The 3D modeler rejected ${name}: ${response.content?.find(c => c.type === 'text')?.text?.slice(0, 200)}`);
      return response.structuredContent ?? JSON.parse(response.content.find(c => c.type === 'text').text);
    };
    try {
      const lot = args.lot.map(([x, z]) => [x * scale, z * scale]);
      const lotArea = polygonArea(lot);
      if (lotArea < 1) throw new Error('The lot outline has no area.');
      const {levels: [ground]} = await call('list_levels', {});
      await call('set_zone', {levelId: ground.id, polygon: lot, label: 'Lot', properties: {acres: 'lot'}});
      const built = [];
      let levelId = ground.id, elevation = 0;
      for (const [index, storey] of storeys.entries()) {
        const footprint = storey.footprint.map(([x, z]) => [x * scale, z * scale]);
        const height = storey.height * scale;
        const label = storey.label || `Level ${index + 1}`;
        if (index > 0) ({levelId} = await call('add_level', {buildingId: ground.parentId, height, name: label}));
        else await call('apply_patch', {patches: [{op: 'update', id: levelId, data: {height}}]});
        await call('create_story_shell', {levelId, footprint, wallHeight: height, createCeiling: false});
        const area = polygonArea(footprint);
        built.push({label, use: storey.use || null, levelId, footprint: footprint.map(p => p.map(n => round(n, 3))), areaSqft: round(area * SQFT, 0), areaSqm: round(area, 1), heightFeet: round(height / FOOT, 1), floorElevationFeet: round(elevation / FOOT, 1), ...(Number.isInteger(storey.units) ? {units: storey.units} : {})});
        elevation += height;
      }
      const {context, note: contextNote} = await surroundings(args, lot);
      const validation = await call('validate_scene', {});
      if (!validation.valid) throw new Error('The concept model failed validation: ' + JSON.stringify(validation.errors).slice(0, 200));
      const {json} = await call('export_json', {});
      const scene = JSON.parse(json);
      const grossSqft = built.reduce((sum, level) => sum + level.areaSqft, 0);
      const units = built.some(level => Number.isInteger(level.units)) ? built.reduce((sum, level) => sum + (level.units || 0), 0) : null;
      const residentialSqft = built.filter(level => /resid|dwelling|apartment/i.test(level.use || '')).reduce((sum, level) => sum + level.areaSqft, 0);
      const metrics = {
        storeys: built.length,
        lotAreaSqft: round(lotArea * SQFT, 0),
        grossFloorAreaSqft: grossSqft,
        far: round(grossSqft / (lotArea * SQFT), 2),
        heightFeet: round(elevation / FOOT, 1),
        ...(units !== null ? {units, ...(units > 0 && residentialSqft > 0 ? {grossSqftPerUnit: round(residentialSqft / units, 0)} : {})} : {}),
        ...(Number.isFinite(args.maxFar) ? {maxFar: args.maxFar, remainingFloorAreaSqft: round(args.maxFar * lotArea * SQFT - grossSqft, 0)} : {}),
        ...(Number.isFinite(args.maxHeightFeet) ? {maxHeightFeet: args.maxHeightFeet, heightMarginFeet: round(args.maxHeightFeet - elevation / FOOT, 1)} : {}),
      };
      const compliance = args.envelope?.levels ? checkEnvelopeCompliance(built, args.envelope.levels, scale) : null;
      const parent = args.parentConceptId ? concepts.find(c => c.id === args.parentConceptId) : null;
      const parentMetrics = parent?.metrics ?? (args.parentMetrics && Number.isFinite(args.parentMetrics.grossFloorAreaSqft) ? args.parentMetrics : null);
      const version = parent ? (parent.version ?? 1) + 1 : args.parentConceptId ? (Number.isInteger(args.parentVersion) ? args.parentVersion + 1 : null) : 1;
      const deltas = parentMetrics ? {
        grossFloorAreaSqft: metrics.grossFloorAreaSqft - parentMetrics.grossFloorAreaSqft,
        ...(Number.isFinite(parentMetrics.far) ? {far: round(metrics.far - parentMetrics.far, 2)} : {}),
        ...(Number.isFinite(parentMetrics.heightFeet) ? {heightFeet: round(metrics.heightFeet - parentMetrics.heightFeet, 1)} : {}),
        ...(Number.isFinite(parentMetrics.storeys) ? {storeys: metrics.storeys - parentMetrics.storeys} : {}),
        ...(Number.isFinite(parentMetrics.units) && metrics.units !== undefined ? {units: metrics.units - parentMetrics.units} : {}),
      } : null;
      const complianceChange = compliance && parent?.compliance ? (compliance.compliant === parent.compliance.compliant ? null : compliance.compliant ? 'now within the envelope' : 'now breaches the envelope') : null;
      const revision = args.parentConceptId || parentMetrics ? {
        parentConceptId: args.parentConceptId || null,
        parentName: parent?.name || (typeof args.parentName === 'string' ? args.parentName.slice(0, 80) : null),
        version,
        note: typeof args.revisionNote === 'string' ? args.revisionNote.slice(0, 300) : '',
        ...(deltas ? {deltas} : {}),
        ...(complianceChange ? {complianceChange} : {}),
        parentMetricsSource: parent ? 'modeled this answer' : parentMetrics ? 'supplied' : 'unavailable',
      } : null;
      const concept = {id: randomUUID(), name: args.name.trim(), summary: typeof args.summary === 'string' ? args.summary.slice(0, 600) : '', units: args.units === 'm' ? 'm' : 'ft', metrics, levels: built, lot: lot.map(p => p.map(n => round(n, 3))), version: version ?? 1, ...(revision ? {revision} : {}), ...(compliance ? {compliance, envelope: {levels: compliance.levels, heightFeet: compliance.envelopeHeightFeet}} : {}), context, scene, createdAt: new Date().toISOString()};
      concepts.push(concept);
      const levels = built.map(({levelId, footprint, ...rest}) => rest);
      const existing = context?.existing ?? null;
      const summary = context ? {buildings: context.buildings.filter(b => !b.existing).length, radiusMeters: context.radiusMeters, existing, sourceId: context.sourceId, frameBasis: context.frameBasis ?? null, parcel: context.parcel ? {bbl: context.parcel.bbl, areaSqft: context.parcel.areaSqft, dataset: context.parcel.sourceId} : null} : null;
      emit('concept.created', {id: concept.id, name: concept.name, summary: concept.summary, metrics, levels, version: concept.version, ...(revision ? {revision} : {}), ...(compliance ? {compliance, envelope: concept.envelope} : {}), context: summary});
      const notes = ['The concept is viewable in the Arosa interface. Areas are gross polygon areas of the modeled footprints; they are not zoning floor area and do not establish an entitlement.'];
      if (summary) notes.push(`${summary.buildings} surrounding buildings were placed around the lot from NYC building footprints${summary.sourceId ? ` (source ${summary.sourceId})` : ''}; their positions relative to the modeled lot are approximate.`);
      if (summary?.parcel) notes.push(`Placement is anchored to the recorded NYC tax lot for BBL ${summary.parcel.bbl} (dataset ${summary.parcel.dataset}, ${summary.parcel.areaSqft.toLocaleString('en-US')} sq ft vs ${metrics.lotAreaSqft.toLocaleString('en-US')} sq ft modeled); the tax-lot outline is drawn in the plan view. A tax lot is not necessarily the zoning lot, and the modeled lot outline still governs the areas above.`);
      if (existing) notes.push(`The existing building on the lot is about ${existing.heightFeet} ft tall with a ${existing.footprintSqft.toLocaleString('en-US')} sq ft footprint${existing.storeys ? `, ${existing.storeys} storeys` : ''}${existing.floorAreaSqft ? ` and ${existing.floorAreaSqft.toLocaleString('en-US')} sq ft of PLUTO floor area` : ''}${existing.yearBuilt ? `, built ${existing.yearBuilt}` : ''}. It is shown for comparison and the concept replaces it.`);
      if (context?.streetView) notes.push(`A Google Street View photo facing the lot${context.streetView.date ? ` (captured ${context.streetView.date})` : ''} accompanies the street view in the interface.`);
      if (revision) {
        const signed = (n, unit = '') => `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}${unit}`;
        const parts = deltas ? [`${signed(deltas.grossFloorAreaSqft)} sq ft`, ...(deltas.far !== undefined ? [`FAR ${signed(deltas.far)}`] : []), ...(deltas.heightFeet !== undefined ? [`${signed(deltas.heightFeet)} ft`] : []), ...(deltas.units !== undefined ? [`${signed(deltas.units)} units`] : [])] : [];
        notes.push(`Revision${revision.version ? ` v${revision.version}` : ''} of ${revision.parentName ? `“${revision.parentName}”` : 'an earlier concept'}${revision.note ? `: ${revision.note}` : ''}${parts.length ? ` (${parts.join(', ')})` : ''}${complianceChange ? `; ${complianceChange}` : ''}. To revert or branch, model again from that concept as the parent.`);
      }
      if (contextNote) notes.push(contextNote);
      if (compliance) notes.push(compliance.compliant
        ? 'Envelope check: every modeled storey sits within the supplied as-of-right envelope (vertex-containment screening, not a zoning determination).'
        : `Envelope check: ${compliance.violations.length} storey(s) fall outside the supplied envelope: ${compliance.violations.map(v => `${v.level}: ${v.reason}`).join('; ')}.`);
      return {conceptId: concept.id, name: concept.name, metrics, levels, version: concept.version, ...(revision ? {revision} : {}), ...(compliance ? {compliance} : {}), ...(summary ? {context: summary} : {}), note: notes.join(' ')};
    } finally {
      await client.close().catch(() => {});
    }
  }
  return {definitions: [conceptDefinition], concepts, handlers: {acres_model_concept: model}};
}
