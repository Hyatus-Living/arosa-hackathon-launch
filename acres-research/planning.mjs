import {spawn} from 'node:child_process';
import {executionSignal,throwIfCancelled} from './execution-context.mjs';
import {randomUUID} from 'node:crypto';
import {existsSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_LEVELS = 60, MAX_VERTICES = 24, MAX_WALLS = 400, MAX_ROOMS = 200, MAX_ROOM_VERTICES = 64;
const ID = /^[A-Za-z0-9_.-]{1,64}$/;

function validPolygon(value) {
  return Array.isArray(value) && value.length >= 3 && value.length <= MAX_VERTICES && value.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 5000));
}

const POINT = {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2};

export const planningDefinition = {
  name: 'acres_plan_concept',
  description: 'Lay out test-fit floor plans inside a massing: per storey a double-loaded corridor, stairs at both ends, an elevator core and units sized to a target mix, with NYC Building Code egress checks (exits, separation, travel distance, dead ends) run as code. Supply the lot and the storeys to fill, typically the levels from acres_zoning_envelope, optionally with below-grade parking levels. Returns takeoffs (gross and net area by use, residential efficiency, units by type against target sizes, achievable parking stalls, failed checks with citations) and "pascal" arguments to hand to acres_model_concept so the planned building, with units per storey, renders in the viewer. Ask for "ifc" only when the user wants an IFC4 model to hand to an architect; it is stored with the plan and the result gives its path and hash. Plans are feasibility test fits, not construction documents. For one detailed storey (an apartment or a traced drawing) supply "layout" instead of lot and levels: wall centrelines, door and window openings and rooms in feet. It is validated (rooms closed by walls, no duplicated walls, openings inside their walls and not overlapping) and stored as an architecture plan revision with a dimensioned SVG, an IFC4 model, a detailed Pascal scene with selectable rooms and an id map; pass revisionOf with an earlier plan id to save the next revision of that plan.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: {type: 'string', description: 'Short concept name.'},
      summary: {type: 'string', description: 'One or two sentences on what the plan assumes.'},
      lot: {type: 'array', description: 'Lot outline polygon as [x, z] pairs in feet, street at z = 0.', items: {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2}, minItems: 3},
      levels: {
        type: 'array', minItems: 1, maxItems: MAX_LEVELS,
        description: 'Storeys from the lowest up. Use "count" to repeat one footprint; mark cellar parking with belowGrade.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            label: {type: 'string'},
            use: {type: 'string', enum: ['residential', 'office', 'retail', 'parking', 'amenity'], description: 'Storey use; residential storeys get units, parking storeys get stalls, the rest stay open plan around the core.'},
            footprint: {type: 'array', items: {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2}, minItems: 3},
            height: {type: 'number', description: 'Floor-to-floor height in feet.'},
            count: {type: 'integer', minimum: 1, maximum: MAX_LEVELS},
            belowGrade: {type: 'boolean', description: 'This storey sits below grade (cellar parking).'},
          },
          required: ['footprint', 'height'],
        },
      },
      mix: {
        type: 'array', minItems: 1, maxItems: 8,
        description: 'Residential unit mix; shares are relative weights. Defaults to 20% studio, 45% one-bed, 25% two-bed, 10% three-bed at market target sizes.',
        items: {type: 'object', additionalProperties: false, properties: {name: {type: 'string'}, share: {type: 'number', minimum: 0.01, maximum: 1}, targetSqft: {type: 'number', minimum: 200, maximum: 5000}}, required: ['name', 'share', 'targetSqft']},
      },
      maxFar: {type: 'number', description: 'Maximum modeled gross floor area divided by lot area. Enforced before layout; this does not calculate legal zoning exclusions.'},
      maxHeightFeet: {type: 'number', description: 'Maximum modeled above-grade height in feet, enforced before layout.'},
      ifc: {type: 'boolean', description: 'Also write the IFC4 model into the stored plan. Defaults to false; the file is roughly 100 KB for a tower.'},
      layout: {
        type: 'object', additionalProperties: false,
        description: 'A detailed single-storey plan in feet, x east and y north, used instead of lot and levels.',
        properties: {
          height: {type: 'number', description: 'Storey and default wall height in feet.'},
          wall_thickness: {type: 'number', description: 'Default wall thickness in feet.'},
          floor_thickness: {type: 'number', description: 'Floor slab thickness in feet.'},
          walls: {type: 'array', minItems: 1, maxItems: MAX_WALLS, description: 'Wall centrelines; a wall shared by two rooms appears once.', items: {type: 'object', additionalProperties: false, properties: {id: {type: 'string'}, start: POINT, end: POINT, thickness: {type: 'number'}, height: {type: 'number'}, material: {type: 'string'}}, required: ['id', 'start', 'end']}},
          openings: {type: 'array', maxItems: MAX_WALLS, items: {type: 'object', additionalProperties: false, properties: {
            id: {type: 'string'}, kind: {type: 'string', enum: ['door', 'window']}, wall: {type: 'string', description: 'Id of the wall the opening is in.'},
            offset: {type: 'number', description: 'Feet from the wall start to the near edge of the opening.'}, width: {type: 'number'}, height: {type: 'number'}, sill: {type: 'number', description: 'Feet above the floor; 0 for doors.'},
            swing: {type: 'object', additionalProperties: false, properties: {hinge: {type: 'string', enum: ['start', 'end']}, side: {type: 'string', enum: ['left', 'right']}}, required: ['hinge', 'side'], description: 'Door hinge end and the side of the wall it opens to, looking from the wall start to its end.'},
          }, required: ['id', 'kind', 'wall', 'offset', 'width', 'height']}},
          rooms: {type: 'array', minItems: 1, maxItems: MAX_ROOMS, items: {type: 'object', additionalProperties: false, properties: {
            id: {type: 'string'}, name: {type: 'string'},
            bounds: {type: 'array', items: {type: 'number'}, minItems: 4, maxItems: 4, description: '[xMin, yMin, xMax, yMax] on wall centrelines for a rectangular room.'},
            polygon: {type: 'array', items: POINT, minItems: 3, maxItems: MAX_ROOM_VERTICES, description: 'Room boundary on wall centrelines, for a room that is not a rectangle.'},
          }, required: ['id', 'name']}},
        },
        required: ['height', 'wall_thickness', 'floor_thickness', 'walls', 'rooms'],
      },
      revisionOf: {type: 'string', description: 'With layout: the id of an earlier detailed plan this layout revises. It keeps the plan id and element ids and becomes the next revision.'},
    },
    required: ['name'],
  },
};

