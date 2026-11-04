# Arosa MCP pilot

`acres-mcp` is a stateless, OAuth-protected Streamable HTTP gateway using the official TypeScript MCP SDK v2. It exposes ten reviewed operations, each requiring one scope:

| Scope | Tools |
| --- | --- |
| `acres:read` | `get_account`, `resolve_property`, `get_property`, `find_nearby_properties`, `search`, `fetch` |
| `acres:state:read` | `list_projects`, `get_project_state` |
| `acres:state:write` | `set_project_assumptions` |
| `acres:admin` | `list_memberships` |

Every tool has explicit schemas, the behavior annotations (`readOnlyHint` is false only for `set_project_assumptions`), its own `securitySchemes` scope, and structured JSON plus text JSON. Internal request IDs stay in the `x-request-id` header and logs, out of tool outputs. It never exposes Composio discovery/execution, corpus refresh, the builder, or the existing Codex worker.

Coverage is not fixed in the contract. `get_account.coverage` lists the jurisdiction codes named in the private service's capability registry (`acres-research/capabilities.mjs`), and each parcel and search result states the jurisdiction of the registry tool behind it. The parcel tools are NYC only.

## Development

Use Node 24 and the existing isolated checkout. A separate worktree is unnecessary.

```sh
cd /workspace/acres
npm ci
npm --prefix acres-mcp ci
python3 -m venv planning/.venv
planning/.venv/bin/pip install -r planning/requirements.txt
npm run check
npm run check:mcp
npm test
```

The default test command includes Node, MCP, planning and worker suites. See [evaluation commands and measurement scope](../scripts/EVALUATION.md). The Python setup follows the existing [planning instructions](../planning/README.md); it is required before `npm test` on a fresh checkout.

The integration tests use real signed RSA tokens and the official MCP client over HTTP, an actual private service and SQLite databases, and controlled upstream fixtures. They cover tool selection contracts, both account and workspace ownership, rejected authentication and inputs, retained source IDs across reconnect/server restart, explicit coverage gaps, and redacted provider failures. Additional domain tests verify quotas, deletion, retention and backup restoration. These tests do not validate a live Google OAuth flow, deployed corpus coverage, funded Exa access, or the ChatGPT interface.

Build with `npm run build` in this directory. For a configured gateway, inject the required settings securely, then run `npm start`. Optional `HOST` defaults to `0.0.0.0`; `PORT` defaults to 8080. In a proxied cloud development environment start Node with `NODE_USE_ENV_PROXY=1` and retain the provided CA trust. The container already sets this flag.

## Required configuration

Arosa identity (`login.witharosa.ai`, the `arosa-auth` service) is the MCP OAuth issuer: `https://login.witharosa.ai/api/auth`, JWKS at `/api/auth/jwks`. It is a Better Auth OAuth provider with RS256 resource-bound tokens (`acres:read` and, where granted, the scoped access below; 600 seconds), explicit consent, PKCE S256, refresh tokens, and open Dynamic Client Registration for MCP clients. Public email sign-up is enabled with email verification; `@witharosa.ai` addresses are reserved for operator provisioning. An earlier Auth0 plan was superseded before launch and is not used anywhere.

Only user-delegated read access is granted. ChatGPT and other MCP clients register through DCR (the plugin package declares `mode: "dcr"`); the gateway verifies access tokens against the Arosa JWKS and never handles client credentials.

| Setting | Requirement |
| --- | --- |
| `MCP_PUBLIC_URL` | Stable HTTPS resource URL ending in `/mcp`: `https://mcp.witharosa.ai/mcp` (live Cloud Run behind the Cloudflare edge proxy). |
| `MCP_PUBLIC_ACCESS` | `true` gives a verified subject with no membership row an isolated self-service account in workspace `public`. A disabled membership stays denied. |
| `OPENAI_APPS_CHALLENGE_TOKEN` | Optional exact OpenAI directory verification token, served as plain text at `/.well-known/openai-apps-challenge`. |
| `MCP_OAUTH_ISSUER` | Exact managed issuer, including its trailing slash if applicable. |
| `MCP_OAUTH_JWKS_URL` | Trusted HTTPS signing-key endpoint for that issuer. |
| `MCP_BACKEND_URL` | Operator-configured private service origin, currently `http://10.42.0.2:18800`; not a user tool argument. |
| `MCP_SERVICE_TOKEN` | Strong, distinct service credential shared only with the private MCP API. Bind through Secret Manager; do not reuse `RESEARCH_TOKEN`. |
| `MCP_MEMBERSHIPS_FILE` | Private JSON file containing reviewed subject/account/workspace memberships and their scopes. |
| `MCP_ALLOWED_HOSTS` | Optional exact additional Cloud Run hostnames, comma-separated. The stable domain is always allowed. |
| `MCP_ALLOWED_ORIGINS` | Optional exact HTTPS browser origins, comma-separated. Requests without an Origin header are allowed; other browser origins are rejected. Test the actual ChatGPT host. |

