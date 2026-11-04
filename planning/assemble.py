"""JSON stdin/stdout lot assembly for acres_assemble_site.

Request: {"parcels": [{"bbl": str, "polygons": [{"polygon": [[x, z], ...], "holes": []}, ...]}, ...]} with every ring
already projected into one local frame in feet (x east, z south). Response: the union outline(s), areas, and
pairwise contiguity (distance and shared boundary length). A 0.4 ft buffer round-trip closes
GIS slivers between separately digitized tax lots; anything wider stays a real gap.

With "openAreas" ({"streets": ["south", ...], "bands": [{"fromFeet", "toFeet", "rearYardFeet",
"rearYardEquivalentFeet", "frontYardFeet", "sideYardFeet", "court": {"minAreaSqft", "minDimensionFeet"} | null}],
"rearYardEquivalentMinLotDepthFeet"}) the response also carries the open areas the zoning requires on the
merged geometry, holes and separate parts included, and the buildable footprint left in each height band.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.validation import explain_validity

TOLERANCE_FT = 0.4
LINE_TOLERANCE_FT = 0.5
HAIRLINE_FT = 0.05
# Compass sides in the local frame: x east, z south.
SIDES = {'north': (0.0, -1.0), 'south': (0.0, 1.0), 'east': (1.0, 0.0), 'west': (-1.0, 0.0)}
OPPOSITE = (('north', 'south'), ('east', 'west'))
COS_45 = 0.70710678
# ZR 12-10: only the part of a corner lot within this distance of the intersection is a corner lot.
CORNER_LOT_FEET = 100
EMPTY = Polygon()


def parcel_geometry(parts):
    polygons = []
    for part in parts:
        polygon = Polygon(part['polygon'], part['holes'])
        if not polygon.is_valid:
            raise ValueError(f'Invalid parcel polygon: {explain_validity(polygon)}')
        if not polygon.is_empty:
            polygons.append(polygon)
    if not polygons:
        raise ValueError('a parcel has no usable polygon')
    return unary_union(polygons)


def ring_of(ring):
    return [[round(x, 1), round(z, 1)] for x, z in ring.coords]


def polygons_of(geometry):
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    return [g for g in getattr(geometry, 'geoms', []) if isinstance(g, Polygon) and not g.is_empty]


def part_of(geometry):
    return {'polygon': ring_of(geometry.exterior), 'holes': [ring_of(hole) for hole in geometry.interiors], 'areaSqft': round(geometry.area)}


def unit(line):
    (x1, z1), (x2, z2) = line.coords
    return ((x2 - x1) / line.length, (z2 - z1) / line.length)


def edges(ring):
    coords = list(ring.coords)
    lines = (LineString([a, b]) for a, b in zip(coords, coords[1:]))
    return [line for line in lines if line.length > 1e-6]


def lot_lines(parts, streets):
    """Front lot lines are edges on the part's convex hull facing a street side (outward normal within
    45 degrees). Rear lot lines follow ZR 12-10: any other lot line within 45 degrees of parallel to a
    street line and not meeting one, the lines around land the assembly encloses included. The rest
    are side lot lines."""
    fronts, others = [], []
    for part in parts:
        # Simplifying merges the collinear pieces the sliver tolerance splits a lot line into.
        oriented = orient(part.simplify(HAIRLINE_FT), 1.0)
        hull = oriented.convex_hull.exterior.buffer(LINE_TOLERANCE_FT)
        for line in edges(oriented.exterior):
            dx, dz = unit(line)
            side = next((s for s in streets if dz * SIDES[s][0] - dx * SIDES[s][1] >= COS_45), None)
            if side and hull.contains(line):
                fronts.append((side, line))
            else:
                others.append(line)
        others.extend(line for hole in oriented.interiors for line in edges(hole))
    for street in streets:
        if not any(side == street for side, _ in fronts):
            raise ValueError(f'no lot line of the assembly faces the {street} street; check the street sides')
    front_union = unary_union([line for _, line in fronts])
    rears, sides = [], []
    for line in others:
        dx, dz = unit(line)
        parallel = any(abs(dx * fx + dz * fz) >= COS_45 for fx, fz in (unit(f) for _, f in fronts))
        # Sub-foot edges are corner artifacts of the sliver tolerance, not lot lines of their own.
        (rears if parallel and line.length >= 1 and line.distance(front_union) > LINE_TOLERANCE_FT else sides).append(line)
    return fronts, rears, sides


def minus(a, b):
    return a if a.is_empty or b.is_empty else a.difference(b)


def band_of(lines, depth, lot):
    if depth <= 0 or not lines:
        return EMPTY
    return unary_union([line.buffer(depth, cap_style='flat') for line in lines]).intersection(lot)


def corner_interior_rears(lot, fronts, rears, sides, depth):
    """A portion of a corner lot more than 100 ft from every street it does not front along is an interior lot
    of the street it fronts: its rear yard runs along the lot lines parallel to that street's, there."""
    opposite = {a: b for pair in OPPOSITE for a, b in (pair, pair[::-1])}
    yards = []
    for street in dict.fromkeys(side for side, _ in fronts):
        crossing = [line for side, line in fronts if side not in (street, opposite[street])]
        if not crossing or depth <= 0:
            continue
        interior = minus(lot, unary_union([line.buffer(CORNER_LOT_FEET, cap_style='flat') for line in crossing]))
        interior = interior.buffer(-HAIRLINE_FT, join_style='mitre').buffer(HAIRLINE_FT, join_style='mitre')
        if interior.is_empty:
            continue
        directions = [unit(line) for side, line in fronts if side == street]
        backs = [line for line in rears + sides if any(abs(unit(line)[0] * fx + unit(line)[1] * fz) >= COS_45 for fx, fz in directions)]
        yards.append(band_of(backs, depth, interior))
    return unary_union(yards) if yards else EMPTY


