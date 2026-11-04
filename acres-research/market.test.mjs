import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketTools, normalizeMarketInputs, recommendUnitMix, allocate, BASELINES, deriveVelocityMix} from './market.mjs';
import {parseNycBbl, createNycPublicRecordsTools} from './nycdb.mjs';

const retrievedAt = '2026-10-12';
const inputs = {
  submarket: 'Financial District, Manhattan',
  rents: [
    {bedrooms: 0, rentPerSqftPerMonth: 8, source: 'StreetEasy market report', url: 'https://streeteasy.com/blog/data-dashboard/', retrievedAt, basis: 'Median studio asking rent $3,600 over 450 sq ft.'},
    {bedrooms: 1, rentPerSqftPerMonth: 7, source: 'StreetEasy market report', url: 'https://streeteasy.com/blog/data-dashboard/', retrievedAt},
    {bedrooms: 2, rentPerSqftPerMonth: 6.5, source: 'User', retrievedAt},
    {bedrooms: 3, rentPerSqftPerMonth: 6, source: 'User', retrievedAt},
  ],
  commercialRents: [{use: 'retail', rentPerSqftPerYear: 150, source: 'REBNY retail report', retrievedAt}],
  supply: {units: 24000, vacancyRate: 0.03, source: 'NYC HVS', retrievedAt},
  pipeline: {units: 1200, horizonYears: 3, source: 'DOB permits', retrievedAt},
  absorption: {unitsPerMonth: 40, source: 'User', retrievedAt},
};

test('records figures with sources, cites public URLs and derives the indicators', async () => {
  const events = [], recorded = [];
  const record = source => { recorded.push(source); return {id: recorded.length}; };
  const tools = createMarketTools({emit: (event, data) => events.push({event, data}), record});
  assert.deepEqual(tools.definitions.map(d => d.name), ['acres_market_inputs', 'acres_unit_mix', 'acres_market_comps', 'acres_search_deal_store']);
  const result = await tools.handlers.acres_market_inputs(inputs);
  assert.equal(result.submarket, 'Financial District, Manhattan');
  assert.equal(result.rents[0].sourceId, 1);
  assert.equal(result.rents[1].sourceId, 2);
  assert.equal(result.rents[2].sourceId, null);
  assert.equal(result.rents[0].basis, 'Median studio asking rent $3,600 over 450 sq ft.');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].kind, 'market');
  assert.match(recorded[0].title, /Financial District, Manhattan rents: StreetEasy/);
  // 1,200 pipeline units / 40 per month = 30 months; 1,200 / 24,000 = 5 percent; 24,000 × 3 percent = 720 vacant.
  assert.deepEqual(result.indicators, {monthsOfSupply: 30, pipelineShareOfSupply: 0.05, vacantUnits: 720});
  assert.equal(result.commercialRents[0].use, 'retail');
  assert.match(result.note, /nothing was estimated/);
  assert.equal(events[0].event, 'market.recorded');
  assert.equal(tools.market.rents.length, 4);
  const again = await tools.handlers.acres_market_inputs({submarket: 'Tribeca', absorption: {unitsPerMonth: 12, source: 'User', retrievedAt}});
  assert.equal(again.rents, undefined);
  assert.deepEqual(again.indicators, {});
  assert.equal(tools.market.submarket, 'Tribeca');
});

