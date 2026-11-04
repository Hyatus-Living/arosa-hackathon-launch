// Static fixture for verifying the plan editor in a browser: serves the built bundle and an
// in-memory stand-in for the architecture plan endpoints, including 409 conflicts.
// Run `npm run build` first, then `node tests/plan-editor-fixture/server.mjs`.
import express from 'express';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const app = express();
const plans = new Map();
app.use(express.json({limit: '3mb'}));
app.get('/', (_req, res) => res.sendFile('index.html', {root: here}));
app.use('/fixtures', express.static(fileURLToPath(new URL('../fixtures', import.meta.url))));
app.use(express.static(fileURLToPath(new URL('../../public', import.meta.url))));
app.get('/api/session', (_req, res) => res.json({namespace: 'fixture', architectureEnabled: true}));
app.get('/api/projects/:id/architecture', (req, res) => {
  const p = plans.get(req.params.id);
  res.json({current: p ? {revision: p.revision, plan: p.plan} : null, revisions: p ? p.history : []});
});
app.put('/api/projects/:id/architecture/plan', (req, res) => {
  const p = plans.get(req.params.id) || {revision: null, planId: randomUUID(), history: []};
  if ((req.body.parentRevision ?? null) !== p.revision) return res.status(409).json({error: `Revision ${p.revision} was saved after you started editing.`, revision: p.revision});
  const revision = (p.revision ?? 0) + 1;
  const plan = {...req.body.plan, id: p.planId, revision, parentRevision: p.revision};
  plans.set(req.params.id, {revision, planId: p.planId, plan, history: [{revision, parentRevision: p.revision}, ...p.history]});
  res.status(201).json({revision, parentRevision: p.revision, planId: p.planId, plan, artifacts: []});
});
// Simulates another person saving a revision.
app.post('/__bump/:id', (req, res) => {
  const p = plans.get(req.params.id);
  const revision = p.revision + 1;
  plans.set(req.params.id, {...p, revision, plan: {...p.plan, revision, parentRevision: p.revision, name: `${p.plan.name} (edited elsewhere)`}});
  res.json({revision});
});
app.listen(Number(process.env.PORT || 4791), '127.0.0.1');
