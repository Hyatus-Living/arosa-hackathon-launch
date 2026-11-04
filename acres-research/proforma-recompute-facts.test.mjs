import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {comparisonFixture} from './fixtures/comparison-ledger.mjs';
import {createMarketTools} from './market.mjs';
import {createProFormaTools} from './proforma.mjs';
import {fieldsFromResult} from './project-state.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {createResearchTools} from './tools.mjs';
import {collectSources} from '../app-starter/public/core-model.js';

const owner = 'a'.repeat(24), oldUrl = 'https://example.com/old-rents';
const citation = source => ({title: source.title, url: source.url, kind: source.kind, retrievedAt: source.fetchedAt});

async function saved(t, {publish = false} = {}) {
  const f = comparisonFixture(), store = new ChatStore(join(f.dir, 'chat.sqlite'));
  t.after(() => {store.close(); f.close();});
  f.tools.record({title: 'Old captured rent fixture', url: oldUrl, kind: 'research', text: 'Synthetic studio rent is eight dollars per square foot per month.'});
  const marketTools = createMarketTools({record: f.tools.record});
  const market = await marketTools.handlers.acres_market_inputs({...f.market, rents: [{...f.market.rents[0], url: oldUrl}]});
  const proformas = createProFormaTools({getMarket: () => market, ledger: f.ledger, record: f.tools.record});
  const {landPrice, ...rest} = f.shared;
  await proformas.handlers.acres_pro_forma({...rest, productType: 'rental', landPriceSource: 'ledger', taxSource: 'ledger'});
  const model = proformas.proFormas[0], conversation = store.createConversation(owner);
  const program = {productType: 'rental', byBedrooms: [{bedrooms: 0, units: 10, unitSqft: 450}]};
  const result = {property: f.property, market, program, proFormas: [model], sources: f.tools.sources};
  if (publish) {const run = store.createRun(owner, conversation.id, 'Publish recorded underwriting'); store.begin(run); store.finish(run, 'completed', {...result, answer: 'Synthetic recorded underwriting.'});}
  else store.project.write(conversation.projectId, fieldsFromResult(result, 'seed'));
  return {...f, store, market, marketTools, conversation, model, view: () => store.projectView(owner, conversation.projectId)};
}

test('assumption edits retain captured taxes, land basis and sensitivity without new ledger reads', async t => {
  const f = await saved(t), before = f.view(), reads = {...f.counts};
  const after = f.store.updateProjectState(owner, f.conversation.projectId, {version: before.version, fields: {assumptions: {hardCostPerSqft: 500}}});
  const field = after.fields.proFormas, model = field.value[0];
  assert.equal(model.operations.realEstateTaxes, 20000); assert.equal(model.operations.noi, 270400);
  assert.equal(model.returns.profit, -2072000);
  assert.equal(model.sensitivity.rent.find(row => row.scenario === 'rent -10%').profit, -2892800);
  assert.deepEqual(model.inputs.landPriceBasis, {...f.model.inputs.landPriceBasis, sourceId: null});
  assert.deepEqual(model.inputs.realEstateTaxes, {...f.model.inputs.realEstateTaxes, sourceId: null});
  assert.deepEqual(field.provenance.sources, before.fields.proFormas.provenance.sources);
  assert.equal(field.stale, null); assert.equal(model.derived, true); assert.deepEqual(f.counts, reads);
});

test('explicit manual land prices, including zero, replace the ledger basis while retaining tax evidence', async t => {
  for (const landPrice of [0, 1000000]) {
    const f = await saved(t), before = f.view();
    const after = f.store.updateProjectState(owner, f.conversation.projectId, {version: before.version, fields: {assumptions: {landPrice}}});
    const field = after.fields.proFormas, model = field.value[0];
    assert.equal(model.inputs.landPrice, landPrice); assert.equal(Object.hasOwn(model.inputs, 'landPriceBasis'), false);
    assert.equal(model.operations.realEstateTaxes, 20000);
    assert.deepEqual(field.provenance.sources, before.fields.proFormas.provenance.sources.filter(source => !source.title.endsWith(', land price estimate')));
    if (landPrice === 0) assert.equal(model.returns.profit, -422000);
  }
});

