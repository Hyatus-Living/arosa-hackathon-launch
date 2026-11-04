"""Zoning floor area accounting for one option: what counts, what is excluded and why, per storey
and in total, against each storey's budget; lot coverage and open space, yards as provided, height,
courts, dwelling units and parking, each figure with the Zoning Resolution section it rests on.

Inputs are the option's acres.outlines/1 export (acres-research/scheme-outlines.mjs), its storey
outlines (engine.storey_outlines) and, when one is drawn, the typical floor's spaces: a list of
{kind, areaSqft} where kind is unit, corridor, stair, elevator, lobby, mechanical, refuse, bicycle,
amenity, parking or other. The exclusion rules themselves come from the export (zoning-rules.json
bulk.floorAreaExclusions), so a text amendment is a data change. Areas are sq ft; storeys without a
drawn layout repeat the typical floor's shares scaled to their own gross area.

With a drawn typical floor (its rooms' footprint as plate) the accounting covers the building the
plan draws: the option's storey count, each storey the typical floor, checked against the outline
its yards, setbacks and coverage allow at that height (the envelope's floor area trim set aside, since
the option spreads its floor area over its own storeys) and against the option's zoning floor area
over its storeys. Coverage and yards are then measured from the drawn footprint.
"""
from dataclasses import dataclass
import math
import re

from shapely.geometry import LineString, Polygon
from shapely.ops import substring, unary_union

import outlines as outline_source

SQFT_PER_SQM = 10.7639
ROOM_KINDS = [
    ('unit', r'^unit\b|bedroom|studio'),
    ('mechanical', r'mechanical|\bmech\b|boiler|electric|meter|pump|sprinkler|telecom'),
    ('refuse', r'trash|refuse|waste|compactor|recycl'),
    ('bicycle', r'\bbike|bicycle'),
    ('amenity', r'amenity|laundry|lounge|gym|fitness|recreation|package|storage|co-?working|library|playroom'),
    ('parking', r'parking|garage'),
    ('corridor', r'^corridor|\bcorridor\b'),
    ('elevator', r'elevator|\bcore\b|shaft'),
    ('stair', r'stair'),
    ('lobby', r'lobby|vestibule|mail'),
]
# Rounding each exclusion to the square foot never reads as a storey over its budget.
BUDGET_TOLERANCE_SQFT = 5
ASSUMED_NOTE = 'Assumed as in the deal model until drawn: the planning share Arosa prices the option with, never above the section\'s limit.'


def room_kind(name):
    text = str(name).lower()
    return next((kind for kind, pattern in ROOM_KINDS if re.search(pattern, text)), 'other')


def spaces_from_plan(doc):
    """The typical floor's spaces from an architecture plan document (metres), by room name."""
    return [{'kind': room_kind(r['name']), 'name': r['name'], 'areaSqft': Polygon(r['polygon']).area * SQFT_PER_SQM} for r in doc['rooms'] if len(r.get('polygon') or []) >= 3]


def units_drawn(spaces):
    """Dwelling units on the typical floor: rooms named "Unit N ..." belong to unit N; any other unit room is one unit."""
    ids = [re.match(r'^unit\s+(\d+)\b', s.get('name', ''), re.I) for s in spaces if s['kind'] == 'unit']
    return len({m.group(1) for m in ids if m}) + sum(1 for m in ids if not m)


def plate_from_plan(doc):
    """The typical floor's footprint in feet in the concept frame: the union of its rooms."""
    return unary_union([Polygon([(x / 0.3048, z / 0.3048) for x, z in r['polygon']]) for r in doc['rooms'] if len(r.get('polygon') or []) >= 3]).buffer(0.01).buffer(-0.01)


@dataclass
class Built:
    """One storey of the building as accounted: what is drawn (geometry) and what the zoning allows there (permitted)."""
    index: int
    label: str
    use: str
    bottom: float
    top: float
    height: float
    geometry: object
    permitted: object
    zfa_budget: float
    shaped_by: list
    court_checks: list
    beyond_envelope: bool = False
    equivalent: str = None
    spaces: list = None     # the rooms drawn on this storey, when the plan draws it


