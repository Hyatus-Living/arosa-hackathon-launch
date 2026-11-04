import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {parseRoute} from '../public/core-route.js';
import {clockTime} from '../public/run-trail.js';
import {shortcutLetter} from '../public/conversation-view.js';

// Execute the production ask handle block over the real page, without booting the app shell.
const read = (file) => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
const source = read('app.js');
const html = read('index.html');
const start = source.indexOf('function askBarVisible()');
const end = source.indexOf('\nasync function planListing(', start);
assert.ok(start >= 0 && end > start, 'the ask handle block is a contiguous slice of app.js');

const PAGES = {home: '/', listing: '/listings/4964456219:for_sale', sites: '/sites', modeling: '/modeling', site: '/sites/p1', plan: '/sites/p1/plan', report: '/sites/p1/report', "What's new": '/whats-new'};

function setup({path = '/', dockOpen = false, session = {namespace: 'acct1'}, run = {}} = {}) {
  const {document} = parseHTML(html);
  const calls = [];
  const context = {
    session, route: parseRoute(path), chatDockOpen: dockOpen, clockTime, Date: {now: () => run.now ?? 0}, state: {id: 'c1'},
    liveLabel: run.label ?? null, runStartedAt: run.startedAt ?? null, runSince: run.since ?? null,
    activeRun: run.label ? 'r1' : null, runRecord: (id) => (id === 'r1' && run.created ? {id, created: run.created} : null),
    historyView: {close: () => calls.push(['closeHistory'])},
    setChatDock: (open, options) => calls.push(['setChatDock', open, options]),
    $: (selector) => document.querySelector(selector),
    setInterval: () => 1, clearInterval() {},
  };
  vm.createContext(context);
  vm.runInContext('let unseenEnd = null, handleClock = null;' + source.slice(start, end), context);
  const handle = document.querySelector('#ask-handle');
  return {context, calls, document, handle, render: () => vm.runInContext('renderAskHandle()', context), status: () => handle.querySelector('.ask-bar-status')};
}

test('one handle with one name opens the chat on every page while the drawer is closed', () => {
  for (const [page, path] of Object.entries(PAGES)) {
    const f = setup({path});
    assert.equal(f.context.askBarVisible(), true, page);
    f.render();
    const handles = f.document.querySelectorAll('[aria-controls="chat-panel"][aria-expanded]');
    assert.equal(handles.length, 1, `${page} has exactly one handle`);
    // Disclosure state rides on the button, the element allowed to carry it; the form may not.
    assert.equal(handles[0], f.handle.querySelector('.send-button'));
    assert.equal(f.handle.querySelector('#ask-input').getAttribute('aria-label'), 'Ask Arosa', page);
    assert.equal(handles[0].getAttribute('aria-expanded'), 'false', page);
  }
  assert.equal(setup({dockOpen: true}).context.askBarVisible(), false, 'the drawer is open');
  assert.equal(setup({session: null}).context.askBarVisible(), false, 'signed out');
});

test('the handle is a real field that reads like the composer it opens', () => {
  const {document} = parseHTML(html);
  const handle = document.querySelector('.shell > #ask-bar > form#ask-handle');
  assert.ok(handle, 'the handle is a form in the shell page area');
  const input = document.querySelector('#ask-bar input#ask-input');
  assert.ok(input, 'the pill can be typed in where it sits, before the drawer opens');
  assert.equal(input.getAttribute('placeholder'), document.querySelector('#prompt').getAttribute('placeholder'));
  assert.equal(handle.getAttribute('aria-describedby'), 'ask-bar-status');
});

test('the floor plan page has no separate chat button', () => {
  assert.doesNotMatch(read('core.js'), /core-plan-ask/);
  for (const file of ['core.css', 'surfaces.css']) assert.doesNotMatch(read(file), /core-plan-ask/, file);
});

