import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
import {addressIdentity} from './parcels.mjs';
import {MarketStore, marketDbPath, PLUTO_DATASET_URL} from './market-store.mjs';

// NYC investment-sales brokers publish their own exclusives on their websites, the same
// listings they syndicate to LoopNet and Crexi. Each feed reads one broker's public site
// search or CMS output. Only listing facts are kept: no photos, marketing copy or agent
// contacts, and every row links back to the broker's page.
export const BROKER_FEEDS = [
  {id: 'ripco', name: 'RIPCO Real Estate', adapter: 'wp-algolia', pageUrl: 'https://www.ripcony.com/property-listings/?leaseOrSale=sale', index: 'wp_posts_property-listings'},
  {id: 'besen', name: 'Besen Partners', adapter: 'houzez', apiBase: 'https://besenpartners.com/wp-json/wp/v2'},
  {id: 'rosewood', name: 'Rosewood Realty Group', adapter: 'webflow', pageUrl: 'https://www.rosewoodrg.com/active-listings'},
  {id: 'ariel', name: 'Ariel Property Advisors', adapter: 'ariel-json', dataUrl: 'https://arielpa.nyc/assets/pages/list-on-market.json', listingBase: 'https://arielpa.nyc/listing/'},
  {id: 'bkrea', name: 'BKREA', adapter: 'buildout', pageUrl: 'https://bkrea.com/listings'},
  {id: 'lee', name: 'Lee & Associates', adapter: 'buildout', pageUrl: 'https://www.lee-associates.com/properties'},
];

const USER_AGENT = 'Mozilla/5.0 (compatible; ArosaBot/1.0; +https://witharosa.ai)';
// Buildout answers crawler user agents with its static SEO table instead of the inventory JSON,
// so Buildout requests name Arosa without the crawler token.
const BUILDOUT_AGENT = 'Mozilla/5.0 (compatible; Arosa/1.0; +https://witharosa.ai)';
const GEOSEARCH_URL = 'https://geosearch.planninglabs.nyc/v2/search';
const BOROUGH_CODES = {manhattan: 'MN', 'north manhattan': 'MN', 'northern manhattan': 'MN', brooklyn: 'BK', queens: 'QN', bronx: 'BX', 'the bronx': 'BX', 'staten island': 'SI'};
// USPS ZIP prefixes of the five boroughs; 110 is Nassau County apart from Queens' 11004 and 11005.
const ZIP_PREFIX_BOROUGH = {100: 'MN', 101: 'MN', 102: 'MN', 103: 'SI', 104: 'BX', 111: 'QN', 112: 'BK', 113: 'QN', 114: 'QN', 116: 'QN'};
const BOROUGH_CITY = {MN: 'New York', BK: 'Brooklyn', QN: 'Queens', BX: 'Bronx', SI: 'Staten Island'};
const STREET_END = /^(.*\b(?:(?:avenue|ave)(?: [a-z](?![\w.]))?|street|st|boulevard|blvd|road|rd|place|pl|expressway|expy|parkway|pkwy|drive|dr|lane|ln|court|ct|terrace|ter|square|sq|highway|hwy|way|broadway|concourse|plaza|turnpike|tpke|bowery|slip|loop|walk|row))\b/i;

