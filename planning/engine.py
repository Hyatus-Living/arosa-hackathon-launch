"""Planning engine: lot + zoning envelope + unit mix + rules -> per-storey plans and takeoffs.

Geometry is in feet in the acres_model_concept frame: x along the street frontage, z into the
lot, street at z = 0. Every storey gets a double-loaded corridor along its long axis, a stair at
each corridor end, an elevator core at mid-plate on one side, and units filling the two bands
between corridor and facade. Rules carry their citations; README.md lists the sources.
"""
from collections import Counter
from dataclasses import dataclass, field
from math import floor, hypot, isfinite

from shapely.geometry import MultiPolygon, Polygon, box
from shapely.ops import unary_union

import outlines as outline_source


@dataclass
class UnitType:
    name: str
    share: float          # fraction of the unit count
    target_sqft: float    # net area the layout aims for


@dataclass
class Storey:
    label: str
    use: str              # residential | office | retail | parking | amenity
    outline: list         # [(x, z)] feet
    height: float         # floor to floor, feet
    count: int = 1
    below_grade: bool = False


@dataclass
class Rules:
    corridor_width: float = 5.5    # ft; NYC BC 2022 Table 1020.2 minimum is 44 in, 5'6" is market practice
    core_width: float = 30.0       # ft along the corridor: elevators, shafts, trash, electrical
    core_depth: float = 22.0       # ft across, on one side of the corridor
    stair_width: float = 12.0      # ft along the corridor, one stair at each corridor end
    stair_depth: float = 22.0      # ft across the corridor
    min_unit_width: float = 14.0   # ft; HMC 27-2074 wants an 8 ft least dimension per living room
    max_unit_depth: float = 40.0   # ft facade to corridor wall, a daylight and layout limit
    exits_required: int = 2        # BC 1006.3.2 allows one exit only for R-2 <= 4 storeys, <= 3 DU/storey, <= 2,500 sf/storey
    max_travel_ft: dict = field(default_factory=lambda: {'residential': 200, 'amenity': 200, 'retail': 200, 'office': 300, 'parking': 250})  # BC Table 1017.2, sprinklered: R and M 200, B 300, S-2 250
    max_common_path_ft: float = 125  # BC Table 1006.2.1, R-2 sprinklered
    max_dead_end_ft: float = 40      # BC 1020.4 exception 4, Group R-2
    exit_separation: float = 1 / 3   # BC 1007.1.1 exception 2, sprinklered: one third of the diagonal
    parking_sqft_per_stall: float = 300  # ZR 25-62, including aisles; a stall is at least 8'6" x 18'
    ramp_sqft: float = 24 * 60
    manhattan_core_share: float = 0.20   # ZR 13-11, Community Districts 1 to 6: <= 20% of new units or 200 spaces
    manhattan_core_cap: int = 200
    dwelling_unit_factor: float = 680    # ZR 23-52


@dataclass
class Space:
    kind: str             # unit | corridor | core | stair | lobby | ramp | parking | common
    name: str
    polygon: list         # [[x, z]] feet, exterior ring
    area_sqft: float
    unit_type: str | None = None


@dataclass
class StoreyPlan:
    index: int
    label: str
    use: str
    elevation: float
    height: float
    outline: list
    spaces: list
    metrics: dict
    checks: list


def storey_outlines(site):
    """The buildable outline of every storey of one option, the floor plates layouts are drawn in.

    site is the option's acres.outlines/1 export (acres-research/envelope.mjs storeyOutlines): the lot
    ring and holes in feet in this frame, and per storey the yards, setbacks, street wall, coverage and
    area caps that shaped it and its zoning floor area budget. Returns [outlines.StoreyOutline], each
    with .geometry (a shapely Polygon or MultiPolygon, holes kept), .polygons ([{exterior, holes}]),
    .zfa_budget, .gross_budget, .shaped_by, .courts, .court_checks, .bottom, .top, .height, .use and
    .source: "tax-lot", or "rectangle" when no lot polygon exists and the frontage-by-depth rectangle
    stands in (outlines.outline_note(site) says so for the plan's report).
    """
    return outline_source.storey_outlines(site)


