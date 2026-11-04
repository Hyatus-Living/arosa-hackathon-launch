import test from 'node:test';
import assert from 'node:assert/strict';
import {research} from './research.mjs';
import {fieldsFromResult} from './project-state.mjs';
import {siteProgress} from '../app-starter/public/core-model.js';

// A synthetic corner lot: the agent values it straight from the subject brief and never calls the
// envelope tool, as a free-form listing underwriting can.
const property = {
  borough: 'BK', address: '100 SAMPLE AVENUE', zipcode: '11230', bbl: '3099990001', block: '9999', lot: '1',
  zonedist1: 'R7A', zonedist2: '', overlay1: '', spdist1: '', lotarea: 9000, bldgarea: 4000, numfloors: 2,
  yearbuilt: 1930, bldgclass: 'K1', lotfront: 90, lotdepth: 100, lottype: '3', builtfar: 0.44, residfar: 4, commfar: 0, facilfar: 4,
  affresfar: 5.01, landmark: '', histdist: '', splitzone: 'N', firm07_flag: '', pfirm15_flag: '', edesignum: '', ownername: 'SAMPLE LLC',
};
const market = {submarket: 'Sample, Brooklyn', rents: [{bedrooms: 1, rentPerSqftPerMonth: 5, source: 'User', retrievedAt: '2026-10-01'}]};
const terms = {productType: 'rental', program: {grossBuildingSqft: 40_000, units: [{bedrooms: 1, count: 50, netSqft: 650}]}, landPrice: 6_000_000, hardCostPerSqft: 400, softCostPerSqft: 90,
  financing: {loanToCost: 0.6, interestRate: 0.08, termMonths: 30}, operating: {residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 9000, commercialVacancyRate: 0, commercialOpexPerSqftPerYear: 0}, capRate: 0.06};
const valueOnly = async ({execute}) => { await execute('acres_pro_forma', {name: 'Rental', ...terms}); return 'The residual land value is in the pro forma [1].'; };
const run = (priorState, agent = valueOnly) => research({message: 'Underwrite this listing and give a residual land value', propertyBbl: property.bbl, priorState}, {ENABLE_CURATED_ZONING: true}, () => {}, () => {}, () => {}, agent);
// What the run saves, whether or not its prose passed the citation check.
const savedBy = promise => promise.then(out => out, error => error.partialResult);
const at = Date.UTC(2026, 9, 22);
const saved = fields => ({fields: Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, {...f, stale: null, updated: at}]))});

test('a run that values a site without calling the envelope tool still saves the envelope, so no step is left unstarted', async () => {
  const out = await run({property, market});
  assert.ok(out.proFormas.length, 'the pro forma is saved');
  assert.equal(out.envelope?.summary?.district, 'R7A', 'the envelope the valuation rests on is saved with it');
  const fields = fieldsFromResult(out, 'run');
  assert.ok(fields.envelope.provenance.sources.some(s => s.url === out.sources.find(x => x.id === out.envelopeSourceId).url), 'and cited to its zoning source');
  const progress = siteProgress(saved({property: fields.property ?? {value: property}, envelope: fields.envelope, proFormas: fields.proFormas}));
  assert.equal(progress.done, 3, 'property, build and worth are done; only the decision is left');
  assert.equal(progress.next, 4);
});

test('the envelope is filled only when the run valued the site and none is saved', async () => {
  const lookup = await savedBy(run({property, market}, async () => 'Only a question about the parcel.'));
  assert.equal(lookup.envelope, null, 'a run that values nothing leaves step 2 to its own request');
  const kept = await savedBy(run({property, market, envelope: {district: 'R7A', saved: true}}));
  assert.ok(kept.proFormas.length);
  assert.equal(kept.envelope, null, 'a saved envelope for the same parcel is kept, not replaced');
});
