import {normalizeMarketInputs, num} from './market.mjs';
import {sensitivity, rerun, ledgerFacts, normalizeProgram, proFormaDefinition} from './proforma.mjs';
import {dofFullTaxes, normalizeTaxIncentive, plan485x} from './tax-485x.mjs';

const round = (n, d = 0) => Number(n.toFixed(d));
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
const pct = n => `${round(n * 100, 1)}%`;
const signedPct = n => `${n > 0 ? '+' : ''}${pct(n)}`;

const rentScaleOf = variant => variant.rentScale ?? (variant.affordableShare != null
  ? 1 - variant.affordableShare + variant.affordableShare * (variant.affordableRentScale ?? 1) : 1);
// The joint downside every variant is tested at: rents and prices down, hard and soft cost up and,
// where the variant has income, the cap rate up, all at once.
export const JOINT_DOWNSIDE = {revenueScale: 0.9, costScale: 1.1, capRateBps: 50};
const separateTaxes = variant => variant.taxIncentive !== undefined || variant.annualTaxes !== undefined || variant.completedTaxDofCapRate !== undefined;
const variantProgram = (variant, sharedProgram) => variant.program ?? {...sharedProgram,
  ...(variant.grossBuildingSqft != null ? {grossBuildingSqft: variant.grossBuildingSqft} : {})};

function validateVariants(variants, sharedProgram, shared = {}) {
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 4) throw new Error('Give one to four program variants.');
  for (const [index, variant] of variants.entries()) {
    const path = `variants[${index}]`;
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) throw new Error(`${path} must be an object.`);
    if (!['rental', 'condo', 'commercial'].includes(variant.productType)) throw new Error(`${path}.productType must be rental, condo or commercial.`);
    if (variant.rentScale != null && !(Number.isFinite(variant.rentScale) && variant.rentScale > 0 && variant.rentScale <= 2)) throw new Error(`${path}.rentScale must be a number greater than 0 and at most 2.`);
    if (variant.priceScale != null && !(Number.isFinite(variant.priceScale) && variant.priceScale > 0)) throw new Error(`${path}.priceScale must be a finite number greater than 0.`);
    if (variant.affordableShare != null) num(variant.affordableShare, `${path}.affordableShare`, 0, 1);
    // Affordable area earns restricted rents, so it needs a rental scenario; on a condo exit it would
    // silently change nothing. Reject it rather than price a market condo under an affordable label.
    if (variant.productType === 'condo' && Number(variant.affordableShare) > 0) throw new Error(`${path}.affordableShare requires a rental scenario: affordable floor area earns restricted rents and cannot be priced on a condo exit. Use productType "rental" for this variant, or remove affordableShare.`);
    // The same rule for the rent multiplier itself: on a condo exit it would scale rents the
    // sellout never reads and change nothing under a scaled label.
    if (variant.productType === 'condo' && variant.rentScale != null && variant.rentScale !== 1) throw new Error(`${path}.rentScale scales residential rents, which a condo sellout does not use; use priceScale to move sale prices, or remove rentScale.`);
    // Commercial is the wholly non-residential income exit: no affordable units, no sale prices and no
    // 485-x (a residential exemption). A mixed-use building is rental or condo with commercial rows.
    if (variant.productType === 'commercial' && Number(variant.affordableShare) > 0) throw new Error(`${path}.affordableShare requires a rental scenario: a commercial variant has no homes to restrict. Use productType "rental" for a mixed-use building, or remove affordableShare.`);
    if (variant.productType === 'commercial' && variant.priceScale != null && variant.priceScale !== 1) throw new Error(`${path}.priceScale moves condo sale prices, which a commercial variant does not use; use rentScale to move commercial rents, or remove priceScale.`);
    if (variant.productType === 'commercial' && variant.taxIncentive !== undefined) throw new Error(`${path}.taxIncentive is the residential 485-x exemption; a commercial variant carries annualTaxes or ledger taxes instead.`);
    if (variant.affordableRentScale != null && !(Number.isFinite(variant.affordableRentScale) && variant.affordableRentScale >= 0)) throw new Error(`${path}.affordableRentScale must be a finite nonnegative number.`);
    if (variant.entitlementScore != null) num(variant.entitlementScore, `${path}.entitlementScore`, 0, 100);
    if (variant.timelineMonths != null) num(variant.timelineMonths, `${path}.timelineMonths`, 0, 60);
    if (variant.approvalMonthsIncludedInFinancing != null) num(variant.approvalMonthsIncludedInFinancing, `${path}.approvalMonthsIncludedInFinancing`, 0, variant.timelineMonths ?? 0);
    if (variant.grossBuildingSqft != null) num(variant.grossBuildingSqft, `${path}.grossBuildingSqft`, 500, 20_000_000);
    // Taxes per variant: a 485-x exemption or the completed building's stated taxes, on income variants.
    if (separateTaxes(variant) && variant.productType === 'condo') throw new Error(`${path} taxes apply to rental and commercial variants only; a condo sellout carries no stabilized operating taxes.`);
    if (variant.taxIncentive !== undefined && variant.annualTaxes !== undefined) throw new Error(`${path}: give taxIncentive or annualTaxes, not both; the incentive states the building's full taxes itself.`);
    if (variant.taxIncentive !== undefined && (variant.affordableShare != null || variant.affordableRentScale != null)) throw new Error(`${path}: 485-x sets its own restricted units and rents; remove affordableShare and affordableRentScale from this variant.`);
    if (variant.annualTaxes !== undefined) num(variant.annualTaxes, `${path}.annualTaxes`, 0, 500_000_000);
    if (variant.completedTaxDofCapRate !== undefined) num(variant.completedTaxDofCapRate, `${path}.completedTaxDofCapRate`, 0.02, 0.2);
    const rentScale = rentScaleOf(variant);
    if (!(rentScale > 0 && rentScale <= 2)) throw new Error(`${path} rent scaling must be within 0 to 2.`);
    normalizeProgram(variantProgram(variant, sharedProgram));
  }
  // Operating expenses exclude taxes once any variant carries its own, so every rental must carry a tax line.
  const taxed = variants.find(separateTaxes);
  const untaxed = variants.find(variant => variant.productType !== 'condo' && !separateTaxes(variant));
  if (taxed && untaxed) throw new Error(`${taxed.label || 'A variant'} carries its own real estate taxes, so operating expenses exclude taxes; give ${untaxed.label || 'every other rental variant'} annualTaxes so every rental pays taxes on the completed-building basis.`);
}

