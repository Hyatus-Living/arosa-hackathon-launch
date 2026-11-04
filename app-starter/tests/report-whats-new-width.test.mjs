// Renders the report and What's new from the plan page fixture in headless Chromium and measures
// them: each page's column spans from the rail to the window edge and centres on a very wide screen,
// its prose and lists keep a 70 character measure, everything in a report chapter ends on one edge
// no wider than the chapter column, the massing drawing sits beside its floor plates, and nothing
// scrolls sideways on a phone. The report is measured as the fixture serves it and again rendered
// with a modeled envelope and floor plan drawings. Skips when no Chrome or Chromium binary is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chrome, startBrowser, startFixture, waitFor} from './headless-chrome.mjs';

const REPORT = {
  path: '/sites/fx-plan/report', ready: '.report-main .report-chapter', column: '.report',
  parts: ['.report-bar', '.report-cover', '.report-terms', '.report-body'],
  prose: '.report p:not(table p, .report-cards p, .uw-scheme-list p, .report-source-line, .report-meta), .report-prose li, .report-list li',
};
// The same site's report with eight modeled storeys on a 50 by 100 ft lot and a drawn floor plan,
// rendered by the report view itself in place of the served one.
const MODELED = `(async () => {
  const {reportModel, renderReport} = await import('/report-view.js');
  const get = async (path) => (await fetch('/api' + path)).json();
  const [project, schemes] = await Promise.all([get('/projects/fx-plan/state'), get('/projects/fx-plan/schemes')]);
  const plate = [[0, 0], [50, 0], [50, 100], [0, 100]];
  project.fields.envelope.value.storeys = Array.from({length: 8}, (_, i) => ({label: 'L' + (i + 1), footprint: plate, floorElevationFeet: i * 10.5, heightFeet: 10.5, areaSqft: 5000}));
  const architecture = {current: {plan: {name: 'Typical floor', levels: [{}], rooms: [{}]}, revision: 3, artifacts: [{id: 'a-svg', kind: 'svg'}], jobs: [{status: 'succeeded', createdAt: 1, artifacts: [{id: 'a-preview', kind: 'preview'}]}]}};
  document.querySelector('.report').replaceWith(renderReport(reportModel({project: {...project, id: 'fx-plan'}, architecture, schemes})));
})()`;
const PAGES = [
  REPORT,
  {...REPORT, label: 'the modeled report', render: MODELED, present: ['.report-figure .report-massing', '.report-plan-images']},
  // The entry rules span the column; the entry text itself holds the reading measure.
  {path: '/whats-new', ready: '.whats-new-entry', column: '.whats-new', parts: ['.whats-new-list', '.whats-new-entry'], prose: '.whats-new p'},
];

const measure = ({column, parts, prose, present = []}) => `(() => {
  const box = (el) => el.getBoundingClientRect();
  const doc = document.scrollingElement;
  const scroller = document.querySelector('.report-page:not([hidden]), .whats-new-page:not([hidden])');
  const main = document.querySelector('.report-main');
  return {
    viewport: innerWidth,
    pageOverflow: Math.max(doc.scrollWidth - doc.clientWidth, scroller.scrollWidth - scroller.clientWidth),
    rail: Math.round(box(document.querySelector('.sidebar')).right),
    column: {left: Math.round(box(document.querySelector(${JSON.stringify(column)})).left), right: Math.round(box(document.querySelector(${JSON.stringify(column)})).right)},
    parts: ${JSON.stringify(parts)}.map((s) => [s, document.querySelector(s)]).filter(([, el]) => el).map(([s, el]) => ({s, left: Math.round(box(el).left), right: Math.round(box(el).right)})),
    // How far the widest line of prose runs past 70 characters of its own type.
    proseExcess: Math.max(0, ...[...document.querySelectorAll(${JSON.stringify(prose)})].filter((p) => p.offsetParent).map((p) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position: absolute; width: 70ch';
      p.append(probe);
      const excess = Math.round(box(p).width - box(probe).width);
      probe.remove();
      return excess;
    })),
    missing: ${JSON.stringify(present)}.filter((s) => !document.querySelector(s)),
    main: main && {width: Math.round(box(main).width), cap: Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) * 60)},
    // How far each chapter, block and cover part ends from the chapter column's right edge.
    edges: main ? [...document.querySelectorAll('.report-cover, .report-terms, .report-main :is(.report-chapter, .report-block, .report-facts, .report-table, .report-figure, .report-plan-images, .uw-scheme-list)')]
      .filter((el) => el.offsetParent).map((el) => ({s: el.className, off: Math.round(box(el).right - box(main).right)})) : [],
    // Tables that stop short of their column.
    short: main ? [...main.querySelectorAll('.report-table table')].filter((t) => t.offsetParent && box(t).width < t.parentElement.clientWidth - 1).length : 0,
    // The empty space between the drawn massing and its floor plates, when they sit side by side.
    massingGap: [...document.querySelectorAll('.report-massing-wrap')].map((wrap) => {
      const svg = wrap.querySelector('svg'), plates = wrap.querySelector('.report-table');
      const s = box(svg), p = box(plates), vb = svg.viewBox.baseVal;
      if (p.top >= s.bottom) return 0;
      const drawn = Math.min(s.width, s.height * vb.width / vb.height);
      return Math.round(p.left - (s.left + (s.width + drawn) / 2));
    }),
  };
})()`;

test("the report and what's new span the page beside the rail, keep a reading measure and fit a phone", {skip: !chrome && 'no Chrome or Chromium binary', timeout: 120000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  for (const page of PAGES) {
    for (const width of [390, 768, 1100, 1440, 1920, 2560]) {
      await send('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: width < 768});
      await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + page.path)}`);
      await waitFor(() => evaluate(`!window.measured && !!document.querySelector(${JSON.stringify(page.ready)})`), `${page.path} at ${width}`);
      if (page.render) await evaluate(page.render);
      await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const m = await evaluate(measure(page));
      const label = `${page.label || page.path} at ${width}`;
      check(m.pageOverflow === 0, `${label}: the page scrolls sideways`);
      check(m.parts.length === page.parts.length, `${label}: ${page.parts.join(', ')} all render`);
      check(m.proseExcess <= 1, `${label}: prose runs ${m.proseExcess}px past a 70 character measure`);
      check(m.missing.length === 0, `${label}: ${m.missing.join(', ')} render`);
      if (m.main) check(m.main.width <= m.main.cap, `${label}: the chapter column is ${m.main.width}px, past ${m.main.cap}px`);
      for (const e of m.edges) check(Math.abs(e.off) <= 1, `${label}: ${e.s} ends ${e.off}px from the chapter column's edge`);
      check(m.short === 0, `${label}: ${m.short} tables stop short of their column`);
      for (const gap of m.massingGap) check(gap <= 64, `${label}: the massing drawing sits ${gap}px from its floor plates`);
      if (width === 2560) {
        const left = m.column.left - m.rail, right = m.viewport - m.column.right;
        check(Math.abs(left - right) <= 40, `${label}: the page sits ${left}px from the rail and ${right}px from the edge`);
      }
      if (width !== 1440) continue;
      for (const p of m.parts) {
        check(p.left - m.rail <= 40, `${label}: ${p.s} starts ${p.left - m.rail}px from the rail`);
        check(m.viewport - p.right <= 40, `${label}: ${p.s} ends ${m.viewport - p.right}px from the edge`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
