// One-Click Institutional Underwriting Deck & Deliverable Generator (Skills 13 & 14):
// Compiles a conversation's persisted project_state (property, envelope, entitlements, assembly,
// concepts, plans, floorplanAudits, market, program, proFormas, comparisons, assumptions) and citations into a
// structured 7-slide underwriting package + printable/PDF-ready HTML presentation.
import {reportFingerprint} from './project-state.mjs';
import {recordedBuildingArea} from './zoning.mjs';

import {conceptPlanSvg} from './concept-plan-svg.mjs';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const finite = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
const fmtNum = n => (finite(n) ? Number(n).toLocaleString('en-US', {maximumFractionDigits: 1}) : null);
const fmtFixed = (n, digits = 2) => (finite(n) ? Number(n).toFixed(digits) : null);
const fmtUsd = n => (finite(n) ? `${Number(n) < 0 ? '-' : ''}$${Math.abs(Math.round(Number(n))).toLocaleString('en-US')}` : null);
const fmtPct = n => (finite(n) ? `${(Number(n) * 100).toFixed(2)}%` : null);
const fmtPctPoints = n => (finite(n) ? `${Number(n).toLocaleString('en-US', {maximumFractionDigits: 1})}%` : null);
const plainText = s => String(s ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|`)/g, '').trim();

// Tool-recorded titles can carry markdown link syntax from the page heading and
// "(offset N)" suffixes from paged reads; a bare URL title reads as domain plus path.
const sourceDomain = url => new URL(url).hostname.replace(/^www\./, '');
function sourceUrl(url) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : null;
}
function sourceTitle(title, url, rawUrl) {
  const text = plainText(title).replace(/\s*\(offset \d+\)$/, '').trim();
  if (!url && rawUrl && text === rawUrl.trim()) return '';
  if (!url || (text && !/^https?:\/\//.test(text))) return text;
  const {pathname} = new URL(url);
  const path = `${sourceDomain(url)}${pathname}`;
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { decoded = path; }
  return decoded.replace(/\/$/, '');
}

const isPersistedField = val => val && typeof val === 'object' && 'value' in val && ('provenance' in val || 'updated' in val);
const unwrapField = val => isPersistedField(val) ? val.value : val;
const REPORT_FIELDS = {
  property: 'Parcel record', envelope: 'Zoning envelope', entitlements: 'Entitlement scenarios',
  assembly: 'Site assembly', concepts: 'Massing concepts', plans: 'Floor plans',
  floorplanAudits: 'Floor plan audits', market: 'Market inputs', program: 'Unit mix',
  proFormas: 'Financial projections', comparisons: 'Program comparison', assumptions: 'Underwriting assumptions',
};

export function selectReportSummary(messages, projectState, projectId) {
  const fingerprint=reportFingerprint(projectId,projectState);
  const changedAt=Math.max(0,...Object.entries(projectState).filter(([key])=>key!=='architecture').map(([,field])=>field.updated??0));
  for(let i=messages.length-1;i>=0;i--){
    const message=messages[i],completedAt=message.completedAt??message.created;
    if(message.role!=='assistant'||message.error||message.interrupted||message.projectUpdate||!Number.isFinite(completedAt))continue;
    if(message.reportContext){
      if(message.reportContext.projectId!==projectId||message.reportContext.fingerprint!==fingerprint)continue;
    }else if(completedAt<changedAt)continue;
    const paragraph=message.text.split(/\n\s*\n/).map(block=>block.split('\n').filter(line=>!/^\s*#{1,6}\s/.test(line)).join(' ').replace(/\[s\d+\]/gi,'').trim()).find(Boolean);
    if(!paragraph)continue;
    let text=plainText(paragraph);if(!text)continue;
    if(text.length>550)text=text.slice(0,549).replace(/\s+\S*$/,'').trimEnd()+'…';
    return {text,messageId:message.id,runId:message.runId??null,completedAt,contextStatus:message.reportContext?'current':'unverified'};
  }
  return null;
}

export function buildUnderwritingDeck({
  projectState = {},
  title = null,
  investmentThesis = null,
  researchSummary = null,
  keyRisks = [],
  nextSteps = [],
  sources = [],
} = {}) {
  const freshnessWarnings = Object.entries(projectState).filter(([key, field]) => Object.hasOwn(REPORT_FIELDS, key) && isPersistedField(field) && field.stale)
    .map(([key, field]) => {
      const changed = Object.hasOwn(REPORT_FIELDS, field.stale) ? REPORT_FIELDS[field.stale].toLowerCase() : 'the inputs';
      return {field: key, message: `${REPORT_FIELDS[key]}: refresh needed after ${changed} changed.`};
    });
  const property = unwrapField(projectState.property) || null;
  const envelope = unwrapField(projectState.envelope) || null;
  const entitlements = unwrapField(projectState.entitlements) || null;
  const assembly = unwrapField(projectState.assembly) || null;
  const concepts = unwrapField(projectState.concepts) || [];
  const plans = unwrapField(projectState.plans) || [];
  const floorplanAudits = unwrapField(projectState.floorplanAudits) || [];
  const market = unwrapField(projectState.market) || null;
  const program = unwrapField(projectState.program) || null;
  const proFormas = unwrapField(projectState.proFormas) || [];
  const comparisons = unwrapField(projectState.comparisons) || [];
  const assumptions = unwrapField(projectState.assumptions) || null;
  // Null on a lot whose building area PLUTO does not record; when its record shows a building the deck
  // says the area is not recorded rather than printing 0 or dropping the row.
  const existingBldgArea = property ? recordedBuildingArea(property) : null;
  const existingBldgAreaRecorded = !(existingBldgArea === null && property && ('bldgarea' in property || Number(property.numbldgs) > 0 || Number(property.yearbuilt) > 0));
  const band = envelope?.capacity?.existingFloorArea?.basis !== 'dob_filed_zfa' ? envelope?.capacity?.zfaVsGfaGuidance?.sensitivityBand : null;
  const headline = envelope?.headlineReconciliation || null;

  const latestProForma = Array.isArray(proFormas) && proFormas.length ? proFormas.at(-1) : null;
  const latestComparison = Array.isArray(comparisons) && comparisons.length ? comparisons.at(-1) : null;
  const latestConcept = Array.isArray(concepts) && concepts.length ? concepts.at(-1) : null;
  const latestAudit = Array.isArray(floorplanAudits) && floorplanAudits.length ? floorplanAudits.at(-1) : null;
  const recommendedProgram = latestComparison?.recommendation?.label || latestComparison?.winner?.name || null;
  const recommendedMatches = recommendedProgram ? (latestComparison?.variants || []).filter(variant => variant.label === recommendedProgram) : [];
  const summaryVariant = recommendedMatches.length === 1 ? recommendedMatches[0] : null;
  let financialNote = null;
  if (recommendedProgram && !summaryVariant) {
    financialNote = recommendedMatches.length > 1
      ? 'Several programs share the recommended name. Use distinct names in a new comparison to identify its financial figures.'
      : 'Financial figures for the recommended program are unavailable.';
  }

  const subjectLabel = property?.address
    ? `${property.address}${property.borough ? `, ${property.borough}` : ''}${property.bbl ? ` (BBL ${property.bbl})` : ''}`
    : (market?.submarket || 'Subject Development Site');

  const deckTitle = title || `${subjectLabel}: Feasibility and Underwriting Package`;
  const generatedDate = new Date().toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});

  // Collect provenance sources across projectState and explicit sources, one entry per URL
  const allSources = [];
  const seenKeys = new Set();
  const addSrc = s => {
    if (!s || (!s.url && !s.title)) return;
    const url = sourceUrl(s.url);
    const key = url || `title:${plainText(s.title) || s.url}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    allSources.push({
      title: sourceTitle(s.title, url, s.url) || 'Source link unavailable',
      domain: url ? sourceDomain(url) : null,
      url,
      kind: s.kind || 'evidence',
      retrievedAt: s.retrievedAt || s.fetchedAt || null,
    });
  };
  for (const s of sources) addSrc(s);
  for (const field of Object.values(projectState || {})) {
    for (const s of field?.provenance?.sources || []) addSrc(s);
  }

  const slides = [
    {
      slideNumber: 1,
      id: 'executive-summary',
      title: 'Executive Summary & Investment Thesis',
      subtitle: subjectLabel,
      metrics: {
        address: property?.address || null,
        bbl: property?.bbl || null,
        zoningDistrict: property?.zonedist1 || envelope?.district || entitlements?.district || null,
        lotAreaSqft: property?.lotarea || envelope?.lot?.areaSqft || null,
        existingBldgAreaSqft: existingBldgArea,
        existingBldgAreaRecorded,
        recommendedProgram,
        financialProgram: recommendedProgram || latestProForma?.name || latestProForma?.productType || null,
        totalDevelopmentCostUsd: recommendedProgram ? (summaryVariant?.totalDevelopmentCostAfterCarry ?? summaryVariant?.totalDevelopmentCost ?? null) : (latestProForma?.development?.totalDevelopmentCost ?? latestProForma?.costs?.totalDevelopmentCost ?? null),
        yieldOnCost: recommendedProgram ? (summaryVariant?.yieldOnCostAfterCarry ?? summaryVariant?.yieldOnCost ?? null) : (latestProForma?.returns?.yieldOnCost ?? latestProForma?.operations?.yieldOnCost ?? null),
        projectedProfitUsd: recommendedProgram ? (summaryVariant?.profitAfterCarry ?? summaryVariant?.profit ?? null) : (latestProForma?.returns?.profit ?? null),
      },
      financialNote,
      thesis: investmentThesis || latestComparison?.recommendation?.rationale || null,
      researchSummary,
    },
    {
      slideNumber: 2,
      id: 'site-parcel-forensics',
      title: 'Site & Parcel Forensics',
      subtitle: 'Lot Geometry, Existing Bulk & Encumbrance Screening',
      parcel: property ? {
        bbl: property.bbl,
        address: property.address,
        borough: property.borough,
        ownerName: property.ownername || null,
        buildingClass: property.bldgclass || null,
        lotAreaSqft: property.lotarea,
        lotFrontageFeet: property.lotfront,
        lotDepthFeet: property.lotdepth,
        existingGrossBldgAreaSqft: existingBldgArea,
        existingBldgAreaRecorded,
        builtFar: existingBldgArea === null ? null : property.builtfar,
        residentialFar: property.residfar,
        affordableUapFar: property.affresfar,
        commercialFar: property.commfar,
        communityFacilityFar: property.facilfar,
        landmark: property.landmark || 'None (PLUTO confirmed)',
        historicDistrict: property.histdist || 'None (PLUTO confirmed)',
        specialDistrict: property.spdist1 || 'None (PLUTO confirmed)',
        eDesignation: property.edesignum || 'None',
      } : null,
      assembly: assembly ? {
        mergedBbls: assembly.bbls || (assembly.parcels || []).map(p => p.bbl),
        combinedLotAreaSqft: assembly.assembled?.totalAreaSqft ?? assembly.mergedLotAreaSqft ?? null,
      } : null,
    },
    {
      slideNumber: 3,
      id: 'zoning-and-entitlements',
      title: 'Zoning Envelope & Entitlement Pathways',
      subtitle: 'As-of-Right Bulk Controls vs. Bonus, Transfer & Discretionary Scenarios',
      envelope: envelope ? {
        district: envelope.district,
        regime: envelope.regime,
        form: envelope.form,
        maxFar: envelope.floorArea?.maxFar ?? envelope.metrics?.far ?? null,
        maxFloorAreaSqft: envelope.floorArea?.maxFloorAreaSqft ?? envelope.metrics?.floorAreaSqft ?? null,
        baseHeightMinFeet: envelope.controls?.streetWall?.minBaseHeightFeet ?? envelope.summary?.baseHeightMinFeet ?? null,
        baseHeightMaxFeet: envelope.controls?.streetWall?.maxBaseHeightFeet ?? envelope.summary?.baseHeightMaxFeet ?? null,
        maxHeightFeet: envelope.controls?.heightLimitFeet ?? envelope.summary?.maxBuildingHeightFeet ?? envelope.metrics?.heightFeet ?? null,
        maxStoreys: envelope.metrics?.storeys ?? null,
        maxUnits: envelope.density?.maxUnits ?? envelope.summary?.maxDwellingUnits ?? null,
        stoppedBy: envelope.summary?.stoppedBy ?? envelope.metrics?.stoppedBy ?? null,
      } : null,
      // The operative figure chosen by the zoning headline reconciliation, with the rows it weighed.
      zoningHeadline: headline ? {
        operativeSqft: headline.operativeFigure.valueSqft,
        basis: headline.operativeFigure.basis,
        reason: headline.operativeFigure.reason,
        rows: headline.rows.filter(r => r.label !== 'Operative figure').map(r => ({label: r.label, valueSqft: r.valueSqft ?? null, operative: r.operative ?? null, conditional: r.conditional ?? false, note: r.reason ?? null})),
      } : null,
      // Remaining floor area per use as a range: the existing building read as 85 to 100 percent of
      // PLUTO gross area, or the exact figure against a filed existing ZFA or on a vacant lot.
      capacity: envelope?.capacity ? {
        lotAreaSqft: envelope.capacity.lotAreaSqft,
        builtFloorAreaSqft: envelope.capacity.builtFloorAreaSqft,
        builtFar: envelope.capacity.builtFar,
        existingBasis: envelope.capacity.existingFloorArea?.basis ?? 'pluto_gross',
        banded: Boolean(band),
        wholeLotBound: Boolean(envelope.capacity.splitLot),
        remainingFloorAreaSqftByUse: Object.fromEntries(Object.entries(envelope.capacity.byUse || {}).map(([use, u]) => [use, u.remainingFloorAreaSqft])),
        remainingFloorAreaSqftRangeByUse: Object.fromEntries(Object.entries(envelope.capacity.byUse || {}).map(([use, u]) => [use, band
          ? {atFullGfa: band.residualByUseAt100PercentZfa[use], at85PercentGfa: band.residualByUseAt85PercentZfa[use]}
          : {atFullGfa: u.remainingFloorAreaSqft, at85PercentGfa: u.remainingFloorAreaSqft}])),
      } : null,
      entitlementScenarios: (entitlements?.scenarios || entitlements?.paths || []).slice(0, 6).map(s => ({
        name: s.name || s.title || s.id,
        mechanism: s.citation || s.mechanism || null,
        maxFar: s.maxFar ?? null,
        totalFloorAreaSqft: s.maxFloorAreaSqft ?? s.totalFloorAreaSqft ?? null,
        incrementalFloorAreaSqft: s.incrementalFloorAreaSqft ?? s.addedFloorAreaSqft ?? null,
        approvalPath: s.approvalPath || s.process || null,
      })),
    },
    {
      slideNumber: 4,
      id: 'massing-and-floorplan-audit',
      title: 'Architectural Massing & Floor-Plate Efficiency',
      subtitle: '3D Concept Geometry, Net-to-Gross Optimization & Code Audit',
      concept: latestConcept ? {
        name: latestConcept.name,
        grossFloorAreaSqft: latestConcept.metrics?.grossFloorAreaSqft ?? latestConcept.grossFloorAreaSqft ?? null,
        storeys: latestConcept.metrics?.storeys ?? latestConcept.storeys?.length ?? null,
        heightFeet: latestConcept.metrics?.heightFeet ?? null,
        far: latestConcept.metrics?.far ?? null,
        // The concept's plan, drawn on the server from its stored geometry so the deck shows the
        // building without anyone opening the interactive view first. Null for legacy records.
        planSvg: (() => { try { return conceptPlanSvg(latestConcept); } catch { return null; } })(),
        contextSourceId: latestConcept.context?.sourceId || null,
        parcelDataset: latestConcept.context?.parcel?.sourceId || null,
      } : null,
      floorplanAudit: latestAudit || (plans.length ? {
        planName: plans.at(-1).name,
        efficiency: plans.at(-1).efficiency ?? null,
      } : null),
    },
    {
      slideNumber: 5,
      id: 'market-and-unit-mix',
      title: 'Submarket Comparables & Unit Mix Program',
      subtitle: market?.submarket || 'Unit Allocation & Pricing Matrix',
      market: market ? {
        submarket: market.submarket,
        rents: market.rents || [],
        salePrices: market.salePrices || [],
        indicators: market.indicators || {},
      } : null,
      program: program ? {
        productType: program.productType,
        residentialGrossSqft: program.residentialGrossSqft,
        efficiency: program.efficiency,
        netResidentialSqft: program.netResidentialSqft,
        allocatedNetSqft: program.allocatedNetSqft ?? null,
        unallocatedNetSqft: program.unallocatedNetSqft ?? null,
        assumptions: program.assumptions || [],
        units: program.units,
        byBedrooms: program.byBedrooms || [],
        annualGrossPotentialRent: program.annualGrossPotentialRent ?? null,
        grossSellout: program.grossSellout ?? null,
      } : null,
    },
    {
      slideNumber: 6,
      id: 'pro-forma-and-feasibility',
      title: 'Development Pro Forma & Program Comparison',
      subtitle: 'Capital Budget, Stabilized NOI / Sellout & Risk-Adjusted Returns',
      proForma: latestProForma,
      comparison: latestComparison,
      // The user's saved underwriting assumptions: inputs not set here use the pro forma defaults.
      assumptions: assumptions ? {values: assumptions, savedAt: projectState.assumptions?.updated ? new Date(projectState.assumptions.updated).toISOString() : null} : null,
    },
    {
      slideNumber: 7,
      id: 'verification-and-risks',
      title: 'Diligence Risks, Next Steps & Verification Trail',
      subtitle: 'Conditions Precedent, Execution Steps & Primary Sources',
      keyRisks: keyRisks.length ? keyRisks : [
        'Verify exact DOB Zoning Floor Area (ZFA) vs. DOF PLUTO Gross Floor Area (GFA) via an architect’s ZD1 / Certificate of Occupancy audit.',
        'Confirm street widths (narrow < 75 ft vs. wide >= 75 ft) and corner/interior tax-map lot boundaries on an official survey.',
        'Confirm Phase I/II environmental (CEQR E-Designation / OER) and geotechnical/flood elevation conditions prior to closing.',
      ],
      nextSteps: nextSteps.length ? nextSteps : [
        'Commission licensed zoning & code architect to prepare schematic massing and DOB pre-consideration / ZRD1.',
        'Order title report, ACRIS covenant/easement search, and ALTA land survey.',
        'Lock construction cost estimate and debt/equity term sheets against the sensitivity matrix.',
      ],
      sources: allSources.slice(),
    },
  ];

  const sectionFields = [Object.keys(REPORT_FIELDS), ['property', 'assembly'], ['envelope', 'entitlements'],
    ['concepts', 'plans', 'floorplanAudits'], ['market', 'program'], ['proFormas', 'comparisons', 'assumptions'], []];
  for (const [i, slide] of slides.entries()) slide.freshnessWarnings = freshnessWarnings.filter((warning) => sectionFields[i].includes(warning.field));

  return {
    title: deckTitle,
    subjectLabel,
    generatedDate,
    slideCount: slides.length,
    slides,
    sources: allSources,
    freshnessWarnings,
  };
}

