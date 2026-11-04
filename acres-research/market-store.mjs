import {requestSignal,throwIfCancelled,executionSignal} from './execution-context.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync, existsSync, statSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {rules as ZONING_RULES, describeDistrict} from './zoning.mjs';
import {wideStreetPortion} from './envelope.mjs';
import {computeEnvelope, polygonArea, bounds} from './envelope.mjs';
import {DEAL_SCREEN_485X, DOF_CLASS2, NYC_485X, dealElection485x, exemptionFactor485x, exemptionSchedule485x, taxShareOfNoi, taxShareOfNoiForClass} from './tax-485x.mjs';
import {NYC_HARD_COST, defaultHardCost, hardCostBasisText} from './construction-costs.mjs';
import {MIH_RULES, availableMihOptions, defaultMihAreasFetcher, mihAreaAt} from './mih-areas.mjs';
import {frontingStreets} from './nyc-zoning-lookups.mjs';
import {fetchLotGeometry, toLocalFeet, snapTaxLotOutline} from './assembly.mjs';
import {socrataHeaders} from './public-http.mjs';
import {DEVELOPMENT_SITE_SALES, ledgerPath} from './ledger.mjs';
import {defaultFilterValues, listingAreaZips, listingSearchFilters, validateSearchState} from './listing-filter-schema.mjs';
import {defaultRentStabilizedFetcher, RENT_STABILIZED_RESYNC_MS, RENT_STABILIZED_SOURCE} from './rent-stabilized-units.mjs';

const execFileAsync = promisify(execFile);

// Rows a city closed-sales file loaded (city-closed-sales.mjs): comps for the rollups, never listings.
export const CITY_CLOSED_SALES_SOURCE = 'city_closed_sales';
// Priced condo and co-op closings a ZIP needs before it has a sale $/sqft benchmark; asks never stand in.
// One peer-evidence floor citywide: no composite (median) figure is published from fewer than
// six sales, here and in LAND_COMPS and BUILDING_SALES below; the individual sales stay visible.
const MIN_PEER_SALES = 6;
const MIN_CLOSED_CONDO_SALES = MIN_PEER_SALES;
// Only closings in this many months before the rollup set that benchmark: older ones describe another market.
const CONDO_SALE_WINDOW_MONTHS = 24;
export const marketDbPath = () => process.env.ACRES_MARKET_DB || '/home/openclaw/.openclaw/acres-state/market.sqlite';
export const PLUTO_DATASET_URL = 'https://data.cityofnewyork.us/resource/64uk-42ks.json';
export const HPD_REGISTRATIONS_URL = 'https://data.cityofnewyork.us/resource/tesw-yqqr.json';

export const NYC_BOROUGH_LOCATIONS = [
  'Manhattan, NY',
  'Brooklyn, NY',
  'Queens, NY',
  'Bronx, NY',
  'Staten Island, NY',
];

// The deal store is internal-only: scraping needs the flag and an admin account; reading needs either.
export const DEFAULT_ADMIN_EMAILS = [];

export function isMarketAdmin(email, adminEmailsEnv = process.env.AROSA_ADMIN_EMAILS) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  const configured = String(adminEmailsEnv || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ADMIN_EMAILS).has(normalized);
}

export function dealStoreEnabled(env = process.env) {
  return env.ACRES_DEAL_STORE_ENABLED === 'true';
}

export function dealStoreAccess(isAdmin, env = process.env) {
  const enabled = dealStoreEnabled(env);
  return {read: enabled || Boolean(isAdmin), sync: enabled && Boolean(isAdmin)};
}

// Every default below is an unsourced planning figure, not a market survey or cost index.
// Each carries the date it was set and its origin so flashcards can print their basis.
export const DEFAULTS_AS_OF = '2026-10-15';
const PLANNING_ASSUMPTION = 'Arosa planning assumption for the deal store; not from a published dataset or cost index';
const ANALYST_TIER = {asOf: DEFAULTS_AS_OF, source: 'Arosa analyst estimate by submarket; unsourced, not a market survey'};

// Hard cost is split by exit: rental schemes price at rentalHardCostPerGrossSqft and the condo
// exit at condoHardCostPerGrossSqft. hardCostPerGrossSqft stays as the legacy alias (the rental
// figure on read; a lone legacy value on write still sets both, so pre-split accounts keep working).
export const DEFAULT_NYC_DEV_SETTINGS = {
  hardCostPerGrossSqft: 375,
  rentalHardCostPerGrossSqft: 375,
  condoHardCostPerGrossSqft: 375,
  softCostPctOfHard: 0.22,
  carryAndFinancingPct: 0.10,
  zfaToGrossFactor: 1.15,
  zfaToNetEfficiency: 0.85,
  operatingExpenseRatio: 0.30,
  greatDealCapRate: 0.085,
  goodDealCapRate: 0.0725,
  badDealCapRate: 0.060,
  greatDealCondoMargin: 0.28,
  goodDealCondoMargin: 0.18,
  badDealCondoMargin: 0.10,
};

export const DEFAULT_NYC_DEV_SETTINGS_BASIS = Object.fromEntries(Object.keys(DEFAULT_NYC_DEV_SETTINGS).map(key => [key, {
  asOf: DEFAULTS_AS_OF,
  source: key === 'zfaToGrossFactor'
    ? 'Developer rule of thumb from the October 2026 product meeting (20,000 ZFA yields about 23,000 gross sq ft)'
    : key.endsWith('HardCostPerGrossSqft') ? 'House hard cost: each building is priced from the published New York cost range (see hardCost); an account\'s own figure replaces it'
    : key === 'operatingExpenseRatio' ? `${PLANNING_ASSUMPTION}; operating costs before real estate taxes, which are priced separately` : PLANNING_ASSUMPTION,
}]));

// Floor area excluded from zoning floor area (ZR 12-10 definition of floor area). The percentages
// are planning estimates, not figures from the Zoning Resolution.
export const ZFA_GROSS_DEDUCTIONS = {
  asOf: DEFAULTS_AS_OF,
  source: `${PLANNING_ASSUMPTION}; ZR 12-10 defines the exclusions, not these percentages`,
  cellarPct: 0.065,
  cellarFloodZonePct: 0.025,
  recreationUapPct: 0.038,
  recreationPct: 0.028,
  exteriorWallPct: 0.030,
  balconyPct: 0.022,
  balconySmallBuildingPct: 0.012,
  narrowLotUnder22FtCorePenalty: 0.06,
  narrowLotUnder28FtCorePenalty: 0.03,
};

// How the screen prices construction and floor plates. Planning estimates, not a cost index or a code
// determination: an account's own hard cost rises with height class (the house cost already varies with
// structure, construction-costs.mjs), both rise on narrow lots, and every floor loses a fixed core (stairs,
// plus an elevator above walk-up height) before any area can be sold or leased.
export const DEAL_SCREEN_ASSUMPTIONS = {
  asOf: DEFAULTS_AS_OF,
  source: PLANNING_ASSUMPTION,
  heightClasses: [
    {maxStoreys: 6, label: 'low-rise', hardCostFactor: 1},
    {maxStoreys: 12, label: 'mid-rise', hardCostFactor: 1.12},
    {maxStoreys: null, label: 'high-rise', hardCostFactor: 1.25},
  ],
  narrowLotWidthFeet: 25,
  narrowLotHardCostFactor: 1.08,
  walkUpMaxStoreys: 5,
  corePerFloorSqft: {walkUp: 250, elevator: 400},
  minViableFloorplateSqft: 1000,
  affordableUnitNetSqft: 650,
  buyerClosingCostPct: 0.015,
};

// The unit mix behind the planned unit count, by the exit that sets the value: net sellable SF per unit
// type and its share of units. Rentals run smaller than condominiums (a one-bedroom about 550 SF against
// 750). Assumptions, not a market survey:
//   rental: 30% studios at 450 SF, 45% one-bedrooms at 550, 25% two-bedrooms at 800 (about 583 SF a unit);
//   condo: 15% studios at 550, 45% one-bedrooms at 750, 30% two-bedrooms at 1,100, 10% three-bedrooms at
//   1,450 (about 895 SF a unit).
// Affordable floor area is always rented, so it counts at the rental size.
export const DEAL_UNIT_MIX = {
  asOf: DEFAULTS_AS_OF,
  source: `${PLANNING_ASSUMPTION}; unit sizes and mix assumed`,
  rental: [{type: 'studio', share: 0.30, netSqft: 450}, {type: 'oneBedroom', share: 0.45, netSqft: 550}, {type: 'twoBedroom', share: 0.25, netSqft: 800}],
  condo: [{type: 'studio', share: 0.15, netSqft: 550}, {type: 'oneBedroom', share: 0.45, netSqft: 750}, {type: 'twoBedroom', share: 0.30, netSqft: 1100}, {type: 'threeBedroom', share: 0.10, netSqft: 1450}],
};
const averageUnitNetSqft = mix => Math.round(mix.reduce((sum, unit) => sum + unit.share * unit.netSqft, 0));

// Unit sizes measured from the store's own Realtor.com listings: the median interior SF of each bedroom
// count in the mix, apartments for rent for the rental exit and condominium and co-op apartments sold or
// for sale for the condo exit, weighted by the mix's shares. Sizes outside the citywide fences for their
// type (1.5 interquartile ranges past the quartiles) are dropped. An area is used only when every type in
// the mix has enough measured listings there; a listing takes its ZIP, then its neighborhood, borough and
// the city, and the assumed mix where even the city has too few.
export const UNIT_SIZE_SAMPLE = {minListings: 20, minPerType: 3, minSqft: 150, maxSqft: 5000, fenceIqr: 1.5};
const UNIT_TYPE_BEDS = {studio: 0, oneBedroom: 1, twoBedroom: 2, threeBedroom: 3};
const UNIT_TYPE_NAMES = {studio: 'studio', oneBedroom: 'one-bedroom', twoBedroom: 'two-bedroom', threeBedroom: 'three-bedroom'};
const BOROUGH_NAMES = {MN: 'Manhattan', BK: 'Brooklyn', QN: 'Queens', BX: 'the Bronx', SI: 'Staten Island'};
const EXIT_UNITS = {rental: 'rentals', condo: 'condos'};
const assumedUnitSizes = exit => ({
  scope: 'assumed', label: 'the citywide assumed mix', sampleCount: 0, asOf: DEAL_UNIT_MIX.asOf,
  averageNetSqft: averageUnitNetSqft(DEAL_UNIT_MIX[exit]), mix: DEAL_UNIT_MIX[exit],
});
export const ASSUMED_UNIT_SIZES = {rental: assumedUnitSizes('rental'), condo: assumedUnitSizes('condo')};

// A unit count split over an exit's mix by share, the remainder going to the largest fractions.
export function unitMixOf(sizes, units) {
  const rows = sizes.mix.map(u => ({type: u.type, netSqft: u.netSqft, exact: u.share * units}));
  const out = rows.map(r => ({type: r.type, netSqft: r.netSqft, units: Math.floor(r.exact)}));
  let left = units - out.reduce((sum, r) => sum + r.units, 0);
  for (const i of rows.map((r, i) => i).sort((a, b) => (rows[b].exact % 1) - (rows[a].exact % 1) || a - b)) if (left-- > 0) out[i].units += 1;
  return out;
}

// The areas a listing's unit sizes can come from, narrowest first.
function unitSizeScopes(r) {
  const borough = r.borough || null;
  const zip = String(r.zip_code || '').trim();
  const neighborhood = String(r.neighborhood || '').trim();
  return [
    zip && {key: `zip:${zip}`, label: `ZIP ${zip}`},
    borough && neighborhood && {key: `neighborhood:${borough}:${neighborhood.toLowerCase()}`, label: neighborhood},
    borough && BOROUGH_NAMES[borough] && {key: `borough:${borough}`, label: BOROUGH_NAMES[borough]},
    {key: 'city', label: 'New York City'},
  ].filter(Boolean);
}

// Measured sizes per area and exit from listing rows (property_id, id, listing_type, zip_code, borough,
// neighborhood, beds, sqft), keeping only the areas with enough listings.
export function measureUnitSizes(rows, asOf) {
  const {minListings, minPerType, minSqft, maxSqft, fenceIqr} = UNIT_SIZE_SAMPLE;
  const seen = new Set();
  const units = [];
  for (const r of rows) {
    const exit = r.listing_type === 'for_rent' ? 'rental' : 'condo';
    // A record without a bedroom count (a city closed sale, a whole building) is no unit type; Number(null) is 0.
    const beds = r.beds === null || r.beds === undefined || r.beds === '' ? NaN : Number(r.beds);
    const type = DEAL_UNIT_MIX[exit].find(u => UNIT_TYPE_BEDS[u.type] === beds)?.type;
    const sqft = Number(r.sqft);
    // A unit sold and listed again is one unit.
    const unitKey = `${exit}:${r.property_id || r.id}`;
    if (!type || !(sqft >= minSqft && sqft <= maxSqft) || seen.has(unitKey)) continue;
    seen.add(unitKey);
    units.push({exit, type, sqft, scopes: unitSizeScopes(r)});
  }
  const quartile = (sorted, q) => {
    const at = (sorted.length - 1) * q;
    return sorted[Math.floor(at)] + (sorted[Math.ceil(at)] - sorted[Math.floor(at)]) * (at - Math.floor(at));
  };
  const fences = new Map();
  for (const exit of ['rental', 'condo']) {
    for (const {type} of DEAL_UNIT_MIX[exit]) {
      const sorted = units.filter(u => u.exit === exit && u.type === type).map(u => u.sqft).sort((a, b) => a - b);
      if (!sorted.length) continue;
      const q1 = quartile(sorted, 0.25), q3 = quartile(sorted, 0.75);
      fences.set(`${exit}:${type}`, [q1 - fenceIqr * (q3 - q1), q3 + fenceIqr * (q3 - q1)]);
    }
  }
  const areas = new Map();
  for (const u of units) {
    const [low, high] = fences.get(`${u.exit}:${u.type}`);
    if (u.sqft < low || u.sqft > high) continue;
    for (const scope of u.scopes) {
      const key = `${u.exit}|${scope.key}`;
      if (!areas.has(key)) areas.set(key, {exit: u.exit, scope: scope.key, label: scope.label, sizes: {}});
      (areas.get(key).sizes[u.type] ??= []).push(u.sqft);
    }
  }
  const measured = [];
  for (const area of areas.values()) {
    const mix = DEAL_UNIT_MIX[area.exit].map(u => ({type: u.type, share: u.share, netSqft: median(area.sizes[u.type], 0), listings: area.sizes[u.type]?.length ?? 0}));
    const sampleCount = mix.reduce((sum, u) => sum + u.listings, 0);
    if (sampleCount < minListings || mix.some(u => u.listings < minPerType)) continue;
    measured.push({exit: area.exit, scope: area.scope, label: area.label, sampleCount, asOf, averageNetSqft: averageUnitNetSqft(mix), mix});
  }
  return measured;
}

// New buildings rent and sell above their ZIP's existing stock, and a ZIP median is mostly existing stock.
// The premium is measured, not assumed: each building completed within the window is compared, by the
// median of its own priced units, with the median of the other units in its ZIP (units with no year built
// count as existing stock), so a tower with hundreds of closings counts once, like a six-unit building.
// The median of those building ratios scales a ZIP's median. The citywide median is the base. A borough
// with at least minBoroughBuildings buildings gets its own, pulled toward the citywide figure as if
// shrinkBuildings more buildings sat at it; a ZIP with at least minZipBuildings gets its own, pulled the
// same way toward its borough's (or the city's). A ZIP where many new buildings trade follows its own
// market and a thin one stays near its borough. Too few buildings measure none. Rents are asking rents;
// sale prices are recorded closings.
export const NEW_BUILD_PREMIUM = {
  windowYears: 12,
  minBuildings: 20,
  minBoroughBuildings: 10,
  minZipBuildings: 3,
  shrinkBuildings: 10,
  minOtherUnits: {rent: 3, sale: 5},
};

