# Arosa Cloudflare separation cutover

Goal: `witharosa.ai` must have nothing to do with Hyatus at the Cloudflare layer — separate
account, zone, Zero Trust organization, Access applications, identity providers, tunnel, workers
and users. Today the Arosa identity service itself (`login.witharosa.ai`, Worker and D1 in the
Arosa account) is already separate; what remains shared is the edge gate: the zone, Access apps
and tunnel still live in the Hyatus account, so sign-in and sign-out pass through
`hyatus-ai.cloudflareaccess.com` and its Hyatus-branded login page.

## Status

Cloudflare ownership and routing moved on 2026-10-23. The Arosa zone is active, the source Access applications and tunnel were retired, and application checks continue below. The preparation sections are historical; the cutover record contains the deployed IDs.

## Hard blocker and date (historical)

Cloudflare refused the inter-account registrar move before 2026-10-22:
`domain_move.ineligibility_reasons = ["domain_recently_registered"]`. The domain was registered
2026-10-12T18:18Z and a Registrar move requires the domain to be more than 10 days old, so the
earliest cutover is **2026-10-22 after 18:18 UTC**. There is no workaround that keeps
Cloudflare Registrar; transferring out is also blocked in the add period. Everything below is
prepared so the cutover on that date is one short sequence. Registration expires 2028-10-12
and auto-renew is off; the gaining account owns renewals after the move, and the registration is
transfer-locked for 30 days after it, so verify before initiating — there is no quick move back.

## Hostnames

Since 2026-10-21 Arosa's main address is `build.witharosa.ai`; `app.witharosa.ai` serves the same
app and stays up. The OpenClaw builder moved from `build.witharosa.ai` to `openclaw.witharosa.ai`.
Every step below recreates that layout: "Arosa Acres" covers `build` and `app`, "Arosa OpenClaw"
covers `openclaw`, and the five Bypass apps cover their path on both Arosa hosts.

## Accounts and prepared state (verified 2026-10-13, hostnames updated 2026-10-21)

- Hyatus account `b38915bce2f6ea4fe59f2f5a7efbe1b2`: active zone `e8478a22ad35e491d527f85489563aaf`
  (nameservers gerald/rachel), Access org `hyatus-ai.cloudflareaccess.com`, apps Arosa Acres
  (aud `b1d3fa73…`, destinations `build.witharosa.ai` and `app.witharosa.ai`) and Arosa OpenClaw
  (aud `824ca819…`, destination `openclaw.witharosa.ai`) already restricted to the Arosa OIDC
  IdP only, Bypass apps "Arosa public stats", "Arosa Stripe webhook", "Arosa beta applications", "Arosa option links" and "Arosa alert unsubscribe" (one path each, on both
  Arosa hosts), tunnel `arosa-apps` `634c7512-e146-48bd-9d74-80df4289b27f`, workers
  `arosa-login-proxy`, `arosa-acres-mcp-edge`, `arosa-mail-forwarder`, `arosa-legacy-redirects`.
- Arosa account `e35aaff0a602b93126a0ebdae4472450`: pending zone `15d26d346852edc014625a2dbf65621a`
  (nameservers ainsley/ishaan), Access org `witharosa.cloudflareaccess.com` named Arosa, IdPs
  "Sign in with Arosa" OIDC `45f4482e-3285-4d45-bc33-67c67da6a0b6` and "Arosa email code",
  workers `arosa-auth` (D1 `db60ae15…`), `arosa-inbox`, `arosa-mail-ingress`, plus newly staged
  `arosa-legacy-redirects` (routes on the pending zone) and `arosa-acres-mcp-edge` (no domain yet).
- Staged in the pending Arosa zone (inert until activation): apex Vercel A records,
  `www`/`acres`/`research` CNAMEs to the new tunnel `f5dd250c-ad3d-40e2-95bd-c7dd1ca78d3f`,
  all MX/SPF/DKIM/DMARC records, and email rules for michael/alex/chaim to the `arosa-inbox`
  worker. `app`/`build`/`openclaw` CNAMEs are deliberately absent until Access apps exist (step 3).
