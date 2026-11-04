// Pure-calculation development pro forma for one concept. Every output is arithmetic on the inputs
// echoed in the result, and the derivation lines show the numbers used, so the model explains and
// the code computes. Money is USD, areas are sq ft, rates are fractions (0.065 is 6.5 percent),
// the financing term is months of interest-only carry from land closing to stabilization or sellout.
import {BEDROOM_LABELS, COMMERCIAL_USES, coreEfficiencyAssumption, normalizeMarketInputs, num, int} from './market.mjs';
import {proFormaBudget} from './budget-lines.mjs';
import {HPD_AFFORDABLE_RENTS, NYC_485X, affordableRent485x, dofFullTaxes, exemptionValue485x, normalizeTaxIncentive, plan485x, planDerivation, restrictedUnits485x, withoutBenefit} from './tax-485x.mjs';

const round = (n, d = 0) => {
  if (!Number.isFinite(n)) throw new Error('The pro forma produced a non-finite figure. Check scenario costs, equity and capitalization rate.');
  return Number(n.toFixed(d));
};
const usd = n => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
const pct = (n, d = 2) => `${(n * 100).toFixed(d)}%`;
const DEFAULT_SENSITIVITY = {rent: [-0.1, 0.1], price: [-0.1, 0.1], cost: [-0.1, 0.1], capRateBps: [-50, 50], entitlement: [0.8, 1.2]};

function lookup(list, key, value, what) {
  const row = (list ?? []).find(r => r[key] === value);
  if (!row) throw new Error(`The market inputs have no ${what}. Record it with acres_market_inputs or pass it in market.`);
  return row;
}

export function normalizeProgram(program) {
  if (!program || typeof program !== 'object') throw new Error('program is required.');
  num(program.grossBuildingSqft, 'program.grossBuildingSqft', 500, 20_000_000);
  if (!Array.isArray(program.units) || program.units.length > 4) throw new Error('program.units must list up to four bedroom types.');
  const units = program.units.map((row, i) => ({bedrooms: int(row.bedrooms, `program.units[${i}].bedrooms`, 0, 3), count: int(row.count, `program.units[${i}].count`, 0, 10000), netSqft: num(row.netSqft, `program.units[${i}].netSqft`, 250, 5000)}));
  if (new Set(units.map(u => u.bedrooms)).size !== units.length) throw new Error('program.units must have one row per bedroom count.');
  const commercial = (program.commercial ?? []).map((row, i) => {
    if (!COMMERCIAL_USES.includes(row?.use)) throw new Error(`program.commercial[${i}].use must be one of ${COMMERCIAL_USES.join(', ')}.`);
    return {use: row.use, netSqft: num(row.netSqft, `program.commercial[${i}].netSqft`, 0, 10_000_000)};
  });
  if (new Set(commercial.map(c => c.use)).size !== commercial.length) throw new Error('program.commercial must have one row per use.');
  if (!units.some(u => u.count > 0) && !commercial.some(c => c.netSqft > 0)) throw new Error('program must include at least one unit or some commercial area.');
  const netArea = units.reduce((sum, unit) => sum + unit.count * unit.netSqft, 0) + commercial.reduce((sum, space) => sum + space.netSqft, 0);
  // Ignore floating-point noise of at most one millionth of a square foot.
  if (netArea - program.grossBuildingSqft > 1e-6) throw new Error(`program net area (${netArea} sq ft) exceeds program.grossBuildingSqft (${program.grossBuildingSqft} sq ft). Correct the area, unit counts or sizes.`);
  return {grossBuildingSqft: program.grossBuildingSqft, units, commercial};
}

function normalize(args, market, facts = {}) {
  if (!['rental', 'condo', 'commercial'].includes(args.productType)) throw new Error('productType must be rental, condo or commercial.');
  const program = normalizeProgram(args.program);
  const commercialSqft = program.commercial.reduce((sum, c) => sum + c.netSqft, 0);
  // Commercial is a wholly non-residential building (retail, office or community facility) held for its
  // income. A building with homes in it, commercial space included, is mixed-use and stays a rental or
  // condo program with commercial rows, priced by the same operations.
  if (args.productType === 'commercial') {
    if (!(commercialSqft > 0)) throw new Error('productType "commercial" needs program.commercial area (retail, office or community_facility); a residential building is rental or condo.');
    if (program.units.some(u => u.count > 0)) throw new Error('productType "commercial" takes no residential units; a mixed-use building is a rental or condo program with commercial rows.');
  }
  const income = args.productType !== 'condo' || commercialSqft > 0;
  const f = args.financing ?? {}, o = args.operating ?? {};
  const inputs = {
    name: typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 80) : 'Pro forma',
    productType: args.productType, program, market,
    landPrice: num(facts.land ? facts.land.estimate : args.landPrice, 'landPrice', 0, 5_000_000_000),
    hardCostPerSqft: num(args.hardCostPerSqft, 'hardCostPerSqft', 50, 3000),
    softCostPerSqft: num(args.softCostPerSqft, 'softCostPerSqft', 0, 1500),
    financing: {loanToCost: num(f.loanToCost, 'financing.loanToCost', 0, 0.95), interestRate: num(f.interestRate, 'financing.interestRate', 0, 0.3), termMonths: int(f.termMonths, 'financing.termMonths', 1, 120)},
  };
  if (income) {
    inputs.operating = {residentialVacancyRate: num(o.residentialVacancyRate, 'operating.residentialVacancyRate', 0, 0.5), residentialOpexPerUnitPerYear: num(o.residentialOpexPerUnitPerYear, 'operating.residentialOpexPerUnitPerYear', 0, 100000), commercialVacancyRate: num(o.commercialVacancyRate, 'operating.commercialVacancyRate', 0, 0.5), commercialOpexPerSqftPerYear: num(o.commercialOpexPerSqftPerYear, 'operating.commercialOpexPerSqftPerYear', 0, 500)};
    inputs.capRate = num(args.capRate, 'capRate', 0.02, 0.15);
  }
  if (args.productType === 'condo') inputs.sellingCostRate = num(args.sellingCostRate, 'sellingCostRate', 0, 0.2);
  if (facts.land) inputs.landPriceBasis = facts.land;
  if (args.taxIncentive !== undefined) inputs.taxIncentive = normalizeTaxIncentive(args.taxIncentive, args.productType, facts);
  else if (facts.taxes) {
    if (args.productType === 'condo') throw new Error('taxSource applies to rental and commercial pro formas; condo sellouts carry no stabilized operating taxes.');
    inputs.realEstateTaxes = facts.taxes;
  }
  return inputs;
}

