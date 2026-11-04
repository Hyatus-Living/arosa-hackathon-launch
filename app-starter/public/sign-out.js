// Cloudflare Access ends the session at this path on the app domain itself,
// so the link keeps working if the Access team domain changes.
export const SIGN_OUT_URL = "/cdn-cgi/access/logout";

// After the app's Access session ends, the browser also ends the Arosa login
// session, then lands on the public Arosa site. Without that second step the
// next sign-in reuses the login session and returns the same person, so
// nobody could switch accounts.
export const SIGNED_OUT_URL = "https://login.witharosa.ai/sign-out?return_to=" + encodeURIComponent("https://witharosa.ai/");

// Ends the Access session without navigating to the Access logout page: the
// logout response itself deletes the CF_Authorization cookie on this domain.
// With a live session the logout path then redirects to the Access team
// domain, which a CORS-mode fetch rejects after the cookie is already gone;
// an opaque no-cors request still processes the cookie deletions and resolves.
// The wait is capped: a slow or hung logout request must never trap the user
// on the page, because the caller falls back to navigating to the logout URL.
export async function endAccessSession(fetchImpl = globalThis.fetch, timeoutMs = 4000) {
  if (typeof fetchImpl !== "function") return false;
  try {
    const ended = Promise.resolve(
      fetchImpl(SIGN_OUT_URL, {
        credentials: "include",
        mode: "no-cors",
        cache: "no-store",
      }),
    ).then(() => true);
    if (!(timeoutMs > 0)) return await ended;
    let timer;
    const gaveUp = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([ended, gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// Announces the pending sign-out on every sign-out link so a slow logout
// never looks like a dead click. Returns false when sign-out is already
// under way, so repeat clicks are ignored.
export function markSigningOut(links) {
  const list = [...(links || [])].filter(Boolean);
  if (!list.length || list[0].classList.contains("is-pending")) return false;
  for (const link of list) {
    link.classList.add("is-pending");
    link.setAttribute("aria-disabled", "true");
    const label = link.querySelector("span") || link;
    label.textContent = "Signing out…";
  }
  return true;
}

// The person's name when the data has one, otherwise their email. A name that is only the email's
// local part ("michael" for michael@...) is the server's fallback, not a name, so the email shows.
export function accountDisplay(person) {
  const email =
    typeof person?.email === "string"
      ? person.email.trim().toLowerCase()
      : "";
  const raw = typeof person?.name === "string" ? person.name.trim() : "";
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  const name = raw && raw.toLowerCase() !== local ? raw : "";
  const primary = name || email || "Arosa account";
  const secondary = name && email ? email : email ? "" : "Saved to your Arosa account";
  const parts = (name || local).split(/[\s._-]+/).filter(Boolean);
  const initials = (
    parts
      .slice(0, 2)
      .map((part) => part[0])
      .join("") || "A"
  ).toUpperCase();
  return { primary, secondary, initials, email: email || null };
}

export function clearSavedDraft(storage, key) {
  if (!storage || !key) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
