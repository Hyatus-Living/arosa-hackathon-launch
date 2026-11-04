"""Presentation render of one scheme's massing; runs inside `blender --background --factory-startup`.

architecture_worker.py runs it once for a render job:

  blender ... --python render_job.py -- <jobDir>

It builds input/scene.json (acres.render.scene/1) from scratch: the scheme's massing with
simple facade materials by use, the neighbouring buildings as plain grey blocks, a ground
plane, a fixed New York afternoon sun and two cameras, then renders output/street.png and
output/aerial.png with Cycles on the CPU. The scene is in the concept frame (x along the
frontage, z into the lot, metres, the street at z = 0); Blender gets (x, -z, up), a proper
rotation, so the block is not mirrored. Results go to output/blender-report.json.

The same scene, settings and Blender build give the same pixels: no randomness except
Cycles' fixed seed, and objects are created in scene order.
"""

import faulthandler
import json
import math
import os
import sys
import time
from pathlib import Path

import bpy
from mathutils import Vector

faulthandler.enable()

job_dir = Path(sys.argv[sys.argv.index("--") + 1])
out = job_dir / "output"
job = json.loads((job_dir / "job.json").read_text())
scene_doc = json.loads((job_dir / "input" / "scene.json").read_text())
settings = job["settings"]["render"]

EYE_HEIGHT = 1.7
MIN_LENS_MM = 15
SENSOR_MM = 36
# Facade bays and window proportions per use: (bay width m, window u range, window v range).
WINDOWS = {"residential": (3.0, (0.18, 0.82), (0.28, 0.86)), "retail": (4.5, (0.04, 0.96), (0.06, 0.9))}
COLOURS = {"residential": (0.30, 0.12, 0.07), "brick": (0.36, 0.15, 0.09), "mortar": (0.40, 0.38, 0.35),
           "belt": (0.62, 0.58, 0.52), "retail": (0.16, 0.16, 0.17), "frame": (0.05, 0.05, 0.05),
           "roof": (0.5, 0.5, 0.49), "glass": (0.10, 0.13, 0.16),
           "context": (0.62, 0.61, 0.59), "ground": (0.42, 0.41, 0.40), "street": (0.16, 0.16, 0.17),
           "lot": (0.58, 0.57, 0.54)}
SIDEWALK = 3.5  # m of sidewalk either side of the roadway
FRAME = 0.09    # m of window frame inside each window opening


def step(name):
    print(f"acres-render: {name}", flush=True)


def to_blender(point, z=0.0):
    return Vector((point[0], -point[1], z))


