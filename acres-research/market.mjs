// Market inputs for the subject site's submarket: residential rents and condo sale prices per
// square foot by bedroom count, commercial rents by use, existing supply and vacancy, the pipeline
// and absorption. Every figure carries its source and retrieval date. Figures come from the user or
// from public sources the agent cites; there is no licensed data feed, so this module validates
// shape and units and never fills a gap. Money is USD, areas are sq ft, rates are fractions.
import {createHash} from 'node:crypto';
import {COST_KEYS, FILTER_SCHEMA, normalizeCostValue, validateFilterSnapshot, listingSearchFilters} from './listing-filter-schema.mjs';
import {requestSignal,throwIfCancelled} from './execution-context.mjs';
import {DEAL_SCREEN_ASSUMPTIONS, unitSizesFor, unitSizeSummary} from './market-store.mjs';

export const BEDROOM_LABELS = ['Studio', 'One bedroom', 'Two bedroom', 'Three bedroom'];
export const COMMERCIAL_USES = ['retail', 'office', 'community_facility'];
// Planning baselines by unit count for studio, one, two and three bedrooms, net unit sizes in sq ft and
// net-to-gross efficiency: the deal screen's assumed mix and efficiency (market-store DEAL_UNIT_MIX and
// zfaToNetEfficiency), so a deal card and the unit mix count units the same way. The rental mix has no
// three-bedroom units, so it has no three-bedroom size. They are starting assumptions in every city,
// never local evidence: the agent replaces them with the submarket's own figures, and the unit mix
// reports them as assumptions when used.
export const BASELINES = {
  rental: {mixPercent: [30, 45, 25, 0], unitSizesSqft: [450, 550, 800, null], efficiency: 0.85},
  condo: {mixPercent: [15, 45, 30, 10], unitSizesSqft: [550, 750, 1100, 1450], efficiency: 0.85},
};
const round = (n, d = 0) => Number(n.toFixed(d));

export function num(value, name, min, max) {
  if (!(Number.isFinite(value) && value >= min && value <= max)) throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return value;
}
export function int(value, name, min, max) {
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
  return num(value, name, min, max);
}
function text(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} is required, up to ${max} characters.`);
  return value.trim();
}
function isoDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be a date as YYYY-MM-DD.`);
  return value;
}
// One figure: its fields (a numeric range [min, max, whole] or a list of allowed words) within sane
// NYC ranges, which also catch unit mix-ups such as an annual rent passed as monthly, then the
// source, the retrieval date and the optional URL and basis.
export function figure(row, name, fields) {
  if (!row || typeof row !== 'object') throw new Error(`${name} must be an object.`);
  const out = {};
  for (const [field, spec] of Object.entries(fields)) {
    if (spec.words) { if (!spec.words.includes(row[field])) throw new Error(`${name}.${field} must be one of ${spec.words.join(', ')}.`); out[field] = row[field]; }
    else out[field] = (spec[2] ? int : num)(row[field], `${name}.${field}`, spec[0], spec[1]);
  }
  out.source = text(row.source, `${name}.source`);
  out.retrievedAt = isoDate(row.retrievedAt, `${name}.retrievedAt`);
  out.url = row.url == null ? null : text(row.url, `${name}.url`, 2000);
  out.basis = row.basis == null ? null : text(row.basis, `${name}.basis`, 600);
  return out;
}
function rows(list, name, fields, key) {
  if (!Array.isArray(list) || !list.length || list.length > 12) throw new Error(`${name} must be a list of 1 to 12 rows.`);
  const out = list.map((row, i) => figure(row, `${name}[${i}]`, fields));
  if (new Set(out.map(row => row[key])).size !== out.length) throw new Error(`${name} must have one row per ${key}.`);
  return out;
}

// Validates the tool arguments and returns the normalized market inputs. Sections are independent:
// each is present only when supplied, and derived indicators use the sections that are present.
export function normalizeMarketInputs(args) {
  const market = {submarket: text(args.submarket, 'submarket', 120)};
  if (args.rents !== undefined) market.rents = rows(args.rents, 'rents', {bedrooms: [0, 3, true], rentPerSqftPerMonth: [1, 30]}, 'bedrooms');
  if (args.salePrices !== undefined) market.salePrices = rows(args.salePrices, 'salePrices', {bedrooms: [0, 3, true], pricePerSqft: [100, 15000]}, 'bedrooms');
  if (args.commercialRents !== undefined) market.commercialRents = rows(args.commercialRents, 'commercialRents', {use: {words: COMMERCIAL_USES}, rentPerSqftPerYear: [5, 3000]}, 'use');
  if (args.supply !== undefined) market.supply = figure(args.supply, 'supply', {units: [0, 10_000_000, true], vacancyRate: [0, 1]});
  if (args.pipeline !== undefined) market.pipeline = figure(args.pipeline, 'pipeline', {units: [0, 1_000_000, true], horizonYears: [0.5, 10]});
  if (args.absorption !== undefined) market.absorption = figure(args.absorption, 'absorption', {unitsPerMonth: [0, 100000]});
  if (Object.keys(market).length === 1) throw new Error('Supply at least one section: rents, salePrices, commercialRents, supply, pipeline or absorption.');
  return market;
}

export function indicators(market) {
  const out = {};
  if (market.pipeline && market.absorption && market.absorption.unitsPerMonth > 0) out.monthsOfSupply = round(market.pipeline.units / market.absorption.unitsPerMonth, 1);
  if (market.pipeline && market.supply && market.supply.units > 0) out.pipelineShareOfSupply = round(market.pipeline.units / market.supply.units, 4);
  if (market.supply) out.vacantUnits = Math.round(market.supply.units * market.supply.vacancyRate);
  return out;
}

// Largest-remainder allocation of whole units to the mix percentages, so counts sum to the total.
export function allocate(total, percents) {
  const raw = percents.map(p => total * p / 100);
  const counts = raw.map(Math.floor);
  const order = raw.map((v, i) => [v - counts[i], i]).sort((a, b) => b[0] - a[0]);
  const left = total - counts.reduce((a, b) => a + b, 0);
  for (let k = 0; k < left; k++) counts[order[k][1]]++;
  return counts;
}

// A building served by stairs, an elevator and halls keeps at most about 90% of its residential gross
// floor area as net rentable or sellable area. Above that the core and circulation are not deducted.
export const MAX_CORE_SERVED_EFFICIENCY = 0.9;
export const coreEfficiencyAssumption = efficiency => efficiency > MAX_CORE_SERVED_EFFICIENCY
  ? `Net-to-gross efficiency ${round(efficiency, 3)} is above ${MAX_CORE_SERVED_EFFICIENCY}: no core or circulation is deducted for stairs, elevators and halls, so units and revenue are overstated unless the plan shows that efficiency.`
  : null;

