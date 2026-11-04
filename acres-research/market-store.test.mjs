import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {
  MarketStore, isMarketAdmin, DEFAULTS_AS_OF, DEFAULT_NYC_DEV_SETTINGS, DEFAULT_NYC_DEV_SETTINGS_BASIS, ZFA_GROSS_DEDUCTIONS,
  getSubmarketBenchmarkForZip, dealStoreAccess, nearbyLandModel, LAND_COMPS, NEARBY_LAND_MODEL,
} from './market-store.mjs';
import {createMarketTools} from './market.mjs';
import {headroomSqft} from '../app-starter/public/core-model.js';
import {runMarketRefresh} from './market-refresh.mjs';
import {createResearchServer} from './service.mjs';
import {ChatStore} from './store.mjs';

// This test deployment explicitly configures its fixture operators.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';

test('the public service has no implicit market administrators',()=>{
  assert.equal(isMarketAdmin('michael@witharosa.ai',''),false);
  assert.equal(isMarketAdmin('admin@example.com','admin@example.com'),true);
});

function makeTempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-market-store-'));
  const dbPath = join(dir, 'market.sqlite');
  const store = new MarketStore(dbPath);
  return {store, dbPath, cleanup: () => { try { store.close(); } catch {} rmSync(dir, {recursive: true, force: true}); }};
}

test('MarketStore ingests listings, tracks price/status history, and computes ZIP rollups', () => {
  const {store, cleanup} = makeTempStore();
  try {
    const initialListings = [
      {
        propertyId: 'prop-101',
        listingId: 'list-1',
        listingType: 'for_sale',
        mlsStatus: 'Active',
        address: '509 Pacific St, Brooklyn, NY 11217',
        streetLine: '509 Pacific St',
        streetNumber: '509',
        streetName: 'Pacific',
        streetSuffix: 'St',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6838,
        longitude: -73.9805,
        style: 'multi_family',
        assetClass: 'multifamily_small',
        isDevelopmentCandidate: true,
        beds: 6,
        baths: 4,
        sqft: 3200,
        lotSqft: 2500,
        stories: 3,
        yearBuilt: 1910,
        listPrice: 2400000,
        pricePerSqft: 750,
        daysOnMls: 42,
        listDate: '2026-09-01',
        url: 'https://www.realtor.com/realestateandhomes-detail/509-Pacific-St_Brooklyn_NY_11217_M00001',
      },
      {
        propertyId: 'prop-102',
        listingId: 'list-2',
        listingType: 'sold',
        mlsStatus: 'Sold',
        address: '515 Pacific St #2A, Brooklyn, NY 11217',
        streetLine: '515 Pacific St',
        unit: '#2A',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6837,
        longitude: -73.9802,
        style: 'condos',
        assetClass: 'condo_coop_apartment',
        beds: 2,
        baths: 2,
        sqft: 1100,
        soldPrice: 1650000,
        pricePerSqft: 1500,
        daysOnMls: 28,
        soldDate: '2026-09-15',
        url: 'https://www.realtor.com/realestateandhomes-detail/515-Pacific-St_Brooklyn_NY_11217_M00002',
      },
      {
        propertyId: 'prop-103',
        listingId: 'list-3',
        listingType: 'for_rent',
        mlsStatus: 'For Rent',
        address: '520 Pacific St #4B, Brooklyn, NY 11217',
        streetLine: '520 Pacific St',
        unit: '#4B',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6836,
        longitude: -73.9800,
        style: 'apartment',
        assetClass: 'condo_coop_apartment',
        beds: 2,
        baths: 1,
        sqft: 950,
        listPrice: 5200,
        rentPerSqftPerMonth: 5.47,
        daysOnMls: 14,
        listDate: '2026-09-20',
        url: 'https://www.realtor.com/realestateandhomes-detail/520-Pacific-St_Brooklyn_NY_11217_M00003',
      },
    ];

    const firstIngest = store.ingestListings(initialListings, 1700000000000);
    assert.equal(firstIngest.inserted, 3);
    assert.equal(firstIngest.updated, 0);
    assert.deepEqual(firstIngest.touchedZips, ['11217']);

    // Simulate a price drop and status change to Pending on prop-101
    const secondIngest = store.ingestListings([
      {
        ...initialListings[0],
        mlsStatus: 'Pending',
        listPrice: 2150000,
        pricePerSqft: 671.88,
      },
    ], 1700086400000);
    assert.equal(secondIngest.inserted, 0);
    assert.equal(secondIngest.updated, 1);

    const row = store.one('SELECT * FROM market_listings WHERE id = ?', 'prop-101:for_sale');
    const history = JSON.parse(row.price_history_json);
    assert.equal(history.length, 2);
    assert.equal(history[0].listPrice, 2400000);
    assert.equal(history[0].status, 'Active');
    assert.equal(history[1].listPrice, 2150000);
    assert.equal(history[1].status, 'Pending');

    const rollup = store.getZipRollup('11217');
    assert.equal(rollup.zipCode, '11217');
    assert.equal(rollup.sampleCount, 3);
    assert.equal(rollup.byBedrooms['2'].medianClosedSoldPricePerSqft, 1500);
    assert.equal(rollup.byBedrooms['2'].medianMonthlyRent, 5200);
    // One closing is too few for a ZIP sale benchmark, and the asks never stand in.
    assert.equal(rollup.devMetrics.blendedCondoSalePsf, null);
  } finally {
    cleanup();
  }
});

