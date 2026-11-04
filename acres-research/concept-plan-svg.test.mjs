import assert from 'node:assert/strict';
import test from 'node:test';
import {conceptPlanSvg} from './concept-plan-svg.mjs';
import {buildUnderwritingDeck, renderDeckHtml as deckHtml} from './deliverable.mjs';

const concept = {
  id: 'c1', name: 'Scheme "A" <west>', units: 'ft',
  metrics: {storeys: 3, grossFloorAreaSqft: 24000, far: 3.2, heightFeet: 36},
  lot: [[0, 0], [30, 0], [30, 24], [0, 24]],
  levels: [
    {footprint: [[2, 2], [28, 2], [28, 22], [2, 22]]},
    {footprint: [[2, 2], [28, 2], [28, 22], [2, 22]]},
    {footprint: [[2, 2], [20, 2], [20, 22], [2, 22]]},
  ],
  envelope: {levels: [{footprint: [[0, 0], [30, 0], [30, 24], [0, 24]]}]},
  context: {north: [0.2, -1], sourceId: '5zhs-2jue', buildings: [
    {polygon: [[-40, 0], [-32, 0], [-32, 20], [-40, 20]], existing: false},
    {polygon: [[3, 3], [27, 3], [27, 21], [3, 21]], existing: true},
  ]},
};

test('the deck plan draws lot, storeys, envelope, neighbours, scale and north from stored geometry', () => {
  const svg = conceptPlanSvg(concept);
  assert.match(svg, /^<svg class="concept-plan-svg"/);
  assert.match(svg, /aria-label="Plan of Scheme &quot;A&quot; &lt;west&gt;"/, 'the concept name is escaped');
  assert.doesNotMatch(svg, /<west>/);
  assert.equal((svg.match(/<path/g) || []).length, 7, 'neighbour, lot, envelope, two distinct storeys, existing, north arrow');
  assert.match(svg, />L1–2</);
  assert.match(svg, />L3</);
  assert.match(svg, />STREET</);
  assert.match(svg, />50 ft</);
  assert.match(svg, />N</);
  assert.equal(conceptPlanSvg(concept), svg, 'deterministic');
});

test('no drawable geometry, no figure: null instead of an empty or NaN drawing', () => {
  assert.equal(conceptPlanSvg(null), null);
  assert.equal(conceptPlanSvg({name: 'legacy', metrics: {storeys: 2}}), null);
  assert.equal(conceptPlanSvg({lot: [[0, 0], [1, 0]], levels: [{footprint: [[0, 0], [1, 0], [1, 1]]}]}), null);
  assert.equal(conceptPlanSvg({lot: [[0, 0], [10, 0], [10, 10], [0, 10]], levels: [{footprint: [[0, 0], [Number.NaN, 0], [1, 1]]}]}), null);
  assert.equal(conceptPlanSvg({lot: [[0, 0], [0, 0], [0, 0]], levels: [{footprint: [[0, 0], [0, 0], [0, 0]]}]}), null);
});

test('the underwriting deck embeds the plan on slide 4 with its hypothesis caption', () => {
  const deck = buildUnderwritingDeck({projectState: {concepts: [concept]}});
  const slide4 = deck.slides.find(s => s.slideNumber === 4);
  assert.match(slide4.concept.planSvg, /^<svg/);
  const html = deckHtml(deck);
  assert.match(html, /<svg class="concept-plan-svg"/);
  assert.match(html, /illustrates a feasibility hypothesis, not an entitlement, survey, or construction document/);
  assert.match(html, /Surrounding buildings from NYC building footprints \(5zhs-2jue\); placement is approximate/);
  const bare = buildUnderwritingDeck({projectState: {concepts: [{name: 'legacy', metrics: {storeys: 2, grossFloorAreaSqft: 9000, far: 1.5, heightFeet: 24}}]}});
  assert.equal(bare.slides.find(s => s.slideNumber === 4).concept.planSvg, null);
  assert.doesNotMatch(deckHtml(bare), /<svg class="concept-plan-svg"/);
});
