import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {comparisonFixture} from './fixtures/comparison-ledger.mjs';
import {createFeasibilityTools, feasibilityDefinition} from './feasibility.mjs';
import {proFormaDefinition} from './proforma.mjs';
import {aggregate, research} from './research.mjs';
import {openSharedLedger} from './ledger.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {collectSources} from '../app-starter/public/core-model.js';

const ledgerShared = shared => {const {landPrice, ...rest} = shared; return {...rest, landPriceSource: 'ledger', taxSource: 'ledger'};};
const citation = source => ({title: source.title, url: source.url, kind: source.kind, retrievedAt: source.fetchedAt});

test('comparison rental taxes match the single pro forma while condo sellout stays untaxed', async t => {
  const f = comparisonFixture(); t.after(() => f.close());
  const out = await f.feasibility.handlers.acres_compare_programs({shared: {...f.shared, taxSource: 'ledger'}, variants: f.variants});
  assert.deepEqual(f.counts, {land: 0, taxes: 1});
  const reference = await f.proformas.handlers.acres_pro_forma({...f.shared, taxSource: 'ledger', productType: 'rental'});
  const rental = out.variants.find(variant => variant.label === 'Market rental');
  assert.equal(rental.noi, reference.operations.noi); assert.equal(rental.profit, reference.returns.profit);
  assert.equal(rental.realEstateTaxes.annualTaxes, 20000);
  const condo = out.variants.find(variant => variant.productType === 'condo');
  const condoReference = await f.proformas.handlers.acres_pro_forma({...f.shared, productType: 'condo'});
  assert.equal(condo.profit, condoReference.returns.profit); assert.equal(Object.hasOwn(condo, 'realEstateTaxes'), false);
});

test('ledger land is resolved once for all variants and supplies approval carry and cited basis', async t => {
  const f = comparisonFixture(); t.after(() => f.close());
  const out = await f.feasibility.handlers.acres_compare_programs({shared: ledgerShared(f.shared), variants: f.variants});
  assert.deepEqual(f.counts, {land: 1, taxes: 1}); assert.equal(f.queries.length, 4);
  assert.equal(out.variants.find(variant => variant.label === 'Affordable rental').entitlementCarryCost, 48000);
  for (const variant of out.variants) {assert.equal(variant.landPriceBasis.estimate, 1000000); assert.equal(variant.landPriceBasis.sampleSize, 3);}
  assert.deepEqual(out.sources.filter(source => source.sourceId != null).map(source => source.sourceId).sort((a, b) => a - b), [1, 2]);
  assert.equal(f.tools.sources.length, 2);
  assert.ok(f.tools.sources.every(source => source.kind === 'official_record'));
});

test('the comparison schema offers ledger selectors and unavailable facts never publish a comparison', async t => {
  const fields = feasibilityDefinition.inputSchema.properties.shared;
  for (const key of ['landPriceSource', 'taxSource']) assert.deepEqual(fields.properties[key], proFormaDefinition.inputSchema.properties[key]);
  assert.equal(fields.required.includes('landPrice'), false);
  const f = comparisonFixture(); t.after(() => f.close());
  const absent = createFeasibilityTools({getMarket: () => f.market});
  await assert.rejects(absent.handlers.acres_compare_programs({shared: ledgerShared(f.shared), variants: f.variants}), /development ledger is not available/);
  f.store.db.exec("DELETE FROM land_sales WHERE doc_id='synthetic-0'");
  await assert.rejects(f.feasibility.handlers.acres_compare_programs({shared: ledgerShared(f.shared), variants: f.variants}), /fewer than three/);
  f.store.db.exec('DELETE FROM assessments');
  await assert.rejects(f.feasibility.handlers.acres_compare_programs({shared: {...f.shared, taxSource: 'ledger'}, variants: f.variants}), /no DOF assessment/);
  await assert.rejects(f.feasibility.handlers.acres_compare_programs({shared: {...f.shared, taxSource: 'ledger'}, variants: [f.variants[2], {...f.variants[2], label: 'Condo 2'}]}), /taxSource requires.*rental/);
  assert.deepEqual(f.feasibility.comparisons, []); assert.deepEqual(absent.comparisons, []);
});

