import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchNycPublicRecords} from './nycdb.mjs';

// Serves recorded NYC Open Data rows by dataset: rows filtered by the query's document_id list and cut
// at its $limit, as Socrata does. ACRIS legals are served by lot and by document id.
function openData(tables, {fail = []} = {}) {
  const calls = [];
  const request = async url => {
    const u = decodeURIComponent(String(url));
    calls.push(u);
    const dataset = u.match(/resource\/([a-z0-9-]+)\.json/)[1];
    if (fail.includes(dataset)) throw new Error('NYC Open Data returned HTTP 500');
    const limit = Number(u.match(/\$limit=(\d+)/)[1]);
    const ids = u.match(/document_id IN \(([^)]*)\)/)?.[1].split(',').map(id => id.replace(/'/g, ''));
    let rows = tables[dataset] ?? [];
    if (ids) rows = rows.filter(r => ids.includes(r.document_id));
    if (u.includes("doc__='01'")) rows = rows.filter(r => r.doc__ === '01');
    if (dataset === '8h5j-fqxa' && u.includes('$select=document_id')) rows = rows.map(r => ({document_id: r.document_id}));
    return rows.slice(0, limit);
  };
  return {request, calls};
}
const filing = i => ({job__: `1210000${String(i).padStart(2, '0')}`, doc__: '02', job_type: 'A2', job_status: 'R', job_status_descrp: 'PERMIT ISSUED', latest_action_date: '2024-01-01'});
const legals = ids => ids.map(document_id => ({document_id, borough: '1', block: '88', lot: '12', air_rights: 'N', easement: 'N'}));
const master = (document_id, doc_type, recorded) => ({document_id, doc_type, crfn: `CRFN-${document_id}`, document_date: `${recorded}T00:00:00.000`, recorded_datetime: `${recorded}T00:00:00.000`});
const party = (document_id, party_type, name) => ({document_id, party_type, name});

test('a dataset that returns its full row limit is flagged truncated and the answer is told so', async () => {
  const {request} = openData({'ic3t-wcy2': Array.from({length: 15}, (_, i) => filing(i)), 'bs8b-p36w': Array.from({length: 10}, (_, i) => ({job_number: `J${i}`}))});
  const res = await fetchNycPublicRecords({bbl: '1000880012'}, {request});
  assert.deepEqual(res.datasetCoverage.dobBis, {returnedRows: 15, rowLimit: 15, truncated: true});
  assert.deepEqual(res.datasetCoverage.certificatesOfOccupancy, {returnedRows: 10, rowLimit: 10, truncated: true});
  assert.equal(res.datasetCoverage.dobNow.truncated, false);
  assert.deepEqual(res.submittalForensics.truncatedDatasets, ['dobBis', 'certificatesOfOccupancy']);
  assert.match(res.proseReportingMandate, /Row limits reached: dobBis returned its limit of 15 rows; certificatesOfOccupancy returned its limit of 10 rows\. .*never as the complete history/);
});

test('a dataset below its row limit is not truncated and an unavailable one has no coverage', async () => {
  const {request} = openData({'ic3t-wcy2': Array.from({length: 14}, (_, i) => filing(i))}, {fail: ['w9ak-ipjd']});
  const res = await fetchNycPublicRecords({bbl: '1000880012'}, {request});
  assert.deepEqual(res.datasetCoverage.dobBis, {returnedRows: 14, rowLimit: 15, truncated: false});
  assert.equal(res.datasetCoverage.dobNow, null);
  assert.deepEqual(res.submittalForensics.truncatedDatasets, []);
  assert.doesNotMatch(res.proseReportingMandate, /Row limits reached/);
});

test('certificates of occupancy carry the dwelling units the dataset publishes and say use is not published', async () => {
  const {request} = openData({'bs8b-p36w': [{job_number: '321596340', job_type: 'NB', c_o_issue_date: '2026-10-19T00:00:00.000', issue_type: 'Final', application_status_raw: 'Issued', filing_status_raw: 'New', pr_dwelling_unit: '17', ex_dwelling_unit: '0', bin_number: '3428698'}]});
  const res = await fetchNycPublicRecords({bbl: '3038550040'}, {request});
  assert.deepEqual(res.certificatesOfOccupancy, [{
    jobNumber: '321596340', jobType: 'NB', issueDate: '2026-10-19', issueType: 'Final', status: 'Issued', filingStatus: 'New',
    proposedDwellingUnits: 17, existingDwellingUnits: 0, bin: '3428698', occupancyDetail: 'not published in this dataset',
    certificatesUrl: 'https://a810-bisweb.nyc.gov/bisweb/COsByLocationServlet?allbin=3428698',
  }]);
  assert.match(res.proseReportingMandate, /dwelling units each records \(the dataset does not publish use or occupancy group/);
});

const chain = {
  '8h5j-fqxa': legals(['DEED10', 'MTG15', 'DEED18', 'SAT21']),
  'bnx9-e6tj': [master('DEED10', 'DEED', '2010-03-01'), master('MTG15', 'MTGE', '2015-06-01'), master('DEED18', 'DEED', '2018-09-12'), master('SAT21', 'SAT', '2021-02-02')],
  '636b-3b5g': [
    party('DEED10', '1', 'FIRST HOLDER'), party('DEED10', '2', 'OLD OWNER LLC'),
    party('MTG15', '1', 'OLD OWNER LLC'), party('MTG15', '2', 'CITY BANK NA'),
    party('DEED18', '1', 'OLD OWNER LLC'), party('DEED18', '2', 'NEW OWNER LLC'), party('DEED18', '2', 'NEW  OWNER LLC'),
    party('SAT21', '1', 'OLD OWNER LLC'), party('SAT21', '2', 'CITY BANK NA'),
  ],
};

test('deed and mortgage parties come from ACRIS and the owner of record from the latest deed, with later documents named', async () => {
  const recorded = [];
  const {request, calls} = openData(chain);
  const res = await fetchNycPublicRecords({bbl: '1000880012'}, {request, record: s => { recorded.push(s); return {id: recorded.length}; }});
  assert.ok(calls.some(u => u.includes('636b-3b5g') && /document_id IN \(.*DEED18.*\)/.test(u)));
  assert.deepEqual(res.deedHistory.map(d => [d.documentId, d.recordedDate, d.grantors, d.grantees]), [
    ['DEED18', '2018-09-12', ['OLD OWNER LLC'], ['NEW OWNER LLC']],
    ['DEED10', '2010-03-01', ['FIRST HOLDER'], ['OLD OWNER LLC']],
  ]);
  assert.equal(res.currentOwner.status, 'latest_deed_predates_later_documents');
  assert.deepEqual(res.currentOwner.names, ['NEW OWNER LLC']);
  assert.deepEqual(res.currentOwner.deed, {documentId: 'DEED18', docType: 'DEED', crfn: 'CRFN-DEED18', documentDate: '2018-09-12', recordedDate: '2018-09-12'});
  assert.deepEqual(res.currentOwner.laterDocuments.map(d => [d.documentId, d.docType]), [['SAT21', 'SAT']]);
  assert.deepEqual(res.acrisDocuments.find(d => d.documentId === 'MTG15').parties, [{role: 'borrower', name: 'OLD OWNER LLC'}, {role: 'lender', name: 'CITY BANK NA'}]);
  assert.match(res.proseReportingMandate, /latest deed indexed on lot 12 is DEED \(CRFN CRFN-DEED18, dated 2018-09-12, recorded 2018-09-12\) from OLD OWNER LLC to NEW OWNER LLC\. Report NEW OWNER LLC as the owner of record per that deed/);
  assert.match(res.proseReportingMandate, /1 document\(s\) \(SAT\) were recorded on the lot after that deed: say the deed is older than them/);
  assert.equal(res.sourceIds.acrisParties, recorded.findIndex(s => /ACRIS Real Property Parties/.test(s.title)) + 1);
  assert.match(recorded.find(s => /Parties/.test(s.title)).url, /636b-3b5g/);
});

test('an undated deed never outranks a dated one: it sorts last and does not name the owner', async () => {
  const undated = {document_id: 'DEEDX', doc_type: 'DEED', crfn: 'CRFN-DEEDX'};
  const {request} = openData({
    ...chain,
    '8h5j-fqxa': legals(['DEED10', 'MTG15', 'DEED18', 'SAT21', 'DEEDX']),
    'bnx9-e6tj': [...chain['bnx9-e6tj'], undated],
    '636b-3b5g': [...chain['636b-3b5g'], party('DEEDX', '1', 'SOME GRANTOR'), party('DEEDX', '2', 'UNDATED GRANTEE LLC')],
  });
  const res = await fetchNycPublicRecords({bbl: '1000880012'}, {request});
  assert.deepEqual(res.deedHistory.map(d => d.documentId), ['DEED18', 'DEED10', 'DEEDX']);
  assert.deepEqual([res.deedHistory[2].documentDate, res.deedHistory[2].recordedDate], [null, null]);
  assert.deepEqual(res.currentOwner.names, ['NEW OWNER LLC']);
  assert.equal(res.currentOwner.deed.documentId, 'DEED18');
});

test('a latest deed with nothing recorded after it is the owner of record without a caveat', async () => {
  const {request} = openData({...chain, '8h5j-fqxa': legals(['DEED10', 'MTG15', 'DEED18']), 'bnx9-e6tj': chain['bnx9-e6tj'].filter(m => m.document_id !== 'SAT21')});
  const res = await fetchNycPublicRecords({bbl: '1000880012'}, {request});
  assert.equal(res.currentOwner.status, 'latest_deed');
  assert.deepEqual(res.currentOwner.laterDocuments, []);
  assert.doesNotMatch(res.proseReportingMandate, /recorded on the lot after that deed/);
});

test('no owner is named when the lot has no deed, the parties cannot be read, or the lot is a condominium billing lot', async () => {
  const noDeed = await fetchNycPublicRecords({bbl: '1000880012'}, {request: openData({...chain, '8h5j-fqxa': legals(['MTG15']), 'bnx9-e6tj': [master('MTG15', 'MTGE', '2015-06-01')]}).request});
  assert.deepEqual([noDeed.currentOwner.status, noDeed.currentOwner.names], ['unresolved', null]);
  assert.match(noDeed.proseReportingMandate, /does not establish an owner of record for this lot: No deed is indexed on lot 12 in ACRIS\. Do not name a current owner from ACRIS\./);

  const failed = await fetchNycPublicRecords({bbl: '1000880012'}, {request: openData(chain, {fail: ['636b-3b5g']}).request});
  assert.match(failed.endpointStatus.acrisParties, /unavailable/);
  assert.ok(failed.unavailableEndpoints.some(e => e.startsWith('acrisParties')));
  assert.equal(failed.currentOwner.names, null);assert.match(failed.currentOwner.reason, /parties of the latest deed .* could not be read/);
  assert.equal(failed.deedHistory[0].grantees, null);

  const condo = await fetchNycPublicRecords({bbl: '1000887501'}, {request: openData({...chain, '8h5j-fqxa': chain['8h5j-fqxa'].map(r => ({...r, lot: '7501'}))}).request});
  assert.equal(condo.currentOwner.names, null);assert.match(condo.currentOwner.reason, /condominium billing lot/);
});
