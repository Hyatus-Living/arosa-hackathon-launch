"""Code-plausible typical floors for New York multifamily buildings.

A scheme's typical floor is laid out many ways inside the storey's buildable outline, each layout is
checked against the rules that shape a New York plan (RULES, each cited to its section; values that
no section fixes are marked as assumptions), scored, and the best one is returned as an architecture
plan v1 document (architecture.py) with a "why this plan" report.

Geometry is in feet in the acres_model_concept frame: x along the frontage, z into the lot, street
at z = 0. The plan document is in metres with plan x = x and plan y = z, so the street is at the
bottom of the drawing. Every layout is made of wings: a rectangle along one face of the outline in
its own frame (u along the face, v away from it), with a band of units on each face that can take
windows and a corridor or a central core between them. Unit rooms come from templates (unit_rooms)
laid into the bays of each band. Light and air, room sizes and egress are measured on the drawn
polygons after the layout is made, so a layout that misjudges a face is caught by the checks.
"""
import heapq
import re
from dataclasses import dataclass, field
from math import atan2, ceil, cos, hypot, pi, sin

import shapely
import shapely.affinity
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, unary_union

import architecture
import outlines as outline_source
import zoning
from exporters import zd1

FOOT = architecture.FOOT
GRID = 0.01  # ft: room vertices snap to this grid so shared edges coincide exactly


@dataclass(frozen=True)
class Rule:
    id: str
    text: str
    value: float | None
    cite: str
    basis: str = 'law'   # law: a code or zoning section fixes the value; assumption: practice, not a legal threshold


RULES = {r.id: r for r in [
    Rule('light', 'Every habitable room has a window on a street, or on a yard or court that meets the zoning minimums', None, 'MDL 30(2); NYC BC 2022 1205.2.5'),
    Rule('glazing', 'Glazed area of each habitable room at least a tenth of its floor area', 0.10, 'NYC BC 2022 1205.2.1; MDL 30(8)'),
    Rule('window_size', 'Each required window at least 12 sq ft of glazing, its top at least 7 ft above the floor', 12, 'NYC BC 2022 1205.2.1, 1205.2.7.2'),
    Rule('window_distance', 'Legally required windows face at least 20 ft of open space to a wall or lot line', 20, 'ZR 23-372'),
    Rule('room_depth', 'No part of a habitable room more than 30 ft from its window', 30, 'NYC BC 2022 1205.2.4'),
    Rule('living_room', 'One room in each unit of at least 150 sq ft', 150, 'NYC BC 2022 1208.3.2; HMC 27-2074(a)'),
    Rule('room_area', 'Every other habitable room at least 80 sq ft', 80, 'NYC BC 2022 1208.3.1'),
    Rule('room_width', 'Habitable rooms at least 8 ft wide in every direction', 8, 'NYC BC 2022 1208.1'),
    Rule('exits', 'Two exit stairs from each storey', 2, 'NYC BC 2022 1006.3.2'),
    Rule('single_exit', 'One exit stair, allowed for R-2 of Type I or II construction up to 6 storeys and 2,000 sq ft a storey', 6, 'NYC BC 2022 1006.3.2 item 7'),
    Rule('exit_separation', 'Exit doors at least one third of the floor diagonal apart (sprinklered), or 15 ft apart for R-2 stairs in 2-hour masonry enclosures', 1 / 3, 'NYC BC 2022 1007.1.1 exceptions 2 and 3'),
    Rule('dwelling_units', 'Units at most the residential floor area over the dwelling unit factor of 680, fractions of three quarters rounding up', 680, 'ZR 23-52'),
    Rule('floor_area', 'The floor stays within its share of the scheme\'s floor area (its zoning floor area and the floor area excluded from it)', 1.03, 'ZR 12-10 (floor area); the scheme\'s zoning floor area'),
    Rule('floor_area_used', 'The floor holds its share of the scheme\'s zoning floor area, to within 3 percent', 0.97, 'The scheme\'s zoning floor area, which its price rests on', 'assumption'),
    Rule('core_stack', 'Exit stairs, elevator and refuse room stack through every storey', None, 'NYC BC 2022 1023.1 (exit stairways continuous to the level of exit discharge); BC 3002.4'),
    Rule('travel', 'Exit access travel distance at most 200 ft (R-2, sprinklered)', 200, 'NYC BC 2022 Table 1017.2'),
    Rule('common_path', 'Common path of egress travel at most 125 ft (R-2, sprinklered)', 125, 'NYC BC 2022 Table 1006.2.1'),
    Rule('dead_end', 'Dead-end corridors at most 40 ft (R-2)', 40, 'NYC BC 2022 1020.4 exception 4'),
    Rule('corridor_width', 'Corridors at least 44 in wide (36 in for 50 occupants or fewer)', 44 / 12, 'NYC BC 2022 Table 1020.2'),
    Rule('stair_width', 'Exit stairs at least 44 in wide', 44 / 12, 'NYC BC 2022 1011.2'),
    Rule('elevator', 'An elevator serving every floor of a building of 5 or more storeys, with a stretcher car', 5, 'NYC BC 2022 3002.4, 3002.4.2; MDL 51(6)'),
    Rule('type_b', 'Every unit a Type B+NYC unit where an elevator serves it (walk-ups: the entrance storey only)', 1.0, 'NYC BC 2022 1107.6.2.1, 1107.7.4.1'),
    Rule('refuse', 'A refuse chute access room on every storey of a building of 5 or more storeys and 9 or more units', 5, 'NYC BC 2022 1213.3'),
    Rule('refuse_storage', 'Refuse and recycling storage of 1.5 sq ft a unit (1.0 with a compactor), at most 350 sq ft', 1.5, 'NYC BC 2022 1213.1, 1213.2'),
    Rule('bike', 'One enclosed bicycle space for every 2 units, waived at 10 units or fewer, 15 sq ft a space', 0.5, 'ZR 25-811, ZR 25-83'),
    Rule('recreation', 'Recreation space of 3 percent of the residential floor area with 9 or more new units', 0.03, 'ZR 23-63'),
    Rule('rear_yard', 'A 30 ft rear yard on an interior lot narrower than 40 ft (20 ft on wider lots, up to 75 ft high)', 30, 'ZR 23-342'),
    Rule('court', 'An outer court with required windows at least 20 ft wide (30 ft above 75 ft of height)', 20, 'ZR 23-353'),
    Rule('lobby', 'A lobby at grade holding the accessible building entrance', None, 'Practice; the accessible entrance is NYC BC 2022 1105.1', 'assumption'),
    Rule('retail', 'Retail along the street frontage at grade on a commercial overlay', None, 'Practice; ZR 32-31 sets no ground floor use on most C1 and C2 overlays, ZR 32-321 bars units within 30 ft of the street wall in special streetscape areas', 'assumption'),
    Rule('mechanical', 'Cellar mechanical and electrical rooms of about 3 percent of the floor area', 0.03, 'Practice for an all-electric building', 'assumption'),
]}


# Unit template dimensions in feet. Practice values an architect would start from, not legal limits.
@dataclass(frozen=True)
class Template:
    living_min: float = 11.0     # living room width on the window wall
    living_max: float = 20.0
    bedroom_min: float = 9.0     # bedroom width on the window wall (BC 1208.1: 8 ft least dimension)
    bedroom_max: float = 13.0
    zone_min: float = 11.0       # depth of the window zone the bedrooms sit in
    zone_max: float = 15.0
    bath_w: float = 5.5          # a 5 by 8 ft bath with a clear turning space, Type B
    bath_d: float = 8.5
    hall: float = 3.5            # bedroom hall: a 36 in accessible route between walls
    kitchen: float = 6.0         # a one-wall kitchen with its aisle
    closet: float = 2.5
    window_height: float = 5.0   # drawn glazing height, ft
    window_max: float = 6.0      # widest single window drawn


T = Template()
# Core modules (ft): a 44 in two-flight stair at 7 in risers and 11 in treads (BC 1011.5) for a 10 ft
# storey is about 10 by 22 ft inside its walls; an elevator shaft for a stretcher car (BC 3002.4); the
# refuse room and the electrical closet beside it.
CORE = {'stair': (10.0, 22.0), 'elevator': (8.0, 9.0), 'refuse': (8.0, 7.0), 'electric': (8.0, 5.0)}
# A scissor stair: two interlocked 44 in stairs in one 2-hour masonry shaft, its doors at the two ends of
# its long side, which BC 1007.1.1 exception 3 counts as two exits in R-2 when the doors are 15 ft apart.
SCISSOR = (26.0, 10.0)
# A central cluster: modules (length along the hall, depth) packed side by side against the back of the
# middle zone, the hall wrapping in front of them and around both ends.
CLUSTER = {'stair': (CORE['stair'][1], CORE['stair'][0]), 'scissor': SCISSOR, 'elevator': (8.0, 9.0), 'refuse': (6.0, 7.0)}
SERVICE = T.bath_d  # ft of foyer and closets a unit may take behind the 30 ft its rooms reach from a window
FOYER = 8.0  # widest foyer drawn, ft
SPACE = 'Space too small for a unit'  # what a unit that is not whole is drawn as: floor area outside any unit
ENTRY = 3.5  # ft of corridor wall a unit needs for its entrance door
BASES = 4  # base plates carried through every storey before one is kept
AIM = 0.995  # share of the scheme's zoning floor area a corrected drawing aims at, so no storey reads over budget
CORE_KINDS = ('stair', 'elevator', 'refuse', 'electric')  # the rooms that stack through every storey
CORRIDOR = 5.5  # drawn corridor width, ft: 44 in clear (BC Table 1020.2) plus finishes and a wheelchair passing width
STOREY_HEIGHT = 10.0
FIT_RANGE = (0.8, 1.3)   # drawn unit area against the scheme's net size before the floor is called a misfit
BEDS = {'studio': 0, 'oneBedroom': 1, 'twoBedroom': 2, 'threeBedroom': 3}
TYPE_NAMES = {'studio': 'Studio', 'oneBedroom': '1 bedroom', 'twoBedroom': '2 bedroom', 'threeBedroom': '3 bedroom'}


@dataclass
class UnitType:
    name: str          # display name, e.g. "1 bedroom" or "2 bedroom, affordable"
    beds: int
    share: float
    target_sqft: float
    key: str = ''      # the scheme's unit type: studio, oneBedroom, twoBedroom or threeBedroom
    smaller: tuple = field(default=(), repr=False, compare=False)  # the mix's types of its group with fewer bedrooms, largest first


def group(t):
    """What a unit type's name adds to its bedroom type: ", affordable" or nothing."""
    return t.name[len(TYPE_NAMES.get(t.key, t.name)):]


def unit_types(request):
    """The scheme's unit types from request['mix'], their shares summing to one, each with the smaller types of its group."""
    mix = [UnitType(m['name'], BEDS[m['type']], m['share'], m['targetSqft'], m['type']) for m in request['mix']]
    total = sum(t.share for t in mix)
    for t in mix:
        t.share /= total
        t.smaller = tuple(sorted((x for x in mix if x.beds < t.beds and group(x) == group(t)), key=lambda x: -x.beds))
    return mix


# ---------------------------------------------------------------------------------------------
# Unit templates


def min_width(beds, corner=False):
    """The narrowest window wall a unit of this many bedrooms takes."""
    if beds == 0:
        return max(T.living_min, T.bath_w + T.kitchen)
    if corner and beds >= 2:
        return T.living_min + 3.5 + (beds - 2) * T.bedroom_min + T.bedroom_min
    return T.living_min + beds * T.bedroom_min


def min_depth(beds, corner=False):
    return T.bath_d + 6 if beds == 0 else T.zone_min + T.bath_d + (T.hall if beds >= 3 or (beds == 2 and corner) else 0)


def unit_rooms(beds, W, D, corner=False):
    """Rooms of one unit in its own frame: s along the window wall (0 to W), t from the window wall (0)
    to the corridor wall (D). A corner unit has its second exposure on the s = 0 face. Returns
    [(name, kind, Polygon)] with kind living, bedroom, bath, closet or hall, or None when the unit is
    too narrow or shallow for its rooms. The living room includes the kitchen at its back, open to it.
    A unit deeper than a habitable room may reach from its window (30 ft) keeps its rooms within that
    depth and puts a foyer and closets behind them, rooms that need no window, at least a hall deep: a unit
    barely deeper than 30 ft stops its rooms short of it rather than draw a sliver its walls would fill."""
    if W < min_width(beds, corner) - 1e-6 or D < min_depth(beds, corner) - 1e-6:
        return None
    reach = RULES['room_depth'].value
    if D > reach + 0.5:
        front = min(reach, D - T.hall)
        rooms = unit_rooms(beds, W, front, corner)
        return rooms and rooms + service_strip(rooms, W, front, D)
    if beds == 2 and not corner:
        return split_two_bedroom(W, D)
    if beds == 0:
        bath = box(W - T.bath_w, D - T.bath_d, W, D)
        rooms = [('Living and sleeping', 'living', box(0, 0, W, D).difference(bath)), ('Bath', 'bath', bath)]
        return rooms
    service = T.bath_d + (T.hall if beds >= 2 else 0)
    zone = min(T.zone_max, max(T.zone_min, D - service))
    corner_bed = corner and beds >= 2 and D - zone >= T.bedroom_min
    window_beds = beds - (1 if corner_bed else 0)
    # Window wall: the living room first (at the corner, where it takes two exposures), then bedrooms.
    living_floor = T.living_min + (T.bedroom_min - 0.5 if corner_bed else 0)
    spare = W - living_floor - window_beds * T.bedroom_min
    grow_beds = min(spare, window_beds * (T.bedroom_max - T.bedroom_min))
    wb = T.bedroom_min + (grow_beds / window_beds if window_beds else 0)
    wl = W - window_beds * wb
    if wl > T.living_max and window_beds:
        wb = min(T.bedroom_max + 2, (W - T.living_max) / window_beds)
        wl = W - window_beds * wb
    rooms = []
    living = box(0, 0, wl, D)
    if corner_bed:
        bed = box(0, zone, min(wl - 4.0, 12.0), D)
        living = living.difference(bed)
        rooms.append((f'Bedroom {beds}', 'bedroom', bed))
    rooms.insert(0, ('Living and kitchen', 'living', living))
    for i in range(window_beds):
        rooms.append((f'Bedroom {i + 1}' if beds > 1 else 'Bedroom', 'bedroom', box(wl + i * wb, 0, wl + (i + 1) * wb, zone)))
    if window_beds == 0:
        return rooms
    if beds == 1:
        rooms.append(('Bath', 'bath', box(wl, zone, wl + T.bath_w, D)))
        if W - wl - T.bath_w >= T.closet:
            rooms.append(('Closet', 'closet', box(wl + T.bath_w, zone, W, D)))
        else:
            rooms[-1] = ('Bath', 'bath', box(wl, zone, W, D))
        return rooms
    rooms.append(('Hall', 'hall', box(wl, zone, W, zone + T.hall)))
    baths = 1 if beds == 2 and corner_bed else 2
    x = wl
    for i in range(baths):
        right = x + T.bath_w
        if W - right < T.closet:
            right = W
        rooms.append((f'Bath {i + 1}' if baths > 1 else 'Bath', 'bath', box(x, zone + T.hall, right, D)))
        x = right
    if W - x >= T.closet:
        rooms.append(('Closets', 'closet', box(x, zone + T.hall, W, D)))
    return rooms


def service_strip(rooms, W, t0, t1):
    """The strip between t0 and t1 behind a unit's rooms: a foyer behind the living room, which the
    entrance opens into, at most FOYER wide, and closets beside it."""
    living = next(p for _, k, p in rooms if k == 'living')
    edge = living.intersection(LineString([(0, t0 - 0.01), (W, t0 - 0.01)]))
    xa, xb = edge.bounds[0], min(edge.bounds[2], edge.bounds[0] + FOYER)
    out = [('Foyer', 'hall', box(xa, t0, xb, t1))]
    for name, a, b in (('Closet', 0.0, xa), ('Closets', xb, W)):
        if b - a >= T.closet:
            out.append((name, 'closet', box(a, t0, b, t1)))
        elif b - a > 1e-6:
            out[0] = ('Foyer', 'hall', out[0][2].union(box(a, t0, b, t1)))
    return out


def split_two_bedroom(W, D):
    """A two-bedroom with its bedrooms either side of the living room, each with a bath behind it
    opening off the kitchen end of the living room: no hall, so it fits a shallow band."""
    zone = min(T.zone_max, max(T.zone_min, D - T.bath_d))
    spare = W - T.living_min - 2 * T.bedroom_min
    wb = T.bedroom_min + min(spare / 2, T.bedroom_max - T.bedroom_min)
    wl = W - 2 * wb
    rooms = [('Living and kitchen', 'living', box(wb, 0, wb + wl, D)),
             ('Bedroom 1', 'bedroom', box(wb + wl, 0, W, zone)), ('Bedroom 2', 'bedroom', box(0, 0, wb, zone))]
    for name, x0, x1, inner in (('Bath 1', wb + wl, W, wb + wl), ('Bath 2', 0, wb, wb)):
        if x1 - x0 - T.bath_w >= T.closet:
            bath = box(inner, zone, inner + T.bath_w, D) if inner == x0 else box(inner - T.bath_w, zone, inner, D)
            closet = box(x0, zone, x1, D).difference(bath)
            rooms += [(name, 'bath', bath), (name.replace('Bath', 'Closet'), 'closet', closet)]
        else:
            rooms.append((name, 'bath', box(x0, zone, x1, D)))
    return rooms


# ---------------------------------------------------------------------------------------------
# Frames, wings and the site


class Frame:
    """A local frame on a face of the outline: u along the face from origin, v away from it, into the plate."""

    def __init__(self, origin, axis, normal):
        self.o, self.a, self.n = origin, axis, normal

    def pt(self, u, v):
        return (self.o[0] + u * self.a[0] + v * self.n[0], self.o[1] + u * self.a[1] + v * self.n[1])

    def rect(self, u0, u1, v0, v1):
        return Polygon([self.pt(u0, v0), self.pt(u1, v0), self.pt(u1, v1), self.pt(u0, v1)])

    def line(self, u0, v0, u1, v1):
        return LineString([self.pt(u0, v0), self.pt(u1, v1)])

    def local(self, x, z):
        dx, dz = x - self.o[0], z - self.o[1]
        return dx * self.a[0] + dz * self.a[1], dx * self.n[0] + dz * self.n[1]


