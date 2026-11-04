import test from 'node:test';
import assert from 'node:assert/strict';
import {computeProForma, sensitivity, recomputeProForma, createProFormaTools, proFormaDefinition} from './proforma.mjs';
import {createMarketTools} from './market.mjs';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LedgerStore, createSubjectLedger, FORMULA_VERSION} from './ledger.mjs';
import {MarketStore, parcelListingRow} from './market-store.mjs';

const retrievedAt = '2026-10-12';
const market = {
  submarket: 'Financial District, Manhattan',
  rents: [
    {bedrooms: 0, rentPerSqftPerMonth: 8, source: 'StreetEasy market report', url: 'https://streeteasy.com/blog/data-dashboard/', retrievedAt},
    {bedrooms: 1, rentPerSqftPerMonth: 7, source: 'StreetEasy market report', url: 'https://streeteasy.com/blog/data-dashboard/', retrievedAt},
    {bedrooms: 2, rentPerSqftPerMonth: 6.5, source: 'User', retrievedAt},
    {bedrooms: 3, rentPerSqftPerMonth: 6, source: 'User', retrievedAt},
  ],
  salePrices: [{bedrooms: 1, pricePerSqft: 1800, source: 'User', retrievedAt}, {bedrooms: 2, pricePerSqft: 2000, source: 'User', retrievedAt}, {bedrooms: 3, pricePerSqft: 2200, source: 'User', retrievedAt}],
  commercialRents: [{use: 'retail', rentPerSqftPerYear: 150, source: 'REBNY retail report', retrievedAt}],
};
const rental = {
  name: 'As-of-right rental', productType: 'rental', market,
  program: {grossBuildingSqft: 100000, units: [{bedrooms: 0, count: 20, netSqft: 450}, {bedrooms: 1, count: 40, netSqft: 650}, {bedrooms: 2, count: 30, netSqft: 950}, {bedrooms: 3, count: 10, netSqft: 1250}], commercial: [{use: 'retail', netSqft: 5000}]},
  landPrice: 20_000_000, hardCostPerSqft: 450, softCostPerSqft: 100,
  financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 30},
  operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 12000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 5},
  capRate: 0.05,
};
const condo = {
  name: 'Condo', productType: 'condo', market,
  program: {grossBuildingSqft: 70000, units: [{bedrooms: 1, count: 20, netSqft: 800}, {bedrooms: 2, count: 20, netSqft: 1200}, {bedrooms: 3, count: 10, netSqft: 1700}]},
  landPrice: 25_000_000, hardCostPerSqft: 600, softCostPerSqft: 150,
  financing: {loanToCost: 0.55, interestRate: 0.09, termMonths: 36},
  sellingCostRate: 0.06,
};

