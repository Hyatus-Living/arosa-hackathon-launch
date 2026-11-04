# ArosAI

The `arosa-buzz` service runs one Codex worker connected to the hosted `witharosa.communities.buzz.xyz` relay. Community members type normally in `#arosai` or a direct message, and select **ArosAI** from the mention picker in `#general`. `buzz-acp.toml` limits no-mention replies to `#arosai`; other channels retain explicit mentions. The shared default is `gpt-6.1-sol` with `medium` reasoning. Channel threads have separate Codex sessions; coding requests queue through one worker against the existing Arosa checkout.

New members only need the Buzz application, their community invitation, and their own Buzz identity. They do not configure a harness, model, provider key, or Builderlab hosting account. The channel topic and welcome guide point them to `#arosai`.

## Recovery

Each person should use Buzz Settings, Profile, Private key, Create backup to create an encrypted identity backup with their own password, store it privately, and use Test backup to verify it. Never post the private key, backup, or password in a channel. The email password is separate from the Buzz identity.

The operator recovery bundle contains the root-only `/etc/arosa-buzz.env`, `/var/lib/arosa-buzz`, and `/opt/arosa-buzz` files. Restore them with their original ownership and private permissions before starting the systemd unit. Never put this bundle in Git or share it with community members. A host-local bundle only protects against accidental changes on the host, not host loss.

The pinned upstream harness publishes typing, turn liveness, and terminal failure notices in the request's conversation, including a reauthentication hint for an expired OAuth login. Keep these features enabled. If shared sign-in expires, Michael should sign in again through the dedicated Codex home. If plan capacity is exhausted, wait for the account's limit reset; do not substitute an API key or another user's credentials.

The container runs without root, a Docker socket, host administration credentials, mail storage, or other OpenClaw workspaces. It mounts the Arosa checkout and its existing repository-specific SSH credential. The root filesystem is read-only. The persistent home is `/var/lib/arosa-buzz`; the agent environment is `/etc/arosa-buzz.env`, mode `0600`. Neither belongs in Git. Michael remains the Buzz agent owner.

The adapter uses a dedicated ChatGPT sign-in under `/var/lib/arosa-buzz/.codex`. It consumes that account's plan limits. It does not use an OpenAI API key or the Hyatus model gateway.

Build the image on the VM with the three Linux binaries extracted from Block's `desktop-v0.5.28` release beside the Dockerfile. Verify the release archive's SHA-256 against GitHub's asset digest. The Codex ACP adapter is pinned to `2.2.2`. The image also builds `git-sign-nostr` from that release's pinned source commit so the agent can follow the repository's signed-commit workflow.

Install the systemd unit and start it only after relay enrollment and Codex login succeed. `systemctl status arosa-buzz` and `docker logs arosa-buzz` show service state. Restart-on-failure preserves a successful owner-requested shutdown. Existing Arosa and OpenClaw services remain independent.

## Shared personas

`arosa-persona@.service` runs Fizz, Honey, and Pollen on the same pinned image. Each has its own Buzz identity, instructions, channel, and work directory under `/var/lib/arosa-agents/<slug>`. Each instance loads a root-only `/etc/arosa-agents/<slug>.env`. The instances use the existing company Codex authentication home at `/var/lib/arosa-buzz/.codex`; credentials are never sent to members. Do not put those environment files in Git.

The personas have no application checkout, repository SSH key, mail storage, Docker socket, or cloud administration credentials. Their writable work directories are separate. They are limited to 1 CPU and 1536 MB each; ArosAI's coding service remains separate. Shared Codex capacity is still bounded by the same account's limits. The company agent runtime is an operator trust boundary, not a separate private credential store for each conversation.

`shared-personas.json` records the non-secret profile and channel configuration. Install the template unit, private environment files, and instructions before enabling `arosa-persona@fizz`, `arosa-persona@honey`, and `arosa-persona@pollen`. Verify a real reply from each identity. Include `/etc/arosa-agents` and `/var/lib/arosa-agents` in operator recovery backups.

See `TEAM-QUICKSTART.md` for the member-facing setup instructions and the distinction between shared agents and personal Codex agents.
