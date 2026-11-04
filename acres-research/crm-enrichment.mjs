// Contact enrichment for the Outreach CRM, run on the research server: a people search when a contact
// has no matching profile, contact lookups (work email, personal email, phone) on the matched profile,
// and a deep-research identity check that says whether that profile and those lookups belong to the
// contact. Jobs live in SQLite (crm_jobs) and run in the background whether or not anyone has the page
// open, surviving restarts and deploys. Up to eight lookups and ten identity checks run at once, retried
// with backoff when a provider is busy, inside a per-run and a daily spending limit.
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ListingResearchProvider, providerTerminal} from './listing-investigation-provider.mjs';

export const ENRICH_STEPS = ['profile', 'contacts', 'identity'];
export const JOB_TERMINAL = ['done', 'failed', 'stopped', 'skipped'];
export const IDENTITY_VERDICTS = ['confirmed', 'needs_review', 'mismatch'];
// Spend held against the limits before a step runs. The recorded cost afterwards is the actual charge
// for lookups and an estimate from token usage for identity checks.
export const STEP_ESTIMATE_MICROS = {profile: 50_000, contacts: 900_000, identity: 1_500_000};
// Estimated deep-research token prices in USD per million tokens (input, cached input, output and thinking).
export const IDENTITY_TOKEN_RATES = {input: 2, cached: 0.2, output: 12};
export const DEFAULT_DAILY_CAP_USD = 50;
const IDENTITY_AGENT = 'deep-research-preview-04-2026';
const IDENTITY_DEADLINE_MS = 45 * 60000;
const LOOKUPS = {work: 'treg.people.email.find', personal: 'treg.people.email.find.personal', phone: 'treg.people.phone.find'};
export const LANES = {lookup: 8, identity: 10};
const RETRIES = 5, MAX_BACKOFF_MS = 120000;
const TREG = 'https://treg.to/call/';
const fail = (status, message) => {throw Object.assign(new Error(message), {status});};
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const lane = (step) => step === 'identity' ? 'identity' : 'lookup';
const day = (now) => new Date(now).toISOString().slice(0, 10);

// Midnight in New York for the day containing `now`: the daily limit resets then.
export function dayStart(now, timeZone = 'America/New_York') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric'})
    .formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return now - now % 1000 - ((parts.hour % 24) * 3600 + parts.minute * 60 + parts.second) * 1000;
}

const words = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
// A profile matches when both the contact's first and last name appear in the profile's name.
export function nameMatches(contactName, profileName) {
  const parts = words(contactName), name = String(profileName || '').toLowerCase();
  return parts.length >= 2 && name.includes(parts[0]) && name.includes(parts.at(-1));
}

const linkedin = (url) => /^https:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(String(url || ''));
// The profile lookups run on: one a person chose, else the first name-matching profile found.
export function pickProfile(contact) {
  if (linkedin(contact.profile_url)) return contact.profile_url;
  return (contact.candidates || []).find((p) => p.name_match && linkedin(p.url))?.url || null;
}

export function profileQuery(contact) {
  return [contact.name, contact.company, contact.borough, 'real estate'].filter(Boolean).join(' ');
}

// One people-search row as a candidate profile.
export function candidateFromSearch(row, contactName) {
  const props = row.entities?.[0]?.properties || {};
  const work = (props.workHistory || []).find((job) => !job.dates?.to) || {};
  const name = props.name || row.title || '';
  return {name, title: work.title || '', company: work.company?.name || '', location: props.location || '', url: row.url || null,
    name_match: nameMatches(contactName, name)};
}

// The three lookups as one record for details.lookup.
export function lookupFromResults(found, profileUrl, at) {
  const work = found.work?.output || {}, personal = found.personal?.output || {}, phone = found.phone?.output || {};
  return {at, profileUrl, workEmail: work.email || null, workEmailVerified: Boolean(work.verified), workEmailConfidence: work.confidence ?? null,
    personalEmail: personal.email || null, personalEmailVerified: Boolean(personal.verified),
    phone: phone.phone || null, phoneLineType: phone.line_type || null};
}

