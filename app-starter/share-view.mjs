// The page an option link opens (GET /api/public/options/:token): one of a site's options as its sender saw it,
// for an architect or contractor without an Arosa account. It is plain HTML with its own styles, since
// the app's scripts and stylesheets sit behind sign-in; files is the base its images and downloads use.
import {fmtMoney, fmtNumber, finite} from './public/core-model.js';

const HELP = 'https://witharosa.ai/help';
const BETA = 'https://witharosa.ai/beta';
const VIEW_LABELS = {street: 'Street', aerial: 'Aerial'};

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const sf = n => `${fmtNumber(n)} SF`;
const dollars = n => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const share = n => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
const day = at => new Date(at).toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'});
const help = (slug, subject) => `<a class="help" href="${HELP}/${slug}" target="_blank" rel="noopener noreferrer" aria-label="How is ${subject} calculated? Opens in a new tab">How is this calculated?</a>`;
// Budget lines are written to their owner ("at your good-deal return"); here they speak of the sender.
const theirs = (text, name) => String(text).replace(/\byour\b/g, `${name}'s`).replace(/\bYour\b/g, `${name}'s`);

// The modeled shape, drawn from above at an angle: each storey's faces toward the viewer and its top.
export function massingSvg({lot, levels}, width = 520) {
  const floors = [];
  let z = 0;
  for (const level of levels) for (let i = 0; i < level.count; i++) { floors.push({footprint: level.footprint, z, h: level.height}); z += level.height; }
  const iso = ([x, y], h) => [(x + y) * 0.866, (x - y) * 0.5 - h];
  const ground = lot?.length > 2 ? lot : floors[0].footprint;
  const pts = [...ground.map(p => iso(p, 0)), ...floors.flatMap(f => f.footprint.flatMap(p => [iso(p, f.z), iso(p, f.z + f.h)]))];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = (width - 48) / Math.max(1, maxX - minX, (maxY - minY) * 1.05);
  const P = (p, h) => { const [x, y] = iso(p, h); return [(x - minX) * k + 24, (y - minY) * k + 24]; };
  const path = points => 'M' + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z';
  const area = poly => poly.reduce((s, [x, y], i) => { const [nx, ny] = poly[(i + 1) % poly.length]; return s + x * ny - nx * y; }, 0);
  const shapes = [`<path class="m-lot" d="${path(ground.map(p => P(p, 0)))}"/>`];
  for (const floor of floors) {
    const poly = floor.footprint, ccw = area(poly) > 0;
    const faces = poly.map((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const [nx, ny] = ccw ? [q[1] - p[1], p[0] - q[0]] : [p[1] - q[1], q[0] - p[0]];
      return {p, q, nx, ny, depth: (p[0] + q[0]) / 2 - (p[1] + q[1]) / 2};
    }).filter(f => f.nx - f.ny > 0).sort((a, b) => a.depth - b.depth);
    for (const f of faces) shapes.push(`<path class="${Math.abs(f.nx) >= Math.abs(f.ny) ? 'm-side' : 'm-front'}" d="${path([P(f.p, floor.z), P(f.q, floor.z), P(f.q, floor.z + floor.h), P(f.p, floor.z + floor.h)])}"/>`);
    shapes.push(`<path class="m-top" d="${path(poly.map(p => P(p, floor.z + floor.h)))}"/>`);
  }
  return `<svg class="massing" viewBox="0 0 ${width} ${((maxY - minY) * k + 48).toFixed(0)}" role="img" aria-label="Building shape, ${floors.length} storeys">${shapes.join('')}</svg>`;
}

function figures(scheme) {
  const r = scheme.returns, p = scheme.program;
  const row = (label, value, note = '') => `<div><dt>${esc(label)}</dt><dd class="value">${esc(value)}</dd>${note ? `<dd class="note">${esc(note)}</dd>` : ''}</div>`;
  return `<dl class="figures">
    ${row('Land value', fmtMoney(r.landValue), r.landValue > 0 ? `$${fmtNumber(r.landValuePerBsf)} per buildable SF` : 'Pays nothing for the land at target returns')}
    ${p.exit === 'rental' ? row('Yield on cost', finite(r.yieldOnCost) ? `${r.yieldOnCost.toFixed(2)}%` : '–') : row('Condo margin', finite(r.condoMargin) ? `${r.condoMargin.toFixed(1)}%` : '–')}
    ${row('Profit', fmtMoney(r.profit), `on ${fmtMoney(r.totalCost)} total cost`)}
    ${row('Floor area', sf(p.zfa), p.affordableZfa > 0 ? `${sf(p.affordableZfa)} affordable` : `${sf(p.grossSqft)} gross`)}
    ${row('Units', fmtNumber(p.units), `over ${p.storeys} storeys`)}
  </dl>`;
}

