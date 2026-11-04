import {providerJson} from './public-http.mjs';
import {describeDistrict, rules} from './zoning.mjs';
import {filingStage} from './ledger.mjs';
import {ZONING_LOT_DOC_TYPES} from './nycdb.mjs';

// Past NYC projects that filed more zoning floor area than their lot's standard FAR allows, with the
// public records that may explain how: the qualifying affordable FAR, zoning lot descriptions and
// air or development rights deeds (ACRIS), City Planning actions (ZAP), special districts and
// landmark status. DOB BIS states zoning floor area on NB and A1 filings; DOB NOW, which took over
// filing in 2021, publishes none, so later projects are outside this search.
const SOCRATA = id => `https://data.cityofnewyork.us/resource/${id}.json`;
export const PRECEDENT_SOURCES = {
  dobBis: SOCRATA('ic3t-wcy2'), pluto: SOCRATA('64uk-42ks'),
  acrisLegals: SOCRATA('8h5j-fqxa'), acrisMaster: SOCRATA('bnx9-e6tj'),
  zapBbl: SOCRATA('2iga-a6mk'), zapProjects: SOCRATA('hgx4-8ukb'),
};
const BOROUGHS = {1: 'MANHATTAN', 2: 'BRONX', 3: 'BROOKLYN', 4: 'QUEENS', 5: 'STATEN ISLAND'};
const CANDIDATE_CAP = 500;
const EXPLAIN_BATCH = 4;
// A filed area more than this multiple of the lot's highest FAR is a zoning lot spanning other tax lots
// or an entry error, not a precedent to rank; such filings are listed apart as outliers.
const OUTLIER_MULTIPLE = 3;
const round = (n, d = 0) => Number(n.toFixed(d));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const mdy = text => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(text || '')); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const bblOf = r => String(r.bbl || '').split('.')[0];
const quote = v => `'${String(v).replace(/'/g, "''")}'`;
const url = (base, params) => { const u = new URL(base); Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v)); return u; };

// The largest standard FAR a district allows for any use, from the curated table when the district is
// curated; the residential equivalent stands in for a commercial district's residential FAR.
export function curatedStandardFar(code) {
  const d = describeDistrict(code);
  if (!d || !['residential', 'commercial', 'manufacturing'].includes(d.kind)) return null;
  const equivalent = d.residentialEquivalent ? rules.districts[d.residentialEquivalent] : null;
  return Math.max(d.farResidential ?? equivalent?.farResidential ?? 0, d.farCommercial ?? 0, d.farCommunityFacility ?? 0) || null;
}

// The base a filing is measured against: today's standard FAR for the district it was filed under.
// PLUTO's own FARs serve when the lot is still in that district; the curated table serves a district
// the lot has since left; otherwise PLUTO's current FAR stands and the filing is marked as rezoned.
export function baseFarFor(filingDistrict, pluto) {
  const plutoFar = Math.max(num(pluto.residfar) ?? 0, num(pluto.commfar) ?? 0, num(pluto.facilfar) ?? 0) || null;
  const same = String(pluto.zonedist1 || '').toUpperCase() === String(filingDistrict || '').toUpperCase();
  if (same && plutoFar) return {far: plutoFar, basis: 'pluto'};
  const curated = filingDistrict ? curatedStandardFar(filingDistrict) : null;
  if (curated) return {far: curated, basis: 'curated'};
  return plutoFar ? {far: plutoFar, basis: 'pluto_current_district', rezonedSinceFiling: Boolean(filingDistrict) && !same} : null;
}

