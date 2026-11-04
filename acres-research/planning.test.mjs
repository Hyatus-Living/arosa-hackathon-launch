import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPlanningTools, planningCommand, spawnPlanner} from './planning.mjs';

const lot = [[0, 0], [100, 0], [100, 50], [0, 50]];

test('the planner is only offered where the sidecar is installed', () => {
  assert.deepEqual(createPlanningTools({available: false}).definitions, []);
  assert.deepEqual(createPlanningTools({available: false}).handlers, {});
  const command = planningCommand('/x/planning');
  assert.equal(command.python, '/x/planning/.venv/bin/python');
  assert.equal(command.script, '/x/planning/run.py');
});

test('every planner process runs with the same hash seed, so a redrawn option draws the same plan', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'planning-'));
  mkdirSync(path.join(dir, '.venv', 'bin'), {recursive: true});
  const python = path.join(dir, '.venv', 'bin', 'python');
  writeFileSync(python, '#!/bin/sh\nprintf \'{"seed": "%s"}\' "$PYTHONHASHSEED"\n');
  chmodSync(python, 0o755);
  assert.deepEqual(await spawnPlanner({}, {planningDir: dir}), {seed: '0'});
});

test('plan requests are shaped for the sidecar and results pass through', async () => {
  let received;
  const tools = createPlanningTools({available: true, run: async request => { received = request; return {takeoffs: {grossFloorAreaSqft: 10000, checks: {total: 12, failed: []}}, pascal: {levels: []}}; }});
  const result = await tools.handlers.acres_plan_concept({
    name: 'Test fit', lot, maxFar: 10,
    levels: [{use: 'parking', footprint: lot, height: 10, belowGrade: true}, {footprint: lot, height: 11, count: 5}],
  });
  assert.equal(received.levels[0].belowGrade, true);
  assert.equal(received.levels[1].use, 'residential');
  assert.equal(received.levels[1].count, 5);
  assert.equal(received.maxFar, 10);
  assert.equal(received.ifc, undefined);
  assert.equal(result.takeoffs.grossFloorAreaSqft, 10000);
  assert.match(result.note, /All 12 egress and depth checks pass/);
});

test('sidecar errors and failed checks surface plainly', async () => {
  const failing = createPlanningTools({available: true, run: async () => ({takeoffs: {checks: {total: 3, failed: [{rule: 'travel'}]}}, pascal: {}})});
  const result = await failing.handlers.acres_plan_concept({name: 'X', lot, levels: [{footprint: lot, height: 11}]});
  assert.match(result.note, /1 code check\(s\) failed/);
  const broken = createPlanningTools({available: true, run: async () => ({error: 'ValueError: bad outline'})});
  await assert.rejects(broken.handlers.acres_plan_concept({name: 'X', lot, levels: [{footprint: lot, height: 11}]}), /Planning failed: ValueError: bad outline/);
  const invalid = createPlanningTools({available: true, run: async () => ({})});
  await assert.rejects(invalid.handlers.acres_plan_concept({name: 'X', lot, levels: [{footprint: [[0, 0]], height: 11}]}), /footprint polygon/);
});

test('the research host installer ships the planning module research imports', () => {
  const installer = readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8');
  assert.match(installer, /\bplanning\.mjs\b/);
  assert.match(installer, /\bresearch\.mjs\b/);
});
