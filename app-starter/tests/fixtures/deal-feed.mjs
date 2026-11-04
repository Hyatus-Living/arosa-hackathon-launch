// A deal store feed for the app fixtures: ten listings spread over the five boroughs, shaped like
// GET /api/market-store/deals, with the map pins GET /api/market-store/deals/pins returns for them.
// The first is the 125 Shepherd Ave lot the listing to site path starts from; the rest are synthetic.
const ZFA_TO_GROSS = 1.15, SQFT_PER_UNIT = 790;
const TIERS = [[150, 'great_deal'], [250, 'good_deal'], [350, 'fair_deal']];
const RETURNS = {great_deal: [7.1, 24.2], good_deal: [6.3, 17.5], fair_deal: [5.6, 11.8], full_price: [4.7, 5.9]};

function deal({id, bbl, address, borough, neighborhood, zipCode, zoningDistrict, style = 'land', latitude, longitude, lotAreaSqft, residFar, existingBldgAreaSqft = 0, listPrice, url = null}) {
  const maxZfa = Math.round(lotAreaSqft * residFar), grossBuildableSqft = Math.round(maxZfa * ZFA_TO_GROSS);
  const maxBuildableUnits = Math.round(grossBuildableSqft / SQFT_PER_UNIT), pricePerZfa = listPrice / maxZfa;
  const dealVerdict = TIERS.find(([max]) => pricePerZfa <= max)?.[1] ?? 'full_price';
  return {
    id, bbl, address, borough, neighborhood, zipCode, zoningDistrict, style, latitude, longitude, url,
    lotAreaSqft, existingBldgAreaSqft, builtFar: Math.round((existingBldgAreaSqft / lotAreaSqft) * 100) / 100, residFar, affResFar: residFar,
    maxStandardZfa: maxZfa, maxUapZfa: maxZfa, unusedUapZfa: Math.max(0, maxZfa - existingBldgAreaSqft),
    listPrice, uapPricePerBuildableZfa: Math.round(pricePerZfa), pricePerBuildableUnit: Math.round(listPrice / maxBuildableUnits), maxBuildableUnits, grossBuildableSqft, similarComps: [],
    flashcardValuation: {impliedYieldOnCostPct: RETURNS[dealVerdict][0], impliedCondoMarginPct: RETURNS[dealVerdict][1], dealVerdict, estimatedRedevValue: grossBuildableSqft * 490,
      slidingScalePricePerBsf: {greatDealMaxBsf: 150, goodDealMaxBsf: 250, badDealMinBsf: 350, greatDealMaxLandValue: maxZfa * 150, goodDealMaxLandValue: maxZfa * 250}, basis: []},
  };
}

