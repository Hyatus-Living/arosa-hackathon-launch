# Configure an authenticated public origin

Use a Cloudflare Access application and an identity provider you control. Set `AROSA_ACCESS_ISSUER` and `AROSA_ACCESS_AUD` on the web gateway. The gateway validates token signature, issuer, audience and account identity; a proxy header alone is not authentication.

Configure your tunnel, DNS records and Access application in your own account. Keep their IDs, connector credentials and migration records in private operator documentation. Do not expose the research service directly.

The application has narrowly scoped public endpoints for aggregate statistics, signed share links, unsubscribe links and signed billing events. If your deployment enables one, create an exact-path policy and verify its handler independently. Do not exempt all `/api` paths from sign-in.

Verify a fresh sign-in, a rejected invalid token, two-account isolation and each enabled public route before inviting users. See [self-hosting](SELF_HOSTING.md).
