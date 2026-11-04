import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from './market-store.mjs';
import {BOROUGH_BOXES, PARTITION_CAP, collectBox, loopnetApiKey, loopnetClient, loopnetListing, parseSearchPage, searchCriteria, syncLoopNetListings} from './loopnet-listings.mjs';

const card = ({id, street, city, zip, listingType = 'PropertyForSale', propertyType, rows, streetInAddress = false}) => `<li><article class="placard-card" data-lk="${id}" data-automation-city="${city}" data-automation-state="NY" data-automation-postal-code="${zip}" data-automation-listing-type="${listingType}" data-automation-property-type="${propertyType}" data-automation-transaction-type="ForSale">
  <a class="placard-link" href="https://www.loopnet.com/Listing/${street.replace(/\W+/g, '-')}-${city.replace(/\W+/g, '-')}-NY/${id}/" title="More details">
    <div class="placard-image"><img src="https://images1.loopnet.com/i2/abc/115/image.jpg"></div>
    <div class="placard-content">
      ${streetInAddress ? `<h4 class="placard-address">${street}, ${city}, NY ${zip}</h4>` : `<h4 class="building-name">${street}</h4><h4 class="placard-address">${city}, NY ${zip}</h4>`}
      <ul class="placard-data">${rows.map(r => `<li class="data-row">${r.join(' · ')}</li>`).join('')}</ul>
      <div class="placard-info"><span class="broker-name">Sharone Levy</span><span class="phone">(718) 786-5050</span></div>
    </div>
  </a>
</article></li>`;

const CARDS = {
  castleton: {id: '42351095', street: '441 Castleton Ave', city: 'Staten Island', zip: '10301', propertyType: 'GeneralRetail', rows: [['Storefront Retail/Residential', '$1,100,000'], ['3,480 SF', 'Built in 1931']]},
  wyckoff: {id: '42000001', street: '287 Wyckoff St', city: 'Brooklyn', zip: '11217', propertyType: 'Multifamily', rows: [['Apartment', '$3,100,000'], ['4.5% Cap Rate', '6 Units']], streetInAddress: true},
  jamaica: {id: '42000002', street: '163-03 Jamaica Ave', city: 'Jamaica', zip: '11432', listingType: 'LandForSale', propertyType: 'Land', rows: [['Commercial', '$2,500,000'], ['0.25 AC']]},
  condos: {id: '42000003', street: '134 W 29th St', city: 'New York', zip: '10001', propertyType: 'Office', rows: [['Office Condos', '$1,950,000 - $5,950,000'], ['3,270 - 10,000 SF', '2 Units']]},
  medical: {id: '42000008', street: '849 53rd St', city: 'Brooklyn', zip: '11220', listingType: 'ConsolidatedCondosForSale', propertyType: 'Office', rows: [['Medical Condo', '$1,090,000'], ['18,764 SF', '1 Unit']]},
  auction: {id: '42000009', street: '12 Court St', city: 'Brooklyn', zip: '11201', listingType: 'PropertyForAuction', propertyType: 'Multifamily', rows: [['Apartment', 'Starting Bid $900,000'], ['4,000 SF']]},
  portfolio: {id: '42000004', street: 'Powers St', city: 'Brooklyn', zip: '11211', listingType: 'CommercialPortfolioForSale', propertyType: 'Multifamily', rows: [['Multifamily', '$3,250,000'], ['3 Properties']]},
  hoboken: {id: '42000005', street: '600 Washington St', city: 'Hoboken', zip: '07030', propertyType: 'GeneralRetail', rows: [['Storefront', '$2,000,000'], ['2,000 SF']]},
  atlantic: {id: '42000006', street: 'Atlantic Ave', city: 'Brooklyn', zip: '11216', propertyType: 'Land', rows: [['Residential', 'Price Upon Request']]},
  hotel: {id: '42000007', street: '55 Lafayette St', city: 'New York', zip: '10013', propertyType: 'Hospitality', rows: [['Hotel', '$40,000,000'], ['80 Rooms']]},
  bay: {id: '42665541', street: '538-540 Bay St', city: 'Staten Island', zip: '10304', propertyType: 'GeneralRetail', rows: [['Storefront Retail/Residential', 'Price Upon Request'], ['5,682 SF', 'Built in 1931']]},
};
const PINS = {'42351095': [40.634087, -74.096979], '42000001': [40.6839, -73.985], '42000002': [40.7045, -73.7945], '42000003': [40.7468, -73.9915], '42000005': [40.7441, -74.0303], '42000006': [40.6782, -73.9442], '42000007': [40.7158, -74.0027], '42665541': [40.628653, -74.076622]};
const page = (keys, count = keys.length) => ({
  count,
  pd: keys.map(k => ({lid: CARDS[k].id, ia: false, ip: false})),
  nlids: keys.map(k => CARDS[k].id),
  pl: `<div class="placards"><ul class="placard-list">${keys.map(k => card(CARDS[k])).join('')}</ul></div>`,
  sp: keys.filter(k => PINS[CARDS[k].id]).map(k => `${CARDS[k].id}||${PINS[CARDS[k].id].join('|')}|1|1|0|`).join('~') + '~22522211|42000004|40.7|-73.9|1|1|0|',
});

