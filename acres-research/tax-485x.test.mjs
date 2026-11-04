import test from 'node:test';
import assert from 'node:assert/strict';
import {zone485x, projectClass485x, restrictedUnits485x, exemptionSchedule485x, exemptionValue485x, wageFloorOn, wageFloor485x, taxShareOfNoi, HPD_AFFORDABLE_RENTS} from './tax-485x.mjs';
import {computeProForma, sensitivity, recomputeProForma, createProFormaTools} from './proforma.mjs';
import {computeDealValuation} from './market-store.mjs';

test('zones follow the statute: Manhattan south of 96th Street and the listed NTAs', () => {
  assert.equal(zone485x({borough: 'BK', ntaCode: 'BK0102'}), 'A');
  assert.equal(zone485x({borough: 'QN', ntaCode: 'QN0201'}), 'A');
  assert.equal(zone485x({borough: 'BK', ntaCode: 'BK0601'}), 'B');
  assert.equal(zone485x({borough: 'BK', ntaCode: 'BK0301'}), null);
  assert.equal(zone485x({borough: 'MN', entirelySouthOf96thStreet: true}), 'A');
  assert.equal(zone485x({borough: 'MN', entirelySouthOf96thStreet: false}), null);
  assert.equal(zone485x({borough: 'BX'}), null);
  assert.throws(() => zone485x({borough: 'MN'}), /south of 96th Street/);
  assert.throws(() => zone485x({borough: 'QN', ntaCode: 'BK0101'}), /neighborhood tabulation area/);
});

test('the unit count, zone and election set the project class at the 6, 11, 100 and 150 unit lines', () => {
  const cls = args => projectClass485x({zone: null, borough: 'BK', ...args});
  assert.equal(cls({units: 5, option: 'B'}).eligible, false);
  assert.equal(cls({units: 99, option: 'B'}).key, 'modest');
  assert.match(cls({units: 100, option: 'B'}).reason, /must comply with Option A/);
  assert.match(cls({units: 99, option: 'A'}).reason, /Option A applies from 100 units/);
  assert.equal(cls({units: 100, option: 'A'}).key, 'large');
  assert.equal(cls({units: 150, option: 'A'}).key, 'large', 'outside Zones A and B a 150-unit project stays large');
  const veryLarge = cls({units: 150, option: 'A', zone: 'B'});
  assert.deepEqual([veryLarge.key, veryLarge.amiPct, veryLarge.benefit[0].years], ['veryLarge', 60, 40]);
  assert.equal(cls({units: 10, option: 'C', residentialFloorAreaPermitted: 12500}).key, 'small');
  assert.match(cls({units: 11, option: 'C', residentialFloorAreaPermitted: 12500}).reason, /6 to 10 units/);
  assert.match(cls({units: 8, option: 'C', residentialFloorAreaPermitted: 12501}).reason, /12,500/);
  assert.match(cls({units: 8, option: 'C', borough: 'MN', residentialFloorAreaPermitted: 9000}).reason, /excludes Manhattan/);
});

test('restricted units mirror the market mix, rounding the largest remainders up', () => {
  assert.deepEqual(restrictedUnits485x([{bedrooms: 0, count: 30}, {bedrooms: 1, count: 49}, {bedrooms: 2, count: 20}], 0.2).map(r => r.count), [6, 10, 4]);
  assert.deepEqual(restrictedUnits485x([{bedrooms: 1, count: 60}, {bedrooms: 2, count: 40}], 0.25).map(r => r.count), [15, 10]);
  const scaled = restrictedUnits485x([{bedrooms: 1, count: 48}, {bedrooms: 2, count: 31.2}], 0.2);
  assert.ok(Math.abs(scaled[0].count / scaled[1].count - 48 / 31.2) < 1e-9, 'a scaled program keeps the exact proportion');
});

