import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {chrome, startBrowser, startFixture, waitFor} from './headless-chrome.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('research steps say what was done, from the tool and its arguments, without tool names', async () => {
  const {document} = parseHTML('<div></div>');
  globalThis.document = document;
  const {describeStep} = await import('../public/activity-view.js');
  assert.equal(describeStep('acres_find_property', {address: '120 Broadway'}, 'complete'), "Looked up 120 Broadway's parcel");
  assert.equal(describeStep('acres_fetch_url', {url: 'https://zr.planning.nyc.gov/article-iii/chapter-3/33-12'}, 'complete'), 'Read ZR 33-12');
  assert.equal(describeStep('acres_execute_capability', {name: 'acres_model_concept', arguments: {name: 'UAP \u2014 1.15 gross-up'}}, 'complete'), 'Modeled UAP, 1.15 gross-up');
  assert.equal(describeStep('acres_fanout_search', {query: 'City of Yes office conversion'}, 'complete'), 'Searched the web for City of Yes office conversion');
  assert.equal(describeStep('acres_fanout_search', {query: 'City of Yes office conversion'}, 'running'), 'Searching the web for City of Yes office conversion');
  assert.equal(describeStep('acres_execute_capability', {name: 'acres_zoning_envelope', arguments: {district: 'R7A'}}, 'complete'), 'Computed the R7A zoning envelope');
  assert.equal(describeStep('acres_fetch_url', {url: 'https://www1.nyc.gov/site/planning/index.page'}, 'complete'), 'Read nyc.gov');
  const unknown = describeStep('acres_brand_new_tool', {}, 'complete');
  assert.equal(unknown, 'Checked a research source');
  for (const text of [unknown, describeStep('acres_execute_tool', {slug: 'EXA_SEARCH', arguments: {query: 'rear yard'}}, 'complete')])
    assert.doesNotMatch(text, /acres_|EXA|_/, 'no internal names reach the page');
});

test('a saved run lists its steps in words, and a step without a recorded end reads as done', async () => {
  const {document, window} = parseHTML('<div></div>');
  globalThis.document = document;globalThis.Node = window.Node;
  const {savedActivity} = await import('../public/activity-view.js');
  const root = savedActivity('run-1', async () => ({created: 1, updated: 5, events: [
    {event: 'tool.started', tool: 'acres_find_property', arguments: {address: '1 Main St'}},
    {event: 'tool.completed', tool: 'acres_find_property', success: true},
    {event: 'tool.started', tool: 'acres_fanout_search', arguments: {query: 'UAP'}},
  ]}), () => 'unused', false, 4000);
  root.open = true;root.dispatchEvent(new window.Event('toggle'));
  await new Promise(setImmediate);
  const rows = [...root.querySelectorAll('.activity-steps li')];
  assert.deepEqual(rows.map((li) => li.querySelector('summary').textContent), ["Looked up 1 Main St's parcel", 'Searched the web for UAP']);
  assert.ok(!root.textContent.includes('run-1'), 'the run id stays internal');
  assert.equal(root.querySelector('.activity-skeleton'), null, 'the loading placeholder leaves once the steps arrive');
});

test('the property panel lists only parcel facts with values, and says a loaded record lacks one plainly', async () => {
  const {document} = parseHTML('<div></div>');
  globalThis.document = document;
  const {parcelRows, PARCEL_ABSENT} = await import('../public/conversation-view.js');
  assert.deepEqual(parcelRows({address: '120 Broadway', bbl: '1000477501'}), [], 'a bare address claims nothing about a record it does not have');
  assert.deepEqual(parcelRows({zonedist1: 'C5-5', spdist1: 'LM', lotarea: 52000, landmark: '', version: '25v2'}), [['Zoning', 'C5-5'], ['Special district', 'LM'], ['Lot area', '52,000 sq ft']]);
  assert.deepEqual(parcelRows({zonedist1: '', lotarea: null, version: '25v2'}), [['Zoning', PARCEL_ABSENT], ['Lot area', PARCEL_ABSENT]]);
  assert.deepEqual(parcelRows({zoningDistrict: 'R7A', lotAreaSqft: 5000}), [['Zoning', 'R7A'], ['Lot area', '5,000 sq ft']]);
});

