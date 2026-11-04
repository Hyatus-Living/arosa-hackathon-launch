"""Topology invariants for the production lot assembly engine."""
import unittest
from shapely.geometry import Polygon, box
from assemble import assemble

def ring(x, z, width, depth):
    return [[x, z], [x + width, z], [x + width, z + depth], [x, z + depth], [x, z]]

def part(polygon, *holes):
    return {'polygon': polygon, 'holes': list(holes)}

def request(*parcels):
    return {'parcels': [{'bbl': str(i), 'polygons': polygons} for i, polygons in enumerate(parcels)]}

class AssemblyTopologyTests(unittest.TestCase):
    def test_courtyard_remains_excluded_from_union_area(self):
        out = assemble(request([part(ring(0, 0, 100, 100), ring(20, 20, 20, 20))], [part(ring(100, 0, 50, 100))]))
        self.assertEqual(out['totalAreaSqft'], 14600)
        self.assertEqual(len(out['parts'][0]['holes']), 1)
        self.assertTrue(out['singlePolygon'])

    def test_multiple_holes_remain_excluded(self):
        out = assemble(request([part(ring(0, 0, 100, 100), ring(20, 20, 20, 20), ring(60, 60, 10, 10))], [part(ring(100, 0, 50, 100))]))
        self.assertEqual(out['totalAreaSqft'], 14500)
        self.assertEqual(len(out['parts'][0]['holes']), 2)

    def test_multiple_source_parts_retain_their_own_holes(self):
        out = assemble(request([part(ring(0, 0, 100, 100), ring(20, 20, 20, 20)), part(ring(300, 0, 50, 50))], [part(ring(100, 0, 50, 100))]))
        self.assertEqual(out['totalAreaSqft'], 17100)
        self.assertEqual([len(p['holes']) for p in out['parts']], [1, 0])

    def test_sliver_tolerance_does_not_fill_a_narrow_recorded_hole(self):
        out = assemble(request([part(ring(0, 0, 100, 100), ring(20, 20, .4, 10))], [part(ring(100, 0, 50, 100))]))
        self.assertEqual(out['totalAreaSqft'], 14996)
        self.assertEqual(len(out['parts'][0]['holes']), 1)

    def test_another_selected_parcel_can_fill_the_hole(self):
        out = assemble(request([part(ring(0, 0, 100, 100), ring(20, 20, 20, 20))], [part(ring(20, 20, 20, 20))]))
        self.assertEqual(out['totalAreaSqft'], 10000)
        self.assertEqual(out['parts'][0]['holes'], [])
        self.assertTrue(out['pairs'][0]['touches'])

    def test_an_island_inside_a_hole_remains_selected_land(self):
        out = assemble(request([part(ring(0, 0, 100, 100), ring(20, 20, 20, 20))], [part(ring(25, 25, 10, 10))]))
        self.assertEqual(out['totalAreaSqft'], 9700)
        self.assertEqual(len(out['parts']), 2)
        self.assertEqual([len(p['holes']) for p in out['parts']], [1, 0])

    def test_disconnected_hole_free_parts_remain_separate(self):
        out = assemble(request([part(ring(0, 0, 10, 10))], [part(ring(20, 0, 10, 10))]))
        self.assertEqual(out['totalAreaSqft'], 200)
        self.assertFalse(out['singlePolygon'])
        self.assertEqual([p['holes'] for p in out['parts']], [[], []])

    def test_a_hole_outside_the_shell_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Invalid.*polygon'):
            assemble(request([part(ring(0, 0, 100, 100), ring(200, 200, 10, 10))], [part(ring(100, 0, 50, 100))]))

    def test_overlapping_holes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Invalid.*polygon'):
            assemble(request([part(ring(0, 0, 100, 100), ring(20, 20, 20, 20), ring(30, 30, 20, 20))], [part(ring(100, 0, 50, 100))]))

    def test_an_invalid_exterior_is_rejected_without_silent_repair(self):
        with self.assertRaisesRegex(ValueError, 'Invalid.*polygon'):
            assemble(request([part([[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]])], [part(ring(20, 0, 10, 10))]))