test('Option B steps down to the affordability percentage after 25 years; base taxes stay payable and excess commercial area cuts the benefit', () => {
  const schedule = exemptionSchedule485x(projectClass485x({units: 99, option: 'B', zone: null, borough: 'BK'}), 20 / 99);
  assert.deepEqual(schedule.map(r => [r.fromYear, r.toYear]), [[1, 25], [26, 35]]);
  assert.equal(schedule[1].exemption, 20 / 99);
  const v = exemptionValue485x({fullTaxes: 1000, baseTaxes: 200, schedule, nonResidentialShare: 0.15, discountRate: 0.05});
  assert.equal(v.reduction.toFixed(2), '0.03');
  assert.equal(v.year1Payable.toFixed(2), (1000 - 0.97 * 800).toFixed(2));
  let pv = 0;
  for (let t = 1; t <= 35; t++) pv += (t <= 25 ? 0.97 * 800 : 0.97 * (20 / 99) * 800) / 1.05 ** t;
  assert.equal(v.presentValue.toFixed(6), pv.toFixed(6));
  assert.equal(v.benefitYears, 35);
});

test('wage floors match the Comptroller table and rise each July 1; very large floors take the lesser prevailing share', () => {
  assert.equal(wageFloorOn(40, '2025-06-30'), 40);
  assert.equal(wageFloorOn(40, '2026-06-30'), 41);
  assert.equal(wageFloorOn(40, '2026-07-01'), 42.03);
  assert.equal(wageFloorOn(72.45, '2026-07-01'), 76.12);
  assert.equal(wageFloorOn(63, '2026-07-01'), 66.19);
  assert.equal(wageFloorOn(40, '2027-07-01'), 43.08);
  assert.equal(wageFloor485x({projectClass: 'modest', units: 99, zone: 'A', start: '2026-08-01', months: 12}), null);
  const large = wageFloor485x({projectClass: 'large', units: 100, zone: null, start: '2026-07-01', months: 12});
  assert.equal(large.hourly, 42.03);
  assert.equal(wageFloor485x({projectClass: 'large', units: 100, zone: null, start: '2027-06-01', months: 5}).hourly, 42.87, 'one month at $42.03, four at $43.08');
  const zoneA = wageFloor485x({projectClass: 'veryLarge', units: 150, zone: 'A', start: '2026-08-01', months: 6});
  assert.deepEqual([zoneA.hourly, zoneA.upperBound], [76.12, true]);
  assert.equal(wageFloor485x({projectClass: 'veryLarge', units: 150, zone: 'A', start: '2026-08-01', months: 6, greatestPrevailingWage: 100}).hourly, 65);
  assert.equal(wageFloor485x({projectClass: 'veryLarge', units: 150, zone: 'B', start: '2026-08-01', months: 6, greatestPrevailingWage: 120}).hourly, 66.19);
});

const market = {submarket: 'Test submarket', rents: [0, 1, 2].map(bedrooms => ({bedrooms, rentPerSqftPerMonth: 6, source: 'Test rent survey', retrievedAt: '2026-10-12'}))};
const building = (count, taxIncentive) => ({
  productType: 'rental', market, landPrice: 10_000_000, hardCostPerSqft: 400, softCostPerSqft: 100, capRate: 0.055,
  financing: {loanToCost: 0.6, interestRate: 0.07, termMonths: 30},
  operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 9000, commercialVacancyRate: 0, commercialOpexPerSqftPerYear: 0},
  program: {grossBuildingSqft: count * 900, units: [{bedrooms: 0, count: Math.round(count * 0.3)}, {bedrooms: 1, count: Math.round(count * 0.5)}, {bedrooms: 2, count: count - Math.round(count * 0.3) - Math.round(count * 0.5)}].map((u, i) => ({...u, netSqft: [450, 650, 900][i]}))},
  taxIncentive: {program: '485-x', option: count < 100 ? 'B' : 'A', location: {borough: 'BK', ntaCode: 'BK0101'}, fullAnnualTaxes: count * 12_000, baseAnnualTaxes: 150_000, discountRate: 0.07,
    construction: {start: '2026-07-01', months: 12, laborShareOfHardCost: 0.45, currentHourlyWage: 38}, ...taxIncentive},
});

