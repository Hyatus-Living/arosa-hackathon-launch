# Deploying the concept context, places and Street View changes

Pull requests #37, #38 and the deploy-script change land three things on the research service and
the web app. Run these steps from a local session with `gcloud` and IAP SSH access, or from a cloud
session in the `acres-gcp` environment, which signs in as `acres-cloud-deployer`
([cloud-sessions.md](cloud-sessions.md)).

## 1. Google Maps Platform key (optional, enables places and the Street View photo)

The server key `acres-maps-server` in project `hyatus-openclaw` is restricted to **Places API (New)**
and **Street View Static API** and lives in Secret Manager as `acres-google-maps-server-key`. The
browser never sees it. The service caps calls per day (200 nearby searches, 600 Street View metadata
calls, 400 photos, overridable with `GOOGLE_MAPS_DAILY_CAPS`).

The key belongs in `/etc/acres-research/secrets.json` on `openclaw-builder` as `GOOGLE_MAPS_API_KEY`.
To set or refresh it:

```bash
gcloud secrets versions access latest --secret acres-google-maps-server-key --project hyatus-openclaw \
  | gcloud compute ssh openclaw-builder --zone us-central1-a --tunnel-through-iap --project hyatus-openclaw \
      --command 'sudo /usr/local/bin/node -e "const fs=require(\"fs\");const p=\"/etc/acres-research/secrets.json\";const s=JSON.parse(fs.readFileSync(p,\"utf8\"));s.GOOGLE_MAPS_API_KEY=fs.readFileSync(0,\"utf8\").trim();fs.writeFileSync(p,JSON.stringify(s,null,2)+\"\\n\")"'
```

The service reads the file when it starts, so the next research deploy (step 2) picks the key up.
Without the key, concept models still get neighbours from NYC building footprints; the places tool
and the photo simply stay off.

## 1b. Map Tiles key for the Photo view (optional)

The **Photo** toggle in a concept dialog streams Google Photorealistic 3D Tiles into the model. The
browser fetches the tiles itself, so `acres-map-tiles-browser` is a browser key restricted to
**Map Tiles API** and, by HTTP referrer, to `https://build.witharosa.ai/*`, `https://app.witharosa.ai/*` and `https://witharosa.ai/*`. It lives in Secret Manager as
`acres-google-map-tiles-key`, and the web app reads it as `GOOGLE_MAP_TILES_API_KEY` from
`/etc/arosa-acres.env` on `openclaw-builder`. The container reads that file when it starts, so after
changing it run `sudo systemctl restart arosa-acres`. To read the key:

```bash
gcloud secrets versions access latest --secret acres-google-map-tiles-key --project hyatus-openclaw
```

Each opened Photo view starts a tiles session; the project quota on 3D Tiles root tileset requests
(30 per minute per key) bounds runaway use. Without the key the Photo toggle stays hidden. Google's
terms require the attribution shown in the corner of the view; keep it visible.

## 2. Research service on the VM

```bash
./scripts/deploy-research.sh    # from your checkout: sends main to the VM, installs dependencies, requests the deploy, prints "Installed <commit>"
```

The VM has no GitHub credential. One writer for its checkout: `/home/openclaw/.openclaw/workspace/acres`
is only ever moved by `scripts/deploy-research.sh`, which fast-forwards it to the `main` it sends. Make code changes in a
branch elsewhere and merge them through a pull request; never edit, commit or stash there.

## 3. Web app

From a clean export of `main`:

```bash
git archive --format=tar main | tar -x -C /tmp/acres-main
cd /tmp/acres-main/app-starter && ./deploy.sh
```

## 4. Acceptance

1. Ask Arosa about a Lower Manhattan address, let it select the subject, and ask for the as-of-right
   envelope. The concept card should open to a 3D view with grey neighbours, a **Plan** with a north
   arrow and street label, and an **Existing building** toggle.
2. With the key set, ask what transit and parks are nearby: `acres_nearby_places` should run, the
   answer should cite a Google Maps source, and the plan should show the markers. The **Street** view
   should show the photo panel below the model.
3. Check the research service log for `concept_context_failed` or `concept_street_view_failed`
   events, which mean a fetch failed and the model fell back to a note.
