// The listing inspector: one listing's ask against its zoning envelope, the price per buildable SF
// scale, the projections at the reader's costs, delivery risks, comparables and the basis of each figure.
import { normalizeDealRow, buildDealUnderwritePrompt, buildDealKeepPrompt, buildDealPlanPrompt, unitEstimate, listingLink, tenantReview, comparableReview, fmtCurrency, fmtInt, fmtPct, verdictMeta, valueDriverLabel, mihBadge, taxBadge, DWELLING_UNIT_FACTOR } from "./deals.js";
import { dealScale, finite, pricePerBuildable, tierHold } from "./deal-card.js";
import { headroomFar, headroomSqft } from "./core-model.js";
import { helpLink } from "./help-links.js";
import { boroughName, photoAt, siteSummary, TIER_LABELS } from "./listing-card.js";
import { bindFilterPopover } from "./filter-popover.js";
import { renderNearbyPipeline } from "./nearby-pipeline.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// What the reader is buying for: building new or keeping the building. The choice orders the page and picks
// the underwriting its main action starts; both stay one click away.
export const GOALS = { build: "Build new", keep: "Keep the building" };
function goalChoice(goal, onGoal) {
  const bar = el("div", "inspector-goal");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "What you are buying for");
  bar.append(el("span", "inspector-goal-label", "Buying to"));
  for (const [id, label] of Object.entries(GOALS)) {
    const option = el("button", `inspector-goal-option${goal === id ? " is-active" : ""}`, label);
    option.type = "button";
    option.dataset.goal = id;
    option.setAttribute("aria-pressed", String(goal === id));
    option.addEventListener("click", () => { if (goal !== id) onGoal(id); });
    bar.append(option);
  }
  return bar;
}

// The listing kept as it stands, read instantly from the store's figures (keep.mjs quickKeep): what it nets at
// the ZIP's asking rents, what it pays at a planning cap rate and what standing buildings like it sold for.
const money = (n) => (finite(n) ? `${Number(n) < 0 ? "-" : ""}${fmtCurrency(Math.abs(Number(n)))}` : null);
export function keepSection(read) {
  if (!read) return null;
  const box = el("section", "inspector-section inspector-keep");
  box.append(el("h3", "", "Keep the building"));
  if (read.priced) {
    const figures = el("dl", "deal-figures inspector-figures");
    const figure = (label, value, note) => {
      const wrap = el("div", "deal-figure");
      const dd = el("dd");
      dd.append(el("strong", "", value));
      if (note) dd.append(el("small", "", note));
      wrap.append(el("dt", "", label), dd);
      figures.append(wrap);
    };
    const h = read.hold, cap = fmtPct(read.capRate, 0);
    figure("Pays up to", h.maxPrice == null || h.maxPrice <= 0 ? "Nothing" : money(h.maxPrice), `As a rental at a ${cap} cap rate on all-in cost, against the ${fmtCurrency(read.price)} ask`);
    figure("Net income at ZIP rents", money(h.noi), `${fmtPct(h.capRateOnCost)} on the all-in cost of ${money(h.allIn)}`);
    figure("Nearby building sales", read.comparable ? money(read.comparable.value) : "Too few sales", read.comparable ? `${fmtPct(read.comparable.shareOfAsk, 0)} of the ask, from ${fmtInt(read.comparable.saleCount)} sales` : null);
    figure("Cash flow with a mortgage", money(h.cashFlow), finite(h.dscr) ? `After debt service; the rent covers it ${Number(h.dscr).toFixed(2)}x` : "After debt service");
    box.append(figures);
  }
  box.append(el("p", "inspector-note", read.sentence));
  if (read.regulatedUnits > 0) box.append(el("p", "inspector-note", `${fmtInt(read.regulatedUnits)} rent-stabilized ${read.regulatedUnits === 1 ? "unit is" : "units are"} registered here; their rents stay regulated, so these figures read high.`));
  if (read.priced) box.append(el("p", "inspector-note", `Assumes ${read.assumptions.join("; ")}. ${read.caveat}`));
  return box;
}

function rows(title, pairs) {
  const section = el("section", "inspector-section");
  section.append(el("h3", "", title));
  const list = el("dl", "inspector-rows");
  for (const [label, value] of pairs) {
    if (value === null || value === undefined || value === "") continue;
    const row = el("div");
    row.append(el("dt", "", label), el("dd", "", value));
    list.append(row);
  }
  section.append(list);
  return section;
}

