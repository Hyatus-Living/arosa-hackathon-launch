import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {listingParcelFixture, parcel} from './fixtures/listing-parcel-match.mjs';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';

test('Queens hyphenated house identifiers match the complete number regardless of candidate order', async t => {
  const exact = parcel('QN', '12-34 TEST AVENUE'), neighbor = parcel('QN', '12-36 TEST AVENUE', {bbl: '4000150036', dy: .00001, dx: 0, lot: 1000, far: 2.2});
  for (const rows of [[exact, neighbor], [neighbor, exact]]) {
    const f = listingParcelFixture(); t.after(() => f.close());
    assert.equal((await f.enrich(rows)).matched, 1);
    assert.equal(f.row().bbl, f.expected); assert.equal(f.row().pluto_address, '12-34 TEST AVENUE');
    assert.equal(f.row().unused_uap_zfa, 22400);
  }
});

test('a close parcel with a conflicting same-street house number stays unmatched', async t => {
  for (const [borough, number, address] of [['QN', '12-34', '12-36 TEST AVENUE'], ['QN', '12', '12-36 TEST AVENUE'], ['BK', '101', '103 TEST AVENUE'], ['BK', '104', '101-109 TEST AVENUE']]) {
    const f = listingParcelFixture({borough, number}); t.after(() => f.close());
    assert.equal((await f.enrich([parcel(borough, address, {dy: .00001, dx: 0})])).matched, 0);
    assert.equal(f.row().bbl, null); assert.equal(f.row().deal_verdict, 'unmatched_parcel');
    assert.equal(f.row().unused_uap_zfa, null);
  }
});

test('a complete street and house match takes priority over a closer alternate-street fallback', async t => {
  const f = listingParcelFixture({borough: 'BK', number: '101'}); t.after(() => f.close());
  const full = parcel('BK', '101 TEST AVENUE'), corner = parcel('BK', '101 OTHER AVENUE', {bbl: '3000150103', dy: .00001, dx: 0, lot: 1000, far: 2.2});
  await f.enrich([corner, full]);
  assert.equal(f.row().bbl, f.expected); assert.equal(f.row().pluto_address, '101 TEST AVENUE');
});

test('non-Queens address ranges, unnumbered lots and close alternate-street addresses retain their match paths', async t => {
  for (const [number, address] of [['103', '101-109 TEST AVENUE'], ['', '103 TEST AVENUE'], ['101', '103 TEST STREET']]) {
    const f = listingParcelFixture({borough: 'BK', number}); t.after(() => f.close());
    assert.equal((await f.enrich([parcel('BK', address, {dy: .00001, dx: 0})])).matched, 1);
    assert.equal(f.row().bbl, f.expected);
  }
});

test('authenticated cards, pins and details use the selected listing parcel and its valuation', async t => {
  const f = listingParcelFixture(); t.after(() => f.close());
  await f.enrich([parcel('QN', '12-36 TEST AVENUE', {bbl: '4000150036', dy: .00001, dx: 0, lot: 1000, far: 2.2}), parcel('QN', '12-34 TEST AVENUE')]);
  const prior = process.env.ACRES_DEAL_STORE_ENABLED; process.env.ACRES_DEAL_STORE_ENABLED = 'true';
  const store = new ChatStore(join(f.dir, 'chat.sqlite')), server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store, marketStoreFactory: () => new MarketStore(f.path)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = async path => {const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {headers: {authorization: 'Bearer test', 'x-acres-account': 'a'.repeat(24)}}); assert.equal(response.status, 200); return response.json();};
  try {
    const page = await get('/market-store/deals?borough=QN&includeSimilarComps=false'), pins = await get('/market-store/deals/pins?borough=QN'), detail = await get('/market-store/deals/' + page.deals[0].id);
    assert.equal(page.total, 1); assert.equal(page.deals[0].bbl, f.expected); assert.equal(page.deals[0].unusedUapZfa, 22400);
    assert.equal(detail.deal.bbl, f.expected); assert.equal(detail.deal.unusedUapZfa, 22400);
    assert.deepEqual(pins.pins.id, [page.deals[0].id]);
    assert.equal(detail.deal.uapPricePerBuildableZfa, page.deals[0].uapPricePerBuildableZfa);
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); if (prior === undefined) delete process.env.ACRES_DEAL_STORE_ENABLED; else process.env.ACRES_DEAL_STORE_ENABLED = prior;}
});
