import json
import os
import subprocess
import sys
import tempfile
import unittest

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

import architecture
import ifcopenshell
import layout
from run import run

HERE = os.path.dirname(os.path.abspath(__file__))
RENTAL = [('studio', 0.30, 450), ('oneBedroom', 0.45, 550), ('twoBedroom', 0.25, 800)]
# A mixed-income building: 14 of 59 units affordable, smaller than the market units, as a bonus option prices them.
MIXED = [('studio', '', 7, 600), ('oneBedroom', '', 20, 750), ('twoBedroom', '', 14, 1268), ('threeBedroom', '', 4, 1896),
         ('studio', ', affordable', 4, 495), ('oneBedroom', ', affordable', 6, 666), ('twoBedroom', ', affordable', 4, 1061)]
AFFORDABLE = 14 / 59
CONDO = [('studio', 0.15, 550), ('oneBedroom', 0.45, 750), ('twoBedroom', 0.30, 1100), ('threeBedroom', 0.10, 1450)]


def request(lot, zfa, storeys, mix=RENTAL, district='R7A', overlay='', outlines=None):
    average = sum(share * size for _, share, size in mix)
    units = int(zfa * 0.85 / average)
    out = {'lot': lot, 'district': district, 'overlay': overlay, 'plateSqft': zfa / storeys, 'unitsPerFloor': max(1, round(units / storeys)),
           'storeys': storeys, 'buildingUnits': units, 'zfa': zfa, 'name': 'Typical floor',
           'mix': [{'name': layout.TYPE_NAMES[t], 'type': t, 'share': s, 'targetSqft': a} for t, s, a in mix]}
    if outlines:
        out['outlines'] = outlines
    return out


# Varied lots and districts: a 25 by 100 interior lot, a 50 ft lot, a wide corner lot on a commercial
# overlay, a through lot, a trapezoid and a skewed lot.
LOTS = {
    '25x100 interior R6B': request({'frontFeet': 25, 'depthFeet': 100, 'lotType': 'interior'}, 5500, 4, district='R6B'),
    '50x100 interior R7A': request({'frontFeet': 50, 'depthFeet': 100, 'lotType': 'interior'}, 18000, 6),
    '50x100 interior R7A condo': request({'frontFeet': 50, 'depthFeet': 100, 'lotType': 'interior'}, 18000, 6, CONDO),
    '100x100 corner R8 C2-5': request({'frontFeet': 100, 'depthFeet': 100, 'lotType': 'corner'}, 54000, 9, district='R8', overlay='C2-5'),
    '100x60 interior R8': request({'frontFeet': 100, 'depthFeet': 80, 'lotType': 'interior'}, 54000, 9, district='R8'),
    '150x150 interior R8': request({'frontFeet': 150, 'depthFeet': 150, 'lotType': 'interior'}, 100000, 10, district='R8'),
    '50x200 through R7A': request({'frontFeet': 50, 'depthFeet': 200, 'lotType': 'through'}, 36000, 6),
    'trapezoid R7A': request({'polygon': [[0, 0], [60, 0], [60, 110], [0, 80]], 'streets': [[[0, 0], [60, 0]]]}, 3500 * 6, 6),
    'skewed R6A': request({'polygon': [[0, 0], [75, 10], [70, 100], [-5, 95]], 'streets': [[[0, 0], [75, 10]]]}, 3600 * 6, 6, district='R6A'),
}
RESULTS = {}


def result(name):
    if name not in RESULTS:
        RESULTS[name] = layout.typical_floor(LOTS[name])
    return RESULTS[name]


FIXTURES = {}


def fixture_request(fixture, name):
    """One outline fixture's site and the typical floor request for its option's floor area and storeys: (site, request)."""
    with open(os.path.join(HERE, 'fixtures', fixture)) as handle:
        site = json.load(handle)[name]
    zfa = site['program']['zfa'] if 'reserveStoreys' in site else sum(s['zfaBudgetSqft'] for s in site['storeys'])
    storeys = site['program']['storeys'] if 'reserveStoreys' in site else len(site['storeys'])
    lot = {'frontFeet': site['lot']['widthFeet'], 'depthFeet': site['lot']['depthFeet'], 'lotType': site['lot']['type']}
    return site, request(lot, zfa, storeys, district=site['district'], outlines=site)


def fixture_result(fixture, name):
    """One outline fixture's site and the floors drawn on it at its option's floor area and storeys: (site, out)."""
    if (fixture, name) not in FIXTURES:
        site, req = fixture_request(fixture, name)
        FIXTURES[(fixture, name)] = site, layout.typical_floor(req)
    return FIXTURES[(fixture, name)]


class Rules(unittest.TestCase):
    def test_every_rule_is_cited_and_assumptions_are_marked(self):
        for rule in layout.RULES.values():
            self.assertTrue(rule.cite, rule.id)
            self.assertIn(rule.basis, ('law', 'assumption'))
            if rule.basis == 'law':
                self.assertRegex(rule.cite, r'(BC|MDL|ZR|HMC) ', rule.id)

    def test_sourced_thresholds(self):
        values = {k: r.value for k, r in layout.RULES.items()}
        self.assertEqual(values['glazing'], 0.10)
        self.assertEqual(values['window_distance'], 20)
        self.assertEqual(values['room_depth'], 30)
        self.assertEqual(values['living_room'], 150)
        self.assertEqual(values['room_area'], 80)
        self.assertEqual(values['room_width'], 8)
        self.assertEqual(values['travel'], 200)
        self.assertEqual(values['common_path'], 125)
        self.assertEqual(values['dead_end'], 40)
        self.assertEqual(values['elevator'], 5)