// The site page's options as comparison variants. Store rents at an AMI are absolute rents, not a
// ratio inferred from another option's market rent. When one option elects 485-x, every other rental
// uses its own completed-building tax estimate, never the subject lot's current assessment.
const BEDROOMS = {studio: 0, oneBedroom: 1, twoBedroom: 2, threeBedroom: 3};
const BEDROOM_WORDS = ['studio', 'one-bedroom', 'two-bedroom', 'three-bedroom'];
const listWords = words => words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
export function storeVariants(schemes, {market, shared, taxIncentive = null, facts = {}}) {
  const variants = [], skipped = [];
  const has485x = schemes.some(s => s.program?.exit === 'rental' && s.program.taxProgram?.kind === '485-x');
  for (const s of schemes.filter(s => s.program)) {
    const p = s.program, rental = p.exit === 'rental', tax = p.taxProgram;
    const skip = reason => skipped.push({storeOption: s.id, label: s.label, summary: s.summary, reason});
    if (tax?.kind === 'city-financed') { skip('The pro forma does not price its city loans and tax credit equity.'); continue; }
    if (!rental && p.affordableZfa > 0) { skip('A condo sellout pro forma does not price its affordable rentals.'); continue; }
    const rows = new Map();
    for (const u of p.unitMix) {
      const bedrooms = BEDROOMS[u.type], row = rows.get(bedrooms) ?? {bedrooms, count: 0, area: 0};
      row.count += u.units; row.area += u.units * u.netSqft; rows.set(bedrooms, row);
    }
    const units = [...rows.values()].filter(r => r.count > 0).map(r => ({bedrooms: r.bedrooms, count: r.count, netSqft: Math.floor(r.area / r.count)}));
    const prices = rental ? market.rents : market.salePrices;
    const missing = units.filter(u => !(prices ?? []).some(r => r.bedrooms === u.bedrooms)).map(u => BEDROOM_WORDS[u.bedrooms]);
    if (missing.length) { skip(`The market inputs have no ${rental ? 'rent' : 'sale price'} per sq ft for ${listWords(missing)} units.`); continue; }
    if (!rental && shared.sellingCostRate == null) { skip('A condo needs shared.sellingCostRate.'); continue; }
    if (rental && (shared.capRate == null || !shared.operating)) { skip('A rental needs shared.capRate and shared.operating.'); continue; }
    const program = {grossBuildingSqft: p.grossSqft, units}, unpriced = [];
    let terms = {};
    if (tax?.kind === '485-x') {
      if (!taxIncentive) { skip(`Pricing its 485-x Option ${tax.option} exemption needs taxIncentive, the run's 485-x terms.`); continue; }
      const incentive = {...taxIncentive, option: tax.option};
      const plan = plan485x(normalizeTaxIncentive(incentive, 'rental', facts), normalizeProgram(program));
      if (!plan.eligible) { skip(`485-x Option ${tax.option} does not apply to it on the run's terms: ${plan.reason}`); continue; }
      terms = {taxIncentive: incentive};
      if (p.affordableZfa > 0) unpriced.push(`the zoning set-aside of ${round(p.affordableZfa / p.zfa * 100)}% of the floor area, priced only as 485-x's own restricted units`);
    } else if (p.affordableZfa > 0) {
      const area = units.reduce((sum, u) => sum + u.count * u.netSqft, 0);
      const marketRent = units.reduce((sum, u) => sum + u.count * u.netSqft * prices.find(r => r.bedrooms === u.bedrooms).rentPerSqftPerMonth, 0) / area;
      const restricted = Math.min(p.affordableRentPsf, marketRent);
      terms = {affordableShare: round(p.affordableZfa / p.zfa, 4), affordableRentScale: round(restricted / marketRent, 4), affordableRentPerSqftPerMonth: round(restricted, 2)};
    }
    if (rental && tax?.kind !== '485-x' && has485x && taxIncentive) terms.completedTaxDofCapRate = taxIncentive.dofCapRate;
    variants.push({label: `${s.label}: ${s.summary.split(', ')[0]}`, productType: p.exit, program, ...terms, storeOption: s.id, unpriced});
  }
  return {variants, skipped};
}

