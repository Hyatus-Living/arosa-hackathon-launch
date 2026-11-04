import test from 'node:test';
import assert from 'node:assert/strict';
import {readDraft, writeDraft, draftKey, PLAN_SCHEMA} from '../public/plan-intake.js';

function store(value) {
  const data = new Map(value === undefined ? [] : [[draftKey('p1'), value]]);
  return {data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v)};
}
const draft = {schema: PLAN_SCHEMA, units: 'm', name: 'Work in progress', revision: 4, levels: [], walls: [], openings: [], rooms: [], objects: [], sources: []};

test('a damaged local draft is ignored without deleting its recoverable bytes or blocking saved-plan loading', () => {
  for (const raw of ['{broken', '42', '"text"', '[]', '{"schema":"other"}', '{"schema":"acres.architecture.plan/1"}']) {
    const storage = store(raw);
    assert.equal(readDraft(storage, 'p1'), null);
    assert.equal(storage.getItem(draftKey('p1')), raw);
  }
});

test('valid incomplete geometry remains recoverable and another site draft is not substituted', () => {
  const storage = store();writeDraft(storage, 'p1', draft);
  assert.deepEqual(readDraft(storage, 'p1'), draft);
  assert.equal(readDraft(storage, 'other-site'), null);
});

test('blocked browser storage does not prevent loading the saved plan', () => {
  assert.equal(readDraft({getItem() { throw new Error('Storage blocked'); }}, 'p1'), null);
});