def prism(name, footprint, base, height, origin_z=None):
    """A closed vertical prism over a footprint, with its origin at the floor when origin_z is set."""
    ring = [to_blender(p) for p in footprint]
    if sum(a.x * b.y - b.x * a.y for a, b in zip(ring, ring[1:] + ring[:1])) < 0:
        ring.reverse()
    n = len(ring)
    oz = base if origin_z is None else origin_z
    verts = [(v.x, v.y, base - oz) for v in ring] + [(v.x, v.y, base + height - oz) for v in ring]
    faces = [list(range(n - 1, -1, -1)), list(range(n, 2 * n))]
    faces += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = (0, 0, oz)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def merged_prisms(name, items):
    """Many prisms in one mesh (the neighbours), which renders faster than one object each."""
    verts, faces = [], []
    for footprint, base, height in items:
        ring = [to_blender(p) for p in footprint]
        if sum(a.x * b.y - b.x * a.y for a, b in zip(ring, ring[1:] + ring[:1])) < 0:
            ring.reverse()
        n, k = len(ring), len(verts)
        verts += [(v.x, v.y, base) for v in ring] + [(v.x, v.y, base + height) for v in ring]
        faces += [[k + i for i in range(n - 1, -1, -1)], [k + n + i for i in range(n)]]
        faces += [[k + i, k + (i + 1) % n, k + n + (i + 1) % n, k + n + i] for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def plain_material(name, colour, roughness):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*colour, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    return material


def facade_material(use, storey_height):
    """Wall colour by use with a window grid on vertical faces; roofs plain grey.

    Object coordinates have their origin at the storey's floor, so v = z / storey height runs
    0 to 1 up each storey; u runs along the facade in bays (x + y covers either facade direction).
    """
    bay, (u0, u1), (v0, v1) = WINDOWS[use]
    material = bpy.data.materials.new(f"Facade {use} {storey_height:.2f}")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    wall = nodes["Principled BSDF"]
    wall.inputs["Base Color"].default_value = (*COLOURS[use], 1)
    wall.inputs["Roughness"].default_value = 0.85
    glass = nodes.new("ShaderNodeBsdfPrincipled")
    glass.inputs["Base Color"].default_value = (*COLOURS["glass"], 1)
    glass.inputs["Roughness"].default_value = 0.02
    # Mostly reflection: the panes take the sky, pale at the top of the frame and darker below.
    glass.inputs["Metallic"].default_value = 0.6
    frame = nodes.new("ShaderNodeBsdfPrincipled")
    frame.inputs["Base Color"].default_value = (*COLOURS["frame"], 1)
    frame.inputs["Metallic"].default_value = 0.6
    frame.inputs["Roughness"].default_value = 0.35
    roof = nodes.new("ShaderNodeBsdfPrincipled")
    roof.inputs["Base Color"].default_value = (*COLOURS["roof"], 1)
    roof.inputs["Roughness"].default_value = 0.9
    coords = nodes.new("ShaderNodeTexCoord")
    xyz = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coords.outputs["Object"], xyz.inputs["Vector"])

    def math_node(operation, a, b=None):
        node = nodes.new("ShaderNodeMath")
        node.operation = operation
        for index, value in enumerate((a, b)):
            if value is None:
                continue
            if isinstance(value, (int, float)):
                node.inputs[index].default_value = value
            else:
                links.new(value, node.inputs[index])
        return node.outputs[0]

    def band(value, low, high):
        return math_node("MULTIPLY", math_node("GREATER_THAN", value, low), math_node("LESS_THAN", value, high))

    along = math_node("ADD", xyz.outputs["X"], xyz.outputs["Y"])
    u = math_node("FRACT", math_node("DIVIDE", along, bay))
    v = math_node("DIVIDE", xyz.outputs["Z"], storey_height)
    window = math_node("MULTIPLY", band(u, u0, u1), band(v, v0, v1))
    fu, fv = FRAME / bay, FRAME / storey_height
    pane = math_node("MULTIPLY", band(u, u0 + fu, u1 - fu), band(v, v0 + fv, v1 - fv))
    # Brick on residential walls, in metres along the facade and up it, and a stone band at each floor.
    if use == "residential":
        vector = nodes.new("ShaderNodeCombineXYZ")
        links.new(along, vector.inputs["X"])
        links.new(xyz.outputs["Z"], vector.inputs["Y"])
        brick = nodes.new("ShaderNodeTexBrick")
        links.new(vector.outputs["Vector"], brick.inputs["Vector"])
        brick.inputs["Color1"].default_value = (*COLOURS["residential"], 1)
        brick.inputs["Color2"].default_value = (*COLOURS["brick"], 1)
        brick.inputs["Mortar"].default_value = (*COLOURS["mortar"], 1)
        brick.inputs["Scale"].default_value = 1.0
        brick.inputs["Mortar Size"].default_value = 0.008
        brick.inputs["Brick Width"].default_value = 0.24
        brick.inputs["Row Height"].default_value = 0.075
        belt = nodes.new("ShaderNodeMix")
        belt.data_type = "RGBA"
        links.new(band(v, -1.0, 0.04), belt.inputs["Factor"])
        links.new(brick.outputs["Color"], belt.inputs["A"])
        belt.inputs["B"].default_value = (*COLOURS["belt"], 1)
        links.new(belt.outputs["Result"], wall.inputs["Base Color"])
    framed = nodes.new("ShaderNodeMixShader")
    links.new(pane, framed.inputs["Fac"])
    links.new(frame.outputs["BSDF"], framed.inputs[1])
    links.new(glass.outputs["BSDF"], framed.inputs[2])
    geometry = nodes.new("ShaderNodeNewGeometry")
    normal = nodes.new("ShaderNodeSeparateXYZ")
    links.new(geometry.outputs["Normal"], normal.inputs["Vector"])
    upward = math_node("GREATER_THAN", normal.outputs["Z"], 0.5)
    facade = nodes.new("ShaderNodeMixShader")
    links.new(window, facade.inputs["Fac"])
    links.new(wall.outputs["BSDF"], facade.inputs[1])
    links.new(framed.outputs["Shader"], facade.inputs[2])
    surface = nodes.new("ShaderNodeMixShader")
    links.new(upward, surface.inputs["Fac"])
    links.new(facade.outputs["Shader"], surface.inputs[1])
    links.new(roof.outputs["BSDF"], surface.inputs[2])
    links.new(surface.outputs["Shader"], nodes["Material Output"].inputs["Surface"])
    return material


