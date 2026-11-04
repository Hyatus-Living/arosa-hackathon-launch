import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The public site's demo windows load the app's own modules from site/public/app, copied there by
// site/build.mjs. A top-level .mjs module the copy step skips 404s in the browser and leaves the
// demo blank (nyc-address.mjs, imported by listings.js), so every app .mjs must be copied verbatim.
test('every top-level app .mjs module is copied into the site demo assets', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  // site/public/app is generated and gitignored; regenerate it the way a deploy does.
  execFileSync(process.execPath, [path.join(root, 'site/build.mjs')], { stdio: 'pipe' });
  const from = path.join(root, 'app-starter/public');
  const to = path.join(root, 'site/public/app');
  const modules = fs.readdirSync(from).filter((name) => name.endsWith('.mjs'));
  assert.ok(modules.length > 0, 'expected at least one app .mjs module');
  for (const name of modules) {
    const copied = path.join(to, name);
    assert.ok(fs.existsSync(copied), `${name} is missing from site/public/app; run node site/build.mjs`);
    assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(path.join(from, name)), `${name} in site/public/app is stale; run node site/build.mjs`);
  }
});
