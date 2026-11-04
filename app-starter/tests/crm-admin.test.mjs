import test from 'node:test';
import assert from 'node:assert/strict';
import {adminTabFromSearch, filterContacts, filingFacts, summaryLine, STATUS_LABELS, jobsByContact, researchStatus, spendLine, planLine, usd, progressLines} from '../public/crm-admin.js';

const contacts = [
  {id: '1', name: 'Anthony Keizner', status: 'new', borough: 'Manhattan', email: null, notes: null},
  {id: '2', name: 'Eugene Dolphin', status: 'reached_out', borough: 'Queens', email: 'eugene@example.com', notes: 'Asked for a call back'},
  {id: '3', name: 'Jorge Avila', status: 'do_not_contact', borough: 'Queens', company: 'Avila Design Workshop'},
];

test('the outreach list filters by text across name, email, company and notes, and by status', () => {
  assert.deepEqual(filterContacts(contacts, {query: 'queens'}).map((c) => c.id), ['2', '3']);
  assert.deepEqual(filterContacts(contacts, {query: 'call back'}).map((c) => c.id), ['2']);
  assert.deepEqual(filterContacts(contacts, {query: 'avila design'}).map((c) => c.id), ['3']);
  assert.deepEqual(filterContacts(contacts, {status: 'new'}).map((c) => c.id), ['1']);
  assert.deepEqual(filterContacts(contacts, {query: 'queens', status: 'reached_out'}).map((c) => c.id), ['2']);
  assert.equal(filterContacts(contacts).length, 3);
});

test('every status the server allows has a label', () => {
  assert.deepEqual(Object.keys(STATUS_LABELS), ['new', 'researching', 'reached_out', 'replied', 'beta_invited', 'beta_active', 'not_interested', 'do_not_contact']);
});

test('a shared admin link opens the right tab and ignores anything else', () => {
  assert.equal(adminTabFromSearch('?admin=outreach'), 'crm');
  assert.equal(adminTabFromSearch('?wallet=1&admin=market'), 'market');
  assert.equal(adminTabFromSearch('?admin=other'), null);
  assert.equal(adminTabFromSearch(''), null);
  assert.equal(adminTabFromSearch(undefined), null);
});

test('the identity filter shows confirmed, needs review and mismatch contacts', () => {
  const people = [{id: 'a', details: {identity: {verdict: 'confirmed'}}}, {id: 'b', details: {identity: {verdict: 'mismatch'}}}, {id: 'c', details: null}];
  assert.deepEqual(filterContacts(people, {verdict: 'mismatch'}).map((c) => c.id), ['b']);
  assert.deepEqual(filterContacts(people, {verdict: ''}).map((c) => c.id), ['a', 'b', 'c']);
});

test('research status reads in plain words from the latest job of each step', () => {
  const jobs = jobsByContact([
    {contact: 'a', step: 'contacts', status: 'failed', created: 1, error: 'The lookup timed out.'},
    {contact: 'a', step: 'contacts', status: 'running', created: 2},
    {contact: 'a', step: 'identity', status: 'queued', created: 3},
    {contact: 'b', step: 'identity', status: 'running', created: 4},
    {contact: 'c', step: 'profile', status: 'done', created: 5, finished: 6},
    {contact: 'c', step: 'contacts', status: 'skipped', created: 6, error: 'No matching profile was found.'},
  ]);
  assert.equal(researchStatus(jobs.get('a'), 'contacts'), 'Looking up…');
  assert.equal(researchStatus(jobs.get('a'), 'identity'), 'Waiting to check identity');
  assert.equal(researchStatus(jobs.get('b'), 'identity'), 'Checking identity, about 8 minutes');
  assert.equal(researchStatus(jobs.get('c'), 'contacts'), 'No matching profile was found.');
  assert.equal(researchStatus(undefined, 'contacts'), '');
});

test('spend and the bulk estimate are stated in dollars', () => {
  assert.equal(usd(1238097), '$1.24');
  assert.equal(spendLine({todayMicros: 3200000, dailyCapMicros: 50e6, run: {spentMicros: 1100000, capMicros: 12e6, active: 4}}),
    'Spent today $3.20 of $50.00 · This run $1.10 of $12.00, 4 steps left');
  assert.equal(spendLine({todayMicros: 0, dailyCapMicros: 50e6, run: null}), 'Spent today $0.00 of $50.00');
  assert.equal(planLine({contacts: 37, estimateMicros: 90650000}), 'Enrich 37 contacts: about $90.65. Lookups run first, then an identity check of about 8 minutes each.');
});

test('live progress counts each step by state for the last day', () => {
  const now = 10 * 86400000;
  const jobs = [
    {step: 'contacts', status: 'running', created: now - 10}, {step: 'contacts', status: 'running', created: now - 9},
    {step: 'contacts', status: 'queued', created: now - 8}, {step: 'contacts', status: 'done', created: now - 7},
    {step: 'identity', status: 'failed', created: now - 6}, {step: 'profile', status: 'done', created: now - 2 * 86400000},
  ];
  assert.deepEqual(progressLines(jobs, now), ['Contact info: 2 running, 1 queued, 1 done', 'Identity check: 1 failed']);
  assert.deepEqual(progressLines([], now), []);
});

test('the outreach list filters by segment and shows the filings behind a developer', () => {
  const details = {segment: 'developers', filings: 12, units: 1104, boroughs: ['Queens', 'Brooklyn'], firstFiling: '2023-11-02', lastFiling: '2026-09-30',
    recentFilings: [{date: '2026-09-30', address: '41-12 MAIN STREET', borough: 'Queens', units: 48, job: 'Q01400001', status: 'Approved'}]};
  const people = [{id: 'd', name: 'Ami Weinstock', company: 'Ami Weinstock', status: 'new', borough: 'Queens', details},
    {id: 'p', name: 'Pat Buyer', status: 'researching', borough: 'Queens', details: {segment: 'parked', primaryLots: 2}}, {id: 'x', name: 'No Segment', status: 'new'}];
  assert.deepEqual(filterContacts(people, {segment: 'parked'}).map((c) => c.id), ['p']);
  assert.deepEqual(filterContacts(people, {segment: ''}).map((c) => c.id), ['d', 'p', 'x']);
  assert.equal(summaryLine(people[0]), 'Developer · Queens · 12 filings · 1,104 units');
  assert.equal(summaryLine(people[1]), 'Queens · 2 lots');
  assert.deepEqual(filingFacts(details), {totals: '12 new-building filings · 1,104 units · Queens, Brooklyn · 2023-11-02 to 2026-09-30',
    recent: ['2026-09-30: 41-12 MAIN STREET, Queens, 48 units (job Q01400001, Approved)']});
  assert.equal(filingFacts({primaryLots: 2}), null);
});