function taxBasisOf(variant, base, annualTaxes = variant.annualTaxes) {
  const t = base.taxIncentive;
  if (t) return t.eligible ? `485-x Option ${t.option}: ${t.restrictedCount} restricted units at ${t.amiPct}% AMI; year-one taxes ${usd(t.year1Taxes)} against full taxes of ${usd(t.fullAnnualTaxes)}, and the exemption's present value of ${usd(t.exemptionPresentValue)} is in the value.` : `485-x does not apply (${t.reason}); full taxes of ${usd(t.fullAnnualTaxes)}.`;
  if (annualTaxes !== undefined) return `Real estate taxes stated for this variant: ${usd(annualTaxes)} a year on the completed building, no exemption.`;
  if (base.inputs.realEstateTaxes) return `Shared real estate taxes of ${usd(base.inputs.realEstateTaxes.annualTaxes)} a year, no exemption.`;
  return variant.productType !== 'condo' ? 'Real estate taxes are inside the shared operating expenses, with no exemption.' : 'Condo sellout: no stabilized operating taxes.';
}

function scaleMarket(market, rentScale = 1, priceScale = 1, commercialScale = 1) {
  if (rentScale === 1 && priceScale === 1 && commercialScale === 1) return market;
  return {
    ...market,
    ...(market.rents ? {rents: market.rents.map(r => ({...r, rentPerSqftPerMonth: r.rentPerSqftPerMonth * rentScale}))} : {}),
    ...(market.salePrices ? {salePrices: market.salePrices.map(r => ({...r, pricePerSqft: r.pricePerSqft * priceScale}))} : {}),
    ...(market.commercialRents ? {commercialRents: market.commercialRents.map(r => ({...r, rentPerSqftPerYear: r.rentPerSqftPerYear * commercialScale}))} : {}),
  };
}

// The highest land price that still earns the target return on cost after incremental approval
// carry, and the uniform rent and price change the stated land price needs to earn it. Both rerun
// the model: surplus is affine in land price, and monotone in revenue, so two runs and a bisection
// solve them.
function acquisitionFigures(inputs, carryRate, target) {
  const surplus = (landPrice, revenueScale = 1) => {
    const run = rerun(inputs, {landPrice, revenueScale});
    const carry = landPrice * carryRate;
    return run.returns.profit - carry - target * (run.development.totalDevelopmentCost + carry);
  };
  const probe = inputs.landPrice || 1_000_000, atZero = surplus(0);
  const maxLandPrice = round(-atZero / ((surplus(probe) - atZero) / probe));
  let low = 0, high = 5, requiredRevenueChange = null;
  if (surplus(inputs.landPrice, high) >= 0) {
    for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (surplus(inputs.landPrice, mid) >= 0) high = mid; else low = mid; }
    requiredRevenueChange = round(high - 1, 4);
  }
  return {maxLandPrice, landHeadroom: maxLandPrice - round(inputs.landPrice), requiredRevenueChange};
}

