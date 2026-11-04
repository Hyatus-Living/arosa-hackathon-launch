# Arosa roadmap: fourteen core skills

Arosa is an agent, not a wizard. A user can ask for any step at any time, so the product is
organised as fourteen skills the agent can call on, each with its own features, rather than a
fixed sequence. The canonical flow still reads in order, and it is what the fourteenth skill runs
end to end:

site intake → zoning analysis → maximize entitlements → massing → market and unit mix →
preliminary plans and parking → pro forma → product recommendation → architectural concepts →
final deck.

**The connecting principle.** Every skill reads from and writes to one project state for the
site: parcels and boundaries, the zoning analysis, the chosen entitlement scenario, the massing,
the program and unit mix, the parking scheme, the plans and their efficiency metrics, the market
inputs and the financial model. When the user changes a unit mix, a parking assumption, a design
choice or an entitlement scenario, every downstream artefact is re-derived from the same state:
plans, efficiency metrics, pro forma, recommendation and deck. Nothing is a one-off answer; each
is a view of the project state with its assumptions visible and its sources attached.

Status key: **built** (live in the product), **partial** (some features live), **planned**.

## 1. Site intake — partial

Turn what the user has into a resolved site.

- Address, shorthand or building name resolution through PLUTO and GeoSearch, with
  confirmation of ambiguous matches. *built* (`acres_find_property`, `acres_set_subject`)
- Folio, BBL or tax-lot identifiers as direct input. *built for NYC BBL*
- Multiple parcels: assemble a site from several lots, flag non-contiguity and separate blocks,
  and treat the assembly as one zoning lot only when the user says so. *built*
  (`acres_assemble_site`)
- Prior site applications, plan submittals, and recorded land records: inspect DOB BIS and
  DOB NOW job filings, Certificates of Occupancy, ACRIS deeds/mortgages/easements/air-rights
  transfers (ZLDAs), and HPD affordable housing projects and maintenance violations for the
  parcel. *built for NYC* (`acres_nyc_public_records` built on the `nycdb` NYC Open Data
  schema; multi-city permit/submittal connectors planned)
- Survey upload: read a survey or site plan (PDF or image) for the lot outline, frontage and
  easements; seed the lot polygon from it instead of PLUTO frontage and depth. *planned*
  (needs document upload in the chat and a sampling-capable Pascal host for
  `analyze_floorplan_image`)
- Site boundary: lot polygon in the concept frame, with frontage and depth, neighbours from
  NYC building footprints, the existing building and its PLUTO size. *built* (`context.mjs`)
- Nearby context: transit, retail, parks and schools with distance and direction; a Street View
  photo facing the lot. *built behind Google keys* (`acres_nearby_places`)

## 2. Zoning engine — partial

The full zoning analysis for the site.

- District, overlays, special districts, zoning map and PLUTO version. *built*
- Lot size, frontage and depth. *built*
- FAR by use from PLUTO maximums, with capacity against the existing building. *built*
  (`acres_zoning_envelope`)
- Curated rules with Zoning Resolution citations, verified against the current text on
  2026-10-13: Lower Manhattan, commercial and manufacturing rules plus all R6–R12 districts
  (45 districts). *built and live behind the curated-zoning flag; special districts beyond
  Lower Manhattan and Midtown remain partial*
- Height, setbacks and stepbacks, sky exposure planes, tower coverage and street wall rules as
  computed envelope geometry rather than prose. *built behind the host's curated-zoning flag* (`envelope.mjs`: Special Lower Manhattan District, commercial sky exposure plane and tower, residential base, tower and eligible-site (ZR 23-434) forms, manufacturing; street wall types and widths are inputs)
- Lot coverage and open space, yards and courts. *partial* (coverage, rear yards and
  through-lot rear yard equivalents drawn; court minimums reported in controls, not carved —
  they depend on where legally required windows face)
