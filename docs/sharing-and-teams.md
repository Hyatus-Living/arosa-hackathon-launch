# Sharing and teams: implementation contract

Status: contract for v1 implementation on branch `feat/sharing-and-teams`. This document is the
single source of truth for the change. Where it names a shape, later work implements that shape
exactly; where it says a file is untouched, that is a requirement, not an observation.

Arosa conversations are private to one account today: every row is scoped by `conversations.owner`
or `runs.owner`, and the research service rejects any caller whose `x-acres-account` header does
not match. This change lets a conversation owner share a thread with named people and with teams,
lets invitees read or participate according to a role, and adds revocable read-only share links.
Billing, rate limits and Composio sessions stay keyed to the person who sends each message.

## Settled decisions

These are closed. Do not re-open them in implementation:

1. Share links are in v1: read-only, sign-in required, revocable. Opening a valid link claims a
   `viewer` grant for the opener (claim-on-open). Revoking a link stops new claims only; people
   who already claimed are removed through the members API.
2. Team visibility is explicit sharing only. Creating a team grants nothing by itself; a
   conversation becomes visible to a team's members only through a `conversation_members` row
   naming that team. There is no automatic team workspace.
3. Only the conversation owner manages thread access (members, teams, links, delete). Only a
   team owner manages that team. Participants cannot invite anyone in v1.
4. Display name is `people.name` when set, otherwise the email local-part
   (`alex@witharosa.ai` displays as `alex`). `people.name` is settable through `POST /people/me`.
5. Notifications are out of scope. No email, badge counts or activity digests.
6. `conversations.owner` keeps its current meaning: the creator, with full control. It is never
   reused to mean "last sender". The sender of a message is `runs.owner` / `messages.author`.
7. No billing change: wallet metering, the 30-runs-per-hour limit and the Composio tool-router
   session are per sender (see "Per-sender metering").
8. Project state belongs to a project, not a conversation (`project_fields` keyed by
   `project`; see [the project state design](project-state.md)). Every conversation is attached
   to exactly one project, and several conversations can share one. Sharing a thread shares its
   project's property, places, concepts, market inputs and pro formas. Project access is
   derived from conversation grants (see "Project access" below); projects have no grants of
   their own yet.

## Data model

Everything lives in the existing chat database
(`chat.sqlite`, opened by `ChatStore` in `acres-research/store.mjs`; WAL mode, `0600`).
Timestamps are epoch milliseconds, matching existing `created` / `updated` columns. Account ids
are the 24-hex values already enforced by the service, the wallet and Composio sessions.
Existing tables `conversations`, `runs` and `events` keep their columns (later,
`conversations` gained `project` and `project_fields` became keyed by project; see
[project-state.md](project-state.md)); `messages` gains one column. Five tables are new:

```sql
CREATE TABLE people(
  account TEXT PRIMARY KEY,          -- 24-hex account id
  email TEXT NOT NULL UNIQUE,        -- lowercase, as verified at sign-in
  name TEXT,                         -- display name; NULL means "use the email local-part"
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL);

CREATE TABLE teams(
  id TEXT PRIMARY KEY,               -- UUID
  name TEXT NOT NULL,
  owner TEXT NOT NULL,               -- account id; the only account that manages the team
  created INTEGER NOT NULL,
  archived_at INTEGER);              -- DELETE archives; there is no hard delete in v1

CREATE TABLE team_members(
  team TEXT NOT NULL REFERENCES teams(id),
  account TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  removed_at INTEGER,                -- set on removal; row is kept for audit
  PRIMARY KEY(team, account));

CREATE TABLE conversation_members(
  conversation TEXT NOT NULL REFERENCES conversations(id),
  principal_type TEXT NOT NULL CHECK(principal_type IN ('account','team')),
  principal TEXT NOT NULL,           -- an account id, or a teams.id
  role TEXT NOT NULL CHECK(role IN ('viewer','participant')),
  added_by TEXT NOT NULL,            -- account id; link claims record the link creator
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY(conversation, principal_type, principal));

CREATE TABLE share_links(
  conversation TEXT NOT NULL REFERENCES conversations(id),
  token TEXT PRIMARY KEY,            -- 32 random bytes, base64url; never sequential
  role TEXT NOT NULL CHECK(role IN ('viewer','participant')),  -- v1 always writes 'viewer'
  created_by TEXT NOT NULL,
  expires_at INTEGER,                -- NULL means no expiry
  revoked_at INTEGER);
CREATE INDEX share_links_conversation ON share_links(conversation);

ALTER TABLE messages ADD COLUMN author TEXT;  -- account id; NULL for assistant messages
```