test('a 485-x rental prices restricted units at HPD rents, pays base taxes and adds the exemption as a present value', () => {
  const r = computeProForma(building(99));
  const t = r.taxIncentive;
  assert.deepEqual([t.label, t.option, t.restrictedCount, t.amiPct, t.benefitYears, t.wageFloorHourly, t.hardCostPremium], ['modest rental project', 'B', 20, 80, 35, null, 0]);
  const oneBedroomAmi = r.operations.lines.find(l => l.line === 'One bedroom, 80% AMI');
  assert.deepEqual([oneBedroomAmi.units, oneBedroomAmi.monthlyRent, oneBedroomAmi.source], [10, HPD_AFFORDABLE_RENTS.byAmi[80][1], HPD_AFFORDABLE_RENTS.source]);
  assert.equal(r.operations.realEstateTaxes, 150_000, 'a 100% exemption leaves the base taxes');
  assert.equal(t.year1Savings, 99 * 12_000 - 150_000);
  assert.ok(Math.abs(r.operations.capitalizedValue - (t.noiAtFullTaxes / 0.055 + t.exemptionPresentValue)) < 20, 'value = NOI at full taxes over the cap rate plus the exemption, to rounding');
  assert.equal(r.operations.noi - t.year1Savings, t.noiAtFullTaxes);
  assert.ok(t.without485x.profit < r.returns.profit, 'the comparison without 485-x is reported');
  assert.ok(r.derivation.some(l => /mirroring the market mix \(6 × studio, 10 × one-bedroom, 4 × two-bedroom\)/.test(l)));
  assert.ok(r.sources.some(s => s.source === 'NY Real Property Tax Law § 485-x'));
});

test('crossing 100 units brings Option A and the wage floor as a hard-cost premium; 150 in Zone A is very large', () => {
  const at100 = computeProForma(building(100));
  assert.equal(at100.taxIncentive.wageFloorHourly, 42.03);
  assert.equal(at100.taxIncentive.hardCostPremium, Number((0.45 * (42.03 / 38 - 1)).toFixed(4)));
  assert.equal(at100.development.hardCost, Math.round(100 * 900 * 400 * (1 + 0.45 * (42.03 / 38 - 1))));
  assert.equal(at100.inputs.hardCostPerSqft, 400, 'the stated hard cost is echoed unchanged');
  const at150 = computeProForma(building(150)).taxIncentive;
  assert.deepEqual([at150.projectClass, at150.amiPct, at150.benefitYears, at150.wageFloorUpperBound], ['veryLarge', 60, 40, true]);
  assert.equal(at150.wageFloorHourly, 76.12);
});

test('an Option A program also reports the same building held to 99 units under Option B, with no wage floor', () => {
  const at120 = computeProForma(building(120)).taxIncentive;
  const held = at120.at99Units;
  assert.equal(held.scenario, '99 units under 485-x Option B');
  assert.equal(held.units, 99);
  assert.equal(held.taxIncentiveEligible, true);
  const direct = computeProForma({...building(120), program: {...building(120).program, grossBuildingSqft: 120 * 900 * 99 / 120, units: building(120).program.units.map((u, i) => ({...u, count: [30, 49, 20][i]}))}, taxIncentive: {...building(120).taxIncentive, option: 'B', fullAnnualTaxes: 99 * 12_000}});
  assert.equal(held.totalDevelopmentCost, direct.development.totalDevelopmentCost, 'no wage floor premium at 99 units');
  assert.equal(held.profit, direct.returns.profit);
  assert.equal(computeProForma(building(99)).taxIncentive.at99Units, null, 'an Option B program has nothing to compare');
});