def built_storeys(site, found, plate):
    if plate is None:
        return [Built(o.index, o.label, o.use, o.bottom, o.top, o.height, o.geometry, o.geometry, o.zfa_budget, o.shaped_by, o.court_checks, equivalent=o.equivalent) for o in found]
    lot = outline_source.lot_polygon(site['lot'])
    lines = outline_source.lot_lines(lot, [s['side'] for s in site['streets']])
    # The option's storeys, or, on an export with reserve storeys, the stack the outlines draw (it rises
    # where exact yards hold less than the envelope's bounding-box storeys).
    count = len(found) if 'reserveStoreys' in site else site['program']['storeys']
    out, bottom = [], found[0].bottom
    for i in range(count):
        o = found[min(i, len(found) - 1)]
        shaped = [c for c in o.shaped_by if c['control'] != 'max_area']
        permitted = outline_source.storey_geometry(site, lot, lines, shaped, o.equivalent or 'midway')
        geometry = plate if o.use == 'residential' else permitted
        out.append(Built(i, 'Ground' if i == 0 else f'Level {i + 1}', o.use, bottom, bottom + o.height, o.height, geometry, permitted,
                         site['program']['zfa'] / count, shaped, outline_source.court_checks(geometry, lot, o.courts), beyond_envelope=i >= len(found), equivalent=o.equivalent))
        bottom += o.height
    return out


def drawn_storeys(site, found, drawn):
    """Each storey the plan draws (drawn: [{name, use, bottomFeet, heightFeet, spaces, plate}] from the
    lowest up), checked against the outline its yards, setbacks and coverage allow at its height. A
    storey below curb level is a cellar: its plate is not floor area (ZR 12-10)."""
    lot = outline_source.lot_polygon(site['lot'])
    lines = outline_source.lot_lines(lot, [s['side'] for s in site['streets']])
    above = [d for d in drawn if d['bottomFeet'] >= -0.01]
    out = []
    for d in drawn:
        top = d['bottomFeet'] + d['heightFeet']
        if d['bottomFeet'] < -0.01:
            out.append(Built(-1, d['name'], 'cellar', d['bottomFeet'], top, d['heightFeet'], d['plate'], lot, 0, [], [], spaces=d['spaces']))
            continue
        i = above.index(d)
        o = found[min(i, len(found) - 1)]
        shaped, courts, beyond = [c for c in o.shaped_by if c['control'] != 'max_area'], o.courts, i >= len(found)
        # A storey the plan draws above the filled stack takes the envelope's reserve storey at that
        # height, its own controls and courts, where the export carries one.
        reserve = next((s for s in site.get('reserveStoreys', []) if s['index'] == i), None) if beyond else None
        if reserve:
            shaped, courts, beyond = [c for c in reserve['shapedBy'] if c['control'] != 'max_area'], reserve.get('courts'), False
        permitted = outline_source.storey_geometry(site, lot, lines, shaped, o.equivalent or 'midway')
        out.append(Built(i, d['name'], o.use, d['bottomFeet'], top, d['heightFeet'], d['plate'], permitted, site['program']['zfa'] / len(above), shaped,
                         outline_source.court_checks(d['plate'], lot, courts), beyond_envelope=beyond, equivalent=o.equivalent, spaces=d['spaces']))
    return out


def rule(rules, kind):
    return next(e for e in rules['excluded'] if e['kind'] == kind)


def round_half_up(value):
    return math.floor(value + 0.5)


def scaled(spaces, gross):
    plate = sum(s['areaSqft'] for s in spaces)
    k = gross / plate if plate else 0
    return {kind: sum(s['areaSqft'] for s in spaces if s['kind'] == kind) * k for kind in {s['kind'] for s in spaces}}


def reach_feet(geometry):
    """Distance from a mid-plate elevator core to the farthest unit door, taken as half the plate's
    longest dimension (the engine and the drafted floors put the core at mid-plate)."""
    minx, minz, maxx, maxz = outline_source.parts(geometry)[0].bounds
    return max(maxx - minx, maxz - minz) / 2


