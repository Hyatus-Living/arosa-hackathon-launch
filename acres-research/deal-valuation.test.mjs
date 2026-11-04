import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore, computeDealValuation, computePhysicalEnvelopeAndDeductions, residentialFarFor, buyerTransferTaxRate, DEAL_SCREEN_ASSUMPTIONS, DEFAULT_NYC_DEV_SETTINGS, askForLandValue, DEAL_UNIT_MIX, ZFA_GROSS_DEDUCTIONS, LISTING_DATA_CHECKS, listingDataChecks, mostUnitsAllowed, normalizeDealSettings, resolveHardCosts, NEARBY_PRICE_TIERS} from './market-store.mjs';
import {NYC_HARD_COST, defaultHardCost} from './construction-costs.mjs';
import {computeEnvelope} from './envelope.mjs';
import {rules as ZONING_RULES, describeDistrict} from './zoning.mjs';

// A 20 by 54 ft interior lot in a high-density contextual district, bought as a townhouse.
const narrowTownhouse = {
  listPrice: 4_900_000, lotArea: 1080, lotFront: 20, lotDepth: 54, lotTypeCode: '5', bldgArea: 3200, bldgClass: 'S1', unitsRes: 1,
  residFar: 7.52, affResFar: 9.02, zoningDistrict: 'R9A', address: '1 EXAMPLE STREET', borough: 'MN', zipCode: '10003',
};
// A vacant 50 by 100 ft interior lot in a medium-density contextual district.
const vacantLot = {
  listPrice: 2_000_000, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 0,
  residFar: 4.0, affResFar: 5.01, zoningDistrict: 'R7A', address: '2 EXAMPLE AVENUE', borough: 'BK', zipCode: '11216',
};

// An account's own hard cost, so a case built on fixed costs does not move with the house cost range.
const OWN_COSTS = {hardCostPerGrossSqft: 380};

// A 25 ft R8 lot on a 60 ft street: a narrow building held to the street width (ZR 23-738).
const narrowR8 = {listPrice: 3_000_000, lotArea: 2500, lotFront: 25, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 6.02, affResFar: 7.2, zoningDistrict: 'R8', address: '9 EXAMPLE STREET', borough: 'MN', zipCode: '10025', frontStreetFeet: 60};

// A 25 by 30 ft R9A lot: the shallow-lot rear yard bottoms at 10 ft (ZR 23-342), leaving 20 ft of depth under the heights.
const shallowR9A = {listPrice: 1_500_000, lotArea: 750, lotFront: 25, lotDepth: 30, lotTypeCode: '5', bldgArea: 0, residFar: 7.52, affResFar: 9.02, zoningDistrict: 'R9A', address: '9 EXAMPLE STREET', borough: 'BK', zipCode: '11216', frontStreetFeet: 60};

test('price per buildable SF reads the zoning floor area the envelope holds, not the paper maximum or its gross area', () => {
  const v = computeDealValuation(shallowR9A);
  assert.equal(v.maxStandardZfa, 5640);
  // Nine 500 sq ft storeys reach 94.5 ft under the 95 ft base, and three 125 sq ft storeys set 15 ft back stop under the
  // 135 ft height: 4,875 sq ft gross; less the recreation space and exterior walls inside them, the zoning floor area.
  const grossPerZfa = 1 + ZFA_GROSS_DEDUCTIONS.recreationPct + ZFA_GROSS_DEDUCTIONS.exteriorWallPct;
  assert.equal(v.achievableStandardZfa, Math.round(4875 / grossPerZfa));
  assert.ok(v.achievableStandardZfa < v.maxStandardZfa);
  assert.equal(v.physicalEnvelope.isBulkConstrained, true);
  assert.equal(v.physicalEnvelope.envelopeBasis, 'curated-envelope');
  assert.equal(v.buildableZfa, v.valueDriver.buildableZfa);
  assert.equal(v.buildableZfa, v.achievableStandardZfa);
  assert.equal(v.pricePerBuildableSf, Math.round(shallowR9A.listPrice / v.buildableZfa));
  assert.equal(v.unusedUapZfa, v.achievableUapZfa - shallowR9A.bldgArea);
  // The summary quotes the controls the envelope used.
  assert.match(v.physicalEnvelope.bulkConstraintSummary, /^3D Bulk Capped: Paper UAP ZFA is 6,765 SF, but the 25'×30' interior lot \(10' rear yard, 80% max coverage, 185' height cap\) holds [\d,]+ ZFA/);
  assert.deepEqual([v.physicalEnvelope.rearYardFeet, v.physicalEnvelope.maxLotCoveragePct], [10, 80]);
});

test('a 25 ft R8 lot holds the floor area its FAR allows: ZR 23-738 limits only sky exposure plane buildings', () => {
  const v = computeDealValuation(narrowR8);
  assert.deepEqual([v.maxStandardZfa, v.achievableStandardZfa, v.buildableZfa], [15050, 15050, 15050]);
  assert.equal(v.physicalEnvelope.isBulkConstrained, false);
  assert.equal(v.pricePerBuildableSf, Math.round(3_000_000 / 15050));
  assert.equal(v.physicalEnvelope.rearYardFeet, 30, 'the 30 ft rear yard of a lot under 40 ft wide');
});

test('a floor area ratio cap reached mid-storey builds a partial top storey in the envelope itself', () => {
  const v = computeDealValuation(vacantLot);
  assert.equal(v.achievableStandardZfa, v.maxStandardZfa);
  assert.equal(v.achievableUapZfa, v.maxUapZfa);
  // C6-1 prices residential at 3.44 FAR: 17,200 sq ft is 18,198 sq ft gross, four 4,000 sq ft storeys and a
  // partial fifth, which the envelope counts itself.
  const c61 = computeDealValuation({...vacantLot, residFar: 3.44, affResFar: 5.01, commFar: 6, zoningDistrict: 'C6-1'});
  assert.equal(c61.achievableStandardZfa, 17200);
  assert.equal(c61.physicalEnvelope.standardStoreys, 5);
  assert.equal(c61.valueDriver.program, 'standard');
  assert.equal(c61.valueDriver.storeys, 5);
});

test('floor plates too small for a core collapse efficiency and hold the tier at fair or below', () => {
  const v = computeDealValuation({...narrowTownhouse, listPrice: 600_000, settings: OWN_COSTS});
  assert.ok(v.valueDriver.floorplateSqft < DEAL_SCREEN_ASSUMPTIONS.minViableFloorplateSqft);
  assert.ok(v.valueDriver.netEfficiency < 0.5);
  assert.deepEqual(v.gates.map(g => g.id), ['floorplate']);
  assert.equal(v.priceVerdict, 'good_deal');
  assert.equal(v.dealVerdict, 'fair_deal');
});

test('affordability bonus area is valued at affordable rents and reported with the program that sets the value', () => {
  const v = computeDealValuation({...vacantLot, settings: {hardCostPerGrossSqft: 150}});
  const driver = v.valueDriver;
  if (driver.program === 'uap') assert.equal(driver.affordableZfa, v.achievableUapZfa - v.maxStandardZfa);
  else assert.equal(driver.affordableZfa, 0);
  assert.ok(['rental', 'condo'].includes(driver.exit));
  assert.ok(v.affordableRentPsf > 0 && v.affordableRentPsf <= v.submarketRentPsf);
  // Bonus area that earns less than it costs never wins: at the same costs with market-rate bonus
  // area the bonus program would always be worth at least as much as the standard one.
  const costly = computeDealValuation({...vacantLot, settings: {hardCostPerGrossSqft: 900}});
  assert.equal(costly.valueDriver.program, 'standard');
});

test('an account\'s own hard cost rises with height class and on narrow lots', () => {
  const narrow = computeDealValuation({...narrowTownhouse, settings: OWN_COSTS}).valueDriver;
  const factor = DEAL_SCREEN_ASSUMPTIONS.heightClasses.find(c => c.label === narrow.heightClass).hardCostFactor;
  assert.ok(narrow.storeys > 6 && factor > 1, 'a building above six storeys is not priced as low-rise');
  assert.equal(narrow.narrowLot, true);
  assert.equal(narrow.hardCostPerGrossSqft, Math.round(380 * factor * DEAL_SCREEN_ASSUMPTIONS.narrowLotHardCostFactor));
  const low = computeDealValuation({...vacantLot, settings: OWN_COSTS}).valueDriver;
  assert.equal(low.heightClass, 'low-rise');
  assert.equal(low.hardCostPerGrossSqft, 380);
});

test('the house hard cost is the published New York range placed by structure and sale price', () => {
  const at = (storeys, salePsf) => defaultHardCost({storeys, salePsf, valuationDate: NYC_HARD_COST.asOf}).perGrossSqft;
  // The ends of the range: a low-rise at the low end of the price scale and a high-rise at the top.
  assert.equal(at(4, NYC_HARD_COST.specification.lowSalePsf), Math.round(260 + 250 / 12));
  assert.equal(at(30, NYC_HARD_COST.specification.highSalePsf), Math.round(510 - 250 / 12));
  assert.ok(at(4, 1000) < at(9, 1000) && at(9, 1000) < at(20, 1000), 'taller structures cost more at the same price');
  assert.ok(at(9, 700) < at(9, 1500) && at(9, 1500) < at(9, 2500), 'higher-priced buildings are built to a higher specification');
  assert.equal(at(9, 99_999), at(9, NYC_HARD_COST.specification.highSalePsf), 'the specification scale stops at its ends');
  // Escalated by the report's New York index after the survey date, never before it.
  const year = defaultHardCost({storeys: 9, salePsf: 1000, valuationDate: '2027-07-01'});
  assert.ok(Math.abs(year.escalation - 1.0484) < 0.001);
  assert.equal(defaultHardCost({storeys: 9, salePsf: 1000, valuationDate: '2026-01-01'}).escalation, 1);

  // A valuation at the house cost prices each exit from the range, with the narrow-lot factor on top.
  const v = computeDealValuation({...vacantLot, submarketSalePsf: 900, valuationDate: NYC_HARD_COST.asOf}).valueDriver;
  const salePsf = computeDealValuation({...vacantLot, submarketSalePsf: 900}).submarketSalePsf;
  assert.equal(v.hardCostPerGrossSqft, at(v.storeys, salePsf));
  assert.deepEqual([v.rentalHardCostFromTable, v.condoHardCostFromTable, v.heightClassFactor, v.hardCostTable.structure], [true, true, 1, 'low_rise']);
  const narrow = computeDealValuation({...vacantLot, lotFront: 24, lotArea: 2400, submarketSalePsf: 900, valuationDate: NYC_HARD_COST.asOf}).valueDriver;
  assert.equal(narrow.hardCostPerGrossSqft, Math.round(at(narrow.storeys, salePsf) * DEAL_SCREEN_ASSUMPTIONS.narrowLotHardCostFactor));
  // An account's own figure for one exit replaces the range for that exit only.
  const mixed = computeDealValuation({...vacantLot, submarketSalePsf: 900, valuationDate: NYC_HARD_COST.asOf, settings: {rentalHardCostPerGrossSqft: 375, condoHardCostPerGrossSqft: 500}}).valueDriver;
  assert.deepEqual([mixed.rentalHardCostFromTable, mixed.condoHardCostFromTable, mixed.condoHardCostPerGrossSqft, mixed.rentalHardCostPerGrossSqft], [true, false, 500, at(mixed.storeys, salePsf)]);
});

