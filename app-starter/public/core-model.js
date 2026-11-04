// Pure helpers for the Core page: they read the project state contract
// ({fields: {key: {value, provenance, stale, updated}}}) and never invent figures.

export const FIELD_LABELS = {
  property: "parcel record",
  places: "nearby places",
  envelope: "zoning envelope",
  concepts: "massing",
  program: "unit mix",
  market: "market inputs",
  proFormas: "pro forma",
  entitlements: "entitlement scenarios",
  comparisons: "program comparison",
  keep: "keep-the-building analysis",
  plans: "floor plans",
  assembly: "site assembly",
  publicRecords: "public records",
  floorplanAudits: "floor plan audits",
  assumptions: "underwriting assumptions",
  architecture: "architecture plan",
};

const TOOL_LABELS = {
  acres_set_subject: "parcel lookup",
  acres_nearby_places: "nearby places",
  acres_zoning_envelope: "zoning envelope",
  acres_model_concept: "massing model",
  acres_unit_mix: "unit mix",
  acres_market_inputs: "market research",
  acres_market_comps: "market comparables",
  acres_pro_forma: "pro forma",
  acres_entitlement_scenarios: "entitlement analysis",
  acres_compare_programs: "program comparison",
  acres_keep_building: "keep-the-building analysis",
  acres_plan_concept: "floor planning",
  acres_assemble_site: "site assembly",
  acres_nyc_public_records: "public records",
  acres_audit_floorplan: "floor plan audit",
};

export function stateField(state, key) {
  return state?.fields?.[key] || null;
}

export function provenanceLabel(provenance) {
  if (provenance?.tool === "user") return "Your input";
  const tool = TOOL_LABELS[provenance?.tool];
  return tool ? `Arosa ${tool}` : "Arosa";
}

export function staleLabel(field) {
  if (!field?.stale) return null;
  return `Needs refresh: the ${FIELD_LABELS[field.stale] || field.stale} changed`;
}

export const finite = (n) => typeof n === "number"
  ? Number.isFinite(n)
  : typeof n === "string" && n.trim() !== "" && Number.isFinite(Number(n));
export const fmtNumber = (n, digits = 0) =>
  finite(n) ? Number(n).toLocaleString("en-US", { maximumFractionDigits: digits }) : "–";