function budget(b, name) {
  const groups = b.groups.filter(g => g.amount);
  const body = groups.map(g => `<tbody>
      <tr class="group"><th scope="row">${esc(g.label)}</th><td>${dollars(g.amount)}</td><td>$${fmtNumber(g.perGsf)}</td><td>${share(g.pct)}</td></tr>
      ${b.lines.filter(l => l.group === g.key).map(l => `<tr><th scope="row">${esc(l.label)}<span class="basis">${esc(theirs(l.basis, name))}</span></th><td>${dollars(l.amount)}</td><td>$${fmtNumber(l.perGsf)}</td><td></td></tr>`).join('')}
    </tbody>`).join('');
  const hard = b.basis.hardCostPerGrossSqft ? `Hard cost at $${fmtNumber(b.basis.hardCostPerGrossSqft)} a gross SF over ${fmtNumber(b.grossSqft)} gross SF` : `${fmtNumber(b.grossSqft)} gross SF`;
  return `<table class="budget">
      <caption class="sr-only">Development budget by line</caption>
      <thead><tr><th scope="col"></th><th scope="col">Cost</th><th scope="col">Per gross SF</th><th scope="col">Share</th></tr></thead>
      ${body}
      <tfoot><tr><th scope="row">Total cost</th><td>${dollars(b.total)}</td><td>$${fmtNumber(b.total / b.grossSqft)}</td><td>100%</td></tr></tfoot>
    </table>
    <p class="fine">${esc(`${hard}, split by ${b.basis.splits === 'custom' ? `${name}'s budget shares` : "Arosa's default budget shares"}.`)}</p>`;
}

function renders(views, files, label) {
  if (!views.length) return '';
  return `<section class="block" aria-labelledby="render-title">
    <h2 id="render-title">Rendering</h2>
    <div class="renders">${views.map(v => `<figure>
      <img src="${files}/${esc(v.artifactId)}" width="1280" height="800" alt="${esc(VIEW_LABELS[v.view])} view of the ${esc(label)} option among its neighbours" decoding="async">
      <figcaption><span>${esc(VIEW_LABELS[v.view])} view</span><a class="download" href="${files}/${esc(v.artifactId)}" download="rendering-${esc(v.view)}.png">Download</a></figcaption>
    </figure>`).join('')}</div>
    <p class="fine">Simplified materials in afternoon sun. Neighboring buildings are shown in gray.</p>
  </section>`;
}

function drawings(option, files) {
  const {massing, plan, scheme} = option;
  if (!massing && !plan) return '';
  return `<section class="block drawings" aria-label="Drawings">
    ${massing ? `<div><h2>Building shape</h2>${massingSvg(massing)}</div>` : ''}
    ${plan ? `<div><h2>Typical floor plan</h2>
      <img class="plan" src="${files}/${esc(plan.artifactId)}" alt="Typical floor plan of the ${esc(scheme.label)} option" decoding="async">
      <a class="download" href="${files}/${esc(plan.artifactId)}" download="floor-plan-${esc(scheme.id)}-r${esc(plan.revision)}.svg">Download the floor plan (SVG)</a></div>` : ''}
  </section>`;
}

// The architect's package of the option's plan revision, by artifact kind, in the order a reader wants them.
const PACKAGE = [
  ['package', 'Everything in one file (ZIP)', 'The drawing set, zoning analysis, building model, CAD drawings and schedules.', 'zip'],
  ['drawings-pdf', 'Drawing set (PDF)', 'Cover sheet with the zoning table, pre-filing self-check, site plan, a dimensioned plan of each floor, elevations, a section and schedules.', 'pdf'],
  ['zd1-pdf', 'Zoning analysis (PDF)', 'Zoning diagram and calculations, each figure with its Zoning Resolution section.', 'pdf'],
  ['ifc', 'Building model (IFC)', 'IFC4 model with named storeys, walls, doors, windows, stairs, the elevator and each unit, carrying the zoning and area figures.', 'ifc'],
  ['dxf', 'CAD drawings (DXF)', 'The site plan and each floor plan in feet and inches, on standard layers.', 'dxf'],
  ['schedules', 'Schedules (Excel)', 'Areas by storey, units, doors and windows.', 'xlsx'],
];