// The building a unit is in: its ZIP, house number and street, without the unit, so a city closing
// ("500 WEST 18TH STREET, W8C") and a listing ("500 W 18th St (Unit #8C)") of one building agree. A
// unit without a house number and street has no known building.
export function newBuildBuildingKey(r) {
  const line = String(r.street_line || r.address || '').split(',')[0].replace(/\s*\(.*$/, '').replace(/\s+(?:#|(?:APT|UNIT|PH|STE|FL)\b).*$/i, '');
  const house = normalizeHouseNumber(line), street = normalizeStreetWords(line);
  return house && street ? `${r.zip_code}|${house} ${street}` : null;
}

// The values left after taking out one occurrence of each of `units`.
function withoutUnits(values, units) {
  const left = new Map();
  for (const v of units) left.set(v, (left.get(v) ?? 0) + 1);
  return values.filter(v => !(left.get(v) > 0 && left.set(v, left.get(v) - 1)));
}

export function measureNewBuildPremiums(rows, asOf) {
  const {windowYears, minBuildings, minBoroughBuildings, minZipBuildings, shrinkBuildings, minOtherUnits} = NEW_BUILD_PREMIUM;
  const firstNewYear = Number(asOf.slice(0, 4)) - windowYears;
  const premiums = [];
  for (const metric of ['rent', 'sale']) {
    const zips = new Map();
    rows.forEach((r, i) => {
      if (r.metric !== metric || !r.zip_code || !(r.psf > 0)) return;
      if (!zips.has(r.zip_code)) zips.set(r.zip_code, {borough: null, all: [], recent: new Map()});
      const zip = zips.get(r.zip_code);
      zip.borough ??= r.borough ?? null;
      zip.all.push(r.psf);
      if (!(r.year_built >= firstNewYear)) return;
      // A unit with no building stands alone.
      const building = r.building ?? `unit ${i}`;
      if (!zip.recent.has(building)) zip.recent.set(building, []);
      zip.recent.get(building).push(r.psf);
    });
    const scopes = new Map();
    for (const [zipCode, {borough, all, recent}] of zips) {
      // A ZIP's median, the figure the premium scales, counts its new buildings too, so each building is
      // compared with the median of every other unit in its ZIP.
      const compared = [...recent.values()].filter(psfs => all.length - psfs.length >= minOtherUnits[metric]);
      if (!compared.length) continue;
      const ratios = compared.map(psfs => median(psfs, 4) / median(withoutUnits(all, psfs), 4));
      const units = compared.reduce((n, psfs) => n + psfs.length, 0);
      for (const scope of ['city', borough, `zip:${zipCode}`]) {
        if (!scope) continue;
        if (!scopes.has(scope)) scopes.set(scope, {ratios: [], units: 0, zipCount: 0, parent: borough});
        const s = scopes.get(scope);
        s.ratios.push(...ratios);
        s.units += units;
        s.zipCount++;
      }
    }
    const city = scopes.get('city');
    if (!city || city.ratios.length < minBuildings) continue;
    const ratios = new Map();
    const record = (scope, s, toward) => {
      const rawRatio = median(s.ratios, 4);
      const ratio = toward === null ? rawRatio : (s.ratios.length * rawRatio + shrinkBuildings * toward) / (s.ratios.length + shrinkBuildings);
      ratios.set(scope, ratio);
      premiums.push({metric, scope, ratio: Number(ratio.toFixed(2)), rawRatio: Number(rawRatio.toFixed(2)), buildingCount: s.ratios.length, pairCount: s.units, zipCount: s.zipCount, windowYears, asOf});
    };
    record('city', city, null);
    for (const [scope, s] of scopes) if (scope !== 'city' && !scope.startsWith('zip:') && s.ratios.length >= minBoroughBuildings) record(scope, s, ratios.get('city'));
    for (const [scope, s] of scopes) if (scope.startsWith('zip:') && s.ratios.length >= minZipBuildings) record(scope, s, ratios.get(s.parent) ?? ratios.get('city'));
  }
  return premiums;
}

// The measured premiums keyed by metric: the citywide one, with the boroughs and ZIPs measured on their own.
export function newBuildPremiumTable(measured) {
  const table = {};
  for (const {metric, ...premium} of measured) if (premium.scope === 'city') table[metric] = {...premium, boroughs: {}, zips: {}};
  for (const {metric, ...premium} of measured) {
    if (premium.scope === 'city' || !table[metric]) continue;
    if (premium.scope.startsWith('zip:')) table[metric].zips[premium.scope.slice(4)] = premium;
    else table[metric].boroughs[premium.scope] = premium;
  }
  return table;
}

// The premium a listing takes: its ZIP's when measured, else its borough's, else the citywide one. A
// ZIP's says which figure it was pulled toward.
export function newBuildPremiumFor(premiums, borough, zipCode = null) {
  const resolve = metric => {
    const city = premiums?.[metric];
    const zip = city?.zips?.[zipCode];
    if (zip) return {...zip, toward: city.boroughs?.[borough] ? borough : 'city'};
    return city?.boroughs?.[borough] ?? city ?? null;
  };
  return {rent: resolve('rent'), sale: resolve('sale')};
}

// The rental and condo unit sizes a listing plans with: its narrowest area with a measured sample.
export function unitSizesFor(table, r) {
  const scopes = unitSizeScopes(r);
  const pick = exit => scopes.map(s => table?.get(`${exit}|${s.key}`)).find(Boolean) ?? ASSUMED_UNIT_SIZES[exit];
  return {rental: pick('rental'), condo: pick('condo')};
}

// The planned-unit basis in plain words: "Crown Heights rentals, median 610 SF (48 listings)".
export function unitSizeSummary(sizes, exit) {
  return sizes.scope === 'assumed'
    ? `${sizes.label}, about ${sizes.averageNetSqft} SF ${exit === 'rental' ? 'a rental' : 'a condo'} (too few measured listings nearby)`
    : `${sizes.label} ${EXIT_UNITS[exit]}, median ${sizes.averageNetSqft} SF (${sizes.sampleCount} listings)`;
}

// Most dwelling units the zoning allows on this floor area: the dwelling unit factor (ZR 23-52, 680 SF),
// a fraction of three-quarters or more counting as one. A cap on the count, not a unit size.
export function mostUnitsAllowed(residentialFloorAreaSqft) {
  const {dwellingUnitFactor, roundUpFraction} = ZONING_RULES.bulk.density;
  const quotient = residentialFloorAreaSqft / dwellingUnitFactor;
  return Math.floor(quotient) + (quotient - Math.floor(quotient) >= roundUpFraction ? 1 : 0);
}

// Floor area the affordability preference adds must be permanently affordable (ZR 23-22, 27-111) and
// earns income-restricted rents. A one-bedroom at 60% AMI over DEAL_SCREEN_ASSUMPTIONS.affordableUnitNetSqft.
export const NYC_AFFORDABLE_RENTS = {
  asOf: '2026-10-18',
  source: 'HPD, 2025 New York City Area Affordable Monthly Rents',
  sourceUrl: 'https://www.nyc.gov/site/hpd/services-and-information/area-median-income.page',
  amiPct: 60,
  monthlyRent: {studio: 1701, oneBedroom: 1822, twoBedroom: 2187, threeBedroom: 2527},
};

// A city-financed, all-affordable rental: HPD's ELLA term sheet (updated 2020-03-10) underwrites rents at a
// 53 to 54% AMI weighted average and lends up to $122,500 a unit on a 100% tax-credit project; HDC's ELLA
// second mortgage adds up to $65,000 a unit, at most $15 million a project, and HDC finances developments of 100
// units as of right and of 50 or more case by case, so a smaller building has no such path. Both loans defer and
// accrue to a balloon at maturity (HPD's at the federal rate from construction closing), so they are set against
// the cost of building, as is the equity from the 4% federal tax credits these projects pair with: 4% of the building cost (land excluded) a year for
// 10 years, sold at the average bid. No basis boost is counted. These rentals pay no real estate taxes: HPD's
// production data lists a 420-c or Article XI exemption on 353 of the 414 city-financed new buildings started
// since 2018. HPD sizes its loan to the gap and accepts a land price only up to the appraised value, so this
// path's land value is capped at the appraised-value proxy we hold: the nearby development-site price
// (nearbyLandModel). Where fewer than six sales lie within two miles there is none, and the path is not priced.
export const NYC_SUBSIDIZED_RENTAL = {
  asOf: '2026-10-22',
  amiPct: 54,
  minUnits: 50,
  hpdSubsidyPerUnit: 122500,
  hdcSubsidyPerUnit: 65000,
  hdcSubsidyCapPerProject: 15000000,
  taxCreditRate: 0.04,
  taxCreditYears: 10,
  taxCreditPrice: 0.85,
  sources: [
    {label: 'HPD ELLA term sheet, updated 2020-03-10', url: 'https://www.nyc.gov/assets/hpd/downloads/pdfs/services/ella-term-sheet-hpd.pdf'},
    {label: 'HDC ELLA term sheet', url: 'https://www.nyc.gov/assets/hpd/downloads/pdfs/services/ella-term-sheet-hdc.pdf'},
    {label: 'HPD Affordable Housing Production by Building and by Project, Multifamily Finance Program new construction started since 2018', url: 'https://data.cityofnewyork.us/Housing-Development/Affordable-Housing-Production-by-Building/hg8x-zxpr'},
    {label: '4% credit rate floor, Consolidated Appropriations Act, 2021; 10-year credit period, IRC section 42', url: 'https://www.att-law.com/wp-content/uploads/2021/01/4-Rate-Bulletin-2.pdf'},
    {label: 'Novogradac, average LIHTC equity bid of about $0.85 per credit dollar, June 2025', url: 'https://www.novoco.com/documents122001/novogradac_jtc_2025-08-WW_04.pdf'},
  ],
};

// What development sites near a lot sold for: the nearest development-site sales (ledger.mjs) in its borough
// within a mile, each priced per as-of-right buildable SF of its own lot. Where a mile holds fewer than six, the search
// widens to a mile and a half, then two miles; fewer than six within two miles says nothing.
export const LAND_COMPS = {radiiMiles: [1, 1.5, 2], maxSales: 15, minSales: MIN_PEER_SALES};
let landCompCache = {key: null, comps: [], byLatitude: [], appraised: new Map()};

const milesApart = (a, b) => {
  const rad = x => x * Math.PI / 180, dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
};

// What nearby development sites sold for, adjusted to this lot. Each of the nearest earlier sales in the
// lot's borough within a mile (a mile and a half where a mile holds fewer than six, then two miles: LAND_COMPS) is priced per
// as-of-right buildable SF of its own lot and moved to this lot by four measured adjustments: the standing
// building's area against the buildable area (a building the buyer gets with the land), the FAR (extra FAR
// is paid for at a falling rate), the existing apartments (tenants to relocate) and the lot's size (larger
// lots sell for less per SF). The figure is the median of the adjusted prices weighted by e^(-miles), times
// 1.19 on a corner lot and a 0.998 centring constant. Where the search had to widen past a mile, it is also
// times 0.88: on the tuning half, buyers of those sparser sites paid a median 0.88 times the figure
// without it (log median -0.1269 over 62 sites), so sales farther away overstate the lot.
// The coefficients are a ridge fit in log space on the tuning half of the 884 development sites sold since
// January 2025 (sha1 of the BBL even), chosen by five-fold cross-validation over 1.4-mile cells and scored
// once on the other half; nothing is fitted to a borough, ZIP or address. Areas are as-of-right on the lot
// as an empty site without street widths, for this lot as for its comps.
export const NEARBY_LAND_MODEL = {
  asOf: '2026-10-26',
  distanceDecayMiles: 1,
  existingShare: 0.6029, far: -0.3641, units: -0.1167, lotArea: -0.1191, corner: 0.1734, constant: -0.0021,
  widened: -0.1269, maxExistingShare: 2,
};

// The land market a lot trades in: its municipality, which for a New York City lot is its borough, the BBL's
// first digit. Comps come from the lot's own borough only: on the tuning half, keeping sales across a borough
// line out before the radius and count rules lowered the cross-validated error of the figure. A lot without a
// BBL keeps every sale, and the figure says so (inBorough).
const landMarket = ({bbl}) => (bbl ? String(bbl)[0] : null);

const nearbyLandTraits = ({lotArea, zfa, existingSf, unitsRes}) => ({
  existingShare: Math.min(NEARBY_LAND_MODEL.maxExistingShare, (Number(existingSf) || 0) / zfa),
  logFar: Math.log(zfa / lotArea), logUnits: Math.log1p(Number(unitsRes) || 0), logLotArea: Math.log(lotArea),
});

// The adjusted nearby price per as-of-right buildable SF for a subject {latitude, longitude, bbl, lotArea,
// zfa, existingSf, unitsRes, corner}, from comps carrying the same traits. Fewer than six sales say nothing.
export function nearbyLandModel(comps, subject) {
  if (!(Number(subject.latitude) && Number(subject.longitude)) || !(subject.zfa > 0) || !(subject.lotArea > 0)) return null;
  const here = {latitude: Number(subject.latitude), longitude: Number(subject.longitude)}, market = landMarket(subject);
  const byDistance = comps.filter(c => c.bbl !== subject.bbl && (!market || landMarket(c) === market)).map(c => ({c, miles: milesApart(here, c)}))
    .filter(x => x.miles <= LAND_COMPS.radiiMiles.at(-1)).sort((a, b) => a.miles - b.miles);
  const lastNeeded = byDistance[LAND_COMPS.minSales - 1]?.miles, radius = LAND_COMPS.radiiMiles.find(r => lastNeeded <= r);
  if (radius === undefined) return null;
  const near = byDistance.filter(x => x.miles <= radius).slice(0, LAND_COMPS.maxSales);
  const m = NEARBY_LAND_MODEL, s = nearbyLandTraits(subject);
  const sales = near.map(({c, miles}) => {
    const f = nearbyLandTraits(c);
    const adjustments = {
      building: Math.exp(m.existingShare * (s.existingShare - f.existingShare)), far: Math.exp(m.far * (s.logFar - f.logFar)),
      units: Math.exp(m.units * (s.logUnits - f.logUnits)), lotArea: Math.exp(m.lotArea * (s.logLotArea - f.logLotArea)),
    };
    const adjusted = c.pricePerBsf * adjustments.building * adjustments.far * adjustments.units * adjustments.lotArea;
    return {docId: c.docId, bbl: c.bbl, recordedAt: c.recordedAt, price: c.price, miles: Number(miles.toFixed(2)), weight: Math.exp(-miles / m.distanceDecayMiles),
      pricePerBsf: Math.round(c.pricePerBsf), adjustedPricePerBsf: adjusted, adjustments};
  });
  // The weighted median: the first adjusted price, in order, at which the weights reach half their total.
  const ordered = [...sales].sort((a, b) => a.adjustedPricePerBsf - b.adjustedPricePerBsf);
  const half = ordered.reduce((sum, x) => sum + x.weight, 0) / 2;
  let run = 0;
  const median = ordered.find(x => (run += x.weight) >= half).adjustedPricePerBsf;
  const cornerFactor = subject.corner ? Math.exp(m.corner) : 1, constantFactor = Math.exp(m.constant);
  const widened = radius > LAND_COMPS.radiiMiles[0], widenedFactor = widened ? Math.exp(m.widened) : 1;
  return {
    pricePerBsf: Math.round(median * cornerFactor * constantFactor * widenedFactor), saleCount: near.length, withinMiles: Number(near.at(-1).miles.toFixed(2)), months: DEVELOPMENT_SITE_SALES.months,
    inBorough: Boolean(market),
    asOf: near.map(x => x.c.recordedAt).sort().at(-1),
    model: {
      factors: {existingShare: m.existingShare, far: m.far, units: m.units, lotArea: m.lotArea, corner: m.corner, constant: m.constant, distanceDecayMiles: m.distanceDecayMiles},
      medianAdjustedPricePerBsf: Math.round(median), cornerFactor: Number(cornerFactor.toFixed(4)), constantFactor: Number(constantFactor.toFixed(4)),
      // The standing-building share the model adjusts on is capped at 200% of the as-of-right area;
      // say so wherever that ceiling binds on the subject.
      ...((Number(subject.existingSf) || 0) / subject.zfa > m.maxExistingShare ? {existingShareCappedAt: m.maxExistingShare, existingShareUncapped: Number(((Number(subject.existingSf) || 0) / subject.zfa).toFixed(3))} : {}),
      ...(widened ? {searchRadiusMiles: radius, widenedFactor: Number(widenedFactor.toFixed(4))} : {}),
      comps: sales.map(x => ({...x, weight: Number(x.weight.toFixed(3)), adjustedPricePerBsf: Math.round(x.adjustedPricePerBsf),
        adjustments: Object.fromEntries(Object.entries(x.adjustments).map(([k, v]) => [k, Number(v.toFixed(3))]))})),
    },
  };
}

// The traits the nearby model compares, for a listing or parcel row: as-of-right area as an empty site
// without street widths, as the comps are priced.
export function nearbyLandSubject(row) {
  const lotArea = Number(row.pluto_lot_area) || 0;
  const {residFar} = residentialFarFor({zoningDistrict: row.zoning_district, residFar: row.resid_far, affResFar: row.aff_res_far});
  return {latitude: row.latitude, longitude: row.longitude, bbl: row.bbl ?? null, lotArea, zfa: Math.round(lotArea * (Number(residFar) || 0)),
    existingSf: Number(row.pluto_bldg_area) || 0, unitsRes: Number(row.units_res) || 0, corner: String(row.pluto_lot_type ?? '') === '3'};
}

// Where nearby development sites sold (nearbyLand), the deal tier is the ask against what they sold for
// on this lot's as-of-right area: Great at 70% of it or less, Good at 85%, Fair at 100%, above that Full
// price. The residual at the account's costs stays beside it as the developer check.
export const NEARBY_PRICE_TIERS = {great_deal: 0.70, good_deal: 0.85, fair_deal: 1.00};

// Transfer taxes the buyer pays on a residential (1 to 3 family, condo or co-op) conveyance in New York
// City: the State additional ("mansion") tax of 1% from $1 million plus the City supplemental tax from
// $2 million. The base transfer taxes fall on the seller.
export const NYC_BUYER_TRANSFER_TAX = {
  asOf: '2026-10-18',
  source: 'NYS Department of Taxation and Finance, real estate transfer tax; Form TP-584-NYC-I',
  sourceUrl: 'https://www.tax.ny.gov/bus/transfer/rptidx.htm',
  residentialRates: [
    {minPrice: 25_000_000, rate: 0.039},
    {minPrice: 20_000_000, rate: 0.0375},
    {minPrice: 15_000_000, rate: 0.035},
    {minPrice: 10_000_000, rate: 0.0325},
    {minPrice: 5_000_000, rate: 0.0225},
    {minPrice: 3_000_000, rate: 0.015},
    {minPrice: 2_000_000, rate: 0.0125},
    {minPrice: 1_000_000, rate: 0.01},
  ],
};

// Whole lots, the listings a development screen can price. A for-sale sync reads these in full per
// borough, apart from the capped mixed pull that also brings condo and co-op units for comps;
// units are about 60% of NYC listings and would otherwise use up the cap.
export const WHOLE_LOT_PROPERTY_TYPES = ['single_family', 'multi_family', 'townhomes', 'duplex_triplex', 'land'];
// Realtor.com serves at most 10,000 results per query; the largest borough lists about 3,500 whole lots.
export const FULL_PULL_LIMIT = 10000;
const FULL_PULL_TIMEOUT_MS = 300000;
export const FOR_SALE_STALE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export const DEFAULT_MARKET_SYNC_CONFIG = {
  autoSyncEnabled: false, // Paused by default during beta once seeded
  syncIntervalHours: 6,
  updatedInPastHours: null,
  limitPerType: 300,
  fullForSalePull: true,
  pastDays: 180,
  enrichPluto: true,
  onDemandSyncIfEmpty: true,
  writeThroughComps: true,
  locations: [...NYC_BOROUGH_LOCATIONS],
  listingTypes: ['for_sale', 'sold', 'for_rent'],
  propertyTypes: ['land', 'multi_family', 'townhomes', 'duplex_triplex', 'single_family', 'condos'],
};

function clampNum(val, min, max, fallback, digits = null) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return digits != null ? Number(clamped.toFixed(digits)) : clamped;
}

export function normalizeSyncConfig(input = {}, base = DEFAULT_MARKET_SYNC_CONFIG) {
  const b = {...DEFAULT_MARKET_SYNC_CONFIG, ...(base || {})};
  if (!input || typeof input !== 'object') return b;
  const validListingTypes = new Set(['for_sale', 'sold', 'for_rent', 'pending', 'off_market']);
  const locations = Array.isArray(input.locations)
    ? input.locations.map(s => String(s || '').trim()).filter(Boolean).slice(0, 50)
    : b.locations;
  const listingTypes = Array.isArray(input.listingTypes)
    ? input.listingTypes.map(s => String(s || '').trim().toLowerCase()).filter(s => validListingTypes.has(s))
    : b.listingTypes;
  const propertyTypes = Array.isArray(input.propertyTypes)
    ? input.propertyTypes.map(s => String(s || '').trim().toLowerCase()).filter(Boolean).slice(0, 20)
    : b.propertyTypes;
  const rawHours = input.updatedInPastHours !== undefined ? input.updatedInPastHours : b.updatedInPastHours;
  const updatedInPastHours = (rawHours === null || rawHours === '' || Number(rawHours) <= 0)
    ? null
    : clampNum(rawHours, 1, 720, null, 0);

  return {
    autoSyncEnabled: input.autoSyncEnabled !== undefined ? Boolean(input.autoSyncEnabled) : Boolean(b.autoSyncEnabled),
    syncIntervalHours: clampNum(input.syncIntervalHours, 1, 168, b.syncIntervalHours, 0),
    updatedInPastHours,
    limitPerType: clampNum(input.limitPerType, 10, 1000, b.limitPerType, 0),
    fullForSalePull: input.fullForSalePull !== undefined ? Boolean(input.fullForSalePull) : b.fullForSalePull !== false,
    pastDays: clampNum(input.pastDays, 7, 365, b.pastDays, 0),
    enrichPluto: input.enrichPluto !== undefined ? Boolean(input.enrichPluto) : Boolean(b.enrichPluto),
    onDemandSyncIfEmpty: input.onDemandSyncIfEmpty !== undefined ? Boolean(input.onDemandSyncIfEmpty) : Boolean(b.onDemandSyncIfEmpty),
    writeThroughComps: input.writeThroughComps !== undefined ? Boolean(input.writeThroughComps) : Boolean(b.writeThroughComps),
    locations: locations.length ? locations : [...NYC_BOROUGH_LOCATIONS],
    listingTypes: listingTypes.length ? listingTypes : ['for_sale', 'sold', 'for_rent'],
    propertyTypes: propertyTypes.length ? propertyTypes : [...DEFAULT_MARKET_SYNC_CONFIG.propertyTypes],
  };
}

// The rental and condo hard costs a settings object carries, before clamping: an explicit split
// value wins, then a lone legacy hardCostPerGrossSqft (which pre-split accounts stored as both),
// then the base's split value or its own legacy value.
export function resolveHardCosts(input = {}, base = DEFAULT_NYC_DEV_SETTINGS) {
  const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const baseLegacy = num(base?.hardCostPerGrossSqft);
  const legacy = num(input?.hardCostPerGrossSqft);
  return {
    rental: num(input?.rentalHardCostPerGrossSqft) ?? legacy ?? num(base?.rentalHardCostPerGrossSqft) ?? baseLegacy ?? DEFAULT_NYC_DEV_SETTINGS.rentalHardCostPerGrossSqft,
    condo: num(input?.condoHardCostPerGrossSqft) ?? legacy ?? num(base?.condoHardCostPerGrossSqft) ?? baseLegacy ?? DEFAULT_NYC_DEV_SETTINGS.condoHardCostPerGrossSqft,
  };
}

function normalizedHardCosts(input, base) {
  const {rental, condo} = resolveHardCosts(input, base);
  const rentalHardCostPerGrossSqft = clampNum(rental, 100, 2500, DEFAULT_NYC_DEV_SETTINGS.rentalHardCostPerGrossSqft, 0);
  const condoHardCostPerGrossSqft = clampNum(condo, 100, 2500, DEFAULT_NYC_DEV_SETTINGS.condoHardCostPerGrossSqft, 0);
  // The legacy field reads back as the rental figure for older consumers.
  return {hardCostPerGrossSqft: rentalHardCostPerGrossSqft, rentalHardCostPerGrossSqft, condoHardCostPerGrossSqft};
}

export function normalizeDealSettings(input = {}, base = DEFAULT_NYC_DEV_SETTINGS) {
  const b = {...DEFAULT_NYC_DEV_SETTINGS, ...(base || {})};
  if (!input || typeof input !== 'object') return {...b, ...normalizedHardCosts(base || {}, DEFAULT_NYC_DEV_SETTINGS)};
  return {
    ...normalizedHardCosts(input, base),
    softCostPctOfHard: clampNum(input.softCostPctOfHard, 0, 1.0, b.softCostPctOfHard, 3),
    carryAndFinancingPct: clampNum(input.carryAndFinancingPct, 0, 1.0, b.carryAndFinancingPct, 3),
    zfaToGrossFactor: clampNum(input.zfaToGrossFactor, 1.0, 1.5, b.zfaToGrossFactor, 3),
    zfaToNetEfficiency: clampNum(input.zfaToNetEfficiency, 0.5, 1.0, b.zfaToNetEfficiency, 3),
    operatingExpenseRatio: clampNum(input.operatingExpenseRatio, 0.05, 0.75, b.operatingExpenseRatio, 3),
    greatDealCapRate: clampNum(input.greatDealCapRate, 0.02, 0.20, b.greatDealCapRate, 4),
    goodDealCapRate: clampNum(input.goodDealCapRate, 0.02, 0.20, b.goodDealCapRate, 4),
    badDealCapRate: clampNum(input.badDealCapRate, 0.02, 0.20, b.badDealCapRate, 4),
    greatDealCondoMargin: clampNum(input.greatDealCondoMargin, 0.02, 0.60, b.greatDealCondoMargin, 3),
    goodDealCondoMargin: clampNum(input.goodDealCondoMargin, 0.02, 0.60, b.goodDealCondoMargin, 3),
    badDealCondoMargin: clampNum(input.badDealCondoMargin, 0.02, 0.60, b.badDealCondoMargin, 3),
  };
}

const BOROUGH_BY_CITY_OR_COUNTY = {
  manhattan: 'MN',
  'new york': 'MN',
  brooklyn: 'BK',
  kings: 'BK',
  queens: 'QN',
  bronx: 'BX',
  'the bronx': 'BX',
  'staten island': 'SI',
  richmond: 'SI',
};

const BOROUGH_DEFAULT_BENCHMARKS = {
  MN: {...ANALYST_TIER, tierLabel: 'Manhattan Core Baseline', salePsf: 1650, rentPsfMonth: 6.80, retailRentPsfYear: 115},
  BK: {...ANALYST_TIER, tierLabel: 'Brooklyn Baseline', salePsf: 1050, rentPsfMonth: 4.85, retailRentPsfYear: 75},
  QN: {...ANALYST_TIER, tierLabel: 'Queens Baseline', salePsf: 825, rentPsfMonth: 4.10, retailRentPsfYear: 62},
  BX: {...ANALYST_TIER, tierLabel: 'Bronx Baseline', salePsf: 575, rentPsfMonth: 3.25, retailRentPsfYear: 48},
  SI: {...ANALYST_TIER, tierLabel: 'Staten Island Baseline', salePsf: 550, rentPsfMonth: 2.95, retailRentPsfYear: 42},
  DEFAULT: {...ANALYST_TIER, tierLabel: 'NYC Metro Baseline', salePsf: 850, rentPsfMonth: 4.25, retailRentPsfYear: 65},
};

const NYC_ZIP_PRICING_TIERS = [
  {
    ...ANALYST_TIER,
    tierLabel: 'Prime Downtown & Midtown Manhattan',
    zips: new Set(['10001','10002','10003','10004','10005','10006','10007','10010','10011','10012','10013','10014','10017','10018','10019','10020','10021','10022','10023','10024','10036','10038','10065','10069','10075','10280','10282']),
    salePsf: 2150,
    rentPsfMonth: 8.25,
    retailRentPsfYear: 145,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'Upper East / Upper West / Murray Hill Manhattan',
    zips: new Set(['10016','10025','10028','10044','10128']),
    salePsf: 1675,
    rentPsfMonth: 6.90,
    retailRentPsfYear: 115,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'Upper Manhattan (Harlem / Washington Heights / Inwood)',
    zips: new Set(['10026','10027','10029','10030','10031','10032','10033','10034','10035','10037','10039','10040']),
    salePsf: 975,
    rentPsfMonth: 4.50,
    retailRentPsfYear: 70,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'Prime Brownstone & North Brooklyn (Williamsburg / Park Slope / Gowanus / DUMBO)',
    zips: new Set(['11201','11205','11211','11215','11217','11222','11231','11238','11249']),
    salePsf: 1475,
    rentPsfMonth: 6.10,
    retailRentPsfYear: 95,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'Central Brooklyn (Crown Heights / Bed-Stuy / Bushwick / Prospect Lefferts)',
    zips: new Set(['11206','11213','11216','11218','11221','11225','11226','11232','11233','11237']),
    salePsf: 1050,
    rentPsfMonth: 4.75,
    retailRentPsfYear: 68,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'South & Mid Brooklyn (Bay Ridge / Sunset Park / Flatbush / Midwood)',
    zips: new Set(['11203','11204','11209','11210','11214','11219','11220','11223','11224','11228','11229','11230','11234','11235']),
    salePsf: 850,
    rentPsfMonth: 3.90,
    retailRentPsfYear: 58,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'East Brooklyn (East New York / Brownsville / Canarsie)',
    zips: new Set(['11207','11208','11212','11236','11239']),
    salePsf: 625,
    rentPsfMonth: 3.25,
    retailRentPsfYear: 45,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'Western Queens (Long Island City / Astoria)',
    zips: new Set(['11101','11102','11103','11104','11105','11106','11109']),
    salePsf: 1275,
    rentPsfMonth: 5.45,
    retailRentPsfYear: 82,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'Central Queens & Flushing (Jackson Heights / Elmhurst / Forest Hills / Flushing)',
    zips: new Set(['11354','11355','11368','11369','11370','11372','11373','11374','11375','11377','11378','11385']),
    salePsf: 925,
    rentPsfMonth: 4.20,
    retailRentPsfYear: 68,
  },
  {
    ...ANALYST_TIER,
    tierLabel: 'South Bronx / Mott Haven / Concourse',
    zips: new Set(['10451','10452','10453','10454','10455','10456']),
    salePsf: 660,
    rentPsfMonth: 3.55,
    retailRentPsfYear: 52,
  },
];

export function getSubmarketBenchmarkForZip(zipCode = null, borough = null) {
  const cleanZip = String(zipCode || '').trim().slice(0, 5);
  if (cleanZip) {
    for (const tier of NYC_ZIP_PRICING_TIERS) {
      if (tier.zips.has(cleanZip)) return tier;
    }
    if (/^113|^114|^116/.test(cleanZip)) {
      return {...ANALYST_TIER, tierLabel: 'Outer Queens Submarket', salePsf: 740, rentPsfMonth: 3.55, retailRentPsfYear: 50};
    }
    if (/^104/.test(cleanZip)) {
      return {...ANALYST_TIER, tierLabel: 'North/East Bronx Submarket', salePsf: 560, rentPsfMonth: 3.15, retailRentPsfYear: 44};
    }
    if (/^103/.test(cleanZip)) {
      return {...ANALYST_TIER, tierLabel: 'Staten Island Submarket', salePsf: 575, rentPsfMonth: 3.00, retailRentPsfYear: 42};
    }
  }
  return BOROUGH_DEFAULT_BENCHMARKS[borough] || BOROUGH_DEFAULT_BENCHMARKS.DEFAULT;
}

const isWideFront = frontStreetFeet => Number(frontStreetFeet) >= ZONING_RULES.bulk.streets.wideStreetMinimumWidthFeet;

// Residential FARs under the current text: a curated district's figures (a commercial district's from its
// residential equivalent, ZR 34-112), otherwise PLUTO's. PLUTO can lag the text (it still gives R6 the old
// 2.43), and a near match by suffix is a different district, so only an exact code replaces PLUTO. Where the
// district has a wide-street row and a street the lot fronts is wide, that row governs only the part of the
// lot within 100 ft of the wide street, weighted by area as the envelope does (wideStreetPortion) on the
// lot's rectangle; a lot without tax-map dimensions is taken as wholly within it. Inside a Mandatory
// Inclusionary Housing area the row's affordable figure gives way to its MIH figure where one is curated
// (ZR 23-22: R8's 8.64 holds only outside MIH areas).
export function residentialFarFor({zoningDistrict = null, residFar = 0, affResFar = 0, frontStreetFeet = null, sideStreetFeet = null, lotFront = null, lotDepth = null, inMihArea = null} = {}) {
  const district = describeDistrict(zoningDistrict);
  if (!Number.isFinite(district?.farResidential)) return {residFar, affResFar, source: 'pluto'};
  const narrow = {residFar: district.farResidential, affResFar: district.farResidentialAffordable ?? affResFar};
  const wideSides = district.farResidentialWideStreet ? [...(isWideFront(frontStreetFeet) ? ['front'] : []), ...(isWideFront(sideStreetFeet) ? ['left'] : [])] : [];
  if (!wideSides.length) return {...narrow, source: 'zoning_rules'};
  const wide = district.farResidentialWideStreet;
  const share = lotFront > 0 && lotDepth > 0
    ? wideStreetPortion([[0, 0], [Number(lotFront), 0], [Number(lotFront), Number(lotDepth)], [0, Number(lotDepth)]], wideSides, ZONING_RULES.bulk.streets.widePortionFeet).wideShare
    : 1;
  const weigh = (wideFar, narrowFar) => Number((wideFar * share + narrowFar * (1 - share)).toFixed(3));
  const wideAffordable = inMihArea && wide.mihAreaAffordable != null ? wide.mihAreaAffordable : wide.affordable;
  return {residFar: weigh(wide.standard, narrow.residFar), affResFar: weigh(wideAffordable, narrow.affResFar), wideStreetShare: Number(share.toFixed(3)), source: 'zoning_rules_wide_street'};
}

// A stored tax-lot outline (the MapPLUTO polygon snapped to its front edge, in feet) as the envelope
// reads it, or null when the stored value is missing or not a usable outline.
export function normalizeLotPolygon(value) {
  const stored = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  const points = Array.isArray(stored) ? stored : stored?.polygon;
  if (!Array.isArray(points) || points.length < 3) return null;
  if (!points.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  if (!(polygonArea(points) > 100)) return null;
  return {points, widthFeet: Number(stored?.widthFeet) || null, depthFeet: Number(stored?.depthFeet) || null, frontEdgeIndex: Number.isInteger(stored?.frontEdgeIndex) ? stored.frontEdgeIndex : null};
}

export function computePhysicalEnvelopeAndDeductions({
  lotArea = 0,
  lotFront = null,
  lotDepth = null,
  lotTypeCode = null,
  lotPolygon = null,
  bldgArea = 0,
  residFar = 0,
  affResFar = 0,
  zoningDistrict = null,
  overlay1 = null,
  address = null,
  frontStreetFeet = null,
  sideStreetFeet = null,
  inFloodZone = false,
  settings = DEFAULT_NYC_DEV_SETTINGS,
} = {}) {
  const cfg = {...DEFAULT_NYC_DEV_SETTINGS, ...(settings || {})};
  const lot = Math.max(0, Number(lotArea) || 0);
  const depth = Number(lotDepth) > 15 ? Number(lotDepth) : 100;
  const width = Number(lotFront) > 10 ? Number(lotFront) : (lot > 0 ? Math.max(16, Math.round(lot / depth)) : 25);
  const effectiveLotArea = lot > 0 ? lot : Math.round(width * depth);

  const ltCode = String(lotTypeCode || '').trim();
  const lotType = ltCode === '3' ? 'corner' : ltCode === '4' ? 'through' : 'interior';
  // The mapped front street width when the store has read it, otherwise a guess from the street name with
  // the house number stripped (so "14 MAIN STREET" is not 14th Street); a commercial overlay says nothing
  // about the street's width.
  const streetBasis = frontStreetFeet != null ? 'mapped' : 'heuristic';
  const streetName = String(address || '').toUpperCase().replace(/^\s*[\d-]+[A-Z]?\s+/, '');
  const isWideStreet = frontStreetFeet != null ? isWideFront(frontStreetFeet)
    : /\b(AVE|AVENUE|BLVD|BOULEVARD|BROADWAY|BWAY|PKWY|PARKWAY|CONCOURSE|BOWERY|CANAL|FLATBUSH|ATLANTIC|BEDFORD|NOSTRAND|MYRTLE|FULTON|QUEENS|NORTHERN|FORDHAM|14|23|34|42|57|72|79|86|96|110|125|145)\b/.test(streetName);

  // Every program priced here is residential, so the standard envelope takes the residential FAR; a higher
  // commercial FAR is floor area a residential building cannot use.
  const stdFar = Number(residFar) || 0;
  const bonusFar = Math.max(stdFar, Number(affResFar) || 0);
  const paperStandardZfa = Math.round(effectiveLotArea * stdFar);
  const paperUapZfa = Math.round(effectiveLotArea * bonusFar);

  const rawCode = String(zoningDistrict || '').trim().toUpperCase().split('/')[0].trim();
  const district = describeDistrict(rawCode) || describeDistrict(rawCode.replace(/[A-Z]$/, ''));
  // The lot as drawn: the stored MapPLUTO tax-lot outline snapped to its front edge when there is one
  // and its area agrees with the recorded lot area, else the PLUTO frontage-by-depth rectangle. An
  // outline far from the recorded area is some other parcel's shape (a condominium lot, a merged tax
  // lot), so the rectangle stands for the lot instead, under its own agreement test below.
  const snapped = normalizeLotPolygon(lotPolygon);
  const snappedMatchesLot = snapped !== null && (!(lot > 0) || Math.abs(polygonArea(snapped.points) - lot) <= lot * 0.25);
  const rectangle = [[0, 0], [width, 0], [width, depth], [0, depth]];
  const drawnLot = snappedMatchesLot ? snapped.points : rectangle;
  const lotShapeBasis = snappedMatchesLot ? 'mappluto-tax-lot' : 'pluto-rectangle';
  const frontages = [
    {side: 'front', widthFeet: frontStreetFeet != null ? Number(frontStreetFeet) : isWideStreet ? 80 : 60},
    ...(lotType === 'corner' ? [{side: 'left', widthFeet: Number(sideStreetFeet) > 0 ? Number(sideStreetFeet) : 60}] : []),
    ...(lotType === 'through' ? [{side: 'rear', widthFeet: 60}] : []),
  ];

  // The envelopes stack gross footprint area. Its zoning floor area is that less the exempt space inside the
  // walls, recreation and amenity space and exterior wall thickness (ZFA_GROSS_DEDUCTIONS); cellars sit below
  // grade and balconies project past the footprint, so neither takes envelope area. Each envelope stacks to its
  // FAR times that factor, and holds its gross area over the factor in zoning floor area. Without a bonus FAR
  // the affordable envelope is the standard one.
  const d = ZFA_GROSS_DEDUCTIONS;
  const uapRecreationDeductionPct = bonusFar > stdFar ? d.recreationUapPct : d.recreationPct;
  const stdGrossPerZfa = 1 + d.recreationPct + d.exteriorWallPct;
  const uapGrossPerZfa = 1 + uapRecreationDeductionPct + d.exteriorWallPct;
  // When the drawn lot is far from the lot's recorded area (an irregular or mismatched lot with no
  // stored outline) no drawn geometry stands for it.
  const drawnMatchesLot = snappedMatchesLot || !(lot > 0) || Math.abs(width * depth - lot) <= lot * 0.25;
  const envelopeAt = (affordable, far, grossPerZfa) => {
    if (!district || !(effectiveLotArea > 0) || !drawnMatchesLot) return null;
    try {
      return computeEnvelope({rules: ZONING_RULES, district, lot: drawnLot, frontages, use: 'residential', affordable, maxFar: far > 0 ? far * grossPerZfa : undefined});
    } catch { return null; }
  };
  const envStd = envelopeAt(false, stdFar, stdGrossPerZfa);
  const envUap = bonusFar > stdFar ? envelopeAt(true, bonusFar, uapGrossPerZfa) : envStd;

  // Fallback physical geometry if district is not in curated table
  const fallbackRearYardFeet = lotType === 'corner' && depth <= 100 ? 0 : (lotType === 'through' ? 0 : 30);
  const fallbackCoveragePct = lotType === 'corner' ? 100 : 65;
  const maxFootprintByYard = Math.max(0, width * Math.max(0, depth - fallbackRearYardFeet));
  const maxFootprintByCoverage = Math.round(effectiveLotArea * (fallbackCoveragePct / 100));
  const fallbackBaseFootprintSqft = Math.max(0, Math.min(maxFootprintByYard, maxFootprintByCoverage));
  const stepbackFootprintSqft = Math.max(0, Math.min(width * Math.max(0, depth - fallbackRearYardFeet - (isWideStreet ? 10 : 15)), maxFootprintByCoverage));

  const maxBaseHeightFeet = envUap?.controls?.streetWall?.maxBaseHeightFeet ?? (bonusFar >= 6 ? 85 : bonusFar >= 4 ? 65 : 45);
  const maxBuildingHeightFeet = envUap?.controls?.heightLimitFeet ?? (bonusFar >= 7 ? 125 : bonusFar >= 4.5 ? 95 : bonusFar >= 3 ? 75 : 55);
  const maxStoreys = envUap?.storeys?.length ?? Math.max(1, Math.floor(maxBuildingHeightFeet / 10.5));
  const baseStoreys = Math.max(1, Math.min(maxStoreys, Math.floor(maxBaseHeightFeet / 10.5)));
  const upperStoreys = Math.max(0, maxStoreys - baseStoreys);

  const geomMaxZfa = Math.round((baseStoreys * fallbackBaseFootprintSqft) + (upperStoreys * stepbackFootprintSqft));
  // What the achievable areas rest on: the curated envelope, the fallback geometry above, or the paper
  // allowance alone when neither holds any floor area.
  const envelopeBasis = envStd && envUap ? 'curated-envelope' : drawnMatchesLot && geomMaxZfa > 0 ? 'fallback-geometry' : 'paper-only';
  const envelopeZfa = (env, grossPerZfa, paper) => (String(env.metrics.stoppedBy).startsWith('floor area ratio') ? paper : Math.min(paper, Math.round(env.metrics.floorAreaSqft / grossPerZfa)));
  const achievableUapZfa = envUap
    ? envelopeZfa(envUap, uapGrossPerZfa, paperUapZfa)
    : envelopeBasis === 'fallback-geometry' ? Math.min(paperUapZfa, geomMaxZfa) : paperUapZfa;
  const achievableStandardZfa = envStd
    ? envelopeZfa(envStd, stdGrossPerZfa, paperStandardZfa)
    : Math.min(paperStandardZfa, achievableUapZfa);
  // The yards, coverage and height the area rests on: the envelope's own controls when it ran.
  const rearYard = envUap?.controls.yards.rearYard;
  const rearYardFeet = rearYard ? rearYard.requiredFeet : fallbackRearYardFeet;
  const maxLotCoveragePct = envUap ? envUap.controls.coverage.basePercent : fallbackCoveragePct;
  const typicalBaseFootprintSqft = envUap ? envUap.storeys[0].areaSqft : fallbackBaseFootprintSqft;

  const isBulkConstrained = paperUapZfa > 0 && achievableUapZfa < paperUapZfa * 0.94;
  const clippedSqft = Math.max(0, paperUapZfa - achievableUapZfa);

  // Build 3D massing tiers for visual axonometric diagram
  const existingStories = bldgArea > 0 && effectiveLotArea > 0
    ? Math.max(1, Math.round(Number(bldgArea) / Math.max(400, typicalBaseFootprintSqft)))
    : 0;
  const massingTiers = [];
  if (envUap?.levels?.length) {
    for (const lvl of envUap.levels) {
      const fpArea = Math.round(polygonArea(lvl.footprint));
      const b = bounds(lvl.footprint);
      massingTiers.push({
        label: lvl.label,
        storeys: lvl.count,
        heightFeet: lvl.height,
        footprintSqft: fpArea,
        widthFeet: Math.round(b.maxX - b.minX),
        depthFeet: Math.round(b.maxZ - b.minZ),
        use: lvl.use,
      });
    }
  } else if (achievableUapZfa > 0) {
    const baseDepth = Math.max(20, Math.round(typicalBaseFootprintSqft / Math.max(15, width)));
    massingTiers.push({
      label: `Street-Wall Base (1–${baseStoreys})`,
      storeys: baseStoreys,
      heightFeet: 10.5,
      footprintSqft: typicalBaseFootprintSqft,
      widthFeet: Math.round(width),
      depthFeet: baseDepth,
      use: overlay1 ? 'retail + residential' : 'residential',
    });
    if (upperStoreys > 0 && stepbackFootprintSqft > 0) {
      const upperDepth = Math.max(18, Math.round(stepbackFootprintSqft / Math.max(15, width)));
      massingTiers.push({
        label: `Setback / UAP Bonus (${baseStoreys + 1}–${maxStoreys})`,
        storeys: upperStoreys,
        heightFeet: 10.5,
        footprintSqft: stepbackFootprintSqft,
        widthFeet: Math.round(width),
        depthFeet: upperDepth,
        use: 'residential',
      });
    }
  }

  // ZFA-to-gross floor area deductions (see ZFA_GROSS_DEDUCTIONS)
  const effectiveZfa = achievableUapZfa || achievableStandardZfa || Number(bldgArea) || 0;
  const cellarDeductionPct = inFloodZone ? d.cellarFloodZonePct : d.cellarPct; // Flood zone restricts below-grade mechanicals/amenities
  const zoneGreenWallDeductionPct = d.exteriorWallPct;
  const balconyAllowancePct = effectiveZfa >= 4000 ? d.balconyPct : d.balconySmallBuildingPct;

  const computedGrossFactor = Number((1 + cellarDeductionPct + uapRecreationDeductionPct + zoneGreenWallDeductionPct + balconyAllowancePct).toFixed(3));
  const appliedGrossFactor = settings && settings.zfaToGrossFactor !== undefined
    ? Number(cfg.zfaToGrossFactor)
    : computedGrossFactor;
  const scaleRatio = computedGrossFactor > 1 ? (appliedGrossFactor - 1) / (computedGrossFactor - 1) : 1;

  const cellarAndMechanicalSqft = Math.round(effectiveZfa * cellarDeductionPct * scaleRatio);
  const uapRecreationAndAmenitySqft = Math.round(effectiveZfa * uapRecreationDeductionPct * scaleRatio);
  const zoneGreenWallThicknessSqft = Math.round(effectiveZfa * zoneGreenWallDeductionPct * scaleRatio);
  const balconyAllowanceSqft = Math.round(effectiveZfa * balconyAllowancePct * scaleRatio);
  const totalExemptDeductionsSqft = cellarAndMechanicalSqft + uapRecreationAndAmenitySqft + zoneGreenWallThicknessSqft + balconyAllowanceSqft;
  const totalGrossConstructionSqft = effectiveZfa + totalExemptDeductionsSqft;

  // Dynamic core & circulation loss factor (narrow lots <25 ft suffer higher elevator/2-stair core loss)
  const narrowLotCorePenalty = width < 22 ? d.narrowLotUnder22FtCorePenalty : width < 28 ? d.narrowLotUnder28FtCorePenalty : 0;
  const effectiveNetEfficiency = Number(Math.max(0.72, cfg.zfaToNetEfficiency - narrowLotCorePenalty).toFixed(3));
  const coreAndCirculationLossPct = Number((1 - effectiveNetEfficiency).toFixed(3));
  const netSaleableOrRentableSqft = Math.round(effectiveZfa * effectiveNetEfficiency);

  // The summary quotes the controls that produced the area, names the bonus only where one exists, and says
  // when no envelope was drawn.
  const bonusLabel = bonusFar > stdFar ? 'UAP ' : '';
  const envelopeTerms = envUap
    ? [rearYard.above75FeetFeet !== undefined && rearYard.above75FeetFeet !== rearYard.requiredFeet ? `${rearYard.requiredFeet}' rear yard (${rearYard.above75FeetFeet}' above 75')` : `${rearYard.requiredFeet}' rear yard`,
      maxLotCoveragePct ? `${maxLotCoveragePct}% max coverage` : 'coverage set by the yards',
      envUap.controls.heightLimitFeet ? `${envUap.controls.heightLimitFeet}' height cap` : 'no fixed height cap'].join(', ')
    : `${rearYardFeet}' rear yard, ${maxLotCoveragePct}% max coverage, ${maxBuildingHeightFeet}' height cap; fallback geometry, no curated envelope for this district`;
  const lotLabel = lotShapeBasis === 'mappluto-tax-lot'
    ? `${lotType} tax lot on its MapPLUTO outline (${snapped.widthFeet ?? Math.round(width)} ft front)`
    : `${Math.round(width)}'×${Math.round(depth)}' ${lotType} lot`;
  const bulkConstraintSummary = envelopeBasis === 'paper-only'
    ? `Paper ${bonusLabel}ZFA only: no envelope could be drawn for the ${lotLabel}, so the ${paperUapZfa.toLocaleString()} SF allowance is taken as buildable.`
    : isBulkConstrained
      ? `3D Bulk Capped: Paper ${bonusLabel}ZFA is ${paperUapZfa.toLocaleString()} SF, but the ${lotLabel} (${envelopeTerms}) holds ${achievableUapZfa.toLocaleString()} ZFA (-${clippedSqft.toLocaleString()} SF clipped).`
      : `Full ${bonusLabel}FAR Achievable: ${achievableUapZfa.toLocaleString()} ZFA fits within the ${maxStoreys}-story ${lotLabel} (${envelopeTerms}).`;

  return {
    physicalEnvelope: {
      // The measured frontage, unrounded: the narrow-lot cost step is judged on it.
      lotWidthFeet: width,
      lotDepthFeet: Math.round(depth),
      lotAreaSqft: effectiveLotArea,
      lotType,
      streetType: isWideStreet ? 'wide' : 'narrow',
      streetBasis,
      envelopeBasis,
      // What shape the envelope was drawn on, and the outline itself in feet (front on z = 0) when the
      // tax lot's own shape was drawn, so the deal screen and scheme outlines draw the same lot.
      lotShapeBasis,
      lotPolygon: lotShapeBasis === 'mappluto-tax-lot' ? drawnLot : null,
      rearYardFeet,
      maxLotCoveragePct,
      typicalBaseFootprintSqft,
      maxBaseHeightFeet,
      maxBuildingHeightFeet,
      maxStoreys,
      standardStoreys: envStd ? envStd.storeys.length : maxStoreys,
      uapStoreys: envUap ? envUap.storeys.length : maxStoreys,
      existingStories,
      existingBldgAreaSqft: Math.round(Number(bldgArea) || 0),
      paperStandardZfa,
      paperUapZfa,
      achievableStandardZfa,
      achievableUapZfa,
      clippedZfaSqft: clippedSqft,
      isBulkConstrained,
      bulkConstraintSummary,
      massingTiers,
    },
    zfaDeductions: {
      zoningFloorAreaSqft: effectiveZfa,
      cellarAndMechanicalSqft,
      uapRecreationAndAmenitySqft,
      zoneGreenWallThicknessSqft,
      balconyAllowanceSqft,
      totalExemptDeductionsSqft,
      totalGrossConstructionSqft,
      effectiveGrossFactor: effectiveZfa > 0 ? Number((totalGrossConstructionSqft / effectiveZfa).toFixed(3)) : appliedGrossFactor,
      effectiveNetEfficiency,
      coreAndCirculationLossPct,
      netSaleableOrRentableSqft,
      narrowLotPenaltyApplied: narrowLotCorePenalty > 0,
    },
  };
}

export function computeCorridorRetailProfile({
  lotArea = 0,
  commFar = 0,
  overlay1 = null,
  zoningDistrict = null,
  address = null,
  borough = null,
  zipCode = null,
  groundFloorSqft = 0,
  resNetNoiPsfYear = 35,
  capRate = 0.0725,
} = {}) {
  const bench = getSubmarketBenchmarkForZip(zipCode, borough);
  const ov = String(overlay1 || '').trim().toUpperCase();
  const zd = String(zoningDistrict || '').trim().toUpperCase();
  const addr = String(address || '').toUpperCase();
  const cFar = Number(commFar) || 0;
  const hasCommercialOverlay = Boolean(cFar > 0 || /^C[1-8]/.test(ov) || /^C[1-8]/.test(zd) || /^MX/.test(zd));
  const isAvenueCorridor = Boolean(
    hasCommercialOverlay ||
    /\b(AVE|AVENUE|BLVD|BOULEVARD|BROADWAY|BWAY|PKWY|PARKWAY|CONCOURSE|BOWERY|CANAL|FLATBUSH|ATLANTIC|BEDFORD|NOSTRAND|MYRTLE|FULTON|QUEENS|NORTHERN|FORDHAM)\b/.test(addr)
  );
  const lot = Math.max(0, Number(lotArea) || 0);
  // Retail takes the ground floor of the building priced, never more than the lot or the commercial
  // floor area the district allows, less 15% for the residential lobby and core. That floor area, its
  // share of core included, holds no apartments.
  const retailFloorAreaSqft = hasCommercialOverlay && lot > 0
    ? Math.round(Math.min(Number(groundFloorSqft) || 0, lot, cFar > 0 ? lot * cFar : lot))
    : 0;
  const groundFloorRetailSqft = Math.round(retailFloorAreaSqft * 0.85);
  const retailRentPsfYear = hasCommercialOverlay ? bench.retailRentPsfYear : null;
  const incrementalNoiPerRetailSqft = hasCommercialOverlay
    ? Math.max(0, (bench.retailRentPsfYear * 0.82) - resNetNoiPsfYear)
    : 0;
  const retailAnnualNoiUplift = Math.round(groundFloorRetailSqft * incrementalNoiPerRetailSqft);
  const retailValueUplift = capRate > 0 ? Math.round(retailAnnualNoiUplift / capRate) : 0;

  return {
    hasRetailUplift: Boolean(hasCommercialOverlay && retailAnnualNoiUplift > 0),
    hasCommercialOverlay,
    isAvenueCorridor,
    overlay: ov || null,
    commFar: cFar,
    retailFloorAreaSqft,
    groundFloorRetailSqft,
    retailRentPsfYear,
    retailAnnualNoiUplift,
    retailValueUplift,
    corridorLabel: hasCommercialOverlay
      ? (isAvenueCorridor ? 'Avenue Commercial / Retail Corridor' : 'Commercial Overlay (Ground-Floor Retail)')
      : (isAvenueCorridor ? 'Avenue Residential Corridor' : 'Side-Street Residential'),
  };
}

export function computeRentStabilizationProfile({
  unitsRes = null,
  unitsTotal = null,
  yearBuilt = null,
  bldgClass = null,
  specialDistrict = null,
  hpdLastRegistrationDate = null,
  hpdRegistrationEndDate = null,
  hpdRegistrationCheckedAt = null,
  rentStabilizedUnits = null,
  rentStabilizedYear = null,
  asOf = new Date().toISOString().slice(0, 10),
} = {}) {
  const count = value => {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const uRes = count(unitsRes);
  const uTot = count(unitsTotal);
  const rawYear = count(yearBuilt);
  const yb = rawYear > 1750 && rawYear <= new Date().getUTCFullYear() ? rawYear : null;
  const bc = String(bldgClass || '').trim().toUpperCase();
  const sp = String(specialDistrict || '').trim().toUpperCase();
  const countConflict = uRes !== null && uTot !== null && uRes > uTot;
  const incomplete = uRes === null || (uRes > 0 && yb === null) || countConflict;
  // HPD Multiple Dwelling Registration (tesw-yqqr): a registration whose year ends on or after asOf is
  // current. Registration data is "unchecked" until the store has read the feed for this lot.
  const isoDay = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
  const regEnd = isoDay(hpdRegistrationEndDate);
  const regLast = isoDay(hpdLastRegistrationDate);
  const registrationChecked = hpdRegistrationCheckedAt !== null && hpdRegistrationCheckedAt !== undefined || regEnd !== null;
  // Registration years end on September 1 and owners renew late: within the grace window the renewal is due,
  // not lapsed. Same window as hpdRegistrationStatus in nycdb.mjs.
  const lapsedDays = regEnd ? (Date.parse(asOf) - Date.parse(regEnd)) / 86400000 : null;
  const registrationStatus = !registrationChecked ? 'unchecked' : regEnd === null ? 'none' : lapsedDays <= 0 ? 'current' : lapsedDays <= HPD_REGISTRATION_RENEWAL_GRACE_DAYS ? 'renewal_due' : 'expired';
  // These cohorts prioritize document review. They do not establish regulation, occupancy,
  // a stabilized-unit count or HPD CONH applicability for this property and proposed work.
  // A 3+ unit pre-1974 building is a multiple dwelling of record once the registration feed has been read:
  // registered and current, it is occupied; expired or missing, its occupancy is unverified. Either way it is reviewed.
  // Units the owner registered as rent-stabilized with HCR, from the DOF statement of account: a
  // positive count is the strongest public sign of regulated tenants; zero or absent is not proof of
  // none, since the line follows the owner's filing. It is also the tax-benefit signal: 421-a, J-51 and
  // 485-x units must register with HCR, so a post-1974 benefit building with stabilized units shows here.
  // No stored source names a building's exemption program, so the screen does not read one.
  const stabilized = count(rentStabilizedUnits);
  const stabilizedYear = count(rentStabilizedYear);
  const riskLevel = stabilized > 0 ? 'high'
    : incomplete ? 'unknown'
    : uRes >= 6 && yb < 1974 ? 'high'
    : uRes >= 6 ? 'moderate'
    : uRes >= 3 && yb < 1974 ? (registrationStatus === 'unchecked' ? 'unknown' : 'moderate')
    : 'low';
  const badgeLabel = {
    unknown: 'Tenant review: missing data',
    high: 'Tenant review: high flags',
    moderate: 'Tenant review: check records',
    low: 'Tenant review: limited flags',
  }[riskLevel];
  const facts = [
    uRes === null ? 'Residential unit count is unavailable.' : `Records report ${uRes} residential unit${uRes === 1 ? '' : 's'}.`,
    yb === null ? 'Year built is unavailable.' : `Recorded year built: ${yb}.`,
  ];
  if (stabilized > 0) facts.push(`${stabilized} rent-stabilized unit${stabilized === 1 ? '' : 's'} registered with HCR per the ${stabilizedYear ?? 'latest'} DOF statement of account.`);
  else if (stabilized === 0) facts.push(`The ${stabilizedYear ?? 'latest'} DOF statement of account lists no rent-stabilized units; owner filings can lag, so this is not proof of none.`);
  if (countConflict) facts.push('Residential and total unit counts conflict; confirm the records.');
  if (bc) facts.push(`Recorded tax building class: ${bc}; actual use and occupancy need verification.`);
  if (sp) facts.push(`Special district recorded: ${sp}; check HPD coverage separately.`);
  if (registrationStatus === 'current') facts.push(`HPD multiple dwelling registration is current through ${regEnd}${regLast ? ` (last registered ${regLast})` : ''}: a registered, occupied multiple dwelling; expect tenants in place.`);
  else if (registrationStatus === 'renewal_due') facts.push(`HPD multiple dwelling registration year ended ${regEnd}${regLast ? ` (last registered ${regLast})` : ''} and the annual renewal is due, so it may not be posted yet: a registered multiple dwelling; expect tenants in place.`);
  else if (registrationStatus === 'expired') facts.push(`HPD multiple dwelling registration expired on ${regEnd}${regLast ? ` (last registered ${regLast})` : ''}: a multiple dwelling of record whose current occupancy is unverified.`);
  else if (registrationStatus === 'none' && uRes !== null && uRes >= 3) facts.push('No HPD multiple dwelling registration is on file; buildings of three or more units must register, so confirm occupancy and registration compliance.');
  else if (registrationStatus === 'none') facts.push('No HPD multiple dwelling registration is on file (not required under three units).');
  else if (registrationStatus === 'unchecked' && uRes >= 3) facts.push('HPD multiple dwelling registration has not been checked for this lot yet; buildings of three or more units must register, so tenant risk is unknown until it is.');
  facts.push('Check HCR rent histories, prior unit counts, tax benefits and leases. Verify current occupancy and delivery terms, and check HPD CONH coverage for the proposed work.');
  return {
    assessment: 'screening',
    riskLevel,
    estStabilizedUnits: stabilized > 0 ? stabilized : null,
    rentStabilizedYear: stabilized > 0 ? stabilizedYear : null,
    existingUnitsRes: uRes,
    existingUnitsTotal: uTot,
    yearBuilt: yb,
    buildingClass: bc || null,
    conhRequired: null,
    rentRegulationStatus: 'unverified',
    occupancyStatus: 'unverified',
    conhStatus: 'not_assessed',
    hpdRegistration: {status: registrationStatus, lastRegistrationDate: regLast, registrationEndDate: regEnd},
    occupancyConfidence: ['current', 'renewal_due'].includes(registrationStatus) ? 'raised' : 'screening',
    badgeLabel,
    reasons: facts,
    summary: facts.join(' '),
    verificationLinks: [
      {label: 'HCR rent regulation guidance', url: 'https://hcr.ny.gov/rent-stabilization-and-emergency-tenant-protection-act'},
      {label: 'HPD CONH criteria', url: 'https://www.nyc.gov/site/hpd/services-and-information/certification-of-no-harassment-conh.page'},
    ],
  };
}

function median(values, digits = 2) {
  const clean = (values || []).map(Number).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  const raw = clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
  return Number(raw.toFixed(digits));
}

export function inferNycBoroughCode(row = {}) {
  const zip = String(row.zipCode || row.zip_code || '').trim();
  if (/^100|^101|^102/.test(zip)) return 'MN';
  if (/^103/.test(zip)) return 'SI';
  if (/^104/.test(zip)) return 'BX';
  if (/^112/.test(zip)) return 'BK';
  if (/^110|^111|^113|^114|^116/.test(zip)) return 'QN';
  const county = String(row.county || '').trim().toLowerCase();
  if (BOROUGH_BY_CITY_OR_COUNTY[county]) return BOROUGH_BY_CITY_OR_COUNTY[county];
  const city = String(row.city || '').trim().toLowerCase();
  if (BOROUGH_BY_CITY_OR_COUNTY[city]) return BOROUGH_BY_CITY_OR_COUNTY[city];
  return null;
}

function normalizeHouseNumber(val) {
  if (!val) return '';
  const firstToken = String(val).trim().split(/\s+/)[0] || '';
  const cleaned = firstToken.replace(/[^0-9A-Za-z-]/g, '').toUpperCase();
  return /^\d/.test(cleaned) ? cleaned : '';
}

function houseNumbersMatch(itemNum, plutoNum, borough) {
  if (!itemNum || !plutoNum) return false;
  if (itemNum === plutoNum) return true;
  if (borough === 'QN') return false;
  const itemInt = parseInt(itemNum, 10);
  const rangeMatch = plutoNum.match(/^(\d+)-(\d+)$/);
  if (Number.isFinite(itemInt) && rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    if (itemInt >= lo && itemInt <= hi && (itemInt % 2 === lo % 2)) return true;
  }
  return false;
}

// Whether a tax lot's records can describe the listing, on the listing data check thresholds: a listed
// building needs a building of comparable size on the lot, and a listed lot size close to the city's.
function lotFitsListing(item, p) {
  const sqft = Number(item.sqft), bldg = Number(p.bldgarea), lot = Number(item.lot_sqft), plutoLot = Number(p.lotarea);
  const {buildingMultiple, lotSizeShare} = LISTING_DATA_CHECKS;
  if (sqft > 0 && !(bldg > 0 && bldg <= buildingMultiple * sqft && sqft <= buildingMultiple * bldg)) return false;
  return !(lot > 0 && plutoLot > 0 && Math.abs(lot - plutoLot) / plutoLot > lotSizeShare);
}

function normalizeStreetWords(val) {
  return String(val || '')
    .toUpperCase()
    .replace(/^\s*\d+(?!ST\b|ND\b|RD\b|TH\b)[A-Z0-9-]*\s+/, '')
    .replace(/\bSAINT\b/g, 'ST')
    .replace(/\bFIRST\b/g, '1')
    .replace(/\bSECOND\b/g, '2')
    .replace(/\bTHIRD\b/g, '3')
    .replace(/\bFOURTH\b/g, '4')
    .replace(/\bFIFTH\b/g, '5')
    .replace(/\bSIXTH\b/g, '6')
    .replace(/\bSEVENTH\b/g, '7')
    .replace(/\bEIGHTH\b/g, '8')
    .replace(/\bNINTH\b/g, '9')
    .replace(/\bTENTH\b/g, '10')
    .replace(/\b(AVENUE|AVE)\b/g, 'AVE')
    .replace(/\b(STREET|ST)\b/g, 'ST')
    .replace(/\b(BOULEVARD|BLVD)\b/g, 'BLVD')
    .replace(/\b(PLACE|PL)\b/g, 'PL')
    .replace(/\b(ROAD|RD)\b/g, 'RD')
    .replace(/\b(DRIVE|DR)\b/g, 'DR')
    .replace(/\b(PARKWAY|PKWY)\b/g, 'PKWY')
    .replace(/\b(EAST)\b/g, 'E')
    .replace(/\b(WEST)\b/g, 'W')
    .replace(/\b(NORTH)\b/g, 'N')
    .replace(/\b(SOUTH)\b/g, 'S')
    .replace(/(\d+)(?:ST|ND|RD|TH)\b/g, '$1')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LISTING_SAMPLE_SOURCE = 'Median of listings in this ZIP: asking price sample, unlicensed source (Realtor.com via HomeHarvest)';

function closedSaleSampleSource({count, cityClosedCount, earliestSoldDate, latestSoldDate, windowMonths}) {
  const parts = [
    cityClosedCount ? `${cityClosedCount} from NYC Department of Finance recorded sales` : null,
    count - cityClosedCount ? `${count - cityClosedCount} from Realtor.com via HomeHarvest, an unlicensed source` : null,
  ].filter(Boolean);
  return {asOf: latestSoldDate ?? null, source: `Median closed condo and co-op sale price per SF in this ZIP across ${count} closings from ${earliestSoldDate} to ${latestSoldDate}, the last ${windowMonths} months: ${parts.join('; ')}. Asking prices are left out.`};
}

// Where the planned unit size comes from: the measured medians for the exit that sets the value, with
// affordable floor area at the rental size, or the assumed mix.
function plannedUnitMixBasis(unitSizes, exit) {
  const sizes = unitSizes[exit];
  const affordable = exit === 'condo' ? `; affordable floor area at the rental size, ${unitSizeSummary(unitSizes.rental, 'rental')}` : '';
  if (sizes.scope === 'assumed') {
    return {item: 'plannedUnitMix', asOf: DEAL_UNIT_MIX.asOf, source: `${DEAL_UNIT_MIX.source}: about ${sizes.averageNetSqft} SF ${exit === 'rental' ? 'a rental' : 'a condominium'}, too few measured listings nearby${affordable}`};
  }
  const medians = sizes.mix.map(u => `${UNIT_TYPE_NAMES[u.type]} ${u.netSqft}`).join(', ');
  const shares = sizes.mix.map(u => `${Math.round(u.share * 100)}%`).join(', ');
  return {item: 'plannedUnitMix', asOf: sizes.asOf, source: `Realtor.com ${exit === 'rental' ? 'apartments for rent' : 'condominium and co-op apartments sold or for sale'} in ${sizes.label}: median SF by bedroom count (${medians}) weighted by the planned mix (${shares}) to ${sizes.averageNetSqft} SF a unit, from ${sizes.sampleCount} listings${affordable}`};
}

// The ZIP median describes its existing stock, so the basis says when a measured new-building premium
// was applied on top of it, and how it was measured.
function withNewBuildPremium(basis, metric, premium) {
  if (!premium) return basis;
  const what = metric === 'rent' ? 'asking rents' : 'condominium and co-op closing prices per SF';
  const zip = premium.scope.startsWith('zip:');
  const measured = `${premium.buildingCount} buildings completed in the last ${premium.windowYears} years (${premium.pairCount} ${what}), each building's median against the median of other units in its ZIP${zip ? '' : `, across ${premium.zipCount} ZIPs`}`;
  const toward = !zip || premium.toward === 'city' ? 'the citywide figure' : `${BOROUGH_NAMES[premium.toward]}'s figure`;
  const where = premium.scope === 'city'
    ? `the median new-building premium citywide: ${measured}`
    : `the median new-building premium in ${zip ? `ZIP ${premium.scope.slice(4)}` : BOROUGH_NAMES[premium.scope]}, ${premium.rawRatio.toFixed(2)} from ${measured}, pulled toward ${toward} by ${NEW_BUILD_PREMIUM.shrinkBuildings} buildings' weight`;
  return {...basis, asOf: premium.asOf ?? basis.asOf, source: `${basis.source.replace(/\.?$/, '.')} Scaled by ${premium.ratio.toFixed(2)}, ${where}.`};
}

function valuationBasis({cfg, bench, saleFromSample, rentFromSample, saleSample, inMihArea, unitSizes, exit, newBuildPremium, landInBorough}) {
  const benchmark = {asOf: bench.asOf, source: `${bench.tierLabel}: ${bench.source}`};
  const sample = {asOf: null, source: LISTING_SAMPLE_SOURCE};
  // Only recorded closings set the ZIP's sale price; without enough of them the basis says the
  // benchmark is missing and names the submarket figure used in its place.
  const thin = saleSample?.basis === 'too_few_closings' ? `: ${saleSample.count} priced condo and co-op closing${saleSample.count === 1 ? '' : 's'} in the last ${saleSample.windowMonths} months, fewer than the ${saleSample.required} needed` : '';
  const missingSale = {asOf: bench.asOf, source: `No recorded sale benchmark for this ZIP${thin}; asking prices are never used. In its place, ${bench.tierLabel}: ${bench.source}`};
  const settings = Object.entries(cfg).map(([key, value]) => (
    value === DEFAULT_NYC_DEV_SETTINGS[key]
      ? {item: key, value, ...DEFAULT_NYC_DEV_SETTINGS_BASIS[key]}
      : {item: key, value, asOf: null, source: 'Override from admin or user deal settings'}
  ));
  const screen = {asOf: DEAL_SCREEN_ASSUMPTIONS.asOf, source: DEAL_SCREEN_ASSUMPTIONS.source};
  return [
    {item: 'submarketSalePsf', ...(!saleFromSample ? missingSale : saleSample?.basis === 'closed' ? withNewBuildPremium(closedSaleSampleSource(saleSample), 'sale', newBuildPremium?.sale) : sample)},
    {item: 'submarketRentPsfMonth', ...(rentFromSample ? withNewBuildPremium(sample, 'rent', newBuildPremium?.rent) : benchmark)},
    {item: 'retailRentPsfYear', ...benchmark},
    {item: 'zfaGrossDeductions', asOf: ZFA_GROSS_DEDUCTIONS.asOf, source: ZFA_GROSS_DEDUCTIONS.source},
    {item: 'affordableRentPsfMonth', asOf: NYC_AFFORDABLE_RENTS.asOf, source: `${NYC_AFFORDABLE_RENTS.source}, one-bedroom at ${NYC_AFFORDABLE_RENTS.amiPct}% AMI over ${DEAL_SCREEN_ASSUMPTIONS.affordableUnitNetSqft} net SF`},
    {item: 'buyerTransferTax', asOf: NYC_BUYER_TRANSFER_TAX.asOf, source: NYC_BUYER_TRANSFER_TAX.source},
    ...(inMihArea ? [{item: 'mandatoryInclusionaryHousing', asOf: MIH_RULES.asOf, source: `${MIH_RULES.source}; each option's rents scale the HPD ${NYC_AFFORDABLE_RENTS.amiPct}% AMI rent by its income index`}] : []),
    {item: 'hardCost', asOf: NYC_HARD_COST.asOf, source: hardCostBasisText()},
    {item: 'heightClassHardCost', ...screen, source: `${screen.source}; applies to an account's own hard cost, and the narrow-lot factor to both`},
    {item: 'corePerFloor', ...screen},
    {item: 'buyerClosingCost', ...screen},
    {item: 'dwellingUnitFactor', asOf: null, source: `${ZONING_RULES.bulk.density.citations[0]}: ${ZONING_RULES.bulk.density.dwellingUnitFactor} SF of residential floor area a unit, three-quarters rounding up`},
    {item: 'realEstateTaxes', asOf: DEAL_SCREEN_485X.asOf, source: `${DOF_CLASS2.source} (class 1 at 6% for three units or fewer; a wholly commercial building pays class 4 (commercial) at the same income method); income method at a ${(DEAL_SCREEN_485X.dofCapRate * 100).toFixed(1)}% base cap rate, ${DEAL_SCREEN_485X.source}`},
    {item: 'taxIncentive485x', asOf: NYC_485X.asOf, source: `${NYC_485X.source} (${NYC_485X.sourceUrl}) and HPD (${NYC_485X.agencyUrl}): Option B from 6 to 99 units, Option A from 100 with the construction wage floor; the zone is not determined, so 150+ units are priced as large projects; the construction-period exemption is not valued`},
    {item: 'cityFinancedRental', asOf: NYC_SUBSIDIZED_RENTAL.asOf, source: `${NYC_SUBSIDIZED_RENTAL.sources.map(x => x.label).join('; ')}: a building of ${NYC_SUBSIDIZED_RENTAL.minUnits} units or more may be priced as an all-affordable rental at ${NYC_SUBSIDIZED_RENTAL.amiPct}% AMI on average with no real estate taxes, up to $${(NYC_SUBSIDIZED_RENTAL.hpdSubsidyPerUnit + NYC_SUBSIDIZED_RENTAL.hdcSubsidyPerUnit).toLocaleString('en-US')} a unit of HPD and HDC loans (HDC's at most $${(NYC_SUBSIDIZED_RENTAL.hdcSubsidyCapPerProject / 1e6).toFixed(0)} million a project) and 4% tax credit equity, its land capped at appraised value (the median price per buildable SF of at least six development-site sales ${landInBorough ? 'in its borough ' : ''}within a mile; where a mile holds fewer, within a mile and a half, then two miles, times 0.88; else not priced); it sets the land value only where it pays the most`},
    {item: 'wageFloorPremium', asOf: DEAL_SCREEN_485X.asOf, source: `${DEAL_SCREEN_485X.source}: labor ${Math.round(DEAL_SCREEN_485X.laborShareOfHardCost * 100)}% of hard cost, expected wages and supplements $${DEAL_SCREEN_485X.currentHourlyWage} an hour, ${DEAL_SCREEN_485X.constructionMonths} construction months from the valuation date`},
    plannedUnitMixBasis(unitSizes, exit),
    ...settings,
  ];
}

// Buyer transfer tax on a residential conveyance at this price; other property pays none.
export function buyerTransferTaxRate(price, residential) {
  if (!residential || !(Number(price) > 0)) return 0;
  return NYC_BUYER_TRANSFER_TAX.residentialRates.find(b => Number(price) >= b.minPrice)?.rate ?? 0;
}

// The most a buyer can ask for land worth landValue once the buyer's transfer tax and closing costs are
// added, each price paying the tax bracket its own price falls in. Just under a bracket floor the ask stops
// at the floor less a dollar when the higher bracket's tax would carry the cost past the land value.
export function askForLandValue(landValue, residential) {
  const closing = DEAL_SCREEN_ASSUMPTIONS.buyerClosingCostPct;
  if (!residential || !(landValue > 0)) return landValue / (1 + closing);
  const floors = [...NYC_BUYER_TRANSFER_TAX.residentialRates].sort((a, b) => a.minPrice - b.minPrice);
  const brackets = [{minPrice: 0, rate: 0}, ...floors].map((b, i, all) => ({...b, maxPrice: all[i + 1] ? all[i + 1].minPrice - 1 : Infinity}));
  return Math.max(...brackets.map(b => Math.min(landValue / (1 + b.rate + closing), b.maxPrice)).filter((ask, i) => ask >= brackets[i].minPrice));
}

// One to three family homes, with or without a store, are residential conveyances for the mansion tax.
const isOneToThreeFamily = (bldgClass, unitsRes) => {
  const cls = String(bldgClass || '').trim().toUpperCase();
  const units = Number(unitsRes);
  return /^(A|B|C0)/.test(cls) || (/^S[0-3]/.test(cls) && units >= 1 && units <= 3);
};

const heightClassFor = storeys => DEAL_SCREEN_ASSUMPTIONS.heightClasses.find(c => c.maxStoreys === null || storeys <= c.maxStoreys);

const VERDICT_RANK = ['great_deal', 'good_deal', 'fair_deal', 'full_price'];

// DCP updates the MIH areas monthly, so a parcel's MIH status is rechecked after this long.
const MIH_RECHECK_MS = 30 * 24 * 3600 * 1000;

// Conditions that hold the tier down whatever the price: restrictive ones cap it at Fair, ones that
// need review cap it at Good.
// Listing data checks: signs the asking price does not buy exactly this tax lot. Each holds the
// rating at Fair, like a delivery constraint, while the price-only verdict stays visible, and ranks the
// listing after the rest in Best deals. priceShare is the fifth the source's price-under-estimate flag
// uses (PRICE_UNDER_ESTIMATE_SHARE in the HomeHarvest bridge), applied to the land value at the deal costs.
// NYC building class codes (DOF and PLUTO). A unit sale is one apartment or condo unit, not a lot.
const RESIDENTIAL_CONDO_UNIT = new Set(['R1', 'R2', 'R3', 'R4', 'R6']);
const COOP_UNIT = new Set(['C6', 'C8', 'D0', 'D4', 'R9']);
export function classifyBuildingClass(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z][0-9A-Z]$/.test(c)) return null;
  if (RESIDENTIAL_CONDO_UNIT.has(c)) return {style: 'condos', assetClass: 'condo_coop_apartment', unitSale: true};
  if (COOP_UNIT.has(c)) return {style: 'coop', assetClass: 'condo_coop_apartment', unitSale: true};
  if (c[0] === 'R') return {style: 'commercial_condo', assetClass: 'commercial_investment', unitSale: true};
  if (c[0] === 'A') return {style: 'single_family', assetClass: 'townhouse_single_family', unitSale: false};
  if (c[0] === 'B' || c === 'C0') return {style: 'multi_family', assetClass: 'townhouse_single_family', unitSale: false};
  if (c[0] === 'C' || c[0] === 'D') return {style: 'apartment_building', assetClass: 'multifamily_building', unitSale: false};
  if (c[0] === 'S') return {style: 'mixed_use', assetClass: 'multifamily_building', unitSale: false};
  if (c[0] === 'V') return {style: 'land', assetClass: 'land_development', unitSale: false};
  return {style: 'commercial', assetClass: 'commercial_investment', unitSale: false};
}

// buildingShare: an ask per SF of building under half what standing buildings of the same kind sold for in its ZIP.
export const LISTING_DATA_CHECKS = {lotSizeShare: 0.25, buildingMultiple: 5, largeLotSqft: 250_000, priceShare: 0.2, buildingShare: 0.5};
// An ask is a live offer only while its listing is current: a listing under contract for more than pendingDays,
// listed more than listedDays ago, or not updated by its source in quietDays may no longer offer the lot at that price.
export const LISTING_FRESHNESS = {pendingDays: 90, listedDays: 730, quietDays: 365};
// What standing buildings sold for: closings of whole buildings (no units) of each kind in a ZIP over the last
// months, per SF of building area, from the city closed-sales file and listing closings; fewer than minSales say nothing.
export const BUILDING_SALES = {months: 24, minSales: MIN_PEER_SALES, assetClasses: {townhouse_single_family: 'one to three family', multifamily_building: 'multifamily', commercial_investment: 'commercial'}};
export const isListingDataCheck = gate => gate.id.startsWith('data_');
const daysSince = (date, now) => (now - Date.parse(String(date).slice(0, 10))) / 86400000;
const dayOf = date => String(date).slice(0, 10);
export function listingDataChecks(r, {buildingSales = null, now = Date.now()} = {}) {
  const checks = [];
  const lot = Number(r.lot_sqft), plutoLot = Number(r.pluto_lot_area), sqft = Number(r.sqft), plutoBldg = Number(r.pluto_bldg_area);
  const sf = n => Math.round(n).toLocaleString('en-US');
  if (lot > 0 && plutoLot > 0 && Math.abs(lot - plutoLot) / plutoLot > LISTING_DATA_CHECKS.lotSizeShare) checks.push({id: 'data_lot_size', severity: 'restrict', label: 'Lot size to confirm', detail: `The listing gives ${sf(lot)} sq ft of lot; city records show ${sf(plutoLot)} sq ft, so the price may not cover this whole lot.`});
  if (sqft > 0 && plutoBldg > LISTING_DATA_CHECKS.buildingMultiple * sqft) checks.push({id: 'data_building_size', severity: 'restrict', label: 'Building size to confirm', detail: `City records show ${sf(plutoBldg)} sq ft built on the lot against ${sf(sqft)} sq ft in the listing, so the listing may be for part of the property.`});
  if (r.price_far_below_estimate === 1 || r.price_far_below_estimate === true) checks.push({id: 'data_price', severity: 'restrict', label: 'Asking price to confirm', detail: 'The asking price is under a fifth of the listing\'s own estimate, which usually means a placeholder or a partial interest.'});
  if (plutoLot > LISTING_DATA_CHECKS.largeLotSqft) checks.push({id: 'data_large_lot', severity: 'restrict', label: 'Very large lot', detail: `The lot is ${sf(plutoLot)} sq ft, typical of co-op communities and campuses, so the listing is unlikely to convey all of it.`});
  // Queens house numbers are hyphenated (91-03 95th St) and name one address, not a range.
  if (r.borough !== 'QN' && /^\s*\d+\s*[-/]\s*\d+\b/.test(String(r.street_line || r.address || ''))) checks.push({id: 'data_address_range', severity: 'restrict', label: 'Address range', detail: 'The listing covers an address range that may span several tax lots; confirm which lots are included.'});
  const fresh = LISTING_FRESHNESS;
  const stale = /pending|contract/i.test(r.mls_status || '') && r.pending_date && daysSince(r.pending_date, now) > fresh.pendingDays ? `It has been under contract since ${dayOf(r.pending_date)}, so the ask may no longer be on offer.`
    : r.list_date && daysSince(r.list_date, now) > fresh.listedDays ? `It has been on the market since ${dayOf(r.list_date)}; confirm the asking price is still current.`
    : r.last_update_date && daysSince(r.last_update_date, now) > fresh.quietDays ? `Its source has not updated it since ${dayOf(r.last_update_date)}, so it may have been withdrawn; confirm it is still for sale.` : null;
  if (stale) checks.push({id: 'data_stale', severity: 'restrict', label: 'Listing may be out of date', detail: stale});
  const ask = Number(r.list_price), askPsf = ask / plutoBldg;
  if (buildingSales && ask > 0 && plutoBldg > 0 && askPsf < LISTING_DATA_CHECKS.buildingShare * buildingSales.pricePerSqft) checks.push({id: 'data_price_vs_building', severity: 'restrict', label: 'Asking price to confirm', detail: `The ask is $${Math.round(askPsf)} per SF of building; ${buildingSales.saleCount} ${buildingSales.kind} buildings in ZIP ${buildingSales.zipCode} sold for a median of $${Math.round(buildingSales.pricePerSqft)} per SF in the last ${buildingSales.months} months. Confirm the price is current and buys the whole building.`});
  return checks;
}

function dealGates({landmark, rentStabilizationRisk, inFloodZone, floorplateSqft}) {
  const gates = [];
  if (landmark) gates.push({id: 'landmark', severity: 'restrict', label: 'Landmark or historic district', detail: 'Demolition and new construction need Landmarks Preservation Commission approval.'});
  if (rentStabilizationRisk === 'high') gates.push({id: 'tenants', severity: 'restrict', label: 'Likely rent-regulated tenants', detail: 'Records point to rent-stabilized units; delivering the site vacant may take buyouts and years.'});
  else if (rentStabilizationRisk === 'moderate') gates.push({id: 'tenants', severity: 'review', label: 'Tenants to check', detail: 'A multiple dwelling of record; confirm regulation status and occupancy.'});
  // Unknown is never no-risk: an unassessed tenant or flood position holds the tier at Good until verified.
  else if (rentStabilizationRisk === 'unknown') gates.push({id: 'tenants_unknown', severity: 'review', unverified: true, label: 'Tenants unverified', detail: 'The unit count, year built or HPD registration is not known yet, so rent-regulation risk cannot be assessed; confirm regulation status and occupancy before relying on a higher tier.'});
  if (floorplateSqft > 0 && floorplateSqft < DEAL_SCREEN_ASSUMPTIONS.minViableFloorplateSqft) gates.push({id: 'floorplate', severity: 'restrict', label: 'Floor plates too small', detail: `About ${Math.round(floorplateSqft).toLocaleString('en-US')} SF a floor leaves little to sell once stairs and an elevator are in.`});
  if (inFloodZone) gates.push({id: 'flood', severity: 'review', label: 'Flood zone', detail: 'Flood-resistant construction applies and cellar space is limited.'});
  else if (inFloodZone === null) gates.push({id: 'flood_unknown', severity: 'review', unverified: true, label: 'Flood zone unverified', detail: 'Flood-zone status has not been checked for this parcel; confirm it before relying on a higher tier.'});
  return gates;
}

export function computeDealValuation({
  listPrice = null,
  lotArea = 0,
  lotFront = null,
  lotDepth = null,
  lotTypeCode = null,
  lotPolygon = null,
  bldgArea = 0,
  bldgClass = null,
  unitsRes = null,
  residFar: plutoResidFar = 0,
  affResFar: plutoAffResFar = 0,
  commFar = 0,
  facilFar = 0,
  mnfFar = 0,
  overlay1 = null,
  zoningDistrict = null,
  address = null,
  frontStreetFeet = null,
  sideStreetFeet = null,
  borough = null,
  zipCode = null,
  inFloodZone = false,
  landmark = false,
  inMihArea = null,
  mihArea = null,
  rentStabilizationRisk = null,
  submarketSalePsf = null,
  submarketSaleSample = null,
  submarketRentPsf = null,
  newBuildPremium = null,
  unitSizes = ASSUMED_UNIT_SIZES,
  settings = DEFAULT_NYC_DEV_SETTINGS,
  zone485x = undefined,
  valuationDate = new Date().toISOString().slice(0, 10),
  dataChecks = [],
  appraisedLand = null,
  withCandidates = false,
} = {}) {
  const cfg = {...DEFAULT_NYC_DEV_SETTINGS, ...(settings || {})};
  // A lone legacy hard cost (pre-split settings or a partial override) prices both exits.
  const hardCosts = resolveHardCosts(settings || {}, DEFAULT_NYC_DEV_SETTINGS);
  cfg.rentalHardCostPerGrossSqft = hardCosts.rental;
  cfg.condoHardCostPerGrossSqft = hardCosts.condo;
  cfg.hardCostPerGrossSqft = hardCosts.rental;
  const screen = DEAL_SCREEN_ASSUMPTIONS;
  const bench = getSubmarketBenchmarkForZip(zipCode, borough);
  const saleFromSample = Number(submarketSalePsf) > 100;
  const rentFromSample = Number(submarketRentPsf) > 1;
  // A ZIP median measured from listings and closings describes the ZIP's existing stock; a new building
  // earns the measured new-building premium over it. Analyst tier figures are not measured, so no premium.
  const rentPremium = rentFromSample ? newBuildPremium?.rent?.ratio ?? 1 : 1;
  const salePremium = saleFromSample ? newBuildPremium?.sale?.ratio ?? 1 : 1;
  const salePsf = saleFromSample ? Math.round(Number(submarketSalePsf) * salePremium) : bench.salePsf;
  const rentPsf = rentFromSample ? Number((Number(submarketRentPsf) * rentPremium).toFixed(2)) : bench.rentPsfMonth;
  // HPD rents are 30% of the band's income, so they scale with the income index from the 60% AMI figure.
  const affordableRentAt = amiPct => Math.min(rentPsf, NYC_AFFORDABLE_RENTS.monthlyRent.oneBedroom * (amiPct / NYC_AFFORDABLE_RENTS.amiPct) / screen.affordableUnitNetSqft);
  const affordableRentPsf = affordableRentAt(NYC_AFFORDABLE_RENTS.amiPct);
  const {residFar, affResFar, source: farSource} = residentialFarFor({zoningDistrict, residFar: plutoResidFar, affResFar: plutoAffResFar, frontStreetFeet, sideStreetFeet, lotFront, lotDepth, inMihArea});

  const {physicalEnvelope, zfaDeductions} = computePhysicalEnvelopeAndDeductions({
    lotArea,
    lotFront,
    lotDepth,
    lotTypeCode,
    lotPolygon,
    bldgArea,
    residFar,
    affResFar,
    zoningDistrict,
    overlay1,
    address,
    frontStreetFeet,
    sideStreetFeet,
    inFloodZone,
    settings: cfg,
  });

  // The zoning maximum on paper, and the area the envelope can actually hold, which prices the site.
  // Every program priced here is a residential building, so a lot whose district allows no residential
  // floor area as of right (manufacturing and C8 districts outside mixed-use and special districts, which
  // PLUTO gives a residential FAR of 0) has no program and is not rated.
  const residentialBarred = Number(lotArea) > 0 && !(Number(residFar) > 0);
  const stdFar = residentialBarred ? 0 : Number(residFar) || 0;
  const bonusFar = residentialBarred ? 0 : Math.max(stdFar, Number(affResFar) || 0);
  const maxStandardZfa = Math.round((Number(lotArea) || 0) * stdFar);
  const maxUapZfa = Math.round((Number(lotArea) || 0) * bonusFar);
  // The most floor area any use allows on paper (community facility and manufacturing included):
  // the ceiling a buyer with another program in mind would price against.
  const anyUseFar = Math.max(bonusFar, Number(commFar) || 0, Number(facilFar) || 0, Number(mnfFar) || 0);
  const maxAnyUseZfa = Math.round((Number(lotArea) || 0) * anyUseFar);
  const existing = Number(bldgArea) || 0;
  const achievableStandardZfa = maxStandardZfa > 0 ? Math.min(maxStandardZfa, physicalEnvelope.achievableStandardZfa || maxStandardZfa) : 0;
  const achievableUapZfa = maxUapZfa > 0 ? Math.min(maxUapZfa, physicalEnvelope.achievableUapZfa || maxUapZfa) : 0;
  const unusedStandardZfa = Math.max(0, achievableStandardZfa - existing);
  const unusedUapZfa = Math.max(0, achievableUapZfa - existing);

  const ask = Number(listPrice) > 0 ? Number(listPrice) : null;
  const effGrossFactor = zfaDeductions.effectiveGrossFactor || cfg.zfaToGrossFactor;
  const narrowLot = physicalEnvelope.lotWidthFeet < screen.narrowLotWidthFeet;

  // Each program is a building the site could hold. Outside MIH areas: the standard envelope at market
  // rents, or the affordability preference, whose added floor area earns affordable rents. Inside them
  // the preference is unavailable and every new building sets aside a mapped option's share of its
  // residential floor area (ZR 27-111, 27-131), unless it is small enough for the exemption.
  const corridorFor = (baseNoiPerZfa, groundFloorSqft) => computeCorridorRetailProfile({
    lotArea, commFar, overlay1, zoningDistrict, address, borough, zipCode, groundFloorSqft,
    resNetNoiPsfYear: baseNoiPerZfa,
    capRate: cfg.goodDealCapRate,
  });
  const program = (key, zfa, affordableZfa, storeys, amiPct = NYC_AFFORDABLE_RENTS.amiPct) => {
    const floorplateSqft = zfa / Math.max(1, storeys);
    const elevator = storeys > screen.walkUpMaxStoreys;
    const coreSqft = elevator ? screen.corePerFloorSqft.elevator : screen.corePerFloorSqft.walkUp;
    const netEfficiency = Math.max(0, Math.min(zfaDeductions.effectiveNetEfficiency || cfg.zfaToNetEfficiency, (floorplateSqft - coreSqft) / floorplateSqft));
    const heightClass = heightClassFor(storeys);
    // Each exit builds at its own hard cost; the legacy fields carry the rental figures. An exit left at
    // the house figure builds at the published cost range for this structure and price level; an account's
    // own figure takes the height class factor. Both take the narrow-lot factor.
    const hardCostTable = defaultHardCost({storeys, salePsf, valuationDate});
    const fromTable = value => value === DEFAULT_NYC_DEV_SETTINGS.hardCostPerGrossSqft;
    const baseHardCost = value => (fromTable(value) ? hardCostTable.perGrossSqft : value * heightClass.hardCostFactor);
    const narrowFactor = narrowLot ? screen.narrowLotHardCostFactor : 1;
    const rentalHardCostFromTable = fromTable(cfg.rentalHardCostPerGrossSqft), condoHardCostFromTable = fromTable(cfg.condoHardCostPerGrossSqft);
    const rentalHardCostPerGrossSqft = Math.round(baseHardCost(cfg.rentalHardCostPerGrossSqft) * narrowFactor);
    const condoHardCostPerGrossSqft = Math.round(baseHardCost(cfg.condoHardCostPerGrossSqft) * narrowFactor);
    const hardCostPerGrossSqft = rentalHardCostPerGrossSqft;
    const directBuildCostPerZfa = rentalHardCostPerGrossSqft * effGrossFactor * (1 + cfg.softCostPctOfHard);
    const condoDirectBuildCostPerZfa = condoHardCostPerGrossSqft * effGrossFactor * (1 + cfg.softCostPctOfHard);
    const affordableShare = zfa > 0 ? affordableZfa / zfa : 0;
    const marketNoiPerZfa = rentPsf * 12 * netEfficiency * (1 - affordableShare) * (1 - cfg.operatingExpenseRatio);
    const affordableNoiPerZfa = affordableRentAt(amiPct) * 12 * netEfficiency * affordableShare * (1 - cfg.operatingExpenseRatio);
    const corridorProfile = corridorFor(rentPsf * 12 * netEfficiency * (1 - cfg.operatingExpenseRatio), Math.min(floorplateSqft, physicalEnvelope.typicalBaseFootprintSqft));
    const retailNoiPerZfa = zfa > 0 ? corridorProfile.retailAnnualNoiUplift / zfa : 0;
    const retailValuePerZfa = zfa > 0 ? corridorProfile.retailValueUplift / zfa : 0;
    return {
      key, zfa, affordableZfa, amiPct, storeys, floorplateSqft, elevator, netEfficiency, heightClass, hardCostPerGrossSqft, rentalHardCostPerGrossSqft, condoHardCostPerGrossSqft, directBuildCostPerZfa, condoDirectBuildCostPerZfa, corridorProfile,
      hardCostTable, rentalHardCostFromTable, condoHardCostFromTable,
      annualNoiPerZfa: marketNoiPerZfa + affordableNoiPerZfa + retailNoiPerZfa,
      publicFundingPerZfa: 0,
      landCapPerZfa: Infinity,
      // Affordable floor area is never sold as condominiums; it is valued as income at the good-deal yield.
      condoSelloutPerZfa: salePsf * netEfficiency * (1 - affordableShare) + affordableNoiPerZfa / cfg.goodDealCapRate + retailValuePerZfa,
    };
  };
  // A program is rebuilt from its spec at a smaller floor area, so each spec says how its affordable
  // floor area follows the building's.
  const specs = [];
  const mihOptions = inMihArea ? availableMihOptions(mihArea) : [];
  if (inMihArea && achievableUapZfa > 0) {
    for (const key of mihOptions) {
      const option = MIH_RULES.options[key];
      specs.push({key, zfa: achievableUapZfa, affordableFor: zfa => zfa * option.affordableShare, storeys: physicalEnvelope.uapStoreys, amiPct: option.amiPct});
    }
    const exemptZfa = Math.min(achievableUapZfa, MIH_RULES.smallProject.maxResidentialSqft);
    // Storeys scale with floor area rounded up, so no storey holds more than the full building's do.
    // The exemption holds only at or under both thresholds, so its building is capped at the unit count too.
    specs.push({key: 'mih_exempt', zfa: exemptZfa, affordableFor: () => 0, storeys: Math.max(1, Math.ceil(physicalEnvelope.uapStoreys * exemptZfa / achievableUapZfa)), maxUnits: MIH_RULES.smallProject.maxUnits});
  } else if (!inMihArea) {
    // The bonus is the floor area above the standard paper maximum, all of it affordable (ZR 23-22); an
    // affordable envelope that only reaches that maximum through its taller heights earns no bonus.
    if (achievableStandardZfa > 0) specs.push({key: 'standard', zfa: achievableStandardZfa, affordableFor: () => 0, storeys: physicalEnvelope.standardStoreys});
    if (achievableUapZfa > maxStandardZfa) specs.push({key: 'uap', zfa: achievableUapZfa, affordableFor: zfa => Math.max(0, zfa - maxStandardZfa), storeys: physicalEnvelope.uapStoreys});
  }
  const affordableBonusNote = !inMihArea && achievableUapZfa > achievableStandardZfa && achievableUapZfa <= maxStandardZfa
    ? `The affordable envelope holds ${achievableUapZfa.toLocaleString('en-US')} SF, more than the standard envelope's ${achievableStandardZfa.toLocaleString('en-US')} SF only through its taller heights and not above the ${maxStandardZfa.toLocaleString('en-US')} SF standard allowance, so it earns no bonus floor area and is not priced.`
    : null;
  const build = spec => ({...program(spec.key, spec.zfa, spec.affordableFor(spec.zfa), spec.storeys, spec.amiPct), spec});
  const programs = specs.map(build);

  // Rental schemes. A completed rental pays real estate taxes, estimated by DOF's income method on NOI
  // before taxes (the expense ratio covers costs before taxes): class 2, or class 1 at three units or fewer.
  // Each program may also elect 485-x at the option its unit count makes, and a program past 99 units may
  // instead build 99 under Option B, which has no construction wage floor (§ 3). Zoning set-aside floor
  // area counts toward the 485-x share and any shortfall rents at the option's AMI; a set-aside whose
  // AMI average is above the option's (MIH Workforce) is not screened under 485-x.
  const rentalUnitNetSqft = unitSizes.rental.averageNetSqft;
  // Apartments fill the floor area not priced as retail: a ground floor priced as shops holds none. The
  // city-financed building prices every floor at its affordable rents, so its ground floor keeps them.
  const retailFloorOf = p => (p.corridorProfile.hasRetailUplift && !p.cityFinancing ? p.corridorProfile.retailFloorAreaSqft : 0);
  const residentialZfaOf = p => Math.max(0, p.zfa - retailFloorOf(p));
  const rentalUnits = (p, residentialZfa = residentialZfaOf(p)) => Math.min(p.spec.maxUnits ?? Infinity, Math.max(1, mostUnitsAllowed(residentialZfa)), Math.max(1, Math.floor(residentialZfa * p.netEfficiency / rentalUnitNetSqft)));
  const nonResidentialShareOf = p => (p.corridorProfile.hasRetailUplift ? p.corridorProfile.groundFloorRetailSqft / (p.zfa * effGrossFactor) : 0);
  const rentalScheme = (p, units, election, unitCap = null) => {
    const taxShare = taxShareOfNoi(units);
    if (!election) {
      const noi = p.annualNoiPerZfa * (1 - taxShare);
      return {...p, units, unitCap, election: null, taxShare, yieldNoiPerZfa: noi, rentalValuePerZfa: capRate => noi / capRate};
    }
    const zoningShare = p.zfa > 0 ? p.affordableZfa / p.zfa : 0;
    const addedShare = Math.max(0, election.restrictedShare - zoningShare);
    const noiBeforeTaxes = p.annualNoiPerZfa - addedShare * (rentPsf - affordableRentAt(election.amiPct)) * 12 * p.netEfficiency * (1 - cfg.operatingExpenseRatio);
    const schedule = exemptionSchedule485x(election, Math.max(zoningShare, election.restrictedShare));
    const nonResidentialShare = nonResidentialShareOf(p);
    const year1 = exemptionFactor485x(schedule, nonResidentialShare, cfg.goodDealCapRate).periods[0].exemption;
    return {
      ...p, units, unitCap, taxShare, election: {...election, addedAffordableZfa: Math.round(addedShare * p.zfa), schedule, nonResidentialShare},
      directBuildCostPerZfa: p.directBuildCostPerZfa * (1 + election.hardCostPremium),
      yieldNoiPerZfa: noiBeforeTaxes * (1 - taxShare * (1 - year1)),
      rentalValuePerZfa: capRate => noiBeforeTaxes * (1 - taxShare) / capRate + noiBeforeTaxes * taxShare * exemptionFactor485x(schedule, nonResidentialShare, capRate).presentValue,
    };
  };
  const rentalSchemes = [];
  for (const p of programs) {
    const units = rentalUnits(p);
    rentalSchemes.push(rentalScheme(p, units, null));
    const elect = (q, count, cap) => {
      const election = dealElection485x({units: count, zone: zone485x ?? null, valuationDate});
      if (election && !(q.affordableZfa > 0 && q.amiPct > election.amiPct)) rentalSchemes.push(rentalScheme(q, count, election, cap));
    };
    elect(p, units, null);
    if (units < 100) continue;
    const cappedZfa = Math.ceil(99 * rentalUnitNetSqft / p.netEfficiency) + retailFloorOf(p);
    if (p.key === 'uap' && !(p.spec.affordableFor(cappedZfa) > 0)) continue; // no bonus area left: the standard building at 99 units
    const capped = build({...p.spec, zfa: cappedZfa, storeys: Math.max(1, Math.ceil(p.storeys * cappedZfa / p.zfa))});
    elect({...capped, uncappedZfa: p.zfa, uncappedUnits: units}, Math.min(99, rentalUnits(capped)), 99);
  }
  const fullTaxNoi = new Map(rentalSchemes.filter(s => !s.election).map(s => [s.spec, s.yieldNoiPerZfa]));

  // Each building of at least the program's size may also be a city-financed, all-affordable rental
  // (NYC_SUBSIDIZED_RENTAL): every unit at the program's average AMI rent, no real estate taxes, and the
  // city's loans and the tax credit equity set against the cost of building, its land capped at the
  // appraised-value proxy on the lot's as-of-right floor area. It competes like any other scheme and sets
  // the land value only where it pays the most; without an appraised value it is not priced.
  const landCap = appraisedLand && maxStandardZfa > 0 ? appraisedLand.pricePerBsf * maxStandardZfa : null;
  for (const p of programs) {
    const units = rentalUnits(p, p.zfa), f = NYC_SUBSIDIZED_RENTAL;
    if (units < f.minUnits || landCap === null) continue;
    const noiPerZfa = affordableRentAt(f.amiPct) * 12 * p.netEfficiency * (1 - cfg.operatingExpenseRatio);
    const loans = units * f.hpdSubsidyPerUnit + Math.min(units * f.hdcSubsidyPerUnit, f.hdcSubsidyCapPerProject);
    const taxCreditEquity = p.directBuildCostPerZfa * p.zfa * f.taxCreditRate * f.taxCreditYears * f.taxCreditPrice;
    rentalSchemes.push({
      ...p, units, unitCap: null, election: null, taxShare: 0, affordableZfa: p.zfa, amiPct: f.amiPct,
      cityFinancing: {units, amiPct: f.amiPct, loans: Math.round(loans), taxCreditEquity: Math.round(taxCreditEquity)},
      publicFundingPerZfa: (loans + taxCreditEquity) / p.zfa,
      landCapPerZfa: landCap / p.zfa,
      yieldNoiPerZfa: noiPerZfa,
      rentalValuePerZfa: capRate => noiPerZfa / capRate,
    });
  }

  // A wholly commercial building on the commercial floor area the district allows, priced at the analyst
  // tier's retail rent for the submarket (the same figure the corridor uplift uses) with class 4 taxes by
  // the DOF income method. It competes for the land like any other scheme, so a lot with no residential
  // floor area as of right is priced rather than left unrated; the full underwriting replaces the tier
  // rent with recorded market inputs (productType 'commercial').
  const commercialFarValue = Number(commFar) || 0;
  const commercialZfa = Math.round((Number(lotArea) || 0) * commercialFarValue);
  // Only where commercial use is the district's own program (a C or MX district, or a C overlay): the
  // tier rent is a retail basis, and a manufacturing district's floor area needs its own underwriting.
  const commercialDistrict = /^(C[1-8]|MX)/.test(String(zoningDistrict || '').trim().toUpperCase()) || /^C[1-8]/.test(String(overlay1 || '').trim().toUpperCase());
  let commercialPriced = false;
  if (commercialDistrict && commercialZfa >= 1000) {
    const storeys = Math.max(1, physicalEnvelope.standardStoreys || 1);
    const spec = {key: 'commercial', zfa: commercialZfa, affordableFor: () => 0, storeys};
    const p = {...program('commercial', commercialZfa, 0, storeys), spec};
    const bench = getSubmarketBenchmarkForZip(zipCode, borough);
    const noiPerZfa = bench.retailRentPsfYear * p.netEfficiency * (1 - cfg.operatingExpenseRatio);
    const taxShare = taxShareOfNoiForClass('4');
    const yieldNoiPerZfa = noiPerZfa * (1 - taxShare);
    rentalSchemes.push({
      ...p, units: 0, unitCap: null, election: null, taxShare,
      commercial: {commFar: commercialFarValue, retailRentPsfYear: bench.retailRentPsfYear, tierLabel: bench.tierLabel},
      annualNoiPerZfa: noiPerZfa, yieldNoiPerZfa,
      rentalValuePerZfa: capRate => yieldNoiPerZfa / capRate,
      condoSelloutPerZfa: 0,
    });
    commercialPriced = true;
  }

  // Land each scheme and exit can pay at a target return, net of construction and carry: a rental scheme
  // at the cap rate less any public funding of its cost, a program sold as condominiums at the margin, and
  // never above a scheme's land cap. Schemes compare on their true residuals, which can be negative; a tier
  // whose best residual is not positive states no threshold. A building held to 99 units competes only
  // when it pays something for the land: when nothing does, a smaller building only loses less.
  const residualPerZfa = (p, exit, target) => Math.min(p.landCapPerZfa, ((exit === 'rental' ? p.rentalValuePerZfa(target) : p.condoSelloutPerZfa * (1 - target)) / (1 + cfg.carryAndFinancingPct)) - (exit === 'rental' ? p.directBuildCostPerZfa - p.publicFundingPerZfa : (p.condoDirectBuildCostPerZfa ?? p.directBuildCostPerZfa)));
  const landOf = (p, exit, target) => ({program: p, exit, value: residualPerZfa(p, exit, target) * p.zfa});
  const bestLand = (capRate, margin) => [...rentalSchemes.map(s => landOf(s, 'rental', capRate)), ...programs.map(p => landOf(p, 'condo', margin))]
    .filter(land => !land.program.unitCap || land.value > 0)
    .reduce((best, land) => (!best || land.value > best.value ? land : best), null);
  const driver = bestLand(cfg.goodDealCapRate, cfg.goodDealCondoMargin);
  // The best city-financed building at the good-deal yield, stated beside the land value whether or not it leads.
  const cityLand = rentalSchemes.filter(s => s.cityFinancing).map(s => landOf(s, 'rental', cfg.goodDealCapRate)).reduce((best, land) => (!best || land.value > best.value ? land : best), null);
  const appraisal = landCap === null ? null : {
    landCap: Math.round(landCap), pricePerBsf: appraisedLand.pricePerBsf, saleCount: appraisedLand.saleCount, withinMiles: appraisedLand.withinMiles,
    basis: `capped at appraised land value (nearby sales): $${Math.round(landCap).toLocaleString('en-US')}, $${appraisedLand.pricePerBsf} per as-of-right buildable SF, the median of ${appraisedLand.saleCount} development-site sales ${appraisedLand.inBorough ? "in the lot's borough " : ''}within ${appraisedLand.withinMiles} miles`,
  };
  const subsidizedRental = cityLand ? (() => {
    const p = cityLand.program, f = NYC_SUBSIDIZED_RENTAL;
    const uncapped = Math.round(residualPerZfa({...p, landCapPerZfa: Infinity}, 'rental', cfg.goodDealCapRate) * p.zfa);
    return {
      appraisal, capped: uncapped > Math.round(cityLand.value), uncappedLandValue: uncapped,
      program: p.key, zfa: Math.round(p.zfa), units: p.units, amiPct: f.amiPct, subsidyPerUnit: Math.round(p.cityFinancing.loans / p.units), taxCreditEquity: p.cityFinancing.taxCreditEquity,
      landValue: Math.round(cityLand.value), landValuePerBsf: Math.round(cityLand.value / p.zfa), leads: driver.program === p,
      basis: `${p.units} units, all at ${f.amiPct}% AMI rents on average, no real estate taxes, $${p.cityFinancing.loans.toLocaleString('en-US')} of HPD and HDC loans (HDC's at most $${(f.hdcSubsidyCapPerProject / 1e6).toFixed(0)} million a project), and 4% tax credit equity at $${f.taxCreditPrice.toFixed(2)} a credit dollar; HDC finances buildings of ${f.minUnits} units or more; ${appraisal.basis} (${f.sources.map(x => x.label).join('; ')}).`,
      sources: f.sources,
    };
  })() : null;
  const lead = driver?.program ?? null;
  const buildableZfa = lead?.zfa ?? 0;

  // The ask buys the land plus the buyer's transfer tax and closing costs, so thresholds are stated as asks.
  // Each threshold pays the bracket of its own price; the acquisition at the ask pays the ask's bracket,
  // and an unpriced listing shows the bracket of its good-deal ask.
  const residential = isOneToThreeFamily(bldgClass, unitsRes);
  const askFor = landValue => askForLandValue(landValue, residential);
  const transferTaxRate = buyerTransferTaxRate(ask ?? (driver ? askFor(driver.value) : 0), residential);
  const acquisitionCostRate = transferTaxRate + screen.buyerClosingCostPct;
  // Each tier's threshold is its land value over the floor area of the building that earns it, which can be
  // a different program from the good-deal lead's; the ask is judged per buildable SF of that same building,
  // so each comparison is the ask against that tier's land value. A tier whose land value is not positive
  // has no threshold and no land value: nothing is stated that the tier does not earn.
  const perBsf = land => { const bsf = land ? Math.round(askFor(land.value) / land.program.zfa) : 0; return bsf > 0 ? bsf : null; };
  const askPerBsf = land => Math.round(ask / land.program.zfa);
  // Infeasible at target returns: even at the lowest (fair) targets no program pays anything for the
  // land. Such a site gets no deal tier and no thresholds.
  const fairLand = buildableZfa > 0 ? bestLand(cfg.badDealCapRate, cfg.badDealCondoMargin) : null;
  const greatLand = buildableZfa > 0 ? bestLand(cfg.greatDealCapRate, cfg.greatDealCondoMargin) : null;
  const infeasibleAtTarget = Boolean(fairLand && !(fairLand.value > 0));
  const greatDealMaxBsf = buildableZfa > 0 && !infeasibleAtTarget ? perBsf(greatLand) : null;
  const goodDealMaxBsf = buildableZfa > 0 && !infeasibleAtTarget ? perBsf(driver) : null;
  const badDealMinBsf = buildableZfa > 0 && !infeasibleAtTarget ? perBsf(fairLand) : null;
  const landAt = (bsf, land) => (bsf ? Math.round(bsf * land.program.zfa) : null);
  const tierBasisOf = land => ({program: land.program.key, exit: land.exit, buildableZfa: Math.round(land.program.zfa)});

  const pricePerBuildableSf = ask && buildableZfa > 0 ? Math.round(ask / buildableZfa) : null;
  const pricePerBuildableZfa = ask && achievableStandardZfa > 0 ? Math.round(ask / achievableStandardZfa) : null;
  const uapPricePerBuildableZfa = ask && achievableUapZfa > 0 ? Math.round(ask / achievableUapZfa) : pricePerBuildableZfa;
  const anyUsePricePerBuildableZfa = ask && maxAnyUseZfa > 0 ? Math.round(ask / maxAnyUseZfa) : null;
  const existingPricePerSqft = ask && existing > 0 ? Math.round(ask / existing) : null;
  // The zoning cap is the site's: a building held to 99 units for 485-x still sits on a lot that allows more.
  const maxBuildableUnits = buildableZfa > 0 ? Math.max(1, mostUnitsAllowed((lead.uncappedZfa ?? buildableZfa) - retailFloorOf(lead))) : (residentialBarred ? null : 0);
  // Planned units: the sellable area after halls, lobby and core, over a typical unit for the exit that
  // sets the value (affordable floor area at the rental size), never above the most the zoning allows.
  let plannedUnits = residentialBarred ? null : 0;
  let plannedUnitBasis = null;
  if (lead && buildableZfa > 0) {
    const unitNetSqft = unitSizes[driver.exit].averageNetSqft;
    const netSellableSqft = Math.round(residentialZfaOf(lead) * lead.netEfficiency);
    const affordableNetSqft = lead.affordableZfa * lead.netEfficiency;
    plannedUnits = driver.exit === 'rental' ? lead.units : Math.min(maxBuildableUnits, Math.max(1, Math.floor((netSellableSqft - affordableNetSqft) / unitNetSqft + affordableNetSqft / rentalUnitNetSqft)));
    const sizes = unitSizes[driver.exit];
    plannedUnitBasis = {
      exit: driver.exit, unitNetSqft, rentalUnitNetSqft, netEfficiency: Number(lead.netEfficiency.toFixed(3)), netSellableSqft, unitCap: lead.unitCap ?? null,
      unitSizes: {scope: sizes.scope, label: sizes.label, sampleCount: sizes.sampleCount, asOf: sizes.asOf, summary: unitSizeSummary(sizes, driver.exit)},
    };
  }
  // The land price per unit is per planned unit; the zoning cap is not a unit count anyone builds.
  const pricePerBuildableUnit = ask && plannedUnits > 0 ? Math.round(ask / plannedUnits) : null;
  const farCompressionPct = existingPricePerSqft && pricePerBuildableSf && existingPricePerSqft > pricePerBuildableSf
    ? Number((((existingPricePerSqft - pricePerBuildableSf) / existingPricePerSqft) * 100).toFixed(1))
    : null;

  let impliedYieldOnCost = null;
  let impliedCondoMargin = null;
  if (pricePerBuildableSf) {
    // Each implied return builds at its own exit's hard cost: the yield at the rental cost, the margin at the condo cost.
    const rentalAllInPerZfa = (pricePerBuildableSf * (1 + acquisitionCostRate) + lead.directBuildCostPerZfa - (driver.exit === 'rental' ? lead.publicFundingPerZfa : 0)) * (1 + cfg.carryAndFinancingPct);
    const condoAllInPerZfa = (pricePerBuildableSf * (1 + acquisitionCostRate) + (lead.condoDirectBuildCostPerZfa ?? lead.directBuildCostPerZfa)) * (1 + cfg.carryAndFinancingPct);
    // Year-one NOI after the taxes the scheme pays; a condominium lead is held as a rental at full taxes.
    const yieldNoiPerZfa = driver.exit === 'rental' ? lead.yieldNoiPerZfa : fullTaxNoi.get(lead.spec);
    impliedYieldOnCost = Number(((yieldNoiPerZfa / rentalAllInPerZfa) * 100).toFixed(2));
    impliedCondoMargin = lead.condoSelloutPerZfa > 0 ? Number((((lead.condoSelloutPerZfa - condoAllInPerZfa) / lead.condoSelloutPerZfa) * 100).toFixed(1)) : null;
  }

  const unusedForLead = Math.max(0, buildableZfa - existing);
  // What nearby development sites sold for, on this lot's as-of-right area (appraisedLand is that price,
  // from sales recorded before today). Where it exists and a building is priced, the ask is judged against
  // it, not the residual.
  const nearbyLand = appraisedLand ? {
    perBuildableSqft: appraisedLand.pricePerBsf, sales: appraisedLand.saleCount, radiusMiles: appraisedLand.withinMiles, months: appraisedLand.months, asOf: appraisedLand.asOf, inBorough: appraisedLand.inBorough,
    value: maxStandardZfa > 0 ? Math.round(appraisedLand.pricePerBsf * maxStandardZfa) : null, model: appraisedLand.model ?? null,
  } : null;
  const byNearby = nearbyLand?.value > 0 && buildableZfa > 0;
  const askToNearby = byNearby && pricePerBuildableSf ? Number((ask / nearbyLand.value).toFixed(3)) : null;
  let priceVerdict = 'unpriced_opportunity';
  if (residentialBarred && !commercialPriced) {
    priceVerdict = null;
  } else if (infeasibleAtTarget) {
    // Settled Q3: a site that does not pencil at target returns gets no deal tier at any
    // ask, nearby sales or not. Nearby sales stay on the card as market context only.
    priceVerdict = null;
  } else if (askToNearby !== null) {
    if (askToNearby <= NEARBY_PRICE_TIERS.great_deal && (unusedForLead >= 1000 || existing === 0)) priceVerdict = 'great_deal';
    else if (askToNearby <= NEARBY_PRICE_TIERS.good_deal && (unusedForLead >= 500 || existing === 0)) priceVerdict = 'good_deal';
    else if (askToNearby <= NEARBY_PRICE_TIERS.fair_deal) priceVerdict = 'fair_deal';
    else priceVerdict = 'full_price';
  } else if (ask && pricePerBuildableSf) {
    if (askPerBsf(greatLand) <= greatDealMaxBsf && (unusedForLead >= 1000 || existing === 0)) priceVerdict = 'great_deal';
    else if (pricePerBuildableSf <= goodDealMaxBsf && (unusedForLead >= 500 || existing === 0)) priceVerdict = 'good_deal';
    else if (askPerBsf(fairLand) <= badDealMinBsf) priceVerdict = 'fair_deal';
    else priceVerdict = 'full_price';
  } else if (ask) {
    priceVerdict = 'unmatched_parcel';
  }
  const gates = [...dealGates({landmark, rentStabilizationRisk, inFloodZone, floorplateSqft: lead?.floorplateSqft ?? 0}), ...dataChecks];
  // An ask far under what the land is worth at these costs rarely buys the whole lot as matched: a unit on a
  // condominium or co-op lot, a share, or part of a campus. It holds the tier whatever the listing states.
  // On the nearby price the land is worth what nearby development sites sold for.
  if (askToNearby !== null ? askToNearby < LISTING_DATA_CHECKS.priceShare : pricePerBuildableSf && goodDealMaxBsf && pricePerBuildableSf < LISTING_DATA_CHECKS.priceShare * goodDealMaxBsf) {
    const worth = askToNearby !== null ? `${nearbyLand.value.toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0})} nearby development sites sold for on this lot's area` : `$${goodDealMaxBsf} per buildable SF the land is worth at these costs`;
    gates.push({id: 'data_price_vs_land', severity: 'restrict', label: 'Asking price to confirm', detail: `The ask is ${askToNearby !== null ? ask.toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0}) : `$${pricePerBuildableSf} per buildable SF`}, under a fifth of the ${worth}, so it may buy a unit or a share rather than this whole ${Math.round(Number(lotArea)).toLocaleString('en-US')} sq ft lot.`});
  }
  if (residentialBarred) gates.push({id: 'no_residential', severity: 'restrict', label: 'No residential use as of right', detail: commercialPriced
    ? `${zoningDistrict || 'The district'} allows no residential floor area as of right, so no rental or condominium building is priced; the commercial building on the district's commercial floor area is priced at the submarket's analyst-tier retail rent, and a manufacturing or community facility program needs its own underwriting.`
    : `${zoningDistrict || 'The district'} allows no residential floor area as of right, so no rental or condominium building is priced; a commercial, manufacturing or community facility program needs its own underwriting.`});
  // Infeasible at target returns: no tier at any ask (Q3), nearby sales or not.
  if (infeasibleAtTarget) gates.push({id: 'infeasible', severity: 'restrict', label: "Doesn't pencil at target returns", detail: `At these rents, prices and costs the building priced is worth less than it costs to build before any land price (best residual ${Math.round(fairLand.value).toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0})} at the lowest return targets), so no deal tier applies at any ask${byNearby ? '; what nearby development sites sold for is market context only while nothing pencils' : ''}.`});
  if (lead?.key === 'mih_exempt') gates.push({id: 'mih_exemption', severity: 'review', label: 'MIH small-project exemption', detail: `Priced as at most ${MIH_RULES.smallProject.maxUnits} units and ${MIH_RULES.smallProject.maxResidentialSqft.toLocaleString('en-US')} SF of residential floor area with no affordable set-aside. The exemption holds only on a zoning lot that existed when ${mihArea.name} was mapped${mihArea.adopted ? ` (${mihArea.adopted})` : ''}; confirm the lot's history.`});
  if (driver?.exit === 'rental' && lead.cityFinancing) gates.push({id: 'city_financing', severity: 'review', label: 'City financing to confirm', detail: `Priced as an all-affordable rental of ${lead.units} units with $${lead.cityFinancing.loans.toLocaleString('en-US')} of HPD and HDC ELLA loans and 4% tax credits. HPD and HDC award these loans project by project and accept a land price only up to its appraised value, so the land value here is ${appraisal.basis}.`});
  const cap = gates.some(g => g.severity === 'restrict') ? 'fair_deal' : gates.length ? 'good_deal' : null;
  // The returns the ask supports bound the tier too. On the land value basis each threshold is its tier's
  // own land value, so price and returns agree; on the nearby price a cheap ask can sit under a tier while
  // the building priced loses money. The ask earns a tier only when some program and exit clears that
  // tier's yield or margin at the ask.
  const returnTargets = [
    ['great_deal', cfg.greatDealCapRate, cfg.greatDealCondoMargin],
    ['good_deal', cfg.goodDealCapRate, cfg.goodDealCondoMargin],
    ['fair_deal', cfg.badDealCapRate, cfg.badDealCondoMargin],
  ];
  const returnsVerdict = VERDICT_RANK.includes(priceVerdict) && pricePerBuildableSf
    ? (returnTargets.find(([, capRate, margin]) => { const land = bestLand(capRate, margin); return askPerBsf(land) <= Math.round(askFor(land.value) / land.program.zfa); })?.[0] ?? 'full_price')
    : null;
  if (returnsVerdict && VERDICT_RANK.indexOf(returnsVerdict) > VERDICT_RANK.indexOf(priceVerdict)) {
    const [missed, capRate, margin] = returnTargets[VERDICT_RANK.indexOf(returnsVerdict) - 1];
    const tierName = {great_deal: 'Great', good_deal: 'Good', fair_deal: 'Fair'}[missed];
    gates.push({id: 'returns', severity: returnsVerdict === 'good_deal' || byNearby ? 'review' : 'restrict', label: 'Returns short of the price tier', detail: `At the ask the building priced yields ${impliedYieldOnCost}% on cost${impliedCondoMargin === null ? '' : ` with a ${impliedCondoMargin}% condo margin`}; ${tierName} needs ${Number((capRate * 100).toFixed(2))}% or a ${Number((margin * 100).toFixed(1))}% margin.`});
  }
  // On the nearby price the returns are the developer check, a note beside the tier, not a cap on it.
  const dealVerdict = VERDICT_RANK.includes(priceVerdict)
    ? [cap, byNearby ? null : returnsVerdict].filter(Boolean).reduce((worst, v) => (VERDICT_RANK.indexOf(v) > VERDICT_RANK.indexOf(worst) ? v : worst), priceVerdict)
    : priceVerdict;
  const dealTierBasis = (residentialBarred && !commercialPriced) || infeasibleAtTarget ? null : {basis: byNearby ? 'nearby' : 'residual', askToNearby, thresholds: byNearby ? NEARBY_PRICE_TIERS : null};

  const leadDirectBuildCostPerZfa = lead ? (driver.exit === 'condo' ? (lead.condoDirectBuildCostPerZfa ?? lead.directBuildCostPerZfa) : lead.directBuildCostPerZfa) : 0;
  const constructionCost = lead ? Math.round(leadDirectBuildCostPerZfa * buildableZfa * (1 + cfg.carryAndFinancingPct)) : 0;
  // The completed building on the exit that sets the value: a rental at the good-deal yield on the NOI after
  // the taxes it pays, or condominiums sold. Both are kept: a condominium lead also reads as a rental at full taxes.
  const leadRental = lead ? (driver.exit === 'rental' ? lead : rentalSchemes.find(s => s.spec === lead.spec && !s.election)) : null;
  const estimatedStabilizedValue = lead ? Math.round(leadRental.rentalValuePerZfa(cfg.goodDealCapRate) * buildableZfa) : null;
  const estimatedCondoSellout = lead ? Math.round(lead.condoSelloutPerZfa * buildableZfa) : null;
  const estimatedRedevValue = lead ? (driver.exit === 'rental' ? estimatedStabilizedValue : estimatedCondoSellout) : null;
  const grossBuildableSqft = Math.round(buildableZfa * effGrossFactor) || zfaDeductions.totalGrossConstructionSqft;
  const corridorProfile = lead?.corridorProfile ?? corridorFor(rentPsf * 12 * cfg.zfaToNetEfficiency * (1 - cfg.operatingExpenseRatio), 0);
  // Every rental scheme the screen compared, with the land it pays at the good-deal cap rate.
  const rentalSchemeSummary = rentalSchemes.map(s => ({
    program: s.key, units: s.units, unitCap: s.unitCap, zfa: Math.round(s.zfa),
    taxes: s.cityFinancing ? 'city-financed' : s.election ? '485-x' : 'full', option: s.election?.option ?? null,
    landValue: Math.round(residualPerZfa(s, 'rental', cfg.goodDealCapRate) * s.zfa),
    leads: driver?.exit === 'rental' && driver.program === s,
  }));
  // Every building and exit the screen weighed for the lead (the set bestLand picks from), most land
  // first: what each pays for the land at the good-deal targets and its returns on the land basis, the
  // ask when there is one and else the land it pays. The site's three schemes are picked from these;
  // the deal list does not ask for them, so its cached valuations stay small.
  const candidateOf = land => {
    const p = land.program, rental = land.exit === 'rental';
    const netSellableSqft = Math.round(residentialZfaOf(p) * p.netEfficiency);
    const affordableNetSqft = p.affordableZfa * p.netEfficiency;
    const units = rental ? p.units : Math.min(p.spec.maxUnits ?? Infinity, mostUnitsAllowed(residentialZfaOf(p)), Math.max(1, Math.floor((netSellableSqft - affordableNetSqft) / unitSizes.condo.averageNetSqft + affordableNetSqft / rentalUnitNetSqft)));
    // Affordable units are rentals at the rental sizes on either exit; the rest follow the exit's mix.
    const affordableUnits = p.affordableZfa > 0 ? Math.min(units, Math.round(rental ? units * p.affordableZfa / p.zfa : affordableNetSqft / rentalUnitNetSqft)) : 0;
    const landBasis = ask ?? Math.max(0, Math.round(land.value));
    const allInPerZfa = (Math.round(landBasis / p.zfa) * (1 + acquisitionCostRate) + (rental ? p.directBuildCostPerZfa : (p.condoDirectBuildCostPerZfa ?? p.directBuildCostPerZfa))) * (1 + cfg.carryAndFinancingPct);
    const completedValue = Math.round((rental ? p.rentalValuePerZfa(cfg.goodDealCapRate) : p.condoSelloutPerZfa) * p.zfa);
    const totalCost = Math.round(allInPerZfa * p.zfa);
    // City loans and tax credit equity fund part of that cost and the carry on it; the developer's own cost is what is left.
    const publicFunding = rental ? Math.round(p.publicFundingPerZfa * (1 + cfg.carryAndFinancingPct) * p.zfa) : 0;
    // The same total by component, before rounding, for the scheme's line-item budget (budget-lines.mjs).
    const hardCostPerGrossSqft = rental ? p.rentalHardCostPerGrossSqft : p.condoHardCostPerGrossSqft;
    const landPaid = Math.round(landBasis / p.zfa) * p.zfa;
    const hardCost = hardCostPerGrossSqft * effGrossFactor * p.zfa, softCost = hardCost * cfg.softCostPctOfHard;
    const wagePremium = rental && p.election ? (hardCost + softCost) * p.election.hardCostPremium : 0;
    const fromTable = rental ? p.rentalHardCostFromTable : p.condoHardCostFromTable;
    const costs = {
      hardCostPerGrossSqft, grossSqft: Math.round(p.zfa * effGrossFactor),
      hardCostBasis: `${fromTable ? `published New York cost range for a ${p.hardCostTable.structureLabel} at this price level` : `your hard cost${p.heightClass.hardCostFactor > 1 ? `, up ${Math.round((p.heightClass.hardCostFactor - 1) * 100)}% ${p.heightClass.label}` : ''}`}${narrowLot ? `, up ${Math.round((screen.narrowLotHardCostFactor - 1) * 100)}% narrow lot` : ''}`,
      land: landPaid, transferTax: landPaid * transferTaxRate, closingCosts: landPaid * screen.buyerClosingCostPct,
      hardCost, softCost, wagePremium,
      financing: (landPaid * (1 + acquisitionCostRate) + hardCost + softCost + wagePremium) * cfg.carryAndFinancingPct,
    };
    return {
      id: [p.key, land.exit, p.cityFinancing ? 'city' : p.election ? `485x-${p.election.option}` : 'full', ...(p.unitCap ? [`cap${p.unitCap}`] : [])].join(':'),
      key: p.key, exit: land.exit, commercial: p.commercial ?? null, zfa: Math.round(p.zfa), grossSqft: Math.round(p.zfa * effGrossFactor), storeys: p.storeys, units,
      unitMix: [...unitMixOf(unitSizes[land.exit], units - affordableUnits), ...unitMixOf(unitSizes.rental, affordableUnits).filter(u => u.units > 0).map(u => ({...u, affordable: true}))],
      affordableZfa: Math.round(p.affordableZfa),
      // The weighted average AMI the affordable floor area is restricted to (the preference's 60%, an MIH option's, the city program's).
      affordableAmiPct: p.affordableZfa > 0 ? p.amiPct : null,
      taxProgram: rental && p.cityFinancing ? {kind: 'city-financed', amiPct: p.cityFinancing.amiPct, loans: p.cityFinancing.loans, taxCreditEquity: p.cityFinancing.taxCreditEquity, landCap: appraisal.landCap}
        : rental && p.election ? {kind: '485-x', option: p.election.option, cappedAt99: p.unitCap === 99} : null,
      leads: land.program === driver?.program && land.exit === driver?.exit,
      returns: {
        landValue: Math.round(land.value), landValuePerBsf: Math.round(land.value / p.zfa), landBasis: ask ? 'ask' : 'land_value',
        yieldOnCost: rental ? Number(((p.yieldNoiPerZfa / (allInPerZfa - p.publicFundingPerZfa * (1 + cfg.carryAndFinancingPct))) * 100).toFixed(2)) : null,
        condoMargin: rental ? null : p.condoSelloutPerZfa > 0 ? Number((((p.condoSelloutPerZfa - allInPerZfa) / p.condoSelloutPerZfa) * 100).toFixed(1)) : null,
        completedValue, totalCost, publicFunding, profit: completedValue + publicFunding - totalCost, costs,
      },
    };
  };
  const candidates = withCandidates && [...rentalSchemes.map(s => landOf(s, 'rental', cfg.goodDealCapRate)), ...programs.map(p => landOf(p, 'condo', cfg.goodDealCondoMargin))]
    .filter(land => land.program.zfa > 0 && (!land.program.unitCap || land.value > 0))
    .sort((a, b) => b.value - a.value)
    .map(candidateOf);

  return {
    maxStandardZfa,
    maxUapZfa,
    standardFar: stdFar,
    uapFar: bonusFar,
    farSource,
    maxAnyUseZfa,
    anyUseFar,
    anyUsePricePerBuildableZfa,
    achievableStandardZfa,
    achievableUapZfa,
    buildableZfa,
    grossBuildableSqft,
    maxBuildableUnits,
    plannedUnits,
    plannedUnitBasis,
    unusedStandardZfa,
    unusedUapZfa,
    // Unused floor area of the building that sets the value: the headroom the tier is judged on.
    unusedForLeadZfa: lead ? Math.round(unusedForLead) : null,
    existingPricePerSqft,
    pricePerBuildableSf,
    pricePerBuildableZfa,
    uapPricePerBuildableZfa,
    pricePerBuildableUnit,
    farCompressionPct,
    submarketTierLabel: bench.tierLabel,
    submarketSalePsf: salePsf,
    submarketRentPsf: rentPsf,
    newBuildPremium: {rent: rentPremium, sale: salePremium},
    affordableRentPsf: Number(affordableRentPsf.toFixed(2)),
    constructionCost,
    estimatedRedevValue,
    estimatedStabilizedValue,
    estimatedCondoSellout,
    completedValueExit: driver?.exit ?? null,
    affordableBonusNote,
    greatDealMaxBsf,
    goodDealMaxBsf,
    badDealMinBsf,
    greatDealMaxLandValue: landAt(greatDealMaxBsf, greatLand),
    goodDealMaxLandValue: landAt(goodDealMaxBsf, driver),
    badDealMinLandValue: landAt(badDealMinBsf, fairLand),
    // The building each threshold is stated on.
    thresholdBasis: badDealMinBsf ? {great: greatDealMaxBsf ? tierBasisOf(greatLand) : null, good: goodDealMaxBsf ? tierBasisOf(driver) : null, fair: tierBasisOf(fairLand)} : null,
    impliedYieldOnCost,
    impliedCondoMargin,
    dealVerdict,
    priceVerdict,
    dealTierBasis,
    nearbyLand,
    infeasibleAtTarget,
    gates,
    valueDriver: driver ? {
      program: lead.key,
      exit: driver.exit,
      buildableZfa,
      affordableZfa: Math.round(lead.affordableZfa),
      storeys: lead.storeys,
      floorplateSqft: Math.round(lead.floorplateSqft),
      netEfficiency: Number(lead.netEfficiency.toFixed(3)),
      heightClass: lead.heightClass.label,
      narrowLot,
      // The lead exit's hard cost, with both exits' figures for the inspector's cost rows.
      hardCostPerGrossSqft: driver.exit === 'condo' ? lead.condoHardCostPerGrossSqft : lead.hardCostPerGrossSqft,
      rentalHardCostPerGrossSqft: lead.rentalHardCostPerGrossSqft,
      condoHardCostPerGrossSqft: lead.condoHardCostPerGrossSqft,
      // What the hard cost is built from: the house cost range's figure for this building or the account's
      // own setting, the height class factor (own settings only) and the narrow-lot factor.
      baseHardCostPerGrossSqft: driver.exit === 'condo' ? (lead.condoHardCostFromTable ? lead.hardCostTable.perGrossSqft : cfg.condoHardCostPerGrossSqft) : (lead.rentalHardCostFromTable ? lead.hardCostTable.perGrossSqft : cfg.rentalHardCostPerGrossSqft),
      baseRentalHardCostPerGrossSqft: lead.rentalHardCostFromTable ? lead.hardCostTable.perGrossSqft : cfg.rentalHardCostPerGrossSqft,
      baseCondoHardCostPerGrossSqft: lead.condoHardCostFromTable ? lead.hardCostTable.perGrossSqft : cfg.condoHardCostPerGrossSqft,
      rentalHardCostFromTable: lead.rentalHardCostFromTable,
      condoHardCostFromTable: lead.condoHardCostFromTable,
      hardCostTable: {...lead.hardCostTable, asOf: NYC_HARD_COST.asOf, lowPerGrossSqft: NYC_HARD_COST.lowPerGrossSqft, highPerGrossSqft: NYC_HARD_COST.highPerGrossSqft},
      heightClassFactor: (driver.exit === 'condo' ? lead.condoHardCostFromTable : lead.rentalHardCostFromTable) ? 1 : lead.heightClass.hardCostFactor,
      narrowLotFactor: narrowLot ? screen.narrowLotHardCostFactor : 1,
      grossFactor: effGrossFactor,
      // The taxes a rental lead carries: full, or the 485-x terms it elected, with the unit cap that
      // election set and the land the best building without that cap pays.
      taxes: driver.exit === 'rental' ? (lead.cityFinancing ? 'city-financed' : lead.election ? '485-x' : 'full') : null,
      cityFinancing: driver.exit === 'rental' && lead.cityFinancing ? {...lead.cityFinancing, appraisal, capped: subsidizedRental.capped, uncappedLandValue: subsidizedRental.uncappedLandValue, sources: NYC_SUBSIDIZED_RENTAL.sources} : null,
      taxShareOfNoi: driver.exit === 'rental' ? Number(lead.taxShare.toFixed(3)) : null,
      taxProgram: driver.exit === 'rental' && lead.election ? taxProgramOf(lead) : null,
      unitCap: driver.exit === 'rental' ? lead.unitCap : null,
      uncappedUnits: lead.uncappedUnits ?? null,
      landValue: Math.round(driver.value),
      uncappedLandValue: lead.unitCap ? Math.max(...rentalSchemeSummary.filter(r => !r.unitCap).map(r => r.landValue)) : null,
    } : null,
    acquisition: {
      transferTaxRate,
      closingCostRate: screen.buyerClosingCostPct,
      cost: ask ? Math.round(ask * acquisitionCostRate) : null,
    },
    corridorProfile,
    rentalSchemes: rentalSchemeSummary,
    subsidizedRental,
    ...(candidates ? {candidates} : {}),
    mih: mihSummary({inMihArea, mihArea, mihOptions, lead, maxBuildableUnits}),
    physicalEnvelope,
    zfaDeductions,
    basis: valuationBasis({cfg, bench, saleFromSample, rentFromSample, saleSample: submarketSaleSample, inMihArea, unitSizes, exit: driver?.exit ?? 'rental', landInBorough: appraisedLand ? appraisedLand.inBorough : true, newBuildPremium: {rent: rentFromSample ? newBuildPremium?.rent ?? null : null, sale: saleFromSample ? newBuildPremium?.sale ?? null : null}}),
  };
}

// The 485-x terms a rental scheme elected, as the card and report state them.
function taxProgramOf(s) {
  const e = s.election;
  return {
    program: '485-x', option: e.option, projectClass: e.key, label: e.label, section: e.section,
    restrictedShare: e.restrictedShare, amiPct: e.amiPct, benefitYears: e.benefitYears,
    schedule: e.schedule.map(r => ({fromYear: r.fromYear, toYear: r.toYear, exemption: Number(r.exemption.toFixed(3))})),
    addedAffordableZfa: e.addedAffordableZfa, wageFloorHourly: e.wageFloorHourly, wageSection: e.wageSection,
    hardCostPremium: Number(e.hardCostPremium.toFixed(4)), nonResidentialShare: Number(e.nonResidentialShare.toFixed(3)),
    taxShareOfNoi: Number(s.taxShare.toFixed(3)),
  };
}

// Whether MIH governs the site and which mapped option, or the exemption, priced it.
function mihSummary({inMihArea, mihArea, mihOptions, lead, maxBuildableUnits}) {
  if (inMihArea === null) return {status: 'unchecked', note: 'Not yet checked against the mapped MIH areas; priced with the affordability preference.'};
  if (!inMihArea) return {status: 'outside'};
  const labels = mihOptions.map(key => MIH_RULES.options[key].label);
  // The lead may be a building no MIH option prices (a wholly commercial building on a C overlay lot).
  const applied = lead?.key === 'mih_exempt' ? 'Small-project exemption' : lead && MIH_RULES.options[lead.key] ? MIH_RULES.options[lead.key].label : null;
  const notes = [];
  if (lead?.key === 'mih_exempt') notes.push(`Priced on the small-project exemption, worth more here than a full building under the mapped options (${labels.join(', ')}).`);
  else if (applied && labels.length > 1) notes.push(`Priced on ${applied}, the least restrictive at this site's rents and costs of the mapped options (${labels.join(', ')}).`);
  else if (lead?.key === 'commercial') notes.push('The building that pays most for this land is wholly commercial, so no MIH option prices it; MIH would bind a residential building here.');
  if (lead && MIH_RULES.options[lead.key] && maxBuildableUnits <= MIH_RULES.fund.maxUnits && lead.zfa < MIH_RULES.fund.residentialSqftUnder) {
    notes.push('A payment to the Affordable Housing Fund may replace the on-site affordable floor area here; HPD sets the contribution, which this screen does not price.');
  }
  return {
    status: 'inside',
    area: mihArea.name,
    adopted: mihArea.adopted,
    ulurp: mihArea.ulurp,
    mappedOptions: labels,
    appliedOption: applied,
    affordableShare: lead ? Number((lead.affordableZfa / lead.zfa).toFixed(3)) : null,
    amiPct: lead && lead.affordableZfa > 0 ? lead.amiPct : null,
    note: notes.join(' ') || null,
  };
}

// A map pin's coordinates, or nulls when the store holds no usable geocode (missing, out of range, or the 0,0 placeholder).
function pinCoordinates(latitude, longitude) {
  const lat = latitude == null || latitude === '' ? NaN : Number(latitude);
  const lon = longitude == null || longitude === '' ? NaN : Number(longitude);
  const valid = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  return valid ? {latitude: lat, longitude: lon} : {latitude: null, longitude: null};
}

const positiveMetric = (...values) => values.map(Number).find(value => Number.isFinite(value) && value > 0) ?? null;

// Capacity used to compare parcels comes from that parcel's own screening inputs.
// Existing floor area and a different parcel's FAR describe different quantities.
function comparableCapacity(row) {
  const uap = positiveMetric(row.max_uap_zfa, row.maxUapZfa, row.uap_max_buildable_zfa);
  if (uap !== null) return {zfa: uap, basis: 'uap_zfa'};
  const standard = positiveMetric(row.max_standard_zfa, row.maxStandardZfa, row.max_buildable_zfa);
  if (standard !== null) return {zfa: standard, basis: 'standard_zfa'};
  const lot = positiveMetric(row.pluto_lot_area, row.lotAreaSqft, row.lot_area_sqft, row.lot_sqft);
  const far = positiveMetric(row.resid_far, row.residFar);
  const zfa = lot !== null && far !== null ? positiveMetric(Math.round(lot * far)) : null;
  return {zfa, basis: zfa !== null ? 'lot_residential_far' : null};
}

// Every listing column the deal valuation reads, including stabilization risk and the listing data checks.
const VALUATION_COLUMNS = [
  'list_price', 'pluto_lot_area', 'pluto_lot_front', 'pluto_lot_depth', 'pluto_lot_type', 'pluto_bldg_area',
  'resid_far', 'aff_res_far', 'comm_far', 'facil_far', 'mnf_far', 'overlay1', 'zoning_district', 'pluto_address', 'address',
  'borough', 'zip_code', 'neighborhood', 'units_res', 'units_total', 'year_built', 'bldg_class', 'special_district', 'landmark_flag', 'flood_zone',
  'in_mih_area', 'mih_area_json', 'hpd_last_registration', 'hpd_registration_end', 'hpd_registration_checked_at',
  'rent_stabilized_units', 'rent_stabilized_year', 'lot_sqft', 'sqft', 'price_far_below_estimate', 'street_line', 'front_street_feet',
  'side_street_feet', 'mls_status', 'list_date', 'pending_date', 'last_update_date', 'lot_polygon_json',
];

// The columns computed sorts rank on, so they rank without loading whole rows.
const COMPUTED_RANK_COLUMNS = ['id', 'latitude', 'longitude', ...VALUATION_COLUMNS].join(', ');

const rentStabilizationOf = r => computeRentStabilizationProfile({
  unitsRes: r.units_res,
  unitsTotal: r.units_total,
  yearBuilt: r.year_built,
  bldgClass: r.bldg_class,
  specialDistrict: r.special_district,
  hpdLastRegistrationDate: r.hpd_last_registration,
  hpdRegistrationEndDate: r.hpd_registration_end,
  hpdRegistrationCheckedAt: r.hpd_registration_checked_at,
  rentStabilizedUnits: r.rent_stabilized_units,
  rentStabilizedYear: r.rent_stabilized_year,
});

// Deal valuation inputs from a stored listing row, its ZIP rollup and the measured unit sizes.
// A parcel record (PLUTO's field names) in the listing columns the valuation reads, for a lot no listing covers.
export function parcelListingRow(p) {
  const num = v => (Number(v) > 0 ? Number(v) : null);
  return {
    list_price: null, pluto_lot_area: num(p.lotarea), pluto_lot_front: num(p.lotfront), pluto_lot_depth: num(p.lotdepth),
    pluto_lot_type: p.lottype != null ? String(p.lottype) : null, pluto_bldg_area: num(p.bldgarea) ?? 0,
    resid_far: Number(p.residfar) || 0, aff_res_far: Number(p.affresfar) || 0, comm_far: Number(p.commfar) || 0,
    facil_far: Number(p.facilfar) || 0, mnf_far: Number(p.mnffar) || 0, overlay1: p.overlay1 || null, zoning_district: p.zonedist1 || null,
    pluto_address: p.address || null, address: p.address || null, borough: p.borough || null, zip_code: p.zipcode ? String(p.zipcode) : null,
    units_res: num(p.unitsres) ?? 0, units_total: num(p.unitstotal) ?? 0, year_built: num(p.yearbuilt), bldg_class: p.bldgclass || null,
    landmark_flag: p.landmark ? 1 : 0, flood_zone: p.pfirm15_flag == null && p.firm07_flag == null ? null : Number(p.pfirm15_flag) === 1 || Number(p.firm07_flag) === 1 ? 1 : 0,
    in_mih_area: null, mih_area_json: null,
    latitude: Number(p.latitude) || null, longitude: Number(p.longitude) || null,
  };
}

export function valuationInputs(r, zipRollup, settings, unitSizeTable, newBuildPremiums = null, appraisedLand = null, buildingSales = null) {
  return {
    listPrice: r.list_price,
    lotArea: r.pluto_lot_area,
    lotFront: r.pluto_lot_front,
    lotDepth: r.pluto_lot_depth,
    lotTypeCode: r.pluto_lot_type,
    lotPolygon: r.lot_polygon_json ?? null,
    bldgArea: r.pluto_bldg_area,
    bldgClass: r.bldg_class,
    unitsRes: r.units_res,
    residFar: r.resid_far,
    affResFar: r.aff_res_far,
    commFar: r.comm_far,
    facilFar: r.facil_far,
    mnfFar: r.mnf_far,
    overlay1: r.overlay1,
    zoningDistrict: r.zoning_district,
    address: r.pluto_address || r.address,
    frontStreetFeet: r.front_street_feet,
    sideStreetFeet: r.side_street_feet,
    borough: r.borough,
    zipCode: r.zip_code,
    inFloodZone: r.flood_zone === null || r.flood_zone === undefined ? null : Boolean(r.flood_zone),
    landmark: Boolean(r.landmark_flag),
    inMihArea: r.in_mih_area === null || r.in_mih_area === undefined ? null : Boolean(r.in_mih_area),
    mihArea: r.in_mih_area ? JSON.parse(r.mih_area_json) : null,
    rentStabilizationRisk: rentStabilizationOf(r).riskLevel,
    // A rollup stored before the benchmark became closings-only may still hold an ask median; only a closed sample prices the exit.
    submarketSalePsf: zipRollup?.devMetrics?.condoSaleSample?.basis === 'closed' ? zipRollup.devMetrics.blendedCondoSalePsf : null,
    submarketSaleSample: zipRollup?.devMetrics?.condoSaleSample ?? null,
    submarketRentPsf: zipRollup?.devMetrics?.blendedRentPsfMonth ?? null,
    unitSizes: unitSizesFor(unitSizeTable, r),
    newBuildPremium: newBuildPremiumFor(newBuildPremiums, r.borough, r.zip_code),
    appraisedLand,
    settings,
    dataChecks: listingDataChecks(r, {buildingSales}),
  };
}

// A valuation is a pure function of the listing's valuation columns, its ZIP rollup, its unit sizes, the
// settings and the valuation date, so the deal list, the map pins and repeat searches reuse one computed per listing
// instead of re-running the envelope for every match. The key is built from the raw columns; the
// inputs are only assembled when the key misses.
const VALUATION_CACHE_LIMIT = 30000;
// The unused floor area a card prints (core-model.js headroomSqft): the building that sets the value, else the
// area with the affordable bonus, then as of right.
const headroomOf = v => (Number.isFinite(v.unusedForLeadZfa) ? v.unusedForLeadZfa : v.unusedUapZfa || v.unusedStandardZfa || (v.unusedUapZfa ?? v.unusedStandardZfa ?? null));

const valuationCache = new Map();
const keyPart = v => (v === null ? '\u0000' : v === undefined ? '\u0001' : v);
function memoizedDealValuation(r, zipRollup, settings, settingsKey, unitSizeTable, newBuildPremiums, appraisedLand, buildingSales) {
  const metrics = zipRollup?.devMetrics;
  const sizes = unitSizesFor(unitSizeTable, r);
  const premium = newBuildPremiumFor(newBuildPremiums, r.borough, r.zip_code);
  let key = `${new Date().toISOString().slice(0, 10)}|${settingsKey}|${keyPart(metrics?.blendedCondoSalePsf)}|${keyPart(metrics?.blendedRentPsfMonth)}|${JSON.stringify(metrics?.condoSaleSample ?? null)}|${keyPart(premium.rent?.scope)}:${keyPart(premium.rent?.ratio)}|${keyPart(premium.sale?.scope)}:${keyPart(premium.sale?.ratio)}`;
  for (const exit of ['rental', 'condo']) key += `|${sizes[exit].scope}:${sizes[exit].averageNetSqft}:${sizes[exit].sampleCount}:${sizes[exit].asOf}`;
  for (const column of VALUATION_COLUMNS) key += `\u001f${keyPart(r[column])}`;
  key += `|${appraisedLand ? `${appraisedLand.pricePerBsf}:${appraisedLand.saleCount}:${appraisedLand.withinMiles}:${appraisedLand.asOf}:${appraisedLand.inBorough}` : '\u0000'}`;
  key += `|${buildingSales ? `${buildingSales.pricePerSqft}:${buildingSales.saleCount}` : '\u0000'}`;
  let val = valuationCache.get(key);
  if (!val) {
    if (valuationCache.size >= VALUATION_CACHE_LIMIT) valuationCache.clear();
    val = computeDealValuation(valuationInputs(r, zipRollup, settings, unitSizeTable, newBuildPremiums, appraisedLand, buildingSales));
    valuationCache.set(key, val);
  }
  return val;
}

// PRAGMA data_version changes whenever another connection commits, so one long-lived reader per store
// file tells whether results computed from an earlier state still hold. Requests open their own
// connections, so every write, theirs included, moves it. In-memory stores have no file and are not cached.
const versionReaders = new Map();
function storeVersion(path) {
  if (path === ':memory:' || !existsSync(path)) return null;
  const {dev, ino, birthtimeMs} = statSync(path);
  const file = `${dev}:${ino}:${birthtimeMs}`;
  let reader = versionReaders.get(path);
  if (reader?.file !== file) {
    reader?.db.close();
    const db = new DatabaseSync(path, {readOnly: true});
    reader = {file, db, version: db.prepare('PRAGMA data_version')};
    versionReaders.set(path, reader);
  }
  return `${file}:${reader.version.get().data_version}`;
}

// Ranked deal searches and the store summary for one state of the store and one valuation date. A
// commit or a new day starts a fresh set, so a cached answer is the answer the store would give now.
const RANKED_CACHE_LIMIT = 8;
const storeCaches = new Map();
function storeCacheFor(path) {
  const version = storeVersion(path);
  if (!version) return null;
  const stamp = `${version}|${new Date().toISOString().slice(0, 10)}`;
  let cache = storeCaches.get(path);
  if (cache?.stamp !== stamp) storeCaches.set(path, cache = {stamp, ranked: new Map(), comps: new Map(), status: null});
  return cache;
}

// Verdicts from best to worst, for the best-deal order.
const VERDICT_ORDER = ['great_deal', 'good_deal', 'unpriced_opportunity', 'fair_deal', 'full_price', 'unmatched_parcel'];

const MARKET_DDL = `
CREATE TABLE IF NOT EXISTS market_listings (
  id TEXT PRIMARY KEY,
  property_id TEXT,
  listing_id TEXT,
  listing_type TEXT NOT NULL,
  mls_status TEXT,
  address TEXT,
  street_line TEXT,
  street_number TEXT,
  street_name TEXT,
  street_suffix TEXT,
  unit TEXT,
  city TEXT,
  borough TEXT,
  state TEXT,
  zip_code TEXT,
  county TEXT,
  fips_code TEXT,
  neighborhood TEXT,
  latitude REAL,
  longitude REAL,
  url TEXT,
  photo_url TEXT,
  style TEXT,
  asset_class TEXT,
  is_dev_candidate INTEGER NOT NULL DEFAULT 0,
  beds INTEGER,
  baths REAL,
  sqft INTEGER,
  sqft_estimated INTEGER NOT NULL DEFAULT 0,
  lot_sqft INTEGER,
  frontage_ft REAL,
  year_built INTEGER,
  stories INTEGER,
  list_price REAL,
  sold_price REAL,
  price_per_sqft REAL,
  rent_per_sqft_month REAL,
  annual_tax REAL,
  avm_available INTEGER NOT NULL DEFAULT 0,
  price_far_below_estimate INTEGER,
  days_on_mls INTEGER,
  list_date TEXT,
  pending_date TEXT,
  sold_date TEXT,
  last_update_date TEXT,
  price_history_json TEXT NOT NULL DEFAULT '[]',
  bbl TEXT,
  pluto_address TEXT,
  zoning_district TEXT,
  overlay1 TEXT,
  special_district TEXT,
  pluto_lot_area REAL,
  pluto_bldg_area REAL,
  pluto_built_far REAL,
  pluto_lot_front REAL,
  pluto_lot_depth REAL,
  pluto_lot_type TEXT,
  resid_far REAL,
  aff_res_far REAL,
  comm_far REAL,
  facil_far REAL,
  mnf_far REAL,
  max_standard_zfa REAL,
  max_any_use_zfa REAL,
  any_use_price_per_buildable_zfa REAL,
  max_uap_zfa REAL,
  gross_buildable_sqft REAL,
  unused_standard_zfa REAL,
  unused_uap_zfa REAL,
  existing_price_per_sqft REAL,
  price_per_buildable_zfa REAL,
  uap_price_per_buildable_zfa REAL,
  price_per_buildable_sf REAL,
  far_compression_pct REAL,
  landmark_flag INTEGER NOT NULL DEFAULT 0,
  flood_zone INTEGER,
  in_mih_area INTEGER,
  mih_area_json TEXT,
  mih_checked_at INTEGER,
  units_res INTEGER,
  units_total INTEGER,
  owner_name TEXT,
  bldg_class TEXT,
  submarket_sale_psf REAL,
  submarket_rent_psf REAL,
  estimated_redev_value REAL,
  great_deal_max_bsf REAL,
  good_deal_max_bsf REAL,
  bad_deal_min_bsf REAL,
  implied_yield_on_cost REAL,
  implied_condo_margin REAL,
  deal_verdict TEXT,
  source TEXT,
  source_name TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_listings_zip_type ON market_listings(zip_code, listing_type);
CREATE INDEX IF NOT EXISTS idx_market_listings_borough_dev ON market_listings(borough, is_dev_candidate, listing_type);
CREATE INDEX IF NOT EXISTS idx_market_listings_bbl ON market_listings(bbl);
CREATE INDEX IF NOT EXISTS idx_market_listings_property ON market_listings(property_id, listing_type);
CREATE INDEX IF NOT EXISTS idx_market_listings_verdict ON market_listings(deal_verdict, uap_price_per_buildable_zfa);
CREATE INDEX IF NOT EXISTS idx_market_listings_coords ON market_listings(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_market_listings_unlocated ON market_listings(id) WHERE latitude IS NULL OR latitude = 0 OR longitude IS NULL OR longitude = 0;

CREATE TABLE IF NOT EXISTS market_submarket_rollups (
  scope_key TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  zip_code TEXT,
  city TEXT,
  state TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  by_bedrooms_json TEXT NOT NULL,
  dev_metrics_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_rollups_zip ON market_submarket_rollups(zip_code);

CREATE TABLE IF NOT EXISTS market_unit_sizes (
  exit TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  label TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  average_net_sqft INTEGER NOT NULL,
  mix_json TEXT NOT NULL,
  as_of TEXT NOT NULL,
  PRIMARY KEY (exit, scope_key)
);

CREATE TABLE IF NOT EXISTS market_new_build_premiums (
  metric TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  ratio REAL NOT NULL,
  raw_ratio REAL NOT NULL,
  building_count INTEGER NOT NULL,
  pair_count INTEGER NOT NULL,
  zip_count INTEGER NOT NULL,
  window_years INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  PRIMARY KEY (metric, scope_key)
);

CREATE TABLE IF NOT EXISTS market_sync_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  locations_json TEXT NOT NULL,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  pluto_matched_count INTEGER NOT NULL DEFAULT 0,
  rollups_updated INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS market_admin_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS rent_stabilized_units (
  bbl TEXT PRIMARY KEY,
  units INTEGER NOT NULL,
  year INTEGER NOT NULL,
  statement_url TEXT,
  synced_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_user_deal_settings (
  account TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
-- Named listing searches an account keeps: every filter, the frozen costs and the map area.
CREATE TABLE IF NOT EXISTS market_saved_searches (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  name TEXT NOT NULL,
  search_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_saved_searches_name ON market_saved_searches(account, name COLLATE NOCASE);
-- Trade-press stories from public RSS feeds (news-feeds.mjs): the feed's own headline, link,
-- date and summary only. A story links to each tax lot an address in it resolved to.
CREATE TABLE IF NOT EXISTS news_stories (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  publisher TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  summary TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news_story_lots (
  story_id TEXT NOT NULL,
  bbl TEXT NOT NULL,
  block TEXT NOT NULL,
  address TEXT,
  mention TEXT,
  PRIMARY KEY (story_id, bbl)
);
CREATE INDEX IF NOT EXISTS idx_news_story_lots_bbl ON news_story_lots(bbl);
CREATE INDEX IF NOT EXISTS idx_news_story_lots_block ON news_story_lots(block);
`;

const SAVED_SEARCH_LIMIT = 100;
const savedSearchRow = row => ({id: row.id, name: row.name, search: JSON.parse(row.search_json), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()});

export async function defaultHomeHarvestBridgeRunner(payload) {
  const scriptPath = fileURLToPath(new URL('./homeharvest-bridge.py', import.meta.url));
  const venvPy = '/opt/acres-research/.venv/bin/python';
  const pythonBin = process.env.ACRES_PYTHON_BIN || (existsSync(venvPy) ? venvPy : 'python3');
  const timeoutMs = payload.timeoutMs ?? 90000;
  const child = execFileAsync(pythonBin, [scriptPath], {timeout: timeoutMs, signal:requestSignal(timeoutMs), killSignal:'SIGKILL', maxBuffer: 128 * 1024 * 1024});
  child.child.stdin.write(JSON.stringify(payload));
  child.child.stdin.end();
  const {stdout} = await child;
  return JSON.parse(stdout);
}

// Address lookup for a listing the coordinate match misses: NYC Planning GeoSearch maps the address to
// a tax lot. The caller checks the house number and the distance from the listing pin before using it.
export const GEOSEARCH_URL = 'https://geosearch.planninglabs.nyc/v2/search';
export async function defaultGeosearchBbl(item) {
  const text = [item.street_line || item.address, item.city, 'NY', item.zip_code].filter(Boolean).join(', ');
  const url = new URL(GEOSEARCH_URL);
  url.searchParams.set('text', text);
  url.searchParams.set('size', '1');
  const res = await fetch(url, {signal: requestSignal(15000)});
  if (!res.ok) throw new Error(`GeoSearch HTTP ${res.status}`);
  const hit = (await res.json())?.features?.[0];
  const bbl = hit?.properties?.addendum?.pad?.bbl;
  if (!bbl) return null;
  return {bbl: String(bbl), label: hit.properties.label || '', longitude: hit.geometry?.coordinates?.[0], latitude: hit.geometry?.coordinates?.[1]};
}
// A GeoSearch hit farther than this from the listing's own pin is a different place (about 500 m).
const GEOSEARCH_MAX_OFFSET_DEG = 0.0045;

export async function defaultPlutoBatchFetcher(whereClause, limit = 500, {offset = 0} = {}) {
  const url = new URL(PLUTO_DATASET_URL);
  url.searchParams.set('$select', [
    'bbl', 'borough', 'address', 'zipcode', 'lotarea', 'bldgarea',
    'zonedist1', 'overlay1', 'spdist1', 'residfar', 'affresfar', 'commfar', 'facilfar', 'mnffar',
    'builtfar', 'lotfront', 'lotdepth', 'lottype', 'unitsres', 'unitstotal',
    'bldgclass', 'yearbuilt', 'ownername', 'landmark', 'histdist', 'pfirm15_flag', 'firm07_flag', 'latitude', 'longitude',
  ].join(','));
  url.searchParams.set('$where', whereClause);
  url.searchParams.set('$limit', String(limit));
  url.searchParams.set('$offset', String(offset));
  url.searchParams.set('$order', 'bbl ASC');
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {headers: socrataHeaders(url), signal: requestSignal(20000)});
      if (!res.ok) throw new Error(`PLUTO Socrata HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      throwIfCancelled();
      lastErr = err;
      if (attempt < 2) await delay(300 * (attempt + 1), undefined, {signal: executionSignal()});
    }
  }
  throw lastErr;
}

// HPD Multiple Dwelling Registrations for a batch of lots, keyed back to the 10-digit BBL. The dataset
// stores bare block and lot numbers and one row per registered building, so a lot can return several rows.
export async function defaultHpdRegistrationBatchFetcher(bbls) {
  const lots = bbls.map(bbl => String(bbl)).filter(bbl => /^[1-5]\d{9}$/.test(bbl));
  if (!lots.length) return [];
  const url = new URL(HPD_REGISTRATIONS_URL);
  url.searchParams.set('$select', 'boroid,block,lot,bin,registrationid,lastregistrationdate,registrationenddate');
  url.searchParams.set('$where', lots.map(bbl => `(boroid='${bbl[0]}' AND block='${Number(bbl.slice(1, 6))}' AND lot='${Number(bbl.slice(6))}')`).join(' OR '));
  url.searchParams.set('$limit', String(lots.length * 20));
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {headers: socrataHeaders(url), signal: requestSignal(20000)});
      if (!res.ok) throw new Error(`HPD registrations Socrata HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      throwIfCancelled();
      lastErr = err;
      if (attempt < 2) await delay(300 * (attempt + 1), undefined, {signal: executionSignal()});
    }
  }
  throw lastErr;
}
export const hpdRegistrationBbl = row => `${row.boroid}${String(Number(row.block)).padStart(5, '0')}${String(Number(row.lot)).padStart(4, '0')}`;
const HPD_REGISTRATION_RECHECK_MS = 30 * 24 * 3600 * 1000;
const HPD_REGISTRATION_RENEWAL_GRACE_DAYS = 120;

const REMOVED_LISTING_COLUMNS = ['agent_name', 'broker_office', 'agent_phone', 'avm_estimate', 'avm_low', 'avm_high', 'avm_source'];

// How much a reported sale's date counts as comp evidence: full weight (4 points over an ask) within
// 12 months, falling evenly to none at 36, and none when the sale is undated.
const COMP_RECENCY = {fullMonths: 12, zeroMonths: 36, points: 4};
function saleRecency(soldDate, now) {
  const day = String(soldDate || '').slice(0, 10);
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day) : NaN;
  if (!Number.isFinite(at)) return {months: null, points: 0, reason: 'Reported sale, date unknown: no weight for recency'};
  // A future sale date is a bad record, not a current sale: no recency weight, and the reason says so.
  if (at > now) return {months: null, points: 0, reason: `Reported sale dated ${day}, in the future: no weight for recency`};
  const months = Math.max(0, Math.floor((now - at) / (30.44 * 86400000)));
  const {fullMonths, zeroMonths, points} = COMP_RECENCY;
  const weight = months <= fullMonths ? 1 : Math.max(0, (zeroMonths - months) / (zeroMonths - fullMonths));
  const reason = months <= fullMonths ? `Sold ${day}, within a year`
    : weight > 0 ? `Sold ${day}, ${months} months ago: weighted down for age` : `Sold ${day}, over three years ago: no weight for recency`;
  return {months, points: Math.round(points * weight), reason};
}

