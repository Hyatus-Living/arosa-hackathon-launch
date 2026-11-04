import {publicErrorMessage} from './chat-api.js';
// Parcel mode of the Core page: one site as four underwriting steps, each answered in a line
// with its working behind a disclosure. Every figure comes from a project state field.
import { conceptComparison } from "./conversation-view.js";
import {
  FIELD_LABELS,
  INSTRUCTION_SECTIONS,
  STEP_NOTES,
  stepView,
  snapshot,
  landAnswer,
  decisionDiffers,
  tierBasisPhrase,
  siteName,
  stateField,
  provenanceLabel,
  staleLabel,
  fmtNumber,
  fmtSqft,
  fmtMoney,
  fmtDollars,
  fmtRate,
  fmtFar,
  finite,
  parcelFlags,
  districtSummary,
  capacityRows,
  zfaBand,
  zoningHeadline,
  conceptsNewestFirst,
  conceptParentName,
  assumptionInputs,
  collectSources,
  jobStatus,
  fmtArea,
  toolStep,
} from "./core-model.js";
import { skel } from "./skeleton.js";
import { describeStep } from "./activity-view.js";
import { sourcesFound, timeLine } from "./run-trail.js";
import { newsList } from "./news-view.js";
import { renderNearbyPipeline } from "./nearby-pipeline.js";
import { renderSchemes } from "./schemes-view.js";
import { helpLink } from "./help-links.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function fmtDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function factList(rows) {
  const dl = el("dl", "core-facts");
  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === "" || value === "–") continue;
    const row = el("div");
    row.append(el("dt", "", label), el("dd", "", value));
    dl.append(row);
  }
  return dl;
}

function table(caption, head, rows, className = "core-table") {
  const wrap = el("div", "core-table-wrap");
  const t = el("table", className);
  if (caption) t.append(el("caption", "", caption));
  const thead = el("thead"), hr = el("tr");
  head.forEach((h, i) => {
    const th = el("th", "", h);
    th.scope = "col";
    if (i === 0 && !h) th.setAttribute("aria-label", "Measure");
    hr.append(th);
  });
  thead.append(hr);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((cell, i) => {
      const c = i === 0 ? el("th", "", cell) : el("td", "", cell);
      if (i === 0) c.scope = "row";
      tr.append(c);
    });
    body.append(tr);
  }
  t.append(thead, body);
  wrap.append(t);
  return wrap;
}

// Columns-as-items table: one column per item, one row per measure; rows with no values drop out.
function columnTable(caption, items, columnLabel, measures) {
  const rows = measures
    .map(([label, read]) => [label, ...items.map((item) => read(item))])
    .filter((row) => row.slice(1).some((v) => v !== null && v !== undefined && v !== "" && v !== "–"))
    .map((row) => row.map((v) => (v === null || v === undefined || v === "" ? "–" : v)));
  return table(caption, ["", ...items.map(columnLabel)], rows, "core-table core-compare");
}

const VIEWER_ONLY = "Viewers can read this site but not ask Arosa to change it.";

function followButton(ctx, field, action, label, primary = false) {
  const b = el("button", "core-follow" + (primary ? " primary" : ""), label);
  b.type = "button";
  b.dataset.followField = field;
  b.dataset.followAction = action;
  b.disabled = !ctx.canSend;
  if (!ctx.canSend) b.title = VIEWER_ONLY;
  return b;
}

const INSTRUCTION_HINTS = {
  envelope: "For example: treat the frontage on the avenue as a wide street, or test a rezoning to R7A.",
  massing: "For example: keep it under seven storeys, or hold the street wall at 65 feet.",
  architecture: "For example: two units per floor with a single stair.",
  revenue: "For example: condo only, mostly two bedrooms.",
  assumptions: "For example: land at $9.5M, 30 percent equity.",
};

const NOTE_LABELS = {
  envelope: "Zoning and approvals",
  massing: "Building shape",
  architecture: "Floor plan",
  revenue: "Units and revenue",
  assumptions: "Costs and financing",
};

function instructionBox(state, ctx, id) {
  const wrap = el("div", "core-instructions");
  const box = el("textarea", "core-instructions-input");
  box.id = `core-${id}-instructions`;
  box.name = id;
  box.rows = 2;
  box.maxLength = 2000;
  box.dataset.instructions = id;
  box.setAttribute("aria-label", `Instructions for Arosa: ${INSTRUCTION_SECTIONS[id]}`);
  box.placeholder = INSTRUCTION_HINTS[id];
  box.value = stateField(state, "instructions")?.value?.[id] || "";
  box.dataset.initial = box.value.trim();
  box.disabled = !ctx.canEdit;
  const label = el("label", "core-instructions-label", NOTE_LABELS[id]);
  label.setAttribute("for", box.id);
  wrap.append(label, box, el("span", "core-instructions-status"));
  return wrap;
}

