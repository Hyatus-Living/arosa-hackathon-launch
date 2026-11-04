// UI preview only: serves app-starter/public with a mock of the Arosa API so every page, dialog and
// state can be opened and screenshotted without the research service or a sign-in. Never deploy it.
// Usage: node scripts/ui-preview/server.mjs [publicDir] [port]   (defaults: app-starter/public, 8090)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullState } from '../../app-starter/tests/fixtures/project-state.mjs';
import { projects } from '../../app-starter/tests/fixtures/projects.mjs';
import { budgetSplitOptions } from '../../acres-research/budget-lines.mjs';
// Synthetic underwriting example; no saved customer project is included.
const winthrop = JSON.parse(fs.readFileSync(new URL('../../app-starter/tests/fixtures/report-winthrop.json', import.meta.url), 'utf8'));

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '../../app-starter/public'));
const port = Number(process.argv[3] || 8090);
const T = Date.UTC(2026, 9, 17, 15, 0);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };

const answer = `**120 Broadway** sits in a **C5-5** district inside the Special Lower Manhattan District. The lot is about **52,000 SF** and the existing Equitable Building is built well past today's base FAR, so additional as-of-right floor area is unlikely.\n\n| Scenario | FAR | Floor area |\n|---|---|---|\n| Built today | 21.6 | ~1.12M SF |\n| Base commercial | 15.0 | ~780K SF |\n| With plaza bonus | 18.0 | ~936K SF |\n\nThe realistic paths are an **interior conversion** under the 2024 City of Yes rules, or a transfer of development rights to a neighbouring lot. Both need confirmation with DCP before any underwriting [1][2].`;
const conversations = [
  { id: 'c1', title: '120 Broadway headroom', updated: T, projectId: 'p_fulton', access: 'owner', memberCount: 0 },
  { id: 'c2', title: 'Brooklyn deals under $3M', updated: T - 3600e3, access: 'owner', memberCount: 0 },
  { id: 'c3', title: 'Austin duplex lot split', updated: T - 86400e3, access: 'owner', memberCount: 0 },
  { id: 'c4', title: 'Crown Heights R7A comparison', updated: T - 2 * 86400e3, access: 'participant', memberCount: 2, owner: { account: 'x', name: 'Alex Kim' } },
  { id: 'c6', title: 'Fulton St massing', updated: T + 1, access: 'owner', memberCount: 0 },
  { id: 'c5', title: 'Portland ADU options', updated: T - 5 * 86400e3, access: 'owner', memberCount: 0 },
  { id: 'c_winthrop', title: winthrop.conversation.title, updated: T - 6 * 86400e3, projectId: 'p_winthrop', access: 'owner', memberCount: 0 },
];
const conversation = (id) => id === 'c6' ? ({ id, title: 'Fulton St massing', access: 'owner', owner: { account: 'acct1', name: 'Michael Ort' }, members: [], projectId: null,
  runs: [{ id: 'r2', status: 'running', owner: 'acct1', input: 'Model the as-of-right massing for 1234 Fulton Street and compare it with UAP.', created: T }],
  messages: [] }) : ({
  id, title: conversations.find((c) => c.id === id)?.title || 'New conversation', access: 'owner', owner: { account: 'acct1', name: 'Michael Ort' }, members: [],
  runs: [{ id: 'r1', status: 'completed', owner: 'acct1', created: T }],
  projectId: id === 'c1' ? 'p_fulton' : null,
  property: { address: '120 Broadway, Manhattan', bbl: '1000477501', borough: 'MN', zonedist1: 'C5-5', zonedist2: '', overlay1: '', spdist1: 'LM', lotarea: 52000, bldgarea: 1120000, landmark: 'EQUITABLE BUILDING', histdist: '', version: '25v2' },
  messages: [
    { id: 'm1', role: 'user', text: 'How much additional floor area could 120 Broadway in Manhattan support?', runId: 'r1', author: 'acct1', created: T },
    { id: 'm2', role: 'assistant', text: answer, runId: 'r1', traceId: 'r1', durationMs: 64000, created: T + 60e3,
      ui: [{ initialHeight: 180, cssComplete: true, htmlComplete: true,
        css: '.fa{display:grid;gap:12px;padding:18px;font-size:13px}.fa h3{margin:0;font-size:14px}.fa label{display:flex;justify-content:space-between;color:var(--ink-muted)}.fa input{width:100%}.fa output{font-size:22px;font-weight:600}.fa .row{display:flex;gap:8px}.fa .cell{flex:1;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2)}',
        html: ['<div class="fa"><h3>Floor area by FAR</h3><label>FAR <span id="v">15.0</span></label><input id="r" type="range" min="10" max="21.6" step="0.1" value="15"><div class="row"><div class="cell">Lot<br><strong>52,000 SF</strong></div><div class="cell">Floor area<br><output id="o">780,000 SF</output></div></div></div>'],
        jsExpressions: ["document.getElementById('r').addEventListener('input',function(e){var f=Number(e.target.value);document.getElementById('v').textContent=f.toFixed(1);document.getElementById('o').textContent=Math.round(f*52000).toLocaleString()+' SF';})"] }],
      sources: [
        { id: 1, title: 'NYC Zoning Resolution 33-12', url: 'https://zr.planning.nyc.gov/article-iii/chapter-3/33-12', kind: 'zoning', retrievedAt: '2026-10-17T14:58:00Z' },
        { id: 2, title: 'NYC MapPLUTO 25v2', url: 'https://data.cityofnewyork.us/resource/64uk-42ks.json', kind: 'property', retrievedAt: '2026-10-17T14:58:00Z' },
      ] },
  ],
});
const streets = ['Fulton St', 'Atlantic Ave', 'Nostrand Ave', 'Myrtle Ave', 'Broadway', 'Flatbush Ave', 'Bedford Ave', 'Court St', 'Grand St', 'Steinway St', 'Jamaica Ave', 'Arthur Ave'];
const hoods = [['BK', 'Bed-Stuy', '11216'], ['BK', 'Crown Heights', '11225'], ['QN', 'Astoria', '11103'], ['BX', 'Belmont', '10458'], ['MN', 'Harlem', '10027'], ['BK', 'Bushwick', '11221']];
const verdicts = ['great_deal', 'good_deal', 'good_deal', 'fair_deal', 'full_price', 'unpriced_opportunity'];
const deals = Array.from({ length: 24 }, (_, i) => {
  const [borough, neighborhood, zip] = hoods[i % hoods.length];
  const price = i % 6 === 5 ? null : 900000 + ((i * 377) % 40) * 95000;
  const lot = 2000 + ((i * 131) % 20) * 250;
  return {
    id: 'd' + i, address: `${100 + i * 17} ${streets[i % streets.length]}`, borough, neighborhood, zipCode: zip, bbl: String(3000000000 + i * 1013),
    zoningDistrict: ['R6A', 'R7A', 'C4-4D', 'R6B', 'M1-4/R7A', 'R7D'][i % 6], style: ['multi_family', 'mixed_use', 'land', 'single_family'][i % 4],
    listPrice: price, lotAreaSqft: lot, existingBldgAreaSqft: lot * 0.8, builtFar: 0.8, residFar: 3, maxStandardZfa: lot * 3, maxUapZfa: lot * 3.9, unusedUapZfa: lot * 3.1,
    pricePerBuildableZfa: price ? Math.round(price / (lot * 3.9)) : null,
    flashcardValuation: { dealVerdict: verdicts[i % verdicts.length], impliedYieldOnCostPct: 5 + (i % 5), impliedCondoMarginPct: 8 + (i % 7) * 3 },
    latitude: 40.64 + ((i * 37) % 30) / 150, longitude: -74.0 + ((i * 53) % 30) / 120,
    url: 'https://example.com/listing/' + i,
  };
});
const pins = { id: deals.map((d) => d.id), address: deals.map((d) => d.address), latitude: deals.map((d) => d.latitude), longitude: deals.map((d) => d.longitude), dealVerdict: deals.map((d) => d.flashcardValuation.dealVerdict), listPrice: deals.map((d) => d.listPrice) };