export const fmtSqft = (n) => (finite(n) ? `${fmtNumber(n)} sq ft` : "–");
// Deal-level totals (land, cost, value, profit) read in millions from $100,000 up, so figures that
// sit side by side share one precision; smaller totals keep whole dollars.
export const fmtMoney = (n) => {
  if (!finite(n)) return "–";
  const v = Number(n), sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 100_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${fmtNumber(abs)}`;
};
// Per-unit prices and rents keep whole dollars.
export const fmtDollars = (n) => (finite(n) ? `${Number(n) < 0 ? "-" : ""}$${fmtNumber(Math.abs(Number(n)))}` : "–");
export const fmtRate = (n, digits = 1) => (finite(n) ? `${(Number(n) * 100).toFixed(digits)}%` : "–");
export const fmtFar = (n) => (finite(n) ? fmtNumber(n, 2) : "–");

export function parcelFlags(p) {
  if (!p) return [];
  const text = (v) => (typeof v === "string" ? v.trim() : v ? String(v) : "");
  const flags = [];
  if (text(p.landmark)) flags.push(`Landmark: ${text(p.landmark)}`);
  if (text(p.histdist)) flags.push(`Historic district: ${text(p.histdist)}`);
  if (text(p.splitzone).toUpperCase() === "Y") flags.push("Split zoning lot");
  if (text(p.firm07_flag) === "1") flags.push("2007 FEMA flood zone");
  if (text(p.pfirm15_flag) === "1") flags.push("2015 preliminary flood zone");
  if (text(p.edesignum)) flags.push(`E-designation ${text(p.edesignum)}`);
  if (/NYC HOUSING AUTH|NYCHA/i.test(text(p.ownername))) flags.push("NYCHA owner");
  return flags;
}

export function districtSummary(p) {
  const join = (keys) => keys.map((k) => p[k]).filter((v) => typeof v === "string" && v.trim()).join(", ");
  return {
    zoning: join(["zonedist1", "zonedist2", "zonedist3", "zonedist4"]),
    overlays: join(["overlay1", "overlay2"]),
    special: join(["spdist1", "spdist2", "spdist3"]),
  };
}

const USE_LABELS = {
  residential: "Residential",
  commercial: "Commercial",
  communityFacility: "Community facility (qualifying program only)",
  residentialAffordableOrUap: "Residential with affordable bonus",
};

export function capacityRows(capacity) {
  if (!capacity?.byUse) return [];
  const rows = Object.entries(capacity.byUse).map(([use, v]) => ({ use, label: USE_LABELS[use] || use, ...v }));
  if (capacity.qualifyingAffordableOrUap)
    rows.push({ use: "residentialAffordableOrUap", label: USE_LABELS.residentialAffordableOrUap, ...capacity.qualifyingAffordableOrUap });
  return rows;
}

// Shares of PLUTO's gross area stand in for an unknown existing zoning floor area; a DOB-filed figure is known, so
// no range is drawn (as the deck does).
export function zfaBand(capacity) {
  const band = capacity?.existingFloorArea?.basis !== "dob_filed_zfa" ? capacity?.zfaVsGfaGuidance?.sensitivityBand : null;
  if (!band) return [];
  return [85, 90, 95, 100].map((percent) => ({
    percent,
    zfaSqft: band[`assumedZfaAt${percent}PercentGfaSqft`],
    residual: Object.entries(band[`residualByUseAt${percent}PercentZfa`] || {}).map(([use, sqft]) => ({ use, label: USE_LABELS[use] || use, sqft })),
  }));
}

// The headline zoning floor area the envelope's reconciliation chose, with the rows it weighed: a
// filing that is not operative and a conditional community facility maximum read as such.
export function zoningHeadline(table) {
  if (!table) return null;
  const rows = table.rows
    .filter((r) => r.label !== "Operative figure" && finite(r.valueSqft))
    .map((r) => [r.operative === false ? `${r.label}, context only` : r.label, fmtSqft(r.valueSqft)]);
  const op = table.operativeFigure;
  return { value: finite(op.valueSqft) ? fmtSqft(op.valueSqft) : "Not computed", reason: op.reason, rows };
}

export function conceptsNewestFirst(concepts = []) {
  const timestamp = ({ createdAt }) => {
    const value = typeof createdAt === "number" ? createdAt : typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
    return Number.isFinite(value) ? value : -Infinity;
  };
  return [...concepts].sort((a, b) => timestamp(b) - timestamp(a) || (b.version || 0) - (a.version || 0));
}

export function conceptParentName(concept, concepts = []) {
  const parentId = concept.revision?.parentConceptId;
  if (!parentId) return null;
  return concepts.find((c) => c.id === parentId)?.name || concept.revision.parentName || null;
}

export const ASSUMPTION_FIELDS = [
  { path: "landPrice", label: "Land price", kind: "currency" },
  { path: "hardCostPerSqft", label: "Hard cost per gross sq ft", kind: "currency" },
  { path: "softCostPerSqft", label: "Soft cost per gross sq ft", kind: "currency" },
  { path: "financing.loanToCost", label: "Loan to cost", kind: "percent" },
  { path: "financing.interestRate", label: "Interest rate", kind: "percent" },
  { path: "financing.termMonths", label: "Loan term (months)", kind: "number" },
  { path: "operating.residentialVacancyRate", label: "Residential vacancy", kind: "percent" },
  { path: "operating.residentialOpexPerUnitPerYear", label: "Residential operating cost per unit per year", kind: "currency" },
  { path: "operating.commercialVacancyRate", label: "Commercial vacancy", kind: "percent" },
  { path: "operating.commercialOpexPerSqftPerYear", label: "Commercial operating cost per sq ft per year", kind: "currency" },
  { path: "capRate", label: "Exit cap rate", kind: "percent" },
  { path: "sellingCostRate", label: "Selling costs", kind: "percent" },
  // Keeping the building (acres_keep_building): the land price above is its purchase price.
  { path: "keep.renovationCostPerSqft", label: "Renovation cost per gross sq ft", kind: "currency", group: "keep" },
  { path: "keep.renovationMonths", label: "Months of work", kind: "number", group: "keep" },
  { path: "keep.renovatedRentPerSqftPerMonth", label: "Renovated rent per sq ft per month", kind: "currency", group: "keep" },
  { path: "keep.afterRenovationValuePerSqft", label: "Renovated sale price per sq ft", kind: "currency", group: "keep" },
  { path: "keep.capRate", label: "Market cap rate", kind: "percent", group: "keep" },
  { path: "keep.vacancyRate", label: "Vacancy", kind: "percent", group: "keep" },
  { path: "keep.operatingExpenseRatio", label: "Operating costs, share of income", kind: "percent", group: "keep" },
  { path: "keep.loanToValue", label: "Mortgage, share of price", kind: "percent", group: "keep" },
  { path: "keep.interestRate", label: "Mortgage rate", kind: "percent", group: "keep" },
  { path: "keep.amortizationYears", label: "Amortization (years)", kind: "number", group: "keep" },
  { path: "keep.targetReturnOnCost", label: "Return on cost to renovate and sell", kind: "percent", group: "keep" },
];

const readPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Rates are stored as fractions and edited as percents.
export function assumptionInputs(value = {}) {
  return ASSUMPTION_FIELDS.map((def) => {
    const raw = readPath(value, def.path);
    const input = finite(raw) ? String(def.kind === "percent" ? Number((Number(raw) * 100).toFixed(4)) : Number(raw)) : "";
    return { ...def, input };
  });
}

export function readAssumptions(entries) {
  const out = {};
  for (const def of ASSUMPTION_FIELDS) {
    const raw = String(entries[def.path] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw.replace(/[$,%\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) throw new Error(`${def.label} must be a positive number.`);
    const keys = def.path.split(".");
    let node = out;
    for (const k of keys.slice(0, -1)) node = node[k] ||= {};
    node[keys.at(-1)] = def.kind === "percent" ? Number((n / 100).toFixed(6)) : n;
  }
  return out;
}

function mergeUserEdits(before, edited, latest, conflict) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(edited, before)) return latest;
  if (same(latest, before) || same(edited, latest)) return edited;
  const objects = [before, edited, latest].every((value) => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value)));
  if (!objects) throw conflict;
  const keys = new Set([before, edited, latest].flatMap((value) => Object.keys(value || {})));
  return Object.fromEntries([...keys].map((key) => [key, mergeUserEdits(before?.[key], edited?.[key], latest?.[key], conflict)]).filter(([, value]) => value !== undefined));
}

// Retry a stale version only when independent edits can be preserved; overlapping edits need review.
export async function saveProjectFields(api, projectId, current, fields) {
  const path = `/projects/${encodeURIComponent(projectId)}/state`;
  if (fields.instructions) fields = { ...fields, instructions: Object.fromEntries(Object.entries(fields.instructions).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)) };
  try {
    return await api.patch(path, { version: current.version, fields });
  } catch (error) {
    if (error.status !== 409) throw error;
  }
  const latest = await api.get(path);
  const conflict = Object.assign(new Error("This site changed while you were saving. Review the latest figures and save again."), { status: 409, latest });
  const merged = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, mergeUserEdits(current.fields?.[key]?.value ?? {}, value, latest.fields?.[key]?.value ?? {}, conflict)]));
  try {
    return await api.patch(path, { version: latest.version, fields: merged });
  } catch (error) {
    if (error.status !== 409) throw error;
    throw conflict;
  }
}

export function shouldRefetch(event, current) {
  return Boolean(event && current && event.projectId === current.id && Number(event.version) > Number(current.version));
}

export function collectSources(state) {
  const byKey = new Map();
  for (const [key, f] of Object.entries(state?.fields || {})) {
    for (const s of f?.provenance?.sources || []) {
      const id = s.url || s.title;
      if (!id) continue;
      const entry = byKey.get(id) || { ...s, fields: [] };
      if (!entry.fields.includes(key)) entry.fields.push(key);
      byKey.set(id, entry);
    }
  }
  return [...byKey.values()];
}

const FOLLOW_UPS = {
  compute: (label) => `Compute the ${label} for this site.`,
  recompute: (label) => `Recompute the ${label} for this site from the saved project state, including my latest assumptions.`,
  explain: (label) => `Explain how the ${label} for this site was derived, which inputs matter most, and what would change it.`,
  revise: (label) => `Model a revision of the latest ${label} concept that stays within the zoning envelope, and show what changed.`,
  review: (label) => `Review the ${label} for this site: check room sizes, circulation, egress and daylight, and suggest specific changes.`,
  draft: (label) => `Draft the ${label} for this site: find a published floor plan for the building or unit and trace it, or draft one from the dimensions on record, then render the 3D walkthrough. Say which drawing it came from and what is assumed.`,
  typical: () => `${TYPICAL_FLOOR} Say what is assumed.`,
  keep: () => `Price keeping the building as it stands: hold it as is, renovate and rent it, and renovate and sell it, with acres_keep_building. Use my land price as the purchase price when I have set one, otherwise the asking price; the rent roll or comparable rents for the building as it is; comparable sales of standing and renovated buildings like it; the current tax bill; and a renovation scope that covers the open violations. Say which figures are planning assumptions.`,
  import: (label, ref) => `Import the edited Pascal scene "${ref.drawing}" from this site's drawings as the next revision of the ${label}, then render the 3D walkthrough. Say what changed.`,
};