- Dwelling unit factor and allowable units; parking requirements and waivers by district and
  transit zone. *partial* (dwelling unit factor, Manhattan Core caps, and Inner/Outer/beyond
  the Greater Transit Zone requirements with small-lot and Column C waivers computed; the zone
  itself comes from the GTZ map, so all three outcomes are reported unless it is named)
- Use groups permitted as of right and by special permit. *planned*
- Landmark, historic district, flood zone, split-lot and legal-occupancy flags. *partial*
  (landmark, historic district, split lot, FIRM/PFIRM flood flags, community district and
  building class surfaced from PLUTO)
- Live retrieval of the current Zoning Resolution text with citations. *built* (knowledge and
  live research tools)

## 3. Maximization and entitlement — partial

"How can I build more?"

- Bonuses and public-benefit programs: Universal Affordability Preference, subway station
  improvement bonuses, plaza and arcade bonuses, special-district mechanisms. *partial*
  (UAP computed 1:1 against affordable floor area provided, capped at the ZR 23-22 QAH FAR;
  subway, plaza and remaining special-district mechanisms still listed, not computed)
- Density transfers: zoning lot mergers, landmark transfers, special-district transfer
  mechanisms, with the recorded-instrument checks they need. *built for mergers and landmark
  transfers* (pooling arithmetic; ZR 75-422 certification caps at 20%, 30% in FAR-15+
  commercial/manufacturing, ZR 74-79 special permit above; recorded ACRIS air-rights and ZLDA
  instruments checked via `acres_nyc_public_records`)
- Variances and rezonings: BSA variance findings, ULURP paths, text amendments. *built as
  scenarios* (the five ZR 72-21 findings verbatim; relief quantified against a requested
  program; no outcome is predicted)
- Conversions and adaptive reuse under Article I Chapter 5 as amended. *built* (1990/1997
  eligibility and convertible non-residential plus mechanical area computed)
- Prior plan submittal pass/fail & denial/objection forensics: check whether previous
  applications or plan submittals on the site passed or failed, and when disapproved,
  withdrawn, or stalled, surface why (plan examiner objections, zoning compliance failures,
  DRC staff comments, or board denials) so new massing and entitlement strategies avoid
  repeating prior rejection points. *partial* (NYC DOB BIS and DOB NOW submittal outcome
  classification — approved/permitted/signed-off vs disapproved/withdrawn/suspended — is built
  in `acres_nyc_public_records`; full DOB objection-sheet text extraction and multi-city DRC
  comment scraping are planned)
- Feasibility scoring from local approval history: BSA decisions, CPC reports, community board
  minutes and comparable approvals near the site, scored for precedent strength, time and risk.
  *partial* (the ZR/BSA/CPC/CEQR corpus is ingested and a deterministic approval-certainty
  rubric ranks paths; precedent-strength scoring from nearby approvals is still planned)
- Each path returns the added floor area, height or units it would unlock, its conditions, and
  what it costs in time and public benefit, into the project state as an entitlement scenario.
  *built* (`acres_entitlement_scenarios`; state capture follows the concept/market writes)

## 4. Massing study — built

A zoning-compliant building envelope in three dimensions.

- Storey-by-storey massing from lot and footprints, with setbacks by shrinking upper floors;
  gross area, FAR, height and remaining capacity. *built* (`acres_model_concept`)
- 3D, plan, street and exploded views; neighbours from footprints; existing building ghost;
  Street View reference photo; Google Photorealistic 3D Tiles under the model. *built*
- Side-by-side comparison of concepts in one answer. *built*
- The computed envelope drawn as a translucent limit the concept is checked against. *built*
  (amber envelope volumes in 3D, dashed outlines in plan, per-storey breach screening in
  `acres_model_concept` with the verdict shown in the viewer)
- Lot coverage, yards, stepbacks and sky exposure planes shown and checked. *built* (the drawn
  envelope carries them; court minimums are reported in controls, not carved)
