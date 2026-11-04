import test from 'node:test';
import assert from 'node:assert/strict';
import {fmtCurrency, fmtInt, fmtPct, normalizeDealRow, verdictThresholds} from '../public/deals.js';
import {fmtNumber, fmtSqft, fmtMoney, fmtRate, fmtFar, headroomSqft, headroomFar} from '../public/core-model.js';

test('unknown numeric inputs never become financial or area measurements', () => {
  const formatters = [fmtCurrency, fmtInt, fmtPct, fmtNumber, fmtSqft, fmtMoney, fmtRate, fmtFar];
  for (const value of [null, undefined, '', '  ', '\t', true, false, [], [12], {}, NaN, Infinity, 'not reported']) {
    for (const format of formatters) {
      assert.equal(format(value), '–', `${format.name} must keep ${JSON.stringify(value)} unknown`);
    }
  }
});

test('known zero and numeric strings remain valid across deal and parcel displays', () => {
  assert.equal(fmtCurrency(0), '$0');
  assert.equal(fmtInt(' 1250 '), '1,250');
  assert.equal(fmtPct('0'), '0.0%');
  assert.equal(fmtMoney('-250'), '-$250');
  assert.equal(fmtRate('0.064'), '6.4%');
  assert.equal(fmtSqft(0), '0 sq ft');
  assert.equal(fmtFar('2.75'), '2.75');
});

test('valuation normalization and threshold copy preserve unknown rates', () => {
  for (const value of ['', ' ', false, true, null, [], 'unknown']) {
    const deal = normalizeDealRow({flashcardValuation: {impliedYieldOnCostPct: value, impliedCondoMarginPct: value}});
    assert.equal(deal.implied_cap_rate, null);
    assert.equal(deal.implied_condo_margin, null);
    const thresholds = verdictThresholds({greatDealCapRate: value, greatDealCondoMargin: value});
    assert.equal(thresholds.great, 'ask ≤70% of nearby land sales, or ≥– yield or ≥– margin without them');
  }
  const deal = normalizeDealRow({flashcardValuation: {impliedYieldOnCostPct: '6.4', impliedCondoMarginPct: 0}});
  assert.equal(deal.implied_cap_rate, 0.064);
  assert.equal(deal.implied_condo_margin, 0);
});

test('missing measurements stay unknown while standard capacity and zero-only headroom remain valid', () => {
  const deal = normalizeDealRow({});
  for (const key of ['lot_area_sqft', 'building_sqft', 'max_buildable_zfa', 'uap_max_buildable_zfa', 'uap_unused_zfa']) assert.equal(deal[key], null, key);
  assert.equal(headroomSqft(deal), null);
  assert.equal(headroomFar({...deal, lot_area_sqft: 2500}), null);
  assert.equal(headroomSqft({uap_unused_zfa: 0, unused_residential_zfa: 1000}), 1000);
  assert.equal(headroomFar({lot_area_sqft: 2500, uap_unused_zfa: 0, unused_residential_zfa: 1000}), 0.4);
  assert.equal(headroomSqft({uap_unused_zfa: 0}), 0);
  assert.equal(headroomSqft({uap_unused_zfa: 0, unused_residential_zfa: 0}), 0);
});
