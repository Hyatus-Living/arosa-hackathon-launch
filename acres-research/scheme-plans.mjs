// "Draft all three": one background job per scheme that lays out the scheme's floors on its
// lot (architecture-tools.mjs schemePlan), saves it as the next revision of that scheme's plan
// (Architecture.save, which also names the plan on the scheme) and queues its walkthrough render.
// Each job is a row in architecture_drafts, so a reload shows where drafting stands; the three are
// drawn at once and saved in scheme order, and a restart fails the ones it interrupted. Each plan
// document carries its option's storey outlines (scheme-outlines.mjs) as zoning, so the planning
// engine and the zoning sheet draw on the lot polygon; the report says whether that is the tax lot
// or a rectangle.
import {randomUUID} from 'node:crypto';
import {exportPlan} from './plan-intake.mjs';
import {schemePlan,lotOf} from './architecture-tools.mjs';
import {spawnPlanner} from './planning.mjs';
import {SCHEME_IDS} from './schemes.mjs';
import {lotOutline,schemeOutlines,isCornerSite} from './scheme-outlines.mjs';

const bad = (message, status = 400) => Object.assign(new Error(message), {status});
const ACTIVE = ['queued', 'running'];

export class SchemeDrafts {
  constructor(architecture, jobs, {loadContext = null, storedPolygonFor = null, plan = (scheme, lot, site) => schemePlan(scheme, lot, undefined, {site, run: request => spawnPlanner(request, {planningDir: architecture.planningDir})})} = {}) {
    this.architecture = architecture;
    this.jobs = jobs;
    this.store = architecture.store;
    this.loadContext = loadContext;
    this.storedPolygonFor = storedPolygonFor;
    this.plan = plan;
  }
  // The option's storey outlines, or why there are none; a missing outline never stops the draft.
  async outlines(state, scheme) {
    const property = state.property?.value, envelope = state.envelope?.value ?? null;
    try {
      const storedPolygon = this.storedPolygonFor && property?.bbl ? await this.storedPolygonFor(String(property.bbl)) : null;
      const lot = await lotOutline(property, {loadContext: this.loadContext, corner: isCornerSite(envelope, property), storedPolygon});
      if (!lot) return {site: null, outline: {source: null, note: 'The lot has no frontage, depth or area on record, so its storeys were not outlined.'}};
      const site = schemeOutlines(scheme, {property, lot, envelope});
      return {site, outline: {source: lot.source, note: lot.note, storeys: site.storeys.length, zfaBudgetSqft: site.floorArea.maxZfaSqft}};
    } catch (error) {
      return {site: null, outline: {source: null, note: `The storeys were not outlined: ${String(error.message).slice(0, 200)}`}};
    }
  }
  view = row => ({id: row.draft_id, scheme: row.scheme, status: row.status, reason: row.reason, planId: row.plan_id, revision: row.revision,
    report: row.report ? JSON.parse(row.report) : null, createdAt: row.created_at, finishedAt: row.finished_at});
  update(row, fields) {
    const keys = Object.keys(fields);
    this.store.write(`UPDATE architecture_drafts SET ${keys.map(k => `${k}=?`).join(',')} WHERE draft_id=?`, ...keys.map(k => fields[k]), row.draft_id);
    const next = this.store.one('SELECT * FROM architecture_drafts WHERE draft_id=?', row.draft_id);
    const event = this.store.appendProjectEvent(next.project, 'architecture.draft', {projectId: next.project, draftId: next.draft_id, scheme: next.scheme, status: next.status,
      ...(next.revision ? {planId: next.plan_id, revision: next.revision} : {}), ...(next.reason ? {reason: next.reason} : {})});
    this.store.projectFeed.emit(next.project, event);
    return next;
  }

  // The latest draft of each scheme.
  list(account, projectId) {
    this.store.requireProject(account, projectId, 'viewer');
    const latest = new Map(this.store.query('SELECT * FROM architecture_drafts WHERE project=? ORDER BY created_at', projectId).map(r => [r.scheme, r]));
    return {projectId, drafts: SCHEME_IDS.filter(id => latest.has(id)).map(id => this.view(latest.get(id)))};
  }

