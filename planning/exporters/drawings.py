"""The drawing set of one plan revision as a multi-page PDF: a cover sheet with the zoning table, the
assumptions and the drawing list; the pre-filing self-check; the zoning diagram; a site plan with the lot
lines, streets and neighbours; a dimensioned plan of every distinct plate; elevations; a section through
the core; and the area, unit, door and window schedules. Every sheet is drawn from the plan document the
IFC model is written from (through package.py), so each wall, door and window drawn is an element of the
model. Sheets are 17 by 11 in at a stated architectural scale with a scale bar; the title block of every
sheet carries the survey caveat and says the package is not for filing.

write(doc, out_dir, account) writes drawings.pdf, schedules.xlsx and selfcheck.json and returns the
sheet list.
"""
import json
import os
import re
from math import atan2, cos, pi, sin

import shapely.affinity
from openpyxl import Workbook
from openpyxl.styles import Font
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

import architecture as arch
from exporters import package

W, H, M = 1224, 792, 36
TITLE_H = 58
INK, MUTED, RULE = (0.1, 0.1, 0.1), (0.42, 0.42, 0.42), (0.78, 0.78, 0.78)
POCHE, GLASS, LOT, LIMIT = (0.25, 0.25, 0.25), (0.35, 0.55, 0.75), (0.15, 0.45, 0.25), (0.72, 0.16, 0.16)
NEIGHBOUR, FOOTPRINT, STREET = (0.88, 0.88, 0.88), (0.8, 0.8, 0.8), (0.95, 0.95, 0.95)
SCALES = [(1 / 4, '1/4" = 1\'-0"'), (3 / 16, '3/16" = 1\'-0"'), (1 / 8, '1/8" = 1\'-0"'), (3 / 32, '3/32" = 1\'-0"'),
          (1 / 16, '1/16" = 1\'-0"'), (1 / 32, '1/32" = 1\'-0"'), (1 / 64, '1/64" = 1\'-0"')]
FT = 1 / package.FOOT  # feet per metre


def feet(n):
    """A length in feet as feet and inches, to the inch."""
    inches = round(n * 12)
    return f"{inches // 12}'-{inches % 12}\""


def sqft(n):
    return f'{round(n):,} sq ft'


class Page:
    """One sheet: paths and text in points, y down, in the zoning sheet's item format."""
    def __init__(self, number, title, items=None):
        self.number, self.title, self.items = number, title, list(items or [])

    def path(self, points, stroke=INK, fill=None, width=0.75, dash=None, closed=True):
        self.items.append(('path', [tuple(p) for p in points], stroke, fill, width, dash, closed))

    def line(self, a, b, **style):
        self.path([a, b], closed=False, **style)

    def text(self, x, y, s, size=8, bold=False, anchor='start', color=INK):
        self.items.append(('text', x, y, str(s), size, bold, anchor, color))

    def svg(self):
        hexc = lambda c: '#%02x%02x%02x' % tuple(round(v * 255) for v in c)
        esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Helvetica, Arial, sans-serif">', f'<rect width="{W}" height="{H}" fill="#ffffff"/>']
        for item in self.items:
            if item[0] == 'path':
                _, pts, stroke, fill, width, dash, closed = item
                d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + (' Z' if closed else '')
                out.append(f'<path d="{d}" fill="{hexc(fill) if fill else "none"}" stroke="{hexc(stroke) if stroke else "none"}" stroke-width="{width}"' + (f' stroke-dasharray="{dash[0]} {dash[1]}"' if dash else '') + '/>')
            else:
                _, x, y, s, size, bold, anchor, color = item
                out.append(f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size}" fill="{hexc(color)}" text-anchor="{anchor}"' + (' font-weight="bold"' if bold else '') + f'>{esc(s)}</text>')
        return '\n'.join(out + ['</svg>']) + '\n'

    def ops(self):
        out = []
        for item in self.items:
            if item[0] == 'path':
                _, pts, stroke, fill, width, dash, closed = item
                out.append(f'{width} w ' + (f'[{dash[0]} {dash[1]}] 0 d' if dash else '[] 0 d'))
                if stroke:
                    out.append('%.3f %.3f %.3f RG' % stroke)
                if fill:
                    out.append('%.3f %.3f %.3f rg' % fill)
                out.append(' '.join(f'{x:.2f} {H - y:.2f} {"m" if i == 0 else "l"}' for i, (x, y) in enumerate(pts)) + (' h' if closed else ''))
                out.append('B' if fill and stroke else 'f' if fill else 'S')
            else:
                _, x, y, s, size, bold, anchor, color = item
                # Helvetica averages about half an em per character; close enough to centre or right-align a label.
                width = len(s) * size * 0.5
                x0 = x - width / 2 if anchor == 'middle' else x - width if anchor == 'end' else x
                text = s.encode('latin-1', 'replace').decode('latin-1').replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
                out.append('%.3f %.3f %.3f rg BT /%s %s Tf %.2f %.2f Td (%s) Tj ET' % (*color, 'F2' if bold else 'F1', size, x0, H - y, text))
        return '\n'.join(out).encode('latin-1', 'replace')


def pdf(pages):
    """A PDF of the pages in order, one 17 by 11 in page each, Helvetica throughout."""
    n = len(pages)
    fonts = 3 + 2 * n
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               ('<< /Type /Pages /Kids [%s] /Count %d >>' % (' '.join(f'{3 + 2 * i} 0 R' for i in range(n)), n)).encode()]
    for i, page in enumerate(pages):
        stream = page.ops()
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Contents {4 + 2 * i} 0 R /Resources << /Font << /F1 {fonts} 0 R /F2 {fonts + 1} 0 R >> >> >>'.encode())
        objects.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
    objects += [b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
                b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']
    out, offsets = bytearray(b'%PDF-1.4\n'), []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offsets)
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref)
    return bytes(out)


# ---------------------------------------------------------------------------------------------
# Sheet furniture


def title_block(page, info, scale=None):
    y = H - TITLE_H
    page.line((M, y), (W - M, y), stroke=INK, width=0.75)
    page.text(M, y + 15, info['project'], 9, bold=True)
    page.text(M, y + 27, info['subtitle'], 7.5, color=MUTED)
    page.text(M, y + 41, package.SURVEY_NOTE, 7.5, bold=True)
    page.text(M, y + 51, package.SCOPE_NOTE, 6.5, color=MUTED)
    page.text(W - M - 150, y + 15, page.title, 9, bold=True, anchor='end')
    if scale:
        page.text(W - M - 150, y + 27, f'Scale {scale} at 17 by 11 in', 7.5, color=MUTED, anchor='end')
    page.text(W - M - 150, y + 41, f"Plan revision {info['revision']}", 7.5, color=MUTED, anchor='end')
    page.line((W - M - 136, y + 4), (W - M - 136, H - 6), stroke=RULE, width=0.5)
    page.text(W - M, y + 30, page.number, 20, bold=True, anchor='end')
    page.text(W - M, y + 46, f"Sheet {info['index']} of {info['count']}", 7, color=MUTED, anchor='end')


