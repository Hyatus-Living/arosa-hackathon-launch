"""Stand-in for the Blender binary in supervisor tests.

Invoked exactly like Blender (`--background ... [model.blend] --python blender_job.py -- <jobDir> <phase>`).
Its behaviour comes from <jobDir>/fake-mode so the supervisor's scrubbed
environment is exercised unchanged.
"""

import json
import os
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

job_dir = Path(sys.argv[sys.argv.index("--") + 1])
phase = sys.argv[-1]
mode = (job_dir / "fake-mode").read_text().strip()
out = job_dir / "output"
(job_dir / f"fake-ran-{phase}").write_text(json.dumps({"argv": sys.argv[1:], "env": dict(os.environ)}))


def writable(path):
    try:
        with open(path, "a"):
            return True
    except OSError:
        return False


# Optional sandbox probe (used by the systemd unit check): which paths can the job see or write?
if (job_dir / "probe-paths.json").exists():
    paths = json.loads((job_dir / "probe-paths.json").read_text())
    (job_dir / "output" / "probe.json").write_text(json.dumps(
        {path: {"exists": os.path.exists(path), "writable": writable(path)} for path in paths}))


def spawn_sleeper():
    # Same process group as this fake Blender: the supervisor must reap it.
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    (job_dir / "pids").write_text(f"{os.getpid()} {child.pid}")


def glb(node_names):
    gltf = json.dumps({"asset": {"version": "2.0"}, "nodes": [{"name": n} for n in node_names]}).encode()
    gltf += b" " * (-len(gltf) % 4)
    return b"glTF" + struct.pack("<II", 2, 20 + len(gltf)) + struct.pack("<I", len(gltf)) + b"JSON" + gltf


def write_outputs(manifest, glb_nodes=None):
    if phase == "import":
        (out / "model.blend").write_bytes(b"BLENDER-fake")
        (out / "blender-report.json").write_text(json.dumps({"phase": "imported"}))
        return
    names = [o["glbNodeName"] for o in manifest["objects"]]
    (out / "preview.png").write_bytes(b"\x89PNG-fake")
    (out / "model.glb").write_bytes(glb(names if glb_nodes is None else glb_nodes))
    (out / "manifest.json").write_text(json.dumps(manifest))
    (out / "blender-report.json").write_text(json.dumps({
        "phase": "published",
        "blender": {"version": "4.5.14", "python": "3.11.13"},
        "bonsai": {"version": "0.9.0-post1"},
        "ifcopenshell": {"version": "0.9.0"},
        "importer": "bonsai",
        "elements": {"walls": 4, "slabs": 1, "spaces": 1, "doors": 1, "windows": 0, "other": 0},
        "bounds": {"min": [0, 0, 0], "max": [6, 4, 3]},
        "timings": {"importSeconds": 0.1, "renderSeconds": 0.2, "exportSeconds": 0.1},
    }))


GOOD_MANIFEST = {
    "objects": [
        {"glbNodeName": "ifc-wall-a", "ifcGlobalId": "wall-a", "kind": "wall", "levelId": "storey", "name": "Wall A"},
        {"glbNodeName": "ifc-slab-a", "ifcGlobalId": "slab-a", "kind": "slab", "levelId": "storey", "name": "Slab"},
    ],
    "levels": [{"id": "storey", "name": "Ground", "elevation": 0.0, "height": 3.0}],
    "collision": {"walls": [{"glbNodeName": "ifc-wall-a"}], "floors": [{"glbNodeName": "ifc-slab-a"}]},
}

def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def png(width, height):
    # Like Cycles: the pixels are fixed, the render time text chunk is not.
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"tEXt", b"cycles.ViewLayer.render_time\x00" + str(time.monotonic_ns()).encode())
            + chunk(b"IDAT", zlib.compress(b"fake-pixels")) + chunk(b"IEND", b""))


def write_render(width_offset=0):
    render = json.loads((job_dir / "job.json").read_text())["settings"]["render"]
    for name in ("street.png", "aerial.png"):
        (out / name).write_bytes(png(render["width"] + width_offset, render["height"]))
    (out / "blender-report.json").write_text(json.dumps({
        "phase": "rendered", "blender": {"version": "4.5.14", "python": "3.11.13"},
        "scene": {"volumes": 6, "context": 12},
        "cameras": {"street": {"location": [30, 20, 1.7], "lens": 24}, "aerial": {"location": [40, 50, 60], "lens": 30}},
        "timings": {"streetSeconds": 0.1, "aerialSeconds": 0.1, "blenderSeconds": 0.3},
    }))


if mode == "ok":
    write_outputs(GOOD_MANIFEST)
elif mode == "render-ok":
    write_render()
elif mode == "render-wrong-size":
    write_render(width_offset=1)
elif mode == "ok-with-straggler":
    spawn_sleeper()
    write_outputs(GOOD_MANIFEST)
elif mode == "duplicate-node":
    bad = json.loads(json.dumps(GOOD_MANIFEST))
    bad["objects"][1]["glbNodeName"] = "ifc-wall-a"
    write_outputs(bad)
elif mode == "dangling-collision":
    bad = json.loads(json.dumps(GOOD_MANIFEST))
    bad["collision"]["floors"] = [{"glbNodeName": "ifc-missing"}]
    write_outputs(bad)
elif mode == "glb-missing-node":
    write_outputs(GOOD_MANIFEST, glb_nodes=["ifc-wall-a"])
elif mode == "missing-glb":
    write_outputs(GOOD_MANIFEST)
    if phase == "publish":
        (out / "model.glb").unlink()
elif mode == "no-blend":
    pass
elif mode == "crash":
    print("Error: fake importer exploded", file=sys.stderr)
    sys.exit(3)
elif mode == "sleep":
    spawn_sleeper()
    time.sleep(120)
else:
    raise SystemExit(f"unknown fake mode {mode}")
