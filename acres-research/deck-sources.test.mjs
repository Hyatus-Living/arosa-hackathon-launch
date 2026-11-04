import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUnderwritingDeck, renderDeckHtml} from './deliverable.mjs';

test('malformed source URLs do not prevent the report and valid citations from exporting', () => {
  const deck = buildUnderwritingDeck({sources: [
    {title: 'Unresolved source', url: 'not a URL'},
    {title: 'Official section', url: 'https://zoningresolution.planning.nyc.gov/article-ii/chapter-3/23-52'},
    {url: 'https://example.com/bad%ZZpath'},
  ]});
  assert.equal(deck.sources[0].url, null);
  assert.equal(deck.sources[0].title, 'Unresolved source');
  assert.equal(deck.sources[2].title, 'example.com/bad%ZZpath');
  const html = renderDeckHtml(deck);
  assert.match(html, /Official section/);
  assert.doesNotMatch(html, /href="not a URL"/);
});

test('report source links reject executable schemes and embedded credentials', () => {
  const deck = buildUnderwritingDeck({sources: [
    {title: 'Script source', url: 'javascript:alert(1)'},
    {title: 'Data source', url: 'data:text/html,test'},
    {title: 'Private source', url: 'https://user:secret@example.com/report'},
    {title: 'https://user:secret@example.com/report', url: 'https://user:secret@example.com/report'},
  ]});
  assert.ok(deck.sources.every((s) => s.url === null && s.domain === null));
  const html = renderDeckHtml(deck);
  assert.doesNotMatch(html, /href="(?:javascript:|data:|https:\/\/user:secret)/);
  assert.doesNotMatch(html, /user:secret/);
});

test('distinct cited sections retain their exact anchors while exact duplicate references collapse', () => {
  const root = 'https://example.com/resolution';
  const deck = buildUnderwritingDeck({sources: [
    {title: 'Density', url: `${root}#density`},
    {title: 'Height', url: `${root}#height`},
    {title: 'Density duplicate', url: `${root}#density`},
  ]});
  assert.deepEqual(deck.sources.map((s) => s.url), [`${root}#density`, `${root}#height`]);
  const html = renderDeckHtml(deck);
  assert.match(html, /resolution#density/);
  assert.match(html, /resolution#height/);
});

test('whitespace-padded unsafe URL titles cannot disclose embedded credentials', () => {
  const url = ' https://user:secret@example.com/report ';
  const deck = buildUnderwritingDeck({sources: [{title: url, url}]});
  assert.equal(deck.sources[0].url, null);
  assert.equal(deck.sources[0].title, 'Source link unavailable');
  assert.doesNotMatch(renderDeckHtml(deck), /user:secret/);
});
