// The floor plan page's schemes: a site has one plan per scheme (As of right, Most floor area,
// Alternative), switched at the top of the plan page, and "Draft all three" lays out each scheme's
// floors in the background. The site's schemes card links here with schemePlanPath and starts
// drafting with draftSchemePlans.
import { SCHEMES, DEFAULT_SCHEME } from "./plan-intake.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// The scheme a plan page address names; an unknown or missing one opens the as-of-right plan.
export function schemeFromSearch(search = "") {
  const scheme = new URLSearchParams(search).get("scheme");
  return SCHEMES.some((s) => s.id === scheme) ? scheme : DEFAULT_SCHEME;
}

export const schemePlanPath = (projectId, scheme) => `/modeling/${encodeURIComponent(projectId)}?scheme=${encodeURIComponent(scheme)}`;

// Prices the site's schemes as they stand, then queues a plan for each one that has a building.
// api is {get, post} over /api (core.js). Resolves to {drafts: [{scheme, status, ...}]}.
export async function draftSchemePlans(api, projectId) {
  const id = encodeURIComponent(projectId);
  await api.get(`/projects/${id}/schemes`);
  return api.post(`/projects/${id}/architecture/schemes/draft`, {});
}

const pct = (v) => `${Math.round(v * 100)}%`;
// Units a floor on the residential floors: one figure, or the range where they differ (report.levels, one per
// drawn plate; the cellar and a ground floor of lobby and shops hold none).
function perFloor(report) {
  const floors = (report.levels || []).filter((l) => (l.use || "residential") === "residential");
  const counts = (floors.length ? floors : [{ units: report.unitsPerFloor }]).map((l) => l.units);
  const lo = Math.min(...counts), hi = Math.max(...counts);
  return lo === hi ? `${lo} unit${lo === 1 ? "" : "s"} a floor` : `${lo} to ${hi} units a floor`;
}
// One line on the open scheme's drawn floors: its units against the scheme's, how the layout was chosen
// (report.why, from the planning engine), and whether the mix fits.
export function draftSummary(report) {
  const units = `${perFloor(report)} over ${report.storeys} storeys`;
  const total = report.typicalFloorUnits === report.buildingUnits ? `the scheme's ${report.buildingUnits} units`
    : report.typicalFloorUnits < report.buildingUnits ? `${report.typicalFloorUnits} of the scheme's ${report.buildingUnits} units`
    : `${report.typicalFloorUnits} units against the scheme's ${report.buildingUnits}`;
  const how = report.why ? report.why.summary : `${pct(report.netToGross)} of the floor is in units.`;
  return `${units}, ${total}. ${how}${report.fit.fits ? "" : ` The mix does not fit: ${report.fit.issues.join(" ")}`}`;
}

// "Why this plan": the rules the chosen layout meets, the values it assumes, what it misses, and what the
// architect still has to check, each list under its own heading.
export function whyThisPlan(why) {
  const box = el("details", "core-plan-scheme-why");
  box.append(el("summary", "", "Why this plan"));
  for (const [label, items] of [["Rules met", why.satisfied], ["Not met", why.failed], ["Assumed, not set by code", why.assumed], ["For the architect to check", why.architect]]) {
    if (!items?.length) continue;
    box.append(el("h4", "", label));
    const list = el("ul");
    for (const item of items) list.append(el("li", "", item));
    box.append(list);
  }
  return box;
}

// The floor plan slot of a scheme's card (schemes-view.js): the drawn floors and the way to its plan.
// scheme.plan is {planId, revision, svg, why, drawn} (svg: the revision's plan drawing, an artifact id;
// drawn, the units and floor area the plan holds, shows among the card's figures).
export function renderSchemePlan(scheme, { projectId }) {
  const box = el("div", "uw-scheme-plan");
  const id = encodeURIComponent(projectId);
  if (scheme.plan.svg) {
    const img = el("img", "uw-scheme-plan-image");
    img.src = `/api/projects/${id}/architecture/artifacts/${encodeURIComponent(scheme.plan.svg)}`;
    img.alt = `Floor plans of the ${scheme.label} option`;
    img.loading = "lazy";
    box.append(img);
  }
  if (scheme.plan.why) box.append(el("p", "uw-scheme-plan-why", scheme.plan.why));
  const link = el("a", "", `Open the floor plan, revision ${scheme.plan.revision}`);
  link.href = link.dataset.route = schemePlanPath(projectId, scheme.id);
  box.append(link);
  return box;
}

// The switcher and its action. summary is the open scheme's architecture summary (its schemes list
// names each scheme's latest revision); drafts is the latest draft of each scheme; drafting is true
// while the request to start drafting is in flight.
export function renderSchemeSwitcher({ scheme, summary, drafts, drafting, error, existingOnly = false }) {
  const bar = el("div", "core-plan-schemes");
  const group = el("div", "core-plan-scheme-tabs");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", existingOnly ? "Saved plans" : "Scheme");
  const heads = new Map((summary?.schemes || []).filter(s => !existingOnly || s.revision).map((s) => [s.scheme, s]));
  const latest = new Map((drafts || []).map((d) => [d.scheme, d]));
  const busy = drafting || (drafts || []).some((d) => d.status === "queued" || d.status === "running");
  for (const { id, label } of SCHEMES) {
    if (existingOnly && !heads.has(id) && id !== scheme) continue;
    const button = el("button", "core-plan-scheme");
    button.type = "button";
    button.dataset.planScheme = id;
    button.setAttribute("aria-pressed", String(id === scheme));
    const draft = latest.get(id), head = heads.get(id);
    const state = draft?.status === "running" ? "Drawing" : draft?.status === "queued" ? "Waiting to draw"
      : draft?.status === "succeeded" && draft.revision === head?.revision ? perFloor(draft.report)
      : head?.revision ? `Revision ${head.revision}` : draft?.status === "failed" ? "Not drawn" : "Not drawn yet";
    button.append(el("span", "core-plan-scheme-label", label), " ", el("span", "core-plan-scheme-state", state));
    group.append(button);
  }
  const allDrawn = SCHEMES.every((s) => heads.get(s.id)?.revision);
  if (existingOnly) { bar.append(group); return bar; }
  const action = el("button", "core-follow", busy ? "Drawing the plans" : allDrawn ? "Redraw all three" : "Draft all three");
  action.type = "button";
  action.dataset.planDraft = "";
  action.disabled = busy;
  bar.append(group, action);
  const draft = latest.get(scheme), head = heads.get(scheme);
  const note = error ? `The plans could not be drafted: ${error}`
    : draft?.status === "failed" ? `This scheme could not be drawn: ${draft.reason}`
    : draft?.status === "succeeded" && draft.revision === head?.revision ? draftSummary(draft.report)
    : null;
  const status = el("p", `core-plan-scheme-note${note && (error || draft?.status === "failed" || !draft?.report?.fit.fits) ? " tone-warning" : ""}`, note);
  status.setAttribute("role", "status");
  status.hidden = !note;
  bar.append(status);
  if (!error && draft?.status === "succeeded" && draft.revision === head?.revision && draft.report?.why) bar.append(whyThisPlan(draft.report.why));
  return bar;
}
