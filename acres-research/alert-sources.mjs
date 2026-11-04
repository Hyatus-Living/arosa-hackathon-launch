// Turns durable system records into alert occurrences. Everything is polled with watermarks
// (never in-process hooks), so a service restart or a missed sweep replays safely and the
// outbox dedupe keys absorb boundary overlaps:
//   runs table            -> 'finished' for the run owner
//   project_events stream -> 'finished' for a render's creator, 'activity' for other members
//   market_listings       -> 'listings' for rules whose criteria the new row matches
// An occurrence is {dedupe, account, ruleKind, projectId, subject, body}; the runner matches
// it against the recipient's rules. Listing occurrences are pre-matched per rule and carry ruleId.
// Dedupe keys name the event and its recipient account; the runner adds the rule's cadence, so an
// event reaches each account once per cadence however many of its rules match.

const TERMINAL_RUNS = ['completed', 'failed'];
const TERMINAL_JOBS = ['succeeded', 'failed', 'cancelled'];

export function projectAccounts(store, projectId) {
  // A superset of everyone who might see the project; the authoritative projectAccess check filters it.
  const candidates = new Set();
  const project = store.project.row(projectId);
  if (!project) return [];
  candidates.add(project.owner);
  for (const c of store.query('SELECT id, owner FROM conversations WHERE project=?', projectId)) {
    candidates.add(c.owner);
    for (const m of store.query(`SELECT principal_type, principal FROM conversation_members WHERE conversation=? AND removed_at IS NULL`, c.id)) {
      if (m.principal_type === 'account') candidates.add(m.principal);
      else for (const t of store.query('SELECT account FROM team_members WHERE team=? AND removed_at IS NULL', m.principal)) candidates.add(t.account);
    }
  }
  return [...candidates].filter(account => store.projectAccess(account, projectId));
}

function projectTitle(store, projectId) {
  return store.project.row(projectId)?.title || 'Untitled site';
}

export function scanRuns(store, alerts, appUrl) {
  const since = Number(alerts.watermark('runs', '0')) || 0;
  // >= on the watermark: same-millisecond writes must not fall between sweeps; dedupe absorbs the replay.
  const rows = store.query(
    `SELECT r.*, c.title AS conversation_title, c.project AS project FROM runs r JOIN conversations c ON c.id=r.conversation
     WHERE r.status IN ('completed','failed') AND r.updated>=? ORDER BY r.updated, r.id LIMIT 500`, since);
  const out = [];
  let max = since;
  for (const r of rows) {
    max = Math.max(max, r.updated);
    if (!TERMINAL_RUNS.includes(r.status)) continue;
    const failed = r.status === 'failed';
    out.push({
      dedupe: `run:${r.id}:${r.status}`, account: r.owner, ruleKind: 'finished', projectId: r.project ?? null,
      subject: failed ? `Research run failed: ${r.conversation_title}` : `Research run finished: ${r.conversation_title}`,
      body: failed
        ? `A research run in "${r.conversation_title}" failed${r.error ? `: ${String(r.error).slice(0, 300)}` : '.'}\nOpen Arosa to retry: ${appUrl}`
        : `A research run in "${r.conversation_title}" has finished.\nOpen Arosa to read the answer: ${appUrl}`,
    });
  }
  if (rows.length) alerts.setWatermark('runs', String(max));
  return out;
}

function eventActor(store, projectId, record) {
  if (record.event === 'state.updated') {
    if (record.account) return record.account;
    if (record.run) return store.one('SELECT owner FROM runs WHERE id=?', record.run)?.owner ?? null;
    return null;
  }
  if (record.event === 'architecture.revision') {
    // Revision events from before schemes name no plan; they belong to the as-of-right plan.
    return store.one('SELECT created_by FROM architecture_plans WHERE project=? AND scheme=? AND revision=?', projectId, record.scheme ?? 'as_of_right', record.revision)?.created_by ?? null;
  }
  if (record.event === 'architecture.job') {
    return store.one('SELECT created_by FROM architecture_jobs WHERE job_id=?', record.jobId)?.created_by ?? null;
  }
  if (record.event === 'architecture.drawing') {
    return store.one('SELECT created_by FROM architecture_drawings WHERE drawing_id=?', record.drawingId)?.created_by ?? null;
  }
  return null;
}