ENVELOPE_USES = {'light industrial or office': 'office'}


def storeys_from_outlines(outlines):
    """Engine storeys from storey outlines, identical consecutive outlines grouped into one storey with a
    count. Each storey takes the outline's largest part, without holes."""
    out = []
    for o in outlines:
        largest = outline_source.parts(o.geometry)[0]
        footprint = outline_source.ring_of(largest.exterior)
        use = ENVELOPE_USES.get(o.use, o.use)
        if out and out[-1].outline == footprint and out[-1].use == use and out[-1].height == o.height:
            out[-1].count += 1
        else:
            out.append(Storey(o.label, use, footprint, o.height))
    return out


def ring(poly):
    return [[round(x, 2), round(z, 2)] for x, z in list(poly.exterior.coords)[:-1]]


def pieces(geom, min_sqft=1.0):
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    return [p for p in polys if isinstance(p, Polygon) and p.area >= min_sqft]


class Frame:
    """Long-axis coordinates u (along the corridor) and v (across). Rectangles come back in plan x, z."""

    def __init__(self, poly, rules):
        minx, minz, maxx, maxz = poly.bounds
        self.swap = (maxz - minz) > (maxx - minx)
        self.u0, self.u1, self.v0, self.v1 = (minz, maxz, minx, maxx) if self.swap else (minx, maxx, minz, maxz)
        self.vm = (self.v0 + self.v1) / 2
        self.rules = rules
        self.stairs = [(self.u0, self.u0 + rules.stair_width), (self.u1 - rules.stair_width, self.u1)]
        um = (self.u0 + self.u1) / 2
        self.core = (um - rules.core_width / 2, um + rules.core_width / 2)

    def rect(self, ua, ub, va, vb):
        return box(va, ua, vb, ub) if self.swap else box(ua, va, ub, vb)

    def uv(self, x, z):
        return (z, x) if self.swap else (x, z)

    def stair_rects(self):
        half = self.rules.stair_depth / 2
        return [self.rect(a, b, self.vm - half, self.vm + half) for a, b in self.stairs]

    def core_rect(self):
        lo = self.vm + self.rules.corridor_width / 2
        return self.rect(self.core[0], self.core[1], lo, lo + self.rules.core_depth)

    def fits(self, poly):
        return all(poly.buffer(0.01).contains(r) for r in self.stair_rects() + [self.core_rect()])


def fill_segment(a, b, depth, mix, counter, rules):
    """Pick unit types by largest share deficit until the segment is full, then stretch to fit exactly."""
    length = b - a
    if length < rules.min_unit_width:
        return []
    picks = []
    used = 0.0
    while used < length:
        n = sum(counter.values())
        kind = max(mix, key=lambda t: t.share * (n + 1) - counter[t.name])
        width = max(t_width(kind, depth), rules.min_unit_width)
        if used + width > length and (used + width - length) > width / 2:
            break
        picks.append([kind, width])
        counter[kind.name] += 1
        used += width
    while picks and length / used * min(w for _, w in picks) < rules.min_unit_width:
        kind, width = picks.pop()
        counter[kind.name] -= 1
        used -= width
    if not picks:
        return []
    scale = length / used
    out, u = [], a
    for kind, width in picks:
        out.append((kind, u, u + width * scale))
        u += width * scale
    return out


def t_width(kind, depth):
    return kind.target_sqft / depth