test('rental pro forma, checked by hand', () => {
  // Budget: hard 100,000 × 450 = 45,000,000; soft 100,000 × 100 = 10,000,000; base = 20,000,000 + 45,000,000
  // + 10,000,000 = 75,000,000. Loan = 60% × 75,000,000 = 45,000,000; equity = 30,000,000. Carry = 8% × 2.5 years
  // × 60% × (20,000,000 land + 55,000,000 / 2) = 0.12 × 47,500,000 = 5,700,000. Total cost = 80,700,000;
  // loan with reserve = 50,700,000, so effective loan to cost = 0.6283 and cost per gross sq ft = 807.
  // Revenue: 12 × (9,000 × 8 + 26,000 × 7 + 28,500 × 6.5 + 12,500 × 6) = 12 × 514,250 = 6,171,000 residential;
  // 5,000 × 150 = 750,000 retail; GPR 6,921,000. Vacancy = 5% × 6,171,000 + 10% × 750,000 = 383,550; EGI 6,537,450.
  // Opex = 100 × 12,000 + 5,000 × 5 = 1,225,000. NOI = 5,312,450. Yield on cost = 5,312,450 / 80,700,000 = 6.58%,
  // spread over the 5% cap rate 158 bps. Value = 5,312,450 / 0.05 = 106,249,000; profit = 25,549,000;
  // return on cost 31.66%; return on equity 25,549,000 / 30,000,000 = 85.16%; equity multiple 1.85.
  // Debt service = 50,700,000 × 8% = 4,056,000; DSCR 1.31; cash on cash = 1,256,450 / 30,000,000 = 4.19%.
  const result = computeProForma(rental);
  assert.equal(result.name, 'As-of-right rental');
  assert.deepEqual(result.development, {landPrice: 20000000, hardCost: 45000000, softCost: 10000000, baseCost: 75000000, interestCarry: 5700000, totalDevelopmentCost: 80700000, loan: 45000000, interestReserve: 5700000, loanWithReserve: 50700000, equity: 30000000, effectiveLoanToCost: 0.6283, costPerGrossSqft: 807});
  const {lines, ...operations} = result.operations;
  assert.deepEqual(operations, {residentialGpr: 6171000, commercialGpr: 750000, grossPotentialRent: 6921000, vacancyLoss: 383550, effectiveGrossIncome: 6537450, operatingExpenses: 1225000, noi: 5312450, unitCount: 100, commercialSqft: 5000, yieldOnCost: 0.0658, capRate: 0.05, developmentSpreadBps: 158, capitalizedValue: 106249000});
  assert.equal(lines.length, 5);
  assert.deepEqual(lines[1], {line: 'One bedroom', units: 40, netSqft: 26000, rentPerSqftPerMonth: 7, annualRent: 2184000, source: 'StreetEasy market report', retrievedAt, sourceId: null});
  assert.equal(lines[4].line, 'retail');
  assert.deepEqual(result.returns, {value: 106249000, profit: 25549000, unleveredReturnOnCost: 0.3166, leveredReturnOnEquity: 0.8516, equityMultiple: 1.85, annualDebtService: 4056000, debtServiceCoverage: 1.31, cashOnCash: 0.0419});
  assert.equal(result.sales, undefined);
  assert.deepEqual(result.sources.map(s => s.source), ['StreetEasy market report', 'User', 'REBNY retail report']);
  assert.equal(result.inputs.market.submarket, 'Financial District, Manhattan');
  assert.equal(result.inputs.financing.termMonths, 30);
  assert.match(result.derivation[4], /^Interest carry = 8\.00% × 2\.5 years × 60% × \(land \$20,000,000 \+ half of construction \$27,500,000\) = \$5,700,000$/);
  assert.match(result.derivation.find(d => d.startsWith('NOI')), /NOI = \$6,921,000 − \$383,550 − \$1,225,000 = \$5,312,450/);
  assert.match(result.derivation.at(-1), /Cash on cash = \(NOI \$5,312,450 − interest-only debt service \$4,056,000\) ÷ equity \$30,000,000 = 4\.19%/);
});

test('a condo with retail capitalizes the retail income beside the sellout', () => {
  // Retail: 5,000 sq ft × $150 = 750,000 GPR; 10% vacancy → 675,000; opex 5,000 × $5 = 25,000; NOI 650,000;
  // value at 5% = 13,000,000. Sellout: 20 × 800 × 1,800 + 20 × 1,200 × 2,000 + 10 × 1,700 × 2,200 = 114,200,000;
  // net of 6% = 107,348,000. Value = 120,348,000.
  const result = computeProForma({...condo, program: {...condo.program, commercial: [{use: 'retail', netSqft: 5000}]}, operating: rental.operating, capRate: 0.05});
  assert.equal(result.operations.unitCount, 0);
  assert.equal(result.operations.noi, 650000);
  assert.equal(result.sales.netSellout, 107348000);
  assert.equal(result.returns.value, 120348000);
});

test('a wholly commercial building is priced on its commercial income, checked by hand', () => {
  // Budget: hard 20,000 x 400 = 8,000,000, soft 1,600,000, base 14,600,000; loan 60% = 8,760,000,
  // equity 5,840,000. Carry = 8% x 2 years x 60% x (5,000,000 + 9,600,000 / 2) = 940,800; total cost
  // 15,540,800. Retail GPR 15,000 x 150 = 2,250,000; vacancy 10% = 225,000; EGI 2,025,000; opex
  // 15,000 x 5 = 75,000; NOI 1,950,000; value at 6% = 32,500,000; profit 16,959,200. Debt service on
  // the loan with reserve = 9,700,800 x 8% = 776,064, so coverage is 2.51x.
  const commercial = {
    name: 'Retail building', productType: 'commercial', market,
    program: {grossBuildingSqft: 20000, units: [], commercial: [{use: 'retail', netSqft: 15000}]},
    landPrice: 5_000_000, hardCostPerSqft: 400, softCostPerSqft: 80,
    financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 24},
    operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 12000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 5},
    capRate: 0.06,
  };
  const result = computeProForma(commercial);
  assert.equal(result.productType, 'commercial');
  assert.equal(result.development.totalDevelopmentCost, 15540800);
  assert.deepEqual([result.operations.residentialGpr, result.operations.commercialGpr, result.operations.noi, result.operations.capitalizedValue, result.operations.unitCount, result.operations.commercialSqft], [0, 2250000, 1950000, 32500000, 0, 15000]);
  assert.deepEqual([result.returns.value, result.returns.profit, result.returns.debtServiceCoverage, result.returns.cashOnCash], [32500000, 16959200, 2.51, 0.201]);
  assert.equal(result.sales, undefined);
  // Mixed-use stays rental or condo, and commercial takes neither homes nor an all-residential program.
  assert.throws(() => computeProForma({...commercial, program: {...commercial.program, units: [{bedrooms: 1, count: 5, netSqft: 700}]}}), /takes no residential units; a mixed-use building is a rental or condo/);
  assert.throws(() => computeProForma({...commercial, program: {grossBuildingSqft: 20000, units: [{bedrooms: 1, count: 5, netSqft: 700}]}}), /needs program\.commercial area/);
  assert.throws(() => computeProForma({...commercial, taxIncentive: {program: '485-x'}}), /rental pro formas/);
});