test('activating the handle opens the drawer on the thread and focuses its composer', () => {
  const f = setup();
  f.context.openFromHandle();
  assert.deepEqual(f.calls, [['closeHistory'], ['setChatDock', true, undefined]], 'setChatDock focuses #prompt by default');
});

test('with the drawer closed the handle shows the running step and time, then a new answer', () => {
  const f = setup({run: {label: 'Checking the zoning', since: 1000, now: 66000}});
  f.render();
  assert.equal(f.status().hidden, false);
  assert.equal(f.status().textContent, 'Checking the zoning · 1:05');
  assert.ok(f.handle.classList.contains('is-running'));
  const listed = setup({run: {label: 'Checking the zoning', since: 50000, created: 1000, now: 66000}});
  listed.render();
  assert.equal(listed.status().textContent, 'Checking the zoning · 1:05', 'timed from when the run was asked, not when this page opened');
  f.context.runStartedAt = 6000;
  f.render();
  assert.equal(f.status().textContent, 'Checking the zoning · 1:00', 'timed from when the run started working');

  f.context.liveLabel = null;
  f.context.noteRunEnded('run.completed', 'c1');
  f.render();
  assert.equal(f.status().textContent, 'New answer');
  assert.ok(!f.handle.classList.contains('is-running'));
  assert.ok(f.handle.classList.contains('has-answer'));

  f.context.chatDockOpen = true;
  f.render();
  f.context.chatDockOpen = false;
  f.render();
  assert.equal(f.status().hidden, true, 'opening the drawer shows the answer, so the handle goes quiet');
  assert.equal(f.handle.querySelector('.ask-bar-input').hidden, false);
});

test('a run that ends without an answer says it stopped, and one that ends in view leaves nothing new', () => {
  for (const event of ['run.failed', 'run.interrupted']) {
    const stopped = setup();
    stopped.context.noteRunEnded(event, 'c1');
    stopped.render();
    assert.equal(stopped.status().textContent, 'Research stopped', event);
    assert.ok(!stopped.handle.classList.contains('has-answer'), event);
  }
  const f = setup({dockOpen: true});
  f.context.noteRunEnded('run.completed', 'c1');
  f.context.chatDockOpen = false;
  f.render();
  assert.equal(f.status().hidden, true);
});

test('an ended run belongs to its conversation, so switching conversations does not carry it over', () => {
  const f = setup();
  f.context.noteRunEnded('run.completed', 'c1');
  f.context.state = {id: 'c2'};
  f.render();
  assert.equal(f.status().hidden, true, 'another saved site opens its own conversation');
  assert.equal(f.handle.querySelector('.ask-bar-input').hidden, false);
  f.context.state = {id: null};
  f.render();
  assert.equal(f.status().hidden, true, 'a new chat');
  f.context.state = {id: 'c1'};
  f.render();
  assert.equal(f.status().textContent, 'New answer', 'back on the conversation the answer is still unread');
});

test('the run stream marks its end for the handle', () => {
  const runEnd = source.slice(source.indexOf('if (/^run\\.(completed|failed|interrupted)$/.test(event.event)) {'));
  assert.match(runEnd.slice(0, 400), /noteRunEnded\(event\.event, state\.id\)/);
});

// The drawer's keyboard shortcut runs the production toggle, setChatDock and focusThread over the real
// page; focus is tracked by hand because the test DOM has none, and like a browser it skips a disabled
// or inert element.
const dockStart = source.indexOf('function setChatDock(');
const dockEnd = source.indexOf('\n// The last conversation, restored', dockStart);
assert.ok(dockStart >= 0 && dockEnd > dockStart, 'setChatDock is a contiguous slice of app.js');
const threadStart = source.indexOf('function focusThread()');
const threadEnd = source.indexOf('\nconst scrollState', threadStart);
assert.ok(threadStart >= 0 && threadEnd > threadStart, 'focusThread is a contiguous slice of app.js');

