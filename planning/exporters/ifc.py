"""Write IFC4 models with ifcopenshell.

write: the test-fit massing. IfcSite > IfcBuilding > IfcBuildingStorey, an IfcSlab per storey, an IfcSpace
per unit and common room, and IfcWall along the corridor and around the core.

write_plan: a detailed architecture plan v1 (architecture.py) as the architect's model. Each level is drawn once and
stands for the storeys it lists (package.storeys); every storey gets its own IfcBuildingStorey, named and at its
elevation, holding the level's slabs, walls on their centrelines with openings voided out of them and filled by doors
and windows, a space per room grouped into an IfcZone per unit, a stair in each stair room and slab openings over
stairs and elevators; one elevator runs through the storeys it serves and the top storey gets a roof slab. Property
sets carry the zoning and area figures. GlobalIds derive from the plan id, the storey and the element id, so an
element keeps its GlobalId across revisions. The model must pass schema validation and arosa.ids before it is written.

Everything is in metres. Plan x (along the frontage) maps to IFC X and plan z (into the lot) to IFC Y.
Products in a storey share one storey-relative placement and identical footprints share one extruded
shape, which keeps the file small for repeated storeys.
"""
import os
import uuid
from math import hypot

import ifcopenshell
import ifcopenshell.api.context
import ifcopenshell.api.geometry
import ifcopenshell.api.material
import ifcopenshell.api.project
import ifcopenshell.api.pset
import ifcopenshell.api.root
import ifcopenshell.api.unit
import ifcopenshell.guid
import ifcopenshell.validate
from ifctester import ids
from shapely.geometry import LineString, Polygon

import architecture as arch
from engine import ring
from exporters import package

FOOT = 0.3048
WALL_FT = 0.5
SLAB = 0.25


class Writer:
    def __init__(self, name):
        self.f = f = ifcopenshell.api.project.create_file(version='IFC4')
        self.project = ifcopenshell.api.root.create_entity(f, ifc_class='IfcProject', name=name)
        ifcopenshell.api.unit.assign_unit(f, length={'is_metric': True, 'raw': 'METERS'}, area={'is_metric': True, 'raw': 'METERS'}, volume={'is_metric': True, 'raw': 'METERS'})
        self.model = model = ifcopenshell.api.context.add_context(f, context_type='Model')
        self.body = ifcopenshell.api.context.add_context(f, context_type='Model', context_identifier='Body', target_view='MODEL_VIEW', parent=model)
        self.shapes = {}

    def placement(self, relative_to, z=0.0):
        f = self.f
        return f.createIfcLocalPlacement(relative_to, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, float(z))), None, None))

    def shape(self, ring_ft, z0, height):
        pts = tuple((round(x * FOOT, 3), round(z * FOOT, 3)) for x, z in ring_ft)
        key = (pts, round(z0, 3), round(height, 3))
        if key not in self.shapes:
            f = self.f
            curve = f.createIfcPolyline([f.createIfcCartesianPoint(p) for p in pts + pts[:1]])
            profile = f.createIfcArbitraryClosedProfileDef('AREA', None, curve)
            rep = ifcopenshell.api.geometry.add_profile_representation(f, context=self.body, profile=profile, depth=height, cardinal_point=None)
            rep.Items[0].Position = f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, float(z0))), None, None)
            self.shapes[key] = f.createIfcProductDefinitionShape(None, None, [rep])
        return self.shapes[key]

    def product(self, ifc_class, name, ring_ft, z0, height, placement, predefined=None, description=None, object_type=None):
        entity = ifcopenshell.api.root.create_entity(self.f, ifc_class=ifc_class, name=name, predefined_type=predefined)
        entity.ObjectPlacement = placement
        entity.Representation = self.shape(ring_ft, z0, height)
        if description:
            entity.Description = description
        if object_type:
            entity.ObjectType = object_type
        return entity


def wall_edges(space):
    pts = space.polygon
    edges = [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]
    if space.kind == 'core':
        return edges
    return sorted(edges, key=lambda e: -hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]))[:2]


