import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {AlertStore, nextDigestAt, DIGEST_HOUR_UTC} from './alerts.mjs';
import {createMailer} from './alert-mailer.mjs';
import {createAlertSweep} from './alert-runner.mjs';
import {listingMatches, scanListings} from './alert-sources.mjs';
import {priceFixture} from './testing/comparable-price.mjs';
import {MarketStore} from './market-store.mjs';
import {createAlertTools} from './alert-tools.mjs';
import {createResearchServer} from './service.mjs';
import {readFileSync} from 'node:fs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acres-alerts-'));
  const store = new ChatStore(join(dir, 'chat.sqlite'));
  const alerts = new AlertStore(store);
  store.touchPerson('owner', 'owner@example.com');
  store.touchPerson('collab', 'collab@example.com');
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {store, alerts};
}

// A deal-store stand-in for listing scans: rows as stored, valued as the store values a listing (its card's
// tier, price per buildable SF and unused floor area), and no saved costs for any account.
const fakeMarket = rows => ({
  query: (sql, since) => rows().filter(r => r.listing_type === 'for_sale' && r.first_seen_at > since),
  getUserDealSettings: () => ({isCustom: false}),
  searchDeals: ({listingId}) => rows().filter(r => r.id === listingId).map(r => ({flashcardValuation: {dealVerdict: r.deal_verdict}, pricePerBuildableSf: r.uap_price_per_buildable_zfa, unusedForLeadZfa: r.unused_uap_zfa})),
  close() {},
});

function capturingMailer() {
  const sent = [];
  return {configured: true, sent, send: async msg => { sent.push(msg); return {id: 'test'}; }};
}

function finishRun(store, account, conversationId, status = 'completed') {
  const run = store.createRun(account, conversationId, 'question');
  store.begin(run);
  store.finish(run, status, status === 'completed' ? {answer: 'done', sources: []} : null, status === 'failed' ? 'boom' : null);
  return run;
}

test('rules validate, isolate per account, and round-trip criteria', t => {
  const {alerts} = fixture(t);
  const rule = alerts.create('owner', {kind: 'listings', cadence: 'daily', criteria: {borough: 'BK', dealVerdict: 'great_deal,good_deal', maxListPrice: 5000000}});
  assert.equal(rule.kind, 'listings');
  assert.equal(rule.criteria.borough, 'BK');
  assert.equal(alerts.list('collab').length, 0, 'another account must not see the rule');
  assert.equal(alerts.get('collab', rule.id), undefined);
  assert.throws(() => alerts.create('owner', {kind: 'everything'}), /kind must be one of/);
  assert.throws(() => alerts.create('owner', {kind: 'listings', projectId: 'x'}), /not tied to a project/);
  assert.throws(() => alerts.create('owner', {kind: 'listings', criteria: {bogus: 1}}), /Unknown listing criterion/);
  assert.throws(() => alerts.create('owner', {kind: 'listings', criteria: {mihArea: 'yes'}}), /mihArea must be inside or outside/);
  assert.throws(() => alerts.create('owner', {kind: 'listings', criteria: {borough: 'Atlantis'}}), /criteria\.borough must be one of/);
  const named = alerts.create('owner', {kind: 'listings', criteria: {borough: 'Queens'}});
  assert.equal(named.criteria.borough, 'QN', 'borough names are stored as their filter code');
  alerts.remove('owner', named.id);
  const mihRule = alerts.create('owner', {kind: 'listings', criteria: {mihArea: 'inside'}});
  assert.equal(mihRule.criteria.mihArea, 'inside');
  alerts.remove('owner', mihRule.id);
  assert.throws(() => alerts.create('owner', {kind: 'listings', criteria: {minListPrice: 9, maxListPrice: 1}}), /cannot exceed/);
  const updated = alerts.update('owner', rule.id, {cadence: 'instant', paused: true});
  assert.equal(updated.cadence, 'instant');
  assert.equal(updated.paused, true);
  assert.throws(() => alerts.update('collab', rule.id, {paused: false}), /not found/);
  alerts.remove('owner', rule.id);
  assert.equal(alerts.list('owner').length, 0);
});

