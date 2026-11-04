"""ZD1-style zoning sheet for one option, as SVG and PDF: a site plan with the lot lines, yards and
setbacks; a section with the storeys, the base and building heights; and the zoning calculations
table, each figure with its Zoning Resolution section. One drawing model feeds both writers, so the
two files always agree. Sheet: 17 by 11 in, points.

draw(site, account, title) -> Sheet, the drawing model (items in page points, y down), which other
sheet sets reuse as a page; render(site, account, title) -> (svg text, pdf bytes). site is the
option's acres.outlines/1 export and account its zoning.account, whose storeys carry the drawn
footprint and the buildable outline.
"""
import json
import os

import architecture
import outlines as outline_source
import zoning
from engine import storey_outlines

W, H, M = 1224, 792, 36
INK, MUTED, RULE = (0.1, 0.1, 0.1), (0.42, 0.42, 0.42), (0.78, 0.78, 0.78)
YARD, BUILDING, LIMIT = (0.86, 0.93, 0.87), (0.85, 0.85, 0.85), (0.72, 0.16, 0.16)
YARD_NAMES = {'rear_yard': 'Rear yard', 'side_yard': 'Side yards', 'front_yard': 'Front yard', 'rear_yard_equivalent': 'Rear yard equivalent'}
SURVEY_NOTE = 'Lot lines come from the city\'s tax map, not a survey.'
SCOPE_NOTE = 'Pre-filing zoning analysis from the Zoning Resolution as amended December 5, 2024. Not a zoning determination; a DOB filing needs drawings sealed by a registered architect or engineer.'


def sqft(n):
    return f'{round(n):,} sq ft'


def feet(n):
    return f'{n:g} ft'


class Sheet:
    def __init__(self):
        self.items = []

    def path(self, points, stroke=INK, fill=None, width=0.75, dash=None, closed=True):
        self.items.append(('path', [tuple(p) for p in points], stroke, fill, width, dash, closed))

    def line(self, a, b, **style):
        self.path([a, b], closed=False, **style)

    def text(self, x, y, s, size=8, bold=False, anchor='start', color=INK):
        self.items.append(('text', x, y, str(s), size, bold, anchor, color))

    def svg(self):
        hexc = lambda c: '#%02x%02x%02x' % tuple(round(v * 255) for v in c)
        esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Helvetica, Arial, sans-serif">',
               f'<rect width="{W}" height="{H}" fill="#ffffff"/>']
        for item in self.items:
            if item[0] == 'path':
                _, pts, stroke, fill, width, dash, closed = item
                d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + (' Z' if closed else '')
                out.append(f'<path d="{d}" fill="{hexc(fill) if fill else "none"}" stroke="{hexc(stroke) if stroke else "none"}" stroke-width="{width}"'
                           + (f' stroke-dasharray="{dash[0]} {dash[1]}"' if dash else '') + '/>')
            else:
                _, x, y, s, size, bold, anchor, color = item
                out.append(f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size}" fill="{hexc(color)}" text-anchor="{anchor}"' + (' font-weight="bold"' if bold else '') + f'>{esc(s)}</text>')
        out.append('</svg>')
        return '\n'.join(out) + '\n'

    def pdf(self):
        ops = []
        for item in self.items:
            if item[0] == 'path':
                _, pts, stroke, fill, width, dash, closed = item
                ops.append(f'{width} w ' + (f'[{dash[0]} {dash[1]}] 0 d' if dash else '[] 0 d'))
                if stroke:
                    ops.append('%.3f %.3f %.3f RG' % stroke)
                if fill:
                    ops.append('%.3f %.3f %.3f rg' % fill)
                ops.append(' '.join(f'{x:.2f} {H - y:.2f} {"m" if i == 0 else "l"}' for i, (x, y) in enumerate(pts)) + (' h' if closed else ''))
                ops.append('B' if fill and stroke else 'f' if fill else 'S')
            else:
                _, x, y, s, size, bold, anchor, color = item
                # Helvetica averages about half an em per character; close enough to centre or right-align a label.
                width = len(s) * size * 0.5
                x0 = x - width / 2 if anchor == 'middle' else x - width if anchor == 'end' else x
                text = s.encode('latin-1', 'replace').decode('latin-1').replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
                ops.append('%.3f %.3f %.3f rg BT /%s %s Tf %.2f %.2f Td (%s) Tj ET' % (*color, 'F2' if bold else 'F1', size, x0, H - y, text))
        stream = '\n'.join(ops).encode('latin-1', 'replace')
        objects = [
            b'<< /Type /Catalog /Pages 2 0 R >>',
            b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>'.encode(),
            b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
        ]
        out, offsets = bytearray(b'%PDF-1.4\n'), []
        for i, body in enumerate(objects, 1):
            offsets.append(len(out))
            out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
        xref = len(out)
        out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offsets)
        out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref)
        return bytes(out)


