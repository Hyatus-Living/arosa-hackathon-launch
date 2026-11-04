"""Health probe; runs inside `blender --background --python health.py -- <out.json>`.

Enables the Bonsai extension, imports the bundled IfcOpenShell and confirms that
Bonsai's IFC project loader operator is registered.
"""

import importlib.metadata
import json
import sys

import addon_utils
import bpy

BONSAI_ADDON = "bl_ext.user_default.bonsai"

addon_utils.enable(BONSAI_ADDON, default_set=True)
import ifcopenshell  # noqa: E402

loaded, enabled = addon_utils.check(BONSAI_ADDON)
report = {
    "blender": {"version": bpy.app.version_string, "python": sys.version.split()[0],
                "background": bpy.app.background},
    "bonsai": {"version": importlib.metadata.version("bonsai"), "enabled": bool(loaded and enabled),
               "loadProjectOperator": hasattr(bpy.ops.bim, "load_project")},
    "ifcopenshell": {"version": ifcopenshell.version},
}
with open(sys.argv[sys.argv.index("--") + 1], "w") as handle:
    json.dump(report, handle, indent=2)
