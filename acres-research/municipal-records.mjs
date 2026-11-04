import {requestSignal,throwIfCancelled} from './execution-context.mjs';
import {addressIdentity} from './parcels.mjs';
// Multi-city deep-coverage parcel, zoning, and municipal record adapters outside NYC:
// - Miami & Miami-Dade County, FL (US-FL-MIAMI, US-FL-MIAMIBEACH, US-FL-CORALGABLES, US-FL-MIAMI_DADE)
//   Dual-layer lookup: Miami-Dade Property Appraiser / GIS parcel layer + City of Miami "Miami 21"
//   Transect zoning rules + Florida Live Local Act (Fla. Stat. § 166.04151(7), SB 102 / SB 328).
// - Fort Lauderdale / Broward County, FL (US-FL-FORTLAUDERDALE)
//   Fort Lauderdale GIS zoning & parcel rules (ULDR Ch. 47) + Florida Live Local Act analysis.
// - New Haven, CT (US-CT-NEWHAVEN)
//   Connecticut CAMA/Parcel GIS + New Haven Zoning Ordinance (Title III) dimensional rules.

import {detectJurisdiction} from './jurisdiction.mjs';

const round = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(d)) : null);

export const SUPPORTED_MUNICIPAL_JURISDICTIONS = new Set([
  'US-FL-MIAMI',
  'US-FL-MIAMIBEACH',
  'US-FL-CORALGABLES',
  'US-FL-FORTLAUDERDALE',
  'US-CT-NEWHAVEN',
]);

