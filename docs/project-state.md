# Project state and dependency graph

The first item of the [roadmap](ROADMAP.md)'s suggested order. It gives every skill one persisted
object to read and write, records where each field came from, and marks downstream fields out of
date when something they were derived from changes. This note covers what is built now; later skills
add fields and edges to the same structure.

## The state object

There is one project state per project. A project is one site's work: it has a `siteKey` (the
subject's BBL once a property is selected, until then the id of the conversation that started it),
the `bbl`, a `title` (the property address, until then the conversation title), an owner and a
`version`. Every conversation is attached to exactly one project, and several conversations can
attach to the same one, so they read and advance one shared state. A new conversation starts its
own project unless it is created with a `projectId`, or with a `bbl` the owner already has a site
for, which it joins.

One owner, one lot, one site. When a run gives a project a BBL that another project of the same
owner already has, the projects converge on the oldest (`ChatStore.convergeSite`): the other
project's conversations attach to it, its fields fold in with the newest value of each field
winning (accumulating lists combine, and dependents of a replaced field go stale), its plan
revisions, renders, drawings and alert rules move over, and the emptied project is removed. The
site's event stream gets `site.merged`. A merge waits while a run is still working in the joining
project, while one of its plan renders is queued or running, or when both projects hold saved
plans; the next write or service start tries again, and opening the store merges any duplicates
left from before.

A project follows its subject. If a conversation switches to a different site partway through,
the property field changes, the project's `siteKey`, `bbl` and `title` move to the new parcel and
everything derived from the old property goes stale (see below).

The state is a set of named fields. Each field holds:

| Part | Meaning |
|---|---|
| `value` | The field's JSON value, in the same shape the interface already uses |
| `provenance` | Where the value came from (below) |
| `stale` | `null` when current, otherwise the name of the upstream field whose change made it out of date |
| `updated` | When the value was last written (epoch milliseconds) |

The fields built today are the ones the product already produces:

| Field | Value | Written by |
|---|---|---|
| `property` | The selected PLUTO parcel record | `acres_set_subject` |
| `places` | Nearby transit, retail, parks and schools | `acres_nearby_places` |
| `concepts` | The massing concepts for the subject, accumulated across answers (below) | `acres_model_concept` |
| `envelope` | The computed zoning envelope for the subject parcel, with PLUTO `capacity` and the envelope `summary` beside the geometry | `acres_zoning_envelope` |
| `market` | The recorded submarket inputs with source and date per figure | `acres_market_inputs` |
| `program` | The recommended unit mix for a residential floor area | `acres_unit_mix` |
| `proFormas` | The computed pro formas for the subject, accumulated across answers (below) | `acres_pro_forma` |
| `publicRecords` | DOB, ACRIS, HPD and E-designation records for the subject (depends on `property`) | `acres_nyc_public_records` |
| `floorplanAudits` | Floor-plate efficiency audits from the latest answer that ran any (depends on `property`, `concepts`, `plans`) | `acres_audit_floorplan` |
| `keep` | Keeping the building as it stands: holding it, renovating and renting it, and renovating and selling it, each with its highest price at the buyer's target, and the way that pays the most (depends on `property`, `assumptions`) | `acres_keep_building` |
| `assumptions` | The user's pro forma assumptions (below); an input of `proFormas` and `keep` | the user |

The auxiliary fields `assembly`, `entitlements`, `plans`, `comparisons` and `keep` follow the same rules.

### User-owned keys

Runs are the writers of every field their tools produce. A user can write exactly three keys,
through `PATCH /projects/:id/state`:

| Key | Value |
|---|---|
| `assumptions` | `{landPrice, hardCostPerSqft, softCostPerSqft, financing: {loanToCost, interestRate, termMonths}, operating: {residentialVacancyRate, residentialOpexPerUnitPerYear, commercialVacancyRate, commercialOpexPerSqftPerYear}, capRate, sellingCostRate}`. Every part is optional; each number must sit in the range `acres_pro_forma` enforces (for example `hardCostPerSqft` 50 to 3000, `termMonths` a whole number from 1 to 120, `capRate` 0.02 to 0.15). An optional `keep` part holds the numbers for keeping the building: `{renovationCostPerSqft, renovationMonths, renovatedRentPerSqftPerMonth, afterRenovationValuePerSqft, capRate, vacancyRate, operatingExpenseRatio, loanToValue, interestRate, amortizationYears, targetReturnOnCost}`, in the ranges `acres_keep_building` enforces (`KEEP_ASSUMPTION_RANGES` in `keep.mjs`). Unknown keys are refused. The value replaces the stored assumptions. |
| `market` | Market inputs in the `acres_market_inputs` shape, validated by the same normaliser (each figure needs its source and retrieval date). |
| `program` | A unit mix in the `acres_unit_mix` shape: `productType` (`rental` or `condo`) and `byBedrooms` rows of `{bedrooms, units, unitSqft}`; other parts are kept as sent. |

