// Explicit operator configuration for this isolated test deployment.
process.env.AROSA_ADMIN_EMAILS='michael@witharosa.ai,alex@witharosa.ai,chaim@witharosa.ai';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {computeDealValuation, MarketStore, DEFAULT_NYC_DEV_SETTINGS} from './market-store.mjs';
import {buildSchemes, SCHEME_IDS} from './schemes.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {priceFixture} from './testing/comparable-price.mjs';

// Lots across densities, lot shapes and boroughs; none is tuned to a known answer.
const lots = {
  narrowR6: {listPrice: 1_400_000, lotArea: 2000, lotFront: 20, lotDepth: 100, lotTypeCode: '5', bldgArea: 1600, residFar: 2.2, affResFar: 3.9, zoningDistrict: 'R6', address: '10 EXAMPLE PLACE', borough: 'BK', zipCode: '11221'},
  wideR7: {listPrice: 6_000_000, lotArea: 10000, lotFront: 100, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 3.44, affResFar: 5.01, zoningDistrict: 'R7-1', address: '20 EXAMPLE AVENUE', borough: 'QN', zipCode: '11373', frontStreetFeet: 80},
  lowR3: {listPrice: 700_000, lotArea: 4000, lotFront: 40, lotDepth: 100, lotTypeCode: '5', bldgArea: 1200, residFar: 0.5, affResFar: 0.6, zoningDistrict: 'R3-2', address: '30 EXAMPLE ROAD', borough: 'SI', zipCode: '10314'},
  overlay: {listPrice: 3_500_000, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 2500, residFar: 3.0, affResFar: 3.9, commFar: 2.0, overlay1: 'C2-4', zoningDistrict: 'R6A', address: '40 EXAMPLE AVENUE', borough: 'BX', zipCode: '10458'},
  barred: {listPrice: 2_000_000, lotArea: 5000, lotFront: 50, lotDepth: 100, lotTypeCode: '5', bldgArea: 0, residFar: 0, commFar: 1, mnfFar: 1, zoningDistrict: 'M1-1', address: '50 EXAMPLE STREET', borough: 'BK', zipCode: '11222'},
};
// Nothing pencils when it costs far more to build than the finished building is worth.
const costly = {...DEFAULT_NYC_DEV_SETTINGS, rentalHardCostPerGrossSqft: 2500, condoHardCostPerGrossSqft: 2500};

const value = (lot, settings) => computeDealValuation({...lot, settings, withCandidates: true});
const bonus = s => s.program.key !== 'mih_exempt' && (s.program.key === 'uap' || s.program.taxProgram !== null);

test('the deal list never carries candidates; the schemes path asks for them, most land first', () => {
  assert.equal('candidates' in computeDealValuation(lots.wideR7), false);
  const v = value(lots.wideR7);
  assert.ok(v.candidates.length >= 3);
  const lands = v.candidates.map(c => c.returns.landValue);
  assert.deepEqual(lands, [...lands].sort((a, b) => b - a));
  assert.equal(new Set(v.candidates.map(c => c.id)).size, v.candidates.length);
  assert.deepEqual(v.candidates.filter(c => c.leads).length, 1);
  for (const c of v.candidates) {
    assert.equal(c.unitMix.reduce((sum, u) => sum + u.units, 0), c.units);
    assert.ok(c.grossSqft > c.zfa);
    assert.equal(c.returns.profit, c.returns.completedValue + c.returns.publicFunding - c.returns.totalCost);
    assert.equal(c.returns.landBasis, 'ask');
    assert.ok(c.exit === 'rental' ? c.returns.yieldOnCost > 0 && c.returns.condoMargin === null : c.returns.yieldOnCost === null);
  }
});

