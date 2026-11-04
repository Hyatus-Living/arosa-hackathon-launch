// The NYC listings page's filters, the store query they make, how they read as text, and the context a
// chat message from the page carries. Pure functions, so the page and the tests share them.

export const PAGE_SIZE = 20;

import { BOROUGHS, TIERS, PROPERTY_TYPES, SORTS, MIH_AREAS, DEFAULT_MIN_PRICE, MIN_UNUSED_ZFA, SEARCH_FILTER_KEYS, defaultFilterValues, listingSearchFilters } from "./listing-filter-schema.js";
export { BOROUGHS, TIERS, PROPERTY_TYPES, SORTS, MIH_AREAS, DEFAULT_MIN_PRICE, MIN_UNUSED_ZFA };

export const HEADROOM_STEPS = [0.5, 1, 2, 3];

export function defaultFilters() {
  const values = defaultFilterValues();
  return Object.fromEntries(SEARCH_FILTER_KEYS.map(key => [key, values[key]]));
}

// The legacy hard cost rides along as the rental figure; the split keys price each exit.
const COST_KEYS = ["hardCostPerGrossSqft", "rentalHardCostPerGrossSqft", "condoHardCostPerGrossSqft", "softCostPctOfHard", "carryAndFinancingPct", "zfaToGrossFactor"];

// The store query for the filters. Pins take every match and a page its slice; while the list follows
// the map, both take the map's bounds, so each pin's rank is its card's number.
export function queryParams(filters, { offset = 0, bounds = null, costs = null, pins = false } = {}) {
  const p = new URLSearchParams();
  const set = (key, value) => {
    if (value !== null && value !== undefined && value !== "" && value !== false) p.set(key, String(value));
  };
  for (const [key, value] of Object.entries(listingSearchFilters(filters))) set(key, value);
  if (costs) for (const key of COST_KEYS) set(key, costs[key]);
  if (!pins) {
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(offset));
    p.set("includeSimilarComps", "false");
  }
  if (bounds) p.set("bounds", [bounds.south, bounds.west, bounds.north, bounds.east].map((n) => n.toFixed(5)).join(","));
  return p;
}