class Templates(unittest.TestCase):
    def test_each_unit_type_at_a_standard_bay_meets_room_sizes(self):
        for beds, width, depth in ((0, 15, 28), (1, 21, 27), (2, 30, 27), (3, 42, 28), (2, 30, 21)):
            rooms = layout.unit_rooms(beds, width, depth)
            self.assertIsNotNone(rooms, (beds, width, depth))
            kinds = [k for _, k, _ in rooms]
            self.assertEqual(kinds.count('bedroom'), beds)
            self.assertGreaterEqual(kinds.count('bath'), 1)
            living = next(p for _, k, p in rooms if k == 'living')
            self.assertGreaterEqual(living.area, 150)
            for _, kind, poly in rooms:
                if kind == 'bedroom':
                    self.assertGreaterEqual(poly.area, 80)
                    self.assertTrue(layout.least_dimension(poly, 8))
                if kind in ('living', 'bedroom'):
                    self.assertAlmostEqual(poly.bounds[1], 0, msg='every habitable room reaches the window wall')
            self.assertAlmostEqual(sum(p.area for _, _, p in rooms), width * depth, places=3)

    def test_a_corner_unit_takes_a_bedroom_onto_its_side_wall(self):
        self.assertIsNone(layout.unit_rooms(3, 34, 28))
        rooms = layout.unit_rooms(3, 34, 28, corner=True)
        side = [p for _, k, p in rooms if k == 'bedroom' and p.bounds[0] == 0 and p.bounds[1] > 0]
        self.assertEqual(len(side), 1, 'one bedroom sits on the s = 0 face, off the window wall')

    def test_a_deep_unit_keeps_its_rooms_within_30_ft_and_puts_a_foyer_and_closets_behind(self):
        for beds, width in ((0, 15), (1, 21), (2, 30), (3, 42)):
            rooms = layout.unit_rooms(beds, width, 37)
            self.assertIsNotNone(rooms, beds)
            for name, kind, poly in rooms:
                if kind in ('living', 'bedroom'):
                    self.assertLessEqual(poly.bounds[3], 30 + 1e-6, f'{beds} beds: {name} reaches past 30 ft')
            foyer = next(p for n, k, p in rooms if n == 'Foyer')
            self.assertAlmostEqual(foyer.bounds[3], 37)
            self.assertTrue(foyer.touches(next(p for _, k, p in rooms if k == 'living')), 'the entrance foyer opens into the living room')
            self.assertAlmostEqual(sum(p.area for _, _, p in rooms), width * 37, places=3)

    def test_a_unit_barely_deeper_than_30_ft_gets_a_foyer_a_hall_deep_not_a_sliver(self):
        for beds, width in ((0, 15), (1, 21), (2, 30), (3, 42)):
            rooms = layout.unit_rooms(beds, width, 30.6)
            self.assertIsNotNone(rooms, beds)
            for name, kind, poly in rooms:
                if kind in ('living', 'bedroom'):
                    self.assertLessEqual(poly.bounds[3], 30 + 1e-6, f'{beds} beds: {name} reaches past 30 ft')
                if kind in ('hall', 'closet') and poly.bounds[3] > 30.6 - 1e-6:
                    self.assertGreaterEqual(poly.bounds[3] - poly.bounds[1], layout.T.hall - 1e-6, f'{beds} beds: {name} is a sliver')
            self.assertAlmostEqual(sum(p.area for _, _, p in rooms), width * 30.6, places=3)

    def test_too_narrow_or_shallow_units_are_refused(self):
        self.assertIsNone(layout.unit_rooms(1, 15, 27))
        self.assertIsNone(layout.unit_rooms(3, 45, 18))


class Floors(unittest.TestCase):
    def test_a_part_set_back_behind_an_open_area_fronts_its_street_not_a_lot_line(self):
        # A through lot's part that stops 12 ft short of its street line: no face is on the street, and the
        # plates are laid out from the open face nearest it, never from the longer side lot line.
        site = layout.Site(Polygon([(0, 0), (50, 0), (50, 100), (0, 100)]), unary_union([LineString([(0, 100), (50, 100)])]),
                           Polygon([(0, 0), (50, 0), (50, 88), (0, 88)]), 'R8', '')
        self.assertFalse([f for f in site.faces() if f[1] == 'street'])
        drafts = layout.candidates(site, 4000, 8)
        self.assertTrue(drafts)
        for d in drafts:
            self.assertAlmostEqual(d.plate.bounds[3], 88, delta=0.5)

    def test_floors_validate_and_meet_the_code_and_zoning_checks(self):
        for name in LOTS:
            with self.subTest(name):
                out = result(name)
                self.assertEqual(architecture.validate(out['plan']), [])
                report = out['report']
                failed = [c for c in report['checks'] if not c['pass'] and c['basis'] == 'law']
                self.assertEqual(failed, [], f"{name}: {[(c['rule'], c['value'], c.get('note')) for c in failed]}")
                self.assertGreater(report['unitsPerFloor'], 0)
                self.assertGreater(report['netToGross'], 0.55)
                self.assertGreater(report['score']['candidates'], 20)
                self.assertIn('chosen from', report['why']['summary'])
                self.assertTrue(report['why']['satisfied'] and report['why']['architect'])

    def test_lot_shape_picks_the_typology(self):
        # On a 25 ft lot the corridor runs across the lot from the core, a unit on the street and one on the rear yard
        # each floor: all eight units whole, where a central core holds six and leaves two spaces too small for a unit.
        self.assertEqual(result('25x100 interior R6B')['report']['layout'], 'double-loaded corridor')
        self.assertEqual(result('25x100 interior R6B')['report']['unitsDrawn'], 8)
        self.assertEqual(result('50x100 interior R7A')['report']['layout'], 'central core')
        self.assertEqual(result('100x60 interior R8')['report']['layout'], 'double-loaded corridor')
        self.assertIn(result('150x150 interior R8')['report']['layout'], ('L-plan', 'courtyard', 'double-loaded corridor'))

    def test_windows_only_on_streets_yards_and_courts(self):
        """No window is drawn on a wall along a side lot line, and every habitable room has one."""
        out = result('50x100 interior R7A')
        plan = out['plan']
        walls = {w['id']: w for w in plan['walls']}
        for o in plan['openings']:
            if o['kind'] != 'window':
                continue
            w = walls[o['wallId']]
            xs = [w['start'][0] / architecture.FOOT, w['end'][0] / architecture.FOOT]
            self.assertFalse(all(abs(x) < 0.1 for x in xs) or all(abs(x - 50) < 0.1 for x in xs), f'window on a side lot line: {w}')
        habitable = [r for r in plan['rooms'] if any(k in r['name'] for k in ('living', 'Living', 'bedroom'))]
        lit = set()
        for o in plan['openings']:
            if o['kind'] == 'window':
                line = LineString([walls[o['wallId']]['start'], walls[o['wallId']]['end']])
                lit |= {r['id'] for r in habitable if Polygon(r['polygon']).exterior.distance(line.interpolate(0.5, normalized=True)) < 0.05 or Polygon(r['polygon']).exterior.intersection(line.buffer(0.01)).length > 0.5}
        self.assertEqual(lit, {r['id'] for r in habitable})

    def test_corner_lot_has_corner_units_and_retail_at_grade(self):
        report = result('100x100 corner R8 C2-5')['report']
        self.assertIn('corner unit', report['why']['summary'])
        self.assertTrue(report['programs']['commercialOverlay'])
        self.assertTrue(report['programs']['ground'][0]['name'].startswith('Retail'))
        self.assertGreater(report['programs']['bikeSpaces'], 0)

    def test_skewed_lot_is_drawn_in_its_own_orientation(self):
        plan = result('skewed R6A')['plan']
        lot = Polygon([(x * architecture.FOOT, z * architecture.FOOT) for x, z in [[0, 0], [75, 10], [70, 100], [-5, 95]]]).buffer(0.01)
        for room in plan['rooms']:
            self.assertTrue(lot.contains(Polygon(room['polygon'])), room['name'])

    def test_floor_area_stays_within_the_schemes_budget(self):
        for name in LOTS:
            report = result(name)['report']
            self.assertLessEqual(report['plate']['sqft'], LOTS[name]['plateSqft'] * 1.031, name)