Rules that go with the schema:

- Removal is always `removed_at = now`, never `DELETE`, for `team_members` and
  `conversation_members`. Re-adding the same principal updates the existing row: new role,
  `removed_at = NULL`, fresh `added_by` / `added_at`.
- The team creator gets a `team_members` row with `role = 'owner'` at creation. `teams.owner`
  is authoritative for management rights; the row exists so member listings are uniform.
- A `people` row is created in three places, always as an upsert keyed by account:
  (a) every authenticated research request touches the caller's row (`email`, `last_seen`);
  (b) sharing by email creates the invitee's row (`name = NULL`) even before they sign in, so
  member lists can show the fallback name immediately; (c) `POST /people/me` upserts the caller.
  Upserts never overwrite a non-null `name` except through `POST /people/me`.
- `messages.author` is written for every user message: the run input written by
  `ChatStore.begin()` and steer messages written by `RunManager.control()`. Assistant
  messages keep `author = NULL`. Reads treat a NULL author on a user message as "the owner of
  the message's run" (covers rows written during a rollback window; see Migration).

## Authorisation: one function

All conversation authorisation goes through one store function. No route, manager method or
test helper re-implements it:

```ts
access(account: string, conversationId: string): 'owner' | 'participant' | 'viewer' | null
```

Effective access, highest role wins (`owner` > `participant` > `viewer`):

1. `owner` when `conversations.owner = account`.
2. Otherwise a direct active row: `conversation_members(conversation, 'account', account)`
   with `removed_at IS NULL` gives its role.
3. Otherwise team access: any active `conversation_members(conversation, 'team', T)` row
   where `team_members(T, account)` is active (`removed_at IS NULL`) and
   `teams.archived_at IS NULL` gives that row's role.

Access is computed at read time from these rows. Nothing is denormalised onto the conversation,
so removing a member, removing someone from a team, or adding someone to a team that already
holds a grant takes effect on the very next request. Archived teams grant nothing.

Error semantics preserve today's privacy shape: **no access at all returns 404** (the same
response as a nonexistent conversation or run), while **some access but not enough for the
action returns 403** (for example a viewer attempting to send). Run-level control
(interrupt / steer) follows the same rule from the run's parent conversation.

### Role matrix

| Capability | owner | participant | viewer |
|---|---|---|---|
| See thread in `GET /conversations`, open it | yes | yes | yes |
| Read messages, sources, concepts, places, market, pro formas | yes | yes | yes |
| Read project state (conversation payload, `GET /projects/:id/state`) | yes | yes | yes |
| Edit user-owned state (`PATCH /projects/:id/state`) | yes | yes | no (403) |
| Read a run and its events (`GET /runs/:id`, SSE) | yes | yes | yes |
| Send a message (`POST /conversations/:id/runs`) | yes | yes | no (403) |
| Steer / interrupt a run they sent | yes | yes | n/a |
| Steer / interrupt another person's run | yes | no (403) | no (403) |
| Add / change / remove members or team grants | yes | no (403) | no (403) |
| Create / list / revoke share links | yes | no (403) | no (403) |
| Delete the conversation | yes | no (403) | no (403) |

### Project access

A project's role for an account mirrors the grants of the project owner's conversations:

- The **owner** of a project is the account that created it, which is the owner of the
  conversation that started it. The owner has every right.
- An account's grant (direct or through a team) on a conversation that the project owner owns
  and that is attached to the project carries over as the same project role: a **participant**
  can edit the user-owned state keys, and a **viewer** can read the state and its events.
- Any access to any other attached conversation, including owning it, gives **viewer** on the
  project and never more. A viewer can attach a new conversation of their own
  (`POST /conversations` with `projectId`), but attaching does not widen their role, and grants
  on that conversation give its members only read access to the project.
- A run writes the project state only when its sender has participant or owner on the project.
  A run in a viewer's attached conversation reads the shared state (the agent still receives
  the summary and prior state) but does not change it.
- Strangers get `404` for a project; viewers attempting an edit get `403`.

For a conversation that is the only one in its project (every conversation before projects
existed), the project role equals the conversation role, so existing sharing is unchanged.