test('an identical rule is refused, however its criteria are ordered, and so is an edit that would copy one', t => {
  const {alerts} = fixture(t);
  const rule = alerts.create('owner', {kind: 'listings', criteria: {borough: 'Brooklyn', styles: ['land', 'multi_family'], maxListPrice: 5000000}});
  assert.throws(() => alerts.create('owner', {kind: 'listings', criteria: {maxListPrice: 5000000, styles: ['multi_family', 'land'], borough: 'Brooklyn'}}),
    e => e.status === 409 && e.message.includes(rule.id));
  const daily = alerts.create('owner', {kind: 'listings', cadence: 'daily', criteria: {borough: 'Brooklyn', styles: ['land', 'multi_family'], maxListPrice: 5000000}});
  assert.equal(alerts.create('collab', {kind: 'listings', criteria: rule.criteria}).kind, 'listings', 'another account may hold the same rule');
  assert.throws(() => alerts.update('owner', daily.id, {cadence: 'instant'}), e => e.status === 409);
  alerts.create('owner', {kind: 'finished'});
  assert.throws(() => alerts.create('owner', {kind: 'finished', cadence: 'instant'}), /already have this alert/);
  assert.equal(alerts.list('owner').length, 3);
});

test('instant and daily rules on one event each deliver once, and overlapping listing rules send one email', async t => {
  const {store, alerts} = fixture(t);
  const conv = store.createConversation('owner');
  alerts.create('owner', {kind: 'finished', cadence: 'instant'});
  alerts.create('owner', {kind: 'finished', cadence: 'daily'});
  const mailer = capturingMailer();
  const now = Date.UTC(2026, 9, 18, 10, 0);
  const row = {listing_type: 'for_sale', borough: 'Brooklyn', zip_code: '11215', style: 'multi_family', list_price: 2000000, unused_uap_zfa: 8000,
    uap_price_per_buildable_zfa: 250, deal_verdict: 'great_deal', landmark_flag: 0, address: '2 Test St', id: 'new-1', first_seen_at: Date.now() + 1000};
  const market = fakeMarket(() => [row]);
  alerts.create('owner', {kind: 'listings', criteria: {borough: 'Brooklyn'}});
  alerts.create('owner', {kind: 'listings', criteria: {zipCode: '11215'}});
  const sweep = createAlertSweep({store, alerts, mailer, openMarket: async () => market, appUrl: 'https://app.example'});
  finishRun(store, 'owner', conv.id);
  await sweep(now);
  assert.deepEqual(mailer.sent.map(m => m.subject).sort(), ['New listing match: 2 Test St', 'Research run finished: question']);
  await sweep(Date.UTC(2026, 9, 18, DIGEST_HOUR_UTC, 5));
  assert.equal(mailer.sent.length, 3);
  assert.match(mailer.sent[2].subject, /daily digest \(1\)/);
  assert.match(mailer.sent[2].text, /Research run finished/);
});