// DOB BIS NB and A1 filings in one community district that state a zoning floor area, largest first.
export async function candidateFilings({communityDistrict, zoningDistrict, sinceYear}, request) {
  const where = [`job_type IN ('NB','A1')`, `doc__='01'`, `proposed_zoning_sqft >= 1000`, `community___board=${quote(communityDistrict)}`];
  if (zoningDistrict) where.push(`upper(zoning_dist1) like ${quote(`${String(zoningDistrict).toUpperCase()}%`)}`);
  const rows = await request(url(PRECEDENT_SOURCES.dobBis, {
    $select: 'job__,job_type,job_status_descrp,withdrawal_flag,pre__filing_date,signoff_date,bbl,borough,block,lot,house__,street_name,zoning_dist1,special_district_1,landmarked,existing_zoning_sqft,proposed_zoning_sqft,proposed_no_of_stories,proposed_height,proposed_dwelling_units',
    $where: where.join(' AND '), $order: 'proposed_zoning_sqft DESC', $limit: String(CANDIDATE_CAP),
  }));
  const filings = rows.map(r => ({
    jobNumber: r.job__, jobType: r.job_type, status: r.job_status_descrp || null, stage: filingStage(r.job_status_descrp),
    filed: mdy(r.pre__filing_date), signedOff: mdy(r.signoff_date),
    bbl: bblOf(r) || `${Object.keys(BOROUGHS).find(k => BOROUGHS[k] === r.borough)}${String(Number(r.block)).padStart(5, '0')}${String(Number(r.lot)).padStart(4, '0')}`,
    address: [r.house__, r.street_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null,
    filingDistrict: r.zoning_dist1 || null, specialDistrict: r.special_district_1 || null, landmarked: r.landmarked === 'Y',
    existingZfaSqft: num(r.existing_zoning_sqft), filedZfaSqft: num(r.proposed_zoning_sqft),
    stories: num(r.proposed_no_of_stories), heightFeet: num(r.proposed_height), units: num(r.proposed_dwelling_units),
  }));
  // Only approved or signed-off jobs are precedents; an alteration that adds no floor area is not an enlargement.
  const live = filings.filter(f => (f.stage === 'approved' || f.stage === 'completed') && !/^Y$/i.test(rows.find(r => r.job__ === f.jobNumber)?.withdrawal_flag || '')
    && (f.jobType === 'NB' || f.filedZfaSqft > (f.existingZfaSqft ?? 0))
    && (!sinceYear || (f.filed && Number(f.filed.slice(0, 4)) >= sinceYear)));
  return {filings: live, read: rows.length, complete: rows.length < CANDIDATE_CAP};
}

// PLUTO rows for the filed lots: the lot itself, or the lots made from it (a condominium billing lot or
// a subdivision carries the filed lot as its apportionment BBL).
export async function plutoForLots(bbls, request) {
  const unique = [...new Set(bbls)];
  const byBbl = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100).join(',');
    const rows = await request(url(PRECEDENT_SOURCES.pluto, {
      $select: 'bbl,appbbl,address,lotarea,bldgarea,residfar,affresfar,commfar,facilfar,zonedist1,spdist1,landmark,histdist,splitzone,cd',
      $where: `bbl in (${chunk}) OR appbbl in (${chunk})`, $limit: '1000',
    }));
    for (const r of rows) {
      const own = bblOf(r), parent = String(r.appbbl || '').split('.')[0];
      if (unique.includes(own)) byBbl.set(own, {...r, bbl: own, matchedBy: 'bbl'});
      else if (unique.includes(parent) && !byBbl.get(parent)?.matchedBy?.startsWith('bbl')) {
        const prior = byBbl.get(parent);
        byBbl.set(parent, prior ? {...prior, lotarea: String(num(prior.lotarea) + num(r.lotarea)), lots: [...prior.lots, own]} : {...r, bbl: own, matchedBy: 'apportionment', lots: [own]});
      }
    }
  }
  return byBbl;
}

// Zoning lot descriptions and air or development rights deeds recorded on a lot, with every lot each
// one covers, read across all of the lot's documents rather than a capped page.
async function zoningLotInstruments(bbls, request) {
  const boro = bbls[0][0], block = String(Number(bbls[0].slice(1, 6)));
  const lots = [...new Set(bbls.filter(b => b.slice(0, 6) === bbls[0].slice(0, 6)).map(b => `'${Number(b.slice(6))}'`))].join(',');
  const ids = [...new Set((await request(url(PRECEDENT_SOURCES.acrisLegals, {$select: 'document_id', $where: `borough='${boro}' AND block='${block}' AND lot IN (${lots})`, $limit: '5000'}))).map(r => r.document_id))];
  if (!ids.length) return [];
  const types = Object.keys(ZONING_LOT_DOC_TYPES).map(quote).join(',');
  const masters = [];
  for (let i = 0; i < ids.length; i += 150) {
    masters.push(...await request(url(PRECEDENT_SOURCES.acrisMaster, {$select: 'document_id,doc_type,crfn,recorded_datetime', $where: `doc_type IN (${types}) AND document_id IN (${ids.slice(i, i + 150).map(quote).join(',')})`, $limit: '150'})));
  }
  const typed = masters.filter(m => ZONING_LOT_DOC_TYPES[m.doc_type]);
  if (!typed.length) return [];
  const legals = await request(url(PRECEDENT_SOURCES.acrisLegals, {$select: 'document_id,borough,block,lot', $where: `document_id IN (${typed.map(m => quote(m.document_id)).join(',')})`, $limit: '2000'}));
  return typed.map(m => ({
    documentId: m.document_id, docType: m.doc_type, type: ZONING_LOT_DOC_TYPES[m.doc_type], crfn: m.crfn || null,
    recorded: String(m.recorded_datetime || '').slice(0, 10) || null,
    lots: [...new Set(legals.filter(l => l.document_id === m.document_id).map(l => `${l.borough}-${l.block}-${l.lot}`))],
  })).sort((a, b) => String(a.recorded).localeCompare(String(b.recorded)));
}

