import test from 'node:test';
import assert from 'node:assert/strict';
import {createConceptTools} from './concepts.mjs';

const lot = [[0, 0], [100, 0], [100, 50], [0, 50]];

test('models a stepped massing in feet, reports areas, FAR and height, and emits the concept', async () => {
  const events = [];
  const tools = createConceptTools({emit: (event, data) => events.push({event, ...data})});
  const result = await tools.handlers.acres_model_concept({
    name: 'As-of-right envelope', summary: 'C5-5 base with a setback above the 6th floor.', maxFar: 15, maxHeightFeet: 200,
    lot,
    levels: [
      {label: 'Ground retail', use: 'retail', footprint: lot, height: 16},
      {use: 'office', footprint: lot, height: 12, count: 5},
      {use: 'office', footprint: [[10, 10], [90, 10], [90, 40], [10, 40]], height: 12, count: 4},
    ],
  });
  assert.equal(result.metrics.storeys, 10);
  assert.equal(result.metrics.lotAreaSqft, 5000);
  assert.equal(result.metrics.grossFloorAreaSqft, 5000 * 6 + 2400 * 4);
  assert.equal(result.metrics.far, 7.92);
  assert.equal(result.metrics.heightFeet, 16 + 12 * 9);
  assert.equal(result.metrics.remainingFloorAreaSqft, 15 * 5000 - 39600);
  assert.equal(result.metrics.heightMarginFeet, 200 - 124);
  assert.equal(result.levels[0].label, 'Ground retail');
  assert.equal(result.levels[6].floorElevationFeet, 76);
  assert.equal(result.levels[9].areaSqft, 2400);
  assert.equal(tools.concepts.length, 1);
  const concept = tools.concepts[0];
  assert.equal(concept.id, result.conceptId);
  const types = Object.values(concept.scene.nodes).map(n => n.type);
  assert.equal(types.filter(t => t === 'level').length, 10);
  assert.equal(types.filter(t => t === 'wall').length, 40);
  // Pascal 1.0.4 story shells also derive one room zone per storey, beside the lot zone.
  const zones = Object.values(concept.scene.nodes).filter(n => n.type === 'zone');
  assert.equal(zones.length, 11);
  assert.deepEqual(zones.filter(z => z.name === 'Lot').map(z => z.polygon), [lot.map(([x, z]) => [x * 0.3048, z * 0.3048])]);
  assert.equal(zones.filter(z => z.name !== 'Lot').length, 10);
  assert.ok(Object.values(concept.scene.nodes).some(n => n.type === 'wall' && Math.abs(n.height - 16 * 0.3048) < 1e-6));
  const levelHeights = Object.values(concept.scene.nodes).filter(n => n.type === 'level').map(n => Math.round(n.height / 0.3048)).sort((a, b) => a - b);
  assert.deepEqual(levelHeights, [12, 12, 12, 12, 12, 12, 12, 12, 12, 16]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'concept.created');
  assert.equal(events[0].id, concept.id);
  assert.equal(events[0].scene, undefined);
  assert.equal(events[0].metrics.far, 7.92);
});

test('accepts metric input and rejects bad geometry, excessive storeys and more than four concepts', async () => {
  const tools = createConceptTools();
  const metric = await tools.handlers.acres_model_concept({name: 'Metric', units: 'm', lot: [[0, 0], [30, 0], [30, 20], [0, 20]], levels: [{footprint: [[0, 0], [30, 0], [30, 20], [0, 20]], height: 4}]});
  assert.equal(metric.metrics.lotAreaSqft, 6458);
  assert.equal(metric.levels[0].heightFeet, 13.1);
  await assert.rejects(tools.handlers.acres_model_concept({name: 'Bad lot', lot: [[0, 0], [1, 1]], levels: [{footprint: lot, height: 10}]}), /polygon/);
  await assert.rejects(tools.handlers.acres_model_concept({name: 'Flat', lot, levels: [{footprint: lot, height: 0}]}), /height/);
  await assert.rejects(tools.handlers.acres_model_concept({name: 'Tower', lot, levels: [{footprint: lot, height: 10, count: 60}, {footprint: lot, height: 10}]}), /storeys/);
  await assert.rejects(tools.handlers.acres_model_concept({name: '', lot, levels: [{footprint: lot, height: 10}]}), /name/);
  for (const i of [2, 3, 4]) await tools.handlers.acres_model_concept({name: 'Concept ' + i, lot, levels: [{footprint: lot, height: 10}]});
  await assert.rejects(tools.handlers.acres_model_concept({name: 'Concept 5', lot, levels: [{footprint: lot, height: 10}]}), /At most 4/);
});

