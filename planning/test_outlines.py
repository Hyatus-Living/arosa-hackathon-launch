"""Storey outlines on the lot polygon (engine.storey_outlines, the A/B interface).

planning/fixtures/outlines.json holds acres.outlines/1 exports from acres-research/envelope.mjs for
varied lots: a 25 by 100 interior lot (R6B), a 50 ft lot with a skewed rear lot line (R7A, affordable),
a wide corner lot (R8), an L-shaped lot (R7A), a through lot (R6B) and a wide commercial lot (C6-2).
"""
import json
import math
import os
import unittest

from shapely.geometry import Polygon, box

import outlines
from engine import Rules, UnitType, plan, storey_outlines, storeys_from_outlines

with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines.json')) as handle:
    SITES = json.load(handle)
MIX = [UnitType('studio', 0.2, 450), UnitType('1br', 0.5, 650), UnitType('2br', 0.3, 950)]


def site(exterior, storeys, streets=('front',), holes=(), source='tax-lot'):
    return {'schema': outlines.SCHEMA, 'lot': {'exterior': exterior, 'holes': list(holes), 'source': source, 'areaSqft': Polygon(exterior, list(holes)).area},
            'streets': [{'side': s} for s in streets],
            'storeys': [{'index': i, 'label': f'Level {i + 1}', 'use': 'residential', 'bottomFeet': i * 10, 'topFeet': (i + 1) * 10, 'heightFeet': 10,
                         'zfaBudgetSqft': 1000, 'grossBudgetSqft': 1058, 'shapedBy': shaped} for i, shaped in enumerate(storeys)]}