function budget(inputs) {
  const {landPrice, hardCostPerSqft, softCostPerSqft, program: {grossBuildingSqft}, financing: {loanToCost, interestRate, termMonths}} = inputs;
  const hardCost = hardCostPerSqft * grossBuildingSqft, softCost = softCostPerSqft * grossBuildingSqft;
  const baseCost = landPrice + hardCost + softCost;
  const years = termMonths / 12;
  // Land is drawn at closing and outstanding for the whole term; hard and soft costs are drawn
  // evenly, so half the construction loan is outstanding on average. Interest-only carry, simple
  // interest, funded from an interest reserve added to the loan.
  const interestCarry = interestRate * years * loanToCost * (landPrice + (hardCost + softCost) / 2);
  const loan = loanToCost * baseCost, equity = baseCost - loan, loanWithReserve = loan + interestCarry;
  const totalDevelopmentCost = baseCost + interestCarry;
  return {
    landPrice, hardCost, softCost, baseCost, interestCarry, totalDevelopmentCost, loan, interestReserve: interestCarry, loanWithReserve, equity,
    effectiveLoanToCost: loanWithReserve / totalDevelopmentCost, costPerGrossSqft: totalDevelopmentCost / grossBuildingSqft,
    derivation: [
      `Hard cost = ${grossBuildingSqft.toLocaleString('en-US')} sq ft × ${usd(hardCostPerSqft)}/sq ft = ${usd(hardCost)}`,
      `Soft cost = ${grossBuildingSqft.toLocaleString('en-US')} sq ft × ${usd(softCostPerSqft)}/sq ft = ${usd(softCost)}`,
      `Base cost = land ${usd(landPrice)} + hard ${usd(hardCost)} + soft ${usd(softCost)} = ${usd(baseCost)}`,
      `Loan = ${pct(loanToCost, 0)} loan to cost × ${usd(baseCost)} = ${usd(loan)}; equity = ${usd(equity)}`,
      `Interest carry = ${pct(interestRate)} × ${round(years, 2)} years × ${pct(loanToCost, 0)} × (land ${usd(landPrice)} + half of construction ${usd((hardCost + softCost) / 2)}) = ${usd(interestCarry)}`,
      `Total development cost = ${usd(baseCost)} + ${usd(interestCarry)} = ${usd(totalDevelopmentCost)}`,
    ],
  };
}

// Restricted 485-x units under Options A and B earn the lesser of HPD's maximum rent at the AMI band
// and the market rent for the unit; Option C units start at market rents.
function income(inputs, plan = null) {
  const {program, market, operating, productType} = inputs;
  const lines = [], derivation = [];
  let residentialGpr = 0, unitCount = 0;
  if (productType === 'rental') for (const u of program.units) {
    const rent = lookup(market.rents, 'bedrooms', u.bedrooms, `rent per sq ft for ${BEDROOM_LABELS[u.bedrooms].toLowerCase()} units`);
    const restricted = plan?.amiPct ? plan.restricted.find(r => r.bedrooms === u.bedrooms).count : 0, marketCount = u.count - restricted;
    const annual = marketCount * u.netSqft * rent.rentPerSqftPerMonth * 12;
    residentialGpr += annual; unitCount += u.count;
    lines.push({line: BEDROOM_LABELS[u.bedrooms], units: marketCount, netSqft: marketCount * u.netSqft, rentPerSqftPerMonth: rent.rentPerSqftPerMonth, annualRent: round(annual), source: rent.source, retrievedAt: rent.retrievedAt, sourceId: rent.sourceId ?? null});
    derivation.push(`${BEDROOM_LABELS[u.bedrooms]} rent = ${marketCount} × ${u.netSqft} sq ft × ${usd(rent.rentPerSqftPerMonth)}/sq ft/month × 12 = ${usd(annual)}`);
    if (restricted > 0) {
      const monthlyRent = Math.min(affordableRent485x(plan.amiPct, u.bedrooms), u.netSqft * rent.rentPerSqftPerMonth), restrictedAnnual = restricted * monthlyRent * 12;
      residentialGpr += restrictedAnnual;
      lines.push({line: `${BEDROOM_LABELS[u.bedrooms]}, ${plan.amiPct}% AMI`, units: restricted, netSqft: restricted * u.netSqft, monthlyRent, annualRent: round(restrictedAnnual), source: HPD_AFFORDABLE_RENTS.source, retrievedAt: HPD_AFFORDABLE_RENTS.asOf, sourceId: null});
      derivation.push(`${BEDROOM_LABELS[u.bedrooms]} ${plan.amiPct}% AMI rent = ${restricted} × ${usd(monthlyRent)}/month (lesser of HPD maximum ${usd(affordableRent485x(plan.amiPct, u.bedrooms))} and market) × 12 = ${usd(restrictedAnnual)}`);
    }
  }
  let commercialGpr = 0, commercialSqft = 0;
  for (const c of program.commercial) {
    const rent = lookup(market.commercialRents, 'use', c.use, `${c.use} rent per sq ft per year`);
    const annual = c.netSqft * rent.rentPerSqftPerYear;
    commercialGpr += annual; commercialSqft += c.netSqft;
    lines.push({line: c.use, netSqft: c.netSqft, rentPerSqftPerYear: rent.rentPerSqftPerYear, annualRent: round(annual), source: rent.source, retrievedAt: rent.retrievedAt, sourceId: rent.sourceId ?? null});
    derivation.push(`${c.use} rent = ${c.netSqft.toLocaleString('en-US')} sq ft × ${usd(rent.rentPerSqftPerYear)}/sq ft/year = ${usd(annual)}`);
  }
  const grossPotentialRent = residentialGpr + commercialGpr;
  const vacancyLoss = residentialGpr * operating.residentialVacancyRate + commercialGpr * operating.commercialVacancyRate;
  const effectiveGrossIncome = grossPotentialRent - vacancyLoss;
  const operatingCosts = unitCount * operating.residentialOpexPerUnitPerYear + commercialSqft * operating.commercialOpexPerSqftPerYear;
  const exemption = plan && incentiveTaxes(inputs.taxIncentive, plan, effectiveGrossIncome - operatingCosts);
  const taxes = exemption ? {annualTaxes: exemption.year1Payable, basis: exemption.basis.join('; ')} : inputs.realEstateTaxes;
  const operatingExpenses = operatingCosts + (taxes ? taxes.annualTaxes : 0);
  const noi = effectiveGrossIncome - operatingExpenses;
  derivation.push(
    `Vacancy = ${usd(residentialGpr)} × ${pct(operating.residentialVacancyRate, 1)} + ${usd(commercialGpr)} × ${pct(operating.commercialVacancyRate, 1)} = ${usd(vacancyLoss)}`,
    taxes
      ? `Operating expenses excluding real estate taxes = ${unitCount} units × ${usd(operating.residentialOpexPerUnitPerYear)} + ${commercialSqft.toLocaleString('en-US')} sq ft × ${usd(operating.commercialOpexPerSqftPerYear)} = ${usd(operatingCosts)}`
      : `Operating expenses = ${unitCount} units × ${usd(operating.residentialOpexPerUnitPerYear)} + ${commercialSqft.toLocaleString('en-US')} sq ft × ${usd(operating.commercialOpexPerSqftPerYear)} = ${usd(operatingExpenses)}`,
    ...(taxes ? [taxes.basis, ...(taxes.crossCheck ? [`Cross-check: ${taxes.crossCheck}`] : []), `Operating expenses = ${usd(operatingCosts)} + real estate taxes ${usd(taxes.annualTaxes)} = ${usd(operatingExpenses)}`] : []),
    `NOI = ${usd(grossPotentialRent)} − ${usd(vacancyLoss)} − ${usd(operatingExpenses)} = ${usd(noi)}`,
  );
  return {lines, residentialGpr, commercialGpr, grossPotentialRent, vacancyLoss, effectiveGrossIncome, operatingExpenses, ...(taxes && {realEstateTaxes: taxes.annualTaxes}), noi, unitCount, commercialSqft, derivation, ...(exemption && {exemption})};
}

