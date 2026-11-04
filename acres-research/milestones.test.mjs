import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFilingOutcome, fetchNycPublicRecords} from './nycdb.mjs';
import {summarizeEnvelope, zrSectionUrl} from './zoning.mjs';
import {buildParcelDiagnostics} from './parcels.mjs';
import {createMunicipalRecordsTools, evaluateFloridaLiveLocalAct} from './municipal-records.mjs';
import {createFloorplanAuditTools} from './floorplan-audit.mjs';
import {buildUnderwritingDeck, createDeliverableTools, renderDeckHtml} from './deliverable.mjs';

test('Fix #1: nycdb classifyFilingOutcome handles withdrawal_flag="0" and reports endpointStatus', async () => {
  assert.equal(
    classifyFilingOutcome('X', 'SIGNED OFF', '0'),
    'signed_off',
    'withdrawal_flag="0" must not misclassify SIGNED OFF jobs as withdrawn'
  );
  assert.equal(
    classifyFilingOutcome('R', 'PERMIT ISSUED - ENTIRE JOB/WORK', '0'),
    'approved_or_permitted'
  );
  assert.equal(
    classifyFilingOutcome('P', 'IN PROCESS', 'Y'),
    'withdrawn'
  );

  // Simulate one endpoint failing (dobBisJobs) while others succeed
  const res = await fetchNycPublicRecords(
    {bbl: '3001910030'},
    {
      request: async url => {
        if (String(url).includes('ic3t-wcy2')) throw new Error('HTTP 503');
        return [];
      },
    }
  );
  assert.match(res.endpointStatus.dobBis, /unavailable/);
  assert.ok(res.unavailableEndpoints.some(e => e.startsWith('dobBis')));
  assert.equal(res.submittalForensics.unavailableEndpoints.length, 1);
});

