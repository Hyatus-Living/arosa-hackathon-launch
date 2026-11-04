// The detailed plan path through the real tool boundary: acres_plan_concept takes the sample layout in
// feet, planning/run.py converts it once to metres and writes the revision's files, and the Pascal scene
// loads and validates in Pascal itself. Skipped where planning/.venv is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SceneBridge} from '@pascal-app/mcp';
import {buildArchitectureRevision, createPlanningTools, planningCommand} from './planning.mjs';

const {python} = planningCommand();
const skip = existsSync(python) ? false : 'planning/.venv is not installed';
const FOOT = 0.3048;
const fixture = JSON.parse(readFileSync(new URL('../planning/fixtures/sample-floorplan.json', import.meta.url), 'utf8'));

// The fixture is in metres; the tool takes feet like every other acres_plan_concept input.
function layoutInFeet() {
  const ft = value => value / FOOT;
  return {
    height: ft(fixture.height), wall_thickness: ft(fixture.wall_thickness), floor_thickness: ft(fixture.floor_thickness),
    walls: fixture.walls.map(w => ({id: w.id, start: w.start.map(ft), end: w.end.map(ft)})),
    openings: fixture.openings.map(o => ({id: o.id, kind: o.kind, wall: o.wall, offset: ft(o.offset), width: ft(o.width), height: ft(o.height), sill: ft(o.sill)})),
    rooms: fixture.rooms.map(r => ({id: r.id, name: r.name, bounds: r.bounds.map(ft)})),
  };
}

function withStateDir(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acres-arch-'));
    const previous = process.env.ACRES_ARCHITECTURE_DIR;
    process.env.ACRES_ARCHITECTURE_DIR = dir;
    try { await fn(dir); } finally {
      if (previous === undefined) delete process.env.ACRES_ARCHITECTURE_DIR; else process.env.ACRES_ARCHITECTURE_DIR = previous;
      rmSync(dir, {recursive: true, force: true});
    }
  };
}

const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 0.001, `${what}: ${actual} != ${expected}`);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

test('a layout in feet becomes one stored plan revision with SVG, IFC, Pascal scene and id map', {skip}, withStateDir(async dir => {
  const tools = createPlanningTools({available: true});
  const result = await tools.handlers.acres_plan_concept({name: 'Two-bedroom workflow test', layout: layoutInFeet()});
  const [plan] = tools.plans;
  const revisionDir = path.join(dir, 'plans', plan.id, '1');
  assert.equal(plan.revision, 1);
  assert.equal(plan.parentRevision, null);
  assert.equal(plan.hasIfc, true);
  assert.deepEqual(readdirSync(revisionDir).sort(), ['drawings.dxf', 'drawings.pdf', 'idmap.json', 'model.ifc', 'package.zip', 'pascal-scene.json', 'plan.json', 'plan.svg', 'schedules.xlsx', 'selfcheck.json']);
  for (const key of ['ifcPath', 'svgPath', 'pascalScenePath', 'idMapPath', 'planPath']) assert.equal(path.dirname(plan[key]), revisionDir, key);
  assert.equal(plan.ifcSha256, sha(plan.ifcPath));
  assert.equal(plan.ifcBytes, readFileSync(plan.ifcPath).length);
  assert.deepEqual(plan.counts, {levels: 1, walls: 8, openings: 9, doors: 5, windows: 4, rooms: 5});
  assert.deepEqual(result.plan, Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'createdAt')));
  assert.doesNotMatch(JSON.stringify(result), /base64/i);

  // Feet were multiplied by 0.3048 exactly once on the way in.
  const doc = readJson(plan.planPath);
  assert.equal(doc.units, 'm');
  near(doc.levels[0].height, 2.8, 'level height');
  const south = doc.walls.find(w => w.id === 'wall-south');
  near(south.end[0], 10, 'south wall length');
  near(south.thickness, 0.18, 'wall thickness');
  near(doc.openings.find(o => o.id === 'opening-entry').offset, 4.55, 'entry offset');

  const ifc = execFileSync(python, ['-c', 'import sys, ifcopenshell; f = ifcopenshell.open(sys.argv[1]); print(len(f.by_type("IfcSpace")), len(f.by_type("IfcOpeningElement")))', plan.ifcPath]).toString().trim();
  assert.equal(ifc, '5 9');
  assert.match(readFileSync(plan.svgPath, 'utf8'), /10\.00 m/);
}));

