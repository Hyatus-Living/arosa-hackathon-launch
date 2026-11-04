import {skel} from './skeleton.js';
import {adminTabFromSearch, renderOutreach, renderOutreachSkeleton} from './crm-admin.js';
import {renderFeedback, renderFeedbackSkeleton} from './feedback-admin.js';

const dialog = document.querySelector('#admin-dialog');
const content = document.querySelector('#admin-content');
const notice = document.querySelector('#admin-notice');
const button = document.querySelector('#admin-button');
const closeButton = document.querySelector('#close-admin');

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

async function request(path, options = {}) {
  const response = await fetch('/api' + path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(120000),
    ...options,
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Sign in with an Arosa admin account.');
  }
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error || 'Admin request failed.');
    err.status = response.status;
    throw err;
  }
  return data;
}

// Areas such as "Brooklyn, NY" contain commas, so a list of them is separated by semicolons.
const splitAreas = (text) => text.split(';').map((s) => s.trim()).filter(Boolean);
const count = (value) => (value || 0).toLocaleString('en-US');
const when = (at) => new Date(at).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

function makeCheckbox(id, labelText, checked) {
  const wrap = element('label', undefined, 'admin-toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = Boolean(checked);
  wrap.append(input, element('span', labelText));
  return {wrap, input};
}

function makeField(id, labelText, value, {type = 'number', step = 'any', placeholder = '', hint = ''} = {}) {
  const wrap = element('label', undefined, 'admin-field');
  wrap.append(element('span', labelText));
  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  if (type === 'number' && step) input.step = step;
  if (placeholder) input.placeholder = placeholder;
  input.value = value !== undefined && value !== null ? String(value) : '';
  wrap.append(input);
  if (hint) wrap.append(element('small', hint));
  return {wrap, input};
}

function section(title) {
  const node = element('section', undefined, 'admin-section');
  node.append(element('h3', title));
  return node;
}

function group(title, ...children) {
  const node = element('div', undefined, 'admin-group');
  if (title) node.append(element('h4', title));
  node.append(...children);
  return node;
}

function grid(...fields) {
  const node = element('div', undefined, 'admin-grid');
  node.append(...fields.map((field) => field.wrap));
  return node;
}

function toggles(...items) {
  const node = element('div', undefined, 'admin-toggles');
  node.append(...items.map((item) => item.wrap));
  return node;
}

function statusLine() {
  const line = element('p', undefined, 'admin-status');
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  return line;
}

// Deal tiers as a small table: one row per tier, one column per measure.
function thresholdTable(rows) {
  const table = element('div', undefined, 'admin-thresholds');
  table.setAttribute('role', 'group');
  table.setAttribute('aria-label', 'Deal tiers');
  table.append(element('span'), element('span', 'Cap rate', 'admin-th'), element('span', 'Condo margin', 'admin-th'));
  for (const [tier, cap, margin] of rows) {
    table.append(element('span', tier, 'admin-tier'));
    for (const [field, measure] of [[cap, 'cap rate'], [margin, 'condo margin']]) {
      field.input.setAttribute('aria-label', `${tier} ${measure}`);
      table.append(field.input);
    }
  }
  return table;
}

function renderStatus(status) {
  if (!content) return;
  content.replaceChildren();
  content.removeAttribute('aria-busy');

  const cfg = status.adminConfig || {};
  const syncCfg = cfg.syncConfig || {};
  const dealCfg = cfg.dealSettings || {};

  const metrics = element('div', undefined, 'admin-metrics');
  for (const [label, value, detail] of [
    ['Listings', count(status.totalListings), `${count(status.activeForSale)} for sale · ${count(status.closedSold)} sold · ${count(status.activeRentals)} rentals`],
    ['Matched to NYC lot records', count(status.plutoMatchedParcels), `${count(status.highPotentialDeals)} good or great deals · ${count(status.submarketRollups)} ZIP code summaries`],
    ['Automatic refresh', syncCfg.autoSyncEnabled ? `Every ${syncCfg.syncIntervalHours || 6} hours` : 'Off', status.lastIngestedAt ? `Last refresh ${when(status.lastIngestedAt)}` : 'Not run yet'],
  ]) {
    const card = element('div', undefined, 'admin-metric-card');
    card.append(element('span', label), element('strong', value), element('small', detail));
    metrics.append(card);
  }
  content.append(metrics);

  // Listing refresh: where listings come from and how often.
  const autoSyncToggle = makeCheckbox('admin-auto-sync', 'Refresh listings automatically', syncCfg.autoSyncEnabled);
  const intervalField = makeField('admin-sync-interval', 'Refresh every (hours)', syncCfg.syncIntervalHours ?? 6, {step: '1'});
  const locationsField = makeField('admin-locations', 'Areas to cover', (syncCfg.locations || []).join('; '), {type: 'text', hint: 'Separate areas with semicolons, as in Brooklyn, NY; 11217.'});
  const onDemandToggle = makeCheckbox('admin-ondemand-sync', 'Fetch listings for an area when a search finds none', syncCfg.onDemandSyncIfEmpty !== false);
  const fullPullToggle = makeCheckbox('admin-full-for-sale-pull', 'Fetch every whole lot for sale in each borough, past the per-type limit', syncCfg.fullForSalePull !== false);
  const writeThroughToggle = makeCheckbox('admin-writethrough-comps', 'Keep listings found by people’s comparable searches', syncCfg.writeThroughComps !== false);
  const enrichPlutoToggle = makeCheckbox('admin-enrich-pluto', 'Match NYC listings to city lot records for zoning and floor area', syncCfg.enrichPluto !== false);
  const limitField = makeField('admin-limit-per-type', 'Listings per type and borough', syncCfg.limitPerType ?? 300, {step: '10'});
  const deltaHoursField = makeField('admin-updated-hours', 'Only listings updated in the last (hours)', syncCfg.updatedInPastHours ?? '', {step: '1', placeholder: 'All listings'});
  const pastDaysField = makeField('admin-past-days', 'Sold listings from the last (days)', syncCfg.pastDays ?? 180, {step: '1'});

  const syncSection = section('Listing refresh');
  syncSection.append(
    group('', toggles(autoSyncToggle), grid(intervalField, locationsField)),
    group('What to fetch', toggles(onDemandToggle, fullPullToggle, writeThroughToggle, enrichPlutoToggle), grid(limitField, deltaHoursField, pastDaysField)),
  );
  content.append(syncSection);

  // Deal scoring: the cost and yield assumptions behind each deal's tier.
  const hardCostField = makeField('admin-hard-cost', 'Rental hard cost ($ per gross sq ft)', dealCfg.rentalHardCostPerGrossSqft ?? dealCfg.hardCostPerGrossSqft ?? 375, {step: '5'});
  const condoHardCostField = makeField('admin-condo-hard-cost', 'Condo hard cost ($ per gross sq ft)', dealCfg.condoHardCostPerGrossSqft ?? dealCfg.hardCostPerGrossSqft ?? 375, {step: '5'});
  const softCostField = makeField('admin-soft-cost', 'Soft cost (share of hard cost)', dealCfg.softCostPctOfHard ?? 0.22, {step: '0.01'});
  const carryField = makeField('admin-carry-cost', 'Carry and financing (share of cost)', dealCfg.carryAndFinancingPct ?? 0.10, {step: '0.01'});
  const opexField = makeField('admin-opex-ratio', 'Operating expenses (share of income)', dealCfg.operatingExpenseRatio ?? 0.30, {step: '0.01'});
  const grossFactorField = makeField('admin-gross-factor', 'Gross area per zoning sq ft', dealCfg.zfaToGrossFactor ?? 1.15, {step: '0.01'});
  const netEffField = makeField('admin-net-eff', 'Sellable share of zoning area', dealCfg.zfaToNetEfficiency ?? 0.85, {step: '0.01'});
  const tierInput = (id, value, step) => makeField(id, '', value, {step});
  const greatCapField = tierInput('admin-great-cap', dealCfg.greatDealCapRate ?? 0.085, '0.0025');
  const goodCapField = tierInput('admin-good-cap', dealCfg.goodDealCapRate ?? 0.0725, '0.0025');
  const badCapField = tierInput('admin-bad-cap', dealCfg.badDealCapRate ?? 0.060, '0.0025');
  const greatMarginField = tierInput('admin-great-margin', dealCfg.greatDealCondoMargin ?? 0.28, '0.01');
  const goodMarginField = tierInput('admin-good-margin', dealCfg.goodDealCondoMargin ?? 0.18, '0.01');
  const badMarginField = tierInput('admin-bad-margin', dealCfg.badDealCondoMargin ?? 0.10, '0.01');

  const dealSection = section('Deal scoring');
  dealSection.append(
    group('Costs', grid(hardCostField, condoHardCostField, softCostField, carryField, opexField)),
    group('Building size', grid(grossFactorField, netEffField)),
    group('Deal tiers', thresholdTable([
      ['Great', greatCapField, greatMarginField],
      ['Good', goodCapField, goodMarginField],
      ['Fair', badCapField, badMarginField],
    ])),
  );
  content.append(dealSection);

  // Run now: one-off refresh and rescore.
  const syncLocField = makeField('admin-sync-target', 'Area', '', {type: 'text', placeholder: 'All areas, or e.g. 11217'});
  const opsSection = section('Run now');
  const opsStatus = statusLine();
  const opsActions = element('div', undefined, 'admin-actions');
  const runSyncBtn = element('button', 'Refresh listings', 'admin-secondary');
  runSyncBtn.type = 'button';
  runSyncBtn.id = 'admin-run-sync';
  const runRevalueBtn = element('button', 'Rescore deals', 'admin-secondary');
  runRevalueBtn.type = 'button';
  runRevalueBtn.id = 'admin-run-revalue';
  const runOperation = async (control, busyLabel, startText, call, done) => {
    const label = control.textContent;
    runSyncBtn.disabled = runRevalueBtn.disabled = true;
    control.textContent = busyLabel;
    opsStatus.textContent = startText;
    try {
      const res = await call();
      opsStatus.textContent = done(res);
      if (res.storeStatus) {
        renderStatus(res.storeStatus);
        const status = content.querySelector('#admin-run-sync')?.closest('.admin-section')?.querySelector('.admin-status');
        if (status) status.textContent = done(res);
      }
    } catch (err) {
      opsStatus.textContent = err.message;
    } finally {
      control.textContent = label;
      runSyncBtn.disabled = runRevalueBtn.disabled = false;
    }
  };
  runSyncBtn.addEventListener('click', () => {
    const customLocs = splitAreas(syncLocField.input.value);
    void runOperation(runSyncBtn, 'Refreshing…', 'Fetching listings and matching them to lot records…',
      () => request('/admin/market-store/sync', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(customLocs.length ? {locations: customLocs} : {})}),
      (res) => `Refresh done: ${count(res.fetchedCount)} found, ${count(res.insertedCount)} new, ${count(res.updatedCount)} updated, ${count(res.plutoMatchedCount)} matched to lot records.`);
  });
  runRevalueBtn.addEventListener('click', () => {
    void runOperation(runRevalueBtn, 'Rescoring…', 'Matching unmatched listings and rescoring deals…',
      () => request('/admin/market-store/revalue', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({enrichPluto: true})}),
      (res) => `${count(res.plutoMatched)} listings newly matched, ${count(res.revaluedCount)} deals rescored.`);
  });
  opsActions.append(runSyncBtn, runRevalueBtn);
  const opsRow = element('div', undefined, 'admin-ops');
  opsRow.append(syncLocField.wrap, opsActions);
  opsSection.append(opsRow, opsStatus);
  content.append(opsSection);

  if (Array.isArray(status.recentSyncs) && status.recentSyncs.length) {
    const historySection = section('Recent refreshes');
    const list = element('ol', undefined, 'admin-sync-list');
    for (const run of status.recentSyncs) {
      const item = element('li');
      const state = String(run.status || '').replace(/^./, (c) => c.toUpperCase());
      item.append(
        element('span', [state, (run.locations || []).join(', ')].filter(Boolean).join(' · ')),
        element('span', `${count(run.fetchedCount)} found · ${count(run.insertedCount)} new · ${when(run.startedAt)}`),
      );
      list.append(item);
    }
    historySection.append(list);
    content.append(historySection);
  }

  // One primary action for the whole dialog, pinned to its foot.
  const footer = element('div', undefined, 'admin-footer');
  const revalueToggle = makeCheckbox('admin-revalue-on-save', 'Rescore existing deals on save', true);
  const saveStatus = statusLine();
  const saveBtn = element('button', 'Save settings', 'admin-primary');
  saveBtn.type = 'button';
  saveBtn.id = 'admin-save-config';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    saveStatus.textContent = '';
    try {
      const locs = splitAreas(locationsField.input.value);
      const rawDelta = deltaHoursField.input.value.trim();
      const payload = {
        revalueDeals: revalueToggle.input.checked,
        syncConfig: {
          autoSyncEnabled: autoSyncToggle.input.checked,
          onDemandSyncIfEmpty: onDemandToggle.input.checked,
          writeThroughComps: writeThroughToggle.input.checked,
          enrichPluto: enrichPlutoToggle.input.checked,
          fullForSalePull: fullPullToggle.input.checked,
          syncIntervalHours: Number(intervalField.input.value),
          limitPerType: Number(limitField.input.value),
          updatedInPastHours: rawDelta ? Number(rawDelta) : null,
          pastDays: Number(pastDaysField.input.value),
          locations: locs,
        },
        dealSettings: {
          hardCostPerGrossSqft: Number(hardCostField.input.value),
          rentalHardCostPerGrossSqft: Number(hardCostField.input.value),
          condoHardCostPerGrossSqft: Number(condoHardCostField.input.value),
          softCostPctOfHard: Number(softCostField.input.value),
          carryAndFinancingPct: Number(carryField.input.value),
          zfaToGrossFactor: Number(grossFactorField.input.value),
          zfaToNetEfficiency: Number(netEffField.input.value),
          operatingExpenseRatio: Number(opexField.input.value),
          greatDealCapRate: Number(greatCapField.input.value),
          goodDealCapRate: Number(goodCapField.input.value),
          badDealCapRate: Number(badCapField.input.value),
          greatDealCondoMargin: Number(greatMarginField.input.value),
          goodDealCondoMargin: Number(goodMarginField.input.value),
          badDealCondoMargin: Number(badMarginField.input.value),
        },
      };
      const res = await request('/admin/market-store/config', {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const saved = `Saved. ${count(res.revaluedCount)} deals rescored.`;
      if (res.storeStatus) {
        renderStatus(res.storeStatus);
        const status = content.querySelector('.admin-footer .admin-status');
        if (status) status.textContent = saved;
      } else saveStatus.textContent = saved;
    } catch (err) {
      saveStatus.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save settings';
    }
  });
  footer.append(revalueToggle.wrap, saveStatus, saveBtn);
  content.append(footer);
}

