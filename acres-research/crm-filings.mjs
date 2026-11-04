// Who is building in New York City, read from DOB NOW new-building filings: the owners (developers),
// the architects of record and the filing representatives (expediters). Developers file each project
// through its own LLC, so filings are grouped into firms by linking a normalized business name, the
// person named on the filing and, for architects, the license number. Every group keeps the raw names
// it merged, as provenance, and its filings as evidence. Used by scripts/crm-import-filings.mjs to
// build the Outreach CRM target list.
import {NB_FILINGS} from './crm.mjs';

export const DOB_NOW_FILINGS_URL = 'https://data.cityofnewyork.us/resource/w9ak-ipjd.json';
export const FILING_FIELDS = ['job_filing_number', 'filing_status', 'filing_date', 'borough', 'house_no', 'street_name', 'bbl', 'nta',
  'building_type', 'proposed_dwelling_units', 'total_construction_floor_area', 'proposed_no_of_stories', 'owner_type', 'owner_s_business_name',
  'owner_first_name', 'owner_last_name', 'applicant_professional_title', 'applicant_license', 'applicant_first_name', 'applicant_last_name',
  'applicant_business_name', 'filing_representative_first_name', 'filing_representative_last_name', 'filing_representative_business_name'];
export const FILING_ROLES = ['developer', 'architect', 'expediter'];
// Multifamily projects: the sites a development underwriting tool is for.
export const MIN_UNITS = 3;
// Filings that never became a project: withdrawn, or abandoned before submission (test filings land here).
const DROPPED = new Set(['Filing Withdrawn', 'Incomplete']);
const PUBLIC_OWNERS = new Set(['NYC Agency', 'NYCHA/HHC Owned and Operated', 'School Construction Authority', 'Other Government Owned and Operated']);
// Business names filers enter when there is none.
const PLACEHOLDER = /^(PR|PRIVATE|N ?A|NOT APPLICABLE|NONE|SELF|OWNERS?|OWNERS? REP(RESENTATIVE)?|HOMEOWNER|INDIVIDUAL|TBD|UNKNOWN|NO|X+|0+|)$/;
const LEGAL_SUFFIX = / (L ?L ?C|L ?L ?P|L ?P|P ?L ?L ?C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|P ?C|D ?P ?C|R ?A)$/;
// Spelling variants of the same word, so "Acme Developers" and "Acme Development" are one firm.
const SYNONYMS = [[/\b(DEVELOPERS?|DEVELOPMENTS|DEV)\b/g, 'DEVELOPMENT'], [/\bCONST\b/g, 'CONSTRUCTION'], [/\bMGMT\b/g, 'MANAGEMENT'],
  [/\bARCHITECTS?\b|\bARCHITECTURAL\b/g, 'ARCHITECTURE'], [/\bCONSULTANTS?\b/g, 'CONSULTING'], [/\bEXPEDIT[EO]RS?\b/g, 'EXPEDITING'],
  [/\bASSOCIATE\b/g, 'ASSOCIATES']];
// Words an architecture firm's name may carry or drop ("SLCE Architects" and "SLCE").
const ARCHITECT_WORDS = / (ARCHITECTURE|DESIGN|STUDIO)$/;
const COMPANY_WORDS = /\b(LLC|INC|CORP|LTD|LP|LLP|PC|GROUP|CONSULTING|CONSULTANTS|DEVELOPMENT|REALTY|HOLDINGS|MANAGEMENT|PROPERTIES|ASSOCIATES|SERVICES|TRUST|BANK|CITY|NYC|AUTHORITY|AGENCY|DEPARTMENT|DEPT)\b/;

// Parentheses hold branch or office numbers ("Xpdite Group (103)").
const clean = (value) => String(value ?? '').toUpperCase().replace(/\([^)]*\)/g, ' ').replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^THE /, '');
const strip = (value, pattern) => {let s = value, prev; do {prev = s; s = s.replace(pattern, '').trim();} while (s !== prev); return s;};
const num = (value) => {const n = Number.parseFloat(value); return Number.isFinite(n) ? n : 0;};
const top = (counts) => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
const tally = (map, key, by = 1) => key && map.set(key, (map.get(key) || 0) + by);

// The merge key for a firm name, or null for a placeholder. Legal suffixes, punctuation, spacing and
// spelling variants never split a firm.
export function firmKey(name, role = 'developer') {
  let s = clean(name);
  if (PLACEHOLDER.test(s)) return null;
  s = strip(s, LEGAL_SUFFIX);
  for (const [pattern, word] of SYNONYMS) s = s.replace(pattern, word);
  if (role === 'architect') s = strip(s, ARCHITECT_WORDS) || s;
  return s.replace(/ /g, '') || null;
}