def account(site, storey_outlines, typical=None, plate=None, stalls_provided=0, drawn=None):
    """drawn, when the plan draws each storey (drawn_storeys), accounts every storey on its own plate and
    rooms; otherwise typical and plate are the one typical floor repeated on the option's storeys."""
    rules = site['floorAreaRules']
    storey_outlines = drawn_storeys(site, storey_outlines, drawn) if drawn else built_storeys(site, storey_outlines, plate)
    # The units the plan draws (on each storey its own, or the typical floor's on every residential storey), or the option's count.
    per_floor = units_drawn(typical or [])
    units = (sum(units_drawn(o.spaces) for o in storey_outlines if o.use == 'residential' and o.bottom >= 0) if drawn
             else per_floor * sum(1 for o in storey_outlines if o.use == 'residential' and o.bottom >= 0) if per_floor else site['program']['units'])
    assumed = site.get('assumedExclusions') or {}
    rows = []
    typical_area = sum(s['areaSqft'] for s in typical) if typical else 0
    for o in storey_outlines:
        if drawn:
            gross = o.geometry.area
            spaces = scaled(o.spaces, gross) if o.spaces else {}
        else:
            # A residential storey is drawn as the typical floor; any other storey fills its outline.
            gross = (o.geometry.area if plate is not None else typical_area) if typical and o.use == 'residential' else o.geometry.area
            spaces = scaled(typical, gross) if typical and o.use == 'residential' else {}
        rows.append({'o': o, 'gross': gross, 'drawn': spaces})
    resi_gross = sum(r['gross'] for r in rows if r['o'].use == 'residential')
    all_gross = sum(r['gross'] for r in rows)

    # Building-wide caps, shared out over the storeys in proportion to what each draws.
    def capped(kind, cap):
        total = sum(r['drawn'].get(kind, 0) for r in rows)
        return min(1.0, cap / total) if total > 0 else 0.0
    bike_required = 0 if units <= rule(rules, 'bicycle')['waivedAtOrBelowUnits'] else round_half_up(units * rule(rules, 'bicycle')['spacesPerUnit'])
    share = {
        'refuse': capped('refuse', units * rule(rules, 'refuse')['maxSqftPerUnit']),
        'bicycle': capped('bicycle', bike_required * rule(rules, 'bicycle')['maxSqftPerRequiredSpace']),
        'amenity': capped('amenity', resi_gross * rule(rules, 'amenity')['maxShareOfResidential']),
    }
    drawn_amenity = sum(r['drawn'].get('amenity', 0) for r in rows)
    amenity_room = max(0.0, resi_gross * rule(rules, 'amenity')['maxShareOfResidential'] - drawn_amenity * share['amenity'])

    storeys, totals = [], {'grossSqft': 0, 'zfaSqft': 0, 'netSqft': 0, 'budgetSqft': 0, 'byUse': {}}
    for r in rows:
        o, gross, drawn = r['o'], r['gross'], r['drawn']
        exclusions = []
        def exclude(kind, sqft, basis, note=None):
            if sqft >= 0.5:
                e = rule(rules, kind) if kind in {x['kind'] for x in rules['excluded']} else None
                exclusions.append({'kind': kind, 'sqft': round(sqft), 'basis': basis, 'section': e['section'] if e else site['exteriorWallSection'], **({'note': note} if note else {})})
        if o.use == 'cellar':
            exclude('cellar', gross, 'drawn')
            drawn = {}
        exclude('mechanical', drawn.get('mechanical', 0), 'drawn')
        if o.top <= rule(rules, 'parking')['maxTopFeet']:
            exclude('parking', drawn.get('parking', 0), 'drawn')
        reach = reach_feet(o.geometry) if not o.geometry.is_empty else 0
        if drawn.get('corridor') and reach <= rule(rules, 'corridor')['maxReachFeet']:
            exclude('corridor', drawn['corridor'] * rule(rules, 'corridor')['share'], 'drawn', f'farthest unit door about {round(reach)} ft from the core')
        for kind in ('refuse', 'bicycle', 'amenity'):
            exclude(kind, drawn.get(kind, 0) * share[kind], 'drawn')
        # The deal model's shares are of zoning floor area (gross = ZFA x grossPerZfa).
        per_gross = 1 / site['floorArea']['grossPerZfa']
        if assumed.get('amenityShare') and o.use != 'cellar':
            exclude('amenity', min(gross * assumed['amenityShare'] * per_gross, amenity_room * gross / all_gross), 'assumed', ASSUMED_NOTE)
        if assumed.get('exteriorWallShare') and o.use != 'cellar':
            exclude('exterior_wall', gross * assumed['exteriorWallShare'] * per_gross, 'assumed', ASSUMED_NOTE)
        zfa = gross - sum(e['sqft'] for e in exclusions)
        net = drawn.get('unit', 0) if drawn else None
        storeys.append({
            'index': o.index, 'label': o.label, 'use': o.use, 'bottomFeet': o.bottom, 'topFeet': o.top,
            'grossSqft': round(gross), 'outlineSqft': round(o.permitted.area), 'fitsOutline': fits(o, gross), 'zfaSqft': round(zfa), 'netSqft': round(net) if net is not None else None,
            'footprint': polygons(o.geometry), 'permitted': polygons(o.permitted),
            **({'beyondEnvelope': True} if o.beyond_envelope else {}),
            'budgetSqft': round(o.zfa_budget), 'overBudgetSqft': round(zfa - o.zfa_budget) if zfa - o.zfa_budget > BUDGET_TOLERANCE_SQFT else 0,
            'exclusions': exclusions, 'counted': [c for c in rules['counted'] if drawn.get(c['kind'])],
        })
        totals['grossSqft'] += gross
        totals['zfaSqft'] += zfa
        totals['netSqft'] += net or 0
        totals['budgetSqft'] += o.zfa_budget
        if o.use != 'cellar':
            totals['byUse'][o.use] = totals['byUse'].get(o.use, 0) + zfa
    # Zoning floor area is a limit on the zoning lot (ZR 23-22), not on each storey: a storey holding more than its
    # share is over budget only where the building holds more than the option's floor area.
    if totals['zfaSqft'] - totals['budgetSqft'] <= BUDGET_TOLERANCE_SQFT:
        for s in storeys:
            s['overBudgetSqft'] = 0
    lot = outline_source.lot_polygon(site['lot'])
    lot_area = lot.area
    # Floor area is figured on the lot area on record; coverage and yards on the tax-map polygon.
    recorded = site['lot'].get('recordedAreaSqft') or lot_area
    totals = {k: (round(v) if not isinstance(v, dict) else {u: round(a) for u, a in v.items()}) for k, v in totals.items()}
    if not typical:
        totals['netSqft'] = None
    building = unary_union([o.geometry for o in storey_outlines if o.bottom >= 0])
    return {
        'storeys': storeys,
        'totals': totals,
        'overBudget': [s['label'] for s in storeys if s['overBudgetSqft'] > 0],
        'outsideOutline': [s['label'] for s in storeys if not s['fitsOutline']],
        # The floor area the option is priced at that its drawn storeys do not hold.
        'optionShortfallSqft': max(0, round(site['program']['zfa'] - totals['zfaSqft'])) if plate is not None or drawn else 0,
        'far': {'allowed': site['zoningFloorArea']['allowedFar'], 'allowedSqft': site['zoningFloorArea']['allowedSqft'], 'used': round(totals['zfaSqft'] / recorded, 2), 'option': site['zoningFloorArea']['optionFar'], 'sections': site['zoningFloorArea']['sections']},
        'lotAreaSqft': round(recorded), 'taxMapAreaSqft': round(lot_area),
        'lotCoverage': coverage(site, building, recorded),
        'yards': yards(site, lot, storey_outlines),
        'cornerPortion': {'footprint': polygons(corner_portion(site, lot, storey_outlines)), 'section': (corner_control(storey_outlines) or {}).get('cornerSection')},
        'portions': [{'label': p['label'], 'sharePercent': p['sharePercent'], 'minBaseFeet': p.get('minBaseHeightFeet'), 'maxBaseFeet': p.get('maxBaseHeightFeet'), 'heightLimitFeet': p.get('heightLimitFeet'),
                      'footprint': polygons(region), 'sections': p['sections']}
                     for p, region in zip(site.get('portions') or [], outline_source.portion_regions(site, lot, outline_source.lot_lines(lot, [s['side'] for s in site['streets']])) if site.get('portions') else [])],
        'height': height(site, storey_outlines),
        'courts': [dict(storey=o.label, **c) for o in storey_outlines for c in o.court_checks],
        'dwellingUnits': dwelling_units(site, units),
        'parking': parking(site, stalls_provided),
        'bicycleParking': {'required': bike_required, 'section': 'ZR 25-81'},
    }


