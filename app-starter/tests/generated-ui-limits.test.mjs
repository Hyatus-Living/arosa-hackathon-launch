import test from 'node:test';
import assert from 'node:assert/strict';
import {assertGeneratedUiLimits} from '../frontend/generated-ui-limits.mjs';

const content = () => ({html: ['<button>Explore</button>'], css: 'button{color:inherit}', initialHeight: 200, jsExpressions: []});

test('accepts the bounded generated interface contract', () => {
  assert.doesNotThrow(() => assertGeneratedUiLimits(content()));
});

test('rejects oversized arrays before examining their elements', () => {
  for (const [field, length] of [['html', 2], ['jsExpressions', 9]]) {
    const values = new Array(length);
    Object.defineProperty(values, 0, {get() { throw new Error('traversed oversized array'); }});
    assert.throws(() => assertGeneratedUiLimits({...content(), [field]: values}), /interface exceeded/);
  }
});

test('rejects oversized strings and invalid heights before rendering', () => {
  for (const update of [
    {html: ['x'.repeat(18001)]}, {css: 'x'.repeat(6001)},
    {jsFunctions: 'x'.repeat(10001)}, {jsExpressions: ['x'.repeat(4001)]},
    {jsExpressions: [null]}, {initialHeight: NaN}, {initialHeight: 901}, {initialHeight: 99},
  ]) assert.throws(() => assertGeneratedUiLimits({...content(), ...update}), /interface exceeded/);
});
