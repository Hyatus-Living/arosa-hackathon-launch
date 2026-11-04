import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDealPlanPrompt} from '../public/deals.js';

test('a floor plan started from a listing carries the lot, zoning, buildable area and units on record', () => {
  const prompt = buildDealPlanPrompt({address: '10 Example St', bbl: '3011560001', lotAreaSqft: 2500, lotFrontFeet: 25, lotDepthFeet: 100,
    zoningDistrict: 'R6A', buildableZfa: 7500, maxBuildableUnits: 10, plannedUnits: 8, url: 'https://example.com/listing'});
  assert.match(prompt, /^Model 10 Example St \(BBL 3011560001\): draft a floor plan/);
  assert.match(prompt, /On record: lot 2,500 SF \(25 by 100 ft\), R6A, 7,500 SF buildable, 8 planned units \(most allowed 10\)\./);
  assert.match(prompt, /Listing: https:\/\/example\.com\/listing$/);
});

test('facts the listing lacks are left out rather than guessed', () => {
  const prompt = buildDealPlanPrompt({address: '10 Example St', lotAreaSqft: 2500, maxUapZfa: 6800});
  assert.match(prompt, /On record: lot 2,500 SF, 6,800 SF buildable, 10 most units allowed\./);
  assert.doesNotMatch(prompt, /R6A|by 100 ft/);
  assert.doesNotMatch(buildDealPlanPrompt({address: '10 Example St'}), /On record/);
});
