import {rules, describeDistrict, recordedBuildingArea} from './zoning.mjs';
import {dwellingUnits} from './envelope.mjs';
import {unitThreshold485x} from './tax-485x.mjs';

const round = (n, d = 0) => Number(n.toFixed(d));

// Deterministic feasibility rubric: an approval-certainty base by permission type, less a time
// penalty from the typical entitlement timeline midpoint. It ranks paths against each other; it
// is not a probability and it does not see site-specific politics or precedent, which the
// research in the same answer should weigh.
const APPROVAL_BASE = {'as-of-right': 85, certification: 70, authorization: 60, elurp: 45, 'special-permit': 40, variance: 25, ulurp: 15};
const APPROVAL_RISK = {'as-of-right': 'low', certification: 'low', authorization: 'medium', elurp: 'medium', 'special-permit': 'medium', variance: 'high', ulurp: 'high'};
function score(approval, timeMonths) {
  const mid = (timeMonths[0] + timeMonths[1]) / 2;
  return Math.max(0, Math.min(100, Math.round(APPROVAL_BASE[approval] - Math.min(25, mid * 0.6))));
}
function scenario(base) {
  return {...base, risk: APPROVAL_RISK[base.approval], feasibilityScore: score(base.approval, base.timeMonths)};
}

function residentialFars(district) {
  const own = {standard: district.farResidential ?? null, affordable: district.farResidentialAffordable ?? null};
  if (own.standard !== null) return own;
  const equivalent = district.residentialEquivalent ? rules.districts[district.residentialEquivalent] : null;
  return {standard: equivalent?.farResidential ?? null, affordable: equivalent?.farResidentialAffordable ?? null};
}

// Charter §197-e(b)(2) and 62 RCNY §14-02.1(a): a zoning map change from a district allowing
// residence equivalent to R6 or above must use ELURP when each new district adds no more than
// 30% maximum residential floor area, keeps a horizontal height plane unless the current district
// has none, and holds newly permitted commercial or manufacturing floor area to 2 FAR.
// Maximum residential floor area here is the district's highest residential FAR, qualifying
// affordable included where mapped.
const ELURP_MAX_INCREASE = 0.30;
const maxResidentialFar = district => {
  const far = residentialFars(district);
  return Math.max(far.standard ?? 0, far.affordable ?? 0) || null;
};
const nonHorizontalPlane = district => Boolean(district.bulk?.skyExposurePlane || district.bulk?.towers);
const allowsMediumHighResidence = district => Number(/^R(\d+)/.exec(district.residentialEquivalent || '')?.[1]) >= 6 && maxResidentialFar(district) !== null;

function elurpReview(current, target) {
  const currentMax = maxResidentialFar(current);
  const targetMax = maxResidentialFar(target);
  const increasePercent = currentMax && targetMax ? round(((targetMax - currentMax) / currentMax) * 100, 1) : null;
  const reasons = [];
  if (!allowsMediumHighResidence(current)) reasons.push('the current district does not allow residence equivalent to R6 or above');
  else if (increasePercent === null || increasePercent <= 0) reasons.push('the change does not increase maximum residential floor area');
  else if (increasePercent > ELURP_MAX_INCREASE * 100) reasons.push(`maximum residential floor area rises ${increasePercent}%, above the 30% limit`);
  if (nonHorizontalPlane(target) && !nonHorizontalPlane(current)) reasons.push('the new district regulates height by something other than a horizontal plane');
  if (!current.farCommercial && (target.farCommercial ?? 0) > 2) reasons.push(`it newly permits ${target.farCommercial} FAR of commercial floor area, above 2 FAR`);
  return {reviewPath: reasons.length ? 'ULURP' : 'ELURP', maxResidentialFloorAreaIncreasePercent: increasePercent, ...(reasons.length ? {ulurpBecause: reasons} : {})};
}

const FAST_TRACK_CONDITION = 'Affordable Housing Fast Track (Charter §197-f) can move publicly funded affordable projects citywide, and affordable housing in the 12 community districts that have permitted the least affordable housing, into expedited review ending at the City Planning Commission, even when an EIS is required (the Commission then has 45 days). Eligibility follows the Commission’s Fast Track methodology; confirm the current district list and criteria before relying on it.';