function keyboardSetup({session = {namespace: 'acct1'}} = {}) {
  const f = setup({session});
  let focused = null;
  Object.defineProperty(f.document, 'activeElement', {get: () => focused ?? f.document.body, configurable: true});
  for (const el of f.document.querySelectorAll('*')) el.focus = function () { if (!this.hasAttribute('disabled') && !this.closest('[inert]')) focused = this; };
  Object.assign(f.context, {document: f.document, shortcutLetter, window: {innerWidth: 1440}, history: {state: null}, setBodyMode() {}, requestAnimationFrame() {}, listings: {resize() {}}, localStorage: {setItem() {}}, CHAT_DOCK_KEY: 'k', save() {}, updateInput() {}});
  vm.runInContext('let dockAutoOpened = false, dockReturnFocus = null, dockHistoryActive = false, dockPendingFocus = null;' + source.slice(threadStart, threadEnd) + source.slice(dockStart, dockEnd), f.context);
  const press = (key, {meta = false, ctrl = false, shift = false, repeat = false, code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key, target = f.document.activeElement} = {}) => {
    const e = {key, code, metaKey: meta, ctrlKey: ctrl, shiftKey: shift, altKey: false, repeat, isComposing: false, target, prevented: false, preventDefault() { this.prevented = true; }};
    e.handled = f.context.onDockShortcut(e);
    return e;
  };
  return {...f, press, focused: () => f.document.activeElement};
}

test('phone chat Back closes the drawer without leaving the page or losing its history state', () => {
  const f = keyboardSetup(), url = 'https://app.test/sites/p1?section=options';
  const entries = [{state: {fromListing: '/listings/one'}, url}];
  let index = 0;
  f.context.window = {innerWidth: 390, location: {href: url}};
  f.context.history = {
    get state() { return entries[index].state; },
    pushState(state, _title, href) { entries.push({state, url: href}); index++; },
    back() { index--; f.context.onChatDockPopstate(); },
  };
  f.context.setChatDock(true);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].url, url);
  assert.equal(entries[1].state.fromListing, '/listings/one');
  f.context.setChatDock(false);
  assert.equal(index, 0);
  assert.equal(f.context.chatDockOpen, false);
  assert.equal(f.focused().id, 'ask-input');
  index = 1; f.context.onChatDockPopstate();
  assert.equal(f.context.chatDockOpen, true, 'Forward restores the drawer');
  assert.equal(f.focused().id, 'prompt');
});

test('Cmd+J or Ctrl+J opens the drawer at its composer and closes it back to where the reader was', () => {
  for (const modifier of [{meta: true}, {ctrl: true}]) {
    const f = keyboardSetup();
    const before = f.document.querySelector('#team-search');
    before.focus();
    const open = f.press('j', modifier);
    assert.ok(open.handled && open.prevented, 'the shortcut is taken');
    assert.equal(f.context.chatDockOpen, true);
    assert.equal(f.focused(), f.document.querySelector('#prompt'), 'the composer is focused');
    const close = f.press('J', modifier);
    assert.ok(close.handled && close.prevented);
    assert.equal(f.context.chatDockOpen, false);
    assert.equal(f.focused(), before, 'focus returns to the element focused before');
  }
  const f = keyboardSetup();
  assert.equal(f.press('j', {meta: true, shift: true}).handled, false, 'Shift+Cmd+J is not the shortcut');
  assert.equal(f.press('j').handled, false, 'a plain j types');
  assert.equal(f.context.chatDockOpen, false);
});

test('closing a drawer the shortcut did not open puts focus on the handle', () => {
  const f = keyboardSetup();
  f.context.setChatDock(true);
  f.press('j', {meta: true});
  assert.equal(f.context.chatDockOpen, false);
  assert.equal(f.focused(), f.handle.querySelector('#ask-input'));
  const g = keyboardSetup();
  g.document.querySelector('#team-search').focus();
  g.press('j', {meta: true});
  g.context.setChatDock(false);
  g.context.setChatDock(true);
  g.press('j', {meta: true});
  assert.equal(g.focused(), g.handle.querySelector('#ask-input'), 'a close in between forgets the earlier place');
});

