"""Write a small IFC4 fixture: one storey, a 6 x 4 m room of four walls, a floor slab,
one space and one door in a real opening. Used by the install smoke job and tests.

Usage (any Python with IfcOpenShell, e.g. Blender's bundled Python with the Bonsai
site-packages on PYTHONPATH): make_fixture_ifc.py <out.ifc>
GlobalIds are derived from fixed names, so every generated fixture has the same IDs.
"""

import sys
import uuid

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import numpy

LENGTH, WIDTH, HEIGHT, THICKNESS = 6.0, 4.0, 3.0, 0.2
DOOR_OFFSET, DOOR_WIDTH, DOOR_HEIGHT = 2.5, 0.9, 2.1


def create(model, ifc_class, name, **kwargs):
    entity = ifcopenshell.api.run("root.create_entity", model, ifc_class=ifc_class, name=name, **kwargs)
    entity.GlobalId = ifcopenshell.guid.compress(uuid.uuid5(uuid.NAMESPACE_URL, f"acres-fixture/{name}").hex)
    return entity


def place(model, product, x, y, z, degrees=0.0):
    matrix = numpy.eye(4)
    radians = numpy.radians(degrees)
    matrix[:2, :2] = [[numpy.cos(radians), -numpy.sin(radians)], [numpy.sin(radians), numpy.cos(radians)]]
    matrix[:3, 3] = [x, y, z]
    ifcopenshell.api.run("geometry.edit_object_placement", model, product=product, matrix=matrix)


def represent(model, product, representation):
    ifcopenshell.api.run("geometry.assign_representation", model, product=product, representation=representation)


def build(path):
    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = create(model, "IfcProject", "Acres fixture")
    ifcopenshell.api.run("unit.assign_unit", model, length={"is_metric": True, "raw": "METERS"})
    model_context = ifcopenshell.api.run("context.add_context", model, context_type="Model")
    body = ifcopenshell.api.run("context.add_context", model, context_type="Model", context_identifier="Body",
                                target_view="MODEL_VIEW", parent=model_context)

    site = create(model, "IfcSite", "Site")
    building = create(model, "IfcBuilding", "Building")
    storey = create(model, "IfcBuildingStorey", "Ground floor")
    storey.Elevation = 0.0
    ifcopenshell.api.run("aggregate.assign_object", model, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", model, products=[building], relating_object=site)
    ifcopenshell.api.run("aggregate.assign_object", model, products=[storey], relating_object=building)
    for spatial in (site, building, storey):
        place(model, spatial, 0, 0, 0)

    walls = []
    for name, x, y, degrees, length in (
        ("Wall south", 0, 0, 0, LENGTH), ("Wall east", LENGTH, 0, 90, WIDTH),
        ("Wall north", LENGTH, WIDTH, 180, LENGTH), ("Wall west", 0, WIDTH, 270, WIDTH),
    ):
        wall = create(model, "IfcWall", name, predefined_type="SOLIDWALL")
        place(model, wall, x, y, 0, degrees)
        represent(model, wall, ifcopenshell.api.run(
            "geometry.add_wall_representation", model, context=body, length=length, height=HEIGHT,
            thickness=THICKNESS))
        walls.append(wall)

    slab = create(model, "IfcSlab", "Floor slab", predefined_type="FLOOR")
    place(model, slab, 0, 0, -THICKNESS)
    represent(model, slab, ifcopenshell.api.run(
        "geometry.add_slab_representation", model, context=body, depth=THICKNESS,
        polyline=[(0, 0), (LENGTH, 0), (LENGTH, WIDTH), (0, WIDTH)]))

    space = create(model, "IfcSpace", "Living room")
    place(model, space, 0, 0, 0)
    represent(model, space, ifcopenshell.api.run(
        "geometry.add_slab_representation", model, context=body, depth=HEIGHT - THICKNESS,
        polyline=[(THICKNESS, THICKNESS), (LENGTH - THICKNESS, THICKNESS),
                  (LENGTH - THICKNESS, WIDTH - THICKNESS), (THICKNESS, WIDTH - THICKNESS)]))
    ifcopenshell.api.run("aggregate.assign_object", model, products=[space], relating_object=storey)

    opening = create(model, "IfcOpeningElement", "Door opening")
    place(model, opening, DOOR_OFFSET, -THICKNESS, 0)
    represent(model, opening, ifcopenshell.api.run(
        "geometry.add_wall_representation", model, context=body, length=DOOR_WIDTH, height=DOOR_HEIGHT,
        thickness=THICKNESS * 3))
    ifcopenshell.api.run("feature.add_feature", model, feature=opening, element=walls[0])

    door = create(model, "IfcDoor", "Entry door")
    door.OverallWidth, door.OverallHeight = DOOR_WIDTH, DOOR_HEIGHT
    place(model, door, DOOR_OFFSET, 0, 0)
    represent(model, door, ifcopenshell.api.run(
        "geometry.add_door_representation", model, context=body, overall_height=DOOR_HEIGHT,
        overall_width=DOOR_WIDTH))
    ifcopenshell.api.run("feature.add_filling", model, opening=opening, element=door)

    ifcopenshell.api.run("spatial.assign_container", model, products=[*walls, slab, door], relating_structure=storey)
    model.write(path)


if __name__ == "__main__":
    build(sys.argv[1])
