// Renders home from the plan page fixture in headless Chromium with the chat drawer open and closed,
// and measures the list and map: side by side the map keeps at least 440px and its tier legend one
// line; a page too narrow for both shows the List and Map switch instead; nothing scrolls sideways.
// Skips when no Chrome or Chromium binary is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chrome, startBrowser, startFixture, waitFor} from './headless-chrome.mjs';

const MEASURE = `(() => {
  const shown = (s) => { const e = document.querySelector(s); return e && e.getClientRects().length ? e.getBoundingClientRect() : null; };
  const doc = document.scrollingElement;
  const legend = [...document.querySelectorAll('.listings-legend li')];
  const cards = [...document.querySelectorAll('.listing-card')].filter((c) => c.offsetParent);
  return {
    pageOverflow: Math.max(doc.scrollWidth - doc.clientWidth, ...[...document.querySelectorAll('#home-listings, .listings-split')].map((e) => e.scrollWidth - e.clientWidth)),
    rail: Math.round(shown('.sidebar')?.width || 0),
    drawer: Math.round(shown('.chat-panel')?.width || 0),
    results: Math.round(shown('.listings-results')?.width || 0),
    map: Math.round(shown('.listings-map-pane')?.width || 0),
    views: Boolean(shown('.listings-views')),
    legendLines: new Set(legend.filter((li) => li.getClientRects().length).map((li) => Math.round(li.getBoundingClientRect().top))).size,
    cardsOverflowing: cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
  };
})()`;

test('home keeps a usable map beside the list, or switches between them, with the chat drawer open or closed', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 120000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  const settle = () => evaluate('new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 450))');
  const open = async (width, drawer) => {
    await send('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: false});
    await evaluate(`localStorage.setItem('acres-chat-dock-open', ${JSON.stringify(JSON.stringify(drawer))}); window.measured = true; location.href = ${JSON.stringify(base + '/')}`);
    await waitFor(() => evaluate(`!window.measured && document.querySelectorAll('.listing-card').length > 0 && document.querySelectorAll('.listings-legend li').length > 0`), `listings at ${width}`);
    await settle();
    return evaluate(MEASURE);
  };
  // The drawer's open state is the reader's saved choice, so the page must be on the fixture's origin first.
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/')}`);
  await waitFor(() => evaluate('!window.measured && document.readyState === "complete"'), 'the fixture');
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const cases = [[1024, false], [1100, false], [1440, false], [1100, true], [1200, true], [1279, true], [1280, true], [1440, true], [1599, true], [1600, true], [1920, true]];
  for (const [width, drawer] of cases) {
    const m = await open(width, drawer);
    const label = `home at ${width}${drawer ? ' with the drawer open' : ''}`;
    check(m.pageOverflow <= 0, `${label}: the page scrolls sideways by ${m.pageOverflow}px`);
    check(m.cardsOverflowing === 0, `${label}: a card's content runs past its border`);
    check(Boolean(m.drawer) === drawer, `${label}: the drawer is ${m.drawer ? 'open' : 'closed'}`);
    const split = m.results > 0 && m.map > 0;
    if (split) {
      check(!m.views, `${label}: the List and Map switch shows beside both`);
      check(m.map >= 440, `${label}: the map is ${m.map}px wide beside the list`);
      check(m.legendLines === 1, `${label}: the legend runs to ${m.legendLines} lines`);
    } else {
      check(m.views, `${label}: list or map alone without the List and Map switch`);
    }
    if (drawer && width >= 1600) check(m.rail === 236, `${label}: the menu folds though both fit beside it`);
    if (drawer && width >= 1280) check(split, `${label}: the list and map share the page (list ${m.results}px, map ${m.map}px)`);
    if (drawer && width >= 1100 && width < 1280) check(!split && m.views, `${label}: the List and Map switch replaces the cramped split`);
  }
  // Closing the chat brings the menu back at its full width.
  await open(1440, true);
  await evaluate(`document.querySelector('.core-chat-close').click(), 1`);
  await settle();
  const closed = await evaluate(MEASURE);
  check(closed.drawer === 0 && closed.rail === 236, `home at 1440 after closing the chat: the menu is ${closed.rail}px wide`);
  assert.deepEqual(problems, []);
});