- Export: PNG of each view, GLB, a link that opens the conversation at the model, and a handoff
  to a hosted Pascal project. *partial* (PNG per view, massing GLB and `#thread=&concept=`
  deep links built; hosted Pascal project handoff still planned — hosted APIs unverified)

## 5. Program recommendation — partial

Best use and unit mix for the site.

- Local supply, pipeline and absorption from public and licensed market data. *partial*
  (live MLS/Realtor.com sold, active for-sale, and rental comparables + days-on-MLS absorption
  velocity harvested nationwide via `acres_market_comps` / `HomeHarvest`; institutional supply
  and construction pipeline feeds remain planned)
- Rents and sale prices per square foot by product type and bedroom count near the site, plus
  absorption velocity (median days on market and turnover volume per bedroom bucket) so the
  recommended unit mix weights both $/sq ft and how fast each unit type sells or leases.
  *built* (`acres_market_comps` computes `recommendedCondoMixByVelocity` and
  `recommendedRentalMixByVelocity` and auto-populates `acres_market_inputs`)
- Recommended product type (rental, condo, mixed, hospitality, office, community facility) and
  unit mix as percentages by studio, one, two and three bedrooms, with target unit sizes.
- Writes the program per storey and the unit mix into the project state; the massing already
  accepts units per storey and reports area per unit. *built* (`acres_market_comps`,
  `acres_market_inputs`, `acres_unit_mix`)

## 6. Parking optimization — partial

Whether parking is required, recommended or waivable, and the best layout.

- Requirement by district, use and transit zone, including waivers for small lots and the
  Manhattan Core rules. *built for NYC residential* (skill 2)
- Recommended count from the program and the market, independent of the requirement. *planned*
- Layout generation: below-grade or structured, ramp or stacker, aisle widths and bay sizes,
  spaces achieved per level and the footprint it consumes. *partial* (the planner sizes stalls
  by area on parking storeys, below grade included; ramp, stacker and bay geometry not drawn)
- Feeds the plans, the efficiency metrics and the pro forma. *partial* (planner takeoffs)

## 7. Preliminary plans — partial

Test-fit drawings.

- Floor plans per typical storey showing units, cores, corridors, common areas, amenities and
  back of house, from the program and the massing. *built* (`acres_plan_concept`: the Python
  planning engine lays out units, double-loaded corridors, stairs and core with NYC egress checks
  as code; Pascal renders the resulting massing)
- Parking levels from skill 6; ground floor with lobby, retail and loading. *partial*
  (below-grade parking storeys and ground retail are planned; lobby/loading detail is schematic)
- Dimensions, unit counts and areas on the drawing; plan export as SVG and PDF. *partial*
  (counts and areas ride the takeoffs and the IFC4 spaces; dimensioned SVG/PDF sheets planned)
- Floor-plan import to seed existing conditions, plus **existing architectural drawing upload
  & AI inefficiency audit ("Upload & Critique")**: upload existing third-party architectural
  plans (PDF/CAD/image) so the AI identifies layout, core, corridor, structural grid,
  window-frontage, unit-depth, and gross-to-sellable/rentable square footage inefficiencies and
  generates higher-efficiency layout alternatives. *planned* (sampling-capable Pascal host +
  vision/geometry audit pipeline)

## 8. Efficiency optimization — partial

Maximize sellable or rentable area.

- Net-to-gross and sellable-to-gross ratios per storey and overall. *built* (planner takeoffs:
  residential efficiency, net rentable area and gross per unit)
- Window frontage per unit, corridor length, core count and placement, amenity allocation and
  parking footprint as levers. *partial* (reported in takeoffs; not yet searched)
- Audit uploaded third-party architectural drawings for layout, core-to-window, corridor, and
  loss-factor inefficiencies, quantifying recoverable net rentable/sellable square feet and its
  pro-forma value impact. *planned*
