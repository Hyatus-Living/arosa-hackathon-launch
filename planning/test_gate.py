"""Gate: for the sample, the plan, the IFC (reopened and meshed by IfcOpenShell) and the Pascal scene agree
on dimensions, level height, room count, opening count and opening positions within 1 mm, and feet become
metres exactly once, by 0.3048.

Run with the project venv:  .venv/bin/python -m unittest test_gate -v
"""
import copy
import json
import os
import tempfile
import unittest
from math import hypot

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement
import ifcopenshell.util.shape
import numpy as np
from shapely.geometry import Polygon

import architecture as arch
from run import run

HERE = os.path.dirname(os.path.abspath(__file__))
MM = 0.001


def sample():
    with open(os.path.join(HERE, 'fixtures', 'sample-floorplan.json')) as handle:
        return json.load(handle)


def in_feet(layout):
    feet = copy.deepcopy(layout)
    feet['units'] = 'ft'
    ft = lambda value: value / 0.3048
    feet['height'], feet['wall_thickness'], feet['floor_thickness'] = ft(layout['height']), ft(layout['wall_thickness']), ft(layout['floor_thickness'])
    for wall in feet['walls']:
        wall['start'], wall['end'] = [ft(v) for v in wall['start']], [ft(v) for v in wall['end']]
    for opening in feet['openings']:
        for key in ('offset', 'width', 'height', 'sill'):
            opening[key] = ft(opening[key])
    for room in feet['rooms']:
        room['bounds'] = [ft(v) for v in room['bounds']]
    return feet


def export(layout):
    out_dir = tempfile.mkdtemp()
    run({'layout': layout, 'planId': 'plan-gate', 'revision': 1, 'outDir': out_dir})

    def load(name):
        with open(os.path.join(out_dir, name)) as handle:
            return json.load(handle)
    return load('plan.json'), ifcopenshell.open(os.path.join(out_dir, 'model.ifc')), load('pascal-scene.json'), load('idmap.json')