// A design request uses the modeling brief and dimensions independently of financial work.
const TYPICAL_FLOOR = "Draft a typical residential floor plan from the dimensions and design brief supplied for this modeling project. Include its units, circulation, stairs and elevator where appropriate. Ask for missing dimensions rather than requiring an underwriting or a pro forma. Save the floor plan so its 3D walkthrough can render from it.";

// The site page sections that take standing instructions, in page order (project-state.mjs keeps the same ids).
export const INSTRUCTION_SECTIONS = {
  envelope: "Zoning envelope and scenarios",
  massing: "Massing",
  architecture: "Architecture",
  revenue: "Usable area and revenue",
  assumptions: "Assumptions and uncertainty",
};

// The steps whose notes feed each instruction section, in the page's step order.
export const STEP_NOTES = { build: ["envelope"], worth: ["revenue", "assumptions"] };

// The sections a full underwriting covers, in page order, each read from the project state field
// that holds it. Site assembly needs the neighboring lots to combine.
export const UNDERWRITING_SECTIONS = [
  { id: "property", label: "Parcel record" },
  { id: "publicRecords", label: "Property history and public records" },
  { id: "envelope", label: "Zoning envelope" },
  { id: "entitlements", label: "Entitlement scenarios" },
  { id: "market", label: "Market inputs" },
  { id: "program", label: "Unit mix" },
  { id: "proFormas", label: "Pro forma" },
  { id: "comparisons", label: "Program comparison and acquisition decision" },
  { id: "keep", label: "Keeping the building: hold, renovate and rent, renovate and sell" },
];
export const FULL_PASS_EXCLUSIONS = ["Site assembly is not part of a full underwriting: it needs the neighboring lots to combine, so ask for it with their addresses."];

