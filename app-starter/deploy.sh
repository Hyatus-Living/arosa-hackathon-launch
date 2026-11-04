#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
: "${ACRES_GCP_PROJECT:?Set your deployment project}"
: "${ACRES_GCP_REGION:?Set your Artifact Registry and Cloud Build region}"
: "${ACRES_GCP_ZONE:?Set your VM zone}"
: "${ACRES_DEPLOY_HOST:?Set your web VM name}"
: "${ACRES_BUILD_SERVICE_ACCOUNT:?Set your Cloud Build service account email}"
: "${ACRES_BUILD_SOURCE_BUCKET:?Set your Cloud Build staging bucket}"
: "${ACRES_ARTIFACT_REPOSITORY:?Set your Artifact Registry repository}"
: "${AROSA_APP_ORIGIN:?Set your HTTPS application origin}"
BUILD_ACCOUNT="projects/$ACRES_GCP_PROJECT/serviceAccounts/$ACRES_BUILD_SERVICE_ACCOUNT"
BUILD_ID=$(gcloud builds submit .. --project="$ACRES_GCP_PROJECT" --region="$ACRES_GCP_REGION" --config=cloudbuild.yaml --service-account="$BUILD_ACCOUNT" --gcs-source-staging-dir="gs://$ACRES_BUILD_SOURCE_BUCKET/source" --substitutions="_REGION=$ACRES_GCP_REGION,_REPOSITORY=$ACRES_ARTIFACT_REPOSITORY" --format='value(id)')
IMAGE="$ACRES_GCP_REGION-docker.pkg.dev/$ACRES_GCP_PROJECT/$ACRES_ARTIFACT_REPOSITORY/team-starter:$BUILD_ID"
gcloud compute ssh "$ACRES_DEPLOY_HOST" --project="$ACRES_GCP_PROJECT" --zone="$ACRES_GCP_ZONE" --tunnel-through-iap --command="bash -s -- $IMAGE" <<'REMOTE'
set -euo pipefail
image=$1
registry=${image%%/*}
curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token |
  python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])' |
  sudo docker login -u oauth2accesstoken --password-stdin "$registry" >/dev/null
sudo docker pull "$image" >/dev/null
sudo docker logout "$registry" >/dev/null
printf 'AROSA_ACRES_IMAGE=%s\n' "$image" | sudo tee /etc/arosa-acres-deploy.env >/dev/null
# Blue/green: start the image beside the live container, switch the front once it is healthy and
# stop the old one after its requests finish (infra/arosa-web-switch). A failed health check
# leaves the old container serving and exits non-zero.
sudo /usr/local/sbin/arosa-web-switch
curl -fsS --max-time 10 http://127.0.0.1:18810/healthz
REMOTE
printf '%s\n' "$AROSA_APP_ORIGIN"