function provenanceLine(state, keys) {
  const line = el("div", "core-provenance");
  for (const key of keys) {
    const f = stateField(state, key);
    if (!f) continue;
    const chip = el("span", "core-prov" + (f.provenance?.tool === "user" ? " is-user" : ""));
    chip.dataset.field = key;
    const when = fmtDate(f.updated);
    chip.textContent = `${capitalize(FIELD_LABELS[key] || key)}: ${provenanceLabel(f.provenance)}${when ? " · " + when : ""}`;
    line.append(chip);
    const stale = staleLabel(f);
    if (stale) {
      const s = el("span", "core-stale", stale);
      s.dataset.staleField = key;
      line.append(s);
    }
  }
  return line;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function section(id, title, state, keys, actions = [], ctx = null) {
  const root = el("section", "core-section");
  root.id = "core-" + id;
  root.setAttribute("aria-labelledby", `core-${id}-title`);
  const head = el("header", "core-section-head");
  const h = el("h2", "", title);
  h.id = `core-${id}-title`;
  const titleRow = el("div", "core-section-title");
  titleRow.append(h);
  if (actions.length) {
    const bar = el("div", "core-section-actions");
    bar.append(...actions);
    titleRow.append(bar);
  }
  head.append(titleRow, provenanceLine(state, keys));
  root.append(head);
  if (ctx && id in INSTRUCTION_SECTIONS) root.append(instructionBox(state, ctx, id));
  return root;
}

function subhead(text) {
  return el("h3", "core-subhead", text);
}

const existingBuilding = (p) => [
  Number(p.bldgarea) > 0 ? fmtSqft(p.bldgarea) : "",
  Number(p.numfloors) > 0 ? `${fmtNumber(p.numfloors)} floors` : "",
  Number(p.yearbuilt) > 0 ? `built ${p.yearbuilt}` : "",
  p.bldgclass ? `class ${p.bldgclass}` : "",
].filter(Boolean).join(", ");

// Step 1: the parcel record behind the answer line.
function propertyDetails(state) {
  const p = stateField(state, "property").value;
  const root = el("div", "uw-detail");
  root.append(el("p", "core-sub", [`BBL ${p.bbl}`, p.borough, p.zipcode, p.version ? `PLUTO ${p.version}` : ""].filter(Boolean).join(" · ")));
  const d = districtSummary(p);
  const existing = existingBuilding(p);
  root.append(factList([
    ["Zoning", d.zoning || "None reported"],
    ["Commercial overlay", d.overlays],
    ["Special district", d.special || "None reported"],
    ["Lot area", fmtSqft(p.lotarea)],
    ["Frontage and depth", Number(p.lotfront) > 0 && Number(p.lotdepth) > 0 ? `${fmtNumber(p.lotfront, 1)} ft by ${fmtNumber(p.lotdepth, 1)} ft` : ""],
    ["Existing building", existing || "No building reported"],
    ["Built FAR", fmtFar(p.builtfar)],
    ["Owner", p.ownername],
  ]));
  root.append(provenanceLine(state, ["property"]));
  return root;
}

function flagList(p) {
  const flags = parcelFlags(p);
  const row = el("ul", "core-flags");
  row.setAttribute("aria-label", "Parcel flags");
  if (flags.length) for (const flag of flags) row.append(el("li", "core-flag", flag));
  else row.append(el("li", "core-flag is-clear", "No landmark, historic district, flood zone or E-designation reported"));
  return row;
}

// Step 2: the envelope and the ways to add floor area, behind the answer line.
function envelopeDetails(state) {
  const env = stateField(state, "envelope")?.value;
  const ent = stateField(state, "entitlements")?.value;
  const root = el("div", "uw-detail");
  root.id = "core-envelope";
  root.append(provenanceLine(state, ["envelope", "entitlements"]));
  if (env) {
    root.append(subhead("Zoning envelope"));
    root.append(factList([
      ["District", env.district],
      ["Maximum FAR", fmtFar(env.floorArea?.maxFar)],
      ["Maximum floor area", fmtSqft(env.floorArea?.maxFloorAreaSqft)],
      ["Modeled floor area", fmtSqft(env.metrics?.floorAreaSqft)],
      ["Modeled height", env.metrics?.heightFeet != null ? `${fmtNumber(env.metrics.heightFeet, 1)} ft, ${fmtNumber(env.metrics.storeys)} storeys` : ""],
      ["Limited by", env.metrics?.stoppedBy],
      ["Maximum dwelling units", fmtNumber(env.density?.maxUnits)],
      ["Parking required", env.parking?.required != null ? fmtNumber(env.parking.required) + " spaces" : ""],
    ]));
    const s = env.summary;
    if (s) {
      root.append(subhead("Envelope controls"));
      root.append(factList([
        ["Base height", s.baseHeightMinFeet != null || s.baseHeightMaxFeet != null ? `${fmtNumber(s.baseHeightMinFeet, 1)} to ${fmtNumber(s.baseHeightMaxFeet, 1)} ft` : ""],
        ["Maximum building height", s.maxBuildingHeightFeet != null ? `${fmtNumber(s.maxBuildingHeightFeet, 1)} ft` : ""],
        ["Setback depth", s.setbackDepthFeet != null && typeof s.setbackDepthFeet !== "object" ? `${fmtNumber(s.setbackDepthFeet, 1)} ft` : ""],
        ["Maximum lot coverage", s.maxLotCoveragePercent != null ? `${fmtNumber(s.maxLotCoveragePercent)}%` : ""],
        ["Rear yard", s.rearYardFeet != null ? `${fmtNumber(s.rearYardFeet, 1)} ft` : ""],
        ["Street widths", s.streetAssumption],
      ]));
    }
    const head = zoningHeadline(env.headlineReconciliation);
    if (head) {
      root.append(subhead("Headline zoning floor area"));
      root.append(factList([["Operative figure", head.value], ...head.rows]));
      root.append(el("p", "core-note", head.reason));
    }
    const cap = env.capacity;
    const rows = capacityRows(cap);
    if (rows.length) {
      root.append(table(cap.splitLot ? "Floor area capacity by use (PLUTO, each use as if the whole split lot were in one district)" : "Floor area capacity by use (PLUTO)", ["Use", "Max FAR", "Max floor area", "Remaining"],
        rows.map((r) => [r.label, fmtFar(r.maxFar), fmtSqft(r.maxFloorAreaSqft), fmtSqft(r.remainingFloorAreaSqft)])));
    }
    const band = zfaBand(cap);
    if (band.length) {
      const uses = band[0].residual.map((r) => r.label);
      root.append(table("Remaining floor area if existing zoning floor area is 85 to 100 percent of PLUTO gross area",
        ["Existing ZFA share", "Existing ZFA", ...uses.map((u) => `${u} remaining`)],
        band.map((b) => [`${b.percent}%`, fmtSqft(b.zfaSqft), ...b.residual.map((r) => fmtSqft(r.sqft))])));
    }
  }
  if (ent) {
    root.append(subhead("Ways to add floor area"));
    if (ent.baseline) root.append(el("p", "core-note", ent.baseline.existingFloorAreaSqft == null
      ? `Baseline: FAR ${fmtFar(ent.baseline.governingFar)}, ${fmtSqft(ent.baseline.maxFloorAreaSqft)} permitted. The existing floor area is not recorded, so the remaining floor area is not known.`
      : `Baseline: FAR ${fmtFar(ent.baseline.governingFar)}, ${fmtSqft(ent.baseline.maxFloorAreaSqft)} permitted, ${fmtSqft(ent.baseline.existingFloorAreaSqft)} existing, ${fmtSqft(ent.baseline.remainingFloorAreaSqft)} remaining.`));
    const scenarios = ent.scenarios || [];
    if (!scenarios.length) root.append(el("p", "core-note", "None found for this site."));
    else root.append(columnTable("", scenarios, (s) => s.name, [
      ["Approval", (s) => APPROVALS[s.approval] || s.approval],
      ["Added floor area", (s) => (s.addedFloorAreaSqft == null ? "Not quantified" : fmtSqft(s.addedFloorAreaSqft))],
      ["Total floor area", (s) => (s.totalFloorAreaSqft == null ? "Not quantified" : fmtSqft(s.totalFloorAreaSqft))],
      ["Resulting FAR", (s) => (s.resultingFar == null ? "Not quantified" : fmtFar(s.resultingFar))],
      ["Time to approval", (s) => (Array.isArray(s.timeMonths) ? (s.timeMonths[1] ? `${s.timeMonths[0]} to ${s.timeMonths[1]} months` : "None") : "")],
      ["Feasibility score", (s) => (s.feasibilityScore == null ? "" : `${s.feasibilityScore} of 100`)],
      ["Risk", (s) => (s.risk ? s.risk.charAt(0).toUpperCase() + s.risk.slice(1) : "")],
    ]), ...scenarios.filter((s) => s.conditions?.length).map(scenarioConditions));
    if (ent.note) root.append(el("p", "core-note", ent.note));
  }
  return root;
}

// Conditions are sentences, not figures: one disclosure per path, below the comparison table.
function scenarioConditions(s) {
  const details = el("details", "core-conditions");
  details.append(el("summary", null, `Conditions: ${s.name}`));
  const list = el("ul", "core-conditions-list");
  for (const c of s.conditions) list.append(el("li", null, String(c).replace(/\s*\u2014\s*/g, ", ").trim()));
  details.append(list);
  if (s.citations?.length) details.append(el("p", "core-note", `Sources: ${s.citations.join(", ")}`));
  return details;
}

const APPROVALS = {
  "as-of-right": "As of right",
  certification: "Certification",
  authorization: "Authorization",
  elurp: "ELURP",
  "special-permit": "Special permit",
  variance: "Variance",
  ulurp: "ULURP",
};

const signed = (n, fmt) => (n > 0 ? "+" : n < 0 ? "-" : "") + fmt(Math.abs(n));

function deltaText(deltas = {}) {
  return [
    deltas.grossFloorAreaSqft != null ? signed(deltas.grossFloorAreaSqft, fmtSqft) : "",
    deltas.far != null ? signed(deltas.far, fmtFar) + " FAR" : "",
    deltas.heightFeet != null ? signed(deltas.heightFeet, (n) => fmtNumber(n, 1)) + " ft" : "",
    deltas.storeys != null ? signed(deltas.storeys, fmtNumber) + " storeys" : "",
    deltas.units != null ? signed(deltas.units, fmtNumber) + " units" : "",
  ].filter(Boolean).join(", ");
}

function complianceText(concept) {
  const c = concept.compliance;
  if (!c) return "";
  if (c.compliant) return "Within modeled envelope";
  const n = c.violations?.length || 0;
  return n === 1 ? "1 envelope violation" : `${n} envelope violations`;
}

// Step 2's picture: the massing versions with the selected one in 3D. Shown in the step, not
// behind its details, so the viewer mounts at full size.
export function massingBlock(state, ctx) {
  const concepts = conceptsNewestFirst(stateField(state, "concepts")?.value || []);
  if (!concepts.length) return null;
  const root = el("div", "uw-massing");
  root.id = "core-massing";
  root.append(subhead("Building shape"), el("p", "uw-massing-note", "Preliminary massing based on the modeled envelope, separate from the floor plan. Review the assumptions and applicable rules."));
  const selected = concepts.find((c) => c.id === ctx.selectedConceptId) || concepts[0];
  const strip = el("ol", "core-versions");
  strip.setAttribute("aria-label", "Concept versions, newest first");
  for (const concept of concepts) {
    const item = el("li");
    const b = el("button", "core-version" + (concept.id === selected.id ? " is-selected" : ""));
    b.type = "button";
    b.dataset.concept = concept.id;
    b.setAttribute("aria-pressed", String(concept.id === selected.id));
    const parent = conceptParentName(concept, concepts);
    b.append(el("strong", "", `${concept.version ? "v" + concept.version + " " : ""}${concept.name}`));
    const meta = [parent ? `from ${parent}` : "", deltaText(concept.revision?.deltas), complianceText(concept)].filter(Boolean).join(" · ");
    if (meta) b.append(el("small", "", meta));
    item.append(b);
    strip.append(item);
  }
  root.append(strip);
  const viewer = el("div", "core-massing-view");
  viewer.setAttribute("aria-label", `3D model of ${selected.name}`);
  if (ctx.conceptViewer) viewer.append(ctx.conceptViewer(selected));
  root.append(viewer);
  if (selected.summary) root.append(el("p", "core-note", selected.summary));
  const violations = selected.compliance?.violations || [];
  if (violations.length) {
    const list = el("ul", "core-issues");
    list.setAttribute("aria-label", "Envelope violations");
    for (const v of violations) list.append(el("li", "", `${v.level}: ${v.reason}`));
    root.append(list);
  }
  const comparison = massingComparison(state);
  if (comparison) root.append(comparison);
  return root;
}

// Saved building-model versions compared in the Modeling workspace.
function massingComparison(state) {
  const concepts = conceptsNewestFirst(stateField(state, "concepts")?.value || []);
  if (concepts.length < 2) return null;
  const root = el("div", "core-block");
  root.append(subhead("Building shape versions"), conceptComparison(concepts));
  return root;
}

// 4. Usable area versus revenue
function programBlock(program) {
  const frag = el("div", "core-block");
  frag.append(subhead("Unit mix"));
  const rental = program.productType !== "condo";
  frag.append(factList([
    ["Product", rental ? "Rental" : "Condominium"],
    ["Residential gross area", fmtSqft(program.residentialGrossSqft)],
    ["Efficiency", fmtRate(program.efficiency, 0)],
    ["Net residential area", fmtSqft(program.netResidentialSqft)],
    ["Units", fmtNumber(program.units)],
    ["Average unit", fmtSqft(program.averageUnitSqft)],
    [rental ? "Gross potential rent per year" : "Gross sellout", fmtMoney(rental ? program.annualGrossPotentialRent : program.grossSellout)],
  ]));
  const rows = (program.byBedrooms || []).map((b) => [
    b.label,
    b.mixPercent != null ? `${fmtNumber(b.mixPercent)}%` : "–",
    fmtNumber(b.units),
    fmtSqft(b.unitSqft),
    fmtSqft(b.netSqft),
    rental ? (b.rentPerSqftPerMonth != null ? `$${fmtNumber(b.rentPerSqftPerMonth, 2)}` : "–") : (b.pricePerSqft != null ? `$${fmtNumber(b.pricePerSqft)}` : "–"),
    rental ? fmtDollars(b.monthlyRent) : fmtDollars(b.unitPrice),
  ]);
  if (rows.length) frag.append(table("Units by bedroom count", ["Type", "Mix", "Units", "Unit size", "Net area", rental ? "Rent per sq ft per month" : "Price per sq ft", rental ? "Monthly rent" : "Unit price"], rows));
  return frag;
}

const labelize = (key) => capitalize(key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/Sqft/i, "sq ft").toLowerCase());
const metricValue = (key, v) => (/efficiency|rate|share/i.test(key) && v <= 1 ? fmtRate(v, 0) : /sqft/i.test(key) ? fmtSqft(v) : fmtNumber(v, 2));