class TaxMapKinks(unittest.TestCase):
    """Tax-map lot lines carry hairline kinks; the floor must still draw every room edge as a wall, once."""

    def test_kinked_front_lines_draw_clean_walls(self):
        lots = {
            'step': ([[0, 0], [14.6, 0], [14.6, 0.01], [50, 0.01], [50, 106], [0, 106]], [[[0, 0], [14.6, 0]], [[14.6, 0.01], [50, 0.01]]]),
            'kink': ([[0, 0.01], [25, -0.01], [50, 0.012], [50, 106], [0, 106]], [[[0, 0.01], [25, -0.01]], [[25, -0.01], [50, 0.012]]]),
            'tilt': ([[0, 0], [50, 0.03], [50.02, 106], [0, 106.01]], [[[0, 0], [50, 0.03]]]),
            'out of square': ([[47.9, 0], [47.9, 104.04], [0, 104.1], [0, 0.07]], [[[0, 0.07], [47.9, 0]]]),
            'corner off square': ([[0, 0.26], [80.25, 0], [80.25, 111.42], [0, 111.68]], [[[0, 0.26], [80.25, 0]], [[80.25, 0], [80.25, 111.42]]]),
        }
        for name, (polygon, streets) in lots.items():
            with self.subTest(name):
                plan = layout.typical_floor(request({'polygon': polygon, 'streets': streets}, 12000, 4, district='R6'))['plan']
                self.assertEqual(architecture.validate(plan), [])
                lines = [(w['levelId'], LineString([w['start'], w['end']])) for w in plan['walls']]
                for i, (level, a) in enumerate(lines):
                    self.assertGreater(a.length, 0.05, f'{name}: a wall shorter than 5 cm')
                    for _, b in [x for x in lines[:i] if x[0] == level]:
                        self.assertLess(a.buffer(0.001, cap_style='flat').intersection(b).length, 0.01, f'{name}: two walls run along each other')


class Egress(unittest.TestCase):
    def test_single_exit_only_where_the_code_allows_it(self):
        small = layout.typical_floor(request({'frontFeet': 25, 'depthFeet': 100, 'lotType': 'interior'}, 1700 * 6, 6, district='R6A'))
        exits = next(c for c in small['report']['checks'] if c['rule'] in ('exits', 'single_exit'))
        self.assertTrue(exits['pass'])
        if exits['value'] == 1:
            self.assertEqual(exits['rule'], 'single_exit', 'a one-stair floor cites the single exit rule')
        big = result('50x100 interior R7A')['report']
        exits = next(c for c in big['checks'] if c['rule'] == 'exits')
        self.assertGreaterEqual(exits['value'], 2, 'over 2,000 sq ft a storey takes two exits')

    def test_a_scissor_stair_counts_as_two_exits_with_its_doors_15_ft_apart(self):
        report = result('50x100 interior R7A')['report']
        exits = next(c for c in report['checks'] if c['rule'] == 'exits')
        if 'scissor' in (exits.get('note') or ''):
            self.assertIn('exception 3', exits['note'])
            separation = next(c for c in report['checks'] if c['rule'] == 'exit_separation')
            self.assertGreaterEqual(separation['value'], 15)


class DwellingUnits(unittest.TestCase):
    def test_units_stay_within_the_dwelling_unit_factor(self):
        # 680 x 7.5 sq ft permits 7 units (a half rounds down); 680 x 7.75 permits 8 (three quarters rounds up).
        for zfa, cap in ((680 * 7.5, 7), (680 * 7.75, 8)):
            report = layout.typical_floor(request({'frontFeet': 25, 'depthFeet': 100, 'lotType': 'interior'}, zfa, 4, district='R6B'))['report']
            check = next(c for c in report['checks'] if c['rule'] == 'dwelling_units')
            self.assertEqual(check['limit'], cap)
            self.assertTrue(check['pass'])
            self.assertLessEqual(report['unitsDrawn'], cap)


    def test_the_envelope_sets_the_cap_and_no_factor_means_no_cap(self):
        with open(os.path.join(HERE, 'fixtures', 'outlines.json')) as handle:
            site = json.load(handle)['interior-25x100-R6B']
        req = request({'frontFeet': 25, 'depthFeet': 100, 'lotType': 'interior'}, 5500, 4, outlines=site)
        permitted, factor = site['zoningFloorArea']['allowedSqft'], site['density']['dwellingUnitFactor']
        self.assertEqual(layout.unit_cap(req), int(permitted / factor) + (1 if permitted / factor % 1 >= 0.75 else 0))
        req['outlines'] = {**site, 'density': {**(site.get('density') or {}), 'dwellingUnitFactor': None, 'maxUnits': None}}
        self.assertIsNone(layout.unit_cap(req), 'no factor in the Manhattan Core or Downtown Brooklyn')


