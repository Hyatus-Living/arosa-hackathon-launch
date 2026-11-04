#!/bin/bash
# Setup script of the acres-gcp Claude Code cloud environment. It runs as root on Ubuntu 24.04 before
# Claude starts and installs the Google Cloud CLI and an SSH client; scripts/cloud-session-setup.sh
# then signs in on every session start.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq apt-transport-https ca-certificates gnupg curl openssh-client >/dev/null
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' > /etc/apt/sources.list.d/google-cloud-sdk.list
apt-get update -qq
apt-get install -y -qq google-cloud-cli >/dev/null
gcloud --version