function proFormaBlock(pf) {
  const frag = el("div", "core-block");
  frag.append(subhead(pf.name || "Pro forma"));
  const d = pf.development || {};
  const grid = el("div", "core-columns");
  const dev = el("div");
  dev.append(el("p", "core-item-title", "Development"));
  dev.append(factList([
    ["Land", fmtMoney(d.landPrice)],
    ["Hard cost", fmtMoney(d.hardCost)],
    ["Soft cost", fmtMoney(d.softCost)],
    ["Interest carry", fmtMoney(d.interestCarry)],
    ["Total development cost", fmtMoney(d.totalDevelopmentCost)],
    ["Cost per gross sq ft", d.costPerGrossSqft != null ? `$${fmtNumber(d.costPerGrossSqft)}` : ""],
    ["Loan", fmtMoney(d.loan)],
    ["Equity", fmtMoney(d.equity)],
  ]));
  grid.append(dev);
  if (pf.operations) {
    const o = pf.operations, ops = el("div");
    ops.append(el("p", "core-item-title", "Operations"));
    ops.append(factList([
      ["Gross potential rent", fmtMoney(o.grossPotentialRent)],
      ["Vacancy", fmtMoney(o.vacancyLoss)],
      ["Operating expenses", fmtMoney(o.operatingExpenses)],
      ["Net operating income", fmtMoney(o.noi)],
      ["Yield on cost", fmtRate(o.yieldOnCost, 2)],
      ["Exit cap rate", fmtRate(o.capRate, 2)],
      ["Development spread", o.developmentSpreadBps != null ? `${fmtNumber(o.developmentSpreadBps)} bps` : ""],
    ]));
    grid.append(ops);
  }
  if (pf.sales) {
    const s = pf.sales, sales = el("div");
    sales.append(el("p", "core-item-title", "Sales"));
    sales.append(factList([
      ["Gross sellout", fmtMoney(s.grossSellout)],
      ["Selling costs", fmtMoney(s.sellingCosts)],
      ["Net sellout", fmtMoney(s.netSellout)],
      ["Units", fmtNumber(s.unitCount)],
    ]));
    grid.append(sales);
  }
  const r = pf.returns || {}, ret = el("div");
  ret.append(el("p", "core-item-title", "Returns"));
  ret.append(factList([
    ["Value", fmtMoney(r.value)],
    ["Profit", fmtMoney(r.profit)],
    ["Unlevered return on cost", fmtRate(r.unleveredReturnOnCost)],
    ["Levered return on equity", fmtRate(r.leveredReturnOnEquity)],
    ["Equity multiple", r.equityMultiple != null ? `${fmtNumber(r.equityMultiple, 2)}x` : ""],
    ["Debt service coverage", r.debtServiceCoverage != null ? `${fmtNumber(r.debtServiceCoverage, 2)}x` : ""],
    ["Cash on cash", fmtRate(r.cashOnCash)],
    ["Margin on revenue", fmtRate(r.marginOnRevenue)],
  ]));
  grid.append(ret);
  frag.append(grid);
  const sens = pf.sensitivity || {};
  const rows = ["rent", "cost", "capRateBps", "entitlement"].flatMap((k) => sens[k] || []);
  if (rows.length) {
    frag.append(table("Sensitivity", ["Scenario", "Development cost", "NOI", "Yield on cost", "Value", "Profit", "Return on cost", "Return on equity"],
      rows.map((x) => [x.scenario, fmtMoney(x.totalDevelopmentCost), fmtMoney(x.noi), fmtRate(x.yieldOnCost, 2), fmtMoney(x.value), fmtMoney(x.profit), fmtRate(x.unleveredReturnOnCost), fmtRate(x.leveredReturnOnEquity)])));
  }
  return frag;
}

function comparisonBlock(comparison) {
  const frag = el("div", "core-block");
  frag.append(subhead(comparison.rankingBasis ? "Program comparison" : "Risk-adjusted comparison"));
  const variants = comparison.variants || [];
  frag.append(columnTable("", variants, (v) => v.label, [
    [comparison.rankingBasis ? "Profit after approval carry" : "Risk-adjusted profit", (v) => fmtMoney(comparison.rankingBasis ? v.profitAfterCarry : v.riskAdjustedProfit)],
    ...(!comparison.rankingBasis ? [["Profit after entitlement carry", (v) => fmtMoney(v.profitAfterCarry)]] : []),
    ["Profit", (v) => fmtMoney(v.profit)],
    ["Value", (v) => fmtMoney(v.value)],
    [comparison.rankingBasis ? "Development cost including approval carry" : "Development cost", (v) => fmtMoney(comparison.rankingBasis ? v.totalDevelopmentCostAfterCarry : v.totalDevelopmentCost)],
    [comparison.rankingBasis ? "Return on cost before approval carry" : "Return on cost", (v) => fmtRate(v.unleveredReturnOnCost)],
    [comparison.rankingBasis ? "Return on equity before approval carry" : "Return on equity", (v) => fmtRate(v.leveredReturnOnEquity)],
    ["Approval risk", (v) => v.entitlementRiskTier],
    ["Approval time", (v) => (v.approvalTimelineMonths != null ? `${fmtNumber(v.approvalTimelineMonths)} months` : "")],
    ["Highest land price at the target return", (v) => fmtMoney(v.maxLandPrice)],
    ["Rent and price change the land price needs", (v) => (v.requiredRevenueChange != null ? `${v.requiredRevenueChange > 0 ? "+" : ""}${fmtRate(v.requiredRevenueChange)}` : "")],
    ["Profit if rents/prices fall 10%", (v) => fmtMoney(v.downsideRentMinus10Profit)],
    [comparison.rankingBasis ? "Downside profit after approval carry" : "Risk-adjusted downside profit", (v) => fmtMoney(comparison.rankingBasis ? v.downsideProfitAfterCarry : v.downsideRiskAdjustedProfit)],
    ["Joint downside profit after approval carry", (v) => fmtMoney(v.jointDownsideProfitAfterCarry)],
    ["Taxes", (v) => v.taxBasis ?? ""],
  ]));
  const rec = comparison.recommendation;
  if (rec) {
    const box = el("div", "core-recommendation");
    box.append(el("p", "core-item-title", `Recommended: ${rec.label}`));
    if (comparison.decision) box.append(el("p", "", comparison.decision.verdict));
    if (rec.whatWouldChangeIt?.length) {
      box.append(el("p", "core-note", "What would change it"));
      const list = el("ul");
      for (const item of rec.whatWouldChangeIt) list.append(el("li", "", item));
      box.append(list);
    }
    frag.append(box);
  }
  if (comparison.rubric) frag.append(el("p", "core-note", comparison.rubric));
  if (comparison.note) frag.append(el("p", "core-note", comparison.note));
  return frag;
}

