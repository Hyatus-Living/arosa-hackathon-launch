import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fetchNycPublicRecords, hpdRegistrationStatus} from './nycdb.mjs';
import {MarketStore, computeRentStabilizationProfile, hpdRegistrationBbl} from './market-store.mjs';

// Serves the violation and registration datasets the way NYC Open Data does: DOB and ECB rows carry
// zero-padded block and lot, registration rows bare numbers; every other dataset is empty.
const recordsRequest = ({dob = [], ecb = [], reg = [], fail = []} = {}) => async url => {
  const u = decodeURIComponent(String(url));
  const dataset = new URL(u).pathname.split('/').pop().replace('.json', '');
  if (fail.includes(dataset)) throw new Error('NYC Open Data returned HTTP 503');
  if (dataset === '3h2n-5cm9') {
    assert.match(u, /boro='3' AND \(block='02186' OR block='2186'\) AND lot IN \('1','00001','0001'\)/);
    assert.match(u, /\$order=issue_date DESC/);
    return dob;
  }
  if (dataset === '6bgk-3dad') return ecb;
  if (dataset === 'tesw-yqqr') {
    assert.match(u, /boroid='3' AND block='2186' AND lot='1'/);
    return reg;
  }
  return [];
};

const dobRow = (issue, category, type = 'LBLVIO-LOW PRESSURE BOILER       BOILER  REQUIRED', extra = {}) => ({number: `V${issue}`, issue_date: issue, violation_type: type, violation_category: category, description: 'FAILURE TO FILE INSPECTION', ...extra});
const ecbRow = (issue, status, severity, penalty, paid, extra = {}) => ({ecb_violation_number: `E${issue}`, ecb_violation_status: status, severity, violation_type: 'Construction', issue_date: issue, hearing_date: '20261202', penality_imposed: String(penalty), amount_paid: String(paid), balance_due: String(penalty - paid), violation_description: 'WORK WITHOUT A PERMIT', ...extra});

