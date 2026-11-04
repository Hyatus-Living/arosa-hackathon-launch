import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

// Execute the production message placement without booting the app shell.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function placeMessageNode(');
const end = source.indexOf('\n}\n', start) + 3;
assert.ok(start >= 0 && end > start, 'placeMessageNode is a function in app.js');

function setup(markup) {
  const {document} = parseHTML(`<div id="messages">${markup}</div>`);
  const context = {$: (s) => document.querySelector(s), document};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return {context, document};
}
const order = (document) => [...document.querySelector('#messages').children].map((n) => n.id || n.dataset.messageId);

test('a new message goes under the earlier messages but above the live research turn', () => {
  const {context, document} = setup('<article data-message-id="m1"></article><article id="live-turn"></article>');
  const node = document.createElement('article');
  node.dataset.messageId = 'pending-1';
  context.placeMessageNode(node);
  assert.deepEqual(order(document), ['m1', 'pending-1', 'live-turn']);
});

test('without a live turn a new message is simply last', () => {
  const {context, document} = setup('<article data-message-id="m1"></article>');
  const node = document.createElement('article');
  node.dataset.messageId = 'm2';
  context.placeMessageNode(node);
  assert.deepEqual(order(document), ['m1', 'm2']);
});