// One bounded top-k accumulator per subject; a page shares one streamed peer scan, and a single
// listing's comps use the same scorer.
function comparableRanker(subject,limit,now=Date.now()) {
    const subjId = subject.id || '';
    const recordedBbl = String(subject.bbl ?? '').trim();
    const subjBbl = /^\d{10}$/.test(recordedBbl) && Number(recordedBbl) > 0 ? recordedBbl : null;
    const subjPropertyId = String(subject.property_id ?? subject.propertyId ?? '').trim() || null;
    const subjZip = subject.zip_code ?? subject.zipCode ?? null;
    const subjBorough = subject.borough ?? null;
    const subjLat = Number(subject.latitude ?? 0);
    const subjLon = Number(subject.longitude ?? 0);
    const subjZoning = String(subject.zoning_district ?? subject.zoningDistrict ?? '').trim().toUpperCase();
    const subjZoningPrefix = subjZoning.replace(/[^A-Z0-9]/g, '').slice(0, 2);
    const subjResidFar = positiveMetric(subject.resid_far, subject.residFar);
    const subjCommOverlay = Boolean(
      (Number(subject.comm_far ?? subject.commFar ?? 0) > 0) ||
      /^C[1-8]/.test(String(subject.overlay1 ?? subject.overlay ?? '').trim().toUpperCase())
    );
    const subjZfa = comparableCapacity(subject).zfa;

    const resultLimit = Math.trunc(Math.max(1, Math.min(Number(limit) || 5, 15)));
    const compare = (a, b) => (b.similarityScore - a.similarityScore) || (a.kind - b.kind)
      || (b.seen - a.seen) || (a.order - b.order);
    const scored = [];
    return {
      consider(c) {
        // A city closing names its lot only in its id: the subject lot's own recorded sale is not a peer.
        if(c.id===subjId || (subjBbl && (String(c.bbl??'').trim()===subjBbl || c.property_id===`city-sale:${subjBbl}`)) || (subjPropertyId && String(c.property_id??'').trim()===subjPropertyId))return;
        if((subjZip||subjBorough) && !(subjZip!==null&&c.zip_code!==null&&String(c.zip_code)===String(subjZip)) && !(subjBorough!==null&&c.borough!==null&&String(c.borough)===String(subjBorough)))return;

      const price = Number(c.comparable_price);
      if (!Number.isFinite(price) || price <= 0) return;
      const isReportedSale = c.listing_type === 'sold';

      let score = 0;
      const reasons = [];

      // 1. Geographic proximity (0–35 pts)
      const cLat = Number(c.latitude || 0);
      const cLon = Number(c.longitude || 0);
      let distanceMiles = null;
      if (subjLat && subjLon && cLat && cLon) {
        const dLat = (cLat - subjLat) * 69.0;
        const dLon = (cLon - subjLon) * 52.3;
        distanceMiles = Number(Math.hypot(dLat, dLon).toFixed(2));
        if (distanceMiles <= 0.15) {
          score += 35;
          reasons.push(`${distanceMiles} mi away`);
        } else if (distanceMiles <= 0.40) {
          score += 31;
          reasons.push(`${distanceMiles} mi away`);
        } else if (distanceMiles <= 0.85) {
          score += 25;
          reasons.push(`${distanceMiles} mi away`);
        } else if (distanceMiles <= 1.75) {
          score += 19;
          reasons.push(`${distanceMiles} mi away`);
        } else {
          score += 12;
        }
      } else if (subjZip && c.zip_code === subjZip) {
        score += 28;
        reasons.push(`Same ZIP (${subjZip})`);
      } else if (subjBorough && c.borough === subjBorough) {
        score += 16;
        reasons.push(`Same borough (${subjBorough})`);
      }

      // 2. Zoning & FAR match (0–25 pts)
      const cZoning = String(c.zoning_district || '').trim().toUpperCase();
      const cZoningPrefix = cZoning.replace(/[^A-Z0-9]/g, '').slice(0, 2);
      const cResidFar = positiveMetric(c.resid_far);
      if (subjZoning && cZoning && subjZoning === cZoning) {
        score += 25;
        reasons.push(`Same ${subjZoning} zoning`);
      } else if (subjZoningPrefix && cZoningPrefix && subjZoningPrefix === cZoningPrefix) {
        score += 19;
        reasons.push(`Matching ${subjZoningPrefix} zoning tier`);
      } else if (cResidFar !== null && subjResidFar !== null && Math.abs(cResidFar - subjResidFar) <= 0.75) {
        score += 14;
        reasons.push('Similar residential FAR');
      } else if (cResidFar !== null && subjResidFar !== null) {
        score += 8;
      }

      // 3. Corridor / Commercial overlay match (0–15 pts)
      const cCommOverlay = Boolean(
        Number(c.comm_far || 0) > 0 ||
        /^C[1-8]/.test(String(c.overlay1 || '').trim().toUpperCase()) ||
        /\b(AVE|AVENUE|BLVD|BROADWAY)\b/i.test(String(c.address || ''))
      );
      if (subjCommOverlay === cCommOverlay) {
        score += 15;
        reasons.push(subjCommOverlay ? 'Matching commercial/avenue corridor' : 'Matching residential side-street');
      } else {
        score += 7;
      }

      // 4. Buildable scale match (0–15 pts)
      const {zfa: cZfa, basis: buildableZfaBasis} = comparableCapacity(c);
      if (cZfa > 0 && subjZfa > 0) {
        const scaleRatio = Math.min(cZfa, subjZfa) / Math.max(cZfa, subjZfa);
        score += Math.max(4, Math.round(scaleRatio * 15));
        if (scaleRatio >= 0.65) reasons.push('Comparable buildable scale');
      }

      // 5. Transaction type and recency (0–10 pts): a current ask and a sale both price the site; a sale
      // within a year earns full weight, decaying to an ask's by three years, and an undated sale none.
      const recency = isReportedSale ? saleRecency(c.sold_date, now) : null;
      if (isReportedSale) {
        score += 6 + recency.points;
        if (recency.months !== null && recency.months <= 12) reasons.push(recency.reason);
        else reasons.unshift(recency.reason);
      } else {
        score += 6;
        reasons.push('Asking price comp');
      }

      const similarityScore = Math.max(1, Math.min(99, score));
      const ranked = {similarityScore, kind: isReportedSale ? 0 : 1, seen: c.last_seen_at, order: c.candidate_order};
      // One lot, one comp: two listings of the same lot (two MLS rows, or a broker copy the sweep has
      // not retired yet) are one piece of evidence, so only the better record stands for the lot.
      const lotBbl = String(c.bbl ?? '').trim();
      ranked.lotKey = /^\d{10}$/.test(lotBbl) && Number(lotBbl) > 0 ? `bbl:${lotBbl}` : (String(c.property_id ?? '').trim() ? `property:${String(c.property_id).trim()}` : null);
      const dupIndex = ranked.lotKey ? scored.findIndex(s => s.lotKey === ranked.lotKey) : -1;
      if (dupIndex >= 0) {
        if (compare(ranked, scored[dupIndex]) >= 0) return;
        scored.splice(dupIndex, 1);
      } else if (scored.length === resultLimit && compare(ranked, scored.at(-1)) >= 0) return;
      const existingSqft = positiveMetric(c.pluto_bldg_area, c.sqft);
      const pricePer = denominator => {
        const value = denominator > 0 ? price / denominator : NaN;
        return Number.isFinite(value) ? Math.round(value) : null;
      };
      const pricePerSqft = pricePer(existingSqft);
      const pricePerBuildableZfa = pricePer(cZfa);
      const buildableUnits = cZfa > 0 ? Math.max(1, Math.floor(cZfa / 680)) : null;
      const pricePerBuildableUnit = pricePer(buildableUnits);

      ranked.entry = {
        id: c.id,
        listingId: c.id,
        address: c.address,
        zipCode: c.zip_code,
        listingType: c.listing_type,
        zoningDistrict: cZoning || null,
        overlay: c.overlay1 || null,
        price,
        priceBasis: isReportedSale ? 'reported_sale' : 'asking_price',
        existingSqft,
        buildableZfa: cZfa,
        buildableZfaBasis,
        buildableUnits,
        pricePerSqft,
        reportedPricePerSqft: Number.isFinite(c.price_per_sqft) && c.price_per_sqft >= 0 ? c.price_per_sqft : null,
        pricePerExistingSqft: pricePerSqft,
        pricePerBuildableZfa,
        pricePerBuildableUnit,
        distanceMiles,
        similarityScore,
        similarityReasons: reasons.slice(0, 3),
        soldDate: isReportedSale ? (c.sold_date || null) : null,
        listingDate: c.list_date || null,
        url: c.url || null,
      };
      scored.push(ranked);
      scored.sort(compare);
      if (scored.length > resultLimit) scored.pop();
      },
      results:()=>scored.map(row=>row.entry),
      // Whether every kept comp scores above a ceiling no unread candidate can beat.
      settledAbove:ceiling=>scored.length===resultLimit&&scored.at(-1).similarityScore>ceiling,
    };
}

