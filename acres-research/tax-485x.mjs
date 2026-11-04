// RPTL § 485-x (Affordable Neighborhoods for New Yorkers): the New York City property tax exemption
// for new rental buildings of six or more units. Pure calculation on stated inputs: the project class
// a unit count, zone and election make; the restricted units, mirroring the market unit mix; the
// exemption schedule and the taxes payable in each benefit year; the present value of the taxes
// exempted; and the construction wage floor on 100+ unit sites as a hard-cost premium. Statutory
// figures carry their subdivision; planning assumptions are labeled as such.
import {readFileSync} from 'node:fs';
import {num, int} from './market.mjs';

const TAX_RATES = JSON.parse(readFileSync(new URL('./nyc-tax-rates.json', import.meta.url), 'utf8'));

export const NYC_485X = {
  asOf: '2026-10-18',
  source: 'NY Real Property Tax Law § 485-x',
  sourceUrl: 'https://legislation.nysenate.gov/pdf/laws/RPT485-X',
  agencyUrl: 'https://www.nyc.gov/site/hpd/services-and-information/tax-incentives-485-x.page',
  wageUrl: 'https://comptroller.nyc.gov/services/for-the-public/workers-rights/485-x/',
  // § 1(r): commencement after June 15, 2022 and on or before June 15, 2034; completion by June 15, 2038.
  window: {commencementAfter: '2022-06-15', commencementOnOrBefore: '2034-06-15', completionOnOrBefore: '2038-06-15'},
  // § 6: benefits fall by the share of floor area in non-residential use above 12 percent.
  nonResidentialFloorAreaCap: 0.12,
  // § 1(oo): a small rental project sits on a zoning lot permitting at most 12,500 sq ft of residential floor area.
  smallLotMaxResidentialFloorArea: 12500,
  // § 1(uu), (vv): Zone A is Manhattan tax lots entirely south of 96th Street plus these 2020 NTAs; Zone B these NTAs.
  zoneNtas: {A: ['BK0101', 'BK0102', 'BK0103', 'BK0104', 'QN0201'], B: ['BK0201', 'BK0202', 'BK0203', 'BK0204', 'BK0601', 'BK0602', 'BK0801', 'QN0105', 'QN0102']},
  classes: {
    small: {label: 'small rental project', option: 'C', restrictedShare: 0.5, amiPct: null, benefit: [{years: 10, exemption: 1}], section: '§ 1(c), (oo), (pp)'},
    modest: {label: 'modest rental project', option: 'B', restrictedShare: 0.2, amiPct: 80, benefit: [{years: 25, exemption: 1}, {years: 10, exemption: 'affordability'}], section: '§ 1(b), (ee), (qq)'},
    large: {label: 'large rental project', option: 'A', restrictedShare: 0.25, amiPct: 80, benefit: [{years: 35, exemption: 1}], section: '§ 1(a)(i), (bb), (qq)'},
    veryLarge: {label: 'very large rental project', option: 'A', restrictedShare: 0.25, amiPct: 60, benefit: [{years: 40, exemption: 1}], section: '§ 1(a)(ii), (ss), (x)'},
  },
  // § 1(o), (u): a construction period of up to 3 years, 5 for a very large rental project in Zone A.
  constructionPeriodYears: {standard: 3, veryLargeZoneA: 5},
  // § 3: minimum hourly wages and supplements on sites of 100+ units, rising 2.5% on July 1, 2025 and each July 1 after.
  wageFloor: {
    firstIncrease: '2025-07-01', annualIncrease: 0.025,
    large: {hourly: 40, prevailingShare: null, section: '§ 3(a)'},
    veryLargeZoneA: {hourly: 72.45, prevailingShare: 0.65, section: '§ 3(b)'},
    veryLargeZoneB: {hourly: 63, prevailingShare: 0.60, section: '§ 3(c)'},
  },
};

// Maximum monthly rents by bedroom count (studio to three bedrooms) for the AMI bands 485-x uses.
export const HPD_AFFORDABLE_RENTS = {
  asOf: '2026-10-18',
  source: 'HPD, 2025 New York City Area Affordable Monthly Rents',
  sourceUrl: 'https://www.nyc.gov/site/hpd/services-and-information/area-median-income.page',
  byAmi: {60: [1701, 1822, 2187, 2527], 80: [2268, 2430, 2916, 3370]},
};