test('Cmd+J from the pill carries its text into the composer', () => {
  const f = keyboardSetup();
  const ask = f.handle.querySelector('#ask-input');
  ask.value = 'What could be built here?';
  ask.focus();
  f.press('j', {meta: true});
  assert.equal(f.context.chatDockOpen, true);
  assert.equal(f.document.querySelector('#prompt').value, 'What could be built here?', 'the typed text follows into the drawer');
  assert.equal(ask.value, '');
  assert.equal(f.focused(), f.document.querySelector('#prompt'));
});

test('on a touch screen Enter is a new line in the composer, and a resize refits the draft field', () => {
  assert.ok(source.includes('!window.matchMedia("(pointer: coarse)").matches'), 'touch Enter does not send');
  assert.ok(source.includes('window.addEventListener("resize", () => { if ($("#prompt").value) updateInput(); });'), 'a resize refits the field');
});

test('Escape in an empty composer closes the drawer; with a draft it does not', () => {
  const f = keyboardSetup();
  const before = f.document.querySelector('#team-search');
  before.focus();
  f.press('j', {ctrl: true});
  const prompt = f.document.querySelector('#prompt');
  prompt.value = 'Is this worth pursuing?';
  assert.equal(f.press('Escape', {target: prompt}).handled, false, 'a draft keeps the drawer open');
  assert.equal(f.context.chatDockOpen, true);
  prompt.value = '';
  const e = f.press('Escape', {target: prompt});
  assert.ok(e.handled && e.prevented);
  assert.equal(f.context.chatDockOpen, false);
  assert.equal(f.focused(), before);
  assert.equal(f.press('Escape', {target: f.document.body}).handled, false, 'Escape elsewhere is left to the page');
});

test('the shortcut does nothing while a modal dialog is open or when signed out', () => {
  const f = keyboardSetup();
  f.document.querySelector('#share-dialog').setAttribute('open', '');
  const e = f.press('j', {meta: true});
  assert.ok(!e.handled && !e.prevented);
  assert.equal(f.context.chatDockOpen, false);
  f.document.querySelector('#share-dialog').removeAttribute('open');
  f.context.setChatDock(true);
  f.document.querySelector('#share-dialog').setAttribute('open', '');
  assert.equal(f.press('Escape', {target: f.document.querySelector('#prompt')}).handled, false, 'Escape belongs to the dialog');
  assert.equal(f.context.chatDockOpen, true);
  const out = keyboardSetup({session: null});
  assert.equal(out.press('j', {meta: true}).handled, false);
});

test('a conversation the reader can only view opens at its title, and Escape there closes it', () => {
  const f = keyboardSetup();
  const before = f.document.querySelector('#team-search');
  before.focus();
  f.document.querySelector('#prompt').setAttribute('disabled', '');
  f.press('j', {ctrl: true});
  const title = f.document.querySelector('#chat-context-title');
  assert.equal(f.context.chatDockOpen, true);
  assert.equal(f.focused(), title, 'focus goes into the chat, not to the page body');
  const e = f.press('Escape', {target: title});
  assert.ok(e.handled && e.prevented);
  assert.equal(f.context.chatDockOpen, false);
  assert.equal(f.focused(), before);
});

test('the open phone menu keeps the shortcut out, as a dialog does', () => {
  const f = keyboardSetup();
  f.document.querySelector('.sidebar').classList.add('open');
  f.document.querySelector('.shell').setAttribute('inert', '');
  const e = f.press('j', {ctrl: true});
  assert.ok(!e.handled && !e.prevented);
  assert.equal(f.context.chatDockOpen, false);
});

