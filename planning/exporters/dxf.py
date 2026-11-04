"""The plans of one revision as a DXF (AutoCAD 2018, inches, architectural units) for architects who
continue in AutoCAD or Revit: the site plan and every distinct plate, each a block defined at its true
lot coordinates (the lot origin at 0,0, the street along the bottom) and inserted side by side in model
space with its title. Walls, doors, windows, rooms, stairs, elevators and dimensions sit on AIA layers.
Drawn from the same plan document and derivations as the drawing set, so marks, swings and areas agree.

write(doc, out_dir) writes drawings.dxf after ezdxf's audit finds no errors and returns its layer counts.
"""
import os
from math import atan2, degrees

import ezdxf
from shapely.geometry import Polygon

import architecture as arch
from exporters import drawings, package

INCH = 12  # inches per foot; drawings.level_geometry gives feet
LAYERS = {
    'A-WALL': (7, 'Walls, cut'), 'A-WALL-PATT': (8, 'Wall fill'), 'A-DOOR': (3, 'Doors and swings'), 'A-GLAZ': (5, 'Windows'),
    'A-AREA': (9, 'Room boundaries'), 'A-AREA-IDEN': (7, 'Room names and areas'), 'A-FLOR-STRS': (2, 'Stairs'), 'A-FLOR-EVTR': (2, 'Elevators'),
    'A-ANNO-DIMS': (1, 'Dimensions'), 'A-ANNO-TEXT': (7, 'Titles and notes'), 'A-ANNO-IDEN': (6, 'Unit and door marks'),
    'C-PROP-LINE': (3, 'Lot lines from the city tax map'), 'C-BLDG': (8, 'Building footprint'),
}


def setup():
    doc = ezdxf.new('R2018')
    doc.units = ezdxf.units.IN
    doc.header['$LUNITS'] = 4  # architectural
    doc.header['$MEASUREMENT'] = 0
    for name, (color, description) in LAYERS.items():
        doc.layers.add(name, color=color).description = description
    style = doc.dimstyles.new('AROSA')
    style.dxf.dimlunit = 4  # feet and inches
    style.dxf.dimtxt = 6
    style.dxf.dimtsz = 3  # architectural ticks rather than arrows
    style.dxf.dimexe = 3
    style.dxf.dimexo = 3
    style.dxf.dimgap = 2
    style.dxf.dimdec = 0
    style.dxf.dimtad = 1
    return doc


def inches(p):
    return (p[0] * INCH, p[1] * INCH)


def plan_point(p):
    """A plan point in metres to inches."""
    return (p[0] / package.FOOT * INCH, p[1] / package.FOOT * INCH)