// DOF assesses class 2 property at 45 percent of market value and values rentals by capitalizing income.
export const DOF_CLASS2 = {assessmentRatio: 0.45, source: 'NYC Department of Finance, class 2 assessment (45% of market value) and property tax rates', sourceUrl: TAX_RATES.sourceUrl};
// Class 1 (one to three family homes) is assessed at 6 percent of market value.
export const DOF_CLASS1 = {assessmentRatio: 0.06, source: 'NYC Department of Finance, class 1 assessment (6% of market value) and property tax rates', sourceUrl: TAX_RATES.sourceUrl};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const wholeNumber = new Intl.NumberFormat('en-US');
const usd = n => (n < 0 ? '-$' : '$') + wholeNumber.format(Math.round(Math.abs(n)));
const cents = n => `$${n.toFixed(2)}`;
const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
const units = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function zone485x({borough, ntaCode = null, entirelySouthOf96thStreet = null}) {
  if (borough === 'MN') {
    if (typeof entirelySouthOf96thStreet !== 'boolean') throw new Error('location.entirelySouthOf96thStreet is required in Manhattan: Zone A covers Manhattan tax lots entirely south of 96th Street.');
    return entirelySouthOf96thStreet ? 'A' : null;
  }
  if (borough === 'BK' || borough === 'QN') {
    if (!/^(BK|QN)\d{4}$/.test(ntaCode ?? '') || !ntaCode.startsWith(borough)) throw new Error(`location.ntaCode is required in ${borough === 'BK' ? 'Brooklyn' : 'Queens'} as a 2020 neighborhood tabulation area code such as ${borough}0101; Zones A and B are defined by NTA.`);
    return Object.keys(NYC_485X.zoneNtas).find(zone => NYC_485X.zoneNtas[zone].includes(ntaCode)) ?? null;
  }
  if (borough === 'BX' || borough === 'SI') return null;
  throw new Error('location.borough must be one of MN, BK, QN, BX, SI.');
}

// The project class a unit count, zone and option make, or the reason the option does not apply.
export function projectClass485x({units: count, option, zone, borough, residentialFloorAreaPermitted = null}) {
  const no = reason => ({eligible: false, reason});
  if (count < 6) return no(`${units(count)} units is below the six dwelling units 485-x requires (§ 1(r)).`);
  if (option === 'C') {
    if (count > 10) return no(`Option C is for small rental projects of 6 to 10 units; ${units(count)} units does not qualify (§ 1(oo)).`);
    if (borough === 'MN') return no('Option C excludes Manhattan (§ 1(oo)).');
    if (!(residentialFloorAreaPermitted <= NYC_485X.smallLotMaxResidentialFloorArea)) return no(`Option C needs a zoning lot permitting at most ${NYC_485X.smallLotMaxResidentialFloorArea.toLocaleString('en-US')} sq ft of residential floor area (§ 1(oo)).`);
    return {eligible: true, key: 'small', ...NYC_485X.classes.small};
  }
  if (option === 'B') return count < 100 ? {eligible: true, key: 'modest', ...NYC_485X.classes.modest} : no(`${units(count)} units is a large rental project, which must comply with Option A (§ 8).`);
  if (count < 100) return no(`Option A applies from 100 units; ${units(count)} units is a modest rental project under Option B (§ 1(ee), § 8).`);
  const key = count >= 150 && (zone === 'A' || zone === 'B') ? 'veryLarge' : 'large';
  return {eligible: true, key, ...NYC_485X.classes[key]};
}

// Restricted units by bedroom type, proportional to the market mix (§ 8(b)(i)); whole units when the
// program is in whole units, with the largest remainders rounded up. § 8(b)(ii) also allows a mix
// with at least half two-bedroom or larger and at most a quarter studios; it is not modeled here.
export function restrictedUnits485x(mix, share) {
  const total = mix.reduce((sum, u) => sum + u.count, 0);
  const required = Math.ceil(share * total - 1e-9);
  const exact = mix.map(u => (u.count * required) / total);
  if (!mix.every(u => Number.isInteger(u.count))) return mix.map((u, i) => ({bedrooms: u.bedrooms, count: exact[i]}));
  const whole = exact.map(Math.floor);
  const order = exact.map((_, i) => i).sort((a, b) => (exact[b] - whole[b]) - (exact[a] - whole[a]) || mix[b].count - mix[a].count);
  let left = required - whole.reduce((s, n) => s + n, 0);
  for (const i of order) if (left > 0 && whole[i] < mix[i].count) { whole[i]++; left--; }
  return mix.map((u, i) => ({bedrooms: u.bedrooms, count: whole[i]}));
}