def fit(bounds, box):
    """Scale and offset that fit plan bounds (x, z) into a screen box, z up the page."""
    minx, minz, maxx, maxz = bounds
    bx, by, bw, bh = box
    k = min(bw / max(maxx - minx, 1), bh / max(maxz - minz, 1))
    ox = bx + (bw - (maxx - minx) * k) / 2
    oy = by + bh - (bh - (maxz - minz) * k) / 2
    return lambda x, z: (ox + (x - minx) * k, oy - (z - minz) * k), k


def rings(geometry):
    return [(list(p.exterior.coords), [list(h.coords) for h in p.interiors]) for p in outline_source.parts(geometry)]


def shapes(polys):
    return [(p['exterior'] + p['exterior'][:1], [h + h[:1] for h in p['holes']]) for p in polys]


def extent(polys, axis):
    values = [pt[axis] for p in polys for pt in p['exterior']]
    return (min(values), max(values)) if values else None


def site_plan(sheet, site, account, box):
    lot = outline_source.lot_polygon(site['lot'])
    bx, by, bw, bh = box
    sheet.text(bx, by - 8, 'Site plan', 10, bold=True)
    to, k = fit(lot.bounds, (bx + 60, by + 20, bw - 150, bh - 90))
    sheet.path([to(x, z) for x, z in lot.exterior.coords], stroke=None, fill=YARD)
    above = [s for s in account['storeys'] if s['bottomFeet'] >= 0]
    for exterior, holes in shapes(above[0]['footprint']):
        sheet.path([to(x, z) for x, z in exterior], stroke=INK, fill=BUILDING, width=0.75)
        for hole in holes:
            sheet.path([to(x, z) for x, z in hole], stroke=INK, fill=YARD, width=0.75)
    seen = set()
    for s in above:
        key = repr(s['permitted'])
        if key in seen:
            continue
        seen.add(key)
        for exterior, _ in shapes(s['permitted']):
            sheet.path([to(x, z) for x, z in exterior], stroke=MUTED, width=0.6, dash=(4, 3))
    for portion in account['portions'][1:]:
        for exterior, _ in shapes(portion['footprint']):
            sheet.path([to(x, z) for x, z in exterior], stroke=MUTED, width=0.8, dash=(8, 2))
            xs, zs = [p[0] for p in exterior], [p[1] for p in exterior]
            x, y = to(sum(xs) / len(xs), sum(zs) / len(zs))
            sheet.text(x, y + 10, portion['label'], 7, anchor='middle', color=MUTED)
    for exterior, _ in shapes(account['cornerPortion']['footprint']):
        sheet.path([to(x, z) for x, z in exterior], stroke=LIMIT, width=0.6, dash=(1.5, 2))
        xs, zs = [p[0] for p in exterior], [p[1] for p in exterior]
        x, y = to(sum(xs) / len(xs), sum(zs) / len(zs))
        sheet.text(x, y, 'Corner portion: no rear yard', 7, anchor='middle', color=LIMIT)
    sheet.path([to(x, z) for x, z in lot.exterior.coords], stroke=INK, width=2)
    if site['lot'].get('north'):
        north_arrow(sheet, site['lot']['north'], (bx + 24, by + 44))
    minx, minz, maxx, maxz = lot.bounds
    for side, st in {s['side']: s for s in site['streets']}.items():
        label = f"{st.get('name') or 'Street'}{', ' + feet(st['widthFeet']) + ' wide' if st.get('widthFeet') else ''}{' (wide street)' if st.get('wide') else ''}".upper()
        if side == 'front':
            x, y = to((minx + maxx) / 2, minz)
            sheet.text(x, y + 30, label, 8, bold=True, anchor='middle')
        elif side == 'rear':
            x, y = to((minx + maxx) / 2, maxz)
            sheet.text(x, y - 12, label, 8, bold=True, anchor='middle')
        else:
            x, y = to(minx if side == 'left' else maxx, (minz + maxz) / 2)
            sheet.text(x + (-10 if side == 'left' else 44), y, label, 7, bold=True, anchor='end' if side == 'left' else 'start')
    (ax, ay), (cx, cy) = to(minx, minz), to(maxx, minz)
    sheet.line((ax, ay + 8), (cx, cy + 8), stroke=MUTED, width=0.5)
    sheet.text((ax + cx) / 2, ay + 17, feet(round(maxx - minx, 1)), 7, anchor='middle', color=MUTED)
    (dx, dy), (ex, ey) = to(maxx, minz), to(maxx, maxz)
    sheet.line((dx + 8, dy), (ex + 8, ey), stroke=MUTED, width=0.5)
    sheet.text(dx + 12, (dy + ey) / 2 + 12, feet(round(maxz - minz, 1)), 7, color=MUTED)
    legend_y = by + bh - 4
    for i, (fill, stroke, dash, label) in enumerate([(BUILDING, INK, None, 'Ground floor as drawn'), (None, MUTED, (4, 3), 'Buildable outline by storey'), (YARD, None, None, 'Yards and open space')]):
        x = bx + 4 + i * 160
        sheet.path([(x, legend_y - 7), (x + 14, legend_y - 7), (x + 14, legend_y), (x, legend_y)], stroke=stroke, fill=fill, width=0.6, dash=dash)
        sheet.text(x + 20, legend_y, label, 7)