test('the narrow-lot cost step reads the measured frontage, not a rounded one', () => {
  const at = lotFront => computeDealValuation({...vacantLot, lotFront, lotArea: Math.round(lotFront * 100), settings: OWN_COSTS}).valueDriver;
  // Under 40 ft wide the 30 ft rear yard (ZR 23-342) needs a seventh storey: mid-rise, 380 x 1.12 = 426; under 25 ft
  // of frontage the narrow-lot step adds 8%: 380 x 1.12 x 1.08 = 460.
  assert.deepEqual([24.6, 24.9, 25, 25.1].map(w => [at(w).narrowLot, at(w).hardCostPerGrossSqft]), [[true, 460], [true, 460], [false, 426], [false, 426]]);
  assert.equal(at(24.9).heightClass, 'mid-rise');
  assert.deepEqual([at(40).heightClass, at(40).hardCostPerGrossSqft], ['low-rise', 380]);
});

test('a lone legacy hard cost prices both exits exactly as the split at the same figure', () => {
  const legacy = computeDealValuation({...vacantLot, settings: {hardCostPerGrossSqft: 200}});
  const split = computeDealValuation({...vacantLot, settings: {rentalHardCostPerGrossSqft: 200, condoHardCostPerGrossSqft: 200}});
  for (const key of ['goodDealMaxBsf', 'greatDealMaxBsf', 'badDealMinBsf', 'impliedYieldOnCost', 'impliedCondoMargin', 'constructionCost', 'dealVerdict']) {
    assert.equal(legacy[key], split[key], key);
  }
  assert.deepEqual(legacy.rentalSchemes, split.rentalSchemes);
  assert.equal(legacy.valueDriver.baseRentalHardCostPerGrossSqft, 200);
  assert.equal(legacy.valueDriver.baseCondoHardCostPerGrossSqft, 200);
  assert.equal(legacy.valueDriver.baseHardCostPerGrossSqft, 200);
});

test('rental schemes price at the rental hard cost and the condo exit at the condo hard cost', () => {
  const cheapRental = computeDealValuation({...vacantLot, settings: {rentalHardCostPerGrossSqft: 150, condoHardCostPerGrossSqft: 900}});
  const cheapCondo = computeDealValuation({...vacantLot, settings: {rentalHardCostPerGrossSqft: 900, condoHardCostPerGrossSqft: 150}});
  const rentalLand = v => Math.max(...v.rentalSchemes.map(s => s.landValue));
  assert.ok(rentalLand(cheapRental) > rentalLand(cheapCondo), 'cheaper rental hard cost leaves more for the land under a rental');
  assert.ok(cheapRental.impliedYieldOnCost > cheapCondo.impliedYieldOnCost, 'the yield builds at the rental cost');
  assert.ok(cheapRental.impliedCondoMargin < cheapCondo.impliedCondoMargin, 'the condo margin builds at the condo cost');
  // Changing only the condo cost must not move a rental scheme's land value, and vice versa.
  const dearerCondo = computeDealValuation({...vacantLot, settings: {rentalHardCostPerGrossSqft: 150, condoHardCostPerGrossSqft: 1400}});
  assert.deepEqual(dearerCondo.rentalSchemes, cheapRental.rentalSchemes);
  assert.equal(dearerCondo.impliedYieldOnCost, cheapRental.impliedYieldOnCost);
  assert.ok(dearerCondo.impliedCondoMargin < cheapRental.impliedCondoMargin);
  assert.equal(cheapRental.valueDriver.baseRentalHardCostPerGrossSqft, 150);
  assert.equal(cheapRental.valueDriver.baseCondoHardCostPerGrossSqft, 900);
  assert.ok(cheapRental.valueDriver.condoHardCostPerGrossSqft > cheapRental.valueDriver.rentalHardCostPerGrossSqft);
});

test('deal settings normalize the hard-cost split with the legacy value as both', () => {
  const legacyOnly = normalizeDealSettings({hardCostPerGrossSqft: 600});
  assert.deepEqual([legacyOnly.hardCostPerGrossSqft, legacyOnly.rentalHardCostPerGrossSqft, legacyOnly.condoHardCostPerGrossSqft], [600, 600, 600]);
  const split = normalizeDealSettings({rentalHardCostPerGrossSqft: 400, condoHardCostPerGrossSqft: 550});
  assert.deepEqual([split.hardCostPerGrossSqft, split.rentalHardCostPerGrossSqft, split.condoHardCostPerGrossSqft], [400, 400, 550]);
  // A pre-split saved base carries its single figure into both exits; an explicit split beats it.
  assert.deepEqual(resolveHardCosts({}, {hardCostPerGrossSqft: 500}), {rental: 500, condo: 500});
  assert.deepEqual(resolveHardCosts({condoHardCostPerGrossSqft: 700}, {hardCostPerGrossSqft: 500}), {rental: 500, condo: 700});
  const clamped = normalizeDealSettings({rentalHardCostPerGrossSqft: 40, condoHardCostPerGrossSqft: 9000});
  assert.deepEqual([clamped.rentalHardCostPerGrossSqft, clamped.condoHardCostPerGrossSqft], [100, 2500]);
});

test('buyer transfer tax follows the residential schedule and thresholds are stated as asks', () => {
  assert.equal(buyerTransferTaxRate(999_999, true), 0);
  assert.equal(buyerTransferTaxRate(1_000_000, true), 0.01);
  assert.equal(buyerTransferTaxRate(2_500_000, true), 0.0125);
  assert.equal(buyerTransferTaxRate(4_900_000, true), 0.015);
  assert.equal(buyerTransferTaxRate(30_000_000, true), 0.039);
  assert.equal(buyerTransferTaxRate(30_000_000, false), 0);

  const house = computeDealValuation(narrowTownhouse);
  assert.equal(house.acquisition.transferTaxRate, 0.015);
  assert.equal(house.acquisition.cost, Math.round(4_900_000 * (0.015 + DEAL_SCREEN_ASSUMPTIONS.buyerClosingCostPct)));
  const land = computeDealValuation(vacantLot);
  assert.equal(land.acquisition.transferTaxRate, 0);
  // The same land value supports a lower ask once buying costs are added.
  const asResidential = computeDealValuation({...vacantLot, listPrice: 4_000_000, bldgClass: 'B1', unitsRes: 2});
  const asLand = computeDealValuation({...vacantLot, listPrice: 4_000_000});
  assert.ok(asResidential.goodDealMaxBsf < asLand.goodDealMaxBsf);
});

test('each threshold ask pays the transfer tax bracket of its own price, not the listing\'s', () => {
  const closing = DEAL_SCREEN_ASSUMPTIONS.buyerClosingCostPct;
  const allIn = ask => ask * (1 + buyerTransferTaxRate(ask, true) + closing);
  // Land values on and either side of every bracket floor: the ask is the most whose own bracket keeps the
  // all-in cost within the land value, and a dollar more would not.
  for (const {minPrice} of [{minPrice: 1_000_000}, ...[2, 3, 5, 10, 15, 20, 25].map(m => ({minPrice: m * 1_000_000}))]) {
    for (const land of [minPrice * 0.99, minPrice * 1.005, minPrice * 1.02, minPrice * 1.05]) {
      const ask = askForLandValue(land, true);
      assert.ok(allIn(ask) <= land + 1e-6, `${land}: ${ask} costs ${allIn(ask)}`);
      assert.ok(allIn(Math.floor(ask) + 1) > land, `${land}: ${ask} is not the most the land supports`);
    }
  }
  assert.equal(askForLandValue(1_020_000, true), 999_999);
  assert.equal(askForLandValue(1_015_000, false), 1_015_000 / (1 + closing));

  // A $30M house: the good-deal threshold sits near $2.7M and pays 1.25%, while buying at the ask pays 3.9%.
  const lot = {...vacantLot, bldgClass: 'B1', unitsRes: 2, settings: OWN_COSTS};
  const listed = computeDealValuation({...lot, listPrice: 30_000_000});
  const cheap = computeDealValuation({...lot, listPrice: 2_000_000});
  assert.equal(listed.acquisition.transferTaxRate, 0.039);
  assert.equal(listed.acquisition.cost, Math.round(30_000_000 * (0.039 + closing)));
  const goodAsk = listed.goodDealMaxLandValue;
  assert.equal(buyerTransferTaxRate(goodAsk, true), 0.0125);
  assert.equal(listed.goodDealMaxBsf, Math.round(listed.valueDriver.landValue / (1 + 0.0125 + closing) / listed.valueDriver.buildableZfa));
  // The thresholds no longer move with the listing's own price.
  for (const key of ['greatDealMaxBsf', 'goodDealMaxBsf', 'badDealMinBsf']) assert.equal(listed[key], cheap[key], key);
});

