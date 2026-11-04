#!/bin/bash
# Run from the operator's checkout. SSH + sudo authorizes the exact origin/main commit;
# the host installer reads only this bundle, never the mutable builder checkout.
set -euo pipefail
MODE=normal
if [[ "${1:-}" == --urgent && "$#" == 1 ]]; then MODE=urgent
elif [[ "$#" != 0 ]]; then echo 'Usage: deploy-research.sh [--urgent]' >&2; exit 1
fi
cd "$(dirname "$0")/.."
[[ "$(pwd -P)" != /srv/arosa ]] || { echo 'Deploy from an operator checkout, not the builder workspace.' >&2; exit 1; }
: "${ACRES_GCP_PROJECT:?Set your deployment project}"
: "${ACRES_GCP_ZONE:?Set your research VM zone}"
: "${ACRES_DEPLOY_HOST:?Set your research VM name}"
git fetch -q origin main
TARGET=$(git rev-parse --verify origin/main^{commit})
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]]
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT
git bundle create -q "$TEMP/release.bundle" refs/remotes/origin/main
echo "Deploying research at $(git log -1 --format='%h %s' "$TARGET")."
# -T keeps the binary bundle intact. sudo -n must succeed for the authenticated operator;
# openclaw and the Buzz container must not have this sudo permission.
gcloud compute ssh "$ACRES_DEPLOY_HOST" --project "$ACRES_GCP_PROJECT" --zone "$ACRES_GCP_ZONE" \
  --tunnel-through-iap --quiet --ssh-flag=-T \
  --command="sudo -n /usr/local/sbin/acres-deploy-research $TARGET $MODE" < "$TEMP/release.bundle"