A user write carries provenance `{"tool": "user", "account": "<account>", "at": "<ISO time>",
"sources": []}`. It marks dependents stale through the same graph as a run write, and the derive
step below recomputes the pro formas and the keep-the-building analysis.

Later skills add their own fields (entitlement scenario, parking, plans) when they are built. No
field is reserved for them in advance.

`concepts` and `proFormas` accumulate: a new entry replaces a prior one with the same `id` or
`name`, other prior entries are kept oldest first, and the list is capped at the 12 most recent.
`provenance.lineage` lists the run that produced each kept entry. A stale list, or one written
together with a different subject parcel, is replaced instead of extended.

## Provenance

Every field carries:

```json
{"tool": "acres_nearby_places", "run": "<run id>", "sources": [
  {"title": "Google Places near the property", "url": "https://…", "kind": "places", "retrievedAt": "2026-10-13T14:02:11.000Z"}
]}
```

- `tool` is the skill that produced the value, so a stale field names what to re-run.
- `run` is the research run that wrote it, which links to its answer, events and trace.
- `sources` are the retrieved documents the value rests on, with title, URL, kind and retrieval
  date. They are copies of the run's sources without the text. Source IDs such as `[3]` are numbered
  per answer, so the state stores the source itself, not the ID.

The sources are found like this:

- `property`: the run's PLUTO sources (`kind: property`) that contain the selected BBL.
- `places`: the source each place already refers to (`sourceId`).
- `concepts`: the building-footprint source each concept's context refers to. A concept's geometry
  is the model's own proposal and its areas are computed in code, so those parts have no source.
  This is how a concept is told apart from a retrieved fact.

## Dependency graph and propagation

The graph is a fixed table in code that says, for each field, which tool produces it and which
fields it depends on:

```text
property ──▶ places
         ├─▶ envelope ──▶ concepts ──▶ program ──▶ proFormas
         └─▶ market ────────────┴──────────────────┘
```

When a run finishes, every field it produced is written in one transaction. A write counts as a
change only if the new value differs from the stored one. A changed value invalidates its
dependents only when the part they are derived from changes: a graph field may name that part as its
`basis`. The envelope's basis leaves out its parking analysis and its reader-facing notes and
citations, so recomputing parking for another transit zone updates the envelope without staling the
massing, entitlements, unit mix or pro formas built on its bulk. For each field whose basis changed,
the store finds every field that depends on it, directly or through other fields. Any of those that the same run
did not also write is marked stale, with the changed field's name. If one run selects a new property
and also models concepts for it, both are current. If a run selects a new property and nothing
else, the old concepts and places become stale with `stale: "property"`. Selecting the same parcel
again does not count as a change.

The agent re-runs dependent skills. Arosa is an agent that chooses its own tool calls, so the store
does not call skills directly. Before each run, it gives the harness a short summary of the state:
each field, when it was written, and, for stale fields, the upstream change and the tool that
regenerates it. The creative-zoning skill says to re-run that tool when the answer depends on the
field, or to say plainly that it is out of date. Writing the field again clears `stale`.

Skills that are pure calculation re-derive in code from their inputs, with no model call. The
store runs a derive callback (`deriveProFormas`) inside the write transaction, for run writes and
user writes alike: when `market`, `program` or `assumptions` changes, every stored pro forma is
recomputed with `computeProForma` from its echoed inputs with the user's assumptions merged on
top (nested `financing` and `operating` merge part by part), at the current market figures and
unit mix (same gross area and commercial space). The results are written fresh with
`derived: true` on each entry and in the provenance, keeping the prior lineage, instead of going
stale. A pro forma that had a sensitivity table gets a recomputed one. If any entry cannot be
recomputed honestly (product type changed, no units, missing rent rows, or stale geometry
upstream), the pro formas stay stale for the agent to re-run.

A user write runs a second callback, `deriveKeep`: when `assumptions` changes, the saved `keep`
analysis is repriced in code (`repriceKeep`) from the inputs its run used (`baseInputs`), with the
user's land price as the purchase price and `assumptions.keep` on top; user figures are cited as
"Your input". It always starts from the run's inputs, so a number the user clears goes back to the
run's. An analysis gone stale for another reason, such as a new parcel, stays stale for the agent to
re-run.

## Storage

The state lives in the existing chat database, `/home/openclaw/.openclaw/acres-state/chat.sqlite`,
next to the conversations it belongs to. It therefore shares that database's WAL mode, 0600
permissions, daily disk snapshots and account scoping. Its tables:

```sql
CREATE TABLE projects(
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,       -- the account that created it
  site_key TEXT NOT NULL,    -- BBL once a property is selected, else the first conversation id
  bbl TEXT,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,  -- +1 on every write that changes a field
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE project_fields(
  project TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,       -- JSON
  provenance TEXT NOT NULL,  -- JSON
  stale TEXT,                -- upstream field name, or NULL
  updated INTEGER NOT NULL,
  PRIMARY KEY(project, key)
);
CREATE TABLE project_events(
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,      -- per project, from 1
  event TEXT NOT NULL,
  data TEXT NOT NULL,        -- JSON record as streamed
  time INTEGER NOT NULL,
  PRIMARY KEY(project, seq)
);
-- conversations gains: project TEXT (the project it is attached to), indexed.
```

