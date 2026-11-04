// The zoning sheet through the real Python boundary: a drafted scheme plan that carries its option's
// storey outlines builds zd1.svg, zd1.pdf and zoning.json beside its plan files. Skipped where the
// planning venv is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildArchitectureRevision, planningCommand} from './planning.mjs';
import {schemePlan} from './architecture-tools.mjs';
import {exportPlan} from './plan-intake.mjs';
import {schemeOutlines} from './scheme-outlines.mjs';
import {REVISION_FILES} from './architecture-artifacts.mjs';

const skip = existsSync(planningCommand().python) ? false : 'planning/.venv is not installed';
const program = {key: 'standard', zfa: 20000, storeys: 6, units: 24, unitMix: [{type: 'oneBedroom', netSqft: 650, units: 16}, {type: 'twoBedroom', netSqft: 950, units: 8}]};

test('a plan drawn on its outlines builds its zoning sheet and figures', {skip, timeout: 60000}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acres-zd1-'));
  try {
    const scheme = {id: 'as_of_right', label: 'As of right', program};
    const property = {bbl: '3012340001', address: '10 EXAMPLE STREET', zonedist1: 'R7A', lotfront: '50', lotdepth: '100'};
    const site = schemeOutlines(scheme, {property, lot: {exterior: [[0, 0], [50, 0], [50, 100], [0, 100]], holes: [], source: 'tax-lot', note: 'Lot lines come from the city\'s tax map, not a survey.'}});
    const {doc} = await schemePlan(scheme, {frontFeet: 50, depthFeet: 100}, undefined, {site});
    const built = await buildArchitectureRevision({...exportPlan(doc), id: 'p1', revision: 1, parentRevision: null, zoning: site}, {outDir: dir});
    assert.equal(built.hasIfc, true);
    for (const [file, kind] of REVISION_FILES.filter(([, kind]) => ['zd1-svg', 'zd1-pdf', 'zoning'].includes(kind))) assert.ok(existsSync(path.join(dir, file)), `${kind} written`);
    const svg = readFileSync(path.join(dir, 'zd1.svg'), 'utf8');
    assert.match(svg, /10 EXAMPLE STREET, As of right/);
    assert.match(svg, /not a survey/);
    assert.equal(readFileSync(path.join(dir, 'zd1.pdf')).subarray(0, 8).toString(), '%PDF-1.4');
    const figures = JSON.parse(readFileSync(path.join(dir, 'zoning.json'), 'utf8'));
    assert.equal(figures.far.allowed, 4);
    // Every storey the plan draws, each on its own level's plate: the cellar holds no zoning floor area (ZR 12-10).
    assert.equal(figures.storeys.filter(s => s.bottomFeet >= 0).length, site.storeys.length);
    assert.ok(figures.storeys.filter(s => s.bottomFeet < 0).every(s => s.use === 'cellar' && s.zfaSqft === 0));
    assert.ok(figures.storeys.every(s => s.exclusions.every(e => /^ZR /.test(e.section))));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
