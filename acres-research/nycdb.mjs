import {requestSignal,executionSignal,throwIfCancelled} from './execution-context.mjs';
import {socrataHeaders} from './public-http.mjs';
import {setTimeout as delay} from 'node:timers/promises';
// NYC public-record diligence adapter modeled on nycdb (https://github.com/nycdb/nycdb):
// queries live NYC Open Data Socrata endpoints by BBL for prior DOB BIS & DOB NOW job/plan
// submittals (and whether they were approved, signed off, disapproved, or withdrawn),
// DOB Certificates of Occupancy, ACRIS recorded real-property instruments (including
// air-rights transfers, easements, and zoning-lot agreements), and HPD affordable-housing
// & violation records.

const BOROUGHS = {
  '1': {code: '1', upper: 'MANHATTAN', title: 'Manhattan'},
  '2': {code: '2', upper: 'BRONX', title: 'Bronx'},
  '3': {code: '3', upper: 'BROOKLYN', title: 'Brooklyn'},
  '4': {code: '4', upper: 'QUEENS', title: 'Queens'},
  '5': {code: '5', upper: 'STATEN ISLAND', title: 'Staten Island'},
};

// ACRIS document types that define the zoning lot or move floor area off it (ACRIS document control
// codes, NYC Open Data 7isb-wh4c).
export const ZONING_LOT_DOC_TYPES = {ZONE: 'zoning lot description', AIRRIGHT: 'air rights', DEVR: 'development rights'};
const ACRIS_MASTER_CHUNK = 150;
const ACRIS_LOT_DOCUMENT_CAP = 5000;
const ACRIS_PARTY_ROW_CAP = 2000;
const VIOLATION_ROW_CAP = 1000;
const [MAJOR_FILING_CAP, CO_CAP, HPD_AFFORDABLE_CAP, HPD_VIOLATION_CAP, HPD_REGISTRATION_CAP, E_DESIGNATION_CAP, LANDMARK_CAP] = [10, 10, 10, 15, 50, 10, 15];
// ACRIS document types whose parties are read (ACRIS Real Property Parties, 636b-3b5g), with the roles of
// party types 1 and 2 as the ACRIS document control codes name them. Deeds convey title; the others are debt.
export const ACRIS_PARTY_ROLES = {
  DEED: ['grantor', 'grantee'], DEEDO: ['grantor', 'grantee'], DEEDP: ['grantor', 'grantee'], 'DEED, RC': ['grantor', 'grantee'],
  'DEED, LE': ['grantor', 'grantee'], 'DEED, TS': ['grantor', 'grantee'], CONDEED: ['grantor', 'grantee'], CORRD: ['grantor', 'grantee'],
  IDED: ['grantor', 'grantee'], REIT: ['grantor', 'grantee'],
  MTGE: ['borrower', 'lender'], SMTG: ['borrower', 'lender'], CMTG: ['borrower', 'lender'], 'M&CON': ['borrower', 'lender'],
  CORRM: ['borrower', 'lender'], ASPM: ['borrower', 'lender'], SPRD: ['borrower', 'lender'], SAT: ['borrower', 'lender'],
  PSAT: ['borrower', 'lender'], ASST: ['assignor', 'assignee'], AGMT: ['party 1', 'party 2'],
};
const isDeed = docType => ACRIS_PARTY_ROLES[docType]?.[1] === 'grantee';
// HPD registration years end on September 1 and owners renew late, so a registration that ended within
// this many days is a renewal due, not a lapse. The deal store applies the same window (market-store.mjs).
export const HPD_REGISTRATION_RENEWAL_GRACE_DAYS = 120;
export function hpdRegistrationStatus(registrationEndDate, asOf) {
  if (!registrationEndDate) return 'none';
  if (registrationEndDate >= asOf) return 'current';
  return (Date.parse(asOf) - Date.parse(registrationEndDate)) / 86400000 <= HPD_REGISTRATION_RENEWAL_GRACE_DAYS ? 'renewal_due' : 'expired';
}

export function parseNycBbl(rawBbl) {
  const clean = String(rawBbl || '').replace(/\D/g, '');
  if (!/^[1-5]\d{9}$/.test(clean)) {
    throw new Error('Supply a valid 10-digit NYC BBL (borough 1-5, 5-digit block, 4-digit lot).');
  }
  const boroCode = clean[0];
  const boro = BOROUGHS[boroCode];
  const block5 = clean.slice(1, 6);
  const blockNum = String(Number(block5));
  const lot4 = clean.slice(6, 10);
  const lotNum = String(Number(lot4));
  const lot5 = lotNum.padStart(5, '0');
  const isCondoBillingLot = Number(lot4) >= 7501 && Number(lot4) <= 7599;
  return {
    bbl: clean,
    boroCode,
    boroughUpper: boro.upper,
    boroughTitle: boro.title,
    block5,
    blockNum,
    lot4,
    lot5,
    lotNum,
    isCondoBillingLot,
  };
}

// BIS and DOB NOW word statuses differently: DOB NOW closes a new building with "CO Issued", writes
// "Signed-off" with a hyphen, issues permits as "Permit Entire" and rejects Local Law 158 filings as "Denied".
export function classifyFilingOutcome(statusRaw = '', statusDesc = '', withdrawalFlag = '') {
  const s = `${statusRaw} ${statusDesc}`.toUpperCase();
  const w = String(withdrawalFlag || '').trim().toUpperCase();
  if (s.includes('SIGN-OFF') || s.includes('SIGNED OFF') || s.includes('SIGNED-OFF') || s.includes('LOC ISSUED') || s.includes('CO ISSUED') || s.includes('COMPLETED') || /^X\b/.test(String(statusRaw).trim())) {
    return 'signed_off';
  }
  if (w === 'Y' || w === 'W' || w === 'YES' || w === 'TRUE' || (Number(w) > 0 && s.includes('WITHDRAW')) || s.includes('WITHDRAWN')) {
    return 'withdrawn';
  }
  if (s.includes('DISAPPROV') || s.includes('DENIED') || /^J\b/.test(String(statusRaw).trim())) return 'disapproved';
  if (s.includes('SUSPEND') || s.includes('REVOK') || s.includes('HOLD')) return 'on_hold_or_suspended';
  if (s.includes('PERMIT ISSUED') || s.includes('PERMIT ENTIRE') || s.includes('APPROVED') || /^[PQR]\b/.test(String(statusRaw).trim())) {
    return 'approved_or_permitted';
  }
  return 'in_review_or_pending';
}

async function defaultJsonRequest(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {headers: socrataHeaders(url), signal: requestSignal(20000)});
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`NYC Open Data returned HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`NYC Open Data returned HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      throwIfCancelled();
      lastErr = err;
      if (attempt < 2) {
        await delay(350 * (attempt + 1),undefined,{signal:executionSignal()});
      }
    }
  }
  throw lastErr;
}

