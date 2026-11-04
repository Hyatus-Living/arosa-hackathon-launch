// Durable architecture jobs: one row per request to turn a plan revision's IFC into the Blender,
// preview and GLB outputs. The worker runs outside the request handler as a detached child in its
// own process group, with a deadline; timeout and cancellation send the group SIGTERM, then SIGKILL
// after a grace period, and a normal exit kills whatever the worker left in its group. A job running when the service stopped
// is marked failed on the next start and its group is killed. A render job (kind 'render') turns one
// scheme's render scene (render-scene.mjs) into street and aerial stills in the same worker, queue
// and limits; it belongs to no plan (plan_id null, revision 0). See docs/architecture-jobs.md.
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,readSync,writeFileSync} from 'node:fs';
import {copyFile} from 'node:fs/promises';
import {assertVerifiedFile} from './artifact-io.mjs';
import {throwIfCancelled,executionSignal,combinedSignal,stoppedError} from './execution-context.mjs';
import {join} from 'node:path';
import {JOB_FILES,DEFAULT_SCHEME,checkScheme,hashJson,sha256File,regularFile,IFC_MAX_BYTES} from './architecture-artifacts.mjs';
import {validateRenderScene} from './render-scene.mjs';
import {SCHEME_IDS} from './schemes.mjs';

const SETTINGS_MAX_CHARS = 8000;
// The worker requires settings.preview {width, height}, integers from 16 to 2048
// (worker/architecture_worker.py). Defaults fill in before hashing so an explicit default reuses a job.
const PREVIEW_DEFAULT = {width: 1280, height: 720};
const PREVIEW_SIDE = [16, 2048];
function withDefaults(settings = {}) {
  if (!plain(settings) || JSON.stringify(settings).length > SETTINGS_MAX_CHARS) throw bad(`settings must be an object of at most ${SETTINGS_MAX_CHARS} characters.`);
  if (settings.preview !== undefined && !plain(settings.preview)) throw bad('settings.preview must be an object with width and height.');
  const preview = {...PREVIEW_DEFAULT, ...settings.preview};
  for (const side of ['width', 'height']) {
    if (!Number.isInteger(preview[side]) || preview[side] < PREVIEW_SIDE[0] || preview[side] > PREVIEW_SIDE[1]) throw bad(`settings.preview.${side} must be a whole number from ${PREVIEW_SIDE[0]} to ${PREVIEW_SIDE[1]}.`);
  }
  return {...settings, preview};
}
// Render stills: bounded size and samples, so a job always finishes inside the deadline on the
// worker's two CPUs (about 80 s for both 1280 x 800 stills at 24 samples).
const RENDER_DEFAULT = {width: 1280, height: 800, samples: 24};
const RENDER_LIMITS = {width: [320, 2048], height: [320, 2048], samples: [1, 64]};
function withRenderDefaults(settings = {}) {
  if (!plain(settings) || (settings.render !== undefined && !plain(settings.render))) throw bad('settings.render must be an object with width, height and samples.');
  const render = {...RENDER_DEFAULT, ...settings.render};
  for (const [key, [low, high]] of Object.entries(RENDER_LIMITS)) {
    if (!Number.isInteger(render[key]) || render[key] < low || render[key] > high) throw bad(`settings.render.${key} must be a whole number from ${low} to ${high}.`);
  }
  return {render: {width: render.width, height: render.height, samples: render.samples}};
}
export const RENDER_FILES = [['verification.json', 'verification', 'application/json'], ['street.png', 'render-street', 'image/png'], ['aerial.png', 'render-aerial', 'image/png']];
const filesOf = kind => kind === 'render' ? RENDER_FILES : JOB_FILES;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const JOB_COLUMNS = 'job_id,project,plan_id,revision,status,reason,input_hash,pipeline_version,settings_hash,settings,created_by,created_at,started_at,finished_at,job_dir,pid,artifacts';
const bad = (message, status = 400) => Object.assign(new Error(message), {status});
const plain = value => value != null && typeof value === 'object' && !Array.isArray(value);

