// One contract for manual controls, chat snapshots, Jev decisions and query values.
export const FILTER_SCHEMA_ID = "acres.listing-filters/1";
export const BOROUGHS = [["MN", "Manhattan"], ["BK", "Brooklyn"], ["QN", "Queens"], ["BX", "Bronx"], ["SI", "Staten Island"]];
export const TIERS = [["great_deal", "Great"], ["good_deal", "Good"], ["fair_deal", "Fair"], ["full_price", "Full price"], ["unpriced_opportunity", "Unpriced"]];
export const PROPERTY_TYPES = [["multi_family", "Multifamily"], ["townhomes", "Townhouse"], ["single_family", "Single family"], ["duplex_triplex", "Two or three family"], ["land", "Land"]];
export const MIH_AREAS = [["", "Any MIH status"], ["inside", "In MIH areas only"], ["outside", "Outside MIH areas only"]];
export const SORTS = [["best_deal", "Best deals"], ["uap_price_per_buildable_zfa", "Lowest $/BSF"], ["any_use_price_per_buildable_zfa", "Lowest $/BSF, any use"], ["unused_uap_zfa", "Most headroom"], ["implied_yield_on_cost", "Highest yield"], ["implied_condo_margin", "Highest margin"]];
export const DEFAULT_MIN_PRICE = 100000;
export const MIN_UNUSED_ZFA = 250;
const amount = (description, value = null, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({type: ["number", "null"], minimum, maximum, default: value, description});
const enumeration = (description, options, value) => ({type: "string", enum: options.map(([id]) => id), options: Object.fromEntries(options), default: value, description});
const multiple = (description, options) => ({type: "array", items: enumeration(description, options), uniqueItems: true, default: [], description});
export const FILTER_SCHEMA = {
  $id: FILTER_SCHEMA_ID,
  type: "object", additionalProperties: false,
  properties: {
    borough: enumeration("NYC borough; empty means all boroughs", [["", "All boroughs"], ...BOROUGHS], ""),
    area: {type: "string", maxLength: 100, default: "", description: "One or more ZIP codes separated by commas, spaces, semicolons, 'and' or 'or', or a neighborhood name, copied from the prompt; empty means any area"},
    minPrice: amount("Minimum asking price in USD; null removes the minimum", DEFAULT_MIN_PRICE),
    maxPrice: amount("Maximum asking price in USD; null means unlimited"),
    maxPpb: amount("Maximum USD per buildable zoning square foot; null means unlimited"),
    minLot: amount("Minimum lot area in square feet"),
    maxLot: amount("Maximum lot area in square feet"),
    minBuildable: amount("Minimum buildable floor area in square feet: the zoning floor area the lot allows, with the affordability bonus where it applies"),
    minWidth: amount("Minimum lot width (street frontage) in feet"),
    maxWidth: amount("Maximum lot width (street frontage) in feet"),
    minDepth: amount("Minimum lot depth in feet"),
    maxDepth: amount("Maximum lot depth in feet"),
    minProjectCost: amount("Minimum total project cost in USD: the asking price plus the estimated construction cost at the active cost assumptions, where a building is priced; a listing with no ask is figured at its good-deal land threshold"),
    maxProjectCost: amount("Maximum total project cost in USD: the asking price plus the estimated construction cost at the active cost assumptions, where a building is priced; a listing with no ask is figured at its good-deal land threshold"),
    zoning: {type: "string", maxLength: 30, pattern: "^[A-Z0-9/-]*$", default: "", description: "Zoning prefix such as R6 or C4-4D; empty means any zoning"},
    minFar: amount("Minimum unused FAR headroom, e.g. 1.75"),
    tiers: multiple("Included deal verdicts; empty includes every verdict", TIERS),
    types: multiple("Included property types; empty includes every type", PROPERTY_TYPES),
    excludeRisk: {type: "boolean", default: false, description: "Exclude properties at high rent stabilization risk"},
    excludeLandmarks: {type: "boolean", default: false, description: "Exclude landmark properties"},
    mih: enumeration("Mandatory Inclusionary Housing areas: inside keeps only sites in a mapped MIH area, where the affordable set-aside applies and the UAP bonus does not; outside keeps only sites confirmed outside; empty includes both", MIH_AREAS, ""),
    sortBy: enumeration("Listing order", SORTS, "best_deal"),
    followMap: {type: "boolean", default: true, description: "Restrict results to the current map area and update as the map moves; false searches the whole city"},
    hardCostPerGrossSqft: amount("Preview rental construction hard cost in USD per gross square foot; null uses saved baseline", null, 100, 2500),
    condoHardCostPerGrossSqft: amount("Preview condo construction hard cost in USD per gross square foot; null uses the saved baseline condo figure, or the rental figure when none is saved", null, 100, 2500),
    softCostPctOfHard: amount("Preview soft cost as a fraction of hard cost, 22% = 0.22; null uses saved baseline", null, 0, 1),
    carryAndFinancingPct: amount("Preview carry and financing as a fraction, 10% = 0.10; null uses saved baseline", null, 0, 1),
    zfaToGrossFactor: amount("Gross factor, gross-up factor or gross area multiplier: gross floor area = zoning floor area times this factor; null uses saved baseline", null, 1, 1.5),
  },
};
FILTER_SCHEMA.required = Object.keys(FILTER_SCHEMA.properties);
const titles = ["Borough", "ZIP or neighborhood", "Minimum price", "Maximum price", "Maximum $/BSF", "Minimum lot area", "Maximum lot area", "Minimum buildable area", "Minimum lot width", "Maximum lot width", "Minimum lot depth", "Maximum lot depth", "Minimum project cost", "Maximum project cost", "Zoning", "FAR headroom", "Deal tiers", "Property types", "Rent stabilization risk exclusion", "Landmark exclusion", "MIH areas", "Sort", "Follow map", "Rental hard cost", "Condo hard cost", "Soft cost", "Carry and financing", "Gross to zoning factor"];
FILTER_SCHEMA.required.forEach((key, index) => { FILTER_SCHEMA.properties[key].title = titles[index]; });
const COST_PRECISION = {hardCostPerGrossSqft: 0, condoHardCostPerGrossSqft: 0, softCostPctOfHard: 3, carryAndFinancingPct: 3, zfaToGrossFactor: 3};
export const COST_KEYS = Object.keys(COST_PRECISION);
for (const key of COST_KEYS) FILTER_SCHEMA.properties[key].multipleOf = 10 ** -COST_PRECISION[key];
export function normalizeCostValue(key, value) {
  const field = FILTER_SCHEMA.properties[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < field.minimum || value > field.maximum) throw new Error(`Invalid cost: ${key}.`);
  return Number(value.toFixed(COST_PRECISION[key]));
}
export const SEARCH_FILTER_KEYS = FILTER_SCHEMA.required.filter(key => key !== "followMap" && !COST_KEYS.includes(key));
export const defaultFilterValues = () => Object.fromEntries(Object.entries(FILTER_SCHEMA.properties).map(([key, field]) => [key, structuredClone(field.default)]));

// ZIP codes in the area search each ZIP, a ZIP+4 as its five-digit ZIP; text with no ZIP is one place
// name. ZIP codes mixed with other words are refused by the word, never searched as a name. Text that
// is only digits and hyphens with no valid ZIP in it is a mistyped ZIP, refused the same way; a house
// number keeps its street words, so address text is untouched.
const ZIP = /^\d{5}(?:-\d{4})?$/;
export function listingAreaZips(text) {
  const parts = String(text || "").trim().split(/[\s,;]+|\b(?:and|or)\b/i).filter(Boolean);
  if (!parts.some(part => ZIP.test(part))) {
    const mistyped = parts.length && parts.every(part => /^[\d-]+$/.test(part)) ? parts.find(part => part.replace(/-/g, "").length >= 4) : undefined;
    if (mistyped) throw new Error(`ZIP or neighborhood: "${mistyped}" is not a ZIP code. Check the ZIP, or search one place name.`);
    return null;
  }
  const word = parts.find(part => !ZIP.test(part));
  if (word) throw new Error(`ZIP or neighborhood: "${word}" is not a ZIP code. Search ZIP codes or one place name, not both.`);
  return [...new Set(parts.map(part => part.slice(0, 5)))];
}

export function validateFilterValues(values) {
  // Searches recorded before the condo cost joined the schema omit it; default it like any cost.
  if (values && typeof values === "object" && !Array.isArray(values) && !Object.hasOwn(values, "condoHardCostPerGrossSqft")) values = {...values, condoHardCostPerGrossSqft: null};
  if (!values || Array.isArray(values) || typeof values !== "object" || Object.keys(values).length !== FILTER_SCHEMA.required.length) throw new Error("A complete filter state is required.");
  for (const [key, field] of Object.entries(FILTER_SCHEMA.properties)) {
    const value = values[key];
    const invalid = () => { throw new Error(`Invalid filter: ${key}.`); };
    if (value === null && Array.isArray(field.type) && field.type.includes("null")) continue;
    if (field.type === "array") {
      if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(item => !field.items.enum.includes(item))) invalid();
    } else if (Array.isArray(field.type)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < field.minimum || value > field.maximum) invalid();
    } else if (typeof value !== field.type || (field.enum && !field.enum.includes(value)) || (field.maxLength && value.length > field.maxLength) || (field.pattern && !new RegExp(field.pattern).test(value))) invalid();
  }
  listingAreaZips(values.area);
  for (const [min, max] of [["minPrice", "maxPrice"], ["minLot", "maxLot"], ["minWidth", "maxWidth"], ["minDepth", "maxDepth"], ["minProjectCost", "maxProjectCost"]]) {
    if (values[min] !== null && values[max] !== null && values[min] > values[max]) throw new Error(`${min} cannot exceed ${max}.`);
  }
  const normalized = structuredClone(values);
  for (const key of COST_KEYS) if (normalized[key] !== null) normalized[key] = normalizeCostValue(key, normalized[key]);
  return normalized;
}