// Year-one taxes under 485-x and the present value of the taxes exempted. Full taxes are stated or
// estimated by the DOF income method from NOI before taxes; base taxes stay payable throughout.
function incentiveTaxes(incentive, plan, noiBeforeTaxes) {
  const dof = incentive.fullAnnualTaxes === undefined ? dofFullTaxes(noiBeforeTaxes, incentive.dofCapRate) : null;
  const fullTaxes = dof ? dof.annualTaxes : incentive.fullAnnualTaxes;
  const value = exemptionValue485x({fullTaxes, baseTaxes: incentive.baseAnnualTaxes, schedule: plan.schedule, nonResidentialShare: plan.nonResidentialShare, discountRate: incentive.discountRate});
  const basis = [
    dof ? dof.basis : `Full taxes on the completed building, stated: ${usd(fullTaxes)}`,
    incentive.baseTaxFact ? `Base taxes (§ 5(a), pre-commencement assessment): ${incentive.baseTaxFact.basis}` : `Base taxes on the pre-commencement assessment (§ 5(a)), stated: ${usd(incentive.baseAnnualTaxes)}`,
    plan.eligible
      ? `Year-one taxes under 485-x = full ${usd(fullTaxes)} − ${pct(value.periods[0].exemption, 1)} × (full − base ${usd(incentive.baseAnnualTaxes)})${value.reduction > 0 ? ` (exemption cut ${pct(value.reduction, 1)} for non-residential area above 12%, § 6)` : ''} = ${usd(value.year1Payable)}; present value of taxes exempted over ${value.benefitYears} years at ${pct(incentive.discountRate)}, taxes held at the year-one level = ${usd(value.presentValue)}`
      : `Taxes without 485-x = full ${usd(fullTaxes)}`,
  ];
  return {...value, fullTaxes, basis};
}

function sellout(inputs) {
  const {program, market, sellingCostRate} = inputs;
  const lines = [], derivation = [];
  let grossSellout = 0, unitCount = 0;
  for (const u of program.units) {
    const price = lookup(market.salePrices, 'bedrooms', u.bedrooms, `sale price per sq ft for ${BEDROOM_LABELS[u.bedrooms].toLowerCase()} units`);
    const proceeds = u.count * u.netSqft * price.pricePerSqft;
    grossSellout += proceeds; unitCount += u.count;
    lines.push({line: BEDROOM_LABELS[u.bedrooms], units: u.count, netSqft: u.count * u.netSqft, pricePerSqft: price.pricePerSqft, sellout: round(proceeds), source: price.source, retrievedAt: price.retrievedAt, sourceId: price.sourceId ?? null});
    derivation.push(`${BEDROOM_LABELS[u.bedrooms]} sellout = ${u.count} × ${u.netSqft} sq ft × ${usd(price.pricePerSqft)}/sq ft = ${usd(proceeds)}`);
  }
  const sellingCosts = grossSellout * sellingCostRate, netSellout = grossSellout - sellingCosts;
  derivation.push(`Net sellout = ${usd(grossSellout)} − ${pct(sellingCostRate, 1)} selling costs ${usd(sellingCosts)} = ${usd(netSellout)}`);
  return {lines, grossSellout, sellingCosts, netSellout, unitCount, derivation};
}

const money = object => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]));
const rate = (n, d = 4) => round(n, d);