test('sensitivities derive from the validated base and never fail its input ranges', () => {
  const nearBounds = {...rental, hardCostPerSqft: 2800, capRate: 0.02, financing: {...rental.financing, interestRate: 0}};
  const {base, table} = sensitivity(nearBounds);
  assert.equal(table.cost.length, 3);
  assert.equal(table.capRateBps[0].scenario, 'cap rate -50 bps');
  assert.equal(base.returns.debtServiceCoverage, null);
  assert.equal(base.returns.annualDebtService, 0);
});

test('one-way sensitivities move only their own input', () => {
  // Rent +10%: GPR 7,613,100, vacancy 421,905, NOI 5,966,195, value 119,323,900. Rent -10%: NOI 4,658,705.
  // Cost +10%: hard 49,500,000 + soft 11,000,000, base 80,500,000, carry 0.12 × 50,250,000 = 6,030,000, total 86,530,000.
  // Cap rate 5.5%: value 96,590,000; 4.5%: 118,054,444. Entitlement ×1.2: 120 units, 6,000 sq ft retail, NOI
  // 7,844,940 − 1,470,000 = 6,374,940 against total cost 86,000,000 + 6,360,000 = 92,360,000, yield 6.90%;
  // ×0.8: NOI 4,249,960 against 69,040,000, yield 6.16%. The land price never moves.
  const {base, table} = sensitivity(rental);
  assert.equal(base.returns.value, 106249000);
  assert.deepEqual(Object.keys(table), ['rent', 'cost', 'capRateBps', 'entitlement']);
  assert.deepEqual(table.rent.map(r => r.scenario), ['rent -10%', 'base', 'rent +10%']);
  assert.deepEqual(table.rent.map(r => r.noi), [4658705, 5312450, 5966195]);
  assert.equal(table.rent[2].value, 119323900);
  assert.equal(table.rent[2].totalDevelopmentCost, 80700000);
  assert.deepEqual(table.cost.map(r => r.totalDevelopmentCost), [74870000, 80700000, 86530000]);
  assert.equal(table.cost[2].noi, 5312450);
  assert.deepEqual(table.capRateBps.map(r => r.scenario), ['cap rate -50 bps', 'base', 'cap rate +50 bps']);
  assert.deepEqual(table.capRateBps.map(r => r.value), [118054444, 106249000, 96590000]);
  assert.deepEqual(table.entitlement.map(r => r.scenario), ['entitlement ×0.8', 'base', 'entitlement ×1.2']);
  assert.deepEqual(table.entitlement.map(r => r.noi), [4249960, 5312450, 6374940]);
  assert.deepEqual(table.entitlement.map(r => r.totalDevelopmentCost), [69040000, 80700000, 92360000]);
  assert.deepEqual(table.entitlement.map(r => r.yieldOnCost), [0.0616, 0.0658, 0.069]);
  const custom = sensitivity(rental, null, {rent: [0.2], entitlement: [1.5]});
  assert.deepEqual(custom.table.rent.map(r => r.scenario), ['base', 'rent +20%']);
  assert.equal(custom.table.entitlement[1].scenario, 'entitlement ×1.5');
  assert.throws(() => sensitivity(rental, null, {cost: []}), /sensitivity\.cost must list 1 to 6 numbers/);
});

