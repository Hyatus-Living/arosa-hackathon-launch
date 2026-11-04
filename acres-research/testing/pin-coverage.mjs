import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from '../market-store.mjs';

export function pinCoverageFixture(t, count = 3205) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-pin-coverage-')), path = join(dir, 'market.sqlite'), store = new MarketStore(path);
  t.after(() => {store.close();rmSync(dir, {recursive: true});});
  const rows = Array.from({length: count}, (_, i) => ({
    id: `pin${String(i).padStart(5, '0')}:for_sale`, propertyId: `pin${String(i).padStart(5, '0')}`, listingType: 'for_sale',
    address: `${100 + i} Coverage Street`, city: (i + 1) % 8 ? 'Brooklyn' : 'Queens', state: 'NY', zipCode: (i + 1) % 8 ? '11201' : '11385',
    borough: (i + 1) % 8 ? 'BK' : 'QN', style: (i + 1) % 2 ? 'multi_family' : 'land', landmark: (i + 1) % 29 === 0, highRisk: (i + 1) % 41 === 0,
    latitude: 40.7 + (i % 40) * .0001, longitude: (i + 1) % 8 ? -73.99 : -73.8,
    listPrice: 2000000 + i * 100, assetClass: 'multifamily_small', isDevelopmentCandidate: true,
  }));
  store.ingestListings(rows);
  store.write(`UPDATE market_listings SET bbl=CAST(3009700000+rowid AS TEXT),borough=CASE WHEN rowid%8=0 THEN 'QN' ELSE 'BK' END,
    style=CASE WHEN rowid%2=0 THEN 'land' ELSE 'multi_family' END, landmark_flag=CASE WHEN rowid%29=0 THEN 1 ELSE 0 END,
    units_res=CASE WHEN rowid%41=0 THEN 10 ELSE 3 END,units_total=CASE WHEN rowid%41=0 THEN 10 ELSE 3 END,
    year_built=CASE WHEN rowid%41=0 THEN 1930 ELSE 1990 END,bldg_class='C1',zoning_district='R7A',
    pluto_lot_area=2500,pluto_bldg_area=2000,resid_far=4,max_uap_zfa=10000,max_standard_zfa=10000,
    unused_uap_zfa=8000,uap_price_per_buildable_zfa=list_price/10000.0,comm_far=0`);
  const invalidIds = new Set(rows.slice(-4, -1).map(row => row.id));
  const invalid = [null, 181, 0];
  rows.slice(-4, -1).forEach((row, i) => {
    row.latitude = i === 2 ? 0 : 40.7;row.longitude = invalid[i];
    store.write('UPDATE market_listings SET latitude=?,longitude=? WHERE id=?', row.latitude, row.longitude, row.id);
  });
  const far = rows.at(-1);
  far.latitude = 40.5;far.longitude = -74.24;far.listPrice = 9000000;
  store.write('UPDATE market_listings SET latitude=?,longitude=?,list_price=?,uap_price_per_buildable_zfa=900 WHERE id=?', far.latitude, far.longitude, far.listPrice, far.id);
  return {store, path, dir, rows, invalidIds, far};
}