# Curated residential bands (ZR 23-342 rear yards, ZR 23-343 rear yard equivalents, ZR 23-352 inner courts).
RESIDENTIAL = [
    {'fromFeet': 0, 'toFeet': 75, 'rearYardFeet': 20, 'rearYardEquivalentFeet': 40, 'court': {'minAreaSqft': 800, 'minDimensionFeet': 20}},
    {'fromFeet': 75, 'toFeet': None, 'rearYardFeet': 30, 'rearYardEquivalentFeet': 60, 'court': {'minAreaSqft': 1200, 'minDimensionFeet': 30}},
]

def open_areas(streets, *parcels, bands=RESIDENTIAL):
    packet = request(*parcels)
    packet['openAreas'] = {'streets': streets, 'bands': bands, 'rearYardEquivalentMinLotDepthFeet': 110}
    return assemble(packet)['openAreas']

def footprint(band):
    return Polygon(band['footprint'][0]['polygon'], band['footprint'][0]['holes'])

class AssemblageOpenAreaTests(unittest.TestCase):
    # Frame: x east, z south. A street on the south side runs along z = depth.
    def test_courtyard_assembly_footprint_excludes_the_courtyard_and_the_rear_yard(self):
        out = open_areas(['south'], [part(ring(0, 0, 100, 150), ring(40, 60, 20, 20))], [part(ring(100, 0, 50, 150))])
        self.assertEqual(out['lotLines'], {'frontFeet': {'south': 150.0}, 'rearFeet': 190.0, 'sideFeet': 340.0})
        low, high = out['bands']
        # 22,500 - 400 courtyard - 3,000 rear yard (150 x 20) - 2 x 400 along the courtyard's rear lot lines.
        self.assertEqual(low['footprintAreaSqft'], 18300)
        self.assertEqual(low['rearYardAreaSqft'], 3800)
        shape = footprint(low)
        self.assertEqual(shape.intersection(box(40, 60, 60, 80)).area, 0)
        self.assertEqual(shape.intersection(box(0, 0, 150, 20)).area, 0)
        self.assertEqual(low['courts'], [{'areaSqft': 1200, 'minDimensionFeet': 20.0, 'meetsMinimum': True, 'widenedToSqft': 1200, 'landOutsideAssemblySqft': 400}])
        # Above 75 ft the 30 ft yards open the courtyard into the rear yard: 22,100 - 4,500 - 2 x 600.
        self.assertEqual(high['footprintAreaSqft'], 16400)
        self.assertEqual(high['courts'], [])

    def test_an_enclosed_court_below_the_minimum_is_widened_into_the_footprint(self):
        out = open_areas(['south'], [part(ring(0, 0, 100, 200), ring(45, 90, 10, 10))], [part(ring(100, 0, 50, 200))])
        low, high = out['bands']
        # The court is 10 x 50 (500 sq ft): widened 5 ft on each side to 20 x 60, taking 700 sq ft more.
        self.assertEqual(low['courts'][0], {'areaSqft': 500, 'minDimensionFeet': 10.0, 'meetsMinimum': False, 'widenedToSqft': 1200, 'landOutsideAssemblySqft': 100})
        self.assertEqual(low['footprintAreaSqft'], 30000 - 100 - 3000 - 400 - 700)
        self.assertEqual(footprint(low).intersection(box(40, 65, 60, 125)).area, 0)
        # Above 75 ft: 10 x 70 widened 10 ft each side to 30 x 90.
        self.assertEqual(high['courts'][0]['widenedToSqft'], 2700)
        self.assertEqual(high['footprintAreaSqft'], 30000 - 100 - 4500 - 600 - 2000)

    def test_a_through_assembly_keeps_the_rear_yard_equivalent_open_midway(self):
        out = open_areas(['north', 'south'], [part(ring(0, 0, 100, 200))], [part(ring(100, 0, 50, 200))])
        low, high = out['bands']
        self.assertEqual(out['lotLines']['rearFeet'], 0)
        self.assertEqual((low['rearYardEquivalentAreaSqft'], low['footprintAreaSqft'], len(low['footprint'])), (6000, 24000, 2))
        self.assertEqual(footprint(low).intersection(box(0, 80, 150, 120)).area, 0)
        self.assertEqual((high['rearYardEquivalentAreaSqft'], high['footprintAreaSqft']), (9000, 21000))

    def test_a_corner_assembly_yards_its_interior_portion_beyond_100_feet(self):
        # ZR 12-10: only the part within 100 ft of the intersection is a corner lot. Along the 150 ft south
        # front the west 50 ft is interior, with its rear yard on the north line; along the 200 ft east front
        # the north 100 ft is interior, with its rear yard on the west line.
        out = open_areas(['south', 'east'], [part(ring(0, 0, 100, 200))], [part(ring(100, 0, 50, 200))])
        self.assertEqual(out['lotLines']['rearFeet'], 0)
        self.assertEqual([b['rearYardAreaSqft'] for b in out['bands']], [50 * 20 + 20 * 100 - 20 * 20, 50 * 30 + 30 * 100 - 30 * 30])
        self.assertEqual(footprint(out['bands'][0]).intersection(box(50, 100, 150, 200)).area, 100 * 100, 'the corner itself needs no yard')

    def test_a_long_corner_assembly_yards_the_part_beyond_100_feet_of_the_crossing_street(self):
        out = open_areas(['south', 'east'], [part(ring(0, 0, 150, 100))], [part(ring(150, 0, 100, 100))])
        low, high = out['bands']
        self.assertEqual((low['rearYardAreaSqft'], low['footprintAreaSqft']), (150 * 20, 25000 - 150 * 20))
        self.assertEqual((high['rearYardAreaSqft'], high['footprintAreaSqft']), (150 * 30, 25000 - 150 * 30))
        self.assertEqual(footprint(low).intersection(box(0, 0, 150, 20)).area, 0)

    def test_a_corner_assembly_within_100_feet_of_the_intersection_needs_no_rear_yard(self):
        out = open_areas(['south', 'east'], [part(ring(0, 0, 50, 100))], [part(ring(50, 0, 50, 100))])
        self.assertEqual([b['footprintAreaSqft'] for b in out['bands']], [10000, 10000])

    def test_separate_parts_each_keep_their_rear_yard(self):
        out = open_areas(['south'], [part(ring(0, 0, 60, 100))], [part(ring(200, 0, 60, 100))])
        self.assertEqual([p['areaSqft'] for p in out['bands'][0]['footprint']], [4800, 4800])
        self.assertEqual([p['areaSqft'] for p in out['bands'][1]['footprint']], [4200, 4200])

    def test_front_and_side_yards_apply_where_the_district_requires_them(self):
        low_density = [{'fromFeet': 0, 'toFeet': None, 'rearYardFeet': 20, 'rearYardEquivalentFeet': 40, 'frontYardFeet': 10, 'sideYardFeet': 5, 'court': None}]
        out = open_areas(['south'], [part(ring(0, 0, 30, 100))], [part(ring(30, 0, 30, 100))], bands=low_density)
        self.assertEqual(out['bands'][0]['footprint'][0]['areaSqft'], 50 * 70)

    def test_a_street_side_with_no_lot_line_is_rejected(self):
        # A triangle pointing north has no lot line facing north.
        west, east = [[50, 0], [50, 100], [0, 100], [50, 0]], [[50, 0], [100, 100], [50, 100], [50, 0]]
        with self.assertRaisesRegex(ValueError, 'faces the north street'):
            open_areas(['north'], [part(west)], [part(east)])

if __name__ == '__main__':
    unittest.main()
