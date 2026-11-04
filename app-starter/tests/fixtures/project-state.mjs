// Fixtures shaped like GET /api/projects/:id/state. Field values follow the node
// schema of the producing research tools; figures are internally consistent but synthetic.
const T0 = Date.UTC(2026, 9, 15, 14, 0);
const agent = (tool, sources = [], extra = {}) => ({ tool, run: 'run_1', sources, ...extra });
const pluto = { title: 'NYC MapPLUTO 25v2', url: 'https://data.cityofnewyork.us/resource/64uk-42ks.json?bbl=3012340056', kind: 'property', retrievedAt: '2026-10-15T13:58:00Z' };
const zr = { title: 'NYC Zoning Resolution 23-22', url: 'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22', kind: 'zoning', retrievedAt: '2026-10-15T13:59:00Z' };
const rents = { title: 'StreetEasy rental market report, Crown Heights', url: 'https://streeteasy.com/blog/data-dashboard/', kind: 'market', retrievedAt: '2026-10-14T09:00:00Z' };

export const property = {
  borough: 'BK', address: '1234 FULTON STREET', zipcode: '11216', bbl: '3012340056', block: '1234', lot: '56',
  zonedist1: 'R7A', zonedist2: '', overlay1: 'C2-4', spdist1: '', lotarea: 5000, bldgarea: 3200, numfloors: 2,
  yearbuilt: 1925, bldgclass: 'K1', lotfront: 50, lotdepth: 100, builtfar: 0.64, residfar: 4, commfar: 2, facilfar: 4,
  affresfar: 5.01, landmark: '', histdist: 'Crown Heights North', splitzone: 'N', firm07_flag: '', pfirm15_flag: '1',
  edesignum: 'E-123', ownername: 'FULTON HOLDINGS LLC', ownertype: '', version: '25v2', latitude: 40.6803, longitude: -73.9502,
};

const capacity = {
  lotAreaSqft: 5000, builtFloorAreaSqft: 3200, builtFar: 0.64,
  byUse: {
    residential: { maxFar: 4, maxFloorAreaSqft: 20000, remainingFloorAreaSqft: 16800, apparentOverageSqft: 0, builtShare: 0.16 },
    commercial: { maxFar: 2, maxFloorAreaSqft: 10000, remainingFloorAreaSqft: 6800, apparentOverageSqft: 0, builtShare: 0.32 },
  },
  qualifyingAffordableOrUap: { maxFar: 5.01, maxFloorAreaSqft: 25050, remainingFloorAreaSqft: 21850 },
  zfaVsGfaGuidance: {
    overbuiltAgainstPlutoGfa: false,
    sensitivityBand: {
      plutoGrossBldgAreaSqft: 3200,
      assumedZfaAt85PercentGfaSqft: 2720, assumedZfaAt90PercentGfaSqft: 2880, assumedZfaAt95PercentGfaSqft: 3040, assumedZfaAt100PercentGfaSqft: 3200,
      residualByUseAt85PercentZfa: { residential: 17280, residentialAffordableOrUap: 22330 },
      residualByUseAt90PercentZfa: { residential: 17120, residentialAffordableOrUap: 22170 },
      residualByUseAt95PercentZfa: { residential: 16960, residentialAffordableOrUap: 22010 },
      residualByUseAt100PercentZfa: { residential: 16800, residentialAffordableOrUap: 21850 },
    },
  },
};

