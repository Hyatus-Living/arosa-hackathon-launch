import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from './market-store.mjs';
import {BROKER_FEEDS, brokerStreetLine, fetchBrokerListings, geocodeBrokerListing, syncBrokerListings, zipBorough} from './broker-listings.mjs';

const feed = id => BROKER_FEEDS.find(f => f.id === id);

const RIPCO_PAGE = '<script>var algolia = {"application_id":"APP","search_api_key":"KEY","indices":{"a":{"name":"x"}}};</script><style id="wp-custom-css">';
const RIPCO_HITS = {nbPages: 1, hits: [
  {post_id: 11, post_title: '509 Pacific Street', permalink: 'https://www.ripcony.com/property-listings/509-pacific/', zip: '11217', total_sqft: 4000, lease_or_sale: [['sale']], post_modified: 1792000000, taxonomies: {region: ['Brooklyn'], property_type: ['Mixed Use']}, brokers: ['Agent Name'], phone_number: ['212.555.0100']},
  {post_id: 12, post_title: '1 Lease Street', permalink: 'https://www.ripcony.com/property-listings/1-lease/', zip: '10001', total_sqft: 900, lease_or_sale: [['lease']], post_modified: 1792000000, taxonomies: {region: ['Manhattan'], property_type: ['Street Retail']}},
  {post_id: 13, post_title: '50 Main Street', permalink: 'https://www.ripcony.com/property-listings/50-main/', zip: '11797', total_sqft: 2000, lease_or_sale: [['lease', 'sale']], post_modified: 1792000000, taxonomies: {region: ['New York', 'Long Island'], property_type: ['Office']}},
]};
const besen = (id, title, classes, meta = {}) => ({id, link: `https://besenpartners.com/property/${id}/`, title: {rendered: title}, modified_gmt: '2026-10-09T16:43:25', class_list: classes, property_meta: meta});
const BESEN_ROWS = [
  besen(21, '287 Wyckoff Street', ['property_type-multifamily', 'property_status-for-sale', 'property_city-brooklyn'], {fave_property_price: ['3,100,000']}),
  besen(22, '120 Dean Street', ['property_type-development-site-land', 'property_status-for-sale', 'property_status-under-contract', 'property_city-brooklyn'], {fave_property_price: ['2,650,000'], fave_property_size: ['3,228'], fave_property_land: ['2,500'], fave_property_land_postfix: ['SF'], fave_property_year: ['1931']}),
  besen(23, 'Off Market &#8211; Multifamily: Greater Boston, MA', ['property_type-multifamily', 'property_status-for-sale', 'property_city-boston'], {fave_property_price: ['400,000']}),
];
const rosewoodItem = (href, head, city, tag, price) => `<div role="listitem"><a href="${href}"></a><div class="listing-head-active">${head}</div><div class="price-active">${price}</div><div class="list-desc-active">${city}</div><div class="text-block-47">${tag}</div></div>`;
const ROSEWOOD_PAGE = `<html><body>${rosewoodItem('/listings/761-769-east-tremont', '761-769 East Tremont Avenue Bronx, NY', 'Bronx', 'NYC', '$5,400,000')}${rosewoodItem('/listings/syracuse-ny', 'Syracuse, NY', 'Syracuse', 'National', '')}</body></html>`;

const ariel = (slug, headline, region, offering, status, priceText, price, specs, points) =>
  [slug, `https://storage.googleapis.com/x/${slug}_main.jpg`, 'Marketing tagline', headline, region, 'Multifamily', 'Walk-Up Building', offering, status, priceText, '7/28/2026', '-', price, '-', points.length, specs, '10/6/2026', '• Marketing bullet', ['agent1'], points, `https://storage.googleapis.com/x/${slug}.pdf`];
