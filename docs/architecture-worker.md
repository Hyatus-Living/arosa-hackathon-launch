# Architecture worker (Blender + Bonsai)

The worker turns one plan revision's IFC into the artifacts the walkthrough needs:
an editable `.blend`, a preview image, a GLB with stable node names and a manifest that
maps those nodes to IFC elements, levels, rooms and collision geometry. Each job runs
pinned official Blender LTS binaries with the Bonsai extension, in background mode only.

| Path | What it is |
|---|---|
| `worker/install.sh` | Installs a pinned release under a versioned prefix and gates activation on a health check and a smoke job |
| `worker/architecture_worker.py` | The job entry point (supervisor): `--job <jobDir>` |
| `worker/blender_job.py` | Runs inside Blender: Bonsai import, save, reopen, render, export |
| `worker/render_job.py` | Runs inside Blender for a render job (`kind: "render"`): builds `input/scene.json` and renders `street.png` and `aerial.png` (see docs/architecture-jobs.md, Scheme renders) |
| `worker/health.py`, `worker/make_fixture_ifc.py` | Health probe; the small IFC fixture used by the smoke job |
| `worker/VERSIONS.md` | Exact versions, download URLs, SHA-256 checksums and licences |
| `worker/tests/` | Supervisor contract tests with a fake Blender (`npm run test:worker`) |
| `infra/acres-architecture-worker@.service` | systemd template unit with the sandbox and the 2 vCPU / 4 GiB limits |

## Packaging decision

The worker is a versioned prefix under `/opt/acres-architecture-worker`, run by systemd.
It is not a container. The research service and the web app already run as systemd units on
the VM, and a release here is a plain directory: activation and rollback are a single
symlink switch, with no image registry, Docker daemon access or socket mount involved.
Every isolation property the brief asks for (unprivileged user, read-only system, one
writable job directory, CPU and memory limits, no network) comes from the unit's own
sandboxing.

## Install

Debian 12 x64 needs these runtime libraries for the official Blender binary:

```bash
sudo apt-get install -y --no-install-recommends xz-utils curl ca-certificates libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 libgl1 libegl1
```

Create the root once, owned by the service account, then install as that account. Root
privileges are not needed for the install itself:

```bash
sudo install -d -o openclaw -g openclaw /opt/acres-architecture-worker
```

```bash
sudo -u openclaw worker/install.sh
```

`install.sh` does the following:

1. Downloads Blender 4.5.14 LTS and Bonsai 0.9.0post1 (`py311` build) into `cache/`. Any file whose SHA-256 differs from `worker/VERSIONS.md` is refused and deleted.
2. Unpacks Blender into `releases/.staging-<id>/` and checks that it starts. A missing shared library names itself here.
3. Installs Bonsai with Blender's own `--command extension install-file --enable` into the release's private user resources. Nothing is written to the account's `~/.config/blender`.
4. Runs the health check: Blender in background mode, bundled Python 3.11.x, Bonsai enabled with its `bim.load_project` importer registered, and IfcOpenShell importable.
5. Runs a smoke job on the IFC fixture (four walls, one slab, one space, one door in an opening, one storey). The job must succeed with exactly those counts.
6. Writes `RELEASE.json` (versions, URLs, checksums, licences), moves the staging directory to `releases/<id>` and only then switches `current`.

The release ID is `blender-<version>+<bonsai tag>+worker-<hash of the worker scripts>`, so
changing the worker code produces a new release. The last stdout output is a JSON health
report; progress goes to stderr.

Disk use: about 1.9 GB per Linux release (Blender 1.1 GB, Bonsai and its wheels 0.8 GB)
plus 0.54 GB of cached downloads shared by all releases.

## Health check

```bash
/opt/acres-architecture-worker/current/bin/health
```

This prints `{blender:{version, python, background}, bonsai:{version, enabled, loadProjectOperator}, ifcopenshell:{version}}`.
The JSON the installer printed is kept as `releases/<id>/health.json`. The smoke job's full
`verification.json` stays in `releases/<id>/smoke/output/`.

## Job directory contract

```text
<jobDir>/job.json          {jobId, projectId, revision, settings:{preview:{width,height}}, deadlineSeconds}
<jobDir>/input/model.ifc
<jobDir>/output/           written by the worker
<jobDir>/tmp/              HOME and TMPDIR for Blender, created by the worker
```

Run a job with:

```bash
/opt/acres-architecture-worker/current/bin/architecture-worker --job <jobDir>
```

