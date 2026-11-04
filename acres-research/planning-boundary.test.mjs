// Exercises the real Python-to-JavaScript boundary: planning.mjs spawns planning/run.py with the
// planning venv, exactly as the research service does. Skipped where the venv is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPlanningTools, planningCommand} from './planning.mjs';

const {python} = planningCommand();
const skip = existsSync(python) ? false : 'planning/.venv is not installed';
const lot = [[0, 0], [100, 0], [100, 120], [0, 120]];
const footprint = [[10, 10], [90, 10], [90, 110], [10, 110]];

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

function ifcStoreys(file) {
  return Number(execFileSync(python, ['-c', 'import sys, ifcopenshell; f = ifcopenshell.open(sys.argv[1]); print(len(f.by_type("IfcBuildingStorey")))', file]).toString().trim());
}

test('a requested IFC survives into the stored plan as a file under architecture/plans/<planId>/<revision>/', {skip}, withStateDir(async dir => {
  const tools = createPlanningTools({available: true});
  const result = await tools.handlers.acres_plan_concept({name: 'Boundary test', lot, levels: [{footprint, height: 11, count: 3}], ifc: true});
  const [plan] = tools.plans;
  assert.equal(plan.hasIfc, true);
  assert.equal(plan.revision, 1);
  assert.equal(path.dirname(plan.ifcPath), path.join(dir, 'plans', plan.id, '1'));
  const bytes = readFileSync(plan.ifcPath);
  assert.equal(plan.ifcBytes, bytes.length);
  assert.equal(plan.ifcSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(ifcStoreys(plan.ifcPath), 3);
  assert.doesNotMatch(JSON.stringify(result), /ifcBase64/);
  assert.doesNotMatch(JSON.stringify(tools.plans), /ifcBase64/);
  assert.equal(result.plan.ifcPath, plan.ifcPath);
}));

test('a plan without IFC still works and writes no IFC', {skip}, withStateDir(async () => {
  const tools = createPlanningTools({available: true});
  const result = await tools.handlers.acres_plan_concept({name: 'No IFC', lot, levels: [{footprint, height: 11}]});
  const [plan] = tools.plans;
  assert.equal(plan.hasIfc, false);
  assert.equal(plan.ifcPath, null);
  assert.ok(result.takeoffs.grossFloorAreaSqft > 0);
}));

test('the real planner rejects off-site footprints, invalid repeat counts and supplied capacity limits before publishing plans', {skip}, withStateDir(async()=>{
  const tools=createPlanningTools({available:true});
  const base={name:'Capacity boundary',lot,levels:[{footprint,height:11}]};
  for(const request of [
    {...base,levels:[{footprint:footprint.map(([x,y])=>[x+200,y]),height:11}]},
    {...base,maxFar:.1}, {...base,maxHeightFeet:5},
    {...base,levels:[{footprint,height:11,count:0}]},
    {...base,levels:[{footprint,height:11,count:1.5}]},
    {...base,lot:[[0,0],[100,120],[0,120],[100,0]]},
  ]) await assert.rejects(tools.handlers.acres_plan_concept(request),/footprint|FAR|height|count|polygon|lot/i);
  assert.equal(tools.plans.length,0);
  const accepted=await tools.handlers.acres_plan_concept({...base,maxFar:1,maxHeightFeet:12});
  assert.ok(accepted.takeoffs.grossFloorAreaSqft>0);assert.equal(tools.plans.length,1);
}));
