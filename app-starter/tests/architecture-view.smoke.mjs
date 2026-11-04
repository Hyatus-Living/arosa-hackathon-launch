// Headless smoke test of the built architecture viewer with the sample apartment fixture: the
// plan renders and selects rooms, the dollhouse loads the GLB, Walk enters from outside into the
// living room, and the plan stays usable when the GLB or WebGL is unavailable.
// Run after `npm run build`. Needs a Chrome or Chromium binary (CHROME_BIN, or a common path).
// `node tests/architecture-view.smoke.mjs --serve` only serves the fixture page for a browser.
import {spawn} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serveOnly = process.argv.includes('--serve');
if (!existsSync(join(root, 'public/genui/architecture-view.js'))) { console.error('Build the frontend first: npm run build.'); process.exit(1); }
const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chrome = candidates.find(existsSync);
if (!chrome && !serveOnly) {
  if (process.env.CI) { console.error('No Chrome binary found for the viewer smoke test.'); process.exit(1); }
  console.log('Skipping the architecture viewer smoke test: no Chrome binary found.'); process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'acres-arch-smoke-'));
cpSync(join(root, 'public/genui'), join(dir, 'genui'), {recursive: true});
cpSync(join(root, 'public/styles.css'), join(dir, 'styles.css'));
cpSync(join(root, 'tests/fixtures/architecture'), join(dir, 'fixture'), {recursive: true});
// ?mode= opens a view, ?glb=missing points at an absent GLB, ?walk=seconds holds W in Walk mode,
// ?select= clicks a room on the plan, ?delay= sets how long to wait before opening ?mode.
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Architecture viewer fixture</title><link rel="stylesheet" href="styles.css"></head>
<body style="margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:var(--sans)"><div id="arch" style="width:min(960px,100%);margin:0 auto"></div><script type="module">
const q = new URLSearchParams(location.search);
const plan = await (await fetch('fixture/sample-plan.json')).json();
await import('./genui/architecture-view.js');
const container = document.getElementById('arch');
document.body.dataset.renderAt = String(Math.round(performance.now()));
window.acresArchitectureView.render(container, {plan, glbUrl: q.get('glb') === 'missing' ? 'fixture/missing.glb' : 'fixture/sample.glb', manifestUrl: 'fixture/sample-manifest.json',
  onSelect: s => { document.body.dataset.selected = s ? s.roomId || s.objectName : ''; }});