const far = (n) => (finite(n) ? Number(n).toFixed(2) : null);
const sf = (n) => (finite(n) && Number(n) > 0 ? `${fmtInt(n)} SF` : null);

// Plain names for the basis items the store reports for each figure.
const BASIS = {
  submarketSalePsf: "Submarket sale $/SF",
  submarketRentPsfMonth: "Submarket rent $/SF a month",
  retailRentPsfYear: "Retail rent $/SF a year",
  zfaGrossDeductions: "Floor area to gross deductions",
  hardCostPerGrossSqft: "Hard cost $/GSF",
  rentalHardCostPerGrossSqft: "Rental hard cost $/GSF",
  condoHardCostPerGrossSqft: "Condo hard cost $/GSF",
  softCostPctOfHard: "Soft cost, share of hard cost",
  carryAndFinancingPct: "Carry and financing",
  zfaToGrossFactor: "Floor area to gross factor",
  zfaToNetEfficiency: "Net efficiency",
  operatingExpenseRatio: "Operating expense ratio",
  affordableRentPsfMonth: "Affordable rent $/SF a month",
  buyerTransferTax: "Buyer transfer tax",
  heightClassHardCost: "Hard cost by height class and lot width",
  corePerFloor: "Stair and elevator core per floor",
  buyerClosingCost: "Buyer closing costs",
  dwellingUnitFactor: "Most units allowed",
  plannedUnitMix: "Planned unit sizes",
  realEstateTaxes: "Real estate taxes",
  taxIncentive485x: "485-x tax exemption",
  wageFloorPremium: "485-x construction wage floor",
};

const pct = (n, digits = 1) => `${Number((Number(n) * 100).toFixed(digits))}%`;
const upBy = (factor) => `+${Math.round((factor - 1) * 100)}%`;

// What the tier rests on, in one line under the tier pill: the ask against the land value that set it, and
// any check holding the tier below what its price earns. tierMethod says how that value and the cut-offs are set.
export function tierBasis(raw) {
  const deal = normalizeDealRow(raw);
  const fv = deal.flashcardValuation || {};
  if (!TIER_LABELS[deal.deal_verdict]) return null;
  const hold = tierHold(deal);
  const held = hold ? ` ${hold}.` : "";
  const t = fv.dealTierBasis;
  if (t?.basis === "nearby" && finite(fv.nearbyLand?.value)) {
    const land = fmtCurrency(fv.nearbyLand.value);
    if (!deal.list_price || t.askToNearby == null) return `No ask yet. Nearby sales put the land at about ${land}.`;
    return `The ask is ${Math.round(t.askToNearby * 100)}% of the ${land} land value from nearby sales.${held}`;
  }
  const land = deal.slidingScale.goodDealMaxPricePerBsf;
  if (!finite(land)) return null;
  const ppb = pricePerBuildable(deal);
  if (!deal.list_price || !finite(ppb)) return `No ask yet. The land is worth up to $${fmtInt(land)}/BSF at your costs.`;
  return `$${fmtInt(ppb)}/BSF against land worth up to $${fmtInt(land)}/BSF at your costs.${held}`;
}

// How the tier is set, for the reader who opens it: where the land value comes from and the cut-offs.
export function tierMethod(raw) {
  const fv = normalizeDealRow(raw).flashcardValuation || {};
  const t = fv.dealTierBasis;
  if (t?.basis === "nearby" && finite(fv.nearbyLand?.value)) {
    const n = fv.nearbyLand;
    const cut = (k) => `${Math.round(t.thresholds[k] * 100)}%`;
    return `${n.sales} development-site sales within ${n.radiusMiles} miles over the last ${n.months} months, adjusted to this lot's size, zoning and existing building, put its land at about ${fmtCurrency(n.value)}. An ask at ${cut("great_deal")} of that or less is a Great deal, up to ${cut("good_deal")} Good, up to ${cut("fair_deal")} Fair, and above it Full price. Tenants, flood risk and other checks can hold a tier lower.`;
  }
  return "Fewer than five development sites sold nearby, so the tier compares the ask per buildable SF with what a developer can pay for the land at your costs and target returns. Tenants, flood risk and other checks can hold a tier lower.";
}

// Where a cost setting comes from: the reader's saved costs, a change made for this search, or the house default.
function costOrigin(key, value, costBasis) {
  // Pre-split cost bases carry only the legacy hard cost, which priced both exits.
  const at = settings => settings?.[key] ?? (key.endsWith("HardCostPerGrossSqft") ? settings?.hardCostPerGrossSqft : undefined);
  const house = at(costBasis?.house);
  if (!finite(house) || Number(value) === Number(house)) return "house default";
  return costBasis?.saved && Number(at(costBasis.saved)) === Number(value) ? "your saved costs" : "this search only";
}