- Browser caching for the Arosa hosts (added 2026-10-17 for `app`, extended to `build` 2026-10-21): the zone's Browser Cache TTL is
  4 hours (`browser_cache_ttl = 14400`), which overrode the origin's `Cache-Control: no-cache`
  and left returning browsers running old JS modules for up to 4 hours after a UI deploy. Both
  zones now carry a Cache Rule (phase `http_request_cache_settings`) matching
  `http.host in {"app.witharosa.ai" "build.witharosa.ai"}` with browser TTL `respect_origin`: Hyatus zone ruleset
  `ffb2de2f37384b21a831f83b74420df3` (rule `5d8ed542…`, live) and the pending Arosa zone ruleset
  `450e38617b254c2d95b7f9f914a755d7` (rule `96880e55…`, staged so the fix survives cutover). The
  zone-level 4-hour TTL is unchanged for every other host. After step 2, confirm a signed-in
  `fetch('/app.js')` on `build.witharosa.ai` and `app.witharosa.ai` still returns `Cache-Control: no-cache`.
- New tunnel `arosa-apps` (Arosa account) is configured for build and app → `127.0.0.1:18810` and
  openclaw → `127.0.0.1:18789`; its connector runs on the VM as `arosa-tunnel-next.service`
  (token file `/etc/arosa-tunnel-next-token`, mode 600) alongside the production
  `arosa-tunnel.service`. Its openclaw `audTag` is unset until step 3 creates the app.
- Access apps cannot be created in the Arosa org yet: the API rejects them with
  "domain does not belong to zone" while the zone is pending. Email routing likewise cannot be
  enabled until the zone is active (rules are already created).
