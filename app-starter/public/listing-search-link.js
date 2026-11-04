import {FILTER_SCHEMA_ID, FILTER_SCHEMA, COST_KEYS, defaultFilterValues, validateFilterSnapshot, validateFilterValues, validateSearchState} from './listing-filter-schema.js';
import {linkOrigin} from './core-route.js';

// The search a snapshot shows, with each cost frozen at its override or the recorded baseline: what a
// link shares and a saved search keeps.
export function listingSearchState(input) {
  const snapshot = validateFilterSnapshot(input);
  const values = validateFilterValues(Object.fromEntries(FILTER_SCHEMA.required.map(key => [key, COST_KEYS.includes(key) ? snapshot.values[key] ?? snapshot.baselineCosts[key] ?? null : snapshot.values[key]])));
  return validateSearchState({schema:FILTER_SCHEMA_ID, values, bounds:snapshot.map?.bounds ?? null, ...(snapshot.condoHardCostPerGrossSqft != null ? {condoHardCostPerGrossSqft:snapshot.condoHardCostPerGrossSqft} : {})});
}

export function createListingSearchLink(baseUrl, input) {
  const {values, bounds, condoHardCostPerGrossSqft} = listingSearchState(input);
  const target = new URL('/', linkOrigin(new URL(baseUrl).origin));
  target.searchParams.set('search', JSON.stringify({schema:FILTER_SCHEMA_ID, values, bounds, ...(condoHardCostPerGrossSqft != null ? {condoHardCostPerGrossSqft} : {})}));
  return target.href;
}

export function readListingSearchLink(value) {
  const target = new URL(value), text = target.searchParams.get('search');
  if (text === null) return null;
  const data = JSON.parse(text);
  if (data?.schema !== FILTER_SCHEMA_ID) throw new Error('Unsupported search link.');
  // Links shared before a filter existed leave it out; it reads as its default. A link from before the
  // condo hard cost travelled has none: its hard cost priced both exits.
  const {values, bounds, condoHardCostPerGrossSqft} = validateSearchState({schema:FILTER_SCHEMA_ID, values:{...defaultFilterValues(), ...data.values}, bounds:data.bounds, ...(data.condoHardCostPerGrossSqft != null ? {condoHardCostPerGrossSqft:data.condoHardCostPerGrossSqft} : {})});
  return condoHardCostPerGrossSqft != null ? {values, bounds, condoHardCostPerGrossSqft} : {values, bounds};
}
