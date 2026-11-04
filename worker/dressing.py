"""Presentation dressing for the architecture worker's preview and GLB; imported by blender_job.py.

Materials by IFC class (exterior wall faces as facade, the rest plaster), a floor finish per room by its
kind, and simple furniture in rooms that are close to rectangular, placed against the wall away from the
room's windows. Room volumes become clear, so the dollhouse shows what is inside them. Nothing here moves
or adds building geometry: finishes and furniture are separate meshes parented to their room, so the
manifest, collision and counts stay those of the IFC, and the browser hides and highlights them with
their room.
"""

import math

import bmesh
import bpy
from mathutils import Vector

# name: (base colour, roughness, metallic, alpha)
MATERIALS = {
    "plaster": ((0.88, 0.86, 0.82), 0.85, 0.0, 1.0),
    "facade": ((0.22, 0.08, 0.05), 0.80, 0.0, 1.0),
    "concrete": ((0.60, 0.59, 0.56), 0.90, 0.0, 1.0),
    "slab": ((0.22, 0.20, 0.19), 0.90, 0.0, 1.0),
    "stone": ((0.45, 0.42, 0.38), 0.85, 0.0, 1.0),
    "oak": ((0.45, 0.28, 0.15), 0.45, 0.0, 1.0),
    "tile": ((0.70, 0.73, 0.76), 0.25, 0.0, 1.0),
    "door": ((0.52, 0.38, 0.25), 0.50, 0.0, 1.0),
    "glass": ((0.22, 0.28, 0.32), 0.05, 0.0, 0.55),
    "metal": ((0.08, 0.08, 0.08), 0.40, 0.7, 1.0),
    "fabric": ((0.35, 0.36, 0.37), 1.00, 0.0, 1.0),
    "throw": ((0.30, 0.33, 0.38), 1.00, 0.0, 1.0),
    "linen": ((0.90, 0.89, 0.86), 0.90, 0.0, 1.0),
    "counter": ((0.92, 0.91, 0.88), 0.30, 0.0, 1.0),
    "walnut": ((0.42, 0.28, 0.16), 0.50, 0.0, 1.0),
    "rug": ((0.62, 0.60, 0.55), 1.00, 0.0, 1.0),
    "room": ((1.0, 1.0, 1.0), 1.00, 0.0, 0.0),
}
# The floor finish of a room by its kind (the IFC space's ObjectType); others are concrete.
FLOORS = {"living": "oak", "bedroom": "oak", "hall": "oak", "closet": "oak", "bath": "tile"}
ELEMENTS = { "IfcDoor": "door", "IfcWindow": "glass", "IfcStair": "concrete",
            "IfcStairFlight": "concrete", "IfcRailing": "metal", "IfcTransportElement": "plaster"}
RECTANGULAR = 0.85  # rooms filling less of their best rectangle than this get no furniture
FINISH_LIFT = 0.01  # m above the slab, so the finish never fights the slab's top face


def material(name, cache={}):
    if name not in cache:
        colour, roughness, metallic, alpha = MATERIALS[name]
        mat = bpy.data.materials.new(f"Acres {name}")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*colour, 1)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
        if alpha < 1:
            bsdf.inputs["Alpha"].default_value = alpha
            mat.blend_method = "BLEND"
            mat.diffuse_color = (*colour, alpha)
        cache[name] = mat
    return cache[name]


def hull(points):
    points = sorted(set(points))
    if len(points) < 3:
        return points
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def area(ring):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))) / 2


def inside(point, ring):
    x, y = point
    hit = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            hit = not hit
    return hit


class Frame:
    """The smallest rectangle around a room's floor: centre, unit axes u (long) and v, half sizes."""

    def __init__(self, ring):
        best = None
        for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
            length = math.hypot(x1 - x0, y1 - y0)
            if length < 1e-6:
                continue
            u = ((x1 - x0) / length, (y1 - y0) / length)
            v = (-u[1], u[0])
            us = [p[0] * u[0] + p[1] * u[1] for p in ring]
            vs = [p[0] * v[0] + p[1] * v[1] for p in ring]
            size = (max(us) - min(us)) * (max(vs) - min(vs))
            if best is None or size < best[0]:
                best = (size, u, v, (min(us) + max(us)) / 2, (min(vs) + max(vs)) / 2, max(us) - min(us), max(vs) - min(vs))
        _, u, v, cu, cv, lu, lv = best
        if lu < lv:
            u, v, cu, cv, lu, lv = v, (-u[0], -u[1]), cv, -cu, lv, lu
        self.u, self.v = u, v
        self.centre = (cu * u[0] + cv * v[0], cu * u[1] + cv * v[1])
        self.half_u, self.half_v = lu / 2, lv / 2
        self.area = lu * lv

    def world(self, a, b):
        return (self.centre[0] + a * self.u[0] + b * self.v[0], self.centre[1] + a * self.u[1] + b * self.v[1])

    def local(self, point):
        dx, dy = point[0] - self.centre[0], point[1] - self.centre[1]
        return dx * self.u[0] + dy * self.u[1], dx * self.v[0] + dy * self.v[1]


