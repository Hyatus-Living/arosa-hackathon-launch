// Renders the site page and the report from the plan page fixture in headless Chromium and measures
// them: the site page spans the column beside the rail, prose keeps a reading measure, and the three
// option cards either share one row or stack, never overflow, at every width, with the chat drawer
// open or closed, on screen and in print. Skips when no Chrome or Chromium binary is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chrome, startBrowser, startFixture, waitFor} from './headless-chrome.mjs';

// Everything measured in one pass, in page coordinates.
const MEASURE = `(() => {
  const box = (el) => el && el.getBoundingClientRect();
  const doc = document.scrollingElement;
  const scroller = document.querySelector('.core-page:not([hidden])') || doc;
  const cards = [...document.querySelectorAll('.uw-scheme-list > .uw-scheme')].filter((c) => c.offsetParent);
  const rows = new Set(cards.map((c) => Math.round(box(c).top)));
  const parts = ['.uw-header', '.uw-snapshot', '.uw-steps', '.uw-schemes'].map((s) => [s, box(document.querySelector('.core-parcel.uw ' + s))]).filter(([, b]) => b);
  const snapshot = document.querySelector('.uw-snapshot');
  return {
    viewport: innerWidth,
    pageOverflow: Math.max(doc.scrollWidth - doc.clientWidth, scroller.scrollWidth - scroller.clientWidth),
    rail: Math.round(box(document.querySelector('.sidebar'))?.right || 0),
    drawer: Math.round(box(document.querySelector('.chat-panel'))?.width || 0),
    parts: parts.map(([s, b]) => ({s, left: Math.round(b.left), right: Math.round(b.right)})),
    snapshotColumns: snapshot ? getComputedStyle(snapshot).gridTemplateColumns.split(' ').length : 0,
    // How far the widest paragraph runs past 72 characters of its own type.
    paragraphExcess: Math.max(0, ...[...document.querySelectorAll('.core-parcel.uw p')].filter((p) => p.offsetParent).map((p) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position: absolute; width: 72ch';
      p.append(probe);
      const excess = Math.round(box(p).width - box(probe).width);
      probe.remove();
      return excess;
    })),
    cards: cards.length,
    rows: rows.size,
    overflowing: cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
  };
})()`;

test('the site page spans its column and the option cards fit at every width, on the site page and the report', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 120000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  const open = async ({path, width, height = 900, drawer = false, print = false}) => {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 768});
    await send('Emulation.setEmulatedMedia', {media: print ? 'print' : ''});
    await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + path)}`);
    await waitFor(() => evaluate(`!window.measured && document.querySelectorAll('.uw-scheme-list > .uw-scheme .uw-scheme-figures').length === 3`), `three priced options on ${path} at ${width}`);
    if (drawer !== null) await evaluate(`document.body.classList.toggle('chat-dock-open', ${drawer}), 1`);
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    return evaluate(MEASURE);
  };
  const cases = [
    ...[390, 768, 860, 1024, 1120, 1280, 1440, 1920, 2560].map((width) => ({path: '/sites/fx-plan', width})),
    ...[390, 768, 1024, 1120, 1280, 1440, 1920, 2560].map((width) => ({path: '/sites/fx-plan', width, drawer: true})),
    ...[390, 768, 1024, 1440].map((width) => ({path: '/sites/fx-plan/report', width, drawer: null})),
    {path: '/sites/fx-plan/report', width: 720, drawer: null, print: true},
  ];
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  for (const c of cases) {
    const m = await open(c);
    const label = `${c.path} at ${c.width}${c.drawer ? ' with the drawer open' : ''}${c.print ? ' in print' : ''}`;
    check(m.pageOverflow === 0, `${label}: the page scrolls sideways`);
    check(m.cards === 3, `${label}: three option cards`);
    check(m.overflowing === 0, `${label}: an option card's content runs past its border`);
    check(m.rows === 1 || m.rows === 3, `${label}: the cards share a row or stack, never split (${m.rows} rows)`);
    if (c.width <= 768) check(m.rows === 3, `${label}: the cards stack on a narrow screen`);
    if (c.path === '/sites/fx-plan') check(m.paragraphExcess <= 1, `${label}: a paragraph runs ${m.paragraphExcess}px past a 72 character measure`);
    if (c.path === '/sites/fx-plan' && c.width === 1440 && !c.drawer) {
      for (const p of m.parts) {
        check(p.left - m.rail <= 40, `${label}: ${p.s} starts ${p.left - m.rail}px from the rail`);
        check(m.viewport - p.right <= 40, `${label}: ${p.s} ends ${m.viewport - p.right}px from the edge`);
      }
      check(m.parts.length === 4, `${label}: header, snapshot, steps and options all render`);
      check(m.snapshotColumns === 4, `${label}: the snapshot shows four figures in a row`);
      check(m.rows === 1, `${label}: the three options sit side by side`);
    }
  }
  assert.deepEqual(problems, []);
});
