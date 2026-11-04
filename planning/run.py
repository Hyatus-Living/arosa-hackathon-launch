"""JSON stdin/stdout wrapper for the acres_plan_concept tool: test-fit massing or a detailed plan.

Detailed plan request: {"layout": {the sample-floorplan.json shape, "units": "ft" or "m"}, "planId": str,
  "revision": int, "parentRevision": int | null, "outDir": str}, or {"plan": an architecture plan v1 document,
  "outDir": str}, which exports a plan the caller already stored in outDir/plan.json without rewriting it.
Response: {"plan": {id, revision, parentRevision, name, counts, rooms, sheets}, "artifacts": {"plan", "svg", "ifc",
  "pascalScene", "idMap", "drawings", "dxf", "schedules", "selfcheck", "package", and with zoning "zd1Svg", "zd1Pdf",
  "zoning": {"file", "sha256", "bytes"}}}: the architect's package (drawing set, DXF, schedules, self-check and their zip). The layout is converted to architecture plan v1
(metres) and validated before anything is written; an invalid plan prints {"error", "validationErrors"}.

Typical floor request: {"typicalFloor": {lot, outlines (optional acres.outlines/1), district, overlay, plateSqft,
  unitsPerFloor, storeys, buildingUnits, zfa, mix, name}} (layout.typical_floor). Response: {"plan": an
  architecture plan v1 document, "report": the layout report with its checks and why this plan}.

Test-fit request (feet, acres_model_concept frame):
  {"name": str, "summary": str, "lot": [[x, z], ...],
   "levels": [{"label": str, "use": str, "footprint": [[x, z], ...], "height": ft,
               "count": int, "belowGrade": bool}, ...],
   "mix": [{"name": str, "share": 0..1, "targetSqft": n}, ...],   optional
   "maxFar": n, "maxHeightFeet": n,                                optional modeled gross FAR/height limits
   "ifc": bool,                                                    write IFC4 when true
   "outDir": str}                                                  required with "ifc"; the plan revision directory

Response: {"takeoffs": {...}, "pascal": {acres_model_concept arguments},
           "artifacts": {"ifc": {"file": "model.ifc", "sha256": str, "bytes": int}} (only when IFC was written)}
Errors print {"error": message} and exit 1.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import architecture
import layout
from engine import Rules, Storey, UnitType, plan
from exporters import drawings, dxf, package, pascal, svg, zd1

try:
    from exporters import ifc
except ImportError:
    ifc = None

# The files an architect receives for an option, also zipped together as package.zip.
PACKAGE_FILES = ['drawings.pdf', 'zd1.pdf', 'model.ifc', 'drawings.dxf', 'schedules.xlsx', 'selfcheck.json']

DEFAULT_MIX = [
    {'name': 'studio', 'share': 0.20, 'targetSqft': 450},
    {'name': '1br', 'share': 0.45, 'targetSqft': 650},
    {'name': '2br', 'share': 0.25, 'targetSqft': 950},
    {'name': '3br', 'share': 0.10, 'targetSqft': 1250},
]


def artifact(out_dir, name):
    with open(os.path.join(out_dir, name), 'rb') as handle:
        data = handle.read()
    return {'file': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


class PlanInvalid(ValueError):
    def __init__(self, errors):
        super().__init__('Plan validation failed: ' + '; '.join(f"{e['code']} ({e['id']}): {e['message']}" for e in errors))
        self.errors = errors


def run(request):
    if 'operation' in request:
        import model_intake
        return model_intake.run(request)
    if 'typicalFloor' in request:
        return layout.typical_floor(request['typicalFloor'])
    if 'plan' in request:
        return run_detailed(request['plan'], request['outDir'], write_plan=False)
    if 'layout' in request:
        doc = architecture.from_layout(request['layout'], request['planId'], request['revision'], request.get('parentRevision'))
        return run_detailed(doc, request['outDir'], write_plan=True)
    return run_test_fit(request)


def run_detailed(doc, out_dir, write_plan):
    errors = architecture.validate(doc)
    if errors:
        raise PlanInvalid(errors)
    doc = {**doc, 'levels': [{'slabThickness': architecture.SLAB_THICKNESS, **level} for level in doc['levels']]}
    os.makedirs(out_dir, exist_ok=True)

    def write(name, text):
        with open(os.path.join(out_dir, name), 'w') as handle:
            handle.write(text)
    if write_plan:
        write('plan.json', json.dumps(doc, indent=1))
    write('plan.svg', svg.render(doc))
    account = zd1.write(doc, out_dir) if doc.get('zoning') else None
    ifc_ids = ifc.write_plan(os.path.join(out_dir, 'model.ifc'), doc, account)
    zoning_sheet = zd1.draw(doc['zoning'], account, ', '.join(part for part in (doc['zoning'].get('address'), doc['zoning'].get('label') or doc['name']) if part)) if account else None
    sheets = drawings.write(doc, out_dir, account, zoning_sheet)
    dxf.write(doc, out_dir)
    package.write_zip(out_dir, [name for name in PACKAGE_FILES if os.path.exists(os.path.join(out_dir, name))])
    scene, pascal_ids = pascal.scene(doc)
    write('pascal-scene.json', json.dumps(scene))
    write('idmap.json', json.dumps({
        'schema': 'acres.architecture.idmap/1', 'planId': doc['id'], 'revision': doc['revision'],
        'ifcProjectGlobalId': ifc.plan_guid(doc['id'], 'project'),
        'elements': {element_id: {**ifc_ids[element_id], 'pascalNodeId': node_id} for element_id, node_id in pascal_ids.items()},
    }, indent=1))
    kinds = [o['kind'] for o in doc['openings']]
    return {
        'plan': {
            'id': doc['id'], 'revision': doc['revision'], 'parentRevision': doc['parentRevision'], 'name': doc['name'],
            'counts': {'levels': len(doc['levels']), 'walls': len(doc['walls']), 'openings': len(kinds), 'doors': kinds.count('door'), 'windows': kinds.count('window'), 'rooms': len(doc['rooms'])},
            'rooms': [{'id': r['id'], 'name': r['name'], 'netArea': architecture.net_area(doc, r)} for r in doc['rooms']],
            'sheets': sheets,
        },
        'artifacts': {key: artifact(out_dir, name) for key, name in (('plan', 'plan.json'), ('svg', 'plan.svg'), ('ifc', 'model.ifc'), ('pascalScene', 'pascal-scene.json'), ('idMap', 'idmap.json'), ('zd1Svg', 'zd1.svg'), ('zd1Pdf', 'zd1.pdf'), ('zoning', 'zoning.json'),
                                                                 ('drawings', 'drawings.pdf'), ('dxf', 'drawings.dxf'), ('schedules', 'schedules.xlsx'), ('selfcheck', 'selfcheck.json'), ('package', 'package.zip'))
                      if os.path.exists(os.path.join(out_dir, name))},
    }


def run_test_fit(request):
    lot = request['lot']
    storeys = []
    for i, level in enumerate(request['levels']):
        storeys.append(Storey(
            level.get('label') or f'Storey {i + 1}',
            level.get('use') or 'residential',
            level['footprint'],
            level['height'],
            count=level.get('count', 1),
            below_grade=bool(level.get('belowGrade')),
        ))
    mix = [UnitType(m['name'], float(m['share']), float(m['targetSqft'])) for m in (request.get('mix') or DEFAULT_MIX)]
    plans, takeoffs = plan(lot, storeys, mix, Rules(), max_far=request.get('maxFar'), max_height=request.get('maxHeightFeet'))
    out = {
        'takeoffs': takeoffs,
        'pascal': pascal.concept_args(
            request.get('name') or 'Planned concept',
            request.get('summary') or '',
            lot, plans,
            max_far=request.get('maxFar'),
            max_height=request.get('maxHeightFeet'),
        ),
    }
    if request.get('ifc'):
        if ifc is None:
            out['ifcNote'] = 'ifcopenshell is not installed in the planning environment, so no IFC was written.'
        else:
            os.makedirs(request['outDir'], exist_ok=True)
            ifc.write(os.path.join(request['outDir'], 'model.ifc'), request.get('name') or 'Planned concept', lot, plans)
            out['artifacts'] = {'ifc': artifact(request['outDir'], 'model.ifc')}
    return out


if __name__ == '__main__':
    try:
        json.dump(run(json.load(sys.stdin)), sys.stdout)
    except PlanInvalid as error:
        json.dump({'error': str(error), 'validationErrors': error.errors}, sys.stdout)
        sys.exit(1)
    except Exception as error:  # the caller surfaces this message to the model
        json.dump({'error': f'{type(error).__name__}: {error}'}, sys.stdout)
        sys.exit(1)