function renderSkeleton() {
  content.setAttribute('aria-busy', 'true');
  const status = element('span', 'Loading settings', 'sr-only');
  status.setAttribute('role', 'status');
  const metrics = element('div', undefined, 'admin-metrics');
  for (let i = 0; i < 3; i++) metrics.append(skel('skel-figure', {height: '92px'}));
  const block = () => {
    const box = element('div', undefined, 'admin-section');
    box.append(skel('skel-text', {width: '30%'}), skel('skel-block', {height: '120px', marginTop: '14px'}));
    return box;
  };
  content.replaceChildren(status, metrics, block(), block());
}

function renderLoadError(err) {
  content.removeAttribute('aria-busy');
  const line = element('p', undefined, 'admin-error');
  line.setAttribute('role', 'alert');
  const retry = element('button', 'Retry', 'admin-retry');
  retry.type = 'button';
  retry.addEventListener('click', () => void load());
  line.append(element('span', err.message), retry);
  content.replaceChildren(line);
}

// The admin window has three tabs: market data settings, the outreach contact list and beta feedback.
let tab = 'market';
const tabs = [...document.querySelectorAll('[data-admin-tab]')];
function selectTab(next) {
  tab = next;
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.adminTab === next));
  dialog.classList.toggle('admin-wide', next !== 'market');
  notice.textContent = '';
  rendered = false;
  void load();
}
for (const t of tabs) t.addEventListener('click', () => selectTab(t.dataset.adminTab));