// Unit counts, net areas and, when market figures exist, rent or price per unit for a residential
// gross floor area. Mix percentages are by unit count; unit sizes are net sq ft per unit. With the storeys
// the efficiency loses the deal screen's stair and elevator core on each floor; measured holds the deal
// screen's measured mix and sizes for the site's area ({mixPercent, unitSizesSqft, summary}).
export function recommendUnitMix({productType, residentialGrossSqft, efficiency, mixPercent, unitSizesSqft, maxDwellingUnits, storeys}, market = null, measured = null) {
  if (!BASELINES[productType]) throw new Error('productType must be rental or condo.');
  const baseline = BASELINES[productType], assumptions = [];
  num(residentialGrossSqft, 'residentialGrossSqft', 500, 10_000_000);
  if (efficiency === undefined && storeys !== undefined) {
    int(storeys, 'storeys', 1, 200);
    const {walkUpMaxStoreys, corePerFloorSqft} = DEAL_SCREEN_ASSUMPTIONS, floorplate = residentialGrossSqft / storeys;
    const core = storeys > walkUpMaxStoreys ? corePerFloorSqft.elevator : corePerFloorSqft.walkUp;
    efficiency = Math.max(0, Math.min(baseline.efficiency, (floorplate - core) / floorplate));
    assumptions.push(`Net-to-gross efficiency ${round(efficiency, 3)} is the ${productType} planning baseline less a ${core} SF stair and elevator core on each of ${storeys} floors of ${Math.round(floorplate)} SF, as the deal screen deducts it.`);
  } else if (efficiency === undefined) {
    efficiency = baseline.efficiency;
    assumptions.push(`Net-to-gross efficiency ${baseline.efficiency} is the ${productType} planning baseline. No floorplate core was deducted: give the storeys to deduct the stair and elevator core on each floor as the deal screen does.`);
  }
  else num(efficiency, 'efficiency', 0.5, 1);
  if (measured && mixPercent === undefined && unitSizesSqft === undefined) {
    ({mixPercent, unitSizesSqft} = measured);
    assumptions.push(`Unit mix and sizes are the deal screen's measured ${measured.summary}.`);
  }
  if (coreEfficiencyAssumption(efficiency)) assumptions.push(coreEfficiencyAssumption(efficiency));
  if (mixPercent === undefined) { mixPercent = baseline.mixPercent; assumptions.push(`The unit mix ${baseline.mixPercent.join('/')} (studio/one/two/three) is the ${productType} planning baseline, not a market reading.`); }
  else {
    if (!Array.isArray(mixPercent) || mixPercent.length !== 4) throw new Error('mixPercent must list four percentages: studio, one, two and three bedrooms.');
    mixPercent.forEach((p, i) => num(p, `mixPercent[${i}]`, 0, 100));
    if (Math.abs(mixPercent.reduce((a, b) => a + b, 0) - 100) > 0.5) throw new Error('mixPercent must sum to 100.');
  }
  if (unitSizesSqft === undefined) {
    unitSizesSqft = baseline.unitSizesSqft;
    const missing = mixPercent.findIndex((p, i) => p > 0 && unitSizesSqft[i] === null);
    if (missing >= 0) throw new Error(`Give unitSizesSqft: the ${productType} planning baseline has no ${BEDROOM_LABELS[missing].toLowerCase()} size.`);
    assumptions.push(`Target unit sizes ${baseline.unitSizesSqft.filter(s => s !== null).join('/')} sq ft are the ${productType} planning baseline, the sizes the deal screen assumes where it measures too few listings.`);
  } else {
    if (!Array.isArray(unitSizesSqft) || unitSizesSqft.length !== 4) throw new Error('unitSizesSqft must list four net unit sizes: studio, one, two and three bedrooms.');
    // A unit type the mix leaves out needs no size.
    unitSizesSqft.forEach((s, i) => (s === null && mixPercent[i] === 0) || num(s, `unitSizesSqft[${i}]`, 250, 5000));
  }
  const netResidentialSqft = residentialGrossSqft * efficiency;
  const mixTotal = mixPercent.reduce((a, b) => a + b, 0);
  const shares = mixPercent.map(p => p * 100 / mixTotal);
  const averageUnitSqft = shares.reduce((sum, p, i) => sum + p / 100 * unitSizesSqft[i], 0);
  let units = Math.floor(netResidentialSqft / averageUnitSqft);
  if (units < 1) throw new Error('The residential floor area is smaller than one unit at these sizes.');
  // The count never exceeds the legal density the caller supplies (the zoning envelope's maximum).
  if (maxDwellingUnits !== undefined) {
    int(maxDwellingUnits, 'maxDwellingUnits', 1, 100_000);
    if (units > maxDwellingUnits) { assumptions.push(`Capped at ${maxDwellingUnits} dwelling units, the legal density supplied; ${units} would fit the net area at these sizes, so the units are larger than the target sizes on average.`); units = maxDwellingUnits; }
  } else assumptions.push('Legal density was not checked: no maximum dwelling units was supplied, so the count may exceed what the zoning allows. Pass the zoning envelope\'s maxDwellingUnits (in NYC the dwelling unit factor, ZR 23-52) to cap it.');
  const targetUnits = units;
  let counts = allocate(units, shares);
  // Whole-unit apportionment can exceed the area implied by a fractional average unit.
  while (units > 0 && counts.reduce((sum, count, i) => sum + count * unitSizesSqft[i], 0) > netResidentialSqft) {
    counts = allocate(--units, shares);
  }
  if (units < 1) throw new Error('No whole-unit allocation fits the residential area at this target mix and unit sizes.');
  if (Math.abs(mixTotal - 100) > 1e-9) assumptions.push(`Target mix percentages were normalized from ${round(mixTotal, 3)}% to 100% for sizing and allocation.`);
  if (units < targetUnits) assumptions.push(`Whole-unit allocation was reduced from ${targetUnits} to ${units} units to fit the net residential area at the target mix and unit sizes.`);
  const rental = productType === 'rental';
  const figures = (rental ? market?.rents : market?.salePrices) ?? [];
  const byBedrooms = counts.map((count, bedrooms) => {
    const fig = figures.find(r => r.bedrooms === bedrooms) ?? null;
    const sized = fig && unitSizesSqft[bedrooms] !== null ? fig : null;
    const row = {bedrooms, label: BEDROOM_LABELS[bedrooms], mixPercent: mixPercent[bedrooms], units: count, unitSqft: unitSizesSqft[bedrooms], netSqft: count * (unitSizesSqft[bedrooms] ?? 0), sourceId: fig?.sourceId ?? null, sourceKey: fig?.sourceKey ?? null};
    if (rental) return {...row, rentPerSqftPerMonth: fig?.rentPerSqftPerMonth ?? null, monthlyRent: sized ? round(sized.rentPerSqftPerMonth * row.unitSqft) : null, annualRent: sized ? round(sized.rentPerSqftPerMonth * row.netSqft * 12) : null};
    return {...row, pricePerSqft: fig?.pricePerSqft ?? null, unitPrice: sized ? round(sized.pricePerSqft * row.unitSqft) : null, sellout: sized ? round(sized.pricePerSqft * row.netSqft) : null};
  });
  const allocatedNetSqft = byBedrooms.reduce((sum, r) => sum + r.netSqft, 0);
  const unpriced = byBedrooms.filter(r => r.units > 0 && (rental ? r.rentPerSqftPerMonth : r.pricePerSqft) === null);
  const revenue = unpriced.length ? {note: `No ${rental ? 'rent' : 'sale price'} figure for ${unpriced.map(r => r.label.toLowerCase()).join(', ')} units; record them with acres_market_inputs for revenue.`}
    : rental
      ? {annualGrossPotentialRent: byBedrooms.reduce((sum, r) => sum + r.annualRent, 0), blendedRentPerSqftPerMonth: round(byBedrooms.reduce((sum, r) => sum + r.units * r.monthlyRent, 0) / allocatedNetSqft, 2)}
      : {grossSellout: byBedrooms.reduce((sum, r) => sum + r.sellout, 0), blendedPricePerSqft: round(byBedrooms.reduce((sum, r) => sum + r.sellout, 0) / allocatedNetSqft)};
  return {productType, residentialGrossSqft, efficiency, netResidentialSqft, averageUnitSqft: round(averageUnitSqft, 1), units, maxDwellingUnits: maxDwellingUnits ?? null, allocatedNetSqft, unallocatedNetSqft: netResidentialSqft - allocatedNetSqft, byBedrooms, ...revenue, assumptions};
}

