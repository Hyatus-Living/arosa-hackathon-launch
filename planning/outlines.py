"""Buildable storey outlines on the exact lot polygon, drawn from the zoning envelope's per-storey
controls (acres-research/envelope.mjs storeyOutlines, schema acres.outlines/1).

Feet in the acres_model_concept frame: x along the front street, z into the lot, the front street
line at the smallest z. Yards and street setbacks are bands measured square from the lot lines they
belong to, so a skewed rear lot line gets a skewed rear yard and an irregular lot keeps its shape;
lot coverage and floor area caps trim from the rear, keeping the street side, as the envelope does.
"""
from dataclasses import dataclass

from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

import assemble

SCHEMA = 'acres.outlines/1'
# Outward normal of a lot line facing each street side.
SIDES = {'front': (0.0, -1.0), 'rear': (0.0, 1.0), 'left': (-1.0, 0.0), 'right': (1.0, 0.0)}
COS_45 = 0.70710678
HAIRLINE = 0.05
LINE_TOLERANCE = 0.5
RECTANGLE_NOTE = 'No tax-lot polygon was found for this lot, so its outline is a rectangle from the frontage and depth on record.'


@dataclass
class StoreyOutline:
    index: int
    label: str
    use: str
    bottom: float          # ft above curb level
    top: float
    height: float
    geometry: object       # shapely Polygon or MultiPolygon, feet, holes kept
    zfa_budget: float      # zoning floor area this storey may hold, sq ft
    gross_budget: float    # the envelope's gross footprint for this storey, sq ft
    shaped_by: list        # the controls that shaped it, each with its ZR section
    courts: dict | None    # inner and outer court minimums at this height (ZR 23-352, 23-353)
    court_checks: list     # courts the outline encloses, measured against the minimums
    source: str            # tax-lot or rectangle
    equivalent: str = None  # where a through lot's rear yard equivalent lies: midway, street_lines or side_lot_lines

    @property
    def area(self):
        return self.geometry.area

    @property
    def polygons(self):
        return [{'exterior': ring_of(p.exterior), 'holes': [ring_of(h) for h in p.interiors]} for p in parts(self.geometry)]


def ring_of(ring):
    return [[round(x, 2), round(z, 2)] for x, z in list(ring.coords)[:-1]]


def parts(geometry):
    """The polygons of a geometry, largest first, from a multipolygon or the collection an
    intersection can return (lines and points dropped)."""
    if geometry.is_empty:
        return []
    polys = [q for g in getattr(geometry, 'geoms', [geometry]) for q in getattr(g, 'geoms', [g])]
    return sorted((p for p in polys if isinstance(p, Polygon) and p.area >= 1), key=lambda p: -p.area)


def lot_polygon(lot):
    polygon = Polygon(lot['exterior'], lot.get('holes') or [])
    if not polygon.is_valid or polygon.area <= 1:
        raise ValueError('The outline export needs a valid lot ring with positive area.')
    return polygon


def lot_lines(lot, street_sides):
    """Street lines by side: edges on the lot's convex hull whose outward normal is within 45 degrees
    of a street side. Rear lot lines follow ZR 12-10: other lot lines within 45 degrees of parallel to
    a street line that do not meet one. A corner lot has none by that test; there the lines facing the
    rear carry the rear yard, as the envelope draws it. The rest are side lot lines."""
    oriented = orient(lot.simplify(HAIRLINE), 1.0)
    hull = oriented.convex_hull.exterior.buffer(LINE_TOLERANCE)
    streets, others = {side: [] for side in street_sides}, []
    for line in assemble.edges(oriented.exterior):
        normal = outward(line)
        street = next((side for side in street_sides if facing(normal, side)), None)
        if street and hull.contains(line):
            streets[street].append(line)
        else:
            others.append(line)
    street_lines = [line for group in streets.values() for line in group]
    near = unary_union(street_lines)
    def parallel(line):
        dx, dz = assemble.unit(line)
        return any(abs(dx * fx + dz * fz) >= COS_45 for fx, fz in map(assemble.unit, street_lines))
    rears = [line for line in others if line.length >= 1 and parallel(line) and line.distance(near) > LINE_TOLERANCE]
    if not rears:
        rears = [line for line in others if line.length >= 1 and facing(outward(line), 'rear')]
    return streets, rears, [line for line in others if line not in rears]


def outward(line):
    dx, dz = assemble.unit(line)
    return (dz, -dx)


