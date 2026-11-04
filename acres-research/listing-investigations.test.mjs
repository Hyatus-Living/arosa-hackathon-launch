import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ListingInvestigations,INVESTIGATION_OBJECTIVES,investigationPrompt,recordPlan} from './listing-investigations.mjs';
import {ListingResearchProvider,ResearchProviderError,RESEARCH_AGENTS,reviewedReport,fetchReviewSources,memoProblems,reviewEvidence} from './listing-investigation-provider.mjs';
import {DEPTH_POLICY,OBJECTIVE_POLICY,QUESTION_SECTION,REVIEW_PROMPT,CONTRACT_AUDIT_PROMPT,memoContract} from './listing-investigation-prompt.mjs';

// Minimal store over an in-memory database: the same one/query/write surface ChatStore exposes.
function fakeStore() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    one: (sql, ...args) => db.prepare(sql).get(...args),
    query: (sql, ...args) => db.prepare(sql).all(...args),
    write: (sql, ...args) => db.prepare(sql).run(...args),
    projectView: () => null,
  };
}

const secrets = {LISTING_RESEARCH_ENABLED: true, GEMINI_RESEARCH_API_KEY: 'test-key', BILLING_ENABLED: false};
const providerDown = {create: async () => { throw new Error('provider down'); }};

function investigations(store) {
  return new ListingInvestigations({store, secrets, provider: providerDown, records: async () => ({status: 'not supplied'})});
}

function insertJob(store, job) {
  store.write('INSERT INTO listing_investigations VALUES(?,?,?,?,?,?,?)', job.id, job.owner, job.listingId, job.status, job.created, job.updated, JSON.stringify(job));
}

const stuckJob = (overrides = {}) => ({
  id: randomUUID(), owner: 'owner-1', listingId: 'listing-1', projectId: null, requestHash: 'x',
  snapshot: {address: '1 Example St', bbl: '3000010001'}, depth: 'standard', objective: 'acquisition screening',
  question: '', status: 'needs_attention', created: Date.now() - 3600_000, updated: Date.now() - 3600_000,
  deadline: Date.now() - 60_000, promptVersion: 'test', providerId: null, cursor: null, billing: 'pending',
  rate: null, dispatchGuard: randomUUID(), cancelRequested: false, result: null,
  error: 'The server restarted during dispatch.', usage: null, ...overrides,
});

test('a provider-less needs_attention job past its deadline auto-fails on recover, billing stays pending', async t => {
  const store = fakeStore();
  const jobs = investigations(store);
  t.after(() => jobs.close());
  const stuck = stuckJob();
  insertJob(store, stuck);

  // Before expiry the account is locked and neither exit works: this is the lockout being fixed.
  await assert.rejects(() => jobs.cancel('owner-1', stuck.id), /reconciliation is required/);
  assert.throws(() => jobs.resume('owner-1', stuck.id), /cannot be reconnected/);

  jobs.recover();
  const after = jobs.get('owner-1', stuck.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /expired without a provider interaction/);
  assert.equal(after.billing, 'pending', 'the hold is left pending for reconciliation, never settled or released');

  // The lock is free: a second investigation can be created.
  const created = jobs.create('owner-1', {id: randomUUID(), listingId: 'listing-2'}, {id: 'listing-2', address: '2 Example St'});
  assert.equal(created.status, 'queued');
});

test('create expires a stale provider-less job even without recover, and never expires a live one early', async t => {
  const store = fakeStore();
  const jobs = investigations(store);
  t.after(() => jobs.close());

  const live = stuckJob({deadline: Date.now() + 3600_000});
  insertJob(store, live);
  assert.throws(() => jobs.create('owner-1', {id: randomUUID(), listingId: 'listing-2'}, {id: 'listing-2'}), /already active or needs attention/);
  assert.equal(jobs.get('owner-1', live.id).status, 'needs_attention');

  const stale = stuckJob({owner: 'owner-2'});
  insertJob(store, stale);
  const created = jobs.create('owner-2', {id: randomUUID(), listingId: 'listing-3'}, {id: 'listing-3', address: '3 Example St'});
  assert.equal(created.status, 'queued');
  assert.equal(jobs.get('owner-2', stale.id).status, 'failed');
  assert.equal(jobs.get('owner-2', stale.id).billing, 'pending');
});

test('a needs_attention job with a provider interaction is not auto-failed inside its attention window', async t => {
  const store = fakeStore();
  const jobs = investigations(store);
  t.after(() => jobs.close());
  const withProvider = stuckJob({providerId: 'interaction-1'});
  insertJob(store, withProvider);
  jobs.recover();
  assert.equal(jobs.get('owner-1', withProvider.id).status, 'needs_attention');
  assert.equal(jobs.expireProviderlessAttention(jobs.row(withProvider.id)), false);
  assert.equal(jobs.expireAttention(jobs.row(withProvider.id)), false, 'the attention window runs a week past the deadline');
});

test('resume after a deadline cancel retrieves the completed interaction instead of discarding it', async t => {
  const provider = fakeProvider();
  const {store, jobs} = setup(t, {provider});
  const stuck = stuckJob({providerId: 'interaction-done', cancelRequested: true, cancelSent: true, deadlineCancellationAttempted: true, billing: 'not_started'});
  insertJob(store, stuck);
  const resumed = jobs.resume('owner-1', stuck.id);
  assert.equal(resumed.status, 'in_progress');
  const done = await statusOf(jobs, 'owner-1', stuck.id, ['completed']);
  assert.ok(done.result, 'the reviewed result is kept');
  assert.deepEqual(provider.calls.cancel, [], 'resuming never re-sends the old cancel');
});

test('a provider-ful needs_attention job abandoned past its attention expiry auto-fails and frees the lock', async t => {
  const store = fakeStore();
  const jobs = investigations(store);
  t.after(() => jobs.close());
  const stuck = stuckJob({providerId: 'interaction-1', attentionExpiresAt: Date.now() - 1000});
  insertJob(store, stuck);
  jobs.recover();
  const after = jobs.get('owner-1', stuck.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /left needing attention and expired/);
  assert.equal(after.billing, 'pending', 'billing is left exactly as recorded');
  const created = jobs.create('owner-1', {id: randomUUID(), listingId: 'listing-2'}, {id: 'listing-2', address: '2 Example St'});
  assert.equal(created.status, 'queued');
});