test('gates cap the tier and keep the tier the price earned', () => {
  const cheap = {...vacantLot, listPrice: 800_000};
  const open = computeDealValuation(cheap);
  assert.equal(open.dealVerdict, 'great_deal');
  assert.deepEqual(open.gates, []);

  const landmark = computeDealValuation({...cheap, landmark: true});
  assert.equal(landmark.priceVerdict, 'great_deal');
  assert.equal(landmark.dealVerdict, 'fair_deal');

  const tenants = computeDealValuation({...cheap, rentStabilizationRisk: 'high'});
  assert.equal(tenants.dealVerdict, 'fair_deal');

  const flood = computeDealValuation({...cheap, inFloodZone: true});
  assert.equal(flood.dealVerdict, 'good_deal');
  assert.deepEqual(flood.gates.map(g => g.severity), ['review']);

  // A cap never lifts a tier.
  const dear = computeDealValuation({...vacantLot, listPrice: 50_000_000, inFloodZone: true});
  assert.equal(dear.dealVerdict, 'full_price');
});

// Nearby development-site sales (the store passes them as appraisedLand), recorded before today.
const nearbySales = (pricePerBsf = 150) => ({pricePerBsf, saleCount: 8, withinMiles: 0.6, months: 24, asOf: '2026-09-30'});
const atShareOfNearby = (lot, share, nearby = nearbySales()) => {
  const value = computeDealValuation({...lot, listPrice: null, appraisedLand: nearby}).nearbyLand.value;
  return computeDealValuation({...lot, listPrice: Math.round(share * value), appraisedLand: nearby});
};

test('with nearby development-site sales the tier is the ask against what they sold for on the lot', () => {
  assert.deepEqual([0.6, 0.7, 0.8, 0.85, 0.95, 1, 1.2].map(share => atShareOfNearby(vacantLot, share).dealVerdict),
    ['great_deal', 'great_deal', 'good_deal', 'good_deal', 'fair_deal', 'fair_deal', 'full_price']);
  const good = atShareOfNearby(vacantLot, 0.8);
  assert.deepEqual(good.dealTierBasis, {basis: 'nearby', askToNearby: 0.8, thresholds: NEARBY_PRICE_TIERS});
  assert.equal(good.nearbyLand.value, 150 * good.maxStandardZfa);
  // Great and Good still need the unused floor area they need today.
  const built = atShareOfNearby({...vacantLot, bldgArea: good.buildableZfa - 800, unitsRes: 0, bldgClass: 'K1'}, 0.6);
  assert.equal(built.priceVerdict, 'good_deal', '800 SF unused is enough for Good, not Great');
  // Without nearby sales the residual sets the tier as before.
  const residual = computeDealValuation({...vacantLot, listPrice: 800_000});
  assert.deepEqual([residual.dealVerdict, residual.dealTierBasis, residual.nearbyLand], ['great_deal', {basis: 'residual', askToNearby: null, thresholds: null}, null]);
});

test('on the nearby price the residual is the developer check: a note, and no tier when nothing pencils', () => {
  // Nearby sites sold far above what a developer earning the target returns could pay here: the ask at
  // 60% of them is Great on the market, and the returns short of it are a note, not a cap.
  const dear = atShareOfNearby(vacantLot, 0.6, nearbySales(2000));
  assert.equal(dear.dealVerdict, 'great_deal');
  assert.deepEqual(dear.gates.filter(g => g.id === 'returns').map(g => g.severity), ['review']);
  // A building that costs more than it is worth: no tier at any ask (settled Q3), nearby sales or not.
  const lowDensity = {lotArea: 4000, lotFront: 40, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 0.5, affResFar: 0.5, zoningDistrict: 'R2', address: '3 EXAMPLE ROAD', borough: 'SI', zipCode: '10309', settings: OWN_COSTS};
  const infeasible = atShareOfNearby(lowDensity, 0.5);
  assert.equal(infeasible.infeasibleAtTarget, true);
  assert.deepEqual([infeasible.priceVerdict, infeasible.dealVerdict, infeasible.dealTierBasis], [null, null, null]);
  const note = infeasible.gates.find(g => g.id === 'infeasible');
  assert.deepEqual([note.severity, note.label], ['restrict', "Doesn't pencil at target returns"]);
  assert.match(note.detail, /no deal tier applies at any ask/);
  assert.match(note.detail, /market context only while nothing pencils/);
  // An ask under a fifth of the nearby price may not buy the whole lot: held at Fair, as against the residual.
  const share = atShareOfNearby(vacantLot, 0.15);
  assert.deepEqual([share.priceVerdict, share.dealVerdict], ['great_deal', 'fair_deal']);
  assert.match(share.gates.find(g => g.id === 'data_price_vs_land').detail, /under a fifth of the \$[\d,]+ nearby development sites sold for/);
  // A nominal ask (under $1 a buildable SF) prices nothing, nearby sales or not.
  assert.equal(computeDealValuation({...vacantLot, listPrice: 1, appraisedLand: nearbySales()}).dealVerdict, 'unmatched_parcel');
  // Risk gates cap as before: a flood zone holds Great at Good.
  assert.equal(atShareOfNearby({...vacantLot, inFloodZone: true}, 0.6).dealVerdict, 'good_deal');
  // No residential use as of right: no tier, nearby sales or not.
  const manufacturing = {listPrice: 828_000, lotArea: 57_000, lotFront: 200, lotDepth: 285, lotTypeCode: '3', bldgArea: 0, bldgClass: 'G7', residFar: 0, affResFar: 0, commFar: 1, facilFar: 2.4, mnfFar: 1, zoningDistrict: 'M1-1', address: '4 EXAMPLE AVENUE', borough: 'BK', zipCode: '11208'};
  const barred = computeDealValuation({...manufacturing, appraisedLand: nearbySales()});
  assert.deepEqual([barred.dealVerdict, barred.dealTierBasis], [null, null]);
});

test('unknown tenant or flood risk caps the tier at Good and is flagged unverified', () => {
  const cheap = {...vacantLot, listPrice: 800_000};
  assert.equal(computeDealValuation(cheap).dealVerdict, 'great_deal');

  const tenants = computeDealValuation({...cheap, rentStabilizationRisk: 'unknown'});
  assert.equal(tenants.dealVerdict, 'good_deal');
  assert.equal(tenants.priceVerdict, 'great_deal');
  assert.deepEqual(tenants.gates.map(g => [g.id, g.severity, g.unverified]), [['tenants_unknown', 'review', true]]);

  const flood = computeDealValuation({...cheap, inFloodZone: null});
  assert.equal(flood.dealVerdict, 'good_deal');
  assert.deepEqual(flood.gates.map(g => [g.id, g.severity, g.unverified]), [['flood_unknown', 'review', true]]);

  // Known-clear evidence is not capped: low tenant risk and a checked dry parcel stay Great.
  assert.equal(computeDealValuation({...cheap, rentStabilizationRisk: 'low', inFloodZone: false}).dealVerdict, 'great_deal');
});

test('the store reads flood zones from PLUTO and backfills parcels matched before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-deal-valuation-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, units_res, year_built, first_seen_at, last_seen_at)
      VALUES ('a', 'for_sale', '2 Example Ave', '11216', 'BK', '3000010001', 800000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 0, 2020, 1, 1),
             ('b', 'for_sale', '4 Example Ave', '11216', 'BK', '3000010002', 800000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 0, 2020, 1, 1)`).run();
    const queries = [];
    const {updated} = await store.backfillFloodZones({plutoFetcher: async where => {
      queries.push(where);
      return [{bbl: '3000010001.00000000', pfirm15_flag: '1'}, {bbl: '3000010002.00000000'}];
    }});
    assert.equal(updated, 2);
    assert.match(queries[0], /bbl in \('3000010001', '3000010002'\)/);
    assert.equal((await store.backfillFloodZones({plutoFetcher: async () => { throw new Error('nothing left to fetch'); }})).updated, 0);

    store.revalueDealsWithSettings();
    const [flooded, dry] = ['a', 'b'].map(id => store.searchDeals({listingId: id})[0]);
    assert.equal(flooded.floodZone, true);
    assert.equal(flooded.flashcardValuation.dealVerdict, 'good_deal');
    assert.equal(dry.floodZone, false);
    assert.equal(dry.flashcardValuation.dealVerdict, 'great_deal');
    const stored = store.one('SELECT price_per_buildable_sf, deal_verdict FROM market_listings WHERE id = ?', 'a');
    assert.equal(stored.price_per_buildable_sf, flooded.pricePerBuildableSf);
    assert.equal(stored.deal_verdict, 'good_deal');
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a parcel whose flood zone was never checked is unverified in the store, not dry', () => {
  const store = new MarketStore(':memory:');
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, units_res, year_built, first_seen_at, last_seen_at)
      VALUES ('unchecked', 'for_sale', '2 Example Ave', '11216', 'BK', '3000010001', 800000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 0, 2020, 1, 1)`).run();
    store.revalueDealsWithSettings();
    const [deal] = store.searchDeals({listingId: 'unchecked'});
    assert.equal(deal.floodZone, null);
    assert.equal(deal.flashcardValuation.priceVerdict, 'great_deal');
    assert.equal(deal.flashcardValuation.dealVerdict, 'good_deal');
    assert.ok(deal.flashcardValuation.gates.some(g => g.id === 'flood_unknown' && g.unverified === true));
  } finally {
    store.close();
  }
});

