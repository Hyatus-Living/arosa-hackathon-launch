import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { bodyModes, parseRoute, resolveRoute } from '../public/core-route.js';

const pub = new URL('../public/', import.meta.url);
const read = (name) => readFileSync(new URL(name, pub), 'utf8');

// Classes the app toggles on <body> to switch layout modes.
const bodyClasses = new Set();
for (const file of readdirSync(pub).filter((f) => f.endsWith('.js'))) {
  for (const m of read(file).matchAll(/document\.body\.classList\.(?:toggle|add)\(\s*["']([\w-]+)["']/g)) bodyClasses.add(m[1]);
}
for (const cls of Object.keys(bodyModes(parseRoute('/')))) bodyClasses.add(cls);

test('layout mode classes on <body> are never styled as bare component classes', () => {
  for (const cls of ['core-mode', 'view-home', 'view-sites', 'view-site']) assert.ok(bodyClasses.has(cls), `expected the app to set the ${cls} body mode class`);
  const css = readdirSync(pub).filter((f) => f.endsWith('.css')).map((f) => [f, read(f)]);
  const offenders = [];
  for (const cls of bodyClasses) {
    // A selector that starts with `.cls` (not `body.cls`) also matches <body> itself and restyles the whole app.
    const bare = new RegExp(`(^|[},;\\s])\\.${cls}(?![\\w-])`, 'm');
    for (const [file, text] of css) if (bare.test(text.replace(/\/\*[\s\S]*?\*\//g, ''))) offenders.push(`${file}: .${cls}`);
  }
  assert.deepEqual(offenders, []);
});

test('each route sets exactly its own view class on <body>', () => {
  const on = (path) => Object.entries(bodyModes(parseRoute(path))).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(on('/'), ['view-home']);
  assert.deepEqual(on('/chat'), ['view-home'], 'the old chat address is home with the drawer open');
  assert.deepEqual(on('/sites'), ['core-mode', 'view-sites']);
  assert.deepEqual(on('/sites/p1'), ['core-mode', 'view-site']);
  assert.deepEqual(on('/core/p1'), ['core-mode', 'view-site']);
  assert.deepEqual(on('/shared/t'), [], 'a shared link is not home until it is claimed');
});

test('the chat is never a page: no route or body class lays it out as one', () => {
  for (const cls of ['chat-page', 'view-chat']) {
    assert.ok(!bodyClasses.has(cls), `nothing sets ${cls} on <body>`);
    for (const file of readdirSync(pub).filter((f) => f.endsWith('.css'))) assert.doesNotMatch(read(file), new RegExp(`\\.${cls}(?![\\w-])`), `${file} styles no ${cls} layout`);
  }
});

// The drawer functions of app.js as written, over the real page, with the account's listings, the
// window width, the open conversation and the saved drawer choice stubbed.
const app = read('app.js');
const fn = (name) => { const start = app.search(new RegExp('^function ' + name + '\\(', 'm')); assert.ok(start >= 0, name + ' is in app.js'); return app.slice(start, app.indexOf('\n}\n', start) + 2); };
function bodyMode({ path = '/', listings = false, width = 1400, dockOpen = false, savedOpen = false, session = {}, messages = 0 } = {}) {
  const { document } = parseHTML(read('index.html'));
  const route = session ? parseRoute(path) : resolveRoute({ pathname: path, search: '', hash: '' }, { replaceState() {} }, null);
  const saved = { dock: JSON.stringify(savedOpen) };
  const history = {state: null, pushState(value) { this.state = value; }, back() { this.state = null; context.onChatDockPopstate(); }};
  const context = { document, $: (q) => document.querySelector(q), bodyModes, route, session, history, window: { innerWidth: width, location: {href: 'https://app.test' + path} }, chatDockOpen: dockOpen, listingsOn: listings,
    state: { id: messages ? 'c1' : null, messages: Array.from({ length: messages }, () => ({ role: 'user' })) },
    saved, CHAT_DOCK_KEY: 'dock', readSaved: (key, fallback) => (key in saved ? JSON.parse(saved[key]) : fallback), localStorage: { setItem: (key, value) => { saved[key] = value; }, getItem: (key) => saved[key] ?? null },
    RAIL_COLLAPSED_KEY: 'rail', homeRailFold: { matches: width >= 1280 && width < 1600 },
    historyView: { close() {} }, listings: { resize() {} }, requestAnimationFrame() {}, planEntryState: () => ({ visible: false }) };
  vm.createContext(context);
  vm.runInContext('const listingsMode = () => Boolean(session) && listingsOn && route.view === "home";' + ['savedDockOpen', 'askBarVisible', 'renderAskHandle', 'focusThread', 'setChatDock', 'onChatDockPopstate', 'showRestoredConversation', 'setRailCollapsed', 'savedRailCollapsed', 'foldRailForHome', 'renderChatCloseLabel'].map(fn).join('') + 'let railFoldedForHome = false, homeWasEmpty = false, dockAutoOpened = false, dockHistoryActive = false, dockPendingFocus = null, unseenEnd = null, handleClock = null, liveLabel = null, runStartedAt = null, runSince = null;' + fn('setBodyMode'), context);
  vm.runInContext('setBodyMode()', context);
  const run = (code) => vm.runInContext(code, context);
  return { context, body: document.body, $: context.$, run, again: () => run('setBodyMode()'), go: (to) => { context.route = parseRoute(to); run('setBodyMode()'); } };
}

test("a boot without a session tops home's welcome with the sign-in notice and keeps the chat closed, on every route", () => {
  for (const path of ['/', '/chat', '/sites', '/sites/p1', '/core/p1', '/shared/t']) {
    const page = bodyMode({ path, session: null, savedOpen: true, dockOpen: true });
    assert.equal(page.$('#welcome').hidden, false, `${path} shows the welcome signed out`);
    vm.runInContext('const SIGN_OUT_URL = "/out";' + fn('showSessionNotice') + 'showSessionNotice(true)', page.context);
    const notice = page.$('.session-notice');
    assert.ok(page.$('#welcome').contains(notice), `${path} puts the notice in the welcome`);
    assert.ok(!page.$('#chat-panel').contains(notice), 'not in the chat drawer');
    assert.match(notice.textContent, /Sign in again/);
    assert.equal(page.context.chatDockOpen, false, `${path} keeps the drawer closed signed out, whatever was saved`);
    assert.ok(!page.body.classList.contains('chat-dock-open'));
    assert.equal(page.$('#ask-bar').hidden, true, 'and offers no composer that cannot run');
  }
});

test('an old /chat link opens the drawer on home once, and the reader can close it', () => {
  for (const listings of [false, true]) for (const width of [390, 1440]) {
    const page = bodyMode({ path: '/chat', listings, width });
    assert.equal(page.context.chatDockOpen, true, `open at ${width}${listings ? ' over listings' : ''}`);
    assert.ok(page.body.classList.contains('chat-dock-open') && page.body.classList.contains('view-home'));
    assert.ok(!page.body.classList.contains('chat-page') && !page.body.classList.contains('view-chat'));
    page.run('setChatDock(false, { focus: false })');
    page.again();
    assert.equal(page.context.chatDockOpen, false, 'closing holds');
  }
});

test('home without listings shows the address entry and recent sites with the chat drawer open beside them', () => {
  const page = bodyMode();
  assert.equal(page.context.chatDockOpen, true, 'the drawer opens as the empty state');
  assert.ok(page.body.classList.contains('chat-dock-open'));
  assert.ok(!page.body.classList.contains('chat-page'));
  assert.equal(page.$('#welcome').hidden, false, 'home shows its own page');
  assert.ok(!page.$('#chat-panel').contains(page.$('#welcome')), 'outside the chat');
  for (const id of ['#home-address', '#home-sites']) assert.ok(page.$('#welcome').contains(page.$(id)));
  // Closing the drawer holds until the page is home without listings again.
  page.run('setChatDock(false, { focus: false })');
  page.again();
  assert.equal(page.context.chatDockOpen, false, 'the reader can close it');
  assert.equal(page.$('#ask-bar').hidden, false, 'the ask bar takes over');
  const listings = bodyMode({ listings: true });
  assert.equal(listings.context.chatDockOpen, false, 'with listings the drawer keeps the reader\'s choice');
  assert.equal(listings.$('#welcome').hidden, true);
  assert.equal(bodyMode({ width: 390 }).context.chatDockOpen, false, 'on a phone the drawer would cover the page, so it waits');
  assert.equal(bodyMode({ path: '/sites' }).$('#welcome').hidden, true);
});

test('an empty-state open the reader did not choose gives way to their saved choice once listings arrive', () => {
  for (const savedOpen of [false, true]) {
    const page = bodyMode({ savedOpen });
    assert.equal(page.context.chatDockOpen, true, 'open while home has no listings');
    page.context.listingsOn = true;
    page.again();
    assert.equal(page.context.chatDockOpen, savedOpen, `listings take the page with the drawer ${savedOpen ? 'open' : 'closed'}, as saved`);
    assert.equal(page.body.classList.contains('chat-dock-open'), savedOpen);
    assert.ok(page.body.classList.contains('listings-mode'));
  }
  // A drawer already open, from /chat or the reader, stays open over listings.
  const chosen = bodyMode({ dockOpen: true });
  chosen.context.listingsOn = true;
  chosen.again();
  assert.equal(chosen.context.chatDockOpen, true);
  // An open the reader confirms is theirs and is saved.
  const confirmed = bodyMode();
  confirmed.run('setChatDock(true, { focus: false })');
  confirmed.context.listingsOn = true;
  confirmed.again();
  assert.equal(confirmed.context.chatDockOpen, true);
  assert.equal(confirmed.context.saved.dock, 'true');
});

test('an empty-state open the reader did not choose gives way to their saved choice on every other page', () => {
  for (const savedOpen of [false, true]) {
    const page = bodyMode({ savedOpen });
    assert.equal(page.context.chatDockOpen, true);
    for (const path of ['/sites', '/sites/p1', '/sites/p1/report', '/whats-new']) {
      page.go(path);
      assert.equal(page.context.chatDockOpen, savedOpen, `${path} keeps the saved choice`);
      assert.equal(page.body.classList.contains('chat-dock-open'), savedOpen);
    }
    page.go('/');
    assert.equal(page.context.chatDockOpen, true, 'home without listings opens it again');
    assert.equal(page.context.saved.dock, JSON.stringify(savedOpen), 'the saved choice is never overwritten');
  }
});

test('the last conversation, restored on home without listings, opens in the drawer until the reader leaves home', () => {
  const phone = bodyMode({ width: 390, messages: 2 });
  assert.equal(phone.context.chatDockOpen, false);
  phone.run('showRestoredConversation()');
  assert.equal(phone.context.chatDockOpen, true, 'nothing else would show it on a phone');
  assert.equal(phone.context.saved.dock, 'false', 'without saving that choice');
  phone.go('/sites');
  assert.equal(phone.context.chatDockOpen, false, 'it gives way on another page');
  for (const options of [{ listings: true, messages: 2 }, { width: 390 }]) {
    const page = bodyMode(options);
    page.run('showRestoredConversation()');
    assert.equal(page.context.chatDockOpen, false, options.listings ? 'listings keep the saved choice' : 'an empty conversation leaves it closed');
  }
});

test('the menu folds to icons while the chat is open beside the listings where only that keeps the list and map side by side, then returns to the reader\'s choice', () => {
  const folded = (page) => page.body.classList.contains('sidebar-collapsed');
  const wide = bodyMode({ listings: true, width: 1440, dockOpen: true });
  assert.ok(folded(wide), 'the menu folds while the chat shares home with the list and map');
  wide.run('setChatDock(false)');
  assert.ok(!folded(wide), 'closing the chat brings the menu back');
  wide.run('setChatDock(true)');
  assert.ok(folded(wide));
  wide.go('/sites');
  assert.ok(!folded(wide), 'other pages keep the menu as the reader left it');
  const kept = bodyMode({ listings: true, width: 1440, dockOpen: true });
  kept.run('localStorage.setItem(RAIL_COLLAPSED_KEY, "1"); setChatDock(false)');
  assert.ok(folded(kept), 'a menu the reader folded stays folded after the chat closes');
  assert.ok(!folded(bodyMode({ listings: true, width: 1200, dockOpen: true })), 'narrower, the list and map switch instead and the menu stays');
  assert.ok(!folded(bodyMode({ listings: true, width: 1920, dockOpen: true })), 'wider, both fit beside the full menu');
  assert.ok(!folded(bodyMode({ listings: false, width: 1440, dockOpen: true })), 'home without listings keeps the menu');
});


test('the chat close name follows the phone and desktop viewport', () => {
  const f = bodyMode({width: 1440, listings: true});
  assert.equal(f.$('.core-chat-close').getAttribute('aria-label'), 'Close chat');
  f.context.window.innerWidth = 390; f.run('renderChatCloseLabel()');
  assert.equal(f.$('.core-chat-close').getAttribute('aria-label'), 'Back to Explore NYC');
  f.context.window.innerWidth = 1440; f.run('renderChatCloseLabel()');
  assert.equal(f.$('.core-chat-close').title, 'Close chat');
});
