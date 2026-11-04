// Writes public/demo/sites/<listing>.json: the site page state for each example listing, computed with the
// research service's own envelope, entitlement, unit mix, pro forma and decision code, and
// public/demo/calc.js: that pro forma and decision code bundled for the browser, so a visitor's own
// numbers re-run the same way. Run it after changing the example listings or that code:
// node site/demo-sites.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createZoningTools } from '../acres-research/zoning.mjs';
import { entitlementScenarios } from '../acres-research/entitlements.mjs';
import { recommendUnitMix } from '../acres-research/market.mjs';
import { computeProForma } from '../acres-research/proforma.mjs';
import { comparePrograms } from '../acres-research/feasibility.mjs';
import { DEALS } from './public/demo/listings-data.js';
import { decide } from './public/demo/numbers.js';

// esbuild is app-starter's, which already uses it to bundle the app's React views.
const { build } = createRequire(new URL('../app-starter/package.json', import.meta.url))('esbuild');

const T0 = Date.UTC(2026, 9, 23, 14, 0);
// Example rents per sq ft per month for new rentals by borough: studio, one, two, three bedrooms.
const RENTS = { MN: [7.1, 6.4, 5.9, 5.4], BK: [6.2, 5.6, 5.1, 4.7], QN: [5.4, 4.9, 4.5, 4.1], BX: [4.6, 4.2, 3.9, 3.6] };
const ASSUMPTIONS = {
  hardCostPerSqft: 450, softCostPerSqft: 99,
  financing: { loanToCost: 0.65, interestRate: 0.0725, termMonths: 30 },
  operating: { residentialVacancyRate: 0.05, residentialOpexPerUnitPerYear: 9000, commercialVacancyRate: 0.1, commercialOpexPerSqftPerYear: 12 },
  capRate: 0.0475, sellingCostRate: 0.05,
};
const TARGET = 0.12;
const source = (title, kind, url = null) => ({ title, url, kind, retrievedAt: '2026-10-23T13:58:00Z' });
const zr = (section) => source(`NYC Zoning Resolution ${section}`, 'zoning', `https://zr.planning.nyc.gov/article-ii/chapter-3#${section}`);
const pluto = source('NYC MapPLUTO 25v2', 'property', 'https://www.nyc.gov/content/planning/pages/resources/datasets/mappluto-pluto-change');
const field = (value, tool, sources = [], at = T0) => ({ value, provenance: { tool, run: 'run_example', sources }, stale: null, updated: at });

async function envelopeOf(property, affordable) {
  const tools = createZoningTools({ getProperty: () => property });
  await tools.handlers.acres_zoning_envelope({ use: 'residential', affordable, streets: [{ side: 'front', name: property.street, widthFeet: 80 }] });
  return tools.envelope;
}

// The envelope fields the site page reads; the geometry goes to the concepts.
function saved(env) {
  const { proseGuidance, sectionUrls, citations, lotGeometrySensitivity, parkingTransitZones, ...summary } = env.summary;
  const { polygon, ...lot } = env.lot;
  return { regime: env.regime, form: env.form, district: env.district, use: env.use, affordable: env.affordable, lot, floorArea: env.floorArea, metrics: env.metrics, density: env.density, parking: env.parking, checks: env.checks, capacity: env.capacity, summary };
}

