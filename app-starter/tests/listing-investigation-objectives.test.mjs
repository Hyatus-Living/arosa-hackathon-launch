import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';

test('each investment objective says in one line what the research looks for first', async () => {
  const {window} = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event});
  const {createListingInvestigation, OBJECTIVE_NOTES} = await import('../public/listing-investigation.js');
  const {dialog} = createListingInvestigation({listing_id: 'l1', address: '1 Main St'}, {request: () => new Promise(() => {}), post: () => new Promise(() => {}), streamFactory: () => ({close() {}})});
  const select = dialog.querySelector('select[name="objective"]'), note = dialog.querySelector('#investigation-objective-note');
  assert.deepEqual([...select.querySelectorAll('option')].map(o => o.value), Object.keys(OBJECTIVE_NOTES));
  assert.equal(note.textContent, OBJECTIVE_NOTES['acquisition screening']);
  assert.equal(select.getAttribute('aria-describedby'), note.id);
  for (const option of select.querySelectorAll('option')) option.toggleAttribute('selected', option.value === 'rental hold');
  select.dispatchEvent(new window.Event('change'));
  assert.equal(note.textContent, OBJECTIVE_NOTES['rental hold']);
  for (const text of Object.values(OBJECTIVE_NOTES)) assert.ok(text.length < 120 && !text.includes('—'), text);
});
