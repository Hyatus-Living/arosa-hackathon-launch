"""Blender-side half of the architecture worker; runs inside `blender --background`.

architecture_worker.py runs it twice, each time in a fresh Blender process:

  blender ... --python blender_job.py -- <jobDir> import
      Imports input/model.ifc through Bonsai's own project loader, checks the imported
      spatial hierarchy against the IFC file and saves output/model.blend.
  blender ... output/model.blend --python blender_job.py -- <jobDir> publish
      Reopens that .blend, checks every IFC-linked object survived, dresses it for
      presentation (dressing.py: materials, floor finishes, furniture), renders a
      preview, exports a GLB whose node names derive from IFC GlobalIds and writes the
      companion manifest.

Both phases record their results in output/blender-report.json for the supervisor.
Coordinates are Blender/IFC metres, Z up; the GLB itself is glTF Y up.
"""

import faulthandler
import importlib.metadata
import json
import math
import os
import stat
import sys
import time
from pathlib import Path

import addon_utils
import bpy
from mathutils import Vector

BONSAI_ADDON = "bl_ext.user_default.bonsai"
PREVIEW_SAMPLES = {"GPU": 64, "CPU": 16}
COUNTED = {"walls": "IfcWall", "slabs": "IfcSlab", "spaces": "IfcSpace", "doors": "IfcDoor", "windows": "IfcWindow"}
KINDS = {"IfcWall": "wall", "IfcSlab": "slab", "IfcSpace": "space", "IfcDoor": "door", "IfcWindow": "window",
         "IfcBuildingStorey": "storey"}

faulthandler.enable()  # Python traceback in blender.log if Blender crashes natively

job_dir = Path(sys.argv[sys.argv.index("--") + 1])
phase = sys.argv[sys.argv.index("--") + 2]
out = job_dir / "output"
report_path = out / "blender-report.json"
job = json.loads((job_dir / "job.json").read_text())

def enable_bonsai():
    """Enable Bonsai from the read-only release (ProtectSystem=strict under the systemd unit).

    Bonsai re-applies execute bits to its bundled binaries (pyradiance) on every registration.
    The install-time smoke job already set them, but on a read-only mount even a chmod that
    changes nothing fails with EROFS, so such calls are skipped while Bonsai registers.
    """
    chmod = os.chmod

    def chmod_if_changed(path, mode, **kwargs):
        if stat.S_IMODE(os.stat(path).st_mode) != stat.S_IMODE(mode):
            chmod(path, mode, **kwargs)

    os.chmod = chmod_if_changed
    try:
        module = addon_utils.enable(BONSAI_ADDON, default_set=True)
    finally:
        os.chmod = chmod
    if module is None:
        raise RuntimeError("Bonsai failed to enable; see the traceback above")


enable_bonsai()
# Headless: skip Bonsai's window setup. It appends a BIM workspace on every load_post,
# which has no window in background mode and crashed Blender on Linux.
bonsai_preferences = bpy.context.preferences.addons[BONSAI_ADDON].preferences
bonsai_preferences.should_setup_workspace = False
bonsai_preferences.should_setup_toolbar = False
import bonsai  # noqa: E402  (importable only once the extension is enabled)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dressing  # noqa: E402
import bonsai.tool as tool  # noqa: E402
import ifcopenshell  # noqa: E402
import ifcopenshell.util.element  # noqa: E402


def step(name):
    print(f"acres-worker: {name}", flush=True)


def kind_of(entity):
    return next((kind for ifc_class, kind in KINDS.items() if entity.is_a(ifc_class)), "other")


def imported_objects():
    """Blender objects Bonsai linked to an IFC product, excluding opening voids."""
    pairs = []
    for obj in bpy.data.objects:
        entity = tool.Ifc.get_entity(obj)
        if entity and entity.is_a("IfcProduct") and not entity.is_a("IfcFeatureElement"):
            pairs.append((obj, entity))
    return sorted(pairs, key=lambda pair: pair[1].GlobalId)


def counts(entities):
    result = {key: sum(1 for e in entities if e.is_a(ifc_class)) for key, ifc_class in COUNTED.items()}
    result["other"] = sum(1 for e in entities if e.is_a("IfcElement") and kind_of(e) == "other"
                          and not e.is_a("IfcFeatureElement"))
    return result


