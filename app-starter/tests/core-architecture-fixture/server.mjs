// Fixture for the Core page's Architecture section: serves the built app with an in-memory
// architecture API. Open /core/fx-<state> for state in empty, planOnly, queued, running, failed,
// succeeded or noModel, fx-fresh for a just-resolved parcel or fx-blank for a site with no parcel yet;
// add ?viewer to read as a viewer, ?run=<status>&tool=<tool name> to show a live run. Running a job moves it to running after
// 2 s and to succeeded after 5 s (fx-failrun fails instead), streamed as architecture.job events.
// Run `npm run build` in app-starter first, then `node tests/core-architecture-fixture/server.mjs`.
import express from 'express';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {architectureStates, stateWithArchitecture, job} from '../fixtures/architecture-states.mjs';
import {fullState, subjectOnlyState} from '../fixtures/project-state.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`../fixtures/architecture/${name}`, import.meta.url));
const app = express();
const projects = new Map();
const clients = new Map();
let seq = 0;

function project(id) {
  if (!projects.has(id)) {
    const name = id.replace(/^fx-/, '');
    const summary = structuredClone(architectureStates[name] || architectureStates.planOnly);
    summary.projectId = id;
    const fields = name === 'fresh' ? subjectOnlyState.fields : name === 'blank' ? {} : summary.current ? stateWithArchitecture.fields : fullState.fields;
    const title = name === 'blank' ? 'Underwrite 793 BROADWAY, New York, NY 10003, MN (BBL 1005620028) in C6-1' : `${fullState.title} (${name})`;
    projects.set(id, {summary, state: {...stateWithArchitecture, id, title, fields}, failRun: name === 'failrun'});
  }
  return projects.get(id);
}
function emit(id, event, data) {
  const record = {seq: ++seq, event, time: Date.now(), projectId: id, ...data};
  for (const res of clients.get(id) || []) res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
}
const outputs = (jobId) => ['verification', 'preview', 'glb', 'manifest'].map((kind) => ({id: `${jobId}-${kind}`, kind, revision: 0, jobId, sha256: '0'.repeat(64), bytes: 1, contentType: 'application/octet-stream', createdAt: Date.now()}));

app.use(express.json({limit: '3mb'}));
app.get(['/core/:id', '/core/:id/plan', '/sites/:id', '/sites/:id/plan'], (_req, res) => res.sendFile('index.html', {root: here}));
app.use(express.static(fileURLToPath(new URL('../../public', import.meta.url))));
app.get('/api/session', (_req, res) => res.json({namespace: 'fixture', architectureEnabled: true}));
app.get('/api/projects/:id/state', (req, res) => res.json(project(req.params.id).state));
app.get('/api/projects/:id/architecture', (req, res) => res.json(project(req.params.id).summary));
app.get('/api/projects/:id/events', (req, res) => {
  res.writeHead(200, {'content-type': 'text/event-stream', connection: 'keep-alive'});
  res.write(': connected\n\n');
  const list = clients.get(req.params.id) || new Set();
  list.add(res);
  clients.set(req.params.id, list);
  req.on('close', () => list.delete(res));
});
app.post('/api/projects/:id/architecture/jobs', (req, res) => {
  const p = project(req.params.id);
  if (req.body.revision !== p.summary.current?.revision) return res.status(409).json({error: 'That revision is no longer current.'});
  const j = job(`job_${Date.now()}`, 'queued', {projectId: req.params.id, revision: req.body.revision, createdAt: Date.now()});
  p.summary.current.jobs.push(j);
  emit(req.params.id, 'architecture.job', {jobId: j.id, revision: j.revision, status: 'queued'});
  setTimeout(() => {
    Object.assign(j, {status: 'running', startedAt: Date.now()});
    emit(req.params.id, 'architecture.job', {jobId: j.id, revision: j.revision, status: 'running'});
  }, 2000);
  setTimeout(() => {
    if (p.failRun) Object.assign(j, {status: 'failed', finishedAt: Date.now(), reason: 'Blender ran past the 300 second deadline.'});
    else Object.assign(j, {status: 'succeeded', finishedAt: Date.now(), artifacts: outputs(j.id)});
    emit(req.params.id, 'architecture.job', {jobId: j.id, revision: j.revision, status: j.status, ...(j.reason ? {reason: j.reason} : {})});
  }, 5000);
  res.status(202).json(j);
});
app.put('/api/projects/:id/architecture/plan', (req, res) => {
  const p = project(req.params.id);
  const parent = p.summary.current?.revision ?? null;
  if ((req.body.parentRevision ?? null) !== parent) return res.status(409).json({error: `Revision ${parent} was saved after you started editing.`, revision: parent});
  const revision = (parent ?? 0) + 1;
  const plan = {...req.body.plan, id: 'plan_fixture', revision, parentRevision: parent};
  const pascal = {id: `rev${revision}-pascal`, kind: 'pascal-scene', revision, jobId: null, sha256: '0'.repeat(64), bytes: 1, contentType: 'application/json', createdAt: Date.now()};
  p.summary.current = {planId: plan.id, revision, parentRevision: parent, createdBy: 'fixture', createdAt: Date.now(), inputHash: '0'.repeat(64), current: true, plan, artifacts: [pascal], jobs: []};
  p.summary.revisions.unshift({revision, parentRevision: parent, createdBy: 'fixture', createdAt: Date.now(), inputHash: '0'.repeat(64)});
  p.state = {...p.state, version: p.state.version + 1, fields: stateWithArchitecture.fields};
  emit(req.params.id, 'state.updated', {version: p.state.version, keys: ['architecture']});
  res.status(201).json({revision, parentRevision: parent, planId: plan.id, plan, artifacts: [pascal]});
});
app.get('/api/projects/:id/architecture/artifacts/:artifactId', (req, res) => {
  const kind = req.params.artifactId.split('-').pop();
  if (kind === 'glb') return res.type('model/gltf-binary').send(readFileSync(fixture('sample.glb')));
  if (kind === 'manifest') return res.type('application/json').send(readFileSync(fixture('sample-manifest.json')));
  if (kind === 'pascal') return res.json({schema: 'pascal-scene fixture', nodes: []});
  res.status(404).json({error: 'Artifact not found.'});
});
app.use('/api', (_req, res) => res.status(404).json({error: 'Not found.'}));
const port = Number(process.env.PORT || 4793);
app.listen(port, '127.0.0.1', () => console.log(`Architecture section fixture: http://127.0.0.1:${port}/core/fx-succeeded`));