test('the drawer header names the conversation, the site it is attached to and its save status, with five icon actions', () => {
  const {document} = parseHTML(html);
  const head = document.querySelector('#main .chat-panel-head');
  assert.equal(head.querySelector('details, .chat-more, .chat-menu'), null, 'no More menu');
  assert.doesNotMatch(head.textContent, /Open in Chat|Export deck|All conversations/);
  const buttons = [...head.querySelectorAll('button')];
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')), ['History', 'New chat', 'Share', 'Expand chat', 'Close chat']);
  assert.ok(head.firstElementChild === buttons[0] && buttons[0].matches('.chat-history-open[data-history-open]'), 'History leads the header and opens History in place');
  for (const b of buttons) {
    assert.ok(b.classList.contains('chat-head-button'), `${b.getAttribute('aria-label')} is a header icon button`);
    assert.ok(b.querySelector('svg[aria-hidden="true"]'), `${b.getAttribute('aria-label')} shows an icon`);
    assert.equal(b.textContent.trim(), b.classList.contains('core-chat-close') ? 'Back' : '', 'only the phone Back action has a text label');
  }
  assert.equal(head.querySelector('#share-button'), buttons[2]);
  assert.equal(buttons[3].getAttribute('aria-pressed'), null, 'Expand names what the next press does instead of a pressed state');
  const sources = document.querySelector('#conversation > .chat-sources');
  assert.ok(sources && sources.hidden && sources.matches('.context-toggle[aria-controls="property-context"]'), 'Property & sources heads the thread, waiting for a property or a cited source');
  assert.equal(sources.textContent.trim(), 'Property & sources');
  const title = head.querySelector('.chat-panel-title');
  assert.equal(title.querySelector('#chat-context-title').textContent, 'New conversation');
  assert.equal(title.querySelector('.chat-attached').textContent, 'Not attached to a site');
  assert.ok(title.querySelector('.saved-label[role="status"]'), 'the save status sits under the title');
  assert.ok(title.querySelector('.chat-run-status[role="status"]'), 'a running request shows as a status beside the title');
  assert.equal(head.querySelector('.chat-panel-kicker'), null, 'no CHAT kicker above the title');
  assert.equal(document.querySelector('#conversation .conversation-heading'), null, 'the thread no longer repeats the site and save line');
  const css = readFileSync(new URL('../public/workspace-shell.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-head-button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/, 'header buttons are 44 px targets');
  assert.match(css, /body\.chat-dock-wide\s*\{[^}]*--dock-w:\s*clamp\(440px, calc\(100vw - var\(--rail-w\) - 480px\), 1040px\)/, 'Expand widens the drawer and leaves the page a 480 px column beside the rail');
  assert.match(css, /body\.chat-dock-wide\.sidebar-collapsed\s*\{[^}]*var\(--rail-w-collapsed\) - 480px/, 'a collapsed rail leaves the drawer more room');
  assert.match(css, /@media \(max-width: 1199px\)\s*\{\s*#chat-panel \.chat-expand \{ display: none; \}/, 'Expand is not offered where the page could not keep its column');
  assert.match(css, /\.chat-sources\s*\{[^}]*min-height:\s*44px/, 'Property & sources is a 44 px target');
  for (const mode of ['view-site', 'view-sites', 'listings-mode']) assert.match(css, new RegExp(`body\\.${mode} \\.chat-sources[,\\s{]`), `no Property & sources in the thread on ${mode}`);
  assert.ok(html.includes('<symbol id="collapse"'), 'a narrowing icon for the expanded drawer');
});

test('the header line names the attached site or says there is none, and the save status reads Saved or Sign in to save', () => {
  const {document} = parseHTML(html);
  const run = (vars) => {
    const context = {$: (q) => document.querySelector(q), displayAddress: (a) => a, siteTitle: null, archive: [], route: {view: 'home'}, session: {account: 'me'}, submitPending: false, ...vars, state: {messages: [], ...vars.state}};
    vm.createContext(context);
    vm.runInContext(appFunction('renderChatHead'), context);
    context.renderChatHead();
    const text = (q) => (document.querySelector(q).hidden ? '' : document.querySelector(q).textContent);
    return [text('#chat-context-title'), text('.chat-attached'), text('.saved-label')];
  };
  const sourcesShown = (vars) => (run(vars), !document.querySelector('.chat-sources').hidden);
  assert.deepEqual(run({state: {title: 'New conversation'}, session: null}), ['New conversation', 'Not attached to a site', 'Sign in to save']);
  assert.deepEqual(run({state: {id: 'c1', title: 'Rear yard at 5 Elm'}}), ['Rear yard at 5 Elm', 'Not attached to a site', 'Saved']);
  assert.deepEqual(run({state: {id: 'c1', title: 'Rear yard', projectId: 'p1'}, route: {view: 'site', projectId: 'p1'}, siteTitle: '5 Elm St'}), ['Rear yard', '5 Elm St', 'Saved']);
  assert.deepEqual(run({state: {id: 'c1', title: 'Rear yard', projectId: 'p2'}, archive: [{id: 'c1', site: {id: 'p2', title: '9 Oak Ave'}}]}), ['Rear yard', '9 Oak Ave', 'Saved'], 'a site chat opened elsewhere still names its site');
  assert.deepEqual(run({state: {title: 'New conversation'}, route: {view: 'site', projectId: 'p1'}, siteTitle: '5 Elm St'}), ['New conversation', '5 Elm St', ''], 'a blank chat on a site page belongs to that site');
  assert.deepEqual(run({state: {id: 'c1', title: 'Rear yard'}, submitPending: true}), ['Rear yard', 'Not attached to a site', 'Saving…']);
  // A conversation remembered from the last visit, on a page that does not load it: History's list names
  // it and its site, and nothing claims it is saved before it has loaded.
  const remembered = {id: 'c1', site: {id: 'p2', title: '9 Oak Ave'}};
  assert.deepEqual(run({state: {id: 'c1', unloaded: true}, route: {view: 'whats-new'}, archive: [{...remembered, title: 'Rear yard'}]}), ['Rear yard', '9 Oak Ave', ''], 'a remembered site chat still names its site');
  assert.deepEqual(run({state: {id: 'c1', unloaded: true}, route: {view: 'sites'}, archive: []}), ['New conversation', 'Not attached to a site', ''], 'an unlisted remembered chat claims neither a site nor a save');
  // A title that already is the site name is not repeated on the line under it.
  assert.deepEqual(run({state: {id: 'c1', title: '5 Elm St', projectId: 'p1'}, route: {view: 'site', projectId: 'p1'}, siteTitle: '5 Elm St'}), ['5 Elm St', 'Site conversation', 'Saved']);
  assert.deepEqual(run({state: {id: 'c1', unloaded: true}, archive: [{...remembered, title: '9 Oak Ave'}]}), ['9 Oak Ave', 'Site conversation', '']);
  // Property & sources heads the thread once the conversation has a property or a cited source.
  assert.equal(sourcesShown({state: {id: 'c1', title: 'Rear yard'}}), false);
  assert.equal(sourcesShown({state: {id: 'c1', title: 'Rear yard', property: {address: '5 Elm St'}}}), true);
  assert.equal(sourcesShown({state: {id: 'c1', title: 'Rear yard', messages: [{role: 'assistant', sources: [{id: 1}]}]}}), true);
});

test('the Share dialog has one primary action, one invite field and no guide paragraphs', () => {
  const {document} = parseHTML(html);
  const dialog = document.querySelector('#share-dialog');
  assert.equal(dialog.querySelectorAll('.share-primary').length, 1);
  assert.equal(dialog.querySelector('.share-primary').id, 'share-copy-link');
  assert.equal(dialog.querySelectorAll('input[type="email"]').length, 1);
  assert.ok(dialog.querySelector('.share-more .share-menu #share-team-select'), 'team sharing sits under More');
  assert.ok(dialog.querySelector('.share-more .share-menu #share-links'), 'link settings sit under More');
  assert.equal(dialog.querySelectorAll('.share-section-heading p').length, 0);
  const start = source.indexOf('function renderShareLinks() {'), end = source.indexOf('\nfunction renderShareTeamOptions() {', start);
  const links = source.slice(start, end);
  assert.match(links, /className = "share-danger"/, 'Revoke is a quiet destructive action');
  assert.ok(links.indexOf('deleteChat(') > links.indexOf('yes.addEventListener('), 'and it asks before acting');
  assert.doesNotMatch(links, /textContent = "Copy"/, 'no second Copy beside the link');
});

test('the welcome example is an action in place, and the plan usage is a badge beside its name', () => {
  const {document} = parseHTML(html);
  assert.doesNotMatch(document.querySelector('.example-link').textContent, /↗/);
  const wallet = document.querySelector('#wallet-button');
  assert.equal(wallet.querySelector('.rail-label').textContent, 'Plan');
  assert.ok(wallet.querySelector('.rail-badge#wallet-balance'));
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css.slice(css.indexOf(':root {'), css.indexOf('html.dark {')), /accent-color: var\(--ink\)/);
});

// A document with focus tracking, for the History view's keyboard paths.
function historyDocument() {
  const {document, window} = parseHTML(html);
  globalThis.document = document;globalThis.Node = window.Node;
  let focused = document.body;
  Object.defineProperty(document, 'activeElement', {get: () => focused, configurable: true});
  // As in a browser, a disabled control does not take focus.
  window.HTMLElement.prototype.focus = function () { if (!this.disabled) focused = this; };
  document.Event = window.Event;
  return document;
}
const key = (k, mods = {}) => ({key: k, metaKey: false, ctrlKey: false, shiftKey: false, ...mods, prevented: false, preventDefault() { this.prevented = true; }});

test('conversation search is the History view inside the chat, never a modal over the page', () => {
  const {document} = parseHTML(html);
  assert.equal(document.querySelector('#search-dialog'), null, 'the search modal is gone');
  const view = document.querySelector('#chat-panel #chat-history-view');
  assert.ok(view, 'History lives inside the chat drawer');
  assert.ok(!document.querySelector('#main').contains(view), 'and takes the thread\'s place rather than sitting in it');
  assert.ok(view.querySelector('input#conversation-search[type="search"]'));
  assert.ok(view.querySelector('#search-results'));
  assert.equal(view.querySelector('h2').textContent.trim(), 'History');
  const rail = document.querySelector('#navigation .rail-recent');
  const all = rail.lastElementChild;
  assert.equal(all.textContent.trim(), 'All conversations', 'the rail list ends with a way into History');
  assert.ok(all.matches('button[data-history-open]'));
  assert.doesNotMatch(source, /search-dialog/, 'nothing opens the old modal');
});

test('Cmd+K or Ctrl+K opens History on every route; Escape steps back to the thread, then closes the drawer and returns focus', async () => {
  const {createHistoryView} = await import('../public/conversation-view.js');
  for (const mods of [{metaKey: true}, {ctrlKey: true}]) {
    const document = historyDocument();
    const dock = [];
    const opener = document.querySelector('#ask-handle');
    opener.focus();
    const view = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock: (open) => dock.push(open), focusThread: () => document.querySelector('#prompt').focus()});
    const k = key('k', mods);
    assert.equal(view.onKeydown(k), true);
    assert.ok(k.prevented);
    assert.equal(document.querySelector('#chat-history-view').hidden, false, 'History shows');
    assert.equal(document.querySelector('#main').hidden, true, 'in place of the thread');
    assert.equal(document.activeElement, document.querySelector('#conversation-search'), 'with the search field focused');
    assert.deepEqual(dock, [true], 'the drawer opens beside the page');
    assert.equal(view.onKeydown(key('Escape')), true);
    assert.equal(document.querySelector('#chat-history-view').hidden, true);
    assert.equal(document.querySelector('#main').hidden, false, 'Escape goes back to the thread');
    assert.equal(document.activeElement, document.querySelector('#prompt'));
    assert.equal(view.onKeydown(key('Escape')), true);
    assert.deepEqual(dock, [true, false], 'a second Escape closes the drawer');
    assert.equal(document.activeElement, opener, 'and returns focus to what opened History');
    assert.equal(view.onKeydown(key('Escape')), false, 'a third Escape is left to the page');
  }
});

test('Escape cancelling an IME composition is left to the IME, in History and the suggestion fields', async () => {
  const {createHistoryView} = await import('../public/conversation-view.js');
  const document = historyDocument();
  const view = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock() {}, focusThread: () => document.querySelector('#prompt').focus()});
  view.onKeydown(key('k', {metaKey: true}));
  assert.ok(view.isOpen());
  assert.equal(view.onKeydown(key('Escape', {isComposing: true})), false, 'the composition Escape is not taken');
  assert.ok(view.isOpen(), 'and History stays open');
  assert.equal(view.onKeydown(key('Escape')), true, 'a plain Escape still steps back');
  for (const file of ['listings.js', 'modeling.js']) {
    const js = readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
    const at = js.indexOf('isComposing) return;');
    assert.ok(at > 0 && js.slice(at, at + 900).includes('Enter'), `${file} leaves composing Enter and arrows to the IME`);
  }
});

