// Production bundle of the app shell, run in the image build after `npm run build`. The page's module
// scripts and stylesheets become a few content-hashed files under public/assets, which browsers keep
// for good, and public/index.html is rewritten in place to load them. Development serves the sources.
import {build} from 'esbuild';
import {readFileSync, writeFileSync} from 'node:fs';
import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const pagePath = `${publicDir}index.html`;
const scriptTag = /^ *<script type="module" src="\/([^"]+)"><\/script>\n/gm;
const styleTag = /^ *<link rel="stylesheet" href="\/([^"]+\.css)" \/>\n/gm;
let page = readFileSync(pagePath, 'utf8');
const scripts = [...page.matchAll(scriptTag)].map(m => m[1]);
const styles = [...page.matchAll(styleTag)].map(m => m[1]);
if (!scripts.length || !styles.length) throw new Error('index.html has no module scripts or stylesheets to bundle.');

const shared = {bundle: true, minify: true, outdir: `${publicDir}assets`, metafile: true, logLevel: 'warning'};
// The generated views and MapLibre load on demand from their own builds, so they stay outside the bundle.
const js = await build({...shared, entryPoints: scripts.map(s => `${publicDir}${s}`), format: 'esm', splitting: true,
  target: 'es2022', entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]', external: ['/genui/*', '/vendor/maplibre/*']});
const css = await build({...shared, stdin: {contents: styles.map(s => `@import "./${s}";`).join('\n'), resolveDir: publicDir, loader: 'css'},
  entryNames: 'app-[hash]'});

const url = out => `/assets/${basename(out)}`;
const outputs = Object.entries(js.metafile.outputs);
const entryOutput = script => outputs.find(([, o]) => o.entryPoint && resolve(o.entryPoint) === `${publicDir}${script}`)[0];
const entries = scripts.map(entryOutput);
const preloads = [...new Set(entries.flatMap(e => js.metafile.outputs[e].imports.filter(i => i.kind === 'import-statement' && !i.external).map(i => i.path)))];
const stylesheet = Object.keys(css.metafile.outputs).find(o => o.endsWith('.css'));

const indent = '    ';
page = page.replace(styleTag, (tag, href) => (href === styles[0] ? `${indent}<link rel="stylesheet" href="${url(stylesheet)}" />\n` : ''));
page = page.replace(scriptTag, (tag, src) => (src === scripts[0]
  ? [...preloads.map(p => `${indent}<link rel="modulepreload" href="${url(p)}" />\n`), ...entries.map(e => `${indent}<script type="module" src="${url(e)}"></script>\n`)].join('')
  : ''));
writeFileSync(pagePath, page);
console.log(`Bundled ${scripts.length} scripts and ${styles.length} stylesheets into ${entries.length + preloads.length + 1} files.`);