def north_arrow(sheet, north, centre, length=22):
    """True north from the lot's frame (x, z), drawn on the page where z runs up."""
    nx, nz = north
    norm = (nx * nx + nz * nz) ** 0.5
    dx, dy = nx / norm, -nz / norm
    cx, cy = centre
    tip, tail = (cx + dx * length / 2, cy + dy * length / 2), (cx - dx * length / 2, cy - dy * length / 2)
    side = (-dy * 5, dx * 5)
    sheet.line(tail, tip, width=1)
    sheet.path([tip, (tip[0] - dx * 9 + side[0], tip[1] - dy * 9 + side[1]), (tip[0] - dx * 9 - side[0], tip[1] - dy * 9 - side[1])], stroke=INK, fill=INK, width=0.5)
    sheet.text(tip[0] + dx * 9, tip[1] + dy * 9 + 3, 'N', 9, bold=True, anchor='middle')


def section(sheet, site, account, box):
    lot = outline_source.lot_polygon(site['lot'])
    bx, by, bw, bh = box
    sheet.text(bx, by - 8, 'Section through the lot, street to rear', 10, bold=True)
    above = [s for s in account['storeys'] if s['bottomFeet'] >= 0 and s['footprint']]
    h = account['height']
    top = max([s['topFeet'] for s in above] + [h['limitFeet'] or 0])
    minz, maxz = lot.bounds[1], lot.bounds[3]
    to, k = fit((minz, 0, maxz, top * 1.08), (bx + 50, by + 10, bw - 140, bh - 40))
    ground_y = to(minz, 0)[1]
    sheet.line((to(minz, 0)[0] - 30, ground_y), (to(maxz, 0)[0] + 20, ground_y), width=1)
    for s in above:
        (a, b), allowed = extent(s['footprint'], 1), extent(s['permitted'], 1)
        if allowed:
            (x0, y0), (x1, y1) = to(allowed[0], s['bottomFeet']), to(allowed[1], s['topFeet'])
            sheet.path([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], stroke=MUTED, width=0.5, dash=(4, 3))
        (x0, y0), (x1, y1) = to(a, s['bottomFeet']), to(b, s['topFeet'])
        sheet.path([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], stroke=INK, fill=BUILDING, width=0.5)
    for z, label in ((minz, 'Street line'), (maxz, 'Rear lot line' if not any(s['side'] == 'rear' for s in site['streets']) else 'Street line')):
        x, _ = to(z, 0)
        sheet.line((x, ground_y + 6), (x, to(z, top * 1.05)[1]), stroke=MUTED, width=0.6, dash=(6, 3))
        sheet.text(x, ground_y + 16, label, 7, anchor='middle', color=MUTED)
    marks = [(h['buildingFeet'], f"Building {feet(h['buildingFeet'])}, {h['storeys']} storeys", INK, None)]
    if h['limitFeet']:
        marks.append((h['limitFeet'], f"Maximum building height {feet(h['limitFeet'])}", LIMIT, (5, 3)))
    if h['maxBaseFeet']:
        marks.append((h['maxBaseFeet'], f"Maximum base height {feet(h['maxBaseFeet'])}", MUTED, (2, 2)))
    if h['minBaseFeet']:
        marks.append((h['minBaseFeet'], f"Minimum base height {feet(h['minBaseFeet'])}", MUTED, (2, 2)))
    right = to(maxz, 0)[0] + 24
    used = []
    for feet_up, label, color, dash in marks:
        y = to(minz, feet_up)[1]
        if dash:
            sheet.line((to(minz, 0)[0] - 20, y), (right - 4, y), stroke=color, width=0.75, dash=dash)
        ly = y + 3
        while any(abs(ly - u) < 9 for u in used):
            ly += 9
        used.append(ly)
        sheet.text(right, ly, label, 7, color=color)
    sheet.text(bx + 4, by + bh + 4, ', '.join(h['sections']), 7, color=MUTED)


