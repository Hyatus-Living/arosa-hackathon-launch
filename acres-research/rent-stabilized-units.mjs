import {requestSignal} from './execution-context.mjs';

// Rent-stabilized unit counts per tax lot. No agency publishes them; JustFix's nyc-doffer reads the
// "Housing-Rent Stabilization" line of each DOF statement of account, where the owner's count of
// units registered with HCR appears, and publishes one CSV per tax year (the file nycdb loads as
// rentstab_v2). A count is the owner's filing for that year, so it can lag or be missing.
export const RENT_STABILIZED_URL = 'https://s3.amazonaws.com/justfix-data/rentstab_counts_from_doffer_2024.csv';
export const RENT_STABILIZED_SOURCE = {
  name: 'Rent-stabilized unit counts from DOF statements of account (JustFix nyc-doffer)',
  url: RENT_STABILIZED_URL,
  basis: 'Units the owner registered with NYS Homes and Community Renewal, as stated on the "Housing-Rent Stabilization" line of the NYC Department of Finance statement of account for the tax year; compiled by JustFix (nyc-doffer) and redistributed by nycdb.',
};
export const RENT_STABILIZED_RESYNC_MS = 30 * 24 * 3600 * 1000;

// Rows of the CSV as {bbl, units, year, statementUrl}: the latest tax year with a stated count,
// since an owner files each year and the newest filing describes the building today.
export function parseRentStabilizedCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',').map(h => h.trim());
  const bblAt = header.indexOf('ucbbl');
  const years = header.filter(h => /^uc\d{4}$/.test(h)).map(h => Number(h.slice(2))).sort((a, b) => b - a);
  if (bblAt < 0 || !years.length) throw new Error('Rent-stabilized CSV has no ucbbl or ucYYYY columns.');
  const column = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const bbl = String(cells[bblAt] || '').trim();
    if (!/^[1-5]\d{9}$/.test(bbl)) continue;
    for (const year of years) {
      const raw = String(cells[column[`uc${year}`]] ?? '').trim();
      if (raw === '') continue;
      const units = Number(raw);
      if (!Number.isInteger(units) || units < 0) continue;
      const statementUrl = String(cells[column[`pdfsoa${year}`]] ?? '').trim() || null;
      rows.push({bbl, units, year, statementUrl});
      break;
    }
  }
  return {rows, years};
}

export async function defaultRentStabilizedFetcher() {
  const res = await fetch(RENT_STABILIZED_URL, {signal: requestSignal(180000)});
  if (!res.ok) throw new Error(`Rent-stabilized counts HTTP ${res.status}`);
  return parseRentStabilizedCsv(await res.text());
}
