import {randomUUID, randomBytes, createHmac, timingSafeEqual} from 'node:crypto';

// Per-user email alerts, configured from chat and delivered to the email on the account.
// Rules, the master switch, the delivery outbox and per-rule listing watermarks live in the
// chat database next to people/projects. Delivery itself is alert-runner.mjs + alert-mailer.mjs;
// this module is storage and validation only, so tests can drive it without network or SMTP.

export const ALERT_KINDS = ['finished', 'activity', 'listings'];
export const ALERT_CADENCES = ['instant', 'daily'];
export const DIGEST_HOUR_UTC = 13; // 08:00 EST / 09:00 EDT

const bad = (message, status = 400) => Object.assign(new Error(message), {status});

// Listing criteria mirror the deal-store filters that stored listing rows can answer directly.
export const LISTING_CRITERIA_KEYS = ['borough', 'zipCode', 'area', 'zoningPrefix', 'styles', 'minListPrice', 'maxListPrice', 'minUnusedZfa', 'maxPricePerBuildableZfa', 'dealVerdict', 'excludeLandmarks', 'mihArea'];
const STYLES = ['land', 'multi_family', 'townhomes', 'single_family', 'duplex_triplex'];
// Borough criteria are stored as the filter schema's codes; names and county aliases resolve to them.
const BOROUGH_CODES = {mn: 'MN', manhattan: 'MN', 'new york': 'MN', bk: 'BK', brooklyn: 'BK', kings: 'BK', qn: 'QN', queens: 'QN', bx: 'BX', bronx: 'BX', 'the bronx': 'BX', si: 'SI', 'staten island': 'SI', richmond: 'SI'};
const VERDICTS = ['great_deal', 'good_deal', 'fair_deal', 'full_price', 'unpriced_opportunity', 'great_deal,good_deal'];

export function validateCriteria(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw bad('Listing criteria must be an object.');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LISTING_CRITERIA_KEYS.includes(key)) throw bad(`Unknown listing criterion "${key}". Supported: ${LISTING_CRITERIA_KEYS.join(', ')}.`);
    if (value === null || value === undefined || value === '') continue;
    if (key === 'borough') {
      const code = typeof value === 'string' ? BOROUGH_CODES[value.trim().toLowerCase()] : undefined;
      if (!code) throw bad('criteria.borough must be one of Manhattan, Brooklyn, Queens, Bronx, or Staten Island (or its two-letter code).');
      out[key] = code;
    } else if (['area', 'zoningPrefix'].includes(key)) {
      if (typeof value !== 'string' || value.length > 60) throw bad(`criteria.${key} must be a short string.`);
      out[key] = value.trim();
    } else if (key === 'zipCode') {
      if (!/^\d{5}$/.test(String(value))) throw bad('criteria.zipCode must be a 5-digit ZIP code.');
      out[key] = String(value);
    } else if (key === 'styles') {
      if (!Array.isArray(value) || !value.length || value.some(s => !STYLES.includes(s))) throw bad(`criteria.styles must be a non-empty subset of ${STYLES.join(', ')}.`);
      out[key] = [...new Set(value)];
    } else if (key === 'dealVerdict') {
      if (!VERDICTS.includes(value)) throw bad(`criteria.dealVerdict must be one of ${VERDICTS.join(', ')}.`);
      out[key] = value;
    } else if (key === 'mihArea') {
      if (!['inside', 'outside'].includes(value)) throw bad('criteria.mihArea must be inside or outside.');
      out[key] = value;
    } else if (key === 'excludeLandmarks') {
      if (typeof value !== 'boolean') throw bad('criteria.excludeLandmarks must be true or false.');
      out[key] = value;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw bad(`criteria.${key} must be a non-negative number.`);
      out[key] = n;
    }
  }
  if (out.minListPrice !== undefined && out.maxListPrice !== undefined && out.minListPrice > out.maxListPrice) throw bad('criteria.minListPrice cannot exceed criteria.maxListPrice.');
  return out;
}

export function validateRuleInput({kind, cadence = 'instant', projectId = null, criteria = {}} = {}) {
  if (!ALERT_KINDS.includes(kind)) throw bad(`kind must be one of ${ALERT_KINDS.join(', ')}: finished = your research runs and renders complete or fail; activity = someone else changes a project you can access; listings = new deal-store listings match your criteria.`);
  if (!ALERT_CADENCES.includes(cadence)) throw bad(`cadence must be one of ${ALERT_CADENCES.join(', ')}.`);
  if (projectId !== null && (typeof projectId !== 'string' || !projectId)) throw bad('projectId must be a project id or null for every project you can access.');
  if (kind === 'listings' && projectId !== null) throw bad('Listing alerts are not tied to a project; leave projectId out.');
  return {kind, cadence, projectId, criteria: kind === 'listings' ? validateCriteria(criteria) : {}};
}

