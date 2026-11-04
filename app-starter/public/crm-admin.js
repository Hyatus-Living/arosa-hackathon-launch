// Outreach tab of the admin window: the team's contact list, each contact's status, and a log of
// every reach-out. Possible profile matches from enrichment are leads to check, not identities.
import {skel} from './skeleton.js';

export const STATUS_LABELS = {
  new: 'New', researching: 'Researching', reached_out: 'Reached out', replied: 'Replied',
  beta_invited: 'Beta invited', beta_active: 'Beta active', not_interested: 'Not interested', do_not_contact: 'Do not contact',
};
export const SEGMENT_LABELS = {developers: 'Developers', architects: 'Architects', expediters: 'Expediters', parked: 'Parked'};
export const CHANNEL_LABELS = {email: 'Email', phone: 'Call', text: 'Text', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', in_person: 'In person', other: 'Other'};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

// Which admin tab a shared link asks for: /?admin=outreach or /?admin=market.
export function adminTabFromSearch(search) {
  const value = new URLSearchParams(search || '').get('admin');
  return {outreach: 'crm', market: 'market'}[value] || null;
}

const day = (at) => new Date(at).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});

export const VERDICT_LABELS = {confirmed: 'Confirmed', needs_review: 'Needs review', mismatch: 'Mismatch'};
export const identityOf = (contact) => contact.details?.identity?.verdict || null;

// Contacts matching the search text, status, identity and segment filters, in the order the server sent them.
export function filterContacts(contacts, {query = '', status = '', verdict = '', segment = ''} = {}) {
  const q = query.trim().toLowerCase();
  return contacts.filter((c) => (!status || c.status === status) && (!verdict || identityOf(c) === verdict) && (!segment || c.details?.segment === segment)
    && (!q || [c.name, c.email, c.phone, c.company, c.borough, c.notes].some((v) => String(v || '').toLowerCase().includes(q))));
}

export const usd = (micros) => `$${(Math.max(0, micros || 0) / 1e6).toFixed(2)}`;

// The latest job per step for each contact.
export function jobsByContact(jobs = []) {
  const out = new Map();
  for (const job of jobs) {
    const steps = out.get(job.contact) || {};
    if (!steps[job.step] || steps[job.step].created <= job.created) steps[job.step] = job;
    out.set(job.contact, steps);
  }
  return out;
}

const ACTIVE = ['queued', 'running'];
export const isActive = (job) => Boolean(job) && ACTIVE.includes(job.status);

// What a contact's research is doing, in plain words, or the last problem it hit.
export function researchStatus(steps = {}, action) {
  const jobs = action === 'identity' ? [steps.identity] : [steps.profile, steps.contacts];
  const live = jobs.find(isActive);
  if (live) {
    if (live.step === 'identity') return live.status === 'running' ? 'Checking identity, about 8 minutes' : 'Waiting to check identity';
    if (live.status === 'queued') return 'Waiting to look up';
    return live.step === 'profile' ? 'Finding profile…' : 'Looking up…';
  }
  const last = jobs.filter(Boolean).sort((a, b) => b.created - a.created)[0];
  if (!last) return '';
  if (last.status === 'done') return last.step === 'identity' ? `Checked ${new Date(last.finished).toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}` : 'Lookup finished';
  return last.error || 'Did not finish.';
}

// "Spent today $3.20 of $50.00 · This run $1.10 of $12.00"
export function spendLine(spend) {
  if (!spend) return '';
  const parts = [`Spent today ${usd(spend.todayMicros)} of ${usd(spend.dailyCapMicros)}`];
  if (spend.run) parts.push(`This run ${usd(spend.run.spentMicros)} of ${usd(spend.run.capMicros)}${spend.run.active ? `, ${spend.run.active} steps left` : ''}`);
  return parts.join(' · ');
}

const STEP_LABELS = {profile: 'Profile search', contacts: 'Contact info', identity: 'Identity check'};
const PROGRESS = [['running', 'running'], ['queued', 'queued'], ['done', 'done'], ['failed', 'failed'], ['stopped', 'stopped'], ['skipped', 'skipped']];
// Live progress by step for the jobs of the last day: "Contact info: 3 running, 2 queued, 5 done".
export function progressLines(jobs = [], now = Date.now()) {
  const recent = jobs.filter((j) => isActive(j) || j.created > now - 86400000);
  return Object.entries(STEP_LABELS).map(([step, label]) => {
    const mine = recent.filter((j) => j.step === step);
    const parts = PROGRESS.map(([status, word]) => [mine.filter((j) => j.status === status).length, word]).filter(([n]) => n);
    return parts.length ? `${label}: ${parts.map(([n, word]) => `${n} ${word}`).join(', ')}` : '';
  }).filter(Boolean);
}