// Rows with no recorded value are dropped, so tables only show what the state holds.
const cell = (value, cls) => `<td${cls ? ` class="${cls}"` : ''}>${value}</td>`;
function factTable(caption, rows) {
  const kept = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!kept.length) return '';
  const units = kept.some(([, , unit]) => unit);
  return `<table class="facts">
        <caption>${esc(caption)}</caption>
        <tbody>${kept.map(([label, value, unit = '', text = false]) => `
          <tr><th scope="row">${esc(label)}</th>${cell(esc(value), text ? 'val' : 'num')}${units ? cell(esc(unit), 'unit') : ''}</tr>`).join('')}
        </tbody>
      </table>`;
}
function gridTable(caption, columns, rows) {
  if (!rows.length) return '';
  return `<div class="table-scroll"><table class="grid">
        <caption>${esc(caption)}</caption>
        <thead><tr>${columns.map(c => `<th scope="col"${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `
          <tr>${r.map((v, i) => `<td${columns[i].num ? ' class="num"' : ''} data-label="${esc(columns[i].label)}">${esc(v ?? 'n/a')}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table></div>`;
}
const emptyNote = text => `<p class="empty">${esc(text)}</p>`;
const USE_LABELS = {residential: 'Residential', commercial: 'Commercial', communityFacility: 'Community facility (qualifying program only)', residentialAffordableOrUap: 'Residential with affordable bonus'};
// A remaining-area range reads low to high: the existing building at 100 percent, then 85 percent, of gross area.
const sqftRange = ({atFullGfa, at85PercentGfa}) => (fmtNum(atFullGfa) === fmtNum(at85PercentGfa) ? fmtNum(atFullGfa) : `${fmtNum(atFullGfa)} to ${fmtNum(at85PercentGfa)}`);
function unusedCaption(cap) {
  const basis = cap.existingBasis === 'dob_filed_zfa' ? 'against the existing zoning floor area filed with DOB'
    : cap.existingBasis === 'unknown' ? 'existing floor area not recorded'
    : cap.banded ? 'existing building read as 100 to 85 percent of PLUTO gross area' : cap.builtFloorAreaSqft > 0 ? 'existing building at PLUTO gross area' : 'vacant lot';
  return `Unused floor area (${basis}${cap.wholeLotBound ? '; split lot, each use as if the whole lot were in one district' : ''})`;
}
const ASSUMPTION_ROWS = [
  ['Land price', a => fmtUsd(a.landPrice)], ['Hard cost per sq ft', a => fmtUsd(a.hardCostPerSqft)], ['Soft cost per sq ft', a => fmtUsd(a.softCostPerSqft)],
  ['Cap rate', a => fmtPct(a.capRate)], ['Selling costs', a => fmtPct(a.sellingCostRate)],
  ['Loan to cost', a => fmtPct(a.financing?.loanToCost)], ['Interest rate', a => fmtPct(a.financing?.interestRate)], ['Loan term', a => fmtNum(a.financing?.termMonths), 'months'],
  ['Residential vacancy', a => fmtPct(a.operating?.residentialVacancyRate)], ['Residential operating expense per unit per year', a => fmtUsd(a.operating?.residentialOpexPerUnitPerYear)],
  ['Commercial vacancy', a => fmtPct(a.operating?.commercialVacancyRate)], ['Commercial operating expense per sq ft per year', a => fmtUsd(a.operating?.commercialOpexPerSqftPerYear)],
];
const longDate = iso => new Date(iso).toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});
const freshnessNote = (warnings = []) => warnings.length ? `<aside class="freshness-note" aria-label="Analysis needs refresh"><h3>Analysis needs refresh</h3><ul>${warnings.map(warning => `<li>${esc(warning.message)}</li>`).join('')}</ul><p>Refresh the affected analysis before relying on these findings.</p></aside>` : '';
const cssString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3C ').replace(/\s+/g, ' ')}"`;
const shorten = (s, max) => (s.length <= max ? s : `${s.slice(0, s.lastIndexOf(' ', max) > max / 2 ? s.lastIndexOf(' ', max) : max)}…`);

// The stepped-parcel mark, drawn in the current text color on a transparent ground.
const AROSA_MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="currentColor"/><path d="M8 24h4v-5h8v5h4V14h-4v-4h-4V6h-4v4H8z" fill="#161616"/></svg>';

export function renderDeckHtml(deck) {
  const [s1 = {}, s2 = {}, s3 = {}, s4 = {}, s5 = {}, s6 = {}, s7 = {}] = deck.slides;
  const m = s1.metrics || {};
  const p = s2.parcel || {};
  const env = s3.envelope || {};
  const prog = s5.program || {};
  const pf = s6.proForma || {};
  const dev = pf.development || pf.costs || {};
  const ops = pf.operations || null;
  const sales = pf.sales || null;
  const ret = pf.returns || {};
  const devCost = pf.development?.totalDevelopmentCost ?? pf.costs?.totalDevelopmentCost ?? null;
  const noi = ops?.noi ?? ops?.netOperatingIncome ?? ret.netOperatingIncome ?? null;
  const yoc = ret.yieldOnCost ?? ops?.yieldOnCost ?? null;
  const profit = ret.profit ?? null;
  const runningTitle = shorten(deck.title, 72);
  const pageCount = 7;

  const keyFacts = [
    ['Zoning district', m.zoningDistrict],
    ['Lot area', fmtNum(m.lotAreaSqft) && `${fmtNum(m.lotAreaSqft)} sq ft`],
    ['Existing floor area', m.existingBldgAreaRecorded === false ? 'Not recorded in PLUTO' : fmtNum(m.existingBldgAreaSqft) && `${fmtNum(m.existingBldgAreaSqft)} sq ft`],
    [m.recommendedProgram ? 'Recommended program' : 'Analyzed program', m.recommendedProgram || m.financialProgram],
    ['Total development cost', fmtUsd(m.totalDevelopmentCostUsd)],
    ['Yield on cost', fmtPct(m.yieldOnCost)],
    ['Projected profit', fmtUsd(m.projectedProfitUsd)],
  ].filter(([, v]) => v);

  const audit = s4.floorplanAudit?.summaryMetrics || null;
  // Only this module's own generated SVG is inlined raw; anything else is dropped, not trusted.
  const planFigureSvg = typeof s4.concept?.planSvg === 'string' && s4.concept.planSvg.startsWith('<svg class="concept-plan-svg"') ? s4.concept.planSvg : null;
  const comparison = s6.comparison || null;
  const variants = comparison?.variants || [];

  const page = (n, s, body) => `
    <section class="page" id="${esc(s.id)}" aria-labelledby="${esc(s.id)}-title">
      <header class="page-head" aria-hidden="true"><span>${esc(runningTitle)}</span><span>${esc(deck.generatedDate)}</span></header>
      <div class="section-head">
        <span class="section-num" aria-hidden="true">${String(n).padStart(2, '0')}</span>
        <h2 class="section-title" id="${esc(s.id)}-title">${esc(s.title)}</h2>
        ${s.subtitle ? `<p class="section-sub">${esc(s.subtitle)}</p>` : ''}
      </div>
      ${freshnessNote(s.freshnessWarnings)}
      ${body}
      <footer class="page-foot" aria-hidden="true"><span>Arosa</span><span>Page ${n} of ${pageCount}</span></footer>
    </section>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${esc(deck.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
  <style>
    :root {
      --font: 'Geist', 'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif;
      --mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      --desk: #e7e7e7;
      --paper: #ffffff;
      --ink: #161616;
      --muted: #5c5c5c;
      --faint: #767676;
      --rule: #dedede;
      --wash: #f4f4f4;
      --accent: #161616;
      --warn: #8a6d00;
      --fs-xs: 0.71875rem;
      --fs-sm: 0.8125rem;
      --fs-base: 0.9375rem;
      --fs-md: 1.125rem;
      --fs-lg: 1.5rem;
      --fs-xl: clamp(2rem, 1.3rem + 2.8vw, 3rem);
      --space-1: 0.25rem;
      --space-2: 0.5rem;
      --space-3: 0.75rem;
      --space-4: 1rem;
      --space-5: 1.5rem;
      --space-6: 2rem;
      --space-7: 3rem;
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --desk: #111111;
        --paper: #1b1b1b;
        --ink: #f2f2f2;
        --muted: #b5b5b5;
        --faint: #9a9a9a;
        --rule: #383838;
        --wash: #242424;
        --accent: #f2f2f2;
        --warn: #d9b45c;
      }
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      font-family: var(--font);
      font-size: var(--fs-base);
      line-height: 1.55;
      color: var(--ink);
      background: var(--desk);
      font-variant-numeric: lining-nums;
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3, p, ol, ul, dl, dd, figure { margin: 0; }
    a { color: var(--ink); text-underline-offset: 2px; text-decoration-thickness: 1px; text-decoration-color: var(--faint); }

    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-3) var(--space-5);
      background: #161616;
      color: #f2f2f2;
      font-size: var(--fs-sm);
    }
    .toolbar-title { display: flex; align-items: center; gap: var(--space-3); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b8b8b8; }
    .toolbar-title strong { color: #ffffff; font-weight: 600; }
    .mark { flex: none; display: block; width: 22px; height: 22px; }
    .print-btn {
      flex: none;
      font: inherit;
      font-weight: 600;
      color: #161616;
      background: #ffffff;
      border: 0;
      border-radius: 999px;
      padding: var(--space-2) var(--space-4);
      cursor: pointer;
    }
    .print-btn:hover { background: #e4e4e4; }
    .print-btn:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }

    .pages {
      display: grid;
      justify-items: center;
      gap: var(--space-6);
      padding: var(--space-6) var(--space-4) var(--space-7);
    }
    .page {
      width: min(100%, 8.5in);
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-5) var(--space-4);
      background: var(--paper);
      border-radius: 3px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px -14px rgba(0, 0, 0, 0.22);
      min-width: 0;
    }
    .page > * { min-width: 0; }
    .page-head, .page-foot {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      font-size: var(--fs-xs);
      color: var(--faint);
      letter-spacing: 0.01em;
    }
    .page-head { padding-bottom: var(--space-3); border-bottom: 1px solid var(--rule); overflow-wrap: anywhere; }
    .page-head span:last-child, .page-foot span:last-child { flex: none; font-family: var(--mono); }
    .page-foot { margin-top: auto; padding-top: var(--space-3); border-top: 1px solid var(--rule); }

    .section-head { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--space-4); row-gap: var(--space-1); align-items: baseline; padding-bottom: var(--space-4); border-bottom: 2px solid var(--ink); }
    .section-num { grid-row: span 2; font: 500 var(--fs-sm)/1 var(--mono); color: var(--faint); }
    .section-title { font-size: var(--fs-lg); line-height: 1.15; font-weight: 600; letter-spacing: -0.025em; text-wrap: balance; }
    .section-sub { color: var(--muted); font-size: var(--fs-sm); }
    .block { display: grid; gap: var(--space-3); }
    .block h3 { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }

    .cover { display: grid; gap: var(--space-4); margin: calc(var(--space-5) * -1) calc(var(--space-4) * -1) 0; padding: var(--space-6) var(--space-4) var(--space-6); background: #161616; color: #ffffff; border-radius: 3px 3px 0 0; }
    .cover-brand { display: flex; align-items: center; gap: var(--space-2); font-weight: 600; font-size: var(--fs-base); letter-spacing: -0.01em; }
    .cover-brand .mark { width: 26px; height: 26px; }
    .kicker { margin-top: var(--space-6); font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: #a8a8a8; }
    .cover-title { font-size: var(--fs-xl); line-height: 1.04; font-weight: 600; letter-spacing: -0.035em; text-wrap: balance; overflow-wrap: anywhere; }
    .cover-meta { color: #a8a8a8; font-size: var(--fs-sm); font-family: var(--mono); }
    .page:first-child > .page-head { display: none; }
    .lede { font-size: var(--fs-md); line-height: 1.55; max-width: 62ch; text-wrap: pretty; }

    .key-facts {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0;
      border: 1px solid var(--rule);
      border-radius: 6px;
      overflow: hidden;
    }
    .key-facts div { display: grid; gap: var(--space-1); align-content: start; padding: var(--space-4); border-right: 1px solid var(--rule); border-bottom: 1px solid var(--rule); margin: 0 -1px -1px 0; }
    .key-facts dt { font-size: var(--fs-xs); color: var(--muted); letter-spacing: 0.02em; }
    .key-facts dd { font: 600 var(--fs-md)/1.25 var(--font); letter-spacing: -0.01em; font-variant-numeric: tabular-nums lining-nums; overflow-wrap: anywhere; }

    .tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr)); gap: var(--space-5) var(--space-6); align-items: start; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums lining-nums; }
    caption { caption-side: top; text-align: left; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding-bottom: var(--space-2); }
    th, td { padding: 0.4rem var(--space-3); border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; overflow-wrap: break-word; }
    th:first-child, td:first-child { padding-left: 0; }
    th:last-child, td:last-child { padding-right: 0; }
    thead th { font-size: var(--fs-xs); font-weight: 500; color: var(--muted); vertical-align: bottom; border-bottom: 1px solid var(--ink); }
    .facts th { font-weight: 400; color: var(--muted); }
    .facts tr:first-child > * { border-top: 1px solid var(--ink); }
    .num { text-align: right; white-space: nowrap; font-family: var(--mono); font-size: 0.95em; }
    .val { text-align: right; }
    .facts .num, .facts .val { font-weight: 500; }
    .unit { width: 1%; padding-left: var(--space-2); color: var(--faint); white-space: nowrap; font-size: var(--fs-xs); }
    .grid td:first-child { font-weight: 600; }
    .grid tbody tr:nth-child(even) td { background: var(--wash); }
    .grid th, .grid td { padding-inline: 0.4rem; }
    .grid :is(th, td):last-child { padding-right: 0; }
    .grid .num { font-family: var(--font); font-size: inherit; }
    .grid th.num { white-space: normal; }
    .grid :is(th, td):first-child { padding-left: 0; }
    .facts th { min-width: 7rem; }

    .concept-plan { display: grid; gap: var(--space-2); }
    .concept-plan-svg { width: 100%; height: auto; max-height: 4.6in; border: 1px solid var(--rule); }
    .concept-plan figcaption { font-size: var(--fs-xs); color: var(--muted); max-width: 72ch; }
    .note { font-size: var(--fs-sm); color: var(--muted); max-width: 70ch; }
    .note strong { font-weight: 600; color: var(--ink); }
    .freshness-note { display: grid; gap: var(--space-2); padding: var(--space-3) var(--space-4); border: 1px solid #d9c98a; border-radius: 6px; background: #fbf7e8; color: #161616; font-size: var(--fs-sm); }
    .freshness-note h3 { font-size: var(--fs-sm); font-weight: 600; color: #8a6d00; }
    .freshness-note ul { display: grid; gap: var(--space-1); padding-left: 1.2em; }
    .empty { color: var(--muted); font-size: var(--fs-sm); max-width: 62ch; padding: var(--space-3) var(--space-4); border: 1px dashed var(--rule); border-radius: 6px; }
    .points { display: grid; gap: var(--space-2); padding-left: 1.2em; max-width: 72ch; }
    .points li::marker { color: var(--faint); }

    .sources { display: grid; gap: 0; padding-left: 0; list-style: none; counter-reset: src; }
    .sources li { display: grid; grid-template-columns: 2.25rem minmax(0, 1fr); counter-increment: src; padding: var(--space-3) 0; border-top: 1px solid var(--rule); }
    .sources li::before { content: counter(src, decimal-leading-zero); font: 500 var(--fs-xs)/1.6 var(--mono); color: var(--faint); }
    .src { display: grid; gap: 0.125rem; min-width: 0; }
    .src-title { font-size: var(--fs-sm); font-weight: 600; overflow-wrap: anywhere; }
    .src-domain { font-size: var(--fs-xs); color: var(--muted); }
    .src a { font: var(--fs-xs)/1.5 var(--mono); color: var(--muted); overflow-wrap: anywhere; word-break: break-word; }

    @media (min-width: 900px) {
      .page { min-height: 11in; padding: 0.6in 0.75in 0.45in; }
      .cover { margin: -0.6in -0.75in 0; padding: 0.6in 0.75in 0.55in; }
    }
    @media (max-width: 640px) {
      .key-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      table.grid thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      table.grid, table.grid caption, table.grid tbody, table.grid tr, table.grid td { display: block; }
      table.grid tr { padding-block: var(--space-2); border-bottom: 1px solid var(--rule); }
      table.grid tr:first-child { border-top: 1px solid var(--ink); }
      table.grid tbody tr:nth-child(even) td { background: none; }
      table.grid td { min-width: 0; display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-1) 0; border: 0; text-align: right; white-space: normal; }
      table.grid td::before { content: attr(data-label); color: var(--muted); text-align: left; font-weight: 400; font-family: var(--font); }
      table.grid td:first-child { padding-bottom: var(--space-2); }
    }

    @page {
      size: Letter;
      margin: 0.7in 0.7in 0.75in;
      @top-left { content: ${cssString(runningTitle)}; font-family: var(--font); font-size: 7.5pt; color: #767676; }
      @top-right { content: ${cssString(deck.generatedDate)}; font-family: var(--font); font-size: 7.5pt; color: #767676; }
      @bottom-left { content: "Arosa"; font-family: var(--font); font-size: 7.5pt; color: #767676; }
      @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: var(--font); font-size: 7.5pt; color: #767676; }
    }
    @page :first { @top-left { content: none; } @top-right { content: none; } }
    @media print {
      html { font-size: 10.5pt; }
      :root { --fs-xl: 2.75rem; }
      body { background: var(--paper); }
      .toolbar, .page-head, .page-foot { display: none; }
      .pages { display: block; justify-items: normal; padding: 0; }
      .page { width: auto; min-height: 0; padding: 0; box-shadow: none; border-radius: 0; break-after: page; }
      .page:last-child { break-after: auto; }
      .cover { margin: 0 0 var(--space-2); padding: 0.45in 0.4in 0.4in; border-radius: 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .grid tbody tr:nth-child(even) td, .freshness-note { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .section-head, caption, h3 { break-after: avoid; }
      tr, .key-facts div, .sources li { break-inside: avoid; }
      thead { display: table-header-group; }
      th, td { padding-block: 0.3rem; }
      .page { gap: var(--space-4); }
      a { color: var(--ink); text-decoration: none; }
      .table-scroll { overflow: visible; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">${AROSA_MARK}<span><strong>Arosa</strong> underwriting package, ${esc(deck.generatedDate)}</span></div>
    <button class="print-btn" type="button" onclick="window.print()">Print or save PDF</button>
  </div>
  <main class="pages">
    <section class="page" id="${esc(s1.id)}" aria-labelledby="cover-title">
      <header class="page-head" aria-hidden="true"><span>${esc(runningTitle)}</span><span>${esc(deck.generatedDate)}</span></header>
      <div class="cover">
        <p class="cover-brand">${AROSA_MARK}Arosa</p>
        <p class="kicker">Feasibility and underwriting package</p>
        <h1 class="cover-title" id="cover-title">${esc(deck.subjectLabel)}</h1>
        <p class="cover-meta">Prepared ${esc(deck.generatedDate)}</p>
      </div>
      <div class="block">
        <h2 class="section-title">${esc(s1.title)}</h2>
        ${s1.thesis ? `<p class="lede">${esc(plainText(s1.thesis))}</p>` : ''}
      </div>
      ${s1.researchSummary ? `<div class="block research-summary">
        <h3>${s1.researchSummary.contextStatus === 'current' ? 'Research summary' : 'Earlier research'}</h3>
        <p class="note">Completed <time datetime="${esc(new Date(s1.researchSummary.completedAt).toISOString())}">${esc(new Date(s1.researchSummary.completedAt).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'long',day:'numeric',year:'numeric'}))}</time></p>
        <p>${esc(s1.researchSummary.text)}</p>
        ${s1.researchSummary.contextStatus === 'unverified' ? '<p class="note">This answer is retained from the conversation. Its match to the current site inputs is unverified.</p>' : ''}
      </div>` : !s1.thesis ? emptyNote('No research summary has been recorded for the current site inputs.') : ''}
      ${freshnessNote(s1.freshnessWarnings)}
      ${s1.financialNote ? `<p class="note financial-note">${esc(s1.financialNote)}</p>` : ''}
      ${keyFacts.length ? `<dl class="key-facts">${keyFacts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : ''}
      <footer class="page-foot" aria-hidden="true"><span>Arosa</span><span>Page 1 of ${pageCount}</span></footer>
    </section>
${page(2, s2, s2.parcel ? `<div class="tables">
      ${factTable('Parcel record', [
        ['BBL', p.bbl, '', true],
        ['Address', p.address, '', true],
        ['Borough', p.borough, '', true],
        ['Owner of record', p.ownerName, '', true],
        ['Building class', p.buildingClass, '', true],
        ['Lot area', fmtNum(p.lotAreaSqft), 'sq ft'],
        ['Lot frontage', fmtNum(p.lotFrontageFeet), 'ft'],
        ['Lot depth', fmtNum(p.lotDepthFeet), 'ft'],
        p.existingBldgAreaRecorded === false ? ['Existing floor area', 'Not recorded in PLUTO', '', true] : ['Existing floor area', fmtNum(p.existingGrossBldgAreaSqft), 'sq ft'],
      ])}
      ${factTable('Floor area ratios', [
        ['Built', fmtFixed(p.builtFar), 'FAR'],
        ['Residential', fmtFixed(p.residentialFar), 'FAR'],
        ['Affordable (UAP)', fmtFixed(p.affordableUapFar), 'FAR'],
        ['Commercial', fmtFixed(p.commercialFar), 'FAR'],
        ['Community facility', fmtFixed(p.communityFacilityFar), 'FAR'],
      ])}
      ${factTable('Encumbrance screen', [
        ['Landmark', p.landmark, '', true],
        ['Historic district', p.historicDistrict, '', true],
        ['Special district', p.specialDistrict, '', true],
        ['CEQR E-designation', p.eDesignation, '', true],
      ])}
      ${s2.assembly ? factTable('Assemblage', [
        ['Merged lots', (s2.assembly.mergedBbls || []).filter(Boolean).join(', '), '', true],
        ['Combined lot area', fmtNum(s2.assembly.combinedLotAreaSqft), 'sq ft'],
      ]) : ''}
    </div>` : emptyNote('No parcel record has been selected for this site yet.'))}
${page(3, s3, `${s3.envelope ? `<div class="tables">
      ${s3.zoningHeadline ? factTable('Headline zoning floor area', [
        ...s3.zoningHeadline.rows.map(r => [r.operative === false && r.valueSqft !== null ? `${r.label}, context only` : r.label, fmtNum(r.valueSqft), 'sq ft']),
        ['Operative figure', fmtNum(s3.zoningHeadline.operativeSqft), 'sq ft'],
      ]) : ''}
      ${factTable('As-of-right envelope', [
        ['District', env.district, '', true],
        ['Regime', env.regime, '', true],
        ['Building form', env.form, '', true],
        ['Maximum FAR', fmtFixed(env.maxFar), 'FAR'],
        ['Maximum zoning floor area', fmtNum(env.maxFloorAreaSqft), 'sq ft'],
        ['Street wall base height', fmtNum(env.baseHeightMinFeet) && fmtNum(env.baseHeightMaxFeet) ? `${fmtNum(env.baseHeightMinFeet)} to ${fmtNum(env.baseHeightMaxFeet)}` : fmtNum(env.baseHeightMaxFeet), 'ft'],
        ['Maximum building height', fmtNum(env.maxHeightFeet), 'ft'],
        ['Maximum storeys', fmtNum(env.maxStoreys), 'floors'],
        ['Maximum dwelling units', fmtNum(env.maxUnits), 'units'],
        ['Binding constraint', env.stoppedBy, '', true],
      ])}
      ${s3.capacity ? factTable(unusedCaption(s3.capacity), Object.entries(s3.capacity.remainingFloorAreaSqftRangeByUse || {}).map(([use, range]) => [USE_LABELS[use] || use, sqftRange(range), 'sq ft'])) : ''}
    </div>
      ${s3.zoningHeadline?.reason ? `<p class="note">${esc(s3.zoningHeadline.reason)}</p>` : ''}
      ${s3.capacity?.banded ? '<p class="note">PLUTO gross building area is not zoning floor area; an architect\'s ZD1 or certificate of occupancy audit sets the existing zoning floor area within this range.</p>' : ''}` : emptyNote('No zoning envelope has been modeled for this site yet.')}
      ${gridTable('Entitlement scenarios', [
        {label: 'Scenario'}, {label: 'Mechanism'}, {label: 'Max FAR', num: true}, {label: 'Total floor area (sq ft)', num: true}, {label: 'Approval path'},
      ], (s3.entitlementScenarios || []).map(sc => [sc.name, sc.mechanism, fmtFixed(sc.maxFar), fmtNum(sc.totalFloorAreaSqft), sc.approvalPath]))}`)}
${page(4, s4, (s4.concept || s4.floorplanAudit) ? `${planFigureSvg ? `<figure class="concept-plan">
        ${planFigureSvg}
        <figcaption>Concept plan${s4.concept.name ? `: ${esc(s4.concept.name)}` : ''}. This drawing illustrates a feasibility hypothesis, not an entitlement, survey, or construction document.${s4.concept.parcelDataset ? ` Green dash-dot outline: recorded NYC tax lot (${esc(s4.concept.parcelDataset)}), not necessarily the zoning lot.` : ''}${s4.concept.contextSourceId ? ` Surrounding buildings from NYC building footprints (${esc(s4.concept.contextSourceId)}); placement is approximate.` : ''}</figcaption>
      </figure>` : ''}<div class="tables">
      ${s4.concept ? factTable(s4.concept.name ? `Massing concept: ${s4.concept.name}` : 'Massing concept', [
        ['Gross floor area', fmtNum(s4.concept.grossFloorAreaSqft), 'sq ft'],
        ['Storeys', fmtNum(s4.concept.storeys), 'floors'],
        ['Height', fmtNum(s4.concept.heightFeet), 'ft'],
        ['Modeled FAR', fmtFixed(s4.concept.far), 'FAR'],
      ]) : ''}
      ${audit ? factTable('Floor plate efficiency', [
        ['Gross floor area', fmtNum(audit.grossFloorAreaSqft), 'sq ft'],
        ['Current efficiency', fmtPctPoints(audit.currentEfficiencyPercent), ''],
        ['Benchmark target', fmtPctPoints(audit.targetBenchmarkEfficiencyPercent), ''],
        ['Illustrative area gain to benchmark', fmtNum(audit.recoverableNetSqft), 'sq ft'],
      ]) : s4.floorplanAudit ? factTable('Floor plan', [
        ['Plan', s4.floorplanAudit.planName, '', true],
        ['Net to gross efficiency', fmtPct(s4.floorplanAudit.efficiency), ''],
      ]) : ''}
    </div>` : emptyNote('No massing concept or floor plan has been recorded for this site yet.'))}
${page(5, s5, s5.program ? `${factTable('Residential program', [
        ['Product type', prog.productType, '', true],
        ['Residential gross area', fmtNum(prog.residentialGrossSqft), 'sq ft'],
        ['Net to gross efficiency', fmtPct(prog.efficiency), ''],
        ['Net residential area', fmtNum(prog.netResidentialSqft), 'sq ft'],
        ['Allocated net residential area', fmtNum(prog.allocatedNetSqft), 'sq ft'],
        ['Unallocated net residential area', fmtNum(prog.unallocatedNetSqft), 'sq ft'],
        ['Dwelling units', fmtNum(prog.units), 'units'],
        ['Annual gross potential rent', fmtUsd(prog.annualGrossPotentialRent), ''],
        ['Gross sellout', fmtUsd(prog.grossSellout), ''],
      ])}
      ${Number.isFinite(prog.allocatedNetSqft) && Number.isFinite(prog.netResidentialSqft) && prog.allocatedNetSqft > prog.netResidentialSqft ? '<p class="note">The saved apartment allocation exceeds the recorded net residential area. Recompute the unit mix before using these figures.</p>' : ''}
      ${prog.assumptions.length ? `<ul class="points note">${prog.assumptions.map(note => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
      ${gridTable('Unit mix and pricing', [
        {label: 'Unit type'}, {label: 'Target mix', num: true}, {label: 'Units', num: true}, {label: 'Net sq ft per unit', num: true}, {label: 'Total net sq ft', num: true}, {label: 'Rate per sq ft', num: true}, {label: 'Per unit', num: true},
      ], (prog.byBedrooms || []).map(b => [
        b.label, fmtPctPoints(b.mixPercent), fmtNum(b.units), fmtNum(b.unitSqft), fmtNum(b.netSqft),
        b.rentPerSqftPerMonth ? `$${fmtFixed(b.rentPerSqftPerMonth)}/mo` : b.pricePerSqft ? fmtUsd(b.pricePerSqft) : null,
        b.rentPerSqftPerMonth ? (fmtUsd(b.monthlyRent) && `${fmtUsd(b.monthlyRent)}/mo`) : fmtUsd(b.unitPrice),
      ]))}` : emptyNote('No unit mix has been programmed for this site yet.'))}
${page(6, s6, `${s6.assumptions ? `<div class="tables">${factTable(`Underwriting assumptions${s6.assumptions.savedAt ? `, saved ${longDate(s6.assumptions.savedAt)}` : ''}`, ASSUMPTION_ROWS.map(([label, value, unit = '']) => [label, value(s6.assumptions.values), unit]))}</div>
      <p class="note">Inputs not listed use the pro forma defaults.</p>` : ''}
      ${s6.proForma ? `<p class="note">Financial model: ${esc(pf.name || pf.productType || 'Unnamed program')}</p><div class="tables">
      ${factTable('Capital budget', [
        ['Land', fmtUsd(dev.landPrice), ''],
        ['Hard cost', fmtUsd(dev.hardCost), ''],
        ['Soft cost', fmtUsd(dev.softCost), ''],
        ['Financing carry', fmtUsd(dev.interestCarry), ''],
        ['Total development cost', fmtUsd(devCost), ''],
        ['Cost per gross sq ft', fmtUsd(dev.costPerGrossSqft), ''],
        ['Equity', fmtUsd(dev.equity), ''],
      ])}
      ${ops ? factTable('Stabilized operations', [
        ['Gross potential rent', fmtUsd(ops.grossPotentialRent), ''],
        ['Vacancy loss', fmtUsd(ops.vacancyLoss), ''],
        ['Effective gross income', fmtUsd(ops.effectiveGrossIncome), ''],
        ['Operating expenses', fmtUsd(ops.operatingExpenses), ''],
        ['Real estate taxes', fmtUsd(ops.realEstateTaxes), ''],
        ['Net operating income', fmtUsd(noi), ''],
        ['Cap rate', fmtPct(ops.capRate), ''],
      ]) : ''}
      ${sales ? factTable('Sellout', [
        ['Gross sellout', fmtUsd(sales.grossSellout), ''],
        ['Selling costs', fmtUsd(sales.sellingCosts), ''],
        ['Net sellout', fmtUsd(sales.netSellout), ''],
      ]) : ''}
      ${factTable('Returns', [
        ['Exit value', fmtUsd(ret.value), ''],
        ['Projected profit', fmtUsd(profit), ''],
        ['Yield on cost', fmtPct(yoc), ''],
        ['Unlevered return on cost', fmtPct(ret.unleveredReturnOnCost), ''],
        ['Levered return on equity', fmtPct(ret.leveredReturnOnEquity), ''],
        ['Equity multiple', fmtFixed(ret.equityMultiple) && `${fmtFixed(ret.equityMultiple)}x`, ''],
        ['Margin on revenue', fmtPct(ret.marginOnRevenue), ''],
      ])}
    </div>` : ''}
      ${gridTable('Program comparison', [
        {label: 'Program'}, {label: comparison?.rankingBasis ? 'Development cost including approval carry' : 'Development cost', num: true}, {label: 'NOI or net sellout', num: true}, {label: 'Profit', num: true}, {label: comparison?.rankingBasis ? 'Profit after approval carry' : 'Risk-adjusted profit', num: true}, {label: 'Profit if rents/prices fall 10%', num: true}, {label: comparison?.rankingBasis ? 'Downside profit after approval carry' : 'Risk-adjusted downside profit', num: true}, {label: 'Entitlement risk'},
      ], variants.map(v => [v.label, fmtUsd(comparison?.rankingBasis ? v.totalDevelopmentCostAfterCarry : v.totalDevelopmentCost), fmtUsd(v.noi ?? v.netSellout), fmtUsd(v.profit), fmtUsd(comparison?.rankingBasis ? v.profitAfterCarry : v.riskAdjustedProfit), fmtUsd(v.downsideRentMinus10Profit), fmtUsd(comparison?.rankingBasis ? v.downsideProfitAfterCarry : v.downsideRiskAdjustedProfit), v.entitlementRiskTier]))}
      ${comparison?.rubric ? `<p class="note">${esc(comparison.rubric)}</p>` : ''}
      ${comparison?.recommendation?.label ? `<div class="block">
        <p class="note"><strong>Recommended program:</strong> ${esc(comparison.recommendation.label)}${fmtUsd(comparison?.rankingBasis ? comparison.recommendation.profitAfterCarry : comparison.recommendation.riskAdjustedProfit) ? `, with ${esc(fmtUsd(comparison?.rankingBasis ? comparison.recommendation.profitAfterCarry : comparison.recommendation.riskAdjustedProfit))} of ${comparison?.rankingBasis ? 'profit after approval carry' : 'risk-adjusted profit'}.` : '.'}</p>
        ${(comparison.recommendation.whatWouldChangeIt || []).length ? `<ul class="points note">${comparison.recommendation.whatWouldChangeIt.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}
      ${!s6.proForma && !variants.length ? emptyNote('No pro forma has been run for this site yet.') : ''}`)}
${page(7, s7, `<div class="block">
        <h3>Key risks and conditions precedent</h3>
        <ul class="points">${(s7.keyRisks || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>
      <div class="block">
        <h3>Next steps</h3>
        <ol class="points">${(s7.nextSteps || []).map(r => `<li>${esc(r)}</li>`).join('')}</ol>
      </div>
      <div class="block">
        <h3>Primary statutory, municipal and market sources</h3>
        ${(s7.sources || []).length ? `<ol class="sources">${s7.sources.map(src => `
          <li><div class="src">
            <span class="src-title">${esc(src.title)}</span>
            ${src.domain ? `<span class="src-domain">${esc(src.domain)}</span>` : ''}
            ${src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.url)}</a>` : ''}
          </div></li>`).join('')}
        </ol>` : emptyNote('No sources were recorded in this conversation.')}
      </div>`)}
  </main>
</body>
</html>`;
}

export const deliverableDeckDefinition = {
  name: 'acres_generate_deck',
  description: 'Compile the conversation’s persisted project state (parcel forensics, zoning envelope, entitlement scenarios, massing concepts, floor-plan efficiency audit, submarket comps, unit mix, and pro-forma returns) into a structured 7-slide Institutional Underwriting Package ready for PDF/HTML export.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: {type: 'string', description: 'Optional custom title for the underwriting package.'},
      investmentThesis: {type: 'string', description: 'Executive investment thesis and highest-and-best-use recommendation (1–3 sentences).'},
      keyRisks: {type: 'array', items: {type: 'string'}, maxItems: 8, description: 'Specific statutory, physical, or financial diligence risks to highlight on Slide 7.'},
      nextSteps: {type: 'array', items: {type: 'string'}, maxItems: 8, description: 'Specific actionable execution steps for the sponsor/architect/land-use counsel.'},
    },
  },
};

export function createDeliverableTools({getStateSnapshot = () => ({}), getSources = () => [], emit = () => {}} = {}) {
  let latestDeck = null;
  async function generateDeck(args = {}) {
    const projectState = getStateSnapshot() || {};
    const sources = getSources() || [];
    const deck = buildUnderwritingDeck({
      projectState,
      title: args.title || null,
      investmentThesis: args.investmentThesis || null,
      keyRisks: args.keyRisks || [],
      nextSteps: args.nextSteps || [],
      sources,
    });
    latestDeck = deck;
    emit('deliverable.generated', {title: deck.title, slideCount: deck.slideCount});
    return {
      ...deck,
      exportHint: 'The user opens the formatted 7-slide Institutional Underwriting package to view, print or save as PDF from the "Open deck" button under your answer, or from "Export deck" on the site page.',
    };
  }

  return {
    definitions: [deliverableDeckDefinition],
    handlers: {acres_generate_deck: generateDeck},
    get deck() { return latestDeck; },
  };
}
