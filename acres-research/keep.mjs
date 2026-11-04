// Keeping the building: underwriting the purchase of a property as it stands, the other answer to
// "should you buy it" beside the ways to build new. Three ways to own it are priced as code from the
// price, the building's income, the work the buyer plans and the financing: hold it as is, renovate and
// rent it, and renovate and sell it. Each says what the buyer ends up with against everything the buyer
// puts in, and the highest price that still meets the buyer's target, so the three compare on one
// footing, the price each can pay, the way the ways to build it compare on what each pays for the land.
// Rents and values per sq ft are market figures and carry their sources; every other default is a dated
// planning assumption the user can replace (assumptions.keep in docs/project-state.md).
import {figure, int, num} from './market.mjs';
import {DEAL_SCREEN_ASSUMPTIONS, DEFAULT_NYC_DEV_SETTINGS, NYC_BUYER_TRANSFER_TAX, buyerTransferTaxRate} from './market-store.mjs';
import {ledgerTaxFacts} from './proforma.mjs';

export const KEEP_IDS = ['hold', 'renovate_rent', 'renovate_sell'];
export const KEEP_LABELS = {hold: 'Hold as is', renovate_rent: 'Renovate and rent', renovate_sell: 'Renovate and sell'};

// Planning defaults, used only where the caller gives no figure; each use is listed in the result's assumed.
export const KEEP_DEFAULTS = {
  asOf: '2026-10-29',
  source: 'Arosa planning assumption for keeping a building; not a lender quote, cost index or market survey',
  closingCostRate: DEAL_SCREEN_ASSUMPTIONS.buyerClosingCostPct,
  rentableShare: DEFAULT_NYC_DEV_SETTINGS.zfaToNetEfficiency,
  vacancyRate: 0.05,
  operatingExpenseRatio: DEFAULT_NYC_DEV_SETTINGS.operatingExpenseRatio,
  loanToValue: 0.65,
  interestRate: 0.07,
  amortizationYears: 30,
  loanCostRate: 0.025,
  contingencyRate: 0.1,
  renovationMonths: 6,
  monthsToSell: 3,
  sellingCostRate: 0.06,
  dscr: 1.25,
  yieldOnCostSpread: 0.01,
  returnOnCost: 0.15,
};

// The joint downside every way is tested at, all at once: rents 10% lower, values and sale prices 10%
// lower, the work 20% dearer and the loan rate a point higher.
export const KEEP_DOWNSIDE = {revenueScale: 0.9, valueScale: 0.9, renovationScale: 1.2, rateBps: 100};