test('holding Cmd+K opens History once instead of searching on every repeat', async () => {
  const {createHistoryView} = await import('../public/conversation-view.js');
  const document = historyDocument();
  let loads = 0;
  const view = createHistoryView({doc: document, load: async () => { loads++; return []; }, account: () => 'me', setDock() {}, focusThread() {}});
  view.onKeydown(key('k', {metaKey: true}));
  await new Promise(setImmediate);
  const held = key('k', {metaKey: true, repeat: true});
  assert.equal(view.onKeydown(held), true, 'the repeat is still taken from the browser');
  assert.ok(held.prevented);
  await new Promise(setImmediate);
  assert.equal(loads, 1, 'and History searched once');
});

test('History renders loading, empty, failed with Try again, and access removed', async () => {
  const {createHistoryView, HISTORY_EMPTY} = await import('../public/conversation-view.js');
  const document = historyDocument();
  const box = document.querySelector('#search-results');
  let answer;
  const view = createHistoryView({doc: document, load: () => answer(), account: () => 'me', setDock() {}, focusThread() {}});
  let release;
  answer = () => new Promise((resolve) => { release = resolve; });
  const loading = view.open(document.body);
  assert.ok(box.querySelector('.search-skeleton[role="status"]'), 'loading holds the rows\' place');
  assert.equal(box.getAttribute('aria-busy'), 'true');
  release([]);await loading;
  assert.equal(box.textContent.trim(), HISTORY_EMPTY);
  assert.equal(HISTORY_EMPTY, 'Your research conversations will appear here.');
  assert.equal(box.hasAttribute('aria-busy'), false);

  answer = async () => { throw new Error('offline'); };
  await view.search();
  const retry = box.querySelector('.search-failed button');
  assert.equal(retry.textContent.trim(), 'Try again');
  answer = async () => [{id: 'c1', title: 'Rear yard at 5 Elm'}];
  retry.click();await new Promise(setImmediate);
  assert.deepEqual([...box.querySelectorAll('[data-conversation]')].map((b) => b.textContent), ['Rear yard at 5 Elm'], 'Try again searches again');

  answer = async () => [];
  await view.accessRemoved();
  assert.match(box.querySelector('.search-notice[role="status"]').textContent, /no longer have access/);
  document.querySelector('#conversation-search').value = 'elm';
  await view.search();
  assert.equal(box.querySelector('.search-notice'), null, 'the notice belongs to the open that failed');
  assert.equal(box.textContent.trim(), 'No conversations match your search.');
});

