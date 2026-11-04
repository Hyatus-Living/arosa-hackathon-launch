# Arosa public site

The static pages live in `public/`. `node build.mjs` copies the app's frontend modules and styles from `../app-starter/public` into `public/app`, so the product windows under `public/demo` use the app's views with example data. Rebuild after changing either surface. From the repository root, `node site/demo-sites.mjs` regenerates the example site states with the research dependencies installed.

For local preview, run `node build.mjs` from this directory and serve `public/` with a static HTTP server. `PRODUCT.md` holds the product content and `DESIGN.md` the visual contract.

## Deploy your own site

Select your own Firebase project and Hosting site. The checked-in configuration has no default cloud project. Review the API rewrite in `firebase.json`, including its region, and configure a proxy or remove that rewrite if your deployment does not use it.

```sh
cd site
node build.mjs
firebase deploy --only hosting --project "$ACRES_GCP_PROJECT"
```

`proxy/` contains a Cloud Run API bridge. Its public allowlist forwards aggregate stats and beta applications; other API requests redirect to the configured app origin. Set `AROSA_APP_ORIGIN` for your deployment. Preserve the application's origin checks and authentication policies. Keep custom-domain, DNS and cloud resource identifiers in private operator configuration.