const SCHEME_PLAN_NAMES = {as_of_right: 'as-of-right floor plan', max_bonus: 'most floor area floor plan', alternative: 'alternative floor plan'};
function describeProjectEvent(record, title) {
  if (record.event === 'architecture.job' && record.kind === 'render') return {subject: `Rendering ${record.status}: ${title}`,
    body: `The rendering of one way to build "${title}" ${record.status}${record.reason ? `: ${record.reason}` : '.'}`};
  if (record.event === 'architecture.job') return {subject: `Walkthrough render ${record.status}: ${title}`,
    body: `The walkthrough render for "${title}" (revision ${record.revision}) ${record.status}${record.reason ? `: ${record.reason}` : '.'}`};
  if (record.event === 'architecture.revision') return {subject: `New floor-plan revision: ${title}`,
    body: `Revision ${record.revision} of the ${SCHEME_PLAN_NAMES[record.scheme] ?? 'floor plan'} for "${title}" was saved.`};
  if (record.event === 'architecture.drawing') return {subject: `Drawing added: ${title}`,
    body: `A drawing ("${record.name}") was added to "${title}".`};
  if (record.event === 'state.updated') return {subject: `Site updated: ${title}`,
    body: `"${title}" changed (${(record.keys || []).join(', ') || 'site data'}).`};
  return null;
}

export function scanProjectEvents(store, alerts, appUrl) {
  const since = Number(alerts.watermark('project_events', '0')) || 0;
  const rows = store.query(
    `SELECT project, seq, event, data, time FROM project_events WHERE time>=? ORDER BY time, project, seq LIMIT 1000`, since);
  const out = [];
  let max = since;
  const accountsByProject = new Map();
  for (const row of rows) {
    max = Math.max(max, row.time);
    const record = JSON.parse(row.data);
    const desc = describeProjectEvent(record, projectTitle(store, row.project));
    if (!desc) continue;
    if (record.event === 'architecture.job' && !TERMINAL_JOBS.includes(record.status)) continue;
    const actor = eventActor(store, row.project, record);
    if (!accountsByProject.has(row.project)) accountsByProject.set(row.project, projectAccounts(store, row.project));
    const accounts = accountsByProject.get(row.project);
    const link = `${appUrl}/sites/${encodeURIComponent(row.project)}`;
    for (const account of accounts) {
      const isActor = actor !== null && account === actor;
      // The person whose render finished gets a 'finished' occurrence; everyone else with
      // access gets 'activity'. Non-render changes never alert their own author.
      if (record.event === 'architecture.job') {
        out.push({dedupe: `pe:${row.project}:${row.seq}:${account}`, account, ruleKind: isActor ? 'finished' : 'activity',
          projectId: row.project, subject: desc.subject, body: `${desc.body}\nOpen the site: ${link}`});
      } else if (!isActor) {
        out.push({dedupe: `pe:${row.project}:${row.seq}:${account}`, account, ruleKind: 'activity',
          projectId: row.project, subject: desc.subject, body: `${desc.body}\nOpen the site: ${link}`});
      }
    }
  }
  if (rows.length) alerts.setWatermark('project_events', String(max));
  return out;
}

const BOROUGHS = {manhattan: 'Manhattan', mn: 'Manhattan', brooklyn: 'Brooklyn', bk: 'Brooklyn', queens: 'Queens', qn: 'Queens', bronx: 'Bronx', 'the bronx': 'Bronx', bx: 'Bronx', 'staten island': 'Staten Island', si: 'Staten Island'};