// A fake research provider: create/get/events/cancel/review, scriptable per test.
const draftInteraction = {status: 'completed', outputs: [{type: 'text', text: 'Draft finding.', annotations: [{type: 'url_citation', url: 'https://example.com/a', title: 'Source A', start_index: 0, end_index: 14}]}]};
function fakeProvider({status = () => 'completed', fail = null} = {}) {
  const calls = {create: [], get: 0, cancel: [], events: 0, review: []};
  return {
    calls,
    async create(depth, prompt) { calls.create.push({depth, prompt}); return {id: `interaction-${calls.create.length}`}; },
    async get() { calls.get++; if (fail) throw fail; const value = status(calls); return value === 'completed' ? draftInteraction : {status: value}; },
    async cancel(id) { calls.cancel.push(id); return {}; },
    async *events(_id, _cursor, signal) { calls.events++; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true})); },
    async review(draft, context) { calls.review.push({draft, context}); return {answer: 'Reviewed memo [1]', sources: draft.sources, unresolvedCitationCount: 0, review: {}}; },
  };
}
function fakeWallet() {
  const calls = [];
  return {
    calls,
    async reserve(_owner, key, amount) { calls.push(['reserve', key, amount]); },
    async dispatch(_owner, key) { calls.push(['dispatch', key]); },
    async settle(_owner, key, amount) { calls.push(['settle', key, amount]); },
    async pending(_owner, key) { calls.push(['pending', key]); },
    async releaseBeforeAttempt(_owner, key) { calls.push(['release', key]); },
  };
}
const rate = {version: 'test-1', basis: 'Flat test price per investigation.', mode: 'estimated_call', amountMicros: 2_000_000, reserveMicros: 3_000_000};
const billedSecrets = {...secrets, BILLING_RATES: {listing_research_standard: rate, listing_research_max: {...rate, amountMicros: 5_000_000, reserveMicros: 6_000_000}}};
const PROJECT = randomUUID();
const deal = {id: 'listing-1', address: '1 Example St', bbl: '3000010001'};
const input = (overrides = {}) => ({id: randomUUID(), listingId: 'listing-1', ...overrides});

function setup(t, {provider = fakeProvider(), wallet = null, records = async () => ({status: 'not supplied'}), secretsOverride = secrets} = {}) {
  const store = fakeStore();
  store.projectView = (owner, id) => (owner === 'owner-1' && id === PROJECT ? {id} : null);
  const jobs = new ListingInvestigations({store, secrets: secretsOverride, provider, wallet, records});
  t.after(() => jobs.close());
  return {store, jobs, provider, wallet};
}
async function until(read, label) {
  for (let i = 0; i < 500; i++) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error(`Timed out waiting for ${label}`);
}
const statusOf = (jobs, owner, id, statuses) => until(() => { const job = jobs.get(owner, id); return statuses.includes(job?.status) && job; }, statuses.join('/'));

test('create rejects invalid requests before anything is stored or dispatched', t => {
  const {jobs, provider, store} = setup(t);
  const status = (fn, code) => assert.throws(fn, error => error.status === code);
  status(() => jobs.create('owner-1', input({id: 'not-a-uuid'}), deal), 400);
  status(() => jobs.create('owner-1', input({depth: 'ultra'}), deal), 400);
  status(() => jobs.create('owner-1', input({depth: 'constructor'}), deal), 400);
  status(() => jobs.create('owner-1', input({objective: 'flip it'}), deal), 400);
  status(() => jobs.create('owner-1', input({question: 42}), deal), 400);
  status(() => jobs.create('owner-1', input({question: 'x'.repeat(1001)}), deal), 400);
  status(() => jobs.create('owner-1', input({listingId: 'listing-2'}), deal), 400);
  status(() => jobs.create('owner-1', input({projectId: 'nope'}), deal), 400);
  status(() => jobs.create('owner-1', input({projectId: randomUUID()}), deal), 404);
  assert.equal(store.one('SELECT COUNT(*) AS count FROM listing_investigations').count, 0);
  assert.equal(provider.calls.create.length, 0);
});

test('create is unavailable when research is not configured for the depth', t => {
  const {jobs} = setup(t, {secretsOverride: {...secrets, LISTING_RESEARCH_ENABLED: false}});
  assert.throws(() => jobs.create('owner-1', input(), deal), error => error.status === 503);
  const billed = setup(t, {wallet: fakeWallet(), secretsOverride: {...secrets, BILLING_RATES: {listing_research_standard: rate}}});
  assert.equal(billed.jobs.policy().modes.max.enabled, false, 'a billed depth without a valid rate is off');
  assert.throws(() => billed.jobs.create('owner-1', input({depth: 'max'}), deal), error => error.status === 503);
});

test('replaying a request ID returns the same job; changed parameters or another owner are refused', async t => {
  const {jobs, provider} = setup(t);
  const request = input({question: 'Who manages the owner LLC?', projectId: PROJECT});
  const first = jobs.create('owner-1', request, deal);
  const replay = jobs.create('owner-1', {...request}, deal);
  assert.equal(replay.id, first.id);
  assert.throws(() => jobs.create('owner-1', {...request, question: 'Something else'}, deal), error => error.status === 409);
  assert.throws(() => jobs.create('owner-2', {...request}, deal), error => error.status === 409);
  await statusOf(jobs, 'owner-1', first.id, ['completed']);
  assert.equal(jobs.create('owner-1', {...request}, deal).status, 'completed');
  assert.equal(provider.calls.create.length, 1, 'a replay never dispatches a second provider interaction');
});

test('another account cannot read, list, stream, cancel or resume an investigation', async t => {
  const {jobs} = setup(t);
  const job = jobs.create('owner-1', input(), deal);
  await statusOf(jobs, 'owner-1', job.id, ['completed']);
  assert.equal(jobs.get('owner-2', job.id), null);
  assert.deepEqual(jobs.list('owner-2', 'listing-1'), []);
  assert.deepEqual(jobs.events('owner-2', job.id), []);
  await assert.rejects(() => jobs.cancel('owner-2', job.id), error => error.status === 404);
  assert.throws(() => jobs.resume('owner-2', job.id), error => error.status === 404);
  assert.equal(jobs.list('owner-1', 'listing-1').length, 1);
  assert.ok(jobs.events('owner-1', job.id).length > 0);
});

test('each depth dispatches its own agent, deadline and budgets', async t => {
  for (const depth of ['standard', 'max']) {
    const sent = [];
    const provider = new ListingResearchProvider('key', {fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return {ok: true, json: async () => ({id: 'interaction-1'})}; }});
    await provider.create(depth, 'prompt');
    assert.equal(sent[0].agent, {standard: 'deep-research-preview-04-2026', max: 'deep-research-max-preview-04-2026'}[depth]);
  }
  assert.deepEqual(RESEARCH_AGENTS, {standard: DEPTH_POLICY.standard.agent, max: DEPTH_POLICY.max.agent});
  for (const key of ['recordRows', 'reviewSourceCap', 'excerptChars', 'reviewFetchMs', 'auditRounds', 'deadlineMs', 'maxWords']) assert.ok(DEPTH_POLICY.max[key] > DEPTH_POLICY.standard[key], `Max raises ${key}`);

  const {jobs, provider} = setup(t);
  const policy = jobs.policy();
  assert.equal(policy.modes.standard.deadlineMinutes, 45);
  assert.equal(policy.modes.max.deadlineMinutes, 90);
  assert.deepEqual([policy.modes.standard.reviewSourceCap, policy.modes.max.reviewSourceCap], [24, 48]);
  const job = jobs.create('owner-1', input({depth: 'max'}), deal);
  assert.equal(job.deadline - job.created, DEPTH_POLICY.max.deadlineMs);
  await statusOf(jobs, 'owner-1', job.id, ['completed']);
  assert.equal(provider.calls.create[0].depth, 'max');
  assert.match(provider.calls.create[0].prompt, new RegExp(`"maxWords": ${DEPTH_POLICY.max.maxWords}`));
});

