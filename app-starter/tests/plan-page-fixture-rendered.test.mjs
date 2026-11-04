import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {validatePlan, exportPlan} from '../public/plan-intake.js';

const freePort = () => new Promise(resolve => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    server.close(() => resolve(port));
  });
});

test('only the explicit rendered-demo hook publishes the matching sample walkthrough', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, ['tests/plan-page-fixture/server.mjs'], {cwd: new URL('..', import.meta.url), env: {...process.env, PORT: String(port)}, stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not start within 10 s')), 10000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited with code ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const before = await (await fetch(`${base}/api/projects/fx-plan/architecture`)).json();
  assert.equal(before.current, null, 'ordinary fixture state remains without a job');
  await fetch(`${base}/__agent-revision/fx-plan`, {method: 'POST'});
  const afterAgentRevision = await (await fetch(`${base}/api/projects/fx-plan/architecture`)).json();
  assert.deepEqual(afterAgentRevision.current.jobs, [], 'agent revisions are not marked rendered');
  const saved = await (await fetch(`${base}/__rendered-plan/fx-plan`, {method: 'POST'})).json();
  const summary = await (await fetch(`${base}/api/projects/fx-plan/architecture`)).json();
  const job = summary.current.jobs.at(-1);
  assert.equal(summary.current.revision, saved.revision);
  assert.equal(summary.current.plan.name, 'Two-bedroom workflow test (Arosa)');
  assert.deepEqual(validatePlan(saved).filter(issue => issue.severity === 'error'), [], 'rendered sample remains editable');
  assert.deepEqual(exportPlan(saved).objects, []);
  assert.deepEqual(exportPlan(saved).sources, []);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.revision, saved.revision);
  for (const artifact of job.artifacts) {
    assert.equal(artifact.revision, saved.revision);
    const response = await fetch(`${base}/api/projects/fx-plan/architecture/artifacts/${artifact.id}`);
    assert.equal(response.ok, true, artifact.kind);
    assert.ok((await response.arrayBuffer()).byteLength > 100, artifact.kind);
  }
  const ordinary = await (await fetch(`${base}/api/projects/fx-plan/architecture/plan`, {
    method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({parentRevision: saved.revision, plan: saved}),
  })).json();
  assert.deepEqual(ordinary.artifacts, []);
  const afterOrdinarySave = await (await fetch(`${base}/api/projects/fx-plan/architecture`)).json();
  assert.deepEqual(afterOrdinarySave.current.jobs, [], 'ordinary revisions are not marked rendered');
});