// Curated Miami 21 Transect Zone rules (City of Miami Zoning Code, Article 4 Table 2 & Article 5)
export const MIAMI_21_ZONES = {
  'T3-R': {
    code: 'T3-R',
    name: 'Sub-Urban Transect: Restricted',
    maxStories: 2,
    maxDensityUnitsPerAcre: 9,
    baseFlr: null,
    publicBenefitsBonusMaxFlr: null,
    maxLotCoveragePercent: 50,
    frontSetbackFeet: 20,
    rearSetbackFeet: 20,
    sideSetbackFeet: 5,
    allowsCommercialOrMixedUse: false,
    citation: 'Miami 21 Code Art. 4, Table 2 & Art. 5 § 5.3 (Sub-Urban Transect Zones)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T4-R': {
    code: 'T4-R',
    name: 'General Urban Transect: Restricted',
    maxStories: 3,
    maxDensityUnitsPerAcre: 36,
    baseFlr: null,
    publicBenefitsBonusMaxFlr: null,
    maxLotCoveragePercent: 60,
    frontSetbackFeet: 10,
    rearSetbackFeet: 20,
    sideSetbackFeet: 5,
    allowsCommercialOrMixedUse: false,
    citation: 'Miami 21 Code Art. 4, Table 2 & Art. 5 § 5.4 (General Urban Transect Zones)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T4-L': {
    code: 'T4-L',
    name: 'General Urban Transect: Limited',
    maxStories: 3,
    maxDensityUnitsPerAcre: 36,
    baseFlr: null,
    publicBenefitsBonusMaxFlr: null,
    maxLotCoveragePercent: 60,
    frontSetbackFeet: 10,
    rearSetbackFeet: 20,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2 & Art. 5 § 5.4 (General Urban Transect Zones)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T5-R': {
    code: 'T5-R',
    name: 'Urban Center Transect: Restricted',
    maxStories: 5,
    maxDensityUnitsPerAcre: 65,
    baseFlr: null,
    publicBenefitsBonusMaxFlr: null,
    maxLotCoveragePercent: 70,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: false,
    citation: 'Miami 21 Code Art. 4, Table 2 & Art. 5 § 5.5 (Urban Center Transect Zones)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T5-O': {
    code: 'T5-O',
    name: 'Urban Center Transect: Open',
    maxStories: 5,
    bonusMaxStoriesTransitOrAffordability: 6,
    maxDensityUnitsPerAcre: 65,
    todOrAttainableMaxDensityUnitsPerAcre: 130,
    baseFlr: null,
    publicBenefitsBonusMaxFlr: null,
    maxLotCoveragePercent: 70,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2 & Art. 5 § 5.5 (Urban Center Transect Zones)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T6-8-O': {
    code: 'T6-8-O',
    name: 'Urban Core Transect: 8 Stories Open',
    maxStories: 8,
    bonusMaxStoriesPublicBenefits: 12,
    maxDensityUnitsPerAcre: 150,
    baseFlr: 5.0,
    publicBenefitsBonusMaxFlr: 6.25,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2, Art. 3 § 3.14 (Public Benefits) & Art. 5 § 5.6.1 (T6-8)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T6-12-O': {
    code: 'T6-12-O',
    name: 'Urban Core Transect: 12 Stories Open',
    maxStories: 12,
    bonusMaxStoriesPublicBenefits: 20,
    maxDensityUnitsPerAcre: 150,
    baseFlr: 8.0,
    publicBenefitsBonusMaxFlr: 10.4,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2, Art. 3 § 3.14 (Public Benefits +30% FLR) & Art. 5 § 5.6.2 (T6-12)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T6-24A-O': {
    code: 'T6-24A-O',
    name: 'Urban Core Transect: 24 Stories (A) Open',
    maxStories: 24,
    bonusMaxStoriesPublicBenefits: 48,
    maxDensityUnitsPerAcre: 150,
    baseFlr: 7.0,
    publicBenefitsBonusMaxFlr: 9.1,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2, Art. 3 § 3.14 (Public Benefits +30% FLR) & Art. 5 § 5.6.3 (T6-24a)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T6-24B-O': {
    code: 'T6-24B-O',
    name: 'Urban Core Transect: 24 Stories (B) Open',
    maxStories: 24,
    bonusMaxStoriesPublicBenefits: 48,
    maxDensityUnitsPerAcre: 150,
    baseFlr: 16.0,
    publicBenefitsBonusMaxFlr: 22.4,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2, Art. 3 § 3.14 (Public Benefits +40% FLR) & Art. 5 § 5.6.3 (T6-24b)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T6-36A-O': {
    code: 'T6-36A-O',
    name: 'Urban Core Transect: 36 Stories (A) Open',
    maxStories: 36,
    bonusMaxStoriesPublicBenefits: 60,
    maxDensityUnitsPerAcre: 150,
    baseFlr: 12.0,
    publicBenefitsBonusMaxFlr: 16.8,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2, Art. 3 § 3.14 & Art. 5 § 5.6.4 (T6-36)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T6-48A-O': {
    code: 'T6-48A-O',
    name: 'Urban Core Transect: 48 Stories (A) Open',
    maxStories: 48,
    bonusMaxStoriesPublicBenefits: 80,
    maxDensityUnitsPerAcre: 500,
    baseFlr: 11.0,
    publicBenefitsBonusMaxFlr: 16.5,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2, Art. 3 § 3.14 & Art. 5 § 5.6.5 (T6-48)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'T6-80-O': {
    code: 'T6-80-O',
    name: 'Urban Core Transect: 80 Stories (Metromover Core) Open',
    maxStories: 80,
    bonusMaxStoriesPublicBenefits: null,
    maxDensityUnitsPerAcre: 1000,
    baseFlr: 24.0,
    publicBenefitsBonusMaxFlr: 36.0,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 15,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2, Art. 3 § 3.14 (+50% FLR) & Art. 5 § 5.6.6 (T6-80)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
  'D1': {
    code: 'D1',
    name: 'Work Place District Transect',
    maxStories: 8,
    maxDensityUnitsPerAcre: 36,
    baseFlr: 2.0,
    publicBenefitsBonusMaxFlr: null,
    maxLotCoveragePercent: 80,
    frontSetbackFeet: 10,
    rearSetbackFeet: 0,
    sideSetbackFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'Miami 21 Code Art. 4, Table 2 & Art. 5 § 5.7 (Work Place District D1/D2/D3)',
    url: 'https://library.municode.com/fl/miami/codes/code_of_ordinances',
  },
};

// Curated Fort Lauderdale ULDR (Chapter 47) Zoning Districts
export const FORT_LAUDERDALE_ZONES = {
  'RAC-CC': {
    code: 'RAC-CC',
    name: 'Downtown Regional Activity Center: City Center',
    maxFar: null,
    maxHeightFeet: null,
    maxStories: null,
    heightNote: 'No fixed numeric height cap in RAC-CC; subject to FAA Part 77 airport flight-path limits, Downtown Master Plan tower stepbacks, and floorplate limits (12,500–18,000 sq ft residential tower plate).',
    maxDensityUnitsPerAcre: null,
    densityNote: 'Allocated from the Downtown RAC pool of authorized dwelling units via Development Review Committee (DRC) Site Plan Level II/III approval.',
    allowsCommercialOrMixedUse: true,
    citation: 'Fort Lauderdale ULDR § 47-13.20 & Downtown Master Plan',
    url: 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code',
  },
  'RAC-UV': {
    code: 'RAC-UV',
    name: 'Downtown Regional Activity Center: Urban Village',
    maxFar: null,
    maxHeightFeet: 150,
    maxStories: 12,
    maxDensityUnitsPerAcre: null,
    allowsCommercialOrMixedUse: true,
    citation: 'Fort Lauderdale ULDR § 47-13.20 (Downtown RAC-UV)',
    url: 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code',
  },
  'NWRAC-MUe': {
    code: 'NWRAC-MUe',
    name: 'Northwest Regional Activity Center: Mixed Use East',
    maxFar: null,
    maxHeightFeet: 65,
    bonusMaxHeightFeetAffordable: 110,
    maxDensityUnitsPerAcre: 50,
    allowsCommercialOrMixedUse: true,
    citation: 'Fort Lauderdale ULDR § 47-13.30 (NWRAC-MUe)',
    url: 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code',
  },
  'B-1': {
    code: 'B-1',
    name: 'Boulevard Business District',
    maxFar: null,
    maxHeightFeet: 150,
    maxDensityUnitsPerAcre: 50,
    allowsCommercialOrMixedUse: true,
    citation: 'Fort Lauderdale ULDR § 47-6.10 & § 47-6.20 (Business Districts)',
    url: 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code',
  },
  'RM-15': {
    code: 'RM-15',
    name: 'Residential Multifamily Low Rise / Medium Density',
    maxFar: null,
    maxHeightFeet: 35,
    maxDensityUnitsPerAcre: 15,
    allowsCommercialOrMixedUse: false,
    citation: 'Fort Lauderdale ULDR § 47-5.35 (RM-15)',
    url: 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code',
  },
  'RM-25': {
    code: 'RM-25',
    name: 'Residential Multifamily Mid Rise / Medium-High Density',
    maxFar: null,
    maxHeightFeet: 55,
    maxDensityUnitsPerAcre: 25,
    allowsCommercialOrMixedUse: false,
    citation: 'Fort Lauderdale ULDR § 47-5.36 (RM-25)',
    url: 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code',
  },
  'RM-45': {
    code: 'RM-45',
    name: 'Residential Multifamily High Rise / High Density',
    maxFar: null,
    maxHeightFeet: 150,
    maxDensityUnitsPerAcre: 45,
    allowsCommercialOrMixedUse: false,
    citation: 'Fort Lauderdale ULDR § 47-5.37 (RM-45)',
    url: 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code',
  },
};

// Curated New Haven, CT Zoning Ordinance Districts (Title III)
export const NEW_HAVEN_ZONES = {
  'RM-1': {
    code: 'RM-1',
    name: 'Low-Middle Density Multifamily Residence',
    maxFar: 0.5,
    maxHeightFeet: 35,
    maxStories: 3,
    minLotAreaPerUnitSqft: 2700,
    maxBuildingCoveragePercent: 30,
    frontYardFeet: 20,
    rearYardFeet: 25,
    sideYardFeet: '8 ft min (18 ft combined)',
    allowsCommercialOrMixedUse: false,
    citation: 'New Haven Zoning Ordinance Art. III § 13 & Art. V § 42 (Bulk & Area Table)',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
  'RM-2': {
    code: 'RM-2',
    name: 'High-Middle Density Multifamily Residence',
    maxFar: 0.7,
    maxHeightFeet: 45,
    maxStories: 4,
    minLotAreaPerUnitSqft: 1750,
    maxBuildingCoveragePercent: 30,
    frontYardFeet: 15,
    rearYardFeet: 25,
    sideYardFeet: '8 ft min (18 ft combined)',
    allowsCommercialOrMixedUse: false,
    citation: 'New Haven Zoning Ordinance Art. III § 14 & Art. V § 42',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
  'RH-1': {
    code: 'RH-1',
    name: 'High Density Multifamily Residence',
    maxFar: 2.0,
    maxHeightFeet: null,
    minLotAreaPerUnitSqft: 1000,
    maxBuildingCoveragePercent: 30,
    frontYardFeet: 15,
    rearYardFeet: 25,
    sideYardFeet: 10,
    allowsCommercialOrMixedUse: false,
    citation: 'New Haven Zoning Ordinance Art. III § 15 & Art. V § 42',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
  'RH-2': {
    code: 'RH-2',
    name: 'High Density Central Multifamily Residence',
    maxFar: 3.2,
    maxHeightFeet: null,
    minLotAreaPerUnitSqft: 700,
    maxBuildingCoveragePercent: 35,
    frontYardFeet: 15,
    rearYardFeet: 25,
    sideYardFeet: 10,
    allowsCommercialOrMixedUse: false,
    citation: 'New Haven Zoning Ordinance Art. III § 16 & Art. V § 42',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
  'BA': {
    code: 'BA',
    name: 'General Business District',
    maxFar: 2.0,
    maxHeightFeet: 60,
    minLotAreaPerUnitSqft: 1000,
    maxBuildingCoveragePercent: 75,
    frontYardFeet: 0,
    rearYardFeet: 20,
    sideYardFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'New Haven Zoning Ordinance Art. V § 42 & § 43 (Business Districts)',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
  'BD': {
    code: 'BD',
    name: 'Central Business District (Downtown New Haven)',
    maxFar: 6.0,
    maxHeightFeet: null,
    minLotAreaPerUnitSqft: null,
    maxBuildingCoveragePercent: 100,
    frontYardFeet: 0,
    rearYardFeet: 0,
    sideYardFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'New Haven Zoning Ordinance Art. V § 43 (Central Business District BD / BD-1 / BD-2 / BD-3)',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
  'BD-1': {
    code: 'BD-1',
    name: 'Central Business / Medical Mixed-Use District',
    maxFar: 6.0,
    maxHeightFeet: null,
    minLotAreaPerUnitSqft: null,
    maxBuildingCoveragePercent: 100,
    frontYardFeet: 0,
    rearYardFeet: 0,
    sideYardFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'New Haven Zoning Ordinance Art. V § 43 (BD-1)',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
  'MU': {
    code: 'MU',
    name: 'Mixed-Use District (Route 34 / Downtown Crossing)',
    maxFar: 6.0,
    maxHeightFeet: 180,
    minLotAreaPerUnitSqft: null,
    maxBuildingCoveragePercent: 90,
    frontYardFeet: 0,
    rearYardFeet: 0,
    sideYardFeet: 0,
    allowsCommercialOrMixedUse: true,
    citation: 'New Haven Zoning Ordinance Art. V § 44.1 (MU Mixed-Use District)',
    url: 'https://library.municode.com/ct/new_haven/codes/zoning',
  },
};

export function evaluateFloridaLiveLocalAct({lotAreaSqft = null, allowsCommercialOrMixedUse = true, municipality = 'Miami, FL', maxMunicipalDensityPerAcre = 150, maxMunicipalFlr = 12.0} = {}) {
  const acres = lotAreaSqft && lotAreaSqft > 0 ? round(lotAreaSqft / 43560, 4) : null;
  const preemptedUnits = acres ? Math.floor(acres * maxMunicipalDensityPerAcre) : null;
  const preemptedFlr = round(maxMunicipalFlr * 1.5, 2);
  const preemptedFloorAreaSqft = lotAreaSqft && lotAreaSqft > 0 ? round(lotAreaSqft * preemptedFlr) : null;
  return {
    statute: 'Florida Live Local Act, Fla. Stat. § 166.04151(7) (SB 102 [2023] as amended by SB 328 [2024])',
    statuteUrl: 'https://www.flsenate.gov/Laws/Statutes/2024/166.04151',
    eligibleByZoningCategory: Boolean(allowsCommercialOrMixedUse),
    affordabilityMandate: 'At least 40% of residential units must be rental units restricted to <= 120% of Area Median Income (AMI) for at least 30 years; in mixed-use projects, at least 65% of total square footage must be residential.',
    statutoryPreemptions: {
      useAndApproval: 'Administrative approval mandatory and preempts public hearings, conditional use permits, rezonings, and Miami 21 / ULDR warrant or variance approvals when code setbacks/design rules are met.',
      densityPreemption: `Highest currently allowed residential density in ${municipality} (${maxMunicipalDensityPerAcre} units/acre, excluding bonus densities)${preemptedUnits !== null ? ` = ${preemptedUnits} units on ${lotAreaSqft.toLocaleString()} sq ft (${acres} acres)` : ''}.`,
      floorAreaRatioPreemption: `150% of the highest currently allowed FAR/FLR in ${municipality} (SB 328 amendment: 150% × ${maxMunicipalFlr} = ${preemptedFlr} FLR/FAR)${preemptedFloorAreaSqft !== null ? ` = ${preemptedFloorAreaSqft.toLocaleString()} sq ft` : ''}.`,
      heightPreemption: 'Highest currently allowed building height for a commercial or residential development within 1 mile of the subject parcel within the municipality (or 3 stories, whichever is higher), subject to SB 328 single-family adjacency step-down (if abutting single-family on 2+ sides with >=25 homes, height is capped at 150% of tallest adjacent building or 3 stories).',
      parkingReductionSb328: 'Mandatory 20% parking reduction within 0.5 miles of a major transit stop, and 100% parking elimination within a Transit-Oriented Development (TOD) area.',
      adValoremTaxExemption: 'Fla. Stat. § 196.1978(3) ("Missing Middle" property tax exemption): 75% property tax exemption on units at 80%–120% AMI, and 100% exemption on units <= 80% AMI (for projects with 70+ affordable units).',
    },
  };
}

export function normalizeMiami21Code(rawCode) {
  if (!rawCode) return null;
  const s = String(rawCode).trim().toUpperCase().replace(/\s+/g, '-');
  if (MIAMI_21_ZONES[s]) return s;
  for (const key of Object.keys(MIAMI_21_ZONES)) {
    if (s.startsWith(key.replace(/-O$|-L$|-R$/, ''))) return key;
  }
  return s;
}

async function defaultHttpJson(url, timeoutMs = 10000) {
  const res = await fetch(url, {
    headers: {Accept: 'application/json', 'User-Agent': 'ArosaResearch/1.0'},
    signal: requestSignal(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Geocode a street address using the US Census Geocoder (public, no key required)
async function geocodeUsCensus(address, request = defaultHttpJson) {
  try {
    const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
    url.searchParams.set('address', address);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('format', 'json');
    const data = await request(url.href, 8000);
    const match = data?.result?.addressMatches?.[0];
    if (!match?.coordinates) return null;
    return {
      matchedAddress: match.matchedAddress,
      longitude: Number(match.coordinates.x),
      latitude: Number(match.coordinates.y),
    };
  } catch {
    return null;
  }
}

function municipalAddressIdentity(address) {
  const [first,...suffixes]=String(address||'').split(',').map(part=>part.trim());
  const unitMarker=/^(?:(?:APT|UNIT|SUITE|STE)(?=\b|\d)|#)/i;
  const inline=first.match(/^(.*?)\s+((?:(?:APT|UNIT|SUITE|STE)(?=\b|\d)|#).*)$/i);
  const street=addressIdentity(inline?inline[1]:first);
  // Locality segments are ignored only after retaining explicit unit suffixes.
  const units=[...(inline?[inline[2]]:[]),...suffixes.filter(part=>unitMarker.test(part))].map(part=>
    part.match(/^(?:(?:APT|UNIT|SUITE|STE)\.?\s*#?\s*|#\s*)([A-Z0-9][A-Z0-9/-]*)$/i)?.[1].toUpperCase()||null);
  const unresolvedUnit=units.some(unit=>unit===null)||new Set(units).size>1;
  return {key:street?(units.length?`${street} UNIT ${units[0]}`:street):null,unresolvedUnit};
}
function selectParcel(data, {address, identifier, idOf, idsOf = row => [idOf(row)], addressOf, normalizeId = value => String(value || '').trim().toUpperCase()}) {
  const rows = (data?.features || []).map(feature => feature.attributes).filter(Boolean);
  const wantedId = identifier ? normalizeId(identifier) : null;
  const wantedAddress = municipalAddressIdentity(address);
  const candidates = rows.map(row => ({id: idOf(row) || null, address: addressOf(row) || null}));
  const addressMatches = row => {
    const candidate = municipalAddressIdentity(addressOf(row));
    return Boolean(wantedAddress.key) && !wantedAddress.unresolvedUnit && !candidate.unresolvedUnit && candidate.key === wantedAddress.key;
  };
  const matches = rows.filter(row => wantedId
    ? idsOf(row).some(id => normalizeId(id) === wantedId)
    : addressMatches(row));
  const incomplete = Boolean(data?.exceededTransferLimit) || rows.length >= 5;
  const conflict = matches.length === 1 && wantedId && (wantedAddress.key || wantedAddress.unresolvedUnit) && !addressMatches(matches[0]);
  const status = conflict ? 'identity_conflict' : matches.length > 1 || (!wantedId && incomplete) ? 'ambiguous'
    : matches.length === 1 ? 'matched' : incomplete ? 'incomplete' : 'not_found';
  return {row: status === 'matched' ? matches[0] : null, resolution: {status, candidates, incomplete}};
}

export async function lookupMiamiDadeParcel({address, folio, zoningCode, lotAreaSqft, request = defaultHttpJson} = {}) {
  if(folio && !/^\d{13}$/.test(String(folio).replace(/[\s-]/g,'')))throw new Error('Use a valid 13-digit Miami-Dade folio.');
  const streetPart = String(address || '').split(',')[0].trim().toUpperCase().replace(/'/g, '');
  let parcelRecord = null;
  let parcelSourceUrl = 'https://www.miamidade.gov/Apps/PA/propertysearch/';
  let zoningLayerCode = zoningCode || null;
  let parcelResolution = {status: 'not_requested', candidates: [], incomplete: false};

  // 1. Try Miami-Dade GIS PropertySearch REST endpoint
  if (folio || streetPart) {
    try {
      const url = new URL('https://gisweb.miamidade.gov/arcgis/rest/services/PropertySearch/MD_PropertySearch/MapServer/0/query');
      const cleanFolio = folio ? String(folio).replace(/\D/g, '') : null;
      const where = cleanFolio
        ? `FOLIO='${cleanFolio}'`
        : `UPPER(TRUE_SITE_ADDR) LIKE '${streetPart}%'`;
      url.searchParams.set('where', where);
      url.searchParams.set('outFields', '*');
      url.searchParams.set('f', 'json');
      url.searchParams.set('resultRecordCount', '5');
      const data = await request(url.href, 9000);
      throwIfCancelled();
      const selected = selectParcel(data, {address, identifier: folio, idOf: row => row.FOLIO, addressOf: row => row.TRUE_SITE_ADDR, normalizeId: value => String(value || '').replace(/[^0-9]/g, '')});
      parcelResolution = {...selected.resolution, queryUrl: url.href};
      const feat = selected.row;
      if (feat) {
        parcelSourceUrl = url.href;
        parcelRecord = {
          folio: feat.FOLIO || cleanFolio || null,
          address: feat.TRUE_SITE_ADDR || address,
          municipality: feat.MUNICIPALITY || 'MIAMI',
          ownerName: [feat.TRUE_OWNER1, feat.TRUE_OWNER2].filter(Boolean).join(' / ') || null,
          lotAreaSqft: Number(feat.LOT_SIZE || lotAreaSqft || 0) || null,
          buildingAreaSqft: Number(feat.BUILDING_HEATED_AREA || feat.ADJUSTED_AREA || 0) || null,
          yearBuilt: Number(feat.YEAR_BUILT || 0) || null,
          floors: Number(feat.FLOOR_COUNT || 0) || null,
          units: Number(feat.UNIT_COUNT || 0) || null,
          assessedValueUsd: Number(feat.ASSESSED_VAL_CUR || 0) || null,
          dorUseCode: feat.DOR_CODE_CUR || null,
          dorUseDescription: feat.DOR_DESC || null,
          subdivision: feat.SUBDIVISION || null,
        };
      }
    } catch {throwIfCancelled();parcelResolution = {status: 'unavailable', candidates: [], incomplete: true};}
  }

  // 2. Try geocoding + City of Miami GIS Miami 21 zoning point query if zoningCode not yet resolved
  if (!zoningLayerCode && address) {
    const geo = await geocodeUsCensus(address, request);
    if (geo) {
      try {
        const zUrl = new URL('https://gis.miami.gov/arcgis/rest/services/Zoning/Miami21/MapServer/0/query');
        zUrl.searchParams.set('geometry', `${geo.longitude},${geo.latitude}`);
        zUrl.searchParams.set('geometryType', 'esriGeometryPoint');
        zUrl.searchParams.set('inSR', '4326');
        zUrl.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
        zUrl.searchParams.set('outFields', '*');
        zUrl.searchParams.set('f', 'json');
        const zData = await request(zUrl.href, 8000);
        const zAttr = zData?.features?.[0]?.attributes;
        if (zAttr) {
          zoningLayerCode = zAttr.M21_ZONE || zAttr.ZONING || zAttr.TRANSECT || null;
        }
      } catch {}
    }
  }

  const normZone = normalizeMiami21Code(zoningLayerCode);
  const zoneRules = normZone ? (MIAMI_21_ZONES[normZone] || null) : null;
  const effLotSqft = parcelRecord?.lotAreaSqft || Number(lotAreaSqft || 0) || null;
  const effAcres = effLotSqft ? round(effLotSqft / 43560, 4) : null;

  const envelopeCapacity = (zoneRules && effLotSqft) ? {
    lotAreaSqft: effLotSqft,
    lotAreaAcres: effAcres,
    baseFlr: zoneRules.baseFlr,
    baseMaxFloorAreaSqft: zoneRules.baseFlr ? round(effLotSqft * zoneRules.baseFlr) : null,
    publicBenefitsBonusMaxFlr: zoneRules.publicBenefitsBonusMaxFlr,
    publicBenefitsBonusMaxFloorAreaSqft: zoneRules.publicBenefitsBonusMaxFlr ? round(effLotSqft * zoneRules.publicBenefitsBonusMaxFlr) : null,
    maxAsOfRightUnits: zoneRules.maxDensityUnitsPerAcre ? Math.floor(effAcres * zoneRules.maxDensityUnitsPerAcre) : null,
    maxLotFootprintSqft: zoneRules.maxLotCoveragePercent ? round(effLotSqft * (zoneRules.maxLotCoveragePercent / 100)) : null,
    maxStoriesBase: zoneRules.maxStories,
    maxStoriesWithBonus: zoneRules.bonusMaxStoriesPublicBenefits || zoneRules.bonusMaxStoriesTransitOrAffordability || zoneRules.maxStories,
  } : null;

  const liveLocal = evaluateFloridaLiveLocalAct({
    lotAreaSqft: effLotSqft,
    allowsCommercialOrMixedUse: zoneRules ? zoneRules.allowsCommercialOrMixedUse : true,
    municipality: 'City of Miami, FL',
    maxMunicipalDensityPerAcre: 1000, // T6-80 allows up to 1,000 du/acre; outside Urban Core standard T6 allows 150 du/acre
    maxMunicipalFlr: 24.0,
  });

  return {
    jurisdiction: 'US-FL-MIAMI',
    adapter: 'miami_dade_and_miami21',
    parcelResolution,
    parcel: parcelRecord || {
      folio: folio || null,
      address: address || null,
      lotAreaSqft: effLotSqft,
      note: 'Live Miami-Dade GIS parcel match unavailable or requires exact folio/street number; computed zoning capacity from supplied parameters.',
    },
    parcelSourceUrl,
    zoningDistrict: normZone || zoningLayerCode || null,
    zoningRules: zoneRules,
    availableMiami21ZonesReference: Object.keys(MIAMI_21_ZONES),
    computedCapacity: envelopeCapacity,
    floridaLiveLocalActAnalysis: liveLocal,
    dualJurisdictionNote: 'City of Miami properties are governed by BOTH City of Miami "Miami 21" Transect zoning (plus Rapid Transit Zone [RTZ] jurisdiction under Miami-Dade County Code Ch. 33C when within the Metrorail/Metromover RTZ Subzone) AND Florida Live Local Act (Fla. Stat. § 166.04151(7)) state preemption.',
  };
}

export async function lookupFortLauderdaleParcel({address, folio, zoningCode, lotAreaSqft, request = defaultHttpJson} = {}) {
  let zoningLayerCode = zoningCode ? String(zoningCode).trim().toUpperCase() : null;
  let gisSourceUrl = 'https://library.municode.com/fl/fort_lauderdale/codes/unified_land_development_code';

  if (!zoningLayerCode && address) {
    const geo = await geocodeUsCensus(address, request);
    if (geo) {
      try {
        const zUrl = new URL('https://gis.fortlauderdale.gov/arcgis/rest/services/PlanningAndZoning/Zoning/MapServer/0/query');
        zUrl.searchParams.set('geometry', `${geo.longitude},${geo.latitude}`);
        zUrl.searchParams.set('geometryType', 'esriGeometryPoint');
        zUrl.searchParams.set('inSR', '4326');
        zUrl.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
        zUrl.searchParams.set('outFields', '*');
        zUrl.searchParams.set('f', 'json');
        const zData = await request(zUrl.href, 8000);
        const zAttr = zData?.features?.[0]?.attributes;
        if (zAttr) {
          gisSourceUrl = zUrl.href;
          zoningLayerCode = zAttr.ZONING || zAttr.ZONE_CLASS || zAttr.ZONE || null;
        }
      } catch {}
    }
  }

  const zoneRules = zoningLayerCode ? (FORT_LAUDERDALE_ZONES[zoningLayerCode] || null) : null;
  const effLotSqft = Number(lotAreaSqft || 0) || null;
  const effAcres = effLotSqft ? round(effLotSqft / 43560, 4) : null;
  const liveLocal = evaluateFloridaLiveLocalAct({
    lotAreaSqft: effLotSqft,
    allowsCommercialOrMixedUse: zoneRules ? zoneRules.allowsCommercialOrMixedUse : true,
    municipality: 'Fort Lauderdale, FL',
    maxMunicipalDensityPerAcre: 50,
    maxMunicipalFlr: 8.0,
  });

  return {
    jurisdiction: 'US-FL-FORTLAUDERDALE',
    adapter: 'fort_lauderdale_uldr',
    parcelResolution: {status: 'supplied_only', candidates: [], incomplete: true},
    parcel: {
      folio: folio || null,
      address: address || null,
      lotAreaSqft: effLotSqft,
      lotAreaAcres: effAcres,
    },
    gisSourceUrl,
    zoningDistrict: zoningLayerCode,
    zoningRules: zoneRules,
    availableFortLauderdaleZonesReference: Object.keys(FORT_LAUDERDALE_ZONES),
    computedCapacity: (zoneRules && effLotSqft) ? {
      lotAreaSqft: effLotSqft,
      lotAreaAcres: effAcres,
      maxHeightFeet: zoneRules.maxHeightFeet,
      maxAsOfRightUnits: zoneRules.maxDensityUnitsPerAcre ? Math.floor(effAcres * zoneRules.maxDensityUnitsPerAcre) : null,
    } : null,
    floridaLiveLocalActAnalysis: liveLocal,
  };
}

export async function lookupNewHavenParcel({address, parcelId, zoningCode, lotAreaSqft, request = defaultHttpJson} = {}) {
  const streetPart = String(address || '').split(',')[0].trim().toUpperCase().replace(/'/g, '');
  let parcelRecord = null;
  let gisSourceUrl = 'https://library.municode.com/ct/new_haven/codes/zoning';
  let zoningLayerCode = zoningCode ? String(zoningCode).trim().toUpperCase() : null;
  let parcelResolution = {status: 'not_requested', candidates: [], incomplete: false};

  if (streetPart || parcelId) {
    try {
      const url = new URL('https://cteco.uconn.edu/ctraster/rest/services/Parcels/CT_Parcels/MapServer/0/query');
      const id = String(parcelId || '').trim().replace(/'/g, "''");
      url.searchParams.set('where', `UPPER(Town_Name)='NEW HAVEN' AND ${id ? `(Parcel_ID='${id}' OR Link='${id}')` : `UPPER(Location) LIKE '${streetPart}%'`}`);
      url.searchParams.set('outFields', '*');
      url.searchParams.set('f', 'json');
      url.searchParams.set('resultRecordCount', '5');
      const data = await request(url.href, 9000);
      throwIfCancelled();
      const selected = selectParcel(data, {address, identifier: parcelId, idOf: row => row.Parcel_ID || row.Link, idsOf: row => [row.Parcel_ID,row.Link], addressOf: row => row.Location});
      parcelResolution = {...selected.resolution, queryUrl: url.href};
      const feat = selected.row;
      if (feat) {
        gisSourceUrl = url.href;
        parcelRecord = {
          parcelId: feat.Parcel_ID || feat.Link || null,
          address: feat.Location || address,
          municipality: 'New Haven, CT',
          ownerName: feat.Owner_Name || null,
          lotAreaSqft: feat.Shape_Area ? round(Number(feat.Shape_Area) * 10.7639) : (Number(lotAreaSqft || 0) || null),
          buildingAreaSqft: Number(feat.Living_Area || feat.Total_Area || 0) || null,
          yearBuilt: Number(feat.Year_Built || 0) || null,
          assessedValueUsd: Number(feat.Total_Assessment || 0) || null,
          zoningCodeFromCama: feat.Zone || feat.Zoning || null,
        };
        if (!zoningLayerCode && parcelRecord.zoningCodeFromCama) {
          zoningLayerCode = String(parcelRecord.zoningCodeFromCama).trim().toUpperCase();
        }
      }
    } catch {throwIfCancelled();parcelResolution = {status: 'unavailable', candidates: [], incomplete: true};}
  }

  const zoneRules = zoningLayerCode ? (NEW_HAVEN_ZONES[zoningLayerCode] || null) : null;
  const effLotSqft = parcelRecord?.lotAreaSqft || Number(lotAreaSqft || 0) || null;
  const computedCapacity = (zoneRules && effLotSqft) ? {
    lotAreaSqft: effLotSqft,
    maxFar: zoneRules.maxFar,
    maxFloorAreaSqft: zoneRules.maxFar ? round(effLotSqft * zoneRules.maxFar) : null,
    maxHeightFeet: zoneRules.maxHeightFeet,
    maxBuildingCoverageSqft: zoneRules.maxBuildingCoveragePercent ? round(effLotSqft * (zoneRules.maxBuildingCoveragePercent / 100)) : null,
    maxDwellingUnitsByLotArea: zoneRules.minLotAreaPerUnitSqft ? Math.floor(effLotSqft / zoneRules.minLotAreaPerUnitSqft) : null,
    inclusionaryZoningNote: 'New Haven Zoning Ordinance § 50 (Inclusionary Zoning): mandatory affordable set-aside (5%–10% of units at <= 50% AMI) in mapped IZO overlay zones, with density bonus and parking reduction incentives.',
  } : null;

  return {
    jurisdiction: 'US-CT-NEWHAVEN',
    adapter: 'new_haven_cama_and_zoning',
    parcelResolution,
    parcel: parcelRecord || {
      parcelId: parcelId || null,
      address: address || null,
      lotAreaSqft: effLotSqft,
    },
    gisSourceUrl,
    zoningDistrict: zoningLayerCode,
    zoningRules: zoneRules,
    availableNewHavenZonesReference: Object.keys(NEW_HAVEN_ZONES),
    computedCapacity,
  };
}

export const municipalParcelRecordsDefinition = {
  name: 'acres_municipal_parcel_records',
  description: 'Multi-city parcel, GIS, and zoning adapter for deep-coverage markets outside NYC: Miami / Miami-Dade County, FL (Miami-Dade Property Appraiser GIS + Miami 21 Transect zones + Florida Live Local Act SB 102/SB 328 preemption calculations), Fort Lauderdale, FL (ULDR Chapter 47 + Live Local Act), and New Haven, CT (CT CAMA/Parcel GIS + New Haven Title III Zoning Ordinance bulk & density calculations). Auto-records an authoritative citable source.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      address: {type: 'string', description: 'Street address with city and state (for example "1400 Biscayne Blvd, Miami, FL" or "360 State Street, New Haven, CT").'},
      jurisdiction: {type: 'string', description: 'Optional jurisdiction code (US-FL-MIAMI, US-FL-FORTLAUDERDALE, US-CT-NEWHAVEN). Auto-detected from address when omitted.'},
      folioOrParcelId: {type: 'string', description: 'Optional Miami-Dade/Broward 13-digit Folio or New Haven MBLU / Parcel ID.'},
      zoningCode: {type: 'string', description: 'Optional known zoning district code (for example "T6-24A-O", "T6-8-O", "RAC-CC", "BD-1", "RM-2") to compute exact envelope capacity.'},
      lotAreaSqft: {type: 'number', minimum: 100, maximum: 5000000, description: 'Optional lot area in sq ft to compute exact FAR/FLR floor area, unit density, and Florida Live Local Act preempted capacity.'},
    },
  },
};

export function createMunicipalRecordsTools({record = () => null, emit = () => {}, request = defaultHttpJson} = {}) {
  let latest = null;
  async function lookup(args = {}) {
    const det = args.jurisdiction
      ? {jurisdiction: String(args.jurisdiction).trim().toUpperCase()}
      : detectJurisdiction(args.address || '');
    const jur = det?.jurisdiction || 'US-FL-MIAMI';
    let data;
    if (jur.startsWith('US-FL-MIAMI') || jur === 'US-FL-CORALGABLES') {
      data = await lookupMiamiDadeParcel({
        address: args.address,
        folio: args.folioOrParcelId,
        zoningCode: args.zoningCode,
        lotAreaSqft: args.lotAreaSqft,
        request,
      });
    } else if (jur === 'US-FL-FORTLAUDERDALE') {
      data = await lookupFortLauderdaleParcel({
        address: args.address,
        folio: args.folioOrParcelId,
        zoningCode: args.zoningCode,
        lotAreaSqft: args.lotAreaSqft,
        request,
      });
    } else if (jur === 'US-CT-NEWHAVEN') {
      data = await lookupNewHavenParcel({
        address: args.address,
        parcelId: args.folioOrParcelId,
        zoningCode: args.zoningCode,
        lotAreaSqft: args.lotAreaSqft,
        request,
      });
    } else {
      throw new Error(`Unsupported municipal adapter jurisdiction: ${jur}. Supported: US-FL-MIAMI, US-FL-FORTLAUDERDALE, US-CT-NEWHAVEN.`);
    }

    throwIfCancelled();
    const srcUrl = data.zoningRules?.url || data.parcelSourceUrl || data.gisSourceUrl || 'https://library.municode.com/';
    const src = record({
      title: `Municipal Parcel & Zoning Adapter (${data.jurisdiction}${data.zoningDistrict ? `: ${data.zoningDistrict}` : ''})`,
      url: srcUrl,
      kind: 'zoning_envelope',
      verified: false,
      text: JSON.stringify(data),
    });

    const out = {
      ...data,
      sourceId: src?.id ?? null,
    };
    latest = out;
    emit('municipal_records.fetched', {jurisdiction: out.jurisdiction, zoningDistrict: out.zoningDistrict, sourceId: out.sourceId});
    return out;
  }

  return {
    definitions: [municipalParcelRecordsDefinition],
    handlers: {acres_municipal_parcel_records: lookup},
    get latest() { return latest; },
  };
}
