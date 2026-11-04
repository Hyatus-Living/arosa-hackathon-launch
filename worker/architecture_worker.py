#!/usr/bin/env python3
"""Run one Acres architecture job: IFC -> Bonsai import -> .blend, preview, GLB, manifest.

Usage: architecture_worker.py --job <jobDir>

Reads <jobDir>/job.json and <jobDir>/input/model.ifc, writes <jobDir>/output/*.
Blender runs twice in background mode (blender_job.py import, then publish from the
saved .blend in a fresh process), each time as a child in its own process group; the whole
group is killed when the job deadline (less a cleanup margin) passes, on SIGTERM/SIGINT
and after Blender exits. On Linux, Blender also dies if this supervisor is SIGKILLed.
Exit status 0 means output/verification.json has status "succeeded".

Environment (set by the installed bin/architecture-worker wrapper):
  ACRES_BLENDER                  Blender executable
  ACRES_BLENDER_USER_RESOURCES   Blender user resources holding the Bonsai extension
"""

import argparse
import ctypes
import hashlib
import json
import os
import resource
import signal
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BLENDER_JOB = HERE / "blender_job.py"
RENDER_JOB = HERE / "render_job.py"
OUTPUTS = {"blend": "model.blend", "preview": "preview.png", "glb": "model.glb", "manifest": "manifest.json"}
# A render job (kind "render") builds input/scene.json in one Blender, without Bonsai, and
# renders these stills; verification hashes are keyed by the service's artifact kinds.
RENDER_OUTPUTS = {"render-street": "street.png", "render-aerial": "aerial.png"}
RENDER_SIDE = (320, 2048)
RENDER_SAMPLES = (1, 64)
REPORT = "blender-report.json"
LOG = "blender.log"
BLENDER_THREADS = 2
KILL_GRACE_SECONDS = 5
# Finish this long before deadlineSeconds: the caller SIGKILLs our process group then.
DEADLINE_MARGIN_SECONDS = KILL_GRACE_SECONDS + 2
PR_SET_PDEATHSIG = 1
MAX_PREVIEW_SIDE = 2048
OBJECT_KINDS = {"wall", "slab", "space", "door", "window", "storey", "other"}


class JobFailure(Exception):
    pass


