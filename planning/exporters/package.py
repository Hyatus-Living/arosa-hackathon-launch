"""The building an architecture plan describes, derived once for the architect's package: its storeys,
units, door swings, door and window marks, schedules and the pre-filing self-check. The IFC model, the
drawing set and the DXF all read it, so every file names the same storeys, units, marks and areas.

A level is one drawn plate; level.storeys lists the storeys it stands for ({id, name, elevation} in metres
above curb), and a level without storeys is one storey of its own. Rooms carry kind, unitId, unitType
and beds where the layout drew them.
"""
import os
import zipfile
from math import ceil

from shapely.geometry import Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

import architecture as arch

FOOT = 0.3048
SQFT = FOOT * FOOT
SURVEY_NOTE = "Lot lines come from the city's tax map, not a survey."
SCOPE_NOTE = 'Pre-filing package, not for filing: a DOB filing needs drawings sealed by a registered architect or engineer.'
ZR_EDITION = 'NYC Zoning Resolution as amended December 5, 2024'
OUT_OF_SCOPE = [
    ('Survey', 'Lot lines, dimensions and area come from the city tax map; a licensed survey sets them.'),
    ('Structure', 'Structural system, foundations and member sizes are not designed.'),
    ('Mechanical, electrical, plumbing and fire protection', 'Systems, risers, shafts and sprinklers are not sized or drawn.'),
    ('Energy code', 'NYC Energy Conservation Code compliance and Local Law 97 emissions limits are not checked.'),
]
# How private a room is: a door swings into the more private room it joins, so off the corridor into a
# unit, a stair or the lobby.
PRIVACY = {'corridor': 0, 'lobby': 0.5, 'hall': 1, 'living': 2}
PUBLIC = {'corridor', 'lobby'}
SHAFTS = {'stair', 'elevator'}
MAX_RISER = 7 / 12 * FOOT  # NYC BC 2022 1011.5.2: risers at most 7 in
TREAD = 11 / 12 * FOOT     # and treads at least 11 in


def feet_inches(metres):
    inches = round(metres / FOOT * 12)
    return f"{inches // 12}'-{inches % 12}\""


def storeys(plan):
    """Every storey of the building, lowest first: {id, name, elevation, height, level, first, number}.
    first marks the storey that keeps the level's own element ids; number is the storey's place above
    grade (1 for the ground floor) or 'C' below it."""
    out = []
    for level in plan['levels']:
        own = level.get('storeys') or [{'id': level['id'], 'name': level['name'], 'elevation': level['elevation']}]
        out += [{'id': s['id'], 'name': s['name'], 'elevation': s['elevation'], 'height': level['height'], 'level': level, 'first': i == 0} for i, s in enumerate(own)]
    out.sort(key=lambda s: s['elevation'])
    ids = [s['id'] for s in out]
    if len(set(ids)) != len(ids):
        raise ValueError('Storey ids must be unique across levels.')
    above = 0
    for s in out:
        if s['elevation'] < -0.01:
            s['number'] = 'C'
        else:
            above += 1
            s['number'] = str(above)
    return out


def rooms_on(plan, level_id):
    return [r for r in plan['rooms'] if r['levelId'] == level_id]


def nets(plan):
    """Each room inside its walls' faces, as architecture.net_polygon draws it, with the level's walls
    unioned once: {room id: {ring, area}} in metres. A building repeats its levels, so callers derive
    this once per plan and pass it on."""
    out = {}
    for level in plan['levels']:
        walls = unary_union([arch.wall_footprint(plan, w) for w in plan['walls'] if w['levelId'] == level['id']])
        for room in rooms_on(plan, level['id']):
            inside = Polygon(room['polygon']).difference(walls)
            if inside.geom_type == 'MultiPolygon':
                inside = max(inside.geoms, key=lambda g: g.area)
            ring = [[round(x, 6), round(y, 6)] for x, y in list(orient(inside.simplify(arch.TOL / 10), 1.0).exterior.coords)[:-1]]
            out[room['id']] = {'ring': ring, 'area': round(Polygon(ring).area, 4)}
    return out


def unit_tag(storey, unit_id):
    """A unit's number as a building's apartments are numbered: the storey and a letter, 3A for unit-1
    on Level 3 (the number itself past 26 units a floor)."""
    key = unit_id.rsplit('-', 1)[-1]
    letter = chr(64 + int(key)) if key.isdigit() and 1 <= int(key) <= 26 else key
    return f"{storey['number']}{letter}"