test('cancel stops a running investigation through the provider; a finished one stays as it is', async t => {
  const provider = fakeProvider({status: calls => (calls.cancel.length ? 'cancelled' : 'in_progress')});
  const {jobs} = setup(t, {provider});
  const job = jobs.create('owner-1', input(), deal);
  await until(() => provider.calls.events, 'the progress stream');
  assert.equal(jobs.get('owner-1', job.id).status, 'in_progress');
  await jobs.cancel('owner-1', job.id);
  const cancelled = await statusOf(jobs, 'owner-1', job.id, ['cancelled']);
  assert.deepEqual(provider.calls.cancel, ['interaction-1']);
  assert.equal(cancelled.result, null);
  assert.equal((await jobs.cancel('owner-1', job.id)).status, 'cancelled');
});

test('resume reconnects a needs_attention job to its provider interaction and finishes it', async t => {
  const {store, jobs, provider} = setup(t);
  const stuck = stuckJob({providerId: 'interaction-9', deadline: Date.now() + 3600_000, billing: 'not_started'});
  insertJob(store, stuck);
  assert.throws(() => jobs.resume('owner-2', stuck.id), error => error.status === 404);
  assert.equal(jobs.resume('owner-1', stuck.id).status, 'in_progress');
  const done = await statusOf(jobs, 'owner-1', stuck.id, ['completed']);
  assert.equal(done.result.answer, 'Reviewed memo [1]');
  assert.equal(provider.calls.create.length, 0, 'resume never starts a new interaction');
  assert.throws(() => jobs.resume('owner-1', stuck.id), error => error.status === 409);
});

test('a job recover() parks without a provider interaction expires at its deadline on its own', async t => {
  const store = fakeStore();
  const jobs = investigations(store);
  t.after(() => jobs.close());
  const dispatched = stuckJob({status: 'creating', billing: 'dispatched', deadline: Date.now() + 50});
  insertJob(store, dispatched);
  jobs.recover();
  assert.equal(jobs.get('owner-1', dispatched.id).status, 'needs_attention');
  assert.throws(() => jobs.create('owner-1', input(), deal), /already active or needs attention/);
  const expired = await statusOf(jobs, 'owner-1', dispatched.id, ['failed']);
  assert.match(expired.error, /expired without a provider interaction/);
  assert.equal(expired.billing, 'dispatched', 'billing stays as recorded for reconciliation');
  assert.equal(jobs.create('owner-1', input(), deal).status, 'queued', 'the same listing can start again');
});

test('a stop the provider refuses still closes the investigation and frees the account', async t => {
  // A finished interaction answers a cancel with 400; one the provider no longer has answers with 404.
  const refusing = status => ({...fakeProvider({status: () => 'in_progress'}), async cancel() { throw new ResearchProviderError(status); }});
  const user = setup(t, {provider: refusing(400)});
  const running = user.jobs.create('owner-1', input(), deal);
  await until(() => user.provider.calls.events, 'the progress stream');
  await user.jobs.cancel('owner-1', running.id);
  assert.equal((await statusOf(user.jobs, 'owner-1', running.id, ['cancelled', 'needs_attention'])).status, 'cancelled');
  assert.equal(user.jobs.create('owner-1', input(), deal).status, 'queued');

  const deadline = setup(t, {provider: refusing(404)});
  const parked = stuckJob({providerId: 'interaction-gone', billing: 'not_started'});
  insertJob(deadline.store, parked);
  deadline.jobs.recover();
  assert.equal((await statusOf(deadline.jobs, 'owner-1', parked.id, ['cancelled'])).status, 'cancelled');
  assert.equal(deadline.jobs.create('owner-1', input(), deal).status, 'queued');
});

test('billing off: a completed investigation never touches a wallet', async t => {
  const {jobs} = setup(t);
  const job = jobs.create('owner-1', input(), deal);
  const done = await statusOf(jobs, 'owner-1', job.id, ['completed']);
  assert.equal(done.billing, 'not_started');
  assert.equal(jobs.policy().billed, false);
});

test('billing on: completion settles the depth price; a lost provider result stays pending', async t => {
  const wallet = fakeWallet();
  const {jobs} = setup(t, {wallet, secretsOverride: billedSecrets});
  assert.equal(jobs.policy().modes.max.chargeMicros, 5_000_000);
  const job = jobs.create('owner-1', input({depth: 'max'}), deal);
  const done = await statusOf(jobs, 'owner-1', job.id, ['completed']);
  assert.equal(done.billing, 'settled');
  assert.deepEqual(wallet.calls, [['reserve', job.id, 6_000_000], ['dispatch', job.id], ['settle', job.id, 5_000_000]]);

  const lostWallet = fakeWallet();
  const lost = setup(t, {wallet: lostWallet, secretsOverride: billedSecrets, provider: fakeProvider({fail: new Error('connection reset')})});
  const failing = lost.jobs.create('owner-1', input(), deal);
  const attention = await statusOf(lost.jobs, 'owner-1', failing.id, ['needs_attention']);
  assert.equal(attention.billing, 'pending');
  assert.deepEqual(lostWallet.calls.map(call => call[0]), ['reserve', 'dispatch', 'pending'], 'never settled or released without a provider outcome');
});

test('billing on: a provider-reported failure settles at zero, never the full depth price', async t => {
  const wallet = fakeWallet();
  const {jobs} = setup(t, {wallet, secretsOverride: billedSecrets, provider: fakeProvider({status: () => 'failed'})});
  const job = jobs.create('owner-1', input({depth: 'max'}), deal);
  const done = await statusOf(jobs, 'owner-1', job.id, ['failed']);
  assert.equal(done.billing, 'settled');
  assert.deepEqual(wallet.calls, [['reserve', job.id, 6_000_000], ['dispatch', job.id], ['settle', job.id, 0]]);
});

test('each objective changes the public-record budget, the memo sections and the audit checklist', async t => {
  assert.deepEqual(INVESTIGATION_OBJECTIVES, Object.keys(OBJECTIVE_POLICY));
  const sections = new Set(), checklists = new Set();
  for (const objective of INVESTIGATION_OBJECTIVES) {
    const contract = memoContract({depth: 'standard', objective, question: ''});
    assert.equal(contract.sections.length, 5);
    assert.equal(contract.sections[3], OBJECTIVE_POLICY[objective].section);
    sections.add(contract.sections[3]);checklists.add(JSON.stringify(contract.checklist));
    assert.match(investigationPrompt({created: Date.now(), deadline: Date.now(), depth: 'standard', objective, question: '', snapshot: {}, records: null}), new RegExp(OBJECTIVE_POLICY[objective].section));
  }
  assert.equal(sections.size, INVESTIGATION_OBJECTIVES.length, 'every objective has its own section');
  assert.equal(checklists.size, INVESTIGATION_OBJECTIVES.length, 'every objective has its own checklist');
  assert.deepEqual(INVESTIGATION_OBJECTIVES.map(objective => recordPlan({depth: 'standard', objective}).rowLimit), [10, 15, 10, 15, 20]);
  assert.equal(recordPlan({depth: 'max', objective: 'acquisition screening'}).rowLimit, 20);
  assert.equal(recordPlan({depth: 'max', objective: 'assemblage'}).rowLimit, 30, 'capped at the public-data limit');

  const plans = [];
  const {jobs} = setup(t, {records: async (_snapshot, plan) => { plans.push(plan); return {status: 'not supplied'}; }});
  const job = jobs.create('owner-1', input({objective: 'assemblage'}), deal);
  await statusOf(jobs, 'owner-1', job.id, ['completed']);
  assert.deepEqual(plans, [{rowLimit: 20}]);
});