export function bestEmail(lookup) {
  return (lookup.workEmailVerified && lookup.workEmail) || (lookup.personalEmailVerified && lookup.personalEmail) || lookup.workEmail || lookup.personalEmail || null;
}

export function identityVerdict({confidence, lookupEmailIsBuyers}) {
  if (lookupEmailIsBuyers === 'no' || confidence === 'low') return 'mismatch';
  return confidence === 'high' ? 'confirmed' : 'needs_review';
}

// The identity check's closing JSON as details.identity.
export function identityFromVerdict(verdict, {checked, sources = []}) {
  const level = ['high', 'medium', 'low'].includes(verdict?.same_person) ? verdict.same_person : 'unknown';
  const email = ['yes', 'no'].includes(verdict?.lookup_email_is_buyers) ? verdict.lookup_email_is_buyers : 'unknown';
  const identity = {confidence: level, lookupEmailIsBuyers: email,
    evidence: (Array.isArray(verdict?.evidence) ? verdict.evidence : []).filter((e) => typeof e === 'string').map((e) => e.slice(0, 600)).slice(0, 8),
    buyerCompany: text(verdict?.buyer_company, 200) || null, buyerRole: text(verdict?.buyer_role, 200) || null,
    website: text(verdict?.website, 300) || null, professionalContact: text(verdict?.professional_contact, 400) || null,
    checked, sources: sources.slice(0, 20)};
  return {verdict: identityVerdict(identity), ...identity};
}

// Field changes the enrichment makes to a contact. Only empty fields a person has not edited are filled:
// a confirmed identity fills email, phone and profile from the lookups; a mismatch keeps the lookups as
// reference only and moves a new contact to researching; company and role come from the identity check
// when it confirms or corrects who the contact is. Needs review changes nothing.
export function enrichmentPatch(contact) {
  const details = contact.details || {}, {lookup, identity} = details, edited = new Set(details.edited || []), patch = {};
  if (!identity) return patch;
  const fill = (field, value) => {if (value && !contact[field] && !edited.has(field)) patch[field] = value;};
  if (identity.verdict === 'confirmed' && lookup) {
    fill('email', bestEmail(lookup));
    fill('phone', lookup.phone);
    fill('profile_url', lookup.profileUrl);
  }
  if (identity.verdict !== 'needs_review') {
    fill('company', identity.buyerCompany);
    fill('title', identity.buyerRole);
  }
  if (identity.verdict === 'mismatch' && contact.status === 'new' && !edited.has('status')) patch.status = 'researching';
  return patch;
}

export function identityPrompt(contact) {
  const d = contact.details || {}, profile = pickProfile(contact);
  const match = (contact.candidates || []).find((p) => p.url === profile);
  const facts = d.deedName
    ? `Public property records show a buyer named "${d.deedName}" who bought ${d.primaryLots || 'one or more'} tax lot(s)${contact.borough ? ` in ${contact.borough}` : ''}${d.firstPurchase ? ` between ${d.firstPurchase} and ${d.lastPurchase || d.firstPurchase}` : ''}.`
    : `The contact is ${contact.name}${contact.title || contact.company ? `, ${[contact.title, contact.company].filter(Boolean).join(' at ')}` : ''}${contact.borough ? `, active in ${contact.borough}` : ''}.`;
  const profileLine = profile
    ? `A people search matched this professional profile: ${match ? `${match.name}, ${match.title || 'no title'} at ${match.company || 'no company'}${match.location ? `, ${match.location}` : ''}, ` : ''}${profile}.`
    : 'No professional profile has been matched yet; answer 1) with low confidence and say who the contact is instead.';
  const work = d.lookup?.workEmail;
  const lookupLine = work && work.includes('@') ? ` A contact lookup on that profile returned the work email domain ${work.split('@')[1]}.` : '';
  return `Identity check for a business outreach list. ${facts} ${profileLine}${lookupLine}\n`
    + 'Answer only these, citing sources: 1) Is that profile the same person as the contact described above? Give high, medium or low confidence '
    + 'and the evidence. 2) If the contact appears to be someone else, who are they professionally (company, role)? '
    + "3) The contact's company and company website, if any. 4) A published professional contact route for the contact "
    + '(company email or email format, office phone, contact page). Do not collect home addresses of individuals, family details '
    + 'or anything unrelated to a professional introduction.\n'
    + 'End your answer with one JSON object on its own, exactly this shape: {"same_person": "high|medium|low", '
    + '"buyer_company": str|null, "buyer_role": str|null, "website": str|null, "professional_contact": str|null, '
    + '"evidence": [str], "lookup_email_is_buyers": "yes|no|unknown"}.';
}