test('the detailed Pascal scene loads and validates in Pascal with every room selectable', {skip}, withStateDir(async () => {
  const tools = createPlanningTools({available: true});
  await tools.handlers.acres_plan_concept({name: 'Pascal check', layout: layoutInFeet()});
  const [plan] = tools.plans;
  const scene = readJson(plan.pascalScenePath);
  const idmap = readJson(plan.idMapPath);
  const bridge = new SceneBridge();
  bridge.loadJSON(scene);
  const validation = bridge.validateScene();
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  const loaded = bridge.getNodes();
  const zones = Object.values(loaded).filter(n => n.type === 'zone');
  assert.deepEqual(zones.map(z => z.name).sort(), ['Bathroom', 'Bedroom A', 'Bedroom B', 'Kitchen', 'Living / dining']);
  for (const room of fixture.rooms) {
    const node = loaded[idmap.elements[`room-${room.id}`].pascalNodeId];
    assert.equal(node.type, 'zone');
    assert.equal(node.name, room.name);
  }
  // Pascal 1.0.4 (room-first) kept the authored geometry as written — no re-centred walls, moved
  // openings or duplicated nodes — except zone polygons, which it re-derives from the boundary
  // walls (gross, to wall centrelines). The stored scene keeps the plan's net rings and netArea.
  assert.equal(Object.keys(loaded).length, Object.keys(scene.nodes).length);
  const ringArea = ring => Math.abs(ring.reduce((sum, [x1, z1], i) => sum + x1 * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * z1, 0)) / 2;
  const storedPlan = readJson(plan.planPath);
  for (const [id, node] of Object.entries(scene.nodes)) {
    for (const key of ['start', 'end', 'position', 'polygon', 'height', 'thickness', 'width']) {
      if (node[key] === undefined || (node.type === 'zone' && key === 'polygon')) continue;
      assert.deepEqual(loaded[id][key], node[key], `${id}.${key}`);
    }
    if (node.type !== 'zone') continue;
    const loadedZone = loaded[id];
    const room = storedPlan.rooms.find(r => r.id === node.metadata.acresId);
    assert.ok(room, `${id} names a plan room`);
    assert.equal(loadedZone.metadata.acresId, node.metadata.acresId);
    assert.equal(loadedZone.metadata.netArea, node.metadata.netArea);
    near(ringArea(loadedZone.polygon), ringArea(room.polygon), `${room.name} derived zone is the gross room ring`);
    assert.deepEqual(loadedZone.boundaryWallIds.map(w => loaded[w].metadata.acresId).sort(),
      node.boundaryWallIds.map(w => scene.nodes[w].metadata.acresId).sort(), `${room.name} keeps its boundary walls`);
  }
}));

test('a revision keeps the plan id and element ids and records its parent', {skip}, withStateDir(async dir => {
  const tools = createPlanningTools({available: true});
  await tools.handlers.acres_plan_concept({name: 'Revision A', layout: layoutInFeet()});
  const first = tools.plans[0];
  const moved = layoutInFeet();
  moved.walls.find(w => w.id === 'bedrooms').start[0] = 4.5 / FOOT;
  moved.walls.find(w => w.id === 'bedrooms').end[0] = 4.5 / FOOT;
  moved.rooms.find(r => r.id === 'bedroom-a').bounds[2] = 4.5 / FOOT;
  moved.rooms.find(r => r.id === 'bedroom-b').bounds[0] = 4.5 / FOOT;
  await tools.handlers.acres_plan_concept({name: 'Revision B', layout: moved, revisionOf: first.id});
  const second = tools.plans[1];
  assert.equal(second.id, first.id);
  assert.equal(second.revision, 2);
  assert.equal(second.parentRevision, 1);
  assert.equal(path.dirname(second.ifcPath), path.join(dir, 'plans', first.id, '2'));
  assert.deepEqual(readJson(second.idMapPath).elements, readJson(first.idMapPath).elements);
  near(readJson(first.planPath).walls.find(w => w.id === 'wall-bedrooms').start[0], 4, 'revision A wall');
  near(readJson(second.planPath).walls.find(w => w.id === 'wall-bedrooms').start[0], 4.5, 'revision B wall');
  assert.notEqual(second.ifcSha256, first.ifcSha256);
  await assert.rejects(tools.handlers.acres_plan_concept({name: 'X', layout: moved, revisionOf: '../../etc'}), /Unknown plan/);
}));