// City Planning applications on a lot: special permits, authorizations, certifications and rezonings.
async function planningActions(bbls, request) {
  const ids = [...new Set((await request(url(PRECEDENT_SOURCES.zapBbl, {$select: 'project_id', $where: `bbl IN (${bbls.map(quote).join(',')})`, $limit: '50'}))).map(r => r.project_id))];
  if (!ids.length) return [];
  const projects = await request(url(PRECEDENT_SOURCES.zapProjects, {$select: 'project_id,project_name,project_brief,public_status,actions,ulurp_numbers,completed_date,approval_date', $where: `project_id IN (${ids.map(quote).join(',')})`, $limit: '50'}));
  return projects.map(p => ({projectId: p.project_id, name: p.project_name || null, brief: p.project_brief || null, status: p.public_status || null, actions: p.actions || null, ulurpNumbers: p.ulurp_numbers || null, completed: String(p.completed_date || p.approval_date || '').slice(0, 10) || null}));
}

// The public reasons a filing may exceed its base, strongest first; none found is stated, not guessed.
function mechanisms(p, pluto, acris, zap) {
  const out = [];
  const lotArea = p.lotAreaSqft, aff = num(pluto.affresfar);
  if (acris.some(d => d.docType === 'ZONE' && d.lots.length > 1)) out.push('Zoning lot merger: a recorded zoning lot description joins this lot with others, so floor area may come from the merged lots.');
  if (acris.some(d => d.docType === 'AIRRIGHT' || d.docType === 'DEVR')) out.push('Air or development rights transfer recorded on the lot.');
  if (zap.length) out.push(`City Planning action on the lot: ${zap.map(z => `${z.name || z.projectId}${z.actions ? ` (${z.actions})` : ''}`).join('; ')}.`);
  if (aff && aff > p.baseFar && p.filedZfaSqft <= lotArea * aff * 1.02) out.push(`Within the qualifying affordable FAR (${aff}), so an affordable housing bonus may account for it.`);
  if (p.specialDistrict) out.push(`Filed in special district ${p.specialDistrict}, whose bonuses or transfers can raise floor area.`);
  if (p.landmarked || pluto.landmark) out.push('Landmark lot or filing marked landmarked: a landmark transfer or bulk waiver may apply.');
  if (pluto.splitzone === true || pluto.splitzone === 'true') out.push('Split zoning lot: part of the lot may carry a higher FAR than the district used as the base.');
  return out;
}