export function interactionText(response) {
  return response.output_text || (response.steps || []).filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

// The last JSON object in the answer that carries a same_person verdict.
export function parseVerdict(answer) {
  const matches = [...String(answer || '').matchAll(/\{[^{}]*"same_person"[^{}]*(\[[^\]]*\][^{}]*)?\}/gs)];
  for (const match of matches.reverse()) {
    try {return JSON.parse(match[0]);} catch {}
  }
  return null;
}

// Cited pages: the answer's url citations, else the https links written in its text.
export function interactionSources(response, answer) {
  const urls = (response?.steps || []).flatMap((s) => s.content || []).flatMap((p) => p.annotations || [])
    .filter((a) => a.type === 'url_citation').map((a) => ({url: a.url, title: a.title || null}));
  const found = urls.length ? urls : [...String(answer || '').matchAll(/https:\/\/[^\s)\]"'<>]+/g)].map((m) => ({url: m[0].replace(/[.,;:]+$/, ''), title: null}));
  const seen = new Set();
  return found.filter((s) => {
    try {if (new URL(s.url).protocol !== 'https:') return false;} catch {return false;}
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

export function identityCostMicros(usage) {
  if (!usage) return 0;
  const cached = usage.total_cached_tokens || 0, input = Math.max(0, (usage.total_input_tokens || 0) - cached);
  const output = (usage.total_output_tokens || 0) + (usage.total_thought_tokens || 0);
  return Math.round(input * IDENTITY_TOKEN_RATES.input + cached * IDENTITY_TOKEN_RATES.cached + output * IDENTITY_TOKEN_RATES.output);
}

export class OutOfBalance extends Error {}

// Routed people search and contact lookups. Timeouts and 5xx answers are retryable; a 402 or an
// insufficient balance means stop.
export class TregClient {
  constructor(token, {fetch: request = fetch} = {}) {this.token = token; this.request = request;}
  async call(endpoint, body, {maxCost, key, timeoutMs = 120000, headers = {}, signal}) {
    let response, raw;
    try {
      response = await this.request(TREG + endpoint, {method: 'POST', body: JSON.stringify(body),
        headers: {'content-type': 'application/json', 'x-treg-token': this.token, 'x-treg-route-max-cost': maxCost, 'idempotency-key': key, ...headers},
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)});
      raw = await response.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error('The lookup timed out.'), {retryable: true});
    }
    if (response.status === 402 || raw.includes('insufficient_balance')) throw new OutOfBalance('The lookup balance has run out.');
    if (response.status >= 500 || response.status === 429) throw Object.assign(new Error(`The lookup service answered ${response.status}.`), {retryable: true});
    if (!response.ok) return {output: null, servedBy: null, charged: 0, error: response.status};
    const data = JSON.parse(raw);
    return {output: data.output ?? null, servedBy: data._treg?.served_by || null, charged: data._treg?.charged_micro || 0, error: null};
  }
}

export class CrmEnrichment {
  constructor({store, crm, secrets, treg, research, now = () => Date.now(), pollMs = 30000, retryMs = 5000, lanes = LANES}) {
    this.store = store; this.crm = crm; this.now = now; this.pollMs = pollMs; this.retryMs = retryMs; this.lanes = lanes;
    this.treg = treg !== undefined ? treg : (secrets.TREG_TOKEN ? new TregClient(secrets.TREG_TOKEN) : null);
    this.research = research !== undefined ? research : (secrets.GEMINI_RESEARCH_API_KEY ? new ListingResearchProvider(secrets.GEMINI_RESEARCH_API_KEY) : null);
    this.dailyCapMicros = Math.round(Number(secrets.CRM_ENRICH_DAILY_CAP_USD ?? DEFAULT_DAILY_CAP_USD) * 1e6);
    this.active = new Map(); this.closed = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS crm_jobs(id TEXT PRIMARY KEY,contact TEXT NOT NULL,step TEXT NOT NULL,status TEXT NOT NULL,
      run TEXT,after TEXT,by_email TEXT,attempts INTEGER NOT NULL DEFAULT 0,cost_micros INTEGER NOT NULL DEFAULT 0,cost TEXT,
      provider_id TEXT,state TEXT NOT NULL DEFAULT '{}',created INTEGER NOT NULL,started INTEGER,finished INTEGER,result TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS idx_crm_jobs_contact ON crm_jobs(contact,created);
      CREATE INDEX IF NOT EXISTS idx_crm_jobs_status ON crm_jobs(status,created);
      CREATE TABLE IF NOT EXISTS crm_runs(id TEXT PRIMARY KEY,by_email TEXT,created INTEGER NOT NULL,cap_micros INTEGER NOT NULL,contacts INTEGER NOT NULL);`);
  }

  job(id) {
    const r = this.store.one('SELECT * FROM crm_jobs WHERE id=?', id);
    return r && {...r, state: JSON.parse(r.state), result: JSON.parse(r.result ?? 'null'), cost: JSON.parse(r.cost ?? 'null')};
  }
  save(job, patch) {
    Object.assign(job, patch);
    this.store.write(`UPDATE crm_jobs SET status=?,attempts=?,cost_micros=?,cost=?,provider_id=?,state=?,started=?,finished=?,result=?,error=? WHERE id=?`,
      job.status, job.attempts, job.cost_micros, JSON.stringify(job.cost ?? null), job.provider_id ?? null, JSON.stringify(job.state),
      job.started ?? null, job.finished ?? null, JSON.stringify(job.result ?? null), job.error ?? null, job.id);
    return job;
  }
  public(job) {
    const {id, contact, step, status, run, attempts, cost_micros: costMicros, created, started, finished, error} = job;
    return {id, contact, step, status, run, attempts, costMicros, created, started, finished, error};
  }

  configured() {return {contacts: Boolean(this.treg), identity: Boolean(this.research)};}
  ready(step) {return step === 'identity' ? Boolean(this.research) : Boolean(this.treg);}

  // Spend so far: recorded costs, plus the estimate for jobs still running.
  spent(where, ...args) {
    const r = this.store.one(`SELECT COALESCE(SUM(CASE WHEN status='running' AND finished IS NULL THEN MAX(cost_micros,
      CASE step WHEN 'identity' THEN ${STEP_ESTIMATE_MICROS.identity} WHEN 'contacts' THEN ${STEP_ESTIMATE_MICROS.contacts} ELSE ${STEP_ESTIMATE_MICROS.profile} END)
      ELSE cost_micros END),0) AS micros FROM crm_jobs WHERE ${where}`, ...args);
    return r.micros;
  }
  spentToday() {return this.spent('started>=?', dayStart(this.now()));}

  status() {
    const since = this.now() - 7 * 86400000;
    const jobs = this.store.query(`SELECT * FROM crm_jobs WHERE created>? OR status IN ('queued','running') ORDER BY created`, since).map((r) => this.public(r));
    const latest = this.store.one('SELECT * FROM crm_runs ORDER BY created DESC LIMIT 1');
    const run = latest && {id: latest.id, created: latest.created, contacts: latest.contacts, capMicros: latest.cap_micros, spentMicros: this.spent('run=?', latest.id),
      active: this.store.one("SELECT COUNT(*) AS n FROM crm_jobs WHERE run=? AND status IN ('queued','running')", latest.id).n};
    return {configured: this.configured(), lanes: this.lanes, jobs, spend: {todayMicros: this.spentToday(), dailyCapMicros: this.dailyCapMicros, run}};
  }

  activeJob(contact, step) {
    return this.store.one("SELECT id FROM crm_jobs WHERE contact=? AND step=? AND status IN ('queued','running')", contact, step)?.id;
  }
  insert(contact, step, {run = null, after = null, byEmail = null} = {}) {
    const existing = this.activeJob(contact, step);
    if (existing) return existing;
    const id = randomUUID();
    this.store.write('INSERT INTO crm_jobs(id,contact,step,status,run,after,by_email,created) VALUES(?,?,?,?,?,?,?,?)', id, contact, step, 'queued', run, after, byEmail, this.now());
    return id;
  }

  // The steps a contact still needs for an action. "contacts" adds a profile search first when no
  // profile matches yet.
  stepsFor(contact, action) {
    if (action === 'identity') return ['identity'];
    if (action !== 'contacts') fail(400, 'Unknown action.');
    return pickProfile(contact) ? ['contacts'] : ['profile', 'contacts'];
  }

  // A per-contact action from the Outreach tab.
  request(contactId, action, byEmail) {
    const contact = this.crm.get(contactId), steps = this.stepsFor(contact, action);
    for (const step of steps) if (!this.ready(step)) fail(503, 'This lookup is not set up on the server yet.');
    if (this.spentToday() + steps.reduce((sum, s) => sum + STEP_ESTIMATE_MICROS[s], 0) > this.dailyCapMicros) fail(429, "Today's spending limit is reached.");
    let after = action === 'identity' ? this.activeJob(contactId, 'contacts') || this.activeJob(contactId, 'profile') || null : null;
    for (const step of steps) after = this.insert(contactId, step, {after, byEmail});
    queueMicrotask(() => this.pump());
    return this.status();
  }

  // Contacts not yet enriched and the steps each still needs. Parked contacts wait.
  plan() {
    const busy = new Set(this.store.query("SELECT DISTINCT contact FROM crm_jobs WHERE status IN ('queued','running')").map((r) => r.contact));
    // A contact whose profile search already found nothing is not searched again by a bulk run.
    const searched = new Set(this.store.query("SELECT DISTINCT contact FROM crm_jobs WHERE step='profile' AND status='done' AND json_extract(result,'$.noMatch')=1").map((r) => r.contact));
    const contacts = this.crm.list().contacts.filter((c) => !busy.has(c.id) && !c.details?.identity && !(searched.has(c.id) && !pickProfile(c))
      && !['not_interested', 'do_not_contact'].includes(c.status) && c.details?.segment !== 'parked');
    const items = contacts.map((c) => ({id: c.id, steps: [...(pickProfile(c) ? [] : ['profile']), ...(c.details?.lookup ? [] : ['contacts']), 'identity']}));
    const estimateMicros = items.reduce((sum, item) => sum + item.steps.reduce((s, step) => s + STEP_ESTIMATE_MICROS[step], 0), 0);
    return {contacts: items.length, steps: Object.fromEntries(ENRICH_STEPS.map((s) => [s, items.filter((i) => i.steps.includes(s)).length])),
      estimateMicros, items, configured: this.configured()};
  }

  // "Enrich all", confirmed with the cap the person agreed to.
  start(capUsd, byEmail) {
    const cap = Math.round(Number(capUsd) * 1e6);
    if (!(cap > 0 && cap <= 1000e6)) fail(400, 'Send a spending limit between $0 and $1,000.');
    if (!this.treg || !this.research) fail(503, 'This lookup is not set up on the server yet.');
    const plan = this.plan();
    if (!plan.contacts) fail(400, 'Every contact is already enriched.');
    const run = randomUUID();
    this.store.write('INSERT INTO crm_runs VALUES(?,?,?,?,?)', run, byEmail || null, this.now(), cap, plan.contacts);
    for (const item of plan.items) {
      let after = null;
      for (const step of item.steps) after = this.insert(item.id, step, {run, after, byEmail});
    }
    queueMicrotask(() => this.pump());
    return this.status();
  }

  // After a restart: lookups that were running go back to the queue and reuse their request keys, so a
  // lookup the provider already answered is not charged twice. An identity check that has a provider
  // interaction is polled again; one interrupted before the interaction existed fails cleanly.
  recover() {
    for (const r of this.store.query("SELECT id FROM crm_jobs WHERE status='running'")) {
      const job = this.job(r.id);
      if (job.step !== 'identity') this.save(job, {status: 'queued'});
      else if (!job.provider_id) this.save(job, {status: 'failed', finished: this.now(), error: 'The server restarted while the check was starting. Run it again.'});
    }
    this.pump();
  }

  pump() {
    if (this.closed) return;
    const busy = {lookup: 0, identity: 0};
    for (const state of this.active.values()) busy[state.lane]++;
    for (const r of this.store.query("SELECT id FROM crm_jobs WHERE status IN ('queued','running') ORDER BY created, rowid")) {
      if (this.active.has(r.id)) continue;
      const job = this.job(r.id), l = lane(job.step);
      if (busy[l] >= this.lanes[l]) continue;
      if (job.after) {
        const dep = this.job(job.after);
        if (dep && !JOB_TERMINAL.includes(dep.status)) continue;
        const blocked = dep && (dep.status !== 'done' || (job.run && dep.result?.noMatch));
        if (blocked) {
          this.save(job, {status: 'skipped', finished: this.now(), error: dep.result?.noMatch ? 'No matching profile was found.' : 'The earlier step did not finish.'});
          continue;
        }
      }
      if (job.status === 'queued' && !this.withinLimits(job)) continue;
      busy[l]++;
      const state = {lane: l, controller: new AbortController()};
      this.active.set(job.id, state);
      state.done = this.work(job, state).finally(() => {this.active.delete(job.id); this.pump();});
    }
  }

  withinLimits(job) {
    const estimate = STEP_ESTIMATE_MICROS[job.step];
    if (this.spentToday() + estimate > this.dailyCapMicros) {
      this.save(job, {status: 'stopped', finished: this.now(), error: "Today's spending limit is reached."});
      return false;
    }
    if (job.run) {
      const run = this.store.one('SELECT cap_micros FROM crm_runs WHERE id=?', job.run);
      if (this.spent('run=?', job.run) + estimate > run.cap_micros) {
        this.save(job, {status: 'stopped', finished: this.now(), error: 'This run reached its spending limit.'});
        return false;
      }
    }
    return true;
  }

  async work(job, state) {
    this.save(job, {status: 'running', started: job.started ?? this.now(), attempts: job.attempts + 1, error: null});
    try {
      const contact = this.crm.get(job.contact);
      const result = job.step === 'profile' ? await this.runProfile(job, contact, state.controller.signal)
        : job.step === 'contacts' ? await this.runContacts(job, contact, state.controller.signal)
          : await this.runIdentity(job, state.controller.signal);
      if (this.closed || !result) return;
      this.save(job, {status: 'done', finished: this.now(), result});
    } catch (error) {
      if (this.closed) return;
      if (error instanceof OutOfBalance) return this.stopLookups(job);
      this.save(job, {status: 'failed', finished: this.now(), error: error.status === 404 ? 'The contact was removed.' : error.message.slice(0, 300)});
    }
  }

  // The balance ran out: this lookup and every queued lookup stop, so nothing is half-recorded.
  stopLookups(job) {
    const error = 'The lookup balance ran out. Add balance, then run it again.';
    this.save(job, {status: 'stopped', finished: this.now(), error});
    this.store.write("UPDATE crm_jobs SET status='stopped',finished=?,error=? WHERE status='queued' AND step IN ('profile','contacts')", this.now(), error);
  }

  // Exponential backoff with jitter for a busy or slow provider.
  backoff(attempt) {return Math.min(MAX_BACKOFF_MS, this.retryMs * 2 ** (attempt - 1)) * (0.75 + Math.random() / 2);}

  // One provider call with its own request key kept in the job, retried with backoff on timeouts,
  // rate limits and server errors.
  async lookup(job, name, endpoint, body, options, signal) {
    job.state.keys ??= {};
    job.state.keys[name] ??= randomUUID();
    this.save(job, {});
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.treg.call(endpoint, body, {...options, key: job.state.keys[name], signal});
        this.save(job, {cost_micros: job.cost_micros + result.charged, cost: {...job.cost, [name]: {micros: result.charged, servedBy: result.servedBy}}});
        return result;
      } catch (error) {
        if (!error.retryable || attempt >= RETRIES || this.closed) throw error;
        this.save(job, {attempts: job.attempts + 1});
        await sleep(this.backoff(attempt), undefined, {signal});
      }
    }
  }

  async runProfile(job, contact, signal) {
    const q = profileQuery(contact);
    const found = await this.lookup(job, 'profile', 'treg.people.search', {q, country: 'US', limit: 5},
      {maxCost: '0.05', timeoutMs: 45000, headers: {'x-treg-route-prefer': 'exa', 'x-treg-route-waterfall': '0'}}, signal);
    const people = (found.output?.people || []).slice(0, 5).map((row) => candidateFromSearch(row, contact.name));
    const latest = this.crm.get(contact.id), known = new Set((latest.candidates || []).map((p) => p.url));
    this.crm.saveEnrichment(contact.id, {candidates: [...(latest.candidates || []), ...people.filter((p) => !known.has(p.url))]}, this.now());
    const matched = people.filter((p) => p.name_match && linkedin(p.url)).length;
    return {query: q, candidates: people.length, matched, noMatch: !matched};
  }

  async runContacts(job, contact, signal) {
    const url = pickProfile(contact);
    if (!url) return {noMatch: true};
    job.state.found ??= {};
    for (const [kind, endpoint] of Object.entries(LOOKUPS)) {
      if (job.state.found[kind] && !job.state.found[kind].error) continue;
      const result = await this.lookup(job, kind, endpoint, {linkedin_url: url}, {maxCost: '0.50'}, signal);
      job.state.found[kind] = {output: result.output, error: result.error};
      this.save(job, {});
    }
    const lookup = lookupFromResults(job.state.found, url, day(this.now()));
    this.applyDetails(contact.id, {lookup});
    return {profileUrl: url, email: Boolean(lookup.workEmail || lookup.personalEmail), phone: Boolean(lookup.phone)};
  }

  async runIdentity(job, signal) {
    if (!job.provider_id) {
      const contact = this.crm.get(job.contact);
      let created;
      // A rate-limited start is refused before anything runs, so it is safe to retry.
      for (let attempt = 1; ; attempt++) {
        try {
          created = await this.research.call('POST', '', {agent: IDENTITY_AGENT, input: identityPrompt(contact), background: true,
            agent_config: {type: 'deep-research', thinking_summaries: 'auto'}}, signal);
          break;
        } catch (error) {
          if (error.statusCode !== 429 || attempt >= RETRIES || this.closed) throw error;
          this.save(job, {attempts: job.attempts + 1});
          await sleep(this.backoff(attempt), undefined, {signal});
        }
      }
      if (!created.id) throw new Error('The identity check did not start.');
      this.save(job, {provider_id: created.id});
    }
    let response, misses = 0;
    for (;;) {
      if (this.closed) return null;
      try {
        response = await this.research.get(job.provider_id);
        misses = 0;
      } catch (error) {
        if (++misses > 10) throw new Error('The identity check could not be reached.');
      }
      if (response && providerTerminal(response.status)) break;
      if (this.now() - job.started > IDENTITY_DEADLINE_MS) {
        await this.research.cancel(job.provider_id).catch(() => {});
        throw new Error('The identity check ran past its time limit.');
      }
      try {await sleep(this.pollMs, undefined, {signal});} catch {return null;}
    }
    const costMicros = identityCostMicros(response.usage);
    this.save(job, {cost_micros: costMicros, cost: {identity: {micros: costMicros, estimated: true, usage: response.usage || null}}});
    if (response.status !== 'completed') throw new Error('The identity check did not finish.');
    const answer = interactionText(response), verdict = parseVerdict(answer);
    const identity = identityFromVerdict(verdict, {checked: day(this.now()), sources: interactionSources(response, answer)});
    this.applyDetails(job.contact, {identity});
    return {verdict: identity.verdict, confidence: identity.confidence, parsed: Boolean(verdict), minutes: Math.round((this.now() - job.started) / 6000) / 10, answer: answer.slice(0, 40000)};
  }

  // Store a lookup or identity result on the contact, then fill fields by the enrichment rules.
  applyDetails(id, add) {
    const contact = this.crm.get(id), details = {...(contact.details || {}), ...add};
    this.crm.saveEnrichment(id, {details, ...enrichmentPatch({...contact, details})}, this.now());
  }

  settled() {return Promise.allSettled([...this.active.values()].map((s) => s.done));}
  async close() {
    this.closed = true;
    for (const state of this.active.values()) state.controller.abort(new Error('Server restarting.'));
    await this.settled();
  }
}
