import {publicUrl} from './public-url.mjs';

// Jurisdiction detection and capability-tier lookup.
// Deep-coverage cities have structured parcel/envelope/context adapters; today only New York City
// has PLUTO, GeoSearch, curated Lower Manhattan bulk rules and building footprints wired.
// Every other detected US city is research-tier: the agent works from live official sources and
// indexed knowledge for that jurisdiction plus generic massing, market and pro-forma tools.

export const NYC_JURISDICTION = 'US-NY-NYC';

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const ABBREVIATIONS = new Set(Object.values(STATES));
const STATE_NAMES = Object.keys(STATES).sort((a, b) => b.length - a.length);
const BOROUGHS = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten island'];
const STREET_SUFFIXES = new Set(['street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'road', 'rd', 'drive', 'dr', 'lane', 'ln', 'way', 'place', 'pl', 'court', 'ct', 'highway', 'hwy', 'parkway', 'terrace', 'trail', 'circle', 'broadway']);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Unambiguous US cities/municipalities recognized in search queries even when written without ", ST".
const KNOWN_US_CITIES = [
  ['west palm beach', 'FL'], ['palm beach gardens', 'FL'], ['palm beach', 'FL'], ['fort lauderdale', 'FL'],
  ['boca raton', 'FL'], ['delray beach', 'FL'], ['boynton beach', 'FL'], ['miami beach', 'FL'],
  ['coral gables', 'FL'], ['miami', 'FL'], ['orlando', 'FL'], ['tampa', 'FL'], ['st petersburg', 'FL'],
  ['jacksonville', 'FL'], ['tallahassee', 'FL'], ['sarasota', 'FL'], ['naples', 'FL'],
  ['los angeles', 'CA'], ['san francisco', 'CA'], ['san diego', 'CA'], ['san jose', 'CA'],
  ['santa monica', 'CA'], ['beverly hills', 'CA'], ['west hollywood', 'CA'], ['pasadena', 'CA'],
  ['long beach', 'CA'], ['oakland', 'CA'], ['berkeley', 'CA'], ['sacramento', 'CA'], ['palo alto', 'CA'],
  ['irvine', 'CA'], ['anaheim', 'CA'], ['fresno', 'CA'],
  ['austin', 'TX'], ['dallas', 'TX'], ['houston', 'TX'], ['san antonio', 'TX'], ['fort worth', 'TX'],
  ['el paso', 'TX'], ['plano', 'TX'], ['frisco', 'TX'],
  ['chicago', 'IL'], ['evanston', 'IL'],
  ['boston', 'MA'], ['cambridge', 'MA'], ['somerville', 'MA'], ['brookline', 'MA'],
  ['philadelphia', 'PA'], ['pittsburgh', 'PA'],
  ['seattle', 'WA'], ['bellevue', 'WA'], ['tacoma', 'WA'],
  ['denver', 'CO'], ['boulder', 'CO'], ['colorado springs', 'CO'],
  ['atlanta', 'GA'], ['savannah', 'GA'],
  ['phoenix', 'AZ'], ['scottsdale', 'AZ'], ['tempe', 'AZ'], ['tucson', 'AZ'],
  ['charlotte', 'NC'], ['raleigh', 'NC'], ['durham', 'NC'],
  ['nashville', 'TN'], ['memphis', 'TN'], ['knoxville', 'TN'], ['chattanooga', 'TN'],
  ['new orleans', 'LA'], ['baton rouge', 'LA'],
  ['detroit', 'MI'], ['ann arbor', 'MI'], ['grand rapids', 'MI'],
  ['minneapolis', 'MN'], ['st paul', 'MN'],
  ['st louis', 'MO'], ['kansas city', 'MO'],
  ['baltimore', 'MD'], ['bethesda', 'MD'], ['silver spring', 'MD'],
  ['washington dc', 'DC'], ['district of columbia', 'DC'],
  ['las vegas', 'NV'], ['reno', 'NV'], ['henderson', 'NV'],
  ['salt lake city', 'UT'], ['provo', 'UT'],
  ['jersey city', 'NJ'], ['hoboken', 'NJ'], ['newark', 'NJ'], ['paterson', 'NJ'], ['princeton', 'NJ'],
  ['stamford', 'CT'], ['new haven', 'CT'], ['hartford', 'CT'], ['bridgeport', 'CT'], ['greenwich', 'CT'], ['norwalk', 'CT'],
  ['yonkers', 'NY'], ['white plains', 'NY'], ['new rochelle', 'NY'], ['mount vernon', 'NY'],
  ['buffalo', 'NY'], ['rochester', 'NY'], ['syracuse', 'NY'], ['albany', 'NY'],
  ['milwaukee', 'WI'], ['madison', 'WI'],
  ['indianapolis', 'IN'], ['columbus', 'OH'], ['cleveland', 'OH'], ['cincinnati', 'OH'],
  ['louisville', 'KY'], ['lexington', 'KY'],
  ['richmond', 'VA'], ['arlington', 'VA'], ['alexandria', 'VA'], ['virginia beach', 'VA'],
  ['charleston', 'SC'], ['columbia', 'SC'], ['greenville', 'SC'],
  ['birmingham', 'AL'], ['huntsville', 'AL'],
  ['oklahoma city', 'OK'], ['tulsa', 'OK'],
  ['albuquerque', 'NM'], ['santa fe', 'NM'],
  ['honolulu', 'HI'], ['anchorage', 'AK'], ['boise', 'ID'], ['omaha', 'NE'], ['des moines', 'IA'],
  ['providence', 'RI'],
].sort((a, b) => b[0].length - a[0].length);

const HOST_JURISDICTIONS = [
  [/(?:^|\.)(?:nyc\.gov|cityofnewyork\.us|nycedc\.com)$/i, NYC_JURISDICTION],
  [/(?:^|\.)(?:nysenate\.gov|ny\.gov|nycourts\.gov)$/i, 'US-NY'],
  [/(?:^|\.)(?:miami\.gov|miamigov\.com)$/i, 'US-FL-MIAMI'],
  [/(?:^|\.)miamibeachfl\.gov$/i, 'US-FL-MIAMIBEACH'],
  [/(?:^|\.)wpb\.org$/i, 'US-FL-WESTPALMBEACH'],
  [/(?:^|\.)fortlauderdale\.gov$/i, 'US-FL-FORTLAUDERDALE'],
  [/(?:^|\.)myboca\.us$/i, 'US-FL-BOCARATON'],
  [/(?:^|\.)orlando\.gov$/i, 'US-FL-ORLANDO'],
  [/(?:^|\.)tampa\.gov$/i, 'US-FL-TAMPA'],
  [/(?:^|\.)myflorida\.com|flsenate\.gov|leg\.state\.fl\.us$/i, 'US-FL'],
  [/(?:^|\.)austintexas\.gov$/i, 'US-TX-AUSTIN'],
  [/(?:^|\.)dallascityhall\.com$/i, 'US-TX-DALLAS'],
  [/(?:^|\.)houstontx\.gov$/i, 'US-TX-HOUSTON'],
  [/(?:^|\.)sanantonio\.gov$/i, 'US-TX-SANANTONIO'],
  [/(?:^|\.)(?:lacity\.org|lacity\.gov)$/i, 'US-CA-LOSANGELES'],
  [/(?:^|\.)(?:sfplanning\.org|sfgov\.org|sf\.gov)$/i, 'US-CA-SANFRANCISCO'],
  [/(?:^|\.)sandiego\.gov$/i, 'US-CA-SANDIEGO'],
  [/(?:^|\.)sanjoseca\.gov$/i, 'US-CA-SANJOSE'],
  [/(?:^|\.)oaklandca\.gov$/i, 'US-CA-OAKLAND'],
  [/(?:^|\.)ca\.gov|leginfo\.legislature\.ca\.gov$/i, 'US-CA'],
  [/(?:^|\.)cityofchicago\.org|chicago\.gov$/i, 'US-IL-CHICAGO'],
  [/(?:^|\.)(?:bostonplans\.org|boston\.gov)$/i, 'US-MA-BOSTON'],
  [/(?:^|\.)cambridgema\.gov$/i, 'US-MA-CAMBRIDGE'],
  [/(?:^|\.)mass\.gov$/i, 'US-MA'],
  [/(?:^|\.)phila\.gov$/i, 'US-PA-PHILADELPHIA'],
  [/(?:^|\.)seattle\.gov$/i, 'US-WA-SEATTLE'],
  [/(?:^|\.)denvergov\.org$/i, 'US-CO-DENVER'],
  [/(?:^|\.)atlantaga\.gov$/i, 'US-GA-ATLANTA'],
  [/(?:^|\.)phoenix\.gov$/i, 'US-AZ-PHOENIX'],
  [/(?:^|\.)(?:dc\.gov|dcoz\.dc\.gov)$/i, 'US-DC-WASHINGTON'],
  [/(?:^|\.)jerseycitynj\.gov$/i, 'US-NJ-JERSEYCITY'],
  [/(?:^|\.)hobokennj\.gov$/i, 'US-NJ-HOBOKEN'],
  [/(?:^|\.)newarknj\.gov$/i, 'US-NJ-NEWARK'],
  [/(?:^|\.)nj\.gov$/i, 'US-NJ'],
];

// Nationwide official & statutory codifier authority table.
const AUTHORITY_RULES = [
  [/\.(?:gov|mil|nyc)$/i, 1.0],
  [/(?:^|\.)(?:cityofnewyork\.us|myboca\.us)$/i, 1.0],
  [/(?:^|\.)(?:state|ci|co|gov|town|village)\.[a-z0-9-]+(?:\.[a-z]{2})?\.us$/i, 0.95],
  [/(?:^|\.)[a-z0-9-]+\.(?:state|ci|co)\.[a-z]{2}\.us$/i, 0.95],
  [/(?:^|\.)data\.[a-z0-9-]+\.(?:gov|us|org)$/i, 0.95],
  [/(?:^|\.)(?:municode\.com|amlegal\.com|ecode360\.com|up\.codes|qcode\.us|codepublishing\.com|generalcode\.com|sterlingcodifiers\.com|clerkshq\.com|encodeplus\.com)$/i, 0.95],
  [/(?:^|\.)(?:wpb\.org|lacity\.org|cityofchicago\.org|sfplanning\.org|sfgov\.org|bostonplans\.org|denvergov\.org|dallascityhall\.com|nycedc\.com)$/i, 0.92],
  [/(?:^|\.)(?:law\.cornell\.edu|law\.justia\.com|casetext\.com)$/i, 0.85],
  [/(?:^|\.)scholar\.google\.com$/i, 0.8],
  [/\.edu$/i, 0.75],
];

export function scoreSourceAuthority(rawUrl) {
  try {
    if (!publicUrl(rawUrl)) return 0;
    const host = new URL(rawUrl).hostname.toLowerCase();
    for (const [re, score] of AUTHORITY_RULES) {
      if (re.test(host)) return score;
    }
    return 0.4;
  } catch {
    return 0;
  }
}

export function isAuthoritativeSourceUrl(rawUrl) {
  try {
    if (!publicUrl(rawUrl)) return false;
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    if (/scholar\.google\.com$/i.test(host)) return false;
    return scoreSourceAuthority(rawUrl) >= 0.85;
  } catch {
    return false;
  }
}

export function citySlug(city) {
  return String(city || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}
const titleCase = value => value.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_, sep, letter) => sep + letter.toUpperCase());
const isNycCity = (city, state) => state === 'NY' && (citySlug(city) === 'NEWYORK' || citySlug(city) === 'NYC' || BOROUGHS.some(borough => citySlug(borough) === citySlug(city)) || citySlug(city) === 'THEBRONX');

function result(city, state, basis) {
  if (isNycCity(city, state)) return {jurisdiction: NYC_JURISDICTION, city: 'New York City', state: 'NY', tier: 'deep', confidence: 'high', basis};
  const slug = citySlug(city);
  if (!slug || !ABBREVIATIONS.has(state)) return null;
  return {jurisdiction: `US-${state}-${slug}`, city: titleCase(city.trim()), state, tier: 'research', confidence: 'high', basis};
}

// The city is the short segment after the previous comma ("500 Main Street, Austin, TX"), or the
// trailing capitalized words before the state comma ("a site in Los Angeles, California").
function cityBefore(text, commaIndex) {
  const segment = text.slice(0, commaIndex).split(/[,;\n]/).pop().trim();
  const words = segment.split(/\s+/).filter(Boolean);
  if (!words.length || /^\d/.test(words[0])) return null;
  let city = null;
  if (words.length <= 3 && words.every(word => /^[A-Za-z][A-Za-z.'-]*$/.test(word))) city = words.join(' ');
  else {
    const trailing = [];
    for (let i = words.length - 1; i >= 0 && trailing.length < 4; i--) {
      if (!/^[A-Z][a-z.'-]*$|^[A-Z]{2,}[.'-]?$/.test(words[i])) break;
      trailing.unshift(words[i]);
    }
    if (trailing.length) city = trailing.join(' ');
  }
  if (!city) return null;
  const last = city.split(/\s+/).at(-1).toLowerCase().replace(/\.$/, '');
  return STREET_SUFFIXES.has(last) ? null : city;
}

function detectExplicit(text) {
  const pattern = new RegExp(`,\\s*(${STATE_NAMES.map(escapeRegExp).join('|')}|[A-Za-z]{2})(?![A-Za-z])`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const token = match[1];
    let state = STATES[token.toLowerCase()] || null;
    if (!state) {
      // A two-letter token counts as a state abbreviation when typed as one (uppercase), or when
      // it closes the address (end, ZIP or sentence punctuation) so ", in the" is not Indiana.
      const after = text.slice(match.index + match[0].length);
      const abbreviation = token.toUpperCase();
      if (!ABBREVIATIONS.has(abbreviation)) continue;
      if (token !== abbreviation && !/^\s*(\d{5}\b|[.?!]|$)/.test(after)) continue;
      state = abbreviation;
    }
    const city = cityBefore(text, match.index);
    const found = city ? result(city, state, 'city-state') : null;
    if (found) return found;
  }
  return null;
}

export function detectJurisdiction(text, {bbl = null} = {}) {
  if (typeof bbl === 'string' && /^[1-5]\d{9}$/.test(bbl)) {
    return {jurisdiction: NYC_JURISDICTION, city: 'New York City', state: 'NY', tier: 'deep', confidence: 'high', basis: 'bbl'};
  }
  if (typeof text !== 'string' || !text.trim()) return null;
  const explicit = detectExplicit(text);
  if (explicit) return explicit;
  if (/\b(?:bbl|borough.?block.?lot)\D{0,12}[1-5]\d{9}/i.test(text)) {
    return {jurisdiction: NYC_JURISDICTION, city: 'New York City', state: 'NY', tier: 'deep', confidence: 'high', basis: 'bbl'};
  }
  if (/\bnew york city\b/i.test(text) || /\bnyc\b/i.test(text)) {
    return {jurisdiction: NYC_JURISDICTION, city: 'New York City', state: 'NY', tier: 'deep', confidence: 'high', basis: 'phrase'};
  }
  if (new RegExp(`\\b(?:${BOROUGHS.map(escapeRegExp).join('|')})\\b`, 'i').test(text)) {
    return {jurisdiction: NYC_JURISDICTION, city: 'New York City', state: 'NY', tier: 'deep', confidence: 'high', basis: 'borough'};
  }
  return null;
}

export function inferUrlJurisdiction(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const host = u.hostname.toLowerCase();
    for (const [re, jur] of HOST_JURISDICTIONS) {
      if (re.test(host)) return jur;
    }
    if (/\.nyc$/i.test(host)) return NYC_JURISDICTION;
    const stateHost = host.match(/(?:^|\.)(?:state|ci|co)\.([a-z]{2})\.us$/i) || host.match(/^([a-z]{2})\.gov$/i);
    if (stateHost && ABBREVIATIONS.has(stateHost[1].toUpperCase())) {
      return `US-${stateHost[1].toUpperCase()}`;
    }
    // Codifier URL paths: library.municode.com/<st>/<city>, up.codes/viewer/<state>/<code-slug>
    if (/municode\.com$/i.test(host)) {
      const m = u.pathname.match(/^\/([a-z]{2})\/([a-z0-9_-]+)/i);
      if (m && ABBREVIATIONS.has(m[1].toUpperCase())) {
        const st = m[1].toUpperCase();
        const city = m[2].replace(/[_-]+/g, ' ');
        return result(city, st, 'url-path')?.jurisdiction || `US-${st}`;
      }
    }
    if (/up\.codes$/i.test(host)) {
      const m = u.pathname.match(/^\/viewer\/([a-z_]+)\/([a-z0-9_-]+)/i);
      if (m) {
        const stateKey = m[1].replace(/_/g, ' ').toLowerCase();
        const st = STATES[stateKey] || null;
        if (/^nyc[-_]/i.test(m[2])) return NYC_JURISDICTION;
        if (st) return `US-${st}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Broader search-time jurisdiction inference from free-text queries, prompts, or source titles.
export function inferQueryJurisdiction(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();
  if (/^US(?:-[A-Z0-9]+){0,3}$/.test(trimmed)) return trimmed;
  if (/^nyc$/i.test(trimmed)) return NYC_JURISDICTION;

  const direct = detectJurisdiction(trimmed);
  if (direct) return direct.jurisdiction;

  // Check embedded URLs
  for (const urlMatch of trimmed.matchAll(/https?:\/\/[^\s)>\]"']+/gi)) {
    const fromUrl = inferUrlJurisdiction(urlMatch[0]);
    if (fromUrl) return fromUrl;
  }

  // Known US municipalities mentioned without comma ("West Palm Beach short term rental rules", "Miami zoning")
  for (const [city, state] of KNOWN_US_CITIES) {
    const re = new RegExp(`\\b${escapeRegExp(city).replace(/\\ /g, '[\\s.-]+')}\\b`, 'i');
    if (re.test(trimmed)) {
      const r = result(city, state, 'known-city');
      if (r) return r.jurisdiction;
    }
  }

  // Space-separated "<City> <State>" where State is an uppercase 2-letter postal code or full state name
  // e.g. "Cambridge MA zoning", "in New Rochelle NY", "Boulder Colorado setbacks"
  const statePattern = new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\s+(${STATE_NAMES.map(escapeRegExp).join('|')}|[A-Z]{2})\\b`, 'g');
  for (const match of trimmed.matchAll(statePattern)) {
    const candidateCity = match[1].trim();
    const token = match[2];
    const st = STATES[token.toLowerCase()] || (ABBREVIATIONS.has(token) ? token : null);
    if (!st) continue;
    const firstWord = candidateCity.split(/\s+/)[0].toLowerCase();
    const StopPrefixes = new Set(['in', 'at', 'for', 'of', 'near', 'from', 'to', 'and', 'or', 'the', 'site', 'lot', 'parcel', 'zoning', 'rules', 'code', 'law', 'under', 'section', 'article', 'chapter']);
    const cleanCity = candidateCity.split(/\s+/).filter((w, idx) => idx > 0 || !StopPrefixes.has(w.toLowerCase())).join(' ');
    if (!cleanCity || StopPrefixes.has(cleanCity.toLowerCase()) || STREET_SUFFIXES.has(cleanCity.split(/\s+/).at(-1).toLowerCase())) continue;
    const found = result(cleanCity, st, 'space-city-state');
    if (found) return found.jurisdiction;
  }

  // NYC-specific regulatory/zoning vocabulary when no non-NY location was matched
  if (/\b(?:zoning resolution|zr\s+\d{1,3}-\d|ulurp|ceqr|pluto|zola|acris|\bmih\b|\buap\b|\bqah\b|485-?x|421-?a|multiple dwelling law|\bsnx\b|sliver law)\b/i.test(trimmed)) {
    return NYC_JURISDICTION;
  }

  // State-level mentions ("Florida short term rental statute", "California SB 9")
  for (const stateName of STATE_NAMES) {
    if (new RegExp(`\\b${escapeRegExp(stateName)}\\b`, 'i').test(trimmed)) {
      const st = STATES[stateName];
      return `US-${st}`;
    }
  }

  return null;
}

// Whether a research run is about New York City, so NYC-only specialist tools can be offered
// directly. A place named in the latest question wins over an earlier subject; then the confirmed
// subject BBL, then the most recent user turn that names a place. With no place at all, NYC is
// assumed because the parcel lookup resolves a bare street address there.
export function runInNyc({message = '', history = [], propertyBbl = null} = {}) {
  const inNyc = jurisdiction => jurisdiction === NYC_JURISDICTION || jurisdiction === 'US-NY';
  const named = inferQueryJurisdiction(message);
  if (named) return inNyc(named);
  if (propertyBbl) return true;
  for (const turn of [...history].reverse()) {
    if (turn.role !== 'user') continue;
    const earlier = inferQueryJurisdiction(turn.text);
    if (earlier) return inNyc(earlier);
  }
  return true;
}

export function normalizeJurisdictionInput(city) {
  if (typeof city !== 'string' || !city.trim()) {
    throw new Error('Use a jurisdiction identifier such as US-NY-NYC.');
  }
  const trimmed = city.trim();
  if (/^[A-Z]{2}(?:-[A-Z0-9]+){0,3}$/.test(trimmed)) return trimmed;
  if (/^nyc$/i.test(trimmed)) return NYC_JURISDICTION;
  // Reject strings containing injection/punctuation characters outside normal place names
  if (!/^[A-Za-z0-9\s,.'-]+$/.test(trimmed) || trimmed.length > 80 || /--/.test(trimmed)) {
    throw new Error('Use a jurisdiction identifier such as US-NY-NYC.');
  }
  if (ABBREVIATIONS.has(trimmed.toUpperCase())) return `US-${trimmed.toUpperCase()}`;
  const inferred = inferQueryJurisdiction(trimmed);
  if (inferred) return inferred;
  throw new Error('Use a jurisdiction identifier such as US-NY-NYC.');
}

export function resolveSearchJurisdiction({city, query = '', fallbackCity = null} = {}) {
  const queryJur = inferQueryJurisdiction(query);
  if (city !== undefined) {
    const explicit = normalizeJurisdictionInput(city);
    return explicit;
  }
  if (queryJur) return queryJur;
  if (fallbackCity) {
    try { return normalizeJurisdictionInput(fallbackCity); } catch {}
  }
  return NYC_JURISDICTION;
}

export function coverageFor(jurisdiction) {
  if (typeof jurisdiction !== 'string' || !/^[A-Z]{2}(?:-[A-Z0-9]+){0,3}$/.test(jurisdiction)) return null;
  if (jurisdiction === NYC_JURISDICTION) return {
    jurisdiction,
    tier: 'deep',
    label: 'Deep coverage: New York City',
    capabilities: [
      'Parcel resolution from NYC PLUTO and GeoSearch by address, borough or BBL, with nearby-parcel lookup.',
      'Zoning capacity from PLUTO FAR fields, plus the curated envelope for the districts encoded so far (mostly Lower Manhattan) when the host enables it.',
      'Neighbouring buildings from NYC building footprints around a modeled concept.',
      'Saved knowledge and source-registry coverage for NYC, New York State and federal sources.',
      'Generic concept massing, market inputs and pro forma, as in every tier.',
    ],
    gaps: [
      'Curated bulk rules do not cover every NYC district; unencoded districts need live Zoning Resolution retrieval.',
      'PLUTO figures are reported parcel data, not verified development rights or an entitlement.',
    ],
  };
  return {
    jurisdiction,
    tier: 'research',
    label: 'Research coverage: sourced live research, no parcel adapter yet',
    capabilities: [
      'Live research against this jurisdiction\'s official zoning text, maps and agency sources, cited the same way as NYC answers.',
      'Saved-knowledge and source-registry search scoped to this jurisdiction and its state and federal parents; saved coverage grows per market and may be empty today.',
      'Concept massing in 2D and 3D from a lot outline the user supplies or retrieved evidence supports, with areas, FAR and height computed from the geometry.',
      'Market inputs, unit mix and pro forma from figures the user supplies or retrieved sources report.',
    ],
    gaps: [
      'No parcel-record adapter is wired for this city yet, so there is no PLUTO or BBL equivalent lookup, subject-parcel panel or nearby-parcel search.',
      'No curated zoning envelope is computed for this city; districts, FAR, height and setbacks must be read from current official text, never inferred from NYC rules.',
      'No building-footprint neighbour context is wired for this city yet.',
    ],
  };
}
