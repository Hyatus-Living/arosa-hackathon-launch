// Headless smoke test of the built concept viewer: mounts a fixture concept with neighbours and
// places in Chromium and checks that the plan, the 3D canvas, the metrics and the places render.
// Run after `npm run build`. Needs a Chrome or Chromium binary (CHROME_BIN, or a common path).
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, writeFileSync, cpSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {createConceptTools} from '../../acres-research/concepts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(Boolean);
const chrome = candidates.find(existsSync);
if (!chrome) {
  if (process.env.CI) { console.error('No Chrome binary found for the viewer smoke test.'); process.exit(1); }
  console.log('Skipping the viewer smoke test: no Chrome binary found.'); process.exit(0);
}
if (!existsSync(join(root, 'public/genui/concept-view.js'))) { console.error('Build the frontend first: npm run build.'); process.exit(1); }

const LAT = 40.708, LON = -74.0107, k = 111320, kx = k * Math.cos((LAT * Math.PI) / 180);
const box = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2], [x1, z1]].map(([x, z]) => [LON + x / kx, LAT - z / k]);
const row = (bin, bbl, ring, height) => ({bin, base_bbl: bbl, height_roof: String(height), ground_elevation: '20', the_geom: {type: 'MultiPolygon', coordinates: [[ring]]}});
const rows = [row('1', '1000470001', box(-10, -15, 10, 15), 85), row('2', '1000470002', box(10, -15, 30, 15), 40), row('3', '1000470003', box(-30, -15, -10, 15), 120), row('5', '1000470005', box(-20, -70, 20, -40), 300)];
const tools = createConceptTools({getProperty: () => ({bbl: '1000470001', latitude: String(LAT), longitude: String(LON), numfloors: '8'}), request: async () => rows, streetView: async () => ({panoId: 'smokepano1', heading: 170, distanceMeters: 22, date: '2024-06'})});
const lot = [[0, 0], [66, 0], [66, 98], [0, 98]];
const smokeFirst = await tools.handlers.acres_model_concept({name: 'Smoke tower', lot, levels: [{use: 'retail', footprint: lot, height: 18}, {use: 'office', footprint: lot, height: 13, count: 5}, {use: 'residential', footprint: [[10, 10], [56, 10], [56, 88], [10, 88]], height: 11, count: 14}], envelope: {levels: [{footprint: lot, height: 18}, {footprint: lot, height: 13, count: 5}, {footprint: [[10, 10], [56, 10], [56, 88], [10, 88]], height: 11, count: 14}]}});
await tools.handlers.acres_model_concept({name: 'Smoke tower', lot, parentConceptId: smokeFirst.conceptId, revisionNote: 'smoke revision', levels: [{use: 'retail', footprint: lot, height: 18}, {use: 'office', footprint: lot, height: 13, count: 5}, {use: 'residential', footprint: [[10, 10], [56, 10], [56, 88], [10, 88]], height: 11, count: 14}], envelope: {levels: [{footprint: lot, height: 18}, {footprint: lot, height: 13, count: 5}, {footprint: [[10, 10], [56, 10], [56, 88], [10, 88]], height: 11, count: 14}]}});
const places = [{name: 'Smoke St station', group: 'transit', distanceMeters: 95, direction: 'NE', latitude: LAT + 0.0006, longitude: LON + 0.0007}];

const dir = mkdtempSync(join(tmpdir(), 'acres-smoke-'));
cpSync(join(root, 'public/genui'), join(dir, 'genui'), {recursive: true});
cpSync(join(root, 'public/styles.css'), join(dir, 'styles.css'));
writeFileSync(join(dir, 'concept.json'), JSON.stringify({concept: tools.concepts[1], places}));
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head>
<body><div id="concept-body" style="width:900px"></div><script type="module">
const {concept, places} = await (await fetch('concept.json')).json();
await import('./genui/concept-view.js');
window.acresConceptView.render(document.getElementById('concept-body'), concept, {places, threadId: 'smoke-thread'});
window.acresConceptView.buildGlb(concept).then(b => { document.body.dataset.glbSize = b.size; }).catch(() => {});
setTimeout(() => { for (const b of document.querySelectorAll('.concept-toolbar button')) if (b.textContent === new URLSearchParams(location.search).get('view')) b.click(); }, 1500);
</script></body></html>`);
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'};
const server = http.createServer((req, res) => {
  const file = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type': types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
// Chromium runs asynchronously so this process keeps serving the page to it meanwhile.
function dom(view) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1000,900', '--virtual-time-budget=10000', '--dump-dom', `${base}?view=${view}`], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Chromium timed out for ${view}`)); }, 120000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Chromium failed for ${view}: ${err.slice(-400)}`));
      if (process.env.SMOKE_DUMP) writeFileSync(`${process.env.SMOKE_DUMP}-${view}.html`, out);
      resolve(out);
    });
  });
}
const failures = [];
const expect = (ok, message) => { if (!ok) failures.push(message); };
try {
  const plan = await dom('Plan');
  expect(plan.includes('class="concept-plan"'), 'the plan SVG did not render');
  expect(plan.includes('>STREET<'), 'the plan has no street label');
  expect(/<path[^>]*fill="#d6d8d0"/.test(plan), 'the plan has no neighbour footprints');
  expect(plan.includes('Smoke St station'), 'the plan has no place marker');
  expect(plan.includes('<canvas'), 'the 3D canvas is missing');
  expect(plan.includes('Existing building'), 'the existing building toggle is missing');
  expect(!plan.includes('>Photo<'), 'the photo toggle must stay hidden without a tiles key');
  expect(plan.includes('89,040 sq ft'), 'the gross floor area is wrong or missing');
  expect(plan.includes('>Envelope<'), 'the envelope toggle is missing');
  expect(plan.includes('Every modeled storey sits within'), 'the compliance badge is missing');
  expect(plan.includes('stroke="#a8761d"'), 'the plan has no envelope outline');
  expect(plan.includes('>PNG<') && plan.includes('>GLB<') && plan.includes('>Copy link<'), 'the export buttons are missing');
  expect(/data-glb-size="\d{4,}"/.test(plan), 'the GLB export did not produce a file');
  expect(plan.includes('v2 of Smoke tower'), 'the revision lineage is missing from the metrics');
  const street = await dom('Street');
  expect(street.includes('/api/street-view?pano=smokepano1&amp;heading=170') || street.includes('/api/street-view?pano=smokepano1&heading=170'), 'the street view photo is missing');
  expect(street.includes('captured 2024-06'), 'the street view caption is missing');
} finally {
  server.close();
  rmSync(dir, {recursive: true, force: true});
}
if (failures.length) { console.error('Viewer smoke test failed:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('Viewer smoke test passed: plan, 3D canvas, neighbours, places and street photo render.');
