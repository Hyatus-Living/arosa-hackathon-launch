import {readFileSync} from 'node:fs';
import {computeEnvelope, conceptArguments, shallowLotRearYardFeet, transitZoneOf} from './envelope.mjs';

// Zoning envelope and capacity for the selected parcel: PLUTO's own maximum FARs and built
// area give the capacity arithmetic; a curated table of Lower Manhattan districts gives the rules
// to read, as starting points with their Zoning Resolution sections; envelope.mjs turns the bulk
// rules into per-storey footprints the agent can pass to acres_model_concept.
export const rules = JSON.parse(readFileSync(new URL('./zoning-rules.json', import.meta.url), 'utf8'));
const round = (n, d = 0) => Number(n.toFixed(d));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pair = {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2};

export const zoningDefinition = {
  name: 'acres_zoning_envelope',
  description: 'NYC only (deep coverage): summarize the zoning envelope and remaining development capacity of the selected New York City property: PLUTO maximum FAR by use against the lot and the existing building, the curated rules and Zoning Resolution sections for its districts, overlays and special districts, and a computed as-of-right envelope (per-storey footprints with heights under the street wall, setback, sky exposure plane, tower coverage and yard rules, plus lot coverage, dwelling units and parking) whose `envelope.concept` can be passed straight to acres_model_concept. Street widths come from the Digital City Map streets the lot fronts; pass `streets` to override them, and a frontage with no mapped width falls back to narrow-street rules, flagged. The parcel also carries the districts, overlays and special districts on the current City Planning zoning map with the share of the lot each covers (a split lot gets per-district floor area under ZR 77-22), whether the lot is in a Mandatory Inclusionary Housing area, and the existing zoning floor area filed with DOB, which remaining capacity is measured against when stated. `headlineReconciliation` names the operative zoning floor area: the larger residential or commercial maximum (the per-district apportionment on a split lot, the curated envelope maximum when PLUTO states no FAR) or an approved, current, lot-wide DOB filing; a community facility maximum is a conditional row and a new building filing stays context while its zoning lot span is unrecorded. Figures from the curated table are starting points to verify against current text, never a determination.',
  inputSchema: {type: 'object', additionalProperties: false, properties: {
    district: {type: 'string', description: 'Look up one district code (for example C5-5 or M1-5) instead of the selected property. Combine with `lot` to compute an envelope without a selected property.'},
    lot: {type: 'array', minItems: 3, maxItems: 24, items: pair, description: 'Lot outline in feet as [x, z] pairs, x along the front street and z into the lot, replacing the PLUTO rectangle (for example from a survey).'},
    lotShape: {type: 'string', enum: ['pluto_rectangle', 'tax_lot'], description: 'Selected property only, ignored when lot is passed. tax_lot draws the envelope on the actual MapPLUTO tax-lot polygon snapped to its front edge instead of the PLUTO frontage-times-depth rectangle; the result carries lotOutline with every edge so a wrong front can be corrected.'},
    frontEdgeIndex: {type: 'integer', minimum: 0, description: 'With lotShape tax_lot: the edge index from a prior lotOutline.edges to treat as the street front.'},
    frontCompass: {type: 'string', enum: ['north', 'south', 'east', 'west'], description: 'With lotShape tax_lot: the compass way the street front faces, used when frontEdgeIndex is not given. The default front is the edge closest to the PLUTO frontage.'},
    streets: {type: 'array', maxItems: 4, items: {type: 'object', additionalProperties: false, properties: {side: {type: 'string', enum: ['front', 'rear', 'left', 'right']}, name: {type: 'string'}, widthFeet: {type: 'number', minimum: 10, maximum: 300, description: 'Mapped street width; 75 ft or more is a wide street (ZR 12-10).'}, streetWallType: {type: 'string', enum: ['1', '2A', '2B', '3', '4', '5'], description: 'Special Lower Manhattan District street wall type from Appendix A Maps 2 and 3 (ZR 91-31), when known.'}}, required: ['side']}, description: 'The streets the lot fronts. Defaults to the mapped streets from the Digital City Map, or one street of unknown width at the front.'},
    use: {type: 'string', enum: ['commercial', 'residential', 'community_facility'], description: 'Envelope use: commercial (default in C and M districts), residential (default in R districts; uses the residential equivalent in C districts), or community_facility (floor area capped at the district community-facility FAR; massing drawn with the district-kind bulk regime and flagged, since community-facility bulk is not curated yet).'},
    affordable: {type: 'boolean', description: 'Use the qualifying affordable housing (Universal Affordability Preference) floor area and heights for a residential envelope.'},
    qualifyingSeniorHousing: {type: 'boolean', description: 'The zoning lot contains qualifying senior housing. This prevents applying a Limited Height District cap under ZR 23-739; verify the qualifying status.'},
    limitedHeightDistrict: {type: 'string', enum: ['LH-1', 'LH-1A', 'LH-2', 'LH-3'], description: 'Limited Height District mapped on the lot. Defaults to PLUTO ltdheight when selected.'},
    form: {type: 'string', enum: ['sky-exposure-plane', 'tower', 'base', 'eligible'], description: 'Height and setback form: sky-exposure-plane or tower for commercial districts; base (fixed heights), tower, or eligible (ZR 23-434 eligible-site heights, districts without a letter suffix) for residential equivalents; sky-exposure-plane for residential use draws the optional ZR 23-73 rules (R6 through R10 districts without a letter suffix: height factor floor area ratio and open space, ZR 23-736 front setbacks and plane, ZR 23-737 towers in R9 and R10). Defaults to the tower form where towers are permitted.'},
    historicCore: {type: 'boolean', description: 'The lot is within the Historic and Commercial Core of the Special Lower Manhattan District (Appendix A Map 1), which raises the tower coverage (ZR 91-33).'},
    maxFar: {type: 'number', minimum: 0.1, maximum: 30, description: 'Override the floor area ratio, for example to show a bonus or transfer scenario.'},
    transitZone: {type: 'string', enum: ['inner', 'outer', 'beyond'], description: 'Transit zone for residential parking requirements outside the Manhattan Core (ZR 25-211, 25-222, 25-232). Omit to use the lot\'s zone from PLUTO; where PLUTO has none, all three zone outcomes are reported.'},
  }, required: []},
};

function envelopeFor({district, specials, lot, property, args}) {
  if (!['commercial', 'residential', 'manufacturing'].includes(district?.kind) || district.bulk === null || !lot) return {envelope: null, envelopeNote: district && district.bulk === null ? `No envelope: ${district.code} bulk is governed by a special district that is not encoded.` : 'No envelope: the district has no curated bulk rules or the lot has no outline.'};
  // A curated gap (no residential equivalent, no sky exposure plane row, no buildable storey) must not
  // cost the agent the capacity and rules summary, so it comes back as a note instead of an error.
  let envelope;
  try {
    envelope = computeEnvelope({rules, district, specialDistricts: specials, lot: args.lot ?? lot.polygon, frontages: args.streets, use: args.use, affordable: args.affordable === true, qualifyingSeniorHousing: args.qualifyingSeniorHousing === true, limitedHeightDistrict: args.limitedHeightDistrict ?? property?.ltdheight ?? null, form: args.form, historicCore: args.historicCore === true, maxFar: args.maxFar, communityDistrict: property?.cd ?? null, transitZone: args.transitZone ?? transitZoneOf(property), transitZoneSource: args.transitZoneSource ?? (args.transitZone ? null : transitZoneOf(property) && 'PLUTO transit zone'), recordedLotAreaSqft: args.lot ? null : Number(property?.lotarea) || null});
  } catch (error) {
    return {envelope: null, envelopeNote: `No envelope: ${error.message}`};
  }
  const flood = [property?.firm07_flag === '1' && '2007 FIRM', property?.pfirm15_flag === '1' && '2015 preliminary FIRM'].filter(Boolean);
  if (flood.length) envelope.checks.push(`Flood zone (${flood.join(' and ')} per PLUTO): flood-resistant buildings measure height per ZR 64-321 and special bulk, use and parking rules in ZR Article VI Chapter 4 may modify this envelope; envelope heights here are from curb level, so confirm the effective FIRM panel and design flood elevation.`);
  return {envelope: {...envelope, concept: conceptArguments(envelope)}, envelopeNote: null};
}