// Sensitivities may go beyond the base underwriting ranges, but must remain finite and economic.
// With a tax incentive, strict runs fail on an ineligible program; sensitivity rows and the comparison
// without 485-x carry full taxes instead. plan overrides the incentive's own plan.
function computeFrom(inputs, {strict = true, plan: forced = null} = {}) {
  const plan = forced ?? (inputs.taxIncentive ? plan485x(inputs.taxIncentive, inputs.program) : null);
  if (plan && !plan.eligible && strict) throw new Error(`taxIncentive: ${plan.reason}`);
  const dev = budget(plan?.hardCostPremium ? {...inputs, hardCostPerSqft: inputs.hardCostPerSqft * (1 + plan.hardCostPremium)} : inputs);
  const {derivation: budgetDerivation, effectiveLoanToCost, costPerGrossSqft, ...dollars} = dev;
  const result = {name: inputs.name, productType: inputs.productType, development: {...money(dollars), effectiveLoanToCost: rate(effectiveLoanToCost), costPerGrossSqft: round(costPerGrossSqft, 2)}, derivation: [...(inputs.landPriceBasis ? [inputs.landPriceBasis.basis] : []), ...(plan ? planDerivation(plan, inputs.taxIncentive) : []), ...budgetDerivation]};
  // A program whose net area is nearly its gross area sells or rents the core; say so with the results.
  const netArea = inputs.program.units.reduce((sum, u) => sum + u.count * u.netSqft, 0) + inputs.program.commercial.reduce((sum, c) => sum + c.netSqft, 0);
  const coreFlag = coreEfficiencyAssumption(netArea / inputs.program.grossBuildingSqft);
  if (coreFlag) result.assumptions = [coreFlag];
  const hasCommercial = inputs.program.commercial.some(c => c.netSqft > 0);
  if (inputs.productType !== 'condo' || hasCommercial) {
    const op = income({...inputs, program: inputs.productType === 'condo' ? {...inputs.program, units: []} : inputs.program}, plan);
    const {lines, derivation, exemption, ...operations} = op;
    // A temporary exemption is not capitalized: value is NOI at full taxes over the cap rate plus the
    // present value of the taxes exempted.
    const noiAtFullTaxes = exemption ? op.noi - exemption.year1Savings : op.noi;
    const value = noiAtFullTaxes / inputs.capRate + (exemption ? exemption.presentValue : 0);
    result.operations = {...money(operations), yieldOnCost: rate(op.noi / dev.totalDevelopmentCost), capRate: inputs.capRate, developmentSpreadBps: round((op.noi / dev.totalDevelopmentCost - inputs.capRate) * 10000), capitalizedValue: round(value), lines};
    result.derivation.push(...derivation, `Yield on cost = NOI ${usd(op.noi)} ÷ total development cost ${usd(dev.totalDevelopmentCost)} = ${pct(op.noi / dev.totalDevelopmentCost)}`,
      exemption ? `Value = NOI at full taxes ${usd(noiAtFullTaxes)} ÷ cap rate ${pct(inputs.capRate)} + present value of taxes exempted ${usd(exemption.presentValue)} = ${usd(value)}` : `Value = NOI ${usd(op.noi)} ÷ cap rate ${pct(inputs.capRate)} = ${usd(value)}`);
    if (exemption) result.taxIncentive = incentiveSummary(inputs, plan, exemption, noiAtFullTaxes, dev);
  }
  if (inputs.productType === 'condo') {
    const sale = sellout(inputs);
    const {lines, derivation, ...sales} = sale;
    result.sales = {...money(sales), lines};
    result.derivation.push(...derivation);
  }
  const value = (result.operations?.capitalizedValue ?? 0) + (result.sales?.netSellout ?? 0);
  const profit = value - dev.totalDevelopmentCost;
  const returns = {value: round(value), profit: round(profit), unleveredReturnOnCost: rate(profit / dev.totalDevelopmentCost), leveredReturnOnEquity: rate(profit / dev.equity), equityMultiple: rate((dev.equity + profit) / dev.equity, 2)};
  result.derivation.push(`Profit = value ${usd(value)} − total development cost ${usd(dev.totalDevelopmentCost)} = ${usd(profit)}`, `Unlevered return on cost = ${usd(profit)} ÷ ${usd(dev.totalDevelopmentCost)} = ${pct(profit / dev.totalDevelopmentCost)}; levered return on equity = ${usd(profit)} ÷ ${usd(dev.equity)} = ${pct(profit / dev.equity)}`);
  if (inputs.productType !== 'condo') {
    const debtService = dev.loanWithReserve * inputs.financing.interestRate;
    Object.assign(returns, {annualDebtService: round(debtService), debtServiceCoverage: debtService > 0 ? rate(result.operations.noi / debtService, 2) : null, cashOnCash: rate((result.operations.noi - debtService) / dev.equity)});
    result.derivation.push(`Cash on cash = (NOI ${usd(result.operations.noi)} − interest-only debt service ${usd(debtService)}) ÷ equity ${usd(dev.equity)} = ${pct((result.operations.noi - debtService) / dev.equity)}`);
  }
  if (inputs.productType === 'condo') Object.assign(returns, {marginOnRevenue: value > 0 ? rate(profit / value) : null});
  result.returns = returns;
  const cited = [...(result.operations?.lines ?? []), ...(result.sales?.lines ?? []), ...[inputs.realEstateTaxes, inputs.landPriceBasis, inputs.taxIncentive?.baseTaxFact].filter(Boolean), ...(inputs.taxIncentive ? [{source: NYC_485X.source, retrievedAt: NYC_485X.asOf}] : [])];
  result.sources = [...new Map(cited.map(l => [l.sourceId ? `id:${l.sourceId}` : `${l.source}|${l.retrievedAt}`, {source: l.source, retrievedAt: l.retrievedAt, sourceId: l.sourceId}])).values()];
  result.inputs = {...inputs, market: {submarket: inputs.market.submarket}};
  return result;
}

function incentiveSummary(inputs, plan, exemption, noiAtFullTaxes, dev) {
  const t = inputs.taxIncentive;
  return {
    program: '485-x', option: t.option, zone: t.zone, eligible: plan.eligible, ...(!plan.eligible && {reason: plan.reason}),
    ...(plan.eligible && {projectClass: plan.projectClass, label: plan.label, restrictedUnits: plan.restricted, restrictedCount: plan.restrictedCount, amiPct: plan.amiPct, affordabilityPct: rate(plan.affordabilityPct)}),
    units: plan.units, benefitYears: exemption.benefitYears,
    schedule: exemption.periods.map(p => ({fromYear: p.fromYear, toYear: p.toYear, exemption: rate(p.exemption), annualTaxes: round(p.payable), annualSavings: round(p.savings)})),
    fullAnnualTaxes: round(exemption.fullTaxes), baseAnnualTaxes: round(t.baseAnnualTaxes), year1Taxes: round(exemption.year1Payable), year1Savings: round(exemption.year1Savings),
    exemptionPresentValue: round(exemption.presentValue), discountRate: t.discountRate,
    noiAtFullTaxes: round(noiAtFullTaxes), yieldOnCostAtFullTaxes: rate(noiAtFullTaxes / dev.totalDevelopmentCost),
    wageFloorHourly: plan.wage ? round(plan.wage.hourly, 2) : null, wageFloorUpperBound: plan.wage?.upperBound ?? false, hardCostPremium: rate(plan.hardCostPremium),
  };
}