for (const [name, lot] of Object.entries(lots).filter(([name]) => name !== 'barred')) {
  test(`${name}: three schemes in order, the best is the deal card's winner, each kind as defined`, () => {
    const v = value(lot);
    const schemes = buildSchemes({candidates: v.candidates});
    assert.deepEqual(schemes.map(s => s.id), SCHEME_IDS);
    const best = schemes.filter(s => s.best);
    assert.equal(best.length, 1);
    assert.equal(best[0].program.key, v.valueDriver.program);
    assert.equal(best[0].program.exit, v.valueDriver.exit);
    assert.equal(best[0].program.zfa, v.valueDriver.buildableZfa);
    assert.equal(best[0].returns.landValue, v.valueDriver.landValue);
    if (v.valueDriver.exit === 'rental') assert.equal(best[0].returns.yieldOnCost, v.impliedYieldOnCost);
    else assert.equal(best[0].returns.condoMargin, v.impliedCondoMargin);
    const [asOfRight, maxBonus, alternative] = schemes;
    assert.ok(asOfRight.program ? !bonus(asOfRight) : asOfRight.note);
    assert.ok(maxBonus.program ? bonus(maxBonus) : maxBonus.note);
    const firstTwo = [asOfRight, maxBonus].filter(s => s.program);
    if (alternative.program) assert.ok(alternative.note || firstTwo.every(s => s.program.exit !== alternative.program.exit || s.program.key !== alternative.program.key || (s.program.taxProgram?.kind === 'city-financed') !== (alternative.program.taxProgram?.kind === 'city-financed')));
    const drawn = schemes.filter(s => s.program);
    assert.equal(new Set(drawn.map(s => s.candidateId)).size, drawn.length);
    // The alternative is drawn whenever a building is left after the first two.
    assert.equal(Boolean(alternative.program), v.candidates.length > firstTwo.length);
    for (const s of schemes) {
      assert.doesNotMatch(s.summary, /\buap\b|zfa|mih_|_/);
      assert.deepEqual([s.massing, s.plan, s.budget, s.render], [null, null, null, null]);
    }
  });
}

test('affordable units are listed as rentals at the rental sizes, on a condo exit too', () => {
  const v = value(lots.wideR7);
  const withAffordable = v.candidates.filter(c => c.affordableZfa > 0);
  assert.ok(withAffordable.some(c => c.exit === 'condo') && withAffordable.some(c => c.exit === 'rental'));
  for (const c of withAffordable) {
    const affordable = c.unitMix.filter(u => u.affordable);
    assert.ok(affordable.length > 0);
    assert.ok(affordable.every(u => ['studio', 'oneBedroom', 'twoBedroom'].includes(u.type)), 'the rental mix');
    assert.equal(c.unitMix.reduce((sum, u) => sum + u.units, 0), c.units);
    const share = affordable.reduce((sum, u) => sum + u.units, 0) / c.units;
    if (c.exit === 'rental') assert.ok(Math.abs(share - c.affordableZfa / c.zfa) <= 1 / c.units);
  }
  assert.ok(v.candidates.filter(c => !c.affordableZfa).every(c => c.unitMix.every(u => !u.affordable)));
});

test('a lot where nothing pencils still shows its three buildings, each paying nothing for the land', () => {
  const v = value(lots.wideR7, costly);
  assert.equal(v.infeasibleAtTarget, true);
  const schemes = buildSchemes({candidates: v.candidates});
  assert.equal(schemes.filter(s => s.best).length, 1);
  assert.ok(schemes.every(s => s.returns.landValue < 0));
  // Losing less is not paying more: no option says why it pays the most for the land.
  assert.ok(schemes.some(s => s.program.affordableZfa > 0));
  assert.ok(schemes.every(s => s.reason === null));
});

test('a lot that allows no residential building has three empty schemes', () => {
  const schemes = buildSchemes({candidates: value(lots.barred).candidates});
  assert.deepEqual(schemes.map(s => [s.id, s.program, s.best]), SCHEME_IDS.map(id => [id, null, false]));
});

