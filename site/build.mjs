// Copies the app's own front-end modules and styles into public/app, so the product embeds on this
// page render with the same code and CSS as build.witharosa.ai. Run it before each Firebase deploy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, '../app-starter/public');
const to = path.join(here, 'public/app');

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(path.join(to, 'vendor'), { recursive: true });
for (const name of fs.readdirSync(from)) if (/\.(js|mjs|css)$/.test(name)) fs.copyFileSync(path.join(from, name), path.join(to, name));
for (const name of ['marked.esm.js', 'purify.es.mjs']) fs.copyFileSync(path.join(from, 'vendor', name), path.join(to, 'vendor', name));
const symbols = fs.readFileSync(path.join(from, 'index.html'), 'utf8').match(/<svg class="symbols"[\s\S]*?<\/svg>/)[0];
fs.writeFileSync(path.join(to, 'symbols.svg'), symbols);