// A top-level function of app.js, as written, to run against stubs.
function appFunction(name) {
  const start = source.search(new RegExp('^(async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name + ' is in app.js');
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}
// History over the real page, open in the drawer as Cmd+K leaves it.
async function openHistory(options = {}) {
  const {createHistoryView} = await import('../public/conversation-view.js');
  const document = historyDocument();
  const view = createHistoryView({doc: document, load: async () => [{id: 'c1', title: 'Rear yard at 5 Elm'}], account: () => 'me', setDock() {}, focusThread() {}, ...options});
  await view.open(document.querySelector('.brand'));
  assert.ok(view.isOpen());
  return {document, view};
}
const threadShows = (document) => {
  assert.equal(document.querySelector('#chat-history-view').hidden, true, 'History has closed');
  assert.equal(document.querySelector('#main').hidden, false, 'the thread shows');
  assert.ok(!document.body.classList.contains('history-view-open'), 'and so does its composer');
};

test('the ask handle opens a visible thread, even when History was left open', async () => {
  const {document, view} = await openHistory();
  const docked = [];
  const context = {document, $: (q) => document.querySelector(q), historyView: view, setChatDock: (open) => { docked.push(open); document.querySelector('#prompt').focus(); }};
  vm.createContext(context);
  vm.runInContext(appFunction('openFromHandle'), context);
  vm.runInContext('openFromHandle()', context);
  assert.deepEqual(docked, [true]);
  threadShows(document);
  assert.equal(document.activeElement, document.querySelector('#prompt'));
});

test('a Recent row, a new page, closing the drawer and any other open show the thread rather than History', async () => {
  const recentStart = source.indexOf('  const recent = e.target.closest("[data-recent]");'), recentEnd = source.indexOf('\n  const conversation =', recentStart);
  assert.ok(recentStart > 0 && recentEnd > recentStart);
  {
    const {document, view} = await openHistory();
    const row = parseHTML('<button data-recent="c2">Land under $150</button>').document.querySelector('button');
    let opened = null;
    const context = {route: {view: 'sites'}, historyView: view, closeNav() {}, setChatDock() {}, siteAttach: Promise.resolve(), state: {id: null},
      openConversation: async (id) => { opened = id; }, handleAccessRemoved() {}, toast() {}};
    vm.createContext(context);
    vm.runInContext('(e) => {' + source.slice(recentStart, recentEnd) + '}', context)({target: row});
    threadShows(document);
    await new Promise(setImmediate);
    assert.equal(opened, 'c2', 'the row\'s conversation opens in the thread');
  }
  // Each of these shows the thread from its first step; the stubs stop each one just after.
  for (const [name, call] of [['applyRoute', 'applyRoute()'], ['setChatDock', 'setChatDock(false)'], ['openPendingSite', 'openPendingSite({})']]) {
    const {document, view} = await openHistory();
    const context = {historyView: view, route: {view: 'sites'}, dockHistoryActive: false};
    vm.createContext(context);
    vm.runInContext(appFunction(name), context);
    try { await vm.runInContext(call, context); } catch { /* past the stubs */ }
    threadShows(document);
  }
  {
    const {view} = await openHistory();
    const context = {historyView: view, route: {view: 'sites'}, dockHistoryActive: false};
    vm.createContext(context);
    vm.runInContext(appFunction('applyRoute'), context);
    try { view.hold(() => vm.runInContext('applyRoute()', context)); } catch { /* past the stubs */ }
    assert.ok(view.isOpen(), 'a move for a conversation picked in History keeps History until it opens');
  }
});

test('a conversation picked in History opens in the drawer, over home from a site page, with History closing once it is there', async () => {
  const start = source.indexOf('  const conversation = e.target.closest("[data-conversation]");'), end = source.indexOf('\n  const draft =', start);
  const {document, view} = await openHistory();
  const row = document.querySelector('#search-results [data-conversation="c1"]');
  const seen = [];
  const context = {archive:[],route: {view: 'site', projectId: 'p1'}, historyView: view, toggleContext() {}, closeNav() {}, handleAccessRemoved() {}, toast() {},
    // As in app.js, a new page and an open each close History unless it holds.
    navigate: (path) => { view.close(); context.route = {view: 'home'}; seen.push(['navigate', path, view.isOpen()]); },
    setChatDock: (open) => seen.push(['dock', open, view.isOpen()]),
    openConversation: async (id) => { view.close(); seen.push(['open', id, view.isOpen()]); }};
  vm.createContext(context);
  vm.runInContext('(e) => {' + source.slice(start, end) + '}', context)({target: row});
  assert.deepEqual(seen, [['navigate', '/', true], ['dock', true, true], ['open', 'c1', true]], 'History holds while the conversation opens');
  await new Promise(setImmediate);
  threadShows(document);
});

test('Cmd+K again keeps the first opener, and focus falls back to the menu button when the opener is out of sight', async () => {
  const {createHistoryView} = await import('../public/conversation-view.js');
  const document = historyDocument();
  const opener = document.querySelector('.brand'), menu = document.querySelector('.mobile-menu');
  opener.focus();
  const view = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock() {}, focusThread: () => document.querySelector('#prompt').focus()});
  view.onKeydown(key('k', {metaKey: true}));
  view.onKeydown(key('k', {metaKey: true}));
  view.onKeydown(key('Escape'));view.onKeydown(key('Escape'));
  assert.equal(document.activeElement, opener, 'the second Cmd+K did not take the opener\'s place');

  const hidden = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock() {}, focusThread: () => document.querySelector('#prompt').focus(), fallbackFocus: () => menu.focus()});
  const inClosedMenu = document.querySelector('.rail-all-conversations');
  inClosedMenu.focus = () => {};
  await hidden.open(inClosedMenu);
  hidden.onKeydown(key('Escape'));hidden.onKeydown(key('Escape'));
  assert.equal(document.activeElement, menu, 'focus lands on the visible menu button');
});

