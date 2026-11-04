// Three ways to build a site, side by side: as of right, most floor area and an alternative, each
// with its program and what it pays for the land, from GET /api/projects/:id/schemes. The site page
// and the full report both draw these cards; the rendering, floor plan and budget slots show their
// own views once those parts are drawn.
import { fmtMoney, fmtNumber, finite } from "./core-model.js";
import { skel } from "./skeleton.js";
import { renderSchemeBudget } from "./budget-view.js";
import { helpLink } from "./help-links.js";
import { openSendOption, withdrawLinks } from "./send-option.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const sf = (n) => `${fmtNumber(n)} SF`;
const perSf = (n) => `${Number(n) < 0 ? "-" : ""}$${fmtNumber(Math.abs(n))} per buildable SF`;

// The parts other features draw for a scheme, in card order. view(scheme, ctx) returns the part's
// own element, called once the part is drawn, or always when the view carries its own "not drawn"
// state and action; otherwise a missing part reads as not drawn yet.
export const SCHEME_SLOTS = [
  { part: "budget", label: "Budget", help: "budget", view: (scheme) => renderSchemeBudget(el("div"), scheme.budget) },
];

// The land basis the returns are figured on, in one line.
export function schemesBasisLine(basis) {
  if (!basis) return null;
  const at = basis.askFrom === "assumptions" ? `your land price of ${fmtMoney(basis.ask)}` : basis.askFrom === "listing" ? `the ${fmtMoney(basis.ask)} asking price` : null;
  return at
    ? `Land values at the target returns in the deal settings; yield, margin and profit at ${at}.`
    : "Land values at the target returns in the deal settings; with no price set, returns assume each option buys the land at what it pays.";
}

// What development land sells for near the site (nearbyLand), adjusted to this lot, against what the
// options could pay, and how the sales were adjusted when the figure carries its model.
export function nearbyLandLine(near) {
  if (!near) return null;
  const here = finite(near.value) ? `, about ${fmtMoney(near.value)} for this site's as-of-right floor area` : "";
  const how = near.model ? " Each nearby sale is adjusted to this lot for its standing building, FAR, existing apartments and lot size, then weighted by distance." : "";
  const miles = fmtNumber(near.radiusMiles, 1);
  return `${near.sales} development-site sales within ${miles} ${miles === "1" ? "mile" : "miles"} over the last ${near.months} months put this lot at ${perSf(near.perBuildableSqft)}${here}.${how}`;
}

// The largest building as a city-financed, all-affordable rental, beside the market-rate options.
export function subsidizedLine(subsidized) {
  if (!subsidized) return null;
  const pays = subsidized.landValue > 0 ? `pays ${fmtMoney(subsidized.landValue)} for the land${subsidized.capped ? ", capped at appraised land value (nearby sales)" : ""}` : "pays nothing for the land";
  return `With city financing, an all-affordable rental of ${fmtNumber(subsidized.units)} units at ${subsidized.amiPct}% AMI rents ${pays}, counting up to $${fmtNumber(subsidized.subsidyPerUnit)} a unit of HPD and HDC loans and ${fmtMoney(subsidized.taxCreditEquity)} of 4% tax credit equity.`;
}

// What the conversation is asked when an option has no building shape yet.
export function schemeModelMessage(scheme) {
  const p = scheme.program;
  return `Model the building shape for the "${scheme.label}" option (${scheme.summary}): about ${fmtNumber(p.zfa)} SF of zoning floor area over ${p.storeys} storeys, within the zoning envelope. Name the concept "${scheme.label}".`;
}

function figures(scheme) {
  const r = scheme.returns, p = scheme.program;
  const dl = el("dl", "uw-scheme-figures");
  const row = (label, value, note = null, tone = null, help = null) => {
    const div = el("div", tone ? `is-${tone}` : "");
    const dt = el("dt", "", label);
    if (help) dt.append(helpLink(help, { icon: true }));
    div.append(dt, el("dd", "", value));
    if (note) div.append(el("dd", "uw-scheme-note", note));
    dl.append(div);
  };
  // An option's land figure is its residual: what a developer could pay for the land at the account's
  // costs and target return. The site's land value from nearby sales sits above the cards.
  row("A developer can pay", fmtMoney(r.landValue), r.landValue > 0 ? perSf(r.landValuePerBsf) : "Pays nothing for the land at target returns", r.landValue > 0 ? null : "negative", "land-value");
  // Both returns are figured on the same land basis; say which one so a yield and a margin on
  // neighbouring cards are not read as like for like without it.
  const basisNote = r.landBasis === "ask" ? "at the asking price" : "at the land value above";
  if (p.exit === "rental") row("Yield on cost", finite(r.yieldOnCost) ? `${r.yieldOnCost.toFixed(2)}%` : "–", basisNote);
  else row("Condo margin", finite(r.condoMargin) ? `${r.condoMargin.toFixed(1)}%` : "–", basisNote);
  row("Profit", fmtMoney(r.profit), `on ${fmtMoney(r.totalCost)} total cost`, r.profit < 0 ? "negative" : null);
  row("Floor area", sf(p.zfa), p.affordableZfa > 0 ? `${sf(p.affordableZfa)} affordable` : `${sf(p.grossSqft)} gross`);
  return dl;
}