test('the review reads the depth\'s page budget, objective-relevant pages first', async () => {
  const sources = Array.from({length: 60}, (_, i) => ({id: i + 1, url: `https://example.com/page-${i + 1}`, title: i >= 55 ? 'HPD rent stabilization registration' : 'Neighborhood news'}));
  const read = [];
  const sourceFetcher = async ({url}) => { read.push(url); return {url, finalUrl: url, title: 'Page', text: 'x'.repeat(30000)}; };
  const standard = await fetchReviewSources(sources, {listing: {}, depth: 'standard', objective: 'acquisition screening'}, undefined, sourceFetcher);
  assert.equal(standard.filter(check => check.status === 'retrieved').length, 24);
  assert.equal(standard.find(check => check.status === 'retrieved').text.length, DEPTH_POLICY.standard.excerptChars);
  assert.equal(standard[30].status, 'not_checked');
  read.length = 0;
  const max = await fetchReviewSources(sources, {listing: {}, depth: 'max', objective: 'acquisition screening'}, undefined, sourceFetcher);
  assert.equal(max.filter(check => check.status === 'retrieved').length, 48);
  assert.equal(max.find(check => check.status === 'retrieved').text.length, DEPTH_POLICY.max.excerptChars);
  const rental = await fetchReviewSources(sources, {listing: {}, depth: 'standard', objective: 'rental hold'}, undefined, sourceFetcher);
  assert.deepEqual(rental.slice(55).map(check => check.status), Array(5).fill('retrieved'), 'rent regulation pages beyond the cap are read first for a rental hold');
  assert.equal(rental.filter(check => check.status === 'retrieved').length, 24);
});

// Publication gate fixtures: reviewedReport must throw on every malformed memo.
const webSources = [{id: 1, url: 'https://example.com/a', title: 'A'}, {id: 2, url: 'https://example.com/b', title: 'B'}, {id: 3, url: 'https://example.com/c', title: 'C'}];
const sourceChecks = [{reference: 'W1', status: 'retrieved'}, {reference: 'W2', status: 'unavailable'}, {reference: 'W3', status: 'not_checked'}];
const memo = (sections, body = 'A cited finding about the subject lot [W1].') => sections.map(title => `## ${title}\n\n${body}`).join('\n\n');
const publish = (answer, contract) => reviewedReport({answer, corrections: []}, {answer: 'draft', sources: webSources}, null, {sourceChecks}, {}, contract);

test('a well-formed memo publishes with renumbered citations', () => {
  const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question: ''});
  const report = publish(memo(contract.sections), contract);
  assert.match(report.answer, /## Decision brief/);
  assert.match(report.answer, /\[1\]/);
  assert.deepEqual(report.sources.map(source => source.url), ['https://example.com/a']);
  assert.deepEqual(memoProblems(memo(contract.sections), contract, sourceChecks), []);
});

test('malformed memos are refused: missing, empty or reordered sections, word cap, unread sources', () => {
  const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question: ''});
  const [brief, ledger, ownership, objective, next] = contract.sections;
  assert.throws(() => publish(memo([brief, ledger, objective, next]), contract), /Missing the "Ownership and business contacts" section/);
  assert.throws(() => publish(memo([brief, ownership, ledger, objective, next]), contract), /out of order/);
  assert.throws(() => publish(`${memo([brief, ledger, ownership, objective])}\n\n## ${next}\n\n`, contract), /"Next actions and coverage" section is empty/);
  assert.throws(() => publish(memo(contract.sections, 'A finding [W2].'), contract), /\[W2\], whose source text was not retrieved/);
  assert.throws(() => publish(memo(contract.sections, 'A finding [W1, W3].'), contract), /\[W3\], whose source text was not retrieved/);
  const long = memo(contract.sections, `${'word '.repeat(380)}[W1].`);
  assert.throws(() => publish(long, contract), /limit for this depth is 1500/);
  const max = memoContract({depth: 'max', objective: 'acquisition screening', question: ''});
  assert.doesNotThrow(() => publish(long, max), 'the same memo fits the Max word budget');
  const assemblage = memoContract({depth: 'standard', objective: 'assemblage', question: ''});
  assert.throws(() => publish(memo(contract.sections), assemblage), /Missing the "Adjacent parcels and assemblage rights" section/);
});

test('a memo may not add sections outside the contract, though a section may hold its own subheadings', () => {
  const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question: ''});
  const [brief, ...rest] = contract.sections;
  const extra = memo([brief, 'Neighborhood and market overview', ...rest]);
  assert.throws(() => publish(extra, contract), /Unexpected section "Neighborhood and market overview"; use only these sections:/);
  assert.match(memoProblems(memo([...contract.sections, 'Market context']), contract, sourceChecks).join(' '), /Unexpected section "Market context"/);
  const subheading = memo(contract.sections).replace('## Decision brief\n\n', '## Decision brief\n\n### Key risks\n\n**Title**\n\n');
  assert.deepEqual(memoProblems(subheading, contract, sourceChecks), []);
  assert.match(memoProblems(memo(['Neighborhood overview', ...contract.sections]), contract, sourceChecks).join(' '), /Unexpected section "Neighborhood overview"/);
  for (const header of ['# Acquisition memo: 12 Example Street\n\n', '## 12 Example Street, Brooklyn, October 2026\n\n', '# Acquisition memo\n\nA screening of the listed lot.\n\n'])
    assert.deepEqual(memoProblems(header + memo(contract.sections), contract, sourceChecks), [], header);
  const unitCount = memo(contract.sections).replace('## Decision brief\n\n', '## Decision brief\n\n# of units: 24 [W1]\n\n');
  assert.deepEqual(memoProblems(unitCount, contract, sourceChecks), []);
  assert.deepEqual(memoProblems(`# 12 Example Street\n\n${contract.sections.map(title => `# ${title}\n\n# of units: 24\nA cited finding [W1].`).join('\n\n')}`, contract, sourceChecks), []);
  assert.deepEqual(memoProblems(`## 12 Example Street\nBrooklyn, listed at $2.4M\n\n${memo(contract.sections)}`, contract, sourceChecks), []);
  const fenced = memo(contract.sections).replace('## Decision brief\n\n', '## Decision brief\n\n```\n## not a heading\nsample text\n```\n\n');
  assert.deepEqual(memoProblems(fenced, contract, sourceChecks), []);
  const setext = `${memo(contract.sections)}\n\nSources\n-------\n\nA list of further pages [W1].`;
  assert.match(memoProblems(setext, contract, sourceChecks).join(' '), /Unexpected section "Sources"/);
  const bold = sections => sections.map(title => `**${title}**\n\nA cited finding about the subject lot [W1].`).join('\n\n');
  assert.deepEqual(memoProblems(bold(contract.sections), contract, sourceChecks), []);
  assert.match(memoProblems(bold([brief, 'Market context', ...rest]), contract, sourceChecks).join(' '), /Unexpected section "Market context"/);
});

