import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const infra = name => readFileSync(new URL(`../infra/${name}`, import.meta.url), 'utf8');

// Evaluates the polkit rule the deploy installer writes, as polkitd would, for one request.
function decide(user, request) {
  const rules = [];
  const polkit = {Result: {YES: 'yes'}, addRule: rule => rules.push(rule)};
  vm.runInNewContext(infra('acres-architecture-worker.rules').replaceAll('RESEARCH_USER', user), {polkit});
  const action = {id: request.action ?? 'org.freedesktop.systemd1.manage-units', lookup: key => ({unit: request.unit, verb: request.verb})[key]};
  return rules.map(rule => rule(action, {user: request.user})).find(Boolean) ?? 'default';
}

test('the worker unit rule lets only the research user start and stop architecture worker units', () => {
  const unit = 'acres-architecture-worker@home-openclaw-.openclaw-acres\\x2dstate-architecture-jobs-1.service';
  assert.equal(decide('acres-runtime', {user: 'acres-runtime', unit, verb: 'start'}), 'yes');
  assert.equal(decide('acres-runtime', {user: 'acres-runtime', unit, verb: 'stop'}), 'yes');
  // The research user moved from openclaw to acres-runtime: a rule naming openclaw refused every job.
  assert.equal(decide('openclaw', {user: 'acres-runtime', unit, verb: 'start'}), 'default');
  assert.equal(decide('acres-runtime', {user: 'openclaw', unit, verb: 'start'}), 'default');
  assert.equal(decide('acres-runtime', {user: 'acres-runtime', unit, verb: 'restart'}), 'default');
  assert.equal(decide('acres-runtime', {user: 'acres-runtime', unit: 'acres-research.service', verb: 'stop'}), 'default');
  assert.equal(decide('acres-runtime', {user: 'acres-runtime', unit, verb: 'start', action: 'org.freedesktop.systemd1.reload-daemon'}), 'default');
});

test('the deploy installer gives the worker units and their polkit rule the research service user', () => {
  const installer = infra('acres-deploy-research');
  assert.match(installer, /RULE=\$\(<"\$ROOT\/infra\/acres-architecture-worker\.rules"\)\n\s+printf '%s\\n' "\$\{RULE\/\/RESEARCH_USER\/\$RESEARCH_USER\}" > \/etc\/polkit-1\/rules\.d\/50-acres-architecture-worker\.rules/);
  assert.match(installer, /printf '\[Service\]\\nUser=%s\\nGroup=%s\\n' "\$RESEARCH_USER" .* > \/etc\/systemd\/system\/acres-architecture-worker@\.service\.d\/user\.conf/);
  assert.match(infra('acres-architecture-worker@.service'), /^ExecStart=\/opt\/acres-architecture-worker\/current\/bin\/architecture-worker --job \/%I$/m);
});