// A commercial district's residential bulk is its residential equivalent's (ZR 34-112, ZR 35-23): one the
// rules do not curate is described from that equivalent, and a curated one without a wide-street floor area
// row takes the equivalent's.
function commercialDistrict(key) {
  const table = rules.commercialResidentialEquivalents, code = table.districts[key], residential = rules.districts[code];
  if (!residential) return null;
  return {kind: 'commercial', residentialEquivalent: code, farResidential: residential.farResidential, farResidentialAffordable: residential.farResidentialAffordable,
    citations: [...table.citations, 'ZR 35-23'], notes: [`Residential bulk follows ${code}, its residential equivalent (ZR 34-112); its commercial floor area is not curated.`]};
}

export function describeDistrict(code) {
  const key = String(code || '').trim().toUpperCase();
  const district = rules.districts[key] ?? commercialDistrict(key);
  if (district) {
    const wide = district.kind === 'commercial' && !district.farResidentialWideStreet ? rules.districts[district.residentialEquivalent]?.farResidentialWideStreet : null;
    return {code: key, ...district, ...(wide ? {farResidentialWideStreet: wide} : {})};
  }
  const overlay = rules.overlays[key];
  if (overlay) return {code: key, kind: 'overlay', ...overlay};
  const special = rules.specialDistricts[key];
  if (special) return {code: key, kind: 'special', ...special};
  return null;
}

const ROMAN_ARTICLES = {
  1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii',
  8: 'viii', 9: 'ix', 10: 'x', 11: 'xi', 12: 'xii', 13: 'xiii', 14: 'xiv',
};

export function zrSectionUrl(sectionCode) {
  const m = String(sectionCode || '').match(/(\d{2,3})-(\d{2,3}[a-z]?)/i);
  if (!m) return null;
  const prefix = m[1];
  const suffix = m[2];
  const artNum = prefix.length === 3 ? Number(prefix.slice(0, 2)) : Number(prefix.slice(0, 1));
  const chapNum = Number(prefix.slice(-1));
  const roman = ROMAN_ARTICLES[artNum];
  if (!roman || !chapNum) return null;
  return `https://zr.planning.nyc.gov/article-${roman}/chapter-${chapNum}#${prefix}-${suffix}`;
}

export function extractZrSectionUrls(items = []) {
  const urls = {};
  const text = (Array.isArray(items) ? items : [items]).map(x => typeof x === 'string' ? x : JSON.stringify(x || '')).join(' ');
  const matches = text.matchAll(/\b(\d{2,3}-\d{2,3}[a-z]?)\b/gi);
  for (const m of matches) {
    const code = m[1];
    const u = zrSectionUrl(code);
    if (u) urls[`ZR ${code}`] = u;
  }
  return urls;
}

export function zoningResolutionUrlFor(district, specials = []) {
  const sp = (specials || []).map(s => String(s).toUpperCase());
  if (sp.includes('LM')) return 'https://zr.planning.nyc.gov/article-ix/chapter-1';
  if (sp.includes('DB')) return 'https://zr.planning.nyc.gov/article-x/chapter-1';
  if (sp.includes('MX')) return 'https://zr.planning.nyc.gov/article-xii/chapter-3';
  if (sp.includes('SNX')) return 'https://zr.planning.nyc.gov/article-xiv/chapter-3';
  if (sp.includes('HS')) return 'https://zr.planning.nyc.gov/article-xi/chapter-9';
  if (district?.kind === 'residential') return 'https://zr.planning.nyc.gov/article-ii/chapter-3';
  if (district?.kind === 'commercial') return 'https://zr.planning.nyc.gov/article-iii/chapter-3';
  if (district?.kind === 'manufacturing') return 'https://zr.planning.nyc.gov/article-iv/chapter-3';
  return 'https://zr.planning.nyc.gov/article-ii/chapter-3';
}

export const UNKNOWN_EXISTING = 'PLUTO does not record a building area for this lot, so its existing floor area is unknown rather than zero and no remaining capacity is given; the existing zoning floor area stated in a DOB filing, the certificate of occupancy or a measured survey resolves it.';

// PLUTO classes the lot itself as having no building: vacant land (land use 11, building class V)
// or an open parking lot (building class G6 or G7).
const classedWithoutBuilding = property => num(property.landuse) === 11 || /^(V|G[67])/i.test(String(property.bldgclass ?? '').trim());

// PLUTO's gross building area, or null when it is not recorded. A lot PLUTO classes as vacant land or
// an open lot reads as 0. Otherwise a blank, unreadable or negative field, or zero on a lot PLUTO shows
// a building on (a building count or a year built), is a gap, not a vacant lot.
export function recordedBuildingArea(property) {
  const blank = property.bldgarea === undefined || property.bldgarea === null || property.bldgarea === '';
  const area = blank ? null : num(property.bldgarea);
  if (area > 0) return area;
  if (area < 0) return null;
  if (classedWithoutBuilding(property)) return 0;
  if (area === null) return null;
  return num(property.numbldgs) > 0 || num(property.yearbuilt) > 0 ? null : 0;
}