function slots(scheme, ctx) {
  const list = el("ul", "uw-scheme-slots");
  for (const slot of SCHEME_SLOTS) {
    const li = el("li");
    li.dataset.part = slot.key ?? slot.part;
    const value = scheme[slot.part];
    if (slot.view && (value || slot.always)) {
      li.className = "has-view";
      const label = el("strong", "", slot.label);
      if (slot.help) label.append(helpLink(slot.help, { icon: true }));
      li.append(label, slot.view(scheme, ctx));
    }
    else li.append(el("strong", "", slot.label), el("span", "", value ? "Drawn" : "Not drawn yet"));
    list.append(li);
  }
  return list;
}

export function schemeCard(scheme, ctx = {}) {
  // Where no option pays for the land at target returns, none is marked as paying the most.
  const pays = scheme.best && scheme.returns?.landValue > 0;
  const li = el("li", `uw-scheme${pays ? " is-best" : ""}${scheme.program ? "" : " is-empty"}`);
  li.dataset.scheme = scheme.id;
  const head = el("header", "uw-scheme-head");
  head.append(el("h3", "", scheme.label));
  if (pays) head.append(el("span", "uw-scheme-badge", "Pays the most for the land"));
  li.append(head);
  if (!scheme.program) {
    li.append(el("p", "uw-scheme-summary", scheme.note || scheme.summary));
    return li;
  }
  li.append(el("p", "uw-scheme-summary", scheme.summary));
  // The option that pays the most for the land says why, in one sentence, under its badge.
  if (scheme.reason) li.append(el("p", "uw-scheme-reason", scheme.reason));
  if (scheme.note) li.append(el("p", "uw-scheme-note", scheme.note));
  li.append(figures(scheme));
  li.append(slots(scheme, ctx));
  const send = sendAction(scheme, ctx);
  if (send) li.append(send);
  return li;
}

const sentOn = (at) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// The card's second, quiet action: a link to this option for an architect or contractor, which only
// the site owner may make or withdraw (ctx.sends, from the schemes route), with the latest send beside it.
function sendAction(scheme, ctx) {
  if (ctx.report || !ctx.sends?.canSend) return null;
  const row = el("div", "uw-scheme-send");
  const b = el("button", "uw-scheme-send-button", "Send to an architect or GC");
  b.type = "button";
  const line = el("span", "uw-scheme-sent");
  const show = (sent) => line.replaceChildren(...(sent ? [`Sent ${sentOn(sent.at)} by ${sent.by}`,
    withdrawLinks({ projectId: ctx.projectId, scheme, onWithdrawn: () => line.replaceChildren("Links withdrawn") })] : []));
  show(ctx.sends.sent?.[scheme.id]);
  b.addEventListener("click", () => openSendOption({ projectId: ctx.projectId, scheme, onSent: (link) => show({ at: link.createdAt, by: link.option.sender.name }) }));
  row.append(b, line);
  return row;
}

function cards(read, ctx) {
  const list = el("ol", "uw-scheme-list");
  list.setAttribute("aria-label", "Three ways to build it");
  for (const scheme of read.schemes) list.append(schemeCard(scheme, { ...ctx, sends: read.sends }));
  return list;
}

// The site page section. read: undefined while the site has no parcel, {loading} while the first
// read is under way, {error} when it failed, else the route's answer.
export function renderSchemes(read, ctx = {}) {
  if (!read || (!read.loading && !read.error && !read.schemes)) return null;
  const root = el("section", "uw-schemes");
  root.id = "core-schemes";
  root.setAttribute("aria-labelledby", "core-schemes-title");
  const h = el("h2", "", "Three ways to build it");
  h.id = "core-schemes-title";
  const head = el("div", "uw-schemes-head");
  head.append(h);
  if (read.schemes) head.append(helpLink("three-options"));
  root.append(head);
  if (read.loading) {
    const status = el("p", "sr-only", "Pricing three ways to build it");
    status.setAttribute("role", "status");
    const list = el("ol", "uw-scheme-list");
    for (let i = 0; i < 3; i++) {
      const card = el("li", "uw-scheme");
      card.append(skel("skel-title", { width: "45%" }), skel("skel-text", { width: "90%", marginTop: "10px" }), skel("skel-block", { height: "96px", marginTop: "14px" }));
      list.append(card);
    }
    root.append(status, list);
    return root;
  }
  if (read.error) {
    const line = el("div", "core-fail");
    line.setAttribute("role", "status");
    const retry = el("button", "core-follow", "Retry");
    retry.type = "button";
    retry.dataset.schemesRetry = "";
    line.append(el("span", "core-fail-text", "The three options did not load."), retry);
    root.append(line);
    return root;
  }
  root.append(el("p", "uw-schemes-basis", schemesBasisLine(read.basis)));
  for (const line of [nearbyLandLine(read.basis?.nearbyLand), subsidizedLine(read.basis?.subsidized)]) {
    if (line) root.append(el("p", "uw-schemes-basis", line));
  }
  root.append(cards(read, ctx));
  return root;
}

// The full report's cards: the same figures without the page's actions.
export function schemesReportBlock(read, ctx = {}) {
  if (!read?.schemes) return [];
  const basis = el("p", "report-source-line", schemesBasisLine(read.basis));
  basis.append(helpLink("three-options"));
  return [basis, cards(read, { ...ctx, report: true })];
}