- Search over layouts within the envelope and program; report the trade-offs, not just the
  winner. *planned* (the engine scores its generated layout; it does not search alternatives)
- Every plan change updates the pro forma. *partial* (re-running the planner refreshes takeoffs;
  the pro forma re-derives from project state on market/program writes)

## 9. Financial model — built as code

Automated pro forma.

- Inputs the user supplies: land price, hard cost per square foot, soft cost per square foot,
  financing terms and carry.
- Computed: revenue from the program and market rents or sale prices, operating expenses,
  development budget, NOI, yield on cost, cap rate, levered and unlevered returns, and a
  sensitivity table across rent, cost, cap rate and entitlement scenario.
- Prepaid wallet and metering already exist for paid research; the pro forma itself is pure
  calculation and runs as code, not model arithmetic. *built* (`acres_pro_forma`, with one-way
  sensitivities and derivation lines)

## 10. Feasibility recommendation — built

Best business plan.

- Compare condo, rental and affordable or subsidized programs on the same site and envelope.
  *built* (`acres_compare_programs`, including blended affordable rents and per-variant sizes)
- Risk-adjusted profit with the entitlement risk from skill 3, the market risk from skill 5 and
  the execution risk from skills 6 to 8 made explicit. *built* (entitlement-certainty scaling,
  rent −10% downside, yield-on-cost spread; losses are never discounted)
- Explain the recommendation and what would change it. *built* (profit gap and flip conditions)
- Keep the building instead of building new: hold it as is, renovate and rent it, or renovate and
  sell it, each with net operating income, all-in cost (closing costs, the buyer's NYC transfer
  taxes on one to three family houses, loan costs, the work and its carry), cash flow after debt
  service, debt coverage, value or sale price, the highest price that meets the buyer's target and
  a joint downside; regulated units keep their rents. The way that pays the most sits beside the
  development decision under "Should you buy it", and the user's numbers reprice it in code.
  *built* (`acres_keep_building`, skill `keep-building`)
- Every listing page reads instantly as a building to keep, without a run: held at the ZIP's median
  asking rent with the listing's tax bill at a planning cap rate, beside what standing buildings of its
  kind sold for in the ZIP. The reader says whether they are buying to build new or to keep the
  building; the choice orders the page and picks the underwriting it starts. *built* (`quickKeep`,
  `MarketStore.listingKeepInputs`)

## 11. Architectural concepting — planned

Design options within zoning.

- Ask for style preferences (modern, limestone, glass, rounded, angular, contextual) after the
  massing and plans are accepted.
- Generate about five distinct, zoning-compliant concepts on the same massing: facade, material,
  rhythm and crown, each rendered in context with the photo tiles layer.
- Keep each concept tied to the massing and plans so areas and the pro forma do not drift.

## 12. Iterative design — partial

Refine a selected concept.

- Conversational edits to facade, massing, materiality, layout and character, with the zoning
  envelope and the underwriting constraints as hard limits. *partial* (massing and layout edits
  through re-modeling with the envelope check on; facade and materiality await skill 11)
- Each iteration re-runs the efficiency metrics and the pro forma and shows the deltas.
  *partial* (massing deltas computed on the revision; planner and pro forma re-run on request
  and via the state derive)
- Version history of concepts in the project state; revert and branch. *built* (version
  lineage with parent, change note and signed deltas on the concept record)

## 13. Final deliverable — planned

An automatically assembled deck.

- Internal underwriting and development package, or an investor or corporate pitch deck.
- Sections drawn from the project state: site, zoning with citations, entitlement scenarios,
  massing views, plans, market analysis, pro forma and sensitivities, recommendation, visuals,
  risks and open items.
- Produced as a slide deck or PDF; sources and assumptions carried through.

## 14. Full zoning underwriting and plan — planned

