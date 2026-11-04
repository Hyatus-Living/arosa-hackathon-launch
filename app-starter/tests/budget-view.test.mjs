import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderSchemeBudget} from '../public/budget-view.js';
import {budgetBreakdownSection, budgetSplitsFields, groupStatus, toStore} from '../public/budget-splits-form.js';
import {budgetFor, budgetSplitOptions, DEFAULT_BUDGET_SPLITS} from '../../acres-research/budget-lines.mjs';

const flush = () => new Promise(setImmediate);
function dom() {
  const {document, window} = parseHTML('<!doctype html><html><body><div id="slot"></div></body></html>');
  globalThis.document = document;
  return {document, window, slot: document.querySelector('#slot')};
}
const costs = {hardCostPerGrossSqft: 410, grossSqft: 20_000, hardCost: 8_200_000, softCost: 1_804_000, wagePremium: 0, land: 3_900_000, transferTax: 0, closingCosts: 58_500};
costs.financing = (costs.land + costs.closingCosts + costs.hardCost + costs.softCost) * 0.1;
const totalCost = Math.round(costs.land + costs.closingCosts + costs.hardCost + costs.softCost + costs.financing);
const scheme = {id: 'as_of_right', program: {storeys: 7, grossSqft: 20_000}, returns: {costs, totalCost, landBasis: 'ask'}};

test('a scheme budget shows the four groups and its total, and every line with its basis on request', () => {
  const {slot} = dom();
  renderSchemeBudget(slot, budgetFor(scheme));
  const rows = [...slot.querySelectorAll('.scheme-budget > table tbody tr')].map(tr => tr.querySelector('th').textContent);
  assert.deepEqual(rows, ['Land and acquisition', 'Hard costs', 'Soft costs', 'Financing and carry', 'Total cost']);
  assert.equal(slot.querySelector('.scheme-budget > table .is-total td').textContent, '$15.36M');
  const detail = slot.querySelector('details.scheme-budget-detail');
  assert.equal(detail.querySelector('summary').textContent, 'Every line');
  const lines = [...detail.querySelectorAll('tbody tr:not(.is-group) th')];
  assert.ok(lines.some(th => th.textContent.startsWith('Mechanical, electrical and plumbing')));
  assert.ok(lines.every(th => th.querySelector('.scheme-budget-basis')?.textContent));
  assert.ok(!lines.some(th => th.textContent.startsWith('Transfer taxes')), 'no transfer tax line where none applies');
  assert.equal(detail.querySelector('tfoot td').textContent, `$${totalCost.toLocaleString('en-US')}`);
  assert.ok(!slot.textContent.includes('—'));
});

test('the shares form says what a group adds up to and stores fractions, or null at the defaults', () => {
  assert.deepEqual(groupStatus({a: 60, b: 40}), {ok: true, text: 'Adds up to 100%'});
  assert.equal(groupStatus({a: 60, b: 37}).text, 'Adds up to 97%; 3% left to place.');
  assert.equal(groupStatus({a: 60, b: null}).ok, false);
  const view = {hard: Object.fromEntries(Object.entries(DEFAULT_BUDGET_SPLITS.hard).map(([k, v]) => [k, v * 100])), soft: Object.fromEntries(Object.entries(DEFAULT_BUDGET_SPLITS.soft).map(([k, v]) => [k, v * 100]))};
  assert.equal(toStore(view, DEFAULT_BUDGET_SPLITS), null);
  assert.equal(toStore({...view, hard: {...view.hard, structure: 20, interiors: 16}}, DEFAULT_BUDGET_SPLITS).hard.structure, 0.2);
});

test('editing a share reports the new shares only once the group adds up again', () => {
  const {document, window, slot} = dom();
  const heard = [];
  const fields = budgetSplitsFields({options: budgetSplitOptions(), value: null, idPrefix: 't', onChange: next => heard.push(next)});
  slot.append(fields.node);
  const type = (key, value) => { const input = document.querySelector(`#t-hard-${key}`); input.value = value; input.dispatchEvent(new window.Event('input')); };
  type('structure', '22');
  assert.equal(heard.at(-1), undefined);
  assert.match(document.querySelector('#t-hard-total').textContent, /104%; 4% too much/);
  type('interiors', '14');
  assert.equal(heard.at(-1).hard.structure, 0.22);
  fields.reset();
  assert.equal(heard.at(-1), null);
});

test('the costs panel section loads the shares when opened and saves them on their own', async () => {
  const {document, window, slot} = dom();
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({path, method: options.method || 'GET', body: options.body && JSON.parse(options.body)});
    return options.method === 'PUT' ? {budgetSplits: JSON.parse(options.body).budgetSplits} : {budgetSplits: null, budgetSplitOptions: budgetSplitOptions()};
  };
  const section = budgetBreakdownSection({request, idPrefix: 'p'});
  slot.append(section);
  assert.equal(calls.length, 0, 'nothing loads until opened');
  section.open = true;
  section.dispatchEvent(new window.Event('toggle'));
  await flush();
  const save = [...section.querySelectorAll('button')].find(b => b.textContent === 'Save breakdown');
  assert.equal(save.disabled, true);
  for (const [key, value] of [['structure', '20'], ['facade', '12']]) { const input = document.querySelector(`#p-hard-${key}`); input.value = value; input.dispatchEvent(new window.Event('input')); }
  assert.equal(save.disabled, false);
  save.dispatchEvent(new window.Event('click'));
  await flush();
  assert.deepEqual(calls.at(-1).body, {budgetSplits: {hard: {...DEFAULT_BUDGET_SPLITS.hard, structure: 0.2, facade: 0.12}, soft: DEFAULT_BUDGET_SPLITS.soft}});
  assert.match(section.querySelector('[role="status"]:last-of-type').textContent + section.textContent, /Saved\. Budgets on your sites use these shares\./);
});