function packageFiles(option, files) {
  const {plan, scheme} = option;
  const listed = PACKAGE.filter(([kind]) => plan?.files?.[kind]);
  if (!listed.length) return '';
  return `<section class="block" aria-labelledby="files-title">
    <h2 id="files-title">Files for the architect</h2>
    <ul class="files">${listed.map(([kind, label, what, ext]) => `
      <li><span><strong>${esc(label)}</strong><span class="what">${esc(what)}</span></span>
        <a class="download" href="${files}/${esc(plan.files[kind])}" download="${esc(`${kind.replace('-pdf', '')}-${scheme.id}-r${plan.revision}.${ext}`)}">Download</a></li>`).join('')}
    </ul>
    <p class="fine">Lot lines come from the city's tax map, not a survey. This is a pre-filing package: a DOB filing needs drawings sealed by a registered architect or engineer.</p>
  </section>`;
}

// What the land figures are counted against, in the sender's terms.
function landBasis(basis, name) {
  if (basis?.askFrom === 'assumptions') return `Land value at ${name}'s target returns; yield, margin and profit at a land price of ${fmtMoney(basis.ask)}.`;
  if (basis?.askFrom === 'listing') return `Land value at ${name}'s target returns; yield, margin and profit at the ${fmtMoney(basis.ask)} asking price.`;
  return `Land value at ${name}'s target returns; with no price set, the returns assume the land is bought at what this option pays.`;
}

export function optionPage(option, {files}) {
  const {scheme, site, sender} = option;
  const name = sender.name;
  const title = `${scheme.label} option for ${site.address}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231a1a1a'/%3E%3Cpath d='M8 24h4v-5h8v5h4V14h-4v-4h-4V6h-4v4H8z' fill='%23fafafa'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head>
<body>
<header class="bar">
  <a class="brand" href="https://witharosa.ai/" aria-label="Arosa"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 24h4v-5h8v5h4V14h-4v-4h-4V6h-4v4H8z"/></svg>Arosa</a>
  <a class="bar-link" href="${BETA}">Apply for the beta</a>
</header>
<main>
  <section class="intro">
    <h1>${esc(site.address)}</h1>
    <p class="lede"><strong>${esc(scheme.label)}.</strong> ${esc(scheme.summary)}.</p>
    <p class="from">Sent by ${esc(name)} on ${esc(day(option.at))}</p>
    <p class="caveat">Every figure here is at ${esc(name)}'s costs and is a screening estimate from public records, not a quote, an appraisal or a design. ${help('three-options', 'the three ways to build it')}</p>
  </section>
  ${renders(option.renders, files, scheme.label)}
  <section class="block" aria-labelledby="figures-title">
    <h2 id="figures-title">What it pays</h2>
    ${figures(scheme)}
    <p class="fine">${esc(landBasis(option.basis, name))} ${help('land-value', 'land value')}</p>
  </section>
  ${drawings(option, files)}
  ${packageFiles(option, files)}
  ${scheme.budget ? `<section class="block" aria-labelledby="budget-title">
    <div class="block-head"><h2 id="budget-title">Development budget</h2>${help('budget', 'the development budget')}</div>
    ${budget(scheme.budget, name)}
  </section>` : ''}
</main>
<footer class="foot">
  <p><strong>Know what any New York lot could become.</strong> Arosa reads the zoning, prices three ways to build a site and drafts their floor plans, at your own costs.</p>
  <a class="cta" href="${BETA}">Apply for the beta</a>
</footer>
</body>
</html>`;
}