test('holding the keys toggles the drawer once', () => {
  const f = keyboardSetup();
  f.press('j', {meta: true});
  for (let i = 0; i < 3; i++) {
    const held = f.press('j', {meta: true, repeat: true});
    assert.ok(held.handled && held.prevented, 'a repeat is still taken from the browser');
  }
  assert.equal(f.context.chatDockOpen, true);
  assert.equal(f.focused(), f.document.querySelector('#prompt'));
});

test('on a non-Latin layout the J key still toggles the drawer', () => {
  const f = keyboardSetup();
  assert.ok(f.press('о', {ctrl: true, code: 'KeyJ'}).handled, 'Cyrillic layout');
  assert.equal(f.context.chatDockOpen, true);
  assert.ok(f.press('ח', {meta: true, code: 'KeyJ'}).handled, 'Hebrew layout');
  assert.equal(f.context.chatDockOpen, false);
  assert.equal(f.press('h', {meta: true, code: 'KeyJ'}).handled, false, 'a Latin layout goes by the letter');
  assert.equal(f.press('о', {meta: true, code: 'KeyO'}).handled, false, 'another physical key');
  assert.equal(shortcutLetter({key: 'К', code: 'KeyK'}, 'k'), true, 'search and new chat match the same way');
  assert.equal(shortcutLetter({key: 'Щ', code: 'KeyO'}, 'o'), true);
});

test('the page listens for the drawer shortcut and the handle names it', () => {
  const listener = source.slice(source.indexOf('if (historyView.onKeydown(e)) return;'));
  assert.match(listener.slice(0, 200), /onDockShortcut\(e\)/);
  assert.match(listener.slice(0, 400), /if \(!e\.repeat\) \$\("\.new-chat"\)\.click\(\)/, 'holding the new-chat keys starts one chat');
  const {document} = parseHTML(html);
  const handle = document.querySelector('#ask-input');
  assert.match(handle.getAttribute('title'), /⌘J/);
  assert.match(handle.getAttribute('title'), /Ctrl\+J/);
  assert.equal(handle.getAttribute('aria-keyshortcuts'), 'Meta+J Control+J');
});

test('a clock reads minutes and seconds', () => {
  assert.equal(clockTime(0), '0:00');
  assert.equal(clockTime(9400), '0:09');
  assert.equal(clockTime(65000), '1:05');
  assert.equal(clockTime(3723000), '62:03');
});

// Declarations of every rule whose selector list contains the selector, across the app's stylesheets.
const css = ['styles.css', 'workspace-shell.css', 'surfaces.css', 'listings.css', 'report.css'].map((f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
const declared = (selector, property) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, selectors]) => selectors.split(',').some((s) => s.trim() === selector))
  .flatMap(([, , body]) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim()));

test('every scrolling page leaves room under its last row for the whole bar, fade included', () => {
  // The clearance is built from the bar's own parts, so the last row ends above the fade, not only above the pill.
  const [clear] = declared('body', '--ask-clear');
  for (const part of ['--ask-fade', '--ask-pill', '--ask-gap']) assert.match(clear ?? '', new RegExp(`var\\(${part}\\)`), `the clearance counts ${part}`);
  assert.deepEqual(declared('.ask-bar', 'padding'), ['var(--ask-fade) 0 var(--ask-gap)']);
  assert.match(declared('.ask-bar', 'background')[0], /var\(--bg\) var\(--ask-fade\)/, 'the fade is as tall as the room above the pill');
  assert.deepEqual(declared('.ask-bar-pill', 'min-height'), ['var(--ask-pill)']);
  // The room goes on each scrolling pane itself: a pane's last child can be hidden (the sites list
  // under an open listing), and padding on a hidden child leaves the visible last row under the bar.
  // Each pane that scrolls also keeps a control the keyboard moves into view clear of the bar.
  for (const [pane, properties] of clearPanes) {
    for (const property of properties) {
      const values = declared(`body.ask-bar-open ${pane}`, property);
      assert.ok(values.length && values.every((v) => v === 'var(--ask-clear)'), `${pane} ${property} clears the bar (${values})`);
    }
  }
  for (const pane of ['.listings-results', '.core-page', '.report-page', '.whats-new-page']) {
    assert.deepEqual(declared(`body.ask-bar-open ${pane} > :last-child`, 'padding-bottom'), ['0'], `${pane} adds no second gap under its last child`);
  }
});

