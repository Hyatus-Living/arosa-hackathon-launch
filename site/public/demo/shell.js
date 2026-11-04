// Shared by every product embed on witharosa.ai: follows the landing page's day or night view,
// answers the app's API calls from example data, and talks to the landing page around it.
const host = window.parent !== window ? window.parent : null;
const root = document.documentElement;

// The embed takes the landing page's view and follows each switch.
if (host) {
  const sync = () => root.classList.toggle("dark", host.document.documentElement.classList.contains("dark"));
  sync();
  new MutationObserver(sync).observe(host.document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

// The app's icons are <use> references into one inline symbol sheet.
const symbols = fetch("/app/symbols.svg").then((r) => r.text()).then((svg) => document.body.insertAdjacentHTML("afterbegin", svg));

// Requests under /api are answered by the handler; it returns the JSON body for a path.
export function serveApi(handler) {
  const real = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return real(input, options);
    const body = await handler(url.pathname.slice(4), url.searchParams, options);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduced() ? Math.min(ms, 60) : ms));
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Messages to and from the landing page: { arosa: type, ...data }.
export function tell(type, data = {}) {
  host?.postMessage({ arosa: type, ...data }, location.origin);
}
export function listen(type, fn) {
  addEventListener("message", (event) => {
    if (event.origin === location.origin && event.data?.arosa === type) fn(event.data);
  });
}

// A page that grows tells the landing page its height, so the window fits it without scrolling.
if (document.body.classList.contains("demo-grow")) {
  const page = document.querySelector("main");
  new ResizeObserver(() => tell("height", { height: page.offsetHeight })).observe(page);
}

// Resolves once the icons are in; the embed then says it is ready for messages.
export const ready = symbols;
