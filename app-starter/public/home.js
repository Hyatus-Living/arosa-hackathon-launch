// Home at "/": the address entry with its pending box and the account's most recent sites.
import { fmtDate } from "./core-view.js";
import { routePath } from "./core-route.js";
import { displayAddress } from "./core-model.js";
import { skel } from "./skeleton.js";

const RECENT_SITES = 6;
// Returning home reuses the last list for this long unless a run may have changed it.
const SITES_MAX_AGE_MS = 60_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// A load that failed: the reason on one line and Try again beside it.
function retryLine(message, onRetry) {
  const line = el("div", "retry-line");
  const text = el("span", "", message);
  text.setAttribute("role", "alert");
  const retry = el("button", "retry-line-action", "Try again");
  retry.type = "button";
  retry.addEventListener("click", onRetry);
  line.append(text, retry);
  return { line, retry };
}

// Site rows while Your sites loads: a name and a meta line in each row's place.
function siteSkeletons(count = 4) {
  const status = el("p", "sr-only", "Loading your sites…");
  status.setAttribute("role", "status");
  const rows = Array.from({ length: count }, (_, i) => {
    const row = el("div", "home-site home-site-skeleton");
    row.setAttribute("aria-hidden", "true");
    row.append(skel("skel-text", { width: `${58 + (i % 3) * 10}%` }), skel("skel-text", { width: "40%", height: "11px" }));
    return row;
  });
  return [status, ...rows];
}

export function underwritePrompt(value) {
  const bbl = /^\d{10}$/.test(value) ? value : null;
  return { bbl, prompt: `Underwrite ${bbl ? "BBL " + bbl : value}: resolve the parcel, then compute its zoning envelope, entitlement scenarios, unit mix and pro forma. Complete the underwriting without requiring or generating floor plans, massing models or 3D renders.` };
}

// What a pending site's conversation says about it: "ready" once it has a project, "waiting" while a
// run is queued or running, "failed" when its runs ended without one, and "none" when no run exists,
// since a conversation that researched nothing has not failed to identify a parcel.
export function pendingOutcome(conversation) {
  if (conversation.projectId) return "ready";
  if (conversation.runs.some((r) => r.status === "queued" || r.status === "running")) return "waiting";
  return conversation.runs.length ? "failed" : "none";
}

// A pending site is {label, conversationId?, failed?, projectId?}: resolving, failed, or ready.
function pendingCopy(pending) {
  if (pending.projectId) return { text: `${pending.label} is ready.`, action: "Open site" };
  if (pending.failed) return { text: `Arosa could not identify a parcel for ${pending.label}. Open the conversation to see what it found.`, action: "Open conversation" };
  return { text: `Arosa is resolving ${pending.label}. It appears in Your sites once the parcel is identified.`, action: pending.conversationId ? "Follow in chat" : null };
}

export function createHome({ addressRoot, sitesRoot, canStart, listProjects, underwrite, openPending }) {
  let pending = null;
  let submit = null;
  const boxes = new Set();
  let list = null;
  let section = null;
  let allSites = null;
  let load = 0;
  let loadedAt = 0;

  function fillBox(box) {
    box.hidden = !pending;
    box.replaceChildren();
    if (!pending) return;
    box.classList.toggle("is-failed", Boolean(pending.failed));
    const { text, action } = pendingCopy(pending);
    box.append(el("p", "", text));
    if (!action) return;
    const open = el("button", "home-follow", action);
    open.type = "button";
    const current = pending;
    open.addEventListener("click", () => openPending(current));
    box.append(open);
  }

  function renderPending() {
    for (const box of boxes) {
      if (box.isConnected) fillBox(box);
      else boxes.delete(box);
    }
    syncAccess();
  }

  // A status box that mirrors the pending site, for any surface that starts one.
  function pendingBox() {
    const box = el("div", "home-pending");
    box.setAttribute("role", "status");
    boxes.add(box);
    fillBox(box);
    return box;
  }

  function renderAddress() {
    const form = el("form", "home-address");
    form.setAttribute("aria-labelledby", "home-address-title");
    const title = el("h2", "", "Underwrite an address");
    title.id = "home-address-title";
    const row = el("div", "home-address-row");
    const input = el("input");
    input.type = "text";
    input.name = "address";
    input.required = true;
    input.autocomplete = "off";
    input.placeholder = "Street, city and state, or NYC BBL";
    input.setAttribute("aria-label", "Address or BBL");
    submit = el("button", "home-follow primary", "Underwrite");
    submit.type = "submit";
    row.append(input, submit);
    form.append(title, row);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value || !canStart()) return;
      const { bbl, prompt } = underwritePrompt(value);
      // A started site clears the entry, so the same address is not started twice by accident.
      void underwrite(value, prompt, bbl).then((started) => {
        if (started && input.value.trim() === value) input.value = "";
      });
    });
    addressRoot.replaceChildren(form, pendingBox());
    syncAccess();
  }

  function renderSites() {
    section = el("section", "home-sites");
    section.setAttribute("aria-labelledby", "home-sites-title");
    const head = el("div", "home-sites-head");
    const title = el("h2", "", "Your sites");
    title.id = "home-sites-title";
    allSites = el("a", "home-all-sites", "All sites");
    allSites.href = allSites.dataset.route = routePath({ view: "sites" });
    allSites.hidden = true;
    head.append(title, allSites);
    list = el("div", "home-site-list");
    list.append(...siteSkeletons());
    section.append(head, list);
    sitesRoot.replaceChildren(section);
  }

  function siteRow(p) {
    const row = el("a", "home-site");
    row.href = row.dataset.route = routePath({ view: "site", projectId: p.id });
    row.dataset.project = p.id;
    row.append(el("strong", "", displayAddress(p.title) || "Untitled site"));
    const meta = [p.bbl ? `BBL ${p.bbl}` : "", p.updated ? `Updated ${fmtDate(p.updated)}` : ""].filter(Boolean).join(" · ");
    if (meta) row.append(el("small", "", meta));
    return row;
  }

  async function refreshSites() {
    const token = ++load;
    loadedAt = Date.now();
    section.setAttribute("aria-busy", "true");
    if (!list.querySelector("[data-project]")) list.replaceChildren(...siteSkeletons());
    let projects;
    try {
      projects = await listProjects();
    } catch (err) {
      if (token !== load) return;
      loadedAt = 0;
      section.setAttribute("aria-busy", "false");
      list.replaceChildren(retryLine(err.message, () => void refreshSites()).line);
      return;
    }
    if (token !== load) return;
    section.setAttribute("aria-busy", "false");
    allSites.hidden = !projects.length;
    list.replaceChildren(...(projects.length
      ? projects.slice(0, RECENT_SITES).map(siteRow)
      : [el("p", "home-empty", "Sites you underwrite appear here.")]));
  }

  function syncAccess() {
    if (submit) submit.disabled = !canStart();
  }

  return {
    // Draws the address entry and the Your sites frame; the list loads when home is shown.
    render() {
      renderAddress();
      renderSites();
    },
    // Loads Your sites the first time home is shown, then again once the list may be stale.
    showSites() {
      if (section && (!loadedAt || Date.now() - loadedAt > SITES_MAX_AGE_MS)) void refreshSites();
    },
    invalidateSites() {
      loadedAt = 0;
    },
    syncAccess,
    pendingBox,
    get pending() {
      return pending;
    },
    setPending(next) {
      pending = next;
      renderPending();
    },
  };
}