test('a 421-a building built in 2000 with stabilized units on its DOF statement screens high and holds at Fair', () => {
  const store = new MarketStore(':memory:');
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, units_res, year_built,
      flood_zone, rent_stabilized_units, rent_stabilized_year, first_seen_at, last_seen_at)
      VALUES ('benefit', 'for_sale', '2 Example Ave', '11216', 'BK', '3000010001', 800000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 10, 2000, 0, 4, 2024, 1, 1),
             ('newer', 'for_sale', '4 Example Ave', '11216', 'BK', '3000010002', 800000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 10, 2000, 0, NULL, NULL, 1, 1)`).run();
    store.revalueDealsWithSettings();
    const [benefit, newer] = ['benefit', 'newer'].map(id => store.searchDeals({listingId: id})[0]);
    assert.equal(benefit.rentStabilization.riskLevel, 'high');
    assert.equal(benefit.flashcardValuation.priceVerdict, 'great_deal');
    assert.equal(benefit.flashcardValuation.dealVerdict, 'fair_deal');
    assert.ok(benefit.flashcardValuation.gates.some(g => g.id === 'tenants' && g.severity === 'restrict'));
    // Without a registered count the same post-1974 building is a multiple dwelling to check, held at Good.
    assert.equal(newer.rentStabilization.riskLevel, 'moderate');
    assert.equal(newer.flashcardValuation.dealVerdict, 'good_deal');
  } finally {
    store.close();
  }
});

// A vacant 100 by 100 ft lot in a mapped MIH area; the area record is what the store keeps per parcel.
const mihLot = {...vacantLot, listPrice: 6_000_000, lotArea: 10000, lotFront: 100, settings: {hardCostPerGrossSqft: 150}};
const mihArea = options => ({name: 'Example Rezoning', projectId: 'P2018K0001', ulurp: '180001ZMK', adopted: '2018-01-31', borough: '3', communityDistrict: 8, options});

test('inside an MIH area the UAP is unavailable and the whole building carries the mapped set-aside', () => {
  const outside = computeDealValuation({...mihLot, inMihArea: false});
  const inside = computeDealValuation({...mihLot, inMihArea: true, mihArea: mihArea(['option1'])});
  assert.equal(outside.mih.status, 'outside');
  assert.ok(['standard', 'uap'].includes(outside.valueDriver.program));
  assert.equal(inside.valueDriver.program, 'option1');
  assert.equal(inside.valueDriver.buildableZfa, inside.achievableUapZfa);
  assert.equal(inside.valueDriver.affordableZfa, Math.round(inside.buildableZfa * 0.25));
  assert.deepEqual([inside.mih.status, inside.mih.appliedOption, inside.mih.affordableShare, inside.mih.amiPct], ['inside', 'Option 1', 0.25, 60]);
  assert.ok(inside.goodDealMaxLandValue < outside.goodDealMaxLandValue, 'the set-aside costs land value the market-rate building earned');
  assert.ok(inside.basis.some(b => b.item === 'mandatoryInclusionaryHousing'));
  // A parcel not yet checked keeps the affordability preference and says so.
  const unchecked = computeDealValuation(mihLot);
  assert.equal(unchecked.mih.status, 'unchecked');
  assert.equal(unchecked.goodDealMaxLandValue, outside.goodDealMaxLandValue);
});

test('with several mapped options the valuation takes the least restrictive and names it', () => {
  const single = ['option1', 'option3'].map(key => computeDealValuation({...mihLot, inMihArea: true, mihArea: mihArea([key])}));
  const both = computeDealValuation({...mihLot, inMihArea: true, mihArea: mihArea(['option1', 'option3'])});
  const best = single.reduce((a, b) => (b.goodDealMaxLandValue > a.goodDealMaxLandValue ? b : a));
  assert.equal(both.goodDealMaxLandValue, best.goodDealMaxLandValue);
  assert.equal(both.mih.appliedOption, best.mih.appliedOption);
  assert.match(both.mih.note, new RegExp(`Priced on ${best.mih.appliedOption}, the least restrictive .*\\(Option 1, Option 3\\)`));
});

test('a small MIH-area building can take the exemption, held for review of the lot history', () => {
  const v = computeDealValuation({...vacantLot, lotArea: 2000, lotFront: 20, listPrice: 400_000, inMihArea: true, mihArea: mihArea(['option1'])});
  assert.ok(v.buildableZfa <= 12_500);
  assert.equal(v.valueDriver.program, 'mih_exempt');
  assert.equal(v.valueDriver.affordableZfa, 0);
  assert.equal(v.mih.appliedOption, 'Small-project exemption');
  assert.match(v.gates.find(g => g.id === 'mih_exemption').detail, /existed when Example Rezoning was mapped \(2018-01-31\)/);
  assert.notEqual(v.dealVerdict, 'great_deal');
});

test('an option scaled down from the full building rounds its storeys up, so every storey fits the lot', () => {
  const v = computeDealValuation({...vacantLot, lotArea: 12000, lotFront: 120, lotDepth: 100, lotTypeCode: '3', listPrice: 3_000_000, inMihArea: true, mihArea: mihArea(['option1']), withCandidates: true});
  const full = v.candidates.find(c => c.key !== 'mih_exempt' && c.storeys > 1), exempt = v.candidates.find(c => c.key === 'mih_exempt');
  assert.ok(full && exempt, JSON.stringify(v.candidates.map(c => [c.key, c.zfa, c.storeys])));
  assert.ok(exempt.zfa / exempt.storeys <= full.zfa / full.storeys, `${exempt.zfa} SF on ${exempt.storeys} storeys is larger per storey than the full building's`);
});

test('the MIH-exempt building on a large lot stays under both thresholds and fits the envelope storey by storey', () => {
  // A 120 by 100 ft corner lot whose full building is far over the exemption: the exempt one is cut from it.
  const v = computeDealValuation({...vacantLot, lotArea: 12000, lotFront: 120, lotDepth: 100, lotTypeCode: '3', listPrice: 8_000_000, inMihArea: true, mihArea: mihArea(['option1', 'option3']), withCandidates: true});
  const exempt = v.candidates.filter(c => c.key === 'mih_exempt');
  assert.ok(exempt.length >= 2, 'priced as a condo and as a rental');
  const full = v.candidates.find(c => c.key === 'option1');
  for (const c of exempt) {
    assert.ok(c.zfa <= 12_500 && c.units <= 10, `${c.id}: ${c.zfa} SF and ${c.units} units, at or under both exemption thresholds`);
    assert.ok(c.zfa / c.storeys <= full.zfa / full.storeys, `${c.id}: ${c.storeys} storeys keep each floor within the envelope's average floor`);
    assert.ok(c.zfa / c.storeys < 12000, 'never one storey larger than the lot');
  }
});