Access follows the conversation grants, as set out in
[sharing and teams](sharing-and-teams.md#project-access). `composio.sqlite` and
`mcp-evidence.sqlite` are unchanged.

## API

All routes sit behind the research service's bearer token and `x-acres-account`, like every
other route.

| Route | Access | Behaviour |
|---|---|---|
| `GET /projects?q=&cursor=&sitesOnly=` | signed in | `{projects: [{id, siteKey, bbl, title, owner, access, version, updated, conversationCount}], nextCursor}`: owned or shared projects, newest first, at most 100 per page. `q` matches title, site key or BBL. Optional `sitesOnly=true` selects projects with a parcel identity or saved field state before pagination; it includes drafts without an address and excludes chat-only placeholders. Home and Sites use this mode. Absent or `false` retains the general project list. Other flag values return 400. Continue with `nextCursor` until null; reset the cursor when changing search or mode. |
| `GET /projects/:id/state` | viewer | `{id, siteKey, bbl, title, owner: {account, name}, access, version, created, updated, fields}` with `ETag: "<version>"`. `fields` has every key of the graph (including `publicRecords`, `floorplanAudits` and `assumptions`), each `{value, provenance, stale, updated}`; a field not produced yet is all `null`. |
| `PATCH /projects/:id/state` | participant | Body `{version, fields: {key: value}}` for the user-owned keys only. `409 {error, version}` when `version` is not the current one; `400` for any other key or an invalid value; `403` for viewers. Returns the full state as `GET` does, with the new `ETag`. An edit that changes nothing keeps the version. |
| `GET /projects/:id/events?after=` | viewer | Server-sent events, one `data:` JSON record per event with `id: <seq>`, replaying stored events after the cursor and then streaming live, with a keepalive comment every 15 seconds. The stream stays open until the client closes it. |
| `POST /conversations` | signed in | Optional body `{projectId}` attaches the new conversation to that project (viewer+); otherwise it starts a new project. The payload includes `projectId`. |
| `GET /conversations/:id` | viewer | The payload includes `projectId`. |
| `GET /conversations/:id/deck` | viewer | Builds the deck from the conversation's project state. |

### `state.updated`

Every write that changes at least one field bumps the version and emits:

```json
{"seq": 3, "event": "state.updated", "time": 1760620000000, "projectId": "<id>", "version": 7, "keys": ["assumptions", "proFormas"]}
```

`keys` are the fields whose value changed, including derived ones. A run's write emits it on that
run's event stream (`GET /runs/:id/events`), just before `run.completed`, and on the project's
stream with the `run` id added. A user edit emits it on the project's stream with the editing
`account` added. Clients refetch `GET /projects/:id/state` when they see it.

The agent's view is unchanged: before each run it receives the summary of its conversation's
project state (`describe`, which shows the user's assumptions in full) and the current fields as
prior state.

## Migration from message payloads

Today the property is stored in `conversations.property`, and each assistant message's payload
stores that answer's `sources`, `concepts` and `places`. Each completed run's full result is also
stored in `runs.result`.

- **Projects.** On open, every conversation without a project gets one: `siteKey` is the BBL of
  its property field (or of `conversations.property`) when there is one, otherwise the
  conversation id; `title` is the property address, otherwise the conversation title; the owner
  is the conversation owner and the version starts at 0. A conversation-keyed `project_fields`
  table is then rebuilt keyed by project, with every row moved to its conversation's project.
  This runs in one transaction, is detected from the schema rather than `user_version`, and does
  nothing once every conversation has a project. Rolling back to a release before projects needs
  the conversation-keyed table back; take the daily snapshot from before the upgrade.
- **Backfill.** The first time the new code opens the database (`PRAGMA user_version` 0 → 1), it
  replays every completed run's stored result in creation order. It uses the same write a live run
  uses, so the backfilled state has the same provenance, retrieval dates and staleness it would have
  had if the state had existed all along. A conversation that has a `conversations.property` value
  but no replayable run gets its property with provenance `{"tool": "acres_set_subject",
  "migrated": true, "sources": []}`. The backfill runs in one transaction. If the process stops
  partway, nothing is committed and the backfill runs again on the next start.
- **Messages keep their payloads.** Each answer's `sources`, `concepts` and `places` stay on its
  message, because citations and concept cards render per answer. The state holds the current
  project, and messages hold the history of how it got there.
- **`conversations.property`** is still written on each run. The conversation API now reads the
  property from the state and falls back to this column, so a rollback to the previous release
  still sees the current property. The column can be dropped once rollback is no longer needed.
- **Sources** do not become a field of their own. They move into the provenance of the fields they
  support. The full per-answer source lists stay on messages for citations.

## Deliberately not built

- Grants on a project itself, moving a conversation between projects, merging projects that
  share a BBL, and renaming a project. Access is derived from conversation grants for now.
- Version history (skill 12): `version` counts changes, but earlier values are not kept.