The orchestrating skill: run skills 1 to 13 end to end for a site from one request such as
"underwrite 120 Broadway for residential conversion", pausing only where the user's input is
needed (style preferences, land price and costs, a choice among concepts), and producing the
project state and the deck in one pass. It also keeps the state consistent afterwards: a change
anywhere re-runs the dependent skills.

## Future pipeline & data moat expansion

Beyond the fourteen core underwriting skills, the following data pipelines, solver expansions,
and platform capabilities are queued for the roadmap:

### 1. Multi-city municipal portal, DRC & planning-minutes + trade-press ingestion ("Trellis for Development")

Build a structured, searchable development-precedent and submittal-history corpus (analogous to
Trellis for litigation) combining official municipal portals, planning/DRC minutes, and real
estate trade press:

- **New York City (`US-NY-NYC`)**:
  - **ZoLa** (`zola.planning.nyc.gov`) for zoning districts, overlays, special districts, and
    linked Zoning Resolution sections.
  - **DOB NOW Public Portal & legacy BIS** (`nycdb` Socrata endpoints `ic3t-wcy2`, `w9ak-ipjd`,
    `bs8b-p36w` live via `acres_nyc_public_records`; portal-level plan examiner objection text
    and zoning diagram `ZD1` extraction planned).
  - **NYC City Planning ZAP (Zoning Application Portal)** (`zap.planning.nyc.gov`), CPC reports,
    and BSA resolutions for ULURP, special permits, variances, and rezonings.
  - **ACRIS & HPD** (`8h5j-fqxa`, `bnx9-e6tj`, `hg8x-zxpr`, `wvxf-dwi5` live via
    `acres_nyc_public_records`) plus DOF tax bills/assessments and ECB/OATH violations from the
    `nycdb` dataset catalog.
- **Miami-Dade County (`US-FL-MIAMI_DADE`)**:
  - **Miami-Dade Zoning Records Viewer**: searchable by address, folio number, or application
    number for zoning history, hearing results, and prior zoning resolutions.
- **City of Miami (`US-FL-MIAMI`)**:
  - **Dual municipal + county record resolution**: City of Miami properties have separate
    municipal zoning/planning/permit records (`Miami 21`, warrant/exception filings, city permit
    records) layered on top of Miami-Dade County property appraiser and county records. Always
    check both the City of Miami portal and Miami-Dade County records.
- **Fort Lauderdale (`US-FL-FORT_LAUDERDALE`)**:
  - **Fort Lauderdale DRC (Development Review Committee)** submittals, staff review comments,
    site plan review packages, and outcomes.
- **City planning minutes & real estate trade press**:
  - Continuous ingestion of municipal planning board/commission minutes alongside **The Real
    Deal**, **YIMBY (New York YIMBY, Florida YIMBY, Chicago YIMBY)**, and **Commercial
    Observer** to link early-stage development filings, rendering leaks, air-rights trades, and
    financing terms back to parcel BBL/folio identifiers.

### 2. Existing architectural drawing upload & AI inefficiency audit ("Upload & Critique")

- Allow architects, developers, and acquisitions teams to upload existing third-party
  architectural drawings (PDF plan sets, CAD/DXF, or floor-plan images) for any project.
- Automatically detect and quantify inefficiencies: oversized cores or corridors, poor
  net-to-gross loss factors, suboptimal structural bay spacing, dead-end corridor or egress
  violations, wasted window frontage, inefficient unit depths, and excess parking ramp area.
- Propose a side-by-side optimized floor plan and show the incremental net rentable/sellable
  square footage and NOI/sellout gain in the pro forma.

### 3. TestFit.io competitive parity & building typology expansion

Expand the generative geometry and planning engine (`planning.mjs` / Pascal) to match and
exceed TestFit.io's solver modules while bundling full zoning legal research and underwriting:

- **Dedicated Parking Solver**: full ramp geometry, speed-ramp vs sloped-floor layouts, column
  grids, mechanical stackers, and turning-radius verification.
