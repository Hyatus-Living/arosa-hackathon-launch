import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchTools} from './tools.mjs';
import {validateCitations} from './lanes.mjs';

const url = 'https://www.nyc.gov/citation-capture-fixture';
const source = (text, extra = {}) => ({url, title: 'Controlled document', text, ...extra});

async function publicTool(t, results) {
  t.mock.method(globalThis, 'fetch', async request => {
    const path = new URL(request).pathname;
    if (path.endsWith('/fixture-public/search')) return Response.json({tool_schemas: {CONTROLLED_PUBLIC_READ: {description: 'Read a public document', input_schema: {type: 'object', properties: {}}}}});
    if (path.endsWith('/fixture-exa/search')) return Response.json({tool_schemas: {}});
    if (path.includes('/tools/CONTROLLED_PUBLIC_READ')) return Response.json({tags: ['readOnlyHint'], no_auth: true});
    if (path.endsWith('/fixture-public/execute')) {
      assert.ok(results.length, 'Only the planned provider calls may run');
      return Response.json({data: {results: [results.shift()]}});
    }
    throw new Error('Unexpected request: ' + path);
  });
  const tools = createResearchTools({COMPOSIO_API_KEY: 'controlled-fixture-key-only'}, () => {}, null, {exa: 'fixture-exa', public: 'fixture-public'});
  await tools.execute('acres_discover_tools', {query: 'Read a public document'});
  return {tools, read: () => tools.execute('acres_execute_tool', {slug: 'CONTROLLED_PUBLIC_READ', arguments: {}})};
}

test('public tool search excerpts provide no citable ID; reading the document creates verified evidence', async t => {
  const {tools, read} = await publicTool(t, [
    {url, title: 'Search result', snippet: 'Preliminary courtyard guidance'},
    {url, description: 'Preliminary courtyard guidance'}, {url, highlights: ['Preliminary courtyard guidance']},
    source('Courtyard access remains available.'),
  ]);
  for (let index = 0; index < 3; index++) {
    const search = await read();
    assert.equal(search.data.results[0].sourceId, undefined);assert.deepEqual(search.sources, []);assert.equal(tools.sources.length, 0);
  }
  assert.throws(() => validateCitations('Preliminary courtyard guidance [1].', tools.sources), /invalid source/);
  const fetched = await read(), captured = tools.sources[0];
  assert.equal(fetched.data.results[0].sourceId, captured.id);assert.equal(captured.verified, true);assert.equal(captured.kind, 'research');
  assert.equal(captured.text, 'Courtyard access remains available.');assert.equal(tools.sources.length, 1);
  assert.doesNotThrow(() => validateCitations(`Courtyard access remains available [${captured.id}].`, tools.sources));
});

test('different public reads at the same URL keep complete immutable text and citation identities', async t => {
  const firstText = 'Existing courtyard rule. '.repeat(1200).slice(0, 24000), nextText = 'Updated courtyard access applies.';
  const {tools, read} = await publicTool(t, [source(firstText), source(nextText)]);
  const first = await read(), original = structuredClone(tools.sources[0]), second = await read();
  assert.notEqual(first.data.results[0].sourceId, second.data.results[0].sourceId);assert.equal(tools.sources.length, 2);
  assert.deepEqual(tools.sources[0], original);assert.equal(tools.sources[1].text, nextText);
  assert.doesNotThrow(() => validateCitations(`Updated courtyard access applies [${tools.sources[1].id}].`, tools.sources));
});

test('unknown and known source versions, changed text and publication dates do not borrow one anothers provenance', () => {
  const tools = createResearchTools({}), text = 'Versioned courtyard guidance.';
  const live = tools.record(source(text)), old = tools.record(source(text, {knowledge: {versionId: 'v1', observedAt: '2024-01-01'}}));
  const current = tools.record(source(text, {knowledge: {versionId: 'v2', observedAt: '2025-01-01'}}));
  assert.equal(new Set([live.id, old.id, current.id]).size, 3);
  assert.equal(tools.record(source(text, {knowledge: {versionId: 'v1', observedAt: '2024-01-01'}})).id, old.id);
  const changed = tools.record(source('Changed version text.', {knowledge: {versionId: 'v1', observedAt: '2024-01-01'}}));
  assert.notEqual(changed.id, old.id);assert.equal(old.text, text);
  const dated = tools.record(source(text, {publishedDate: '2026-01-01'}));assert.notEqual(dated.id, live.id);assert.equal(live.publishedDate, null);
  const observed = tools.record(source(text, {knowledge: {versionId: 'v1', observedAt: '2024-02-01'}}));assert.notEqual(observed.id, old.id);assert.equal(old.fetchedAt, '2024-01-01');
  const metadata = {versionId: 'isolated', observedAt: '2025-02-01'}, pdf = {page: 1, pageCount: 2};
  const isolated = tools.record(source(text, {knowledge: metadata, pdf}));
  metadata.versionId = 'later-annotation';pdf.page = 2;
  assert.equal(isolated.knowledge.versionId, 'isolated');assert.equal(isolated.pdf.page, 1);
});

