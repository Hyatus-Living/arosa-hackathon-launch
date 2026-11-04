import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AlertStore} from './alerts.mjs';
import {mailerFromSecrets} from './alert-mailer.mjs';
import {scanRuns, scanProjectEvents, scanListings} from './alert-sources.mjs';

// One alert sweep: scan event sources into the outbox, then dispatch what is due.
// Instant mail goes one event per email; daily mail is grouped per account into a single
// digest. When no sending key is configured, due mail is held (never dropped, never
// attempt-counted) and the sweep reports held>0. Runs on an interval inside the research
// service; also runnable directly for backfills: node alert-runner.mjs

export function createAlertSweep({store, alerts = new AlertStore(store), mailer, openMarket = null, appUrl = 'https://build.witharosa.ai', log = () => {}}) {
  async function sweep(now = Date.now()) {
    const stats = {scanned: 0, queued: 0, sent: 0, emails: 0, failed: 0, held: 0, sourceErrors: 0};
    // Each source fails alone: one bad source must never block the others or dispatch.
    const occurrences = [];
    for (const scan of [() => scanRuns(store, alerts, appUrl), () => scanProjectEvents(store, alerts, appUrl)]) {
      try { occurrences.push(...scan()); }
      catch (e) { stats.sourceErrors++; log({event: 'alerts_source_failed', message: String(e?.message || e).slice(0, 300)}); }
    }
    let market = null;
    try { market = openMarket ? await openMarket() : null; } catch { market = null; }
    try { if (market) occurrences.push(...scanListings(market, alerts)); }
    catch (e) { stats.sourceErrors++; log({event: 'alerts_source_failed', message: String(e?.message || e).slice(0, 300)}); }
    finally { try { market?.close?.(); } catch { /* already closed */ } }
    stats.scanned = occurrences.length;

    for (const occ of occurrences) {
      if (!alerts.prefs(occ.account).enabled) continue;
      const email = store.personRow(occ.account)?.email;
      if (!email) continue;
      const rules = occ.ruleId
        ? alerts.list(occ.account).filter(r => r.id === occ.ruleId && !r.paused)
        : alerts.matching(occ.account, occ.ruleKind, occ.projectId);
      for (const rule of rules) {
        if (alerts.enqueue({account: occ.account, ruleId: rule.id, dedupe: `${occ.dedupe}:${rule.cadence}`, subject: occ.subject, body: occ.body, cadence: rule.cadence, now})) stats.queued++;
      }
    }

    const stopUrl = (account, ruleId) => `${appUrl}/api/public/alerts/unsubscribe?token=${alerts.unsubscribeToken(account, ruleId)}`;
    const due = alerts.due(now);
    if (!mailer?.configured) { stats.held = due.length; return stats; }
    const instant = due.filter(r => r.cadence !== 'daily');
    const daily = due.filter(r => r.cadence === 'daily');
    for (const row of instant) {
      const email = store.personRow(row.account)?.email;
      if (!email) { alerts.markFailed([row.id], 'Account has no email on file.', now); stats.failed++; continue; }
      try {
        const unsubscribeUrl = stopUrl(row.account, row.rule);
        await mailer.send({to: email, subject: row.subject, unsubscribeUrl, text: `${row.body}\n\n-- \nYou are receiving this because you asked Arosa for this alert. Manage alerts in chat ("show my alerts") or stop ${row.rule ? 'this alert' : 'all alerts'}: ${unsubscribeUrl}`});
        alerts.markSent([row.id], now); stats.sent++; stats.emails++;
      } catch (e) { alerts.markFailed([row.id], e.message, now); stats.failed++; }
    }
    const byAccount = new Map();
    for (const row of daily) byAccount.set(row.account, [...(byAccount.get(row.account) || []), row]);
    for (const [account, rows] of byAccount) {
      const email = store.personRow(account)?.email;
      const ids = rows.map(r => r.id);
      if (!email) { alerts.markFailed(ids, 'Account has no email on file.', now); stats.failed += ids.length; continue; }
      const unsubscribeUrl = stopUrl(account, null);
      const text = `${rows.length} update${rows.length === 1 ? '' : 's'} since your last digest:\n\n${rows.map(r => `• ${r.subject}\n${r.body}${r.rule ? `\nStop this alert: ${stopUrl(account, r.rule)}` : ''}`).join('\n\n')}\n\n-- \nYou are receiving this because you asked Arosa for these alerts. Manage alerts in chat ("show my alerts") or stop all alerts: ${unsubscribeUrl}`;
      try {
        await mailer.send({to: email, subject: `Your Arosa daily digest (${rows.length})`, text, unsubscribeUrl});
        alerts.markSent(ids, now); stats.sent += ids.length; stats.emails++;
      } catch (e) { alerts.markFailed(ids, e.message, now); stats.failed += ids.length; }
    }
    if (stats.queued || stats.sent || stats.failed) log({event: 'alerts_sweep', ...stats});
    return stats;
  }
  return sweep;
}

// Starts the in-service interval. Errors are logged, never thrown into the host process.
export function startAlertSweeper(options, {intervalMs = 60000, log = entry => console.error(JSON.stringify(entry))} = {}) {
  const sweep = createAlertSweep({...options, log});
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweep(); } catch (e) { log({event: 'alerts_sweep_failed', message: String(e?.message || e).slice(0, 300)}); }
    finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return {stop: () => clearInterval(timer), sweepNow: tick};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {ChatStore} = await import('./store.mjs');
  const {openMarketStore} = await import('./market-store.mjs');
  const secrets = JSON.parse(readFileSync(process.env.ACRES_SECRETS_JSON || '/etc/acres-research/secrets.json', 'utf8'));
  const store = new ChatStore('/home/openclaw/.openclaw/acres-state/chat.sqlite');
  const sweep = createAlertSweep({
    store, mailer: mailerFromSecrets(secrets),
    openMarket: async () => openMarketStore({readOnly: true}),
    appUrl: process.env.ALERTS_APP_URL || 'https://build.witharosa.ai',
    log: entry => console.error(JSON.stringify(entry)),
  });
  console.log(JSON.stringify(await sweep()));
  store.close();
}