export async function fetchNycPublicRecords(
  {bbl, includeBlockAirRights = true, limit = 15} = {},
  {request = defaultJsonRequest, record = () => null, asOf = new Date().toISOString().slice(0, 10), rentStabilizedLookup = null} = {}
) {
  const freshness = {retrievedAt: new Date().toISOString(), dataAsOf: null, note: 'Retrieval time, not the dataset publication or update date. Record filing, action, issue and fiscal dates retain their individual meanings.'};
  const recordSource = record;
  record = source => recordSource({...source, fetchedAt: freshness.retrievedAt, text: JSON.stringify({...JSON.parse(source.text), freshness})});
  const parsed = parseNycBbl(bbl);
  const cap = Math.max(1, Math.min(Number(limit) || 15, 30));
  const lot5Candidates = parsed.isCondoBillingLot ? [parsed.lot5, '00001'] : [parsed.lot5];
  const lotNumCandidates = parsed.isCondoBillingLot ? [parsed.lotNum, '1'] : [parsed.lotNum];
  const lot5In = lot5Candidates.map(l => `'${l}'`).join(',');
  const lotNumIn = [...new Set([...lotNumCandidates, ...lot5Candidates])].map(l => `'${l}'`).join(',');

  const bisUrl = `https://data.cityofnewyork.us/resource/ic3t-wcy2.json?$where=${encodeURIComponent(
    `borough='${parsed.boroughUpper}' AND (block='${parsed.block5}' OR block='${parsed.blockNum}') AND lot IN (${lotNumIn})`
  )}&$order=${encodeURIComponent('latest_action_date DESC')}&$limit=${cap}`;

  const bisMajorDoc01Url = `https://data.cityofnewyork.us/resource/ic3t-wcy2.json?$where=${encodeURIComponent(
    `borough='${parsed.boroughUpper}' AND (block='${parsed.block5}' OR block='${parsed.blockNum}') AND lot IN (${lotNumIn}) AND doc__='01' AND job_type IN ('NB','A1','DM')`
  )}&$order=${encodeURIComponent('latest_action_date DESC')}&$limit=${MAJOR_FILING_CAP}`;

  const dobNowUrl = `https://data.cityofnewyork.us/resource/w9ak-ipjd.json?$where=${encodeURIComponent(
    `upper(borough)='${parsed.boroughUpper}' AND (block='${parsed.blockNum}' OR block='${parsed.block5}') AND lot IN (${lotNumIn})`
  )}&$limit=${cap}`;

  const coUrl = `https://data.cityofnewyork.us/resource/bs8b-p36w.json?$where=${encodeURIComponent(
    `upper(borough)='${parsed.boroughUpper}' AND (block='${parsed.block5}' OR block='${parsed.blockNum}') AND lot IN (${lotNumIn})`
  )}&$order=${encodeURIComponent('c_o_issue_date DESC')}&$limit=${CO_CAP}`;

  const acrisLotUrl = `https://data.cityofnewyork.us/resource/8h5j-fqxa.json?$where=${encodeURIComponent(
    `borough='${parsed.boroCode}' AND block='${parsed.blockNum}' AND (lot='${parsed.lotNum}' OR air_rights='Y' OR easement='Y')`
  )}&$order=${encodeURIComponent('good_through_date DESC')}&$limit=${cap}`;

  // Every document ever recorded on the subject lot, by id only: the capped lot query above returns
  // rows in no useful order, so an old zoning lot description or air rights deed can fall outside it.
  const acrisLotDocsUrl = `https://data.cityofnewyork.us/resource/8h5j-fqxa.json?$select=document_id&$where=${encodeURIComponent(
    `borough='${parsed.boroCode}' AND block='${parsed.blockNum}' AND lot IN (${[...new Set(lotNumCandidates)].map(l => `'${l}'`).join(',')})`
  )}&$order=document_id&$limit=${ACRIS_LOT_DOCUMENT_CAP}`;

  const hpdAffUrl = `https://data.cityofnewyork.us/resource/hg8x-zxpr.json?bbl=${parsed.bbl}&$limit=${HPD_AFFORDABLE_CAP}`;
  const hpdViolUrl = `https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$where=${encodeURIComponent(
    `boroid='${parsed.boroCode}' AND block='${parsed.blockNum}' AND lot='${parsed.lotNum}'`
  )}&$order=${encodeURIComponent('inspectiondate DESC')}&$limit=${HPD_VIOLATION_CAP}`;

  const hpdRegUrl = `https://data.cityofnewyork.us/resource/tesw-yqqr.json?$where=${encodeURIComponent(
    `boroid='${parsed.boroCode}' AND block='${parsed.blockNum}' AND lot='${parsed.lotNum}'`
  )}&$order=${encodeURIComponent('registrationenddate DESC')}&$limit=${HPD_REGISTRATION_CAP}`;

  // DOB violations (3h2n-5cm9) and ECB/OATH violations (6bgk-3dad) store the block zero-padded to five
  // digits and the lot padded to five or four. Rows are read in bulk so the counts are the lot's, not a sample's.
  const violationLotIn = [...new Set([...lotNumCandidates, ...lot5Candidates, ...lot5Candidates.map(l => l.slice(1))])].map(l => `'${l}'`).join(',');
  const violationWhere = `boro='${parsed.boroCode}' AND (block='${parsed.block5}' OR block='${parsed.blockNum}') AND lot IN (${violationLotIn})`;
  const dobViolUrl = `https://data.cityofnewyork.us/resource/3h2n-5cm9.json?$select=${encodeURIComponent(
    'isn_dob_bis_viol,number,issue_date,violation_type,violation_category,disposition_date,disposition_comments,description'
  )}&$where=${encodeURIComponent(violationWhere)}&$order=${encodeURIComponent('issue_date DESC')}&$limit=${VIOLATION_ROW_CAP}`;
  const ecbViolUrl = `https://data.cityofnewyork.us/resource/6bgk-3dad.json?$select=${encodeURIComponent(
    'ecb_violation_number,ecb_violation_status,severity,violation_type,issue_date,hearing_date,hearing_status,penality_imposed,amount_paid,balance_due,violation_description'
  )}&$where=${encodeURIComponent(violationWhere)}&$order=${encodeURIComponent('issue_date DESC')}&$limit=${VIOLATION_ROW_CAP}`;

  const eDesigUrl = `https://data.cityofnewyork.us/resource/hxm3-23vy.json?bbl=${parsed.bbl}&$limit=${E_DESIGNATION_CAP}`;

  const blkInt = Number(parsed.blockNum);
  const nearbyBlockPrefixes = [-2, -1, 0, 1, 2]
    .map(d => blkInt + d)
    .filter(n => n > 0)
    .map(n => `bbl like '${parsed.boroCode}${String(n).padStart(5, '0')}%'`)
    .join(' OR ');
  const lpcUrl = `https://data.cityofnewyork.us/resource/ncre-qhxs.json?$where=${encodeURIComponent(
    `(${nearbyBlockPrefixes}) AND status='DESIGNATED'`
  )}&$limit=${LANDMARK_CAP}`;

  const [bisRes, bisMajorRes, dobNowRes, coRes, acrisLegalsRes, hpdAffRes, hpdViolRes, eDesigRes, lpcRes, acrisLotDocsRes, hpdRegRes, dobViolRes, ecbViolRes] = await Promise.allSettled([
    request(bisUrl),
    request(bisMajorDoc01Url),
    request(dobNowUrl),
    request(coUrl),
    request(acrisLotUrl),
    request(hpdAffUrl),
    request(hpdViolUrl),
    request(eDesigUrl),
    request(lpcUrl),
    request(acrisLotDocsUrl),
    request(hpdRegUrl),
    request(dobViolUrl),
    request(ecbViolUrl),
  ]);

  // Every document on the lot with its type and dates, read from ACRIS Master: the zoning lot instruments
  // by type, and the deeds that name the owner of record.
  const lotDocIds = acrisLotDocsRes.status === 'fulfilled' && Array.isArray(acrisLotDocsRes.value) ? [...new Set(acrisLotDocsRes.value.map(r => r.document_id).filter(Boolean))] : [];
  const lotMasterRes = await Promise.allSettled(Array.from({length: Math.ceil(lotDocIds.length / ACRIS_MASTER_CHUNK)}, (_, i) => request(`https://data.cityofnewyork.us/resource/bnx9-e6tj.json?$select=${encodeURIComponent('document_id,doc_type,crfn,document_date,recorded_datetime,document_amt')}&$where=${encodeURIComponent(
    `document_id IN (${lotDocIds.slice(i * ACRIS_MASTER_CHUNK, (i + 1) * ACRIS_MASTER_CHUNK).map(d => `'${d}'`).join(',')})`
  )}&$limit=${ACRIS_MASTER_CHUNK}`)));
  const lotMasterRows = lotMasterRes.flatMap(r => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []));
  const zoningLotIds = lotMasterRows.filter(m => ZONING_LOT_DOC_TYPES[m.doc_type]).map(m => m.document_id);
  const lotIndexFailure = acrisLotDocsRes.status === 'rejected' ? acrisLotDocsRes.reason : lotMasterRes.find(r => r.status === 'rejected')?.reason;

  const endpointStatus = {
    dobBis: (bisRes.status === 'fulfilled' || bisMajorRes.status === 'fulfilled') ? 'ok' : `unavailable (${bisRes.reason?.message || 'query failed'})`,
    dobNow: dobNowRes.status === 'fulfilled' ? 'ok' : `unavailable (${dobNowRes.reason?.message || 'query failed'})`,
    certificatesOfOccupancy: coRes.status === 'fulfilled' ? 'ok' : `unavailable (${coRes.reason?.message || 'query failed'})`,
    acris: acrisLegalsRes.status === 'fulfilled' ? 'ok' : `unavailable (${acrisLegalsRes.reason?.message || 'query failed'})`,
    hpdAffordable: hpdAffRes.status === 'fulfilled' ? 'ok' : `unavailable (${hpdAffRes.reason?.message || 'query failed'})`,
    hpdViolations: hpdViolRes.status === 'fulfilled' ? 'ok' : `unavailable (${hpdViolRes.reason?.message || 'query failed'})`,
    hpdRegistrations: hpdRegRes.status === 'fulfilled' ? 'ok' : `unavailable (${hpdRegRes.reason?.message || 'query failed'})`,
    dobViolations: dobViolRes.status === 'fulfilled' ? 'ok' : `unavailable (${dobViolRes.reason?.message || 'query failed'})`,
    ecbViolations: ecbViolRes.status === 'fulfilled' ? 'ok' : `unavailable (${ecbViolRes.reason?.message || 'query failed'})`,
    eDesignations: eDesigRes.status === 'fulfilled' ? 'ok' : `unavailable (${eDesigRes.reason?.message || 'query failed'})`,
    nearbyLpcLandmarks: lpcRes.status === 'fulfilled' ? 'ok' : `unavailable (${lpcRes.reason?.message || 'query failed'})`,
    acrisZoningLotInstruments: lotIndexFailure ? `unavailable (${lotIndexFailure.message || 'query failed'})` : 'ok',
  };
  const rowsOf = res => (res.status === 'fulfilled' && Array.isArray(res.value) ? res.value : []);
  // A dataset that returned its full row limit has older rows that were not read.
  const coverage = (res, limit) => (res.status === 'fulfilled' ? {returnedRows: rowsOf(res).length, rowLimit: limit, truncated: rowsOf(res).length >= limit} : null);
  const datasetCoverage = {
    dobBis: coverage(bisRes, cap), dobBisMajorFilings: coverage(bisMajorRes, MAJOR_FILING_CAP), dobNow: coverage(dobNowRes, cap),
    certificatesOfOccupancy: coverage(coRes, CO_CAP), acris: coverage(acrisLegalsRes, cap), acrisLotDocuments: coverage(acrisLotDocsRes, ACRIS_LOT_DOCUMENT_CAP),
    hpdAffordable: coverage(hpdAffRes, HPD_AFFORDABLE_CAP), hpdViolations: coverage(hpdViolRes, HPD_VIOLATION_CAP), hpdRegistrations: coverage(hpdRegRes, HPD_REGISTRATION_CAP),
    dobViolations: coverage(dobViolRes, VIOLATION_ROW_CAP), ecbViolations: coverage(ecbViolRes, VIOLATION_ROW_CAP),
    eDesignations: coverage(eDesigRes, E_DESIGNATION_CAP), nearbyLpcLandmarks: coverage(lpcRes, LANDMARK_CAP),
  };
  const unavailableEndpoints = Object.entries(endpointStatus)
    .filter(([, st]) => st !== 'ok')
    .map(([name, st]) => `${name}: ${st}`);

  const rawBisRows = [
    ...(bisMajorRes.status === 'fulfilled' && Array.isArray(bisMajorRes.value) ? bisMajorRes.value : []),
    ...(bisRes.status === 'fulfilled' && Array.isArray(bisRes.value) ? bisRes.value : []),
  ];
  const seenBisKeys = new Set();
  const bisRows = [];
  for (const r of rawBisRows) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.job__ || ''}:${r.doc__ || '01'}`;
    if (seenBisKeys.has(key)) continue;
    seenBisKeys.add(key);
    bisRows.push(r);
  }

  const dobNowRows = dobNowRes.status === 'fulfilled' && Array.isArray(dobNowRes.value) ? dobNowRes.value : [];
  const coRows = coRes.status === 'fulfilled' && Array.isArray(coRes.value) ? coRes.value : [];
  const acrisLegalRows = acrisLegalsRes.status === 'fulfilled' && Array.isArray(acrisLegalsRes.value) ? acrisLegalsRes.value : [];
  const hpdAffRows = hpdAffRes.status === 'fulfilled' && Array.isArray(hpdAffRes.value) ? hpdAffRes.value : [];
  const hpdViolRows = hpdViolRes.status === 'fulfilled' && Array.isArray(hpdViolRes.value) ? hpdViolRes.value : [];
  const hpdRegRows = hpdRegRes.status === 'fulfilled' && Array.isArray(hpdRegRes.value) ? hpdRegRes.value : [];
  const dobViolRows = dobViolRes.status === 'fulfilled' && Array.isArray(dobViolRes.value) ? dobViolRes.value : [];
  const ecbViolRows = ecbViolRes.status === 'fulfilled' && Array.isArray(ecbViolRes.value) ? ecbViolRes.value : [];
  const eDesigRows = eDesigRes.status === 'fulfilled' && Array.isArray(eDesigRes.value) ? eDesigRes.value : [];
  const lpcRows = lpcRes.status === 'fulfilled' && Array.isArray(lpcRes.value) ? lpcRes.value : [];

  // The lot query is capped and its rows arrive in no useful order, so a document
  // recorded on several lots can come back with only some of its legals rows. Read
  // every legals row of the returned documents on this block, and enrich them with
  // ACRIS Master (bnx9-e6tj) document types, dates, and amounts.
  let acrisMasterById = new Map();
  let acrisMasterUrl = null;
  let acrisDocumentLegalRows = [];
  let acrisLotsComplete = false;
  const docIds = [...new Set([...acrisLegalRows.map(r => r.document_id), ...zoningLotIds].filter(Boolean))];
  if (docIds.length) {
    const docIdIn = docIds.map(d => `'${d}'`).join(',');
    const legalsRowLimit = 1000;
    const acrisDocumentLegalsUrl = `https://data.cityofnewyork.us/resource/8h5j-fqxa.json?$where=${encodeURIComponent(
      `borough='${parsed.boroCode}' AND block='${parsed.blockNum}' AND document_id IN (${docIdIn})`
    )}&$order=${encodeURIComponent('document_id')}&$limit=${legalsRowLimit}`;
    acrisMasterUrl = `https://data.cityofnewyork.us/resource/bnx9-e6tj.json?$where=${encodeURIComponent(
      `document_id IN (${docIdIn})`
    )}&$limit=${docIds.length}`;
    const [docLegalsRes, masterRes] = await Promise.allSettled([request(acrisDocumentLegalsUrl), request(acrisMasterUrl)]);
    if (docLegalsRes.status === 'fulfilled' && Array.isArray(docLegalsRes.value)) {
      acrisDocumentLegalRows = docLegalsRes.value;
      acrisLotsComplete = acrisDocumentLegalRows.length < legalsRowLimit;
    }
    if (masterRes.status === 'fulfilled' && Array.isArray(masterRes.value)) {
      acrisMasterById = new Map(masterRes.value.map(m => [m.document_id, m]));
    }
  }

  const dobBisFilings = bisRows.map(r => {
    const outcome = classifyFilingOutcome(r.job_status, r.job_status_descrp, r.withdrawal_flag);
    return {
      jobNumber: r.job__ || null,
      docNumber: r.doc__ || null,
      jobType: r.job_type || null,
      jobStatus: r.job_status || null,
      jobStatusDescription: r.job_status_descrp || null,
      outcome,
      latestActionDate: r.latest_action_date || null,
      approvedDate: r.approved || null,
      disapprovedDate: r.disapproved_date || null,
      signoffDate: r.signoff_date || null,
      existingStories: r.existing_no_of_stories ? Number(r.existing_no_of_stories) : null,
      proposedStories: r.proposed_no_of_stories ? Number(r.proposed_no_of_stories) : null,
      existingDwellingUnits: r.existing_dwelling_units ? Number(r.existing_dwelling_units) : null,
      proposedDwellingUnits: r.proposed_dwelling_units ? Number(r.proposed_dwelling_units) : null,
      existingZoningSqft: r.existing_zoning_sqft ? Number(r.existing_zoning_sqft) : null,
      proposedZoningSqft: r.proposed_zoning_sqft ? Number(r.proposed_zoning_sqft) : null,
      totalConstructionFloorArea: r.total_construction_floor_area ? Number(r.total_construction_floor_area) : null,
      zoningDist1: r.zoning_dist1 || null,
      zoningDist2: r.zoning_dist2 || null,
      specialDistrict1: r.special_district_1 || null,
      description: r.job_description || r.other_description || null,
      lot: r.lot || null,
    };
  });

  const dobNowFilings = dobNowRows.map(r => {
    const outcome = classifyFilingOutcome('', r.filing_status, '');
    return {
      jobFilingNumber: r.job_filing_number || null,
      jobType: r.job_type || null,
      filingStatus: r.filing_status || null,
      outcome,
      filingDate: r.filing_date ? String(r.filing_date).slice(0, 10) : null,
      currentStatusDate: r.current_status_date ? String(r.current_status_date).slice(0, 10) : null,
      proposedDwellingUnits: r.proposed_dwelling_units ? Number(r.proposed_dwelling_units) : null,
      workOnFloor: r.work_on_floor || null,
      ownerBusinessName: r.owner_s_business_name || null,
      applicantTitle: r.applicant_professional_title || null,
      lot: r.lot || null,
    };
  });

  // The certificate of occupancy dataset publishes the dwelling units each certificate records, not the use
  // or occupancy group; those are read on the certificate itself, listed in DOB BIS by building.
  const certificatesOfOccupancy = coRows.map(r => ({
    jobNumber: r.job_number || null,
    jobType: r.job_type || null,
    issueDate: r.c_o_issue_date ? String(r.c_o_issue_date).slice(0, 10) : null,
    issueType: r.issue_type || null,
    status: r.application_status_raw || null,
    filingStatus: r.filing_status_raw || null,
    proposedDwellingUnits: r.pr_dwelling_unit != null && r.pr_dwelling_unit !== '' ? Number(r.pr_dwelling_unit) : null,
    existingDwellingUnits: r.ex_dwelling_unit != null && r.ex_dwelling_unit !== '' ? Number(r.ex_dwelling_unit) : null,
    bin: r.bin_number || null,
    occupancyDetail: 'not published in this dataset',
    certificatesUrl: r.bin_number ? `https://a810-bisweb.nyc.gov/bisweb/COsByLocationServlet?allbin=${r.bin_number}` : null,
  }));

  // ACRIS records one legals row per lot, so an instrument covering several lots
  // (a zoning lot merger, a development rights transfer, an assemblage mortgage)
  // arrives as several rows. Group the rows into one entry per document.
  const knownLot = lot => (lot == null || String(lot).trim() === '' ? null : String(Number(lot)));
  // Lot 1 and the unit lots (1001 to 7499) of a block may belong to the subject
  // condominium or to another one on the same block.
  const isCondoLot = lot => lot === '1' || (Number(lot) >= 1001 && Number(lot) <= 7499);
  const acrisById = new Map();
  for (const r of [...acrisLegalRows, ...acrisDocumentLegalRows]) {
    if (!r?.document_id) continue;
    const lot = knownLot(r.lot);
    const existing = acrisById.get(r.document_id);
    if (existing) {
      if (lot && !existing.lots.includes(lot)) existing.lots.push(lot);
      existing.airRights ||= r.air_rights === 'Y';
      existing.easement ||= r.easement === 'Y';
      existing.subterraneanRights ||= r.subterranean_rights === 'Y';
      existing.unit ||= r.unit || null;
      existing.propertyType ||= r.property_type || null;
      continue;
    }
    const master = acrisMasterById.get(r.document_id) || {};
    acrisById.set(r.document_id, {
      documentId: r.document_id,
      crfn: master.crfn || null,
      docType: master.doc_type || null,
      documentDate: master.document_date ? String(master.document_date).slice(0, 10) : null,
      recordedDate: master.recorded_datetime ? String(master.recorded_datetime).slice(0, 10) : null,
      documentAmount: master.document_amt ? Number(master.document_amt) : null,
      lots: lot ? [lot] : [],
      unit: r.unit || null,
      airRights: r.air_rights === 'Y',
      easement: r.easement === 'Y',
      subterraneanRights: r.subterranean_rights === 'Y',
      propertyType: r.property_type || null,
    });
  }
  const acrisDocuments = [...acrisById.values()].map(d => {
    const lots = [...d.lots].sort((a, b) => Number(a) - Number(b));
    return {...d, lots, lotsComplete: acrisLotsComplete, onSubjectLot: lots.includes(parsed.lotNum)};
  });

  // Party names from ACRIS Real Property Parties for every deed on the lot and for the deeds and
  // mortgages returned above. The owner of record comes only from the latest deed on the lot.
  const lotDeeds = lotMasterRows.filter(m => isDeed(m.doc_type));
  const docTypeById = new Map([...lotMasterRows, ...acrisMasterById.values()].map(m => [m.document_id, m.doc_type]));
  const partyDocIds = [...new Set([...lotDeeds.map(m => m.document_id), ...acrisDocuments.filter(d => ACRIS_PARTY_ROLES[d.docType]).map(d => d.documentId)])];
  const partyUrls = Array.from({length: Math.ceil(partyDocIds.length / ACRIS_MASTER_CHUNK)}, (_, i) => `https://data.cityofnewyork.us/resource/636b-3b5g.json?$select=${encodeURIComponent('document_id,party_type,name')}&$where=${encodeURIComponent(
    `document_id IN (${partyDocIds.slice(i * ACRIS_MASTER_CHUNK, (i + 1) * ACRIS_MASTER_CHUNK).map(d => `'${d}'`).join(',')})`
  )}&$order=document_id&$limit=${ACRIS_PARTY_ROW_CAP}`);
  const partyRes = await Promise.allSettled(partyUrls.map(url => request(url)));
  const partyFailure = partyRes.find(r => r.status === 'rejected')?.reason;
  if (partyUrls.length) {
    endpointStatus.acrisParties = partyFailure ? `unavailable (${partyFailure.message || 'query failed'})` : 'ok';
    if (partyFailure) unavailableEndpoints.push(`acrisParties: ${endpointStatus.acrisParties}`);
    const partyRows = partyRes.flatMap(rowsOf);
    datasetCoverage.acrisParties = partyFailure ? null : {returnedRows: partyRows.length, rowLimit: ACRIS_PARTY_ROW_CAP, truncated: partyRes.some(r => rowsOf(r).length >= ACRIS_PARTY_ROW_CAP)};
  }
  const partiesById = new Map();
  for (const row of partyRes.flatMap(rowsOf)) {
    const roles = ACRIS_PARTY_ROLES[docTypeById.get(row.document_id)];
    const name = String(row.name || '').replace(/\s+/g, ' ').trim();
    if (!roles || !name) continue;
    const role = roles[Number(row.party_type) - 1] ?? 'other party';
    const list = partiesById.get(row.document_id) ?? [];
    if (!list.some(p => p.role === role && p.name === name)) list.push({role, name});
    partiesById.set(row.document_id, list);
  }
  const partiesOf = id => (partyFailure && !partiesById.has(id) ? null : partiesById.get(id) ?? []);
  const named = (id, role) => partiesOf(id)?.filter(p => p.role === role).map(p => p.name) ?? null;
  for (const d of acrisDocuments) if (ACRIS_PARTY_ROLES[d.docType]) d.parties = partiesOf(d.documentId);
  const day = v => (v ? String(v).slice(0, 10) : null);
  const deedHistory = lotDeeds.map(m => ({
    documentId: m.document_id, docType: m.doc_type, crfn: m.crfn || null, documentDate: day(m.document_date), recordedDate: day(m.recorded_datetime),
    documentAmount: m.document_amt ? Number(m.document_amt) : null, grantors: named(m.document_id, 'grantor'), grantees: named(m.document_id, 'grantee'),
  // Newest first; a deed with no date at all sorts last, never as the latest deed.
  })).sort((a, b) => (b.recordedDate ?? b.documentDate ?? '').localeCompare(a.recordedDate ?? a.documentDate ?? ''));
  const latestDeed = deedHistory[0] ?? null;
  const unresolvedOwner = reason => ({status: 'unresolved', names: null, reason});
  const lotIndexNote = datasetCoverage.acrisLotDocuments?.truncated ? ` The lot's document index reached its ${ACRIS_LOT_DOCUMENT_CAP} row limit, so later documents may be missing.` : '';
  let currentOwner;
  if (parsed.boroCode === '5') currentOwner = unresolvedOwner('ACRIS does not hold Staten Island land records; the Richmond County Clerk does.');
  else if (parsed.isCondoBillingLot) currentOwner = unresolvedOwner(`Lot ${parsed.lotNum} is a condominium billing lot, owned unit by unit; each unit lot has its own deeds.`);
  else if (lotIndexFailure) currentOwner = unresolvedOwner(`The lot's ACRIS document index could not be read (${lotIndexFailure.message || 'query failed'}).`);
  else if (!latestDeed) currentOwner = unresolvedOwner(`No deed is indexed on lot ${parsed.lotNum} in ACRIS.${lotIndexNote}`);
  else if (latestDeed.grantees === null) currentOwner = unresolvedOwner(`The parties of the latest deed (CRFN ${latestDeed.crfn ?? latestDeed.documentId}) could not be read.`);
  else if (!latestDeed.grantees.length) currentOwner = unresolvedOwner(`The latest deed (CRFN ${latestDeed.crfn ?? latestDeed.documentId}) names no grantee in ACRIS.`);
  else {
    const deedDay = latestDeed.recordedDate ?? latestDeed.documentDate;
    const laterDocuments = lotMasterRows.filter(m => day(m.recorded_datetime) && deedDay && day(m.recorded_datetime) > deedDay)
      .map(m => ({documentId: m.document_id, docType: m.doc_type, crfn: m.crfn || null, recordedDate: day(m.recorded_datetime)}))
      .sort((a, b) => a.recordedDate.localeCompare(b.recordedDate));
    currentOwner = {
      status: laterDocuments.length ? 'latest_deed_predates_later_documents' : 'latest_deed',
      names: latestDeed.grantees, grantors: latestDeed.grantors,
      deed: {documentId: latestDeed.documentId, docType: latestDeed.docType, crfn: latestDeed.crfn, documentDate: latestDeed.documentDate, recordedDate: latestDeed.recordedDate},
      laterDocuments,
      reason: `Grantee of the latest deed indexed on lot ${parsed.lotNum}, recorded ${latestDeed.recordedDate ?? 'on an unrecorded date'}.${laterDocuments.length ? ` ${laterDocuments.length} document(s) were recorded on the lot after it, so the owner of record may have changed if any of them conveys title.` : ''}${lotIndexNote}`,
    };
  }
  const ownerMandate = currentOwner.names
    ? ` ACRIS deed parties: the latest deed indexed on lot ${parsed.lotNum} is ${latestDeed.docType} (CRFN ${latestDeed.crfn ?? latestDeed.documentId}, dated ${latestDeed.documentDate ?? 'with no document date'}, recorded ${latestDeed.recordedDate ?? 'on an unrecorded date'}) from ${latestDeed.grantors.join('; ') || 'an unnamed grantor'} to ${latestDeed.grantees.join('; ')}. Report ${latestDeed.grantees.join('; ')} as the owner of record per that deed, with its dates, citing sourceIds.acrisParties.${currentOwner.laterDocuments.length ? ` ${currentOwner.laterDocuments.length} document(s) (${[...new Set(currentOwner.laterDocuments.map(d => d.docType))].join(', ')}) were recorded on the lot after that deed: say the deed is older than them and that the owner may have changed if any of them conveys title.` : ''}`
    : ` ACRIS does not establish an owner of record for this lot: ${currentOwner.reason} Do not name a current owner from ACRIS.`;

  // The ACRIS query also returns air-rights and easement instruments recorded on
  // other lots of the block; label them so none is attributed to the subject lot.
  // A document with no recorded lot is left unlabelled rather than called a neighbor's.
  const instrumentRef = d => ({documentId: d.documentId, crfn: d.crfn, docType: d.docType, lots: d.lots, lotsComplete: d.lotsComplete});
  const offSubject = acrisDocuments.filter(d => !d.onSubjectLot && d.lots.length);
  const awaitsCondoCheck = d => parsed.isCondoBillingLot && d.lots.some(isCondoLot);
  const subjectLotInstruments = acrisDocuments.filter(d => d.onSubjectLot).map(instrumentRef);
  const condominiumLotsToConfirm = offSubject.filter(awaitsCondoCheck).map(instrumentRef);
  const otherLotsOnBlock = offSubject.filter(d => !awaitsCondoCheck(d)).map(instrumentRef);
  const describeInstrument = d => `${d.docType || 'instrument'}${d.crfn ? ` (CRFN ${d.crfn})` : ''} on lot${d.lots.length > 1 ? 's' : ''} ${d.lots.join(', ')}`;
  const otherLotsMandate = !otherLotsOnBlock.length
    ? ''
    : acrisLotsComplete
      ? ` ACRIS returned ${otherLotsOnBlock.length} instrument(s) recorded only on other lots of block ${parsed.blockNum}: ${otherLotsOnBlock.map(describeInstrument).join('; ')}. Report each with its own lot numbers as a block neighbor's instrument and never attribute it to lot ${parsed.lotNum}; only subjectLotInstruments are recorded against the subject lot, and a subject instrument that also lists other lots covers those lots too.`
      : ` ACRIS returned ${otherLotsOnBlock.length} instrument(s) whose returned rows are on other lots of block ${parsed.blockNum}: ${otherLotsOnBlock.map(describeInstrument).join('; ')}. Their full lot lists could not be read, so report the lots shown as the lots returned and do not state whether these instruments also cover lot ${parsed.lotNum}.`;
  const condoLotsMandate = condominiumLotsToConfirm.length
    ? ` ACRIS returned ${condominiumLotsToConfirm.length} instrument(s) recorded on lot 1 or condominium unit lots of block ${parsed.blockNum} but not on billing lot ${parsed.lotNum}: ${condominiumLotsToConfirm.map(describeInstrument).join('; ')}. A block can hold more than one condominium, so confirm from the condominium declaration that those lots belong to billing lot ${parsed.lotNum} before attributing any of them to the subject property.`
    : '';

  // Zoning lot descriptions and air or development rights instruments on the subject lot: the zoning
  // lot may be larger than the tax lot, or floor area may already have left it.
  const zoningLotInstruments = acrisDocuments.filter(d => d.onSubjectLot && ZONING_LOT_DOC_TYPES[d.docType])
    .map(d => ({...instrumentRef(d), type: ZONING_LOT_DOC_TYPES[d.docType], documentDate: d.documentDate, recordedDate: d.recordedDate}))
    .sort((a, b) => (a.recordedDate ?? '9999-12-31').localeCompare(b.recordedDate ?? '9999-12-31'));
  const zoningLotMandate = zoningLotInstruments.length
    ? ` ACRIS records ${zoningLotInstruments.length} zoning lot instrument(s) on this lot: ${zoningLotInstruments.map(d => `${d.type} (${d.docType}${d.crfn ? `, CRFN ${d.crfn}` : ''}, recorded ${d.recordedDate || 'on an unrecorded date'}, lots ${d.lots.join(', ')})`).join('; ')}. State that the zoning lot may be larger than the tax lot or that floor area may already have been transferred, so the PLUTO capacity is not final until counsel reads these instruments.`
    : '';

  const hpdAffordableProjects = hpdAffRows.map(r => ({
    projectId: r.project_id || null,
    projectName: r.project_name || null,
    projectStartDate: r.project_start_date ? String(r.project_start_date).slice(0, 10) : null,
    constructionType: r.reporting_construction_type || null,
    extendedAffordability: r.extended_affordability_status || null,
    prevailingWage: r.prevailing_wage_status || null,
    lowIncomeUnits: r.low_income_units ? Number(r.low_income_units) : 0,
    countedRentalUnits: r.counted_rental_units ? Number(r.counted_rental_units) : 0,
    allCountedUnits: r.all_counted_units ? Number(r.all_counted_units) : 0,
  }));

  const openViolations = hpdViolRows.filter(v => String(v.violationstatus || '').toUpperCase() === 'OPEN');
  const classCViolations = hpdViolRows.filter(v => String(v.class || '').toUpperCase() === 'C');
  const hpdViolationSummary = {
    sampledCount: hpdViolRows.length,
    openInSample: openViolations.length,
    classCInSample: classCViolations.length,
    recentViolations: hpdViolRows.slice(0, 5).map(v => ({
      violationId: v.violationid,
      class: v.class,
      status: v.violationstatus,
      inspectionDate: v.inspectiondate ? String(v.inspectiondate).slice(0, 10) : null,
      story: v.story || null,
      apartment: v.apartment || null,
      novDescription: v.novdescription ? String(v.novdescription).slice(0, 220) : null,
    })),
  };

  // HPD Multiple Dwelling Registrations (tesw-yqqr): one row per registered building on the lot. The
  // registration year ends on the registrationenddate, so a date before today is a lapsed registration.
  const isoDay = v => (v ? String(v).slice(0, 10) : null);
  const latestDay = values => values.map(isoDay).filter(Boolean).sort().at(-1) || null;
  const hpdRegistrationEndDate = latestDay(hpdRegRows.map(r => r.registrationenddate));
  const hpdRegistration = hpdRegRes.status !== 'fulfilled'
    ? {status: 'unavailable', registeredMultipleDwelling: null, buildingCount: null, lastRegistrationDate: null, registrationEndDate: null}
    : {
      status: hpdRegistrationStatus(hpdRegistrationEndDate, asOf),
      registeredMultipleDwelling: hpdRegRows.length > 0,
      buildingCount: hpdRegRows.length,
      lastRegistrationDate: latestDay(hpdRegRows.map(r => r.lastregistrationdate)),
      registrationEndDate: hpdRegistrationEndDate,
      buildings: hpdRegRows.slice(0, 10).map(r => ({
        registrationId: r.registrationid || null,
        buildingId: r.buildingid || null,
        bin: r.bin || null,
        address: [r.housenumber, r.streetname].filter(Boolean).join(' ') || null,
        lastRegistrationDate: isoDay(r.lastregistrationdate),
        registrationEndDate: isoDay(r.registrationenddate),
      })),
    };

  // DOB and ECB dates arrive as YYYYMMDD; type labels carry the code, a dash and padded text.
  const violationDay = v => (/^\d{8}$/.test(String(v || '')) ? `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}` : isoDay(v));
  const violationLabel = v => String(v || '').replace(/\s+/g, ' ').trim() || null;
  const tally = (rows, key) => {
    const counts = {};
    for (const row of rows) { const k = key(row) || 'unspecified'; counts[k] = (counts[k] || 0) + 1; }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  };
  const money = v => (v === null || v === undefined || String(v).trim() === '' ? 0 : Number(v) || 0);
  const roundMoney = n => Math.round(n * 100) / 100;
  // A DOB violation category marked with an asterisk, or reading dismissed or resolved, is closed.
  const dobViolationOpen = v => !/\*|DISMISS|RESOLV/i.test(String(v.violation_category || ''));
  const openDobViolations = dobViolRows.filter(dobViolationOpen);
  const dobViolationSummary = {
    available: dobViolRes.status === 'fulfilled',
    returnedCount: dobViolRows.length,
    complete: dobViolRes.status === 'fulfilled' && dobViolRows.length < VIOLATION_ROW_CAP,
    openCount: openDobViolations.length,
    closedCount: dobViolRows.length - openDobViolations.length,
    openByType: tally(openDobViolations, v => violationLabel(v.violation_type)),
    recentViolations: dobViolRows.slice(0, 5).map(v => ({
      number: v.number || null,
      issueDate: violationDay(v.issue_date),
      type: violationLabel(v.violation_type),
      category: violationLabel(v.violation_category),
      open: dobViolationOpen(v),
      dispositionDate: violationDay(v.disposition_date),
      description: v.description ? String(v.description).slice(0, 220) : null,
    })),
  };
  const ecbViolationOpen = v => String(v.ecb_violation_status || '').toUpperCase() === 'ACTIVE';
  const openEcbViolations = ecbViolRows.filter(ecbViolationOpen);
  const ecbViolationSummary = {
    available: ecbViolRes.status === 'fulfilled',
    returnedCount: ecbViolRows.length,
    complete: ecbViolRes.status === 'fulfilled' && ecbViolRows.length < VIOLATION_ROW_CAP,
    openCount: openEcbViolations.length,
    resolvedCount: ecbViolRows.length - openEcbViolations.length,
    openBySeverity: tally(openEcbViolations, v => violationLabel(v.severity)),
    openByType: tally(openEcbViolations, v => violationLabel(v.violation_type)),
    totalPenaltyImposed: roundMoney(ecbViolRows.reduce((sum, v) => sum + money(v.penality_imposed), 0)),
    totalAmountPaid: roundMoney(ecbViolRows.reduce((sum, v) => sum + money(v.amount_paid), 0)),
    totalBalanceDue: roundMoney(ecbViolRows.reduce((sum, v) => sum + money(v.balance_due), 0)),
    openBalanceDue: roundMoney(openEcbViolations.reduce((sum, v) => sum + money(v.balance_due), 0)),
    recentViolations: ecbViolRows.slice(0, 5).map(v => ({
      ecbViolationNumber: v.ecb_violation_number || null,
      status: violationLabel(v.ecb_violation_status),
      severity: violationLabel(v.severity),
      type: violationLabel(v.violation_type),
      issueDate: violationDay(v.issue_date),
      hearingDate: violationDay(v.hearing_date),
      hearingStatus: violationLabel(v.hearing_status),
      penaltyImposed: money(v.penality_imposed),
      amountPaid: money(v.amount_paid),
      balanceDue: money(v.balance_due),
      description: v.violation_description ? String(v.violation_description).slice(0, 220) : null,
    })),
  };
  const openViolationsMandate = dobViolationSummary.openCount || ecbViolationSummary.openCount
    ? ` Open violations are on record for this lot: ${dobViolationSummary.openCount} open DOB violation(s) of ${dobViolationSummary.returnedCount} returned and ${ecbViolationSummary.openCount} open ECB/OATH violation(s) of ${ecbViolationSummary.returnedCount} returned, with $${ecbViolationSummary.totalBalanceDue.toLocaleString('en-US')} in ECB penalties still due. Report the open counts, the severity mix, the outstanding penalties and the most recent items with their dates as obligations that run with the property; DOB does not sign off work or issue a Certificate of Occupancy while they stand.`
    : '';
  const registrationMandate = hpdRegistration.status === 'unavailable'
    ? ''
    : hpdRegistration.registeredMultipleDwelling
      ? ` HPD lists ${hpdRegistration.buildingCount} registered multiple dwelling(s) on this lot, last registered ${hpdRegistration.lastRegistrationDate || 'on an unrecorded date'} with the registration ${hpdRegistration.status === 'current' ? `current through ${hpdRegistration.registrationEndDate}` : hpdRegistration.status === 'renewal_due' ? `year ended ${hpdRegistration.registrationEndDate} and the annual renewal due (it may not be posted yet)` : `expired on ${hpdRegistration.registrationEndDate}`}; report this as a registered, occupied multiple dwelling whose tenancies need review.`
      : ' HPD has no multiple dwelling registration for this lot; say so, and note that buildings of three or more units must register, so an unregistered building with that many units needs its occupancy confirmed.';

  const eDesignations = eDesigRows.map(r => ({
    eNumber: r.enumber || null,
    ceqrNumber: r.ceqr_num || null,
    ulurpNumber: r.ulurp_num || null,
    effectiveDate: r.effective_date ? String(r.effective_date).slice(0, 10) : null,
    hazmatRequired: Boolean(r.hazmat_code),
    airQualityStackRequired: Boolean(r.air_code),
    windowWallNoiseRequired: Boolean(r.noise_code),
    description: r.description || r.descriptio || null,
  }));

  const nearbyLpcLandmarks = lpcRows.map(r => {
    const lmBbl = String(r.bbl || '').replace(/\D/g, '').slice(0, 10);
    return {
      bbl: lmBbl || null,
      landmarkName: r.lm_name || null,
      landmarkType: r.lm_type || null,
      status: r.status || null,
      historicDistrict: r.hist_distr || null,
      address: r.pluto_addr || null,
      bin: r.bin_number || null,
      isSubjectLot: lmBbl === parsed.bbl,
      isSameTaxBlock: lmBbl.slice(0, 6) === `${parsed.boroCode}${parsed.block5}`,
    };
  });

  const truncatedDatasets = Object.entries(datasetCoverage).filter(([, c]) => c?.truncated);
  const truncationMandate = truncatedDatasets.length
    ? ` Row limits reached: ${truncatedDatasets.map(([name, c]) => `${name} returned its limit of ${c.rowLimit} rows`).join('; ')}. Older records exist beyond those read, so report each of these as the most recent rows, never as the complete history, and never present a count from them as a total.`
    : '';

  const allFilings = [
    ...dobBisFilings.map(f => ({source: 'DOB_BIS', id: f.jobNumber, doc: f.docNumber, jobType: f.jobType, outcome: f.outcome, status: f.jobStatusDescription, date: f.latestActionDate, proposedStories: f.proposedStories, proposedUnits: f.proposedDwellingUnits, existingZfa: f.existingZoningSqft, proposedZfa: f.proposedZoningSqft, zoningDist1: f.zoningDist1, zoningDist2: f.zoningDist2, description: f.description})),
    ...dobNowFilings.map(f => ({source: 'DOB_NOW', id: f.jobFilingNumber, doc: null, jobType: f.jobType, outcome: f.outcome, status: f.filingStatus, date: null, proposedStories: null, proposedUnits: null, existingZfa: null, proposedZfa: null, zoningDist1: null, zoningDist2: null, description: f.workOnFloor})),
  ];

  const filedZoningFloorAreaSummary = dobBisFilings
    .filter(f => (f.proposedZoningSqft && f.proposedZoningSqft > 0) || (f.existingZoningSqft && f.existingZoningSqft > 0))
    .map(f => ({
      jobNumber: f.jobNumber,
      docNumber: f.docNumber,
      jobType: f.jobType,
      outcome: f.outcome,
      existingZoningSqft: f.existingZoningSqft,
      proposedZoningSqft: f.proposedZoningSqft,
      totalConstructionFloorArea: f.totalConstructionFloorArea,
      proposedStories: f.proposedStories,
      proposedDwellingUnits: f.proposedDwellingUnits,
      zoningDist1: f.zoningDist1,
      zoningDist2: f.zoningDist2,
    }));

  const submittalForensics = {
    totalFilingsReturned: allFilings.length,
    datasetCoverage,
    truncatedDatasets: truncatedDatasets.map(([name]) => name),
    endpointStatus,
    ...(unavailableEndpoints.length ? {unavailableEndpoints} : {}),
    majorFilings: allFilings.filter(f => ['NB', 'A1', 'DM', 'ALT-CO', 'New Building'].includes(String(f.jobType || ''))),
    disapprovedOrWithdrawn: allFilings.filter(f => f.outcome === 'disapproved' || f.outcome === 'withdrawn' || f.outcome === 'on_hold_or_suspended'),
    approvedOrSignedOff: allFilings.filter(f => f.outcome === 'signed_off' || f.outcome === 'approved_or_permitted'),
    filedZoningFloorAreaSummary,
    zoningLotInstruments,
    airRightsOrEasementInstruments: acrisDocuments.filter(d => d.airRights || d.easement || [...Object.keys(ZONING_LOT_DOC_TYPES), 'EASE', 'CERT', 'AGMT', 'DECL'].includes(String(d.docType || ''))),
    note: 'DOB Open Data reports filing status (Approved, Permit Issued, Signed Off, Disapproved, Withdrawn) and proposed stories/units/ZFA (especially on doc__ = 01 for NB/A1 jobs). Specific plan-examiner objection sheets on disapproved jobs live in the DOB BIS / DOB NOW Public Portal under the job number.',
  };

  // Rent-stabilized units the owner registered with HCR, from the DOF statement of account line
  // (JustFix nyc-doffer, kept monthly in the deal store). Absent from the file is not proof of none.
  let rentStabilizedUnits = {status: 'unavailable', units: null, year: null, statementUrl: null, note: 'No rent-stabilized count source is configured.'};
  if (rentStabilizedLookup) {
    try {
      const found = await rentStabilizedLookup(parsed.bbl);
      rentStabilizedUnits = found
        ? {status: 'ok', units: found.units, year: found.year, statementUrl: found.statementUrl ?? null, note: `${found.units} rent-stabilized unit(s) registered with HCR per the ${found.year} DOF statement of account.`}
        : {status: 'none', units: null, year: null, statementUrl: null, note: 'The lot does not appear in the rent-stabilized counts file, which is not proof that no unit is regulated.'};
    } catch (error) {
      rentStabilizedUnits = {status: 'unavailable', units: null, year: null, statementUrl: null, note: `Rent-stabilized counts could not be read (${error.message}).`};
    }
  }
  const stabilizedMandate = rentStabilizedUnits.status === 'ok'
    ? ` ${rentStabilizedUnits.note} Report that count with its year and cite the statement of account.`
    : rentStabilizedUnits.status === 'none' ? ' The rent-stabilized counts file has no entry for this lot; say so rather than reporting zero regulated units.' : '';

  const sourceIds = {};
  if (rentStabilizedUnits.status === 'ok') {
    const src = record({
      title: `Rent-stabilized units registered for BBL ${parsed.bbl} (DOF statement of account ${rentStabilizedUnits.year})`,
      url: rentStabilizedUnits.statementUrl || 'https://s3.amazonaws.com/justfix-data/rentstab_counts_from_doffer_2024.csv',
      text: JSON.stringify({bbl: parsed.bbl, rentStabilizedUnits}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.rentStabilizedUnits = src.id;
  }
  if (dobBisFilings.length) {
    const src = record({
      title: `NYC DOB BIS Job Application Filings for BBL ${parsed.bbl}`,
      url: bisUrl,
      text: JSON.stringify({bbl: parsed.bbl, dobBisFilings, filedZoningFloorAreaSummary}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.dobBis = src.id;
  }
  if (dobNowFilings.length) {
    const src = record({
      title: `NYC DOB NOW Build Job Filings for BBL ${parsed.bbl}`,
      url: dobNowUrl,
      text: JSON.stringify({bbl: parsed.bbl, dobNowFilings}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.dobNow = src.id;
  }
  if (certificatesOfOccupancy.length) {
    const src = record({
      title: `NYC DOB Certificates of Occupancy for BBL ${parsed.bbl}`,
      url: coUrl,
      text: JSON.stringify({bbl: parsed.bbl, certificatesOfOccupancy}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.certificatesOfOccupancy = src.id;
  }
  if (acrisDocuments.length) {
    const src = record({
      title: `NYC ACRIS Recorded Property & Air-Rights Instruments for Block ${parsed.blockNum}, Lot ${parsed.lotNum}`,
      url: acrisLotUrl,
      text: JSON.stringify({bbl: parsed.bbl, acrisDocuments}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.acris = src.id;
  }
  if (partiesById.size) {
    const src = record({
      title: `NYC ACRIS Real Property Parties for Deeds and Mortgages on Block ${parsed.blockNum}, Lot ${parsed.lotNum}`,
      url: partyUrls[0],
      text: JSON.stringify({bbl: parsed.bbl, currentOwner, deedHistory, documentParties: Object.fromEntries(partiesById)}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.acrisParties = src.id;
  }
  if (hpdAffordableProjects.length || hpdViolRows.length) {
    const src = record({
      title: `NYC HPD Affordable Housing & Violation Records for BBL ${parsed.bbl}`,
      url: hpdAffordableProjects.length ? hpdAffUrl : hpdViolUrl,
      text: JSON.stringify({bbl: parsed.bbl, hpdAffordableProjects, hpdViolationSummary}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.hpd = src.id;
  }
  if (hpdRegRows.length) {
    const src = record({
      title: `NYC HPD Multiple Dwelling Registrations for BBL ${parsed.bbl}`,
      url: hpdRegUrl,
      text: JSON.stringify({bbl: parsed.bbl, hpdRegistration}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.hpdRegistrations = src.id;
  }
  if (dobViolRows.length) {
    const src = record({
      title: `NYC DOB Violations for BBL ${parsed.bbl}`,
      url: dobViolUrl,
      text: JSON.stringify({bbl: parsed.bbl, dobViolationSummary}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.dobViolations = src.id;
  }
  if (ecbViolRows.length) {
    const src = record({
      title: `NYC DOB ECB/OATH Violations for BBL ${parsed.bbl}`,
      url: ecbViolUrl,
      text: JSON.stringify({bbl: parsed.bbl, ecbViolationSummary}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.ecbViolations = src.id;
  }
  if (eDesignations.length) {
    const src = record({
      title: `NYC DCP CEQR E-Designations for BBL ${parsed.bbl}`,
      url: eDesigUrl,
      text: JSON.stringify({bbl: parsed.bbl, eDesignations}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.eDesignations = src.id;
  }
  if (nearbyLpcLandmarks.length) {
    const src = record({
      title: `NYC LPC Designated Landmarks Near Block ${parsed.blockNum} (BBL ${parsed.bbl})`,
      url: lpcUrl,
      text: JSON.stringify({bbl: parsed.bbl, nearbyLpcLandmarks}, null, 2),
      kind: 'official_record',
    });
    if (src?.id) sourceIds.lpcLandmarks = src.id;
  }

  return {
    bbl: parsed.bbl,
    freshness,
    borough: parsed.boroughTitle,
    block: parsed.blockNum,
    lot: parsed.lotNum,
    endpointStatus,
    ...(unavailableEndpoints.length ? {unavailableEndpoints} : {}),
    datasetCoverage,
    sourceIds,
    submittalForensics,
    dobBisFilings,
    dobNowFilings,
    certificatesOfOccupancy,
    acrisDocuments,
    currentOwner,
    deedHistory,
    subjectLotInstruments,
    zoningLotInstruments,
    otherLotsOnBlock,
    condominiumLotsToConfirm,
    hpdAffordableProjects,
    hpdViolationSummary,
    hpdRegistration,
    rentStabilizedUnits,
    dobViolationSummary,
    ecbViolationSummary,
    eDesignations,
    nearbyLpcLandmarks,
    proseReportingMandate: `IMPORTANT: You called acres_nyc_public_records. In your final written answer, you MUST explicitly report and cite (using the sourceIds above) the specific findings returned here, including specific DOB job numbers, outcomes, and filed proposed/existing ZFA (from filedZoningFloorAreaSummary / dobBisFilings / dobNowFilings), Certificate of Occupancy job numbers/dates and the dwelling units each records (the dataset does not publish use or occupancy group; say those are read on the certificate itself), ACRIS document types/CRFNs/dates with the lots each was recorded on, their party names (and whether air_rights or easement flags are Y or N), HPD affordable unit counts and open/Class C violations, the HPD multiple dwelling registration status (registered or not, last registration date, current or expired), open DOB violations and open ECB/OATH violations with their severity mix and the ECB penalty balance still due (from dobViolationSummary and ecbViolationSummary), any E-Designation numbers and requirements (hazmat, air stack, noise attenuation), and any nearby LPC landmarks.${ownerMandate}${truncationMandate}${stabilizedMandate}${zoningLotMandate}${otherLotsMandate}${condoLotsMandate}${openViolationsMandate}${registrationMandate}${unavailableEndpoints.length ? ` WARNING: The following endpoints were unavailable or timed out: ${unavailableEndpoints.join('; ')}. State that those specific endpoints were unavailable; never report that they returned "zero records".` : ''}`,
  };
}

export const nycPublicRecordsDefinition = {
  name: 'acres_nyc_public_records',
  description: 'Query NYC Open Data public records (modeled on nycdb) for an NYC parcel by BBL: prior and active DOB BIS & DOB NOW job/plan submittals (with pass/fail/disapproved status, proposed stories, dwelling units, and filed zoning floor area on doc 01 NB/A1 jobs), DOB Certificates of Occupancy (issue dates, type and the dwelling units recorded; use and occupancy group are on the certificate itself, not in the dataset), ACRIS recorded real-property instruments (including air-rights transfers, easements, and zoning-lot agreements) with deed and mortgage party names and the owner of record from the latest deed, HPD affordable housing / violation records, HPD multiple dwelling registration status, DOB violations and ECB/OATH violations (open counts, severity mix, penalties due), NYC DCP CEQR E-Designations, and nearby LPC Designated Landmarks. Each dataset reports its row limit and whether it reached it (datasetCoverage). Automatically records non-empty datasets as citable sources.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      bbl: {type: 'string', description: 'Optional 10-digit NYC BBL; defaults to the currently selected subject property BBL.'},
      limit: {type: 'integer', minimum: 1, maximum: 30, description: 'Maximum rows per dataset (default 15).'},
    },
    required: [],
  },
};

// New building and major alteration filings, the jobs that propose a building's floor area. BIS files
// them as NB and A1; DOB NOW names them in full ("New Building", "ALT-CO - New Building with Existing
// Elements to Remain").
export const PROPOSAL_JOB = /^(NB|A1)$|new building|alt-?co|alteration co/i;
// A filing older than this with no later action has most likely lapsed (permits expire unless work proceeds).
export const PROPOSAL_STALE_YEARS = 6;
const DIGEST_FILING_CAP = 5;
const isoActionDay = v => {
  const m = String(v ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : v ? String(v).slice(0, 10) : null;
};
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

// The records most NYC underwriting answers need, in a form compact enough to ride on a tool result: the
// owner of record from the latest deed with its caveats, open violation counts, new building and major
// alteration filings still in progress, the latest certificate of occupancy, and the flags that send an
// answer to the full records (E-designations, zoning lot instruments, HPD registration, rent stabilization).
export function publicRecordsDigest(out, {now = new Date()} = {}) {
  const owner = out.currentOwner;
  const {dobViolationSummary: dob, ecbViolationSummary: ecb, hpdViolationSummary: hpd, endpointStatus: status} = out;
  const ownerCaveat = owner.names && (owner.status !== 'latest_deed' || out.datasetCoverage.acrisLotDocuments?.truncated) ? owner.reason : null;
  // Counts from a dataset that reached its row limit are the most recent rows, not the lot's total.
  const countsAreAtLeast = [dob.available && !dob.complete && 'dob', ecb.available && !ecb.complete && 'ecb'].filter(Boolean);
  const since = new Date(now.getTime() - PROPOSAL_STALE_YEARS * 365.25 * 86400000).toISOString().slice(0, 10);
  const major = [
    ...out.dobBisFilings.filter(f => (f.docNumber ?? '01') === '01')
      .map(f => ({system: 'DOB BIS', jobNumber: f.jobNumber, jobType: f.jobType, status: f.jobStatusDescription, outcome: f.outcome, lastAction: isoActionDay(f.latestActionDate), proposedZoningSqft: f.proposedZoningSqft, proposedDwellingUnits: f.proposedDwellingUnits, proposedStories: f.proposedStories})),
    ...out.dobNowFilings.map(f => ({system: 'DOB NOW', jobNumber: f.jobFilingNumber, jobType: f.jobType, status: f.filingStatus, outcome: f.outcome, lastAction: [f.filingDate, f.currentStatusDate].filter(Boolean).sort().at(-1) ?? null, proposedDwellingUnits: f.proposedDwellingUnits})),
  ].filter(f => PROPOSAL_JOB.test(f.jobType || '') && (f.outcome === 'in_review_or_pending' || f.outcome === 'approved_or_permitted'));
  const inProgress = major.filter(f => f.lastAction && f.lastAction >= since).sort((a, b) => b.lastAction.localeCompare(a.lastAction));
  const lapsed = major.filter(f => f.lastAction && f.lastAction < since).length;
  const undated = major.filter(f => !f.lastAction);
  const cert = out.certificatesOfOccupancy[0];
  const registration = out.hpdRegistration;
  const stabilized = out.rentStabilizedUnits;
  return compact({
    bbl: out.bbl,
    freshness: out.freshness,
    ownerOfRecord: owner.names
      ? compact({names: owner.names, deed: compact({docType: owner.deed.docType, crfn: owner.deed.crfn, documentDate: owner.deed.documentDate, recordedDate: owner.deed.recordedDate}), caveat: ownerCaveat})
      : {names: null, reason: owner.reason},
    openViolations: compact({
      dob: dob.available ? dob.openCount : null,
      ecb: ecb.available ? ecb.openCount : null,
      ecbOpenBalanceDue: ecb.available ? ecb.openBalanceDue : null,
      hpdOpenInLatestInspections: status.hpdViolations === 'ok' ? hpd.openInSample : null,
      hpdInspectionsRead: status.hpdViolations === 'ok' ? hpd.sampledCount : null,
      countsAreAtLeast: countsAreAtLeast.length ? countsAreAtLeast : null,
    }),
    majorFilingsInProgress: {
      actionSince: since,
      count: inProgress.length,
      latest: inProgress.slice(0, DIGEST_FILING_CAP).map(({outcome, ...f}) => compact(f)),
      ...(lapsed ? {lapsedUnresolvedCount: lapsed} : {}),
      ...(undated.length ? {undatedUnresolvedCount: undated.length, undated: undated.slice(0, DIGEST_FILING_CAP).map(({outcome, ...f}) => compact(f))} : {}),
    },
    latestCertificateOfOccupancy: cert ? compact({jobNumber: cert.jobNumber, issueDate: cert.issueDate, issueType: cert.issueType, dwellingUnits: cert.proposedDwellingUnits}) : null,
    eDesignations: out.eDesignations.length ? out.eDesignations.map(e => e.eNumber).filter(Boolean) : null,
    zoningLotInstruments: out.zoningLotInstruments.length ? out.zoningLotInstruments.map(d => compact({type: d.type, crfn: d.crfn, recordedDate: d.recordedDate})).slice(0, 3) : null,
    hpdRegistration: registration.status === 'unavailable' ? null : compact({status: registration.status, registrationEndDate: registration.registrationEndDate}),
    rentStabilizedUnits: stabilized.status === 'ok' ? {units: stabilized.units, year: stabilized.year} : null,
    unavailableEndpoints: out.unavailableEndpoints ?? null,
  });
}

export function createNycPublicRecordsTools({getProperty = () => null, request = defaultJsonRequest, record = () => null, emit = () => {}, rentStabilizedLookup = null} = {}) {
  let latestRecords = null;
  // Records do not change within a run, so each query is read once: a records call made while the digest
  // is still being read, or after it, reuses those reads. A failed read is tried again by the next call.
  const reads = new Map();
  const read = url => {
    if (!reads.has(url)) reads.set(url, request(url).catch(error => { reads.delete(url); throw error; }));
    return reads.get(url);
  };
  async function run(args = {}) {
    const targetBbl = args?.bbl || getProperty()?.bbl;
    if (!targetBbl) {
      throw new Error('Supply a 10-digit NYC BBL or select a subject property with acres_set_subject first.');
    }
    const out = await fetchNycPublicRecords({bbl: targetBbl, limit: args?.limit ?? 15}, {request: read, record, rentStabilizedLookup});
    latestRecords = out;
    emit('nyc_records.fetched', {bbl: out.bbl, sourceIds: out.sourceIds, totalFilings: out.submittalForensics.totalFilingsReturned});
    return out;
  }
  // The digest records nothing until it is cited, and never becomes the run's records result.
  async function digest(bbl) {
    const out = await fetchNycPublicRecords({bbl}, {request: read, rentStabilizedLookup});
    if (Object.values(out.endpointStatus).every(status => status !== 'ok')) throw new Error('every NYC Open Data records endpoint was unavailable');
    return publicRecordsDigest(out);
  }
  function citeDigest(summary) {
    const src = record({
      title: `NYC public records digest for BBL ${summary.bbl}: owner of record, open violations, major filings in progress and certificate of occupancy`,
      url: 'https://data.cityofnewyork.us/',
      text: JSON.stringify(summary),
      kind: 'official_record',
    });
    return {...summary, ...(src?.id ? {sourceId: src.id} : {})};
  }
  return {
    definitions: [nycPublicRecordsDefinition],
    handlers: {acres_nyc_public_records: run},
    digest,
    citeDigest,
    get records() { return latestRecords; },
  };
}