const ARIEL_ROWS = [
  ariel('1099-ocean-avenue', '1099 Ocean Avenue', 'Flatbush, Brooklyn', 'For Sale', 'Listing', '$4,250,000', 4250000, {'Lot SF': '11,000', 'Gross SF': '9,800 SF', 'Buildable SF': '33,000', Stories: '2+Cellar', Units: '12'}, ['40.6355808, -73.9578732, 1099 Ocean Avenue']),
  ariel('belmont-portfolio', 'Belmont Portfolio', 'Belmont, East Tremont, Bronx', 'For Sale', 'Contract', 'Price: Not Disclosed', 9000000, {'Gorss SF': '14,000'}, ['40.8551, -73.8853, 2384 Hoffman Street', '40.8553, -73.8851, 2386 Hoffman Street']),
  ariel('509-pacific-street', '509 Pacific Street', 'Boerum Hill, Brooklyn', 'For Sale', 'Listing', 'Price: Please Inquire', 5000000, {}, ['40.6835, -73.979, 509 Pacific Street']),
  ariel('680-essex-street', '680 Essex Street', 'East New York, Brooklyn', 'Ground Lease', 'Listing', 'Price: Please Inquire', 1, {}, ['40.6666, -73.8798, 680 Essex St']),
  ariel('400-riverdale-avenue', '400 Riverdale Avenue', 'Ludlow, Yonkers', 'For Sale', 'Listing', '$500,000', 500000, {}, ['40.9186, -73.90109, 400 Riverdale Avenue']),
];
const BKREA_PAGE = '<script src="https://buildout.com/api.js?v8"></script><script>\n    BuildOut.embed({\n      token:     "21b6b9ce6c140328279ec0e80b3911cf5e7d7545",\n      plugin:    "inventory",\n      target:    "buildout"\n    });\n  </script>';
const LEE_PAGE = '<script>BuildOut.embed({"token":"0000000000000000000000000000000000000000","plugin":"inventory","inventoryParentUrl":"https:\\/\\/www.lee-associates.com\\/properties","target":"buildout"});</script>';
const buildout = (id, address, city, zip, attributes, flags = {}) => ({id, address, city, state: 'NY', zip, sale: true, closed: false, under_contract: false, property_sub_type_name: attributes['Property Type'], index_attributes: Object.entries(attributes), show_link: `https://www.bkrea.com/listings?propertyId=${id}`, broker: 'Agent Name', broker_contacts: [{name: 'Agent Name', phone: '917.555.0100'}], photo_url: 'https://cdn/photo.jpg', pdf_url: 'https://buildout.com/docs/om.pdf', ...flags});
const BUILDOUT_PAGES = {
  '21b6b9ce6c140328279ec0e80b3911cf5e7d7545': [
    {inventory: [buildout(31, '817 Avenue H', 'Brooklyn', '11230', {Price: '$8,400,000', 'Lot Size': '1.5 Acres', 'Property Type': 'Other'}), buildout(32, '41-43 Mercer Street', 'New York', '10013', {Price: 'Guidance Upon Request', 'Property Type': 'Other'}, {closed: true})], meta: {total: 3, page: 0, offset: 0, limit: 2}},
    {inventory: [buildout(33, '4 Saint Marks Place', 'New York', '10003', {Price: 'Guidance Upon Request', 'Building Size': '10,036 SF', 'Property Type': 'Mixed-use'}, {under_contract: true})], meta: {total: 3, page: 1, offset: 2, limit: 2}},
  ],
  '0000000000000000000000000000000000000000': [
    {inventory: [buildout(41, '105 - 111 Lakeville Rd', 'New Hyde Park', '11040', {Price: 'Call For Info', 'Building Size': '1,120 SF', 'Property Type': 'Office Building'}), buildout(42, '120 Dean Street', 'Brooklyn', '11201-3704', {Price: '$0', 'Property Type': 'Development Site'})], meta: {total: 2, page: 0, offset: 0, limit: 30}},
  ],
};