const envelope = {
  regime: 'residential', form: 'contextual', district: 'R7A', use: 'residential', affordable: false,
  lot: { areaSqft: 5000, widthFeet: 50, depthFeet: 100, type: 'interior', streets: [{ side: 'front', name: 'Fulton Street', widthFeet: 80, wide: true, assumedNarrow: false }, { side: 'rear', name: null, widthFeet: null, wide: false, assumedNarrow: true }] },
  floorArea: { maxFar: 4, maxFloorAreaSqft: 20000 },
  metrics: { storeys: 8, heightFeet: 85, floorAreaSqft: 19600, far: 3.92, remainingFloorAreaSqft: 400, stoppedBy: 'height' },
  density: { maxUnits: 29 },
  parking: { required: 0 },
  checks: ['rear street width unknown; narrow-street rules applied (ZR 12-10: a wide street is 75 ft or more).', 'Rear yard drawn as 20 ft up to 75 ft of height and 30 ft above, as curated from ZR 23-342; verify against the current text before relying on it.'],
  capacity,
  summary: { baseHeightMinFeet: 40, baseHeightMaxFeet: 75, maxBuildingHeightFeet: 85, setbackDepthFeet: 10, maxLotCoveragePercent: 65, rearYardFeet: 30, streetAssumption: 'front: wide, rear: narrow (assumed narrow)', maxDwellingUnits: 29 },
};

const fixtureLot = [[0, 0], [15.24, 0], [15.24, 30.48], [0, 30.48]];
const fixtureFootprint = [[2.286, 4.572], [12.954, 4.572], [12.954, 25.908], [2.286, 25.908]];
const fixtureLevels = (count, heightFeet, areaSqft) => Array.from({length: count}, (_, i) => ({
  label: `L${i + 1}`, levelId: `level-${i + 1}`, use: 'Residential', floorElevationFeet: i * heightFeet, heightFeet,
  areaSqft, footprint: fixtureFootprint.map(point => [...point]),
}));

const concepts = [
  {
    id: 'c-base', name: 'Envelope baseline', summary: 'Maximum as-of-right massing.', units: 'ft', version: 1, createdAt: T0,
    metrics: { storeys: 8, lotAreaSqft: 5000, grossFloorAreaSqft: 19600, far: 3.92, heightFeet: 85, units: 24, maxFar: 4, maxHeightFeet: 85 },
    lot: fixtureLot, levels: fixtureLevels(8, 10.625, 2450), compliance: { compliant: true, violations: [] },
  },
  {
    id: 'c-uap', name: 'UAP bonus scheme', summary: 'Adds the affordable bonus floor area.', units: 'ft', version: 2, createdAt: T0 + 3600000,
    metrics: { storeys: 10, lotAreaSqft: 5000, grossFloorAreaSqft: 24800, far: 4.96, heightFeet: 105, units: 31, maxFar: 5.01, maxHeightFeet: 105 },
    lot: fixtureLot, levels: fixtureLevels(10, 10.5, 2480),
    revision: { parentConceptId: 'c-base', parentName: 'Envelope baseline', version: 2, note: 'UAP bonus', deltas: { grossFloorAreaSqft: 5200, far: 1.04, heightFeet: 20, storeys: 2, units: 7 } },
    compliance: { compliant: false, violations: [{ level: 'L10', reason: 'Exceeds the 105 ft height limit by 2 ft' }] },
  },
];

const program = {
  productType: 'rental', residentialGrossSqft: 24800, efficiency: 0.82, netResidentialSqft: 20336, averageUnitSqft: 656, units: 31,
  allocatedNetSqft: 20100, unallocatedNetSqft: 236,
  byBedrooms: [
    { bedrooms: 0, label: 'Studio', mixPercent: 30, units: 9, unitSqft: 450, netSqft: 4050, rentPerSqftPerMonth: 6.2, monthlyRent: 2790, annualRent: 301320 },
    { bedrooms: 1, label: '1 bedroom', mixPercent: 50, units: 16, unitSqft: 650, netSqft: 10400, rentPerSqftPerMonth: 5.6, monthlyRent: 3640, annualRent: 698880 },
    { bedrooms: 2, label: '2 bedroom', mixPercent: 20, units: 6, unitSqft: 940, netSqft: 5640, rentPerSqftPerMonth: 5.1, monthlyRent: 4794, annualRent: 345168 },
  ],
  annualGrossPotentialRent: 1345368, blendedRentPerSqftPerMonth: 5.58,
  assumptions: ['Unit sizes follow the NYC market baseline for new rentals.', '82 percent efficiency from gross to net residential area.'],
};