The worker exits 0 only when `output/verification.json` has `status: "succeeded"`. On any
failure it exits non-zero and writes `{status:"failed", reason}`. Preview sides must be
integers from 16 to 2048.

The worker reads and writes nothing outside the job directory:

- `job.json`, `input/model.ifc`, `output/` and every output file are resolved with symlinks followed and must stay inside the job directory, or the job fails before Blender starts. If `output/` itself escapes, the worker writes nothing and reports the error on stderr.
- Blender gets a scrubbed environment containing only `PATH`, `HOME`, `TMPDIR`, `LANG` and `BLENDER_USER_RESOURCES`. It runs with `--factory-startup --offline-mode`.

### Outputs

| File | Content |
|---|---|
| `model.blend` | The Bonsai-imported scene, saved before any preview helpers are added; Bonsai's IFC links intact |
| `preview.png` | Cycles CPU render at the requested size, 16 samples, space volumes hidden |
| `model.glb` | Every IFC-linked object Bonsai imported (elements, spaces and spatial empties), glTF Y up |
| `manifest.json` | Node to IFC mapping, levels and collision references (below) |
| `verification.json` | Gate result (below) |
| `blender.log` | Blender output for both phases, with step markers and a Python traceback on native crashes |

`verification.json` on success:

```text
{status:"succeeded", blender:{version,python}, bonsai:{version}, ifcopenshell:{version}, importer:"bonsai",
 elements:{walls,slabs,spaces,doors,windows,other}, bounds:{min:[x,y,z],max:[x,y,z]},
 outputs:{blend,preview,glb,manifest}, hashes:{glbSha256,blendSha256,previewSha256,manifestSha256},
 timings:{importSeconds,renderSeconds,exportSeconds,totalSeconds}, peakMemoryMb}
```

`outputs` paths are relative to the job directory. `bounds` are Blender/IFC world metres,
Z up, over every imported mesh including spaces. `peakMemoryMb` is the peak resident size
of the larger Blender process.

`manifest.json`:

```text
{objects:[{glbNodeName, ifcGlobalId, kind, levelId?, roomId?, name}],
 levels:[{id, name, elevation, height}],
 collision:{walls:[{glbNodeName}], floors:[{glbNodeName}]}}
```

- `glbNodeName` is `ifc-<IfcGlobalId>`, so it is stable for the same input.
- `kind` is `wall`, `slab`, `space`, `door`, `window`, `storey` or `other`. Site and building empties are `other`.
- `levelId` is the GlobalId of the containing `IfcBuildingStorey`. A door or window in an opening takes its host wall's storey.
- `roomId` is set on space objects; space nodes are room volumes, which the viewer should hide and use for picking.
- `elevation` is the storey's world Z. `height` runs from the elevation to the highest point of the storey's meshes.
- Collision walls are the wall nodes; collision floors are the slab nodes. Doors are not collision geometry.

Manifest bytes are identical across runs and platforms for the same input. GLB bytes are
identical across runs on the same platform: objects are exported in GlobalId order, because
Bonsai creates them in thread-completion order.

### What makes it a real Bonsai import

The two phases run in separate Blender processes.

**Import phase.** Enables Bonsai and loads the IFC with `bpy.ops.bim.load_project`. The job
fails unless:

- Bonsai reports no `last_error`;
- an IfcBuildingStorey exists;
- the per-class counts of Bonsai-linked Blender objects equal the counts declared in the IFC file.

It then saves `model.blend`.

**Publish phase.** A fresh Blender opens `model.blend`. The phase requires the same IFC-linked
GlobalIds to be present, then renders and exports.

The supervisor then checks every output:

- each output file exists and is non-empty;
- the manifest has no duplicate node names;
- every manifest node is present in the GLB's node list;
- collision entries reference manifest nodes;
- the report came from the publish phase with `importer: "bonsai"`.

Reopening happens in a fresh process because an in-session `wm.open_mainfile` after a Bonsai
import segfaulted intermittently on Linux, while plain Blender reopened files reliably. Bonsai's
headless window setup is also switched off (`should_setup_workspace`, `should_setup_toolbar`).
In background mode it appends a BIM workspace on every load, and that crashed Blender on Linux.

## Process control

