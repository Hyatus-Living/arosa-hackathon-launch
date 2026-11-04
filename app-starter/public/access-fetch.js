// Cloudflare Access sends a request with an expired sign-in to its login page on another domain. A
// script's request cannot follow that redirect, so it would fail as a network error. Marked as a
// script request, it gets a 401 instead, and the page can say the sign-in expired.
export const SIGN_IN_EXPIRED = "arosa:sign-in-expired";

export function isAccessSignInExpired(response) {
  return response.status === 401 && Boolean(response.headers.get("www-authenticate")?.startsWith("Cloudflare-Access"));
}

export function markScriptRequests(target = globalThis) {
  const nativeFetch = target.fetch.bind(target);
  target.fetch = async (input, init = {}) => {
    const url = new URL(String(input), target.location.href);
    if (url.origin !== target.location.origin || !url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const headers = new Headers(init.headers);
    headers.set("x-requested-with", "XMLHttpRequest");
    const response = await nativeFetch(input, { ...init, headers });
    if (isAccessSignInExpired(response)) target.dispatchEvent(new Event(SIGN_IN_EXPIRED));
    return response;
  };
}

markScriptRequests();