// Keeping the building: the three ways to own what stands, side by side, each with the highest price that
// meets its target. Ways the analysis could not price say why instead of showing figures.
const KEEP_MEASURE = { hold: "Cap rate on all-in cost", renovate_rent: "Yield on all-in cost", renovate_sell: "Return on all-in cost" };
const CALLS = { supports_price: "Supports the price", below_price: "Below the price", no_value: "No price meets the target" };
const signedMoney = (n) => (finite(n) ? `${n > 0 ? "+" : ""}${fmtMoney(n)}` : "");
export function keepBlock(keep) {
  const frag = el("div", "core-block core-keep");
  frag.id = "core-keep";
  frag.append(subhead("Keep the building"));
  frag.append(el("p", "core-sub", `At ${fmtMoney(keep.price)}${keep.inputs?.priceBasis ? ` (${keep.inputs.priceBasis.charAt(0).toLowerCase()}${keep.inputs.priceBasis.slice(1)})` : ""}${keep.derived ? ", repriced with your numbers" : ""}.`));
  const priced = (keep.strategies || []).filter((s) => s.priced);
  // The answer first: the way that pays the most, what would change it, and where to change the numbers.
  const box = el("div", "core-recommendation");
  box.append(el("p", "core-item-title", keep.decision?.label ? `Pays the most: ${keep.decision.label}` : "No way to keep it meets its target"));
  if (keep.decision?.verdict) box.append(el("p", "", keep.decision.verdict));
  if (keep.whatWouldChangeIt?.length) {
    box.append(el("p", "core-note", "What would change it"));
    const list = el("ul");
    for (const item of keep.whatWouldChangeIt) list.append(el("li", "", item));
    box.append(list);
  }
  const change = el("button", "core-follow", "Change the price, work, rents or loan");
  change.type = "button";
  change.dataset.numbersOpen = "keep";
  box.append(change);
  frag.append(box);
  if (priced.length) {
    frag.append(columnTable("", priced, (s) => s.label, [
      ["Highest price at your target", (s) => (s.maxPrice == null ? "None" : fmtMoney(s.maxPrice))],
      ["Against the price", (s) => (s.headroom == null ? "" : signedMoney(s.headroom))],
      ["Call", (s) => CALLS[s.call] || ""],
      ["Measure at the price", (s) => `${KEEP_MEASURE[s.id]}: ${fmtRate(s.measure, 2)}, target ${fmtRate(s.target, 2)}`],
      ["All-in cost", (s) => fmtMoney(s.allIn)],
      ["Work, with contingency", (s) => (s.renovationCost ? fmtMoney(s.renovationCost) : "")],
      ["Months until it is let or sold", (s) => (finite(s.months) ? fmtNumber(s.months) : "")],
      ["Net operating income", (s) => (finite(s.noi) ? fmtMoney(s.noi) : "")],
      ["Value or sale price", (s) => fmtMoney(s.id === "renovate_sell" ? s.salePrice : s.value)],
      ["Value over cost, or profit", (s) => signedMoney(s.id === "renovate_sell" ? s.profit : s.valueCreated)],
      ["Cash flow after debt service", (s) => (finite(s.cashFlow) ? fmtMoney(s.cashFlow) : "")],
      ["Debt coverage", (s) => (finite(s.dscr) ? `${Number(s.dscr).toFixed(2)}x` : "")],
      ["Cash on cash", (s) => (finite(s.cashOnCash) ? fmtRate(s.cashOnCash) : "")],
      ["Highest price in the joint downside", (s) => (s.downside?.maxPrice == null ? "None" : fmtMoney(s.downside.maxPrice))],
    ]));
  }
  for (const s of (keep.strategies || []).filter((x) => !x.priced)) frag.append(el("p", "core-note", `${s.label}: not priced. ${s.reason}`));
  // Each way's verdict in a sentence, then the arithmetic behind it.
  const working = priced.map((s) => {
    const part = el("div", "core-keep-way");
    part.append(el("p", "", s.verdict));
    const list = el("ul", "core-keep-working");
    for (const line of s.derivation || []) list.append(el("li", "", line));
    part.append(list);
    return part;
  });
  if (working.length) frag.append(disclosure("core-keep-how", "keep-how", "How each is worked out", working));
  for (const note of keep.notes || []) frag.append(el("p", "core-note", note));
  return frag;
}

// Step 3: unit mix, market figures and pro formas behind the answer line.
function worthDetails(state) {
  const program = stateField(state, "program")?.value;
  const proFormas = stateField(state, "proFormas")?.value || [];
  const root = el("div", "uw-detail");
  root.id = "core-revenue";
  root.append(provenanceLine(state, ["program", "market", "proFormas"]));
  if (program) root.append(programBlock(program));
  if (program?.assumptions?.length) {
    root.append(subhead("Unit mix assumptions"));
    const list = el("ul");
    for (const a of program.assumptions) list.append(el("li", "", a));
    root.append(list);
  }
  const market = marketTable(state);
  if (market) root.append(market);
  for (const pf of proFormas) root.append(proFormaBlock(pf));
  return root;
}

function marketTable(state) {
  const market = stateField(state, "market")?.value;
  const figures = market ? [
    ...(market.rents || []).map((r) => [`Rent, ${BEDROOMS[r.bedrooms] ?? r.bedrooms + " bedroom"}`, `$${fmtNumber(r.rentPerSqftPerMonth, 2)} per sq ft per month`, r]),
    ...(market.salePrices || []).map((r) => [`Sale price, ${BEDROOMS[r.bedrooms] ?? r.bedrooms + " bedroom"}`, `$${fmtNumber(r.pricePerSqft)} per sq ft`, r]),
    ...(market.commercialRents || []).map((r) => [`Commercial rent, ${r.use.replaceAll("_", " ")}`, `$${fmtNumber(r.rentPerSqftPerYear, 2)} per sq ft per year`, r]),
  ] : [];
  if (!figures.length) return null;
  return table(`Market figures${market.submarket ? ", " + market.submarket : ""}`, ["Figure", "Value", "Source", "Retrieved", "Basis"],
    figures.map(([label, value, r]) => [label, value, r.source || hostname(r.url) || "–", fmtDate(r.retrievedAt) || "–", r.basis || "–"]));
}

// Step 3's inputs: the investor's own numbers, saved to the site and used by the next pro forma.
function yourNumbers(state, ctx) {
  const f = stateField(state, "assumptions");
  const root = el("div", "uw-numbers");
  root.id = "core-assumptions";
  root.append(el("p", "core-note", f
    ? `Saved by ${provenanceLabel(f.provenance) === "Your input" ? "you" : provenanceLabel(f.provenance)}${f.updated ? " on " + fmtDate(f.updated) : ""}. Blank fields use Arosa's defaults.`
    : "Blank fields use Arosa's defaults."));
  if (f?.stale) root.append(el("p", "core-stale", staleLabel(f)));
  root.append(assumptionsForm(state, ctx));
  return root;
}

// Step 4: the program comparison, keeping the building, and every open issue an offer should price in.
function decideDetails(state) {
  const root = el("div", "uw-detail");
  root.id = "core-decide";
  root.append(provenanceLine(state, ["comparisons", "keep"]));
  const latest = (stateField(state, "comparisons")?.value || []).at(-1);
  if (latest) root.append(comparisonBlock(latest));
  const keep = stateField(state, "keep")?.value;
  if (keep) root.append(keepBlock(keep));
  const issues = openIssues(state);
  if (issues.length) {
    root.append(subhead("Check before an offer"));
    const list = el("ul", "core-issues");
    for (const issue of issues) list.append(el("li", "", issue));
    root.append(list);
  }
  return root;
}

function openIssues(state) {
  const issues = [];
  for (const [key, v] of Object.entries(state.fields || {})) {
    if (v?.stale) issues.push(`${capitalize(FIELD_LABELS[key] || key)} is out of date: ${staleLabel(v).replace(/^Needs refresh: /, "")}.`);
  }
  const p = stateField(state, "property")?.value;
  if (p) for (const flag of parcelFlags(p)) issues.push(`${flag}.`);
  const env = stateField(state, "envelope")?.value;
  for (const s of (env?.lot?.streets || []).filter((s) => s.assumedNarrow)) issues.push(`${capitalize(s.side)} street${s.name ? " (" + s.name + ")" : ""}: width unknown, assumed narrow.`);
  for (const c of env?.checks || []) issues.push(typeof c === "string" ? c : c.detail || c.label);
  for (const s of (stateField(state, "entitlements")?.value?.scenarios || []).filter((s) => s.conditions?.length)) issues.push(`${s.name}: ${s.conditions.join("; ")}`);
  return issues;
}

