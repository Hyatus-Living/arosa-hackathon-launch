// Client routes: home (the listings map and top deals) at "/", one open listing on home at
// "/listings/:listingId", the sites list at "/sites", a site Arosa is still resolving at "/sites/new", one site at
// "/sites/:projectId", its floor plan at "/sites/:projectId/plan", its underwriting report at
// "/sites/:projectId/report", independent Modeling at "/modeling" and "/modeling/:projectId", shared links at
// "/shared/:token" and shipped changes at "/whats-new". Old "/core" links are aliases, and an old
// "/chat" link is home with the chat drawer open.
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function needsUnderwritingSetup(route,session) {
  return Boolean(session) && !(session.architectureEnabled===true && ['models','plan'].includes(route.view));
}

// Links people copy or share use Arosa's main address, build.witharosa.ai, even on
// app.witharosa.ai, which still serves Arosa.
export function linkOrigin(origin = window.location.origin) {
  return origin === "https://app.witharosa.ai" ? "https://build.witharosa.ai" : origin;
}

// A truncated or hand-edited link can carry a malformed escape such as "%E0%A4%A"; such a
// segment matches no route, so the app opens home instead of failing to start.
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoute(pathname = "/") {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/chat") return { view: "home", chat: true };
  if (path === "/whats-new") return { view: "whats-new" };
  if (path === "/sites" || path === "/core") return { view: "sites" };
  if (path === "/sites/new") return { view: "starting" };
  if (path === "/modeling") return { view: "models" };
  const model = path.match(/^\/modeling\/([^/]+)$/);
  if (model) {
    const projectId = safeDecode(model[1]);
    return projectId !== null && PROJECT_ID.test(projectId) ? { view: "plan", projectId } : { view: "models" };
  }
  const site = path.match(/^\/(?:sites|core)\/([^/]+)(?:\/(plan|report))?$/);
  if (site) {
    const projectId = safeDecode(site[1]);
    return projectId !== null && PROJECT_ID.test(projectId) ? { view: site[2] || "site", projectId } : { view: "sites" };
  }
  const listing = path.match(/^\/listings\/([^/]+)$/);
  if (listing) {
    const listingId = safeDecode(listing[1]);
    return listingId !== null && listingId.length <= 300 ? { view: "home", listingId } : { view: "home" };
  }
  const shared = path.match(/^\/shared\/([^/]+)$/);
  const token = shared && safeDecode(shared[1]);
  if (token) return { view: "shared", token };
  return { view: "home" };
}

export function routePath(route) {
  if (route.view === "whats-new") return "/whats-new";
  if (route.view === "sites") return "/sites";
  if (route.view === "starting") return "/sites/new";
  if (route.view === "models") return "/modeling";
  if (route.view === "site") return "/sites/" + encodeURIComponent(route.projectId);
  if (route.view === "plan") return "/modeling/" + encodeURIComponent(route.projectId);
  if (route.view === "report") return "/sites/" + encodeURIComponent(route.projectId) + "/report";
  if (route.view === "shared") return "/shared/" + encodeURIComponent(route.token);
  if (route.listingId) return "/listings/" + encodeURIComponent(route.listingId);
  return "/";
}

// Parses the current location and rewrites an alias to its named route without a new history entry.
// Without a session no site or chat can load, so every route lays out as home and shows the sign-in notice.
// Modeling needs the session's architecture flag; accounts outside the rollout return to Underwriting.
export function resolveRoute(location, history, session) {
  const parsed = parseRoute(location.pathname);
  const route = ["plan", "models"].includes(parsed.view) && session?.architectureEnabled !== true ? { view: "sites" } : parsed;
  const path = routePath(route);
  if (path !== location.pathname) history.replaceState(null, "", path + location.search + location.hash);
  return session ? route : { view: "home" };
}

// Layout mode classes for <body> on each route. A shared link opens on home once it is claimed.
// The floor plan page and a site still resolving use the site layout: the page beside the chat sidebar.
// The report is a site page of its own that keeps the site's menu but not the site page.
export function bodyModes(route) {
  const sites = route.view === "sites", model = ["models", "plan"].includes(route.view), site = ["site", "plan", "starting"].includes(route.view), report = route.view === "report";
  return { "core-mode": sites || site || model, "view-home": route.view === "home", "view-sites": sites, "view-modeling": model, "view-site": site || report, "view-report": report, "view-whats-new": route.view === "whats-new" };
}