test('History shows new results when the conversations change while it is open', async () => {
  let loads = 0;
  const {view} = await openHistory({load: async () => { loads++; return []; }});
  assert.equal(loads, 1);
  view.refresh();await new Promise(setImmediate);
  assert.equal(loads, 2, 'open: it searches again');
  view.close();view.refresh();await new Promise(setImmediate);
  assert.equal(loads, 2, 'closed: nothing to refresh');
  assert.match(appFunction('loadHistory'), /historyView\.refresh\(\)/, 'the conversations list reloading refreshes History');
});

test('background refreshes of the open conversation leave History open with the reader\'s search', async () => {
  const run = async (call, extra = {}) => {
    const {document, view} = await openHistory();
    const input = document.querySelector('#conversation-search');
    input.value = 'Bronx';
    const context = {historyView: view, state: {id: 'c1'}, document: {hidden: false}, submitPending: false, generation: 0, conversationLoad: 0,
      chatRequest: async () => ({}), applyConversation() {}, setConversationOpening() {}, clearActiveRun() {}, scrollState: {reset() {}},
      refreshHistory: async () => {}, handleAccessRemoved() {}, toast() {}, startBlankChat() {}, renderHistory() {}, archive: [],
      $: () => ({open: false}), ...extra};
    vm.createContext(context);
    vm.runInContext(['openConversation', 'pollSharedThread', 'reopenAfterRun', 'refreshAfterShareChange', 'discardEmptyConversation'].map(appFunction).join('\n'), context);
    await vm.runInContext(call, context);
    await new Promise(setImmediate);
    assert.ok(view.isOpen(), call + ' leaves History open');
    assert.ok(document.activeElement === input, 'with focus in the search field');
    assert.equal(input.value, 'Bronx', 'and the query as typed');
  };
  await run('pollSharedThread()');
  await run('reopenAfterRun("c1", 0)');
  await run('refreshAfterShareChange()');
  await run('discardEmptyConversation("c1")', {deleteChat: async () => { throw Object.assign(new Error('Not empty'), {status: 409}); }});
});

