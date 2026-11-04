"""Architecture plan v1: the one editable geometry document every detailed export is derived from.

Units are metres. Plan axes: x east, y north, elevation up. IFC uses the same axes (X, Y, Z up);
Pascal's ground is XZ with Y up, so a plan point (x, y) is Pascal (x, -y) and elevation is Pascal Y,
which keeps the model right-handed rather than mirrored.

from_layout converts the simple layout shape of planning/fixtures/sample-floorplan.json (walls by
centreline, openings by parent wall and offset from the wall start, rooms by bounds or polygon). Feet
become metres here and nowhere else, multiplying once by FOOT. validate returns structured errors.
"""
from math import hypot

from shapely.geometry import LineString, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

SCHEMA = 'acres.architecture.plan/1'
FOOT = 0.3048
UNIT_SCALE = {'m': 1.0, 'metres': 1.0, 'meters': 1.0, 'ft': FOOT, 'feet': FOOT}
TOL = 0.001  # 1 mm: the geometric tolerance for coverage, overlap and containment
SLAB_THICKNESS = 0.2  # metres, for levels that do not give levels[].slabThickness (the editor and agent drafts)
NET_AREA_METHOD = 'inside-wall-faces'


def from_layout(layout, plan_id, revision=1, parent_revision=None):
    scale = UNIT_SCALE[layout['units']]
    m = lambda value: round(value * scale, 6)
    point = lambda p: [m(p[0]), m(p[1])]
    level_id = 'level-1'
    walls = [{
        'id': f"wall-{w['id']}", 'levelId': level_id, 'start': point(w['start']), 'end': point(w['end']),
        'thickness': m(w.get('thickness', layout['wall_thickness'])), 'height': m(w.get('height', layout['height'])),
        'material': w.get('material', 'generic'), 'roomIds': [],
    } for w in layout['walls']]
    openings = [{
        'id': f"opening-{o['id']}", 'wallId': f"wall-{o['wall']}", 'kind': o['kind'],
        'offset': m(o['offset']), 'width': m(o['width']), 'sill': m(o.get('sill', 0)), 'height': m(o['height']),
        'swing': o.get('swing'),
    } for o in layout['openings']]
    rooms = []
    for r in layout['rooms']:
        if 'bounds' in r:
            x0, y0, x1, y1 = r['bounds']
            polygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        else:
            polygon = r['polygon']
        rooms.append({'id': f"room-{r['id']}", 'levelId': level_id, 'name': r['name'], 'polygon': [point(p) for p in polygon], 'netAreaMethod': NET_AREA_METHOD})
    plan = {
        'schema': SCHEMA, 'id': plan_id, 'revision': revision, 'parentRevision': parent_revision,
        'name': layout['name'], 'units': 'm',
        'levels': [{'id': level_id, 'name': 'Level 1', 'elevation': 0.0, 'height': m(layout['height']), 'slabThickness': m(layout['floor_thickness'])}],
        'walls': walls, 'openings': openings, 'rooms': rooms, 'objects': [],
        'sources': [{'kind': 'layout', 'ref': layout['name']}],
    }
    for wall in walls:
        wall['roomIds'] = sorted(room['id'] for room in rooms if bounds_room(wall, room))
    return plan


# Derived geometry shared by the validator and every exporter.

def centreline(wall):
    return LineString([wall['start'], wall['end']])


def wall_length(wall):
    return hypot(wall['end'][0] - wall['start'][0], wall['end'][1] - wall['start'][1])


def wall_direction(wall):
    length = wall_length(wall)
    return ((wall['end'][0] - wall['start'][0]) / length, (wall['end'][1] - wall['start'][1]) / length)


def point_along(wall, distance):
    dx, dy = wall_direction(wall)
    return (wall['start'][0] + dx * distance, wall['start'][1] + dy * distance)


def bounds_room(wall, room):
    return Polygon(room['polygon']).exterior.intersection(centreline(wall)).length > TOL