- Interim sign-out fix is live (PR #84): sign-out ends the Access session in place and lands on
  `https://witharosa.ai/` instead of the Hyatus-branded Access page.

## Cutover sequence (as prepared; run on 2026-10-23)

1. Re-check eligibility: `GET /accounts/b389…/registrar/domains/witharosa.ai` must show
   `domain_move.ineligibility_reasons` empty. Confirm DNSSEC is disabled on both zones
   (it is today) and re-export both zones' DNS for a final diff.
2. Initiate the Registrar move in the dashboard (this step is dashboard-only): Hyatus account →
   Domain Registration → Manage Domains → `witharosa.ai` → Configuration → start the move to
   account `e35aaff0a602b93126a0ebdae4472450`, then accept it in the Arosa account under
   Manage Domains → View Actions (within five days). Cloudflare switches the nameservers to
   ainsley/ishaan on completion; all source-account zone configuration is lost at that point.
3. As soon as the Arosa zone turns active, create the Access apps in the Arosa org mirroring the
   current ones (self-hosted, `allowed_idps` only `45f4482e…`, auto-redirect to it, policy
   requires that login method): "Arosa Acres" with two destinations, `build.witharosa.ai` and
   `app.witharosa.ai` (one app, so one AUD), 720h session (30-day sign-ins) and an allow policy
   including everyone, since customers sign up through the Arosa login; and "Arosa OpenClaw" for
   `openclaw.witharosa.ai`, 24h session, allow policy including email domain `witharosa.ai`
   only. Record the two new AUDs.
   Also recreate "Arosa public stats" (self-hosted, destinations `build.witharosa.ai/api/public/stats`
   and `app.witharosa.ai/api/public/stats`, one Bypass policy including everyone), or the stats
   strip on witharosa.ai disappears, and "Arosa Stripe webhook" (same settings, destinations
   `build.witharosa.ai/api/public/stripe/subscriptions` and the same path on `app`), or Arosa Pro
   subscriptions stop reaching the app, and "Arosa beta applications" (same settings, destinations
   `build.witharosa.ai/api/public/beta-apply` and the same path on `app`), or the apply form on
   witharosa.ai/beta stops saving applications, and "Arosa option links" (same settings, destinations
   `build.witharosa.ai/api/public/options` and the same path on `app`, policy "Public option links"),
   or options sent to architects and contractors ask them to sign in, and "Arosa alert unsubscribe"
   (same settings, destinations `build.witharosa.ai/api/public/alerts/unsubscribe` and the same
   path on `app`, policy "Public alert unsubscribe"), or the stop link in every alert email asks
   for a sign-in.
4. Update the new tunnel's openclaw ingress `audTag` to the new OpenClaw AUD (teamName `witharosa`),
   then create the `build`, `app` and `openclaw` proxied CNAMEs to `f5dd250c-….cfargotunnel.com`.
5. Enable Email Routing on the Arosa zone and confirm the three staged rules are active.
6. Attach worker custom domains in the Arosa account: `mcp.witharosa.ai` →
   `arosa-acres-mcp-edge`; `login.witharosa.ai` → `arosa-auth` following that repo's README
   (preserve issuer, D1, signing keys and secrets; coordinate the proxy-secret guard change with
   the identity owner, and do not retire `arosa-login-proxy` until direct login is verified);
   `mail.witharosa.ai` with the inbox owner.
7. Update VM trust anchors, then restart: `/etc/arosa-acres.env` gets
   `AROSA_ACCESS_ISSUER=https://witharosa.cloudflareaccess.com` and the new app
   `AROSA_ACCESS_AUD`; restart `arosa-acres`. Find the builder's expected AUD/team references
   (`grep -r 824ca819 /home/openclaw/.openclaw /etc` on the VM), replace with the new OpenClaw AUD
   and team, and restart the builder gateway. Its `gateway.controlUi.allowedOrigins` must keep
   `https://openclaw.witharosa.ai`.
8. Verify before retiring anything: `build.witharosa.ai`, `app.witharosa.ai` and
   `openclaw.witharosa.ai` redirect to `witharosa.cloudflareaccess.com` only; `build` and `app`
   open Arosa and `openclaw` opens the builder; `/api/public/stats` answers without sign-in on
   `build` and `app`, as do an option link and `/api/public/alerts/unsubscribe?token=x` (the
   button page); sign-in completes through Sign in with Arosa;
   sign-out lands on `witharosa.ai`; research health and a real signed-in question pass; the
   MCP OAuth flow still issues tokens (issuer `login.witharosa.ai` unchanged); a test email
   reaches each Arosa mailbox; apex site still serves from Vercel.
9. Retire the Hyatus-side pieces: stop `arosa-tunnel.service` on the VM, delete the Hyatus
   Access apps and its copy of the Arosa IdP, remove the `arosa-apps` tunnel, remove the
   witharosa custom domains/routes from the Hyatus workers (keep the `hyatus.com` routes on
   `arosa-legacy-redirects`), and update `docs/arosa-deployment.md` plus the `account_id`
   values in `infra/*.wrangler.jsonc` to the Arosa account.

## Option links bypass (created 2026-10-22 in the Hyatus account)

Approved by Michael on 2026-10-22 and created after the 2:00 to 4:00 PM Eastern cutover window, in
the Hyatus account because the registrar move had not happened. Option links (an option sent to an
architect or contractor) open without sign-in at `/api/public/options/<token>`, with their files at
`/api/public/options/<token>/files/<id>`; the link's token is the authority.

- App "Arosa option links" (`203306b1-812e-4d70-a8bc-d8f12d746bb0`), self-hosted, destinations
  `build.witharosa.ai/api/public/options` and `app.witharosa.ai/api/public/options`, 24h session,
  hidden from the launcher; one policy, "Public option links", Bypass, include everyone. The same
  shape as "Arosa public stats" and "Arosa beta applications". Nothing else under `/api/public`
  changed: `/api/public/optionsx`, `/sites` and `/api/projects` still redirect to sign-in.
- Verified signed out on both hosts: a 39 Winthrop St option link, its floor plan and both
  rendering stills answer 200; `/api/public/options/<random 43 characters>` answers the "not
  available" page with 404.
- When the move to the Arosa org happens, recreate it there in step 3 with the other Bypass apps;
  never keep it in both orgs past the move.

## Alert unsubscribe bypass (created 2026-10-23 in the Hyatus account)

Every alert email links to `https://build.witharosa.ai/api/public/alerts/unsubscribe?token=...`
and names it in a one-click `List-Unsubscribe` header. Until this app existed the link asked for
a sign-in. GET shows a page with a "Stop alert emails" button and nothing else; POST forwards only
the token to research, which checks its signature and pauses the rule, or turns off every alert
for a digest's link. Neither response carries account data.

- App "Arosa alert unsubscribe" (`40872d9c-b821-4994-9255-6ea8fc6b160f`), self-hosted,
  destinations `build.witharosa.ai/api/public/alerts/unsubscribe` and
  `app.witharosa.ai/api/public/alerts/unsubscribe`, 24h session, hidden from the launcher; one
  policy, "Public alert unsubscribe", Bypass, include everyone. The same shape as the other four.
- Verified signed out on both hosts: GET answers the button page with 200; a one-click POST with
  an invalid token answers "Link not recognized" (404) from research; a correctly signed token for
  a rule that does not exist answers "This alert was already removed" (200) and writes nothing.
  `/api/public/alerts`, `/api/public/alerts/unsubscribex`, `/api/public/alertsx`,
  `/api/projects` and `/` still redirect to sign-in; `/api/public/alerts/unsubscribe/x` passes
  Access and the app answers 401.
- When the move to the Arosa org happens, recreate it there in step 3 with the other Bypass apps;
  never keep it in both orgs past the move.

## Cutover record (2026-10-23)

- 2026-10-22, 18:30Z: the scheduled run found the move eligible (`ineligibility_reasons` empty, DNSSEC
  disabled on both zones) but stopped before step 2: the registrar move is dashboard-only and no
  browser had a Cloudflare session. The DNS diff of the staged zone against the live one showed three
  SendGrid records missing (`em7621`, `s1._domainkey`, `s2._domainkey` CNAMEs); they were added to the
  pending zone that day. Everything else matched.
- 2026-10-23, from the dashboard as michaelort@hyatus.com (Hyatus account audit log):
  `domain_move_initiation_request_sent` 19:05:22Z, `self_serve_domain_move_successful` 19:06:17Z,
  `zone_moved` 19:17:20Z. The Hyatus zone `e8478a22…` now reads `moved`; the Arosa zone
  `15d26d346852edc014625a2dbf65621a` is `active` and ainsley/ishaan answer for the domain. The
  registration (expires 2028-10-12, auto-renew on, transfer lock on) is in the Arosa account.
- Transient: for a few minutes after `zone_moved`, `login.witharosa.ai` answered "Origin DNS error"
  while the Worker custom domains re-bound to the new zone. It recovered on its own; nothing was changed.
- Access apps created in the Arosa org `witharosa.cloudflareaccess.com` (all restricted to the
  "Sign in with Arosa" IdP `45f4482e…` where they require sign-in):
  - Arosa Acres `1b8dacec-f5bd-4174-8a1e-ce8e84412cd3`, AUD
    `023b16f362214b87566de8ed82e81e0acb12aa33894210191da97da825400d42`, `build` and `app`, 720h,
    allow everyone with that login method.
  - Arosa OpenClaw `a7907768-4da5-43b9-aff5-7777fed25a25`, AUD
    `3f8cbe0dee1b79135974e88e6cfa021b8e9f56ddeca0682c3aff269413da19c6`, `openclaw`, 24h, allow
    email domain `witharosa.ai`.
  - Bypass apps, one path each on `build` and `app`: Arosa public stats
    `9da8526b-8409-4884-a75f-b4e647ba8625`, Arosa Stripe webhook `f388165a-462f-4d86-b794-fdc9e9041433`,
    Arosa beta applications `152aa257-e3d1-4108-8880-7d5263d2887e`, Arosa option links
    `8d95c181-e2a6-42c7-8e70-01b3296fec6c`, Arosa alert unsubscribe `194766f9-3353-4425-988f-7e52653b2551`.
  - The existing Arosa Inbox app `772b7d7f…` now also lists `mail.witharosa.ai/auth/cloudflare`.
- Tunnel `f5dd250c-ad3d-40e2-95bd-c7dd1ca78d3f`: openclaw ingress `audTag` set to the new OpenClaw AUD,
  `teamName` `witharosa`; `build`, `app` and `openclaw` proxied CNAMEs created. Email Routing enabled
  (`ready`) with the three rules to `arosa-inbox`. Worker custom domains in the Arosa account:
  `login.witharosa.ai` → `arosa-auth` (direct; `PROXY_SECRET` stays set and the workers.dev address
  still answers 403), `mcp.witharosa.ai` → `arosa-acres-mcp-edge`, `mail.witharosa.ai` → `arosa-inbox`.
- VM: `/etc/arosa-acres.env` (the template `acres-pull-secrets` renders into `/run/acres-secrets/app.env`)
  updated 19:19:48Z with `AROSA_ACCESS_ISSUER=https://witharosa.cloudflareaccess.com` and the Arosa
  Acres AUD; `arosa-acres` switched 19:21Z (blue, 18811). The builder had no copy of the old AUD outside
  this document; only the tunnel `audTag` carried it. Both connectors still run (`arosa-tunnel`,
  `arosa-tunnel-next`).

Verified 19:20 to 19:35Z:

- `app`, `build` and `openclaw` without a session redirect to `witharosa.cloudflareaccess.com` and the
  login page offers Sign in with Arosa only; `www` → `witharosa.ai`, `acres` and `research` → `build`;
  the apex serves the landing page from Vercel and `/api/public/stats` answers on the apex and on `build`.
- Signed in on `app.witharosa.ai`: listings and the map load, `/api/session` names the account, and
  `fetch('/app.js')` returns `Cache-Control: no-cache` (edge `MISS`; the Cache Rule is live in the
  Arosa zone). `/sites` and other paths still redirect to sign-in. On the VM
  `http://127.0.0.1:18810/healthz` and `http://10.42.0.2:18800/healthz` answer ok.
- Mail: MX, SPF, DMARC, the Cloudflare DKIM and the SendGrid CNAMEs resolve from the Arosa zone. A test
  message from michaelort@hyatus.com to michael@witharosa.ai reached the `arosa-inbox` worker five
  seconds after sending (`wrangler tail`: `rcptTo michael@witharosa.ai`, outcome ok).
- Stripe: a request with a bad signature reaches the app on both hosts and answers 400 "Invalid payment
  signature." (not an Access redirect); a correctly signed test event (HMAC with the server's
  `whsec_`, `livemode` false) answers 200 `{"received":true}` on both hosts. Every other `/api/public`
  path except the five Bypass paths redirects to sign-in. Note: the zone's browser integrity check
  answers 403 (error 1010) to a `python-urllib` user agent on that path; Stripe's own user agent passes.
