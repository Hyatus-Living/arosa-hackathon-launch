"""Measured IFC intake and point-to-surface checks in model engineering coordinates (metres)."""
import hashlib
import os
import tempfile
import uuid

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np
from shapely.geometry import MultiPoint

MAX_POINTS = 50000


class UnsupportedGeometry(ValueError):
    pass


def shape(element):
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    created = ifcopenshell.geom.create_shape(settings, element)
    geometry = created.geometry
    return np.asarray(geometry.verts).reshape(-1, 3), np.asarray(geometry.faces).reshape(-1, 3)


def key(element):
    return 'ifc-' + hashlib.sha256(element.GlobalId.encode()).hexdigest()[:24]


def rectangular_wall(element, unit_scale):
    points, _ = shape(element)
    hull = MultiPoint(points[:, :2]).convex_hull
    rectangle = hull.minimum_rotated_rectangle
    if rectangle.geom_type != 'Polygon' or rectangle.area < .001 or hull.symmetric_difference(rectangle).area > .001:
        raise UnsupportedGeometry('The wall footprint is curved or nonrectangular.')
    low, high = points[:, 2].min(), points[:, 2].max()
    bottom = MultiPoint(points[np.abs(points[:, 2] - low) < .001, :2]).convex_hull
    top = MultiPoint(points[np.abs(points[:, 2] - high) < .001, :2]).convex_hull
    if bottom.geom_type != 'Polygon' or top.geom_type != 'Polygon' or bottom.hausdorff_distance(top) > .001:
        raise UnsupportedGeometry('The wall is sloped or has a varying height.')
    corners = np.asarray(rectangle.exterior.coords)[:4]
    edges = np.roll(corners, -1, axis=0) - corners
    lengths = np.linalg.norm(edges, axis=1)
    index = int(lengths.argmax())
    direction = edges[index] / lengths[index]
    if tuple(direction) < (0, 0):
        direction *= -1
    centre = corners.mean(axis=0)
    length, thickness = float(lengths.max()), float(lengths.min())
    if length < .05 or high - low < .05:
        raise UnsupportedGeometry('The wall is smaller than the editable model limits.')
    start, end = (centre - direction * length / 2).tolist(), (centre + direction * length / 2).tolist()
    # Native axes preserve junction endpoints rather than extending a centreline to physical end caps.
    axes = [r for r in element.Representation.Representations if r.RepresentationIdentifier == 'Axis']
    if axes and len(axes[0].Items) == 1 and axes[0].Items[0].is_a('IfcPolyline'):
        axis = axes[0].Items[0]
        if len(axis.Points) == 2:
            placement = ifcopenshell.util.placement.get_local_placement(element.ObjectPlacement)
            ends = [(placement @ np.array([*p.Coordinates, *([0.] * (3 - len(p.Coordinates))), 1.]))[:2] * unit_scale for p in axis.Points]
            axis_length = np.linalg.norm(ends[1] - ends[0])
            parallel = axis_length >= .05 and abs(np.dot((ends[1] - ends[0]) / axis_length, direction)) > 1 - 1e-8
            delta = (ends[0] + ends[1]) / 2 - centre
            centred = abs(direction[0] * delta[1] - direction[1] * delta[0]) < .001
            if parallel and centred and length - 2 * thickness - .005 <= axis_length <= length + .001 and all(hull.buffer(.001).covers(MultiPoint([p])) for p in ends):
                start, end = [p.tolist() for p in ends]
    return {'id': key(element), 'start': start,
            'end': end, 'height': float(high - low),
            'thickness': thickness, 'material': 'generic', 'roomIds': [], 'ifcGlobalId': element.GlobalId}, float(low)


