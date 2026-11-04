"""Zoning floor area accounting and the ZD1-style sheet, over the varied fixture lots
(planning/fixtures/outlines.json: R6B, R7A, R8, C6-2; interior, skewed, corner, L-shaped, through)."""
import json
import os
import re
import tempfile
import unittest
import xml.etree.ElementTree as ET

from shapely.geometry import Polygon

import outlines
import zoning
from engine import storey_outlines
from exporters import zd1

with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines.json')) as handle:
    SITES = json.load(handle)


def typical(plate, corridor=300, refuse=60, bike=0, amenity=0, mechanical=80, units=6):
    spaces = [('corridor', corridor), ('stair', 220), ('elevator', 90), ('refuse', refuse), ('bicycle', bike), ('amenity', amenity), ('mechanical', mechanical)]
    drawn = [{'kind': k, 'areaSqft': a} for k, a in spaces if a]
    return drawn + [{'kind': 'unit', 'areaSqft': (plate - sum(a for _, a in spaces)) / units} for _ in range(units)]


class Accounting(unittest.TestCase):
    def test_an_undrawn_option_meets_its_budget_storey_by_storey(self):
        for name, site in SITES.items():
            with self.subTest(name):
                a = zoning.account(site, storey_outlines(site))
                self.assertEqual(a['overBudget'], [])
                for s in a['storeys']:
                    self.assertLessEqual(s['zfaSqft'], s['budgetSqft'] + zoning.BUDGET_TOLERANCE_SQFT)
                    self.assertTrue(all(e['section'].startswith('ZR ') for e in s['exclusions']))
                    self.assertTrue(all(e['basis'] == 'assumed' for e in s['exclusions']))
                self.assertLessEqual(a['far']['used'], a['far']['allowed'] + 0.01)

    def test_drawn_exclusions_follow_their_section_limits(self):
        site = SITES['corner-100x125-R8']
        found = storey_outlines(site)
        a = zoning.account(site, found, typical=typical(9000, refuse=200, bike=300, amenity=2000))
        units = a['dwellingUnits']['units']
        total = lambda kind, basis='drawn': sum(e['sqft'] for s in a['storeys'] for e in s['exclusions'] if e['kind'] == kind and e['basis'] == basis)
        self.assertLessEqual(total('refuse'), 3 * units + len(found), 'ZR 23-233: 3 sq ft per dwelling unit')
        self.assertLessEqual(total('bicycle'), 15 * a['bicycleParking']['required'] + len(found), 'ZR 25-85: 15 sq ft per required space')
        self.assertEqual(a['bicycleParking']['required'], units // 2)
        residential = sum(s['grossSqft'] for s in a['storeys'])
        self.assertLessEqual(total('amenity') + total('amenity', 'assumed'), 0.05 * residential + len(found), 'ZR 23-231: 5 percent of residential floor area')
        corridor = [e for e in a['storeys'][0]['exclusions'] if e['kind'] == 'corridor'][0]
        self.assertEqual(corridor['sqft'], 150, 'ZR 23-232: half the corridor where the farthest door is within 100 ft of the core')
        self.assertTrue(all(e['sqft'] == 80 for s in a['storeys'][:3] for e in s['exclusions'] if e['kind'] == 'mechanical'))

    def test_a_corridor_too_long_keeps_its_floor_area(self):
        # A 240 ft plate with a mid-plate core: the farthest door is 120 ft away, past ZR 23-232's 100 ft.
        site = json.loads(json.dumps(SITES['interior-25x100-R6B']))
        site['lot']['exterior'] = [[0, 0], [25, 0], [25, 240], [0, 240]]
        for s in site['storeys']:
            s['shapedBy'] = []
        a = zoning.account(site, storey_outlines(site), typical=typical(6000))
        self.assertFalse([e for s in a['storeys'] for e in s['exclusions'] if e['kind'] == 'corridor'])

    def test_a_floor_plate_larger_than_its_outline_is_flagged(self):
        site = SITES['skewed-50ft-R7A']
        a = zoning.account(site, storey_outlines(site), typical=typical(3800))
        self.assertIn('Ground', a['outsideOutline'], 'the rectangle plate does not fit the exact rear yard')
        self.assertNotIn('Ground', a['overBudget'], 'its exclusions still keep it within the storey budget')
        bigger = zoning.account(site, storey_outlines(site), typical=typical(4600))
        self.assertIn('Ground', bigger['overBudget'])
        self.assertGreater(bigger['storeys'][0]['overBudgetSqft'], 400)

    def test_a_storey_over_its_share_is_within_budget_while_the_building_is(self):
        # Zoning floor area is a limit on the zoning lot (ZR 23-22), not on each storey: a drawing whose ground floor
        # holds less than an even share of the option's floor area and whose upper floors hold more is within its
        # budget, and only a building over the option's floor area names the storeys over their share.
        site = SITES['interior-25x100-R6B']
        found = storey_outlines(site)
        drawn = lambda grosses: [{'name': name, 'use': 'residential', 'bottomFeet': 10.0 * i, 'heightFeet': 10.0, 'spaces': [{'kind': 'unit', 'areaSqft': gross}],
                                  'plate': Polygon([(0, 0), (25, 0), (25, gross / 25), (0, gross / 25)])}
                                 for i, (name, gross) in enumerate(zip(('Ground floor', 'Level 2', 'Level 3'), grosses))]
        within = zoning.account(site, found, drawn=drawn([1500, 1800, 1800]))
        self.assertLess(within['totals']['zfaSqft'], site['program']['zfa'])
        self.assertGreater(within['storeys'][1]['zfaSqft'], within['storeys'][1]['budgetSqft'] + zoning.BUDGET_TOLERANCE_SQFT)
        self.assertEqual(within['overBudget'], [])
        over = zoning.account(site, found, drawn=drawn([1800, 1800, 1800]))
        self.assertGreater(over['totals']['zfaSqft'], site['program']['zfa'])
        self.assertEqual(over['overBudget'], ['Ground floor', 'Level 2', 'Level 3'])

    def test_yards_are_measured_from_the_lot_lines_they_belong_to(self):
        for name in ('interior-25x100-R6B', 'skewed-50ft-R7A', 'l-shaped-R7A', 'corner-100x125-R8'):
            with self.subTest(name):
                a = zoning.account(SITES[name], storey_outlines(SITES[name]))
                self.assertTrue(a['yards'])
                for y in a['yards']:
                    self.assertTrue(y['pass'], y)
                    self.assertAlmostEqual(y['providedFeet'], y['requiredFeet'], delta=0.2)
        through = zoning.account(SITES['through-40x200-R6B'], storey_outlines(SITES['through-40x200-R6B']))
        self.assertEqual([y['yard'] for y in through['yards']], ['rear_yard_equivalent'])

    def test_coverage_height_units_and_parking_carry_their_sections(self):
        a = zoning.account(SITES['interior-25x100-R6B'], storey_outlines(SITES['interior-25x100-R6B']))
        self.assertEqual((a['lotCoverage']['percent'], a['lotCoverage']['allowedPercent'], a['lotCoverage']['pass']), (80.0, 80, True))
        self.assertEqual(a['lotCoverage']['openSpaceSqft'], 500)
        self.assertTrue(a['height']['pass'])
        self.assertLessEqual(a['height']['buildingFeet'], a['height']['limitFeet'])
        self.assertEqual(a['dwellingUnits']['maxUnits'], 7, 'ZR 23-52: the 5,000 sq ft permitted over 680 is 7.35, so 7')
        l_shaped = zoning.account(SITES['l-shaped-R7A'], storey_outlines(SITES['l-shaped-R7A']))
        self.assertEqual(l_shaped['dwellingUnits']['maxUnits'], 33, 'the 22,400 sq ft permitted, not the 18,144 the outlines hold: 32.94 rounds up')
        zones = a['parking']['byTransitZone']
        self.assertEqual(zones['inner']['required'], 0)
        self.assertEqual(zones['outer']['waiverSpaces'], 15)
        self.assertTrue(all(s.startswith('ZR 25-') for z in zones.values() for s in z['sections']))


class DrawnBuilding(unittest.TestCase):
    def test_the_drawn_floor_is_accounted_over_the_options_own_storeys(self):
        site = SITES['corner-100x125-R8']
        found = storey_outlines(site)
        plate = found[0].geometry.buffer(-10, join_style='mitre')
        a = zoning.account(site, found, typical=typical(round(plate.area)), plate=plate)
        self.assertEqual(len(a['storeys']), site['program']['storeys'])
        self.assertTrue(all(s['budgetSqft'] == round(site['program']['zfa'] / site['program']['storeys']) for s in a['storeys']))
        self.assertEqual(a['outsideOutline'], [])
        self.assertAlmostEqual(a['lotCoverage']['coveredSqft'], plate.area, delta=1)
        self.assertTrue(all(y['providedFeet'] >= y['requiredFeet'] for y in a['yards']))
        per_floor = sum(1 for s in typical(round(plate.area)) if s['kind'] == 'unit')
        self.assertEqual(a['dwellingUnits']['units'], per_floor * site['program']['storeys'], 'the units drawn, not the option\'s priced count')
        self.assertEqual(a['dwellingUnits']['optionUnits'], site['program']['units'])

    def test_floor_area_rests_on_the_recorded_lot_area_and_a_tax_map_gap_is_named(self):
        site = json.loads(json.dumps(SITES['interior-25x100-R6B']))
        site['lot']['recordedAreaSqft'] = 2200
        a = zoning.account(site, storey_outlines(site))
        self.assertEqual((a['lotAreaSqft'], a['taxMapAreaSqft']), (2200, 2500))
        self.assertEqual(a['far']['used'], round(a['totals']['zfaSqft'] / 2200, 2))
        self.assertEqual(a['lotCoverage']['allowedPercent'], 80)
        svg, _ = zd1.render(site, a, 'Gap')
        self.assertIn('14% more than the 2,200 sq ft on record', svg)
        self.assertIn('Confirm the lot area by survey.', svg)

    def test_an_option_with_too_few_storeys_for_its_floor_area_is_named(self):
        # Priced at the whole lot's floor area on one storey: one storey of the outline cannot hold it.
        site = json.loads(json.dumps(SITES['interior-25x100-R6B']))
        site['program']['storeys'] = 1
        found = storey_outlines(site)
        a = zoning.account(site, found, typical=typical(round(found[0].area)), plate=found[0].geometry)
        self.assertGreater(a['optionShortfallSqft'], 0.5 * site['program']['zfa'])
        svg, _ = zd1.render(site, a, 'One storey')
        self.assertIn('short of the', svg)

    def test_a_floor_that_ignores_a_deeper_yard_higher_up_is_caught(self):
        site = json.loads(json.dumps(SITES['corner-100x125-R8']))
        site['program']['storeys'] = len(site['storeys'])
        found = storey_outlines(site)
        plate = found[0].geometry
        a = zoning.account(site, found, typical=typical(round(plate.area)), plate=plate)
        high = [s['label'] for s in a['storeys'] if s['topFeet'] > 75]
        self.assertTrue(high and set(high) <= set(a['outsideOutline']), 'above 75 ft the rear yard is 30 ft (ZR 23-342)')
        self.assertTrue(any(not y['pass'] and y['requiredFeet'] == 30 for y in a['yards']))
        svg, _ = zd1.render(site, a, 'Corner')
        self.assertIn('30 ft required (ZR 23-342)', svg)

    def test_units_are_counted_once_however_many_rooms_they_have(self):
        rooms = ['Unit 1 living and kitchen', 'Unit 1 bedroom', 'Unit 1 bath', 'Unit 1 closet', 'Unit 2 living and sleeping', 'Unit 2 bath', 'Unit 12 bedroom 1', 'Stair hall', 'Corridor']
        self.assertEqual(zoning.units_drawn([{'kind': zoning.room_kind(n), 'name': n, 'areaSqft': 100} for n in rooms]), 3)
        self.assertEqual(zoning.units_drawn([{'kind': 'unit', 'areaSqft': 500}, {'kind': 'unit', 'areaSqft': 500}]), 2)

    def test_room_names_map_to_their_exclusions(self):
        names = {'Electric closet': 'mechanical', 'Storage': 'amenity', 'Refuse room': 'refuse', 'Scissor stair': 'stair', 'Elevator': 'elevator', 'Stair hall': 'stair', 'Corridor': 'corridor', 'Unit 3, 2 bedroom': 'unit', 'Bike room': 'bicycle', 'Amenity': 'amenity'}
        self.assertEqual({n: zoning.room_kind(n) for n in names}, names)


class Sheet(unittest.TestCase):
    def test_every_lot_renders_a_sheet_in_both_formats(self):
        for name, site in SITES.items():
            with self.subTest(name):
                found = storey_outlines(site)
                svg, pdf = zd1.render(site, zoning.account(site, found), f'{name}, As of right')
                root = ET.fromstring(svg)
                text = ' '.join(t.text or '' for t in root.iter('{http://www.w3.org/2000/svg}text'))
                self.assertIn(zd1.SURVEY_NOTE, text)
                for needle in ('Site plan', 'Section through the lot', 'Zoning calculations', 'Floor area ratio', 'Lot coverage', 'Building height', 'Accessory parking', 'ZR 23-'):
                    self.assertIn(needle, text)
                self.assertNotRegex(svg, '—')
                self.assertTrue(pdf.startswith(b'%PDF-1.4') and pdf.rstrip().endswith(b'%%EOF'))
                offset = int(re.search(rb'startxref\n(\d+)', pdf).group(1))
                self.assertEqual(pdf[offset:offset + 4], b'xref')
                self.assertIn(b"(Lot lines come from the city's tax map, not a survey.)", pdf)

    def test_a_plan_with_outlines_writes_the_sheet_and_its_figures(self):
        site = SITES['interior-25x100-R6B']
        m = 0.3048
        rooms = [{'id': 'r1', 'levelId': 'l1', 'name': 'Unit 1, 1 bedroom', 'polygon': [[0, 0], [25 * m, 0], [25 * m, 40 * m], [0, 40 * m]]},
                 {'id': 'r2', 'levelId': 'l1', 'name': 'Corridor', 'polygon': [[0, 40 * m], [25 * m, 40 * m], [25 * m, 46 * m], [0, 46 * m]]}]
        doc = {'id': 'p', 'revision': 2, 'name': 'Typical floor', 'levels': [{'id': 'l1'}], 'rooms': rooms, 'zoning': {**site, 'label': 'As of right', 'address': '1 Example St'}}
        with tempfile.TemporaryDirectory() as out:
            account = zd1.write(doc, out)
            self.assertEqual(sorted(os.listdir(out)), ['zd1.pdf', 'zd1.svg', 'zoning.json'])
            with open(os.path.join(out, 'zoning.json')) as handle:
                saved = json.load(handle)
            self.assertEqual((saved['schema'], saved['revision']), ('acres.zoning/1', 2))
            self.assertEqual(saved['storeys'][0]['grossSqft'], round(25 * 46))
            self.assertEqual(account['storeys'][0]['exclusions'][0]['kind'], 'corridor')
            with open(os.path.join(out, 'zd1.svg')) as handle:
                self.assertIn('1 Example St, As of right', handle.read())


    def test_a_corner_portion_needs_no_rear_yard_and_the_sheet_names_it(self):
        base = SITES['corner-100x125-R8']
        corner = lambda shaped: [{**c, 'cornerPortionFeet': 100, 'cornerSection': 'ZR 23-344'} if c['control'] == 'rear_yard' else c for c in shaped]
        site = {**base, 'lot': {**base['lot'], 'exterior': [[0, 0], [150, 0], [150, 90], [0, 90]], 'areaSqft': 13500, 'recordedAreaSqft': 13500},
                'storeys': [{**st, 'shapedBy': corner(st['shapedBy'])} for st in base['storeys']]}
        account = zoning.account(site, storey_outlines(site))
        rear = [y for y in account['yards'] if y['yard'] == 'rear_yard']
        self.assertTrue(rear and all(y['pass'] for y in rear), rear)
        self.assertEqual(account['cornerPortion']['section'], 'ZR 23-344')
        self.assertAlmostEqual(sum(zoning.Polygon(p['exterior']).area for p in account['cornerPortion']['footprint']), 100 * 90, delta=1)
        rows = zd1.calculations(site, account)
        self.assertIn(['  Corner portion', 'no rear yard', '', 'ZR 12-10, ZR 23-344'], rows)
        self.assertIn('Corner portion: no rear yard', zd1.render(site, account, 'Corner')[0])

    def test_portions_within_and_beyond_100_ft_of_a_wide_street_are_on_the_sheet(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['deep-50x150-R8-wide-street']
        account = zoning.account(site, storey_outlines(site))
        self.assertEqual([(p['label'], p['heightLimitFeet']) for p in account['portions']], [('Within 100 ft of a wide street', 135), ('Beyond 100 ft of a wide street', 115)])
        rows = zd1.calculations(site, account)
        self.assertIn(['  Beyond 100 ft of a wide street (33.3%)', 'base 60 ft to 85 ft, height 115 ft', '', 'ZR 23-432, ZR 77-28'], rows)
        self.assertTrue(any(r[0] == 'Floor area ratio' and 'ZR 77-22' in r[3] for r in rows))
        self.assertTrue(account['height']['pass'])
        svg, _ = zd1.render(site, account, 'Deep')
        self.assertIn('Beyond 100 ft of a wide street', svg)

    def test_a_split_lot_is_accounted_portion_by_portion_on_the_mapped_boundary(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['split-100x100-R6-R7A']
        found = storey_outlines(site)
        account = zoning.account(site, found)
        # The mapped boundary runs from x = 40 at the street to x = 50 at the rear: the R7A part is 4,500 sq ft.
        areas = [sum(zoning.Polygon(p['exterior']).area for p in portion['footprint']) for portion in account['portions']]
        self.assertEqual([round(a) for a in areas], [5500, 4500])
        self.assertAlmostEqual(found[0].area, 8000, delta=2)
        rows = zd1.calculations(site, account)
        self.assertEqual(rows[1], ['Zoning district', 'R6 55%, R7A 45%', 'interior lot', 'Zoning Map, ZR 77-02'])
        self.assertTrue(any(r[0] == 'Floor area ratio' and r[1] == '3.01' and 'ZR 77-22' in r[3] for r in rows))
        self.assertIn('  R7A portion (45%)', [r[0] for r in rows])

    def test_the_typical_floor_is_repeated_over_the_stack_the_outlines_draw(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['l-shaped-R7A-recovered']
        found = storey_outlines(site)
        plate = zoning.Polygon([[0, 0], [40, 0], [40, 80], [0, 80]])
        account = zoning.account(site, found, typical=typical(plate.area), plate=plate)
        self.assertEqual(len(account['storeys']), len(found))
        self.assertGreater(len(found), site['program']['storeys'])

    def test_a_portion_without_a_minimum_base_and_no_zero_yard_rows(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['split-100x100-R6-R7A']
        site = {**site, 'portions': [{**site['portions'][0], 'minBaseHeightFeet': None, 'maxBaseHeightFeet': 35, 'heightLimitFeet': 35}, site['portions'][1]]}
        account = zoning.account(site, storey_outlines(site))
        rows = zd1.calculations(site, account)
        self.assertIn(['  R6 portion (55%)', 'base up to 35 ft, height 35 ft', '', 'ZR 77-27, ZR 77-28'], rows)
        far = next(r for r in rows if r[0] == 'Floor area ratio')
        self.assertEqual(far[3].count('ZR 77-22'), 1)
        self.assertTrue(all(y['requiredFeet'] > 0 for y in account['yards']))

    def test_each_portion_s_yards_are_measured_within_it(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['split-100x100-R6-R7A']
        # A 10 ft front yard on the R7A portion only: the R6 portion building to the street line does not fail it.
        def front(st):
            return [*st['shapedBy'], *([{'control': 'front_yard', 'feet': 10, 'sides': ['front'], 'section': 'ZR 23-321', 'portion': 1}] if st['index'] == 0 else [])]
        site = {**site, 'storeys': [{**st, 'shapedBy': front(st)} for st in site['storeys']]}
        found = storey_outlines(site)
        account = zoning.account(site, found)
        row = next(y for y in account['yards'] if y['yard'] == 'front_yard')
        self.assertTrue(row['portion'] == 'R7A portion' and row['pass'], row)
        self.assertIn(['Front yard (R7A portion)', '10 ft', '10 ft', 'ZR 23-321'], zd1.calculations(site, account))
        self.assertTrue(all(y['providedFeet'] < 200 for y in account['yards']))

    def test_a_storey_drawn_above_the_filled_stack_takes_the_reserve_storey_at_its_height(self):
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlines-portions.json')) as handle:
            site = json.load(handle)['deep-50x150-R8-wide-street']
        found = storey_outlines(site)
        plate = zoning.Polygon([[0, 0], [40, 0], [40, 40], [0, 40]])
        drawn = [{'name': f'Level {i + 1}', 'use': 'residential', 'bottomFeet': 10.5 * i, 'heightFeet': 10.5, 'spaces': typical(plate.area), 'plate': plate} for i in range(len(found) + 1)]
        top = zoning.account(site, found, drawn=drawn)['storeys'][-1]
        reserve = next(s for s in site['reserveStoreys'] if s['index'] == len(found))
        self.assertNotIn('beyondEnvelope', top)
        self.assertEqual(top['permitted'], zoning.polygons(outlines.storey_geometry(site, outlines.lot_polygon(site['lot']), outlines.lot_lines(outlines.lot_polygon(site['lot']), ['front']), [c for c in reserve['shapedBy'] if c['control'] != 'max_area'], found[0].equivalent or 'midway')))
        # With no reserve at that height the storey is still named as beyond the envelope.
        past = zoning.account({**site, 'reserveStoreys': []}, found, drawn=drawn)['storeys'][-1]
        self.assertTrue(past['beyondEnvelope'])

    def test_draw_returns_the_sheet_both_writers_render(self):
        site = SITES['corner-100x125-R8']
        account = zoning.account(site, storey_outlines(site))
        sheet = zd1.draw(site, account, 'Corner, As of right')
        self.assertIsInstance(sheet, zd1.Sheet)
        self.assertEqual({item[0] for item in sheet.items}, {'path', 'text'})
        self.assertEqual(zd1.render(site, account, 'Corner, As of right'), (sheet.svg(), sheet.pdf()))

    def test_the_north_arrow_points_where_the_lot_frame_says_north_is(self):
        site = SITES['interior-25x100-R6B']
        account = zoning.account(site, storey_outlines(site))
        texts = lambda sheet: [i for i in sheet.items if i[0] == 'text' and i[3] == 'N']
        self.assertEqual(texts(zd1.draw(site, account, 'No north')), [])
        # North along +x in the lot frame: the arrow points right on the page.
        sheet = zd1.draw({**site, 'lot': {**site['lot'], 'north': [1, 0]}}, account, 'North east')
        (label,) = texts(sheet)
        shaft = next(i for i in sheet.items if i[0] == 'path' and not i[6] and i[4] == 1)
        (x0, y0), (x1, y1) = shaft[1]
        self.assertAlmostEqual(y0, y1)
        self.assertGreater(x1, x0)
        self.assertGreater(label[1], x1)
        # North along -z (toward the front street, drawn at the bottom): the arrow points down the page.
        sheet = zd1.draw({**site, 'lot': {**site['lot'], 'north': [0, -1]}}, account, 'South')
        (x0, y0), (x1, y1) = next(i for i in sheet.items if i[0] == 'path' and not i[6] and i[4] == 1)[1]
        self.assertGreater(y1, y0)

    def test_a_resolved_transit_zone_is_one_parking_row(self):
        site = SITES['interior-25x100-R6B']
        parking = {'required': 0, 'transitZone': 'outer', 'transitZoneSource': 'PLUTO transit zone', 'waived': True, 'waiverSpaces': 15, 'sections': ['ZR 25-222']}
        site = {**site, 'parking': parking}
        account = zoning.account(site, storey_outlines(site))
        self.assertEqual((account['parking']['transitZone'], account['parking']['transitZoneSource']), ('outer', 'PLUTO transit zone'))
        rows = [r for r in zd1.calculations(site, account) if r[0] == 'Accessory parking']
        self.assertEqual(rows, [['Accessory parking', '0 spaces, Outer Transit Zone', '0 spaces', 'ZR 25-222']])

    def test_a_multi_level_plan_is_accounted_storey_by_storey_on_its_own_plates(self):
        site = {**SITES['interior-25x100-R6B'], 'label': 'As of right', 'lot': {**SITES['interior-25x100-R6B']['lot'], 'north': [0, 1]}}
        m = 0.3048
        box = lambda level, name, depth: {'id': f'{level}-{name}', 'levelId': level, 'name': name, 'polygon': [[0, 0], [25 * m, 0], [25 * m, depth * m], [0, depth * m]]}
        levels = [{'id': 'c', 'use': 'cellar', 'storeys': [{'id': 'c1', 'name': 'Cellar', 'elevation': -3}]},
                  {'id': 'g', 'use': 'ground', 'storeys': [{'id': 'g1', 'name': 'Ground', 'elevation': 0}]},
                  {'id': 't', 'use': 'residential', 'storeys': [{'id': f't{i}', 'name': f'Level {i}', 'elevation': 3.2 * (i - 1)} for i in range(2, 5)]},
                  {'id': 'u', 'use': 'residential', 'storeys': [{'id': 'u5', 'name': 'Level 5', 'elevation': 12.8}]}]
        rooms = [box('c', 'Mechanical', 60), box('g', 'Lobby', 50), box('t', 'Unit 1, 1 bedroom', 44), box('u', 'Unit 1, studio', 30)]
        doc = {'id': 'p', 'revision': 3, 'name': 'Plan', 'levels': levels, 'rooms': rooms, 'zoning': site}
        self.assertEqual(zd1.typical_level(doc)['id'], 't')
        self.assertEqual(zd1.typical_level({'levels': [{'id': 'only'}]})['id'], 'only')
        with tempfile.TemporaryDirectory() as out:
            account = zd1.write(doc, out)
            with open(os.path.join(out, 'zoning.json')) as handle:
                saved = json.load(handle)
        # Each storey is its own plate; the cellar is not floor area (ZR 12-10).
        self.assertEqual([(st['label'], st['grossSqft']) for st in account['storeys']], [('Cellar', 1500), ('Ground', 1250), ('Level 2', 1100), ('Level 3', 1100), ('Level 4', 1100), ('Level 5', 750)])
        cellar = account['storeys'][0]
        self.assertEqual((cellar['zfaSqft'], cellar['exclusions'][0]['kind']), (0, 'cellar'))
        self.assertNotIn('cellar', account['totals']['byUse'])
        self.assertEqual(account['dwellingUnits']['units'], 4, 'one unit on each of levels 2 to 5')
        self.assertEqual(account['optionShortfallSqft'], max(0, round(site['program']['zfa'] - account['totals']['zfaSqft'])))
        self.assertTrue(all(st['fitsOutline'] for st in account['storeys'][1:]))
        self.assertEqual(saved['north'], [0, 1])
        self.assertEqual(saved['transitZone'], {'zone': None, 'source': None})


if __name__ == '__main__':
    unittest.main()