- MCP OAuth: `mcp.witharosa.ai/mcp` answers 401 with `resource_metadata`, the protected-resource
  document names `https://login.witharosa.ai/api/auth` as the authorization server, that issuer's OIDC
  discovery and token endpoint answer from the Arosa worker. The interactive consent flow was not re-run.

Additional application checks and mail separation:

- Arosa Auth PRs 9 and 10 preserve the existing D1 identities and signing keys, bind the canonical login hostname directly, and send identity email through the native Arosa `arosa-mail-sender`. Direct workers.dev access still requires the existing proxy secret. All 18 auth tests and type checking passed; deployed commit `103c88e`.
- Arosa Inbox PR 2 uses the Arosa account, canonical mail hostname and native EMAIL binding. Email Sending is enabled and its DNS is configured and healthy. A self-addressed Michael message through the sender and a second message sent through the actual Inbox compose UI both arrived. Mailbox privacy and the three inbound address rules are preserved. Inbox tests, accessibility checks, gateway tests, type checking and production build passed; deployed commit `bfacf22`.
- Actual Acres research completed with sources, existing saved property and conversation history remained visible, and sign-out returned to the public homepage.
- A fresh OpenClaw page connects as `michael@witharosa.ai`, retains profile `888c0289-f4fa-45ba-96ef-9a96a0ba7ac5` and lists prior sessions. The team-only Access policy remains unchanged.
- The real ChatGPT Acres connector still reports that reauthentication is required after a reported reconnect. Discovery and anonymous rejection pass, but a successful connected MCP call remains an acceptance requirement. Do not label that integration verified until it succeeds.

