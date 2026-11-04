import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  detectJurisdiction,
  coverageFor,
  NYC_JURISDICTION,
  inferQueryJurisdiction,
  inferUrlJurisdiction,
  resolveSearchJurisdiction,
  isAuthoritativeSourceUrl,
  scoreSourceAuthority,
  runInNyc,
} from './jurisdiction.mjs';
import {jurisdictionScope} from './knowledge.mjs';
import {createParcelOperations} from './parcels.mjs';

test('NYC is detected from boroughs, city phrases and BBLs', () => {
  for (const text of ['120 Broadway, Manhattan', '500 Main Street, Brooklyn', 'an address in New York City', 'site in NYC', '120 Broadway, New York, NY']) {
    const found = detectJurisdiction(text);
    assert.equal(found?.jurisdiction, NYC_JURISDICTION, text);
    assert.equal(found?.tier, 'deep', text);
  }
  assert.equal(detectJurisdiction('the parcel', {bbl: '1000477501'})?.jurisdiction, NYC_JURISDICTION);
});

test('other US cities are detected from an explicit city and state', () => {
  const cases = [
    ['500 Main Street, Austin, TX', 'US-TX-AUSTIN', 'Austin', 'TX'],
    ['a site in Los Angeles, California', 'US-CA-LOSANGELES', 'Los Angeles', 'CA'],
    ['77 Wacker Drive, Chicago, IL 60601', 'US-IL-CHICAGO', 'Chicago', 'IL'],
    ['1 Main Street, Buffalo, New York', 'US-NY-BUFFALO', 'Buffalo', 'NY'],
    ['2 College Street, Manhattan, KS', 'US-KS-MANHATTAN', 'Manhattan', 'KS'],
  ];
  for (const [text, jurisdiction, city, state] of cases) {
    const found = detectJurisdiction(text);
    assert.equal(found?.jurisdiction, jurisdiction, text);
    assert.equal(found?.city, city, text);
    assert.equal(found?.state, state, text);
    assert.equal(found?.tier, 'research', text);
    assert.deepEqual(jurisdictionScope(jurisdiction), ['US', `US-${state}`, jurisdiction], text);
  }
});

test('ambiguous input stays undetected so the agent clarifies instead of guessing', () => {
  for (const text of ['120 Broadway', 'a lot in Portland', '500 Main Street, Austin, ZZ', 'what could I build here?', '']) {
    assert.equal(detectJurisdiction(text), null, text);
  }
  assert.equal(detectJurisdiction(null), null);
  assert.equal(detectJurisdiction(42), null);
});

test('coverage tiers name what each tier can and cannot do', () => {
  const deep = coverageFor(NYC_JURISDICTION);
  assert.equal(deep.tier, 'deep');
  assert.ok(deep.capabilities.some(line => /PLUTO/i.test(line)));
  const research = coverageFor('US-TX-AUSTIN');
  assert.equal(research.tier, 'research');
  assert.ok(research.gaps.some(line => /parcel/i.test(line)));
  assert.ok(research.gaps.some(line => /envelope/i.test(line)));
  assert.equal(coverageFor(null), null);
});

test('a clearly non-NYC address never reaches the NYC parcel providers', async () => {
  let calls = 0;
  const {findProperty} = createParcelOperations({
    request: async () => { calls++; throw new Error('NYC provider must not be called'); },
    record: () => null,
    onParcel: () => { throw new Error('no parcel may be recorded'); },
  });
  const result = await findProperty({address: '500 Main Street, Austin, TX'});
  assert.equal(calls, 0);
  assert.equal(result.confirmed, false);
  assert.deepEqual(result.rows, []);
  assert.equal(result.jurisdiction.jurisdiction, 'US-TX-AUSTIN');
  assert.equal(result.coverage.tier, 'research');
  assert.match(result.note, /outside.*deep|research.tier/i);
});

test('the research host installer ships the jurisdiction module parcels import', () => {
  const installer = readFileSync(new URL('../infra/acres-deploy-research', import.meta.url), 'utf8');
  assert.match(installer, /\bjurisdiction\.mjs\b/);
  assert.match(installer, /\bparcels\.mjs\b/);
});