test('an invalid layout is rejected with structured errors and writes nothing', {skip}, withStateDir(async dir => {
  const tools = createPlanningTools({available: true});
  const layout = layoutInFeet();
  layout.openings.find(o => o.id === 'entry').offset = 9.5 / FOOT;
  const error = await tools.handlers.acres_plan_concept({name: 'Broken', layout}).catch(e => e);
  assert.match(error.message, /opening_outside_wall/);
  assert.deepEqual(error.validationErrors.map(e => [e.code, e.id]), [['opening_outside_wall', 'opening-entry']]);
  assert.deepEqual(tools.plans, []);
  assert.equal(existsSync(path.join(dir, 'plans')) ? readdirSync(path.join(dir, 'plans')).flatMap(id => readdirSync(path.join(dir, 'plans', id))).length : 0, 0);
}));

const samplePlan = JSON.parse(readFileSync(new URL('../planning/fixtures/sample-plan.json', import.meta.url), 'utf8'));

// The jobs service stages <state>/architecture/plans/<planId>/<revision>/, writes plan.json there, then calls this.
function stage(dir, plan) {
  const outDir = path.join(dir, 'plans', plan.id, String(plan.revision));
  mkdirSync(outDir, {recursive: true});
  writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan));
  return outDir;
}

test('buildArchitectureRevision exports a validated plan document into the staged revision directory', {skip}, withStateDir(async dir => {
  const plan = {...samplePlan, id: '7b0d7a52-8f3e-4f57-9a43-2b2a1b7d1c11', revision: 3, parentRevision: 2};
  const outDir = stage(dir, plan);
  const before = readFileSync(path.join(outDir, 'plan.json'));
  const result = await buildArchitectureRevision(plan, {outDir});
  assert.deepEqual(Object.keys(result).sort(), ['counts', 'hasIfc', 'id', 'idMapPath', 'ifcBytes', 'ifcPath', 'ifcSha256', 'parentRevision', 'pascalScenePath', 'planPath', 'revision', 'rooms', 'svgPath'].sort());
  assert.equal(result.id, plan.id);
  assert.equal(result.revision, 3);
  assert.equal(result.parentRevision, 2);
  assert.equal(result.hasIfc, true);
  assert.equal(result.ifcSha256, sha(result.ifcPath));
  assert.equal(result.ifcBytes, readFileSync(result.ifcPath).length);
  assert.deepEqual(readFileSync(result.planPath), before);
  assert.deepEqual(readdirSync(outDir).sort(), ['drawings.dxf', 'drawings.pdf', 'idmap.json', 'model.ifc', 'package.zip', 'pascal-scene.json', 'plan.json', 'plan.svg', 'schedules.xlsx', 'selfcheck.json']);
  assert.equal(readJson(result.idMapPath).revision, 3);
  assert.deepEqual(result.counts, {levels: 1, walls: 8, openings: 9, doors: 5, windows: 4, rooms: 5});
}));

test('buildArchitectureRevision rejects invalid geometry and malformed documents with status 400', {skip}, withStateDir(async dir => {
  const overlapping = structuredClone(samplePlan);
  overlapping.openings.find(o => o.id === 'opening-living-window').offset = 4.0;
  const outDir = stage(dir, overlapping);
  const error = await buildArchitectureRevision(overlapping, {outDir}).catch(e => e);
  assert.equal(error.status, 400);
  assert.deepEqual(error.validationErrors.map(e => e.code), ['opening_overlap']);
  assert.deepEqual(readdirSync(outDir), ['plan.json']);
  const {walls: _walls, ...malformed} = samplePlan;
  const shapeError = await buildArchitectureRevision(malformed, {outDir}).catch(e => e);
  assert.equal(shapeError.status, 400);
  assert.match(shapeError.message, /walls/);
}));