test('rejects malformed figures, unit mix-ups and missing provenance', () => {
  const ok = {source: 'User', retrievedAt};
  assert.throws(() => normalizeMarketInputs({submarket: 'X'}), /at least one section/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', rents: [{bedrooms: 1, rentPerSqftPerMonth: 84, ...ok}]}), /rents\[0\]\.rentPerSqftPerMonth must be a number from 1 to 30/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', rents: [{bedrooms: 1.5, rentPerSqftPerMonth: 7, ...ok}]}), /bedrooms must be a whole number/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', rents: [{bedrooms: 1, rentPerSqftPerMonth: 7, ...ok}, {bedrooms: 1, rentPerSqftPerMonth: 8, ...ok}]}), /one row per bedrooms/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', rents: [{bedrooms: 1, rentPerSqftPerMonth: 7, retrievedAt}]}), /rents\[0\]\.source is required/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', rents: [{bedrooms: 1, rentPerSqftPerMonth: 7, source: 'User', retrievedAt: '10/12/2026'}]}), /retrievedAt must be a date as YYYY-MM-DD/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', commercialRents: [{use: 'hotel', rentPerSqftPerYear: 100, ...ok}]}), /use must be one of retail, office, community_facility/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', supply: {units: 100.5, vacancyRate: 0.02, ...ok}}), /supply\.units must be a whole number/);
  assert.throws(() => normalizeMarketInputs({submarket: 'X', salePrices: [{bedrooms: 2, pricePerSqft: 20, ...ok}]}), /pricePerSqft must be a number from 100 to 15000/);
  const minimal = normalizeMarketInputs({submarket: 'X', absorption: {unitsPerMonth: 5, ...ok}});
  assert.deepEqual(minimal.absorption, {unitsPerMonth: 5, source: 'User', retrievedAt, url: null, basis: null});
});

test('the baseline rental unit mix for 100,000 gross sq ft, checked by hand', async () => {
  // Net area = 100,000 × 0.85 = 85,000 sq ft. Average unit = 0.30×450 + 0.45×550 + 0.25×800 = 135 + 247.5
  // + 200 = 582.5 sq ft. Units = floor(85,000 / 582.5) = 145. Shares 43.5 / 65.25 / 36.25 / 0 floor to
  // 43 / 65 / 36 / 0 = 144, and the largest remainder (.5) goes to studios: 44 / 65 / 36 / 0. Net = 19,800
  // + 35,750 + 28,800 = 84,350 sq ft. Monthly rents at the recorded $/sq ft: 3,600 / 3,850 / 5,200, and no
  // three-bedroom size. Monthly total = 158,400 + 250,250 + 187,200 = 595,850; annual = 7,150,200;
  // blended = 595,850 / 84,350 = 7.06 $/sq ft/month.
  const tools = createMarketTools();
  await tools.handlers.acres_market_inputs(inputs);
  const mix = await tools.handlers.acres_unit_mix({productType: 'rental', residentialGrossSqft: 100000});
  assert.equal(mix.netResidentialSqft, 85000);
  assert.equal(mix.averageUnitSqft, 582.5);
  assert.equal(mix.units, 145);
  assert.deepEqual(mix.byBedrooms.map(r => r.units), [44, 65, 36, 0]);
  assert.deepEqual(mix.byBedrooms.map(r => r.netSqft), [19800, 35750, 28800, 0]);
  assert.deepEqual(mix.byBedrooms.map(r => r.monthlyRent), [3600, 3850, 5200, null]);
  assert.equal(mix.byBedrooms[0].label, 'Studio');
  assert.equal(mix.byBedrooms[0].sourceId, null);
  assert.equal(tools.program.units, mix.units);
  assert.equal(tools.program.note, undefined);
  assert.equal(mix.allocatedNetSqft, 84350);
  assert.equal(mix.unallocatedNetSqft, 650);
  assert.equal(mix.annualGrossPotentialRent, 7150200);
  assert.equal(mix.blendedRentPerSqftPerMonth, 7.06);
  assert.equal(mix.assumptions.length, 4);
  assert.match(mix.assumptions[1], /planning baseline, not a market reading/);
  assert.match(mix.note, /650 net sq ft is left over/);
});