def lay_out(index, storey, elevation, poly, frame, rules, mix, ground):
    cw = rules.corridor_width
    spaces, checks, counter = [], [], Counter()   # the mix is balanced per storey so identical storeys repeat as a typical floor
    stairs = [r.intersection(poly) for r in frame.stair_rects()]
    core = frame.core_rect().intersection(poly)
    obstacles = unary_union(stairs + [core])
    for i, s in enumerate(stairs):
        spaces.append(Space('stair', f'Stair {"AB"[i]}', ring(s), s.area))
    spaces.append(Space('core', 'Core', ring(core), core.area))
    (su0, sv0), (su1, sv1) = frame.uv(*poly.bounds[:2]), frame.uv(*poly.bounds[2:])
    stair_doors = [(a + b) / 2 for a, b in frame.stairs]
    diagonal = hypot(poly.bounds[2] - poly.bounds[0], poly.bounds[3] - poly.bounds[1])
    checks.append(check('exits per storey', len(stairs), rules.exits_required, len(stairs) >= rules.exits_required, 'NYC BC 2022 1006.3.1 and 1006.3.2'))
    checks.append(check('exit separation ft', round(stair_doors[1] - stair_doors[0], 1), round(rules.exit_separation * diagonal, 1), stair_doors[1] - stair_doors[0] >= rules.exit_separation * diagonal, 'NYC BC 2022 1007.1.1 exc. 2 (one third of the diagonal, sprinklered)'))
    units = []
    if storey.use == 'residential':
        corridor = frame.rect(su0, su1, frame.vm - cw / 2, frame.vm + cw / 2).intersection(poly).difference(obstacles)
        spaces.append(Space('corridor', 'Corridor', ring(max(pieces(corridor), key=lambda p: p.area)), corridor.area))
        dead_end = max(0.0, frame.stairs[0][0] - su0, su1 - frame.stairs[1][1])
        checks.append(check('dead end ft', round(dead_end, 1), rules.max_dead_end_ft, dead_end <= rules.max_dead_end_ft, 'NYC BC 2022 1020.4 exc. 4 (R-2, 40 ft)'))
        worst_travel = worst_common = 0.0
        for side in (-1, 1):
            band = (sv0, frame.vm - cw / 2) if side < 0 else (frame.vm + cw / 2, sv1)
            depth = band[1] - band[0]
            checks.append(check(f'unit depth ft side {side}', round(depth, 1), rules.max_unit_depth, depth <= rules.max_unit_depth, 'engine rule: facade to corridor'))
            segments = [(su0, frame.core[0]), (frame.core[1], su1)] if side > 0 else [(su0, su1)]
            for a, b in segments:
                for kind, ua, ub in fill_segment(a, b, depth, mix, counter, rules):
                    geom = frame.rect(ua, ub, *band).intersection(poly).difference(obstacles)
                    geom = max(pieces(geom), key=lambda p: p.area, default=None)
                    if geom is None or geom.area < kind.target_sqft / 2:
                        counter[kind.name] -= 1
                        continue
                    door_u, edge_v = (ua + ub) / 2, band[1] if side < 0 else band[0]
                    in_unit = max(abs(frame.uv(x, z)[0] - door_u) + abs(frame.uv(x, z)[1] - edge_v) for x, z in geom.exterior.coords)
                    beyond = 0.0 if stair_doors[0] <= door_u <= stair_doors[1] else min(abs(door_u - d) for d in stair_doors)
                    worst_travel = max(worst_travel, in_unit + min(abs(door_u - d) for d in stair_doors))
                    worst_common = max(worst_common, in_unit + beyond)
                    units.append(Space('unit', f'{kind.name} {len(units) + 1:02d}', ring(geom), geom.area, kind.name))
        checks.append(check('exit access travel ft', round(worst_travel, 1), rules.max_travel_ft['residential'], worst_travel <= rules.max_travel_ft['residential'], 'NYC BC 2022 Table 1017.2 (R, sprinklered, 200 ft)'))
        checks.append(check('common path ft', round(worst_common, 1), rules.max_common_path_ft, worst_common <= rules.max_common_path_ft, 'NYC BC 2022 Table 1006.2.1 (R-2, sprinklered, 125 ft)'))
        spaces += units
        leftover = poly.difference(unary_union([Polygon(s.polygon) for s in spaces]))
        spaces += [Space('common', 'Common', ring(q), q.area) for q in pieces(leftover, 20)]
    else:
        if ground and frame.stairs[0][0] - su0 >= 10:
            lobby = frame.rect(su0, frame.stairs[0][0], frame.vm - rules.core_width / 2, frame.vm + rules.core_width / 2).intersection(poly)
            spaces.append(Space('lobby', 'Lobby', ring(lobby), lobby.area))
        if storey.use == 'parking':
            lo = frame.vm + cw / 2
            ramp = frame.rect(frame.core[1], frame.core[1] + rules.ramp_sqft / 24, lo, lo + 24).intersection(poly)
            spaces.append(Space('ramp', 'Ramp', ring(ramp), ramp.area))
            stalls_area = poly.difference(unary_union([obstacles, ramp]))
            spaces += [Space('parking', 'Parking', ring(p), p.area) for p in pieces(stalls_area)]
        far_corner = max(min(abs(frame.uv(x, z)[0] - d) + abs(frame.uv(x, z)[1] - frame.vm) for d in stair_doors) for x, z in poly.exterior.coords)
        checks.append(check('exit access travel ft', round(far_corner, 1), rules.max_travel_ft[storey.use], far_corner <= rules.max_travel_ft[storey.use], 'NYC BC 2022 Table 1017.2 (sprinklered)'))
    gross = poly.area
    net = sum(s.area_sqft for s in spaces if s.kind in ('unit', 'parking')) if storey.use in ('residential', 'parking') else gross - sum(s.area_sqft for s in spaces if s.kind in ('stair', 'core', 'lobby'))
    metrics = {'grossSqft': round(gross), 'netSqft': round(net), 'efficiency': round(net / gross, 3), 'units': len(units), 'unitsByType': dict(Counter(u.unit_type for u in units))}
    if storey.use == 'parking':
        metrics['stalls'] = floor(net / rules.parking_sqft_per_stall)
    return StoreyPlan(index, storey.label, storey.use, round(elevation, 2), storey.height, ring(poly), spaces, metrics, checks)


