// Example New York City listings for the landing page embeds, in the deal store's row shape. Figures
// are illustrative and internally consistent; they are not live listings.
export const SETTINGS = {
  isCustom: false,
  dealSettings: { hardCostPerGrossSqft: 450, softCostPctOfHard: 0.22, carryAndFinancingPct: 0.1, zfaToGrossFactor: 1.15, greatDealCapRate: 0.085, goodDealCapRate: 0.0725, badDealCapRate: 0.06, greatDealCondoMargin: 0.28, goodDealCondoMargin: 0.18, badDealCondoMargin: 0.1 },
};

// Residential FAR as of right, then with the Universal Affordability Preference (ZR 23-22).
const FAR = { R6A: [3, 3.9], R6B: [2, 2.4], R7A: [4, 5.01], R7D: [4.66, 5.6], R8A: [6.02, 7.2] };
const SCALE = { greatDealMaxBsf: 150, goodDealMaxBsf: 250, badDealMinBsf: 350 };
const tier = (ppb) => (ppb === null ? "unpriced_opportunity" : ppb <= SCALE.greatDealMaxBsf ? "great_deal" : ppb <= SCALE.goodDealMaxBsf ? "good_deal" : ppb < SCALE.badDealMinBsf ? "fair_deal" : "full_price");

// id, address, borough, neighborhood, zip, latitude, longitude, zoning, lot, existing building, ask, style, year built
const ROWS = [
  ["ex-fulton", "1234 Fulton St", "BK", "Crown Heights", "11216", 40.6803, -73.9502, "R7A", 5000, 3200, 3100000, "mixed_use", 1925],
  ["ex-nostrand", "418 Nostrand Ave", "BK", "Bedford-Stuyvesant", "11216", 40.6851, -73.951, "R6A", 2500, 1800, 1350000, "multi_family", 1910],
  ["ex-atlantic", "1890 Atlantic Ave", "BK", "Ocean Hill", "11233", 40.6772, -73.9255, "R7A", 6000, 2400, 3200000, "land", null],
  ["ex-arthur", "2410 Arthur Ave", "BX", "Belmont", "10458", 40.8545, -73.888, "R7A", 2500, 2000, 1100000, "mixed_use", 1931],
  ["ex-steinway", "31-18 Steinway St", "QN", "Astoria", "11103", 40.7575, -73.9175, "R7A", 3000, 2200, 2400000, "mixed_use", 1928],
  ["ex-myrtle", "920 Myrtle Ave", "BK", "Bedford-Stuyvesant", "11206", 40.6955, -73.9395, "R7A", 4000, 4000, 2600000, "land", null],
  ["ex-whiteplains", "3801 White Plains Rd", "BX", "Williamsbridge", "10467", 40.88, -73.8665, "R6A", 3500, 1700, 1200000, "single_family", 1920],
  ["ex-jamaica", "88-12 Jamaica Ave", "QN", "Woodhaven", "11421", 40.6935, -73.856, "R6A", 4000, 2600, 1900000, "mixed_use", 1925],
  ["ex-125th", "155 E 125th St", "MN", "East Harlem", "10035", 40.804, -73.9375, "R8A", 2500, 3000, 4800000, "mixed_use", 1900],
  ["ex-fortgreene", "245 Myrtle Ave", "BK", "Fort Greene", "11205", 40.6935, -73.976, "R7A", 2000, 3600, 2950000, "multi_family", 1899],
  ["ex-grand", "640 Grand St", "BK", "Williamsburg", "11211", 40.7115, -73.9475, "R6A", 2500, 2500, 3400000, "multi_family", 1915],
  ["ex-broadway", "4120 Broadway", "MN", "Washington Heights", "10033", 40.8475, -73.938, "R8A", 2500, 9000, 5900000, "multi_family", 1922],
  ["ex-harlem", "2101 Frederick Douglass Blvd", "MN", "Harlem", "10026", 40.804, -73.9555, "R7A", 2000, 4800, 3900000, "multi_family", 1905],
  ["ex-bedford", "1150 Bedford Ave", "BK", "Bedford-Stuyvesant", "11216", 40.687, -73.9545, "R6B", 2000, 2400, 1600000, "single_family", 1901],
  ["ex-court", "312 Court St", "BK", "Carroll Gardens", "11231", 40.6825, -73.9935, "R6B", 2000, 2100, 2250000, "mixed_use", 1899],
  ["ex-flatbush", "1501 Flatbush Ave", "BK", "Midwood", "11210", 40.6315, -73.947, "R7D", 4500, 3000, null, "mixed_use", 1930],
];