test('incentive inputs fail fast on a mismatched option, the eligibility window and doubled tax inputs', async () => {
  assert.throws(() => computeProForma({...building(120), taxIncentive: {...building(120).taxIncentive, option: 'B'}}), /large rental project, which must comply with Option A/);
  assert.throws(() => computeProForma(building(99, {construction: {start: '2034-07-01', months: 12}})), /on or before 2034-06-15/);
  assert.throws(() => computeProForma(building(99, {construction: {start: '2033-01-01', months: 120}})), /after 2038-06-15/);
  assert.throws(() => computeProForma(building(99, {dofCapRate: 0.08})), /exactly one of taxIncentive.fullAnnualTaxes/);
  assert.throws(() => computeProForma({...building(99), productType: 'condo', sellingCostRate: 0.05}), /rental pro formas/);
  const ledger = {taxes: () => ({annualTaxes: 90_000, basis: 'Real estate taxes = DOF assessment x class 1 rate.', crossCheck: null, sourceUrl: 'https://data.cityofnewyork.us/d/8y4t-faws', retrievedAt: '2026-10-16T06:00:00.000Z'})};
  const tools = createProFormaTools({ledger, record: () => ({id: 'T1'})});
  await assert.rejects(tools.handlers.acres_pro_forma({...building(99), taxSource: 'ledger'}), /base taxes once/);
  const {baseAnnualTaxes: _, ...incentive} = building(99).taxIncentive;
  const fromLedger = await tools.handlers.acres_pro_forma({...building(99), taxIncentive: incentive, taxSource: 'ledger'});
  assert.equal(fromLedger.operations.realEstateTaxes, 90_000);
  assert.ok(fromLedger.sources.some(s => s.sourceId === 'T1'));
});

test('the DOF income method estimates full taxes from NOI before taxes when they are not stated', () => {
  const {fullAnnualTaxes: _, ...incentive} = building(99).taxIncentive;
  const r = computeProForma({...building(99), taxIncentive: {...incentive, dofCapRate: 0.08}});
  const noiBeforeTaxes = r.operations.effectiveGrossIncome - 99 * 9000, effective = 0.45 * 0.12439;
  assert.equal(r.taxIncentive.fullAnnualTaxes, Math.round(noiBeforeTaxes / (0.08 + effective) * effective));
  assert.ok(r.derivation.some(l => /DOF income method/.test(l)));
});

test('sensitivity rows that leave the option carry full taxes, and recompute keeps the incentive', () => {
  const {base, table} = sensitivity(building(99), null, {entitlement: [0.8, 1.2]});
  assert.deepEqual(table.entitlement.map(r => r.taxIncentiveEligible), [true, true, false]);
  assert.ok(base.taxIncentive.without485x);
  const again = recomputeProForma({...base, sensitivitySteps: {}}, {market, program: {productType: 'rental', byBedrooms: base.inputs.program.units.map(u => ({bedrooms: u.bedrooms, units: u.count, unitSqft: u.netSqft}))}});
  assert.equal(again.returns.value, base.returns.value);
  assert.equal(again.taxIncentive.restrictedCount, 20);
});

// A 200 by 100 ft vacant lot in a high-density district, enough envelope for 150+ units.
const largeLot = {listPrice: 30_000_000, lotArea: 20000, lotFront: 200, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 6.02, affResFar: 7.2, zoningDistrict: 'R8A', address: '9 EXAMPLE AVENUE', borough: 'BK', zipCode: '11211', valuationDate: '2026-10-20', submarketSalePsf: 900};
const scheme = (v, program, units, option) => v.rentalSchemes.find(s => s.program === program && s.units === units && s.option === option);

test('a building held to 99 units over a retail ground floor still holds 99 apartments', () => {
  const v = computeDealValuation({...largeLot, commFar: 2, overlay1: 'C2-4', submarketRentPsf: 8});
  const capped = v.rentalSchemes.find(s => s.unitCap === 99);
  assert.ok(v.corridorProfile.hasRetailUplift);
  assert.equal(capped.units, 99, 'the shops are added on top of the 99 apartments\' floor area');
});

