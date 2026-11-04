"""Architecture plan v1: the sample fixture converter and the validator's rejection rules.

Run with the project venv:  .venv/bin/python -m unittest test_architecture -v
"""
import copy
import json
import os
import unittest

from architecture import FOOT, SCHEMA, from_layout, levels_of, validate

HERE = os.path.dirname(os.path.abspath(__file__))


def sample():
    with open(os.path.join(HERE, 'fixtures', 'sample-floorplan.json')) as handle:
        return json.load(handle)


def codes(plan):
    return sorted({error['code'] for error in validate(plan)})


class Converter(unittest.TestCase):
    def setUp(self):
        self.plan = from_layout(sample(), 'plan-sample')

    def test_document_shape(self):
        plan = self.plan
        self.assertEqual(plan['schema'], SCHEMA)
        self.assertEqual((plan['id'], plan['revision'], plan['parentRevision'], plan['units']), ('plan-sample', 1, None, 'm'))
        self.assertEqual(plan['name'], 'Two-bedroom workflow test')
        self.assertEqual(plan['levels'], [{'id': 'level-1', 'name': 'Level 1', 'elevation': 0.0, 'height': 2.8, 'slabThickness': 0.2}])
        self.assertEqual(len(plan['walls']), 8)
        self.assertEqual(len(plan['openings']), 9)
        self.assertEqual(len(plan['rooms']), 5)
        self.assertEqual(plan['objects'], [])
        self.assertEqual(plan['sources'], [{'kind': 'layout', 'ref': 'Two-bedroom workflow test'}])

    def test_walls_openings_and_rooms_keep_source_ids_namespaced_by_kind(self):
        south = next(w for w in self.plan['walls'] if w['id'] == 'wall-south')
        self.assertEqual(south, {'id': 'wall-south', 'levelId': 'level-1', 'start': [0.0, 0.0], 'end': [10.0, 0.0], 'thickness': 0.18, 'height': 2.8,
                                 'material': 'generic', 'roomIds': ['room-kitchen', 'room-living']})
        entry = next(o for o in self.plan['openings'] if o['id'] == 'opening-entry')
        self.assertEqual(entry, {'id': 'opening-entry', 'wallId': 'wall-south', 'kind': 'door', 'offset': 4.55, 'width': 0.9, 'sill': 0.0, 'height': 2.1, 'swing': None})
        living = next(r for r in self.plan['rooms'] if r['id'] == 'room-living')
        self.assertEqual(living, {'id': 'room-living', 'levelId': 'level-1', 'name': 'Living / dining', 'polygon': [[0.0, 0.0], [7.0, 0.0], [7.0, 4.0], [0.0, 4.0]], 'netAreaMethod': 'inside-wall-faces'})
        divider = next(w for w in self.plan['walls'] if w['id'] == 'wall-rooms')
        self.assertEqual(divider['roomIds'], ['room-bathroom', 'room-bedroom-a', 'room-bedroom-b', 'room-kitchen', 'room-living'])

    def test_the_sample_is_valid(self):
        self.assertEqual(validate(self.plan), [])

    def test_a_level_without_storeys_stands_for_itself(self):
        [level] = levels_of(self.plan)
        self.assertEqual(level['storeys'], [{'id': 'level-1', 'name': 'Level 1', 'elevation': 0.0}])
        self.assertIsNone(level['use'])
        self.assertEqual(len(level['rooms']), 5)
        self.assertAlmostEqual(level['plate'].area, 80.0, places=6)  # the sample is 10 by 8 m

    def test_a_level_names_the_storeys_it_repeats_on(self):
        plan = copy.deepcopy(self.plan)
        storeys = [{'id': f'storey-{i + 1}', 'name': f'Level {i + 1}', 'elevation': round(i * 3.048, 4)} for i in range(1, 4)]
        plan['levels'][0].update(use='residential', storeys=storeys)
        [level] = levels_of(plan)
        self.assertEqual((level['use'], level['storeys']), ('residential', storeys))
        self.assertEqual(validate(plan), [])

    def test_feet_convert_once_with_0_3048(self):
        layout = sample()
        feet = copy.deepcopy(layout)
        feet['units'] = 'ft'
        scale = lambda v: v / FOOT
        feet['height'], feet['wall_thickness'], feet['floor_thickness'] = scale(2.8), scale(0.18), scale(0.2)
        for wall in feet['walls']:
            wall['start'], wall['end'] = [scale(v) for v in wall['start']], [scale(v) for v in wall['end']]
        for opening in feet['openings']:
            for key in ('offset', 'width', 'height', 'sill'):
                opening[key] = scale(opening[key])
        for room in feet['rooms']:
            room['bounds'] = [scale(v) for v in room['bounds']]
        converted = from_layout(feet, 'plan-sample')
        self.assertEqual(FOOT, 0.3048)
        self.assertEqual(from_layout({**feet, 'height': 10}, 'x')['levels'][0]['height'], 3.048)
        self.assertEqual(converted['levels'], self.plan['levels'])
        # Values are rounded to the micrometre after the single multiplication, so the round trip is exact.
        self.assertEqual(converted['walls'], self.plan['walls'])
        self.assertEqual(converted['openings'], self.plan['openings'])
        self.assertEqual(converted['rooms'], self.plan['rooms'])