// The same inputs with no 485-x: market rents on every unit, full taxes, no wage floor.
function without485x(inputs) {
  const units = inputs.program.units.reduce((s, u) => s + u.count, 0), share = inputs.program.commercial.reduce((s, c) => s + c.netSqft, 0) / inputs.program.grossBuildingSqft;
  return computeFrom(inputs, {strict: false, plan: withoutBenefit('comparison case without 485-x.', units, share)});
}

// The same building held to 99 units under Option B: 99 whole units in the program's bedroom mix
// (largest remainders rounded up), gross and commercial area and any stated full taxes scaled pro
// rata at the same land price, with no construction wage floor (§ 3); null unless the program took
// Option A.
function at99Units(inputs, result) {
  const t = result.taxIncentive;
  if (!t?.eligible || t.option !== 'A') return null;
  const factor = 99 / t.units, incentive = inputs.taxIncentive;
  const taxIncentive = {...incentive, option: 'B', ...(incentive.fullAnnualTaxes !== undefined && {fullAnnualTaxes: incentive.fullAnnualTaxes * factor})};
  const scaled = vary(inputs, 'entitlement', factor);
  const units = restrictedUnits485x(inputs.program.units, factor).map((u, i) => ({...inputs.program.units[i], count: u.count}));
  return {...headline('99 units under 485-x Option B', computeFrom({...scaled, program: {...scaled.program, units}, taxIncentive})), units: 99};
}

// The whole model for one set of inputs. Dollar lines are rounded to whole dollars and rates to
// four decimals; the derivation strings and the market sources used come with them.
export function computeProForma(args, recordedMarket = null) {
  const market = args.market ? normalizeMarketInputs(args.market) : recordedMarket;
  if (!market) throw new Error('Record market inputs with acres_market_inputs first, or pass market.');
  const inputs = normalize(args, market), result = computeFrom(inputs);
  if (inputs.taxIncentive) Object.assign(result.taxIncentive, {without485x: headline('without 485-x', without485x(inputs)), at99Units: at99Units(inputs, result)});
  return result;
}

// One-way sensitivities: each axis varies one input and reports the headline results. Rent and
// cost steps are fractions of the base figure, cap rate steps are basis points, and the entitlement
// multiplier scales the building (gross area, unit counts pro rata and commercial area) against a
// fixed land price.
const scaled = (list, field, factor) => list?.map(r => ({...r, [field]: r[field] * factor}));
function vary(inputs, axis, step) {
  const market = inputs.market;
  // Independent axes: rent moves rents (residential and commercial) only; price moves sale prices only.
  if (axis === 'rent') return {...inputs, market: {...market, rents: scaled(market.rents, 'rentPerSqftPerMonth', 1 + step), commercialRents: scaled(market.commercialRents, 'rentPerSqftPerYear', 1 + step)}};
  if (axis === 'price') return {...inputs, market: {...market, salePrices: scaled(market.salePrices, 'pricePerSqft', 1 + step)}};
  if (axis === 'cost') return {...inputs, hardCostPerSqft: inputs.hardCostPerSqft * (1 + step), softCostPerSqft: inputs.softCostPerSqft * (1 + step)};
  if (axis === 'capRateBps') return {...inputs, capRate: inputs.capRate + step / 10000};
  return {...inputs, program: {...inputs.program, grossBuildingSqft: inputs.program.grossBuildingSqft * step, units: inputs.program.units.map(u => ({...u, count: u.count * step})), commercial: inputs.program.commercial.map(c => ({...c, netSqft: c.netSqft * step}))}};
}
const headline = (scenario, result) => ({scenario, totalDevelopmentCost: result.development.totalDevelopmentCost, ...(result.operations && {noi: result.operations.noi, yieldOnCost: result.operations.yieldOnCost}), value: result.returns.value, profit: result.returns.profit, unleveredReturnOnCost: result.returns.unleveredReturnOnCost, leveredReturnOnEquity: result.returns.leveredReturnOnEquity, ...(result.taxIncentive && {taxIncentiveEligible: result.taxIncentive.eligible})});
const labels = {rent: s => `rent ${s > 0 ? '+' : ''}${pct(s, 0)}`, price: s => `sale price ${s > 0 ? '+' : ''}${pct(s, 0)}`, cost: s => `hard and soft cost ${s > 0 ? '+' : ''}${pct(s, 0)}`, capRateBps: s => `cap rate ${s > 0 ? '+' : ''}${s} bps`, entitlement: s => `entitlement ×${s}`};

function validateSensitivity(steps, capRate) {
  const spec = {...DEFAULT_SENSITIVITY, ...steps};
  for (const [axis, values] of Object.entries(spec)) {
    if (!Object.hasOwn(DEFAULT_SENSITIVITY, axis)) throw new Error(`Unknown sensitivity axis: ${axis}.`);
    if (!Array.isArray(values) || !values.length || values.length > 6 || !values.every(Number.isFinite)) throw new Error(`sensitivity.${axis} must list 1 to 6 numbers.`);
    if ((axis === 'rent' || axis === 'price' || axis === 'cost') && values.some(v => v < -1)) throw new Error(`sensitivity.${axis} cannot reduce prices or costs below zero.`);
    if (axis === 'entitlement' && values.some(v => v <= 0)) throw new Error('sensitivity.entitlement multipliers must be positive; model no development separately.');
    if (axis === 'capRateBps' && capRate !== undefined && values.some(v => capRate + v / 10000 <= 0)) throw new Error('Each sensitivity capitalization rate must remain positive.');
  }
  return spec;
}