test('a memo must answer the listing question in its own section', () => {
  const question = 'Who manages the owner LLC, and what happened to the previous development application?';
  const contract = memoContract({depth: 'standard', objective: 'redevelopment', question});
  assert.equal(contract.sections[1], QUESTION_SECTION);
  const withoutQuestion = contract.sections.filter(title => title !== QUESTION_SECTION);
  assert.throws(() => publish(memo(withoutQuestion), contract), /Missing the "Answer to your question" section/);
  const sidestep = contract.sections.map(title => `## ${title}\n\n${title === QUESTION_SECTION ? 'See the ledger below [W1].' : 'A cited finding [W1].'}`).join('\n\n');
  assert.throws(() => publish(sidestep, contract), /does not address the question asked/);
  const answered = contract.sections.map(title => `## ${title}\n\n${title === QUESTION_SECTION ? 'The previous development application was withdrawn in 2019 [W1].' : 'A cited finding [W1].'}`).join('\n\n');
  assert.doesNotThrow(() => publish(answered, contract));
});

test('every ledger and contact table row cites its source unless it marks the point unresolved', () => {
  const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question: ''});
  const withRow = (section, row) => contract.sections.map(title => `## ${title}\n\n${title === section ? `| Finding | Record | Source | Status |\n| --- | --- | --- | --- |\n${row}` : 'A cited finding about the subject lot [W1].'}`).join('\n\n');
  for (const section of ['Evidence ledger and timeline', 'Ownership and business contacts']) {
    assert.deepEqual(memoProblems(withRow(section, '| Deed to Example Holdings LLC | ACRIS deed, 2019 | [W1] | historical |'), contract, sourceChecks), []);
    assert.deepEqual(memoProblems(withRow(section, '| Example Realty | Listing broker | [Listing] | reported by marketing |'), contract, sourceChecks), []);
    assert.deepEqual(memoProblems(withRow(section, '| Current owner | None retrieved | None | unresolved |'), contract, sourceChecks), []);
    assert.throws(() => publish(withRow(section, '| Owner LLC defaulted on a 2019 mortgage | ACRIS | none | confirmed current |'), contract), new RegExp(`"${section}" table has 1 row without a source citation`));
  }
});

test('the question section may answer in other word forms or topic words, never on another topic', () => {
  const problems = (question, answer) => {
    const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question});
    return memoProblems(contract.sections.map(title => `## ${title}\n\n${title === QUESTION_SECTION ? answer : 'A cited finding about the subject lot [W1].'}`).join('\n\n'), contract, sourceChecks);
  };
  for (const [question, answer] of [
    ['Who owns it?', 'The owner of record is Example Holdings LLC, grantee on the 2019 deed [W1].'],
    ['Any violations?', 'There are 14 open DOB and ECB violation records on the lot [W1].'],
    ['Is it vacant?', 'The lot is unimproved land with no building [W1].'],
    ['What is it zoned?', 'The zoning district is R6 [W1].'],
    ['Is there a mortgage on it?', 'A 2021 loan of $2,000,000 is recorded against the lot [W1].'],
    ['Is the building rent stabilized?', 'The building has 24 apartments registered with DHCR as rent regulated [W1].'],
    ['Who owns the property?', 'The owner of record is Example Holdings LLC [W1].'],
    ['How many buildings are on the parcel?', 'Two buildings stand on the parcel: a four storey walk-up and a rear garage [W1].'],
    ['What can be built on the site?', 'As of right the site supports a building of about 14,000 square feet [W1].'],
    ['What is the lot size of the property?', 'The property sits on a 25 by 100 foot lot of 2,500 square feet [W1].'],
    ['How old is the building?', 'The building was completed in 1931 [W1].'],
    ['What zoning regulations apply to the site?', 'The site is in an R7A district with a C2-4 commercial overlay [W1].'],
    ['How many tenants live in the building?', 'The building has 12 apartments, 9 of them leased [W1].'],
    ['What is the certificate of occupancy for the building?', 'The building is a legal two-family dwelling [W1].'],
    ['What is the title history of the property?', 'The property sold in 1990 and 2012 [R1].'],
  ]) assert.deepEqual(problems(question, answer), [], question);
  for (const [question, answer] of [
    ['Who owns it?', 'The building has four storeys and a cellar [W1].'],
    ['Is it vacant?', 'The lot lies in a flood zone [W1].'],
    ['Is the building rent stabilized?', 'The building sits on a corner lot with frontage on two streets [W1].'],
    ['Is the property vacant?', 'The property lies in a flood zone [W1].'],
    ['How old is the building?', 'It was completed in 1931 [W1].'],
  ]) assert.match(problems(question, answer).join(' '), /does not address the question asked/, question);
  assert.match(problems('Is the building rent stabilized?', 'The building sits on a corner lot [W1].').join(' '), /answer it in terms of rent, stabilized\./);
  assert.match(problems('How many tenants live in the building?', 'It was completed in 1931 [W1].').join(' '), /does not address the question asked; answer it in terms of tenants\./);
  assert.match(problems('How old is the building?', 'It was completed in 1931 [W1].').join(' '), /does not address the question asked\.$/);
});

// Records like those of 100 East 123rd Street: a 2012 deed after an older one, 17 open DOB and 2 open ECB violations.
const deedRecords = (extra = {}) => ({status: 'supplied', records: {bbl: '1017480001',
  sourceIds: {acris: 2, acrisParties: 4, dobViolations: 6, ecbViolations: 7},
  currentOwner: {status: 'latest_deed_predates_later_documents', names: ['PARK ELITE GROUP LLC'], deed: {documentId: '2012012700462001', docType: 'DEED', crfn: '2012000035619', documentDate: '2012-01-18', recordedDate: '2012-01-27'}},
  deedHistory: [{documentId: '2012012700462001', docType: 'DEED', crfn: '2012000035619', documentDate: '2012-01-18', recordedDate: '2012-01-27'}, {documentId: 'FT_1600000342260', docType: 'DEED', crfn: null, documentDate: '1990-01-02', recordedDate: '1990-05-24'}],
  dobViolationSummary: {available: true, returnedCount: 30, complete: true, openCount: 17, closedCount: 13, openByType: {'LL6291-BOILER': 12, 'E-ELEVATOR': 6}},
  ecbViolationSummary: {available: true, returnedCount: 4, complete: true, openCount: 2, resolvedCount: 2, openBySeverity: {'CLASS - 2': 2}, openByType: {Construction: 1, Elevators: 1}, openBalanceDue: 0},
  ...extra}, sources: [2, 4, 6, 7].map(id => ({id, title: `Source ${id}`, url: `https://data.cityofnewyork.us/${id}`, kind: 'record'}))});