test('condo pro forma, checked by hand, and a condo with retail', () => {
  // Hard 70,000 × 600 = 42,000,000; soft 70,000 × 150 = 10,500,000; base 77,500,000; loan 55% = 42,625,000;
  // equity 34,875,000; carry = 9% × 3 years × 55% × (25,000,000 + 52,500,000 / 2) = 0.1485 × 51,250,000 = 7,610,625;
  // total cost 85,110,625. Sellout = 16,000 × 1,800 + 24,000 × 2,000 + 17,000 × 2,200 = 114,200,000; selling costs
  // 6% = 6,852,000; net 107,348,000. Profit = 22,237,375; margin on cost 26.13%, on revenue 20.72%; return on
  // equity 63.76%; equity multiple 1.64. No cap rate is needed, so the sensitivity table has no cap rate axis.
  const result = computeProForma(condo);
  assert.equal(result.development.totalDevelopmentCost, 85110625);
  assert.equal(result.development.equity, 34875000);
  assert.equal(result.operations, undefined);
  const {lines, ...sales} = result.sales;
  assert.deepEqual(sales, {grossSellout: 114200000, sellingCosts: 6852000, netSellout: 107348000, unitCount: 50});
  assert.equal(lines[2].sellout, 37400000);
  assert.deepEqual(result.returns, {value: 107348000, profit: 22237375, unleveredReturnOnCost: 0.2613, leveredReturnOnEquity: 0.6376, equityMultiple: 1.64, marginOnRevenue: 0.2072});
  // Independent axes: a pure condo reads sale prices, not rents, so its table carries the price axis
  // and no rent axis. Sale price +10%: gross 125,620,000 less 6% selling costs is net 118,082,800.
  const condoTable = sensitivity(condo).table;
  assert.deepEqual(Object.keys(condoTable), ['price', 'cost', 'entitlement']);
  assert.deepEqual(condoTable.price.map(r => r.scenario), ['sale price -10%', 'base', 'sale price +10%']);
  assert.equal(condoTable.price[2].value, 118082800);
  // Adding 2,000 sq ft of retail at 150 with 10% vacancy and 5/sq ft opex: NOI 300,000 − 30,000 − 10,000 = 260,000,
  // capitalized at 5% = 5,200,000 on top of the net sellout; the building area and so the budget do not change.
  const mixed = computeProForma({...condo, program: {...condo.program, commercial: [{use: 'retail', netSqft: 2000}]}, operating: {residentialVacancyRate: 0, residentialOpexPerUnitPerYear: 0, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 5}, capRate: 0.05});
  assert.equal(mixed.operations.noi, 260000);
  assert.equal(mixed.operations.unitCount, 0);
  assert.equal(mixed.operations.capitalizedValue, 5200000);
  assert.equal(mixed.returns.value, 112548000);
  assert.equal(mixed.development.totalDevelopmentCost, 85110625);
});

test('inputs are validated and every price must come from the market inputs', () => {
  assert.throws(() => computeProForma({...rental, market: undefined}), /Record market inputs with acres_market_inputs first/);
  assert.throws(() => computeProForma({...condo, sellingCostRate: undefined}), /sellingCostRate must be a number from 0 to 0.2/);
  assert.throws(() => computeProForma({...rental, capRate: undefined}), /capRate must be a number/);
  assert.throws(() => computeProForma({...rental, operating: undefined}), /operating\.residentialVacancyRate must be a number/);
  assert.throws(() => computeProForma({...rental, financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 30.5}}), /termMonths must be a whole number/);
  assert.throws(() => computeProForma({...rental, hardCostPerSqft: 4.5}), /hardCostPerSqft must be a number from 50 to 3000/);
  assert.throws(() => computeProForma({...rental, market: {...market, rents: market.rents.slice(0, 3)}}), /no rent per sq ft for three bedroom units/);
  assert.throws(() => computeProForma({...rental, market: {...market, commercialRents: undefined}}), /no retail rent per sq ft per year/);
  assert.throws(() => computeProForma({...condo, market: {...market, salePrices: undefined}}), /no sale price per sq ft for one bedroom units/);
  assert.throws(() => computeProForma({...rental, program: {...rental.program, units: [...rental.program.units, {bedrooms: 3, count: 1, netSqft: 900}]}}), /up to four bedroom types/);
  assert.throws(() => computeProForma({...rental, program: {...rental.program, commercial: [{use: 'hotel', netSqft: 100}]}}), /commercial\[0\]\.use must be one of/);
  assert.throws(() => computeProForma({...rental, productType: 'hotel'}), /rental, condo or commercial/);
});