test('a newly recorded market replaces old rent evidence and preserves the captured ledger sources', async t => {
  const f = await saved(t), before = f.view();
  const records = createResearchTools({});
  records.record({title: 'Unrelated new-run evidence', url: 'https://example.com/unrelated', kind: 'research', text: 'Unrelated synthetic capture.'});
  const fresh = records.record({title: 'Fresh captured rent fixture', url: 'https://example.com/fresh-rents', kind: 'research', text: 'Synthetic studio rent is ten dollars per square foot per month.'});
  assert.equal(fresh.id, f.model.inputs.landPriceBasis.sourceId, 'The new rent ID collides with the old land ID');
  const market = await createMarketTools({record: records.record}).handlers.acres_market_inputs({...f.market, rents: [{...f.market.rents[0], source: 'Fresh rent sample', rentPerSqftPerMonth: 10, url: fresh.url}]});
  const run = f.store.createRun(owner, f.conversation.id, 'Update recorded market'); f.store.begin(run);
  f.store.finish(run, 'completed', {answer: 'Synthetic updated rents.', market, sources: records.sources});
  const published = f.view();
  assert.equal(published.fields.proFormas.stale,'market');
  assert.equal(published.fields.proFormas.value[0].operations.noi,before.fields.proFormas.value[0].operations.noi);
  const after = f.store.updateProjectState(owner,f.conversation.projectId,{version:published.version,fields:{assumptions:{hardCostPerSqft:f.model.inputs.hardCostPerSqft}}}), field = after.fields.proFormas;
  assert.equal(field.value[0].operations.noi, 373000); assert.equal(field.value[0].operations.realEstateTaxes, 20000);
  assert.ok(field.value[0].sources.some(source => source.sourceId === fresh.id && source.source === 'Fresh rent sample'));
  assert.equal(field.value[0].inputs.landPriceBasis.sourceId, null);
  assert.equal(field.value[0].inputs.realEstateTaxes.sourceId, null);
  assert.deepEqual(field.provenance.sources, [citation(fresh), ...before.fields.proFormas.provenance.sources.filter(source => source.kind === 'official_record')]);
  assert.equal(collectSources(after).some(source => source.url === oldUrl), false);
  assert.deepEqual(f.counts, {land: 1, taxes: 1});
});

test('authenticated assumption PATCH and a new store connection retain the recalculated basis and Core evidence', async t => {
  const f = await saved(t), before = f.view(), server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store: f.store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/projects/${f.conversation.projectId}/state`, {method: 'PATCH', headers: {authorization: 'Bearer test', 'x-acres-account': owner, 'content-type': 'application/json'}, body: JSON.stringify({version: before.version, fields: {assumptions: {hardCostPerSqft: 500}}})});
    const project = await response.json(); assert.equal(response.status, 200);
    assert.equal(project.fields.proFormas.value[0].operations.realEstateTaxes, 20000);
    assert.deepEqual(collectSources(project).filter(source => source.kind === 'official_record').map(({fields, ...source}) => source), before.fields.proFormas.provenance.sources.filter(source => source.kind === 'official_record'));
    const independent = new ChatStore(join(f.dir, 'chat.sqlite'));
    try {assert.deepEqual(independent.projectView(owner, f.conversation.projectId).fields.proFormas, project.fields.proFormas);}
    finally {independent.close();}
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});

test('initial publication of a complete research result preserves its recorded underwriting facts', async t => {
  const f = await saved(t, {publish: true}), field = f.view().fields.proFormas;
  assert.equal(field.value[0].operations.noi, f.model.operations.noi);
  assert.equal(field.value[0].operations.realEstateTaxes, 20000);
  assert.deepEqual(field.value[0].inputs.landPriceBasis, f.model.inputs.landPriceBasis);
  assert.deepEqual(field.provenance.sources, f.tools.sources.map(citation));
});
