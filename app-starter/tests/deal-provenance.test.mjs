import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {normalizeDealRow, buildDealUnderwritePrompt, verdictMeta} from '../public/deals.js';
import {dealCard} from '../public/deal-card.js';

const {document} = parseHTML('<html><body></body></html>');
globalThis.document = document;

test('an absent deal assessment stays unrated instead of becoming a fair deal', () => {
  for (const row of [{}, {deal_verdict: ''}, {flashcardValuation: {}}]) {
    const deal = normalizeDealRow(row);
    assert.equal(deal.deal_verdict, null);
    assert.deepEqual(verdictMeta(deal.deal_verdict), {label: 'Not rated', cls: 'verdict-unpriced', unrated: true});
  }
  assert.equal(normalizeDealRow({flashcardValuation: {dealVerdict: 'good_deal'}}).deal_verdict, 'good_deal');
});

test('unassessed and unrecognized ratings are visible without implying an evaluation', () => {
  for (const rating of [undefined, 'future_model_rating']) {
    const card = dealCard({id: 'unknown', address: '10 Example St', listPrice: 1_000_000, deal_verdict: rating});
    assert.match(card.textContent, /Not rated/);
    assert.doesNotMatch(card.textContent, /Fair Deal|Evaluated|future_model_rating/);
  }
});

test('underwriting never invents a zoning district when source coverage is absent', () => {
  const prompt = buildDealUnderwritePrompt({address: '10 Example St'});
  assert.match(prompt, /zoning district not verified/);
  assert.doesNotMatch(prompt, /Contextual Residential/);
  assert.match(buildDealUnderwritePrompt({address: '10 Example St', zoningDistrict: 'R6A'}), /in R6A/);
});
