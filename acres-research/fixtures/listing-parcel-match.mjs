import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from '../market-store.mjs';

const geography = {QN: {lat: 40.75, lon: -73.94, zip: '11101', city: 'Queens', bbl: '4000150034'}, BK: {lat: 40.68, lon: -73.99, zip: '11231', city: 'Brooklyn', bbl: '3000150101'}};
export function parcel(borough, address, {bbl = geography[borough].bbl, dy = .0004, dx = .0003, lot = 6000, far = 3.9} = {}) {
  const geo = geography[borough];
  return {bbl, borough, address, zipcode: geo.zip, zonedist1: 'R6', lotarea: String(lot), bldgarea: '1000', builtfar: String(1000 / lot), residfar: String(far), affresfar: String(far), commfar: '0', facilfar: String(far), unitsres: '1', unitstotal: '1', bldgclass: 'B1', latitude: String(geo.lat + dy), longitude: String(geo.lon + dx)};
}
export function listingParcelFixture({borough = 'QN', number = '12-34', street = 'Test Ave'} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-listing-parcel-')), path = join(dir, 'market.sqlite'), store = new MarketStore(path), geo = geography[borough];
  const streetLine = `${number ? number + ' ' : ''}${street}`;
  store.ingestListings([{propertyId: 'synthetic-listing', listingType: 'for_sale', address: `${streetLine}, ${geo.city}, NY ${geo.zip}`, streetLine, streetNumber: number, streetName: 'Test', city: geo.city, state: 'NY', zipCode: geo.zip, latitude: geo.lat, longitude: geo.lon, style: 'land', isDevelopmentCandidate: true, sqft: 1000, lotSqft: 4000, listPrice: 500000}]);
  return {dir, path, store, borough, expected: geo.bbl, enrich: rows => store.enrichNycListingsWithPluto({plutoFetcher: async () => rows}), row: () => store.one('SELECT id,bbl,pluto_address,pluto_lot_area,unused_uap_zfa,uap_price_per_buildable_zfa,deal_verdict FROM market_listings'), close() {store.close(); rmSync(dir, {recursive: true});}};
}