const figureRow = (fields, description) => ({type: 'object', additionalProperties: false, description, properties: {...fields, source: {type: 'string', description: 'Who reported the figure: the publication, data set or the user.'}, url: {type: 'string', description: 'Public URL of the source when there is one, so it becomes a citable source.'}, retrievedAt: {type: 'string', description: 'Date the figure was retrieved or stated, YYYY-MM-DD.'}, basis: {type: 'string', description: 'How the figure was derived when it was converted, for example a median asking rent divided by a typical unit size.'}}, required: [...Object.keys(fields), 'source', 'retrievedAt']});
const bedrooms = {type: 'integer', minimum: 0, maximum: 3, description: '0 for studio, 1, 2 or 3 bedrooms.'};

export const marketDefinition = {
  name: 'acres_market_inputs',
  description: 'Record the market inputs for the subject site\'s submarket: residential rents in USD per sq ft per month and condo sale prices in USD per sq ft by bedroom count, commercial rents in USD per sq ft per year by use, existing supply with its vacancy rate, the development pipeline and monthly absorption. Every figure needs its source and retrieval date; give the public URL when there is one so it becomes a citable source, and state the basis when you converted a quoted figure. Figures come from the user or from public sources you retrieved; there is no licensed data feed and the tool never fills a gap, so record only the sections you have. Recording replaces the previous inputs for this answer. Returns the normalized figures with source IDs and the derived indicators (months of supply, pipeline share of supply, vacant units).',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      submarket: {type: 'string', description: 'The submarket the figures describe, for example "Financial District, Manhattan".'},
      rents: {type: 'array', maxItems: 12, items: figureRow({bedrooms, rentPerSqftPerMonth: {type: 'number', description: 'Asking or achieved rent, USD per net sq ft per month for the site submarket (for scale, prime NYC product runs about 3 to 15).'}}, 'Residential rental rent by bedroom count.')},
      salePrices: {type: 'array', maxItems: 12, items: figureRow({bedrooms, pricePerSqft: {type: 'number', description: 'Condo sale price, USD per net sq ft.'}}, 'Condo sale price by bedroom count.')},
      commercialRents: {type: 'array', maxItems: 12, items: figureRow({use: {type: 'string', enum: COMMERCIAL_USES}, rentPerSqftPerYear: {type: 'number', description: 'Asking rent, USD per sq ft per year.'}}, 'Commercial rent by use.')},
      supply: figureRow({units: {type: 'integer', description: 'Existing residential units in the submarket.'}, vacancyRate: {type: 'number', description: 'Vacancy as a fraction, 0.03 for 3 percent.'}}, 'Existing inventory and vacancy.'),
      pipeline: figureRow({units: {type: 'integer', description: 'Units under construction or permitted.'}, horizonYears: {type: 'number', description: 'Years over which the pipeline delivers.'}}, 'Development pipeline. Give exactly one of pipeline or pipelineSource.'),
      pipelineSource: {type: 'string', enum: ['ledger'], description: 'ledger: the pipeline is the NYC development ledger\'s DOB new building and major alteration filings in the subject ZIP over the last 24 months that DOB has approved or permitted (their proposed dwelling units and job count, the filing window as the horizon; jobs at other stages are named in the basis, not counted), cited as an official record.'},
      absorption: figureRow({unitsPerMonth: {type: 'number', description: 'Net units leased or sold per month in the submarket.'}}, 'Absorption.'),
    },
    required: ['submarket'],
  },
};
export const unitMixDefinition = {
  name: 'acres_unit_mix',
  description: 'Compute a unit mix for the residential gross floor area of a concept: unit counts by studio, one, two and three bedrooms from mix percentages and target net unit sizes, the net residential area at the stated net-to-gross efficiency and, when market inputs are recorded, the rent or sale price per unit and the blended figure. Omitted mix, sizes and efficiency use the stated planning baseline for the product type (the deal screen\'s assumed mix and efficiency) and come back as assumptions; replace them with the submarket evidence when you have it. Pass maxDwellingUnits from the zoning envelope so the count never exceeds the legal density. Take the residential gross floor area from the concept (acres_model_concept reports storey areas by use) or from the zoning envelope.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      productType: {type: 'string', enum: ['rental', 'condo']},
      residentialGrossSqft: {type: 'number', description: 'Residential gross floor area in sq ft.'},
      efficiency: {type: 'number', description: 'Net rentable or sellable area divided by gross residential area, 0.5 to 1. Above 0.9 the result flags that no core or circulation is deducted.'},
      mixPercent: {type: 'array', items: {type: 'number'}, minItems: 4, maxItems: 4, description: 'Percent of units that are studios, one, two and three bedrooms, in that order, summing to 100.'},
      unitSizesSqft: {type: 'array', items: {type: 'number'}, minItems: 4, maxItems: 4, description: 'Target net sq ft per unit for studios, one, two and three bedrooms.'},
      maxDwellingUnits: {type: 'integer', minimum: 1, description: 'Most dwelling units the zoning allows (the zoning envelope\'s maxDwellingUnits). The count is capped there; omitted, it is auto-filled from the zoning envelope on file when there is one, else the result says legal density was not checked.'},
      storeys: {type: 'integer', minimum: 1, description: 'Storeys the residential area is spread over. Without an efficiency, each floor loses the deal screen\'s stair and elevator core (250 SF walk-up, 400 SF above five storeys).'},
    },
    required: ['productType', 'residentialGrossSqft'],
  },
};

export const marketCompsDefinition = {
  name: 'acres_market_comps',
  description: 'Harvest MLS / Realtor.com property comparables via HomeHarvest for a requested US address, ZIP or city/state. Compute sale/rent medians, sizes and days on market by bedroom count. Record listing evidence when URLs exist. Matching provider results can populate market inputs; broader fallback results and stored ZIP aggregates are labeled references and keep market inputs unchanged.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      location: {type: 'string', description: 'Address, ZIP code, or "City, State" to harvest comps for (e.g. "120 Broadway, New York, NY" or "West Palm Beach, FL").'},
      zipCode: {type: 'string', description: 'Optional explicit 5-digit ZIP fallback for this requested location. A ZIP supplied as location uses its own code.'},
      submarket: {type: 'string', description: 'Optional submarket label; defaults to location.'},
      radiusMiles: {type: 'number', minimum: 0.25, maximum: 25, description: 'Optional search radius in miles around an address (default 1.0).'},
      pastDays: {type: 'integer', minimum: 7, maximum: 730, description: 'Lookback window in days for sold comps (default 180).'},
      listingTypes: {type: 'array', items: {type: 'string', enum: ['sold', 'for_sale', 'for_rent']}, minItems: 1, maxItems: 3},
      limit: {type: 'integer', minimum: 5, maximum: 100, description: 'Max comps per listing type (default 40).'},
      autoRecordMarketInputs: {type: 'boolean', description: 'When true (default), populates market inputs only from provider results resolving to the requested location. Broader or cached results remain references.'},
    },
    required: ['location'],
  },
};

