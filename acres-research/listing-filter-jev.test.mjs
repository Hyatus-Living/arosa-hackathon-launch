import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FILTER_SCHEMA, FILTER_SCHEMA_ID, defaultFilterValues, validateFilterValues, validateSearchState} from './listing-filter-schema.mjs';
import {decideListingFilters, numericCandidates} from './listing-filter-jev.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {RunManager} from './manager.mjs';

const snapshot = () => ({schema: FILTER_SCHEMA_ID, revision: 7, values: {...defaultFilterValues(), borough: 'QN', maxPrice: 2000000, types: ['multi_family', 'land']}, baselineCosts: {hardCostPerGrossSqft: 375, softCostPctOfHard: .22, carryAndFinancingPct: .1, zfaToGrossFactor: 1.15}});
const result = choices => ({answers: Object.fromEntries(Object.entries(choices).map(([key, value]) => [key, {type: 'choice', choice: value}]))});
function evaluator(actions, selections = {}) {
  return async ({questions}) => {
    const response = result(Object.fromEntries(Object.entries(questions).filter(([,question]) => question.type === 'choice').map(([key, question]) => {
    if (key === 'mode') return [key, actions.mode || 'filters'];
    if (key === 'control_action') return [key, ['research', 'preserve'].includes(actions.mode) ? 'preserve' : 'change'];
    if (key === 'response_kind') return [key, ['research', 'both'].includes(actions.mode) ? 'research' : 'acknowledge'];
    if (key === 'initialization') return [key, actions.initialization ? Object.keys(question.criteria).find(id => actions.initialization === 'reset_all' ? /reset|restore|defaults/i.test(question.criteria[id].source || '') : /clear|wipe/i.test(question.criteria[id].source || '')) : 'preserve'];
    if (question.criteria.keep) return [key, actions[key] || 'keep'];
    const selected = selections[key];
    const id = typeof selected === 'function' ? Object.keys(question.criteria).find(id => selected(question.criteria[id])) : selected;
    assert.ok(id && Object.hasOwn(question.criteria, id), `A deliberate test decision exists for ${key}`);
    return [key, id];
    })));
    return response;
  };
}

test('a saved search from before the condo cost joined the schema still validates', () => {
  const complete = {...defaultFilterValues(), hardCostPerGrossSqft: 375, softCostPctOfHard: .22, carryAndFinancingPct: .1, zfaToGrossFactor: 1.15};
  const legacy = {...complete}; delete legacy.condoHardCostPerGrossSqft;
  const beside = validateSearchState({schema: FILTER_SCHEMA_ID, values: legacy, bounds: null, condoHardCostPerGrossSqft: 700});
  assert.equal(beside.values.condoHardCostPerGrossSqft, 700);
  assert.equal(beside.condoHardCostPerGrossSqft, 700);
  const frozen = validateSearchState({schema: FILTER_SCHEMA_ID, values: legacy, bounds: null});
  assert.equal(frozen.values.condoHardCostPerGrossSqft, 375, 'no condo figure froze at the rental hard cost, as it priced then');
});

test('a complete multi-ZIP area selection retains every other value in the JSON state',async()=>{
  const base=snapshot(),before=JSON.stringify(base),prompt='Show ZIP codes 11201 and 11211';
  const choose=evaluator({area:'set'},{area:c=>c.text==='11201'});
  const out=await decideListingFilters({snapshot:base,prompt},{},async body=>{
    const q=body.questions.area;
    if(typeof q?.instructions==='string'&&q.instructions.includes('last token')){
      const id=Object.keys(q.criteria).find(key=>q.criteria[key].text==='11201 and 11211');
      assert.ok(id);return result({area:id});
    }
    return choose(body);
  });
  assert.equal(out.filterUpdate.values.area,'11201 and 11211');
  assert.deepEqual(Object.keys(out.filterUpdate.values).sort(),FILTER_SCHEMA.required.toSorted());
  for(const key of FILTER_SCHEMA.required.filter(key=>key!=='area'))assert.deepEqual(out.filterUpdate.values[key],base.values[key]);
  assert.equal(JSON.stringify(base),before);
});