export const DEALS = [
  {...deal({id: '4964456219:for_sale', bbl: '3044290016', address: '125 Shepherd Ave', borough: 'BK', neighborhood: 'East New York', zipCode: '11208', zoningDistrict: 'M1-1',
    latitude: 40.6753, longitude: -73.8899, lotAreaSqft: 57000, residFar: 1, listPrice: 828000, url: 'https://www.realtor.com/realestateandhomes-detail/125-Shepherd-Ave_Brooklyn_NY_11208_M49644-56219'}),
  uapPricePerBuildableZfa: 15, pricePerBuildableUnit: 9976, maxBuildableUnits: 83, grossBuildableSqft: 65550,
  flashcardValuation: {impliedYieldOnCostPct: 7.1, impliedCondoMarginPct: 24.2, dealVerdict: 'great_deal', estimatedRedevValue: 32_000_000,
    slidingScalePricePerBsf: {greatDealMaxBsf: 150, goodDealMaxBsf: 250, badDealMinBsf: 350, greatDealMaxLandValue: 8_550_000, goodDealMaxLandValue: 14_250_000}, basis: []}},
  deal({id: 'fx-feed-02:for_sale', bbl: '3017420031', address: '412 Fixture Ave', borough: 'BK', neighborhood: 'Bedford-Stuyvesant', zipCode: '11221', zoningDistrict: 'R6A', latitude: 40.6872, longitude: -73.9301, lotAreaSqft: 2500, residFar: 3, listPrice: 1_150_000}),
  deal({id: 'fx-feed-03:for_sale', bbl: '3051230012', address: '88 Sample St', borough: 'BK', neighborhood: 'Flatbush', zipCode: '11226', zoningDistrict: 'R7A', style: 'multi_family', latitude: 40.6461, longitude: -73.9581, lotAreaSqft: 4000, residFar: 4, existingBldgAreaSqft: 6000, listPrice: 2_400_000}),
  deal({id: 'fx-feed-04:for_sale', bbl: '1021450060', address: '560 Fixture Pl', borough: 'MN', neighborhood: 'Washington Heights', zipCode: '10032', zoningDistrict: 'R7-2', latitude: 40.8392, longitude: -73.9418, lotAreaSqft: 3000, residFar: 3.44, listPrice: 4_200_000}),
  deal({id: 'fx-feed-05:for_sale', bbl: '1017890040', address: '231 Example St', borough: 'MN', neighborhood: 'East Harlem', zipCode: '10035', zoningDistrict: 'R8A', style: 'duplex_triplex', latitude: 40.8007, longitude: -73.9389, lotAreaSqft: 2500, residFar: 7.2, existingBldgAreaSqft: 7500, listPrice: 4_900_000}),
  deal({id: 'fx-feed-06:for_sale', bbl: '4019870022', address: '37-15 Fixture Blvd', borough: 'QN', neighborhood: 'Jackson Heights', zipCode: '11372', zoningDistrict: 'R6', latitude: 40.7498, longitude: -73.8848, lotAreaSqft: 5000, residFar: 2.43, listPrice: 2_100_000}),
  deal({id: 'fx-feed-07:for_sale', bbl: '4097650018', address: '144-20 Sample Ave', borough: 'QN', neighborhood: 'Jamaica', zipCode: '11435', zoningDistrict: 'R7X', latitude: 40.7009, longitude: -73.8079, lotAreaSqft: 10000, residFar: 5, listPrice: 5_500_000}),
  deal({id: 'fx-feed-08:for_sale', bbl: '2027310045', address: '1020 Example Ave', borough: 'BX', neighborhood: 'Morrisania', zipCode: '10456', zoningDistrict: 'R7-1', latitude: 40.8296, longitude: -73.9073, lotAreaSqft: 7500, residFar: 3.44, listPrice: 1_600_000}),
  deal({id: 'fx-feed-09:for_sale', bbl: '2032550101', address: '2875 Fixture Rd', borough: 'BX', neighborhood: 'Kingsbridge', zipCode: '10463', zoningDistrict: 'R6A', style: 'multi_family', latitude: 40.8781, longitude: -73.9034, lotAreaSqft: 5000, residFar: 3, existingBldgAreaSqft: 8000, listPrice: 4_200_000}),
  deal({id: 'fx-feed-10:for_sale', bbl: '5005120034', address: '65 Sample Pl', borough: 'SI', neighborhood: 'Stapleton', zipCode: '10304', zoningDistrict: 'R5', latitude: 40.6271, longitude: -74.0776, lotAreaSqft: 8000, residFar: 1.25, listPrice: 780_000}),
];