test('NYC lookups still resolve through the parcel providers', async () => {
  let calls = 0;
  const {findProperty, sameBlock} = createParcelOperations({
    request: async url => {
      calls++;
      if (url?.searchParams?.has('$where')) {
        return [
          {bbl: '1000470010', borough: 'MN', block: 47, lot: 10, address: '110 BROADWAY', zonedist1: 'C5-5', lotarea: 10000, bldgarea: 80000, builtfar: 8, residfar: 10, commfar: 15, facilfar: 15},
          {bbl: '1000477502', borough: 'MN', block: 47, lot: 7502, address: '122 BROADWAY', zonedist1: 'C5-5', lotarea: 5000, bldgarea: 40000, builtfar: 8, residfar: 10, commfar: 15, facilfar: 15},
        ];
      }
      return [{bbl: '1000477501', borough: 'MN', block: 47, lot: 7501, address: '120 BROADWAY', bldgclass: 'R4', lotarea: 50000, bldgarea: 100000, builtfar: 2, residfar: 10, affresfar: 12, commfar: 15, facilfar: 15, lotfront: 200, lotdepth: 250, firm07_flag: '1'}];
    },
    record: () => ({id: 1}),
    onParcel: () => {},
  });
  const result = await findProperty({bbl: '1000477501'});
  assert.equal(calls, 1);
  assert.equal(result.confirmed, true);
  assert.equal(result.rows[0].bbl, '1000477501');
  assert.equal(result.parcelDiagnostics.isCondoBillingLot, true);
  assert.match(result.parcelDiagnostics.condoAdvisory, /Condominium Billing Lot/);
  assert.equal(result.parcelDiagnostics.floodZoneCheck.inMappedFloodZone, true);
  assert.equal(result.parcelDiagnostics.bulkComplianceAndZfaBands.estimatedDobZfaBands.at90PctOfPlutoGfa, 90000);

  const blockNeighbors = await sameBlock({bbl: '1000477501', borough: 'MN', block: 47, lot: 7501});
  assert.equal(blockNeighbors.adjacentBlockLots.length, 2);
  assert.equal(blockNeighbors.adjacentBlockLots[0].lot, 7502, 'closest lot number on block should sort first');
  assert.equal(blockNeighbors.adjacentBlockLots[0].estimatedUnusedStandardZfa, 35000);
});

test('search jurisdiction inference resolves nationwide queries, URLs and natural city names without defaulting to NYC', () => {
  assert.equal(inferQueryJurisdiction('West Palm Beach short term rental rules'), 'US-FL-WESTPALMBEACH');
  assert.equal(inferQueryJurisdiction('Miami T6-8 zoning setbacks'), 'US-FL-MIAMI');
  assert.equal(inferQueryJurisdiction('Cambridge MA inclusionary zoning'), 'US-MA-CAMBRIDGE');
  assert.equal(inferQueryJurisdiction('Florida vacation rental statute'), 'US-FL');
  assert.equal(inferQueryJurisdiction('UAP bonus under ZR 23-22'), 'US-NY-NYC');

  assert.equal(inferUrlJurisdiction('https://www.wpb.org/government/development-services'), 'US-FL-WESTPALMBEACH');
  assert.equal(inferUrlJurisdiction('https://library.municode.com/fl/west_palm_beach/codes/code_of_ordinances'), 'US-FL-WESTPALMBEACH');
  assert.equal(inferUrlJurisdiction('https://www.miami.gov/Permits-Construction/Zoning'), 'US-FL-MIAMI');
  assert.equal(inferUrlJurisdiction('https://up.codes/viewer/california/ca-building-code-2022'), 'US-CA');

  assert.equal(resolveSearchJurisdiction({query: 'West Palm Beach short term rental rules'}), 'US-FL-WESTPALMBEACH');
  assert.equal(resolveSearchJurisdiction({city: 'Miami, FL', query: 'zoning'}), 'US-FL-MIAMI');

  for (const url of [
    'https://www.nyc.gov/site/planning/index.page',
    'https://library.municode.com/fl/miami/codes/code_of_ordinances',
    'https://codelibrary.amlegal.com/codes/los_angeles/latest/overview',
    'https://ecode360.com/YO1234',
    'https://up.codes/viewer/new_york/nyc-building-code-2022',
    'https://www.wpb.org/government/zoning',
    'https://planning.lacity.org/zoning',
  ]) {
    assert.equal(isAuthoritativeSourceUrl(url), true, url);
    assert.ok(scoreSourceAuthority(url) >= 0.85, url);
  }
  assert.equal(isAuthoritativeSourceUrl('https://blog.example.com/zoning'), false);
  assert.equal(isAuthoritativeSourceUrl('http://www.nyc.gov/zoning'), false);
});



test('runInNyc reads the latest named place, then the subject BBL, then earlier user turns',()=>{
  assert.equal(runInNyc({message:'What can be built at 100 Main Street, Austin, TX?'}),false,'a named city elsewhere is not NYC');
  assert.equal(runInNyc({message:'Miami zoning for a mid-rise'}),false,'a known city named without a state is not NYC');
  assert.equal(runInNyc({message:'What can be built at 250 West 57th Street, New York, NY?'}),true);
  assert.equal(runInNyc({message:'How much more can this lot build?',propertyBbl:'1010297501'}),true,'a confirmed BBL is an NYC subject');
  assert.equal(runInNyc({message:'Compare this with Austin, TX rules.',propertyBbl:'1010297501'}),false,'a place named in the latest question wins over the subject');
  assert.equal(runInNyc({message:'And the parking requirement?',history:[{role:'user',text:'Zoning for 12 Oak Street, Boston, MA'},{role:'assistant',text:'The lot sits in a residential district.'}]}),false,'a follow-up keeps the place named earlier');
  assert.equal(runInNyc({message:'What is floor area ratio?'}),true,'with no place at all, the deep-coverage city is assumed');
});
