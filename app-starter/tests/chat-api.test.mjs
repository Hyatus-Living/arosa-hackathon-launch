import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRequest, streamRun } from '../public/chat-api.js';

test('reconnecting streams deliver each persisted event once and close on completion', t => {
  class EventSourceFixture {
    constructor(url) { this.url = url; this.closed = false; }
    close() { this.closed = true; }
    emit(event) { this.onmessage({ data: JSON.stringify(event) }); }
  }
  const original = globalThis.EventSource;
  globalThis.EventSource = EventSourceFixture;
  t.after(() => { globalThis.EventSource = original; });
  const events = [];
  let disconnects = 0;
  const handle = streamRun('saved-run', e => events.push(e), () => disconnects++), stream = handle.source;
  assert.equal(stream.url, '/api/runs/saved-run/events');
  stream.emit({ seq: 1, event: 'run.started' });
  stream.emit({ seq: 2, event: 'message.delta', delta: 'Hello' });
  stream.onerror();
  stream.emit({ seq: 1, event: 'run.started' });
  stream.emit({ seq: 2, event: 'message.delta', delta: 'Hello' });
  stream.emit({ seq: 3, event: 'message.delta', delta: ' world' });
  stream.emit({ seq: 4, event: 'run.completed' });
  assert.equal(disconnects, 1);
  assert.equal(events.map(e => e.delta || '').join(''), 'Hello world');
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]);
  assert.equal(stream.closed, true);
});

test('a stream refused while research restarts reopens from its cursor, and gives up only after the retry window', t => {
  const opened = [];
  class EventSourceFixture {
    constructor(url) { this.url = url; this.closed = false; this.readyState = 1; opened.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    emit(event) { this.onmessage({ data: JSON.stringify(event) }); }
    refuse() { this.readyState = 2; this.onerror(); }
  }
  const original = globalThis.EventSource;
  globalThis.EventSource = EventSourceFixture;
  t.after(() => { globalThis.EventSource = original; });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const events = [], disconnects = [];
  const handle = streamRun('queued-run', e => events.push(e.seq), d => disconnects.push(d), { retryMs: 3000, retryForMs: 10000 });
  opened[0].emit({ seq: 1, event: 'run.queued' });
  opened[0].refuse();
  assert.deepEqual(disconnects, [{ final: false }]);
  t.mock.timers.tick(3000);
  assert.equal(opened.length, 2);
  assert.equal(opened[1].url, '/api/runs/queued-run/events?after=1');
  opened[1].onopen();
  opened[1].emit({ seq: 2, event: 'run.started' });
  opened[1].refuse();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(3000); opened.at(-1).refuse(); }
  assert.deepEqual(disconnects.at(-1), { final: true });
  assert.equal(opened.at(-1).closed, true);
  t.mock.timers.tick(30000);
  assert.equal(opened.length, 6);
  assert.deepEqual(events, [1, 2]);
  handle.close();
});

test('an unresponsive API request times out instead of pending forever', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    assert.ok(options.signal, 'chatRequest must pass an abort signal');
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  });
  await assert.rejects(chatRequest('/conversations', { timeoutMs: 25 }), /timed out/i);
});

test('an HTML gateway error keeps its status, while an HTML sign-in page still reads as a lost sign-in', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const page = status => new Response('<!DOCTYPE html><title>Bad gateway</title>', { status, headers: { 'content-type': 'text/html' } });
  globalThis.fetch = async () => page(502);
  await assert.rejects(chatRequest('/runs/r1'), e => e.status === 502 && /interrupted/.test(e.message));
  globalThis.fetch = async () => page(200);
  await assert.rejects(chatRequest('/runs/r1'), e => e.status === undefined && /sign-in could not be verified/.test(e.message));
});