def wall_extensions(plan, wall):
    """How far the wall body runs past its start and end: half its thickness where it meets another
    wall's end at a corner, so corners close; nothing at a T, where it already ends inside the other wall."""
    def extension(end):
        corner = any(other is not wall and other['levelId'] == wall['levelId'] and any(hypot(end[0] - p[0], end[1] - p[1]) <= TOL for p in (other['start'], other['end'])) for other in plan['walls'])
        return wall['thickness'] / 2 if corner else 0.0
    return extension(wall['start']), extension(wall['end'])


def wall_footprint(plan, wall):
    ext_start, ext_end = wall_extensions(plan, wall)
    a, b = point_along(wall, -ext_start), point_along(wall, wall_length(wall) + ext_end)
    return LineString([a, b]).buffer(wall['thickness'] / 2, cap_style='flat', join_style='mitre')


def is_exterior(plan, wall):
    rooms = [Polygon(r['polygon']) for r in plan['rooms'] if r['levelId'] == wall['levelId']]
    return bool(rooms) and unary_union(rooms).boundary.intersection(centreline(wall)).length > TOL


def net_polygon(plan, room):
    """The room inside its walls' faces, as a ring of [x, y] points (counter-clockwise, unclosed)."""
    walls = unary_union([wall_footprint(plan, w) for w in plan['walls'] if w['levelId'] == room['levelId']])
    inside = Polygon(room['polygon']).difference(walls)
    if inside.geom_type == 'MultiPolygon':
        inside = max(inside.geoms, key=lambda g: g.area)
    ring = list(orient(inside.simplify(TOL / 10), 1.0).exterior.coords)[:-1]
    return [[round(x, 6), round(y, 6)] for x, y in ring]


def gross_area(room):
    return round(Polygon(room['polygon']).area, 4)


def net_area(plan, room):
    return round(Polygon(net_polygon(plan, room)).area, 4)


def floor_regions(plan, level_id):
    """Separate floor polygons to the outer wall faces, retaining gaps and courtyard voids."""
    shapes = [Polygon(r['polygon']) for r in plan['rooms'] if r['levelId'] == level_id]
    shapes += [wall_footprint(plan, w) for w in plan['walls'] if w['levelId'] == level_id]
    union = unary_union(shapes)
    if union.is_empty:
        return []
    parts = list(union.geoms) if union.geom_type == 'MultiPolygon' else [union]
    parts.sort(key=lambda p: (-p.area, p.bounds, p.normalize().wkb))

    def ring(coords):
        points = [[round(x, 6), round(y, 6)] for x, y in list(coords)[:-1]]
        start = min(range(len(points)), key=points.__getitem__)
        return points[start:] + points[:start]

    regions = []
    used = {item['id'] for key in ('levels', 'walls', 'openings', 'rooms', 'objects') for item in plan[key]}
    for index, part in enumerate(parts):
        polygon = orient(part.simplify(TOL / 10), 1.0)
        element_id = f'{level_id}:slab' + (f':{index + 1}' if index else '')
        while element_id in used:
            element_id += ':floor'
        used.add(element_id)
        regions.append({'id': element_id,
                        'polygon': ring(polygon.exterior.coords), 'holes': sorted(ring(hole.coords) for hole in polygon.interiors)})
    return regions


def levels_of(plan):
    """Each level with what it stands for: {level, use, storeys, rooms, plate}. storeys is the level's
    [{id, name, elevation}] (elevation in metres above curb), or the level itself as one storey when it names
    none, as editor plans and older revisions do; use is the level's use (cellar, ground, residential) or None;
    plate is the union of its rooms in metres, a shapely geometry (empty without rooms)."""
    out = []
    for level in plan['levels']:
        rooms = [r for r in plan['rooms'] if r['levelId'] == level['id']]
        out.append({'level': level, 'use': level.get('use'), 'rooms': rooms,
                    'storeys': level.get('storeys') or [{'id': level['id'], 'name': level['name'], 'elevation': level['elevation']}],
                    'plate': unary_union([Polygon(r['polygon']) for r in rooms if len(r['polygon']) >= 3])})
    return out


# Validation.