test('drawn parts stay with a scheme while it is the same building, and modeled concepts link by size', () => {
  const {candidates} = value(lots.wideR7);
  const first = buildSchemes({candidates});
  const drawn = first.map(s => ({...s, plan: {planId: `p-${s.id}`, revision: 2}, budget: {lines: [], total: 1, basis: 'x'}, render: {artifactId: 'a', status: 'succeeded', url: '/x'}}));
  assert.deepEqual(buildSchemes({candidates, prior: drawn}).map(s => s.plan?.planId), first.map(s => `p-${s.id}`));
  const resized = candidates.map(c => ({...c, zfa: c.zfa + 500}));
  assert.deepEqual(buildSchemes({candidates: resized, prior: drawn}).map(s => [s.plan, s.budget, s.render]), first.map(() => [null, null, null]));
  const target = first[0].program;
  const concepts = [
    {id: 'near', metrics: {grossFloorAreaSqft: target.zfa * 1.05, storeys: target.storeys}},
    {id: 'far', metrics: {grossFloorAreaSqft: target.zfa * 3, storeys: target.storeys + 6}},
  ];
  const linked = buildSchemes({candidates, concepts});
  assert.deepEqual(linked[0].massing, {conceptId: 'near', source: 'concept'});
  assert.ok(linked.slice(1).every(s => s.massing?.conceptId !== 'near'));
  assert.ok(linked.every(s => s.massing?.conceptId !== 'far'));
});

const alice = 'a'.repeat(24);
async function serve(t) {
  const cleanup = [], f = priceFixture({after: fn => cleanup.push(fn)});
  const chat = new ChatStore(join(f.dir, 'chat.sqlite'));
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'fixture'}, store: chat, maps: null, marketStoreFactory: () => new MarketStore(f.path)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); chat.close(); cleanup.forEach(fn => fn()); });
  const get = async path => (await fetch(`http://127.0.0.1:${server.address().port}${path}`, {headers: {authorization: 'Bearer fixture', 'x-acres-account': alice, 'x-acres-email': 'alex@witharosa.ai'}})).json();
  const site = property => {
    const {projectId} = chat.createConversation(alice);
    chat.project.write(projectId, {property: {value: property, provenance: {tool: 'acres_set_subject', sources: []}}});
    return projectId;
  };
  return {f, chat, get, site};
}

test('the schemes route prices a listed lot like its deal card, follows your land price and keeps drawn parts', async t => {
  const {f, chat, get, site} = await serve(t);
  const listing = f.subject();
  const projectId = site({bbl: listing.bbl, address: listing.address, zipcode: '11201', borough: 'BK'});
  const card = (await get(`/market-store/deals/${encodeURIComponent(f.subjectId)}?minUnusedZfa=0`)).deal.flashcardValuation;
  const view = await get(`/projects/${projectId}/schemes`);
  assert.deepEqual(view.schemes.map(s => s.id), SCHEME_IDS);
  assert.equal(card.subsidizedRental, null, 'no nearby sales to appraise the land, so no city-financed building');
  assert.equal(card.nearbyLand, null, 'and no nearby land value on the card');
  assert.equal('marketLand' in card, false, 'one nearby land figure on the card');
  assert.deepEqual(view.basis, {source: 'listing', listingId: f.subjectId, ask: 3_000_000, askFrom: 'listing', dealVerdict: card.dealVerdict, priceVerdict: card.priceVerdict,
    dealTierBasis: card.dealTierBasis, gates: card.gates.map(g => ({id: g.id, severity: g.severity, label: g.label})), infeasible: false,
    nearbyLand: null, subsidized: null});
  assert.equal(view.basis.dealTierBasis.basis, 'residual', 'without nearby sales the tier rests on the residual');
  const best = view.schemes.find(s => s.best);
  assert.deepEqual([best.program.key, best.program.exit, best.returns.landValue], [card.valueDriver.program, card.valueDriver.exit, card.valueDriver.landValue]);

  const version = chat.projectView(alice, projectId).version;
  assert.equal((await get(`/projects/${projectId}/schemes`)).version, version, 'an unchanged recompute saves nothing');
  const drawn = chat.setSchemePart(projectId, 'max_bonus', 'plan', {planId: 'plan-1', revision: 1});
  assert.deepEqual(drawn.schemes[1].plan, {planId: 'plan-1', revision: 1});
  assert.equal(drawn.version, version + 1);
  assert.throws(() => chat.setSchemePart(projectId, 'tallest', 'plan', {}), e => e.status === 400);
  assert.throws(() => chat.setSchemePart(projectId, 'max_bonus', 'returns', {}), e => e.status === 400);

  chat.updateProjectState(alice, projectId, {version: drawn.version, fields: {assumptions: {landPrice: 1_000_000}}});
  assert.equal(chat.schemesView(projectId).stale, 'assumptions');
  chat.setSchemePart(projectId, 'as_of_right', 'budget', {lines: [], total: 0, basis: 'fixture'});
  assert.equal(chat.schemesView(projectId).stale, 'assumptions', 'writing a part leaves the field stale');
  const repriced = await get(`/projects/${projectId}/schemes`);
  assert.equal(repriced.stale, null);
  assert.deepEqual([repriced.basis.ask, repriced.basis.askFrom], [1_000_000, 'assumptions']);
  assert.deepEqual(repriced.schemes[1].plan, {planId: 'plan-1', revision: 1});
});