export function planLine(plan) {
  const n = plan.contacts;
  return `Enrich ${n} contact${n === 1 ? '' : 's'}: about ${usd(plan.estimateMicros)}. Lookups run first, then an identity check of about 8 minutes each.`;
}

const normal = (email) => String(email || '').trim().toLowerCase();
// Whether a contact's email is on the beta tester list.
export function isBetaContact(contact, betaEmails) {
  return Boolean(contact.email) && betaEmails.has(normal(contact.email));
}

const jsonBody = (body) => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

function field(labelText, input) {
  const wrap = el('label', undefined, 'admin-field');
  wrap.append(el('span', labelText), input);
  return wrap;
}

function input(value, {type = 'text', placeholder = ''} = {}) {
  const node = document.createElement('input');
  node.type = type;
  node.value = value || '';
  if (placeholder) node.placeholder = placeholder;
  return node;
}

function select(options, value) {
  const node = document.createElement('select');
  for (const [key, label] of Object.entries(options)) {
    const option = el('option', label);
    option.value = key;
    node.append(option);
  }
  node.value = value;
  return node;
}

const plural = (count, word) => count ? `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}` : '';

// The new-building filings behind a developer or architect from the filings list: totals, then the latest three.
export function filingFacts(details) {
  if (!details?.filings) return null;
  return {totals: [plural(details.filings, 'new-building filing'), plural(details.units, 'unit'), details.boroughs?.join(', '),
    details.firstFiling && `${details.firstFiling} to ${details.lastFiling}`].filter(Boolean).join(' · '),
  recent: (details.recentFilings || []).map((f) => `${f.date}: ${f.address}, ${f.borough}, ${plural(f.units, 'unit')} (job ${f.job}, ${f.status})`)};
}

export function summaryLine(c) {
  const n = plural;
  if (c.details?.filings) return [SEGMENT_LABELS[c.details.segment]?.replace(/s$/, ''), c.company !== c.name && c.company, c.borough, n(c.details.filings, 'filing'), n(c.details.units, 'unit')].filter(Boolean).join(' · ');
  const facts = c.borough ? [c.borough, n(c.details?.primaryLots, 'lot'), n(c.details?.deeds, 'deed')] : [c.company, c.title, c.details?.appliedAt && `Applied ${c.details.appliedAt}`];
  return facts.filter(Boolean).join(' · ');
}