test('a page replacing itself, as a resolving site does when it lands, leaves History open; a new page closes it', async () => {
  for (const [replace, width] of [[true, 1440], [true, 390], [false, 1440]]) {
    const {view} = await openHistory();
    const context = {modelingBoot: false, historyView: view, route: {view: 'starting'}, chatDockOpen: true, history: {state: null, replaceState() {}, pushState() {}},
      window: {innerWidth: width, location: {pathname: '/starting'}}, parseRoute: () => ({projectId: 'p1'})};
    vm.createContext(context);
    vm.runInContext(appFunction('navigate') + appFunction('applyRoute'), context);
    try { vm.runInContext(`navigate("/sites/p1", null, {replace: ${replace}})`, context); } catch { /* past the stubs */ }
    assert.equal(view.isOpen(), replace, replace ? 'a replace keeps History' : 'a new page shows the thread');
    if (replace) assert.equal(context.chatDockOpen, true, 'and keeps the drawer it sits in, on a phone too');
  }
});

test('on a thread the reader can only view, Escape still steps back to the thread and then closes the drawer', async () => {
  const {createHistoryView} = await import('../public/conversation-view.js');
  for (const titleTakesFocus of [true, false]) {
    const document = historyDocument();
    document.querySelector('#prompt').disabled = true;
    // Where the title is hidden, as in the chat page's header on a phone, focus falls to the page.
    if (!titleTakesFocus) document.querySelector('#chat-context-title').focus = () => document.body.focus();
    const context = {document, $: (q) => document.querySelector(q)};
    vm.createContext(context);
    vm.runInContext(appFunction('focusThread'), context);
    const opener = document.querySelector('.brand'), dock = [];
    opener.focus();
    const view = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock: (open) => dock.push(open), focusThread: context.focusThread});
    view.onKeydown(key('k', {metaKey: true}));
    assert.equal(view.onKeydown(key('Escape')), true);
    assert.ok(document.activeElement === (titleTakesFocus ? document.querySelector('#chat-context-title') : document.body), 'focus goes to the thread\'s title when the composer cannot take it');
    assert.equal(view.onKeydown(key('Escape')), true);
    assert.deepEqual(dock, [true, false], 'the second Escape closes the drawer');
    assert.ok(document.activeElement === opener, 'and returns focus to the opener');
  }
});

test('Cmd+K leaves an open dialog in charge, and only an Escape pressed next closes the drawer', async () => {
  const {createHistoryView} = await import('../public/conversation-view.js');
  {
    const document = historyDocument();
    document.querySelector('#share-dialog').setAttribute('open', '');
    const dock = [];
    const view = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock: (open) => dock.push(open), focusThread() {}});
    const k = key('k', {metaKey: true});
    assert.equal(view.onKeydown(k), false);
    assert.ok(!k.prevented && !view.isOpen() && dock.length === 0, 'nothing opens or docks behind the dialog');
  }
  for (const between of ['key', 'pointer']) {
    const document = historyDocument();
    const dock = [];
    const view = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock: (open) => dock.push(open), focusThread: () => document.querySelector('#prompt').focus()});
    view.onKeydown(key('k', {metaKey: true}));
    view.onKeydown(key('Escape'));
    if (between === 'key') assert.equal(view.onKeydown(key('ArrowDown')), false);
    else document.dispatchEvent(new document.Event('pointerdown'));
    assert.equal(view.onKeydown(key('Escape')), false, 'a later Escape after a ' + between + ' is left to the chat');
    assert.deepEqual(dock, [true], 'and the drawer stays open');
  }
});

test('focus returns to the opener\'s row even when a refresh redrew the list while History was open', async () => {
  const {createHistoryView} = await import('../public/conversation-view.js');
  const document = historyDocument();
  const list = document.querySelector('.rail-recent-list');
  const row = () => { const b = document.createElement('button'); b.setAttribute('data-recent', 'c2'); return b; };
  list.replaceChildren(row());
  list.firstElementChild.focus();
  const dock = [];
  const view = createHistoryView({doc: document, load: async () => [], account: () => 'me', setDock: (open) => dock.push(open), focusThread: () => document.querySelector('#prompt').focus()});
  view.onKeydown(key('k', {metaKey: true}));
  list.replaceChildren(row());
  view.onKeydown(key('Escape'));view.onKeydown(key('Escape'));
  assert.deepEqual(dock, [true, false]);
  assert.ok(document.activeElement === list.firstElementChild, 'the redrawn row takes focus');
});

test('a Recent rail redraw keeps keyboard focus on the row it was on', async () => {
  const {renderRecentRail} = await import('../public/conversation-view.js');
  const document = historyDocument();
  const rail = document.querySelector('.rail-recent'), now = Date.now();
  const items = [{id: 'c1', title: 'Rear yard at 5 Elm', updated: now - 1000}, {id: 'c2', title: 'Two Bronx listings compared', updated: now - 2000}];
  renderRecentRail(rail, items, null, now);
  rail.querySelector('[data-recent="c2"]').focus();
  renderRecentRail(rail, items, 'c1', now);
  assert.ok(document.activeElement === rail.querySelector('[data-recent="c2"]'), 'the new row for the same conversation has focus');
  document.body.focus();
  renderRecentRail(rail, items, null, now);
  assert.ok(document.activeElement === document.body, 'a redraw never pulls focus into the rail');
});

// The drawer header on the site page fixture, in headless Chromium: every action a 44 px target, the
// title and its line inside the header, nothing scrolling sideways, and Expand widening the drawer.
const HEAD = `(() => {
  const head = document.querySelector('#main .chat-panel-head');
  const box = (e) => e.getBoundingClientRect();
  const h = box(head);
  return {
    buttons: [...head.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => ({name: b.getAttribute('aria-label'), width: Math.round(box(b).width), height: Math.round(box(b).height), inside: box(b).left >= h.left - 0.5 && box(b).right <= h.right + 0.5})),
    overflow: [head, ...head.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && !e.matches('#chat-context-title, .chat-attached')).map((e) => e.className || e.tagName),
    page: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
    title: document.querySelector('#chat-context-title').textContent,
    attached: document.querySelector('.chat-attached').textContent,
    saved: document.querySelector('.saved-label').hidden ? '' : document.querySelector('.saved-label').textContent,
    drawer: Math.round(box(document.querySelector('.chat-panel')).width),
    pageColumn: Math.round(box(document.querySelector('.shell')).width - box(document.querySelector('.chat-panel')).width),
  };
})()`;