test('an oversized multi-token area has an explicit atomic refusal instead of forced truncation',async()=>{
  const base=snapshot(),before=JSON.stringify(base),value=Array.from({length:20},(_,i)=>String(11201+i)).join(', ');
  assert.ok(value.length>FILTER_SCHEMA.properties.area.maxLength);
  const choose=evaluator({area:'set'},{area:c=>c.text==='11201'});
  await assert.rejects(decideListingFilters({snapshot:base,prompt:'Show ZIP codes '+value},{},async body=>{
    const q=body.questions.area;
    if(typeof q?.instructions==='string'&&q.instructions.includes('last token')){
      assert.ok(Object.hasOwn(q.criteria,'too_long'),'The chooser must be able to refuse the entire requested value');
      return result({area:'too_long'});
    }
    return choose(body);
  }),/too long.*No filters changed/);
  assert.equal(JSON.stringify(base),before);
});

test('full filter schema validates every field, fractions, zero overrides and cross-field ranges atomically', () => {
  const values = defaultFilterValues();
  assert.equal(Object.keys(values).length, 28);
  assert.deepEqual(validateFilterValues({...values, minPrice: null, softCostPctOfHard: 0, minFar: 1.75}), {...values, minPrice: null, softCostPctOfHard: 0, minFar: 1.75});
  for (const change of [{maxPrice: 1}, {maxLot: 2, minLot: 3}, {borough: 'Brooklyn'}, {types: ['land', 'land']}, {tiers: ['invented']}, {area: 'x'.repeat(101)}, {zoning: '<R6>'}, {softCostPctOfHard: 22}, {zfaToGrossFactor: 2}, {minFar: Infinity}, {extra: true}]) assert.throws(() => validateFilterValues({...values, ...change}));
  const partial = {...values}; delete partial.area; assert.throws(() => validateFilterValues(partial));
  assert.deepEqual(values, defaultFilterValues(), 'Validation never changes the source');
});

test('Jev gets complete JSON state and schema, preserves unspecified fields and applies arbitrary numeric values', async () => {
  const base = snapshot(), requests = [];
  const decide = evaluator({borough: 'set', maxPrice: 'set', minFar: 'set', excludeLandmarks: 'set'}, {borough: o => o.value === 'BK', maxPrice: o => o.value === 1250000, minFar: o => o.value === 1.75, excludeLandmarks: 'enabled'});
  const out = await decideListingFilters({snapshot: base, prompt: 'Brooklyn under $1.25m, 1.75 FAR headroom; exclude landmarks'}, {}, async body => {requests.push(body);return decide(body);});
  assert.equal(requests.length,2,'intent and all actions share one request, changed values use one more');
  for(const key of Object.keys(FILTER_SCHEMA.properties))assert.ok(requests[0].questions[key],`Initial action selection includes ${key}`);
  assert.deepEqual(Object.keys(requests[1].questions).sort(),['borough','excludeLandmarks','maxPrice','minFar']);
  for (const request of requests) {
    assert.deepEqual(request.state.current, base);
    assert.deepEqual(request.state.schema, FILTER_SCHEMA);
    assert.match(request.state.instruction, /Only the prompt may request changes/);
  }
  assert.deepEqual(out.filterUpdate.values, {...base.values, borough: 'BK', maxPrice: 1250000, minFar: 1.75, excludeLandmarks: true});
  assert.deepEqual(out.filterUpdate.base, base);
  assert.equal(out.filterUpdate.values.excludeRisk, false);
});

test('condo hard cost is chat-editable beside the rental figure, changing only the condo value', async () => {
  const base = snapshot();
  const decide = evaluator({condoHardCostPerGrossSqft: 'set'}, {condoHardCostPerGrossSqft: o => o.value === 600});
  const out = await decideListingFilters({snapshot: base, prompt: 'Set condo hard cost to $600'}, {}, decide);
  assert.equal(out.filterUpdate.values.condoHardCostPerGrossSqft, 600);
  assert.equal(out.filterUpdate.values.hardCostPerGrossSqft, base.values.hardCostPerGrossSqft);
  for (const key of FILTER_SCHEMA.required.filter(key => key !== 'condoHardCostPerGrossSqft')) assert.deepEqual(out.filterUpdate.values[key], base.values[key]);
});