def table(sheet, rows, x, y, widths, size=7, row_height=11.5, numeric=()):
    for i, row in enumerate(rows):
        cy = y + i * row_height
        if i == 0:
            sheet.line((x, cy + 3), (x + sum(widths), cy + 3), stroke=INK, width=0.75)
        elif i < len(rows):
            sheet.line((x, cy + 3), (x + sum(widths), cy + 3), stroke=RULE, width=0.3)
        cx = x
        for j, (cell, width) in enumerate(zip(row, widths)):
            right = j in numeric and i > 0
            sheet.text(cx + width - 6 if right else cx + 2, cy, cell, size, bold=(i == 0), anchor='end' if right else 'start')
            cx += width
    return y + len(rows) * row_height


def calculations(site, account):
    far, cov, h, du, p = account['far'], account['lotCoverage'], account['height'], account['dwellingUnits'], account['parking']
    district = (', '.join(f"{p['district']} {p['sharePercent']:g}%" for p in site['districtPortions']) if site.get('districtPortions') else site['district']) + (f" in {', '.join(site['specialDistricts'])}" if site.get('specialDistricts') else '')
    rows = [['Item', 'Permitted or required', 'Proposed', 'Zoning Resolution']]
    rows.append(['Zoning district', district, site['lot']['type'] + ' lot', 'Zoning Map' + (', ZR 77-02' if site.get('districtPortions') else '')])
    rows.append(['Lot area (on record)', sqft(account['lotAreaSqft']), sqft(account['lotAreaSqft']), 'ZR 12-10 (lot area)'])
    if abs(account['taxMapAreaSqft'] - account['lotAreaSqft']) >= 1:
        rows.append(['  Tax map polygon', '', sqft(account['taxMapAreaSqft']), 'ZR 12-10 (lot area)'])
    rows.append(['Floor area ratio', f"{far['allowed']:g}", f"{far['used']:g}", ', '.join(dict.fromkeys(far['sections'] + (['ZR 77-22'] if account['portions'] else [])))])
    rows.append(['Zoning floor area', sqft(far['allowedSqft']), sqft(account['totals']['zfaSqft']), 'ZR 12-10 (floor area)'])
    for use, area in account['totals']['byUse'].items():
        rows.append([f'  {use.capitalize()} floor area', '', sqft(area), 'ZR 12-10 (floor area)'])
    rows.append(['Lot coverage', f"{cov['allowedPercent']:g}%" if cov['allowedPercent'] is not None else 'set by yards', f"{cov['percent']:g}%", ', '.join(cov['sections'])])
    rows.append(['Open space', '', sqft(cov['openSpaceSqft']), 'ZR 12-10 (open space)'])
    for y in account['yards']:
        rows.append([f"{YARD_NAMES[y['yard']]} ({y.get('portion') or y['storeys']})", feet(y['requiredFeet']), feet(y['providedFeet']), y['section']])
    if account['cornerPortion']['footprint']:
        rows.append(['  Corner portion', 'no rear yard', '', f"ZR 12-10, {account['cornerPortion']['section']}"])
    for portion in account['portions']:
        base = f"base {feet(portion['minBaseFeet'])} to {feet(portion['maxBaseFeet'])}, " if portion['minBaseFeet'] and portion['maxBaseFeet'] else f"base up to {feet(portion['maxBaseFeet'])}, " if portion['maxBaseFeet'] else ''
        rows.append([f"  {portion['label']} ({portion['sharePercent']:g}%)", f"{base}height {feet(portion['heightLimitFeet']) if portion['heightLimitFeet'] else 'by setbacks'}", '', ', '.join(portion['sections'])])
    if h['minBaseFeet'] or h['maxBaseFeet']:
        rows.append(['Base height', f"{feet(h['minBaseFeet']) + ' to ' if h['minBaseFeet'] else 'up to '}{feet(h['maxBaseFeet'])}", feet(h['baseFeet']), ', '.join(site['streetWall'].get('sections', [])[:1])])
    rows.append(['Building height', feet(h['limitFeet']) if h['limitFeet'] else 'set by setbacks', feet(h['buildingFeet']), ', '.join(site['setbacks'].get('sections', [])[:2])])
    rows.append(['Dwelling units', str(du['maxUnits']) if du['maxUnits'] is not None else 'no factor', str(du['units']), ', '.join(du['sections'][:1])])
    zone_label = {'inner': 'Inner Transit Zone', 'outer': 'Outer Transit Zone', 'beyond': 'beyond the Greater Transit Zone', 'special-25-241': 'Outer Transit Zone, ZR 25-241 area', 'lic': 'Long Island City area'}
    if p['required'] is not None:
        where = f", {zone_label[p['transitZone']]}" if p.get('transitZone') in zone_label else ', Manhattan Core' if p['manhattanCore'] else ''
        rows.append(['Accessory parking', f"{p['required']} spaces{where}", f"{p['provided']} spaces", ', '.join(p['sections'][:3])])
    elif p['byTransitZone']:
        z = p['byTransitZone']
        zone_names = {'inner': 'Inner zone', 'outer': 'Outer zone', 'beyond': 'Beyond the zones'}
        rows.append(['Accessory parking', ', '.join(f"{zone_names.get(zone, zone)} {v['required'] if v['required'] is not None else 'not curated'}" for zone, v in z.items()), f"{p['provided']} spaces", ', '.join(sorted({s for v in z.values() for s in v['sections']}))])
        waiver = z.get('outer', {}).get('waiverSpaces')
        if waiver:
            rows.append(['  Waiver (outer zone)', f'{waiver} spaces or fewer', '', 'ZR 25-222'])
    rows.append(['Bicycle parking', f"{account['bicycleParking']['required']} spaces", '', account['bicycleParking']['section']])
    inner = [c for c in account['courts'] if c.get('kind', 'inner') == 'inner']
    outer = [c for c in account['courts'] if c.get('kind') == 'outer']
    rows.append(['Inner courts', '800 sq ft, 20 ft min. (with windows)', f"{len(inner)} enclosed" if inner else 'none enclosed', 'ZR 23-352'])
    rows.append(['Outer courts', 'width at least depth, or 20 ft wide (with windows)', (f"{len(outer)} measured" + (f", {sum(1 for c in outer if not c['pass'])} short" if any(not c['pass'] for c in outer) else '')) if outer else 'none', 'ZR 23-353'])
    return rows