async function loadOutreach() {
  renderOutreachSkeleton(content);
  try {
    renderOutreach(content, await request('/admin/crm'), {request});
  } catch (err) {
    renderLoadError(err);
  }
}

async function loadFeedback() {
  renderFeedbackSkeleton(content);
  try {
    renderFeedback(content, await request('/admin/feedback'), {request});
  } catch (err) {
    renderLoadError(err);
  }
}

let rendered = false;
async function load() {
  if (tab === 'crm') return loadOutreach();
  if (tab === 'feedback') return loadFeedback();
  if (!rendered) renderSkeleton();
  try {
    renderStatus(await request('/admin/market-store'));
    rendered = true;
  } catch (err) {
    if (rendered) notice.textContent = err.message;
    else renderLoadError(err);
  }
}

async function initAdmin() {
  if (!button || !dialog) return;
  try {
    const status = await request('/admin/market-store');
    button.hidden = false;
    renderStatus(status);
    rendered = true;
  } catch {
    button.hidden = true;
    return;
  }
  openFromLink();
}

// A shared link such as /?admin=outreach opens the admin window on that tab.
function openFromLink() {
  const linked = adminTabFromSearch(window.location?.search);
  if (!linked) return;
  const params = new URLSearchParams(window.location.search);
  params.delete('admin');
  const rest = params.toString();
  history.replaceState(history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  dialog.showModal();
  selectTab(linked);
}

if (button && dialog) {
  button.addEventListener('click', () => {
    notice.textContent = '';
    dialog.showModal();
    void load();
  });
}
if (closeButton && dialog) {
  closeButton.addEventListener('click', () => dialog.close());
}

void initAdmin();