def write(path, name, lot_ft, plans):
    w = Writer(name)
    f = w.f
    site = ifcopenshell.api.root.create_entity(f, ifc_class='IfcSite', name='Lot')
    building = ifcopenshell.api.root.create_entity(f, ifc_class='IfcBuilding', name=name)
    site.ObjectPlacement = w.placement(None)
    building.ObjectPlacement = w.placement(site.ObjectPlacement)
    site.Representation = w.shape(lot_ft, -0.3, 0.3)
    # Relationships are written directly: the api's assign_object/assign_container re-place every product,
    # which would undo the shared storey-relative placement.
    aggregate = lambda parent, children: f.createIfcRelAggregates(ifcopenshell.guid.new(), None, None, None, parent, children)
    aggregate(w.project, [site])
    aggregate(site, [building])
    storeys = []
    for p in plans:
        storey = ifcopenshell.api.root.create_entity(f, ifc_class='IfcBuildingStorey', name=p.label)
        storey.Elevation = round(p.elevation * FOOT, 3)
        storey.ObjectPlacement = w.placement(building.ObjectPlacement, p.elevation * FOOT)
        storeys.append(storey)
        local = w.placement(storey.ObjectPlacement)
        clear = p.height * FOOT - SLAB
        elements = [w.product('IfcSlab', f'{p.label} slab', p.outline, 0.0, SLAB, local, predefined='FLOOR')]
        spaces = []
        for s in p.spaces:
            description = f'{s.area_sqft:.0f} sq ft ({s.area_sqft * FOOT * FOOT:.1f} m2)'
            spaces.append(w.product('IfcSpace', s.name, s.polygon, SLAB, clear, local, predefined='PARKING' if s.kind == 'parking' else 'INTERNAL', description=description, object_type=s.unit_type or s.kind))
            if s.kind in ('corridor', 'core'):
                for a, b in wall_edges(s):
                    footprint = ring(LineString([a, b]).buffer(WALL_FT / 2, cap_style=2))
                    elements.append(w.product('IfcWall', f'{s.name} wall', footprint, SLAB, clear, local, predefined='PARTITIONING' if s.kind == 'corridor' else 'SHEAR'))
        aggregate(storey, spaces)
        f.createIfcRelContainedInSpatialStructure(ifcopenshell.guid.new(), None, None, None, elements, storey)
    aggregate(building, storeys)
    f.write(path)
    return f


def plan_guid(plan_id, element_id):
    return ifcopenshell.guid.compress(uuid.uuid5(uuid.NAMESPACE_URL, f'acres:architecture:{plan_id}/{element_id}').hex)


OPENING_CLEARANCE = 0.01  # the void runs this far past each wall face so the cut is clean
IDS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'arosa.ids')


class InvalidModel(ValueError):
    pass


def check(f):
    """Schema validation and the package's IDS requirements; raises InvalidModel naming each failure."""
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(f, logger)
    problems = [str(s.get('message', s))[:200] for s in logger.statements]
    specs = ids.open(IDS_PATH)
    specs.validate(f)
    for spec in specs.specifications:
        if not spec.status:
            failures = [failure for requirement in spec.requirements for failure in requirement.failures]
            problems.append(f'{spec.name}: {len(failures)} failing, e.g. {failures[0]["element"] if failures else ""}')
    if problems:
        raise InvalidModel('The IFC model failed validation: ' + '; '.join(problems[:10]))
    return {'schema': 'IFC4', 'ids': [spec.name for spec in specs.specifications]}


