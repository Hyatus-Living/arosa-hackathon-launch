# Arosa: zoning and development intelligence

Arosa is a specialized AI chat for understanding what a property could become. The primary workflow is a conversation about development ideas, grounded in a specific property and current official zoning sources. Real estate underwriting is supporting context, not the primary home-screen experience.

The product roadmap, organised as fourteen core skills the agent can call on in any order (site intake through the final deck, plus one skill that runs the whole underwriting end to end), is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Product experience

Use a refined, chat-first layout inspired by the clarity of ChatGPT and premium specialist AI workspaces such as Legora. The primary surface is a generous conversation canvas with a persistent composer. Keep navigation quiet, with saved conversations and properties on the left. Open property context, source excerpts, and concept comparisons alongside the conversation when needed.

Use warm off-white surfaces, deep green accents, restrained borders, editorial serif headings and clear sans-serif body text. Avoid a dashboard of metrics, generic AI gradients, and marketing sections inside the working app.

## First useful workflow

1. User supplies an address or parcel and their development goal.
2. Identify the municipality, parcel boundary, zoning district and overlays.
3. Gather current official zoning material. Let the user inspect each source and its jurisdiction/date.
4. Explain what is permitted, what is uncertain, and what needs discretionary approval.
5. Explore viable concepts and compare trade-offs using the same verified assumptions.
6. Produce a practical due-diligence checklist and next questions for planning staff.

Do not present an attractive concept as an established entitlement. Attach sources to regulatory claims. Keep assumptions visible. Use code for calculations; use TypeSafe for bounded classifications and rubric judgments when account credits are available, with the main model handling analysis and explanation.

## Live research scope

The chat runs the Codex harness through a private Codex App Server WebSocket client. Codex decides when to resolve an address, inspect PLUTO parcels, compare nearby properties, discover public Composio tools and retrieve evidence through Exa or other available providers. A native creative-zoning skill supports development hypotheses and legal precedent research. Answers include numbered source citations, readable excerpts and original links. The property panel shows the selected, retrieved parcel. Ambiguous parcels remain unconfirmed.

Conversations persist in the current browser. Shared team discussion and coding remain in the separate OpenClaw builder workspace. Document uploads, synchronized research conversations, exhaustive agency/court docket searches and a legal citator are not implemented. Exa results are a discovery layer; they do not guarantee complete or current zoning coverage.

## Coverage tiers

Arosa works for a property in any US city, with tiered depth. The jurisdiction is auto-detected from the address: a borough or BBL means New York City (`US-NY-NYC`), a city named with its state means that jurisdiction (for example `US-TX-AUSTIN`); when the city and state cannot be determined, ask rather than assuming New York City. New York City is deep coverage: parcel resolution, curated envelope rules where encoded, and building-footprint neighbours. Every other US city is research coverage: live official-source research for that jurisdiction with the same citation discipline, saved sources scoped to the city and its state and federal parents, and the generic concept, market and pro-forma tools. Research coverage has no parcel adapter, computed bulk envelope or footprint context yet, and NYC rules or datasets must never be applied there. Depth grows city by city as parcel adapters, rule tables and approval corpora are added deliberately per market. Every answer names its jurisdiction, coverage tier and material gaps.

## Deep-coverage market: New York City

Deep coverage covers New York City, across its five boroughs. Ask for a street address with borough or a borough-block-lot (BBL) identifier. Resolve the parcel and ask the user to confirm ambiguous matches before analysis. Do not infer rules from a neighborhood name alone.

The initial question is: “What could I build here under the current zoning, and which options are worth investigating?” Start with one property per conversation. Compare as-of-right concepts separately from ideas that require discretionary approvals. Do not rank an option as the best financial outcome without supplied cost and revenue assumptions.

### Official-source collection

- NYC Planning ZoLa: https://zola.planninglabs.nyc/ for parcel discovery, zoning districts and mapped context.
- Current NYC Zoning Resolution: https://zr.planning.nyc.gov/ for applicable provisions and linked official zoning maps. Retrieve current adopted text rather than relying on an old handbook or model memory.
- NYC Planning's zoning index map: https://www.nyc.gov/assets/planning/pages/zoning-index-map/index.html for locating official map sheets.
- NYC Department of Buildings' building-data entry point: https://www.nyc.gov/site/buildings/dob/find-building-data.page for BIS and DOB NOW records relevant to existing buildings and filings.

Use PLUTO/MapPLUTO as property data when its release and field definitions have been verified. Tax-lot data is a starting point, not proof of zoning-lot boundaries, available development rights, legal occupancy or an entitlement. Record the source, retrieval date and applicable version for each material finding. A pending proposal must never be treated as an adopted rule.

### First research response

1. Confirm the address, borough and BBL; identify source coverage and missing records.
2. Summarize the zoning district, overlays and special-district provisions that actually apply.
3. Explain permitted uses and relevant floor-area, height, setback, lot-coverage and other constraints with direct citations.
4. Compare two or three supported development concepts, showing calculations and assumptions. Clearly distinguish theoretical zoning capacity from a verified buildable envelope.
5. List unresolved issues such as zoning-lot agreements, landmarks, flood requirements, legal occupancy and additional approvals where relevant. An unchecked issue remains unknown, not cleared.
6. Offer focused next questions in the chat, with sources available in the adjacent panel.

The existing fictional Orchard Lane demo remains an interaction sample, not an NYC zoning analysis. Replace it with a verified NYC case only once the live source and inference workflow is connected.
