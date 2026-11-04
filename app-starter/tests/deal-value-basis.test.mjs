import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {MarketStore, computeDealValuation} from '../../acres-research/market-store.mjs';

// One listing as the store serves it: a cheap vacant lot that is landmarked, so its price earns a
// better tier than it is shown.
function servedDeal() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-deal-basis-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, landmark_flag,
      flood_zone, units_res, year_built, first_seen_at, last_seen_at)
      VALUES ('a', 'for_sale', '2 Example Ave', '11216', 'BK', '3000010001', 800000, 5000, 50, 100, '5', 0, 4, 5.01, 'R7A', 1, 1, 0, 2020, 1, 1)`).run();
    return store.searchDeals({listingId: 'a'})[0];
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

test('the inspector and cards say what sets the value and why a tier is held down', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector} = await import('../public/listing-inspector.js');
  const {listingCard} = await import('../public/listing-card.js');
  const {pricePerBuildable} = await import('../public/deal-card.js');
  const {normalizeDealRow} = await import('../public/deals.js');

  const deal = servedDeal();
  assert.equal(deal.flashcardValuation.priceVerdict, 'great_deal');
  assert.equal(deal.flashcardValuation.dealVerdict, 'fair_deal');
  assert.equal(pricePerBuildable(normalizeDealRow(deal)), deal.pricePerBuildableSf);

  const view = renderInspector(deal, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  const section = [...view.querySelectorAll('section.inspector-section')].find(s => s.querySelector('h3')?.textContent === 'What sets the value');
  assert.ok(section, 'the inspector has a value basis section');
  assert.match(section.textContent, /Value set by(Rental|Condo sales) (with the affordability bonus|on the standard envelope)/);
  assert.match(section.textContent, /Hard cost\$\d+\/GSF: house default, wood or light-gauge steel low-rise at this price level in the published New York range of \$260 to \$510/);
  assert.match(section.textContent, /Priced Great, held at Fair: Landmark or historic district, Flood zone/);
  assert.match(view.textContent, /Flood zone/);
  // The tier line under the pill names the price tier as well as the tier shown.
  assert.match(view.querySelector('.inspector-tier-basis').textContent, /^\$\d+\/BSF against land worth up to \$\d+\/BSF at your costs\. Priced Great, held at Fair: Landmark or historic district, Flood zone\.$/);

  const card = listingCard(deal, {onOpen() {}});
  assert.equal(card.querySelector('.listing-card-hold').textContent, 'Priced Great, held at Fair: Landmark or historic district, Flood zone');
  // An uncapped listing shows no hold line.
  const open = {...deal, flashcardValuation: {...deal.flashcardValuation, dealVerdict: 'great_deal', gates: []}, dealVerdict: 'great_deal'};
  assert.equal(listingCard(open, {onOpen() {}}).querySelector('.listing-card-hold'), null);
});

// A served listing as the inspector reads it: a high-rise on a narrow lot, valued at the reader's saved hard cost.
const highRise = {
  id: 'hr', address: '9 Tower St', bbl: '1000010001', borough: 'MN', listPrice: 6_000_000, pricePerBuildableSf: 115,
  maxBuildableUnits: 76, plannedUnits: 49, pricePerBuildableUnit: 122_449,
  plannedUnitBasis: {exit: 'condo', unitNetSqft: 910, rentalUnitNetSqft: 600, netEfficiency: 0.85, netSellableSqft: 44_200, unitSizes: {scope: 'zip:11249', label: 'ZIP 11249', sampleCount: 48, asOf: '2026-10-21', summary: 'ZIP 11249 condos, median 910 SF (48 listings)'}},
  flashcardValuation: {
    dealVerdict: 'great_deal', priceVerdict: 'great_deal', gates: [],
    slidingScalePricePerBsf: {greatDealMaxBsf: 160, goodDealMaxBsf: 230, badDealMinBsf: 300},
    valueDriver: {program: 'standard', exit: 'condo', buildableZfa: 52_000, affordableZfa: 0, storeys: 14, floorplateSqft: 3700, netEfficiency: 0.85, heightClass: 'high-rise', narrowLot: true,
      hardCostPerGrossSqft: 540, baseHardCostPerGrossSqft: 400, heightClassFactor: 1.25, narrowLotFactor: 1.08, grossFactor: 1.15},
  },
};
const house = {hardCostPerGrossSqft: 375, softCostPctOfHard: 0.22, carryAndFinancingPct: 0.1, zfaToGrossFactor: 1.15};

const normalizeForHold = (raw) => ({...raw, deal_verdict: raw.flashcardValuation.dealVerdict, list_price: raw.list_price ?? raw.listPrice});

test('the listing page says what the tier rests on, with the deal\'s own numbers', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector, tierBasis, tierMethod} = await import('../public/listing-inspector.js');
  assert.equal(tierBasis(highRise), '$115/BSF against land worth up to $230/BSF at your costs.');
  assert.match(tierMethod(highRise), /^Fewer than five development sites sold nearby, so the tier compares the ask per buildable SF with what a developer can pay/);
  const view = renderInspector(highRise, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  const line = view.querySelector('.inspector-pills + .inspector-tier-basis');
  assert.ok(line, 'the line sits under the tier pill');
  assert.equal(line.textContent, tierBasis(highRise));
  // How the tier is set sits closed under the line, with the deal tiers article.
  const method = view.querySelector('.inspector-tier-basis + details.inspector-tier-method');
  assert.ok(method && !method.open, 'the method is behind a closed disclosure');
  assert.equal(method.querySelector('summary').textContent, 'How the tier is set');
  assert.equal(method.querySelector('p').textContent, tierMethod(highRise));
  assert.equal(method.querySelector('a').dataset.help, 'deal-tiers');

  const fv = highRise.flashcardValuation;
  const returns = {...highRise, flashcardValuation: {...fv, dealVerdict: 'fair_deal', gates: [{id: 'returns', severity: 'restrict', label: 'Returns short of the price tier', detail: ''}]}};
  assert.equal(tierBasis(returns), '$115/BSF against land worth up to $230/BSF at your costs. Priced Great, held at Fair: Returns short of the price tier.');
  const checked = {...highRise, flashcardValuation: {...fv, dealVerdict: 'full_price', gates: [{id: 'data_large_lot', severity: 'restrict', label: 'Very large lot', detail: ''}, {id: 'returns', severity: 'restrict', label: 'Returns', detail: ''}]}};
  assert.equal(tierBasis(checked), '$115/BSF against land worth up to $230/BSF at your costs. Priced Great, held at Full price: Very large lot, Returns.');
  assert.match(tierBasis({...highRise, listPrice: null, pricePerBuildableSf: null, flashcardValuation: {...fv, dealVerdict: 'unpriced_opportunity', priceVerdict: 'unpriced_opportunity'}}), /^No ask yet\. The land is worth up to \$230\/BSF at your costs\.$/);
  assert.equal(tierBasis({...highRise, flashcardValuation: {...fv, dealVerdict: 'unmatched_parcel'}}), null);

  // With five or more nearby development-site sales the tier is the ask against what they sold for, and the
  // returns are a note beside it, never a hold.
  const nearbyLand = {perBuildableSqft: 203, sales: 15, radiusMiles: 0.53, months: 24, value: 2_366_980, asOf: '2026-06-24'};
  const dealTierBasis = {basis: 'nearby', askToNearby: 0.824, thresholds: {great_deal: 0.7, good_deal: 0.85, fair_deal: 1}};
  const near = {...highRise, deal_verdict: 'good_deal', flashcardValuation: {...fv, dealVerdict: 'good_deal', priceVerdict: 'good_deal', nearbyLand, dealTierBasis, gates: [{id: 'returns', severity: 'review', label: 'Returns short of the price tier', detail: ''}]}};
  assert.equal(tierBasis(near), 'The ask is 82% of the $2.37M land value from nearby sales.');
  assert.equal(tierMethod(near), "15 development-site sales within 0.53 miles over the last 24 months, adjusted to this lot's size, zoning and existing building, put its land at about $2.37M. An ask at 70% of that or less is a Great deal, up to 85% Good, up to 100% Fair, and above it Full price. Tenants, flood risk and other checks can hold a tier lower.");
  const capped = {...near, flashcardValuation: {...near.flashcardValuation, priceVerdict: 'great_deal', dealTierBasis: {...dealTierBasis, askToNearby: 0.6}, gates: [{id: 'infeasible', severity: 'review', label: "Doesn't pencil at target returns", detail: ''}, {id: 'returns', severity: 'review', label: 'Returns short of the price tier', detail: ''}]}};
  assert.equal(tierBasis(capped), "The ask is 60% of the $2.37M land value from nearby sales. Priced Great, held at Good: Doesn't pencil at target returns.");
  const {tierHold, dealScale} = await import('../public/deal-card.js');
  assert.equal(tierHold(normalizeForHold(capped)), "Priced Great, held at Good: Doesn't pencil at target returns", 'the returns note never holds a nearby tier');
  const scale = dealScale(normalizeForHold(near));
  assert.match(scale.getAttribute('aria-label'), /^Ask \$\d[\d.,M]*, rated Good Deal, on a scale with great at \$1\.66M or less and full price above \$2\.37M, the land value from nearby sales adjusted to this lot\.$/);
  assert.deepEqual([...scale.querySelectorAll('.deal-scale-labels span')].map(s => s.textContent), ['Great ≤ $1.66M', 'Full price > $2.37M']);
});

test('the listing page splits the unit count into the zoning cap and the planned units', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector} = await import('../public/listing-inspector.js');
  const view = renderInspector(highRise, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  const figures = view.querySelector('.inspector-figures').textContent;
  assert.match(figures, /Most units allowed76Zoning cap, one per 680 SF of floor area/);
  assert.match(figures, /Planned units49Uses ZIP 11249 condos, median 910 SF \(48 listings\); 15% of floor area to halls, lobby and core/);
  assert.match(figures, /\$122,449 per planned unit/);
  assert.doesNotMatch(view.textContent, /Screening unit estimate|ZFA\/unit assumption/);
  const barred = renderInspector({...highRise, maxBuildableUnits: null, plannedUnits: null, plannedUnitBasis: null}, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  assert.doesNotMatch(barred.textContent, /Most units allowed|Planned units/);
});

test('each cost says where it comes from, and Set your costs opens the Costs control', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector} = await import('../public/listing-inspector.js');
  let opened = 0;
  const view = renderInspector(highRise, {
    dealSettings: {...house, hardCostPerGrossSqft: 400, carryAndFinancingPct: 0.12},
    costBasis: {house, saved: {...house, hardCostPerGrossSqft: 400}},
    onSetCosts: () => { opened++; },
    canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {},
  });
  const section = [...view.querySelectorAll('section.inspector-section')].find(s => s.querySelector('h3')?.textContent === 'What sets the value');
  const text = section.textContent;
  assert.match(text, /Hard cost\$540\/GSF: \$400 your saved costs, \+25% high-rise, \+8% narrow lot/);
  assert.match(text, /Soft cost22% of hard cost, house default/);
  assert.match(text, /Carry and financing12% of cost, this search only/);
  assert.match(text, /Gross-up1\.15, assumed; house default/);
  assert.match(text, /85% sellable after halls, lobby and core/);
  const action = section.querySelector('button.inspector-costs-action');
  assert.equal(action.textContent, 'Set your costs');
  assert.equal(view.querySelectorAll('.inspector-costs-action').length, 1);
  action.click();
  assert.equal(opened, 1);

  const lowRise = renderInspector({...highRise, flashcardValuation: {...highRise.flashcardValuation, valueDriver: {...highRise.flashcardValuation.valueDriver, heightClass: 'low-rise', narrowLot: false, hardCostPerGrossSqft: 375, baseHardCostPerGrossSqft: 375, heightClassFactor: 1, narrowLotFactor: 1}}}, {dealSettings: house, costBasis: {house, saved: null}, canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  assert.match(lowRise.textContent, /Hard cost\$375\/GSF, house default for low-rise/);
  assert.equal(lowRise.querySelector('.inspector-costs-action'), null, 'no action without a Costs control to open');
});

test('a rental held to 99 units for 485-x names the option and the cap on the cards and the listing page', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector} = await import('../public/listing-inspector.js');
  const {listingCard} = await import('../public/listing-card.js');
  const {dealCard} = await import('../public/deal-card.js');
  const {unitEstimate, normalizeDealRow, valueDriverLabel} = await import('../public/deals.js');
  // A 200 by 100 ft R8A lot whose rents carry a rental only under 485-x, and best at 99 units.
  const v = computeDealValuation({listPrice: 30_000_000, lotArea: 20000, lotFront: 200, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 6.02, affResFar: 7.2, zoningDistrict: 'R8A', address: '9 Example Ave', borough: 'BK', zipCode: '11211', valuationDate: '2026-10-20', submarketSalePsf: 900, submarketRentPsf: 8, settings: {hardCostPerGrossSqft: 380}});
  const deal = {
    id: 'cap', address: '9 Example Ave', bbl: '3000010001', borough: 'BK', listPrice: 30_000_000, pricePerBuildableSf: v.pricePerBuildableSf,
    maxBuildableUnits: v.maxBuildableUnits, plannedUnits: v.plannedUnits, plannedUnitBasis: v.plannedUnitBasis,
    flashcardValuation: {dealVerdict: v.dealVerdict, priceVerdict: v.priceVerdict, gates: v.gates, valueDriver: v.valueDriver, basis: v.basis,
      slidingScalePricePerBsf: {greatDealMaxBsf: v.greatDealMaxBsf, goodDealMaxBsf: v.goodDealMaxBsf, badDealMinBsf: v.badDealMinBsf}},
  };
  assert.equal(valueDriverLabel(v.valueDriver), 'Rental on the standard envelope, 485-x Option B capped at 99 units');
  assert.equal(unitEstimate(normalizeDealRow(deal)).label, '99 planned units (capped at 99 for 485-x; most allowed 177)');
  const badge = listingCard(deal, {onOpen() {}}).querySelector('.listing-card-mih');
  assert.equal(badge.textContent, '485-x · 99 units');
  assert.match(badge.title, /^Priced as a rental under 485-x Option B, modest rental project: 20% of units at 80% AMI, a 35-year tax exemption, no construction wage floor, held to 99 units \(the envelope holds 175\)\.$/);
  assert.match(dealCard(deal).textContent, /Value set byRental on the standard envelope, 485-x Option B capped at 99 units/);

  const view = renderInspector(deal, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  assert.ok([...view.querySelectorAll('.inspector-pill')].some(p => p.textContent === '485-x · 99 units'));
  const section = [...view.querySelectorAll('section.inspector-section')].find(s => s.querySelector('h3')?.textContent === 'What sets the value');
  assert.match(section.textContent, /Real estate taxes485-x Option B, modest rental project \(RPTL 485-x § 1\(b\), \(ee\), \(qq\)\): 20% of units at 80% AMI on average; 100% exempt in years 1 to 25, 20% exempt in years 26 to 35; no construction wage floor under 100 units/);
  assert.match(section.textContent, /Unit capHeld to 99 units for 485-x Option B, from the 175 the full envelope holds\. The land is worth \$[\d.]+M this way, against the best building without the cap, which falls \$[\d.]+M short of its costs\./);
  // The priced floor area is the capped 99-unit building's, not the full envelope's.
  assert.match(section.textContent, /Priced on[\d,]+ SF in the 99-unit building/);
  assert.doesNotMatch(section.textContent, /Priced on[\d,]+ SF the envelope holds/);
  assert.match(view.textContent, /485-x tax exemption/);
  assert.doesNotMatch(view.textContent, /\u2014/);
});

// A served listing with an existing building on a lot whose affordable envelope is larger than the standard
// one that sets the value.
function servedLot({bldgArea, listPrice}) {
  const store = new MarketStore(':memory:');
  try {
    store.db.prepare(`INSERT INTO market_listings (id, listing_type, address, zip_code, borough, bbl, list_price, pluto_lot_area,
      pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, flood_zone,
      units_res, year_built, first_seen_at, last_seen_at)
      VALUES ('b', 'for_sale', '4 Example Ave', '11216', 'BK', '3000010002', ?, 5000, 50, 100, '5', ?, 4, 5.01, 'R7A', 0, 0, 2020, 1, 1)`).run(listPrice, bldgArea);
    return store.searchDeals({listingId: 'b', minUnusedZfa: 0})[0];
  } finally {
    store.close();
  }
}

test('cards and the inspector quote the headroom the rating was judged on, not the bonus envelope\'s', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector} = await import('../public/listing-inspector.js');
  const {dealCard} = await import('../public/deal-card.js');
  const {headroomSqft} = await import('../public/core-model.js');
  const {normalizeDealRow} = await import('../public/deals.js');

  const deal = servedLot({bldgArea: 19_200, listPrice: 400_000});
  assert.equal(deal.flashcardValuation.valueDriver.program, 'standard');
  assert.equal(deal.unusedForLeadZfa, deal.buildableZfa - 19_200);
  assert.equal(deal.unusedForLeadZfa, 800);
  assert.ok(deal.unusedUapZfa > deal.unusedForLeadZfa);
  // 800 SF clears the 500 SF Good condition but not the 1,000 SF Great one: the same figure every view shows.
  assert.equal(deal.flashcardValuation.priceVerdict, 'good_deal');
  assert.equal(headroomSqft(normalizeDealRow(deal)), 800);

  const card = dealCard(deal, {onUnderwrite() {}});
  const headroom = [...card.querySelectorAll('.deal-figure')].find(f => f.querySelector('dt').textContent === 'Headroom');
  assert.match(headroom.textContent, /\+0\.16 FAR800 SF unused/);
  const view = renderInspector(deal, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  const figure = [...view.querySelectorAll('.deal-figure')].find(f => f.querySelector('dt').textContent === 'Headroom');
  assert.match(figure.textContent, /800 SF unused/);
  assert.match(view.textContent, /Unused floor area800 SF/);
  assert.doesNotMatch(view.textContent, new RegExp(`${deal.unusedUapZfa.toLocaleString('en-US')} SF`));
});

test('completed value is stated on the exit that sets the value, and the rental and condo figures differ', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector} = await import('../public/listing-inspector.js');
  const {normalizeDealRow, fmtCurrency} = await import('../public/deals.js');
  const v = computeDealValuation({listPrice: 2_000_000, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 4, affResFar: 5.01, zoningDistrict: 'R7A', borough: 'BK', zipCode: '11249', submarketSalePsf: 500, submarketRentPsf: 6});
  assert.equal(v.valueDriver.exit, 'rental');
  const fv = {dealVerdict: v.dealVerdict, priceVerdict: v.priceVerdict, gates: v.gates, valueDriver: v.valueDriver, estimatedRedevValue: v.estimatedRedevValue, estimatedStabilizedValue: v.estimatedStabilizedValue, estimatedCondoSellout: v.estimatedCondoSellout, completedValueExit: v.completedValueExit};
  const row = normalizeDealRow({id: 'r', address: '6 Example Ave', listPrice: 2_000_000, flashcardValuation: fv});
  assert.equal(row.estimated_stabilized_value, v.estimatedRedevValue);
  assert.equal(row.estimated_condo_sellout, v.estimatedCondoSellout);
  assert.notEqual(row.estimated_stabilized_value, row.estimated_condo_sellout);
  const view = renderInspector({id: 'r', address: '6 Example Ave', listPrice: 2_000_000, flashcardValuation: fv}, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}});
  assert.ok(view.textContent.includes(`Completed value${fmtCurrency(v.estimatedStabilizedValue)}, as a rental at the good-deal yield`));
  assert.notEqual(fmtCurrency(v.estimatedStabilizedValue), fmtCurrency(v.estimatedCondoSellout));
});

test('the envelope row says when its area is estimated and drops it when no envelope was drawn', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {renderInspector} = await import('../public/listing-inspector.js');
  const at = envelopeBasis => renderInspector({...highRise, maxUapZfa: 60_000, achievableUapZfa: 52_000, flashcardValuation: {...highRise.flashcardValuation, envelopeBasis}}, {canStart: () => true, onUnderwrite() {}, onAsk() {}, onClose() {}}).textContent;
  assert.match(at('curated-envelope'), /Fits the envelope52,000 SF(?!,)/);
  assert.match(at('fallback-geometry'), /Fits the envelope52,000 SF, estimated: this district's bulk rules are not on file/);
  assert.doesNotMatch(at('paper-only'), /Fits the envelope/);
});

test('a rating held down by a check never blames headroom, and headroom is the lead building\'s unused area', async () => {
  const {document, window} = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.document = document;
  globalThis.window = window;
  const {dealScale, tierHold} = await import('../public/deal-card.js');
  const {normalizeDealRow} = await import('../public/deals.js');
  const row = (id, valuation, extra) => normalizeDealRow({id, address: `${id} Test Street`, zoningDistrict: 'R6A', lotAreaSqft: 2500,
    maxUapZfa: 10000, unusedUapZfa: 7500, listPrice: 2_400_000, uapPricePerBuildableZfa: 120, ...extra,
    flashcardValuation: {slidingScalePricePerBsf: {greatDealMaxBsf: 150, goodDealMaxBsf: 250, badDealMinBsf: 350, goodDealMaxLandValue: 2_500_000}, ...valuation}});
  // Landmarked: the price earns Great, the check holds it at Fair, and 20,000 SF is unused.
  const landmark = row('5', {priceVerdict: 'great_deal', dealVerdict: 'fair_deal', gates: [{id: 'landmark', severity: 'restrict', label: 'Landmark or historic district', detail: ''}]}, {unusedUapZfa: 25000, unusedForLeadZfa: 20000});
  // Headroom alone: the lead building has 600 SF unused while the bonus envelope has 7,500.
  const thin = row('6', {priceVerdict: 'fair_deal', dealVerdict: 'fair_deal', gates: []}, {unusedForLeadZfa: 600});
  const held = dealScale(landmark);
  assert.equal(held.querySelector('.deal-scale-note'), null);
  assert.doesNotMatch(held.getAttribute('aria-label'), /unused/);
  assert.match(held.getAttribute('aria-label'), /rated Fair Deal.*Priced Great, held at Fair: Landmark or historic district\.$/);
  assert.match(tierHold(landmark), /^Priced Great, held at Fair: Landmark/);
  assert.doesNotMatch(dealScale(thin).getAttribute('aria-label'), /Priced|held at/);
  assert.equal(tierHold(thin), null);
  assert.match(dealScale(thin).querySelector('.deal-scale-note').textContent, /Great range.*rated Fair Deal because only 600 SF of buildable area is unused/);
});