function buildContextualRezoningBenchmarks(district, lotAreaSqft, governingFar) {
  const candidates = district.kind === 'manufacturing'
    ? ['R7A', 'R7X', 'R8A', 'C6-2A', 'C6-4']
    : ['R6A', 'R7A', 'R7D', 'R7X', 'R8A', 'R9A', 'R10A', 'R11A', 'R12', 'C6-2A', 'C6-3A', 'C6-4'];
  const benchmarks = [];
  for (const code of candidates) {
    if (code === district.code) continue;
    const target = rules.districts[code];
    if (!target) continue;
    const stdFar = target.farResidential ?? target.farCommercial ?? null;
    const affFar = target.farResidentialAffordable ?? null;
    const topFar = Math.max(stdFar ?? 0, affFar ?? 0);
    if (district.kind !== 'manufacturing' && topFar <= governingFar) continue;
    const maxTotalSqft = round((affFar ?? stdFar) * lotAreaSqft);
    const review = elurpReview(district, target);
    benchmarks.push({
      illustrativeDistrict: code,
      kind: target.kind,
      ...review,
      standardFar: stdFar,
      affordableOrMihFar: affFar,
      standardMaxFloorAreaSqft: stdFar ? round(stdFar * lotAreaSqft) : null,
      affordableOrMihMaxFloorAreaSqft: affFar ? round(affFar * lotAreaSqft) : null,
      addedOverCurrentBaselineSqft: round(maxTotalSqft - governingFar * lotAreaSqft),
      mihOption1Affordable25PercentSqft: affFar ? round(maxTotalSqft * 0.25) : null,
      mihOption2Affordable30PercentSqft: affFar ? round(maxTotalSqft * 0.30) : null,
      heightSummary: target.height,
      citations: [review.reviewPath === 'ELURP' ? 'NYC Charter §197-e (ELURP)' : 'NYC Charter §197-c (ULURP)', 'ZR 23-22', 'ZR 27-131 (MIH)', ...(target.citations || [])],
    });
    if (benchmarks.length >= 3) break;
  }
  return {
    label: 'Illustrative Hypothetical Contextual Rezoning Benchmarks via ELURP or ULURP (Requires Discretionary Approval, Not As-of-Right)',
    benchmarks,
    mihRequirements: 'Rezonings that increase residential capacity are generally paired with mapping a Mandatory Inclusionary Housing area (MIH, ZR 27-131), whose requirements are shares of residential floor area: Option 1 requires 25% permanently affordable at an average of 60% AMI (with 10% at 40% AMI); Option 2 requires 30% at an average of 80% AMI.',
    elurpSteps: [
      '1. Pre-Application & Environmental Review (same pre-certification and certification standards as ULURP; actions needing an EIS are excluded unless they qualify for Affordable Housing Fast Track)',
      '2. DCP Certification of Complete Application (starts the 90-day ELURP clock under NYC Charter §197-e)',
      '3. Community Board and Borough President Review (concurrent, 60 days, advisory; longer for June and early-July certifications)',
      '4. City Planning Commission Hearing & Vote (30 days, 45 for Fast Track applications with an EIS; the Commission’s decision is final, with no City Council review)',
    ],
    ulurpSteps: [
      '1. Pre-Application & CEQR Environmental Review (EAS/EIS scoping, typically 9–18+ months before certification)',
      '2. DCP Certification of Complete Application (starts the ~7-month statutory ULURP clock under NYC Charter §197-c)',
      '3. Community Board Review (60 days, advisory recommendation)',
      '4. Borough President & Borough Board Review (30 days, advisory recommendation)',
      '5. City Planning Commission (CPC) Hearing & Vote (60 days, binding approval/modification)',
      '6. City Council Review & Vote (50 days, binding vote and local Council Member deference; the Affordable Housing Appeals Board can reverse a disapproval or modification of a single-borough affordable housing application)',
      '7. Mayoral Review (5 days)',
    ],
  };
}