@dataclass
class Site:
    lot: Polygon
    streets: object          # MultiLineString of the lot edges on a street
    region: Polygon          # where this storey may be built (the zoning outline)
    district: str = ''
    overlay: str = ''
    notes: list = field(default_factory=list)

    def faces(self):
        """Edges of the region with their exposure: street, open (yard or court side) or lot line."""
        ring = list(self.region.exterior.coords)
        out = []
        for p, q in zip(ring, ring[1:]):
            seg = LineString([p, q])
            if seg.length < 1:
                continue
            on_street = seg.buffer(0.5).intersection(self.streets).length >= seg.length * 0.6
            on_lot_line = not on_street and seg.buffer(0.5).intersection(self.lot.exterior).length >= seg.length * 0.6
            out.append((seg, 'street' if on_street else 'lot line' if on_lot_line else 'open'))
        return out


def rectangular_site(front, depth, lot_type='interior', rear_yard=None, district='', overlay=''):
    """A rectangular lot and its region until the zoning outline is supplied: a rear yard is taken off an
    interior lot; corner lots front two streets and through lots two parallel streets."""
    lot = box(0, 0, front, depth)
    streets = [LineString([(0, 0), (front, 0)])]
    notes = []
    region = lot
    if lot_type == 'corner':
        streets.append(LineString([(0, 0), (0, depth)]))
    elif lot_type == 'through':
        streets.append(LineString([(0, depth), (front, depth)]))
    else:
        if rear_yard is None:
            rear_yard = RULES['rear_yard'].value if front < 40 else 20.0
        region = box(0, 0, front, max(depth - rear_yard, 10))
        notes.append(f'A {rear_yard:g} ft rear yard is taken off the lot (ZR 23-342) until the zoning outline is drawn for this storey.')
    return Site(lot, MultiLineString(streets), region, district, overlay, notes)


def polygon_site(lot, streets, region=None, district='', overlay=''):
    lot = Polygon(lot)
    return Site(lot, MultiLineString([LineString(s) for s in streets]), Polygon(region) if region else lot, district, overlay)


def outline_site(export, district='', overlay='', storeys=None):
    """The site from an option's storey outlines (acres.outlines/1, planning/outlines.py): the lot polygon,
    its street lines, and the region the base floor is drawn in, the outline most residential storeys above
    grade share (storeys above a deeper rear yard or behind a setback get plates of their own). Returns
    (site, the region's gross budget in sq ft, the residential storeys as StoreyOutlines)."""
    lot = outline_source.lot_polygon(export['lot'])
    lot_lines = outline_source.lot_lines(lot, [s['side'] for s in export['streets']])
    lines = MultiLineString([LineString(l.coords) for group in lot_lines[0].values() for l in group])
    every = outline_source.storey_outlines(export)
    upper = [o for o in every if o.use == 'residential' and o.bottom > 0 and (storeys is None or o.index < storeys)] or every
    # A storey trimmed only because the option's floor area ran out (max_area) is a budget, which the
    # plate area already answers; the floor must fit the yards, setbacks and coverage, so those are
    # redrawn without the trim.
    for o in upper:
        if any(c['control'] == 'max_area' for c in o.shaped_by):
            o.geometry = outline_source.storey_geometry(export, lot, lot_lines, [c for c in o.shaped_by if c['control'] != 'max_area'], o.equivalent or 'midway')
    groups = {}
    for o in upper:
        groups.setdefault(o.geometry.wkb, []).append(o)
    common = max(groups.values(), key=len)
    region = outline_source.parts(common[0].geometry)[0]
    site = Site(lot, lines, Polygon(region.exterior), export.get('district') or district, overlay, [outline_source.outline_note(export)])
    budgets = [o.gross_budget for o in upper if not any(c['control'] == 'max_area' for c in o.shaped_by)]
    return site, min(budgets) if budgets else region.area, upper


@dataclass
class Bay:
    """A run of a band holding units: wing frame, u from a to b, v from v0 to v1 with windows at v_win."""
    frame: Frame
    a: float
    b: float
    v0: float
    v1: float
    window_at_v0: bool
    corner_a: bool = False
    corner_b: bool = False
    units: list = field(default_factory=list)

    @property
    def length(self):
        return self.b - self.a

    @property
    def depth(self):
        return self.v1 - self.v0


@dataclass
class Draft:
    """One candidate layout before checks: rooms in feet and the egress network."""
    typology: str
    plate: Polygon
    rooms: list = field(default_factory=list)       # dicts: name, kind, poly, unit (index or None), frame
    bays: list = field(default_factory=list)
    corridors: list = field(default_factory=list)   # (Polygon, centreline LineString)
    stairs: list = field(default_factory=list)      # stair room polygons
    elevator: bool = False
    params: dict = field(default_factory=dict)

    def add(self, name, kind, poly, unit=None, frame=None):
        poly = clean(poly)
        if poly is not None:
            self.rooms.append({'name': name, 'kind': kind, 'poly': poly, 'unit': unit, 'frame': frame})
        return poly


def clean(poly, min_area=4.0):
    if poly is None or poly.is_empty:
        return None
    poly = shapely.set_precision(poly, GRID)
    parts = [p for p in (poly.geoms if isinstance(poly, MultiPolygon) else [poly]) if isinstance(p, Polygon) and p.area >= min_area]
    if not parts:
        return None
    return max(parts, key=lambda p: p.area)


# ---------------------------------------------------------------------------------------------
# Wings and typologies


def face_frame(seg, region):
    (x0, z0), (x1, z1) = seg.coords[0], seg.coords[-1]
    L = hypot(x1 - x0, z1 - z0)
    a = ((x1 - x0) / L, (z1 - z0) / L)
    n = (-a[1], a[0])
    mid = ((x0 + x1) / 2 + n[0] * 0.5, (z0 + z1) / 2 + n[1] * 0.5)
    if not region.contains(Point(mid)):
        n = (-n[0], -n[1])
    return Frame((x0, z0), a, n), L


def open_beyond(frame, u0, u1, v, region, site):
    """Whether the face at v (looking away from the wing, +v) opens to a street, or to a yard or court
    deep enough for legally required windows, measured to the lot line or the region's far side."""
    need = RULES['window_distance'].value
    mid = (u0 + u1) / 2
    probe = frame.line(mid, v + 0.5, mid, v + need)
    if probe.intersects(site.streets):
        return True
    return site.lot.buffer(0.01).contains(probe) and not probe.crosses(site.lot.exterior)


@dataclass
class WingSpec:
    frame: Frame
    length: float
    depth: float
    front: float      # front band depth, 0 when the front face takes no windows
    back: float       # back band depth, 0 when the back face takes no windows
    mid: float        # corridor or core zone between the bands
    start: float = 0.0


def lay_wing(draft, spec, site, cores, name='', start_exposed=False, end_exposed=False, reserve=(), cluster=()):
    """Draw one wing: its bands of bays, its corridor or central hall, and the cores placed in it.
    cores is [(kind, u, band)] with band 'front', 'back' or 'mid'; reserve is [(u0, u1, band)]
    taken out of a band for another wing's corridor or a court corner."""
    f, L = spec.frame, spec.start + spec.length
    u_lo = spec.start
    vf0, vf1 = 0.0, spec.front
    vm0, vm1 = spec.front, spec.front + spec.mid
    vb0, vb1 = vm1, vm1 + spec.back
    taken = {'front': [], 'back': [], 'mid': []}
    for u0, u1, band in reserve:
        taken[band].append((u0, u1))
    # Cores: stairs and the elevator module, each a bay of the band it sits in.
    for kind, u, band in cores:
        v0, v1 = {'front': (vf0, vf1), 'back': (vb0, vb1), 'mid': (vm0, vm1)}[band]
        depth = v1 - v0
        if u == 'after':
            u = max((c1 for _, c1 in taken[band]), default=u_lo)
        if kind == 'stair':
            w, d = CORE['stair'][0], depth
            if band == 'mid':
                w, d = (CORE['stair'][1], CORE['stair'][0]) if depth < CORE['stair'][1] else CORE['stair']
            u0 = min(max(u, u_lo), L - w)
            near = v0 if band == 'back' else v1 - min(d, depth) if band == 'front' else v0
            if band == 'mid':
                near = v0 + (depth - min(d, depth)) / 2
            draft.stairs.append(draft.add(f'Stair {"ABC"[len(draft.stairs)]}', 'stair', f.rect(u0, u0 + w, near, near + min(d, depth)).intersection(draft.plate)))
            taken[band].append((u0, u0 + w))
        else:  # the elevator, refuse and electric module, stacked away from the corridor
            w = CORE['elevator'][0]
            u0 = min(max(u, u_lo), L - w)
            stack = [('Elevator', 'elevator', CORE['elevator'][1]), ('Refuse room', 'refuse', CORE['refuse'][1]), ('Electric closet', 'electric', CORE['electric'][1])]
            if band == 'mid':
                stack = stack[:2]
            v = v0 if band != 'front' else v1
            for label, k, d in stack:
                if band == 'front':
                    draft.add(label, k, f.rect(u0, u0 + w, max(v - d, v0), v).intersection(draft.plate))
                    v = max(v - d, v0)
                else:
                    draft.add(label, k, f.rect(u0, u0 + w, v, min(v + d, v1)).intersection(draft.plate))
                    v = min(v + d, v1)
            draft.elevator = True
            taken[band].append((u0, u0 + w))
    if cluster:
        length = sum(CLUSTER[k][0] for k in cluster)
        u = max(u_lo, (u_lo + L) / 2 - length / 2)
        for k in cluster:
            w, d = CLUSTER[k]
            d = min(d, spec.mid)
            poly = f.rect(u, u + w, vm1 - d, vm1).intersection(draft.plate)
            if k in ('stair', 'scissor'):
                label = 'Scissor stair' if k == 'scissor' else f'Stair {"ABC"[len(draft.stairs)]}'
                room = draft.add(label, 'stair', poly)
                draft.stairs.append(room)
                if k == 'scissor' and room is not None:
                    draft.params.setdefault('scissor', []).append(room)
            else:
                draft.add({'elevator': 'Elevator', 'refuse': 'Refuse room'}[k], k, poly)
                draft.elevator = draft.elevator or k == 'elevator'
            taken['mid'].append((u, u + w))
            u += w
    # The corridor or the central hall: the middle zone less what the cores took from it.
    hall = f.rect(u_lo, L, vm0, vm1).intersection(draft.plate)
    if cluster:
        hall = hall.difference(unary_union([r['poly'] for r in draft.rooms]))
    else:
        for u0, u1 in taken['mid']:
            hall = hall.difference(f.rect(u0, u1, vm0, vm1))
    for piece in pieces(shapely.set_precision(hall, GRID), 12):
        line = f.line(u_lo, (vm0 + vm1) / 2, L, (vm0 + vm1) / 2).intersection(piece.buffer(0.01))
        if line.is_empty:  # a hall beside a core: its centreline runs along u at its own middle
            pu = [f.local(x, z) for x, z in piece.exterior.coords]
            vmid = (min(v for _, v in pu) + max(v for _, v in pu)) / 2
            line = f.line(min(u for u, _ in pu), vmid, max(u for u, _ in pu), vmid)
        draft.corridors.append((piece, line))
        draft.add('Corridor' if spec.mid <= CORRIDOR + 0.5 else 'Stair hall', 'corridor', piece)
    # Bays: each band less its cores; a free run at an exposed wing end is a corner bay.
    for band, (v0, v1, at_v0) in (('front', (vf0, vf1, True)), ('back', (vb0, vb1, False))):
        if v1 - v0 < 1:
            continue
        cuts = sorted(taken[band])
        u = u_lo
        runs = []
        for c0, c1 in cuts + [(L, L)]:
            if c0 - u >= 1:
                runs.append((u, c0))
            u = max(u, c1)
        for a, b in runs:
            draft.bays.append(Bay(f, a, b, v0, v1, at_v0, corner_a=start_exposed and a <= u_lo + 0.01, corner_b=end_exposed and b >= L - 0.01))


def bar(site, face, depth, band, core, name='bar', stairs=2, elevator=True, length=None):
    """One wing along a face: double-loaded when both faces take windows, single-loaded toward the one
    that does, with stairs at the corridor ends ('ends'), a stair beside the elevator plus one at the far
    end ('core'), or everything in a central core between the bands ('central')."""
    seg, _ = face
    f, L = face_frame(seg, site.region)
    if length and length < L - 1:  # a bar shorter than the frontage, from the end of the face nearer a street
        f, L = (f, length) if edge_exposed(f, 0, depth, site, -1) or not edge_exposed(f, L, depth, site, 1) else (Frame(f.pt(L - length, 0), f.a, f.n), length)
    plate = clean(f.rect(0, L, 0, depth).intersection(site.region), 50)
    if plate is None:
        return None
    draft = Draft(name, plate, params={'depth': depth, 'band': band, 'core': core, 'stairs': stairs, 'elevator': elevator})
    back_open = open_beyond(f, 0, L, depth, site, site)
    start_exposed = edge_exposed(f, 0, depth, site, -1)
    end_exposed = edge_exposed(f, L, depth, site, 1)
    if core == 'central':
        if not back_open:
            return None
        mid = depth - 2 * band
        if mid < CORE['stair'][0]:
            return None
        spec = WingSpec(f, L, depth, band, band, mid)
        cores = [('stair', 0, 'mid')] + ([('elevator', 'after', 'mid')] if elevator else []) + ([('stair', L, 'mid')] if stairs == 2 else [])
    elif core == 'cluster':
        if not back_open or depth - 2 * band < SCISSOR[1] + 4.5:
            return None
        spec = WingSpec(f, L, depth, band, band, depth - 2 * band)
        cores = []
        modules = (['stair'] if stairs == 1 else ['scissor']) + (['elevator', 'refuse'] if elevator else [])
        if sum(CLUSTER[k][0] for k in modules) > L - 2 * 3.5:  # a 3.5 ft hall past each end of the cluster
            return None
    else:
        if back_open and depth >= 2 * band + CORRIDOR - 0.01:
            spec = WingSpec(f, L, depth, band, depth - band - CORRIDOR, CORRIDOR)
        elif 18 <= depth - CORRIDOR <= RULES['room_depth'].value + SERVICE:
            spec = WingSpec(f, L, depth, depth - CORRIDOR, 0.0, CORRIDOR)  # single-loaded toward the street
        else:
            return None
        side = 'back' if spec.back else 'front'
        lift = [('elevator', L / 2 - CORE['elevator'][0] / 2, side)] if elevator else []
        if stairs == 1:
            cores = [('stair', L / 2 - CORE['stair'][0], side)] + ([('elevator', L / 2, side)] if elevator else [])
        elif core == 'ends':
            cores = [('stair', 0, side)] + lift + [('stair', L, side)]
        else:
            cores = [('stair', L / 2 - CORE['stair'][0], side)] + ([('elevator', L / 2, side)] if elevator else []) + [('stair', L, side)]
    lay_wing(draft, spec, site, cores, start_exposed=start_exposed, end_exposed=end_exposed, cluster=modules if core == 'cluster' else ())
    draft.params.update({'length': L, 'single': spec.back == 0 and core not in ('central', 'cluster')})
    return draft




def edge_exposed(f, u, depth, site, direction):
    """Whether the wing's end at u faces a street or open lot area (a corner end) rather than a lot line."""
    need = RULES['window_distance'].value
    probe = LineString([f.pt(u + direction * 0.5, depth / 2), f.pt(u + direction * need, depth / 2)])
    end = LineString([f.pt(u, 1.0), f.pt(u, depth - 1.0)])
    if end.buffer(0.6).intersection(site.streets).length >= 0.5 * end.length:
        return True
    return site.lot.buffer(0.01).contains(probe) and not site.region.buffer(-0.5).intersects(probe)


def l_plan(site, face1, face2, depth, band, target=None):
    """An L on a corner: a double-loaded wing along each street, the elevator at the knee and a stair at
    the far end of each wing."""
    f1, L1 = face_frame(face1[0], site.region)
    f2, L2 = face_frame(face2[0], site.region)
    # Run wing 2 away from the shared corner.
    if hypot(*(a - b for a, b in zip(f2.o, f1.o))) > 1 and hypot(*(a - b for a, b in zip(f2.pt(L2, 0), f1.o))) < 1:
        f2 = Frame(f2.pt(L2, 0), (-f2.a[0], -f2.a[1]), f2.n)
    if hypot(*(a - b for a, b in zip(f1.o, f2.o))) > 1:
        f1 = Frame(f1.pt(L1, 0), (-f1.a[0], -f1.a[1]), f1.n)
    if hypot(*(a - b for a, b in zip(f1.o, f2.o))) > 1:
        return None
    if target:  # wings just long enough for the target floor area, equal unless a face cuts one short
        # The plate is wing 1 (L1 by depth) plus wing 2 beyond it ((L2 - depth) by depth).
        x = (target + depth * depth) / (2 * depth)
        if L1 >= x and L2 >= x:
            L1 = L2 = x
        elif L2 < x:
            L1 = min(L1, (target - (L2 - depth) * depth) / depth)
        elif L1 < x:
            L2 = min(L2, (target - L1 * depth) / depth + depth)
    if depth < 2 * band + CORRIDOR - 0.01 or L1 < depth + 30 or L2 < depth + 30:
        return None
    plate = clean(unary_union([f1.rect(0, L1, 0, depth), f2.rect(0, L2, 0, depth)]).intersection(site.region), 50)
    if plate is None:
        return None
    draft = Draft('L-plan', plate, params={'depth': depth, 'band': band, 'core': 'knee'})
    back = depth - band - CORRIDOR
    # Wing 1 holds the corner. Its corridor meets wing 2's at the knee, so wing 2's corridor crosses
    # wing 1's back band: that crossing and the elevator beside it are reserved there.
    cross = (band, band + CORRIDOR)
    lay_wing(draft, WingSpec(f1, L1, depth, band, back, CORRIDOR), site,
             [('elevator', band + CORRIDOR, 'back'), ('stair', L1, 'back')], end_exposed=edge_exposed(f1, L1, depth, site, 1),
             reserve=[(0, band, 'back'), cross + ('back',)])
    # The connector: wing 2's corridor through wing 1's back band, then wing 2 from wing 1's depth on.
    connector = clean(f1.rect(cross[0], cross[1], band + CORRIDOR, depth).intersection(plate))
    if connector is not None:
        draft.add('Corridor', 'corridor', connector)
        draft.corridors.append((connector, f2.line(band + CORRIDOR / 2, band + CORRIDOR / 2, band + CORRIDOR / 2, depth)))
    # The bay of wing 1's back band at the corner faces the second street: a corner bay of wing 2's front band.
    draft.bays.append(Bay(f2, band + CORRIDOR, depth, 0, band, True, corner_a=False))
    spec2 = WingSpec(f2, L2 - depth, depth, band, back, CORRIDOR, start=depth)
    lay_wing(draft, spec2, site, [('stair', L2, 'back')], end_exposed=edge_exposed(f2, L2, depth, site, 1))
    # Extend wing 2's corridor centreline to the knee so the network joins.
    draft.corridors.append((None, f2.line(band + CORRIDOR / 2, band + CORRIDOR / 2, depth, band + CORRIDOR / 2)))
    # The bay of wing 1's back band at the inner corner looks into wing 2: give it to wing 2's corridor side as storage.
    inner = clean(f1.rect(0, band, band + CORRIDOR, depth).intersection(plate))
    draft.params.update({'length': L1 + L2 - depth})
    return draft


