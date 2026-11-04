import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketStore} from './market-store.mjs';
import {priceFixture} from './testing/comparable-price.mjs';

const pinsOf = store => store.searchDealsPage({minUnusedZfa: 0, sortBy: 'best_deal', pins: true});

test('a ranked search is reused until any connection writes to the store', t => {
  const f = priceFixture(t);
  const cheap = f.add('cheap', {listPrice: 900_000});
  f.add('dear', {listPrice: 9_000_000});
  const first = pinsOf(f.store);
  assert.equal(pinsOf(f.store), first);

  const other = new MarketStore(f.path);
  t.after(() => other.close());
  other.write('UPDATE market_listings SET list_price = ? WHERE id = ?', 450_000, cheap);

  const after = pinsOf(f.store);
  assert.notEqual(after, first);
  assert.equal(after.pins.listPrice[after.pins.id.indexOf(cheap)], 450_000);
  const page = f.store.searchDealsPage({minUnusedZfa: 0, sortBy: 'best_deal', includeSimilarComps: false});
  assert.equal(page.deals.find(d => d.id === cheap).listPrice, 450_000);
});

test('similar comps on a deal page follow a write to a comparable', t => {
  const f = priceFixture(t);
  const sale = f.add('sale', {listingType: 'sold', soldPrice: 1_100_000, soldDate: '2026-10-02'});
  const compOf = () => f.store.searchDealsPage({listingId: f.subjectId}).deals[0].similarComps.find(c => c.id === sale);
  assert.equal(compOf().price, 1_100_000);
  f.store.write('UPDATE market_listings SET sold_price = ? WHERE id = ?', 1_300_000, sale);
  assert.equal(compOf().price, 1_300_000);
});

test('the ranked list and the listing page value a listing from the same columns', t => {
  const f = priceFixture(t);
  // The listing's own lot size disagrees with city records, a data check that holds the tier at Fair.
  const flagged = f.add('flagged', {listPrice: 400_000});
  f.store.write('UPDATE market_listings SET lot_sqft = 9000, facil_far = 6.5, mnf_far = 2 WHERE id = ?', flagged);
  const ranked = f.store.searchDealsPage({minUnusedZfa: 0, sortBy: 'best_deal', includeSimilarComps: false}).deals.find(d => d.id === flagged);
  const listing = f.store.searchDealsPage({listingId: flagged, includeSimilarComps: false}).deals[0];
  assert.equal(ranked.dealVerdict, listing.dealVerdict);
  assert.deepEqual(ranked.flashcardValuation.gates.map(g => g.id), listing.flashcardValuation.gates.map(g => g.id));
  assert.ok(listing.flashcardValuation.gates.some(g => g.id === 'data_lot_size'));
  assert.equal(ranked.maxAnyUseZfa, listing.maxAnyUseZfa);
});