def build_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    materials = {}
    massing = []
    for index, volume in enumerate(scene_doc["volumes"]):
        obj = prism(f"Volume {index + 1}", volume["footprint"], volume["base"], volume["height"], origin_z=volume["base"])
        key = (volume["use"], round(volume["height"], 2))
        if key not in materials:
            materials[key] = facade_material(volume["use"], volume["height"])
        obj.data.materials.append(materials[key])
        massing.append(obj)
    if scene_doc["context"]:
        context = merged_prisms("Neighbours", [(b["footprint"], b["base"], b["height"]) for b in scene_doc["context"]])
        context.data.materials.append(plain_material("Neighbours", COLOURS["context"], 0.9))
    lot = prism("Lot", scene_doc["lot"], -0.05, 0.1)
    lot.data.materials.append(plain_material("Lot", COLOURS["lot"], 0.95))
    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, -0.06))
    bpy.context.active_object.data.materials.append(plain_material("Ground", COLOURS["ground"], 0.95))
    # The roadway in front of the lot: the street lies at concept z from 0 to -width, which is Blender
    # y from 0 to width, with a sidewalk on each side.
    width = scene_doc["streetWidthMeters"]
    if width > 2 * SIDEWALK:
        road = (width - 2 * SIDEWALK) / 2
        bpy.ops.mesh.primitive_plane_add(size=1, location=(0, SIDEWALK + road, -0.055))
        street = bpy.context.active_object
        street.scale = (2000, 2 * road, 1)
        street.data.materials.append(plain_material("Street", COLOURS["street"], 0.9))
    return massing


def light_scene():
    """Sky fill plus a sun at the scene's azimuth (clockwise from north) and elevation."""
    scene = bpy.context.scene
    north = Vector((scene_doc["north"][0], -scene_doc["north"][1], 0)).normalized()
    east = Vector((north.y, -north.x, 0))
    azimuth, elevation = (math.radians(scene_doc["sun"][key]) for key in ("azimuthDeg", "elevationDeg"))
    to_sun = (north * math.cos(azimuth) + east * math.sin(azimuth)) * math.cos(elevation) + Vector((0, 0, math.sin(elevation)))
    # A physical sky, brightest toward the sun, without its own sun disc: the sun lamp casts the shadows.
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    sky = world.node_tree.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_disc = False
    sky.sun_elevation = elevation
    sky.sun_rotation = math.atan2(to_sun.x, to_sun.y) % (2 * math.pi)
    background = world.node_tree.nodes["Background"]
    background.inputs["Strength"].default_value = 0.3
    world.node_tree.links.new(sky.outputs["Color"], background.inputs["Color"])
    scene.world = world
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(1.0)
    sun.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(sun)