test('adds surrounding buildings and the existing building when a subject property is selected', async () => {
  const LAT = 40.708, LON = -74.0107, k = 111320, kx = k * Math.cos((LAT * Math.PI) / 180);
  const box = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2], [x1, z1]].map(([x, z]) => [LON + x / kx, LAT - z / k]);
  const row = (bin, bbl, ring, height) => ({bin, base_bbl: bbl, height_roof: String(height), ground_elevation: '20', the_geom: {type: 'MultiPolygon', coordinates: [[ring]]}});
  const rows = [row('1', '1000470001', box(-10, -15, 10, 15), 85), row('2', '1000470002', box(10, -15, 30, 15), 40), row('3', '1000470003', box(-30, -15, -10, 15), 120), row('4', '1000470004', box(-10, 15, 10, 40), 30)];
  const property = {bbl: '1000470001', latitude: String(LAT), longitude: String(LON), numfloors: '8', bldgarea: '48000'};
  const sources = [], events = [];
  let requests = 0, fail = false;
  const tools = createConceptTools({
    emit: (event, data) => events.push({event, ...data}),
    getProperty: () => property,
    record: source => { sources.push({id: sources.length + 1, ...source}); return sources.at(-1); },
    request: async () => { requests++; if (fail) throw new Error('offline'); return rows; },
  });
  const args = {name: 'Replacement', lot: [[0, 0], [66, 0], [66, 98], [0, 98]], levels: [{footprint: [[0, 0], [66, 0], [66, 98], [0, 98]], height: 14, count: 12}]};
  const result = await tools.handlers.acres_model_concept(args);
  assert.equal(requests, 3, 'footprints plus exact and containing tax-lot lookups (stub rows carry no bbl field, so no parcel matches)');
  assert.equal(result.context.buildings, 3);
  assert.equal(result.context.existing.heightFeet, 85);
  assert.equal(result.context.existing.storeys, 8);
  assert.equal(result.context.sourceId, 1);
  assert.match(result.note, /3 surrounding buildings .* \(source 1\)/);
  assert.match(result.note, /existing building on the lot is about 85 ft tall/);
  assert.equal(sources[0].title, 'NYC building footprints near the property');
  const concept = tools.concepts[0];
  assert.equal(concept.context.buildings.length, 4);
  assert.equal(concept.context.buildings[0].existing, true);
  assert.equal(concept.context.sourceId, 1);
  assert.deepEqual(concept.lot[1], [Number((66 * 0.3048).toFixed(3)), 0]);
  assert.equal(concept.levels[0].footprint.length, 4);
  assert.equal(result.levels[0].footprint, undefined);
  assert.equal(events[0].context.buildings, 3);
  assert.equal(events[0].context.existing.heightFeet, 85);
  assert.equal(events[0].levels[0].footprint, undefined);

  // The same block is reused for the next concept, opting out skips it, and a failure degrades.
  await tools.handlers.acres_model_concept({...args, name: 'Second'});
  assert.equal(requests, 3);
  const skipped = await tools.handlers.acres_model_concept({...args, name: 'Third', context: false});
  assert.equal(skipped.context, undefined);
  assert.equal(tools.concepts[2].context, null);
  fail = true;
  const failed = await tools.handlers.acres_model_concept({...args, name: 'Fourth', contextRadiusMeters: 200});
  assert.equal(failed.context, undefined);
  assert.match(failed.note, /Surrounding buildings were unavailable/);
  assert.equal(tools.concepts[3].context, null);
});

test('explains the missing context when no property is selected', async () => {
  const tools = createConceptTools({request: async () => { throw new Error('must not be called'); }});
  const result = await tools.handlers.acres_model_concept({name: 'Alone', lot, levels: [{footprint: lot, height: 10}]});
  assert.match(result.note, /No subject property is selected/);
  assert.equal(tools.concepts[0].context, null);
});

