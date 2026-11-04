#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# Deploy into the existing Acres project. This script does not create
# a project, change the web/builder service, or provision credentials/networking.
: "${ACRES_GCP_PROJECT:=hyatus-openclaw}"
: "${ACRES_MCP_SERVICE_ACCOUNT:?Set the dedicated gateway service account email}"
: "${ACRES_BUILD_SERVICE_ACCOUNT:?Set the Cloud Build service account email}"
: "${MCP_PUBLIC_URL:?Set the stable HTTPS resource URL ending in /mcp}"
: "${MCP_OAUTH_ISSUER:?Set the managed OAuth issuer}"
: "${MCP_OAUTH_JWKS_URL:?Set the trusted issuer JWKS URL}"
: "${MCP_BACKEND_URL:?Set the private Acres service origin}"
: "${MCP_SERVICE_TOKEN_SECRET:?Set the Secret Manager name for the dedicated service credential}"
: "${MCP_MEMBERSHIPS_SECRET:?Set the Secret Manager name for reviewed memberships}"
: "${ACRES_BUILD_SOURCE_BUCKET:?Set the existing Cloud Build staging bucket}"
network_args=()
if [[ -n "${ACRES_MCP_VPC_NETWORK:-}" ]]; then
  : "${ACRES_MCP_VPC_SUBNET:?Set the existing Direct VPC subnet}"
  : "${ACRES_MCP_NETWORK_TAGS:?Set the dedicated gateway network tag}"
  [[ -z "${ACRES_MCP_VPC_CONNECTOR:-}" ]] || { echo 'Choose Direct VPC or a connector, not both.' >&2; exit 1; }
  network_args=(--network="$ACRES_MCP_VPC_NETWORK" --subnet="$ACRES_MCP_VPC_SUBNET" --network-tags="$ACRES_MCP_NETWORK_TAGS")
else
  : "${ACRES_MCP_VPC_CONNECTOR:?Set an existing connector or Direct VPC network/subnet/tag}"
  network_args=(--vpc-connector="$ACRES_MCP_VPC_CONNECTOR")
fi
region=${ACRES_GCP_REGION:-us-central1}
repository=${ACRES_ARTIFACT_REPOSITORY:-apps}
service_token_version=${MCP_SERVICE_TOKEN_VERSION:-latest}
memberships_version=${MCP_MEMBERSHIPS_VERSION:-latest}
[[ "$ACRES_GCP_PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]
env_file=$(mktemp)
trap 'rm -f "$env_file"' EXIT
python3 - "$env_file" <<'PY'
import json, os, sys
keys = ['MCP_PUBLIC_URL', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_JWKS_URL', 'MCP_BACKEND_URL', 'MCP_ALLOWED_HOSTS', 'MCP_ALLOWED_ORIGINS', 'MCP_PUBLIC_ACCESS', 'OPENAI_APPS_CHALLENGE_TOKEN']
values = {key: os.environ[key] for key in keys if os.environ.get(key)}
values['MCP_MEMBERSHIPS_FILE'] = '/run/acres/memberships.json'
with open(sys.argv[1], 'w') as output:
    json.dump(values, output)
PY
gcloud projects describe "$ACRES_GCP_PROJECT" --format='value(projectId)'
gcloud artifacts repositories describe "$repository" --project="$ACRES_GCP_PROJECT" --location="$region" --format='value(name)'
gcloud secrets describe "$MCP_SERVICE_TOKEN_SECRET" --project="$ACRES_GCP_PROJECT" --format='value(name)'
gcloud secrets describe "$MCP_MEMBERSHIPS_SECRET" --project="$ACRES_GCP_PROJECT" --format='value(name)'
if [[ -n "${ACRES_MCP_VPC_NETWORK:-}" ]]; then
  gcloud compute networks subnets describe "$ACRES_MCP_VPC_SUBNET" --project="$ACRES_GCP_PROJECT" --region="$region" --format='value(network)'
else
  gcloud compute networks vpc-access connectors describe "$ACRES_MCP_VPC_CONNECTOR" --project="$ACRES_GCP_PROJECT" --region="$region" --format='value(state)'
fi
build_id=$(gcloud builds submit . --project="$ACRES_GCP_PROJECT" --region="$region" --config=cloudbuild.yaml \
  --service-account="projects/$ACRES_GCP_PROJECT/serviceAccounts/$ACRES_BUILD_SERVICE_ACCOUNT" \
  --gcs-source-staging-dir="gs://$ACRES_BUILD_SOURCE_BUCKET/source" \
  --substitutions="_REGION=$region,_REPOSITORY=$repository" --format='value(id)')
gcloud run deploy acres-mcp --project="$ACRES_GCP_PROJECT" --region="$region" \
  --image="$region-docker.pkg.dev/$ACRES_GCP_PROJECT/$repository/acres-mcp:$build_id" \
  --service-account="$ACRES_MCP_SERVICE_ACCOUNT" --allow-unauthenticated \
  "${network_args[@]}" --vpc-egress=private-ranges-only \
  --min=0 --max=2 --concurrency=20 --memory=256Mi --cpu=1 --port=8080 --timeout=30 \
  --env-vars-file="$env_file" \
  --set-secrets="MCP_SERVICE_TOKEN=$MCP_SERVICE_TOKEN_SECRET:$service_token_version,/run/acres/memberships.json=$MCP_MEMBERSHIPS_SECRET:$memberships_version" --quiet
echo 'Gateway revision deployed. Validate the stable domain, OAuth discovery, private connectivity, two real accounts and ChatGPT before inviting users.'