const market = {
  submarket: 'Crown Heights',
  rents: [
    { bedrooms: 0, rentPerSqftPerMonth: 6.2, source: 'StreetEasy', retrievedAt: '2026-10-14T09:00:00Z', url: rents.url, basis: 'Median asking rent, new construction' },
    { bedrooms: 1, rentPerSqftPerMonth: 5.6, source: 'StreetEasy', retrievedAt: '2026-10-14T09:00:00Z', url: rents.url, basis: 'Median asking rent, new construction' },
  ],
  supply: { units: 1200, vacancyRate: 0.031 },
};

const proFormas = [{
  name: 'UAP rental', productType: 'rental',
  development: { landPrice: 4500000, hardCost: 11160000, softCost: 2455200, baseCost: 18115200, interestCarry: 1086912, totalDevelopmentCost: 19202112, loan: 12481373, equity: 6720739, effectiveLoanToCost: 0.65, costPerGrossSqft: 774 },
  operations: { grossPotentialRent: 1345368, vacancyLoss: 67268, effectiveGrossIncome: 1278100, operatingExpenses: 279000, noi: 999100, yieldOnCost: 0.052, capRate: 0.0475, developmentSpreadBps: 45, capitalizedValue: 21033684 },
  returns: { value: 21033684, profit: 1831572, unleveredReturnOnCost: 0.0954, leveredReturnOnEquity: 0.2725, equityMultiple: 1.27, debtServiceCoverage: 1.21 },
  sensitivity: {
    rent: [{ scenario: 'Rent -10%', totalDevelopmentCost: 19202112, noi: 879000, yieldOnCost: 0.0458, value: 18505263, profit: -696849, unleveredReturnOnCost: -0.0363, leveredReturnOnEquity: -0.1037 }],
    cost: [{ scenario: 'Cost +10%', totalDevelopmentCost: 21122323, noi: 999100, yieldOnCost: 0.0473, value: 21033684, profit: -88639, unleveredReturnOnCost: -0.0042, leveredReturnOnEquity: -0.012 }],
    capRateBps: [], entitlement: [],
  },
  inputs: { landPrice: 4500000, hardCostPerSqft: 450, softCostPerSqft: 99 },
  createdAt: T0 + 3600000,
}];

const entitlements = {
  district: 'R7A', lotAreaSqft: 5000,
  baseline: { governingFar: 4, greatestFar: 5.01, maxFloorAreaSqft: 20000, existingFloorAreaSqft: 3200, remainingFloorAreaSqft: 16800 },
  scenarios: [
    { id: 'as-of-right', name: 'As of right', approval: 'as-of-right', addedFloorAreaSqft: 16800, totalFloorAreaSqft: 20000, resultingFar: 4, timeMonths: [0, 0], conditions: [], citations: ['ZR 23-22'], risk: 'low', feasibilityScore: 95 },
    { id: 'universal-affordability-preference', name: 'Universal Affordability Preference', approval: 'as-of-right', addedFloorAreaSqft: 21850, totalFloorAreaSqft: 25050, resultingFar: 5.01, timeMonths: [0, 3], conditions: ['20 percent of floor area permanently affordable at 60 percent AMI'], citations: ['ZR 23-22'], risk: 'low', feasibilityScore: 88 },
    { id: 'zoning-map-amendment', name: 'Zoning map amendment', approval: 'ulurp', addedFloorAreaSqft: null, totalFloorAreaSqft: null, resultingFar: null, timeMonths: [18, 30], conditions: ['City Planning certification and Council vote'], citations: [], risk: 'high', feasibilityScore: 22 },
  ],
  note: 'Scenario floor areas are estimates.',
};