// Regenerate redoes the underwriting from fresh data; the other full pass reuses current inputs.
function doAllMessage(instructions = {}, fresh = false) {
  const lines = Object.entries(INSTRUCTION_SECTIONS)
    .filter(([id]) => !['massing', 'architecture'].includes(id) && String(instructions[id] || "").trim())
    .map(([id, label]) => `- ${label}: ${instructions[id].trim()}`);
  const records = "its public records (DOB filings, certificates of occupancy, ACRIS deeds with the owner of record, HPD registration and violations)";
  const keep = "and, where a building stands on the lot, what keeping it is worth at the same price: held as is, renovated and rented, and renovated and sold";
  const ask = fresh
    ? `Underwrite this site again from scratch in one pass: re-check the parcel and ${records}, then recompute the zoning envelope and entitlement scenarios, the unit mix with fresh market inputs, the pro forma, and the program comparison with the acquisition decision at the land price, ${keep}. Do not reuse earlier underwriting results; replace each one with the new run's.`
    : `Underwrite this site end to end in one pass: resolve the parcel if it is missing and read ${records}, then the zoning envelope and entitlement scenarios, the unit mix with market inputs, the pro forma, and the program comparison with the acquisition decision at the land price, ${keep}. Reuse whatever in the project state is current and redo only what is missing or stale.`;
  const asks = `${ask} Complete the underwriting from its zoning and financial inputs without requiring a building model. Do not create or revise floor plans, massing models or 3D renders in this workflow. Leave site assembly out: it needs the neighboring lots to combine. End by listing each section as produced, kept as current, or not produced, with the reason.`;
  return lines.length ? `${asks}\n\nFollow my instructions for each section:\n${lines.join("\n")}` : asks;
}

// Each section's state after a full underwriting that started at since (ms): produced by the run,
// kept because it was current, needing a refresh because an earlier result changed, or not produced.
export function underwritingChecklist(state, since) {
  const fields = state?.fields || {};
  const items = UNDERWRITING_SECTIONS.map(({ id, label }) => {
    const f = fields[id];
    const status = !hasValue(f) ? "missing" : f.stale ? "stale" : Number(new Date(f.updated)) >= since ? "produced" : "kept";
    return { id, label, status };
  });
  return { items, exclusions: FULL_PASS_EXCLUSIONS };
}

export function followUpMessage(ref) {
  if (ref?.action === "all") return doAllMessage(ref.instructions, false, ref.plan === true);
  if (ref?.action === "regenerate") return doAllMessage(ref.instructions, true, ref.plan === true);
  const label = FIELD_LABELS[ref?.field], action = FOLLOW_UPS[ref?.action];
  if (!label || !action) throw new Error("This page control is not available.");
  const note = String(ref.note || "").trim();
  return note ? `${action(label, ref)} My instructions for this section: ${note}` : action(label, ref);
}

// The site page is four underwriting steps in order. A step is done when its required fields exist (a
// list inside required means any one of them), needs a refresh when any of its fields is stale, and is
// running when the site's conversation is working on one of its tools; later unfinished steps of a run
// are up next. Should you buy it is answered by building new (the program comparison), by keeping the
// building, or by both.
export const STEPS = [
  { id: "property", title: "Confirm the property", fields: ["property"], required: ["property"] },
  { id: "build", title: "What you can build", fields: ["envelope", "entitlements"], required: ["envelope"] },
  { id: "worth", title: "What it's worth", fields: ["program", "market", "proFormas"], required: ["proFormas"] },
  { id: "decide", title: "Should you buy it", fields: ["comparisons", "keep"], required: [["comparisons", "keep"]] },
];