// A project's total cost: the asking price plus the construction cost of the building priced (hard
// and soft cost with carry, at the active cost assumptions); a lot with no building priced costs its
// ask. A listing with no ask is figured at the most it could ask and still rate a good deal (the
// good-deal land threshold on its own card), so Unpriced rows carry a project cost on that stated
// basis instead of falling out of the filter; with no such threshold there is no project cost.
export function projectCost(row, valuation) {
  const construction = Number(valuation?.constructionCost) || 0;
  const ask = Number(row.list_price);
  if (ask > 0) return Math.round(ask + construction);
  const land = Number(valuation?.goodDealMaxLandValue);
  return land > 0 ? Math.round(land + construction) : null;
}

export class MarketStore {
  constructor(pathOrOptions = marketDbPath(), {readOnly = false} = {}) {
    const isObj = pathOrOptions && typeof pathOrOptions === 'object';
    const path = isObj ? (pathOrOptions.path || pathOrOptions.filename || marketDbPath()) : pathOrOptions;
    const ro = isObj ? Boolean(pathOrOptions.readOnly) : Boolean(readOnly);
    if (!ro) {
      mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    }
    this.path = path;
    this.db = new DatabaseSync(path, {readOnly: ro});
    if (!ro) {
      try { chmodSync(path, 0o600); } catch { /* ignore on temp dirs */ }
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; ${MARKET_DDL}`);
      const remeasurePremiums = this.addListingColumns();
      this.dropThirdPartyPersonalData();
      this.addListingSource();
      if (remeasurePremiums) this.recomputeNewBuildPremiums();
    }
  }

  // Columns added after the table first shipped.
  addListingColumns() {
    // The premiums are rebuilt from the listings, so an older table (citywide only, or counted by unit) is
    // dropped, not altered, and measured again once the listing columns are in place.
    const remeasurePremiums = this.one("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'market_new_build_premiums'") && !this.query('PRAGMA table_info(market_new_build_premiums)').some(c => c.name === 'building_count');
    if (remeasurePremiums) {
      this.db.exec('DROP TABLE market_new_build_premiums; CREATE TABLE market_new_build_premiums (metric TEXT NOT NULL, scope_key TEXT NOT NULL, ratio REAL NOT NULL, raw_ratio REAL NOT NULL, building_count INTEGER NOT NULL, pair_count INTEGER NOT NULL, zip_count INTEGER NOT NULL, window_years INTEGER NOT NULL, as_of TEXT NOT NULL, PRIMARY KEY (metric, scope_key));');
    }
    const columns = new Set(this.query('PRAGMA table_info(market_listings)').map(c => c.name));
    if (!columns.has('flood_zone')) this.db.exec('ALTER TABLE market_listings ADD COLUMN flood_zone INTEGER');
    if (!columns.has('price_per_buildable_sf')) this.db.exec('ALTER TABLE market_listings ADD COLUMN price_per_buildable_sf REAL');
    if (!columns.has('in_mih_area')) this.db.exec('ALTER TABLE market_listings ADD COLUMN in_mih_area INTEGER; ALTER TABLE market_listings ADD COLUMN mih_area_json TEXT; ALTER TABLE market_listings ADD COLUMN mih_checked_at INTEGER;');
    if (!columns.has('hpd_registration_end')) this.db.exec('ALTER TABLE market_listings ADD COLUMN hpd_last_registration TEXT; ALTER TABLE market_listings ADD COLUMN hpd_registration_end TEXT; ALTER TABLE market_listings ADD COLUMN hpd_registration_checked_at INTEGER;');
    if (!columns.has('front_street_feet')) this.db.exec('ALTER TABLE market_listings ADD COLUMN front_street_feet REAL; ALTER TABLE market_listings ADD COLUMN front_street_checked_at INTEGER;');
    if (!columns.has('side_street_feet')) this.db.exec('ALTER TABLE market_listings ADD COLUMN side_street_feet REAL;');
    if (!columns.has('lot_polygon_json')) this.db.exec('ALTER TABLE market_listings ADD COLUMN lot_polygon_json TEXT; ALTER TABLE market_listings ADD COLUMN lot_polygon_checked_at INTEGER;');
    return remeasurePremiums;
  }

  // HomeHarvest rows keep a null source; broker-published listings name their feed.
  addListingSource() {
    const columns = new Set(this.query('PRAGMA table_info(market_listings)').map(c => c.name));
    if (!columns.has('source')) this.db.exec('ALTER TABLE market_listings ADD COLUMN source TEXT; ALTER TABLE market_listings ADD COLUMN source_name TEXT;');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_market_listings_source ON market_listings(source, listing_type)');
  }

  // Earlier builds stored listing agents' names, brokerages and phones and vendor AVM figures.
  // Keep only whether an AVM existed, drop the columns and rewrite the file so the values are gone.
  dropThirdPartyPersonalData() {
    const columns = new Set(this.query('PRAGMA table_info(market_listings)').map(c => c.name));
    if (!columns.has('avm_available')) this.db.exec('ALTER TABLE market_listings ADD COLUMN avm_available INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('price_far_below_estimate')) this.db.exec('ALTER TABLE market_listings ADD COLUMN price_far_below_estimate INTEGER');
    if (!columns.has('rent_stabilized_units')) this.db.exec('ALTER TABLE market_listings ADD COLUMN rent_stabilized_units INTEGER; ALTER TABLE market_listings ADD COLUMN rent_stabilized_year INTEGER; ALTER TABLE market_listings ADD COLUMN rent_stabilized_checked_at INTEGER');
    if (!columns.has('mnf_far')) this.db.exec('ALTER TABLE market_listings ADD COLUMN mnf_far REAL; ALTER TABLE market_listings ADD COLUMN max_any_use_zfa REAL; ALTER TABLE market_listings ADD COLUMN any_use_price_per_buildable_zfa REAL');
    const removed = REMOVED_LISTING_COLUMNS.filter(c => columns.has(c));
    if (!removed.length) return;
    if (columns.has('avm_estimate')) this.db.exec('UPDATE market_listings SET avm_available = 1 WHERE avm_estimate IS NOT NULL');
    for (const column of removed) this.db.exec(`ALTER TABLE market_listings DROP COLUMN ${column}`);
    this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }

  query(sql, ...args) { return this.db.prepare(sql).all(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  write(sql, ...args) { return this.db.prepare(sql).run(...args); }
  close() { this.db.close(); }

  saveNewsStory(story, lots, now = Date.now()) {
    this.write(`INSERT INTO news_stories (id, feed_id, publisher, title, url, published_at, summary, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, published_at = excluded.published_at, summary = excluded.summary`,
    story.id, story.feedId, story.publisher, story.title, story.url, story.publishedAt, story.summary, now);
    for (const lot of lots) this.write('INSERT OR IGNORE INTO news_story_lots (story_id, bbl, block, address, mention) VALUES (?, ?, ?, ?, ?)', story.id, lot.bbl, lot.bbl.slice(0, 6), lot.address, lot.mention);
  }

  // Up to `limit` stories about the lot or another lot on its block, newest first. `onLot` says
  // whether the story names this lot itself.
  newsForLot(bbl, {limit = 5} = {}) {
    const lot = String(bbl);
    // A read-only store opened before the first feed pass has no news tables yet.
    if (!this.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'news_story_lots'")) return [];
    return this.query(`SELECT s.id, s.publisher, s.title, s.url, s.published_at AS publishedAt, s.summary,
        MAX(l.bbl = ?) AS onLot, GROUP_CONCAT(DISTINCT l.address) AS addresses
      FROM news_story_lots l JOIN news_stories s ON s.id = l.story_id
      WHERE l.block = ? GROUP BY s.id ORDER BY s.published_at DESC LIMIT ?`, lot, lot.slice(0, 6), limit)
      .map(row => ({...row, onLot: Boolean(row.onLot), addresses: row.addresses ? row.addresses.split(',') : []}));
  }

  newsStoryCounts() {
    return this.one(`SELECT COUNT(*) AS stories,
        (SELECT COUNT(DISTINCT story_id) FROM news_story_lots) AS matchedStories,
        (SELECT COUNT(DISTINCT bbl) FROM news_story_lots) AS lots
      FROM news_stories`);
  }

  getAdminConfig() {
    let syncRow = null;
    let dealRow = null;
    try {
      syncRow = this.one('SELECT value_json, updated_at, updated_by FROM market_admin_config WHERE key = ?', 'sync_config');
      dealRow = this.one('SELECT value_json, updated_at, updated_by FROM market_admin_config WHERE key = ?', 'deal_settings');
    } catch { /* read-only DB without table */ }
    const savedSync = syncRow?.value_json ? JSON.parse(syncRow.value_json) : {};
    const savedDeal = dealRow?.value_json ? JSON.parse(dealRow.value_json) : {};
    const updatedAt = Math.max(Number(syncRow?.updated_at || 0), Number(dealRow?.updated_at || 0)) || null;
    const updatedBy = dealRow?.updated_by || syncRow?.updated_by || null;
    return {
      syncConfig: normalizeSyncConfig(savedSync, DEFAULT_MARKET_SYNC_CONFIG),
      dealSettings: normalizeDealSettings(savedDeal, DEFAULT_NYC_DEV_SETTINGS),
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      updatedBy,
    };
  }

  getUserDealSettings(account) {
    const baselineSettings = this.getAdminConfig().dealSettings;
    if (!account) {
      return {
        dealSettings: baselineSettings,
        baselineSettings,
        isCustom: false,
        hasCustomSettings: false,
        costsConfirmed: false,
        budgetSplits: null,
        updatedAt: null,
        updatedBy: null,
      };
    }
    let row = null;
    try {
      row = this.one('SELECT settings_json, updated_at, updated_by FROM market_user_deal_settings WHERE account = ?', String(account));
    } catch { /* read-only DB without table */ }
    // The account's budget line shares ride in the same row and are no cost setting of the valuation.
    const {budgetSplits = null, ...rawSaved} = row?.settings_json ? JSON.parse(row.settings_json) : {};
    const hasCustomSettings = Object.keys(rawSaved).length > 0;
    return {
      dealSettings: hasCustomSettings ? normalizeDealSettings(rawSaved, baselineSettings) : baselineSettings,
      budgetSplits,
      baselineSettings,
      isCustom: hasCustomSettings,
      hasCustomSettings,
      // The account has entered its own costs at least once; a later reset to house costs keeps this.
      costsConfirmed: Boolean(row),
      updatedAt: row?.updated_at ? new Date(Number(row.updated_at)).toISOString() : null,
      updatedBy: row?.updated_by || null,
    };
  }

  // budgetSplits replaces the account's budget line shares (null restores the defaults); left out, the
  // saved shares are kept. Shares are validated by the caller (normalizeBudgetSplits).
  updateUserDealSettings(account, settings = {}, {reset = false, updatedBy = null, budgetSplits} = {}, now = Date.now()) {
    if (!account) throw new Error('Account is required to save developer settings.');
    const acct = String(account);
    const splits = budgetSplits === undefined ? this.getUserDealSettings(acct).budgetSplits : budgetSplits;
    const withSplits = costs => JSON.stringify(splits ? {...costs, budgetSplits: splits} : costs);
    if (reset) {
      // A row without costs means house costs, and still records that the account set its costs once.
      this.write(`
        INSERT INTO market_user_deal_settings (account, settings_json, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at,
          updated_by = COALESCE(excluded.updated_by, market_user_deal_settings.updated_by)
      `, acct, withSplits({}), now, updatedBy);
      return this.getUserDealSettings(acct);
    }
    const baseline = this.getAdminConfig().dealSettings;
    const normalized = normalizeDealSettings(settings, baseline);
    this.write(`
      INSERT INTO market_user_deal_settings (account, settings_json, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at,
        updated_by = COALESCE(excluded.updated_by, market_user_deal_settings.updated_by)
    `, acct, withSplits(normalized), now, updatedBy);
    return this.getUserDealSettings(acct);
  }

  // Saves only the budget line shares (null restores the defaults), leaving the account's costs as they are.
  updateUserBudgetSplits(account, budgetSplits, {updatedBy = null} = {}, now = Date.now()) {
    if (!account) throw new Error('Account is required to save developer settings.');
    const acct = String(account);
    const row = this.one('SELECT settings_json FROM market_user_deal_settings WHERE account = ?', acct);
    const {budgetSplits: _previous, ...costs} = row?.settings_json ? JSON.parse(row.settings_json) : {};
    this.write(`
      INSERT INTO market_user_deal_settings (account, settings_json, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at,
        updated_by = COALESCE(excluded.updated_by, market_user_deal_settings.updated_by)
    `, acct, JSON.stringify(budgetSplits ? {...costs, budgetSplits} : costs), now, updatedBy);
    return this.getUserDealSettings(acct);
  }

  // An account's saved listing searches, oldest first. Each keeps the whole search, validated by the
  // same filter contract the page uses, under a name unique to the account.
  listSavedSearches(account) {
    return this.query('SELECT * FROM market_saved_searches WHERE account = ? ORDER BY created_at, rowid', String(account)).map(savedSearchRow);
  }

  createSavedSearch(account, {name, search}, now = Date.now()) {
    const acct = String(account), label = this.savedSearchName(acct, name);
    const state = validateSearchState(search);
    if (this.one('SELECT COUNT(*) AS n FROM market_saved_searches WHERE account = ?', acct).n >= SAVED_SEARCH_LIMIT) throw new Error(`You can keep up to ${SAVED_SEARCH_LIMIT} saved searches. Delete one to save another.`);
    const id = randomUUID();
    this.write('INSERT INTO market_saved_searches (id, account, name, search_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, acct, label, JSON.stringify(state), now, now);
    return this.savedSearch(acct, id);
  }

  renameSavedSearch(account, id, name, now = Date.now()) {
    const acct = String(account);
    this.savedSearch(acct, id);
    this.write('UPDATE market_saved_searches SET name = ?, updated_at = ? WHERE account = ? AND id = ?', this.savedSearchName(acct, name, id), now, acct, String(id));
    return this.savedSearch(acct, id);
  }

  deleteSavedSearch(account, id) {
    this.savedSearch(String(account), id);
    this.write('DELETE FROM market_saved_searches WHERE account = ? AND id = ?', String(account), String(id));
  }

  savedSearch(account, id) {
    const row = this.one('SELECT * FROM market_saved_searches WHERE account = ? AND id = ?', account, String(id));
    if (!row) throw Object.assign(new Error('Saved search not found.'), {status: 404});
    return savedSearchRow(row);
  }

  savedSearchName(account, name, id = '') {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Name must be 1 to 80 characters.');
    const label = name.trim();
    if (this.one('SELECT 1 AS taken FROM market_saved_searches WHERE account = ? AND name = ? COLLATE NOCASE AND id != ?', account, label, String(id))) throw Object.assign(new Error(`You already have a saved search named ${label}.`), {status: 409});
    return label;
  }

  updateAdminConfig({syncConfig = null, dealSettings = null, revalueDeals = true, updatedBy = null} = {}, now = Date.now()) {
    const current = this.getAdminConfig();
    const nextSync = syncConfig ? normalizeSyncConfig(syncConfig, current.syncConfig) : current.syncConfig;
    const nextDeal = dealSettings ? normalizeDealSettings(dealSettings, current.dealSettings) : current.dealSettings;

    if (syncConfig) {
      this.write(`
        INSERT INTO market_admin_config (key, value_json, updated_at, updated_by)
        VALUES ('sync_config', ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at,
          updated_by = COALESCE(excluded.updated_by, market_admin_config.updated_by)
      `, JSON.stringify(nextSync), now, updatedBy);
    }

    let revaluedCount = 0;
    if (dealSettings) {
      this.write(`
        INSERT INTO market_admin_config (key, value_json, updated_at, updated_by)
        VALUES ('deal_settings', ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at,
          updated_by = COALESCE(excluded.updated_by, market_admin_config.updated_by)
      `, JSON.stringify(nextDeal), now, updatedBy);
      if (revalueDeals) {
        const res = this.revalueDealsWithSettings(nextDeal);
        revaluedCount = res.revalued;
      }
    }

    return {
      ...this.getAdminConfig(),
      revaluedCount,
    };
  }

  static soldDateKeyPart(row) {
    const raw = String(row.soldDate || row.sold_date || '').trim();
    if (!raw) return '';
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : raw.toLowerCase().replace(/\s+/g, '_');
  }

  static listingKey(row) {
    const ltype = String(row.listingType || row.listing_type || 'for_sale').trim().toLowerCase();
    // A property can close more than once; each closing is its own comp, so a sold row's
    // identity carries its sold date. Asking rows keep one identity per property.
    const soldPart = ltype === 'sold' ? MarketStore.soldDateKeyPart(row) : '';
    const suffix = soldPart ? `:${soldPart}` : '';
    const pid = String(row.propertyId || row.property_id || '').trim();
    if (pid) return `${pid}:${ltype}${suffix}`;
    const addr = String(row.address || row.streetLine || '').trim().toLowerCase().replace(/\s+/g, '_');
    const zip = String(row.zipCode || row.zip_code || '').trim();
    return `addr:${addr}:${zip}:${ltype}${suffix}`;
  }

  ingestListings(rows = [], now = Date.now()) {
    let inserted = 0;
    let updated = 0;
    let rollupsUpdated = 0;
    const touchedZips = new Set();
    const dealSettings = this.getAdminConfig().dealSettings, zipRollups = new Map(), unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();

    // Immediate: a deferred transaction that read first fails on its first write once another
    // connection (the listing sync, news feeds, an import) commits, instead of waiting on busy_timeout.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const id = MarketStore.listingKey(r);
        const ltype = String(r.listingType || 'for_sale').trim().toLowerCase();
        const existingCols = `id, zip_code, list_price, sold_price, sold_date, mls_status, price_history_json, first_seen_at, last_update_date,
          pluto_lot_area, pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, max_standard_zfa, max_uap_zfa,
          bldg_class, units_res, units_total, year_built, special_district, resid_far, aff_res_far, comm_far, overlay1,
          zoning_district, pluto_address, address, borough, neighborhood, flood_zone, landmark_flag, in_mih_area, mih_area_json`;
        let existing = this.one(`SELECT ${existingCols} FROM market_listings WHERE id = ?`, id);
        // Sold rows stored before the sold date joined the identity keep their history: a legacy
        // row for the same closing (same or missing sold date) is renamed, not duplicated.
        if (!existing && ltype === 'sold' && MarketStore.soldDateKeyPart(r)) {
          const legacyId = MarketStore.listingKey({...r, soldDate: null, sold_date: null});
          if (legacyId !== id) {
            const legacy = this.one(`SELECT ${existingCols} FROM market_listings WHERE id = ?`, legacyId);
            if (legacy && (!legacy.sold_date || MarketStore.soldDateKeyPart(legacy) === MarketStore.soldDateKeyPart(r))) {
              this.write('UPDATE market_listings SET id = ? WHERE id = ?', id, legacyId);
              existing = {...legacy, id};
            }
          }
        }
        const storedDate = Date.parse(existing?.last_update_date);
        const observedDate = Date.parse(r.lastUpdateDate);
        // Source freshness, rather than response arrival order, owns the current listing.
        if (Number.isFinite(storedDate) && Number.isFinite(observedDate) && observedDate < storedDate) continue;
        const borough = inferNycBoroughCode(r);
        const listPrice = r.listPrice != null ? Number(r.listPrice) : null;
        const soldPrice = r.soldPrice != null ? Number(r.soldPrice) : null;
        const pid = String(r.propertyId || '').trim() || null;
        const soldDay = ltype === 'sold' ? MarketStore.soldDateKeyPart(r) : '';
        // A property that sold on or after this observation is not for sale at it: the observation is
        // stored off the market. Otherwise a fresh observation puts a swept or retired row back on.
        const observedDay = MarketStore.soldDateKeyPart({soldDate: r.lastUpdateDate}) || new Date(now).toISOString().slice(0, 10);
        const soldSince = ltype === 'for_sale' && pid && this.one("SELECT 1 FROM market_listings WHERE property_id = ? AND listing_type = 'sold' AND substr(sold_date, 1, 10) >= ? LIMIT 1", pid, observedDay);
        const listingType = soldSince ? 'off_market' : ltype;
        const mlsStatus = soldSince ? 'off_market' : r.mlsStatus || ltype;

        let history = [];
        if (existing?.price_history_json) {
          try { history = JSON.parse(existing.price_history_json) || []; } catch { history = []; }
        }
        const lastEntry = history.at(-1);
        if (!lastEntry || lastEntry.listPrice !== listPrice || lastEntry.soldPrice !== soldPrice || lastEntry.status !== mlsStatus) {
          history.push({
            observedAt: new Date(now).toISOString().slice(0, 10),
            status: mlsStatus,
            listPrice,
            soldPrice,
          });
          if (history.length > 20) history = history.slice(-20);
        }

        const isDev = r.isDevelopmentCandidate ? 1 : 0;
        const zipCode = r.zipCode ? String(r.zipCode).trim() : null;
        if (existing?.zip_code) touchedZips.add(existing.zip_code);
        if (zipCode) touchedZips.add(zipCode);

        if (!existing) {
          inserted++;
          this.write(`
            INSERT INTO market_listings (
              id, property_id, listing_id, listing_type, mls_status,
              address, street_line, street_number, street_name, street_suffix, unit,
              city, borough, state, zip_code, county, fips_code, neighborhood,
              latitude, longitude, url, photo_url, style, asset_class, is_dev_candidate,
              beds, baths, sqft, sqft_estimated, lot_sqft, frontage_ft, year_built, stories,
              list_price, sold_price, price_per_sqft, rent_per_sqft_month, annual_tax,
              avm_available, price_far_below_estimate,
              days_on_mls, list_date, pending_date, sold_date, last_update_date,
              price_history_json, source, source_name,
              first_seen_at, last_seen_at
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?
            )
          `,
            id, r.propertyId ?? null, r.listingId ?? null, listingType, mlsStatus,
            r.address ?? null, r.streetLine ?? null, r.streetNumber ?? null, r.streetName ?? null, r.streetSuffix ?? null, r.unit ?? null,
            r.city ?? null, borough, r.state ?? null, zipCode, r.county ?? null, r.fipsCode ?? null, r.neighborhood ?? null,
            r.latitude ?? null, r.longitude ?? null, r.url ?? null, r.photoUrl ?? null, r.style ?? null, r.assetClass ?? null, isDev,
            r.beds ?? null, r.baths ?? null, r.sqft ?? null, r.sqftEstimated ? 1 : 0, r.lotSqft ?? null, r.frontageFt ?? null, r.yearBuilt ?? null, r.stories ?? null,
            listPrice, soldPrice, r.pricePerSqft ?? null, r.rentPerSqftPerMonth ?? null, r.annualTax ?? null,
            r.avmAvailable ? 1 : 0, r.priceFarBelowEstimate == null ? null : (r.priceFarBelowEstimate ? 1 : 0),
            r.daysOnMls ?? null, r.listDate ?? null, r.pendingDate ?? null, r.soldDate ?? null, r.lastUpdateDate ?? null,
            JSON.stringify(history), r.source ?? null, r.sourceName ?? null,
            now, now
          );
        } else {
          if (existing.zip_code && !zipRollups.has(existing.zip_code)) zipRollups.set(existing.zip_code, this.getZipRollup(existing.zip_code));
          const priceMetrics = computeDealValuation(valuationInputs({...existing, list_price: listPrice}, zipRollups.get(existing.zip_code), dealSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(existing), this.buildingSalesFor(existing)));
          updated++;
          this.write(`
            UPDATE market_listings SET
              listing_type = ?,
              listing_id = COALESCE(?, listing_id),
              mls_status = COALESCE(?, mls_status),
              address = COALESCE(?, address),
              street_line = COALESCE(?, street_line),
              street_number = COALESCE(?, street_number),
              street_name = COALESCE(?, street_name),
              street_suffix = COALESCE(?, street_suffix),
              unit = COALESCE(?, unit),
              city = COALESCE(?, city),
              borough = COALESCE(?, borough),
              state = COALESCE(?, state),
              zip_code = COALESCE(?, zip_code),
              county = COALESCE(?, county),
              fips_code = COALESCE(?, fips_code),
              neighborhood = COALESCE(?, neighborhood),
              latitude = COALESCE(?, latitude),
              longitude = COALESCE(?, longitude),
              url = COALESCE(?, url),
              photo_url = COALESCE(?, photo_url),
              style = COALESCE(?, style),
              asset_class = COALESCE(?, asset_class),
              is_dev_candidate = ?,
              beds = COALESCE(?, beds),
              baths = COALESCE(?, baths),
              sqft = COALESCE(?, sqft),
              lot_sqft = COALESCE(?, lot_sqft),
              frontage_ft = COALESCE(?, frontage_ft),
              year_built = COALESCE(?, year_built),
              stories = COALESCE(?, stories),
              list_price = ?,
              existing_price_per_sqft = ?,
              price_per_buildable_zfa = ?,
              uap_price_per_buildable_zfa = ?,
              price_per_buildable_sf = ?,
              any_use_price_per_buildable_zfa = ?,
              far_compression_pct = ?,
              sold_price = COALESCE(?, sold_price),
              price_per_sqft = COALESCE(?, price_per_sqft),
              rent_per_sqft_month = COALESCE(?, rent_per_sqft_month),
              annual_tax = COALESCE(?, annual_tax),
              avm_available = ?,
              price_far_below_estimate = ?,
              days_on_mls = COALESCE(?, days_on_mls),
              list_date = COALESCE(?, list_date),
              pending_date = COALESCE(?, pending_date),
              sold_date = COALESCE(?, sold_date),
              last_update_date = COALESCE(?, last_update_date),
              price_history_json = ?,
              source = COALESCE(?, source),
              source_name = COALESCE(?, source_name),
              last_seen_at = ?
            WHERE id = ?
          `,
            listingType, r.listingId ?? null, mlsStatus,
            r.address ?? null, r.streetLine ?? null, r.streetNumber ?? null, r.streetName ?? null, r.streetSuffix ?? null, r.unit ?? null,
            r.city ?? null, borough, r.state ?? null, zipCode, r.county ?? null, r.fipsCode ?? null, r.neighborhood ?? null,
            r.latitude ?? null, r.longitude ?? null, r.url ?? null, r.photoUrl ?? null, r.style ?? null, r.assetClass ?? null, isDev,
            r.beds ?? null, r.baths ?? null, r.sqft ?? null, r.lotSqft ?? null, r.frontageFt ?? null, r.yearBuilt ?? null, r.stories ?? null,
            listPrice, priceMetrics.existingPricePerSqft, priceMetrics.pricePerBuildableZfa, priceMetrics.uapPricePerBuildableZfa, priceMetrics.pricePerBuildableSf, priceMetrics.anyUsePricePerBuildableZfa, priceMetrics.farCompressionPct,
            soldPrice, r.pricePerSqft ?? null, r.rentPerSqftPerMonth ?? null, r.annualTax ?? null,
            r.avmAvailable ? 1 : 0,
            r.priceFarBelowEstimate == null ? null : (r.priceFarBelowEstimate ? 1 : 0),
            r.daysOnMls ?? null, r.listDate ?? null, r.pendingDate ?? null, r.soldDate ?? null, r.lastUpdateDate ?? null,
            JSON.stringify(history), r.source ?? null, r.sourceName ?? null,
            now, id
          );
        }
        // A closing retires the property's for-sale listing when it was listed on or before the sale.
        if (soldDay && pid) {
          this.write(`UPDATE market_listings SET listing_type = 'off_market', mls_status = 'off_market'
            WHERE property_id = ? AND listing_type = 'for_sale' AND COALESCE(substr(list_date, 1, 10), date(first_seen_at / 1000, 'unixepoch')) <= ?`, pid, soldDay);
        }
      }
      for (const zip of touchedZips) {
        this.recomputeZipRollup(zip, now);
        rollupsUpdated++;
      }
      if (touchedZips.size) { this.recomputeUnitSizes(now); this.recomputeNewBuildPremiums(now); }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {inserted, updated, rollupsUpdated, touchedZips: [...touchedZips]};
  }

  recomputeZipRollup(zipCode, now = Date.now()) {
    const cleanZip = String(zipCode || '').trim();
    if (!cleanZip) return null;
    // Sourced asking rows (broker and LoopNet feeds) stay out of the rollups, but a sourced
    // closing is still a closing: city closed-sales rows carry a source and must count.
    const rows = this.query("SELECT * FROM market_listings WHERE zip_code = ? AND (source IS NULL OR listing_type = 'sold')", cleanZip);
    if (!rows.length) {
      this.write('DELETE FROM market_submarket_rollups WHERE scope_key = ?', `zip:${cleanZip}`);
      return null;
    }

    const byBedrooms = {};
    for (const b of [0, 1, 2, 3]) {
      const saleRows = rows.filter(r =>
        (r.listing_type === 'sold' || r.listing_type === 'for_sale') &&
        ((b < 3 && r.beds === b) || (b === 3 && r.beds != null && r.beds >= 3))
      );
      const soldOnly = saleRows.filter(r => r.listing_type === 'sold');
      const activeSale = saleRows.filter(r => r.listing_type === 'for_sale');
      const condoSale = saleRows.filter(r => r.asset_class === 'condo_coop_apartment');
      const condoSold = soldOnly.filter(r => r.asset_class === 'condo_coop_apartment');
      const thSale = saleRows.filter(r => r.asset_class === 'townhouse_single_family');
      const rentRows = rows.filter(r =>
        r.listing_type === 'for_rent' &&
        ((b < 3 && r.beds === b) || (b === 3 && r.beds != null && r.beds >= 3))
      );
      byBedrooms[String(b)] = {
        bedrooms: b,
        saleSampleCount: saleRows.length,
        closedSoldCount: soldOnly.length,
        activeForSaleCount: activeSale.length,
        medianSalePricePerSqft: median(saleRows.map(r => r.price_per_sqft), 0),
        medianClosedSoldPricePerSqft: median(soldOnly.filter(r => r.sold_price > 0 && r.sqft > 0).map(r => r.sold_price / r.sqft), 0),
        medianActiveAskPricePerSqft: median(activeSale.map(r => r.price_per_sqft), 0),
        medianSalePrice: median(saleRows.map(r => r.listing_type === 'sold' ? r.sold_price : r.list_price), 0),
        medianSaleSqft: median(saleRows.map(r => r.sqft), 0),
        medianSaleDaysOnMls: median(saleRows.map(r => r.days_on_mls), 0),
        medianClosedSoldDaysOnMls: median(soldOnly.map(r => r.days_on_mls), 0),
        condoCoopSaleSampleCount: condoSale.length,
        medianCondoCoopSalePricePerSqft: median(condoSale.map(r => r.price_per_sqft), 0),
        condoCoopClosedSoldCount: condoSold.length,
        condoCoopClosedSoldPriceSampleCount: condoSold.filter(r => r.sold_price > 0 && r.sqft > 0).length,
        medianCondoCoopClosedSoldPricePerSqft: median(condoSold.filter(r => r.sold_price > 0 && r.sqft > 0).map(r => r.sold_price / r.sqft), 0),
        medianCondoCoopSaleDaysOnMls: median(condoSale.map(r => r.days_on_mls), 0),
        townhouseSingleFamilySaleSampleCount: thSale.length,
        medianTownhouseSingleFamilySalePricePerSqft: median(thSale.map(r => r.price_per_sqft), 0),
        medianTownhouseSingleFamilySaleDaysOnMls: median(thSale.map(r => r.days_on_mls), 0),
        rentSampleCount: rentRows.length,
        medianRentPerSqftPerMonth: median(rentRows.map(r => r.rent_per_sqft_month), 2),
        medianMonthlyRent: median(rentRows.map(r => r.list_price), 0),
        medianRentSqft: median(rentRows.map(r => r.sqft), 0),
        medianRentDaysOnMls: median(rentRows.map(r => r.days_on_mls), 0),
      };
    }

    // The ZIP's condo sale $/sqft is the median of its priced condo and co-op closings in the window, and
    // only with enough of them. Asks never set it, nor do whole-building, commercial or land sales: a thin
    // ZIP has no recorded benchmark, and the valuation says so and uses its submarket tier instead.
    const since = new Date(now);
    since.setUTCMonth(since.getUTCMonth() - CONDO_SALE_WINDOW_MONTHS);
    const closedCondo = rows.filter(r => r.asset_class === 'condo_coop_apartment' && r.listing_type === 'sold' && r.sold_price > 0 && r.sqft > 0 && String(r.sold_date || '').slice(0, 10) >= since.toISOString().slice(0, 10));
    const closedSample = closedCondo.length >= MIN_CLOSED_CONDO_SALES;
    const soldDays = closedCondo.map(r => String(r.sold_date).slice(0, 10)).sort();
    const allRentPsf = rows.filter(r => r.listing_type === 'for_rent').map(r => r.rent_per_sqft_month);
    const devRows = rows.filter(r => r.is_dev_candidate && r.uap_price_per_buildable_zfa > 0);

    const devMetrics = {
      blendedCondoSalePsf: closedSample ? median(closedCondo.map(r => r.sold_price / r.sqft), 0) : null,
      condoSaleSample: closedSample ? {
        basis: 'closed',
        count: closedCondo.length,
        cityClosedCount: closedCondo.filter(r => r.source === CITY_CLOSED_SALES_SOURCE).length,
        earliestSoldDate: soldDays[0],
        latestSoldDate: soldDays.at(-1),
        windowMonths: CONDO_SALE_WINDOW_MONTHS,
      } : {basis: 'too_few_closings', count: closedCondo.length, required: MIN_CLOSED_CONDO_SALES, windowMonths: CONDO_SALE_WINDOW_MONTHS},
      blendedRentPsfMonth: median(allRentPsf, 2),
      devCandidateCount: devRows.length,
      medianPricePerBuildableZfa: median(devRows.map(r => r.uap_price_per_buildable_zfa), 0),
    };

    const sampleRow = rows[0];
    const scopeKey = `zip:${cleanZip}`;
    this.write(`
      INSERT INTO market_submarket_rollups (scope_key, scope_type, zip_code, city, state, sample_count, by_bedrooms_json, dev_metrics_json, updated_at)
      VALUES (?, 'zip', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        city = COALESCE(excluded.city, market_submarket_rollups.city),
        state = COALESCE(excluded.state, market_submarket_rollups.state),
        sample_count = excluded.sample_count,
        by_bedrooms_json = excluded.by_bedrooms_json,
        dev_metrics_json = excluded.dev_metrics_json,
        updated_at = excluded.updated_at
    `, scopeKey, cleanZip, sampleRow.city ?? null, sampleRow.state ?? null, rows.length, JSON.stringify(byBedrooms), JSON.stringify(devMetrics), now);

    return {scopeKey, zipCode: cleanZip, sampleCount: rows.length, byBedrooms, devMetrics};
  }

  getZipRollup(zipCode) {
    const row = this.one('SELECT * FROM market_submarket_rollups WHERE scope_key = ?', `zip:${String(zipCode || '').trim()}`);
    if (!row) return null;
    return {
      scopeKey: row.scope_key,
      zipCode: row.zip_code,
      city: row.city,
      state: row.state,
      sampleCount: row.sample_count,
      byBedrooms: JSON.parse(row.by_bedrooms_json || '{}'),
      devMetrics: JSON.parse(row.dev_metrics_json || '{}'),
      updatedAt: row.updated_at,
    };
  }

  // Measured unit sizes for every area, from Realtor.com rows with a stated size (sourced feeds and city
  // closed sales carry no unit sizes). The whole table is rebuilt from the listings each time.
  recomputeUnitSizes(now = Date.now()) {
    const rows = this.query(`
      SELECT id, property_id, listing_type, zip_code, borough, neighborhood, beds, sqft FROM market_listings
      WHERE source IS NULL AND sqft_estimated = 0 AND sqft > 0 AND borough IS NOT NULL
        AND asset_class = 'condo_coop_apartment' AND listing_type IN ('for_rent', 'for_sale', 'sold')
    `);
    const measured = measureUnitSizes(rows, new Date(now).toISOString().slice(0, 10));
    this.write('DELETE FROM market_unit_sizes');
    for (const m of measured) {
      this.write('INSERT INTO market_unit_sizes (exit, scope_key, label, sample_count, average_net_sqft, mix_json, as_of) VALUES (?, ?, ?, ?, ?, ?, ?)',
        m.exit, m.scope, m.label, m.sampleCount, m.averageNetSqft, JSON.stringify(m.mix), m.asOf);
    }
    return {areas: measured.length};
  }

  // The new-building premium over ZIP medians, rebuilt from the listings and closings like the unit sizes.
  recomputeNewBuildPremiums(now = Date.now()) {
    const rows = [
      ...this.query("SELECT zip_code, borough, year_built, address, street_line, rent_per_sqft_month AS psf, 'rent' AS metric FROM market_listings WHERE source IS NULL AND listing_type = 'for_rent' AND rent_per_sqft_month > 0"),
      ...this.query("SELECT zip_code, borough, year_built, address, street_line, sold_price * 1.0 / sqft AS psf, 'sale' AS metric FROM market_listings WHERE listing_type = 'sold' AND asset_class = 'condo_coop_apartment' AND sold_price > 0 AND sqft > 0"),
    ].map(r => ({...r, building: newBuildBuildingKey(r)}));
    const measured = measureNewBuildPremiums(rows, new Date(now).toISOString().slice(0, 10));
    this.write('DELETE FROM market_new_build_premiums');
    for (const m of measured) {
      this.write('INSERT INTO market_new_build_premiums (metric, scope_key, ratio, raw_ratio, building_count, pair_count, zip_count, window_years, as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        m.metric, m.scope, m.ratio, m.rawRatio, m.buildingCount, m.pairCount, m.zipCount, m.windowYears, m.asOf);
    }
    return {measured: measured.length};
  }

  // Development-site sales from the development ledger, each priced per as-of-right buildable SF of its lot
  // as an empty site. A lot's envelope does not depend on deal settings, so the priced sales are shared by
  // every store in the process until the ledger changes or the day turns. Without a ledger there are none.
  landComps(now = Date.now()) {
    const path = this.ledgerPath ?? ledgerPath();
    if (!existsSync(path)) return [];
    const key = `${path}|${new Date(now).toISOString().slice(0, 10)}|${statSync(path).mtimeMs}`;
    if (landCompCache.key === key) return landCompCache.comps;
    const ledger = new DatabaseSync(path, {readOnly: true});
    const since = new Date(now - DEVELOPMENT_SITE_SALES.months * 30.4375 * 86400000).toISOString().slice(0, 10);
    const rows = ledger.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'development_site_sales'").get()
      ? ledger.prepare('SELECT doc_id, bbl, recorded_at, price, latitude, longitude, pluto_json FROM development_site_sales WHERE recorded_at >= ?').all(since) : [];
    ledger.close();
    const unitSizes = this.getUnitSizes();
    const comps = rows.filter(r => r.latitude && r.longitude).map(r => {
      const pluto = JSON.parse(r.pluto_json), site = {...pluto, bldgarea: 0, unitsres: 0, unitstotal: 0, bldgclass: 'V1', yearbuilt: null};
      const zfa = computeDealValuation(valuationInputs(parcelListingRow(site), null, DEFAULT_NYC_DEV_SETTINGS, unitSizes)).maxStandardZfa;
      return {docId: r.doc_id, bbl: r.bbl, recordedAt: r.recorded_at, price: r.price, latitude: r.latitude, longitude: r.longitude, pricePerBsf: zfa > 0 ? r.price / zfa : null,
        zfa, lotArea: Number(pluto.lotarea) || 0, existingSf: Number(pluto.bldgarea) || 0, unitsRes: Number(pluto.unitsres) || 0};
    }).filter(c => c.pricePerBsf > 0);
    landCompCache = {key, comps, byLatitude: [...comps].sort((a, b) => a.latitude - b.latitude), appraised: new Map()};
    return comps;
  }

  // The nearby market price for a lot (a listing row or a parcel row), and what that price comes to on
  // the lot's own as-of-right buildable floor area.
  // The appraised-value proxy for a city-financed building on a lot: its nearby development-site price, cached
  // with the priced sales. Sales within the widest radius lie within that distance of latitude, so only that band is read.
  appraisedLandFor(row, now = Date.now()) {
    const comps = this.landComps(now);
    if (!comps.length || !(Number(row.latitude) && Number(row.longitude))) return null;
    const subject = nearbyLandSubject(row);
    const key = `${row.latitude}|${row.longitude}|${row.bbl ?? ''}|${subject.lotArea}|${subject.zfa}|${subject.existingSf}|${subject.unitsRes}|${subject.corner}`;
    const cache = landCompCache.appraised;
    if (cache.has(key)) return cache.get(key);
    const band = LAND_COMPS.radiiMiles.at(-1) / 69, lat = Number(row.latitude), sorted = landCompCache.byLatitude;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].latitude < lat - band) lo = mid + 1; else hi = mid; }
    let end = lo;
    while (end < sorted.length && sorted[end].latitude <= lat + band) end++;
    // Only sales recorded before today: what a buyer could have known.
    const today = new Date(now).toISOString().slice(0, 10);
    const value = nearbyLandModel(sorted.slice(lo, end).filter(c => c.recordedAt < today), subject);
    cache.set(key, value);
    return value;
  }

  // The store's own figures for reading a listing as a building to keep (keep.mjs quickKeep): its ask, the
  // building PLUTO records on the lot, the listing's annual tax, the registered rent-stabilized count, the
  // ZIP's median asking rent and what standing buildings of its kind sold for there. Null for an unknown id.
  listingKeepInputs(id) {
    const r = this.one('SELECT id, list_price, pluto_bldg_area, units_res, bldg_class, asset_class, zip_code, annual_tax, rent_stabilized_units FROM market_listings WHERE id = ?', String(id));
    if (!r) return null;
    const rollup = r.zip_code ? this.getZipRollup(r.zip_code) : null;
    const perSqftPerMonth = Number(rollup?.devMetrics?.blendedRentPsfMonth);
    const sampleCount = Object.values(rollup?.byBedrooms || {}).reduce((sum, b) => sum + (Number(b.rentSampleCount) || 0), 0);
    return {
      price: Number(r.list_price) > 0 ? Number(r.list_price) : null,
      grossSqft: Number(r.pluto_bldg_area) || 0, residentialUnits: Number(r.units_res) || 0,
      annualTax: Number(r.annual_tax) > 0 ? Number(r.annual_tax) : null, regulatedUnits: Number(r.rent_stabilized_units) || 0,
      zipCode: r.zip_code || null,
      rent: perSqftPerMonth > 0 ? {perSqftPerMonth, sampleCount: sampleCount || null, asOf: rollup.updatedAt} : null,
      buildingSales: this.buildingSalesFor(r),
    };
  }

  // What standing buildings of the row's kind sold for per SF in its ZIP (BUILDING_SALES), or null. The medians
  // are read once per store state and day.
  buildingSalesFor(row) {
    // The city's building class says what stands on the lot; the listing's own type only where the lot has none.
    const cls = classifyBuildingClass(row.bldg_class), assetClass = cls ? cls.assetClass : row.asset_class;
    const kind = BUILDING_SALES.assetClasses[assetClass];
    if (!kind || cls?.unitSale || !row.zip_code) return null;
    const cache = storeCacheFor(this.path) ?? {};
    if (!cache.buildingSales) {
      const today = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - BUILDING_SALES.months * 30.4375 * 86400000).toISOString().slice(0, 10);
      const groups = new Map();
      for (const s of this.db.prepare(`SELECT zip_code, asset_class, sold_price / sqft AS psf FROM market_listings
          WHERE listing_type = 'sold' AND COALESCE(TRIM(unit), '') = '' AND sold_price > 0 AND sqft > 0
            AND substr(sold_date, 1, 10) >= ? AND substr(sold_date, 1, 10) <= ? AND asset_class IN (SELECT value FROM json_each(?))`)
        .iterate(since, today, JSON.stringify(Object.keys(BUILDING_SALES.assetClasses)))) {
        const key = `${s.zip_code}|${s.asset_class}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s.psf);
      }
      cache.buildingSales = new Map([...groups].filter(([, psfs]) => psfs.length >= BUILDING_SALES.minSales).map(([key, psfs]) => [key, {pricePerSqft: median(psfs, 0), saleCount: psfs.length}]));
    }
    const sales = cache.buildingSales.get(`${row.zip_code}|${assetClass}`);
    return sales ? {...sales, kind, zipCode: row.zip_code, months: BUILDING_SALES.months} : null;
  }


  // The measured premiums keyed by metric (`rent`, `sale`): the citywide one, with the boroughs and ZIPs
  // that have their own under `boroughs` and `zips`. An unmeasured metric is absent. A read-only store
  // opened before any writer created the table has none.
  getNewBuildPremiums() {
    if (!this.one("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'market_new_build_premiums'")) return {};
    return newBuildPremiumTable(this.query('SELECT * FROM market_new_build_premiums ORDER BY scope_key').map(r => ({
      metric: r.metric, scope: r.scope_key, ratio: r.ratio, rawRatio: r.raw_ratio, buildingCount: r.building_count, pairCount: r.pair_count, zipCount: r.zip_count, windowYears: r.window_years, asOf: r.as_of,
    })));
  }

  // The measured unit sizes keyed `${exit}|${scope}`. A read-only store opened before any writer created
  // the table has none, and every listing plans with the assumed mix.
  getUnitSizes() {
    const table = new Map();
    if (!this.one("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'market_unit_sizes'")) return table;
    for (const r of this.query('SELECT * FROM market_unit_sizes')) {
      table.set(`${r.exit}|${r.scope_key}`, {scope: r.scope_key, label: r.label, sampleCount: r.sample_count, asOf: r.as_of, averageNetSqft: r.average_net_sqft, mix: JSON.parse(r.mix_json)});
    }
    return table;
  }

  // geosearchFetcher, when given, resolves listings the coordinate match misses by address;
  // retryUnmatched also offers listings an earlier run could not match.
  async enrichNycListingsWithPluto({plutoFetcher = defaultPlutoBatchFetcher, geosearchFetcher = null, retryUnmatched = false, batchSize = 12, limit = 1000, settings = null} = {}) {
    const activeSettings = settings ? normalizeDealSettings(settings, this.getAdminConfig().dealSettings) : this.getAdminConfig().dealSettings;
    const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
    const candidates = this.query(`
      SELECT * FROM market_listings
      WHERE borough IS NOT NULL
        AND is_dev_candidate = 1
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND bbl IS NULL
        AND (? = 1 OR deal_verdict IS NULL OR deal_verdict != 'unmatched_parcel')
      ORDER BY last_seen_at DESC
      LIMIT ?
    `, retryUnmatched ? 1 : 0, limit);

    if (!candidates.length) { this.retireSupersededListings(); return {matched: 0, scanned: 0}; }

    // Group by borough so each Socrata query is scoped to a single borough
    const byBorough = new Map();
    for (const c of candidates) {
      const list = byBorough.get(c.borough) || [];
      list.push(c);
      byBorough.set(c.borough, list);
    }

    let matched = 0, geosearched = 0, incompleteBatches = 0, failedBatches = 0;
    const touchedZips = new Set();
    // The lot GeoSearch names for the listing, when its house number is the listing's and it lies
    // near the listing pin; its PLUTO row then stands in for a coordinate match.
    const byAddress = async (item, itemNum) => {
      const hit = await geosearchFetcher(item).catch(() => null);
      if (!hit?.bbl || !/^[1-5]\d{9}$/.test(hit.bbl)) return null;
      if (!houseNumbersMatch(itemNum, normalizeHouseNumber(hit.label), item.borough)) return null;
      if (Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude) && Math.hypot(hit.latitude - Number(item.latitude), hit.longitude - Number(item.longitude)) > GEOSEARCH_MAX_OFFSET_DEG) return null;
      const rows = await plutoFetcher(`bbl=${hit.bbl}`, 1).catch(() => []);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    };
    // Another lot in the borough with the matched lot's address that fits the listing, in the listing's
    // ZIP, nearest the listing pin first.
    const sameAddressLot = async (item, matched) => {
      const address = String(matched.address).toUpperCase();
      const rows = await plutoFetcher(`borough='${item.borough}' AND address='${address.replace(/'/g, "''")}'`, 50, {offset: 0}).catch(() => []);
      const zip = String(item.zip_code || '').slice(0, 5);
      const away = p => Math.hypot(Number(p.latitude) - Number(item.latitude), Number(p.longitude) - Number(item.longitude));
      return (Array.isArray(rows) ? rows : [])
        .filter(p => String(p.address || '').toUpperCase() === address && Math.trunc(Number(p.bbl)) !== Math.trunc(Number(matched.bbl)))
        .filter(p => (!zip || !p.zipcode || String(p.zipcode) === zip) && lotFitsListing(item, p))
        .sort((a, b) => away(a) - away(b))[0] ?? null;
    };

    for (const [borough, group] of byBorough.entries()) {
      for (let i = 0; i < group.length; i += batchSize) {
        const chunk = group.slice(i, i + batchSize);
        const boxClauses = chunk.map(c => {
          const lat = Number(c.latitude);
          const lon = Number(c.longitude);
          return `(latitude BETWEEN ${(lat - 0.00045).toFixed(6)} AND ${(lat + 0.00045).toFixed(6)} AND longitude BETWEEN ${(lon - 0.00055).toFixed(6)} AND ${(lon + 0.00055).toFixed(6)})`;
        });
        const where = `borough='${borough}' AND (${boxClauses.join(' OR ')})`;
        const plutoRows = [], seen = new Set();
        let complete = false;
        try {
          // Stable pages cover up to 2,000 candidates. An incomplete pool cannot
          // establish either the best match or a permanent unmatched verdict.
          for (let page = 0; page < 4; page++) {
            throwIfCancelled();
            const rows = await plutoFetcher(where, 500, {offset: page * 500});
            throwIfCancelled();
            if (!Array.isArray(rows)) throw new Error('Invalid PLUTO candidate response.');
            const duplicate = rows.some(row => seen.has(String(row.bbl)));
            if (duplicate) break; // Provider ignored offsets or changed between pages.
            for (const row of rows) { seen.add(String(row.bbl)); plutoRows.push(row); }
            if (rows.length < 500) { complete = true; break; }
          }
        } catch {
          throwIfCancelled();
          failedBatches++;
          continue;
        }
        if (!complete) { incompleteBatches++; continue; }

        for (const item of chunk) {
          const lat = Number(item.latitude);
          const lon = Number(item.longitude);
          const itemNum = normalizeHouseNumber(item.street_number || item.street_line || item.address);
          const itemStreet = normalizeStreetWords(item.street_line || item.street_name || item.address);

          let best = null;
          let bestScore = Infinity;
          let bestAddressMatch = false;
          for (const p of plutoRows) {
            const plat = Number(p.latitude || 0);
            const plon = Number(p.longitude || 0);
            const dist = Math.hypot(plat - lat, plon - lon);
            if (dist > 0.00065) continue;
            const pAddr = String(p.address || '').toUpperCase();
            const pNum = normalizeHouseNumber(pAddr);
            const pStreet = normalizeStreetWords(pAddr);

            const numExact = houseNumbersMatch(itemNum, pNum, borough);
            const streetOverlap = Boolean(itemStreet && pStreet && (pStreet.includes(itemStreet) || itemStreet.includes(pStreet)));
            if (itemNum && pNum && streetOverlap && !numExact) continue;
            // Require either exact house number within ~60m or very close coordinate (<12m for corner/unnumbered lots)
            if (!numExact && dist > 0.00012) continue;
            if (numExact && itemStreet && pStreet && !streetOverlap && dist > 0.00018) continue;

            const penalty = (numExact ? 0 : 0.00045) + (streetOverlap ? 0 : 0.00020);
            const score = dist + penalty;
            const addressMatch = numExact && streetOverlap;
            if ((addressMatch && !bestAddressMatch) || (addressMatch === bestAddressMatch && score < bestScore)) {
              bestScore = score;
              bestAddressMatch = addressMatch;
              best = p;
            }
          }

          // A proximity-only match on a numbered listing is confirmed by address: a pin tens of metres off
          // lands on a neighbour or a corner lot's other frontage, and GeoSearch names the listed lot.
          if (best && !bestAddressMatch && itemNum && geosearchFetcher) {
            throwIfCancelled();
            const named = await byAddress(item, itemNum);
            if (named && String(Math.trunc(Number(named.bbl))) !== String(Math.trunc(Number(best.bbl)))) { best = named; geosearched++; }
          }
          if (!best && geosearchFetcher) {
            throwIfCancelled();
            best = await byAddress(item, itemNum);
            if (best) geosearched++;
          }
          // A borough can hold two lots with one address (a street name reused in two neighbourhoods), and
          // a pin geocoded to the other one lands on a lot the listing does not describe: a house listed on a
          // parking lot. A same-address lot that fits the listing replaces it.
          const bestStreet = normalizeStreetWords(best?.address);
          const sameStreet = Boolean(itemStreet && bestStreet && (bestStreet.includes(itemStreet) || itemStreet.includes(bestStreet)));
          if (best && sameStreet && houseNumbersMatch(itemNum, normalizeHouseNumber(String(best.address).toUpperCase()), borough) && !lotFitsListing(item, best)) {
            throwIfCancelled();
            best = await sameAddressLot(item, best) ?? best;
          }
          if (!best) {
            this.write('UPDATE market_listings SET deal_verdict = ? WHERE id = ?', 'unmatched_parcel', item.id);
            continue;
          }
          const bbl = String(Math.trunc(Number(best.bbl || 0)));
          if (!/^[1-5]\d{9}$/.test(bbl)) {
            this.write('UPDATE market_listings SET deal_verdict = ? WHERE id = ?', 'unmatched_parcel', item.id);
            continue;
          }

          const lotArea = Number(best.lotarea || 0);
          const bldgArea = Number(best.bldgarea || 0);
          const builtFar = Number(best.builtfar || 0);
          const residFar = Number(best.residfar || 0);
          const affResFar = Number(best.affresfar || residFar || 0);
          const commFar = Number(best.commfar || 0);
          const facilFar = Number(best.facilfar || 0);
          const mnfFar = Number(best.mnffar || 0);
          const plutoYearBuilt = Number(best.yearbuilt || 0) > 1750 ? Math.trunc(Number(best.yearbuilt)) : null;
          const landmarkFlag = (best.landmark && String(best.landmark).trim()) || (best.histdist && String(best.histdist).trim()) ? 1 : 0;

          const floodZone = Number(best.pfirm15_flag) === 1 || Number(best.firm07_flag) === 1 ? 1 : 0;
          const parcel = {
            ...item,
            bbl,
            pluto_address: best.address ?? null,
            zoning_district: best.zonedist1 ?? null,
            overlay1: best.overlay1 ?? null,
            special_district: best.spdist1 ?? null,
            pluto_lot_area: lotArea,
            pluto_bldg_area: bldgArea,
            pluto_lot_front: Number(best.lotfront || 0) || null,
            pluto_lot_depth: Number(best.lotdepth || 0) || null,
            pluto_lot_type: best.lottype != null ? String(best.lottype) : null,
            front_street_feet: item.bbl === bbl ? item.front_street_feet : null,
            resid_far: residFar,
            aff_res_far: affResFar,
            comm_far: commFar,
            facil_far: facilFar,
            mnf_far: mnfFar,
            landmark_flag: landmarkFlag,
            flood_zone: floodZone,
            units_res: Number(best.unitsres || 0),
            units_total: Number(best.unitstotal || 0),
            year_built: item.year_built ?? plutoYearBuilt,
            owner_name: best.ownername ? String(best.ownername).trim() : null,
            bldg_class: best.bldgclass ? String(best.bldgclass).trim() : null,
          };
          const zipRollup = item.zip_code ? this.getZipRollup(item.zip_code) : null;
          const valuation = computeDealValuation(valuationInputs(parcel, zipRollup, activeSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(parcel), this.buildingSalesFor(parcel)));

          this.write(`
            UPDATE market_listings SET
              front_street_feet = CASE WHEN bbl = ? THEN front_street_feet END,
              front_street_checked_at = CASE WHEN bbl = ? THEN front_street_checked_at END,
              bbl = ?,
              pluto_address = ?,
              zoning_district = ?,
              overlay1 = ?,
              special_district = ?,
              pluto_lot_area = ?,
              pluto_bldg_area = ?,
              pluto_built_far = ?,
              pluto_lot_front = ?,
              pluto_lot_depth = ?,
              pluto_lot_type = ?,
              resid_far = ?,
              aff_res_far = ?,
              comm_far = ?,
              facil_far = ?,
              mnf_far = ?,
              landmark_flag = ?,
              flood_zone = ?,
              units_res = ?,
              units_total = ?,
              year_built = COALESCE(year_built, ?),
              owner_name = ?,
              bldg_class = ?
            WHERE id = ?
          `,
            bbl,
            bbl,
            bbl,
            parcel.pluto_address,
            parcel.zoning_district,
            parcel.overlay1,
            parcel.special_district,
            lotArea,
            bldgArea,
            builtFar,
            parcel.pluto_lot_front,
            parcel.pluto_lot_depth,
            parcel.pluto_lot_type,
            residFar,
            affResFar,
            commFar,
            facilFar,
            mnfFar,
            landmarkFlag,
            floodZone,
            parcel.units_res,
            parcel.units_total,
            plutoYearBuilt,
            parcel.owner_name,
            parcel.bldg_class,
            item.id
          );
          this.writeValuation(item.id, valuation);
          matched++;
          if (item.zip_code) touchedZips.add(item.zip_code);
        }
      }
    }

    for (const zip of touchedZips) {
      this.recomputeZipRollup(zip);
    }
    this.retireSupersededListings();
    return {matched, geosearched, scanned: candidates.length, incompleteBatches, failedBatches};
  }

  // HPD Multiple Dwelling Registration dates for matched parcels, read in lot batches and rechecked
  // monthly; the tenant screen then knows whether the building is a registered, current multiple dwelling.
  // A batch the feed fails is left unchecked and counted, so a lapse is never recorded from a failed read.
  async backfillHpdRegistrations({hpdRegistrationFetcher = defaultHpdRegistrationBatchFetcher, batchSize = 50, limit = 20000, now = Date.now(), settings = null} = {}) {
    const rows = this.query('SELECT DISTINCT bbl FROM market_listings WHERE bbl IS NOT NULL AND (hpd_registration_checked_at IS NULL OR hpd_registration_checked_at < ?) LIMIT ?', now - HPD_REGISTRATION_RECHECK_MS, limit);
    const bbls = rows.map(r => r.bbl).filter(b => /^[1-5]\d{9}$/.test(b));
    let checked = 0, registered = 0, failedBatches = 0;
    for (let i = 0; i < bbls.length; i += batchSize) {
      const batch = bbls.slice(i, i + batchSize);
      let regRows;
      try {
        throwIfCancelled();
        regRows = await hpdRegistrationFetcher(batch);
        if (!Array.isArray(regRows)) throw new Error('Invalid HPD registrations response.');
      } catch {
        throwIfCancelled();
        failedBatches++;
        continue;
      }
      const latest = new Map();
      for (const row of regRows) {
        const bbl = hpdRegistrationBbl(row);
        const end = row.registrationenddate ? String(row.registrationenddate).slice(0, 10) : null;
        const last = row.lastregistrationdate ? String(row.lastregistrationdate).slice(0, 10) : null;
        const prior = latest.get(bbl) || {end: null, last: null};
        latest.set(bbl, {end: [prior.end, end].filter(Boolean).sort().at(-1) || null, last: [prior.last, last].filter(Boolean).sort().at(-1) || null});
      }
      for (const bbl of batch) {
        const reg = latest.get(bbl);
        this.write('UPDATE market_listings SET hpd_last_registration = ?, hpd_registration_end = ?, hpd_registration_checked_at = ? WHERE bbl = ?', reg?.last ?? null, reg?.end ?? null, now, bbl);
        checked++;
        if (reg) registered++;
      }
    }
    if (checked) {
      const dealSettings = settings ? normalizeDealSettings(settings, this.getAdminConfig().dealSettings) : this.getAdminConfig().dealSettings;
      const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
      for (const r of this.query('SELECT * FROM market_listings WHERE hpd_registration_checked_at = ? AND bbl IN (SELECT value FROM json_each(?))', now, JSON.stringify(bbls))) {
        this.writeValuation(r.id, computeDealValuation(valuationInputs(r, r.zip_code ? this.getZipRollup(r.zip_code) : null, dealSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(r), this.buildingSalesFor(r))));
      }
    }
    return {checked, registered, failedBatches};
  }

  revalueDealsWithSettings(settings = null, boroughFilter = null) {
    const activeSettings = settings ? normalizeDealSettings(settings, this.getAdminConfig().dealSettings) : this.getAdminConfig().dealSettings;
    this.recomputeUnitSizes();
    this.recomputeNewBuildPremiums();
    const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
    const rows = this.query(`
      SELECT * FROM market_listings
      WHERE bbl IS NOT NULL AND (? IS NULL OR borough = ?)
    `, boroughFilter, boroughFilter);
    for (const r of rows) {
      const zipRollup = r.zip_code ? this.getZipRollup(r.zip_code) : null;
      this.writeValuation(r.id, computeDealValuation(valuationInputs(r, zipRollup, activeSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(r), this.buildingSalesFor(r))));
    }
    return {revalued: rows.length};
  }

  // Listings last seen before the latest completed all-borough scrape, less a grace for a borough
  // whose scrape failed, are off the market. An incremental scrape returns only what changed, so it is
  // never that reference. With no such scrape every listing stays.
  forSaleStaleCutoff(graceMs = FOR_SALE_STALE_GRACE_MS) {
    const last = this.one(`SELECT MAX(started_at) AS at FROM market_sync_runs WHERE status = 'completed' AND json_array_length(locations_json) >= ? AND json_extract(summary_json, '$.updatedInPastHours') IS NULL`, NYC_BOROUGH_LOCATIONS.length);
    return last?.at ? Number(last.at) - graceMs : 0;
  }

  // One active for-sale listing per lot once parcels are matched. An MLS listing on the lot takes precedence
  // over a broker site's copy of it, whichever arrived first (a broker sync skips a lot an MLS row already
  // holds; LoopNet retires its own copies after matching), and a whole-lot closing retires a for-sale listing
  // on its lot listed on or before it.
  // Condo and co-op units share their building's lot, so their sales never retire a lot's listing.
  retireSupersededListings() {
    const staleBefore = this.forSaleStaleCutoff();
    const brokerTwins = this.write(`UPDATE market_listings SET listing_type = 'off_market', mls_status = 'off_market'
      WHERE listing_type = 'for_sale' AND bbl IS NOT NULL AND source LIKE 'broker:%'
        AND EXISTS (SELECT 1 FROM market_listings o WHERE o.bbl = market_listings.bbl AND o.listing_type = 'for_sale' AND o.source IS NULL AND o.last_seen_at >= ?)`, staleBefore).changes;
    const sold = this.query(`SELECT DISTINCT f.id, f.zip_code FROM market_listings f JOIN market_listings s ON s.bbl = f.bbl
      WHERE f.listing_type = 'for_sale' AND f.bbl IS NOT NULL AND s.listing_type = 'sold'
        AND f.asset_class IS NOT 'condo_coop_apartment' AND s.asset_class IS NOT 'condo_coop_apartment'
        AND substr(s.sold_date, 1, 10) >= COALESCE(substr(f.list_date, 1, 10), date(f.first_seen_at / 1000, 'unixepoch'))`);
    for (const {id} of sold) this.write("UPDATE market_listings SET listing_type = 'off_market', mls_status = 'off_market' WHERE id = ?", id);
    for (const zip of new Set(sold.map(r => r.zip_code).filter(Boolean))) this.recomputeZipRollup(zip);
    return {brokerTwins: Number(brokerTwins), soldTwins: sold.length};
  }

  // After a complete scrape of every borough (whole lots included, no location or listing type failed),
  // MLS for-sale listings not seen since the stale cutoff have sold or been withdrawn: they go off the
  // market for good, so comps, ZIP rollups and counts drop them too. A partial or failed sync sweeps nothing.
  sweepStaleForSale(staleBefore) {
    const stale = this.query("SELECT id, zip_code FROM market_listings WHERE listing_type = 'for_sale' AND source IS NULL AND last_seen_at < ?", staleBefore);
    for (const {id} of stale) this.write("UPDATE market_listings SET listing_type = 'off_market', mls_status = 'off_market' WHERE id = ?", id);
    for (const zip of new Set(stale.map(r => r.zip_code).filter(Boolean))) this.recomputeZipRollup(zip);
    return {swept: stale.length};
  }

  // Stored copies of the valuation, which SQL filters and the default order read.
  writeValuation(id, val) {
    this.write(`
      UPDATE market_listings SET
        max_standard_zfa = ?,
        max_uap_zfa = ?,
        max_any_use_zfa = ?,
        any_use_price_per_buildable_zfa = ?,
        gross_buildable_sqft = ?,
        unused_standard_zfa = ?,
        unused_uap_zfa = ?,
        existing_price_per_sqft = ?,
        price_per_buildable_zfa = ?,
        uap_price_per_buildable_zfa = ?,
        price_per_buildable_sf = ?,
        far_compression_pct = ?,
        submarket_sale_psf = ?,
        submarket_rent_psf = ?,
        estimated_redev_value = ?,
        great_deal_max_bsf = ?,
        good_deal_max_bsf = ?,
        bad_deal_min_bsf = ?,
        implied_yield_on_cost = ?,
        implied_condo_margin = ?,
        deal_verdict = ?
      WHERE id = ?
    `,
      val.maxStandardZfa,
      val.maxUapZfa,
      val.maxAnyUseZfa,
      val.anyUsePricePerBuildableZfa,
      val.grossBuildableSqft,
      val.unusedStandardZfa,
      val.unusedUapZfa,
      val.existingPricePerSqft,
      val.pricePerBuildableZfa,
      val.uapPricePerBuildableZfa,
      val.pricePerBuildableSf,
      val.farCompressionPct,
      val.submarketSalePsf,
      val.submarketRentPsf,
      val.estimatedRedevValue,
      val.greatDealMaxBsf,
      val.goodDealMaxBsf,
      val.badDealMinBsf,
      val.impliedYieldOnCost,
      val.impliedCondoMargin,
      val.dealVerdict,
      id
    );
  }

  // Flood flags for parcels matched before the store read them from PLUTO.
  async backfillFloodZones({plutoFetcher = defaultPlutoBatchFetcher, batchSize = 50, limit = 20000} = {}) {
    const rows = this.query('SELECT DISTINCT bbl FROM market_listings WHERE bbl IS NOT NULL AND flood_zone IS NULL LIMIT ?', limit);
    let updated = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const bbls = rows.slice(i, i + batchSize).map(r => r.bbl).filter(b => /^[1-5]\d{9}$/.test(b));
      if (!bbls.length) continue;
      const plutoRows = await plutoFetcher(`bbl in (${bbls.map(b => `'${b}'`).join(', ')})`, batchSize * 2);
      const flooded = new Set(plutoRows.filter(p => Number(p.pfirm15_flag) === 1 || Number(p.firm07_flag) === 1).map(p => String(Math.trunc(Number(p.bbl)))));
      for (const bbl of bbls) updated += this.write('UPDATE market_listings SET flood_zone = ? WHERE bbl = ?', flooded.has(bbl) ? 1 : 0, bbl).changes;
    }
    return {updated};
  }

  // The mapped widths of the streets each lot fronts (DCP Digital City Map, as the zoning tool reads it),
  // for lots whose district sets a higher FAR on a wide street; their listings are revalued under it.
  // The widest non-front street is kept too: a corner lot takes the wide-street row from a wide side street.
  // Corner lots read before side widths were kept are read again once, to fill theirs in.
  async backfillFrontStreets({lookup = frontingStreets, limit = 20000, concurrency = 6, now = Date.now()} = {}) {
    const districts = Object.entries(ZONING_RULES.districts).filter(([, d]) => d.farResidentialWideStreet).map(([code]) => code);
    const rows = this.query(`
      SELECT bbl, MIN(COALESCE(pluto_address, address)) AS address FROM market_listings
      WHERE bbl IS NOT NULL AND (front_street_checked_at IS NULL OR (TRIM(pluto_lot_type) = '3' AND side_street_feet IS NULL AND front_street_feet IS NOT NULL AND front_street_feet < ?))
        AND UPPER(TRIM(zoning_district)) IN (SELECT value FROM json_each(?))
      GROUP BY bbl LIMIT ?
    `, ZONING_RULES.bulk.streets.wideStreetMinimumWidthFeet, JSON.stringify(districts), limit).filter(r => /^[1-5]\d{9}$/.test(r.bbl));
    let wide = 0;
    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(rows.slice(i, i + concurrency).map(async ({bbl, address}) => {
        const {streets} = await lookup({bbl, address});
        const feet = streets.find(s => s.side === 'front')?.widthFeet ?? null;
        const sideWidths = streets.filter(s => s.side !== 'front').map(s => s.widthFeet).filter(Number.isFinite);
        // 0 marks "read, no side street found", so such a corner lot is not read again on every pass.
        const sideFeet = sideWidths.length ? Math.max(...sideWidths) : 0;
        this.write('UPDATE market_listings SET front_street_feet = ?, side_street_feet = ?, front_street_checked_at = ? WHERE bbl = ?', feet, sideFeet, now, bbl);
        if (isWideFront(feet) || isWideFront(sideFeet)) wide++;
      }));
    }
    if (rows.length) {
      const dealSettings = this.getAdminConfig().dealSettings;
      const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
      for (const r of this.query('SELECT * FROM market_listings WHERE front_street_checked_at = ? AND bbl IN (SELECT value FROM json_each(?))', now, JSON.stringify(rows.map(r => r.bbl)))) {
        this.writeValuation(r.id, computeDealValuation(valuationInputs(r, r.zip_code ? this.getZipRollup(r.zip_code) : null, dealSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(r), this.buildingSalesFor(r))));
      }
    }
    return {checked: rows.length, wide};
  }

  // Each unchecked lot's own MapPLUTO shape, snapped to the edge closest to its PLUTO frontage and
  // stored in feet, so the deal screen draws the envelope on the tax lot's actual outline instead of
  // the frontage-by-depth rectangle. A lot MapPLUTO has no single outline for is marked read with no
  // polygon, and the rectangle stands for it. Lots that gained an outline are revalued under it.
  async backfillLotPolygons({fetchGeometry = fetchLotGeometry, limit = 20000, batchSize = 100, now = Date.now()} = {}) {
    const rows = this.query(`
      SELECT bbl, MAX(pluto_lot_front) AS lot_front FROM market_listings
      WHERE bbl IS NOT NULL AND lot_polygon_checked_at IS NULL AND pluto_lot_area > 0
      GROUP BY bbl LIMIT ?
    `, limit).filter(r => /^[1-5]\d{9}$/.test(r.bbl));
    let withPolygon = 0;
    const store = (bbl, outline) => {
      const json = outline ? JSON.stringify({polygon: outline.polygon, widthFeet: outline.widthFeet, depthFeet: outline.depthFeet, frontEdgeIndex: outline.frontEdgeIndex, edges: outline.edges}) : null;
      this.write('UPDATE market_listings SET lot_polygon_json = ?, lot_polygon_checked_at = ? WHERE bbl = ?', json, now, bbl);
      if (outline) withPolygon++;
    };
    const snapOne = async ({bbl, lot_front}) => {
      let outline = null;
      try {
        const parts = (await fetchGeometry([bbl])).get(bbl);
        if (parts?.length) outline = snapTaxLotOutline(toLocalFeet(new Map([[bbl, parts]])).get(bbl), {frontageFeet: Number(lot_front) || null});
      } catch { outline = null; }
      store(bbl, outline);
    };
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      let feet = null;
      try { feet = toLocalFeet(await fetchGeometry(batch.map(r => r.bbl))); } catch { feet = null; }
      if (!feet) { for (const row of batch) await snapOne(row); continue; }
      for (const {bbl, lot_front} of batch) {
        let outline = null;
        const parts = feet.get(bbl);
        if (parts?.length) { try { outline = snapTaxLotOutline(parts, {frontageFeet: Number(lot_front) || null}); } catch { outline = null; } }
        store(bbl, outline);
      }
    }
    if (rows.length) {
      const dealSettings = this.getAdminConfig().dealSettings;
      const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
      for (const r of this.query('SELECT * FROM market_listings WHERE lot_polygon_checked_at = ? AND lot_polygon_json IS NOT NULL AND bbl IN (SELECT value FROM json_each(?))', now, JSON.stringify(rows.map(r => r.bbl)))) {
        this.writeValuation(r.id, computeDealValuation(valuationInputs(r, r.zip_code ? this.getZipRollup(r.zip_code) : null, dealSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(r), this.buildingSalesFor(r))));
      }
    }
    return {checked: rows.length, withPolygon};
  }

  lotListing(bbl) {
    return bbl ? this.one("SELECT * FROM market_listings WHERE bbl = ? AND listing_type = 'for_sale' AND pluto_lot_area > 0 ORDER BY last_seen_at DESC, id DESC LIMIT 1", String(bbl)) : null;
  }

  // The stored tax-lot outline's points in feet (front on z = 0) for a lot, or null when none is stored.
  lotPolygonFor(bbl) {
    if (!bbl) return null;
    const row = this.one('SELECT lot_polygon_json FROM market_listings WHERE bbl = ? AND lot_polygon_json IS NOT NULL LIMIT 1', String(bbl));
    return normalizeLotPolygon(row?.lot_polygon_json)?.points ?? null;
  }

  // The row a lot is valued from: its newest for-sale listing, else its parcel record, keyed to its BBL so
  // the nearby land model leaves the lot's own sales out.
  lotRow({bbl, property = null, listing = this.lotListing(bbl)}) {
    return listing ?? (property ? {...parcelListingRow(property), bbl: property.bbl ?? bbl ?? null} : null);
  }

  // What nearby development sites sold for on a lot's as-of-right buildable area as of `now`, the figure its
  // site page leads with; where there is none, {value: null, reason} says why.
  lotNearbyLand({bbl, property = null, now = Date.now()}) {
    const row = this.lotRow({bbl, property});
    if (!row) return {value: null, reason: 'the lot has no listing or parcel record to value'};
    const valuation = computeDealValuation(valuationInputs(row, null, DEFAULT_NYC_DEV_SETTINGS, this.getUnitSizes(), null, this.appraisedLandFor(row, now)));
    if (valuation.nearbyLand?.value > 0) return {...valuation.nearbyLand, buildableSqft: valuation.maxStandardZfa};
    return {value: null, reason: this.nearbyLandGap(row, valuation, now)};
  }

  // Why a lot has no nearby development-site figure.
  nearbyLandGap(row, valuation, now = Date.now()) {
    const comps = this.landComps(now);
    if (!comps.length) return 'the development ledger has no development-site sales synced';
    if (!(Number(row.latitude) && Number(row.longitude))) return 'the lot has no coordinates to find nearby sales from';
    const subject = nearbyLandSubject(row);
    if (!(subject.zfa > 0) || !(valuation.maxStandardZfa > 0)) return "the lot's zoning gives it no as-of-right residential floor area to price";
    const today = new Date(now).toISOString().slice(0, 10), here = {latitude: Number(row.latitude), longitude: Number(row.longitude)};
    const widest = LAND_COMPS.radiiMiles.at(-1), market = landMarket(subject);
    // The same sales the model reads: earlier ones in the lot's borough, the lot's own left out.
    const count = comps.filter(c => c.bbl !== subject.bbl && (!market || landMarket(c) === market) && c.recordedAt < today && milesApart(here, c) <= widest).length;
    return `only ${count} development-site ${count === 1 ? 'sale was' : 'sales were'} recorded ${market ? "in the lot's borough " : ''}within ${widest} miles in the ${DEVELOPMENT_SITE_SALES.months} months before ${today}, fewer than ${LAND_COMPS.minSales}`;
  }

  // Whether each matched parcel lies in a mapped MIH area, tested at its PLUTO point and rechecked
  // monthly as DCP maps new areas; the listings are revalued under the result.
  // The deal valuation of one lot with every candidate building it weighed, at the account's deal
  // settings: the lot's newest for-sale listing when the store has one, so it matches that listing's
  // deal card, and otherwise the parcel record itself. A land price, when given, stands in for the ask.
  lotValuation({bbl, property = null, account = null, landPrice = null}) {
    const listing = this.lotListing(bbl);
    const row = this.lotRow({bbl, property, listing});
    if (!row) return null;
    const priced = Number(landPrice) > 0 ? {...row, list_price: Number(landPrice)} : row;
    const zipRollup = row.zip_code ? this.getZipRollup(row.zip_code) : null;
    const valuation = computeDealValuation({...valuationInputs(priced, zipRollup, this.getUserDealSettings(account).dealSettings, this.getUnitSizes(), this.getNewBuildPremiums(), this.appraisedLandFor(priced), this.buildingSalesFor(priced)), withCandidates: true});
    const ask = Number(priced.list_price) > 0 ? Number(priced.list_price) : null;
    return {valuation, nearbyLand: valuation.nearbyLand, source: listing ? 'listing' : 'parcel', listingId: listing?.id ?? null, ask, askFrom: ask === null ? null : Number(landPrice) > 0 ? 'assumptions' : 'listing'};
  }

  // The latest rent-stabilized count per lot, from the monthly copy of the JustFix file.
  lookupRentStabilizedUnits(bbl) {
    const row = this.one('SELECT bbl, units, year, statement_url, synced_at FROM rent_stabilized_units WHERE bbl = ?', String(bbl));
    return row ? {bbl: row.bbl, units: row.units, year: row.year, statementUrl: row.statement_url, syncedAt: row.synced_at} : null;
  }

  // Replaces the stored counts with a fresh copy once a month; a failed download keeps the old copy.
  async syncRentStabilizedUnits({fetcher = defaultRentStabilizedFetcher, now = Date.now(), maxAgeMs = RENT_STABILIZED_RESYNC_MS} = {}) {
    const current = this.one('SELECT MAX(synced_at) AS at, COUNT(*) AS n FROM rent_stabilized_units');
    if (current?.at && now - Number(current.at) < maxAgeMs) return {skipped: true, rows: current.n, syncedAt: Number(current.at)};
    const {rows} = await fetcher();
    if (!Array.isArray(rows) || !rows.length) throw new Error('Rent-stabilized counts came back empty.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.write('DELETE FROM rent_stabilized_units');
      const insert = this.db.prepare('INSERT INTO rent_stabilized_units (bbl, units, year, statement_url, synced_at) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) insert.run(r.bbl, r.units, r.year, r.statementUrl ?? null, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {skipped: false, rows: rows.length, syncedAt: now};
  }

  // Every matched lot carries its registered rent-stabilized count (or none) from the current copy,
  // and the tenant screen is revalued for the lots whose count was read in this pass.
  async backfillRentStabilizedUnits({fetcher = defaultRentStabilizedFetcher, now = Date.now(), limit = 20000, settings = null} = {}) {
    const sync = await this.syncRentStabilizedUnits({fetcher, now});
    const rows = this.query('SELECT DISTINCT bbl FROM market_listings WHERE bbl IS NOT NULL AND (rent_stabilized_checked_at IS NULL OR rent_stabilized_checked_at < ?) LIMIT ?', sync.syncedAt, limit);
    const bbls = rows.map(r => r.bbl).filter(b => /^[1-5]\d{9}$/.test(b));
    let withUnits = 0;
    for (const bbl of bbls) {
      const found = this.one('SELECT units, year FROM rent_stabilized_units WHERE bbl = ?', bbl);
      this.write('UPDATE market_listings SET rent_stabilized_units = ?, rent_stabilized_year = ?, rent_stabilized_checked_at = ? WHERE bbl = ?', found?.units ?? null, found?.year ?? null, now, bbl);
      if (found?.units > 0) withUnits++;
    }
    if (bbls.length) {
      const dealSettings = settings ? normalizeDealSettings(settings, this.getAdminConfig().dealSettings) : this.getAdminConfig().dealSettings;
      const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
      for (const r of this.query('SELECT * FROM market_listings WHERE rent_stabilized_checked_at = ? AND bbl IN (SELECT value FROM json_each(?))', now, JSON.stringify(bbls))) {
        this.writeValuation(r.id, computeDealValuation(valuationInputs(r, r.zip_code ? this.getZipRollup(r.zip_code) : null, dealSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(r), this.buildingSalesFor(r))));
      }
    }
    return {checked: bbls.length, withUnits, source: sync};
  }

  async assignMihAreas({mihAreasFetcher = defaultMihAreasFetcher, plutoFetcher = defaultPlutoBatchFetcher, batchSize = 50, limit = 20000, now = Date.now()} = {}) {
    const rows = this.query('SELECT DISTINCT bbl FROM market_listings WHERE bbl IS NOT NULL AND (mih_checked_at IS NULL OR mih_checked_at < ?) LIMIT ?', now - MIH_RECHECK_MS, limit);
    const bbls = rows.map(r => r.bbl).filter(b => /^[1-5]\d{9}$/.test(b));
    if (!bbls.length) return {checked: 0, inside: 0};
    const areas = await mihAreasFetcher();
    let checked = 0;
    let inside = 0;
    for (let i = 0; i < bbls.length; i += batchSize) {
      const batch = bbls.slice(i, i + batchSize);
      const plutoRows = await plutoFetcher(`bbl in (${batch.map(b => `'${b}'`).join(', ')})`, batchSize * 2);
      const points = new Map(plutoRows.map(p => [String(Math.trunc(Number(p.bbl))), p]));
      for (const bbl of batch) {
        const point = points.get(bbl);
        if (!point || !Number.isFinite(Number(point.latitude)) || !Number.isFinite(Number(point.longitude))) continue;
        const area = mihAreaAt(areas, point.latitude, point.longitude);
        this.write('UPDATE market_listings SET in_mih_area = ?, mih_area_json = ?, mih_checked_at = ? WHERE bbl = ?', area ? 1 : 0, area ? JSON.stringify(area) : null, now, bbl);
        checked++;
        if (area) inside++;
      }
    }
    const dealSettings = this.getAdminConfig().dealSettings;
    const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
    for (const r of this.query(`SELECT * FROM market_listings WHERE mih_checked_at = ? AND bbl IN (SELECT value FROM json_each(?))`, now, JSON.stringify(bbls))) {
      this.writeValuation(r.id, computeDealValuation(valuationInputs(r, r.zip_code ? this.getZipRollup(r.zip_code) : null, dealSettings, unitSizes, newBuildPremiums, this.appraisedLandFor(r), this.buildingSalesFor(r))));
    }
    return {checked, inside};
  }

  getSimilarCompsForDeal(dealOrId, {limit = 5} = {}) {
    const subject = typeof dealOrId === 'string'
      ? (this.one('SELECT * FROM market_listings WHERE id = ? OR bbl = ? LIMIT 1', dealOrId, dealOrId))
      : dealOrId;
    if (!subject) return [];

    const subjId = subject.id || '';
    const recordedBbl = String(subject.bbl ?? '').trim();
    const subjBbl = /^\d{10}$/.test(recordedBbl) && Number(recordedBbl) > 0 ? recordedBbl : null;
    const subjPropertyId = String(subject.property_id ?? subject.propertyId ?? '').trim() || null;
    const subjZip = subject.zip_code ?? subject.zipCode ?? null;
    const subjBorough = subject.borough ?? null;
    const subjLat = Number(subject.latitude ?? 0);
    const subjLon = Number(subject.longitude ?? 0);

    const comparablePriceSql = "CASE WHEN listing_type = 'sold' THEN sold_price ELSE list_price END";
    // A subject's historical sale or alternate listing is not independent peer evidence.
    // An apartment, condo or commercial unit's sale prices a unit, not a site, so unit rows are never site comps.
    // Every eligible peer is ranked, nearest first: a row beyond the 0.85 mile box scores at most
    // 19 for distance, 84 in all, so once the kept set beats that the distant rows are never read.
    // Stream only the fields used here.
    const select = `
      SELECT rowid AS candidate_order, last_seen_at, id, bbl, property_id, address, zip_code, borough, listing_type,
        latitude, longitude, zoning_district, resid_far, comm_far, overlay1,
        max_uap_zfa, max_standard_zfa, pluto_lot_area, lot_sqft, pluto_bldg_area, sqft,
        price_per_sqft, sold_date, list_date, url, ${comparablePriceSql} AS comparable_price
      FROM market_listings
      WHERE id != ?
        AND (? IS NULL OR COALESCE(TRIM(bbl), '') != ?)
        AND (? IS NULL OR COALESCE(TRIM(property_id), '') != ?)
        AND listing_type IN ('sold', 'for_sale')
        AND asset_class IS NOT 'condo_coop_apartment' AND COALESCE(TRIM(unit), '') = ''
        AND ${comparablePriceSql} > 0
        AND (? IS NULL OR zip_code = ? OR borough = ?)`;
    const params = [subjId, subjBbl, subjBbl, subjPropertyId, subjPropertyId, subjZip || subjBorough, subjZip, subjBorough];
    const box = 'latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?';
    const unlocated = 'latitude IS NULL OR latitude = 0 OR longitude IS NULL OR longitude = 0';
    const near = 0.85, boxParams = [subjLat - near / 69.0, subjLat + near / 69.0, subjLon - near / 52.3, subjLon + near / 52.3];
    const nearby = subjLat && subjLon ? [[`${select} AND ${box}`, [...params, ...boxParams]], [`${select} AND (${unlocated})`, params]] : [[select, params]];
    const distant = subjLat && subjLon ? [`${select} AND NOT (${unlocated}) AND NOT (${box})`, [...params, ...boxParams]] : null;
    const DISTANT_CEILING = 84;

    // The same scorer as a page of deals uses (comparableRanker), so one listing's comps match its card's.
    const ranker = comparableRanker(subject, limit);
    for (const [sql, bound] of nearby) for (const c of this.db.prepare(sql).iterate(...bound)) ranker.consider(c);
    if (distant && !ranker.settledAbove(DISTANT_CEILING)) for (const c of this.db.prepare(distant[0]).iterate(...distant[1])) ranker.consider(c);
    return ranker.results();
  }

  // Comps for listings read from the store are kept until the store changes, since both sides of the
  // match come from it. Only unmodified stored rows may be passed.
  storedListingComps(rows, limit) {
    const cache = storeCacheFor(this.path);
    const missing = cache ? rows.filter(r => !cache.comps.has(r.id)) : rows;
    const ranked = this.getSimilarCompsForDeals(missing, {limit});
    if (!cache) return ranked;
    for (const [r, comps] of ranked) cache.comps.set(r.id, comps);
    return new Map(rows.map(r => [r, cache.comps.get(r.id)]));
  }

  getSimilarCompsForDeals(subjects, {limit = 5} = {}) {
    // Unit sales are not site comps (see getSimilarCompsForDeal).
    if(!subjects.length)return new Map();
    const rankers=subjects.map(subject=>({subject,ranker:comparableRanker(subject,limit)}));
    const zips=[...new Set(subjects.map(s=>s.zip_code??s.zipCode??null).filter(value=>value!==null))];
    const boroughs=[...new Set(subjects.map(s=>s.borough??null).filter(value=>value!==null))];
    const scoped=subjects.every(s=>(s.zip_code??s.zipCode)||s.borough);
    const price="CASE WHEN listing_type = 'sold' THEN sold_price ELSE list_price END";
    const candidates=this.db.prepare(`SELECT rowid AS candidate_order,last_seen_at,id,bbl,property_id,address,zip_code,borough,listing_type,
        latitude,longitude,zoning_district,resid_far,comm_far,overlay1,max_uap_zfa,max_standard_zfa,
        pluto_lot_area,lot_sqft,pluto_bldg_area,sqft,price_per_sqft,sold_date,list_date,url,${price} AS comparable_price
      FROM market_listings WHERE listing_type IN ('sold','for_sale') AND asset_class IS NOT 'condo_coop_apartment' AND COALESCE(TRIM(unit),'')='' AND ${price}>0 AND ${price}<=?
        ${scoped?'AND (zip_code IN (SELECT value FROM json_each(?)) OR borough IN (SELECT value FROM json_each(?)))':''}`)
      .iterate(Number.MAX_VALUE,...(scoped?[JSON.stringify(zips),JSON.stringify(boroughs)]:[]));
    for(const candidate of candidates)for(const {ranker} of rankers)ranker.consider(candidate);
    return new Map(rankers.map(({subject,ranker})=>[subject,ranker.results()]));
  }

  searchDeals(filters = {}) {
    return this.searchDealsPage(filters).deals;
  }

  // One page of deals and the number that match. Every sort ends on id, so offset pages never overlap or skip a listing.
  searchDealsPage({
    listingId = null,
    borough = null,
    zipCode = null,
    area = null,
    zoningPrefix = null,
    listingType = 'for_sale',
    minUnusedZfa = 500,
    minHeadroomFar = null,
    maxPricePerBuildableZfa = null,
    maxPricePerBuildableAnyUse = null,
    minListPrice = null,
    maxListPrice = null,
    minLotArea = null,
    maxLotArea = null,
    minBuildableZfa = null,
    minLotFront = null,
    maxLotFront = null,
    minLotDepth = null,
    maxLotDepth = null,
    minProjectCost = null,
    maxProjectCost = null,
    styles = null,
    dealVerdict = null,
    bounds = null,
    excludeLandmarks = false,
    excludeHighStabilizedRisk = false,
    mihArea = null,
    includeSimilarComps = true,
    sortBy = 'uap_price_per_buildable_zfa',
    limit = 25,
    offset = 0,
    pins = false,
    customSettings = null,
  } = {}) {
    const bCode = borough ? (BOROUGH_BY_CITY_OR_COUNTY[String(borough).toLowerCase().trim()] || String(borough).toUpperCase().trim()) : null;
    // Typed text matches literally: % and _ are escaped, not LIKE wildcards.
    const literal = text => text.replace(/[\\%_]/g, '\\$&');
    const zPrefix = zoningPrefix ? `${literal(String(zoningPrefix).toUpperCase().trim())}%` : null;
    const cappedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 25), 100));
    // A list of ZIPs is a union; other text matches the neighborhood or city name.
    const areaText = area ? String(area).trim() : '';
    const zipList = listingAreaZips(areaText);
    const areaZips = zipList ? JSON.stringify(zipList) : null;
    const areaName = areaText && !areaZips ? `%${literal(areaText.toLowerCase())}%` : null;
    // Text that starts a street address ("6 Chatham", "6 chatham square") also finds that listing, by
    // the listing's own address or the city record's spelled-out one.
    const areaAddress = areaName ? `${literal(areaText.toLowerCase().replace(/\s+/g, ' '))}%` : null;
    const listOf = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);
    const verdicts = listOf(dealVerdict);
    const styleList = listOf(styles);
    // A listing with no ask has no price to bound, so with the Unpriced tier chosen the price bounds
    // keep it; priced listings still meet them.
    const unpriced = verdicts.includes('unpriced_opportunity') ? 'COALESCE(list_price, 0) <= 0' : '0';
    const box = bounds && ['south', 'west', 'north', 'east'].every(k => Number.isFinite(Number(bounds[k]))) ? bounds : null;