- Each Blender phase runs as a child in its own process group with stdin closed.
- Both phases share one deadline: `deadlineSeconds` minus a 7-second margin. The supervisor therefore finishes, and writes a failed verification, before a caller that SIGKILLs at `deadlineSeconds`.
- On timeout, on SIGTERM or SIGINT, and after every normal exit, the supervisor sends SIGTERM to the whole Blender group, waits up to 5 s, sends SIGKILL to whatever remains, and reaps.
- On Linux each Blender child also has `PR_SET_PDEATHSIG=SIGKILL`, so a SIGKILLed supervisor does not leave Blender running.
- Callers should cancel with SIGTERM to the worker, then SIGKILL after about 10 s.

## Running under systemd

The research service can run `bin/architecture-worker` directly. In that case the job shares
the research service's cgroup and has no CPU or memory cap of its own. For the production
slice, point the service at the unit launcher instead; it takes the same arguments:

```bash
/opt/acres-architecture-worker/current/bin/architecture-worker-unit --job <jobDir>
```

It starts `acres-architecture-worker@<systemd-escaped jobDir>.service`, waits for it, and
stops the unit if it receives SIGTERM. The research deploy (`infra/acres-deploy-research`)
installs the template whenever `/opt/acres-architecture-worker` exists, with a drop-in
(`acres-architecture-worker@.service.d/user.conf`) that sets `User` and `Group` to the user
`acres-research` runs as (`acres-runtime` on the VM). It also installs the polkit rule
`infra/acres-architecture-worker.rules` as `/etc/polkit-1/rules.d/50-acres-architecture-worker.rules`,
with `RESEARCH_USER` replaced by that user, so the research service may start and stop only
these units.

The unit, the rule and the research service must name the same user. That user creates the job
directory (mode 700) and starts the unit, and the unit must read and write that directory. On
2026-10-21 research moved to `acres-runtime` while the rule and the unit still named `openclaw`:
every job then failed with `Interactive authentication required` before Blender started. A job
that ends without a verification report now fails with the launcher's last output lines as its
reason.

The unit runs as the research service's user with:

- `ProtectSystem=strict`, so the release and system are read-only;
- `ProtectHome=tmpfs` plus `BindPaths` of the job directory only;
- `input/` and `job.json` read-only;
- `PrivateNetwork` (loopback only), `PrivateDevices`, `PrivateTmp` and `NoNewPrivileges`;
- an empty capability set and no environment file, so no credentials;
- `CPUQuota=200%`, `MemoryMax=4G`, `MemorySwapMax=0` and `TasksMax=128`;
- `TimeoutStartSec=330` as a backstop to the job deadline;
- `KillMode=mixed`, so stopping the unit sends SIGTERM to the supervisor first and then kills the rest of the cgroup.

Blender itself is limited to two render threads.

### Read-only release

Under the unit the release is a read-only mount, and every job starts with an empty HOME.
Bonsai re-applies execute bits to its bundled `pyradiance` binaries every time it registers.
A read-only mount rejects even a `chmod` that changes nothing, so the job script skips those
no-op calls while Bonsai registers; the install-time smoke job already set the bits. Without
this, Bonsai fails to register, and Blender then tries to remove all of Bonsai's wheels from
the release.

`chmod -R a-w` does not reproduce these conditions, because a file's owner can still `chmod`
it. After installing, check a release under them with real Blender. The test bind-mounts the
release read-only in a private mount namespace (unprivileged user namespaces, or root):

```bash
ACRES_WORKER_RELEASE=/opt/acres-architecture-worker/current python3 -m unittest worker/tests/test_readonly_release.py
```

## Presentation dressing

The publish phase dresses the imported building before the preview and the GLB (`worker/dressing.py`).
It moves or adds no building geometry; the manifest, collision and counts stay those of the IFC.

- Materials by IFC class: exterior wall faces (`Pset_WallCommon.IsExternal`, faces looking out of
  every room) in facade brick and the rest in plaster, slabs in dark concrete, doors in oak, windows in
  tinted glass, stairs in concrete.
- Each room (`IfcSpace`) becomes clear, so the dollhouse shows inside it, and gets a floor finish: its
  own floor faces lifted a centimetre, oak in living rooms, bedrooms and halls, tile in baths, concrete
  elsewhere.
- Rooms that fill at least 85 percent of their smallest rectangle get simple furniture by kind (sofa,
  rug, table and kitchen run in living rooms, bed and nightstands in bedrooms, vanity and tub in baths),
  backed against the long wall away from the room's windows.

Finishes and furniture are separate meshes parented to their room, so the browser hides them with
their storey and highlights them with their room. The preview renders with a physical sky, a sun and
a ground plane (not exported), 64 samples on the GPU host and 16 on a CPU, denoised.

The presentation stills (`render_job.py`) use the same sky, brick with stone floor bands on residential
storeys, framed reflective glass, and an asphalt roadway between sidewalks along the street front.