test('a mix that sums to 100 within the tolerance never allocates more units than exist, and null optional fields are accepted', () => {
  const mix = recommendUnitMix({productType: 'condo', residentialGrossSqft: 200000, mixPercent: [25, 25, 25, 25.5]});
  assert.equal(mix.byBedrooms.reduce((sum, r) => sum + r.units, 0), mix.units);
  const retrievedAt = '2026-10-12';
  const market = normalizeMarketInputs({submarket: 'X', rents: [{bedrooms: 1, rentPerSqftPerMonth: 7, source: 'User', retrievedAt, url: null, basis: null}]});
  assert.equal(market.rents[0].url, null);
});

test('supplied mix and sizes, condo prices, missing figures and allocation edge cases', async () => {
  const tools = createMarketTools();
  await tools.handlers.acres_market_inputs({submarket: 'Tribeca', salePrices: [{bedrooms: 1, pricePerSqft: 1800, source: 'User', retrievedAt}, {bedrooms: 2, pricePerSqft: 2000, source: 'User', retrievedAt}]});
  // 60,000 × 0.9 = 54,000 net; average = 0.5×800 + 0.5×1200 = 1,000; 54 units, 27 and 27; sellout = 27×800×1800 + 27×1200×2000 = 38,880,000 + 64,800,000.
  const condo = await tools.handlers.acres_unit_mix({productType: 'condo', residentialGrossSqft: 60000, efficiency: 0.9, mixPercent: [0, 50, 50, 0], unitSizesSqft: [550, 800, 1200, 1700], maxDwellingUnits: 60});
  // An omitted cap auto-fills from the envelope on file; an explicit cap overrides it.
  const cappedTools = createMarketTools({getMaxDwellingUnits: () => 40});
  const autoCapped = await cappedTools.handlers.acres_unit_mix({productType: 'condo', residentialGrossSqft: 60000, efficiency: 0.9, mixPercent: [0, 50, 50, 0], unitSizesSqft: [550, 800, 1200, 1700]});
  assert.equal(autoCapped.units, 40);
  assert.equal(autoCapped.maxDwellingUnits, 40);
  assert.match(autoCapped.note, /auto-filled from the zoning envelope on file: at most 40 dwelling units \(ZR 23-52\)/);
  const overridden = await cappedTools.handlers.acres_unit_mix({productType: 'condo', residentialGrossSqft: 60000, efficiency: 0.9, mixPercent: [0, 50, 50, 0], unitSizesSqft: [550, 800, 1200, 1700], maxDwellingUnits: 60});
  assert.equal(overridden.maxDwellingUnits, 60);
  assert.equal(condo.units, 54);
  assert.deepEqual(condo.byBedrooms.map(r => r.units), [0, 27, 27, 0]);
  assert.equal(condo.grossSellout, 103680000);
  assert.equal(condo.blendedPricePerSqft, 1920);
  assert.deepEqual(condo.assumptions, []);
  const unpriced = await tools.handlers.acres_unit_mix({productType: 'condo', residentialGrossSqft: 60000});
  assert.equal(unpriced.grossSellout, undefined);
  assert.match(unpriced.note, /No sale price figure for studio, three bedroom units/);
  const bare = recommendUnitMix({productType: 'rental', residentialGrossSqft: 20000});
  assert.equal(bare.byBedrooms[1].rentPerSqftPerMonth, null);
  assert.match(bare.note, /No rent figure/);
  assert.throws(() => recommendUnitMix({productType: 'hotel', residentialGrossSqft: 20000}), /rental or condo/);
  assert.throws(() => recommendUnitMix({productType: 'rental', residentialGrossSqft: 20000, mixPercent: [50, 50, 10, 0]}), /sum to 100/);
  assert.throws(() => recommendUnitMix({productType: 'rental', residentialGrossSqft: 20000, unitSizesSqft: [450, 650, 950]}), /four net unit sizes/);
  assert.throws(() => recommendUnitMix({productType: 'rental', residentialGrossSqft: 600}), /smaller than one unit/);
  assert.deepEqual(allocate(10, [25, 25, 25, 25]), [3, 3, 2, 2]);
  assert.deepEqual(allocate(7, [0, 100, 0, 0]), [0, 7, 0, 0]);
  for (const baseline of Object.values(BASELINES)) assert.equal(baseline.mixPercent.reduce((a, b) => a + b, 0), 100);
});

