import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {buildUnderwritingDeck, renderDeckHtml} from './deliverable.mjs';

const field = (value, stale = null) => ({value, stale, updated: 1, provenance: {sources: []}});
const financials = [{development: {totalDevelopmentCost: 1_000_000}, operations: {yieldOnCost: 0.07}, returns: {profit: 100_000}}];

test('exported projections carry stale-input warnings on the cover and financial section', () => {
  const deck = buildUnderwritingDeck({projectState: {proFormas: field(financials, 'market')}});
  assert.equal(deck.freshnessWarnings?.[0].field, 'proFormas');
  assert.match(deck.freshnessWarnings[0].message, /Financial projections.*market inputs changed/i);
  const {document} = parseHTML(renderDeckHtml(deck));
  assert.match(document.querySelector('#executive-summary .freshness-note')?.textContent || '', /needs refresh/i);
  assert.match(document.querySelector('#pro-forma-and-feasibility .freshness-note')?.textContent || '', /market inputs changed/i);
  assert.match(document.querySelector('#pro-forma-and-feasibility').textContent, /1,000,000/);
});

test('the deck follows the viewer color scheme instead of fixed light', () => {
  const html = renderDeckHtml(buildUnderwritingDeck({projectState: {proFormas: field(financials)}}));
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /--paper: #1b1b1b/);
});

test('current findings are retained without an invented stale warning', () => {
  const deck = buildUnderwritingDeck({projectState: {proFormas: field(financials)}});
  const {document} = parseHTML(renderDeckHtml(deck));
  assert.equal(document.querySelector('.freshness-note'), null);
  assert.match(document.querySelector('#pro-forma-and-feasibility').textContent, /1,000,000/);
});

test('stale geometry is identified in its affected sections rather than marking a fresh parcel record stale', () => {
  const deck = buildUnderwritingDeck({projectState: {
    property: field({address: '10 Example St', lotarea: 2500}),
    envelope: field({district: 'R6A'}, 'property'),
    concepts: field([], 'property'),
  }});
  const {document} = parseHTML(renderDeckHtml(deck));
  assert.match(document.querySelector('#zoning-and-entitlements .freshness-note')?.textContent || '', /parcel record changed/i);
  assert.match(document.querySelector('#massing-and-floorplan-audit .freshness-note')?.textContent || '', /parcel record changed/i);
  assert.equal(document.querySelector('#parcel-forensics .freshness-note'), null);
});

test('deep-research reports retain every unique citation beyond the former thirty-source cap', () => {
  const sources = Array.from({length: 45}, (_, i) => ({title: `Reference ${i + 1}`, url: `https://example.com/reference/${i + 1}`}));
  const deck = buildUnderwritingDeck({sources: [...sources, sources[0]]});
  assert.equal(deck.sources.length, 45);
  assert.equal(deck.slides[6].sources.length, 45);
  const {document} = parseHTML(renderDeckHtml(deck));
  assert.equal(document.querySelectorAll('.sources li').length, 45);
  assert.equal(document.querySelector('a[href="https://example.com/reference/45"]')?.textContent, sources[44].url);
});

test('unknown refresh reasons remain readable and inherited object keys are not report sections', () => {
  const deck = buildUnderwritingDeck({projectState: {
    proFormas: field(financials, 'constructor'),
    ['__proto__']: field({}, 'property'),
  }});
  assert.equal(deck.freshnessWarnings?.length, 1);
  assert.equal(deck.freshnessWarnings[0].field, 'proFormas');
  assert.match(deck.freshnessWarnings[0].message, /the inputs changed/);
  assert.doesNotMatch(renderDeckHtml(deck), /constructor|__proto__/);
});