def check(rule, value, limit, ok, cite):
    return {'rule': rule, 'value': value, 'limit': limit, 'pass': bool(ok), 'cite': cite}


def plan(lot, storeys, mix, rules=Rules(), max_far=None, max_height=None):
    assert abs(sum(t.share for t in mix) - 1) < 1e-6, 'unit mix shares must sum to 1'
    def valid_polygon(points, label):
        if not isinstance(points, list) or len(points) < 3 or any(
            not isinstance(p, (list, tuple)) or len(p) != 2 or any(not isinstance(n, (int, float)) or not isfinite(n) for n in p)
            for p in points
        ):
            raise ValueError(f'{label} needs finite [x, z] points')
        polygon = Polygon(points)
        if not polygon.is_valid or polygon.is_empty or polygon.area <= 1e-6:
            raise ValueError(f'{label} must be a valid non-self-intersecting polygon with positive area')
        return polygon

    lot_poly = valid_polygon(lot, 'Lot')
    if not storeys:
        raise ValueError('Supply at least one storey')
    for s in storeys:
        if type(s.count) is not int or not 1 <= s.count <= 60:
            raise ValueError('Storey count must be an integer from 1 to 60')
        if not isinstance(s.height, (int, float)) or not isfinite(s.height) or not 0 < s.height <= 40:
            raise ValueError('Storey height must be positive and at most 40 feet')
        if not lot_poly.buffer(1e-6).covers(valid_polygon(s.outline, f'Footprint {s.label}')):
            raise ValueError(f'Footprint {s.label} is outside the supplied lot')
    if sum(s.count for s in storeys) > 60:
        raise ValueError('Plan at most 60 storeys')
    expanded = [s for s in storeys for _ in range(s.count)]
    above = [s for s in expanded if not s.below_grade]
    if not above:
        raise ValueError('Supply at least one above-grade storey')
    for label, limit, value in (
        ('modeled gross FAR (not legal zoning floor area)', max_far, sum(Polygon(s.outline).area for s in above) / lot_poly.area),
        ('above-grade height in feet', max_height, sum(s.height for s in above)),
    ):
        if limit is not None:
            if not isinstance(limit, (int, float)) or not isfinite(limit) or limit <= 0:
                raise ValueError(f'The supplied {label} limit must be positive and finite')
            if value > limit + 1e-6:
                raise ValueError(f'The {label} {value:g} exceeds the supplied limit {limit:g}')
    anchor_storey = next((s for s in reversed(above) if s.use == 'residential'), above[-1])
    anchor = Frame(Polygon(anchor_storey.outline), rules)
    plans, elevation = [], 0.0
    for below in [s for s in expanded if s.below_grade]:
        elevation -= below.height
    for i, s in enumerate([s for s in expanded if s.below_grade] + above):
        poly = Polygon(s.outline)
        frame = anchor if anchor.fits(poly) else Frame(poly, rules)
        plans.append(lay_out(i, s, elevation, poly, frame, rules, mix, ground=(elevation == 0)))
        elevation += s.height
    return plans, takeoffs(lot_poly, plans, mix, rules)