def courtyard(site, face, sides, depth, band, side_depth, target=None):
    """A U (or, with one side, an L on an interior lot) around a court open to the rear: a double-loaded
    wing on the street and single-loaded wings along the side lot lines, their corridors on the lot line
    and their units facing the court, with a stair at the far end of each side wing."""
    f, L = face_frame(face[0], site.region)
    reach = max(f.local(x, z)[1] for x, z in site.region.exterior.coords)
    if target:  # side wings just long enough for the target floor area
        reach = min(reach, depth + max(0.0, target - L * depth) / (len(sides) * side_depth))
    court = L - len(sides) * side_depth
    if court < RULES['court'].value or depth < 2 * band + CORRIDOR - 0.01 or reach < depth + CORE['stair'][1] + 20:
        return None
    wings = [f.rect(0, L, 0, depth)]
    for which in sides:
        wings.append(f.rect(0, side_depth, 0, reach) if which == 'start' else f.rect(L - side_depth, L, 0, reach))
    plate = clean(unary_union(wings).intersection(site.region), 50)
    if plate is None:
        return None
    draft = Draft('courtyard' if len(sides) == 2 else 'L-plan', plate, params={'depth': depth, 'band': band, 'core': 'courtyard', 'sideDepth': side_depth})
    back = depth - band - CORRIDOR
    reserve, cores = [], []
    for which in sides:
        # Where the side wing meets the street wing: its corridor runs through the street wing's back
        # band to the main corridor, and the bay beside it, which looks into the side wing, holds the core.
        lot, inner = ((0, CORRIDOR), (CORRIDOR, side_depth)) if which == 'start' else ((L - CORRIDOR, L), (L - side_depth, L - CORRIDOR))
        reserve += [lot + ('back',), inner + ('back',)]
        conn = draft.add('Corridor', 'corridor', f.rect(lot[0], lot[1], band + CORRIDOR, depth).intersection(plate))
        cu = (lot[0] + lot[1]) / 2
        if conn is not None:
            draft.corridors.append((conn, f.line(cu, band + CORRIDOR / 2, cu, depth)))
        if not draft.elevator:
            k = 0.0
            for label, kind, w in (('Elevator', 'elevator', CORE['elevator'][0]), ('Refuse room', 'refuse', 6.0)):
                u0 = inner[0] + k if which == 'start' else inner[1] - k - w
                draft.add(label, kind, f.rect(u0, u0 + w, band + CORRIDOR, band + CORRIDOR + min(back, CORE['elevator'][1])).intersection(plate))
                k += w
            draft.elevator = True
        # The side wing in its own frame: u from the street wing into the lot along the lot line, v from
        # the lot line (its corridor) to the court (its windows).
        origin = f.pt(0, depth) if which == 'start' else f.pt(L, depth)
        normal = f.a if which == 'start' else (-f.a[0], -f.a[1])
        side = Frame(origin, f.n, normal)
        spec = WingSpec(side, reach - depth, side_depth, 0.0, side_depth - CORRIDOR, CORRIDOR)
        lay_wing(draft, spec, site, [('stair', reach - depth, 'back')], end_exposed=False)
        draft.corridors.append((None, side.line(0, CORRIDOR / 2, 0.01, CORRIDOR / 2)))
    if len(sides) == 1:
        cores.append(('stair', L if sides[0] == 'start' else 0, 'back'))
    lay_wing(draft, WingSpec(f, L, depth, band, back, CORRIDOR), site, cores, reserve=reserve)
    leftover = clean(plate.difference(unary_union([r['poly'] for r in draft.rooms] + [f.rect(b.a, b.b, b.v0, b.v1) for b in draft.bays if b.frame is f])))
    draft.params.update({'length': L, 'reach': reach})
    return draft


# ---------------------------------------------------------------------------------------------
# Units into bays


def assign_units(bays, picks):
    """Deal the picked unit types to bays: the longest run of the picks, in the order the mix picks them, that the
    bays hold whole (deal), so a floor short of room keeps each group's share of its units. Then order each bay with
    its largest units at exposed (corner) ends, and size each in proportion to its net area. Returns how many of the
    picks are dealt: a longer run of them deals the same ones."""
    for k in range(len(picks), -1, -1):
        lists = deal(bays, picks[:k])
        if lists is not None:
            break
    for bay, units in zip(bays, lists):
        units.sort(key=lambda t: -t.target_sqft)
        if bay.corner_b and not bay.corner_a:
            units.reverse()
        elif bay.corner_a and bay.corner_b and len(units) > 1:
            units[:] = units[::2] + units[1::2][::-1]
        set_widths(bay, units)
    return k


def set_widths(bay, units):
    """The bay's units side by side in the order given, each its width (fit_widths)."""
    u = bay.a
    bay.units = []
    for t, w in zip(units, fit_widths(bay, units)):
        bay.units.append((t, u, u + w))
        u += w


def deal(bays, picks):
    """The picks dealt largest first, each to the bay with the most area left among those deep enough for its rooms
    with window wall left for them at their narrowest, as the largest smaller type of its group (UnitType.smaller)
    where it does not fit itself: the unit types of each bay, or None when one fits no bay."""
    load, wall, lists = [0.0] * len(bays), [0.0] * len(bays), [[] for _ in bays]
    for pick in sorted(picks, key=lambda t: -t.target_sqft):
        for t in (pick, *pick.smaller):
            room = [(b.length * b.depth - load[i], i) for i, b in enumerate(bays)
                    if b.depth >= min_depth(t.beds) - 1e-6 and wall[i] + min_width(t.beds) <= b.length + 1e-6]
            if room:
                break
        else:
            return None
        _, i = max(room)
        lists[i].append(t)
        load[i] += t.target_sqft
        wall[i] += min_width(t.beds)
    return lists


def fit_widths(bay, units):
    """Widths in proportion to each unit's net size, raised to its template's narrowest window wall
    where the bay allows, the rest shared in proportion again."""
    n = len(units)
    floors = []
    for i, t in enumerate(units):
        corner = (i == 0 and bay.corner_a) or (i == n - 1 and bay.corner_b)
        floors.append(template_width(t.beds, bay.depth, corner))
    fixed = {}
    while True:
        free = [i for i in range(n) if i not in fixed]
        left = bay.length - sum(fixed.values())
        total = sum(units[i].target_sqft for i in free)
        widths = {i: left * units[i].target_sqft / total for i in free} if free else {}
        low = [i for i in free if widths[i] < floors[i] - 1e-6]
        if not low or sum(floors) > bay.length:
            break
        for i in low:
            fixed[i] = floors[i]
    widths.update(fixed)
    return [widths[i] for i in range(n)]


def hall_runs(bay, halls):
    """The stretches (u0, u1) of a bay's corridor-side wall that open onto a corridor or hall."""
    v = bay.v1 if bay.window_at_v0 else bay.v0
    touch = bay.frame.line(bay.a, v, bay.b, v).intersection(halls.buffer(0.05))
    runs = []
    for g in (touch.geoms if hasattr(touch, 'geoms') else [touch]):
        if isinstance(g, LineString) and g.length > 0.01:
            us = [bay.frame.local(*c)[0] for c in g.coords]
            runs.append((min(us), max(us)))
    return sorted(runs)


def give_entries(bay, runs):
    """Shift the boundaries between a bay's units so each has at least ENTRY ft of corridor wall for its
    door, taking it from a neighbour that keeps its own and the window wall its rooms need."""
    reach = lambda x0, x1: sum(max(0.0, min(x1, b) - max(x0, a)) for a, b in runs)
    edges = [ua for _, ua, _ in bay.units] + [bay.units[-1][2]]
    n = len(bay.units)
    least = lambda k: template_width(bay.units[k][0].beds, bay.depth, (k == 0 and bay.corner_a) or (k == n - 1 and bay.corner_b))
    for i in range(n):
        if reach(edges[i], edges[i + 1]) >= ENTRY:
            continue
        for side in (1, -1):
            j = i + 1 if side > 0 else i       # the boundary that moves
            if not 0 < j < len(edges) - 1:
                continue
            other = (edges[j], edges[j + 1]) if side > 0 else (edges[j - 1], edges[j])
            for step in [k * 0.5 for k in range(1, 61)]:
                x = edges[j] + side * step
                mine = (edges[i], x) if side > 0 else (x, edges[i + 1])
                theirs = (x, other[1]) if side > 0 else (other[0], x)
                if theirs[1] - theirs[0] < least(i + side) - 1e-6 or reach(*theirs) < ENTRY:
                    break
                if reach(*mine) >= ENTRY:
                    edges[j] = x
                    break
            if reach(edges[i], edges[i + 1]) >= ENTRY:
                break
    bay.units = [(t, edges[k], edges[k + 1]) for k, (t, _, _) in enumerate(bay.units)]


def place_units(draft, picks):
    """Lay the picked units into the plate's bays and return how many are drawn. A unit is drawn only whole, its
    template's rooms inside the plate (lay_unit). A space laid out for a unit that holds no unit's rooms, and a bay
    narrower or shallower than every unit of the mix, are drawn as a space too small for a unit, floor area outside
    any unit (draft.params['givenUp'] names the unit type, or none); a bay the floor's units leave over is amenity."""
    bays = [b for b in draft.bays if b.length >= 8 and b.depth >= 10]
    draft.params['dealt'] = assign_units(bays, picks)
    halls = unary_union([h for h, _ in draft.corridors if h is not None])
    for bay in bays:
        if len(bay.units) < 2:
            continue
        runs = hall_runs(bay, halls)
        reach = lambda x0, x1: sum(max(0.0, min(x1, b) - max(x0, a)) for a, b in runs)
        while len(bay.units) > 1:
            give_entries(bay, runs)
            # A unit that gets no corridor wall for its door without a neighbour going below its template's width
            # leaves the bay to the others, widened.
            short = next((k for k, (_, a, b) in enumerate(bay.units) if reach(a, b) < ENTRY), None)
            if short is None:
                break
            set_widths(bay, [t for k, (t, _, _) in enumerate(bay.units) if k != short])
    least = {(min_width(x.beds), min_depth(x.beds)) for t in picks for x in (t, *t.smaller)}  # each unit type's narrowest bay
    inside = draft.plate.buffer(0.05)
    shapely.prepare(inside)
    n = 0
    for bay in bays:
        if not bay.units:
            if least and not any(bay.length >= w - 1e-6 and bay.depth >= d - 1e-6 for w, d in least):
                draft.params.setdefault('givenUp', []).append(None)
                draft.add(SPACE, 'other', bay.frame.rect(bay.a, bay.b, bay.v0, bay.v1).intersection(draft.plate))
            else:
                draft.add('Amenity', 'amenity', bay.frame.rect(bay.a, bay.b, bay.v0, bay.v1).intersection(draft.plate))
            continue
        for t, ua, ub in bay.units:
            laid = lay_unit(draft, inside, bay, t, ua, ub)
            if laid is None:
                draft.params.setdefault('givenUp', []).append(t)
                draft.add(SPACE, 'other', bay.frame.rect(ua, ub, bay.v0, bay.v1).intersection(draft.plate))
                continue
            n += 1
            t, (u0, u1), corner, rooms = laid
            unit = {'index': n, 'type': t, 'width': u1 - u0, 'depth': bay.depth, 'corner': corner, 'frame': bay.frame,
                    'outline': clean(bay.frame.rect(u0, u1, bay.v0, bay.v1).intersection(draft.plate)), 'window_v': bay.v0 if bay.window_at_v0 else bay.v1}
            draft.params.setdefault('units', []).append(unit)
            for name, kind, poly in rooms:
                draft.add(f'Unit {n} {name.lower()}', kind, poly, unit=n, frame=bay.frame)
    # Whatever the layout left: storage, so the rooms tile the plate.
    used = unary_union([r['poly'] for r in draft.rooms])
    for piece in pieces(draft.plate.difference(used), 20):
        draft.add('Storage', 'storage', piece)
    return n


def template_width(beds, depth, corner=False):
    """The narrowest window wall a unit of this many bedrooms takes in a band this deep: its corner template's at
    an exposed end deep enough for that template, else the plain template's."""
    return min_width(beds, corner and depth >= min_depth(beds, True) - 1e-6)


def full_depth(bay, ua, ub, inside):
    """The longest stretch of a bay between ua and ub along which the band's full depth lies inside the plate (inside:
    the plate buffered for drawing tolerance)."""
    cut = bay.frame.rect(ua, ub, bay.v0, bay.v1).difference(inside)
    spans = sorted((min(us), max(us)) for g in pieces(cut, 0.01) for us in [[bay.frame.local(x, z)[0] for x, z in g.exterior.coords]])
    best, u = (ua, ua), ua
    for a, b in spans + [(ub, ub)]:
        if a - u > best[1] - best[0]:
            best = (u, a)
        u = max(u, b)
    return best


def lay_unit(draft, inside, bay, t, ua, ub):
    """One unit's rooms in its bay between ua and ub, drawn whole inside the plate (inside: the plate buffered for
    drawing tolerance): (its unit type, (u0, u1) it stands on, whether it has an exposed end, [(name, kind, polygon)]).
    Where the plate's edge cuts its template's rooms, the template is turned the other way, then laid in the stretch
    of the bay that holds the band's full depth, then tried as each smaller type of its group; None when none fits."""
    clipped = not inside.contains(bay.frame.rect(ua, ub, bay.v0, bay.v1))
    stretches = [(ua, ub), full_depth(bay, ua, ub, inside)] if clipped else [(ua, ub)]
    for t in (t, *t.smaller):
        for u0, u1 in dict.fromkeys(stretches):
            corner_lo, corner_hi = bay.corner_a and u0 <= bay.a + 0.01, bay.corner_b and u1 >= bay.b - 0.01
            exposed, flip = corner_lo or corner_hi, corner_hi and not corner_lo

            def to_world(poly, mirror):
                # s along the window wall from u0 (from u1, turned), t from the window wall: one affine map to the plate.
                (ox, oz), (ax, az), (nx, nz) = bay.frame.o, bay.frame.a, bay.frame.n
                su, ds = (u1, -1) if mirror else (u0, 1)
                tv, dt = (bay.v0, 1) if bay.window_at_v0 else (bay.v1, -1)
                return shapely.affinity.affine_transform(poly, [ds * ax, dt * nx, ds * az, dt * nz, ox + su * ax + tv * nx, oz + su * az + tv * nz])
            # The corner template with its living room at the exposed end, the plain one so, then the plain one turned.
            for corner, mirror in dict.fromkeys([(exposed, flip), (False, flip), (False, not flip)]):
                template = unit_rooms(t.beds, u1 - u0, bay.depth, corner)
                if template is None:
                    continue
                if not clipped:
                    return t, (u0, u1), exposed, [(name, kind, to_world(poly, mirror)) for name, kind, poly in template]
                drawn = [(name, kind, clean(to_world(poly, mirror).intersection(draft.plate))) for name, kind, poly in template]
                if whole(template, drawn):
                    return t, (u0, u1), exposed, [(name, kind, poly) for name, kind, poly in drawn if poly is not None]
    return None


def whole(template, drawn):
    """Whether a unit's rooms are all drawn: every living room, bedroom and hall of its template stands inside the
    plate, the living room and bedrooms still of their least area and width (RULES), and each bath whole."""
    least = {'living': RULES['living_room'].value, 'bedroom': RULES['room_area'].value}
    for (_, kind, local), (_, _, poly) in zip(template, drawn):
        if kind in ('living', 'bedroom', 'hall', 'bath') and poly is None:
            return False
        if kind == 'bath' and poly.area < 0.98 * local.area:
            return False
        if kind in least and (poly.area < least[kind] or not least_dimension(poly, RULES['room_width'].value)):
            return False
    return True


def pieces(geom, min_area):
    geoms = geom.geoms if hasattr(geom, 'geoms') else [geom]
    return [g for g in geoms if isinstance(g, Polygon) and g.area >= min_area]


# ---------------------------------------------------------------------------------------------
# Checks


def exposure(seg, draft, site):
    """What a stretch of exterior wall looks onto: 'street', 'yard', 'court' or None (a lot line, or
    open space too shallow for a legally required window)."""
    need = RULES['window_distance'].value
    mid = seg.interpolate(0.5, normalized=True)
    (x0, z0), (x1, z1) = seg.coords[0], seg.coords[-1]
    L = hypot(x1 - x0, z1 - z0)
    n = (-(z1 - z0) / L, (x1 - x0) / L)
    if draft.plate.buffer(0.05).contains(Point(mid.x + n[0] * 0.3, mid.y + n[1] * 0.3)):
        n = (-n[0], -n[1])
    if seg.buffer(0.6).intersection(site.streets).length >= seg.length * 0.5:
        return 'street'
    ray = LineString([(mid.x + n[0] * 0.3, mid.y + n[1] * 0.3), (mid.x + n[0] * need, mid.y + n[1] * need)])
    if ray.intersects(site.streets):
        return 'street'
    if not site.lot.buffer(0.01).contains(ray):
        return None
    if ray.intersects(draft.plate.buffer(-0.05)):
        return None
    return 'court' if LineString([(mid.x + n[0] * need, mid.y + n[1] * need), (mid.x + n[0] * (need + 400), mid.y + n[1] * (need + 400))]).intersects(draft.plate) else 'yard'