// filedExisting is filedExistingZfa(): the existing building's zoning floor area as filed with DOB.
// When it is stated, remaining capacity is measured against it instead of PLUTO's gross floor area.
export function capacity(property, filedExisting = null) {
  const lotArea = num(property.lotarea), built = recordedBuildingArea(property);
  if (!lotArea || lotArea <= 0) return null;
  const filedZfa = filedExisting?.existingZfaSqft > 0 ? Number(filedExisting.existingZfaSqft) : null;
  const existing = filedZfa ?? built;
  const numFloors = num(property.numfloors);
  const impliedFloorplate = (built > 0 && numFloors && numFloors > 0) ? round(built / numFloors) : round(lotArea * 0.8);
  const uses = {residential: num(property.residfar), residentialAffordableOrUap: num(property.affresfar), commercial: num(property.commfar), communityFacility: num(property.facilfar)};
  const byUse = {};
  for (const [use, far] of Object.entries(uses)) {
    if (far === null || far <= 0) continue;
    // Keep legacy top-level keys in byUse as residential/commercial/communityFacility so existing callers/tests see exact keys
    if (use === 'residentialAffordableOrUap') continue;
    const max = far * lotArea;
    byUse[use] = {
      maxFar: far,
      maxFloorAreaSqft: round(max),
      remainingFloorAreaSqft: existing === null ? null : round(Math.max(0, max - existing)),
      apparentOverageSqft: existing === null ? null : existing > max ? round(existing - max) : 0,
      builtShare: existing === null ? null : round(Math.min(1, existing / max), 2),
    };
  }
  const affFar = num(property.affresfar);
  const allUsesForSensitivity = {
    ...byUse,
    ...(affFar && affFar > 0 ? {
      residentialAffordableOrUap: {
        maxFar: affFar,
        maxFloorAreaSqft: round(affFar * lotArea),
        remainingFloorAreaSqft: existing === null ? null : round(Math.max(0, affFar * lotArea - existing)),
      },
    } : {}),
  };
  const builtFar = built === null ? null : num(property.builtfar) ?? round(built / lotArea, 2);
  const maxAnyFloorArea = Math.max(0, ...Object.values(byUse).map(u => u.maxFloorAreaSqft));
  const overbuiltAgainstPlutoGfa = built > 0 && maxAnyFloorArea > 0 && built >= maxAnyFloorArea;
  const zfaSensitivityBand = built > 0 ? {
    plutoGrossBldgAreaSqft: built,
    impliedExistingFloorplateSqft: impliedFloorplate,
    assumedZfaAt85PercentGfaSqft: round(built * 0.85),
    assumedZfaAt90PercentGfaSqft: round(built * 0.90),
    assumedZfaAt95PercentGfaSqft: round(built * 0.95),
    assumedZfaAt100PercentGfaSqft: built,
    residualByUseAt85PercentZfa: Object.fromEntries(Object.entries(allUsesForSensitivity).map(([u, v]) => [u, round(Math.max(0, v.maxFloorAreaSqft - built * 0.85))])),
    residualByUseAt90PercentZfa: Object.fromEntries(Object.entries(allUsesForSensitivity).map(([u, v]) => [u, round(Math.max(0, v.maxFloorAreaSqft - built * 0.90))])),
    residualByUseAt95PercentZfa: Object.fromEntries(Object.entries(allUsesForSensitivity).map(([u, v]) => [u, round(Math.max(0, v.maxFloorAreaSqft - built * 0.95))])),
    residualByUseAt100PercentZfa: Object.fromEntries(Object.entries(allUsesForSensitivity).map(([u, v]) => [u, v.remainingFloorAreaSqft])),
    ...(impliedFloorplate > 0 ? {
      equivalentAdditionalFloorsByUseAtImpliedFloorplate: Object.fromEntries(Object.entries(allUsesForSensitivity).map(([u, v]) => [u, {
        assumedFloorplateSqft: impliedFloorplate,
        floorsAt100PercentZfa: round(Math.max(0, v.maxFloorAreaSqft - built) / impliedFloorplate, 2),
        floorsAt95PercentZfa: round(Math.max(0, v.maxFloorAreaSqft - built * 0.95) / impliedFloorplate, 2),
        floorsAt90PercentZfa: round(Math.max(0, v.maxFloorAreaSqft - built * 0.90) / impliedFloorplate, 2),
        floorsAt85PercentZfa: round(Math.max(0, v.maxFloorAreaSqft - built * 0.85) / impliedFloorplate, 2),
      }])),
    } : {}),
  } : null;
  return {
    lotAreaSqft: lotArea,
    builtFloorAreaSqft: built,
    builtFar,
    existingFloorArea: filedZfa !== null
      ? {sqft: filedZfa, basis: 'dob_filed_zfa', reason: `Remaining floor area is measured against ${Math.round(filedZfa).toLocaleString('en-US')} sq ft of existing zoning floor area: ${filedExisting.basis}.`, jobNumber: filedExisting.filing?.jobNumber ?? null}
      : built === null ? {sqft: null, basis: 'unknown', reason: UNKNOWN_EXISTING}
      : {sqft: built, basis: 'pluto_gross', reason: filedExisting ? `Remaining floor area is measured against PLUTO gross building area because ${filedExisting.basis}.` : 'Remaining floor area is measured against PLUTO gross building area.'},
    byUse,
    ...(affFar && affFar > 0 ? {qualifyingAffordableOrUap: allUsesForSensitivity.residentialAffordableOrUap} : {}),
    zfaVsGfaGuidance: {
      overbuiltAgainstPlutoGfa,
      ...(filedZfa !== null ? {filedExistingZfaSqft: filedZfa, filedZfaShareOfGfa: built > 0 ? round(filedZfa / built, 2) : null} : {}),
      sensitivityBand: zfaSensitivityBand,
      note: 'PLUTO `bldgarea` is Department of Finance gross building area (GFA), NOT Department of Buildings zoning floor area (ZFA) under ZR 12-10 (which excludes qualifying cellar space, mechanical/electrical/HVAC space, accessory parking up to statutory caps, and exterior wall-thickness deductions, often making ZFA 85%–95% of GFA). In your headline and prose, explicitly separate PLUTO GFA from DOB ZFA, show the 100% / 95% / 90% / 85% ZFA sensitivity band and floor-equivalent conversions when relevant, and state that an architect’s DOB ZD1/PW1/Certificate of Occupancy audit is required to establish true unused ZFA.',
    },
  };
}