test('a lot no listing covers is priced from its parcel record, and a site without a parcel has no schemes', async t => {
  const {chat, get, site} = await serve(t);
  const parcel = {bbl: '4012340001', address: '20 EXAMPLE AVENUE', borough: 'QN', zipcode: '11373', zonedist1: 'R7-1', lotarea: 10000, lotfront: 100, lotdepth: 100, lottype: '5', bldgarea: 0, residfar: 3.44, affresfar: 5.01, commfar: 0, facilfar: 4.8};
  const view = await get(`/projects/${site(parcel)}/schemes`);
  assert.deepEqual([view.basis.source, view.basis.ask], ['parcel', null]);
  assert.ok(view.schemes.every(s => s.returns.landBasis === 'land_value'));
  const {projectId} = chat.createConversation(alice);
  assert.deepEqual(await get(`/projects/${projectId}/schemes`), {projectId, version: 0, schemes: null, basis: null, stale: null, updated: null, sends: {canSend: true, sent: {}}});
});

test('the web app proxies a site\'s schemes', () => {
  const server = readFileSync(new URL('../app-starter/server.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/projects\/:id\/schemes',\(req,res\)=>proxy\(req,res,`\/projects\/\$\{encodeURIComponent\(req\.params\.id\)\}\/schemes`\)\);/);
});

// Candidates as the valuation lists them on a lot mapped for MIH, most land first.
const candidate = (key, exit, taxProgram = null, zfa = 50_000, storeys = 6, units = 60) => ({
  id: [key, exit, taxProgram?.kind ?? 'full'].join(':'), key, exit, zfa, storeys, units, unitMix: [], affordableZfa: 0, taxProgram, leads: false,
  returns: {landValue: 0},
});
const city = {kind: 'city-financed', amiPct: 60};

test('another MIH option on the same building is not an alternative: a different kind of building is chosen when one exists', () => {
  const exempt = {...candidate('mih_exempt', 'condo', null, 12_500, 2, 10), leads: true};
  const others = [candidate('option1', 'rental', city), candidate('option3', 'rental', city), candidate('option1', 'rental', {kind: '485-x', option: 'B'}), candidate('option3', 'condo')];
  const [asOfRight, maxBonus, alternative] = buildSchemes({candidates: [exempt, ...others]});
  assert.equal(asOfRight.candidateId, exempt.id);
  assert.equal(maxBonus.candidateId, 'option1:rental:city-financed');
  assert.equal(alternative.candidateId, 'option1:rental:485-x', 'the rental without city financing, not the same city-financed building under Option 3');
  assert.equal(alternative.note, null);
  const noMarketRental = buildSchemes({candidates: [exempt, ...others.filter(c => c.taxProgram?.kind !== '485-x')]});
  assert.equal(noMarketRental[2].candidateId, 'option3:condo:full');
});