class Geometry(unittest.TestCase):
    def test_rear_yard_is_measured_square_from_a_skewed_rear_lot_line(self):
        # The rear lot line runs from z = 105 at x = 0 to z = 85 at x = 50.
        [o] = storey_outlines(site([[0, 0], [50, 0], [50, 85], [0, 105]], [[{'control': 'rear_yard', 'feet': 20, 'section': 'ZR 23-342'}]]))
        rear = outlines.lot_lines(Polygon([[0, 0], [50, 0], [50, 85], [0, 105]]), ['front'])[1]
        self.assertEqual(len(rear), 1)
        self.assertAlmostEqual(o.geometry.distance(rear[0]), 20, places=1)
        # The rear yard line runs parallel to the lot line, 20 / cos(21.8 deg) = 21.5 ft back along z at
        # both sides; a bounding-box clip at z = 85 would leave no yard at all at x = 50.
        self.assertAlmostEqual(o.geometry.bounds[3], 105 - 20 * (1 + 0.4 ** 2) ** 0.5, delta=0.1)
        self.assertAlmostEqual(o.geometry.intersection(Polygon([[49, 0], [50, 0], [50, 100], [49, 100]])).bounds[3], 85 - 20 * (1 + 0.4 ** 2) ** 0.5, delta=0.5)

    def test_street_setbacks_apply_per_side_and_coverage_trims_from_the_rear(self):
        lot = [[0, 0], [100, 0], [100, 100], [0, 100]]
        [o] = storey_outlines(site(lot, [[{'control': 'setback', 'feet': {'front': 10, 'left': 15}, 'section': 'ZR 23-433'}, {'control': 'lot_coverage', 'percent': 60, 'section': 'ZR 23-362'}]], streets=('front', 'left')))
        minx, minz, maxx, maxz = o.geometry.bounds
        self.assertEqual((round(minx), round(minz), round(maxx)), (15, 10, 100))
        self.assertAlmostEqual(o.area, 6000, delta=1)

    def test_through_lot_keeps_the_rear_yard_equivalent_midway(self):
        [o] = storey_outlines(site([[0, 0], [40, 0], [40, 200], [0, 200]], [[{'control': 'rear_yard_equivalent', 'feet': 60, 'section': 'ZR 23-343'}]], streets=('front', 'rear')))
        self.assertEqual(len(outlines.parts(o.geometry)), 2)
        self.assertAlmostEqual(o.area, 40 * 140, delta=1)
        self.assertTrue(o.geometry.intersection(Polygon([[0, 71], [40, 71], [40, 129], [0, 129]])).is_empty)

    def test_holes_are_kept_and_enclosed_courts_measured(self):
        hole = [[40, 40], [50, 40], [50, 50], [40, 50]]
        s = site([[0, 0], [100, 0], [100, 100], [0, 100]], [[]], holes=[hole])
        s['storeys'][0]['courts'] = {'inner': {'withWindows': {'minAreaSqft': 800, 'minDimensionFeet': 20}, 'section': 'ZR 23-352'}, 'outer': {'withWindows': {'minWidthFeet': 20}, 'section': 'ZR 23-353'}}
        [o] = storey_outlines(s)
        self.assertEqual(len(o.polygons[0]['holes']), 1)
        self.assertEqual(o.court_checks[0]['meetsMinimum'], False)
        self.assertEqual(o.court_checks[0]['section'], 'ZR 23-352')

    def test_rectangle_fallback_is_reported(self):
        s = site([[0, 0], [25, 0], [25, 100], [0, 100]], [[]], source='rectangle')
        self.assertEqual(storey_outlines(s)[0].source, 'rectangle')
        self.assertEqual(outlines.outline_note(s), outlines.RECTANGLE_NOTE)

    def test_a_corner_lot_has_no_rear_yard_within_its_corner_portion(self):
        rear = [{'control': 'rear_yard', 'feet': 20, 'section': 'ZR 23-342', 'cornerPortionFeet': 100, 'cornerSection': 'ZR 23-344'}]
        # 150 ft on the front street, 90 deep, side street on the left: the 50 ft beyond 100 ft of the
        # side street is an interior portion and keeps its rear yard (ZR 12-10).
        (o,) = storey_outlines(site([[0, 0], [150, 0], [150, 90], [0, 90]], [rear], streets=('front', 'left')))
        self.assertAlmostEqual(o.area, 150 * 90 - 50 * 20, delta=1)
        self.assertLess(o.geometry.difference(Polygon([[0, 0], [100, 0], [100, 90], [0, 90]])).area, 50 * 70 + 1)
        # Without the corner flag (an older export) the yard runs the whole rear line, as before.
        (old,) = storey_outlines(site([[0, 0], [150, 0], [150, 90], [0, 90]], [[{k: v for k, v in rear[0].items() if not k.startswith('corner')}]], streets=('front', 'left')))
        self.assertAlmostEqual(old.area, 150 * 70, delta=1)

    def test_the_corner_portion_needs_street_lines_meeting_at_135_degrees_or_less(self):
        rear = [{'control': 'rear_yard', 'feet': 20, 'section': 'ZR 23-342', 'cornerPortionFeet': 100, 'cornerSection': 'ZR 23-344'}]
        def skewed(angle, depth=90, frontage=150):
            # The side street line leaves the corner at the given interior angle to the front street.
            dx, dz = math.cos(math.radians(angle)), math.sin(math.radians(angle))
            far = (dx * depth / dz, depth)
            return [[0, 0], [frontage, 0], [frontage, depth], [round(far[0], 3), depth]]
        lot_120, lot_140 = Polygon(skewed(120)), Polygon(skewed(140))
        (at_120,) = storey_outlines(site(skewed(120), [rear], streets=('front', 'left')))
        (at_140,) = storey_outlines(site(skewed(140), [rear], streets=('front', 'left')))
        # At 120 degrees the corner portion keeps part of the 20 ft rear band; at 140 degrees the lot is
        # no corner lot and the whole band stays open.
        front_70 = lambda lot: lot.intersection(box(-500, 0, 500, 70)).area
        self.assertGreater(at_120.area, front_70(lot_120) + 500)
        self.assertAlmostEqual(at_140.area, front_70(lot_140), delta=2)

    def test_a_through_lot_places_its_equivalent_where_the_building_holds_the_most(self):
        eq = lambda alternatives: {'control': 'rear_yard_equivalent', 'feet': 40, 'section': 'ZR 23-343', **({'alternatives': ['street_lines', 'side_lot_lines']} if alternatives else {})}
        setback = {'control': 'setback', 'feet': {'front': 15, 'rear': 15}, 'aboveFeet': 10, 'section': 'ZR 23-433'}
        lot = [[0, 0], [50, 0], [50, 200], [0, 200]]
        # Midway, the equivalent and the street setbacks above the base both cost area; along the street
        # lines the 20 ft open areas take in the 15 ft setbacks, so the building holds more there.
        alt = storey_outlines(site(lot, [[eq(True)], [eq(True), setback]], streets=('front', 'rear')))
        self.assertEqual([o.equivalent for o in alt], ['street_lines', 'street_lines'])
        self.assertAlmostEqual(sum(o.area for o in alt), 50 * 160 * 2, delta=2)
        standard = storey_outlines(site(lot, [[eq(False)], [eq(False), setback]], streets=('front', 'rear')))
        self.assertEqual(standard[0].equivalent, 'midway')
        self.assertAlmostEqual(sum(o.area for o in standard), 50 * 160 + 50 * 130, delta=2)
        # The side lot line option costs 20 ft along each 200 ft side: never chosen on this lot.
        self.assertNotIn('side_lot_lines', [o.equivalent for o in alt])

    def test_rejects_anything_but_an_outline_export(self):
        with self.assertRaises(ValueError):
            storey_outlines({'lot': {}})