export function summarizeEnvelope(computed, property = null, districtObj = null, specials = []) {
  if (!computed) return null;
  const sw = computed.controls?.streetWall || {};
  const sb = computed.controls?.setbacks || {};
  const cov = computed.controls?.coverage || {};
  const rear = computed.controls?.yards?.rearYard || {};
  const groundFootprintSqft = computed.storeys?.[0]?.areaSqft ?? null;
  const topFootprintSqft = computed.storeys?.at(-1)?.areaSqft ?? null;
  // Prefer exact PLUTO lot area, frontage, and depth over the 0.1-ft rounded 3D massing polygon
  const lotArea = (num(property?.lotarea) && num(property?.lotarea) > 0) ? num(property?.lotarea) : (computed.lot?.areaSqft ?? 0);
  const lotWidth = (num(property?.lotfront) && num(property?.lotfront) > 0) ? num(property?.lotfront) : (computed.lot?.widthFeet ?? 0);
  const lotDepth = (num(property?.lotdepth) && num(property?.lotdepth) > 0) ? num(property?.lotdepth) : (computed.lot?.depthFeet ?? 0);

  let wideStreetComparison = null;
  if (districtObj && computed.lot?.polygon && computed.lot?.streets?.every(s => s.assumedNarrow)) {
    try {
      const wideComputed = computeEnvelope({
        rules,
        district: districtObj,
        specialDistricts: specials,
        lot: computed.lot.polygon,
        frontages: [{side: 'front', widthFeet: 80}],
        use: computed.use,
        affordable: computed.affordable,
        form: computed.form,
        communityDistrict: property?.cd ?? null,
      });
      wideStreetComparison = {
        narrowStreetAssumed: {
          maxFar: computed.floorArea?.maxFar,
          maxFloorAreaSqft: computed.floorArea?.maxFloorAreaSqft,
          baseHeightMinFeet: sw.minBaseHeightFeet ?? null,
          baseHeightMaxFeet: sw.maxBaseHeightFeet ?? sw.maxFrontWallFeet ?? null,
          maxBuildingHeightFeet: computed.controls?.heightLimitFeet ?? null,
          setbackDepthFeet: sb.depthFeet?.narrow ?? sb.depthFeet ?? null,
          modeledStoreys: computed.metrics?.storeys ?? null,
        },
        wideStreetAt75FtPlus: {
          maxFar: wideComputed.floorArea?.maxFar,
          maxFloorAreaSqft: wideComputed.floorArea?.maxFloorAreaSqft,
          baseHeightMinFeet: wideComputed.controls?.streetWall?.minBaseHeightFeet ?? null,
          baseHeightMaxFeet: wideComputed.controls?.streetWall?.maxBaseHeightFeet ?? wideComputed.controls?.streetWall?.maxFrontWallFeet ?? null,
          maxBuildingHeightFeet: wideComputed.controls?.heightLimitFeet ?? null,
          setbackDepthFeet: wideComputed.controls?.setbacks?.depthFeet?.wide ?? wideComputed.controls?.setbacks?.depthFeet ?? null,
          modeledStoreys: wideComputed.metrics?.storeys ?? null,
        },
      };
    } catch {}
  }

  const shallowRule = rules.bulk.residentialCommon.shallowLot;
  const isShallow = lotDepth > 0 && lotDepth < shallowRule.maxDepthFeet;
  const shallowRearYard = feet => Number(shallowLotRearYardFeet(feet, lotDepth, rules).toFixed(2));
  const lotGeometrySensitivity = lotArea > 0 ? {
    plutoLotTypeCode: property?.lottype ?? null,
    exactLotAreaSqft: lotArea,
    exactLotFrontFeet: lotWidth,
    exactLotDepthFeet: lotDepth,
    interiorLotScenario: {
      maxResidentialCoveragePercent: 80,
      maxResidentialFootprintAt80PctSqft: round(lotArea * 0.8),
      standardRearYardDepthFeet: '20 ft (up to 75 ft height) / 30 ft (above 75 ft height) per ZR 23-342',
      footprintAfter20FtRearYardSqft: lotWidth > 0 && lotDepth > 20 ? round(lotWidth * (lotDepth - 20)) : null,
      footprintAfter30FtRearYardSqft: lotWidth > 0 && lotDepth > 30 ? round(lotWidth * (lotDepth - 30)) : null,
    },
    cornerLotScenario: {
      maxResidentialCoveragePercent: 100,
      maxResidentialFootprintAt100PctSqft: round(lotArea),
      rearYardExemptionWithin100FtOfCorner: '0 ft required within 100 ft of street intersection (ZR 23-344 / ZR 33-261 / ZR 143-22)',
      mixedCornerInteriorCoverageSqft: (lotWidth > 100 || lotDepth > 100)
        ? round(Math.min(lotArea, 10000) * 1.0 + Math.max(0, lotArea - 10000) * 0.8)
        : round(lotArea),
    },
    ...(isShallow ? {
      shallowLotScenario: {
        lotDepthFeet: lotDepth,
        reducedRearYardFeet: shallowRearYard(rules.bulk.residentialCommon.rearYardFeet.upTo75Feet),
        reducedRearYardAbove75FeetFeet: shallowRearYard(rules.bulk.residentialCommon.rearYardFeet.above75Feet),
        footprintAfterReducedRearYardSqft: lotWidth > 0 ? round(lotWidth * Math.max(0, lotDepth - shallowRearYard(rules.bulk.residentialCommon.rearYardFeet.upTo75Feet))) : null,
        citation: `ZR 23-342 (an interior lot less than ${shallowRule.maxDepthFeet} ft deep since December 15, 1961 reduces each rear yard by six inches per foot short of ${shallowRule.maxDepthFeet} ft, never below ${shallowRule.minimumFeet} ft)`,
      },
    } : {}),
  } : null;

  const sectionUrls = extractZrSectionUrls([computed.citations || [], districtObj, lotGeometrySensitivity]);

  return {
    regime: computed.regime,
    form: computed.form,
    district: computed.district,
    residentialEquivalent: computed.residentialEquivalent,
    use: computed.use,
    affordable: computed.affordable,
    streetAssumption: computed.lot?.streets?.map(s => `${s.side}: ${s.wide ? 'wide' : 'narrow'}${s.assumedNarrow ? ' (assumed narrow)' : ''}`).join(', ') || 'front: narrow (assumed)',
    baseHeightMinFeet: sw.minBaseHeightFeet ?? null,
    baseHeightMaxFeet: sw.maxBaseHeightFeet ?? sw.maxFrontWallFeet ?? null,
    maxBuildingHeightFeet: computed.controls?.heightLimitFeet ?? null,
    eligibleSiteMaxHeightFeet: computed.controls?.eligibleSiteMaxHeightFeet ?? null,
    setbackAboveFeet: sb.aboveFeet ?? sb.skyExposurePlane?.startFeet ?? null,
    setbackDepthFeet: sb.depthFeet ?? sb.towerSetbackFeet ?? sb.initialSetbackFeet ?? null,
    skyExposurePlaneSlope: sb.skyExposurePlane?.slope ?? null,
    maxLotCoveragePercent: cov.basePercent ?? null,
    towerCoveragePercent: cov.towerPercent ?? cov.towerUpTo300FeetPercent ?? cov.aboveBaseUpTo300FeetPercent ?? null,
    rearYardFeet: rear.requiredFeet ?? null,
    groundFloorplateSqft: groundFootprintSqft,
    upperFloorplateSqft: topFootprintSqft,
    modeledGrossFloorAreaSqft: computed.metrics?.floorAreaSqft ?? null,
    modeledFar: computed.metrics?.far ?? null,
    modeledStoreys: computed.metrics?.storeys ?? null,
    modeledTotalHeightFeet: computed.metrics?.heightFeet ?? null,
    stoppedBy: computed.metrics?.stoppedBy ?? null,
    maxDwellingUnits: computed.density?.maxUnits ?? null,
    dwellingUnitFactor: computed.density?.dwellingUnitFactor ?? null,
    parkingRequired: computed.parking?.required ?? null,
    plutoTransitZone: property?.transitzone ?? null,
    parkingTransitZones: computed.parking?.transitZones ? Object.fromEntries(Object.entries(computed.parking.transitZones).map(([k, v]) => [k, v.required])) : null,
    ...(wideStreetComparison ? {wideVsNarrowStreetComparison: wideStreetComparison} : {}),
    ...(lotGeometrySensitivity ? {lotGeometrySensitivity} : {}),
    citations: computed.citations || [],
    sectionUrls,
    proseGuidance: 'Surface these physical envelope parameters in your written answer (base height min/max, maximum building height or sky exposure plane, street-line setback depths, max lot coverage, rear yard, floor-plate sizes, dwelling unit factor/max units, and parking requirement). When street width or interior-vs-corner lot geometry is relevant, report BOTH the narrow- and wide-street numbers from wideVsNarrowStreetComparison AND both the interior-lot (80% coverage, 20/30 ft rear yard) and corner/shallow-lot (100% coverage, ZR 23-344 100-ft corner exemption, ZR 23-342 shallow-lot rear yard) figures from lotGeometrySensitivity using exactLotAreaSqft.',
  };
}

const sqft = n => `${Math.round(n).toLocaleString('en-US')} sq ft`;
const BANDS = [100, 95, 90, 85];

