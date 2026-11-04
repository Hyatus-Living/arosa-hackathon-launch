import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {MarketStore} from '../../acres-research/market-store.mjs';

// One listing as the store serves it, a vacant lot with a priced building.
function servedDeal() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-inspector-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, landmark_flag,
      flood_zone, units_res, year_built, first_seen_at, last_seen_at)
      VALUES ('a', 'for_sale', '2 Example Ave', '11216', 'BK', '3000010001', 800000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 0, 0, 0, 2020, 1, 1)`).run();
    return store.searchDeals({listingId: 'a'})[0];
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

test('the inspector\'s nearby land sales row is the adjusted nearby land value the tier uses', async t => {
  const previous = {document: globalThis.document, window: globalThis.window};
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {document, window});
  t.after(() => Object.assign(globalThis, previous));
  const {renderInspector} = await import('../public/listing-inspector.js');
  const {fmtCurrency} = await import('../public/deals.js');

  const deal = servedDeal();
  assert.equal('marketLand' in deal.flashcardValuation, false, 'the store serves one nearby land figure');
  const nearbyLand = {perBuildableSqft: 214, sales: 9, radiusMiles: 0.62, months: 24, asOf: '2026-09-30', value: 2_140_000, model: {comps: []}};
  const fv = {...deal.flashcardValuation, nearbyLand};
  const view = renderInspector({...deal, flashcardValuation: fv}, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  const row = [...view.querySelectorAll('.inspector-rows div')].find(r => r.querySelector('dt')?.textContent === 'Nearby land sales');
  assert.ok(row, 'the row is shown');
  const text = row.querySelector('dd').textContent;
  assert.ok(text.includes(`${fmtCurrency(nearbyLand.perBuildableSqft)} per buildable SF`), text);
  assert.ok(text.includes(fmtCurrency(nearbyLand.value)), text);
  assert.match(text, /9 development-site sales within 0\.6 miles/);

  const none = renderInspector({...deal, flashcardValuation: {...fv, nearbyLand: null}}, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  assert.equal([...none.querySelectorAll('.inspector-rows dt')].some(dt => dt.textContent === 'Nearby land sales'), false, 'no nearby sales, no row');
});