    // Yield, margin, the best-deal order and the headroom a card prints (the building that sets the value)
    // move with the cost profile, so they rank on the valuation this request returns.
    const liveRank = {implied_yield_on_cost: 'impliedYieldOnCost', implied_condo_margin: 'impliedCondoMargin', best_deal: 'dealVerdict', unused_uap_zfa: 'headroomSqft', unused_far: 'headroomFar'}[sortBy] || null;
    const orderClause = liveRank
      ? ''
      : sortBy === 'far_compression_pct'
            ? 'far_compression_pct DESC NULLS LAST,'
            : sortBy === 'any_use_price_per_buildable_zfa'
              ? 'any_use_price_per_buildable_zfa ASC NULLS LAST,'
              : 'COALESCE(price_per_buildable_sf, uap_price_per_buildable_zfa) ASC NULLS LAST,';
    // A for-sale listing the last full scrape no longer returned has sold or been withdrawn, so it
    // leaves the deals; broker and LoopNet listings refresh on their own passes and are kept.
    const staleBefore = this.forSaleStaleCutoff();

    const where = `
      WHERE bbl IS NOT NULL
        AND (? IS NULL OR id = ?)
        AND (? IS NULL OR listing_type = ?)
        AND (? IS NULL OR borough = ?)
        AND (? IS NULL OR zip_code = ?)
        AND (? IS NULL OR zip_code IN (SELECT value FROM json_each(?)))
        AND (? IS NULL OR lower(neighborhood) LIKE ? ESCAPE '\\' OR lower(city) LIKE ? ESCAPE '\\' OR lower(address) LIKE ? ESCAPE '\\' OR lower(pluto_address) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR zoning_district LIKE ? ESCAPE '\\')
        AND (? IS NULL OR unused_uap_zfa >= ?)
        AND (? IS NULL OR COALESCE(price_per_buildable_sf, uap_price_per_buildable_zfa) <= ? OR ${unpriced})
        AND (? IS NULL OR any_use_price_per_buildable_zfa <= ? OR ${unpriced})
        AND (listing_type != 'for_sale' OR source LIKE 'broker:%' OR source = 'loopnet' OR last_seen_at >= ?)
        AND (? IS NULL OR list_price >= ? OR ${unpriced})
        AND (? IS NULL OR list_price <= ? OR ${unpriced})
        AND (? IS NULL OR pluto_lot_area >= ?)
        AND (? IS NULL OR pluto_lot_area <= ?)
        AND (? IS NULL OR COALESCE(NULLIF(max_uap_zfa, 0), max_standard_zfa) >= ?)
        AND (? IS NULL OR pluto_lot_front >= ?)
        AND (? IS NULL OR pluto_lot_front <= ?)
        AND (? IS NULL OR pluto_lot_depth >= ?)
        AND (? IS NULL OR pluto_lot_depth <= ?)
        ${styleList.length ? `AND style IN (${styleList.map(() => '?').join(', ')})` : ''}
        ${box ? 'AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?' : ''}
        AND (? = 0 OR landmark_flag = 0)
        AND (? IS NULL OR in_mih_area = ?)`;
    const params = [
      listingId ?? null, listingId ?? null,
      listingId ? null : listingType || null, listingId ? null : listingType || null,
      bCode, bCode,
      zipCode || null, zipCode || null,
      areaZips, areaZips,
      areaName, areaName, areaName, areaAddress, areaAddress,
      zPrefix, zPrefix,
      listingId ? null : minUnusedZfa ?? null, listingId ? null : minUnusedZfa ?? null,
      maxPricePerBuildableZfa ?? null, maxPricePerBuildableZfa ?? null,
      maxPricePerBuildableAnyUse ?? null, maxPricePerBuildableAnyUse ?? null,
      staleBefore,
      minListPrice ?? null, minListPrice ?? null,
      maxListPrice ?? null, maxListPrice ?? null,
      minLotArea ?? null, minLotArea ?? null,
      maxLotArea ?? null, maxLotArea ?? null,
      minBuildableZfa ?? null, minBuildableZfa ?? null,
      minLotFront ?? null, minLotFront ?? null,
      maxLotFront ?? null, maxLotFront ?? null,
      minLotDepth ?? null, minLotDepth ?? null,
      maxLotDepth ?? null, maxLotDepth ?? null,
      ...styleList,
      ...(box ? [Number(box.south), Number(box.north), Number(box.west), Number(box.east)] : []),
      excludeLandmarks ? 1 : 0,
      ...Array(2).fill({inside: 1, outside: 0}[mihArea] ?? null),
    ];
    const ordered = `SELECT * FROM market_listings ${where} ORDER BY ${orderClause} id ASC`;
    const baseDealSettings = this.getAdminConfig().dealSettings;
    const activeSettings = customSettings ? normalizeDealSettings(customSettings, baseDealSettings) : baseDealSettings;
    const unitSizes = this.getUnitSizes(), newBuildPremiums = this.getNewBuildPremiums();
    const settingsKey = JSON.stringify(activeSettings);
    // Stabilization risk, live yields and tiers are computed, not stored, so those searches rank every
    // match; the ranking is kept per filter set until the store changes.
    // Project cost (the ask plus the construction cost at this request's costs) is computed too.
    const costRange = minProjectCost != null || maxProjectCost != null;
    const computedRank = Boolean(excludeHighStabilizedRisk || liveRank || pins || verdicts.length || costRange || minHeadroomFar != null);
    const cache = computedRank ? storeCacheFor(this.path) : null;
    const rankKey = computedRank ? JSON.stringify([orderClause, liveRank, excludeHighStabilizedRisk, verdicts, minProjectCost, maxProjectCost, minHeadroomFar, settingsKey, params]) : null;
    let ranked = cache?.ranked.get(rankKey) ?? null;
    const zipRollups = new Map();
    const valuations = ranked?.valuations ?? new Map();
    const valuationOf = r => {
      if (valuations.has(r.id)) return valuations.get(r.id);
      if (r.zip_code && !zipRollups.has(r.zip_code)) zipRollups.set(r.zip_code, this.getZipRollup(r.zip_code));
      const zipRollup = r.zip_code ? zipRollups.get(r.zip_code) : null;
      const val = memoizedDealValuation(r, zipRollup, activeSettings, settingsKey, unitSizes, newBuildPremiums, this.appraisedLandFor(r), this.buildingSalesFor(r));
      valuations.set(r.id, val);
      return val;
    };

