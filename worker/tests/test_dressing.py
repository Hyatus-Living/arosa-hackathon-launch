"""The dressing's room geometry, without Blender: hull, the room's rectangle frame and point-in-room."""

import math
import sys
import types
import unittest

from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from pathlib import Path

for name in ("bpy", "bmesh", "mathutils"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["mathutils"].Vector = tuple
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dressing  # noqa: E402


class RoomGeometryTest(unittest.TestCase):
    def test_room_use_infers_only_missing_authored_uses(self):
        entity = lambda name, kind=None: types.SimpleNamespace(Name=name, ObjectType=kind)
        self.assertEqual(dressing.room_use(entity("Bedroom A")), "bedroom")
        self.assertEqual(dressing.room_use(entity("Living / dining")), "living")
        self.assertEqual(dressing.room_use(entity("Living / sleeping")), "studio")
        self.assertEqual(dressing.room_use(entity("Full Bath")), "bath")
        self.assertEqual(dressing.room_use(entity("Rear utility/storage")), "")
        self.assertEqual(dressing.room_use(entity("Unspecified room")), "")
        self.assertEqual(dressing.room_use(entity("Bedroom A", "workshop")), "workshop")
        self.assertEqual(dressing.FLOORS.get(dressing.room_use(entity("Bedroom A"))), "oak")
        self.assertEqual(dressing.FLOORS.get(dressing.room_use(entity("Unspecified room")), "concrete"), "concrete")

    def test_hull_drops_inner_and_collinear_points(self):
        ring = dressing.hull([(0, 0), (4, 0), (2, 0), (4, 3), (0, 3), (2, 1)])
        self.assertEqual(sorted(ring), [(0, 0), (0, 3), (4, 0), (4, 3)])
        self.assertAlmostEqual(dressing.area(ring), 12)

    def test_frame_of_a_rotated_room_runs_along_its_long_side(self):
        angle = math.radians(30)
        rotate = lambda x, y: (x * math.cos(angle) - y * math.sin(angle) + 10, x * math.sin(angle) + y * math.cos(angle) + 5)
        ring = dressing.hull([rotate(x, y) for x, y in ((0, 0), (5, 0), (5, 3), (0, 3))])
        frame = dressing.Frame(ring)
        self.assertAlmostEqual(frame.half_u, 2.5)
        self.assertAlmostEqual(frame.half_v, 1.5)
        self.assertAlmostEqual(abs(frame.u[0] * math.cos(angle) + frame.u[1] * math.sin(angle)), 1)
        self.assertAlmostEqual(frame.area, 15)
        a, b = frame.local(frame.world(1.2, -0.7))
        self.assertAlmostEqual(a, 1.2)
        self.assertAlmostEqual(b, -0.7)

    def test_an_l_shaped_room_fills_too_little_of_its_rectangle_for_furniture(self):
        ell = [(0, 0), (4, 0), (4, 1), (1, 1), (1, 4), (0, 4)]
        self.assertLess(dressing.area(ell), dressing.RECTANGULAR * dressing.Frame(dressing.hull(ell)).area)

    def test_inside(self):
        square = [(0, 0), (2, 0), (2, 2), (0, 2)]
        self.assertTrue(dressing.inside((1, 1), square))
        self.assertFalse(dressing.inside((3, 1), square))


class SurfaceFinishTest(unittest.TestCase):
    def rotate(self, point, angle):
        c, s = math.cos(angle), math.sin(angle)
        return (c * point[0] - s * point[1], s * point[0] + c * point[1], point[2])

    def face(self, polygon, yaw=0, kind="roof", level="ground", owner="roof"):
        to_world = lambda x, y: self.rotate((x, y, 3) if kind == "roof" else (x, 0, y), yaw)
        return [{"points": [to_world(x, y) for x, y in list(triangle.exterior.coords)[:3]],
                 "normal": self.rotate((0, 0, 1) if kind == "roof" else (0, -1, 0), yaw),
                 "kind": kind, "level": level, "owner": owner}
                for triangle in constrained_delaunay_triangles(polygon).geoms]

    def coverage(self, surfaces, yaw=0, kind="roof"):
        triangles = []
        for surface in surfaces:
            vertices = [self.rotate(point, -yaw) for point in surface["vertices"]]
            for face in surface["faces"]:
                triangles.append(Polygon([(vertices[i][0], vertices[i][1 if kind == "roof" else 2]) for i in face]))
        return unary_union(triangles)

    def test_union_keeps_openings_partial_overlap_and_disconnected_gap_after_rotation(self):
        ring = Polygon([(0, 0), (4, 0), (4, 4), (0, 4)], holes=[[(1, 1), (3, 1), (3, 3), (1, 3)]])
        patches = [ring, box(3.5, 0, 5, 1.5), box(6, 0, 7, 1)]
        expected = unary_union(patches)
        for kind in ["roof", "facade"]:
            for yaw in [0, math.radians(37)]:
                with self.subTest(kind=kind, yaw=yaw):
                    source = [face for patch in patches for face in self.face(patch, yaw, kind)]
                    actual = dressing.coplanar_finishes(source)
                    self.assertEqual(len(actual), 1)
                    self.assertLess(self.coverage(actual, yaw, kind).symmetric_difference(expected).area, 1e-8)
                    # Triangle winding faces the source normal, including vertical facades.
                    for row in actual:
                        a, b, c = [row["vertices"][i] for i in row["faces"][0]]
                        u, v = dressing._sub(b, a), dressing._sub(c, a)
                        normal = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                        self.assertGreater(dressing._dot(normal, source[0]["normal"]), 0)

    def test_near_coplanar_faces_merge_without_merging_storeys_or_distinct_planes(self):
        faces = self.face(box(0, 0, 2, 2), math.radians(37), "facade")
        adjacent = self.face(box(1, 0, 3, 2), math.radians(37), "facade")
        # IFC float conversion places equivalent planes on opposite rounded-key boundaries.
        for face in adjacent:
            face["normal"] = tuple(value + 1e-8 for value in face["normal"])
            face["points"] = [tuple(value + 1e-7 for value in point) for point in face["points"]]
        actual = dressing.coplanar_finishes(faces + adjacent)
        self.assertEqual(len(actual), 1)
        self.assertAlmostEqual(actual[0]["sourceArea"], 6, places=5)
        self.assertEqual(len(dressing.coplanar_finishes(faces + self.face(box(0, 0, 2, 2), math.radians(37), "facade", "upper"))), 2)
        offset = self.face(box(0, 0, 2, 2), math.radians(37), "facade")
        for face in offset:
            face["points"] = [(x, y + 0.01, z) for x, y, z in face["points"]]
        self.assertEqual(len(dressing.coplanar_finishes(faces + offset)), 2)

    def test_adjacent_coplanar_elements_keep_their_own_finish_and_selection_extent(self):
        first = box(0, 0, 2, 3)
        second = box(2, 0, 4, 3)
        for yaw in [0, math.radians(37)]:
            surfaces = dressing.coplanar_finishes(self.face(first, yaw, "facade", owner="wall-a")
                                                  + self.face(second, yaw, "facade", owner="wall-b"))
            self.assertEqual({row["owner"] for row in surfaces}, {"wall-a", "wall-b"})
            self.assertEqual(len(surfaces), 2)
            for row in surfaces:
                expected = first if row["owner"] == "wall-a" else second
                self.assertLess(self.coverage([row], yaw, "facade").symmetric_difference(expected).area, 1e-8)
            self.assertLess(self.coverage(surfaces, yaw, "facade").symmetric_difference(box(0, 0, 4, 3)).area, 1e-8)

    def test_wall_finish_excludes_endcaps_and_opening_jambs_in_every_orientation(self):
        vertices = [(x, y, z) for x in [0, 5] for y in [0, 0.2] for z in [0, 3]]
        for yaw in [0, math.radians(37), math.radians(91)]:
            points = [self.rotate(point, yaw) for point in vertices]
            self.assertTrue(dressing.facade_side(self.rotate((0, -1, 0), yaw), points))
            self.assertFalse(dressing.facade_side(self.rotate((1, 0, 0), yaw), points))
            self.assertFalse(dressing.facade_side((0, 0, 1), points))
        self.assertFalse(dressing.facade_side((0, -1, 0), [(x, y, z) for x in [0, .2] for y in [0, .2] for z in [0, 3]]))


if __name__ == "__main__":
    unittest.main()
