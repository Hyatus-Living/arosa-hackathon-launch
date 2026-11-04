// Fixtures shaped like GET /api/projects/:id/architecture, one per job state, around the sample
// apartment plan. Used by the Core page tests and the architecture section fixture page.
import {readFileSync} from 'node:fs';
import {fullState} from './project-state.mjs';

const T0 = Date.UTC(2026, 9, 16, 15, 0);
const plan = {
  schema: 'acres.architecture.plan/1', id: 'plan_fulton', revision: 3, parentRevision: 2,
  ...JSON.parse(readFileSync(new URL('./architecture/sample-plan.json', import.meta.url), 'utf8')),
};
delete plan.version;

const artifact = (kind, id, jobId = null, contentType = 'application/octet-stream') =>
  ({id, kind, revision: 3, jobId, sha256: kind.padEnd(64, '0').slice(0, 64), bytes: 1024, contentType, createdAt: T0});
const revisionArtifacts = [
  artifact('plan', 'a-plan', null, 'application/json'),
  artifact('svg', 'a-svg', null, 'image/svg+xml'),
  artifact('ifc', 'a-ifc', null, 'application/x-step'),
  artifact('pascal-scene', 'a-pascal', null, 'application/json'),
  artifact('idmap', 'a-idmap', null, 'application/json'),
];
const jobArtifacts = (jobId) => [
  artifact('verification', `${jobId}-verification`, jobId, 'application/json'),
  artifact('blend', `${jobId}-blend`, jobId),
  artifact('preview', `${jobId}-preview`, jobId, 'image/png'),
  artifact('glb', `${jobId}-glb`, jobId, 'model/gltf-binary'),
  artifact('manifest', `${jobId}-manifest`, jobId, 'application/json'),
];

export const job = (id, status, extra = {}) => ({
  id, projectId: fullState.id, revision: 3, status, reason: null, inputHash: 'ifc'.padEnd(64, '0'), pipelineVersion: '1', settingsHash: 's'.padEnd(64, '0'),
  createdBy: 'a'.repeat(24), createdAt: T0 + 60000, startedAt: null, finishedAt: null, artifacts: [], ...extra,
});

const summary = (jobs) => ({
  projectId: fullState.id, planId: plan.id, stale: null,
  current: {
    planId: plan.id, revision: 3, parentRevision: 2, createdBy: 'a'.repeat(24), createdAt: T0, inputHash: 'p'.padEnd(64, '0'), current: true, plan,
    artifacts: [...revisionArtifacts, ...jobs.flatMap((j) => j.artifacts)], jobs,
  },
  revisions: [3, 2, 1].map((revision) => ({revision, parentRevision: revision > 1 ? revision - 1 : null, createdBy: 'a'.repeat(24), createdAt: T0 - (3 - revision) * 86400000, inputHash: 'p'.padEnd(64, '0')})),
});

const failedEarlier = job('job_old', 'failed', {createdAt: T0 + 1000, startedAt: T0 + 2000, finishedAt: T0 + 30000, reason: 'Blender exited before writing the model.'});

export const architectureStates = {
  empty: {projectId: fullState.id, planId: null, stale: null, current: null, revisions: []},
  planOnly: summary([]),
  queued: summary([job('job_q', 'queued')]),
  running: summary([job('job_r', 'running', {startedAt: T0 + 65000})]),
  failed: summary([job('job_f', 'failed', {startedAt: T0 + 65000, finishedAt: T0 + 125000, reason: 'The IFC has no storeys to export.'})]),
  succeeded: summary([failedEarlier, job('job_s', 'succeeded', {startedAt: T0 + 65000, finishedAt: T0 + 140000, artifacts: jobArtifacts('job_s')})]),
  noModel: summary([job('job_n', 'succeeded', {startedAt: T0 + 65000, finishedAt: T0 + 140000, artifacts: jobArtifacts('job_n').filter((a) => a.kind !== 'glb')})]),
};

// The project state once a plan revision is saved: the architecture node is the user's input.
export const stateWithArchitecture = {
  ...fullState,
  fields: {
    ...fullState.fields,
    architecture: {
      value: {planId: plan.id, revision: 3, parentRevision: 2, name: plan.name, inputHash: 'p'.padEnd(64, '0'), artifacts: {}},
      provenance: {tool: 'user', account: 'a'.repeat(24), at: T0, revision: 3}, stale: null, updated: T0,
    },
  },
};
