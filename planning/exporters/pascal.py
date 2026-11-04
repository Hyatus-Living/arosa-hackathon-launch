"""Pascal exports.

concept_args: the acres_model_concept arguments (feet) so the test-fit massing renders in the existing
Pascal view. The tool builds from the ground up, so below-grade storeys are left out; identical
consecutive storeys collapse into one level with a count.

scene: a detailed Pascal scene ({nodes, rootNodeIds}) from an architecture plan v1, in metres. Plan
(x, y) maps to Pascal ground (x, -y) and elevation to Pascal Y. Walls stay on their centrelines, doors
and windows are children of their wall at a wall-local position (centre distance from the wall start,
centre height), and every room is its own selectable zone. Node ids derive from the plan id and
element id, so they survive revisions; each node's metadata.acresId names its plan element.

Pascal 1.0.4 (room-first) normalizes scenes on load: slab rings are rewound to positive signed
area in ground XZ, and zone polygons are re-derived from their boundary walls (gross, to wall
centrelines). The exporter therefore writes slab rings already canonical, while zone polygons
stay the plan's net (inside-wall-faces) rings: the stored file remains truthful to the plan and
metadata.netArea matches it; a loaded bridge view shows Pascal's derived gross ring instead.
"""
import hashlib
import json

import architecture as arch


def concept_args(name, summary, lot, plans, max_far=None, max_height=None):
    levels = []
    for p in plans:
        if p.elevation < 0:
            continue
        level = {'label': p.label, 'use': p.use, 'footprint': p.outline, 'height': p.height}
        if p.use == 'residential':
            level['units'] = p.metrics['units']
        prev = levels[-1] if levels else None
        if prev and all(prev.get(k) == level.get(k) for k in ('use', 'footprint', 'height', 'units')):
            prev['count'] = prev.get('count', 1) + 1
        else:
            levels.append(level)
    args = {'name': name, 'summary': summary, 'units': 'ft', 'lot': [[float(x), float(z)] for x, z in lot], 'levels': levels}
    if max_far:
        args['maxFar'] = max_far
    if max_height:
        args['maxHeightFeet'] = max_height
    return args


def write(path, args):
    with open(path, 'w') as handle:
        json.dump(args, handle, indent=1)


def node_id(prefix, plan_id, element_id):
    return f"{prefix}_{hashlib.sha256(f'{plan_id}/{element_id}'.encode()).hexdigest()[:16]}"


def ground(point):
    return [point[0], -point[1] if point[1] else 0.0]  # no -0.0 in the JSON


def canonical_ring(points):
    """Ground ring with positive signed area — the winding Pascal 1.0.4 keeps on load."""
    area = sum(x1 * z2 - x2 * z1 for (x1, z1), (x2, z2) in zip(points, points[1:] + points[:1])) / 2
    return points if area >= 0 else list(reversed(points))


