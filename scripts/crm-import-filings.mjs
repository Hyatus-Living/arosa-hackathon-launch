// Builds the Outreach CRM target list from DOB NOW new-building filings: pulls (or reuses a cached pull
// of) the initial filings since a date, ranks developers, architects of record and expediters, writes
// one CSV per role plus the import payload, and with --post sends the payload to the research
// service's admin import.
//   node scripts/crm-import-filings.mjs --since 2023-10-01 --out <dir> [--cache <file>] [--developers 100] [--architects 50]
//     [--post http://10.42.0.2:18800]   (reads RESEARCH_TOKEN, ACRES_ACCOUNT and ACRES_EMAIL from the environment)
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {FILING_ROLES, fetchNewBuildingFilings, firmsCsv, importPayload, rankFirms} from '../acres-research/crm-filings.mjs';

const {values: args} = parseArgs({options: {since: {type: 'string'}, out: {type: 'string'}, cache: {type: 'string'},
  developers: {type: 'string', default: '100'}, architects: {type: 'string', default: '50'}, post: {type: 'string'}}});
if (!args.since || !args.out) throw new Error('Pass --since YYYY-MM-DD and --out <dir>.');
mkdirSync(args.out, {recursive: true});

const cache = args.cache || join(args.out, `nb-filings-since-${args.since}.json`);
const rows = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : await fetchNewBuildingFilings({since: args.since});
if (!existsSync(cache)) writeFileSync(cache, JSON.stringify(rows));

const ranked = Object.fromEntries(FILING_ROLES.map((role) => [role, rankFirms(rows, role)]));
for (const role of FILING_ROLES) writeFileSync(join(args.out, `${role}s.csv`), firmsCsv(ranked[role]));
const payload = importPayload(ranked, {developers: Number(args.developers), architects: Number(args.architects)});
writeFileSync(join(args.out, 'crm-import.json'), JSON.stringify(payload, null, 2));
console.log(JSON.stringify({filings: rows.length, ...Object.fromEntries(FILING_ROLES.map((role) => [`${role}s`, ranked[role].length])), contacts: payload.contacts.length}));

// The research API takes request bodies up to 60 KB, so contacts go in batches of 40.
if (args.post) {
  for (let i = 0; i < payload.contacts.length; i += 40) {
    const res = await fetch(new URL('/admin/crm/import', args.post), {method: 'POST', body: JSON.stringify({...payload, contacts: payload.contacts.slice(i, i + 40)}),
      headers: {'content-type': 'application/json', authorization: `Bearer ${process.env.RESEARCH_TOKEN}`, 'x-acres-account': process.env.ACRES_ACCOUNT, 'x-acres-email': process.env.ACRES_EMAIL}});
    console.log(res.status, await res.text());
    if (!res.ok) process.exit(1);
  }
}