// One spelling per criteria set (sorted keys and styles), so equal rules compare equal.
const canonicalCriteria = criteria => JSON.stringify(Object.fromEntries(Object.keys(criteria).sort()
  .map(key => [key, key === 'styles' ? [...criteria[key]].sort() : criteria[key]])));

// The next daily-digest boundary strictly after now (ms epoch), at DIGEST_HOUR_UTC.
export function nextDigestAt(now) {
  const d = new Date(now);
  const candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DIGEST_HOUR_UTC, 0, 0, 0);
  return candidate > now ? candidate : candidate + 24 * 3600 * 1000;
}

const DDL = `
CREATE TABLE IF NOT EXISTS alert_rules(
  id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('finished','activity','listings')),
  project TEXT, cadence TEXT NOT NULL CHECK(cadence IN ('instant','daily')), paused INTEGER NOT NULL DEFAULT 0,
  criteria TEXT NOT NULL DEFAULT '{}', seen_until INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS alert_rules_account ON alert_rules(account, kind);
CREATE TABLE IF NOT EXISTS alert_prefs(account TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alert_outbox(
  id TEXT PRIMARY KEY, account TEXT NOT NULL, rule TEXT, dedupe TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL, body TEXT NOT NULL, cadence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, deliver_after INTEGER NOT NULL, created INTEGER NOT NULL,
  sent_at INTEGER, last_error TEXT);
CREATE INDEX IF NOT EXISTS alert_outbox_due ON alert_outbox(status, deliver_after);
CREATE TABLE IF NOT EXISTS alert_watermarks(source TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class AlertStore {
  constructor(store) {
    this.store = store;
    this.store.db.exec(DDL);
    // Unsubscribe links are signed with a key kept in this database, made once on first use.
    if (!this.store.one(`SELECT 1 FROM alert_watermarks WHERE source='unsubscribe-key'`)) this.setWatermark('unsubscribe-key', randomBytes(32).toString('hex'));
    this.signingKey = this.watermark('unsubscribe-key');
  }

  view = row => row && ({id: row.id, kind: row.kind, cadence: row.cadence, projectId: row.project, paused: Boolean(row.paused),
    criteria: JSON.parse(row.criteria || '{}'), createdAt: row.created, updatedAt: row.updated});

  prefs(account) {
    const row = this.store.one('SELECT enabled FROM alert_prefs WHERE account=?', account);
    return {enabled: row ? Boolean(row.enabled) : true};
  }
  setEnabled(account, enabled) {
    this.store.write(`INSERT INTO alert_prefs VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET enabled=excluded.enabled, updated=excluded.updated`,
      account, enabled ? 1 : 0, Date.now());
    return this.prefs(account);
  }

  list(account) { return this.store.query('SELECT * FROM alert_rules WHERE account=? ORDER BY created, id', account).map(this.view); }
  get(account, id) { return this.view(this.store.one('SELECT * FROM alert_rules WHERE account=? AND id=?', account, id)); }

  // An identical rule (same kind, project, cadence and criteria) would only send the same email twice.
  rejectDuplicate(account, rule, exceptId = null) {
    const same = this.list(account).find(r => r.id !== exceptId && r.kind === rule.kind && r.cadence === rule.cadence
      && r.projectId === rule.projectId && canonicalCriteria(r.criteria) === canonicalCriteria(rule.criteria));
    if (same) throw bad(`You already have this alert (rule ${same.id}${same.paused ? ', paused' : ''}).`, 409);
  }

  create(account, input = {}) {
    const rule = validateRuleInput(input);
    if (rule.projectId) this.store.requireProject(account, rule.projectId, 'viewer');
    this.rejectDuplicate(account, rule);
    const now = Date.now(), id = randomUUID();
    // seen_until starts now: listing rules never backfill the existing store into the inbox.
    this.store.write('INSERT INTO alert_rules VALUES(?,?,?,?,?,?,?,?,?,?)', id, account, rule.kind, rule.projectId, rule.cadence, 0, canonicalCriteria(rule.criteria), now, now, now);
    return this.get(account, id);
  }

  update(account, id, patch = {}) {
    const current = this.get(account, id);
    if (!current) throw bad('Alert rule not found.', 404);
    const next = validateRuleInput({
      kind: patch.kind ?? current.kind,
      cadence: patch.cadence ?? current.cadence,
      projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
      criteria: patch.criteria ?? current.criteria,
    });
    if (next.projectId) this.store.requireProject(account, next.projectId, 'viewer');
    this.rejectDuplicate(account, next, id);
    const paused = patch.paused === undefined ? current.paused : Boolean(patch.paused);
    this.store.write('UPDATE alert_rules SET kind=?, cadence=?, project=?, paused=?, criteria=?, updated=? WHERE account=? AND id=?',
      next.kind, next.cadence, next.projectId, paused ? 1 : 0, canonicalCriteria(next.criteria), Date.now(), account, id);
    return this.get(account, id);
  }

  remove(account, id) {
    if (!this.get(account, id)) throw bad('Alert rule not found.', 404);
    this.store.write('DELETE FROM alert_rules WHERE account=? AND id=?', account, id);
    return {deleted: id};
  }

  // A signed link token that stops one rule, or every alert for the account when rule is null.
  unsubscribeToken(account, ruleId = null) {
    const payload = Buffer.from(JSON.stringify([account, ruleId])).toString('base64url');
    return `${payload}.${createHmac('sha256', this.signingKey).update(payload).digest('base64url')}`;
  }
  // Following the link pauses the rule (or turns alerts off); repeating it changes nothing more.
  unsubscribe(token) {
    const [payload, signature = ''] = String(token || '').split('.');
    const expected = createHmac('sha256', this.signingKey).update(payload).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad('This unsubscribe link is not valid.', 404);
    const [account, ruleId] = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (ruleId === null) { this.setEnabled(account, false); return {stopped: 'all'}; }
    const rule = this.get(account, ruleId);
    if (!rule) return {stopped: 'deleted'};
    this.store.write('UPDATE alert_rules SET paused=1, updated=? WHERE account=? AND id=? AND paused=0', Date.now(), account, ruleId);
    return {stopped: 'rule', kind: rule.kind};
  }

  // Rules that could match an occurrence of this kind for this recipient (paused/master applied by caller via prefs).
  matching(account, kind, projectId = null) {
    return this.list(account).filter(r => !r.paused && r.kind === kind && (r.projectId === null || r.projectId === projectId));
  }

  allListingRules() {
    return this.store.query(`SELECT * FROM alert_rules WHERE kind='listings' AND paused=0`).map(row => ({...this.view(row), account: row.account, seenUntil: row.seen_until}));
  }
  advanceListingWatermark(ruleId, seenUntil) {
    this.store.write('UPDATE alert_rules SET seen_until=MAX(seen_until, ?) WHERE id=?', seenUntil, ruleId);
  }

  watermark(source, fallback = '0') {
    return this.store.one('SELECT value FROM alert_watermarks WHERE source=?', source)?.value ?? fallback;
  }
  setWatermark(source, value) {
    this.store.write(`INSERT INTO alert_watermarks VALUES(?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value`, source, String(value));
  }

  // Returns true when the row was newly queued (dedupe makes re-scans idempotent).
  enqueue({account, ruleId = null, dedupe, subject, body, cadence, now = Date.now()}) {
    const deliverAfter = cadence === 'daily' ? nextDigestAt(now) : now;
    const result = this.store.write(
      `INSERT OR IGNORE INTO alert_outbox(id,account,rule,dedupe,subject,body,cadence,deliver_after,created) VALUES(?,?,?,?,?,?,?,?,?)`,
      randomUUID(), account, ruleId, dedupe, subject, body, cadence, deliverAfter, now);
    return result.changes > 0;
  }

  due(now, limit = 200) {
    return this.store.query(`SELECT * FROM alert_outbox WHERE status='pending' AND deliver_after<=? ORDER BY deliver_after, created LIMIT ?`, now, limit);
  }
  pendingCount() { return this.store.one(`SELECT COUNT(*) AS n FROM alert_outbox WHERE status='pending'`).n; }
  markSent(ids, at = Date.now()) {
    for (const id of ids) this.store.write(`UPDATE alert_outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?`, at, id);
  }
  markFailed(ids, error, now = Date.now()) {
    for (const id of ids) {
      const row = this.store.one('SELECT attempts FROM alert_outbox WHERE id=?', id);
      if (!row) continue;
      const attempts = row.attempts + 1;
      if (attempts >= 5) this.store.write(`UPDATE alert_outbox SET status='failed', attempts=?, last_error=? WHERE id=?`, attempts, String(error).slice(0, 300), id);
      else this.store.write(`UPDATE alert_outbox SET attempts=?, last_error=?, deliver_after=? WHERE id=?`, attempts, String(error).slice(0, 300), now + Math.min(24 * 3600 * 1000, 5 * 60 * 1000 * 2 ** attempts), id);
    }
  }
}