def facing(normal, side):
    return normal[0] * SIDES[side][0] + normal[1] * SIDES[side][1] >= COS_45


def band(lines, depth, lot):
    """The part of the lot within depth of the lines, measured square from each line. An end at a
    convex lot corner runs on past the corner, closing the wedge a square-ended band leaves where the
    neighbouring lot line meets it at an acute angle; an end at a re-entrant corner stops square."""
    if depth <= 0 or not lines:
        return assemble.EMPTY
    def convex(point):
        return lot.intersection(Point(point).buffer(0.5)).area < 0.5 * Point(point).buffer(0.5).area
    strips = []
    for line in lines:
        (ax, az), (bx, bz) = line.coords
        dx, dz = assemble.unit(line)
        a = (ax - dx * depth, az - dz * depth) if convex((ax, az)) else (ax, az)
        b = (bx + dx * depth, bz + dz * depth) if convex((bx, bz)) else (bx, bz)
        strips.append(LineString([a, b]).buffer(depth, cap_style='flat'))
    return unary_union(strips).intersection(lot)


def corner_portions(lot, streets, feet):
    """ZR 12-10: the corner portion of a corner lot, bounded by two street lines that meet at an
    interior angle of 135 degrees or less and lines parallel to and feet (100) from each. No rear yard
    is required there (ZR 23-344, 33-301, 43-311)."""
    groups = [lines for lines in streets.values() if lines]
    found = []
    for i, a in enumerate(groups):
        for b in groups[i + 1:]:
            if unary_union(a).distance(unary_union(b)) > LINE_TOLERANCE:
                continue
            na, nb = outward(max(a, key=lambda l: l.length)), outward(max(b, key=lambda l: l.length))
            # The interior angle is 180 degrees less the angle between the outward normals.
            if na[0] * nb[0] + na[1] * nb[1] <= COS_45 + 1e-9:
                found.append(band(a, feet, lot).intersection(band(b, feet, lot)))
    return unary_union(found) if found else assemble.EMPTY


EQUIVALENT_PLACES = {'midway': 'midway between the street lines', 'street_lines': 'along the street lines', 'side_lot_lines': 'along the side lot lines'}


def rear_yard_equivalent(lines, depth, lot, place):
    """The rear yard equivalent's open area (ZR 23-343(c)): midway between the street lines, or, where
    the text allows, open areas along both street lines of the same combined depth, or half the depth
    along each side lot line."""
    streets, _, sides = lines
    if place == 'street_lines':
        return unary_union([band(streets.get('front') or [], depth / 2, lot), band(streets.get('rear') or [], depth / 2, lot)])
    if place == 'side_lot_lines':
        return band(sides, depth / 2, lot)
    return midway_strip(streets, depth, lot)


def midway_strip(streets, depth, lot):
    """Rear yard equivalent on a through lot: a strip of the required depth midway between the
    front and rear street lines (ZR 23-343, 43-28)."""
    near, far = unary_union(streets.get('front') or []), unary_union(streets.get('rear') or [])
    if near.is_empty or far.is_empty or depth <= 0:
        return assemble.EMPTY
    lot_depth = near.distance(far)
    strip = near.buffer((lot_depth + depth) / 2, cap_style='flat').difference(near.buffer((lot_depth - depth) / 2, cap_style='flat'))
    return strip.intersection(lot)


def trim_to_area(geometry, max_area):
    """Cut from the rear (largest z) until the area is at most max_area, keeping the street side."""
    if geometry.is_empty or geometry.area <= max_area + 1e-6:
        return geometry
    minx, minz, maxx, maxz = geometry.bounds
    lo, hi = minz, maxz
    for _ in range(48):
        mid = (lo + hi) / 2
        if geometry.intersection(box(minx - 1, minz - 1, maxx + 1, mid)).area > max_area:
            hi = mid
        else:
            lo = mid
    return geometry.intersection(box(minx - 1, minz - 1, maxx + 1, lo))


def trim_to_dimension(geometry, max_dimension):
    """Shrink the bounding box in proportion until its diagonal fits, keeping the street side and
    centring across the frontage (ZR 91-34), as the envelope does."""
    minx, minz, maxx, maxz = geometry.bounds
    width, depth = maxx - minx, maxz - minz
    diagonal = (width ** 2 + depth ** 2) ** 0.5
    if diagonal <= max_dimension:
        return geometry
    scale, centre = max_dimension / diagonal, (minx + maxx) / 2
    return geometry.intersection(box(centre - width * scale / 2, minz, centre + width * scale / 2, minz + depth * scale))


