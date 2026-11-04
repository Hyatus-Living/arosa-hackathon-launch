import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const site = new URL('../../site/', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, site), 'utf8');

test('each product window on the home page opens a demo page that exists', () => {
  const frames = [...read('public/index.html').matchAll(/data-embed="(\w+)"[^>]*data-src="\/demo\/(\w+)"/g)];
  assert.deepEqual(frames.map((m) => m[1]).sort(), ['building', 'explore', 'underwrite']);
  for (const [, name, page] of frames) {
    assert.equal(name, page);
    assert.ok(fs.existsSync(new URL(`public/demo/${page}.html`, site)), `${page}.html`);
  }
});

test('the totals strip reads only fields the public stats route returns', () => {
  const keys = [...read('public/site.js').matchAll(/\['(\w+)', '[^']+'\]/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['listingsScreened', 'lotsMatched', 'sourcesCited', 'researchRuns']);
  // The totals come from the chat store and the deal store (store.mjs publicCounts, market-store.mjs).
  const sources = ['store.mjs', 'market-store.mjs'].map((name) => fs.readFileSync(new URL(`../../acres-research/${name}`, import.meta.url), 'utf8')).join('\n');
  for (const key of keys) assert.ok(new RegExp(`\\b${key}\\b`).test(sources), key);
});

test('the browser calculation bundle loads without Node and reprices an example when costs change', async () => {
  const calc = await import('../../site/public/demo/calc.js');
  const {decide} = await import('../../site/public/demo/numbers.js');
  const example = JSON.parse(read('public/demo/sites/ex-fulton.json'));
  const cost = (hardCostPerSqft) => decide(calc, {...example.inputs, shared: {...example.inputs.shared, hardCostPerSqft}}, 0).proForma.development.totalDevelopmentCost;
  assert.ok(cost(380) < cost(450));
});
