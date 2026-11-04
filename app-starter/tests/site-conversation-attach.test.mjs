import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the production attach logic without booting the app shell.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function readProjectChats()');
const end = source.indexOf('\n// Selecting a listing or an address', start);
assert.ok(start >= 0 && end > start);

function setup({remembered = {}, running = {}} = {}) {
  const opened = [], blank = [];
  let resolveHistory;
  const context = {
    session: {namespace: 'acct1'},
    state: {id: null, projectId: null},
    route: {view: 'site', projectId: 'p_fulton'},
    archive: [],
    historyLoading: true,
    historyReady: new Promise((resolve) => { resolveHistory = resolve; }),
    projectChatsKey: 'acres-core-chats-acct1',
    storageUnavailable: false,
    readSaved: () => remembered,
    localStorage: {setItem() {}},
    openConversation: async (id) => { opened.push(id); context.state = {id, projectId: 'p_fulton'}; },
    startBlankChat: () => blank.push(true),
    jobs: {forProject: (id) => running[id] || null},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return {
    context, opened, blank,
    historyArrives(conversations) { context.archive = conversations; context.historyLoading = false; resolveHistory(); },
  };
}

test('a site opened directly attaches its conversation once the history arrives', async () => {
  const f = setup();
  const attaching = f.context.attachProjectConversation('p_fulton');
  f.historyArrives([{id: 'c1', projectId: 'p_fulton'}]);
  await attaching;
  assert.deepEqual(f.opened, ['c1']);
  assert.equal(f.blank.length, 0);
});

test('a site with no conversation starts a blank chat only after the history is known', async () => {
  const f = setup();
  const attaching = f.context.attachProjectConversation('p_fulton');
  f.historyArrives([{id: 'c9', projectId: 'other'}]);
  await attaching;
  assert.deepEqual(f.opened, []);
  assert.equal(f.blank.length, 1);
});

test('leaving the site while its history loads attaches nothing', async () => {
  const f = setup();
  const attaching = f.context.attachProjectConversation('p_fulton');
  f.context.route = {view: 'home', projectId: null};
  f.historyArrives([{id: 'c1', projectId: 'p_fulton'}]);
  await attaching;
  assert.deepEqual(f.opened, []);
  assert.equal(f.blank.length, 0);
});

test('a site with research still running opens that run\'s conversation first', async () => {
  const f = setup({running: {p_fulton: {conversationId: 'c_running'}}});
  const attaching = f.context.attachProjectConversation('p_fulton');
  f.historyArrives([{id: 'c1', projectId: 'p_fulton'}, {id: 'c_running', projectId: 'p_fulton'}]);
  await attaching;
  assert.deepEqual(f.opened, ['c_running']);
});
