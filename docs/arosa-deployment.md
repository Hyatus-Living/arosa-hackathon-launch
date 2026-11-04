# Arosa deployment

Arosa and OpenClaw use the Arosa identity service at https://login.witharosa.ai. Browser applications are https://build.witharosa.ai (Arosa, its main address; https://app.witharosa.ai serves the same app) and https://openclaw.witharosa.ai (the OpenClaw builder); https://witharosa.ai is the public site, the static pages in `site/` hosted on Firebase Hosting in Google Cloud project `hyatus-openclaw` (site `hyatus-openclaw`), with the apex DNS record pointing at Firebase (`199.36.158.100`) and not proxied. See `site/README.md` for deploys and the `arosa-site-proxy` Cloud Run API bridge. The tool endpoint is https://mcp.witharosa.ai/mcp.

The existing dedicated Google Cloud project is displayed as **Arosa**. Its immutable project ID remains `hyatus-openclaw`. The original research database and OpenClaw workspaces stay on the existing VM; no conversation data is copied to another company's application.

Arosa runs in a `arosa-acres-blue` or `arosa-acres-green` container on that VM (`arosa-acres@blue` on `127.0.0.1:18811`, `arosa-acres@green` on `127.0.0.1:18812`). `arosa-web-front` owns `127.0.0.1:18810`, the tunnel's origin, and forwards each request to the live color named in `/etc/arosa-acres/web-target`. The containers read `/run/acres-secrets/app.env`; the image to run is in `/etc/arosa-acres-deploy.env`. See [Deploys without downtime](#deploys-without-downtime). The `arosa-tunnel-next` service (tunnel `arosa-apps` in the Arosa account) connects Arosa and the existing OpenClaw listener to Cloudflare: `build.witharosa.ai` and `app.witharosa.ai` go to `127.0.0.1:18810`, `openclaw.witharosa.ai` to OpenClaw on `127.0.0.1:18789`, whose `gateway.controlUi.allowedOrigins` in `/home/openclaw/.openclaw/openclaw.json` names that origin. Both routes require a signed Access token with the correct application audience. The Arosa API validates that token again. Native Google/IAP user sign-in is removed from the web application.

`AROSA_ACCOUNT_LINKS` preserves Michael's verified existing research namespace. Other Arosa accounts derive separate namespaces from their canonical addresses. The tool gateway has reviewed memberships for the same namespaces, tied to Arosa identity subject IDs. Its OAuth issuer, resource URL and membership secret must be updated together.

One API path is public: `GET https://build.witharosa.ai/api/public/stats` (also on `app.witharosa.ai`) returns aggregate totals for the stats strip on witharosa.ai (listings screened, NYC lots matched, properties researched, sites underwritten, sources cited, research runs) and nothing tied to an account. The web server registers it before sign-in and reads it from the research service's `/public-stats`, which recomputes at most every five minutes. A separate self-hosted Access application, "Arosa public stats", covers exactly that path on both hosts (`build.witharosa.ai/api/public/stats` and `app.witharosa.ai/api/public/stats`) with a single Bypass policy for everyone; every other path stays under "Arosa Acres", which lists both hosts as destinations so a single application audience (`AROSA_ACCESS_AUD`) covers them. The site reaches it same-origin through the rewrite in `site/firebase.json`, which sends `/api/**` to the `arosa-site-proxy` Cloud Run service; the proxy passes the two public paths through to the app and redirects every other API path there.

Stripe sends Arosa Pro subscription events to `POST https://build.witharosa.ai/api/public/stripe/subscriptions`. A second Bypass application, "Arosa Stripe webhook", covers exactly that path on both hosts; the web server registers it before sign-in and accepts only events carrying a valid Stripe signature (see `docs/BILLING.md`).

Every alert email links to `https://build.witharosa.ai/api/public/alerts/unsubscribe?token=...` and names it in a one-click `List-Unsubscribe` header. A third Bypass application, "Arosa alert unsubscribe" (`194766f9-3353-4425-988f-7e52653b2551`, in the Arosa org; see `docs/arosa-cloudflare-cutover.md`), covers exactly that path on both hosts (`build.witharosa.ai/api/public/alerts/unsubscribe` and the same path on `app`) with one Bypass policy for everyone; the web server registers it before sign-in. Opening the link shows a button (so mail scanners that prefetch links stop nothing) and the button or a mail app's one-click POST pauses the linked rule, or turns off all alerts for a digest's link. The token is signed with a key kept in the chat database, so only links Arosa sent are accepted.

