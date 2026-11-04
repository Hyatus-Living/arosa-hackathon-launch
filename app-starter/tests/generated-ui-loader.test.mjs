import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeneratedUiLoader} from '../public/generated-ui-loader.js';

test('generated UI loader shares one in-flight load', async () => {
  let loads = 0;
  let release;
  const load = createGeneratedUiLoader({
    loadModule: () => {
      loads += 1;
      return new Promise(resolve => { release = resolve; });
    },
  });
  const first = load();
  const second = load();
  assert.equal(loads, 1);
  release({ready: true});
  assert.deepEqual(await first, {ready: true});
  assert.deepEqual(await second, {ready: true});
  assert.equal(loads, 1);
});

test('generated UI loader retries after a failed bundle import', async () => {
  let attempts = 0;
  const load = createGeneratedUiLoader({
    loadModule: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary import failure');
      return {ready: true};
    },
  });
  await assert.rejects(load(), /temporary import failure/);
  assert.deepEqual(await load(), {ready: true});
  assert.equal(attempts, 2);
});