export const dealStoreDefinition = {
  name: 'acres_search_deal_store',
  description: 'Search and rank the internal NYC deal store (HomeHarvest MLS listings, listings published on NYC investment-sales brokers\' own sites and LoopNet sale listings, matched to PLUTO) for listed properties with unused buildable FAR, effective price per buildable square foot ($/ZFA and $/gross buildable SF), and development valuation flashcards (Great Deal / Good Deal / Fair Deal / Full Price / Unpriced Opportunity sliding scale) with the dated basis of every assumption. The filters of the latest search in a run are returned with the answer, so the user\'s deals map can show the same listings. Admin accounts can sync an empty borough or ZIP when the deal store is enabled.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      useCurrentFilters: {type: 'boolean', description: 'For listing chats, inherit captured search criteria and map scope by default. Set false only for an explicitly broader or independent comparison. Captured cost assumptions still apply unless explicitly overridden.'},
      borough: {type: 'string', description: 'NYC borough name or code ("Manhattan"/"MN", "Brooklyn"/"BK", "Queens"/"QN", "Bronx"/"BX", "Staten Island"/"SI").'},
      zipCode: {type: 'string', description: 'Optional 5-digit ZIP code filter (e.g. "11215").'},
      zoningPrefix: {type: 'string', description: 'Optional zoning district prefix filter (e.g. "R6", "R7", "R8", "C", "M1").'},
      area: {type: 'string', description: 'Optional neighborhood or city name (e.g. "Bay Ridge", "Astoria"), or a 5-digit ZIP code.'},
      styles: {type: 'array', items: {type: 'string', enum: ['land', 'multi_family', 'townhomes', 'single_family', 'duplex_triplex']}, description: 'Optional property types to include.'},
      minHeadroomFar: {type: 'number', minimum: 0, maximum: 20, description: 'Minimum unused FAR (unused buildable floor area divided by lot area).'},
      minListPrice: {type: 'number', minimum: 0, maximum: 500000000, description: 'Minimum asking price in USD.'},
      maxLotArea: {type: 'number', minimum: 500, maximum: 1000000, description: 'Maximum PLUTO lot area in sq ft.'},
      minBuildableZfa: {type: 'number', minimum: 0, maximum: 10000000, description: 'Minimum buildable zoning floor area in sq ft (with the affordability bonus where it applies).'},
      minLotFront: {type: 'number', minimum: 0, maximum: 5000, description: 'Minimum lot width (street frontage) in feet.'},
      maxLotFront: {type: 'number', minimum: 0, maximum: 5000, description: 'Maximum lot width (street frontage) in feet.'},
      minLotDepth: {type: 'number', minimum: 0, maximum: 5000, description: 'Minimum lot depth in feet.'},
      maxLotDepth: {type: 'number', minimum: 0, maximum: 5000, description: 'Maximum lot depth in feet.'},
      minProjectCost: {type: 'number', minimum: 0, maximum: 5000000000, description: 'Minimum total project cost in USD: asking price plus estimated construction cost at the active cost assumptions; a listing with no ask is figured at its good-deal land threshold.'},
      maxProjectCost: {type: 'number', minimum: 0, maximum: 5000000000, description: 'Maximum total project cost in USD: asking price plus estimated construction cost at the active cost assumptions; a listing with no ask is figured at its good-deal land threshold.'},
      excludeHighStabilizedRisk: {type: 'boolean', description: 'When true, excludes listings with high rent-stabilization or CONH risk (six or more units built before 1974).'},
      listingType: {type: 'string', enum: ['for_sale', 'sold', 'pending'], description: 'Listing status filter (default "for_sale").'},
      minUnusedZfa: {type: 'number', minimum: 0, maximum: 1000000, description: 'Minimum unused buildable zoning floor area in sq ft (default 500).'},
      maxPricePerBuildableZfa: {type: 'number', minimum: 10, maximum: 5000, description: 'Maximum acquisition price per buildable ZFA in USD/sqft.'},
      maxPricePerBuildableAnyUse: {type: 'number', minimum: 10, maximum: 5000, description: 'Maximum price per buildable sq ft at the highest FAR any use allows on the lot (residential, affordable, commercial, community facility or manufacturing), in USD/sqft.'},
      maxListPrice: {type: 'number', minimum: 10000, maximum: 500000000, description: 'Maximum asking price in USD.'},
      minLotArea: {type: 'number', minimum: 500, maximum: 1000000, description: 'Minimum PLUTO lot area in sq ft.'},
      dealVerdict: {type: 'string', enum: ['great_deal', 'good_deal', 'fair_deal', 'full_price', 'unpriced_opportunity', 'great_deal,good_deal'], description: 'Filter by valuation flashcard verdict; "great_deal,good_deal" keeps both.'},
      excludeLandmarks: {type: 'boolean', description: 'When true, excludes landmarked and historic-district parcels.'},
      mihArea: {type: 'string', enum: ['inside', 'outside'], description: 'Keep only parcels inside, or only parcels confirmed outside, a mapped Mandatory Inclusionary Housing area. Inside one, the affordability preference is unavailable and the valuation prices the mapped option\'s affordable set-aside (flashcardValuation.mih says which option and why).'},
      sortBy: {type: 'string', enum: ['best_deal', 'uap_price_per_buildable_zfa', 'any_use_price_per_buildable_zfa', 'unused_uap_zfa', 'unused_far', 'far_compression_pct', 'implied_yield_on_cost', 'implied_condo_margin'], description: 'Sort ranking metric. unused_far ranks unused area / lot area; unused_uap_zfa ranks total unused area (default "uap_price_per_buildable_zfa").'},
      limit: {type: 'integer', minimum: 1, maximum: 50, description: 'Max deals to return (default 15).'},
      ...Object.fromEntries(COST_KEYS.map(key => [key, {
        ...FILTER_SCHEMA.properties[key],
        description: FILTER_SCHEMA.properties[key].description.replace('saved baseline', 'deal store baseline'),
      }])),
      condoHardCostPerGrossSqft: {
        ...FILTER_SCHEMA.properties.hardCostPerGrossSqft,
        description: 'Condo construction hard cost in USD per gross square foot, for the condo exit. Omitted, a hard cost named in this call prices both exits; otherwise the listing page\'s or saved condo cost applies.',
      },
      syncIfEmpty: {type: 'boolean', description: 'When true (default), syncs HomeHarvest listings + NYC PLUTO FAR records for this borough or ZIP if the store has no matching deals. Runs only for admin accounts while the deal store is enabled.'},
    },
  },
};