def clean(geometry):
    return geometry.buffer(-HAIRLINE, join_style='mitre').buffer(HAIRLINE, join_style='mitre')


def outline(lot, lines, shaped_by, lot_area=None, equivalent='midway'):
    """The storey's buildable outline. Coverage caps are shares of lot_area, the lot area on record
    (the export's lot.areaSqft); without it, of the polygon's own area."""
    lot_area = lot_area or lot.area
    streets, rears, sides = lines
    street_lines = [line for group in streets.values() for line in group]
    open_areas = []
    geometry = lot
    for c in shaped_by:
        kind = c['control']
        if kind == 'rear_yard':
            yard = band(rears, c['feet'], lot)
            open_areas.append(yard.difference(corner_portions(lot, streets, c['cornerPortionFeet'])) if c.get('cornerPortionFeet') else yard)
        elif kind == 'rear_yard_equivalent':
            open_areas.append(rear_yard_equivalent(lines, c['feet'], lot, equivalent))
        elif kind == 'front_yard':
            open_areas.append(band(street_lines, c['feet'], lot))
        elif kind == 'side_yard':
            open_areas.append(band(sides, c['feet'], lot))
        elif kind == 'setback':
            open_areas += [band(streets.get(side, []), feet, lot) for side, feet in c['feet'].items()]
    open_areas = [g for g in open_areas if not g.is_empty]
    if open_areas:
        geometry = clean(assemble.minus(geometry, unary_union(open_areas)))
    for c in shaped_by:
        if c['control'] == 'lot_coverage':
            geometry = trim_to_area(geometry, lot_area * c['percent'] / 100)
        elif c['control'] == 'max_area':
            geometry = trim_to_area(geometry, c['areaSqft'])
        elif c['control'] == 'max_dimension':
            geometry = trim_to_dimension(geometry, c['feet'])
    return geometry


def street_region(lot, lines, spec):
    """The lot within, or beyond, withinFeet of the named street lines (ZR 23-22 and 23-432 notes)."""
    streets = lines[0]
    near = unary_union([band(streets.get(side) or [], spec['withinFeet'], lot) for side in spec['sides']])
    return near.intersection(lot) if spec['inside'] else assemble.minus(lot, near)


def portion_regions(site, lot, lines):
    """The part of the lot each of the export's portions governs (ZR 77-27, 77-28): a wide-street
    portion, or a zoning district's mapped part, itself split by a wide-street portion where it has one.
    The few square feet the zoning map and the tax lot disagree on go to the largest district."""
    out = []
    for p in site['portions']:
        if p['kind'] == 'district':
            mapped = unary_union([Polygon(q['exterior'], q['holes']).buffer(0) for q in p['parts']]).intersection(lot)
            out.append(street_region(mapped, lines, p['inner']) if p.get('inner') else mapped)
        else:
            out.append(street_region(lot, lines, p))
    if site['portions'][0]['kind'] == 'district':
        left = assemble.minus(lot, unary_union(out))
        first = [i for i, p in enumerate(site['portions']) if p['district'] == site['portions'][0]['district']]
        out[first[0]] = unary_union([out[first[0]], left])
    return out


def portion_region(lot, lines, portion):
    """One wide-street portion's region (kept for callers outside a whole export)."""
    return street_region(lot, lines, portion)


def storey_geometry(site, lot, lines, shaped_by, equivalent='midway'):
    """A storey's buildable outline. Where the export divides the lot into portions under different rules,
    each portion is drawn under its own yards, setbacks and street walls within its own region and the
    parts are joined; lot coverage is then the area-weighted share of the whole lot (ZR 77-24)."""
    portions = site.get('portions')
    if not portions:
        return outline(lot, lines, shaped_by, site['lot']['areaSqft'], equivalent)
    scale = site['lot']['areaSqft'] / lot.area
    parts, covered = [], 0
    for p, region in zip(portions, portion_regions(site, lot, lines)):
        percent = [c['percent'] for c in shaped_by if c.get('portion') == p['index'] and c['control'] == 'lot_coverage']
        percent = percent or [c['percent'] for s in site['storeys'] for c in s['shapedBy'] if c.get('portion') == p['index'] and c['control'] == 'lot_coverage'] or [100]
        covered += region.area * scale * percent[0] / 100
        controls = [c for c in shaped_by if c.get('portion') == p['index'] and c['control'] != 'lot_coverage']
        if controls:
            parts.append(outline(region, lines, controls, region.area * scale, equivalent))
    geometry = trim_to_area(clean(unary_union(parts)), covered) if parts else assemble.EMPTY
    # Controls without a portion (the partial top storey's floor area cap) apply to the joined storey.
    for c in shaped_by:
        if 'portion' not in c and c['control'] == 'max_area':
            geometry = trim_to_area(geometry, c['areaSqft'])
    return geometry