test('the city-financed building prices its ground floor as apartments, so a commercial overlay leaves its units alone', () => {
  const appraisedLand = {pricePerBsf: 150, saleCount: 6, withinMiles: 1};
  const units = lot => computeDealValuation({...largeLot, ...lot, submarketRentPsf: 8, appraisedLand}).rentalSchemes.filter(s => s.taxes === 'city-financed').map(s => [s.program, s.units]);
  const shops = units({commFar: 2, overlay1: 'C2-4'});
  assert.ok(shops.length > 0);
  assert.deepEqual(shops, units({}));
});

test('a rental past 99 units can hold to 99 under 485-x Option B, with no wage floor, when that pays more for the land', () => {
  const v = computeDealValuation({...largeLot, submarketRentPsf: 8});
  const d = v.valueDriver;
  assert.deepEqual([d.exit, d.program, d.taxes, d.unitCap, v.plannedUnits], ['rental', 'standard', '485-x', 99, 99]);
  assert.equal(v.maxBuildableUnits, 177, 'the zoning cap stays the site\'s');
  assert.equal(d.uncappedUnits, 175);
  assert.ok(v.buildableZfa < v.achievableStandardZfa && d.storeys < computeDealValuation({...largeLot, submarketRentPsf: 14}).valueDriver.storeys);
  assert.deepEqual([d.taxProgram.option, d.taxProgram.projectClass, d.taxProgram.restrictedShare, d.taxProgram.amiPct, d.taxProgram.benefitYears, d.taxProgram.wageFloorHourly, d.taxProgram.hardCostPremium], ['B', 'modest', 0.2, 80, 35, null, 0]);
  assert.deepEqual(d.taxProgram.schedule, [{fromYear: 1, toYear: 25, exemption: 1}, {fromYear: 26, toYear: 35, exemption: 0.2}]);
  assert.ok(d.landValue > d.uncappedLandValue, 'chosen only when it pays more for the land than any uncapped building');
  assert.equal(d.uncappedLandValue, Math.max(...v.rentalSchemes.filter(s => !s.unitCap).map(s => s.landValue)));
  assert.ok(scheme(v, 'standard', 99, 'B').leads);
  assert.ok(scheme(v, 'standard', 175, 'A').landValue < scheme(v, 'standard', 99, 'B').landValue);
});

test('a building held to 99 units never leads by losing less when no building pays for the land', () => {
  const v = computeDealValuation({...largeLot, submarketRentPsf: 6, settings: {hardCostPerGrossSqft: 380}});
  assert.ok(scheme(v, 'standard', 99, 'B').landValue < 0 && scheme(v, 'standard', 99, 'B').landValue > scheme(v, 'standard', 175, 'A').landValue);
  assert.equal(v.valueDriver.unitCap ?? null, null);
  assert.ok(!scheme(v, 'standard', 99, 'B').leads);
});

test('the uncapped building elects Option A with the wage floor when its extra floor area outweighs the cap', () => {
  const v = computeDealValuation({...largeLot, submarketRentPsf: 12});
  const d = v.valueDriver;
  assert.deepEqual([d.exit, d.program, d.taxProgram.option, d.unitCap, v.plannedUnits], ['rental', 'uap', 'A', null, 209]);
  assert.equal(d.taxProgram.projectClass, 'large', 'an undetermined zone keeps 150+ units a large project');
  assert.equal(d.taxProgram.wageSection, '§ 3(a)');
  assert.ok(d.taxProgram.wageFloorHourly > 42 && d.taxProgram.hardCostPremium > 0);
  assert.ok(scheme(v, 'standard', 99, 'B').landValue < d.landValue);
  const zoneA = computeDealValuation({...largeLot, submarketRentPsf: 12, zone485x: 'A'});
  assert.ok(zoneA.rentalSchemes.length === v.rentalSchemes.length && scheme(zoneA, 'uap', 209, 'A').landValue < scheme(v, 'uap', 209, 'A').landValue, 'Zone A makes 150+ units very large: deeper affordability and a higher wage floor');
});

