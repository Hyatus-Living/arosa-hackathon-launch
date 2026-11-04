// Architectural Plan & Survey Efficiency Audit ("Upload & Critique" — Skills 1, 7 & 8):
// Evaluates existing or proposed architectural floor plans, test-fits, or uploaded plan/survey
// parameters for net-to-gross efficiency, circulation/core waste, lease-span depth, glazing/light-and-air
// compliance, IBC / NYC Building Code egress checks, and pro-forma value uplift from recovering wasted space.

const round = (n, d = 0) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const optionalNumber = (args, key, min = 0, max = Infinity) => {
  const value = args[key];
  if (value == null) return null;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be a finite number from ${min} to ${max}.`);
  return value;
};

export const BENCHMARK_EFFICIENCY = {
  rental: 0.82,
  condo: 0.85,
  office_to_resi_conversion: 0.78,
};

export const BENCHMARK_LOSS_SHARES = {
  corridorCirculation: 0.08,
  elevatorStairCore: 0.055,
  mechanicalShafts: 0.02,
  exteriorWallLoss: 0.025,
};

export function auditFloorplan(args = {}) {
  const productType = ['rental', 'condo', 'office_to_resi_conversion'].includes(args.productType)
    ? args.productType
    : 'rental';
  const grossSqft = Number(args.grossFloorAreaSqft || 0);
  if (!(grossSqft >= 500 && grossSqft <= 10_000_000)) {
    throw new Error('grossFloorAreaSqft must be between 500 and 10,000,000 sq ft.');
  }

  const storeys = optionalNumber(args, 'storeys', 1, 150);
  if (storeys !== null && !Number.isInteger(storeys)) throw new Error('storeys must be a whole number.');
  const typicalPlateSqft = optionalNumber(args, 'typicalFloorplateSqft', 1) ?? (storeys ? grossSqft / storeys : null);
  const corridorSqft = optionalNumber(args, 'corridorCirculationSqft');
  const coreSqft = optionalNumber(args, 'elevatorStairCoreSqft');
  const mepSqft = optionalNumber(args, 'mechanicalShaftSqft');
  const wallSqft = optionalNumber(args, 'exteriorWallLossSqft');
  const explicitLossComponents = [corridorSqft, coreSqft, mepSqft, wallSqft].filter(v => v !== null);
  const sumExplicitLoss = explicitLossComponents.reduce((a, b) => a + b, 0);
  if (sumExplicitLoss > grossSqft) throw new Error('Supplied loss areas exceed gross floor area.');
  const suppliedNet = optionalNumber(args, 'netRentableOrSellableSqft');
  if (suppliedNet !== null && suppliedNet + sumExplicitLoss > grossSqft + 1e-6) throw new Error('Net area plus supplied loss areas exceeds gross floor area.');
  if (suppliedNet !== null && explicitLossComponents.length === 4 && Math.abs(suppliedNet + sumExplicitLoss - grossSqft) > 1e-6) throw new Error('Net area and the complete loss breakdown must sum to gross floor area.');
  const netSqft = suppliedNet ?? (explicitLossComponents.length === 4 ? grossSqft - sumExplicitLoss : null);
  const totalLossSqft = netSqft === null ? null : grossSqft - netSqft;
  const currentEfficiency = netSqft === null ? null : round(netSqft / grossSqft, 4);
  const targetEfficiency = optionalNumber(args, 'targetEfficiency', 0.6, 0.92) ?? BENCHMARK_EFFICIENCY[productType];
  const share = value => value === null ? null : round(value / grossSqft, 4);
  const corridorShare = share(corridorSqft), coreShare = share(coreSqft), mepShare = share(mepSqft), wallShare = share(wallSqft);
  const buildingDepthFeet = optionalNumber(args, 'buildingDepthFeet', 0);
  const coreToWindowDepthFeet = optionalNumber(args, 'coreToWindowDepthFeet', 0);
  if (args.sprinklered != null && typeof args.sprinklered !== 'boolean') throw new Error('sprinklered must be a boolean.');
  const sprinklered = args.sprinklered ?? null;
  // These are screening assumptions, not a verified code determination for the subject.
  const maxDeadEndAllowedFeet = sprinklered === null ? null : sprinklered ? 50 : 20;
  const maxTravelAllowedFeet = sprinklered === null ? null : sprinklered ? 250 : 200;
  const deadEndCorridorFeet = optionalNumber(args, 'deadEndCorridorFeet');
  const maxTravelDistanceFeet = optionalNumber(args, 'maxTravelDistanceFeet');
  const egressStairCount = optionalNumber(args, 'egressStairCount', 1, 10);
  if (egressStairCount !== null && !Number.isInteger(egressStairCount)) throw new Error('egressStairCount must be a whole number.');

  const inefficiencies = [];
  const recommendations = [];

  if (currentEfficiency !== null && currentEfficiency < targetEfficiency) {
    const gapPct = round((targetEfficiency - currentEfficiency) * 100, 1);
    inefficiencies.push({
      category: 'Net-to-Gross Efficiency Deficit',
      severity: gapPct >= 5 ? 'high' : 'medium',
      finding: `Current net-to-gross efficiency is ${round(currentEfficiency * 100, 1)}% (${netSqft.toLocaleString()} net sq ft / ${grossSqft.toLocaleString()} gross sq ft), which is ${gapPct} percentage points below the institutional ${productType.replace(/_/g, ' ')} benchmark of ${round(targetEfficiency * 100, 1)}%.`,
    });
  }

  if (corridorShare > BENCHMARK_LOSS_SHARES.corridorCirculation + 0.015) {
    const excessCorridorSqft = round((corridorShare - BENCHMARK_LOSS_SHARES.corridorCirculation) * grossSqft);
    inefficiencies.push({
      category: 'Excessive Double-Loaded Corridor / Circulation Waste',
      severity: 'high',
      finding: `Horizontal circulation consumes ${round(corridorShare * 100, 1)}% of GFA (~${round(corridorShare * grossSqft).toLocaleString()} sq ft) vs. an 8.0% institutional target, wasting ~${excessCorridorSqft.toLocaleString()} sq ft of potential sellable/rentable floor area.`,
    });
    recommendations.push(`Compact the horizontal corridor loop, pull apartment entry doors closer to the elevator landing, and convert end-of-hall corridor runs into in-unit foyer/den space to recover ~${excessCorridorSqft.toLocaleString()} net sq ft.`);
  }

  if (coreShare > BENCHMARK_LOSS_SHARES.elevatorStairCore + 0.015) {
    const excessCoreSqft = round((coreShare - BENCHMARK_LOSS_SHARES.elevatorStairCore) * grossSqft);
    inefficiencies.push({
      category: 'Oversized Vertical Core / Stair Geometry',
      severity: 'medium',
      finding: `Elevator/stair core consumes ${round(coreShare * 100, 1)}% of GFA (~${round(coreShare * grossSqft).toLocaleString()} sq ft) vs. a 5.5% benchmark (~${excessCoreSqft.toLocaleString()} sq ft excess).`,
    });
    recommendations.push(`Ask the architect to assess a more compact core and MEP riser arrangement, preserving required independent exits and testing whether the benchmark gap of ~${excessCoreSqft.toLocaleString()} net sq ft can be recovered.`);
  }

  if (coreToWindowDepthFeet !== null && coreToWindowDepthFeet > 30) {
    inefficiencies.push({
      category: 'Excessive Lease-Span / Habitable Room Depth (Light & Air Constraint)',
      severity: coreToWindowDepthFeet > 38 ? 'high' : 'medium',
      finding: `Core-to-window depth is ${coreToWindowDepthFeet} ft (building depth ${buildingDepthFeet} ft). This exceeds the 30 ft planning screen; confirm room geometry, legal windows and the applicable light and air provisions before drawing a compliance conclusion.`,
    });
    recommendations.push(`Place unit bathrooms, walk-in closets, laundry rooms, and kitchens in the inner 10–14 ft collar immediately wrapping the central core so living rooms and bedrooms stay within the outer 20–26 ft window zone${coreToWindowDepthFeet > 40 ? ', or carve a rear/interior light court to create additional legal window perimeter' : ''}.`);
  }

  if (deadEndCorridorFeet !== null && maxDeadEndAllowedFeet !== null && deadEndCorridorFeet > maxDeadEndAllowedFeet) {
    inefficiencies.push({
      category: 'Dead-End Corridor Exceeds Screening Threshold',
      severity: 'high',
      finding: `Dead-end corridor length of ${deadEndCorridorFeet} ft exceeds the ${maxDeadEndAllowedFeet} ft screening threshold for the assumed ${sprinklered ? 'sprinklered' : 'unsprinklered'} Group R-2 occupancy (IBC § 1020.5 / NYC BC 1020.4).`,
    });
    recommendations.push(`Absorb the last ${round(deadEndCorridorFeet - maxDeadEndAllowedFeet + 5)} linear feet of dead-end corridor directly into the corner/end units as private entry galleries, subject to an architect verifying the applicable code, exit access and usable-area consequences.`);
  }

  if (maxTravelDistanceFeet !== null && maxTravelAllowedFeet !== null && maxTravelDistanceFeet > maxTravelAllowedFeet) {
    inefficiencies.push({
      category: 'Travel Distance Exceeds Screening Threshold',
      severity: 'high',
      finding: `Maximum exit access travel distance of ${maxTravelDistanceFeet} ft exceeds the ${maxTravelAllowedFeet} ft screening threshold (IBC Table 1017.2 / NYC BC Table 1017.2).`,
    });
    recommendations.push('Relocate one egress stair toward the far wing or centralize the core to bring maximum travel distance below the screening threshold, subject to verification of the applicable code.');
  }

  const targetNetSqft = netSqft === null ? null : round(grossSqft * Math.max(currentEfficiency, targetEfficiency));
  const recoverableNetSqft = netSqft === null ? null : Math.max(0, targetNetSqft - netSqft);
  const avgUnitSqft = productType === 'condo' ? 950 : 720;
  const equivalentAdditionalUnits = recoverableNetSqft === null ? null : round(recoverableNetSqft / avgUnitSqft, 1);
  const rentPsfMonth = optionalNumber(args, 'marketRentPerSqftPerMonth', 0);
  const salePsf = optionalNumber(args, 'marketSalePricePerSqft', 0);
  const capRate = optionalNumber(args, 'capRate', 0.000001, 0.15);
  const incrementalAnnualGrossRentUsd = recoverableNetSqft === null || rentPsfMonth === null ? null : round(recoverableNetSqft * rentPsfMonth * 12);
  const incrementalAnnualNoiUsd = incrementalAnnualGrossRentUsd === null ? null : round(incrementalAnnualGrossRentUsd * 0.72);
  const capitalizedRentalValueGainUsd = incrementalAnnualNoiUsd === null || capRate === null ? null : round(incrementalAnnualNoiUsd / capRate);
  const incrementalGrossCondoSelloutUsd = recoverableNetSqft === null || salePsf === null ? null : round(recoverableNetSqft * salePsf);
  const netCondoSelloutGainUsd = incrementalGrossCondoSelloutUsd === null ? null : round(incrementalGrossCondoSelloutUsd * 0.94);

  if (recommendations.length === 0) recommendations.push('Verify the unmeasured areas and applicable code before selecting a layout change. Benchmark gaps alone do not establish recoverable space.');

  return {
    productType,
    assessmentBasis: {netArea: suppliedNet !== null ? 'supplied' : explicitLossComponents.length === 4 ? 'derived_from_complete_losses' : 'unknown', optimizedArea: 'benchmark_illustration', codeApplicability: 'unverified'},
    summaryMetrics: {
      grossFloorAreaSqft: grossSqft,
      storeys,
      typicalFloorplateSqft: typicalPlateSqft,
      currentNetAreaSqft: netSqft,
      currentLossAreaSqft: totalLossSqft,
      currentEfficiency,
      currentEfficiencyPercent: currentEfficiency === null ? null : round(currentEfficiency * 100, 1),
      targetBenchmarkEfficiency: targetEfficiency,
      targetBenchmarkEfficiencyPercent: round(targetEfficiency * 100, 1),
      optimizedNetAreaSqft: targetNetSqft,
      recoverableNetSqft,
      equivalentAdditionalUnitsAtTypicalSize: equivalentAdditionalUnits,
    },
    lossFactorBreakdown: {
      corridorCirculationShare: corridorShare,
      corridorCirculationSqft: corridorSqft,
      benchmarkCorridorShare: BENCHMARK_LOSS_SHARES.corridorCirculation,
      elevatorStairCoreShare: coreShare,
      elevatorStairCoreSqft: coreSqft,
      benchmarkCoreShare: BENCHMARK_LOSS_SHARES.elevatorStairCore,
      mechanicalShaftShare: mepShare,
      mechanicalShaftSqft: mepSqft,
      exteriorWallLossShare: wallShare,
      exteriorWallLossSqft: wallSqft,
      unallocatedLossSqft: totalLossSqft === null ? null : Math.max(0, totalLossSqft - sumExplicitLoss),
    },
    codeAndLivabilityAudit: {
      sprinklered,
      buildingDepthFeet,
      coreToWindowDepthFeet,
      habitableDepthLimitFeet: 30,
      habitableDepthStatus: coreToWindowDepthFeet === null ? 'NOT_SUPPLIED' : coreToWindowDepthFeet <= 30 ? 'WITHIN_SCREENING_THRESHOLD' : 'WARNING_DEEP_FLOORPLATE',
      deadEndCorridorFeet,
      maxDeadEndAllowedFeet,
      deadEndStatus: deadEndCorridorFeet === null ? 'NOT_SUPPLIED' : maxDeadEndAllowedFeet === null ? 'UNKNOWN_SPRINKLER_STATUS' : (deadEndCorridorFeet <= maxDeadEndAllowedFeet ? 'WITHIN_SCREENING_THRESHOLD' : 'EXCEEDS_SCREENING_THRESHOLD'),
      maxTravelDistanceFeet,
      maxTravelAllowedFeet,
      travelDistanceStatus: maxTravelDistanceFeet === null ? 'NOT_SUPPLIED' : maxTravelAllowedFeet === null ? 'UNKNOWN_SPRINKLER_STATUS' : (maxTravelDistanceFeet <= maxTravelAllowedFeet ? 'WITHIN_SCREENING_THRESHOLD' : 'EXCEEDS_SCREENING_THRESHOLD'),
      egressStairCount,
      citations: [
        'IBC § 1020.5 / NYC Building Code § 1020.4 (Dead-end corridor limits: 20 ft unsprinklered / 50 ft sprinklered in Group R-2)',
        'IBC Table 1017.2 / NYC Building Code Table 1017.2 (Exit access travel distance: 200 ft unsprinklered / 250 ft sprinklered)',
        'Natural light and ventilation require jurisdiction-specific review of room geometry and windows; the 30 ft depth screen is a planning assumption, not a verified legal limit.',
      ],
    },
    inefficiencies,
    valueEngineeringRecommendations: recommendations,
    proFormaValueUplift: {
      status: recoverableNetSqft === null ? 'insufficient_measurements' : 'illustrative_benchmark_gap',
      assumptions: {rentalNoiMargin: 0.72, condoSellingCostRate: 0.06, physicalRecoveryVerified: false},
      recoverableNetSqft,
      rentalScenario: {
        assumedRentPerSqftPerMonthUsd: rentPsfMonth,
        assumedCapRate: capRate,
        incrementalAnnualGrossRentUsd,
        incrementalAnnualNoiUsd,
        capitalizedAssetValueUpliftUsd: capitalizedRentalValueGainUsd,
      },
      condoScenario: {
        assumedSalePricePerSqftUsd: salePsf,
        incrementalGrossSelloutUsd: incrementalGrossCondoSelloutUsd,
        netSelloutGainAfterSalesCostUsd: netCondoSelloutGainUsd,
      },
    },
    proseGuidance: 'Missing measurements are unknown. Code screens have unverified applicability, and benchmark area/value gains are illustrations, not verified recoverable space. Present a clear Before-vs-After Floor-Plate Efficiency & Value-Engineering table showing Current vs. Optimized Net Area, the Loss Factor Breakdown (Corridor %, Core %, MEP %, Wall %), Code & Light/Air findings, and the dollar Pro-Forma Value Uplift (incremental annual NOI + capitalized value gain for rental, and incremental sellout for condo).',
  };
}

export const floorplanAuditDefinition = {
  name: 'acres_audit_floorplan',
  description: 'Audit an existing or proposed architectural floor plan, test-fit, or uploaded survey/plan ("Upload & Critique"): evaluates net-to-gross efficiency against institutional benchmarks (82% rental, 85% condo, 78% office-to-resi conversion), decomposes corridor/core/MEP/wall loss factors, screens supplied egress and depth measurements against explicit planning assumptions with unverified code applicability, and illustrates area/value gains only when the required measurements and market inputs are supplied.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      productType: {type: 'string', enum: ['rental', 'condo', 'office_to_resi_conversion'], description: 'Target residential product type (default "rental").'},
      grossFloorAreaSqft: {type: 'number', minimum: 500, maximum: 10000000, description: 'Total or typical-floor gross floor area (GFA) in sq ft.'},
      netRentableOrSellableSqft: {type: 'number', minimum: 250, maximum: 10000000, description: 'Current net rentable or sellable area (NRA/NSA) in sq ft, if known.'},
      storeys: {type: 'integer', minimum: 1, maximum: 150, description: 'Number of residential storeys.'},
      typicalFloorplateSqft: {type: 'number', minimum: 500, maximum: 200000, description: 'Typical single-storey floorplate gross area in sq ft.'},
      corridorCirculationSqft: {type: 'number', minimum: 0, maximum: 2000000, description: 'Area consumed by horizontal corridors/hallways in sq ft.'},
      elevatorStairCoreSqft: {type: 'number', minimum: 0, maximum: 2000000, description: 'Area consumed by elevators and exit stairs in sq ft.'},
      mechanicalShaftSqft: {type: 'number', minimum: 0, maximum: 2000000, description: 'Area consumed by MEP rooms and vertical shafts in sq ft.'},
      exteriorWallLossSqft: {type: 'number', minimum: 0, maximum: 2000000, description: 'Area consumed by exterior curtain wall / masonry thickness in sq ft.'},
      buildingDepthFeet: {type: 'number', minimum: 15, maximum: 500, description: 'Overall building depth in feet.'},
      coreToWindowDepthFeet: {type: 'number', minimum: 10, maximum: 250, description: 'Lease span depth from central core wall to exterior window wall in feet.'},
      deadEndCorridorFeet: {type: 'number', minimum: 0, maximum: 300, description: 'Longest dead-end corridor pocket in feet.'},
      maxTravelDistanceFeet: {type: 'number', minimum: 10, maximum: 600, description: 'Maximum exit access travel distance in feet.'},
      egressStairCount: {type: 'integer', minimum: 1, maximum: 10, description: 'Number of exit stairs serving the floorplate.'},
      sprinklered: {type: 'boolean', description: 'Whether the building is fully sprinklered (NFPA 13; omit when unknown).'},
      targetEfficiency: {type: 'number', minimum: 0.6, maximum: 0.92, description: 'Optional custom target net-to-gross efficiency ratio.'},
      marketRentPerSqftPerMonth: {type: 'number', minimum: 1, maximum: 30, description: 'Submarket monthly rent per net sq ft for value-uplift calculation.'},
      marketSalePricePerSqft: {type: 'number', minimum: 100, maximum: 15000, description: 'Submarket condo sale price per net sq ft for value-uplift calculation.'},
      capRate: {type: 'number', minimum: 0.025, maximum: 0.15, description: 'Exit cap rate for an illustrative value calculation; omitted rates remain unknown.'},
    },
    required: ['grossFloorAreaSqft'],
  },
};

export function createFloorplanAuditTools({emit = () => {}, getMarket = () => null} = {}) {
  const audits = [];
  async function runAudit(args = {}) {
    const market = getMarket();
    const fallbackRent = market?.rents?.find(r => r.bedrooms === 1)?.rentPerSqftPerMonth
      || market?.rents?.[0]?.rentPerSqftPerMonth
      || undefined;
    const fallbackSale = market?.salePrices?.find(r => r.bedrooms === 2)?.pricePerSqft
      || market?.salePrices?.[0]?.pricePerSqft
      || undefined;
    const result = auditFloorplan({
      ...args,
      marketRentPerSqftPerMonth: args.marketRentPerSqftPerMonth ?? fallbackRent,
      marketSalePricePerSqft: args.marketSalePricePerSqft ?? fallbackSale,
    });
    audits.push(result);
    emit('floorplan.audited', {
      productType: result.productType,
      currentEfficiency: result.summaryMetrics.currentEfficiency,
      recoverableNetSqft: result.summaryMetrics.recoverableNetSqft,
    });
    return result;
  }

  return {
    definitions: [floorplanAuditDefinition],
    handlers: {acres_audit_floorplan: runAudit},
    get audits() { return audits; },
  };
}