def court_checks(geometry, lot, courts):
    """Every open area the outline encloses on all sides is an inner court; it is measured against
    the minimum for courts that legally required windows face (ZR 23-352). Outer courts follow."""
    if not courts:
        return []
    spec = courts['inner']['withWindows']
    found, _ = assemble.courts(geometry, lot, spec)
    inner = [{'kind': 'inner', **c, 'minAreaSqft': spec['minAreaSqft'], 'minDimensionFeet': spec['minDimensionFeet'], 'section': courts['inner']['section']} for c in found]
    return inner + outer_courts(geometry, lot, courts)


def outer_courts(geometry, lot, courts):
    """Outer courts (ZR 12-10): the notches between a plate and its convex hull, on the zoning lot, that
    its walls wrap on three sides (each end wall within 45 degrees of square to the opening). The width
    is the least dimension parallel to the opening, the depth the greatest distance from the opening;
    the part perpendiculars from the opening cannot reach is a recess. Measured against the rule for
    courts legally required windows face (ZR 23-353): width at least the depth, or any depth once the
    court is 20 ft wide (30 ft above 75 ft); a recess at least as wide as it is deep. An open corner,
    wrapped on two sides only, has no width to measure this way and is left out."""
    min_width = courts['outer']['withWindows']['minWidthFeet']
    out = []
    for part in parts(geometry):
        hull = part.convex_hull
        for notch in parts(hull.difference(part).intersection(lot)):
            if notch.area < 25:
                continue
            edge = [l for l in line_pieces(notch.exterior.intersection(hull.exterior.buffer(0.05))) if l.length >= 1]
            if not edge:
                continue
            opening = LineString(max(edge, key=lambda l: l.length).boundary.geoms)
            if not wrapped_on_three_sides(notch, opening):
                continue
            ux, uz = assemble.unit(opening)
            nx, nz = -uz, ux
            (ax, az), (bx, bz) = opening.coords
            inside = notch.representative_point()
            if (inside.x - ax) * nx + (inside.y - az) * nz < 0:
                nx, nz = -nx, -nz
            depth = max((x - ax) * nx + (z - az) * nz for x, z in notch.exterior.coords)
            # What lines square to the opening reach; the rest of the notch is a recess.
            swept = Polygon([(ax, az), (bx, bz), (bx + nx * (depth + 1), bz + nz * (depth + 1)), (ax + nx * (depth + 1), az + nz * (depth + 1))])
            covered = swept.intersection(notch)
            steps = [depth * (k + 0.5) / 12 for k in range(12)]
            far = opening.length + 2 * depth + 10
            slice_at = lambda t: LineString([(ax + nx * t - ux * far, az + nz * t - uz * far), (ax + nx * t + ux * far, az + nz * t + uz * far)])
            width = min(max((l.length for l in line_pieces(slice_at(t).intersection(covered))), default=0) for t in steps)
            recesses = [r for r in parts(assemble.minus(notch, covered.buffer(0.01))) if r.area >= 10]
            recess_ok = all(recess_passes(r, covered) for r in recesses)
            out.append({'kind': 'outer', 'areaSqft': round(notch.area), 'widthFeet': round(width, 1), 'depthFeet': round(depth, 1), 'minWidthFeet': min_width,
                        'recessSqft': round(sum(r.area for r in recesses)), 'pass': (width >= depth - 0.1 or width >= min_width - 0.1) and recess_ok,
                        'section': courts['outer']['section']})
    return out


def line_pieces(geometry):
    if geometry.is_empty:
        return []
    if isinstance(geometry, LineString):
        return [geometry]
    return [g for g in getattr(geometry, 'geoms', []) for g in line_pieces(g)] if hasattr(geometry, 'geoms') else []