function renderContact(c, {request, onSaved, beta, onBetaChanged, steps = {}, onEnrich}) {
  const item = el('details', undefined, 'crm-row');
  item.dataset.id = c.id;
  const head = el('summary', undefined, 'crm-row-head');
  const who = el('span', undefined, 'crm-who');
  who.append(el('strong', c.name), el('small', summaryLine(c)));
  const pill = el('span', STATUS_LABELS[c.status], `crm-status crm-status-${c.status}`);
  const last = el('small', c.last_contacted ? `Last reached ${day(c.last_contacted)}` : 'Not reached yet', 'crm-last');
  if (beta) who.querySelector('strong').append(el('span', 'Beta tester', 'crm-beta-tag'));
  const verdict = identityOf(c);
  if (verdict) who.querySelector('strong').append(el('span', VERDICT_LABELS[verdict], `crm-verdict crm-verdict-${verdict}`));
  head.append(who, last, pill);
  item.append(head);

  const body = el('div', undefined, 'crm-body');
  const status = select(STATUS_LABELS, c.status);
  const email = input(c.email, {type: 'email'});
  const phone = input(c.phone, {type: 'tel'});
  const company = input(c.company);
  const title = input(c.title);
  const profile = input(c.profile_url, {type: 'url', placeholder: 'https://'});
  const owner = input(c.owner, {placeholder: 'Who owns this contact'});
  const notes = document.createElement('textarea');
  notes.rows = 3;
  notes.value = c.notes || '';
  const grid = el('div', undefined, 'admin-grid');
  grid.append(field('Status', status), field('Email', email), field('Phone', phone), field('Company', company),
    field('Role', title), field('Profile link', profile), field('Owner', owner));
  const saveLine = el('div', undefined, 'admin-actions');
  const save = el('button', 'Save', 'admin-primary');
  save.type = 'button';
  const saved = el('span', '', 'crm-saved');
  saved.setAttribute('role', 'status');
  saveLine.append(save);
  // Beta access belongs to the sign-in email, so only a contact with an email can get it.
  if (c.email) {
    const toggle = el('button', beta ? 'Remove beta tester' : 'Make beta tester', 'admin-secondary');
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      saved.textContent = beta ? 'Removing…' : 'Granting…';
      try {
        if (beta) await request(`/admin/beta-testers/${encodeURIComponent(normal(c.email))}`, {method: 'DELETE'});
        else await request('/admin/beta-testers', jsonBody({email: c.email}));
        await onBetaChanged();
      } catch (err) {
        saved.textContent = err.message;
        toggle.disabled = false;
      }
    });
    saveLine.append(toggle);
  }
  saveLine.append(saved);
  save.addEventListener('click', async () => {
    save.disabled = true;
    saved.textContent = 'Saving…';
    try {
      onSaved(await request(`/admin/crm/${c.id}`, {method: 'PATCH', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({status: status.value, email: email.value, phone: phone.value, company: company.value,
          title: title.value, profile_url: profile.value, owner: owner.value, notes: notes.value})}));
    } catch (err) {
      saved.textContent = err.message;
      save.disabled = false;
    }
  });
  body.append(grid, field('Notes', notes), saveLine);

  const matches = (c.candidates || []).filter((p) => p.name_match);
  if (matches.length) {
    const box = el('div', undefined, 'crm-matches');
    box.append(el('h4', 'Possible profiles'), el('small', 'Same name found online. Check before using.'));
    for (const p of matches) {
      const line = el('div', undefined, 'crm-match');
      const text = el('span', [p.name, [p.title, p.company].filter(Boolean).join(' at '), p.location].filter(Boolean).join(' · '));
      line.append(text);
      if (p.url) {
        const link = el('a', 'Open', 'crm-link');
        link.href = p.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const use = el('button', 'Use', 'admin-secondary');
        use.type = 'button';
        use.addEventListener('click', () => {
          profile.value = p.url;
          if (!company.value && p.company) company.value = p.company;
          if (!title.value && p.title) title.value = p.title;
          saved.textContent = 'Not saved yet';
        });
        line.append(link, use);
      }
      box.append(line);
    }
    body.append(box);
  }

  body.append(renderResearch(c, steps, {onEnrich}));
  const identity = c.details?.identity;
  if (identity) body.append(renderIdentity(identity));

  const lookup = c.details?.lookup;
  if (lookup && (lookup.workEmail || lookup.personalEmail || lookup.phone)) {
    const box = el('div', undefined, 'crm-matches');
    const note = identity?.verdict === 'mismatch' ? 'These belong to a different person. Keep for reference only.'
      : identity?.verdict === 'confirmed' ? 'The identity check matched this profile to the contact.'
        : 'Confirm before reaching out.';
    box.append(el('h4', 'Found by contact lookup'), el('small', `Looked up ${lookup.at} from the matched profile. ${note}`));
    const rows = [
      ['Work email', lookup.workEmail, lookup.workEmailVerified ? 'verified' : 'unverified', email],
      ['Personal email', lookup.personalEmail, lookup.personalEmailVerified ? 'verified' : 'unverified', email],
      ['Phone', lookup.phone, lookup.phoneLineType || '', phone],
    ];
    for (const [label, value, note, target] of rows) {
      if (!value) continue;
      const line = el('div', undefined, 'crm-match');
      line.append(el('span', `${label}: ${value}${note ? ` (${note})` : ''}`));
      const use = el('button', 'Use', 'admin-secondary');
      use.type = 'button';
      use.addEventListener('click', () => {
        target.value = value;
        saved.textContent = 'Not saved yet';
      });
      line.append(use);
      box.append(line);
    }
    body.append(box);
  }

  if (c.details?.focus) {
    const focus = el('p', undefined, 'crm-facts');
    focus.append(el('span', `Looks at: ${c.details.focus}`));
    body.append(focus);
  }

  const filed = filingFacts(c.details);
  if (filed) {
    const facts = el('div', undefined, 'crm-filings');
    facts.append(el('p', filed.totals));
    const recent = el('ul');
    recent.append(...filed.recent.map((line) => el('li', line)));
    facts.append(recent);
    body.append(facts);
  }

  if (c.details?.exampleDeedUrl || c.details?.firstPurchase) {
    const facts = el('p', undefined, 'crm-facts');
    facts.append(el('span', [c.details.firstPurchase && `First purchase ${c.details.firstPurchase}`, c.details.lastPurchase && `last ${c.details.lastPurchase}`].filter(Boolean).join(', ')));
    if (c.details.exampleDeedUrl) {
      const deed = el('a', 'Example deed', 'crm-link');
      deed.href = c.details.exampleDeedUrl;
      deed.target = '_blank';
      deed.rel = 'noopener noreferrer';
      facts.append(deed);
    }
    body.append(facts);
  }

  const log = el('div', undefined, 'crm-log');
  log.append(el('h4', 'Reach-outs'));
  const form = el('div', undefined, 'crm-log-form');
  const channel = select(CHANNEL_LABELS, 'email');
  const note = input('', {placeholder: 'What happened'});
  const logButton = el('button', 'Log reach-out', 'admin-secondary');
  logButton.type = 'button';
  logButton.addEventListener('click', async () => {
    logButton.disabled = true;
    try {
      onSaved(await request(`/admin/crm/${c.id}/touches`, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({channel: channel.value, note: note.value})}));
    } catch (err) {
      saved.textContent = err.message;
      logButton.disabled = false;
    }
  });
  form.append(channel, note, logButton);
  log.append(form);
  const list = el('ul', undefined, 'crm-touches');
  for (const t of c.touches || []) list.append(el('li', `${day(t.at)} · ${CHANNEL_LABELS[t.channel]}${t.note ? ` · ${t.note}` : ''} · ${t.byEmail}`));
  if (!(c.touches || []).length) list.append(el('li', 'No reach-outs yet.', 'crm-empty'));
  log.append(list);
  body.append(log);
  item.append(body);
  return item;
}

