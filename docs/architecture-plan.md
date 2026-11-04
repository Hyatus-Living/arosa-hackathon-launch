# Architecture plan v1

The architecture plan is the one editable geometry document for a detailed building plan. The SVG
drawing, the IFC4 model, the Pascal scene and the id map are all generated from one revision of it;
none of them is edited on its own. The code lives in `planning/architecture.py` (converter, derived
geometry, validator), `planning/exporters/` (`svg.py`, `ifc.py` `write_plan`, `pascal.py` `scene`) and
`planning/run.py`, called by `acres_plan_concept` in `acres-research/planning.mjs`.

## Units and axes

- Stored in metres. The tool boundary takes feet, like every other `acres_plan_concept` input, and
  `architecture.from_layout` multiplies by `0.3048` once, rounding to the micrometre. Nothing else
  converts units.
- Plan axes: x east, y north, elevation up.
- IFC: the same axes, X, Y and Z up.
- Pascal: ground plane XZ with Y up. A plan point `(x, y)` is Pascal `(x, -y)`, and elevation is
  Pascal Y, so the model stays right-handed rather than mirrored.

## Document

```json
{
  "schema": "acres.architecture.plan/1",
  "id": "uuid", "revision": 1, "parentRevision": null,
  "name": "Two-bedroom workflow test", "units": "m",
  "levels":   [{"id": "level-1", "name": "Level 1", "elevation": 0.0, "height": 2.8, "slabThickness": 0.2}],
  "walls":    [{"id": "wall-south", "levelId": "level-1", "start": [0, 0], "end": [10, 0],
                "thickness": 0.18, "height": 2.8, "material": "generic", "roomIds": ["room-kitchen", "room-living"]}],
  "openings": [{"id": "opening-entry", "wallId": "wall-south", "kind": "door",
                "offset": 4.55, "width": 0.9, "sill": 0.0, "height": 2.1, "swing": null}],
  "rooms":    [{"id": "room-living", "levelId": "level-1", "name": "Living / dining",
                "polygon": [[0, 0], [7, 0], [7, 4], [0, 4]], "netAreaMethod": "inside-wall-faces"}],
  "objects":  [{"id": "...", "levelId": "...", "kind": "...", "position": [], "size": [], "rotation": 0}],
  "sources":  [{"kind": "layout", "ref": "Two-bedroom workflow test"}]
}
```

| Field | Meaning |
| --- | --- |
| `id`, `revision`, `parentRevision` | The plan id stays the same across revisions; each save is the next integer revision and names its parent. |
| element ids | Unique across the whole document and stable across revisions. The layout converter prefixes the source id by kind (`wall-`, `opening-`, `room-`), so a wall and a room may share a source name. |
| `levels[].slabThickness` | Floor slab thickness below the level's floor plane (an addition to the core fields; 0.2 m when absent, as in plans from the editor and the research agent). |
| `walls[]` | Centreline from `start` to `end`. A wall shared by two rooms appears once. `roomIds` lists the rooms whose boundary runs along it (derived). |
| `openings[]` | `offset` is metres along the parent wall from its start point to the near edge of the opening; `sill` and `height` are above the level floor. `swing` is `null` or `{hinge: "start" or "end", side: "left" or "right"}` looking from the wall start to its end. |
| `rooms[]` | `polygon` runs on wall centrelines. Net area (`inside-wall-faces`) is the polygon minus the wall bodies, which is what the SVG label, the IFC `NetFloorArea` and the Pascal zone show. |
| `objects[]` | Furniture and other visualization objects, kept apart from building elements. The current exporters do not draw them yet. |
| `sources[]` | Where the geometry came from (the layout, a drawing, an imported IFC). |

Drawing sources retain their calibration (`pointA`, `pointB`, `distanceMetres`). Sources created from an already attached drawing also retain its `drawingId`. Calibration belongs to that drawing and PDF page, identified by `#page=N` in `ref` (an omitted PDF page means page 1). Saved drawing IDs take precedence over legacy filename or ID references. Calibrating another drawing records its scale without moving existing plan geometry; recalibrating the current drawing preserves the existing plan-wide coordinate transformation. Undo and Redo restore the drawing scale with the plan geometry.

When a pending upload completes, matching local source references in the current plan and its Undo/Redo history acquire the stored drawing ID and normalized filename. Page suffixes, calibration and geometry are retained. This metadata update preserves Redo and does not add an Undo step. If a plan was saved before upload completion, the linked source remains an unsaved change until the next Save. Sources already linked to another drawing ID are retained.

Wall bodies run past a wall end by half the thickness where the end meets another wall's end (a
corner), so corners close; at a T-junction the wall ends at the other wall's centreline.

## Validation

`architecture.validate(plan)` returns a list of `{code, id, message}`; an empty list means valid. A
plan with any error is rejected before a file is written, and the tool error carries the list as
`validationErrors`. Tolerance is 1 mm.

