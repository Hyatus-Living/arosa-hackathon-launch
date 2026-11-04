// Architecture plan revisions and the files derived from them. A project has up to one plan per
// scheme (as of right, most floor area, alternative; schemes.mjs); every save to a plan is a new
// numbered revision guarded by its parent revision, so revision numbers repeat across a project's
// plans and jobs and artifacts are keyed by plan_id. Each revision is stored as plan.json beside the files
// the geometry lane generates from it (plan.svg, model.ifc, pascal-scene.json, idmap.json). Every
// artifact row is bound to one revision, so a later revision never presents an older IFC as
// current. Files live under <state>/architecture and are only served through authorized routes.
// See docs/architecture-jobs.md.
import {createHash,randomUUID} from 'node:crypto';
import {throwIfCancelled} from './execution-context.mjs';
import {verifyFile,assertVerifiedFile} from './artifact-io.mjs';
import {createReadStream,lstatSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SCHEME_IDS} from './schemes.mjs';

export const PLAN_SCHEMA = 'acres.architecture.plan/1';
export const PLAN_MAX_BYTES = 2 * 1024 * 1024;
export const IFC_MAX_BYTES = 50 * 1024 * 1024;
export const OUTPUT_MAX_BYTES = 512 * 1024 * 1024;

// The schemes a plan can belong to, in the order the site shows them; a plan saved without one is
// the as-of-right plan, which is also where every plan from before schemes was migrated.
export const PLAN_SCHEMES = SCHEME_IDS;
export const DEFAULT_SCHEME = 'as_of_right';

const PLANS_TABLE = name => `CREATE TABLE IF NOT EXISTS ${name}(project TEXT NOT NULL REFERENCES projects(id),plan_id TEXT NOT NULL,revision INTEGER NOT NULL,parent_revision INTEGER,document_path TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,input_hash TEXT NOT NULL,scheme TEXT NOT NULL,PRIMARY KEY(plan_id,revision),UNIQUE(project,scheme,revision))`;
export const ARCHITECTURE_DDL = `
${PLANS_TABLE('architecture_plans')};
CREATE TABLE IF NOT EXISTS architecture_jobs(job_id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),reason TEXT,input_hash TEXT NOT NULL,pipeline_version TEXT NOT NULL,settings_hash TEXT NOT NULL,settings TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,job_dir TEXT NOT NULL,pid INTEGER,artifacts TEXT NOT NULL DEFAULT '[]',plan_id TEXT);
CREATE INDEX IF NOT EXISTS architecture_jobs_project ON architecture_jobs(project,created_at DESC);
CREATE INDEX IF NOT EXISTS architecture_jobs_status ON architecture_jobs(status,created_at);
CREATE TABLE IF NOT EXISTS architecture_artifacts(artifact_id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,job_id TEXT,kind TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,content_type TEXT NOT NULL,created_at INTEGER NOT NULL,plan_id TEXT);
CREATE INDEX IF NOT EXISTS architecture_artifacts_revision ON architecture_artifacts(project,revision);
CREATE TABLE IF NOT EXISTS architecture_drafts(draft_id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),scheme TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),reason TEXT,plan_id TEXT,revision INTEGER,report TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER);
CREATE INDEX IF NOT EXISTS architecture_drafts_project ON architecture_drafts(project,created_at DESC);`;

