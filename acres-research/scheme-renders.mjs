// Presentation renders of a site's schemes: builds a scheme's render scene from the project state,
// queues the render job and keeps the scheme's render part (setSchemePart) in step with the job.
// See docs/architecture-jobs.md.
import {renderScene,hasConceptMassing} from './render-scene.mjs';

const FOOT = 0.3048;
const VIEWS = ['street', 'aerial'];

// The scheme's render part for a render job row: the street still is the part's artifactId and url.
export function renderPart(row) {
  const artifacts = JSON.parse(row.artifacts);
  const views = VIEWS.flatMap(view => {
    const artifact = artifacts.find(a => a.kind === `render-${view}`);
    return artifact ? [{view, artifactId: artifact.id, url: `/api/projects/${row.project}/architecture/artifacts/${artifact.id}`}] : [];
  });
  return {
    artifactId: views[0]?.artifactId ?? null, status: row.status, url: views[0]?.url ?? null, jobId: row.job_id,
    reason: row.reason ?? null, views,
    renderSeconds: row.status === 'succeeded' && row.started_at ? Math.round((row.finished_at - row.started_at) / 100) / 10 : null,
    at: row.finished_at ?? row.created_at,
  };
}

// Called on every render job change: the part follows the job it names, so a render requested for an
// earlier building of the scheme never overwrites the current one.
export function syncRenderPart(store, row) {
  const scheme = store.project.read(row.project).schemes?.value.schemes.find(s => s.id === row.scheme);
  if (!scheme || (scheme.render && scheme.render.jobId !== row.job_id)) return;
  store.setSchemePart(row.project, row.scheme, 'render', renderPart(row));
}

// Queues the render of one scheme and returns its render part. loadContext({property, lot}) is a
// context.mjs loader's load, used when the massing has no neighbours of its own (an envelope massing).
export async function requestSchemeRender({store, jobs, loadContext}, account, projectId, schemeId) {
  store.requireProject(account, projectId, 'participant');
  const state = store.project.read(projectId);
  const scheme = state.schemes?.value.schemes.find(s => s.id === schemeId);
  if (!scheme) throw Object.assign(new Error('This option was not found.'), {status: 404});
  if (!scheme.program) throw Object.assign(new Error('This option has no building to render.'), {status: 409});
  const concept = scheme.massing ? (state.concepts?.value || []).find(c => (c.id ?? c.name) === scheme.massing.conceptId) ?? null : null;
  const envelope = state.envelope?.value ?? null;
  // A concept's neighbours are placed in its own lot frame; an envelope massing loads them for the envelope's lot.
  const conceptMassing = hasConceptMassing(concept);
  let context = conceptMassing ? concept.context ?? null : null;
  if (!conceptMassing && envelope?.lot?.polygon && state.property?.value) {
    const lot = envelope.lot.polygon.map(([x, z]) => [x * FOOT, z * FOOT]);
    context = (await loadContext({property: state.property.value, lot}))?.context ?? null;
  }
  const scene = renderScene({scheme, concept, envelope, context});
  const job = await jobs.create(account, projectId, {kind: 'render', scheme: schemeId, scene});
  const part = renderPart(jobs.row(job.id));
  store.setSchemePart(projectId, schemeId, 'render', part);
  return part;
}