const pluto = (bbl, address, zipcode, latitude, longitude) => ({bbl: `${bbl}.00000000`, address, zipcode, zonedist1: 'R6A', lotarea: '2500', bldgarea: '2800', builtfar: '1.12', residfar: '3.0', affresfar: '3.6', commfar: '0', facilfar: '3.0', unitsres: '3', unitstotal: '3', bldgclass: 'C0', latitude, longitude});
const PLUTO_ROWS = [
  pluto('5000120010', '441 CASTLETON AVENUE', '10301', '40.6340900', '-74.0969800'),
  pluto('3003940050', '287 WYCKOFF STREET', '11217', '40.6839000', '-73.9850000'),
  pluto('4098760012', '163-03 JAMAICA AVENUE', '11432', '40.7045100', '-73.7945100'),
  pluto('5000130020', '538 BAY STREET', '10304', '40.6286500', '-74.0766200'),
];

// Every borough box answers with the same page set; the top Staten Island box is over the cap
// once when `split` is set, so its four quarters are searched instead.
function fakeClient({pages = [['castleton', 'wyckoff', 'jamaica', 'condos', 'portfolio', 'hoboken', 'atlantic', 'hotel'], ['bay']], split = false, status = null, requests = []} = {}) {
  const total = pages.flat().length;
  return {
    async search(criteria) {
      requests.push(criteria);
      if (status) { const err = new Error(`LoopNet API HTTP ${status}: the session companion is offline (temporary outage)`); throw err; }
      const box = criteria.mapCriteria.boundingBox;
      const width = box.br.ln - box.tl.ln;
      if (split && width > (BOROUGH_BOXES.SI[2] - BOROUGH_BOXES.SI[0]) * 0.75) return {...page([], PARTITION_CAP)};
      const index = criteria.pagingCriteria.page - 1;
      return page(pages[index] || [], index === 0 ? 40 + total : total);
    },
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-loopnet-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  return {dir, store, cleanup: () => { store.close(); rmSync(dir, {recursive: true, force: true}); }};
}

test('a search page yields cards with the street line, facts and the pin coordinates', () => {
  const cards = parseSearchPage(page(['castleton', 'wyckoff', 'portfolio']));
  assert.equal(cards.length, 3);
  const [castleton, wyckoff, portfolio] = cards;
  assert.deepEqual({...castleton, facts: undefined}, {listingId: '42351095', url: 'https://www.loopnet.com/Listing/441-Castleton-Ave-Staten-Island-NY/42351095/', listingType: 'PropertyForSale', propertyType: 'GeneralRetail', city: 'Staten Island', zipCode: '10301', address: '441 Castleton Ave, Staten Island, NY 10301', latitude: 40.634087, longitude: -74.096979, facts: undefined});
  assert.deepEqual(castleton.facts, ['Storefront Retail/Residential', '$1,100,000', '3,480 SF', 'Built in 1931']);
  assert.equal(wyckoff.address, '287 Wyckoff St, Brooklyn, NY 11217', 'a card whose address line carries the street keeps it');
  assert.deepEqual([portfolio.latitude, portfolio.longitude], [40.7, -73.9], 'a portfolio takes the pin of its first property');
});

test('only whole-lot sale listings in the five boroughs become candidates', () => {
  const listing = key => loopnetListing(parseSearchPage(page([key]))[0]);
  assert.deepEqual(listing('castleton'), {listingId: '42351095', url: 'https://www.loopnet.com/Listing/441-Castleton-Ave-Staten-Island-NY/42351095/', street: '441 Castleton Ave', borough: 'SI', city: 'Staten Island', zipCode: '10301', latitude: 40.634087, longitude: -74.096979, askingPrice: 1100000, buildingSqft: 3480, lotSqft: null, yearBuilt: 1931, style: 'mixed_use'});
  const jamaica = listing('jamaica');
  assert.deepEqual([jamaica.street, jamaica.borough, jamaica.lotSqft, jamaica.buildingSqft, jamaica.style], ['163-03 Jamaica Ave', 'QN', 10890, null, 'land'], 'land size is the lot; Queens hyphenated numbers stay whole');
  assert.deepEqual([listing('bay').street, listing('bay').askingPrice], ['538 Bay St', null], 'a frontage range keeps its first number; price on request stays unpriced');
  assert.equal(listing('wyckoff').style, 'multi_family');
  assert.deepEqual(listing('condos'), {skip: 'unit'});
  assert.deepEqual(listing('medical'), {skip: 'unit'});
  assert.deepEqual(listing('auction'), {skip: 'listingType'});
  assert.deepEqual(listing('portfolio'), {skip: 'portfolio'});
  assert.deepEqual(listing('hoboken'), {skip: 'nonNyc'});
  assert.deepEqual(listing('atlantic'), {skip: 'noAddress'});
  assert.deepEqual(listing('hotel'), {skip: 'propertyType'});
});

test('a box at the result cap is split in four and smaller boxes are paged', async () => {
  const requests = [];
  const cards = new Map();
  const report = {searches: 0};
  await collectBox(fakeClient({split: true, requests}), BOROUGH_BOXES.SI, cards, report);
  assert.equal(report.searches, 9, 'one capped search, then two pages for each quarter');
  assert.equal(cards.size, 9, 'cards seen from several quarters are one card each');
  const boxes = requests.map(r => r.mapCriteria.boundingBox);
  assert.ok(boxes.slice(1).every(b => b.br.ln - b.tl.ln < (boxes[0].br.ln - boxes[0].tl.ln) * 0.51));
  assert.deepEqual(requests.map(r => r.pagingCriteria.page), [1, 1, 2, 1, 2, 1, 2, 1, 2]);
  assert.equal(searchCriteria(BOROUGH_BOXES.SI).filters.listingType, 1, 'sale listings only');
});

test('LoopNet rows enter the store as facts and links, match their lots and defer to listings already on the lot', async () => {
  const {store, cleanup} = tempStore();
  try {
    store.ingestListings([{propertyId: 'hh-1', listingType: 'for_sale', address: '287 Wyckoff St, Brooklyn, NY 11217', streetLine: '287 Wyckoff St', city: 'Brooklyn', state: 'NY', zipCode: '11217', latitude: 40.6839, longitude: -73.985, beds: 3, sqft: 2800, listPrice: 3_000_000, pricePerSqft: 1071, isDevelopmentCandidate: true}], 1_000);
    store.write("UPDATE market_listings SET bbl = '3003940050' WHERE property_id = 'hh-1'");

    const report = await syncLoopNetListings(store, {client: fakeClient(), boroughs: ['SI'], plutoFetcher: async () => PLUTO_ROWS, geosearchFetcher: async () => null, now: 2_000});
    assert.equal(report.error, undefined);
    assert.deepEqual({...report, pluto: undefined, coverage: undefined}, {searches: 2, fetched: 9, skipped: {listingType: 0, portfolio: 1, propertyType: 1, unit: 1, nonNyc: 1, noAddress: 1, noCoordinates: 0}, duplicateOfStored: 1, ingested: 4, offMarket: 0, pluto: undefined, coverage: undefined});
    assert.deepEqual(report.coverage, {active: 3, plutoMatched: 3, unusedZfaOver500: 3, priced: 2});

    const deals = store.searchDeals({listingType: 'for_sale', minUnusedZfa: 0, includeSimilarComps: false});
    const castleton = deals.find(d => d.bbl === '5000120010');
    assert.deepEqual([castleton.listingSource, castleton.listingSourceName, castleton.url, castleton.photoUrl, castleton.listPrice, castleton.style], ['loopnet', 'LoopNet', 'https://www.loopnet.com/Listing/441-Castleton-Ave-Staten-Island-NY/42351095/', null, 1100000, 'mixed_use']);
    assert.ok(castleton.unusedUapZfa > 0 && castleton.pricePerBuildableSf > 0, 'priced per buildable square foot');
    assert.equal(deals.find(d => d.bbl === '4098760012').listingSource, 'loopnet');
    assert.equal(deals.find(d => d.bbl === '5000130020').listPrice, null);
    assert.deepEqual(store.query("SELECT property_id FROM market_listings WHERE bbl = '3003940050' AND listing_type = 'for_sale'").map(r => r.property_id), ['hh-1'], 'the MLS row keeps the lot');
    assert.equal(store.one("SELECT listing_type FROM market_listings WHERE property_id = 'loopnet:42000001'").listing_type, 'off_market');
    const stored = JSON.stringify(store.query("SELECT * FROM market_listings WHERE source = 'loopnet'"));
    assert.doesNotMatch(stored, /Sharone|786-5050|images1\.loopnet/, 'no agent names, phones or photos are stored');
    assert.equal(store.getZipRollup('10301'), null, 'ZIP benchmarks stay residential MLS samples');

    // Next pass: the lot the MLS holds is skipped before ingest, a withdrawn listing goes off market.
    const second = await syncLoopNetListings(store, {client: fakeClient({pages: [['wyckoff', 'jamaica', 'bay']]}), boroughs: ['SI'], plutoFetcher: async () => PLUTO_ROWS, geosearchFetcher: async () => null, now: 3_000});
    assert.deepEqual([second.duplicateOfStored, second.ingested, second.offMarket], [1, 2, 1]);
    assert.equal(store.one("SELECT listing_type FROM market_listings WHERE property_id = 'loopnet:42351095'").listing_type, 'off_market');
    assert.equal(store.one("SELECT listing_type FROM market_listings WHERE property_id = 'loopnet:42000002'").listing_type, 'for_sale');

    // An outage keeps every row as it was.
    const outage = await syncLoopNetListings(store, {client: fakeClient({status: 503}), boroughs: ['SI'], plutoFetcher: async () => PLUTO_ROWS, geosearchFetcher: async () => null, now: 4_000});
    assert.match(outage.error, /503/);
    assert.deepEqual([outage.ingested, outage.offMarket], [0, 0]);
    assert.equal(store.one("SELECT listing_type FROM market_listings WHERE property_id = 'loopnet:42000002'").listing_type, 'for_sale');
  } finally {
    cleanup();
  }
});

test('the API key comes from the environment or the research secrets file and the client sends it as a bearer token', async () => {
  const {dir, cleanup} = tempStore();
  try {
    const secrets = join(dir, 'secrets.json');
    writeFileSync(secrets, JSON.stringify({RESEARCH_TOKEN: 'r', LOOPNET_API_KEY: 'file-key'}));
    assert.equal(loopnetApiKey({ACRES_SECRETS_JSON: secrets}), 'file-key');
    assert.equal(loopnetApiKey({LOOPNET_API_KEY: 'env-key', ACRES_SECRETS_JSON: secrets}), 'env-key');
    assert.equal(loopnetApiKey({}), null);
    writeFileSync(secrets, JSON.stringify({RESEARCH_TOKEN: 'r'}));
    assert.equal(loopnetApiKey({ACRES_SECRETS_JSON: secrets}), null);

    const calls = [];
    const responses = [{status: 202, ok: false, headers: new Headers({'retry-after': '0'})}, {status: 200, ok: true, headers: new Headers(), json: async () => ({count: 0, pl: '', sp: ''})}];
    const client = loopnetClient({apiKey: 'file-key', baseUrl: 'https://api.example.test/dev', fetchImpl: async (url, options) => { calls.push({url, options}); return responses.shift(); }});
    assert.deepEqual(await client.search(searchCriteria(BOROUGH_BOXES.BX)), {count: 0, pl: '', sp: ''});
    assert.equal(calls.length, 2, 'a 202 is retried once after Retry-After');
    assert.equal(calls[0].url, 'https://api.example.test/dev/loopnet/search');
    assert.equal(calls[0].options.headers.authorization, 'Bearer file-key');
    assert.deepEqual(JSON.parse(calls[0].options.body).mapCriteria.boundingBox, {br: {lt: 40.7855, ln: -73.7654}, tl: {lt: 40.9176, ln: -73.9339}});

    const down = loopnetClient({apiKey: 'k', fetchImpl: async () => ({status: 503, ok: false, headers: new Headers()})});
    await assert.rejects(down.search(searchCriteria(BOROUGH_BOXES.BX)), /503.*temporary outage/);
  } finally {
    cleanup();
  }
});