// mihArea is mihAreaForPoint() from nyc-zoning-lookups.mjs: inside a mapped area MIH replaces the UAP.
export function entitlementScenarios({district: districtArg, lotAreaSqft, existingFloorAreaSqft = 0, affordableFloorAreaSqft, landmark, mergerLots, conversion, requestedFloorAreaSqft, mihArea} = {}) {
  const district = typeof districtArg === 'string' ? describeDistrict(districtArg) : districtArg;
  if (!district) throw new Error('Entitlement scenarios need a curated district; pass district or select a property first.');
  if (!(Number.isFinite(lotAreaSqft) && lotAreaSqft > 0)) throw new Error('Entitlement scenarios need the lot area in square feet.');
  const res = residentialFars(district);
  const commercialFar = district.farCommercial ?? null;
  const governingFar = res.standard ?? commercialFar;
  if (!governingFar) throw new Error(`No curated floor area ratio for ${district.code}, so entitlement scenarios cannot be quantified.`);
  const greatestFar = Math.max(res.standard ?? 0, commercialFar ?? 0, district.farCommunityFacility ?? 0);
  const baselineMax = governingFar * lotAreaSqft;
  const scenarios = [];

  scenarios.push(scenario({
    id: 'as-of-right', name: 'As-of-right development', approval: 'as-of-right',
    addedFloorAreaSqft: 0, totalFloorAreaSqft: round(baselineMax), resultingFar: governingFar,
    timeMonths: [0, 3],
    conditions: ['Complies with district bulk, height, yard and parking rules as modeled in the zoning envelope.', ...(mihArea?.inMihArea ? [`Inside the ${mihArea.name} Mandatory Inclusionary Housing area, residential projects above ${mihArea.smallProjectExemption.maxUnits} units or ${mihArea.smallProjectExemption.maxResidentialSqft.toLocaleString('en-US')} sq ft must meet a mapped MIH option even at the standard FAR (ZR 27-131).`] : [])],
    citations: ['ZR Article II/III bulk (district table)'],
  }));

  if (res.standard !== null && district.farCommunityFacility && district.farCommunityFacility > governingFar) {
    const totalFloorAreaSqft = round(district.farCommunityFacility * lotAreaSqft);
    scenarios.push(scenario({
      id: 'mixed-residential-community-facility', name: 'Hypothetical mixed residential and community facility building', approval: 'as-of-right',
      addedFloorAreaSqft: round(totalFloorAreaSqft - baselineMax), totalFloorAreaSqft, resultingFar: district.farCommunityFacility,
      residentialFloorAreaSqft: round(baselineMax), communityFacilityFloorAreaSqft: round(totalFloorAreaSqft - baselineMax),
      timeMonths: [3, 9],
      conditions: [
        `Illustrative mixed program only: residential floor area is held to the ${governingFar} FAR residential maximum (${round(baselineMax)} sq ft), with up to ${round(totalFloorAreaSqft - baselineMax)} sq ft of qualifying community facility floor area to the ${district.farCommunityFacility} FAR ceiling.`,
        'The community facility use, its bulk, and all applicable use-group and building-code conditions must be verified. This does not replace the residential headline or establish that a particular program qualifies.',
      ],
      citations: ['ZR 24-11', ...(district.citations || [])],
    }));
  }

  if (mihArea?.inMihArea && res.standard !== null && res.affordable !== null && res.affordable > res.standard) {
    // Inside a mapped MIH area the qualifying FAR is reached by meeting a mapped option, whose set-aside
    // is a share of all residential floor area; the UAP is unavailable (ZR 27-111).
    const totalFloorAreaSqft = round(res.affordable * lotAreaSqft);
    const options = mihArea.availableOptions.map(o => ({key: o.key, label: o.label, affordableSharePercent: Math.round(o.affordableShare * 100), amiPct: o.amiPct, affordableRequiredSqft: round(totalFloorAreaSqft * o.affordableShare)}));
    const least = [...options].sort((a, b) => a.affordableRequiredSqft - b.affordableRequiredSqft)[0];
    scenarios.push(scenario({
      id: 'mandatory-inclusionary-housing', name: `Mandatory Inclusionary Housing (${mihArea.name})`, approval: 'as-of-right',
      addedFloorAreaSqft: round((res.affordable - res.standard) * lotAreaSqft), totalFloorAreaSqft, resultingFar: res.affordable,
      affordableRequiredSqft: least.affordableRequiredSqft,
      affordableShareOfTotalPercent: least.affordableSharePercent,
      mihOptions: options,
      timeMonths: [3, 9],
      conditions: [
        `The lot is in the ${mihArea.name} MIH area (adopted ${mihArea.adopted}), so the Universal Affordability Preference is unavailable (ZR 27-111) and residential FAR rises from ${res.standard} to the qualifying ${res.affordable} FAR (${totalFloorAreaSqft} sq ft) under a mapped MIH option.`,
        `Each option sets aside a share of all residential floor area: ${options.map(o => `${o.label} ${o.affordableSharePercent}% at ${o.amiPct}% AMI average = ${o.affordableRequiredSqft} sq ft`).join('; ')}. affordableRequiredSqft shows the smallest set-aside (${least.label}); choose the option by its income targets and value.`,
        'Heights may also rise to the qualifying-affordable rows of ZR 23-432.',
      ],
      citations: ['ZR 23-22', 'ZR 27-131 (MIH options)', 'ZR 27-111', 'ZR Appendix F (MIH areas)'],
    }));
  } else if (res.standard !== null && res.affordable !== null && res.affordable > res.standard) {
    const deltaCap = (res.affordable - res.standard) * lotAreaSqft;
    const added = Number.isFinite(affordableFloorAreaSqft) ? Math.min(Math.max(0, affordableFloorAreaSqft), deltaCap) : deltaCap;
    const totalFloorAreaSqft = round(res.standard * lotAreaSqft + added);
    const affordableShareOfTotalPercent = totalFloorAreaSqft > 0 ? round((added / totalFloorAreaSqft) * 100, 1) : 0;
    scenarios.push(scenario({
      id: 'universal-affordability-preference', name: 'Universal Affordability Preference (qualifying affordable housing)', approval: 'as-of-right',
      addedFloorAreaSqft: round(added), totalFloorAreaSqft, resultingFar: round(res.standard + added / lotAreaSqft, 2),
      affordableRequiredSqft: round(added),
      affordableShareOfTotalPercent,
      timeMonths: [3, 9],
      conditions: [
        `Residential FAR may exceed the standard table (${res.standard} FAR = ${round(res.standard * lotAreaSqft)} sq ft) up to the qualifying-affordable FAR (${res.affordable} FAR = ${totalFloorAreaSqft} sq ft); the ${round(added)} sq ft bonus (${affordableShareOfTotalPercent}% of total residential ZFA) is matched 1:1 by permanently income-restricted floor area averaging <=60% AMI under an HPD regulatory agreement and permit notice (ZR 27-111, ZR 27-131).`,
        mihArea ? 'The lot is outside every mapped Mandatory Inclusionary Housing area, so the UAP applies.' : 'Applies outside Mandatory Inclusionary Housing areas; inside them MIH governs instead.',
        'Heights may also rise to the qualifying-affordable rows of ZR 23-432.',
      ],
      citations: ['ZR 23-22', 'ZR 27-111 (UAP development)', 'ZR 12-10 (qualifying affordable housing)'],
    }));
  }

  // R1 through R5 have no UAP; a qualifying residential site (ZR 12-10) reaches a higher FAR as of right.
  const qualifyingFar = district.farResidentialQualifyingSite ?? null;
  if (res.standard !== null && qualifyingFar !== null && qualifyingFar > res.standard) {
    scenarios.push(scenario({
      id: 'qualifying-residential-site', name: 'Qualifying residential site (City of Yes, R1 through R5)', approval: 'as-of-right',
      addedFloorAreaSqft: round((qualifyingFar - res.standard) * lotAreaSqft), totalFloorAreaSqft: round(qualifyingFar * lotAreaSqft), resultingFar: qualifyingFar,
      timeMonths: [0, 3],
      conditions: [
        `Residential FAR rises from ${res.standard} to ${qualifyingFar} (ZR 23-21) on a zoning lot that is a qualifying residential site under ZR 12-10: at least 5,000 sq ft in the Greater Transit Zone with frontage on a wide street or the short dimension of a block (not in R1 or R2); or a lot with community facility floor space existing on December 5, 2024; or qualifying senior housing in R3-2, R4, R5 or R5B.`,
        'Any residence type is permitted on a qualifying residential site (ZR 22-122), with the higher base and building heights of ZR 23-424.',
        'Where the permitted residential floor area exceeds 50,000 sq ft, the floor area above the qualifying FAR divided by 1.2 must be affordable at a weighted average of 80 percent of the income index under an HPD regulatory agreement or restrictive declaration (ZR 12-10).',
      ],
      citations: ['ZR 23-21', 'ZR 12-10 (qualifying residential site)', 'ZR 22-122', 'ZR 23-424'],
    }));
  }

  if (landmark) {
    const grantingMaxFar = landmark.maxFar ?? governingFar;
    const transferable = Math.max(0, grantingMaxFar * landmark.lotAreaSqft - (landmark.existingFloorAreaSqft ?? 0) - (landmark.previouslyTransferredSqft ?? 0));
    const highDistrict = (district.kind === 'commercial' || district.kind === 'manufacturing') && (commercialFar ?? 0) >= 15;
    const capPercent = highDistrict ? 30 : 20;
    // The cap is a share of the floor area allowable for the receiving development itself (the
    // governing FAR the transfer is added to), not of a higher community-facility FAR the
    // program cannot use; counting farCommunityFacility here overstated the cap.
    const receivingCap = (capPercent / 100) * baselineMax;
    const receivable = Math.min(transferable, receivingCap);
    scenarios.push(scenario({
      id: 'landmark-transfer', name: 'Landmark development-rights transfer (certification)', approval: 'certification',
      addedFloorAreaSqft: round(receivable), totalFloorAreaSqft: round(baselineMax + receivable), resultingFar: round(governingFar + receivable / lotAreaSqft, 2),
      transferableSqft: round(transferable), receivingCapSqft: round(receivingCap), receivingCapPercent: capPercent,
      timeMonths: [4, 10],
      conditions: [
        'Receiving lot must sit within the surrounding area of the landmark (ZR 75-421 definitions).',
        `Certification caps the increase at ${capPercent}% of the maximum floor area allowable on the receiving lot${highDistrict ? '; transfers above 30% need the ZR 74-79 special permit' : ''}.`,
        'Joint application with site plans and zoning calculations, a continuing-maintenance program with an LPC report, and a recorded transfer instrument plus notices of restrictions before a building permit; the granting lot is irrevocably reduced.',
        'Price is negotiated with the landmark owner; the tool quantifies area, not value.',
      ],
      citations: ['ZR 75-422', 'ZR 75-421', 'ZR 74-79'],
    }));
  }

  if (Array.isArray(mergerLots) && mergerLots.length) {
    let pooled = 0;
    const adjoiningLots = mergerLots.map(lot => {
      const unusedFloorAreaSqft = Math.max(0, (lot.maxFar ?? governingFar) * lot.lotAreaSqft - (lot.builtFloorAreaSqft ?? 0));
      pooled += unusedFloorAreaSqft;
      return {...(lot.bbl ? {bbl: String(lot.bbl)} : {}), ...(lot.address ? {address: lot.address} : {}), lotAreaSqft: lot.lotAreaSqft, builtFloorAreaSqft: lot.builtFloorAreaSqft ?? null, maxFar: lot.maxFar ?? governingFar, unusedFloorAreaSqft: round(unusedFloorAreaSqft)};
    });
    scenarios.push(scenario({
      id: 'zoning-lot-merger', name: 'Zoning lot merger (unused floor area pooling)', approval: 'as-of-right',
      addedFloorAreaSqft: round(pooled), totalFloorAreaSqft: round(baselineMax + pooled), resultingFar: round(governingFar + pooled / lotAreaSqft, 2),
      adjoiningLots,
      timeMonths: [2, 6],
      conditions: [
        'The lots must form one zoning lot under common ownership or party-in-interest control, documented by a recorded zoning lot development agreement and declaration of restrictions.',
        'Pooled floor area still has to fit the merged lot’s bulk envelope; re-run acres_zoning_envelope on the merged outline before relying on the number.',
        'Unused area is computed against built floor area; confirm no prior transfers, bonuses or non-complying floor area distort the inputs.',
      ],
      citations: ['ZR 12-10 (zoning lot, development rights)'],
    }));
  }

  if (conversion) {
    const cutoff = conversion.specialMixedUse ? 1997 : 1990;
    const eligible = Number.isFinite(conversion.yearBuilt) && conversion.yearBuilt <= cutoff;
    const convertible = eligible ? (conversion.nonResidentialSqft ?? 0) + (conversion.mechanicalSqft ?? 0) : 0;
    scenarios.push(scenario({
      id: 'residential-conversion', name: 'Residential conversion of the existing building', approval: 'as-of-right',
      addedFloorAreaSqft: round(convertible), totalFloorAreaSqft: null, resultingFar: null,
      unlocksExistingSqft: round(convertible), eligible, ...(conversion.source ? {areaSource: conversion.source} : {}),
      timeMonths: [6, 18],
      conditions: eligible ? [
        `Building existing on December 31, ${cutoff} qualifies in principle; conversions count non-residential floor area and mechanical space not counted as floor area.`,
        'Residential use must be allowed in the district (or under the chapter in manufacturing districts); light-and-air (ZR 15-112), recreation space (ZR 15-12) and unit-count (ZR 15-111) rules still shape the layout.',
        'This unlocks residential use inside existing floor area; it does not by itself add zoning floor area or enlarge the envelope.',
      ] : [
        `Building year ${conversion.yearBuilt ?? 'unknown'} is after the December 31, ${cutoff} eligibility date, so Article I Chapter 5 does not apply; conversion would need to fully comply as a residential development or seek discretionary relief.`,
      ],
      citations: ['ZR 15-01', 'ZR 15-111', 'ZR 15-112'],
    }));
  }

  if (Number.isFinite(existingFloorAreaSqft) && existingFloorAreaSqft > baselineMax) {
    const retainedExcessSqft = round(existingFloorAreaSqft - baselineMax);
    scenarios.push(scenario({
      id: 'retain-non-complying-building', name: 'Retain existing non-complying floor area', approval: 'as-of-right',
      addedFloorAreaSqft: 0, totalFloorAreaSqft: round(existingFloorAreaSqft), resultingFar: round(existingFloorAreaSqft / lotAreaSqft, 2), retainedExcessSqft,
      timeMonths: [0, 3],
      conditions: [`The existing building is ${retainedExcessSqft} sq ft above today's ${round(baselineMax)} sq ft maximum. Retention is not an enlargement right: ZR 54-31 bars increasing the degree of non-compliance, and ZR 54-41 requires compliant reconstruction if 75 percent or more is demolished or destroyed.`],
      citations: ['ZR 54-31', 'ZR 54-41'],
    }));
    scenarios.push(scenario({
      id: 'rebuild-to-current-maximum', name: 'Teardown and rebuild to current maximum', approval: 'as-of-right',
      addedFloorAreaSqft: 0, totalFloorAreaSqft: round(baselineMax), resultingFar: governingFar, replacedExistingFloorAreaSqft: round(existingFloorAreaSqft), reductionFromExistingSqft: retainedExcessSqft,
      timeMonths: [12, 30],
      conditions: [`A new compliant building is capped at ${round(baselineMax)} sq ft (${governingFar} FAR), ${retainedExcessSqft} sq ft below the existing building. Confirm demolition scope, zoning floor area, and any lawful non-complying status with an architect before choosing this path.`],
      citations: ['ZR 54-31', 'ZR 54-41'],
    }));
  }

  const discretionaryAdded = Number.isFinite(requestedFloorAreaSqft) ? Math.max(0, requestedFloorAreaSqft - baselineMax) : null;
  scenarios.push(scenario({
    id: 'bsa-variance', name: 'BSA variance', approval: 'variance',
    addedFloorAreaSqft: discretionaryAdded === null ? null : round(discretionaryAdded),
    totalFloorAreaSqft: Number.isFinite(requestedFloorAreaSqft) ? round(requestedFloorAreaSqft) : null,
    resultingFar: Number.isFinite(requestedFloorAreaSqft) ? round(requestedFloorAreaSqft / lotAreaSqft, 2) : null,
    timeMonths: [12, 30],
    conditions: [
      'All five ZR 72-21 findings are mandatory: (a) unique physical conditions inherent in the lot causing practical difficulties or unnecessary hardship; (b) no reasonable return from a conforming development (waived for non-profits); (c) no alteration of the neighborhood’s essential character or detriment to adjacent property/public welfare; (d) hardship not self-created; (e) the minimum variance necessary.',
      'Needs a feasibility study for finding (b) in most use/bulk cases and survives Article 78 challenge risk after approval.',
    ],
    citations: ['ZR 72-21', 'ZR 72-22'],
  }));
  const contextualRezoning = buildContextualRezoningBenchmarks(district, lotAreaSqft, governingFar);
  const elurpEligible = allowsMediumHighResidence(district);
  if (elurpEligible) {
    const currentMax = maxResidentialFar(district);
    const ceilingSqft = currentMax * (1 + ELURP_MAX_INCREASE) * lotAreaSqft;
    const coversRequestedProgram = Number.isFinite(requestedFloorAreaSqft) ? requestedFloorAreaSqft <= ceilingSqft : null;
    const total = coversRequestedProgram === null ? ceilingSqft : Math.min(requestedFloorAreaSqft, ceilingSqft);
    const qualifyingDistricts = Object.entries(rules.districts)
      .map(([code, target]) => ({code, target, review: elurpReview(district, target)}))
      .filter(c => c.review.reviewPath === 'ELURP')
      .sort((a, b) => maxResidentialFar(b.target) - maxResidentialFar(a.target))
      .slice(0, 3)
      .map(c => ({district: c.code, maxResidentialFar: maxResidentialFar(c.target), maxResidentialFloorAreaIncreasePercent: c.review.maxResidentialFloorAreaIncreasePercent}));
    scenarios.push(scenario({
      id: 'rezoning-elurp', name: 'Modest zoning map change through ELURP', approval: 'elurp',
      addedFloorAreaSqft: round(Math.max(0, total - baselineMax)), totalFloorAreaSqft: round(total), resultingFar: round(total / lotAreaSqft, 2),
      currentMaxResidentialFar: currentMax,
      elurpCeilingFar: round(currentMax * (1 + ELURP_MAX_INCREASE), 2),
      elurpCeilingFloorAreaSqft: round(ceilingSqft),
      coversRequestedProgram,
      illustrativeQualifyingDistricts: qualifyingDistricts,
      timeMonths: [9, 18],
      conditions: [
        `A zoning map change must use ELURP when each new district raises maximum residential floor area by no more than 30% (from ${currentMax} FAR to at most ${round(currentMax * (1 + ELURP_MAX_INCREASE), 2)} FAR here), keeps a horizontal height plane unless the current district has none, and holds newly permitted commercial or manufacturing floor area to 2 FAR; no part of the area may have been rezoned through ELURP in the prior 10 years.`,
        'The ceiling is measured on maximum residential floor area, qualifying affordable included, so reaching it usually means providing the affordable share; confirm the comparison basis with DCP at pre-application.',
        'Outside Fast Track, ELURP is limited to actions that need no environmental impact statement; a change that needs an EIS goes through ULURP.',
        'After the same pre-certification as ULURP, review takes 90 days: concurrent community board and borough president advisory review, then a final City Planning Commission decision with no City Council vote. Pre-certification and environmental assessment dominate the timeline.',
        FAST_TRACK_CONDITION,
        contextualRezoning.mihRequirements,
      ],
      citations: ['NYC Charter §197-e (ELURP)', '62 RCNY §14-02.1', 'ZR 27-131 (MIH)'],
    }));
  }
  scenarios.push(scenario({
    id: 'rezoning-ulurp', name: 'Rezoning or special permit through ULURP', approval: 'ulurp',
    addedFloorAreaSqft: discretionaryAdded === null ? null : round(discretionaryAdded),
    totalFloorAreaSqft: Number.isFinite(requestedFloorAreaSqft) ? round(requestedFloorAreaSqft) : null,
    resultingFar: Number.isFinite(requestedFloorAreaSqft) ? round(requestedFloorAreaSqft / lotAreaSqft, 2) : null,
    illustrativeContextualBenchmarks: contextualRezoning.benchmarks,
    timeMonths: [24, 60],
    conditions: [
      elurpEligible
        ? 'Needed for map changes beyond the ELURP limits (more than 30% added maximum residential floor area, a new non-horizontal height plane, or more than 2 FAR of newly permitted commercial floor area), for actions needing an EIS outside Fast Track, and for special permits.'
        : `${district.code} does not allow residence equivalent to R6 or above, so a zoning map change here cannot use the medium- and high-density ELURP path.`,
      'Pre-certification and environmental review (CEQR) precede the ULURP clock: community board and borough president advisory votes, then binding CPC and City Council votes.',
      'If the Council disapproves or modifies a single-borough application that facilitates affordable housing, the Affordable Housing Appeals Board (Mayor, Council Speaker and Borough President) may reverse it on a request filed within 5 days, deciding within 15 days.',
      FAST_TRACK_CONDITION,
      contextualRezoning.mihRequirements,
      'Precedent strength should be researched from CPC reports and dispositions and nearby ULURP actions before this path is priced.',
    ],
    citations: ['NYC Charter §197-c (ULURP)', 'NYC Charter §197-g (Affordable Housing Appeals Board)', 'ZR Article VII Chapter 4', 'ZR 27-131 (MIH)'],
  }));

  // A residential path whose floor area allows 100 or more units changes a new rental's 485-x option.
  if (res.standard !== null) for (const s of scenarios) {
    const threshold = Number.isFinite(s.totalFloorAreaSqft) ? unitThreshold485x(dwellingUnits({residentialFloorAreaSqft: s.totalFloorAreaSqft, specialDensityArea: false, rules}).maxUnits) : null;
    if (threshold) s.conditions.push(threshold);
  }

  const quantified = scenarios.filter(s => s.addedFloorAreaSqft !== null).sort((a, b) => b.feasibilityScore - a.feasibilityScore || (b.addedFloorAreaSqft ?? 0) - (a.addedFloorAreaSqft ?? 0));
  const unquantified = scenarios.filter(s => s.addedFloorAreaSqft === null);
  return {
    district: district.code, lotAreaSqft: round(lotAreaSqft),
    baseline: existingFloorAreaSqft === null
      ? {governingFar, greatestFar, maxFloorAreaSqft: round(baselineMax), existingFloorAreaSqft: null, remainingFloorAreaSqft: null, existingFloorAreaReason: 'The existing floor area is unknown, so no remaining floor area is given; the existing zoning floor area stated in a DOB filing, the certificate of occupancy or a measured survey resolves it.'}
      : {governingFar, greatestFar, maxFloorAreaSqft: round(baselineMax), existingFloorAreaSqft: round(existingFloorAreaSqft), remainingFloorAreaSqft: round(Math.max(0, baselineMax - existingFloorAreaSqft))},
    scenarios: [...quantified, ...unquantified],
    contextualRezoningBenchmarks: contextualRezoning,
    scoringNote: 'Feasibility scores rank paths by approval certainty less typical time (as-of-right 85, certification 70, authorization 60, ELURP 45, special permit 40, variance 25, ULURP 15; minus up to 25 for duration). They ignore price, politics and precedent; research those in the same answer and do not present a score as a probability.',
    note: 'Quantified scenarios are arithmetic from the curated FAR tables and the areas supplied; transfers and mergers are negotiated transactions, and every discretionary path needs its own findings. Starting points to verify, not entitlement determinations.',
  };
}

