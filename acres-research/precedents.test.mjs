import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {baseFarFor, curatedStandardFar, findPrecedents, createPrecedentTools} from './precedents.mjs';

const bis = (job, bbl, {type = 'NB', status = 'SIGNED OFF', filed = '06/01/2015', district = 'R7A', zfa, existing = '', special = '', landmarked = 'N', withdrawn = ''} = {}) => ({
  job__: job, job_type: type, job_status_descrp: status, withdrawal_flag: withdrawn, pre__filing_date: filed, signoff_date: '', bbl,
  borough: 'BROOKLYN', block: bbl.slice(1, 6), lot: bbl.slice(6), house__: '1', street_name: `JOB ${job}`, zoning_dist1: district,
  special_district_1: special, landmarked, existing_zoning_sqft: existing, proposed_zoning_sqft: String(zfa), proposed_no_of_stories: '8', proposed_dwelling_units: '40',
});
const plutoRow = (bbl, lotarea, extra = {}) => ({bbl: `${bbl}.00000000`, address: `LOT ${bbl}`, lotarea: String(lotarea), residfar: '4', affresfar: '5.01', commfar: '0', facilfar: '4', zonedist1: 'R7A', splitzone: false, ...extra});

// Serves DOB, PLUTO, ACRIS and ZAP fixtures by dataset, recording every query.
const stub = ({filings, pluto, legals = [], masters = [], zapBbl = [], zapProjects = [], calls = []}) => async url => {
  const u = decodeURIComponent(String(url).replace(/\+/g, ' '));
  calls.push(u);
  const ids = field => [...u.matchAll(new RegExp(`${field} (?:IN|in) \\(([^)]*)\\)`, 'g'))].flatMap(m => m[1].split(',').map(v => v.replace(/'/g, '').trim()));
  if (u.includes('ic3t-wcy2')) return filings;
  if (u.includes('64uk-42ks')) { const wanted = ids('bbl'); return pluto.filter(r => wanted.includes(r.bbl.split('.')[0]) || wanted.includes(String(r.appbbl || '').split('.')[0])); }
  if (u.includes('8h5j-fqxa')) {
    if (u.includes('document_id IN')) { const docs = ids('document_id'); return legals.filter(l => docs.includes(l.document_id)); }
    const lots = ids('lot'), block = u.match(/block='(\d+)'/)[1];
    return legals.filter(l => l.block === block && lots.includes(l.lot)).map(l => ({document_id: l.document_id}));
  }
  if (u.includes('bnx9-e6tj')) { const docs = ids('document_id'); return masters.filter(m => docs.includes(m.document_id)); }
  if (u.includes('2iga-a6mk')) { const bbls = ids('bbl'); return zapBbl.filter(z => bbls.includes(z.bbl)); }
  if (u.includes('hgx4-8ukb')) { const projects = ids('project_id'); return zapProjects.filter(p => projects.includes(p.project_id)); }
  throw new Error(`unexpected ${u}`);
};

test('the base is today\'s standard FAR for the district filed under, flagged when the lot was rezoned since', () => {
  assert.deepEqual(baseFarFor('R7A', {zonedist1: 'R7A', residfar: '4', commfar: '0', facilfar: '4'}), {far: 4, basis: 'pluto'});
  assert.equal(curatedStandardFar('R8A'), baseFarFor('R8A', {zonedist1: 'R7A', residfar: '4'}).far);
  assert.deepEqual(baseFarFor('M1-2', {zonedist1: 'R7X', residfar: '5'}), {far: 5, basis: 'pluto_current_district', rezonedSinceFiling: true});
  assert.equal(baseFarFor('M1-2', {zonedist1: 'R7X'}), null);
});

test('precedents rank built projects above their base, group one zoning lot filed as several jobs, and set outliers apart', async () => {
  const calls = [];
  const filings = [
    bis('A', '3001000010', {zfa: 30000}), // 5,000 sq ft at 4 FAR = 20,000 base: 50% above
    bis('B1', '3001000020', {zfa: 26000, filed: '07/11/2017'}), bis('B2', '3001000021', {zfa: 26000, filed: '07/11/2017'}), // one zoning lot of 2 x 2,500, above the 5.01 affordable FAR
    bis('C', '3001000030', {zfa: 9000}), // within base
    bis('D', '3001000040', {zfa: 90000}), // 3,000 sq ft: FAR 30, an outlier
    bis('E', '3001000050', {zfa: 50000, status: 'PLAN EXAM - DISAPPROVED'}),
    bis('F', '3001000060', {zfa: 50000, status: 'WITHDRAWN'}),
    bis('G', '3001000070', {type: 'A1', zfa: 12000, existing: '12000', status: 'PERMIT ISSUED - ENTIRE JOB/WORK'}),
    bis('H', '3001007501', {zfa: 33000, special: 'MX-2'}), // a condominium of original lot 80
    bis('I', '3001000090', {zfa: 25000}), // FAR 5.0, within the affordable FAR
  ];
  const pluto = [
    plutoRow('3001000010', 5000), plutoRow('3001000020', 2500), plutoRow('3001000021', 2500), plutoRow('3001000030', 3000),
    plutoRow('3001000040', 3000), plutoRow('3001000050', 5000), plutoRow('3001000060', 5000), plutoRow('3001000070', 2000),
    plutoRow('3001007501', 6000, {appbbl: '3001000080.00000000'}), plutoRow('3001000090', 5000),
  ];
  const legals = [
    {document_id: 'Z1', borough: '3', block: '100', lot: '10'}, {document_id: 'Z1', borough: '3', block: '100', lot: '11'},
    {document_id: 'AR1', borough: '3', block: '100', lot: '80'},
  ];
  const masters = [{document_id: 'Z1', doc_type: 'ZONE', crfn: 'C-Z1', recorded_datetime: '2014-01-02T00:00:00.000'}, {document_id: 'AR1', doc_type: 'AIRRIGHT', crfn: 'C-AR1', recorded_datetime: '2014-05-02T00:00:00.000'}];
  const zapBbl = [{project_id: 'P1', bbl: '3001000010'}];
  const zapProjects = [{project_id: 'P1', project_name: 'Lot A special permit', actions: 'ZS', public_status: 'Completed', completed_date: '2014-09-01T00:00:00.000'}];
  const out = await findPrecedents({communityDistrict: '307', minPercentAboveBase: 5}, {request: stub({filings, pluto, legals, masters, zapBbl, zapProjects, calls})});

  // E is disapproved, F withdrawn and G an alteration adding no floor area.
  assert.equal(out.coverage.approvedOrSignedOff, 7);
  assert.deepEqual(out.precedents.map(p => [p.jobNumber, p.percentAboveBase]), [['A', 50], ['H', 37.5], ['B1', 30], ['I', 25]]);
  const [a, h, b] = out.precedents;
  assert.match(a.likelyMechanisms.join(' '), /Zoning lot merger/);
  assert.match(a.likelyMechanisms.join(' '), /City Planning action on the lot: Lot A special permit \(ZS\)/);
  assert.deepEqual(a.zoningLotInstruments.map(d => [d.docType, d.lots]), [['ZONE', ['3-100-10', '3-100-11']]]);
  // The condominium's air rights deed is recorded on its original lot.
  assert.deepEqual(h.originalLots, ['3001000080']);
  assert.match(h.likelyMechanisms.join(' '), /Air or development rights transfer.*special district MX-2/);
  assert.deepEqual([b.taxLots, b.jobNumbers, b.lotAreaSqft], [['3001000020', '3001000021'], ['B1', 'B2'], 5000]);
  assert.match(b.unexplained, /No public record found/);
  assert.match(out.precedents[3].likelyMechanisms.join(' '), /Within the qualifying affordable FAR \(5\.01\)/);
  assert.deepEqual(out.outliers.map(o => [o.jobNumber, o.filedFar]), [['D', 30]]);
  assert.ok(calls.some(c => c.includes("community___board='307'")));
});

test('the tool defaults to the subject\'s community district and records its source', async () => {
  const recorded = [];
  const tools = createPrecedentTools({getProperty: () => ({cd: 307}), record: s => { recorded.push(s); return {id: 9}; }, request: stub({filings: [bis('A', '3001000010', {zfa: 30000})], pluto: [plutoRow('3001000010', 5000)]})});
  const out = await tools.handlers.acres_far_precedents({});
  assert.equal(out.scope.communityDistrict, '307');
  assert.equal(out.sourceId, 9);
  assert.match(recorded[0].title, /community district 307/);
  assert.match(out.proseReportingMandate, /unexplained rather than guessing/);
  await assert.rejects(createPrecedentTools({request: stub({filings: [], pluto: []})}).handlers.acres_far_precedents({}), /communityDistrict/);
});

test('the research host installer ships the precedents module', () => {
  assert.match(readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8'), /\bprecedents\.mjs\b/);
});