def units(plan, storey, net):
    """The units on a storey, in plan order: {tag, unitId, unitType, beds, rooms, netSqft, grossSqft}."""
    found = {}
    for room in rooms_on(plan, storey['level']['id']):
        if room.get('unitId'):
            found.setdefault(room['unitId'], []).append(room)
    return [{'tag': unit_tag(storey, unit_id), 'unitId': unit_id, 'unitType': members[0].get('unitType'), 'beds': members[0].get('beds'),
             'rooms': members, 'netSqft': sum(net[r['id']]['area'] for r in members) / SQFT, 'grossSqft': sum(arch.gross_area(r) for r in members) / SQFT}
            for unit_id, members in found.items()]


def sides(plan, opening):
    """The rooms on the left (+1, the wall's left normal) and right (-1) of an opening, None outside."""
    wall = next(w for w in plan['walls'] if w['id'] == opening['wallId'])
    dx, dy = arch.wall_direction(wall)
    mx, my = arch.point_along(wall, opening['offset'] + opening['width'] / 2)
    probe = wall['thickness'] / 2 + 0.15
    rooms = rooms_on(plan, wall['levelId'])
    found = {}
    for sign in (1, -1):
        p = Point(mx - dy * probe * sign, my + dx * probe * sign)
        found[sign] = next((r for r in rooms if Polygon(r['polygon']).contains(p)), None)
    return wall, found


def door_swing(plan, opening):
    """{into: +1 or -1 (the side the leaf swings to), hinge: 'start' or 'end' along the wall, sliding,
    kind}. Doors swing into the more private room (a unit from the corridor, a bedroom from the hall,
    a stair from the corridor, in the direction of egress) and out of the building; elevator doors slide.
    The hinge sits at the end of the opening nearer its wall's end, so the open leaf lies against a wall."""
    wall, found = sides(plan, opening)
    kinds = {sign: (room.get('kind') if room else None) for sign, room in found.items()}
    if 'elevator' in kinds.values():
        return {'into': None, 'hinge': None, 'sliding': True, 'kind': 'Elevator door'}
    if found[1] is None or found[-1] is None:
        into = 1 if found[1] is None else -1
        kind = 'Building entry'
    else:
        rank = {sign: PRIVACY.get(kinds[sign], 3) for sign in (1, -1)}
        into = 1 if rank[1] >= rank[-1] else -1
        joined = {kinds[1], kinds[-1]}
        kind = ('Stair door' if 'stair' in joined else 'Unit entry' if joined & PUBLIC and joined & {'living', 'hall'}
                else 'Corridor door' if joined & PUBLIC else 'Room door')
    length = arch.wall_length(wall)
    hinge = 'start' if opening['offset'] <= length - opening['offset'] - opening['width'] else 'end'
    return {'into': into, 'hinge': hinge, 'sliding': False, 'kind': kind}


def marks(plan):
    """Type marks shared by every file: doors D1, D2 ... by kind and size, windows W1, W2 ... by size
    and sill, numbered in order of first appearance."""
    types, out = {}, {}
    for opening in plan['openings']:
        if opening['kind'] == 'door':
            key = ('door', door_swing(plan, opening)['kind'], round(opening['width'], 3), round(opening['height'], 3))
        else:
            key = ('window', round(opening['width'], 3), round(opening['height'], 3), round(opening['sill'], 3))
        if key not in types:
            prefix = 'D' if key[0] == 'door' else 'W'
            types[key] = f"{prefix}{1 + sum(1 for k in types if k[0] == key[0])}"
        out[opening['id']] = types[key]
    return out


def account_row(account, storey):
    """The zoning account's row for a storey: the one whose floor is at the storey's elevation."""
    feet = storey['elevation'] / FOOT
    return next((row for row in account['storeys'] if abs(row['bottomFeet'] - feet) < 0.5), None) if account else None