test('every rental scheme carries real estate taxes, and 485-x starts at six units', () => {
  const mid = computeDealValuation({...largeLot, lotArea: 5000, lotFront: 50, listPrice: 3_000_000, submarketRentPsf: 8});
  assert.deepEqual(mid.rentalSchemes.map(s => [s.program, s.units, s.option, s.unitCap]), [['standard', 43, null, null], ['standard', 43, 'B', null], ['uap', 52, null, null], ['uap', 52, 'B', null]]);
  assert.ok(scheme(mid, 'standard', 43, 'B').landValue > scheme(mid, 'standard', 43, null).landValue);
  assert.equal(mid.valueDriver.taxProgram.option, 'B');
  const tiny = computeDealValuation({...largeLot, lotArea: 1000, lotFront: 20, lotDepth: 50, residFar: 3, affResFar: 3.9, zoningDistrict: 'R6B', listPrice: 500_000, submarketRentPsf: 8});
  assert.ok(tiny.rentalSchemes.every(s => s.taxes === 'full' && s.units < 6));
  assert.ok(taxShareOfNoi(3) < taxShareOfNoi(4), 'three units or fewer are class 1');
  const untaxed = 8 * 12 * 0.85 * 0.7 / 0.0725 / 1.1;
  const full = scheme(mid, 'standard', 43, null);
  assert.ok(full.landValue / full.zfa < untaxed - 500, 'full taxes lower the rental value');
  assert.ok(mid.basis.some(b => b.item === 'realEstateTaxes') && mid.basis.some(b => b.item === 'taxIncentive485x'));
});

test('a zoning set-aside counts toward the 485-x share; one above its AMI average is not screened under 485-x', () => {
  const mihArea = options => ({name: 'Example Rezoning', projectId: 'P2018K0001', ulurp: '180001ZMK', adopted: '2018-01-31', borough: '3', communityDistrict: 8, options});
  const inside = option => computeDealValuation({...largeLot, submarketRentPsf: 12, inMihArea: true, mihArea: mihArea([option])}).valueDriver;
  assert.deepEqual([inside('option1').program, inside('option1').taxProgram.option, inside('option1').taxProgram.addedAffordableZfa], ['option1', 'A', 0], 'a 25% set-aside at 60% AMI meets Option A on its own');
  assert.equal(inside('option3').taxProgram.addedAffordableZfa, 0.05 * inside('option3').buildableZfa, 'a 20% set-aside adds 5% more at 80% AMI');
  const workforce = computeDealValuation({...largeLot, submarketRentPsf: 12, inMihArea: true, mihArea: mihArea(['option4'])});
  assert.ok(!workforce.rentalSchemes.some(s => s.program === 'option4' && s.option));
});

test('the envelope and entitlement paths flag floor area that allows 100 or more units', async () => {
  const {dwellingUnits} = await import('./envelope.mjs');
  const {rules} = await import('./zoning.mjs');
  const {entitlementScenarios} = await import('./entitlements.mjs');
  assert.match(dwellingUnits({residentialFloorAreaSqft: 68_000, specialDensityArea: false, rules}).note, /allows 100 units\. A new rental of 100 or more units takes 485-x Option A.*held to 99 units it is a modest rental project under Option B/);
  assert.doesNotMatch(dwellingUnits({residentialFloorAreaSqft: 67_000, specialDensityArea: false, rules}).note, /485-x/);
  const paths = entitlementScenarios({district: 'R7A', lotAreaSqft: 15_000});
  const flagged = id => paths.scenarios.find(s => s.id === id).conditions.some(c => /485-x Option A/.test(c));
  assert.deepEqual([flagged('as-of-right'), flagged('universal-affordability-preference')], [false, true], '60,000 sq ft allows 88 units; the UAP 75,150 sq ft allows 110');
});