export function validateFilterSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== FILTER_SCHEMA_ID || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("Invalid filter snapshot.");
  const baselineCosts = {};
  for (const key of COST_KEYS) {
    const value = snapshot.baselineCosts?.[key];
    if (value === undefined) continue;
    const field = FILTER_SCHEMA.properties[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < field.minimum || value > field.maximum) throw new Error(`Invalid baseline: ${key}.`);
    baselineCosts[key] = normalizeCostValue(key, value);
  }
  const result = {schema: FILTER_SCHEMA_ID, revision: snapshot.revision, values: validateFilterValues(snapshot.values), baselineCosts};
  // The condo hard cost is a schema value now (so chat can edit it), but a snapshot keeps the
  // applied figure beside the values as before: a value set in values mirrors beside, and a
  // beside figure from an older snapshot is kept beside, never folded into the values.
  if (result.values.condoHardCostPerGrossSqft != null) result.condoHardCostPerGrossSqft = result.values.condoHardCostPerGrossSqft;
  else if (snapshot.condoHardCostPerGrossSqft != null) result.condoHardCostPerGrossSqft = normalizeCostValue("condoHardCostPerGrossSqft", snapshot.condoHardCostPerGrossSqft);
  if (snapshot.map !== undefined) {
    const map = snapshot.map;
    if (!map || !Number.isSafeInteger(map.revision) || map.revision < 0) throw new Error("Invalid map snapshot.");
    const box = value => {
      if (value === null) return null;
      if (!value || !["south", "west", "north", "east"].every(key => typeof value[key] === "number" && Number.isFinite(value[key])) || value.south > value.north || value.west > value.east) throw new Error("Invalid map bounds.");
      return Object.fromEntries(["south", "west", "north", "east"].map(key => [key, Number(value[key].toFixed(5))]));
    };
    result.map = {revision: map.revision, bounds: box(map.bounds), viewport: box(map.viewport)};
  }
  return result;
}

