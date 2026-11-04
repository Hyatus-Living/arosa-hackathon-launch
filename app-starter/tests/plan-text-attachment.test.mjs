import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const helperUrl = new URL('../public/plan-text-attachment.js', import.meta.url);
const helpers = existsSync(helperUrl) ? await import(helperUrl) : {};
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
let start = source.indexOf('$("#plan-file-input")?.addEventListener("change"');
const counter = source.indexOf('let planAttachmentGeneration = 0;');
if (counter >= 0 && counter < start) start = counter;
const end = source.indexOf('\n$("#prompt").addEventListener("keydown"', start);
assert.ok(start >= 0 && end > start);
const updateStart = source.indexOf('function updateInput() {');
const updateEnd = source.indexOf('\n$("#prompt").addEventListener("input"', updateStart);
assert.ok(updateStart >= 0 && updateEnd > updateStart);

function setup(draft = 'My exact question') {
  const {document} = parseHTML('<textarea id="prompt"></textarea><span id="prompt-count"></span><button class="send-button"></button><button id="attach-plan-button"><span>Add plan text</span></button><input id="plan-file-input"><div id="run-controls"><button>Steer</button></div>');
  const prompt = document.querySelector('#prompt');prompt.value = draft;prompt.focus = () => {};
  Object.defineProperty(prompt, 'scrollHeight', {value: 40});
  const input = document.querySelector('input');input.value = 'selected.txt';input.files = [];
  input.addEventListener = (_name, fn) => {context.change = fn;};
  const context = {...helpers, generation: 1, state: {id: 'c1', draft}, prompt, input, document, window: {listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }}, historyView: {close: () => context.closed++}, setChatDock: () => context.docked++, closed: 0, docked: 0, toasts: [], saved: 0,
    planAttachmentPending: false, submitPending: false, busy: false, canSend: () => true,
    $: (selector) => document.querySelector(selector),
    save: () => context.saved++, toast: (text) => context.toasts.push(text)};
  vm.createContext(context);vm.runInContext(source.slice(updateStart, updateEnd) + '\n' + source.slice(start, end), context);
  context.updateInput();
  context.add = (file) => {input.files = [file];return context.change({target: input});};
  return context;
}
function deferredFile() {
  let finish;
  const file = new File(['plan'], 'survey.txt', {type: 'text/plain'});
  file.text = () => new Promise((resolve) => {finish = resolve;});
  return {file, finish: (text) => finish(text)};
}

test('a fitting plan text file preserves all source text and the exact existing question', async () => {
  const draft = '  Preserve this question and its spacing.  ';
  const text = '{\n  "dimensions": "' + 'x'.repeat(2100) + '"\n}\n';
  const c = setup(draft);await c.add(new File([text], 'survey.json'));
  assert.ok(c.prompt.value.startsWith(draft + '\n\n'));
  assert.ok(c.prompt.value.includes(text));
  assert.ok(c.prompt.value.length <= 3000);
  assert.equal(c.state.draft, c.prompt.value);
  assert.equal(c.saved, 1);
  assert.doesNotMatch(c.prompt.value, /acres_audit_floorplan/);
});

test('a file that does not fit leaves the question intact and does not claim an attachment', async () => {
  const draft = 'q'.repeat(2900);
  const c = setup(draft);await c.add(new File(['s'.repeat(600)], 'survey.txt'));
  assert.equal(c.prompt.value, draft);
  assert.equal(c.state.draft, draft);
  assert.equal(c.saved, 0);
  assert.match(c.toasts.at(-1), /fit|limit|too large/i);
});

test('unsupported and oversized files are refused without changing the draft or reading huge input', async () => {
  const unsupported = setup();await unsupported.add(new File(['pixels'], 'survey.png'));
  assert.equal(unsupported.saved, 0);
  const c = setup();let reads = 0;
  const file = new File(['x'.repeat(12001)], 'large.ifc');
  file.text = async () => {reads++;return 'unexpected read';};
  await c.add(file);
  assert.equal(reads, 0);
  assert.equal(c.prompt.value, 'My exact question');
  assert.equal(c.saved, 0);
});

test('a late file read cannot alter a different conversation draft', async () => {
  const c = setup();const d = deferredFile();const pending = c.add(d.file);
  c.generation++;c.state = {id: 'c2', draft: 'New conversation question'};c.prompt.value = c.state.draft;
  d.finish('Old conversation plan');await pending;
  assert.equal(c.prompt.value, 'New conversation question');
  assert.equal(c.saved, 0);
});

test('edits made while reading a file are preserved in the same conversation', async () => {
  const c = setup();const d = deferredFile();const pending = c.add(d.file);
  c.prompt.value = 'The edited question';d.finish('Complete plan text');await pending;
  assert.ok(c.prompt.value.startsWith('The edited question'));
  assert.ok(c.prompt.value.includes('Complete plan text'));
});

test('a newer file selection wins over an older pending read', async () => {
  const c = setup();const d = deferredFile();const older = c.add(d.file);
  await c.add(new File(['The new plan'], 'new.txt'));
  d.finish('The obsolete plan');await older;
  assert.match(c.prompt.value, /The new plan/);
  assert.doesNotMatch(c.prompt.value, /The obsolete plan/);
  assert.equal(c.saved, 1);
});

test('a file dropped on the page attaches as plan text instead of replacing the page, and a text drop is left alone', async () => {
  const c = setup('My exact question');
  const drop = (dataTransfer) => {
    let prevented = false;
    c.window.listeners.drop({preventDefault: () => { prevented = true; }, dataTransfer});
    return prevented;
  };
  assert.equal(drop({types: ['text/plain'], files: []}), false, 'a text drag still drops where it was aimed');
  let overPrevented = false;
  c.window.listeners.dragover({preventDefault: () => { overPrevented = true; }, dataTransfer: {types: ['Files']}});
  assert.equal(overPrevented, true);
  assert.equal(drop({types: ['Files'], files: [new File(['DROPPED PLAN'], 'survey.txt')]}), true, 'the browser never navigates to the dropped file');
  for (let i = 0; i < 6 && !c.prompt.value.includes('DROPPED PLAN'); i++) await new Promise((r) => setImmediate(r));
  assert.ok(c.prompt.value.includes('DROPPED PLAN'));
  assert.equal(c.docked, 1, 'the chat opens on the attached text');
  assert.match(c.toasts.at(-1), /Added complete text from survey\.txt/);
});

test('Send waits for the selected text and becomes available after the read settles', async () => {
  const c = setup();const d = deferredFile();const pending = c.add(d.file);
  c.busy = true;c.updateInput();
  try {
    assert.equal(c.document.querySelector('.send-button').disabled, true);
    assert.equal(c.document.querySelector('#run-controls button').disabled, true);
    assert.match(c.document.querySelector('#attach-plan-button').textContent, /Reading text/);
  } finally {d.finish('The complete plan');await pending;}
  assert.equal(c.document.querySelector('.send-button').disabled, false);
  assert.equal(c.document.querySelector('#run-controls button').disabled, false);
  assert.equal(c.document.querySelector('#attach-plan-button').textContent, 'Add plan text');
});