export function planningCommand(planningDir) {
  const dir = planningDir || process.env.ACRES_PLANNING_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'planning');
  return {dir, python: path.join(dir, '.venv', 'bin', 'python'), script: path.join(dir, 'run.py')};
}

// Plan revisions live in the acres state directory beside chat.sqlite, as store.mjs and dream.mjs resolve it.
export function architectureDir() {
  return process.env.ACRES_ARCHITECTURE_DIR || path.join(path.dirname(process.env.RESEARCH_STATE_PATH || '/home/openclaw/.openclaw/acres-state/chat.sqlite'), 'architecture');
}

export function planRevisionDir(planId, revision) {
  return path.join(architectureDir(), 'plans', planId, String(revision));
}

// File references for one plan revision, from the sidecar's artifact list; never file contents.
export function planFiles(outDir, artifacts = {}) {
  const at = name => artifacts[name] ? path.join(outDir, artifacts[name].file) : null;
  return {
    hasIfc: Boolean(artifacts.ifc),
    ifcPath: at('ifc'),
    ifcSha256: artifacts.ifc?.sha256 ?? null,
    ifcBytes: artifacts.ifc?.bytes ?? null,
    planPath: at('plan'),
    svgPath: at('svg'),
    pascalScenePath: at('pascalScene'),
    idMapPath: at('idMap'),
  };
}

export function planRevisions(planId) {
  const dir = path.join(architectureDir(), 'plans', planId);
  if (!/^[0-9a-f-]{36}$/i.test(planId) || !existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^\d+$/.test(name)).map(Number);
}

