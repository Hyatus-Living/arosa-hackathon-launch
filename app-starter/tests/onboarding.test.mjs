import test from "node:test";
import assert from "node:assert/strict";
import { FIELDS, STEPS, WELCOME, initialValues, fieldError, stepErrors, costStack, toDealSettings } from "../public/onboarding-model.js";

const HOUSE = {
  hardCostPerGrossSqft: 375, rentalHardCostPerGrossSqft: 375, condoHardCostPerGrossSqft: 375, softCostPctOfHard: 0.22, carryAndFinancingPct: 0.1, zfaToGrossFactor: 1.15, zfaToNetEfficiency: 0.85,
  operatingExpenseRatio: 0.3, greatDealCapRate: 0.085, goodDealCapRate: 0.0725, badDealCapRate: 0.06,
  greatDealCondoMargin: 0.28, goodDealCondoMargin: 0.18, badDealCondoMargin: 0.1,
};

test("both hard costs start empty and block the first step; the rest start at house costs", () => {
  const values = initialValues(HOUSE);
  assert.equal(values.rentalHardCostPerGrossSqft, null);
  assert.equal(values.condoHardCostPerGrossSqft, null);
  assert.equal(values.softCostPctOfHard, 22);
  assert.equal(values.zfaToGrossFactor, 15);
  assert.equal(values.goodDealCapRate, 7.25);
  assert.deepEqual(stepErrors(STEPS[0], values), {
    rentalHardCostPerGrossSqft: "Enter your rental hard cost to continue.",
    condoHardCostPerGrossSqft: "Enter your condo hard cost to continue.",
  });
  // One hard cost alone still blocks: there is no house stand-in for either.
  assert.deepEqual(Object.keys(stepErrors(STEPS[0], { ...values, rentalHardCostPerGrossSqft: 420 })), ["condoHardCostPerGrossSqft"]);
  assert.deepEqual(stepErrors(STEPS[1], values), {});
  assert.match(fieldError("rentalHardCostPerGrossSqft", 40), /from 100 to 2,500/);
  assert.match(fieldError("condoHardCostPerGrossSqft", 2600), /from 100 to 2,500/);
  assert.equal(fieldError("condoHardCostPerGrossSqft", 420), null);
});

test("every step but the last asks for at least one field, and every field is asked once", () => {
  const asked = STEPS.flatMap(step => step.fields);
  assert.deepEqual([...asked].sort(), Object.keys(FIELDS).sort());
  assert.equal(STEPS.at(-1).fields.length, 0);
  assert.ok(STEPS.slice(0, -1).every(step => step.fields.length));
});

test("the cost stack builds hard on gross area, then soft costs, then carry, for each exit", () => {
  assert.equal(costStack(initialValues(HOUSE)), null);
  assert.equal(costStack({ ...initialValues(HOUSE), rentalHardCostPerGrossSqft: 400 }), null);
  const stack = costStack({ ...initialValues(HOUSE), rentalHardCostPerGrossSqft: 400, condoHardCostPerGrossSqft: 500 });
  // Rental: 400 x 1.15 = 460; soft 22% = 101.2; carry 10% of 561.2 = 56.12.
  // Condo: 500 x 1.15 = 575; soft 22% = 126.5; carry 10% of 701.5 = 70.15.
  assert.deepEqual(stack, {
    hard: 460, soft: 101, carry: 56, total: 617,
    rental: { hard: 460, soft: 101, carry: 56, total: 617 },
    condo: { hard: 575, soft: 127, carry: 70, total: 772 },
  });
});

test("saved settings convert view units and keep the threshold spacing around the good deal", () => {
  const values = { ...initialValues(HOUSE), rentalHardCostPerGrossSqft: 410, condoHardCostPerGrossSqft: 460, softCostPctOfHard: 25, zfaToGrossFactor: 18, zfaToNetEfficiency: 82, goodDealCapRate: 7.75, goodDealCondoMargin: 20 };
  const saved = toDealSettings(values, HOUSE);
  assert.equal(saved.rentalHardCostPerGrossSqft, 410);
  assert.equal(saved.condoHardCostPerGrossSqft, 460);
  assert.equal(saved.hardCostPerGrossSqft, 410, "the legacy single hard cost reads back as the rental figure");
  assert.equal(saved.softCostPctOfHard, 0.25);
  assert.equal(saved.carryAndFinancingPct, 0.1);
  assert.equal(saved.zfaToGrossFactor, 1.18);
  assert.equal(saved.zfaToNetEfficiency, 0.82);
  assert.equal(saved.operatingExpenseRatio, 0.3);
  assert.deepEqual([saved.greatDealCapRate, saved.goodDealCapRate, saved.badDealCapRate], [0.09, 0.0775, 0.065]);
  assert.deepEqual([saved.greatDealCondoMargin, saved.goodDealCondoMargin, saved.badDealCondoMargin], [0.3, 0.2, 0.12]);
});

test("the welcome says why costs are asked, in plain words, and previews every question step", () => {
  const copy = [WELCOME.title, ...WELCOME.lines, WELCOME.action].join(" ");
  assert.match(copy, /land value/);
  assert.match(copy, /about a minute/);
  assert.match(copy, /change it any time/);
  assert.doesNotMatch(copy, /\u2014/);
  assert.ok(STEPS.every(step => step.short && !step.short.includes("\u2014")));
});