const PLACES = {
  '509 Pacific Street': {name: '509 PACIFIC STREET', borough: 'Brooklyn', postalcode: '11217', bbl: '3009280034'},
  '287 Wyckoff Street': {name: '287 WYCKOFF STREET', borough: 'Brooklyn', postalcode: '11217', bbl: '3003940050'},
  '120 Dean Street': {name: '120 DEAN STREET', borough: 'Brooklyn', postalcode: '11201', bbl: '3001900010'},
  '761 East Tremont Avenue': {name: '765 EAST TREMONT AVENUE', borough: 'Bronx', postalcode: '10460', bbl: '2029990001'},
  '1099 Ocean Avenue': {name: '1099 OCEAN AVENUE', borough: 'Brooklyn', postalcode: '11230', bbl: '3051230020'},
  '2384 Hoffman Street': {name: '2384 HOFFMAN STREET', borough: 'Bronx', postalcode: '10458', bbl: '2030620010'},
  '817 Avenue H': {name: '817 AVENUE H', borough: 'Brooklyn', postalcode: '11230', bbl: '3067120001'},
  '4 Saint Marks Place': {name: '4 SAINT MARKS PLACE', borough: 'Manhattan', postalcode: '10003', bbl: '1004630040'},
};
const pluto = (bbl, address, zipcode, latitude, longitude) => ({bbl: `${bbl}.00000000`, borough: 'BK', address, zipcode, zonedist1: 'R6A', lotarea: '2500', bldgarea: '2800', builtfar: '1.12', residfar: '3.0', affresfar: '3.6', commfar: '0', facilfar: '3.0', unitsres: '3', unitstotal: '3', bldgclass: 'C0', latitude, longitude});
const PLUTO_ROWS = [
  pluto('3009280034', '509 PACIFIC STREET', '11217', '40.6835000', '-73.9790000'),
  pluto('3001900010', '118 DEAN STREET', '11201', '40.6870000', '-73.9910000'),
  pluto('3003940050', '287 WYCKOFF STREET', '11217', '40.6839000', '-73.9850000'),
  pluto('3051230020', '1099 OCEAN AVENUE', '11230', '40.6355800', '-73.9578700'),
  pluto('2030620010', '2384 HOFFMAN STREET', '10458', '40.8551000', '-73.8853000'),
  pluto('3067120001', '817 AVENUE H', '11230', '40.6290000', '-73.9640000'),
  pluto('1004630040', '4 SAINT MARKS PLACE', '10003', '40.7290000', '-73.9890000'),
];