class Portions(unittest.TestCase):
    def test_each_portion_is_drawn_under_its_own_row_and_the_storey_joined(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['deep-50x150-R8-wide-street']
        lot = Polygon(site['lot']['exterior'])
        found = storey_outlines(site)
        # Below the base every storey covers 80% of the whole lot in one piece (ZR 23-362, 77-24).
        for o in found[:-1]:
            self.assertEqual(len(outlines.parts(o.geometry)), 1)
            self.assertAlmostEqual(o.area, 0.8 * lot.area, delta=2)
        near = outlines.portion_region(lot, outlines.lot_lines(lot, ['front']), site['portions'][0])
        self.assertAlmostEqual(near.area, 50 * 100, delta=1)
        # Level 9 tops out at 94.5 ft: above the narrow row's 85 ft base the beyond portion's controls name
        # the street setback (it falls 100 ft away, outside its region), while the wide-street portion keeps
        # its street wall to 95 ft (ZR 23-432, 23-433).
        level9 = next(o for o in found if o.label == 'Level 9')
        self.assertTrue(any(c.get('portion') == 1 and c['control'] == 'setback' for c in level9.shaped_by))
        self.assertFalse(any(c.get('portion') == 0 and c['control'] == 'setback' for c in level9.shaped_by))


class OuterCourts(unittest.TestCase):
    COURTS = {'inner': {'withWindows': {'minAreaSqft': 800, 'minDimensionFeet': 20}, 'section': 'ZR 23-352'}, 'outer': {'withWindows': {'minWidthFeet': 20}, 'section': 'ZR 23-353'}}
    LOT = Polygon([[0, 0], [100, 0], [100, 100], [0, 100]])

    def u(self, width, depth):
        x0 = 50 - width / 2
        return Polygon([[0, 0], [100, 0], [100, 80], [x0 + width, 80], [x0 + width, 80 - depth], [x0, 80 - depth], [x0, 80], [0, 80]])

    def test_an_outer_court_is_as_wide_as_it_is_deep_or_20_ft_wide(self):
        found = {(w, d): outlines.outer_courts(self.u(w, d), self.LOT, self.COURTS)[0] for w, d in [(15, 10), (15, 25), (25, 40)]}
        self.assertEqual({k: (c['widthFeet'], c['depthFeet'], c['pass']) for k, c in found.items()},
                         {(15, 10): (15, 10, True), (15, 25): (15, 25, False), (25, 40): (25, 40, True)})
        self.assertEqual(found[(15, 25)]['section'], 'ZR 23-353')
        # Above 75 ft the width that permits any depth is 30 ft.
        high = {**self.COURTS, 'outer': {**self.COURTS['outer'], 'withWindows': {'minWidthFeet': 30}}}
        self.assertFalse(outlines.outer_courts(self.u(25, 40), self.LOT, high)[0]['pass'])

    def test_an_open_corner_is_not_an_outer_court_and_courts_join_the_checks(self):
        ell = Polygon([[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]])
        self.assertEqual(outlines.outer_courts(ell, self.LOT, self.COURTS), [])
        checks = outlines.court_checks(self.u(15, 25), self.LOT, self.COURTS)
        self.assertEqual([c['kind'] for c in checks], ['outer'])


class Recovery(unittest.TestCase):
    def test_storeys_are_added_where_exact_yards_hold_less_than_the_envelope_stack(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['l-shaped-R7A-recovered']
        target = sum(s['grossBudgetSqft'] for s in site['storeys'])
        found = storey_outlines(site)
        # Six bounding-box storeys become eight exact ones, the last partial, all under the 85 ft limit.
        self.assertEqual((len(site['storeys']), len(found)), (6, 8))
        self.assertAlmostEqual(sum(o.area for o in found), target, delta=2)
        self.assertTrue(found[-1].label.endswith('(partial)') and all(o.top <= site['heightLimitFeet'] for o in found))
        self.assertEqual([round(o.gross_budget) for o in found[:-1]], [round(o.area) for o in found[:-1]])
        # An export without reserves (an older revision) keeps its own storeys.
        old = storey_outlines({k: v for k, v in site.items() if k != 'reserveStoreys'})
        self.assertEqual(len(old), 6)


class EnvelopeExports(unittest.TestCase):
    def test_outlines_follow_the_envelope_and_never_exceed_its_budget(self):
        for name, s in SITES.items():
            with self.subTest(name):
                out = storey_outlines(s)
                lot = Polygon(s['lot']['exterior'])
                self.assertEqual(len(out), len(s['storeys']))
                for o in out:
                    self.assertTrue(lot.buffer(0.01).covers(o.geometry))
                    self.assertLessEqual(o.area, o.gross_budget + 1)
                    self.assertTrue(all(c['section'].startswith('ZR ') for c in o.shaped_by if c.get('section')))

    def test_exact_yards_differ_from_the_bounding_box_only_where_the_lot_is_irregular(self):
        for name, s in SITES.items():
            out = storey_outlines(s)
            gap = max(o.gross_budget - o.area for o in out)
            if name.startswith(('skewed', 'l-shaped')):
                self.assertGreater(gap, 40, name)
            else:
                self.assertLess(gap, 2, name)

    def test_the_planning_engine_lays_out_inside_the_outlines(self):
        for name in ('interior-25x100-R6B', 'corner-100x125-R8', 'wide-100x100-C6-2'):
            with self.subTest(name):
                s = SITES[name]
                storeys = storeys_from_outlines(storey_outlines(s))
                self.assertLess(len(storeys), len(s['storeys']) + 1)
                plans, takeoffs = plan(s['lot']['exterior'], storeys, MIX, Rules())
                self.assertEqual(takeoffs['storeysAboveGrade'], len(s['storeys']))
                self.assertGreater(takeoffs['residential']['units'] + takeoffs['byUse'].get('office', 0), 0)


if __name__ == '__main__':
    unittest.main()
