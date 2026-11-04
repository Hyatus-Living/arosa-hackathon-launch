"""The dressing's room geometry, without Blender: hull, the room's rectangle frame and point-in-room."""

import math
import sys
import types
import unittest
from pathlib import Path

for name in ("bpy", "bmesh", "mathutils"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["mathutils"].Vector = tuple
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dressing  # noqa: E402


class RoomGeometryTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