test('the store places matched parcels in or out of MIH areas, revalues them and filters on it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-deal-mih-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, first_seen_at, last_seen_at)
      VALUES ('in', 'for_sale', '2 Example Ave', '11216', 'BK', '3000010001', 6000000, 10000, 100, 100, '5', 0, 4, 5.01, 'R7A', 1, 1),
             ('out', 'for_sale', '4 Example Ave', '11216', 'BK', '3000010002', 6000000, 10000, 100, 100, '5', 0, 4, 5.01, 'R7A', 1, 1)`).run();
    const area = {...mihArea(['option1', 'option2']), polygons: [[[[-73.95, 40.68], [-73.94, 40.68], [-73.94, 40.69], [-73.95, 40.69], [-73.95, 40.68]]]], box: {west: -73.95, east: -73.94, south: 40.68, north: 40.69}};
    const plutoFetcher = async () => [
      {bbl: '3000010001.00000000', latitude: '40.685', longitude: '-73.945'},
      {bbl: '3000010002.00000000', latitude: '40.70', longitude: '-73.945'},
    ];
    const now = Date.parse('2026-10-18');
    assert.deepEqual(await store.assignMihAreas({plutoFetcher, mihAreasFetcher: async () => [area], now}), {checked: 2, inside: 1});
    const unreachable = async () => { throw new Error('checked this month'); };
    assert.deepEqual(await store.assignMihAreas({plutoFetcher: unreachable, mihAreasFetcher: unreachable, now: now + 86_400_000}), {checked: 0, inside: 0});

    const [inside] = store.searchDeals({mihArea: 'inside', minUnusedZfa: 0});
    assert.equal(inside.id, 'in');
    assert.equal(inside.inMihArea, true);
    assert.equal(inside.flashcardValuation.mih.area, 'Example Rezoning');
    assert.deepEqual(inside.flashcardValuation.mih.mappedOptions, ['Option 1', 'Option 2']);
    assert.ok(!['standard', 'uap'].includes(inside.flashcardValuation.valueDriver.program));
    assert.deepEqual(store.searchDeals({mihArea: 'outside', minUnusedZfa: 0}).map(d => d.id), ['out']);
    const stored = store.one('SELECT deal_verdict, price_per_buildable_sf FROM market_listings WHERE id = ?', 'in');
    assert.equal(stored.price_per_buildable_sf, inside.pricePerBuildableSf);
    assert.equal(stored.deal_verdict, inside.flashcardValuation.dealVerdict);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

// PLUTO still gives R6 the height-factor maximum of 2.43; the current text sets 2.2, or 3.0 within
// 100 ft of a wide street.
test('a curated district sets the residential FAR, with its wide-street row on a wide front street', () => {
  const pluto = {zoningDistrict: 'R6', residFar: 2.43, affResFar: 3.9};
  assert.deepEqual(residentialFarFor(pluto), {residFar: 2.2, affResFar: 3.9, source: 'zoning_rules'});
  assert.deepEqual(residentialFarFor({...pluto, frontStreetFeet: 60}), {residFar: 2.2, affResFar: 3.9, source: 'zoning_rules'});
  assert.deepEqual(residentialFarFor({...pluto, frontStreetFeet: 80}), {residFar: 3, affResFar: 3.9, wideStreetShare: 1, source: 'zoning_rules_wide_street'});
  // A corner lot takes the wide-street row from a wide side street too, and so do R7-1/R7-2 (4.0 within 100 ft).
  assert.deepEqual(residentialFarFor({...pluto, frontStreetFeet: 60, sideStreetFeet: 80}), {residFar: 3, affResFar: 3.9, wideStreetShare: 1, source: 'zoning_rules_wide_street'});
  for (const zoningDistrict of ['R7-1', 'R7-2']) {
    assert.deepEqual(residentialFarFor({zoningDistrict, residFar: 3.44, affResFar: 5.01, frontStreetFeet: 60}), {residFar: 3.44, affResFar: 5.01, source: 'zoning_rules'});
    assert.deepEqual(residentialFarFor({zoningDistrict, residFar: 3.44, affResFar: 5.01, frontStreetFeet: 60, sideStreetFeet: 100}), {residFar: 4, affResFar: 5.01, wideStreetShare: 1, source: 'zoning_rules_wide_street'});
  }
  // R6A has one FAR on any street.
  assert.equal(residentialFarFor({zoningDistrict: 'R6A', residFar: 3, affResFar: 3.9, frontStreetFeet: 100}).residFar, 3);
});

test('the wide-street FAR covers only the part of the lot within 100 ft of the wide street, as the envelope weighs it', () => {
  const r6 = {zoningDistrict: 'R6', residFar: 2.43, affResFar: 3.9};
  // 50 by 100: wholly within 100 ft of the wide front street.
  assert.deepEqual(residentialFarFor({...r6, frontStreetFeet: 80, lotFront: 50, lotDepth: 100}), {residFar: 3, affResFar: 3.9, wideStreetShare: 1, source: 'zoning_rules_wide_street'});
  // 50 by 150: two thirds at 3.0, the rest at 2.2 (ZR 23-22, 77-22).
  const deep = residentialFarFor({...r6, frontStreetFeet: 80, lotFront: 50, lotDepth: 150});
  assert.deepEqual(deep, {residFar: Number((3 * 2 / 3 + 2.2 / 3).toFixed(3)), affResFar: 3.9, wideStreetShare: 0.667, source: 'zoning_rules_wide_street'});
  // A corner lot 200 ft along a narrow front street with a wide side street: the 100 ft column along the side street.
  assert.equal(residentialFarFor({zoningDistrict: 'R7-1', residFar: 3.44, affResFar: 5.01, frontStreetFeet: 60, sideStreetFeet: 100, lotFront: 200, lotDepth: 100}).residFar, Number((4 * 0.5 + 3.44 * 0.5).toFixed(3)));
  // The same figure the envelope computes on the same rectangle.
  for (const [code, front, depth, frontages] of [['R8', 50, 150, [{side: 'front', widthFeet: 100}]], ['R7-1', 150, 100, [{side: 'front', widthFeet: 60}, {side: 'left', widthFeet: 100}]], ['R6', 40, 230, [{side: 'front', widthFeet: 80}]]]) {
    const envelope = computeEnvelope({rules: ZONING_RULES, district: describeDistrict(code), lot: [[0, 0], [front, 0], [front, depth], [0, depth]], frontages, use: 'residential'});
    const side = frontages.find(f => f.side === 'left');
    assert.equal(residentialFarFor({zoningDistrict: code, residFar: 0, affResFar: 0, frontStreetFeet: frontages[0].widthFeet, sideStreetFeet: side?.widthFeet ?? null, lotFront: front, lotDepth: depth}).residFar, envelope.floorArea.maxFar, code);
  }
  // The buildable area follows: a deep lot on a wide street prices less floor area than the whole-lot row gave.
  const lot = {listPrice: null, lotArea: 7500, lotFront: 50, lotDepth: 150, lotTypeCode: '5', bldgArea: 0, residFar: 2.43, affResFar: 3.9, zoningDistrict: 'R6', borough: 'BK', zipCode: '11216', frontStreetFeet: 80};
  assert.equal(computeDealValuation(lot).maxStandardZfa, Math.round(7500 * deep.residFar));
});

test('a commercial district takes its residential equivalent\'s wide-street row, and R8\'s 8.64 holds only outside MIH areas', () => {
  const wide = {residFar: 0, affResFar: 0, frontStreetFeet: 100, lotFront: 50, lotDepth: 100};
  assert.deepEqual(residentialFarFor({...wide, zoningDistrict: 'C6-2'}), {residFar: 7.2, affResFar: 8.64, wideStreetShare: 1, source: 'zoning_rules_wide_street'});
  assert.deepEqual(residentialFarFor({...wide, zoningDistrict: 'C6-1'}), {residFar: 4, affResFar: 5.01, wideStreetShare: 1, source: 'zoning_rules_wide_street'});
  // ZR 23-22 note 2: the 8.64 is for UAP developments outside Mandatory Inclusionary Housing areas.
  assert.deepEqual(residentialFarFor({...wide, zoningDistrict: 'R8', inMihArea: true}), {residFar: 7.2, affResFar: 7.2, wideStreetShare: 1, source: 'zoning_rules_wide_street'});
  assert.equal(residentialFarFor({...wide, zoningDistrict: 'R8', inMihArea: false}).affResFar, 8.64);
});

test('PLUTO keeps the FAR of districts the curated table does not name exactly', () => {
  // A suffixed district is not its base district: a commercial one ZR 34-112 names takes its own residential
  // equivalent (C6-3X is R9X, not C6-3's R9), one it does not name keeps PLUTO, and a paired MX district carries
  // its residential FAR in PLUTO.
  assert.deepEqual(residentialFarFor({zoningDistrict: 'C6-3X', residFar: 8, affResFar: 9}), {residFar: 9, affResFar: 10.8, source: 'zoning_rules'});
  assert.deepEqual(residentialFarFor({zoningDistrict: 'C6-2M', residFar: 6.02, affResFar: 7.2}), {residFar: 6.02, affResFar: 7.2, source: 'pluto'});
  assert.deepEqual(residentialFarFor({zoningDistrict: 'M1-5/R7X', residFar: 5, affResFar: 6}), {residFar: 5, affResFar: 6, source: 'pluto'});
  // A curated district without residential floor area leaves PLUTO's zero, so the lot stays unrated.
  assert.deepEqual(residentialFarFor({zoningDistrict: 'M1-5', residFar: 0, affResFar: 0}), {residFar: 0, affResFar: 0, source: 'pluto'});
  assert.equal(computeDealValuation({...vacantLot, zoningDistrict: 'M1-5', residFar: 0, affResFar: 0, commFar: 5}).maxStandardZfa, 0);
});

test('the standard buildable area uses the current R6 FAR rather than PLUTO', () => {
  const r6 = {listPrice: 1_950_000, lotArea: 5300, lotFront: 25, lotDepth: 212, lotTypeCode: '5', bldgArea: 0, residFar: 2.43, affResFar: 3.9, zoningDistrict: 'R6', address: '3 EXAMPLE STREET', borough: 'BK', zipCode: '11225'};
  const narrow = computeDealValuation(r6);
  assert.equal(narrow.standardFar, 2.2);
  assert.equal(narrow.maxStandardZfa, 11660);
  assert.equal(narrow.farSource, 'zoning_rules');
  // On a wide street the 3.0 covers the first 100 ft of the 212 ft depth and 2.2 the rest (ZR 23-22, 77-22).
  const wide = computeDealValuation({...r6, frontStreetFeet: 100});
  assert.equal(wide.standardFar, Number((3 * 100 / 212 + 2.2 * 112 / 212).toFixed(3)));
  assert.equal(wide.maxStandardZfa, Math.round(5300 * wide.standardFar));
  assert.equal(wide.farSource, 'zoning_rules_wide_street');
});

test('the store reads front street widths for wide-street districts and revalues those listings', async () => {
  const store = new MarketStore(':memory:');
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, pluto_address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, first_seen_at, last_seen_at)
      VALUES ('wide', 'for_sale', '5 Example Ave', '5 EXAMPLE AVENUE', '11225', 'BK', '3000020001', 2000000, 5000, 50, 100, '5', 0, 2.43, 3.9, 'R6', 1, 1),
             ('narrow', 'for_sale', '7 Example St', '7 EXAMPLE STREET', '11225', 'BK', '3000020002', 2000000, 5000, 50, 100, '5', 0, 2.43, 3.9, 'R6', 1, 1),
             ('contextual', 'for_sale', '9 Example St', '9 EXAMPLE STREET', '11225', 'BK', '3000020003', 2000000, 5000, 50, 100, '5', 0, 3, 3.9, 'R6A', 1, 1)`).run();
    const asked = [];
    const lookup = async ({bbl, address}) => {
      asked.push(address);
      return {streets: [{side: 'front', name: address.replace(/^\d+ /, ''), widthFeet: bbl === '3000020001' ? 100 : 60}]};
    };
    assert.deepEqual(await store.backfillFrontStreets({lookup}), {checked: 2, wide: 1});
    assert.deepEqual(asked.sort(), ['5 EXAMPLE AVENUE', '7 EXAMPLE STREET']);
    assert.deepEqual(await store.backfillFrontStreets({lookup: async () => { throw new Error('already read'); }}), {checked: 0, wide: 0});
    const zfa = id => store.one('SELECT max_standard_zfa FROM market_listings WHERE id = ?', id).max_standard_zfa;
    assert.equal(zfa('wide'), 15000);
    assert.equal(zfa('narrow'), 11000);
    // Revaluing again keeps the stored width.
    store.revalueDealsWithSettings();
    assert.equal(zfa('wide'), 15000);
  } finally {
    store.close();
  }
});