- **Site Solver Portfolio**: batch multi-site feasibility screening and portfolio-wide comparison
  across dozens of candidate parcels simultaneously.
- **Expanded building typologies**:
  - **Industrial / Warehouse** (dock counts, trailer courts, clear heights, bay depths)
  - **Low-Detail Fast Massing** (instant zoned envelope + FAR massing sweep)
  - **Multi-family** (wrap, podium, garden, double-loaded tower, single-stair point block)
  - **Commercial / Office / Retail / Hospitality**

### 4. Freemium self-hosted model tier, trace flywheel & cross-industry data monetization

- **High-volume token + subscription pricing with self-hosted open-weight tier (`Qwen`)**:
  offer an accessible monthly + token model with a free basic tier routed to self-hosted
  open-weight models (`Qwen`) so high-volume free users generate real-world zoning, parcel, and
  feasibility traces that feed the Nightly Dreaming (`dream.mjs`) self-improvement flywheel at
  near-zero marginal inference cost.
- **Cross-industry structured data monetization**: package Arosa's verified parcel, zoning,
  prior-submittal, air-rights, and development-pipeline intelligence for adjacent verticals
  including **municipalities and city planning departments, architects, civil/structural
  engineering firms, building-supply manufacturers/distributors, and commercial real estate
  brokers and lenders**.

## Foundations the skills share

- **Project state.** One persisted object per conversation or site that every skill reads and
  writes, with provenance per field and a dependency graph so changes propagate. Built: the
  graph (property, places, envelope, concepts, market, program, pro formas, assembly, and NYC
  public records) is captured per run with stale propagation, and pro formas re-derive in code
  when market or program writes supersede their inputs.
- **Evidence and citations.** Every regulatory and market claim carries a source with retrieval
  date and jurisdiction. Curated tables are starting points to verify, never determinations.
- **Smart index routing.** `acres_search_knowledge` uses the Jev (`gpt-5.4-nano`) catalog
  router over higher-level source metadata (`country`, `state`, `city`, `sectionSummary`,
  `authorityTier`) to select relevant indexed sources, promote high-confidence official docs as
  direct citable sources (`directSources`), and return `recommendedFanout` queries for gaps.
- **Calculation as code.** Areas, capacity, parking counts, efficiency ratios and the pro forma
  run as code the user can inspect; the model explains and chooses.
- **Rendering.** Pascal for massing, the Python planning engine (shapely + ifcopenshell) for
  test-fit plans and the IFC4 handoff, SVG for drawings, Google tiles and Street View for
  context, a deck generator for the deliverable.
- **Jurisdictions.** Tiered coverage with the jurisdiction auto-detected from the address
  (`acres-research/jurisdiction.mjs`). New York City is deep coverage: PLUTO parcels, curated
  rules and envelope, footprint neighbours, and `nycdb` DOB/ACRIS/HPD records. Every other US
  city is research coverage: live official-source research scoped to that jurisdiction plus
  nationwide `HomeHarvest` MLS comparables (`acres_market_comps`) and generic massing, market
  and pro-forma tools, with the parcel and bulk gaps named. The parcel adapters, rules tables,
  parking rules and approval corpora that deepen a city are per jurisdiction and must be added
  deliberately for each new market; NYC rules never transfer.

## Suggested order

1. Skill 2 tail: use-group summaries and deeper special-district coverage.
2. Skill 1 & 3 portal expansion: DOB plan-examiner objection sheet extraction + South Florida
   (Miami-Dade Zoning Records Viewer, City of Miami dual lookup, Fort Lauderdale DRC) adapters.
3. Skill 7 & 8: existing architectural drawing upload & AI inefficiency audit ("Upload &
   Critique") + layout search.
4. Skill 13: the automatically assembled deck from project state.
5. Skill 11 facades on the photo tiles layer (completes skill 12), then the orchestrating
   skill 14.