function checkLayout(layout) {
  const finite = n => Number.isFinite(n) && Math.abs(n) <= 5000;
  const point = p => Array.isArray(p) && p.length === 2 && p.every(finite);
  if (!layout || typeof layout !== 'object') throw new Error('The layout must be an object.');
  for (const key of ['height', 'wall_thickness', 'floor_thickness']) if (!(finite(layout[key]) && layout[key] > 0)) throw new Error(`The layout needs a positive ${key} in feet.`);
  if (!Array.isArray(layout.walls) || !layout.walls.length || layout.walls.length > MAX_WALLS) throw new Error(`Supply 1 to ${MAX_WALLS} walls.`);
  if (!Array.isArray(layout.rooms) || !layout.rooms.length || layout.rooms.length > MAX_ROOMS) throw new Error(`Supply 1 to ${MAX_ROOMS} rooms.`);
  if (layout.openings !== undefined && (!Array.isArray(layout.openings) || layout.openings.length > MAX_WALLS)) throw new Error(`Supply at most ${MAX_WALLS} openings.`);
  for (const wall of layout.walls) if (!ID.test(wall.id) || !point(wall.start) || !point(wall.end)) throw new Error('Each wall needs an id of letters, digits, dots, dashes or underscores and [x, y] start and end points in feet.');
  for (const o of layout.openings || []) if (!ID.test(o.id) || !['door', 'window'].includes(o.kind) || typeof o.wall !== 'string' || ![o.offset, o.width, o.height, o.sill ?? 0].every(finite)) throw new Error('Each opening needs an id, a kind of door or window, its wall id and an offset, width and height in feet.');
  for (const room of layout.rooms) {
    if (!ID.test(room.id) || typeof room.name !== 'string' || !room.name.trim() || room.name.length > 80) throw new Error('Each room needs an id and a name of at most 80 characters.');
    const shaped = room.bounds ? Array.isArray(room.bounds) && room.bounds.length === 4 && room.bounds.every(finite) : Array.isArray(room.polygon) && room.polygon.length >= 3 && room.polygon.length <= MAX_ROOM_VERTICES && room.polygon.every(point);
    if (!shaped) throw new Error('Each room needs bounds [xMin, yMin, xMax, yMax] or a polygon of [x, y] points in feet.');
  }
}