export const entitlementDefinition = {
  name: 'acres_entitlement_scenarios',
  description: 'Compute how a site could build more: as-of-right baseline against the curated FAR tables, the Universal Affordability Preference uplift (matched 1:1 by affordable floor area, ZR 27-111) or, inside a mapped Mandatory Inclusionary Housing area, the MIH uplift with each mapped option\'s set-aside (ZR 27-131), landmark development-rights transfers with the ZR 75-422 receiving caps, zoning-lot-merger pooling, residential conversion eligibility and area (Article I Chapter 5), plus BSA variance (five ZR 72-21 findings), a modest map change through ELURP (Charter §197-e, sized to the 30% maximum residential floor area limit, with qualifying districts) and rezoning/ULURP paths. Each path carries added floor area where arithmetic allows, approval type, typical timeline, a deterministic feasibility ranking, conditions and citations. Defaults district, lot area, built area and year built from the selected PLUTO property. Use it after acres_zoning_envelope when the user asks how to maximize a site; feed winning scenarios back through the envelope with maxFar to draw them.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      district: {type: 'string', description: 'Zoning district code, e.g. R9A or C6-9. Defaults to the selected property’s first zoning district.'},
      lotAreaSqft: {type: 'number', minimum: 100, description: 'Defaults to the selected property’s PLUTO lot area.'},
      existingFloorAreaSqft: {type: 'number', minimum: 0, description: 'Built floor area today. Defaults to the existing zoning floor area filed with DOB, else PLUTO building area; when PLUTO records none for a lot with a building, existing and remaining floor area are null.'},
      affordableFloorAreaSqft: {type: 'number', minimum: 0, description: 'Affordable floor area the scheme would provide; the UAP uplift is limited to this amount. Omit for the maximum-uplift case.'},
      landmark: {type: 'object', additionalProperties: false, properties: {lotAreaSqft: {type: 'number', minimum: 100}, existingFloorAreaSqft: {type: 'number', minimum: 0}, maxFar: {type: 'number', minimum: 0.1, description: 'Granting-lot maximum FAR; defaults to the subject governing FAR.'}, previouslyTransferredSqft: {type: 'number', minimum: 0}}, required: ['lotAreaSqft'], description: 'A nearby landmark granting lot, to size a ZR 75-422 transfer.'},
      mergerLots: {type: 'array', maxItems: 12, items: {type: 'object', additionalProperties: false, properties: {bbl: {type: 'string'}, address: {type: 'string'}, lotAreaSqft: {type: 'number', minimum: 100}, builtFloorAreaSqft: {type: 'number', minimum: 0, description: 'Omitted reads as a vacant lot; leave out a lot whose built floor area is unknown.'}, maxFar: {type: 'number', minimum: 0.1}}, required: ['lotAreaSqft']}, description: 'Adjacent lots whose unused floor area would pool into one zoning lot.'},
      conversion: {type: 'object', additionalProperties: false, properties: {yearBuilt: {type: 'integer', description: 'Defaults to the selected property’s PLUTO year built.'}, nonResidentialSqft: {type: 'number', minimum: 0}, mechanicalSqft: {type: 'number', minimum: 0}, specialMixedUse: {type: 'boolean'}}, required: [], description: 'Existing-building conversion inputs (Article I Chapter 5). Omit to use the selected property’s PLUTO non-residential area when recorded.'},
      requestedFloorAreaSqft: {type: 'number', minimum: 0, description: 'A target program size; discretionary paths report how much relief it needs beyond as-of-right.'},
    },
    required: [],
  },
};