def scale_for(width_ft, depth_ft, box_w, box_h):
    """The largest listed scale at which a drawing of this size fits the box: (points per foot, label)."""
    for inches, label in SCALES:
        k = inches * 72
        if width_ft * k <= box_w and depth_ft * k <= box_h:
            return k, label
    inches, label = SCALES[-1]
    return inches * 72, label


def scale_bar(page, x, y, k):
    """A scale bar of 0 to 40 ft (or 0 to 100 ft at small scales) starting at (x, y)."""
    step = 10 if k * 10 >= 24 else 25
    for i in range(4):
        page.path([(x + i * step * k, y), (x + (i + 1) * step * k, y), (x + (i + 1) * step * k, y + 4), (x + i * step * k, y + 4)],
                  fill=INK if i % 2 == 0 else None, width=0.5)
        page.text(x + i * step * k, y + 13, f'{i * step}', 6, anchor='middle')
    page.text(x + 4 * step * k, y + 13, f"{4 * step} ft", 6, anchor='middle')


def north_arrow(page, x, y, north):
    """An arrow pointing to north, given as a unit vector in the plan frame (x right, y up the sheet)."""
    if not north:
        return
    nx, ny = north
    tip = (x + nx * 16, y - ny * 16)
    tail = (x - nx * 10, y + ny * 10)
    side = (-ny * 6, -nx * 6)
    page.path([tip, (tail[0] + side[0], tail[1] + side[1]), (x, y), (tail[0] - side[0], tail[1] - side[1])], fill=INK, width=0.5)
    page.text(tip[0] + nx * 8, tip[1] - ny * 8 + 3, 'N', 8, bold=True, anchor='middle')


def north_of(site):
    """North as a unit vector in the plan frame, from the zoning export's lot.north when it carries one."""
    north = ((site or {}).get('lot') or {}).get('north')
    if north is None:
        return None
    if isinstance(north, (list, tuple)):
        length = (north[0] ** 2 + north[1] ** 2) ** 0.5
        return (north[0] / length, north[1] / length)
    angle = north * pi / 180  # degrees clockwise from the frame's +y (into the lot)
    return (sin(angle), cos(angle))


class Frame:
    """Plan feet to sheet points: x right, plan y up the sheet, k points per foot."""
    def __init__(self, k, left, top):
        self.k, self.left, self.top = k, left, top

    def __call__(self, p):
        return (self.left + p[0] * self.k, self.top - p[1] * self.k)


def frame_for(bounds, area, margin=60):
    """A frame that centres plan bounds (feet) in a sheet area (x, y, w, h) less a margin for dimensions."""
    minx, miny, maxx, maxy = bounds
    x, y, w, h = area
    k, label = scale_for(maxx - minx, maxy - miny, w - 2 * margin, h - 2 * margin)
    cx, cy = x + w / 2, y + h / 2
    left = cx - (maxx - minx) * k / 2 - minx * k
    top = cy + (maxy - miny) * k / 2 + miny * k
    return Frame(k, left, top), label


def ring_points(frame, coords):
    return [frame(p) for p in coords]


def fill_shape(page, frame, geom, **style):
    for part in getattr(geom, 'geoms', [geom]):
        if part.is_empty or part.geom_type != 'Polygon':
            continue
        page.path(ring_points(frame, part.exterior.coords[:-1]), **style)
        for hole in part.interiors:
            page.path(ring_points(frame, hole.coords[:-1]), stroke=style.get('stroke'), fill=(1, 1, 1), width=style.get('width', 0.75))


