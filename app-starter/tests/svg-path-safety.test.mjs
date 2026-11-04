import test from 'node:test';
import assert from 'node:assert/strict';
import {runSvg} from './fixtures/svg-path-harness.mjs';

const rectangle = 'M10 10L110 10L110 110L10 110Z';
const svg = (...paths) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${paths.map(d => `<path d="${d}" fill="none" stroke="black" stroke-width="2"/>`).join('')}</svg>`;

async function parsed(paths, options) {
  const result = await runSvg(svg(...paths), options);
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.workerStopped, true, JSON.stringify(result));
  return result;
}

async function rejected(paths, options) {
  const result = await parsed(paths, options);
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.message, /invalid path data/i);
  assert.equal(result.value, undefined);
}

test('SVG paths preserve compact numbers, exponents, commas and legacy trailing decimals', async () => {
  const cases = [
    ['M1e1,10 H110 V1.1e2 H10 Z', 4],
    ['M0.6.5L10-20', 1],
    ['M10. 10.L110. 10. L110. 110. L10. 110.Z', 4],
    ['M10\t10\nL110\r10 L110 110 L10 110Z', 4],
  ];
  for (const [path, count] of cases) {
    const result = await parsed([path]);
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.value.segments.length, count, path);
    assert.ok(result.value.segments.every(({a,b}) => [...a,...b].every(Number.isFinite)));
  }
});

test('SVG relative moves, implicit lines, close repeats and new subpaths retain coordinates', async () => {
  const result = await parsed(['m10 10 100 0v100h-100zZl20 0M50 50l10 0']);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(result.value.segments.map(({a,b}) => [a,b]), [
    [[10,10],[110,10]], [[110,10],[110,110]], [[110,110],[10,110]],
    [[10,110],[10,10]], [[10,10],[30,10]], [[50,50],[60,50]],
  ]);
  const disabled = await parsed(['', 'none']);
  assert.equal(disabled.status, 'complete', JSON.stringify(disabled));
  assert.deepEqual(disabled.value.segments, []);
});

test('SVG numeric operands cannot implicitly repeat a parameterless close command', async () => {
  for (const path of [`${rectangle} 1 1`, 'm0 0l10 0z 5', 'M0 0L10 0ZZ-1-1']) {
    await rejected([path]);
  }
});

test('SVG missing operands and missing initial moves fail without returning partial walls', async () => {
  for (const path of ['M0 0L10', 'M0 0L10 0L', 'M0 0L10 0H', 'M0 0L10 V20', 'M0', 'L10 10L20 20', 'Z']) {
    await rejected([path]);
  }
});

test('SVG path junk and invalid comma placement cannot be silently repaired', async () => {
  for (const path of ['M0 0L10@10', 'M0 0L10,,10', ',M0 0L10 10', 'M,0 0L10 10', 'M0 0,L10 10', 'M0 0L10 10,', 'M0 0X10 10']) {
    await rejected([path]);
  }
});

test('SVG nonfinite operands and relative coordinate overflow fail before wall inference', async () => {
  for (const path of ['M0 0L1e309 10', 'M1e308 0l1e308 10']) await rejected([path]);
});

test('SVG unsupported curves and arcs discard their whole path while retaining healthy paths', async () => {
  for (const path of ['M0 0L10 0C20 0 20 10 30 10', 'M0 0L10 0A10 10 0 0 1 20 20']) {
    const result = await parsed([rectangle, path]);
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.value.segments.length, 4);
    assert.equal(result.value.skipped, 1);
  }
});

test('backend SVG conversion calibrates valid walls and rejects malformed drawings atomically', async () => {
  const valid = await parsed([rectangle], {action:'plan'});
  assert.equal(valid.status, 'complete', JSON.stringify(valid));
  assert.equal(valid.value.units, 'm');
  assert.equal(valid.value.scale.metresPerDrawingUnit, 0.1);
  assert.equal(valid.value.walls.length, 4);
  assert.ok(valid.value.walls.every(({start,end}) => [...start,...end].every(Number.isFinite)));
  await rejected([`${rectangle} 1 1`], {action:'plan'});
  await rejected([rectangle, 'M10 10L50 10L'], {action:'plan'});
});