def storey_rows(account):
    rows = [['Storey', 'Gross', 'Excluded', 'Zoning floor area', 'Budget']]
    for s in account['storeys']:
        excluded = s['grossSqft'] - s['zfaSqft']
        rows.append([s['label'], f"{s['grossSqft']:,}", f"{excluded:,}", f"{s['zfaSqft']:,}" + (' over' if s['overBudgetSqft'] else ''), f"{s['budgetSqft']:,}"])
    t = account['totals']
    rows.append(['Total', f"{t['grossSqft']:,}", f"{t['grossSqft'] - t['zfaSqft']:,}", f"{t['zfaSqft']:,}", f"{t['budgetSqft']:,}"])
    return rows


def exclusion_lines(account):
    seen = {}
    for s in account['storeys']:
        for e in s['exclusions']:
            key = (e['kind'], e['basis'], e['section'])
            seen[key] = seen.get(key, 0) + e['sqft']
    names = {'mechanical': 'Mechanical', 'parking': 'Parking', 'corridor': 'Corridors (half)', 'refuse': 'Refuse rooms', 'bicycle': 'Bicycle rooms',
             'amenity': 'Residential amenities', 'exterior_wall': 'Exterior wall thickness', 'cellar': 'Cellar'}
    return [f"{names.get(kind, kind)}: {sqft(area)} ({'assumed until drawn' if basis == 'assumed' else 'drawn'}), {section}" for (kind, basis, section), area in seen.items()]