test('the tool reads the recorded market inputs with their source IDs, emits and caps the count', async () => {
  const events = [];
  let ids = 0;
  const marketTools = createMarketTools({record: () => ({id: ++ids})});
  await marketTools.handlers.acres_market_inputs(market);
  const tools = createProFormaTools({emit: (event, data) => events.push({event, data}), getMarket: () => marketTools.market});
  assert.equal(tools.definitions[0].name, 'acres_pro_forma');
  const {market: _, ...args} = rental;
  const result = await tools.handlers.acres_pro_forma({...args, sensitivity: {capRateBps: [25]}});
  assert.equal(result.returns.value, 106249000);
  assert.deepEqual(result.sources[0], {source: 'StreetEasy market report', retrievedAt, sourceId: 1});
  assert.equal(result.operations.lines[0].sourceId, 1);
  assert.equal(result.operations.lines[1].sourceId, 2);
  assert.deepEqual(result.sensitivity.capRateBps.map(r => r.scenario), ['base', 'cap rate +25 bps']);
  assert.equal(result.sensitivity.rent.length, 3);
  assert.match(result.note, /not an IRR/);
  assert.equal(events[0].event, 'proforma.created');
  assert.equal(tools.proFormas.length, 1);
  assert.equal(tools.proFormas[0].name, 'As-of-right rental');
  const bare = createProFormaTools();
  await assert.rejects(bare.handlers.acres_pro_forma(args), /Record market inputs with acres_market_inputs first/);
  for (let i = 1; i < 4; i++) await tools.handlers.acres_pro_forma(args);
  await assert.rejects(tools.handlers.acres_pro_forma(args), /At most four pro formas/);
});

test('recompute swaps market figures and unit mix at the stated deal', () => {
  const {base, table} = sensitivity(rental);
  const stored = {...base, sensitivity: table, createdAt: '2026-10-12T00:00:00.000Z'};
  const dearer = {...market, rents: market.rents.map(r => ({...r, rentPerSqftPerMonth: r.rentPerSqftPerMonth * 1.5}))};
  const program = {productType: 'rental', residentialGrossSqft: 100000, byBedrooms: [
    {bedrooms: 0, units: 20, unitSqft: 450}, {bedrooms: 1, units: 40, unitSqft: 650},
    {bedrooms: 2, units: 30, unitSqft: 950}, {bedrooms: 3, units: 10, unitSqft: 1250}]};
  const derived = recomputeProForma(stored, {market: dearer, program});
  assert.equal(derived.derived, true);
  assert.match(derived.derivedNote, /previously stated gross building area/);
  assert.equal(derived.development.totalDevelopmentCost, stored.development.totalDevelopmentCost);
  assert.ok(derived.operations.noi > stored.operations.noi);
  assert.equal(derived.inputs.landPrice, rental.landPrice);
  assert.equal(recomputeProForma(stored, {market: dearer, program: {...program, productType: 'condo'}}), null);
  assert.equal(recomputeProForma({name: 'No inputs'}, {market: dearer, program}), null);
});

// The development ledger seam: the subject's land price estimate and current-assessment taxes.
const ledgerAt = '2026-10-16T06:00:00.000Z';
const fakeLedger = (over = {}) => ({
  landPriceEstimate: () => ({
    method: 'block_median', source: 'NYC development ledger: ACRIS land sales (bnx9-e6tj)', docIds: ['2026100100000003', '2026100100000001', '2026090100000009'],
    estimate: 20_000_000, pricePerZfaMedian: 200, pricePerZfaRange: [120, 1363.64], sampleSize: 3, maxZfa: 100000, reason: null,
    sales: [{docId: '2026100100000003', documentAmt: 30000000, pricePerZfa: 1363.64, recordedAt: '2026-10-03'}, {docId: '2026100100000001', documentAmt: 12000000, pricePerZfa: 120, recordedAt: '2026-10-01'}, {docId: '2026090100000009', documentAmt: 8000000, pricePerZfa: 200, recordedAt: '2026-09-15'}],
    basis: 'Land price = median $200 per max ZFA of 3 arm\'s-length ACRIS deeds on Manhattan block 15 x the subject max ZFA 100,000.',
    sourceUrl: 'https://data.cityofnewyork.us/d/bnx9-e6tj', retrievedAt: ledgerAt,
  }),
  taxes: () => ({
    annualTaxes: 444768, assessedValue: 4100000, marketValue: 9100000, taxClass: '4', rate: 0.10848, rateFiscalYear: 2026, assessmentFiscalYear: 2027, reason: null,
    basis: 'Real estate taxes = DOF FY2027 assessment $4,100,000 x class 4 FY2026 rate 10.848%.', crossCheck: 'Taxes are 4.89% of the DOF market value $9,100,000.',
    sourceUrl: 'https://data.cityofnewyork.us/d/8y4t-faws', retrievedAt: ledgerAt,
  }),
  ...over,
});