test('partial market updates for the same submarket merge sections instead of clobbering, and initialMarket hydrates follow-up unit mixes', async () => {
  const tools = createMarketTools({initialMarket: inputs});
  // Without calling acres_market_inputs again, unit mix uses hydrated initialMarket
  const hydratedMix = await tools.handlers.acres_unit_mix({productType: 'rental', residentialGrossSqft: 50000});
  assert.equal(hydratedMix.byBedrooms[0].rentPerSqftPerMonth, 8);
  assert.equal(tools.market, null, 'untouched market stays null for run aggregation');

  // Updating only salePrices for the same submarket preserves existing rents and indicators
  const updated = await tools.handlers.acres_market_inputs({
    submarket: 'Financial District, Manhattan',
    salePrices: [{bedrooms: 1, pricePerSqft: 1950, source: 'User', retrievedAt}],
  });
  assert.equal(updated.rents.length, 4, 'existing rents for same submarket must be preserved');
  assert.equal(updated.salePrices[0].pricePerSqft, 1950);
  assert.equal(updated.indicators.monthsOfSupply, 30);
});

test('acres_market_comps aggregates HomeHarvest comps, reports closed-sale sample mix, cites listings, and auto-populates market inputs', async () => {
  const recorded = [];
  const record = s => { recorded.push(s); return {id: recorded.length}; };
  const mockRunner = async ({location}) => ({
    location,
    retrievedAt: '2026-10-15',
    totalComps: 24,
    byBedrooms: {
      '0': {saleSampleCount: 2, closedSoldCount:2, condoCoopClosedSoldPriceSampleCount:2, medianCondoCoopClosedSoldPricePerSqft:1300, medianSalePrice: 650000, medianSaleSqft: 500, medianSalePricePerSqft: 1300, medianSaleDaysOnMls: 45, rentSampleCount: 3, medianRent: 3600, medianRentSqft: 450, medianRentPerSqftPerMonth: 8.0, medianRentDaysOnMls: 18},
      '1': {saleSampleCount: 6, closedSoldCount:6, condoCoopClosedSoldPriceSampleCount:6, medianCondoCoopClosedSoldPricePerSqft:1500, medianSalePrice: 1050000, medianSaleSqft: 700, medianSalePricePerSqft: 1500, medianSaleDaysOnMls: 22, rentSampleCount: 5, medianRent: 4900, medianRentSqft: 680, medianRentPerSqftPerMonth: 7.21, medianRentDaysOnMls: 14},
      '2': {saleSampleCount: 5, closedSoldCount:5, condoCoopClosedSoldPriceSampleCount:5, medianCondoCoopClosedSoldPricePerSqft:1636, medianSalePrice: 1800000, medianSaleSqft: 1100, medianSalePricePerSqft: 1636.36, medianSaleDaysOnMls: 28, rentSampleCount: 2, medianRent: 7200, medianRentSqft: 1000, medianRentPerSqftPerMonth: 7.2, medianRentDaysOnMls: 30},
      '3': {saleSampleCount: 1, closedSoldCount:1, medianSalePrice: 2800000, medianSaleSqft: 1600, medianSalePricePerSqft: 1750, medianSaleDaysOnMls: 75, rentSampleCount: 0},
    },
    sampleComps: [
      {address: '100 Wall St, New York, NY, 10005', style: 'CONDOS', beds: 1, baths: 1, sqft: 700, soldPrice: 1050000, pricePerSqft: 1500, daysOnMls: 22, url: 'https://www.realtor.com/realestateandhomes-detail/100-Wall-St'},
    ],
  });

  const tools = createMarketTools({record, compRunner: mockRunner});
  const res = await tools.handlers.acres_market_comps({location: '10005', submarket: 'Financial District'});
  assert.ok(Array.isArray(res.recommendedCondoMixByVelocity));
  assert.equal(res.recommendedCondoMixByVelocity.reduce((a, b) => a + b, 0), 100);
  // 1BR has the largest observed closed-sale sample; asking stock and DOM do not weight it.
  assert.ok(res.recommendedCondoMixByVelocity[1] > res.recommendedCondoMixByVelocity[0]);
  assert.ok(res.recommendedCondoMixByVelocity[1] > res.recommendedCondoMixByVelocity[3]);
  assert.ok(res.autoRecordedMarket, 'market inputs should be auto-populated from harvested comps');
  assert.equal(tools.market.submarket, 'Financial District');
  assert.equal(tools.market.salePrices.find(s => s.bedrooms === 1).pricePerSqft, 1500);
  assert.equal(tools.market.rents.find(r => r.bedrooms === 1).rentPerSqftPerMonth, 7.21);
  assert.ok(recorded.length >= 2, 'citable sources must be recorded for comp batches');
  assert.equal(deriveVelocityMix({}, 'sale'), null);
});