def least_dimension(poly, need):
    return not poly.buffer(-need / 2 + 0.01, join_style='mitre').is_empty


def window_walls(draft, site):
    """Exterior wall stretches of each habitable room that may take a legally required window."""
    edge = draft.plate.exterior
    out = {}
    for i, room in enumerate(draft.rooms):
        if room['kind'] not in ('living', 'bedroom'):
            continue
        walls = []
        shared = room['poly'].exterior.intersection(edge.buffer(0.02))
        for line in (shared.geoms if hasattr(shared, 'geoms') else [shared]):
            if not isinstance(line, LineString) or line.length < 2:
                continue
            coords = list(line.coords)
            for p, q in zip(coords, coords[1:]):
                seg = LineString([p, q])
                if seg.length >= 2:
                    kind = exposure(seg, draft, site)
                    if kind:
                        walls.append((seg, kind))
        out[i] = walls
    return out


def network_distances(draft):
    """Distances along corridor centrelines: a graph of noded centreline segments, Dijkstra from each stair."""
    lines = [c for _, c in draft.corridors if c is not None and not c.is_empty]
    merged = unary_union([l for l in lines if l.length > 0.1])
    segs = []
    for g in (merged.geoms if hasattr(merged, 'geoms') else [merged]):
        if isinstance(g, LineString):
            cs = list(g.coords)
            segs += [LineString([p, q]) for p, q in zip(cs, cs[1:]) if hypot(q[0] - p[0], q[1] - p[1]) > 0.01]
    return segs


def attach(segs, points):
    """Graph over corridor segments with the given points projected on: {node: [(node, length)]} and
    each point's node and stub length."""
    cuts = {i: [0.0, s.length] for i, s in enumerate(segs)}
    where = []
    for p in points:
        i = min(range(len(segs)), key=lambda k: segs[k].distance(p))
        d = segs[i].project(p)
        cuts[i].append(d)
        where.append((i, d, segs[i].distance(p)))
    key = lambda pt: (round(pt.x, 1), round(pt.y, 1))
    graph = {}
    for i, s in enumerate(segs):
        ds = sorted(set(round(d, 3) for d in cuts[i]))
        for d0, d1 in zip(ds, ds[1:]):
            a, b = key(s.interpolate(d0)), key(s.interpolate(d1))
            graph.setdefault(a, []).append((b, d1 - d0))
            graph.setdefault(b, []).append((a, d1 - d0))
    nodes = [(key(segs[i].interpolate(round(d, 3))), stub) for i, d, stub in where]
    return graph, nodes


def dijkstra(graph, source):
    dist = {source: 0.0}
    heap = [(0.0, source)]
    while heap:
        d, n = heapq.heappop(heap)
        if d > dist.get(n, 1e18):
            continue
        for m, w in graph.get(n, []):
            if d + w < dist.get(m, 1e18):
                dist[m] = d + w
                heapq.heappush(heap, (d + w, m))
    return dist


def door_point(unit_poly, draft):
    """Where a unit meets the corridor: the middle of the longest shared edge, or None."""
    best = None
    for hall, _ in draft.corridors:
        if hall is None:
            continue
        shared = unit_poly.exterior.intersection(hall.exterior.buffer(0.05))
        for g in (shared.geoms if hasattr(shared, 'geoms') else [shared]):
            if isinstance(g, LineString) and g.length >= 3 and (best is None or g.length > best.length):
                best = g
    return best


def check(rule_id, value, ok, limit=None, scope='floor', note=None):
    r = RULES[rule_id]
    out = {'rule': rule_id, 'text': r.text, 'value': value, 'limit': r.value if limit is None else limit, 'pass': bool(ok), 'cite': r.cite, 'basis': r.basis, 'scope': scope}
    if note:
        out['note'] = note
    return out


def evaluate(draft, site, program):
    """Rule checks, measured on the drawn rooms, for one candidate."""
    checks, units = [], draft.params.get('units', [])
    walls = window_walls(draft, site)
    light_fail, glazing_fail, area_fail, width_fail = [], [], [], []
    windows = {}
    for i, room in enumerate(draft.rooms):
        if room['kind'] not in ('living', 'bedroom'):
            continue
        area = room['poly'].area
        need = RULES['glazing'].value * area / T.window_height
        run = sum(s.length for s, _ in walls[i])
        windows[i] = (walls[i], need)
        if not walls[i]:
            light_fail.append(room['name'])
        elif run < need + 1:
            glazing_fail.append(room['name'])
        if room['kind'] == 'living' and area < RULES['living_room'].value:
            area_fail.append(f"{room['name']} {area:.0f} SF")
        if room['kind'] == 'bedroom' and area < RULES['room_area'].value:
            area_fail.append(f"{room['name']} {area:.0f} SF")
        if not least_dimension(room['poly'], RULES['room_width'].value):
            width_fail.append(room['name'])
    habitable = len(windows)
    checks.append(check('light', f'{habitable - len(light_fail)} of {habitable} habitable rooms', not light_fail, scope='room', note='; '.join(light_fail[:6]) or None))
    checks.append(check('glazing', f'{habitable - len(glazing_fail) - len(light_fail)} of {habitable} rooms', not glazing_fail and not light_fail, scope='room', note='; '.join(glazing_fail[:6]) or None))
    checks.append(check('living_room', 'all units' if not [a for a in area_fail if 'living' in a] else 'short', not [a for a in area_fail if 'living' in a], scope='room', note='; '.join(a for a in area_fail if 'living' in a) or None))
    checks.append(check('room_area', 'all bedrooms' if not [a for a in area_fail if 'bedroom' in a] else 'short', not [a for a in area_fail if 'bedroom' in a], scope='room', note='; '.join(a for a in area_fail if 'bedroom' in a) or None))
    checks.append(check('room_width', 'all rooms' if not width_fail else f'{len(width_fail)} narrow', not width_fail, scope='room', note='; '.join(width_fail[:6]) or None))
    # Room depth: the farthest point of each habitable room from its own window walls.
    deep = []
    worst_depth = 0.0
    for i, (lines, _) in windows.items():
        if not lines:
            continue
        reach = max(unary_union([s for s, _ in lines]).distance(Point(p)) for p in draft.rooms[i]['poly'].exterior.coords)
        worst_depth = max(worst_depth, reach)
        if reach > RULES['room_depth'].value + 0.5:
            deep.append(f"{draft.rooms[i]['name']} {reach:.0f} ft")
    checks.append(check('room_depth', round(worst_depth, 1), not deep, scope='room', note='; '.join(deep[:6]) or None))
    checks.append(check('window_size', f'{T.window_height:g} ft tall, head {2.5 + T.window_height:g} ft', T.window_height * 3 >= RULES['window_size'].value and 2.5 + T.window_height >= 7, scope='room',
                        note='Windows are drawn at least 3 ft wide.'))
    # Egress.
    stairs = [s for s in draft.stairs if s is not None]
    scissors = draft.params.get('scissor', [])
    storeys, per_floor = program['storeys'], len(units)
    area = draft.plate.area
    single_ok = (storeys <= RULES['single_exit'].value and area <= 2000) or (storeys <= 4 and per_floor <= 3 and area <= 2500)
    needed = 1 if single_ok else RULES['exits'].value
    # Exit doors: one per stair, two at the ends of a scissor stair's hall side.
    stair_doors = []
    for s in stairs:
        d = door_point(s, draft)
        if d is None:
            continue
        if any(s is x for x in scissors) and d.length >= 21:
            stair_doors += [d.interpolate(3.0), d.interpolate(d.length - 3.0)]
        else:
            stair_doors.append(d.interpolate(0.5, normalized=True))
    exits = len(stair_doors)
    note = None
    if single_ok and exits == 1:
        note = 'One exit stair is allowed at this height and floor area (Type I or II construction).' if storeys > 4 else 'One exit stair is allowed at this height, unit count and floor area (NYC BC 2022 1006.3.2 item 6).'
    elif scissors:
        note = 'The scissor stair counts as two exits in 2-hour masonry enclosures with doors at least 15 ft apart (NYC BC 2022 1007.1.1 exception 3).'
    checks.append(check('single_exit' if needed == 1 and exits == 1 else 'exits', exits, exits >= needed, limit=needed, note=note))
    segs = network_distances(draft)
    doors = []
    for u in units:
        d = door_point(u['outline'], draft) if u['outline'] is not None else None
        doors.append(d)
    unreachable = [u['index'] for u, d in zip(units, doors) if d is None]
    diag = max((hypot(p[0] - q[0], p[1] - q[1]) for p in draft.plate.exterior.coords for q in draft.plate.exterior.coords), default=0)
    if len(stair_doors) >= 2:
        sep = max(stair_doors[i].distance(stair_doors[j]) for i in range(len(stair_doors)) for j in range(i + 1, len(stair_doors)))
        third = RULES['exit_separation'].value * diag
        checks.append(check('exit_separation', round(sep, 1), sep >= min(third, 15.0) - 0.5, limit=round(third, 1),
                            note=None if sep >= third - 0.5 else 'Under one third of the diagonal: the stairs need 2-hour masonry enclosures with doors at least 15 ft apart (exception 3).'))
    worst_travel = worst_common = worst_dead = 0.0
    if segs and stair_doors:
        pts = [d.interpolate(0.5, normalized=True) for d in doors if d is not None] + stair_doors
        ends = [Point(c) for s in segs for c in (s.coords[0], s.coords[-1])]
        graph, nodes = attach(segs, pts + ends)
        n_units = len(pts) - len(stair_doors)
        stair_nodes = nodes[n_units:n_units + len(stair_doors)]
        tables = [dijkstra(graph, n) for n, _ in stair_nodes]
        reach = lambda node, k: tables[k].get(node, 1e9) + stair_nodes[k][1]
        between = tables[0].get(stair_nodes[1][0], 1e9) if len(stair_nodes) > 1 else 0.0
        live = [d for d in doors if d is not None]
        for j, (node, stub) in enumerate(nodes[:n_units]):
            u = [u for u, d in zip(units, doors) if d is not None][j]
            door = live[j].interpolate(0.5, normalized=True)
            inside = max(abs(u['frame'].local(*p)[0] - u['frame'].local(door.x, door.y)[0]) + abs(u['frame'].local(*p)[1] - u['frame'].local(door.x, door.y)[1]) for p in u['outline'].exterior.coords)
            d = sorted(reach(node, k) for k in range(len(stair_nodes)))
            worst_travel = max(worst_travel, inside + stub + d[0])
            common = d[0] if len(d) < 2 else max(0.0, (d[0] + d[1] - between) / 2)
            worst_common = max(worst_common, inside + common)
        for node, _ in nodes[n_units + len(stair_doors):]:
            d = sorted(reach(node, k) for k in range(len(stair_nodes)))
            dead = d[0] if len(d) < 2 else max(0.0, (d[0] + d[1] - between) / 2)
            worst_dead = max(worst_dead, dead)
    elif units:
        worst_travel = worst_common = worst_dead = 999
    checks.append(check('travel', round(worst_travel, 1), worst_travel <= RULES['travel'].value))
    checks.append(check('common_path', round(worst_common, 1), worst_common <= (RULES['common_path'].value if not single_ok else 125)))
    checks.append(check('dead_end', round(worst_dead, 1), worst_dead <= RULES['dead_end'].value + 0.5))
    # Corridor width: 44 in, or 36 in where the floor serves 50 occupants or fewer (200 sq ft gross each, BC Table 1004.5).
    need_width = RULES['corridor_width'].value if area / 200 > 50 else 3.0
    halls = [h for h, _ in draft.corridors if h is not None]
    narrow_halls = [h for h in halls if not least_dimension(h, need_width)]
    checks.append(check('corridor_width', 'all halls' if not narrow_halls else f'{len(narrow_halls)} narrow', not narrow_halls, limit=round(need_width, 2)))
    target = program.get('plateSqft')
    if target:
        checks.append(check('floor_area', f'{area:.0f} of {target:.0f} SF', area <= target * RULES['floor_area'].value, limit=round(target), scope='floor'))
        checks.append(check('floor_area_used', f'{area:.0f} of {target:.0f} SF', area >= target * RULES['floor_area_used'].value, limit=round(target * RULES['floor_area_used'].value), scope='floor'))
    if unreachable:
        checks.append({'rule': 'access', 'text': 'Every unit opens onto the corridor', 'value': f'{len(unreachable)} units', 'limit': 0, 'pass': False, 'cite': 'NYC BC 2022 1016.2', 'basis': 'law', 'scope': 'unit',
                       'note': ', '.join(f'Unit {i}' for i in unreachable)})
    need_elevator = storeys >= RULES['elevator'].value
    checks.append(check('elevator', 'drawn' if draft.elevator else 'none', draft.elevator or not need_elevator, scope='building',
                        note=None if draft.elevator or not need_elevator else f'{storeys} storeys need an elevator.'))
    # Type B+NYC: the templates hold a 5 by 8 ft bath and a 3.5 ft hall; the clearances inside are the architect's.
    checks.append(check('type_b', 'every unit' if draft.elevator else 'entrance storey', True, scope='unit',
                        note='Unit templates reserve the bath and hall clearances; door, kitchen and bath details are drawn by the architect.'))
    cap = program.get('unitCap')
    if cap is not None:
        drawn = per_floor * storeys
        checks.append(check('dwelling_units', f'{drawn} of {cap}', drawn <= cap, limit=cap, scope='building',
                            note='No factor applies in special density areas or to qualifying senior housing.'))
    refuse = any(r['kind'] == 'refuse' for r in draft.rooms)
    need_refuse = storeys >= RULES['refuse'].value and program['units'] >= 9
    checks.append(check('refuse', 'drawn' if refuse else 'none', refuse or not need_refuse, scope='floor'))
    return checks, windows, {'travel': worst_travel, 'commonPath': worst_common, 'deadEnd': worst_dead}


# ---------------------------------------------------------------------------------------------
# Candidates, scoring and the chosen plan


def pick_types(mix, count):
    """count unit types by largest share deficit, the engine's mix method: first the group (affordable or not) furthest
    below its share, then its type furthest below its share of the group, so every count keeps each group's share to
    within half a unit."""
    groups = {}
    for t in mix:
        groups.setdefault(group(t), []).append(t)
    share = {g: sum(t.share for t in types) for g, types in groups.items()}
    taken, counter = dict.fromkeys(groups, 0), {t.name: 0 for t in mix}
    picks = []
    for i in range(1, count + 1):
        g = max(groups, key=lambda g: share[g] * i - taken[g])
        taken[g] += 1
        t = max(groups[g], key=lambda t: t.share / share[g] * taken[g] - counter[t.name])
        counter[t.name] += 1
        picks.append(t)
    return picks


def candidates(site, target_sqft, storeys=6):
    """Plates and circulation the floor could take inside the region, as un-filled drafts."""
    faces = site.faces()
    streets = [f for f in faces if f[1] == 'street']
    if not streets:
        # A part set back behind an open area along its street (on a through lot, the open area the rear
        # yard equivalent leaves at a street line) fronts that street from its open face nearest it.
        facing = [f for f in faces if f[1] == 'open']
        streets = [min(facing, key=lambda f: f[0].distance(site.streets))] if facing else [max(faces, key=lambda f: f[0].length)]
    drafts = []
    main = max(streets, key=lambda f: f[0].length)
    for face in streets:
        f, L = face_frame(face[0], site.region)
        reach = max(f.local(x, z)[1] for x, z in site.region.exterior.coords)
        # Plate depths: the depth that holds the target area, and the standard double-loaded depths.
        depths = sorted({round(min(reach, target_sqft / max(L, 1)), 1)} | {d for d in (50, 55, 60, 65, 70, 75, 80, 85) if d <= reach + 0.01})
        for depth in depths:
            if depth < 20:
                continue
            plate = min(L * depth, site.region.area)
            stair_counts = (1, 2) if storeys <= RULES['single_exit'].value and plate <= 2000 * 1.05 else (2,)
            lifts = (True,) if storeys >= RULES['elevator'].value else (False, True)
            for band, core in [(b, c) for b in (21, 24, 27, 30, 34, 38) for c in ('ends', 'core')] + \
                    [(round((depth - m) / 2, 1), c) for m, c in ((CORE['stair'][0], 'central'), (CORE['stair'][1], 'central'), (SCISSOR[1] + 5, 'cluster'), (SCISSOR[1] + 8, 'cluster'))]:
                if not 19.5 <= band <= RULES['room_depth'].value + SERVICE:
                    continue
                if core not in ('central', 'cluster') and depth < 2 * band + CORRIDOR - 0.01 and band != 27:
                    continue
                for stairs in stair_counts:
                    if stairs == 1 and core == 'core':
                        continue
                    for lift in lifts:
                        # The whole frontage, and a bar just long enough for the target floor area.
                        for length in dict.fromkeys((None, round(target_sqft / depth, 1) if target_sqft / depth < L - 10 else None)):
                            d = bar(site, face, depth, band, core, name='central core' if core in ('central', 'cluster') else 'double-loaded corridor', stairs=stairs, elevator=lift, length=length)
                            if d is not None:
                                if core != 'central' and d.params.get('single'):
                                    d.typology = 'single-loaded corridor'
                                drafts.append(d)
    # Corner lots: an L along both streets.
    for i, f1 in enumerate(streets):
        for f2 in streets[i + 1:]:
            if f1[0].distance(f2[0]) < 1:
                for depth in (55, 60, 65):
                    for band in (24, 27, 30):
                        for a, b in ((f1, f2), (f2, f1)):
                            d = l_plan(site, a, b, depth, band, target_sqft)
                            if d is not None:
                                drafts.append(d)
    # Wide lots: a U around a court open to the rear, its side wings on the side lot lines.
    for face in streets:
        f, L = face_frame(face[0], site.region)
        sides = tuple(which for which, u in (('start', 0.0), ('end', L)) if not edge_exposed(f, u, 30, site, -1 if which == 'start' else 1))
        for chosen in dict.fromkeys(c for c in (sides, sides[:1], sides[1:]) if c):
            for depth in (55, 60, 65):
                for band in (24, 27):
                    for side_depth in (30, 33):
                        d = courtyard(site, face, chosen, depth, band, side_depth, target_sqft)
                        if d is not None:
                            drafts.append(d)
    return drafts