class Validator(unittest.TestCase):
    def setUp(self):
        self.plan = from_layout(sample(), 'plan-sample')

    def error(self, plan, code):
        found = [e for e in validate(plan) if e['code'] == code]
        self.assertTrue(found, f'expected {code}, got {validate(plan)}')
        self.assertTrue(all(set(e) == {'code', 'id', 'message'} for e in found))
        return found[0]

    def test_open_room_boundary(self):
        plan = self.plan
        plan['walls'] = [w for w in plan['walls'] if w['id'] != 'wall-kitchen']
        plan['openings'] = [o for o in plan['openings'] if o['wallId'] != 'wall-kitchen']
        error = self.error(plan, 'room_open_boundary')
        self.assertIn(error['id'], ('room-living', 'room-kitchen'))
        self.assertEqual(codes(plan), ['room_open_boundary'])

    def test_unclosed_room_polygon(self):
        self.plan['rooms'][0]['polygon'] = [[0.0, 0.0], [7.0, 0.0]]
        self.assertEqual(self.error(self.plan, 'room_invalid_polygon')['id'], self.plan['rooms'][0]['id'])

    def test_self_intersecting_room_polygon(self):
        self.plan['rooms'][0]['polygon'] = [[0.0, 0.0], [7.0, 4.0], [7.0, 0.0], [0.0, 4.0]]
        self.error(self.plan, 'room_invalid_polygon')

    def test_duplicated_shared_wall(self):
        plan = self.plan
        plan['walls'].append({**plan['walls'][4], 'id': 'wall-rooms-copy', 'start': [10.0, 4.0], 'end': [3.0, 4.0], 'roomIds': []})
        self.assertEqual(self.error(plan, 'wall_duplicate')['id'], 'wall-rooms-copy')

    def test_a_wall_a_hair_off_its_neighbour_is_a_duplicate(self):
        plan = copy.deepcopy(self.plan)
        south = next(w for w in plan['walls'] if w['id'] == 'wall-south')
        plan['walls'].append({**south, 'id': 'wall-skew', 'start': [0.0, 0.0], 'end': [10.0, 0.003]})
        self.assertIn('wall_duplicate', codes(plan))

    def test_crossing_and_touching_walls_are_not_duplicates(self):
        self.assertNotIn('wall_duplicate', codes(self.plan))

    def test_opening_past_the_wall_end(self):
        entry = next(o for o in self.plan['openings'] if o['id'] == 'opening-entry')
        entry['offset'] = 9.5
        self.assertEqual(self.error(self.plan, 'opening_outside_wall')['id'], 'opening-entry')

    def test_opening_above_the_wall(self):
        window = next(o for o in self.plan['openings'] if o['id'] == 'opening-kitchen-window')
        window['sill'] = 2.0
        self.assertEqual(self.error(self.plan, 'opening_outside_wall')['id'], 'opening-kitchen-window')

    def test_negative_offset(self):
        self.plan['openings'][0]['offset'] = -0.1
        self.error(self.plan, 'opening_outside_wall')

    def test_overlapping_openings(self):
        window = next(o for o in self.plan['openings'] if o['id'] == 'opening-living-window')
        window['offset'] = 4.0  # 4.0 to 6.4 overlaps the entry door at 4.55 to 5.45
        self.assertEqual(self.error(self.plan, 'opening_overlap')['id'], 'opening-living-window')

    def test_unknown_parent_wall(self):
        self.plan['openings'][0]['wallId'] = 'wall-missing'
        self.error(self.plan, 'unknown_reference')

    def test_duplicate_ids(self):
        self.plan['rooms'][1]['id'] = self.plan['rooms'][0]['id']
        self.error(self.plan, 'duplicate_id')

    def test_zero_length_wall(self):
        self.plan['walls'][0]['end'] = list(self.plan['walls'][0]['start'])
        self.error(self.plan, 'invalid_dimension')

    def test_wrong_schema_or_units(self):
        self.plan['units'] = 'ft'
        self.error(self.plan, 'invalid_document')


if __name__ == '__main__':
    unittest.main()