export function acceptsFilterUpdate(snapshot, update) {
  return update?.base?.schema === snapshot.schema && update.base.revision === snapshot.revision && update.base.map?.revision === snapshot.map?.revision && FILTER_SCHEMA.required.every(key => JSON.stringify(update.base.values?.[key]) === JSON.stringify(snapshot.values[key])) && COST_KEYS.every(key => update.base.baselineCosts?.[key] === snapshot.baselineCosts[key]) && (update.base.condoHardCostPerGrossSqft ?? null) === (snapshot.condoHardCostPerGrossSqft ?? null);
}

// Map coordinates are captured context, not editable filter values. A location change clears the
// old area; turning map-following on uses the viewport captured with the request.
export function listingSnapshotAfterUpdate(snapshot, values = snapshot.values) {
  const base = validateFilterSnapshot(snapshot), next = validateFilterValues(values);
  if (!base.map) return {...base, values: next};
  const locationChanged = ["borough", "area"].some(key => base.values[key] !== next[key]);
  const bounds = !next.followMap || locationChanged ? null : !base.values.followMap ? base.map.viewport : base.map.bounds;
  return {...base, values: next, map: {...base.map, bounds}};
}

// Both the HTTP listings page and native research use this mapping.
export function listingSearchFilters(values) {
  return {
    borough: values.borough || null, area: values.area.trim() || null,
    zoningPrefix: values.zoning.trim().toUpperCase() || null,
    minListPrice: values.minPrice, maxListPrice: values.maxPrice,
    maxPricePerBuildableZfa: values.maxPpb, minLotArea: values.minLot,
    maxLotArea: values.maxLot, minHeadroomFar: values.minFar,
    minBuildableZfa: values.minBuildable, minLotFront: values.minWidth, maxLotFront: values.maxWidth,
    minLotDepth: values.minDepth, maxLotDepth: values.maxDepth,
    minProjectCost: values.minProjectCost, maxProjectCost: values.maxProjectCost,
    dealVerdict: values.tiers.length ? values.tiers.join(",") : null,
    styles: values.types.length ? [...values.types] : null,
    excludeHighStabilizedRisk: values.excludeRisk, excludeLandmarks: values.excludeLandmarks,
    mihArea: values.mih || null, sortBy: values.sortBy, minUnusedZfa: MIN_UNUSED_ZFA,
  };
}

