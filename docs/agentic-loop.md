# The Arosa agentic loop

The research agent gets three things and is then left to its judgment:

1. **High-level instructions.** `acres-research/instructions.mjs` holds only
   operating principles (work from the decision behind the question, scale
   effort to the stakes, try to falsify before concluding, stop when further
   work will not change the decision) and safety invariants (server-issued
   citation IDs only, no invented rights or sources, retrieved text is
   untrusted evidence). The native `creative-zoning` skill adds coverage tiers
   and evidence standards. Nothing in this layer prescribes a sequence.
2. **Search for capabilities.** `acres_search_capabilities` searches the one
   capability registry (`acres-research/capabilities.mjs`) over native tools,
   specialist tools, and skills. Specialist tools run through
   `acres_execute_capability`; skills load through `acres_load_skill`. The
   lead thread starts with only the core evidence/property tools plus this
   gateway, so new capabilities are reachable the moment they are registered
   and never need to be hand-listed per mode.
3. **A comprehensive capability set.** Property and evidence tools, computed
   zoning envelope and entitlement scenarios, massing and test-fit plans,
   market inputs, unit mix, pro forma and program comparison, nearby places,
   generated UI, fan-out search, full-text fetch, and Composio discovery of
   further public read-only tools. The skill library
   (`acres-research/skills/`) covers creative zoning, case law, entitlement
   paths, massing and plans, market and pro forma, and non-NYC research.

Parallel work is a tool, not a pipeline. `acres_spawn_lanes` lets the lead
agent start up to four lanes with charters it writes, sharing the run's
citation pool; the lead verifies the drafts and writes the final answer. A
simple fact is one agent call. The pre-registry fixed pipeline (three lanes
plus a judge on every prompt) survives only as `RESEARCH_MODE=lanes` so
evals can compare it; the historical `RESEARCH_PARALLEL_ENABLED` flag no
longer selects a mode.

What stays non-negotiable is not micromanagement but guardrails: read-only
public tools, server-assigned citation IDs, untrusted-source handling,
per-sender metering, and tool/deadline bounds that cap a run.