// Brings a database from one plan per project to one plan per scheme, once: the plans table is
// rebuilt with a scheme column (every existing plan becomes the as-of-right plan, keeping its
// plan_id, revisions, parents and authors), and jobs and artifacts gain plan_id, filled from the
// project's only plan. Runs after ARCHITECTURE_DDL in one savepoint.
export function migrateArchitecture(db) {
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  db.exec('SAVEPOINT architecture_schemes');
  try {
    if (!columns('architecture_plans').includes('scheme')) {
      db.exec(`${PLANS_TABLE('architecture_plans_schemes')};
        INSERT INTO architecture_plans_schemes(project,plan_id,revision,parent_revision,document_path,created_by,created_at,input_hash,scheme)
          SELECT project,plan_id,revision,parent_revision,document_path,created_by,created_at,input_hash,'${DEFAULT_SCHEME}' FROM architecture_plans;
        DROP TABLE architecture_plans;
        ALTER TABLE architecture_plans_schemes RENAME TO architecture_plans;`);
    }
    for (const table of ['architecture_jobs', 'architecture_artifacts']) {
      if (columns(table).includes('plan_id')) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN plan_id TEXT;
        UPDATE ${table} SET plan_id=(SELECT p.plan_id FROM architecture_plans p WHERE p.project=${table}.project AND p.revision=${table}.revision);`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS architecture_plans_scheme ON architecture_plans(project,scheme,revision DESC);
      CREATE INDEX IF NOT EXISTS architecture_jobs_plan ON architecture_jobs(plan_id,revision);
      CREATE INDEX IF NOT EXISTS architecture_artifacts_plan ON architecture_artifacts(plan_id,revision);
      RELEASE architecture_schemes;`);
  } catch (error) {
    db.exec('ROLLBACK TO architecture_schemes; RELEASE architecture_schemes');
    throw error;
  }
}

// File name, artifact kind and content type of every file a revision or job may register.
// A plan that carries its option's storey outlines (plan.zoning) also gets the zoning sheet and its figures.
// Every revision gets the architect's package: the drawing set, the DXF, the schedules, the self-check and
// their zip with the IFC model and the zoning sheet (planning/exporters/drawings.py, dxf.py, package.py).
export const REVISION_FILES = [['plan.json', 'plan', 'application/json'], ['plan.svg', 'svg', 'image/svg+xml'], ['model.ifc', 'ifc', 'application/x-step'], ['pascal-scene.json', 'pascal-scene', 'application/json'], ['idmap.json', 'idmap', 'application/json'],
  ['zd1.svg', 'zd1-svg', 'image/svg+xml'], ['zd1.pdf', 'zd1-pdf', 'application/pdf'], ['zoning.json', 'zoning', 'application/json'],
  ['drawings.pdf', 'drawings-pdf', 'application/pdf'], ['drawings.dxf', 'dxf', 'image/vnd.dxf'], ['schedules.xlsx', 'schedules', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['selfcheck.json', 'selfcheck', 'application/json'], ['package.zip', 'package', 'application/zip']];
// The files an option link sends to an architect, by artifact kind (schemes.mjs optionSnapshot).
export const PACKAGE_KINDS = ['package', 'drawings-pdf', 'zd1-pdf', 'ifc', 'dxf', 'schedules'];
export const JOB_FILES = [['verification.json', 'verification', 'application/json'], ['model.blend', 'blend', 'application/x-blender'], ['preview.png', 'preview', 'image/png'], ['model.glb', 'glb', 'model/gltf-binary'], ['manifest.json', 'manifest', 'application/json']];

const bad = (message, status = 400) => Object.assign(new Error(message), {status});
export function checkScheme(scheme) {
  if (!PLAN_SCHEMES.includes(scheme)) throw bad(`scheme must be one of ${PLAN_SCHEMES.join(', ')}.`);
  return scheme;
}
const plain = value => value != null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_key, v) => plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const hashJson = value => createHash('sha256').update(canonical(value)).digest('hex');
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const collections = {levels: 200, walls: 20000, openings: 20000, rooms: 5000, objects: 20000, sources: 500};
const identified = ['levels', 'walls', 'openings', 'rooms'];

