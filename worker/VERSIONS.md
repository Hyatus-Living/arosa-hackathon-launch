# Architecture worker pinned versions

`install.sh` downloads exactly these files and refuses any whose SHA-256 differs.
Change a version only together with its checksum, then reinstall: the release ID
changes, and the previous release stays available for rollback.

| Component | Version | Licence |
|---|---|---|
| Blender (official LTS binary) | 4.5.14 LTS, build date 2026-09-15, bundled Python 3.11.15 | GPL-2.0-or-later |
| Bonsai (Blender extension) | 0.9.0.post1, release tag `bonsai-0.9.0post1`, Python 3.11 build | GPL-3.0-or-later |
| IfcOpenShell (bundled in the Bonsai wheels) | 0.9.0.post1 | LGPL-3.0-or-later |

The Bonsai build is the `py311` one, matching the Python ABI that Blender 4.5 bundles.
`install.sh` checks that bundled Python is 3.11.x, that Bonsai enables in background
mode with its `bim.load_project` importer registered, and that a fixture job imports
through Bonsai with the expected element counts.

## Downloads

| Platform | File | SHA-256 |
|---|---|---|
| Linux x64 (production) | [blender-4.5.14-linux-x64.tar.xz](https://download.blender.org/release/Blender4.5/blender-4.5.14-linux-x64.tar.xz) | `9ba871ff2ecd36526b77432745980b7e6664ecd0c7ca11c48849073dcfe06da3` |
| Linux x64 (production) | [bonsai_py311-0.9.0-post1-py311-linux-x64.zip](https://github.com/IfcOpenShell/IfcOpenShell/releases/download/bonsai-0.9.0post1/bonsai_py311-0.9.0-post1-py311-linux-x64.zip) | `c6e486d096a05584c18fa03ae92ac7799998a4bb6d975161c698d02aa5bb79e2` |
| macOS arm64 (local development) | [blender-4.5.14-macos-arm64.dmg](https://download.blender.org/release/Blender4.5/blender-4.5.14-macos-arm64.dmg) | `65134d9b07b20e2fa8d3c9e44f6f44ffb5c9774dd521b95f50387310241ca170` |
| macOS arm64 (local development) | [bonsai_py311-0.9.0-post1-py311-macos-arm64.zip](https://github.com/IfcOpenShell/IfcOpenShell/releases/download/bonsai-0.9.0post1/bonsai_py311-0.9.0-post1-py311-macos-arm64.zip) | `a39462d5fba5db1b70bf55e9e8714f4c881102538004d0f6ba99c90aac7da3ef` |

Blender checksums come from the release's `blender-4.5.14.sha256` file on
download.blender.org. Bonsai checksums are the asset digests GitHub publishes for the
`bonsai-0.9.0post1` release. Both were matched against local downloads.

No container image is used, so there is no image digest to record. The installed release
records the same URLs, checksums and licences in `RELEASE.json`.