    // The offset is clamped to the match count, so a huge or infinite offset is an empty page, never a SQLite error.
    const startAt = total => Math.min(total, Math.max(0, Math.floor(Number(offset)) || 0));
    let total;
    let start;
    let rows;
    // Tiers move with the cost profile too, so a tier filter reads the verdict at this request's costs.
    if (computedRank) {
      if (ranked) {
        cache.ranked.delete(rankKey);
        cache.ranked.set(rankKey, ranked);
      } else {
        // Ranking reads only the columns the computations use; full rows are loaded for the returned page alone.
        let kept = this.query(`SELECT ${COMPUTED_RANK_COLUMNS} FROM market_listings ${where} ORDER BY ${orderClause} id ASC`, ...params);
        if (excludeHighStabilizedRisk) kept = kept.filter(r => rentStabilizationOf(r).riskLevel !== 'high');
        if (verdicts.length) kept = kept.filter(r => verdicts.includes(valuationOf(r).dealVerdict));
        // The headroom FAR filter reads the unused floor area the card prints.
        if (minHeadroomFar != null) kept = kept.filter(r => r.pluto_lot_area > 0 && headroomOf(valuationOf(r)) / r.pluto_lot_area >= minHeadroomFar);
        if (costRange) kept = kept.filter(r => {
          const cost = projectCost(r, valuationOf(r));
          return cost !== null && (minProjectCost == null || cost >= minProjectCost) && (maxProjectCost == null || cost <= maxProjectCost);
        });
        if (liveRank === 'dealVerdict') {
          // Best deals first: the verdict tier, then the lowest price per buildable SF within it. A listing
          // whose price may not buy the lot as matched (a listing data check) ranks after every other, since
          // its price per buildable SF is not a price for that floor area.
          const tier = new Map(kept.map(r => [r.id, VERDICT_ORDER.indexOf(valuationOf(r).dealVerdict)]));
          const toConfirm = new Map(kept.map(r => [r.id, valuationOf(r).gates.some(isListingDataCheck) ? 1 : 0]));
          const rankOf = id => (tier.get(id) < 0 ? VERDICT_ORDER.length : tier.get(id));
          const ppb = r => valuationOf(r).pricePerBuildableSf ?? Infinity;
          kept.sort((a, b) => toConfirm.get(a.id) - toConfirm.get(b.id) || rankOf(a.id) - rankOf(b.id) || ppb(a) - ppb(b));
        } else if (liveRank) {
          const metric = new Map(kept.map(r => {
            const v = valuationOf(r);
            const value = liveRank === 'headroomSqft' ? headroomOf(v) : liveRank === 'headroomFar' ? (r.pluto_lot_area > 0 ? headroomOf(v) / r.pluto_lot_area : null) : v[liveRank];
            return [r.id, Number.isFinite(value) ? value : null];
          }));
          // A stable sort over rows already in id order, so ties keep the id order.
          kept.sort((a, b) => {
            const x = metric.get(a.id), y = metric.get(b.id);
            if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
            return y - x;
          });
        }
        ranked = {kept, valuations, pins: null};
        if (cache) {
          if (cache.ranked.size >= RANKED_CACHE_LIMIT) cache.ranked.delete(cache.ranked.keys().next().value);
          cache.ranked.set(rankKey, ranked);
        }
      }
      const {kept} = ranked;
      if (pins) {
        // Every match with a usable geocode, in rank order, for the map: one array per field, which
        // the map reads with pinRows. Five decimals place a pin within about a metre.
        if (!ranked.pins) {
          // A pin's rank is its card's number: its place in this ranked list, unlocated cards included.
          const located = kept.map((r, i) => ({r, rank: i + 1, ...pinCoordinates(r.latitude, r.longitude)})).filter(p => p.latitude !== null);
          const round = value => Math.round(value * 1e5) / 1e5;
          ranked.pins = {
            total: kept.length,
            locatedTotal: located.length,
            unlocatedTotal: kept.length - located.length,
            pins: {
              id: located.map(({r}) => r.id),
              rank: located.map(({rank}) => rank),
              address: located.map(({r}) => r.address),
              latitude: located.map(({latitude}) => round(latitude)),
              longitude: located.map(({longitude}) => round(longitude)),
              dealVerdict: located.map(({r}) => valuationOf(r).dealVerdict),
              listPrice: located.map(({r}) => r.list_price),
            },
          };
        }
        return ranked.pins;
      }
      total = kept.length;
      start = startAt(total);
      const pageIds = kept.slice(start, start + cappedLimit).map(r => r.id);
      const full = pageIds.length ? this.query(`SELECT * FROM market_listings WHERE id IN (${pageIds.map(() => '?').join(', ')})`, ...pageIds) : [];
      const byId = new Map(full.map(r => [r.id, r]));
      rows = pageIds.map(id => byId.get(id));
    } else {
      total = this.one(`SELECT COUNT(*) AS n FROM market_listings ${where}`, ...params).n;
      start = startAt(total);
      rows = start < total ? this.query(`${ordered} LIMIT ? OFFSET ?`, ...params, cappedLimit, start) : [];
    }