// A person's name as a merge key, or null when it is initials, a placeholder or really a company.
export function personKey(first, last) {
  const f = clean(first), l = clean(last);
  if (f.replace(/ /g, '').length < 2 || l.replace(/ /g, '').length < 2 || PLACEHOLDER.test(f) || PLACEHOLDER.test(l)) return null;
  const name = `${f} ${l}`;
  return COMPANY_WORDS.test(name) ? null : name;
}

const titleCase = (name) => name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
const address = (f) => `${String(f.house_no ?? '').trim()} ${String(f.street_name ?? '').replace(/\s+/g, ' ').trim()}`.trim();

// The filings worth ranking: initial new-building filings for multifamily projects that were not
// withdrawn or abandoned.
export function projectFilings(rows, minUnits = MIN_UNITS) {
  return rows.filter((f) => /-I1$/.test(f.job_filing_number || '') && !DROPPED.has(f.filing_status) && num(f.proposed_dwelling_units) >= minUnits);
}

// Who a filing names for a role: the firm key, the person key, any other identifier, and the raw names.
function party(f, role) {
  if (role === 'developer') {
    if (PUBLIC_OWNERS.has(f.owner_type)) return null;
    return {firm: firmKey(f.owner_s_business_name, role), person: personKey(f.owner_first_name, f.owner_last_name), id: null,
      firmName: f.owner_s_business_name, personFirst: f.owner_first_name, personLast: f.owner_last_name};
  }
  if (role === 'architect') {
    if (f.applicant_professional_title !== 'RA') return null;
    const license = String(f.applicant_license ?? '').replace(/^0+/, '');
    return {firm: firmKey(f.applicant_business_name, role), person: personKey(f.applicant_first_name, f.applicant_last_name),
      id: license ? `RA${license}` : null, firmName: f.applicant_business_name, personFirst: f.applicant_first_name, personLast: f.applicant_last_name};
  }
  return {firm: firmKey(f.filing_representative_business_name, role), person: personKey(f.filing_representative_first_name, f.filing_representative_last_name),
    id: null, firmName: f.filing_representative_business_name, personFirst: f.filing_representative_first_name, personLast: f.filing_representative_last_name};
}

