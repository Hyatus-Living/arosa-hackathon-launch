import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseRoute, routePath, resolveRoute} from '../public/core-route.js';
import {parseHTML} from 'linkedom';
import {upsertConversationItem,renderRecentRail} from '../public/conversation-view.js';

test('a modeling conversation keeps its destination through local history updates and the Recent rail',()=>{
  const site={id:'model_1',title:'A building',workflow:'modeling'};
  const entries=upsertConversationItem([],{id:'chat_1',projectId:site.id,title:'Draw the building',site,workflow:'modeling',updated:Date.now()});
  assert.equal(entries[0].site.workflow,'modeling');
  const {document}=parseHTML(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));
  renderRecentRail(document.querySelector('.rail-recent'),entries,'chat_1');
  const row=document.querySelector('[data-recent=chat_1]');
  assert.equal(row.dataset.site,'model_1');assert.equal(row.dataset.workflow,'modeling');
  assert.match(row.querySelector('small').textContent,/Modeling/);
});

// Execute the production address-following logic against a browser-like history stack.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function followListing(');
const end = source.indexOf('\n// A site opened from a listing', start);
assert.ok(start >= 0 && end > start);

function setup(path = '/', search = '') {
  const entries = [{path, search, state: null}];
  let index = 0;
  const location = {get pathname() { return entries[index].path; }, get search() { return entries[index].search; }, origin: 'https://app.test'};
  const split = (url) => { const u = new URL(url, 'https://app.test'); return {path: u.pathname, search: u.search}; };
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state, _t, url) { entries.splice(index + 1); entries.push({...split(url), state}); index++; },
    replaceState(state, _t, url) { entries[index] = {...split(url), state}; },
    back() { index--; },
  };
  const context = {route: parseRoute(path), history, window: {location}, parseRoute, routePath, URL};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return {context, entries, at: () => entries[index], position: () => index};
}

test('opening a listing adds an address; closing it steps back to the results', () => {
  const f = setup('/', '?search=%7B%7D');
  f.context.followListing('broker:ripco:11:for_sale');
  assert.equal(f.at().path, '/listings/broker%3Aripco%3A11%3Afor_sale');
  assert.equal(f.at().search, '?search=%7B%7D', 'a shared search stays on the address');
  assert.deepEqual({...f.context.route}, {view: 'home', listingId: 'broker:ripco:11:for_sale'});
  f.context.followListing(null);
  assert.equal(f.position(), 0, 'back to results returns to the same history entry');
  assert.deepEqual({...f.context.route}, {view: 'home'});
});

test('a listing opened from a pasted link closes onto the results address without leaving the app', () => {
  const f = setup('/listings/one');
  f.context.followListing(null);
  assert.equal(f.entries.length, 1);
  assert.equal(f.at().path, '/');
});

test('moving between listings keeps each one in history', () => {
  const f = setup('/');
  f.context.followListing('one');
  f.context.followListing('two');
  assert.deepEqual(f.entries.map(e => e.path), ['/', '/listings/one', '/listings/two']);
  f.context.followListing(null);
  assert.equal(f.at().path, '/', 'the second listing was opened from a listing, so closing it shows the results in place');
});

test('the address only follows listings on home, and an unchanged listing adds nothing', () => {
  const f = setup('/sites');
  f.context.followListing('one');
  assert.equal(f.entries.length, 1);
  const g = setup('/listings/one');
  g.context.followListing('one');
  assert.equal(g.entries.length, 1);
});

test('a site started from a listing replaces its resolving address and carries the listing to its pages', () => {
  const navSource = source.slice(source.indexOf('function navigate('), source.indexOf('function applyRoute('));
  const entries = [{path: '/listings/one', search: '', state: null}];
  let index = 0;
  const location = {get pathname() { return entries[index].path; }};
  const history = {
    get state() { return entries[index].state; },
    pushState(state, _t, url) { entries.splice(index + 1); entries.push({path: url, search: '', state}); index++; },
    replaceState(state, _t, url) { entries[index] = {path: url, search: '', state}; },
  };
  const context = {modelingBoot: false, route: parseRoute('/listings/one'), history, window: {location, innerWidth: 1400}, parseRoute, routePath, chatDockOpen: true, historyView: {isOpen: () => false}, applyRoute() { context.route = parseRoute(location.pathname); }};
  vm.createContext(context);
  vm.runInContext(navSource, context);
  // The listing opens the resolving-site page at once, remembering the listing.
  context.navigate('/sites/new', {fromListing: '/listings/one'});
  assert.deepEqual(entries.map((e) => e.path), ['/listings/one', '/sites/new']);
  // Once the parcel is identified the page becomes the site in place, so back returns to the listing.
  context.navigate('/sites/p1/plan', history.state, {replace: true});
  assert.deepEqual(entries.map((e) => e.path), ['/listings/one', '/sites/p1/plan']);
  assert.equal(JSON.stringify(history.state), '{"fromListing":"/listings/one"}');
  // Moving between the site's pages keeps the listing; another site does not inherit it.
  context.navigate('/sites/p1');
  assert.equal(JSON.stringify(history.state), '{"fromListing":"/listings/one"}');
  context.navigate('/sites/p2');
  assert.equal(history.state, null);
  assert.equal(index, 3);
});