// The store's best-deal order: the tier, then the lowest price per buildable foot within it.
const VERDICT_ORDER = ['great_deal', 'good_deal', 'unpriced_opportunity', 'fair_deal', 'full_price', 'unmatched_parcel'];
const SORTS = {
  best_deal: (a, b) => VERDICT_ORDER.indexOf(a.flashcardValuation.dealVerdict) - VERDICT_ORDER.indexOf(b.flashcardValuation.dealVerdict) || a.uapPricePerBuildableZfa - b.uapPricePerBuildableZfa,
  uap_price_per_buildable_zfa: (a, b) => a.uapPricePerBuildableZfa - b.uapPricePerBuildableZfa,
  unused_uap_zfa: (a, b) => b.unusedUapZfa - a.unusedUapZfa,
  implied_yield_on_cost: (a, b) => b.flashcardValuation.impliedYieldOnCostPct - a.flashcardValuation.impliedYieldOnCostPct,
  implied_condo_margin: (a, b) => b.flashcardValuation.impliedCondoMarginPct - a.flashcardValuation.impliedCondoMarginPct,
};
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The feed's filters and sorts over the fixture listings, read from the query the app sends to
// GET /api/market-store/deals and /deals/pins with the store's defaults. A filter on a figure the
// fixture listings do not carry (lot width and depth, project cost, landmarks, MIH) keeps every listing.
export function searchFeed(deals, query) {
  const num = (key) => (query[key] != null && query[key] !== '' ? Number(query[key]) : null);
  const list = (key) => String(query[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const verdicts = list('dealVerdict'), styles = list('styles');
  const minUnused = num('minUnusedZfa') ?? 500, maxPpb = num('maxPricePerBuildableZfa') ?? num('maxPricePerBuildableAnyUse');
  const minPrice = num('minListPrice'), maxPrice = num('maxListPrice'), minLot = num('minLotArea'), maxLot = num('maxLotArea');
  const minBuildable = num('minBuildableZfa'), minFar = num('minHeadroomFar');
  const area = String(query.area || '').trim().toLowerCase(), zips = area.match(/\b\d{5}\b/g);
  const zoning = String(query.zoningPrefix || '').trim().toUpperCase(), borough = String(query.borough || '').trim().toUpperCase();
  const [south, west, north, east] = String(query.bounds || '').split(',').map(Number);
  const box = query.bounds && [south, west, north, east].every(Number.isFinite);
  const priced = (d, test) => verdicts.includes('unpriced_opportunity') && !(d.listPrice > 0) || test;
  const kept = deals.filter((d) => (!borough || d.borough === borough)
    && (!area || (zips ? zips.includes(d.zipCode) : `${d.neighborhood} ${d.address}`.toLowerCase().includes(area)))
    && (!zoning || d.zoningDistrict.startsWith(zoning))
    && d.unusedUapZfa >= minUnused
    && priced(d, maxPpb == null || d.uapPricePerBuildableZfa <= maxPpb)
    && priced(d, minPrice == null || d.listPrice >= minPrice) && priced(d, maxPrice == null || d.listPrice <= maxPrice)
    && (minLot == null || d.lotAreaSqft >= minLot) && (maxLot == null || d.lotAreaSqft <= maxLot)
    && (minBuildable == null || d.maxUapZfa >= minBuildable)
    && (minFar == null || d.unusedUapZfa / d.lotAreaSqft >= minFar)
    && (!styles.length || styles.includes(d.style))
    && (!verdicts.length || verdicts.includes(d.flashcardValuation.dealVerdict))
    && (!box || (d.latitude >= south && d.latitude <= north && d.longitude >= west && d.longitude <= east)));
  const sort = SORTS[query.sortBy] || SORTS.uap_price_per_buildable_zfa;
  return [...kept].sort(byId).sort(sort);
}

// One page of a search, with the offset and limit clamped as the store clamps them.
export function pageOf(ranked, query) {
  const limit = Math.max(1, Math.min(Math.floor(Number(query.limit)) || 25, 100));
  const offset = Math.min(ranked.length, Math.max(0, Math.floor(Number(query.offset)) || 0));
  return {deals: ranked.slice(offset, offset + limit), total: ranked.length, offset, limit};
}

// Map pins in rank order, one array per field as the store sends them.
export function pinsOf(deals) {
  return {
    total: deals.length, locatedTotal: deals.length, unlocatedTotal: 0,
    pins: {id: deals.map((d) => d.id), rank: deals.map((_, i) => i + 1), address: deals.map((d) => d.address), latitude: deals.map((d) => d.latitude),
      longitude: deals.map((d) => d.longitude), dealVerdict: deals.map((d) => d.flashcardValuation.dealVerdict), listPrice: deals.map((d) => d.listPrice)},
  };
}

export const SETTINGS = {isCustom: false, dealSettings: {hardCostPerGrossSqft: 375, softCostPctOfHard: 0.22, carryAndFinancingPct: 0.1, zfaToGrossFactor: 1.15, greatDealCapRate: 0.085, goodDealCapRate: 0.0725, badDealCapRate: 0.06, greatDealCondoMargin: 0.28, goodDealCondoMargin: 0.18, badDealCondoMargin: 0.1}};