test('the reviewer receives the latest deed and the DOB and ECB violation summaries with their sources', () => {
  const packet = reviewEvidence(deedRecords());
  assert.equal(packet.records.currentOwner.deed.crfn, '2012000035619');
  assert.equal(packet.records.dobViolationSummary.openCount, 17);
  assert.equal(packet.records.ecbViolationSummary.openCount, 2);
  assert.deepEqual([packet.records.sourceIds.acrisParties, packet.records.sourceIds.dobViolations, packet.records.sourceIds.ecbViolations], [4, 6, 7]);
  assert.deepEqual(packet.sources.map(s => s.id).sort(), [4, 6, 7]);
});

test('a memo is refused only when its prose contradicts the deed and violation counts its records hold', () => {
  const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question: '', publicRecords: deedRecords()});
  assert.deepEqual(contract.recordFacts, {latestDeed: {docType: 'DEED', documentId: '2012012700462001', crfn: '2012000035619', recordedDate: '2012-01-27'}, openViolations: {DOB: 17, ECB: 2}, unavailableViolations: []});
  assert.deepEqual(contract.recordChecks, {earlierDeeds: [{documentId: 'FT_1600000342260', crfn: null, documentDate: '1990-01-02', recordedDate: '1990-05-24'}], openParts: {DOB: [12, 6], ECB: [2, 1]}});
  const memo = text => memoProblems(contract.sections.map(title => `## ${title}\n\n${title === 'Evidence ledger and timeline' ? text : 'A cited finding about the subject lot [W1].'}`).join('\n\n'), contract, sourceChecks);
  const deed = '| Latest deed of record | DEED, CRFN 2012000035619, recorded 2012-01-27 | [R4] | historical |';
  const counts = '| 17 open DOB violations | DOB violations | [R6] | confirmed current |\n| 2 open ECB violations | ECB violations | [R7] | confirmed current |';
  const table = rows => `| Finding | Record | Source | Status |\n| --- | --- | --- | --- |\n${rows}`;
  assert.deepEqual(memo(table(`${deed}\n${counts}`)), []);
  // The appended records table states the deed and counts, so prose that leaves them out is not refused.
  assert.deepEqual(memo('A cited finding about the subject lot [W1].'), []);
  // Prose that names an earlier deed as the latest is refused, by document ID or by its date.
  for (const text of [
    table('| Historical deed | Document FT_1600000342260 (Dated 1990-01-02) | [R4] | Latest retrieved deed |'),
    'The most recent deed retrieved from the bounded ACRIS search dates to 1990 [R4].',
    'The latest deed of record was recorded May 24, 1990 [R4].',
    'The current owner took title by the 1990 deed, the most recent conveyance on file [R4].',
    'The most recent recorded transfer was the 1990 deed [R4].',
  ]) assert.match(memo(text).join(' '), /names an earlier deed as the latest deed of record; the latest is DEED, CRFN 2012000035619, recorded 2012-01-27/, text);
  // Naming the latest deed beside an earlier one, or an earlier deed not called the latest, is not a contradiction.
  assert.deepEqual(memo('The latest deed, recorded 2012-01-27, followed the 1990 deed [R4].'), []);
  assert.deepEqual(memo('A 1990 deed transferred the lot to Hundred East Equitycorp [R4].'), []);
  // A prose date names the earlier deed; a year that dates something other than a deed does not.
  assert.match(memo('The most recent deed on the lot was recorded on May 24, 1990 [R4].').join(' '), /names an earlier deed as the latest deed of record/);
  assert.deepEqual(memo('The latest mortgage was recorded in 2015; the 1990 deed conveyed the lot [R4].'), []);
  assert.deepEqual(memo('The most recent deed predates the 1990 rezoning [R4].'), []);
  // The latest deed before an earlier date is a question about that time, not a claim about the latest of record.
  assert.deepEqual(memo('The last deed before 2012 was recorded 1990-05-24 [R4].'), []);
  assert.deepEqual(memo('The deed recorded 1990-05-24 is the latest deed indexed before the 2012 sale [R4].'), []);
  // An open count other than the records' is refused; an agency with none open holds zero.
  assert.match(memo('The lot has 3 open ECB violations [R7].').join(' '), /states 3 open ECB violations, but the supplied records hold 2/);
  assert.deepEqual(memo('The lot has 17 open DOB violations and 2 open ECB violations [R6][R7].'), []);
  // A count about another property is not the subject lot's count; the subject's own clause still is.
  assert.deepEqual(memo('The adjoining lot has 3 open DOB violations [W1].'), []);
  // A part of the total is not a competing total: a tallied type or severity, a count beside the total, a dated
  // count or one building's count.
  for (const text of [
    'Of the open DOB violations, 12 open DOB violations are LL62/91 boiler violations [R6].',
    'Of the 17 open DOB violations, 3 open DOB violations concern the facade [R6].',
    'The lot has 17 open DOB violations; 9 open DOB violations are elevator related [R6].',
    'Building 2 on the lot (BIN 1054321) carries 3 open DOB violations of the 17 on the lot [R6].',
    'In 2019, DOB records showed 4 open DOB violations [R6].',
    'Both open ECB violations are class 2, and 1 open ECB violation concerns the elevators [R7].',
  ]) assert.deepEqual(memo(text), [], text);
  // A part can never exceed the total, and a smaller count standing alone is a competing total.
  assert.match(memo('In 2019, DOB records showed 20 open DOB violations [R6].').join(' '), /states 20 open DOB violations, but the supplied records hold 17/);
  assert.match(memo('The lot has 9 open DOB violations [R6].').join(' '), /states 9 open DOB violations, but the supplied records hold 17/);
  assert.match(memo('The lot has 5 open DOB violations, while the adjoining lot has 3 open DOB violations [R6].').join(' '), /states 5 open DOB violations, but the supplied records hold 17/);
  assert.match(memo(`${table(`${deed}\n${counts}`)}\n\nDOB and ECB violations were unavailable for this lot [W1].`).join(' '), /calls DOB violations unavailable, but the supplied records hold them/);
  // Records with no deed of record or no open violations hold the prose to neither.
  const quiet = memoContract({depth: 'standard', objective: 'acquisition screening', question: '', publicRecords: deedRecords({currentOwner: {status: 'unresolved', names: null, reason: 'No deed is indexed.'}, deedHistory: [], dobViolationSummary: {available: true, openCount: 0}, ecbViolationSummary: {available: false, openCount: 0}})});
  assert.deepEqual(quiet.recordFacts, {latestDeed: null, openViolations: {}, unavailableViolations: ['ECB']});
  assert.deepEqual(quiet.recordChecks.earlierDeeds, []);
  assert.deepEqual(memoProblems(quiet.sections.map(title => `## ${title}\n\nA cited finding about the subject lot [W1].`).join('\n\n'), quiet, sourceChecks), []);
  assert.match(memoProblems(quiet.sections.map(title => `## ${title}\n\nThe lot has 4 open DOB violations [W1].`).join('\n\n'), quiet, sourceChecks).join(' '), /states 4 open DOB violations, but the supplied records hold 0/);
});