async function site(deal) {
  const street = deal.address.replace(/^[\d-]+\s+/, '');
  const property = {
    borough: deal.borough, address: deal.address.toUpperCase(), street, zipcode: deal.zipCode, bbl: '', zonedist1: deal.zoningDistrict,
    lotarea: deal.lotAreaSqft, bldgarea: deal.existingBldgAreaSqft, numfloors: Math.max(2, Math.round(deal.existingBldgAreaSqft / (deal.lotAreaSqft * 0.7))),
    yearbuilt: deal.yearBuilt ?? 0, lotfront: deal.lotAreaSqft / 100, lotdepth: 100, builtfar: deal.builtFar, residfar: deal.residFar, affresfar: deal.affResFar,
    commfar: 0, facilfar: deal.residFar, landmark: '', histdist: '', splitzone: 'N', version: '25v2', latitude: deal.latitude, longitude: deal.longitude,
  };
  const base = await envelopeOf(property, false), uap = await envelopeOf(property, true);
  const rents = RENTS[deal.borough].map((rentPerSqftPerMonth, bedrooms) => ({ bedrooms, rentPerSqftPerMonth, source: 'Example rents', retrievedAt: '2026-10-23', basis: 'Illustrative asking rent for new construction' }));
  const market = { submarket: deal.neighborhood, rents };
  const gross = (env) => Math.round(env.metrics.floorAreaSqft * 1.15);
  const mix = (env) => recommendUnitMix({ productType: 'rental', residentialGrossSqft: gross(env) }, market);
  const units = (m) => m.byBedrooms.filter((r) => r.units).map((r) => ({ bedrooms: r.bedrooms, count: r.units, netSqft: r.unitSqft }));
  const landPrice = deal.listPrice ?? Math.round(deal.maxUapZfa * 120 / 10000) * 10000;
  const uapMix = mix(uap), baseMix = mix(base);
  const shared = { market, landPrice, ...ASSUMPTIONS, targetReturnOnCost: TARGET, program: { grossBuildingSqft: gross(uap), units: units(uapMix) } };
  // UAP keeps 20 percent of the homes affordable at about 45 percent of market rent.
  const variants = [
    { label: 'As-of-right rental', productType: 'rental', entitlementScore: 95, timelineMonths: 0, program: { grossBuildingSqft: gross(base), units: units(baseMix) } },
    { label: 'UAP rental', productType: 'rental', entitlementScore: 88, timelineMonths: 2, affordableShare: 0.2, affordableRentScale: 0.45, program: { grossBuildingSqft: gross(uap), units: units(uapMix) } },
  ];
  const inputs = { shared, variants, mixes: { 'As-of-right rental': baseMix, 'UAP rental': uapMix } };
  const { comparison, proForma, program } = decide({ computeProForma, comparePrograms }, inputs, T0);
  // The site page's answer line lowercases approval names ("elurp"), so that scenario stays out of the examples.
  const scenarios = entitlementScenarios({ district: deal.zoningDistrict, lotAreaSqft: deal.lotAreaSqft, existingFloorAreaSqft: deal.existingBldgAreaSqft });
  const entitlements = { ...scenarios, scenarios: scenarios.scenarios.filter((s) => s.approval !== 'elurp') };
  const concept = (id, name, env, version, extra = {}) => ({
    id, name, version, units: 'ft', createdAt: T0 + version * 60000,
    summary: version === 1 ? 'The largest as-of-right building on the lot.' : 'Adds the affordable bonus floor area and height.',
    metrics: { storeys: env.metrics.storeys, lotAreaSqft: deal.lotAreaSqft, grossFloorAreaSqft: env.metrics.floorAreaSqft, far: env.metrics.far, heightFeet: env.metrics.heightFeet, units: (version === 1 ? baseMix : uapMix).units, maxFar: env.floorArea.maxFar, maxHeightFeet: env.summary.maxBuildingHeightFeet },
    compliance: { compliant: true, violations: [] },
    massing: { lot: env.lot.polygon, storeys: env.storeys.map((s) => ({ footprint: s.footprint, base: s.floorElevationFeet, height: s.heightFeet })), maxHeightFeet: env.summary.maxBuildingHeightFeet, baseHeightMaxFeet: env.summary.baseHeightMaxFeet },
    ...extra,
  });
  const concepts = [
    concept('c-base', 'Envelope baseline', base, 1),
    concept('c-uap', 'UAP bonus scheme', uap, 2, { revision: { parentConceptId: 'c-base', parentName: 'Envelope baseline', version: 2, note: 'UAP bonus', deltas: {
      grossFloorAreaSqft: uap.metrics.floorAreaSqft - base.metrics.floorAreaSqft, far: Math.round((uap.metrics.far - base.metrics.far) * 100) / 100,
      heightFeet: uap.metrics.heightFeet - base.metrics.heightFeet, storeys: uap.metrics.storeys - base.metrics.storeys, units: uapMix.units - baseMix.units } } }),
  ];
  const { street: _street, ...record } = property;
  return {
    id: deal.id, title: deal.address, version: 4, updated: T0,
    // What steps 3 and 4 were run with, so the page can run them again on the visitor's numbers.
    inputs,
    fields: {
      property: field(record, 'acres_set_subject', [pluto]),
      envelope: field(saved(uap), 'acres_zoning_envelope', [zr('23-22'), zr('23-432')]),
      entitlements: field(entitlements, 'acres_entitlement_scenarios', [zr('23-22')]),
      concepts: field(concepts, 'acres_model_concept'),
      program: field(program, 'acres_unit_mix'),
      market: field(market, 'acres_market_inputs'),
      proFormas: field([proForma], 'acres_pro_forma'),
      comparisons: field([comparison], 'acres_compare_programs'),
      assumptions: field({ landPrice, ...ASSUMPTIONS }, 'user'),
    },
  };
}

