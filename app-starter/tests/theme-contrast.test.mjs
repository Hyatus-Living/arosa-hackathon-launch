import {readFileSync, readdirSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';

const sheets = readdirSync(new URL('../public/', import.meta.url)).filter((name) => name.endsWith('.css')).sort();
const css = sheets
  .map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8'))
  .join('\n');
const tokens = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

// For chroma-0 OKLCH neutrals, relative luminance Y is L^3.
const contrast = (a, b) => {
  const [hi, lo] = [a ** 3, b ** 3].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (body, name) => {
  const match = body.match(new RegExp(`${name}:\\s*oklch\\(([\\d.]+)`));
  assert.ok(match, `missing token ${name}`);
  return Number(match[1]);
};

test('no literal white surfaces survive into the night theme', () => {
  assert.doesNotMatch(css, /background:\s*white\b/);
  assert.doesNotMatch(css, /rgba\(255,\s*255,\s*255/);
});

test('faint text keeps WCAG AA contrast on every surface in both themes', () => {
  const [light, dark] = tokens.split('html.dark');
  for (const [name, body, surfaces] of [
    ['light', light, ['--bg', '--surface', '--surface-2', '--surface-3']],
    ['dark', dark, ['--bg', '--surface', '--surface-2', '--surface-3']],
  ]) {
    for (const ink of ['--ink', '--ink-muted', '--ink-faint']) {
      for (const surface of surfaces) {
        const ratio = contrast(token(body, ink), token(body, surface));
        assert.ok(ratio >= 4.5, `${name} ${ink} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('shared polish tokens exist for corners, motion and depth', () => {
  for (const name of ['--r-sm', '--r-md', '--r-lg', '--r-pill', '--dur-1', '--dur-2', '--shadow-1', '--shadow-dialog']) {
    assert.match(css, new RegExp(`${name}:`), `missing ${name}`);
  }
  assert.doesNotMatch(css, /border-radius:\s*\d+px/, 'radii must use the token scale');
});