test('a published memo carries a Records on file table built from its records: latest deed, open counts and penalties due', () => {
  const records = {...deedRecords({currentOwner: {...deedRecords().records.currentOwner, laterDocuments: [{docType: 'MTGE'}, {docType: 'AGMT'}]}, ecbViolationSummary: {available: true, returnedCount: 4, complete: true, openCount: 2, resolvedCount: 2, openBalanceDue: 6250}, hpdViolationSummary: {sampledCount: 15, openInSample: 1, classCInSample: 8}}),
    queries: [{sourceId: 8, dataset: 'HPD violations', status: 'retrieved', returnedRows: 15, rowLimit: 15}, {sourceId: 9, dataset: 'E-designations', status: 'unavailable', returnedRows: null, rowLimit: 10}]};
  records.sources.push({id: 8, title: 'HPD violations: bounded query', url: 'https://data.cityofnewyork.us/8', kind: 'public_record_query'}, {id: 9, title: 'E-designations: bounded query', url: 'https://data.cityofnewyork.us/9', kind: 'public_record_query'});
  const publishWith = packet => reviewedReport({answer: memo(memoContract({depth: 'standard', objective: 'acquisition screening', question: '', publicRecords: packet}).sections), corrections: []}, {answer: 'draft', sources: webSources}, packet, {sourceChecks}, {}, memoContract({depth: 'standard', objective: 'acquisition screening', question: '', publicRecords: packet}));
  const report = publishWith(records);
  const cite = url => `[${report.sources.find(source => source.url === url).id}]`;
  const table = report.answer.slice(report.answer.indexOf('### Records on file'), report.answer.indexOf('### Public-record query coverage'));
  assert.ok(table, 'the records table comes before the query coverage');
  for (const row of [
    `| Latest deed of record | DEED, CRFN 2012000035619, recorded 2012-01-27, grantee PARK ELITE GROUP LLC; 2 documents (MTGE, AGMT) were recorded on the lot after it, so the owner may have changed if any of them conveys title | ${cite('https://data.cityofnewyork.us/4')} |`,
    `| Open DOB violations | 17 open, 13 closed | ${cite('https://data.cityofnewyork.us/6')} |`,
    `| Open ECB violations | 2 open, 2 resolved, $6,250 in penalties due on open violations | ${cite('https://data.cityofnewyork.us/7')} |`,
    `| Open HPD violations | 1 open in a sample of 15 | ${cite('https://data.cityofnewyork.us/8')} |`,
  ]) assert.ok(table.includes(row), row);
  // A violation source that was not read says so instead of a count, and an empty HPD sample says no rows came back.
  const quiet = publishWith({...records, records: {...records.records, ecbViolationSummary: {available: false, returnedCount: 0, openCount: 0}, hpdViolationSummary: {sampledCount: 0, openInSample: 0, classCInSample: 0}}});
  assert.match(quiet.answer, /\| Open ECB violations \| Not read \|/);
  assert.match(quiet.answer, /\| Open HPD violations \| No rows returned \|/);
  // An unresolved owner gives its reason rather than reading as no deed on file.
  const unresolved = publishWith({...records, records: {...records.records, currentOwner: {status: 'unresolved', names: null, reason: 'The latest deed (CRFN 2012000035619) names no grantee in ACRIS.'}}});
  assert.match(unresolved.answer, /\| Latest deed of record \| Unresolved: The latest deed \(CRFN 2012000035619\) names no grantee in ACRIS\. \| \[\d+\] \|/);
  const failed = publishWith({...records, records: {...records.records, currentOwner: {status: 'unresolved', names: null, reason: "The lot's ACRIS document index could not be read (query failed)."}}});
  assert.match(failed.answer, /\| Unresolved: The lot's ACRIS document index could not be read\. \|/);
  const nested = publishWith({...records, records: {...records.records, currentOwner: {status: 'unresolved', names: null, reason: "The lot's ACRIS document index could not be read (Public records HTTP 500 (Internal))."}}});
  assert.match(nested.answer, /\| Unresolved: The lot's ACRIS document index could not be read\. \|/);
  assert.match(publishWith({...records, records: {...records.records, currentOwner: {status: 'unresolved', names: null}}}).answer, /\| Latest deed of record \| Unresolved \|/);
  // The latest deed is known from the lot's deed history even when its grantee is not, so an earlier deed called
  // the latest is still refused.
  const nameless = memoContract({depth: 'standard', objective: 'acquisition screening', question: '', publicRecords: {...records, records: {...records.records, currentOwner: {status: 'unresolved', names: null, reason: 'The latest deed (CRFN 2012000035619) names no grantee in ACRIS.'}}}});
  assert.equal(nameless.recordFacts.latestDeed.crfn, '2012000035619');
  assert.match(memoProblems(memo(nameless.sections, 'The latest deed of record was recorded 1990-05-24 [R4].'), nameless, sourceChecks).join(' '), /names an earlier deed as the latest deed of record/);
});

test('the review and every audit round hold the memo to the earlier deeds in the full record packet', async () => {
  const records = {...deedRecords(), queries: []};
  const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question: '', publicRecords: records});
  const wrong = memo(contract.sections, 'The most recent deed retrieved from the bounded ACRIS search dates to 1990 [R4].');
  const right = memo(contract.sections, 'The latest deed of record was recorded 2012-01-27 [R4].');
  const audits = [];
  const answer = wrong;
  const respond = data => ({ok: true, json: async () => data});
  const provider = new ListingResearchProvider('key', {
    sourceFetcher: async ({url}) => ({url, finalUrl: url, title: 'Source A', text: 'A cited finding about the subject lot.'}),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.input.startsWith('Audit this acquisition memo')) { audits.push(JSON.parse(body.input.slice(body.input.indexOf('\n\n{') + 2))); return respond({status: 'completed', id: `audit-${audits.length}`, output_text: JSON.stringify({approved: true, edits: []})}); }
      reviews.push(body.input);
      return respond({status: 'completed', id: 'review-1', output_text: JSON.stringify({answer, corrections: []})});
    },
  });
  const reviews = [];
  const context = {listing: {}, depth: 'standard', objective: 'acquisition screening', question: '', researchDate: '2026-10-25T00:00:00.000Z', publicRecords: records};
  const report = {answer: 'Draft finding [1].', sources: webSources.slice(0, 1)};
  const error = await provider.review(report, context).then(() => null, caught => caught);
  assert.match(error?.message ?? '', /source audit found unresolved claims/);
  // The app's own checks stay out of the prompt; the audit still applies them.
  assert.equal(audits[0].memoContract.recordFacts.latestDeed.crfn, '2012000035619');
  assert.equal(audits[0].memoContract.recordChecks, undefined);
  assert.match(audits[0].contractProblems.join(' '), /names an earlier deed as the latest deed of record; the latest is DEED, CRFN 2012000035619/);
  // Resuming the saved review keeps the same contract: a corrected memo publishes with its records table.
  const resumed = await provider.finishReview({...error.reviewState, reviewed: {answer: right, corrections: []}});
  assert.equal(audits.at(-1).memoContract.recordChecks, undefined);
  // The review and the research brief read the records' facts without the app's checks.
  const brief = investigationPrompt({created: Date.now(), deadline: Date.now(), depth: 'standard', objective: 'acquisition screening', question: '', snapshot: {}, records});
  for (const input of [reviews[0], brief]) {
    assert.match(input, /"recordFacts":\s*\{\s*"latestDeed":\s*\{\s*"docType":\s*"DEED",\s*"documentId":\s*"2012012700462001"/);
    assert.doesNotMatch(input, /recordChecks|earlierDeeds/);
  }
  assert.match(resumed.answer, /\| Latest deed of record \| DEED, CRFN 2012000035619, recorded 2012-01-27/);
});

