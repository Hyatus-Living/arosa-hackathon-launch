import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {FILTER_SCHEMA_ID, defaultFilterValues} from './listing-filter-schema.mjs';

const owner = 'a'.repeat(24), participant = 'b'.repeat(24);
const filters = () => ({prompt: 'Cap price at 500000', snapshot: {schema: FILTER_SCHEMA_ID, revision: 0, values: {...defaultFilterValues(), maxPrice: 500000}, baselineCosts: {hardCostPerGrossSqft: 375, softCostPctOfHard: .22, carryAndFinancingPct: .1, zfaToGrossFactor: 1.15}}});
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-request-identity-')), path = join(dir, 'chat.sqlite'), store = new ChatStore(path), conversation = store.createConversation(owner);
  store.grantMember(owner, conversation.id, 'account', participant, 'participant');
  t.after(() => {store.close(); rmSync(dir, {recursive: true});});
  return {store, conversation, path};
}
const conflict = error => error.status === 409;

test('a request ID rejects changed messages while collaborators retain the original sender', t => {
  const {store, conversation} = setup(t), id = randomUUID();
  store.createRun(owner, conversation.id, 'Original question', id);
  const before = store.runEvents(id);
  assert.throws(() => store.createRun(owner, conversation.id, 'Different question', id), conflict);
  assert.throws(() => store.createRun(participant, conversation.id, 'Different question', id), conflict);
  assert.equal(store.createRun(participant, conversation.id, 'Original question', id).owner, owner);
  assert.equal(store.run(owner, id).input, 'Original question'); assert.equal(store.run(owner, id).owner, owner);
  assert.deepEqual(store.runEvents(id), before); assert.equal(store.query('SELECT id FROM runs').length, 1);
});

test('adding, removing or changing any filter context requires a new request ID', t => {
  const {store, conversation} = setup(t), base = filters();
  const pairs = [[base, null], [null, base], [base, {...base, prompt: 'A different prompt'}], [base, {...base, snapshot: {...base.snapshot, revision: 1}}], [base, {...base, snapshot: {...base.snapshot, values: {...base.snapshot.values, maxPrice: 600000}}}], [base, {...base, snapshot: {...base.snapshot, baselineCosts: {...base.snapshot.baselineCosts, hardCostPerGrossSqft: 400}}}]];
  for (const [first, changed] of pairs) {
    const id = randomUUID(); store.createRun(owner, conversation.id, 'Filter question', id, first);
    const before = store.runEvents(id);
    assert.throws(() => store.createRun(owner, conversation.id, 'Filter question', id, changed), conflict);
    assert.deepEqual(store.runEvents(id), before);
  }
});

test('exact normalized retries survive lifecycle states, object order and JSON zero without creating work', t => {
  const {store, conversation} = setup(t);
  for (const status of ['queued', 'running', 'completed', 'failed', 'interrupted']) {
    const base = filters(); base.snapshot.values.maxPpb = -0;
    const run = store.createRun(owner, conversation.id, 'Same question', randomUUID(), base);
    if (status !== 'queued') store.begin(run);
    if (!['queued', 'running'].includes(status)) store.finish(run, status, status === 'completed' ? {answer: 'Fixture answer.', sources: []} : null, status === 'failed' ? 'Fixture failure.' : null);
    const reordered = {...base, snapshot: {...base.snapshot, values: Object.fromEntries(Object.entries(base.snapshot.values).reverse()), baselineCosts: Object.fromEntries(Object.entries(base.snapshot.baselineCosts).reverse())}};
    const before = {events: store.runEvents(run.id), messages: store.messageRows(conversation.id)};
    assert.equal(store.createRun(owner, conversation.id, 'Same question', run.id, reordered).status, status);
    assert.deepEqual(store.runEvents(run.id), before.events); assert.deepEqual(store.messageRows(conversation.id), before.messages);
  }
  assert.equal(store.query('SELECT id FROM runs').length, 5);
});

test('conversation and access boundaries remain enforced while exact acknowledgments stay readable', t => {
  const {store, conversation} = setup(t), original = store.createRun(owner, conversation.id, 'Original question');
  assert.throws(() => store.createRun('c'.repeat(24), conversation.id, 'Original question', original.id), error => error.status === 404);
  const other = store.createConversation(owner);
  assert.throws(() => store.createRun(owner, other.id, 'Original question', original.id), conflict);
  const own = store.createRun(participant, conversation.id, 'Participant question');
  store.setGrantRole(owner, conversation.id, 'account', participant, 'viewer');
  assert.equal(store.createRun(participant, conversation.id, 'Participant question', own.id).id, own.id);
  assert.equal(store.createRun(participant, conversation.id, 'Original question', original.id).owner, owner);
  assert.throws(() => store.createRun(participant, conversation.id, 'New question'), error => error.status === 403);
});

test('authenticated conflicting retries return 409 and a fresh ID executes the intended new question', async t => {
  const {store, conversation} = setup(t), executed = [], server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store, execute: async request => {executed.push(request.message); return {answer: 'Synthetic answer.', sources: [], ui: []};}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = (path, body, account = owner) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {headers: {authorization: 'Bearer test', 'x-acres-account': account, 'content-type': 'application/json'}, ...(body ? {method: 'POST', body: JSON.stringify(body)} : {})});
  try {
    const id = randomUUID();
    assert.equal((await api(`/conversations/${conversation.id}/runs`, {id, message: 'Original question'})).status, 202);
    const collaborator = await api(`/conversations/${conversation.id}/runs`, {id, message: 'Original question'}, participant);
    assert.equal(collaborator.status, 202); assert.equal((await collaborator.json()).owner, owner);
    assert.equal((await api(`/conversations/${conversation.id}/runs`, {id, message: 'Different question'}, participant)).status, 409);
    assert.match(await (await api(`/runs/${id}/events`)).text(), /run.completed/);
    const mismatch = await api(`/conversations/${conversation.id}/runs`, {id, message: 'Different question'});
    assert.equal(mismatch.status, 409); assert.match((await mismatch.json()).error, /request ID/i);
    assert.equal((await api(`/conversations/${conversation.id}/runs`, {id, message: 'Original question'})).status, 202);
    const next = randomUUID();
    assert.equal((await api(`/conversations/${conversation.id}/runs`, {id: next, message: 'Different question'})).status, 202);
    assert.match(await (await api(`/runs/${next}/events`)).text(), /run.completed/);
    assert.deepEqual(executed, ['Original question', 'Different question']);
    assert.deepEqual(store.messageRows(conversation.id).filter(message => message.role === 'user').map(message => message.text), executed);
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});
