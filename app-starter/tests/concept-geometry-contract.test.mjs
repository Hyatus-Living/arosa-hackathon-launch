import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {fullState} from './fixtures/project-state.mjs';

const source = readFileSync(new URL('../frontend/concept-view.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function conceptGeometry(');
const end = source.indexOf('\nasync function createConceptRenderer', start);
assert.ok(start >= 0 && end > start);
const {conceptGeometry, geometryMessage} = vm.runInNewContext(`${source.slice(start, end)}; ({conceptGeometry, geometryMessage})`, {Map, Object, Array, Number});

test('fixture massing has a concrete lot and storey footprints', () => {
  for (const concept of fullState.fields.concepts.value) {
    const geometry = conceptGeometry(concept);
    assert.equal(geometry.lot.length, 4, concept.id);
    assert.equal(geometry.levels.length, concept.metrics.storeys, concept.id);
    assert.ok(geometry.levels.every(level => level.footprint.length === 4), concept.id);
    assert.equal(geometryMessage(geometry), null, concept.id);
  }
});

test('missing scene or malformed geometry is reported instead of inferred', () => {
  const noScene = conceptGeometry({levels: []});
  assert.equal(noScene.lot.length, 0);
  assert.match(geometryMessage(noScene), /no valid lot polygon/);
  const noFootprints = conceptGeometry({lot: [[0, 0], [1, 0], [1, 1]], levels: [{footprint: [[0, 0], [1, 0]]}]});
  assert.match(geometryMessage(noFootprints), /no valid storey footprints/);
});
