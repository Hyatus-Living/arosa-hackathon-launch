# Licenses and attribution

Arosa-authored code and documentation in this repository are released under the MIT license in `LICENSE`. This grant does not relicense third-party software, model weights, provider services or external datasets.

| Component | License / source |
|---|---|
| Arosa source and documentation | MIT, copyright 2026 Hyatus Living |
| Pascal packages | MIT as declared by the installed `@pascal-app` packages; retain their package notices |
| React, Three.js, React Three Fiber, Drei and camera-controls | Their distributed MIT notices |
| `@meta-sam/parser` | SAM License, included at `licenses/SAM-LICENSE.txt`; includes use restrictions |
| Blender and Bonsai | Their GPL licenses; installed separately by the worker, not relicensed by this repository |
| IfcOpenShell and other Python packages | The license of each pinned package in `planning/requirements.txt`; Bonsai integration has separate GPL obligations |
| Glam Velvet Sofa | CC BY 4.0, Eric Chadwick / Wayfair; see the included asset credits |
| Innerscene furniture and ambientCG textures | CC0 as recorded in the included asset credits |
| Vendored MapLibre, DOMPurify and Marked | License files beside the vendored source in `app-starter/public/vendor/` |
| Fonts, render libraries and all other npm packages | The license and notices distributed with each resolved package; versions recorded in lockfiles |
| Meta Model API and its outputs | Applicable Meta account/API terms; an MIT code license does not grant API access |
| NYC datasets, maps, listing sources and other remote content | Their original data/service terms; API clients do not relicense retrieved data |

Full visual asset credits: [app-starter/public/architecture-assets/credits.html](app-starter/public/architecture-assets/credits.html). Worker distribution versions and license references: [worker/VERSIONS.md](worker/VERSIONS.md).

The synthetic UI fixtures illustrate behavior. The production-derived report formerly used by the preview was replaced with the existing synthetic project-state fixture before publication. API credential fixtures use dummy values. Runtime secrets, customer records, internal screenshots and private history are excluded.