function acquisitionDecision(variant, target) {
  const at = target === 0 ? 'break-even' : `a ${pct(target)} return on cost`;
  const needs = variant.requiredRevenueChange === null ? 'more than a sixfold rise in rents and prices' : `rents and prices ${signedPct(variant.requiredRevenueChange)}`;
  const call = variant.maxLandPrice >= variant.landPrice ? 'supports_price' : variant.maxLandPrice > 0 ? 'below_price' : 'no_land_value';
  const verdict = call === 'supports_price'
    ? `${variant.label} supports the ${usd(variant.landPrice)} land price at ${at}; it justifies up to ${usd(variant.maxLandPrice)}, and rents and prices could fall ${pct(-variant.requiredRevenueChange)} before it misses.`
    : call === 'below_price'
      ? `${variant.label} does not support ${usd(variant.landPrice)} at ${at}: it justifies at most ${usd(variant.maxLandPrice)}, or needs ${needs} at the stated price.`
      : `${variant.label} leaves no land value at ${at} (residual ${usd(variant.maxLandPrice)}); at ${usd(variant.landPrice)} it needs ${needs}.`;
  return {call, label: variant.label, targetReturnOnCost: target, landPrice: variant.landPrice, maxLandPrice: variant.maxLandPrice, landHeadroom: variant.landHeadroom, requiredRevenueChange: variant.requiredRevenueChange, verdict};
}