test('MarketStore batch-enriches NYC listings with PLUTO BBL/FAR and computes Deal Flashcards', async () => {
  const {store, cleanup} = makeTempStore();
  const mockPlutoRows = [
    {
      bbl: '3009280034.00000000',
      borough: 'BK',
      address: '509 PACIFIC STREET',
      zipcode: '11217',
      zonedist1: 'R7A',
      overlay1: 'C2-4',
      lotarea: '2500',
      bldgarea: '3200',
      builtfar: '1.28',
      residfar: '4.0',
      affresfar: '5.01',
      commfar: '2.0',
      facilfar: '4.0',
      unitsres: '4',
      unitstotal: '4',
      yearbuilt: '2005',
      bldgclass: 'C3',
      ownername: 'PACIFIC HOLDINGS LLC',
      lotfront: '25',
      lotdepth: '100',
      lottype: '5',
      latitude: '40.6838100',
      longitude: '-73.9805100',
    },
    {
      bbl: '3009280040.00000000',
      borough: 'BK',
      address: '531 PACIFIC STREET',
      zipcode: '11217',
      zonedist1: 'R7A',
      lotarea: '5000',
      bldgarea: '2000',
      builtfar: '0.40',
      residfar: '4.0',
      affresfar: '5.01',
      commfar: '0',
      facilfar: '4.0',
      unitsres: '0',
      unitstotal: '1',
      bldgclass: 'G1',
      ownername: 'GOWANUS GARAGE CORP',
      lotfront: '50',
      lotdepth: '100',
      lottype: '5',
      latitude: '40.6835000',
      longitude: '-73.9798000',
    },
  ];

  try {
    store.ingestListings([
      // Comp to establish submarket exit PSF ($1,500/SF)
      {
        propertyId: 'comp-1',
        listingType: 'sold',
        address: '515 Pacific St #2A, Brooklyn, NY 11217',
        streetLine: '515 Pacific St',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6837,
        longitude: -73.9802,
        style: 'condos',
        assetClass: 'condo_coop_apartment',
        beds: 2,
        sqft: 1000,
        soldPrice: 1500000,
        pricePerSqft: 1500,
        url: 'https://www.realtor.com/realestateandhomes-detail/515-Pacific-St_Brooklyn_NY_11217_M00002',
      },
      // Priced development deal at $2.2M on a 10,000 ZFA / 12,525 UAP ZFA lot ($176/BSF UAP)
      {
        propertyId: 'deal-priced',
        listingType: 'for_sale',
        address: '509 Pacific St, Brooklyn, NY 11217',
        streetLine: '509 Pacific St',
        streetNumber: '509',
        streetName: 'Pacific',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6838,
        longitude: -73.9805,
        style: 'multi_family',
        assetClass: 'multifamily_small',
        isDevelopmentCandidate: true,
        beds: 6,
        sqft: 3200,
        lotSqft: 2500,
        listPrice: 2200000,
        pricePerSqft: 687.5,
        url: 'https://www.realtor.com/realestateandhomes-detail/509-Pacific-St_Brooklyn_NY_11217_M00001',
      },
      // Unpriced commercial garage on a 5,000 SF lot in R7A (20,000 standard ZFA / 23,000 UAP ZFA)
      {
        propertyId: 'deal-unpriced',
        listingType: 'for_sale',
        address: '531 Pacific St, Brooklyn, NY 11217',
        streetLine: '531 Pacific St',
        streetNumber: '531',
        streetName: 'Pacific',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6835,
        longitude: -73.9798,
        style: 'land',
        assetClass: 'land',
        isDevelopmentCandidate: true,
        sqft: 2000,
        lotSqft: 5000,
        listPrice: null,
        url: 'https://www.realtor.com/realestateandhomes-detail/531-Pacific-St_Brooklyn_NY_11217_M00009',
      },
    ]);

    // Each matched lot is valued as its BBL, so its nearby land figure reads its own borough's sales.
    const appraised = [], appraise = store.appraisedLandFor.bind(store);
    store.appraisedLandFor = (row, now) => { appraised.push(row.bbl); return appraise(row, now); };
    const enriched = await store.enrichNycListingsWithPluto({
      plutoFetcher: async () => mockPlutoRows,
      limit: 10,
    });
    assert.equal(enriched.matched, 2);
    assert.deepEqual([...new Set(appraised)].sort(), ['3009280034', '3009280040']);

    const deals = store.searchDeals({zipCode: '11217', listingType: 'for_sale', minUnusedZfa: 1000});
    assert.equal(deals.length, 2);

    const pricedDeal = deals.find(d => d.address.includes('509 Pacific St'));
    assert.ok(pricedDeal, 'expected 509 Pacific St deal');
    assert.equal(pricedDeal.bbl, '3009280034');
    assert.equal(pricedDeal.zoningDistrict, 'R7A');
    assert.equal(pricedDeal.lotAreaSqft, 2500);
    assert.deepEqual([pricedDeal.lotFrontFeet, pricedDeal.lotDepthFeet], [25, 100], 'the lot dimensions travel with the deal');
    assert.equal(pricedDeal.maxStandardZfa, 10000);
    assert.equal(pricedDeal.maxUapZfa, 12525);
    // Gross buildable applies the 1.15x ZFA-to-gross factor to the 10,000 ZFA the R7A envelope holds on a 25x100
    // interior lot: 10,000 * 1.15 = 11,500 (not paper 12,525 ZFA).
    assert.equal(pricedDeal.grossBuildableSqft, 11500);
    assert.equal(pricedDeal.uapPricePerBuildableZfa, 176);
    // The 30 ft rear yard of a lot under 40 ft wide (ZR 23-342) takes it to seven storeys, mid-rise construction, so
    // $176 per buildable SF is Good, not Great.
    assert.equal(pricedDeal.flashcardValuation.dealVerdict, 'good_deal');
    assert.ok(pricedDeal.flashcardValuation.slidingScalePricePerBsf.greatDealMaxBsf < 176 && 176 <= pricedDeal.flashcardValuation.slidingScalePricePerBsf.goodDealMaxBsf);
    assert.ok(pricedDeal.flashcardValuation.slidingScalePricePerBsf.badDealMinBsf > pricedDeal.flashcardValuation.slidingScalePricePerBsf.goodDealMaxBsf);

    const unpricedDeal = deals.find(d => d.address.includes('531 Pacific St'));
    assert.ok(unpricedDeal, 'expected 531 Pacific St unpriced deal');
    assert.equal(unpricedDeal.bbl, '3009280040');
    assert.equal(unpricedDeal.maxUapZfa, 25050);
    assert.equal(unpricedDeal.flashcardValuation.dealVerdict, 'unpriced_opportunity');
    assert.ok(unpricedDeal.flashcardValuation.estimatedRedevValue > 5000000, 'expected positive estimated redevelopment land value for unpriced lot');

    // Custom developer cost assumptions dynamically shift the sliding scale
    const stressedDeals = store.searchDeals({
      zipCode: '11217',
      listingType: 'for_sale',
      minUnusedZfa: 1000,
      customSettings: {
        hardCostPerGrossSqft: 850,
        softCostPctOfHard: 0.25,
        carryAndFinancingPct: 0.15,
      },
    });
    const stressedPricedDeal = stressedDeals.find(d => d.address.includes('509 Pacific St'));
    assert.ok(stressedPricedDeal.flashcardValuation.slidingScalePricePerBsf.greatDealMaxBsf < pricedDeal.flashcardValuation.slidingScalePricePerBsf.greatDealMaxBsf);
  } finally {
    cleanup();
  }
});

test('acres_search_deal_store tool returns structured flashcards and records citable sources', async () => {
  const {store, cleanup} = makeTempStore();
  try {
    store.ingestListings([
      {
        propertyId: 'prop-tool-1',
        listingType: 'for_sale',
        address: '287 Wyckoff St, Brooklyn, NY 11217',
        streetLine: '287 Wyckoff St',
        streetNumber: '287',
        streetName: 'Wyckoff',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6839,
        longitude: -73.9850,
        style: 'multi_family',
        assetClass: 'multifamily_small',
        isDevelopmentCandidate: true,
        sqft: 2800,
        lotSqft: 2500,
        listPrice: 1800000,
        pricePerSqft: 642.86,
        url: 'https://www.realtor.com/realestateandhomes-detail/287-Wyckoff-St_Brooklyn_NY_11217_M00005',
      },
    ]);
    await store.enrichNycListingsWithPluto({
      plutoFetcher: async () => [
        {
          bbl: '3003940050.00000000',
          borough: 'BK',
          address: '287 WYCKOFF STREET',
          zipcode: '11217',
          zonedist1: 'R6A',
          lotarea: '2500',
          bldgarea: '2800',
          builtfar: '1.12',
          residfar: '3.0',
          affresfar: '3.9',
          commfar: '0',
          facilfar: '3.0',
          unitsres: '3',
          unitstotal: '3',
          bldgclass: 'C0',
          latitude: '40.6839000',
          longitude: '-73.9850000',
        },
      ],
    });

    const recorded = [];
    const events = [];
    const tools = createMarketTools({
      marketStore: store,
      dealStoreAccess: {read: true, sync: false},
      record: source => { recorded.push(source); return {id: recorded.length}; },
      emit: (event, data) => events.push({event, data}),
    });
    const res = await tools.handlers.acres_search_deal_store({
      zipCode: '11217',
      minUnusedZfa: 1000,
      syncIfEmpty: false,
    });
    assert.equal(res.dealCount, 1);
    assert.equal(res.deals[0].bbl, '3003940050');
    assert.equal(res.deals[0].uapPricePerBuildableZfa, 185);
    assert.equal(res.sourceId, 1);
    assert.equal(recorded[0].kind, 'deal_store');
    assert.equal(events[0].event, 'market.deals_searched');
    const basis = res.deals[0].flashcardValuation.basis;
    assert.ok(basis.every(b => b.source), 'every basis entry names its source');
    assert.equal(basis.find(b => b.item === 'hardCostPerGrossSqft').asOf, DEFAULTS_AS_OF);
  } finally {
    cleanup();
  }
});