def storey_of(entity):
    while entity and not entity.is_a("IfcBuildingStorey"):
        if getattr(entity, "FillsVoids", None):
            entity = entity.FillsVoids[0].RelatingOpeningElement.VoidsElements[0].RelatingBuildingElement
        else:
            entity = ifcopenshell.util.element.get_container(entity) or ifcopenshell.util.element.get_aggregate(entity)
    return entity


def world_corners(obj):
    return [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]


def bounds_of(objects):
    corners = [c for obj in objects for c in world_corners(obj)]
    return ([round(min(c[i] for c in corners), 4) + 0.0 for i in range(3)],
            [round(max(c[i] for c in corners), 4) + 0.0 for i in range(3)])


def import_phase():
    """Bonsai's project loader (bim.load_project), not a generic mesh importer."""
    step("import")
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    started = time.monotonic()
    result = bpy.ops.bim.load_project(filepath=str(job_dir / "input" / "model.ifc"), should_start_fresh_session=False,
                                      skip_autosave_recovery=True, skip_recent=True)
    if result != {"FINISHED"} or getattr(bonsai, "last_error", None):
        raise RuntimeError(f"Bonsai load_project returned {result}: {getattr(bonsai, 'last_error', '')}")
    model = tool.Ifc.get()
    if model is None:
        raise RuntimeError("Bonsai did not load an IFC model")
    if not model.by_type("IfcBuildingStorey"):
        raise RuntimeError("IFC model has no IfcBuildingStorey")
    imported = imported_objects()
    elements = counts([entity for _obj, entity in imported])
    expected = counts(model.by_type("IfcProduct"))
    if elements != expected:
        raise RuntimeError(f"Bonsai imported {elements}, the IFC file declares {expected}")
    import_seconds = time.monotonic() - started

    step("save")
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "model.blend"))
    report_path.write_text(json.dumps({
        "phase": "imported",
        "blender": {"version": bpy.app.version_string, "python": sys.version.split()[0]},
        "bonsai": {"version": importlib.metadata.version("bonsai")},
        "ifcopenshell": {"version": ifcopenshell.version},
        "importer": "bonsai",
        "elements": elements,
        "globalIds": [entity.GlobalId for _obj, entity in imported],
        "timings": {"importSeconds": round(import_seconds, 3)},
    }))



def cycles_device(scene):
    """Cycles on the host's GPU where the worker names one (ACRES_CYCLES_DEVICE: OPTIX or CUDA), else the CPU.
    A named device that Blender cannot find fails the job rather than render slowly on the CPU."""
    kind = os.environ.get("ACRES_CYCLES_DEVICE")
    if not kind:
        scene.cycles.device = "CPU"
        return
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = kind
    prefs.get_devices()
    if not any(d.type == kind for d in prefs.devices):
        raise RuntimeError(f"Cycles found no {kind} device on this host.")
    for d in prefs.devices:
        d.use = d.type == kind
    scene.cycles.device = "GPU"
    print(f"cycles device: {kind} {', '.join(d.name for d in prefs.devices if d.use)}", flush=True)

