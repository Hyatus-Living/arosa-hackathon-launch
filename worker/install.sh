#!/usr/bin/env bash
# Install the pinned Blender LTS + Bonsai architecture worker as a versioned release.
#
#   worker/install.sh            # install into $ACRES_WORKER_ROOT (default /opt/acres-architecture-worker)
#
# Layout under the root:
#   cache/                 verified downloads, reused by later installs
#   releases/<release-id>/ Blender, the Bonsai extension, worker scripts, bin/ wrappers,
#                          RELEASE.json, health.json and the smoke job it passed
#   current -> releases/<release-id>   switched only after health and smoke pass
# Earlier releases are kept for rollback (see docs/architecture-worker.md).
# Run as the account that owns the root; root privileges are not required.
# Progress goes to stderr; the last thing on stdout is the JSON health report.
set -euo pipefail

BLENDER_VERSION=4.5.14
BONSAI_TAG=bonsai-0.9.0post1
BLENDER_BASE=https://download.blender.org/release/Blender4.5
BONSAI_BASE=https://github.com/IfcOpenShell/IfcOpenShell/releases/download/$BONSAI_TAG

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    PLATFORM=linux-x64
    BLENDER_FILE=blender-$BLENDER_VERSION-linux-x64.tar.xz
    BLENDER_SHA256=9ba871ff2ecd36526b77432745980b7e6664ecd0c7ca11c48849073dcfe06da3
    BONSAI_FILE=bonsai_py311-0.9.0-post1-py311-linux-x64.zip
    BONSAI_SHA256=c6e486d096a05584c18fa03ae92ac7799998a4bb6d975161c698d02aa5bb79e2
    BLENDER_REL=blender/blender
    PYTHON_REL=blender/4.5/python/bin/python3.11
    ;;
  Darwin-arm64) # local development only; production is Linux x64
    PLATFORM=macos-arm64
    BLENDER_FILE=blender-$BLENDER_VERSION-macos-arm64.dmg
    BLENDER_SHA256=65134d9b07b20e2fa8d3c9e44f6f44ffb5c9774dd521b95f50387310241ca170
    BONSAI_FILE=bonsai_py311-0.9.0-post1-py311-macos-arm64.zip
    BONSAI_SHA256=a39462d5fba5db1b70bf55e9e8714f4c881102538004d0f6ba99c90aac7da3ef
    BLENDER_REL=Blender.app/Contents/MacOS/Blender
    PYTHON_REL=Blender.app/Contents/Resources/4.5/python/bin/python3.11
    ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

SOURCE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=${ACRES_WORKER_ROOT:-/opt/acres-architecture-worker}
CACHE=$ROOT/cache
SCRIPTS=(architecture_worker.py blender_job.py dressing.py render_job.py remote_worker.py health.py make_fixture_ifc.py)
SITE_REL=user-resources/extensions/.local/lib/python3.11/site-packages

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() { # url file sha256
  if [ ! -f "$CACHE/$2" ]; then
    echo "downloading $1" >&2
    curl -fL --retry 3 -o "$CACHE/$2.part" "$1"
    mv "$CACHE/$2.part" "$CACHE/$2"
  fi
  local actual
  actual=$(sha256_of "$CACHE/$2")
  if [ "$actual" != "$3" ]; then
    rm -f "$CACHE/$2"
    echo "checksum mismatch for $2: expected $3, got $actual (removed from cache)" >&2
    exit 1
  fi
}

WORKER_HASH=$(cd "$SOURCE" && cat "${SCRIPTS[@]}" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12)
RELEASE_ID=blender-$BLENDER_VERSION+$BONSAI_TAG+worker-$WORKER_HASH
RELEASE=$ROOT/releases/$RELEASE_ID
if [ -e "$RELEASE" ]; then
  echo "$RELEASE is already installed; to activate it: ln -sfn releases/$RELEASE_ID $ROOT/current" >&2
  cat "$RELEASE/health.json"
  exit 0
fi

mkdir -p "$CACHE" "$ROOT/releases"
fetch "$BLENDER_BASE/$BLENDER_FILE" "$BLENDER_FILE" "$BLENDER_SHA256"
fetch "$BONSAI_BASE/$BONSAI_FILE" "$BONSAI_FILE" "$BONSAI_SHA256"

STAGE=$ROOT/releases/.staging-$RELEASE_ID
rm -rf "$STAGE"
mkdir -p "$STAGE/worker" "$STAGE/bin" "$STAGE/user-resources"
trap 'rm -rf "$STAGE"' EXIT

