// Explicit operator configuration for this isolated test deployment.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {priceFixture} from './testing/comparable-price.mjs';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

test('a subject historical sale and alternate-source parcel listing are not nearby peer comparables', t => {
  const f = priceFixture(t), subject = f.subject();
  const sale = f.add('subject', {listingType: 'sold', soldPrice: 2400000});
  const relisted = f.add('same-parcel', {listingType: 'sold', soldPrice: 2500000});
  const peer = f.add('independent', {listingType: 'sold', soldPrice: 2100000});
  f.store.write('UPDATE market_listings SET bbl=? WHERE id=?', subject.bbl, relisted);
  assert.deepEqual(f.comps().map(c => c.id), [peer]);
  assert.deepEqual(f.store.getSimilarCompsForDeal(subject.bbl).map(c => c.id), [peer]);
  assert.equal(f.store.one('SELECT sold_price FROM market_listings WHERE id=?', sale).sold_price, 2400000, 'Subject history stays stored');
  assert.equal(f.store.one('SELECT bbl FROM market_listings WHERE id=?', relisted).bbl, subject.bbl);
});

test('subject identity exclusion happens before the 120-row candidate cap and preserves peer ranking and limits', t => {
  const f = priceFixture(t), subject = f.subject();
  const peers = ['peer-one', 'peer-two', 'peer-three'].map(name => f.add(name, {listingType: 'sold', soldPrice: 2100000, lastSeen: 1}));
  const expected = f.comps();
  for (let i = 0; i < 125; i++) {
    const id = f.add(`same-parcel-${i}`, {listingType: 'sold', soldPrice: 2500000, lastSeen: 2000 + i});
    f.store.write('UPDATE market_listings SET bbl=? WHERE id=?', subject.bbl, id);
  }
  assert.deepEqual(f.comps(), expected, 'Unrelated peers keep their prices, source dates, scores, reasons and order');
  assert.deepEqual(f.store.getSimilarCompsForDeal(subject, {limit: 2}), expected.slice(0, 2));
  assert.deepEqual(new Set(expected.map(c => c.id)), new Set(peers));
});

test('known provider identity excludes subject records without parcel identity and supports public camelCase subjects', t => {
  const f = priceFixture(t), subject = f.subject();
  const ownSale = f.add('subject', {listingType: 'sold', soldPrice: 2400000}), peer = f.add('peer');
  f.store.write('UPDATE market_listings SET bbl=NULL,property_id=? WHERE id=?', ' subject ', subject.id);
  f.store.write('UPDATE market_listings SET bbl=NULL,property_id=? WHERE id=?', ' subject ', ownSale);
  const snake = f.store.getSimilarCompsForDeal(f.subject());
  const camel = f.store.getSimilarCompsForDeal({id: subject.id, propertyId: 'subject', zipCode: subject.zip_code, borough: subject.borough, latitude: subject.latitude, longitude: subject.longitude, zoningDistrict: subject.zoning_district, residFar: subject.resid_far, maxUapZfa: subject.max_uap_zfa});
  assert.deepEqual(snake.map(c => c.id), [peer]);
  assert.deepEqual(camel.map(c => c.id), [peer]);
  assert.deepEqual(f.store.getSimilarCompsForDeal(subject.id).map(c => c.id), [peer]);
});

test('unknown parcel/provider identities never equate unrelated listings and addresses are not used as identity', t => {
  const f = priceFixture(t), a = f.add('unknown-a'), b = f.add('unknown-b'), c = f.add('same-address');
  f.store.write('UPDATE market_listings SET bbl=NULL,property_id=NULL WHERE id=?', a);
  f.store.write("UPDATE market_listings SET bbl='',property_id='' WHERE id=?", b);
  f.store.write('UPDATE market_listings SET address=? WHERE id=?', f.subject().address, c);
  for (const bbl of [null, '', '0', '0000000000', 'unmatched']) {
    f.store.write('UPDATE market_listings SET bbl=? WHERE id=?', bbl, a);
    const subject = {...f.subject(), bbl, property_id: null};
    const result = f.store.getSimilarCompsForDeal(subject);
    assert.deepEqual(new Set(result.map(comp => comp.id)), new Set([a, b, c]), String(bbl));
  }
  assert.deepEqual(f.store.getSimilarCompsForDeal('missing-record'), []);
});

test('authenticated deal detail and tool-facing search responses exclude subject identity without removing stored records', async t => {
  const cleanup = [], f = priceFixture({after: fn => cleanup.push(fn)}), subject = f.subject();
  const sale = f.add('subject', {listingType: 'sold', soldPrice: 2400000}), sameLot = f.add('same-parcel'), peer = f.add('independent');
  f.store.write('UPDATE market_listings SET bbl=? WHERE id=?', subject.bbl, sameLot);
  const chat = new ChatStore(join(f.dir, 'chat.sqlite'));
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'fixture'}, store: chat, maps: null, marketStoreFactory: () => new MarketStore(f.path)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));chat.close();cleanup.forEach(fn => fn());});
  const response = await fetch(`http://127.0.0.1:${server.address().port}/market-store/deals/${encodeURIComponent(subject.id)}`, {headers: {authorization: 'Bearer fixture', 'x-acres-account': 'a'.repeat(24), 'x-acres-email': 'alex@witharosa.ai'}});
  assert.equal(response.status, 200); const {deal} = await response.json();
  assert.deepEqual(deal.similarComps.map(c => c.id), [peer]);
  const search = f.store.searchDeals({listingId: subject.id});
  assert.deepEqual(search[0].similarComps, deal.similarComps);
  assert.ok(f.store.one('SELECT id FROM market_listings WHERE id=?', sale));
  assert.ok(f.store.one('SELECT id FROM market_listings WHERE id=?', sameLot));
});
