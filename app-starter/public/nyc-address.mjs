// New York City address suggestions from NYC Planning's GeoSearch (built on the city's
// Property Address Directory, so every NYC address resolves, not only listed properties).
// GeoSearch serves the five boroughs only, which is the geo restriction the create and
// search flows want. Each suggestion carries the parcel BBL the rest of Arosa keys on.
const AUTOCOMPLETE_URL = 'https://geosearch.planninglabs.nyc/v2/autocomplete';

export function parseGeosearchSuggestions(payload, limit = 6) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const suggestions = [];
  for (const feature of features) {
    const p = feature?.properties || {};
    const bbl = p.addendum?.pad?.bbl;
    if (!p.label || !/^\d{10}$/.test(bbl || '')) continue;
    suggestions.push({
      label: p.label,
      name: p.name || p.label,
      borough: p.borough || null,
      postalcode: p.postalcode || null,
      bbl,
      bin: p.addendum?.pad?.bin || null,
      coordinates: feature?.geometry?.coordinates || null,
    });
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}

export async function fetchAddressSuggestions(text, { fetcher = fetch, signal } = {}) {
  const query = String(text || '').trim().replace(/\s+/g, ' ');
  if (query.length < 3) return [];
  const url = `${AUTOCOMPLETE_URL}?${new URLSearchParams({ text: query, size: '6' })}`;
  const response = await fetcher(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Address lookup returned HTTP ${response.status}.`);
  return parseGeosearchSuggestions(await response.json());
}