def write_plan(path, plan, account=None):
    """Write the plan as IFC4: a storey for every storey each level stands for, with its slabs, walls,
    doors, windows, rooms, units, stairs, elevators and slab openings, and property sets with the
    zoning and area figures. The model is validated before it is written. Returns
    {elementId: {ifcGlobalId, ifcClass[, ifcOpeningGlobalId]}} for the elements of each level's first storey."""
    w = Writer(plan['name'])
    f = w.f
    axis_context = ifcopenshell.api.context.add_context(f, context_type='Model', context_identifier='Axis', target_view='GRAPH_VIEW', parent=w.model)
    guid = lambda key: plan_guid(plan['id'], key)
    ids_out = {}
    marks = package.marks(plan)

    def entity(ifc_class, key, name, predefined=None):
        instance = ifcopenshell.api.root.create_entity(f, ifc_class=ifc_class, name=name, predefined_type=predefined)
        instance.GlobalId = guid(key)
        return instance

    def placement(relative_to, origin=(0.0, 0.0, 0.0), x_dir=(1.0, 0.0)):
        return f.createIfcLocalPlacement(relative_to, f.createIfcAxis2Placement3D(
            f.createIfcCartesianPoint(tuple(float(v) for v in origin)), f.createIfcDirection((0.0, 0.0, 1.0)), f.createIfcDirection((float(x_dir[0]), float(x_dir[1]), 0.0))))

    def curve(ring):
        return f.createIfcPolyline([f.createIfcCartesianPoint((float(x), float(y))) for x, y in list(ring) + [ring[0]]])

    def extrusion(points, z0, depth, holes=()):
        profile = (f.createIfcArbitraryProfileDefWithVoids('AREA', None, curve(points), [curve(hole) for hole in holes])
                   if holes else f.createIfcArbitraryClosedProfileDef('AREA', None, curve(points)))
        return f.createIfcExtrudedAreaSolid(profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, float(z0))), None, None), f.createIfcDirection((0.0, 0.0, 1.0)), float(depth))

    def body(solids, extra=()):
        return f.createIfcProductDefinitionShape(None, None, list(extra) + [f.createIfcShapeRepresentation(w.body, 'Body', 'SweptSolid', list(solids))])

    def rel(kind, key, *args):
        return getattr(f, f'create{kind}')(guid(f'rel:{kind}:{key}'), None, None, None, *args)

    def pset(product, name, properties):
        ifcopenshell.api.pset.edit_pset(f, pset=ifcopenshell.api.pset.add_pset(f, product=product, name=name), properties={k: v for k, v in properties.items() if v is not None})

    w.project.GlobalId = guid('project')
    site = entity('IfcSite', 'site', 'Site')
    building = entity('IfcBuilding', 'building', plan['name'])
    site.ObjectPlacement = placement(None)
    building.ObjectPlacement = placement(site.ObjectPlacement)
    lot = (plan.get('zoning') or {}).get('lot')
    if lot:
        site.Representation = body([extrusion([(x * FOOT, z * FOOT) for x, z in lot['exterior']], -0.3, 0.3, [[(x * FOOT, z * FOOT) for x, z in h] for h in lot.get('holes', [])])])
        pset(site, 'Pset_SiteCommon', {'TotalArea': account['lotAreaSqft'] * package.SQFT if account else lot['areaSqft'] * package.SQFT})
    ids_out.update({'site': {'ifcGlobalId': site.GlobalId, 'ifcClass': 'IfcSite'}, 'building': {'ifcGlobalId': building.GlobalId, 'ifcClass': 'IfcBuilding'}})
    rel('IfcRelAggregates', 'project', w.project, [site])
    rel('IfcRelAggregates', 'site', site, [building])
    materials = {}
    all_storeys = package.storeys(plan)
    net = package.nets(plan)
    exterior_of = {w['id']: arch.is_exterior(plan, w) for w in plan['walls']}
    runs = {}  # stair room id -> its flights, the same on every storey of its level
    lowest = all_storeys[0]['id']
    top = all_storeys[-1]['id']
    shapes = {}  # (level id, element id) -> the product definition shape every storey of the level shares

    def shared(level_id, element_id, make):
        key = (level_id, element_id)
        if key not in shapes:
            shapes[key] = make()
        return shapes[key]

    storey_entities = []
    gross_total = net_total = 0.0
    lifts = []  # stacks of elevator rooms, each room overlapping the one in the storey below
    for s in all_storeys:
        level = s['level']
        key = (lambda element_id: element_id) if s['first'] else (lambda element_id, sid=s['id']: f'{sid}/{element_id}')

        def record(element_id, instance):
            if s['first']:
                ids_out[element_id] = {'ifcGlobalId': instance.GlobalId, 'ifcClass': instance.is_a()}
            return instance
        storey = record(level['id'], entity('IfcBuildingStorey', s['id'], s['name']))
        storey.Elevation = s['elevation']
        storey.ObjectPlacement = placement(building.ObjectPlacement, (0.0, 0.0, s['elevation']))
        areas = package.storey_areas(plan, s, net, account)
        gross_total += areas['grossSqft']
        net_total += areas['netSqft']
        ifcopenshell.api.pset.edit_qto(f, qto=ifcopenshell.api.pset.add_qto(f, product=storey, name='Qto_BuildingStoreyBaseQuantities'),
                                       properties={'GrossHeight': level['height'], 'GrossFloorArea': areas['grossSqft'] * package.SQFT, 'NetFloorArea': areas['netSqft'] * package.SQFT})
        pset(storey, 'Arosa_StoreyArea', {'Use': level.get('use', 'residential'), 'GrossFloorAreaSqft': round(areas['grossSqft'], 1), 'NetFloorAreaSqft': round(areas['netSqft'], 1),
                                          'ZoningFloorAreaSqft': None if areas['zfaSqft'] is None else float(areas['zfaSqft']), 'DwellingUnits': areas['units']})
        storey_entities.append(storey)
        local = placement(storey.ObjectPlacement)
        contained = []
        rooms = package.rooms_on(plan, level['id'])
        shafts = [r for r in rooms if r.get('kind') in package.SHAFTS]
        regions = arch.floor_regions(plan, level['id'])
        for index, region in enumerate(regions):
            slab = record(region['id'], entity('IfcSlab', key(region['id']), f"{s['name']} slab" + (f' {index + 1}' if index else ''), predefined='FLOOR'))
            slab.ObjectPlacement = local
            slab.Representation = shared(level['id'], region['id'], lambda: body([extrusion(region['polygon'], -level['slabThickness'], level['slabThickness'], region['holes'])]))
            contained.append(slab)
            if s['id'] == lowest:
                continue
            region_shape = Polygon(region['polygon'], region['holes'])
            for room in shafts:
                if not region_shape.contains(Polygon(room['polygon']).representative_point()):
                    continue
                void = entity('IfcOpeningElement', key(f"{room['id']}:slab-opening"), f"{room['name']} opening", predefined='OPENING')
                void.ObjectPlacement = placement(slab.ObjectPlacement)
                void.Representation = shared(level['id'], f"{room['id']}:slab-opening", lambda: body([extrusion(room['polygon'], -level['slabThickness'] - OPENING_CLEARANCE, level['slabThickness'] + 2 * OPENING_CLEARANCE)]))
                rel('IfcRelVoidsElement', key(f"{room['id']}:slab-opening"), slab, void)
        if s['id'] == top:
            for index, region in enumerate(regions):
                roof = entity('IfcSlab', key(f"{region['id']}:roof"), 'Roof' + (f' {index + 1}' if index else ''), predefined='ROOF')
                roof.ObjectPlacement = local
                roof.Representation = shared(level['id'], f"{region['id']}:roof", lambda: body([extrusion(region['polygon'], level['height'] - level['slabThickness'], level['slabThickness'], region['holes'])]))
                contained.append(roof)
        spaces = []
        for room in rooms:
            space = record(room['id'], entity('IfcSpace', key(room['id']), room['name'], predefined='INTERNAL'))
            space.LongName = room['name']
            space.ObjectType = room.get('kind')
            space.ObjectPlacement = local
            # A room rises to the underside of the slab above, not into it.
            clear = level['height'] - level['slabThickness']
            space.Representation = shared(level['id'], room['id'], lambda: body([extrusion(net[room['id']]['ring'], 0.0, clear)]))
            ifcopenshell.api.pset.edit_qto(f, qto=ifcopenshell.api.pset.add_qto(f, product=space, name='Qto_SpaceBaseQuantities'), properties={
                'NetFloorArea': net[room['id']]['area'], 'GrossFloorArea': arch.gross_area(room), 'Height': clear})
            pset(space, 'Pset_SpaceCommon', {'Reference': room['id'], 'IsExternal': False})
            spaces.append(space)
            if room.get('kind') == 'stair' and s['id'] != top:
                run = runs.setdefault(room['id'], package.stair_runs(net[room['id']]['ring'], level['height']))
                stair = entity('IfcStair', key(f"{room['id']}:stair"), room['name'], predefined='HALF_TURN_STAIR')
                stair.ObjectPlacement = local
                stair.Representation = shared(level['id'], f"{room['id']}:stair", lambda: body(stair_solids(f, run)))
                pset(stair, 'Pset_StairCommon', {'NumberOfRiser': run['risers'], 'NumberOfTreads': run['risers'] - 2, 'RiserHeight': run['riser'], 'TreadLength': run['tread'], 'IsExternal': False})
                contained.append(stair)
            if room.get('kind') == 'elevator':
                shape = Polygon(room['polygon'])
                stack = next((stack for stack in lifts if stack[-1][0] is not s and Polygon(stack[-1][1]['polygon']).intersection(shape).area > 0.5 * shape.area), None)
                if stack is None:
                    lifts.append(stack := [])
                stack.append((s, room, local))
        for unit in package.units(plan, s, net):
            zone = entity('IfcZone', key(f"{level['id']}:unit:{unit['unitId']}"), f"Unit {unit['tag']}")
            zone.ObjectType = 'Dwelling unit'
            rel('IfcRelAssignsToGroup', key(f"{level['id']}:unit:{unit['unitId']}"), [space for space, room in zip(spaces, rooms) if room.get('unitId') == unit['unitId']], None, zone)
            pset(zone, 'Arosa_Unit', {'Unit': unit['tag'], 'UnitType': unit['unitType'], 'Bedrooms': unit['beds'], 'NetAreaSqft': round(unit['netSqft'], 1), 'GrossAreaSqft': round(unit['grossSqft'], 1)})
        for wall in (x for x in plan['walls'] if x['levelId'] == level['id']):
            length, t = arch.wall_length(wall), wall['thickness']
            ext_start, ext_end = arch.wall_extensions(plan, wall)
            exterior = exterior_of[wall['id']]
            element = record(wall['id'], entity('IfcWall', key(wall['id']), wall['id'], predefined='STANDARD'))
            element.ObjectPlacement = placement(storey.ObjectPlacement, (*wall['start'], 0.0), arch.wall_direction(wall))
            element.Representation = shared(level['id'], wall['id'], lambda: body(
                [extrusion([(-ext_start, -t / 2), (length + ext_end, -t / 2), (length + ext_end, t / 2), (-ext_start, t / 2)], 0.0, wall['height'])],
                [f.createIfcShapeRepresentation(axis_context, 'Axis', 'Curve2D', [f.createIfcPolyline([f.createIfcCartesianPoint((0.0, 0.0)), f.createIfcCartesianPoint((float(length), 0.0))])])]))
            pset(element, 'Pset_WallCommon', {'IsExternal': exterior})
            if wall['material'] not in materials:
                materials[wall['material']] = ifcopenshell.api.material.add_material(f, name=wall['material'])
            ifcopenshell.api.material.assign_material(f, products=[element], material=materials[wall['material']])
            contained.append(element)
            for opening in (o for o in plan['openings'] if o['wallId'] == wall['id']):
                void = ifcopenshell.api.root.create_entity(f, ifc_class='IfcOpeningElement', name=opening['id'], predefined_type='OPENING')
                void.GlobalId = guid(key(f"{opening['id']}:opening"))
                void.ObjectPlacement = placement(element.ObjectPlacement, (opening['offset'], 0.0, opening['sill']))
                half = t / 2 + OPENING_CLEARANCE
                void.Representation = shared(level['id'], f"{opening['id']}:opening", lambda: body([extrusion([(0.0, -half), (opening['width'], -half), (opening['width'], half), (0.0, half)], 0.0, opening['height'])]))
                rel('IfcRelVoidsElement', key(opening['id']), element, void)
                door = opening['kind'] == 'door'
                filling = record(opening['id'], entity('IfcDoor' if door else 'IfcWindow', key(opening['id']), opening['id'], predefined=opening['kind'].upper()))
                filling.Tag = marks[opening['id']]
                if s['first']:
                    ids_out[opening['id']]['ifcOpeningGlobalId'] = void.GlobalId
                filling.OverallWidth, filling.OverallHeight = opening['width'], opening['height']
                filling.ObjectPlacement = placement(void.ObjectPlacement)
                panel = 0.05 if door else 0.03
                filling.Representation = shared(level['id'], opening['id'], lambda: body([extrusion([(0.0, -panel / 2), (opening['width'], -panel / 2), (opening['width'], panel / 2), (0.0, panel / 2)], 0.0, opening['height'])]))
                if door:
                    swing = package.door_swing(plan, opening)
                    filling.OperationType = 'DOUBLE_DOOR_SLIDING' if swing['sliding'] else (
                        'SINGLE_SWING_LEFT' if (swing['hinge'] == 'start') == (swing['into'] == 1) else 'SINGLE_SWING_RIGHT')
                    pset(filling, 'Pset_DoorCommon', {'Reference': marks[opening['id']], 'IsExternal': exterior})
                else:
                    pset(filling, 'Pset_WindowCommon', {'Reference': marks[opening['id']], 'IsExternal': exterior})
                rel('IfcRelFillsElement', key(opening['id']), void, filling)
                contained.append(filling)
        if spaces:
            rel('IfcRelAggregates', s['id'], storey, spaces)
        s['contained'] = contained
        s['entity'] = storey
    # One elevator per stack of elevator rooms, in its lowest storey and as tall as the storeys it serves.
    for stops in lifts:
        s, room, local = stops[0]
        last = stops[-1][0]
        lift = entity('IfcTransportElement', f"{s['id']}/{room['id']}:elevator", 'Elevator', predefined='ELEVATOR')
        lift.ObjectPlacement = local
        inset = Polygon(net[room['id']]['ring']).buffer(-0.05, join_style='mitre')
        lift.Representation = body([extrusion(list(inset.exterior.coords)[:-1], 0.0, last['elevation'] + last['height'] - s['elevation'])])
        pset(lift, 'Arosa_Elevator', {'StoreysServed': len(stops), 'Note': 'Shaft and car zone only; the car, machine room and pit are for the elevator consultant.'})
        s['contained'].append(lift)
    for s in all_storeys:
        if s['contained']:
            rel('IfcRelContainedInSpatialStructure', s['id'], s['contained'], s['entity'])
    rel('IfcRelAggregates', 'building', building, storey_entities)
    pset(building, 'Pset_BuildingCommon', {'NumberOfStoreys': len(all_storeys), 'GrossPlannedArea': gross_total * package.SQFT, 'NetPlannedArea': net_total * package.SQFT})
    zoning = plan.get('zoning')
    if account and zoning:
        far, h, cov, du = account['far'], account['height'], account['lotCoverage'], account['dwellingUnits']
        pset(building, 'Arosa_Zoning', {
            'District': zoning['district'], 'LotAreaSqft': float(account['lotAreaSqft']), 'TaxMapLotAreaSqft': float(account['taxMapAreaSqft']),
            'FloorAreaRatioAllowed': float(far['allowed']), 'FloorAreaRatio': float(far['used']), 'ZoningFloorAreaAllowedSqft': float(far['allowedSqft']),
            'ZoningFloorAreaSqft': float(account['totals']['zfaSqft']), 'DwellingUnits': du['units'], 'DwellingUnitsAllowed': du.get('maxUnits'),
            'BuildingHeightFeet': float(h['buildingFeet']), 'HeightLimitFeet': None if h.get('limitFeet') is None else float(h['limitFeet']),
            'BaseHeightFeet': None if h.get('baseFeet') is None else float(h['baseFeet']), 'LotCoveragePercent': float(cov['percent']),
            'LotCoverageAllowedPercent': float(cov['allowedPercent']), 'ZoningResolution': package.ZR_EDITION, 'LotLines': package.SURVEY_NOTE})
    check(f)
    f.write(path)
    return ids_out


