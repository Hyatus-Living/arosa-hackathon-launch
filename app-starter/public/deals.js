import {publicErrorMessage} from './chat-api.js';
import { finite, headroomFar, headroomSqft, dealPin, nycMapPoint } from './core-model.js';
import { skel } from './skeleton.js';

let content = null;
let notice = null;
let onUnderwrite = () => {};
let screenGeneration = 0;
let profilePending = false;
const COMP_CAPACITY_LABELS = {
  uap_zfa: 'UAP ZFA estimate',
  standard_zfa: 'Standard ZFA estimate',
  lot_residential_far: 'Lot × residential FAR estimate',
};
const COMP_PRICE_LABELS = {asking_price: 'ASKING PRICE', reported_sale: 'REPORTED SALE'};

function comparableDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value.trim())) return null;
  const day = value.trim().slice(0, 10), date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

export function comparableReview(comp) {
  const expectedPriceBasis = comp.listingType === 'sold' ? 'reported_sale' : comp.listingType === 'for_sale' ? 'asking_price' : null;
  const hasPrice = expectedPriceBasis !== null && comp.priceBasis === expectedPriceBasis && finite(comp.price) && Number(comp.price) > 0;
  const capacityLabel = Object.hasOwn(COMP_CAPACITY_LABELS, comp.buildableZfaBasis) ? COMP_CAPACITY_LABELS[comp.buildableZfaBasis] : null;
  const hasCapacity = Boolean(capacityLabel) && finite(comp.buildableZfa) && Number(comp.buildableZfa) > 0;
  const date = hasPrice ? comparableDate(comp.priceBasis === 'reported_sale' ? comp.soldDate : comp.listingDate) : null;
  return {hasPrice, capacityLabel, hasCapacity, date};
}
const TENANT_VERIFICATION_LINKS = [
  {label: 'HCR rent regulation guidance', url: 'https://hcr.ny.gov/rent-stabilization-and-emergency-tenant-protection-act'},
  {label: 'HPD CONH criteria', url: 'https://www.nyc.gov/site/hpd/services-and-information/certification-of-no-harassment-conh.page'},
];

export function tenantReview(profile) {
  if (profile?.assessment === 'screening') return profile;
  return {
    riskLevel: 'unknown',
    badgeLabel: 'Tenant review: unassessed',
    summary: 'Tenant occupancy, rent regulation and delivery terms have not been verified.',
    verificationLinks: TENANT_VERIFICATION_LINKS,
  };
}

