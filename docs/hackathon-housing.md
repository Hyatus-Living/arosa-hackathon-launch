> Public release update: the complete product source is now included, including the independent Underwriting workflow. The earlier extraction proposal below is historical. Use [the current submission guide](hackathon/index.html), [README](../README.md) and [license inventory](../LICENSES.md) for current scope.

# Housing modeling hackathon

Give more people the power to imagine and create homes in their neighborhoods. The hackathon prototype should make early architectural exploration accessible to homeowners, small builders, and nonprofit housing groups. Start with an address and a practical goal: a backyard cottage or accessory dwelling unit, an addition, a conversion, a home on a vacant lot, or small infill housing. Show the sources, assumptions, and unanswered questions alongside an editable design. Local rules and site conditions vary; a concept is not a permit or a professional zoning determination.

## Public extraction boundary

Prepare a public, reproducible package of the hackathon's new zoning and architectural work, with a clear record of what was built during the event. The intended public experience includes site research, 2D/3D geometry and rendering, walkthroughs, and Meta model integrations. Arosa's private application and Underwriting remain independent. Do not require financial analysis to start a modeling project.

Editable IFC provides an interchange path for architectural tools such as Revit. Describe it as IFC import or export unless a specific Revit workflow has been tested; do not imply native Revit integration.

Before publishing, identify which shared source modules and dependencies are required, confirm their licenses and disclosure rights, inspect any history that would become public, and provide rights-cleared sample data and a clean setup without private services or credentials. If the shared core cannot be published, extract a standalone adapter with a documented interface rather than presenting an unreproducible private dependency as public code.

## First implementation slice

- Route opted-in Modeling research to Muse Spark while retaining the existing Underwriting engine. Validate real tool calls, provenance, failure behavior, and configured metering before enabling it in a release.
- Preserve model geometry as the source of truth. SAM masks are reviewable image regions, not surveyed dimensions; Muse Image results are illustrations, not zoning evidence or editable 3D.
- Test with varied parcels and use cases, including a case where data is incomplete, and clearly identify the evidence and assumptions for each outcome.
- Prioritize a reliable end-to-end housing concept before optional media, open-weight, or voice features. Keep existing code and newly created hackathon work distinct in the submission.

## Visual prototype

The Modeling-only photo panel sends an explicitly selected photo to SAM 3.1 for reviewable object masks and point-based refinement. Muse Image uses the photo, a captured view of the selected concept, and, when regions are selected, an annotated site photo to guide the illustration. Muse Image does not accept a mask parameter, so the highlighted reference guides rather than constrains the output. The image is not saved in the project or used as model geometry. Photo tiles are excluded from the captured model reference. The backend checks project access and the concept version before making a request; it does not accept arbitrary remote image URLs.

The extraction includes `acres-research/meta-visual.mjs`, `app-starter/frontend/visual-workbench.jsx`, the project-scoped API and proxy routes, and their tests. They currently depend on Arosa's project authorization and selected concept viewer; a standalone public version needs equivalent interfaces or a self-contained replacement. The unmodified `@meta-sam/parser` dependency is distributed under the [SAM License](../licenses/SAM-LICENSE.txt), which must accompany any distribution of that dependency; its terms include use restrictions and do not make the entire project SAM-licensed. Review the remaining project dependencies and rights before a public release.

When billing is enabled, visual calls require explicitly configured `BILLING_RATES.meta_visual_segment` and `BILLING_RATES.meta_visual_illustrate` fixed-call policies. The interface shows the charge and reservation and the server rejects stale quotes. A successful call settles; uncertain provider outcomes remain pending for reconciliation. With billing disabled, dispatched and completed or uncertain calls are recorded in the service log without image data. No customer rates are set by this feature. Meta's [published prices](https://dev.meta.ai/docs/pricing-rate-limits) are provider costs and may change; they do not authorize a customer price.