test('MarketStore persists admin config, pauses scheduled refresh in beta, and revalues deals when underwriting settings change', async () => {
  const {store, dbPath, cleanup} = makeTempStore();
  try {
    const initialConfig = store.getAdminConfig();
    assert.equal(initialConfig.syncConfig.autoSyncEnabled, false);
    assert.equal(initialConfig.dealSettings.zfaToGrossFactor, 1.15);

    // Scheduled refresh should skip cleanly when autoSyncEnabled is false
    const skipped = await runMarketRefresh({
      dbPath,
      scheduled: true,
      env: {ACRES_DEAL_STORE_ENABLED: 'true'},
      bridgeRunner: async () => { throw new Error('the paused refresh must not scrape'); },
    });
    assert.equal(skipped.skipped, true);
    assert.match(skipped.reason, /paused/i);

    // Ingest a listing + PLUTO match and verify updating dealSettings revalues it
    store.ingestListings([
      {
        propertyId: 'comp-admin-1',
        listingType: 'sold',
        address: '515 Pacific St #2A, Brooklyn, NY 11217',
        streetLine: '515 Pacific St',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        style: 'condos',
        assetClass: 'condo_coop_apartment',
        beds: 2,
        sqft: 1000,
        soldPrice: 1500000,
        pricePerSqft: 1500,
      },
      {
        propertyId: 'deal-admin-1',
        listingType: 'for_sale',
        address: '509 Pacific St, Brooklyn, NY 11217',
        streetLine: '509 Pacific St',
        streetNumber: '509',
        streetName: 'Pacific',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11217',
        latitude: 40.6838,
        longitude: -73.9805,
        style: 'multi_family',
        assetClass: 'multifamily_small',
        isDevelopmentCandidate: true,
        sqft: 3200,
        lotSqft: 2500,
        listPrice: 2200000,
        pricePerSqft: 687.5,
      },
    ]);
    await store.enrichNycListingsWithPluto({
      plutoFetcher: async () => [
        {
          bbl: '3009280034.00000000',
          borough: 'BK',
          address: '509 PACIFIC STREET',
          zipcode: '11217',
          zonedist1: 'R7A',
          lotarea: '2500',
          bldgarea: '3200',
          builtfar: '1.28',
          residfar: '4.0',
          affresfar: '4.6',
          commfar: '2.0',
          facilfar: '4.0',
          unitsres: '4',
          unitstotal: '4',
          bldgclass: 'C3',
          latitude: '40.6838100',
          longitude: '-73.9805100',
        },
      ],
    });

    const beforeDeal = store.searchDeals({zipCode: '11217', listingType: 'for_sale'})[0];
    const updated = store.updateAdminConfig({
      syncConfig: {
        autoSyncEnabled: true,
        writeThroughComps: false,
        onDemandSyncIfEmpty: false,
        locations: ['Brooklyn, NY', 'Queens, NY'],
      },
      dealSettings: {
        hardCostPerGrossSqft: 725,
      },
      revalueDeals: true,
      updatedBy: 'michael@witharosa.ai',
    });

    assert.equal(updated.syncConfig.autoSyncEnabled, true);
    assert.equal(updated.syncConfig.writeThroughComps, false);
    assert.equal(updated.syncConfig.onDemandSyncIfEmpty, false);
    assert.deepEqual(updated.syncConfig.locations, ['Brooklyn, NY', 'Queens, NY']);
    assert.equal(updated.dealSettings.hardCostPerGrossSqft, 725);
    assert.equal(updated.updatedBy, 'michael@witharosa.ai');
    assert.equal(updated.revaluedCount, 1);

    const afterDeal = store.searchDeals({zipCode: '11217', listingType: 'for_sale'})[0];
    assert.ok(
      afterDeal.flashcardValuation.slidingScalePricePerBsf.greatDealMaxBsf <
      beforeDeal.flashcardValuation.slidingScalePricePerBsf.greatDealMaxBsf,
    );
  } finally {
    cleanup();
  }
});

