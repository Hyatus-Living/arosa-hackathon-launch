---
name: floor-plans
description: Finding a building's published 2D floor plan, judging whether a candidate is the right one, drafting the typical floor of an underwritten program, and revising the project plan with the user. Load when the user asks for a floor plan, pastes a listing or building link for one, an underwriting asks for the typical floor plan, or the user gives feedback on the plan in the editor.
---

# Finding and drafting floor plans

## Where published plans come from
- Sales and rental listing pages (brokerage sites and listing portals) often carry a floor plan image for the unit, with room dimensions in the listing text.
- Brokerage offering memoranda and marketing brochures (PDF) often include typical floor or unit plans, a rent roll and the building's gross area.
- Building and leasing websites publish typical unit plans and floor plates.
- Short-term and furnished rental platforms and their analytics are never sources; the tools exclude them, and you should not search for them.

Start with `acres_find_floor_plan`: give the address with city and state (or the building name), and the user's link when they gave one. Read the candidates it returns, not just the first: prefer a file whose label or page names the unit, line or floor the user means. Attach it with `acres_attach_drawing`, passing the page it came from.

## Evidence limits
- A plan image shows a layout; it is not a survey. Marketing plans are often "not to scale", rounded, mirrored or from a different line on another floor. Say which unit and floor the drawing claims to show and where it came from.
- Look at an attached drawing with `acres_view_drawing` before drafting: read the room names and the dimensions printed on it, and use listing text, PDF text or the user's figures where the image is unclear. Say which values came from the drawing. When no dimensions are legible anywhere, tell the user the drawing is ready to trace in the editor and ask for one known length to scale it.
- Total area stated by a listing rarely equals the sum of room rectangles; report both and do not adjust rooms to force a match.

## The typical floor of an underwritten program
- A development site has no published plan for the building it could become; draft its typical residential floor instead, after the pro forma and decision, so the plan shows the program that was priced.
- Read the plan first with `acres_read_plan`. When a revision exists, keep it and say so: the user may have edited it, and a second draft is never needed.
- Save with `acres_save_plan`, parentRevision 0 and `typicalFloor`: the plate width and depth in feet from the typical residential storey of the massing or envelope (the bounding rectangle when it is not one), and the priced unit mix as shares with target net sizes. The tool lays out the corridor, stairs, core and units as code; do not hand-place them.
- Report the units per floor and how they compare with the priced unit count per storey. The layout is a feasibility test fit, not a design or an egress review.

## Drafting and revising the plan
- Read the current plan with `acres_read_plan` before every change; the user may have saved edits in the editor since your last turn, and their edits win.
- Name rooms plainly ("Living room", "Bedroom closet"): the editor shows names on the plan, so dimensions, certainty and notes belong in your answer, not in a name.
- First drafts: `acres_save_plan` with `draft` rooms as rectangles in feet, x east and y north from the south-west corner, laid edge to edge so shared walls coincide. Put doors and windows at a point on the room edge they belong to. Keep corridors and closets as their own rooms when their size is known.
- Revisions: change only what the user asked, send the full plan back with `plan`, and keep element ids so the user's selection and the walkthrough stay stable.
- After saving, tell the user in one or two sentences what you drew, what you assumed, and what to check on screen. Fix validation issues the tool reports rather than describing them.
- Pascal hand-off round-trip: the user can download **Pascal scene (JSON)** from the Architecture section, edit it in Pascal (local `npx @pascal-app/cli editor` or editor.pascal.app), upload the edited JSON back as a drawing, and you import it with `acres_import_pascal_scene` using that drawing's id and the revision it was edited from. Element ids survive when the scene carries them; anything with no plan meaning is dropped and reported in importWarnings; relay those notes to the user instead of silently accepting the import.
- Saving with `acres_save_plan` automatically queues the walkthrough finished products (Blender preview image, 3D walkthrough model and editable Blender file) for the new revision. For a revision saved earlier, for example by the user in the editor, queue them with `acres_render_plan`. Rendering runs in the background: never say the preview or walkthrough is ready until `acres_read_plan` reports the walkthrough succeeded; a queued or running job is progress the user can watch in the Architecture section, not a finished product. If rendering is unavailable on the host, say so plainly; the saved plan and its IFC, SVG and Pascal scene files are still downloadable there.