def import_ifc(path, name):
    model = ifcopenshell.open(path)
    unit_scale = ifcopenshell.util.unit.calculate_unit_scale(model)
    elements = model.by_type('IfcElement') + model.by_type('IfcSpace')
    if len(elements) > 10000 or len(model.by_type('IfcWall')) > 1000:
        raise ValueError('Import a building section with at most 1,000 walls and 10,000 elements.')
    plan = {'schema': 'acres.architecture.plan/1', 'id': None, 'revision': None, 'parentRevision': None,
            'name': name[:200], 'units': 'm', 'levels': [], 'walls': [], 'openings': [], 'rooms': [], 'objects': [], 'sources': []}
    imported, omitted, wall_map = set(), [], {}
    for element in model.by_type('IfcWall'):
        try:
            wall, elevation = rectangular_wall(element, unit_scale)
        except (UnsupportedGeometry, RuntimeError) as error:
            omitted.append({'globalId': element.GlobalId, 'type': element.is_a(), 'name': element.Name or '', 'reason': str(error)[:200]})
            continue
        storey = ifcopenshell.util.element.get_container(element)
        level = next((l for l in plan['levels'] if abs(l['elevation'] - elevation) < .001), None)
        if level is None:
            level = {'id': f'level-{len(plan["levels"]) + 1}', 'name': (storey.Name if storey else None) or f'Level {len(plan["levels"]) + 1}',
                     'elevation': elevation, 'height': wall['height'], 'slabThickness': .2}
            plan['levels'].append(level)
        level['height'] = max(level['height'], wall['height'])
        wall['levelId'] = level['id']
        plan['walls'].append(wall)
        wall_map[element.id()] = (wall, elevation)
        imported.add(element.id())
    if not plan['walls']:
        raise ValueError('No straight, vertical rectangular walls could be imported. Keep the IFC as a reference and simplify the unsupported geometry first.')
    for kind in ('IfcDoor', 'IfcWindow'):
        for element in model.by_type(kind):
            try:
                fills = element.FillsVoids
                if not fills or not fills[0].RelatingOpeningElement.VoidsElements:
                    raise UnsupportedGeometry('The element has no opening linked to a wall.')
                void = fills[0].RelatingOpeningElement
                parent = void.VoidsElements[0].RelatingBuildingElement
                if parent.id() not in wall_map:
                    raise UnsupportedGeometry('The parent wall could not be imported.')
                wall, base = wall_map[parent.id()]
                points, _ = shape(void)
                start, end = np.asarray(wall['start']), np.asarray(wall['end'])
                length = float(np.linalg.norm(end - start))
                along = (points[:, :2] - start) @ ((end - start) / length)
                offset, far = float(along.min()), float(along.max())
                sill, top = float(points[:, 2].min() - base), float(points[:, 2].max() - base)
                # Curved, triangular and arched voids must not become a rectangular opening silently.
                projected = MultiPoint(np.column_stack((along, points[:, 2]))).convex_hull
                if abs(projected.area - (far - offset) * (top - sill)) > .001:
                    raise UnsupportedGeometry('The opening is not rectangular.')
                if offset < -.001 or far > length + .001 or sill < -.001 or top > wall['height'] + .001:
                    raise UnsupportedGeometry('The opening extends beyond the editable wall.')
                plan['openings'].append({'id': key(element), 'wallId': wall['id'], 'kind': 'door' if kind == 'IfcDoor' else 'window',
                                         'offset': max(0, offset), 'width': min(length, far) - max(0, offset),
                                         'sill': max(0, sill), 'height': min(wall['height'], top) - max(0, sill),
                                         'swing': None, 'ifcGlobalId': element.GlobalId})
                imported.update((element.id(), void.id()))
            except (UnsupportedGeometry, RuntimeError) as error:
                omitted.append({'globalId': element.GlobalId, 'type': kind, 'name': element.Name or '', 'reason': str(error)[:200]})
    reported = {x['globalId'] for x in omitted}
    for element in elements:
        if element.id() not in imported and element.GlobalId not in reported:
            omitted.append({'globalId': element.GlobalId, 'type': element.is_a(), 'name': element.Name or '',
                            'reason': 'Retained in the source IFC; not represented by the editable wall and opening model.'})
    return {'plan': plan, 'report': {'schema': 'acres.ifc-import/1', 'importedWalls': len(plan['walls']),
            'importedOpenings': len(plan['openings']), 'omitted': omitted,
            'coordinates': 'Metres in IFC engineering coordinates, including object placements. IFC map conversion is not applied.',
            'derived': 'Rooms and floor surfaces are derived from editable walls; original slabs, roofs, materials and property sets remain in the source IFC.'}}


