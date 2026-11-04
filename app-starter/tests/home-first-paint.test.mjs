import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

// Execute the production home-mode block without booting the app shell.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const DEALS_ON_HOME_KEY');
const end = source.indexOf('\n// Runs sent from the listings page', start);
assert.ok(start >= 0 && end > start, 'the home-mode block is a contiguous slice of app.js');

function setup({remembered = null} = {}) {
  const {document} = parseHTML(`<body>
    <div id="home-listings" hidden><div class="listings-head"><div class="listings-address"></div></div><div class="listings-results"></div></div>
    <section class="welcome"><p class="intro"></p><div id="home-address" class="home-mount"></div><div class="welcome-links"></div><div id="home-sites" class="home-mount"></div></section>
  </body>`);
  const stored = new Map();
  const calls = [];
  const context = {
    session: {namespace: 'acct1'},
    readSaved: (_key, fallback) => (remembered === null ? fallback : remembered),
    localStorage: {setItem: (k, v) => stored.set(k, v)},
    $: (selector) => document.querySelector(selector),
    listings: {addressMount: document.querySelector('.listings-address'), sitesMount: document.querySelector('.listings-results')},
    setBodyMode: () => calls.push('setBodyMode'),
    render: () => calls.push('render'),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const where = () => ({
    address: document.querySelector('#home-address').parentElement.className,
    addressNext: document.querySelector('#home-address').nextElementSibling?.className || null,
    sites: document.querySelector('#home-sites').parentElement.className,
  });
  // let and const bindings stay in the script scope: read them by evaluating in the context.
  const value = (name) => vm.runInContext(name, context);
  return {context, stored, calls, where, value};
}

test('an account that showed listings last time boots straight into the listings layout', () => {
  const f = setup({remembered: true});
  assert.equal(f.value('dealsOnHome'), true);
  assert.deepEqual(f.where(), {address: 'listings-address', addressNext: null, sites: 'listings-results'});
  assert.deepEqual(f.calls, []);
});

test('a revoked deal store moves the address entry and recent sites back to their welcome positions', () => {
  const f = setup({remembered: true});
  f.context.settleDealsOnHome(false);
  assert.equal(f.value('dealsOnHome'), false);
  assert.deepEqual(f.where(), {address: 'welcome', addressNext: 'welcome-links', sites: 'welcome'});
  assert.deepEqual(f.calls, ['setBodyMode', 'render']);
  assert.equal(f.stored.get('acres-deals-on-home-acct1'), 'false');
});

test('a first visit stays in the welcome until the deal store answers, then remembers the answer', () => {
  const f = setup();
  assert.equal(f.value('dealsOnHome'), false);
  assert.equal(f.value('dealsOnHomeKnown'), false);
  assert.deepEqual(f.where(), {address: 'welcome', addressNext: 'welcome-links', sites: 'welcome'});
  f.context.settleDealsOnHome(true);
  assert.deepEqual(f.where(), {address: 'listings-address', addressNext: null, sites: 'listings-results'});
  assert.equal(f.stored.get('acres-deals-on-home-acct1'), 'true');
  f.context.settleDealsOnHome(true);
  assert.deepEqual(f.calls, ['setBodyMode', 'render'], 'a confirming answer changes nothing');
});
