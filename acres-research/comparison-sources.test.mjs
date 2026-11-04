import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchTools} from './tools.mjs';
import {createMarketTools} from './market.mjs';
import {comparePrograms, createFeasibilityTools} from './feasibility.mjs';
import {computeProForma} from './proforma.mjs';
import {fieldsFromResult} from './project-state.mjs';
import {aggregate} from './research.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {collectSources} from '../app-starter/public/core-model.js';
import {property} from '../app-starter/tests/fixtures/project-state.mjs';

const shared = {
  program: {grossBuildingSqft: 10000, units: [{bedrooms: 0, count: 5, netSqft: 450}, {bedrooms: 1, count: 5, netSqft: 650}]},
  landPrice: 1000000, hardCostPerSqft: 450, softCostPerSqft: 100,
  financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 30},
  operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 12000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 5},
  capRate: 0.05,
};
const variants = [{label: 'Market', productType: 'rental'}, {label: 'Restricted', productType: 'rental', rentScale: 0.8}];
const citation = source => ({title: source.title, url: source.url, kind: source.kind, retrievedAt: source.fetchedAt});

async function computed() {
  const tools = createResearchTools({});
  for (const bedrooms of [0, 1]) tools.record({title: `Synthetic rent capture ${bedrooms}`, url: `https://example.com/rent-${bedrooms}`, kind: 'research', text: `Synthetic ${bedrooms}-bedroom source, not live market evidence.`});
  const marketTools = createMarketTools({record: tools.record});
  const market = await marketTools.handlers.acres_market_inputs({
    submarket: 'Synthetic fixture',
    rents: [0, 1].map(bedrooms => ({bedrooms, rentPerSqftPerMonth: 8 - bedrooms, source: 'Same publisher', url: `https://example.com/rent-${bedrooms}`, retrievedAt: '2026-10-12'})),
  });
  const feasibilityTools = createFeasibilityTools({getMarket: () => market});
  const comparison = await feasibilityTools.handlers.acres_compare_programs({shared, variants});
  return {tools, market, feasibilityTools, comparison};
}

test('program comparison retains both recorded captures sharing a publisher and date', async () => {
  const f = await computed();
  assert.deepEqual(f.market.rents.map(row => row.sourceId), [1, 2]);
  const proforma = computeProForma({...shared, productType: 'rental'}, f.market);
  assert.deepEqual(proforma.sources.map(source => source.sourceId), [1, 2]);
  assert.deepEqual(f.comparison.sources, proforma.sources);
  const field = fieldsFromResult({comparisons: [f.comparison], sources: f.tools.sources}, 'run').comparisons;
  assert.deepEqual(field.provenance.sources, f.tools.sources.map(citation));
});

test('comparison citation deduplication preserves legacy labels and repeated recorded IDs', async () => {
  const f = await computed();
  for (const [ids, expected] of [[[null, null], [null]], [[1, 1], [1]], [[1, null], [1, null]]]) {
    const market = {...f.market, rents: f.market.rents.map((row, index) => ({...row, sourceId: ids[index]}))};
    const out = comparePrograms({shared, variants}, market);
    assert.deepEqual(out.sources.map(source => source.sourceId), expected);
  }
});

test('saved comparison HTTP, Core evidence and reopened storage retain both source links', async t => {
  const f = await computed();
  const dir = mkdtempSync(join(tmpdir(), 'acres-comparison-evidence-')), path = join(dir, 'chat.sqlite');
  const store = new ChatStore(path), owner = 'a'.repeat(24), conversation = store.createConversation(owner);
  t.after(() => rmSync(dir, {recursive: true}));
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const expected = f.tools.sources.map(citation);
  try {
    const out = aggregate([{status: 'completed', tools: {property}, aux: {feasibilityTools: f.feasibilityTools}}], property.bbl);
    const run = store.createRun(owner, conversation.id, 'Save program comparison'); store.begin(run);
    store.finish(run, 'completed', {...out, answer: 'Computed comparison.', sources: f.tools.sources});
    const response = await fetch(`http://127.0.0.1:${server.address().port}/projects/${conversation.projectId}/state`, {headers: {authorization: 'Bearer test', 'x-acres-account': owner}});
    const project = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(project.fields.comparisons.provenance.sources, expected);
    assert.deepEqual(project.fields.comparisons.value, [f.comparison]);
    assert.deepEqual(collectSources(project), expected.map(source => ({...source, fields: ['comparisons']})));
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();}
  const reopened = new ChatStore(path);
  try {assert.deepEqual(reopened.projectView(owner, conversation.projectId).fields.comparisons.provenance.sources, expected);}
  finally {reopened.close();}
});