function api(req, url) {
  const p = url.pathname.replace(/^\/api/, '');
  if (p === '/session') return { namespace: 'acct1', email: 'michael@witharosa.ai', isAdmin: true, architectureEnabled: true };
  if (p === '/people/me') return { account: 'acct1', email: 'michael@witharosa.ai', name: 'Michael Ort' };
  if (p === '/conversations' && req.method === 'GET') return { conversations: url.searchParams.get('q') ? conversations.slice(0, 2) : conversations };
  if (p === '/conversations' && req.method === 'POST') return { id: 'c-new', title: 'New conversation', messages: [], runs: [] };
  const conv = p.match(/^\/conversations\/([^/]+)$/);
  if (conv) return conv[1] === 'c_winthrop' ? winthrop.conversation : conversation(conv[1]);
  if (/^\/conversations\/[^/]+\/members$/.test(p)) return { members: [{ principalType: 'account', principal: 'acct2', name: 'Alex Kim', email: 'alex@witharosa.ai', role: 'participant' }, { principalType: 'team', principal: 't1', name: 'Acquisitions', role: 'viewer' }] };
  if (/^\/conversations\/[^/]+\/links$/.test(p)) return { links: [{ id: 'l1', token: 'abc123', role: 'viewer', created: T }] };
  if (p === '/projects') return { projects: [...projects, { id: 'p_winthrop', siteKey: winthrop.project.siteKey, bbl: winthrop.project.bbl, title: 'Synthetic housing feasibility example', owner: winthrop.project.owner, access: 'owner', version: 1, conversationCount: 1, updated: T - 6 * 86400e3 }], nextCursor: null };
  if (p === '/projects/p_winthrop/state') return winthrop.project;
  if (/^\/projects\/[^/]+\/state$/.test(p)) return fullState;
  if (/^\/projects\/[^/]+\/architecture$/.test(p)) return { revision: 0, plan: null, jobs: [] };
  if (p === '/market-store/status') return { ok: true, listings: deals.length };
  if (p === '/market-store/user-settings' && req.method === 'PUT') return { dealSettings: {}, isCustom: true, costsConfirmed: true, budgetSplits: null, budgetSplitOptions: budgetSplitOptions() };
  if (p === '/market-store/user-settings') return { dealSettings: { hardCostPerGrossSqft: 450, softCostPctOfHard: 0.25, carryAndFinancingPct: 0.1, zfaToGrossFactor: 1.15 }, isCustom: false,
    // PREVIEW_ONBOARDING=1 shows the first-run cost setup.
    costsConfirmed: process.env.PREVIEW_ONBOARDING !== '1', budgetSplits: null, budgetSplitOptions: budgetSplitOptions(),
    baselineSettings: { hardCostPerGrossSqft: 375, softCostPctOfHard: 0.22, carryAndFinancingPct: 0.1, zfaToGrossFactor: 1.15, zfaToNetEfficiency: 0.85, operatingExpenseRatio: 0.3,
      greatDealCapRate: 0.085, goodDealCapRate: 0.0725, badDealCapRate: 0.06, greatDealCondoMargin: 0.28, goodDealCondoMargin: 0.18, badDealCondoMargin: 0.1 } };
  if (p === '/market-store/deals/pins') return { pins };
  const one = p.match(/^\/market-store\/deals\/([^/?]+)$/);
  if (one) return { deal: { ...(deals.find((d) => d.id === one[1]) || deals[0]), similarComps: [{ address: '210 Fulton St', soldPrice: 1850000, pricePerSqft: 410 }] }, userSettings: { dealSettings: { hardCostPerGrossSqft: 450, softCostPctOfHard: 0.25, carryAndFinancingPct: 0.1, zfaToGrossFactor: 1.15 }, isCustom: false } };
  if (p === '/market-store/deals') {
    const offset = Number(url.searchParams.get('offset') || 0);
    return { deals: deals.slice(offset, offset + 12), total: 240, userSettings: api({ method: 'GET' }, new URL('http://x/api/market-store/user-settings')) };
  }
  if (p === '/runs') return { runs: [] };
  if (p === '/teams') return { teams: [{ id: 't1', name: 'Acquisitions', memberCount: 4, role: 'owner' }] };
  if (p.startsWith('/teams/')) return { team: { id: 't1', name: 'Acquisitions', members: [] }, members: [] };
  // PREVIEW_PLAN picks the plan (free, limit, pro or team); PREVIEW_WALLET=off matches a deployment without credit billing.
  if (p === '/plan') {
    const base = { plan: 'free', used: 7, limit: 10, resetsAt: Date.UTC(2026, 10, 1), subscription: null, manageable: false, checkoutAvailable: true, prices: { month: { amount: 100 }, year: { amount: 600 } } };
    return {
      free: base,
      limit: { ...base, used: 10 },
      pro: { ...base, plan: 'pro', used: 37, limit: null, manageable: true, subscription: { status: 'active', interval: 'year', currentPeriodEnd: Date.UTC(2027, 9, 20, 15), cancelAtPeriodEnd: false } },
      team: { ...base, plan: 'team', used: 109, limit: null },
    }[process.env.PREVIEW_PLAN || 'free'];
  }
  if (p === '/wallet' && process.env.PREVIEW_WALLET === 'off') return { enabled: false, checkoutAvailable: false, currency: 'USD', entries: [] };
  if (p === '/wallet') return { enabled: true, availableMicros: 42500000, heldMicros: 1200000, balanceMicros: 43700000, checkoutAvailable: true,
    policy: { rates: { openai: { mode: 'estimated_tokens', inputMicrosPerMillion: 1250000, cachedInputMicrosPerMillion: 125000, outputMicrosPerMillion: 10000000, reserveMicros: 500000, basis: 'List price', version: '2026-10' } } },
    entries: [
      { kind: 'usage', provider: 'openai', operation: 'research', deltaMicros: -820000, at: T, estimated: true, basis: 'token estimate', runId: 'r1aaaaaaaa' },
      { kind: 'reserve', reservedMicros: 1200000, at: T - 60e3, runId: 'r2bbbbbbbb' },
      { kind: 'topup', deltaMicros: 50000000, at: T - 86400e3 } ] };
  if (p === '/admin/market-store') return { totalListings: 18234, activeForSale: 9120, closedSold: 7800, activeRentals: 1314, plutoMatchedParcels: 15022, highPotentialDeals: 612, submarketRollups: 180, lastIngestedAt: T - 3600e3,
    adminConfig: { syncConfig: { locations: ['Brooklyn, NY', 'Queens, NY'], maxPages: 5 }, dealSettings: { hardCostPerGrossSqft: 450 } },
    recentSyncs: [{ status: 'completed', locations: ['Brooklyn, NY'], startedAt: T - 3600e3, finishedAt: T - 3000e3, listings: 812 }] };
  if (/^\/runs\/r1$/.test(p)) return { id: 'r1', created: T, updated: T + 64000, status: 'completed', events: [
    { event: 'status', status: 'Resolving the jurisdiction', time: T },
    { event: 'tool.started', tool: 'acres_find_property', arguments: { address: '120 Broadway' }, time: T + 1000 },
    { event: 'tool.completed', tool: 'acres_find_property', success: true, time: T + 4000 },
    { event: 'tool.started', tool: 'acres_fetch_url', arguments: { url: 'https://zr.planning.nyc.gov/article-iii/chapter-3/33-12' }, time: T + 5000 },
    { event: 'tool.completed', tool: 'acres_fetch_url', success: true, time: T + 20000 },
    { event: 'tool.started', tool: 'acres_fanout_search', arguments: { query: 'City of Yes office conversion' }, time: T + 21000 },
    { event: 'tool.completed', tool: 'acres_fanout_search', success: true, time: T + 40000 },
    { event: 'tool.started', tool: 'acres_execute_capability', arguments: { name: 'acres_zoning_envelope', arguments: { district: 'C5-5' } }, time: T + 41000 },
    { event: 'tool.completed', tool: 'acres_execute_capability', success: true, time: T + 50000 } ] };
  if (p.startsWith('/people')) return { people: [] };
  return {};
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/runs/r2/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const evs = [
        { event: 'status', status: 'Reading the parcel record' },
        { event: 'tool.started', tool: 'acres_find_property', arguments: { address: '1234 Fulton Street' } },
        { event: 'tool.completed', tool: 'acres_find_property', success: true },
        { event: 'tool.started', tool: 'acres_zoning_envelope', arguments: { district: 'R7A' } },
        { event: 'message.started', id: 'lm1', phase: 'final' },
        { event: 'message.delta', id: 'lm1', phase: 'final', delta: 'The R7A envelope allows a **4.0 FAR** base, or **5.01 FAR** with UAP. On a 5,000 SF lot that is ' },
        { event: 'message.delta', id: 'lm1', phase: 'final', delta: '20,000 SF as of right, rising to about 25,050 SF with qualifying affordable housing.' },
      ];
      evs.forEach((e, i) => setTimeout(() => res.write(`data: ${JSON.stringify({ seq: i + 1, ...e })}\n\n`), 50 * i));
      return;
    }
    if (url.pathname.endsWith('/events')) { res.writeHead(204); return res.end(); }
    const out = JSON.stringify(api(req, url));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(out);
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('preview on', port, root));
