import {fileURLToPath} from 'node:url';
import {MarketStore, marketDbPath, dealStoreEnabled} from './market-store.mjs';
import {syncBrokerListings} from './broker-listings.mjs';
import {loopnetApiKey, loopnetClient, syncLoopNetListings} from './loopnet-listings.mjs';
import {syncNewsFeeds} from './news-feeds.mjs';

export async function runMarketRefresh({
  dbPath = marketDbPath(),
  locations = null,
  listingTypes = null,
  propertyTypes = undefined,
  limitPerType = null,
  updatedInPastHours = undefined,
  pastDays = null,
  enrichPluto = null,
  scheduled = false,
  homeHarvest = true,
  brokers = true,
  brokerHttp,
  loopnet = true,
  loopnetSearchClient,
  news = true,
  newsHttp,
  bridgeRunner,
  plutoFetcher,
  mihAreasFetcher,
  frontStreetLookup,
  env = process.env,
} = {}) {
  if (!dealStoreEnabled(env)) {
    return {skipped: true, reason: 'The deal store is disabled. Set ACRES_DEAL_STORE_ENABLED=true to allow syncing.'};
  }
  const store = new MarketStore(dbPath);
  try {
    const {syncConfig} = store.getAdminConfig();
    if (scheduled && !syncConfig.autoSyncEnabled) {
      return {
        skipped: true,
        reason: 'Automatic scheduled scraping is paused in admin configuration.',
        storeStatus: store.statusSummary(),
      };
    }
    const syncResult = homeHarvest ? await store.syncMarket({
      locations,
      listingTypes,
      propertyTypes,
      limitPerType,
      updatedInPastHours,
      pastDays,
      enrichPluto,
      ...(bridgeRunner ? {bridgeRunner} : {}),
      ...(plutoFetcher ? {plutoFetcher} : {}),
    }) : {};
    // Broker sites are read after HomeHarvest, so a broker listing that duplicates an MLS row on
    // the same lot defers to the MLS row.
    const brokerResult = brokers ? await syncBrokerListings(store, {...(brokerHttp ? {http: brokerHttp} : {}), ...(plutoFetcher ? {plutoFetcher} : {})}) : null;
    // LoopNet is read last, so a LoopNet listing that duplicates an MLS or broker row on the same
    // lot defers to that row. Without an API key in the environment or secrets file the feed is off.
    const loopnetKey = loopnet && !loopnetSearchClient ? loopnetApiKey(env) : null;
    const loopnetSearch = loopnetSearchClient || (loopnetKey ? loopnetClient({apiKey: loopnetKey, ...(env.LOOPNET_API_URL ? {baseUrl: env.LOOPNET_API_URL} : {})}) : null);
    const loopnetResult = !loopnet ? null
      : loopnetSearch ? await syncLoopNetListings(store, {client: loopnetSearch, ...(plutoFetcher ? {plutoFetcher} : {})})
      : {skipped: true, reason: 'LOOPNET_API_KEY is not configured.'};
    // Parcels matched by either sync are placed in or out of the mapped MIH areas, read their front
    // street where the district's FAR depends on it, and are revalued.
    const mih = enrichPluto !== false
      ? await store.assignMihAreas({...(plutoFetcher ? {plutoFetcher} : {}), ...(mihAreasFetcher ? {mihAreasFetcher} : {})})
      : null;
    const frontStreets = enrichPluto !== false ? await store.backfillFrontStreets(frontStreetLookup ? {lookup: frontStreetLookup} : {}) : null;
    const lotPolygons = enrichPluto !== false ? await store.backfillLotPolygons() : null;
    // Trade-press feeds name lots by address; their stories are kept beside the listings.
    const newsResult = news ? await syncNewsFeeds(store, newsHttp ? {http: newsHttp} : {}) : null;
    const status = store.statusSummary();
    return {...syncResult, ...(brokerResult ? {brokers: brokerResult} : {}), ...(loopnetResult ? {loopnet: loopnetResult} : {}), ...(mih ? {mih} : {}), ...(frontStreets ? {frontStreets} : {}), ...(lotPolygons ? {lotPolygons} : {}), ...(newsResult ? {news: newsResult} : {}), storeStatus: status};
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const locArgs = process.argv.filter(a => a.startsWith('--location=')).map(a => a.slice(11));
  const hoursArg = process.argv.find(a => a.startsWith('--updated-hours='));
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const noPluto = process.argv.includes('--no-pluto');
  const scheduled = process.argv.includes('--scheduled');
  const brokersOnly = process.argv.includes('--brokers-only');
  const loopnetOnly = process.argv.includes('--loopnet-only');

  const result = await runMarketRefresh({
    locations: locArgs.length ? locArgs : null,
    updatedInPastHours: hoursArg ? Number(hoursArg.split('=')[1]) : undefined,
    limitPerType: limitArg ? Number(limitArg.split('=')[1]) : null,
    enrichPluto: noPluto ? false : null,
    scheduled,
    homeHarvest: !brokersOnly && !loopnetOnly,
    brokers: !loopnetOnly && !process.argv.includes('--no-brokers'),
    loopnet: !brokersOnly && !process.argv.includes('--no-loopnet'),
    news: !brokersOnly && !loopnetOnly && !process.argv.includes('--no-news'),
  });
  console.log(JSON.stringify(result, null, 2));
}