export function spawnPlanner(request, {planningDir, timeoutMs = 120000} = {}) {
  throwIfCancelled();
  const {python, script} = planningCommand(planningDir);
  return new Promise((resolve, reject) => {
    // A fixed hash seed: the planner's choices never depend on a process's string hash order.
    const child = spawn(python, [script], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, PYTHONHASHSEED: '0'}});
    const signal=executionSignal(),abort=()=>child.kill('SIGKILL');
    signal?.addEventListener('abort',abort,{once:true});
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`The planning engine did not finish within ${Math.round(timeoutMs / 1000)} seconds.`)); }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error.code === 'ENOENT' ? new Error('The planning environment is not installed on this host (planning/.venv is missing).') : error); });
    child.on('close', code => {
      signal?.removeEventListener('abort',abort);
      clearTimeout(timer);
      if(signal?.aborted){reject(signal.reason);return;}
      try {
        const parsed = JSON.parse(out);
        if (code === 0 && !parsed.error) return resolve(parsed);
        reject(Object.assign(new Error(`Planning failed: ${parsed.error || err.trim() || `exit ${code}`}`), parsed.validationErrors ? {validationErrors: parsed.validationErrors} : {}));
      } catch { reject(new Error(`Planning failed: ${err.trim().slice(-300) || `exit ${code}`}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// Export a validated architecture plan v1 document into its staged revision directory, where the caller
// has already written plan.json. Invalid geometry or a malformed document rejects with status 400 and
// validationErrors; any other failure is the planning environment's.
export async function buildArchitectureRevision(plan, {outDir, planningDir, timeoutMs} = {}) {
  const out = await spawnPlanner({plan, outDir}, {planningDir, timeoutMs}).catch(error => {
    if (error.validationErrors) error.status = 400;
    throw error;
  });
  return {id: out.plan.id, revision: out.plan.revision, parentRevision: out.plan.parentRevision, counts: out.plan.counts, rooms: out.plan.rooms, ...planFiles(outDir, out.artifacts)};
}

// run is injectable for tests; available defaults to the sidecar being installed, so the tool is
// only offered where the planning environment exists.
export function createPlanningTools({run = request => spawnPlanner(request, {planningDir}), planningDir, available, emit = () => {}} = {}) {
  const command = planningCommand(planningDir);
  const ready = available ?? (existsSync(command.python) && existsSync(command.script));
  const plans = [];
  async function planLayout(args) {
    checkLayout(args.layout);
    let id = randomUUID(), revision = 1, parentRevision = null;
    if (args.revisionOf !== undefined) {
      const revisions = planRevisions(String(args.revisionOf));
      if (!revisions.length) throw new Error(`Unknown plan ${String(args.revisionOf).slice(0, 80)}; revise a plan id returned earlier.`);
      id = args.revisionOf;
      parentRevision = Math.max(...revisions);
      revision = parentRevision + 1;
    }
    const outDir = planRevisionDir(id, revision);
    // The tool takes feet; run.py multiplies by 0.3048 once and stores metres.
    const out = await run({layout: {...args.layout, openings: args.layout.openings || [], name: args.name.trim(), units: 'ft'}, planId: id, revision, parentRevision, outDir});
    throwIfCancelled();
    if (out?.error) throw new Error(`Planning failed: ${out.error}`);
    const plan = {id, revision, parentRevision, kind: 'detailed', name: out.plan.name, counts: out.plan.counts, rooms: out.plan.rooms, ...planFiles(outDir, out.artifacts)};
    plans.push({...plan, createdAt: new Date().toISOString()});
    emit('plan.created', {name: plan.name, revision});
    return {
      plan,
      note: `Detailed plan ${id} revision ${revision}${parentRevision ? ` (revises ${parentRevision})` : ''}: ${plan.counts.rooms} rooms, ${plan.counts.walls} walls, ${plan.counts.doors} doors and ${plan.counts.windows} windows, validated and stored in metres with a dimensioned SVG, an IFC4 model, a detailed Pascal scene and an id map. Room areas are net of walls (inside wall faces).`,
    };
  }

  async function planConcept(args) {
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80) throw new Error('Give the concept a short name.');
    if (args.layout !== undefined) return planLayout(args);
    if (!validPolygon(args.lot)) throw new Error('The lot must be a polygon of 3 to 24 [x, z] points.');
    if (!Array.isArray(args.levels) || !args.levels.length) throw new Error('Supply at least one storey to plan.');
    let expanded = 0;
    for (const level of args.levels) {
      if (!validPolygon(level.footprint)) throw new Error('Each storey needs a footprint polygon of 3 to 24 [x, z] points.');
      if (!(Number.isFinite(level.height) && level.height > 0 && level.height <= 40)) throw new Error('Each storey needs a positive floor-to-floor height of at most 40 ft.');
      if (level.count !== undefined && (!Number.isInteger(level.count) || level.count < 1 || level.count > MAX_LEVELS)) throw new Error(`Storey count must be an integer from 1 to ${MAX_LEVELS}.`);
      expanded += level.count ?? 1;
    }
    if (expanded > MAX_LEVELS) throw new Error(`Plan at most ${MAX_LEVELS} storeys.`);
    for (const key of ['maxFar', 'maxHeightFeet']) if (args[key] !== undefined && !(Number.isFinite(args[key]) && args[key] > 0)) throw new Error(`${key} must be positive and finite.`);
    if (args.mix !== undefined) {
      if (!Array.isArray(args.mix) || !args.mix.length) throw new Error('The unit mix needs at least one unit type.');
      for (const m of args.mix) if (!m.name || !(m.share > 0) || !(m.targetSqft > 0)) throw new Error('Each mix entry needs a name, a positive share and a positive targetSqft.');
    }
    const request = {
      name: args.name.trim(),
      ...(typeof args.summary === 'string' ? {summary: args.summary.slice(0, 600)} : {}),
      lot: args.lot,
      levels: args.levels.map(level => ({...(level.label ? {label: level.label} : {}), use: level.use || 'residential', footprint: level.footprint, height: level.height, ...(level.count ? {count: level.count} : {}), ...(level.belowGrade ? {belowGrade: true} : {})})),
      ...(args.mix ? {mix: args.mix} : {}),
      ...(Number.isFinite(args.maxFar) ? {maxFar: args.maxFar} : {}),
      ...(Number.isFinite(args.maxHeightFeet) ? {maxHeightFeet: args.maxHeightFeet} : {}),
      ...(args.ifc === true ? {ifc: true} : {}),
    };
    const id = randomUUID(), revision = 1, outDir = planRevisionDir(id, revision);
    const out = await run({...request, outDir});
    throwIfCancelled();
    if (out?.error) throw new Error(`Planning failed: ${out.error}`);
    const failed = out.takeoffs?.checks?.failed?.length ?? 0;
    const {artifacts, ...result} = out;
    const plan = {id, revision, parentRevision: null, kind: 'test-fit', name: request.name, ...planFiles(outDir, artifacts)};
    plans.push({...plan, takeoffs: result.takeoffs || null, pascal: result.pascal || null, levels: request.levels, createdAt: new Date().toISOString()});
    emit('plan.created', {name: request.name, failedChecks: failed});
    return {
      ...result,
      plan,
      note: `Test-fit plans from the planning engine (double-loaded corridor, stacked core, units stretched to fill each band). ${failed ? `${failed} code check(s) failed; see takeoffs.checks.failed with citations. ` : `All ${out.takeoffs?.checks?.total ?? 0} egress and depth checks pass. `}Hand "pascal" to acres_model_concept to draw the planned building. Areas are modeled gross/net areas, not zoning floor area.`,
    };
  }
  return {definitions: ready ? [planningDefinition] : [], handlers: ready ? {acres_plan_concept: planConcept} : {}, plans};
}
