"""Golden regression for the planning engine and its JSON wrapper.

Run with the project venv:  .venv/bin/python -m unittest test_engine -v
The numbers are the spike example's independently checked takeoffs (README.md):
672,000 sq ft gross at FAR 10.18, 285 units, 84.9% residential efficiency, 126 checks.
"""
import unittest

from engine import Rules, Storey, UnitType, plan
from run import run
from assemble import assemble

LOT = [[0, 0], [200, 0], [200, 330], [0, 330]]
TOWER = [[60, 50], [140, 50], [140, 280], [60, 280]]
MIX = [UnitType('studio', 0.20, 450), UnitType('1br', 0.45, 650), UnitType('2br', 0.25, 950), UnitType('3br', 0.10, 1250)]
STOREYS = [
    Storey('Cellar parking', 'parking', LOT, 10, below_grade=True),
    Storey('Ground retail', 'retail', LOT, 15),
    Storey('Office', 'office', LOT, 12.5, count=5),
    Storey('Residential', 'residential', TOWER, 10.5, count=15),
]


class GoldenExample(unittest.TestCase):
    def test_takeoffs_match_the_spike(self):
        _, takeoffs = plan(LOT, STOREYS, MIX, Rules())
        self.assertEqual(takeoffs['grossFloorAreaSqft'], 672000)
        self.assertEqual(takeoffs['far'], 10.18)
        self.assertEqual(takeoffs['storeysAboveGrade'], 21)
        self.assertEqual(takeoffs['heightFeet'], 235.0)
        self.assertEqual(takeoffs['residential']['units'], 285)
        self.assertEqual(takeoffs['residential']['efficiency'], 0.849)
        self.assertEqual(takeoffs['residential']['netRentableSqft'], 234330)
        self.assertEqual(takeoffs['checks']['total'], 126)
        self.assertEqual(takeoffs['checks']['failed'], [])

    def test_wrapper_round_trip(self):
        out = run({
            'name': 'Wrapper check', 'lot': LOT,
            'levels': [
                {'label': 'Cellar parking', 'use': 'parking', 'footprint': LOT, 'height': 10, 'belowGrade': True},
                {'label': 'Ground retail', 'use': 'retail', 'footprint': LOT, 'height': 15},
                {'label': 'Office', 'use': 'office', 'footprint': LOT, 'height': 12.5, 'count': 5},
                {'label': 'Residential', 'use': 'residential', 'footprint': TOWER, 'height': 10.5, 'count': 15},
            ],
            'maxFar': 15,
        })
        self.assertEqual(out['takeoffs']['grossFloorAreaSqft'], 672000)
        pascal = out['pascal']
        self.assertEqual(pascal['maxFar'], 15)
        residential = [l for l in pascal['levels'] if l['use'] == 'residential']
        self.assertEqual(residential[0]['units'], 19)
        self.assertEqual(residential[0].get('count'), 15)
        self.assertNotIn('ifcBase64', out)

    def test_wrapper_ifc(self):
        import hashlib, os, tempfile
        with tempfile.TemporaryDirectory() as out_dir:
            out = run({'name': 'IFC check', 'lot': LOT, 'ifc': True, 'outDir': out_dir,
                       'levels': [{'label': 'Residential', 'use': 'residential', 'footprint': TOWER, 'height': 10.5, 'count': 2}]})
            with open(os.path.join(out_dir, 'model.ifc'), 'rb') as handle:
                raw = handle.read()
        self.assertIn(b'IFC4', raw[:400])
        self.assertEqual(out['artifacts']['ifc'], {'file': 'model.ifc', 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
        self.assertNotIn('ifcBase64', out)



class Assembly(unittest.TestCase):
    def test_adjacent_lots_union_into_one_polygon(self):
        left = [[0, 0], [50, 0], [50, 100], [0, 100], [0, 0]]
        right = [[50, 0], [100, 0], [100, 100], [50, 100], [50, 0]]
        out = assemble({'parcels': [{'bbl': '1', 'polygons': [{'polygon': left, 'holes': []}]}, {'bbl': '2', 'polygons': [{'polygon': right, 'holes': []}]}]})
        self.assertTrue(out['singlePolygon'])
        self.assertEqual(out['totalAreaSqft'], 10000)
        # Buffered-boundary intersection overcounts the corners by up to the tolerance at each end.
        self.assertAlmostEqual(out['pairs'][0]['sharedBoundaryFeet'], 100.0, delta=2.0)
        self.assertTrue(out['pairs'][0]['touches'])
        xs = [point[0] for point in out['parts'][0]['polygon']]
        self.assertEqual((min(xs), max(xs)), (0.0, 100.0))

    def test_separate_lots_stay_separate(self):
        left = [[0, 0], [50, 0], [50, 100], [0, 100], [0, 0]]
        far = [[200, 0], [250, 0], [250, 100], [200, 100], [200, 0]]
        out = assemble({'parcels': [{'bbl': '1', 'polygons': [{'polygon': left, 'holes': []}]}, {'bbl': '2', 'polygons': [{'polygon': far, 'holes': []}]}]})
        self.assertFalse(out['singlePolygon'])
        self.assertEqual(len(out['parts']), 2)
        self.assertEqual(out['pairs'][0]['distanceFeet'], 150.0)
        self.assertFalse(out['pairs'][0]['touches'])

if __name__ == '__main__':
    unittest.main()