test('DOB and ECB violations are summarized by open status, severity and penalties due, with the newest five listed', async () => {
  const recorded = [];
  const res = await fetchNycPublicRecords({bbl: '3021860001'}, {
    record: src => { recorded.push(src); return {id: recorded.length}; },
    asOf: '2026-10-18',
    request: recordsRequest({
      dob: [dobRow('20251114', 'V-DOB VIOLATION - ACTIVE'), dobRow('20240301', 'V*-DOB VIOLATION - DISMISSED'), dobRow('20230101', 'V*-DOB VIOLATION - Resolved', 'E-ELEVATOR'), dobRow('20220101', 'VW-VIOLATION WORK WITHOUT PERMIT - ACTIVE', 'WWP-WORK WITHOUT PERMIT', {disposition_date: ''})],
      ecb: [ecbRow('20260928', 'ACTIVE', 'CLASS - 2', 1250, 0), ecbRow('20260730', 'ACTIVE', 'CLASS - 1', 10000, 2500), ecbRow('19910129', 'RESOLVE', 'Hazardous', 285, 285)],
      reg: [{registrationid: '374676', buildingid: '809319', boroid: '3', block: '2186', lot: '1', bin: '3388503', housenumber: '104', streetname: 'ROSS STREET', lastregistrationdate: '2025-08-19T00:00:00.000', registrationenddate: '2026-09-01T00:00:00.000'}],
    }),
  });
  assert.equal(res.endpointStatus.dobViolations, 'ok');
  assert.equal(res.endpointStatus.ecbViolations, 'ok');
  assert.equal(res.endpointStatus.hpdRegistrations, 'ok');
  const dob = res.dobViolationSummary;
  assert.deepEqual([dob.available, dob.returnedCount, dob.complete, dob.openCount, dob.closedCount], [true, 4, true, 2, 2]);
  assert.deepEqual(dob.openByType, {'LBLVIO-LOW PRESSURE BOILER BOILER REQUIRED': 1, 'WWP-WORK WITHOUT PERMIT': 1});
  assert.equal(dob.recentViolations.length, 4);
  assert.deepEqual(dob.recentViolations[0], {number: 'V20251114', issueDate: '2025-11-14', type: 'LBLVIO-LOW PRESSURE BOILER BOILER REQUIRED', category: 'V-DOB VIOLATION - ACTIVE', open: true, dispositionDate: null, description: 'FAILURE TO FILE INSPECTION'});
  const ecb = res.ecbViolationSummary;
  assert.deepEqual([ecb.returnedCount, ecb.openCount, ecb.resolvedCount], [3, 2, 1]);
  assert.deepEqual(ecb.openBySeverity, {'CLASS - 2': 1, 'CLASS - 1': 1});
  assert.deepEqual([ecb.totalPenaltyImposed, ecb.totalAmountPaid, ecb.totalBalanceDue, ecb.openBalanceDue], [11535, 2785, 8750, 8750]);
  assert.deepEqual(ecb.recentViolations[1], {ecbViolationNumber: 'E20260730', status: 'ACTIVE', severity: 'CLASS - 1', type: 'Construction', issueDate: '2026-07-30', hearingDate: '2026-12-02', hearingStatus: null, penaltyImposed: 10000, amountPaid: 2500, balanceDue: 7500, description: 'WORK WITHOUT A PERMIT'});
  // The registration fact: one current building, registered 2025-08-19 through 2026-09-01.
  const reg = res.hpdRegistration;
  assert.equal(reg.registeredMultipleDwelling, true);
  assert.deepEqual([reg.buildingCount, reg.lastRegistrationDate, reg.registrationEndDate], [1, '2025-08-19', '2026-09-01']);
  // Six weeks past the September 1 year end the renewal is due, not lapsed; a year on it has expired.
  assert.equal(reg.status, 'renewal_due');
  assert.match(res.proseReportingMandate, /year ended 2026-09-01 and the annual renewal due/);
  assert.deepEqual(['2026-08-01', '2026-10-18', '2027-10-18', null].map(asOf => hpdRegistrationStatus(asOf && '2026-09-01', asOf || '2026-10-18')), ['current', 'renewal_due', 'expired', 'none']);
  assert.deepEqual(reg.buildings[0], {registrationId: '374676', buildingId: '809319', bin: '3388503', address: '104 ROSS STREET', lastRegistrationDate: '2025-08-19', registrationEndDate: '2026-09-01'});
  // Each dataset is a cited source of its own.
  assert.deepEqual(Object.keys(res.sourceIds).sort(), ['dobViolations', 'ecbViolations', 'hpdRegistrations']);
  assert.deepEqual(recorded.map(s => s.title), [`NYC HPD Multiple Dwelling Registrations for BBL 3021860001`, `NYC DOB Violations for BBL 3021860001`, `NYC DOB ECB/OATH Violations for BBL 3021860001`]);
  assert.ok(recorded.every(s => s.kind === 'official_record' && s.url.includes('data.cityofnewyork.us')));
  // The agent is told to report the open violations, the penalties due and the registration.
  assert.match(res.proseReportingMandate, /2 open DOB violation\(s\) of 4 returned and 2 open ECB\/OATH violation\(s\) of 3 returned, with \$8,750 in ECB penalties still due/);
  assert.match(res.proseReportingMandate, /HPD lists 1 registered multiple dwelling\(s\) on this lot, last registered 2025-08-19/);
  assert.match(res.proseReportingMandate, /dobViolationSummary and ecbViolationSummary/);
  assert.doesNotMatch(res.proseReportingMandate, /—/);
});

test('a lot with no violations or registration says so, and an unavailable feed is never read as zero', async () => {
  const clean = await fetchNycPublicRecords({bbl: '3021860001'}, {request: recordsRequest()});
  assert.deepEqual([clean.dobViolationSummary.openCount, clean.ecbViolationSummary.openCount, clean.ecbViolationSummary.totalBalanceDue], [0, 0, 0]);
  assert.deepEqual(clean.hpdRegistration, {status: 'none', registeredMultipleDwelling: false, buildingCount: 0, lastRegistrationDate: null, registrationEndDate: null, buildings: []});
  assert.match(clean.proseReportingMandate, /HPD has no multiple dwelling registration for this lot/);
  assert.doesNotMatch(clean.proseReportingMandate, /Open violations are on record/);
  assert.deepEqual(clean.sourceIds, {});

  const down = await fetchNycPublicRecords({bbl: '3021860001'}, {request: recordsRequest({fail: ['3h2n-5cm9', '6bgk-3dad', 'tesw-yqqr']})});
  assert.match(down.endpointStatus.dobViolations, /unavailable \(NYC Open Data returned HTTP 503\)/);
  assert.match(down.endpointStatus.ecbViolations, /unavailable/);
  assert.match(down.endpointStatus.hpdRegistrations, /unavailable/);
  assert.deepEqual([down.dobViolationSummary.available, down.dobViolationSummary.complete, down.ecbViolationSummary.available], [false, false, false]);
  assert.equal(down.hpdRegistration.status, 'unavailable');
  assert.equal(down.hpdRegistration.registeredMultipleDwelling, null);
  assert.doesNotMatch(down.proseReportingMandate, /HPD has no multiple dwelling registration/);
  assert.ok(down.unavailableEndpoints.some(e => e.startsWith('dobViolations')) && down.unavailableEndpoints.some(e => e.startsWith('hpdRegistrations')));
  assert.match(down.proseReportingMandate, /never report that they returned "zero records"/);
});