test('the drawer header fits a phone and a desktop with five 44 px actions, and Expand widens the drawer', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 120000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/')}`);
  await waitFor(() => evaluate('!window.measured && document.readyState === "complete"'), 'the fixture');
  const open = async (width) => {
    await send('Emulation.setDeviceMetricsOverride', {width, height: 844, deviceScaleFactor: 1, mobile: width < 768});
    await evaluate(`localStorage.setItem('acres-chat-dock-open', 'true'); window.measured = true; location.href = ${JSON.stringify(base + '/sites/fx-plan')}`);
    await waitFor(() => evaluate(`!window.measured && document.querySelector('.chat-attached').textContent !== 'Not attached to a site' && document.querySelector('.uw-header')`), `the site chat at ${width}`);
    // A phone keeps the drawer closed over a site page until the reader opens it from the ask handle.
    await evaluate(`document.body.classList.contains('chat-dock-open') || document.querySelector('#ask-handle').requestSubmit(), 1`);
    await waitFor(() => evaluate(`document.body.classList.contains('chat-dock-open')`), `the drawer open at ${width}`);
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    return evaluate(HEAD);
  };
  for (const width of [390, 1280]) {
    const m = await open(width);
    const expected = width < 851 ? ['History', 'New chat', 'Share', 'Back to 1234 Fulton Street'] : ['History', 'New chat', 'Share', 'Expand chat', 'Close chat'];
    assert.deepEqual(m.buttons.map((b) => b.name), expected, `the header actions at ${width}`);
    for (const b of m.buttons) {
      assert.ok(b.width >= 44 && b.height >= 44, `${b.name} is ${b.width} by ${b.height} at ${width}`);
      assert.ok(b.inside, `${b.name} sits inside the header at ${width}`);
    }
    assert.deepEqual(m.overflow, [], `nothing in the header runs past its box at ${width}`);
    assert.equal(m.page, 0, `the page does not scroll sideways at ${width}`);
    assert.ok(m.title && m.title !== 'New conversation', `the conversation title shows at ${width}`);
    assert.ok(m.attached, `the attached site is named at ${width}`);
    assert.equal(m.saved, 'Saved', `the save status reads Saved at ${width}`);
  }
  const narrow = (await evaluate(HEAD)).drawer;
  await evaluate(`document.querySelector('.chat-panel-head .chat-expand').click(), 1`);
  await evaluate('new Promise((r) => setTimeout(r, 400))');
  const wide = await evaluate(HEAD);
  assert.ok(wide.drawer > narrow + 100, `Expand widens the drawer (${narrow} to ${wide.drawer} px)`);
  assert.ok(wide.pageColumn >= 479, `the page keeps a reading column beside the wide drawer (${wide.pageColumn} px)`);
  assert.deepEqual(await evaluate(`(() => { const b = document.querySelector('.chat-panel-head .chat-expand'); return [b.getAttribute('aria-label'), b.title, b.querySelector('use').getAttribute('href')]; })()`), ['Narrow chat', 'Narrow chat', '#collapse'], 'the pressed button says the next press narrows the drawer');
  await evaluate(`document.querySelector('.chat-panel-head .chat-expand').click(), 1`);
  await evaluate('new Promise((r) => setTimeout(r, 400))');
  assert.equal((await evaluate(HEAD)).drawer, narrow, 'Narrow returns the drawer to its width');
  assert.equal(wide.page, 0, 'the wide drawer does not push the page sideways');
});

// Expand is remembered per viewer: the next page load opens the drawer at the width the reader left it,
// and a browser that refuses storage still draws the narrow drawer with its Expand button.
test('the expanded drawer is remembered for the viewer, and a page without storage still draws it', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 120000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/')}`);
  await waitFor(() => evaluate('!window.measured && document.readyState === "complete"'), 'the fixture');
  const load = async () => {
    await evaluate(`localStorage.setItem('acres-chat-dock-open', 'true'); window.measured = true; location.href = ${JSON.stringify(base + '/sites/fx-plan')}`);
    await waitFor(() => evaluate(`!window.measured && document.body.classList.contains('chat-dock-open') && document.querySelector('.uw-header')`), 'the site page with its drawer');
    await evaluate('new Promise((r) => setTimeout(r, 400))');
    return evaluate(HEAD);
  };
  const expandLabel = `document.querySelector('.chat-panel-head .chat-expand').getAttribute('aria-label')`;
  const narrow = await load();
  assert.equal(await evaluate(expandLabel), 'Expand chat');
  await evaluate(`document.querySelector('.chat-panel-head .chat-expand').click(), 1`);
  const wide = await load();
  assert.ok(wide.drawer > narrow.drawer + 100, `the next load keeps the drawer wide (${narrow.drawer} to ${wide.drawer} px)`);
  assert.equal(await evaluate(expandLabel), 'Narrow chat', 'the remembered wide drawer offers to narrow');
  assert.equal(wide.page, 0, 'the wide drawer at 1440 does not scroll the page sideways');
  await evaluate(`document.querySelector('.chat-panel-head .chat-expand').click(), 1`);
  assert.equal((await load()).drawer, narrow.drawer, 'narrowing is remembered too');
  await evaluate(`document.querySelector('.chat-panel-head .chat-expand').click(), 1`);
  // Storage that throws on every read and write, installed before the app runs.
  await send('Page.enable');
  const {identifier} = await send('Page.addScriptToEvaluateOnNewDocument', {source: `Object.defineProperty(window, 'localStorage', {get() { throw new DOMException('blocked', 'SecurityError'); }});`});
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/sites/fx-plan')}`);
  await waitFor(() => evaluate(`!window.measured && document.querySelector('.uw-header') !== null`), 'the site page without storage');
  await evaluate(`document.body.classList.contains('chat-dock-open') || document.querySelector('#ask-handle').requestSubmit(), 1`);
  await waitFor(() => evaluate(`document.body.classList.contains('chat-dock-open')`), 'the drawer open without storage');
  assert.equal(await evaluate(`document.body.classList.contains('chat-dock-wide')`), false, 'without storage the drawer starts at its usual width');
  assert.equal(await evaluate(expandLabel), 'Expand chat');
  await evaluate(`document.querySelector('.chat-panel-head .chat-expand').click(), 1`);
  assert.equal(await evaluate(`document.body.classList.contains('chat-dock-wide')`), true, 'Expand still works when storage throws');
  await send('Page.removeScriptToEvaluateOnNewDocument', {identifier});
});