export const DEALS = ROWS.map(([id, address, borough, neighborhood, zipCode, latitude, longitude, zoningDistrict, lot, built, listPrice, style, yearBuilt]) => {
  const [standardFar, bonusFar] = FAR[zoningDistrict];
  const maxStandardZfa = Math.round(lot * standardFar), maxUapZfa = Math.round(lot * bonusFar);
  const unusedUapZfa = Math.max(0, maxUapZfa - built), unusedStandardZfa = Math.max(0, maxStandardZfa - built);
  const ppb = listPrice === null ? null : Math.round(listPrice / maxUapZfa);
  const gross = Math.round(maxUapZfa * 1.15);
  const verdict = tier(ppb);
  const yieldPct = { great_deal: 7.4, good_deal: 6.4, fair_deal: 5.6, full_price: 4.9, unpriced_opportunity: null }[verdict];
  return {
    id, address, borough, neighborhood, zipCode, latitude, longitude, zoningDistrict, style, yearBuilt,
    bbl: null, url: null,
    lotAreaSqft: lot, existingBldgAreaSqft: built, builtFar: Math.round((built / lot) * 100) / 100,
    residFar: standardFar, affResFar: bonusFar, standardFar, uapFar: bonusFar,
    maxStandardZfa, unusedStandardZfa, maxUapZfa, unusedUapZfa, achievableUapZfa: maxUapZfa,
    listPrice, pricePerBuildableZfa: listPrice === null ? null : Math.round(listPrice / maxStandardZfa), uapPricePerBuildableZfa: ppb,
    existingPricePerSqft: listPrice === null ? null : Math.round(listPrice / built),
    grossBuildableSqft: gross, maxBuildableUnits: Math.floor((gross * 0.82) / 700),
    pricePerBuildableUnit: listPrice === null ? null : Math.round(listPrice / Math.floor((gross * 0.82) / 700)),
    similarComps: [],
    flashcardValuation: {
      dealVerdict: verdict, impliedYieldOnCostPct: yieldPct, impliedCondoMarginPct: yieldPct === null ? null : Math.round((yieldPct - 4.2) * 70) / 10,
      estimatedRedevValue: Math.round(gross * 0.82 * 900), valueDriver: { exit: "rental", program: "uap" },
      slidingScalePricePerBsf: { ...SCALE, greatDealMaxLandValue: maxUapZfa * SCALE.greatDealMaxBsf, goodDealMaxLandValue: maxUapZfa * SCALE.goodDealMaxBsf }, basis: [],
    },
  };
});

// Best deals: by tier, then in the order the examples are listed.
const SORT = {
  best_deal: (d) => ["great_deal", "good_deal", "fair_deal", "unpriced_opportunity", "full_price"].indexOf(d.flashcardValuation.dealVerdict) * 1e6 + DEALS.indexOf(d),
  uap_price_per_buildable_zfa: (d) => d.uapPricePerBuildableZfa ?? Infinity,
  any_use_price_per_buildable_zfa: (d) => d.uapPricePerBuildableZfa ?? Infinity,
  unused_uap_zfa: (d) => -d.unusedUapZfa,
  implied_yield_on_cost: (d) => -(d.flashcardValuation.impliedYieldOnCostPct ?? -1),
  implied_condo_margin: (d) => -(d.flashcardValuation.impliedCondoMarginPct ?? -1),
};

// The deal store's search over the example rows: the filters the Explore view sends, then its sort.
export function searchDeals(params) {
  const num = (k) => (params.has(k) ? Number(params.get(k)) : null);
  const box = params.get("bounds")?.split(",").map(Number);
  const tiers = params.get("dealVerdict")?.split(",");
  const styles = params.getAll("styles").flatMap((s) => s.split(","));
  const zoning = params.get("zoningPrefix");
  const area = params.get("area")?.toLowerCase();
  const rows = DEALS.filter((d) =>
    (!params.get("borough") || d.borough === params.get("borough")) &&
    (!tiers || tiers.includes(d.flashcardValuation.dealVerdict)) &&
    (!styles.length || styles.includes(d.style)) &&
    (!zoning || d.zoningDistrict.startsWith(zoning)) &&
    (!area || [d.neighborhood, d.zipCode, d.address].some((v) => v.toLowerCase().includes(area))) &&
    (num("minListPrice") === null || d.listPrice === null || d.listPrice >= num("minListPrice")) &&
    (num("maxListPrice") === null || (d.listPrice !== null && d.listPrice <= num("maxListPrice"))) &&
    (num("maxPricePerBuildableZfa") === null || (d.uapPricePerBuildableZfa !== null && d.uapPricePerBuildableZfa <= num("maxPricePerBuildableZfa"))) &&
    (num("minLotArea") === null || d.lotAreaSqft >= num("minLotArea")) &&
    (num("maxLotArea") === null || d.lotAreaSqft <= num("maxLotArea")) &&
    (num("minHeadroomFar") === null || d.unusedUapZfa / d.lotAreaSqft >= num("minHeadroomFar")) &&
    (!box || (d.latitude >= box[0] && d.longitude >= box[1] && d.latitude <= box[2] && d.longitude <= box[3])));
  const key = SORT[params.get("sortBy")] || SORT.best_deal;
  return rows.sort((a, b) => key(a) - key(b));
}