export function listingMatches(row, criteria = {}) {
  if (criteria.borough) {
    const want = BOROUGHS[String(criteria.borough).trim().toLowerCase()] || criteria.borough;
    if (String(row.borough || '').toLowerCase() !== String(want).toLowerCase()) return false;
  }
  if (criteria.zipCode && row.zip_code !== criteria.zipCode) return false;
  if (criteria.area) {
    const area = String(criteria.area).toLowerCase();
    const fields = [row.neighborhood, row.city, row.zip_code].map(v => String(v || '').toLowerCase());
    if (!fields.includes(area)) return false;
  }
  if (criteria.zoningPrefix && !String(row.zoning_district || '').toUpperCase().startsWith(String(criteria.zoningPrefix).toUpperCase())) return false;
  if (criteria.styles?.length && !criteria.styles.includes(row.style)) return false;
  if (criteria.minListPrice !== undefined && !(row.list_price >= criteria.minListPrice)) return false;
  if (criteria.maxListPrice !== undefined && !(row.list_price <= criteria.maxListPrice)) return false;
  // Unused floor area and price per buildable SF are the card's: the building that sets the value, where valued.
  const unused = row.unused_for_lead_zfa ?? row.unused_uap_zfa, perBuildable = row.price_per_buildable_sf ?? row.uap_price_per_buildable_zfa;
  if (criteria.minUnusedZfa !== undefined && !(unused >= criteria.minUnusedZfa)) return false;
  if (criteria.maxPricePerBuildableZfa !== undefined && !(perBuildable > 0 && perBuildable <= criteria.maxPricePerBuildableZfa)) return false;
  if (criteria.dealVerdict) {
    const allowed = criteria.dealVerdict.split(',');
    if (!allowed.includes(row.deal_verdict)) return false;
  }
  if (criteria.excludeLandmarks && row.landmark_flag) return false;
  if (criteria.mihArea && row.in_mih_area !== {inside: 1, outside: 0}[criteria.mihArea]) return false;
  return true;
}

function describeListing(row) {
  const price = row.list_price ? `$${Math.round(row.list_price).toLocaleString('en-US')}` : 'price on request';
  const unused = row.unused_for_lead_zfa ?? row.unused_uap_zfa;
  const zfa = unused ? `${Math.round(unused).toLocaleString('en-US')} unused ZFA` : 'unused ZFA n/a';
  const verdict = row.deal_verdict ? row.deal_verdict.replaceAll('_', ' ') : 'unrated';
  const mih = row.in_mih_area ? `, in MIH area ${JSON.parse(row.mih_area_json).name}` : '';
  return `${row.address || 'Address unavailable'} (${row.borough || ''} ${row.zip_code || ''}): ${price}, ${zfa}, verdict: ${verdict}${mih}${row.url ? `\n${row.url}` : ''}`;
}

export function scanListings(marketStore, alerts) {
  if (!marketStore) return [];
  const rules = alerts.allListingRules();
  if (!rules.length) return [];
  const since = Math.min(...rules.map(r => r.seenUntil || r.createdAt));
  const rows = marketStore.query(
    `SELECT * FROM market_listings WHERE listing_type='for_sale' AND first_seen_at>? ORDER BY first_seen_at, id LIMIT 5000`, since);
  const out = [];
  const advanced = new Map();
  // A listing is matched and described with the figures its subscriber's card shows: valued at their saved
  // costs (house costs when they saved none), its tier, price per buildable SF and unused floor area.
  const savedCosts = new Map(), deals = new Map();
  const asCard = (account, row) => {
    if (!savedCosts.has(account)) {
      const saved = marketStore.getUserDealSettings(account);
      savedCosts.set(account, saved.isCustom ? saved.dealSettings : null);
    }
    const costs = savedCosts.get(account), key = `${costs ? account : ''}\u001f${row.id}`;
    if (!deals.has(key)) deals.set(key, marketStore.searchDeals({listingId: row.id, customSettings: costs})[0] ?? null);
    const deal = deals.get(key);
    return deal ? {...row, deal_verdict: deal.flashcardValuation?.dealVerdict ?? null, price_per_buildable_sf: deal.pricePerBuildableSf ?? null, unused_for_lead_zfa: deal.unusedForLeadZfa ?? null} : row;
  };
  const byCard = {dealVerdict: undefined, maxPricePerBuildableZfa: undefined, minUnusedZfa: undefined};
  for (const row of rows) {
    for (const rule of rules) {
      advanced.set(rule.id, Math.max(advanced.get(rule.id) || 0, row.first_seen_at));
      if (row.first_seen_at <= (rule.seenUntil || rule.createdAt)) continue;
      if (!listingMatches(row, {...rule.criteria, ...byCard})) continue;
      const seen = asCard(rule.account, row);
      if (!listingMatches(seen, rule.criteria)) continue;
      out.push({dedupe: `listing:${rule.account}:${row.id}`, account: rule.account, ruleKind: 'listings', ruleId: rule.id, projectId: null,
        subject: `New listing match: ${row.address || 'NYC development site'}`,
        body: `A new deal-store listing matches your alert criteria.\n${describeListing(seen)}`});
    }
  }
  for (const [ruleId, seenUntil] of advanced) alerts.advanceListingWatermark(ruleId, seenUntil);
  return out;
}
