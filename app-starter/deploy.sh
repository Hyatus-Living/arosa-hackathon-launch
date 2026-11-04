#!/bin/bash
set -euo pipefail
PROJECT=hyatus-openclaw
REGION=us-central1
BUILD_ACCOUNT=projects/$PROJECT/serviceAccounts/openclaw-build@$PROJECT.iam.gserviceaccount.com
BUILD_ID=$(gcloud builds submit .. --project="$PROJECT" --region="$REGION" --config=cloudbuild.yaml --service-account="$BUILD_ACCOUNT" --gcs-source-staging-dir="gs://$PROJECT-build/source" --format='value(id)')
IMAGE="$REGION-docker.pkg.dev/$PROJECT/apps/team-starter:$BUILD_ID"
gcloud compute ssh openclaw-builder --project="$PROJECT" --zone=us-central1-a --tunnel-through-iap --command="bash -s -- $IMAGE" <<'REMOTE'
set -euo pipefail
image=$1
curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token |
  python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])' |
  sudo docker login -u oauth2accesstoken --password-stdin us-central1-docker.pkg.dev >/dev/null
sudo docker pull "$image" >/dev/null
sudo docker logout us-central1-docker.pkg.dev >/dev/null
printf 'AROSA_ACRES_IMAGE=%s\n' "$image" | sudo tee /etc/arosa-acres-deploy.env >/dev/null
# Blue/green: start the image beside the live container, switch the front once it is healthy and
# stop the old one after its requests finish (infra/arosa-web-switch). A failed health check
# leaves the old container serving and exits non-zero.
sudo /usr/local/sbin/arosa-web-switch
curl -fsS --max-time 10 http://127.0.0.1:18810/healthz
REMOTE
printf '%s\n' 'https://build.witharosa.ai'