// Rank cash economics after incremental land carry. Ordinal entitlement scores remain separate
// risk information, never a probability multiplier on dollars. Timing already included in the
// financing term is subtracted explicitly; omitted timing is disclosed as unpriced.
export function comparePrograms({shared, variants} = {}, recordedMarket = null, facts = {}) {
  if (!shared || typeof shared !== 'object' || !shared.program) throw new Error('compare needs shared pro forma inputs with a program.');
  validateVariants(variants, shared.program, shared);
  // Without a stated hurdle the decision is solved at break-even, and says so.
  const target = shared.targetReturnOnCost == null ? 0 : num(shared.targetReturnOnCost, 'shared.targetReturnOnCost', 0, 1);
  const market = shared.market ? normalizeMarketInputs(shared.market) : recordedMarket;
  if (!market) throw new Error('Record market inputs with acres_market_inputs first, or pass market in shared.');
  const {market: _market, name: _name, targetReturnOnCost: _target, ...sharedArgs} = shared;

  const results = variants.map((variant, index) => {
    const label = typeof variant.label === 'string' && variant.label.trim() ? variant.label.trim() : `${variant.productType} ${index + 1}`;
    const effectiveRentScale = rentScaleOf(variant);
    const scaled = scaleMarket(market, effectiveRentScale, variant.priceScale ?? 1, variant.productType === 'commercial' ? effectiveRentScale : 1);
    const program = variantProgram(variant, shared.program);
    // Derive ordinary rentals' completed-building taxes from their own pre-tax NOI.  The ledger fact
    // remains available for the 485-x base tax but is never used as this building's full tax line.
    const estimatedTaxes = variant.completedTaxDofCapRate === undefined ? null : dofFullTaxes(
      sensitivity({...sharedArgs, name: label, productType: variant.productType, program}, scaled, {}, {land: facts.land}).base.operations.noi,
      variant.completedTaxDofCapRate,
    );
    const annualTaxes = variant.annualTaxes ?? estimatedTaxes?.annualTaxes;
    const statedTaxes = annualTaxes === undefined ? {} : {taxes: {annualTaxes, basis: estimatedTaxes?.basis ?? `Real estate taxes stated for ${label}: ${usd(annualTaxes)} a year on the completed building`, source: estimatedTaxes ? 'Completed-building DOF income method' : 'Stated for this variant', retrievedAt: new Date().toISOString().slice(0, 10)}};
    const variantFacts = variant.productType !== 'condo' ? {...facts, ...statedTaxes} : {land: facts.land};
    const {base, table, inputs} = sensitivity({...sharedArgs, name: label, productType: variant.productType, program, ...(variant.taxIncentive !== undefined ? {taxIncentive: variant.taxIncentive} : {})}, scaled, {}, variantFacts);
    const score = variant.entitlementScore ?? null;
    const profit = base.returns.profit;
    const approvalTimelineMonths = variant.timelineMonths ?? null;
    const approvalMonthsIncludedInFinancing = variant.approvalMonthsIncludedInFinancing ?? 0;
    if (approvalMonthsIncludedInFinancing > base.inputs.financing.termMonths) throw new Error('Approval months included in financing cannot exceed financing.termMonths.');
    const incrementalApprovalMonths = (approvalTimelineMonths ?? 0) - approvalMonthsIncludedInFinancing;
    const {loanToCost, interestRate} = base.inputs.financing;
    const entitlementCarryCost = round(base.inputs.landPrice * loanToCost * interestRate * incrementalApprovalMonths / 12);
    const profitAfterCarry = round(profit - entitlementCarryCost);
    const totalDevelopmentCostAfterCarry = base.development.totalDevelopmentCost + entitlementCarryCost;
    const entitlementRiskTier = score === null ? 'unassessed' : score >= 75 ? 'ministerial/certification' : score >= 55 ? 'discretionary-moderate' : 'discretionary-high';
    // The revenue downside on the axis this product reads: rents for income exits, sale prices for a condo.
    const downside = table.rent?.find(r => r.scenario === 'rent -10%') ?? table.price?.find(r => r.scenario === 'sale price -10%') ?? null;
    const jointDownsideProfit = rerun(inputs, JOINT_DOWNSIDE).returns.profit;
    return {
      label, productType: variant.productType,
      ...(variant.storeOption ? {storeOption: variant.storeOption} : {}),
      ...(variant.unpriced?.length ? {unpricedStoreTerms: variant.unpriced} : {}),
      ...(variant.entitlementLabel ? {entitlement: variant.entitlementLabel} : {}),
      entitlementScore: variant.entitlementScore ?? null,
      entitlementRiskTier,
      approvalTimelineMonths,
      approvalMonthsIncludedInFinancing,
      incrementalApprovalMonths,
      approvalTimingPriced: approvalTimelineMonths !== null,
      entitlementCarryCost,
      profitAfterCarry,
      rankingProfit: profitAfterCarry,
      totalDevelopmentCostAfterCarry,
      ...(base.operations ? {yieldOnCostAfterCarry: round(base.operations.noi / totalDevelopmentCostAfterCarry, 4)} : {}),
      effectiveRentScale: round(effectiveRentScale, 3),
      totalDevelopmentCost: base.development.totalDevelopmentCost,
      landPrice: base.inputs.landPrice,
      ...acquisitionFigures(inputs, loanToCost * interestRate * incrementalApprovalMonths / 12, target),
      ...(base.inputs.landPriceBasis ? {landPriceBasis: base.inputs.landPriceBasis} : {}),
      ...(base.inputs.realEstateTaxes ? {realEstateTaxes: base.inputs.realEstateTaxes} : {}),
      ...(base.taxIncentive ? {taxIncentive: {program: base.taxIncentive.program, option: base.taxIncentive.option, eligible: base.taxIncentive.eligible, year1Taxes: base.taxIncentive.year1Taxes, fullAnnualTaxes: base.taxIncentive.fullAnnualTaxes, exemptionPresentValue: base.taxIncentive.exemptionPresentValue, profitWithout485x: base.taxIncentive.without485x.profit}} : {}),
      taxBasis: taxBasisOf(variant, base, annualTaxes),
      value: base.returns.value, profit,
      unleveredReturnOnCost: base.returns.unleveredReturnOnCost,
      leveredReturnOnEquity: base.returns.leveredReturnOnEquity,
      equityMultiple: base.returns.equityMultiple,
      ...(base.operations ? {noi: base.operations.noi, yieldOnCost: base.operations.yieldOnCost, developmentSpreadBps: base.operations.developmentSpreadBps, debtServiceCoverage: base.returns.debtServiceCoverage ?? null, cashOnCash: base.returns.cashOnCash ?? null} : {}),
      ...(base.sales ? {netSellout: base.sales.netSellout, marginOnRevenue: base.returns.marginOnRevenue ?? null} : {}),
      downsideRentMinus10Profit: downside ? downside.profit : null,
      downsideScenario: downside ? downside.scenario : null,
      downsideProfitAfterCarry: downside ? round(downside.profit - entitlementCarryCost) : null,
      jointDownsideProfit: round(jointDownsideProfit),
      jointDownsideProfitAfterCarry: round(jointDownsideProfit - entitlementCarryCost),
      // The pro forma's own flags, such as no core deducted at net equal to gross, stay with the program.
      ...(base.assumptions ? {assumptions: base.assumptions} : {}),
      _sources: base.sources ?? [],
    };
  });
  const sources = [...new Map(results.flatMap(r => r._sources).map(s => [s.sourceId != null ? `id:${s.sourceId}` : `${s.source}|${s.retrievedAt}`, s])).values()];
  for (const result of results) delete result._sources;

  const ranked = [...results].sort((a, b) => b.rankingProfit - a.rankingProfit || a.label.localeCompare(b.label));
  const [winner, runnerUp] = ranked;
  const flip = [];
  if (runnerUp) {
    flip.push(`${winner.label} leads ${runnerUp.label} by $${(winner.rankingProfit - runnerUp.rankingProfit).toLocaleString('en-US')} of profit after incremental approval carry.`);
    if (winner.downsideProfitAfterCarry !== null && winner.downsideProfitAfterCarry < runnerUp.rankingProfit) flip.push(`A 10% rent/price miss for ${winner.label} alone reduces its profit after incremental approval carry to ${usd(winner.downsideProfitAfterCarry)}, below ${runnerUp.label}'s base profit after incremental approval carry of ${usd(runnerUp.rankingProfit)}; ${runnerUp.label} then leads.`);
    const jointLeader = [...results].sort((a, b) => b.jointDownsideProfitAfterCarry - a.jointDownsideProfitAfterCarry || a.label.localeCompare(b.label))[0];
    if (jointLeader !== winner && jointLeader.jointDownsideProfitAfterCarry > winner.jointDownsideProfitAfterCarry) flip.push(`In the joint downside applied to every program (rents and prices 10% lower, hard and soft cost 10% higher, cap rate 50 bps higher), ${jointLeader.label} would lead at ${usd(jointLeader.jointDownsideProfitAfterCarry)} of profit after incremental approval carry against ${winner.label}'s ${usd(winner.jointDownsideProfitAfterCarry)}.`);
    if (winner.entitlementScore !== null && winner.entitlementScore < 70) flip.push(`${winner.label} depends on a discretionary entitlement (score ${winner.entitlementScore}, ${winner.approvalTimelineMonths ?? 'unpriced'}mo approval carry $${winner.entitlementCarryCost.toLocaleString('en-US')}); if that path stalls, ${runnerUp.label} is the fallback.`);
  }
  return {
    variants: ranked,
    rankingBasis: 'profit_after_incremental_approval_carry',
    unpricedApprovalTiming: ranked.filter(v => !v.approvalTimingPriced).map(v => v.label),
    recommendation: {label: winner.label, rankingProfit: winner.rankingProfit, profitAfterCarry: winner.profitAfterCarry, whatWouldChangeIt: flip},
    decision: acquisitionDecision(winner, target),
    rubric: 'Rank by profit after incremental approval land carry. Approval months explicitly included in financing.termMonths are not charged again. Missing approval timelines leave that carry unpriced; the ranking is provisional. Entitlement score is an ordinal index rather than an actuarial probability and never multiplies dollars. Downside applies the same 10% rent/price shock to the leading program alone, keeping alternatives at base and deducting the same incremental carry; the joint downside shocks every program at once (rents and prices 10% lower, hard and soft cost 10% higher, cap rate 50 bps higher where there is income) and reports when that changes the leader. The decision is made on the recommended program: the highest land price that earns the target return on cost after carry, and the uniform rent and price change the stated land price needs.',
    note: 'Every figure is the pro forma model’s arithmetic on the shared inputs and each variant’s scaling; rents and prices carry their recorded sources. Affordable variants blend restricted and market rents across the same unit mix, a first-pass approximation, not an HPD term sheet. Each variant\'s taxBasis states the taxes it carries: a 485-x exemption, taxes stated for that variant, or the shared taxes.',
    sources,
  };
}