// A complete search to keep or share: every filter with its costs frozen, the map area while it
// follows the map, and the condo hard cost when one is kept beside the rental figure.
export function validateSearchState(state) {
  if (state?.schema !== FILTER_SCHEMA_ID) throw new Error("Unsupported search.");
  // A kept search recorded before a filter joined the schema omits that key; read it at its
  // default, as search links already do, instead of refusing the whole search. Keys the schema
  // does not know still fail the complete-state check, and costs recorded as null stay refused.
  const values = {...defaultFilterValues(), ...(state.values && typeof state.values === "object" && !Array.isArray(state.values) ? state.values : {})};
  const snapshot = validateFilterSnapshot({schema: FILTER_SCHEMA_ID, revision: 0, values, baselineCosts: {}, map: {revision: 0, bounds: state.bounds ?? null, viewport: state.bounds ?? null}});
  // A search recorded before the condo cost joined the schema carries its condo figure only
  // beside the values, or priced condos at the rental hard cost; freeze that figure into the
  // values rather than refuse it. A current explicit null stays null with any beside figure
  // kept beside, exactly as kept searches have always carried it.
  const legacyCondo = !(state.values && Object.hasOwn(state.values, "condoHardCostPerGrossSqft"));
  if (legacyCondo && snapshot.values.condoHardCostPerGrossSqft === null) snapshot.values.condoHardCostPerGrossSqft = state.condoHardCostPerGrossSqft != null
    ? normalizeCostValue("condoHardCostPerGrossSqft", state.condoHardCostPerGrossSqft) : snapshot.values.hardCostPerGrossSqft;
  if (COST_KEYS.some(key => key !== "condoHardCostPerGrossSqft" && snapshot.values[key] === null)) throw new Error("A search needs complete cost assumptions.");
  const box = snapshot.map.bounds;
  if (box && (box.south < -90 || box.north > 90 || box.west < -180 || box.east > 180)) throw new Error("Invalid map bounds.");
  const result = {schema: FILTER_SCHEMA_ID, values: snapshot.values, bounds: snapshot.values.followMap ? box : null};
  const besideCondo = snapshot.values.condoHardCostPerGrossSqft ?? (state.condoHardCostPerGrossSqft != null ? normalizeCostValue("condoHardCostPerGrossSqft", state.condoHardCostPerGrossSqft) : null);
  if (besideCondo !== null) result.condoHardCostPerGrossSqft = besideCondo;
  return result;
}

