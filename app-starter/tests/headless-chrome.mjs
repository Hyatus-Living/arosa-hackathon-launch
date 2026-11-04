// Headless Chromium over the DevTools protocol and the plan page fixture server, shared by the
// rendered layout tests. chrome is undefined when no Chrome or Chromium binary is installed.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';

const cached = (dir) => (existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse().flatMap((d) => [join(dir, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), join(dir, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'), join(dir, d, 'chrome-linux/chrome')]) : []);
export const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ...cached(join(homedir(), 'Library/Caches/ms-playwright')), ...cached(join(homedir(), '.cache/ms-playwright'))].filter(Boolean).find(existsSync);
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); });
export const waitFor = async (check, what, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

export async function startFixture(t) {
  const port = await freePort();
  const child = spawn(process.execPath, ['tests/plan-page-fixture/server.mjs'], {cwd: new URL('..', import.meta.url), env: {...process.env, PORT: String(port)}, stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (code) => reject(new Error(`fixture exited with code ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

// One headless page driven over the DevTools protocol.
export async function startBrowser(t) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'acres-width-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {stdio: 'ignore'});
  // Chromium's helper processes can still be writing the profile just after the kill, so removal retries.
  t.after(() => { child.kill('SIGKILL'); rmSync(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); });
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'), 'Chromium');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  t.after(() => ws.close());
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({data}) => { const msg = JSON.parse(data); pending.get(msg.id)?.(msg); pending.delete(msg.id); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async (expression) => {
    const {result, exceptionDetails} = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  return {send, evaluate};
}
