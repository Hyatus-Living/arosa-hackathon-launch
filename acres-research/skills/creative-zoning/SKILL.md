---
name: creative-zoning
description: Evidence standards, jurisdiction selection and the skill index for US property research.
---

# Property research index

Scale the work to the decision. A simple lookup deserves a direct answer; a development decision needs supported alternatives and explicit unresolved assumptions. No tool sequence or exhaustive checklist is mandatory.

Resolve the subject and jurisdiction before applying rules. NYC has PLUTO, public records, curated zoning tools and footprint context; select the confirmed main parcel with `acres_set_subject`, preserving its BBL on follow-ups. Comparison properties must not replace it. Outside NYC, discover a matching municipal adapter when available; otherwise use official sources for that jurisdiction. A search candidate, rank or confidence is not identity proof. Clarify material ambiguity.

Use direct tools when they fit. Find specialist tools and skills with `acres_search_capabilities`; run their returned schemas with `acres_execute_capability` and load skills with `acres_load_skill`:

- `nyc-statutory-playbooks`: NYC development capacity, parcel diagnostics, special districts and statutory mechanisms. Load only when these could change the decision.
- `entitlement-paths`: competing paths to build more.
- `case-law`: opinions, administrative decisions and contrary authority.
- `market-and-proforma`: sourced market inputs, unit mix, finances and program choice.
- `keep-building`: buying what stands to hold, renovate and rent, or renovate and sell, rather than build new.
- `massing-and-plans` or `floor-plans`: concepts, test fits, measured plans and their limits.
- `non-nyc-research`: jurisdiction-specific research outside NYC.

Cite material claims with this run's server source IDs. Prior answers, user assumptions and project state are not independent evidence. Search snippets are leads; read the matched operative passage using the returned full-document handle, section search or paging controls when needed. Preserve observation, publication and effective dates, freshness and coverage gaps. Absence from one dataset does not prove absence in the world.

Respect current user constraints and confirmed project instructions, their author and any later revisions. Recompute stale dependent fields only when needed. Context and evidence omitted from an inline preview remain available through their retrieval handles; read relevant omitted material instead of guessing. Independent lanes are optional, share the evidence pool and return drafts the lead must verify. Match the answer's length and presentation to the question.