def unit_type_sizes(units):
    return [u['outline'].area if u['outline'] is not None else 0 for u in units]


def score(draft, checks, units, target_units, target_sqft):
    gross = draft.plate.area
    net = sum(u['outline'].area for u in units if u['outline'] is not None)
    circulation = sum(r['poly'].area for r in draft.rooms if r['kind'] in ('corridor', 'stair', 'elevator', 'refuse', 'electric'))
    habitable = [c for c in checks if c['rule'] == 'light']
    corner = sum(1 for u in units if u['corner'])
    ntg = net / gross if gross else 0
    parts = {
        'netToGross': round(ntg, 3),
        'unitCount': round(max(0.0, 1 - abs(len(units) - target_units) / max(target_units, 1)), 3),
        'windowExposure': round(sum(1 for c in checks if c['scope'] == 'room' and c['pass']) / max(1, sum(1 for c in checks if c['scope'] == 'room')), 3),
        'cornerUnits': round(min(1.0, corner / max(1, min(4, len(units)))), 3),
        'coreEfficiency': round(1 - circulation / gross, 3) if gross else 0,
        'plateArea': round(max(0.0, 1 - abs(gross - target_sqft) / target_sqft), 3) if target_sqft else 1,
    }
    weights = {'netToGross': 30, 'unitCount': 25, 'windowExposure': 15, 'cornerUnits': 5, 'coreEfficiency': 10, 'plateArea': 15}
    total = sum(parts[k] * w for k, w in weights.items())
    failed = [c for c in checks if not c['pass']]
    penalty = sum(40 if c['basis'] == 'law' else 8 for c in failed)
    fit = fit_issues(units)
    penalty += 6 * len(fit)
    return round(total - penalty, 1), parts, fit


def fit_issues(units):
    small = [u for u in units if u['outline'] is not None and u['outline'].area < u['type'].target_sqft * FIT_RANGE[0]]
    large = [u for u in units if u['outline'] is not None and u['outline'].area > u['type'].target_sqft * FIT_RANGE[1]]
    out = []
    if small:
        out.append(f"{len(small)} unit{'s' if len(small) > 1 else ''} drawn below 80 percent of the scheme's net size ({', '.join(sorted({u['type'].name for u in small}))}).")
    if large:
        out.append(f"{len(large)} unit{'s' if len(large) > 1 else ''} drawn above 130 percent of the scheme's net size ({', '.join(sorted({u['type'].name for u in large}))}).")
    return out


def fill(draft, picks, site, program, target_units, target_sqft):
    n = place_units(draft, picks)
    units = draft.params.get('units', [])
    checks, windows, egress = evaluate(draft, site, program)
    total, parts, fit = score(draft, checks, units, target_units, target_sqft)
    return {'draft': draft, 'units': units, 'checks': checks, 'windows': windows, 'egress': egress, 'score': total, 'parts': parts, 'fit': fit, 'count': n}


def layout_key(draft):
    """What a layout is, the same in every run: its typology, plate and stairs, to order layouts that score alike."""
    bounds = lambda g: tuple(round(v, 1) for v in g.bounds)
    return draft.typology, bounds(draft.plate), tuple(sorted(bounds(s) for s in draft.stairs if s is not None))


def plan_floor(site, mix, units_per_floor, plate_sqft, storeys, building_units, unit_cap=None, core_within=None):
    """Lay out the typical floor many ways and keep the best: (best result, number of layouts tried).
    Every plate and circulation is filled with the scheme's units a floor; the ten best are filled
    again with one unit more and one fewer. With core_within (the part every storey shares), only
    plates whose stairs, elevator and refuse room lie inside it are kept, so the core stacks, unless
    none does. Each result carries the unfilled plate it was filled from as 'proto'."""
    program = {'storeys': storeys, 'units': building_units, 'plateSqft': plate_sqft, 'unitCap': unit_cap}
    protos = [p for p in candidates(site, plate_sqft, storeys) if any(b.length >= 8 and b.depth >= 10 for b in p.bays)]
    if not protos:
        raise ValueError('No layout fits this outline: it is too small for a stair and a unit.')
    # Stairs, the elevator and the refuse room are whole: a plate whose outline cuts one at an angle is not a plan.
    protos = [p for p in protos if cores_whole(p)] or protos
    if core_within is not None:
        protos = [p for p in protos if core_inside(p, core_within)] or protos
    rank = lambda r: (-r['score'], -r['parts']['netToGross'], layout_key(r['draft']))
    average = sum(t.share * t.target_sqft for t in mix)
    first = []
    for proto in protos:
        # The scheme's count and what the bays hold at the scheme's sizes, each also one unit fewer: a plate
        # that cannot take its count at the template widths often takes one unit less.
        holds = max(1, round(sum(b.length * b.depth for b in proto.bays if b.length >= 8 and b.depth >= 10) / average))
        for count in sorted({c for n in (units_per_floor, holds) for c in (n, n - 1) if c >= 1}):
            first.append((fill(clone(proto), pick_types(mix, count), site, program, units_per_floor, plate_sqft), proto, count))
            first[-1][0]['proto'] = proto
            if first[-1][0]['draft'].params['dealt'] < count:
                break  # a plate short of room for this count deals the same units for any larger one
    first.sort(key=lambda rp: rank(rp[0]))
    results = [r for r, _, _ in first]
    for r, proto, count in first[:10]:
        for more in (count - 1, count + 1):
            if more > r['draft'].params['dealt']:
                continue
            if more >= 1 and not any(p is proto and c == more for _, p, c in first):
                results.append(fill(clone(proto), pick_types(mix, more), site, program, units_per_floor, plate_sqft))
                results[-1]['proto'] = proto
    results.sort(key=rank)
    return results[0], len(results), results


def clone(draft):
    return Draft(draft.typology, draft.plate, [dict(r) for r in draft.rooms], [Bay(b.frame, b.a, b.b, b.v0, b.v1, b.window_at_v0, b.corner_a, b.corner_b) for b in draft.bays],
                 list(draft.corridors), list(draft.stairs), draft.elevator, {k: v for k, v in draft.params.items() if k not in ('units', 'givenUp')})


# ---------------------------------------------------------------------------------------------
# Ground floor and cellar programs


def programs(site, result, program):
    """The ground floor and cellar a scheme of this typical floor needs, as a schedule with its rules."""
    units = program['units']
    plate = result['draft'].plate.area
    front = max((s.length for s, k in site.faces() if k == 'street'), default=0)
    sizes = program_sizes(site, program)
    bike, compactor, refuse, commercial = sizes['bike'], sizes['compactor'], sizes['refuse'], sizes['commercial']
    recreation = RULES['recreation'].value * program['zfa'] if units >= 9 else 0.0
    core = sum(r['poly'].area for r in result['draft'].rooms if r['kind'] in ('stair', 'elevator', 'refuse', 'electric', 'corridor'))
    lobby = sizes['lobby']
    retail = min(front * 40.0, max(0.0, plate - core - lobby - refuse)) if commercial else 0.0
    item = lambda name, sqft, rule, note=None: {'name': name, 'sqft': round(sqft), 'cite': RULES[rule].cite, 'basis': RULES[rule].basis, **({'note': note} if note else {})}
    ground = [item('Lobby and mail', lobby, 'lobby')]
    if retail:
        ground.insert(0, item('Retail on the street frontage, 40 ft deep', retail, 'retail'))
    ground.append(item('Refuse and recycling storage' + (' with a compactor' if compactor else ''), refuse, 'refuse_storage'))
    left = plate - core - sum(g['sqft'] for g in ground)
    if left > 300:
        ground.append({'name': 'Units behind the lobby', 'sqft': round(left), 'cite': None, 'basis': 'assumption'})
    cellar = [item('Mechanical, electrical and water service rooms', program['zfa'] * RULES['mechanical'].value, 'mechanical')]
    if bike:
        cellar.append(item(f'Bicycle room, {bike} spaces', bike * 15, 'bike'))
    if recreation:
        cellar.append(item('Recreation space, outdoors on the roof or in the rear yard, or indoors in rooms with windows', recreation, 'recreation',
                           'Not drawn: a cellar room has no windows.'))
    return {'ground': ground, 'cellar': cellar, 'bikeSpaces': bike, 'compactor': compactor, 'commercialOverlay': commercial}


def program_sizes(site, program):
    """The ground floor and cellar rooms a building of this many units needs, in sq ft: the schedule's sizes.
    The ground floor is retail on a commercial overlay unless the scheme prices it as apartments (program
    retail false: a city-financed building has no retail income)."""
    units, storeys = program['units'], program['storeys']
    compactor = storeys >= 4 and units >= 12
    return {'lobby': max(250.0, min(1000.0, 5.0 * units)), 'refuse': max(60.0, min(350.0, units * (1.0 if compactor else RULES['refuse_storage'].value))),
            'bike': 0 if units <= 10 else ceil(units * RULES['bike'].value), 'mechanical': program['zfa'] * RULES['mechanical'].value,
            'commercial': program.get('retail', True) and (bool(site.overlay) or site.district.startswith(('C', 'MX'))), 'compactor': compactor}


def carve(draft, bay, sqft, name, kind, near, least=6.0):
    """A room of about sqft across a bay's full depth, placed as near u = near as the bay allows; the bay keeps
    what is left either side when it is long enough for a unit, else the room takes it."""
    width = min(bay.length, max(least, sqft / bay.depth))
    u0 = min(max(near - width / 2, bay.a), bay.b - width)
    u1 = u0 + width
    if u0 - bay.a < 8:
        u0 = bay.a
    if bay.b - u1 < 8:
        u1 = bay.b
    draft.add(name, kind, bay.frame.rect(u0, u1, bay.v0, bay.v1).intersection(draft.plate))
    draft.bays.remove(bay)
    for a, b in ((bay.a, u0), (u1, bay.b)):
        if b - a >= 8:
            draft.bays.append(Bay(bay.frame, a, b, bay.v0, bay.v1, bay.window_at_v0, bay.corner_a and a == bay.a, bay.corner_b and b == bay.b))
    return u1 - u0


def core_point(draft):
    return unary_union([r['poly'] for r in draft.rooms if r['kind'] in CORE_KINDS]).centroid


def nearest_bay(bays, point):
    return min(bays, key=lambda b: b.frame.rect(b.a, b.b, b.v0, b.v1).distance(point))


def on_street(bay, draft, site):
    v = bay.v0 if bay.window_at_v0 else bay.v1
    return exposure(bay.frame.line(bay.a, v, bay.b, v), draft, site) == 'street'


def ground_floor(proto, site, program, residential=True):
    """The ground floor on a plate with the building's core: the lobby and mailroom on the street beside the core,
    the refuse and recycling room off the corridor, and units in what is left; on a commercial overlay, or where
    the ground storey is not residential, retail in what is left, as the deal model prices it (the ground floor
    less its lobby and core)."""
    sizes = program_sizes(site, program)
    d = clone(proto)
    core = core_point(d)
    street = [b for b in d.bays if on_street(b, d, site)]
    lobby = nearest_bay(street or d.bays, core)
    carve(d, lobby, sizes['lobby'], 'Lobby and mail', 'lobby', lobby.frame.local(core.x, core.y)[0], least=10.0)
    if d.bays:
        inner = [b for b in d.bays if not on_street(b, d, site)] or d.bays
        refuse = nearest_bay(inner, core)
        carve(d, refuse, sizes['refuse'], 'Refuse and recycling storage' + (' with a compactor' if sizes['compactor'] else ''), 'refuse', refuse.frame.local(core.x, core.y)[0])
    for bay in list(d.bays):
        if not residential or sizes['commercial']:
            # A shop opens on the street; a bay with no street front serves the shops as their stock room.
            name = 'Retail' if on_street(bay, d, site) else 'Retail stock room'
            d.add(name, 'retail', bay.frame.rect(bay.a, bay.b, bay.v0, bay.v1).intersection(d.plate))
            d.bays.remove(bay)
    ring = list(d.plate.exterior.coords)
    d.params['street_front'] = unary_union([seg for seg in (LineString([p, q]) for p, q in zip(ring, ring[1:])) if seg.length >= 1 and exposure(seg, d, site) == 'street'])
    return d


def cellar(proto, site, program):
    """The cellar under the building's footprint, its stairs and elevator stacked: the mechanical, electrical and
    water service rooms and the bicycle room nearest the core, storage in the rest. It has no units."""
    sizes = program_sizes(site, program)
    keep = [dict(r) for r in proto.rooms if r['kind'] in ('stair', 'elevator', 'corridor')]
    d = Draft('cellar', proto.plate, keep, [Bay(b.frame, b.a, b.b, b.v0, b.v1, b.window_at_v0) for b in proto.bays], list(proto.corridors), [r['poly'] for r in keep if r['kind'] == 'stair'], True, {})
    core = core_point(d)
    for name, kind, sqft in (('Mechanical, electrical and water service', 'mechanical', sizes['mechanical']), (f"Bicycle room, {sizes['bike']} spaces", 'bike', sizes['bike'] * 15)):
        while sqft > 1 and d.bays:
            bay = nearest_bay(d.bays, core)
            sqft -= carve(d, bay, sqft, name, kind, bay.frame.local(core.x, core.y)[0]) * bay.depth
    for bay in list(d.bays):
        d.add('Storage', 'storage', bay.frame.rect(bay.a, bay.b, bay.v0, bay.v1).intersection(d.plate))
    for piece in pieces(d.plate.difference(unary_union([r['poly'] for r in d.rooms])), 20):
        d.add('Storage', 'storage', piece)
    d.bays = []
    return {'draft': d, 'units': [], 'checks': [], 'windows': {}, 'egress': {}, 'score': 0.0, 'fit': [], 'count': 0, 'law': True, 'ok': True}


# ---------------------------------------------------------------------------------------------
# The plan document


def plan_document(levels, name):
    """The drawn floors as an architecture plan v1 document in metres. levels is [(result or [result, one for
    each building on the lot], storeys, use)]:
    each drawn floor is one level standing for its storeys ([{id, name, elevation, height}], elevations in
    metres above curb), with its rooms, walls on every room edge (exterior, between units and inside units at
    their own thickness) rising to the underside of the slab above, doors and windows. Rooms carry their kind and, inside a unit, the unit's id (unique
    on its level), type and bedrooms."""
    doc = {'schema': architecture.SCHEMA, 'id': None, 'revision': None, 'parentRevision': None, 'name': name[:200], 'units': 'm',
           'levels': [], 'walls': [], 'openings': [], 'rooms': [], 'objects': [], 'sources': [{'kind': 'layout', 'ref': 'planning/layout.py'}]}
    for k, (result, storeys, use) in enumerate(levels):
        level_id = f'level-{k + 1}'
        doc['levels'].append({'id': level_id, 'name': level_name(storeys), 'use': use, 'elevation': storeys[0]['elevation'], 'height': storeys[0]['height'],
                              'storeys': [{key: st[key] for key in ('id', 'name', 'elevation')} for st in storeys]})
        before = 0
        for part in (result if isinstance(result, list) else [result]):
            wall_height = round(storeys[0]['height'] - architecture.SLAB_THICKNESS, 4)
            rooms, walls, openings = level_document(part, level_id, wall_height, {key: len(doc[key]) for key in ('rooms', 'walls', 'openings')}, before)
            before += len(part['units'])
            doc['rooms'] += rooms
            doc['walls'] += walls
            doc['openings'] += openings
    return doc


def level_name(storeys):
    names = [st['name'] for st in storeys]
    return names[0] if len(names) == 1 else f'{names[0]} to {names[-1]}'


def wall_angle(polys):
    """The direction most of a floor's room edges run in, against the frame's axes, by length (radians, from
    -45 to 45 degrees; 0 when the floor is square to the frame)."""
    lengths = {}
    for p in polys:
        coords = list(p.exterior.coords)
        for (x0, z0), (x1, z1) in zip(coords, coords[1:]):
            a = round(atan2(z1 - z0, x1 - x0) % (pi / 2), 3)
            lengths[a] = lengths.get(a, 0.0) + hypot(x1 - x0, z1 - z0)
    a = max(lengths, key=lengths.get) if lengths else 0.0
    a = a - pi / 2 if a > pi / 4 else a
    return 0.0 if abs(a) < 2e-3 else a


def slant_lines(polys, within=0.03, turn=0.004):
    """Room edges off the floor's axes (cut by an outline edge at an angle) that lie along one line, to within
    `within` ft and `turn` radians, get one common line, and their corners are set on it, so the cut is drawn
    as one wall rather than several a hair apart."""
    edges = []
    for p in polys:
        coords = list(p.exterior.coords)
        for a, b in zip(coords, coords[1:]):
            dx, dz = b[0] - a[0], b[1] - a[1]
            L = hypot(dx, dz)
            if L < 0.5 or min(abs(dx), abs(dz)) / L < 1e-3:
                continue
            ux, uz = (dx / L, dz / L) if (dx > 0 or (dx == 0 and dz > 0)) else (-dx / L, -dz / L)
            edges.append((ux, uz, -uz * a[0] + ux * a[1], L, a, b))
    lines = []
    for ux, uz, off, L, a, b in edges:
        line = next((l for l in lines if abs(l['ux'] - ux) < turn and abs(l['uz'] - uz) < turn and abs(l['off'] - off) < within), None)
        if line is None:
            lines.append({'ux': ux, 'uz': uz, 'off': off, 'w': L, 'pts': {a, b}})
        else:
            w = line['w'] + L
            for k, v in (('ux', ux), ('uz', uz), ('off', off)):
                line[k] = (line[k] * line['w'] + v * L) / w
            line['w'] = w
            line['pts'] |= {a, b}
    move = {}
    for l in lines:
        n = hypot(l['ux'], l['uz'])
        ux, uz = l['ux'] / n, l['uz'] / n
        for x, z in l['pts']:
            d = -uz * x + ux * z - l['off']
            move[(x, z)] = (x + uz * d, z - ux * d)
    return lambda poly: Polygon([move.get(c, c) for c in poly.exterior.coords])