test('when only variants of the first two are left the alternative says so, and a small exempt building says why', () => {
  const exempt = candidate('mih_exempt', 'condo', null, 12_500, 2, 10);
  const schemes = buildSchemes({candidates: [exempt, candidate('option1', 'rental', city), candidate('option3', 'rental', city)]});
  assert.equal(schemes[2].candidateId, 'option3:rental:city-financed');
  assert.equal(schemes[2].note, 'No other kind of building fits this lot, so this is the Most floor area building priced another way.');
  assert.equal(schemes[0].summary, 'Condo with the MIH small-project exemption, 12,500 SF, 2 storeys, 10 units');
  assert.match(schemes[0].note, /^Kept to 12,500 SF and 10 units to stay under the MIH threshold, so no affordable set-aside applies\./);
  assert.equal(buildSchemes({candidates: [candidate('standard', 'rental', null, 900, 1, 1)]})[0].summary, 'Rental, 900 SF, 1 storey, 1 unit');
});

test('on a large lot mapped for MIH the three schemes are three kinds of building, the exempt one under both thresholds', () => {
  const lot = {...lots.wideR7, lotArea: 12000, lotFront: 120, lotTypeCode: '3', residFar: 4, zoningDistrict: 'R7A', inMihArea: true,
    mihArea: {name: 'Example Rezoning', adopted: '2018-01-31', options: ['option1', 'option3']}};
  const [asOfRight, maxBonus, alternative] = buildSchemes({candidates: value(lot).candidates});
  const kinds = [asOfRight, maxBonus, alternative].filter(s => s.program).map(s => `${s.program.exit}:${/^option/.test(s.program.key) ? 'mih' : s.program.key}:${s.program.taxProgram?.kind === 'city-financed'}`);
  assert.equal(new Set(kinds).size, kinds.length, kinds.join(' / '));
  for (const s of [asOfRight, maxBonus, alternative].filter(s => s.program?.key === 'mih_exempt')) {
    assert.ok(s.program.zfa <= 12_500 && s.program.units <= 10 && s.program.storeys >= 2);
    assert.match(s.note, /stay under the MIH threshold/);
  }
});

test('a building with affordable floor area says its share, and the building to build says why in one sentence', () => {
  for (const lot of [lots.narrowR6, lots.wideR7, lots.overlay]) {
    const v = value(lot);
    const schemes = buildSchemes({candidates: v.candidates});
    for (const s of schemes.filter(s => s.program)) {
      const c = v.candidates.find(x => x.id === s.candidateId);
      if (c.affordableZfa > 0) assert.match(s.summary, new RegExp(`, ${Math.round(c.affordableZfa / c.zfa * 100)}% affordable${c.exit === 'condo' ? ' rentals' : ''} at ${c.affordableAmiPct}% AMI on average$`));
      else assert.doesNotMatch(s.summary, /affordable/);
    }
    assert.deepEqual(schemes.filter(s => s.reason).map(s => s.id), schemes.filter(s => s.best && s.reason).map(s => s.id));
  }
  // An R6 lot: the bonus area is all affordable, and the standard building pays more for the land.
  const [asOfRight, maxBonus] = buildSchemes({candidates: value(lots.narrowR6).candidates});
  assert.equal(maxBonus.program.affordableAmiPct, 60);
  assert.ok(asOfRight.best && asOfRight.returns.landValue > maxBonus.returns.landValue);
  const more = asOfRight.returns.landValue - maxBonus.returns.landValue;
  assert.equal(asOfRight.reason, `Most new buildings skip the bonus: here it adds ${(maxBonus.program.zfa - asOfRight.program.zfa).toLocaleString('en-US')} SF that must all be affordable at 60% AMI on average and earns less than it costs to build, so this building pays $${(more / 1e6).toFixed(2)}M more for the land than the Most floor area building.`);
  assert.match(maxBonus.summary, /^Condo with the affordability bonus, .*, 44% affordable rentals at 60% AMI on average$/);
});