// The two research actions for one contact and what each is doing now.
function renderResearch(c, steps, {onEnrich}) {
  const box = el('div', undefined, 'crm-research');
  box.append(el('h4', 'Research'));
  for (const [action, label] of [['contacts', 'Find contact info'], ['identity', 'Verify identity']]) {
    const line = el('div', undefined, 'crm-match');
    const button = el('button', label, 'admin-secondary');
    button.type = 'button';
    const live = action === 'identity' ? isActive(steps.identity) : isActive(steps.profile) || isActive(steps.contacts);
    button.disabled = live;
    const status = el('span', researchStatus(steps, action), 'crm-saved');
    status.setAttribute('role', 'status');
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = 'Starting…';
      try {
        await onEnrich(c.id, action);
      } catch (err) {
        status.textContent = err.message;
        button.disabled = false;
      }
    });
    line.append(button, status);
    box.append(line);
  }
  return box;
}

const CONFIDENCE = {high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence', unknown: 'No clear answer'};
function renderIdentity(identity) {
  const box = el('div', undefined, 'crm-matches crm-identity');
  box.append(el('h4', `Identity: ${VERDICT_LABELS[identity.verdict]}`),
    el('small', `${CONFIDENCE[identity.confidence] || CONFIDENCE.unknown} that the matched profile is this contact. Checked ${identity.checked}.`));
  const facts = [['Company', identity.buyerCompany], ['Role', identity.buyerRole], ['Contact route', identity.professionalContact]];
  for (const [label, value] of facts) if (value) box.append(el('div', `${label}: ${value}`, 'crm-match'));
  if (identity.website) {
    const line = el('div', 'Website: ', 'crm-match');
    const link = el('a', identity.website, 'crm-link');
    link.href = /^https?:\/\//i.test(identity.website) ? identity.website : `https://${identity.website}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    line.append(link);
    box.append(line);
  }
  if (identity.lookupEmailIsBuyers === 'no') box.append(el('div', 'The looked-up email is not this contact\'s.', 'crm-match'));
  if (identity.evidence?.length) {
    const list = el('ul', undefined, 'crm-evidence');
    for (const item of identity.evidence) list.append(el('li', item));
    box.append(list);
  }
  if (identity.sources?.length) box.append(el('small', `${identity.sources.length} source${identity.sources.length === 1 ? '' : 's'} checked.`));
  return box;
}

// "Enrich all": the count and estimated cost first, then a confirming click starts the run.
function renderEnrichBar(getData, {request, onChanged}) {
  const bar = el('div', undefined, 'crm-enrich');
  const spend = el('small', '', 'crm-spend');
  const progress = el('ul', undefined, 'crm-progress');
  progress.setAttribute('aria-live', 'polite');
  const start = el('button', 'Enrich all', 'admin-secondary');
  start.type = 'button';
  const confirm = el('div', undefined, 'crm-enrich-confirm');
  const status = el('span', '', 'crm-saved');
  status.setAttribute('role', 'status');
  bar.append(start, spend, confirm, status, progress);
  const update = () => {
    const data = getData();
    spend.textContent = spendLine(data.enrichment?.spend);
    progress.replaceChildren(...progressLines(data.enrichment?.jobs).map((line) => el('li', line)));
  };
  start.addEventListener('click', async () => {
    start.disabled = true;
    status.textContent = 'Counting…';
    try {
      const plan = await request('/admin/crm/enrich/plan');
      status.textContent = '';
      if (!plan.contacts) {
        status.textContent = 'Every contact is already enriched.';
        start.disabled = false;
        return;
      }
      const go = el('button', 'Start enrichment', 'admin-primary');
      go.type = 'button';
      const cancel = el('button', 'Cancel', 'admin-secondary');
      cancel.type = 'button';
      const close = () => {confirm.replaceChildren(); start.disabled = false;};
      cancel.addEventListener('click', close);
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          await request('/admin/crm/enrich', jsonBody({capUsd: Math.ceil(plan.estimateMicros / 1e6)}));
          close();
          await onChanged();
        } catch (err) {
          status.textContent = err.message;
          go.disabled = false;
        }
      });
      confirm.replaceChildren(el('span', planLine(plan)), go, cancel);
    } catch (err) {
      status.textContent = err.message;
      start.disabled = false;
    }
  });
  update();
  return {bar, update};
}