test('acres_nyc_public_records parses BBL, classifies prior plan submittal approvals vs disapprovals, and enriches ACRIS air rights', async () => {
  const parsed = parseNycBbl('1-00047-7501');
  assert.equal(parsed.bbl, '1000477501');
  assert.equal(parsed.boroughUpper, 'MANHATTAN');
  assert.equal(parsed.block5, '00047');
  assert.equal(parsed.lot5, '07501');

  const recorded = [];
  const mockRequest = async (url) => {
    const u = String(url);
    if (u.includes('ic3t-wcy2')) {
      return [
        {job__: '121000111', job_type: 'NB', job_status: 'J', job_status_descrp: 'PLAN EXAM - DISAPPROVED', latest_action_date: '2024-05-10', proposed_no_of_stories: '28', proposed_dwelling_units: '140', job_description: 'Proposed 28-story mixed-use tower disapproved on sky exposure plane objection'},
        {job__: '121000222', job_type: 'A1', job_status: 'X', job_status_descrp: 'SIGNED OFF', latest_action_date: '2025-01-15', proposed_no_of_stories: '22', proposed_dwelling_units: '110', job_description: 'Major alteration signed off'},
      ];
    }
    if (u.includes('w9ak-ipjd')) {
      return [
        {job_filing_number: 'M00999999-I1', job_type: 'New Building', filing_status: 'Permit Issued', current_status_date: '2026-02-01', proposed_no_of_stories: '25', proposed_dwelling_units: '125', proposed_zoning_sqft: '118500'},
      ];
    }
    if (u.includes('bs8b-p36w')) {
      return [{job_number: '121000222', c_o_issue_date: '2025-02-01T00:00:00.000', issue_type: 'Final'}];
    }
    if (u.includes('8h5j-fqxa') && u.includes('lot=')) {
      return [{document_id: '2025010100001', borough: '1', block: '47', lot: '7501', easement: 'N', air_rights: 'Y', property_type: 'CS'}];
    }
    if (u.includes('8h5j-fqxa') && u.includes('air_rights')) {
      return [{document_id: '2025010100001', borough: '1', block: '47', lot: '7501', easement: 'N', air_rights: 'Y'}];
    }
    if (u.includes('bnx9-e6tj')) {
      return [{document_id: '2025010100001', doc_type: 'ZONE', document_date: '2025-01-01', recorded_datetime: '2025-01-05', document_amt: '14500000'}];
    }
    if (u.includes('hg8x-zxpr')) {
      return [{project_id: '77777', project_name: '120 Broadway Inclusionary', all_counted_units: '125', low_income_units: '32'}];
    }
    if (u.includes('wvxf-dwi5')) {
      return [{violationid: '9991', class: 'B', inspectiondate: '2026-01-10', violationstatus: 'Open', novdescription: 'Self-closing door adjustment'}];
    }
    return [];
  };

  const nycTools = createNycPublicRecordsTools({
    getProperty: () => ({bbl: '1000477501'}),
    record: s => { recorded.push(s); return {id: recorded.length}; },
    request: mockRequest,
  });

  const out = await nycTools.handlers.acres_nyc_public_records({});
  assert.equal(out.bbl, '1000477501');
  assert.equal(out.submittalForensics.totalFilingsReturned, 3);
  assert.equal(out.submittalForensics.disapprovedOrWithdrawn.length, 1);
  assert.equal(out.submittalForensics.disapprovedOrWithdrawn[0].id, '121000111');
  assert.equal(out.submittalForensics.disapprovedOrWithdrawn[0].outcome, 'disapproved');
  assert.equal(out.submittalForensics.majorFilings.length, 3);
  assert.equal(out.acrisDocuments[0].docType, 'ZONE');
  assert.equal(out.acrisDocuments[0].airRights, true);
  assert.equal(out.acrisDocuments[0].documentAmount, 14500000);
  assert.equal(out.hpdAffordableProjects[0].allCountedUnits, 125);
  assert.equal(out.hpdViolationSummary.openInSample, 1);
  assert.equal(recorded.length, 5);
});