def snapper(polys, within=0.03):
    """Room corners on one floor whose x (or z) differ by less than within (ft) take one value, so rooms built
    in different steps share their edges exactly: an edge a grid step off its neighbour at one end would
    otherwise become a second wall a hair off the first."""
    def axis(values):
        out, group = {}, []
        for v in sorted(set(values)):
            if group and v - group[0] > within:
                out.update({g: round(sum(group) / len(group), 2) for g in group})
                group = []
            group.append(v)
        out.update({g: round(sum(group) / len(group), 2) for g in group})
        return out
    coords = [c for p in polys if p is not None for part in pieces(shapely.set_precision(p, GRID), 0) for c in part.exterior.coords]
    xs, zs = axis(c[0] for c in coords), axis(c[1] for c in coords)
    def snap(poly):
        poly = max(pieces(poly, 0), key=lambda g: g.area)
        return Polygon([(xs.get(x, x), zs.get(z, z)) for x, z in poly.exterior.coords])
    return snap


def level_document(result, level_id, height_m, start, units_before=0):
    """One drawn floor's rooms, walls and openings, numbered on from start ({rooms, walls, openings}); its units
    numbered on from units_before, where another building on the lot shares the level. The floor is drawn
    turned square to the run of its walls (a wing along a face at an angle to the street), so grid rounding
    and corner snapping keep walls on one line, and turned back at the end."""
    draft, windows = result['draft'], result['windows']
    angle = wall_angle([r['poly'] for r in draft.rooms])
    if angle:
        turn = lambda g: shapely.affinity.rotate(g, -angle, origin=(0, 0), use_radians=True)
        draft = Draft(draft.typology, turn(draft.plate), [{**r, 'poly': turn(r['poly'])} for r in draft.rooms],
                      params={**draft.params, **({'street_front': turn(draft.params['street_front'])} if draft.params.get('street_front') is not None else {})})
        windows = {i: ([(turn(seg), kind) for seg, kind in segs], need) for i, (segs, need) in windows.items()}
    units = {u['index']: u for u in result['units']}
    snap = snapper([r['poly'] for r in draft.rooms])
    slant = slant_lines([snap(shapely.set_precision(r['poly'], GRID)) for r in draft.rooms])
    rooms = []
    for i, r in enumerate(draft.rooms):
        # Vertices within an inch of a straight line go, so no room edge is too short to be a wall.
        poly = slant(snap(shapely.set_precision(r['poly'], GRID))).buffer(0).simplify(0.1, preserve_topology=True)
        if poly.is_empty or not isinstance(poly, Polygon):
            continue
        pts = [[round(x * FOOT, 4), round(z * FOOT, 4)] for x, z in list(poly.exterior.coords)[:-1]]
        unit = units.get(r['unit'])
        name = re.sub(r'^Unit \d+', f"Unit {unit['index'] + units_before}", r['name']) if unit else r['name']
        rooms.append({'id': f"room-{start['rooms'] + len(rooms) + 1}", 'levelId': level_id, 'name': name[:80], 'polygon': pts, 'netAreaMethod': architecture.NET_AREA_METHOD, 'kind': r['kind'],
                      **({'unitId': f"unit-{unit['index'] + units_before}", 'unitType': unit['type'].key, 'beds': unit['type'].beds} if unit else {}), '_src': i, '_poly': poly})
    edges = unary_union([LineString(list(r['_poly'].exterior.coords)) for r in rooms])
    outer = draft.plate.exterior
    segments = []
    for g in (edges.geoms if hasattr(edges, 'geoms') else [edges]):
        cs = list(g.coords)
        segments += [(p, q) for p, q in zip(cs, cs[1:]) if hypot(q[0] - p[0], q[1] - p[1]) > 0.01]
    walls = merge_walls(segments)
    unit_of = {r['id']: draft.rooms[r['_src']]['unit'] for r in rooms}
    out_walls = []
    for k, (p, q) in enumerate(walls):
        line = LineString([p, q])
        mid = line.interpolate(0.5, normalized=True)
        exterior = outer.distance(mid) < 0.05
        sides = [r for r in rooms if r['_poly'].exterior.distance(mid) < 0.05]
        owners = {unit_of[r['id']] for r in sides}
        thickness = 0.3 if exterior else 0.12 if len(owners) == 1 and None not in owners else 0.2
        out_walls.append({'id': f"wall-{start['walls'] + k + 1}", 'levelId': level_id, 'start': [round(p[0] * FOOT, 4), round(p[1] * FOOT, 4)], 'end': [round(q[0] * FOOT, 4), round(q[1] * FOOT, 4)],
                          'thickness': thickness, 'height': height_m, 'material': 'generic', 'roomIds': [], '_line': line})
    openings = []

    def on_wall(seg, width_ft, kind, sill=0.0, height=2.1):
        mid = seg.interpolate(0.5, normalized=True)
        wall = min(out_walls, key=lambda w: w['_line'].distance(mid))
        if wall['_line'].distance(mid) > 0.05:
            return
        length = wall['_line'].length
        width = min(width_ft, seg.length - 0.5, length)
        if width < 1.5:
            return
        center = wall['_line'].project(mid)
        offset = max(0.0, min(length - width, center - width / 2))
        for o in openings:
            if o['wallId'] == wall['id'] and min(o['_off'] + o['_w'], offset + width) - max(o['_off'], offset) > 0:
                return
        openings.append({'id': f"opening-{start['openings'] + len(openings) + 1}", 'wallId': wall['id'], 'kind': kind, 'offset': round(offset * FOOT, 4), 'width': round(width * FOOT, 4),
                         'sill': round(sill * FOOT, 4), 'height': round(height, 3), 'swing': None, '_off': offset, '_w': width})
    by_src = {r['_src']: r for r in rooms}
    # Unit entry doors and stair doors on the corridor.
    halls = [r for r in rooms if draft.rooms[r['_src']]['kind'] == 'corridor']
    entered = set()
    # A unit's entrance opens into its foyer where it has one, else into its living room.
    for r in sorted(rooms, key=lambda r: draft.rooms[r['_src']]['kind'] != 'hall'):
        kind, unit = draft.rooms[r['_src']]['kind'], draft.rooms[r['_src']]['unit']
        if unit in entered:
            continue
        if kind in ('living', 'stair', 'elevator', 'refuse', 'electric', 'amenity', 'storage', 'lobby', 'mechanical', 'bike', 'other') or (kind == 'hall' and unit is not None) or r['name'] == 'Retail stock room':
            for h in halls:
                shared = longest(r['_poly'].exterior.intersection(h['_poly'].exterior.buffer(0.02)))
                if shared is not None and shared.length >= 3:
                    if r['name'] == 'Scissor stair' and shared.length >= 21:
                        for d in (3.0, shared.length - 3.0):
                            on_wall(LineString([shared.interpolate(d - 1.6), shared.interpolate(d + 1.6)]), 3.0, 'door')
                    else:
                        on_wall(shared, 3.5 if kind == 'elevator' else 3.0, 'door')
                    if unit is not None:
                        entered.add(unit)
                    break
    # Street doors, on a wall that faces a street: the building entrance into the lobby, a door into each shop.
    street_front = draft.params.get('street_front')
    for r in rooms:
        kind = draft.rooms[r['_src']]['kind']
        if kind in ('lobby', 'retail') and street_front is not None and r['name'] != 'Retail stock room':
            front = r['_poly'].exterior.intersection(street_front.buffer(0.05))
            shared = longest(front)
            if shared is not None and shared.length >= 4:
                on_wall(shared, 6.0 if kind == 'lobby' else 3.5, 'door')
    # Doors inside each unit: bedrooms and baths off the hall, else off the living room; closets off a bedroom.
    units = {}
    for r in rooms:
        u = draft.rooms[r['_src']]['unit']
        if u is not None:
            units.setdefault(u, []).append(r)
    for members in units.values():
        kinds = {r['id']: draft.rooms[r['_src']]['kind'] for r in members}
        hubs = [r for r in members if kinds[r['id']] == 'hall'] + [r for r in members if kinds[r['id']] == 'living']
        for r in members:
            if kinds[r['id']] in ('living', 'hall'):
                continue
            order = hubs + [m for m in members if kinds[m['id']] == 'bedroom'] if kinds[r['id']] == 'closet' else hubs
            for h in order:
                if h is r:
                    continue
                shared = longest(r['_poly'].exterior.intersection(h['_poly'].exterior.buffer(0.02)))
                if shared is not None and shared.length >= 2.5:
                    on_wall(shared, 2.67, 'door')
                    break
        for r in members:
            if kinds[r['id']] == 'hall':
                living = next((m for m in members if kinds[m['id']] == 'living'), None)
                shared = longest(r['_poly'].exterior.intersection(living['_poly'].exterior.buffer(0.02))) if living else None
                if shared is not None and shared.length >= 2.5:
                    on_wall(shared, 3.0, 'door')
    # Windows: on each habitable room's legal window walls, enough glazing for the room and no wider than a bay.
    for i, (walls_i, need) in windows.items():
        left = max(need, 3.0)
        for seg, _ in sorted(walls_i, key=lambda w: -w[0].length):
            if left <= 0:
                break
            width = min(left + 0.5, T.window_max, seg.length - 1.0)
            if width >= 2:
                on_wall(seg, width, 'window', sill=2.5, height=T.window_height * FOOT)
                left -= width
    for o in openings:
        o.pop('_off'), o.pop('_w')
    for w in out_walls:
        w.pop('_line')
    for r in rooms:
        r.pop('_src'), r.pop('_poly')
    if angle:
        c, s_ = cos(angle), sin(angle)
        back = lambda p: [round(p[0] * c - p[1] * s_, 4), round(p[0] * s_ + p[1] * c, 4)]
        for r in rooms:
            r['polygon'] = [back(p) for p in r['polygon']]
        for w in out_walls:
            w['start'], w['end'] = back(w['start']), back(w['end'])
    return rooms, out_walls, openings


def longest(geom):
    lines = [g for g in (geom.geoms if hasattr(geom, 'geoms') else [geom]) if isinstance(g, LineString) and g.length > 0]
    if not lines:
        return None
    merged = linemerge(lines) if len(lines) > 1 else lines[0]
    cands = merged.geoms if hasattr(merged, 'geoms') else [merged]
    best = max(cands, key=lambda g: g.length)
    cs = list(best.coords)
    if len(cs) < 2:
        return None
    seg = max((LineString([p, q]) for p, q in zip(cs, cs[1:])), key=lambda s: s.length)
    return seg


def merge_walls(segments):
    """Collinear touching segments become one wall; a wall stops where its line ends."""
    groups = {}
    for p, q in segments:
        dx, dz = q[0] - p[0], q[1] - p[1]
        L = hypot(dx, dz)
        ux, uz = dx / L, dz / L
        if ux < -1e-9 or (abs(ux) <= 1e-9 and uz < 0):
            ux, uz, p, q = -ux, -uz, q, p
        offset = round(-uz * p[0] + ux * p[1], 2)
        key = (round(ux, 4), round(uz, 4), offset)
        a, b = ux * p[0] + uz * p[1], ux * q[0] + uz * q[1]
        groups.setdefault(key, []).append((min(a, b), max(a, b), p if a <= b else q, q if a <= b else p))
    walls = []
    for spans in groups.values():
        spans.sort()
        lo, hi, pa, pb = spans[0]
        for a, b, qa, qb in spans[1:]:
            if a <= hi + 0.02:
                if b > hi:
                    hi, pb = b, qb
            else:
                walls.append((pa, pb))
                lo, hi, pa, pb = a, b, qa, qb
        walls.append((pa, pb))
    return walls


# ---------------------------------------------------------------------------------------------
# The request: a scheme's typical floor


def square(region, tolerance=0.6):
    """An outline whose edges run within tolerance (ft over their length) of the street grid, with those
    edges set square on it. Each such edge moves to its inner end, so the squared outline stays inside;
    every corner is the meeting point of its two edge lines. Walls on a tax-map line a fraction of a
    degree off square would otherwise come out a hair off parallel and fail to join."""
    ring = orient(region, 1.0).exterior.coords[:-1]
    n = len(ring)
    lines = []
    for i in range(n):
        (x0, z0), (x1, z1) = ring[i], ring[(i + 1) % n]
        dx, dz = x1 - x0, z1 - z0
        if abs(dz) <= tolerance and abs(dx) > abs(dz):      # nearly along x: z = const, interior above (CCW, dx > 0) or below
            z = max(z0, z1) if dx > 0 else min(z0, z1)
            lines.append(((x0, z), (1.0, 0.0)))
        elif abs(dx) <= tolerance and abs(dz) > abs(dx):    # nearly along z: x = const, interior to the left of travel
            x = min(x0, x1) if dz > 0 else max(x0, x1)
            lines.append(((x, z0), (0.0, 1.0)))
        else:
            lines.append(((x0, z0), (dx, dz)))
    pts = []
    for i in range(n):
        (p, d), (q, e) = lines[i - 1], lines[i]
        det = d[0] * e[1] - d[1] * e[0]
        if abs(det) < 1e-9:
            pts.append(ring[i])
            continue
        t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / det
        pts.append((p[0] + t * d[0], p[1] + t * d[1]))
    squared = Polygon(pts)
    if not squared.is_valid or abs(squared.area - region.area) > 0.02 * region.area:
        return region
    return squared


def unit_cap(request):
    """The ZR 23-52 unit cap: the residential floor area permitted on the zoning lot (the outline's
    zoningFloorArea.allowedSqft, else the scheme's floor area) over the dwelling unit factor (the outline's
    density.dwellingUnitFactor, else 680), fractions of three quarters rounding up; None where the
    envelope has no factor, as in the Manhattan Core and Downtown Brooklyn."""
    outlines = request.get('outlines') or {}
    factor = outlines['density'].get('dwellingUnitFactor') if outlines.get('density') else RULES['dwelling_units'].value
    if not factor:
        return None
    whole, part = divmod((outlines.get('zoningFloorArea') or {}).get('allowedSqft', request['zfa']) / factor, 1)
    return int(whole) + (1 if part >= 0.75 else 0)


def drawn_storeys(request):
    """The storeys the floors are drawn on, [{id, name, elevation, height}] in metres above curb: the
    option's residential storeys from its outlines, else its storeys at the standard height."""
    if request.get('outlines'):
        found = stack(request)[:request['storeys']]
        rows = [(o.index, o.bottom, o.height) for o in found if o.use == 'residential'] or [(o.index, o.bottom, o.height) for o in found]
    else:
        rows = [(i, i * STOREY_HEIGHT, STOREY_HEIGHT) for i in range(request['storeys'])]
    return [{'id': f'storey-{i + 1}', 'name': 'Ground floor' if i == 0 else f'Level {i + 1}', 'elevation': round(bottom * FOOT, 4), 'height': round(height * FOOT, 4)}
            for i, bottom, height in rows]


def gross_per_zfa(request):
    """Gross floor area a square foot of zoning floor area takes: the envelope's figure (the floor area the
    zoning resolution excludes, such as mechanical and refuse rooms, comes on top), 1 without outlines,
    times the correction (grossScale) a first drawing measured against the zoning account."""
    return ((request.get('outlines') or {}).get('floorArea', {}).get('grossPerZfa') or 1.0) * request.get('grossScale', 1.0)


def stack(request):
    """The storey outlines the floors are drawn on: the export's, or, where a first drawing found the floors
    hold less than the outlines (every room within 30 ft of a window), the stack carried up to stackStoreys
    storeys into the envelope's reserve storeys, within the height limit they carry."""
    export = request['outlines']
    if 'stackStoreys' not in request:
        return outline_source.storey_outlines(export)
    every = {**export, 'storeys': [{**s, 'grossBudgetSqft': s['grossBudgetSqft'] * 10} for s in export['storeys']]}
    return outline_source.storey_outlines(every)[:request['stackStoreys']]


def zoning_floor_area(doc, export):
    """The zoning floor area a plan draws, as its zoning sheet accounts it: every storey on its own level's
    plate and rooms, less the exclusions drawn and assumed (planning/zoning.py)."""
    found = outline_source.storey_outlines(export)
    return zoning.account(export, found, drawn=zd1.drawn_storeys(doc, found))['totals']['zfaSqft']


def floors_of(request):
    """Each drawn storey with the outline its floor may fill and its share of the scheme's floor area:
    [(storey, region, target gross sq ft)]. The region leaves out the trim that only spreads the option's
    floor area over its storeys (a budget, which the target answers); the scheme's zoning floor area, as
    gross floor area, is shared evenly over the storeys, none above what its outline holds. Without
    outlines every storey takes the site's region (None here) and the scheme's floor area over its storeys."""
    storeys = drawn_storeys(request)
    if not request.get('outlines'):
        return [(st, None, request['plateSqft']) for st in storeys]
    export = request['outlines']
    lot = outline_source.lot_polygon(export['lot'])
    lines = outline_source.lot_lines(lot, [s['side'] for s in export['streets']])
    found = {f'storey-{o.index + 1}': o for o in stack(request)}
    rows = []
    for st in storeys:
        o = found[st['id']]
        geometry = o.geometry
        if any(c['control'] == 'max_area' for c in o.shaped_by):
            geometry = outline_source.storey_geometry(export, lot, lines, [c for c in o.shaped_by if c['control'] != 'max_area'], o.equivalent or 'midway')
        rows.append((st, significant(geometry)))
    # A storey of another use (retail at grade) fills its outline, as the zoning account draws it.
    other = sum(o.geometry.area for o in stack(request)[:request['storeys']] if f'storey-{o.index + 1}' not in {st['id'] for st in storeys})
    return [(st, region, target) for (st, region), target in zip(rows, spread(max(0.0, request['zfa'] * gross_per_zfa(request) - other), [region.area for _, region in rows]))]