// Post-completion benefit years with the exemption fraction for each.
export function exemptionSchedule485x(projectClass, affordabilityPct) {
  let year = 1;
  return projectClass.benefit.map(({years, exemption}) => {
    const row = {fromYear: year, toYear: year + years - 1, exemption: exemption === 'affordability' ? affordabilityPct : exemption};
    year += years;
    return row;
  });
}

// Taxes each benefit year and the present value of the taxes exempted, at the stabilized tax level
// held flat. The owner keeps paying taxes on the pre-commencement assessed value (§ 5(a)), so the
// exemption reaches the taxes above that base; non-residential area above 12% reduces it (§ 6).
export function exemptionValue485x({fullTaxes, baseTaxes, schedule, nonResidentialShare, discountRate}) {
  const reduction = Math.max(0, nonResidentialShare - NYC_485X.nonResidentialFloorAreaCap);
  const exemptible = Math.max(0, fullTaxes - baseTaxes);
  const periods = schedule.map(row => {
    const exemption = row.exemption * (1 - reduction);
    const payable = fullTaxes - exemption * exemptible;
    return {...row, exemption, payable, savings: fullTaxes - payable};
  });
  let presentValue = 0;
  for (const p of periods) for (let t = p.fromYear; t <= p.toYear; t++) presentValue += p.savings / (1 + discountRate) ** t;
  const benefitYears = periods.length ? periods.at(-1).toYear : 0;
  return {reduction, exemptible, periods, benefitYears, year1Payable: periods[0]?.payable ?? fullTaxes, year1Savings: periods[0]?.savings ?? 0, presentValue};
}

// The § 3 floor on one date: the statutory figure raised 2.5% on each July 1 from 2025 through the date.
export function wageFloorOn(base, date) {
  const d = new Date(`${date}T00:00:00Z`), year = d.getUTCFullYear();
  const increases = Math.max(0, year - 2025 + (d >= new Date(`${year}-07-01T00:00:00Z`) ? 1 : 0));
  return Math.round(base * (1 + NYC_485X.wageFloor.annualIncrease) ** increases * 100 + 1e-6) / 100;
}

const addMonths = (date, months) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

// The construction wage floor for a project class and zone, averaged over the construction months;
// null under 100 units. For a very large project it is the lesser of the dollar figure and a share of
// the greatest prevailing rate in a classification; without that rate the dollar figure is an upper bound.
export function wageFloor485x({projectClass, units: count, zone, start, months, greatestPrevailingWage = null}) {
  if (count < 100) return null;
  const tier = projectClass === 'veryLarge' ? (zone === 'A' ? NYC_485X.wageFloor.veryLargeZoneA : NYC_485X.wageFloor.veryLargeZoneB) : NYC_485X.wageFloor.large;
  const floors = Array.from({length: months}, (_, m) => wageFloorOn(tier.hourly, addMonths(start, m)));
  const statutory = Math.round(floors.reduce((s, f) => s + f, 0) / floors.length * 100) / 100;
  const prevailingCap = tier.prevailingShare && greatestPrevailingWage ? tier.prevailingShare * greatestPrevailingWage : null;
  const hourly = prevailingCap === null ? statutory : Math.min(statutory, prevailingCap);
  return {
    hourly, atStart: floors[0], section: tier.section, upperBound: Boolean(tier.prevailingShare) && prevailingCap === null,
    basis: `Wage floor (${tier.section}) = ${cents(tier.hourly)} raised 2.5% each July 1 from 2025, averaging ${cents(statutory)}/hour over ${months} construction months from ${start} (${cents(floors[0])} at start)`
      + (tier.prevailingShare ? (prevailingCap === null ? `; the floor is the lesser of this and ${pct(tier.prevailingShare, 0)} of the greatest prevailing rate in a classification, which was not given, so this is an upper bound` : `, capped at ${pct(tier.prevailingShare, 0)} × ${cents(greatestPrevailingWage)} prevailing = ${cents(prevailingCap)}`) : ''),
  };
}