The research app accepts verified Arosa identities with any valid email address, including customers signing in through Google. Its Access policy admits only the Arosa identity provider. New customers receive separate research namespaces, not employee or builder access. Global people-directory search remains restricted to `@witharosa.ai` accounts; customers can share by entering a recipient's email. Builder and mailbox policies remain employee-only. Research is still a free pilot while billing is disabled.

Since 2026-10-23 the domain, zone, Access applications (org `witharosa.cloudflareaccess.com`), tunnel `arosa-apps` (`f5dd250c…`) and the `login`, `mcp` and `mail` Worker domains live in the Arosa Cloudflare account `e35aaff0a602b93126a0ebdae4472450`; `docs/arosa-cloudflare-cutover.md` has the record and the IDs. The Hyatus-side copies were retired the same day. Arosa Inbox now sends through its native Cloudflare EMAIL binding, and identity mail uses `arosa-mail-sender` in the Arosa account. The `hyatus.com` redirect routes remain on the Hyatus copy of `arosa-legacy-redirects` (`wrangler deploy --env hyatus`).

The old Hyatus web addresses redirect to Arosa through `infra/arosa-legacy-redirects.mjs`. `acres.witharosa.ai`, `research.witharosa.ai` and `acres.hyatus.com` redirect to `build.witharosa.ai`; `build.hyatus.com` redirects to the builder at `openclaw.witharosa.ai`; `www.witharosa.ai` redirects to `witharosa.ai`. The old Google Cloud Run web service is a rollback artifact with its default URL disabled. Billing remains disabled. Shared OpenClaw sessions and Arosa history must be preserved during future deployments.

## Deploys without downtime

### Web

`app-starter/deploy.sh` builds the image, pulls it on the VM, writes `/etc/arosa-acres-deploy.env` and runs `/usr/local/sbin/arosa-web-switch` (`infra/arosa-web-switch`). The switch starts the image as the idle color, waits for its `/healthz`, points the front at it (rewrites `web-target`, sends the front SIGHUP and confirms through the front's status socket `/run/arosa-web-front/admin.sock`), checks `/healthz` through `127.0.0.1:18810`, waits until the old color has no plain request in flight (up to about 5.5 minutes, the app's longest proxied request) and stops it. Event streams on the old color are cut when it stops and reconnect to the new one. If the new color fails its health check, or the front does not switch, the switch stops the new color, keeps the old one serving, restores the old image in `/etc/arosa-acres-deploy.env` and exits non-zero.

`sudo systemctl restart arosa-acres` runs the same switch with the current image, so an `app.env` change or `acres-server restart web` also has no downtime. `arosa-acres.service` is a oneshot that runs the switch at boot and on restart; stopping it leaves the live color running. Logs are in `journalctl -u arosa-acres@blue` and `journalctl -u arosa-acres@green`.

Roll back the web app by switching to the previous image, which the idle color's file still names:

```bash
LIVE=$( [ "$(cat /etc/arosa-acres/web-target)" = 18811 ] && echo blue || echo green )
IDLE=$( [ "$LIVE" = blue ] && echo green || echo blue )
sudo grep '^AROSA_ACRES_IMAGE=' "/etc/arosa-acres/$IDLE.env" | sudo tee /etc/arosa-acres-deploy.env
sudo /usr/local/sbin/arosa-web-switch
```

The front itself (`/usr/local/lib/arosa-web-front.mjs`) changes rarely. The research installer keeps the web units, the switch and the front file current once the host has switched over, but never restarts the front: after changing `arosa-web-front.mjs`, restart it at a quiet moment with `sudo systemctl restart arosa-web-front` (plain requests get 30 seconds to finish; event streams reconnect).

### Research

See the deployment section of [acres-research/README.md](../acres-research/README.md): `acres-research.socket` holds `10.42.0.2:18800`, the old process drains while it keeps serving, and the next one starts after it exits, so callers never see a refused connection or a restart error.

### One-time switch-over on openclaw-builder

Merge the change first, so the server checkout has the new files.