// A route that waits on the server during boot (a shared link here) paints the remembered wide drawer
// from the first frame, so the page column does not jump once the conversation arrives. A stray value
// under the width's key is just not wide, and saving the conversation keeps working.
test('a remembered wide drawer is wide before boot finishes, and a stray value cannot stop saving', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 120000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/')}`);
  await waitFor(() => evaluate('!window.measured && document.readyState === "complete"'), 'the fixture');
  // Holds the shared link's request until the test releases it, so boot stops at that await.
  await send('Page.enable');
  const {identifier} = await send('Page.addScriptToEvaluateOnNewDocument', {source: `{
    const real = window.fetch;
    window.sharedHeld = new Promise((resolve) => { window.releaseShared = resolve; });
    window.fetch = (input, init) => String(input.url || input).includes('/shared/') ? window.sharedHeld.then(() => real(input, init)) : real(input, init);
  }`});
  await evaluate(`localStorage.setItem('acres-chat-dock-open', 'true'); localStorage.setItem('acres-chat-dock-wide', 'true'); window.measured = true; location.href = ${JSON.stringify(base + '/shared/fx-shared-link')}`);
  await waitFor(() => evaluate(`!window.measured && typeof window.releaseShared === 'function' && document.body.classList.contains('chat-dock-open')`), 'the shared link waiting on its conversation');
  const width = `Math.round(document.querySelector('.chat-panel').getBoundingClientRect().width)`;
  assert.equal(await evaluate(`document.body.classList.contains('chat-dock-wide')`), true, 'the drawer is wide while boot waits on the server');
  assert.equal(await evaluate(`document.querySelector('.chat-panel-head .chat-expand').getAttribute('aria-label')`), 'Narrow chat');
  const waiting = await evaluate(width);
  await evaluate('window.releaseShared(), 1');
  await waitFor(() => evaluate(`document.querySelector('#chat-context-title').textContent === 'Two Bronx listings compared'`), 'the shared conversation');
  assert.equal(await evaluate(width), waiting, `the drawer keeps its width when the conversation arrives (${waiting} px)`);
  await send('Page.removeScriptToEvaluateOnNewDocument', {identifier});
  // A value the app never writes reads as not wide and leaves saving on.
  await evaluate(`localStorage.setItem('acres-chat-dock-wide', 'yes'); localStorage.removeItem('acres-nyc-chat-v3-fixture'); window.measured = true; location.href = ${JSON.stringify(base + '/sites/fx-plan')}`);
  await waitFor(() => evaluate(`!window.measured && document.querySelector('.uw-header') !== null`), 'the site page with a stray width value');
  assert.equal(await evaluate(`document.body.classList.contains('chat-dock-wide')`), false, 'a stray value leaves the drawer at its usual width');
  await evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = 'Draft kept'; p.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('acres-nyc-chat-v3-fixture') || '{}').draft`), 'Draft kept', 'the draft is still saved');
});

// A page that does not load the remembered conversation still names its site from History's list, and
// says nothing about saving a conversation that has not loaded.
test('a remembered site conversation on another page names its site and claims no save before it loads', {skip: !chrome && 'no Chrome or Chromium binary', timeout: 120000}, async (t) => {
  const base = await startFixture(t);
  const {send, evaluate} = await startBrowser(t);
  await send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 844, deviceScaleFactor: 1, mobile: false});
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/')}`);
  await waitFor(() => evaluate('!window.measured && document.readyState === "complete"'), 'the fixture');
  const remembered = await evaluate(`(async () => {
    const {namespace} = await (await fetch('/api/session')).json();
    const item = (await (await fetch('/api/conversations')).json()).conversations.find((c) => c.site);
    localStorage.setItem('acres-nyc-chat-v3-' + namespace, JSON.stringify({id: item.id}));
    localStorage.setItem('acres-chat-dock-open', 'true');
    return {title: item.title, site: item.site.title};
  })()`);
  await evaluate(`window.measured = true; location.href = ${JSON.stringify(base + '/whats-new')}`);
  await waitFor(() => evaluate(`!window.measured && document.querySelector('.chat-attached').textContent !== 'Not attached to a site'`), 'the remembered site named in the header');
  const head = await evaluate(HEAD);
  assert.equal(head.attached, remembered.site === remembered.title ? 'Site conversation' : remembered.site);
  assert.equal(head.saved, '', 'no save claimed before the conversation loads');
});