def render_preview(reopened):
    """Small preview with Cycles, on the GPU render host's GPU or this host's CPU (no display either way)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cycles_device(scene)
    scene.cycles.samples = PREVIEW_SAMPLES[scene.cycles.device]
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.view_settings.view_transform = "AgX"
    scene.render.resolution_x = job["settings"]["preview"]["width"]
    scene.render.resolution_y = job["settings"]["preview"]["height"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(out / "preview.png")
    dressing.sky(scene)
    for obj, entity in reopened:
        obj.hide_render = entity.is_a("IfcSpace")
    low, high = bounds_of([obj for obj, entity in reopened if obj.type == "MESH" and not entity.is_a("IfcSpace")])
    center = (Vector(low) + Vector(high)) / 2
    size = (Vector(high) - Vector(low)).length
    # Ground under the building for the preview only; the GLB exports the selected building alone.
    bpy.ops.mesh.primitive_plane_add(size=size * 60, location=(center.x, center.y, low[2] - 0.02))
    bpy.context.active_object.data.materials.append(dressing.material("concrete"))
    camera = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    camera.data.clip_end = size * 20
    camera.location = center + Vector((1.1, -1.65, 0.62)) * size * 1.25
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    sun = bpy.data.objects.new("PreviewSun", bpy.data.lights.new("PreviewSun", "SUN"))
    sun.data.energy = 2.8
    sun.data.angle = math.radians(1.0)
    sun.rotation_euler = (math.radians(50), 0, math.radians(200))
    for helper in (camera, sun):
        scene.collection.objects.link(helper)
    scene.camera = camera
    bpy.ops.render.render(write_still=True)


def build_manifest(reopened):
    levels = {}
    objects = []
    for obj, entity in reopened:
        kind = kind_of(entity)
        record = {"glbNodeName": obj.name, "ifcGlobalId": entity.GlobalId, "kind": kind, "name": entity.Name or ""}
        storey = entity if kind == "storey" else storey_of(entity)
        if storey:
            record["levelId"] = storey.GlobalId
            levels.setdefault(storey.GlobalId, {"storey": storey, "tops": []})
            if obj.type == "MESH":
                levels[storey.GlobalId]["tops"].append(max(c.z for c in world_corners(obj)))
        if kind == "space":
            record["roomId"] = entity.GlobalId
        objects.append(record)

    storey_objects = {entity.GlobalId: obj for obj, entity in reopened if entity.is_a("IfcBuildingStorey")}
    manifest_levels = []
    for level_id, level in sorted(levels.items(), key=lambda item: storey_objects[item[0]].matrix_world.translation.z):
        elevation = storey_objects[level_id].matrix_world.translation.z
        manifest_levels.append({
            "id": level_id, "name": level["storey"].Name or "", "elevation": round(elevation, 4) + 0.0,
            "height": round(max(level["tops"], default=elevation) - elevation, 4) + 0.0,
        })
    return {
        "objects": objects,
        "levels": manifest_levels,
        "collision": {
            "walls": [{"glbNodeName": o["glbNodeName"]} for o in objects if o["kind"] == "wall"],
            "floors": [{"glbNodeName": o["glbNodeName"]} for o in objects if o["kind"] == "slab"],
        },
    }


def publish_phase():
    """Runs in a fresh Blender that opened output/model.blend at startup."""
    step("reopen")
    report = json.loads(report_path.read_text())
    reopened = imported_objects()
    if [entity.GlobalId for _obj, entity in reopened] != report["globalIds"]:
        raise RuntimeError("reopened .blend lost IFC-linked objects")
    low, high = bounds_of([obj for obj, _entity in reopened if obj.type == "MESH"])

    step("dress")
    dressed = dressing.dress(reopened, storey_of, bpy.context.scene.collection)

    step("render")
    started = time.monotonic()
    render_preview(reopened)
    render_seconds = time.monotonic() - started

    step("export")
    started = time.monotonic()
    for obj, entity in reopened:
        obj.name = f"ifc-{entity.GlobalId}"
    manifest = build_manifest(reopened)
    # One export collection in GlobalId order: Bonsai creates objects in thread-completion
    # order, which would otherwise reorder GLB nodes between runs of the same input.
    export = bpy.data.collections.new("AcresExport")
    bpy.context.scene.collection.children.link(export)
    bpy.ops.object.select_all(action="DESELECT")
    for obj, _entity in reopened:
        for collection in obj.users_collection:
            collection.objects.unlink(obj)
        export.objects.link(obj)
        # Bonsai hides spatial empties and spaces in the viewport; the exporter skips hidden objects.
        obj.hide_viewport = False
        obj.select_set(True)
    # Floor finishes and furniture follow, each parented to its room.
    for obj in dressed:
        for collection in obj.users_collection:
            collection.objects.unlink(obj)
        export.objects.link(obj)
        obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(out / "model.glb"), export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_cameras=False, export_lights=False,
                              export_extras=False)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    export_seconds = time.monotonic() - started

    del report["globalIds"]
    report.update(phase="published", bounds={"min": low, "max": high})
    report["timings"].update(renderSeconds=round(render_seconds, 3), exportSeconds=round(export_seconds, 3))
    report_path.write_text(json.dumps(report))


{"import": import_phase, "publish": publish_phase}[phase]()