| Code | Rejected when |
| --- | --- |
| `invalid_document` | Wrong schema or units other than metres. |
| `duplicate_id` | An id is used twice anywhere in the document. |
| `unknown_reference` | A wall, room or object names an unknown level, or an opening an unknown wall. |
| `invalid_dimension` | A zero-length wall, or a wall or opening without positive thickness, height or width. |
| `wall_duplicate` | Two walls on a level share a length of centreline (a shared wall entered twice). Crossing and touching walls are fine. |
| `opening_outside_wall` | An opening runs past either wall end, below the floor or above the wall top. |
| `opening_overlap` | Two openings in one wall overlap along it. |
| `room_invalid_polygon` | A room polygon has fewer than three points, crosses itself or has no area. |
| `room_open_boundary` | Part of a room's boundary has no wall on it. |

## Layout input

`acres_plan_concept` takes a detailed storey as `layout`, in feet, in the shape of
`planning/fixtures/sample-floorplan.json` (which is the same shape in metres): `height`,
`wall_thickness`, `floor_thickness`, `walls` (`id`, `start`, `end`, optional `thickness`, `height`,
`material`), `openings` (`id`, `kind`, `wall`, `offset`, `width`, `height`, `sill`, optional `swing`)
and `rooms` (`id`, `name`, and `bounds` `[xMin, yMin, xMax, yMax]` or `polygon`). `revisionOf` with an
earlier plan id saves the next revision of that plan.

## Exporting a stored plan document

A service that saves plan documents itself calls `buildArchitectureRevision(plan, {outDir})` from
`acres-research/planning.mjs`. `plan` is an architecture plan v1 document with its id, revision and
parent revision already assigned; `outDir` is the staged revision directory, which already holds the
caller's `plan.json` (left untouched). It writes `plan.svg`, `model.ifc`, `pascal-scene.json` and
`idmap.json` there and resolves `{id, revision, parentRevision, counts, rooms, hasIfc, ifcPath,
ifcSha256, ifcBytes, planPath, svgPath, pascalScenePath, idMapPath}`. Invalid geometry or a malformed
document rejects with `status: 400` and `validationErrors`, and nothing is written; other failures carry
no status. `planning/fixtures/sample-plan.json` is the sample as a plan document.

## Files

Each revision is written once, under the acres state directory (`dirname(RESEARCH_STATE_PATH)`, by
default `/home/openclaw/.openclaw/acres-state`), overridable with `ACRES_ARCHITECTURE_DIR`:

```
<state>/architecture/plans/<planId>/<revision>/
  plan.json           the architecture plan v1 document for this revision
  plan.svg            dimensioned drawing: walls with openings cut, rooms with name, net area and size,
                      overall centreline dimensions; every group carries data-acres-id
  model.ifc           IFC4 (see below)
  pascal-scene.json   Pascal scene {nodes, rootNodeIds, collections, materials}
  idmap.json          plan element id -> IFC GlobalId -> Pascal node id
```

A test-fit massing plan (lot and levels) gets the same directory with `model.ifc` only, when IFC is
requested. Files are never rewritten; a changed plan is a new revision directory.

The tool result and the in-memory plan list carry references, never file contents:

```json
{"id": "uuid", "revision": 2, "parentRevision": 1, "kind": "detailed", "name": "...",
 "counts": {"levels": 1, "walls": 8, "openings": 9, "doors": 5, "windows": 4, "rooms": 5},
 "rooms": [{"id": "room-living", "name": "Living / dining", "netArea": 26.0524}],
 "hasIfc": true, "ifcPath": ".../model.ifc", "ifcSha256": "...", "ifcBytes": 33828,
 "planPath": ".../plan.json", "svgPath": ".../plan.svg",
 "pascalScenePath": ".../pascal-scene.json", "idMapPath": ".../idmap.json"}
```

For a test-fit plan `kind` is `test-fit`, and the detailed paths are `null`.

## IFC

### Existing conditions roadmap

Modeling and Underwriting remain independent address-based workspaces. Model intake never creates or updates underwriting assumptions, quantities or financial outputs. Any future quantity transfer must be an explicit user action with a named source revision.

1. Editable IFC intake and scan validation: import straight, vertical rectangular walls and their rectangular door/window openings; retain the original IFC and report every element outside the editable representation. Check aligned PLY, LAS, LAZ or XYZ scans against the current model surfaces, with explicit units, tolerance, tested-point counts and a downloadable report. Importing creates a draft; saving uses normal revision and conflict handling.
2. Existing versus proposed models: preserve captured evidence, distinguish existing geometry from proposed changes and compare revisions. Add registration review and richer IFC element support based on actual import losses.
3. Assisted reconstruction: evaluate scan-to-BIM suppliers through delivered IFC files before committing to an API. Develop architectural reconstruction for walls, floors and openings before detailed MEP. Validate dimensions and coverage against independent measurements across varied buildings.