let currentState = {
  deals: [],
  selectedDealId: null,
  userSettings: {isCustom: false, dealSettings: {}, baselineSettings: {}},
  storeStatus: null,
  // How many listings the store matched and how many are loaded, plus the exact query (filters, sort and cost inputs)
  // the list on screen came from, so a further page extends that list and never one built from newer settings.
  total: 0,
  loaded: 0,
  listQuery: null,
  listCosts: {},
  appliedCosts: {},
  costDraft: null,
  costDraftVersion: 0,
  filters: {
    borough: '',
    zipCode: '',
    dealVerdict: '',
    sortBy: 'unused_uap_zfa',
    excludeHighStabilizedRisk: false,
  },
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

export function fmtCurrency(n) {
  if (!finite(n)) return '–';
  const val = Number(n);
  if (Math.abs(val) >= 1_000_000) {
    return `$${(val / 1_000_000).toFixed(2)}M`;
  }
  return `$${Math.round(val).toLocaleString()}`;
}

export function fmtInt(n) {
  if (!finite(n)) return '–';
  return Math.round(Number(n)).toLocaleString();
}

export function fmtPct(n, digits = 1) {
  if (!finite(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

export function verdictMeta(verdict) {
  switch (verdict) {
    case 'great_deal':
      return {label: 'Great Deal', cls: 'verdict-great'};
    case 'good_deal':
      return {label: 'Good Deal', cls: 'verdict-good'};
    case 'unpriced_opportunity':
      return {label: 'Unpriced · Residual', cls: 'verdict-unpriced'};
    case 'fair_deal':
      return {label: 'Fair Deal', cls: 'verdict-fair'};
    case 'full_price':
      return {label: 'Full Price', cls: 'verdict-bad'};
    case 'unmatched_parcel':
      // The listing has an ask, but no parcel was matched to it, so its price per buildable SF is unknown.
      return {label: 'Not matched to a parcel', cls: 'verdict-unpriced'};
    default:
      // A verdict the store does not define never shows its raw identifier.
      return {label: 'Not rated', cls: 'verdict-unpriced', unrated: true};
  }
}

// The rankings the deal store supports, shared by the listing screen and the home feed.
export const DEAL_SORTS = [
  ['unused_uap_zfa', 'Most unused floor area'],
  ['unused_far', 'Most FAR headroom'],
  ['uap_price_per_buildable_zfa', 'Lowest UAP $/BSF'],
  ['any_use_price_per_buildable_zfa', 'Lowest $/BSF at any use'],
  ['implied_yield_on_cost', 'Highest Implied Yield on Cost'],
  ['implied_condo_margin', 'Highest Condo Margin'],
];

function pctLabel(n) {
  return finite(n) ? `${Number((Number(n) * 100).toFixed(2))}%` : '–';
}

// Verdict thresholds come from the deal settings that produced the verdicts (admin baseline or the
// user's saved overrides), so labels never drift from the store's configuration.
export function verdictThresholds(ds = {}) {
  return {
    // With five or more nearby development-site sales a tier is the ask against what they sold for (the
    // store's NEARBY_PRICE_TIERS); otherwise the returns at the reader's costs.
    great: `ask ≤70% of nearby land sales, or ≥${pctLabel(ds.greatDealCapRate)} yield or ≥${pctLabel(ds.greatDealCondoMargin)} margin without them`,
    good: `ask ≤85% of nearby land sales, or ≥${pctLabel(ds.goodDealCapRate)} yield or ≥${pctLabel(ds.goodDealCondoMargin)} margin without them`,
    fair: `ask ≤100% of nearby land sales, or ≥${pctLabel(ds.badDealCapRate)} yield or ≥${pctLabel(ds.badDealCondoMargin)} margin without them`,
    full: `ask above nearby land sales, or <${pctLabel(ds.badDealCapRate)} yield and <${pctLabel(ds.badDealCondoMargin)} margin without them`,
  };
}

const BASIS_LABELS = {
  submarketSalePsf: 'Submarket sale $/SF',
  submarketRentPsfMonth: 'Submarket rent $/SF/mo',
  retailRentPsfYear: 'Retail rent $/SF/yr',
  zfaGrossDeductions: 'ZFA-to-gross deductions',
  hardCostPerGrossSqft: 'Hard cost $/GSF',
  rentalHardCostPerGrossSqft: 'Rental hard cost $/GSF',
  condoHardCostPerGrossSqft: 'Condo hard cost $/GSF',
  softCostPctOfHard: 'Soft cost (share of hard)',
  carryAndFinancingPct: 'Carry & financing',
  zfaToGrossFactor: 'ZFA-to-gross factor',
  zfaToNetEfficiency: 'Net efficiency',
  operatingExpenseRatio: 'Operating expense ratio',
  greatDealCapRate: 'Great deal yield',
  goodDealCapRate: 'Good deal yield',
  badDealCapRate: 'Full price yield',
  greatDealCondoMargin: 'Great deal condo margin',
  goodDealCondoMargin: 'Good deal condo margin',
  badDealCondoMargin: 'Full price condo margin',
};

function renderBasis(basis = []) {
  const box = el('details', undefined, 'deals-detail-box deals-basis');
  box.append(el('summary', 'Basis for these figures'));
  const list = el('ul', undefined, 'deals-basis-list');
  for (const b of basis) {
    const value = b.value !== undefined ? ` ${b.value}` : '';
    const asOf = b.asOf ? ` (as of ${b.asOf})` : '';
    list.append(el('li', `${BASIS_LABELS[b.item] || b.item}${value}: ${b.source}${asOf}`));
  }
  box.append(list);
  return box;
}

export function normalizeDealRow(d = {}) {
  const fv = d.flashcardValuation || {};
  const ss = d.slidingScale || fv.slidingScalePricePerBsf || {};
  return {
    ...d,
    listing_id: d.listing_id || d.id || d.propertyId,
    zip_code: d.zip_code || d.zipCode || '',
    zoning_district_1: d.zoning_district_1 || d.zoningDistrict || '',
    lot_area_sqft: d.lot_area_sqft ?? d.lotAreaSqft ?? null,
    building_sqft: d.building_sqft ?? d.existingBldgAreaSqft ?? null,
    built_far: d.built_far ?? d.builtFar ?? null,
    resid_far: d.resid_far ?? d.residFar ?? null,
    uap_far: d.uap_far ?? d.affResFar ?? null,
    // The FARs that produced the two envelopes: the residential FAR, then the affordable bonus.
    standard_far: d.standard_far ?? d.standardFar ?? null,
    bonus_far: d.bonus_far ?? d.uapFar ?? null,
    max_buildable_zfa: d.max_buildable_zfa ?? d.maxStandardZfa ?? null,
    unused_residential_zfa: d.unused_residential_zfa ?? d.unusedStandardZfa ?? null,
    uap_max_buildable_zfa: d.uap_max_buildable_zfa ?? d.maxUapZfa ?? null,
    uap_unused_zfa: d.uap_unused_zfa ?? d.unusedUapZfa ?? null,
    unused_for_lead_zfa: d.unused_for_lead_zfa ?? d.unusedForLeadZfa ?? null,
    estimated_gross_buildable_sqft: d.estimated_gross_buildable_sqft ?? d.grossBuildableSqft ?? null,
    list_price: d.list_price ?? d.listPrice ?? null,
    price_per_existing_sqft: d.price_per_existing_sqft ?? d.existingPricePerSqft ?? null,
    price_per_buildable_zfa: d.price_per_buildable_zfa ?? d.pricePerBuildableZfa ?? null,
    uap_price_per_buildable_zfa: d.uap_price_per_buildable_zfa ?? d.uapPricePerBuildableZfa ?? null,
    any_use_price_per_buildable_zfa: d.any_use_price_per_buildable_zfa ?? d.anyUsePricePerBuildableZfa ?? null,
    max_any_use_zfa: d.max_any_use_zfa ?? d.maxAnyUseZfa ?? null,
    any_use_far: d.any_use_far ?? d.anyUseFar ?? null,
    price_per_buildable_sf: d.price_per_buildable_sf ?? d.pricePerBuildableSf ?? null,
    buildable_zfa: d.buildable_zfa ?? d.buildableZfa ?? null,
    estimated_construction_cost: d.estimated_construction_cost ?? d.estimatedConstructionCost ?? fv.estimatedConstructionCost ?? null,
    // The completed building as a rental and as condominiums; the store sends each on its own basis.
    estimated_stabilized_value: d.estimated_stabilized_value ?? fv.estimatedStabilizedValue ?? null,
    estimated_condo_sellout: d.estimated_condo_sellout ?? fv.estimatedCondoSellout ?? null,
    implied_cap_rate: d.implied_cap_rate ?? (finite(fv.impliedYieldOnCostPct) ? fv.impliedYieldOnCostPct / 100 : null),
    implied_condo_margin: d.implied_condo_margin ?? (finite(fv.impliedCondoMarginPct) ? fv.impliedCondoMarginPct / 100 : null),
    deal_verdict: d.deal_verdict || fv.dealVerdict || null,
    slidingScale: {
      greatDealMaxPricePerBsf: ss.greatDealMaxPricePerBsf ?? ss.greatDealMaxBsf ?? null,
      goodDealMaxPricePerBsf: ss.goodDealMaxPricePerBsf ?? ss.goodDealMaxBsf ?? null,
      badDealMinPricePerBsf: ss.badDealMinPricePerBsf ?? ss.badDealMinBsf ?? null,
      greatDealMaxLandValue: ss.greatDealMaxLandValue ?? null,
      goodDealMaxLandValue: ss.goodDealMaxLandValue ?? null,
      badDealMinLandValue: ss.badDealMinLandValue ?? null,
    },
  };
}

// Price per buildable SF on the floor area the tier is judged on: the program that sets the site's value,
// as the envelope can hold it. Rows valued before that basis fall back to the bonus, then as of right.
export const verdictPricePerBsf = (deal) => deal.price_per_buildable_sf ?? deal.uap_price_per_buildable_zfa ?? deal.price_per_buildable_zfa ?? null;

// How the store's value driver reads: the exit, then the program, then any 485-x election and unit cap or city financing.
export function valueDriverLabel(driver) {
  if (!driver) return null;
  const exit = driver.exit === 'rental' ? 'Rental' : 'Condo sales';
  const tax = driver.cityFinancing ? ', city-financed and all affordable' : driver.taxProgram ? `, 485-x Option ${driver.taxProgram.option}${driver.unitCap ? ` capped at ${driver.unitCap} units` : ''}` : '';
  if (driver.program === 'uap') return `${exit} with the affordability bonus${tax}`;
  if (driver.program === 'mih_exempt') return `${exit} under the MIH small-project exemption${tax}`;
  if (/^option\d$/.test(driver.program)) return `${exit} with MIH Option ${driver.program.slice(6)}${tax}`;
  return `${exit} on the standard envelope${tax}`;
}

// A short MIH tag for a listing inside a mapped area: the option that priced it, or null outside one.
export function mihBadge(deal) {
  const mih = deal.flashcardValuation?.mih;
  if (mih?.status !== 'inside') return null;
  return {text: mih.appliedOption ? `MIH · ${mih.appliedOption}` : 'MIH area', title: [`Mandatory Inclusionary Housing area: ${mih.area}`, mih.note].filter(Boolean).join('. ')};
}

// A short 485-x tag for a rental priced under the exemption: the unit cap when it held the building to
// 99 units, otherwise the option; null when the value does not rest on 485-x.
export function taxBadge(deal) {
  const driver = deal.flashcardValuation?.valueDriver;
  const t = driver?.taxProgram;
  if (!t) return null;
  const cap = driver.unitCap ? `, held to ${driver.unitCap} units (the envelope holds ${fmtInt(driver.uncappedUnits)})` : '';
  return {
    text: driver.unitCap ? `485-x · ${driver.unitCap} units` : `485-x · Option ${t.option}`,
    title: `Priced as a rental under 485-x Option ${t.option}, ${t.label}: ${Math.round(t.restrictedShare * 100)}% of units at ${t.amiPct}% AMI, a ${t.benefitYears}-year tax exemption${t.wageFloorHourly ? `, construction wages at least $${t.wageFloorHourly.toFixed(2)} an hour` : ', no construction wage floor'}${cap}.`,
  };
}

// The dwelling unit factor (ZR 23-52): the zoning caps units at one per 680 SF of residential floor area.
export const DWELLING_UNIT_FACTOR = 680;

// Two unit counts: the most units the zoning allows (a cap from the dwelling unit factor, not a unit size)
// and the units planned at a typical size for the rental or condo exit that sets the value. count is the
// planned figure when the store gives one.
export function unitEstimate(deal) {
  const area = deal.uap_max_buildable_zfa;
  const max = finite(deal.maxBuildableUnits) && Number(deal.maxBuildableUnits) >= 0
    ? Number(deal.maxBuildableUnits)
    : finite(area) && Number(area) > 0 ? Math.floor(Number(area) / DWELLING_UNIT_FACTOR) : null;
  const planned = finite(deal.plannedUnits) && Number(deal.plannedUnits) >= 0 ? Number(deal.plannedUnits) : null;
  const count = planned ?? max;
  const cap = deal.flashcardValuation?.valueDriver?.unitCap;
  const label = planned !== null && max !== null ? `${fmtInt(planned)} planned units (${cap ? `capped at ${fmtInt(cap)} for 485-x; ` : ''}most allowed ${fmtInt(max)})`
    : max !== null ? `${fmtInt(max)} most units allowed`
      : 'Unit capacity not assessed';
  return {count, max, planned, label};
}

export function listingLink(deal) {
  if (!deal.url) return null;
  let url;
  try { url = new URL(deal.url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  // An off-market row's page is a source record, not a listing a reader can act on.
  const offMarket = deal.listingType === 'off_market' || deal.mlsStatus === 'off_market';
  const label = offMarket ? 'View source' : 'View listing';
  const link = el('a', label, 'deal-listing-link');
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${label} for ${deal.address || `BBL ${deal.bbl}`}${offMarket ? ' (off market)' : ''}`);
  return link;
}

// Modeling starts from a listing address and recorded dimensions, without underwriting.
// The lot and program the listing already knows travel with it, so the draft starts from them. The
// message shows in the chat as the reader's own words, so it stays short enough to read there.
export function buildDealPlanPrompt(rawDeal) {
  const deal = normalizeDealRow(rawDeal);
  const bbl = deal.bbl ? ` (BBL ${deal.bbl})` : '';
  const page = deal.url ? ` Listing: ${deal.url}` : '';
  const dimensions = finite(deal.lotFrontFeet) && finite(deal.lotDepthFeet) ? ` (${fmtInt(deal.lotFrontFeet)} by ${fmtInt(deal.lotDepthFeet)} ft)` : '';
  const buildable = deal.buildable_zfa ?? deal.uap_max_buildable_zfa ?? deal.max_buildable_zfa;
  const units = unitEstimate(deal);
  const known = [
    finite(deal.lot_area_sqft) ? `lot ${fmtInt(deal.lot_area_sqft)} SF${dimensions}` : null,
    deal.zoning_district_1 || null,
    finite(buildable) ? `${fmtInt(buildable)} SF buildable` : null,
    units.count !== null ? units.label : null,
  ].filter(Boolean);
  const facts = known.length ? ` On record: ${known.join(', ')}.` : '';
  return `Model ${deal.address || 'this listing'}${bbl}: draft a floor plan from a published drawing or recorded dimensions, then a 3D walkthrough.${facts} State the drawing and assumptions. Skip underwriting.${page}`;
}

// The underwriting a listing starts when the buyer means to keep the building: the parcel and its records,
// then what holding it, renovating and renting it, and renovating and selling it pay against the ask.
export function buildDealKeepPrompt(rawDeal) {
  const deal = normalizeDealRow(rawDeal);
  const bbl = deal.bbl ? ` (BBL ${deal.bbl})` : '';
  const ask = deal.list_price ? `the $${Number(deal.list_price).toLocaleString('en-US')} asking price` : 'a price I give you (the listing is unpriced, so ask me for one)';
  const building = finite(deal.building_sqft) && Number(deal.building_sqft) > 0 ? ` On record: a ${fmtInt(deal.building_sqft)} SF building.` : '';
  const page = deal.url ? ` Listing: ${deal.url}` : '';
  return `Underwrite keeping ${deal.address || 'this listing'}${bbl} as it stands: I am buying to keep the building, not to build new.${building} Confirm the parcel and read its public records (owner, violations, filings, certificate of occupancy, rent registrations). Then price holding it as is, renovating and renting it, and renovating and selling it at ${ask} with acres_keep_building, using the listing's rent roll or comparable rents for its condition, comparable sales of standing and renovated buildings like it, the city tax bill, and a renovation scope that covers the open violations. Find the listing's floor plans if it has them. Skip the zoning envelope and the development pro forma unless they change the answer.${page}`;
}

export function buildDealUnderwritePrompt(rawDeal, dealSettings = {}) {
  const deal = normalizeDealRow(rawDeal);
  const addr = deal.address || 'Subject Parcel';
  const boro = deal.borough || 'NYC';
  const bbl = deal.bbl ? ` (BBL ${deal.bbl})` : '';
  const zoning = deal.zoning_district_1 || 'zoning district not verified';
  const lotArea = fmtInt(deal.lot_area_sqft);
  const existingSf = fmtInt(deal.building_sqft);
  const stdZfa = fmtInt(deal.max_buildable_zfa);
  const uapZfa = fmtInt(deal.uap_max_buildable_zfa);
  const grossSf = fmtInt(deal.estimated_gross_buildable_sqft);
  const units = unitEstimate(deal);
  const askStr = deal.list_price
    ? `listed at $${Number(deal.list_price).toLocaleString()} ($${verdictPricePerBsf(deal) || '–'} per buildable SF the envelope holds, $${fmtInt(deal.pricePerBuildableUnit)}/planned unit)`
    : `currently unpriced / call-for-offers (estimated land residual ${fmtCurrency(deal.slidingScale?.goodDealMaxLandValue)} at a Good Deal threshold)`;
  const hardCost = dealSettings.rentalHardCostPerGrossSqft || dealSettings.hardCostPerGrossSqft || 375;
  const condoHardCost = dealSettings.condoHardCostPerGrossSqft || hardCost;
  const hardCostText = condoHardCost !== hardCost ? `$${hardCost}/GSF rental hard cost, $${condoHardCost}/GSF condo hard cost` : `$${hardCost}/GSF hard cost`;
  const softPct = Number(((dealSettings.softCostPctOfHard ?? 0.22) * 100).toFixed(1));
  const carryPct = Number(((dealSettings.carryAndFinancingPct ?? 0.10) * 100).toFixed(1));
  const grossFactor = dealSettings.zfaToGrossFactor || 1.15;
  const corridorNote = deal.corridorProfile?.hasRetailUplift
    ? ` Include ground-floor retail uplift (${deal.corridorProfile.corridorLabel}, ~${fmtInt(deal.corridorProfile.groundFloorRetailSqft)} SF retail at $${deal.corridorProfile.retailRentPsfYear}/PSF/yr).`
    : '';
  const rsNote = ` Address tenant screening (${tenantReview(deal.rentStabilization).badgeLabel}). Verify rent regulation, occupancy/vacant delivery and HPD CONH applicability.`;

  return `Underwrite ${addr}, ${boro}${bbl} in ${zoning} (${lotArea} SF lot, ${existingSf} SF existing building), ${askStr}. Compare Standard As-of-Right (${stdZfa} ZFA) vs. NYC City of Yes UAP Bonus (${uapZfa} ZFA / ~${grossSf} gross SF at ${grossFactor}x gross-up; ${units.label}) using my developer cost baseline (${hardCostText}, ${softPct}% soft cost, ${carryPct}% carry).${corridorNote}${rsNote} Provide a full residual land valuation, development pro-forma, and sensitivity table.`;
}

export async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch('/api' + path, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
      ...options,
    });
  } catch (err) {
    // fetch rejects only when the request never completes: a timeout or a lost connection.
    throw new Error(err.name === 'TimeoutError' || err.name === 'AbortError'
      ? 'The market store took too long to answer. Try again.'
      : 'Could not reach the market store. Check your connection and try again.');
  }
  if(response.status>=500&&!response.headers.get('content-type')?.includes('application/json'))throw new Error(publicErrorMessage({status:response.status},'These listings'));
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Sign in with your Arosa account to explore NYC deals.');
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(publicErrorMessage({status:response.status,message:data.error,userFacing:data.userFacing||(response.status>=400&&response.status<500),code:data.code},'These listings'));
  }
  return data;
}

function renderMapSvg(deals, selectedDealId, onSelectDeal, dealSettings) {
  const wrap = el('div', undefined, 'deals-map-card');
  const pinned = deals.map(deal => ({deal, pin: dealPin(deal)})).filter(p => p.pin);
  const header = el('div', undefined, 'deals-map-header');
  header.append(
    el('strong', pinned.length === deals.length
      ? `NYC Development Opportunity Map (${deals.length} parcels)`
      : `NYC Development Opportunity Map (${pinned.length} of ${deals.length} parcels mapped)`),
  );
  if (deals.length) {
    header.append(el('span', pinned.length ? 'Click a parcel pin, or tab to one and press Enter, to inspect $/BSF & comps' : 'None of these listings has a map location yet', 'deals-map-hint'));
  }
  wrap.append(header);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 420 230');
  svg.setAttribute('class', 'deals-map-svg');
  svg.setAttribute('id', 'deals-map-canvas');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'NYC development deal pins');

  // Subtle grid lines
  for (let x = 60; x < 420; x += 60) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(x));
    line.setAttribute('y1', '0');
    line.setAttribute('x2', String(x));
    line.setAttribute('y2', '230');
    line.setAttribute('class', 'deals-map-grid');
    svg.append(line);
  }
  for (let y = 50; y < 230; y += 50) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', '420');
    line.setAttribute('y2', String(y));
    line.setAttribute('class', 'deals-map-grid');
    svg.append(line);
  }

  // Borough watermark labels, placed with the same projection as the pins
  const boroZones = [
    {label: 'MANHATTAN', lat: 40.79, lon: -73.965},
    {label: 'BRONX', lat: 40.85, lon: -73.87},
    {label: 'QUEENS', lat: 40.71, lon: -73.80},
    {label: 'BROOKLYN', lat: 40.64, lon: -73.95},
    {label: 'STATEN IS.', lat: 40.58, lon: -74.15},
  ];
  for (const bz of boroZones) {
    const {x, y} = nycMapPoint(bz.lat, bz.lon);
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', String(x));
    txt.setAttribute('y', String(y));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('class', 'deals-map-boro-label');
    txt.textContent = bz.label;
    svg.append(txt);
  }

  // Listings without a geocode inside the five boroughs stay in the list but get no pin.
  // Pins are keyboard-operable with a roving tabindex: one tab stop for the map, arrows move
  // between pins, Enter or Space inspects the focused pin, exactly like a click.
  const pinElements = [];
  const focusPin = (index) => {
    pinElements.forEach((pin, i) => pin.setAttribute('tabindex', i === index ? '0' : '-1'));
    pinElements[index]?.focus?.();
  };
  for (const {deal, pin: {x, y}} of pinned) {

    const g = document.createElementNS(ns, 'g');
    const vMeta = verdictMeta(deal.deal_verdict);
    const isSelected = deal.listing_id === selectedDealId;
    g.setAttribute('class', `deal-map-pin ${vMeta.cls}${isSelected ? ' is-selected' : ''}`);
    g.setAttribute('data-deal-id', deal.listing_id);
    g.setAttribute('transform', `translate(${x}, ${y})`);

    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('r', isSelected ? '9' : '6.5');
    g.append(circle);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', isSelected ? '-13' : '-10');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'deal-map-pin-label');
    label.textContent = verdictPricePerBsf(deal)
      ? `$${Math.round(verdictPricePerBsf(deal))}/BSF`
      : 'Residual';
    g.append(label);

    const pinIndex = pinElements.length;
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', isSelected || (pinIndex === 0 && !pinned.some(p => p.deal.listing_id === selectedDealId)) ? '0' : '-1');
    g.setAttribute('aria-label', `Inspect ${deal.address || `BBL ${deal.bbl}`}, ${label.textContent}`);
    g.addEventListener('click', () => onSelectDeal(deal.listing_id));
    g.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelectDeal(deal.listing_id);
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        focusPin((pinIndex + 1) % pinElements.length);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusPin((pinIndex - 1 + pinElements.length) % pinElements.length);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusPin(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusPin(pinElements.length - 1);
      }
    });
    pinElements.push(g);
    svg.append(g);
  }

  wrap.append(svg);

  const thresholds = verdictThresholds(dealSettings);
  const legend = el('div', undefined, 'deals-map-legend');
  legend.append(
    el('span', `● Great Deal (${thresholds.great})`, 'legend-item verdict-great'),
    el('span', `● Good Deal (${thresholds.good})`, 'legend-item verdict-good'),
    el('span', '● Unpriced / Residual', 'legend-item verdict-unpriced'),
    el('span', '● Fair Deal', 'legend-item verdict-fair'),
    el('span', `● Full Price (${thresholds.full})`, 'legend-item verdict-bad')
  );
  wrap.append(legend);
  return wrap;
}

function renderSelectedDealInspector(deal, userSettings) {
  const inspector = el('section', undefined, 'deals-inspector');
  inspector.id = 'deals-inspector';
  if (!deal) {
    inspector.append(el('p', 'Select a parcel on the map or list to inspect its zoning envelope, $/BSF sliding scale, and comparable sales.', 'deals-empty'));
    return inspector;
  }

  const vMeta = verdictMeta(deal.deal_verdict);
  const topBar = el('div', undefined, 'deals-inspector-header');
  const titleWrap = el('div');
  const pillRow = el('div', undefined, 'deals-pill-row');
  pillRow.append(
    el('span', vMeta.label, `deal-verdict-pill ${vMeta.cls}`),
    el('span', deal.zoning_district_1 || 'NYC Zoning', 'deal-zone-pill')
  );
  if (deal.corridorProfile?.hasRetailUplift) {
    pillRow.append(el('span', `Retail Uplift · ${deal.corridorProfile.corridorLabel}`, 'deal-corridor-pill'));
  }
  const tenant = tenantReview(deal.rentStabilization);
  pillRow.append(el('span', tenant.badgeLabel, `deal-rs-pill rs-${tenant.riskLevel}`));
  titleWrap.append(
    pillRow,
    el('h3', deal.address || 'NYC Development Parcel'),
    el('p', `${deal.borough || 'NYC'} ${deal.zip_code || ''} · BBL ${deal.bbl || 'Matched'} · Lot ${fmtInt(deal.lot_area_sqft)} SF`, 'deals-inspector-sub')
  );

  const underwriteBtn = el('button', 'Underwrite this parcel', 'deals-underwrite-btn');
  underwriteBtn.type = 'button';
  underwriteBtn.id = 'deals-underwrite-btn';
  underwriteBtn.addEventListener('click', () => onUnderwrite(deal, buildDealUnderwritePrompt(deal, userSettings?.dealSettings)));
  topBar.append(titleWrap, underwriteBtn);
  inspector.append(topBar);
  const sourceLink = listingLink(deal);
  if (sourceLink) inspector.append(sourceLink);

  // 1. Headline $/BSF Compression Strip
  const compressionGrid = el('div', undefined, 'deals-kpi-grid');
  const askCard = el('div', undefined, 'deals-kpi-card');
  askCard.append(
    el('span', deal.list_price ? 'Asking Price' : 'Unpriced · Target Residual'),
    el('strong', deal.list_price ? fmtCurrency(deal.list_price) : fmtCurrency(deal.slidingScale?.goodDealMaxLandValue)),
    el('small', deal.list_price ? `Existing: ${fmtInt(deal.building_sqft)} SF` : 'Good Deal max residual land value')
  );

  const existingPsfCard = el('div', undefined, 'deals-kpi-card');
  existingPsfCard.append(
    el('span', 'Existing $/SF'),
    el('strong', deal.price_per_existing_sqft ? `$${fmtInt(deal.price_per_existing_sqft)}/SF` : 'Land / Unpriced'),
    el('small', `Built FAR ${deal.built_far ?? '–'} vs ${deal.bonus_far ?? deal.standard_far ?? '–'} Max FAR`)
  );

  const stdBsfCard = el('div', undefined, 'deals-kpi-card');
  stdBsfCard.append(
    el('span', 'As-of-Right $/BSF'),
    el('strong', deal.price_per_buildable_zfa ? `$${fmtInt(deal.price_per_buildable_zfa)}/BSF` : '–'),
    el('small', `${fmtInt(deal.max_buildable_zfa)} ZFA (+${fmtInt(deal.unused_residential_zfa)} unused)`)
  );

  const uapBsfCard = el('div', undefined, 'deals-kpi-card highlight');
  const units = unitEstimate(deal);
  const pricePerUnit = deal.pricePerBuildableUnit || (deal.list_price && units.count > 0 ? Math.round(deal.list_price / units.count) : null);
  uapBsfCard.append(
    el('span', '$/Buildable SF & $/Planned Unit'),
    el('strong', verdictPricePerBsf(deal) ? `$${fmtInt(verdictPricePerBsf(deal))}/BSF` : (deal.slidingScale?.goodDealMaxPricePerBsf ? `≤$${fmtInt(deal.slidingScale.goodDealMaxPricePerBsf)}/BSF` : '–')),
    el('small', `${pricePerUnit ? `$${fmtInt(pricePerUnit)}/unit · ` : ''}${units.label} · ${fmtInt(deal.buildable_zfa ?? deal.uap_max_buildable_zfa)} buildable ZFA`)
  );

  compressionGrid.append(askCard, existingPsfCard, stdBsfCard, uapBsfCard);
  inspector.append(compressionGrid);

  // 2. Sendy's Sliding Scale ($/BSF Great / Good / Bad + Implied Returns)
  const scaleBox = el('div', undefined, 'deals-detail-box');
  scaleBox.append(el('h4', '$/Buildable SF Sliding Scale & Projected Redevelopment Value'));
  const scaleRow = el('div', undefined, 'deals-scale-row');

  const greatThreshold = deal.slidingScale?.greatDealMaxPricePerBsf ?? deal.great_deal_max_price_per_bsf;
  const goodThreshold = deal.slidingScale?.goodDealMaxPricePerBsf ?? deal.good_deal_max_price_per_bsf;
  const badThreshold = deal.slidingScale?.badDealMinPricePerBsf ?? deal.bad_deal_min_price_per_bsf;

  const thresholds = verdictThresholds(userSettings?.dealSettings);
  const greatMarker = el('div', undefined, 'scale-tier tier-great');
  greatMarker.append(
    el('span', `Great Deal (${thresholds.great})`),
    el('strong', greatThreshold ? `≤ $${fmtInt(greatThreshold)} / BSF` : '–'),
    el('small', `Max Land: ${fmtCurrency(deal.slidingScale?.greatDealMaxLandValue)}`)
  );

  const goodMarker = el('div', undefined, 'scale-tier tier-good');
  goodMarker.append(
    el('span', `Good Deal (${thresholds.good})`),
    el('strong', goodThreshold ? `≤ $${fmtInt(goodThreshold)} / BSF` : '–'),
    el('small', `Max Land: ${fmtCurrency(deal.slidingScale?.goodDealMaxLandValue)}`)
  );

  const badMarker = el('div', undefined, 'scale-tier tier-bad');
  badMarker.append(
    el('span', `Full Price (${thresholds.full})`),
    el('strong', badThreshold ? `≥ $${fmtInt(badThreshold)} / BSF` : '–'),
    el('small', `Land > ${fmtCurrency(deal.slidingScale?.badDealMinLandValue)}`)
  );

  scaleRow.append(greatMarker, goodMarker, badMarker);
  scaleBox.append(scaleRow);

  const devMetricsLine = el('div', undefined, 'deals-dev-summary');
  devMetricsLine.append(
    el('span', `${userSettings?.dealSettings?.zfaToGrossFactor ?? '–'}x Gross Construction: ${fmtInt(deal.estimated_gross_buildable_sqft)} GSF`),
    el('span', `Est. Construction Cost: ${fmtCurrency(deal.estimated_construction_cost)}`),
    el('span', `Completed Rental Value: ${fmtCurrency(deal.estimated_stabilized_value)} (${fmtPct(deal.implied_cap_rate)} YOC)`),
    el('span', `Completed Condo Sellout: ${fmtCurrency(deal.estimated_condo_sellout)} (${fmtPct(deal.implied_condo_margin)} Margin)`)
  );
  scaleBox.append(devMetricsLine);
  inspector.append(scaleBox);
  inspector.append(renderBasis(deal.flashcardValuation?.basis));

  // 3. Avenue Commercial Retail Uplift + Rent-Stabilized / Demolition Risk
  const intelGrid = el('div', undefined, 'deals-intel-grid');

  const corridorBox = el('div', undefined, 'deals-detail-box');
  corridorBox.append(el('h4', 'Ground-Floor Retail & Avenue Overlay'));
  if (deal.corridorProfile?.hasRetailUplift) {
    corridorBox.append(
      el('p', `${deal.corridorProfile.corridorLabel}: ~${fmtInt(deal.corridorProfile.groundFloorRetailSqft)} SF ground-floor retail @ $${deal.corridorProfile.retailRentPsfYear}/PSF/yr.`, 'intel-highlight'),
      el('small', `Adds +${fmtCurrency(deal.corridorProfile.retailAnnualNoiUplift)}/yr retail NOI (+${fmtCurrency(deal.corridorProfile.retailValueUplift)} capitalized value uplift).`)
    );
  } else {
    corridorBox.append(
      el('p', 'Pure Residential Side-Street Envelope', 'intel-muted'),
      el('small', 'No commercial overlay or primary avenue retail uplift modeled; 100% residential ZFA underwriting.')
    );
  }

  const rsBox = el('div', undefined, 'deals-detail-box');
  rsBox.append(el('h4', 'Tenant & Demolition Screening'));
  const tenantStatus = el('p');
  tenantStatus.append(el('small', 'Rent regulation: unverified · Occupancy: unverified · CONH: not assessed'));
  rsBox.append(
    el('p', tenant.badgeLabel, `intel-rs-title rs-${tenant.riskLevel}`),
    el('small', tenant.summary),
    tenantStatus
  );
  const verification = el('p');
  for (const source of tenant.verificationLinks) {
    const link = listingLink({url: source.url});
    if (!link) continue;
    link.textContent = source.label;
    link.className = 'tenant-verification-link';
    link.setAttribute('aria-label', source.label);
    if (verification.childNodes.length) verification.append(document.createTextNode(' · '));
    verification.append(link);
  }
  rsBox.append(verification);
  intelGrid.append(corridorBox, rsBox);
  inspector.append(intelGrid);

  // 4. 1-100% Similarity-Ranked Area Comps
  const compsBox = el('div', undefined, 'deals-detail-box');
  const compsList = Array.isArray(deal.similarComps) ? deal.similarComps : [];
  compsBox.append(el('h4', `Similarity-Ranked Area Comps (${compsList.length})`));
  if (!compsList.length) {
    compsBox.append(el('small', 'No nearby comparables with a reported sale or asking price yet.'));
  } else {
    const table = el('div', undefined, 'deals-comps-list');
    for (const comp of compsList) {
      const row = el('div', undefined, 'deals-comp-row');
      const left = el('div', undefined, 'deals-comp-main');
      const {hasPrice, capacityLabel, hasCapacity, date} = comparableReview(comp);
      const scoreBadge = el('span', `Match score ${comp.similarityScore}/100`, 'comp-similarity-badge');
      const statusBadge = el('span', hasPrice ? COMP_PRICE_LABELS[comp.priceBasis] : 'UNVERIFIED PRICE', `comp-status-badge status-${comp.listingType}`);
      left.append(
        scoreBadge,
        statusBadge,
        el('strong', comp.address || 'Comparable Parcel'),
        el('small', (comp.similarityReasons || []).join(' · '))
      );
      left.append(el('small', comp.zoningDistrict ? `${comp.zoningDistrict} zoning` : 'Zoning unavailable'));

      const right = el('div', undefined, 'deals-comp-metrics');
      right.append(el('strong', !hasPrice ? 'Price source unavailable' : hasCapacity && finite(comp.pricePerBuildableZfa) ? `$${fmtInt(comp.pricePerBuildableZfa)}/BSF` : fmtCurrency(comp.price)));
      const metrics = [];
      if (hasPrice && hasCapacity && finite(comp.pricePerBuildableUnit)) metrics.push(`$${fmtInt(comp.pricePerBuildableUnit)}/allowed unit`);
      if (hasPrice && finite(comp.pricePerExistingSqft)) metrics.push(`$${fmtInt(comp.pricePerExistingSqft)}/exist SF`);
      if (metrics.length) right.append(el('small', metrics.join(' · ')));
      right.append(el('small', hasCapacity ? capacityLabel : 'Buildable area unavailable'));
      if (hasPrice && hasCapacity && finite(comp.pricePerBuildableUnit)) right.append(el('small', `Most units zoning allows, ${DWELLING_UNIT_FACTOR} SF a unit`));
      if (hasPrice) {
        const sale = comp.priceBasis === 'reported_sale';
        right.append(el('small', date ? `${sale ? 'Reported sale' : 'Listed'}: ${date}` : `${sale ? 'Sale' : 'Listing'} date unavailable`));
      }
      row.append(left, right);
      table.append(row);
    }
    compsBox.append(table);
  }
  inspector.append(compsBox);

  return inspector;
}

export function renderDealsExplorer(payload, {append = false} = {}) {
  if (!content) return;
  const activeCostId = COST_FIELDS.map(key => COST_CONFIG[key].id).includes(document.activeElement?.id) ? document.activeElement.id : null;
  // A new query starts the card list at the top; selecting a card or loading a further page keeps its scroll.
  const listScroll = payload && !append ? 0 : (document.querySelector('#deals-card-list')?.scrollTop || 0);
  const shownBefore = currentState.deals.length;
  if (payload) {
    // The store ranks every page with a stable tie-break, so pages are appended in the order it returns them.
    const incoming = Array.isArray(payload.deals) ? payload.deals.map(normalizeDealRow) : [];
    const known = new Set(append ? currentState.deals.map(d => d.listing_id) : []);
    currentState.deals = append ? [...currentState.deals, ...incoming.filter(d => !known.has(d.listing_id))] : incoming;
    currentState.loaded = (append ? currentState.loaded : 0) + incoming.length;
    currentState.total = Number.isFinite(payload.total) ? payload.total : currentState.loaded;
    // The inputs show the costs the cards were valued with, which may be unsaved ones from Recalculate.
    if (payload.userSettings) {
      currentState.userSettings = {
        ...payload.userSettings,
        savedDealSettings: {...payload.userSettings.dealSettings},
        dealSettings: {...payload.userSettings.dealSettings, ...currentState.listCosts},
      };
    }
    if (sameCosts(currentState.costDraft, currentState.userSettings.dealSettings)) currentState.costDraft = null;
    if (payload.storeStatus) currentState.storeStatus = payload.storeStatus;
  }

  const deals = currentState.deals;
  if (!deals.some(d => d.listing_id === currentState.selectedDealId)) {
    currentState.selectedDealId = deals[0]?.listing_id || null;
  }
  const selectedDeal = deals.find(d => d.listing_id === currentState.selectedDealId) || deals[0] || null;

  content.replaceChildren();

  // 1. Filter & Sort Bar
  const toolbar = el('div', undefined, 'deals-toolbar');

  const boroSelect = el('select', undefined, 'deals-select');
  boroSelect.id = 'deals-borough-filter';
  for (const [val, label] of [
    ['', 'All NYC Boroughs'],
    ['Manhattan', 'Manhattan'],
    ['Brooklyn', 'Brooklyn'],
    ['Queens', 'Queens'],
    ['Bronx', 'Bronx'],
    ['Staten Island', 'Staten Island'],
  ]) {
    const opt = el('option', label);
    opt.value = val;
    if (currentState.filters.borough === val) opt.selected = true;
    boroSelect.append(opt);
  }
  boroSelect.addEventListener('change', () => {
    currentState.filters.borough = boroSelect.value;
    void loadDeals();
  });

  const zipInput = el('input', undefined, 'deals-input');
  zipInput.id = 'deals-zip-filter';
  zipInput.type = 'text';
  zipInput.placeholder = 'ZIP (e.g. 11215)';
  zipInput.value = currentState.filters.zipCode || '';
  zipInput.addEventListener('change', () => {
    currentState.filters.zipCode = zipInput.value.trim();
    void loadDeals();
  });

  const thresholds = verdictThresholds(currentState.userSettings?.dealSettings);
  const verdictSelect = el('select', undefined, 'deals-select');
  verdictSelect.id = 'deals-verdict-filter';
  for (const [val, label] of [
    ['', 'All Verdicts (Priced + Unpriced)'],
    ['great_deal', `Great Deals Only (${thresholds.great})`],
    ['good_deal', `Good Deals (${thresholds.good})`],
    ['unpriced_opportunity', 'Unpriced / Call-for-Offers'],
    ['fair_deal', 'Fair Deals'],
    ['full_price', `Full Price (${thresholds.full})`],
  ]) {
    const opt = el('option', label);
    opt.value = val;
    if (currentState.filters.dealVerdict === val) opt.selected = true;
    verdictSelect.append(opt);
  }
  verdictSelect.addEventListener('change', () => {
    currentState.filters.dealVerdict = verdictSelect.value;
    void loadDeals();
  });

  const sortSelect = el('select', undefined, 'deals-select');
  sortSelect.id = 'deals-sort-by';
  for (const [val, label] of DEAL_SORTS) {
    const opt = el('option', `Sort: ${label}`);
    opt.value = val;
    if (currentState.filters.sortBy === val) opt.selected = true;
    sortSelect.append(opt);
  }
  sortSelect.addEventListener('change', () => {
    currentState.filters.sortBy = sortSelect.value;
    void loadDeals();
  });

  const cleanLabel = el('label', undefined, 'deals-checkbox-label');
  const cleanCheck = document.createElement('input');
  cleanCheck.type = 'checkbox';
  cleanCheck.id = 'deals-clean-delivery';
  cleanCheck.checked = Boolean(currentState.filters.excludeHighStabilizedRisk);
  cleanCheck.addEventListener('change', () => {
    currentState.filters.excludeHighStabilizedRisk = cleanCheck.checked;
    void loadDeals();
  });
  cleanLabel.append(cleanCheck, el('span', 'Hide high tenant review flags (unknowns remain)'));

  toolbar.append(boroSelect, zipInput, verdictSelect, sortSelect, cleanLabel);
  content.append(toolbar);

  // 2. Per-User Developer Cost Baseline Bar
  const ds = currentState.userSettings?.dealSettings || {};
  const isCustom = Boolean(currentState.userSettings?.isCustom);
  const costBar = el('div', undefined, 'deals-cost-bar');
  const costHeader = el('div', undefined, 'deals-cost-header');
  const profileBadge = el('span', undefined, 'deals-profile-badge');
  const profileNote = el('span');
  costHeader.append(el('strong', 'My Developer Cost Profile'), profileBadge);
  function updateCostStatus() {
    const unapplied = currentState.costDraft && !sameCosts(currentState.costDraft, ds);
    const unsaved = !sameCosts(ds, currentState.userSettings.savedDealSettings || ds);
    profileBadge.textContent = unapplied ? 'Unapplied changes' : unsaved ? 'Unsaved assumptions' : isCustom ? 'Custom Saved Profile' : `NYC Baseline ($${fmtInt(currentState.userSettings?.baselineSettings?.hardCostPerGrossSqft)}/GSF)`;
    profileBadge.classList.toggle('is-custom', Boolean(unapplied || unsaved || isCustom));
    profileNote.textContent = unapplied ? 'Recalculate to apply these changes.' : unsaved ? 'Current results use these unsaved assumptions.' : '';
    profileNote.hidden = !profileNote.textContent;
  }

  const costInputs = el('div', undefined, 'deals-cost-inputs');
  const fields = {};
  for (const key of COST_FIELDS) {
    const config = COST_CONFIG[key];
    const w = el('label', undefined, 'deals-cost-field');
    w.append(el('span', config.label));
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.id = config.id;
    inp.min = String(config.min);
    inp.max = String(config.max);
    inp.step = String(10 ** -config.digits);
    inp.value = currentState.costDraft?.[key] ?? String(ds[key] ?? (key === 'condoHardCostPerGrossSqft' ? ds.hardCostPerGrossSqft : undefined) ?? config.defaultValue);
    inp.addEventListener('input', () => {
      currentState.costDraft = Object.fromEntries(COST_FIELDS.map(key => [key, fields[key].value]));
      currentState.costDraftVersion++;
      inp.removeAttribute('aria-invalid');
      updateCostStatus();
    });
    w.append(inp);
    fields[key] = inp;
    costInputs.append(w);
  }
  function readCosts() {
    const costs = {};
    for (const key of COST_FIELDS) {
      const input = fields[key], config = COST_CONFIG[key], value = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(value) || value < config.min || value > config.max) {
        input.setAttribute('aria-invalid', 'true');
        if (notice) notice.textContent = `${config.label}: enter a number from ${config.min} to ${config.max}.`;
        input.focus();
        return null;
      }
      costs[key] = Number(value.toFixed(config.digits));
    }
    costs.rentalHardCostPerGrossSqft = costs.hardCostPerGrossSqft;
    currentState.costDraft = Object.fromEntries(COST_FIELDS.map(key => [key, String(costs[key])]));
    currentState.costDraftVersion++;
    for (const key of COST_FIELDS) fields[key].value = currentState.costDraft[key];
    updateCostStatus();
    return costs;
  }

  const applyBtn = el('button', 'Recalculate', 'deals-btn');
  applyBtn.type = 'button';
  applyBtn.id = 'deals-apply-costs';
  applyBtn.addEventListener('click', () => {
    if (profilePending) return;
    const costs = readCosts();
    if (!costs) return;
    currentState.appliedCosts = costs;
    void loadDeals({statusMessage: 'Recalculating deals…'});
  });

  async function changeProfile(body, savedMessage) {
    if (profilePending) return;
    const generation = screenGeneration, draftVersion = currentState.costDraftVersion;
    profilePending = true;
    ++latestPage;
    syncProfileControls();
    if (notice) notice.textContent = 'Saving your developer cost defaults…';
    try {
      const updated = await apiRequest('/market-store/user-settings', {
        method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
      });
      if (generation !== screenGeneration) return;
      currentState.appliedCosts = {};
      if (draftVersion === currentState.costDraftVersion) currentState.costDraft = null;
      currentState.userSettings = {...updated, savedDealSettings: {...updated.dealSettings}, dealSettings: currentState.userSettings.dealSettings};
      const refresh = loadDeals({statusMessage: `${savedMessage} Updating deals…`});
      const query = latestQuery;
      const data = await refresh;
      if (generation === screenGeneration && query === latestQuery && notice) {
        notice.textContent = data ? `${savedMessage} Deal results updated.` : `${savedMessage} ${notice.textContent}`;
      }
    } catch (err) {
      if (generation === screenGeneration && notice) notice.textContent = err.message;
    } finally {
      profilePending = false;
      syncProfileControls();
    }
  }

  const saveProfileBtn = el('button', 'Save My Defaults', 'deals-btn primary');
  saveProfileBtn.type = 'button';
  saveProfileBtn.id = 'deals-save-profile';
  saveProfileBtn.addEventListener('click', () => {
    if (profilePending) return;
    const costs = readCosts();
    if (costs) void changeProfile({dealSettings: costs}, 'Defaults saved.');
  });

  const resetProfileBtn = el('button', 'Reset Baseline', 'deals-btn');
  resetProfileBtn.type = 'button';
  resetProfileBtn.id = 'deals-reset-profile';
  resetProfileBtn.addEventListener('click', () => {
    void changeProfile({reset: true}, 'NYC baseline restored.');
  });

  updateCostStatus();
  costInputs.append(applyBtn, saveProfileBtn, resetProfileBtn);
  costBar.append(costHeader, profileNote, costInputs);
  content.append(costBar);

  // 3. Split Workspace: Map + Feed on Left, Selected Flashcard Inspector on Right
  const workspace = el('div', undefined, 'deals-workspace');
  const leftCol = el('div', undefined, 'deals-left-col');

  const selectDeal = (listingId) => {
    currentState.selectedDealId = listingId;
    renderDealsExplorer();
  };

  leftCol.append(renderMapSvg(deals, currentState.selectedDealId, selectDeal, currentState.userSettings?.dealSettings));

  const cardList = el('div', undefined, 'deals-card-list');
  cardList.id = 'deals-card-list';
  if (!deals.length) {
    cardList.append(el('p', 'No matching NYC development parcels found for these filters.', 'deals-empty'));
  } else {
    deals.forEach((deal, index) => {
      const vMeta = verdictMeta(deal.deal_verdict);
      const isSelected = deal.listing_id === currentState.selectedDealId;
      const card = el('button', undefined, `deal-flashcard-item ${vMeta.cls}${isSelected ? ' is-selected' : ''}`);
      card.type = 'button';
      card.setAttribute('data-deal-card', deal.listing_id);

      const top = el('div', undefined, 'deal-card-top');
      top.append(
        el('span', `#${index + 1}`, 'deal-rank'),
        el('span', vMeta.label, `deal-verdict-pill ${vMeta.cls}`),
        el('span', deal.zoning_district_1 || 'Zoning', 'deal-zone-pill')
      );
      if (deal.corridorProfile?.hasRetailUplift) {
        top.append(el('span', '+Retail', 'deal-mini-badge'));
      }
      const tenant = tenantReview(deal.rentStabilization);
      top.append(el('span', tenant.badgeLabel, `deal-mini-badge rs-${tenant.riskLevel}`));

      const mid = el('div', undefined, 'deal-card-mid');
      mid.append(
        el('strong', deal.address || 'Parcel'),
        el('span', verdictPricePerBsf(deal) ? `$${fmtInt(verdictPricePerBsf(deal))}/BSF` : `Est. ≤$${fmtInt(deal.slidingScale?.goodDealMaxPricePerBsf)}/BSF`, 'deal-card-bsf')
      );

      const bot = el('div', undefined, 'deal-card-bot');
      bot.append(
        el('small', `${deal.borough || 'NYC'} ${deal.zip_code || ''} · Ask ${deal.list_price ? fmtCurrency(deal.list_price) : 'Unpriced'}`),
        el('small', `+${fmtInt(headroomSqft(deal))} Unused ZFA${headroomFar(deal) !== null ? ` · +${headroomFar(deal).toFixed(2)} FAR headroom` : ''} · ${unitEstimate(deal).label}`)
      );

      card.append(top, mid, bot);
      card.addEventListener('click', () => selectDeal(deal.listing_id));
      cardList.append(card);
    });
  }
  leftCol.append(cardList);

  if (currentState.loaded < currentState.total) {
    const more = el('div', undefined, 'deals-more');
    const moreBtn = el('button', 'Show more listings', 'deals-btn');
    moreBtn.type = 'button';
    moreBtn.id = 'deals-more-btn';
    moreBtn.addEventListener('click', async () => {
      moreBtn.disabled = true;
      if (!(await loadDeals({more: true}))) syncProfileControls();
    });
    more.append(el('span', `Showing ${deals.length} of ${currentState.total} matching listings`), moreBtn);
    leftCol.append(more);
  }

  const rightCol = renderSelectedDealInspector(selectedDeal, currentState.userSettings);
  workspace.append(leftCol, rightCol);
  content.append(workspace);
  cardList.scrollTop = listScroll;
  // Keyboard focus moves to the first newly loaded listing, which also scrolls it into view.
  if (append && deals.length > shownBefore) cardList.children[shownBefore].focus();
  if (activeCostId) content.querySelector(`#${activeCostId}`).focus({preventScroll: true});
  syncProfileControls();
}

// Match the owning market store's input ranges and stored precision.
// The legacy hard-cost field is the rental figure; the condo figure is its own field.
const COST_CONFIG = {
  hardCostPerGrossSqft: {id: 'deals-hard-cost', label: 'Rental hard ($/GSF)', min: 100, max: 2500, digits: 0, defaultValue: 375},
  softCostPctOfHard: {id: 'deals-soft-cost', label: 'Soft (frac)', min: 0, max: 1, digits: 3, defaultValue: .22},
  carryAndFinancingPct: {id: 'deals-carry-cost', label: 'Carry (frac)', min: 0, max: 1, digits: 3, defaultValue: .1},
  zfaToGrossFactor: {id: 'deals-gross-factor', label: 'ZFA→Gross', min: 1, max: 1.5, digits: 3, defaultValue: 1.15},
  condoHardCostPerGrossSqft: {id: 'deals-condo-hard-cost', label: 'Condo hard ($/GSF)', min: 100, max: 2500, digits: 0, defaultValue: 375},
};
const COST_FIELDS = Object.keys(COST_CONFIG);
function sameCosts(a, b) {
  // Settings saved before the split carry no condo figure: it reads as the legacy hard cost.
  const at = (obj, key) => (key === 'condoHardCostPerGrossSqft' ? (obj[key] ?? obj.hardCostPerGrossSqft) : obj[key]);
  return a && b && COST_FIELDS.every(key => finite(at(a, key)) && finite(at(b, key)) && Number(at(a, key)) === Number(at(b, key)));
}
let latestQuery = 0;
let latestPage = 0;
let queryPending = false;
function syncProfileControls() {
  for (const id of ['deals-apply-costs', 'deals-save-profile', 'deals-reset-profile']) {
    const button = content?.querySelector(`#${id}`);
    if (button) button.disabled = profilePending;
  }
  const more = content?.querySelector('#deals-more-btn');
  if (more) more.disabled = profilePending || queryPending;
}

// A new query (filters, sort or costs) replaces the list; a further page extends the list on screen with that list's own query.
// Only the latest query renders, and a page renders only onto the list it was asked for, so slow responses never mix lists.
export async function loadDeals({statusMessage = '', more = false} = {}) {
  if (more) {
    if (queryPending || profilePending || !currentState.listQuery) return null;
    const page = ++latestPage;
    const query = latestQuery;
    const params = new URLSearchParams(currentState.listQuery);
    params.set('offset', String(currentState.loaded));
    try {
      const data = await apiRequest(`/market-store/deals?${params.toString()}`);
      if (query !== latestQuery || page !== latestPage) return null;
      renderDealsExplorer(data, {append: true});
      return data;
    } catch (err) {
      if (query === latestQuery && page === latestPage && notice) notice.textContent = err.message;
      return null;
    }
  }

  if (notice) {notice.textContent = statusMessage; notice.className = 'deals-notice';}
  const query = ++latestQuery;
  queryPending = true;
  syncProfileControls();
  const costs = {...currentState.appliedCosts};
  const params = new URLSearchParams();
  if (currentState.filters.borough) params.set('borough', currentState.filters.borough);
  if (currentState.filters.zipCode) params.set('zipCode', currentState.filters.zipCode);
  if (currentState.filters.dealVerdict) params.set('dealVerdict', currentState.filters.dealVerdict);
  if (currentState.filters.sortBy) params.set('sortBy', currentState.filters.sortBy);
  if (currentState.filters.excludeHighStabilizedRisk) params.set('excludeHighStabilizedRisk', 'true');
  params.set('minUnusedZfa', '250');
  params.set('limit', '30');
  params.set('offset', '0');
  for (const [k, v] of Object.entries(costs)) params.set(k, String(v));
  try {
    const data = await apiRequest(`/market-store/deals?${params.toString()}`);
    if (query !== latestQuery) return null;
    queryPending = false;
    const effectiveCosts = {...data.userSettings?.dealSettings, ...costs};
    if (!finite(effectiveCosts.condoHardCostPerGrossSqft) && finite(effectiveCosts.hardCostPerGrossSqft)) effectiveCosts.condoHardCostPerGrossSqft = effectiveCosts.hardCostPerGrossSqft;
    currentState.listCosts = Object.fromEntries(COST_FIELDS.filter(key => finite(effectiveCosts[key])).map(key => [key, Number(effectiveCosts[key])]));
    for (const [key, value] of Object.entries(currentState.listCosts)) params.set(key, String(value));
    currentState.listQuery = params.toString();
    renderDealsExplorer(data);
    if (notice) {notice.textContent = ''; notice.className = 'deals-notice';}
    return data;
  } catch (err) {
    if (query !== latestQuery) return null;
    queryPending = false;
    syncProfileControls();
    if (notice) {
      // One line naming the failure, with Try again beside it.
      const retry = el('button', 'Try again', 'retry-line-action');
      retry.type = 'button';
      retry.addEventListener('click', () => void loadDeals());
      notice.replaceChildren(el('span', `${err.message} Results still use the previous assumptions and filters.`), retry);
      notice.className = 'deals-notice retry-line';
    }
    return null;
  }
}

// The deal store is internal-only: the research service answers 404 to accounts that may not read it.
// The app asks once at boot, beside the session request, and every later caller shares that answer.
let storeAvailable = null;
export function dealsAvailable() {
  storeAvailable ||= apiRequest('/market-store/status').then(() => true, () => false);
  return storeAvailable;
}

export function mountDealsScreen(container, {onUnderwrite: underwrite}) {
  ++screenGeneration;
  currentState.appliedCosts = {};
  currentState.costDraft = null;
  currentState.costDraftVersion = 0;
  currentState.listQuery = null;
  currentState.listCosts = {};
  onUnderwrite = underwrite;
  notice = el('p', undefined, 'deals-notice');
  notice.id = 'deals-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  // The explorer's shape while the first listings load: a map block beside a few card rows.
  content = el('div', undefined, 'deals-content-loading');
  content.id = 'deals-content';
  content.setAttribute('aria-busy', 'true');
  const loadingNote = el('p', 'Loading NYC listings…', 'sr-only');
  loadingNote.setAttribute('role', 'status');
  content.append(loadingNote, skel('skel-block', {height: '220px'}), ...Array.from({length: 3}, () => skel('skel-block', {height: '96px'})));
  container.replaceChildren(notice, content);
  return loadDeals();
}