// Hard-cost premium when the floor binds: labor's share of hard cost times the wage increase over the
// project's expected average wages and supplements per hour.
export const wagePremium485x = (floorHourly, {laborShareOfHardCost, currentHourlyWage}) => laborShareOfHardCost * Math.max(0, floorHourly / currentHourlyWage - 1);

// Full class 2 taxes on the completed building by DOF's income method: market value = net operating
// income before taxes ÷ (base capitalization rate + effective tax rate), taxed at 45% assessment × the
// latest published class 2 rate. The base capitalization rate is the caller's stated assumption.
export function dofFullTaxes(noiBeforeTaxes, dofCapRate, taxClass = '2') {
  const fiscalYear = Object.keys(TAX_RATES.fiscalYears).sort().at(-1);
  const rate = TAX_RATES.fiscalYears[fiscalYear].rates[taxClass];
  const ratio = (taxClass === '1' ? DOF_CLASS1 : DOF_CLASS2).assessmentRatio;
  const effective = ratio * rate;
  const marketValue = noiBeforeTaxes / (dofCapRate + effective);
  const annualTaxes = marketValue * effective;
  return {annualTaxes, marketValue, effectiveRate: effective, rate, fiscalYear, taxClass,
    basis: `Full taxes on the completed building = DOF income method: NOI before taxes ${usd(noiBeforeTaxes)} ÷ (base cap rate ${pct(dofCapRate, 2)} + effective tax rate ${pct(ratio, 0)} × FY${fiscalYear} class ${taxClass}${taxClass === '4' ? ' (commercial)' : ''} rate ${pct(rate, 3)} = ${pct(effective, 3)}) = market value ${usd(marketValue)}; taxes = ${usd(annualTaxes)}`};
}

// Validation of the pro forma's taxIncentive input; facts.taxes (the ledger's current assessment)
// supplies the base taxes when present.
export function normalizeTaxIncentive(t, productType, facts = {}) {
  if (!t || typeof t !== 'object' || t.program !== '485-x') throw new Error("taxIncentive.program must be '485-x'.");
  if (productType !== 'rental') throw new Error('taxIncentive applies to rental pro formas; the 485-x homeownership option is not modeled.');
  if (!['A', 'B', 'C'].includes(t.option)) throw new Error('taxIncentive.option must be A, B or C.');
  const location = {borough: t.location?.borough, ntaCode: t.location?.ntaCode ?? null, entirelySouthOf96thStreet: t.location?.entirelySouthOf96thStreet ?? null};
  const zone = zone485x(location);
  if ((t.fullAnnualTaxes === undefined) === (t.dofCapRate === undefined)) throw new Error('Give exactly one of taxIncentive.fullAnnualTaxes (the completed building\'s full annual taxes) or taxIncentive.dofCapRate (estimate them by the DOF income method).');
  const ledgerBase = facts.taxes ?? t.baseTaxFact ?? null;
  if (ledgerBase && t.baseAnnualTaxes !== undefined && !t.baseTaxFact) throw new Error('Give the base taxes once: taxSource ledger or taxIncentive.baseAnnualTaxes.');
  const c = t.construction ?? {};
  if (!ISO_DATE.test(c.start ?? '')) throw new Error('taxIncentive.construction.start must be the expected commencement date as YYYY-MM-DD.');
  const months = int(c.months, 'taxIncentive.construction.months', 1, 120);
  const completion = addMonths(c.start, months), w = NYC_485X.window;
  if (!(c.start > w.commencementAfter && c.start <= w.commencementOnOrBefore)) throw new Error(`485-x requires commencement after ${w.commencementAfter} and on or before ${w.commencementOnOrBefore} (§ 1(r)).`);
  if (completion > w.completionOnOrBefore) throw new Error(`Completion ${completion} is after ${w.completionOnOrBefore}, the last completion date 485-x allows (§ 1(r)).`);
  const out = {
    program: '485-x', option: t.option, location, zone,
    ...(t.option === 'C' && {residentialFloorAreaPermitted: num(t.residentialFloorAreaPermitted, 'taxIncentive.residentialFloorAreaPermitted', 0, 1_000_000)}),
    ...(t.fullAnnualTaxes !== undefined ? {fullAnnualTaxes: num(t.fullAnnualTaxes, 'taxIncentive.fullAnnualTaxes', 0, 500_000_000)} : {dofCapRate: num(t.dofCapRate, 'taxIncentive.dofCapRate', 0.02, 0.2)}),
    baseAnnualTaxes: ledgerBase ? ledgerBase.annualTaxes : num(t.baseAnnualTaxes, 'taxIncentive.baseAnnualTaxes', 0, 500_000_000),
    ...(ledgerBase && {baseTaxFact: ledgerBase}),
    discountRate: num(t.discountRate, 'taxIncentive.discountRate', 0.01, 0.25),
    construction: {start: c.start, months, completion},
  };
  if (t.option === 'A') {
    out.construction.laborShareOfHardCost = num(c.laborShareOfHardCost, 'taxIncentive.construction.laborShareOfHardCost', 0, 0.8);
    out.construction.currentHourlyWage = num(c.currentHourlyWage, 'taxIncentive.construction.currentHourlyWage', 10, 300);
    if (c.greatestPrevailingWage !== undefined && c.greatestPrevailingWage !== null) out.construction.greatestPrevailingWage = num(c.greatestPrevailingWage, 'taxIncentive.construction.greatestPrevailingWage', 10, 500);
  }
  return out;
}