// Precedents in a community district: filings at or above minRatio of the base, with evidence for the
// top ones. Ratios use today's tables and lot areas, so a lot merged or rezoned since filing can misread.
export async function findPrecedents({communityDistrict, zoningDistrict = null, sinceYear = 2005, minPercentAboveBase = 5, limit = 8}, {request = providerJson} = {}) {
  const {filings, read, complete} = await candidateFilings({communityDistrict, zoningDistrict, sinceYear}, request);
  const pluto = await plutoForLots(filings.map(f => f.bbl), request);
  // Jobs filed the same day on one block stating the same zoning floor area describe one zoning lot
  // across several tax lots (each job states the whole lot's area), so they are measured together.
  const projects = new Map();
  for (const f of filings) {
    const key = `${f.bbl.slice(0, 6)}|${f.filed}|${f.filedZfaSqft}`;
    const prior = projects.get(key);
    if (prior) { if (!prior.taxLots.includes(f.bbl)) prior.taxLots.push(f.bbl); prior.jobNumbers.push(f.jobNumber); }
    else projects.set(key, {...f, taxLots: [f.bbl], jobNumbers: [f.jobNumber]});
  }
  const measured = [];
  const unmeasured = {noLot: 0, noFar: 0};
  for (const f of projects.values()) {
    const lots = f.taxLots.map(b => pluto.get(b)).filter(l => l && num(l.lotarea) > 0);
    if (lots.length !== f.taxLots.length) { unmeasured.noLot++; continue; }
    const lot = lots[0];
    const base = baseFarFor(f.filingDistrict, lot);
    if (!base) { unmeasured.noFar++; continue; }
    const lotAreaSqft = lots.reduce((sum, l) => sum + num(l.lotarea), 0), baseMaxSqft = lotAreaSqft * base.far;
    const origins = [...new Set(lots.map(l => String(l.appbbl || '').split('.')[0]).filter(b => /^[1-5]\d{9}$/.test(b)))];
    measured.push({...f, plutoAddress: lot.address ?? null, currentDistrict: lot.zonedist1 ?? null, lotAreaSqft, lotMatchedBy: lot.matchedBy, ...(origins.length ? {originalLots: origins} : {}), baseFar: base.far, baseFarBasis: base.basis, ...(base.rezonedSinceFiling ? {rezonedSinceFiling: true} : {}), baseMaxSqft: round(baseMaxSqft), filedFar: round(f.filedZfaSqft / lotAreaSqft, 2), percentAboveBase: round((f.filedZfaSqft / baseMaxSqft - 1) * 100, 1), _pluto: lot});
  }
  // One project per zoning lot: its largest live filing.
  const best = new Map();
  for (const m of measured) if (!best.has(m.taxLots.join()) || best.get(m.taxLots.join()).filedZfaSqft < m.filedZfaSqft) best.set(m.taxLots.join(), m);
  const ceiling = m => OUTLIER_MULTIPLE * Math.max(m.baseFar, num(m._pluto.affresfar) ?? 0);
  const outliers = [...best.values()].filter(m => m.filedFar > ceiling(m)).sort((a, b) => b.filedFar - a.filedFar)
    .map(m => ({address: m.address, bbl: m.bbl, jobNumber: m.jobNumber, filedZfaSqft: m.filedZfaSqft, lotAreaSqft: m.lotAreaSqft, filedFar: m.filedFar, baseFar: m.baseFar}));
  const above = [...best.values()].filter(m => m.filedFar <= ceiling(m) && m.percentAboveBase >= minPercentAboveBase).sort((a, b) => b.percentAboveBase - a.percentAboveBase);
  const top = above.slice(0, limit);
  const explained = [];
  for (let i = 0; i < top.length; i += EXPLAIN_BATCH) {
    explained.push(...await Promise.all(top.slice(i, i + EXPLAIN_BATCH).map(async ({_pluto, ...p}) => {
      const lots = [...new Set([...p.taxLots, ...(p.originalLots ?? [])])];
      const [acris, zap] = await Promise.allSettled([zoningLotInstruments(lots, request), planningActions(lots, request)]);
      const a = acris.status === 'fulfilled' ? acris.value : [], z = zap.status === 'fulfilled' ? zap.value : [];
      const found = mechanisms(p, _pluto, a, z);
      return {
        ...p, zoningLotInstruments: a, planningActions: z, likelyMechanisms: found,
        ...(found.length ? {} : {unexplained: 'No public record found for the extra floor area; read the zoning diagram (ZD1) and any BSA decision, and check whether the lot was larger or zoned higher when filed.'}),
        ...([acris, zap].some(r => r.status === 'rejected') ? {evidenceUnavailable: [acris, zap].filter(r => r.status === 'rejected').map(r => r.reason?.message || String(r.reason))} : {}),
      };
    })));
  }
  return {
    scope: {communityDistrict, zoningDistrict, sinceYear, minPercentAboveBase},
    coverage: {filingsRead: read, complete, candidateCap: CANDIDATE_CAP, approvedOrSignedOff: filings.length, zoningLotsMeasured: best.size, unmeasured, aboveBase: above.length, shown: explained.length, outliers: outliers.length},
    precedents: explained,
    ...(outliers.length ? {outliers: outliers.slice(0, 5), outlierNote: `Filed area above ${OUTLIER_MULTIPLE} times the lot's highest FAR: the zoning lot likely spans tax lots not in the filing, or the filing has an entry error. Check the filing before using any as a precedent.`} : {}),
    method: 'Filed zoning floor area from approved or signed-off DOB BIS NB and A1 filings (doc 01; same-day filings on one block stating the same area read as one zoning lot) against PLUTO lot area times the standard FAR of the district each was filed under, at today\'s FAR tables. Evidence: ACRIS zoning lot descriptions and air or development rights deeds on the lot, City Planning (ZAP) applications on the lot, PLUTO affordable FAR, landmark and split-lot fields, and the filing\'s special district.',
    limitations: [
      'DOB NOW filings (2021 on) publish no zoning floor area, so recent projects are not searched.',
      'Lot areas and FARs are today\'s: a lot merged, subdivided or rezoned since filing, or a filing made under older FAR tables, can misread.',
      'A filing states a proposal; a signed-off job is the strongest sign it was built as filed.',
      'BSA variances and special permits are not in this search; read BSA decisions for an unexplained precedent.',
    ],
    sourceUrls: Object.values(PRECEDENT_SOURCES),
  };
}