test('open text boundaries, multi-select edits and fractional cost values are copied into the full state', async () => {
  const prompt = 'Use Bedford Stuyvesant and r6a. Preview $425 hard cost, 25% soft and 12% carry, factor 1.2. Remove land, add townhouses.';
  const actions = {area: 'set', zoning: 'set', types: 'set', hardCostPerGrossSqft: 'set', softCostPctOfHard: 'set', carryAndFinancingPct: 'set', zfaToGrossFactor: 'set'};
  const selections = {area: o => o.text === 'Bedford', zoning: o => o.text === 'r6a.', types_multi_family: 'include', types_townhomes: 'include', types_single_family: 'exclude', types_duplex_triplex: 'exclude', types_land: 'exclude', hardCostPerGrossSqft: o => o.value === 425, softCostPctOfHard: o => o.value === .25, carryAndFinancingPct: o => o.value === .12, zfaToGrossFactor: o => o.value === 1.2};
  const decide = evaluator(actions, selections);
  const out = await decideListingFilters({snapshot: snapshot(), prompt}, {}, async body => {
    if (body.questions.area?.instructions?.includes?.('last token')) return result({area: Object.keys(body.questions.area.criteria).find(id => body.questions.area.criteria[id].text === 'Bedford Stuyvesant'), zoning: Object.keys(body.questions.zoning.criteria)[0]});
    return decide(body);
  });
  assert.equal(out.filterUpdate.values.area, 'Bedford Stuyvesant');
  assert.equal(out.filterUpdate.values.zoning, 'R6A');
  assert.deepEqual(out.filterUpdate.values.types, ['multi_family', 'townhomes']);
  assert.equal(out.filterUpdate.values.softCostPctOfHard, .25);
  assert.equal(out.filterUpdate.values.carryAndFinancingPct, .12);
});

test('global clear differs from reset, research does not change filters, and malformed replies fail atomically', async () => {
  const request = {snapshot: snapshot(), prompt: 'Clear all filters'};
  const clear = await decideListingFilters(request, {}, evaluator({initialization: 'clear_all'}));
  assert.equal(clear.filterUpdate.values.minPrice, null); assert.equal(clear.filterUpdate.values.followMap, false);
  assert.deepEqual((await decideListingFilters({...request, prompt: 'Reset all'}, {}, evaluator({initialization: 'reset_all'}))).filterUpdate.values, defaultFilterValues());
  const exceptions = await decideListingFilters({...request, prompt: 'Reset all except preserve borough and clear minimum price'}, {}, evaluator({initialization: 'reset_all', borough: 'retain', minPrice: 'clear'}));
  assert.deepEqual(exceptions.filterUpdate.values, {...defaultFilterValues(), borough: 'QN', minPrice: null});
  assert.deepEqual(await decideListingFilters({...request, prompt: 'Why these properties?'}, {}, evaluator({mode: 'research'})), {mode: 'research', filterUpdate: null});
  await assert.rejects(() => decideListingFilters(request, {}, async () => ({answers: {}})), /invalid decision/);
  await assert.rejects(() => decideListingFilters({...request, prompt: 'Maximum 10k'}, {}, evaluator({maxPrice: 'set'}, {maxPrice: o => o.value === 10000})), /cannot exceed/);
});