const TOOL_STEP = {
  acres_find_property: "property",
  acres_set_subject: "property",
  acres_nyc_public_records: "property",
  acres_zoning_envelope: "build",
  acres_entitlement_scenarios: "build",
  acres_assemble_site: "build",
  acres_unit_mix: "worth",
  acres_market_inputs: "worth",
  acres_market_comps: "worth",
  acres_pro_forma: "worth",
  acres_compare_programs: "decide",
  acres_keep_building: "decide",
};

// The step a tool works on (by its capability name), or null for research that serves every step.
export const toolStep = (tool) => TOOL_STEP[tool] || null;

// The floor plan tools: a run whose latest tool is one of these is drafting or editing the plan.
// Reading the plan or a drawing counts only once the run has started drafting: an underwriting that
// reads the saved plan to size its units is still on its steps.
export const PLAN_TOOLS = new Set(["acres_model_concept", "acres_find_floor_plan", "acres_attach_drawing", "acres_view_drawing", "acres_read_plan", "acres_save_plan", "acres_render_plan", "acres_import_pascal_scene"]);
const PLAN_READS = new Set(["acres_view_drawing", "acres_read_plan"]);
const lastTool = (run) => {
  const tools = run?.tools || [];
  const drafting = tools.some((t) => PLAN_TOOLS.has(t) && !PLAN_READS.has(t));
  return [...tools].reverse().find((t) => TOOL_STEP[t] || (PLAN_TOOLS.has(t) && (drafting || !PLAN_READS.has(t)))) || null;
};
export const planDrafting = (run) => PLAN_TOOLS.has(lastTool(run));

const hasValue = (field) => {
  const v = field?.value;
  return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
};

// asked is the step a request from the page targeted: a run shows there until it reaches a tool
// that belongs to another step.
export function stepView(state, run = null, asked = null) {
  const fields = state?.fields || {};
  const steps = STEPS.map((s) => {
    const done = s.required.every((k) => (Array.isArray(k) ? k.some((key) => hasValue(fields[key])) : hasValue(fields[k])));
    const stale = done && s.fields.some((k) => fields[k]?.stale);
    const updated = Math.max(0, ...s.fields.map((k) => (hasValue(fields[k]) ? Number(new Date(fields[k].updated)) || 0 : 0)));
    return { ...s, done, stale, updated: updated || null };
  });
  // A step with some of its results but not the one that completes it is incomplete, not unstarted.
  const idle = (s) => (s.stale ? "stale" : s.done ? "done" : s.fields.some((k) => hasValue(fields[k])) ? "partial" : "todo");
  // A run on the floor plan is past the four steps: they read as they stand.
  if (!run || planDrafting(run)) return steps.map((s) => ({ ...s, status: idle(s) }));
  const tool = lastTool(run);
  const active = tool ? TOOL_STEP[tool] : asked || (steps.find((s) => !s.done || s.stale) || steps[0]).id;
  const at = steps.findIndex((s) => s.id === active);
  // A run fills every unfinished step up to the one it is working on, so an earlier step it has
  // not saved yet is still in progress, never "not started".
  return steps.map((s, i) => ({
    ...s,
    status: i === at || (i < at && (!s.done || s.stale)) ? "running" : i > at && (!s.done || s.stale) ? "queued" : idle(s),
  }));
}

// The step (1 to 4) a run is working on, from the tools it has started: the furthest step the site
// page shows as running, since earlier unsaved steps also show as running there.
export function runStep(state, tools) {
  const at = stepView(state, { tools }).findLastIndex((s) => s.status === "running");
  return at < 0 ? null : at + 1;
}

// The option that pays the most for the land: the site's one answer to what the land is worth, read
// the same way by the header, the deal card, the sites list and the full report. schemes is the
// site's schemes read ({schemes, basis}); null until it holds an option with returns.
export function leadingScheme(schemes) {
  return (schemes?.schemes || []).filter((s) => s.returns).reduce((a, s) => (!a || s.returns.landValue > a.returns.landValue ? s : a), null);
}

// What development sites near the lot sold for, scaled to its as-of-right buildable area: the site's land
// value where at least five such sales exist (nearbyLand on the schemes read), otherwise null and the
// residual leads.
export const NEARBY_MIN_SALES = 5;
export function nearbyLand(schemes) {
  const n = schemes?.basis?.nearbyLand;
  return n && Number(n.sales) >= NEARBY_MIN_SALES && finite(n.value) && Number(n.value) > 0 ? n : null;
}

