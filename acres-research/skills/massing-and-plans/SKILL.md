---
name: massing-and-plans
description: Models development concepts in 2D/3D and lays out test-fit floor plans, and reports modeled areas and yields honestly as hypotheses. Load when the answer compares concepts, envelopes, or floor plans.
---

# Massing, concepts and test-fit plans

Use `acres_model_concept` when the answer compares development concepts for a resolved property: the as-of-right envelope and each alternative worth weighing (assembly, transfer, conversion, bonus, special-district mechanism). Give the lot outline and one footprint per storey with its floor-to-floor height, in feet, with x along the frontage and z into the lot; shrink upper footprints to show setbacks and pass the applicable `maxFar` and `maxHeightFeet` when you have them. The user views the result as a 3D massing among its neighbours, a plan with a north arrow, a street view and a storey table, so name each concept the way you refer to it in the answer and keep to the few that matter, at most four per answer. For an NYC site, select the subject with `acres_set_subject` before modeling: the tool then draws the block from NYC building footprints and returns the existing building's size. Those neighbours are roof heights on footprints placed approximately against your lot; they do not establish adjacency, light, air or any right.

Use `acres_plan_concept` to lay out test-fit floor plans inside a massing (units, corridor, cores, egress checks) and hand its returned arguments to `acres_model_concept` so the planned building renders. Ask for IFC only when the user wants a model to hand to an architect.

Use `acres_zoning_envelope` (NYC, when available) for the computed as-of-right envelope: pass `streets` when you know the widths, read `envelope.checks` for what was assumed, and hand `envelope.concept` to `acres_model_concept` to draw it. Its figures are starting points with citations to read, not determinations.

The tools return gross polygon areas, FAR and height computed from your geometry. Report them as the concept's modeled numbers, not as zoning floor area or as a buildable envelope, and keep the controlling rule, source citations and unresolved issues in the answer. A model of an idea that needs discretionary approval is still an idea. Do not model when the question is a simple parcel fact or when lot dimensions are unknown; derive dimensions from retrieved parcel evidence or say they are assumed. Give each residential storey a `units` count when the concept has a unit mix, so the answer and comparison report units and area per unit. In a research-tier city there is no subject parcel or footprint context yet, so model only from lot dimensions the user supplied or retrieved evidence supports, and say so.