## GPU render host

Renders and previews run on `acres-render-gpu` when the research service points
`ACRES_ARCHITECTURE_WORKER` at `bin/architecture-worker-gpu`. That host is a Compute Engine VM in
`hyatus-openclaw`, `us-central1-a`, network `openclaw`: n1-standard-4 with one NVIDIA T4, 100 GB
balanced disk, Ubuntu 22.04 with the NVIDIA 580 server driver (the prebuilt module for the GCP kernel), no service account, an ephemeral
external address for package and Blender downloads only, and the network tag `acres-render-gpu`.
Firewall rule `acres-render-gpu-ssh` admits SSH only from the research host (10.42.0.2) and IAP.

`worker/remote_worker.py` (run as the research user) starts the host when it is stopped, sends
`job.json` and `input/` over SSH as the research host's OS Login user, runs the job there through `acres-gpu-job` in the same
`acres-architecture-worker@.service` sandbox as here, and copies `output/` back. On that host the
unit's `gpu.conf` drop-in (`infra/acres-architecture-worker-gpu.conf`) opens the NVIDIA devices
only, sets `ACRES_CYCLES_DEVICE=OPTIX` and allows 4 vCPUs and 12 GB; Cycles then renders on the
GPU, and `blender.log` says `cycles device: OPTIX`. When the host does not answer within 150
seconds the job runs on this host's CPU unit instead. The research host's service account holds
`roles/compute.instanceAdmin.v1` and `roles/compute.osAdminLogin` on that one instance only, and
plain `ssh` uses a key on that account's OS Login profile, so no project-wide permission is needed.
Create the key once as the research user (it lives in `/var/lib/acres-runtime/.ssh`):

```bash
sudo -u acres-runtime env HOME=/var/lib/acres-runtime ssh-keygen -q -t ed25519 -N "" -f /var/lib/acres-runtime/.ssh/acres-render-gpu
sudo -u acres-runtime env HOME=/var/lib/acres-runtime gcloud compute os-login ssh-keys add \
  --key-file=/var/lib/acres-runtime/.ssh/acres-render-gpu.pub
```

If the host is recreated, remove its old entry from `/var/lib/acres-runtime/.ssh/known_hosts`.

The host powers itself off when it has been up 15 minutes and no job has run for 15 minutes
(`acres-render-gpu-idle.timer`), so it bills only while rendering: about $0.54 an hour on demand.

Set it up, or update its worker after a change here, from an export of `main`:

```bash
gcloud compute ssh acres-render-gpu --project hyatus-openclaw --zone us-central1-a --tunnel-through-iap \
  --command 'sudo bash /var/tmp/acres/infra/acres-render-gpu-setup /var/tmp/acres'
```

after copying the export to `/var/tmp/acres` there. It installs the driver and the worker, then
renders the smoke scene on the GPU.

## Measured resource use

The fixture job (four walls, one slab, one space, one door, 320 × 240 preview) is the only
model measured so far:

| Run | Import | Render | Export | Total | Peak memory |
|---|---|---|---|---|---|
| macOS arm64, native, Apple silicon | 0.4 s | 0.3 s | 0.05 s | 9.2 s | 434 MB |
| Linux x64 under qemu emulation, 2 CPUs, 4 GiB cap | 1.5–2.0 s | 6.7–7.9 s | 0.2–0.9 s | 35–42 s | 690–710 MB |

A 480 × 320 preview took 14 s to render under the same emulation. Most of the total is
starting Blender and loading Bonsai twice. The Linux figures come from
instruction emulation on an arm64 Mac and should be well above what native x64 does on the
VM. Measure the first real jobs on the VM before raising concurrency or the preview size.

## Rollback

Every release stays under `releases/` until removed. To roll back, point `current` at the
previous one. Running jobs keep the release they started with, because the wrappers resolve
their own directory.

```bash
ls /opt/acres-architecture-worker/releases
```

```bash
ln -sfn releases/<previous-release-id> /opt/acres-architecture-worker/current.new && mv -T /opt/acres-architecture-worker/current.new /opt/acres-architecture-worker/current
```

Remove a release only when it is neither `current` nor the rollback target.

## Upgrading Blender or Bonsai

Change the version, file names and SHA-256 values together in `install.sh` and
`worker/VERSIONS.md`, then run the installer. A Bonsai build must target the Python ABI
that the chosen Blender bundles. The installer's health check fails the release otherwise,
and `current` is not switched.