// Firms for one role, ranked by filings (one per lot), then units, then floor area. Filings that share
// a firm key, a person or a license belong to one firm. A business name that files for other owners as
// their representative is an expediter filling in the owner's form, so it never links developers.
export function rankFirms(rows, role, {minUnits = MIN_UNITS} = {}) {
  const filings = projectFilings(rows, minUnits);
  const expediters = new Set(role === 'developer' ? filings.map((f) => firmKey(f.filing_representative_business_name))
    .filter((rep, i) => rep && rep !== firmKey(filings[i].owner_s_business_name)) : []);
  const parent = new Map();
  const find = (x) => {while (parent.get(x) !== x) {parent.set(x, parent.get(parent.get(x))); x = parent.get(x);} return x;};
  const union = (a, b) => {parent.has(a) || parent.set(a, a); parent.has(b) || parent.set(b, b); parent.set(find(a), find(b));};
  const parties = [];
  for (const f of filings) {
    const p = party(f, role);
    if (!p) continue;
    if (expediters.has(p.firm)) p.firm = null;
    const nodes = [p.firm && `F:${p.firm}`, p.person && `P:${p.person}`, p.id && `L:${p.id}`].filter(Boolean);
    if (!nodes.length) continue;
    for (const node of nodes) union(nodes[0], node);
    parties.push([f, p, nodes[0]]);
  }
  const groups = new Map();
  for (const [f, p, node] of parties) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, {filings: new Map(), firms: new Map(), names: new Map(), people: new Map(), keys: new Map()});
    const g = groups.get(root), lot = f.bbl || `${f.borough}|${address(f)}`, seen = g.filings.get(lot);
    // A lot filed again (a refiling after a withdrawal or a new scheme) counts once, as its latest filing.
    if (!seen || String(f.filing_date) > String(seen.filing_date)) g.filings.set(lot, f);
    const raw = String(p.firmName ?? '').trim();
    if (p.firm) {tally(g.firms, raw); tally(g.keys, p.firm); if (!/^\d/.test(clean(raw))) tally(g.names, raw);}
    if (p.person) tally(g.people, titleCase(`${p.personFirst} ${p.personLast}`.replace(/[^\p{L}' -]+/gu, ' ').replace(/\s+/g, ' ').trim()));
  }
  const ranked = [...groups.values()].map((g) => {
    const list = [...g.filings.values()].sort((a, b) => String(b.filing_date).localeCompare(String(a.filing_date)));
    const boroughs = new Map();
    for (const f of list) tally(boroughs, f.borough);
    const people = top(g.people), person = people[0] || null;
    // Shown as: its most used firm name that is not a one-project address LLC, else its person.
    const name = top(g.names)[0] || person || top(g.firms)[0];
    return {role, key: top(g.keys)[0] || clean(person || name).replace(/ /g, ''), name, person, people, rawNames: top(g.firms),
      filings: list.length, units: list.reduce((s, f) => s + num(f.proposed_dwelling_units), 0),
      floorArea: Math.round(list.reduce((s, f) => s + num(f.total_construction_floor_area), 0)), boroughs: top(boroughs),
      firstFiling: list.at(-1).filing_date.slice(0, 10), lastFiling: list[0].filing_date.slice(0, 10),
      recent: list.slice(0, 3).map((f) => ({job: f.job_filing_number.replace(/-I1$/, ''), date: f.filing_date.slice(0, 10), address: address(f),
        borough: f.borough, units: num(f.proposed_dwelling_units), floorArea: Math.round(num(f.total_construction_floor_area)), status: f.filing_status}))};
  });
  ranked.sort((a, b) => b.filings - a.filings || b.units - a.units || b.floorArea - a.floorArea || a.name.localeCompare(b.name));
  return ranked.map((g, i) => ({rank: i + 1, ...g}));
}

const SEGMENTS = {developer: 'developers', architect: 'architects', expediter: 'expediters'};
const TITLES = {developer: null, architect: 'Registered architect', expediter: 'Filing representative'};

// A ranked firm as an Outreach CRM lead: named for its person when the filings name one, keyed by
// role and firm so a later pull updates it in place. No contact details: the filings carry none.
export function filingLead(group) {
  return {name: group.person || group.name, sourceRef: `${group.role}:${group.key}`, company: group.name, title: TITLES[group.role],
    borough: group.boroughs[0] || null,
    details: {segment: SEGMENTS[group.role], role: group.role, rank: group.rank, filings: group.filings, units: group.units,
      floorArea: group.floorArea, boroughs: group.boroughs, firstFiling: group.firstFiling, lastFiling: group.lastFiling,
      recentFilings: group.recent, rawNames: group.rawNames.slice(0, 20), people: group.people.slice(0, 10), dataset: DOB_NOW_FILINGS_URL}};
}

export function importPayload(groupsByRole, {developers = 100, architects = 50} = {}) {
  return {source: NB_FILINGS, contacts: [...groupsByRole.developer.slice(0, developers), ...groupsByRole.architect.slice(0, architects)].map(filingLead)};
}

const csvCell = (value) => {const s = Array.isArray(value) ? value.join('; ') : String(value ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;};
export function firmsCsv(groups) {
  const head = ['rank', 'name', 'person', 'filings', 'units', 'floor_area', 'boroughs', 'first_filing', 'last_filing', 'recent_filings', 'raw_names', 'people'];
  const rows = groups.map((g) => [g.rank, g.name, g.person, g.filings, g.units, g.floorArea, g.boroughs, g.firstFiling, g.lastFiling,
    g.recent.map((r) => `${r.date} ${r.address}, ${r.borough} (${r.units} units, ${r.job})`), g.rawNames, g.people]);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

// Initial new-building filings since a date, read page by page with a hard page limit.
export async function fetchNewBuildingFilings({since, fetchImpl = fetch, pageSize = 5000, maxPages = 10}) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(DOB_NOW_FILINGS_URL);
    url.searchParams.set('$select', FILING_FIELDS.join(','));
    url.searchParams.set('$where', `job_type='New Building' AND filing_date>='${since}' AND job_filing_number like '%-I1'`);
    url.searchParams.set('$order', 'job_filing_number');
    url.searchParams.set('$limit', String(pageSize));
    url.searchParams.set('$offset', String(page * pageSize));
    const res = await fetchImpl(url, {signal: AbortSignal.timeout(120000)});
    if (!res.ok) throw new Error(`DOB NOW filings request failed: ${res.status}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`More than ${maxPages * pageSize} filings since ${since}; raise maxPages.`);
}