const BOROUGH_CODES = Object.fromEntries([...BOROUGHS.flatMap(([code, name]) => [[code.toLowerCase(), code], [name.toLowerCase(), code]]), ["new york", "MN"], ["kings", "BK"], ["the bronx", "BX"], ["richmond", "SI"]]);
const STORE_SORTS = {unused_far: "Most unused FAR", far_compression_pct: "Largest price compression"};
const money = value => "$" + Number(value).toLocaleString("en-US");

// The page filters for a recorded store search, the inverse of listingSearchFilters: the same query
// comes back. What the page cannot set is named in differences, and anything invalid throws.
export function listingSearchValues(search) {
  const values = defaultFilterValues(), differences = [];
  const borough = search.borough ? BOROUGH_CODES[String(search.borough).trim().toLowerCase()] : "";
  if (borough === undefined) throw new Error(`Unknown borough: ${search.borough}.`);
  const zip = search.zipCode ? String(search.zipCode).trim() : "", area = search.area ? String(search.area).trim() : "";
  values.area = zip || area;
  if (zip && area && !listingAreaZips(area)?.includes(zip)) differences.push(`"${area}" together with ZIP ${zip}`);
  const tiers = Array.isArray(search.dealVerdict) ? search.dealVerdict : String(search.dealVerdict || "").split(",").map(item => item.trim()).filter(Boolean);
  Object.assign(values, {
    borough, zoning: String(search.zoningPrefix || "").trim().toUpperCase(),
    minPrice: search.minListPrice ?? null, maxPrice: search.maxListPrice ?? null,
    maxPpb: search.maxPricePerBuildableZfa ?? null, minLot: search.minLotArea ?? null, maxLot: search.maxLotArea ?? null,
    minFar: search.minHeadroomFar ?? null, minBuildable: search.minBuildableZfa ?? null,
    minWidth: search.minLotFront ?? null, maxWidth: search.maxLotFront ?? null, minDepth: search.minLotDepth ?? null, maxDepth: search.maxLotDepth ?? null,
    minProjectCost: search.minProjectCost ?? null, maxProjectCost: search.maxProjectCost ?? null,
    tiers: [...new Set(tiers)], types: [...new Set(Array.isArray(search.styles) ? search.styles : String(search.styles || "").split(",").map(item => item.trim()).filter(Boolean))],
    excludeRisk: Boolean(search.excludeHighStabilizedRisk), excludeLandmarks: Boolean(search.excludeLandmarks),
    mih: search.mihArea || "", followMap: Boolean(search.bounds),
  });
  if (STORE_SORTS[search.sortBy]) differences.push(`the order ${STORE_SORTS[search.sortBy]}`);
  else if (search.sortBy) values.sortBy = search.sortBy;
  for (const key of COST_KEYS) values[key] = search[key] ?? null;
  if ((search.listingType || "for_sale") !== "for_sale") differences.push(`${search.listingType} listings, as this page shows listings for sale`);
  if ((search.minUnusedZfa ?? MIN_UNUSED_ZFA) !== MIN_UNUSED_ZFA) differences.push(`at least ${Number(search.minUnusedZfa).toLocaleString("en-US")} SF of unused floor area, as this page keeps ${MIN_UNUSED_ZFA} SF`);
  if (search.maxPricePerBuildableAnyUse != null) differences.push(`an any-use buildable price up to ${money(search.maxPricePerBuildableAnyUse)}/BSF`);
  const state = validateSearchState({schema: FILTER_SCHEMA_ID, values, bounds: search.bounds ?? null, ...(search.condoHardCostPerGrossSqft != null ? {condoHardCostPerGrossSqft: search.condoHardCostPerGrossSqft} : {})});
  return {...state, differences};
}