def polygons(geometry):
    return [{'exterior': outline_source.ring_of(p.exterior), 'holes': [outline_source.ring_of(h) for h in p.interiors]} for p in outline_source.parts(geometry)]


def fits(o, gross):
    """A drawn floor fits when it stays inside what its storey allows (half a foot of drawing tolerance)."""
    if o.geometry is o.permitted:
        return gross <= o.permitted.area + 1
    return o.geometry.difference(o.permitted.buffer(0.5)).area < 1 and gross <= o.permitted.area + 1


def coverage(site, building, lot_area):
    allowed = site['coverage'].get('basePercent')
    used = building.area / lot_area * 100
    return {'percent': round(used, 1), 'allowedPercent': allowed, 'coveredSqft': round(building.area), 'openSpaceSqft': round(lot_area - building.area),
            'pass': allowed is None or used <= allowed + 0.05, 'sections': site['coverage']['sections']}


def yards(site, lot, storey_outlines):
    """Each yard the controls require, against the depth the outlines leave, measured from the lot line."""
    streets, rears, sides = outline_source.lot_lines(lot, [s['side'] for s in site['streets']])
    # A rear yard is measured only where one is required: not within a corner lot's corner portion.
    exempt = corner_portion(site, lot, storey_outlines)
    rears = [part for line in rears for part in line_parts(line.difference(exempt))] if not exempt.is_empty else rears
    # On a lot in portions (a wide-street portion, a split lot's districts) each portion's yards are
    # measured within that portion: its stretch of the lot line, the building inside its region.
    regions = outline_source.portion_regions(site, lot, (streets, rears, sides)) if site.get('portions') else []
    out = []
    for kind, lines in (('rear_yard', rears), ('side_yard', sides), ('front_yard', [l for g in streets.values() for l in g])):
        required = {}
        for o in storey_outlines:
            for c in o.shaped_by:
                if c['control'] == kind and c['feet']:
                    required.setdefault((c['feet'], c.get('portion', -1)), []).append(o)
        for (feet, portion), at in sorted(required.items()):
            region = regions[portion] if portion >= 0 and regions else None
            near = [part for line in lines for part in line_parts(line.intersection(region.buffer(0.5)))] if region is not None else lines
            built = [o.geometry.intersection(region) if region is not None else o.geometry for o in at]
            built = [g for g in built if not g.is_empty and g.area >= 1]
            if not near or not built:
                continue
            provided = min(depth_from(line, g, lot) for line in near for g in built)
            if provided >= (lot.bounds[2] - lot.bounds[0]) + (lot.bounds[3] - lot.bounds[1]) - 1:
                continue  # nothing in this portion faces the line, so it holds no such yard
            section = next(c['section'] for c in at[0].shaped_by if c['control'] == kind)
            where = f'{at[0].label} to {at[-1].label}' if len(at) > 1 else at[0].label
            out.append({'yard': kind, 'requiredFeet': feet, 'providedFeet': round(provided, 1), 'storeys': where, **({'portion': site['portions'][portion]['label']} if region is not None else {}),
                        'pass': provided >= feet - 0.1, 'section': section})
    equivalent = next((c for o in storey_outlines for c in o.shaped_by if c['control'] == 'rear_yard_equivalent'), None)
    if equivalent:
        place = storey_outlines[0].equivalent or 'midway'
        out.append({'yard': 'rear_yard_equivalent', 'requiredFeet': equivalent['feet'], 'providedFeet': equivalent['feet'], 'storeys': outline_source.EQUIVALENT_PLACES[place], 'place': place,
                    'pass': True, 'section': equivalent['section'] + ('(c)(2)' if place != 'midway' else '')})
    return out