def rear_yard_equivalent(parts, fronts, depth, min_lot_depth):
    """Through portions (street lines on opposite sides of one part) keep a strip of the required depth
    midway between the street lines open."""
    strips = []
    for part in parts:
        for a, b in OPPOSITE:
            near = unary_union([line for side, line in fronts if side == a and line.distance(part) <= LINE_TOLERANCE_FT])
            far = unary_union([line for side, line in fronts if side == b and line.distance(part) <= LINE_TOLERANCE_FT])
            if near.is_empty or far.is_empty or depth <= 0:
                continue
            lot_depth = near.distance(far)
            if lot_depth < min_lot_depth:
                continue
            strip = near.buffer((lot_depth + depth) / 2, cap_style='flat').difference(near.buffer((lot_depth - depth) / 2, cap_style='flat'))
            strips.append(strip.intersection(part))
    return unary_union(strips) if strips else EMPTY


def short_side(geometry):
    rect = list(geometry.minimum_rotated_rectangle.exterior.coords)
    return min(LineString(rect[i:i + 2]).length for i in range(2))


def courts(footprint, lot, spec):
    """Every open area the footprint encloses on all sides is an inner court. One below the minimum
    area or dimension is widened into the footprint, evenly on all sides, until it meets both."""
    out, removed = [], []
    for polygon in polygons_of(footprint):
        for interior in polygon.interiors:
            court = Polygon(interior)
            if court.area < 1:
                continue
            area, dimension = court.area, short_side(court)
            grown = court
            if area < spec['minAreaSqft'] or dimension < spec['minDimensionFeet'] - 1e-6:
                k = max(0.0, (spec['minDimensionFeet'] - dimension) / 2)
                grown = court.buffer(k, join_style='mitre')
                while grown.area < spec['minAreaSqft']:
                    k += 0.5
                    grown = court.buffer(k, join_style='mitre')
                removed.append(grown)
            out.append({
                'areaSqft': round(area), 'minDimensionFeet': round(dimension, 1),
                'meetsMinimum': grown is court, 'widenedToSqft': round(grown.area),
                'landOutsideAssemblySqft': round(court.difference(lot).area),
            })
    remaining = minus(footprint, unary_union(removed)) if removed else footprint
    return out, remaining