// What the land is worth, in one sentence. Where nearby sales lead, the land value is what they sold for,
// and the residual follows as what a developer earning the target return at the account's costs could pay,
// saying so when that is less than buyers nearby pay. Otherwise the residual is the land value. Both name
// city financing when that option pays the most and end with the ask when there is one. The site header
// and the full report both say it this way.
export function landAnswer(schemes) {
  const best = leadingScheme(schemes);
  const land = Math.max(0, best?.returns.landValue ?? 0);
  const near = nearbyLand(schemes);
  const city = best?.program?.taxProgram?.kind === "city-financed" ? " with city financing, capped at appraised land value (nearby sales)" : "";
  const b = schemes?.basis;
  const ask = b?.askFrom === "assumptions" ? `Your land price is ${fmtMoney(b.ask)}.` : b?.askFrom === "listing" ? `The asking price is ${fmtMoney(b.ask)}.` : "";
  const developer = land > 0
    ? `a developer earning your target return at your costs could pay up to ${fmtMoney(land)}${city}`
    : "none of the three ways to build it pays for the land at your costs and target return";
  const above = land > 0 ? ", less than buyers nearby are paying" : ", so buyers nearby are paying more than the returns support";
  const lead = near
    ? `Land value: nearby development-site sales, adjusted to this lot, put it at about ${fmtMoney(near.value)}; ${developer}${land < Number(near.value) ? above : ""}.`
    : `Land value: ${developer}.`;
  return [lead, ask, tierSentence(b)].filter(Boolean).join(" ");
}

// The store's deal tier for the site, named as the deal-tiers help article names it.
export const DEAL_TIERS = { great_deal: "Great deal", good_deal: "Good deal", fair_deal: "Fair deal", full_price: "Full price", unpriced_opportunity: "Unpriced" };

// What set a store tier (its dealTierBasis), in a phrase: with enough nearby development-site sales, the
// ask as a share of what they sold for; otherwise what a developer can pay at the account's costs.
export function tierBasisPhrase(t, { short = false } = {}) {
  if (!t) return null;
  if (t.basis === "nearby") {
    if (t.askToNearby == null) return short ? "on nearby sales" : "set on the land value from nearby sales";
    const share = `${Math.round(Number(t.askToNearby) * 100)}%`;
    return short ? `ask ${share} of nearby land value` : `the ask is ${share} of the land value from nearby sales`;
  }
  return short ? "on what a developer can pay" : "set on what a developer can pay at your costs";
}

// The checks that hold a tier below the one its price earns, by label. On the nearby basis the returns are
// the developer check, a note beside the tier, never a hold. v carries priceVerdict, dealVerdict, gates and
// dealTierBasis (a deal's flashcardValuation or a schemes read's basis).
export function tierHolds(v) {
  if (!v?.priceVerdict || v.priceVerdict === v.dealVerdict) return [];
  return (v.gates || []).filter((g) => !(v.dealTierBasis?.basis === "nearby" && g.id === "returns")).map((g) => g.label);
}

// The tier in one sentence for the site header and report: the tier, what set it, and any check holding it.
export function tierSentence(basis) {
  const tier = DEAL_TIERS[basis?.dealVerdict];
  if (!tier || !basis.dealTierBasis || basis.dealVerdict === "unpriced_opportunity") return null;
  const holds = tierHolds(basis);
  return `Deal tier: ${tier}, ${tierBasisPhrase(basis.dealTierBasis)}.${holds.length ? ` Held at ${tier.replace(/ deal$/, "")}: ${holds.join(", ").toLowerCase()}.` : ""}`;
}

// The call a land value makes against a price, in the acquisition decision's terms; null with no price.
export const landCall = (landValue, price) => (price == null ? (landValue > 0 ? null : "no_land_value") : landValue >= price ? "supports_price" : landValue > 0 ? "below_price" : "no_land_value");

// The figures an investor reads first; each is null until the step that produces it has run. Once the
// site has priced options they come from the leading option at today's store figures, like the options
// themselves (priced: true); before that, from the run's latest pro forma.
export function snapshot(state, schemes = state?.fields?.schemes?.value) {
  const value = (k) => state?.fields?.[k]?.value;
  const env = value("envelope");
  const area = {
    buildableSqft: finite(env?.floorArea?.maxFloorAreaSqft) ? Number(env.floorArea.maxFloorAreaSqft) : null,
    maxFar: finite(env?.floorArea?.maxFar) ? Number(env.floorArea.maxFar) : null,
  };
  const lead = leadingScheme(schemes);
  if (lead) {
    const r = lead.returns, basis = schemes.basis || {};
    const landPrice = finite(basis.ask) ? Number(basis.ask) : null;
    return {
      priced: true, landPrice, ...area,
      landValue: r.landValue, leadLabel: lead.label, tier: DEAL_TIERS[basis.dealVerdict] || null, tierBasis: basis.dealTierBasis || null, nearby: nearbyLand(schemes),
      value: finite(r.completedValue) ? Number(r.completedValue) : null,
      profit: finite(r.profit) ? Number(r.profit) : null,
      margin: finite(r.condoMargin) ? { label: "condo margin", pct: Number(r.condoMargin) } : finite(r.yieldOnCost) ? { label: "yield on cost", pct: Number(r.yieldOnCost) } : null,
      call: landCall(r.landValue, landPrice),
    };
  }
  const pf = (value("proFormas") || []).at(-1);
  const landPrice = value("assumptions")?.landPrice ?? pf?.development?.landPrice;
  return {
    landPrice: finite(landPrice) ? Number(landPrice) : null,
    ...area,
    value: finite(pf?.returns?.value) ? Number(pf.returns.value) : null,
    profit: finite(pf?.returns?.profit) ? Number(pf.returns.profit) : null,
    returnOnCost: finite(pf?.returns?.unleveredReturnOnCost) ? Number(pf.returns.unleveredReturnOnCost) : null,
    proFormaName: pf?.name || null,
  };
}