  // Queues a draft of every scheme that has a building, or returns the drafts already under way.
  start(account, projectId) {
    this.store.requireProject(account, projectId, 'participant');
    if (this.store.one(`SELECT 1 FROM architecture_drafts WHERE project=? AND status IN ('queued','running') LIMIT 1`, projectId)) return this.list(account, projectId);
    const schemes = this.store.schemesView(projectId).schemes?.filter(s => s.program);
    if (!schemes?.length) throw bad('This site has no schemes to draw yet.', 409);
    const now = Date.now();
    const rows = schemes.map((scheme, i) => {
      const id = randomUUID();
      this.store.write('INSERT INTO architecture_drafts(draft_id,project,scheme,status,created_by,created_at) VALUES(?,?,?,?,?,?)', id, projectId, scheme.id, 'queued', account, now + i);
      return this.store.one('SELECT * FROM architecture_drafts WHERE draft_id=?', id);
    });
    this.running = this.run(account, projectId, rows);
    return this.list(account, projectId);
  }

  // The planner draws every scheme at once; the plans are saved in scheme order, each once those before it are
  // saved or failed, so revisions and render jobs keep that order and one failure leaves the others saved.
  async run(account, projectId, rows) {
    rows = rows.map(row => this.update(row, {status: 'running'}));
    const drawings = rows.map(row => this.draw(projectId, row));
    for (const drawing of drawings) drawing.catch(() => {}); // each failure is recorded on its own row below
    for (const [i, row] of rows.entries()) {
      try {
        await this.save(account, projectId, row, await drawings[i]);
      } catch (error) {
        this.update(row, {status: 'failed', reason: String(error.message).slice(0, 300), finished_at: Date.now()});
      }
    }
  }

  async draw(projectId, row) {
    // The scheme as it stands now: a refresh while queued may have changed its building.
    const scheme = this.store.schemesView(projectId).schemes?.find(s => s.id === row.scheme);
    if (!scheme?.program) throw new Error('This scheme no longer has a building to draw.');
    const state = this.store.project.read(projectId);
    const {site, outline} = await this.outlines(state, scheme);
    const {doc, report} = await this.plan(scheme, lotOf(state.property?.value), site);
    return {scheme, site, outline, doc, report};
  }

  async save(account, projectId, row, {scheme, site, outline, doc, report}) {
    const parentRevision = this.architecture.head(projectId, scheme.id)?.revision ?? null;
    // The layout's checks travel with the plan, for the self-check in the architect's package.
    const checked = {checks: report.checks, architect: report.why.architect};
    const saved = await this.architecture.save(account, projectId, {parentRevision, plan: {...exportPlan(doc), ...(site ? {zoning: site} : {}), layout: checked, parentRevision}, scheme: scheme.id, by: 'agent'}, this.jobs.view);
    try { await this.jobs.create(account, projectId, {planId: saved.planId, revision: saved.revision}); }
    catch (error) { console.error(JSON.stringify({event: 'scheme_render_not_queued', projectId, scheme: scheme.id, message: String(error.message).slice(0, 300)})); }
    const {plate, netToGross, unitsPerFloor, storeys, buildingUnits, typicalFloorUnits, levels, drawn, layout, mix, fit, score, why, checks, programs} = report;
    // The option card shows why this plan was chosen and what it draws beside its drawing, until the plan is edited.
    const part = this.store.schemesView(projectId).schemes?.find(s => s.id === scheme.id)?.plan;
    if (part?.planId === saved.planId && part.revision === saved.revision) this.store.setSchemePart(projectId, scheme.id, 'plan', {...part, why: why.summary, drawn});
    this.update(row, {status: 'succeeded', plan_id: saved.planId, revision: saved.revision, finished_at: Date.now(),
      report: JSON.stringify({plate, netToGross, unitsPerFloor, storeys, buildingUnits, typicalFloorUnits, levels, drawn, layout, mix, fit, outline, score, why, checks, programs})});
  }

  // On service start: drafts queued or running lost their runner.
  recover() {
    for (const row of this.store.query(`SELECT * FROM architecture_drafts WHERE status IN (${ACTIVE.map(s => `'${s}'`).join(',')})`)) {
      this.update(row, {status: 'failed', reason: 'The research service restarted before this plan was drawn. Draft again.', finished_at: Date.now()});
    }
  }
}