class Building(unittest.TestCase):
    def test_floor_area_is_spread_evenly_and_no_storey_takes_more_than_its_outline(self):
        self.assertEqual(layout.spread(9000, [4000, 4000, 4000]), [3000, 3000, 3000])
        self.assertEqual(layout.spread(9000, [4000, 4000, 2000]), [3500, 3500, 2000])

    def test_units_are_spread_over_the_storeys_to_sum_to_the_schemes_count(self):
        fills = lambda scores: {c: {'score': s, 'ok': ok} for c, (s, ok) in scores.items()}
        plates = [{'best': 10, 'fills': fills({9: (80, True), 10: (90, True), 11: (85, True), 12: (40, False)})},
                  {'best': 8, 'fills': fills({7: (70, True), 8: (75, True), 9: (60, True)})}]
        counts = layout.allocate(plates, [0, 0, 0, 0, 1], 49)
        self.assertEqual(sum(counts), 49)
        self.assertEqual(counts, [11, 10, 10, 10, 8], 'a unit goes where it costs the least score, the lowest storey first')
        self.assertEqual(sum(layout.allocate(plates, [0, 0, 0, 0, 1], 60)), 53, 'a count the plates cannot hold stops at what they hold')

    def test_every_unit_keeps_corridor_wall_for_its_door(self):
        # A core blocks the corridor wall from 22 to 42 ft. In 66 ft the middle unit takes wall for its door from a
        # neighbour that keeps the one bedroom's 20 ft window wall.
        t = layout.UnitType('1 bedroom', 1, 1.0, 600, 'oneBedroom')
        runs = [(0, 22), (42, 66)]
        reach = lambda a, b: sum(max(0, min(b, y) - max(a, x)) for x, y in runs)
        bay = layout.Bay(layout.Frame((0, 0), (1, 0), (0, 1)), 0, 66, 0, 30, True)
        bay.units = [(t, 0, 22), (t, 22, 44), (t, 44, 66)]
        layout.give_entries(bay, runs)
        self.assertTrue(all(reach(a, b) >= layout.ENTRY for _, a, b in bay.units), bay.units)
        self.assertTrue(all(b - a >= layout.min_width(1) for _, a, b in bay.units), bay.units)
        self.assertEqual((bay.units[0][1], bay.units[-1][2]), (0, 66))
        # In 60 ft no neighbour can spare the wall without going below its rooms' width, so none is squeezed: the
        # floor then holds the two units that have doors (place_units), each widened.
        runs = [(0, 20), (42, 60)]
        bay = layout.Bay(layout.Frame((0, 0), (1, 0), (0, 1)), 0, 60, 0, 30, True)
        bay.units = [(t, 0, 20), (t, 20, 40), (t, 40, 60)]
        layout.give_entries(bay, runs)
        self.assertTrue(all(b - a >= layout.min_width(1) for _, a, b in bay.units), bay.units)
        hall = Polygon([(0, 30), (60, 30), (60, 35.5), (0, 35.5)]).difference(Polygon([(20, 30), (42, 30), (42, 35.5), (20, 35.5)]))
        draft = layout.Draft('test', Polygon([(0, 0), (60, 0), (60, 35.5), (0, 35.5)]),
                             bays=[layout.Bay(layout.Frame((0, 0), (1, 0), (0, 1)), 0, 60, 0, 30, True)], corridors=[(hall, LineString([(0, 32.75), (60, 32.75)]))])
        self.assertEqual(layout.place_units(draft, [t, t, t]), 2)
        for u in draft.params['units']:
            us = [u['frame'].local(x, z)[0] for x, z in u['outline'].exterior.coords]
            self.assertGreaterEqual(reach(min(us), max(us)), layout.ENTRY)
            self.assertGreaterEqual(max(us) - min(us), layout.min_width(1))

    def test_a_through_lot_draws_a_building_on_each_street(self):
        with open(os.path.join(HERE, 'fixtures', 'outlines.json')) as handle:
            site = json.load(handle)['through-40x200-R6B']
        zfa = sum(s['zfaBudgetSqft'] for s in site['storeys'])
        out = layout.typical_floor(request({'frontFeet': 40, 'depthFeet': 200, 'lotType': 'through'}, zfa, len(site['storeys']), district='R6B', outlines=site))
        doc, report = out['plan'], out['report']
        self.assertEqual(architecture.validate(doc), [])
        level = next(l for l in doc['levels'] if l['use'] == 'residential')
        stairs = [Polygon(r['polygon']) for r in doc['rooms'] if r['levelId'] == level['id'] and r['kind'] == 'stair']
        halves = {'front' if s.centroid.y < 100 * architecture.FOOT else 'rear' for s in stairs}
        self.assertEqual(halves, {'front', 'rear'}, 'each building has its own stair')
        self.assertGreaterEqual(report['drawn']['zfaSqft'], zfa * 0.97, 'the two buildings hold the floor area one could not')
        ids = [r['unitId'] for r in doc['rooms'] if r['levelId'] == level['id'] and 'unitId' in r]
        self.assertEqual(len(set(ids)), len({(r['unitId'], r['name'].split()[1]) for r in doc['rooms'] if r['levelId'] == level['id'] and 'unitId' in r}), 'unit ids are unique on a level shared by two buildings')
        self.assertEqual(report['drawn']['units'], sum(len({r['unitId'] for r in doc['rooms'] if r['levelId'] == l['id'] and 'unitId' in r}) * len(l['storeys']) for l in doc['levels']))

    def test_storeys_recovered_above_the_stack_and_lots_in_portions_are_drawn_on_their_own_outlines(self):
        with open(os.path.join(HERE, 'fixtures', 'outlines-portions.json')) as handle:
            sites = json.load(handle)
        for name in ('l-shaped-R7A-recovered', 'split-100x100-R6-R7A'):
            with self.subTest(name):
                site = sites[name]
                found = layout.outline_source.storey_outlines(site)
                req = request({'frontFeet': site['lot']['widthFeet'], 'depthFeet': site['lot']['depthFeet'], 'lotType': site['lot']['type']},
                              site['program']['zfa'], site['program']['storeys'], district=site['district'], outlines=site)
                out = layout.typical_floor(req)
                doc, report = out['plan'], out['report']
                self.assertEqual(architecture.validate(doc), [])
                drawn = [st['id'] for l in doc['levels'] if l['use'] != 'cellar' for st in l['storeys']]
                self.assertEqual(drawn, [f'storey-{o.index + 1}' for o in found], 'every storey of the stack is drawn, the recovered ones too')
                self.assertTrue(next(c for c in report['checks'] if c['rule'] == 'storey_outlines')['pass'])
                self.assertEqual([c['rule'] for c in report['checks'] if not c['pass'] and c['basis'] == 'law'], [])
        self.assertGreater(len(layout.outline_source.storey_outlines(sites['l-shaped-R7A-recovered'])), sites['l-shaped-R7A-recovered']['program']['storeys'])

    def test_the_zoning_sheet_never_finds_more_floor_area_than_the_scheme_is_priced_on(self):
        # Measured as the zoning sheet accounts it; on plain lots the floors also hold all but 3 percent of it.
        # The wide C6-2 lot steps from 70 whole units on 97.0 percent of its floor area (to the square foot, a little
        # under) to 84 units 1.3 percent over as its plates grow, so it is not among them.
        for fixture, held in (('outlines.json', {'interior-25x100-R6B', 'skewed-50ft-R7A', 'through-40x200-R6B'}),
                              ('outlines-portions.json', {'split-100x100-R6-R7A'})):
            with open(os.path.join(HERE, 'fixtures', fixture)) as handle:
                names = list(json.load(handle))
            for name in names:
                with self.subTest(name):
                    site, out = fixture_result(fixture, name)
                    zfa = site['program']['zfa'] if 'reserveStoreys' in site else sum(s['zfaBudgetSqft'] for s in site['storeys'])
                    drawn = layout.zoning_floor_area(out['plan'], site)
                    self.assertEqual(out['report']['drawn']['zfaSqft'], round(drawn))
                    self.assertLessEqual(drawn, zfa + 1)
                    if name in held:
                        self.assertGreaterEqual(drawn, zfa * 0.97)

    def test_a_floor_at_an_angle_to_the_street_draws_each_wall_once_and_only_whole_stairs(self):
        with open(os.path.join(HERE, 'fixtures', 'outlines-slanted.json')) as handle:
            site = json.load(handle)['split-110x132-R4-R6-slanted']
        out = layout.typical_floor(request({'frontFeet': 110, 'depthFeet': 132, 'lotType': 'interior'}, site['program']['zfa'], site['program']['storeys'], district='R4', outlines=site))
        doc = out['plan']
        self.assertEqual(architecture.validate(doc), [])
        for r in doc['rooms']:
            if r['kind'] in ('stair', 'elevator'):
                poly = Polygon(r['polygon'])
                self.assertGreaterEqual(poly.area, 0.98 * poly.minimum_rotated_rectangle.area, f"{r['name']} is whole")
        self.assertLessEqual(layout.zoning_floor_area(doc, site), site['program']['zfa'] + 1)
        # Its whole package builds: the cover sheet of an R4 portion with a maximum base height and no minimum.
        import tempfile, run
        built = run.run_detailed({**doc, 'id': 'plan-slanted', 'revision': 1, 'parentRevision': None, 'zoning': site}, tempfile.mkdtemp(), True)
        self.assertIn('package', built['artifacts'])
        # Its whole package builds: the cover sheet of an R4 portion with a maximum base height and no minimum.
        import tempfile, run
        out_dir = tempfile.mkdtemp()
        built = run.run_detailed({**doc, 'id': 'plan-slanted', 'revision': 1, 'parentRevision': None, 'zoning': site}, out_dir, True)
        self.assertIn('package', built['artifacts'])

    def test_raising_the_stack_keeps_the_lawful_drawing_holding_the_most_not_the_last_one_tried(self):
        # On this slanted split lot the storeys above the fourth hold no whole stair, so taller stacks end there
        # with smaller plates; the drawing kept meets every code check and holds at least the four-storey stack.
        with open(os.path.join(HERE, 'fixtures', 'outlines-slanted.json')) as handle:
            site = json.load(handle)['split-110x132-R4-R6-slanted']
        req = request({'frontFeet': 110, 'depthFeet': 132, 'lotType': 'interior'}, site['program']['zfa'], site['program']['storeys'], district='R4', outlines=site)
        out = layout.typical_floor(req)
        self.assertEqual([c['rule'] for c in out['report']['checks'] if not c['pass'] and c['basis'] == 'law'], [])
        four = layout.typical_floor({**req, 'stackStoreys': 4, 'grossScale': 1.0})
        self.assertEqual([c['rule'] for c in four['report']['checks'] if not c['pass'] and c['basis'] == 'law'], [])
        self.assertGreaterEqual(layout.zoning_floor_area(out['plan'], site), layout.zoning_floor_area(four['plan'], site))
        self.assertEqual(out['report']['drawn']['zfaSqft'], round(layout.zoning_floor_area(out['plan'], site)))

    def test_a_taller_stack_over_the_floor_area_is_drawn_with_smaller_floors_not_passed_over(self):
        # With apartments at grade, this corner lot's six storeys hold 87 percent of the floor area and seven hold
        # just over all of it: the seven-storey stack is drawn with smaller floors instead of keeping the six.
        with open(os.path.join(HERE, 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['corner-80x112-R7D-recovered']
        mix = [('studio', 0.30, 465), ('oneBedroom', 0.46, 667), ('twoBedroom', 0.24, 949)]
        req = {**request({'frontFeet': 80, 'depthFeet': 112, 'lotType': 'corner'}, site['program']['zfa'], site['program']['storeys'], mix, 'R7D', 'C2-4', site), 'groundRetail': False}
        out = layout.typical_floor(req)
        held = layout.zoning_floor_area(out['plan'], site)
        self.assertGreaterEqual(held, site['program']['zfa'] * 0.97)
        self.assertLessEqual(held, site['program']['zfa'])
        self.assertEqual(out['report']['drawn']['zfaSqft'], round(held))
        self.assertEqual([c['rule'] for c in out['report']['checks'] if not c['pass'] and c['basis'] == 'law'], [])

    def test_storeys_behind_a_setback_get_their_own_plate_with_the_core_stacked(self):
        with open(os.path.join(HERE, 'fixtures', 'outlines.json')) as handle:
            site = json.load(handle)['corner-100x125-R8']
        zfa = sum(s['zfaBudgetSqft'] for s in site['storeys'])
        out = layout.typical_floor(request({'frontFeet': 100, 'depthFeet': 125, 'lotType': 'corner'}, zfa, len(site['storeys']), district='R8', outlines=site))
        doc, report = out['plan'], out['report']
        self.assertEqual(architecture.validate(doc), [])
        self.assertGreater(len(doc['levels']), 1)
        self.assertEqual(sum(len(l['storeys']) for l in doc['levels'] if l['use'] != 'cellar'), len(site['storeys']))
        cores = {l['id']: sorted(tuple(round(c, 1) for c in Polygon(r['polygon']).bounds) for r in doc['rooms'] if r['levelId'] == l['id'] and r['kind'] in ('stair', 'elevator')) for l in doc['levels']}
        self.assertEqual(len(set(map(tuple, cores.values()))), 1, 'stairs and elevator sit in the same place on every level')
        self.assertTrue(next(c for c in report['checks'] if c['rule'] == 'core_stack')['pass'])
        self.assertTrue(next(c for c in report['checks'] if c['rule'] == 'storey_outlines')['pass'])
        units = sum(len({r['unitId'] for r in doc['rooms'] if r['levelId'] == l['id'] and 'unitId' in r}) * len(l['storeys']) for l in doc['levels'])
        self.assertEqual(units, report['unitsDrawn'])
        self.assertEqual(report['drawn']['units'], units)


class GroundAndCellar(unittest.TestCase):
    def rooms(self, doc, use):
        level = next(l for l in doc['levels'] if l['use'] == use)
        return [r for r in doc['rooms'] if r['levelId'] == level['id']]

    def test_the_ground_floor_holds_the_lobby_refuse_room_and_units_and_the_cellar_the_service_rooms(self):
        out = result('50x100 interior R7A')
        doc = out['plan']
        ground = {r['kind'] for r in self.rooms(doc, 'ground')}
        self.assertLessEqual({'lobby', 'refuse', 'stair', 'corridor'}, ground)
        self.assertIn('living', ground, 'units fill the ground floor behind the lobby off a commercial overlay')
        self.assertNotIn('retail', ground)
        cellar = self.rooms(doc, 'cellar')
        self.assertLessEqual({'mechanical', 'bike', 'stair'}, {r['kind'] for r in cellar})
        self.assertFalse(any('unitId' in r for r in cellar))
        mech = sum(Polygon(r['polygon']).area for r in cellar if r['kind'] == 'mechanical') / architecture.FOOT ** 2
        self.assertGreaterEqual(mech, 0.03 * LOTS['50x100 interior R7A']['zfa'] * 0.97)
        lobby = next(r for r in self.rooms(doc, 'ground') if r['kind'] == 'lobby')
        walls = {w['id'] for w in doc['walls'] if LineString([w['start'], w['end']]).distance(Polygon(lobby['polygon'])) < 0.01}
        self.assertTrue(any(o['kind'] == 'door' and o['wallId'] in walls for o in doc['openings']), 'the lobby has its doors')

    def test_on_a_commercial_overlay_retail_takes_the_ground_floor_as_the_deal_model_prices_it(self):
        doc = result('100x100 corner R8 C2-5')['plan']
        ground = self.rooms(doc, 'ground')
        kinds = {r['kind'] for r in ground}
        self.assertLessEqual({'lobby', 'refuse', 'retail'}, kinds)
        self.assertFalse(any('unitId' in r for r in ground))
        self.assertEqual(result('100x100 corner R8 C2-5')['report']['levels'][1]['units'], 0)
        # Every shop door is on a wall that faces a street; a shop space with no street front is a stock room off the corridor.
        streets = [LineString([(0, 0), (100 * architecture.FOOT, 0)]), LineString([(0, 0), (0, 100 * architecture.FOOT)])]
        walls = {w['id']: w for w in doc['walls']}

        def middle(o):
            w = walls[o['wallId']]
            return LineString([w['start'], w['end']]).interpolate(o['offset'] + o['width'] / 2)
        for r in ground:
            if r['kind'] != 'retail':
                continue
            doors = [middle(o) for o in doc['openings'] if o['kind'] == 'door' and Polygon(r['polygon']).exterior.distance(middle(o)) < 0.05]
            on_street = [d for d in doors if min(s.distance(d) for s in streets) < 0.3]
            if r['name'] == 'Retail':
                self.assertTrue(on_street, f"{r['name']} {r['id']} has a street door")
            else:
                self.assertEqual(r['name'], 'Retail stock room')
                self.assertFalse(on_street, 'a stock room has no street door')

    def test_a_ground_floor_priced_as_apartments_draws_apartments_on_a_commercial_overlay(self):
        doc = layout.typical_floor({**LOTS['100x100 corner R8 C2-5'], 'groundRetail': False})['plan']
        kinds = {r['kind'] for r in self.rooms(doc, 'ground')}
        self.assertNotIn('retail', kinds)
        self.assertLessEqual({'lobby', 'living'}, kinds, 'a city-financed building has no retail income, so its ground floor holds units')


class Units(unittest.TestCase):
    def test_every_unit_counted_is_drawn_with_its_rooms(self):
        # A bay too narrow or shallow for a unit's rooms, or a plate edge that cuts them away, leaves no apartment:
        # every unit the plan counts has its living room, a whole bath and a bedroom for each it is sold with, and
        # the plan, its report and its zoning sheet count the same units.
        cases = [(name, None, result(name)) for name in LOTS]
        for fixture in ('outlines.json', 'outlines-portions.json', 'outlines-slanted.json'):
            with open(os.path.join(HERE, 'fixtures', fixture)) as handle:
                names = list(json.load(handle))
            cases += [(f'{fixture} {name}', *fixture_result(fixture, name)) for name in names]
        sqft = lambda r: Polygon(r['polygon']).area / architecture.FOOT ** 2
        for name, site, out in cases:
            with self.subTest(name):
                doc = out['plan']
                storeys = {level['id']: len(level.get('storeys') or [None]) for level in doc['levels']}
                units = {}
                for r in doc['rooms']:
                    if 'unitId' in r:
                        units.setdefault((r['levelId'], r['unitId']), []).append(r)
                for (level, unit), rooms in units.items():
                    kinds = [r['kind'] for r in rooms]
                    what = f"{unit} on {level}: {[(r['name'], round(sqft(r))) for r in rooms]}"
                    self.assertEqual(kinds.count('living'), 1, what)
                    self.assertEqual(kinds.count('bedroom'), rooms[0]['beds'], what)
                    self.assertTrue([r for r in rooms if r['kind'] == 'bath'], what)
                    self.assertGreaterEqual(min(sqft(r) for r in rooms if r['kind'] == 'bath'), 5 * 8, what)
                counted = sum(storeys[level] for level, _ in units)
                self.assertEqual(out['report']['unitsDrawn'], counted)
                # The spaces drawn in their place are counted on every storey of every building, not one floor's.
                spaces = sum(storeys[r['levelId']] for r in doc['rooms'] if r['name'] == layout.SPACE)
                short = next((c for c in out['report']['checks'] if c['rule'] == 'template'), None)
                self.assertEqual(int(short['value'].split()[0]) if short else 0, spaces)
                if site:
                    found = layout.outline_source.storey_outlines(site)
                    account = layout.zoning.account(site, found, drawn=layout.zd1.drawn_storeys(doc, found))
                    self.assertEqual(account['dwellingUnits']['units'], counted)


def mixed_types():
    """The MIXED mix as the layout builds it: shares summing to one, each type knowing its group's smaller types."""
    req = {'mix': [{'name': layout.TYPE_NAMES[t] + suffix, 'type': t, 'share': share, 'targetSqft': size} for t, suffix, share, size in MIXED]}
    return layout.unit_types(req)


class Affordable(unittest.TestCase):
    def test_each_floor_picks_the_affordable_share_to_within_half_a_unit(self):
        mix = mixed_types()
        for count in range(1, 16):
            picks = layout.pick_types(mix, count)
            affordable = sum(1 for t in picks if t.name.endswith('affordable'))
            self.assertLessEqual(abs(affordable - count * AFFORDABLE), 0.5, (count, [t.name for t in picks]))

    def test_a_floor_short_of_room_draws_the_first_picks_that_fit_whole_affordable_ones_among_them(self):
        # A 70 ft band holds a two bedroom and two one bedrooms at their narrowest, not the five units dealt to it: it
        # draws the first three the mix picks, one of them affordable, each at least its template's width.
        mix = mixed_types()
        bay = layout.Bay(layout.Frame((0, 0), (1, 0), (0, 1)), 0, 70, 0, 27, True)
        layout.assign_units([bay], layout.pick_types(mix, 5))
        self.assertEqual(sorted(t.name for t, _, _ in bay.units), ['1 bedroom', '1 bedroom, affordable', '2 bedroom'])
        self.assertTrue(all(b - a >= layout.min_width(t.beds) - 1e-6 for t, a, b in bay.units), bay.units)

    def test_a_unit_no_bay_holds_is_drawn_as_the_largest_smaller_type_of_its_group(self):
        mix = mixed_types()
        two = next(t for t in mix if t.name == '2 bedroom, affordable')
        bay = layout.Bay(layout.Frame((0, 0), (1, 0), (0, 1)), 0, 50, 0, 25, True)
        layout.assign_units([bay], [two, two])
        self.assertEqual(sorted(t.name for t, _, _ in bay.units), ['1 bedroom, affordable', '2 bedroom, affordable'])
        self.assertTrue(all(b - a >= layout.min_width(t.beds) - 1e-6 for t, a, b in bay.units), bay.units)

    def test_the_building_draws_its_affordable_share_to_within_half_a_unit_a_storey(self):
        for fixture, name in (('outlines.json', 'corner-100x125-R8'), ('outlines.json', 'wide-100x100-C6-2'), ('outlines-portions.json', 'split-100x100-R6-R7A')):
            with self.subTest(name):
                with open(os.path.join(HERE, 'fixtures', fixture)) as handle:
                    site = json.load(handle)[name]
                zfa = site['program']['zfa'] if 'reserveStoreys' in site else sum(s['zfaBudgetSqft'] for s in site['storeys'])
                storeys = site['program']['storeys'] if 'reserveStoreys' in site else len(site['storeys'])
                req = request({'frontFeet': site['lot']['widthFeet'], 'depthFeet': site['lot']['depthFeet'], 'lotType': site['lot']['type']}, zfa, storeys, district=site['district'], outlines=site)
                req['mix'] = [{'name': layout.TYPE_NAMES[t] + suffix, 'type': t, 'share': share, 'targetSqft': size} for t, suffix, share, size in MIXED]
                report = layout.typical_floor(req)['report']
                drawn = sum(m['count'] for m in report['mix'])
                affordable = sum(m['count'] for m in report['mix'] if m['name'].endswith('affordable'))
                self.assertGreater(drawn, 20)
                self.assertLessEqual(abs(affordable - drawn * AFFORDABLE), 0.5 * report['storeysDrawn'], f'{affordable} of {drawn} affordable')


class Outlines(unittest.TestCase):
    def test_the_floor_names_its_storeys_and_its_rooms_their_units(self):
        doc = result('50x100 interior R7A')['plan']
        cellar, *above = doc['levels']
        self.assertEqual((cellar['use'], cellar['elevation'], [s['name'] for s in cellar['storeys']]), ('cellar', round(-10 * architecture.FOOT, 4), ['Cellar']))
        self.assertEqual(above[0]['use'], 'ground')
        self.assertEqual({level['use'] for level in above[1:]}, {'residential'})
        self.assertEqual(above[0]['height'], round(10 * architecture.FOOT, 4))
        self.assertEqual([s['name'] for level in above for s in level['storeys']], ['Ground floor'] + [f'Level {i}' for i in range(2, 7)])
        self.assertEqual([s['elevation'] for level in above for s in level['storeys']], [round(i * 10 * architecture.FOOT, 4) for i in range(6)])
        units = [r for r in doc['rooms'] if 'unitId' in r]
        self.assertTrue(units)
        for r in units:
            self.assertTrue(r['name'].startswith(f"Unit {r['unitId'].split('-')[1]}"), r['name'])
            self.assertIn(r['unitType'], layout.BEDS)
            self.assertEqual(r['beds'], layout.BEDS[r['unitType']])
        self.assertEqual({r['kind'] for r in doc['rooms'] if 'unitId' not in r} & {'living', 'bedroom'}, set())
        self.assertLessEqual({'living', 'bath', 'corridor', 'stair'}, {r['kind'] for r in doc['rooms']})

    """The storey outlines of Thread A's fixtures (acres.outlines/1) as the region."""

    def test_layouts_on_storey_outlines(self):
        with open(os.path.join(HERE, 'fixtures', 'outlines.json')) as handle:
            sites = json.load(handle)
        for name, site in sites.items():
            with self.subTest(name):
                zfa = sum(s['zfaBudgetSqft'] for s in site['storeys'])
                req = request({'frontFeet': site['lot']['widthFeet'], 'depthFeet': site['lot']['depthFeet'], 'lotType': site['lot']['type']},
                              zfa, len(site['storeys']), district=site['district'], outlines=site)
                out = layout.typical_floor(req)
                self.assertEqual(architecture.validate(out['plan']), [])
                found = layout.outline_source.storey_outlines(site)
                self.assertEqual([s['elevation'] for level in out['plan']['levels'] if level['use'] != 'cellar' for s in level['storeys']], [round(o.bottom * architecture.FOOT, 4) for o in found][:len(site['storeys'])])
                failed = [c['rule'] for c in out['report']['checks'] if not c['pass'] and c['basis'] == 'law' and c['rule'] != 'storey_outlines']
                self.assertEqual(failed, [], name)
                # The floor is checked on every storey it repeats on; only storeys behind a setback may miss it.
                fit = next(c for c in out['report']['checks'] if c['rule'] == 'storey_outlines')
                setback = {o.label for o in layout.outline_source.storey_outlines(site) if any(c['control'] == 'setback' for c in o.shaped_by)}
                missed = set(fit['note'].split(' need')[0].split(', ')) if fit['note'] else set()
                self.assertLessEqual(missed, setback, name)
                inside = unary_union([region for _, region, _ in layout.floors_of(req)]).buffer(0.05)
                for room in out['plan']['rooms']:
                    pts = [(x / architecture.FOOT, y / architecture.FOOT) for x, y in room['polygon']]
                    self.assertTrue(inside.contains(Polygon(pts)), f"{name}: {room['name']} leaves the storey outline")



def planner_processes(args, body, seeds=('1', '2')):
    """What one planner command prints for the same stdin, in one process per hash seed run side by side."""
    work = tempfile.mkdtemp()
    with open(os.path.join(work, 'in.json'), 'w') as handle:
        handle.write(body)
    children = []
    for seed in seeds:
        with open(os.path.join(work, 'in.json')) as stdin, open(os.path.join(work, f'out-{seed}'), 'w') as stdout:
            children.append(subprocess.Popen([sys.executable, *args], cwd=HERE, stdin=stdin, stdout=stdout, env={**os.environ, 'PYTHONHASHSEED': seed}))
    assert [child.wait() for child in children] == [0] * len(seeds)
    outs = []
    for seed in seeds:
        with open(os.path.join(work, f'out-{seed}'), 'rb') as handle:
            outs.append(handle.read())
    return outs


class Determinism(unittest.TestCase):
    """A scheme's plan is a function of its request: redrawing it in another process draws the same plan."""

    def test_the_same_scheme_request_in_two_planner_processes_prints_byte_identical_plan_json(self):
        first, second = planner_processes(['run.py'], json.dumps({'typicalFloor': LOTS['150x150 interior R8']}))
        self.assertTrue(json.loads(first)['plan']['rooms'])
        self.assertEqual(first, second)

    def test_every_test_option_drawn_twice_is_identical(self):
        names = list(LOTS)
        requests = [{'typicalFloor': LOTS[name]} for name in names]
        for fixture in ('outlines.json', 'outlines-portions.json', 'outlines-slanted.json'):
            with open(os.path.join(HERE, 'fixtures', fixture)) as handle:
                found = list(json.load(handle))
            names += [f'{fixture} {name}' for name in found]
            requests += [{'typicalFloor': fixture_request(fixture, name)[1]} for name in found]
        driver = 'import json, sys\nfrom run import run\nfor r in json.load(sys.stdin):\n    print(json.dumps(run(r)))'
        first, second = [out.splitlines() for out in planner_processes(['-c', driver], json.dumps(requests))]
        self.assertEqual(len(first), len(names))
        for name, a, b in zip(names, first, second):
            with self.subTest(name):
                self.assertEqual(a, b)


class ExportedModel(unittest.TestCase):
    def test_walls_and_rooms_rise_to_the_underside_of_the_slab_above(self):
        # Each storey's slab above starts its thickness below the next floor, and the roof its thickness below the
        # top of the storey: the planner's walls and room volumes stop there, neither short of it nor inside it.
        _, out = fixture_result('outlines.json', 'interior-25x100-R6B')
        plan, out_dir = out['plan'], tempfile.mkdtemp()
        run({'plan': {**plan, 'revision': 1, 'parentRevision': None}, 'outDir': out_dir})
        model = ifcopenshell.open(os.path.join(out_dir, 'model.ifc'))
        with open(os.path.join(out_dir, 'idmap.json')) as handle:
            ids = json.load(handle)['elements']
        height = {level['id']: level['height'] for level in plan['levels']}
        for kind in ('walls', 'rooms'):
            for item in plan[kind]:
                shapes = model.by_guid(ids[item['id']]['ifcGlobalId']).Representation.Representations
                body = next(shape for shape in shapes if shape.RepresentationIdentifier == 'Body')
                top = max(solid.Position.Location.Coordinates[2] + solid.Depth for solid in body.Items)
                self.assertAlmostEqual(top, height[item['levelId']] - architecture.SLAB_THICKNESS, delta=0.001, msg=item['id'])


if __name__ == '__main__':
    unittest.main()