const button = label => [...document.querySelectorAll('.concept-toolbar button')].find(b => b.textContent === label);
const wait = ms => new Promise(r => setTimeout(r, ms));
// Let the GLB load (or fail) before acting, so each check sees a settled page.
for (let i = 0; i < 100 && !container.dataset.modelMs && !container.querySelector('.arch-notice'); i++) await wait(100);
if (q.get('select')) container.querySelector('[data-room="' + q.get('select') + '"]').dispatchEvent(new MouseEvent('click', {bubbles: true}));
const mode = q.get('mode');
if (mode) { await wait(Number(q.get('delay') ?? 300)); button(mode)?.click(); await wait(1500); }
if (q.get('walk')) {
  await wait(1500);
  window.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyW'}));
  await wait(Number(q.get('walk')) * 1000);
  window.dispatchEvent(new KeyboardEvent('keyup', {code: 'KeyW'}));
  await wait(300);
}
document.body.dataset.done = '1';
</script></body></html>`);
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'};
const server = http.createServer((req, res) => {
  const file = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type': types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(serveOnly ? Number(process.env.PORT || 4417) : 0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
if (serveOnly) { console.log(`Serving the architecture fixture at ${base}`); await new Promise(() => {}); }

// Chromium is driven over the DevTools protocol in real time (virtual time does not run WebGL
// frames reliably), until the page marks itself done; the result is the page's final markup.
async function dom(query, flags = []) {
  const profile = mkdtempSync(join(tmpdir(), 'acres-arch-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...flags, '--window-size=1000,900', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  try {
    const browser = await new Promise((resolve, reject) => {
      let err = '';
      child.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) resolve(new URL(m[1])); });
      child.on('close', () => reject(new Error(`Chromium exited for ${query}: ${err.slice(-400)}`)));
    });
    // Drive the initial tab: a tab opened beside it runs in the background, where frames pause.
    const target = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()).find(t => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); };
    const send = (method, params) => new Promise(resolve => { pending.set(++id, resolve); ws.send(JSON.stringify({id, method, params})); });
    const evaluate = async expression => (await send('Runtime.evaluate', {expression, returnByValue: true})).result?.result?.value;
    await send('Page.navigate', {url: `${base}?${query}`});
    const deadline = Date.now() + 60000;
    let html = '';
    while (!html && Date.now() < deadline) {
      html = await evaluate('document.body?.dataset.done ? document.documentElement.outerHTML : ""');
      if (!html) await new Promise(resolve => setTimeout(resolve, 250));
    }
    ws.close();
    if (!html) throw new Error(`The fixture page did not finish for ${query}`);
    if (process.env.SMOKE_DUMP) writeFileSync(`${process.env.SMOKE_DUMP}-${query.replace(/\W+/g, '_') || 'plan'}.html`, html);
    return html;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(profile, {recursive: true, force: true});
  }
}
const failures = [];
const expect = (ok, message) => { if (!ok) failures.push(message); };
try {
  const plan = await dom('select=kitchen');
  expect(plan.includes('class="concept-plan arch-plan"'), 'the plan SVG did not render');
  expect((plan.match(/class="arch-room"/g) || []).length === 5, 'the plan does not show five rooms');
  for (const name of ['Living / dining', 'Kitchen', 'Bedroom A', 'Bedroom B', 'Bathroom']) expect(plan.includes(`>${name}<`), `the plan has no ${name} label`);
  expect((plan.match(/data-opening="/g) || []).length === 9, 'the plan does not draw nine openings');
  expect(/data-plan-ms="\d+"/.test(plan), 'the plan did not report its paint time');
  expect(plan.includes('data-selected="kitchen"'), 'clicking a room did not report the selection');
  expect(plan.includes('<strong>Kitchen</strong>'), 'the selected room is not described');
  expect(/data-model-ms="\d+"/.test(plan), 'the GLB did not load in the background');

  const dollhouse = await dom('mode=Dollhouse');
  expect(dollhouse.includes('data-mode="dollhouse"'), 'the dollhouse mode did not open');
  expect(dollhouse.includes('<canvas'), 'the dollhouse canvas is missing');
  expect(/data-model-ready-ms="\d+"/.test(dollhouse), 'the dollhouse never drew the model');
  expect(dollhouse.includes('>Go to…<') && dollhouse.includes('>Entrance<'), 'the camera stops are missing');

  const walk = await dom('mode=Walk&walk=3');
  expect(walk.includes('data-mode="walk"'), 'walk mode did not open');
  expect(walk.includes('data-walker-room="living"'), 'walking forward from the entrance did not reach the living room');
  expect(/data-walk-fps="[\d.]+"/.test(walk), 'walk mode did not report a frame rate');

  const missing = await dom('glb=missing&mode=Walk');
  expect(missing.includes('The 3D model could not be loaded. The plan is still available.'), 'a missing GLB is not explained');
  expect(missing.includes('class="concept-plan arch-plan"'), 'the plan is not shown when the GLB is missing');
  expect(missing.includes('data-mode="plan"'), 'a missing GLB still allowed a 3D mode');

  const noGl = await dom('mode=Dollhouse&gl=off', ['--disable-3d-apis']);
  expect(noGl.includes('This browser cannot show the 3D model. The plan is still available.'), 'missing WebGL is not explained');
  expect(noGl.includes('class="concept-plan arch-plan"'), 'the plan is not shown without WebGL');
} finally {
  server.close();
  rmSync(dir, {recursive: true, force: true});
}
if (failures.length) { console.error(`Architecture viewer smoke test failed:\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('Architecture viewer smoke test passed: plan, selection, dollhouse, walk and both fallbacks.');