def open_areas(lot, spec):
    parts = polygons_of(lot)
    streets = list(dict.fromkeys(spec['streets']))
    fronts, rears, sides = lot_lines(parts, streets)
    bands = []
    for band in spec['bands']:
        rear_yard = unary_union([band_of(rears, band['rearYardFeet'], lot), corner_interior_rears(lot, fronts, rears, sides, band['rearYardFeet'])])
        equivalent = minus(rear_yard_equivalent(parts, fronts, band['rearYardEquivalentFeet'], spec['rearYardEquivalentMinLotDepthFeet']), rear_yard)
        yards = [g for g in (rear_yard, equivalent, band_of([line for _, line in fronts], band.get('frontYardFeet', 0), lot), band_of(sides, band.get('sideYardFeet', 0), lot)) if not g.is_empty]
        footprint = minus(lot, unary_union(yards)) if yards else lot
        # Drop hairline slivers the sliver tolerance leaves along yard edges, keeping square corners.
        footprint = footprint.buffer(-HAIRLINE_FT, join_style='mitre').buffer(HAIRLINE_FT, join_style='mitre')
        court_list, footprint = courts(footprint, lot, band['court']) if band.get('court') else ([], footprint)
        footprint_parts = sorted((part_of(g) for g in polygons_of(footprint) if g.area >= 1), key=lambda part: -part['areaSqft'])
        bands.append({
            'fromFeet': band['fromFeet'], 'toFeet': band['toFeet'],
            'rearYardFeet': band['rearYardFeet'], 'rearYardEquivalentFeet': band['rearYardEquivalentFeet'],
            'rearYardAreaSqft': round(rear_yard.area), 'rearYardEquivalentAreaSqft': round(equivalent.area),
            'openAreaSqft': round(lot.area - sum(part['areaSqft'] for part in footprint_parts)),
            'footprintAreaSqft': sum(part['areaSqft'] for part in footprint_parts),
            'footprint': footprint_parts,
            'courts': court_list,
        })
    length = lambda lines: round(sum(line.length for line in lines), 1)
    return {
        'streets': streets,
        'lotLines': {
            'frontFeet': {street: length([line for side, line in fronts if side == street]) for street in streets},
            'rearFeet': length(rears), 'sideFeet': length(sides),
        },
        'bands': bands,
    }


def assemble(request):
    parcels = [(p['bbl'], parcel_geometry(p['polygons'])) for p in request['parcels']]
    if len(parcels) < 2:
        raise ValueError('assembly needs at least two parcels')
    buffered = [geometry.buffer(TOLERANCE_FT) for _, geometry in parcels]
    union = unary_union(buffered).buffer(-TOLERANCE_FT)
    # Close digitization slivers without filling interior voids from the exact union.
    # Selected islands inside a void remain land; another selected parcel can fill it.
    exact = unary_union([geometry for _, geometry in parcels])
    exact_parts = list(exact.geoms) if isinstance(exact, MultiPolygon) else [exact]
    voids = [Polygon(interior) for part in exact_parts for interior in part.interiors]
    if voids:
        union = union.difference(unary_union(voids).difference(exact))
    geoms = list(union.geoms) if isinstance(union, MultiPolygon) else [union]
    parts = sorted((part_of(g) for g in geoms if not g.is_empty), key=lambda part: -part['areaSqft'])
    pairs = []
    for i, (bbl_a, a) in enumerate(parcels):
        for bbl_b, b in parcels[i + 1:]:
            shared = a.boundary.intersection(b.boundary.buffer(2 * TOLERANCE_FT)).length
            pairs.append({
                'a': bbl_a, 'b': bbl_b,
                'distanceFeet': round(a.distance(b), 1),
                'sharedBoundaryFeet': round(shared, 1),
                'touches': shared >= 1.0,
            })
    out = {
        'parts': parts,
        'totalAreaSqft': round(sum(part['areaSqft'] for part in parts)),
        'singlePolygon': len(parts) == 1,
        'toleranceFeet': 2 * TOLERANCE_FT,
        'pairs': pairs,
    }
    if request.get('openAreas'):
        out['openAreas'] = open_areas(union, request['openAreas'])
    return out


if __name__ == '__main__':
    try:
        json.dump(assemble(json.load(sys.stdin)), sys.stdout)
    except Exception as error:  # the caller surfaces this message to the model
        json.dump({'error': f'{type(error).__name__}: {error}'}, sys.stdout)
        sys.exit(1)