test('every alert email carries a signed stop link that pauses its rule without a sign-in', async t => {
  const {store, alerts} = fixture(t);
  const conv = store.createConversation('owner');
  const rule = alerts.create('owner', {kind: 'finished'});
  const daily = alerts.create('owner', {kind: 'activity', cadence: 'daily'});
  const mailer = capturingMailer();
  const sweep = createAlertSweep({store, alerts, mailer, appUrl: 'https://app.example'});
  finishRun(store, 'owner', conv.id);
  await sweep();
  const link = new URL(mailer.sent[0].unsubscribeUrl);
  assert.equal(link.origin + link.pathname, 'https://app.example/api/public/alerts/unsubscribe');
  assert.ok(mailer.sent[0].text.includes(`stop this alert: ${link.href}`));
  const token = link.searchParams.get('token');
  assert.throws(() => alerts.unsubscribe(token.slice(0, -2) + 'xx'), e => e.status === 404);
  assert.throws(() => alerts.unsubscribe(alerts.unsubscribeToken('collab', rule.id).split('.')[0] + '.' + token.split('.')[1]), e => e.status === 404, 'a token cannot be re-pointed at another account');
  const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'test'}, store, execute: async () => ({answer: 'x', sources: []})});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/alerts/unsubscribe`, {method: 'POST', headers: {authorization: 'Bearer test', 'content-type': 'application/json'}, body: JSON.stringify(body)});
  assert.deepEqual(await (await post({token})).json(), {stopped: 'rule', kind: 'finished'});
  assert.deepEqual(await (await post({token})).json(), {stopped: 'rule', kind: 'finished'}, 'following the link again is harmless');
  assert.equal((await post({token: 'forged.token'})).status, 404);
  assert.equal(alerts.get('owner', rule.id).paused, true);
  assert.equal(alerts.get('owner', daily.id).paused, false, 'only the linked rule stops');
  finishRun(store, 'owner', conv.id);
  assert.equal((await sweep()).sent, 0);
  assert.deepEqual(alerts.unsubscribe(alerts.unsubscribeToken('owner', null)), {stopped: 'all'});
  assert.equal(alerts.prefs('owner').enabled, false);
  const web = readFileSync(new URL('../app-starter/server.js', import.meta.url), 'utf8');
  assert.ok(web.indexOf("app.post('/api/public/alerts/unsubscribe'") < web.indexOf("app.use('/api',authenticate)"), 'the stop link works without a sign-in');
});

test('nextDigestAt lands on the next digest hour', () => {
  const before = Date.UTC(2026, 9, 18, DIGEST_HOUR_UTC - 1, 30);
  assert.equal(nextDigestAt(before), Date.UTC(2026, 9, 18, DIGEST_HOUR_UTC));
  const after = Date.UTC(2026, 9, 18, DIGEST_HOUR_UTC + 1, 0);
  assert.equal(nextDigestAt(after), Date.UTC(2026, 9, 19, DIGEST_HOUR_UTC));
});

test('a finished run emails its owner once, and only with a matching rule', async t => {
  const {store, alerts} = fixture(t);
  const conv = store.createConversation('owner');
  alerts.create('owner', {kind: 'finished', cadence: 'instant'});
  const mailer = capturingMailer();
  const sweep = createAlertSweep({store, alerts, mailer, appUrl: 'https://app.example'});
  finishRun(store, 'owner', conv.id);
  const stats = await sweep();
  assert.equal(stats.sent, 1);
  assert.equal(mailer.sent[0].to, 'owner@example.com');
  assert.match(mailer.sent[0].subject, /Research run finished/);
  const again = await sweep();
  assert.equal(again.sent, 0, 'watermark + dedupe must prevent a resend');
  finishRun(store, 'collab', store.createConversation('collab').id);
  const third = await sweep();
  assert.equal(third.sent, 0, 'accounts without a rule receive nothing');
});

test('master switch and pause silence delivery without deleting rules', async t => {
  const {store, alerts} = fixture(t);
  const conv = store.createConversation('owner');
  const rule = alerts.create('owner', {kind: 'finished'});
  alerts.setEnabled('owner', false);
  const mailer = capturingMailer();
  const sweep = createAlertSweep({store, alerts, mailer, appUrl: 'https://app.example'});
  finishRun(store, 'owner', conv.id);
  assert.equal((await sweep()).sent, 0);
  alerts.setEnabled('owner', true);
  alerts.update('owner', rule.id, {paused: true});
  finishRun(store, 'owner', conv.id);
  assert.equal((await sweep()).sent, 0);
  assert.equal(alerts.list('owner').length, 1, 'the rule survives pause and master-off');
});

test('collaborator activity alerts other members, never the actor; a render finish splits finished vs activity', async t => {
  const {store, alerts} = fixture(t);
  const conv = store.createConversation('owner');
  store.grantMember('owner', conv.id, 'account', 'collab', 'participant');
  const projectId = conv.projectId;
  alerts.create('owner', {kind: 'activity'});
  alerts.create('collab', {kind: 'activity'});
  alerts.create('collab', {kind: 'finished'});
  const mailer = capturingMailer();
  const sweep = createAlertSweep({store, alerts, mailer, appUrl: 'https://app.example'});

  store.appendProjectEvent(projectId, 'state.updated', {projectId, keys: ['assumptions'], account: 'collab'});
  let stats = await sweep();
  assert.equal(stats.sent, 1, 'only the owner is alerted about the collaborator edit');
  assert.equal(mailer.sent[0].to, 'owner@example.com');
  assert.match(mailer.sent[0].subject, /Site updated/);

  store.write('INSERT INTO architecture_jobs(job_id,project,revision,status,reason,input_hash,pipeline_version,settings_hash,settings,created_by,created_at,started_at,finished_at,job_dir,pid,artifacts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'job-1', projectId, 3, 'succeeded', null, 'hash', '1', 'shash', '{}', 'collab', Date.now(), Date.now(), Date.now(), '/tmp/job', null, '[]');
  store.appendProjectEvent(projectId, 'architecture.job', {projectId, jobId: 'job-1', revision: 3, status: 'succeeded'});
  const beforeSecondSweep = mailer.sent.length;
  stats = await sweep();
  assert.equal(stats.sent, 2, 'render creator (finished) and owner (activity) each get one email');
  const to = mailer.sent.slice(beforeSecondSweep).map(m => m.to).sort();
  assert.deepEqual(to, ['collab@example.com', 'owner@example.com']);
});

test('a drawing event resolves its actor from architecture_drawings and alerts the other members', async t => {
  const {store, alerts} = fixture(t);
  const {Drawings} = await import('./architecture-drawings.mjs').catch(() => ({}));
  if (!Drawings) return; // table is created by the Drawings class in service runs
  const conv = store.createConversation('owner');
  store.grantMember('owner', conv.id, 'account', 'collab', 'participant');
  const drawings = new Drawings(store, {stateDir: '/tmp'});
  void drawings;
  store.write('INSERT INTO architecture_drawings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'draw-1', conv.projectId, 'plan.pdf', 'pdf', 'application/pdf', 10, 'sha', '/tmp/plan.pdf', null, null, 'collab', 'user', Date.now());
  alerts.create('owner', {kind: 'activity'});
  alerts.create('collab', {kind: 'activity'});
  const mailer = capturingMailer();
  const sweep = createAlertSweep({store, alerts, mailer, appUrl: 'x'});
  store.appendProjectEvent(conv.projectId, 'architecture.drawing', {projectId: conv.projectId, drawingId: 'draw-1', name: 'plan.pdf', kind: 'pdf', by: 'user'});
  const stats = await sweep();
  assert.equal(stats.sent, 1);
  assert.equal(mailer.sent[0].to, 'owner@example.com');
  assert.match(mailer.sent[0].subject, /Drawing added/);
});

test('daily rules batch into one digest email after the boundary', async t => {
  const {store, alerts} = fixture(t);
  const conv = store.createConversation('owner');
  alerts.create('owner', {kind: 'finished', cadence: 'daily'});
  const mailer = capturingMailer();
  const sweep = createAlertSweep({store, alerts, mailer, appUrl: 'https://app.example'});
  finishRun(store, 'owner', conv.id);
  finishRun(store, 'owner', conv.id, 'failed');
  const morning = Date.UTC(2026, 9, 18, 10, 0); // before DIGEST_HOUR_UTC same day
  assert.equal((await sweep(morning)).emails, 0, 'nothing sends before the digest boundary');
  const stats = await sweep(Date.UTC(2026, 9, 18, DIGEST_HOUR_UTC, 5));
  assert.equal(stats.emails, 1);
  assert.equal(stats.sent, 2);
  assert.match(mailer.sent[0].subject, /daily digest \(2\)/);
  assert.match(mailer.sent[0].text, /Research run finished/);
  assert.match(mailer.sent[0].text, /Research run failed/);
});

test('unconfigured mailer holds mail without consuming attempts; failures back off then give up', async t => {
  const {store, alerts} = fixture(t);
  const conv = store.createConversation('owner');
  alerts.create('owner', {kind: 'finished'});
  finishRun(store, 'owner', conv.id);
  const held = createAlertSweep({store, alerts, mailer: {configured: false, send: async () => { throw new Error('must not be called'); }}, appUrl: 'x'});
  const heldStats = await held();
  assert.equal(heldStats.held, 1);
  assert.equal(alerts.pendingCount(), 1);
  assert.equal(store.one('SELECT attempts FROM alert_outbox').attempts, 0);

  const failing = createAlertSweep({store, alerts, mailer: {configured: true, send: async () => { throw new Error('smtp down'); }}, appUrl: 'x'});
  let now = Date.now();
  for (let i = 0; i < 5; i++) { await failing(now); now += 25 * 3600 * 1000; }
  const row = store.one('SELECT status, attempts FROM alert_outbox');
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 5);
});

test('listing rules match new deal-store rows once, with no backfill at creation', async t => {
  const {store, alerts} = fixture(t);
  const base = {listing_type: 'for_sale', borough: 'Brooklyn', zip_code: '11215', style: 'multi_family', list_price: 2000000,
    unused_uap_zfa: 8000, uap_price_per_buildable_zfa: 250, deal_verdict: 'great_deal', landmark_flag: 0, address: '1 Test St', url: 'https://example.com/1'};
  const rows = [
    {...base, id: 'old-1', first_seen_at: Date.now() - 10000},
  ];
  const market = fakeMarket(() => rows);
  alerts.create('owner', {kind: 'listings', criteria: {borough: 'Brooklyn', dealVerdict: 'great_deal,good_deal'}});
  const mailer = capturingMailer();
  const sweep = createAlertSweep({store, alerts, mailer, openMarket: async () => market, appUrl: 'x'});
  assert.equal((await sweep()).sent, 0, 'listings seen before the rule existed are not backfilled');
  rows.push({...base, id: 'new-1', first_seen_at: Date.now() + 1000, address: '2 Test St'});
  rows.push({...base, id: 'new-2', first_seen_at: Date.now() + 1000, deal_verdict: 'full_price', address: '3 Test St'});
  const stats = await sweep(Date.now() + 2000);
  assert.equal(stats.sent, 1, 'only the matching new listing alerts');
  assert.match(mailer.sent[0].text, /2 Test St/);
  assert.equal((await sweep(Date.now() + 3000)).sent, 0);
});

test('a listing alert rates each new listing at its subscriber\'s saved costs, as their Browse rates it', t => {
  const f = priceFixture(t), {alerts} = fixture(t);
  // At house costs the listing is Full price; at the owner's saved $2,400 hard costs it has no tier.
  f.store.revalueDealsWithSettings();
  f.store.updateUserDealSettings('owner', {rentalHardCostPerGrossSqft: 2400, condoHardCostPerGrossSqft: 2400});
  assert.equal(f.store.one('SELECT deal_verdict FROM market_listings WHERE id=?', f.subjectId).deal_verdict, 'full_price');
  alerts.create('owner', {kind: 'listings', criteria: {dealVerdict: 'full_price'}});
  alerts.create('collab', {kind: 'listings', criteria: {dealVerdict: 'full_price'}});
  f.store.write('UPDATE market_listings SET first_seen_at=? WHERE id=?', Date.now() + 1000, f.subjectId);
  assert.deepEqual(scanListings(f.store, alerts).map(o => o.account), ['collab']);
});

test('a listing alert compares the price per buildable SF the card prints and describes the card\'s unused floor area', t => {
  const {alerts} = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'acres-alert-ppb-')), market = new MarketStore(join(dir, 'market.sqlite'));
  t.after(() => { market.close(); rmSync(dir, {recursive: true, force: true}); });
  // R7A 40 by 100 at $1.9M: the bonus area is 20,040 sq ft ($95 a buildable SF); the building that sets the value
  // holds 16,000 ($119), the figure the card prints.
  market.db.prepare(`INSERT INTO market_listings (id, listing_type, address, pluto_address, zip_code, borough, bbl, list_price, pluto_lot_area,
    pluto_lot_front, pluto_lot_depth, pluto_lot_type, pluto_bldg_area, resid_far, aff_res_far, zoning_district, units_res, year_built, flood_zone,
    landmark_flag, front_street_feet, first_seen_at, last_seen_at)
    VALUES ('a1', 'for_sale', '30 Probe St', '30 PROBE STREET', '11238', 'BK', '3011110022', 1900000, 4000, 40, 100, '5', 0, 4.6, 5.0, 'R7A', 0, 2020, 0, 0, 60, ?, ?)`).run(Date.now() + 1000, Date.now() + 1000);
  market.revalueDealsWithSettings();
  const stored = market.one('SELECT uap_price_per_buildable_zfa, price_per_buildable_sf FROM market_listings WHERE id=?', 'a1');
  assert.deepEqual([stored.uap_price_per_buildable_zfa, stored.price_per_buildable_sf], [95, 119]);
  alerts.create('owner', {kind: 'listings', criteria: {maxPricePerBuildableZfa: 100}});
  alerts.create('collab', {kind: 'listings', criteria: {maxPricePerBuildableZfa: 120}});
  const out = scanListings(market, alerts);
  assert.deepEqual(out.map(o => o.account), ['collab']);
  assert.match(out[0].body, /16,000 unused ZFA/);
  assert.doesNotMatch(out[0].body, /\u2014/);
});

test('listingMatches honors the stored-row criteria', () => {
  const row = {borough: 'Queens', zip_code: '11101', neighborhood: 'Astoria', city: 'Astoria', zoning_district: 'R7A', style: 'land',
    list_price: 900000, unused_uap_zfa: 5000, uap_price_per_buildable_zfa: 180, deal_verdict: 'good_deal', landmark_flag: 1};
  assert.equal(listingMatches(row, {borough: 'QN', area: 'astoria', zoningPrefix: 'R7', maxPricePerBuildableZfa: 200}), true);
  assert.equal(listingMatches(row, {excludeLandmarks: true}), false);
  assert.equal(listingMatches(row, {styles: ['multi_family']}), false);
  assert.equal(listingMatches(row, {dealVerdict: 'great_deal'}), false);
  // Unchecked parcels match neither side of the MIH criterion.
  assert.equal(listingMatches(row, {mihArea: 'outside'}), false);
  assert.equal(listingMatches({...row, in_mih_area: 0}, {mihArea: 'outside'}), true);
  assert.equal(listingMatches({...row, in_mih_area: 1}, {mihArea: 'inside'}), true);
  assert.equal(listingMatches({...row, in_mih_area: 1}, {mihArea: 'outside'}), false);
});

test('mailer posts the SendGrid shape and reports configuration honestly', async () => {
  let seen = null;
  const key = 'SG.' + 'fixture'.repeat(4);
  const mailer = createMailer({apiKey: key, from: 'A <a@b.c>', fetchImpl: async (url, init) => { seen = {url, init}; return {ok: true, status: 202, headers: {get: h => h === 'x-message-id' ? 'm1' : null}}; }});
  assert.equal(mailer.configured, true);
  const sent = await mailer.send({to: 'u@example.com', subject: 'S', text: 'T', unsubscribeUrl: 'https://app.example/stop'});
  assert.equal(sent.id, 'm1');
  assert.equal(seen.url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(seen.init.headers.authorization, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(seen.init.body), {
    personalizations: [{to: [{email: 'u@example.com'}]}],
    from: {name: 'A', email: 'a@b.c'}, subject: 'S',
    content: [{type: 'text/plain', value: 'T'}],
    headers: {'List-Unsubscribe': '<https://app.example/stop>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'},
  });
  assert.equal(createMailer({apiKey: ''}).configured, false);
  assert.equal(createMailer({apiKey: 'not-a-sendgrid-key'}).configured, false);
  const failing = createMailer({apiKey: key, fetchImpl: async () => ({ok: false, status: 403, json: async () => ({errors: [{message: 'The from address does not match a verified Sender Identity.'}]})})});
  await assert.rejects(() => failing.send({to: 'u@example.com', subject: 'S', text: 'T', unsubscribeUrl: 'https://app.example/stop'}), /HTTP 403: The from address/);
});

test('the chat tool manages only the bound account and reports delivery state', async t => {
  const {store, alerts} = fixture(t);
  assert.deepEqual(createAlertTools({alerts: null}).definitions, []);
  const handle = {
    email: 'owner@example.com',
    prefs: () => alerts.prefs('owner'), setEnabled: v => alerts.setEnabled('owner', v),
    list: () => alerts.list('owner'), create: i => alerts.create('owner', i),
    update: (id, p) => alerts.update('owner', id, p), remove: id => alerts.remove('owner', id),
    deliveryConfigured: () => false,
    test: () => alerts.enqueue({account: 'owner', dedupe: 'test:1', subject: 't', body: 'b', cadence: 'instant'}),
  };
  const tools = createAlertTools({alerts: handle});
  const manage = tools.handlers.acres_manage_alerts;
  const created = await manage({op: 'create', kind: 'finished', cadence: 'daily'});
  assert.equal(created.email, 'owner@example.com');
  assert.equal(created.emailDeliveryActive, false);
  assert.match(created.deliveryNote, /activates as soon as/);
  assert.equal(created.rules.length, 1);
  const listed = await manage({op: 'list'});
  assert.equal(listed.rules[0].kind, 'finished');
  const off = await manage({op: 'master', enabled: false});
  assert.equal(off.alertsEnabled, false);
  await manage({op: 'test'});
  assert.equal(alerts.pendingCount(), 1);
  assert.ok(store.personRow('owner'));
});