def read_points(path, extension):
    if extension in ('las', 'laz'):
        import laspy
        with laspy.open(path) as reader:
            total = reader.header.point_count
            if total > 5000000:
                raise ValueError('Use a scan section containing at most 5 million points.')
            cloud = reader.read()
        points = np.column_stack((cloud.x, cloud.y, cloud.z))
    elif extension == 'ply':
        from plyfile import PlyData
        cloud = PlyData.read(path)['vertex']
        points = np.column_stack((cloud['x'], cloud['y'], cloud['z']))
    elif extension == 'xyz':
        points = np.loadtxt(path, ndmin=2)
        if points.shape[1] != 3:
            raise ValueError('XYZ files must contain three space-separated coordinates per row.')
    else:
        raise ValueError('Use a PLY, LAS, LAZ or XYZ point cloud.')
    if points.ndim != 2 or points.shape[1] != 3 or len(points) == 0 or not np.isfinite(points).all():
        raise ValueError('The scan must contain finite XYZ points.')
    return np.asarray(points, dtype=np.float64)


def validate_scan(path, extension, plan, units, tolerance):
    import trimesh
    from exporters.ifc import write_plan
    import architecture
    if units not in ('m', 'mm', 'ft') or not .001 <= tolerance <= 1:
        raise ValueError('Choose metres, millimetres or feet and a tolerance between 1 and 1,000 mm.')
    errors = architecture.validate(plan)
    if errors:
        raise ValueError('Fix the model validation errors before checking a scan: ' + str(errors[0]))
    points = read_points(path, extension)
    total = len(points)
    # Deterministic uniform-by-index sampling; report the sample size rather than implying full coverage.
    points = points[np.linspace(0, total - 1, min(total, MAX_POINTS), dtype=int)] * {'m': 1, 'mm': .001, 'ft': .3048}[units]
    doc = {**plan, 'id': plan['id'] or str(uuid.uuid4()), 'revision': plan['revision'] or 1}
    with tempfile.TemporaryDirectory() as directory:
        model_path = os.path.join(directory, 'model.ifc')
        write_plan(model_path, doc)
        model = ifcopenshell.open(model_path)
        meshes = []
        for element in model.by_type('IfcElement'):
            if element.is_a('IfcOpeningElement') or not element.Representation:
                continue
            vertices, faces = shape(element)
            if len(faces):
                meshes.append(trimesh.Trimesh(vertices=vertices, faces=faces, process=False))
        if not meshes:
            raise ValueError('The current model has no physical surfaces to check.')
        mesh = trimesh.util.concatenate(meshes)
        distances = np.concatenate([trimesh.proximity.closest_point(mesh, chunk)[1] for chunk in np.array_split(points, max(1, int(np.ceil(len(points) / 500))))])
    display = np.linspace(0, len(points) - 1, min(len(points), 2000), dtype=int)
    return {'schema': 'acres.scan-validation/1', 'totalPoints': total, 'testedPoints': len(points),
            'sampled': total > len(points), 'toleranceMetres': tolerance, 'withinTolerance': int((distances <= tolerance).sum()),
            'withinPercent': float(100 * (distances <= tolerance).mean()), 'medianMetres': float(np.median(distances)),
            'p95Metres': float(np.quantile(distances, .95)), 'maxMetres': float(distances.max()),
            'points': [{'x': float(points[i, 0]), 'y': float(points[i, 1]), 'z': float(points[i, 2]), 'distance': float(distances[i])} for i in display],
            'scope': 'Unsigned distance from sampled scan points to current model surfaces. This does not establish completeness, registration accuracy or survey accuracy.'}


def run(request):
    if request['operation'] == 'import-ifc':
        return import_ifc(request['inputPath'], request['name'])
    if request['operation'] == 'validate-scan':
        return validate_scan(request['inputPath'], request['extension'], request['plan'], request['units'], request['tolerance'])
    raise ValueError('Unknown model intake operation.')