def wrapped_on_three_sides(notch, opening):
    """Both walls that meet the opening run within 45 degrees of square to it."""
    ux, uz = assemble.unit(opening)
    ends = [Point(p) for p in opening.coords]
    walls = [LineString(pair) for pair in zip(notch.exterior.coords[:-1], notch.exterior.coords[1:])]
    for end in ends:
        touching = [w for w in walls if w.distance(end) < 0.1 and w.length >= 0.5 and abs(abs(assemble.unit(w)[0] * ux + assemble.unit(w)[1] * uz) - 1) > 1e-3]
        if not touching or not any(abs(assemble.unit(w)[0] * ux + assemble.unit(w)[1] * uz) <= COS_45 for w in touching):
            return False
    return True


def recess_passes(recess, court):
    """An outer court recess at least as wide, along its mouth on the court, as it is deep from it (ZR 23-353)."""
    mouth = [l for l in line_pieces(recess.exterior.intersection(court.buffer(0.05).exterior.buffer(0.1))) if l.length >= 0.5]
    width = sum(l.length for l in mouth)
    depth = max((Point(p).distance(unary_union(mouth)) for p in recess.exterior.coords), default=0) if mouth else 0
    return width >= depth - 0.1


def storey_outlines(site):
    if not isinstance(site, dict) or site.get('schema') != SCHEMA:
        raise ValueError(f'storey_outlines needs an {SCHEMA} export from the zoning envelope.')
    lot = lot_polygon(site['lot'])
    lines = lot_lines(lot, [s['side'] for s in site['streets']])
    source = site['lot']['source']
    equivalent = equivalent_place(site, lot, lines)
    if 'reserveStoreys' in site:
        return filled(site, lot, lines, equivalent)
    out = []
    for s in site['storeys']:
        geometry = storey_geometry(site, lot, lines, s['shapedBy'], equivalent or 'midway')
        out.append(StoreyOutline(
            s['index'], s['label'], s['use'], s['bottomFeet'], s['topFeet'], s['heightFeet'], geometry,
            s['zfaBudgetSqft'], s['grossBudgetSqft'], s['shapedBy'], s.get('courts'), court_checks(geometry, lot, s.get('courts')), source, equivalent,
        ))
    return out


def filled(site, lot, lines, equivalent):
    """The storeys that hold the option's floor area on the exact outlines: each storey takes what its
    yards, setbacks and coverage allow on the lot polygon, the envelope's reserve storeys are added while
    the axis-aligned stack's floor area is not yet held, and the last storey keeps only the remainder.
    The stack can end lower than the envelope's where the polygon holds more, or rise where exact yards
    hold less (an irregular lot), within the height limit the reserves carry."""
    target = sum(s['grossBudgetSqft'] for s in site['storeys'])
    per_zfa = site['floorArea']['grossPerZfa']
    out, held = [], 0.0
    for s in site['storeys'] + site['reserveStoreys']:
        if held >= target - 1:
            break
        shaped = [c for c in s['shapedBy'] if c['control'] != 'max_area']
        geometry = storey_geometry(site, lot, lines, shaped, equivalent or 'midway')
        if geometry.area < 1:
            break
        label = s['label'].replace(' (partial)', '')
        if held + geometry.area > target + 1:
            remainder = target - held
            geometry = trim_to_area(geometry, remainder)
            shaped = shaped + [{'control': 'max_area', 'areaSqft': round(remainder), 'section': site['floorArea']['sections'][0], 'text': f'partial storey holding the last {round(remainder)} sq ft of the floor area'}]
            label += ' (partial)'
        out.append(StoreyOutline(
            s['index'], label, s['use'], s['bottomFeet'], s['topFeet'], s['heightFeet'], geometry,
            round(geometry.area / per_zfa), round(geometry.area), shaped, s.get('courts'), court_checks(geometry, lot, s.get('courts')), site['lot']['source'], equivalent,
        ))
        held += geometry.area
    return out


def equivalent_place(site, lot, lines):
    """One place for a through lot's rear yard equivalent, for the whole building (it is open to the sky):
    midway, unless an alternative the export allows holds more floor area over all storeys."""
    controls = [c for s in site['storeys'] for c in s['shapedBy'] if c['control'] == 'rear_yard_equivalent']
    if not controls:
        return None
    places = ['midway'] + controls[0].get('alternatives', [])
    held = {place: sum(storey_geometry(site, lot, lines, s['shapedBy'], place).area for s in site['storeys']) for place in places}
    best = max(places, key=lambda place: held[place])
    return best if held[best] > held['midway'] + 1 else 'midway'


def outline_note(site):
    return RECTANGLE_NOTE if site['lot']['source'] == 'rectangle' else 'Outlines are drawn on the tax-lot polygon from the city\'s tax map, not a survey.'