// One table for the headline ZFA: the zoning maximum, the governing DOB filed proposal and the
// existing building's GFA read as ZFA, then the operative figure with the reason it was chosen.
// filed is the subject ledger's latestProposal(): {proposal, stage, notOperative, earlierWithZfa, reason}.
// envelope is the computed envelope, whose curated FAR x lot outline stands in when PLUTO states no FAR.
// The zoning maximum is the largest residential or commercial figure: a community facility FAR needs a
// qualifying program and shows as a conditional row, and a split lot takes its maxima from the
// per-district apportionment, never from one district's FAR over the whole lot. A filed ZFA is
// operative only when the ledger found it approved, current and lot wide (notOperative null), a zoning
// maximum exists to check it against, and it does not exceed that maximum by more than 2 percent
// without a documented bonus or transfer.
export function headlineReconciliation(cap, filed, envelope = null) {
  const zoningLabel = 'Zoning maximum ZFA', filedLabel = 'DOB filed proposed ZFA (governing NB/A1)', bandLabel = 'Existing building as ZFA (PLUTO GFA at 100/95/90/85 percent)';
  const largest = byUse => Object.entries(byUse).filter(([use, v]) => use !== 'communityFacility' && v > 0).sort((a, b) => b[1] - a[1])[0] ?? null;
  const split = cap?.splitLot ?? null, apportioned = split?.apportionment && !split.apportionment.uncuratedDistricts ? split.apportionment : null;
  const plutoTop = largest(Object.fromEntries(Object.entries(cap?.byUse ?? {}).map(([use, u]) => [use, u.maxFloorAreaSqft])));
  const env = envelope?.floorArea?.maxFloorAreaSqft > 0 ? envelope : null;
  let zoning, cfSqft = null;
  if (split) {
    const top = apportioned ? largest(apportioned.maxFloorAreaSqft) : null;
    cfSqft = apportioned?.maxFloorAreaSqft.communityFacility || null;
    zoning = top
      ? {label: zoningLabel, valueSqft: top[1], use: top[0], basis: 'split_lot_apportionment', basisText: `${top[0]} floor area apportioned across the split lot (${apportioned.portions.map(p => `${p.district} on ${p.sharePercent}%`).join(', ')}), each portion's area times its district's FAR (ZR 77-22)`, reason: null}
      : {label: zoningLabel, valueSqft: null, basis: null, reason: split.apportionment ? `the split lot's per-district total is open: ${split.apportionment.note}` : 'the lot is split between zoning districts and no per-district apportionment is available, so each PLUTO maximum assumes the whole lot sits in one district'};
  } else if (plutoTop) {
    const u = cap.byUse[plutoTop[0]];
    cfSqft = cap.byUse.communityFacility?.maxFloorAreaSqft ?? null;
    // Sources can disagree even when their products nearly match: a curated FAR over a smaller
    // modeled outline can land within 2 percent of PLUTO's FAR over the full lot by coincidence.
    const sourcesDiffer = env && (env.floorArea.maxFar !== u.maxFar || env.lot.areaSqft !== cap.lotAreaSqft);
    const envelopeNote = sourcesDiffer
      ? `the envelope's curated ${env.district} FAR ${env.floorArea.maxFar} x the ${sqft(env.lot.areaSqft)} modeled lot outline gives ${sqft(env.floorArea.maxFloorAreaSqft)}; the two maxima use different sources (curated FAR ${env.floorArea.maxFar} on ${sqft(env.lot.areaSqft)} against PLUTO FAR ${u.maxFar} on ${sqft(cap.lotAreaSqft)}), so similar totals do not mean the sources agree`
      : null;
    zoning = {label: zoningLabel, valueSqft: u.maxFloorAreaSqft, use: plutoTop[0], maxFar: u.maxFar, lotAreaSqft: cap.lotAreaSqft, basis: 'pluto_far_x_lot_area', basisText: `PLUTO ${plutoTop[0]} FAR ${u.maxFar} x ${sqft(cap.lotAreaSqft)} of lot area`, reason: envelopeNote};
  } else if (env) {
    cfSqft = cap?.byUse?.communityFacility?.maxFloorAreaSqft ?? null;
    zoning = {label: zoningLabel, valueSqft: env.floorArea.maxFloorAreaSqft, use: env.use, maxFar: env.floorArea.maxFar, lotAreaSqft: env.lot.areaSqft, basis: 'curated_far_x_lot_outline', basisText: `the curated ${env.district} FAR ${env.floorArea.maxFar} x the ${sqft(env.lot.areaSqft)} modeled lot outline`,
      reason: `PLUTO states no maximum FAR for this lot, so the maximum is the envelope's curated district FAR over the modeled lot outline; the envelope fits ${sqft(env.metrics?.floorAreaSqft ?? 0)} of gross floor area, limited by ${env.metrics?.stoppedBy ?? 'its bulk rules'}`};
  } else {
    cfSqft = cap?.byUse?.communityFacility?.maxFloorAreaSqft ?? null;
    zoning = {label: zoningLabel, valueSqft: null, basis: null, reason: cap ? 'PLUTO states no residential or commercial maximum FAR for this lot and no envelope is computed' : 'PLUTO reports no lot area for this lot'};
  }
  const {basisText, ...zoningRow} = zoning;
  // The entitlement baseline the brief starts from (curated district FAR over PLUTO's lot area,
  // entitlements.mjs) is a third maximum beside the PLUTO and envelope figures; name it whenever
  // it differs from the zoning row so no larger starting figure sits unexplained next to the headline.
  const baselineSqft = env && cap?.lotAreaSqft > 0 ? round(env.floorArea.maxFar * cap.lotAreaSqft) : null;
  const baselineRow = baselineSqft && zoning.valueSqft && baselineSqft !== zoning.valueSqft
    ? {label: 'Entitlement baseline ZFA (curated FAR x PLUTO lot area)', valueSqft: baselineSqft, basis: 'curated_far_x_pluto_lot_area',
       reason: baselineSqft > zoning.valueSqft
         ? `Larger than the zoning maximum row: it applies the curated ${env.district} FAR ${env.floorArea.maxFar} to PLUTO's ${sqft(cap.lotAreaSqft)} of lot area, while the headline stands on ${basisText}. The gap is the FAR source each figure uses; verify the district FAR against current Zoning Resolution text before relying on the larger figure.`
         : `Smaller than the zoning maximum row: it applies the curated ${env.district} FAR ${env.floorArea.maxFar} to PLUTO's ${sqft(cap.lotAreaSqft)} of lot area, while the headline stands on ${basisText}. The gap is the FAR source each figure uses.`}
    : null;
  const cfRow = cfSqft > (zoning.valueSqft ?? 0)
    ? {label: 'Community facility maximum ZFA (conditional)', valueSqft: cfSqft, conditional: true, reason: 'Available only to a qualifying community facility program; community facility bulk and eligibility are not modeled, so it is never the operative figure.'}
    : null;
  const f = filed.proposal;
  const earlier = filed.earlierWithZfa;
  const earlierNote = earlier ? `; the most recent filing that states a ZFA is job ${earlier.jobNumber} (${earlier.jobType}, ${earlier.status || 'status not recorded'}, filed ${earlier.filingDate || 'on an unrecorded date'}) at ${sqft(earlier.proposedZoningSqft)}` : '';
  const share = f?.proposedZoningSqft > 0 && zoning.valueSqft ? f.proposedZoningSqft / zoning.valueSqft : null;
  const sharePercent = share === null ? null : Math.round(share * 100);
  const notOperative = filed.notOperative ?? (!f ? null
    : share === null ? "no zoning maximum is available to check it against, so it is the filer's own figure, unverified"
    : share > 1.02 ? `it is ${sharePercent} percent of the zoning maximum, so it likely relies on a bonus, transfer or merger that is not documented here` : null);
  const shareNote = sharePercent === null ? '' : `; it is ${sharePercent} percent of the zoning maximum`;
  const filedRow = f
    ? {label: filedLabel, valueSqft: f.proposedZoningSqft > 0 ? f.proposedZoningSqft : null, jobNumber: f.jobNumber, jobType: f.jobType, outcome: f.status, stage: filed.stage, date: f.filingDate ?? null, lastActivity: filed.lastActivity ?? null, proposedDwellingUnits: f.proposedDwellingUnits, proposedStories: f.proposedStories, operative: !notOperative, shareOfZoningMaximumPercent: sharePercent, retrievedAt: filed.retrievedAt ?? null, reason: notOperative ? `Context, not the headline: ${notOperative}${shareNote}${earlierNote}.` : null, earlierWithZfa: earlier ?? null}
    : {label: filedLabel, valueSqft: null, operative: false, reason: filed.reason};
  const built = cap?.builtFloorAreaSqft ?? 0;
  const filedExisting = cap?.existingFloorArea?.basis === 'dob_filed_zfa' ? cap.existingFloorArea : null;
  // Shown only when a DOB filing states the existing building's ZFA; the GFA bands stand in otherwise.
  const existingRow = filedExisting ? {label: 'Existing building ZFA (DOB filing)', valueSqft: filedExisting.sqft, jobNumber: filedExisting.jobNumber, reason: null} : null;
  const bandRow = built > 0
    ? {label: bandLabel, valueSqft: built, bandsSqft: Object.fromEntries(BANDS.map(b => [String(b), round(built * b / 100)])), reason: null}
    : {label: bandLabel, valueSqft: null, reason: cap?.builtFloorAreaSqft === null ? UNKNOWN_EXISTING : 'PLUTO reports no building area, so the lot reads as vacant'};
  const filedWhy = f ? `DOB job ${f.jobNumber} is not operative because ${notOperative}` : `no DOB filed proposal is available because ${filed.reason}`;
  let operativeFigure;
  if (f && !notOperative) {
    const versus = share < 0.98 ? `it is ${sharePercent} percent of the zoning maximum, so the approved project leaves part of the zoning floor area unused`
      : 'it matches the zoning maximum';
    operativeFigure = {valueSqft: f.proposedZoningSqft, basis: 'dob_filed_proposal', reason: `DOB job ${f.jobNumber} (${f.jobType}, ${f.status}, filed ${f.filingDate || 'on an unrecorded date'}) is approved and states ${sqft(f.proposedZoningSqft)} of proposed zoning floor area, the filer's own ZFA computation for this lot; ${versus}.`};
  } else if (zoning.valueSqft) {
    const remainingRangeSqft = filedExisting ? null : built > 0 ? {atFull: round(Math.max(0, zoning.valueSqft - built)), at85Percent: round(Math.max(0, zoning.valueSqft - built * 0.85))} : null;
    const remaining = filedExisting
      ? ` Against the existing building's filed zoning floor area of ${sqft(filedExisting.sqft)} (DOB job ${filedExisting.jobNumber}) the remaining capacity is ${sqft(Math.max(0, zoning.valueSqft - filedExisting.sqft))}.`
      : remainingRangeSqft ? ` Against the existing building the remaining capacity is ${sqft(remainingRangeSqft.atFull)} at 100 percent of GFA and ${sqft(remainingRangeSqft.at85Percent)} at 85 percent.`
      : cap?.existingFloorArea?.basis === 'unknown' ? ' The remaining capacity is unknown because PLUTO does not record the existing building area.' : '';
    operativeFigure = {valueSqft: zoning.valueSqft, basis: 'zoning_maximum', maximumBasis: zoning.basis, ...(remainingRangeSqft ? {remainingRangeSqft} : {}), reason: `The zoning maximum stands, ${basisText}, since ${filedWhy}.${remaining}`};
  } else {
    operativeFigure = {valueSqft: null, basis: null, reason: `No ZFA figure is computed: ${zoning.reason}, and ${filedWhy}.`};
  }
  return {
    rows: [zoningRow, ...(baselineRow ? [baselineRow] : []), ...(cfRow ? [cfRow] : []), filedRow, ...(existingRow ? [existingRow] : []), bandRow, {label: 'Operative figure', ...operativeFigure}],
    operativeFigure,
    guidance: 'State operativeFigure.valueSqft as the headline ZFA with its reason, or when it is null say that no ZFA is computed and why. Then show the other rows so the reader sees how the zoning maximum, the filed proposal and the existing building reconcile. A filing that is not operative is context, never the lot capacity, and a conditional community facility maximum applies only with a qualifying program.',
  };
}