export const precedentDefinition = {
  name: 'acres_far_precedents',
  description: 'NYC only: find past projects that filed more zoning floor area than their lot\'s standard FAR allows, in a community district (default: the selected property\'s), ranked by how far they exceeded it, each with the public records that may explain how: the qualifying affordable FAR, recorded zoning lot mergers and air or development rights transfers (ACRIS), City Planning special permits, authorizations, certifications and rezonings on the lot (ZAP), special districts and landmark status. Use it to find precedents for increasing buildable floor area near a site. Covers DOB BIS filings (through 2021); DOB NOW filings state no zoning floor area. Ratios use today\'s lot areas and FAR tables, so treat each precedent as a lead to verify against its filing and zoning diagram.',
  inputSchema: {type: 'object', additionalProperties: false, required: [], properties: {
    communityDistrict: {type: 'string', pattern: '^[1-5]\\d{2}$', description: 'Three-digit community district as PLUTO and DOB write it (borough digit plus district, e.g. 101 for Manhattan CD 1, 307 for Brooklyn CD 7). Defaults to the selected property\'s.'},
    zoningDistrict: {type: 'string', description: 'Only filings under districts starting with this code, e.g. R7 or C6-4.'},
    sinceYear: {type: 'integer', minimum: 1990, maximum: 2030, description: 'Earliest filing year (default 2005).'},
    minPercentAboveBase: {type: 'number', minimum: 0, maximum: 500, description: 'Smallest excess over the base floor area to report, in percent (default 5).'},
    limit: {type: 'integer', minimum: 1, maximum: 15, description: 'How many precedents to explain (default 8).'},
  }},
};

export function createPrecedentTools({getProperty = () => null, record = () => null, request = providerJson} = {}) {
  async function run(args = {}) {
    const property = getProperty();
    const communityDistrict = args.communityDistrict ?? (property?.cd ? String(property.cd) : null);
    if (!communityDistrict) throw new Error('Pass communityDistrict or select an NYC subject property first.');
    const out = await findPrecedents({...args, communityDistrict}, {request});
    const source = record({
      title: `NYC floor-area precedents in community district ${communityDistrict}${args.zoningDistrict ? ` (${args.zoningDistrict} districts)` : ''}`,
      url: PRECEDENT_SOURCES.dobBis,
      text: JSON.stringify(out),
      kind: 'official_record',
    });
    return {
      ...out, ...(source?.id ? {sourceId: source.id} : {}),
      proseReportingMandate: out.precedents.length
        ? `Report each precedent with its address, DOB job number, filed zoning floor area, base and percent above base, status, and its likely mechanisms with the ACRIS or ZAP identifiers; state the limitations, and call any precedent without a found mechanism unexplained rather than guessing.${out.coverage.complete ? '' : ` The search read the ${out.coverage.candidateCap} largest filings in the district, so say smaller projects may be missing.`}`
        : `No filing in this scope exceeded the base by ${out.scope.minPercentAboveBase}% or more; say so with the coverage counts, and widen the scope (another district, an earlier year or a lower threshold) if the user wants more.`,
    };
  }
  return {definitions: [precedentDefinition], handlers: {acres_far_precedents: run}};
}
