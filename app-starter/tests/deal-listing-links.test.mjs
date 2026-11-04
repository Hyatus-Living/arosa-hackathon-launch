import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {dealCard} from '../public/deal-card.js';

const {document} = parseHTML('<html><body></body></html>');
globalThis.document = document;
const row = {id: 'source', address: '10 Example St', listPrice: 1_000_000};

test('a deal card opens the original listing without losing the underwriting context', () => {
  const card = dealCard({...row, url: 'https://example.com/listing/10?ref=feed'});
  const link = card.querySelector('a.deal-listing-link');
  assert.ok(link);
  assert.equal(link.href, 'https://example.com/listing/10?ref=feed');
  assert.equal(link.textContent, 'View listing');
  assert.equal(link.getAttribute('aria-label'), 'View listing for 10 Example St');
  assert.equal(link.target, '_blank');
  assert.match(link.rel, /noopener/);
  assert.match(link.rel, /noreferrer/);
  assert.equal(card.querySelector('.deal-card-underwrite').textContent, 'Underwrite');
});

test('missing, unsafe or credential-bearing listing URLs never become navigation links', () => {
  for (const url of [undefined, '', '/internal', 'not a URL', 'javascript:alert(1)', 'data:text/html,test', 'https://user:secret@example.com/']) {
    assert.equal(dealCard({...row, url}).querySelector('a.deal-listing-link'), null);
  }
});

test('an off-market row links to its source record, not a live listing', () => {
  for (const status of [{listingType: 'off_market'}, {mlsStatus: 'off_market'}]) {
    const card = dealCard({...row, ...status, url: 'https://example.com/listing/10'});
    const link = card.querySelector('a.deal-listing-link');
    assert.ok(link);
    assert.equal(link.href, 'https://example.com/listing/10');
    assert.equal(link.textContent, 'View source');
    assert.equal(link.getAttribute('aria-label'), 'View source for 10 Example St (off market)');
  }
  const live = dealCard({...row, listingType: 'for_sale', url: 'https://example.com/listing/10'});
  assert.equal(live.querySelector('a.deal-listing-link').textContent, 'View listing');
});

test('unpriced listings can still be investigated through their original source', () => {
  const card = dealCard({...row, listPrice: null, url: 'https://example.com/call-for-offers'});
  assert.equal(card.querySelector('a.deal-listing-link')?.href, 'https://example.com/call-for-offers');
  assert.match(card.textContent, /Unpriced/);
});