// The governing filed proposal for the reconciliation; a missing or unreadable ledger becomes the
// filed row's reason, never a failed result.
export function governingFiledProposal(ledger) {
  if (!ledger) return {proposal: null, reason: 'no development ledger is configured for this research service'};
  try { return ledger.latestProposal(); } catch (error) { return {proposal: null, reason: `the development ledger could not be read (${error.message})`}; }
}

// A rectangle from PLUTO frontage and depth, in feet, with x along the frontage and z into the lot.
export function suggestedLot(property) {
  const front = num(property.lotfront), depth = num(property.lotdepth), area = num(property.lotarea);
  if (front && depth && front > 0 && depth > 0) {
    const polygon = [[0, 0], [round(front, 1), 0], [round(front, 1), round(depth, 1)], [0, round(depth, 1)]];
    return {polygon, widthFeet: round(front, 1), depthFeet: round(depth, 1), note: area && Math.abs(front * depth - area) / area > 0.15 ? 'PLUTO frontage times depth differs from the lot area by more than 15 percent, so the lot is not a simple rectangle; treat this outline as a stand-in and say so.' : 'Rectangle from PLUTO frontage and depth.'};
  }
  if (area && area > 0) {
    const side = round(Math.sqrt(area), 1);
    return {polygon: [[0, 0], [side, 0], [side, side], [0, side]], widthFeet: side, depthFeet: side, note: 'PLUTO has no frontage or depth, so this is a square of the lot area; say the shape is assumed.'};
  }
  return null;
}

// A lot divided by district boundaries: each portion's area times its district's FAR, summed per use
// (ZR 77-22). Shares come from DCP's current zoning map and are applied to PLUTO's lot area. PARK is
// mapped parkland and carries no floor area; a district without curated FARs leaves the sum open.
export function apportionSplitLot(districts, lotAreaSqft) {
  const farFor = d => {
    if (d.code === 'PARK') return {residential: 0, commercial: 0, communityFacility: 0};
    const found = describeDistrict(d.code);
    if (!found || !['residential', 'commercial', 'manufacturing'].includes(found.kind)) return null;
    const equivalent = found.residentialEquivalent ? rules.districts[found.residentialEquivalent] : null;
    return {residential: found.farResidential ?? equivalent?.farResidential ?? 0, commercial: found.farCommercial ?? 0, communityFacility: found.farCommunityFacility ?? 0};
  };
  const portions = districts.map(d => ({district: d.code, sharePercent: d.sharePercent, lotAreaSqft: round(lotAreaSqft * d.sharePercent / 100), far: farFor(d)}));
  const uncurated = portions.filter(p => !p.far).map(p => p.district);
  const total = use => uncurated.length ? null : round(portions.reduce((sum, p) => sum + p.lotAreaSqft * p.far[use], 0));
  return {
    portions,
    maxFloorAreaSqft: {residential: total('residential'), commercial: total('commercial'), communityFacility: total('communityFacility')},
    ...(uncurated.length ? {uncuratedDistricts: uncurated} : {}),
    citations: ['ZR 77-22', 'ZR 77-11', 'ZR 77-02'],
    note: uncurated.length
      ? `The split-lot total is open because ${uncurated.join(', ')} has no curated floor area ratio; read its FAR in the Zoning Resolution and add that portion.`
      : 'Maximum floor area is each portion\'s area times its district\'s FAR, summed (ZR 77-22); use and bulk rules still apply portion by portion except where ZR 77-11 lets a use extend 25 ft across the boundary, and a lot existing before the boundary was mapped may follow ZR 77-02.',
  };
}

const codes = list => [...new Set((list || []).map(c => String(c).trim().toUpperCase()).filter(Boolean))].sort();
// PLUTO names a lot's lesser districts only when they cover a material part of it, so a mapped
// district reads as missing from PLUTO only at this share or more.
const MATERIAL_SHARE_PERCENT = 10;