const comparisons = [{
  variants: [
    { label: 'As-of-right rental', productType: 'rental', entitlementScore: 95, entitlementRiskTier: 'low', approvalTimelineMonths: 0, profitAfterCarry: 950000, totalDevelopmentCost: 16000000, value: 16950000, profit: 950000, riskAdjustedProfit: 902500, unleveredReturnOnCost: 0.0594, leveredReturnOnEquity: 0.17, downsideRentMinus10Profit: -700000 },
    { label: 'UAP rental', productType: 'rental', entitlementScore: 88, entitlementRiskTier: 'low', approvalTimelineMonths: 2, profitAfterCarry: 1700000, totalDevelopmentCost: 19202112, value: 21033684, profit: 1831572, riskAdjustedProfit: 1496000, unleveredReturnOnCost: 0.0954, leveredReturnOnEquity: 0.2725, downsideRentMinus10Profit: -696849 },
  ],
  recommendation: { label: 'UAP rental', riskAdjustedProfit: 1496000, profitAfterCarry: 1700000, whatWouldChangeIt: ['Rents below $5.10 per sq ft per month', 'Hard cost above $495 per gross sq ft'] },
  note: 'Risk-adjusted profit weighs approval odds.', createdAt: T0 + 3600000,
}];

const plans = [{ name: 'Typical floor plan', takeoffs: { efficiency: 0.81, netSqft: 2050, grossSqft: 2530, checks: { total: 12, failed: ['Corridor width under 5 ft on L3'] } }, levels: [], hasIfc: false, createdAt: T0 + 3600000 }];

const floorplanAudits = [{ name: 'Existing building plan', summaryMetrics: { grossSqft: 3150, netSqft: 2480, efficiency: 0.79 } }];

const assumptions = {
  landPrice: 4500000, hardCostPerSqft: 450, softCostPerSqft: 99,
  financing: { loanToCost: 0.65, interestRate: 0.0725, termMonths: 30 },
  operating: { residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 9000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 12 },
  capRate: 0.0475, sellingCostRate: 0.05,
};

const field = (value, provenance, extra = {}) => ({ value, provenance, stale: null, updated: T0, ...extra });

export const fullState = {
  id: 'proj_1234', siteKey: 'nyc:3012340056', bbl: '3012340056', title: '1234 Fulton Street', owner: 'a'.repeat(24), version: 7, updated: T0 + 3600000,
  fields: {
    property: field(property, agent('acres_set_subject', [pluto])),
    places: field([{ id: 'p1', name: 'Nostrand Av (A, C)', type: 'subway', group: 'transit', distanceMeters: 240, direction: 'E' }], agent('acres_nearby_places')),
    envelope: field(envelope, agent('acres_zoning_envelope', [zr])),
    concepts: field(concepts, agent('acres_model_concept')),
    program: field(program, agent('acres_unit_mix', [rents])),
    market: field(market, agent('acres_market_inputs', [rents])),
    proFormas: field(proFormas, agent('acres_pro_forma', [], { derived: true }), { stale: 'assumptions' }),
    entitlements: field(entitlements, agent('acres_entitlement_scenarios', [zr])),
    comparisons: field(comparisons, agent('acres_compare_programs'), { stale: 'proFormas' }),
    plans: field(plans, agent('acres_plan_concept')),
    floorplanAudits: field(floorplanAudits, agent('acres_audit_floorplan')),
    assumptions: field(assumptions, { tool: 'user', sources: [] }, { updated: T0 + 7200000 }),
  },
};

// A freshly resolved parcel: the subject is set, nothing else has been computed yet.
export const subjectOnlyState = {
  id: 'proj_new', siteKey: 'nyc:1000010001', bbl: '1000010001', title: '1 Example Street', owner: 'a'.repeat(24), version: 1, updated: T0,
  fields: { property: field({ ...property, address: '1 EXAMPLE STREET', bbl: '1000010001', histdist: '', edesignum: '', pfirm15_flag: '' }, agent('acres_set_subject', [pluto])) },
};