Step 9, done 2026-10-23 19:31 to 19:35Z (snapshots of every deleted object were taken first):

- VM: `arosa-tunnel.service` stopped and disabled (`arosa-tunnel-next.service` carries all traffic;
  its token file `/etc/arosa-tunnel-token` is left in place, unused). Hyatus tunnel `arosa-apps`
  `634c7512-e146-48bd-9d74-80df4289b27f` deleted; it had no connections and no private routes.
- Hyatus Access apps deleted: Arosa Acres `15cc6a60…`, Arosa OpenClaw `bc1f5782…`, Arosa public stats
  `ed0db599…`, Arosa Stripe webhook `9ef08605…`, Arosa beta applications `86239102…`, Arosa option links
  `203306b1…`, Arosa alert unsubscribe `40872d9c…`. The Hyatus copy of the Arosa IdP `7d70019f…` deleted;
  no other Hyatus app or reusable policy referenced it.
- Hyatus Worker custom domains `login.witharosa.ai` (`arosa-login-proxy`), `mcp.witharosa.ai`
  (`arosa-acres-mcp-edge`) and `mail.witharosa.ai` (`arosa-mail-forwarder`) removed, and the three
  witharosa routes on the moved zone removed. Each live host answered the same before and after.
  The `hyatus.com` routes on the Hyatus `arosa-legacy-redirects` stay.