def dimension(page, a, b, offset, label, size=6.5):
    """A dimension between sheet points a and b, its line offset perpendicular by offset points, with
    extension lines, slash ticks and the label centred above the line."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = (dx * dx + dy * dy) ** 0.5
    if length < 1:
        return
    ux, uy = dx / length, dy / length
    nx, ny = -uy * offset, ux * offset
    pa, pb = (a[0] + nx, a[1] + ny), (b[0] + nx, b[1] + ny)
    for p, q in ((a, pa), (b, pb)):
        page.line((p[0] + nx * 0.15, p[1] + ny * 0.15), (q[0] + nx * 0.1, q[1] + ny * 0.1), stroke=MUTED, width=0.3)
    page.line(pa, pb, stroke=INK, width=0.4)
    tick = (1.8 * (ux - uy), 1.8 * (uy + ux))  # an architectural slash at 45 degrees
    for p in (pa, pb):
        page.line((p[0] - tick[0], p[1] - tick[1]), (p[0] + tick[0], p[1] + tick[1]), stroke=INK, width=0.6)
    if length < len(label) * size * 0.5 + 4:
        return
    mid = ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)
    if abs(ux) >= abs(uy):
        page.text(mid[0], mid[1] - 2.5, label, size, anchor='middle')
    else:
        page.text(mid[0] - 3, mid[1] + size / 3, label, size, anchor='end')


def table(page, rows, x, y, widths, size=7, row_height=11.0, numeric=(), header=True):
    """Rows of text from (x, y) in columns of the given widths; the first row bold when header."""
    for i, row in enumerate(rows):
        cx = x
        for j, (cell, w) in enumerate(zip(row, widths)):
            if j in numeric:
                page.text(cx + w - 4, y + i * row_height, cell, size, bold=header and i == 0, anchor='end')
            else:
                page.text(cx, y + i * row_height, cell, size, bold=header and i == 0)
            cx += w
        if header and i == 0:
            page.line((x, y + 3), (x + sum(widths), y + 3), stroke=RULE, width=0.5)
    return y + len(rows) * row_height


def wrap(text, chars):
    words, lines, line = text.split(), [], ''
    for word in words:
        if line and len(line) + 1 + len(word) > chars:
            lines.append(line)
            line = word
        else:
            line = f'{line} {word}' if line else word
    return lines + ([line] if line else [])


def bullets(page, items, x, y, chars, size=7, leading=9.5, bottom=H - TITLE_H - 10):
    """Wrapped bullet items from (x, y); returns the next y, stopping above the title block."""
    for item in items:
        lines = wrap(item, chars)
        if y + leading * len(lines) > bottom:
            page.text(x, y, '(continued in selfcheck.json)', size, color=MUTED)
            return bottom
        for i, line in enumerate(lines):
            page.text(x + (0 if i == 0 else 8), y, ('- ' if i == 0 else '') + line, size)
            y += leading
    return y


# ---------------------------------------------------------------------------------------------
# The building in feet


def level_geometry(doc, level):
    """Rooms, walls less their openings, the floor outline and openings of a level, in feet."""
    to_ft = lambda pts: [(x * FT, y * FT) for x, y in pts]
    walls = [w for w in doc['walls'] if w['levelId'] == level['id']]
    openings = [o for o in doc['openings'] if any(w['id'] == o['wallId'] for w in walls)]
    cut = []
    for w in walls:
        shape = arch.wall_footprint(doc, w)
        for o in (o for o in openings if o['wallId'] == w['id']):
            a, b = arch.point_along(w, o['offset']), arch.point_along(w, o['offset'] + o['width'])
            shape = shape.difference(LineString([a, b]).buffer(w['thickness'] / 2 + 0.02, cap_style='flat'))
        cut.append(shape)
    regions = arch.floor_regions(doc, level['id'])
    floor = unary_union([Polygon(to_ft(r['polygon']), [to_ft(h) for h in r['holes']]) for r in regions])
    scale = lambda g: Polygon(to_ft(g.exterior.coords), [to_ft(h.coords) for h in g.interiors])
    pieces = [scale(p) for g in cut for p in getattr(g, 'geoms', [g]) if p.geom_type == 'Polygon' and not p.is_empty]
    return {'walls': walls, 'openings': openings, 'wallShapes': pieces, 'floor': floor,
            'rooms': [r for r in doc['rooms'] if r['levelId'] == level['id']]}


def door_symbol(page, frame, doc, opening):
    """The leaf open at 90 degrees and its swing arc, or two leaves parted for a sliding door."""
    wall = next(w for w in doc['walls'] if w['id'] == opening['wallId'])
    swing = package.door_swing(doc, opening)
    dx, dy = arch.wall_direction(wall)
    nx, ny = -dy, dx
    t = wall['thickness'] / 2
    a, b = arch.point_along(wall, opening['offset']), arch.point_along(wall, opening['offset'] + opening['width'])
    to = lambda p: frame((p[0] * FT, p[1] * FT))
    if swing['sliding']:
        for s in (1, -1):
            page.line(to((a[0] + nx * t * 0.3 * s, a[1] + ny * t * 0.3 * s)), to((b[0] + nx * t * 0.3 * s, b[1] + ny * t * 0.3 * s)), width=0.5)
        return
    side = swing['into']
    hinge, free = (a, b) if swing['hinge'] == 'start' else (b, a)
    face = lambda p: (p[0] + nx * t * side, p[1] + ny * t * side)
    h = face(hinge)
    width = opening['width']
    leaf = (h[0] + nx * width * side, h[1] + ny * width * side)
    page.line(to(h), to(leaf), width=0.6)
    start = atan2(face(free)[1] - h[1], face(free)[0] - h[0])
    end = atan2(leaf[1] - h[1], leaf[0] - h[0])
    sweep = (end - start + pi) % (2 * pi) - pi
    arc = [to((h[0] + width * cos(start + sweep * i / 12), h[1] + width * sin(start + sweep * i / 12))) for i in range(13)]
    page.path(arc, closed=False, width=0.3, stroke=MUTED)


def window_symbol(page, frame, doc, opening):
    wall = next(w for w in doc['walls'] if w['id'] == opening['wallId'])
    dx, dy = arch.wall_direction(wall)
    nx, ny = -dy, dx
    t = wall['thickness'] / 2
    a, b = arch.point_along(wall, opening['offset']), arch.point_along(wall, opening['offset'] + opening['width'])
    to = lambda p: frame((p[0] * FT, p[1] * FT))
    for s in (-1, -0.2, 0.2, 1):
        page.line(to((a[0] + nx * t * s, a[1] + ny * t * s)), to((b[0] + nx * t * s, b[1] + ny * t * s)), stroke=GLASS if abs(s) < 1 else INK, width=0.4)


def stair_symbol(page, frame, ring, height, up):
    run = package.stair_runs(ring, height)
    to = lambda p: frame((p[0] * FT, p[1] * FT))
    for origin, r, across, risers, _z in run['flights']:
        for k in range(risers):
            u = k * run['tread']
            p0 = (origin[0] + r[0] * u, origin[1] + r[1] * u)
            p1 = (p0[0] + across[0] * run['width'], p0[1] + across[1] * run['width'])
            page.line(to(p0), to(p1), width=0.3)
    if up:
        origin, r, across, risers, _z = run['flights'][0]
        mid = (origin[0] + across[0] * run['width'] / 2, origin[1] + across[1] * run['width'] / 2)
        end = (mid[0] + r[0] * (risers - 1) * run['tread'], mid[1] + r[1] * (risers - 1) * run['tread'])
        page.line(to(mid), to(end), width=0.5)
        page.text(*to(mid), 'UP', 5.5, bold=True, anchor='middle')


# ---------------------------------------------------------------------------------------------
# Sheets


def cover(info, doc, account, sheets, sched, check):
    page = Page('G-001', 'Cover sheet')
    site = doc.get('zoning') or {}
    page.text(M, M + 6, 'Pre-filing package', 20, bold=True)
    page.text(M, M + 26, info['project'], 11)
    page.text(M, M + 40, info['subtitle'], 8.5, color=MUTED)
    y = M + 70
    page.text(M, y, 'Zoning summary', 10, bold=True)
    rows = [['Item', 'Allowed', 'This option', 'Section']]
    if account:
        far, h, cov, du = account['far'], account['height'], account['lotCoverage'], account['dwellingUnits']
        rows += [
            ['Zoning district', site.get('district', ''), '', ''],
            ['Lot area', sqft(account['lotAreaSqft']) + ' on record', sqft(account['taxMapAreaSqft']) + ' tax map', ''],
            ['Floor area ratio', f"{far['allowed']:g}", f"{far['used']:g}", far['sections'][0]],
            ['Zoning floor area', sqft(far['allowedSqft']), sqft(account['totals']['zfaSqft']), far['sections'][0]],
            ['Building height', feet(h['limitFeet']) if h.get('limitFeet') else 'none', feet(h['buildingFeet']), h['sections'][0]],
            ['Base height', (f"{feet(h['minBaseFeet'])} to {feet(h['maxBaseFeet'])}" if h.get('minBaseFeet') else f"up to {feet(h['maxBaseFeet'])}") if h.get('maxBaseFeet') else '', feet(h['baseFeet']) if h.get('baseFeet') else '', h['sections'][1] if len(h['sections']) > 1 else ''],
            ['Lot coverage', f"{cov['allowedPercent']:g}%", f"{cov['percent']:g}%", cov['sections'][0]],
            ['Dwelling units', str(du['maxUnits']) if du.get('maxUnits') is not None else 'no cap', str(du['units']), du['sections'][0]],
        ] + [[y_['yard'].replace('_', ' ').capitalize(), feet(y_['requiredFeet']), feet(y_['providedFeet']), y_['section']] for y_ in account['yards']]
        parking = account['parking']
        rows.append(['Parking', 'by transit zone' if parking.get('required') is None else str(parking['required']), str(parking.get('provided', 0)), parking['sections'][0]])
    else:
        rows.append(['No zoning envelope', 'drawn by hand', '', ''])
    y = table(page, rows, M, y + 16, [110, 120, 120, 90], numeric=())
    y += 14
    page.text(M, y, 'Building', 10, bold=True)
    t = sched['areaTotals']
    types = {}
    for u in sched['units']:
        types[u['type'] or 'unit'] = types.get(u['type'] or 'unit', 0) + 1
    summary = [f"{len(sched['areas'])} storeys from {sched['areas'][0]['storey']} to {sched['areas'][-1]['storey']}",
               f"Gross floor area {sqft(t['grossSqft'])}; net in units {sqft(t['netSqft'])}" + (f"; zoning floor area {sqft(t['zfaSqft'])}" if t['zfaSqft'] else ''),
               f"{t['units']} dwelling units: " + ', '.join(f'{n} {k}' for k, n in types.items()) if t['units'] else 'No dwelling units drawn']
    y = bullets(page, summary, M, y + 14, 90)
    y += 8
    page.text(M, y, 'Assumptions', 10, bold=True)
    assumed = ['Floor-to-floor heights, slab thicknesses and wall thicknesses are planning values, not structural design.',
               'Walls are drawn to their centrelines at 12 in exterior, 8 in between units and 5 in inside units unless the plan sets them.',
               'Stairs are drawn with 7 in risers and 11 in treads (NYC BC 2022 1011.5.2); doors swing into the room they serve.']
    assumed += [c['text'] for c in check['architect'] if 'assumption' in c['text']]
    assumed += [f"{e['kind'].capitalize()} floor area excluded at the deal model's share ({e['section']})" for s in (account['storeys'] if account else [])[:1] for e in s.get('exclusions', []) if e.get('basis') == 'assumed']
    bullets(page, assumed, M, y + 14, 90)
    x2 = M + 560
    page.text(x2, M + 70, 'Drawings', 10, bold=True)
    table(page, [['Sheet', 'Title']] + [[p.number, p.title] for p in sheets], x2, M + 86, [60, 360])
    page.text(x2, H - TITLE_H - 60, 'Files with this package', 9, bold=True)
    page.text(x2, H - TITLE_H - 46, 'model.ifc (IFC4 building model), drawings.dxf (CAD), schedules.xlsx, selfcheck.json, zd1.pdf (zoning analysis).', 7, color=MUTED)
    return page


def selfcheck_sheet(check):
    page = Page('G-002', 'Pre-filing self-check')
    page.text(M, M + 6, 'Pre-filing self-check', 16, bold=True)
    page.text(M, M + 22, 'Each item is checked against the cited rule. A registered architect reviews every item before filing.', 8, color=MUTED)
    columns = [('Passes', check['passes']), ('Needs the architect', check['architect']), ('Outside this package', check['outOfScope'])]
    width = (W - 2 * M - 40) / 3
    for i, (title, items) in enumerate(columns):
        x = M + i * (width + 20)
        page.text(x, M + 50, f'{title} ({len(items)})', 10, bold=True, color=LIMIT if title == 'Needs the architect' else INK)
        bullets(page, [it['text'] + (f" ({it['cite']})" if it.get('cite') else '') for it in items], x, M + 66, int(width / 3.6), size=6.5, leading=8.5)
    return page


def site_plan(doc, info):
    page = Page('A-001', 'Site plan')
    site = doc['zoning']
    lot = Polygon(site['lot']['exterior'], site['lot'].get('holes') or [])
    first = package.storeys(doc)
    ground = next((s for s in first if s['number'] == '1'), first[0])
    footprint = level_geometry(doc, ground['level'])['floor']
    typical = unary_union([level_geometry(doc, l)['floor'] for l in doc['levels']])
    context = site.get('context') or []
    minx, miny, maxx, maxy = lot.bounds
    pad = 40
    area = (M, M + 20, W - 2 * M - 220, H - TITLE_H - M - 30)
    frame, label = frame_for((minx - pad, miny - pad, maxx + pad, maxy + pad), area, margin=20)
    # Streets on the sides the export names, out to their width.
    sides = {'front': (0, -1), 'rear': (0, 1), 'left': (-1, 0), 'right': (1, 0)}
    for street in site.get('streets') or []:
        nx, ny = sides[street['side']]
        w = min(street.get('widthFeet') or 60, pad * 2)
        band = box(minx - pad, miny - w, maxx + pad, miny) if (nx, ny) == (0, -1) else box(minx - pad, maxy, maxx + pad, maxy + w) if (nx, ny) == (0, 1) else \
            box(minx - w, miny - pad, minx, maxy + pad) if (nx, ny) == (-1, 0) else box(maxx, miny - pad, maxx + w, maxy + pad)
        fill_shape(page, frame, band, stroke=None, fill=STREET)
        c = band.centroid
        name = street.get('name') or 'Street'
        page.text(*frame((c.x, c.y)), f"{name}, {street['widthFeet']:g} ft {'wide' if street.get('wide') else 'narrow'} street" if street.get('widthFeet') else name, 7, color=MUTED, anchor='middle')
    for b in context:
        poly = Polygon(b['polygon'])
        if not poly.is_valid or poly.distance(lot) > pad:
            continue
        fill_shape(page, frame, poly, stroke=MUTED, fill=NEIGHBOUR, width=0.4)
        c = poly.representative_point()
        page.text(*frame((c.x, c.y)), f"{b['height']:.0f} ft", 5.5, color=MUTED, anchor='middle')
    fill_shape(page, frame, typical, stroke=MUTED, fill=None, width=0.5)
    fill_shape(page, frame, footprint, stroke=INK, fill=FOOTPRINT, width=0.8)
    page.path(ring_points(frame, list(lot.exterior.coords)[:-1]), stroke=LOT, width=1.4, dash=(8, 3))
    coords = list(lot.exterior.coords)
    centre = lot.centroid
    for p, q in zip(coords, coords[1:]):
        length = LineString([p, q]).length
        if length < 3:
            continue
        a, b = frame(p), frame(q)
        mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        outward = 1 if (mid[0] - centre.x) * -(q[1] - p[1]) + (mid[1] - centre.y) * (q[0] - p[0]) < 0 else -1
        dimension(page, a, b, 14 * outward, feet(length))
    # The front and rear yards at the middle of the building's width, from lot line to building.
    if not footprint.is_empty:
        mx = (footprint.bounds[0] + footprint.bounds[2]) / 2
        probe = LineString([(mx, miny - 1), (mx, maxy + 1)])
        on_lot, on_building = probe.intersection(lot).bounds, probe.intersection(footprint).bounds
        for y0, y1 in ((on_lot[1], on_building[1]), (on_building[3], on_lot[3])):
            if y1 - y0 > 0.5:
                dimension(page, frame((mx, y0)), frame((mx, y1)), 0, feet(y1 - y0))
    x = W - M - 200
    page.text(x, M + 30, 'Site plan', 10, bold=True)
    legend = [('Lot line from the city tax map', LOT), ('Building at grade', INK), ('Upper storeys', MUTED), ('Neighbouring buildings, height above curb', MUTED)]
    for i, (text, colour) in enumerate(legend):
        page.line((x, M + 50 + i * 14), (x + 18, M + 50 + i * 14), stroke=colour, width=1.2)
        page.text(x + 24, M + 53 + i * 14, text, 6.5)
    facts = [f"Lot area {sqft(site['lot']['areaSqft'])} by the tax map", f"Zoning district {site['district']}"]
    if site['lot'].get('bbl'):
        facts.insert(0, f"BBL {site['lot']['bbl']}")
    if not context:
        facts.append('Neighbouring buildings were not loaded for this lot.')
    bullets(page, facts, x, M + 120, 46)
    north_arrow(page, W - M - 40, M + 40, north_of(site))
    scale_bar(page, M, H - TITLE_H - 22, frame.k)
    return page, label


def plan_sheet(doc, level, number, info, north, net):
    title = level['name'] if not level.get('storeys') or len(level['storeys']) == 1 else f"{level['storeys'][0]['name']} to {level['storeys'][-1]['name']}"
    page = Page(number, f'Floor plan, {title}')
    g = level_geometry(doc, level)
    if g['floor'].is_empty:
        page.text(M, M + 30, page.title, 10, bold=True)
        page.text(M, M + 50, 'No walls or rooms are drawn on this level yet.', 9, color=MUTED)
        return page, None
    minx, miny, maxx, maxy = g['floor'].bounds
    area = (M, M + 26, W - 2 * M - 200, H - TITLE_H - M - 40)
    frame, label = frame_for((minx, miny, maxx, maxy), area, margin=50)
    for room in g['rooms']:
        if room.get('kind') in ('corridor', 'lobby', 'stair', 'elevator'):
            page.path(ring_points(frame, [(x * FT, y * FT) for x, y in room['polygon']]), stroke=None, fill=(0.96, 0.96, 0.96))
    for piece in g['wallShapes']:
        fill_shape(page, frame, piece, stroke=None, fill=POCHE)
    for o in g['openings']:
        (door_symbol if o['kind'] == 'door' else window_symbol)(page, frame, doc, o)
    all_storeys = package.storeys(doc)
    mine = [s for s in all_storeys if s['level'] is level]
    up = mine and mine[-1]['id'] != all_storeys[-1]['id']
    for room in g['rooms']:
        if room.get('kind') == 'stair':
            stair_symbol(page, frame, net[room['id']]['ring'], level['height'], up)
        if room.get('kind') == 'elevator':
            poly = Polygon([(x * FT, y * FT) for x, y in net[room['id']]['ring']])
            a, b, c, d = poly.minimum_rotated_rectangle.exterior.coords[:4]
            page.line(frame(a), frame(c), stroke=MUTED, width=0.4)
            page.line(frame(b), frame(d), stroke=MUTED, width=0.4)
    for room in g['rooms']:
        poly = Polygon([(x * FT, y * FT) for x, y in room['polygon']])
        p = frame((poly.representative_point().x, poly.representative_point().y))
        span = (poly.bounds[2] - poly.bounds[0]) * frame.k
        size = 5.5 if span > 40 else 4.5
        # Inside a unit the unit's tag names it, so its rooms read "Bedroom 1" rather than "Unit 3 bedroom 1".
        name = re.sub(r'^Unit \S+\s+', '', room['name']) if room.get('unitId') else room['name']
        name = name[:1].upper() + name[1:]
        if room.get('kind') in ('stair', 'elevator') or span > len(name) * size * 0.5:
            page.text(p[0], p[1], name, size, anchor='middle')
            page.text(p[0], p[1] + size + 1, sqft(net[room['id']]['area'] / package.SQFT), size - 0.5, color=MUTED, anchor='middle')
    storey = mine[0] if mine else None
    if storey:
        for unit in package.units(doc, storey, net):
            shape = unary_union([Polygon([(x * FT, y * FT) for x, y in r['polygon']]) for r in unit['rooms']])
            c = frame((shape.centroid.x, shape.centroid.y))
            tag = unit['tag'][len(storey['number']):] if len(mine) > 1 else unit['tag']
            page.path([(c[0] - 11, c[1] - 16), (c[0] + 11, c[1] - 16), (c[0] + 11, c[1] - 6), (c[0] - 11, c[1] - 6)], stroke=INK, fill=(1, 1, 1), width=0.5)
            page.text(c[0], c[1] - 8.5, tag, 6, bold=True, anchor='middle')
    # Overall dimensions and the chain of walls along the street face and the left side, measured in the
    # plate's own direction (its longest exterior wall), since a tax-lot plate can sit a fraction of a
    # degree off the sheet's axes.
    exterior = [w for w in g['walls'] if arch.is_exterior(doc, w)] or g['walls']
    longest = max(exterior, key=arch.wall_length)
    turn = atan2(longest['end'][1] - longest['start'][1], longest['end'][0] - longest['start'][0])
    turn = (turn + pi / 4) % (pi / 2) - pi / 4
    c, s_ = cos(turn), sin(turn)
    local = lambda p: (p[0] * c + p[1] * s_, -p[0] * s_ + p[1] * c)  # sheet frame to the plate's frame
    back = lambda p: frame((p[0] * c - p[1] * s_, p[0] * s_ + p[1] * c))
    lx0, ly0, lx1, ly1 = shapely.affinity.rotate(g['floor'], -turn, origin=(0, 0), use_radians=True).bounds
    dimension(page, back((lx0, ly0)), back((lx1, ly0)), 46, feet(lx1 - lx0), size=7)
    dimension(page, back((lx0, ly0)), back((lx0, ly1)), -46, feet(ly1 - ly0), size=7)
    ends = [(local((w['start'][0] * FT, w['start'][1] * FT)), local((w['end'][0] * FT, w['end'][1] * FT))) for w in g['walls']]
    xs = sorted({round(min(p[0], q[0]), 2) for p, q in ends if abs(p[0] - q[0]) < 0.05 and min(p[1], q[1]) <= ly0 + 1.5})
    ys = sorted({round(min(p[1], q[1]), 2) for p, q in ends if abs(p[1] - q[1]) < 0.05 and min(p[0], q[0]) <= lx0 + 1.5})
    for values, axis in ((xs, 'x'), (ys, 'y')):
        chain = [values[0]] if values else []
        for v in values[1:]:
            if v - chain[-1] > 1.0:
                chain.append(v)
        for a, b in zip(chain, chain[1:]):
            if axis == 'x':
                dimension(page, back((a, ly0)), back((b, ly0)), 24, feet(b - a))
            else:
                dimension(page, back((lx0, a)), back((lx0, b)), -24, feet(b - a))
    x = W - M - 180
    page.text(x, M + 30, page.title, 10, bold=True)
    served = [s['name'] for s in mine]
    facts = [f"Storeys: {', '.join(served)}" if len(served) <= 4 else f"Storeys: {served[0]} to {served[-1]} ({len(served)} storeys)",
             f"Floor to floor {feet(level['height'] * FT)}", f"Gross {sqft(g['floor'].area)}"]
    if storey:
        found = package.units(doc, storey, net)
        facts.append(f"{len(found)} units a storey" + (f", numbered by storey ({mine[1]['name']}: {package.unit_tag(mine[1], found[0]['unitId'])})" if len(mine) > 1 and found else ''))
    bullets(page, facts, x, M + 50, 40)
    north_arrow(page, W - M - 40, M + 140, north)
    scale_bar(page, M, H - TITLE_H - 22, frame.k)
    return page, label


def elevation_sheet(doc, account, number, directions, info):
    """Exterior elevations, each looking at the building from one side (an outward direction in the
    plan): the storeys with their floor elevations, the windows and doors in the exterior walls seen
    from that side, and the height limits."""
    page = Page(number, 'Elevations, ' + ' and '.join(name.lower() for name, _ in directions))
    all_storeys = package.storeys(doc)
    geoms = {l['id']: level_geometry(doc, l) for l in doc['levels']}
    exterior = {w['id'] for w in doc['walls'] if arch.is_exterior(doc, w)}
    points = [p for g in geoms.values() for part in getattr(g['floor'], 'geoms', [g['floor']]) if not part.is_empty for p in part.exterior.coords]
    if not points:
        page.text(M, M + 30, 'No walls or rooms are drawn yet.', 9, color=MUTED)
        return page, None
    bottom = all_storeys[0]['elevation'] * FT
    top = (all_storeys[-1]['elevation'] + all_storeys[-1]['height']) * FT
    limit = account['height'].get('limitFeet') if account else None
    spans = []
    for _name, n in directions:
        right = (-n[1], n[0])
        us = [p[0] * right[0] + p[1] * right[1] for p in points]
        spans.append((min(us), max(us)))
    box_w = (W - 2 * M - 40) / len(directions)
    k, label = scale_for(max(hi - lo for lo, hi in spans), max(top, limit or 0) + 6 - bottom, box_w - 90, H - TITLE_H - M - 90)
    for i, (name, n) in enumerate(directions):
        right = (-n[1], n[0])
        lo, hi = spans[i]
        span = hi - lo
        x0 = M + 60 + i * (box_w + 40)
        base = H - TITLE_H - 50
        to = lambda u, z: (x0 + u * k, base - (z - bottom) * k)
        u_of = lambda p: p[0] * right[0] + p[1] * right[1] - lo
        page.text(x0, M + 24, f'{name} elevation', 10, bold=True)
        page.line(to(-6, 0), to(span + 6, 0), width=1.0)
        for s in all_storeys:
            g = geoms[s['level']['id']]
            if g['floor'].is_empty:
                continue
            us = [u_of(p) for part in getattr(g['floor'], 'geoms', [g['floor']]) for p in part.exterior.coords]
            z0, z1 = s['elevation'] * FT, (s['elevation'] + s['height']) * FT
            page.path([to(min(us), z0), to(max(us), z0), to(max(us), z1), to(min(us), z1)], stroke=INK, fill=(0.97, 0.97, 0.97) if z0 >= 0 else (0.9, 0.9, 0.9), width=0.6)
            page.text(*to(-8, z0 + 1), f"{s['name']}  {z0:.1f} ft", 5.5, anchor='end')
            for w in g['walls']:
                if w['id'] not in exterior:
                    continue
                dx, dy = arch.wall_direction(w)
                out = (dy, -dx)
                mid = arch.point_along(w, arch.wall_length(w) / 2)
                reach = w['thickness'] / 2 + 0.3
                if g['floor'].contains(Point((mid[0] + out[0] * reach) * FT, (mid[1] + out[1] * reach) * FT)):
                    out = (-out[0], -out[1])
                if out[0] * n[0] + out[1] * n[1] < 0.7:
                    continue
                start = ((mid[0] + out[0] * reach) * FT, (mid[1] + out[1] * reach) * FT)
                if LineString([start, (start[0] + n[0] * 1000, start[1] + n[1] * 1000)]).intersects(g['floor']):
                    continue
                for o in (o for o in g['openings'] if o['wallId'] == w['id']):
                    a, b = arch.point_along(w, o['offset']), arch.point_along(w, o['offset'] + o['width'])
                    ua, ub = sorted((u_of((a[0] * FT, a[1] * FT)), u_of((b[0] * FT, b[1] * FT))))
                    za, zb = z0 + o['sill'] * FT, z0 + (o['sill'] + o['height']) * FT
                    page.path([to(ua, za), to(ub, za), to(ub, zb), to(ua, zb)], stroke=INK, fill=GLASS if o['kind'] == 'window' else (0.55, 0.55, 0.55), width=0.4)
        if limit:
            page.line(to(-6, limit), to(span + 6, limit), stroke=LIMIT, width=0.6, dash=(6, 3))
            page.text(*to(span + 6, limit + 1), f'Height limit {feet(limit)}', 6, color=LIMIT, anchor='end')
        if account and account['height'].get('maxBaseFeet'):
            base_limit = account['height']['maxBaseFeet']
            page.line(to(-6, base_limit), to(span + 6, base_limit), stroke=LIMIT, width=0.4, dash=(2, 2))
            page.text(*to(span + 6, base_limit + 1), f'Maximum base height {feet(base_limit)}', 6, color=LIMIT, anchor='end')
        page.text(*to(span / 2, -4), 'Curb level 0 ft', 6, color=MUTED, anchor='middle')
    scale_bar(page, M, H - TITLE_H - 22, k)
    return page, label


def section_sheet(doc, account, info, net):
    """A section along the lot depth through the first stair: slabs and walls cut, the stair flights,
    storey elevations and the height limit."""
    page = Page('A-301', 'Section through the core')
    all_storeys = package.storeys(doc)
    stair = next((r for r in doc['rooms'] if r.get('kind') == 'stair'), None)
    geoms = {l['id']: level_geometry(doc, l) for l in doc['levels']}
    union = unary_union([g['floor'] for g in geoms.values()])
    if union.is_empty:
        page.text(M, M + 30, 'No walls or rooms are drawn yet.', 9, color=MUTED)
        return page, None
    cut_x = Polygon([(x * FT, y * FT) for x, y in stair['polygon']]).centroid.x if stair else union.centroid.x
    miny, maxy = union.bounds[1], union.bounds[3]
    bottom = all_storeys[0]['elevation'] * FT
    top = (all_storeys[-1]['elevation'] + all_storeys[-1]['height']) * FT
    limit = account['height'].get('limitFeet') if account else None
    k, label = scale_for(maxy - miny + 20, max(top, limit or 0) - bottom + 10, W - 2 * M - 300, H - TITLE_H - M - 90)
    x0, base = M + 120, H - TITLE_H - 50
    to = lambda y, z: (x0 + (y - miny + 10) * k, base - (z - bottom) * k)
    page.text(M, M + 24, f'Section {feet(cut_x)} from the left side, looking toward the left lot line; the street is on the left', 10, bold=True)
    page.line(to(-10, 0), to(maxy - miny + 10, 0), width=1.0)
    cut = LineString([(cut_x, miny - 1), (cut_x, maxy + 1)])
    for s in all_storeys:
        level = s['level']
        g = geoms[level['id']]
        z0 = s['elevation'] * FT
        slab = level['slabThickness'] * FT
        for part in getattr(g['floor'].intersection(cut), 'geoms', [g['floor'].intersection(cut)]):
            if part.is_empty or part.length < 0.1:
                continue
            ya, yb = sorted(c[1] for c in part.coords)
            page.path([to(ya, z0 - slab), to(yb, z0 - slab), to(yb, z0), to(ya, z0)], stroke=INK, fill=POCHE, width=0.4)
            if s is all_storeys[-1]:
                ztop = z0 + level['height'] * FT
                page.path([to(ya, ztop - slab), to(yb, ztop - slab), to(yb, ztop), to(ya, ztop)], stroke=INK, fill=POCHE, width=0.4)
        for piece in g['wallShapes']:
            hit = piece.intersection(cut)
            if hit.is_empty or hit.length < 0.05:
                continue
            ya, yb = hit.bounds[1], hit.bounds[3]
            page.path([to(ya, z0), to(yb, z0), to(yb, z0 + level['height'] * FT - slab), to(ya, z0 + level['height'] * FT - slab)], stroke=None, fill=POCHE)
        page.text(*to(-12, z0 + 1), f"{s['name']}  {z0:.1f} ft", 6, anchor='end')
        if stair and s is not all_storeys[-1]:
            room = next((r for r in g['rooms'] if r.get('kind') == 'stair' and Polygon(r['polygon']).buffer(0.01).contains(Polygon(stair['polygon']).centroid)), None)
            if room:
                run = package.stair_runs(net[room['id']]['ring'], level['height'])
                for origin, r, across, risers, zf in run['flights']:
                    ya = origin[1] * FT
                    yb = ya + r[1] * (risers - 1) * run['tread'] * FT
                    page.line(to(ya, z0 + zf * FT), to(yb, z0 + (zf + risers * run['riser']) * FT), width=0.6)
    if limit:
        page.line(to(-10, limit), to(maxy - miny + 10, limit), stroke=LIMIT, width=0.6, dash=(6, 3))
        page.text(*to(maxy - miny + 10, limit + 1), f'Height limit {feet(limit)}', 6, color=LIMIT, anchor='end')
    page.text(*to(maxy - miny + 12, top), f'Top of roof {feet(top)}', 6, bold=True)
    x = W - M - 170
    page.text(x, M + 50, 'Storeys', 9, bold=True)
    table(page, [['Storey', 'Floor at', 'Height']] + [[s['name'], f"{s['elevation'] * FT:.1f} ft", feet(s['height'] * FT)] for s in all_storeys][:40],
          x, M + 66, [80, 50, 40], size=6, row_height=9, numeric=(1, 2))
    scale_bar(page, M, H - TITLE_H - 22, k)
    return page, label


def schedule_sheets(sched):
    pages = []
    page = Page('A-601', 'Area, door and window schedules')
    page.text(M, M + 24, 'Area schedule', 10, bold=True)
    rows = [['Storey', 'Use', 'Gross', 'Zoning floor area', 'Net in units', 'Units']]
    for a in sched['areas']:
        rows.append([a['storey'], a['use'], sqft(a['grossSqft']), sqft(a['zfaSqft']) if a['zfaSqft'] is not None else '', sqft(a['netSqft']), str(a['units'])])
    t = sched['areaTotals']
    rows.append(['Total', '', sqft(t['grossSqft']), sqft(t['zfaSqft']) if t['zfaSqft'] else '', sqft(t['netSqft']), str(t['units'])])
    size = 6.5 if len(rows) <= 34 else 5.5
    end = table(page, rows, M, M + 40, [90, 60, 75, 95, 75, 35], size=size, row_height=min(10.5, 380 / len(rows)), numeric=(2, 3, 4, 5))
    page.text(M, end + 6, 'Gross is measured to the outer wall faces; net is inside the unit walls; zoning floor area is from the zoning analysis (zd1.pdf).', 6, color=MUTED)
    x = M + 470
    page.text(x, M + 24, 'Door types', 10, bold=True)
    kinds = {}
    for d in sched['doors']:
        key = (d['mark'], d['kind'], d['width'], d['height'], d['operation'])
        kinds[key] = kinds.get(key, 0) + 1
    rows = [['Mark', 'Type', 'Width', 'Height', 'Operation', 'Count']] + [[*key, str(n)] for key, n in sorted(kinds.items(), key=lambda kv: int(kv[0][0][1:]))]
    end = table(page, rows, x, M + 40, [36, 90, 45, 45, 55, 35], size=6.5, numeric=(5,))
    page.text(x, end + 16, 'Window types', 10, bold=True)
    kinds = {}
    for w in sched['windows']:
        key = (w['mark'], w['width'], w['height'], w['sill'])
        kinds.setdefault(key, []).append(w['share'])
    rows = [['Mark', 'Width', 'Height', 'Sill', 'Count', 'Least glazing share']] + [[*key, str(len(v)), f"{min(s for s in v if s is not None):.0%}" if any(s is not None for s in v) else ''] for key, v in sorted(kinds.items(), key=lambda kv: int(kv[0][0][1:]))]
    end = table(page, rows, x, end + 32, [36, 45, 45, 45, 35, 90], size=6.5, numeric=(4, 5))
    page.text(x, end + 6, "Glazing share: a window's glazed area over its room's floor area (at least 10% for a habitable room, MDL 30).", 6, color=MUTED)
    pages.append(page)
    per_page, columns = 46, 3
    units = sched['units']
    for start in range(0, len(units), per_page * columns):
        page = Page(f'A-{602 + len(pages) - 1}', 'Unit schedule' + (f' ({len(pages)})' if len(units) > per_page * columns else ''))
        page.text(M, M + 24, 'Unit schedule', 10, bold=True)
        chunk = units[start:start + per_page * columns]
        for c in range(columns):
            part = chunk[c * per_page:(c + 1) * per_page]
            if part:
                table(page, [['Unit', 'Storey', 'Type', 'Beds', 'Net']] + [[u['unit'], u['storey'], u['type'] or '', str(u['beds'] or ''), sqft(u['netSqft'])] for u in part],
                      M + c * 380, M + 40, [45, 80, 60, 35, 70], size=6.5, row_height=10.5, numeric=(3, 4))
        pages.append(page)
    return pages


# ---------------------------------------------------------------------------------------------
# The set


def info_for(doc):
    site = doc.get('zoning') or {}
    project = ', '.join(part for part in (site.get('address'), doc['name']) if part)
    sub = ' | '.join(part for part in (site.get('label'), f"BBL {site['lot']['bbl']}" if site.get('lot', {}).get('bbl') else None, site.get('district')) if part)
    return {'project': project, 'subtitle': sub or 'Architecture plan', 'revision': doc['revision']}


def sheets(doc, account=None, zoning_sheet=None):
    """The pages of the set in order, each with its scale, title block applied."""
    sched = package.schedules(doc, account)
    net = package.nets(doc)
    info = info_for(doc)
    north = north_of(doc.get('zoning'))
    body = []
    if zoning_sheet is not None:
        body.append((Page('Z-001', 'Zoning diagram', zoning_sheet.items), None, False))
    if doc.get('zoning'):
        body.append((*site_plan(doc, info), True))
    levels = sorted(doc['levels'], key=lambda l: l['elevation'])
    for i, level in enumerate(levels):
        body.append((*plan_sheet(doc, level, f'A-{101 + i}', info, north, net), True))
    body.append((*elevation_sheet(doc, account, 'A-201', [('Front', (0, -1)), ('Rear', (0, 1))], info), True))
    body.append((*elevation_sheet(doc, account, 'A-202', [('Left', (-1, 0)), ('Right', (1, 0))], info), True))
    body.append((*section_sheet(doc, account, info, net), True))
    body += [(p, None, True) for p in schedule_sheets(sched)]
    check = package.selfcheck(doc, account)
    pages = [p for p, _, _ in body]
    front = [selfcheck_sheet(check)]
    cover_page = cover(info, doc, account, [Page('G-001', 'Cover sheet')] + front + pages, sched, check)
    ordered = [(cover_page, None, True), (front[0], None, True)] + body
    for i, (page, scale, framed) in enumerate(ordered, 1):
        if framed:
            title_block(page, {**info, 'index': i, 'count': len(ordered)}, scale)
        else:
            page.text(W - M, H - 4, f"{page.number}  |  Sheet {i} of {len(ordered)}  |  Pre-filing package, not for filing", 6.5, color=MUTED, anchor='end')
    return [p for p, _, _ in ordered], sched, check


def write_schedules(path, sched):
    book = Workbook()
    def sheet(title, header, rows, first=False):
        ws = book.active if first else book.create_sheet()
        ws.title = title
        ws.append(header)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for row in rows:
            ws.append(row)
    sheet('Areas', ['Storey', 'Use', 'Floor elevation (ft)', 'Gross (sq ft)', 'Zoning floor area (sq ft)', 'Net in units (sq ft)', 'Units'],
          [[a['storey'], a['use'], round(a['elevationFeet'], 2), round(a['grossSqft']), None if a['zfaSqft'] is None else round(a['zfaSqft']), round(a['netSqft']), a['units']] for a in sched['areas']], first=True)
    sheet('Units', ['Unit', 'Storey', 'Type', 'Bedrooms', 'Rooms', 'Net (sq ft)', 'Gross (sq ft)'],
          [[u['unit'], u['storey'], u['type'], u['beds'], u['rooms'], round(u['netSqft']), round(u['grossSqft'])] for u in sched['units']])
    sheet('Doors', ['Mark', 'Storey', 'Type', 'Between', 'Width', 'Height', 'Operation'],
          [[d['mark'], d['storey'], d['kind'], d['between'], d['width'], d['height'], d['operation']] for d in sched['doors']])
    sheet('Windows', ['Mark', 'Storey', 'Room', 'Width', 'Height', 'Sill', 'Glazed (sq ft)', 'Room (sq ft)', 'Glazing share'],
          [[w['mark'], w['storey'], w['room'], w['width'], w['height'], w['sill'], round(w['glazedSqft'], 1), None if w['roomSqft'] is None else round(w['roomSqft']), None if w['share'] is None else round(w['share'], 3)] for w in sched['windows']])
    book.properties.creator = 'Arosa'
    book.save(path)


def write(doc, out_dir, account=None, zoning_sheet=None):
    """drawings.pdf, schedules.xlsx and selfcheck.json for a plan revision; returns the sheet list."""
    pages, sched, check = sheets(doc, account, zoning_sheet)
    with open(os.path.join(out_dir, 'drawings.pdf'), 'wb') as handle:
        handle.write(pdf(pages))
    write_schedules(os.path.join(out_dir, 'schedules.xlsx'), sched)
    with open(os.path.join(out_dir, 'selfcheck.json'), 'w') as handle:
        json.dump(check, handle, indent=1)
    return [{'number': p.number, 'title': p.title} for p in pages]