echo "unpacking Blender $BLENDER_VERSION ($PLATFORM)" >&2
if [ "$PLATFORM" = linux-x64 ]; then
  mkdir "$STAGE/blender"
  tar -xJf "$CACHE/$BLENDER_FILE" -C "$STAGE/blender" --strip-components=1
  if ! "$STAGE/$BLENDER_REL" --version >/dev/null 2>"$STAGE/blender-version.err"; then
    echo "Blender does not start; install the apt packages in docs/architecture-worker.md:" >&2
    cat "$STAGE/blender-version.err" >&2
    exit 1
  fi
  rm "$STAGE/blender-version.err"
else
  mount=$(mktemp -d)
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$CACHE/$BLENDER_FILE"
  ditto "$mount/Blender.app" "$STAGE/Blender.app"
  hdiutil detach -quiet "$mount"
  rmdir "$mount"
fi

cp "${SCRIPTS[@]/#/$SOURCE/}" "$STAGE/worker/"
cat > "$STAGE/bin/architecture-worker" <<EOF
#!/bin/sh
# Run one job: architecture-worker --job <jobDir>
set -eu
release=\$(cd "\$(dirname "\$0")/.." && pwd -P)
export ACRES_BLENDER="\$release/$BLENDER_REL"
export ACRES_BLENDER_USER_RESOURCES="\$release/user-resources"
exec "\$release/$PYTHON_REL" -I "\$release/worker/architecture_worker.py" "\$@"
EOF
cat > "$STAGE/bin/architecture-worker-unit" <<'EOF'
#!/bin/sh
# Run one job inside acres-architecture-worker@.service (CPU/memory limits, sandbox):
#   architecture-worker-unit --job <jobDir>
# Needs the polkit rule in docs/architecture-worker.md. SIGTERM stops the unit.
set -eu
[ "$#" -eq 2 ] && [ "$1" = --job ] || { echo "usage: $0 --job <jobDir>" >&2; exit 2; }
unit="acres-architecture-worker@$(systemd-escape --path "$(realpath "$2")").service"
trap 'systemctl stop "$unit"; exit 143' TERM INT
systemctl start --wait "$unit" &
wait $!
EOF
cat > "$STAGE/bin/architecture-worker-gpu" <<EOF
#!/bin/sh
# Run one job on the GPU render host, or here on the CPU when it cannot start:
#   architecture-worker-gpu --job <jobDir>   (see worker/remote_worker.py)
set -eu
release=\$(cd "\$(dirname "\$0")/.." && pwd -P)
exec "\$release/$PYTHON_REL" -I "\$release/worker/remote_worker.py" "\$@"
EOF
cat > "$STAGE/bin/blender" <<EOF
#!/bin/sh
# Blender with this release's Bonsai extension (enable it with --factory-startup runs explicitly).
set -eu
release=\$(cd "\$(dirname "\$0")/.." && pwd -P)
export BLENDER_USER_RESOURCES="\$release/user-resources"
exec "\$release/$BLENDER_REL" "\$@"
EOF
cat > "$STAGE/bin/health" <<EOF
#!/bin/sh
# Print the release health report: Blender, bundled Python, Bonsai and IfcOpenShell versions.
set -eu
release=\$(cd "\$(dirname "\$0")/.." && pwd -P)
out=\$(mktemp)
"\$release/bin/blender" --background --factory-startup --offline-mode -noaudio --python-exit-code 1 \\
  --python "\$release/worker/health.py" -- "\$out" >/dev/null
