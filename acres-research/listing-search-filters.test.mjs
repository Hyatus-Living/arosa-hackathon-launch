import test from 'node:test';
import assert from 'node:assert/strict';
import {tenantFixture} from './testing/tenant-screening.mjs';
import {listingAreaZips} from './listing-filter-schema.mjs';

const ids = page => page.deals.map(row => row.id).sort();

function places(t) {
  const f = tenantFixture(t), a = f.add('bushwick'), b = f.add('williamsburg'), c = f.add('chatham');
  f.store.write('UPDATE market_listings SET neighborhood=?,zoning_district=? WHERE id=?', 'Bushwick', 'R6A', a);
  f.store.write('UPDATE market_listings SET zip_code=?,neighborhood=?,zoning_district=? WHERE id=?', '11211', 'Williamsburg', 'C4-4D', b);
  f.store.write('UPDATE market_listings SET address=?,pluto_address=?,zoning_district=? WHERE id=?', '6 Chatham Sq', '6 CHATHAM SQUARE', 'M1-1', c);
  return {...f, a, b, c};
}

test('area and zoning text match literally: LIKE wildcards never widen a search', t => {
  const f = places(t);
  for (const area of ['%', '_ushwick', 'Bush%', '%wick', '6 Ch_tham', '\\']) assert.equal(f.page({area}).total, 0, area);
  for (const zoningPrefix of ['%', 'R%', '_6']) assert.equal(f.page({zoningPrefix}).total, 0, zoningPrefix);
  assert.deepEqual(ids(f.page({area: 'Bushwick'})), [f.a]);
  assert.deepEqual(ids(f.page({area: 'bush'})), [f.a]);
  assert.deepEqual(ids(f.page({area: '6 Chatham'})), [f.c]);
  assert.deepEqual(ids(f.page({zoningPrefix: 'R6'})), [f.a]);
  assert.deepEqual(ids(f.page({zoningPrefix: 'C4-4'})), [f.b]);
  assert.equal(f.store.searchDealsPage({area: '%', pins: true, minUnusedZfa: 0}).total, 0, 'pins match literally too');
});

test('a ZIP+4 searches its five-digit ZIP, alone or in a list', t => {
  const f = places(t);
  assert.deepEqual(ids(f.page({area: '11201-1234'})), [f.a, f.c].sort());
  assert.deepEqual(ids(f.page({area: '11201-1234, 11211'})), [f.a, f.b, f.c].sort());
  assert.deepEqual(ids(f.page({area: '11211-0001 and 11211'})), [f.b]);
  assert.deepEqual(listingAreaZips('11201-1234; 11211 or 11201'), ['11201', '11211']);
  assert.equal(listingAreaZips('Bedford and Stuyvesant'), null);
  assert.equal(listingAreaZips('6 Chatham Square'), null, 'a house number is not a ZIP');
});

test('ZIP codes mixed with a place name are refused by name, never searched as zero results', t => {
  const f = places(t);
  for (const [area, token] of [['11201, Williamsburg', 'Williamsburg'], ['Williamsburg 11211', 'Williamsburg'], ['11201, 1120', '1120'], ['11201 and 11211-12', '11211-12']]) {
    const message = new RegExp(`"${token}" is not a ZIP code`);
    assert.throws(() => listingAreaZips(area), message, area);
    assert.throws(() => f.page({area}), message, area);
  }
});

test('a mistyped ZIP with no valid ZIP beside it is refused by name, not searched as a place', t => {
  const f = places(t);
  for (const area of ['1120', '112011', '11201-123', '1120, 1121']) {
    const message = /is not a ZIP code/;
    assert.throws(() => listingAreaZips(area), message, area);
    assert.throws(() => f.page({area}), message, area);
  }
  assert.equal(listingAreaZips('37-10 Main Street'), null, 'a hyphenated house number with its street stays an address search');
  assert.equal(listingAreaZips('6 Chatham Square'), null);
});

test('the Unpriced tier keeps unpriced listings under the default minimum price; priced tiers keep their price bounds', t => {
  const f = tenantFixture(t);
  // A house hard cost of the account's own, so the fixture's tiers do not move with the published cost range.
  f.store.updateAdminConfig({dealSettings: {...f.store.getAdminConfig().dealSettings, hardCostPerGrossSqft: 380, rentalHardCostPerGrossSqft: 380, condoHardCostPerGrossSqft: 380}});
  const unpriced = f.add('unpriced'), cheap = f.add('cheap'), priced = f.add('priced');
  f.store.write('UPDATE market_listings SET list_price=NULL WHERE id=?', unpriced);
  f.store.write('UPDATE market_listings SET list_price=50000 WHERE id=?', cheap);
  assert.deepEqual(ids(f.page({minListPrice: 100000, dealVerdict: 'unpriced_opportunity'})), [unpriced]);
  assert.deepEqual(ids(f.page({minListPrice: 100000, dealVerdict: 'unpriced_opportunity,fair_deal'})), [unpriced, priced].sort());
  assert.deepEqual(ids(f.page({maxListPrice: 1000000, dealVerdict: 'unpriced_opportunity,fair_deal'})), [unpriced, cheap].sort());
  assert.deepEqual(ids(f.page({minListPrice: 100000, maxPricePerBuildableZfa: 500, dealVerdict: 'unpriced_opportunity'})), [unpriced]);
  assert.deepEqual(ids(f.page({minListPrice: 100000})), [priced], 'without the Unpriced tier a price bound still drops unpriced listings');
  assert.deepEqual(ids(f.page({minListPrice: 100000, dealVerdict: 'fair_deal'})), [priced]);
  f.store.write('UPDATE market_listings SET latitude=40.7,longitude=-73.95');
  const pins = f.store.searchDealsPage({minUnusedZfa: 0, minListPrice: 100000, dealVerdict: 'unpriced_opportunity', pins: true});
  assert.deepEqual(pins.pins.id, [unpriced], 'the map shows the same set');
});

test('every pin carries its card number: its place in the ranked list, across pages and inside a map area', t => {
  const f = tenantFixture(t), rows = Array.from({length: 26}, (_, i) => f.add(`rank-${i}`));
  rows.forEach((id, i) => f.store.write('UPDATE market_listings SET uap_price_per_buildable_zfa=?,latitude=?,longitude=? WHERE id=?', 100 + i, 40.6 + i * .01, -73.95, id));
  f.store.write('UPDATE market_listings SET latitude=NULL,longitude=NULL WHERE id=?', rows[2]);
  const query = {minUnusedZfa: 0, includeSimilarComps: false, sortBy: 'uap_price_per_buildable_zfa'};
  const cards = [0, 20].flatMap(offset => f.store.searchDealsPage({...query, limit: 20, offset}).deals.map(deal => deal.id));
  const city = f.store.searchDealsPage({...query, pins: true});
  assert.deepEqual(city.pins.id, cards.filter(id => id !== rows[2]));
  assert.deepEqual(city.pins.rank, city.pins.id.map(id => cards.indexOf(id) + 1), 'an unlocated card keeps its number; its pin is absent');
  assert.equal(city.pins.rank[city.pins.id.indexOf(rows[24])], 25, 'the 25th card is the second page\'s fifth');
  const bounds = {south: 40.645, west: -74, north: 40.755, east: -73.9};
  const area = f.store.searchDealsPage({...query, bounds, pins: true});
  const areaCards = f.store.searchDealsPage({...query, bounds, limit: 20}).deals.map(deal => deal.id);
  assert.deepEqual(area.pins.id, areaCards);
  assert.deepEqual(area.pins.rank, areaCards.map((_, i) => i + 1));
});