export function money(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1e6) return `$${Number((n / 1e6).toFixed(n >= 1e7 ? 0 : 1))}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

const sqft = (n) => `${Math.round(n).toLocaleString("en-US")} SF`;
const labelOf = (list, value) => list.find(([v]) => v === value)?.[1] || value;

export function rangeText(min, max, unit) {
  if (min != null && max != null) return `${unit(min)} to ${unit(max)}`;
  if (min != null) return `${unit(min)}+`;
  if (max != null) return `up to ${unit(max)}`;
  return "";
}

// One short phrase per filter that differs from showing everything, for filter buttons, the chat
// context and the receipt of a change the chat made.
export function describeFilters(f) {
  const parts = [];
  if (f.borough) parts.push(labelOf(BOROUGHS, f.borough));
  if (f.area.trim()) parts.push(f.area.trim());
  const price = rangeText(f.minPrice, f.maxPrice, money);
  if (price) parts.push(`ask ${price}`);
  if (f.maxPpb !== null) parts.push(`up to $${f.maxPpb}/BSF`);
  const lot = rangeText(f.minLot, f.maxLot, sqft);
  if (lot) parts.push(`lot ${lot}`);
  const feet = (n) => `${Number(n).toLocaleString("en-US")} ft`;
  const width = rangeText(f.minWidth, f.maxWidth, feet);
  if (width) parts.push(`${width} wide`);
  const depth = rangeText(f.minDepth, f.maxDepth, feet);
  if (depth) parts.push(`${depth} deep`);
  if (f.minBuildable !== null) parts.push(`at least ${sqft(f.minBuildable)} buildable`);
  const cost = rangeText(f.minProjectCost, f.maxProjectCost, money);
  if (cost) parts.push(`project cost ${cost}`);
  if (f.zoning.trim()) parts.push(`zoning ${f.zoning.trim().toUpperCase()}`);
  if (f.minFar !== null) parts.push(`at least +${f.minFar} FAR unused`);
  if (f.tiers.length) parts.push(`${f.tiers.map((t) => labelOf(TIERS, t)).join(" or ")} deals`);
  if (f.types.length) parts.push(f.types.map((t) => labelOf(PROPERTY_TYPES, t)).join(" or "));
  if (f.excludeRisk) parts.push("no rent-stabilization risk");
  if (f.excludeLandmarks) parts.push("no landmarks");
  if (f.mih) parts.push(f.mih === "inside" ? "in MIH areas" : "outside MIH areas");
  return parts;
}

const BOROUGH_NAMES = { manhattan: "MN", "new york": "MN", brooklyn: "BK", kings: "BK", queens: "QN", bronx: "BX", "the bronx": "BX", "staten island": "SI", richmond: "SI" };
const boroughCode = (value) => {
  const v = String(value || "").trim().toLowerCase();
  return BOROUGH_NAMES[v] || (BOROUGHS.some(([code]) => code.toLowerCase() === v) ? v.toUpperCase() : "");
};
const positive = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);

// The page filters for a deal store search the chat ran. Anything the search left unset is at its
// default, so the map matches the listings the answer is about.
export function filtersFromSearch(search = {}) {
  const f = defaultFilters();
  f.borough = boroughCode(search.borough);
  // The page has one area box; a ZIP is the narrower of the two when the search set both.
  f.area = String(search.zipCode || search.area || "").trim();
  f.zoning = String(search.zoningPrefix || "").trim().toUpperCase();
  f.minPrice = positive(search.minListPrice) ?? DEFAULT_MIN_PRICE;
  f.maxPrice = positive(search.maxListPrice);
  f.maxPpb = positive(search.maxPricePerBuildableZfa);
  f.minLot = positive(search.minLotArea);
  f.maxLot = positive(search.maxLotArea);
  f.minBuildable = positive(search.minBuildableZfa);
  f.minWidth = positive(search.minLotFront);
  f.maxWidth = positive(search.maxLotFront);
  f.minDepth = positive(search.minLotDepth);
  f.maxDepth = positive(search.maxLotDepth);
  f.minProjectCost = positive(search.minProjectCost);
  f.maxProjectCost = positive(search.maxProjectCost);
  f.minFar = positive(search.minHeadroomFar);
  const tiers = String(search.dealVerdict || "").split(",").map((s) => s.trim());
  f.tiers = TIERS.map(([v]) => v).filter((v) => tiers.includes(v));
  const types = Array.isArray(search.styles) ? search.styles : String(search.styles || "").split(",");
  f.types = PROPERTY_TYPES.map(([v]) => v).filter((v) => types.includes(v));
  f.excludeRisk = search.excludeHighStabilizedRisk === true;
  f.excludeLandmarks = search.excludeLandmarks === true;
  if (MIH_AREAS.some(([v]) => v && v === search.mihArea)) f.mih = search.mihArea;
  if (SORTS.some(([v]) => v === search.sortBy)) f.sortBy = search.sortBy;
  return f;
}

// What a message sent from the listings page tells Arosa: the filters, how many listings match, the
// first cards on screen and the listing the reader has open.
export function listingsContext({ filters, total, deals = [], selected = null }) {
  const shown = describeFilters(filters);
  const lines = [
    `Deals page: ${total} NYC listings for sale${shown.length ? ` (${shown.join(", ")})` : ""}, sorted by ${labelOf(SORTS, filters.sortBy).toLowerCase()}.`,
  ];
  if (selected) lines.push(`Open listing: ${listingLine(selected)}.`);
  const top = deals.slice(0, 5).map(listingLine);
  if (top.length) lines.push(`First on the page: ${top.join("; ")}.`);
  // Brackets would end the note early, so none reach it from typed filters or addresses.
  return lines.join(" ").replace(/[[\]]/g, "");
}

function listingLine(d) {
  const ask = Number.isFinite(d.listPrice) ? `ask ${money(d.listPrice)}` : "unpriced";
  const bbl = d.bbl ? `BBL ${d.bbl}` : "";
  return [d.address || bbl, bbl && d.address ? bbl : "", d.zoningDistrict, ask].filter(Boolean).join(", ");
}

// The message the chat runs: the page context in front when both fit the limit, else the text alone.
export function withListingsContext(text, context, limit = 3000) {
  const message = `[${context}]\n\n${text}`;
  return message.length <= limit ? message : text;
}

// A user message sent from the page shows the reader's words; the bracketed context stays with Arosa.
export function splitListingsContext(text) {
  const match = /^\[(Deals page: [^\]]*)\]\n\n([\s\S]*)$/.exec(text || "");
  return match ? { context: match[1], text: match[2] } : { context: null, text };
}