def plate_block(doc, plan, level, block):
    """One plate in a block at true coordinates; None for a level with nothing drawn on it."""
    g = drawings.level_geometry(plan, level)
    if g['floor'].is_empty:
        return None
    net = package.nets(plan)
    for piece in g['wallShapes']:
        for ring in [piece.exterior, *piece.interiors]:
            block.add_lwpolyline([inches(p) for p in ring.coords[:-1]], close=True, dxfattribs={'layer': 'A-WALL'})
        hatch = block.add_hatch(color=8, dxfattribs={'layer': 'A-WALL-PATT'})
        hatch.paths.add_polyline_path([inches(p) for p in piece.exterior.coords[:-1]], is_closed=True, flags=1)
        for ring in piece.interiors:
            hatch.paths.add_polyline_path([inches(p) for p in ring.coords[:-1]], is_closed=True, flags=16)
    marks = package.marks(plan)
    for opening in g['openings']:
        wall = next(w for w in plan['walls'] if w['id'] == opening['wallId'])
        dx, dy = arch.wall_direction(wall)
        nx, ny = -dy, dx
        t = wall['thickness'] / 2
        a, b = arch.point_along(wall, opening['offset']), arch.point_along(wall, opening['offset'] + opening['width'])
        if opening['kind'] == 'window':
            for s in (-1, -0.2, 0.2, 1):
                block.add_line(plan_point((a[0] + nx * t * s, a[1] + ny * t * s)), plan_point((b[0] + nx * t * s, b[1] + ny * t * s)), dxfattribs={'layer': 'A-GLAZ'})
            continue
        swing = package.door_swing(plan, opening)
        if swing['sliding']:
            for s in (0.3, -0.3):
                block.add_line(plan_point((a[0] + nx * t * s, a[1] + ny * t * s)), plan_point((b[0] + nx * t * s, b[1] + ny * t * s)), dxfattribs={'layer': 'A-DOOR'})
            continue
        side = swing['into']
        hinge, free = (a, b) if swing['hinge'] == 'start' else (b, a)
        h = (hinge[0] + nx * t * side, hinge[1] + ny * t * side)
        f = (free[0] + nx * t * side, free[1] + ny * t * side)
        leaf = (h[0] + nx * opening['width'] * side, h[1] + ny * opening['width'] * side)
        block.add_line(plan_point(h), plan_point(leaf), dxfattribs={'layer': 'A-DOOR'})
        start, end = degrees(atan2(f[1] - h[1], f[0] - h[0])), degrees(atan2(leaf[1] - h[1], leaf[0] - h[0]))
        if (end - start) % 360 > 180:  # arcs run counterclockwise from start to end
            start, end = end, start
        block.add_arc(plan_point(h), opening['width'] / package.FOOT * INCH, start, end, dxfattribs={'layer': 'A-DOOR'})
        mid = arch.point_along(wall, opening['offset'] + opening['width'] / 2)
        block.add_text(marks[opening['id']], height=4, dxfattribs={'layer': 'A-ANNO-IDEN'}).set_placement(
            plan_point((mid[0] - nx * (t + 0.25) * side, mid[1] - ny * (t + 0.25) * side)), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
    for room in g['rooms']:
        block.add_lwpolyline([plan_point(p) for p in room['polygon']], close=True, dxfattribs={'layer': 'A-AREA'})
        c = Polygon(room['polygon']).representative_point()
        block.add_text(room['name'], height=6, dxfattribs={'layer': 'A-AREA-IDEN'}).set_placement(plan_point((c.x, c.y)), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
        block.add_text(f"{round(net[room['id']]['area'] / package.SQFT):,} SF", height=4.5, dxfattribs={'layer': 'A-AREA-IDEN'}).set_placement(
            plan_point((c.x, c.y - 0.3)), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
        if room.get('kind') == 'stair':
            run = package.stair_runs(net[room['id']]['ring'], level['height'])
            for origin, r, across, risers, _z in run['flights']:
                for k in range(risers):
                    p0 = (origin[0] + r[0] * k * run['tread'], origin[1] + r[1] * k * run['tread'])
                    block.add_line(plan_point(p0), plan_point((p0[0] + across[0] * run['width'], p0[1] + across[1] * run['width'])), dxfattribs={'layer': 'A-FLOR-STRS'})
        if room.get('kind') == 'elevator':
            a, b, c2, d = Polygon(net[room['id']]['ring']).minimum_rotated_rectangle.exterior.coords[:4]
            block.add_line(plan_point(a), plan_point(c2), dxfattribs={'layer': 'A-FLOR-EVTR'})
            block.add_line(plan_point(b), plan_point(d), dxfattribs={'layer': 'A-FLOR-EVTR'})
    storey = next(s for s in package.storeys(plan) if s['level'] is level and s['first'])
    for unit in package.units(plan, storey, net):
        shape = Polygon(unit['rooms'][0]['polygon']).union(Polygon(unit['rooms'][-1]['polygon']))
        c = shape.centroid
        block.add_text(unit['tag'][len(storey['number']):], height=9, dxfattribs={'layer': 'A-ANNO-IDEN'}).set_placement(plan_point((c.x, c.y + 0.5)), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
    minx, miny, maxx, maxy = g['floor'].bounds
    for p1, p2, base, angle in (((minx, miny), (maxx, miny), (minx, miny - 6), 0), ((minx, miny), (minx, maxy), (minx - 6, miny), 90)):
        block.add_linear_dim(base=inches(base), p1=inches(p1), p2=inches(p2), angle=angle, dimstyle='AROSA', dxfattribs={'layer': 'A-ANNO-DIMS'}).render()
    return g['floor'].bounds


def site_block(plan, block):
    site = plan['zoning']
    lot = site['lot']
    for ring in [lot['exterior'], *(lot.get('holes') or [])]:
        block.add_lwpolyline([inches(p) for p in ring], close=True, dxfattribs={'layer': 'C-PROP-LINE'})
    ground = next((s for s in package.storeys(plan) if s['number'] == '1'), package.storeys(plan)[0])
    floor = drawings.level_geometry(plan, ground['level'])['floor']
    for part in getattr(floor, 'geoms', [floor]):
        block.add_lwpolyline([inches(p) for p in part.exterior.coords[:-1]], close=True, dxfattribs={'layer': 'C-BLDG'})
    for b in site.get('context') or []:
        block.add_lwpolyline([inches(p) for p in b['polygon']], close=True, dxfattribs={'layer': 'C-BLDG'})
    coords = lot['exterior'] + lot['exterior'][:1]
    for p, q in zip(coords, coords[1:]):
        block.add_aligned_dim(p1=inches(p), p2=inches(q), distance=-24, dimstyle='AROSA', dxfattribs={'layer': 'A-ANNO-DIMS'}).render()
    return Polygon(lot['exterior']).bounds


def write(plan, out_dir):
    doc = setup()
    msp = doc.modelspace()
    x = 0.0
    parts = []
    if plan.get('zoning'):
        parts.append(('SITE', 'Site plan', lambda block: site_block(plan, block)))
    for level in sorted(plan['levels'], key=lambda l: l['elevation']):
        served = level.get('storeys') or [{'name': level['name']}]
        title = served[0]['name'] if len(served) == 1 else f"{served[0]['name']} to {served[-1]['name']}"
        parts.append((f"PLAN-{level['id']}".upper()[:200], f'Floor plan, {title}', lambda block, level=level: plate_block(doc, plan, level, block)))
    for name, title, draw in parts:
        block = doc.blocks.new(name)
        bounds = draw(block)
        if bounds is None:
            doc.blocks.delete_block(name, safe=False)
            continue
        minx, miny, maxx, maxy = bounds
        offset = x - minx * INCH
        msp.add_blockref(name, (offset, 0), dxfattribs={'layer': '0'})
        msp.add_text(title, height=18, dxfattribs={'layer': 'A-ANNO-TEXT'}).set_placement((x, (maxy + 12) * INCH))
        msp.add_text(package.SURVEY_NOTE, height=8, dxfattribs={'layer': 'A-ANNO-TEXT'}).set_placement((x, (maxy + 8) * INCH))
        x += (maxx - minx + 40) * INCH
    msp.add_text(package.SCOPE_NOTE, height=8, dxfattribs={'layer': 'A-ANNO-TEXT'}).set_placement((0, -40 * INCH))
    auditor = doc.audit()
    if auditor.has_errors:
        raise ValueError(f'The DXF failed its audit: {[str(e.message) for e in auditor.errors][:5]}')
    path = os.path.join(out_dir, 'drawings.dxf')
    doc.saveas(path)
    counts = {}
    for block in doc.blocks:
        for e in block:
            counts[e.dxf.layer] = counts.get(e.dxf.layer, 0) + 1
    return counts
