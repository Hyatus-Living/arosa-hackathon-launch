import test from 'node:test';
import assert from 'node:assert/strict';
import {addPlanNote, planNotesLine, withPlanNotes} from '../public/plan-notes.js';

test('plan notes: identical notes collapse and only the latest saved revision is kept', () => {
  let notes = [];
  notes = addPlanNote(notes, {kind: 'revision', revision: 3});
  notes = addPlanNote(notes, {kind: 'drawing', name: 'floor.jpg'});
  notes = addPlanNote(notes, {kind: 'drawing', name: 'floor.jpg'});
  notes = addPlanNote(notes, {kind: 'revision', revision: 4});
  assert.deepEqual(notes, [{kind: 'drawing', name: 'floor.jpg'}, {kind: 'revision', revision: 4}]);
  assert.equal(planNotesLine(notes), 'Arosa will see: you attached floor.jpg; you saved revision 4');
});

test('plan notes ride on the next message and never push it past the length limit', () => {
  const notes = [{kind: 'drawing', name: 'floor.jpg'}, {kind: 'revision', revision: 4}];
  assert.equal(withPlanNotes('Check the egress.', notes), '[Plan update: I attached the drawing "floor.jpg" to the floor plan. I saved revision 4 of the floor plan.]\n\nCheck the egress.');
  assert.equal(withPlanNotes('Check the egress.', []), 'Check the egress.');
  const long = 'x'.repeat(2990);
  assert.equal(withPlanNotes(long, notes), long);
});