- Kept in the Hyatus account: the `arosa-mail-forwarder` worker, because `arosa-inbox` still sends
  outbound mail through `https://arosa-mail-forwarder.michaelort.workers.dev/send`; the
  `arosa-login-proxy` and Hyatus `arosa-acres-mcp-edge` scripts, which no longer have any domain and
  can be deleted at any time; the `hyatus.com` copy of `arosa-legacy-redirects`.
- `infra/arosa-mcp-edge.wrangler.jsonc` now targets the Arosa account.
  `infra/arosa-legacy-redirects.wrangler.jsonc` targets the Arosa account for the witharosa.ai
  routes (`wrangler deploy --env=""`) and the Hyatus account for the hyatus.com routes
  (`wrangler deploy --env hyatus`).
- Re-verified afterwards: no-session redirects to `witharosa.cloudflareaccess.com` on all three hosts,
  apex and stats, the five Bypass paths, `/api/projects` still behind sign-in, Stripe bad signature
  answered 400 by the app on both hosts, the `login.witharosa.ai` issuer, MCP resource metadata,
  `mail.witharosa.ai`, the `www`/`acres`/`research` and `acres`/`build.hyatus.com` redirects, and both
  VM health checks.

Final retirement and acceptance checkpoint:

- After native Arosa identity and inbox sending were verified, the unbound source `arosa-login-proxy`, `arosa-acres-mcp-edge` and `arosa-mail-forwarder` scripts were backed up and deleted. Each had no source hostname, route or stateful binding. A live readback leaves only `arosa-legacy-redirects` in the source account for the three `hyatus.com` redirects. Arosa mail no longer depends on a Hyatus Worker.
- A fresh OpenClaw conversation returned “Arosa OpenClaw is connected.” in six seconds. The existing Michael profile and prior sessions remain available, and the unchanged Arosa team policy is enforced.
- The actual ChatGPT Acres connector is the remaining unverified integration: it reports reauthentication required before reaching the service. The browser pane's ChatGPT settings session belongs to a different account, so its connections were left unchanged. The authorized bounded continuation retries the connection from the original chat and reports completion or a blocker. Anonymous MCP rejection and OAuth discovery are verified independently.

## Rollback posture

Before step 2, nothing above is user-visible and abandoning is free. After the move completes
there is no fast move back (30-day transfer lock), so failures after activation are fixed
forward inside the Arosa account: the staged DNS, tunnel connector, workers and this sequence
exist precisely so each hostname can be brought up independently in minutes.

## Addendum 2026-10-28: apex host moved from Vercel to Firebase Hosting

The Vercel references above describe the zone at cutover time. The apex has since moved:
`witharosa.ai` is served by Firebase Hosting in Google Cloud project `hyatus-openclaw`
(site `hyatus-openclaw`), its Cloudflare `A` record points at Firebase (`199.36.158.100`)
and is not proxied, and `site/firebase.json` rewrites `/api/**` to the `arosa-site-proxy`
Cloud Run service. The Vercel project `arosa-site` and its domain record were deleted and
`site/vercel.json` was removed from the repository (PRs #556 to #559); `arosa-site.vercel.app`
returns 404. See `site/README.md` and `docs/arosa-deployment.md` for the current deploy paths.