const round = (n, d = 0) => (n == null ? null : Number(n.toFixed(d)) + 0);
const usd = n => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const pct = (n, d = 1) => `${round(n * 100, d)}%`;
const plain = v => v != null && typeof v === 'object' && !Array.isArray(v);
const text = (v, name, max = 600) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${name} must be text of 1 to ${max} characters.`);
  return v.trim();
};

// A market figure: {value, source, retrievedAt (YYYY-MM-DD), url?, basis?, sourceId?}.
function sourced(row, name, min, max) {
  if (!plain(row)) throw new Error(`${name} must be an object with value, source and retrievedAt.`);
  const out = figure(row, name, {value: [min, max]});
  return {...out, sourceId: Number.isInteger(row.sourceId) ? row.sourceId : null};
}

// The building from the caller, or from the subject's PLUTO record.
function buildingOf(args, property) {
  let b = args.building, source = 'Stated for this analysis';
  if (b === undefined && Number(property?.bldgarea) > 0) {
    b = {grossSqft: Number(property.bldgarea), residentialUnits: Number(property.unitsres) || 0, commercialSqft: Number(property.comarea) || 0};
    source = `PLUTO${property.version ? ` ${property.version}` : ''} record for BBL ${property.bbl}`;
  }
  if (!plain(b)) throw new Error('building is required: grossSqft and residentialUnits, or select the subject so its PLUTO record supplies them.');
  const grossSqft = num(b.grossSqft, 'building.grossSqft', 200, 5_000_000);
  const residentialUnits = int(b.residentialUnits, 'building.residentialUnits', 0, 5000);
  const commercialSqft = b.commercialSqft == null ? 0 : num(b.commercialSqft, 'building.commercialSqft', 0, grossSqft);
  if (residentialUnits === 0 && commercialSqft === 0) throw new Error('building needs residential units or commercial space that earn rent.');
  const regulatedUnits = b.regulatedUnits == null ? 0 : int(b.regulatedUnits, 'building.regulatedUnits', 0, residentialUnits);
  const stated = b.rentableSqft != null;
  const rentableSqft = stated ? num(b.rentableSqft, 'building.rentableSqft', 0, grossSqft - commercialSqft) : round((grossSqft - commercialSqft) * KEEP_DEFAULTS.rentableShare);
  return {grossSqft, residentialUnits, commercialSqft, regulatedUnits, rentableSqft, rentableStated: stated, source: b.source == null ? source : text(b.source, 'building.source', 200)};
}

function incomeOf(i, b) {
  if (!plain(i)) throw new Error('income is required: rentRoll with rentRollSource, or rentPerSqftPerMonth with its source.');
  const roll = i.rentRoll !== undefined, psf = i.rentPerSqftPerMonth !== undefined;
  // A wholly commercial building has no apartments to price: its income is the commercial rent alone.
  if (b.residentialUnits === 0 && (roll || psf)) throw new Error('The building has no apartments; give income.commercialRentPerSqftPerYear only.');
  if (b.residentialUnits > 0 && roll === psf) throw new Error('Give exactly one of income.rentRoll (the leases in place) or income.rentPerSqftPerMonth (a market rent on the rentable area).');
  const out = {};
  if (roll) {
    if (!Array.isArray(i.rentRoll) || !i.rentRoll.length || i.rentRoll.length > 24) throw new Error('income.rentRoll must list 1 to 24 rows.');
    out.rentRoll = i.rentRoll.map((r, k) => {
      if (!plain(r)) throw new Error(`income.rentRoll[${k}] must be an object.`);
      return {label: r.label == null ? null : text(r.label, `income.rentRoll[${k}].label`, 80), units: int(r.units, `income.rentRoll[${k}].units`, 1, 5000),
        monthlyRentPerUnit: num(r.monthlyRentPerUnit, `income.rentRoll[${k}].monthlyRentPerUnit`, 0, 100_000), regulated: r.regulated === true};
    });
    const units = out.rentRoll.reduce((s, r) => s + r.units, 0);
    if (units > b.residentialUnits) throw new Error(`income.rentRoll lists ${units} units but the building has ${b.residentialUnits}; correct the roll or building.residentialUnits.`);
    out.rentRollSource = {...figure(i.rentRollSource ?? {}, 'income.rentRollSource', {}), sourceId: Number.isInteger(i.rentRollSource?.sourceId) ? i.rentRollSource.sourceId : null};
  } else if (psf) {
    out.rentPerSqftPerMonth = sourced(i.rentPerSqftPerMonth, 'income.rentPerSqftPerMonth', 0.5, 30);
  }
  if (b.commercialSqft > 0) out.commercialRentPerSqftPerYear = sourced(i.commercialRentPerSqftPerYear, 'income.commercialRentPerSqftPerYear', 5, 3000);
  else if (i.commercialRentPerSqftPerYear !== undefined) throw new Error('income.commercialRentPerSqftPerYear needs building.commercialSqft.');
  out.otherIncomePerYear = i.otherIncomePerYear == null ? 0 : num(i.otherIncomePerYear, 'income.otherIncomePerYear', 0, 100_000_000);
  return out;
}

// Validates the arguments and fills planning defaults, listing each one used. facts.taxes is the
// ledger's current tax bill when taxSource is ledger; facts.property is the subject.
export function normalizeKeep(args = {}, facts = {}) {
  if (!plain(args)) throw new Error('acres_keep_building needs an object of inputs.');
  const assumed = [];
  // An input the caller gave, checked; otherwise the planning default under key, recorded by its input path.
  const pick = (value, path, key, min, max, whole = false) => {
    if (value != null) return (whole ? int : num)(value, path, min, max);
    assumed.push(path);
    return KEEP_DEFAULTS[key];
  };
  const b = buildingOf(args, facts.property);
  const income = incomeOf(args.income, b);
  const op = args.operating ?? {};
  if (!plain(op)) throw new Error('operating must be an object.');
  const operating = {
    vacancyRate: pick(op.vacancyRate, 'operating.vacancyRate', 'vacancyRate', 0, 0.5),
    operatingExpenseRatio: pick(op.operatingExpenseRatio, 'operating.operatingExpenseRatio', 'operatingExpenseRatio', 0, 0.9),
  };
  if ((op.annualTaxes !== undefined) === (args.taxSource === 'ledger')) throw new Error('Give exactly one of operating.annualTaxes (with operating.taxBasis) or taxSource: "ledger" (the current DOF assessment times the class rate).');
  if (args.taxSource !== undefined && args.taxSource !== 'ledger') throw new Error('taxSource must be ledger.');
  if (args.taxSource === 'ledger') {
    if (!facts.taxes) throw new Error('taxSource "ledger" needs the ledger tax bill.');
    operating.annualTaxes = facts.taxes.annualTaxes;
    operating.taxes = {source: facts.taxes.source, retrievedAt: facts.taxes.retrievedAt, basis: facts.taxes.basis, taxClass: facts.taxes.taxClass ?? null, sourceId: facts.taxes.sourceId ?? null};
  } else {
    operating.annualTaxes = num(op.annualTaxes, 'operating.annualTaxes', 0, 500_000_000);
    operating.taxes = {source: text(op.taxBasis ?? '', 'operating.taxBasis', 300), retrievedAt: null, basis: null, taxClass: null, sourceId: Number.isInteger(op.taxSourceId) ? op.taxSourceId : null};
  }
  const v = args.valuation;
  if (!plain(v)) throw new Error('valuation is required with capRate.');
  const valuation = {
    capRate: num(v.capRate, 'valuation.capRate', 0.02, 0.15),
    capRateBasis: v.capRateBasis == null ? 'Stated for this analysis' : text(v.capRateBasis, 'valuation.capRateBasis', 300),
    asIsValuePerSqft: v.asIsValuePerSqft == null ? null : sourced(v.asIsValuePerSqft, 'valuation.asIsValuePerSqft', 50, 15000),
    afterRenovationValuePerSqft: v.afterRenovationValuePerSqft == null ? null : sourced(v.afterRenovationValuePerSqft, 'valuation.afterRenovationValuePerSqft', 50, 15000),
  };
  let renovation = null;
  if (args.renovation != null) {
    const r = args.renovation;
    if (!plain(r)) throw new Error('renovation must be an object.');
    if ((r.costPerSqft != null) === (r.totalCost != null)) throw new Error('Give exactly one of renovation.costPerSqft (on the gross building area) or renovation.totalCost.');
    renovation = {
      costPerSqft: r.costPerSqft == null ? null : num(r.costPerSqft, 'renovation.costPerSqft', 0, 2000),
      totalCost: r.totalCost == null ? null : num(r.totalCost, 'renovation.totalCost', 0, 1_000_000_000),
      contingencyRate: pick(r.contingencyRate, 'renovation.contingencyRate', 'contingencyRate', 0, 0.5),
      months: pick(r.months, 'renovation.months', 'renovationMonths', 0, 36, true),
      vacant: r.vacant !== false,
      rentPerSqftPerMonth: r.rentPerSqftPerMonth == null ? null : sourced(r.rentPerSqftPerMonth, 'renovation.rentPerSqftPerMonth', 0.5, 30),
      costBasis: r.costBasis == null ? 'Stated for this analysis' : text(r.costBasis, 'renovation.costBasis', 300),
      scope: r.scope == null ? null : text(r.scope, 'renovation.scope', 600),
    };
  }
  const f = args.financing ?? {};
  if (!plain(f)) throw new Error('financing must be an object.');
  const financing = {
    loanToValue: pick(f.loanToValue, 'financing.loanToValue', 'loanToValue', 0, 0.9),
    interestRate: pick(f.interestRate, 'financing.interestRate', 'interestRate', 0, 0.25),
    amortizationYears: pick(f.amortizationYears, 'financing.amortizationYears', 'amortizationYears', 0, 40, true),
    loanCostRate: pick(f.loanCostRate, 'financing.loanCostRate', 'loanCostRate', 0, 0.06),
  };
  const a = args.acquisition ?? {};
  if (!plain(a)) throw new Error('acquisition must be an object.');
  // A one to three family house is a residential conveyance, so the buyer pays the State "mansion" and
  // City supplemental transfer taxes by price bracket; other buildings pass the transfer taxes to the seller.
  const residentialConveyance = a.residentialConveyance == null ? b.residentialUnits >= 1 && b.residentialUnits <= 3 && b.commercialSqft === 0 : a.residentialConveyance === true;
  const acquisition = {
    closingCostRate: pick(a.closingCostRate, 'acquisition.closingCostRate', 'closingCostRate', 0, 0.1),
    transferTaxRate: a.transferTaxRate == null ? null : num(a.transferTaxRate, 'acquisition.transferTaxRate', 0, 0.05),
    residentialConveyance,
  };
  const e = args.exit ?? {};
  if (!plain(e)) throw new Error('exit must be an object.');
  const exit = {
    sellingCostRate: pick(e.sellingCostRate, 'exit.sellingCostRate', 'sellingCostRate', 0, 0.15),
    monthsToSell: pick(e.monthsToSell, 'exit.monthsToSell', 'monthsToSell', 0, 24, true),
  };
  const t = args.targets ?? {};
  if (!plain(t)) throw new Error('targets must be an object.');
  const targets = {
    capRate: t.capRate == null ? valuation.capRate : num(t.capRate, 'targets.capRate', 0.02, 0.2),
    yieldOnCost: t.yieldOnCost == null ? round(valuation.capRate + KEEP_DEFAULTS.yieldOnCostSpread, 4) : num(t.yieldOnCost, 'targets.yieldOnCost', 0.02, 0.25),
    returnOnCost: pick(t.returnOnCost, 'targets.returnOnCost', 'returnOnCost', 0, 1),
    dscr: pick(t.dscr, 'targets.dscr', 'dscr', 1, 3),
  };
  if (t.yieldOnCost == null) assumed.push('targets.yieldOnCost');
  const name = args.name == null ? 'Keep the building' : text(args.name, 'name', 120);
  const purchasePrice = num(args.purchasePrice, 'purchasePrice', 10_000, 5_000_000_000);
  return {name, purchasePrice, priceBasis: args.priceBasis == null ? 'Stated for this analysis' : text(args.priceBasis, 'priceBasis', 300),
    building: b, income, operating, valuation, renovation, financing, acquisition, exit, targets, assumed};
}

// Level annual payments on a loan; interest only when amortizationYears is 0.
function debtService(loan, rate, years) {
  if (!(loan > 0)) return 0;
  if (years === 0) return loan * rate;
  if (rate === 0) return loan / years;
  const r = rate / 12, n = years * 12;
  return loan * r / (1 - (1 + r) ** -n) * 12;
}
// The loan a net operating income carries at a debt coverage ratio, at the rate and amortization.
function loanAtCoverage(noi, dscr, rate, years) {
  if (!(noi > 0)) return 0;
  const payment = noi / dscr;
  if (years === 0) return rate > 0 ? payment / rate : Infinity;
  if (rate === 0) return payment * years;
  const r = rate / 12, n = years * 12;
  return payment / 12 * (1 - (1 + r) ** -n) / r;
}

// Rent from the apartments as they stand, by the roll or at the market rent on the rentable area; the
// regulated share of the area keeps its rent after a renovation.
function apartmentsAsIs(n) {
  const {income: i, building: b} = n;
  if (!i.rentRoll && !i.rentPerSqftPerMonth) return {annual: 0, regulatedAnnual: 0, regulatedUnits: 0, rentedUnits: 0};
  if (i.rentRoll) {
    const all = i.rentRoll.reduce((s, r) => s + r.units * r.monthlyRentPerUnit * 12, 0);
    const regulated = i.rentRoll.filter(r => r.regulated).reduce((s, r) => s + r.units * r.monthlyRentPerUnit * 12, 0);
    const regulatedUnits = i.rentRoll.filter(r => r.regulated).reduce((s, r) => s + r.units, 0);
    return {annual: all, regulatedAnnual: regulated, regulatedUnits, rentedUnits: i.rentRoll.reduce((s, r) => s + r.units, 0)};
  }
  const annual = b.rentableSqft * i.rentPerSqftPerMonth.value * 12;
  const share = b.residentialUnits ? b.regulatedUnits / b.residentialUnits : 0;
  return {annual, regulatedAnnual: annual * share, regulatedUnits: b.regulatedUnits, rentedUnits: b.residentialUnits};
}
// Rent after the work: regulated units keep their rent; the rest of the apartment area earns the
// renovated rent. Null when no renovated rent is given.
function apartmentsRenovated(n) {
  const r = n.renovation?.rentPerSqftPerMonth;
  if (!r) return null;
  const now = apartmentsAsIs(n), b = n.building;
  const freeShare = b.residentialUnits ? (b.residentialUnits - now.regulatedUnits) / b.residentialUnits : 0;
  return now.regulatedAnnual + b.rentableSqft * freeShare * r.value * 12;
}
function operate(n, apartments, revenueScale) {
  const commercial = n.income.commercialRentPerSqftPerYear ? n.building.commercialSqft * n.income.commercialRentPerSqftPerYear.value : 0;
  const gross = (apartments + commercial) * revenueScale;
  const vacancy = gross * n.operating.vacancyRate;
  const egi = gross - vacancy + n.income.otherIncomePerYear;
  const opex = egi * n.operating.operatingExpenseRatio;
  return {grossRent: gross, vacancyLoss: vacancy, effectiveGrossIncome: egi, operatingExpenses: opex, taxes: n.operating.annualTaxes, noi: egi - opex - n.operating.annualTaxes};
}

// The purchase at a price: closing costs, the buyer's transfer taxes, the acquisition loan and its costs.
function purchase(n, price) {
  const p = Math.max(0, price);
  const transferRate = n.acquisition.transferTaxRate ?? (n.acquisition.residentialConveyance ? buyerTransferTaxRate(p, true) : 0);
  const loan = p * n.financing.loanToValue;
  const closingCosts = p * n.acquisition.closingCostRate, transferTaxes = p * transferRate, loanCosts = loan * n.financing.loanCostRate;
  return {price, closingCosts, transferTaxes, transferTaxRate: transferRate, loan, loanCosts, allIn: price + closingCosts + transferTaxes + loanCosts};
}
const workCost = (n, scale) => n.renovation ? (n.renovation.costPerSqft != null ? n.renovation.costPerSqft * n.building.grossSqft : n.renovation.totalCost) * (1 + n.renovation.contingencyRate) * scale : 0;

// Every way at one price and one set of shocks. Each returns its figures, or a reason it is not priced.
function ways(n, price, s = {}) {
  const revenue = s.revenueScale ?? 1, value = s.valueScale ?? 1, work = s.renovationScale ?? 1;
  const rate = n.financing.interestRate + (s.rateBps ?? 0) / 10000, years = n.financing.amortizationYears;
  const buy = purchase(n, price);
  const asIs = operate(n, apartmentsAsIs(n).annual, revenue);
  const ds = debtService(buy.loan, rate, years);
  const out = {};
  // Hold as is: the building's income on everything paid to own it.
  const salesValue = n.valuation.asIsValuePerSqft ? n.valuation.asIsValuePerSqft.value * n.building.grossSqft * value : null;
  const incomeValue = asIs.noi / n.valuation.capRate * value;
  out.hold = {
    priced: true, ...asIs, purchase: buy, allIn: buy.allIn, equity: buy.allIn - buy.loan,
    capRateOnCost: asIs.noi / buy.allIn, debtService: ds, dscr: ds > 0 ? asIs.noi / ds : null,
    cashFlow: asIs.noi - ds, cashOnCash: (asIs.noi - ds) / (buy.allIn - buy.loan),
    incomeValue, salesValue, value: salesValue ?? incomeValue, valueBasis: salesValue != null ? 'sales' : 'income',
    loanAtTargetCoverage: loanAtCoverage(asIs.noi, n.targets.dscr, rate, years),
    measure: asIs.noi / buy.allIn, target: n.targets.capRate,
  };
  out.hold.valueCreated = out.hold.value - buy.allIn;
  const reno = n.renovation;
  if (!reno) {
    const reason = 'No renovation was given: state its cost, months and the rent or sale price it reaches.';
    out.renovate_rent = {priced: false, reason};
    out.renovate_sell = {priced: false, reason};
    return out;
  }
  const renovationCost = workCost(n, work);
  // Carry while the work is under way: loan interest and taxes, less the income the building still earns
  // when the work leaves it occupied.
  const carryFor = months => (buy.loan * rate + n.operating.annualTaxes - (reno.vacant ? 0 : asIs.noi + n.operating.annualTaxes)) * months / 12;
  const renovated = apartmentsRenovated(n);
  if (renovated == null) out.renovate_rent = {priced: false, reason: 'No renovated rent was given: state renovation.rentPerSqftPerMonth with its source.'};
  else {
    const after = operate(n, renovated, revenue);
    const carry = carryFor(reno.months);
    const allIn = buy.allIn + renovationCost + carry;
    const stabilizedValue = after.noi / n.valuation.capRate * value;
    const refinance = Math.max(0, Math.min(stabilizedValue * n.financing.loanToValue, loanAtCoverage(after.noi, n.targets.dscr, rate, years)));
    const dsAfter = debtService(refinance, rate, years);
    const equityLeft = allIn + refinance * n.financing.loanCostRate - refinance;
    out.renovate_rent = {
      priced: true, ...after, purchase: buy, renovationCost, carry, months: reno.months, allIn,
      yieldOnCost: after.noi / allIn, value: stabilizedValue, valueCreated: stabilizedValue - allIn,
      refinanceLoan: refinance, cashOut: refinance * (1 - n.financing.loanCostRate) - buy.loan, debtService: dsAfter,
      dscr: dsAfter > 0 ? after.noi / dsAfter : null, cashFlow: after.noi - dsAfter, equityLeft,
      cashOnCash: equityLeft > 0 ? (after.noi - dsAfter) / equityLeft : null,
      measure: after.noi / allIn, target: n.targets.yieldOnCost,
    };
  }
  if (!n.valuation.afterRenovationValuePerSqft) out.renovate_sell = {priced: false, reason: 'No renovated sale price was given: state valuation.afterRenovationValuePerSqft with its source.'};
  else {
    const months = reno.months + n.exit.monthsToSell;
    const carry = carryFor(reno.months) + (buy.loan * rate + n.operating.annualTaxes) * n.exit.monthsToSell / 12;
    const salePrice = n.valuation.afterRenovationValuePerSqft.value * n.building.grossSqft * value;
    const sellingCosts = salePrice * n.exit.sellingCostRate;
    const allIn = buy.allIn + renovationCost + carry;
    const profit = salePrice - sellingCosts - allIn;
    const equity = allIn - buy.loan;
    out.renovate_sell = {
      priced: true, purchase: buy, renovationCost, carry, months, allIn, salePrice, sellingCosts, profit,
      returnOnCost: profit / allIn, equity, returnOnEquity: equity > 0 ? profit / equity : null,
      measure: profit / allIn, target: n.targets.returnOnCost,
    };
  }
  return out;
}

// The highest price at which a way still meets its target, by bisection: its measure falls as the price
// rises, transfer-tax brackets included. Below a zero price the figure is a negative residual, reported
// rather than floored. Null when no price earns the target (the way loses money however little is paid).
function highestPrice(n, id) {
  const meets = price => {
    const w = ways(n, price)[id];
    return w.allIn > 0 && w.measure >= w.target;
  };
  const atZero = ways(n, 0)[id];
  let lo = 1 - (atZero.allIn - 0);
  if (!meets(lo)) return null;
  let hi = Math.max(1_000_000, lo + 1_000_000);
  while (meets(hi)) { hi *= 2; if (hi > 1e11) return null; }
  for (let k = 0; k < 90 && hi - lo > 1; k++) { const mid = (lo + hi) / 2; if (meets(mid)) lo = mid; else hi = mid; }
  return Math.floor(lo);
}

const MEASURES = {hold: 'cap rate on all-in cost', renovate_rent: 'yield on all-in cost', renovate_sell: 'return on all-in cost'};
const callOf = (max, price) => (max == null || max <= 0 ? 'no_value' : max >= price ? 'supports_price' : 'below_price');

function verdictOf(id, w, n, max) {
  const price = usd(n.purchasePrice), target = pct(w.target), at = `${pct(w.measure)} ${MEASURES[id]}`;
  const pays = max == null ? 'no price earns the target' : max <= 0 ? `it pays nothing for the building at the target (residual ${usd(max)})` : `it pays up to ${usd(max)} at the target`;
  const meets = w.measure >= w.target ? 'meeting' : 'below';
  if (id === 'hold') {
    const debt = w.purchase.loan > 0 ? ` A ${pct(n.financing.loanToValue, 0)} loan at ${pct(n.financing.interestRate, 2)} leaves ${usd(w.cashFlow)} a year after debt service${w.dscr != null ? ` (coverage ${w.dscr.toFixed(2)}x)` : ''}.` : '';
    const comps = w.salesValue != null ? ` Standing buildings like it sell for about ${usd(w.salesValue)}.` : '';
    return `Holding it as is at ${price}: ${usd(w.noi)} net operating income is a ${at}, ${meets} the ${target} target; ${pays}.${debt}${comps}`;
  }
  if (id === 'renovate_rent') return `Renovating and renting at ${price}: ${usd(w.renovationCost)} of work over ${w.months} months lifts net operating income to ${usd(w.noi)}, a ${at}, ${meets} the ${target} target; ${pays}. At a ${pct(n.valuation.capRate, 2)} cap rate it would be worth ${usd(w.value)}, ${usd(Math.abs(w.valueCreated))} ${w.valueCreated >= 0 ? 'more' : 'less'} than it cost.`;
  return `Renovating and selling at ${price}: the renovated building sells for about ${usd(w.salePrice)}; after ${usd(w.renovationCost)} of work, ${w.months} months of carry and ${pct(n.exit.sellingCostRate, 0)} selling costs it ${w.profit >= 0 ? 'makes' : 'loses'} ${usd(Math.abs(w.profit))}, a ${at}, ${meets} the ${target} target; ${pays}.`;
}

function derivation(id, w, n) {
  const b = n.building, p = w.purchase;
  const buy = `All-in purchase ${usd(p.allIn)} = price ${usd(p.price)} + closing ${pct(n.acquisition.closingCostRate)} ${usd(p.closingCosts)} + buyer transfer taxes ${pct(p.transferTaxRate, 2)} ${usd(p.transferTaxes)} + loan costs ${pct(n.financing.loanCostRate)} of the ${usd(p.loan)} loan ${usd(p.loanCosts)}`;
  const ops = x => `Net operating income ${usd(x.noi)} = gross rent ${usd(x.grossRent)} − vacancy ${pct(n.operating.vacancyRate)} ${usd(x.vacancyLoss)}${n.income.otherIncomePerYear ? ` + other income ${usd(n.income.otherIncomePerYear)}` : ''} − operating costs ${pct(n.operating.operatingExpenseRatio)} of income ${usd(x.operatingExpenses)} − taxes ${usd(x.taxes)}`;
  if (id === 'hold') return [buy, ops(w),
    `Cap rate on cost ${pct(w.capRateOnCost, 2)} = ${usd(w.noi)} ÷ ${usd(w.allIn)}`,
    ...(p.loan > 0 ? [`Debt service ${usd(w.debtService)} a year on ${usd(p.loan)} at ${pct(n.financing.interestRate, 2)}${n.financing.amortizationYears ? ` over ${n.financing.amortizationYears} years` : ', interest only'}; cash flow ${usd(w.cashFlow)} on ${usd(w.equity)} of equity = ${pct(w.cashOnCash)} cash on cash`] : []),
    `Income value ${usd(w.incomeValue)} = ${usd(w.noi)} ÷ ${pct(n.valuation.capRate, 2)} cap rate`,
    ...(w.salesValue != null ? [`Sales value ${usd(w.salesValue)} = ${usd(n.valuation.asIsValuePerSqft.value)} per sq ft × ${b.grossSqft.toLocaleString('en-US')} sq ft`] : [])];
  const work = n.renovation.costPerSqft != null ? `${usd(n.renovation.costPerSqft)} per sq ft × ${b.grossSqft.toLocaleString('en-US')} sq ft` : usd(n.renovation.totalCost);
  const reno = `Work ${usd(w.renovationCost)} = ${work} + ${pct(n.renovation.contingencyRate, 0)} contingency; carry ${usd(w.carry)} over ${w.months} months (loan interest and taxes${n.renovation.vacant ? ', the building empty during the work' : ', less the income it earns while occupied'})`;
  if (id === 'renovate_rent') return [buy, reno, ops(w),
    `Yield on cost ${pct(w.yieldOnCost, 2)} = ${usd(w.noi)} ÷ all-in ${usd(w.allIn)}; value ${usd(w.value)} = ${usd(w.noi)} ÷ ${pct(n.valuation.capRate, 2)}`,
    `Refinance ${usd(w.refinanceLoan)}: the lower of ${pct(n.financing.loanToValue, 0)} of value and the loan the income carries at ${n.targets.dscr.toFixed(2)}x coverage; ${w.cashOut >= 0 ? `it repays the ${usd(p.loan)} purchase loan and returns ${usd(w.cashOut)} of cash` : `it falls ${usd(-w.cashOut)} short of repaying the ${usd(p.loan)} purchase loan, which the buyer pays down`}`];
  return [buy, reno,
    `Sale ${usd(w.salePrice)} = ${usd(n.valuation.afterRenovationValuePerSqft.value)} per sq ft × ${b.grossSqft.toLocaleString('en-US')} sq ft; selling costs ${pct(n.exit.sellingCostRate, 0)} ${usd(w.sellingCosts)}`,
    `Profit ${usd(w.profit)} = sale − selling costs − all-in ${usd(w.allIn)} (purchase, work and ${w.months} months of carry); ${pct(w.returnOnCost)} on cost${w.returnOnEquity != null ? `, ${pct(w.returnOnEquity)} on ${usd(w.equity)} of equity` : ''}`];
}

// The figure each way leads with in a downside, and how it reads.
const headline = (id, w) => (id === 'hold' ? w.cashFlow : id === 'renovate_rent' ? w.valueCreated : w.profit);
const HEADLINE = {hold: 'cash flow after debt service', renovate_rent: 'value over cost', renovate_sell: 'profit'};

// What would change the answer: the joint downside on each way, and the lead's margin over the next.
function changes(strategies, n) {
  const out = [], priced = strategies.filter(s => s.priced && s.maxPrice != null);
  for (const s of priced) {
    const d = s.downside;
    if (s.measure >= s.target && d.measure < d.target) out.push(`${s.label} misses its ${pct(s.target)} target in the joint downside (rents and values 10% lower, the work 20% dearer, the loan rate a point higher): ${pct(d.measure)}, ${HEADLINE[s.id]} ${usd(d.headline)}.`);
  }
  const ranked = [...priced].sort((a, b) => b.maxPrice - a.maxPrice);
  if (ranked.length > 1) {
    const [lead, next] = ranked;
    out.push(`${lead.label} pays ${usd(lead.maxPrice - next.maxPrice)} more for the building than ${next.label.toLowerCase()} at your targets.`);
    const downMax = s => s.downside.maxPrice ?? -Infinity;
    const downLead = [...priced].sort((a, b) => downMax(b) - downMax(a))[0];
    if (downLead !== lead && downMax(downLead) > downMax(lead)) out.push(`In the joint downside ${downLead.label} would pay the most instead: ${usd(downLead.downside.maxPrice)} against ${lead.downside.maxPrice == null ? 'no price at its target' : usd(lead.downside.maxPrice)}.`);
  }
  const hold = strategies.find(s => s.id === 'hold');
  if (hold.dscr != null && hold.dscr < n.targets.dscr) out.push(`As is the income covers debt service ${hold.dscr.toFixed(2)}x, under the ${n.targets.dscr.toFixed(2)}x lenders usually ask; it carries a loan of about ${usd(hold.loanAtTargetCoverage)}, not ${usd(hold.purchase.loan)}.`);
  return out;
}

function notesOf(n) {
  const notes = [];
  const reg = apartmentsAsIs(n).regulatedUnits;
  if (reg > 0) notes.push(`${reg} rent-regulated ${reg === 1 ? 'unit keeps its' : 'units keep their'} rent after the work: in New York the renovation increases a landlord may add to a regulated rent are small and capped, so only the free-market area earns the renovated rent. A sale price for a renovated building assumes it can be delivered as priced; with regulated tenants in place it usually cannot.`);
  const rented = n.income.rentRoll ? n.income.rentRoll.reduce((s, r) => s + r.units, 0) : null;
  if (rented != null && rented < n.building.residentialUnits) notes.push(`The rent roll lists ${rented} of ${n.building.residentialUnits} units; the other ${n.building.residentialUnits - rented} earn nothing as the building stands.`);
  if (n.building.residentialUnits >= 1 && n.building.residentialUnits <= 3 && n.building.commercialSqft === 0) notes.push('One to three family houses mostly sell to people who live in them, on comparable sales rather than on rent: the hold and renovate-and-rent results say what it earns as a rental; the comparable sales say what buyers pay.');
  notes.push('Taxes stay at the current bill. The city reassesses a building with four or more units by its income, so higher rents raise its taxes over the following years; a one to three family house is capped at 6% a year and 20% over five.');
  if (n.renovation) notes.push(`The work is paid from equity, and the carry is loan interest and taxes${n.renovation.vacant ? ' with the building empty' : ''}; permits, a new certificate of occupancy or tenant relocation it needs are not priced unless they are in the budget.`);
  notes.push('Values per sq ft and rents on the rentable area apply to the building area stated; a listing\'s interior area and the city\'s gross area differ, so read the comparable figure on the same basis.');
  const assumed = assumedWords(n);
  if (assumed.length) notes.push(`Planning assumptions, replace them with your own (${KEEP_DEFAULTS.source}, ${KEEP_DEFAULTS.asOf}): ${assumed.join('; ')}.`);
  return notes;
}

// Each planning default the analysis used, named with its value.
const ASSUMED = {
  'operating.vacancyRate': n => `vacancy ${pct(n.operating.vacancyRate)}`,
  'operating.operatingExpenseRatio': n => `operating costs ${pct(n.operating.operatingExpenseRatio, 0)} of income before taxes`,
  'financing.loanToValue': n => `a ${pct(n.financing.loanToValue, 0)} loan`,
  'financing.interestRate': n => `${pct(n.financing.interestRate, 2)} interest`,
  'financing.amortizationYears': n => (n.financing.amortizationYears ? `${n.financing.amortizationYears}-year amortization` : 'interest only'),
  'financing.loanCostRate': n => `loan costs ${pct(n.financing.loanCostRate)} of the loan`,
  'acquisition.closingCostRate': n => `closing costs ${pct(n.acquisition.closingCostRate)}`,
  'renovation.contingencyRate': n => `${pct(n.renovation.contingencyRate, 0)} contingency on the work`,
  'renovation.months': n => `${n.renovation.months} months of work`,
  'exit.sellingCostRate': n => `selling costs ${pct(n.exit.sellingCostRate, 0)}`,
  'exit.monthsToSell': n => `${n.exit.monthsToSell} months to sell`,
  'targets.returnOnCost': n => `a ${pct(n.targets.returnOnCost, 0)} return on cost to sell`,
  'targets.dscr': n => `${n.targets.dscr.toFixed(2)}x debt coverage`,
  'targets.yieldOnCost': n => `a ${pct(n.targets.yieldOnCost, 2)} yield on cost to renovate and rent (the cap rate plus one point)`,
};
// Defaults that only price a renovation (its work, its sale and its targets) are named only when there is one.
const RENOVATION_ONLY = path => path.startsWith('renovation.') || path.startsWith('exit.') || path === 'targets.returnOnCost' || path === 'targets.yieldOnCost';
export const assumedWords = n => n.assumed.filter(path => ASSUMED[path] && (n.renovation || !RENOVATION_ONLY(path))).map(path => ASSUMED[path](n));

function sourcesOf(n) {
  const rows = [n.income.rentPerSqftPerMonth, n.income.rentRollSource, n.income.commercialRentPerSqftPerYear, n.valuation.asIsValuePerSqft, n.valuation.afterRenovationValuePerSqft, n.renovation?.rentPerSqftPerMonth, n.operating.taxes].filter(Boolean);
  return {sourceIds: [...new Set(rows.map(r => r.sourceId).filter(id => id != null))], sources: rows.filter(r => r.source).map(r => ({source: r.source, retrievedAt: r.retrievedAt ?? null, url: r.url ?? null, sourceId: r.sourceId ?? null}))};
}

// Prices the three ways from normalized inputs: each way's figures at the price, the highest price at its
// target, the same under the joint downside, and the way that pays the most.
export function priceKeep(n) {
  const at = ways(n, n.purchasePrice), down = ways(n, n.purchasePrice, KEEP_DOWNSIDE);
  const downN = {...n, financing: {...n.financing, interestRate: n.financing.interestRate + KEEP_DOWNSIDE.rateBps / 10000}};
  const strategies = KEEP_IDS.map(id => {
    const w = at[id];
    if (!w.priced) return {id, label: KEEP_LABELS[id], priced: false, reason: w.reason};
    const maxPrice = highestPrice(n, id);
    const d = down[id];
    const downMax = highestPrice({...downN, ...scaleInputs(n, KEEP_DOWNSIDE)}, id);
    const {purchase: buy, ...figures} = w;
    return {
      id, label: KEEP_LABELS[id], ...roundAll(figures), purchase: roundAll(buy),
      maxPrice, headroom: maxPrice == null ? null : maxPrice - n.purchasePrice, call: callOf(maxPrice, n.purchasePrice),
      verdict: verdictOf(id, w, n, maxPrice),
      downside: {measure: round(d.measure, 4), target: d.target, headline: round(headline(id, d)), maxPrice: downMax},
      derivation: derivation(id, w, n),
    };
  });
  const priced = strategies.filter(s => s.priced && s.maxPrice != null);
  const lead = priced.reduce((a, s) => (!a || s.maxPrice > a.maxPrice ? s : a), null);
  const comparable = n.valuation.asIsValuePerSqft ? round(n.valuation.asIsValuePerSqft.value * n.building.grossSqft) : null;
  const decision = lead
    ? {id: lead.id, label: lead.label, maxPrice: lead.maxPrice, price: n.purchasePrice, call: lead.call,
      verdict: `Of the ways to keep the building, ${lead.label.toLowerCase()} pays the most: ${lead.maxPrice > 0 ? `up to ${usd(lead.maxPrice)}` : `nothing (residual ${usd(lead.maxPrice)})`} at your targets, against the ${usd(n.purchasePrice)} price${lead.call === 'supports_price' ? ', so the price works' : lead.call === 'below_price' ? `, ${usd(n.purchasePrice - lead.maxPrice)} short` : ''}.${comparable != null ? ` Standing buildings like it sell for about ${usd(comparable)}, ${pct(comparable / n.purchasePrice, 0)} of the price.` : ''}`}
    : {id: null, label: null, maxPrice: null, price: n.purchasePrice, call: 'no_value', verdict: 'None of the ways to keep the building earns its target at any price on these figures.'};
  return {
    name: n.name, price: n.purchasePrice, strategies, decision, comparable: comparable == null ? null : {value: comparable, perSqft: n.valuation.asIsValuePerSqft.value, shareOfPrice: round(comparable / n.purchasePrice, 4)},
    whatWouldChangeIt: changes(strategies, n), notes: notesOf(n), ...sourcesOf(n), inputs: n,
  };
}
// The joint downside's values and the work, as inputs, so the downside's highest price is solved on them.
function scaleInputs(n, s) {
  const scaleFigure = (f, k) => (f ? {...f, value: f.value * k} : f);
  return {
    income: {...n.income, rentPerSqftPerMonth: scaleFigure(n.income.rentPerSqftPerMonth, s.revenueScale), commercialRentPerSqftPerYear: scaleFigure(n.income.commercialRentPerSqftPerYear, s.revenueScale),
      rentRoll: n.income.rentRoll?.map(r => ({...r, monthlyRentPerUnit: r.monthlyRentPerUnit * s.revenueScale}))},
    valuation: {...n.valuation, asIsValuePerSqft: scaleFigure(n.valuation.asIsValuePerSqft, s.valueScale), afterRenovationValuePerSqft: scaleFigure(n.valuation.afterRenovationValuePerSqft, s.valueScale)},
    renovation: n.renovation && {...n.renovation, costPerSqft: n.renovation.costPerSqft == null ? null : n.renovation.costPerSqft * s.renovationScale, totalCost: n.renovation.totalCost == null ? null : n.renovation.totalCost * s.renovationScale,
      rentPerSqftPerMonth: scaleFigure(n.renovation.rentPerSqftPerMonth, s.revenueScale)},
  };
}
const roundAll = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v, Math.abs(v) < 10 ? 4 : 0) : v]));

export function computeKeep(args, facts = {}) {
  return priceKeep(normalizeKeep(args, facts));
}

// The numbers a user can set under assumptions.keep, with the range each takes, and the analysis input
// a default for it sits under (project-state.mjs checks these ranges on a user write).
export const KEEP_ASSUMPTION_RANGES = {
  renovationCostPerSqft: [0, 2000], renovationMonths: [0, 36, true], renovatedRentPerSqftPerMonth: [0.5, 30], afterRenovationValuePerSqft: [50, 15000],
  capRate: [0.02, 0.15], vacancyRate: [0, 0.5], operatingExpenseRatio: [0, 0.9], loanToValue: [0, 0.9], interestRate: [0, 0.25], amortizationYears: [0, 40, true], targetReturnOnCost: [0, 1],
};
const USER_KEYS = {vacancyRate: 'operating.vacancyRate', operatingExpenseRatio: 'operating.operatingExpenseRatio', loanToValue: 'financing.loanToValue', interestRate: 'financing.interestRate',
  amortizationYears: 'financing.amortizationYears', targetReturnOnCost: 'targets.returnOnCost', renovationMonths: 'renovation.months'};

// A saved analysis repriced in code with the user's numbers on top: their land price is the purchase
// price, and assumptions.keep replaces the work, rents, values and terms it names. It always starts from
// the inputs the run used (baseInputs), so a number the user clears goes back to the run's. Null when the
// saved analysis carries no inputs to reprice.
export function repriceKeep(previous, assumptions = {}, today = new Date().toISOString().slice(0, 10)) {
  const n = previous?.baseInputs ?? previous?.inputs;
  if (!n) return null;
  const k = assumptions.keep ?? {};
  const mine = value => ({value, source: 'Your input', retrievedAt: today, url: null, basis: null, sourceId: null});
  const set = (obj, key, value) => (value === undefined ? obj : {...obj, [key]: value});
  const next = structuredClone(n);
  // A default the user has now set is no longer an assumption.
  next.assumed = n.assumed.filter(path => !Object.entries(USER_KEYS).some(([key, input]) => input === path && k[key] !== undefined));
  if (assumptions.landPrice !== undefined && assumptions.landPrice >= 10_000) { next.purchasePrice = assumptions.landPrice; next.priceBasis = 'Your land price'; }
  next.operating = set(set(next.operating, 'vacancyRate', k.vacancyRate), 'operatingExpenseRatio', k.operatingExpenseRatio);
  next.financing = set(set(set(next.financing, 'loanToValue', k.loanToValue), 'interestRate', k.interestRate), 'amortizationYears', k.amortizationYears);
  if (k.capRate !== undefined) {
    const followsCap = n.targets.capRate === n.valuation.capRate, spread = n.targets.yieldOnCost - n.valuation.capRate;
    next.valuation = {...next.valuation, capRate: k.capRate, capRateBasis: 'Your input'};
    if (followsCap) next.targets = {...next.targets, capRate: k.capRate};
    if (n.assumed.includes('targets.yieldOnCost')) next.targets = {...next.targets, yieldOnCost: round(k.capRate + spread, 4)};
  }
  if (k.afterRenovationValuePerSqft !== undefined) next.valuation = {...next.valuation, afterRenovationValuePerSqft: mine(k.afterRenovationValuePerSqft)};
  if (k.targetReturnOnCost !== undefined) next.targets = {...next.targets, returnOnCost: k.targetReturnOnCost};
  const touchesWork = ['renovationCostPerSqft', 'renovationMonths', 'renovatedRentPerSqftPerMonth'].some(key => k[key] !== undefined);
  if (touchesWork) {
    const r = next.renovation ?? {costPerSqft: 0, totalCost: null, contingencyRate: KEEP_DEFAULTS.contingencyRate, months: KEEP_DEFAULTS.renovationMonths, vacant: true, rentPerSqftPerMonth: null, costBasis: 'Your input', scope: null};
    if (!next.renovation) next.assumed = [...next.assumed, 'renovation.contingencyRate', ...(k.renovationMonths === undefined ? ['renovation.months'] : [])];
    next.renovation = {
      ...r,
      ...(k.renovationCostPerSqft !== undefined ? {costPerSqft: k.renovationCostPerSqft, totalCost: null, costBasis: 'Your input'} : {}),
      ...(k.renovationMonths !== undefined ? {months: k.renovationMonths} : {}),
      ...(k.renovatedRentPerSqftPerMonth !== undefined ? {rentPerSqftPerMonth: mine(k.renovatedRentPerSqftPerMonth)} : {}),
    };
  }
  return {...priceKeep(next), baseInputs: n, createdAt: new Date().toISOString(), derived: true};
}

// The instant read a listing gets without a run: the building held as it stands, priced from figures the deal
// store already has (the ask, PLUTO's building area and units, the listing's annual tax and the ZIP's median
// asking rent) at a planning cap rate, beside what standing buildings of its kind sold for in the ZIP. It says
// why when it cannot price. Renovating needs a scope and renovated rents, so it waits for the keep underwriting.
export const QUICK_KEEP = {capRate: 0.06, asOf: KEEP_DEFAULTS.asOf, source: KEEP_DEFAULTS.source};
const day = at => {
  const d = new Date(typeof at === 'number' ? at : String(at ?? ''));
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
};
export function quickKeep(store = null) {
  if (!store) return null;
  const {price, grossSqft, residentialUnits, commercialSqft = 0, annualTax, regulatedUnits = 0, zipCode, rent, buildingSales} = store;
  const comparable = buildingSales && grossSqft > 0 && buildingSales.pricePerSqft > 0 ? {
    value: round(buildingSales.pricePerSqft * grossSqft), perSqft: buildingSales.pricePerSqft, saleCount: buildingSales.saleCount, kind: buildingSales.kind,
    months: buildingSales.months, zipCode: buildingSales.zipCode, shareOfAsk: price > 0 ? round(buildingSales.pricePerSqft * grossSqft / price, 4) : null,
  } : null;
  const comparableLine = comparable ? `${comparable.kind.charAt(0).toUpperCase()}${comparable.kind.slice(1)} buildings in ZIP ${comparable.zipCode} sold for a median $${Math.round(comparable.perSqft).toLocaleString('en-US')} per sq ft over ${comparable.months} months (${comparable.saleCount} sales), about ${usd(comparable.value)} for this building${comparable.shareOfAsk ? `, ${pct(comparable.shareOfAsk, 0)} of the ask` : ''}.` : null;
  const unpriced = reason => ({priced: false, reason, comparable, sentence: [reason, comparableLine].filter(Boolean).join(' ')});
  if (!(price > 0)) return unpriced('The listing has no asking price to read it against.');
  if (!(grossSqft > 0) || !(residentialUnits > 0)) return unpriced('No apartments are on record for this lot, so there is no rent to price it on.');
  if (!(rent?.perSqftPerMonth > 0)) return unpriced(`No apartments are listed for rent in ZIP ${zipCode} to price its rent from.`);
  if (annualTax == null || !(annualTax >= 0)) return unpriced('The listing gives no annual tax, so its net income is not shown; Underwrite to keep reads the city tax bill.');
  const rentSource = `Median asking rent of ${rent.sampleCount ? `${rent.sampleCount} ` : ''}apartments listed for rent in ZIP ${zipCode}, all building ages`;
  let n;
  try {
    n = normalizeKeep({
      name: 'Instant keep read', purchasePrice: price, priceBasis: 'Asking price',
      building: {grossSqft, residentialUnits, regulatedUnits: Math.min(Math.max(0, regulatedUnits || 0), residentialUnits), rentableSqft: round(Math.max(0, grossSqft - commercialSqft) * KEEP_DEFAULTS.rentableShare), source: 'PLUTO building area and residential units'},
      income: {rentPerSqftPerMonth: {value: round(rent.perSqftPerMonth, 2), source: rentSource, retrievedAt: day(rent.asOf)}},
      operating: {annualTaxes: annualTax, taxBasis: 'Annual tax stated on the listing'},
      valuation: {capRate: QUICK_KEEP.capRate, capRateBasis: `Planning cap rate (${QUICK_KEEP.source}, ${QUICK_KEEP.asOf})`,
        ...(comparable ? {asIsValuePerSqft: {value: comparable.perSqft, source: `Median price per sq ft of ${comparable.saleCount} ${comparable.kind} buildings sold in ZIP ${comparable.zipCode} in ${comparable.months} months`, retrievedAt: day(Date.now())}} : {})},
    });
  } catch (error) {
    return unpriced(`Its figures are out of range for a quick read (${error.message}).`);
  }
  const hold = priceKeep(n).strategies.find(s => s.id === 'hold');
  const pays = hold.maxPrice == null ? `no price earns a ${pct(QUICK_KEEP.capRate, 0)} cap rate on cost` : `at a ${pct(QUICK_KEEP.capRate, 0)} cap rate it pays up to ${usd(hold.maxPrice)}`;
  const sentence = `Kept as a rental at ZIP asking rents, it nets about ${usd(hold.noi)} a year after vacancy, operating costs and the listing's ${usd(annualTax)} taxes, ${pct(hold.capRateOnCost)} on the all-in cost; ${pays}.${comparableLine ? ` ${comparableLine}` : ''}`;
  return {
    priced: true, price, sentence, comparable, capRate: QUICK_KEEP.capRate,
    hold: {noi: hold.noi, grossRent: hold.grossRent, capRateOnCost: hold.capRateOnCost, allIn: hold.allIn, maxPrice: hold.maxPrice, call: hold.call, cashFlow: hold.cashFlow, dscr: hold.dscr},
    rent: {perSqftPerMonth: n.income.rentPerSqftPerMonth.value, source: rentSource, asOf: n.income.rentPerSqftPerMonth.retrievedAt},
    regulatedUnits: n.building.regulatedUnits,
    assumptions: [`a ${pct(QUICK_KEEP.capRate, 0)} cap rate`, ...assumedWords(n)],
    caveat: 'Asking rents across every building age in the ZIP; older apartments often rent for less, and regulated ones for much less. Renovating, and the tax bill on record, are priced when you underwrite to keep.',
  };
}

