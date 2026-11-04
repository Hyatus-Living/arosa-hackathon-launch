// Freemium plans: every account gets a monthly allowance of free research runs; Arosa Pro (a
// Stripe subscription the web app sells) and the Arosa team are unlimited. A run counts against the
// person who sends it, whoever owns the conversation. The limit applies only once the service is
// configured with an allowance (FREE_RUNS_PER_MONTH), so it never blocks anyone before checkout exists.
// Beta testers (beta.mjs) are unlimited in practice: BETA_RUNS_PER_MONTH (1,000 when unset) is only a
// safety cap, applied under the same switch as the free allowance; while the free limit is off, nobody is limited.
// Subscription state arrives from the web app's Stripe webhook; Stripe stays the source of truth and
// this table only mirrors its latest event.
import {isMarketAdmin} from './market-store.mjs';

export const INTERVALS = ['month', 'year'];
// Stripe keeps retrying a failed renewal while the subscription is past due; access continues until it cancels.
const ACTIVE = new Set(['active', 'trialing', 'past_due']);
const STATUSES = new Set(['active', 'trialing', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid', 'canceled', 'paused']);

function fail(status, message, code) {const error = new Error(message); error.status = status; if (code) error.code = code; throw error;}

// The free allowance resets on the first of each month, UTC.
export function monthWindow(now = Date.now()) {
  const date = new Date(now);
  return {start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)};
}

export class Plans {
  constructor(store, {freeRunsPerMonth = null, betaRunsPerMonth = null, betaTesters = null, unmeteredEmails = []} = {}) {
    this.store = store;
    this.limit = Number.isSafeInteger(freeRunsPerMonth) && freeRunsPerMonth >= 0 ? freeRunsPerMonth : null;
    this.betaLimit = Number.isSafeInteger(betaRunsPerMonth) && betaRunsPerMonth >= 0 ? betaRunsPerMonth : 1000;
    this.betaTesters = betaTesters;
    this.unmeteredEmails = new Set(unmeteredEmails.map(email => String(email).trim().toLowerCase()));
    store.db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(account TEXT PRIMARY KEY,status TEXT NOT NULL,interval TEXT NOT NULL,
      current_period_end INTEGER,cancel_at_period_end INTEGER NOT NULL,customer TEXT NOT NULL,subscription TEXT NOT NULL,
      event_created INTEGER NOT NULL,updated INTEGER NOT NULL)`);
  }
  unmetered(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return Boolean(normalized) && (normalized.endsWith('@witharosa.ai') || isMarketAdmin(normalized) || this.unmeteredEmails.has(normalized));
  }
  subscription(account) {return this.store.one('SELECT * FROM subscriptions WHERE account=?', account) || null;}
  used(account, now = Date.now()) {
    const {start, end} = monthWindow(now);
    return this.store.one('SELECT count(*) n FROM runs WHERE owner=? AND created>=? AND created<?', account, start, end).n;
  }
  // What the account's plan is this month. `customer` is the Stripe customer, for the web app only.
  status(account, email, now = Date.now()) {
    const row = this.subscription(account);
    const beta = Boolean(this.betaTesters?.has(email));
    const plan = this.unmetered(email) ? 'team' : row && ACTIVE.has(row.status) ? 'pro' : beta ? 'beta' : 'free';
    const limit = plan === 'free' ? this.limit : plan === 'beta' && this.limit !== null ? this.betaLimit : null;
    return {
      plan, beta, used: this.used(account, now), limit, ...(plan === 'beta' ? {betaAllowance: this.betaLimit} : {}), resetsAt: monthWindow(now).end,
      subscription: row ? {status: row.status, interval: row.interval, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: Boolean(row.cancel_at_period_end)} : null,
      customer: row?.customer || null,
    };
  }
  assertCanRun(account, email, now = Date.now()) {
    const status = this.status(account, email, now);
    if (status.limit !== null && status.used >= status.limit)
      fail(402, status.plan === 'beta'
        ? `You have reached the beta safety cap of ${status.limit.toLocaleString('en-US')} research runs this month. It resets on the first of next month.`
        : `You have used your ${status.limit} free research runs this month. Upgrade to Arosa Pro for unlimited research.`, 'free_limit_reached');
  }
  // Stripe can deliver events out of order; an older event never overwrites a newer one, and the end
  // of a replaced subscription never ends the live one that replaced it.
  record(account, input, now = Date.now()) {
    const {status, interval, currentPeriodEnd = null, cancelAtPeriodEnd, customer, subscription, eventCreated} = input || {};
    if (!STATUSES.has(status) || !INTERVALS.includes(interval) || typeof cancelAtPeriodEnd !== 'boolean'
      || !/^cus_\w+$/.test(customer || '') || !/^sub_\w+$/.test(subscription || '') || !Number.isSafeInteger(eventCreated)
      || (currentPeriodEnd !== null && !Number.isSafeInteger(currentPeriodEnd))) fail(400, 'Invalid subscription.');
    this.store.write(`INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET
        status=excluded.status,interval=excluded.interval,current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,
        customer=excluded.customer,subscription=excluded.subscription,event_created=excluded.event_created,updated=excluded.updated
      WHERE excluded.event_created>=subscriptions.event_created
        AND NOT (excluded.subscription<>subscriptions.subscription AND subscriptions.status IN ('active','trialing','past_due')
          AND excluded.status NOT IN ('active','trialing','past_due'))`,
    account, status, interval, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, customer, subscription, eventCreated, now);
    return this.subscription(account);
  }
}
