// Free hosted access with per-account daily allowances. Historical subscriptions remain
// available for billing records, but never change access or bypass the shared limits.
export const INTERVALS = ['month', 'year'];
const STATUSES = new Set(['active', 'trialing', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid', 'canceled', 'paused']);
export const DAILY_LIMITS = Object.freeze({research: 50, illustrations: 20, selections: 100, renders: 50});
export const RESET_TIME_ZONE = 'America/New_York';
const LABELS = {research: 'Research requests', illustrations: 'AI illustrations', selections: 'Photo selections', renders: '3D renders'};
const calendar = new Intl.DateTimeFormat('en-US', {timeZone: RESET_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'});
const localParts = at => Object.fromEntries(calendar.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
function fail(status, message, code) {const error = new Error(message); error.status = status; if (code) error.code = code; throw error;}
function midnight(year, month, day) {
  const target = Date.UTC(year, month - 1, day);
  let at = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(at);
    at += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return at;
}
// Calendar-day windows, including the 23- and 25-hour daylight-saving transition days.
export function dayWindow(now = Date.now()) {
  const p = localParts(now), next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return {start: midnight(p.year, p.month, p.day), end: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())};
}

export class Plans {
  constructor(store, {dailyLimits = {}, betaTesters = null} = {}) {
    this.store = store;
    this.limits = {...DAILY_LIMITS, ...dailyLimits};
    if (Object.keys(this.limits).some(kind => !Object.hasOwn(DAILY_LIMITS, kind) || !Number.isSafeInteger(this.limits[kind]) || this.limits[kind] < 0)) throw new Error('Daily allowances must be nonnegative integers for known activities.');
    this.betaTesters = betaTesters;
    store.db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(account TEXT PRIMARY KEY,status TEXT NOT NULL,interval TEXT NOT NULL,
      current_period_end INTEGER,cancel_at_period_end INTEGER NOT NULL,customer TEXT NOT NULL,subscription TEXT NOT NULL,
      event_created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_usage(account TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(account,kind,reference));
      CREATE INDEX IF NOT EXISTS daily_usage_window ON daily_usage(account,kind,created)`);
    // Import existing requests without coupling future usage to deletable project content.
    store.write("INSERT OR IGNORE INTO daily_usage SELECT owner,'research','run:'||id,created FROM runs");
    if(store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='listing_investigations'"))
      store.write("INSERT OR IGNORE INTO daily_usage SELECT owner,'research','listing:'||id,created FROM listing_investigations");
  }
  subscription(account) {return this.store.one('SELECT * FROM subscriptions WHERE account=?', account) || null;}
  used(account, now = Date.now(), kind = 'research') {
    const {start, end} = dayWindow(now);
    return this.store.one('SELECT count(*) n FROM daily_usage WHERE account=? AND kind=? AND created>=? AND created<?', account, kind, start, end).n;
  }
  allowance(account, kind, now = Date.now()) {
    const limit = this.limits[kind], used = this.used(account, now, kind);
    return {label: LABELS[kind], used, limit, remaining: Math.max(0, limit - used)};
  }
  status(account, email, now = Date.now()) {
    const row = this.subscription(account);
    const limits = Object.fromEntries(Object.keys(this.limits).map(kind => [kind, this.allowance(account, kind, now)]));
    return {
      plan: 'community', beta: Boolean(this.betaTesters?.has(email)),
      used: limits.research.used, limit: limits.research.limit, remaining: limits.research.remaining,
      period: 'day', timeZone: RESET_TIME_ZONE, resetsAt: dayWindow(now).end, limits,
      subscription: row ? {status: row.status, interval: row.interval, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: Boolean(row.cancel_at_period_end)} : null,
      customer: row?.customer || null,
    };
  }
  assertAvailable(account, kind, now = Date.now()) {
    const {used, limit, label} = this.allowance(account, kind, now);
    if (used >= limit) throw Object.assign(new Error(`You have used today's ${limit} ${label.toLowerCase()}. Your free allowance resets at midnight New York time. Your saved work remains available.`),
      {status: 429, code: 'daily_limit_reached', kind, limit, resetsAt: dayWindow(now).end});
  }
  assertCanRun(account, _email, now = Date.now()) {this.assertAvailable(account, 'research', now);}
  // Reserve immediately before a new provider call or render is dispatched. Replays are free.
  consume(account, kind, reference, now = Date.now()) {
    if (!Object.hasOwn(this.limits, kind)) throw new Error('Unknown daily activity.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.store.one('SELECT 1 FROM daily_usage WHERE account=? AND kind=? AND reference=?', account, kind, reference)) {
        this.store.db.exec('COMMIT');return false;
      }
      this.assertAvailable(account, kind, now);
      this.store.write('INSERT INTO daily_usage VALUES(?,?,?,?)', account, kind, reference, now);
      this.store.db.exec('COMMIT');return true;
    } catch (error) {this.store.db.exec('ROLLBACK');throw error;}
  }
  admitResearch(account, reference, now = Date.now()) {
    if(!this.consume(account,'research',reference,now))fail(409,'This request ID has already been used. Start a new request.');
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
