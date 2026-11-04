// Outreach CRM for the Arosa team: people we plan to contact or have contacted, with their status
// and a log of every reach-out. Admin only. Imported leads keep where they came from (`source`,
// `source_ref`) so a re-import updates them in place instead of duplicating them, and never
// overwrites what the team has since entered (status, email, phone, notes).
import {randomUUID} from 'node:crypto';

export const CRM_STATUSES = ['new', 'researching', 'reached_out', 'replied', 'beta_invited', 'beta_active', 'not_interested', 'do_not_contact'];
export const CRM_CHANNELS = ['email', 'phone', 'text', 'whatsapp', 'linkedin', 'in_person', 'other'];
export const APPLICANT_ROLES = {developer: 'Developer', investor: 'Investor', broker: 'Broker', architect: 'Architect', attorney: 'Land-use attorney', lender: 'Lender', other: 'Other'};
export const BETA_APPLICATIONS = 'Beta applications';
// Developers and architects ranked from DOB new-building filings (crm-filings.mjs).
export const NB_FILINGS = 'DOB new-building filings';
// Outreach groups. A parked segment stays in the list, keeps its status and is left out of bulk enrichment.
export const CRM_SEGMENTS = ['developers', 'architects', 'expediters', 'parked'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EDITABLE = ['name', 'status', 'email', 'phone', 'company', 'title', 'profile_url', 'notes', 'owner'];
// Enrichment results and the record of what people edited survive a re-import of the source list.
const KEPT_DETAILS = ['lookup', 'identity', 'edited', 'segment'];
const ENRICHED = ['email', 'phone', 'company', 'title', 'profile_url', 'status', 'details', 'candidates'];

function fail(status, message) {const error = new Error(message); error.status = status; throw error;}
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const json = (value) => JSON.stringify(value ?? null);

export class Crm {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS crm_contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL,
      source_ref TEXT,status TEXT NOT NULL,email TEXT,phone TEXT,company TEXT,title TEXT,profile_url TEXT,notes TEXT,
      owner TEXT,borough TEXT,details TEXT NOT NULL DEFAULT 'null',candidates TEXT NOT NULL DEFAULT '[]',
      created INTEGER NOT NULL,updated INTEGER NOT NULL,last_contacted INTEGER,UNIQUE(source,source_ref));
      CREATE TABLE IF NOT EXISTS crm_touches(id TEXT PRIMARY KEY,contact TEXT NOT NULL,at INTEGER NOT NULL,
      by_email TEXT NOT NULL,channel TEXT NOT NULL,note TEXT);
      CREATE INDEX IF NOT EXISTS idx_crm_touches_contact ON crm_touches(contact,at);`);
  }

  row(r) {
    return {...r, details: JSON.parse(r.details), candidates: JSON.parse(r.candidates),
      touches: this.store.query('SELECT id,at,by_email AS byEmail,channel,note FROM crm_touches WHERE contact=? ORDER BY at DESC', r.id)};
  }

  list() {
    const contacts = this.store.query('SELECT * FROM crm_contacts ORDER BY CASE status WHEN \'do_not_contact\' THEN 1 ELSE 0 END, updated DESC').map(r => this.row(r));
    const counts = Object.fromEntries(CRM_STATUSES.map(status => [status, contacts.filter(c => c.status === status).length]));
    return {contacts, counts, statuses: CRM_STATUSES, channels: CRM_CHANNELS, segments: CRM_SEGMENTS};
  }

  get(id) {
    const r = this.store.one('SELECT * FROM crm_contacts WHERE id=?', id);
    if (!r) fail(404, 'Contact not found.');
    return this.row(r);
  }

  // Leads from a list (a spreadsheet, a records pull). Existing rows keep the team's own fields.
  import(source, leads, now = Date.now()) {
    source = text(source, 80);
    if (!source || !Array.isArray(leads) || !leads.length) fail(400, 'Send a source and at least one contact.');
    let created = 0, updated = 0;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const lead of leads) {
        const name = text(lead.name, 200), ref = text(String(lead.sourceRef ?? ''), 200) || null;
        if (!name) fail(400, 'Every contact needs a name.');
        const existing = ref && this.store.one('SELECT id,details FROM crm_contacts WHERE source=? AND source_ref=?', source, ref);
        if (existing) {
          const old = JSON.parse(existing.details) || {}, kept = Object.fromEntries(KEPT_DETAILS.filter(k => old[k] !== undefined).map(k => [k, old[k]]));
          const details = Object.keys(kept).length ? {...(lead.details || {}), ...kept} : lead.details;
          this.store.write('UPDATE crm_contacts SET borough=?,details=?,candidates=?,updated=? WHERE id=?',
            text(lead.borough, 120) || null, json(details), json(lead.candidates || []), now, existing.id);
          updated++;
        } else {
          this.store.write(`INSERT INTO crm_contacts(id,name,source,source_ref,status,email,phone,company,title,profile_url,notes,owner,
            borough,details,candidates,created,updated) VALUES(?,?,?,?,'new',?,?,?,?,?,NULL,NULL,?,?,?,?,?)`,
            randomUUID(), name, source, ref, text(lead.email, 200) || null, text(lead.phone, 60) || null,
            text(lead.company, 200) || null, text(lead.title, 200) || null, text(lead.profileUrl, 500) || null,
            text(lead.borough, 120) || null, json(lead.details), json(lead.candidates || []), now, now);
          created++;
        }
      }
      this.store.db.exec('COMMIT');
    } catch (error) {this.store.db.exec('ROLLBACK'); throw error;}
    return {created, updated};
  }

  // Moves every contact from one source into a segment, leaving status and the team's fields alone.
  segment(source, segment, now = Date.now()) {
    if (!CRM_SEGMENTS.includes(segment)) fail(400, 'Unknown segment.');
    const rows = this.store.query('SELECT id,details FROM crm_contacts WHERE source=?', text(source, 80));
    if (!rows.length) fail(404, 'No contacts from that source.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) this.store.write('UPDATE crm_contacts SET details=?,updated=? WHERE id=?', json({...(JSON.parse(r.details) || {}), segment}), now, r.id);
      this.store.db.exec('COMMIT');
    } catch (error) {this.store.db.exec('ROLLBACK'); throw error;}
    return {updated: rows.length};
  }

  // An application from the public beta page lands as a new contact, keyed by email, so applying
  // twice updates the application instead of adding a second contact.
  apply(input, now = Date.now()) {
    const name = text(input.name, 120), email = text(input.email, 200).toLowerCase(), role = text(input.role, 40);
    if (!name) fail(400, 'Enter your name.');
    if (!EMAIL.test(email)) fail(400, 'Enter a valid email address.');
    if (!Object.hasOwn(APPLICANT_ROLES, role)) fail(400, 'Choose what best describes you.');
    const details = {role, focus: text(input.focus, 1000) || null, appliedAt: new Date(now).toISOString().slice(0, 10)};
    this.import(BETA_APPLICATIONS, [{name, sourceRef: email, email, phone: input.phone, company: input.company, title: APPLICANT_ROLES[role], details}], now);
    return {ok: true};
  }

  // A person's edit. Every field it changes is remembered in details.edited, so enrichment never
  // overwrites or refills it.
  update(id, input, now = Date.now()) {
    const contact = this.get(id);
    const fields = EDITABLE.filter(field => Object.hasOwn(input, field));
    if (!fields.length) fail(400, 'Nothing to update.');
    if (fields.includes('status') && !CRM_STATUSES.includes(input.status)) fail(400, 'Unknown status.');
    if (fields.includes('name') && !text(input.name, 200)) fail(400, 'A contact needs a name.');
    const values = fields.map(field => field === 'notes' ? text(input.notes, 10000) || null : text(input[field], 500) || null);
    const changed = fields.filter((field, i) => values[i] !== (contact[field] ?? null));
    const details = changed.length ? {...(contact.details || {}), edited: [...new Set([...(contact.details?.edited || []), ...changed])]} : contact.details;
    this.store.write(`UPDATE crm_contacts SET ${fields.map(field => `${field}=?`).join(',')},details=?,updated=? WHERE id=?`, ...values, json(details), now, id);
    return this.get(id);
  }

  // Fields written by contact enrichment (results and the fields its rules fill).
  saveEnrichment(id, fields, now = Date.now()) {
    const names = ENRICHED.filter(field => Object.hasOwn(fields, field));
    if (!names.length) return;
    const values = names.map(field => ['details', 'candidates'].includes(field) ? json(fields[field]) : fields[field]);
    this.store.write(`UPDATE crm_contacts SET ${names.map(field => `${field}=?`).join(',')},updated=? WHERE id=?`, ...values, now, id);
  }

  // A reach-out moves a new or researching contact to "reached out".
  touch(id, byEmail, input, now = Date.now()) {
    const contact = this.get(id);
    if (!CRM_CHANNELS.includes(input.channel)) fail(400, 'Unknown channel.');
    this.store.write('INSERT INTO crm_touches VALUES(?,?,?,?,?,?)', randomUUID(), id, now, String(byEmail || ''), input.channel, text(input.note, 2000) || null);
    const status = ['new', 'researching'].includes(contact.status) ? 'reached_out' : contact.status;
    this.store.write('UPDATE crm_contacts SET last_contacted=?,status=?,updated=? WHERE id=?', now, status, now, id);
    return this.get(id);
  }

  // Granting beta access invites every contact with that email who was earlier in the funnel.
  markBetaInvited(email, now = Date.now()) {
    return this.store.write(`UPDATE crm_contacts SET status='beta_invited',updated=? WHERE lower(trim(email))=?
      AND status IN ('new','researching','reached_out','replied')`, now, String(email || '').trim().toLowerCase()).changes;
  }
}