const num = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };

// lookups is createParcelLookups() from nyc-zoning-lookups.mjs: it supplies the subject's MIH area and
// filed existing zoning floor area; without it MIH status is unknown and PLUTO building area is used.
export function createEntitlementTools({getProperty = () => null, getSameBlock = () => null, enabled = false, emit = () => {}, record = () => null, lookups = null} = {}) {
  let entitlements = null;
  // capture:false sizes the paths without replacing the entitlements that become project state.
  async function scenarios(args = {}, {capture = true} = {}) {
    const property = getProperty();
    const district = args.district || String(property?.zonedist1 || '').split(/[\s/]/)[0] || null;
    if (!district) throw new Error('Pass a district or select a property first so its zoning district is known.');
    const plutoConversionSqft = Math.max(0, num(property?.comarea) ?? num(property?.officearea) ?? (property?.resarea != null && property?.garagearea != null ? (num(property.bldgarea) ?? 0) - Number(property.resarea) - Number(property.garagearea) : 0));
    const conversionSource = num(property?.comarea) ? 'PLUTO commercial area' : num(property?.officearea) ? 'PLUTO office area' : 'PLUTO building area less residential and garage area';
    const conversion = args.conversion
      ? {...args.conversion, yearBuilt: args.conversion.yearBuilt ?? (num(property?.yearbuilt) ? Math.round(num(property.yearbuilt)) : undefined), ...(args.conversion.nonResidentialSqft === undefined && plutoConversionSqft > 0 ? {nonResidentialSqft: plutoConversionSqft, source: conversionSource} : {})}
      : plutoConversionSqft > 0 ? {yearBuilt: num(property?.yearbuilt) ? Math.round(num(property.yearbuilt)) : undefined, nonResidentialSqft: plutoConversionSqft, source: conversionSource} : undefined;
    const found = lookups && property ? await lookups(property) : null;
    const block = getSameBlock();
    const mergerLots = args.mergerLots ?? block?.adjacentBlockLots.filter(lot => lot.bldgarea !== null && lot.lotarea > 0 && lot.estimatedUnusedStandardZfa > 0).map(lot => ({bbl: lot.bbl, address: lot.address, lotAreaSqft: lot.lotarea, builtFloorAreaSqft: lot.bldgarea, maxFar: (lot.estimatedUnusedStandardZfa + lot.bldgarea) / lot.lotarea}));
    const out = entitlementScenarios({
      district,
      lotAreaSqft: args.lotAreaSqft ?? num(property?.lotarea) ?? undefined,
      existingFloorAreaSqft: args.existingFloorAreaSqft ?? num(found?.existingZfa?.existingZfaSqft) ?? (property ? recordedBuildingArea(property) : 0),
      mihArea: found?.mih ?? undefined,
      affordableFloorAreaSqft: args.affordableFloorAreaSqft,
      landmark: args.landmark,
      mergerLots,
      conversion,
      requestedFloorAreaSqft: args.requestedFloorAreaSqft,
    });
    if (!args.mergerLots && mergerLots?.length) {out.mergerSourceId = block.sourceId;out.mergerBasis = 'Same-block PLUTO candidates; physical contiguity, ownership/control, existing zoning floor area and prior transfers remain unverified.';}
    const entitlementUrl = args.landmark
      ? 'https://zr.planning.nyc.gov/article-vii/chapter-5'
      : args.conversion
        ? 'https://zr.planning.nyc.gov/article-i/chapter-5'
        : 'https://zr.planning.nyc.gov/article-vii/chapter-4';
    const source = record({
      title: `NYC Zoning Resolution entitlement scenarios & statutory mechanisms (${out.district}, lot ${out.lotAreaSqft} sq ft)`,
      url: entitlementUrl,
      text: JSON.stringify(out),
      kind: 'entitlement_scenarios',
    });
    const enriched = {...out, ...(source?.id ? {sourceId: source.id} : {}), ...(out.mergerSourceId ? {sourceIds:[out.mergerSourceId,...(source?.id?[source.id]:[])]} : {})};
    if (capture) {
      entitlements = enriched;
      emit('entitlements.computed', {district: out.district, count: out.scenarios.length});
    }
    return enriched;
  }
  return {definitions: enabled ? [entitlementDefinition] : [], handlers: enabled ? {acres_entitlement_scenarios: scenarios} : {}, get entitlements() { return entitlements; }};
}
