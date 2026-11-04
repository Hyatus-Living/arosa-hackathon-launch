# Cloud sessions with GCP access

Claude Code cloud sessions on this repository can develop and deploy Arosa themselves when they run in
the `acres-gcp` cloud environment. The environment carries one credential, a key for the
`acres-cloud-deployer` service account in project `hyatus-openclaw`. Everything else a deploy needs is
in Secret Manager and readable with that account.

## The environment

| Setting | Value |
|---|---|
| Name | `acres-gcp` (cloud environment at claude.ai/code) |
| Network access | Custom, with the default list included, plus the hosts below |
| Environment variables | `CLOUDSDK_CORE_PROJECT=hyatus-openclaw` and `ACRES_GCP_SA_KEY_B64=<base64 of the service-account key JSON, one line>` |
| Setup script | [scripts/cloud-environment-setup.sh](../scripts/cloud-environment-setup.sh): installs the Google Cloud CLI and an SSH client |

Additional allowed hosts:

```text
packages.cloud.google.com
dl.google.com
tunnel.cloudproxy.app
*.run.app
witharosa.ai
build.witharosa.ai
app.witharosa.ai
mcp.witharosa.ai
```

On every session start the repository's SessionStart hook ([.claude/settings.json](../.claude/settings.json))
runs [scripts/cloud-session-setup.sh](../scripts/cloud-session-setup.sh), which decodes the key,
activates the service account in `gcloud`, selects the project and exports
`GOOGLE_APPLICATION_CREDENTIALS` for client libraries. It also removes the placeholder
`CLOUDSDK_AUTH_ACCESS_TOKEN` that cloud sessions set for their network proxy, which would otherwise
shadow the key, and installs an SSH client when the container has none. Local sessions have no
`ACRES_GCP_SA_KEY_B64` and the hook exits at once.

The `permissions.allow` rules in the same settings file let `gcloud`, `git`, `npm`, `node`, `curl` and
the two deploy scripts run in cloud sessions without approval prompts, so a deploy can finish
unattended.

## What `acres-cloud-deployer` may do

| Grant | Purpose |
|---|---|
| `roles/run.developer` | Deploy `acres-mcp` revisions and keep the rollback `team-starter` service |
| `roles/cloudbuild.builds.editor` | Submit the image builds that `app-starter/deploy.sh` and the MCP deploy use |
| `roles/iam.serviceAccountUser` on `openclaw-build`, `openclaw-app`, `openclaw-builder`, `acres-mcp` | Run builds and services as their existing runtime accounts |
| `roles/storage.objectAdmin` and `roles/storage.legacyBucketReader` on `gs://hyatus-openclaw-build` | Upload build sources |
| `roles/compute.viewer`, `roles/compute.osAdminLogin`, `roles/iap.tunnelResourceAccessor` | `gcloud compute ssh openclaw-builder --tunnel-through-iap` with `sudo`, for the `arosa-acres` container deploy and the research deploy |
| `roles/secretmanager.viewer`, plus `secretAccessor` on `acres-research-token`, `acres-google-maps-server-key`, `acres-google-map-tiles-key` | Read the secrets the deploys need |
| `roles/logging.viewer`, `roles/serviceusage.serviceUsageConsumer` | Read service logs; call project APIs |

It cannot create secrets, service accounts or API keys, change IAM, or reach other projects. Those steps
stay with an operator who holds Owner on `hyatus-openclaw`.

## Secrets (Secret Manager, `hyatus-openclaw`)

| Secret | Holds | Consumers |
|---|---|---|
| `acres-research-token` | Research service bearer token | VM `/etc/arosa-acres.env` and `/etc/acres-research/secrets.json` |
| `acres-mcp-service-token`, `acres-mcp-memberships` | MCP gateway token and pilot memberships | `acres-mcp` |
| `acres-iap-oauth-client`, `openclaw-google-oauth-client` | IAP and OAuth clients | operator |
| `acres-google-maps-server-key` | API key `acres-maps-server`, restricted to Places API (New) and Street View Static API | VM `secrets.json` as `GOOGLE_MAPS_API_KEY` |
| `acres-google-map-tiles-key` | Browser key `acres-map-tiles-browser`, restricted to Map Tiles API and `https://witharosa.ai/*` | VM `/etc/arosa-acres.env` as `GOOGLE_MAP_TILES_API_KEY` |

Read one with `gcloud secrets versions access latest --secret <name> --project hyatus-openclaw`.

## Deploying from a cloud session

- Web app: export `main` with `git archive`, then `cd app-starter && ./deploy.sh`. The script builds the
  image with Cloud Build, pulls it on `openclaw-builder`, switches to it with no downtime (blue/green,
  see [arosa-deployment.md](arosa-deployment.md)) and checks `http://127.0.0.1:18810/healthz`
  (step 3 of [concept-context-deploy.md](concept-context-deploy.md)).
- Research service: `gcloud compute ssh openclaw-builder --zone us-central1-a --tunnel-through-iap --project hyatus-openclaw --ssh-key-expire-after=8h`,
  then step 2 of [concept-context-deploy.md](concept-context-deploy.md). The login user is the service
  account's OS Login user and `sudo` works.
- Web app configuration lives in `/etc/arosa-acres.env` on the VM; after editing it with `sudo`, run
  `sudo systemctl restart arosa-acres`, which starts a fresh container beside the live one and switches
  over without downtime.

## Rotating the deployer key

Create a new key, replace `ACRES_GCP_SA_KEY_B64` in the environment, then delete the old key. Existing
sessions read the new value when their VM is next restored; a new session uses it at once.

```bash
SA=acres-cloud-deployer@hyatus-openclaw.iam.gserviceaccount.com
gcloud iam service-accounts keys create /tmp/acres-key.json --iam-account "$SA"
base64 < /tmp/acres-key.json | tr -d '\n' | pbcopy && rm /tmp/acres-key.json   # paste as ACRES_GCP_SA_KEY_B64
gcloud iam service-accounts keys list --iam-account "$SA" --managed-by=user
gcloud iam service-accounts keys delete <old-key-id> --iam-account "$SA"
```