def storey_areas(plan, storey, net, account=None):
    """{grossSqft, netSqft, zfaSqft, units}: gross to the outer wall faces, net inside the unit rooms'
    walls, zoning floor area from the zoning account's row for the storey when there is one."""
    level = storey['level']
    gross = sum(Polygon(r['polygon'], r['holes']).area for r in arch.floor_regions(plan, level['id'])) / SQFT
    found = units(plan, storey, net)
    row = account_row(account, storey)
    return {'grossSqft': gross, 'netSqft': sum(u['netSqft'] for u in found), 'zfaSqft': row['zfaSqft'] if row else None, 'units': len(found)}


def schedules(plan, account=None):
    """Area, unit, door and window schedules, one row per storey, unit or opening instance."""
    all_storeys = storeys(plan)
    mark = marks(plan)
    net = nets(plan)
    areas, unit_rows, doors, windows = [], [], [], []
    for s in all_storeys:
        a = storey_areas(plan, s, net, account)
        areas.append({'storey': s['name'], 'use': s['level'].get('use', 'residential'), 'elevationFeet': s['elevation'] / FOOT, **a})
        for u in units(plan, s, net):
            unit_rows.append({'unit': u['tag'], 'storey': s['name'], 'type': u['unitType'], 'beds': u['beds'], 'rooms': len(u['rooms']), 'netSqft': u['netSqft'], 'grossSqft': u['grossSqft']})
        for opening in plan['openings']:
            wall, found = sides(plan, opening)
            if wall['levelId'] != s['level']['id']:
                continue
            names = ' / '.join(r['name'] for r in (found[1], found[-1]) if r) or 'Exterior'
            if opening['kind'] == 'door':
                swing = door_swing(plan, opening)
                doors.append({'mark': mark[opening['id']], 'storey': s['name'], 'between': names, 'kind': swing['kind'],
                              'width': feet_inches(opening['width']), 'height': feet_inches(opening['height']), 'operation': 'Sliding' if swing['sliding'] else 'Swing'})
            else:
                room = found[1] or found[-1]
                floor = net[room['id']]['area'] / SQFT if room else None
                glazed = opening['width'] * opening['height'] / SQFT
                windows.append({'mark': mark[opening['id']], 'storey': s['name'], 'room': room['name'] if room else '',
                                'width': feet_inches(opening['width']), 'height': feet_inches(opening['height']), 'sill': feet_inches(opening['sill']),
                                'glazedSqft': glazed, 'roomSqft': floor, 'share': glazed / floor if floor else None})
    total = {key: sum(a[key] for a in areas if a[key] is not None) for key in ('grossSqft', 'netSqft', 'units')}
    total['zfaSqft'] = sum(a['zfaSqft'] for a in areas if a['zfaSqft'] is not None) if account else None
    return {'areas': areas, 'areaTotals': total, 'units': unit_rows, 'doors': doors, 'windows': windows}