export function sensitivity(args, recordedMarket = null, steps = {}, facts = {}) {
  const market = args.market ? normalizeMarketInputs(args.market) : recordedMarket;
  if (!market) throw new Error('Record market inputs with acres_market_inputs first, or pass market.');
  const inputs = normalize(args, market, facts);
  const base = computeFrom(inputs);
  if (inputs.taxIncentive) Object.assign(base.taxIncentive, {without485x: headline('without 485-x', without485x(inputs)), at99Units: at99Units(inputs, base)});
  const spec = validateSensitivity(steps, inputs.capRate);
  const table = {};
  for (const axis of Object.keys(DEFAULT_SENSITIVITY)) {
    if (axis === 'capRateBps' && inputs.capRate === undefined) continue;
    // An axis the product does not read would only restate the base: sale prices price a condo exit,
    // rents price rental and commercial income (and a mixed condo's commercial rows).
    if (axis === 'price' && inputs.productType !== 'condo') continue;
    if (axis === 'rent' && inputs.productType === 'condo' && !(inputs.program.commercial?.length > 0)) continue;
    const values = spec[axis];
    if (!Array.isArray(values) || !values.length || values.length > 6 || !values.every(v => Number.isFinite(v))) throw new Error(`sensitivity.${axis} must list 1 to 6 numbers.`);
    const neutral = axis === 'entitlement' ? 1 : 0;
    table[axis] = [...new Set([...values, neutral])].sort((a, b) => a - b).map(step => step === neutral ? headline('base', base) : headline(labels[axis](step), computeFrom(vary(inputs, axis, step), {strict: false})));
  }
  return {base, table, inputs};
}

// The model rerun on normalized inputs at another land price, with every rent and price scaled and,
// for a joint downside, costs scaled and the cap rate moved, so a target (the land price a return
// allows, the revenue a price needs) is solved by the model itself rather than by restating its algebra.
export function rerun(inputs, {landPrice = inputs.landPrice, revenueScale = 1, costScale = 1, capRateBps = 0} = {}) {
  // A revenue scale is every revenue at once, so it moves both independent axes together.
  let varied = vary(vary({...inputs, landPrice}, 'rent', revenueScale - 1), 'price', revenueScale - 1);
  if (costScale !== 1) varied = vary(varied, 'cost', costScale - 1);
  if (capRateBps && varied.capRate !== undefined) varied = vary(varied, 'capRateBps', capRateBps);
  return computeFrom(varied, {strict: false});
}

// Recompute a stored pro forma from its echoed inputs at the current market figures and unit
// mix, with no model judgment: land, costs, financing, commercial areas and gross building area
// stay as previously stated, so this answers "what do the new rents and mix do to the same
// deal?" Returns null when the swap cannot be made honestly (missing inputs, product mismatch).
export function recomputeProForma(previous, {market, program} = {}) {
  const prior = previous?.inputs;
  if (!prior || !market || !program || prior.productType !== program.productType) return null;
  const units = (program.byBedrooms || []).filter(r => r.units > 0).map(r => ({bedrooms: r.bedrooms, count: r.units, netSqft: r.unitSqft}));
  if (!units.length) return null;
  const {market: _echo, ...rest} = prior;
  const {base, table} = sensitivity({...rest, program: {...prior.program, units}}, market, previous.sensitivitySteps ?? {}, {land: prior.landPriceBasis, taxes: prior.realEstateTaxes});
  return {...base, sensitivitySteps: previous.sensitivitySteps ?? {}, sensitivity: table, createdAt: new Date().toISOString(), derived: true,
    derivedNote: 'Recomputed in code from the latest market inputs and unit mix at the previously stated gross building area, land, costs and financing; re-run acres_pro_forma if the building size changed.'};
}