// The construction cost inputs behind the value, each with its basis.
function costRows(driver, dealSettings, costBasis) {
  const hard = driver.baseHardCostPerGrossSqft;
  const steps = [driver.heightClassFactor > 1 ? `${upBy(driver.heightClassFactor)} ${driver.heightClass}` : null, driver.narrowLotFactor > 1 ? `${upBy(driver.narrowLotFactor)} narrow lot` : null].filter(Boolean);
  const hardLine = (base, adjusted, key) => {
    // The house cost is the published New York range's figure for this structure and price level.
    const fromTable = key === "condoHardCostPerGrossSqft" ? driver.condoHardCostFromTable : key === "rentalHardCostPerGrossSqft" ? driver.rentalHardCostFromTable : driver.exit === "condo" ? driver.condoHardCostFromTable : driver.rentalHardCostFromTable;
    if (fromTable && driver.hardCostTable) {
      const t = driver.hardCostTable;
      return `$${fmtInt(adjusted)}/GSF: house default, ${t.structureLabel} at this price level in the published New York range of $${fmtInt(t.lowPerGrossSqft)} to $${fmtInt(t.highPerGrossSqft)}${driver.narrowLotFactor > 1 ? `, ${upBy(driver.narrowLotFactor)} narrow lot` : ""}`;
    }
    const origin = costOrigin(key, base, costBasis);
    return finite(base) && steps.length
      ? `$${fmtInt(adjusted)}/GSF: $${fmtInt(base)} ${origin}, ${steps.join(", ")}`
      : `$${fmtInt(adjusted)}/GSF, ${finite(base) ? origin : "house default"} for ${driver.heightClass}`;
  };
  // One row while both exits build at the same cost; a row each once they differ.
  const rentalBase = driver.baseRentalHardCostPerGrossSqft ?? hard, condoBase = driver.baseCondoHardCostPerGrossSqft ?? hard;
  const rows = finite(rentalBase) && finite(condoBase) && rentalBase !== condoBase
    ? [["Rental hard cost", hardLine(rentalBase, driver.rentalHardCostPerGrossSqft ?? driver.hardCostPerGrossSqft, "rentalHardCostPerGrossSqft")],
       ["Condo hard cost", hardLine(condoBase, driver.condoHardCostPerGrossSqft ?? driver.hardCostPerGrossSqft, "condoHardCostPerGrossSqft")]]
    : [["Hard cost", hardLine(hard, driver.hardCostPerGrossSqft, "hardCostPerGrossSqft")]];
  const soft = dealSettings.softCostPctOfHard, carry = dealSettings.carryAndFinancingPct;
  if (finite(soft)) rows.push(["Soft cost", `${pct(soft, 0)} of hard cost, ${costOrigin("softCostPctOfHard", soft, costBasis)}`]);
  if (finite(carry)) rows.push(["Carry and financing", `${pct(carry, 0)} of cost, ${costOrigin("carryAndFinancingPct", carry, costBasis)}`]);
  const gross = driver.grossFactor ?? dealSettings.zfaToGrossFactor;
  if (finite(gross)) rows.push(["Gross-up", `${Number(gross).toFixed(2)}, assumed; ${costOrigin("zfaToGrossFactor", gross, costBasis)}`]);
  return rows;
}

// The taxes a rental lead carries: full taxes by the DOF income method, the 485-x terms it elected, or none when city-financed.
function taxesLine(driver) {
  if (driver.taxes === "full") return `Full taxes, about ${pct(driver.taxShareOfNoi, 0)} of NOI before taxes by the DOF income method`;
  if (driver.taxes === "city-financed") return "None: city-financed rentals are exempt (420-c or Article XI)";
  const t = driver.taxProgram;
  if (!t) return null;
  const years = t.schedule.map((r) => `${pct(r.exemption, 0)} exempt in years ${r.fromYear} to ${r.toYear}`).join(", ");
  const wage = t.wageFloorHourly ? `a construction wage floor of $${t.wageFloorHourly.toFixed(2)} an hour (${t.wageSection}) adds ${pct(t.hardCostPremium, 1)} to hard cost` : "no construction wage floor under 100 units";
  return `485-x Option ${t.option}, ${t.label} (RPTL 485-x ${t.section}): ${pct(t.restrictedShare, 0)} of units at ${t.amiPct}% AMI on average; ${years}; ${wage}`;
}