// Whether the run's buy decision values the land differently from today's options: a justified land
// price more than 10% from the leading option's, or a different call. The cause can be a later change to
// land values or the program the run chose to compare. Returns the run's figure or null.
export function decisionDiffers(state, schemes = state?.fields?.schemes?.value) {
  const decision = (state?.fields?.comparisons?.value || []).at(-1)?.decision;
  const s = snapshot(state, schemes);
  if (!s.priced || !decision || !finite(decision.maxLandPrice)) return null;
  const now = Math.max(0, s.landValue), then = Math.max(0, Number(decision.maxLandPrice));
  const moved = Math.abs(now - then) > 0.1 * Math.max(now, then) || (s.call && s.call !== decision.call);
  return moved ? { maxLandPrice: then, call: decision.call } : null;
}

// A saved site's state at a glance: steps done out of four (as the site page counts them), whether
// any needs a refresh, the first step still to do (1 to 4, null when none), when a step last saved a
// result, the land price and profit once known, and the acquisition call (supports_price, below_price or
// no_land_value): from the leading option once the site has priced options, otherwise the run's decision.
export function siteProgress(state) {
  const steps = stepView(state);
  const s = snapshot(state);
  const decision = (state?.fields?.comparisons?.value || []).at(-1)?.decision;
  const next = steps.findIndex((step) => !step.done || step.stale);
  return {
    done: steps.filter((step) => step.done && !step.stale).length,
    next: next < 0 ? null : next + 1,
    stale: steps.some((step) => step.stale),
    underwritten: Math.max(0, ...steps.map((step) => step.updated || 0)) || null,
    landPrice: s.landPrice,
    profit: s.profit,
    call: s.priced ? s.call : decision?.call || null,
  };
}

// The site's name: the parcel address once resolved, otherwise the address the request named.
// City records spell addresses in capitals; pages name a site as people write it.
export const displayAddress = (text) => (text && text === text.toUpperCase() ? text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : text);

export function siteName(state) {
  const address = state?.fields?.property?.value?.address;
  if (address) return displayAddress(address);
  const title = String(state?.title || "").replace(/^underwrite\s+/i, "");
  return title.split(" (")[0].trim() || "Untitled site";
}

// Headroom: the unused floor area of the building that sets the value, the figure the rating is judged on.
// Rows valued before the store served it fall back to the area with the affordable bonus, then as of right.
export const headroomSqft = (d) => {
  if (finite(d.unused_for_lead_zfa)) return Number(d.unused_for_lead_zfa);
  const bonus = finite(d.uap_unused_zfa) ? Number(d.uap_unused_zfa) : null;
  const standard = finite(d.unused_residential_zfa) ? Number(d.unused_residential_zfa) : null;
  return bonus || standard || (bonus ?? standard);
};
export const headroomFar = (d) => {
  const unused = headroomSqft(d);
  return finite(d.lot_area_sqft) && Number(d.lot_area_sqft) > 0 && unused !== null
    ? unused / Number(d.lot_area_sqft) : null;
};

// A box around the five boroughs, drawn into a 420 by 230 map with a margin for pins and their labels.
export const NYC_EXTENT = { south: 40.4774, north: 40.9176, west: -74.2591, east: -73.7004 };
export function nycMapPoint(lat, lon) {
  return {
    x: Math.round(25 + ((lon - NYC_EXTENT.west) / (NYC_EXTENT.east - NYC_EXTENT.west)) * 370),
    y: Math.round(22 + ((NYC_EXTENT.north - lat) / (NYC_EXTENT.north - NYC_EXTENT.south)) * 186),
  };
}

// A deal card's map pin, or null when the geocode is missing or falls outside the map's extent, a box around the
// five boroughs: the 0,0 placeholder and swapped coordinates get no pin, while points just across the city line,
// such as Jersey City or western Nassau, still do.
export function dealPin(d) {
  if (!finite(d.latitude) || !finite(d.longitude)) return null;
  const lat = Number(d.latitude), lon = Number(d.longitude);
  const e = NYC_EXTENT;
  if (lat < e.south || lat > e.north || lon < e.west || lon > e.east) return null;
  return { lat, lon, ...nycMapPoint(lat, lon) };
}