test('landPriceSource ledger fills land from the block estimate and cites the ACRIS deeds', async () => {
  const recorded = [];
  const tools = createProFormaTools({ledger: fakeLedger(), record: s => { recorded.push(s); return {id: `L${recorded.length}`}; }});
  const {landPrice: _, ...args} = rental;
  const result = await tools.handlers.acres_pro_forma({...args, landPriceSource: 'ledger'});
  assert.equal(result.inputs.landPrice, 20_000_000);
  assert.equal(result.returns.value, 106249000);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'official_record');
  assert.match(recorded[0].text, /2026100100000003/);
  assert.ok(result.derivation.some(l => /Land price = median \$200 per max ZFA/.test(l)));
  assert.deepEqual(result.sources.at(-1), {source: 'NYC development ledger: ACRIS land sales (bnx9-e6tj)', retrievedAt: '2026-10-16', sourceId: 'L1'});
  assert.deepEqual(result.inputs.landPriceBasis.docIds, ['2026100100000003', '2026100100000001', '2026090100000009']);
});

test('land price takes exactly one of landPrice or the ledger, and a null estimate fails with its reason', async () => {
  const tools = createProFormaTools({ledger: fakeLedger({landPriceEstimate: () => ({estimate: null, reason: 'fewer than three priced arm\'s-length deeds on the block (2)'})})});
  const {landPrice: _, market: m, ...args} = rental;
  await assert.rejects(tools.handlers.acres_pro_forma({...args, market: m, landPrice: 1, landPriceSource: 'ledger'}), /exactly one of landPrice or landPriceSource/);
  await assert.rejects(tools.handlers.acres_pro_forma({...args, market: m}), /exactly one of landPrice or landPriceSource/);
  await assert.rejects(tools.handlers.acres_pro_forma({...args, market: m, landPriceSource: 'ledger'}), /fewer than three/);
  await assert.rejects(createProFormaTools().handlers.acres_pro_forma({...args, market: m, landPriceSource: 'ledger'}), /development ledger is not available/);
  assert.deepEqual(proFormaDefinition.inputSchema.required.includes('landPrice'), false);
});