def draw(site, account, title):
    sheet = Sheet()
    sheet.text(M, M, 'Zoning diagram', 16, bold=True)
    sheet.text(M, M + 16, title, 9, color=MUTED)
    sheet.text(W - M, M, f"{site['district']}  |  FAR {account['far']['used']:g} of {account['far']['allowed']:g}  |  {sqft(account['totals']['zfaSqft'])} zoning floor area", 9, bold=True, anchor='end')
    sheet.text(W - M, M + 16, f"Lot {sqft(account['lotAreaSqft'])}" + (f", BBL {site['lot']['bbl']}" if site['lot'].get('bbl') else ''), 9, color=MUTED, anchor='end')
    site_plan(sheet, site, account, (M, 90, 560, 380))
    section(sheet, site, account, (M + 600, 90, W - 2 * M - 600, 360))
    sheet.text(M, 500, 'Zoning calculations', 10, bold=True)
    end = table(sheet, calculations(site, account), M, 516, [150, 175, 85, 200])
    sheet.text(M + 640, 500, 'Floor area by storey (sq ft)', 10, bold=True)
    rows = storey_rows(account)
    size = 7 if len(rows) <= 22 else 6
    after = table(sheet, rows, M + 640, 516, [150, 70, 70, 100, 80], size=size, row_height=min(11.5, 200 / len(rows)), numeric=(1, 2, 3, 4))
    for i, line in enumerate(exclusion_lines(account)):
        sheet.text(M + 640, after + 6 + i * 9, line, 6.5, color=MUTED)
    flags = []
    if account['overBudget']:
        flags.append(f"Over its zoning floor area budget: {', '.join(account['overBudget'])}.")
    for y in account['yards']:
        if not y['pass']:
            flags.append(f"{YARD_NAMES[y['yard']]} ({y['storeys']}{', ' + y['portion'] if y.get('portion') else ''}): {feet(y['providedFeet'])} provided, {feet(y['requiredFeet'])} required ({y['section']}).")
    du, cov, h = account['dwellingUnits'], account['lotCoverage'], account['height']
    if not du['pass']:
        flags.append(f"{du['units']} dwelling units drawn, above the {du['maxUnits']} the floor area allows ({du['sections'][0]}).")
    if not cov['pass']:
        flags.append(f"Lot coverage {cov['percent']:g}%, above the {cov['allowedPercent']:g}% allowed ({cov['sections'][0]}).")
    if not h['pass']:
        flags.append(f"Height {feet(h['buildingFeet'])} or base {feet(h['baseFeet'])} outside the limits ({', '.join(h['sections'][:2])}).")
    short = account.get('optionShortfallSqft', 0)
    if short > 0.05 * site['program']['zfa']:
        flags.append(f"The drawn storeys hold {sqft(account['totals']['zfaSqft'])} of zoning floor area, {sqft(short)} short of the {sqft(site['program']['zfa'])} this option is priced at.")
    gap = account['taxMapAreaSqft'] / account['lotAreaSqft'] - 1
    if abs(gap) > 0.05:
        flags.append(f"The tax map polygon measures {sqft(account['taxMapAreaSqft'])}, {abs(gap) * 100:.0f}% {'more' if gap > 0 else 'less'} than the {sqft(account['lotAreaSqft'])} on record; floor area is figured on the recorded area. Confirm the lot area by survey.")
    beyond = [s['label'] for s in account['storeys'] if s.get('beyondEnvelope')]
    if beyond:
        flags.append(f"Above the storeys the envelope outlines, checked against the top outlined storey's controls: {', '.join(beyond)}.")
    for c in account['courts']:
        if c.get('kind') == 'outer' and not c['pass']:
            flags.append(f"Outer court on {c['storey']}: {feet(c['widthFeet'])} wide and {feet(c['depthFeet'])} deep; where legally required windows face it, it must be as wide as it is deep or {feet(c['minWidthFeet'])} wide (ZR 23-353).")
    if account.get('outsideOutline'):
        flags.append(f"Drawn floor larger than its outline: {', '.join(account['outsideOutline'])}.")
    for i, flag in enumerate(flags):
        sheet.text(M, max(end, 700) + 4 + i * 10, flag, 7.5, bold=True, color=LIMIT)
    sheet.line((M, H - 34), (W - M, H - 34), stroke=RULE, width=0.5)
    sheet.text(M, H - 22, SURVEY_NOTE if site['lot']['source'] == 'tax-lot' else outline_source.RECTANGLE_NOTE, 7.5, bold=True)
    sheet.text(M, H - 12, SCOPE_NOTE, 7, color=MUTED)
    return sheet