    const results = [];
    const comps = includeSimilarComps ? this.storedListingComps(rows, 5) : null;

    for (const r of rows) {
      const rentStabilization = rentStabilizationOf(r);
      const val = valuationOf(r);

      const similarComps = comps?.get(r) || [];

      results.push({
        id: r.id,
        propertyId: r.property_id,
        bbl: r.bbl,
        address: r.address,
        plutoAddress: r.pluto_address,
        borough: r.borough,
        city: r.city,
        zipCode: r.zip_code,
        neighborhood: r.neighborhood,
        ...pinCoordinates(r.latitude, r.longitude),
        url: r.url,
        photoUrl: r.photo_url,
        listingSource: r.source || 'homeharvest',
        listingSourceName: r.source_name || 'Realtor.com via HomeHarvest',
        listingType: r.listing_type,
        mlsStatus: r.mls_status,
        style: r.style,
        zoningDistrict: r.zoning_district,
        overlay: r.overlay1,
        specialDistrict: r.special_district,
        lotAreaSqft: r.pluto_lot_area,
        lotFrontFeet: r.pluto_lot_front,
        lotDepthFeet: r.pluto_lot_depth,
        existingBldgAreaSqft: r.pluto_bldg_area,
        builtFar: r.pluto_built_far,
        residFar: r.resid_far,
        affResFar: r.aff_res_far,
        commFar: r.comm_far,
        facilFar: r.facil_far,
        mnfFar: r.mnf_far,
        maxStandardZfa: val.maxStandardZfa,
        maxUapZfa: val.maxUapZfa,
        standardFar: val.standardFar,
        uapFar: val.uapFar,
        maxAnyUseZfa: val.maxAnyUseZfa,
        anyUseFar: val.anyUseFar,
        anyUsePricePerBuildableZfa: val.anyUsePricePerBuildableZfa,
        achievableStandardZfa: val.achievableStandardZfa,
        achievableUapZfa: val.achievableUapZfa,
        buildableZfa: val.buildableZfa,
        grossBuildableSqft: val.grossBuildableSqft,
        maxBuildableUnits: val.maxBuildableUnits,
        plannedUnits: val.plannedUnits,
        plannedUnitBasis: val.plannedUnitBasis,
        unusedStandardZfa: val.unusedStandardZfa,
        unusedUapZfa: val.unusedUapZfa,
        unusedForLeadZfa: val.unusedForLeadZfa,
        listPrice: r.list_price,
        avmAvailable: Boolean(r.avm_available),
        existingPricePerSqft: val.existingPricePerSqft,
        pricePerBuildableZfa: val.pricePerBuildableZfa,
        uapPricePerBuildableZfa: val.uapPricePerBuildableZfa,
        pricePerBuildableSf: val.pricePerBuildableSf,
        pricePerBuildableUnit: val.pricePerBuildableUnit,
        farCompressionPct: val.farCompressionPct,
        landmarkFlag: Boolean(r.landmark_flag),
        floodZone: r.flood_zone === null || r.flood_zone === undefined ? null : Boolean(r.flood_zone),
        rentStabilizedUnits: r.rent_stabilized_units ?? null,
        rentStabilizedYear: r.rent_stabilized_year ?? null,
        inMihArea: r.in_mih_area === null || r.in_mih_area === undefined ? null : Boolean(r.in_mih_area),
        existingUnitsRes: r.units_res,
        existingUnitsTotal: r.units_total,
        yearBuilt: r.year_built,
        ownerName: r.owner_name,
        buildingClass: r.bldg_class,
        daysOnMls: r.days_on_mls,
        listDate: r.list_date,
        priceHistory: JSON.parse(r.price_history_json || '[]'),
        corridorProfile: val.corridorProfile,
        rentStabilization,
        similarComps,
        estimatedConstructionCost: val.constructionCost,
        flashcardValuation: {
          submarketTierLabel: val.submarketTierLabel,
          submarketSalePsf: val.submarketSalePsf,
          submarketRentPsfMonth: val.submarketRentPsf,
          estimatedRedevValue: val.estimatedRedevValue,
          estimatedStabilizedValue: val.estimatedStabilizedValue,
          estimatedCondoSellout: val.estimatedCondoSellout,
          completedValueExit: val.completedValueExit,
          estimatedConstructionCost: val.constructionCost,
          slidingScalePricePerBsf: {
            greatDealMaxBsf: val.greatDealMaxBsf,
            goodDealMaxBsf: val.goodDealMaxBsf,
            badDealMinBsf: val.badDealMinBsf,
            greatDealMaxLandValue: val.greatDealMaxLandValue,
            goodDealMaxLandValue: val.goodDealMaxLandValue,
            badDealMinLandValue: val.badDealMinLandValue,
          },
          thresholdBasis: val.thresholdBasis,
          envelopeBasis: val.physicalEnvelope.envelopeBasis,
          affordableBonusNote: val.affordableBonusNote,
          impliedYieldOnCostPct: val.impliedYieldOnCost,
          impliedCondoMarginPct: val.impliedCondoMargin,
          dealVerdict: val.dealVerdict,
          priceVerdict: val.priceVerdict,
          dealTierBasis: val.dealTierBasis,
          gates: val.gates,
          mih: val.mih,
          valueDriver: val.valueDriver,
          acquisition: val.acquisition,
          affordableRentPsfMonth: val.affordableRentPsf,
          corridorProfile: val.corridorProfile,
          basis: val.basis,
          nearbyLand: val.nearbyLand,
          subsidizedRental: val.subsidizedRental,
        },
      });
    }