Team management is separate from thread roles: reads of a team are allowed for its active
members and owner; every write (rename, archive, add/remove member) is team-owner only.
Non-members get 404 for a team, members attempting a write get 403.

## Identity plumbing

Today the chain is: Cloudflare Access JWT → `createAuthenticator` in `app-starter/auth.js`
sets `req.account` (`accountLinks[email] || arosaAccount(email)`, where `arosaAccount` is
`sha256("arosa:" + lowercase(email))` truncated to 24 hex chars) → `app-starter/server.js`
`proxy()` forwards `x-acres-account` → `acres-research/service.mjs` validates
`/^[a-f0-9]{24}$/`. The change:

- `createAuthenticator` also sets `req.email` (the verified lowercase email, before any
  `accountLinks` mapping). `auth.js` exports one resolver used by both the authenticator and
  the proxy: `resolveAccount(email) = accountLinks[email] || arosaAccount(email)`, with the
  links map parsed once from `AROSA_ACCOUNT_LINKS` in `auth.js`.
- `proxy()`, `billingPolicy()` and the street-view forward in `server.js` send both
  `x-acres-account` and `x-acres-email`. `GET /api/session` additionally returns `email` so
  the frontend can label "you" (it already returns `namespace`, the account id).
- The research service reads both headers, keeps the existing 24-hex check on the account,
  validates the email when present, and upserts the caller's `people` row. The service never
  recomputes the hash itself: `accountLinks` overrides mean only the web app can resolve an
  email to its account.
- Sharing with an email that has never signed in works because the account id is a fixed hash
  of the email: the web app resolves the invitee's email with `resolveAccount` and sends
  `{account, email, role}` to the members endpoint; the service stores both. When that person
  later signs in, their JWT resolves to the same account and access is already in place.

## API

Paths below are research-service paths (`acres-research/service.mjs`, behind the existing
`RESEARCH_TOKEN` Bearer [REDACTED] plus the identity headers). The web app exposes each one under
`/api` with the same suffix (for example `GET /api/conversations` → `GET /conversations`).
The legacy unscoped `POST /research` and the `/mcp-api/*` namespace are unchanged; `acres-mcp`
is untouched by this work.

Display helpers used in responses: `displayName = people.name ?? email local-part`, and for an
account with no `people` row yet (possible only for not-yet-signed-in legacy data) the literal
`"A teammate"` — never a raw account hash.

### Conversations and runs (existing routes, widened)

| Route | Min. access | Contract |
|---|---|---|
| `GET /conversations?q=` | signed in | Owned **plus shared** conversations matching the existing title/message `LIKE` search (escaped, `LIMIT 100`). Each item: `{id, title, created, updated, access, owner: {account, name}, memberCount, lastAuthor: {account, name} \| null}`. Ordered by `updated DESC` (last activity; `updated` is already bumped on run create and finish). `memberCount` = distinct accounts besides the owner with effective access (direct rows plus active members of granted teams). `lastAuthor` = author of the most recent user message, `null` when none. |
| `POST /conversations` | signed in (viewer+ on `projectId` when given) | Creates a conversation owned by the caller. With an optional body `{projectId}` it attaches to that project (`404` when the caller cannot read it); otherwise it starts a new project. `201` with the conversation payload (now including `access: "owner"` and `members` holding just the owner entry, `via: "owner"` — the same shape as `GET /conversations/:id`). |
| `GET /conversations/:id` | viewer | Existing payload (`{id, title, property, created, updated, messages, runs}`) **plus** `projectId`, `owner: {account, name}`, `access`, `members`, and `author` + `authorName` on each message (both `null` for assistant messages). `members` is the effective people list: the owner (`via: "owner"`) plus one entry per distinct account with access — `{account, name, email, role, via: "direct" \| "team"}` — highest role winning on duplicates. `runs` entries additionally carry `owner` (the sender) and `authorName` so the UI can attribute queued/running work. |
| `DELETE /conversations/:id` | conversation owner | Transactionally deletes that conversation's events, messages, runs, grants and links, then the conversation. The site and its saved project data are removed only when this was its last conversation and the caller also owns the project. Otherwise the project remains, including when a collaborator removes the final conversation. The project owner can still browse the site and start a new conversation with `{projectId}`. Explicit deletion is refused with `409` while a research run is `queued` or `running`. Automatic cleanup uses `?empty=1`, which refuses saved conversation content and any project work it would remove; malformed empty flags return `400`. |
| `POST /conversations/:id/runs` | participant | Request/response shape (`{message, id?, listingFilters?}` → `202` run). `runs.owner` is the **sender's** account. An existing ID acknowledges that same request for any caller with viewer+ access on its conversation, retaining the original sender. A different conversation, message or optional filter context returns `409`; JSON object member order is ignored. Exact retries create no work. The per-conversation cap of 10 queued runs counts all senders. |
| `GET /runs/:id` | viewer on the run's conversation | Existing `{...run, events}` payload; `run.owner` remains the sender. |
| `GET /runs/:id/events` | viewer on the run's conversation | Existing SSE stream, `after` cursor and replay semantics unchanged. |
| `POST /runs/:id/interrupt` | run sender or conversation owner | Existing behaviour for queued and running runs; anyone else with access gets `403`. |
| `POST /runs/:id/steer` | run sender or conversation owner | Existing behaviour; the steer message is stored with `author` = the steerer. |

