import {throwIfCancelled} from './execution-context.mjs';
import {shallowLotRearYardFeet} from './envelope.mjs';
import {readFileSync} from 'node:fs';
import {providerJson,PublicToolError} from './public-http.mjs';
import {detectJurisdiction,coverageFor,NYC_JURISDICTION} from './jurisdiction.mjs';
import {recordedBuildingArea,UNKNOWN_EXISTING} from './zoning.mjs';
const zoningRules = JSON.parse(readFileSync(new URL('./zoning-rules.json', import.meta.url), 'utf8'));

export const boroughs={manhattan:'MN',brooklyn:'BK',queens:'QN',bronx:'BX','staten island':'SI'};
export const parcelDataset='https://data.cityofnewyork.us/resource/64uk-42ks.json';
const fields=['borough','address','zipcode','bbl','block','lot','zonedist1','zonedist2','zonedist3','zonedist4','overlay1','overlay2','spdist1','spdist2','spdist3','ltdheight','lotarea','bldgarea','comarea','resarea','officearea','retailarea','garagearea','factryarea','otherarea','numfloors','numbldgs','unitsres','unitstotal','yearbuilt','yearalter1','yearalter2','builtfar','residfar','commfar','facilfar','affresfar','lotfront','lotdepth','bldgfront','bldgdepth','lottype','irrlotcode','edesignum','transitzone','ownername','ownertype','landuse','easements','landmark','histdist','splitzone','zonemap','sanborn','taxmap','version','cd','bldgclass','firm07_flag','pfirm15_flag','latitude','longitude'];
const validBbl=value=>typeof value==='string'&&/^[1-5]\d{9}$/.test(value);
const cleanRow=row=>Object.fromEntries(fields.filter(key=>['string','number','boolean'].includes(typeof row[key])||row[key]===null).map(key=>[key,row[key]]));
function streetAddress(value) {
  // Keep geographic context out of the street predicate. GeoSearch accepts
  // "bway", but a phrase such as "downtown Manhattan" otherwise yields no hits.
  return value.trim().replace(/\bbway\b/gi,'Broadway')
    .replace(/[,\s]+(?:(?:downtown|uptown|midtown)\s+)?(?:Manhattan|Brooklyn|Queens|Bronx|Staten Island)(?:[,\s]+NY)?\s*$/i,'')
    .replace(/[,\s]+NY\s*$/i,'')
    .replace(/\s+/g,' ').trim();
}