def corners(objects):
    return [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]


def fit(camera, points, aspect, margin=1.12, shift=True):
    """Set lens (and shift) so every point is in frame, given the camera's position and rotation."""
    inverse = camera.matrix_world.inverted()
    local = [inverse @ p for p in points]
    tx = [p.x / -p.z for p in local]
    ty = [p.y / -p.z for p in local]
    if shift:
        span = max(max(tx) - min(tx), (max(ty) - min(ty)) * aspect) * margin
        camera.data.shift_x = (max(tx) + min(tx)) / 2 / span
        camera.data.shift_y = (max(ty) + min(ty)) / 2 / span
    else:
        span = 2 * max(max(map(abs, tx)), max(map(abs, ty)) * aspect) * margin
    camera.data.lens = SENSOR_MM / span
    return camera.data.lens


def add_camera(name):
    camera = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.sensor_width = SENSOR_MM
    camera.data.clip_start = 0.5
    camera.data.clip_end = 5000
    bpy.context.scene.collection.objects.link(camera)
    return camera


def street_camera(points, aspect):
    """Level camera in the street, looking back obliquely at the frontage: verticals stay vertical
    (lens shift instead of tilt). It walks further along the street until the lens is no wider than
    MIN_LENS_MM."""
    low = Vector((min(p.x for p in points), min(p.y for p in points), 0))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    across = scene_doc["streetWidthMeters"] * 0.8
    camera = add_camera("Street")
    for along in [1.2 + 0.4 * i for i in range(20)]:
        camera.location = Vector((high.x + along * across, high.y + across, EYE_HEIGHT))
        target = Vector(((low.x + high.x) / 2, high.y, EYE_HEIGHT))
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        if fit(camera, points, aspect) >= MIN_LENS_MM:
            break
    return camera


def aerial_camera(points, aspect):
    """Bird's-eye from the street side at 35 degrees, framing the massing and its block."""
    centre = sum(points, Vector()) / len(points)
    radius = max((p - centre).length for p in points)
    direction = Vector((0.55, 0.83, math.tan(math.radians(35)))).normalized()
    camera = add_camera("Aerial")
    camera.location = centre + direction * max(2.6 * radius, 75)
    camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    lot = [to_blender(p) for p in scene_doc["lot"]]
    fit(camera, points + [p + Vector((dx, dy, 0)) for p in lot for dx, dy in ((-15, 15), (15, -15))], aspect, margin=1.05, shift=False)
    return camera


def render(camera, path):
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.filepath = str(path)
    started = time.monotonic()
    bpy.ops.render.render(write_still=True)
    return round(time.monotonic() - started, 3)



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

def main():
    started = time.monotonic()
    step("build")
    massing = build_scene()
    light_scene()
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cycles_device(scene)
    scene.cycles.samples = settings["samples"]
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.render.resolution_x = settings["width"]
    scene.render.resolution_y = settings["height"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.context.view_layer.update()
    points = corners(massing)
    aspect = settings["width"] / settings["height"]
    cameras = {"street": street_camera(points, aspect), "aerial": aerial_camera(points, aspect)}
    timings = {}
    for view, camera in cameras.items():
        step(f"render {view}")
        timings[f"{view}Seconds"] = render(camera, out / f"{view}.png")
    report = {
        "phase": "rendered",
        "blender": {"version": bpy.app.version_string, "python": sys.version.split()[0]},
        "scene": {"volumes": len(scene_doc["volumes"]), "context": len(scene_doc["context"])},
        "cameras": {view: {"location": [round(c, 3) for c in camera.location], "lens": round(camera.data.lens, 2)}
                    for view, camera in cameras.items()},
        "timings": {**timings, "blenderSeconds": round(time.monotonic() - started, 3)},
    }
    (out / "blender-report.json").write_text(json.dumps(report))


main()