The issuer must support Google as upstream identity, authorization code with PKCE S256, resource/audience binding to `MCP_PUBLIC_URL`, a supported OpenAI client registration strategy, consent, refresh-token rotation/revocation and reconnect. Configure RS256 access tokens with a space-separated `scope` claim drawn from `acres:read`, `acres:state:read`, `acres:state:write` and `acres:admin`, plus `sub`, `iat`, `exp`, and a lifetime of at most 600 seconds. JWT signature, exact issuer, exact audience, scope and lifetime are checked on every MCP request. Metadata is served at `/.well-known/oauth-protected-resource/mcp` (and the root alias) with all four scopes in `scopes_supported`; the challenge points to it. Authorization-server metadata and all OAuth transactions belong to the selected managed provider. Use short-lived access tokens: revoking a refresh grant does not retroactively invalidate an already signed JWT before expiry.

The membership file is an array with this shape; placeholders are deliberately invalid until replaced by verified identities:

```json
[
  {
    "subject": "VERIFIED_OAUTH_SUBJECT",
    "accountId": "VERIFIED_24_CHARACTER_ACCOUNT_HASH",
    "workspaceId": "pilot",
    "enabled": true,
    "scopes": ["acres:read", "acres:state:read"]
  }
]
```

### Scope model

`scopes` is optional. A row without it keeps the original read-only access, `["acres:read"]`, so existing membership files stay valid. Allowed values are the four scopes above, each at most once. A request's effective scopes are the intersection of the token's `scope` claim and the membership row's `scopes`; isolated public accounts never exceed `acres:read`, whatever the token carries. A token whose effective scopes are empty is refused at the transport with `403` and `error="insufficient_scope"`. A tool call without its scope returns an `INSUFFICIENT_SCOPE` tool error naming the missing scope, with an `mcp/www_authenticate` challenge in `_meta` so the client can ask for it; the private service is not called. `get_account.capabilities` reports the effective scopes, and `list_memberships` returns only the caller's workspace rows. Grant `acres:state:write` and `acres:admin` per reviewed row; the issuer must also be allowed to sign them.

An administrator must explicitly link the OAuth subject to the verified account value used by the existing website. A membership can supply `googleIapSubject` instead of `accountId`; the gateway calculates the exact existing namespace. Do not strip or add a prefix to that verified value: the legacy formula is the first 24 hex characters of SHA-256 of `accounts.google.com:` followed by the complete IAP subject. If both fields are supplied they must agree. The regression test runs the actual website authenticator with signed IAP fixtures, then verifies signed MCP tokens for two identities and asserts identical account IDs. It does not replace or bypass either production login. Never link accounts by an unverified email or merely assume two subject formats have the same shape.

More than one enabled workspace requires the issuer to sign `https://acres.witharosa.ai/workspace_id`; tool arguments, headers and MCP session IDs cannot select membership. Memberships are reread on each request. Disabling a membership or removing a scope takes effect once the mounted file changes; verify Secret Manager file propagation. Conversation messages and history are not exposed; with `acres:state:read` the caller can read the per-field project state of projects the account owns or was shared, and with `acres:state:write` set its assumptions.

An empty reviewed membership array is valid. With `MCP_PUBLIC_ACCESS=true`, authenticated subjects receive their own isolated public account without administrator linking; with it off, an empty array denies every authenticated user. Do not use fabricated subjects or placeholder account mappings to bootstrap access.

Deployment may use existing Direct VPC access with `ACRES_MCP_VPC_NETWORK`, `ACRES_MCP_VPC_SUBNET` and `ACRES_MCP_NETWORK_TAGS`, or an existing `ACRES_MCP_VPC_CONNECTOR`. Configure one route only. The dedicated network tag must have a reviewed private-backend firewall path.

## Private service and sources

Install the new modules using the updated explicit list in `infra/acres-deploy-research`; an administrator must update the host installer before deploying research code. The existing listener/IAP routes retain their protection. `/mcp-api/tools/<reviewed operation>` accepts only the separate `MCP_SERVICE_TOKEN`, validates arguments again, and requires a trusted account and workspace from the gateway. That credential cannot access the web conversations/runs, and the web credential cannot access this API.

The private service's configuration adds `MCP_SERVICE_TOKEN`, optional `MCP_RELEASED_SOURCE_IDS` (an array of reviewed public source IDs), and `MCP_ENABLE_EXA_SEARCH` (boolean, default false). Do not print the existing secrets file. Operator configuration and provider credentials remain outside source control. `ACRES_MCP_EVIDENCE_DB` can override the host's default evidence database path. The gateway has no model or provider credentials.

Project state tools read through callbacks injected at the `createMcpDomain` call site: `readState` is `store.projectView(account, projectId)`, `listProjects` is `store.listProjects(account)` and `writeState` is `store.updateProjectState(account, projectId, {version, fields: {assumptions}})`, so access follows the web app's project grants (owner, and grants on the project's conversations). `get_project_state` returns the project `version` and each produced field with its value, provenance (producing tool, run and sources), `stale` (the upstream field that changed, or null) and `updated`. `set_project_assumptions` takes the `version` the caller last read: a newer version is refused with `VERSION_CONFLICT`, a viewer gets `PROJECT_READ_ONLY`, and the assumptions object replaces earlier user assumptions, with pro formas recomputed when they can be. Without a `writeState` callback the private service answers `501 NOT_IMPLEMENTED`.