// A program carrying full taxes, market rents and no wage floor: ineligible, or the comparison case.
export const withoutBenefit = (reason, count, nonResidentialShare) => ({eligible: false, reason, units: count, restricted: [], schedule: [], nonResidentialShare, wage: null, hardCostPremium: 0});

// What the incentive does to one program before the money is computed: the class, restricted units
// and their rents, the schedule and the wage premium. An ineligible program carries no benefit.
export function plan485x(incentive, program) {
  const count = program.units.reduce((s, u) => s + u.count, 0);
  const nonResidentialShare = program.commercial.reduce((s, c) => s + c.netSqft, 0) / program.grossBuildingSqft;
  const klass = projectClass485x({units: count, option: incentive.option, zone: incentive.zone, borough: incentive.location.borough, residentialFloorAreaPermitted: incentive.residentialFloorAreaPermitted});
  if (!klass.eligible) return withoutBenefit(klass.reason, count, nonResidentialShare);
  const restricted = restrictedUnits485x(program.units, klass.restrictedShare);
  const restrictedCount = restricted.reduce((s, u) => s + u.count, 0);
  const affordabilityPct = klass.amiPct ? restrictedCount / count : 0;
  const wage = wageFloor485x({projectClass: klass.key, units: count, zone: incentive.zone, ...incentive.construction});
  const hardCostPremium = wage ? wagePremium485x(wage.hourly, incentive.construction) : 0;
  return {
    eligible: true, projectClass: klass.key, label: klass.label, option: klass.option, section: klass.section, units: count,
    restrictedShare: klass.restrictedShare, amiPct: klass.amiPct, restricted, restrictedCount, affordabilityPct,
    schedule: exemptionSchedule485x(klass, affordabilityPct),
    constructionPeriodYears: Math.min(incentive.construction.months / 12, klass.key === 'veryLarge' && incentive.zone === 'A' ? NYC_485X.constructionPeriodYears.veryLargeZoneA : NYC_485X.constructionPeriodYears.standard),
    nonResidentialShare, wage, hardCostPremium,
  };
}

// The affordable monthly rent for a bedroom count at the class's AMI band.
export const affordableRent485x = (amiPct, bedrooms) => HPD_AFFORDABLE_RENTS.byAmi[amiPct][bedrooms];

// The derivation lines for a planned incentive (money lines are added by the caller).
export function planDerivation(plan, incentive) {
  if (!plan.eligible) return [`485-x not applied: ${plan.reason}`];
  const restricted = plan.restricted.filter(r => r.count > 0).map(r => `${units(r.count)} × ${['studio', 'one-bedroom', 'two-bedroom', 'three-bedroom'][r.bedrooms]}`).join(', ');
  const lines = [
    `485-x ${plan.label}, Option ${plan.option} (${plan.section}), zone ${incentive.zone ?? 'outside Zones A and B'}: ${units(plan.units)} units, at least ${pct(plan.restrictedShare, 0)} restricted = ${units(plan.restrictedCount)} units mirroring the market mix (${restricted})`
      + (plan.amiPct ? ` at a ${plan.amiPct}% AMI weighted average, priced at HPD's ${plan.amiPct}% AMI maximum rents; restricted units stay rent stabilized permanently (§ 8(c))` : ', rent stabilized at the initial market rent (rents stay at market in year one; later increases follow the Rent Guidelines Board)'),
    `485-x exemption: ${plan.schedule.map(r => `years ${r.fromYear}-${r.toYear} at ${pct(r.exemption, 1)}`).join(', ')} after completion, plus up to ${plan.constructionPeriodYears.toFixed(1)} construction-period years at 100% (not valued: the pro forma carries no construction-period taxes)`,
  ];
  if (plan.wage) lines.push(`${plan.wage.basis}; hard-cost premium = labor share ${pct(incentive.construction.laborShareOfHardCost, 0)} × (${cents(plan.wage.hourly)} ÷ expected ${cents(incentive.construction.currentHourlyWage)} − 1, floored at 0) = ${pct(plan.hardCostPremium, 2)}. A project labor agreement covering all work, or a collective bargaining agreement waiving § 3, removes the floor (§ 3(h), (i))`);
  return lines;
}

