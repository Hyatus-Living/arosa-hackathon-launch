import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

// Execute the production controller function without booting the unrelated app shell.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
let start = source.indexOf('async function loadShare() {');
const counter = source.indexOf('let shareLoadGeneration = 0;');
if (counter >= 0 && counter < start) start = counter;
const end = source.indexOf('\nfunction openShare()', start);
assert.ok(start >= 0 && end > start);
function setup() {
  const {document} = parseHTML('<dialog id="share-dialog"><p id="share-notice"></p><div id="share-manage" hidden><input id="share-link-url" value="https://example.com/shared/previous-token"></div></dialog>');
  const dialog = document.querySelector('dialog');dialog.open = true;
  const requests = [], renders = [];
  const context = {
    state: {id: 'old', access: 'owner'},
    shareGrants: [{id: 'previous-grant'}], shareLinks: [{token: 'previous-token'}], shareTeamSelection: null,
    $: (selector) => document.querySelector(selector),
    isOwner: () => context.state.access === 'owner',
    chatRequest: (url) => new Promise((resolve, reject) => requests.push({url, resolve, reject})),
    loadTeamsCache: async () => {}, renderEffectiveMembers() {}, renderShareTeamOptions() {},
    renderShareGrants: () => renders.push({id: context.state.id, grants: context.shareGrants}),
    renderShareLinks: () => renders.push({id: context.state.id, links: context.shareLinks}),
  };
  vm.createContext(context);vm.runInContext(source.slice(start, end), context);
  const answer = (id) => {
    requests.find((r) => r.url === `/conversations/${id}/members`).resolve({members: [{id: `${id}-grant`}]});
    requests.find((r) => r.url === `/conversations/${id}/links`).resolve({links: [{token: `${id}-token`}]});
  };
  return {context, document, dialog, answer, renders};
}

test('sharing controls hide old grants and links while new settings are loading', async () => {
  const {context, document, answer} = setup();
  const loading = context.loadShare();
  assert.equal(document.querySelector('#share-manage').hidden, true);
  assert.equal(document.querySelector('#share-link-url').value, '');
  assert.equal(document.querySelector('#share-link-url').hidden, true);
  answer('old');await loading;
  assert.equal(document.querySelector('#share-manage').hidden, false);
});

test('an older Share dialog cannot replace a newer conversation grants or public links', async () => {
  const {context, answer} = setup();
  const older = context.loadShare();
  context.state = {id: 'new', access: 'owner'};
  const newer = context.loadShare();
  answer('new');await newer;
  answer('old');await older;
  assert.equal(context.shareGrants[0].id, 'new-grant');
  assert.equal(context.shareLinks[0].token, 'new-token');
});

test('an obsolete load cannot clear the new dialog loading state', async () => {
  const {context, dialog, answer} = setup();
  const older = context.loadShare();
  context.state = {id: 'new', access: 'owner'};
  const newer = context.loadShare();
  answer('old');await older;
  assert.equal(dialog.getAttribute('aria-busy'), 'true');
  answer('new');await newer;
  assert.equal(dialog.hasAttribute('aria-busy'), false);
});

test('a closed dialog cannot publish settings after its pending response arrives', async () => {
  const {context, dialog, answer, renders} = setup();
  const loading = context.loadShare();dialog.open = false;
  answer('old');await loading;
  assert.equal(renders.length, 0);
});

test('a previous load waiting for teams cannot render or settle a newer dialog', async () => {
  const {context, dialog, answer, renders} = setup();
  const teams = [];
  context.loadTeamsCache = () => new Promise((resolve) => teams.push(resolve));
  const older = context.loadShare();answer('old');await new Promise(setImmediate);
  context.state = {id: 'new', access: 'owner'};
  const newer = context.loadShare();
  teams[0]();await older;
  assert.equal(renders.length, 0);
  assert.equal(dialog.getAttribute('aria-busy'), 'true');
  answer('new');await new Promise(setImmediate);teams[1]();await newer;
  assert.equal(context.shareLinks[0].token, 'new-token');
});