// What development sites near the listing sold for, adjusted to this lot, per as-of-right buildable SF:
// the nearby land value the deal tier is judged against.
function nearbyLandSummary(n) {
  if (!n) return null;
  const miles = Number(n.radiusMiles).toFixed(1);
  return `${fmtCurrency(n.perBuildableSqft)} per buildable SF from ${n.sales} development-site sales within ${miles} ${miles === "1.0" ? "mile" : "miles"} over the last ${n.months} months${n.model ? ", each adjusted to this lot" : ""}${finite(n.value) ? `; ${fmtCurrency(n.value)} on this lot's as-of-right floor area` : ""}`;
}

// A rental held under 100 units for 485-x Option B, against the best building without the cap.
function unitCapLine(driver) {
  if (!driver.unitCap) return null;
  const held = `Held to ${driver.unitCap} units for 485-x Option B, from the ${fmtInt(driver.uncappedUnits)} the full envelope holds.`;
  const without = driver.uncappedLandValue > 0 ? `${fmtCurrency(driver.uncappedLandValue)} for the best building without the cap` : `the best building without the cap, which falls ${fmtCurrency(-driver.uncappedLandValue)} short of its costs`;
  return `${held} The land is worth ${fmtCurrency(driver.landValue)} this way, against ${without}.`;
}

// What sets the site's value and what holds its tier: the program and exit the land value comes from,
// the building behind it, what buying costs on top of the ask, and any condition that caps the tier.
function valueBasis(deal, { dealSettings = {}, costBasis = null, onSetCosts = null } = {}) {
  const fv = deal.flashcardValuation || {};
  const driver = fv.valueDriver;
  const buy = fv.acquisition;
  const mih = fv.mih?.status === "inside" ? fv.mih : null;
  // Outside MIH areas affordable floor area is the UAP's, at 60% AMI on average.
  const ami = mih ? mih.amiPct : 60;
  if (!driver && !fv.gates?.length) return null;
  const section = rows("What sets the value", driver ? [
    ["Value set by", valueDriverLabel(driver)],
    ["Priced on", sf(driver.buildableZfa) ? (driver.unitCap ? `${sf(driver.buildableZfa)} in the ${driver.unitCap}-unit building` : `${sf(driver.buildableZfa)} the envelope holds`) : null],
    ["MIH area", mih ? `${mih.area}${mih.adopted ? `, mapped ${mih.adopted}` : ""}; ${mih.mappedOptions.join(", ")}` : null],
    ["MIH set-aside", mih?.appliedOption ? (driver.affordableZfa > 0 ? `${mih.appliedOption}: ${pct(mih.affordableShare, 0)} of residential floor area at ${ami}% AMI on average` : mih.appliedOption) : null],
    ["Affordable floor area", driver.affordableZfa > 0 ? `${sf(driver.affordableZfa)} at ${ami}% AMI rents${!mih && finite(fv.affordableRentPsfMonth) ? `, $${Number(fv.affordableRentPsfMonth).toFixed(2)} per SF a month` : ""}` : null],
    ["Real estate taxes", taxesLine(driver)],
    ["Unit cap", unitCapLine(driver)],
    ["Building", `${driver.storeys} storeys, about ${fmtInt(driver.floorplateSqft)} SF a floor, ${pct(driver.netEfficiency, 0)} sellable after halls, lobby and core`],
    ...costRows(driver, dealSettings, costBasis),
    ["Buying costs", buy && finite(buy.cost) ? `${fmtCurrency(buy.cost)} (${buy.transferTaxRate ? `${pct(buy.transferTaxRate, 2)} buyer transfer tax and ` : ""}${pct(buy.closingCostRate)} closing)` : null],
    ["Nearby land sales", nearbyLandSummary(fv.nearbyLand)],
    ["With city financing", fv.subsidizedRental ? `${fmtCurrency(fv.subsidizedRental.landValue)} for the land as an all-affordable rental of ${fmtInt(fv.subsidizedRental.units)} units at ${fv.subsidizedRental.amiPct}% AMI, with HPD and HDC loans and 4% tax credit equity` : null],
  ] : []);
  if (driver && onSetCosts) {
    const setCosts = el("button", "inspector-costs-action", "Set your costs");
    setCosts.type = "button";
    setCosts.addEventListener("click", () => onSetCosts(setCosts));
    section.append(setCosts);
  }
  if (mih?.note) section.append(el("p", "inspector-note", mih.note));
  const hold = tierHold(deal);
  if (hold) section.append(el("p", "inspector-note", hold));
  for (const gate of fv.gates || []) section.append(el("p", "inspector-note", `${gate.label}: ${gate.detail}`));
  return section;
}

