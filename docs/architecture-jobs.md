# Architecture plans, jobs and artifacts

The research service keeps one editable architecture plan per scheme of a project (`as_of_right`,
`max_bonus`, `alternative`; see `acres-research/schemes.mjs`), numbered revisions of each, durable
processing jobs that turn a revision's IFC into Blender, preview and GLB outputs, and the
files both produce. Code: `acres-research/architecture-artifacts.mjs` (plans, revisions, artifacts)
and `acres-research/architecture-jobs.mjs` (jobs and the worker process). Tests:
`acres-research/architecture.test.mjs`.

## Switching it on

The routes exist only when the service runs with `ACRES_ARCHITECTURE_ENABLED=true`. Jobs also need
`ACRES_ARCHITECTURE_WORKER`, the absolute path of the worker executable
(`/opt/acres-architecture-worker/current/bin/architecture-worker`, or `bin/architecture-worker-unit`
beside it to run each job in a systemd unit with memory and CPU limits, or `bin/architecture-worker-gpu` to run it on the GPU render host; see the worker's docs); without it plan revisions
work and `POST .../jobs` answers 503, so a disabled feature never starts Blender.
`ACRES_ARCHITECTURE_PIPELINE_VERSION` (default `1`) names the worker build; change it whenever the
worker changes so completed jobs are not reused across versions. Files live under
`/home/openclaw/.openclaw/acres-state/architecture/`, beside `chat.sqlite`, and are covered by the
same state backup.

## Plans per scheme

`architecture_plans` is keyed `(plan_id, revision)` and unique on `(project, scheme, revision)`: each
scheme's plan numbers its own revisions from 1, so jobs and artifacts carry `plan_id` and every
query joins on it. Every plan route takes `?scheme=` (or `scheme` in a JSON body); without one it
reads and writes the `as_of_right` plan, which is where every plan from before schemes was migrated
(`migrateArchitecture`, run once at store start: the plans table is rebuilt with its rows, plan ids,
revisions and authors, and `plan_id` is filled on jobs and artifacts from the project's only plan).
The summary lists each scheme's latest revision in `schemes`. A save also records
`{planId, revision}` as the scheme's `plan` part (`setSchemePart`) once the site has schemes.

`POST .../schemes/draft` ("Draft all three", participant or owner) queues one row in
`architecture_drafts` per scheme that has a building and returns `202 {drafts}`; `GET` returns the
latest draft of each scheme. The drafts run one after another: each lays out the scheme's typical
floor on the lot (`schemePlan` in `architecture-tools.mjs`: the plate is the scheme's zoning floor
area over its storeys, up to 60 ft deep and never past the PLUTO lot; the floor holds the scheme's
units over its storeys at its unit mix), saves it as the next revision of that scheme's plan
(`by: "agent"`), queues its walkthrough job and records a report (units per floor, net-to-gross, mix,
and fit issues when units are drawn under 80% or over 130% of their net size or under 14 ft wide).
Each status change emits `architecture.draft {projectId, draftId, scheme, status}`. Drafts running
when the service stops are failed on the next start.

## Plan revisions

A plan is an `acres.architecture.plan/1` document:
`{schema, id, revision, parentRevision, name, units:"m", levels[], walls[], openings[], rooms[], objects[], sources[]}`.
The service checks what it can without geometry: the envelope, unique `id`s on levels, walls,
openings and rooms, `walls[].levelId`, `rooms[].levelId`, `objects[].levelId`, `walls[].roomIds`
and `openings[].wallId` references. Geometry is validated by the geometry lane's build
(`planning.mjs` `buildArchitectureRevision(plan, {outDir, planningDir})`, with `planningDir` from
`ACRES_PLANNING_DIR` in `/etc/acres-research/secrets.json`, else the environment, the same
directory the chat planning tools use); a build error with status 400 is
returned to the editor as `400 {error, validationErrors:[{code, id, message}]}` (at most 50), any other build failure is a 502 and stores nothing.

Saving is optimistic: `PUT .../plan {parentRevision, plan}` must name the current revision (`null`
for the first plan) or it gets `409 {error, revision}`. The server assigns `id` (the plan id, one per
project), `revision` (parent + 1) and `parentRevision`, writes `plan.json`, builds the derived files
into a staging directory, and commits the revision, its artifacts and the project-state node in one
transaction. Files of revision `r` are in `architecture/plans/<planId>/<r>/`: `plan.json`,
`plan.svg`, `model.ifc`, `pascal-scene.json`, `idmap.json`.

The project state gains an `architecture` field (`{planId, revision, parentRevision, name,
inputHash, artifacts:{kind:{id, sha256}}}`, provenance `{tool, account, at, revision}` where tool is
`user` for the editor and `acres_save_plan` for the research agent).
Its top-level fields name the plan saved last, with its `scheme`, and `plans` maps each scheme to
its current `{planId, revision, name}`.
It depends on `property`, so selecting another parcel marks it stale, and a save emits
`state.updated` and `architecture.revision {projectId, planId, scheme, revision, parentRevision, by:"user"|"agent"}`
on the project event stream. That field is what "current" means: reopening the
project shows exactly that revision, and older revisions stay readable by number.

Limits: the plan document is at most 2 MB (413), the generated IFC at most 50 MB (413), job
settings at most 8,000 characters, each worker output at most 512 MB.

## Jobs

`POST .../jobs {revision, settings, scheme}` (participant or owner) queues a job for that revision
of the scheme's plan (the as-of-right plan when no scheme is given).
`settings` may be omitted; the service fills `preview: {width: 1280, height: 720}` (each side a
whole number from 16 to 2048, as the worker requires) before hashing and writing `job.json`, so a
request with the explicit defaults reuses the same job.
A job with the same input hash (the IFC's sha256), pipeline version and settings hash in the same
project is returned instead of a new one (`200`, `reused: true`); a completed one from another
revision becomes a completed job of this revision with its outputs registered again, so artifacts
always belong to one revision. Failed and cancelled jobs are never reused.

One job runs at a time. Starting a job creates `architecture/jobs/<jobId>/` with `input/model.ifc`
(copied from the revision and checked against its hash), `job.json`
(`{jobId, projectId, revision, settings, deadlineSeconds}`), `output/` and `worker.log`, then runs
`<worker> --job <jobDir>` as a detached child in its own process group with only `PATH` and `LANG`
in its environment. The deadline is 300 seconds.

The worker writes `output/{verification.json, model.blend, preview.png, model.glb, manifest.json}`
and exits 0 with verification status `succeeded`, or exits non-zero with `verification.json`
`{status:"failed", reason}`. On exit the service kills the process group (anything the worker left
behind), then requires every output to be a nonempty regular file within its size limit. The
four model/preview/manifest hashes must match the verification report before any artifacts are
registered. Missing files, invalid reports, hash mismatches and symlinks fail the job. Before
reusing a completed job, the service repeats these checks and compares the files with its saved
artifact hashes. Invalid cached work is marked failed with a reason and a fresh job is queued;
historical artifact records remain attached to their original job. Statuses are `queued`,
`running`, `succeeded`, `failed`, `cancelled`; every change is an `architecture.job` event
`{projectId, jobId, revision, status, reason?}` on `GET /projects/:id/events`.

Timeout and cancel send the worker's process group SIGTERM, so the worker can stop Blender and write
a failed `verification.json`, then SIGKILL after a 10-second grace period for anything left. The
worker's own deadline handling finishes before the service's, so the service timeout is a backstop.
When the service starts, a job still marked `running` is failed with "The research service
restarted while this job was running." and its group is stopped the same way (only if the leader
is gone or is still that job's worker); queued jobs then start.

## Scheme renders

Each of a site's three schemes (`schemes.mjs`) can have a presentation rendering: its massing with
simple facade materials, among the neighbouring buildings, in a fixed New York afternoon sun.
`POST /projects/:id/schemes/:schemeId/render` (participant or owner, proxied as
`/api/projects/:id/schemes/:schemeId/render`) builds the scheme's scene and queues a render job;
it answers `202` with the scheme's render part.

- **Scene** (`render-scene.mjs`, `acres.render.scene/1`, metres in the concept frame): the scheme's
  linked concept when it has storey footprints, otherwise the zoning envelope's storeys cut or
  extended to the scheme's storeys and shortened from the rear so the gross area matches the
  scheme (never beyond the envelope). Ground floors with a retail or commercial use get storefront
  glazing; the rest are residential. Neighbours are the concept's own context, or NYC building
  footprints loaded for the envelope's lot (`context.mjs`), without the building the scheme replaces.
  The sun is fixed at azimuth 225 degrees and 35 degrees up.
- **Job**: an `architecture_jobs` row with `kind='render'`, `scheme` and `revision` 0 (it belongs to
  no plan revision). The scene is written to `input/scene.json` when the job is queued and checked
  against `input_hash` when it starts. Settings are `{render: {width, height, samples}}`, defaults
  1280 x 800 at 24 samples, sides 320 to 2048 and samples 1 to 64. The same scheme, scene, pipeline
  and settings reuse the queued, running or finished job, as for model jobs.
- **Worker**: `render_job.py` in one Blender (no Bonsai) renders `output/street.png` (a level
  camera in the street, verticals kept vertical with lens shift) and `output/aerial.png` (35 degrees
  from the street side) with Cycles on the CPU, a fixed seed and denoising. The supervisor checks
  both are PNGs of the requested size, drops their text chunks (Cycles stamps its render time into each, so identical pixels would hash differently) and reports their hashes as `render-streetSha256` and
  `render-aerialSha256`. On the VM both stills take about 80 seconds at the defaults.
- **Artifacts**: `render-street` and `render-aerial` (PNG) plus `verification`, served by the
  artifacts route below.
- **Part**: `setSchemePart(projectId, schemeId, 'render', part)` with
  `{artifactId, status, url, jobId, reason, views: [{view, artifactId, url}], renderSeconds, at}`
  (the street still is `artifactId`/`url`). The part follows its job through every status change,
  and only the job it names: a render requested for an earlier building never overwrites it.
- **View**: `app-starter/public/render-view.js` exports `renderSchemeRender(container, render, options)`
  for the scheme card, with the not drawn, rendering, failed and ready states.

## Drawings

A project keeps the drawings its plan is traced from: SVG (2 MB), PNG, JPEG or WebP (15 MB each) and
PDF (25 MB), typed from their bytes. They are uploaded raw (`x-drawing-name` carries the
URI-encoded file name) or attached by URL (`{url, name}`), which the service downloads from a public
HTTPS address only, re-checking each redirect, its DNS and the address actually dialled, and
refusing short-term and furnished rental platforms on every hop. Files live in
`architecture/drawings/<projectId>/`; a drawing is `{id, name, kind, contentType, bytes, sha256,
sourceUrl, foundOn, createdAt, createdBy, by:"user"|"agent"}`. Each new drawing emits
`architecture.drawing {projectId, drawingId, name, kind, by}` on the project event stream.

The research agent works on the plan of the project its conversation belongs to, as the run's
sender (only when the sender's email is in `ACRES_ARCHITECTURE_EMAILS` on the research host, when
that list is set, matching the web app's rollout), with `acres_find_floor_plan`, `acres_attach_drawing`, `acres_read_plan`,
`acres_save_plan` and `acres_render_plan` (`architecture-tools.mjs`, method in `skills/floor-plans`). Its saves use the same
parent revision guard as the editor. Saving through `acres_save_plan` also queues the walkthrough
finished-product job for the new revision (best-effort: the same `POST .../jobs` create the web
app's Run button uses, with the same reuse rules; a disabled worker is reported to the agent as
`unavailable` and never fails the save). Editor (`PUT .../plan`) saves queue the same job after
the revision is stored; a job that cannot start is logged and never fails the save. The Run
button or `acres_render_plan` starts a job again on demand. The Architecture section shows the succeeded
job's preview still and download links for every finished product and interchange file
(preview, GLB, Blender file, IFC, plan SVG, Pascal scene), each served by the artifacts route
below under the project's existing access rules. The plan document helpers are the editor's
`app-starter/public/plan-intake.js`, linked into the service as `plan-intake.mjs` and shipped under
that name by the installer.

## Routes

Research service (behind `RESEARCH_TOKEN` and `x-acres-account`), proxied by the web app under
`/api`:

| Route | Access | Result |
|---|---|---|
| `GET /projects/:id/architecture` | viewer | `{projectId, planId, stale, current:{planId, revision, parentRevision, createdBy, createdAt, inputHash, current, plan, artifacts, jobs}, revisions:[{revision, parentRevision, createdBy, createdAt, inputHash}]}` |
| `PUT /projects/:id/architecture/plan` | participant | `201` revision view; `409 {error, revision}`; `400`; `413` |
| `GET /projects/:id/architecture/revisions/:rev` | viewer | revision view |
| `POST /projects/:id/architecture/drawings` | participant | `201` drawing; `413` over its type's limit; `415` not a drawing |
| `GET /projects/:id/architecture/drawings` | viewer | `{drawings:[drawing]}`, newest first |
| `GET /projects/:id/architecture/drawings/:drawingId` | viewer | the file, with its content type and `ETag` of its sha256 (`304` on a match) |
| `POST /projects/:id/architecture/jobs` | participant | `202` job, or `200` reused job; `503` when jobs are disabled |
| `GET /projects/:id/architecture/jobs/:jobId` | viewer | job |
| `POST /projects/:id/architecture/jobs/:jobId/cancel` | participant | job; `409` when already finished |
| `GET /projects/:id/architecture/artifacts/:artifactId` | viewer | the file, with its content type, `ETag` of its sha256 (`304` on a match) and `X-Architecture-Revision` |

A job is `{id, projectId, revision, status, reason, inputHash, pipelineVersion, settingsHash,
createdBy, createdAt, startedAt, finishedAt, artifacts}`; an artifact is `{id, kind, revision,
jobId, sha256, bytes, contentType, createdAt}` with kind one of `plan`, `svg`, `ifc`,
`pascal-scene`, `idmap`, `verification`, `blend`, `preview`, `glb`, `manifest`. Job directories and
process ids are never returned. A job or artifact is found only through the project it belongs to,
so another account (or another project) gets 404 for any guessed id.