def render(site, account, title):
    sheet = draw(site, account, title)
    return sheet.svg(), sheet.pdf()


def drawn_storeys(doc, found):
    """Every storey the plan draws, lowest first, from its levels (architecture.levels_of): each storey
    a level stands for carries that level's rooms and plate; heights are the level's floor-to-floor, or
    the outline's at that storey."""
    out = []
    for lv in architecture.levels_of(doc):
        rooms = {'rooms': lv['rooms']}
        spaces, plate = zoning.spaces_from_plan(rooms), zoning.plate_from_plan(rooms)
        for st in lv['storeys']:
            out.append({'name': st['name'], 'use': lv['use'] or 'residential', 'bottomFeet': round(st['elevation'] / 0.3048, 2),
                        'height': lv['level'].get('height'), 'spaces': spaces, 'plate': plate})
    out.sort(key=lambda d: d['bottomFeet'])
    above = [d for d in out if d['bottomFeet'] >= -0.01]
    for d in out:
        d['heightFeet'] = round(d.pop('height') / 0.3048, 2) if d.get('height') else found[min(above.index(d), len(found) - 1)].height if d in above else 10
    return out


def typical_level(doc):
    """The residential level that stands for the most storeys (a level without storeys is one), or the
    first level of a one-level plan."""
    residential = [l for l in doc['levels'] if l.get('use', 'residential') == 'residential']
    return max(residential or doc['levels'][:1], key=lambda l: len(l.get('storeys') or [None]))


def write(doc, out_dir):
    """The zoning sheet (zd1.svg, zd1.pdf) and its figures (zoning.json) for a plan document that
    carries its option's storey outlines as zoning; the typical floor is typical_level(doc)."""
    site = doc['zoning']
    found = storey_outlines(site)
    if any(l.get('storeys') for l in doc['levels']) and doc['rooms']:
        # Levels that name their storeys: each storey on its own plate.
        account = zoning.account(site, found, drawn=drawn_storeys(doc, found))
    else:
        level = typical_level(doc)['id']
        rooms = {'rooms': [r for r in doc['rooms'] if r['levelId'] == level]}
        typical = zoning.spaces_from_plan(rooms)
        account = zoning.account(site, found, typical=typical or None, plate=zoning.plate_from_plan(rooms) if typical else None)
    title = ', '.join(part for part in (site.get('address'), site.get('label') or doc['name']) if part)
    svg_text, pdf_bytes = render(site, account, title)
    with open(os.path.join(out_dir, 'zd1.svg'), 'w') as handle:
        handle.write(svg_text)
    with open(os.path.join(out_dir, 'zd1.pdf'), 'wb') as handle:
        handle.write(pdf_bytes)
    with open(os.path.join(out_dir, 'zoning.json'), 'w') as handle:
        json.dump({'schema': 'acres.zoning/1', 'planId': doc['id'], 'revision': doc['revision'], 'note': outline_source.outline_note(site),
                   'north': site['lot'].get('north'), 'transitZone': {'zone': account['parking']['transitZone'], 'source': account['parking']['transitZoneSource']}, **account}, handle, indent=1)
    return account