// A page with one message and the way back to Arosa: a missing link, or one that cannot open right now.
export function messagePage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet"><style>${STYLES}</style></head>
<body><main class="gone"><h1>${esc(title)}</h1><p>${esc(text)}</p><a class="cta" href="https://witharosa.ai/">Go to Arosa</a></main></body></html>`;
}

const STYLES = `
:root{--bg:oklch(0.99 0 0);--surface:oklch(0.965 0 0);--ink:oklch(0.2 0 0);--muted:oklch(0.45 0 0);--line:oklch(0.89 0 0);--mass-top:oklch(0.97 0 0);--mass-side:oklch(0.8 0 0);--mass-front:oklch(0.88 0 0);--mass-edge:oklch(0.35 0 0);--lot:oklch(0.93 0 0);--paper:oklch(1 0 0);--warn:oklch(0.55 0.13 60);--neg:oklch(0.52 0.17 25);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.16 0 0);--surface:oklch(0.2 0 0);--ink:oklch(0.95 0 0);--muted:oklch(0.7 0 0);--line:oklch(0.3 0 0);--mass-top:oklch(0.42 0 0);--mass-side:oklch(0.26 0 0);--mass-front:oklch(0.33 0 0);--mass-edge:oklch(0.8 0 0);--lot:oklch(0.23 0 0);--warn:oklch(0.78 0.12 70);--neg:oklch(0.72 0.15 25)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Geist,ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums}
::selection{background:var(--ink);color:var(--bg)}
a{color:inherit;text-underline-offset:3px;text-decoration-thickness:1px}
a:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:4px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:1080px;margin:0 auto;padding:20px 24px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-0.01em;text-decoration:none}
.brand svg{width:22px;height:22px;fill:currentColor}
.bar-link{font-size:14px;color:var(--muted)}
.bar-link:hover{color:var(--ink)}
main{max-width:1080px;margin:0 auto;padding:16px 24px 48px}
.intro{max-width:46rem;padding:32px 0 8px}
h1{font-size:clamp(2rem,4.6vw,3.25rem);line-height:1.05;letter-spacing:-0.03em;font-weight:600;margin:0 0 20px;text-wrap:balance}
.lede{font-size:1.25rem;line-height:1.45;margin:0 0 12px;text-wrap:pretty}
.from{color:var(--muted);margin:0 0 20px;font-size:15px}
.caveat{margin:0;padding:14px 16px;background:var(--surface);border-radius:12px;font-size:15px;color:var(--ink)}
.help{font-size:14px;color:var(--muted);white-space:nowrap}
.help:hover{color:var(--ink)}
.block{margin-top:56px}
.block-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
h2{font-size:1.25rem;letter-spacing:-0.015em;font-weight:600;margin:0 0 16px}
.renders{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:20px}
figure{margin:0}
figure img{display:block;width:100%;height:auto;border-radius:12px;background:var(--surface)}
figcaption{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:14px;color:var(--muted)}
.download{font-size:14px;font-weight:500;color:var(--ink)}
.fine{color:var(--muted);font-size:14px;margin:14px 0 0;max-width:46rem}
.figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0;margin:0;border-top:1px solid var(--line)}
.figures div{padding:16px 16px 18px 0;border-bottom:1px solid var(--line)}
.figures dt{font-size:14px;color:var(--muted)}
.figures dd{margin:0}
.figures .value{font-size:1.6rem;font-weight:600;letter-spacing:-0.02em;margin-top:4px}
.figures .note{font-size:14px;color:var(--muted)}
.drawings{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:32px}
.massing{display:block;width:100%;height:auto;max-height:420px}
.massing path{stroke:var(--mass-edge);stroke-width:.6;stroke-linejoin:round}
.massing .m-lot{fill:var(--lot);stroke-dasharray:3 3}
.massing .m-top{fill:var(--mass-top)}
.massing .m-side{fill:var(--mass-side)}
.massing .m-front{fill:var(--mass-front)}
.files{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.files li{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}
.files strong{font-weight:500}
.files .what{display:block;color:var(--muted);font-size:14px;max-width:40rem}
.files .download{white-space:nowrap}
.plan{display:block;width:100%;height:auto;max-height:420px;object-fit:contain;background:var(--paper);border-radius:12px;padding:12px;margin-bottom:12px}
.budget{width:100%;border-collapse:collapse;font-size:15px}
.budget th,.budget td{padding:9px 0;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}
.budget th{text-align:left;font-weight:400;padding-right:16px}
.budget td{padding-left:16px;white-space:nowrap}
.budget thead th{font-size:13px;color:var(--muted);text-align:right}
.budget thead th:first-child{text-align:left}
.budget .group th,.budget .group td{font-weight:600;padding-top:18px}
.budget tbody tr:not(.group) th{padding-left:14px}
.budget .basis{display:block;font-size:13px;color:var(--muted)}
.budget tfoot th,.budget tfoot td{font-weight:600;border-bottom:0;border-top:2px solid var(--ink);padding-top:12px}
.foot{max-width:1080px;margin:24px auto 0;padding:32px 24px 56px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap}
.foot p{margin:0;max-width:40rem;color:var(--muted)}
.foot strong{color:var(--ink);font-weight:600}
.cta{display:inline-block;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:500;padding:11px 18px;border-radius:10px}
.cta:hover{opacity:.88}
.gone{max-width:36rem;padding:20vh 24px 0}
.gone p{color:var(--muted);margin:0 0 24px}
@media (max-width:640px){
  .bar,main,.foot{padding-left:16px;padding-right:16px}
  .intro{padding-top:16px}
  .block{margin-top:44px}
  .budget{font-size:14px}
  .budget thead th:nth-child(4),.budget td:nth-child(4){display:none}
}
`;
