#!/bin/bash
# Deploy the research service at origin/main. Run it from your own checkout: the builder host has
# no GitHub credential, so this sends the new commits to the host's checkout as a git bundle over
# IAP SSH, then runs the host side of this script there.
#
# On the host (the canonical checkout), it requests the deploy of the checkout's origin/main. The
# host's path unit stages the files and restarts the service with no downtime: it waits up to 10
# minutes for a moment with no active runs, then the old process drains (keeps serving, lets
# active runs finish, up to 22 minutes) while connections wait on the systemd socket for the new
# one. A release that fails its health check is rolled back. The host writes
# .deploy-research-result; this script waits for that and prints it. --urgent skips both waits and
# stops active runs; use it only when production is broken.
set -euo pipefail
URGENT=""
if [[ "${1:-}" == --urgent ]]; then URGENT=urgent; fi
cd "$(dirname "$0")/.."
CHECKOUT=/home/openclaw/.openclaw/workspace/acres

if [[ "$(pwd -P)" != "$CHECKOUT" ]]; then
  SSH=(gcloud compute ssh openclaw-builder --project hyatus-openclaw --zone us-central1-a --tunnel-through-iap --quiet)
  git fetch -q origin main
  TARGET=$(git rev-parse origin/main)
  BASE=$("${SSH[@]}" --command "sudo -u openclaw git -C $CHECKOUT rev-parse origin/main" | tail -n 1)
  BUNDLE=""
  if [[ "$BASE" != "$TARGET" ]]; then
    # Send only the commits the host lacks when its origin/main is known here.
    RANGE=origin/main
    if git cat-file -e "$BASE^{commit}" 2>/dev/null; then RANGE="$BASE..origin/main"; fi
    BUNDLE=$(mktemp -d)/acres-$TARGET.bundle
    git bundle create -q "$BUNDLE" "$RANGE"
    gcloud compute scp "$BUNDLE" "openclaw-builder:/tmp/acres-$TARGET.bundle" --project hyatus-openclaw --zone us-central1-a --tunnel-through-iap --quiet
    rm -rf "$(dirname "$BUNDLE")"
  fi
  echo "Deploying research at $(git log -1 --format='%h %s' origin/main)."
  "${SSH[@]}" --command="bash -s -- $TARGET ${BUNDLE:+bundle} ${URGENT:+--urgent}" <<REMOTE
set -euo pipefail
GIT=(sudo -u openclaw git -C $CHECKOUT)
if [[ "\${2:-}" == bundle ]]; then
  chmod 644 /tmp/acres-\$1.bundle
  "\${GIT[@]}" fetch -q /tmp/acres-\$1.bundle refs/remotes/origin/main:refs/remotes/origin/main
  rm -f /tmp/acres-\$1.bundle
fi
[[ "\$("\${GIT[@]}" rev-parse --abbrev-ref HEAD)" == main ]] || { echo 'The host checkout is not on main.' >&2; exit 1; }
"\${GIT[@]}" merge -q --ff-only origin/main
sudo -u openclaw $CHECKOUT/scripts/deploy-research.sh ${URGENT:+--urgent}
REMOTE
  exit
fi

# Only committed, pushed files are installed, so untracked files (such as the builder's own
# notes) do not block a deploy; modified tracked files do, because they would not match main.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Commit and push the source changes before deploying research.' >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  if [[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]]; then
    git merge --ff-only origin/main
  else
    echo 'Deploy only the current origin/main commit: check out main first.' >&2
    exit 1
  fi
fi
npm ci --ignore-scripts
PREVIOUS=$(cat .deploy-research-result 2>/dev/null || true)
HEAD=$(git rev-parse HEAD)
printf '%s\n%s\n' "$HEAD" "$URGENT" > .deploy-research.tmp
mv .deploy-research.tmp .deploy-research
echo 'Research deployment requested. Waiting for active runs to finish and the host to install it.'
for _ in $(seq 1 900); do
  sleep 2
  RESULT=$(cat .deploy-research-result 2>/dev/null || true)
  if [[ -n "$RESULT" && "$RESULT" != "$PREVIOUS" ]]; then
    [[ "$RESULT" == "Installed $HEAD" ]] && { echo "$RESULT"; exit 0; }
    # An earlier deploy finished while this request waited behind it; this one runs next.
    if [[ "$(head -n 1 .deploy-research 2>/dev/null)" == "$HEAD" ]]; then PREVIOUS=$RESULT; continue; fi
    echo "$RESULT"; echo 'This commit is not installed.' >&2; exit 1
  fi
  [[ -f .deploy-research ]] || break
done
echo 'The host has not reported a result yet. Check: systemctl status acres-deploy-research.service; cat .deploy-research-result' >&2
exit 1
