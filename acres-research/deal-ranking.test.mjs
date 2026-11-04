import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketStore} from './market-store.mjs';
import {headroomSqft} from '../app-starter/public/core-model.js';

// R7A 50 by 100 lots with 0 to 25,000 sq ft standing: the headroom a card prints is the unused floor area of the
// building that sets the value. Two identical lots tie, and two lots with no recorded lot area have no headroom FAR.
function fixture(t) {
  const store = new MarketStore(':memory:');
  t.after(() => store.close());
  const insert = store.db.prepare(`INSERT INTO market_listings
    (id, listing_type, address, pluto_address, bbl, borough, zip_code, list_price, pluto_lot_area, pluto_lot_front, pluto_lot_depth, pluto_lot_type,
     pluto_bldg_area, resid_far, aff_res_far, zoning_district, units_res, year_built, flood_zone, landmark_flag, front_street_feet, first_seen_at, last_seen_at)
    VALUES (?, 'for_sale', ?, ?, ?, 'BK', '11217', 2000000, ?, 50, 100, '5', ?, 4.0, 5.01, 'R7A', 0, 2020, 0, 0, 60, 1, 1)`);
  let lot = 1;
  for (const [id, area, standing] of [
    ['vacant', 5_000, 0], ['half', 5_000, 10_000], ['tie-a', 5_000, 15_000], ['tie-b', 5_000, 15_000],
    ['built-out', 5_000, 25_000], ['zero-area', 0, 0], ['missing-area', null, 0],
  ]) insert.run(id, `${lot} Example St`, `${lot} EXAMPLE STREET`, `3${String(lot++).padStart(9, '0')}`, area, standing);
  store.revalueDealsWithSettings();
  return store;
}
// The card reads the row as deals.js normalizes it.
const card = d => headroomSqft({unused_for_lead_zfa: d.unusedForLeadZfa, uap_unused_zfa: d.unusedUapZfa, unused_residential_zfa: d.unusedStandardZfa});
const ids = deals => deals.map(d => d.id);
const query = {sortBy: 'unused_far', minUnusedZfa: 0, includeSimilarComps: false};
const RANKED = ['vacant', 'half', 'tie-a', 'tie-b', 'built-out', 'missing-area', 'zero-area'];

test('FAR ranking reads the headroom the card prints over lot area, with stable ties and unknown denominators last', t => {
  const store = fixture(t);
  const deals = store.searchDealsPage(query).deals;
  assert.deepEqual(ids(deals), RANKED);
  const far = deals.slice(0, -2).map(d => card(d) / d.lotAreaSqft);
  assert.deepEqual(far, [...far].sort((a, b) => b - a));
  assert.ok(far[0] > far[1] && far[1] > far[2] && far[2] === far[3] && far[4] === 0);
  // Ranked by square feet, the lots without a recorded area rank by their headroom too.
  const sqft = store.searchDealsPage({...query, sortBy: 'unused_uap_zfa'}).deals.map(card);
  assert.deepEqual(sqft, [...sqft].sort((a, b) => b - a));
});

test('FAR-ranked pages retain filters, totals and stable ordering with risk filtering enabled or disabled', t => {
  const store = fixture(t);
  for (const excludeHighStabilizedRisk of [false, true]) {
    const q = {...query, zipCode: '11217', excludeHighStabilizedRisk};
    const pages = [0, 2, 4, 6].map(offset => store.searchDealsPage({...q, limit: 2, offset}));
    assert.ok(pages.every(p => p.total === 7));
    assert.deepEqual(pages.flatMap(p => ids(p.deals)), RANKED);
    assert.deepEqual(ids(store.searchDealsPage({...q, zipCode: '00000'}).deals), []);
  }
});
