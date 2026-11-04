# Configure map context

Set `GOOGLE_MAPS_API_KEY` privately on the research service for server-side Places and Street View lookups. Restrict it to the APIs used and set appropriate quotas.

`GOOGLE_MAP_TILES_API_KEY` is intentionally delivered to signed-in browsers. Use a separate browser key restricted to the Map Tiles API and your application origins. A browser key cannot be kept secret by frontend code.

Keep provider key values and Secret Manager resource IDs in operator-owned configuration. Verify both a permitted browser origin and rejection from an unrelated origin after configuration. Map imagery is reference context, not surveyed geometry.