test('Research service /admin/market-store endpoints enforce admin email access and update configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-research-admin-'));
  const marketDb = join(dir, 'market.sqlite');
  const chatStore = new ChatStore(join(dir, 'chat.sqlite'));
  const token = 'test-research-token';
  const account = 'a'.repeat(24);
  const server = createResearchServer({
    secrets: {RESEARCH_TOKEN: token},
    store: chatStore,
    maps: null,
    marketStoreFactory: () => new MarketStore(marketDb),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = email => ({
    authorization: `Bearer ${token}`,
    'x-acres-account': account,
    'x-acres-email': email,
  });

  try {
    // Non-admin caller (including other @witharosa.ai or @hyatus.com addresses) gets 403
    for (const nonAdmin of ['visitor@gmail.com', 'someone@witharosa.ai', 'ops@hyatus.com']) {
      const forbidden = await fetch(`${baseUrl}/admin/market-store`, {
        headers: authHeaders(nonAdmin),
      });
      assert.equal(forbidden.status, 403, `expected 403 for ${nonAdmin}`);
    }

    // Michael, Alex, and Chaim get 200 status + config
    for (const admin of ['michael@witharosa.ai', 'alex@witharosa.ai', 'chaim@witharosa.ai']) {
      const statusRes = await fetch(`${baseUrl}/admin/market-store`, {
        headers: authHeaders(admin),
      });
      assert.equal(statusRes.status, 200, `expected 200 for ${admin}`);
      const statusBody = await statusRes.json();
      assert.equal(statusBody.adminConfig.syncConfig.autoSyncEnabled, false);
    }

    // Admin caller updates config
    const updateRes = await fetch(`${baseUrl}/admin/market-store/config`, {
      method: 'PUT',
      headers: {
        ...authHeaders('alex@witharosa.ai'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        syncConfig: {
          autoSyncEnabled: false,
          pastDays: 120,
        },
        dealSettings: {
          hardCostPerGrossSqft: 600,
        },
        revalueDeals: true,
      }),
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json();
    assert.equal(updateBody.syncConfig.pastDays, 120);
    assert.equal(updateBody.dealSettings.hardCostPerGrossSqft, 600);
    assert.equal(updateBody.updatedBy, 'alex@witharosa.ai');
  } finally {
    await new Promise(resolve => server.close(resolve));
    try { chatStore.close?.(); } catch {}
    rmSync(dir, {recursive: true, force: true});
  }
});

test('MarketStore computes Avenue Retail Uplift, Rent-Stabilized / CONH Demolition Risk, 1-100% Similarity Comps, and Per-User Developer Settings', async () => {
  const {store, cleanup} = makeTempStore();
  try {
    store.ingestListings([
      // Subject 1: Clean 2-unit avenue parcel with C2-4 overlay
      {
        propertyId: 'ave-clean',
        listingType: 'for_sale',
        address: '412 4th Ave, Brooklyn, NY 11215',
        streetLine: '412 4th Ave',
        streetNumber: '412',
        streetName: '4th Ave',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11215',
        latitude: 40.6725,
        longitude: -73.9842,
        style: 'multi_family',
        assetClass: 'multifamily_small',
        isDevelopmentCandidate: true,
        sqft: 2400,
        lotSqft: 2500,
        yearBuilt: 1920,
        listPrice: 2200000,
      },
      // Subject 2: High Rent-Stabilized / CONH Risk (8-unit pre-1974 walkup on side street)
      {
        propertyId: 'side-rs-risk',
        listingType: 'for_sale',
        address: '218 8th St, Brooklyn, NY 11215',
        streetLine: '218 8th St',
        streetNumber: '218',
        streetName: '8th St',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11215',
        latitude: 40.6710,
        longitude: -73.9860,
        style: 'multi_family',
        assetClass: 'multifamily_walkup',
        isDevelopmentCandidate: true,
        sqft: 6200,
        lotSqft: 2500,
        yearBuilt: 1925,
        listPrice: 2100000,
      },
      // Sold Comp on 4th Ave in R7A
      {
        propertyId: 'comp-ave-sold',
        listingType: 'sold',
        address: '420 4th Ave, Brooklyn, NY 11215',
        streetLine: '420 4th Ave',
        streetNumber: '420',
        streetName: '4th Ave',
        city: 'Brooklyn',
        state: 'NY',
        zipCode: '11215',
        latitude: 40.6721,
        longitude: -73.9845,
        style: 'multi_family',
        assetClass: 'multifamily_small',
        isDevelopmentCandidate: true,
        sqft: 2600,
        lotSqft: 2500,
        yearBuilt: 1922,
        soldPrice: 2450000,
      },
    ]);

    await store.enrichNycListingsWithPluto({
      plutoFetcher: async () => [
        {
          bbl: '3009650010',
          borough: 'BK',
          address: '412 4 AVENUE',
          zipcode: '11215',
          zonedist1: 'R8A',
          overlay1: 'C2-4',
          lotarea: '2500',
          bldgarea: '2400',
          builtfar: '0.96',
          residfar: '6.02',
          affresfar: '7.2',
          commfar: '2.0',
          unitsres: '2',
          unitstotal: '3',
          bldgclass: 'S2',
          yearbuilt: '1920',
          latitude: '40.6725',
          longitude: '-73.9842',
        },
        {
          bbl: '3009650025',
          borough: 'BK',
          address: '218 8 STREET',
          zipcode: '11215',
          zonedist1: 'R7B',
          lotarea: '2500',
          bldgarea: '6200',
          builtfar: '2.48',
          residfar: '3.0',
          affresfar: '3.9',
          commfar: '0',
          unitsres: '8',
          unitstotal: '8',
          bldgclass: 'C1',
          yearbuilt: '1925',
          latitude: '40.6710',
          longitude: '-73.9860',
        },
        {
          bbl: '3009650014',
          borough: 'BK',
          address: '420 4 AVENUE',
          zipcode: '11215',
          zonedist1: 'R8A',
          overlay1: 'C2-4',
          lotarea: '2500',
          bldgarea: '2600',
          builtfar: '1.04',
          residfar: '6.02',
          affresfar: '7.2',
          commfar: '2.0',
          unitsres: '2',
          unitstotal: '3',
          bldgclass: 'S2',
          yearbuilt: '1922',
          latitude: '40.6721',
          longitude: '-73.9845',
        },
      ],
    });

    const allDeals = store.searchDeals({zipCode: '11215', listingType: 'for_sale', minUnusedZfa: 500});
    assert.equal(allDeals.length, 2);

    const aveDeal = allDeals.find(d => d.id === 'ave-clean:for_sale');
    const rsDeal = allDeals.find(d => d.id === 'side-rs-risk:for_sale');

    // 1. Avenue retail uplift check
    assert.ok(aveDeal.corridorProfile.hasRetailUplift);
    assert.ok(aveDeal.corridorProfile.retailAnnualNoiUplift > 0);
    assert.ok(aveDeal.corridorProfile.retailValueUplift > 0);
    assert.equal(rsDeal.corridorProfile.hasRetailUplift, false);

    // 2. Metadata screening prioritizes review without deciding legal coverage.
    assert.equal(aveDeal.rentStabilization.riskLevel, 'low');
    assert.equal(rsDeal.rentStabilization.riskLevel, 'high');
    assert.equal(rsDeal.rentStabilization.conhRequired, null);
    assert.equal(rsDeal.rentStabilization.estStabilizedUnits, null);
    assert.equal(rsDeal.rentStabilization.existingUnitsRes, 8);

    // Hiding high review flags leaves the lower-indicator avenue parcel.
    const cleanOnly = store.searchDeals({
      zipCode: '11215',
      listingType: 'for_sale',
      minUnusedZfa: 500,
      excludeHighStabilizedRisk: true,
    });
    assert.equal(cleanOnly.length, 1);
    assert.equal(cleanOnly[0].id, 'ave-clean:for_sale');

    // 3. 1-100% Similarity comps check
    assert.ok(Array.isArray(aveDeal.similarComps));
    assert.ok(aveDeal.similarComps.length >= 1);
    const soldComp = aveDeal.similarComps.find(c => c.listingId === 'comp-ave-sold:sold');
    assert.ok(soldComp);
    assert.ok(soldComp.similarityScore >= 85 && soldComp.similarityScore <= 99);
    assert.ok(soldComp.pricePerBuildableZfa > 0);
    assert.ok(soldComp.pricePerBuildableUnit > 0);

    // 4. Per-User Developer Underwriting Profile
    const acct = 'dev-user-account-123';
    assert.equal(store.getUserDealSettings(acct).isCustom, false);
    assert.equal(store.getUserDealSettings(acct).costsConfirmed, false);
    const saved = store.updateUserDealSettings(
      acct,
      {hardCostPerGrossSqft: 495, softCostPctOfHard: 0.25, zfaToGrossFactor: 1.18},
      {updatedBy: 'sendy@developer.com'}
    );
    assert.equal(saved.isCustom, true);
    assert.equal(saved.costsConfirmed, true);
    assert.equal(saved.dealSettings.hardCostPerGrossSqft, 495);
    assert.equal(saved.dealSettings.zfaToGrossFactor, 1.18);

    const customDeals = store.searchDeals({
      zipCode: '11215',
      listingType: 'for_sale',
      minUnusedZfa: 500,
      customSettings: saved.dealSettings,
    });
    const customAve = customDeals.find(d => d.id === 'ave-clean:for_sale');
    assert.ok(customAve.estimatedConstructionCost > aveDeal.estimatedConstructionCost);

    const reset = store.updateUserDealSettings(acct, {}, {reset: true});
    assert.equal(reset.isCustom, false);
    assert.equal(reset.costsConfirmed, true);
    assert.deepEqual(reset.dealSettings, reset.baselineSettings);
  } finally {
    cleanup();
  }
});



const PII_FIELDS = {agentName: 'Pat Example', brokerOffice: 'Example Realty', agentPhone: '555-010-4477'};
const ADMIN = 'michael@witharosa.ai';

test('listings never persist or return listing agent contacts, and AVMs reduce to a boolean', async () => {
  const {store, cleanup} = makeTempStore();
  try {
    store.ingestListings([{
      propertyId: 'pii-1', listingType: 'for_sale', address: '509 Pacific St, Brooklyn, NY 11217', streetNumber: '509', streetName: 'Pacific',
      city: 'Brooklyn', state: 'NY', zipCode: '11217', latitude: 40.6838, longitude: -73.9805, isDevelopmentCandidate: true,
      listPrice: 2200000, avmAvailable: true, avmEstimate: 2100000, ...PII_FIELDS,
    }]);
    const columns = store.query('PRAGMA table_info(market_listings)').map(c => c.name);
    for (const gone of ['agent_name', 'broker_office', 'agent_phone', 'avm_estimate', 'avm_low', 'avm_high', 'avm_source']) {
      assert.ok(!columns.includes(gone), `${gone} must not exist`);
    }
    assert.equal(store.one('SELECT avm_available FROM market_listings').avm_available, 1);
    await store.enrichNycListingsWithPluto({plutoFetcher: async () => [{
      bbl: '3009280034', borough: 'BK', address: '509 PACIFIC STREET', zonedist1: 'R7A', lotarea: '2500', bldgarea: '3200',
      residfar: '4.0', affresfar: '4.6', latitude: '40.6838', longitude: '-73.9805',
    }]});
    const [deal] = store.searchDeals({zipCode: '11217', minUnusedZfa: 0});
    assert.equal(deal.avmAvailable, true);
    const serialized = JSON.stringify(deal);
    for (const value of Object.values(PII_FIELDS)) assert.ok(!serialized.includes(value));
    assert.ok(!('agentName' in deal) && !('brokerOffice' in deal) && !('agentPhone' in deal) && !('avmEstimate' in deal));
  } finally {
    cleanup();
  }
});

test('opening an older market store drops agent and AVM columns and their values from the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-market-migrate-'));
  const dbPath = join(dir, 'market.sqlite');
  try {
    new MarketStore(dbPath).close();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('ALTER TABLE market_listings DROP COLUMN avm_available');
    for (const column of ['avm_estimate REAL', 'avm_low REAL', 'avm_high REAL', 'avm_source TEXT', 'agent_name TEXT', 'broker_office TEXT', 'agent_phone TEXT']) {
      legacy.exec(`ALTER TABLE market_listings ADD COLUMN ${column}`);
    }
    const insert = legacy.prepare(`INSERT INTO market_listings (id, listing_type, zip_code, avm_estimate, avm_low, avm_high, avm_source,
      agent_name, broker_office, agent_phone, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run('a:for_sale', 'for_sale', '11217', 1900000, 1800000, 2000000, 'Vendor AVM', PII_FIELDS.agentName, PII_FIELDS.brokerOffice, PII_FIELDS.agentPhone, 1, 1);
    insert.run('b:for_sale', 'for_sale', '11217', null, null, null, null, null, null, null, 1, 1);
    legacy.close();

    const store = new MarketStore(dbPath);
    const columns = store.query('PRAGMA table_info(market_listings)').map(c => c.name);
    assert.ok(!columns.some(c => /^(agent_|broker_|avm_(estimate|low|high|source))/.test(c)));
    assert.deepEqual(store.query('SELECT id, avm_available FROM market_listings ORDER BY id').map(r => [r.id, r.avm_available]), [['a:for_sale', 1], ['b:for_sale', 0]]);
    store.close();
    const bytes = readFileSync(dbPath).toString('latin1');
    for (const value of [...Object.values(PII_FIELDS), 'Vendor AVM']) assert.ok(!bytes.includes(value), `${value} must be gone from the file`);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('deal store access: reads need the flag or an admin, scraping needs both', () => {
  assert.deepEqual(dealStoreAccess(false, {}), {read: false, sync: false});
  assert.deepEqual(dealStoreAccess(true, {}), {read: true, sync: false});
  assert.deepEqual(dealStoreAccess(false, {ACRES_DEAL_STORE_ENABLED: 'true'}), {read: true, sync: false});
  assert.deepEqual(dealStoreAccess(true, {ACRES_DEAL_STORE_ENABLED: 'true'}), {read: true, sync: true});
});

test('the deal tool hides the store without read access and syncs or writes through only with sync access', async () => {
  const {store, cleanup} = makeTempStore();
  try {
    let syncs = 0;
    store.syncMarket = async () => { syncs++; return {}; };
    const noRead = createMarketTools({marketStore: store});
    await assert.rejects(noRead.handlers.acres_search_deal_store({zipCode: '11217'}), /not available/);

    const reader = createMarketTools({marketStore: store, dealStoreAccess: {read: true, sync: false}});
    assert.equal((await reader.handlers.acres_search_deal_store({zipCode: '11217'})).dealCount, 0);
    assert.equal(syncs, 0);

    const admin = createMarketTools({marketStore: store, dealStoreAccess: {read: true, sync: true}});
    await admin.handlers.acres_search_deal_store({zipCode: '11217'});
    assert.equal(syncs, 1);
  } finally {
    cleanup();
  }
});

test('refresh never scrapes while the deal store flag is off', async () => {
  const {dbPath, cleanup} = makeTempStore();
  try {
    const result = await runMarketRefresh({dbPath, env: {}, bridgeRunner: async () => { throw new Error('must not scrape'); }});
    assert.equal(result.skipped, true);
    assert.match(result.reason, /ACRES_DEAL_STORE_ENABLED/);
    const unit = readFileSync(new URL('../infra/acres-market.service', import.meta.url), 'utf8');
    assert.match(unit, /market-refresh\.mjs --scheduled/);
  } finally {
    cleanup();
  }
});

test('every underwriting default, benchmark tier and deduction carries an as-of date and source', () => {
  assert.deepEqual(Object.keys(DEFAULT_NYC_DEV_SETTINGS_BASIS), Object.keys(DEFAULT_NYC_DEV_SETTINGS));
  for (const b of Object.values(DEFAULT_NYC_DEV_SETTINGS_BASIS)) assert.ok(b.asOf && b.source);
  assert.ok(ZFA_GROSS_DEDUCTIONS.asOf && ZFA_GROSS_DEDUCTIONS.source);
  for (const [zip, borough] of [['10001'], ['11215'], ['11372'], ['10451'], ['11420'], ['10465'], ['10314'], [null, 'MN'], [null, 'BK'], [null, 'QN'], [null, 'BX'], [null, 'SI'], [null, null]]) {
    const tier = getSubmarketBenchmarkForZip(zip, borough);
    assert.ok(tier.asOf && tier.source, `tier for ${zip || borough} is dated and sourced`);
  }
});

test('flashcard basis says a ZIP with too few closings has no recorded sale benchmark and names the tier figure used', async () => {
  const {store, cleanup} = makeTempStore();
  try {
    store.ingestListings([
      {propertyId: 'comp-1', listingType: 'sold', zipCode: '11217', city: 'Brooklyn', state: 'NY', assetClass: 'condo_coop_apartment', beds: 2, sqft: 1000, soldPrice: 1500000, pricePerSqft: 1500, soldDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)},
      {propertyId: 'deal-1', listingType: 'for_sale', address: '509 Pacific St, Brooklyn, NY 11217', streetNumber: '509', streetName: 'Pacific', city: 'Brooklyn', state: 'NY', zipCode: '11217', latitude: 40.6838, longitude: -73.9805, isDevelopmentCandidate: true, listPrice: 2200000},
    ]);
    await store.enrichNycListingsWithPluto({plutoFetcher: async () => [{
      bbl: '3009280034', borough: 'BK', address: '509 PACIFIC STREET', zonedist1: 'R7A', lotarea: '2500', bldgarea: '3200',
      residfar: '4.0', affresfar: '4.6', latitude: '40.6838', longitude: '-73.9805',
    }]});
    const [deal] = store.searchDeals({zipCode: '11217', minUnusedZfa: 0});
    const basis = Object.fromEntries(deal.flashcardValuation.basis.map(b => [b.item, b]));
    assert.match(basis.submarketSalePsf.source, /^No recorded sale benchmark for this ZIP: 1 priced condo and co-op closing in the last 24 months, fewer than the 6 needed; asking prices are never used\. In its place, .*Arosa analyst estimate/);
    assert.equal(deal.flashcardValuation.submarketSalePsf, getSubmarketBenchmarkForZip('11217', 'BK').salePsf);
    assert.match(basis.submarketRentPsfMonth.source, /Arosa analyst estimate/);
    assert.equal(basis.submarketRentPsfMonth.asOf, DEFAULTS_AS_OF);
    assert.match(basis.zfaGrossDeductions.source, /not these percentages/);
  } finally {
    cleanup();
  }
});

test('research service hides the deal routes from non-admins while the flag is off and blocks scraping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-research-gate-'));
  const chatStore = new ChatStore(join(dir, 'chat.sqlite'));
  const token = 'test-research-token';
  const server = createResearchServer({
    secrets: {RESEARCH_TOKEN: token},
    store: chatStore,
    maps: null,
    marketStoreFactory: () => new MarketStore(join(dir, 'market.sqlite')),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = email => ({authorization: `Bearer ${token}`, 'x-acres-account': 'b'.repeat(24), 'x-acres-email': email, 'content-type': 'application/json'});
  const previous = process.env.ACRES_DEAL_STORE_ENABLED;
  try {
    delete process.env.ACRES_DEAL_STORE_ENABLED;
    for (const path of ['/market-store/deals', '/market-store/status', '/market-store/user-settings']) {
      assert.equal((await fetch(baseUrl + path, {headers: headers('visitor@gmail.com')})).status, 404, path);
    }
    assert.equal((await fetch(`${baseUrl}/market-store/deals`, {headers: headers(ADMIN)})).status, 200);
    const sync = await fetch(`${baseUrl}/admin/market-store/sync`, {method: 'POST', headers: headers(ADMIN), body: '{}'});
    assert.equal(sync.status, 403);
    assert.match((await sync.json()).error, /ACRES_DEAL_STORE_ENABLED/);

    process.env.ACRES_DEAL_STORE_ENABLED = 'true';
    assert.equal((await fetch(`${baseUrl}/market-store/deals`, {headers: headers('visitor@gmail.com')})).status, 200);
    assert.equal((await fetch(`${baseUrl}/admin/market-store/sync`, {method: 'POST', headers: headers('visitor@gmail.com'), body: '{}'})).status, 403);
  } finally {
    if (previous === undefined) delete process.env.ACRES_DEAL_STORE_ENABLED;
    else process.env.ACRES_DEAL_STORE_ENABLED = previous;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});

// Few distinct metric values so every sort has long runs of ties; ids are inserted out of order.
function seedPagedDeals(store, count) {
  const insert = store.db.prepare(`
    INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, latitude, longitude, zoning_district,
      list_price, pluto_lot_area, pluto_bldg_area, resid_far, aff_res_far, unused_uap_zfa, uap_price_per_buildable_zfa,
      far_compression_pct, implied_yield_on_cost, implied_condo_margin, units_res, units_total, year_built, bldg_class,
      first_seen_at, last_seen_at)
    VALUES (?, 'for_sale', ?, '11217', 'BK', ?, ?, ?, 'R6A', ?, 2500, 1000, 3, 3.9, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
  for (let i = 0; i < count; i++) {
    const n = (i * 7) % count;
    const price = n % 5 === 0 ? null : 1500000 + 250000 * (n % 3);
    const [lat, lon] = n % 4 === 0 ? [null, null] : n % 4 === 1 ? [0, 0] : [40.68 + n / 1000, -73.97 - n / 1000];
    insert.run(
      `deal-${String(n).padStart(3, '0')}`, `${n} Test Ave`, `30000000${String(n).padStart(2, '0')}`, lat, lon, price,
      1000 * (1 + (n % 3)), n % 6 === 0 ? null : 100 * (1 + (n % 2)), n % 3 === 0 ? null : 10,
      // Stored yields and margins run opposite to the live valuation, as if written under an older cost profile.
      price ? price / 1e6 : null, price ? price / 1e6 : null,
      n % 2 ? 8 : 2, n % 2 ? 8 : 2, n % 2 ? 1950 : 2010, n % 2 ? 'C1' : 'B1',
    );
  }
}

test('repeat deal searches reuse valuations until a listing or the costs change', () => {
  const {store, cleanup} = makeTempStore();
  try {
    seedPagedDeals(store, 12);
    const q = {zipCode: '11217', minUnusedZfa: 0, sortBy: 'best_deal', includeSimilarComps: false, limit: 50};
    const priceOf = (page, id) => page.deals.find(d => d.id === id).pricePerBuildableSf;
    const first = store.searchDealsPage(q);
    const id = first.deals.find(d => d.listPrice && Number.isFinite(d.pricePerBuildableSf)).id;
    assert.deepEqual(store.searchDealsPage(q), first);
    store.write('UPDATE market_listings SET list_price = list_price * 2 WHERE id = ?', id);
    assert.equal(priceOf(store.searchDealsPage(q), id), priceOf(first, id) * 2, 'a changed listing is valued again');
    const pricier = store.searchDealsPage({...q, customSettings: {hardCostPerGrossSqft: 900}});
    const verdicts = page => page.deals.map(d => [d.id, d.flashcardValuation.dealVerdict]);
    assert.equal(pricier.deals.length, first.deals.length);
    assert.notDeepEqual(verdicts(pricier), verdicts(store.searchDealsPage(q)), 'other costs give other verdicts');
  } finally {
    cleanup();
  }
});

test('a corner lot is valued on its wide side street whichever view reads it first', () => {
  const {store, cleanup} = makeTempStore();
  try {
    // R8 corner lot, 5,000 SF: 50 ft on a 60 ft street and an 80 ft (wide) side street, so 7.2 FAR, 36,000 SF, not 6.02.
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, pluto_address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, units_res, year_built,
      flood_zone, landmark_flag, front_street_feet, side_street_feet, front_street_checked_at, first_seen_at, last_seen_at)
      VALUES ('corner', 'for_sale', '200 Sample Ave', '200 SAMPLE AVENUE', '11216', 'BK', '3018000001', 6000000, 5000, 50, 100, '3', 0, 6.02, 7.2,
      'R8', 0, 2020, 0, 0, 60, 80, 1, ?, ?)`).run(Date.now(), Date.now());
    store.revalueDealsWithSettings();
    const read = deal => [deal.buildableZfa, deal.flashcardValuation.dealVerdict];
    const ranked = read(store.searchDeals({sortBy: 'best_deal', minUnusedZfa: null})[0]);
    const detail = read(store.searchDeals({listingId: 'corner'})[0]);
    assert.equal(ranked[0], 36000);
    assert.deepEqual(detail, ranked);
  } finally {
    cleanup();
  }
});

test('the headroom filter and the headroom sorts read the unused floor area the card prints', () => {
  const {store, cleanup} = makeTempStore();
  try {
    const ins = store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, pluto_address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, units_res, year_built, flood_zone,
      landmark_flag, front_street_feet, in_mih_area, mih_area_json, first_seen_at, last_seen_at)
      VALUES (?, 'for_sale', ?, ?, '11216', 'BK', ?, ?, 5000, 50, 100, '5', ?, 4.0, 5.01, 'R7A', 4, 1931, 0, 0, 60, ?, ?, ?, ?)`);
    // R7A 50 by 100 lots with 0 to 19,800 sq ft standing, in and out of an MIH area, at two asks: the card's
    // headroom is the unused floor area of the building that sets the value, not the bonus area.
    let n = 0;
    for (const bldg of [0, 8000, 14000, 17000, 19000, 19800]) for (const mih of [0, 1]) for (const price of [1_500_000, 4_000_000]) {
      n++;
      ins.run(`L${n}`, `${n} Test St`, `${n} TEST STREET`, `30100${String(n).padStart(5, '0')}`, price, bldg, mih, mih ? JSON.stringify({projectArea: 'Test', options: ['option1', 'option2']}) : null, Date.now(), Date.now());
    }
    store.revalueDealsWithSettings();
    const all = store.searchDeals({minUnusedZfa: null, limit: 100});
    // The card reads the row as deals.js normalizes it.
    const card = new Map(all.map(d => [d.id, headroomSqft({unused_for_lead_zfa: d.unusedForLeadZfa, uap_unused_zfa: d.unusedUapZfa, unused_residential_zfa: d.unusedStandardZfa})]));
    const plusOne = store.searchDeals({minHeadroomFar: 1, minUnusedZfa: null, limit: 100});
    assert.ok(plusOne.length > 0 && plusOne.length < all.length);
    assert.deepEqual(plusOne.map(d => d.id).sort(), all.filter(d => card.get(d.id) / 5000 >= 1).map(d => d.id).sort());
    for (const sortBy of ['unused_uap_zfa', 'unused_far']) {
      const order = store.searchDeals({sortBy, minUnusedZfa: null, limit: 100}).map(d => card.get(d.id));
      assert.deepEqual(order, [...order].sort((a, b) => b - a), sortBy);
    }
  } finally {
    cleanup();
  }
});