function fakeHttp({besenRows = BESEN_ROWS, ripcoDown = false, requests = []} = {}) {
  return {
    async text(url) {
      requests.push(url);
      if (url.includes('ripcony')) { if (ripcoDown) throw new Error('www.ripcony.com HTTP 503'); return RIPCO_PAGE; }
      if (url.includes('rosewoodrg')) return ROSEWOOD_PAGE;
      if (url.includes('bkrea')) return BKREA_PAGE;
      if (url.includes('lee-associates')) return LEE_PAGE;
      throw new Error(`unexpected ${url}`);
    },
    async json(url, options) {
      requests.push(url);
      if (url.includes('algolia.net')) {
        assert.equal(options.headers['x-algolia-api-key'], 'KEY');
        return RIPCO_HITS;
      }
      if (url.includes('/property_status?')) return [{id: 19}, {id: 62}];
      if (url.includes('/properties?')) return besenRows;
      if (url.includes('arielpa.nyc')) return ARIEL_ROWS;
      if (url.includes('buildout.com/plugins/')) {
        assert.doesNotMatch(options.headers['user-agent'], /bot/i, 'Buildout serves crawlers its SEO table instead of JSON');
        const query = new URL(url).searchParams;
        assert.equal(query.get('q[sale_or_lease_eq]'), 'sale');
        assert.equal(query.get('q[state_eq_any][]'), 'NY');
        return BUILDOUT_PAGES[url.split('/')[4]][Number(query.get('page'))];
      }
      if (url.includes('geosearch')) {
        const text = new URL(url).searchParams.get('text');
        const place = PLACES[text.split(',')[0]];
        return {features: place ? [{properties: {...place, addendum: {pad: {bbl: place.bbl}}}}] : []};
      }
      if (url.includes('64uk-42ks')) return PLUTO_ROWS.map(r => ({bbl: r.bbl, address: r.address, latitude: r.latitude, longitude: r.longitude}));
      throw new Error(`unexpected ${url}`);
    },
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-broker-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  return {store, cleanup: () => { store.close(); rmSync(dir, {recursive: true, force: true}); }};
}

test('broker headlines reduce to one NYC street line', () => {
  assert.equal(brokerStreetLine('975 St. Marks Avenue Brooklyn, NY', 'BK'), '975 St. Marks Avenue');
  assert.equal(brokerStreetLine('976 Anderson Avenue High Bridge, Bronx, NY', 'BX'), '976 Anderson Avenue');
  assert.equal(brokerStreetLine('761-769 East Tremont Avenue Bronx, NY', 'BX'), '761 East Tremont Avenue');
  assert.equal(brokerStreetLine('163-03 Horace Harding Expressway Fresh Meadows, NY', 'QN'), '163-03 Horace Harding Expressway');
  assert.equal(brokerStreetLine('88-10 Whitney Avenue Elmhurst, Queens, New York', null), '88-10 Whitney Avenue');
  assert.equal(brokerStreetLine('437–449 & 438–450 61st Street Brooklyn, NY', 'BK'), '437 61st Street');
  assert.equal(brokerStreetLine('Off Market &#8211; Multifamily: Greater Boston, MA', null), null);
  assert.equal(brokerStreetLine('18, 24 & 30 Edgewater Place', 'BK'), '18 Edgewater Place');
  assert.equal(brokerStreetLine('1173 Nelson Avenue & 1092 Anderson Avenue', 'BX'), '1173 Nelson Avenue');
  assert.equal(brokerStreetLine('237- 245 East 36th Street and 663-673 Second Avenue', 'MN'), '237 East 36th Street');
  assert.equal(brokerStreetLine('817 Avenue H', 'BK'), '817 Avenue H');
  assert.equal(brokerStreetLine('3rd Avenue Development Assemblage', 'MN'), null);
});

test('NYC ZIPs name their borough; Nassau and Westchester ZIPs do not', () => {
  assert.deepEqual(['10003', '10304', '10458-3704', '11230', '11101', '11004', '11001', '11040', '10701'].map(zipBorough), ['MN', 'SI', 'BX', 'BK', 'QN', 'QN', null, null, null]);
});

test('the house number and street confirm an address; broker ZIP and borough only break ties', async () => {
  const feature = (name, borough, postalcode, bbl) => ({properties: {name, borough, postalcode, addendum: {pad: {bbl}}}});
  const http = features => ({json: async () => ({features})});
  const bryant = [feature('883 BRYANT AVENUE', 'Bronx', '10474', '2027610107'), feature('885 BRYANT AVENUE', 'Bronx', '10474', '2027610108')];
  // A placeholder ZIP and the wrong borough still confirm the only lot with this address.
  assert.equal((await geocodeBrokerListing({street: '883 Bryant Ave', borough: 'MN', zipCode: '11415'}, http(bryant))).bbl, '2027610107');
  const broadway = [feature('100 BROADWAY', 'Manhattan', '10005', '1000480001'), feature('100 BROADWAY', 'Brooklyn', '11249', '3021340001')];
  assert.equal((await geocodeBrokerListing({street: '100 Broadway', borough: 'BK', zipCode: '11415'}, http(broadway))).bbl, '3021340001');
  assert.equal(await geocodeBrokerListing({street: '100 Broadway', borough: null, cityHint: 'New York', zipCode: null}, http(broadway)), null);
  assert.equal(await geocodeBrokerListing({street: '881 Bryant Ave', borough: 'BX', zipCode: null}, http(bryant)), null);
});

test('adapters keep listing facts and drop leases, contacts and non-NYC rows', async () => {
  const ripco = await fetchBrokerListings(feed('ripco'), fakeHttp());
  assert.deepEqual(ripco.map(l => [l.sourceListingId, l.borough, l.style]), [['11', 'BK', 'mixed_use'], ['13', null, 'office']]);
  assert.equal(JSON.stringify(ripco).includes('212.555'), false);

  const besenRows = await fetchBrokerListings(feed('besen'), fakeHttp());
  const dean = besenRows.find(l => l.sourceListingId === '22');
  assert.deepEqual({price: dean.askingPrice, sqft: dean.buildingSqft, lot: dean.lotSqft, year: dean.yearBuilt, style: dean.style, status: dean.status},
    {price: 2650000, sqft: 3228, lot: 2500, year: 1931, style: 'land', status: 'under_contract'});

  const rosewood = await fetchBrokerListings(feed('rosewood'), fakeHttp());
  assert.deepEqual(rosewood.map(l => [l.street, l.borough, l.askingPrice]), [['761 East Tremont Avenue', 'BX', 5400000], [null, null, null]]);
});

test('the Ariel adapter reads positional rows and keeps undisclosed prices unpriced', async () => {
  const rows = await fetchBrokerListings(feed('ariel'), fakeHttp());
  assert.deepEqual(rows.map(l => [l.sourceListingId, l.street, l.borough, l.askingPrice, l.status]), [
    ['1099-ocean-avenue', '1099 Ocean Avenue', 'BK', 4250000, 'active'],
    ['belmont-portfolio', '2384 Hoffman Street', 'BX', null, 'under_contract'],
    ['509-pacific-street', '509 Pacific Street', 'BK', null, 'active'],
    ['400-riverdale-avenue', '400 Riverdale Avenue', null, 500000, 'active'],
  ], 'a ground lease is not a sale, and a portfolio is placed at its first building');
  const ocean = rows[0];
  assert.deepEqual({url: ocean.url, sqft: ocean.buildingSqft, lot: ocean.lotSqft, stories: ocean.stories, updated: ocean.updatedAt},
    {url: 'https://arielpa.nyc/listing/1099-ocean-avenue', sqft: 9800, lot: 11000, stories: 2, updated: '2026-10-06T00:00:00.000Z'});
  assert.equal(rows[1].buildingSqft, 14000);
  assert.equal(/storage\.googleapis|Marketing|agent1/.test(JSON.stringify(rows)), false);
});

test('the Buildout adapter reads the embed token, pages the NY sale inventory and skips closed deals', async () => {
  const requests = [];
  const bkrea = await fetchBrokerListings(feed('bkrea'), fakeHttp({requests}));
  assert.equal(requests.filter(u => u.includes('inventory.json')).length, 2);
  assert.deepEqual(bkrea.map(l => [l.sourceListingId, l.street, l.borough, l.zipCode, l.askingPrice, l.buildingSqft, l.lotSqft, l.style, l.status]), [
    ['31', '817 Avenue H', 'BK', '11230', 8400000, null, 65340, 'commercial', 'active'],
    ['33', '4 Saint Marks Place', 'MN', '10003', null, 10036, null, 'mixed_use', 'under_contract'],
  ]);
  assert.equal(/917\.555|photo|docs\/om/.test(JSON.stringify(bkrea)), false);

  const lee = await fetchBrokerListings(feed('lee'), fakeHttp());
  assert.deepEqual(lee.map(l => [l.street, l.borough, l.zipCode, l.askingPrice]), [['105 Lakeville Rd', null, '11040', null], ['120 Dean Street', 'BK', '11201', null]]);
});

test('broker sync confirms addresses, defers to MLS rows on the same lot and prices unused FAR', async () => {
  const {store, cleanup} = tempStore();
  try {
    store.ingestListings([{propertyId: 'hh-1', listingType: 'for_sale', address: '287 Wyckoff St, Brooklyn, NY 11217', streetLine: '287 Wyckoff St', city: 'Brooklyn', state: 'NY', zipCode: '11217', latitude: 40.6839, longitude: -73.985, beds: 3, sqft: 2800, listPrice: 3_000_000, pricePerSqft: 1071, isDevelopmentCandidate: true}]);
    store.write("UPDATE market_listings SET bbl = '3003940050' WHERE property_id = 'hh-1'");

    const report = await syncBrokerListings(store, {http: fakeHttp(), plutoFetcher: async () => PLUTO_ROWS, now: 1_000});
    assert.deepEqual(report.errors, {});
    assert.deepEqual(report.feeds.ripco, {fetched: 2, nonNyc: 1, unconfirmedAddress: 0, duplicateOfStored: 0, duplicateOfBroker: 0, ingested: 1, offMarket: 0});
    assert.deepEqual(report.feeds.besen, {fetched: 3, nonNyc: 1, unconfirmedAddress: 0, duplicateOfStored: 1, duplicateOfBroker: 0, ingested: 1, offMarket: 0});
    assert.deepEqual(report.feeds.rosewood, {fetched: 2, nonNyc: 1, unconfirmedAddress: 1, duplicateOfStored: 0, duplicateOfBroker: 0, ingested: 0, offMarket: 0});
    assert.deepEqual(report.feeds.ariel, {fetched: 4, nonNyc: 1, unconfirmedAddress: 0, duplicateOfStored: 0, duplicateOfBroker: 1, ingested: 2, offMarket: 0});
    assert.deepEqual(report.feeds.bkrea, {fetched: 2, nonNyc: 0, unconfirmedAddress: 0, duplicateOfStored: 0, duplicateOfBroker: 0, ingested: 2, offMarket: 0});
    assert.deepEqual(report.feeds.lee, {fetched: 2, nonNyc: 1, unconfirmedAddress: 0, duplicateOfStored: 0, duplicateOfBroker: 1, ingested: 0, offMarket: 0});

    const deals = store.searchDeals({listingType: 'for_sale', minUnusedZfa: 0, includeSimilarComps: false});
    const pacific = deals.find(d => d.bbl === '3009280034');
    assert.equal(pacific.listingSource, 'broker:ripco');
    assert.equal(pacific.listingSourceName, 'RIPCO Real Estate');
    assert.equal(pacific.url, 'https://www.ripcony.com/property-listings/509-pacific/');
    assert.equal(pacific.photoUrl, null);
    const dean = deals.find(d => d.bbl === '3001900010');
    assert.equal(dean.listPrice, 2650000);
    assert.equal(dean.mlsStatus, 'under_contract');
    assert.equal(dean.address, '120 DEAN STREET, Brooklyn, NY 11201', 'the broker address is shown although PLUTO files the lot as 118');
    assert.ok(dean.unusedUapZfa > 0);
    assert.equal(store.query("SELECT COUNT(*) AS n FROM market_listings WHERE bbl = '3003940050'")[0].n, 1, 'the MLS row keeps the lot');
    const ocean = deals.find(d => d.bbl === '3051230020');
    assert.deepEqual([ocean.listingSource, ocean.listingSourceName, ocean.listPrice, ocean.url], ['broker:ariel', 'Ariel Property Advisors', 4250000, 'https://arielpa.nyc/listing/1099-ocean-avenue']);
    assert.equal(deals.find(d => d.bbl === '2030620010').listPrice, null, 'an undisclosed price stays undisclosed');
    assert.equal(deals.find(d => d.bbl === '1004630040').mlsStatus, 'under_contract');

    // ZIP benchmarks stay residential MLS samples.
    assert.equal(store.getZipRollup('11217').sampleCount, 1);
  } finally {
    cleanup();
  }
});

test('a listing a broker withdraws goes off market; a failed feed keeps its rows', async () => {
  const {store, cleanup} = tempStore();
  try {
    await syncBrokerListings(store, {http: fakeHttp(), plutoFetcher: async () => PLUTO_ROWS, now: 1_000});
    const requests = [];
    const report = await syncBrokerListings(store, {http: fakeHttp({besenRows: [], ripcoDown: true, requests}), plutoFetcher: async () => PLUTO_ROWS, now: 2_000});
    assert.match(report.errors.ripco, /503/);
    assert.equal(report.feeds.besen.offMarket, 2);
    const type = id => store.one('SELECT listing_type FROM market_listings WHERE property_id = ?', id).listing_type;
    assert.equal(type('broker:besen:22'), 'off_market');
    assert.equal(type('broker:ripco:11'), 'for_sale');
    const geocoded = requests.filter(u => u.includes('geosearch')).map(u => new URL(u).searchParams.get('text').split(',')[0]);
    assert.deepEqual(geocoded.sort(), ['120 Dean Street', '509 Pacific Street', '761 East Tremont Avenue'], 'only listings without a stored lot are geocoded again');
  } finally {
    cleanup();
  }
});

test('a lot listed by a broker and on the MLS is one deal at the MLS price, whichever arrives first', async () => {
  const mls = {propertyId: 'hh-9', listingType: 'for_sale', address: '509 Pacific St, Brooklyn, NY 11217', streetLine: '509 Pacific St', streetNumber: '509', streetName: 'Pacific', city: 'Brooklyn', state: 'NY', zipCode: '11217', latitude: 40.6835, longitude: -73.979, listPrice: 2_100_000, url: 'https://www.realtor.com/509-pacific', isDevelopmentCandidate: true};
  const plutoFetcher = async () => PLUTO_ROWS;
  const onLot = store => store.searchDeals({listingType: 'for_sale', minUnusedZfa: 0}).filter(d => d.bbl === '3009280034').map(d => [d.propertyId, d.listPrice, d.url]);
  for (const order of ['mls first', 'broker first']) {
    const {store, cleanup} = tempStore();
    try {
      const mlsSync = async () => { store.ingestListings([mls], 5_000); await store.enrichNycListingsWithPluto({plutoFetcher}); };
      if (order === 'mls first') await mlsSync();
      await syncBrokerListings(store, {http: fakeHttp(), plutoFetcher, now: 6_000});
      if (order === 'broker first') {
        assert.equal(onLot(store)[0][0], 'broker:ripco:11');
        await mlsSync();
        assert.equal(store.one("SELECT listing_type FROM market_listings WHERE property_id = 'broker:ripco:11'").listing_type, 'off_market');
      }
      assert.deepEqual(onLot(store), [['hh-9', 2_100_000, 'https://www.realtor.com/509-pacific']], order);
      // A later broker pass keeps the lot with the MLS row.
      await syncBrokerListings(store, {http: fakeHttp(), plutoFetcher, now: 7_000});
      assert.deepEqual(onLot(store), [['hh-9', 2_100_000, 'https://www.realtor.com/509-pacific']], `${order}, after another broker pass`);
    } finally {
      cleanup();
    }
  }
});