// The checks that need no geometry: the v1 envelope, unique element IDs and the references
// between levels, walls, openings and rooms. Geometry validation belongs to the geometry lane.
export function validatePlan(doc) {
  if (!plain(doc)) throw bad('The plan must be an object.');
  if (doc.schema !== PLAN_SCHEMA) throw bad(`The plan schema must be ${PLAN_SCHEMA}.`);
  if (doc.units !== 'm') throw bad('The plan units must be m (metres).');
  if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 200) throw bad('The plan name must be 1 to 200 characters.');
  const ids = {};
  for (const [key, max] of Object.entries(collections)) {
    const list = doc[key];
    if (!Array.isArray(list) || list.length > max) throw bad(`The plan ${key} must be a list of at most ${max} entries.`);
    ids[key] = new Set();
    list.forEach((item, i) => {
      if (!plain(item)) throw bad(`${key}[${i}] must be an object.`);
      if (!identified.includes(key)) return;
      if (typeof item.id !== 'string' || !idPattern.test(item.id)) throw bad(`${key}[${i}].id must be 1 to 100 letters, digits or . _ : -`);
      if (ids[key].has(item.id)) throw bad(`${key}[${i}].id duplicates ${item.id}.`);
      ids[key].add(item.id);
    });
  }
  if (!doc.levels.length) throw bad('The plan needs at least one level.');
  for (const key of ['walls', 'rooms', 'objects']) doc[key].forEach((item, i) => {
    if (item.levelId !== undefined && !ids.levels.has(item.levelId)) throw bad(`${key}[${i}].levelId does not name a level in this plan.`);
  });
  doc.walls.forEach((wall, i) => {
    if (wall.roomIds !== undefined && (!Array.isArray(wall.roomIds) || wall.roomIds.some(id => !ids.rooms.has(id)))) throw bad(`walls[${i}].roomIds must name rooms in this plan.`);
  });
  doc.openings.forEach((opening, i) => {
    if (!ids.walls.has(opening.wallId)) throw bad(`openings[${i}].wallId does not name a wall in this plan.`);
  });
  return doc;
}

export async function sha256File(path,{maxBytes=OUTPUT_MAX_BYTES,...options}={}) {return (await verifyFile(path,maxBytes,options)).sha256;}

// A file a revision or job produced, if it is a regular file within the size limit. Symlinks and
// other file types are refused so a worker cannot point a download outside its directory.
export function regularFile(path, name, max) {
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (!stat) return null;
  if (!stat.isFile()) throw bad(`${name} is not a regular file.`, 502);
  if (stat.size > max) throw bad(`${name} exceeds ${Math.round(max / 1024 / 1024)} MB.`, 413);
  return stat.size;
}

const artifactView = r => ({id: r.artifact_id, kind: r.kind, planId: r.plan_id, revision: r.revision, jobId: r.job_id, sha256: r.sha256, bytes: r.bytes, contentType: r.content_type, createdAt: r.created_at});

export class Architecture {
  // store: the ChatStore (access checks, project state and the project event stream).
  // buildPlan(document, {outDir, planningDir}) is planning.mjs buildArchitectureRevision.
  constructor(store, {stateDir, buildPlan, planningDir}) {
    this.store = store;
    this.db = store.db;
    this.root = join(stateDir, 'architecture');
    this.buildPlan = buildPlan;
    this.planningDir = planningDir;
  }
  // The latest revision of a scheme's plan.
  head(projectId, scheme = DEFAULT_SCHEME) { return this.store.one('SELECT * FROM architecture_plans WHERE project=? AND scheme=? ORDER BY revision DESC LIMIT 1', projectId, scheme) ?? null; }
  revisionRow(projectId, planId, revision) { return this.store.one('SELECT * FROM architecture_plans WHERE project=? AND plan_id=? AND revision=?', projectId, planId, revision) ?? null; }
  artifacts(projectId, planId, revision) { return this.store.query('SELECT * FROM architecture_artifacts WHERE project=? AND plan_id=? AND revision=? ORDER BY created_at,kind', projectId, planId, revision).map(artifactView); }
  artifactRow(projectId, artifactId) { return this.store.one('SELECT * FROM architecture_artifacts WHERE project=? AND artifact_id=?', projectId, artifactId) ?? null; }
  jobsFor(projectId, planId, revision) { return this.store.query('SELECT * FROM architecture_jobs WHERE project=? AND plan_id=? AND revision=? ORDER BY created_at', projectId, planId, revision); }
  // The plan of each scheme the project state points at: what reopening the project shows. A state
  // saved before schemes holds the as-of-right plan alone.
  currentPlans(projectId) {
    const value = this.store.project.read(projectId).architecture?.value;
    return value?.plans ?? (value?.planId ? {[DEFAULT_SCHEME]: {planId: value.planId, revision: value.revision, name: value.name}} : {});
  }
  currentRevision(projectId, scheme = DEFAULT_SCHEME) { return this.currentPlans(projectId)[scheme]?.revision ?? null; }

