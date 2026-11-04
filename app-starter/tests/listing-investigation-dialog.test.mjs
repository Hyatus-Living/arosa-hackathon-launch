import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';

const {window} = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event});
const {createListingInvestigation} = await import('../public/listing-investigation.js');

const policy = {enabled: true, billed: false, modes: {standard: {enabled: true}, max: {enabled: true}}};
const completed = {id: 'job-2', depth: 'max', status: 'completed', created: Date.parse('2026-10-20T12:00:00Z'), eventSeq: 9, result: {answer: '## Decision brief\n\nThe lot carries an open HPD violation [1].', sources: [{id: 1, url: 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json', title: 'HPD violations'}], unresolvedCitationCount: 0}};
const older = {...completed, id: 'job-1', depth: 'standard', created: Date.parse('2026-10-01T12:00:00Z')};
const open = saved => createListingInvestigation({listing_id: 'l1', address: '1 Main St'}, {
  request: url => Promise.resolve(url.endsWith('/policy') ? policy : {investigations: saved}),
  post: () => new Promise(() => {}),
  streamFactory: () => ({close() {}}),
});

test('a completed report opens findings first, above saved history, with the new-investigation form collapsed', async () => {
  const {dialog, ready} = open([completed, older]);
  await ready;
  const children = [...dialog.children];
  const report = dialog.querySelector('.investigation-report').parentNode;
  const history = dialog.querySelector('.investigation-history');
  const controls = dialog.querySelector('.investigation-controls');
  const setup = dialog.querySelector('details.investigation-setup');
  assert.match(report.textContent, /open HPD violation/);
  assert.ok(children.indexOf(report) < children.indexOf(history), 'the report precedes saved history');
  assert.ok(children.indexOf(report) < children.indexOf(controls), 'the report precedes the controls');
  assert.equal(setup.hasAttribute('open'), false);
  assert.equal(history.querySelectorAll('button').length, 2);
});

test('a newest run that failed does not hide the older completed report', async () => {
  const failedNewest = {id: 'job-3', depth: 'standard', status: 'failed', created: Date.parse('2026-10-25T12:00:00Z'), eventSeq: 4, error: 'The research provider could not finish this investigation.'};
  const {dialog, ready} = open([failedNewest, completed, older]);
  await ready;
  assert.match(dialog.querySelector('.investigation-report').textContent, /open HPD violation/, 'the completed report opens first');
  assert.match(dialog.textContent, /Research complete · Max/, 'the status line names the completed run');
  assert.equal(dialog.querySelectorAll('.investigation-history button').length, 3, 'the failed run stays one click away in history');
});

test('with no saved report the new-investigation form stays open', async () => {
  const {dialog, ready} = open([]);
  await ready;
  assert.equal(dialog.querySelector('details.investigation-setup').hasAttribute('open'), true);
  assert.equal(dialog.querySelector('.investigation-report'), null);
});