test('an HPD registration raises the tenant screen on a 3+ unit pre-1974 building and states the reason', () => {
  const asOf = '2026-10-18';
  const base = {unitsRes: 4, yearBuilt: 1931, asOf};
  const unchecked = computeRentStabilizationProfile(base);
  // Before the registration feed is read for the lot, a building that must register is an unknown, never low.
  assert.deepEqual([unchecked.riskLevel, unchecked.hpdRegistration.status, unchecked.occupancyConfidence], ['unknown', 'unchecked', 'screening']);
  assert.ok(unchecked.reasons.some(r => /registration has not been checked/.test(r)));
  assert.equal(computeRentStabilizationProfile({...base, unitsRes: 2}).riskLevel, 'low', 'under three units no registration is required');
  const current = computeRentStabilizationProfile({...base, hpdLastRegistrationDate: '2025-08-19', hpdRegistrationEndDate: '2027-09-01T00:00:00.000', hpdRegistrationCheckedAt: 1});
  assert.equal(current.riskLevel, 'moderate');
  assert.equal(current.occupancyConfidence, 'raised');
  assert.deepEqual(current.hpdRegistration, {status: 'current', lastRegistrationDate: '2025-08-19', registrationEndDate: '2027-09-01'});
  assert.ok(current.reasons.some(r => /registration is current through 2027-09-01 \(last registered 2025-08-19\)/.test(r)));
  assert.match(current.summary, /occupied multiple dwelling/);
  const renewal = computeRentStabilizationProfile({...base, hpdRegistrationEndDate: '2026-09-01', hpdRegistrationCheckedAt: 1});
  assert.deepEqual([renewal.riskLevel, renewal.hpdRegistration.status, renewal.occupancyConfidence], ['moderate', 'renewal_due', 'raised']);
  assert.match(renewal.summary, /year ended 2026-09-01 and the annual renewal is due/);
  const expired = computeRentStabilizationProfile({...base, hpdLastRegistrationDate: '2019-06-01', hpdRegistrationEndDate: '2020-09-01', hpdRegistrationCheckedAt: 1});
  assert.deepEqual([expired.riskLevel, expired.hpdRegistration.status, expired.occupancyConfidence], ['moderate', 'expired', 'screening']);
  assert.match(expired.summary, /registration expired on 2020-09-01.*occupancy is unverified/);
  const missing = computeRentStabilizationProfile({...base, hpdRegistrationCheckedAt: 1});
  assert.deepEqual([missing.riskLevel, missing.hpdRegistration.status], ['moderate', 'none']);
  assert.match(missing.summary, /No HPD multiple dwelling registration is on file; buildings of three or more units must register/);
  // Six-plus pre-1974 stays high and a small or newer building stays where it was; occupancy is still unverified.
  const high = computeRentStabilizationProfile({unitsRes: 8, yearBuilt: 1920, hpdRegistrationEndDate: '2026-09-01', hpdRegistrationCheckedAt: 1, asOf});
  assert.deepEqual([high.riskLevel, high.occupancyStatus, high.rentRegulationStatus], ['high', 'unverified', 'unverified']);
  assert.equal(computeRentStabilizationProfile({unitsRes: 2, yearBuilt: 1920, hpdRegistrationCheckedAt: 1, asOf}).riskLevel, 'low');
  assert.match(computeRentStabilizationProfile({unitsRes: 2, yearBuilt: 1920, hpdRegistrationCheckedAt: 1, asOf}).summary, /not required under three units/);
  assert.equal(computeRentStabilizationProfile({unitsRes: 4, yearBuilt: 1990, hpdRegistrationEndDate: '2026-09-01', hpdRegistrationCheckedAt: 1, asOf}).riskLevel, 'low');
});

