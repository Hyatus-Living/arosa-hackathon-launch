// Renders home from the plan page fixture in headless Chromium at phone widths and on a wide touch
// screen, and measures the filter row, the sort row and the pager: every control is at least 44 by
// 44 px, the filter row scrolls sideways under an edge fade, the sort row fits inside the listings
// column, and nothing but the filter row scrolls sideways. Each phone width is measured twice: with the
// fixture's short count, and with a long one, a four digit count limited to the map area, as a shared
// search with a map area opens it.
// Skips when no Chrome or Chromium binary is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chrome, startBrowser, startFixture, waitFor} from './headless-chrome.mjs';
import {FILTER_SCHEMA_ID, defaultFilterValues} from '../public/listing-filter-schema.js';
import {createListingSearchLink} from '../public/listing-search-link.js';
import {SETTINGS} from './fixtures/deal-feed.mjs';

// A search over all five boroughs that follows the map, and a feed that answers it with a count in
// the thousands, as the live store does.
const NYC = {south: 40.45, west: -74.3, north: 40.95, east: -73.65};
const MAP_SEARCH = new URL(createListingSearchLink('https://example.com/', {schema: FILTER_SCHEMA_ID, revision: 1, values: defaultFilterValues(), baselineCosts: SETTINGS.dealSettings, map: {revision: 1, bounds: NYC, viewport: NYC}})).search;
const MANY = `(() => {
  const fetch = window.fetch;
  window.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input?.url ?? input).includes('/api/market-store/deals?')) return response;
    return new Response(JSON.stringify({...(await response.json()), total: 1284}), {status: response.status, headers: response.headers});
  };
})()`;

const MEASURE = `(() => {
  const row = document.querySelector('.listings-filters');
  const bar = document.querySelector('.listings-bar').getBoundingClientRect();
  const body = document.querySelector('.listings-body').getBoundingClientRect();
  const status = document.querySelector('.listings-status');
  const visible = (e) => e.getClientRects().length && !e.closest('[popover], dialog');
  const controls = [...document.querySelectorAll('.listings-filters, .listings-bar, .listings-pager')]
    .flatMap((group) => [...group.querySelectorAll('button, summary, select, input, a[href]')])
    .filter(visible)
    .map((e) => { const r = e.getBoundingClientRect(); return {name: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10}; });
  const overflowing = [document.scrollingElement, ...document.querySelectorAll('body *')]
    .filter((e) => e !== row && visible(e) && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowX)) && e.scrollWidth > e.clientWidth)
    .map((e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + [...e.classList].join('.')) + ' ' + e.scrollWidth + '/' + e.clientWidth);
  return {
    overflowing,
    barFits: bar.left >= body.left - 0.5 && bar.right <= body.right + 0.5,
    bar: Math.round(bar.width), body: Math.round(body.width),
    rowScrolls: getComputedStyle(row).overflowX === 'auto' && row.scrollWidth > row.clientWidth,
    rowFades: getComputedStyle(row).maskImage.includes('gradient'),
    status: status.textContent,
    sort: Math.round(document.querySelector('.listings-sort select').getBoundingClientRect().width),
    statusClipped: [status, ...status.children].some((e) => e.scrollWidth > e.clientWidth + 0.5),
    pager: Boolean(document.querySelector('.listings-pager:not([hidden])')),
    clear: controls.some((c) => c.name === 'Clear filters'),
    controls,
  };
})()`;

const small = (m) => m.controls.filter((c) => c.width < 44 || c.height < 44);

test('home on a phone gives every filter, sort and pager control a 44 px target and nothing but the filter row scrolls sideways', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 180000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  const load = async (width, height, search = '') => {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    await evaluate(`localStorage.setItem('acres-chat-dock-open', 'false'); window.measured = true; location.href = ${JSON.stringify(base + '/' + search)}`);
    await waitFor(() => evaluate(`!window.measured && document.querySelectorAll('.listing-card').length > 0`), `listings at ${width}`);
    await evaluate('new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 450))');
  };
  const check = (m, width, state) => {
    assert.ok(m.pager, `the fixture shows the pager under the cards at ${width} with ${state}`);
    assert.ok(m.controls.length >= 8, `measured ${m.controls.length} controls at ${width} with ${state}`);
    assert.deepEqual(small(m), [], `every control is at least 44 by 44 px at ${width} with ${state}`);
    assert.ok(m.rowScrolls, `the filter row scrolls sideways at ${width} with ${state}`);
    assert.ok(m.rowFades, `the filter row fades at its edges at ${width} with ${state}`);
    assert.ok(m.barFits, `the sort row (${m.bar} px) fits the listings column (${m.body} px) at ${width} with ${state}`);
    assert.deepEqual(m.overflowing, [], `nothing but the filter row scrolls sideways at ${width} with ${state}`);
    assert.ok(m.sort >= 80, `the sort (${m.sort} px) has room to name its order at ${width} with ${state}`);
  };
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/')}`);
  await waitFor(() => evaluate('!window.measured && document.readyState === "complete"'), 'the fixture');

  const widths = [320, 359, 360, 375, 390, 414];
  for (const width of widths) {
    await load(width, 844);
    const m = await evaluate(MEASURE);
    assert.equal(m.status, '10 listings', `the fixture count at ${width}`);
    check(m, width, 'the fixture count');
  }

  await send('Page.enable');
  const {identifier} = await send('Page.addScriptToEvaluateOnNewDocument', {source: MANY});
  for (const width of widths) {
    await load(width, 844, MAP_SEARCH);
    const m = await evaluate(MEASURE);
    assert.equal(m.status, '1,284 listings in the map area', `the long count at ${width}`);
    check(m, width, 'a long count in the map area');
    assert.ok(!m.statusClipped, `the long count and its map area read in full at ${width}`);
  }
  await send('Page.removeScriptToEvaluateOnNewDocument', {identifier});
  await load(390, 844);

  // An unapplied filter shows Clear filters in the row; it is a full target too.
  await evaluate(`(() => { const input = document.querySelector('.listings-filters .listings-field input'); input.value = '1'; input.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.listings-clear:not([hidden])'))`), 'Clear filters');
  const cleared = await evaluate(MEASURE);
  assert.ok(cleared.clear, 'Clear filters shows in the filter row');
  assert.deepEqual(small(cleared), [], 'Clear filters and the rest are at least 44 by 44 px');

  // A wide touch screen gets the same targets through the coarse pointer.
  await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await load(1024, 768);
  assert.ok(await evaluate(`matchMedia('(pointer: coarse)').matches`), 'the emulated screen has a coarse pointer');
  const wide = await evaluate(MEASURE);
  assert.ok(wide.controls.length >= 8, `measured ${wide.controls.length} controls on a wide touch screen`);
  assert.deepEqual(small(wide), [], 'every control is at least 44 by 44 px on a wide touch screen');
  assert.deepEqual(wide.overflowing, [], 'nothing but the filter row scrolls sideways on a wide touch screen');
});
