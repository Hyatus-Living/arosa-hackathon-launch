import {fileURLToPath} from 'node:url';
import {readFileSync, existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {parseHTML} from 'linkedom';
import {boroughCode, brokerStreetLine, zipBorough} from './broker-listings.mjs';
import {MarketStore, marketDbPath, defaultGeosearchBbl} from './market-store.mjs';

// LoopNet sale inventory, read through the Hyatus LoopNet search API (serverless-monorepo
// apps/loopnet), which signs the requests with the stored LoopNet session. Only listing facts
// and the listing URL are kept: no descriptions, photos or agent contacts (CoStar's 2025 ruling
// against Crexi makes copying those a risk). Whole-lot development candidates only: condo and
// co-op units, portfolios and leases are skipped.
export const LOOPNET_API_URL = 'https://functions.hyatus.com/loopnet';
export const LOOPNET_SOURCE = 'loopnet';
export const LOOPNET_SOURCE_NAME = 'LoopNet';
const PAGE_SIZE = 40;
// Upstream returns at most 750 listings per search; a box at or above this count is split.
export const PARTITION_CAP = 700;
const MAX_DEPTH = 12;

// Search boxes per borough as [west, south, east, north]. They overlap at the borough edges and
// the listing's own ZIP (or city) names its borough, so a listing seen from two boxes is one row.
export const BOROUGH_BOXES = {
  MN: [-74.0479, 40.6829, -73.9067, 40.8820],
  BX: [-73.9339, 40.7855, -73.7654, 40.9176],
  BK: [-74.0421, 40.5707, -73.8334, 40.7394],
  QN: [-73.9626, 40.5417, -73.7001, 40.8122],
  SI: [-74.2557, 40.4959, -74.0522, 40.6490],
};

// LoopNet property types that are whole lots, with the deal store style each maps to.
const WHOLE_LOT_TYPES = {Multifamily: 'multi_family', Land: 'land', Industrial: 'industrial', Flex: 'industrial', GeneralRetail: 'retail', Office: 'office'};
// LoopNet's listing types: whole properties and land, condo units (ConsolidatedCondosForSale),
// portfolios, and auctions, which name a reserve rather than an asking price.
const LISTING_TYPE_SKIPS = {PropertyForSale: null, LandForSale: null, ConsolidatedCondosForSale: 'unit', CommercialPortfolioForSale: 'portfolio'};

export function searchCriteria(box, page = 1) {
  const [west, south, east, north] = box;
  return {
    pagingCriteria: {page, pageSize: PAGE_SIZE},
    geography: {id: 30699, t: 3, l: {lt: 40.70678, ln: -73.97794}, bb: {br: {lt: 40.495865, ln: -73.7001691}, tl: {lt: 40.917705, ln: -74.25571}}, pi: 'ChIJOwg_06VPwokRYv534QaPC8g'},
    mapCriteria: {countryCode: 'USA', boundingBox: {br: {lt: south, ln: east}, tl: {lt: north, ln: west}}},
    typeaheadDisplay: 'New York, NY - USA',
    filters: {saleFilters: {saleTypes: 3, includeNonDisclosedPrice: true}, listingType: 1, sort: 1, leaseFilters: {includeNonDisclosedRent: true}, auctionFilters: {}},
    expandSearch: false,
    isBounded: false,
  };
}

// The key is read from the environment or the research secrets file (LOOPNET_API_KEY) and never
// logged. Without a key the feed is off.
export function loopnetApiKey(env = process.env) {
  if (env.LOOPNET_API_KEY) return env.LOOPNET_API_KEY;
  const path = env.ACRES_SECRETS_JSON;
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')).LOOPNET_API_KEY || null;
}

// A 202 means the API is renewing its LoopNet session; it is retried once after Retry-After. Any
// other failure, including the 503 the API returns while the Mac that renews the session is
// offline, ends this pass: the caller keeps its stored rows and the next scheduled pass tries again.
export function loopnetClient({apiKey, baseUrl = LOOPNET_API_URL, fetchImpl = fetch} = {}) {
  return {
    async search(criteria) {
      for (let attempt = 0; ; attempt++) {
        const response = await fetchImpl(`${baseUrl}/loopnet/search`, {
          method: 'POST',
          headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
          body: JSON.stringify(criteria),
          signal: AbortSignal.timeout(45000),
        });
        if (response.status === 202 && attempt === 0) {
          const retryAfter = response.headers.get('retry-after');
          await delay((retryAfter === null ? 5 : Number(retryAfter)) * 1000);
          continue;
        }
        if (response.status === 503) throw new Error('LoopNet API HTTP 503: the session companion is offline (temporary outage)');
        if (!response.ok) throw new Error(`LoopNet API HTTP ${response.status}`);
        return response.json();
      }
    },
  };
}

const clean = text => String(text || '').replace(/\s+/g, ' ').trim();

// A search page: `pl` holds the placard cards as HTML, `sp` the map pins as
// "listingId|portfolioId|lat|lng|...~..." and `count` the matches in the box.
export function parseSearchPage(response) {
  const coordinates = new Map();
  for (const pin of String(response.sp || '').split('~')) {
    const [lid, plid, lat, lng] = pin.split('|');
    if (!lat || !lng) continue;
    for (const id of [lid, plid]) if (id && !coordinates.has(id)) coordinates.set(id, {latitude: Number(lat), longitude: Number(lng)});
  }
  const {document} = parseHTML(String(response.pl || ''));
  return [...document.querySelectorAll('article[data-lk]')].map(card => {
    const text = selector => clean(card.querySelector(selector)?.textContent);
    const attr = name => card.getAttribute(`data-automation-${name}`) || '';
    const city = attr('city');
    let address = text('.placard-address');
    if (address.startsWith(`${city}, ${attr('state')}`)) address = `${text('.building-name')}, ${address}`;
    const listingId = card.getAttribute('data-lk');
    return {
      listingId,
      url: card.querySelector('a.placard-link')?.getAttribute('href') || null,
      listingType: attr('listing-type'),
      propertyType: attr('property-type'),
      city,
      zipCode: attr('postal-code').slice(0, 5) || null,
      address,
      facts: [...card.querySelectorAll('.placard-data .data-row')].flatMap(row => row.textContent.split('·').map(clean).filter(Boolean)),
      ...(coordinates.get(listingId) || {latitude: null, longitude: null}),
    };
  });
}

const number = value => {
  const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function styleFor(propertyType, subtype) {
  if (/residential|mixed/i.test(subtype) && propertyType !== 'Multifamily' && propertyType !== 'Land') return 'mixed_use';
  return WHOLE_LOT_TYPES[propertyType];
}

// A card becomes a whole-lot listing or a skip reason. The first fact is LoopNet's subtype
// ("Storefront Retail/Residential", "Office Condos"); a price or size range means several units
// sold separately, and "N Properties" a portfolio.
export function loopnetListing(card) {
  const typeSkip = card.listingType in LISTING_TYPE_SKIPS ? LISTING_TYPE_SKIPS[card.listingType] : 'listingType';
  if (typeSkip) return {skip: typeSkip};
  if (card.facts.some(f => /\bProperties\b/i.test(f))) return {skip: 'portfolio'};
  if (!WHOLE_LOT_TYPES[card.propertyType]) return {skip: 'propertyType'};
  const subtype = card.facts[0] || '';
  const priceFact = card.facts.find(f => /^\$/.test(f)) || '';
  const sizeFact = card.facts.find(f => /^[\d,.]+( - [\d,.]+)? (SF|AC)$/.test(f)) || '';
  if (/\b(condo|co-?op)/i.test(subtype) || /-/.test(priceFact) || / - /.test(sizeFact)) return {skip: 'unit'};
  const borough = zipBorough(card.zipCode) || boroughCode(card.city);
  if (!borough) return {skip: 'nonNyc'};
  const street = brokerStreetLine(card.address.split(',')[0], borough);
  if (!street) return {skip: 'noAddress'};
  if (!Number.isFinite(card.latitude) || !Number.isFinite(card.longitude)) return {skip: 'noCoordinates'};
  const size = number(sizeFact);
  const sizeSqft = size && /AC$/.test(sizeFact) ? Math.round(size * 43560) : size;
  const yearBuilt = number(card.facts.find(f => /^Built in \d{4}$/.test(f)));
  return {
    listingId: card.listingId,
    url: card.url,
    street,
    borough,
    city: card.city,
    zipCode: card.zipCode,
    latitude: card.latitude,
    longitude: card.longitude,
    askingPrice: number(priceFact),
    buildingSqft: card.propertyType === 'Land' ? null : sizeSqft,
    lotSqft: card.propertyType === 'Land' ? sizeSqft : null,
    yearBuilt,
    style: styleFor(card.propertyType, subtype),
  };
}

export function loopnetMarketRow(listing) {
  return {
    propertyId: `${LOOPNET_SOURCE}:${listing.listingId}`,
    listingId: listing.listingId,
    listingType: 'for_sale',
    mlsStatus: 'active',
    source: LOOPNET_SOURCE,
    sourceName: LOOPNET_SOURCE_NAME,
    address: `${listing.street}, ${listing.city}, NY${listing.zipCode ? ` ${listing.zipCode}` : ''}`,
    streetLine: listing.street,
    streetNumber: listing.street.split(' ')[0],
    city: listing.city,
    borough: listing.borough,
    state: 'NY',
    zipCode: listing.zipCode,
    latitude: listing.latitude,
    longitude: listing.longitude,
    url: listing.url,
    style: listing.style,
    assetClass: listing.style === 'land' ? 'land_development' : 'commercial_investment',
    isDevelopmentCandidate: true,
    sqft: listing.buildingSqft,
    lotSqft: listing.lotSqft,
    yearBuilt: listing.yearBuilt,
    stories: null,
    listPrice: listing.askingPrice,
    pricePerSqft: listing.askingPrice && listing.buildingSqft ? Math.round(listing.askingPrice / listing.buildingSqft) : null,
    lastUpdateDate: null,
  };
}

// Every sale listing in a box: a box with PARTITION_CAP or more matches is split in four, a
// smaller one is paged. Cards are collected by listing ID across boxes and pages.
export async function collectBox(client, box, cards, report, depth = 0) {
  const first = await client.search(searchCriteria(box));
  report.searches++;
  const count = Number(first.count) || 0;
  if (count >= PARTITION_CAP) {
    if (depth >= MAX_DEPTH) throw new Error(`LoopNet search cap not resolved by splitting ${box.join(',')}`);
    const [west, south, east, north] = box;
    const midX = (west + east) / 2, midY = (south + north) / 2;
    for (const child of [[west, south, midX, midY], [midX, south, east, midY], [west, midY, midX, north], [midX, midY, east, north]]) {
      await collectBox(client, child, cards, report, depth + 1);
    }
    return;
  }
  for (const card of parseSearchPage(first)) cards.set(card.listingId, card);
  for (let page = 2; page <= Math.ceil(count / PAGE_SIZE); page++) {
    const result = await client.search(searchCriteria(box, page));
    report.searches++;
    for (const card of parseSearchPage(result)) cards.set(card.listingId, card);
  }
}

// LoopNet is read after HomeHarvest and the broker sites, so a lot already listed through the MLS
// (a live row) or a broker keeps that row: the LoopNet listing for it is skipped when its lot is
// known, and otherwise taken off the market once PLUTO matching names the lot.
export async function syncLoopNetListings(store, {client, boroughs = Object.keys(BOROUGH_BOXES), plutoFetcher, geosearchFetcher = defaultGeosearchBbl, now = Date.now()} = {}) {
  const report = {searches: 0, fetched: 0, skipped: {listingType: 0, portfolio: 0, propertyType: 0, unit: 0, nonNyc: 0, noAddress: 0, noCoordinates: 0}, duplicateOfStored: 0, ingested: 0, offMarket: 0};
  const cards = new Map();
  try {
    for (const borough of boroughs) await collectBox(client, BOROUGH_BOXES[borough], cards, report);
  } catch (err) {
    return {...report, error: err.message};
  }
  report.fetched = cards.size;
  const staleBefore = store.forSaleStaleCutoff();
  const otherOnLot = `SELECT 1 FROM market_listings o WHERE o.bbl = ? AND o.listing_type = 'for_sale' AND COALESCE(o.source, 'homeharvest') != '${LOOPNET_SOURCE}' AND (o.source IS NOT NULL OR o.last_seen_at >= ?)`;
  const rows = [];
  for (const card of cards.values()) {
    const listing = loopnetListing(card);
    if (listing.skip) { report.skipped[listing.skip]++; continue; }
    const stored = store.one('SELECT bbl FROM market_listings WHERE id = ?', `${LOOPNET_SOURCE}:${listing.listingId}:for_sale`);
    if (stored?.bbl && store.one(otherOnLot, stored.bbl, staleBefore)) { report.duplicateOfStored++; continue; }
    rows.push(loopnetMarketRow(listing));
  }
  store.ingestListings(rows, now);
  report.ingested = rows.length;
  store.write(`UPDATE market_listings SET listing_type = 'for_sale' WHERE source = ? AND last_seen_at >= ?`, LOOPNET_SOURCE, now);
  report.offMarket = Number(store.write(`UPDATE market_listings SET listing_type = 'off_market', mls_status = 'off_market' WHERE source = ? AND last_seen_at < ? AND listing_type != 'off_market'`, LOOPNET_SOURCE, now).changes);
  report.pluto = await store.enrichNycListingsWithPluto({...(plutoFetcher ? {plutoFetcher} : {}), geosearchFetcher, limit: Math.max(1000, rows.length)});
  report.duplicateOfStored += Number(store.write(`UPDATE market_listings SET listing_type = 'off_market', mls_status = 'off_market'
    WHERE source = ? AND listing_type = 'for_sale' AND bbl IS NOT NULL AND EXISTS (${otherOnLot.replace('o.bbl = ?', 'o.bbl = market_listings.bbl')})`, LOOPNET_SOURCE, staleBefore).changes);
  report.coverage = {...store.one(`
    SELECT COUNT(*) AS active,
      SUM(CASE WHEN bbl IS NOT NULL THEN 1 ELSE 0 END) AS plutoMatched,
      SUM(CASE WHEN unused_uap_zfa >= 500 THEN 1 ELSE 0 END) AS unusedZfaOver500,
      SUM(CASE WHEN list_price IS NOT NULL THEN 1 ELSE 0 END) AS priced
    FROM market_listings WHERE source = ? AND listing_type = 'for_sale'`, LOOPNET_SOURCE)};
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiKey = loopnetApiKey();
  if (!apiKey) throw new Error('LOOPNET_API_KEY is not configured.');
  const boroughArgs = process.argv.filter(a => a.startsWith('--borough=')).map(a => a.slice(10));
  const store = new MarketStore(marketDbPath());
  try {
    console.log(JSON.stringify(await syncLoopNetListings(store, {client: loopnetClient({apiKey}), ...(boroughArgs.length ? {boroughs: boroughArgs} : {})}), null, 2));
  } finally {
    store.close();
  }
}