test('an implausible amount without its unit is refused, not applied: "under 2" is never a $2 price', async () => {
  const base = snapshot(), before = structuredClone(base);
  const refused = [
    ['Show listings under 2', 'maxPrice', 2, /explicit value for Maximum price.*No filters changed/],
    ['Asking at least 500', 'minPrice', 500, /explicit value for Minimum price.*No filters changed/],
    ['Raise the maximum price by 2', 'maxPrice', 2000002, /explicit value for Maximum price.*No filters changed/],
    ['Project cost under 3', 'maxProjectCost', 3, /explicit value for Maximum project cost.*No filters changed/],
    ['Under 2 per buildable foot', 'maxPpb', 2, /explicit value for Maximum \$\/BSF.*No filters changed/],
    ['Lots of at least 25', 'minLot', 25, /explicit value for Minimum lot area.*No filters changed/],
    ['At least 60 FAR of headroom', 'minFar', 60, /explicit value for FAR headroom.*No filters changed/],
    ['At least 60k FAR of headroom', 'minFar', 60000, /explicit value for FAR headroom.*No filters changed/],
  ];
  for (const [prompt, field, value, message] of refused) {
    await assert.rejects(decideListingFilters({prompt, snapshot: base}, {}, evaluator({[field]: 'set'}, {[field]: option => option.value === value})), message, prompt);
    assert.deepEqual(base, before);
  }
  const applied = [
    ['Show listings under $2m', 'maxPrice', 2000000],
    ['Under 2 million', 'maxPrice', 2000000],
    ['Under 2,500,000', 'maxPrice', 2500000],
    ['Asking at least $750k', 'minPrice', 750000],
    ['Under $300 per buildable foot', 'maxPpb', 300],
    ['Lots of at least 2,500 square feet', 'minLot', 2500],
    ['At least 1.5 FAR of headroom', 'minFar', 1.5],
  ];
  const open = {...base, values: {...base.values, maxPrice: null}};
  for (const [prompt, field, value] of applied) {
    const out = await decideListingFilters({prompt, snapshot: open}, {}, evaluator({[field]: 'set'}, {[field]: option => option.value === value}));
    assert.equal(out.filterUpdate.values[field], value, prompt);
  }
});

test('numeric source candidates preserve arbitrary units and written amounts', () => {
  const values = numericCandidates('$1.235m, 2,500 SF, twenty five percent and two hundred thousand dollars');
  assert.deepEqual(values.map(o => o.value), [1235000, 2500, 25, 200000]);
  assert.equal(values[2].percent, true);
  assert.deepEqual(numericCandidates('-5 and 500k-2m').map(o => o.value), [-5, 500000, 2000000]);
});

test('leading-decimal candidates preserve amount, percent, sign and source spans', () => {
  const prompt = '$.5m, .75 FAR, .5%, -.25, 500k-.75m, .125 thousand, $0.5m';
  const candidates = numericCandidates(prompt);
  assert.deepEqual(candidates.map(candidate => candidate.value), [500000, .75, .5, -.25, 500000, 750000, 125, 500000]);
  assert.equal(candidates[0].source, '$.5m');
  assert.equal(candidates[2].percent, true);
  for (const candidate of candidates) assert.ok(prompt.slice(candidate.position).startsWith(candidate.source));
});

test('leading decimals reach complete atomic filter updates at their intended scale', async () => {
  const base = snapshot(), before = structuredClone(base);
  const cases = [
    ['Cap asking price at $.5m.', 'maxPrice', 500000, 500000],
    ['Set soft costs to .5 percent.', 'softCostPctOfHard', .005, .005],
    ['Set minimum FAR headroom to .75.', 'minFar', .75, .75],
    ['Reduce hard costs by .5 percent.', 'hardCostPerGrossSqft', 373.125, 373],
  ];
  for (const [prompt, field, candidate, expected] of cases) {
    const select = evaluator({[field]: 'set'}, {[field]: option => option.value === candidate});
    const out = await decideListingFilters({prompt, snapshot: base}, {}, body => {
      assert.deepEqual(body.state.current, base);
      assert.deepEqual(body.state.schema, FILTER_SCHEMA);
      return select(body);
    });
    assert.equal(out.mode, 'filters');
    assert.deepEqual(out.filterUpdate.base, base);
    assert.deepEqual(out.filterUpdate.values, {...base.values, [field]: expected});
    assert.deepEqual(base, before);
  }
});