def corner_control(storey_outlines):
    return next((c for o in storey_outlines for c in o.shaped_by if c['control'] == 'rear_yard' and c.get('cornerPortionFeet')), None)


def corner_portion(site, lot, storey_outlines):
    """The corner portion the rear yard controls exempt (ZR 12-10), or an empty geometry."""
    c = corner_control(storey_outlines)
    if not c:
        return outline_source.assemble.EMPTY
    streets, _, _ = outline_source.lot_lines(lot, [s['side'] for s in site['streets']])
    return outline_source.corner_portions(lot, streets, c['cornerPortionFeet'])


def line_parts(geometry):
    lines = geometry.geoms if hasattr(geometry, 'geoms') else [geometry]
    return [l for l in lines if isinstance(l, LineString) and l.length >= 1]


def depth_from(line, geometry, lot):
    """How far the building stands from a lot line, measured square to it within the line's own span."""
    reach = (lot.bounds[2] - lot.bounds[0]) + (lot.bounds[3] - lot.bounds[1])
    # A hair short of each end, so a building that only touches the line's end corner is not read as on it.
    inner = substring(line, 0.1, line.length - 0.1)
    facing = outline_source.parts(geometry.intersection(inner.buffer(reach, cap_style='flat')))
    return min(line.distance(p) for p in facing) if facing else reach


