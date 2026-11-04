import {BOROUGHS,PROPERTY_TYPES,TIERS,SORTS} from "./listing-filter-schema.js";

const number = value => Number(value).toLocaleString("en-US", {maximumFractionDigits: 3});
const money = value => "$" + Number(value).toLocaleString("en-US", {maximumFractionDigits: 2});
const label = (options, value) => options.find(([key]) => key === value)?.[1] || value;
const list = value => Array.isArray(value) ? value : String(value || "").split(",").filter(Boolean);
const range = (min, max, format) => min != null && max != null ? `${format(min)} to ${format(max)}` : min != null ? `from ${format(min)}` : max != null ? `up to ${format(max)}` : "Any";

function description(search) {
  const f = search.filters;
  const area = [f.borough && label(BOROUGHS, f.borough), f.zipCode, f.area].filter(Boolean).join(" · ") || "NYC";
  const heading = `${area} · ${search.returnedCount} returned`;
  const criteria = [`Asking price: ${range(f.minListPrice, f.maxListPrice, money)}`];
  if (f.zoningPrefix) criteria.push(`Zoning: ${f.zoningPrefix}`);
  if (f.maxPricePerBuildableZfa != null) criteria.push(`Buildable price: up to ${money(f.maxPricePerBuildableZfa)}/BSF`);
  if (f.minLotArea != null || f.maxLotArea != null) criteria.push(`Lot area: ${range(f.minLotArea, f.maxLotArea, number)} SF`);
  if (f.minLotFront != null || f.maxLotFront != null) criteria.push(`Lot width: ${range(f.minLotFront, f.maxLotFront, number)} ft`);
  if (f.minLotDepth != null || f.maxLotDepth != null) criteria.push(`Lot depth: ${range(f.minLotDepth, f.maxLotDepth, number)} ft`);
  if (f.minBuildableZfa != null) criteria.push(`Buildable: at least ${number(f.minBuildableZfa)} SF`);
  if (f.minProjectCost != null || f.maxProjectCost != null) criteria.push(`Project cost: ${range(f.minProjectCost, f.maxProjectCost, (n) => `$${number(n)}`)}`);
  if (f.minHeadroomFar != null) criteria.push(`Unused FAR: at least ${number(f.minHeadroomFar)}`);
  criteria.push(`Unused floor area: at least ${number(f.minUnusedZfa)} ZFA`);
  if (list(f.styles).length) criteria.push(`Property types: ${list(f.styles).map(value => label(PROPERTY_TYPES, value)).join(", ")}`);
  if (list(f.dealVerdict).length) criteria.push(`Deal tiers: ${list(f.dealVerdict).map(value => label(TIERS, value)).join(", ")}`);
  if (f.excludeHighStabilizedRisk) criteria.push("High rent-stabilization risk excluded");
  if (f.excludeLandmarks) criteria.push("Landmarks excluded");
  if (f.mihArea) criteria.push(f.mihArea === "inside" ? "In MIH areas only" : "Outside MIH areas only");
  const status = {for_sale: "For sale", sold: "Sold", pending: "Pending"}[f.listingType];
  const order = {unused_uap_zfa: "Most unused floor area", unused_far: "Most unused FAR", far_compression_pct: "Largest price compression"}[f.sortBy] || label(SORTS, f.sortBy);
  const rentalHard = f.rentalHardCostPerGrossSqft ?? f.hardCostPerGrossSqft, condoHard = f.condoHardCostPerGrossSqft ?? rentalHard;
  const hardText = condoHard !== rentalHard ? `${money(rentalHard)}/GSF rental hard cost · ${money(condoHard)}/GSF condo hard cost` : `${money(rentalHard)}/GSF hard cost`;
  const costs = `${hardText} · ${number(f.softCostPctOfHard * 100)}% soft cost · ${number(f.carryAndFinancingPct * 100)}% carry and financing · ${number(f.zfaToGrossFactor)}× gross factor`;
  return {heading, lines: [f.bounds ? "Selected map area" : "No map boundary", status, ...criteria, `Order: ${order}`, `Up to ${number(f.limit)} results requested`, `Costs: ${costs}`]};
}

export function listingSearchesText(searches) {
  if (!searches?.length) return "";
  return searches.map(search => {const item = description(search);return [item.heading, ...item.lines].join("\n");}).join("\n\n");
}

// reuse offers each search's filters, map area and costs back to the listings page.
export function listingSearchesView(searches, messageIndex, {reuse = false} = {}) {
  if (!searches?.length) return null;
  const section = document.createElement("section");
  section.className = "listing-searches";
  section.setAttribute("aria-label", "Listing searches used");
  const title = document.createElement("h3");title.textContent = "Listing searches";section.append(title);
  for (const [index, search] of searches.entries()) {
    const item = description(search), details = document.createElement("details"), summary = document.createElement("summary");
    summary.textContent = `${item.heading} · ${money(search.filters.hardCostPerGrossSqft)}/GSF`;details.append(summary);
    const content = document.createElement("div");content.className = "listing-search-details";
    for (const line of item.lines) {const p = document.createElement("p");p.textContent = line;content.append(p);}
    if (search.sourceId != null) {
      const source = document.createElement("button");source.type = "button";source.className = "listing-search-source";
      source.textContent = "View search evidence";source.dataset.message = messageIndex;source.dataset.source = search.sourceId;content.append(source);
    }
    if (reuse) {
      const use = document.createElement("button");use.type = "button";use.className = "listing-search-use";
      use.textContent = "Use these filters";use.title = "Apply this search's filters, map area and costs. Undo returns to your current filters.";
      use.dataset.message = messageIndex;use.dataset.listingSearch = index;content.append(use);
    }
    details.append(content);section.append(details);
  }
  return section;
}
