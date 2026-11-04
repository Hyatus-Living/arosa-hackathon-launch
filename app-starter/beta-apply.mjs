// How many beta applications one address may send per window: a few retries are fine, a flood is not.
export function betaApplyAllowed(log, client, now = Date.now(), limit = 5, windowMs = 3600000) {
  const recent = (log.get(client) || []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    log.set(client, recent);
    return false;
  }
  log.set(client, [...recent, now]);
  return true;
}
