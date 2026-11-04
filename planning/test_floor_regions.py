"""Floor topology remains intact through detailed plan SVG, IFC, Pascal and ID-map exports."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

import ifcopenshell
import ifcopenshell.geom
from ifcopenshell.util.shape import get_volume
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

import architecture as arch
from run import run


def rectangles(bounds):
    xs = sorted({v for box in bounds for v in (box[0], box[2])})
    ys = sorted({v for box in bounds for v in (box[1], box[3])})
    edges, rooms = set(), []
    for i, (x0, y0, x1, y1) in enumerate(bounds):
        rooms.append({'id': f'room-{i+1}', 'levelId': 'floor', 'name': f'Room {i+1}', 'polygon': [[x0,y0],[x1,y0],[x1,y1],[x0,y1]], 'netAreaMethod': 'centerline'})
        xx, yy = [x for x in xs if x0 <= x <= x1], [y for y in ys if y0 <= y <= y1]
        edges.update(((a,y),(b,y)) for y in (y0,y1) for a,b in zip(xx,xx[1:]))
        edges.update(((x,a),(x,b)) for x in (x0,x1) for a,b in zip(yy,yy[1:]))
    walls = [{'id': f'wall-{i+1}', 'levelId': 'floor', 'start': list(a), 'end': list(b), 'thickness': .18, 'height': 2.8, 'material': 'generic', 'roomIds': []} for i,(a,b) in enumerate(sorted(edges))]
    for wall in walls:
        wall['roomIds'] = [room['id'] for room in rooms if arch.bounds_room(wall,room)]
    return {'schema': arch.SCHEMA, 'id': 'floor-regions', 'revision': 1, 'parentRevision': None, 'name': 'Floor regions', 'units': 'm',
            'levels': [{'id':'floor','name':'Floor','elevation':0,'height':2.8,'slabThickness':.2}], 'walls':walls, 'rooms':rooms, 'openings':[], 'objects':[], 'sources':[]}


def detached():
    plan = rectangles([(0,0,8,6)])
    plan['walls'].append({'id':'detached-wall','levelId':'floor','start':[10,10],'end':[12,10],'thickness':.18,'height':2.8,'material':'generic','roomIds':[]})
    return plan


def courtyard():
    return rectangles([(0,0,10,3),(0,7,10,10),(0,3,3,7),(7,3,10,7)])


def exported(plan):
    with tempfile.TemporaryDirectory(prefix='acres-floor-regions-') as directory:
        path = Path(directory)
        (path/'plan.json').write_text(json.dumps(plan))
        result = run({'plan': plan, 'outDir': directory})
        return {'result':result, 'ifc':ifcopenshell.open(str(path/'model.ifc')), 'svg':ET.fromstring((path/'plan.svg').read_text()),
                'scene':json.loads((path/'pascal-scene.json').read_text()), 'ids':json.loads((path/'idmap.json').read_text())}


def profile_polygon(slab):
    profile = slab.Representation.Representations[0].Items[0].SweptArea
    points = lambda curve: [tuple(p.Coordinates) for p in curve.Points]
    return Polygon(points(profile.OuterCurve), [points(curve) for curve in profile.InnerCurves] if profile.is_a('IfcArbitraryProfileDefWithVoids') else [])


class FloorRegions(unittest.TestCase):
    def test_disconnected_wall_preserves_both_regions_and_the_gap(self):
        plan = detached()
        self.assertEqual(arch.validate(plan), [])
        regions = arch.floor_regions(plan,'floor')
        self.assertEqual([r['id'] for r in regions], ['floor:slab','floor:slab:2'])
        geometry = unary_union([Polygon(r['polygon'],r['holes']) for r in regions])
        self.assertAlmostEqual(geometry.area,50.9124,places=6)
        self.assertTrue(geometry.covers(Point(11,10)))
        self.assertFalse(geometry.covers(Point(9,8)))
        self.assertEqual(plan,detached())

    def test_disconnected_rooms_classify_exterior_walls_without_crossing_the_gap(self):
        plan = rectangles([(0,0,4,4),(10,0,14,4)])
        self.assertEqual(arch.validate(plan), [])
        self.assertTrue(all(arch.is_exterior(plan,wall) for wall in plan['walls']))
        self.assertFalse(arch.is_exterior(plan,{'start':[1,1],'end':[2,1],'levelId':'floor'}))

    def test_disconnected_exports_keep_all_components_and_matching_element_ids(self):
        plan = detached();out = exported(plan)
        slabs = [s for s in out['ifc'].by_type('IfcSlab') if s.PredefinedType == 'FLOOR']  # the top storey also has its roof
        self.assertEqual(len(slabs),2)
        self.assertEqual(len(out['ifc'].by_type('IfcWall')),5)
        floor = unary_union([profile_polygon(slab) for slab in slabs])
        self.assertAlmostEqual(floor.area,50.9124,places=6)
        self.assertFalse(floor.covers(Point(9,8)))
        volume = sum(get_volume(ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(),slab).geometry) for slab in slabs)
        self.assertAlmostEqual(volume,50.9124*.2,places=6)
        nodes = out['scene']['nodes']
        self.assertEqual(sum(n['type']=='slab' for n in nodes.values()),2)
        for slab in slabs:
            key = next(key for key,row in out['ids']['elements'].items() if row['ifcGlobalId']==slab.GlobalId)
            node = nodes[out['ids']['elements'][key]['pascalNodeId']]
            self.assertEqual(node['metadata']['acresId'],key)
            self.assertEqual(node['parentId'],out['ids']['elements']['floor']['pascalNodeId'])
            self.assertAlmostEqual(Polygon([(x,-y) for x,y in node['polygon']]).area,profile_polygon(slab).area,places=6)
        self.assertEqual(len(out['svg'].findall('.//{*}g[@data-acres-id="detached-wall"]')),1)

    def test_courtyard_void_survives_ifc_mesh_and_pascal_polygon_holes(self):
        plan = courtyard();self.assertEqual(arch.validate(plan),[])
        wall = next(w for w in plan['walls'] if w['start']==[3,3] and w['end']==[7,3])
        self.assertTrue(arch.is_exterior(plan,wall))
        out = exported(plan);slab, = [s for s in out['ifc'].by_type('IfcSlab') if s.PredefinedType == 'FLOOR']
        polygon = profile_polygon(slab)
        self.assertEqual(len(polygon.interiors),1)
        self.assertFalse(polygon.covers(Point(5,5)))
        self.assertAlmostEqual(polygon.area,89.04,places=6)
        self.assertAlmostEqual(get_volume(ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(),slab).geometry),89.04*.2,places=6)
        node = out['scene']['nodes'][out['ids']['elements']['floor:slab']['pascalNodeId']]
        self.assertEqual(len(node['holes']),1)
        actual = Polygon([(x,-y) for x,y in node['polygon']], [[(x,-y) for x,y in ring] for ring in node['holes']])
        self.assertAlmostEqual(actual.symmetric_difference(polygon).area,0,places=6)

    def test_empty_level_has_no_invented_slab_and_keeps_a_readable_svg_panel(self):
        plan = rectangles([(0,0,8,6)])
        plan['levels'].append({'id':'future','name':'Future floor','elevation':3,'height':2.8,'slabThickness':.2})
        out = exported(plan)
        self.assertEqual(len(out['ifc'].by_type('IfcBuildingStorey')),2)
        self.assertEqual(len(out['ifc'].by_type('IfcSlab')),1)
        self.assertNotIn('future:slab',out['ids']['elements'])
        storey = next(s for s in out['ifc'].by_type('IfcBuildingStorey') if s.Name=='Future floor')
        self.assertEqual(len(storey.ContainsElements),0)
        panel = out['svg'].find('.//{*}g[@data-acres-id="future"]')
        self.assertIn('No walls or rooms on this level',''.join(panel.itertext()))
        self.assertEqual(len(panel.findall('.//{*}g[@class="dimension"]')),0)

    def test_an_empty_draft_exports_structure_without_fabricating_floor_geometry(self):
        out = exported(rectangles([]))
        self.assertEqual(len(out['ifc'].by_type('IfcBuildingStorey')),1)
        for kind in ['IfcSlab','IfcWall','IfcSpace']:
            self.assertEqual(len(out['ifc'].by_type(kind)),0)
        self.assertEqual(sorted(n['type'] for n in out['scene']['nodes'].values()),['building','level','site'])
        self.assertTrue(all(float(v)>0 for v in out['svg'].attrib['viewBox'].split()[2:]))

    def test_region_order_and_existing_element_ids_survive_reordering_and_revision(self):
        original = rectangles([(0,0,8,6)]);before = exported(original)
        plan = detached();reverse = copy.deepcopy(plan)
        reverse['walls'].reverse();reverse['rooms'].reverse()
        self.assertEqual(arch.floor_regions(plan,'floor'),arch.floor_regions(reverse,'floor'))
        plan['revision']=2;plan['parentRevision']=1;after=exported(plan)
        for key,row in before['ids']['elements'].items():
            self.assertEqual(row,after['ids']['elements'][key])
        self.assertIn('floor:slab:2',after['ids']['elements'])
        collision = detached();collision['walls'][-1]['id']='floor:slab:2'
        actual = exported(collision)
        roots = actual['ifc'].by_type('IfcRoot')
        self.assertEqual(len({root.GlobalId for root in roots}),len(roots))
        self.assertEqual(actual['ids']['elements']['floor:slab:2']['ifcClass'],'IfcWall')
        self.assertEqual(sum(row['ifcClass']=='IfcSlab' for row in actual['ids']['elements'].values()),2)


if __name__ == '__main__':
    unittest.main()