    return {deals: results, total, offset: start, limit: cappedLimit};
  }

  async syncMarket({
    locations = null,
    listingTypes = null,
    propertyTypes = undefined,
    limitPerType = null,
    updatedInPastHours = undefined,
    pastDays = null,
    enrichPluto = null,
    fullForSalePull = null,
    bridgeRunner = defaultHomeHarvestBridgeRunner,
    plutoFetcher = defaultPlutoBatchFetcher,
    geosearchFetcher = defaultGeosearchBbl,
    hpdRegistrationFetcher = defaultHpdRegistrationBatchFetcher,
    rentStabilizedFetcher = defaultRentStabilizedFetcher,
  } = {}) {
    const {syncConfig, dealSettings} = this.getAdminConfig();
    const effLocations = Array.isArray(locations) && locations.length ? locations : syncConfig.locations;
    const effListingTypes = Array.isArray(listingTypes) && listingTypes.length ? listingTypes : syncConfig.listingTypes;
    const effPropertyTypes = propertyTypes !== undefined ? propertyTypes : syncConfig.propertyTypes;
    const effLimit = limitPerType != null ? Number(limitPerType) : syncConfig.limitPerType;
    const effUpdatedHours = updatedInPastHours !== undefined ? updatedInPastHours : syncConfig.updatedInPastHours;
    const effPastDays = pastDays != null ? Number(pastDays) : syncConfig.pastDays;
    const effEnrichPluto = enrichPluto != null ? Boolean(enrichPluto) : Boolean(syncConfig.enrichPluto);
    const effFullPull = (fullForSalePull != null ? Boolean(fullForSalePull) : syncConfig.fullForSalePull !== false) && effListingTypes.includes('for_sale');

    const runId = randomUUID();
    throwIfCancelled();
    const startedAt = Date.now();
    this.write(
      'INSERT INTO market_sync_runs (id, started_at, status, locations_json) VALUES (?, ?, ?, ?)',
      runId, startedAt, 'running', JSON.stringify(effLocations)
    );

    try {
      // One bridge call per location, so each borough gets its full limit per listing type and a
      // long run never truncates the locations listed last. A location that fails is reported in
      // errors and the others are still ingested.
      const rows = [];
      const errors = {};
      const fullPullCounts = {};
      for (const location of effLocations) {
        throwIfCancelled();
        const raw = await bridgeRunner({
          locations: [location],
          listingTypes: effListingTypes,
          ...(effPropertyTypes ? {propertyTypes: effPropertyTypes} : {}),
          limit: effLimit,
          pastDays: effPastDays,
          ...(effUpdatedHours ? {updatedInPastHours: effUpdatedHours} : {}),
          includeAllRows: true,
          extraPropertyData: false,
        }).catch(err => ({error: err.message}));
        throwIfCancelled();
        if (raw?.error) {
          errors[location] = raw.error;
          continue;
        }
        rows.push(...(raw.allRows || raw.sampleComps || []));
        Object.assign(errors, raw.errors || {});
        if (!effFullPull) continue;
        // Every whole lot for sale in the location, which the capped mixed pull above cannot reach.
        const full = await bridgeRunner({
          locations: [location],
          listingTypes: ['for_sale'],
          propertyTypes: WHOLE_LOT_PROPERTY_TYPES,
          limit: FULL_PULL_LIMIT,
          pastDays: effPastDays,
          ...(effUpdatedHours ? {updatedInPastHours: effUpdatedHours} : {}),
          includeAllRows: true,
          extraPropertyData: false,
          timeoutMs: FULL_PULL_TIMEOUT_MS,
        }).catch(err => ({error: err.message}));
        throwIfCancelled();
        if (full?.error) { errors[`${location}:whole_lots_for_sale`] = full.error; continue; }
        fullPullCounts[location] = (full.allRows || []).length;
        rows.push(...(full.allRows || []));
        Object.assign(errors, full.errors || {});
      }
      if (effLocations.every(location => errors[location])) throw new Error(errors[effLocations[0]]);
      // A whole lot the capped pull also returned is one listing, counted once.
      const unique = new Map(rows.map(r => [MarketStore.listingKey(r), r]));
      const ingested = this.ingestListings([...unique.values()], Date.now());
      let plutoResult = {matched: 0, scanned: 0};
      let hpdRegistrations = null;
      let rentStabilized = null;
      if (effEnrichPluto) {
        plutoResult = await this.enrichNycListingsWithPluto({
          plutoFetcher,
          geosearchFetcher,
          limit: Math.max(1000, unique.size),
          settings: dealSettings,
        });
        // Every matched lot, this run's or an earlier one's, gets its HPD registration dates for the tenant screen.
        hpdRegistrations = await this.backfillHpdRegistrations({hpdRegistrationFetcher, settings: dealSettings});
        // A failed download of the rent-stabilized counts keeps the stored copy and never fails the sync.
        try { rentStabilized = await this.backfillRentStabilizedUnits({fetcher: rentStabilizedFetcher, settings: dealSettings}); }
        catch (error) { throwIfCancelled(); rentStabilized = {error: error.message}; }
      }

      // The cutoff is the one this run sets for the read-time filter once it is recorded as completed.
      // An incremental run returns only listings updated in its window, so it never sweeps.
      const complete = NYC_BOROUGH_LOCATIONS.every(location => effLocations.includes(location)) && effFullPull && !effUpdatedHours && !Object.keys(errors).length;
      const staleSweep = complete ? this.sweepStaleForSale(startedAt - FOR_SALE_STALE_GRACE_MS) : null;
      const finishedAt = Date.now();
      throwIfCancelled();
      const summary = {
        ...(staleSweep ? {staleForSaleSwept: staleSweep.swept} : {}),
        runId,
        locations: effLocations,
        listingTypes: effListingTypes,
        ...(effUpdatedHours ? {updatedInPastHours: effUpdatedHours} : {}),
        fetchedCount: unique.size,
        ...(effFullPull ? {wholeLotsForSaleFetched: fullPullCounts} : {}),
        insertedCount: ingested.inserted,
        updatedCount: ingested.updated,
        plutoMatchedCount: plutoResult.matched,
        plutoMatchedByAddress: plutoResult.geosearched ?? 0,
        ...(hpdRegistrations ? {hpdRegistrations} : {}),
        ...(rentStabilized ? {rentStabilized} : {}),
        rollupsUpdated: ingested.rollupsUpdated,
        durationMs: finishedAt - startedAt,
        errors,
      };
      this.write(`
        UPDATE market_sync_runs SET
          finished_at = ?,
          status = 'completed',
          fetched_count = ?,
          inserted_count = ?,
          updated_count = ?,
          pluto_matched_count = ?,
          rollups_updated = ?,
          summary_json = ?
        WHERE id = ?
      `,
        finishedAt,
        rows.length,
        ingested.inserted,
        ingested.updated,
        plutoResult.matched,
        ingested.rollupsUpdated,
        JSON.stringify(summary),
        runId
      );
      return summary;
    } catch (err) {
      const finishedAt = Date.now();
      this.write(`
        UPDATE market_sync_runs SET
          finished_at = ?,
          status = 'failed',
          summary_json = ?
        WHERE id = ?
      `, finishedAt, JSON.stringify({error: err.message}), runId);
      throw err;
    }
  }

  // Aggregate totals for the public site. City closed sales are comps, not screened listings.
  publicCounts() {
    return this.one('SELECT COUNT(*) AS listingsScreened, COUNT(DISTINCT bbl) AS lotsMatched FROM market_listings WHERE source IS NOT ?', CITY_CLOSED_SALES_SOURCE);
  }

  statusSummary() {
    const cache = storeCacheFor(this.path);
    if (cache?.status) return cache.status;
    const totals = this.one(`
      SELECT
        SUM(CASE WHEN source IS NOT ? THEN 1 ELSE 0 END) AS totalListings,
        SUM(CASE WHEN listing_type = 'for_sale' THEN 1 ELSE 0 END) AS activeForSale,
        SUM(CASE WHEN listing_type = 'sold' AND source IS NOT ? THEN 1 ELSE 0 END) AS closedSold,
        SUM(CASE WHEN source IS ? THEN 1 ELSE 0 END) AS cityClosedSales,
        SUM(CASE WHEN listing_type = 'for_rent' THEN 1 ELSE 0 END) AS activeRentals,
        SUM(CASE WHEN bbl IS NOT NULL THEN 1 ELSE 0 END) AS plutoMatchedParcels,
        SUM(CASE WHEN deal_verdict IN ('great_deal', 'good_deal') THEN 1 ELSE 0 END) AS highPotentialDeals,
        MAX(last_seen_at) AS lastIngestedAt
      FROM market_listings
    `, CITY_CLOSED_SALES_SOURCE, CITY_CLOSED_SALES_SOURCE, CITY_CLOSED_SALES_SOURCE);
    const rollupsCount = this.one('SELECT COUNT(*) AS count FROM market_submarket_rollups')?.count || 0;
    const recentSyncs = this.query('SELECT * FROM market_sync_runs ORDER BY started_at DESC LIMIT 8').map(r => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      locations: JSON.parse(r.locations_json || '[]'),
      fetchedCount: r.fetched_count,
      insertedCount: r.inserted_count,
      updatedCount: r.updated_count,
      plutoMatchedCount: r.pluto_matched_count,
      rollupsUpdated: r.rollups_updated,
    }));
    const summary = {
      totalListings: Number(totals?.totalListings || 0),
      activeForSale: Number(totals?.activeForSale || 0),
      closedSold: Number(totals?.closedSold || 0),
      cityClosedSales: Number(totals?.cityClosedSales || 0),
      activeRentals: Number(totals?.activeRentals || 0),
      plutoMatchedParcels: Number(totals?.plutoMatchedParcels || 0),
      highPotentialDeals: Number(totals?.highPotentialDeals || 0),
      submarketRollups: Number(rollupsCount),
      lastIngestedAt: totals?.lastIngestedAt ? new Date(Number(totals.lastIngestedAt)).toISOString() : null,
      recentSyncs,
      adminConfig: this.getAdminConfig(),
    };
    if (cache) cache.status = summary;
    return summary;
  }
}

// Values every for-sale listing at the store's own costs and ranks the listings page's default search,
// so the first deal search after a restart, a store write or a new day reads cached results instead of
// computing them inside a request. When nothing has changed every call here is a cache hit.
export function warmDealValuations(store = openMarketStore({readOnly: true})) {
  if (!store) return;
  try {
    store.searchDealsPage({minUnusedZfa: 0, sortBy: 'best_deal', pins: true});
    store.searchDealsPage({...listingSearchFilters(defaultFilterValues()), pins: true});
    store.statusSummary();
  } finally { store.close(); }
}

export function openMarketStore({readOnly = false} = {}) {
  const path = marketDbPath();
  if (readOnly && !existsSync(path)) return null;
  try {
    return new MarketStore(path, {readOnly});
  } catch {
    return null;
  }
}
