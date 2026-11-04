import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {buildParcelDiagnostics} from './parcels.mjs';
import {entitlementScenarios} from './entitlements.mjs';

const root = new URL('..', import.meta.url).pathname;
const skillFiles = ['acres-research/skills', 'acres-mcp/plugin/skills', 'skills'].flatMap(dir =>
  readdirSync(join(root, dir), {withFileTypes: true}).filter(d => d.isDirectory()).map(d => join(root, dir, d.name, 'SKILL.md')));
const diagnostics = buildParcelDiagnostics({bbl: '1000470001', lot: '1', lotarea: '10000', bldgarea: '30000', builtfar: '3', residfar: '6', commfar: '2', facilfar: '6.5', lotfront: '100', lotdepth: '100', bldgclass: 'O4'});

test('every parcel diagnostic a skill tells the agent to check exists in buildParcelDiagnostics output', () => {
  const sections = Object.keys(diagnostics).filter(k => diagnostics[k] && typeof diagnostics[k] === 'object');
  const named = new Set();
  for (const file of skillFiles) {
    const text = readFileSync(file, 'utf8');
    for (const [, path] of text.matchAll(/`parcelDiagnostics\.([\w.]+)`/g)) named.add(path);
    for (const [, section, key] of text.matchAll(new RegExp(`\`(${sections.join('|')})\\.(\\w+)\``, 'g'))) named.add(`${section}.${key}`);
  }
  assert.ok(named.has('ownershipAndEncumbranceCheck.isNychaPublicHousing'));
  assert.ok(named.has('ownershipAndEncumbranceCheck.isTransitOrUtilityRightOfWay'));
  const missing = [...named].filter(path => path.split('.').reduce((node, key) => (node && Object.hasOwn(node, key) ? node[key] : undefined), diagnostics) === undefined);
  assert.deepEqual(missing, []);
});

test('the playbook states the landmark transfer certification caps the code enforces, 30 percent in C5-5', () => {
  const playbook = readFileSync(join(root, 'acres-research/skills/nyc-statutory-playbooks/SKILL.md'), 'utf8');
  const landmark = playbook.split('\n').find(line => line.includes('**Landmark TDR'));
  assert.match(landmark, /`20%` above its maximum floor area, or `30%` in Commercial and Manufacturing districts whose non-residential maximum FAR is `15\.0` or more \(for example `C5-3`, `C5-5`/);
  assert.match(landmark, /`ZR 74-79` special permit/);
  assert.doesNotMatch(playbook, /uncapped in/i);
  const c55 = entitlementScenarios({district: 'C5-5', lotAreaSqft: 10000, landmark: {lotAreaSqft: 20000, existingFloorAreaSqft: 0, maxFar: 15}}).scenarios.find(s => s.id === 'landmark-transfer');
  assert.equal(c55.receivingCapPercent, 30, 'the playbook and the computed transfer agree');
});
