import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDealUnderwritePrompt, unitEstimate} from '../public/deals.js';

test('underwriting names planned units beside the most the zoning allows', () => {
  const prompt = buildDealUnderwritePrompt({address: '10 Example St', maxBuildableUnits: 10, plannedUnits: 8, maxUapZfa: 6800, listPrice: 1_000_000, pricePerBuildableUnit: 125_000});
  assert.match(prompt, /8 planned units \(most allowed 10\)/);
  assert.match(prompt, /\$125,000\/planned unit/);
  assert.doesNotMatch(prompt, /estimated unit|680 ZFA\/unit assumption/);
});

test('without a planned count the zoning cap is named as a cap, never as planned units', () => {
  assert.match(buildDealUnderwritePrompt({address: '10 Example St', maxUapZfa: 10000}), /14 most units allowed/);
  assert.deepEqual(unitEstimate({maxBuildableUnits: 10}), {count: 10, max: 10, planned: null, label: '10 most units allowed'});
});

test('absent floor area stays unassessed and an explicit zero is preserved', () => {
  assert.match(buildDealUnderwritePrompt({address: '10 Example St'}), /Unit capacity not assessed/);
  assert.match(buildDealUnderwritePrompt({address: '10 Example St', maxBuildableUnits: 0, maxUapZfa: 6800}), /0 most units allowed/);
});