// The supervisor publishes only the complete output contract confirmed by the worker.
// Reuse also checks these bytes against the immutable artifact records saved on completion.
async function verifiedOutputs(architecture, dir, exitCode = 0, signal, files = JOB_FILES) {
  const reportPath=join(dir,'verification.json');
  if(!regularFile(reportPath,'Worker output verification.json',1024*1024)){
    const tail=exitCode===0?'':workerLogTail(join(dir,'..'));
    throw bad(tail?`The worker exited ${exitCode??'abnormally'} without a verification report: ${tail}`:'Worker output verification.json is missing or empty.',502);
  }
  const outputs=await architecture.prepare(dir,files,{signal});
  const report=outputs.find(file=>file.kind==='verification');
  const verification=JSON.parse(report.text);
  assertVerifiedFile(reportPath,report);
  if(exitCode!==0||verification?.status!=='succeeded')throw bad(typeof verification?.reason==='string'?verification.reason.slice(0,500):`The worker did not report successful verification (exit ${exitCode}).`,502);
  for(const [name,kind] of files.slice(1)){
    const file=outputs.find(output=>output.kind===kind);
    if(!file?.bytes)throw bad(`Worker output ${name} is missing or empty.`,502);
    if(file.sha256!==verification.hashes?.[`${kind}Sha256`])throw bad(`Worker output ${name} does not match its verification hash.`,502);
  }
  return outputs;
}

// The worker's last output lines, for a failure that left no verification report, such as a
// systemd unit the worker launcher was not allowed to start.
const LOG_TAIL_BYTES=2048;
function workerLogTail(jobDir) {
  const path=join(jobDir,'worker.log'),size=regularFile(path,'worker.log',Number.MAX_SAFE_INTEGER);
  if(!size)return '';
  const length=Math.min(size,LOG_TAIL_BYTES),buffer=Buffer.alloc(length),fd=openSync(path,'r');
  try{readSync(fd,buffer,0,length,size-length);}finally{closeSync(fd);}
  return buffer.toString('utf8').trim().split('\n').slice(-3).map(line=>line.trim()).filter(Boolean).join(' | ').slice(0,300);
}