// What the live parcel lookups add to the zoning result: parcel fields, split-lot figures and flags.
function lookupFindings(found, property, districts, overlays, specials) {
  if (!found) return {flags: [], fields: {}};
  const flags = [], fields = {};
  const z = found.zoning;
  if (z) {
    fields.currentZoning = {districts: z.districts, overlays: z.overlays, specialDistricts: z.specialDistricts, ...(z.sliversIgnored.length ? {sliversIgnored: z.sliversIgnored} : {}), mappedLotAreaSqft: z.mappedLotAreaSqft, source: z.source};
    // A change is a material mapped district PLUTO does not list, or a PLUTO district the map no longer shows.
    const changes = [['district', z.districts, districts], ['overlay', z.overlays, overlays], ['special district', z.specialDistricts, specials]].flatMap(([what, mapped, pluto]) => {
      const listed = codes(pluto), onMap = codes(mapped.map(d => d.code));
      return [
        ...mapped.filter(d => d.sharePercent >= MATERIAL_SHARE_PERCENT && !listed.includes(d.code.toUpperCase())).map(d => `the map shows ${what} ${d.code} on ${d.sharePercent}% of the lot, which PLUTO does not list`),
        ...listed.filter(code => !onMap.includes(code)).map(code => `PLUTO lists ${what} ${code}, which the map no longer shows on the lot`),
      ];
    });
    if (changes.length) flags.push(`Current zoning map differs from PLUTO ${property.version ?? ''}: ${changes.join('; ')}. PLUTO's maximum FARs and the envelope below use PLUTO's districts; confirm the current map in ZoLa before relying on them.`);
    if (z.districts.length > 1) {
      const lotArea = num(property.lotarea) || z.mappedLotAreaSqft;
      fields.splitLotApportionment = apportionSplitLot(z.districts, lotArea);
      flags.push(`Split zoning lot by DCP's current map: ${z.districts.map(d => `${d.code} ${d.sharePercent}%`).join(', ')} of the lot. Report splitLotApportionment's per-district floor area instead of assumed splits (ZR 77-22).`);
    }
  }
  const m = found.mih;
  if (m) {
    fields.mihArea = m;
    flags.push(m.inMihArea
      ? `Mandatory Inclusionary Housing area: ${m.name} (adopted ${m.adopted}). The Universal Affordability Preference is unavailable here (ZR 27-111); new residential floor area must meet a mapped option (${m.availableOptions.map(o => `${o.label}: ${Math.round(o.affordableShare * 100)}% at ${o.amiPct}% AMI average`).join('; ')}), unless the project has at most ${m.smallProjectExemption.maxUnits} units and ${m.smallProjectExemption.maxResidentialSqft.toLocaleString('en-US')} sq ft of residential floor area (ZR 27-131).`
      : 'Outside every mapped Mandatory Inclusionary Housing area: qualifying affordable floor area above the standard FAR is available through the Universal Affordability Preference (ZR 27-111).');
  }
  const st = found.streets;
  if (st) fields.mappedStreets = {streets: st.streets, ...(st.streets.length ? {frontMatchedAddress: st.frontMatchedAddress} : {note: st.note}), source: st.source};
  const e = found.existingZfa;
  if (e) fields.filedExistingZfa = e;
  for (const [what, why] of Object.entries(found.unavailable || {})) flags.push(`${{zoning: 'Current zoning map', streets: 'Mapped street widths', mih: 'Mandatory Inclusionary Housing area', existingZfa: 'DOB filed existing zoning floor area'}[what]} lookup unavailable (${why}); say it could not be checked rather than assuming a result.`);
  return {flags, fields};
}

// Street frontages for the envelope from the Digital City Map: a side whose width is unknown is left
// for the narrow-street default and its flag.
const mappedFrontages = found => found?.streets?.streets?.length
  ? found.streets.streets.map(s => ({side: s.side, name: s.name, ...(s.widthFeet ? {widthFeet: Math.min(300, Math.max(10, s.widthFeet))} : {})}))
  : null;