The first scan checker uses unsigned point-to-triangle distances from the same IFC geometry used by the model export. It tests at most 50,000 uniformly indexed points and displays at most 2,000. Results describe point-to-model fit, not model completeness, scan registration or survey accuracy. Scans must already share the model's axes and engineering origin; unit conversion is explicit. IFC map conversion is not applied. Inputs are limited to 25 MB sections. E57/RCP ingestion, automatic registration, complete BIM round-tripping and an accuracy guarantee are outside this first slice.

The implementation is `planning/model_intake.py`, through Modeling-only `architecture/import-ifc` and `architecture/validate-scan` endpoints. Source IFCs use the existing account-scoped drawing storage. Scan files are temporary and deleted after the check; the downloadable report carries the file hash, geometry fingerprint, revision, units and metrics. Any geometry edit marks the on-screen check stale.

The GCP research installer stages the planner through `infra/acres-stage-planning`, including its IFC specification and all runtime modules. Python 3.11+ with venv support is a host prerequisite. Dependencies are provisioned before draining the service in `/opt/acres-planning-envs/<requirements-hash>`; the release's `/opt/planning/.venv/bin/python` launcher selects that environment. Rollback restores the previous launcher with the previous source. `ACRES_PLANNING_DIR` overrides remain operator-managed and must receive the same source and requirements. No AWS delivery is involved.

`IfcProject` > `IfcSite` > `IfcBuilding` > `IfcBuildingStorey` per level (elevation, and
`Qto_BuildingStoreyBaseQuantities.GrossHeight`), aggregated. Each storey aggregates an `IfcSpace` per
room (net polygon extruded to the level height, `Name` and `LongName` the room name,
`Qto_SpaceBaseQuantities` net and gross floor area and height) and contains an `IfcSlab` per connected
floor region (`FLOOR`, outer wall faces with courtyard voids), `IfcWall`s and the doors and windows. Empty
levels have no slab or empty containment relationship. Each wall is placed at its
start point with local X along the wall and has an `Axis` and a `Body` representation,
`Pset_WallCommon.IsExternal` and its material. Each opening is an `IfcOpeningElement` voiding its wall
(`IfcRelVoidsElement`) and filled (`IfcRelFillsElement`) by an `IfcDoor` or `IfcWindow` with
`OverallWidth` and `OverallHeight`.

GlobalIds are derived from the plan id and element id (UUID v5, compressed), so an element keeps its
GlobalId in every revision. The opening element's GlobalId is under `ifcOpeningGlobalId` in the id map.
Derived floor regions are ordered by decreasing area, then bounds and normalized geometry. The first
uses `<levelId>:slab`, later regions use `:2`, `:3` and so on; `:floor` is appended to avoid collisions
with input element IDs. Unchanged regions keep their IDs when input collections are reordered.
Topology changes can create, remove or reorder derived regions; wall, opening and room IDs remain their input IDs.

## Pascal scene

One site, building and level per plan level (`height`, and `baseElevation` for any difference from
Pascal's stacked elevation), a slab per connected floor region with its polygon holes, a wall per plan wall on its centreline, a door or window node as a
child of its wall at the wall-local position Pascal uses (centre distance from the wall start, centre
height), and one `zone` per room (`spaceRole: room`, net polygon, `boundaryWallIds`), so each room is
individually selectable. Node ids are `<type>_<16 hex>` derived from the plan id and element id;
`metadata.acresId` names the plan element. The scene loads into `@pascal-app/mcp`'s `SceneBridge` and
passes `validateScene` with no errors or warnings.

## Id map

```json
{"schema": "acres.architecture.idmap/1", "planId": "uuid", "revision": 1,
 "ifcProjectGlobalId": "...",
 "elements": {
   "wall-south":    {"ifcGlobalId": "...", "ifcClass": "IfcWall", "pascalNodeId": "wall_..."},
   "opening-entry": {"ifcGlobalId": "...", "ifcClass": "IfcDoor", "ifcOpeningGlobalId": "...", "pascalNodeId": "door_..."},
   "room-living":   {"ifcGlobalId": "...", "ifcClass": "IfcSpace", "pascalNodeId": "zone_..."},
   "level-1:slab":  {"ifcGlobalId": "...", "ifcClass": "IfcSlab", "pascalNodeId": "slab_..."}
 }}
```

It has an entry for the site, building, every level, each floor-region slab, wall, opening and room.

## Tests

The Python tests run with the planning venv (`python3 -m venv planning/.venv && planning/.venv/bin/pip
install -r planning/requirements.txt`), from `planning/`:
`.venv/bin/python -m unittest test_engine test_architecture test_exporters test_floor_regions test_gate`. `test_gate.py`
enters the sample in feet and checks that the plan, the reopened and meshed IFC and the Pascal scene
agree on dimensions, level height, room and opening counts and opening positions within 1 mm, and that
wall volumes equal the solid less every opening. `acres-research/planning-boundary.test.mjs` and
`planning-architecture.test.mjs` run the real `run.py` through `planning.mjs` and load the scene into
Pascal; `npm test` skips them where `planning/.venv` is missing.