def box(name, parent, frame, a0, a1, b0, b1, z0, z1, mat, collection):
    """A box in a room's frame (a along u, b along v, z in world metres), parented to the room."""
    corners = [frame.world(a, b) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))]
    verts = [(x, y, z0) for x, y in corners] + [(x, y, z1) for x, y in corners]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.materials.append(material(mat))
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj


def floor_of(obj):
    """The room's floor outline (the convex hull of its lowest vertices, world XY), level and true floor area
    (its downward faces), so an L-shaped room is not mistaken for its hull."""
    world = obj.matrix_world
    verts = [world @ v.co for v in obj.data.vertices]
    bottom = min(v.z for v in verts)
    floor = 0.0
    for poly in obj.data.polygons:
        ring = [verts[i] for i in poly.vertices]
        if all(v.z < bottom + 0.02 for v in ring):
            floor += area([(v.x, v.y) for v in ring])
    return hull([(round(v.x, 4), round(v.y, 4)) for v in verts if v.z < bottom + 0.02]), bottom, floor


def finish(space, kind, collection):
    """The room's own floor faces, lifted a centimetre, in the finish its kind takes."""
    world = space.matrix_world
    bm = bmesh.new()
    bm.from_mesh(space.data)
    bm.transform(world)
    bottom = [f for f in bm.faces if f.normal.z < -0.9]
    if not bottom:
        bm.free()
        return None
    keep = bmesh.new()
    index = {}
    for face in bottom:
        verts = []
        for v in reversed(face.verts):
            if v.index not in index:
                index[v.index] = keep.verts.new((v.co.x, v.co.y, v.co.z + FINISH_LIFT))
            verts.append(index[v.index])
        keep.faces.new(verts)
    bm.free()
    mesh = bpy.data.meshes.new(f"{space.name}-floor")
    keep.to_mesh(mesh)
    keep.free()
    mesh.materials.append(material(FLOORS.get(kind, "concrete")))
    obj = bpy.data.objects.new(f"{space.name}-floor", mesh)
    collection.objects.link(obj)
    obj.parent = space
    obj.matrix_parent_inverse = world.inverted()
    return obj


def furnish(space, entity, ring, floor, z, windows, collection):
    """Simple furniture in a near-rectangular living room, bedroom or bath, backed against the long wall
    away from its windows."""
    frame = Frame(ring)
    if floor < RECTANGULAR * frame.area:
        return []
    near = [frame.local(w) for w in windows]
    near = [b for a, b in near if abs(a) <= frame.half_u + 0.5 and abs(b) <= frame.half_v + 0.8]
    side = -1 if sum(1 for b in near if b > 0) >= sum(1 for b in near if b < 0) else 1  # the back wall
    L, S = frame.half_u, frame.half_v
    back = side * (S - 0.05)
    out = lambda depth: back - side * depth  # a point `depth` in front of the back wall
    name, kind, made = space.name, entity.ObjectType or "", []

    def put(label, a0, a1, d0, d1, z0, z1, mat):
        b0, b1 = sorted((out(d0), out(d1)))
        made.append(box(f"{name}-{label}", space, frame, a0, a1, b0, b1, z + z0, z + z1, mat, collection))

    label = (entity.Name or "").lower()
    if kind == "living" and "sleeping" in label and L >= 1.7 and S >= 1.6:
        bed = 1.4
        put("bed", -L + 0.1, -L + 0.1 + bed, 0, 2.0, 0, 0.45, "linen")
        put("headboard", -L + 0.1, -L + 0.1 + bed, 0, 0.08, 0, 1.0, "walnut")
        if L >= 2.6:
            put("sofa", L - 1.9, L - 0.1, 0, 0.85, 0, 0.42, "fabric")
            put("sofa-back", L - 1.9, L - 0.1, 0, 0.2, 0, 0.8, "fabric")
    elif kind == "living" and L >= 1.7 and S >= 1.3:
        sofa = min(2.1, 2 * L - 0.6)
        a0 = -L + 0.3
        put("sofa", a0, a0 + sofa, 0, 0.9, 0, 0.42, "fabric")
        put("sofa-back", a0, a0 + sofa, 0, 0.2, 0, 0.8, "fabric")
        if S >= 1.5:
            put("rug", a0, a0 + sofa, 1.0, 2.4, 0, 0.01, "rug")
            put("coffee-table", a0 + sofa / 2 - 0.5, a0 + sofa / 2 + 0.5, 1.3, 1.85, 0, 0.4, "walnut")
        if "kitchen" in label and L >= 2.6:
            run = min(3.0, 2 * L - sofa - 1.2)
            if run >= 1.5:
                put("kitchen-counter", L - 0.1 - run, L - 0.1, 0, 0.65, 0, 0.9, "counter")
                if S >= 1.6:
                    put("dining-table", L - 0.3 - min(1.4, run), L - 0.3, 1.6, 2.45, 0.72, 0.76, "oak")
    elif kind == "bedroom" and L >= 1.4 and S >= 1.3:
        width = 1.5 if 2 * L >= 3.0 else 1.35
        put("bed", -width / 2, width / 2, 0, 2.05, 0, 0.45, "linen")
        put("throw", -width / 2 - 0.02, width / 2 + 0.02, 1.45, 2.05, 0.3, 0.47, "throw")
        put("headboard", -width / 2, width / 2, 0, 0.08, 0, 1.0, "walnut")
        if 2 * L >= width + 1.2:
            for end, name_ in ((-1, "left"), (1, "right")):
                edge = end * (width / 2 + 0.05)
                put(f"nightstand-{name_}", min(edge, edge + end * 0.45), max(edge, edge + end * 0.45), 0, 0.4, 0, 0.5, "walnut")
    elif kind == "bath" and L >= 0.9 and S >= 0.75:
        put("vanity", -L + 0.1, -L + 0.9, 0, 0.5, 0, 0.85, "counter")
        if 2 * L >= 2.4:
            put("tub", L - 1.6, L - 0.1, 0, 0.75, 0, 0.55, "tile")
    return made


