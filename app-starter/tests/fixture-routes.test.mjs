// The plan page fixture stands in for the whole app, so screenshots and browser checks can reach every
// page with a deal feed, saved sites and conversations, and every dialog loads without an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {TIERS} from '../public/listing-filter-schema.js';
import {siteName, siteProgress} from '../public/core-model.js';

const NYC = {south: 40.49, north: 40.92, west: -74.26, east: -73.7};
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); });

async function startFixture(t, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['tests/plan-page-fixture/server.mjs'], {cwd: new URL('..', import.meta.url), env: {...process.env, PORT: String(port), ...env}, stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not start within 10 s')), 10000);
    child.stdout.on('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`fixture exited with code ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  // GET by default; a body makes it a JSON POST unless a method is given. The status must match (200 unless given).
  return async (path, {body, method = body ? 'POST' : 'GET', status = 200} = {}) => {
    const res = await fetch(base + path, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body && JSON.stringify(body)});
    const text = await res.text();
    assert.equal(res.status, status, `${method} ${path} answered ${res.status}: ${text.slice(0, 120)}`);
    if (status < 400) assert.doesNotMatch(text, /Not found\./, path);
    return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  };
}
const SHELL = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const BEST_DEAL_ORDER = ['great_deal', 'good_deal', 'unpriced_opportunity', 'fair_deal', 'full_price', 'unmatched_parcel'];

test('the fixture serves the app shell for every page', async (t) => {
  const get = await startFixture(t);
  for (const path of ['/', '/chat', '/listings/4964456219:for_sale', '/sites', '/sites/fx-plan', '/sites/fx-plan/plan', '/sites/fx-plan/report', '/whats-new', '/shared/fx-shared-link']) {
    assert.equal(await get(path), SHELL, path);
  }
});

test('the fixture feed has ten NYC deals with a pin each, a saved site and three conversations', async (t) => {
  const get = await startFixture(t);
  const {deals, total} = await get('/api/market-store/deals?offset=0&limit=20');
  assert.equal(total, 10);
  assert.equal(deals.length, 10);
  const {pins} = await get('/api/market-store/deals/pins?pins=true');
  assert.deepEqual(pins.id, deals.map((d) => d.id));
  pins.latitude.forEach((lat, i) => {
    const lng = pins.longitude[i];
    assert.ok(lat > NYC.south && lat < NYC.north && lng > NYC.west && lng < NYC.east, `${pins.id[i]} at ${lat},${lng}`);
  });
  for (const d of deals) assert.equal((await get(`/api/market-store/deals/${encodeURIComponent(d.id)}`)).deal.id, d.id);

  for (const path of ['/api/projects', '/api/projects?sitesOnly=true']) assert.ok((await get(path)).projects.some((p) => p.id === 'fx-plan'), path);
  const {conversations} = await get('/api/conversations');
  assert.equal(conversations.length, 3);
  const site = conversations.filter((c) => c.projectId === 'fx-plan');
  assert.equal(site.length, 1);
  const conversation = await get(`/api/conversations/${site[0].id}`);
  const cited = conversation.messages.find((m) => m.sources?.length);
  assert.ok(cited, 'the site conversation has an answer with sources');
  for (const s of cited.sources) assert.match(cited.text, new RegExp(`\\[${s.id}\\]`));
});

test('the dialogs the rail and the chat open all load', async (t) => {
  const get = await startFixture(t);
  const {conversations} = await get('/api/conversations');
  const site = conversations.find((c) => c.projectId === 'fx-plan');
  const {teams} = await get('/api/teams');
  assert.ok(teams.length >= 1);
  assert.ok((await get(`/api/teams/${teams[0].id}`)).members.length >= 1);
  const plan = await get('/api/plan');
  assert.equal(typeof plan.plan, 'string');
  await get('/api/wallet');
  assert.ok(Array.isArray((await get(`/api/conversations/${site.id}/members`)).members));
  assert.ok(Array.isArray((await get(`/api/conversations/${site.id}/links`)).links));
  const claim = await get('/api/shared/fx-shared-link');
  assert.ok(conversations.some((c) => c.id === claim.conversationId));
});

test('ADMIN=1 signs the fixture in as an admin', async (t) => {
  const [member, admin] = await Promise.all([startFixture(t), startFixture(t, {ADMIN: '1'})]);
  assert.equal((await member('/api/session')).isAdmin, false);
  assert.equal((await admin('/api/session')).isAdmin, true);
});

test('the fixture feed rates every listing in the tiers the app shows and covers each priced tier', async (t) => {
  const get = await startFixture(t);
  const tiers = TIERS.map(([id]) => id);
  const {deals} = await get('/api/market-store/deals?limit=100');
  const {pins} = await get('/api/market-store/deals/pins');
  for (const verdict of [...deals.map((d) => d.flashcardValuation.dealVerdict), ...pins.dealVerdict]) assert.ok(tiers.includes(verdict), verdict);
  for (const tier of ['great_deal', 'good_deal', 'fair_deal', 'full_price']) assert.ok(pins.dealVerdict.includes(tier), tier);
});

test('the fixture feed sorts and filters as the store does', async (t) => {
  const get = await startFixture(t);
  const best = await get('/api/market-store/deals?sortBy=best_deal&limit=100');
  const rank = best.deals.map((d) => [BEST_DEAL_ORDER.indexOf(d.flashcardValuation.dealVerdict), d.uapPricePerBuildableZfa]);
  rank.slice(1).forEach(([tier, price], i) => assert.ok(tier > rank[i][0] || (tier === rank[i][0] && price >= rank[i][1]), best.deals[i + 1].address));
  assert.deepEqual((await get('/api/market-store/deals/pins?sortBy=best_deal')).pins.id, best.deals.map((d) => d.id));

  const great = await get('/api/market-store/deals?dealVerdict=great_deal&limit=100');
  assert.ok(great.total > 0 && great.total < best.total);
  assert.equal(great.deals.length, great.total);
  assert.ok(great.deals.every((d) => d.flashcardValuation.dealVerdict === 'great_deal'));
  const cheap = await get('/api/market-store/deals?maxListPrice=2000000&styles=land&limit=100');
  assert.ok(cheap.total > 0 && cheap.deals.every((d) => d.listPrice <= 2_000_000 && d.style === 'land'));
  const roomy = await get('/api/market-store/deals?sortBy=unused_uap_zfa&limit=100');
  roomy.deals.slice(1).forEach((d, i) => assert.ok(d.unusedUapZfa <= roomy.deals[i].unusedUapZfa, d.address));

  const page = await get('/api/market-store/deals?offset=abc&limit=4');
  assert.deepEqual([page.offset, page.limit, page.deals.length, page.total], [0, 4, 4, 10]);
  assert.equal((await get('/api/market-store/deals?offset=8&limit=4')).deals.length, 2);
});

test('the seeded answers quote figures the feed shows', async (t) => {
  const get = await startFixture(t);
  const {deals} = await get('/api/market-store/deals?limit=100');
  const prices = new Set(deals.map((d) => d.uapPricePerBuildableZfa)), areas = new Set(deals.flatMap((d) => [d.unusedUapZfa, d.existingBldgAreaSqft]));
  for (const id of ['conv_fx_market', 'conv_fx_shared']) {
    const answer = (await get(`/api/conversations/${id}`)).messages.find((m) => m.role === 'assistant').text;
    // Every price but the question's own $150 bound, and every floor area.
    const quoted = [...answer.matchAll(/\$(\d+)\b(?! per)/g)].map(([, n]) => Number(n));
    const measured = [...answer.matchAll(/([\d,]+) (?:sq ft|in )/g)].map(([, n]) => Number(n.replaceAll(',', '')));
    assert.ok(quoted.length, id);
    for (const n of quoted) assert.ok(prices.has(n), `${id}: $${n}`);
    for (const n of measured) assert.ok(areas.has(n), `${id}: ${n} sq ft`);
  }
});

test('a saved site reads the same on its card and its page, and runs only while its own run is going', async (t) => {
  const get = await startFixture(t, {RESOLVE_MS: '20'});
  const [card] = (await get('/api/projects?sitesOnly=true')).projects;
  const state = await get(`/api/projects/${card.id}/state`);
  const schemes = await get(`/api/projects/${card.id}/schemes`);
  assert.equal(card.title, siteName(state));
  assert.equal(siteProgress(state).landPrice, schemes.basis.ask);
  assert.equal(card.running, null);

  const {id} = await get('/api/conversations', {body: {}, status: 201});
  await get(`/api/conversations/${id}/runs`, {body: {message: 'Underwrite 125 Shepherd Ave'}, status: 202});
  let sites;
  for (let i = 0; i < 50 && !(sites = (await get('/api/projects')).projects).some((p) => p.running); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sites.filter((p) => p.running).map((p) => p.id), ['fx-new']);
});

test('sharing and team actions work and fail as the service does', async (t) => {
  const get = await startFixture(t);
  const invited = await get('/api/conversations/conv_fx_plan/members', {body: {email: 'partner@example.com', role: 'viewer'}});
  assert.equal(invited.member.email, 'partner@example.com');
  const principal = encodeURIComponent(invited.member.principal);
  assert.equal((await get(`/api/conversations/conv_fx_plan/members/account/${principal}`, {method: 'PATCH', body: {role: 'participant'}})).member.role, 'participant');
  assert.deepEqual((await get('/api/conversations/conv_fx_plan/members', {body: {teamId: 'team_fx', role: 'viewer'}})).members.map((m) => m.principalType), ['account', 'team']);
  assert.equal((await get(`/api/conversations/conv_fx_plan/members/account/${principal}`, {method: 'DELETE'})).members.length, 1);
  const link = await get('/api/conversations/conv_fx_plan/links', {body: {}, status: 201});
  await get(`/api/conversations/conv_fx_plan/links/${link.token}`, {method: 'DELETE'});
  assert.ok((await get('/api/conversations/conv_fx_plan/links')).links.find((l) => l.token === link.token).revoked);
  await get(`/api/shared/${link.token}`, {status: 404});

  const team = await get('/api/teams', {body: {name: 'Brokers'}, status: 201});
  assert.equal(team.members.length, 1);
  const added = await get(`/api/teams/${team.id}/members`, {body: {email: 'broker@example.com'}});
  const broker = added.members.find((m) => m.email === 'broker@example.com');
  assert.equal(added.memberCount, 2);
  assert.equal((await get(`/api/teams/${team.id}/members/${encodeURIComponent(broker.account)}`, {method: 'DELETE'})).memberCount, 1);
  assert.equal((await get(`/api/teams/${team.id}`, {method: 'PATCH', body: {name: 'Brokerage'}})).name, 'Brokerage');
  await get(`/api/teams/${team.id}`, {method: 'DELETE'});
  assert.ok(!(await get('/api/teams')).teams.some((x) => x.id === team.id));

  assert.deepEqual((await get('/api/people?q=dana')).people.map((p) => p.email), ['dana@example.com']);
  await get('/api/conversations/nope/links', {body: {}, status: 404});
  await get('/api/conversations/nope/members', {status: 404});
  await get('/api/conversations/conv_fx_shared/members', {status: 403});
  await get('/api/conversations/conv_fx_plan/members', {body: {email: 'x@example.com', role: 'owner'}, status: 400});
  await get('/api/teams', {body: {name: ' '}, status: 400});
  await get('/api/teams/team_fx/members/fixture', {method: 'DELETE', status: 400});
  await get('/api/teams/nope', {status: 404});
});