test('the sync reads HPD registrations for matched lots in batches, keeps a failed batch unchecked and revalues the deals', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-hpd-reg-')), store = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const lot = n => ({propertyId: `p-${n}`, listingType: 'for_sale', address: `${n} Ross St, Brooklyn, NY 11249`, streetLine: `${n} Ross St`, streetNumber: String(n), city: 'Brooklyn', state: 'NY', zipCode: '11249', latitude: 40.70 + n / 1e4, longitude: -73.96, listPrice: 2_000_000, style: 'multi_family', assetClass: 'multifamily_small', isDevelopmentCandidate: true});
  store.ingestListings([lot(1), lot(2), lot(3)], Date.UTC(2026, 9, 18));
  const pluto = n => ({bbl: `300100000${n}`, address: `${n} ROSS ST`, latitude: 40.70 + n / 1e4, longitude: -73.96, lotarea: 2500, bldgarea: 4000, residfar: 2, affresfar: 2.4, zonedist1: 'R6B', unitsres: 4, unitstotal: 4, yearbuilt: 1931, bldgclass: 'C3'});
  const batches = [];
  const nextYearEnd = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const result = await store.syncMarket({
    locations: ['Brooklyn, NY'],
    fullForSalePull: false,
    bridgeRunner: async () => ({allRows: []}),
    plutoFetcher: async () => [pluto(1), pluto(2), pluto(3)],
    geosearchFetcher: async () => null,
    hpdRegistrationFetcher: async bbls => {
      batches.push(bbls);
      assert.deepEqual(bbls, ['3001000001', '3001000002', '3001000003']);
      return [
        {boroid: '3', block: '100', lot: '1', registrationid: 'a', lastregistrationdate: '2025-08-19T00:00:00.000', registrationenddate: `${nextYearEnd}T00:00:00.000`},
        {boroid: '3', block: '100', lot: '1', registrationid: 'b', lastregistrationdate: '2024-08-19T00:00:00.000', registrationenddate: '2025-09-01T00:00:00.000'},
        {boroid: '3', block: '100', lot: '2', registrationid: 'c', lastregistrationdate: '2019-06-01T00:00:00.000', registrationenddate: '2020-09-01T00:00:00.000'},
      ];
    },
  });
  assert.equal(result.plutoMatchedCount, 3);
  assert.deepEqual(result.hpdRegistrations, {checked: 3, registered: 2, failedBatches: 0});
  assert.equal(batches.length, 1);
  const stored = store.query('SELECT property_id, hpd_last_registration l, hpd_registration_end e, hpd_registration_checked_at c FROM market_listings ORDER BY property_id');
  assert.deepEqual(stored.map(r => [r.property_id, r.l, r.e, r.c !== null]), [['p-1', '2025-08-19', nextYearEnd, true], ['p-2', '2019-06-01', '2020-09-01', true], ['p-3', null, null, true]]);
  const deals = Object.fromEntries(store.searchDeals({minUnusedZfa: 0}).map(d => [d.propertyId, d]));
  assert.deepEqual([deals['p-1'].rentStabilization.hpdRegistration.status, deals['p-2'].rentStabilization.hpdRegistration.status, deals['p-3'].rentStabilization.hpdRegistration.status], ['current', 'expired', 'none']);
  assert.ok(['moderate'].includes(deals['p-1'].rentStabilization.riskLevel));
  assert.ok(deals['p-1'].flashcardValuation.gates.some(g => g.id === 'tenants' && g.severity === 'review'), 'the stored valuation carries the tenants gate');
  assert.ok(deals['p-1'].rentStabilization.summary.includes(`current through ${nextYearEnd}`));
  // Already checked lots are not re-read for a month, and a failed read leaves the lot unchecked.
  assert.deepEqual(await store.backfillHpdRegistrations({hpdRegistrationFetcher: async () => { throw new Error('unreachable'); }}), {checked: 0, registered: 0, failedBatches: 0});
  store.write('UPDATE market_listings SET hpd_registration_checked_at = NULL, hpd_registration_end = NULL WHERE property_id = ?', 'p-3');
  assert.deepEqual(await store.backfillHpdRegistrations({hpdRegistrationFetcher: async () => { throw new Error('HTTP 503'); }}), {checked: 0, registered: 0, failedBatches: 1});
  assert.equal(store.one("SELECT hpd_registration_checked_at c FROM market_listings WHERE property_id = 'p-3'").c, null);
  assert.equal(hpdRegistrationBbl({boroid: '1', block: '460', lot: '29'}), '1004600029');
});