// Serves ACRIS fixtures the way NYC Open Data does: legals rows filtered by the
// query's own WHERE clause and cut at its $limit, master rows by document id.
const acrisRequest = (legals, masters, {failDocumentLegals = false} = {}) => async url => {
  const u = decodeURIComponent(String(url));
  const limit = Number(u.match(/\$limit=(\d+)/)[1]);
  const ids = (u.match(/document_id IN \(([^)]*)\)/)?.[1] || '').split(',').map(id => id.replace(/'/g, ''));
  if (u.includes('8h5j-fqxa')) {
    const borough = u.match(/borough='(\d)'/)[1];
    const block = u.match(/block='(\d+)'/)[1];
    const subjectLot = u.match(/\(lot='(\d+)'/)?.[1];
    const lotIn = u.match(/lot IN \(([^)]*)\)/)?.[1].split(',').map(l => l.replace(/'/g, ''));
    if (lotIn) return legals.filter(r => r.borough === borough && r.block === block && lotIn.includes(r.lot)).map(r => ({document_id: r.document_id})).slice(0, limit);
    if (!subjectLot && failDocumentLegals) throw new Error('NYC Open Data returned HTTP 500');
    return legals
      .filter(r => r.borough === borough && r.block === block)
      .filter(r => (subjectLot ? r.lot === subjectLot || r.air_rights === 'Y' || r.easement === 'Y' : ids.includes(r.document_id)))
      .slice(0, limit);
  }
  if (u.includes('bnx9-e6tj')) return masters.filter(m => ids.includes(m.document_id)).slice(0, limit);
  return [];
};
const legalsRow = (document_id, block, lot, flags = '') => ({
  document_id, borough: '1', block, lot, air_rights: flags.includes('A') ? 'Y' : 'N', easement: flags.includes('E') ? 'Y' : 'N',
});

test('ACRIS instruments are split into subject-lot documents and other-lot block instruments', async () => {
  const res = await fetchNycPublicRecords(
    {bbl: '1008010009'},
    {
      request: acrisRequest(
        [legalsRow('DEED1', '801', '9'), legalsRow('ZLD1', '801', '12', 'A')],
        [
          {document_id: 'DEED1', doc_type: 'DEED', crfn: '2019000111111'},
          {document_id: 'ZLD1', doc_type: 'ZONE', crfn: '2019000222222'},
        ]
      ),
    }
  );
  assert.deepEqual(res.subjectLotInstruments.map(d => [d.documentId, d.docType]), [['DEED1', 'DEED']]);
  assert.deepEqual(res.otherLotsOnBlock.map(d => [d.documentId, d.docType, d.lots, d.lotsComplete]), [['ZLD1', 'ZONE', ['12'], true]]);
  assert.equal(res.acrisDocuments.length, 2);
  assert.match(res.proseReportingMandate, /ZONE \(CRFN 2019000222222\) on lot 12/);
  assert.match(res.proseReportingMandate, /never attribute it to lot 9/);
  assert.doesNotMatch(res.proseReportingMandate, /—| - /);
});

test('a multi-lot ACRIS instrument is read in full: subject when any of its lots is the subject lot, with every lot listed', async () => {
  // MULTI is recorded on six lots but flagged for air rights only on lot 11, so the
  // lot query returns two of its rows; EASE1 is flagged on lots 11 and 13 only.
  const lots = ['2', '4', '11', '12', '13', '14'];
  const res = await fetchNycPublicRecords(
    {bbl: '1000880002'},
    {
      request: acrisRequest(
        [
          ...lots.map(lot => legalsRow('MULTI', '88', lot, lot === '11' ? 'A' : '')),
          legalsRow('EASE1', '88', '11', 'E'),
          legalsRow('EASE1', '88', '13', 'E'),
          legalsRow('EASE1', '88', '15'),
          legalsRow('EASE1', '89', '2'),
        ],
        [
          {document_id: 'MULTI', doc_type: 'MTGE', crfn: '2005000033214'},
          {document_id: 'EASE1', doc_type: 'EASE', crfn: '2010000444444'},
        ]
      ),
    }
  );
  assert.equal(res.acrisDocuments.length, 2);
  assert.deepEqual(res.subjectLotInstruments, [{documentId: 'MULTI', crfn: '2005000033214', docType: 'MTGE', lots, lotsComplete: true}]);
  assert.equal(res.acrisDocuments.find(d => d.documentId === 'MULTI').airRights, true);
  assert.deepEqual(res.otherLotsOnBlock.map(d => [d.documentId, d.lots]), [['EASE1', ['11', '13', '15']]]);
  assert.doesNotMatch(res.proseReportingMandate, /2005000033214/);
  assert.match(res.proseReportingMandate, /EASE \(CRFN 2010000444444\) on lots 11, 13, 15\./);
});

test('a subject-lot instrument whose subject row falls past the ACRIS cap is still labelled the subject lot\'s', async () => {
  // Every row on a block shares one good_through_date, so the cap cuts arbitrarily:
  // here the DECL and DEVR rows for lot 12 come after the cap.
  const legals = [
    legalsRow('DECL1', '88', '13', 'A'),
    legalsRow('DEVR1', '88', '13', 'A'),
    legalsRow('NEIGH', '88', '4', 'E'),
    legalsRow('DECL1', '88', '12'),
    legalsRow('DEVR1', '88', '12'),
  ];
  const masters = [
    {document_id: 'DECL1', doc_type: 'DECL', crfn: '2004000521065'},
    {document_id: 'DEVR1', doc_type: 'DEVR', crfn: '2004000521064'},
    {document_id: 'NEIGH', doc_type: 'EASE', crfn: '2011000555555'},
  ];
  const res = await fetchNycPublicRecords({bbl: '1000880012', limit: 3}, {request: acrisRequest(legals, masters)});
  assert.deepEqual(res.subjectLotInstruments.map(d => [d.docType, d.lots]), [['DECL', ['12', '13']], ['DEVR', ['12', '13']]]);
  assert.deepEqual(res.otherLotsOnBlock.map(d => [d.docType, d.lots]), [['EASE', ['4']]]);
  // The development rights instrument is named as the subject's zoning lot instrument, never as a neighbor's.
  assert.deepEqual(res.zoningLotInstruments.map(d => [d.docType, d.type, d.lots]), [['DEVR', 'development rights', ['12', '13']]]);
  assert.match(res.proseReportingMandate, /zoning lot instrument\(s\) on this lot: development rights \(DEVR, CRFN 2004000521064/);
  assert.doesNotMatch(res.proseReportingMandate.split('recorded only on other lots')[1], /2004000521065|2004000521064/);

  // Without the full legals rows nothing is asserted to lie only on other lots.
  const partial = await fetchNycPublicRecords(
    {bbl: '1000880012', limit: 3},
    {request: acrisRequest(legals, masters, {failDocumentLegals: true})}
  );
  assert.deepEqual(partial.subjectLotInstruments, []);
  assert.deepEqual(partial.otherLotsOnBlock.map(d => [d.docType, d.lotsComplete]), [['DECL', false], ['DEVR', false], ['EASE', false]]);
  assert.doesNotMatch(partial.proseReportingMandate, /never attribute|recorded only on other lots/);
  assert.match(partial.proseReportingMandate, /full lot lists could not be read.*do not state whether these instruments also cover lot 12/);
});

test('a zoning lot description beyond the capped lot query is still found by type and reported', async () => {
  // The capped query returns only the three newest-looking rows; the 1998 ZONE row is not among them.
  const legals = [legalsRow('MTG1', '88', '12'), legalsRow('MTG2', '88', '12'), legalsRow('SAT1', '88', '12'), legalsRow('ZONE98', '88', '12'), legalsRow('ZONE98', '88', '14')];
  const masters = [
    {document_id: 'MTG1', doc_type: 'MTGE'}, {document_id: 'MTG2', doc_type: 'MTGE'}, {document_id: 'SAT1', doc_type: 'SAT'},
    {document_id: 'ZONE98', doc_type: 'ZONE', crfn: '1998000123456', recorded_datetime: '1998-06-02T00:00:00.000'},
  ];
  const res = await fetchNycPublicRecords({bbl: '1000880012', limit: 3}, {request: acrisRequest(legals, masters)});
  assert.equal(res.endpointStatus.acrisZoningLotInstruments, 'ok');
  assert.deepEqual(res.zoningLotInstruments.map(d => [d.documentId, d.type, d.lots, d.recordedDate]), [['ZONE98', 'zoning lot description', ['12', '14'], '1998-06-02']]);
  assert.ok(res.submittalForensics.airRightsOrEasementInstruments.some(d => d.documentId === 'ZONE98'));
  assert.match(res.proseReportingMandate, /zoning lot description \(ZONE, CRFN 1998000123456, recorded 1998-06-02, lots 12, 14\)/);
});

test('a condominium billing lot asks to confirm unit lot instruments, and a row without a lot is never called a neighbor', async () => {
  const res = await fetchNycPublicRecords(
    {bbl: '1008017501'},
    {
      request: acrisRequest(
        [
          legalsRow('DECL', '801', '7501'),
          legalsRow('UNIT', '801', '1009', 'AE'),
          legalsRow('LOT1', '801', '1', 'A'),
          legalsRow('NOLOT', '801', null, 'A'),
          legalsRow('NEIGHBOR', '801', '40', 'A'),
        ],
        [
          {document_id: 'DECL', doc_type: 'DECL', crfn: 'C0'},
          {document_id: 'UNIT', doc_type: 'DEED', crfn: 'C1'},
          {document_id: 'LOT1', doc_type: 'EASE', crfn: 'C4'},
          {document_id: 'NOLOT', doc_type: 'AGMT', crfn: 'C2'},
          {document_id: 'NEIGHBOR', doc_type: 'ZONE', crfn: 'C3'},
        ]
      ),
    }
  );
  assert.deepEqual(res.subjectLotInstruments.map(d => d.documentId), ['DECL']);
  assert.deepEqual(res.condominiumLotsToConfirm.map(d => d.documentId), ['UNIT', 'LOT1']);
  assert.deepEqual(res.otherLotsOnBlock.map(d => d.documentId), ['NEIGHBOR']);
  assert.equal(res.acrisDocuments.length, 5);
  assert.doesNotMatch(res.proseReportingMandate, /lot null|CRFN C0\b|CRFN C2\b/);
  assert.match(res.proseReportingMandate, /ZONE \(CRFN C3\) on lot 40\. .*never attribute it to lot 7501/);
  assert.match(res.proseReportingMandate, /DEED \(CRFN C1\) on lot 1009; EASE \(CRFN C4\) on lot 1\. .*confirm from the condominium declaration that those lots belong to billing lot 7501/);
});

test('Fix #2: summarizeEnvelope uses exact PLUTO lot dimensions and attaches sectionUrls', () => {
  const computed = {
    regime: 'UAP',
    form: 'base',
    district: 'R6A',
    use: 'residential',
    lot: {areaSqft: 7030, widthFeet: 100, depthFeet: 70.3, streets: [{side: 'front', wide: true}]},
    controls: {
      streetWall: {minBaseHeightFeet: 40, maxBaseHeightFeet: 65},
      setbacks: {depthFeet: {wide: 10, narrow: 15}},
      coverage: {basePercent: 80},
      yards: {rearYard: {requiredFeet: 20}},
    },
    metrics: {floorAreaSqft: 27400, far: 3.9, storeys: 8, heightFeet: 85},
    citations: ['ZR 23-22', 'ZR 23-342'],
  };
  const property = {lotarea: 7025, lotfront: 100, lotdepth: 70.25, lottype: '5'};
  const summary = summarizeEnvelope(computed, property, null, []);
  assert.equal(summary.lotGeometrySensitivity.exactLotAreaSqft, 7025);
  assert.equal(summary.lotGeometrySensitivity.interiorLotScenario.maxResidentialFootprintAt80PctSqft, 5620);
  assert.equal(summary.lotGeometrySensitivity.cornerLotScenario.maxResidentialFootprintAt100PctSqft, 7025);
  // ZR 23-342: 24.75 ft short of 95 ft takes 12.375 ft off each yard, never below 10 ft.
  assert.deepEqual([summary.lotGeometrySensitivity.shallowLotScenario.reducedRearYardFeet, summary.lotGeometrySensitivity.shallowLotScenario.reducedRearYardAbove75FeetFeet], [10, 17.63]);
  assert.equal(zrSectionUrl('23-22'), 'https://zr.planning.nyc.gov/article-ii/chapter-3#23-22');
  assert.ok(summary.sectionUrls['ZR 23-22'].includes('/article-ii/chapter-3#23-22'));
});

test('Fix #4: buildParcelDiagnostics flags residential overbuild even when community facility FAR is higher', () => {
  const diag = buildParcelDiagnostics({
    bbl: '1003480066',
    lot: 66,
    bldgclass: 'C7',
    lotarea: 2500,
    lotfront: 25,
    lotdepth: 100,
    bldgarea: 8100,
    builtfar: 3.24,
    residfar: 2.43,
    affresfar: 3.9,
    commfar: 0,
    facilfar: 4.8,
  });
  assert.equal(diag.bulkComplianceAndZfaBands.isOverbuiltRelativeToStandardResidentialFar, true);
  assert.equal(diag.bulkComplianceAndZfaBands.apparentResidentialOverageSqFt, 2025);
  assert.match(diag.bulkComplianceAndZfaBands.nonComplyingBulkAdvisory, /ZR 54-31/);
  assert.match(diag.bulkComplianceAndZfaBands.nonComplyingBulkAdvisory, /ZR 54-41/);
});

test('Milestone A: Multi-city municipal parcel & zoning adapter (Miami, Fort Lauderdale, New Haven)', async () => {
  const recorded = [];
  const tools = createMunicipalRecordsTools({
    record: src => { recorded.push(src); return {id: recorded.length}; },
    request: async () => ({features: []}),
  });

  const miami = await tools.handlers.acres_municipal_parcel_records({
    address: '1400 Biscayne Blvd, Miami, FL',
    zoningCode: 'T6-24A-O',
    lotAreaSqft: 43560,
  });
  assert.equal(miami.jurisdiction, 'US-FL-MIAMI');
  assert.equal(miami.zoningDistrict, 'T6-24A-O');
  assert.equal(miami.computedCapacity.baseMaxFloorAreaSqft, 304920);
  assert.equal(miami.computedCapacity.publicBenefitsBonusMaxFloorAreaSqft, 396396);
  assert.equal(miami.computedCapacity.maxAsOfRightUnits, 150);
  assert.equal(miami.floridaLiveLocalActAnalysis.eligibleByZoningCategory, true);

  const ftl = await tools.handlers.acres_municipal_parcel_records({
    address: '200 E Las Olas Blvd, Fort Lauderdale, FL',
    zoningCode: 'RAC-CC',
    lotAreaSqft: 30000,
  });
  assert.equal(ftl.jurisdiction, 'US-FL-FORTLAUDERDALE');
  assert.equal(ftl.zoningDistrict, 'RAC-CC');

  const nh = await tools.handlers.acres_municipal_parcel_records({
    address: '360 State Street, New Haven, CT',
    zoningCode: 'BD-1',
    lotAreaSqft: 20000,
  });
  assert.equal(nh.jurisdiction, 'US-CT-NEWHAVEN');
  assert.equal(nh.computedCapacity.maxFloorAreaSqft, 120000);
});

test('Milestone B: Architectural floor-plan efficiency audit ("Upload & Critique")', async () => {
  const tools = createFloorplanAuditTools({
    getMarket: () => ({
      rents: [{bedrooms: 1, rentPerSqftPerMonth: 7.5}],
      salePrices: [{bedrooms: 2, pricePerSqft: 1650}],
    }),
  });
  const audit = await tools.handlers.acres_audit_floorplan({
    productType: 'rental',
    grossFloorAreaSqft: 50000,
    netRentableOrSellableSqft: 36500,
    corridorCirculationSqft: 6500,
    elevatorStairCoreSqft: 4000,
    buildingDepthFeet: 85,
    coreToWindowDepthFeet: 38,
    deadEndCorridorFeet: 62,
    sprinklered: true,
    capRate: 0.05,
  });
  assert.equal(audit.summaryMetrics.currentEfficiency, 0.73);
  assert.equal(audit.summaryMetrics.recoverableNetSqft, 4500);
  assert.equal(audit.codeAndLivabilityAudit.deadEndStatus, 'EXCEEDS_SCREENING_THRESHOLD');
  assert.equal(audit.codeAndLivabilityAudit.habitableDepthStatus, 'WARNING_DEEP_FLOORPLATE');
  assert.ok(audit.proFormaValueUplift.rentalScenario.capitalizedAssetValueUpliftUsd > 5000000);
});

test('Milestone C: Institutional underwriting deck generator & HTML renderer', async () => {
  const tools = createDeliverableTools({
    getStateSnapshot: () => ({
      property: {bbl: '1000477501', address: '120 BROADWAY', borough: 'MN', zonedist1: 'C5-5', lotarea: 50000, bldgarea: 100000, builtfar: 2, residfar: 10, affresfar: 12},
      envelope: {district: 'C5-5', floorArea: {maxFar: 12, maxFloorAreaSqft: 600000}, density: {maxUnits: 882}},
      program: {productType: 'rental', residentialGrossSqft: 500000, efficiency: 0.82, netResidentialSqft: 410000, units: 580, byBedrooms: [{bedrooms: 1, label: 'One bedroom', mixPercent: 45, units: 261, unitSqft: 650, netSqft: 169650, rentPerSqftPerMonth: 7.5, monthlyRent: 4875}]},
      proFormas: [{name: 'Base Rental', productType: 'rental', development: {totalDevelopmentCost: 350000000}, operations: {netOperatingIncome: 24500000}, returns: {yieldOnCost: 0.07, profit: 85000000}}],
    }),
    getSources: () => [{id: 1, title: 'NYC PLUTO', url: 'https://data.cityofnewyork.us/'}],
  });
  const deck = await tools.handlers.acres_generate_deck({
    investmentThesis: 'Proceed with UAP affordable bonus residential tower.',
  });
  assert.equal(deck.slideCount, 7);
  const html = renderDeckHtml(deck);
  assert.match(html, /Feasibility and underwriting package/);
  assert.match(html, /120 BROADWAY/);
  assert.match(html, /Diligence Risks, Next Steps &amp; Verification Trail/);
});

test('the deck reads persisted envelope capacity, summary and floor-plan audits', () => {
  const field = value => ({value, provenance: {tool: 'test', run: 'r1', sources: []}, stale: null, updated: 1});
  const deck = buildUnderwritingDeck({projectState: {
    property: field({bbl: '1000477501', address: '120 BROADWAY'}),
    envelope: field({
      district: 'C5-5', floorArea: {maxFar: 15, maxFloorAreaSqft: 600000}, metrics: {storeys: 40},
      capacity: {lotAreaSqft: 40000, builtFloorAreaSqft: 100000, builtFar: 2.5, byUse: {residential: {maxFar: 10, maxFloorAreaSqft: 400000, remainingFloorAreaSqft: 300000}}},
      summary: {baseHeightMinFeet: 60, baseHeightMaxFeet: 85, maxBuildingHeightFeet: 210, maxDwellingUnits: 600, stoppedBy: 'floor area'},
    }),
    floorplanAudits: field([{productType: 'rental', summaryMetrics: {grossFloorAreaSqft: 500000, currentEfficiencyPercent: 78, targetBenchmarkEfficiencyPercent: 85, recoverableNetSqft: 12000}}]),
  }});
  const [, , s3, s4] = deck.slides;
  assert.equal(s3.envelope.baseHeightMinFeet, 60);
  assert.equal(s3.envelope.baseHeightMaxFeet, 85);
  assert.equal(s3.envelope.maxHeightFeet, 210);
  assert.equal(s3.envelope.maxUnits, 600);
  assert.equal(s3.envelope.stoppedBy, 'floor area');
  assert.deepEqual(s3.capacity, {lotAreaSqft: 40000, builtFloorAreaSqft: 100000, builtFar: 2.5, existingBasis: 'pluto_gross', banded: false, wholeLotBound: false, remainingFloorAreaSqftByUse: {residential: 300000}, remainingFloorAreaSqftRangeByUse: {residential: {atFullGfa: 300000, at85PercentGfa: 300000}}});
  assert.equal(s4.floorplanAudit.summaryMetrics.recoverableNetSqft, 12000);
  const html = renderDeckHtml(deck);
  assert.match(html, /Unused floor area/);
  assert.match(html, /<th scope="row">Residential<\/th><td class="num">300,000<\/td><td class="unit">sq ft<\/td>/);
});

test('deck sources drop markdown link syntax and offset suffixes, dedupe by URL and fall back to domain plus path', () => {
  const civic = 'https://cdnsm5-hosted.civiclive.com/UserFiles/Servers/Server_6189660/File/City%20Hall/Ord.%202025-059.pdf';
  const agenda = 'https://townofharrison.com/AgendaCenter/ViewFile/Agenda/_12162025-645';
  const deck = buildUnderwritingDeck({sources: [
    {title: '[Chapter 18:14 Short-Term Rentals](https://ecode360.com/36690277#36690277)', url: 'https://ecode360.com/36690277'},
    {title: '[Chapter 18:14 Short-Term Rentals](https://ecode360.com/36690277#36690277) (offset 2456)', url: 'https://ecode360.com/36690277'},
    {title: civic, url: civic},
    {title: `${civic} (offset 24000)`, url: civic},
    {title: `${agenda} (offset 50861)`, url: agenda},
    {title: agenda, url: agenda},
    {title: 'Short-Term Rental', url: 'https://www.townofharrison.com/342/Short-Term-Rental'},
  ]});
  assert.deepEqual(deck.sources.map(s => [s.title, s.domain, s.url]), [
    ['Chapter 18:14 Short-Term Rentals', 'ecode360.com', 'https://ecode360.com/36690277'],
    ['cdnsm5-hosted.civiclive.com/UserFiles/Servers/Server_6189660/File/City Hall/Ord. 2025-059.pdf', 'cdnsm5-hosted.civiclive.com', civic],
    ['townofharrison.com/AgendaCenter/ViewFile/Agenda/_12162025-645', 'townofharrison.com', agenda],
    ['Short-Term Rental', 'townofharrison.com', 'https://www.townofharrison.com/342/Short-Term-Rental'],
  ]);
  const s7 = deck.slides.at(-1);
  assert.equal(s7.sources.length, 4);
  assert.doesNotMatch(s7.subtitle, /\d/);

  const html = renderDeckHtml(deck);
  assert.doesNotMatch(html, /\]\(https?:/);
  assert.doesNotMatch(html, /\(offset \d+\)/);
  for (const url of [civic, agenda, 'https://ecode360.com/36690277']) {
    assert.equal(html.split(`>${url}</a>`).length - 1, 1, `${url} is shown once as a link`);
    assert.equal(html.split(url).length - 1, 2, `${url} appears only in one href and one link text`);
  }
});

test('the rendered deck has no em dashes and keeps numeric slides in right-aligned tables', () => {
  const deck = buildUnderwritingDeck({projectState: {
    property: {bbl: '1000477501', address: '120 BROADWAY', borough: 'MN', zonedist1: 'C5-5', lotarea: 50000},
    envelope: {district: 'C5-5', floorArea: {maxFar: 12, maxFloorAreaSqft: 600000}, density: {maxUnits: 882}},
    program: {productType: 'rental', units: 580, byBedrooms: [{label: 'One bedroom', mixPercent: 45, units: 261, unitSqft: 650, netSqft: 169650, rentPerSqftPerMonth: 7.5, monthlyRent: 4875}]},
    proFormas: [{development: {totalDevelopmentCost: 350000000}, operations: {netOperatingIncome: 24500000}, returns: {yieldOnCost: 0.07, profit: 85000000}}],
  }});
  assert.doesNotMatch(deck.title, /—/);
  const html = renderDeckHtml(deck);
  assert.doesNotMatch(html, /—|&mdash;/);
  assert.match(html, /<td class="num">\$350,000,000<\/td>/);
  assert.match(html, /<td class="num">7\.00%<\/td>/);
  assert.match(html, /<td class="num" data-label="Units">261<\/td>/);
  assert.match(html, /@page/);
});
