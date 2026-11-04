import copy
import json
import os
import tempfile
import unittest

import ifcopenshell
import ifcopenshell.util.unit
import numpy as np

import architecture
from exporters.ifc import write_plan
from model_intake import import_ifc, read_points, validate_scan, MAX_POINTS


def sample():
    with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'sample-floorplan.json')) as handle:
        return architecture.from_layout(json.load(handle), 'bc8e00d1-38c7-4bd5-8171-d9ec75136b72')


class ModelIntake(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, 'source.ifc')
        self.plan = sample()
        write_plan(self.path, self.plan)

    def test_native_export_imports_editable_walls_openings_and_accounts_for_losses(self):
        result = import_ifc(self.path, 'Existing apartment')
        self.assertEqual(len(result['plan']['walls']), 8)
        self.assertEqual(len(result['plan']['openings']), 9)
        self.assertTrue(all(w['ifcGlobalId'] for w in result['plan']['walls']))
        self.assertTrue(any(item['type'] == 'IfcSlab' for item in result['report']['omitted']))
        self.assertEqual(architecture.validate(result['plan']), [])
        # Re-reading the same IFC keeps editor identity stable.
        self.assertEqual([w['id'] for w in result['plan']['walls']], [w['id'] for w in import_ifc(self.path, 'Again')['plan']['walls']])

    def test_millimetres_and_rotated_translated_placements_are_measured_in_metres(self):
        model = ifcopenshell.open(self.path)
        building = model.by_type('IfcBuilding')[0]
        placement = building.ObjectPlacement.RelativePlacement
        placement.Location.Coordinates = (100., 200., 0.)
        placement.RefDirection = model.createIfcDirection((0., 1., 0.))
        model = ifcopenshell.util.unit.convert_file_length_units(model, 'MILLIMETER')
        model.write(self.path)
        result = import_ifc(self.path, 'Rotated')
        original = next(w for w in self.plan['walls'] if w['id'] == 'wall-south')
        wall = max(result['plan']['walls'], key=lambda w: np.linalg.norm(np.array(w['end']) - w['start']))
        self.assertAlmostEqual(wall['thickness'], original['thickness'], places=4)
        self.assertAlmostEqual(wall['height'], original['height'], places=4)
        self.assertTrue(all(90 < p[0] < 110 and 190 < p[1] < 220 for w in result['plan']['walls'] for p in (w['start'], w['end'])))

    def test_nonrectangular_wall_is_reported_without_a_silent_box(self):
        model = ifcopenshell.open(self.path)
        wall = model.by_type('IfcWall')[0]
        body = next(r for r in wall.Representation.Representations if r.RepresentationIdentifier == 'Body')
        profile = body.Items[0].SweptArea
        coords = profile.OuterCurve.Points
        coords[1].Coordinates = (coords[1].Coordinates[0] - 1, coords[1].Coordinates[1] + .04)
        model.write(self.path)
        result = import_ifc(self.path, 'Unsupported wall')
        self.assertEqual(len(result['plan']['walls']), 7)
        self.assertTrue(any(x['globalId'] == wall.GlobalId and 'nonrectangular' in x['reason'] for x in result['report']['omitted']))

    def test_scan_distance_is_to_faces_not_vertices_and_uses_explicit_units(self):
        scan = os.path.join(self.directory.name, 'scan.xyz')
        # A point on the south wall face, another 100 mm away, far from mesh vertices.
        np.savetxt(scan, [[3000, -90, 2500], [3000, -190, 2500]])
        result = validate_scan(scan, 'xyz', self.plan, 'mm', .025)
        self.assertEqual(result['withinTolerance'], 1)
        self.assertAlmostEqual(result['maxMetres'], .1, places=5)
        self.assertEqual(result['testedPoints'], 2)
        self.assertFalse(result['sampled'])
        shifted = copy.deepcopy(self.plan)
        for wall in shifted['walls']:
            wall['start'][0] += 100
            wall['end'][0] += 100
        shifted['rooms'] = []
        self.assertEqual(validate_scan(scan, 'xyz', shifted, 'mm', .025)['withinTolerance'], 0)

    def test_ply_las_laz_and_xyz_read_coordinates_without_losing_las_scale(self):
        import laspy
        from plyfile import PlyData, PlyElement
        points = np.array([[1., 2., 3.], [4., 5., 6.]])
        vertices = np.array([tuple(p) for p in points], dtype=[('x', 'f8'), ('y', 'f8'), ('z', 'f8')])
        for binary in (False, True):
            path = os.path.join(self.directory.name, 'scan.ply')
            PlyData([PlyElement.describe(vertices, 'vertex')], text=not binary).write(path)
            np.testing.assert_allclose(read_points(path, 'ply'), points)
        for extension in ('las', 'laz'):
            cloud = laspy.LasData(laspy.LasHeader(point_format=3, version='1.2'))
            cloud.header.scales = [.001, .001, .001]
            cloud.header.offsets = [1000, 1000, 1000]
            cloud.x, cloud.y, cloud.z = points.T
            path = os.path.join(self.directory.name, 'scan.' + extension)
            cloud.write(path)
            np.testing.assert_allclose(read_points(path, extension), points)

    def test_bad_points_and_tolerance_fail(self):
        path = os.path.join(self.directory.name, 'bad.xyz')
        np.savetxt(path, [[1, float('nan'), 2]])
        with self.assertRaisesRegex(ValueError, 'finite'):
            read_points(path, 'xyz')
        with self.assertRaisesRegex(ValueError, 'tolerance'):
            validate_scan(path, 'xyz', self.plan, 'm', 0)

    def test_large_cloud_reports_sampling_and_bounds_heatmap_output(self):
        path = os.path.join(self.directory.name, 'large.xyz')
        np.savetxt(path, np.tile([3., -.09, 2.5], (MAX_POINTS + 1, 1)))
        result = validate_scan(path, 'xyz', self.plan, 'm', .025)
        self.assertTrue(result['sampled'])
        self.assertEqual(result['totalPoints'], MAX_POINTS + 1)
        self.assertEqual(result['testedPoints'], MAX_POINTS)
        self.assertEqual(result['withinPercent'], 100)
        self.assertEqual(len(result['points']), 2000)


if __name__ == '__main__':
    unittest.main()