// This is an observed closed-sale sample mix, not an inventory-weighted absorption estimate.
// Asking rental listings do not report completed leases, so they cannot establish rental demand.
export function deriveVelocityMix(byBedrooms = {}, mode = 'sale') {
  if (mode !== 'sale') return null;
  const weights = [0, 1, 2, 3].map(b => {
    const count = byBedrooms[String(b)]?.closedSoldCount;
    return Number.isInteger(count) && count > 0 ? count : 0;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return total ? allocate(100, weights.map(n => n / total * 100)) : null;
}

async function defaultHomeHarvestRunner(payload) {
  const {execFile} = await import('node:child_process');
  const {existsSync} = await import('node:fs');
  const {promisify} = await import('node:util');
  const {fileURLToPath} = await import('node:url');
  const execFileAsync = promisify(execFile);
  const scriptPath = fileURLToPath(new URL('./homeharvest-bridge.py', import.meta.url));
  const venvPy = '/opt/acres-research/.venv/bin/python';
  const pythonBin = process.env.ACRES_PYTHON_BIN || (existsSync(venvPy) ? venvPy : 'python3');
  const child = execFileAsync(pythonBin, [scriptPath], {timeout: 45000, signal:requestSignal(45000), killSignal:'SIGKILL', maxBuffer: 16 * 1024 * 1024});
  child.child.stdin.write(JSON.stringify(payload));
  child.child.stdin.end();
  const {stdout} = await child;
  return JSON.parse(stdout);
}

// record adds an evidence source for a figure with a public URL and returns it with an id, or null.
// dealStoreAccess comes from dealStoreAccess() in market-store.mjs: read the internal deal store, and
// sync (scrape into it) only for admins while ACRES_DEAL_STORE_ENABLED=true. Its account, set by the run
// manager, is whose saved costs a search without listing-page costs uses.
export function createMarketTools({emit = () => {}, record = () => null, getProperty = () => null, getMaxDwellingUnits = () => null, initialMarket = null, initialProgram = null, compRunner = defaultHomeHarvestRunner, marketStore = null, marketStoreFactory = null, dealStoreAccess = {read: false, sync: false}, ledger = null, listingContext = null} = {}) {
  const listingSnapshot = listingContext ? validateFilterSnapshot(listingContext) : null;
  // Numeric citations belong to one run. Restore only captured evidence, never an old pool index.
  const evidenceSources = {};
  const remapped = new Map();
  for (const [key, snapshot] of Object.entries(initialMarket?.evidenceSources || {})) {
    const source = record({...snapshot, completeJson: snapshot.completeJson === true});
    if (source) { evidenceSources[key] = snapshot; remapped.set(key, source.id); }
  }
  const restoreRow = row => ({...row, sourceId: remapped.get(row.sourceKey) ?? null});
  const priorMarket = initialMarket ? {...initialMarket, evidenceSources} : null;
  if (priorMarket) {
    for (const key of ['rents','salePrices','commercialRents']) if (priorMarket[key]) priorMarket[key] = priorMarket[key].map(restoreRow);
    for (const key of ['supply','pipeline','absorption']) if (priorMarket[key]) priorMarket[key] = restoreRow(priorMarket[key]);
  }
  const priorProgram = initialProgram ? {...initialProgram, byBedrooms: initialProgram.byBedrooms?.map(restoreRow)} : null;
  const state = {market: null, program: null, priorMarket, priorProgram, comps: null, deals: null, dealSearches: []};
  let laneConflicts=new Set();
  const effective=key=>{
    if(state[key])return state[key];
    if(laneConflicts.has(key))throw new Error(`Parallel lanes disagree on ${key}. Record the chosen inputs explicitly before using dependent tools.`);
    return state[key==='market'?'priorMarket':'priorProgram'];
  };
  async function withMarketStore(fn) {
    throwIfCancelled();
    try {
      if (marketStore) {
        return await fn(marketStore);
      }
      if (marketStoreFactory) {
        const s = await marketStoreFactory();
        if (!s) return null;
        try { throwIfCancelled();return await fn(s); } finally { s.close?.(); }
      }
      const {openMarketStore} = await import('./market-store.mjs');
      throwIfCancelled();
      const s = openMarketStore();
      if (!s) return null;
      try { return await fn(s); } finally { s.close(); }
    } catch {
      throwIfCancelled();
      return null;
    }
  }
  function cite(row, label, kind = 'market') {
    if (!row.url) return {...row, sourceId: null};
    const source = record({title: `${label}: ${row.source}`, url: row.url, kind, text: `Market figure recorded ${row.retrievedAt}: ${JSON.stringify(row)}`});
    let sourceKey = null;
    if (source?.text && source?.url) {
      const {id, ...snapshot} = source;
      sourceKey = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      evidenceSources[sourceKey] = snapshot;
    }
    return {...row, sourceId: source?.id ?? null, sourceKey};
  }
  // The measured DOB pipeline for the subject ZIP; the look-back window stands in as the horizon.
  function ledgerPipeline() {
    if (!ledger) throw new Error('The development ledger is not available here; record the pipeline with its source instead.');
    const read = ledger.pipeline();
    if (!read.retrievedAt) throw new Error('The development ledger has not been synced for DOB filings; record the pipeline with its source instead.');
    // The pipeline is units under construction or permitted: approved jobs only, the rest named by stage.
    const t = read.totals, other = t.proposedDwellingUnitsAllStages - t.approvedDwellingUnits;
    return {
      activeJobs: t.approvedJobs, units: t.approvedDwellingUnits, horizonYears: read.months / 12, source: `NYC development ledger: DOB filings in ZIP ${read.zip}`, retrievedAt: read.retrievedAt.slice(0, 10), url: read.sourceUrl,
      basis: `${t.approvedDwellingUnits} proposed dwelling units across ${t.approvedJobs} approved or permitted DOB jobs in ZIP ${read.zip} filed since ${read.since}${other > 0 ? `; another ${other} units across ${t.activeJobs - t.approvedJobs} job${t.activeJobs - t.approvedJobs === 1 ? '' : 's'} in review, pre-filing, with objections or signed off are not counted` : ''}; the horizon is the ${read.months}-month filing window.`,
    };
  }
  async function inputs(args) {
    if (args.pipelineSource !== undefined && args.pipelineSource !== 'ledger') throw new Error('pipelineSource must be ledger.');
    if (args.pipelineSource && args.pipeline !== undefined) throw new Error('Give exactly one of pipeline or pipelineSource.');
    const {pipelineSource, ...rest} = args;
    const measured = pipelineSource ? ledgerPipeline() : null;
    const market = normalizeMarketInputs(measured ? {...rest, pipeline: measured} : rest);
    if (measured) market.pipeline.activeJobs = measured.activeJobs;
    for (const key of ['rents', 'salePrices', 'commercialRents']) if (market[key]) market[key] = market[key].map(row => cite(row, `${market.submarket} ${key}`));
    for (const key of ['supply', 'pipeline', 'absorption']) if (market[key]) market[key] = cite(market[key], `${market.submarket} ${key}`, key === 'pipeline' && measured ? 'official_record' : 'market');
    const existing = state.market || state.priorMarket;
    const sameSubmarket = existing && String(existing.submarket || '').trim().toLowerCase() === market.submarket.trim().toLowerCase();
    const merged = sameSubmarket ? {
      submarket: market.submarket,
      ...Object.fromEntries(['rents', 'salePrices', 'commercialRents', 'supply', 'pipeline', 'absorption'].map(k => [k, market[k] !== undefined ? market[k] : existing[k]]).filter(([, v]) => v !== undefined)),
    } : market;
    Object.assign(evidenceSources, sameSubmarket ? existing.evidenceSources : null);
    const citedKeys = new Set([...['rents','salePrices','commercialRents'].flatMap(key => merged[key] || []), ...['supply','pipeline','absorption'].map(key => merged[key])].map(row => row?.sourceKey).filter(Boolean));
    const snapshots = Object.fromEntries([...citedKeys].filter(key => evidenceSources[key]).map(key => [key,evidenceSources[key]]));
    state.market = {...merged, evidenceSources: snapshots, indicators: indicators(merged), recordedAt: new Date().toISOString()};
    emit('market.recorded', state.market);
    const {evidenceSources: _captured, ...visibleMarket} = state.market;
    return {...visibleMarket, note: 'Figures are as recorded, with the source and retrieval date on each; nothing was estimated. Cite the sourceId for figures that have one and name the source for the rest.'};
  }
  // The deal screen's measured mix and sizes for the site's area, when it has measured enough listings there.
  async function measuredUnitSizes(productType) {
    const p = getProperty();
    if (!p) return null;
    const sizes = await withMarketStore(s => unitSizesFor(s.getUnitSizes(), {zip_code: p.zipcode ? String(p.zipcode) : null, borough: p.borough ?? null})[productType]);
    if (!sizes || sizes.scope === 'assumed') return null;
    const beds = {studio: 0, oneBedroom: 1, twoBedroom: 2, threeBedroom: 3}, mixPercent = [0, 0, 0, 0], unitSizesSqft = [null, null, null, null];
    for (const u of sizes.mix) { mixPercent[beds[u.type]] = u.share * 100; unitSizesSqft[beds[u.type]] = u.netSqft; }
    return {mixPercent, unitSizesSqft, summary: unitSizeSummary(sizes, productType)};
  }
  async function unitMix(args) {
    const measured = args.mixPercent === undefined && args.unitSizesSqft === undefined && BASELINES[args.productType] ? await measuredUnitSizes(args.productType) : null;
    // An omitted density cap is auto-filled from the zoning envelope on file; an explicit one wins.
    const filledCap = args.maxDwellingUnits === undefined ? getMaxDwellingUnits() : null;
    const mix = recommendUnitMix(filledCap ? {...args, maxDwellingUnits: filledCap} : args, effective('market'), measured);
    state.program = mix;
    emit('unitmix.computed', mix);
    const notes = [mix.note, filledCap ? `Legal density auto-filled from the zoning envelope on file: at most ${filledCap} dwelling units (ZR 23-52). Pass maxDwellingUnits to override.` : null, `Counts are whole units by largest remainder; ${mix.unallocatedNetSqft} net sq ft is left over at these sizes.`, mix.assumptions.length ? 'Report the assumptions as such.' : 'Mix, sizes and efficiency were supplied.'];
    return {...mix, note: notes.filter(Boolean).join(' ')};
  }
  async function marketComps(args = {}) {
    const loc = text(args.location, 'location', 200);
    const locationZip = /^\d{5}$/.test(loc) ? loc : null;
    const explicitZip = args.zipCode === undefined ? null : String(args.zipCode).trim();
    if (explicitZip !== null && !/^\d{5}$/.test(explicitZip)) throw new Error('Use a 5-digit ZIP code for the requested location.');
    if (locationZip && explicitZip && locationZip !== explicitZip) throw new Error('The ZIP fallback conflicts with the requested ZIP location.');
    const zipHint = explicitZip || locationZip || undefined;
    const submarket = args.submarket ? text(args.submarket, 'submarket', 120) : loc;
    let raw = null;
    try {
      raw = await compRunner({
        location: loc,
        ...(zipHint ? {zipCode: zipHint} : {}),
        radiusMiles: args.radiusMiles ?? 1.0,
        pastDays: args.pastDays ?? 180,
        listingTypes: args.listingTypes ?? ['sold', 'for_sale', 'for_rent'],
        limit: args.limit ?? 40,
      });
    } catch (err) {
      raw = {error: err.message};
    }

    if ((raw?.error || !raw?.totalComps) && zipHint && dealStoreAccess.read) {
      const cached = await withMarketStore(s => s.getZipRollup(zipHint));
      if (cached && cached.sampleCount > 0) {
        raw = {
          location: zipHint,
          resolvedLocationsByType: {cachedZip: zipHint},
          retrievedAt: null,
          cachedAt: new Date(cached.updatedAt).toISOString(),
          totalComps: cached.sampleCount,
          byBedrooms: cached.byBedrooms,
          sampleComps: [],
          fromMarketStoreCache: true,
        };
      }
    }
    if (raw?.error) throw new Error(raw.error);

    if (dealStoreAccess.sync && compRunner === defaultHomeHarvestRunner && (raw.allRows?.length || raw.sampleComps?.length)) {
      await withMarketStore(async s => {
        if (s.getAdminConfig?.().syncConfig?.writeThroughComps !== false) {
          s.ingestListings(raw.allRows?.length ? raw.allRows : raw.sampleComps);
        }
      });
    }

    const fromCache = Boolean(raw.fromMarketStoreCache);
    const actualLocations = [...new Set(Object.values(raw.resolvedLocationsByType || {}))];
    if (!actualLocations.length) actualLocations.push(raw.location || loc);
    const referenceOnly = fromCache || actualLocations.some(location => location !== loc);
    const datasetLocation = referenceOnly ? actualLocations.join('; ') : loc;
    const datasetSubmarket = referenceOnly ? datasetLocation : submarket;
    const retrievedAt = fromCache ? null : (raw.retrievedAt || new Date().toISOString().slice(0, 10));
    const byBedrooms = raw.byBedrooms || {};
    const firstUrl = fromCache ? null : ((raw.sampleComps || []).find(c => c.url)?.url || null);
    const recordedSource = (raw.totalComps > 0 && firstUrl) ? record({
      title: `HomeHarvest MLS Property Comparables for ${datasetSubmarket}`,
      url: firstUrl,
      kind: 'comp_dataset',
      text: JSON.stringify({submarket: datasetSubmarket, requestedLocation: loc, actualLocations, retrievedAt, totalComps: raw.totalComps, resolvedLocationsByType: raw.resolvedLocationsByType, byBedrooms, sampleComps: (raw.sampleComps || []).slice(0, 20)}, null, 2),
    }) : null;

    const salePrices = [];
    const rents = [];
    for (const b of [0, 1, 2, 3]) {
      const row = byBedrooms[String(b)];
      if (!row) continue;
      // Realized condo prices need actual closed, priced condo/co-op observations.
      // Combined active asks and whole-building sales remain reference data in byBedrooms.
      const chosenSalePsf = row.medianCondoCoopClosedSoldPricePerSqft;
      const chosenSaleCount = row.condoCoopClosedSoldPriceSampleCount ?? 0;
      if (chosenSaleCount >= 2 && chosenSalePsf >= 100 && chosenSalePsf <= 15000) {
        salePrices.push({
          bedrooms: b,
          pricePerSqft: chosenSalePsf,
          source: `HomeHarvest closed condo/co-op sales (${chosenSaleCount} priced observations)`,
          url: firstUrl,
          retrievedAt,
          basis: `Median realized condo/co-op sale $/sqft across ${chosenSaleCount} closed sales with recorded sale price and area. Asking prices are excluded; this is a provider sample, not a complete market census.`,
        });
      }
      if (row.medianRentPerSqftPerMonth >= 1 && row.medianRentPerSqftPerMonth <= 30) {
        rents.push({
          bedrooms: b,
          rentPerSqftPerMonth: row.medianRentPerSqftPerMonth,
          source: `HomeHarvest MLS rental comps (${row.rentSampleCount} listings)`,
          url: firstUrl,
          retrievedAt,
          basis: `Median monthly asking rent $/sqft across ${row.rentSampleCount} comps${row.medianRentDaysOnMls ? ` (median ${row.medianRentDaysOnMls} days on market)` : ''}.`,
        });
      }
    }

    let autoRecordedMarket = null;
    if (args.autoRecordMarketInputs !== false && !referenceOnly && (salePrices.length || rents.length)) {
      autoRecordedMarket = await inputs({
        submarket,
        ...(salePrices.length ? {salePrices} : {}),
        ...(rents.length ? {rents} : {}),
      });
    }

    const out = {
      location: datasetLocation,
      requestedLocation: loc,
      resolvedLocationsByType: raw.resolvedLocationsByType || null,
      submarket: datasetSubmarket,
      requestedSubmarket: submarket,
      retrievedAt,
      provenance: {source: fromCache ? 'market-store-cache' : 'homeharvest', referenceOnly, actualLocations, cachedAt: raw.cachedAt || null,
        scopeNote: fromCache ? 'ZIP-wide stored inventory; not restricted to the requested radius, date window or listing types. The cache update time is not a listing retrieval date.' : referenceOnly ? 'Some listing types used a different provider query target. These broader results are references for those locations.' : 'Provider queries used the requested location; listing geography is provider-reported.'},
      sourceId: recordedSource?.id ?? null,
      totalComps: raw.totalComps || 0,
      byBedrooms,
      recommendedCondoMixByVelocity: referenceOnly ? [] : deriveVelocityMix(byBedrooms, 'sale'),
      recommendedRentalMixByVelocity: referenceOnly ? [] : null,
      salesDemandBasis: 'Closed-sale counts within the provider query window, normalized by bedroom. This is a capped sample mix, not market-wide absorption or an optimized program. Active inventory and days on market do not add completed demand.',
      rentalDemandStatus: 'unavailable_no_completed_lease_observations',
      closedSalesWindowDays: raw.closedSalesWindowDays ?? null,
      salePricingStatus: salePrices.length ? 'recorded_closed_condo_sample' : 'insufficient_closed_priced_condo_observations',
      sampleComps: (raw.sampleComps || []).slice(0, 20),
      autoRecordedMarket: Boolean(autoRecordedMarket),
      autoRecordReason: referenceOnly ? 'Market inputs were kept because the provider query target or stored cache scope differs from the request. Requery the intended location to obtain matching comps.' : null,
      proseReportingMandate: referenceOnly ? 'These are reference results for the actualLocations, not a completed request for the original geography/radius/date scope. Label the actual location and cachedAt when present, state the scope limits and keep the saved market inputs unchanged. Do not describe cached aggregates as live HomeHarvest evidence or cite a sourceId when it is null.' : 'IMPORTANT: You called acres_market_comps. In your written answer, present a bedroom-by-bedroom table (Studio/0BR, 1BR, 2BR, 3BR+) showing the returned saleSampleCount (closedSoldCount + activeForSaleCount), medianSalePricePerSqft, medianClosedSoldPricePerSqft, medianSaleDaysOnMls, rentSampleCount, medianRentPerSqftPerMonth, medianMonthlyRent, and medianRentDaysOnMls, plus the observed closed-sale sample mix (recommendedCondoMixByVelocity). Rental absorption is unavailable from asking listings. Distinguish asking, closed and mixed price medians; automatic condo inputs require at least two actually priced closed condo/co-op sales per bucket. Cite sourceId when available and state when listing URLs are unavailable. When 2BR/3BR+ buckets include both condo/co-op units and whole-townhouse/single-family sales, note both the stratified condo/co-op median (medianCondoCoopSalePricePerSqft) and the all-comps median.',
    };
    state.comps = out;
    emit('market.comps_harvested', {submarket: out.submarket, requestedLocation: loc, referenceOnly, totalComps: out.totalComps, sourceId: out.sourceId});
    return out;
  }

  async function searchDealStore(args = {}) {
    if (!dealStoreAccess.read) throw new Error('The deal store is not available for this account.');
    const named = args;
    if (listingSnapshot) {
      // The condo figure keeps its dedicated handling below: it is optional in a snapshot and
      // falls back to the page figure, a named hard cost, or the saved split, never required here.
      const capturedCostKeys = COST_KEYS.filter(key => key !== 'condoHardCostPerGrossSqft');
      const capturedCosts = Object.fromEntries(capturedCostKeys.map(key => [key, listingSnapshot.values[key] ?? listingSnapshot.baselineCosts[key]]));
      if (listingSnapshot.condoHardCostPerGrossSqft != null) capturedCosts.condoHardCostPerGrossSqft = listingSnapshot.condoHardCostPerGrossSqft;
      else if (listingSnapshot.values.condoHardCostPerGrossSqft != null) capturedCosts.condoHardCostPerGrossSqft = listingSnapshot.values.condoHardCostPerGrossSqft;
      const inherited = args.useCurrentFilters === false ? {} : {...listingSearchFilters(listingSnapshot.values), bounds: listingSnapshot.values.followMap ? listingSnapshot.map?.bounds ?? null : null};
      args = {...inherited, ...capturedCosts, syncIfEmpty: false, ...args};
      for (const key of capturedCostKeys) if (args[key] === null) args[key] = listingSnapshot.baselineCosts[key];
      for (const key of capturedCostKeys) if (args[key] == null) throw new Error(`The captured listing cost ${key} is unavailable. Provide it explicitly before comparing deal returns.`);
    }
    const costOverrides = Object.fromEntries(COST_KEYS.filter(key => key !== 'condoHardCostPerGrossSqft' && args[key] != null).map(key => [key, normalizeCostValue(key, args[key])]));
    // The page's hard cost, or one the call names, is the rental figure over a saved split one; a named one
    // prices both exits unless the call names a condo cost too.
    if (listingSnapshot || named.hardCostPerGrossSqft != null) costOverrides.rentalHardCostPerGrossSqft = costOverrides.hardCostPerGrossSqft;
    const condo = named.hardCostPerGrossSqft != null && named.condoHardCostPerGrossSqft == null ? named.hardCostPerGrossSqft : args.condoHardCostPerGrossSqft;
    if (condo != null) costOverrides.condoHardCostPerGrossSqft = normalizeCostValue('hardCostPerGrossSqft', condo);
    const filters = {...args, ...costOverrides};

    const query = {
      borough: args.borough || null,
      zipCode: args.zipCode || null,
      zoningPrefix: args.zoningPrefix || null,
      area: args.area || null,
      styles: Array.isArray(args.styles) && args.styles.length ? args.styles : null,
      minHeadroomFar: args.minHeadroomFar ?? null,
      minListPrice: args.minListPrice ?? null,
      maxLotArea: args.maxLotArea ?? null,
      minBuildableZfa: args.minBuildableZfa ?? null,
      minLotFront: args.minLotFront ?? null,
      maxLotFront: args.maxLotFront ?? null,
      minLotDepth: args.minLotDepth ?? null,
      maxLotDepth: args.maxLotDepth ?? null,
      minProjectCost: args.minProjectCost ?? null,
      maxProjectCost: args.maxProjectCost ?? null,
      excludeHighStabilizedRisk: Boolean(args.excludeHighStabilizedRisk),
      listingType: args.listingType || 'for_sale',
      minUnusedZfa: args.minUnusedZfa ?? 500,
      maxPricePerBuildableZfa: args.maxPricePerBuildableZfa ?? null,
      maxPricePerBuildableAnyUse: args.maxPricePerBuildableAnyUse ?? null,
      maxListPrice: args.maxListPrice ?? null,
      minLotArea: args.minLotArea ?? null,
      dealVerdict: args.dealVerdict || null,
      bounds: args.bounds || null,
      excludeLandmarks: Boolean(args.excludeLandmarks),
      mihArea: args.mihArea || null,
      sortBy: args.sortBy || 'uap_price_per_buildable_zfa',
      limit: args.limit ?? 15,
      customSettings: null,
    };
    const result = await withMarketStore(async s => {
      // The run's account values deals at its saved profile, as Browse does: the listing page's captured costs
      // and costs named in the call override its saved costs, and house figures apply where nothing is saved.
      const saved = dealStoreAccess.account ? s.getUserDealSettings(dealStoreAccess.account) : null;
      const custom = {...(saved?.isCustom ? saved.dealSettings : {}), ...costOverrides};
      query.customSettings = Object.keys(custom).length ? custom : null;
      const costSource = listingSnapshot ? 'listing page' : saved?.isCustom ? 'saved costs' : 'house costs';
      let deals = s.searchDeals(query);

      let syncedNow = false;
      const config = s.getAdminConfig();
      const allowOnDemand = config.syncConfig.onDemandSyncIfEmpty;
      const effectiveCosts = Object.fromEntries(COST_KEYS.map(key => [key, custom[key] ?? config.dealSettings[key]]));
      // The condo figure the valuation uses, by the store's rule: a split value, else a lone legacy hard cost.
      effectiveCosts.condoHardCostPerGrossSqft = custom.condoHardCostPerGrossSqft ?? custom.hardCostPerGrossSqft ?? config.dealSettings.condoHardCostPerGrossSqft;
      if (!deals.length && args.syncIfEmpty !== false && dealStoreAccess.sync && allowOnDemand) {
        const targetLoc = args.zipCode
          ? String(args.zipCode).trim()
          : args.borough
            ? `${args.borough}, NY`
            : 'Brooklyn, NY';
        await s.syncMarket({
          locations: [targetLoc],
          listingTypes: [args.listingType || 'for_sale'],
          propertyTypes: ['land', 'multi_family', 'townhomes', 'duplex_triplex', 'single_family'],
          limitPerType: 60,
          enrichPluto: true,
          // A chat search seeds an empty store quickly; the full whole-lot pull belongs to the scheduled sync.
          fullForSalePull: false,
        });
        syncedNow = true;
        deals = s.searchDeals(query);
      }

      return {deals, syncedNow, effectiveCosts, costSource, storeStatus: s.statusSummary()};
    });

    if (!result) throw new Error('Market deal store is unavailable.');
    const firstUrl = result.deals.find(d => d.url)?.url || 'https://data.cityofnewyork.us/resource/64uk-42ks.json';
    const {customSettings, ...criteria} = query;
    const searchContext = {filters: structuredClone({...criteria, ...result.effectiveCosts}), costSource: result.costSource, returnedCount: result.deals.length, searchedAt: new Date().toISOString()};
    const recordedSource = record({
      title: `Arosa NYC Development Deal Store (${args.borough || args.zipCode || 'NYC'}: PLUTO FAR + HomeHarvest MLS + broker sites + LoopNet)`,
      url: firstUrl,
      kind: 'deal_store',
      completeJson: true,
      text: JSON.stringify({filters, searchContext, returnedDeals: result.deals.length, deals: result.deals}, null, 2),
    });
    const receipt = {...searchContext, sourceId: recordedSource?.id ?? null};
    state.dealSearches.push(structuredClone(receipt));

    const out = {
      filters,
      syncedNow: result.syncedNow,
      sourceId: recordedSource?.id ?? null,
      dealCount: result.deals.length,
      searchContext: receipt,
      deals: result.deals,
      storeStatus: result.storeStatus,
      proseReportingMandate: 'Present a clear ranked table of the returned development candidates showing Address, BBL, Zoning District, Lot Area, Existing Bldg Area, Max Buildable ZFA (Standard & UAP), Unused ZFA, Asking Price, Existing $/SF vs. Buildable $/ZFA (% compression), and the Flashcard Valuation Verdict (Great/Good/Fair Deal sliding scale in $/BSF), and cite sourceId. State the flashcard basis: the costs, cap rates, benchmarks and deductions are dated planning assumptions, and each ZIP sale median is recorded condo and co-op closings where the ZIP has enough; otherwise the ZIP has no recorded sale benchmark, its basis says so and the dated submarket tier figure stands in. Asking prices never set it. Name each deal\'s listingSourceName and link its url; a broker-site or LoopNet asking price is the broker\'s published figure, and a listing without one stays unpriced. For a deal inside a Mandatory Inclusionary Housing area (flashcardValuation.mih.status inside), say so, name the area and the option the valuation applied (its appliedOption and note), and do not offer the UAP bonus there.',
    };
    state.deals = out;
    emit('market.deals_searched', {dealCount: out.dealCount, sourceId: out.sourceId});
    return out;
  }

  return {
    definitions: [marketDefinition, unitMixDefinition, marketCompsDefinition, dealStoreDefinition],
    handlers: {
      acres_market_inputs: inputs,
      acres_unit_mix: unitMix,
      acres_market_comps: marketComps,
      acres_search_deal_store: searchDealStore,
    },
    get market() { return state.market; },
    get program() { return state.program; },
    get comps() { return state.comps; },
    get deals() { return state.deals; },
    get dealSearches() { return structuredClone(state.dealSearches); },
    adoptLaneState({market,program,conflicts}){
      laneConflicts=new Set(conflicts);
      if(market||conflicts.has('market'))state.priorMarket=market;
      if(market)Object.assign(evidenceSources,market.evidenceSources);
      if(program||conflicts.has('program'))state.priorProgram=program;
    },
    get effectiveMarket() { return effective('market'); },
    get effectiveProgram() { return effective('program'); },
  };
}