class Gate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = sample()
        # The fixture enters in feet, as it would through the acres_plan_concept tool boundary.
        cls.plan, cls.ifc, cls.scene, cls.idmap = export(in_feet(cls.source))
        cls.settings = ifcopenshell.geom.settings()
        cls.settings.set('use-world-coords', True)

    def near(self, a, b, what):
        self.assertTrue(np.allclose(a, b, atol=MM, rtol=0), f'{what}: {a} != {b}')

    def ifc_of(self, element_id):
        return self.ifc.by_guid(self.idmap['elements'][element_id]['ifcGlobalId'])

    def pascal_of(self, element_id):
        return self.scene['nodes'][self.idmap['elements'][element_id]['pascalNodeId']]

    def mesh(self, element):
        shape = ifcopenshell.geom.create_shape(self.settings, element)
        return np.array(shape.geometry.verts).reshape(-1, 3), ifcopenshell.util.shape.get_volume(shape.geometry)

    def test_feet_convert_to_metres_once_with_0_3048(self):
        self.assertEqual(arch.FOOT, 0.3048)
        self.assertEqual(arch.UNIT_SCALE['ft'], 0.3048)
        # 2.8 m entered as 9.186351706... ft comes back as 2.8 m: not 0.853 (twice) or 9.19 (never).
        self.near(self.plan['levels'][0]['height'], self.source['height'], 'level height')
        for wall, source in zip(self.plan['walls'], self.source['walls']):
            self.near(wall['start'] + wall['end'], source['start'] + source['end'], wall['id'])
            self.near(wall['thickness'], self.source['wall_thickness'], wall['id'])
        for opening, source in zip(self.plan['openings'], self.source['openings']):
            self.near([opening[k] for k in ('offset', 'width', 'height', 'sill')], [source[k] for k in ('offset', 'width', 'height', 'sill')], opening['id'])

    def test_counts_agree(self):
        nodes = self.scene['nodes'].values()
        count = lambda kind: sum(1 for n in nodes if n['type'] == kind)
        self.assertEqual((len(self.plan['rooms']), len(self.ifc.by_type('IfcSpace')), count('zone')), (5, 5, 5))
        self.assertEqual((len(self.plan['openings']), len(self.ifc.by_type('IfcOpeningElement')), count('door') + count('window')), (9, 9, 9))
        self.assertEqual((len(self.ifc.by_type('IfcDoor')), count('door')), (5, 5))
        self.assertEqual((len(self.ifc.by_type('IfcWindow')), count('window')), (4, 4))
        self.assertEqual((len(self.plan['walls']), len(self.ifc.by_type('IfcWall')), count('wall')), (8, 8, 8))

    def test_level_height_agrees(self):
        level = self.plan['levels'][0]
        storey = self.ifc_of('level-1')
        self.near(ifcopenshell.util.element.get_pset(storey, 'Qto_BuildingStoreyBaseQuantities')['GrossHeight'], 2.8, 'IFC storey height')
        self.near(self.pascal_of('level-1')['height'], 2.8, 'Pascal level height')
        self.near(level['height'], 2.8, 'plan level height')
        for wall in self.plan['walls']:
            verts, _ = self.mesh(self.ifc_of(wall['id']))
            self.near([verts[:, 2].min(), verts[:, 2].max()], [0.0, 2.8], f'IFC {wall["id"]} height')
            self.near(self.pascal_of(wall['id'])['height'], 2.8, f'Pascal {wall["id"]} height')

    def test_dimensions_agree(self):
        # Centrelines: 10 m by 8 m in the plan, the IFC wall axes and the Pascal walls.
        for wall in self.plan['walls']:
            element = self.ifc_of(wall['id'])
            matrix = ifcopenshell.util.placement.get_local_placement(element.ObjectPlacement)
            axis = next(r for r in element.Representation.Representations if r.RepresentationIdentifier == 'Axis').Items[0].Points
            length = hypot(*(np.array(axis[1].Coordinates) - np.array(axis[0].Coordinates)))
            start = matrix[:2, 3]
            end = start + matrix[:2, 0] * length
            self.near(list(start) + list(end), wall['start'] + wall['end'], f'IFC axis {wall["id"]}')
            node = self.pascal_of(wall['id'])
            self.near(node['start'] + node['end'], [wall['start'][0], -wall['start'][1], wall['end'][0], -wall['end'][1]], f'Pascal {wall["id"]}')
            self.near(node['thickness'], wall['thickness'], f'Pascal {wall["id"]} thickness')
        # Outer faces: 10.18 m by 8.18 m from the meshed IFC walls and slab and the Pascal slab.
        walls = np.vstack([self.mesh(w)[0] for w in self.ifc.by_type('IfcWall')])
        self.near([walls[:, 0].min(), walls[:, 1].min(), walls[:, 0].max(), walls[:, 1].max()], [-0.09, -0.09, 10.09, 8.09], 'IFC wall extents')
        slab, slab_volume = self.mesh(self.ifc_of('level-1:slab'))
        self.near([slab[:, 0].min(), slab[:, 1].min(), slab[:, 2].min(), slab[:, 0].max(), slab[:, 1].max(), slab[:, 2].max()], [-0.09, -0.09, -0.2, 10.09, 8.09, 0.0], 'IFC slab')
        self.near(slab_volume, 10.18 * 8.18 * 0.2, 'IFC slab volume')
        points = np.array(self.pascal_of('level-1:slab')['polygon'])
        self.near([points[:, 0].min(), -points[:, 1].max(), points[:, 0].max(), -points[:, 1].min()], [-0.09, -0.09, 10.09, 8.09], 'Pascal slab')

    def test_openings_are_cut_from_their_walls(self):
        for wall in self.plan['walls']:
            ext_start, ext_end = arch.wall_extensions(self.plan, wall)
            solid = (arch.wall_length(wall) + ext_start + ext_end) * wall['thickness'] * wall['height']
            cut = sum(o['width'] * wall['thickness'] * o['height'] for o in self.plan['openings'] if o['wallId'] == wall['id'])
            _, volume = self.mesh(self.ifc_of(wall['id']))
            self.near(volume, solid - cut, f'{wall["id"]} volume after openings')

    def test_opening_positions_agree(self):
        for opening, source in zip(self.plan['openings'], self.source['openings']):
            wall = next(w for w in self.plan['walls'] if w['id'] == opening['wallId'])
            # The source drawing measures each opening from its wall's start point.
            source_wall = next(w for w in self.source['walls'] if w['id'] == source['wall'])
            length = hypot(source_wall['end'][0] - source_wall['start'][0], source_wall['end'][1] - source_wall['start'][1])
            ux, uy = (source_wall['end'][0] - source_wall['start'][0]) / length, (source_wall['end'][1] - source_wall['start'][1]) / length
            centre = source['offset'] + source['width'] / 2
            expected = [source_wall['start'][0] + ux * centre, source_wall['start'][1] + uy * centre, source['sill'] + source['height'] / 2]
            # IFC: the opening element's world placement is its lower-left corner on the wall axis.
            void = self.ifc.by_guid(self.idmap['elements'][opening['id']]['ifcOpeningGlobalId'])
            matrix = ifcopenshell.util.placement.get_local_placement(void.ObjectPlacement)
            ifc_centre = matrix[:3, 3] + matrix[:3, 0] * opening['width'] / 2 + matrix[:3, 2] * opening['height'] / 2
            self.near(ifc_centre, expected, f'IFC {opening["id"]}')
            filling = self.ifc_of(opening['id'])
            self.near([filling.OverallWidth, filling.OverallHeight], [source['width'], source['height']], f'IFC {opening["id"]} size')
            verts, _ = self.mesh(filling)
            self.near([(verts[:, k].min() + verts[:, k].max()) / 2 for k in range(3)], expected, f'IFC {opening["id"]} mesh centre')
            # Pascal: wall-local position along the wall from its start, at centre height.
            node = self.pascal_of(opening['id'])
            host = self.scene['nodes'][node['wallId']]
            hx, hz = host['start']
            ex, ez = host['end']
            along = node['position'][0] / hypot(ex - hx, ez - hz)
            px, pz = hx + (ex - hx) * along, hz + (ez - hz) * along
            self.near([px, -pz, node['position'][1]], expected, f'Pascal {opening["id"]}')
            self.near([node['width'], node['height']], [source['width'], source['height']], f'Pascal {opening["id"]} size')
            self.assertEqual(node['type'], source['kind'])
            self.assertEqual(host['metadata']['acresId'], wall['id'])

    def test_rooms_agree(self):
        for room, source in zip(self.plan['rooms'], self.source['rooms']):
            x0, y0, x1, y1 = source['bounds']
            self.near(sorted(map(tuple, room['polygon'])), sorted([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]), room['id'])
            net = (x1 - x0 - 0.18) * (y1 - y0 - 0.18)  # every sample room is bounded by 0.18 m walls on all sides
            space = self.ifc_of(room['id'])
            self.assertEqual(space.Name, source['name'])
            self.near(ifcopenshell.util.element.get_pset(space, 'Qto_SpaceBaseQuantities')['NetFloorArea'], net, f'IFC {room["id"]} net area')
            verts, volume = self.mesh(space)
            # A room rises to the underside of the slab above: the storey height less the floor thickness.
            self.near(volume / (self.source['height'] - self.source['floor_thickness']), net, f'IFC {room["id"]} meshed area')
            self.near([verts[:, 0].min(), verts[:, 1].min(), verts[:, 0].max(), verts[:, 1].max()], [x0 + 0.09, y0 + 0.09, x1 - 0.09, y1 - 0.09], f'IFC {room["id"]} extents')
            zone = self.pascal_of(room['id'])
            self.assertEqual(zone['name'], source['name'])
            self.near(Polygon([(x, -z) for x, z in zone['polygon']]).area, net, f'Pascal {room["id"]} area')
            self.near(zone['metadata']['netArea'], net, f'Pascal {room["id"]} metadata area')


if __name__ == '__main__':
    unittest.main()