export function renderOutreachSkeleton(content) {
  content.setAttribute('aria-busy', 'true');
  const status = el('span', 'Loading contacts', 'sr-only');
  status.setAttribute('role', 'status');
  const rows = el('div', undefined, 'crm-list');
  for (let i = 0; i < 6; i++) rows.append(skel('skel-block', {height: '54px'}));
  content.replaceChildren(status, skel('skel-text', {width: '40%'}), rows);
}

// Beta testers at the top of the tab: everyone with access, and an email field to grant it directly.
function renderBetaTesters(testers, {request, onBetaChanged}) {
  const box = el('section', undefined, 'crm-beta');
  box.setAttribute('aria-label', 'Beta testers');
  box.append(el('h4', 'Beta testers'));
  const list = el('ul', undefined, 'crm-beta-list');
  for (const t of testers) {
    const item = el('li');
    const remove = el('button', 'Remove', 'admin-secondary');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${t.email} as a beta tester`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await request(`/admin/beta-testers/${encodeURIComponent(t.email)}`, {method: 'DELETE'});
        await onBetaChanged();
      } catch (err) {
        status.textContent = err.message;
        remove.disabled = false;
      }
    });
    item.append(el('span', t.email), el('small', `Since ${day(t.grantedAt)}`), remove);
    list.append(item);
  }
  if (!testers.length) list.append(el('li', 'No beta testers yet.', 'crm-empty'));
  const form = el('form', undefined, 'crm-log-form');
  const email = input('', {type: 'email', placeholder: 'name@example.com'});
  email.setAttribute('aria-label', 'Email to make a beta tester');
  const grant = el('button', 'Make beta tester', 'admin-secondary');
  grant.type = 'submit';
  const status = el('span', '', 'crm-saved');
  status.setAttribute('role', 'status');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!email.value.trim()) return;
    grant.disabled = true;
    try {
      await request('/admin/beta-testers', jsonBody({email: email.value}));
      await onBetaChanged();
    } catch (err) {
      status.textContent = err.message;
      grant.disabled = false;
    }
  });
  form.append(email, grant, status);
  box.append(list, form);
  return box;
}

export function renderOutreach(content, data, {request}) {
  content.removeAttribute('aria-busy');
  let current = data;
  let contacts = data.contacts;
  let testers = data.betaTesters || [];
  const betaBox = el('div');
  const state = {query: '', status: '', verdict: '', segment: ''};
  const counts = el('p', undefined, 'crm-counts');
  const toolbar = el('div', undefined, 'crm-toolbar');
  const search = input('', {type: 'search', placeholder: 'Search name, email, company or notes'});
  search.setAttribute('aria-label', 'Search contacts');
  const filter = select({'': 'All statuses', ...STATUS_LABELS}, '');
  filter.setAttribute('aria-label', 'Filter by status');
  const identityFilter = select({'': 'Any identity', ...VERDICT_LABELS}, '');
  identityFilter.setAttribute('aria-label', 'Filter by identity check');
  const segmentFilter = select({'': 'All segments', ...SEGMENT_LABELS}, '');
  segmentFilter.setAttribute('aria-label', 'Filter by segment');
  toolbar.append(search, filter, identityFilter, segmentFilter);
  const list = el('div', undefined, 'crm-list');
  const rows = new Map();

  const reload = async (keepEditing = false) => {
    const next = await request('/admin/crm');
    current = next;
    contacts = next.contacts;
    testers = next.betaTesters || [];
    paint(keepEditing);
  };
  const onEnrich = async (id, action) => {
    await request(`/admin/crm/${id}/enrich`, jsonBody({action}));
    await reload();
  };
  const enrich = renderEnrichBar(() => current, {request, onChanged: () => reload()});

  // Rows are rebuilt only when their contact or research changed, and never while being edited.
  const paint = (keepEditing = false) => {
    const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.id));
    const shown = filterContacts(contacts, state);
    const tally = Object.entries(STATUS_LABELS).map(([k, label]) => [label, contacts.filter((c) => c.status === k).length]).filter(([, n]) => n);
    const verdicts = Object.entries(VERDICT_LABELS).map(([k, label]) => [label, contacts.filter((c) => identityOf(c) === k).length]).filter(([, n]) => n);
    counts.textContent = `${contacts.length} contacts${tally.length ? ': ' + tally.map(([label, n]) => `${n} ${label.toLowerCase()}`).join(', ') : ''}`
      + (verdicts.length ? `. Identity: ${verdicts.map(([label, n]) => `${n} ${label.toLowerCase()}`).join(', ')}` : '');
    const betaEmails = new Set(testers.map((t) => t.email));
    betaBox.replaceChildren(renderBetaTesters(testers, {request, onBetaChanged: () => reload()}));
    enrich.update();
    const jobs = jobsByContact(current.enrichment?.jobs);
    list.replaceChildren(...(shown.length ? shown.map((c) => {
      const steps = jobs.get(c.id) || {};
      const beta = isBetaContact(c, betaEmails);
      const key = JSON.stringify([c.updated, c.touches?.length, beta, Object.values(steps).map((j) => [j.id, j.status])]);
      const old = rows.get(c.id);
      const editing = keepEditing && old?.node.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
      if (old && (old.key === key || editing)) return old.node;
      const row = renderContact(c, {request, beta, onBetaChanged: () => reload(), steps, onEnrich,
        onSaved: (next) => {contacts = contacts.map((x) => x.id === next.id ? next : x); paint();}});
      row.open = open.has(c.id);
      rows.set(c.id, {key, node: row});
      return row;
    }) : [el('p', contacts.length ? 'No contacts match.' : 'No contacts yet. Import a list to start.', 'crm-empty')]));
  };
  // While research runs on the server the tab refreshes itself every few seconds, and stops once the
  // tab is closed. The jobs keep running either way.
  const poll = async () => {
    if (!list.isConnected) return;
    if ((current.enrichment?.jobs || []).some(isActive)) {
      try {await reload(true);} catch {}
    }
    setTimeout(poll, 4000);
  };
  search.addEventListener('input', () => {state.query = search.value; paint();});
  filter.addEventListener('change', () => {state.status = filter.value; paint();});
  identityFilter.addEventListener('change', () => {state.verdict = identityFilter.value; paint();});
  segmentFilter.addEventListener('change', () => {state.segment = segmentFilter.value; paint();});
  content.replaceChildren(betaBox, enrich.bar, counts, toolbar, list);
  paint();
  setTimeout(poll, 4000);
}