def selfcheck(plan, account=None):
    """The pre-filing self-check: what passes (cited), what needs the architect's judgment, and what is
    outside this package. Layout checks come from the plan's layout report (plan.layout), zoning items
    from the zoning account."""
    passes, architect = [], []
    layout = plan.get('layout')
    if layout:
        if layout.get('edited'):
            architect.append({'text': 'The plan was edited after its layout was checked; the layout checks below are for the drafted plan.', 'cite': None})
        for c in layout['checks']:
            item = {'text': f"{c['text']}: {c['value']}" + (f" ({c['note']})" if c.get('note') else ''), 'cite': c['cite']}
            if not c['pass']:
                architect.append(item)
            elif c['basis'] == 'law':
                passes.append(item)
            else:
                architect.append({**item, 'text': item['text'] + ' (an assumption, not a fixed rule)'})
        architect += [{'text': text, 'cite': None} for text in layout.get('architect', []) if 'not a survey' not in text]  # the survey line leads the list
    else:
        architect.append({'text': 'This plan was drawn or edited by hand, so the building code layout checks did not run on it.', 'cite': None})
    if account:
        far, h, cov, du = account['far'], account['height'], account['lotCoverage'], account['dwellingUnits']
        zoning_items = [
            (far['used'] <= far['allowed'] + 1e-6, f"Floor area ratio {far['used']:g} of {far['allowed']:g} allowed", far['sections'][0]),
            (h['pass'], f"Building height {h['buildingFeet']:g} ft" + (f" of {h['limitFeet']:g} ft" if h.get('limitFeet') else ''), h['sections'][0]),
            (cov['pass'], f"Lot coverage {cov['percent']:g}% of {cov['allowedPercent']:g}% allowed", cov['sections'][0]),
            (du['pass'], f"{du['units']} dwelling units" + (f" of {du['maxUnits']} allowed" if du.get('maxUnits') is not None else ''), du['sections'][0]),
        ] + [(y['pass'], f"{y['yard'].replace('_', ' ').capitalize()}: {y['providedFeet']:g} ft provided, {y['requiredFeet']:g} ft required ({y['storeys']})", y['section']) for y in account['yards']]
        for ok, text, cite in zoning_items:
            (passes if ok else architect).append({'text': text, 'cite': cite})
        if account['overBudget']:
            architect.append({'text': f"Over its zoning floor area budget: {', '.join(account['overBudget'])}", 'cite': 'ZR 23-22'})
        if account.get('outsideOutline'):
            architect.append({'text': f"Drawn floor larger than its zoning outline: {', '.join(account['outsideOutline'])}", 'cite': None})
        gap = account['taxMapAreaSqft'] / account['lotAreaSqft'] - 1
        if abs(gap) > 0.05:
            architect.append({'text': f"The tax map polygon measures {account['taxMapAreaSqft']:,.0f} sq ft against {account['lotAreaSqft']:,.0f} sq ft on record; confirm by survey.", 'cite': None})
        if account['parking'].get('required') is None and not account['parking'].get('manhattanCore'):
            architect.append({'text': 'Required parking depends on the transit zone, which is not resolved for this lot.', 'cite': 'ZR 25-21 to 25-23'})
    else:
        architect.append({'text': 'This plan carries no zoning envelope, so its zoning figures are not checked.', 'cite': None})
    architect.insert(0, {'text': SURVEY_NOTE, 'cite': None})
    return {'schema': 'acres.selfcheck/1', 'planId': plan['id'], 'revision': plan['revision'], 'passes': passes, 'architect': architect,
            'outOfScope': [{'text': f'{name}: {why}', 'cite': None} for name, why in OUT_OF_SCOPE]}


def stair_runs(ring, height):
    """A half-turn stair in a stair room (its net ring): two flights side by side along the room's long side and a
    landing at its far end. {risers, riser, tread, flights: [(origin, run, across, risers, z0)], landing}
    in plan metres; risers at most 7 in and treads 11 in (shortened to fit the room)."""
    rect = Polygon(ring).minimum_rotated_rectangle
    c = list(rect.exterior.coords)[:4]
    e1, e2 = (c[1][0] - c[0][0], c[1][1] - c[0][1]), (c[3][0] - c[0][0], c[3][1] - c[0][1])
    n1, n2 = (e1[0] ** 2 + e1[1] ** 2) ** 0.5, (e2[0] ** 2 + e2[1] ** 2) ** 0.5
    (long, length), (short, width) = sorted(((e1, n1), (e2, n2)), key=lambda e: -e[1])
    r = (long[0] / length, long[1] / length)
    w = (short[0] / width, short[1] / width)
    risers = ceil(height / MAX_RISER - 1e-9)
    first = ceil(risers / 2)
    riser = height / risers
    flight_width = (width - 0.1) / 2
    landing = max(flight_width, 1.0)
    tread = min(TREAD, (length - landing - 0.3) / max(first - 1, 1))
    o = c[0]
    at = lambda along, over: (o[0] + r[0] * along + w[0] * over, o[1] + r[1] * along + w[1] * over)
    end = length - landing
    return {'risers': risers, 'riser': riser, 'tread': tread, 'width': flight_width,
            'flights': [(at(end - (first - 1) * tread, 0.0), r, w, first, 0.0),
                        (at(end, width), (-r[0], -r[1]), (-w[0], -w[1]), risers - first, first * riser)],
            'landing': [at(end, 0.0), at(length, 0.0), at(length, width), at(end, width)], 'landingZ': first * riser}


def write_zip(out_dir, names, zip_name='package.zip'):
    """The named files of a revision as one zip, byte-identical for identical files."""
    with zipfile.ZipFile(os.path.join(out_dir, zip_name), 'w', zipfile.ZIP_DEFLATED) as z:
        for name in sorted(names):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(os.path.join(out_dir, name), 'rb') as handle:
                z.writestr(info, handle.read())