Project state has its own routes (`GET /projects`, `GET` and `PATCH /projects/:id/state`,
`GET /projects/:id/events`), documented in [project-state.md](project-state.md) and gated by the
project access rules above. Viewers also read it through the conversation payload (the `property`
field is derived from it), and `ChatStore.projectState()` gates by `access()` (viewer+) on the
conversation and reads that conversation's project.

### Members (grant rows, owner-only)

| Route | Contract |
|---|---|
| `GET /conversations/:id/members` | The raw active grant rows for management UI: `{members: [{principalType, principal, role, name, email?, addedBy, addedAt}]}` where `name` is the person's display name or the team's name. Owner only — this is a management view, distinct from the effective `members` list on the conversation payload. |
| `POST /conversations/:id/members` | Body is either `{account, email, role}` (person; `account`+`email` resolved by the web app, see Identity plumbing) or `{teamId, role}` (team; the team must exist, not be archived, and the caller need not own it — any conversation owner may grant any team they can name, matching "explicit sharing"). Upserts the grant row, creating the invitee's `people` row when needed. `role` must be `viewer` or `participant`. Granting the conversation owner themselves is a no-op success. |
| `PATCH /conversations/:id/members/:principalType/:principal` | Body `{role}`; changes the role of an active row. `404` when no active row exists. |
| `DELETE /conversations/:id/members/:principalType/:principal` | Sets `removed_at`. Idempotent. Takes effect on the next request (read-time `access()`). |

### Share links

| Route | Contract |
|---|---|
| `POST /conversations/:id/links` | Owner only. Body `{expiresAt?}` (epoch ms, optional). Creates a `viewer` link and returns `{token, role: "viewer", expiresAt, path: "/shared/<token>"}`. |
| `GET /conversations/:id/links` | Owner only. Lists the conversation's links with `createdBy` name, `expiresAt`, and revoked state, so the owner can manage them. |
| `DELETE /conversations/:id/links/:token` | Owner only. Sets `revoked_at`. Already-claimed grants survive (decision 1). |
| `GET /shared/:token` | Any signed-in account. Unknown, revoked or expired token → `404`. Otherwise claims: if the caller is not the owner and has no direct row, insert/reactivate a direct `viewer` row (`added_by` = link creator); an existing `participant` row or ownership is never downgraded. Returns `{conversationId, access}` with the caller's effective access after claiming. The web route `GET /api/shared/:token` proxies this; the frontend then opens the conversation normally. |

### Teams

| Route | Contract |
|---|---|
| `GET /teams` | Teams the caller owns or is an active member of, archived excluded: `{teams: [{id, name, owner: {account, name}, role: "owner" \| "member", memberCount, created}]}` ordered by name. |
| `POST /teams` | Body `{name}` (trimmed, 1–80 chars). Creator becomes `teams.owner` and gets the `owner` member row. `201` with the team. |
| `GET /teams/:id` | Active members and owner (others `404`): team plus `members: [{account, name, email, role, addedAt}]` (active rows only). |
| `PATCH /teams/:id` | Team owner only. Body `{name}`. |
| `DELETE /teams/:id` | Team owner only. Sets `archived_at`; grants through the team stop applying immediately. No un-archive in v1. |
| `POST /teams/:id/members` | Team owner only. Body `{account, email}` (resolved by the web app as above). Upserts an active `member` row and the invitee's `people` row. Adding the team owner is a no-op success. |
| `DELETE /teams/:id/members/:account` | Team owner only. Sets `removed_at`. The team owner cannot be removed (`400`). Idempotent. |

