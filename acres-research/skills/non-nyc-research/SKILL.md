---
name: non-nyc-research
description: Research in a US city without an Arosa parcel adapter or curated rules. Load whenever the site is outside New York City: live official-source research scoped to that jurisdiction, coverage tier and gaps named, NYC rules never imported.
---

# Research-tier cities outside New York City

Outside NYC there is no parcel adapter, curated bulk-rule table or building-footprint context yet. Work from live official sources for the actual jurisdiction plus the generic concept, market and pro forma tools.

- Identify the site from retrieved official evidence. Never invent a parcel identifier, zoning district, FAR or height limit, and never apply NYC rules, datasets or section numbers to another city.
- Pass the detected jurisdiction (for example `US-TX-AUSTIN`) as the city argument to knowledge and source-registry searches. Empty saved-knowledge or registry results mean no saved coverage yet, not that no rule exists.
- Prefer the municipality's own code, zoning map documentation, and county/state sources via `acres_fanout_search` and `acres_fetch_url`; use `acres_discover_tools` when a public tool fits the source better.
- State the coverage tier and the material gaps (no parcel data, no computed envelope) in the answer, and name the local document or determination that would close each gap.
- Model concepts only from lot dimensions the user supplied or retrieved evidence supports, and say which. Market inputs, unit mix and pro forma work the same as in NYC once figures are evidenced for that submarket.
- Do not retry NYC parcel lookups for a non-NYC address after jurisdiction detection; `acres_find_property` returning research-tier coverage is the signal to switch methods, not an error to retry around.
