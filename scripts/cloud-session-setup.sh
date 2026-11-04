#!/bin/bash
# SessionStart hook. In the acres-gcp cloud environment the ACRES_GCP_SA_KEY_B64 variable holds the
# acres-cloud-deployer service-account key; sign gcloud in with it and expose it to client libraries.
# Local sessions have no such variable and exit here.
set -euo pipefail
[[ -n "${ACRES_GCP_SA_KEY_B64:-}" ]] || exit 0
# Cloud sessions set CLOUDSDK_AUTH_ACCESS_TOKEN to a placeholder for their network proxy. gcloud would
# send that instead of the key, so drop it here and in every later shell command.
unset CLOUDSDK_AUTH_ACCESS_TOKEN
KEY_FILE=$HOME/.config/gcloud/acres-cloud-deployer.json
install -d -m 700 "$HOME/.config/gcloud"
(umask 077 && printf '%s' "$ACRES_GCP_SA_KEY_B64" | base64 -d > "$KEY_FILE")
gcloud auth activate-service-account --key-file="$KEY_FILE" --quiet 2>/dev/null
gcloud config set project hyatus-openclaw --quiet 2>/dev/null
if ! command -v ssh >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq openssh-client >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq openssh-client >/dev/null 2>&1; }
fi
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  printf 'unset CLOUDSDK_AUTH_ACCESS_TOKEN\nexport GOOGLE_APPLICATION_CREDENTIALS=%s\n' "$KEY_FILE" >> "$CLAUDE_ENV_FILE"
fi
echo 'gcloud is signed in as acres-cloud-deployer in project hyatus-openclaw. docs/cloud-sessions.md lists what it may deploy.'