test('counts dwelling units per storey and area per unit', async () => {
  const tools = createConceptTools();
  const result = await tools.handlers.acres_model_concept({name: 'Units', lot, levels: [{use: 'retail', footprint: lot, height: 15}, {use: 'residential', footprint: lot, height: 10.5, count: 4, units: 5}, {use: 'residential', footprint: lot, height: 10.5, units: 2}]});
  assert.equal(result.metrics.units, 22);
  assert.equal(result.metrics.grossSqftPerUnit, Math.round((5000 * 5) / 22));
  assert.equal(result.levels[0].units, undefined);
  assert.equal(result.levels[1].units, 5);
  const none = await tools.handlers.acres_model_concept({name: 'No units', lot, levels: [{footprint: lot, height: 10}]});
  assert.equal(none.metrics.units, undefined);
  await assert.rejects(tools.handlers.acres_model_concept({name: 'Bad', lot, levels: [{footprint: lot, height: 10, units: 2.5}]}), /Units per storey/);
});

test('concepts are screened against a supplied envelope', async () => {
  const tools = createConceptTools({});
  const envelope = {levels: [{footprint: lot, height: 12, count: 3}]};
  const inside = await tools.handlers.acres_model_concept({
    name: 'Inside', lot, envelope,
    levels: [{footprint: [[10, 5], [90, 5], [90, 45], [10, 45]], height: 12, count: 2}],
  });
  assert.equal(inside.compliance.compliant, true);
  assert.equal(inside.compliance.levels.length, 3);
  assert.equal(tools.concepts[0].envelope.levels.length, 3);
  assert.equal(tools.concepts[0].envelope.heightFeet, 36);
  assert.match(inside.note, /every modeled storey sits within/);
  const breaching = await tools.handlers.acres_model_concept({
    name: 'Breaching', lot, envelope,
    levels: [
      {footprint: lot, height: 12},
      {label: 'Too wide', footprint: [[-5, 0], [100, 0], [100, 50], [-5, 50]], height: 12},
      {label: 'Too tall', footprint: lot, height: 12, count: 3},
    ],
  });
  assert.equal(breaching.compliance.compliant, false);
  assert.ok(breaching.compliance.violations.some(v => v.level === 'Too wide' && /outside the envelope/.test(v.reason)));
  assert.ok(breaching.compliance.violations.some(v => /above the envelope top/.test(v.reason)));
  assert.equal(tools.concepts[1].compliance.compliant, false);
  assert.match(breaching.note, /Envelope check/);
  assert.doesNotMatch(JSON.stringify([inside, breaching]), /\u2014/);
});

test('revisions carry version lineage and metric deltas', async () => {
  const tools = createConceptTools({});
  const first = await tools.handlers.acres_model_concept({name: 'Tower A', lot, levels: [{footprint: lot, height: 12, count: 5}]});
  assert.equal(first.version, 1);
  const second = await tools.handlers.acres_model_concept({
    name: 'Tower A taller', lot, parentConceptId: first.conceptId, revisionNote: 'two storeys added',
    levels: [{footprint: lot, height: 12, count: 7}],
  });
  assert.equal(second.version, 2);
  assert.equal(second.revision.parentName, 'Tower A');
  assert.equal(second.revision.deltas.grossFloorAreaSqft, 10000);
  assert.equal(second.revision.deltas.storeys, 2);
  assert.match(second.note, /Revision v2 of “Tower A”: two storeys added \(\+10,000 sq ft/);
  assert.equal(tools.concepts[1].revision.parentConceptId, first.conceptId);
  // Cross-answer revision: parent metrics echoed from the earlier result still yield deltas.
  const other = createConceptTools({});
  const third = await other.handlers.acres_model_concept({
    name: 'Tower A shorter', lot, parentConceptId: first.conceptId, parentName: 'Tower A', parentVersion: 1,
    parentMetrics: {grossFloorAreaSqft: first.metrics.grossFloorAreaSqft, far: first.metrics.far, heightFeet: first.metrics.heightFeet, storeys: first.metrics.storeys},
    levels: [{footprint: lot, height: 12, count: 4}],
  });
  assert.equal(third.version, 2);
  assert.equal(third.revision.deltas.grossFloorAreaSqft, -5000);
  assert.equal(third.revision.parentMetricsSource, 'supplied');
});