cat "\$out"
rm -f "\$out"
EOF
cat > "$STAGE/bin/make-fixture" <<EOF
#!/bin/sh
# Write the small IFC fixture: make-fixture <out.ifc>
set -eu
release=\$(cd "\$(dirname "\$0")/.." && pwd -P)
PYTHONPATH="\$release/$SITE_REL" exec "\$release/$PYTHON_REL" -s "\$release/worker/make_fixture_ifc.py" "\$@"
EOF
chmod 0755 "$STAGE"/bin/*

echo "installing Bonsai from $BONSAI_FILE" >&2
BLENDER_USER_RESOURCES=$STAGE/user-resources "$STAGE/$BLENDER_REL" --offline-mode \
  --command extension install-file --repo user_default --enable "$CACHE/$BONSAI_FILE" >&2

echo "health check" >&2
"$STAGE/bin/health" > "$STAGE/health.json"
"$STAGE/$PYTHON_REL" -I - "$STAGE/health.json" <<'EOF'
import json, sys
health = json.load(open(sys.argv[1]))
assert health["blender"]["background"], health
assert health["blender"]["python"].startswith("3.11."), health
assert health["bonsai"]["enabled"] and health["bonsai"]["loadProjectOperator"], health
EOF

echo "smoke job on the IFC fixture" >&2
mkdir -p "$STAGE/smoke/input"
"$STAGE/bin/make-fixture" "$STAGE/smoke/input/model.ifc"
cat > "$STAGE/smoke/job.json" <<'EOF'
{"jobId": "install-smoke", "projectId": "install-smoke", "revision": 1,
 "settings": {"preview": {"width": 320, "height": 240}}, "deadlineSeconds": 300}
EOF
"$STAGE/bin/architecture-worker" --job "$STAGE/smoke" >&2
"$STAGE/$PYTHON_REL" -I - "$STAGE/smoke/output/verification.json" <<'EOF'
import json, sys
v = json.load(open(sys.argv[1]))
assert v["status"] == "succeeded" and v["importer"] == "bonsai", v
assert v["elements"] == {"walls": 4, "slabs": 1, "spaces": 1, "doors": 1, "windows": 0, "other": 0}, v["elements"]
EOF
rm -rf "$STAGE/smoke/tmp"

echo "smoke render of a two-storey massing beside one neighbour" >&2
mkdir -p "$STAGE/smoke-render/input"
cat > "$STAGE/smoke-render/input/scene.json" <<'EOF'
{"schema": "acres.render.scene/1", "units": "m", "scheme": "as_of_right", "label": "Smoke",
 "lot": [[0, 0], [10, 0], [10, 20], [0, 20]],
 "volumes": [{"footprint": [[0, 0], [10, 0], [10, 16], [0, 16]], "base": 0, "height": 4.5, "use": "retail"},
             {"footprint": [[0, 0], [10, 0], [10, 16], [0, 16]], "base": 4.5, "height": 3.2, "use": "residential"}],
 "context": [{"footprint": [[10, 0], [20, 0], [20, 18], [10, 18]], "base": 0, "height": 12}],
 "north": [0, -1], "sun": {"azimuthDeg": 225, "elevationDeg": 35}, "streetWidthMeters": 18.3, "floorAreaSqft": 3444}
EOF
cat > "$STAGE/smoke-render/job.json" <<'EOF'
{"jobId": "install-smoke-render", "projectId": "install-smoke", "revision": 0, "kind": "render",
 "settings": {"render": {"width": 480, "height": 320, "samples": 4}}, "deadlineSeconds": 300}
EOF
"$STAGE/bin/architecture-worker" --job "$STAGE/smoke-render" >&2
"$STAGE/$PYTHON_REL" -I - "$STAGE/smoke-render/output/verification.json" <<'EOF'
import json, sys
v = json.load(open(sys.argv[1]))
assert v["status"] == "succeeded" and v["kind"] == "render", v
assert v["scene"] == {"volumes": 2, "context": 1}, v["scene"]
EOF
rm -rf "$STAGE/smoke-render/tmp"

cat > "$STAGE/RELEASE.json" <<EOF
{
  "release": "$RELEASE_ID",
  "platform": "$PLATFORM",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "workerScriptsSha256Prefix": "$WORKER_HASH",
  "blender": {"version": "$BLENDER_VERSION", "url": "$BLENDER_BASE/$BLENDER_FILE", "sha256": "$BLENDER_SHA256", "license": "GPL-2.0-or-later"},
  "bonsai": {"tag": "$BONSAI_TAG", "url": "$BONSAI_BASE/$BONSAI_FILE", "sha256": "$BONSAI_SHA256", "license": "GPL-3.0-or-later"},
  "ifcopenshell": {"bundledWith": "bonsai", "license": "LGPL-3.0-or-later"}
}
EOF

trap - EXIT
mv "$STAGE" "$RELEASE"
ln -sfn "releases/$RELEASE_ID" "$ROOT/current.new"
if [ "$PLATFORM" = linux-x64 ]; then mv -T "$ROOT/current.new" "$ROOT/current"; else mv -h "$ROOT/current.new" "$ROOT/current"; fi
echo "activated $RELEASE" >&2

"$RELEASE/$PYTHON_REL" -I - "$RELEASE" <<'EOF'
import json, sys
from pathlib import Path
release = Path(sys.argv[1])
smoke = json.loads((release / "smoke/output/verification.json").read_text())
print(json.dumps({
    "release": json.loads((release / "RELEASE.json").read_text()),
    "health": json.loads((release / "health.json").read_text()),
    "smoke": {key: smoke[key] for key in ("status", "elements", "bounds", "timings", "peakMemoryMb", "hashes")},
}, indent=2))
EOF