test('most floor area is the largest bonus or tax-program building, even when a smaller one pays more', () => {
  const condo = {...candidate('standard', 'condo', null, 40_000, 6, 33), leads: true, returns: {landValue: 9_000_000}};
  const cityPlain = {...candidate('standard', 'rental', city, 40_000, 6, 50), affordableZfa: 40_000, affordableAmiPct: 54, returns: {landValue: 5_800_000}};
  const cityBonus = {...candidate('uap', 'rental', city, 48_000, 7, 60), affordableZfa: 48_000, affordableAmiPct: 54, returns: {landValue: 5_000_000}};
  const [, maxBonus, alternative] = buildSchemes({candidates: [condo, cityPlain, cityBonus]});
  assert.equal(maxBonus.candidateId, cityBonus.id);
  assert.equal(alternative.candidateId, cityPlain.id);
  const same = {...cityBonus, id: 'uap:rental:other', returns: {landValue: 4_000_000}};
  assert.equal(buildSchemes({candidates: [condo, cityBonus, same]})[1].candidateId, cityBonus.id, 'of two that build as much, the one that pays more');
  // The bonus is priced against the same city-financed rental without it, not against the condo.
  assert.equal(buildSchemes({candidates: [condo, cityPlain, cityBonus]})[0].reason, 'Most new buildings skip the bonus: the Most floor area building is the Alternative building with it, 8,000 SF larger and paying $800K less for the land. This building pays $4.00M more for the land than the Most floor area building.');
  assert.equal(buildSchemes({candidates: [condo, cityBonus]})[0].reason, 'Pays $4.00M more for the land than the Most floor area building.', 'no drawn building isolates the bonus');
});

test('the reason names an MIH set-aside as a share of the building, and a bonus that pays for itself as such', () => {
  const exempt = {...candidate('mih_exempt', 'condo', null, 12_500, 2, 10), leads: true, returns: {landValue: 900_000}};
  const option1 = {...candidate('option1', 'rental', {kind: '485-x', option: 'B'}), affordableZfa: 12_500, affordableAmiPct: 60, returns: {landValue: 400_000}};
  const [first] = buildSchemes({candidates: [exempt, option1]});
  assert.equal(first.reason, 'Pays $500K more for the land than the Most floor area building, where 25% of the floor area is affordable at 60% AMI on average and earns less than it costs to build.');
  const uap = {...candidate('uap', 'rental', null, 60_000, 8, 70), affordableZfa: 10_000, affordableAmiPct: 60, leads: true, returns: {landValue: 3_000_000}};
  const standard = {...candidate('standard', 'rental'), returns: {landValue: 2_000_000}};
  const schemes = buildSchemes({candidates: [uap, standard]});
  assert.equal(schemes.find(s => s.best).reason, 'The bonus pays for itself here: $1.00M more for the land than the As of right building, with 17% affordable at 60% AMI on average.');
  assert.equal(buildSchemes({candidates: [{...standard, leads: true}]})[0].reason, null);
  const cityLead = {...candidate('option1', 'rental', city, 60_000, 6, 75), affordableZfa: 60_000, affordableAmiPct: 54, leads: true, returns: {landValue: 8_000_000}};
  const small = {...candidate('mih_exempt', 'condo', null, 12_500, 2, 6), returns: {landValue: 1_000_000}};
  const cityReason = buildSchemes({candidates: [cityLead, small]}).find(s => s.best).reason;
  assert.equal(cityReason, 'City loans and tax credit equity cover the cost of making every unit affordable at 60% AMI on average, so this building pays $7.00M more for the land than the As of right building.');
  const mihLead = {...candidate('option1', 'condo', null, 60_000, 6, 60), affordableZfa: 15_000, affordableAmiPct: 60, leads: true, returns: {landValue: 3_000_000}};
  assert.equal(buildSchemes({candidates: [mihLead, small]}).find(s => s.best).reason, 'Pays $2.00M more for the land than the Alternative building, with 25% affordable rentals at 60% AMI on average.');
});