test('pipelineSource ledger records the measured DOB pipeline for the subject ZIP', async () => {
  const recorded = [];
  const read = {zip: '10013', months: 24, since: '2024-10-16', totals: {approvedJobs: 2, approvedDwellingUnits: 160, byStage: {approved: {jobs: 2, proposedDwellingUnits: 160}, in_review: {jobs: 1, proposedDwellingUnits: 300}}, activeJobs: 3, proposedDwellingUnitsAllStages: 460, withdrawnJobs: 1}, filings: [],
    basis: 'DOB BIS and DOB NOW filings in ZIP 10013 filed since 2024-10-16.', sourceUrl: 'https://data.cityofnewyork.us/d/w9ak-ipjd', retrievedAt: '2026-10-16T06:00:00.000Z'};
  const tools = createMarketTools({record: s => { recorded.push(s); return {id: `P${recorded.length}`}; }, ledger: {pipeline: () => read}});
  const {pipeline: _, ...rest} = inputs;
  const result = await tools.handlers.acres_market_inputs({...rest, pipelineSource: 'ledger'});
  assert.deepEqual({...result.pipeline, basis: undefined}, {units: 160, horizonYears: 2, activeJobs: 2, source: 'NYC development ledger: DOB filings in ZIP 10013', retrievedAt: '2026-10-16', url: 'https://data.cityofnewyork.us/d/w9ak-ipjd', basis: undefined, sourceId: 'P3', sourceKey:null});
  assert.match(result.pipeline.basis, /160 proposed dwelling units across 2 approved or permitted DOB jobs.*filed since 2024-10-16; another 300 units across 1 job in review.*not counted; the horizon is the 24-month filing window/);
  assert.equal(recorded.at(-1).kind, 'official_record');
  // 160 units / 40 per month = 4 months; 160 / 24,000 = 0.67 percent.
  assert.equal(result.indicators.monthsOfSupply, 4);
  assert.equal(result.indicators.pipelineShareOfSupply, 0.0067);

  await assert.rejects(tools.handlers.acres_market_inputs({...inputs, pipelineSource: 'ledger'}), /exactly one of pipeline or pipelineSource/);
  await assert.rejects(createMarketTools({ledger: {pipeline: () => ({...read, retrievedAt: null})}}).handlers.acres_market_inputs({...rest, pipelineSource: 'ledger'}), /not been synced/);
  await assert.rejects(createMarketTools().handlers.acres_market_inputs({...rest, pipelineSource: 'ledger'}), /development ledger is not available/);
});