async function request(url, {method = 'GET', headers = {}, body = null} = {}) {
  const response = await fetch(url, {method, headers: {'user-agent': USER_AGENT, ...headers}, body, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`${new URL(url).host} HTTP ${response.status}`);
  return response;
}

export const defaultHttp = {
  json: async (url, options) => (await request(url, options)).json(),
  text: async url => (await request(url)).text(),
};

const decodeEntities = value => String(value || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

const number = value => {
  const digits = String(value ?? '').replace(/[^0-9.]/g, '');
  const n = digits ? Number(digits) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function boroughCode(value) {
  return BOROUGH_CODES[String(value || '').toLowerCase().replace(/-/g, ' ').trim()] || null;
}

export function zipBorough(zip) {
  const code = String(zip || '').slice(0, 5);
  return ZIP_PREFIX_BOROUGH[code.slice(0, 3)] || (code === '11004' || code === '11005' ? 'QN' : null);
}

// Publicly shown asking prices only: "Guidance Upon Request" and "$0" stay unpriced.
const askingPrice = text => (/^\s*\$/.test(text || '') ? number(text) : null);

// The street line of a broker headline: "975 St. Marks Avenue Brooklyn, NY" -> "975 St. Marks Avenue".
// Combined frontages ("437-449 & 438-450 61st Street", "18, 24 & 30 Edgewater Place") keep the first address, and a house-number
// range outside Queens ("761-769 East Tremont Avenue") keeps its first number. Queens numbers such
// as "163-03" are a single address. A headline without a house number ("3rd Avenue Assemblage") is
// not an address.
export function brokerStreetLine(headline, borough = null) {
  let line = decodeEntities(headline).replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().replace(/^(\d+) ?- ?(\d+)\b/, '$1-$2');
  line = line.replace(/^(\d[\w-]*)(?:, ?\d[\w-]*)* ?(?:,|&|and) ?\d[\w-]* /i, '$1 ').split(',')[0].split(/ (?:&|and) (?=\d)/i)[0].trim();
  const street = line.match(STREET_END);
  if (street) line = street[1];
  const range = line.match(/^(\d+)-(\d+)(\s.+)$/);
  if (range && borough !== 'QN' && range[1].length === range[2].length && Number(range[2]) > Number(range[1])) line = `${range[1]}${range[3]}`;
  return /^\d[\d-]*[a-z]? /i.test(line) ? line : null;
}

function styleFor(types) {
  const text = types.join(' ').toLowerCase();
  if (/land|development|ground lease/.test(text)) return 'land';
  if (/mixed/.test(text)) return 'mixed_use';
  if (/multi|residential|walk|elevator|apartment/.test(text)) return 'multi_family';
  if (/hotel/.test(text)) return 'hotel';
  if (/office/.test(text)) return 'office';
  if (/industrial|warehouse/.test(text)) return 'industrial';
  if (/retail|restaurant|medical|freestanding|shopping/.test(text)) return 'retail';
  return 'commercial';
}

async function ripcoListings(feed, http) {
  const page = await http.text(feed.pageUrl);
  const config = JSON.parse(page.match(/var algolia = (\{.*?\});\s*(?:<\/script>|$)/m)[1]);
  const url = `https://${config.application_id}-dsn.algolia.net/1/indexes/${feed.index}/query`;
  const headers = {'x-algolia-application-id': config.application_id, 'x-algolia-api-key': config.search_api_key};
  const hits = [];
  for (let pageNo = 0, pages = 1; pageNo < pages; pageNo++) {
    const result = await http.json(url, {method: 'POST', headers, body: JSON.stringify({params: `hitsPerPage=1000&page=${pageNo}`})});
    hits.push(...result.hits);
    pages = result.nbPages;
  }
  return hits.filter(h => h.lease_or_sale.flat().includes('sale')).map(h => {
    const borough = (h.taxonomies.region || []).map(boroughCode).find(Boolean) || null;
    return {
      sourceListingId: String(h.post_id),
      url: h.permalink,
      street: brokerStreetLine(h.post_title, borough),
      borough,
      zipCode: h.zip || null,
      askingPrice: null,
      buildingSqft: number(h.total_sqft),
      lotSqft: null,
      yearBuilt: null,
      stories: null,
      style: styleFor(h.taxonomies.property_type || []),
      status: 'active',
      updatedAt: new Date(h.post_modified * 1000).toISOString(),
    };
  });
}

async function houzezListings(feed, http) {
  const statuses = await http.json(`${feed.apiBase}/property_status?slug=for-sale,under-contract`);
  const fields = 'id,link,title,modified_gmt,class_list,property_meta';
  const rows = [];
  for (let pageNo = 1; ; pageNo++) {
    const batch = await http.json(`${feed.apiBase}/properties?property_status=${statuses.map(s => s.id).join(',')}&per_page=100&page=${pageNo}&_fields=${fields}`);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows.map(p => {
    const classes = p.class_list;
    const terms = prefix => classes.filter(c => c.startsWith(prefix)).map(c => c.slice(prefix.length));
    const meta = key => p.property_meta[key]?.[0];
    const borough = terms('property_city-').map(boroughCode).find(Boolean) || null;
    const lotSqft = number(meta('fave_property_land'));
    const [lat, lng] = String(meta('fave_property_location') || '').split(',').map(Number);
    return {
      sourceListingId: String(p.id),
      url: p.link,
      street: brokerStreetLine(p.title.rendered, borough),
      borough,
      zipCode: null,
      askingPrice: number(meta('fave_property_price')),
      buildingSqft: number(meta('fave_property_size')),
      lotSqft: lotSqft && /acre/i.test(meta('fave_property_land_postfix') || '') ? Math.round(lotSqft * 43560) : lotSqft,
      yearBuilt: number(meta('fave_property_year')),
      stories: number(meta('fave_stories')),
      style: styleFor(terms('property_type-')),
      status: terms('property_status-').includes('under-contract') ? 'under_contract' : 'active',
      updatedAt: `${p.modified_gmt}Z`,
      hint: Number.isFinite(lat) && Number.isFinite(lng) ? {lat, lng} : null,
    };
  });
}

async function webflowListings(feed, http) {
  const {document} = parseHTML(await http.text(feed.pageUrl));
  return [...document.querySelectorAll('[role="listitem"]')].map(item => {
    const text = selector => item.querySelector(selector)?.textContent.trim() || '';
    const href = item.querySelector('a[href^="/listings/"]')?.getAttribute('href');
    const borough = boroughCode(text('.list-desc-active'));
    const inNyc = [...item.querySelectorAll('.text-block-47')].some(e => /^(NYC|New York City)$/i.test(e.textContent.trim()));
    return {
      sourceListingId: href ? href.split('/').pop() : null,
      url: href ? new URL(href, feed.pageUrl).href : null,
      street: brokerStreetLine(text('.listing-head-active'), borough),
      borough: inNyc ? borough : null,
      cityHint: inNyc ? text('.list-desc-active') : null,
      zipCode: null,
      askingPrice: number(text('.price-active')),
      buildingSqft: null,
      lotSqft: null,
      yearBuilt: null,
      stories: null,
      style: 'commercial',
      status: 'active',
      updatedAt: null,
    };
  }).filter(l => l.sourceListingId);
}

// Ariel publishes its on-market offerings as one JSON file of positional rows: 0 slug, 3 headline,
// 4 "neighborhood, borough", 5-6 property types, 7 offering type, 8 Listing or Contract, 9 price
// text, 15 spec pairs with free-form keys, 16 last update (M/D/YYYY), 19 "lat, lng, address" per
// building. Index 12 holds a number even when the price is not disclosed, so it is never read.
async function arielListings(feed, http) {
  const rows = await http.json(feed.dataUrl);
  return rows.filter(r => r[7].includes('For Sale')).map(r => {
    const borough = boroughCode(r[4].split(',').pop());
    const spec = pattern => number(Object.entries(r[15]).find(([key]) => pattern.test(key))?.[1]);
    const [month, day, year] = r[16].split('/').map(Number);
    return {
      sourceListingId: r[0],
      url: `${feed.listingBase}${r[0]}`,
      street: brokerStreetLine(r[3], borough) || brokerStreetLine(r[19][0].split(',').slice(2).join(','), borough),
      borough,
      zipCode: null,
      askingPrice: askingPrice(r[9]),
      buildingSqft: spec(/^(gross|gorss|building) (sf|sq\. ?ft)/i),
      lotSqft: spec(/^(gross )?lot (sf|size|sq\. ?ft|area)/i),
      yearBuilt: spec(/^year built$/i),
      stories: spec(/^stories$/i),
      style: styleFor([r[5], r[6]]),
      status: r[8] === 'Contract' ? 'under_contract' : 'active',
      updatedAt: new Date(Date.UTC(year, month - 1, day)).toISOString(),
    };
  });
}

// Buildout hosts many brokers' inventories behind the token in the broker page's
// BuildOut.embed({token}) call. The NY sale inventory is paged 30 rows at a time.
async function buildoutListings(feed, http) {
  const token = (await http.text(feed.pageUrl)).match(/BuildOut\.embed\(\{[^}]*?token["']?\s*:\s*["']([0-9a-f]{40})["']/)[1];
  const headers = {'user-agent': BUILDOUT_AGENT};
  const rows = [];
  for (let pageNo = 0, pages = 1; pageNo < pages; pageNo++) {
    const query = new URLSearchParams({'q[sale_or_lease_eq]': 'sale', 'q[state_eq_any][]': 'NY', page: String(pageNo)});
    const result = await http.json(`https://buildout.com/plugins/${token}/inventory.json?${query}`, {headers});
    rows.push(...result.inventory);
    pages = Math.ceil(result.meta.total / result.meta.limit);
  }
  return rows.filter(r => r.sale && !r.closed).map(r => {
    const attributes = Object.fromEntries(r.index_attributes);
    const borough = zipBorough(r.zip);
    const lot = attributes['Lot Size'] || '';
    return {
      sourceListingId: String(r.id),
      url: r.show_link,
      street: brokerStreetLine(r.address, borough),
      borough,
      zipCode: r.zip ? r.zip.slice(0, 5) : null,
      askingPrice: askingPrice(attributes.Price),
      buildingSqft: number(attributes['Building Size']),
      lotSqft: /acre/i.test(lot) ? Math.round(number(lot) * 43560) : number(lot),
      yearBuilt: null,
      stories: null,
      style: styleFor([r.property_sub_type_name, attributes['Property Type']]),
      status: r.under_contract ? 'under_contract' : 'active',
      updatedAt: null,
    };
  });
}

const ADAPTERS = {'wp-algolia': ripcoListings, houzez: houzezListings, webflow: webflowListings, 'ariel-json': arielListings, buildout: buildoutListings};

export async function fetchBrokerListings(feed, http = defaultHttp) {
  return ADAPTERS[feed.adapter](feed, http);
}

// GeoSearch confirms the address is a NYC tax lot: a candidate must carry the listing's house
// number and street. Broker ZIP and borough fields are self-reported and sometimes a placeholder,
// so they only choose among same-named streets; with several matches and no agreeing hint the
// address stays unconfirmed.
export async function geocodeBrokerListing(listing, http = defaultHttp) {
  const place = listing.borough ? BOROUGH_CITY[listing.borough] : listing.cityHint || 'New York';
  const url = new URL(GEOSEARCH_URL);
  url.searchParams.set('text', `${listing.street}, ${place}, NY`);
  url.searchParams.set('size', '10');
  const result = await http.json(url.href);
  const identity = addressIdentity(listing.street);
  const matches = result.features.filter(f => addressIdentity(f.properties.name) === identity && /^[1-5]\d{9}$/.test(String(f.properties.addendum?.pad?.bbl || '')));
  const lots = [...new Map(matches.map(f => [f.properties.addendum.pad.bbl, f])).values()];
  const match = lots.find(f => listing.zipCode && f.properties.postalcode === listing.zipCode)
    || lots.find(f => listing.borough && boroughCode(f.properties.borough) === listing.borough)
    || (lots.length === 1 ? lots[0] : null);
  if (!match) return null;
  return {bbl: String(match.properties.addendum.pad.bbl), borough: boroughCode(match.properties.borough), zipCode: match.properties.postalcode || null, address: match.properties.name};
}

// The PLUTO lot centroid and address become the listing's coordinates and matching street, so
// the deal store's PLUTO matcher resolves the lot the address confirmed, including a lot PLUTO
// files under another house number of its frontage.
export async function plutoCentroids(bbls, http = defaultHttp) {
  const out = new Map();
  for (let i = 0; i < bbls.length; i += 50) {
    const url = new URL(PLUTO_DATASET_URL);
    url.searchParams.set('$select', 'bbl,address,latitude,longitude');
    url.searchParams.set('$where', `bbl in (${bbls.slice(i, i + 50).map(b => `'${b}'`).join(',')})`);
    for (const row of await http.json(url.href)) {
      const bbl = String(Math.trunc(Number(row.bbl)));
      if (row.latitude && row.longitude) out.set(bbl, {latitude: Number(row.latitude), longitude: Number(row.longitude), plutoAddress: row.address});
    }
  }
  return out;
}

export function brokerMarketRow(feed, listing, place) {
  const borough = place.borough;
  const city = BOROUGH_CITY[borough];
  const street = place.address;
  const matchStreet = place.plutoAddress || street;
  return {
    propertyId: `broker:${feed.id}:${listing.sourceListingId}`,
    listingId: listing.sourceListingId,
    listingType: 'for_sale',
    mlsStatus: listing.status,
    source: `broker:${feed.id}`,
    sourceName: feed.name,
    address: `${street}, ${city}, NY${place.zipCode ? ` ${place.zipCode}` : ''}`,
    streetLine: matchStreet,
    streetNumber: matchStreet.split(' ')[0],
    city,
    borough,
    state: 'NY',
    zipCode: place.zipCode,
    latitude: place.latitude,
    longitude: place.longitude,
    url: listing.url,
    style: listing.style,
    assetClass: listing.style === 'land' ? 'land_development' : 'commercial_investment',
    isDevelopmentCandidate: true,
    sqft: listing.buildingSqft,
    lotSqft: listing.lotSqft,
    yearBuilt: listing.yearBuilt,
    stories: listing.stories,
    listPrice: listing.askingPrice,
    pricePerSqft: listing.askingPrice && listing.buildingSqft ? Math.round(listing.askingPrice / listing.buildingSqft) : null,
    lastUpdateDate: listing.updatedAt,
  };
}

// One pass over every feed. A feed that fails is reported and leaves its stored rows as they
// were; a feed that succeeds marks its rows missing from this pass off the market.
export async function syncBrokerListings(store, {feeds = BROKER_FEEDS, http = defaultHttp, plutoFetcher, now = Date.now()} = {}) {
  const report = {feeds: {}, errors: {}};
  const claimed = new Map();
  for (const feed of feeds) {
    const source = `broker:${feed.id}`;
    const counts = {fetched: 0, nonNyc: 0, unconfirmedAddress: 0, duplicateOfStored: 0, duplicateOfBroker: 0, ingested: 0, offMarket: 0};
    try {
      const listings = await fetchBrokerListings(feed, http);
      counts.fetched = listings.length;
      const placed = [];
      for (const listing of listings) {
        if (!listing.street || (!listing.borough && !listing.cityHint)) { counts.nonNyc++; continue; }
        const stored = store.one('SELECT bbl, borough, zip_code, address, street_line, latitude, longitude FROM market_listings WHERE id = ?', `broker:${feed.id}:${listing.sourceListingId}:for_sale`);
        const place = stored?.bbl
          ? {bbl: stored.bbl, borough: stored.borough, zipCode: stored.zip_code, address: stored.address.split(',')[0], plutoAddress: stored.street_line, latitude: stored.latitude, longitude: stored.longitude}
          : await geocodeBrokerListing(listing, http);
        if (!place) { counts.unconfirmedAddress++; continue; }
        placed.push({listing, place});
      }
      const centroids = await plutoCentroids([...new Set(placed.filter(p => p.place.latitude == null).map(p => p.place.bbl))], http);
      const rows = [];
      for (const {listing, place} of placed) {
        if (claimed.has(place.bbl)) { counts.duplicateOfBroker++; continue; }
        const other = store.one(`SELECT id FROM market_listings WHERE bbl = ? AND listing_type = 'for_sale' AND COALESCE(source, 'homeharvest') != ? LIMIT 1`, place.bbl, source);
        if (other) { counts.duplicateOfStored++; continue; }
        const coords = place.latitude != null ? place : centroids.get(place.bbl);
        if (!coords) { counts.unconfirmedAddress++; continue; }
        claimed.set(place.bbl, feed.id);
        rows.push(brokerMarketRow(feed, listing, {...place, ...coords}));
      }
      store.ingestListings(rows, now);
      counts.ingested = rows.length;
      store.write(`UPDATE market_listings SET listing_type = 'for_sale' WHERE source = ? AND last_seen_at >= ?`, source, now);
      counts.offMarket = Number(store.write(`UPDATE market_listings SET listing_type = 'off_market', mls_status = 'off_market' WHERE source = ? AND last_seen_at < ? AND listing_type != 'off_market'`, source, now).changes);
    } catch (err) {
      report.errors[feed.id] = err.message;
    }
    report.feeds[feed.id] = counts;
  }
  report.pluto = await store.enrichNycListingsWithPluto({...(plutoFetcher ? {plutoFetcher} : {}), limit: 1000});
  report.coverage = store.query(`
    SELECT source, COUNT(*) AS active,
      SUM(CASE WHEN bbl IS NOT NULL THEN 1 ELSE 0 END) AS plutoMatched,
      SUM(CASE WHEN unused_uap_zfa >= 500 THEN 1 ELSE 0 END) AS unusedZfaOver500,
      SUM(CASE WHEN list_price IS NOT NULL THEN 1 ELSE 0 END) AS priced
    FROM market_listings WHERE source LIKE 'broker:%' AND listing_type = 'for_sale' GROUP BY source`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = new MarketStore(marketDbPath());
  try {
    console.log(JSON.stringify(await syncBrokerListings(store), null, 2));
  } finally {
    store.close();
  }
}