def scene(plan):
    """Return ({nodes, rootNodeIds, collections, materials}, {elementId: pascalNodeId})."""
    nodes, ids = {}, {}

    def add(kind, element_id, parent, name, **fields):
        id_ = node_id(kind, plan['id'], element_id)
        nodes[id_] = {'object': 'node', 'id': id_, 'type': kind, 'name': name, 'parentId': parent, 'visible': True,
                      'metadata': {'acresId': element_id, 'planId': plan['id'], 'revision': plan['revision']}, **fields}
        if parent:
            nodes[parent]['children'].append(id_)
        ids[element_id] = id_
        return id_

    outlines = [p for level in plan['levels'] for region in arch.floor_regions(plan, level['id']) for p in region['polygon']] or [[0.0, 0.0]]
    xs, ys = [p[0] for p in outlines], [p[1] for p in outlines]
    margin = 2.0
    site_ring = [[min(xs) - margin, min(ys) - margin], [max(xs) + margin, min(ys) - margin], [max(xs) + margin, max(ys) + margin], [min(xs) - margin, max(ys) + margin]]
    site = add('site', 'site', None, 'Site', polygon={'type': 'polygon', 'points': [ground(p) for p in site_ring]}, children=[])
    building = add('building', 'building', site, plan['name'], children=[], position=[0, 0, 0], rotation=[0, 0, 0])
    stacked = 0.0
    for index, level in enumerate(plan['levels']):
        # Each additive offset moves this level and the remaining stack above it.
        level_id = add('level', level['id'], building, level['name'], children=[], level=index, baseElevation=round(level['elevation'] - stacked, 6), height=level['height'])
        stacked = level['elevation'] + level['height']
        for index, region in enumerate(arch.floor_regions(plan, level['id'])):
            add('slab', region['id'], level_id, f"{level['name']} slab" + (f' {index + 1}' if index else ''), polygon=canonical_ring([ground(p) for p in region['polygon']]),
                holes=[[ground(p) for p in hole] for hole in region['holes']],
                holeMetadata=[{'source': 'floor-opening', 'openingId': node_id('floor-opening', plan['id'], f"{region['id']}:void:{i}")} for i in range(len(region['holes']))],
                elevation=0.0, thickness=level['slabThickness'])
            for hole_index, hole in enumerate(region['holes']):
                # Pascal discovers every enclosed wall face as a room. Keep floor voids explicit
                # so a courtyard does not acquire a derived floor or ceiling on load.
                void_id = node_id('zone', plan['id'], f"{region['id']}:void:{hole_index}")
                nodes[void_id] = {'object': 'node', 'id': void_id, 'type': 'zone', 'name': f"{level['name']} void {hole_index + 1}",
                                  'parentId': level_id, 'visible': True, 'polygon': [ground(p) for p in hole],
                                  'spaceRole': 'room', 'enclosureStatus': 'open', 'hasFloor': False, 'hasCeiling': False,
                                  'metadata': {'floorVoid': True, 'floorRegionId': region['id'], 'planId': plan['id'], 'revision': plan['revision']}}
                nodes[level_id]['children'].append(void_id)
                opening_id = node_id('floor-opening', plan['id'], f"{region['id']}:void:{hole_index}")
                nodes[opening_id] = {'object': 'node', 'id': opening_id, 'type': 'floor-opening', 'name': f"{level['name']} void opening {hole_index + 1}",
                                     'parentId': level_id, 'visible': True, 'polygon': [ground(p) for p in hole], 'source': 'manual',
                                     'drawnOn': 'floor', 'cutsAdjacent': False, 'metadata': {'floorVoid': True, 'floorRegionId': region['id']}}
                nodes[level_id]['children'].append(opening_id)
        for wall in (w for w in plan['walls'] if w['levelId'] == level['id']):
            wall_id = add('wall', wall['id'], level_id, wall['id'], children=[], start=ground(wall['start']), end=ground(wall['end']), thickness=wall['thickness'], height=wall['height'])
            nodes[wall_id]['metadata']['material'] = wall['material']
            for opening in (o for o in plan['openings'] if o['wallId'] == wall['id']):
                fields = {'wallId': wall_id, 'position': [round(opening['offset'] + opening['width'] / 2, 6), round(opening['sill'] + opening['height'] / 2, 6), 0], 'rotation': [0, 0, 0], 'width': opening['width'], 'height': opening['height']}
                if opening['kind'] == 'door':
                    add('door', opening['id'], wall_id, opening['id'], doorType='hinged', **fields)
                else:
                    add('window', opening['id'], wall_id, opening['id'], windowType='fixed', **fields)
                nodes[ids[opening['id']]]['metadata']['swing'] = opening['swing']
        for room in (r for r in plan['rooms'] if r['levelId'] == level['id']):
            add('zone', room['id'], level_id, room['name'], polygon=[ground(p) for p in arch.net_polygon(plan, room)], spaceRole='room', enclosureStatus='enclosed',
                boundaryWallIds=[ids[w['id']] for w in plan['walls'] if room['id'] in w['roomIds']], ceilingHeight=level['height'], color='#3b82f6')
            nodes[ids[room['id']]]['metadata'].update(netArea=arch.net_area(plan, room), netAreaMethod=room['netAreaMethod'])
    return {'nodes': nodes, 'rootNodeIds': [site], 'collections': {}, 'materials': {}}, ids
