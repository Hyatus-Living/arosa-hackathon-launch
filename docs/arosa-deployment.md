# Deploy an Arosa instance

Start with [self-hosting](SELF_HOSTING.md) to configure private storage, provider credentials and signed authentication. The public repository contains generic deployment helpers, not the hosted service's operational inventory.

For Google Cloud deployments, choose your own project, region, VM, service accounts, artifact repository and staging bucket. Grant each runtime only the permissions it needs. Configure `ACRES_GCP_PROJECT`, `ACRES_GCP_REGION`, `ACRES_GCP_ZONE` and `ACRES_DEPLOY_HOST` explicitly before using the shell deployment helpers. `scripts/deploy-research.sh` stages committed `main` source and drains the service before activation; `app-starter/deploy.sh` builds the web image and switches only after health succeeds.

The systemd examples in `infra/` use `/srv/arosa` for source and `/var/lib/arosa` for private state. Review the service users, paths, network bindings and permissions for your installation. Keep the research listener private. Only the authenticated web gateway and separately authenticated MCP gateway should reach it.

Store deployment-specific identity mappings, account IDs, tunnel identifiers, service-account keys and secret-resource names outside this repository. Preserve an operator-owned rollback copy, verify the installed revision and health, then repeat signed-in account isolation and saved-model checks.

The web helper also requires `ACRES_BUILD_SERVICE_ACCOUNT`, `ACRES_BUILD_SOURCE_BUCKET`, `ACRES_ARTIFACT_REPOSITORY` and `AROSA_APP_ORIGIN`. These name existing resources; the helper does not provision them.

The optional `infra/acres-pull-secrets` helper reads `ACRES_GCP_PROJECT` and `ACRES_SECRET_MAP_JSON` from `/etc/arosa/secrets.env`. The mapping is a private JSON object from application environment keys to your Secret Manager names, for example `{"RESEARCH_TOKEN":"your-research-token-secret"}`. Supply a mapping for each required enabled integration. Secret values are fetched with the VM identity and written only to the runtime directory. `infra/openclaw-gsm-resolver.mjs` separately requires `ACRES_OPENCLAW_SECRET_MAP_JSON`, a private object mapping allowed OpenClaw reference IDs to your secret names. Unmapped references are rejected before any network request.

## Research deployment authorization

Run `scripts/deploy-research.sh [--urgent]` from an operator-controlled checkout. It fetches `origin/main`, sends a complete Git bundle through GCP IAP SSH, and invokes the administratively installed `/usr/local/sbin/acres-deploy-research COMMIT normal|urgent` through `sudo -n`. The SSH account must be an authorized host administrator. Neither `openclaw`, the research service account, nor the Buzz container may invoke that helper through sudo or administer systemd. Branch names and clean worktrees are not authorization.

The fixed helper takes the expected commit from the operator's sudo command, imports the bundle into a new root-owned repository with isolated Git configuration, checks the exact commit, and exports it into root-only staging. All executed helpers and installed files come from that export. It never updates itself, reads the builder checkout, or copies its `node_modules`. The former `.deploy-research` file and path/service trigger are retired. Results are printed to the SSH session and recorded in root-only `/var/lib/acres-research-release/result`; the runtime revision and `/healthz` remain the live verification sources. Concurrent deploys fail instead of replacing one another.

## One-time administrative upgrade

Before using this flow on an existing host:

1. Use the operator's authenticated SSH session to disable and stop `acres-deploy-research.path` and `acres-deploy-research.service`. Back up and remove their old unit files from `/etc/systemd/system`, run `systemctl daemon-reload`, and mask both units. Do not re-enable the workspace watcher.
2. From a reviewed immutable commit in the operator's checkout, export `infra/acres-deploy-research` with `git show COMMIT:infra/acres-deploy-research`. Send it through the operator's SSH stdin to a root-created temporary file, then install that file as root-owned mode `0755` at `/usr/local/sbin/acres-deploy-research`. Do not install from `/srv/arosa`, a user-owned temporary file, or a mutable working tree. Repeat this explicit administrative step when the installer's module list changes.
3. Review the helper's sudo policy. Grant it only to the intended operator account, never to `openclaw`, the runtime account, a group containing either, or a chat agent. Confirm those identities cannot run it or modify the helper, its ancestors, `/var/lib/acres-research-release`, or systemd configuration. An existing policy granting general root access to a runtime identity must be removed before claiming isolation.
4. Back up state permissions and stop all writers before hardening the state boundary described below. Keep the ledger timer stopped until the first successful release, which installs its entrypoint at `/opt/scripts/ledger-sync.mjs` and then enables the timer. Verify the installed ledger unit no longer executes `/srv/arosa` source.
5. Install the reviewed `infra/arosa-buzz/arosa-buzz.service` administratively and restart Buzz. Inspect its effective Docker mount configuration and verify `/workspace/acres` is read-only. Keep agent edits in an independent writable directory and use reviewed Git changes for releases.

The host needs Git, `flock`, GNU coreutils, systemd with `LoadCredential` support, its existing Node/Python runtimes and approved dependencies. Dependency changes remain an explicit administrative operation: install from the reviewed lockfile into a root-controlled dependency tree, retain rollback, and do not import packages from the builder workspace. This flow creates no cloud resources or credentials.

## Shared state permissions

The existing callers create SQLite databases, WAL files, traces and artifacts directly under `/var/lib/arosa`; the ledger also uses the OpenClaw home state path. Moving all callers is a separate migration. Preserve existing file ACLs and state, but make the shared parent root-owned with its sticky bit set. This permits each writer to create, rename and delete its own state while preventing it from replacing another identity's private directory. OpenClaw's directory must remain owned by `openclaw`, mode `0700`, with no named or default ACL granting the research user access. Systemd reads the environment and credential files before starting research. The research unit gets read-only copies of the two JSON credentials and needs no OpenClaw directory access. Restart it after rotating credentials.

After stopping writers, inspecting for symlinks, and backing up `getfacl` output outside this tree, an administrator can apply the following to the actual research account (shown as `acres-runtime`). Fail and investigate if either directory is a symlink or has unexpected ownership; do not follow it or recursively change state ownership.

```sh
sudo chown root:root /var/lib/arosa
sudo chmod +t /var/lib/arosa
sudo setfacl -m u:openclaw:rwx,u:acres-runtime:rwx,m::rwx /var/lib/arosa
sudo -u openclaw setfacl -b -k /var/lib/arosa/openclaw
sudo -u openclaw chmod 0700 /var/lib/arosa/openclaw
```

The parent write permission is required for the existing SQLite WAL layout, not for OpenClaw access. Avoid later setup tools that reset `/var/lib/arosa` ownership or clear the sticky bit. The deploy helper rejects an unhardened parent or research access to the private directory instead of granting broad ACLs. Use a dedicated unprivileged research account (the supplied unit uses `acres-runtime`). Before the first upgrade, provision that account and configure the existing unit to use it, preserving the permissions its database and runtime secrets require. The installer refuses to proceed if research shares a UID with root or OpenClaw, or if it cannot verify the separation.

Before restarting, verify both writers can create, rename and remove a disposable file they own in the shared parent, and verify existing database file ACLs still permit their intended users. Verify `acres-runtime` cannot read, write or traverse `/var/lib/arosa/openclaw`. Create an empty disposable directory as `openclaw` under the shared parent and verify `acres-runtime` cannot rename or remove it, then clean it up as its owner. Do not test rename/delete against the real private directory. After release, verify research health, ledger and knowledge jobs, and the effective Buzz mount before considering the host upgraded.