const variantRow = {
  type: 'object', additionalProperties: false,
  properties: {
    label: {type: 'string', description: 'Variant label, e.g. "Market rental", "Condo", "UAP affordable (20% at 40% rents)".'},
    productType: {type: 'string', enum: ['rental', 'condo', 'commercial'], description: 'commercial is a wholly non-residential building (retail, office or community facility) held for its commercial income; its program has no units and carries commercial area. Mixed-use is rental or condo with commercial rows.'},
    rentScale: {type: 'number', exclusiveMinimum: 0, maximum: 2, description: 'Multiplier on rents (1 = market), greater than 0 and at most 2: residential rents on rental variants, commercial rents on commercial variants. On a condo variant use priceScale.'},
    priceScale: {type: 'number', exclusiveMinimum: 0, description: 'Positive multiplier on condo sale prices.'},
    affordableShare: {type: 'number', minimum: 0, maximum: 1, description: 'Share of units income-restricted, from 0 to 1; blended with affordableRentScale when rentScale is omitted. Rental variants only: a condo variant with an affordable share is rejected, since affordable floor area earns restricted rents.'},
    affordableRentScale: {type: 'number', minimum: 0, description: 'Nonnegative restricted/contract rent ratio to market for the affordable share; the blended rent multiplier must remain greater than 0 and at most 2.'},
    grossBuildingSqft: {type: 'number', minimum: 500, maximum: 20_000_000, description: 'Override the building size for this variant (e.g. the larger UAP envelope); unit counts stay as programmed unless program is replaced. The override must accommodate their combined residential and commercial net area.'},
    program: {type: 'object', description: 'Full program override in the acres_pro_forma shape.'},
    entitlementScore: {type: 'number', minimum: 0, maximum: 100, description: 'Feasibility score of the entitlement path this variant needs, from acres_entitlement_scenarios. Omit for as-of-right.'},
    entitlementLabel: {type: 'string', description: 'Name of that entitlement path, for the report.'},
    timelineMonths: {type: 'number', minimum: 0, maximum: 60, description: 'Approval duration in months. Missing timing is unpriced; use 0 for no approval delay.'},
    approvalMonthsIncludedInFinancing: {type: 'number', minimum: 0, maximum: 60, description: 'Approval months already included in financing.termMonths; deducted from timelineMonths for incremental land carry.'},
    taxIncentive: {...proFormaDefinition.inputSchema.properties.taxIncentive, description: 'Rental only: model this variant under the 485-x exemption (restricted units at HPD AMI rents, base taxes payable, the exemption\'s present value in the value), in the acres_pro_forma taxIncentive shape. Operating expenses then exclude taxes, so every other rental variant needs annualTaxes for its completed building. Not combined with affordableShare.'},
    annualTaxes: {type: 'number', minimum: 0, description: 'Rental and commercial only: full annual real estate taxes on the completed building for this variant, USD, as a separate tax line with no exemption (operating expenses then exclude taxes). Use it for the market-rate comparison to a 485-x variant.'},
  },
  required: ['label', 'productType'],
};