1. Research (socket, staged installs, health check). Run `./scripts/deploy-research.sh` from your own checkout on the merged main. The installed installer replaces itself with the new one (revision `2026-10-20.1`), installs `acres-research.socket` and `acres-research-apply`, and moves the port from the process to the socket. This first handover still uses the old process's drain, which answers new requests with an error until its active runs finish, and leaves the port closed for about a second, so run it when no research is active. Then check:

   ```bash
   systemctl is-active acres-research.socket acres-research    # active active
   curl -fsS http://10.42.0.2:18800/healthz                    # "release" is the merged commit, "draining": false
   sudo head -3 /usr/local/sbin/acres-deploy-research | tail -1  # revision 2026-10-20.1
   ```

2. Web units, as root in `/home/openclaw/.openclaw/workspace/acres`:

   ```bash
   install -m 644 infra/arosa-acres@.service infra/arosa-web-front.service /etc/systemd/system/
   install -m 755 infra/arosa-web-switch /usr/local/sbin/arosa-web-switch
   install -m 644 infra/arosa-web-front.mjs /usr/local/lib/arosa-web-front.mjs
   # The developer-source mounts move to the colors, each with its own copy of the prepared source,
   # so preparing the next color never deletes the files the live one serves.
   mkdir -p /etc/systemd/system/arosa-acres@.service.d
   cat > /etc/systemd/system/arosa-acres@.service.d/acres-developer-source.conf <<'EOF'
   [Service]
   ExecStartPre=/usr/local/sbin/acres-server --prepare-web
   ExecStartPre=/bin/sh -c 'rm -rf /var/lib/acres-developer-access/web-source-%i && cp -a /var/lib/acres-developer-access/web-source /var/lib/acres-developer-access/web-source-%i'
   ExecStart=
   ExecStart=/usr/bin/docker run --rm --name arosa-acres-%i --env-file=/run/acres-secrets/app.env -p 127.0.0.1:${AROSA_ACRES_PORT}:8080 --mount type=bind,source=/var/lib/acres-developer-access/web-source-%i/app-starter,target=/app/app-starter,readonly --mount type=bind,source=/var/lib/acres-developer-access/web-source-%i/acres-research,target=/app/acres-research,readonly ${AROSA_ACRES_IMAGE}
   EOF
   systemctl daemon-reload
   ```

3. Start the live image as blue beside the running container, then hand port 18810 to the front. This is the one moment with a gap of about a second (and the old container's static files may 404 while blue prepares its source), so do it at a quiet moment:

   ```bash
   install -d -m 755 /etc/arosa-acres
   IMAGE=$(sed -n 's/^AROSA_ACRES_IMAGE=//p' /etc/arosa-acres-deploy.env)
   printf 'AROSA_ACRES_IMAGE=%s\nAROSA_ACRES_PORT=18811\n' "$IMAGE" > /etc/arosa-acres/blue.env
   systemctl start arosa-acres@blue
   curl -fsS --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:18811/healthz
   echo 18811 > /etc/arosa-acres/web-target
   systemctl stop arosa-acres && systemctl start arosa-web-front
   curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:18810/healthz
   ```

4. Replace the old unit with the switch unit and prove a zero-downtime switch (blue to green):

   ```bash
   rm /etc/systemd/system/arosa-acres.service.d/acres-developer-source.conf
   install -m 644 infra/arosa-acres.service /etc/systemd/system/arosa-acres.service
   systemctl daemon-reload
   systemctl enable arosa-web-front arosa-acres
   systemctl restart arosa-acres
   cat /etc/arosa-acres/web-target                                   # 18812
   systemctl is-active arosa-web-front arosa-acres@green arosa-acres@blue   # active active inactive
   curl -fsS http://127.0.0.1:18810/healthz && curl -fsS -o /dev/null -w '%{http_code}\n' https://build.witharosa.ai/
   ```

   Verify the signed-in app in a browser. From then on `app-starter/deploy.sh` switches without downtime.

To undo the web switch-over: `systemctl disable --now arosa-web-front arosa-acres@blue arosa-acres@green` (the site is down from here until the last step), `rm /etc/arosa-acres/web-target` (the research installer then stops updating the web units), reinstall the previous `infra/arosa-acres.service` from git and the old drop-in (the `ExecStart` above with `--name arosa-acres -p 127.0.0.1:18810:8080` and the shared `web-source` paths, without the second `ExecStartPre`), then `systemctl daemon-reload && systemctl start arosa-acres`.

To undo research: revert the change on main and run `./scripts/deploy-research.sh` from your checkout so the server checkout has it, then `sudo install -m 644 infra/acres-research.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl disable --now acres-research.socket` (the running process keeps its listener) and run `./scripts/deploy-research.sh`; the previous installer replaces the new one and restarts research on its own port.