### People

| Route | Contract |
|---|---|
| `GET /people?q=` | Signed in. Directory search over `people` rows: case-insensitive substring on name and email, `LIMIT 20`, returns `{people: [{account, email, name}]}` with `name` already display-resolved. Only accounts that have signed in or been shared with appear; sharing by a brand-new email still works through the hash even when it is absent here. |
| `POST /people/me` | Signed in. Upserts the caller's row from the identity headers (touching `last_seen`). Body `{name?}`: a non-empty trimmed string (≤80 chars) sets the display name; `null` or `""` clears it back to the local-part fallback. Always returns the caller's `{account, email, name}` (display-resolved), so the frontend uses an empty-body POST on boot as its "who am I" call. |

Validation conventions follow the existing service style: JSON bodies bounded by `body()`
(60 KB), text inputs validated and trimmed, errors in the `{error: "…"}` envelope with
`404` / `403` / `400` / `409` as specified above. The current top-of-router guard that 404s
any non-UUID second path segment must be restructured so `teams`, `people` and `shared`
segments route (team ids are UUIDs; tokens are not).

## Per-sender metering (no billing change)

`runs.owner` is the sender, and everything already keyed by it stays per sender with no change
to `acres-research/wallet.mjs`, `app-starter/payments.mjs` or the wallet UI:

- Wallet metering: `RunManager.work()` builds the usage meter with `owner: run.owner`
  (`createUsageMeter`), so reservations and settlement hit the sender's Firestore wallet
  (`acres_wallets/<sender>`).
- Hourly cap: `ChatStore.createRun()` counts `runs WHERE owner = sender` in the last hour
  (30). A participant sending in someone else's thread spends their own budget.
- Composio: `SessionStore.forAccount(run.owner)` gives the sender's tool-router session, so
  Composio logs and Instant charges attribute to the sender. The shared Exa service session is
  unchanged.
- The conversation owner is never charged for a participant's run, and an owner interrupting a
  participant's run does not move its charges.

## Agent visibility in multi-participant threads

A thread counts as multi-participant when its user messages have more than one distinct author
(or, equivalently, more than one distinct `runs.owner`). Single-author threads produce
byte-identical harness input to today.

- **History.** `ChatStore.begin()` builds the harness history (last 12 non-error messages
  before the current input, `{role, text}`). In a multi-participant thread each `user` turn's
  text is prefixed with the author's display name: `"[Alex] <text>"`. Assistant turns are
  unchanged. The prefix is baked into `text`, so `research()` in `acres-research/research.mjs`
  needs no new history handling (it forwards `history.slice(-8)` to `runCodex()`).
- **Latest question.** An optional `authorName` (the sender's display name, `null` for
  single-author threads) is threaded `RunManager.work()` → `research()` → `runCodex()` in
  `acres-research/codex.mjs`. When present, the turn input's final line reads
  `Latest question from <authorName>: <message>` instead of `Latest user question: …`.
  Steer text sent through `turn/steer` gets the same name prefix in multi-participant threads.
- **Prompt text.** The `developerInstructions` in `runCodex()` and
  `acres-research/skills/creative-zoning/SKILL.md` each gain the same short instruction:
  several teammates may share one conversation; user turns name their author; address the
  person who asked the current question, and attribute earlier requests to the right person
  when it matters. The stored history text remains untrusted context, as today.
- **Project state** is one shared state per project (decision 8). Any run whose sender may
  write the project advances it; provenance records the producing run, whose owner is the
  sender, and a user edit records `{tool: "user", account, at}`.

## Migration (user_version 1 → 2) and rollback

Migration runs on startup in `ChatStore`'s constructor, after the existing
`ProjectState.migrate()` call (which owns `user_version` 0 → 1 in
`acres-research/project-state.mjs` and already no-ops when the version is ≥ 1). Follow that
pattern exactly: check `PRAGMA user_version`, do all work in **one transaction**
(`BEGIN` … `PRAGMA user_version=2; COMMIT`, `ROLLBACK` and rethrow on error), so a stop
partway commits nothing and the migration reruns on next start.

Steps, only when `user_version < 2`:

1. `CREATE TABLE IF NOT EXISTS` for `people`, `teams`, `team_members`,
   `conversation_members`, `share_links`, plus the `share_links_conversation` index.
2. Add `messages.author` via `ALTER TABLE`, guarded by a `PRAGMA table_info(messages)` check
   so fresh databases (whose constructor `CREATE TABLE` may already include the column)
   converge on the same shape instead of erroring.