// House number and street of a one-line address with common abbreviations
// expanded, so 'W 85th St' and 'WEST 85 STREET' compare equal. Fractional
// house numbers stay part of the number, so 539 never matches 539 1/2.
const streetWords={ST:'STREET',STR:'STREET',AVE:'AVENUE',AV:'AVENUE',PL:'PLACE',W:'WEST',E:'EAST',N:'NORTH',S:'SOUTH',BLVD:'BOULEVARD',RD:'ROAD',DR:'DRIVE',PKWY:'PARKWAY',LN:'LANE',CT:'COURT',TER:'TERRACE',SQ:'SQUARE',HWY:'HIGHWAY',FIRST:'1',SECOND:'2',THIRD:'3',FOURTH:'4',FIFTH:'5',SIXTH:'6',SEVENTH:'7',EIGHTH:'8',NINTH:'9',TENTH:'10',ELEVENTH:'11',TWELFTH:'12'};
export function addressIdentity(value) {
  const line=String(value||'').split(',')[0].toUpperCase().replace(/[.'#]/g,' ').replace(/\s+/g,' ').trim();
  const match=line.match(/^(\d+(?:-\d+)?[A-Z]?(?: \d+\/\d+)?) (.+)$/);
  if(!match)return null;
  // ST before more street words is Saint ('St Marks Pl'), at the end Street.
  const words=match[2].split(' ');
  return `${match[1]} ${words.map((word,i)=>word==='ST'&&i<words.length-1?'SAINT':streetWords[word]||word.replace(/^(\d+)(?:ST|ND|RD|TH)$/,'$1')).join(' ')}`;
}

export const LOT_TYPE_MAP = {
  '0': {code: '0', envelopeType: 'interior', label: 'Mixed / Unclassified Lot'},
  '1': {code: '1', envelopeType: 'block', label: 'Block Assemblage (Entire Tax Block)'},
  '2': {code: '2', envelopeType: 'interior', label: 'Waterfront Lot'},
  '3': {code: '3', envelopeType: 'corner', label: 'Corner Lot'},
  '4': {code: '4', envelopeType: 'through', label: 'Through Lot'},
  '5': {code: '5', envelopeType: 'interior', label: 'Inside / Interior Lot'},
  '6': {code: '6', envelopeType: 'interior', label: 'Interior Lot (No Street Frontage)'},
  '7': {code: '7', envelopeType: 'block', label: 'Island Lot'},
  '8': {code: '8', envelopeType: 'interior', label: 'Alley Lot'},
  '9': {code: '9', envelopeType: 'interior', label: 'Submerged Land Lot'},
};

export function buildParcelDiagnostics(row) {
  if (!row || typeof row !== 'object') return null;
  const bbl = String(row.bbl || '');
  const lotNum = Number(row.lot || bbl.slice(6) || 0);
  const bldgClass = String(row.bldgclass || '').toUpperCase();
  const isCondoBillingLot = (lotNum >= 7501 && lotNum <= 7599) || bldgClass.startsWith('R');

  const lotArea = Number(row.lotarea || 0);
  // Null when PLUTO does not record the building area of a lot it shows a building on.
  const bldgArea = recordedBuildingArea(row);
  const existingUnknown = bldgArea === null;
  const numFloors = Number(row.numfloors || 0);
  const builtFar = existingUnknown ? null : Number(row.builtfar || 0);
  const residFar = Number(row.residfar || 0);
  const affResFar = Number(row.affresfar || 0);
  const commFar = Number(row.commfar || 0);
  const facilFar = Number(row.facilfar || 0);
  const lotFront = Number(row.lotfront || 0);
  const lotDepth = Number(row.lotdepth || 0);
  const rectArea = +(lotFront * lotDepth).toFixed(2);
  const geomDelta = +(lotArea - rectArea).toFixed(2);

  const lotTypeCode = row.lottype != null ? String(row.lottype).trim() : null;
  const lotTypeInfo = (lotTypeCode && LOT_TYPE_MAP[lotTypeCode]) || {code: lotTypeCode, envelopeType: 'interior', label: 'Inside / Interior Lot (default)'};
  const isIrrLot = row.irrlotcode === true || row.irrlotcode === 'Y' || row.irrlotcode === 'true' || Math.abs(geomDelta) > 25;
  const shallowRule = zoningRules.bulk.residentialCommon.shallowLot;
  const shallowRearYardFt = (lotDepth > 0 && lotDepth < shallowRule.maxDepthFeet) ? +shallowLotRearYardFeet(zoningRules.bulk.residentialCommon.rearYardFeet.upTo75Feet, lotDepth, zoningRules).toFixed(1) : null;

  const zfaAt = share => (existingUnknown ? null : Math.round(bldgArea * share));
  const zfa100 = zfaAt(1);
  const zfa95 = zfaAt(0.95);
  const zfa90 = zfaAt(0.9);
  const zfa85 = zfaAt(0.85);
  const impliedExistingFloorplate = (bldgArea > 0 && numFloors > 0) ? Math.round(bldgArea / numFloors) : (lotArea > 0 ? Math.round(lotArea * 0.8) : null);

  const calcBand = far => {
    const maxZfa = +(lotArea * far).toFixed(2);
    const unused = zfa => (zfa === null ? null : +(maxZfa - zfa).toFixed(2));
    const u100 = unused(zfa100);
    const u95 = unused(zfa95);
    const u90 = unused(zfa90);
    const u85 = unused(zfa85);
    return {
      far,
      maxZfa,
      netUnusedAt100PctGfa: u100,
      netUnusedAt95PctGfa: u95,
      netUnusedAt90PctGfa: u90,
      netUnusedAt85PctGfa: u85,
      ...(!existingUnknown && impliedExistingFloorplate && impliedExistingFloorplate > 0 ? {
        equivalentFloorsAtImpliedFloorplate: {
          assumedFloorplateSqFt: impliedExistingFloorplate,
          at100PctGfa: u100 > 0 ? +(u100 / impliedExistingFloorplate).toFixed(2) : 0,
          at95PctGfa: u95 > 0 ? +(u95 / impliedExistingFloorplate).toFixed(2) : 0,
          at90PctGfa: u90 > 0 ? +(u90 / impliedExistingFloorplate).toFixed(2) : 0,
          at85PctGfa: u85 > 0 ? +(u85 / impliedExistingFloorplate).toFixed(2) : 0,
        },
      } : {}),
    };
  };

  const maxStandardFar = Math.max(residFar, commFar, facilFar);
  const isOverStandardFar = builtFar > maxStandardFar && maxStandardFar > 0;
  const isOverStandardResidentialFar = residFar > 0 && (builtFar > residFar || (lotArea > 0 && bldgArea > residFar * lotArea));
  const residentialOverageSqFt = (residFar > 0 && lotArea > 0 && bldgArea > residFar * lotArea)
    ? Math.round(bldgArea - residFar * lotArea)
    : 0;
  const inFloodZone = row.firm07_flag === '1' || row.pfirm15_flag === '1';

  const ownerName = row.ownername ? String(row.ownername).trim() : null;
  const ownerType = row.ownertype ? String(row.ownertype).trim() : null;
  const eDesigNum = row.edesignum ? String(row.edesignum).trim() : null;
  const easementsCount = Number(row.easements || 0);
  const isNycha = Boolean(ownerName && /HOUSING AUTHORITY|NYCHA/i.test(ownerName));
  const isTransitOrRail = Boolean(
    bldgClass === 'Z7' ||
    bldgClass.startsWith('U') ||
    (ownerName && /\b(MTA|LIRR|METRO-NORTH|TRANSIT|PORT AUTHORITY|AMTRAK)\b/i.test(ownerName))
  );
  const isGovernmentOrPublic = Boolean(isNycha || isTransitOrRail || ['C', 'O', 'X'].includes(ownerType || ''));

  const landmarkVal = row.landmark && String(row.landmark).trim() ? String(row.landmark).trim() : null;
  const histDistVal = row.histdist && String(row.histdist).trim() ? String(row.histdist).trim() : null;
  const spDists = [row.spdist1, row.spdist2, row.spdist3].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());

  return {
    isCondoBillingLot,
    condoAdvisory: isCondoBillingLot
      ? `Lot ${lotNum} (bldgclass ${bldgClass || 'R'}) is a NYC DOF Condominium Billing Lot. PLUTO reports aggregate billing data; the underlying zoning lot and individual condo unit tax lots (1001+) are governed by the recorded Condominium Declaration. Any demolition, adaptive reuse, or ZLDA air-rights transfer requires reviewing the Condominium Declaration, common-interest allocations, and unit-owner/mortgagee consent thresholds under the NY Condominium Act (RPL Art. 9-B).`
      : null,
    isVacantInPluto: bldgArea === 0,
    ...(existingUnknown ? {existingFloorAreaUnknownAdvisory: `${UNKNOWN_EXISTING} Do not present this lot as vacant or its unused floor area as the full maximum.`} : {}),
    vacantOrMergedLotAdvisory: bldgArea === 0
      ? 'PLUTO records bldgarea = 0 (vacant or recently merged/demolished lot). If the prompt or historical records mention an existing building area, check DOB NOW / BIS / ACRIS for legacy pre-merger tax lots or recent demolition/new-building filings, and explicitly present both the current PLUTO vacant baseline (0 sq ft existing) and the historical/reported building baseline.'
      : null,
    ownershipAndEncumbranceCheck: {
      ownerName,
      ownerType,
      buildingClass: bldgClass || null,
      easementsCount,
      eDesignationNumber: eDesigNum,
      transitZone: row.transitzone || null,
      isNychaPublicHousing: isNycha,
      isTransitOrUtilityRightOfWay: isTransitOrRail,
      isGovernmentOrTaxExempt: isGovernmentOrPublic,
      publicOwnershipAdvisory: isNycha
        ? `CRITICAL DILIGENCE FLAG: PLUTO records ownername = "${ownerName}" (ownertype = "${ownerType || 'O'}"). This property is owned by the New York City Housing Authority (NYCHA). It is NOT a standard private redevelopment site: any disposition, demolition, infill, or air-rights transfer is governed by a federal HUD Declaration of Trust, HUD Section 18 disposition approval (24 CFR Part 970), NYCHA RAD/PACT or mixed-finance preservation rules, and mandatory resident consultation/relocation requirements. State this prominently in your headline and risk analysis.`
        : isTransitOrRail
          ? `CRITICAL DILIGENCE FLAG: PLUTO records bldgclass = "${bldgClass}"${ownerName ? `, ownername = "${ownerName}"` : ''} (transit/rail utility or easement right-of-way strip). Conventional excavation and foundations are typically obstructed by active below-grade or open-cut transit/rail infrastructure; any development requires an engineering overbuild/decking platform, transit agency easement/air-rights agreements, and potentially ULURP disposition/franchise approvals. State this prominently.`
          : isGovernmentOrPublic
            ? `Public/exempt ownership flag: PLUTO records ownername = "${ownerName || 'N/A'}", ownertype = "${ownerType}". Verify whether municipal disposition (ULURP ZR 197-c / Mayoral authorization) or public-authority approvals are required.`
            : null,
      eDesignationAdvisory: eDesigNum
        ? `Parcel carries NYC CEQR Environmental Designation ${eDesigNum} in PLUTO (edesignum = "${eDesigNum}"). Call acres_nyc_public_records to retrieve the specific E-Designation requirements (hazmat Phase I/II OER sign-off, window-wall noise attenuation in dBA + alternate ventilation, and/or HVAC exhaust stack height/setback restrictions) and report them explicitly.`
        : null,
    },
    landmarkAndSpecialDistrictStatus: {
      landmark: landmarkVal,
      historicDistrict: histDistVal,
      specialDistricts: spDists,
      statusSummary: (landmarkVal || histDistVal)
        ? `LPC Jurisdiction Confirmed: PLUTO records ${[landmarkVal ? `landmark = "${landmarkVal}"` : null, histDistVal ? `histdist = "${histDistVal}"` : null].filter(Boolean).join(', ')}. Any exterior alteration, rooftop addition, window/facade work, demolition, or new construction requires Landmarks Preservation Commission (LPC) review (Certificate of Appropriateness or Certificate of No Effect).`
        : 'PLUTO confirms landmark = null and histdist = null: the subject lot itself is NOT an individual NYC landmark and is NOT in an LPC historic district (do NOT call subject-lot landmark status "unverified"; state that PLUTO confirms no landmark/historic-district designation on the subject lot, so the subject lot cannot be a ZR 75-422 / 74-79 granting lot and can only be a receiving lot if an eligible landmark exists on the same block or across the street/intersection under ZR 75-421).',
      specialDistrictSummary: spDists.length
        ? `PLUTO confirms Special Purpose District(s): ${spDists.join(', ')}.`
        : 'PLUTO confirms spdist1 = null: the parcel is NOT located in any Special Purpose District (do not leave special-district applicability "unverified").',
    },
    existingUseAreaBreakdown: {
      grossBldgAreaSqFt: bldgArea,
      residentialAreaSqFt: Number(row.resarea || 0),
      commercialAreaSqFt: Number(row.comarea || 0),
      officeAreaSqFt: Number(row.officearea || 0),
      retailAreaSqFt: Number(row.retailarea || 0),
      garageAreaSqFt: Number(row.garagearea || 0),
      factoryAreaSqFt: Number(row.factryarea || 0),
      otherAreaSqFt: Number(row.otherarea || 0),
      yearBuilt: Number(row.yearbuilt || 0) || null,
      yearAlter1: Number(row.yearalter1 || 0) || null,
      yearAlter2: Number(row.yearalter2 || 0) || null,
    },
    lotGeometryCheck: {
      plutoLotArea: lotArea,
      frontageTimesDepthSqFt: rectArea,
      discrepancySqFt: geomDelta,
      isIrregularLot: isIrrLot,
      plutoLotTypeCode: lotTypeCode,
      plutoLotTypeLabel: lotTypeInfo.label,
      inferredEnvelopeLotType: lotTypeInfo.envelopeType,
      isCornerLotInPluto: lotTypeCode === '3',
      isThroughLotInPluto: lotTypeCode === '4',
      isShallowLotUnder95Ft: lotDepth > 0 && lotDepth < shallowRule.maxDepthFeet,
      shallowLotRearYardFeet: shallowRearYardFt,
      isNarrowFrontageSliverCandidate: lotFront > 0 && lotFront <= 45,
      isSplitZoningLot: row.splitzone === 'Y' || row.splitzone === true || Boolean(row.zonedist2),
      cornerAndShallowLotAdvisory: (lotTypeCode === '3' || lotTypeCode === '4' || (lotDepth > 0 && lotDepth < shallowRule.maxDepthFeet) || lotTypeCode === '0')
        ? `Lot geometry advisory (PLUTO lottype = ${lotTypeCode || 'N/A'} [${lotTypeInfo.label}], lotFront = ${lotFront} ft, lotDepth = ${lotDepth} ft): Always quantify BOTH the interior-lot baseline (80% max residential coverage, standard 20 ft / 30 ft rear yard) AND the corner-lot / shallow-lot geometry (100% residential lot coverage within 100 ft of a corner under ZR 23-362; no rear yard required within 100 ft of a corner under ZR 23-344 / 33-261 / 143-22;${shallowRearYardFt !== null ? ` shallow-lot rear yard reduction to ${shallowRearYardFt} ft (at or below 75 ft of height) on a ${lotDepth} ft deep lot under ZR 23-342;` : ''} through-lot rear yard equivalent under ZR 23-343 / 33-283).`
        : null,
      splitLotAdvisory: (row.splitzone === 'Y' || row.splitzone === true || row.zonedist2)
        ? `Split zoning lot (${[row.zonedist1, row.zonedist2, row.zonedist3].filter(Boolean).join(' / ')}). Apply ZR Article VII Chapter 7 (ZR 77-11 / 77-22) and always provide concrete numeric floor-area tables (for example 70/30, 50/50, and 100% single-district benchmark allocations); never leave capacities as unsolved algebraic variables.`
        : null,
    },
    bulkComplianceAndZfaBands: {
      plutoGrossBldgArea: bldgArea,
      plutoBuiltFar: builtFar,
      impliedExistingFloorplateSqFt: impliedExistingFloorplate,
      estimatedDobZfaBands: {
        at100PctOfPlutoGfa: zfa100,
        at95PctOfPlutoGfa: zfa95,
        at90PctOfPlutoGfa: zfa90,
        at85PctOfPlutoGfa: zfa85,
      },
      ceilingsAndHeadroomByUse: {
        ...(residFar > 0 ? {residentialStandard: calcBand(residFar)} : {}),
        ...(affResFar > 0 ? {residentialUapOrMih: calcBand(affResFar)} : {}),
        ...(commFar > 0 ? {commercial: calcBand(commFar)} : {}),
        ...(facilFar > 0 ? {communityFacility: calcBand(facilFar)} : {}),
      },
      isApparentNonComplyingOrOverbuilt: isOverStandardFar,
      isOverbuiltRelativeToStandardResidentialFar: isOverStandardResidentialFar,
      apparentResidentialOverageSqFt: residentialOverageSqFt,
      nonComplyingBulkAdvisory: (isOverStandardFar || isOverStandardResidentialFar)
        ? `MANDATORY NON-COMPLYING BULK CHECK: Existing PLUTO bldgarea (${bldgArea} sq ft, ${builtFar} FAR) exceeds standard ${isOverStandardFar ? 'maximum district' : 'residential'} FAR (${isOverStandardFar ? maxStandardFar : residFar} FAR = ${Math.round((isOverStandardFar ? maxStandardFar : residFar) * lotArea)} sq ft${residentialOverageSqFt > 0 ? `, an overage of ${residentialOverageSqFt} sq ft` : ''}). Even if higher-FAR uses exist (such as UAP/MIH ${affResFar} FAR or Community Facility ${facilFar} FAR), you MUST explicitly cite and apply ZR Article V Chapter 4: ZR 54-31 (no enlargement, conversion, or transfer may create a new non-compliance or increase the degree of an existing non-compliance) and ZR 54-41 (if 75% or more of a non-complying building's floor area is demolished or destroyed, reconstruction must comply with current bulk/FAR limits).`
        : 'For any retain-vs-demolish or transfer analysis, explicitly address ZR Article V Chapter 4: ZR 54-31 (no enlargement or transfer may create a new non-compliance or increase the degree of an existing non-compliance) and ZR 54-41 (if 75% or more of a non-complying building\'s floor area is demolished or destroyed, any reconstruction must comply with current bulk/FAR limits).',
    },
    floodZoneCheck: {
      firm07Flag: row.firm07_flag ?? null,
      pfirm15Flag: row.pfirm15_flag ?? null,
      inMappedFloodZone: inFloodZone,
      advisory: inFloodZone
        ? 'Parcel is within a mapped FEMA flood zone (FIRM07 / PFIRM15). Apply ZR Article VI Chapter 4 (ZR 64-00): height may be measured from the Flood-Resistant Construction Elevation (FRCE) reference plane (ZR 64-321), with floor-area exemptions for elevated mechanical equipment and wet-floodproofed entry/access space (ZR 64-312).'
        : 'PLUTO firm07_flag and pfirm15_flag are null/0 (not in a mapped FEMA 1% annual chance flood zone per PLUTO). If asked about flood-resilient zoning (ZR 64-00), state this PLUTO fact first and present ZR 64-312 / 64-321 mechanics as a conditional/illustrative resilience scenario.',
    },
  };
}

// Shared by the web harness and the fixed public MCP operations. No model or
// Composio access is required to resolve or retrieve parcels.
export function createParcelOperations({request=providerJson,record=()=>null,onParcel=()=>{}}={}) {
  async function parcels(params) {
    const url=new URL(parcelDataset);url.searchParams.set('$select',fields.join(','));url.searchParams.set('$limit','8');
    for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
    const response=await request(url);
    if(!Array.isArray(response))throw new Error('No usable parcel records were returned.');
    const rows=response.slice(0,8).filter(row=>row&&typeof row==='object').map(cleanRow);
    for(const row of rows)onParcel(String(Math.trunc(Number(row.bbl))),row);
    const source=rows.length?record({title:'NYC Planning PLUTO parcel records',url:url.href,text:JSON.stringify(rows),kind:'property'}):null;
    return {rows,sourceId:source?.id};
  }
  async function findProperty({address,borough,bbl,lotAreaSqft}) {
    if(bbl&&!validBbl(bbl))throw new Error('Use a valid ten-digit NYC BBL.');
    if(address&&(typeof address!=='string'||address.length>300))throw new Error('Use a street address of up to 300 characters.');
    // Parcel records exist only for the deep-coverage market. A clearly non-NYC address must
    // never be queried against NYC datasets, where a same-name street could return a wrong parcel.
    if(address&&!bbl&&!borough) {
      const found=detectJurisdiction(address);
      if(found&&found.jurisdiction!==NYC_JURISDICTION) {
        const hasMunicipalAdapter=['US-FL-MIAMI','US-FL-MIAMIBEACH','US-FL-CORALGABLES','US-FL-FORTLAUDERDALE','US-CT-NEWHAVEN'].includes(found.jurisdiction);
        return {
          rows:[],
          confirmed:false,
          jurisdiction:found,
          coverage:coverageFor(found.jurisdiction),
          hasMunicipalAdapter,
          note:`${found.city}, ${found.state} is outside NYC PLUTO coverage (research-tier, jurisdiction ${found.jurisdiction}).${hasMunicipalAdapter ? ` A dedicated municipal GIS/zoning adapter IS available for ${found.city}: call acres_execute_capability with name="acres_municipal_parcel_records" and arguments={address: "${address}", jurisdiction: "${found.jurisdiction}"}!` : ' No parcel adapter is wired for this city, so do not retry with a BBL or PLUTO lookup.'} Continue with live official-source research for this jurisdiction, search saved knowledge and the source registry with city ${found.jurisdiction}, and name any parcel-data gap in the answer.`,
        };
      }
    }
    const code=borough?boroughs[borough.toLowerCase()]:null;
    if(borough&&!code)throw new Error('Use a NYC borough name.');
    // Preserve the borough supplied in the input phrase even without the
    // optional separate field; never let normalization discard that constraint.
    const suffix=address?.match(/(?:^|[,\s])(Manhattan|Brooklyn|Queens|Bronx|Staten Island)(?:[,\s]+NY)?\s*$/i)?.[1];
    if(borough&&suffix&&borough.toLowerCase()!==suffix.toLowerCase())throw new PublicToolError('BOROUGH_CONFLICT','Clarify the NYC borough: the address and selected borough disagree.',400);
    if(!borough&&suffix)borough=suffix;
    const boroughCode=borough?boroughs[borough.toLowerCase()]:null;
    const normalized=address?streetAddress(address):null;
    if(bbl||address) {
      const result=await parcels(bbl?{bbl}:{address:normalized.toUpperCase(),...(boroughCode?{borough:boroughCode}:{}),...(Number.isFinite(lotAreaSqft)&&lotAreaSqft>0?{lotarea:String(Math.round(lotAreaSqft))}:{})});
      if(result.rows.length) {
        let matchedRows = result.rows;
        if (matchedRows.length > 1 && Number.isFinite(lotAreaSqft) && lotAreaSqft > 0) {
          const exactArea = matchedRows.filter(r => Math.abs(Number(r.lotarea || 0) - lotAreaSqft) <= 5);
          if (exactArea.length === 1) matchedRows = exactArea;
        }
        return {
          ...result,
          rows: matchedRows,
          confirmed: matchedRows.length === 1,
          ...(matchedRows.length === 1 ? {parcelDiagnostics: buildParcelDiagnostics(matchedRows[0])} : {}),
          note: matchedRows.length === 1 ? 'A single parcel matched.' : 'Multiple parcels matched. Match by lotarea, zonedist1, or bldgarea from the prompt if stated, or ask which one before confirming.',
        };
      }
      // If a street-name-only address (no leading house number, e.g. "50 Avenue") had no exact match with lotarea or needs a LIKE fallback on that street:
      if (!bbl && normalized && !/^\d/.test(normalized) && boroughCode) {
        const cleanStreet = normalized.toUpperCase().replace(/'/g, '');
        const whereClause = `borough='${boroughCode}' AND (address='${cleanStreet}' OR address LIKE '% ${cleanStreet}')${Number.isFinite(lotAreaSqft) && lotAreaSqft > 0 ? ` AND lotarea=${Math.round(lotAreaSqft)}` : ''}`;
        const fallback = await parcels({'$where': whereClause});
        if (fallback.rows.length) {
          return {
            ...fallback,
            confirmed: fallback.rows.length === 1,
            ...(fallback.rows.length === 1 ? {parcelDiagnostics: buildParcelDiagnostics(fallback.rows[0])} : {}),
            note: fallback.rows.length === 1 ? 'A single parcel matched on street name and lot attributes.' : 'Multiple parcels matched on this street. Compare lotarea, zonedist1, and bldgarea against the question to pick the matching BBL.',
          };
        }
      }
    }
    if(!address)return {rows:[],confirmed:false,note:'No parcel record matched this BBL.'};
    const url=new URL('https://geosearch.planninglabs.nyc/v2/search');url.searchParams.set('text',`${normalized}${borough?`, ${borough}`:''}`);url.searchParams.set('size','10');
    const result=await request(url);
    if(!Array.isArray(result.features))throw new Error('No usable address candidates were returned.');
    const candidates=[...new Map(result.features.slice(0,10).filter(f=>f?.properties&&(!borough||f.properties.borough?.toLowerCase()===borough.toLowerCase())).map(f=>{
      const p=f.properties,bbl=String(p.addendum?.pad.bbl||'');
      return [bbl,{label:p.label,borough:p.borough,address:p.name,bbl,confidence:p.confidence,version:p.addendum?.pad.version}];
    }).filter(([bbl])=>validBbl(bbl))).values()];
    const source=candidates.length?record({title:'NYC Planning GeoSearch address candidates',url:url.href,text:JSON.stringify(candidates),kind:'address'}):null;
    // One candidate in the requested borough with the same house number and
    // street is the identity check the model would make; resolve it now. A
    // failed parcel lookup leaves the candidates for the model to resolve.
    // A supplied lot area must agree with that record, within the same
    // tolerance used to pick among PLUTO address matches.
    const identity=addressIdentity(normalized);
    if(borough&&identity&&candidates.length===1&&addressIdentity(candidates[0].address)===identity) {
      const resolved=await parcels({bbl:candidates[0].bbl}).catch(()=>null);
      const areaAgrees=row=>!(Number.isFinite(lotAreaSqft)&&lotAreaSqft>0)||Math.abs(Number(row.lotarea||0)-lotAreaSqft)<=5;
      if(resolved?.rows.length===1&&areaAgrees(resolved.rows[0]))return {...resolved,candidates,candidatesSourceId:source?.id,confirmed:true,parcelDiagnostics:buildParcelDiagnostics(resolved.rows[0]),note:'The only address candidate in this borough with this house number and street, resolved to its parcel record.'};
    }
    return {candidates,confirmed:false,sourceId:source?.id,note:'Rank and confidence do not prove identity. Resolve against the question, then look up its BBL. Ask if materially ambiguous.'};
  }
  async function nearby({bbl,radiusMeters=150}) {
    if(!validBbl(bbl)||!Number.isFinite(radiusMeters)||radiusMeters<10||radiusMeters>500)throw new Error('Use a valid BBL and a radius of 10 to 500 meters.');
    const {rows}=await parcels({bbl}),lat=Number(rows[0]?.latitude),lon=Number(rows[0]?.longitude);
    if(!rows.length||!rows[0].latitude||!rows[0].longitude||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('No parcel coordinates were available.');
    const dy=radiusMeters/111320,dx=dy/Math.cos(lat*Math.PI/180),url=new URL(parcelDataset);
    url.searchParams.set('$select',fields.join(','));url.searchParams.set('$limit','51');url.searchParams.set('$order','bbl ASC');
    url.searchParams.set('$where',`latitude between ${lat-dy} and ${lat+dy} AND longitude between ${lon-dx} and ${lon+dx} AND bbl != '${bbl}'`);
    const response=await request(url);if(!Array.isArray(response))throw new Error('No usable nearby records were returned.');
    const records=response.slice(0,50).filter(row=>row&&typeof row==='object').map(cleanRow);
    const source=records.length?record({title:'NYC PLUTO nearby parcel candidates',url:url.href,text:JSON.stringify(records),kind:'property'}):null;
    return {records,sourceId:source?.id,truncated:response.length>50,coverage:{complete:response.length<=50,returned:records.length,limit:50,order:'bbl ASC'},note:'Centroids within a bounding box. This does not prove adjacency, ownership, unused rights or a common zoning lot.'};
  }
  async function sameBlock({bbl,borough,block,lot}) {
    if(!validBbl(bbl)||!borough||!block)return null;
    const url=new URL(parcelDataset);
    url.searchParams.set('$select',fields.join(','));
    url.searchParams.set('$limit','500');
    url.searchParams.set('$order','bbl ASC');
    url.searchParams.set('$where',`borough='${String(borough).replace(/'/g,'')}' AND block='${String(block).replace(/'/g,'')}' AND bbl != '${bbl}'`);
    const response=[],seen=new Set();
    let complete=false;
    for(let page=0;page<4;page++){
      throwIfCancelled();
      url.searchParams.set('$offset',String(page*500));
      const rows=await request(url);
      throwIfCancelled();
      if(!Array.isArray(rows))throw new Error('No usable block records were returned.');
      if(rows.some(row=>seen.has(String(row.bbl))))break;
      for(const row of rows){seen.add(String(row.bbl));response.push(row);}
      if(rows.length<500){complete=true;break;}
    }
    if(!response.length)return null;
    url.searchParams.delete('$offset');
    const coverage={complete,scanned:response.length,limit:2000,order:'bbl ASC'};
    const subjLot=Number(lot||bbl.slice(6)||0);
    const cleaned=response.filter(r=>r&&typeof r==='object').map(cleanRow);
    const mapLot=r=>{
      const la=Number(r.lotarea||0),ba=recordedBuildingArea(r),maxFar=Math.max(Number(r.residfar||0),Number(r.commfar||0),Number(r.facilfar||0));
      return {
        bbl:String(Math.trunc(Number(r.bbl))),
        lot:Number(r.lot||0),
        address:r.address,
        ownername:r.ownername||null,
        zonedist1:r.zonedist1,
        overlay1:r.overlay1||null,
        spdist1:r.spdist1||null,
        lottype:r.lottype||null,
        lotarea:la,
        bldgarea:ba,
        builtfar:ba===null?null:Number(r.builtfar||0),
        residfar:Number(r.residfar||0),
        affresfar:Number(r.affresfar||0),
        commfar:Number(r.commfar||0),
        facilfar:Number(r.facilfar||0),
        bldgclass:r.bldgclass||null,
        landmark:r.landmark||null,
        histdist:r.histdist||null,
        estimatedUnusedStandardZfa:ba===null?null:+(la*maxFar-ba).toFixed(0),
      };
    };
    const sorted=cleaned
      .sort((a,b)=>Math.abs(Number(a.lot||0)-subjLot)-Math.abs(Number(b.lot||0)-subjLot)||String(a.bbl).localeCompare(String(b.bbl)))
      .slice(0,10)
      .map(mapLot);
    const landmarksOnSameBlock=cleaned
      .filter(r=>(r.landmark&&String(r.landmark).trim())||(r.histdist&&String(r.histdist).trim()))
      .map(mapLot);
    const source=sorted.length?record({title:`NYC PLUTO Block ${block} adjacent tax lots`,url:url.href,text:JSON.stringify({adjacentBlockLots:sorted,landmarksOnSameBlock,coverage}),kind:'property'}):null;
    return {
      block:Number(block),
      borough,
      adjacentBlockLots:sorted,
      coverage,
      truncated:!complete,
      landmarksOnSameBlock,
      sourceId:source?.id,
      note:'Tax lots on the same NYC tax block sorted by lot-number proximity (for ZLDA zoning-lot merger, landmark TDR, and contextual block analysis). Verify shared ≥10 linear ft lot boundary on the DOF Tax Map.',
      proseInstruction:'Whenever the user question involves zoning-lot mergers (ZLDAs), landmark TDR (ZR 75-422 / 74-79), air-rights transfers, or block context, you MUST report specific named lots from adjacentBlockLots (Lot number, address, lotarea, bldgarea, builtfar, and estimatedUnusedStandardZfa) and landmarksOnSameBlock in your written answer and cite this sourceId. A null bldgarea is unrecorded, not vacant.',
    };
  }
  return {findProperty,nearby,sameBlock};
}
