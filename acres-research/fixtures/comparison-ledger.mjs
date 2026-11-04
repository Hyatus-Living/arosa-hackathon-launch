import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LedgerStore, createSubjectLedger, FORMULA_VERSION} from '../ledger.mjs';
import {createResearchTools} from '../tools.mjs';
import {createProFormaTools} from '../proforma.mjs';
import {createFeasibilityTools} from '../feasibility.mjs';

export function comparisonFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-ledger-comparison-')), path = join(dir, 'ledger.sqlite');
  const store = new LedgerStore(path), at = '2026-10-16T06:00:00.000Z';
  for (const [index, price] of [80, 100, 120].entries()) store.upsertLandSale({
    bbl: `100015000${index + 2}`, borough: '1', block: 15, lot: index + 2, doc_id: `synthetic-${index}`, doc_type: 'DEED', document_amt: price * 10000, recorded_at: '2026-09-15', lot_area_sqft: 1000, zone_dist: 'C6-4', lot_count: 1, bundled: 0, arms_length: 1, max_zfa_standard: 10000, price_per_zfa: price, price_per_zfa_reason: null, query_url: 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json', fetched_at: at, formula_version: FORMULA_VERSION,
  });
  store.upsertAssessment({bbl: '1000150001', fiscal_year: 2026, period: 3, assessed_value: 200000, tax_class: '4', market_value: 1000000, query_url: 'https://data.cityofnewyork.us/resource/8y4t-faws.json', fetched_at: at});
  for (const dataset of ['acris', 'assessments']) store.recordRun({run_id: `synthetic-${dataset}`, dataset, dataset_id: dataset, since: '2026-09-01', until: '2026-10-16', rows_fetched: 3, inserted: 3, updated: 0, unchanged: 0, trimmed: 0, status: 'ok', started_at: at, finished_at: at});
  const property = {bbl: '1000150001', zipcode: '10013', lotarea: '1000', zonedist1: 'C6-4'};
  const rates = {sourceUrl: 'https://example.com/synthetic-tax-rate', retrievedAt: at, fiscalYears: {2026: {rates: {'4': .1}}}};
  const subject = createSubjectLedger({getProperty: () => property, openLedger: () => store, now: () => new Date(at), rates});
  const counts = {land: 0, taxes: 0}, queries = [], prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {queries.push(sql); return prepare(sql);};
  const ledger = {landPriceEstimate: () => {counts.land++; return subject.landPriceEstimate();}, taxes: () => {counts.taxes++; return subject.taxes();}};
  const market = {submarket: 'Synthetic comparison fixture', rents: [{bedrooms: 0, rentPerSqftPerMonth: 8, source: 'Synthetic assumption', retrievedAt: '2026-10-12'}], salePrices: [{bedrooms: 0, pricePerSqft: 1200, source: 'Synthetic assumption', retrievedAt: '2026-10-12'}]};
  const shared = {program: {grossBuildingSqft: 10000, units: [{bedrooms: 0, count: 10, netSqft: 450}]}, landPrice: 1000000, hardCostPerSqft: 450, softCostPerSqft: 100, financing: {loanToCost: .6, interestRate: .08, termMonths: 30}, operating: {residentialVacancyRate: .05, residentialOpexPerUnitPerYear: 12000, commercialVacancyRate: .1, commercialOpexPerSqftPerYear: 5}, capRate: .05, sellingCostRate: .06};
  const variants = [{label: 'Market rental', productType: 'rental'}, {label: 'Affordable rental', productType: 'rental', affordableShare: .2, affordableRentScale: .4, entitlementScore: 65, timelineMonths: 12}, {label: 'Condo', productType: 'condo'}];
  const tools = createResearchTools({}), proformas = createProFormaTools({getMarket: () => market, ledger, record: tools.record}), feasibility = createFeasibilityTools({getMarket: () => market, ledger, record: tools.record});
  return {dir, path, store, property, ledger, counts, queries, market, shared, variants, tools, proformas, feasibility, close() {store.close(); rmSync(dir, {recursive: true});}};
}