3. Backfill author from the owning run, in the same transaction:
   `UPDATE messages SET author = (SELECT runs.owner FROM runs WHERE runs.id = messages.run)
    WHERE role = 'user' AND run IS NOT NULL`. Assistant rows stay `NULL`. No
   `conversation_members` backfill is needed (owner access comes from `conversations.owner`),
   and `people` cannot be backfilled (emails were never stored) — rows appear on next sign-in
   or share, with the `"A teammate"` fallback covering the gap.
4. Set `PRAGMA user_version = 2` as the last statement before commit.

**Old code stays safe against the migrated database**, which is what makes rollback a plain
redeploy of the previous modules:

- Old `ChatStore` ignores the new tables. Its `addMessage()` inserts with an explicit column
  list, so `author` defaults to `NULL`; its message/conversation reads pick named fields, so
  the extra column is ignored.
- Old `ProjectState.migrate()` returns immediately at `user_version >= 1`, so version 2 does
  not retrigger or reset anything.
- `conversations.property` keeps being dual-written by `finish()` as today, so a rolled-back
  release still sees the current property (the precedent from docs/project-state.md).
- The one visible scar: user messages written by old code during a rollback window have
  `author = NULL`. The read-time fallback (NULL user author → that message's run owner, which
  under old code is always the conversation owner) renders them correctly, and re-upgrading
  needs no second backfill because the fallback is permanent.
- Rolling back hides shared threads from non-owners (owner-scoped reads return) but deletes
  nothing; grants, teams and links resume when the new code is redeployed. Links created
  before a rollback remain claimable after re-upgrade unless expired or revoked.

## Implementation map (exact files and functions per lane)

### Lane A — store and migration (`acres-research/store.mjs`)

- `ChatStore` constructor: add the five `CREATE TABLE IF NOT EXISTS` statements and call the
  new `migrateSharing()` after `this.project.migrate()`. Implement the v1→v2 transaction
  (including the `table_info`-guarded `ALTER` and the `messages.author` backfill).
- New methods: `access(account, conversationId)`; `displayName(account)` and
  `peopleByAccount(accounts)` for name resolution; `touchPerson(account, email)`,
  `setMyName(account, email, name)`, `searchPeople(q)`; `createTeam(owner, name)`,
  `listTeams(account)`, `team(account, id)`, `renameTeam(owner, id, name)`,
  `archiveTeam(owner, id)`, `addTeamMember(owner, id, account, email)`,
  `removeTeamMember(owner, id, account)`; `listGrants(conversation)`,
  `grantMember(owner, conversation, principalType, principal, role, inviteeEmail?)`,
  `setGrantRole(owner, conversation, principalType, principal, role)`,
  `removeGrant(owner, conversation, principalType, principal)`;
  `createLink(owner, conversation, expiresAt)`, `listLinks(owner, conversation)`,
  `revokeLink(owner, conversation, token)`, `claimLink(account, token)`;
  `deleteConversation(owner, id)`.
- Reworked methods: `conversation(account, id)` (gate on `access()`; add `owner`, `access`,
  effective `members`, per-message `author`/`authorName`, per-run `owner`/`authorName`);
  `list(account, q)` (owned + shared set, new item fields, same search escaping);
  `createConversation(owner)` (unchanged insert; returns the widened payload);
  `createRun(sender, conversation, input, id)` (participant+ gate instead of the owner-scoped
  `conversation()` existence check; hourly cap and queued cap unchanged);
  `runForViewer(account, id)` / `run(account, id)` (resolve the run, then gate on
  `access(account, run.conversation)` — internal callers that already hold the run row, such
  as `begin`/`finish`/`recover`, keep using unscoped row access);
  `events(account, id, after)` (viewer gate via the parent conversation);
  `projectState(account, id)` (viewer gate);
  `addMessage(conversation, run, role, text, payload, author)` (new trailing `author` param,
  default `null`); `begin(run)` (pass `run.owner` as author, build name-prefixed history in
  multi-author threads); `finish(run, …)` (assistant author stays `null`; no other change).
- `acres-research/project-state.mjs`: **untouched**. `ProjectState` is already keyed by
  conversation only (`read`, `write`, `property`); all gating stays in the store wrapper.

### Lane B — service and run manager (`acres-research/service.mjs`, `manager.mjs`)