const row = (fields, required) => ({type: 'object', additionalProperties: false, properties: fields, required});
export const proFormaDefinition = {
  name: 'acres_pro_forma',
  description: 'Run a development pro forma for one concept as code: development budget (land, hard and soft cost, interest-only carry on a loan-to-cost construction loan), revenue from the program at the recorded market rents or sale prices, vacancy, operating expenses, NOI, yield on cost, value at the cap rate, profit, unlevered return on cost, levered return on equity, equity multiple, debt service coverage and cash on cash for rentals, net sellout and margins for condos, and one-way sensitivity tables across rent, sale price, cost, cap rate and an entitlement multiplier (rent moves rents only, sale price moves sale prices only). For NYC new rentals, taxIncentive models the 485-x exemption as a scenario: restricted units at HPD AMI rents mirroring the unit mix, the exemption schedule over base taxes, value as NOI at full taxes over the cap rate plus the present value of the taxes exempted, the construction wage floor on 100+ units as a hard-cost premium, and the same deal without 485-x for comparison; an Option A program also reports the same building held to 99 units under Option B (at99Units), which carries no wage floor. The user supplies land price, costs per gross sq ft, financing and operating assumptions; rents and prices come from acres_market_inputs unless passed in market with their sources. Every figure returned is arithmetic on these inputs and the derivation lines show it; report the assumptions with the results and keep the model\'s judgment in the answer. The program is the concept\'s unit mix (acres_unit_mix) and commercial area; gross building area comes from the concept.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      name: {type: 'string', description: 'Short label, usually the concept name.'},
      productType: {type: 'string', enum: ['rental', 'condo', 'commercial'], description: 'rental: homes held for rent. condo: homes sold. commercial: a wholly non-residential building (retail, office or community facility) held for its commercial income, program.units empty and program.commercial carrying the area. Mixed-use is rental or condo with commercial rows in the program.'},
      program: row({
        grossBuildingSqft: {type: 'number', description: 'Total gross building area in sq ft, the basis for hard and soft cost. It must cover the combined residential net area (unit count times unit size) and commercial net area.'},
        units: {type: 'array', maxItems: 4, items: row({bedrooms: {type: 'integer', minimum: 0, maximum: 3}, count: {type: 'number'}, netSqft: {type: 'number', description: 'Net sq ft per unit.'}}, ['bedrooms', 'count', 'netSqft'])},
        commercial: {type: 'array', maxItems: 3, items: row({use: {type: 'string', enum: COMMERCIAL_USES}, netSqft: {type: 'number'}}, ['use', 'netSqft'])},
      }, ['grossBuildingSqft', 'units']),
      market: {type: 'object', description: 'Market inputs in the acres_market_inputs shape (submarket plus rents, salePrices, commercialRents with source and retrievedAt), when they were not recorded in this answer.'},
      landPrice: {type: 'number', description: 'Land price in USD. Give exactly one of landPrice or landPriceSource.'},
      landPriceSource: {type: 'string', enum: ['ledger'], description: 'ledger: land price = what nearby development sites sold for, each of the nearest earlier sales in the subject\'s borough within a mile (widened to 1.5, then 2 miles where a mile holds fewer than five, with the figure scaled by 0.88 to correct for the farther sales; the basis states the distance) adjusted to the subject lot, per as-of-right buildable SF × the lot\'s as-of-right buildable SF, the figure its site page shows; where that model gives no figure (the basis says why), the median price per max ZFA of the arm\'s-length ACRIS deeds on the subject block (at least three) × the subject max ZFA. The result states which basis it used (inputs.landPriceBasis.method) and is cited as an official record. Fails with the reason when there is no estimate.'},
      taxSource: {type: 'string', enum: ['ledger'], description: 'Rental and commercial only. ledger: adds a separate real estate taxes line = DOF actual assessed value × the class tax rate for the subject as currently assessed, with market value as a cross-check; residentialOpexPerUnitPerYear then excludes taxes. With taxIncentive it supplies the 485-x base taxes instead.'},
      taxIncentive: row({
        program: {type: 'string', enum: ['485-x'], description: 'NYC RPTL § 485-x (Affordable Neighborhoods for New Yorkers), new rental buildings of six or more units. residentialOpexPerUnitPerYear then excludes real estate taxes.'},
        option: {type: 'string', enum: ['A', 'B', 'C'], description: 'B: 6 to 99 units, 20% of units at an 80% AMI weighted average, 100% exemption for 25 years then the affordability percentage for 10. A: 100+ units, 25% at 80% AMI, 100% for 35 years; at 150+ units in Zone A or B a very large project, 25% at 60% AMI, 100% for 40 years. C: 6 to 10 units outside Manhattan on a zoning lot permitting at most 12,500 sq ft of residential floor area, 50% rent stabilized, 100% for 10 years. The code checks the option against the unit count and zone.'},
        location: row({borough: {type: 'string', enum: ['MN', 'BK', 'QN', 'BX', 'SI']}, ntaCode: {type: 'string', description: 'Brooklyn and Queens: the 2020 neighborhood tabulation area code (e.g. BK0101), which sets Zone A or B.'}, entirelySouthOf96thStreet: {type: 'boolean', description: 'Manhattan: whether the tax lot lies entirely south of 96th Street (Zone A).'}}, ['borough']),
        residentialFloorAreaPermitted: {type: 'number', description: 'Option C: residential floor area the zoning lot permits, sq ft.'},
        fullAnnualTaxes: {type: 'number', description: 'Full annual real estate taxes on the completed building before any exemption, USD. Give this or dofCapRate.'},
        dofCapRate: {type: 'number', description: 'Estimate full taxes by the DOF income method instead: NOI before taxes ÷ (this base cap rate + 45% × the class 2 tax rate). A stated assumption.'},
        baseAnnualTaxes: {type: 'number', description: 'Taxes on the assessment before construction starts, which stay payable (§ 5(a)); omit when taxSource is ledger.'},
        discountRate: {type: 'number', description: 'Annual rate discounting the exempted taxes to a present value, as a fraction.'},
        construction: row({
          start: {type: 'string', description: 'Expected commencement date, YYYY-MM-DD (eligible after 2022-06-15 through 2034-06-15, completion by 2038-06-15).'},
          months: {type: 'integer', description: 'Construction months from commencement to the certificate of occupancy.'},
          laborShareOfHardCost: {type: 'number', description: 'Option A: labor share of hard cost, as a fraction, for the wage floor premium.'},
          currentHourlyWage: {type: 'number', description: 'Option A: the expected average hourly wages and supplements without the floor, USD.'},
          greatestPrevailingWage: {type: 'number', description: 'Very large projects: the greatest prevailing rate of wages and supplements in a classification, USD per hour; without it the dollar floor is an upper bound.'},
        }, ['start', 'months']),
      }, ['program', 'option', 'location', 'discountRate', 'construction']),
      hardCostPerSqft: {type: 'number', description: 'Hard cost in USD per gross sq ft for this product type: the rental hard cost for a rental pro forma, the condo hard cost for a condo pro forma.'},
      softCostPerSqft: {type: 'number', description: 'Soft cost in USD per gross sq ft, including fees, financing fees and contingency as the user states them.'},
      financing: row({loanToCost: {type: 'number', description: 'Construction loan as a fraction of land plus hard plus soft cost, 0 to 0.95.'}, interestRate: {type: 'number', description: 'Annual interest rate as a fraction.'}, termMonths: {type: 'integer', description: 'Months of interest-only carry from land closing to stabilization or sellout.'}}, ['loanToCost', 'interestRate', 'termMonths']),
      operating: row({residentialVacancyRate: {type: 'number'}, residentialOpexPerUnitPerYear: {type: 'number', description: 'Operating expenses, USD per unit per year: including real estate taxes by default, excluding real estate taxes when taxSource is ledger.'}, commercialVacancyRate: {type: 'number'}, commercialOpexPerSqftPerYear: {type: 'number', description: 'Landlord operating cost on commercial space, USD per sq ft per year (0 for net leases).'}}, ['residentialVacancyRate', 'residentialOpexPerUnitPerYear', 'commercialVacancyRate', 'commercialOpexPerSqftPerYear']),
      capRate: {type: 'number', description: 'Capitalization rate as a fraction; required when the program produces income.'},
      sellingCostRate: {type: 'number', description: 'Condo selling costs as a fraction of gross sellout; required for condos.'},
      lineItems: {type: 'boolean', description: 'Also return the development budget as line items (development.lineItems) when the user asks for a detailed or line-item budget: land; hard cost split into site work and demolition, foundations, structure, facade and roofing, interiors, vertical transportation (elevator buildings only), mechanical, electrical and plumbing, general conditions and GC fee, and contingency; soft cost split into architecture and engineering, permits, legal, insurance, developer fee and contingency, plus the 485-x wage floor where it applies; financing and carry. The shares are the account\'s budget breakdown or Arosa\'s dated planning defaults (basis gives the source); the lines add up exactly to the total development cost. Requires storeys.'},
      storeys: {type: 'integer', minimum: 1, maximum: 150, description: 'Storeys above grade of the concept, required with lineItems: a building above five storeys carries an elevator line.'},
      sensitivity: row({rent: {type: 'array', items: {type: 'number'}, description: 'Rent changes as fractions (residential and commercial rents only), default [-0.1, 0.1].'}, price: {type: 'array', items: {type: 'number'}, description: 'Sale price changes as fractions (condo exits only), default [-0.1, 0.1].'}, cost: {type: 'array', items: {type: 'number'}, description: 'Hard and soft cost changes as fractions, default [-0.1, 0.1].'}, capRateBps: {type: 'array', items: {type: 'number'}, description: 'Cap rate changes in basis points, default [-50, 50].'}, entitlement: {type: 'array', items: {type: 'number'}, description: 'Floor area multipliers for entitlement scenarios against a fixed land price, default [0.8, 1.2].'}}, []),
    },
    required: ['productType', 'program', 'hardCostPerSqft', 'softCostPerSqft', 'financing'],
  },
};