test('/chat is home with the chat drawer open, rewritten in place so a saved conversation link still lands', () => {
  assert.deepEqual(parseRoute('/chat'), {view: 'home', chat: true});
  assert.deepEqual(parseRoute('/chat/'), {view: 'home', chat: true});
  assert.equal(routePath(parseRoute('/chat')), '/');
  for (const [pathname, hash, landed] of [['/chat', '', '/'], ['/chat', '#thread=c1', '/#thread=c1'], ['/chat/', '#thread=c1&concept=k2', '/#thread=c1&concept=k2']]) {
    const f = setup(pathname);
    const location = {pathname, search: '', hash};
    const route = resolveRoute(location, f.context.history, {});
    assert.deepEqual({...route}, {view: 'home', chat: true});
    assert.equal(f.entries.length, 1, 'no new history entry');
    assert.equal(f.at().path + (f.at().search || '') + hash, landed);
  }
});

test('one chat drawer on every page: the rail has no Chat item, Teams appears once, and nothing links to a chat page', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const {document} = parseHTML(html);
  const routes = [...document.querySelectorAll('#navigation .app-nav [data-route]')].map((n) => n.dataset.route);
  assert.deepEqual(routes, ['/', '/sites', '/modeling', '/whats-new']);
  assert.equal(document.querySelectorAll('[href="/chat"], [data-route="/chat"]').length, 0);
  // Dialogs open from the page; on the page itself Teams is named once.
  const teams = [...document.querySelectorAll('body *')].filter((el) => !el.children.length && el.textContent.trim() === 'Teams' && !el.closest('dialog'));
  assert.equal(teams.length, 1, 'Teams is named once, in the rail');
  assert.ok(teams[0].closest('#navigation'));
  assert.equal(document.querySelector('#chat-history, #history-toggle, .chat-page-return'), null, 'no history column, history toggle or way back from a chat page');
  assert.doesNotMatch(source, /navigate\("\/chat"\)|chatIsPage|chatReturnRoute/);
});

test('a truncated or malformed share link opens home instead of failing to start the app', () => {
  assert.deepEqual(parseRoute('/listings/%E0%A4%A'), {view: 'home'});
  assert.deepEqual(parseRoute('/sites/%E0%A4%A/plan'), {view: 'sites'});
  assert.deepEqual(parseRoute('/shared/%'), {view: 'home'});
  assert.deepEqual(parseRoute('/listings/one%20two'), {view: 'home', listingId: 'one two'});
});

// One function of app.js, as written.
const fnSource = (name) => { const at = source.search(new RegExp('^function ' + name + '\\(', 'm')); assert.ok(at >= 0, name); return source.slice(at, source.indexOf('\n}\n', at) + 2); };

test('a shared or #thread link shows its conversation in the drawer at any width, without saving that choice', () => {
  for (const width of [390, 1440]) {
    const calls = [];
    const context = {state: {id: 'c1', messages: [{role: 'user'}]}, window: {innerWidth: width}, dockAutoOpened: true, setChatDock: (open, options) => calls.push([open, options])};
    vm.createContext(context);
    vm.runInContext(fnSource('showLinkedConversation'), context);
    context.showLinkedConversation('c1');
    assert.equal(JSON.stringify(calls), JSON.stringify([[true, {focus: false, remember: false}]]), `opens at ${width}`);
    assert.equal(context.dockAutoOpened, false, 'listings arriving later leave it open');
    context.showLinkedConversation('other');
    context.state.messages = [];
    context.showLinkedConversation('c1');
    assert.equal(calls.length, 1, 'only for the linked conversation, once it has messages');
  }
});

// runExample as written, with the conversation, the drawer and sending recorded.
function example(state) {
  const calls = [];
  const context = {
    state,
    startBlankChat: () => { calls.push('new conversation'); context.state = {id: null, messages: []}; },
    setChatDock: (open, options) => calls.push(`drawer ${open ? 'open' : 'closed'}${options?.focus === false ? '' : ' with focus'}`),
    send: (text) => calls.push(`send into ${context.state.id || 'a new conversation'}: ${text}`),
  };
  vm.createContext(context);
  vm.runInContext(fnSource('runExample'), context);
  context.runExample('Q');
  return calls;
}

test('an example question starts its own conversation in the drawer, never one already open there', () => {
  const fresh = ['drawer open', 'send into a new conversation: Q'];
  assert.deepEqual(example({id: null, messages: []}), fresh, 'with nothing open, the drawer opens before it runs');
  const own = example({id: 'c1', messages: [{role: 'user'}, {role: 'assistant'}]});
  assert.deepEqual(own, ['new conversation', ...fresh], 'a restored conversation keeps its messages');
  const viewed = example({id: 'shared', messages: [{role: 'user'}], access: {role: 'viewer'}});
  assert.deepEqual(viewed, ['new conversation', ...fresh], 'a thread the reader can only view does not swallow it');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const {document} = parseHTML(html);
  assert.ok([...document.querySelectorAll('[data-prompt]')].every((b) => b.closest('#welcome')), 'examples live on home\'s welcome');
  assert.ok(source.includes('if (p) runExample(p.dataset.prompt);'), 'a click on one runs it');
});