// Architecture: GET /projects/:id/architecture is {current:{revision, plan, artifacts, jobs}, revisions}.
export const architectureArtifactUrl = (projectId, artifact) =>
  `/api/projects/${encodeURIComponent(projectId)}/architecture/artifacts/${encodeURIComponent(artifact.id)}`;

const polygonArea = (polygon) => Math.abs(polygon.reduce((sum, [x, y], i) => {
  const [nx, ny] = polygon[(i + 1) % polygon.length];
  return sum + x * ny - nx * y;
}, 0)) / 2;
const SQFT_PER_M2 = 10.7639;
// Plans are drawn in metres; areas are shown in square feet.
export const fmtArea = (m2) => `${fmtNumber(m2 * SQFT_PER_M2)} sq ft`;

// Finished products a revision offers as files, in the order a reader wants them: the still
// and the 3D model first, then the interchange documents. Each kind appears once, from the
// latest job for job outputs and from the revision itself for the geometry-lane files.
const DOWNLOAD_KINDS = [
  ["preview", "Preview (PNG)"],
  ["glb", "3D model (GLB)"],
  ["blend", "Blender file"],
  ["ifc", "IFC model"],
  ["svg", "Plan (SVG)"],
  ["pascal-scene", "Pascal scene (JSON)"],
];

export function architectureView(projectId, summary) {
  const current = summary?.current;
  if (!current) return { kind: "empty" };
  const job = [...current.jobs].sort((a, b) => a.createdAt - b.createdAt).at(-1) || null;
  const outputs = Object.fromEntries((job?.artifacts || []).map((a) => [a.kind, a]));
  const pascal = current.artifacts.find((a) => a.kind === "pascal-scene" && !a.jobId);
  const viewer = job?.status === "succeeded" && outputs.glb && outputs.manifest ? {
    key: job.id,
    glbUrl: architectureArtifactUrl(projectId, outputs.glb),
    manifestUrl: architectureArtifactUrl(projectId, outputs.manifest),
    pascalSceneUrl: pascal ? architectureArtifactUrl(projectId, pascal) : null,
  } : null;
  const byKind = new Map();
  for (const artifact of current.artifacts) if (!artifact.jobId && !byKind.has(artifact.kind)) byKind.set(artifact.kind, artifact);
  for (const [kind, artifact] of Object.entries(outputs)) byKind.set(kind, artifact);
  const downloads = DOWNLOAD_KINDS.filter(([kind]) => byKind.has(kind))
    .map(([kind, label]) => ({ kind, label, url: architectureArtifactUrl(projectId, byKind.get(kind)), bytes: byKind.get(kind).bytes }));
  const preview = job?.status === "succeeded" && outputs.preview
    ? { url: architectureArtifactUrl(projectId, outputs.preview), bytes: outputs.preview.bytes }
    : null;
  return {
    kind: "plan",
    revision: current.revision,
    revisionCount: summary.revisions.length,
    name: current.plan.name,
    savedAt: current.createdAt,
    levels: current.plan.levels.length,
    rooms: current.plan.rooms.length,
    netAreaM2: current.plan.rooms.reduce((sum, r) => sum + polygonArea(r.polygon), 0),
    unitsPerFloor: unitsPerFloor(current.plan),
    plan: current.plan,
    job,
    viewer,
    preview,
    downloads,
  };
}

// Units on the fullest storey, counted from rooms named as units ("Unit 3, 1 bedroom"); 0 for a
// plan of one apartment, whose rooms are its kitchen, bedrooms and so on.
function unitsPerFloor(plan) {
  const counts = plan.levels.map((l) => plan.rooms.filter((r) => (r.levelId ?? l.id) === l.id && /^unit\b/i.test(r.name)).length);
  return Math.max(0, ...counts);
}

const atTime = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function jobStatus(job, revision) {
  const status = job?.status || "none";
  const text = {
    none: () => `No walkthrough has been built for revision ${revision}.`,
    queued: () => "Queued: the walkthrough starts when the worker is free.",
    running: () => `Building the walkthrough for revision ${revision} in Blender${job.startedAt ? ` · started ${atTime(job.startedAt)}` : ""}`,
    failed: () => (job.reason ? `The walkthrough job failed: ${job.reason}` : "The walkthrough job failed. No reason was reported."),
    cancelled: () => "The walkthrough job was cancelled.",
    succeeded: () => `Walkthrough built for revision ${revision}${job.finishedAt ? ` · ${atTime(job.finishedAt)}` : ""}`,
  }[status]();
  const running = status === "queued" || status === "running";
  return { status, text, running, failed: status === "failed", canRun: !running };
}


export function architectureEventAffects(event, projectId) {
  if (event?.projectId !== projectId) return false;
  return event.event === "architecture.job" || (event.event === "state.updated" && Boolean(event.keys?.includes("architecture")));
}