test('searchDeals pages in a stable order with a total for every sort', () => {
  const {store, cleanup} = makeTempStore();
  try {
    seedPagedDeals(store, 23);
    const ids = deals => deals.map(d => d.id);
    for (const sortBy of ['uap_price_per_buildable_zfa', 'unused_uap_zfa', 'far_compression_pct', 'implied_yield_on_cost', 'implied_condo_margin']) {
      for (const excludeHighStabilizedRisk of [false, true]) {
        const q = {zipCode: '11217', minUnusedZfa: 0, includeSimilarComps: false, sortBy, excludeHighStabilizedRisk};
        const label = `${sortBy} exclude=${excludeHighStabilizedRisk}`;
        const all = store.searchDealsPage({...q, limit: 20, offset: 0});
        const first = store.searchDealsPage({...q, limit: 10, offset: 0});
        const second = store.searchDealsPage({...q, limit: 10, offset: 10});
        assert.equal(first.deals.length, 10, label);
        assert.equal(new Set([...ids(first.deals), ...ids(second.deals)]).size, first.deals.length + second.deals.length, `${label}: pages are disjoint`);
        assert.deepEqual([...ids(first.deals), ...ids(second.deals)], ids(all.deals), `${label}: pages concatenate to the larger page`);
        assert.deepEqual(ids(store.searchDeals({...q, limit: 10, offset: 10})), ids(second.deals), label);
        assert.equal(first.total, all.total, label);
        assert.equal(second.total, all.total, label);
        assert.equal(second.offset, 10, label);
        assert.equal(all.deals.length, Math.min(20, all.total), label);
      }
    }
    const q = {zipCode: '11217', minUnusedZfa: 0, includeSimilarComps: false};
    assert.equal(store.searchDealsPage(q).total, 23);
    const safe = store.searchDealsPage({...q, excludeHighStabilizedRisk: true, limit: 100});
    assert.ok(safe.total > 10 && safe.total < 23, 'the stabilization filter is counted in the total');
    assert.equal(safe.deals.length, safe.total);

    // Equal stored metric values break ties by id.
    const byPrice = store.searchDeals({...q, limit: 100});
    const storedPrice = id => store.one('SELECT COALESCE(price_per_buildable_sf, uap_price_per_buildable_zfa) AS v FROM market_listings WHERE id = ?', id).v;
    for (let i = 1; i < byPrice.length; i++) {
      if (storedPrice(byPrice[i].id) === storedPrice(byPrice[i - 1].id)) assert.ok(byPrice[i - 1].id < byPrice[i].id, byPrice[i].id);
    }

    // Yield and margin follow the valuation the request returns, not the stored columns.
    for (const [sortBy, key] of [['implied_yield_on_cost', 'impliedYieldOnCostPct'], ['implied_condo_margin', 'impliedCondoMarginPct']]) {
      const values = store.searchDeals({...q, sortBy, limit: 100, customSettings: {hardCostPerGrossSqft: 900}}).map(d => d.flashcardValuation[key]);
      const firstNull = values.indexOf(null);
      const priced = firstNull === -1 ? values : values.slice(0, firstNull);
      assert.ok(priced.length > 1 && values.slice(priced.length).every(v => v === null), `${sortBy}: unvalued listings rank last`);
      assert.ok(priced.every((v, i) => i === 0 || v <= priced[i - 1]), `${sortBy} follows the returned ${key}`);
    }

    // Offsets and limits from a query string never reach SQLite as non integers.
    for (const offset of [Infinity, 1e20, Number.MAX_VALUE]) {
      for (const sortBy of ['uap_price_per_buildable_zfa', 'unused_uap_zfa', 'implied_yield_on_cost']) {
        const page = store.searchDealsPage({...q, sortBy, offset});
        assert.deepEqual([page.deals.length, page.total], [0, 23], `${sortBy} offset ${offset}`);
      }
    }
    for (const offset of [-5, NaN, -Infinity]) assert.equal(store.searchDealsPage({...q, offset, limit: 5}).offset, 0);
    assert.deepEqual(ids(store.searchDeals({...q, offset: 2.7, limit: 2.5})), ids(store.searchDeals({...q, offset: 2, limit: 2})));
    assert.equal(store.searchDeals({...q, limit: 0.5}).length, 1, 'a fractional limit below one still returns one listing');

    // Computed sorts rank on a narrow projection, then return the same full listing as the stored sorts.
    const stored = new Map(store.searchDeals({...q, limit: 100}).map(d => [d.id, d]));
    const live = store.searchDeals({...q, sortBy: 'implied_yield_on_cost', excludeHighStabilizedRisk: true, limit: 100});
    assert.ok(live.length > 0);
    for (const deal of live) assert.deepEqual(deal, stored.get(deal.id), deal.id);

    // A map pin only for coordinates the store actually holds: missing and 0,0 geocodes carry no pin.
    for (const deal of store.searchDeals({...q, limit: 100})) {
      const row = store.one('SELECT latitude, longitude FROM market_listings WHERE id = ?', deal.id);
      if (row.latitude == null || (row.latitude === 0 && row.longitude === 0)) {
        assert.deepEqual([deal.latitude, deal.longitude], [null, null], deal.id);
      } else {
        assert.deepEqual([deal.latitude, deal.longitude], [row.latitude, row.longitude], deal.id);
      }
    }
  } finally {
    cleanup();
  }
});