export const feasibilityDefinition = {
  name: 'acres_compare_programs',
  description: 'Compare business plans for the same site and building: market rental, condo, commercial (a wholly non-residential building held for its retail, office or community-facility income), mixed-use (rental or condo with commercial rows in the program), and affordable/subsidized mixes on one set of land, cost and financing inputs. Each variant runs the full pro forma and is ranked by profit after incremental approval carry, with the ordinal entitlement score shown separately and raw and after-carry rent/price downside alongside. Market reversal conditions test the leading program alone against unchanged alternatives using the same after-carry ranking rule. Returns the ranked variants, the recommended plan, the conditions that would flip the ranking (market miss, entitlement stall, profit gap), and the acquisition decision on the recommended plan: the highest land price that earns targetReturnOnCost, the uniform rent and price change the stated land price needs, and whether the stated price is supported. One variant is enough when only one program is viable. Affordable variants blend restricted rents across the unit mix via affordableShare and affordableRentScale, or carry the 485-x exemption via taxIncentive; annualTaxes states a variant\'s full taxes, and each variant reports the taxes it carries (taxBasis). Every variant also reports a joint downside (rents and prices 10% lower, costs 10% higher, cap rate 50 bps higher). The result is the site\'s saved acquisition decision.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      shared: {
        type: 'object', additionalProperties: false,
        description: 'Pro forma inputs shared by every variant, in the acres_pro_forma shape minus productType. Give exactly one of landPrice or landPriceSource. Ledger taxes apply to rental and commercial variants only and require at least one of them.',
        properties: {
          program: {type: 'object', description: 'Program in the acres_pro_forma shape (grossBuildingSqft, units by bedrooms, optional commercial).'},
          market: {type: 'object', description: 'Market inputs in the acres_market_inputs shape, when not recorded this answer.'},
          landPrice: proFormaDefinition.inputSchema.properties.landPrice,
          landPriceSource: proFormaDefinition.inputSchema.properties.landPriceSource,
          taxSource: proFormaDefinition.inputSchema.properties.taxSource,
          hardCostPerSqft: {type: 'number'}, softCostPerSqft: {type: 'number'},
          financing: {type: 'object'}, operating: proFormaDefinition.inputSchema.properties.operating,
          capRate: {type: 'number', description: 'Required when any variant produces income.'},
          sellingCostRate: {type: 'number', description: 'Required when any variant is a condo.'},
          targetReturnOnCost: {type: 'number', minimum: 0, maximum: 1, description: 'Unlevered profit over total development cost (after approval carry) the buyer requires, e.g. 0.15. The acquisition decision solves the land price and revenue that earn it; omitted, it is solved at break-even.'},
        },
        required: ['hardCostPerSqft', 'softCostPerSqft', 'financing'],
      },
      variants: {type: 'array', minItems: 1, maxItems: 4, items: variantRow, description: 'Omit to compare the site page options for this subject. Options that the supplied inputs cannot price are returned in skippedStoreOptions, never ranked.'},
      taxIncentive: {type: 'object', description: 'Only when variants are omitted: 485-x terms for site-page options. If a 485-x option is compared to another rental, give dofCapRate so the other rental receives its own completed-building tax estimate.'},
    },
    required: ['shared'],
  },
};

