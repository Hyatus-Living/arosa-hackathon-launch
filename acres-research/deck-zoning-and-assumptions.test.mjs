import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {buildUnderwritingDeck, renderDeckHtml} from './deliverable.mjs';
import {capacity, headlineReconciliation} from './zoning.mjs';

// Visible text with a space between cells and blocks.
const text = node => { const out = []; const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c.data); else walk(c); } }; walk(node); return out.join(' ').replace(/\s+/g, ' '); };
const field = (value, stale = null, updated = Date.UTC(2026, 9, 20, 15)) => ({value, stale, updated, provenance: {sources: []}});
const parcel = {lotarea: '10000', bldgarea: '20000', residfar: '6', commfar: '2', numfloors: '4'};
const cap = capacity(parcel);
const filed = {proposal: {jobNumber: '121234567', jobType: 'NB', status: 'PERMIT ISSUED - ENTIRE JOB/WORK', proposedZoningSqft: 90000, filingDate: '2025-02-01'}, stage: 'approved', notOperative: 'the ledger records no zoning lot span for new building filings, so its ZFA may cover a merged zoning lot or only part of this tax lot'};
const envelope = {district: 'R7A', floorArea: {maxFar: 6, maxFloorAreaSqft: 60000}, metrics: {floorAreaSqft: 56000, storeys: 8}, capacity: cap, headlineReconciliation: headlineReconciliation(cap, filed)};

test('the zoning slide prints remaining floor area as 85 to 100 percent ranges and the operative figure with its filed context', () => {
  const deck = buildUnderwritingDeck({projectState: {envelope: field(envelope)}});
  const s3 = deck.slides[2];
  assert.deepEqual(s3.capacity.remainingFloorAreaSqftRangeByUse, {residential: {atFullGfa: 40000, at85PercentGfa: 43000}, commercial: {atFullGfa: 0, at85PercentGfa: 3000}});
  assert.equal(s3.zoningHeadline.operativeSqft, 60000);
  const html = renderDeckHtml(deck);
  const {document} = parseHTML(html);
  const slide = text(document.querySelector('#zoning-and-entitlements'));
  assert.match(slide, /Unused floor area \(existing building read as 100 to 85 percent of PLUTO gross area\)/);
  assert.match(slide, /Residential 40,000 to 43,000 sq ft/);
  assert.match(slide, /Commercial 0 to 3,000 sq ft/);
  assert.match(slide, /Headline zoning floor area/);
  assert.match(slide, /DOB filed proposed ZFA \(governing NB\/A1\), context only 90,000 sq ft/);
  assert.match(slide, /Operative figure 60,000 sq ft/);
  assert.match(slide, /The zoning maximum stands, PLUTO residential FAR 6/);
  assert.match(slide, /ZD1 or certificate of occupancy audit/);
  assert.doesNotMatch(html, /—/, 'no em dashes in deck copy');
  // A vacant lot has no existing building to convert, so its remaining area is one figure.
  const vacant = capacity({...parcel, bldgarea: '0'});
  const vacantSlide = renderDeckHtml(buildUnderwritingDeck({projectState: {envelope: field({...envelope, capacity: vacant})}}));
  assert.match(vacantSlide, /Unused floor area \(vacant lot\)/);
  assert.match(vacantSlide, />60,000</);
});

test('the pro forma slide shows the saved underwriting assumptions with when they were saved', () => {
  const assumptions = {landPrice: 1234567, hardCostPerSqft: 777, capRate: 0.055, financing: {loanToCost: 0.6, termMonths: 30}};
  const deck = buildUnderwritingDeck({projectState: {assumptions: field(assumptions)}});
  assert.equal(deck.slides[5].assumptions.values.hardCostPerSqft, 777);
  assert.match(JSON.stringify(deck), /777/);
  const {document} = parseHTML(renderDeckHtml(deck));
  const slide = text(document.querySelector('#pro-forma-and-feasibility'));
  assert.match(slide, /Underwriting assumptions, saved October 20, 2026/);
  assert.match(slide, /Land price \$1,234,567/);
  assert.match(slide, /Hard cost per sq ft \$777/);
  assert.match(slide, /Cap rate 5\.50%/);
  assert.match(slide, /Loan to cost 60\.00%/);
  assert.match(slide, /Loan term 30 months/);
  assert.match(slide, /Inputs not listed use the pro forma defaults\./);
  // Projections recomputed from older assumptions are flagged on the slide that shows them.
  const stale = buildUnderwritingDeck({projectState: {assumptions: field(assumptions), proFormas: field([{development: {totalDevelopmentCost: 1}}], 'assumptions')}});
  assert.match(parseHTML(renderDeckHtml(stale)).document.querySelector('#pro-forma-and-feasibility .freshness-note').textContent, /underwriting assumptions changed/);
  assert.equal(buildUnderwritingDeck({projectState: {}}).slides[5].assumptions, null);
});

test('the deck says a building area PLUTO does not record is not recorded, on the cover and the parcel page', () => {
  const site = {bbl: '1000470001', address: '1 EXAMPLE STREET', zonedist1: 'R9A', lotarea: '10000', residfar: '6', builtfar: '0', bldgarea: '0', numbldgs: '2', yearbuilt: '1925'};
  const gapCap = capacity(site);
  const html = renderDeckHtml(buildUnderwritingDeck({projectState: {property: field(site), envelope: field({...envelope, capacity: gapCap, headlineReconciliation: headlineReconciliation(gapCap, filed)})}}));
  const {document} = parseHTML(html);
  assert.match(text(document.querySelector('.key-facts')), /Existing floor area Not recorded in PLUTO/);
  const parcelPage = text(document.querySelector('#site-parcel-forensics'));
  assert.match(parcelPage, /Existing floor area Not recorded in PLUTO/);
  assert.doesNotMatch(parcelPage, /Existing floor area 0|Built 0\.00/);
  assert.doesNotMatch(html, /vacant lot/);
  for (const vacant of [{bldgarea: '0', numbldgs: '0', yearbuilt: '0'}, {bldgarea: '0', yearbuilt: '2019', bldgclass: 'V1', landuse: '11'}]) {
    const vacantHtml = renderDeckHtml(buildUnderwritingDeck({projectState: {property: field({...site, ...vacant})}}));
    assert.match(text(parseHTML(vacantHtml).document.querySelector('.key-facts')), /Existing floor area 0 sq ft/, JSON.stringify(vacant));
  }
});