const ledgerDate = at => at.slice(0, 10);
// The land and tax inputs a ledger source resolves to, each recorded as a citable official record.
export function ledgerFacts(args, ledger, record) {
  if ((args.landPrice !== undefined) === (args.landPriceSource === 'ledger')) throw new Error('Give exactly one of landPrice or landPriceSource: \'ledger\'.');
  if (args.taxSource !== undefined && args.taxSource !== 'ledger') throw new Error('taxSource must be ledger.');
  if (!(args.landPriceSource || args.taxSource)) return {};
  if (!ledger) throw new Error('The development ledger is not available here; state the land price and tax-inclusive operating expenses instead.');
  const facts = {};
  if (args.landPriceSource === 'ledger') {
    const est = ledger.landPriceEstimate();
    if (est.estimate === null) throw new Error(`The ledger has no land price estimate: ${est.reason}. State a land price instead.`);
    const cited = record({title: `${est.source}, land price estimate`, url: est.sourceUrl, kind: 'official_record', text: JSON.stringify(est, null, 2)});
    const measure = est.method === 'nearby_model'
      ? {pricePerBsf: est.pricePerBsf, buildableSqft: est.buildableSqft, withinMiles: est.withinMiles}
      : {pricePerZfaMedian: est.pricePerZfaMedian, pricePerZfaRange: est.pricePerZfaRange, maxZfa: est.maxZfa};
    facts.land = {estimate: est.estimate, method: est.method, ...measure, sampleSize: est.sampleSize, docIds: est.docIds, basis: est.basis, source: est.source, retrievedAt: ledgerDate(est.retrievedAt), sourceId: cited?.id ?? null};
  }
  if (args.taxSource === 'ledger') facts.taxes = ledgerTaxFacts(ledger, record, 'Use tax-inclusive operating expenses instead.');
  return facts;
}

// The subject's current real estate taxes from the ledger (DOF assessed value x the class tax rate),
// recorded as a citable official record. fallback says what to do instead when the ledger has none.
export function ledgerTaxFacts(ledger, record, fallback) {
  if (!ledger) throw new Error(`The development ledger is not available here. ${fallback}`);
  const t = ledger.taxes();
  if (t.annualTaxes === null) throw new Error(`The ledger has no tax estimate: ${t.reason}. ${fallback}`);
  const source = 'NYC development ledger: DOF assessment (8y4t-faws) x DOF class tax rate';
  const cited = record({title: `${source}, real estate taxes`, url: t.sourceUrl, kind: 'official_record', text: JSON.stringify(t, null, 2)});
  return {annualTaxes: t.annualTaxes, assessedValue: t.assessedValue, marketValue: t.marketValue, taxClass: t.taxClass, rate: t.rate, rateFiscalYear: t.rateFiscalYear, assessmentFiscalYear: t.assessmentFiscalYear, basis: t.basis, crossCheck: t.crossCheck, source, retrievedAt: ledgerDate(t.retrievedAt), sourceId: cited?.id ?? null};
}

// getMarket returns the market inputs recorded by acres_market_inputs in this answer, or null;
// ledger is the subject's development ledger reads (createSubjectLedger), or null where it is absent.
// getBudgetSplits returns the account's budget line shares, or null for the defaults.
export function createProFormaTools({emit = () => {}, getMarket = () => null, ledger = null, record = () => null, getBudgetSplits = () => null} = {}) {
  const proFormas = [];
  async function run(args) {
    if (proFormas.length >= 4) throw new Error('At most four pro formas per answer. Compare the existing ones instead.');
    normalizeProgram(args.program);
    const {sensitivity: steps, landPriceSource: _land, taxSource: _tax, lineItems = false, storeys, ...rest} = args;
    if (lineItems && !(Number.isInteger(storeys) && storeys >= 1 && storeys <= 150)) throw new Error('storeys is required with lineItems: a whole number of storeys from 1 to 150.');
    validateSensitivity(steps ?? {}, args.capRate);
    const facts = ledgerFacts(args, ledger, record);
    const {base, table} = sensitivity(rest, getMarket(), steps ?? {}, facts);
    const result = {...base, sensitivitySteps: steps ?? {}, sensitivity: table, createdAt: new Date().toISOString()};
    if (lineItems) {
      const grossSqft = base.inputs.program.grossBuildingSqft;
      result.development = {...base.development, lineItems: proFormaBudget(base.development, {grossSqft, storeys, baseHardCost: base.inputs.hardCostPerSqft * grossSqft, splits: getBudgetSplits()})};
    }
    proFormas.push(result);
    emit('proforma.created', result);
    return {...result, note: 'Every figure is arithmetic on the inputs echoed in `inputs`; the derivation lines show the numbers. Carry is simple interest on a loan drawn for land at closing and evenly for construction. Returns are total profit over cost and over equity at stabilization or sellout, not an IRR. Report the assumptions and the sources of the rents or prices with the results.'};
  }
  return {definitions: [proFormaDefinition], proFormas, handlers: {acres_pro_forma: run}};
}
