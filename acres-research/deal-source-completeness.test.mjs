import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createResearchTools} from './tools.mjs';
import {createMarketTools} from './market.mjs';
import {priceFixture} from './testing/comparable-price.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {research} from './research.mjs';

const capture = text => ({title:'Returned listing evidence', url:'https://example.com/listings', kind:'deal_store', text, completeJson:true});
const pooledTools = () => createResearchTools({}, () => {}, null, null, {sources:[], retrievedParcels:new Map(), seenKnowledge:new Set(), calls:0});
function marketFixture(t) {
  const fixture = priceFixture(t), tools = pooledTools();
  for (let i = 0; i < 50; i++) fixture.add(`capture-${i}`, {listPrice:1_000_000 + i * 1000});
  const market = createMarketTools({marketStore:fixture.store, dealStoreAccess:{read:true, sync:false}, record:tools.record});
  const search = args => market.handlers.acres_search_deal_store({limit:50, minUnusedZfa:0, syncIfEmpty:false, ...args});
  return {...fixture, tools, market, search};
}

test('complete JSON preserves every character while ordinary source excerpts retain their limit', () => {
  const tools = createResearchTools({}), text = JSON.stringify({address:'東京 🏘️ '.repeat(5000), tail:'Final listing'});
  const source = tools.record(capture(text));
  assert.equal(source.text === text, true);
  assert.equal(JSON.parse(source.text).tail, 'Final listing');
  const excerpt = tools.record({title:'Page', url:'https://example.com/page', text:'x'.repeat(30000)});
  assert.equal(excerpt.text.length, 24000);
});

test('complete captures consume the existing aggregate source allowance and fail before partial append', () => {
  for (const [tools, capacity] of [[createResearchTools({}), 40], [pooledTools(), 80]]) {
    for (let i = 0; i < capacity - 2; i++) tools.record({title:'Page', url:`https://example.com/${i}`, text:'Page excerpt'});
    const input = capture(JSON.stringify({tail:'x'.repeat(24000)})), source = tools.record(input);
    assert.equal(tools.record(input), source, 'identical capture is reusable at capacity');
    assert.equal(tools.record({title:'Extra', url:'https://example.com/extra', text:'Extra excerpt'}), null);
    assert.throws(() => tools.record(capture('{"different":true}')), /budget/i);
    assert.equal(tools.sources.length, capacity - 1);
    assert.throws(() => tools.record(capture('{"invalid":')), /JSON/i);
    assert.throws(() => tools.record({...capture('{}'), url:'file:///private/data'}), /public URL/i);
    assert.throws(() => tools.record(capture('')), /nonempty text/i);
    assert.throws(() => tools.record(capture(JSON.stringify({large:'x'.repeat(capacity * 24000)}))), /budget/i);
    assert.equal(tools.sources.length, capacity - 1);
  }
});

test('changes beyond the old excerpt boundary produce separate immutable citations', () => {
  const tools = pooledTools(), first = JSON.stringify({padding:'x'.repeat(25000), finalPrice:1000000});
  const second = JSON.stringify({padding:'x'.repeat(25000), finalPrice:2000000});
  const original = tools.record(capture(first)), changed = tools.record(capture(second));
  assert.notEqual(original.id, changed.id);
  assert.notEqual(original.contentHash, changed.contentHash);
  assert.equal(original.text === first, true);
  assert.equal(JSON.parse(changed.text).finalPrice, 2000000);
});

test('native search captures all 50 returned listings and a single large price history', async t => {
  const f = marketFixture(t), result = await f.search();
  const source = f.tools.sources.find(row => row.id === result.sourceId), saved = JSON.parse(source.text);
  assert.equal(result.dealCount, 50);
  assert.equal(saved.returnedDeals, 50);
  assert.deepEqual(saved.deals.map(row => row.id), result.deals.map(row => row.id));
  assert.equal(JSON.stringify(saved.deals) === JSON.stringify(result.deals), true);
  const history = Array.from({length:1500}, (_, i) => ({date:`fixture-${i}`, price:3_000_000 + i}));
  f.store.write('UPDATE market_listings SET price_history_json=? WHERE id=?', JSON.stringify(history), f.subjectId);
  const single = await f.search({limit:1, minListPrice:3_000_000});
  assert.equal(single.deals[0].id, f.subjectId);
  const largeSource = f.tools.sources.find(row => row.id === single.sourceId);
  assert.equal(largeSource.text.length > 24000, true);
  assert.equal(JSON.stringify(JSON.parse(largeSource.text).deals[0].priceHistory) === JSON.stringify(history), true);
});

test('native search cannot publish uncaptured results when its source allowance is full', async t => {
  const f = marketFixture(t), original = await f.search({limit:1});
  while (f.tools.sources.length < 80) {
    const i = f.tools.sources.length;
    const source = f.tools.record({title:'Page', url:`https://example.com/fill/${i}`, text:'Page excerpt'});
    if (!source) break;
  }
  const before = f.tools.sources.length, searches = f.market.dealSearches;
  await assert.rejects(f.search(), /budget/i);
  assert.equal(f.tools.sources.length, before);
  assert.equal(f.market.deals, original);
  assert.deepEqual(f.market.dealSearches, searches);
});

test('saved-chat HTTP and reopened storage retain parseable evidence for every returned listing', async t => {
  const f = marketFixture(t), owner = 'a'.repeat(24), path = join(f.dir, 'chat.sqlite');
  const previous = process.env.ACRES_MARKET_DB; process.env.ACRES_MARKET_DB = f.path;
  t.after(() => {if (previous === undefined) delete process.env.ACRES_MARKET_DB; else process.env.ACRES_MARKET_DB = previous;});
  let returned;
  const result = await research({message:'Save all returned listing evidence', dealStore:{read:true, sync:false}}, {}, () => {}, () => {}, () => {}, async ({execute}) => {
    returned = await execute('acres_search_deal_store', {limit:50, minUnusedZfa:0, syncIfEmpty:false});
    return `Returned ${returned.dealCount} listings [${returned.sourceId}].`;
  });
  const store = new ChatStore(path), conversation = store.createConversation(owner);
  const run = store.createRun(owner, conversation.id, 'Save all returned listing evidence');
  store.begin(run);
  store.finish(run, 'completed', result);
  const server = createResearchServer({secrets:{RESEARCH_TOKEN:'test'}, store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/conversations/${conversation.id}`, {headers:{authorization:'Bearer test', 'x-acres-account':owner}});
    assert.equal(response.status, 200);
    const chat = await response.json(), text = chat.messages.at(-1).sources[0].text;
    assert.equal(text === result.sources[0].text, true);
    assert.equal(JSON.parse(text).deals.length, 50);
    assert.deepEqual(JSON.parse(text).deals.map(row => row.id), returned.deals.map(row => row.id));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  }
  const reopened = new ChatStore(path);
  try {
    const source = reopened.run(owner, run.id).result.sources[0];
    assert.equal(source.text === result.sources[0].text, true);
    assert.equal(JSON.parse(source.text).deals.length, 50);
  } finally {reopened.close();}
});