def spread(total, capacities):
    """total shared evenly over storeys, none above its capacity, what a small storey cannot hold going to the rest."""
    out, left, open_ = [0.0] * len(capacities), total, set(range(len(capacities)))
    while open_ and left > 1e-6:
        each = left / len(open_)
        full = {i for i in open_ if capacities[i] - out[i] <= each}
        if not full:
            for i in open_:
                out[i] += each
            break
        for i in full:
            left -= capacities[i] - out[i]
            out[i] = capacities[i]
        open_ -= full
    return out


def significant(geometry):
    """The parts of an outline a building can stand on: the largest, and any other at least a quarter of its
    area (a through lot's second building across its rear yard equivalent)."""
    found = outline_source.parts(geometry)
    keep = [p for p in found if p.area >= max(600.0, 0.25 * found[0].area)]
    return keep[0] if len(keep) == 1 else MultiPolygon(keep)


def piece(region, part):
    """The polygon of a storey's outline standing on one part of the base outline."""
    return max(outline_source.parts(region), key=lambda g: g.intersection(part).area)


def cores_whole(draft):
    return all(r['poly'].area >= 0.98 * r['poly'].minimum_rotated_rectangle.area for r in draft.rooms if r['kind'] in CORE_KINDS)


def core_inside(draft, region):
    near = region.buffer(0.5)
    return all(near.contains(r['poly']) for r in draft.rooms if r['kind'] in CORE_KINDS)


def derive(proto, region, target):
    """The plate of a storey whose outline or floor area is smaller than the base plate's, drawn from the base
    plate so its stairs, elevator and corridors stack: the plate cut to the outline, each bay cut to what stays
    inside, then the bay ends farthest from the core given up until the floor is within its floor area. None
    when the core does not fit the outline."""
    plate = clean(proto.plate.intersection(region), 50)
    if plate is None or not core_inside(proto, plate):
        return None
    rooms = []
    for r in proto.rooms:
        if r['kind'] in CORE_KINDS + ('corridor',):
            poly = clean(r['poly'].intersection(plate))
            if poly is not None:
                rooms.append({**r, 'poly': poly})
    d = Draft(proto.typology, plate, rooms, params={k: v for k, v in proto.params.items() if k not in ('units', 'givenUp', 'scissor')})
    d.stairs = [r['poly'] for r in rooms if r['kind'] == 'stair']
    if proto.params.get('scissor'):
        d.params['scissor'] = [r['poly'] for r in rooms if r['name'] == 'Scissor stair']
    d.elevator = any(r['kind'] == 'elevator' for r in rooms)
    for hall, line in proto.corridors:
        piece, cut = clean(hall.intersection(plate), 12), line.intersection(plate)
        if piece is not None and not cut.is_empty:
            d.corridors.append((piece, cut))
    for b in proto.bays:
        inside = clean(b.frame.rect(b.a, b.b, b.v0, b.v1).intersection(plate))
        if inside is None:
            continue
        us, vs = zip(*(b.frame.local(x, z) for x, z in inside.exterior.coords))
        a, e, v0, v1 = max(b.a, min(us)), min(b.b, max(us)), max(b.v0, min(vs)), min(b.v1, max(vs))
        if e - a >= 8 and v1 - v0 >= 10 and plate.buffer(0.05).contains(b.frame.rect(a, e, v0, v1)):
            d.bays.append(Bay(b.frame, a, e, v0, v1, b.window_at_v0, b.corner_a and a <= b.a + 0.01, b.corner_b and e >= b.b - 0.01))
    if not d.bays:
        return None
    core = unary_union([r['poly'] for r in rooms if r['kind'] in CORE_KINDS]).centroid
    end = lambda b, u: Point(b.frame.pt(u, (b.v0 + b.v1) / 2)).distance(core)
    while d.plate.area > target * RULES['floor_area'].value and d.bays:
        bay = max(d.bays, key=lambda b: max(end(b, b.a), end(b, b.b)))
        cut = (d.plate.area - target) / bay.depth
        if bay.length - cut < 8:
            d.bays.remove(bay)
            gone = bay.frame.rect(bay.a, bay.b, bay.v0, bay.v1)
        elif end(bay, bay.b) >= end(bay, bay.a):
            gone = bay.frame.rect(bay.b - cut, bay.b, bay.v0, bay.v1)
            bay.b, bay.corner_b = bay.b - cut, False
        else:
            gone = bay.frame.rect(bay.a, bay.a + cut, bay.v0, bay.v1)
            bay.a, bay.corner_a = bay.a + cut, False
        d.plate = clean(d.plate.difference(gone.buffer(0.01, join_style='mitre')), 50)
    if not d.bays:
        return None
    # Corridor that no longer leads to a unit or the core is given up with the bays it served.
    served = unary_union([b.frame.rect(b.a, b.b, b.v0, b.v1) for b in d.bays] + [r['poly'] for r in d.rooms if r['kind'] in CORE_KINDS]).buffer(CORRIDOR + 1, join_style='mitre').convex_hull
    halls = []
    for hall, line in d.corridors:
        piece, cut = clean(hall.intersection(served), 12), line.intersection(served)
        if piece is not None and not cut.is_empty:
            halls.append((piece, cut))
    stubs = unary_union([h for h, _ in d.corridors]).difference(unary_union([h for h, _ in halls] or [Polygon()]))
    d.corridors = halls
    d.rooms = [r if r['kind'] != 'corridor' else {**r, 'poly': clean(r['poly'].intersection(served), 12)} for r in d.rooms]
    d.rooms = [r for r in d.rooms if r['poly'] is not None]
    if not stubs.is_empty:
        d.plate = clean(d.plate.difference(stubs.buffer(0.01, join_style='mitre')), 50)
    return d


def allocate(plates, floors, units):
    """Units on each storey, summing to the scheme's count where the plates allow: each storey starts at the
    count its plate draws best, then storeys take one unit more (or fewer) where that costs the least score,
    among counts that meet every code and zoning check. floors is the plate index of each storey."""
    choice = [plates[k]['best'] for k in floors]
    diff = units - sum(choice)
    step = 1 if diff > 0 else -1
    while diff:
        moves = [(plates[k]['fills'][choice[i]]['score'] - plates[k]['fills'][choice[i] + step]['score'], i)
                 for i, k in enumerate(floors) if plates[k]['fills'].get(choice[i] + step, {}).get('ok')]
        if not moves:
            break
        _, i = min(moves)
        choice[i] += step
        diff -= step
    return choice


def building(base, floors, site, mix, request):
    """One base plate carried through the storeys: a plate per storey group (the base, or one derived from it,
    or laid out on its own when the core does not fit), each filled with a range of unit counts, and the
    scheme's units spread over the storeys. Returns (levels, plates, floor area drawn, units drawn, score,
    whether every floor meets the code and zoning checks, the base plate)."""
    cap = unit_cap(request)
    units = request['buildingUnits'] if cap is None else min(request['buildingUnits'], cap)
    plates, of = [], []
    program = {'units': units, 'storeys': request['storeys'], 'zfa': request['zfa'], 'retail': request.get('groundRetail', True)}
    for n, (st, region, target) in enumerate(floors):
        if base.plate.within(region.buffer(0.5)) and base.plate.area <= target * RULES['floor_area'].value:
            key = 'base'
        else:
            key = (region.wkb, round(target))
        ground = st['id'] == 'storey-1'
        key = ('ground', key) if ground else key
        k = next((i for i, p in enumerate(plates) if p['key'] == key), None)
        if k is None:
            plain = key[1] if ground else key
            proto, stacked = (base, True) if plain == 'base' else (derive(base, region, target), True)
            if proto is None:
                alone = plan_floor(Site(site.lot, site.streets, region, site.district, site.overlay), mix, request['unitsPerFloor'], target, request['storeys'], units)[0]
                proto, stacked = alone['proto'], False
                lawful = not any(not c['pass'] and c['basis'] == 'law' and c['scope'] != 'building' for c in alone['checks'])
                if not (proto.stairs and cores_whole(proto) and lawful):
                    # No plate of this storey holds a whole stair and meets the code: the building ends below it.
                    floors = floors[:n]
                    break
            if ground:
                proto = ground_floor(proto, site, program)
            plates.append({'key': key, 'proto': proto, 'target': target, 'stacked': stacked, 'region': region, 'use': 'ground' if ground else 'residential'})
            k = len(plates) - 1
        of.append(k)
    # Fill each plate with a range of unit counts, then spread the scheme's units over the storeys.
    average = sum(t.share * t.target_sqft for t in mix)
    whole = sum(t for _, _, t in floors)
    for p in plates:
        expect = units * p['target'] / whole
        if not any(b.length >= 8 and b.depth >= 10 for b in p['proto'].bays):
            r = fill(clone(p['proto']), [], site, {'storeys': request['storeys'], 'units': units, 'plateSqft': p['target'], 'unitCap': None}, 0, p['target'])
            r['law'] = r['ok'] = True
            p['fills'], p['best'] = {0: r}, 0
            continue
        holds = max(1, round(sum(b.length * b.depth for b in p['proto'].bays if b.length >= 8 and b.depth >= 10) / average))
        program = {'storeys': request['storeys'], 'units': units, 'plateSqft': p['target'], 'unitCap': None}
        p['fills'] = {}
        # Each fill is kept under the units it draws, which a plate short of room leaves below the count picked; of
        # fills drawing as many, the one that meets the checks and fits the mix, then scores best.
        for c in range(max(1, min(holds, round(expect)) - 2), max(holds, round(expect)) + 3):
            r = fill(clone(p['proto']), pick_types(mix, c), site, program, expect, p['target'])
            r['law'] = not any(not x['pass'] and x['basis'] == 'law' and x['scope'] != 'building' for x in r['checks'])
            r['ok'] = r['law'] and not r['fit']
            kept = p['fills'].get(r['count'])
            if kept is None or (r['ok'], r['score']) > (kept['ok'], kept['score']):
                p['fills'][r['count']] = r
            if r['draft'].params['dealt'] < c:
                break  # a plate short of room for c deals the same units for any larger count
        # A ground floor where no unit fits beside the lobby and refuse room gives its bays to amenity space.
        if p['use'] == 'ground' and not any(r['law'] for r in p['fills'].values()):
            r = fill(clone(p['proto']), [], site, program, expect, p['target'])
            r['law'] = r['ok'] = True
            p['fills'][0] = r
        if not any(r['ok'] for r in p['fills'].values()):
            for r in p['fills'].values():
                r['ok'] = r['law']
        # The lawful fill drawing the most units stays in the choice, off the mix's sizes or not, so a bay a lawful unit
        # holds is not left over for one that fits the sizes better.
        most = max((c for c, r in p['fills'].items() if r['law']), default=None)
        if most is not None:
            p['fills'][most]['ok'] = True
        pool = [c for c, r in p['fills'].items() if r['ok']] or list(p['fills'])
        p['best'] = max(pool, key=lambda c: (p['fills'][c]['score'], -abs(c - expect)))
    counts = allocate(plates, of, units)
    levels = []
    for (st, _, _), k, c in zip(floors, of, counts):
        if levels and levels[-1]['plate'] == k and levels[-1]['count'] == c:
            levels[-1]['storeys'].append(st)
        else:
            levels.append({'plate': k, 'count': c, 'storeys': [st], 'result': plates[k]['fills'][c], 'use': plates[k]['use']})
    area = sum(lv['result']['draft'].plate.area * len(lv['storeys']) for lv in levels)
    score = sum(lv['result']['score'] * len(lv['storeys']) for lv in levels) / len(floors)
    return levels, plates, area, sum(counts), score, all(lv['result']['law'] for lv in levels), base


def typical_floor(request):
    """{lot: {frontFeet, depthFeet, lotType} or {polygon, streets}, outline (optional polygon, ft), outlines
    (optional acres.outlines/1), district, overlay, plateSqft, unitsPerFloor, storeys, buildingUnits, zfa,
    mix: [{name, type, share, targetSqft}], name} -> {plan (architecture plan v1), report}.

    The building's floors: a base plate laid out many ways on the outline most storeys share, with its
    stairs, elevator and refuse room inside the part every storey shares, then a plate of its own for each
    storey whose outline or floor area is smaller (above a deeper rear yard, behind a setback, the partial
    top storey), cut from the base plate so the core stacks. Units are spread over the storeys to sum to the
    scheme's count; each run of storeys drawn alike is one level of the plan. Where exact yards hold less than
    the envelope's stack, the outlines recover storeys above it (reserveStoreys), and all of them are drawn."""
    if 'reserveStoreys' in (request.get('outlines') or {}):
        request = {**request, 'storeys': len(stack(request))}
    lot = request['lot']
    floors = floors_of(request)
    if request.get('outlines'):
        site, _, _ = outline_site(request['outlines'], request.get('district', ''), request.get('overlay', ''), request['storeys'])
    elif 'polygon' in lot:
        site = polygon_site(lot['polygon'], lot['streets'], request.get('outline'), request.get('district', ''), request.get('overlay', ''))
    else:
        site = rectangular_site(lot['frontFeet'], lot['depthFeet'], lot.get('lotType', 'interior'), lot.get('rearYardFeet', 20.0), request.get('district', ''), request.get('overlay', ''))
        if request.get('outline'):
            site.region = Polygon(request['outline'])

    def turn_all(turn):
        nonlocal site, floors
        site = Site(turn(site.lot), turn(site.streets), turn(site.region), site.district, site.overlay, site.notes)
        floors = [(st, turn(r) if r is not None else None, t) for st, r, t in floors]
    # Lay out with the longest street along x, so walls on the street grid are exact, then turn back.
    street = max((LineString(list(g.coords)) for g in site.streets.geoms), key=lambda g: g.length)
    (x0, z0), (x1, z1) = street.coords[0], street.coords[-1]
    angle = atan2(z1 - z0, x1 - x0)
    if abs(angle) > 1e-12:
        turn_all(lambda g, a=angle: shapely.affinity.rotate(g, -a, origin=(0, 0), use_radians=True))
    # Tax-map outlines carry kinks of a fraction of an inch along their lines; drawn walls follow the
    # outline to within 3 in, so rooms do not pick up edges too short to be walls.
    tidy = lambda g: unary_union([square(p.simplify(0.25, preserve_topology=True)) for p in outline_source.parts(g)]) if isinstance(g, MultiPolygon) else square(g.simplify(0.25, preserve_topology=True))
    site.region = tidy(site.region)
    floors = [(st, tidy(r) if r is not None else site.region, t) for st, r, t in floors]
    # Then square the frame on the outline's own street face, which may sit a hair off the street line.
    faces = [seg for seg, kind in site.faces() if kind == 'street']
    if faces:
        (x0, z0), (x1, z1) = max(faces, key=lambda g: g.length).coords[:2]
        if x1 < x0:
            x0, z0, x1, z1 = x1, z1, x0, z0
        residual = atan2(z1 - z0, x1 - x0)
        if 1e-12 < abs(residual) < 0.05:
            turn_all(lambda g, a=residual: shapely.affinity.rotate(g, -a, origin=(0, 0), use_radians=True))
            angle += residual
    mix = unit_types(request)
    # A through lot's outline stands in parts, one building on each street: each part is laid out as a building
    # of its own, with its share of the floor area and units, and the parts are drawn together storey by storey.
    common = max(floors, key=lambda f: sum(1 for g in floors if g[1].equals(f[1])))[1]
    parts = outline_source.parts(common)
    units = request['buildingUnits']
    shares = [p.area / sum(q.area for q in parts) for p in parts]
    counts = [int(units * x) for x in shares]
    for i in sorted(range(len(parts)), key=lambda i: -(units * shares[i] % 1))[:units - sum(counts)]:
        counts[i] += 1
    built = []
    for part, share, n in zip(parts, shares, counts):
        part_site = Site(site.lot, site.streets, part if len(parts) > 1 else site.region, site.district, site.overlay, site.notes)
        part_floors = [(st, piece(r, part), t * piece(r, part).area / r.area) for st, r, t in floors]
        built.append(lay(part_site, part_floors, mix, {**request, 'buildingUnits': n, 'zfa': request['zfa'] * share,
                                                       'unitsPerFloor': max(1, round(request['unitsPerFloor'] * share))}))
    levels = merge_parts([b[0] for b in built])
    checks = merge_checks([b[1] for b in built], [b[0] for b in built])
    short = template_check(levels)
    if short:
        checks.append(short)
    drawn = sum(lv['count'] * len(lv['storeys']) for lv in levels)
    cap = unit_cap(request)
    if cap is not None:
        checks.append(check('dwelling_units', f'{drawn} of {cap}', drawn <= cap, limit=cap, scope='building', note='No factor applies in special density areas or to qualifying senior housing.'))
    considered = sum(b[2] for b in built)
    program = {'units': units, 'zfa': request['zfa'], 'storeys': request['storeys'], 'retail': request.get('groundRetail', True)}
    doc = plan_document([([part['result'] for part in lv['parts']], lv['storeys'], lv['use']) for lv in levels], request.get('name') or 'Floor plans')
    if abs(angle) > 1e-12:
        c, s_ = cos(angle), sin(angle)
        back = lambda p: [round(p[0] * c - p[1] * s_, 4), round(p[0] * s_ + p[1] * c, 4)]
        for w in doc['walls']:
            w['start'], w['end'] = back(w['start']), back(w['end'])
        for r in doc['rooms']:
            r['polygon'] = [back(p) for p in r['polygon']]
    out = {'plan': doc, 'report': report(levels, checks, considered, site, program, request)}
    # The envelope's gross-per-zoning factor is an assumption; the zoning sheet accounts what the floors draw.
    # A plan over the scheme's zoning floor area is drawn again with smaller floor area targets (fitted). One then
    # more than 3 percent under it, or holding it only in units larger than the scheme's (roomy), is drawn a storey
    # higher at a time into the outlines' reserve storeys until it holds it to within 3 percent; a storey that
    # carries it over the scheme's floor area is drawn with smaller floors, as above, and ends the climb. The
    # drawing kept meets every code and zoning check, then holds the floor area, then (holding it) comes nearest
    # the scheme's units, else holds the most. A stack the building ends below (a storey with no whole stair)
    # spreads the floor area over storeys it does not draw and is checked at a height it does not reach, so
    # the storeys stop rising there.
    if request.get('outlines') and 'grossScale' not in request:
        target = request['zfa']
        drawn = zoning_floor_area(doc, request['outlines'])
        out['report']['drawn']['zfaSqft'] = round(drawn)
        if drawn > target:
            fit = fitted(request, drawn)
            if not fit:
                return out
            out, drawn = fit
        if 'reserveStoreys' in request['outlines'] and (drawn < target * RULES['floor_area_used'].value or roomy(out['report'], request)):
            lawful = lambda o: not any(not c['pass'] and c['basis'] == 'law' for c in o['report']['checks'])
            holds = lambda zfa: zfa >= target * RULES['floor_area_used'].value
            tried = [(lawful(out), drawn, out)]
            for storeys in range(request['storeys'] + 1, request['storeys'] + 1 + len(request['outlines']['reserveStoreys'])):
                stacked = {**request, 'stackStoreys': storeys}
                taller = typical_floor({**stacked, 'grossScale': 1.0})
                held = zoning_floor_area(taller['plan'], request['outlines'])
                if len(stack(stacked)) < storeys or taller['report']['storeysDrawn'] < storeys:
                    break
                over = held > target
                if over:
                    fit = fitted(stacked, held)
                    if not fit or fit[0]['report']['storeysDrawn'] < storeys:
                        break
                    taller, held = fit
                taller['report']['drawn']['zfaSqft'] = round(held)
                tried.append((lawful(taller), held, taller))
                # A stack corrected from over the floor area ends the climb: a storey more only holds more.
                if over or holds(held):
                    break
            # Of drawings that hold the floor area, the one nearest the scheme's units; else the one holding the most.
            out = max(tried, key=lambda t: (t[0], holds(t[1]), -abs(t[2]['report']['unitsDrawn'] - request['buildingUnits']) if holds(t[1]) else 0, t[1]))[2]
    return out