  async prepare(dir, files, {signal} = {}) {
    const prepared=[];
    for(const [name,kind,contentType] of files){
      const path=join(dir,name),max=name==='model.ifc'?IFC_MAX_BYTES:kind==='verification'?1024*1024:OUTPUT_MAX_BYTES;
      if(regularFile(path,name,max)==null)continue;
      prepared.push({name,kind,contentType,...await verifyFile(path,max,{signal,text:kind==='verification'})});
    }
    return prepared;
  }
  register(projectId, planId, revision, jobId, dir, prepared, at = Date.now()) {
    const rows = [];
    for (const file of prepared) {
      const {name,kind,contentType,bytes,sha256}=file;
      const path = join(dir, name);
      assertVerifiedFile(path,file);
      rows.push({artifact_id: randomUUID(), project: projectId, plan_id: planId, revision, job_id: jobId, kind, path, sha256, bytes, content_type: contentType, created_at: at});
    }
    for (const r of rows) this.store.write('INSERT INTO architecture_artifacts(artifact_id,project,plan_id,revision,job_id,kind,path,sha256,bytes,content_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', r.artifact_id, r.project, r.plan_id, r.revision, r.job_id, r.kind, r.path, r.sha256, r.bytes, r.content_type, r.created_at);
    return rows.map(artifactView);
  }

  revisionView(projectId, row, jobView) {
    const current = this.currentRevision(projectId, row.scheme);
    return {planId: row.plan_id, scheme: row.scheme, revision: row.revision, parentRevision: row.parent_revision, createdBy: row.created_by, createdAt: row.created_at, inputHash: row.input_hash,
      current: row.revision === current, plan: JSON.parse(readFileSync(row.document_path, 'utf8')), artifacts: this.artifacts(projectId, row.plan_id, row.revision),
      jobs: this.jobsFor(projectId, row.plan_id, row.revision).map(jobView)};
  }

  // One scheme's plan (the as-of-right plan by default) with its revision list, and the head of
  // every scheme's plan so a switcher can say which schemes are drawn.
  summary(account, projectId, jobView, scheme = DEFAULT_SCHEME) {
    this.store.requireProject(account, projectId, 'viewer');
    checkScheme(scheme);
    const planId = this.head(projectId, scheme)?.plan_id ?? null, current = this.currentRevision(projectId, scheme);
    const row = planId && current != null ? this.revisionRow(projectId, planId, current) : null;
    const field = this.store.project.read(projectId).architecture;
    const heads = Object.fromEntries(PLAN_SCHEMES.map(id => [id, this.head(projectId, id)]));
    return {projectId, scheme, planId, stale: field?.stale ?? null,
      current: row ? this.revisionView(projectId, row, jobView) : null,
      revisions: this.store.query('SELECT revision,parent_revision,created_by,created_at,input_hash FROM architecture_plans WHERE project=? AND scheme=? ORDER BY revision DESC', projectId, scheme)
        .map(r => ({revision: r.revision, parentRevision: r.parent_revision, createdBy: r.created_by, createdAt: r.created_at, inputHash: r.input_hash})),
      schemes: PLAN_SCHEMES.map(id => ({scheme: id, planId: heads[id]?.plan_id ?? null, revision: heads[id]?.revision ?? null, createdAt: heads[id]?.created_at ?? null}))};
  }