test('the deals route pages with offset, reports the total and stays hidden from accounts without the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-research-paging-'));
  const chatStore = new ChatStore(join(dir, 'chat.sqlite'));
  const token = 'test-research-token';
  const seed = new MarketStore(join(dir, 'market.sqlite'));
  seedPagedDeals(seed, 23);
  seed.close();
  const server = createResearchServer({
    secrets: {RESEARCH_TOKEN: token},
    store: chatStore,
    maps: null,
    marketStoreFactory: () => new MarketStore(join(dir, 'market.sqlite')),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = email => ({authorization: `Bearer ${token}`, 'x-acres-account': 'c'.repeat(24), 'x-acres-email': email});
  const previous = process.env.ACRES_DEAL_STORE_ENABLED;
  try {
    delete process.env.ACRES_DEAL_STORE_ENABLED;
    const path = '/market-store/deals?zipCode=11217&minUnusedZfa=0&includeSimilarComps=false&limit=10';
    assert.equal((await fetch(`${baseUrl}${path}&offset=10`, {headers: headers('visitor@gmail.com')})).status, 404);
    const first = await (await fetch(`${baseUrl}${path}&offset=0`, {headers: headers(ADMIN)})).json();
    const second = await (await fetch(`${baseUrl}${path}&offset=10`, {headers: headers(ADMIN)})).json();
    assert.deepEqual([first.total, first.offset, first.limit, first.deals.length], [23, 0, 10, 10]);
    assert.deepEqual([second.total, second.offset, second.deals.length], [23, 10, 10]);
    assert.ok(second.deals.every(d => !first.deals.some(f => f.id === d.id)), 'pages are disjoint');
    for (const offset of ['Infinity', '1e20', 'abc', '-3']) {
      for (const sortBy of ['uap_price_per_buildable_zfa', 'unused_uap_zfa', 'far_compression_pct']) {
        const res = await fetch(`${baseUrl}${path}&sortBy=${sortBy}&offset=${offset}`, {headers: headers(ADMIN)});
        assert.equal(res.status, 200, `${sortBy} offset ${offset}`);
        assert.equal((await res.json()).total, 23);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ACRES_DEAL_STORE_ENABLED;
    else process.env.ACRES_DEAL_STORE_ENABLED = previous;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a listing pinned to one of two lots sharing an address is placed on the lot that fits it', async () => {
  const {store, cleanup} = makeTempStore();
  try {
    // One borough, one address, two lots: a vacant parking lot where the listing pin landed, and a
    // three-family house in the same ZIP across the neighbourhood, plus a same-address lot in another ZIP.
    const parking = {bbl: '3000010001.00000000', borough: 'BK', address: '40 EXAMPLE AVENUE', zipcode: '11208', lotarea: '57000', bldgarea: '0', bldgclass: 'G7', unitsres: '0', zonedist1: 'M1-1', residfar: '0', commfar: '1', facilfar: '2.4', mnffar: '1', latitude: '40.6590', longitude: '-73.8732'};
    const house = {bbl: '3000020002.00000000', borough: 'BK', address: '40 EXAMPLE AVENUE', zipcode: '11208', lotarea: '2000', bldgarea: '2900', bldgclass: 'C0', unitsres: '3', zonedist1: 'R4', residfar: '0.9', affresfar: '1.35', latitude: '40.6819', longitude: '-73.8820'};
    const elsewhere = {...house, bbl: '3000030003.00000000', zipcode: '11207', latitude: '40.6600', longitude: '-73.8740'};
    const queries = [];
    const plutoFetcher = async where => { queries.push(where); return where.includes("address='40 EXAMPLE AVENUE'") ? [parking, house, elsewhere] : [parking]; };
    const listing = (id, extra) => ({propertyId: id, listingType: 'for_sale', address: '40 Example Ave, Brooklyn, NY 11208', streetLine: '40 Example Ave', streetNumber: '40', streetName: 'Example',
      city: 'Brooklyn', state: 'NY', zipCode: '11208', latitude: 40.65902, longitude: -73.8732, listPrice: 828000, isDevelopmentCandidate: true, ...extra});
    // The house listing describes a 3,100 SF building; the land listing gives no size, so its pin stands.
    store.ingestListings([listing('house-1', {style: 'multi_family', sqft: 3100, beds: 3}), listing('land-1', {style: 'land'})]);
    await store.enrichNycListingsWithPluto({plutoFetcher, geosearchFetcher: async () => null});
    const placed = Object.fromEntries(store.query('SELECT property_id, bbl, zoning_district FROM market_listings').map(r => [r.property_id, [r.bbl, r.zoning_district]]));
    assert.deepEqual(placed['house-1'], ['3000020002', 'R4']);
    assert.deepEqual(placed['land-1'], ['3000010001', 'M1-1']);
    assert.equal(queries.filter(q => q.includes('address=')).length, 1, 'only the listing that does not fit its pinned lot looks for a twin');
    // The house is valued on its residential lot; the land on the manufacturing lot is not rated, and no
    // envelope reports a FAR other than the one that produced it.
    const [houseDeal] = store.searchDeals({listingId: 'house-1:for_sale', minUnusedZfa: 0, includeSimilarComps: false});
    assert.equal(houseDeal.maxStandardZfa, Math.round(2000 * houseDeal.standardFar));
    assert.equal(houseDeal.maxUapZfa, Math.round(2000 * houseDeal.uapFar));
    const [landDeal] = store.searchDeals({listingId: 'land-1:for_sale', minUnusedZfa: 0, includeSimilarComps: false});
    assert.deepEqual([landDeal.standardFar, landDeal.maxStandardZfa, landDeal.maxBuildableUnits, landDeal.flashcardValuation.dealVerdict, landDeal.flashcardValuation.valueDriver], [0, 0, null, null, null]);
  } finally {
    cleanup();
  }
});

test('the nearby land model widens to a mile and a half, then two, only where a mile holds fewer than six sales', () => {
  // Development-site sales due east of the lot at the given distances (0.0191 degrees of longitude is about a mile here).
  const lot = {latitude: 40.68, longitude: -73.95, bbl: '3999990001', lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0, corner: false};
  const at = miles => miles.map((d, i) => ({docId: `S${i}`, bbl: `30000000${String(i).padStart(2, '0')}`, recordedAt: '2025-08-01', price: (200 + 10 * i) * 10000,
    latitude: 40.68, longitude: -73.95 + d * 0.0191, pricePerBsf: 200 + 10 * i, lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0}));
  const figure = (comps, radius) => nearbyLandModel(comps, lot) && JSON.stringify(nearbyLandModel(comps.filter(c => c.longitude <= -73.95 + radius * 0.0191), lot));
  assert.deepEqual(LAND_COMPS.radiiMiles, [1, 1.5, 2]);
  // Six within a mile: the farther sales change nothing, byte for byte.
  const covered = at([0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 1.2, 1.3, 1.7]);
  assert.equal(JSON.stringify(nearbyLandModel(covered, lot)), figure(covered, 1));
  assert.equal(nearbyLandModel(covered, lot).saleCount, 6);
  // Four within a mile: the nearest sales within a mile and a half, and the stated radius is the farthest one used.
  const sparse = at([0.2, 0.4, 0.6, 0.8, 1.2, 1.3, 1.7]);
  assert.deepEqual([nearbyLandModel(sparse, lot).saleCount, nearbyLandModel(sparse, lot).withinMiles], [6, 1.3]);
  assert.equal(JSON.stringify(nearbyLandModel(sparse, lot)), figure(sparse, 1.5));
  // Three within a mile and a half: out to two miles.
  const sparser = at([0.4, 0.8, 1.2, 1.7, 1.9, 1.95, 2.4]);
  assert.deepEqual([nearbyLandModel(sparser, lot).saleCount, nearbyLandModel(sparser, lot).withinMiles], [6, 1.95]);
  // Fewer than six within two miles: no figure.
  assert.equal(nearbyLandModel(at([0.4, 0.8, 1.2, 1.7, 2.4, 2.6]), lot), null);
});

test('the nearby land model takes its sales from the lot\'s own borough before the radius and count rules', () => {
  // A Manhattan lot by the East River: five Queens sales lie closer than any Manhattan sale.
  const lot = {latitude: 40.75, longitude: -73.96, bbl: '1013490001', lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0, corner: false};
  const sale = (borough, miles, i) => ({docId: `${borough}${i}`, bbl: `${borough}00000${String(i).padStart(4, '0')}`, recordedAt: '2025-08-01', price: (200 + 10 * i) * 10000,
    latitude: 40.75, longitude: -73.96 + (borough === '4' ? 1 : -1) * miles * 0.0189, pricePerBsf: 200 + 10 * i, lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0});
  const queens = [0.3, 0.4, 0.5, 0.6, 0.7].map((d, i) => sale('4', d, i));
  const manhattan = [0.8, 0.85, 0.9, 0.95, 0.98, 0.99].map((d, i) => sale('1', d, i + 10));
  const figure = nearbyLandModel([...queens, ...manhattan], lot);
  assert.deepEqual(figure.model.comps.map(c => c.bbl[0]), ['1', '1', '1', '1', '1', '1']);
  assert.equal(JSON.stringify(figure), JSON.stringify(nearbyLandModel(manhattan, lot)));
  assert.equal(figure.inBorough, true);
  // A lot without a BBL has no known borough: it reads every sale, and its figure says so.
  const anywhere = nearbyLandModel([...queens, ...manhattan], {...lot, bbl: null});
  assert.deepEqual([anywhere.inBorough, anywhere.model.comps.map(c => c.bbl[0]).join('')], [false, '44444111111']);
  // Five Manhattan sales within two miles say nothing, however many sales lie across the river.
  assert.equal(nearbyLandModel([...queens, ...manhattan.slice(1)], lot), null);
});

test('a figure from sales past a mile is scaled down by the widened-radius factor, and a one-mile figure is not', () => {
  const lot = {latitude: 40.68, longitude: -73.95, bbl: '3999990001', lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0, corner: false};
  const at = miles => miles.map((d, i) => ({docId: `S${i}`, bbl: `30000000${String(i).padStart(2, '0')}`, recordedAt: '2025-08-01', price: (200 + 10 * i) * 10000,
    latitude: 40.68, longitude: -73.95 + d * 0.0191, pricePerBsf: 200 + 10 * i, lotArea: 5000, zfa: 10000, existingSf: 0, unitsRes: 0}));
  // Comps with the lot's own traits need no adjustment, so the weighted median is one of their prices.
  const near = nearbyLandModel(at([0.2, 0.4, 0.6, 0.8, 0.9, 0.95]), lot);
  assert.equal(near.pricePerBsf, Math.round(near.model.medianAdjustedPricePerBsf * Math.exp(NEARBY_LAND_MODEL.constant)));
  assert.equal('widenedFactor' in near.model || 'searchRadiusMiles' in near.model, false);
  for (const [miles, radius] of [[[0.2, 0.4, 0.6, 0.8, 1.2, 1.4], 1.5], [[0.4, 0.8, 1.2, 1.7, 1.9, 1.95], 2]]) {
    const far = nearbyLandModel(at(miles), lot);
    assert.equal(far.pricePerBsf, Math.round(far.model.medianAdjustedPricePerBsf * Math.exp(NEARBY_LAND_MODEL.constant + NEARBY_LAND_MODEL.widened)));
    assert.deepEqual([far.model.searchRadiusMiles, far.model.widenedFactor], [radius, Number(Math.exp(NEARBY_LAND_MODEL.widened).toFixed(4))]);
  }
  assert.ok(NEARBY_LAND_MODEL.widened < 0);
});