// A Brooklyn lot of 5,000 SF in R6A (FAR 3.0, so 15,000 SF as of right) with six development-site sales
// east of it a month ago and three arm's-length deeds on its own block at $50 per max ZFA; otherBoroughSales adds
// Queens sales beside them.
function landFixture({nearbySales = 6, ownSale = false, otherBoroughSales = 0} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proforma-land-'));
  const ledgerStore = new LedgerStore(join(dir, 'ledger.sqlite'));
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10), now = new Date().toISOString();
  for (let i = 0; i < nearbySales; i++) {
    const bbl = `30000000${String(i).padStart(2, '0')}`, latitude = 40.68, longitude = -73.95 + (i + 1) * 0.00191;
    ledgerStore.upsertDevelopmentSiteSale({doc_id: `S${i}`, bbl, recorded_at: day(30), price: [150, 250, 200, 300, 100, 200][i] * 5000, filing_job: `J${i}`, filing_type: 'New Building',
      filed_at: day(20), zip: '11216', latitude, longitude, query_url: 'https://data.cityofnewyork.us', fetched_at: now,
      pluto_json: JSON.stringify({bbl, lotarea: '2500', lotfront: '25', lotdepth: '100', lottype: '5', residfar: '2', affresfar: '0', zonedist1: 'R6B', borough: 'BK', zipcode: '11216', latitude, longitude})});
  }
  for (let i = 0; i < otherBoroughSales; i++) {
    const bbl = `40000000${String(i).padStart(2, '0')}`, latitude = 40.681, longitude = -73.95 + (i + 1) * 0.00191;
    ledgerStore.upsertDevelopmentSiteSale({doc_id: `Q${i}`, bbl, recorded_at: day(30), price: 200 * 5000, filing_job: `JQ${i}`, filing_type: 'New Building',
      filed_at: day(20), zip: '11385', latitude, longitude, query_url: 'https://data.cityofnewyork.us', fetched_at: now,
      pluto_json: JSON.stringify({bbl, lotarea: '2500', lotfront: '25', lotdepth: '100', lottype: '5', residfar: '2', affresfar: '0', zonedist1: 'R6B', borough: 'QN', zipcode: '11385', latitude, longitude})});
  }
  if (ownSale) {
    const bbl = '3999990001', latitude = 40.68, longitude = -73.95;
    ledgerStore.upsertDevelopmentSiteSale({doc_id: 'OWN', bbl, recorded_at: day(30), price: 900 * 5000, filing_job: 'JOWN', filing_type: 'New Building',
      filed_at: day(20), zip: '11216', latitude, longitude, query_url: 'https://data.cityofnewyork.us', fetched_at: now,
      pluto_json: JSON.stringify({bbl, lotarea: '2500', lotfront: '25', lotdepth: '100', lottype: '5', residfar: '2', affresfar: '0', zonedist1: 'R6B', borough: 'BK', zipcode: '11216', latitude, longitude})});
  }
  for (const [i, docId] of ['D1', 'D2', 'D3'].entries()) {
    ledgerStore.upsertLandSale({bbl: `39999900${String(i + 2).padStart(2, '0')}`, block: 99999, lot: i + 2, borough: '3', doc_id: docId, doc_type: 'DEED', document_amt: 500000, recorded_at: day(60),
      lot_area_sqft: 2500, zone_dist: 'R6A', zip: '11216', percent_trans: 100, lot_count: 1, bundled: 0, arms_length: 1, trim_reason: null, max_zfa_standard: 10000, max_zfa_affordable: null,
      price_per_zfa: 50, price_per_zfa_reason: null, query_url: 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json', dataset_updated_at: null, fetched_at: now, formula_version: FORMULA_VERSION});
  }
  for (const dataset of ['acris', 'development_site_sales']) ledgerStore.recordRun({run_id: 'r', dataset, dataset_id: 'bnx9-e6tj', since: day(90), until: now, rows_fetched: 3, inserted: 3, updated: 0, unchanged: 0, trimmed: 0, status: 'ok', started_at: now, finished_at: now});
  const market = new MarketStore(join(dir, 'market.sqlite'));
  market.ledgerPath = join(dir, 'ledger.sqlite');
  const property = {bbl: '3999990001', lotarea: '5000', lotfront: '50', lotdepth: '100', lottype: '5', residfar: '3', affresfar: '3.9', zonedist1: 'R6A', borough: 'BK', zipcode: '11216', latitude: '40.68', longitude: '-73.95'};
  const ledger = createSubjectLedger({getProperty: () => property, openLedger: () => ledgerStore, nearbyLand: p => market.lotNearbyLand({bbl: p.bbl, property: p})});
  return {ledger, market, property, close: () => { market.close(); ledgerStore.close(); rmSync(dir, {recursive: true, force: true}); }};
}

test('landPriceSource ledger prices land with the nearby development-site model the site page shows', async () => {
  const {ledger, market, property, close} = landFixture();
  try {
    const recorded = [];
    const tools = createProFormaTools({ledger, record: s => { recorded.push(s); return {id: `L${recorded.length}`}; }});
    const {landPrice: _, ...args} = rental;
    const result = await tools.handlers.acres_pro_forma({...args, landPriceSource: 'ledger'});
    const appraisal = market.appraisedLandFor({...parcelListingRow(property), bbl: property.bbl});
    assert.equal(appraisal.saleCount, 6);
    assert.equal(result.inputs.landPrice, appraisal.pricePerBsf * 15000, 'the nearby price per buildable SF on the lot\'s as-of-right area');
    assert.notEqual(result.inputs.landPrice, 50 * 15000, 'not the block median');
    assert.equal(result.inputs.landPriceBasis.method, 'nearby_model');
    assert.deepEqual(result.inputs.landPriceBasis.docIds, appraisal.model.comps.map(c => c.docId));
    assert.match(result.inputs.landPriceBasis.basis, /development-site sales in the lot's borough within/);
    assert.match(result.inputs.landPriceBasis.basis, /block/, 'the block median is stated beside it');
    assert.equal(result.sources.at(-1).source, 'NYC development ledger: nearby development-site sales (ACRIS bnx9-e6tj, DOB filings)');
  } finally { close(); }
});

test('landPriceSource ledger falls back to the block median only where the nearby model has fewer than six sales', async () => {
  const {ledger, close} = landFixture({nearbySales: 4});
  try {
    const {landPrice: _, ...args} = rental;
    const result = await createProFormaTools({ledger}).handlers.acres_pro_forma({...args, landPriceSource: 'ledger'});
    assert.equal(result.inputs.landPriceBasis.method, 'block_median');
    assert.equal(result.inputs.landPrice, 50 * 15000);
    assert.match(result.inputs.landPriceBasis.basis, /The nearby development-site model gives no figure: only 4 development-site sales were recorded in the lot's borough within 2 miles in the 24 months before \d{4}-\d{2}-\d{2}, fewer than 6\.$/);
    assert.equal(result.sources.at(-1).source, 'NYC development ledger: ACRIS land sales (bnx9-e6tj)');
  } finally { close(); }
});

test('a lot with sales across a borough line but fewer than six in its own borough counts only its own borough\'s', async () => {
  const {ledger, market, property, close} = landFixture({nearbySales: 4, otherBoroughSales: 8});
  try {
    assert.match(market.lotNearbyLand({bbl: property.bbl, property}).reason, /^only 4 development-site sales were recorded in the lot's borough within 2 miles in the 24 months before /);
    const queensLot = {...property, bbl: '4999990001', borough: 'QN'};
    assert.equal(market.lotNearbyLand({bbl: queensLot.bbl, property: queensLot}).sales, 8, 'the other borough\'s lot is valued from its own sales');
    const {landPrice: _, ...args} = rental;
    const result = await createProFormaTools({ledger}).handlers.acres_pro_forma({...args, landPriceSource: 'ledger'});
    assert.equal(result.inputs.landPriceBasis.method, 'block_median');
    assert.match(result.inputs.landPriceBasis.basis, /The nearby development-site model gives no figure: only 4 development-site sales were recorded in the lot's borough within 2 miles/);
  } finally { close(); }
});

test('a lot without a nearby land figure says why: no coordinates, no residential floor area, no earlier sales, no ledger', () => {
  const {market, property, close} = landFixture();
  try {
    const reason = p => market.lotNearbyLand({bbl: p.bbl, property: p}).reason;
    assert.equal(reason({...property, latitude: null, longitude: null}), 'the lot has no coordinates to find nearby sales from');
    assert.equal(reason({...property, zonedist1: 'M1-2', residfar: '0', affresfar: '0'}), "the lot's zoning gives it no as-of-right residential floor area to price");
    const before = new Date(Date.now() - 40 * 86400000);
    assert.match(market.lotNearbyLand({bbl: property.bbl, property, now: before}).reason, /^only 0 development-site sales were recorded in the lot's borough within 2 miles in the 24 months before /, 'sales after the as-of date are left out');
    assert.equal(market.lotNearbyLand({bbl: property.bbl, property}).sales, 6);
    market.ledgerPath = join(tmpdir(), 'no-such-ledger.sqlite');
    assert.equal(reason(property), 'the development ledger has no development-site sales synced');
  } finally { close(); }
});

test('a lot valued from its parcel record leaves its own development-site sale out of the nearby land price', () => {
  const {market, property, close} = landFixture({ownSale: true});
  try {
    const {source, nearbyLand} = market.lotValuation({bbl: property.bbl, property});
    assert.equal(source, 'parcel');
    assert.equal(nearbyLand.sales, 6);
    assert.ok(!nearbyLand.model.comps.some(c => c.docId === 'OWN'), 'the lot\'s own sale is not its comp');
    assert.equal(market.lotNearbyLand({bbl: property.bbl, property}).value, nearbyLand.value, 'the chat figure matches the plan page');
  } finally { close(); }
});

test('taxSource ledger adds a separate real estate tax line from the assessment', async () => {
  const recorded = [];
  const tools = createProFormaTools({ledger: fakeLedger(), record: s => { recorded.push(s); return {id: `T${recorded.length}`}; }});
  const plain = await createProFormaTools().handlers.acres_pro_forma(rental);
  const taxed = await tools.handlers.acres_pro_forma({...rental, taxSource: 'ledger'});
  assert.equal(plain.operations.realEstateTaxes, undefined, 'without taxSource opex stays tax-inclusive');
  assert.equal(taxed.operations.realEstateTaxes, 444768);
  assert.equal(taxed.operations.operatingExpenses, plain.operations.operatingExpenses + 444768);
  assert.equal(taxed.operations.noi, plain.operations.noi - 444768);
  assert.ok(taxed.derivation.some(l => /Real estate taxes = DOF FY2027 assessment/.test(l)));
  assert.ok(taxed.derivation.some(l => /market value \$9,100,000/.test(l)), 'market value is a cross-check line');
  assert.ok(taxed.derivation.some(l => /excluding real estate taxes/.test(l)));
  assert.equal(recorded[0].kind, 'official_record');
  assert.ok(taxed.sources.some(s => s.sourceId === 'T1'));
  await assert.rejects(tools.handlers.acres_pro_forma({...condo, taxSource: 'ledger'}), /taxSource applies to rental/);
  await assert.rejects(createProFormaTools({ledger: fakeLedger({taxes: () => ({annualTaxes: null, reason: 'no DOF assessment for BBL 1000150001'})})}).handlers.acres_pro_forma({...rental, taxSource: 'ledger'}), /no DOF assessment/);
  assert.match(proFormaDefinition.inputSchema.properties.operating.properties.residentialOpexPerUnitPerYear.description, /excluding real estate taxes when taxSource is ledger/);

  const program = {productType: 'rental', byBedrooms: [{bedrooms: 0, units: 20, unitSqft: 450}, {bedrooms: 1, units: 40, unitSqft: 650}, {bedrooms: 2, units: 30, unitSqft: 950}, {bedrooms: 3, units: 10, unitSqft: 1250}]};
  const again = recomputeProForma(taxed, {market, program});
  assert.equal(again.operations.realEstateTaxes, 444768, 'recompute keeps the stated tax line');
});