test('comma-separated negative decimal prices remain invalid and leave the snapshot untouched', async () => {
  const base = snapshot(), before = structuredClone(base);
  for (const prompt of ['Set price limits to 100000, -.5m.', 'Set maximum price to -.5m.']) {
    await assert.rejects(decideListingFilters({prompt, snapshot: base}, {}, evaluator({maxPrice: 'set'}, {maxPrice: option => option.value === -500000})), /Invalid filter: maxPrice/);
    assert.deepEqual(base, before);
  }
});

test('authenticated chat HTTP persists filter snapshots and completed updates without invoking research or integrations', {timeout: 5000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-filter-chat-')), owner = 'a'.repeat(24), db = join(dir, 'chat.sqlite');
  const store = new ChatStore(db), base = snapshot(); let researchCalls = 0, queued;
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store, execute: async () => {researchCalls++;return {answer: 'Research answer', sources: [], ui: []};}, sessions: {forAccount: async () => {throw new Error('Filter command must not initialize integrations');}}, filterDecider: request => decideListingFilters(request, {}, evaluator({maxPrice: 'set'}, {maxPrice: o => o.value === 1250000}))});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {method, headers: {authorization: 'Bearer test', 'x-acres-account': owner, 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  try {
    const conversation = store.createConversation(owner), id = randomUUID();
    const body = {message: 'Under $1.25m', id, listingFilters: {prompt: 'Under $1.25m', snapshot: base}};
    assert.equal((await api(`/conversations/${conversation.id}/runs`, 'POST', body)).status, 202);
    assert.match(await (await api(`/runs/${id}/events`)).text(), /run.completed/);
    const assistant = store.conversation(owner, conversation.id).messages.find(message => message.role === 'assistant');
    assert.equal(assistant.filterContext, true); assert.equal(assistant.filterUpdate.values.maxPrice, 1250000);
    assert.deepEqual(assistant.filterUpdate.base, base); assert.equal(researchCalls, 0);
    assert.deepEqual(store.runEvents(id)[0].listingFilters, body.listingFilters);
    assert.equal((await api(`/conversations/${conversation.id}/runs`, 'POST', body)).status, 202);
    assert.equal((await api(`/conversations/${conversation.id}/runs`, 'POST', {...body, listingFilters: {...body.listingFilters, snapshot: {...base, revision: 8}}})).status, 409);
    assert.equal(store.conversation(owner, conversation.id).messages.length, 2);
    queued = store.createRun(owner, conversation.id, body.message, randomUUID(), body.listingFilters);
  } finally {server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();}
  const reopened = new ChatStore(db);
  try {
    assert.equal(reopened.list(owner).length, 1);
    assert.equal(reopened.run(owner, queued.id).status, 'queued');
    const manager = new RunManager(reopened, {}, async () => {throw new Error('Queued filters must not invoke research');}, null, null, null, request => decideListingFilters(request, {}, evaluator({maxPrice: 'set'}, {maxPrice: o => o.value === 1250000})));
    const finished = new Promise(resolve => manager.on(queued.id, event => {if (event.event === 'run.completed') resolve();}));
    manager.pump(); await finished;
    assert.equal(reopened.run(owner, queued.id).result.filterUpdate.values.maxPrice, 1250000);
    assert.deepEqual(reopened.run(owner, queued.id).result.filterUpdate.base, base);
  } finally {reopened.close();rmSync(dir, {recursive: true});}
});