test('a fetched document does not inherit the unverified state of an earlier assumption at its URL', () => {
  const tools = createResearchTools({}), assumption = tools.record(source('Assumed courtyard access.', {kind: 'assumption'}));
  const original = structuredClone(assumption), fetched = tools.record(source('Courtyard access remains available.'));
  assert.notEqual(fetched.id, assumption.id);assert.equal(fetched.verified, true);assert.deepEqual(assumption, original);
  assert.throws(() => validateCitations(`Assumed courtyard access [${assumption.id}].`, tools.sources), /unverified/);
  assert.doesNotThrow(() => validateCitations(`Courtyard access remains available [${fetched.id}].`, tools.sources));
});

test('later assumptions and explicitly unverified text cannot acquire an earlier verified citation', () => {
  const tools = createResearchTools({}), fetched = tools.record(source('Courtyard access remains available.')), original = structuredClone(fetched);
  const assumption = tools.record(source('Courtyard access remains available.', {kind: 'assumption'}));
  const unverified = tools.record(source('Courtyard access remains available.', {verified: false}));
  assert.notEqual(assumption.id, fetched.id);assert.notEqual(unverified.id, fetched.id);assert.equal(assumption.verified, false);assert.equal(unverified.verified, false);
  assert.deepEqual(fetched, original);assert.throws(() => validateCitations(`Courtyard access remains available [${unverified.id}].`, tools.sources), /unverified/);
});

test('market citations cannot promote discovery snippets and still reuse an actual verified document', () => {
  const tools = createResearchTools({});
  assert.equal(tools.record(source('Search excerpt only.', {kind: 'search', verified: true})), null);
  assert.equal(tools.record(source('Market reference.', {kind: 'market'})), null);
  const fetched = tools.record(source('Observed market evidence.'));
  assert.equal(tools.record(source('Market reference.', {kind: 'market'})).id, fetched.id);assert.equal(tools.sources.length, 1);
});

test('identical rereads and zoning-host aliases deduplicate while offsets and PDF pages stay separate', () => {
  const tools = createResearchTools({}), text = 'Stable source text.', canonical = 'https://zr.planning.nyc.gov/article-i';
  const first = tools.record(source(text, {url: canonical}));
  assert.equal(tools.record(source(text, {url: 'https://zoningresolution.planning.nyc.gov/article-i'})).id, first.id);
  const later = tools.record(source(text, {url: canonical, offset: 24000}));assert.notEqual(later.id, first.id);
  assert.equal(tools.record(source(text, {url: canonical, offset: 24000})).id, later.id);
  const page1 = tools.record(source(text, {url: url + '#page=1', pdf: {page: 1, pageCount: 2}}));
  const page2 = tools.record(source(text, {url: url + '#page=2', pdf: {page: 2, pageCount: 2}}));assert.notEqual(page1.id, page2.id);
  const changedPdf = tools.record(source(text, {url: url + '#page=1', pdf: {page: 1, pageCount: 3}}));assert.notEqual(changedPdf.id, page1.id);assert.equal(page1.pdf.pageCount, 2);
});

test('discovery does not consume citation capacity; identical reads remain reusable at the existing cap', () => {
  const tools = createResearchTools({});
  for (let index = 0; index < 50; index++) assert.equal(tools.record(source('Discovery ' + index, {url: url + '?search=' + index, kind: 'search'})), null);
  assert.equal(tools.sources.length, 0);
  for (let index = 0; index < 40; index++) assert.equal(tools.record(source('Read ' + index, {url: url + '?read=' + index})).id, index + 1);
  assert.equal(tools.record(source('Read 0', {url: url + '?read=0'})).id, 1);
  assert.equal(tools.record(source('Extra read', {url: url + '?read=40'})), null);assert.equal(tools.sources.length, 40);
});