// Planning assumptions for the deal screen's real estate taxes and 485-x wage floor; not from a published
// dataset or cost index.
export const DEAL_SCREEN_485X = {
  asOf: '2026-10-20',
  source: 'Arosa planning assumption for the deal screen real estate taxes and 485-x wage floor; not from a published dataset or cost index',
  dofCapRate: 0.08,
  laborShareOfHardCost: 0.45,
  currentHourlyWage: 38,
  constructionMonths: 24,
};

// The share of NOI before taxes that full taxes take by the DOF income method, at the screen's base cap
// rate: class 1 for three units or fewer, class 2 above.
export const taxShareOfNoi = units => {
  const {effectiveRate} = dofFullTaxes(1, DEAL_SCREEN_485X.dofCapRate, units <= 3 ? '1' : '2');
  return effectiveRate / (DEAL_SCREEN_485X.dofCapRate + effectiveRate);
};

// The same DOF income-method share for a named tax class (a wholly commercial building pays class 4).
export const taxShareOfNoiForClass = taxClass => {
  const {effectiveRate} = dofFullTaxes(1, DEAL_SCREEN_485X.dofCapRate, taxClass);
  return effectiveRate / (DEAL_SCREEN_485X.dofCapRate + effectiveRate);
};

// The 485-x terms a rental building of this many units elects on the deal screen: Option B from 6 to
// 99 units (modest rental project), Option A from 100 (large; very large at 150+ in Zone A or B), with
// the § 3 wage floor as a hard-cost premium from 100 units over the screen's construction months from
// the valuation date; null below six units or after the commencement window. Option C is not screened.
// With the zone undetermined, 150+ units stay a large project.
export function dealElection485x({units: count, zone = null, valuationDate}) {
  if (count < 6 || valuationDate > NYC_485X.window.commencementOnOrBefore) return null;
  const klass = projectClass485x({units: count, option: count < 100 ? 'B' : 'A', zone});
  const a = DEAL_SCREEN_485X;
  const wage = wageFloor485x({projectClass: klass.key, units: count, zone, start: valuationDate, months: a.constructionMonths});
  return {
    key: klass.key, label: klass.label, option: klass.option, section: klass.section, restrictedShare: klass.restrictedShare, amiPct: klass.amiPct, benefit: klass.benefit,
    benefitYears: klass.benefit.reduce((s, b) => s + b.years, 0),
    wageFloorHourly: wage ? Number(wage.hourly.toFixed(2)) : null, wageSection: wage?.section ?? null, wageUpperBound: wage?.upperBound ?? false,
    hardCostPremium: wage ? wagePremium485x(wage.hourly, a) : 0,
  };
}

// What a unit count allowed means for a new rental's 485-x path: from 100 units the project is large
// (Option A, construction wage floor), while a building held to 99 is modest (Option B, no wage floor).
export function unitThreshold485x(maxUnits) {
  if (!(maxUnits >= 100)) return null;
  return `The zoning allows ${maxUnits} units. A new rental of 100 or more units takes 485-x Option A, 25% of units at 80% AMI with the construction wage floor (RPTL 485-x § 3(a)); held to 99 units it is a modest rental project under Option B, 20% at 80% AMI with no wage floor (§ 1(b), (ee)).`;
}

// The present value, at the discount rate, of the 485-x exemption on one dollar of annual full taxes held flat.
export const exemptionFactor485x = (schedule, nonResidentialShare, discountRate) => exemptionValue485x({fullTaxes: 1, baseTaxes: 0, schedule, nonResidentialShare, discountRate});
