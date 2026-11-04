# Deploy an Arosa instance

Start with [self-hosting](SELF_HOSTING.md) to configure private storage, provider credentials and signed authentication. The public repository contains generic deployment helpers, not the hosted service's operational inventory.

For Google Cloud deployments, choose your own project, region, VM, service accounts, artifact repository and staging bucket. Grant each runtime only the permissions it needs. Configure `ACRES_GCP_PROJECT`, `ACRES_GCP_REGION`, `ACRES_GCP_ZONE` and `ACRES_DEPLOY_HOST` explicitly before using the shell deployment helpers. `scripts/deploy-research.sh` stages committed `main` source and drains the service before activation; `app-starter/deploy.sh` builds the web image and switches only after health succeeds.

The systemd examples in `infra/` use `/srv/arosa` for source and `/var/lib/arosa` for private state. Review the service users, paths, network bindings and permissions for your installation. Keep the research listener private. Only the authenticated web gateway and separately authenticated MCP gateway should reach it.

Store deployment-specific identity mappings, account IDs, tunnel identifiers, service-account keys and secret-resource names outside this repository. Preserve an operator-owned rollback copy, verify the installed revision and health, then repeat signed-in account isolation and saved-model checks.

The web helper also requires `ACRES_BUILD_SERVICE_ACCOUNT`, `ACRES_BUILD_SOURCE_BUCKET`, `ACRES_ARTIFACT_REPOSITORY` and `AROSA_APP_ORIGIN`. These name existing resources; the helper does not provision them.

The optional `infra/acres-pull-secrets` helper reads `ACRES_GCP_PROJECT` and `ACRES_SECRET_MAP_JSON` from `/etc/arosa/secrets.env`. The mapping is a private JSON object from application environment keys to your Secret Manager names, for example `{"RESEARCH_TOKEN":"your-research-token-secret"}`. Supply a mapping for each required enabled integration. Secret values are fetched with the VM identity and written only to the runtime directory. `infra/openclaw-gsm-resolver.mjs` separately requires `ACRES_OPENCLAW_SECRET_MAP_JSON`, a private object mapping allowed OpenClaw reference IDs to your secret names. Unmapped references are rejected before any network request.