const sourcedSchema = (what, min, max) => ({type: 'object', additionalProperties: false, description: `${what}, with its source and retrieval date.`,
  properties: {value: {type: 'number', minimum: min, maximum: max}, source: {type: 'string'}, retrievedAt: {type: 'string', description: 'YYYY-MM-DD'}, url: {type: 'string'}, basis: {type: 'string', description: 'How the figure was derived, e.g. the comparables and the statistic taken.'}, sourceId: {type: 'integer', description: 'This run\'s source ID for the figure, when it has one.'}},
  required: ['value', 'source', 'retrievedAt']});
const rate = (what, max) => ({type: 'number', minimum: 0, maximum: max, description: what});

export const keepDefinition = {
  name: 'acres_keep_building',
  description: 'Underwrite buying a property as it stands instead of building new: hold it as is, renovate and rent it, or renovate and sell it, priced as code from the price, the building\'s income, the planned work and the financing. Each way returns its net operating income, all-in cost (price, closing costs, the buyer\'s NYC transfer taxes on one to three family houses, loan costs, the work and its carry), cap rate or yield on cost, cash flow after debt service, debt coverage and cash on cash, value or sale price, and the highest price that still meets its target, plus the same under a joint downside (rents and values 10% lower, work 20% dearer, rate a point higher). The decision names the way that pays the most for the building against the price. Rents, renovated rents and values per sq ft are market figures that need a source; financing, vacancy, operating costs, contingency and targets default to labeled planning assumptions listed in assumed. Regulated units keep their rents after a renovation. The result is the site\'s saved keep-the-building analysis, shown under "Should you buy it".',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      name: {type: 'string', description: 'Label, e.g. "Keep 1447 Dean Street".'},
      purchasePrice: {type: 'number', minimum: 10_000, maximum: 5_000_000_000, description: 'The price for the whole property, USD: the user\'s offer, the contract price or the asking price.'},
      priceBasis: {type: 'string', description: 'Where the price came from, e.g. "Asking price, StreetEasy listing, 2026-10-28".'},
      building: {type: 'object', additionalProperties: false, description: 'Omit to use the subject\'s PLUTO building area, residential units and commercial area.',
        properties: {grossSqft: {type: 'number'}, residentialUnits: {type: 'integer'}, commercialSqft: {type: 'number'}, regulatedUnits: {type: 'integer', description: 'Rent-stabilized or controlled units, when the rent is given per sq ft; a rentRoll marks them per row instead.'}, rentableSqft: {type: 'number', description: 'Residential rentable area; defaults to 85% of the residential gross area.'}, source: {type: 'string'}}},
      income: {type: 'object', additionalProperties: false, description: 'The building\'s income as it stands: exactly one of rentRoll or rentPerSqftPerMonth.',
        properties: {
          rentRoll: {type: 'array', minItems: 1, maxItems: 24, items: {type: 'object', additionalProperties: false, properties: {label: {type: 'string'}, units: {type: 'integer', minimum: 1}, monthlyRentPerUnit: {type: 'number', minimum: 0}, regulated: {type: 'boolean'}}, required: ['units', 'monthlyRentPerUnit']}, description: 'The leases in place; units missing from it earn nothing as is.'},
          rentRollSource: {type: 'object', description: 'Required with rentRoll: {source, retrievedAt, url?, basis?, sourceId?}, e.g. the offering memorandum or the seller\'s rent roll.'},
          rentPerSqftPerMonth: sourcedSchema('Market rent for the apartments as they stand, USD per rentable sq ft per month (comparable rentals in similar condition, not new construction)', 0.5, 30),
          commercialRentPerSqftPerYear: sourcedSchema('Commercial rent, USD per sq ft per year; required when the building has commercial space', 5, 3000),
          otherIncomePerYear: {type: 'number', minimum: 0},
        }},
      operating: {type: 'object', additionalProperties: false, properties: {
        vacancyRate: rate('Share of gross rent lost to vacancy and collection.', 0.5),
        operatingExpenseRatio: rate('Operating costs before real estate taxes as a share of effective gross income.', 0.9),
        annualTaxes: {type: 'number', minimum: 0, description: 'The current annual real estate tax bill, USD. Give this with taxBasis, or taxSource "ledger".'},
        taxBasis: {type: 'string', description: 'Where annualTaxes came from.'},
        taxSourceId: {type: 'integer'},
      }},
      taxSource: {type: 'string', enum: ['ledger'], description: 'ledger: the current DOF assessed value × the class tax rate, cited as an official record (NYC).'},
      valuation: {type: 'object', additionalProperties: false, properties: {
        capRate: {type: 'number', minimum: 0.02, maximum: 0.15, description: 'Market cap rate for the building\'s income: values the hold and renovate-and-rent results and, unless targets say otherwise, is the hold target.'},
        capRateBasis: {type: 'string'},
        asIsValuePerSqft: sourcedSchema('What standing buildings like it sold for, USD per sq ft of building', 50, 15000),
        afterRenovationValuePerSqft: sourcedSchema('What renovated buildings like it sold for, USD per sq ft of building; prices renovate and sell', 50, 15000),
      }, required: ['capRate']},
      renovation: {type: 'object', additionalProperties: false, description: 'The planned work; omit to price holding it as is only.', properties: {
        costPerSqft: {type: 'number', minimum: 0, maximum: 2000, description: 'USD per gross sq ft. Give this or totalCost.'},
        totalCost: {type: 'number', minimum: 0},
        costBasis: {type: 'string', description: 'Where the budget came from: the user, a contractor, or a labeled planning figure for the scope.'},
        contingencyRate: rate('Contingency on the work.', 0.5),
        months: {type: 'integer', minimum: 0, maximum: 36},
        vacant: {type: 'boolean', description: 'Whether the building is empty during the work (default true).'},
        rentPerSqftPerMonth: sourcedSchema('Market rent for renovated apartments, USD per rentable sq ft per month; prices renovate and rent', 0.5, 30),
        scope: {type: 'string', description: 'What the work covers, including repairs for open violations.'},
      }},
      financing: {type: 'object', additionalProperties: false, properties: {
        loanToValue: rate('Acquisition loan as a share of the price, and of value at a refinance.', 0.9),
        interestRate: rate('Annual rate.', 0.25),
        amortizationYears: {type: 'integer', minimum: 0, maximum: 40, description: '0 for interest only.'},
        loanCostRate: rate('Lender fees and mortgage recording tax as a share of the loan.', 0.06),
      }},
      acquisition: {type: 'object', additionalProperties: false, properties: {
        closingCostRate: rate('Buyer\'s closing costs other than transfer taxes, as a share of the price.', 0.1),
        transferTaxRate: rate(`Buyer's transfer taxes as a share of the price; omitted, the NYC schedule applies to one to three family houses (${NYC_BUYER_TRANSFER_TAX.source}).`, 0.05),
        residentialConveyance: {type: 'boolean', description: 'Override whether the buyer\'s residential transfer taxes apply.'},
      }},
      exit: {type: 'object', additionalProperties: false, properties: {sellingCostRate: rate('Broker and seller costs on a sale.', 0.15), monthsToSell: {type: 'integer', minimum: 0, maximum: 24}}},
      targets: {type: 'object', additionalProperties: false, properties: {
        capRate: {type: 'number', minimum: 0.02, maximum: 0.2, description: 'Hold: the cap rate on all-in cost the buyer needs.'},
        yieldOnCost: {type: 'number', minimum: 0.02, maximum: 0.25, description: 'Renovate and rent: the yield on all-in cost needed; defaults to the cap rate plus one point.'},
        returnOnCost: rate('Renovate and sell: the profit on all-in cost needed.', 1),
        dscr: {type: 'number', minimum: 1, maximum: 3, description: 'The debt coverage lenders ask for.'},
      }},
    },
    required: ['purchasePrice', 'income', 'valuation'],
  },
};

// getProperty returns the subject (its PLUTO building supplies building when omitted); ledger is the
// subject's development ledger reads, for taxSource "ledger".
export function createKeepTools({emit = () => {}, getProperty = () => null, ledger = null, record = () => null} = {}) {
  const analyses = [];
  async function run(args = {}) {
    if (analyses.length >= 3) throw new Error('At most three keep-the-building analyses per answer; compare the ones made.');
    const facts = {property: getProperty?.() ?? null};
    if (args?.taxSource === 'ledger') facts.taxes = ledgerTaxFacts(ledger, record, 'State operating.annualTaxes with taxBasis instead.');
    const result = {...computeKeep(args, facts), createdAt: new Date().toISOString()};
    analyses.push(result);
    emit('keep.computed', result);
    return {...result, note: 'Every figure is arithmetic on the inputs echoed in `inputs`; the derivation lines show it. Report the verdict, the highest price for each way and the decision from the result, never from hand arithmetic, with the sources of the rents and values and the planning assumptions listed in `inputs.assumed`. Returns are year-one and on total cost, not an IRR.'};
  }
  return {definitions: [keepDefinition], analyses, handlers: {acres_keep_building: run}};
}