// The calculation code for the browser. The research modules it imports also hold the deal store and
// tool runners, which need Node; every Node built-in they import becomes a stub module with the same
// export names, each a function that throws if called. The calculations need only the JSON tables the
// bundled modules read beside themselves (inlined, by file name, through readFileSync) and
// AsyncLocalStorage (a pass-through); promisify, which a tool runner calls as it loads, hands back a stub.
const unavailable = 'function unavailable() { throw new Error("Not available in the browser."); }';
const research = new URL('../acres-research/', import.meta.url);
let tables = {};
const working = () => ({
  'node:fs': { readFileSync: `(url) => { const name = String(url).split("/").pop(); if (!(name in tables)) unavailable(); return tables[name]; }; const tables = ${JSON.stringify(tables)}` },
  'node:async_hooks': { AsyncLocalStorage: 'class { getStore() {} run(store, fn) { return fn(); } }' },
  'node:util': { promisify: '() => unavailable' },
});
async function shim(name) {
  const names = Object.keys(await import(name)).filter((key) => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key));
  const value = (key) => working()[name]?.[key] ?? 'unavailable';
  return `${unavailable}\n${names.map((key) => `export const ${key} = ${value(key)};`).join('\n')}\nexport default { ${names.join(', ')} };`;
}
const calc = {
  stdin: { contents: "export { computeProForma } from './proforma.mjs'; export { comparePrograms } from './feasibility.mjs';", resolveDir: research.pathname },
  bundle: true, format: 'esm', platform: 'browser', minify: true, legalComments: 'none',
  outfile: new URL('./public/demo/calc.js', import.meta.url).pathname,
  plugins: [{ name: 'node-shims', setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'shim' }));
    b.onLoad({ filter: /.*/, namespace: 'shim' }, async (args) => ({ contents: await shim(args.path), loader: 'js' }));
  } }],
};
// A first pass finds the bundled research modules and the JSON tables they read; the second writes.
const { metafile } = await build({ ...calc, write: false, metafile: true });
const read = Object.keys(metafile.inputs).filter((input) => input.startsWith('acres-research/'))
  .flatMap((input) => [...fs.readFileSync(new URL(input.slice('acres-research/'.length), research), 'utf8').matchAll(/new URL\(['"]\.\/([\w.-]+\.json)['"]/g)].map((m) => m[1]));
tables = Object.fromEntries([...new Set(read)].map((name) => [name, fs.readFileSync(new URL(name, research), 'utf8')]));
await build(calc);

const dir = new URL('./public/demo/sites/', import.meta.url);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
for (const deal of DEALS) {
  const state = await site(deal);
  fs.writeFileSync(new URL(`${deal.id}.json`, dir), JSON.stringify(state));
  console.log(`${state.title}: ${state.fields.envelope.value.metrics.storeys} storeys, ${state.fields.comparisons.value[0].decision.call}`);
}