def height(site, storey_outlines):
    above = [o for o in storey_outlines if o.bottom >= 0]
    top = max(o.top for o in above)
    base = max((o.top for o in above if not any(c['control'] == 'setback' for c in o.shaped_by)), default=0)
    wall = site['streetWall']
    limit = site.get('heightLimitFeet')
    return {'buildingFeet': top, 'limitFeet': limit, 'storeys': len(above), 'baseFeet': base,
            'minBaseFeet': wall.get('minBaseHeightFeet'), 'maxBaseFeet': wall.get('maxBaseHeightFeet', wall.get('maxFrontWallFeet')),
            'pass': (limit is None or top <= limit + 0.01) and (not wall.get('minBaseHeightFeet') or base >= wall['minBaseHeightFeet'] - 0.01 or top < wall['minBaseHeightFeet']),
            'sections': sorted(set(wall.get('sections', []) + site['setbacks'].get('sections', [])))}


def dwelling_units(site, units):
    """ZR 23-52: the maximum residential floor area permitted on the zoning lot over the dwelling unit
    factor, fractions of three-quarters or more counting as a unit; no factor in the special density areas."""
    density = site.get('density') or {}
    factor = density.get('dwellingUnitFactor')
    cap = None
    if factor:
        quotient = site['zoningFloorArea']['allowedSqft'] / factor
        cap = math.floor(quotient) + (1 if quotient - math.floor(quotient) >= 0.75 else 0)
    return {'units': units, 'optionUnits': site['program']['units'], 'maxUnits': cap, 'factor': factor, 'pass': cap is None or units <= cap, 'sections': density.get('sections', ['ZR 23-52'])}


def parking(site, provided):
    p = site['parking']
    if p.get('transitZones'):
        zones = {zone: {'required': z.get('required'), 'waiverSpaces': z.get('waiverSpaces'), 'waived': z.get('waived', False), 'sections': z.get('sections', [])} for zone, z in p['transitZones'].items()}
        required = None
    else:
        zones, required = None, p.get('required')
    return {'required': required, 'byTransitZone': zones, 'provided': provided, 'manhattanCore': bool(p.get('manhattanCore')),
            'transitZone': p.get('transitZone'), 'transitZoneSource': p.get('transitZoneSource'),
            'maxResidentialSpaces': p.get('maxResidentialSpaces'), 'note': p.get('note'), 'sections': p.get('sections', [])}