test('saved comparison HTTP, reopened storage and Core retain ledger calculations and both citations', async t => {
  const f = comparisonFixture(); t.after(() => f.close());
  await f.feasibility.handlers.acres_compare_programs({shared: ledgerShared(f.shared), variants: f.variants});
  const path = join(f.dir, 'chat.sqlite'), store = new ChatStore(path), owner = 'a'.repeat(24), conversation = store.createConversation(owner);
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const run = store.createRun(owner, conversation.id, 'Compare using the recorded ledger basis'); store.begin(run);
    const out = aggregate([{status: 'completed', tools: {property: f.property}, aux: {feasibilityTools: f.feasibility}}], f.property.bbl);
    store.finish(run, 'completed', {...out, answer: 'Synthetic ledger comparison.', sources: f.tools.sources});
    const response = await fetch(`http://127.0.0.1:${server.address().port}/projects/${conversation.projectId}/state`, {headers: {authorization: 'Bearer test', 'x-acres-account': owner}});
    const project = await response.json(); assert.equal(response.status, 200);
    assert.deepEqual(project.fields.comparisons.value, f.feasibility.comparisons);
    assert.deepEqual(project.fields.comparisons.provenance.sources, f.tools.sources.map(citation));
    assert.equal(collectSources(project).length, 2);
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();}
  const reopened = new ChatStore(path);
  try {assert.deepEqual(reopened.projectView(owner, conversation.projectId).fields.comparisons.value, f.feasibility.comparisons);}
  finally {reopened.close();}
});

for (const mode of ['lead', 'lanes']) test(`${mode} research wires the selected subject ledger into comparisons`, async t => {
  const f = comparisonFixture(), priorPath = process.env.ACRES_LEDGER_DB;
  process.env.ACRES_LEDGER_DB = f.path;
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-16T06:00:00Z').getTime()});
  if (mode === 'lanes') t.mock.method(globalThis, 'fetch', async url => {
    const request = new URL(url); assert.equal(request.hostname, 'data.cityofnewyork.us'); assert.equal(request.pathname, '/resource/64uk-42ks.json');
    return Response.json([f.property]);
  });
  t.after(() => {openSharedLedger().close(); if (priorPath === undefined) delete process.env.ACRES_LEDGER_DB; else process.env.ACRES_LEDGER_DB = priorPath; f.close();});
  let computed, references = '';
  const agent = async ({label, execute}) => {
    if (label === 'research' || label === 'lane_comps') {
      if (mode === 'lanes') {await execute('acres_find_property', {bbl: f.property.bbl}); await execute('acres_set_subject', {bbl: f.property.bbl}); await execute('acres_market_inputs', f.market);}
      computed = await execute('acres_compare_programs', {shared: ledgerShared(f.shared), variants: f.variants});
      references = computed.sources.filter(source => source.sourceId != null).map(source => `[${source.sourceId}]`).join(' ');
      return `Compared programs using the recorded land and taxes ${references}.`;
    }
    return label === 'judge' ? `Land price estimate and real estate taxes ${references}.` : 'No additional findings.';
  };
  const out = await research({message: 'Compare rental, affordable rental and condo programs using recorded land sales and taxes', propertyBbl: f.property.bbl, priorState: {property: f.property, market: f.market}}, mode === 'lanes' ? {RESEARCH_MODE: 'lanes'} : {}, () => {}, () => {}, () => {}, agent);
  assert.equal(out.comparisons.length, 1); assert.ok(computed.variants);
  assert.equal(out.comparisons[0].variants.find(variant => variant.productType === 'rental').realEstateTaxes.assessedValue, 200000);
  assert.equal(out.sources.filter(source => source.kind === 'official_record').length, 2);
});