Parcel tools reuse the same PLUTO/GeoSearch implementation as the web harness. Exact matches and approximate candidates remain distinct; nearby results use a centroid bounding box, capped at 50. Dataset versions are returned when supplied, otherwise unknown. No FAR-derived legal entitlement is claimed.

Corpus search is gated by `MCP_RELEASED_SOURCE_IDS` and filters released sources before ranking. It searches only NYC and applicable New York/federal sources, uses lexical retrieval, and cannot enqueue refreshes. Source IDs are stable opaque account/workspace-owned snapshot IDs; fetch works independently of a previous in-memory search session. The evidence snapshot includes title, canonical HTTPS URL, source version, observation/retrieval dates, known publication/effective dates, jurisdiction, coverage and truncation. Dates remain null when unknown. Returned text is untrusted evidence.

Omitting `offset` in `fetch` returns the original matched excerpt. To read the complete retained document, pass `offset: 0`, then follow `metadata.nextOffset` until it is null. Each response contains at most 48,000 UTF-16 characters and keeps the same document hash and source version. When captured PDF page ranges are available, `metadata.documentPdfPages` lists each physical page with its UTF-16 `start` and `end` in the complete text. Missing ranges remain unavailable; the matched excerpt's PDF identity is separate from the full-document offsets.

Public search, when deliberately enabled, calls only the pinned `EXA_SEARCH` session, with five results and at most 12,000 text characters per result. It does not discover public/Instant tools or route arbitrary SaaS operations. Search extracts are explicitly labeled as extracts. Verify provider funding, entitlement and retention/redistribution rights before enabling it. A known failure or disabled/unreleased integration returns an explicit issue with coverage, never a fabricated answer or a claim that a rule/case does not exist.

The pilot admits 120 `acres:read` tool requests/account/hour, 30 public searches/account/hour, 200 public searches/day across the service, and two concurrent upstream operations. Project state calls (read or write) have their own 240/account/hour counter and admin calls their own 60/account/hour counter, so neither consumes the read quota. Admission counts persist in SQLite; failed attempts also consume admission. These are request caps, not a dollar guarantee. Configure provider-side spending caps and alerts before inviting users.

## Storage and operations

The stateless gateway is suitable for Cloud Run. The evidence database stays on the existing private service's persistent disk; do not put it on an ephemeral Cloud Run filesystem or independently scale copies of the SQLite service. Evidence retention defaults to 30 days; expired rows are unavailable immediately and pruned on subsequent admissions or the private admin command. Queries and raw tool payloads are not stored in the gateway logs; MCP corpus searches also avoid the corpus's legacy raw-query retrieval log. Logs contain request IDs, pseudonymous account/workspace IDs, tool names, latency, outcome and safe error codes. Protect these logs and configure their retention separately.

Host-only administration (no public tool exposes these actions):

```sh
node /opt/acres-research/mcp-admin.mjs backup /SECURE_BACKUP_PATH/mcp-evidence.sqlite
node /opt/acres-research/mcp-admin.mjs prune
node /opt/acres-research/mcp-admin.mjs delete-account WORKSPACE VERIFIED_ACCOUNT_HASH
```

SQLite's backup API includes committed WAL state. The automated tests restore a backup, run `integrity_check`, and verify the known snapshot and ownership. Production backup schedules, storage permissions and restore drills still need validation. Deleting active evidence does not purge earlier backups; the deployed backup retention policy must be disclosed separately. The admin command does not delete web chat history. Define a broader deletion process before wider use.

## Deployment and release

Use the existing GCP project `hyatus-openclaw`, region `us-central1`, and a new `acres-mcp` service. Keep `team-starter`, `openclaw-builder` and their IAP/access policies intact. This repository does not create a project or change billing.

`deploy.sh` is a preparation artifact, not authorization to deploy. It requires a dedicated gateway/build identity, existing Artifact Registry and staging bucket, Secret Manager bindings, and a connector/network/firewall path to the private backend. The gateway needs secret access only for its two bindings. Review service and networking configuration before running it with an authorized native GCP identity. It publicly exposes the new MCP service at the transport layer while enforcing application OAuth; it does not remove IAP from the existing app. A successful Cloud Run revision alone does not establish that the proposed stable domain is mapped or usable.

See [pilot acceptance and rollout gates](docs/pilot.md) and the [directory submission runbook](docs/submission.md). The stable HTTPS deployment is live; released corpus inventory, provider rights/funding, actual ChatGPT acceptance cases, and OpenAI review remain release gates. Deep research remains outside the catalog until project API-key inference or a separately approved hosted authentication route completes a real research job. The submission package lives in [`plugin/`](plugin/) — `plugin.json`, `mcp.json`, the research skill and listing icons.