def wall_faces(obj, rooms):
    """Assign the plaster and facade slots of an exterior wall: a face looking out of every room is facade."""
    obj.data.materials.clear()
    obj.data.materials.append(material("plaster"))
    obj.data.materials.append(material("facade"))
    world = obj.matrix_world
    rotation = world.to_3x3()
    for poly in obj.data.polygons:
        normal = (rotation @ poly.normal).normalized()
        if abs(normal.z) > 0.7:
            poly.material_index = 0
            continue
        probe = world @ poly.center + normal * 0.3
        poly.material_index = 0 if any(inside((probe.x, probe.y), ring) for ring, low, high in rooms
                                       if low - 0.05 <= probe.z <= high + 0.05) else 1


def slab_faces(obj):
    """A slab's edges in stone, like a floor band on the facade, and its top and soffit in concrete."""
    obj.data.materials.clear()
    obj.data.materials.append(material("slab"))
    obj.data.materials.append(material("stone"))
    rotation = obj.matrix_world.to_3x3()
    for poly in obj.data.polygons:
        poly.material_index = 0 if abs((rotation @ poly.normal).normalized().z) > 0.7 else 1


def dress(reopened, storey_of, collection):
    """Materials, floor finishes and furniture for the imported building; returns the objects it added."""
    rooms, added = [], []
    spaces = [(obj, entity) for obj, entity in reopened if entity.is_a("IfcSpace") and obj.type == "MESH"]
    windows = {}
    level = lambda entity: (storey_of(entity) or entity).GlobalId
    for obj, entity in reopened:
        if entity.is_a("IfcWindow") and obj.type == "MESH":
            centre = sum((obj.matrix_world @ Vector(c) for c in obj.bound_box), Vector()) / 8
            windows.setdefault(level(entity), []).append((centre.x, centre.y))
    for obj, entity in spaces:
        ring, z, floor_area = floor_of(obj)
        if len(ring) < 3:
            continue
        top = max((obj.matrix_world @ v.co).z for v in obj.data.vertices)
        rooms.append((ring, z, top))
        obj.data.materials.clear()
        obj.data.materials.append(material("room"))
        kind = entity.ObjectType or ""
        floor = finish(obj, kind, collection)
        if floor:
            added.append(floor)
        added += furnish(obj, entity, ring, floor_area, z + FINISH_LIFT, windows.get(level(entity), []), collection)
    for obj, entity in reopened:
        if obj.type != "MESH" or entity.is_a("IfcSpace"):
            continue
        if entity.is_a("IfcSlab"):
            slab_faces(obj)
            continue
        if entity.is_a("IfcWall"):
            exterior = any(p.Name == "Pset_WallCommon" and any(prop.Name == "IsExternal" and prop.NominalValue and prop.NominalValue.wrappedValue
                                                               for prop in p.HasProperties)
                           for rel in getattr(entity, "IsDefinedBy", []) if rel.is_a("IfcRelDefinesByProperties")
                           for p in [rel.RelatingPropertyDefinition] if p.is_a("IfcPropertySet"))
            if exterior:
                wall_faces(obj, rooms)
                continue
            name = "plaster"
        else:
            name = next((m for cls, m in ELEMENTS.items() if entity.is_a(cls)), "plaster")
        obj.data.materials.clear()
        obj.data.materials.append(material(name))
    return added


def sky(scene, elevation_deg=40.0, rotation_deg=200.0, strength=0.35):
    """A physical (Nishita) sky without its sun disc; the scene's sun lamp casts the shadows."""
    world = bpy.data.worlds.new("Acres sky")
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    texture = nodes.new("ShaderNodeTexSky")
    texture.sky_type = "NISHITA"
    texture.sun_disc = False
    texture.sun_elevation = math.radians(elevation_deg)
    texture.sun_rotation = math.radians(rotation_deg)
    background = nodes["Background"]
    background.inputs["Strength"].default_value = strength
    links.new(texture.outputs["Color"], background.inputs["Color"])
    scene.world = world
    return world