// site is the listing's saved site, when it has one: the page then opens that underwriting, and
// Regenerate in More runs it again once no run is underwriting it.
// costBasis holds the house costs and the reader's saved costs, when any, so each cost can say which it is;
// onSetCosts opens the Costs control.
// goal is what the reader is buying for (GOALS); onGoal changes it, and without onGoal the page offers no choice.
export function renderInspector(raw, { dealSettings = {}, costBasis = null, onSetCosts = null, site = null, canStart, onUnderwrite, onOpenSite, onRegenerate, onAsk, onInvestigate, onPlan = null, onCopyLink = null, onClose, goal = "build", onGoal = null }) {
  const deal = normalizeDealRow(raw);
  const verdict = verdictMeta(deal.deal_verdict);
  const root = el("article", `listing-inspector ${verdict.cls}`);
  root.setAttribute("aria-labelledby", "inspector-title");
  root.dataset.listing = deal.listing_id;

  const back = el("button", "inspector-back", "Back to results");
  back.type = "button";
  back.addEventListener("click", onClose);

  const head = el("header", "inspector-head");
  const pills = el("div", "inspector-pills");
  // The deal tier prices the lot for building new; a reader keeping the building sees it named so.
  const tierLabel = TIER_LABELS[deal.deal_verdict] || verdict.label;
  pills.append(el("span", `verdict-pill ${verdict.cls}`, goal === "keep" && onGoal ? `Build-new tier: ${tierLabel}` : tierLabel));
  if (deal.zoning_district_1) pills.append(el("span", "inspector-pill", [deal.zoning_district_1, deal.overlay, deal.specialDistrict].filter(Boolean).join(" / ")));
  if (deal.rentStabilization?.riskLevel === "high") pills.append(el("span", "inspector-pill is-risk", "Rent-stabilization risk"));
  if (deal.landmarkFlag) pills.append(el("span", "inspector-pill is-risk", "Landmark"));
  if (deal.floodZone) pills.append(el("span", "inspector-pill is-risk", "Flood zone"));
  for (const tag of [mihBadge(deal), taxBadge(deal)].filter(Boolean)) {
    const pill = el("span", "inspector-pill", tag.text);
    pill.title = tag.title;
    pills.append(pill);
  }
  const title = el("h2", "", deal.address || `BBL ${deal.bbl}`);
  title.id = "inspector-title";
  title.tabIndex = -1;
  const place = [deal.neighborhood, boroughName(deal.borough), deal.zip_code].filter(Boolean).join(", ");
  const sub = el("p", "inspector-sub", [place, deal.bbl ? `BBL ${deal.bbl}` : "", sf(deal.lot_area_sqft) ? `lot ${sf(deal.lot_area_sqft)}` : ""].filter(Boolean).join(" · "));
  // One prominent action with its reason, and the other ways in behind a menu that names each.
  const actions = el("div", "inspector-actions");
  let primary, reason;
  if (site) {
    primary = el("button", "home-follow primary", "Open underwriting");
    primary.type = "button";
    primary.addEventListener("click", () => onOpenSite(site));
    reason = el("p", "inspector-action-reason inspector-site", siteSummary(site));
  } else {
    const keeping = goal === "keep";
    primary = el("button", "home-follow primary deal-card-underwrite", keeping ? "Underwrite to keep" : "Underwrite");
    primary.type = "button";
    primary.disabled = !canStart();
    primary.addEventListener("click", () => onUnderwrite(deal, keeping ? buildDealKeepPrompt(deal) : buildDealUnderwritePrompt(deal, dealSettings)));
    reason = el("p", "inspector-action-reason", keeping
      ? "What holding it, renovating and renting it, or renovating and selling it pays against the ask."
      : "Full site analysis: what you can build, what it is worth, and whether to buy.");
  }
  const more = el("details", "listings-pop inspector-more");
  const summary = el("summary", "", "More");
  const menu = el("div", "listings-pop-body inspector-menu");
  more.append(summary, menu);
  bindFilterPopover(more, menu);
  menu.setAttribute("aria-label", "More actions for this listing");
  const item = (control, what) => {
    const row = el("div", "inspector-menu-item");
    row.append(control, el("span", "inspector-menu-what", what));
    menu.append(row);
    control.addEventListener("click", () => { more.open = false; });
  };
  if (site && !site.running && site.access !== "viewer") {
    const regenerate = el("button", "home-follow deal-card-underwrite", "Regenerate");
    regenerate.type = "button";
    regenerate.disabled = !canStart();
    regenerate.addEventListener("click", () => onRegenerate(site));
    item(regenerate, "Run the full underwriting again with fresh data and replace the saved results.");
  }
  // The other underwriting stays one click away.
  if (!site && onGoal) {
    const other = el("button", "home-follow deal-card-underwrite", goal === "keep" ? "Underwrite to build" : "Underwrite to keep");
    other.type = "button";
    other.disabled = !canStart();
    other.addEventListener("click", () => onUnderwrite(deal, goal === "keep" ? buildDealUnderwritePrompt(deal, dealSettings) : buildDealKeepPrompt(deal)));
    item(other, goal === "keep" ? "The full site analysis for building new: what the zoning allows, what it is worth and what the land is worth." : "What holding it, renovating and renting it, or renovating and selling it pays against the ask.");
  }
  const ask = el("button", "home-follow", "Ask about this listing");
  ask.type = "button";
  ask.addEventListener("click", () => onAsk(deal));
  item(ask, "A quick question about this listing in the chat, without the full underwriting.");
  if (onPlan) {
    const plan = el("button", "home-follow", "Model this property");
    plan.type = "button";
    plan.disabled = !canStart() || !deal.address;
    if (!deal.address) plan.title = 'A property address is needed to start modeling.';
    plan.addEventListener("click", () => onPlan(deal, buildDealPlanPrompt(deal)));
    item(plan, "Open Modeling to draft a floor plan or explore the building in 3D.");
  }
  if(onInvestigate){
    const investigate=el('button','home-follow','Investigate listing');investigate.type='button';
    investigate.addEventListener('click',()=>onInvestigate(deal));
    item(investigate, "Who owns it, its history and the acquisition risks, from the listing and public records.");
  }
  if (onCopyLink) {
    const copy = el("button", "home-follow", "Copy link");
    copy.type = "button";
    copy.addEventListener("click", () => onCopyLink(deal));
    item(copy, "A link to this listing in Arosa. It opens for anyone signed in.");
  }
  const link = listingLink(deal);
  if (link) {
    link.className = "home-follow inspector-link";
    item(link, "The broker's own page for this offering.");
  }
  actions.append(primary, reason, more);
  const basisLine = tierBasis(deal);
  const method = el("details", "inspector-tier-method");
  method.append(el("summary", "", "How the tier is set"), el("p", "", tierMethod(deal)), helpLink("deal-tiers"));
  // Keeping the building, the tier's basis (what a developer can pay for the land) waits below with the build figures.
  const showTierBasis = basisLine && !(goal === "keep" && onGoal);
  head.append(...(onGoal ? [goalChoice(goal, onGoal)] : []), pills, ...(showTierBasis ? [el("p", "inspector-tier-basis", basisLine), method] : []), title, sub, actions);
  root.append(back, head);
  const kept = keepSection(deal.keep);

  if (deal.photoUrl) {
    const photo = el("img", "inspector-photo");
    photo.src = photoAt(deal.photoUrl, 960, 720);
    photo.alt = "";
    photo.loading = "lazy";
    photo.referrerPolicy = "no-referrer";
    photo.addEventListener("error", () => photo.remove());
    root.append(photo);
  }

  const ppb = pricePerBuildable(deal);
  const room = headroomFar(deal);
  const units = unitEstimate(deal);
  const figures = el("dl", "deal-figures inspector-figures");
  const figure = (label, value, note) => {
    const wrap = el("div", "deal-figure");
    const dd = el("dd");
    dd.append(el("strong", "", value));
    if (note) dd.append(el("small", "", note));
    wrap.append(el("dt", "", label), dd);
    figures.append(wrap);
  };
  figure("Ask", deal.list_price ? fmtCurrency(deal.list_price) : "Unpriced", deal.list_price && finite(deal.price_per_existing_sqft) ? `$${fmtInt(deal.price_per_existing_sqft)} per existing SF` : null);
  figure("Price per buildable SF", finite(ppb) && deal.list_price ? `$${fmtInt(ppb)}` : "Unknown", finite(deal.pricePerBuildableUnit) ? `$${fmtInt(deal.pricePerBuildableUnit)} per planned unit` : null);
  if (finite(deal.any_use_price_per_buildable_zfa) && deal.list_price && finite(deal.any_use_far) && deal.any_use_far > (deal.uap_far ?? deal.resid_far ?? 0)) figure("At the highest FAR of any use", `$${fmtInt(deal.any_use_price_per_buildable_zfa)}`, `${deal.any_use_far} FAR, ${fmtInt(deal.max_any_use_zfa)} SF on paper`);
  figure("Headroom", room !== null ? `+${room.toFixed(2)} FAR` : `+${fmtInt(headroomSqft(deal))} SF`, `${fmtInt(headroomSqft(deal))} SF unused`);
  // The zoning cap and the units a building would actually hold; neither shows where no housing is allowed.
  if (units.max > 0) figure("Most units allowed", fmtInt(units.max), `Zoning cap, one per ${DWELLING_UNIT_FACTOR} SF of floor area`);
  const plan = deal.plannedUnitBasis;
  if (units.planned > 0 && plan) figure("Planned units", fmtInt(units.planned), `Uses ${plan.unitSizes.summary}; ${pct(1 - plan.netEfficiency, 0)} of floor area to halls, lobby and core`);
  // Keeping the building leads when that is what the reader is buying for; otherwise it follows the build figures.
  if (kept && goal === "keep") root.append(kept);
  if (basisLine && !showTierBasis) root.append(el("p", "inspector-tier-basis", basisLine), method);
  root.append(figures);
  if (kept && goal !== "keep") root.append(kept);

  const scale = dealScale(deal);
  if (scale) {
    const box = el("section", "inspector-section");
    box.append(el("h3", "", "Price per buildable SF scale"), scale);
    const land = deal.slidingScale || {};
    if (finite(land.greatDealMaxLandValue) || finite(land.goodDealMaxLandValue)) {
      box.append(el("p", "inspector-note", `${finite(land.greatDealMaxLandValue) ? `A great deal at your costs is ${fmtCurrency(land.greatDealMaxLandValue)} or less` : "No price is a great deal at your costs"}; good up to ${fmtCurrency(land.goodDealMaxLandValue)}.`));
    }
    root.append(box);
  }
  const basisOfValue = valueBasis(deal, { dealSettings, costBasis, onSetCosts });
  if (basisOfValue) root.append(basisOfValue);

  // The envelope figure says what it rests on: the district's bulk rules, estimated geometry where they are
  // not on file, and nothing where no envelope could be drawn for the lot.
  const envelopeBasis = deal.flashcardValuation?.envelopeBasis;
  const fits = sf(deal.achievableUapZfa) && deal.achievableUapZfa < deal.uap_max_buildable_zfa && envelopeBasis !== "paper-only" ? sf(deal.achievableUapZfa) : null;
  root.append(rows("Zoning envelope", [
    ["District", [deal.zoning_district_1, deal.overlay, deal.specialDistrict].filter(Boolean).join(" / ")],
    ["Lot area", sf(deal.lot_area_sqft)],
    ["Existing building", sf(deal.building_sqft) ? `${sf(deal.building_sqft)}${far(deal.built_far) ? `, ${far(deal.built_far)} FAR built` : ""}` : null],
    ["As of right", sf(deal.max_buildable_zfa) ? `${sf(deal.max_buildable_zfa)}${far(deal.standard_far) ? ` at ${far(deal.standard_far)} FAR` : ""}` : null],
    [deal.flashcardValuation?.mih?.status === "inside" ? "With MIH affordable housing" : "With the affordability bonus", sf(deal.uap_max_buildable_zfa) ? `${sf(deal.uap_max_buildable_zfa)}${far(deal.bonus_far) ? ` at ${far(deal.bonus_far)} FAR` : ""}` : null],
    ["Fits the envelope", fits && envelopeBasis === "fallback-geometry" ? `${fits}, estimated: this district's bulk rules are not on file` : fits],
    ["Unused floor area", sf(headroomSqft(deal))],
  ]));

  const fv = deal.flashcardValuation || {};
  root.append(rows("Projections at your costs", [
    ["Gross buildable", sf(deal.estimated_gross_buildable_sqft)],
    ["Construction cost", finite(deal.estimated_construction_cost) ? fmtCurrency(deal.estimated_construction_cost) : null],
    ["Completed value", finite(fv.estimatedRedevValue) ? `${fmtCurrency(fv.estimatedRedevValue)}${fv.completedValueExit === "rental" ? ", as a rental at the good-deal yield" : fv.completedValueExit === "condo" ? ", sold as condominiums" : ""}` : null],
    ["Yield on cost", finite(deal.implied_cap_rate) ? fmtPct(deal.implied_cap_rate) : null],
    ["Condo margin", finite(deal.implied_condo_margin) ? fmtPct(deal.implied_condo_margin) : null],
    ["Submarket sale price", finite(fv.submarketSalePsf) ? `$${fmtInt(fv.submarketSalePsf)} per SF${fv.submarketTierLabel ? `, ${fv.submarketTierLabel}` : ""}` : null],
  ]));

  const tenant = tenantReview(deal.rentStabilization);
  const risks = [["Tenants", tenant.summary]];
  if (deal.corridorProfile?.hasRetailUplift) risks.push(["Ground-floor retail", `About ${fmtInt(deal.corridorProfile.groundFloorRetailSqft)} SF at $${fmtInt(deal.corridorProfile.retailRentPsfYear)} per SF a year`]);
  if (deal.landmarkFlag) risks.push(["Landmark", "Landmarked or in a historic district; changes need Landmarks Preservation Commission approval."]);
  if (finite(deal.yearBuilt) && Number(deal.yearBuilt) > 0) risks.push(["Year built", String(deal.yearBuilt)]);
  const delivery = rows("Delivery", risks);
  const verification = el("div", "inspector-actions");
  for (const source of tenant.verificationLinks || []) {
    const link = listingLink({url: source.url});
    if (!link) continue;
    link.className = "inspector-verification-link";
    link.textContent = source.label;
    link.setAttribute("aria-label", `${source.label} (opens in a new tab)`);
    verification.append(link);
  }
  if (verification.childElementCount) delivery.append(verification);
  root.append(delivery);

  const comps = Array.isArray(deal.similarComps) ? deal.similarComps : [];
  const compsBox = el("section", "inspector-section");
  compsBox.append(el("h3", "", "Comparables"));
  if (!comps.length) compsBox.append(el("p", "inspector-note", "No comparable listings nearby yet."));
  else {
    compsBox.append(el("p", "inspector-note", "Match score weighs location, zoning, street context, buildable size and sale status; a sale within a year counts more than an ask, less as it ages past a year, and an undated sale no more than an ask."));
    const list = el("ul", "inspector-comps");
    for (const c of comps) {
      const item = el("li");
      const main = el("div");
      const review = comparableReview(c);
      const sale = c.listingType === "sold";
      const status = !review.hasPrice ? "Price unverified" : review.date
        ? `${sale ? "Sold" : "For sale"} ${review.date}`
        : `${sale ? "Sold" : "For sale"} · ${sale ? "Sale" : "Listing"} date unavailable`;
      main.append(el("strong", "", c.address || "Comparable"), el("small", "", [status, c.zoningDistrict, finite(c.distanceMiles) ? `${Number(c.distanceMiles).toFixed(2)} mi` : ""].filter(Boolean).join(" · ")));
      const value = el("div", "inspector-comp-value");
      const score = finite(c.similarityScore) && Number(c.similarityScore) >= 0 && Number(c.similarityScore) <= 100
        ? `Match score ${fmtInt(c.similarityScore)}/100` : "Match score unavailable";
      const price = !review.hasPrice ? "Price source unavailable" : review.hasCapacity && finite(c.pricePerBuildableZfa) ? `$${fmtInt(c.pricePerBuildableZfa)}/BSF` : fmtCurrency(c.price);
      value.append(el("strong", "", price), el("small", "", review.hasCapacity ? review.capacityLabel : "Buildable area unavailable"), el("small", "", score));
      const reasons = (c.similarityReasons || []).join(" · ");
      item.append(main, value, el("p", "inspector-comp-reasons", reasons ? `Match details: ${reasons}` : "Match details unavailable."));
      list.append(item);
    }
    compsBox.append(list);
  }
  root.append(compsBox);
  if (deal.nearbyPipeline) root.append(renderNearbyPipeline(deal.nearbyPipeline));

  const basis = Array.isArray(fv.basis) ? fv.basis : [];
  if (basis.length) {
    const box = el("details", "inspector-section inspector-basis");
    box.append(el("summary", "", "Basis for these figures"));
    const list = el("ul");
    for (const b of basis) list.append(el("li", "", `${BASIS[b.item] || b.item}: ${b.source}${b.asOf ? `, as of ${b.asOf}` : ""}`));
    box.append(list);
    root.append(box);
  }
  return root;
}
