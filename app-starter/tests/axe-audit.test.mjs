// Axe accessibility audit over the rendered fixture pages in headless Chromium (feature 69's last
// open item beside the 44px targets and contrast suites): home, the site page and its report carry
// no serious or critical WCAG 2 A/AA violations. Skips when no Chrome or Chromium binary exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chrome, startBrowser, startFixture, waitFor} from './headless-chrome.mjs';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PAGES = [
  {path: '/', ready: `document.querySelectorAll('.deal-card, .listings-filters').length > 0`, what: 'home feed'},
  {path: '/sites/fx-plan', ready: `document.querySelectorAll('.uw-scheme-list > .uw-scheme .uw-scheme-figures').length === 3`, what: 'three priced options'},
  {path: '/sites/fx-plan/report', ready: `document.querySelector('.report-body') !== null`, what: 'report body'},
];

test('home, the site page and its report have no serious or critical axe violations', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 180000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  await send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
  const problems = [];
  for (const page of PAGES) {
    await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + page.path)}`);
    await waitFor(() => evaluate(`!window.measured && (${page.ready})`), `${page.what} on ${page.path}`);
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const violations = await evaluate(`(async () => {
      ${AXE}
      const results = await axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']}});
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' '))}));
    })()`);
    for (const v of violations) problems.push(`${page.path}: [${v.impact}] ${v.id} ${v.help} at ${v.nodes.join(' | ')}`);
  }
  assert.deepEqual(problems, []);
});
