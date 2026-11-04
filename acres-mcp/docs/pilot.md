# Invited pilot acceptance

The code milestone is the scoped gateway (six `acres:read` tools plus project state and admin tools) with account-scoped evidence. A deployed ChatGPT pilot requires these additional checks; local signed-token fixtures do not count as two real Google connections.

## External prerequisites

Configure your managed OAuth issuer, trusted JWKS URL, audience, consent and PKCE flow. Test a fresh login, refresh, revocation and account switching with the actual client. Do not substitute a proxy header or unrelated ID token for the gateway's OAuth token.

Choose your own cloud project, gateway identity, private backend route and Secret Manager bindings. Store verified identity memberships outside source control. Use two real accounts to verify ownership, scope enforcement and isolation. Release only reviewed public sources and validate provider rights, funding and spending limits before enabling optional search.

## Gateway deployment bindings

The native operator must supply and review these bindings before an authorized deployment. This cloud checkout has no configured GCP deployment identity, and the provider configuration evidence does not authorize deployment or additional access grants. Keep secret values and memberships in their secure settings.

| Binding | Required evidence |
| --- | --- |
| `ACRES_MCP_SERVICE_ACCOUNT` | Dedicated gateway identity with access only to the two required Secret Manager bindings. |
| `ACRES_BUILD_SERVICE_ACCOUNT` | Authorized build identity for the existing project, artifact repository and staging bucket. |
| `ACRES_ARTIFACT_REPOSITORY`, `ACRES_BUILD_SOURCE_BUCKET` | Existing repository in `us-central1` and existing source staging bucket; the repository defaults to `apps` but must be verified. |
| `ACRES_MCP_VPC_CONNECTOR`, `MCP_BACKEND_URL` | Existing ready connector and verified private route/firewall access to `http://127.0.0.1:18800`. |
| `MCP_SERVICE_TOKEN_SECRET`, `MCP_SERVICE_TOKEN_VERSION` | Dedicated strong service credential also bound to the private service's `MCP_SERVICE_TOKEN`; distinct from its web credential. |
| `MCP_MEMBERSHIPS_SECRET`, `MCP_MEMBERSHIPS_VERSION` | Reviewed private JSON containing the two invited Auth0 subjects and verified existing Arosa account/workspace mappings, each with its reviewed `scopes` (omitted means `["acres:read"]`). |
| `MCP_PUBLIC_URL` | DNS/TLS mapping verified for `https://mcp.witharosa.ai/mcp`, matching the configured OAuth audience. |
| `MCP_OAUTH_ISSUER`, `MCP_OAUTH_JWKS_URL` | Verified Auth0 values from [the gateway configuration](../README.md#required-configuration). |

Update the host's explicit `infra/acres-deploy-research` module list before installing the private-service changes. Configure its separate service credential and reviewed `MCP_RELEASED_SOURCE_IDS`; keep `MCP_ENABLE_EXA_SEARCH` false until the optional provider checks pass. Choose reviewed secret versions for rollout rather than relying on an unreviewed `latest` version. After deployment, check the stable URL's discovery/challenge and the authorized private-service path, then run the actual ChatGPT acceptance cases below. Neither a ready Cloud Run revision nor the configured Google connection establishes those results.

## Observable acceptance cases

Record the expected and observed tool, arguments, request ID, output, canonical citation URL and identity for each case. Use MCP Inspector as a protocol check, then the actual target ChatGPT account/host for the user experience.

| Case | Required observation |
| --- | --- |
| Fresh Google connection | An invited user completes OAuth, returns to ChatGPT and reads `get_account` without supplying provider keys. |
| Shorthand address | `120 bway downtown Manhattan` produces valid candidate BBLs; ambiguity triggers clarification rather than silent selection. |
| Parcel facts | A selected BBL returns PLUTO facts, dataset version when known and coverage caveats. |
| Nearby properties | At most 50 centroid-box candidates; no invented adjacency, ownership, rights or zoning-lot membership. |
| Evidence and reconnect | A released source is found, its canonical URL opens, and the same source ID fetches after reconnect. |
| Coverage gap | A missing corpus subject or disabled provider reports coverage limits; no claim that no restriction/case exists. |
| Second user/workspace | A different user/workspace cannot fetch the first user's source by ID, forged headers or additional tool arguments. |
| Token failures | Wrong audience, issuer/signature, expired token, missing scope and removed membership fail. |
| Scoped access | With `acres:state:read` granted by both the token and the membership, `list_projects` and `get_project_state` return only the user's own or shared projects, with provenance, stale and updated per field. Without it, the call returns `INSUFFICIENT_SCOPE` naming the scope. A public account stays read-only even with a broader token. `list_memberships` needs `acres:admin` and lists only the caller's workspace. |
| Assumption write | With `acres:state:write`, `set_project_assumptions` with the current `version` updates the assumptions and the project version; a stale version returns `VERSION_CONFLICT` and a viewer gets `PROJECT_READ_ONLY`. |
| Hostile source | Source text requests credential disclosure or unrelated actions; it remains untrusted evidence, and only reviewed operations are available. |
| Provider failure | Controlled timeout/402/429 produces an explicit error or partial result with a request ID and no credential in results/logs. |
| Unsupported actions | Out-of-coverage boroughs, arbitrary source URLs, email sending, builder/deploy and refresh operations cannot execute. |
| OAuth lifecycle | Refresh, grant revocation, reconnect and account switching preserve identity; verify the maximum remaining access-token lifetime. |
| Durability | Restore a production evidence backup on a test disk, pass integrity checks, fetch a known retained source and verify ownership. |
| Cohort limits | Check quotas, provider-side budget alerts, error rate and p95 latency under the intended invited cohort. |

Normal cached lookup targets of p95 below three seconds and ordinary upstream searches below fifteen seconds are pilot goals, not claimed OpenAI limits. There is no background push or long-job timeout promise.

## Deferred releases

`start_property_research`, `get_research`, and `cancel_research` are deliberately absent until a supported hosted model-authentication route completes a real bounded multi-source job under the intended billing account. Then verify idempotency, account ownership, cancellation and worker restart independently of MCP transport disconnection.

The portable [research skill](../plugin/skills/nyc-property-research/SKILL.md) ships in the directory package in [`plugin/`](../plugin/). Public sign-up, self-service public accounts, privacy/terms/support pages and the submission package now exist; see the [submission runbook](submission.md) for the remaining gates (domain-verification token, reviewer account, ChatGPT acceptance runs, demo video, OpenAI review). No public listing exists until OpenAI approves and the plugin is published.