def on_signal(signum, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise JobFailure(f"cancelled by {signal.Signals(signum).name}")


def inside(job_dir, path):
    resolved = path.resolve()
    if not resolved.is_relative_to(job_dir):
        raise JobFailure(f"{path.relative_to(job_dir)} resolves outside the job directory")
    return resolved


def read_job(job_dir):
    job = json.loads(inside(job_dir, job_dir / "job.json").read_text())
    for key in ("jobId", "projectId"):
        if not isinstance(job.get(key), str) or not job[key]:
            raise JobFailure(f"job.json {key} must be a non-empty string")
    if not isinstance(job.get("revision"), (int, str)):
        raise JobFailure("job.json revision must be an integer or string")
    if job.get("kind", "model") == "render":
        render = job["settings"]["render"]
        for key, (low, high) in (("width", RENDER_SIDE), ("height", RENDER_SIDE), ("samples", RENDER_SAMPLES)):
            if not isinstance(render.get(key), int) or not low <= render[key] <= high:
                raise JobFailure(f"job.json settings.render.{key} must be an integer from {low} to {high}")
    else:
        preview = job["settings"]["preview"]
        for side in ("width", "height"):
            if not isinstance(preview.get(side), int) or not 16 <= preview[side] <= MAX_PREVIEW_SIDE:
                raise JobFailure(f"job.json settings.preview.{side} must be an integer from 16 to {MAX_PREVIEW_SIDE}")
    if not isinstance(job.get("deadlineSeconds"), (int, float)) or job["deadlineSeconds"] <= 0:
        raise JobFailure("job.json deadlineSeconds must be a positive number")
    return job


def kill_group(proc):
    """Terminate every process in the child's group, then reap the child."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    end = time.monotonic() + KILL_GRACE_SECONDS
    while time.monotonic() < end:
        proc.poll()
        try:
            os.killpg(proc.pid, 0)
        except (ProcessLookupError, PermissionError):
            # macOS answers EPERM when only unreaped zombies remain in the group.
            return
        time.sleep(0.05)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def die_with_parent(parent_pid):
    """Linux: SIGKILL Blender if this supervisor is SIGKILLed, since Blender has its own group."""
    ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
    if os.getppid() != parent_pid:
        os._exit(1)


def run_blender(job_dir, out_dir, phase, deadline_at, blend=None, script=BLENDER_JOB):
    """Run one Blender script phase in a fresh background Blender, in its own process group."""
    seconds_left = deadline_at - time.monotonic()
    if seconds_left <= 0:
        raise JobFailure(f"deadline exceeded before the {phase} phase")
    tmp = job_dir / "tmp"
    (tmp / "home").mkdir(parents=True, exist_ok=True)
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp / "home"),
        "TMPDIR": str(tmp),
        "LANG": "C.UTF-8",
        "BLENDER_USER_RESOURCES": os.environ["ACRES_BLENDER_USER_RESOURCES"],
    }
    # The GPU render host's unit names its Cycles device (OPTIX or CUDA); everywhere else Cycles uses the CPU.
    if os.environ.get("ACRES_CYCLES_DEVICE"):
        env["ACRES_CYCLES_DEVICE"] = os.environ["ACRES_CYCLES_DEVICE"]
    cmd = [
        os.environ["ACRES_BLENDER"], "--background", "--factory-startup", "--offline-mode",
        "-noaudio", "--threads", str(BLENDER_THREADS), "--python-exit-code", "1",
        *([str(blend)] if blend else []), "--python", str(script), "--", str(job_dir), phase,
    ]
    log_path = out_dir / LOG
    with open(log_path, "ab") as log:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=job_dir,
            start_new_session=True,
            preexec_fn=(lambda parent=os.getpid(): die_with_parent(parent)) if sys.platform == "linux" else None)
    try:
        code = proc.wait(timeout=seconds_left)
    except subprocess.TimeoutExpired:
        raise JobFailure(f"deadline exceeded during the {phase} phase; Blender process group killed")
    finally:
        kill_group(proc)
    if code != 0:
        tail = log_path.read_text(errors="replace").strip().splitlines()[-15:]
        raise JobFailure(f"Blender {phase} phase exited with exit code {code}: " + " | ".join(tail))


def glb_node_names(path):
    data = path.read_bytes()
    magic, version, _length, json_length, chunk_type = struct.unpack_from("<4sIII4s", data)
    if magic != b"glTF" or version != 2 or chunk_type != b"JSON":
        raise JobFailure("output/model.glb is not a glTF 2.0 binary")
    gltf = json.loads(data[20:20 + json_length])
    return {node.get("name") for node in gltf.get("nodes", [])}


def check_manifest(manifest, glb_nodes):
    names = set()
    for obj in manifest["objects"]:
        missing = {"glbNodeName", "ifcGlobalId", "kind", "name"} - set(obj)
        if missing:
            raise JobFailure(f"manifest object missing {sorted(missing)}")
        if obj["kind"] not in OBJECT_KINDS:
            raise JobFailure(f"manifest object kind {obj['kind']!r} is not one of {sorted(OBJECT_KINDS)}")
        if obj["glbNodeName"] in names:
            raise JobFailure(f"manifest has duplicate glbNodeName {obj['glbNodeName']}")
        names.add(obj["glbNodeName"])
    missing_nodes = sorted(names - glb_nodes)
    if missing_nodes:
        raise JobFailure(f"manifest nodes missing from model.glb: {', '.join(missing_nodes)}")
    level_ids = {level["id"] for level in manifest["levels"]}
    for level in manifest["levels"]:
        missing = {"id", "name", "elevation", "height"} - set(level)
        if missing:
            raise JobFailure(f"manifest level missing {sorted(missing)}")
    for obj in manifest["objects"]:
        if "levelId" in obj and obj["levelId"] not in level_ids:
            raise JobFailure(f"manifest object {obj['glbNodeName']} references unknown level {obj['levelId']}")
    for group in ("walls", "floors"):
        for ref in manifest["collision"][group]:
            if ref["glbNodeName"] not in names:
                raise JobFailure(f"manifest collision.{group} references unknown node {ref['glbNodeName']}")


def peak_child_memory_mb():
    peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    # ru_maxrss is KiB on Linux and bytes on macOS.
    return round(peak / 1024 / (1024 if sys.platform == "darwin" else 1), 1)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strip_png_text(path):
    """Drop a still's text chunks. Cycles writes its render time into every PNG, so identical pixels
    would otherwise hash differently from run to run."""
    data = path.read_bytes()
    kept, pos = [data[:8]], 8
    while pos < len(data):
        length, = struct.unpack(">I", data[pos:pos + 4])
        end = pos + 12 + length
        if data[pos + 4:pos + 8] not in (b"tEXt", b"zTXt", b"iTXt"):
            kept.append(data[pos:end])
        pos = end
    path.write_bytes(b"".join(kept))


def png_size(path):
    data = path.read_bytes()[:24]
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise JobFailure(f"output/{path.name} is not a PNG")
    return struct.unpack(">II", data[16:24])


def run_render(job_dir, out_dir, job, started):
    """One Blender builds the scene and renders both stills; each must be a PNG of the requested size."""
    if not inside(job_dir, job_dir / "input" / "scene.json").is_file():
        raise JobFailure("input/scene.json is missing")
    for name in [*RENDER_OUTPUTS.values(), REPORT, LOG, "verification.json"]:
        inside(job_dir, out_dir / name).unlink(missing_ok=True)
    if job["deadlineSeconds"] <= DEADLINE_MARGIN_SECONDS:
        raise JobFailure(f"deadlineSeconds must exceed the {DEADLINE_MARGIN_SECONDS}s cleanup margin")
    run_blender(job_dir, out_dir, "render", started + job["deadlineSeconds"] - DEADLINE_MARGIN_SECONDS, script=RENDER_JOB)
    size = (job["settings"]["render"]["width"], job["settings"]["render"]["height"])
    for name in [*RENDER_OUTPUTS.values(), REPORT]:
        path = inside(job_dir, out_dir / name)
        if not path.is_file() or path.stat().st_size == 0:
            raise JobFailure(f"Blender did not write output/{name}")
    for name in RENDER_OUTPUTS.values():
        strip_png_text(out_dir / name)
        if png_size(out_dir / name) != size:
            raise JobFailure(f"output/{name} is not {size[0]} x {size[1]}")
    report = json.loads((out_dir / REPORT).read_text())
    (out_dir / REPORT).unlink()
    if report["phase"] != "rendered":
        raise JobFailure(f"Blender report stopped at phase {report['phase']}")
    return {
        "status": "succeeded",
        "kind": "render",
        "blender": report["blender"],
        "scene": report["scene"],
        "cameras": report["cameras"],
        "outputs": {kind: f"output/{name}" for kind, name in RENDER_OUTPUTS.items()},
        "hashes": {f"{kind}Sha256": sha256(out_dir / name) for kind, name in RENDER_OUTPUTS.items()},
        "timings": {**report["timings"], "totalSeconds": round(time.monotonic() - started, 3)},
        "peakMemoryMb": peak_child_memory_mb(),
    }


def run(job_dir, out_dir):
    started = time.monotonic()
    job = read_job(job_dir)
    if job.get("kind", "model") == "render":
        return run_render(job_dir, out_dir, job, started)
    if not inside(job_dir, job_dir / "input" / "model.ifc").is_file():
        raise JobFailure("input/model.ifc is missing")
    for name in [*OUTPUTS.values(), REPORT, LOG, "verification.json"]:
        inside(job_dir, out_dir / name).unlink(missing_ok=True)

    if job["deadlineSeconds"] <= DEADLINE_MARGIN_SECONDS:
        raise JobFailure(f"deadlineSeconds must exceed the {DEADLINE_MARGIN_SECONDS}s cleanup margin")
    deadline_at = started + job["deadlineSeconds"] - DEADLINE_MARGIN_SECONDS

    # Import and save in one Blender; reopen the saved .blend in a fresh one to publish.
    run_blender(job_dir, out_dir, "import", deadline_at)
    blend = inside(job_dir, out_dir / OUTPUTS["blend"])
    if not blend.is_file() or blend.stat().st_size == 0:
        raise JobFailure("Blender did not write output/model.blend")
    run_blender(job_dir, out_dir, "publish", deadline_at, blend=blend)

    for name in [*OUTPUTS.values(), REPORT]:
        path = inside(job_dir, out_dir / name)
        if not path.is_file() or path.stat().st_size == 0:
            raise JobFailure(f"Blender did not write output/{name}")
    check_manifest(json.loads((out_dir / OUTPUTS["manifest"]).read_text()), glb_node_names(out_dir / OUTPUTS["glb"]))
    report = json.loads((out_dir / REPORT).read_text())
    (out_dir / REPORT).unlink()
    if report["phase"] != "published":
        raise JobFailure(f"Blender report stopped at phase {report['phase']}")
    if report["importer"] != "bonsai":
        raise JobFailure(f"importer was {report['importer']}, not bonsai")
    return {
        "status": "succeeded",
        "blender": report["blender"],
        "bonsai": report["bonsai"],
        "ifcopenshell": report["ifcopenshell"],
        "importer": report["importer"],
        "elements": report["elements"],
        "bounds": report["bounds"],
        "outputs": {key: f"output/{name}" for key, name in OUTPUTS.items()},
        "hashes": {f"{key}Sha256": sha256(out_dir / name) for key, name in OUTPUTS.items()},
        "timings": {**report["timings"], "totalSeconds": round(time.monotonic() - started, 3)},
        "peakMemoryMb": peak_child_memory_mb(),
    }


def write_json(path, data):
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--job", required=True, type=Path)
    job_dir = parser.parse_args().job.resolve()
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    out_dir = job_dir / "output"
    try:
        out_dir.mkdir(exist_ok=True)
        out_dir = inside(job_dir, out_dir)
    except JobFailure as failure:
        print(f"architecture worker: {failure}", file=sys.stderr)
        return 2

    try:
        verification = run(job_dir, out_dir)
    except (JobFailure, KeyError, ValueError, OSError) as failure:
        reason = str(failure) if isinstance(failure, JobFailure) else f"{type(failure).__name__}: {failure}"
        write_json(out_dir / "verification.json", {"status": "failed", "reason": reason})
        print(f"architecture worker: {reason}", file=sys.stderr)
        return 1
    write_json(out_dir / "verification.json", verification)
    return 0


if __name__ == "__main__":
    sys.exit(main())