function assumptionsForm(state, ctx) {
  const f = stateField(state, "assumptions");
  const form = el("form", "core-assumptions");
  form.id = "core-assumptions-form";
  form.noValidate = true;
  // One form for every number, so a save never drops the other group's; keeping the building has its own heading.
  const GROUPS = { keep: ["Keeping the building", "Your land price above is the purchase price. Saving reprices the keep-the-building analysis at once."] };
  let grid = null, group;
  for (const input of assumptionInputs(f?.value)) {
    if (!grid || input.group !== group) {
      group = input.group;
      const [title, note] = GROUPS[group] || [];
      if (title) form.append(subhead(title), el("p", "core-note", note));
      grid = el("div", "core-assumption-grid");
      grid.dataset.group = group || "build";
      form.append(grid);
    }
    const label = el("label", "core-field");
    label.append(el("span", "", input.label));
    const wrap = el("span", "core-input" + (input.kind === "currency" ? " is-currency" : input.kind === "percent" ? " is-percent" : ""));
    const box = el("input");
    box.name = input.path;
    box.inputMode = "decimal";
    box.autocomplete = "off";
    box.value = input.input;
    box.dataset.initial = input.input;
    box.disabled = !ctx.canEdit;
    wrap.append(box);
    label.append(wrap);
    grid.append(label);
  }
  const footer = el("div", "core-form-footer");
  const status = el("p", "core-form-status", ctx.assumptionStatus || "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const save = el("button", "core-follow", "Save my numbers");
  save.type = "submit";
  save.disabled = !ctx.canEdit;
  footer.append(status, save);
  form.append(footer);
  if (!ctx.canEdit) form.append(el("p", "core-note", "Only participants can change these numbers."));
  return form;
}


// Architecture: the saved plan revision, its walkthrough job and the inline viewer.
// Opens the floor plan page; part is the editor or the walkthrough the page opens on. Viewers can
// open an existing plan to read it but not start one.

function dots() {
  const node = el("span", "research-dots");
  node.setAttribute("aria-hidden", "true");
  node.append(el("i"), el("i"), el("i"));
  return node;
}

function runStrip(text, { running = false, failed = false } = {}) {
  const strip = el("div", "core-run" + (running ? " is-running" : "") + (failed ? " is-failed" : ""));
  const status = el("span", "core-run-status", text);
  status.setAttribute("role", "status");
  strip.append(dots(), status);
  return strip;
}

// A screen-reader status for content that is still loading behind a skeleton.
export function loadingStatus(text) {
  const node = el("p", "sr-only", text);
  node.setAttribute("role", "status");
  return node;
}

// What could not load, in one line where it would have appeared, with the way to try again.
export function failLine(text, actions = []) {
  const line = el("div", "core-fail");
  line.setAttribute("role", "status");
  line.append(el("span", "core-fail-text", publicErrorMessage({message:text,userFacing:true})), ...actions);
  return line;
}

export function retryButton(attribute, value = "") {
  const b = el("button", "core-follow", "Retry");
  b.type = "button";
  b.dataset[attribute] = value;
  return b;
}

// The floor plan page's walkthrough panel: the saved plan revision, its job and the 3D viewer.
// The editor sits beside it on that page, so the panel never links back to it.
export function renderArchitecture(state, ctx) {
  const arch = ctx.architecture;
  const view = arch.view;
  const hasPlan = view?.kind === "plan";
  const job = hasPlan ? jobStatus(view.job, view.revision) : null;
  const actions = [];
  if (hasPlan) {
    actions.push(followButton(ctx, "architecture", "review", "Review the plan"));
    const run = el("button", "core-follow primary", job.failed || job.status === "cancelled" || job.status === "succeeded" ? "Render the 3D walkthrough again" : "Render the 3D walkthrough");
    run.type = "button";
    run.dataset.architectureRun = String(view.revision);
    run.disabled = !ctx.canSend || !job.canRun || Boolean(arch.starting);
    if (!ctx.canSend) run.title = VIEWER_ONLY;
    actions.push(run);
  }
  const root = section("architecture", "3D walkthrough", state, ["architecture"], actions);
  if (arch.status === "loading") {
    const box = el("div", "core-arch-skeleton");
    box.append(loadingStatus("Loading the floor plan"), skel("skel-text", { width: "min(260px, 50%)" }), skel("skel-block", { height: "140px", marginTop: "12px" }));
    root.append(box);
    return root;
  }
  if (arch.status === "error") {
    root.append(failLine(`The floor plan did not load. ${arch.error}`, [retryButton("architectureRetry")]));
    return root;
  }
  if (ctx.pending?.field === "architecture" && !ctx.run) root.append(runStrip("Starting…", { running: true }));
  // Without a plan the panel only says so: the editor below it offers Arosa's draft.
  if (!hasPlan) {
    root.append(el("p", "core-empty", "No floor plan yet."));
    return root;
  }
  root.append(factList([
    ["Plan", view.name],
    ["Revision", `Revision ${view.revision} of ${view.revisionCount}${fmtDate(view.savedAt) ? ", saved " + fmtDate(view.savedAt) : ""}`],
    ["Levels", fmtNumber(view.levels)],
    ["Rooms", fmtNumber(view.rooms)],
    ["Net room area", fmtArea(view.netAreaM2)],
  ]));
  if (arch.summary?.revisions?.length > 1) root.append(revisionList(arch, view.revision, ctx));
  if (arch.viewing) root.append(revisionPanel(arch, view.revision, ctx));
  if (arch.starting) root.append(runStrip("Starting the walkthrough…", { running: true }));
  else if (arch.runError) root.append(runStrip(`The walkthrough did not start. ${arch.runError}`, { failed: true }));
  else root.append(runStrip(job.text, job));
  if (view.preview) {
    const figure = el("figure", "core-arch-preview");
    const img = el("img", "core-arch-preview-img");
    img.src = view.preview.url;
    img.alt = `Rendered preview of ${view.name}, revision ${view.revision}`;
    img.loading = "lazy";
    figure.append(img, el("figcaption", "", `Preview of revision ${view.revision}. Schematic, not a construction document.`));
    root.append(figure);
  }
  if (view.viewer && ctx.architectureViewer) {
    const box = el("div", "core-arch-view");
    box.setAttribute("aria-label", `Walkthrough of ${view.name}`);
    box.append(ctx.architectureViewer(view));
    root.append(box);
  } else if (job.status === "succeeded") {
    root.append(el("p", "core-empty", "The last render produced no 3D model."));
  }
  if (view.downloads?.length) {
    const files = el("div", "core-arch-downloads");
    files.append(el("span", "core-arch-downloads-label", "Files"));
    for (const file of view.downloads) {
      const link = el("a", "", file.label);
      link.href = file.url;
      link.setAttribute("download", "");
      files.append(link);
    }
    root.append(files);
  }
  return root;
}

// Every saved revision, newest first: any earlier one opens read only and can come back as the
// next revision (its document saved again on top of the current one, so nothing is overwritten).
function revisionButton(label, attribute, revision, disabled = false) {
  const b = el("button", "core-follow", label);
  b.type = "button";
  b.dataset[attribute] = String(revision);
  b.disabled = disabled;
  return b;
}
function restoreButton(arch, revision, ctx) {
  const b = revisionButton(arch.restoring === revision ? "Restoring…" : "Restore as new revision", "revisionRestore", revision, !ctx.canSend || arch.restoring != null);
  if (!ctx.canSend) b.title = VIEWER_ONLY;
  return b;
}
function revisionList(arch, current, ctx) {
  const box = el("details", "core-revisions");
  box.open = Boolean(arch.viewing);
  box.append(el("summary", "", `Saved revisions (${arch.summary.revisions.length})`));
  const list = el("ol", "core-revision-list");
  for (const r of arch.summary.revisions) {
    const item = el("li", "core-revision" + (r.revision === current ? " is-current" : ""));
    item.append(el("span", "core-revision-name", `Revision ${r.revision}${r.revision === current ? " (current)" : ""}${fmtDate(r.createdAt) ? `, saved ${fmtDate(r.createdAt)}` : ""}`));
    if (r.revision !== current) item.append(revisionButton("View", "revisionOpen", r.revision), restoreButton(arch, r.revision, ctx));
    list.append(item);
  }
  box.append(list);
  if (arch.restoreError) box.append(failLine(`The revision was not restored. ${arch.restoreError}`));
  return box;
}
function revisionPanel(arch, current, ctx) {
  const { revision, status, view, error } = arch.viewing;
  const box = el("div", "core-revision-view");
  box.setAttribute("aria-label", `Revision ${revision}, read only`);
  const head = el("div", "core-revision-head");
  head.append(el("strong", "", `Revision ${revision}, read only`), revisionButton(`Back to revision ${current}`, "revisionClose", revision));
  box.append(head);
  if (status === "loading") box.append(loadingStatus(`Loading revision ${revision}`), skel("skel-text", { width: "min(260px, 50%)" }));
  else if (status === "error") box.append(failLine(`Revision ${revision} did not load. ${error}`, [revisionButton("Retry", "revisionOpen", revision)]));
  else {
    box.append(factList([
      ["Plan", view.name],
      ["Saved", fmtDate(view.savedAt)],
      ["Levels", fmtNumber(view.levels)],
      ["Rooms", fmtNumber(view.rooms)],
      ["Net room area", fmtArea(view.netAreaM2)],
    ]));
    if (view.preview) {
      const img = el("img", "core-arch-preview-img");
      img.src = view.preview.url;
      img.alt = `Rendered preview of ${view.name}, revision ${revision}`;
      img.loading = "lazy";
      box.append(img);
    }
    box.append(restoreButton(arch, revision, ctx));
  }
  return box;
}

const BEDROOMS = { 0: "studio", 1: "1 bedroom", 2: "2 bedroom", 3: "3 bedroom" };

// The site's sources, counted once by URL; the footer is left out until Arosa cites one.
// Trade-press stories that name this lot or another lot on its block.
function newsSection(stories) {
  const root = el("section", "core-section core-news");
  root.id = "core-news";
  root.setAttribute("aria-labelledby", "core-news-title");
  const h = el("h2", "", "In the news");
  h.id = "core-news-title";
  root.append(h, newsList(stories, "core-news-list"));
  return root;
}

function sourcesFooter(state) {
  const sources = collectSources(state);
  if (!sources.length) return null;
  const root = el("details", "uw-sources");
  root.id = "core-sources";
  root.dataset.disclosure = "sources";
  root.append(el("summary", "", `Sources (${sources.length})`));
  const list = el("div", "core-sources");
  sources.forEach((s, i) => {
    const b = el("button", "source-card");
    b.type = "button";
    b.dataset.stateSource = String(i);
    const text = el("div");
    text.append(el("strong", "", s.title || hostname(s.url)));
    text.append(el("small", "", [hostname(s.url), fmtDate(s.retrievedAt) ? "retrieved " + fmtDate(s.retrievedAt) : "", "used for " + s.fields.map((k) => FIELD_LABELS[k] || k).join(", ")].filter(Boolean).join(" · ")));
    b.append(text, el("span", "", "↗"));
    list.append(b);
  });
  root.append(list);
  root.append(helpLink("sources-and-freshness"));
  root.append(el("p", "sample-note", "Source coverage varies. Reported zoning and floor area do not establish a legal development entitlement."));
  return root;
}

// The site page: a header, the figures an investor reads first, one next action, then the four
// steps. ctx.run is the site conversation's live run ({label, tools}) or null.
function siteHeader(state, ctx = {}) {
  const p = stateField(state, "property")?.value;
  const root = el("header", "uw-header");
  const back = el("a", "core-back", "All sites");
  back.href = "/sites";
  back.dataset.route = "/sites";
  const crumbs=el('nav','page-breadcrumbs');crumbs.setAttribute('aria-label','Breadcrumb');
  const current=el('span','',siteName(state));current.setAttribute('aria-current','page');crumbs.append(back,document.createTextNode(' / '),current);root.append(crumbs);
  // Copying the site's own address grants nothing: the page still opens only for accounts
  // with access through a conversation grant (everyone else gets the not-available page).
  // Inviting people stays in the conversation's Share dialog.
  // The underwriting deck of the site's conversation opens in a new tab, to print or save as PDF.
  if (ctx.onCopySiteLink || ctx.onExportDeck) {
    const row = el("div", "uw-share");
    if (ctx.onCopySiteLink) {
      const copy = el("button", "core-follow", "Copy link");
      copy.type = "button";
      const status = el("span", "uw-share-status");
      status.setAttribute("role", "status");
      copy.addEventListener("click", async () => {
        try { await ctx.onCopySiteLink(state.id); status.textContent = "Link copied. People with access can open it."; }
        catch { status.textContent = "Could not copy. Copy the address from the address bar."; }
      });
      row.append(copy, status);
    }
    const report=el('a','core-follow','Report');report.href=report.dataset.route='/sites/'+encodeURIComponent(state.id)+'/report';row.insertBefore(report,row.querySelector('.uw-share-status'));
    if (ctx.onExportDeck) {
      const deck = el("button", "core-follow", "Underwriting package");
      deck.type = "button";
      deck.addEventListener("click", ctx.onExportDeck);
      row.insertBefore(deck, row.querySelector(".uw-share-status"));
    }
    root.append(row);
  }
  const d = p ? districtSummary(p) : null;
  const where = p ? [p.borough, p.bbl ? `BBL ${p.bbl}` : "", d.zoning].filter(Boolean).join(" · ") : "";
  if (where) root.append(el("p", "uw-where", where));
  root.append(el("h1", "core-title", siteName(state)));
  const verdict = answerLine(state, ctx.steps || [], ctx.schemes);
  if (verdict) root.append(el("p", "uw-verdict", verdict));
  return root;
}

// Once the four steps have results, the header answers the page in one line: what the zoning lets
// you build, then the land value (landAnswer: what nearby development sites sold for where enough did,
// with what a developer could pay at the account's costs), set against the ask when there is one. The
// options are read again when the site's assumptions change, so the line follows them.
export function answerLine(state, steps, schemes) {
  const { buildableSqft } = snapshot(state);
  if (!steps.length || !steps.every((s) => s.done) || buildableSqft == null || !schemes?.schemes) return null;
  return `You can build ${fmtSqft(buildableSqft)}. ${landAnswer(schemes)}`;
}

// The deal card. Once the options are priced it reads the leading option at today's figures, so the
// card, the header line and the options give one answer; before that, the run's pro forma.
function snapshotStrip(state, schemes) {
  const s = snapshot(state, schemes);
  const dl = el("dl", "uw-snapshot");
  dl.setAttribute("aria-label", "Deal snapshot");
  const cell = (label, value, note, pending, help = null, extra = null) => {
    const row = el("div", value == null ? "is-pending" : "");
    const dt = el("dt", "", label);
    if (help) dt.append(helpLink(help, { icon: true }));
    row.append(dt, el("dd", "", value ?? pending));
    if (value != null && note) {
      // Long pro forma names wrap to two lines at most; the full name stays in the title.
      const small = el("dd", "uw-snapshot-note", note);
      small.title = note;
      row.append(small);
    }
    if (value != null && extra) row.append(extra);
    dl.append(row);
  };
  cell("Land price", s.landPrice == null ? null : fmtMoney(s.landPrice), null, "Not set");
  cell("Buildable floor area", s.buildableSqft == null ? null : fmtSqft(s.buildableSqft), s.maxFar == null ? null : `FAR ${fmtFar(s.maxFar)}`, "After step 2", "buildable-area");
  if (s.priced) {
    // Where nearby development-site sales lead, the land value is what they sold for and the residual is
    // what a developer could pay; otherwise the residual is the land value. The store's deal tier sits
    // with the figure that set it, says how, and links the article that explains it.
    const basis = s.tierBasis?.basis === "nearby" && s.nearby ? "nearby" : "residual";
    const tier = s.tier ? el("dd", "uw-snapshot-note uw-snapshot-tier", `Deal tier: ${s.tier}${s.tierBasis && s.tier !== "Unpriced" ? ` · ${tierBasisPhrase(s.tierBasis, { short: true })}` : ""}`) : null;
    if (tier) tier.append(helpLink("deal-tiers", { icon: true }));
    const n = s.nearby;
    if (n) cell("Land value", fmtMoney(n.value), `${fmtNumber(n.sales)} nearby sales, adjusted to this lot`, null, "land-value", basis === "nearby" ? tier : null);
    cell(n ? "A developer can pay" : "Land value", s.landValue > 0 ? fmtMoney(s.landValue) : "None",
      s.landValue > 0 ? `${n ? "At" : "What a developer can pay at"} your costs · ${s.leadLabel}` : "No option pays for the land at your costs", null, n ? null : "land-value", basis === "residual" ? tier : null);
    if (!n) cell("Profit", s.profit == null ? null : fmtMoney(s.profit), s.margin ? `${fmtRate(s.margin.pct / 100)} ${s.margin.label}${s.landPrice == null ? "" : " at the price"}` : null, "After step 3");
  } else {
    cell("Value when built", s.value == null ? null : fmtMoney(s.value), s.proFormaName, "After step 3");
    cell("Profit", s.profit == null ? null : fmtMoney(s.profit), s.returnOnCost == null ? null : `${fmtRate(s.returnOnCost)} return on cost`, "After step 3");
  }
  return dl;
}

function openChatButton(label, primary = false) {
  const b = el("button", "core-follow" + (primary ? " primary" : ""), label);
  b.type = "button";
  b.dataset.openChat = "";
  return b;
}

// The page's one primary action and the line that says why, or the status of the work under way.
function nextAction(steps, ctx) {
  const root = el("div", "uw-next");
  const text = el("p", "uw-next-text");
  text.setAttribute("role", "status");
  text.setAttribute("aria-live", "polite");
  root.append(text);
  const busy = (line) => {
    root.classList.add("is-running");
    text.append(dots(), el("span", "", line));
  };
  // Earlier steps the run has worked through also read as running; the line names the one it is on.
  const running = steps.findLastIndex((s) => s.status === "running");
  const starting = steps.findIndex((s) => s.status === "starting");
  const done = steps.filter((s) => s.done && !s.stale).length;
  const stale = steps.filter((s) => s.stale).length;
  const skipped = steps.findIndex((s, i) => !s.done && steps.slice(i + 1).some((later) => later.done));
  if (ctx.starting) {
    // The site is not resolved yet: the page says so where the parcel record will appear.
    if (ctx.starting.failed) {
      root.classList.add("is-failed");
      text.textContent = `Arosa could not identify a parcel for ${ctx.starting.label}.`;
      root.append(openChatButton("Open the conversation"));
    } else {
      busy(`Identifying the parcel for ${ctx.starting.label}…`);
      root.append(openChatButton("Watch in chat"));
    }
  } else if (running >= 0) {
    busy(`Step ${running + 1} of 4 · ${ctx.run.label || "Researching"}`);
    root.append(openChatButton("Watch in chat"));
  } else if (ctx.pending && ctx.pending.field !== "architecture") {
    // The click is acknowledged here at once; the run's own progress replaces this when it reports.
    busy(starting >= 0 ? `Step ${starting + 1} of 4 · Starting…` : "Starting…");
    const b = followButton(ctx, "all", "all", "Starting…", true);
    b.disabled = true;
    b.setAttribute("aria-busy", "true");
    root.append(b);
  } else if (ctx.runFailure && ctx.canSend) {
    // The last request failed: say so here, where the click was, and offer the same action again.
    root.classList.add("is-failed");
    text.textContent = `The last request did not finish. ${ctx.runFailure.message}`;
    root.append(followButton(ctx, "all", "all", done ? "Try the update again" : "Try again", true));
  } else if (!ctx.canSend) {
    text.textContent = done ? `${done} of 4 steps done. You can read this site; only its participants can ask Arosa to update it.` : "You can read this site; only its participants can ask Arosa to underwrite it.";
  } else if (done === 0 && stale === 0) {
    text.textContent = "Confirms the parcel, sizes the zoning, prices the building and tests the land price.";
    root.append(followButton(ctx, "all", "all", "Underwrite this site", true));
  } else if (skipped >= 0) {
    // A run that finished later steps without this one: the page names it and offers it first.
    const step = steps[skipped];
    text.textContent = `${done} of 4 steps done. Step ${skipped + 1}, ${step.title}, ${step.status === "partial" ? "was left unfinished" : "was skipped"}, so the steps after it rest on figures it did not save.`;
    root.append(followButton(ctx, STEP_MENU[step.id].field, "compute", `Run step ${skipped + 1}`, true), followButton(ctx, "all", "all", "Finish the underwriting"));
  } else if (done < 4) {
    text.textContent = `${done} of 4 steps done.${stale ? ` ${stale === 1 ? "One step needs" : `${stale} steps need`} a refresh because an earlier result changed.` : ""}`;
    root.append(followButton(ctx, "all", "all", done + stale === 4 ? "Update the underwriting" : "Finish the underwriting", true));
  } else {
    const when = fmtDate(Math.max(...steps.map((s) => s.updated || 0)));
    // The finished underwriting reads as one report; asking and regenerating stay beside it. When land
    // values differ from the run's, regenerating comes first so its steps are worked again on today's figures.
    const report = el("a", "core-follow" + (ctx.differs ? "" : " primary"), "Open the full report");
    report.href = `/sites/${encodeURIComponent(ctx.siteId)}/report`;
    report.dataset.route = report.getAttribute("href");
    const regenerate = followButton(ctx, "all", "regenerate", "Regenerate", Boolean(ctx.differs));
    if (ctx.differs) {
      text.textContent = `Underwritten${when ? " " + when : ""}. Steps 3 and 4 show that run's own comparison, which values the land differently from the options above. Regenerate to work them again on today's figures.`;
      root.append(regenerate, report, openChatButton("Ask about this site"));
    } else {
      text.textContent = `Underwritten${when ? " " + when : ""}. The full report has every figure, assumption and source.`;
      root.append(report, openChatButton("Ask about this site"), regenerate);
    }
  }
  return root;
}

const PROMISES = {
  property: "The parcel record: zoning, lot, existing building and flags.",
  build: "The floor area the zoning allows and ways to add capacity.",
  worth: "Unit mix, comparable rents or prices and a pro forma on your numbers.",
  decide: "Whether to build new or keep the building, what each pays, and what would change the answer.",
};

const STATUS_TEXT = { running: "Working", starting: "Starting", queued: "Up next", stale: "Needs a refresh", partial: "Incomplete", todo: "Not started" };

function answer(step, state) {
  const v = (k) => stateField(state, k)?.value;
  if (step.id === "property") {
    const p = v("property");
    return [districtSummary(p).zoning || "Zoning not reported", Number(p.lotarea) > 0 ? `${fmtSqft(p.lotarea)} lot` : "", existingBuilding(p) || "no building reported"].filter(Boolean).join(" · ");
  }
  if (step.id === "build") {
    const env = v("envelope");
    const m = env.metrics || {};
    const shape = m.storeys != null && m.heightFeet != null ? `, about ${fmtNumber(m.storeys)} storeys and ${fmtNumber(m.heightFeet)} ft` : "";
    const best = (v("entitlements")?.scenarios || [])
      .filter((s) => Number(s.addedFloorAreaSqft) > 0)
      .sort((a, b) => b.addedFloorAreaSqft - a.addedFloorAreaSqft)[0];
    return `Up to ${fmtSqft(env.floorArea?.maxFloorAreaSqft)} of floor area at FAR ${fmtFar(env.floorArea?.maxFar)}${shape}.`
      + (best ? ` The most added floor area comes from ${best.name}: ${fmtSqft(best.addedFloorAreaSqft)}, ${(APPROVALS[best.approval] || best.approval).toLowerCase()}.` : "");
  }
  if (step.id === "worth") {
    const pf = v("proFormas").at(-1);
    const units = v("program")?.units;
    return `${units ? `${fmtNumber(units)} units. ` : ""}${pf.name || "Pro forma"}: ${fmtMoney(pf.returns?.value)} value on ${fmtMoney(pf.development?.totalDevelopmentCost)} total cost, ${fmtRate(pf.returns?.unleveredReturnOnCost)} return on cost.`;
  }
  // Building new answers first when it was compared; keeping the building follows, or answers alone.
  const c = (v("comparisons") || []).at(-1);
  const rec = c?.recommendation;
  const pick = rec && (c.variants || []).find((x) => x.label === rec.label);
  const profit = pick ? (c.rankingBasis ? pick.profitAfterCarry : pick.riskAdjustedProfit) : null;
  const keep = v("keep")?.decision;
  const issues = openIssues(state).length;
  return [
    c ? (c.decision ? c.decision.verdict : rec ? `Pursue ${rec.label}.` : "Programs compared; none is recommended.") : "",
    profit != null ? `${fmtMoney(profit)} profit after approval risk${pick.downsideRentMinus10Profit != null ? `, ${fmtMoney(pick.downsideRentMinus10Profit)} if rents fall 10%` : ""}.` : "",
    keep ? keep.verdict : "",
    issues ? `${issues === 1 ? "One item" : `${issues} items`} to check before an offer.` : "",
  ].filter(Boolean).join(" ");
}

function disclosure(className, key, summary, body, open = false) {
  const d = el("details", className);
  d.dataset.disclosure = key;
  d.open = open;
  d.append(el("summary", "", summary), ...body);
  return d;
}

const notesCount = (step, state) => {
  const saved = stateField(state, "instructions")?.value || {};
  return (STEP_NOTES[step.id] || []).filter((id) => String(saved[id] || "").trim()).length;
};

// A step's notes for Arosa: shown when saved, otherwise opened from the step's More menu. The boxes
// stay in the page while hidden, so every save and run carries every section's notes.
function notesFor(step, state, ctx) {
  const ids = STEP_NOTES[step.id];
  if (!ids) return null;
  const count = notesCount(step, state);
  const d = disclosure("uw-notes", `notes-${step.id}`, count ? `Your notes for Arosa (${count})` : "Notes for Arosa", ids.map((id) => instructionBox(state, ctx, id)), count > 0);
  d.hidden = count === 0;
  return d;
}

// One More menu per step: each item names what it does in a short line.
export function moreMenu(label, items) {
  const more = el("details", "listings-pop uw-menu");
  const summary = el("summary", "", "More");
  summary.setAttribute("aria-label", label);
  const menu = el("div", "listings-pop-body uw-menu-body");
  menu.dataset.menuLabel = label;
  for (const [control, what] of items) {
    const row = el("div", "uw-menu-item");
    row.append(control, el("span", "uw-menu-what", what));
    menu.append(row);
  }
  more.append(summary, menu);
  return more;
}

const STEP_MENU = {
  build: { field: "envelope", redo: "Recompute the zoning envelope and the ways to add floor area.", explain: ["Explain the zoning", "How the envelope was worked out and what would change it, in the chat."] },
  worth: { field: "proFormas", redo: "Recompute the unit mix, market figures and pro forma with your numbers." },
  decide: { field: "comparisons", redo: "Compare the programs again with the latest figures." },
};

function stepMenu(step, state, ctx) {
  if (!ctx.canSend) return null;
  const items = [];
  const cfg = STEP_MENU[step.id];
  const has = step.done || step.stale;
  const busy = step.status === "running" || step.status === "starting";
  // Should you buy it can be answered by keeping the building alone; its redo compares building new.
  const redoable = step.id !== "decide" || Boolean(stateField(state, "comparisons"));
  if (cfg && redoable && (has || step.status === "partial") && !busy) {
    items.push([followButton(ctx, cfg.field, "recompute", has ? "Redo this step" : "Finish this step"), cfg.redo]);
    if (cfg.explain && has) items.push([followButton(ctx, cfg.field, "explain", cfg.explain[0]), cfg.explain[1]]);
  }
  // Keeping the building is priced on its own request, once the site has a parcel to read the building from.
  if (step.id === "decide" && stateField(state, "property") && !busy) {
    const kept = Boolean(stateField(state, "keep"));
    items.push([followButton(ctx, "keep", "keep", kept ? "Reprice keeping the building" : "Price keeping the building"), "Hold it as is, renovate and rent it, or renovate and sell it, against the price."]);
  }
  if (STEP_NOTES[step.id]) {
    const count = notesCount(step, state);
    const b = el("button", "core-follow", count ? `Edit your notes (${count})` : "Add a note for Arosa");
    b.type = "button";
    b.dataset.notesOpen = step.id;
    items.push([b, "Instructions Arosa follows the next time it works on this step."]);
  }
  return items.length ? moreMenu(`More for ${step.title.toLowerCase()}`, items) : null;
}

// A running step shows what the run has found for it so far. The step the run is working on also
// shows what it is doing now, its latest reasoning headline, the sources it has read and how long
// runs like it usually take; an earlier step it has already worked through says when it is saved.
function runTrail(step, ctx) {
  const run = ctx.run;
  const trail = run.trail || [];
  const root = el("div", "uw-trail");
  const stepOf = (item) => toolStep(item.tool === "acres_execute_capability" ? item.arguments?.name : item.tool);
  const active = step.id === ctx.activeStepId;
  const found = trail.filter((item) => item.finding && stepOf(item) === step.id).slice(-4);
  if (active) root.append(runStrip(run.label || "Researching", { running: true }));
  if (found.length) {
    const list = el("ul", "uw-trail-found");
    list.setAttribute("aria-label", `Found so far for ${step.title.toLowerCase()}`);
    for (const item of found) {
      const li = el("li");
      li.append(el("span", "uw-trail-did", describeStep(item.tool, item.arguments, "complete")), el("span", "uw-trail-figure", item.finding));
      list.append(li);
    }
    root.append(list);
  }
  if (!active) {
    root.append(el("p", "uw-trail-note", found.length ? "Saved to the site when the underwriting finishes." : "Worked through; saved to the site when the underwriting finishes."));
    return root;
  }
  if (run.queued) {
    root.append(el("p", "uw-trail-note", "Other underwritings are using every research slot. This one starts on its own when one frees up, and keeps going if you leave this page."));
    return root;
  }
  const thought = [...trail].reverse().find((item) => item.thought)?.text;
  if (thought) root.append(el("p", "uw-trail-thought", thought));
  const sources = sourcesFound(trail);
  if (sources.length) {
    const names = sources.slice(-3).reverse().map((s) => s.title).join("; ");
    root.append(el("p", "uw-trail-sources", `${sources.length} ${sources.length === 1 ? "source" : "sources"} read so far, latest: ${names}`));
  }
  if (run.startedAt) {
    const time = el("p", "uw-trail-time", timeLine(Date.now() - run.startedAt, run.typicalMs));
    time.dataset.startedAt = String(run.startedAt);
    if (finite(run.typicalMs)) time.dataset.typicalMs = String(run.typicalMs);
    root.append(time);
  }
  root.append(el("p", "uw-trail-note", "You can leave this page: the underwriting keeps going, and Activity in the menu shows when it is done."));
  return root;
}

// Which step a pending request will start in: a full run starts at the first unfinished step.
const FIELD_STEP = { property: "property", envelope: "build", entitlements: "build", concepts: "build", program: "worth", market: "worth", proFormas: "worth", comparisons: "decide", keep: "decide" };

// The steps with the page's own request applied: before its run reports, the asked step reads
// "starting"; once the run reports, it shows in that step until its tools say otherwise.
function siteSteps(state, ctx) {
  // A floor plan request works past the four steps, which read as they stand.
  if (ctx.pending?.field === "architecture") return stepView(state);
  const asked = ctx.pending && ctx.pending.action !== "all" ? FIELD_STEP[ctx.pending.field] || null : null;
  const steps = stepView(state, ctx.run || null, asked);
  if (!ctx.pending || ctx.run) return steps;
  const id = asked || (steps.find((s) => !s.done || s.stale) || steps[0]).id;
  return steps.map((s) => (s.id === id ? { ...s, status: "starting" } : s));
}

function stepItem(step, index, state, ctx) {
  const li = el("li", `uw-step is-${step.status}`);
  li.id = step.id === "property" ? "core-property" : `core-step-${step.id}`;
  li.setAttribute("aria-labelledby", `${li.id}-title`);
  const marker = el("span", "uw-marker", step.status === "done" ? "" : String(index + 1));
  marker.setAttribute("aria-hidden", "true");
  const body = el("div", "uw-body");
  const head = el("header", "uw-step-head");
  const title = el("h2", "", step.title);
  title.id = `${li.id}-title`;
  const when = step.status === "done" ? ["Done", fmtDate(step.updated)].filter(Boolean).join(" · ") : STATUS_TEXT[step.status];
  const side = el("div", "uw-step-side");
  side.append(el("span", "uw-status", when));
  const menu = stepMenu(step, state, ctx);
  if (menu) side.append(menu);
  head.append(title, side);
  body.append(head);
  const has = step.done || step.stale;
  if (step.status === "running") body.append(runTrail(step, ctx));
  if (step.status === "starting") body.append(runStrip("Starting…", { running: true }));
  if (has) body.append(el("p", "uw-answer", answer(step, state)));
  if (has && step.id === "decide" && ctx.differs) body.append(el("p", "uw-answer-note", `${ctx.differs.maxLandPrice > 0 ? `This run's comparison put the land at up to ${fmtMoney(ctx.differs.maxLandPrice)}.` : "This run's comparison found no land value."} The options below are priced today at your deal settings.`));
  else if (step.status !== "running" && step.status !== "starting") body.append(el("p", "uw-promise", PROMISES[step.id]));
  if (step.id === "property" && has) body.append(flagList(stateField(state, "property").value));
  const details = {
    property: () => step.done && propertyDetails(state),
    build: () => (stateField(state, "envelope") || stateField(state, "entitlements")) && envelopeDetails(state),
    worth: () => (stateField(state, "program") || stateField(state, "proFormas") || stateField(state, "market")) && worthDetails(state),
    decide: () => (stateField(state, "comparisons") || stateField(state, "keep") || openIssues(state).length) && decideDetails(state),
  }[step.id]();
  const foot = el("div", "uw-step-foot");
  if (details) foot.append(disclosure("uw-more", `more-${step.id}`, "Show the details", [details]));
  if (step.id === "worth") {
    const land = stateField(state, "assumptions")?.value?.landPrice;
    foot.append(disclosure("uw-numbers-toggle", "numbers", finite(land) ? `Your numbers · land ${fmtMoney(land)}` : "Set your numbers", [yourNumbers(state, ctx)]));
  }
  const notes = notesFor(step, state, ctx);
  if (notes) foot.append(notes);
  if (foot.childNodes.length) body.append(foot);
  li.append(marker, body);
  return li;
}

// The site page's shape while its state loads: header, snapshot, next action and the four steps.
export function siteSkeleton() {
  const root = el("div", "core-parcel uw uw-skeleton");
  root.append(loadingStatus("Loading the site"));
  const head = el("div", "uw-header");
  head.append(skel("skel-text", { width: "64px" }), skel("skel-text", { width: "min(220px, 50%)", marginTop: "8px" }), skel("skel-title", { width: "min(380px, 75%)", height: "30px" }));
  const snap = el("div", "uw-snapshot");
  for (let i = 0; i < 4; i++) {
    const cell = el("div");
    cell.append(skel("skel-text", { width: "60%", height: "11px" }), skel("skel-title", { width: "75%", marginTop: "8px" }));
    snap.append(cell);
  }
  const next = el("div", "uw-next");
  next.append(skel("skel-text", { width: "min(340px, 60%)" }), skel("skel-button", { width: "190px" }));
  const steps = el("div", "uw-steps");
  for (let i = 0; i < 4; i++) {
    const step = el("div", "uw-step");
    const body = el("div", "uw-body");
    body.append(skel("skel-title", { width: `${34 + (i % 2) * 10}%`, height: "20px" }), skel("skel-text", { width: "82%", marginTop: "10px" }));
    step.append(skel("uw-marker"), body);
    steps.append(step);
  }
  root.append(head, snap, next, steps);
  return root;
}

// What the last full underwriting left in each section, and what a full pass never covers.
const CHECKLIST_STATUS = { produced: "Produced in this run", kept: "Kept, still current", stale: "Needs a refresh", missing: "Not produced" };
function checklistBlock(checklist) {
  const box = el("section", "core-checklist");
  box.setAttribute("aria-label", "Last full underwriting");
  box.append(el("p", "core-item-title", "Last full underwriting"));
  const list = el("ul");
  for (const item of checklist.items) {
    const row = el("li", `is-${item.status}`);
    row.dataset.section = item.id;
    row.append(el("span", "", `${item.label}: `), el("strong", "", CHECKLIST_STATUS[item.status]));
    list.append(row);
  }
  box.append(list);
  for (const note of checklist.exclusions) box.append(el("p", "core-note", note));
  return box;
}

export function renderParcel(state, ctx = {}) {
  const steps = siteSteps(state, ctx);
  const root = el("article", "core-parcel uw");
  root.dataset.projectId = state.id;
  // The schemes read while it loads stands back for the options the state last saved.
  const priced = ctx.schemes?.schemes ? ctx.schemes : undefined;
  const differs = decisionDiffers(state, priced);
  root.append(siteHeader(state, { ...ctx, steps }));
  if (ctx.canEdit === false) {const notice=el('p','site-viewer-notice','View only. Ask the site owner for access to update this site.');notice.setAttribute('role','status');root.append(notice);}
  root.append(snapshotStrip(state, priced), nextAction(steps, { ...ctx, siteId: state.id, differs }));
  if (ctx.checklist) root.append(checklistBlock(ctx.checklist));
  const list = el("ol", "uw-steps");
  list.setAttribute("aria-label", "Underwriting steps");
  // The furthest running step is the one the run is working on now.
  const activeStepId = steps.findLast((s) => s.status === "running")?.id ?? null;
  steps.forEach((step, i) => list.append(stepItem(step, i, state, { ...ctx, activeStepId, differs })));
  root.append(list);
  const schemes = renderSchemes(ctx.schemes, { projectId: state.id, canSend: ctx.canSend, busy: Boolean(ctx.run || ctx.pending) });
  if (schemes) root.append(schemes);
  if (ctx.news?.stories?.length) root.append(newsSection(ctx.news.stories));
  // What is being built around the site; undefined where the site has no parcel located yet.
  if (ctx.nearbyPipeline !== undefined) root.append(renderNearbyPipeline(ctx.nearbyPipeline));
  const sources = sourcesFooter(state);
  if (sources) root.append(sources);
  return root;
}

export function stateSources(state) {
  return collectSources(state);
}
