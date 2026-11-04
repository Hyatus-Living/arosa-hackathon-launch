# Run your own Arosa instance

The research service, web gateway and planning sidecar can run from this checkout with your own storage paths, provider credentials and Cloudflare Access application. The web gateway verifies signed Access JWTs; local startup does not disable sign-in. The public source does not include the hosted service's accounts, private databases, credentials or deployment infrastructure.

Use Node.js 24 or later and Python 3.11 or later. Blender rendering supports Linux x64 and Apple Silicon macOS through the pinned worker installer. Run commands from the repository root unless a step changes directories.

## Install and build

```sh
npm ci
npm --prefix app-starter ci
npm --prefix acres-mcp ci
python3 -m venv planning/.venv
planning/.venv/bin/python -m pip install -r planning/requirements.txt
npm --prefix app-starter run build
npm run check
npm test
```

The test suite uses temporary stores and synthetic fixtures. It does not need production credentials. Provider calls, sign-in and rendering need the configuration below.

## Configure private storage and research

Copy `acres-research/.env.example` to `acres-research/.env`. Both `.env` files are ignored by Git. Set `ACRES_STATE_DIR` to a private, writable absolute directory and `ACRES_SECRETS_JSON` to a private JSON file outside the checkout. Restrict that file to its owner with `chmod 600`.

Create the secrets JSON with your own values:

```json
{
  "RESEARCH_TOKEN": "replace-with-a-long-random-shared-secret",
  "RESEARCH_ENGINE": "meta",
  "MODELING_RESEARCH_ENGINE": "meta",
  "UNDERWRITING_RESEARCH_ENGINE": "meta",
  "MODEL_API_KEY": "your-meta-model-api-key",
  "META_MODEL": "muse-spark-1.3",
  "COMPOSIO_API_KEY": "your-composio-project-key",
  "BILLING_ENABLED": false,
  "LISTING_RESEARCH_ENABLED": true,
  "LISTING_RESEARCH_PROVIDER": "meta"
}
```

`MODEL_API_KEY` enables the Meta agent, image, selection, feedback and review calls available to that key. `COMPOSIO_API_KEY` enables the public research tool router; connect Exa in your Composio project for its search tools. These providers may charge for use. Keep keys on the service, never in browser code.

Additional integrations are separate: `TYPESAFE_API_KEY` enables Jev selection/routing, `GOOGLE_MAPS_API_KEY` enables Maps lookups, and `SERPER_API_KEY` enables Serper search. Local knowledge needs its own corpus and embedding configuration; market feeds need their own ingestion and `ACRES_DEAL_STORE_ENABLED=true`. Their databases default to the private state directory; `ACRES_KNOWLEDGE_DB` and `ACRES_MARKET_DB` can name explicit locations. Missing integrations do not supply fabricated data. Existing historical Gemini investigations also need `GEMINI_RESEARCH_API_KEY` to resume; new Meta investigations do not.

Start research:

```sh
node --env-file=acres-research/.env acres-research/service.mjs
```

The service prints its bound address. In another terminal, `curl http://127.0.0.1:18800/healthz` should return `ok: true`. This checks startup only and makes no model call. A provider-free health rehearsal can instead use a secrets file containing only `RESEARCH_TOKEN`; it cannot perform research.

| Setting | Meaning |
|---|---|
| `ACRES_STATE_DIR` | Directory for chat, account cost profiles, optional market/knowledge data, Composio sessions, optional MCP evidence, traces and architecture revisions/jobs |
| `RESEARCH_STATE_PATH` | Existing explicit chat-database override; when set, its parent directory also determines the other service stores |
| `RESEARCH_HOST`, `RESEARCH_PORT` | Listener outside systemd socket activation; defaults remain `10.42.0.2:18800` for the deployed service |
| `ACRES_MCP_EVIDENCE_DB` | Optional explicit MCP evidence database override |
| `ACRES_PLANNING_DIR` | Planning sidecar directory; defaults to this checkout's `planning/` |

Use one research process per state directory. The service drains on SIGTERM and stops promptly on SIGINT. Keep the research listener private: it trusts the gateway's account headers only after verifying the shared service token. Never expose that token or the research listener to browsers. A systemd socket retains control of the listener when socket activation is used.

## Configure sign-in and start the web app

Create a Cloudflare Access application for your own HTTPS hostname and identity provider. Set its issuer and audience in `app-starter/.env`, copied from the example. Configure your tunnel or reverse proxy to send traffic to the local web listener and preserve `Cf-Access-Jwt-Assertion`. Set your own administrator email and application origin; do not use the hosted Arosa issuer or audience. The web server validates the JWT signature, issuer and audience and derives each account's namespace from its verified email.

Set `RESEARCH_TOKEN` to the same private value as the research service and `ACRES_RESEARCH_ORIGIN` to its reachable origin. Run:

```sh
cd app-starter
node --env-file=.env server.js
```

`http://127.0.0.1:8080/healthz` checks the web listener. `/api/public/stats` checks its authenticated connection to research. `/api/session` must return 401 without a valid Access assertion. Open your Access-protected hostname to sign in and use the app. There is no unauthenticated local-account mode.

## Enable architecture rendering

Set `ACRES_ARCHITECTURE_ENABLED=true` on both services. The planning environment above enables plan saving, IFC generation/import and scan validation. Rendered Blender/GLB/preview artifacts additionally need the worker:

```sh
ACRES_WORKER_ROOT="$HOME/.local/share/arosa-worker" worker/install.sh
"$HOME/.local/share/arosa-worker/current/bin/health"
```

The installer downloads pinned official Blender and Bonsai releases, checks their hashes and runs a real import/render smoke job before activation. Linux requires the packages listed in [Architecture worker](architecture-worker.md). Set `ACRES_ARCHITECTURE_WORKER` in the research environment to the installed absolute `current/bin/architecture-worker` path, then restart research. Restrict accepted file uploads and worker resources for an internet-facing deployment as described in the worker documentation.

When using the sandboxed `architecture-worker-unit` wrapper, run research as the existing service account named in the worker unit and its narrow polkit rule. Its state directory must belong to that account. Set `ACRES_ARCHITECTURE_PIPELINE_VERSION` to the installed worker release ID after each worker update so new renders do not reuse older artifacts.

Verify a new independent Modeling project: save a plan, render it, reopen it and compare its revision across IFC, Pascal, GLB and Blender files. Then run a sourced research question and inspect the saved provider usage. Sign in with a second account and confirm it cannot read the first account's projects. These live checks require your configured providers and sign-in, even when the installation tests pass.

## Services outside this local configuration

Leave billing disabled. The current wallet repository is bound to the hosted GCP Firestore project and attached service identity; changing the research origin does not make paid billing portable. Stripe webhooks, email delivery, external feeds, the public MCP service and scheduled jobs need their own separately configured deployment and credentials. Do not run the repository's GCP deployment scripts against a new account as a local setup step.