  revision(account, projectId, revision, jobView, scheme = DEFAULT_SCHEME) {
    this.store.requireProject(account, projectId, 'viewer');
    checkScheme(scheme);
    const planId = this.head(projectId, scheme)?.plan_id;
    const row = planId ? this.revisionRow(projectId, planId, revision) : null;
    if (!row) throw bad('Revision not found.', 404);
    return this.revisionView(projectId, row, jobView);
  }

  // Saves the next revision: validate, check the parent, build the derived files into a staging
  // directory, then commit the row, its artifacts and the project-state node in one transaction.
  // by is "user" for the editor and "agent" for the research agent's plan tools; scheme picks which
  // of the project's plans the revision belongs to.
  async save(account, projectId, {parentRevision, plan, by = 'user', scheme = DEFAULT_SCHEME} = {}, jobView) {
    this.store.requireProject(account, projectId, 'participant');
    checkScheme(scheme);
    if (parentRevision !== null && !Number.isSafeInteger(parentRevision)) throw bad('parentRevision must be the revision you edited, or null for the first plan.');
    const document = validatePlan(plan);
    const conflict = head => Object.assign(bad('The plan changed since you opened it. Reload and apply your edit again.', 409), {revision: head?.revision ?? null});
    let head = this.head(projectId, scheme);
    if (parentRevision !== (head?.revision ?? null)) throw conflict(head);
    // An edit keeps the storey outlines its parent was drawn in, so every revision has its zoning sheet,
    // and the layout checks its parent was drafted with, marked edited for the self-check.
    if ((!document.zoning || !document.layout) && head) {
      const parent = JSON.parse(readFileSync(head.document_path, 'utf8'));
      if (!document.zoning && parent.zoning) document.zoning = parent.zoning;
      if (!document.layout && parent.layout) document.layout = {...parent.layout, edited: true};
    }
    const planId = head?.plan_id ?? randomUUID(), revision = (head?.revision ?? 0) + 1;
    const stored = {...document, id: planId, revision, parentRevision: head?.revision ?? null};
    const planDir = join(this.root, 'plans', planId), staging = join(planDir, `.staging-${randomUUID()}`), finalDir = join(planDir, String(revision));
    mkdirSync(staging, {recursive: true, mode: 0o700});
    let prepared;
    try {
      writeFileSync(join(staging, 'plan.json'), JSON.stringify(stored));
      let built;
      try { built = await this.buildPlan(stored, {outDir: staging, planningDir: this.planningDir}); }
      catch (error) {
        if (error.status !== 400) {
          console.error(JSON.stringify({event: 'architecture_build_failed', projectId, message: String(error.message).slice(0, 300)}));
          throw bad('The plan could not be built. Try again shortly.', 502);
        }
        const validationErrors = (Array.isArray(error.validationErrors) ? error.validationErrors : []).slice(0, 50)
          .map(v => ({code: String(v?.code ?? ''), id: v?.id == null ? null : String(v.id), message: String(v?.message ?? '').slice(0, 300)}));
        throw Object.assign(bad(String(error.message).slice(0, 300)), {validationErrors});
      }
      this.store.requireProject(account, projectId, 'participant');
      throwIfCancelled();
      if (!built?.hasIfc) throw bad('The plan build produced no IFC.', 502);
      regularFile(join(staging, 'model.ifc'), 'The generated IFC', IFC_MAX_BYTES);
      prepared=await this.prepare(staging,REVISION_FILES);
      if (built.ifcSha256 && built.ifcSha256 !== prepared.find(file=>file.kind==='ifc')?.sha256) throw bad('The generated IFC did not match its reported hash.', 502);
      this.store.requireProject(account, projectId, 'participant');
      throwIfCancelled();
      head = this.head(projectId, scheme);
      if (parentRevision !== (head?.revision ?? null)) throw conflict(head);
      rmSync(finalDir, {recursive: true, force: true});
      renameSync(staging, finalDir);
    } catch (error) {
      rmSync(staging, {recursive: true, force: true});
      throw error;
    }
    const at = Date.now();
    let stateEvent = null, revisionEvent;
    this.db.exec('SAVEPOINT architecture_save');
    try {
      this.store.write('INSERT INTO architecture_plans(project,plan_id,revision,parent_revision,document_path,created_by,created_at,input_hash,scheme) VALUES(?,?,?,?,?,?,?,?,?)', projectId, planId, revision, stored.parentRevision, join(finalDir, 'plan.json'), account, at, hashJson(document), scheme);
      const artifacts = this.register(projectId, planId, revision, null, finalDir, prepared, at);
      // The top-level fields name the plan saved last; plans holds every scheme's current plan.
      const value = {planId, scheme, revision, parentRevision: stored.parentRevision, name: document.name, inputHash: hashJson(document),
        artifacts: Object.fromEntries(artifacts.map(a => [a.kind, {id: a.id, sha256: a.sha256}])),
        plans: {...this.currentPlans(projectId), [scheme]: {planId, revision, name: document.name}}};
      const changed = this.store.project.write(projectId, {architecture: {value, provenance: {tool: by === 'agent' ? 'acres_save_plan' : 'user', account, at: new Date(at).toISOString(), revision, sources: []}}}, at);
      // The site's scheme names its plan (schemes.mjs), with the drawing its card shows, once the site has schemes.
      const svg = artifacts.find(a => a.kind === 'svg')?.id ?? null;
      const sheet = artifacts.find(a => a.kind === 'zd1-svg')?.id;
      const zoning = sheet ? {zoning: {svg: sheet, pdf: artifacts.find(a => a.kind === 'zd1-pdf')?.id ?? null}} : {};
      const files = Object.fromEntries(PACKAGE_KINDS.map(kind => [kind, artifacts.find(a => a.kind === kind)?.id]).filter(([, id]) => id));
      if (this.store.project.read(projectId).schemes) changed.push(...this.store.project.setSchemePart(projectId, scheme, 'plan', {planId, revision, svg, ...zoning, files}, at).filter(key => !changed.includes(key)));
      if (changed.length) stateEvent = this.store.appendProjectEvent(projectId, 'state.updated', {projectId, version: this.store.project.row(projectId).version, keys: changed, account});
      revisionEvent = this.store.appendProjectEvent(projectId, 'architecture.revision', {projectId, planId, scheme, revision, parentRevision: stored.parentRevision, by});
      this.db.exec('RELEASE architecture_save');
    } catch (error) {
      this.db.exec('ROLLBACK TO architecture_save; RELEASE architecture_save');
      rmSync(finalDir, {recursive: true, force: true});
      throw error;
    }
    if (stateEvent) this.store.projectFeed.emit(projectId, stateEvent);
    this.store.projectFeed.emit(projectId, revisionEvent);
    return this.revisionView(projectId, this.revisionRow(projectId, planId, revision), jobView);
  }

  // The artifact row, the file stat and a stream; null when the account cannot read the project or
  // the artifact belongs to another project.
  open(account, projectId, artifactId) {
    if (!this.store.projectAccess(account, projectId)) return null;
    const row = this.artifactRow(projectId, artifactId);
    if (!row || !row.path.startsWith(this.root + '/')) return null;
    const stat = lstatSync(row.path, {throwIfNoEntry: false});
    if (!stat?.isFile() || stat.size !== row.bytes) return null;
    return {artifact: artifactView(row), stream: () => createReadStream(row.path)};
  }
}