test('research and combined requests preserve normal execution and publish the full filter context', {timeout: 5000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-filter-research-')), owner = 'a'.repeat(24), store = new ChatStore(join(dir, 'chat.sqlite'));
  const calls = [], base = snapshot();
  const manager = new RunManager(store, {}, async input => {calls.push(input);return {answer: 'Research evidence', sources: [], ui: [], dealSearch: {borough: 'BK'}};}, null, null, null, request => decideListingFilters(request, {}, evaluator(request.prompt === 'Why?' ? {mode: 'research'} : {mode: 'both', borough: 'set'}, {borough: o => o.value === 'BK'})));
  try {
    for (const prompt of ['Why?', 'Set Brooklyn and explain the risks']) {
      const conversation = store.createConversation(owner), id = randomUUID();
      const finished = new Promise(resolve => manager.on(id, event => {if (event.event === 'run.completed') resolve();}));
      manager.enqueue(owner, conversation.id, prompt, id, {prompt, snapshot: base}); await finished;
      const answer = store.conversation(owner, conversation.id).messages.find(message => message.role === 'assistant');
      assert.equal(answer.filterContext, true); assert.equal(answer.text, 'Research evidence');
      assert.deepEqual(answer.dealSearch, {borough: 'BK'});
      if (prompt === 'Why?') assert.equal(answer.filterUpdate, undefined);
      else assert.deepEqual(answer.filterUpdate.values, {...base.values, borough: 'BK'});
    }
    assert.equal(calls.length, 2); assert.deepEqual(calls[0].listingContext, base); assert.match(calls[0].message, /Authoritative listing filters/); assert.deepEqual(calls[1].listingContext, {...base, values: {...base.values, borough: 'BK'}});
    assert.match(calls[1].message, /Authoritative listing filters/); assert.match(calls[1].message, /"borough":"BK"/);
  } finally {store.close();rmSync(dir, {recursive: true});}
});

test('stopping a filter request while Jev is working never publishes its update', {timeout: 5000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-filter-stop-')), owner = 'a'.repeat(24), store = new ChatStore(join(dir, 'chat.sqlite'));
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const manager = new RunManager(store, {}, async () => {throw new Error('No research');}, null, null, null, async () => {await pending;return {mode: 'filters', answer: 'Updated filters', filterUpdate: {base: snapshot(), values: defaultFilterValues()}};});
  try {
    const conversation = store.createConversation(owner), id = randomUUID();
    const finished = new Promise(resolve => manager.on(id, event => {if (event.event === 'run.interrupted') resolve();}));
    manager.enqueue(owner, conversation.id, 'Clear all', id, {prompt: 'Clear all', snapshot: snapshot()});
    await manager.control(owner, id, 'interrupt'); release(); await finished;
    assert.equal(store.run(owner, id).status, 'interrupted');
    assert.equal(store.conversation(owner, conversation.id).messages.some(message => message.filterUpdate), false);
  } finally {release();store.close();rmSync(dir, {recursive: true});}
});

test('a request that leaves every filter as it is carries no filterUpdate, so the chat offers nothing to reapply', async () => {
  const request = {snapshot: snapshot(), prompt: 'Keep my filters as they are'};
  assert.deepEqual(await decideListingFilters(request, {}, evaluator({mode: 'preserve'})), {mode: 'filters', filterUpdate: null, answer: 'Your filters are unchanged.'});
  const same = await decideListingFilters({...request, prompt: 'Show Queens'}, {}, evaluator({borough: 'set'}, {borough: o => o.value === 'QN'}));
  assert.deepEqual(same, {mode: 'filters', filterUpdate: null, answer: 'These filters already match your request.'});
  const dir = mkdtempSync(join(tmpdir(), 'acres-filter-noop-')), owner = 'a'.repeat(24), store = new ChatStore(join(dir, 'chat.sqlite'));
  const manager = new RunManager(store, {}, async () => {throw new Error('No research');}, null, null, null, async () => ({mode: 'filters', filterUpdate: null, answer: 'Your filters are unchanged.'}));
  try {
    const conversation = store.createConversation(owner), id = randomUUID();
    const finished = new Promise(resolve => manager.on(id, event => {if (event.event === 'run.completed') resolve();}));
    manager.enqueue(owner, conversation.id, 'Keep my filters', id, {prompt: 'Keep my filters', snapshot: snapshot()}); await finished;
    const answer = store.conversation(owner, conversation.id).messages.find(message => message.role === 'assistant');
    assert.equal(answer.filterContext, true); assert.equal(answer.text, 'Your filters are unchanged.');
    assert.equal(Object.hasOwn(answer, 'filterUpdate'), false, 'the saved message carries no update to reapply');
  } finally {store.close();rmSync(dir, {recursive: true});}
});