def stair_solids(f, run):
    """Each flight as a stepped profile in its vertical plane, extruded across the flight's width, and the
    landing slab: a stair an architect can read in plan and section, not a detailed design."""
    solids = []
    for origin, r, across, risers, z0 in run['flights']:
        if risers < 1:
            continue
        rise, tread = run['riser'], run['tread']
        steps = [(0.0, 0.0)]
        for k in range(risers):
            steps += [(k * tread, (k + 1) * rise), ((k + 1) * tread if k < risers - 1 else k * tread, (k + 1) * rise)]
        end = (risers - 1) * tread
        start = max(0.05, end - (risers * rise - 0.2) * tread / rise)
        steps += [(end, risers * rise - 0.2), (start, 0.0)]
        points = [steps[0]] + [p for i, p in enumerate(steps[1:], 1) if p != steps[i - 1]]
        extrude = (r[1], -r[0])  # right of the run; the profile's y axis is then up
        side = 0.0 if extrude[0] * across[0] + extrude[1] * across[1] > 0 else run['width']
        at = (origin[0] + across[0] * side, origin[1] + across[1] * side)
        profile = f.createIfcArbitraryClosedProfileDef('AREA', None, f.createIfcPolyline([f.createIfcCartesianPoint((float(u), float(v))) for u, v in points + [points[0]]]))
        position = f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((float(at[0]), float(at[1]), float(z0))), f.createIfcDirection((float(extrude[0]), float(extrude[1]), 0.0)), f.createIfcDirection((float(r[0]), float(r[1]), 0.0)))
        solids.append(f.createIfcExtrudedAreaSolid(profile, position, f.createIfcDirection((0.0, 0.0, 1.0)), float(run['width'])))
    landing = f.createIfcArbitraryClosedProfileDef('AREA', None, f.createIfcPolyline([f.createIfcCartesianPoint((float(x), float(y))) for x, y in run['landing'] + run['landing'][:1]]))
    solids.append(f.createIfcExtrudedAreaSolid(landing, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, float(run['landingZ'] - 0.2))), None, None), f.createIfcDirection((0.0, 0.0, 1.0)), 0.2))
    return solids