def takeoffs(lot_poly, plans, mix, rules):
    above = [p for p in plans if p.elevation >= 0]
    resi = [p for p in plans if p.use == 'residential']
    units = sum(p.metrics['units'] for p in plans)
    by_type = Counter()
    areas = Counter()
    for p in resi:
        for s in p.spaces:
            if s.kind == 'unit':
                by_type[s.unit_type] += 1
                areas[s.unit_type] += s.area_sqft
    gross_above = sum(p.metrics['grossSqft'] for p in above)
    resi_gross = sum(p.metrics['grossSqft'] for p in resi)
    resi_net = sum(p.metrics['netSqft'] for p in resi)
    stalls = sum(p.metrics.get('stalls', 0) for p in plans)
    out = {
        'lotAreaSqft': round(lot_poly.area),
        'storeysAboveGrade': len(above),
        'heightFeet': round(sum(p.height for p in above), 1),
        'grossFloorAreaSqft': gross_above,
        'far': round(gross_above / lot_poly.area, 2),
        'byUse': {use: round(sum(p.metrics['grossSqft'] for p in plans if p.use == use)) for use in dict.fromkeys(p.use for p in plans)},
        'residential': {'grossSqft': resi_gross, 'netRentableSqft': resi_net, 'efficiency': round(resi_net / resi_gross, 3) if resi_gross else None, 'units': units, 'grossSqftPerUnit': round(resi_gross / units) if units else None,
                        'unitsByType': {t.name: {'count': by_type[t.name], 'share': round(by_type[t.name] / units, 3) if units else 0, 'targetShare': t.share, 'avgSqft': round(areas[t.name] / by_type[t.name]) if by_type[t.name] else None, 'targetSqft': t.target_sqft} for t in mix},
                        'dwellingUnitCap': floor(resi_gross / rules.dwelling_unit_factor), 'dwellingUnitCapNote': f'ZR 23-52 factor {rules.dwelling_unit_factor:g} applied to gross residential area as a stand-in for zoning floor area'},
        'parking': {'stallsAchievable': stalls, 'manhattanCoreAsOfRightMax': min(floor(units * rules.manhattan_core_share), rules.manhattan_core_cap), 'note': 'ZR 13-10: no parking is required in the Manhattan Core; ZR 13-11 caps as-of-right accessory spaces at 20% of new units (CD 1 to 6) or 200; ZR 25-62: 300 sq ft per space including aisles'},
        'checks': {'failed': [dict(storey=p.label, **c) for p in plans for c in p.checks if not c['pass']], 'total': sum(len(p.checks) for p in plans)},
        'storeys': [{'label': p.label, 'use': p.use, 'elevationFeet': p.elevation, 'heightFeet': p.height, **p.metrics} for p in plans],
    }
    return out