test('the tier never reads better than the yield or margin the ask supports', () => {
  // A low-density lot whose building costs more than it is worth: no program pays anything for the
  // land even at the lowest return targets, so the site is infeasible — no tier, no thresholds.
  const lowDensity = {listPrice: 30_000, lotArea: 4000, lotFront: 40, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 0.5, affResFar: 0.5, zoningDistrict: 'R2', address: '3 EXAMPLE ROAD', borough: 'SI', zipCode: '10309'};
  const v = computeDealValuation({...lowDensity, settings: OWN_COSTS});
  assert.ok(v.impliedCondoMargin < 0);
  assert.equal(v.infeasibleAtTarget, true);
  assert.deepEqual([v.greatDealMaxBsf, v.goodDealMaxBsf, v.badDealMinBsf, v.greatDealMaxLandValue, v.goodDealMaxLandValue, v.badDealMinLandValue], [null, null, null, null, null, null]);
  assert.equal(v.priceVerdict, null);
  assert.equal(v.dealVerdict, null);
  assert.ok(v.valueDriver.landValue <= 0, 'the best residual is not positive');
  assert.ok(v.gates.some(g => g.id === 'infeasible' && /Doesn't pencil/.test(g.label)));

  // Across lots, costs and asks, each tier implies its own yield or margin target at the ask.
  const S = DEFAULT_NYC_DEV_SETTINGS;
  const targets = {great_deal: [S.greatDealCapRate, S.greatDealCondoMargin], good_deal: [S.goodDealCapRate, S.goodDealCondoMargin], fair_deal: [S.badDealCapRate, S.badDealCondoMargin]};
  const seen = new Set();
  for (const lot of [lowDensity, vacantLot, narrowTownhouse]) {
    for (const hardCostPerGrossSqft of [250, 375, 600]) {
      for (let ask = 20_000; ask < 40_000_000; ask *= 1.3) {
        const r = computeDealValuation({...lot, listPrice: Math.round(ask), settings: {hardCostPerGrossSqft}});
        seen.add(r.dealVerdict);
        // On the land value basis each threshold is its tier's own land value, so the price never earns a tier its returns miss.
        if (r.dealTierBasis?.basis === 'residual') assert.deepEqual(r.gates.filter(g => g.id === 'returns').map(g => g.label), [], `${lot.zoningDistrict} at $${Math.round(ask)}, $${hardCostPerGrossSqft} hard cost`);
        const target = targets[r.dealVerdict];
        if (!target) continue;
        // Per-BSF rounding leaves the returns a hair under the target at a threshold.
        assert.ok(r.impliedYieldOnCost >= target[0] * 100 - 0.05 || r.impliedCondoMargin >= target[1] * 100 - 0.2,
          `${lot.zoningDistrict} at $${Math.round(ask)}: ${r.dealVerdict} with ${r.impliedYieldOnCost}% yield, ${r.impliedCondoMargin}% margin`);
      }
    }
  }
  assert.ok(seen.has('great_deal') && seen.has('full_price'));
});

test('a tier states a threshold and land value only from its own positive land value', () => {
  // At a $450 hard cost the great-deal margin leaves nothing for the land while Good and Fair still pay for
  // it: Great has no threshold, never a floored $25, and Good is its own land value, never a spread above Great.
  const costs = {hardCostPerGrossSqft: 450};
  const v = computeDealValuation({...vacantLot, settings: costs});
  assert.equal(v.infeasibleAtTarget, false);
  assert.deepEqual([v.greatDealMaxBsf, v.greatDealMaxLandValue, v.thresholdBasis.great], [null, null, null]);
  assert.equal(v.goodDealMaxBsf, Math.round(askForLandValue(v.valueDriver.landValue, false) / v.thresholdBasis.good.buildableZfa));
  assert.ok(v.goodDealMaxLandValue <= v.valueDriver.landValue, 'Good never states more than its own land value');
  assert.ok(v.badDealMinLandValue >= v.goodDealMaxLandValue);
  // An ask under the old $25 floor is judged against what each tier earns: Good, with no hold.
  const cheap = computeDealValuation({...vacantLot, listPrice: 20 * v.buildableZfa, settings: costs});
  assert.equal(cheap.priceVerdict, 'good_deal');
  assert.deepEqual(cheap.gates.filter(g => g.id === 'returns'), []);
});

test('a lot that allows no residential use is not valued as a residential building', () => {
  const manufacturing = {listPrice: 828_000, lotArea: 57_000, lotFront: 200, lotDepth: 285, lotTypeCode: '3', bldgArea: 0, bldgClass: 'G7', residFar: 0, affResFar: 0, commFar: 1, facilFar: 2.4, mnfFar: 1, zoningDistrict: 'M1-1', address: '4 EXAMPLE AVENUE', borough: 'BK', zipCode: '11208'};
  const v = computeDealValuation(manufacturing);
  assert.equal(v.valueDriver, null);
  assert.deepEqual([v.maxStandardZfa, v.maxUapZfa, v.buildableZfa, v.standardFar, v.uapFar], [0, 0, 0, 0, 0]);
  assert.equal(v.maxBuildableUnits, null, 'no residential unit count');
  assert.equal(v.impliedYieldOnCost, null);
  assert.equal(v.dealVerdict, null);
  assert.equal(v.priceVerdict, null);
  assert.equal(v.corridorProfile.groundFloorRetailSqft, 0);
  assert.equal(v.corridorProfile.hasRetailUplift, false);
  assert.deepEqual(v.gates.map(g => g.id), ['no_residential']);
  // The other uses' ceiling stays visible.
  assert.equal(v.anyUseFar, 2.4);
  assert.equal(v.maxAnyUseZfa, 136_800);
});

test('each envelope reports the FAR that produced it, and retail fits the ground floor', () => {
  // Commercial FAR above residential in a commercial district: the residential building is still priced on
  // the residential FAR, and the bonus on the affordable FAR.
  // C4-4A takes R7A's residential FAR (ZR 34-112), whatever PLUTO says.
  const v = computeDealValuation({...vacantLot, residFar: 3, affResFar: 3.9, commFar: 6, overlay1: null, zoningDistrict: 'C4-4A'});
  assert.deepEqual([v.standardFar, v.uapFar], [4, 5.01]);
  assert.equal(v.maxStandardZfa, Math.round(vacantLot.lotArea * v.standardFar));
  assert.equal(v.maxUapZfa, Math.round(vacantLot.lotArea * v.uapFar));
  assert.equal(v.maxAnyUseZfa, vacantLot.lotArea * 6, 'the commercial FAR stays the any-use ceiling');
  // C6-1 (residential 3.44, commercial 6, affordable 5.01) on a 50 by 100 ft lot: paper residential values.
  const c61 = computeDealValuation({...vacantLot, residFar: 3.44, affResFar: 5.01, commFar: 6, zoningDistrict: 'C6-1'});
  assert.deepEqual([c61.standardFar, c61.uapFar, c61.maxStandardZfa, c61.maxUapZfa], [3.44, 5.01, 17200, 25050]);
  assert.ok(c61.buildableZfa <= 25050);
  assert.equal(c61.physicalEnvelope.paperStandardZfa, 17200);

  const overlay = computeDealValuation({...vacantLot, residFar: 3, affResFar: 3.9, commFar: 2, overlay1: 'C2-4', zoningDistrict: 'R6A'});
  const retail = overlay.corridorProfile.groundFloorRetailSqft;
  assert.ok(retail > 0);
  assert.ok(retail <= overlay.physicalEnvelope.typicalBaseFootprintSqft && retail <= overlay.valueDriver.floorplateSqft, 'retail is at most the ground floor');
  assert.ok(retail < 0.85 * vacantLot.lotArea, 'not 85% of the lot under a yard-limited footprint');
});

test('a ground floor priced as retail holds no apartments, in the planned units, the zoning cap and every scheme', () => {
  const lot = {...vacantLot, listPrice: null, residFar: 3, affResFar: 3.9, zoningDistrict: 'R6A', submarketSalePsf: 1100, submarketSaleSample: {basis: 'closed', count: 40}, submarketRentPsf: 4.5, withCandidates: true};
  const plain = computeDealValuation(lot);
  const shops = computeDealValuation({...lot, commFar: 2, overlay1: 'C2-4'});
  const c = shops.corridorProfile;
  assert.ok(c.hasRetailUplift && c.retailFloorAreaSqft > 0);
  assert.equal(c.groundFloorRetailSqft, Math.round(c.retailFloorAreaSqft * 0.85), 'the shops are the floor less its lobby and core');
  assert.equal(shops.buildableZfa, plain.buildableZfa, 'the building is the same; only its ground floor changes use');
  const residentialZfa = shops.buildableZfa - c.retailFloorAreaSqft;
  assert.equal(shops.plannedUnitBasis.netSellableSqft, Math.round(residentialZfa * shops.valueDriver.netEfficiency));
  assert.equal(shops.maxBuildableUnits, mostUnitsAllowed(residentialZfa), 'the dwelling unit factor counts residential floor area only');
  assert.ok(shops.plannedUnits < plain.plannedUnits && shops.maxBuildableUnits < plain.maxBuildableUnits);
  const units = v => Object.fromEntries(v.candidates.map(x => [x.id, x.units]));
  for (const [id, n] of Object.entries(units(shops))) {
    // The overlay also prices a wholly commercial building, which has no counterpart without the overlay and no apartments either way.
    if (id.startsWith('commercial:')) { assert.equal(n, 0); continue; }
    assert.ok(n < units(plain)[id], `${id}: ${n} with shops, ${units(plain)[id]} without`);
  }
  // No uplift (shop rents under apartment rents) prices the floor as apartments, so it keeps them.
  const lowRent = computeDealValuation({...lot, commFar: 2, overlay1: 'C2-4', submarketRentPsf: 12});
  assert.equal(lowRent.corridorProfile.hasRetailUplift, false);
  assert.equal(lowRent.plannedUnitBasis.netSellableSqft, Math.round(lowRent.buildableZfa * lowRent.valueDriver.netEfficiency));
});

// A small house or unit listed on the tax lot of a whole development: the price buys a fraction of the lot.
const developmentLot = {lotArea: 392_040, lotFront: 25, lotDepth: 29, lotTypeCode: '6', bldgArea: 193_762, bldgClass: 'R3', unitsRes: 158, residFar: 0.75, affResFar: 1, facilFar: 1, zoningDistrict: 'R3-2', overlay1: 'C2-2', borough: 'SI', zipCode: '10314'};

test('an ask far under the land value is held at Fair whatever the listing states, at any costs', () => {
  const costs = [DEFAULT_NYC_DEV_SETTINGS, {...DEFAULT_NYC_DEV_SETTINGS, hardCostPerGrossSqft: 150, softCostPctOfHard: 0.05, greatDealCapRate: 0.04, goodDealCapRate: 0.035, badDealCapRate: 0.03, greatDealCondoMargin: 0.02, goodDealCondoMargin: 0.01, badDealCondoMargin: 0}];
  const lots = [developmentLot, {...vacantLot, lotArea: 60_000, lotFront: 200, lotDepth: 300}, {...vacantLot, zipCode: '11249', submarketSalePsf: 1400, submarketRentPsf: 5.5}];
  for (const settings of costs) {
    for (const lot of lots) {
      const free = computeDealValuation({...lot, listPrice: 1_000_000, settings});
      // Where no program pays for the land at these costs there is no land-value scale to be far
      // under: the site is infeasible and unrated instead, which also keeps it out of Great/Good.
      if (free.infeasibleAtTarget) {
        assert.equal(free.dealVerdict, null, `${lot.zipCode} infeasible`);
        continue;
      }
      // No listed size at all: none of the listing's own checks can fire.
      const ask = Math.floor(LISTING_DATA_CHECKS.priceShare * free.goodDealMaxBsf * free.buildableZfa * 0.9);
      const v = computeDealValuation({...lot, listPrice: ask, settings, dataChecks: listingDataChecks({borough: lot.borough, street_line: '1 Example St'})});
      assert.ok(!['great_deal', 'good_deal'].includes(v.dealVerdict), `${lot.zipCode} ${v.dealVerdict}`);
      const gate = v.gates.find(g => g.id === 'data_price_vs_land');
      assert.ok(gate && gate.severity === 'restrict' && /under a fifth/.test(gate.detail), JSON.stringify(v.gates));
    }
  }
  // A price near the land value is not questioned.
  const fair = computeDealValuation({...vacantLot, listPrice: 800_000});
  assert.ok(!fair.gates.some(g => g.id === 'data_price_vs_land'));
});

test('a house matched to a development lot ranks after every clean listing in best deals', t => {
  const store = new MarketStore(':memory:');
  t.after(() => store.close());
  const insert = store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, street_line, borough, zip_code, bbl, list_price, sqft, lot_sqft,
    pluto_lot_area, pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, facil_far, zoning_district, bldg_class, units_res,
    unused_uap_zfa, first_seen_at, last_seen_at) VALUES (?, 'for_sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10000, 1, 1)`);
  const lot = developmentLot;
  insert.run('house', '14 Example Loop', '14 Example Loop', 'SI', '10314', '5015527501', 579_000, 1480, 780, lot.lotArea, lot.lotFront, lot.lotDepth, '6', lot.bldgArea, lot.residFar, lot.affResFar, lot.facilFar, lot.zoningDistrict, 'R3', 158);
  insert.run('land', '20 Example Loop', '20 Example Loop', 'SI', '10314', '5015520001', 3_500_000, null, null, 20_000, 100, 200, '5', 0, 0.75, 1, 1, 'R3-2', 'V0', 0);
  const verdict = d => d.flashcardValuation.dealVerdict;
  const page = store.searchDealsPage({sortBy: 'best_deal', minUnusedZfa: 0, includeSimilarComps: false});
  assert.deepEqual(page.deals.map(d => d.id), ['land', 'house']);
  const house = page.deals[1];
  assert.deepEqual(page.deals[0].flashcardValuation.gates.filter(g => g.id.startsWith('data_')), [], 'the land listing is clean');
  assert.ok(house.pricePerBuildableSf < page.deals[0].pricePerBuildableSf, 'the house is cheaper per buildable SF');
  assert.ok(!['great_deal', 'good_deal'].includes(verdict(house)));
  // Priced as the whole development lot the site does not pencil at all, so there is no land-value
  // scale for the price check; the size checks and infeasibility keep it unrated and last.
  assert.equal(verdict(house), null);
  assert.ok(['data_lot_size', 'data_building_size', 'data_large_lot'].every(id => house.flashcardValuation.gates.some(g => g.id === id)));
  assert.ok(house.flashcardValuation.gates.some(g => g.id === 'infeasible'));
});

test('most units allowed divides by the dwelling unit factor, a fraction of three-quarters counting as one', () => {
  assert.equal(mostUnitsAllowed(6800), 10);
  assert.equal(mostUnitsAllowed(680 * 10.74), 10);
  assert.equal(mostUnitsAllowed(680 * 10.75), 11);
  assert.equal(mostUnitsAllowed(500), 0);
});

test('planned units come from sellable area over a typical unit for the exit, under the zoning cap', () => {
  const average = mix => Math.round(mix.reduce((sum, u) => sum + u.share * u.netSqft, 0));
  assert.ok(average(DEAL_UNIT_MIX.rental) < average(DEAL_UNIT_MIX.condo), 'rentals run smaller than condominiums');
  for (const share of ['rental', 'condo']) assert.ok(Math.abs(DEAL_UNIT_MIX[share].reduce((sum, u) => sum + u.share, 0) - 1) < 1e-9);
  const condo = computeDealValuation({...vacantLot, zipCode: '11249', submarketSalePsf: 1400, submarketRentPsf: 3});
  const rental = computeDealValuation({...vacantLot, zipCode: '11249', submarketSalePsf: 500, submarketRentPsf: 6});
  for (const v of [condo, rental]) {
    const b = v.plannedUnitBasis;
    assert.equal(b.exit, v.valueDriver.exit);
    assert.equal(b.netEfficiency, v.valueDriver.netEfficiency);
    assert.equal(b.netSellableSqft, Math.round(v.buildableZfa * v.valueDriver.netEfficiency));
    assert.ok(v.plannedUnits >= 1 && v.plannedUnits <= v.maxBuildableUnits);
    assert.equal(v.maxBuildableUnits, mostUnitsAllowed(v.buildableZfa));
    assert.equal(v.pricePerBuildableUnit, Math.round(vacantLot.listPrice / v.plannedUnits));
  }
  assert.deepEqual([condo.plannedUnitBasis.exit, rental.plannedUnitBasis.exit], ['condo', 'rental']);
  assert.equal(condo.plannedUnitBasis.unitNetSqft, average(DEAL_UNIT_MIX.condo));
  assert.equal(rental.plannedUnitBasis.unitNetSqft, average(DEAL_UNIT_MIX.rental));
  assert.ok(condo.plannedUnits < condo.maxBuildableUnits, 'condominiums plan fewer, larger units than the cap');
  const barred = computeDealValuation({...vacantLot, residFar: 0, affResFar: 0, commFar: 1, zoningDistrict: 'M1-1'});
  assert.deepEqual([barred.maxBuildableUnits, barred.plannedUnits, barred.pricePerBuildableUnit], [null, null, null]);
});

test('the value driver states what its hard cost is built from', () => {
  for (const settings of [undefined, OWN_COSTS]) {
    const d = computeDealValuation({...narrowTownhouse, settings}).valueDriver;
    assert.equal(d.baseHardCostPerGrossSqft, settings ? 380 : d.hardCostTable.perGrossSqft);
    assert.equal(d.heightClassFactor, settings ? DEAL_SCREEN_ASSUMPTIONS.heightClasses.find(c => c.label === d.heightClass).hardCostFactor : 1);
    assert.equal(d.hardCostPerGrossSqft, Math.round(d.baseHardCostPerGrossSqft * d.heightClassFactor * d.narrowLotFactor));
    assert.equal(d.narrowLotFactor, DEAL_SCREEN_ASSUMPTIONS.narrowLotHardCostFactor);
    assert.equal(d.grossFactor, DEFAULT_NYC_DEV_SETTINGS.zfaToGrossFactor);
  }
  // The valuation basis names the published range and its date.
  const basis = computeDealValuation(narrowTownhouse).basis.find(b => b.item === 'hardCost');
  assert.equal(basis.asOf, NYC_HARD_COST.asOf);
  assert.match(basis.source, /Rider Levett Bucknall.*\$260 to \$510.*escalated from July 2026/);
});

test('the deal envelope records what its area rests on: the curated envelope, fallback geometry or paper alone', () => {
  const lot = {lotArea: 5000, lotFront: 50, lotDepth: 100, residFar: 1.25, affResFar: 1.25};
  const r5 = computePhysicalEnvelopeAndDeductions({...lot, zoningDistrict: 'R5'}).physicalEnvelope;
  assert.equal(r5.envelopeBasis, 'curated-envelope');
  // No bonus FAR in R5: the summary names no affordability bonus.
  assert.match(r5.bulkConstraintSummary, /^Full FAR Achievable: 6,250 ZFA fits within the \d+-story 50'×100' interior lot/);
  assert.doesNotMatch(r5.bulkConstraintSummary, /UAP/);
  const uncurated = computePhysicalEnvelopeAndDeductions({...lot, zoningDistrict: 'C8-2'}).physicalEnvelope;
  assert.equal(uncurated.envelopeBasis, 'fallback-geometry');
  assert.match(uncurated.bulkConstraintSummary, /fallback geometry, no curated envelope for this district/);
  // A 25 by 29 ft frontage and depth on a 392,040 sq ft lot draws nothing that stands for the lot.
  const mismatched = computePhysicalEnvelopeAndDeductions({...lot, lotArea: 392_040, lotFront: 25, lotDepth: 29, zoningDistrict: 'R3-2', residFar: 0.75, affResFar: 1}).physicalEnvelope;
  assert.equal(mismatched.envelopeBasis, 'paper-only');
  assert.equal(mismatched.achievableUapZfa, mismatched.paperUapZfa);
  assert.match(mismatched.bulkConstraintSummary, /^Paper UAP ZFA only: no envelope could be drawn/);
  assert.equal(computeDealValuation({...vacantLot, listPrice: 800_000}).physicalEnvelope.envelopeBasis, 'curated-envelope');
});

test('a guessed street width ignores the house number and the commercial overlay, and says it was guessed', () => {
  const street = args => computePhysicalEnvelopeAndDeductions({lotArea: 2500, lotFront: 25, lotDepth: 100, residFar: 3, affResFar: 3.9, zoningDistrict: 'R6A', ...args}).physicalEnvelope;
  assert.deepEqual(['streetType', 'streetBasis'].map(k => street({address: '14 MAIN STREET'})[k]), ['narrow', 'heuristic']);
  assert.equal(street({address: '7 EXAMPLE STREET', overlay1: 'C2-4'}).streetType, 'narrow');
  assert.equal(street({address: '210 WEST 14 STREET'}).streetType, 'wide');
  assert.equal(street({address: '14-20 31 AVENUE'}).streetType, 'wide');
  // A mapped width always wins over the name.
  assert.deepEqual(['streetType', 'streetBasis'].map(k => street({address: '14 MAIN STREET', frontStreetFeet: 100})[k]), ['wide', 'mapped']);
  assert.equal(street({address: '5 EXAMPLE AVENUE', frontStreetFeet: 60}).streetType, 'narrow');
});

test('affordable floor area is the area above the standard paper maximum, never the gap to the standard envelope', () => {
  // R9A, 20 by 40 ft: the standard envelope holds 5,955 sq ft of the 6,016 sq ft allowance, the affordable
  // one all 7,216. The bonus is 7,216 less 6,016 = 1,200 sq ft, (9.02 - 7.52) x 800, not 7,216 less 5,955.
  const v = computeDealValuation({listPrice: 1_500_000, lotArea: 800, lotFront: 20, lotDepth: 40, lotTypeCode: '5', bldgArea: 0, residFar: 7.52, affResFar: 9.02, zoningDistrict: 'R9A', address: '1 EXAMPLE STREET', borough: 'MN', zipCode: '10003', settings: {hardCostPerGrossSqft: 100}});
  assert.deepEqual([v.maxStandardZfa, v.achievableStandardZfa, v.achievableUapZfa], [6016, 5955, 7216]);
  assert.equal(v.valueDriver.program, 'uap');
  assert.equal(v.valueDriver.affordableZfa, 1200);
  // An affordable envelope that clears the standard envelope only through its taller heights, and stays under
  // the standard allowance, earns no bonus: no affordability program is priced and the note says why.
  const heightsOnly = computeDealValuation({listPrice: 6_000_000, lotArea: 3600, lotFront: 60, lotDepth: 60, lotTypeCode: '5', bldgArea: 0, residFar: 9, affResFar: 9.45, zoningDistrict: 'C6-2X', frontStreetFeet: 60, address: '1 EXAMPLE STREET', borough: 'MN', zipCode: '10003', settings: {hardCostPerGrossSqft: 100}});
  assert.ok(heightsOnly.achievableUapZfa > heightsOnly.achievableStandardZfa && heightsOnly.achievableUapZfa <= heightsOnly.maxStandardZfa);
  assert.ok(heightsOnly.rentalSchemes.every(s => s.program === 'standard'));
  assert.equal(heightsOnly.valueDriver.affordableZfa, 0);
  assert.match(heightsOnly.affordableBonusNote, /only through its taller heights .* earns no bonus floor area/);
});

test('headroom is the lead building\'s unused floor area, the figure the tier is judged on', () => {
  // The standard program leads; the affordable envelope is larger, so its unused area is not the headroom.
  const v = computeDealValuation({...vacantLot, listPrice: 400_000, bldgArea: 19_200});
  assert.equal(v.valueDriver.program, 'standard');
  assert.equal(v.unusedForLeadZfa, v.buildableZfa - 19_200);
  assert.equal(v.unusedForLeadZfa, 800);
  assert.ok(v.unusedUapZfa > v.unusedForLeadZfa);
  // 800 sq ft clears the 500 sq ft Good condition and not the 1,000 sq ft Great one, whatever the price.
  assert.ok(v.pricePerBuildableSf <= v.greatDealMaxBsf);
  assert.equal(v.priceVerdict, 'good_deal');
});

test('completed value follows the exit that sets the value, with both exits kept apart', () => {
  const carry = DEFAULT_NYC_DEV_SETTINGS.carryAndFinancingPct;
  const rental = computeDealValuation({...vacantLot, zipCode: '11249', submarketSalePsf: 500, submarketRentPsf: 6});
  assert.equal(rental.valueDriver.exit, 'rental');
  assert.equal(rental.estimatedRedevValue, rental.estimatedStabilizedValue);
  assert.notEqual(rental.estimatedStabilizedValue, rental.estimatedCondoSellout);
  assert.equal(rental.completedValueExit, 'rental');
  // The land the rental pays is its capitalized value less construction and carry, so the value reproduces it.
  assert.ok(Math.abs(rental.valueDriver.landValue * (1 + carry) + rental.constructionCost - rental.estimatedRedevValue) <= 5);
  const condo = computeDealValuation({...vacantLot, zipCode: '11249', submarketSalePsf: 1400, submarketRentPsf: 3});
  assert.equal(condo.valueDriver.exit, 'condo');
  assert.equal(condo.estimatedRedevValue, condo.estimatedCondoSellout);
  assert.ok(condo.estimatedStabilizedValue > 0 && condo.estimatedStabilizedValue < condo.estimatedCondoSellout);
});

test('each price threshold is its tier\'s land value over the floor area of the building that earns it', () => {
  // Cheap construction and high rents: the standard rental wins at the great-deal yield, the larger affordable
  // building at the good-deal yield.
  const v = computeDealValuation({...vacantLot, submarketSalePsf: 600, submarketRentPsf: 6, settings: {hardCostPerGrossSqft: 150}});
  assert.deepEqual(v.thresholdBasis.great, {program: 'standard', exit: 'rental', buildableZfa: 20000});
  assert.deepEqual(v.thresholdBasis.good, {program: 'uap', exit: 'rental', buildableZfa: 25050});
  assert.equal(v.buildableZfa, 25050);
  for (const [tier, max, land] of [['great', v.greatDealMaxBsf, v.greatDealMaxLandValue], ['good', v.goodDealMaxBsf, v.goodDealMaxLandValue], ['fair', v.badDealMinBsf, v.badDealMinLandValue]]) {
    assert.equal(land, max * v.thresholdBasis[tier].buildableZfa, tier);
  }
  // The great threshold divided by the lead's 25,050 sq ft would understate it by a fifth.
  assert.ok(v.greatDealMaxBsf > Math.round(v.greatDealMaxLandValue / v.buildableZfa) + 25);
  // The good threshold is the lead's land value net of buying costs over the lead's own area.
  const rate = v.acquisition.transferTaxRate + DEAL_SCREEN_ASSUMPTIONS.buyerClosingCostPct;
  assert.equal(v.goodDealMaxBsf, Math.round(v.valueDriver.landValue / (1 + rate) / v.thresholdBasis.good.buildableZfa));
  // An ask at the great-deal land value rates great; the ask is judged on the great building's own area.
  assert.equal(computeDealValuation({...vacantLot, listPrice: v.greatDealMaxLandValue, submarketSalePsf: 600, submarketRentPsf: 6, settings: {hardCostPerGrossSqft: 150}}).priceVerdict, 'great_deal');
});

test('a commercial-district lot with no residential floor area is priced on its commercial building', () => {
  const lot = {listPrice: 3_000_000, lotArea: 10000, lotFront: 100, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 0, commFar: 3.4, zoningDistrict: 'C8-2', address: '5 EXAMPLE AVENUE', borough: 'BK', zipCode: '11216', settings: {hardCostPerGrossSqft: 150}};
  const v = computeDealValuation({...lot, withCandidates: true});
  const commercial = v.rentalSchemes.find(s => s.program === 'commercial');
  assert.ok(commercial, 'the commercial building is weighed');
  assert.equal(commercial.zfa, 34000);
  assert.equal(commercial.units, 0);
  assert.notEqual(v.priceVerdict, null, 'the lot is priced rather than left unrated');
  const candidate = v.candidates.find(c => c.key === 'commercial');
  assert.ok(candidate?.commercial?.retailRentPsfYear > 0, 'the tier retail rent is recorded on the candidate');
  const gate = v.gates.find(g => g.id === 'no_residential');
  assert.match(gate.detail, /commercial building .* is priced/);
});

test('a commercial lead inside an MIH area prices no MIH option and says so', () => {
  // Weak residential rents with a large commercial allowance: the commercial building leads.
  const lot = {...mihLot, residFar: 3, affResFar: 3.9, commFar: 6.5, overlay1: 'C2-4', zoningDistrict: 'R6A', submarketRentPsf: 2.2, submarketSalePsf: 350, inMihArea: true, mihArea: mihArea(['option1'])};
  const v = computeDealValuation(lot);
  assert.equal(v.valueDriver.program, 'commercial');
  assert.equal(v.mih.status, 'inside');
  assert.equal(v.mih.appliedOption, null);
  assert.match(v.mih.note, /wholly commercial/);
});

test('a residential lot without commercial floor area weighs no commercial building', () => {
  const v = computeDealValuation(vacantLot);
  assert.equal(v.rentalSchemes.some(s => s.program === 'commercial'), false);
});

test('a stored tax-lot outline is the lot the envelope is drawn on', () => {
  // An L of 4,000 sq ft: 50 ft wide for 60 ft, then 25 ft wide for 40 more. The PLUTO rectangle
  // (50 by 110) is far from the recorded area, so without the outline no envelope stands for the lot.
  const outline = [[0, 0], [50, 0], [50, 60], [25, 60], [25, 100], [0, 100]];
  const lot = {...vacantLot, lotArea: 4000, lotFront: 50, lotDepth: 110};
  const paper = computeDealValuation(lot);
  assert.equal(paper.physicalEnvelope.envelopeBasis, 'paper-only');
  assert.equal(paper.physicalEnvelope.lotShapeBasis, 'pluto-rectangle');
  const snapped = computeDealValuation({...lot, lotPolygon: {polygon: outline, widthFeet: 50, depthFeet: 100}});
  assert.equal(snapped.physicalEnvelope.lotShapeBasis, 'mappluto-tax-lot');
  assert.equal(snapped.physicalEnvelope.envelopeBasis, 'curated-envelope');
  assert.deepEqual(snapped.physicalEnvelope.lotPolygon, outline);
  assert.match(snapped.physicalEnvelope.bulkConstraintSummary, /MapPLUTO outline/);
  // An outline far from the recorded area is some other parcel's shape: the rectangle stands instead.
  const other = computeDealValuation({...lot, lotPolygon: {polygon: [[0, 0], [90, 0], [90, 100], [0, 100]], widthFeet: 90, depthFeet: 100}});
  assert.equal(other.physicalEnvelope.lotShapeBasis, 'pluto-rectangle');
  assert.equal(other.physicalEnvelope.lotPolygon, null);
});

test('the store reads each lot its MapPLUTO outline and revalues the listings on it', async () => {
  const store = new MarketStore(':memory:');
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, pluto_address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, first_seen_at, last_seen_at)
      VALUES ('shaped', 'for_sale', '5 Example Ave', '5 EXAMPLE AVENUE', '11216', 'BK', '3000030001', 2000000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 1, 1),
             ('unshaped', 'for_sale', '7 Example St', '7 EXAMPLE STREET', '11216', 'BK', '3000030002', 2000000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 1, 1)`).run();
    // A 50 by 100 ft square in lon/lat near 40.68, -73.95, as MapPLUTO returns it.
    const ring = [[-73.95, 40.68], [-73.9498192, 40.68], [-73.9498192, 40.6802743], [-73.95, 40.6802743], [-73.95, 40.68]];
    const fetchGeometry = async bbls => new Map(bbls.filter(b => b === '3000030001').map(b => [b, [{polygon: ring, holes: []}]]));
    assert.deepEqual(await store.backfillLotPolygons({fetchGeometry}), {checked: 2, withPolygon: 1});
    const shaped = store.one("SELECT lot_polygon_json, max_standard_zfa FROM market_listings WHERE id = 'shaped'");
    const stored = JSON.parse(shaped.lot_polygon_json);
    assert.ok(Math.abs(stored.widthFeet - 50) < 2, `front edge ${stored.widthFeet} ft`);
    assert.ok(stored.polygon.length >= 4);
    assert.ok(shaped.max_standard_zfa > 0, 'the listing was revalued on its outline');
    assert.deepEqual(store.lotPolygonFor('3000030001'), stored.polygon);
    assert.equal(store.lotPolygonFor('3000030002'), null);
    assert.equal(store.one("SELECT lot_polygon_json FROM market_listings WHERE id = 'unshaped'").lot_polygon_json, null);
    assert.deepEqual(await store.backfillLotPolygons({fetchGeometry: async () => { throw new Error('already read'); }}), {checked: 0, withPolygon: 0});
  } finally {
    store.close();
  }
});