export function createFeasibilityTools({emit = () => {}, getMarket = () => null, ledger = null, record = () => null, getStoreOptions = () => null} = {}) {
  const comparisons = [];
  function storeComparison(args) {
    const market = args.shared.market ? normalizeMarketInputs(args.shared.market) : getMarket();
    if (!market) throw new Error('Record market inputs with acres_market_inputs first, or pass market in shared.');
    const facts = ledgerFacts(args.shared, ledger, record);
    const schemes = getStoreOptions() ?? [];
    if (!schemes.some(s => s.program)) throw new Error('Give one to four program variants: the site page has no options for this subject to compare.');
    const has485x = schemes.some(s => s.program?.exit === 'rental' && s.program.taxProgram?.kind === '485-x');
    const hasOtherRental = schemes.some(s => s.program?.exit === 'rental' && s.program.taxProgram?.kind !== '485-x');
    if (args.taxIncentive && has485x && hasOtherRental && args.taxIncentive.dofCapRate === undefined) throw new Error('Comparing a 485-x option with another rental requires taxIncentive.dofCapRate to estimate each ordinary rental\'s completed-building taxes; fullAnnualTaxes applies only to the 485-x building.');
    const {variants, skipped} = storeVariants(schemes, {market, shared: args.shared, taxIncentive: args.taxIncentive ?? null, facts});
    if (!variants.length) throw new Error(`None of the site page's options can be priced on these inputs. ${skipped.map(s => `${s.label}: ${s.reason}`).join(' ')}`);
    const {taxIncentive: _incentive, ...rest} = args;
    return {args: {...rest, variants, shared: {program: variants[0].program, ...args.shared}}, skipped, facts};
  }
  async function compare(args = {}) {
    if (comparisons.length >= 3) throw new Error('At most three program comparisons per answer.');
    if (!args.shared || typeof args.shared !== 'object') throw new Error('compare needs shared pro forma inputs.');
    let skipped = [], facts = null;
    if (args.variants === undefined) ({args, skipped, facts} = storeComparison(args));
    else if (args.taxIncentive !== undefined) throw new Error('taxIncentive applies to site page options when variants are omitted; give each variant its own taxIncentive.');
    if (!args.shared.program) throw new Error('compare needs shared pro forma inputs with a program.');
    validateVariants(args.variants, args.shared.program, args.shared);
    if (args.shared.taxSource && Array.isArray(args.variants) && !args.variants.some(variant => variant.productType !== 'condo')) throw new Error('taxSource requires at least one rental or commercial variant.');
    facts ??= ledgerFacts(args.shared, ledger, record);
    const result = {...comparePrograms(args, getMarket(), facts), ...(skipped.length ? {skippedStoreOptions: skipped} : {}), createdAt: new Date().toISOString()};
    comparisons.push(result);
    emit('feasibility.compared', result);
    return result;
  }
  return {definitions: [feasibilityDefinition], comparisons, handlers: {acres_compare_programs: compare}};
}
