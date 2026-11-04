"""Detailed exports from one architecture plan revision: SVG, IFC4, Pascal scene and the id map.

Run with the project venv:  .venv/bin/python -m unittest test_exporters -v
"""
import json
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET

import ifcopenshell
import ifcopenshell.guid
import ifcopenshell.util.element

from architecture import from_layout
from run import run

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = {'plan': 'plan.json', 'svg': 'plan.svg', 'ifc': 'model.ifc', 'pascalScene': 'pascal-scene.json', 'idMap': 'idmap.json',
         'drawings': 'drawings.pdf', 'dxf': 'drawings.dxf', 'schedules': 'schedules.xlsx', 'selfcheck': 'selfcheck.json', 'package': 'package.zip'}


def sample():
    with open(os.path.join(HERE, 'fixtures', 'sample-floorplan.json')) as handle:
        return json.load(handle)


def export(revision=1, parent=None, layout=None):
    out_dir = tempfile.mkdtemp()
    out = run({'layout': layout or sample(), 'planId': 'plan-sample', 'revision': revision, 'parentRevision': parent, 'outDir': out_dir})
    return out, out_dir


class Exports(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out, cls.dir = export()
        cls.path = lambda self, key: os.path.join(self.dir, FILES[key])
        cls.ifc = ifcopenshell.open(os.path.join(cls.dir, 'model.ifc'))
        with open(os.path.join(cls.dir, 'pascal-scene.json')) as handle:
            cls.scene = json.load(handle)
        with open(os.path.join(cls.dir, 'idmap.json')) as handle:
            cls.idmap = json.load(handle)

    def test_every_artifact_is_written_with_hash_and_size(self):
        self.assertEqual({k: v['file'] for k, v in self.out['artifacts'].items()}, FILES)
        for key, artifact in self.out['artifacts'].items():
            self.assertEqual(os.path.getsize(self.path(key)), artifact['bytes'])
            self.assertEqual(len(artifact['sha256']), 64)
        summary = self.out['plan']
        self.assertEqual((summary['id'], summary['revision'], summary['parentRevision']), ('plan-sample', 1, None))
        self.assertEqual(summary['counts'], {'levels': 1, 'walls': 8, 'openings': 9, 'doors': 5, 'windows': 4, 'rooms': 5})
        living = next(r for r in summary['rooms'] if r['id'] == 'room-living')
        self.assertEqual(living, {'id': 'room-living', 'name': 'Living / dining', 'netArea': 26.0524})

    def test_ifc_spatial_hierarchy(self):
        f = self.ifc
        self.assertEqual(f.schema, 'IFC4')
        project, = f.by_type('IfcProject')
        site, = f.by_type('IfcSite')
        building, = f.by_type('IfcBuilding')
        storey, = f.by_type('IfcBuildingStorey')
        self.assertEqual(ifcopenshell.util.element.get_aggregate(site), project)
        self.assertEqual(ifcopenshell.util.element.get_aggregate(building), site)
        self.assertEqual(ifcopenshell.util.element.get_aggregate(storey), building)
        self.assertEqual(storey.Name, 'Level 1')
        spaces = f.by_type('IfcSpace')
        self.assertEqual(sorted(s.Name for s in spaces), ['Bathroom', 'Bedroom A', 'Bedroom B', 'Kitchen', 'Living / dining'])
        self.assertTrue(all(ifcopenshell.util.element.get_aggregate(s) == storey for s in spaces))
        contained, = storey.ContainsElements
        counts = {}
        for element in contained.RelatedElements:
            counts[element.is_a()] = counts.get(element.is_a(), 0) + 1
        self.assertEqual(counts, {'IfcWall': 8, 'IfcSlab': 2, 'IfcDoor': 5, 'IfcWindow': 4})  # the floor and, on the top storey, the roof

    def test_ifc_walls_slab_and_opening_relationships(self):
        f = self.ifc
        self.assertEqual(len(f.by_type('IfcWall')), 8)
        self.assertEqual(sorted(s.PredefinedType for s in f.by_type('IfcSlab')), ['FLOOR', 'ROOF'])
        openings = f.by_type('IfcOpeningElement')
        self.assertEqual(len(openings), 9)
        for opening in openings:
            self.assertEqual(len(opening.VoidsElements), 1)
            self.assertEqual(opening.VoidsElements[0].RelatingBuildingElement.is_a(), 'IfcWall')
            self.assertEqual(len(opening.HasFillings), 1)
        fillings = [o.HasFillings[0].RelatedBuildingElement for o in openings]
        self.assertEqual(sorted(e.is_a() for e in fillings), ['IfcDoor'] * 5 + ['IfcWindow'] * 4)
        entry = next(e for e in fillings if e.Name == 'opening-entry')
        self.assertAlmostEqual(entry.OverallWidth, 0.9)
        self.assertAlmostEqual(entry.OverallHeight, 2.1)
        south = entry.FillsVoids[0].RelatingOpeningElement.VoidsElements[0].RelatingBuildingElement
        self.assertEqual(south.Name, 'wall-south')
        self.assertTrue(ifcopenshell.util.element.get_pset(south, 'Pset_WallCommon')['IsExternal'])
        self.assertFalse(ifcopenshell.util.element.get_pset(f.by_type('IfcWall')[4], 'Pset_WallCommon')['IsExternal'])

    def test_global_ids_are_valid_unique_and_stable_across_revisions(self):
        rooted = self.ifc.by_type('IfcRoot')
        ids = [e.GlobalId for e in rooted]
        self.assertEqual(len(ids), len(set(ids)))
        for gid in ids:
            self.assertEqual(len(gid), 22)
            ifcopenshell.guid.expand(gid)
        _, dir2 = export(revision=2, parent=1)
        with open(os.path.join(dir2, 'idmap.json')) as handle:
            second = json.load(handle)
        self.assertEqual(second['revision'], 2)
        self.assertEqual(second['elements'], self.idmap['elements'])

    def test_id_map_links_plan_ifc_and_pascal(self):
        self.assertEqual(self.idmap['schema'], 'acres.architecture.idmap/1')
        self.assertEqual((self.idmap['planId'], self.idmap['revision']), ('plan-sample', 1))
        elements = self.idmap['elements']
        plan = self.out_plan()
        plan_ids = ['level-1'] + [item['id'] for kind in ('walls', 'openings', 'rooms') for item in plan[kind]]
        for plan_id in plan_ids:
            entry = elements[plan_id]
            element = self.ifc.by_guid(entry['ifcGlobalId'])
            self.assertEqual(element.is_a(), entry['ifcClass'])
            self.assertIn(entry['pascalNodeId'], self.scene['nodes'])
            self.assertEqual(self.scene['nodes'][entry['pascalNodeId']]['metadata']['acresId'], plan_id)
        self.assertEqual(elements['room-kitchen']['ifcClass'], 'IfcSpace')
        self.assertEqual(elements['opening-entry']['ifcClass'], 'IfcDoor')
        self.assertEqual(elements['opening-entry']['ifcOpeningGlobalId'], self.ifc.by_guid(elements['opening-entry']['ifcGlobalId']).FillsVoids[0].RelatingOpeningElement.GlobalId)
        self.assertEqual(elements['level-1:slab']['ifcClass'], 'IfcSlab')

    def out_plan(self):
        with open(self.path('plan')) as handle:
            return json.load(handle)

    def test_pascal_scene_has_selectable_rooms_walls_and_openings(self):
        nodes = self.scene['nodes']
        site, = self.scene['rootNodeIds']
        self.assertEqual(nodes[site]['type'], 'site')
        by_type = {}
        for node in nodes.values():
            by_type.setdefault(node['type'], []).append(node)
            if node['parentId']:
                self.assertIn(node['id'], nodes[node['parentId']]['children'])
        self.assertEqual({k: len(v) for k, v in by_type.items()}, {'site': 1, 'building': 1, 'level': 1, 'wall': 8, 'door': 5, 'window': 4, 'slab': 1, 'zone': 5})
        rooms = {z['name']: z for z in by_type['zone']}
        self.assertEqual(sorted(rooms), ['Bathroom', 'Bedroom A', 'Bedroom B', 'Kitchen', 'Living / dining'])
        kitchen = rooms['Kitchen']
        self.assertEqual((kitchen['spaceRole'], kitchen['enclosureStatus']), ('room', 'enclosed'))
        self.assertTrue(all(nodes[w]['type'] == 'wall' for w in kitchen['boundaryWallIds']))
        self.assertEqual(len(kitchen['boundaryWallIds']), 4)
        for opening in by_type['door'] + by_type['window']:
            self.assertEqual(nodes[opening['wallId']]['type'], 'wall')
            self.assertEqual(opening['parentId'], opening['wallId'])

    def test_svg_is_dimensioned_with_addressable_rooms(self):
        tree = ET.parse(self.path('svg'))
        text = ' '.join(t.text or '' for t in tree.iter('{http://www.w3.org/2000/svg}text'))
        self.assertIn('10.00 m', text)
        self.assertIn('8.00 m', text)
        for name in ('Living / dining', 'Kitchen', 'Bedroom A', 'Bedroom B', 'Bathroom'):
            self.assertIn(name, text)
        self.assertIn('280 sq ft', text)
        ids = [e.get('data-acres-id') for e in tree.iter() if e.get('data-acres-id')]
        self.assertEqual(len([i for i in ids if i.startswith('room-')]), 5)
        self.assertEqual(len([i for i in ids if i.startswith('wall-')]), 8)
        self.assertEqual(len([i for i in ids if i.startswith('opening-')]), 9)

    def test_names_are_escaped_in_svg(self):
        layout = sample()
        layout['rooms'][0]['name'] = 'Living <script>&'
        out, out_dir = export(layout=layout)
        tree = ET.parse(os.path.join(out_dir, 'plan.svg'))
        self.assertIn('Living <script>&', ' '.join(t.text or '' for t in tree.iter('{http://www.w3.org/2000/svg}text')))
        self.assertEqual(list(tree.iter('{http://www.w3.org/2000/svg}script')), [])

    def test_a_plan_document_exports_without_rewriting_its_plan_json(self):
        with open(os.path.join(HERE, 'fixtures', 'sample-plan.json')) as handle:
            doc = json.load(handle)
        self.assertEqual(doc, json.loads(json.dumps(from_layout(sample(), 'sample'))))
        out_dir = tempfile.mkdtemp()
        original = b'{"caller": "wrote this"}'
        with open(os.path.join(out_dir, 'plan.json'), 'wb') as handle:
            handle.write(original)
        out = run({'plan': {**doc, 'revision': 3, 'parentRevision': 2}, 'outDir': out_dir})
        with open(os.path.join(out_dir, 'plan.json'), 'rb') as handle:
            self.assertEqual(handle.read(), original)
        self.assertEqual(sorted(os.listdir(out_dir)), sorted(FILES.values()))
        self.assertEqual((out['plan']['revision'], out['plan']['parentRevision']), (3, 2))
        self.assertEqual(out['artifacts']['plan']['bytes'], len(original))
        with open(os.path.join(out_dir, 'idmap.json')) as handle:
            self.assertEqual(json.load(handle)['revision'], 3)

    def test_an_editor_plan_without_slab_thickness_exports_with_the_default_slab(self):
        # The browser editor and the research agent write the core v1 fields only: no
        # levels[].slabThickness, a string swing and centreline room areas.
        with open(os.path.join(HERE, 'fixtures', 'sample-plan.json')) as handle:
            doc = json.load(handle)
        for level in doc['levels']:
            del level['slabThickness']
        doc['openings'][0]['swing'] = 'left'
        for room in doc['rooms']:
            room['netAreaMethod'] = 'centerline'
        out_dir = tempfile.mkdtemp()
        with open(os.path.join(out_dir, 'plan.json'), 'w') as handle:
            json.dump(doc, handle)
        out = run({'plan': {**doc, 'revision': 1, 'parentRevision': None}, 'outDir': out_dir})
        self.assertEqual(sorted(os.listdir(out_dir)), sorted(FILES.values()))
        self.assertEqual(out['plan']['counts']['walls'], len(doc['walls']))
        slab = ifcopenshell.open(os.path.join(out_dir, 'model.ifc')).by_type('IfcSlab')[0]
        self.assertAlmostEqual(slab.Representation.Representations[0].Items[0].Depth, 0.2)

    def test_an_invalid_plan_writes_nothing(self):
        layout = sample()
        layout['openings'][0]['offset'] = 9.5
        out_dir = tempfile.mkdtemp()
        with self.assertRaises(ValueError) as caught:
            run({'layout': layout, 'planId': 'plan-sample', 'revision': 1, 'outDir': out_dir})
        self.assertIn('opening_outside_wall', str(caught.exception))
        self.assertEqual(os.listdir(out_dir), [])


if __name__ == '__main__':
    unittest.main()