- `service.mjs` `createResearchServer()`: rename the `owner` local to `account`; read and
  validate `x-acres-email`; call `store.touchPerson(account, email)` once per authenticated
  non-legacy request; restructure the `parts` routing so the UUID guard no longer swallows
  `teams` / `people` / `shared`; wire every route in the API tables with the specified
  404-vs-403 behaviour. Existing routes (`/billing-policy`, `/street-view`, legacy
  `/research`, `/mcp-api/*`) keep their behaviour; `POST /conversations/:id/runs` keeps
  calling `manager.enqueue(account, …)` so the run's owner is the sender.
- `manager.mjs` `RunManager`: `enqueue(sender, conversation, message, id)` (parameter
  rename only); `work(state)` — drop owner-scoping from its `store.events(...)` and
  `store.projectState(...)` calls (pass the sender; the store now gates by `access()`, and
  the sender always has participant+ on their own run), keep meter and
  `sessions.forAccount(run.owner)` per sender, pass `authorName` into `execute`;
  `control(account, id, action, text)` — authorise as run sender or conversation owner
  (resolve via the store, not `store.run(owner, id)`), record steer messages with the
  steerer's author, and prefix steer text with the steerer's name in multi-author threads.
- `research.mjs` `research()`: accept and forward the optional `authorName` only.
- `codex.mjs` `runCodex()`: optional `authorName` param → `Latest question from …` line;
  add the multi-participant sentence to `developerInstructions`.
- `skills/creative-zoning/SKILL.md`: add the matching multi-participant paragraph (near the
  project-state paragraph). It is deployed by the installer as `SKILL.md`; no list change.
- Untouched in this lane: `wallet.mjs`, `composio.mjs` (`SessionStore.forAccount` already
  keys by the account it is given), `trace.mjs`, `tools.mjs`.

### Lane C — web auth and proxy (`app-starter/auth.js`, `app-starter/server.js`)

- `auth.js`: `createAuthenticator` sets `req.email`; export `resolveAccount(email)`
  (links map + `arosaAccount`) for invitee resolution. `arosaAccount` itself is unchanged.
- `server.js`: `proxy()` adds the `x-acres-email` header (as do `billingPolicy()` and the
  street-view forward); `GET /api/session` returns `email` alongside `namespace`; add proxy
  routes `DELETE /api/conversations/:id`, `ALL /api/conversations/:id/members…`,
  `ALL /api/conversations/:id/links…`, `GET /api/shared/:token`, `ALL /api/teams…`,
  `GET /api/people`, `POST /api/people/me`. For member-creation bodies arriving as
  `{email, role}` from the browser, `server.js` resolves `account = resolveAccount(email)`
  before forwarding `{account, email, role}`.
- `payments.mjs` and `public/wallet.js`: **untouched**.

### Lane D — frontend (`app-starter/public/`)

- `index.html`: a Share button in `.topbar` `.top-actions` (next to `#wallet-button`);
  a `#share-dialog` (people search via `GET /people`, add-by-email, role pickers, team
  grants, link create/copy/revoke — owner-only sections hidden otherwise); a Teams entry in
  the sidebar (`#navigation`, below `.workspace-tools`) with a `#team-dialog` for
  create/rename/archive/member management; relabel the `.workspace-card`
  "Private workspace" once teams exist. New markup reuses existing dialog/icon patterns.
- `app.js`: on boot, `POST /people/me` (empty body) to learn the caller's display name;
  handle a `/shared/<token>` landing (call `GET /api/shared/:token`, then
  `openConversation(conversationId)`); `applyConversation()` stores `access`/`members` in
  `state`; `render()` — author label (name + initial) on user messages in multi-author
  threads, composer (`#composer`, `.send-button`) disabled with an explanatory note for
  viewers, `#run-controls` (Steer/Stop) and queued-message remove buttons shown only when
  the caller sent that run or owns the conversation, Share button state by role;
  `watchRun()` / `streamRun` unchanged in mechanics, but a viewer watching another sender's
  run relies on the same stream (now authorised server-side); add a visibility-aware
  refresh — `openConversation(state.id, {preserveScroll: true})` + `refreshHistory()` on
  `focus`/`visibilitychange` and a 5 s interval while a shared thread is open and visible —
  because today there is no polling, only SSE plus refetch on terminal run events; all new
  fetches respect the existing `generation`/`conversationLoad` tokens.