// Signals a job's process group. A pgid cannot be reused while any member of the group is alive,
// so when the leader is gone the remaining members are this job's descendants; when the leader is
// alive (after a restart) it must still be this job's worker, named by its --job directory.
// Returns whether the group existed.
export function signalGroup(pgid, signal, jobDir = null) {
  if (!pgid) return false;
  try { process.kill(-pgid, 0); } catch { return false; }
  if (jobDir) {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pgid)], {encoding: 'utf8'}).stdout.trim();
    if (command && !command.includes(jobDir)) return false;
  }
  try { process.kill(-pgid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  return true;
}

// Stops a job's group: SIGTERM so the worker can stop Blender and record why, then SIGKILL after
// the grace period for whatever is left. Returns the pending SIGKILL timer.
export function stopGroup(pgid, graceMs, jobDir = null) {
  if (!signalGroup(pgid, 'SIGTERM', jobDir)) return null;
  const timer = setTimeout(() => signalGroup(pgid, 'SIGKILL', jobDir), graceMs);
  timer.unref();
  return timer;
}

export class ArchitectureJobs {
  constructor(architecture, {worker, pipelineVersion, deadlineSeconds = 300, killGraceMs = 10000, concurrency = 1}) {
    this.architecture = architecture;
    this.store = architecture.store;
    this.root = join(architecture.root, 'jobs');
    this.worker = worker;
    this.pipelineVersion = pipelineVersion;
    this.deadlineSeconds = deadlineSeconds;
    this.killGraceMs = killGraceMs;
    this.concurrency = concurrency;
    this.active = new Map();
    this.closed = false;
    this.draining = false;
    this.creating = new Map();
    this.shutdown = new AbortController();
    // Render jobs (kind, scheme) arrived after the table; older databases gain the columns here.
    const columns = new Set(this.store.query('PRAGMA table_info(architecture_jobs)').map(column => column.name));
    if (!columns.has('kind')) this.store.db.exec("ALTER TABLE architecture_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'model'");
    if (!columns.has('scheme')) this.store.db.exec('ALTER TABLE architecture_jobs ADD COLUMN scheme TEXT');
  }

  row(jobId) { return this.store.one('SELECT * FROM architecture_jobs WHERE job_id=?', jobId) ?? null; }
  view = row => ({id: row.job_id, projectId: row.project, kind: row.kind, scheme: row.scheme, planId: row.plan_id, revision: row.revision, status: row.status, reason: row.reason, inputHash: row.input_hash,
    pipelineVersion: row.pipeline_version, settingsHash: row.settings_hash, createdBy: row.created_by, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at, artifacts: JSON.parse(row.artifacts)});

  emit(row) {
    const event = this.store.appendProjectEvent(row.project, 'architecture.job', {projectId: row.project, jobId: row.job_id, planId: row.plan_id, revision: row.revision, status: row.status, ...(row.kind === 'render' ? {kind: 'render', scheme: row.scheme} : {}), ...(row.reason ? {reason: row.reason} : {})});
    this.store.projectFeed.emit(row.project, event);
    if (row.kind === 'render') this.onRender?.(row);
  }
  update(jobId, fields, onlyIf) {
    const keys = Object.keys(fields);
    const result = this.store.write(`UPDATE architecture_jobs SET ${keys.map(k => `${k}=?`).join(',')} WHERE job_id=?${onlyIf ? ` AND status='${onlyIf}'` : ''}`, ...keys.map(k => fields[k]), jobId);
    if (!result.changes) return null;
    const row = this.row(jobId);
    this.emit(row);
    return row;
  }

  // A job for the account's project; null when the account cannot read the project or the job
  // belongs to another project.
  get(account, projectId, jobId) {
    if (!this.store.projectAccess(account, projectId)) return null;
    const row = this.row(jobId);
    return row && row.project === projectId ? this.view(row) : null;
  }

  // Queues a job for a revision of one of the project's plans (named by planId, or by scheme, the
  // as-of-right plan by default), or returns the queued, running or completed job with the same
  // input, pipeline and settings. A completed job for another revision with the same IFC becomes a
  // completed job of this revision with its outputs registered again, so artifacts stay per revision.
  async create(account,projectId,input={}) {
    const previous=this.creating.get(projectId)||Promise.resolve();
    let release;const pending=new Promise(resolve=>{release=resolve;});this.creating.set(projectId,pending);
    try{await previous;return input.kind==='render'?await this.createRender(account,projectId,input):await this.createOne(account,projectId,input);}
    finally{release();if(this.creating.get(projectId)===pending)this.creating.delete(projectId);}
  }

  // Queues a render of one scheme's scene, or returns the queued, running or completed render of the
  // same scene, pipeline and settings for that scheme. The scene is written into the job directory
  // now and checked against its hash when the job starts.
  async createRender(account, projectId, {scheme, scene, settings} = {}) {
    throwIfCancelled();
    if(this.draining||this.closed)throw bad('Architecture processing is restarting. Try again shortly.',503);
    this.store.requireProject(account, projectId, 'participant');
    if (!SCHEME_IDS.includes(scheme)) throw bad(`scheme must be one of ${SCHEME_IDS.join(', ')}.`);
    settings = withRenderDefaults(settings);
    const text = JSON.stringify(validateRenderScene(scene));
    if (!this.worker) throw bad('Architecture processing is not enabled.', 503);
    const inputHash = createHash('sha256').update(text).digest('hex'), settingsHash = hashJson(settings);
    let match = this.store.one(`SELECT * FROM architecture_jobs WHERE project=? AND kind='render' AND scheme=? AND input_hash=? AND pipeline_version=? AND settings_hash=? AND status IN ('queued','running','succeeded')
      ORDER BY created_at DESC LIMIT 1`, projectId, scheme, inputHash, this.pipelineVersion, settingsHash);
    if (match?.status === 'succeeded') {
      try { await this.checkStored(match); }
      catch (error) {
        this.update(match.job_id, {status: 'failed', reason: `Stored outputs failed verification: ${error.message}`.slice(0, 300), finished_at: Date.now()}, 'succeeded');
        match = null;
      }
    }
    if (match) return {...this.view(match), reused: true};
    const jobId = randomUUID(), jobDir = join(this.root, jobId);
    mkdirSync(join(jobDir, 'input'), {recursive: true, mode: 0o700});
    writeFileSync(join(jobDir, 'input', 'scene.json'), text, {mode: 0o600});
    this.store.write(`INSERT INTO architecture_jobs(job_id,project,kind,scheme,revision,status,input_hash,pipeline_version,settings_hash,settings,created_by,created_at,job_dir) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      jobId, projectId, 'render', scheme, 0, 'queued', inputHash, this.pipelineVersion, settingsHash, JSON.stringify(settings), account, Date.now(), jobDir);
    this.emit(this.row(jobId));
    setImmediate(() => this.pump());
    return this.view(this.row(jobId));
  }
  // A completed job's files still match what the worker verified and what was registered.
  async checkStored(row, signal) {
    const outputs = await verifiedOutputs(this.architecture, join(row.job_dir, 'output'), 0, signal, filesOf(row.kind));
    const artifacts = JSON.parse(row.artifacts);
    if (artifacts.length !== outputs.length || outputs.some(output => !artifacts.some(artifact => artifact.kind === output.kind && artifact.bytes === output.bytes && artifact.sha256 === output.sha256))) {
      throw bad('Stored output hashes do not match the completed job artifacts.', 502);
    }
    return outputs;
  }
  async createOne(account, projectId, {planId, scheme = DEFAULT_SCHEME, revision, settings} = {}) {
    throwIfCancelled();
    if(this.draining||this.closed)throw bad('Architecture processing is restarting. Try again shortly.',503);
    const signal=combinedSignal(executionSignal(),this.shutdown.signal);
    let prepared;
    this.store.requireProject(account, projectId, 'participant');
    if (!Number.isSafeInteger(revision) || revision < 1) throw bad('revision must be a revision number.');
    settings = withDefaults(settings);
    if (!this.worker) throw bad('Architecture processing is not enabled.', 503);
    planId ??= this.architecture.head(projectId, checkScheme(scheme))?.plan_id;
    if (!planId || !this.architecture.revisionRow(projectId, planId, revision)) throw bad('Revision not found.', 404);
    const ifc = this.store.one("SELECT * FROM architecture_artifacts WHERE project=? AND plan_id=? AND revision=? AND kind='ifc' AND job_id IS NULL", projectId, planId, revision);
    if (!ifc) throw bad('This revision has no IFC to process.', 409);
    if (ifc.bytes > IFC_MAX_BYTES) throw bad('The IFC exceeds 50 MB.', 413);
    const settingsHash = hashJson(settings);
    let match = this.store.one(`SELECT * FROM architecture_jobs WHERE project=? AND kind='model' AND input_hash=? AND pipeline_version=? AND settings_hash=? AND status IN ('queued','running','succeeded')
      ORDER BY (plan_id=? AND revision=?) DESC, created_at DESC LIMIT 1`, projectId, ifc.sha256, this.pipelineVersion, settingsHash, planId, revision);
    if (match?.status === 'succeeded') {
      try {
        prepared = await this.checkStored(match, signal);
      } catch (error) {
        signal?.throwIfAborted();
        this.store.requireProject(account,projectId,'participant');
        this.update(match.job_id, {status: 'failed', reason: `Stored outputs failed verification: ${error.message}`.slice(0, 300), finished_at: Date.now()}, 'succeeded');
        match = null;
      }
    }
    signal?.throwIfAborted();
    this.store.requireProject(account,projectId,'participant');
    if(this.draining)throw bad('Architecture processing is restarting. Try again shortly.',503);
    if (match?.plan_id === planId && match.revision === revision) return {...this.view(match), reused: true};
    const jobId = randomUUID(), now = Date.now(), jobDir = join(this.root, jobId);
    if (match?.status === 'succeeded') {
      this.store.db.exec('SAVEPOINT architecture_reuse');
      try {
        this.store.write(`INSERT INTO architecture_jobs(${JOB_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, jobId, projectId, planId, revision, 'succeeded', `Reused the outputs of job ${match.job_id}.`, ifc.sha256, this.pipelineVersion, settingsHash, JSON.stringify(settings), account, now, now, now, match.job_dir, null, '[]');
        const artifacts=this.architecture.register(projectId,planId,revision,jobId,join(match.job_dir,'output'),prepared);
        this.store.write('UPDATE architecture_jobs SET artifacts=? WHERE job_id=?',JSON.stringify(artifacts),jobId);
        this.store.db.exec('RELEASE architecture_reuse');
      }catch(error){this.store.db.exec('ROLLBACK TO architecture_reuse; RELEASE architecture_reuse');throw error;}
      const row = this.row(jobId);
      this.emit(row);
      return {...this.view(row), reused: true};
    }
    this.store.write(`INSERT INTO architecture_jobs(${JOB_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, jobId, projectId, planId, revision, 'queued', null, ifc.sha256, this.pipelineVersion, settingsHash, JSON.stringify(settings), account, now, null, null, jobDir, null, '[]');
    this.emit(this.row(jobId));
    setImmediate(() => this.pump());
    return this.view(this.row(jobId));
  }

  cancel(account, projectId, jobId) {
    this.store.requireProject(account, projectId, 'participant');
    const row = this.row(jobId);
    if (!row || row.project !== projectId) throw bad('Job not found.', 404);
    if (TERMINAL.includes(row.status)) throw bad(`This job already ${row.status === 'succeeded' ? 'succeeded' : row.status === 'failed' ? 'failed' : 'was cancelled'}.`, 409);
    if (row.status === 'queued') return this.view(this.update(jobId, {status: 'cancelled', reason: 'Cancelled before it started.', finished_at: Date.now()}, 'queued') ?? this.row(jobId));
    const active = this.active.get(jobId);
    if (active && !active.ending) { active.ending = {status: 'cancelled', reason: 'Cancelled while running.'}; active.controller.abort(stoppedError()); active.killTimer = stopGroup(row.pid, this.killGraceMs); }
    return this.view(this.row(jobId));
  }

  // Starts queued jobs, oldest first, up to the concurrency limit.
  pump() {
    if (this.closed || this.draining || !this.worker) return;
    while (this.active.size < this.concurrency) {
      const next = this.store.one("SELECT * FROM architecture_jobs WHERE status='queued' ORDER BY created_at LIMIT 1");
      if (!next) return;
      this.start(next);
    }
  }

  start(row) {
    const active={child:null,ending:null,controller:new AbortController()};
    active.done=new Promise(resolve=>{active.resolveDone=resolve;});
    this.active.set(row.job_id,active);
    this.update(row.job_id,{status:'running',started_at:Date.now()},'queued');
    active.timer=setTimeout(()=>{
      active.ending??={status:'failed',reason:`The job exceeded its ${this.deadlineSeconds}-second deadline.`};
      active.controller.abort(stoppedError(active.ending.reason));
      active.killTimer=stopGroup(active.child?.pid,this.killGraceMs);
    },this.deadlineSeconds*1000);
    active.preparation=this.prepareWorker(row,active);
  }

  async prepareWorker(row,active) {
    const {job_id:jobId,job_dir:jobDir}=row,signal=active.controller.signal;
    try {
      mkdirSync(join(jobDir,'input'),{recursive:true,mode:0o700});
      mkdirSync(join(jobDir,'output'),{recursive:true,mode:0o700});
      if(row.kind==='render'){
        if(await sha256File(join(jobDir,'input','scene.json'),{signal,maxBytes:IFC_MAX_BYTES})!==row.input_hash)throw new Error('The render scene changed on disk.');
      }else{
        const ifc=this.store.one("SELECT * FROM architecture_artifacts WHERE project=? AND plan_id=? AND revision=? AND kind='ifc' AND job_id IS NULL",row.project,row.plan_id,row.revision);
        await copyFile(ifc.path,join(jobDir,'input','model.ifc'));
        if(await sha256File(join(jobDir,'input','model.ifc'),{signal,maxBytes:IFC_MAX_BYTES})!==row.input_hash)throw new Error('The revision IFC changed on disk.');
      }
      signal.throwIfAborted();
      writeFileSync(join(jobDir,'job.json'),JSON.stringify({jobId,projectId:row.project,planId:row.plan_id,revision:row.revision,...(row.kind==='render'?{kind:'render',scheme:row.scheme}:{}),settings:JSON.parse(row.settings),deadlineSeconds:this.deadlineSeconds}),{mode:0o600});
      const log=openSync(join(jobDir,'worker.log'),'a',0o600);
      const child=active.child=spawn(this.worker,['--job',jobDir],{cwd:jobDir,detached:true,stdio:['ignore',log,log],env:{PATH:process.env.PATH,LANG:process.env.LANG||'C.UTF-8'}});
      closeSync(log);
      child.on('error',error=>{
        active.ending??={status:'failed',reason:`The worker could not start (${error.code||'error'}).`};
        if(child.pid===undefined)void this.finish(jobId,child.pid,null,active);
      });
      child.on('close',code=>{void this.finish(jobId,child.pid,code,active);});
      this.store.write("UPDATE architecture_jobs SET pid=? WHERE job_id=? AND status='running'",child.pid??null,jobId);
    }catch(error){
      active.ending??={status:'failed',reason:String(error.message).slice(0,300)};
      await this.finish(jobId,active.child?.pid,null,active);
    }
  }

  async finish(jobId,pid,code,active) {
    if(active.finishing)return;
    active.finishing=true;
    clearTimeout(active.killTimer);
    signalGroup(pid,'SIGKILL');
    try {
      if(this.closed)return;
      const row=this.row(jobId);let result=active.ending;
      if(!result){
        try {
          const out=join(row.job_dir,'output');
          const prepared=await verifiedOutputs(this.architecture,out,code,active.controller.signal,filesOf(row.kind));
          active.controller.signal.throwIfAborted();
          if(this.closed)return;
          this.store.db.exec('SAVEPOINT architecture_job');
          try {
            const artifacts=this.architecture.register(row.project,row.plan_id,row.revision,jobId,out,prepared);
            this.store.write('UPDATE architecture_jobs SET artifacts=? WHERE job_id=?',JSON.stringify(artifacts),jobId);
            this.store.db.exec('RELEASE architecture_job');
          }catch(error){this.store.db.exec('ROLLBACK TO architecture_job; RELEASE architecture_job');throw error;}
          result={status:'succeeded',reason:null};
        }catch(error){result=active.ending||{status:'failed',reason:String(error.message).slice(0,300)};}
      }
      if(!this.closed)this.update(jobId,{status:result.status,reason:result.reason,finished_at:Date.now()},'running');
    }finally{
      clearTimeout(active.timer);clearTimeout(active.killTimer);
      this.active.delete(jobId);active.resolveDone();this.pump();this.onIdle?.();
    }
  }

  // On service start: a job still marked running lost its supervisor, so it fails with a reason
  // and its process group is killed; then queued jobs start.
  recover() {
    for (const row of this.store.query("SELECT * FROM architecture_jobs WHERE status='running'")) {
      stopGroup(row.pid, this.killGraceMs, row.job_dir);
      this.update(row.job_id, {status: 'failed', reason: 'The research service restarted while this job was running.', finished_at: Date.now()}, 'running');
    }
    setImmediate(() => this.pump());
  }

  stopAdmission() { this.draining=true; }
  settled() { return Promise.allSettled([...this.creating.values(),...[...this.active.values()].map(active=>active.done)]); }
  cancelActive() {
    this.shutdown.abort(stoppedError('Service is stopping.'));
    for(const active of this.active.values()) {
      active.ending??={status:'cancelled',reason:'Service stopped before the job completed.'};
      active.controller.abort(stoppedError());
      if(active.child?.pid)active.killTimer=stopGroup(active.child.pid,this.killGraceMs);
    }
  }
  // Abrupt supervisor closure is retained for restart recovery and tests.
  close() {
    this.closed = true;this.shutdown.abort(stoppedError());
    for (const active of this.active.values()){clearTimeout(active.timer);active.controller.abort(stoppedError());}
  }
}