test('the contract audit prompt names the question section instead of a literal placeholder', () => {
  assert.match(CONTRACT_AUDIT_PROMPT, new RegExp(`"${QUESTION_SECTION}" section`));
  assert.doesNotMatch(CONTRACT_AUDIT_PROMPT, /\$\{QUESTION_SECTION\}/);
});

test('the final audit round keeps its corrections in the saved review for the reconnect', async () => {
  const contract = memoContract({depth: 'standard', objective: 'acquisition screening', question: '', publicRecords: {status: 'not supplied'}});
  const reviewed = {answer: memo(contract.sections) + '\n\nFirst claim. Second claim. Third claim.', corrections: []};
  const fixes = [
    {before: 'First claim.', after: 'First fixed.', reason: 'first correction'},
    {before: 'Second claim.', after: 'Second fixed.', reason: 'second correction'},
    {before: 'Third claim.', after: 'Third fixed.', reason: 'third correction'},
  ];
  let calls = 0;
  const respond = data => ({ok: true, json: async () => data});
  const provider = new ListingResearchProvider('key', {
    fetch: async () => respond({status: 'completed', id: `audit-${calls + 1}`, output_text: JSON.stringify({approved: false, edits: [fixes[calls++]]})}),
  });
  const evidence = {depth: 'standard', objective: 'acquisition screening', question: '', memoContract: contract, webEvidence: [], webSources: [], draft: ''};
  const error = await provider.audit(reviewed, evidence).then(() => null, caught => caught);
  assert.equal(calls, DEPTH_POLICY.standard.auditRounds);
  assert.match(error?.message ?? '', /source audit found unresolved claims/);
  // The saved candidate a reconnect resumes from carries every round's correction, the last one included.
  for (const fix of fixes) assert.match(error.auditPending.reviewed.answer, new RegExp(fix.after.replace('.', '\\.')));
  assert.deepEqual(error.auditPending.edits, []);
});

test('an audit that approves a memo ignoring the question keeps the job out of completed', async t => {
  const question = 'What happened to the previous development application?';
  const audits = [];
  const respond = data => ({ok: true, json: async () => data});
  const reviewAnswer = memoContract({depth: 'standard', objective: 'acquisition screening', question}).sections.filter(title => title !== QUESTION_SECTION).map(title => `## ${title}\n\nA cited finding [W1].`).join('\n\n');
  const provider = new ListingResearchProvider('key', {
    sourceFetcher: async ({url}) => ({url, finalUrl: url, title: 'Source A', text: 'A cited finding about the subject lot.'}),
    fetch: async (_url, options) => {
      if (options.method === 'GET') return respond(draftInteraction);
      const body = JSON.parse(options.body);
      if (body.agent) return respond({id: 'interaction-1'});
      if (body.input.startsWith('Audit this acquisition memo')) { audits.push(JSON.parse(body.input.slice(body.input.indexOf('\n\n{') + 2))); return respond({status: 'completed', id: `audit-${audits.length}`, output_text: JSON.stringify({approved: true, edits: []})}); }
      return respond({status: 'completed', id: 'review-1', output_text: JSON.stringify({answer: reviewAnswer, corrections: []})});
    },
  });
  const {jobs} = setup(t, {provider});
  const job = jobs.create('owner-1', input({question}), deal);
  const attention = await statusOf(jobs, 'owner-1', job.id, ['needs_attention', 'completed']);
  assert.equal(attention.status, 'needs_attention');
  assert.equal(attention.result, null);
  assert.equal(audits.length, 1, 'an approval without edits cannot clear a detected problem');
  assert.equal(audits[0].memoContract.question, question);
  assert.deepEqual(audits[0].memoContract.checklist, OBJECTIVE_POLICY['acquisition screening'].checklist);
  assert.match(audits[0].contractProblems.join(' '), /Missing the "Answer to your question" section/);

  // The same pipeline publishes once the memo answers the question in its own section.
  audits.length = 0;
  const answered = memoContract({depth: 'standard', objective: 'acquisition screening', question}).sections.map(title => `## ${title}\n\n${title === QUESTION_SECTION ? 'The previous development application is not in the retrieved records [W1].' : 'A cited finding [W1].'}`).join('\n\n');
  provider.request = async (_url, options) => {
    if (options.method === 'GET') return respond(draftInteraction);
    const body = JSON.parse(options.body);
    if (body.agent) return respond({id: 'interaction-2'});
    if (body.input.startsWith('Audit this acquisition memo')) { audits.push(1); return respond({status: 'completed', id: 'audit', output_text: JSON.stringify({approved: true, edits: []})}); }
    return respond({status: 'completed', id: 'review-2', output_text: JSON.stringify({answer: answered, corrections: []})});
  };
  const second = setup(t, {provider});
  const ok = second.jobs.create('owner-1', input({question}), deal);
  const completed = await statusOf(second.jobs, 'owner-1', ok.id, ['needs_attention', 'completed']);
  assert.equal(completed.status, 'completed');
  assert.match(completed.result.answer, /## Answer to your question/);
  assert.equal(audits.length, 1);
});

test('the review names an owner of record only from the latest deed parties now that ACRIS parties are supplied',()=>{
  assert.doesNotMatch(REVIEW_PROMPT,/no party names/);
  assert.match(REVIEW_PROMPT,/owner of record only from the latest deed's grantees/);
});

test('a provider-less parked job still expires at its deadline after a cancellation attempt', async t => {
  const store = fakeStore();
  const jobs = investigations(store);
  t.after(() => jobs.close());
  const stuck = stuckJob({deadlineCancellationAttempted: true, deadline: Date.now() + 30, attentionExpiresAt: Date.now() + 7 * 86400000});
  insertJob(store, stuck);
  jobs.recover();
  const after = await statusOf(jobs, 'owner-1', stuck.id, ['failed']);
  assert.match(after.error, /expired without a provider interaction/);
  assert.equal(after.billing, 'pending');
});