// Every screen rule in the page's stylesheets, in load order, with the media or container query it sits in.
const sheetRules = () => [...html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)"/g)].flatMap(([, file], sheet) => {
  const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const context = [];
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      const prelude = text.slice(from, i).trim();
      if (prelude.startsWith('@')) context.push(prelude);
      else {
        const close = text.indexOf('}', i);
        rules.push({selectors: prelude, body: text.slice(i + 1, close), media: context.join(' '), order: [sheet, rules.length]});
        i = close;
      }
      from = i + 1;
    } else if (text[i] === '}') {
      context.pop();
      from = i + 1;
    }
  }
  return rules.filter((rule) => !/@media print/.test(rule.media));
});
// Selector specificity as [ids, classes, types]; :where() counts nothing, :not/:is/:has count their arguments.
const specificity = (selector) => {
  const s = selector.replace(/:where\([^)]*\)/g, '').replace(/::?(before|after)\b|::[\w-]+/g, ' x');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]/g) || []).length + (s.match(/:(?!not\(|is\(|has\()[\w-]+/g) || []).length;
  const types = (s.replace(/[#.:][\w-]+|\[[^\]]*\]/g, '').match(/(?:^|[\s>+~(])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, types];
};
// Whether declaration a wins over b in the cascade: !important first, then specificity, then load order.
const beats = (a, b) => {
  if (a.important !== b.important) return a.important;
  const key = (d) => [...d.spec, ...d.order];
  const i = key(a).findIndex((n, j) => n !== key(b)[j]);
  return i !== -1 && key(a)[i] > key(b)[i];
};
const longhands = {'padding-bottom': ['padding', 'padding-block', 'padding-block-end', 'padding-bottom'], 'scroll-padding-bottom': ['scroll-padding', 'scroll-padding-block', 'scroll-padding-block-end', 'scroll-padding-bottom']};
const clearPanes = [
  ['.listings-results', ['padding-bottom', 'scroll-padding-bottom']],
  ['.core-page', ['padding-bottom', 'scroll-padding-bottom']],
  ['.report-page', ['padding-bottom', 'scroll-padding-bottom']],
  ['.whats-new-page', ['padding-bottom', 'scroll-padding-bottom']],
  ['.shell > .welcome', ['padding-bottom', 'scroll-padding-bottom']],
  ['.listings', ['padding-bottom']],
  ['#home-listings', ['scroll-padding-bottom']],
];

test('no other rule in the cascade takes the room back from a pane', () => {
  // Any rule that sets the same edge on the same element must lose to the bar's rule: lower
  // specificity, or equal and earlier. Media queries are ignored, so a rule for another width counts too.
  const rules = sheetRules();
  const targets = (selector, pane) => {
    const last = selector.split(/\s*[\s>+~]\s*(?![^(]*\))/).at(-1);
    return new RegExp(`(^|[^\\w-])${pane.split(' ').at(-1).replace(/[.#]/, '\\$&')}(?![\\w-])`).test(last);
  };
  for (const [pane, properties] of clearPanes) {
    for (const property of properties) {
      const declarations = rules.flatMap((rule) => rule.selectors.split(',').map((s) => s.trim()).filter((s) => targets(s, pane)).flatMap((selector) =>
        [...rule.body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].filter(([, name]) => longhands[property].includes(name))
          .map(([, name, value]) => ({selector, name, value: value.trim(), important: /!important/.test(value), spec: specificity(selector), order: rule.order}))));
      const ours = declarations.filter((d) => d.selector === `body.ask-bar-open ${pane}` && d.name === property);
      assert.ok(ours.length, `${pane} ${property} is set for the bar`);
      for (const other of declarations.filter((d) => !ours.includes(d))) {
        assert.ok(ours.every((d) => beats(d, other)), `${other.selector} { ${other.name}: ${other.value} } would override ${pane} ${property}`);
      }
    }
  }
});

test('notices rise above the bar rather than covering it', () => {
  const bottom = declared('body.ask-bar-open .toast', 'bottom');
  assert.ok(bottom.length && bottom.every((v) => parseFloat(v) >= 76), `the toast clears the bar (${bottom})`);
});

test('the chat drawer header actions are full-size touch targets', () => {
  for (const [selector, property] of [['#chat-panel .chat-head-button', 'min-height'], ['#chat-panel .chat-head-button', 'min-width']]) {
    const values = declared(selector, property);
    assert.ok(values.length && values.every((v) => parseFloat(v) >= 44), `${selector} ${property} is at least 44px (${values})`);
  }
});


test('phone shortcut returns focus after the asynchronous history close', () => {
  const f = keyboardSetup(); let state = null, pop;
  f.context.window = {innerWidth: 390, location: {href: 'https://app.test/sites/p1'}};
  f.context.history = {get state() { return state; }, pushState(value) { state = value; }, back() { state = null; pop = () => f.context.onChatDockPopstate(); }};
  const before = f.document.querySelector('#team-search'); before.focus();
  f.press('j', {meta: true}); f.press('j', {meta: true});
  assert.equal(f.context.chatDockOpen, true, 'the browser has not delivered popstate yet');
  assert.equal(f.focused().id, 'prompt');
  pop();
  assert.equal(f.context.chatDockOpen, false);
  assert.equal(f.focused(), before);
});

test('a run starting or ending never hides the field under text being typed', () => {
  const f = setup({run: {label: 'Checking the zoning', since: 1000, now: 66000}});
  const input = f.handle.querySelector('#ask-input');
  input.value = 'What about the rear yard?';
  f.render();
  assert.equal(input.hidden, false, 'the typed text stays visible');
  assert.equal(f.status().hidden, true, 'and the run status waits');
  input.value = '';
  f.render();
  assert.equal(input.hidden, true, 'an empty field gives way to the run');
  assert.equal(f.status().hidden, false);
});

test('focusing the pill field draws no outline of its own inside the pill', () => {
  assert.ok(declared('.ask-bar-input:focus-visible', 'outline').includes('none'), 'the pill ring is the only focus sign');
  assert.ok(declared('.ask-bar-input:focus', 'outline').includes('none'));
});

test('on a phone the chat fields are 16px, so focusing one does not zoom the page', () => {
  const surfaces = read('surfaces.css');
  const phone = surfaces.slice(surfaces.indexOf('@media (max-width: 850px)'));
  assert.match(phone, /\.ask-bar-pill \{[^}]*font-size: 16px;/);
  assert.match(phone, /\.composer textarea \{ font-size: 16px; \}/);
  assert.match(phone, /#conversation-search \{ font-size: 16px; \}/, 'the History search repeats the size where its own 15px base cannot outrank it');
});

// The pill's own listeners (send on Enter, IME guard, click to focus or open) over the real page.
const pillStart = source.indexOf('let askComposing = false;');
const pillEnd = source.indexOf('\nbindFilterPopover(', pillStart);
assert.ok(pillStart >= 0 && pillEnd > pillStart, 'the pill listeners are a contiguous slice of app.js');

function pillSetup() {
  const {document, window} = parseHTML(html);
  const calls = [];
  let focused = null;
  for (const el of document.querySelectorAll('*')) el.focus = function () { focused = this; };
  const context = {
    $: (selector) => document.querySelector(selector),
    state: {draft: ''},
    openFromHandle: () => calls.push(['open']),
    send: (text) => calls.push(['send', text]),
    updateInput: () => calls.push(['updateInput']),
    save: () => calls.push(['save']),
    toast: (message) => calls.push(['toast', message]),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(pillStart, pillEnd), context);
  const handle = document.querySelector('#ask-handle');
  const input = document.querySelector('#ask-input');
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, {bubbles: true, cancelable: true}));
  return {document, calls, handle, input, fire, focused: () => focused, prompt: document.querySelector('#prompt'), state: context.state};
}

test('Enter in the pill sends the question; empty Enter only opens the chat', () => {
  const f = pillSetup();
  f.input.value = 'Is 18823 120th Ave worth pursuing?';
  f.fire(f.input, 'input');
  assert.equal(f.handle.querySelector('.send-button').getAttribute('aria-label'), 'Send message');
  f.fire(f.handle, 'submit');
  assert.deepEqual(f.calls, [['open'], ['send', 'Is 18823 120th Ave worth pursuing?']]);
  assert.equal(f.input.value, '', 'the pill clears once the question is sent');
  assert.equal(f.handle.querySelector('.send-button').getAttribute('aria-label'), 'Open chat');
  const empty = pillSetup();
  empty.fire(empty.handle, 'submit');
  assert.deepEqual(empty.calls, [['open']], 'nothing typed, nothing sent');
});

test('Enter joins a different draft already in the drawer instead of sending either piece alone', () => {
  const f = pillSetup();
  f.prompt.value = 'Compare the zoning first.';
  f.input.value = 'Then price the headroom.';
  f.fire(f.handle, 'submit');
  assert.deepEqual(f.calls.filter(([name]) => name === 'send'), [], 'nothing sends itself');
  assert.equal(f.prompt.value, 'Compare the zoning first.\nThen price the headroom.');
  assert.equal(f.state.draft, f.prompt.value);
  assert.equal(f.focused(), f.prompt, 'the joined draft waits in the drawer for review');
});

test('Enter confirming an IME composition does not send half-composed text', () => {
  const f = pillSetup();
  f.input.value = 'とうきょう';
  f.fire(f.input, 'compositionstart');
  f.fire(f.handle, 'submit');
  assert.deepEqual(f.calls, [], 'the composition Enter is left to the IME');
  f.fire(f.input, 'compositionend');
  f.fire(f.handle, 'submit');
  assert.deepEqual(f.calls, [['open'], ['send', 'とうきょう']]);
});

test('a paste longer than a chat field holds says it was cut, in the pill and the composer', () => {
  const f = pillSetup();
  // The test DOM has no maxLength or selection; give both fields the browser values for their markup.
  for (const el of [f.input, f.prompt]) Object.defineProperties(el, {maxLength: {value: 3000}, selectionStart: {value: 0}, selectionEnd: {value: 0}});
  const paste = (el, text) => {
    const e = new f.document.defaultView.Event('paste', {bubbles: true, cancelable: true});
    e.clipboardData = {getData: () => text};
    el.dispatchEvent(e);
  };
  paste(f.input, 'x'.repeat(3100));
  paste(f.prompt, 'y'.repeat(3100));
  assert.deepEqual(f.calls, [['toast', 'Pasted text was cut to fit 3,000 characters.'], ['toast', 'Pasted text was cut to fit 3,000 characters.']]);
  paste(f.input, 'short');
  assert.equal(f.calls.length, 2, 'a paste that fits says nothing');
});

test('clicking the pill focuses its field, and clicking a running pill opens the drawer', () => {
  const f = pillSetup();
  f.fire(f.handle, 'click');
  assert.equal(f.focused(), f.input, 'a click on the pill padding puts the caret in the field');
  assert.deepEqual(f.calls, [], 'and does not open the drawer');
  f.input.hidden = true;
  f.fire(f.handle, 'click');
  assert.deepEqual(f.calls, [['open']], 'while a run shows, the click opens the chat');
});
