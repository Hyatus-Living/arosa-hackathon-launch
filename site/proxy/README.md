# Public-site proxy

The beta application route requires `AROSA_SITE_PROXY_SECRET` in both this service and the web app. Use a separate random token of at least 32 characters. Keep it in the services' secret stores; never put it in browser code or source control. Without it, the application route returns 503. Public read-only routes do not require this token.

On Cloud Run, the proxy relays only the rightmost platform-appended `X-Forwarded-For` address. With other deployments it uses the socket peer and ignores forwarded headers. If another intermediary fronts Cloud Run, that address may identify the intermediary, so its users share the application allowance. Confirm the actual proxy chain before changing this trust rule.

The web app verifies the separate proxy token before accepting a relayed client address. Direct web requests are limited by their socket peer, with `CF-Connecting-IP` accepted only from the local tunnel. Keep the web listener private to that tunnel or a documented trusted proxy.