def roomy(report, request):
    """Whether a drawing holds its floor area in fewer units than the scheme's, larger on average than its sizes allow
    (FIT_RANGE): floors too deep for the mix, which a taller stack of smaller floors may hold in the scheme's units."""
    drawn = report['drawn']
    average = sum(m['share'] * m['targetSqft'] for m in request['mix']) / sum(m['share'] for m in request['mix'])
    return 0 < drawn['units'] < request['buildingUnits'] and drawn['netSqft'] / drawn['units'] > average * FIT_RANGE[1]


def fitted(request, drawn):
    """A plan whose floors hold drawn sq ft, over the scheme's zoning floor area and so over the zoning, drawn
    again with smaller targets until a drawing holds 97 to 100 percent of it: (the drawing, the zoning floor area it
    holds). Each floor may run 3 percent over its target, so the floor area drawn moves in steps: the targets step
    down while the drawing stays over, and once one comes out under, each try is midway between the largest scale
    found over and the smallest found under. Where no try lands there, the drawing within the floor area that meets
    the code and zoning checks and holds the most, so a plan over the zoning is not kept when one within it was
    drawn; None when every try is still over it."""
    target = request['zfa']
    over, under, within = 1.0, None, []
    scale = AIM * target / drawn
    for _ in range(6):
        again = typical_floor({**request, 'grossScale': scale})
        redrawn = zoning_floor_area(again['plan'], request['outlines'])
        if redrawn > target:
            over = scale
        else:
            again['report']['drawn']['zfaSqft'] = round(redrawn)
            if redrawn >= target * RULES['floor_area_used'].value:
                return again, redrawn
            under = scale
            within.append((not any(not c['pass'] and c['basis'] == 'law' for c in again['report']['checks']), redrawn, again))
        scale = (over + under) / 2 if under is not None else scale - 0.015 * target / drawn
    if not within:
        return None
    _, redrawn, again = max(within, key=lambda w: w[:2])
    return again, redrawn


def lay(site, floors, mix, request):
    """One building on one part of the lot: the base plate laid out many ways with its core inside the part
    every storey shares, the best few carried through every storey (building), and the one kept that meets the
    code and zoning checks on every floor, then holds the floor area as its zoning sheet will account it (or most
    of it; building_zfa), then comes nearest the unit count, then scores best; with its cellar, and its ground
    floor where that storey is not residential. Returns (levels, checks, layouts considered)."""
    units = request['buildingUnits']
    # The base plate: the floor area most storeys take, its core inside the part every storey shares.
    targets = sorted({round(t) for _, _, t in floors}, key=lambda t: (-sum(1 for _, _, x in floors if round(x) == t), -t))
    base_target = targets[0]
    shared = clean(unary_union([r for _, r, _ in floors[:1]]).intersection(unary_union([r for _, r, _ in floors[1:]] or [floors[0][1]])), 100)
    for _, r, _ in floors[2:]:
        shared = clean(shared.intersection(r), 100) if shared is not None else None
    _, considered, ranked = plan_floor(site, mix, request['unitsPerFloor'], base_target, request['storeys'], units, None, shared)
    # The best few base plates, each carried through every storey; the building kept is the one that meets
    # the code and zoning checks on every floor, then holds the scheme's floor area (or most of it), then
    # comes nearest its unit count, then scores best.
    key = lambda p: (p.typology, p.params.get('band'), p.params.get('core'), round(p.plate.area, -2))
    bases = {}
    for r in ranked:
        bases.setdefault(key(r['proto']), r['proto'])
    bases = list(bases.values())[:BASES]
    built = [building(base, floors, site, mix, request) for base in bases]
    held = {id(b): building_zfa(b, site, request) for b in built}
    holds = lambda b: held[id(b)] >= request['zfa'] * RULES['floor_area_used'].value
    # The floor area comes first: where none of them holds it, the largest plate that meets the floor's checks is
    # carried through too.
    if not any(holds(b) for b in built):
        lawful = [r['proto'] for r in ranked if not any(not c['pass'] and c['basis'] == 'law' and c['scope'] != 'building' for c in r['checks'])]
        widest = max(lawful or [r['proto'] for r in ranked], key=lambda p: p.plate.area)
        if key(widest) not in {key(p) for p in bases}:
            built.append(building(widest, floors, site, mix, request))
            held[id(built[-1])] = building_zfa(built[-1], site, request)
    levels, plates, *_, base = max(built, key=lambda b: (b[5], holds(b), 0 if holds(b) else held[id(b)], -abs(b[3] - units), b[4]))
    return complete(levels, base, site, request), building_checks(levels, plates), considered


def complete(levels, base, site, request):
    """A building's levels with, below its floors, the cellar and, at grade where the ground storey is not
    residential, its retail and lobby."""
    program = {'units': request['buildingUnits'], 'zfa': request['zfa'], 'storeys': request['storeys'], 'retail': request.get('groundRetail', True)}
    levels = list(levels)
    if levels[0]['storeys'][0]['id'] != 'storey-1':
        o = outline_source.storey_outlines(request['outlines'])[0] if request.get('outlines') else None
        ground = {'id': 'storey-1', 'name': 'Ground floor', 'elevation': 0.0, 'height': round((o.height if o else STOREY_HEIGHT) * FOOT, 4)}
        levels.insert(0, {'plate': None, 'count': 0, 'storeys': [ground], 'use': 'ground',
                          'result': {**cellar(base, site, program), 'draft': ground_floor(base, site, program, residential=False)}})
    under = {'id': 'cellar', 'name': 'Cellar', 'elevation': round(-STOREY_HEIGHT * FOOT, 4), 'height': round(STOREY_HEIGHT * FOOT, 4)}
    levels.insert(0, {'plate': None, 'count': 0, 'storeys': [under], 'use': 'cellar', 'result': cellar(base, site, program)})
    return levels


def building_zfa(built, site, request):
    """The zoning floor area a building (from building) holds as its zoning sheet will account it, the cellar and
    ground floor it is completed with included; without outlines its gross floor area over the gross-per-zoning
    factor. Plates of one gross area can hold different zoning floor area (a corridor's excluded half, amenity rooms)."""
    export = request.get('outlines')
    if not export:
        return built[2] / gross_per_zfa(request)
    drawn = []
    for lv in complete(built[0], built[6], site, request):
        draft = lv['result']['draft']
        spaces = [{'kind': zoning.room_kind(r['name']), 'areaSqft': r['poly'].area} for r in draft.rooms]
        drawn += [{'name': st['name'], 'use': lv['use'], 'bottomFeet': st['elevation'] / FOOT, 'heightFeet': st['height'] / FOOT, 'spaces': spaces, 'plate': draft.plate}
                  for st in lv['storeys']]
    return zoning.account(export, outline_source.storey_outlines(export), drawn=drawn)['totals']['zfaSqft']


def merge_parts(buildings):
    """The parts' levels drawn together: each run of storeys every part draws alike is one level, holding each
    part's floor ([{storeys, use, count, parts: [part level]}], from the cellar up)."""
    at = [{st['id']: lv for lv in levels for st in lv['storeys']} for levels in buildings]
    order = sorted({st['id']: st for levels in buildings for lv in levels for st in lv['storeys']}.values(), key=lambda st: st['elevation'])
    merged = []
    for st in order:
        lvs = [m[st['id']] for m in at if st['id'] in m]
        key = tuple(id(lv) for lv in lvs)
        if merged and merged[-1]['key'] == key:
            merged[-1]['storeys'].append(st)
        else:
            merged.append({'key': key, 'storeys': [st], 'parts': lvs, 'use': lvs[0]['use'], 'count': sum(lv['count'] for lv in lvs)})
    return merged


def merge_checks(lists, buildings):
    """Each rule met only if every part meets it, the value and note taken from a part that misses it."""
    if len(lists) == 1:
        return lists[0]
    out = {}
    for checks in lists:
        for c in checks:
            if c['rule'] not in out or (out[c['rule']]['pass'] and not c['pass']):
                out[c['rule']] = dict(c)
    return list(out.values())


def template_check(levels):
    """The spaces laid out for a unit that hold no unit's rooms (place_units), counted on every storey and every
    building on the lot, as one check; None when every space laid out for a unit holds one."""
    missed = {}
    for lv in levels:
        for part in lv['parts']:
            for t in part['result']['draft'].params.get('givenUp', []):
                key = (level_name(lv['storeys']), t.name if t else 'a bay too small for any unit')
                missed[key] = missed.get(key, 0) + len(lv['storeys'])
    if not missed:
        return None
    on = {}
    for (level, name), n in missed.items():
        on.setdefault(level, []).append(f'{name} x{n}' if n > 1 else name)
    total = sum(missed.values())
    return {'rule': 'template', 'text': 'Every space laid out for a unit holds its rooms', 'value': f"{total} space{'s' if total > 1 else ''}", 'limit': 0, 'pass': False,
            'cite': 'Arosa unit templates', 'basis': 'assumption', 'scope': 'unit', 'note': '; '.join(f"{level}: {', '.join(names)}" for level, names in on.items())}


def building_checks(levels, plates):
    """A building's checks: each rule met only if it is met on every drawn floor (the floors that miss it named),
    and the building's own: every storey inside its own outline, the core stacking."""
    merged = {}
    for lv in levels:
        for c in lv['result']['checks']:
            if c['rule'] == 'template':
                continue
            m = merged.setdefault(c['rule'], {**c, 'missed': []})
            if not c['pass']:
                if not m['missed']:
                    m.update({k: v for k, v in c.items() if k != 'pass'})
                m['missed'].append(level_name(lv['storeys']))
    out = []
    for m in merged.values():
        missed = m.pop('missed')
        if missed:
            m['pass'] = False
            m['note'] = '; '.join(filter(None, [m.get('note'), f"on {', '.join(missed)}" if len(levels) > 1 else None]))
        out.append(m)
    drawn = [lv for lv in levels if lv['plate'] is not None]
    storeys = sum(len(lv['storeys']) for lv in drawn)
    inside = sum(len(lv['storeys']) for lv in drawn if plates[lv['plate']]['region'].buffer(0.5).contains(lv['result']['draft'].plate))
    out.append({'rule': 'storey_outlines', 'text': 'Every storey is drawn within its own zoning outline', 'value': f'{inside} of {storeys} storeys', 'limit': storeys, 'pass': inside == storeys,
                'cite': "ZR 23-342 and the setbacks of the option's envelope", 'basis': 'law', 'scope': 'building', 'note': None})
    loose = [level_name(lv['storeys']) for lv in drawn if not plates[lv['plate']]['stacked']]
    out.append(check('core_stack', f"{len(drawn) - len(loose)} of {len(drawn)} floor plates", not loose, scope='building',
                     note=f"{', '.join(loose)} could not keep the base floor's core inside its outline and is laid out on its own." if loose else None))
    return out


def report(levels, checks, considered, site, program, request):
    results = lambda lv: [part['result'] for part in lv['parts']]
    area = lambda lv: sum(r['draft'].plate.area for r in results(lv))
    in_units = lambda lv: sum(u['outline'].area for r in results(lv) for u in r['units'] if u['outline'] is not None)
    base = max((lv for lv in levels if lv['use'] != 'cellar'), key=lambda lv: (lv['use'] == 'residential', len(lv['storeys']), area(lv)))
    best = results(base)[0]
    draft, units = best['draft'], best['units']
    gross = draft.plate.area
    net = sum(u['outline'].area for u in units if u['outline'] is not None)
    minx, minz, maxx, maxz = draft.plate.bounds
    drawn_units = sum(lv['count'] * len(lv['storeys']) for lv in levels)
    drawn_gross = sum(area(lv) * len(lv['storeys']) for lv in levels if lv['use'] != 'cellar')
    drawn_net = sum(in_units(lv) * len(lv['storeys']) for lv in levels)
    mix = []
    for name in dict.fromkeys(m['name'] for m in request['mix']):
        of = [(u, len(lv['storeys'])) for lv in levels for r in results(lv) for u in r['units'] if u['type'].name == name]
        count = sum(n for _, n in of)
        target = next(m['targetSqft'] for m in request['mix'] if m['name'] == name)
        mix.append({'name': name, 'count': count, 'targetSqft': target, 'averageSqft': round(sum(u['outline'].area * n for u, n in of) / count) if count else None})
    capacity = max(1, int(sum(b.length * b.depth for b in draft.bays) // (sum(m['targetSqft'] * m['share'] for m in request['mix']) / sum(m['share'] for m in request['mix']))))
    passed = [c for c in checks if c['pass']]
    failed = [c for c in checks if not c['pass']]
    issues = fit_issues([u for lv in levels for r in results(lv) for u in r['units'] for _ in lv['storeys']])
    if drawn_units != request['buildingUnits']:
        average = sum(m['share'] * m['targetSqft'] for m in request['mix']) / sum(m['share'] for m in request['mix'])
        need = request['buildingUnits'] * average
        issues.insert(0, f"The floors hold {drawn_units} units against the scheme's {request['buildingUnits']}: at the scheme's sizes they need {need:,.0f} SF in units, "
                         f"and the floors put {drawn_net:,.0f} SF ({drawn_net / drawn_gross:.0%}) in units on {drawn_gross:,.0f} SF.")
    drawn_zfa = drawn_gross / gross_per_zfa(request)
    if drawn_zfa < request['zfa'] * RULES['floor_area_used'].value:
        issues.insert(0, f"The floors draw about {drawn_zfa:,.0f} SF of the scheme's {request['zfa']:,.0f} SF of zoning floor area.")
    issues += [f"{c['text']}: {c['value']}{' (' + c['note'] + ')' if c.get('note') else ''}, {c['cite']}." for c in failed]
    names = {'double-loaded corridor': 'Double-loaded corridor', 'single-loaded corridor': 'Single-loaded corridor', 'central core': 'Central core',
             'L-plan': 'L-plan', 'courtyard': 'Courtyard'}
    architect = [
        'Lot lines come from the city tax map, not a survey.',
        'Structure, shafts and mechanical, plumbing and fire protection risers are not sized.',
        'Fire ratings of walls, doors and shafts, and stair and elevator details.',
        'Type A units (NYC BC 1107.6.2.2.1) and the Type B details inside each unit.',
        'Energy code, Local Law 97 and the window-to-wall ratio.',
    ]
    if not request.get('outlines'):
        architect.insert(0, 'The outline is the lot less a rear yard, not the drawn zoning envelope for this storey.')
    corner = sum(1 for u in units if u['corner'])
    summary = (f"{names.get(draft.typology, draft.typology)}, chosen from {considered} layouts: score {best['score']:.0f} of 100, "
               f"{round(drawn_net / drawn_gross * 100)}% of the floor area in units, {sum(1 for c in passed if c['basis'] == 'law')} of "
               f"{sum(1 for c in checks if c['basis'] == 'law')} code and zoning checks met"
               + (f", {corner} corner unit{'s' if corner != 1 else ''} a floor" if corner else '')
               + (f", {len(levels)} drawn levels" if len(levels) > 1 else '')
               + (f", {len(levels[0]['parts'])} buildings on the lot" if len(levels[0]['parts']) > 1 else '') + '.')
    return {
        'layout': draft.typology, 'plate': {'width': round(maxx - minx), 'depth': round(maxz - minz), 'sqft': round(gross)},
        'unitsPerFloor': len(units), 'unitsDrawn': drawn_units, 'storeysDrawn': sum(len(lv['storeys']) for lv in levels if lv['use'] != 'cellar'), 'netSqft': round(net), 'netToGross': round(net / gross, 2), 'mix': mix,
        'drawn': {'units': drawn_units, 'grossSqft': round(drawn_gross), 'zfaSqft': round(drawn_zfa), 'netSqft': round(drawn_net)},
        'levels': [{'name': level_name(lv['storeys']), 'use': lv['use'], 'storeys': len(lv['storeys']), 'units': lv['count'], 'plateSqft': round(area(lv)), 'netSqft': round(in_units(lv))} for lv in levels],
        'fit': {'fits': not issues, 'capacity': capacity, 'issues': issues},
        'score': {'total': best['score'], 'parts': best['parts'], 'candidates': considered},
        'checks': checks,
        'egress': {k: round(v, 1) for k, v in best['egress'].items()},
        'programs': programs(site, best, program),
        'why': {'summary': summary,
                'satisfied': [f"{c['text']} ({c['cite']})" for c in passed if c['basis'] == 'law'],
                'assumed': [f"{c['text']}: {c['value']} ({c['cite']})" for c in checks if c['basis'] == 'assumption'],
                'failed': [f"{c['text']}: {c['value']} ({c['cite']})" for c in failed],
                'architect': architect},
        'siteNotes': site.notes,
    }