// ledger is the subject development ledger (createSubjectLedger); without one the filed row says so.
// lookups is createParcelLookups() from nyc-zoning-lookups.mjs; without it the PLUTO-only result stands.
export function createZoningTools({getProperty = () => null, record = () => null, ledger = null, lookups = null, taxLotOutline = null} = {}) {
  let captured = null, capturedSourceId = null, capturedBbl = null;
  // capture:false computes without replacing the envelope that becomes project state.
  async function envelope(args = {}, {capture = true} = {}) {
    if (args.district) {
      const found = describeDistrict(args.district);
      if (!found) return {district: String(args.district).toUpperCase(), rules: null, note: `No curated entry for this district. ${rules.caveat}`};
      const {envelope: computed, envelopeNote} = args.lot ? envelopeFor({district: found, specials: [], lot: {polygon: args.lot}, property: null, args}) : {envelope: null, envelopeNote: 'Pass `lot` to compute an envelope for this district.'};
      const summary = summarizeEnvelope(computed, null, found, []);
      const source = record({
        title: `NYC Zoning Resolution curated district & envelope summary (${found.code})`,
        url: zoningResolutionUrlFor(found, []),
        text: JSON.stringify({district: found.code, rules: found, envelopeSummary: summary, mechanisms: rules.mechanisms}),
        kind: 'zoning_envelope',
      });
      if (computed && capture) {captured = {...computed, summary}; capturedSourceId = source?.id ?? null; capturedBbl = null;}
      return {district: found.code, rules: found, mechanisms: rules.mechanisms, envelope: computed, envelopeSummary: summary, ...(source?.id ? {sourceId: source.id} : {}), note: `${envelopeNote ? `${envelopeNote} ` : ''}${rules.caveat}`};
    }
    const property = getProperty();
    if (!property) throw new Error('Select the subject property first, or pass a district code.');
    const districts = ['zonedist1', 'zonedist2', 'zonedist3', 'zonedist4'].map(k => property[k]).filter(v => typeof v === 'string' && v.trim());
    const overlays = ['overlay1', 'overlay2'].map(k => property[k]).filter(v => typeof v === 'string' && v.trim());
    const specials = ['spdist1', 'spdist2', 'spdist3'].map(k => property[k]).filter(v => typeof v === 'string' && v.trim());
    const described = [...districts, ...overlays, ...specials].map(code => describeDistrict(code) || {code: code.toUpperCase(), kind: 'unknown', notes: ['No curated entry; read the Zoning Resolution for this district.']});
    const found = lookups ? await lookups(property) : null;
    const findings = lookupFindings(found, property, districts, overlays, specials);
    const streets = args.streets ?? mappedFrontages(found);
    const cap = capacity(property, found?.existingZfa);
    // A split lot's per-use maxima each read one district's FAR over the whole lot: they are bounds, not
    // the lot's capacity, which is the per-district apportionment from DCP's current map when there is one.
    const split = found?.zoning ? found.zoning.districts.length > 1 : property.splitzone === true || property.splitzone === 'true' || property.splitzone === 'Y' || districts.length > 1;
    if (cap && split) cap.splitLot = {wholeLotBound: true, apportionment: findings.fields.splitLotApportionment ?? null, note: 'The lot is split between zoning districts, so each per-use maximum here applies one FAR to the whole lot; the lot\'s maximum is the per-district apportionment (ZR 77-22).'};
    const flags = [];
    // The actual tax-lot shape when asked for: MapPLUTO geometry snapped to its front edge. Any failure
    // keeps the PLUTO rectangle and says so, the same curated-gap treatment as the envelope itself.
    let outline = null;
    if (args.lotShape === 'tax_lot' && !args.lot) {
      const bbl = String(property.bbl ?? '').trim().replace(/\.0+$/, '');
      if (!taxLotOutline || !/^[1-5]\d{9}$/.test(bbl)) flags.push('Tax-lot shape requested but no MapPLUTO geometry lookup is available for this property; the PLUTO rectangle outline is used instead.');
      else {
        try { outline = await taxLotOutline(bbl, {frontageFeet: num(property.lotfront), frontEdge: args.frontEdgeIndex ?? args.frontCompass ?? null}); }
        catch (error) { flags.push(`Tax-lot shape unavailable (${error.message}); the PLUTO rectangle outline is used instead.`); }
        if (!outline && !flags.some(f => f.startsWith('Tax-lot shape unavailable'))) flags.push('Tax-lot shape requested but MapPLUTO has no geometry for this BBL; the PLUTO rectangle outline is used instead.');
      }
    }
    const lot = outline ? {polygon: outline.polygon} : suggestedLot(property);
    if (typeof property.landmark === 'string' && property.landmark.trim()) flags.push(`Landmark: ${property.landmark.trim()} (LPC approval governs exterior work; unused floor area may transfer by certification under ZR 75-422).`);
    else flags.push('Landmark: null in PLUTO (subject lot is not an individual NYC landmark).');
    if (typeof property.histdist === 'string' && property.histdist.trim()) flags.push(`Historic district: ${property.histdist.trim()} (LPC Certificate of Appropriateness governs exterior work, rooftop additions, and demolition).`);
    else flags.push('Historic district: null in PLUTO (subject lot is not in an LPC historic district).');
    if (typeof property.edesignum === 'string' && property.edesignum.trim()) flags.push(`CEQR E-Designation: ${property.edesignum.trim()} in PLUTO (call acres_nyc_public_records for hazmat, air-stack, and noise-attenuation requirements).`);
    if (typeof property.ownername === 'string' && /HOUSING AUTHORITY|NYCHA/i.test(property.ownername)) flags.push(`NYCHA Public Housing Ownership: PLUTO ownername="${property.ownername.trim()}" (HUD Declaration of Trust, Section 18 disposition, and RAD/PACT rules apply).`);
    if (property.splitzone === true || property.splitzone === 'true' || property.splitzone === 'Y') flags.push('Split zoning lot: bulk is apportioned by district area (ZR 77-00).');
    flags.push(...findings.flags);
    if (property.firm07_flag === '1') flags.push('Flood zone: PLUTO flags the lot in the 2007 FIRM 1% annual-chance floodplain; flood-resistant construction and insurance rules apply (ZR Article VI Chapter 4, Building Code Appendix G).');
    else if (property.pfirm15_flag === '1') flags.push('Flood zone: PLUTO flags the lot in the 2015 preliminary FIRM floodplain but not the effective 2007 FIRM; confirm the effective panel before relying on flood requirements (ZR Article VI Chapter 4).');
    const {envelope: computed, envelopeNote} = envelopeFor({district: described[0], specials, lot, property, args: {...args, streets, transitZone: args.transitZone ?? transitZoneOf(property) ?? found?.transitZone?.zone, transitZoneSource: args.transitZone ? null : transitZoneOf(property) ? 'PLUTO transit zone' : found?.transitZone?.sourceUrl}});
    if (computed && outline) computed.lotOutline = {source: 'MapPLUTO tax-lot geometry', frontEdgeIndex: outline.frontEdgeIndex, edges: outline.edges, note: outline.note};
    const summary = summarizeEnvelope(computed, property, described[0], specials);
    // The envelope models the first district over the whole lot, so on a split lot its storeys and area are a bound, not capacity.
    if (summary && split) {
      const apportionment = findings.fields.splitLotApportionment, uncurated = apportionment?.uncuratedDistricts ?? null, apportioned = Boolean(apportionment && !uncurated);
      const scope = args.maxFar
        ? `this envelope applies ${summary.district} height and setback rules to the whole lot at the supplied FAR ${args.maxFar}, so its storeys are a bound for that district and its floor area is the lot's capacity only if that FAR is the lot's area-weighted FAR.`
        : `this envelope applies ${summary.district} rules to the whole lot, so its storeys and floor area are a bound for that district, not the lot's capacity.`;
      const gap = apportioned ? 'The lot\'s maximum is the per-district apportionment (ZR 77-22).'
        : uncurated ? `splitLotApportionment gives each district's share of the lot. ${apportionment.note}`
        : 'No per-district apportionment is available; find each district\'s share of the lot before stating a capacity (ZR 77-22).';
      summary.splitLot = {wholeLotBound: true, modeledDistrict: summary.district, apportioned, ...(uncurated ? {uncuratedDistricts: uncurated} : {}), note: `The lot is split between zoning districts; ${scope} ${gap}`};
    }
    const reconciliation = headlineReconciliation(cap, governingFiledProposal(ledger), computed);
    const parcelMeta = {bbl: property.bbl, address: property.address ?? null, ownerName: property.ownername ?? null, ownerType: property.ownertype ?? null, districts, overlays, specialDistricts: specials, eDesignation: property.edesignum ?? null, transitZone: property.transitzone ?? null, lotTypeCode: property.lottype ?? null, zoningMap: property.zonemap ?? null, plutoVersion: property.version ?? null, communityDistrict: property.cd ?? null, buildingClass: property.bldgclass ?? null, storeys: num(property.numfloors), yearBuilt: num(property.yearbuilt), residentialUnits: num(property.unitsres), totalUnits: num(property.unitstotal), ...findings.fields};
    const source = record({
      title: `NYC Zoning Resolution curated district & envelope summary (BBL ${property.bbl}, ${districts.join('/') || 'NYC'})`,
      url: zoningResolutionUrlFor(described[0], specials),
      text: JSON.stringify({parcel: parcelMeta, capacity: cap, headlineReconciliation: reconciliation, rules: described, envelopeSummary: summary, mechanisms: rules.mechanisms, flags}),
      kind: 'zoning_envelope',
    });
    // The captured envelope becomes project state, so it keeps capacity, summary and the headline beside the geometry.
    if (computed && capture) {captured = {...computed, capacity: cap, summary, headlineReconciliation: reconciliation}; capturedSourceId = source?.id ?? null; capturedBbl = property.bbl ?? null;}
    return {
      parcel: parcelMeta,
      capacity: cap,
      headlineReconciliation: reconciliation,
      suggestedLot: lot,
      storeyHeightsFeet: {retailGround: 15, office: 12.5, residential: 10.5, mechanical: 14},
      rules: described,
      envelope: computed,
      envelopeSummary: summary,
      mechanisms: rules.mechanisms,
      flags,
      ...(source?.id ? {sourceId: source.id} : {}),
      ...(envelopeNote ? {envelopeNote} : {}),
      note: `Capacity is PLUTO's maximum FAR times lot area less ${cap?.existingFloorArea?.basis === 'dob_filed_zfa' ? 'the existing zoning floor area filed with DOB' : 'PLUTO building area'}; it ignores zoning lot mergers, bonuses, transfers, existing non-complying floor area${cap?.existingFloorArea?.basis === 'dob_filed_zfa' ? '' : ' and the difference between gross and zoning floor area'}. ${cap?.existingFloorArea?.basis === 'unknown' ? `${UNKNOWN_EXISTING} ` : ''}${envelopeNote ? `${envelopeNote} ` : `The envelope is computed from the curated bulk rules for the first district on the suggested lot${!args.streets && streets ? ', with the street widths mapped in the Digital City Map' : ''}; pass streets, use, form or a surveyed lot to refine it, and hand envelope.concept to acres_model_concept to draw it. `}${rules.caveat}`,
    };
  }
  return {definitions: [zoningDefinition], handlers: {acres_zoning_envelope: envelope}, get envelope() { return captured; }, get envelopeSourceId() { return capturedSourceId; }, get envelopeBbl() { return capturedBbl; }};
}
