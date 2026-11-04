# witharosa.ai

The public site: static pages in `public/`, hosted on Firebase Hosting in the Google Cloud
project `hyatus-openclaw` (site `hyatus-openclaw`; config in `firebase.json`, project in
`.firebaserc`, output directory `public`). The build, `node build.mjs`, copies the app's front-end
modules and styles from `../app-starter/public` into `public/app`, so the product windows under
`public/demo` run the app's own views on example data. Redeploy whenever `site/` or
`app-starter/public` changes, so the demo windows always carry the current app code.
`node site/demo-sites.mjs` (from the repo root, with the research dependencies installed)
regenerates the example site states and `public/demo/calc.js` from the research service's own code.

Deploy (needs Firebase Hosting rights on `hyatus-openclaw`):

```bash
cd site
node build.mjs
firebase deploy --only hosting
```

API paths that land on the apex are handled by the `arosa-site-proxy` Cloud Run service
(`site/proxy/`, project `hyatus-openclaw`, region `us-central1`), which `firebase.json` rewrites
`/api/**` to: `/api/public/stats` and `/api/public/beta-apply` pass through to
`build.witharosa.ai` (Origin and client IP forwarded; the app checks both), and every other
`/api` path redirects there. Payment returns (`?wallet=`) are forwarded to `build.witharosa.ai`
by a script in `public/index.html`. Redeploy the proxy only when its code changes:

```bash
gcloud run deploy arosa-site-proxy --source site/proxy --project hyatus-openclaw --region us-central1 --allow-unauthenticated
```

The apex `A` record for `witharosa.ai` in Cloudflare DNS points at Firebase Hosting
(`199.36.158.100`) and is not proxied; the app stays behind the Cloudflare tunnel and Access at
`build.witharosa.ai` (`app.witharosa.ai` serves it too). Preview locally by running
`node build.mjs`, then any static server on `public/`, for example
`python3 -m http.server --directory public`. Asset files are named
`site.css` and `site.js` because the app that used to live on the apex served `styles.css` and
`app.js`, and browsers that visited it keep those cached.

Firebase Hosting is the only host for the apex.

`PRODUCT.md` holds the product truth the copy is drawn from; `DESIGN.md` the visual contract, which
inherits the HyatusOS monochrome system.
