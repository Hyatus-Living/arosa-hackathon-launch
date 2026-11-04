"""A dimensioned plan drawing (SVG) of an architecture plan v1, one panel per level.

Walls are drawn as their solid footprints with door and window openings cut out, rooms by their net
(inside-face) polygon with name, net area and centreline size, windows as glazing lines, doors as jambs,
and overall centreline dimensions along the top and left. Every room, wall and opening group carries data-acres-id so the drawing is addressable
by the same ids as the IFC and Pascal exports. User text is escaped.
"""
from xml.sax.saxutils import escape, quoteattr

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

import architecture as arch

SCALE = 56  # px per metre
MARGIN = 80
INK, PAPER, ROOM, GLASS, LABEL = '#192927', '#f9f8f3', '#e8efe9', '#7fb3bc', '#285b4b'


def render(plan):
    panels, top, width = [], 0.0, 0.0
    for level in plan['levels']:
        svg, w, h = panel(plan, level, top)
        panels.append(svg)
        top += h
        width = max(width, w)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {top:.0f}" role="img" aria-label={quoteattr(plan["name"])}>'
            f'<title>{escape(plan["name"])}</title><rect width="{width:.0f}" height="{top:.0f}" fill="{PAPER}"/>' + ''.join(panels) + '</svg>')


def panel(plan, level, top):
    walls = [w for w in plan['walls'] if w['levelId'] == level['id']]
    ring = [p for region in arch.floor_regions(plan, level['id']) for p in region['polygon']] or [[-1, -1], [1, 1]]
    min_x, max_x = min(p[0] for p in ring), max(p[0] for p in ring)
    min_y, max_y = min(p[1] for p in ring), max(p[1] for p in ring)
    X = lambda x: MARGIN + (x - min_x) * SCALE
    Y = lambda y: top + MARGIN + (max_y - y) * SCALE  # SVG y runs down, plan y (north) runs up
    path = lambda points: 'M' + ' L'.join(f'{X(x):.2f},{Y(y):.2f}' for x, y in points) + ' Z'
    shapes = lambda geometry: ' '.join(path(list(g.exterior.coords)[:-1]) + ''.join(' ' + path(list(i.coords)[:-1]) for i in g.interiors) for g in getattr(geometry, 'geoms', [geometry]))
    out = [f'<g data-acres-id={quoteattr(level["id"])}>',
           f'<text x="{MARGIN}" y="{top + 28:.0f}" font-family="sans-serif" font-size="15" fill="{INK}">{escape(level["name"])} · {level["height"]:.2f} m storey height</text>']

    for room in (r for r in plan['rooms'] if r['levelId'] == level['id']):
        poly = Polygon(room['polygon'])
        cx, cy = poly.representative_point().coords[0]
        bx0, by0, bx1, by1 = poly.bounds
        text = lambda dy, size, fill, value: f'<text x="{X(cx):.1f}" y="{Y(cy) + dy:.1f}" text-anchor="middle" font-family="sans-serif" font-size="{size}" fill="{fill}">{escape(value)}</text>'
        out.append(f'<g data-acres-id={quoteattr(room["id"])}><path d="{path(arch.net_polygon(plan, room))}" fill="{ROOM}"/>'
                   + text(-8, 15, LABEL, room['name']) + text(10, 12, INK, f'{arch.net_area(plan, room) / 0.09290304:,.0f} sq ft')
                   + text(26, 11, '#63716a', f'{bx1 - bx0:.2f} × {by1 - by0:.2f} m') + '</g>')

    for wall in walls:
        openings = [o for o in plan['openings'] if o['wallId'] == wall['id']]
        gaps = [LineString([arch.point_along(wall, o['offset']), arch.point_along(wall, o['offset'] + o['width'])]).buffer(wall['thickness'] / 2 + 0.01, cap_style='flat') for o in openings]
        solid = arch.wall_footprint(plan, wall).difference(unary_union(gaps)) if gaps else arch.wall_footprint(plan, wall)
        out.append(f'<g data-acres-id={quoteattr(wall["id"])}><path d="{shapes(solid)}" fill="{INK}" fill-rule="evenodd"/></g>')
        dx, dy = arch.wall_direction(wall)
        nx, ny = -dy, dx
        half = wall['thickness'] / 2
        for o in openings:
            a, b = arch.point_along(wall, o['offset']), arch.point_along(wall, o['offset'] + o['width'])
            line = lambda p, q, stroke, w: f'<path d="M{X(p[0]):.2f},{Y(p[1]):.2f} L{X(q[0]):.2f},{Y(q[1]):.2f}" stroke="{stroke}" stroke-width="{w}" fill="none"/>'
            shift = lambda p, d: (p[0] + nx * d, p[1] + ny * d)
            if o['kind'] == 'window':
                body = line(shift(a, half), shift(b, half), INK, 1) + line(shift(a, -half), shift(b, -half), INK, 1) + line(a, b, GLASS, 3)
            else:
                body = line(shift(a, half), shift(a, -half), INK, 1) + line(shift(b, half), shift(b, -half), INK, 1)
            out.append(f'<g data-acres-id={quoteattr(o["id"])} data-kind="{o["kind"]}">{body}</g>')

    if walls:
        xs = [p[0] for w in walls for p in (w['start'], w['end'])]
        ys = [p[1] for w in walls for p in (w['start'], w['end'])]
        out.append(dimension(X(min(xs)), Y(max_y) - 34, X(max(xs)), Y(max_y) - 34, f'{max(xs) - min(xs):.2f} m'))
        out.append(dimension(MARGIN - 34, Y(min(ys)), MARGIN - 34, Y(max(ys)), f'{max(ys) - min(ys):.2f} m'))
    else:
        out.append(f'<text x="{MARGIN}" y="{top + MARGIN:.0f}" font-family="sans-serif" font-size="13" fill="{LABEL}">No walls or rooms on this level</text>')
    out.append('</g>')
    return ''.join(out), X(max_x) + MARGIN, (max_y - min_y) * SCALE + 2 * MARGIN


def dimension(x0, y0, x1, y1, label):
    vertical = x0 == x1
    tick = lambda x, y: f'<path d="M{x - 5:.1f},{y + 5:.1f} L{x + 5:.1f},{y - 5:.1f}" stroke="{INK}" stroke-width="1.2"/>'
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    text = (f'<text x="{mx - 8:.1f}" y="{my:.1f}" text-anchor="middle" transform="rotate(-90 {mx - 8:.1f} {my:.1f})"' if vertical else f'<text x="{mx:.1f}" y="{my - 8:.1f}" text-anchor="middle"')
    return (f'<g class="dimension"><path d="M{x0:.1f},{y0:.1f} L{x1:.1f},{y1:.1f}" stroke="{INK}" stroke-width="1"/>{tick(x0, y0)}{tick(x1, y1)}'
            f'{text} font-family="sans-serif" font-size="14" fill="{INK}">{escape(label)}</text></g>')
