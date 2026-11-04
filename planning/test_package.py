"""The architect's package from one plan revision: the full IFC model, the drawing set, the DXF, the
schedules, the self-check and the zip, on synthetic multi-level plans built to the plan document's level
contract (each drawn plate a level listing the storeys it stands for; rooms with kind and unit).

Run with the project venv:  .venv/bin/python -m unittest test_package -v
"""
import json
import os
import re
import tempfile
import unittest
import zipfile
from math import ceil, cos, sin

import ezdxf
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
from shapely.geometry import LineString, Polygon, box
from openpyxl import load_workbook
from shapely.ops import unary_union

import architecture as arch
import layout
import run
import zoning
from engine import storey_outlines
from exporters import drawings, ifc, package

HERE = os.path.dirname(os.path.abspath(__file__))
FOOT = 0.3048


def outlines(name):
    with open(os.path.join(HERE, 'fixtures', 'outlines.json')) as handle:
        return json.load(handle)[name]


def plate(prefix, x0, y0, width, depth, program, unit_width=7.0):
    """Rooms of one plate, metres: a double-loaded corridor along x, a stair at each end and an elevator
    beside the first in the back band; the front band (the street side, low y) holds units, or a lobby on
    the ground floor; a cellar holds mechanical and bike rooms. Units are a living room on the facade, a
    bedroom beside it and a bath behind the bedroom."""
    band = (depth - 1.6) / 2
    rooms = []

    def room(name, kind, poly, unit=None, unit_type=None, beds=None):
        rooms.append({'name': name, 'kind': kind, 'poly': poly, 'unitId': unit, 'unitType': unit_type, 'beds': beds})

    room('Corridor', 'corridor', box(x0, y0 + band, x0 + width, y0 + band + 1.6))
    back0, back1 = y0 + band + 1.6, y0 + depth
    room('Stair A', 'stair', box(x0, back0, x0 + 3.0, back1))
    room('Elevator', 'elevator', box(x0 + 3.0, back0, x0 + 5.5, back1))
    room('Stair B', 'stair', box(x0 + width - 3.0, back0, x0 + width, back1))

    def units(a, b, y_face, y_corridor, letters):
        n = max(1, int((b - a) // unit_width))
        step = (b - a) / n
        for i in range(n):
            u = f'{letters}{i + 1}'
            u0, u1 = a + i * step, a + (i + 1) * step
            mid = u0 + step * 0.55
            lo, hi = sorted((y_face, y_corridor))
            bath_at = y_corridor - 2.0 if y_corridor > y_face else y_corridor + 2.0
            room(f'Living {u}', 'living', box(u0, lo, mid, hi), u, 'oneBedroom', 1)
            room(f'Bedroom {u}', 'bedroom', box(mid, min(y_face, bath_at), u1, max(y_face, bath_at)), u, 'oneBedroom', 1)
            room(f'Bath {u}', 'bath', box(mid, min(bath_at, y_corridor), u1, max(bath_at, y_corridor)), u, 'oneBedroom', 1)

    if program == 'cellar':
        room('Mechanical room', 'mechanical', box(x0, y0, x0 + width / 2, y0 + band))
        room('Bicycle room', 'bike', box(x0 + width / 2, y0, x0 + width, y0 + band))
        room('Storage', 'storage', box(x0 + 5.5, back0, x0 + width - 3.0, back1))
    elif program == 'ground':
        room('Lobby', 'lobby', box(x0, y0, x0 + 6.0, y0 + band))
        units(x0 + 6.0, x0 + width, y0, y0 + band, 'F')
        units(x0 + 5.5, x0 + width - 3.0, back1, back0, 'R')
    else:
        units(x0, x0 + width, y0, y0 + band, 'F')
        units(x0 + 5.5, x0 + width - 3.0, back1, back0, 'R')
    return [{**r, 'id': f'{prefix}-room-{i + 1}'} for i, r in enumerate(rooms)]


def document(levels, name='Synthetic building', zoning_site=None):
    """A plan v1 document from [{id, name, use, elevation, height, storeys, rooms}] with walls on every
    room edge, unit, stair and room doors, and a window on each living room and bedroom facade."""
    doc_levels, walls, openings, rooms = [], [], [], []
    for spec in levels:
        lid = spec['id']
        doc_levels.append({k: spec[k] for k in ('id', 'name', 'elevation', 'height') if k in spec} | {'slabThickness': 0.25, 'use': spec['use'],
                          **({'storeys': spec['storeys']} if spec.get('storeys') else {})})
        level_rooms = spec['rooms']
        outer = unary_union([r['poly'] for r in level_rooms])
        edges = unary_union([LineString(list(r['poly'].exterior.coords)) for r in level_rooms])
        segments = []
        for g in edges.geoms if hasattr(edges, 'geoms') else [edges]:
            cs = list(g.coords)
            segments += [(p, q) for p, q in zip(cs, cs[1:]) if LineString([p, q]).length > 0.01]
        level_walls = []
        for p, q in layout.merge_walls(segments):
            line = LineString([p, q])
            exterior = outer.exterior.distance(line.interpolate(0.5, normalized=True)) < 0.01
            level_walls.append({'id': f'{lid}-wall-{len(level_walls) + 1}', 'levelId': lid, 'start': [round(p[0], 4), round(p[1], 4)], 'end': [round(q[0], 4), round(q[1], 4)],
                                'thickness': 0.3 if exterior else 0.15, 'height': spec['height'] - 0.25, 'material': 'generic', 'roomIds': [], '_line': line})

        def on_wall(a, b, kind, width, sill=0.0, height=2.1):
            shared = a['poly'].exterior.intersection(b['poly'].exterior) if b is not None else a['poly'].exterior.intersection(outer.exterior)
            seg = layout.longest(shared)
            if seg is None or seg.length < width + 0.4:
                return
            mid = seg.interpolate(0.5, normalized=True)
            wall = min(level_walls, key=lambda w: w['_line'].distance(mid))
            offset = wall['_line'].project(mid) - width / 2
            openings.append({'id': f"{lid}-opening-{len(openings) + 1}", 'wallId': wall['id'], 'kind': kind, 'offset': round(offset, 4), 'width': width,
                             'sill': sill, 'height': height, 'swing': None})
        by_kind = lambda kind: [r for r in level_rooms if r['kind'] == kind]
        corridor = by_kind('corridor')[0]
        for r in level_rooms:
            if r['kind'] in ('stair', 'elevator', 'living', 'lobby', 'mechanical', 'bike', 'storage'):
                on_wall(r, corridor, 'door', 1.07 if r['kind'] == 'elevator' else 0.91)
            if r['kind'] in ('bedroom', 'bath'):
                living = next(m for m in level_rooms if m['kind'] == 'living' and m['unitId'] == r['unitId'])
                on_wall(r, living, 'door', 0.81)
            if r['kind'] in ('living', 'bedroom'):
                on_wall(r, None, 'window', 1.5, sill=0.76, height=1.5)
            if r['kind'] == 'lobby':
                on_wall(r, None, 'door', 1.07)
        for r in level_rooms:
            rooms.append({'id': r['id'], 'levelId': lid, 'name': r['name'], 'kind': r['kind'], 'polygon': [[round(x, 4), round(y, 4)] for x, y in list(r['poly'].exterior.coords)[:-1]],
                          'netAreaMethod': arch.NET_AREA_METHOD, **({'unitId': r['unitId'], 'unitType': r['unitType'], 'beds': r['beds']} if r['unitId'] else {})})
        for w in level_walls:
            w.pop('_line')
        walls += level_walls
    doc = {'schema': arch.SCHEMA, 'id': 'plan-synthetic', 'revision': 3, 'parentRevision': 2, 'name': name, 'units': 'm', 'levels': doc_levels,
           'walls': walls, 'openings': openings, 'rooms': rooms, 'objects': [], 'sources': [{'kind': 'layout', 'ref': 'test_package.py'}]}
    for wall in walls:
        wall['roomIds'] = sorted(room['id'] for room in rooms if room['levelId'] == wall['levelId'] and arch.bounds_room(wall, room))
    if zoning_site:
        doc['zoning'] = zoning_site
    return doc


def building(storeys=5, width=24.0, depth=18.0, x0=1.5, y0=0.0, site=None, upper=None):
    """Cellar, ground floor and a typical plate standing for Level 2 up; upper adds a narrower top plate.
    Storeys sit at the zoning export's storey elevations when there is one, else 10 ft apart."""
    count = storeys + (1 if upper else 0)
    rows = [(s['bottomFeet'] * FOOT, s['heightFeet'] * FOOT) for s in site['storeys'][:count]] if site else [(i * 3.05, 3.05) for i in range(count)]
    ground, typical_h = rows[0], rows[1][1]
    typical = [{'id': f'storey-{i}', 'name': f'Level {i}', 'elevation': round(rows[i - 1][0], 4)} for i in range(2, storeys + 1)]
    levels = [
        {'id': 'cellar', 'name': 'Cellar', 'use': 'cellar', 'elevation': -3.05, 'height': 3.05, 'rooms': plate('c', x0, y0, width, depth, 'cellar')},
        {'id': 'ground', 'name': 'Ground floor', 'use': 'ground', 'elevation': 0.0, 'height': round(ground[1], 4), 'rooms': plate('g', x0, y0, width, depth, 'ground')},
        {'id': 'typical', 'name': 'Level 2', 'use': 'residential', 'elevation': typical[0]['elevation'], 'height': round(typical_h, 4), 'storeys': typical, 'rooms': plate('t', x0, y0, width, depth, 'residential')},
    ]
    if upper:
        levels.append({'id': 'upper', 'name': f'Level {storeys + 1}', 'use': 'residential', 'elevation': round(rows[storeys][0], 4), 'height': round(rows[storeys][1], 4),
                       'rooms': plate('u', x0, y0 + upper, width, depth - upper, 'residential')})
    return document(levels, zoning_site=site)


def site_account(site):
    return zoning.account(site, storey_outlines(site))


class Contract(unittest.TestCase):
    def test_synthetic_plans_are_valid_plan_documents(self):
        for doc in (building(), building(upper=3.0, site=outlines('wide-100x100-C6-2'))):
            self.assertEqual(arch.validate(doc), [])

    def test_storeys_expand_levels_lowest_first(self):
        found = package.storeys(building(storeys=5))
        self.assertEqual([s['name'] for s in found], ['Cellar', 'Ground floor', 'Level 2', 'Level 3', 'Level 4', 'Level 5'])
        self.assertEqual([s['number'] for s in found], ['C', '1', '2', '3', '4', '5'])
        self.assertEqual([s['first'] for s in found], [True, True, True, False, False, False])

    def test_a_level_without_storeys_is_one_storey(self):
        doc = building()
        doc['levels'] = doc['levels'][:1]
        self.assertEqual([(s['id'], s['name']) for s in package.storeys(doc)], [('cellar', 'Cellar')])

    def test_doors_swing_into_units_stairs_and_rooms(self):
        doc = building()
        kinds = {}
        for opening in doc['openings']:
            if opening['kind'] != 'door':
                continue
            swing = package.door_swing(doc, opening)
            wall, found = package.sides(doc, opening)
            if swing['sliding']:
                kinds.setdefault('Elevator door', set()).add('elevator')
                continue
            into = found[swing['into']]
            kinds.setdefault(swing['kind'], set()).add(into['kind'] if into else 'outside')
        self.assertEqual(kinds['Unit entry'], {'living'})
        self.assertEqual(kinds['Corridor door'], {'lobby', 'mechanical', 'bike', 'storage'})
        self.assertEqual(kinds['Stair door'], {'stair'})
        self.assertEqual(kinds['Room door'], {'bedroom', 'bath'})
        self.assertEqual(kinds['Building entry'], {'outside'})
        self.assertEqual(kinds['Elevator door'], {'elevator'})

    def test_units_are_numbered_by_storey_and_letter(self):
        level_3 = {'number': '3'}
        self.assertEqual([package.unit_tag(level_3, u) for u in ('unit-1', 'unit-4', 'unit-27', 'F2')], ['3A', '3D', '327', '3F2'])

    def test_net_rooms_match_the_architecture_module(self):
        doc = building(storeys=3, upper=2.0)
        net = package.nets(doc)
        for room in doc['rooms']:
            self.assertEqual(net[room['id']]['ring'], arch.net_polygon(doc, room))
            self.assertAlmostEqual(net[room['id']]['area'], arch.net_area(doc, room))

    def test_stairs_meet_riser_and_tread_limits_and_fit_their_room(self):
        doc = building()
        stair = next(r for r in doc['rooms'] if r['kind'] == 'stair')
        run = package.stair_runs(package.nets(doc)[stair['id']]['ring'], 3.05)
        self.assertEqual(run['risers'], ceil(3.05 / package.MAX_RISER))
        self.assertLessEqual(run['riser'], package.MAX_RISER + 1e-9)
        self.assertAlmostEqual(run['tread'], package.TREAD)
        room = Polygon(stair['polygon']).buffer(1e-6)
        self.assertTrue(room.contains(Polygon(run['landing'])))


class Model(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site = outlines('wide-100x100-C6-2')
        cls.account = site_account(cls.site)
        cls.doc = building(storeys=5, upper=3.0, site=cls.site)
        cls.dir = tempfile.mkdtemp()
        cls.path = os.path.join(cls.dir, 'model.ifc')
        cls.ids = ifc.write_plan(cls.path, cls.doc, cls.account)
        cls.f = ifcopenshell.open(cls.path)

    def storey(self, name):
        return next(s for s in self.f.by_type('IfcBuildingStorey') if s.Name == name)

    def contained(self, storey, ifc_class):
        return [e for e in ifcopenshell.util.element.get_decomposition(storey) if e.is_a(ifc_class)]

    def test_every_storey_is_named_at_its_elevation(self):
        got = sorted((s.Elevation, s.Name) for s in self.f.by_type('IfcBuildingStorey'))
        self.assertEqual([n for _, n in got], ['Cellar', 'Ground floor', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6'])
        self.assertEqual([round(e / FOOT, 1) for e, _ in got], [-10.0] + [s['bottomFeet'] for s in self.site['storeys'][:6]])

    def test_repeated_storeys_hold_the_level_elements_and_share_shapes(self):
        level_walls = sum(1 for w in self.doc['walls'] if w['levelId'] == 'typical')
        level_doors = sum(1 for o in self.doc['openings'] if o['kind'] == 'door' and o['wallId'].startswith('typical'))
        for name in ('Level 2', 'Level 3', 'Level 5'):
            s = self.storey(name)
            self.assertEqual(len(self.contained(s, 'IfcWall')), level_walls)
            self.assertEqual(len(self.contained(s, 'IfcDoor')), level_doors)
        a, b = (self.contained(self.storey(n), 'IfcWall') for n in ('Level 2', 'Level 4'))
        self.assertEqual({w.Representation.id() for w in a}, {w.Representation.id() for w in b})
        self.assertEqual(len({e.GlobalId for e in self.f.by_type('IfcRoot')}), len(self.f.by_type('IfcRoot')))

    def test_units_are_zones_with_their_rooms(self):
        zones = {z.Name: z for z in self.f.by_type('IfcZone')}
        self.assertIn('Unit 2F1', zones)
        self.assertIn('Unit 5R1', zones)
        self.assertNotIn('Unit CF1', zones)
        rooms = [r.Name for rel in zones['Unit 3F1'].IsGroupedBy for r in rel.RelatedObjects]
        self.assertEqual(sorted(rooms), ['Bath F1', 'Bedroom F1', 'Living F1'])
        props = ifcopenshell.util.element.get_pset(zones['Unit 3F1'], 'Arosa_Unit')
        self.assertEqual((props['Unit'], props['UnitType'], props['Bedrooms']), ('3F1', 'oneBedroom', 1))

    def test_stairs_on_every_storey_but_the_top_and_one_elevator_stack(self):
        for name in ('Cellar', 'Ground floor', 'Level 5'):
            self.assertEqual(len(self.contained(self.storey(name), 'IfcStair')), 2)
        self.assertEqual(len(self.contained(self.storey('Level 6'), 'IfcStair')), 0)
        lifts = self.f.by_type('IfcTransportElement')
        self.assertEqual(len(lifts), 1)
        self.assertEqual(ifcopenshell.util.element.get_container(lifts[0]).Name, 'Cellar')
        self.assertEqual(ifcopenshell.util.element.get_pset(lifts[0], 'Arosa_Elevator')['StoreysServed'], 7)
        props = ifcopenshell.util.element.get_pset(self.f.by_type('IfcStair')[0], 'Pset_StairCommon')
        self.assertLessEqual(props['RiserHeight'], package.MAX_RISER + 1e-9)

    def test_slabs_above_the_lowest_storey_open_at_stairs_and_elevators(self):
        def voids(name):
            return sum(len(slab.HasOpenings) for slab in self.contained(self.storey(name), 'IfcSlab') if slab.PredefinedType == 'FLOOR')
        self.assertEqual(voids('Cellar'), 0)
        self.assertEqual(voids('Ground floor'), 3)
        self.assertEqual(voids('Level 4'), 3)
        roofs = [s for s in self.f.by_type('IfcSlab') if s.PredefinedType == 'ROOF']
        self.assertTrue(roofs and all(ifcopenshell.util.element.get_container(r).Name == 'Level 6' for r in roofs))

    def test_property_sets_carry_the_zoning_and_area_figures(self):
        b = self.f.by_type('IfcBuilding')[0]
        z = ifcopenshell.util.element.get_pset(b, 'Arosa_Zoning')
        self.assertEqual(z['District'], self.site['district'])
        self.assertEqual(z['FloorAreaRatioAllowed'], self.account['far']['allowed'])
        self.assertEqual(z['ZoningFloorAreaSqft'], self.account['totals']['zfaSqft'])
        self.assertEqual(z['LotLines'], package.SURVEY_NOTE)
        self.assertEqual(ifcopenshell.util.element.get_pset(b, 'Pset_BuildingCommon')['NumberOfStoreys'], 7)
        row = next(r for r in self.account['storeys'] if r['label'] == 'Level 3')
        self.assertEqual(ifcopenshell.util.element.get_pset(self.storey('Level 3'), 'Arosa_StoreyArea')['ZoningFloorAreaSqft'], row['zfaSqft'])
        net = ifcopenshell.util.element.get_pset(self.storey('Level 3'), 'Arosa_StoreyArea')['NetFloorAreaSqft']
        self.assertAlmostEqual(net, sum(u['netSqft'] for u in package.units(self.doc, package.storeys(self.doc)[3], package.nets(self.doc))), places=0)

    def test_doors_and_windows_carry_schedule_marks_and_swing(self):
        marks = package.marks(self.doc)
        door = self.f.by_guid(self.ids[next(o['id'] for o in self.doc['openings'] if o['kind'] == 'door')]['ifcGlobalId'])
        self.assertEqual(door.Tag, ifcopenshell.util.element.get_pset(door, 'Pset_DoorCommon')['Reference'])
        self.assertIn(door.OperationType, ('SINGLE_SWING_LEFT', 'SINGLE_SWING_RIGHT', 'DOUBLE_DOOR_SLIDING'))
        self.assertEqual({m[0] for m in marks.values()}, {'D', 'W'})

    def test_the_model_passes_schema_and_ids_and_every_product_tessellates(self):
        self.assertEqual(len(ifc.check(self.f)['ids']), 10)
        settings = ifcopenshell.geom.settings()
        products = [p for p in self.f.by_type('IfcProduct') if p.Representation]
        for p in products:
            shape = ifcopenshell.geom.create_shape(settings, p)
            self.assertGreater(len(shape.geometry.verts), 0, p)

    def test_a_model_missing_a_required_figure_is_refused(self):
        f = ifcopenshell.open(self.path)
        for rel in list(f.by_type('IfcRelDefinesByProperties')):
            if rel.RelatingPropertyDefinition.Name == 'Pset_WallCommon':
                f.remove(rel)
                break
        with self.assertRaises(ifc.InvalidModel):
            ifc.check(f)

    def test_ids_map_the_first_storey_of_each_level(self):
        self.assertEqual(self.ids['typical']['ifcClass'], 'IfcBuildingStorey')
        self.assertEqual(self.f.by_guid(self.ids['typical']['ifcGlobalId']).Name, 'Level 2')
        wall = next(w['id'] for w in self.doc['walls'] if w['levelId'] == 'typical')
        self.assertEqual(ifcopenshell.util.element.get_container(self.f.by_guid(self.ids[wall]['ifcGlobalId'])).Name, 'Level 2')
        self.assertEqual(self.ids['site']['ifcClass'], 'IfcSite')


def read(path):
    with open(path, 'rb') as handle:
        return handle.read()


def load(path):
    return json.loads(read(path))


def pdf_pages(path):
    """The content streams of a PDF the drawing set wrote, one per page."""
    data = read(path)
    count = int(re.search(rb'/Type /Pages /Kids \[[^\]]*\] /Count (\d+)', data).group(1))
    streams = re.findall(rb'stream\n(.*?)\nendstream', data, re.S)
    return count, streams


def texts(page):
    return [item[3] for item in page.items if item[0] == 'text']


class Package(unittest.TestCase):
    """The whole revision export on a zoned corner lot: run.run_detailed writes the architect's files."""
    @classmethod
    def setUpClass(cls):
        cls.site = outlines('corner-100x125-R8')
        cls.doc = building(storeys=6, upper=3.0, site=cls.site)
        cls.doc['layout'] = {'checks': [
            {'rule': 'exits', 'text': 'Two exits on every storey', 'value': '2', 'pass': True, 'cite': 'NYC BC 2022 1006.3.2', 'basis': 'law'},
            {'rule': 'corridor', 'text': 'Corridor width at least 44 in', 'value': '5 ft 3 in', 'pass': True, 'cite': 'NYC BC 2022 Table 1020.2', 'basis': 'law'},
            {'rule': 'light', 'text': 'Every habitable room has a legal window', 'value': '2 rooms short', 'pass': False, 'cite': 'MDL 30', 'basis': 'law'},
            {'rule': 'refuse', 'text': 'Refuse room on each storey', 'value': 'yes', 'pass': True, 'cite': 'assumption', 'basis': 'assumption'}],
            'architect': ['Fire ratings of walls, doors and shafts, and stair and elevator details.', 'Lot lines come from the city tax map, not a survey.']}
        cls.dir = tempfile.mkdtemp()
        cls.out = run.run_detailed(cls.doc, cls.dir, write_plan=True)
        cls.account = load(os.path.join(cls.dir, 'zoning.json'))
        cls.pages, cls.sched, cls.check = drawings.sheets(cls.doc, cls.account)

    def test_the_package_files_are_written_and_zipped(self):
        for key in ('drawings', 'dxf', 'schedules', 'selfcheck', 'package', 'ifc', 'zd1Pdf'):
            self.assertIn(key, self.out['artifacts'])
        with zipfile.ZipFile(os.path.join(self.dir, 'package.zip')) as z:
            self.assertEqual(sorted(z.namelist()), sorted(run.PACKAGE_FILES))
            self.assertEqual(z.read('model.ifc'), read(os.path.join(self.dir, 'model.ifc')))

    def test_the_set_has_every_sheet_and_the_survey_caveat_on_each_page(self):
        numbers = [s['number'] for s in self.out['plan']['sheets']]
        self.assertEqual(numbers[:4], ['G-001', 'G-002', 'Z-001', 'A-001'])
        self.assertEqual([n for n in numbers if n.startswith('A-1')], ['A-101', 'A-102', 'A-103', 'A-104'])
        for n in ('A-201', 'A-202', 'A-301', 'A-601', 'A-602'):
            self.assertIn(n, numbers)
        count, streams = pdf_pages(os.path.join(self.dir, 'drawings.pdf'))
        self.assertEqual(count, len(numbers))
        self.assertEqual(len(streams), len(numbers))
        for stream in streams:
            self.assertIn(b"Lot lines come from the city's tax map, not a survey.", stream)
            self.assertIn(b'not for filing', stream)

    def test_each_plate_is_dimensioned_to_its_floor_and_draws_its_openings(self):
        for page, level in zip((p for p in self.pages if p.number.startswith('A-1')), sorted(self.doc['levels'], key=lambda l: l['elevation'])):
            floor = drawings.level_geometry(self.doc, level)['floor']
            minx, miny, maxx, maxy = floor.bounds
            self.assertIn(drawings.feet(maxx - minx), texts(page), page.number)
            self.assertIn(drawings.feet(maxy - miny), texts(page), page.number)
            self.assertIn(f"Floor to floor {drawings.feet(level['height'] / FOOT)}", ' '.join(texts(page)))
        ifc_model = ifcopenshell.open(os.path.join(self.dir, 'model.ifc'))
        idmap = load(os.path.join(self.dir, 'idmap.json'))['elements']
        for opening in self.doc['openings']:
            entry = idmap[opening['id']]
            self.assertEqual(ifc_model.by_guid(entry['ifcGlobalId']).is_a(), 'IfcDoor' if opening['kind'] == 'door' else 'IfcWindow')

    def test_a_plate_a_fraction_of_a_degree_off_the_axes_keeps_its_dimension_strings(self):
        doc = building(storeys=3)
        turn = lambda p: [round(p[0] * cos(0.0015) - p[1] * sin(0.0015), 6), round(p[0] * sin(0.0015) + p[1] * cos(0.0015), 6)]
        for w in doc['walls']:
            w['start'], w['end'] = turn(w['start']), turn(w['end'])
        for r in doc['rooms']:
            r['polygon'] = [turn(p) for p in r['polygon']]
        level = next(l for l in doc['levels'] if l['id'] == 'typical')
        page, _ = drawings.plan_sheet(doc, level, 'A-103', drawings.info_for(doc), None, package.nets(doc))
        straight, _ = drawings.plan_sheet(building(storeys=3), level, 'A-103', drawings.info_for(doc), None, package.nets(building(storeys=3)))
        labels = lambda p: sorted(t for t in texts(p) if re.fullmatch(r"\d+'-\d+\"", t))
        self.assertEqual(labels(page), labels(straight))
        self.assertGreater(len(labels(page)), 4)

    def test_the_cover_carries_the_zoning_table_and_drawing_list(self):
        cover = ' | '.join(texts(self.pages[0]))
        far = self.account['far']
        self.assertIn(f"{far['allowed']:g}", cover)
        self.assertIn(self.site['district'], cover)
        for page in self.pages[1:]:
            self.assertIn(page.number, cover)

    def test_schedules_add_up_and_read_back_from_the_workbook(self):
        sched = self.sched
        self.assertAlmostEqual(sched['areaTotals']['grossSqft'], sum(a['grossSqft'] for a in sched['areas']))
        self.assertEqual(sched['areaTotals']['units'], len(sched['units']))
        self.assertEqual(len(sched['doors']), sum(1 for s in package.storeys(self.doc) for o in self.doc['openings']
                                                   if o['kind'] == 'door' and o['wallId'].startswith(s['level']['id'] + '-')))
        book = load_workbook(os.path.join(self.dir, 'schedules.xlsx'))
        self.assertEqual(book.sheetnames, ['Areas', 'Units', 'Doors', 'Windows'])
        self.assertEqual(book['Units'].max_row - 1, len(sched['units']))
        self.assertEqual(book['Areas'].max_row - 1, len(package.storeys(self.doc)))
        self.assertTrue(all(u['unit'].startswith(('1', '2', '3', '4', '5', '6', '7')) for u in sched['units']))

    def test_the_self_check_sorts_passes_the_architect_and_out_of_scope(self):
        check = load(os.path.join(self.dir, 'selfcheck.json'))
        passes = [c['text'] for c in check['passes']]
        architect = [c['text'] for c in check['architect']]
        self.assertIn('Two exits on every storey: 2', passes)
        self.assertTrue(any(t.startswith('Floor area ratio') for t in passes + architect))
        self.assertIn('Every habitable room has a legal window: 2 rooms short', architect)
        self.assertIn('Refuse room on each storey: yes (an assumption, not a fixed rule)', architect)
        self.assertEqual(architect[0], package.SURVEY_NOTE)
        self.assertEqual(sum('not a survey' in t for t in architect), 1)
        self.assertEqual([c['text'].split(':')[0] for c in check['outOfScope']], ['Survey', 'Structure', 'Mechanical, electrical, plumbing and fire protection', 'Energy code'])

    def test_the_dxf_reads_back_clean_with_the_plan_elements(self):
        d = ezdxf.readfile(os.path.join(self.dir, 'drawings.dxf'))
        self.assertEqual(len(d.audit().errors), 0)
        self.assertEqual(d.units, ezdxf.units.IN)
        for level in self.doc['levels']:
            block = d.blocks.get(f"PLAN-{level['id']}".upper())
            layer = lambda name, kind=None: [e for e in block if e.dxf.layer == name and (kind is None or e.dxftype() == kind)]
            rooms = [r for r in self.doc['rooms'] if r['levelId'] == level['id']]
            openings = [o for o in self.doc['openings'] if o['wallId'].startswith(level['id'] + '-')]
            self.assertEqual(len(layer('A-AREA', 'LWPOLYLINE')), len(rooms))
            self.assertEqual(len(layer('A-GLAZ')), 4 * sum(1 for o in openings if o['kind'] == 'window'))
            self.assertEqual(len(layer('A-DOOR', 'ARC')), sum(1 for o in openings if o['kind'] == 'door' and not package.door_swing(self.doc, o)['sliding']))
        self.assertIsNotNone(d.blocks.get('SITE'))

    def test_a_plan_without_zoning_still_gets_its_package(self):
        doc = building(storeys=3)
        out_dir = tempfile.mkdtemp()
        out = run.run_detailed(doc, out_dir, write_plan=True)
        self.assertNotIn('zd1Pdf', out['artifacts'])
        self.assertNotIn('A-001', [s['number'] for s in out['plan']['sheets']])
        with zipfile.ZipFile(os.path.join(out_dir, 'package.zip')) as z:
            self.assertNotIn('zd1.pdf', z.namelist())
        check = load(os.path.join(out_dir, 'selfcheck.json'))
        self.assertTrue(any('no zoning envelope' in c['text'] for c in check['architect']))


class Layouts(unittest.TestCase):
    """Plans the layout engine draws today (one typical level, rooms without kinds) still export whole."""

    def test_typical_floors_on_the_outline_fixtures_export_their_package(self):
        with open(os.path.join(HERE, 'fixtures', 'outlines.json')) as handle:
            sites = json.load(handle)
        for name in ('skewed-50ft-R7A', 'through-40x200-R6B'):
            with self.subTest(name):
                site = sites[name]
                zfa = sum(s['zfaBudgetSqft'] for s in site['storeys'])
                lot = {'frontFeet': site['lot']['widthFeet'], 'depthFeet': site['lot']['depthFeet'], 'lotType': site['lot']['type']}
                req = {'lot': lot, 'district': site['district'], 'overlay': '', 'plateSqft': zfa / len(site['storeys']), 'unitsPerFloor': 4,
                       'storeys': len(site['storeys']), 'buildingUnits': 4 * len(site['storeys']), 'zfa': zfa, 'name': 'Typical floor', 'outlines': site,
                       'mix': [{'name': '1 bedroom', 'type': 'oneBedroom', 'share': 1.0, 'targetSqft': 650}]}
                doc = {**layout.typical_floor(req)['plan'], 'id': f'plan-{name}', 'revision': 1, 'parentRevision': None, 'zoning': site}
                out_dir = tempfile.mkdtemp()
                out = run.run_detailed(doc, out_dir, write_plan=True)
                self.assertIn('package', out['artifacts'])
                f = ifcopenshell.open(os.path.join(out_dir, 'model.ifc'))
                storeys = {l['id']: len(l.get('storeys') or [l]) for l in doc['levels']}
                self.assertGreater(max(storeys.values()), 1, 'the typical floor stands for its storeys')
                self.assertEqual(len(f.by_type('IfcWall')), sum(storeys[w['levelId']] for w in doc['walls']))
                walls = {w['id']: w['levelId'] for w in doc['walls']}
                self.assertEqual(len(f.by_type('IfcDoor')) + len(f.by_type('IfcWindow')), sum(storeys[walls[o['wallId']]] for o in doc['openings']))
                stairs = sum(1 for r in doc['rooms'] if r.get('kind') == 'stair' and r['levelId'] == doc['levels'][0]['id'])  # the core stacks: as many on every level
                self.assertGreater(stairs, 0)
                self.assertEqual(len(f.by_type('IfcStair')), stairs * (sum(storeys.values()) - 1), 'the stairs on every storey but the top')


if __name__ == '__main__':
    unittest.main()