def validate(plan):
    errors = []
    error = lambda code, id_, message: errors.append({'code': code, 'id': id_, 'message': message})
    if plan.get('schema') != SCHEMA or plan.get('units') != 'm':
        error('invalid_document', plan.get('id'), f'Expected schema {SCHEMA} in metres.')
        return errors
    missing = [key for key in ('levels', 'walls', 'openings', 'rooms', 'objects') if not isinstance(plan.get(key), list)]
    if missing:
        error('invalid_document', plan.get('id'), f'The plan needs {", ".join(missing)} as lists.')
        return errors
    seen = set()
    for kind in ('levels', 'walls', 'openings', 'rooms', 'objects'):
        for item in plan[kind]:
            if item['id'] in seen:
                error('duplicate_id', item['id'], f'The id {item["id"]} is used more than once.')
            seen.add(item['id'])
    levels = {level['id'] for level in plan['levels']}
    walls = {wall['id']: wall for wall in plan['walls']}
    for item in plan['walls'] + plan['rooms'] + plan['objects']:
        if item['levelId'] not in levels:
            error('unknown_reference', item['id'], f'{item["id"]} is on unknown level {item["levelId"]}.')

    good_walls = []
    for wall in plan['walls']:
        if wall_length(wall) <= TOL or wall['thickness'] <= 0 or wall['height'] <= 0:
            error('invalid_dimension', wall['id'], f'Wall {wall["id"]} needs a length, thickness and height above zero.')
        else:
            good_walls.append(wall)
    for i, a in enumerate(good_walls):
        for b in good_walls[:i]:
            # Along each other to within TOL, as the editor's validator tests it: a wall a hair off its neighbour
            # overlaps it for its length; walls meeting, crossing or forming a sharp corner overlap for millimetres.
            if a['levelId'] == b['levelId'] and centreline(a).intersection(centreline(b).buffer(TOL, cap_style='flat')).length > 0.05:
                error('wall_duplicate', a['id'], f'Wall {a["id"]} runs along wall {b["id"]}; a shared wall must appear once.')

    by_wall = {}
    for opening in plan['openings']:
        wall = walls.get(opening['wallId'])
        if wall is None:
            error('unknown_reference', opening['id'], f'Opening {opening["id"]} is in unknown wall {opening["wallId"]}.')
            continue
        if opening['width'] <= 0 or opening['height'] <= 0:
            error('invalid_dimension', opening['id'], f'Opening {opening["id"]} needs a width and height above zero.')
            continue
        if wall not in good_walls:
            continue
        if opening['offset'] < -TOL or opening['offset'] + opening['width'] > wall_length(wall) + TOL or opening['sill'] < -TOL or opening['sill'] + opening['height'] > wall['height'] + TOL:
            error('opening_outside_wall', opening['id'], f'Opening {opening["id"]} does not fit inside wall {wall["id"]} ({wall_length(wall):.3f} m long, {wall["height"]:.3f} m high).')
            continue
        for other in by_wall.get(wall['id'], []):
            if min(opening['offset'] + opening['width'], other['offset'] + other['width']) - max(opening['offset'], other['offset']) > TOL:
                error('opening_overlap', opening['id'], f'Opening {opening["id"]} overlaps opening {other["id"]} in wall {wall["id"]}.')
        by_wall.setdefault(wall['id'], []).append(opening)

    for room in plan['rooms']:
        points = room['polygon']
        polygon = Polygon(points) if len(points) >= 3 else None
        if polygon is None or not polygon.is_valid or polygon.area <= TOL * TOL:
            error('room_invalid_polygon', room['id'], f'Room {room["id"]} needs a closed, non-self-intersecting polygon with area.')
            continue
        lines = [centreline(w) for w in good_walls if w['levelId'] == room['levelId']]
        gap = polygon.exterior.difference(unary_union(lines).buffer(TOL)).length if lines else polygon.exterior.length
        if gap > TOL:
            error('room_open_boundary', room['id'], f'Room {room["id"]} has {gap:.3f} m of boundary without a wall.')
    return errors