- `conversation-view.js` `renderNavigation()`: render shared-thread affordances in the
  sidebar list (owner name when not mine, member count, last author) from the widened list
  payload; `sourceList` / `conceptList` / `createScrollManager` unchanged.
- `chat-api.js`: `chatRequest` / `postChat` / `streamRun` already generic — add thin
  helpers only if needed; no signature changes.
- `styles.css`: styles for author labels, share/team dialogs, sidebar meta, viewer notice.

### Installer and deploy module list

The research installer is `infra/acres-deploy-research` (invoked by
`infra/acres-deploy-research.service` when `infra/acres-deploy-research.path` sees
`.deploy-research`, requested via `scripts/deploy-research.sh`). Its module allowlist is the
`for FILE in research.mjs service.mjs codex.mjs tools.mjs composio.mjs trace.mjs store.mjs
project-state.mjs manager.mjs generated-ui.mjs knowledge.mjs … proforma.mjs` loop near the
top of that script, plus `skills/creative-zoning/SKILL.md` installed separately. **This
change adds no new research module** (everything lands in `store.mjs`, `service.mjs`,
`manager.mjs`, `research.mjs`, `codex.mjs`, `SKILL.md`), so the list is unchanged. If any
lane introduces a new `acres-research/*.mjs` file, it must in the same commit add it to both
that `for FILE in …` list and the root `package.json` `check` script, or it will pass CI and
fail on the host.

## Tests and checks (exact commands)

Existing suites that must be updated (assertions encoding owner-only behaviour change to the
role matrix; nothing is deleted or skipped):

- `acres-research/store.test.mjs` — "cannot be read across accounts" becomes the access
  matrix (no grant → `null`/`404` equivalents stay; viewer reads but cannot `createRun`;
  participant sends with `runs.owner` = participant; team grant + removal take effect
  immediately; migration fixture rebuilt at `user_version = 1` with pre-column `messages`,
  reopened to assert backfilled `author`, `user_version = 2`, and one-shot behaviour — mirror
  the backfill test in `project-state.test.mjs`).
- `acres-research/service.test.mjs` — cross-account `404` stays for unshared threads; add
  shared read (`200`), viewer send (`403`), non-sender interrupt (`403`), link claim →
  read, revoked/expired link (`404`), team routes owner-vs-member (`403`/`404`), and the
  `x-acres-email` → `people` upsert. The restart/queue and billing-policy tests keep passing
  unchanged.
- `acres-research/project-state.test.mjs` — `store.projectState('bob', …)` is `null` without
  a grant and readable once `bob` is a viewer; staleness behaviour unchanged.
- `app-starter/tests/arosa-auth.test.mjs` — assert `req.email` is set and
  `resolveAccount` honours `accountLinks` then the hash.
- Unchanged and still green: `wallet.test.mjs`, `research.test.mjs`, `composio.test.mjs`,
  `app-starter/tests/chat-api.test.mjs`, `payments.test.mjs`, `wallet-ui.test.mjs`, and all
  knowledge/concepts/market/proforma suites. `acres-mcp` suites are not touched.

Commands (Node 24; run from repo root unless noted):

```sh
npm run check                                    # node --check on every listed module
npm test                                         # node --test acres-research/*.test.mjs app-starter/tests/*.test.mjs
node --test acres-research/store.test.mjs acres-research/service.test.mjs acres-research/project-state.test.mjs
npm run check:mcp && npm run test:mcp            # untouched, must stay green (CI runs them)
cd app-starter && npm test && npm run build && npm run test:smoke && npm run check
./scripts/deploy-research.sh                     # from your checkout: sends main to the host and requests the install
```

CI (`.github/workflows/checks.yml`) runs exactly: `npm ci` (root, `app-starter`,
`acres-mcp`), `npm run check`, `npm run check:mcp`, `npm test`, `npm run test:mcp`, then
`app-starter` `npm test`, `npm run build`, `npm run test:smoke`. A new
`acres-research/*.test.mjs` file is picked up by the existing `npm test` glob automatically;
a new source module is **not** picked up by `check` automatically (see installer note).

## Out of scope for v1

Notifications of any kind; participant link roles (links grant `viewer` only); inviting by
participants; automatic team workspaces; ownership transfer; un-archiving teams; per-team
billing or shared wallets; presence/typing indicators; message editing or per-message
reactions; guest access without an Arosa sign-in (every route still requires the existing
Cloudflare Access identity and `@witharosa.ai` domain check in `auth.js`).
