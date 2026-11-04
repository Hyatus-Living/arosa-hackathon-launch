// Server-side concept plan for the underwriting deck: the same drawing the browser Plan view
// shows (light sheet), rendered as a pure function of a stored concept so every deck carries the
// building's plan even when nobody has opened the interactive view. Geometry is the concept's lot
// and per-storey footprints in metres (x east, z into the lot, street at z = 0), with NYC footprint
// neighbours when the concept recorded them. Every coordinate is validated finite before use and
// text is escaped, so the result is safe to inline in deck HTML. Returns null when the concept
// carries no drawable geometry (legacy records): the deck then shows its metrics alone.

const FOOT = 0.3048;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = n => Math.round(Number(n) * 1000) / 1000;
const ring = value => Array.isArray(value) && value.length >= 3 && value.length <= 64 &&
  value.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? value.map(([x, z]) => [x, z]) : null;
const path = polygon => polygon.map(([x, z], i) => `${i ? 'L' : 'M'}${num(x)} ${num(z)}`).join(' ') + ' Z';
const centroid = polygon => [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];

export function conceptPlanSvg(concept) {
  if (!concept || typeof concept !== 'object') return null;
  const lot = ring(concept.lot);
  const levels = (Array.isArray(concept.levels) ? concept.levels : []).map(l => ring(l?.footprint)).filter(Boolean);
  if (!lot || !levels.length) return null;
  const envelopeFootprints = [...new Set((Array.isArray(concept.envelope?.levels) ? concept.envelope.levels : []).map(l => JSON.stringify(l?.footprint)))]
    .map(s => ring(JSON.parse(s))).filter(Boolean);
  const buildings = (Array.isArray(concept.context?.buildings) ? concept.context.buildings : [])
    .map(b => ({polygon: ring(b?.polygon), existing: Boolean(b?.existing)})).filter(b => b.polygon);
  const parcel = ring(concept.context?.parcel?.polygon);
  const points = [...lot, ...levels.flat(), ...envelopeFootprints.flat(), ...(parcel || [])];
  const xs = points.map(p => p[0]), zs = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const size = Math.max(maxX - minX, maxZ - minZ);
  if (!(size > 0)) return null;
  const pad = buildings.length ? Math.max(size * 0.9, 36) : Math.max(size * 0.25, 8);
  const view = {x: minX - pad, z: minZ - pad, w: maxX - minX + pad * 2, h: maxZ - minZ + pad * 2};
  const unit = view.w / 100, font = Math.max(unit * 2.6, 0.6), stroke = unit * 0.35;
  const distinct = [];
  levels.forEach((footprint, i) => {
    const key = JSON.stringify(footprint), last = distinct.at(-1);
    if (last && last.key === key) last.to = i + 1; else distinct.push({key, footprint, from: i + 1, to: i + 1});
  });
  const units = concept.units === 'm' ? 'm' : 'ft';
  const bar = units === 'm' ? (view.w > 150 ? 50 : 20) : (view.w > 150 ? 100 * FOOT : 50 * FOOT);
  const barLabel = units === 'm' ? `${bar} m` : `${Math.round(bar / FOOT)} ft`;
  const north = Array.isArray(concept.context?.north) && Number.isFinite(concept.context.north[0]) && Number.isFinite(concept.context.north[1]) ? concept.context.north : null;
  const northAngle = north ? (Math.atan2(north[0], -north[1]) * 180) / Math.PI : null;
  const P = {sheet: '#eef0e9', contextFill: '#d6d8d0', contextStroke: '#aeb2a8', lotFill: '#f7f8f3', lotStroke: '#3a3f36', parcel: '#1f4632', envelope: '#a8761d', storeyFill: '#8c6a4a', storeyStroke: '#2b2520', existing: '#2f4fb5', ink: '#1f1b17', street: '#5d6356'};
  const parts = [
    `<svg class="concept-plan-svg" viewBox="${num(view.x)} ${num(view.z)} ${num(view.w)} ${num(view.h)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Plan of ${esc(concept.name || 'massing concept')}">`,
    `<rect x="${num(view.x)}" y="${num(view.z)}" width="${num(view.w)}" height="${num(view.h)}" fill="${P.sheet}"/>`,
    ...buildings.filter(b => !b.existing).map(b => `<path d="${path(b.polygon)}" fill="${P.contextFill}" stroke="${P.contextStroke}" stroke-width="${num(stroke)}" stroke-linejoin="round"/>`),
    `<path d="${path(lot)}" fill="${P.lotFill}" stroke="${P.lotStroke}" stroke-width="${num(stroke * 1.2)}" stroke-dasharray="${num(unit * 1.6)} ${num(unit)}"/>`,
    ...(parcel ? [`<path d="${path(parcel)}" fill="none" stroke="${P.parcel}" stroke-width="${num(stroke * 1.4)}" stroke-dasharray="${num(unit * 2.2)} ${num(unit * 0.7)} ${num(unit * 0.5)} ${num(unit * 0.7)}"/>`] : []),
    ...envelopeFootprints.map(f => `<path d="${path(f)}" fill="none" stroke="${P.envelope}" stroke-width="${num(stroke * 1.2)}" stroke-dasharray="${num(unit * 1.2)} ${num(unit * 0.8)}"/>`),
    ...distinct.map((d, i) => `<path d="${path(d.footprint)}" fill="${P.storeyFill}" fill-opacity="${Math.min(0.18 + i * 0.16, 0.8)}" stroke="${P.storeyStroke}" stroke-width="${num(stroke)}" stroke-linejoin="round"/>`),
    ...buildings.filter(b => b.existing).map(b => `<path d="${path(b.polygon)}" fill="none" stroke="${P.existing}" stroke-width="${num(stroke * 1.3)}" stroke-dasharray="${num(unit * 0.9)} ${num(unit * 0.7)}"/>`),
  ];
  distinct.forEach((d, i) => {
    const [cx, cz] = centroid(d.footprint);
    const width = Math.max(...d.footprint.map(p => p[0])) - Math.min(...d.footprint.map(p => p[0]));
    const depth = Math.max(...d.footprint.map(p => p[1])) - Math.min(...d.footprint.map(p => p[1]));
    if (font * 3.2 > width || font * 1.3 * distinct.length > depth) return;
    parts.push(`<text x="${num(cx)}" y="${num(cz + font * 0.35 + (i - (distinct.length - 1) / 2) * font * 1.3)}" font-size="${num(font)}" text-anchor="middle" fill="${P.ink}" font-family="system-ui, sans-serif">${d.from === d.to ? `L${d.from}` : `L${d.from}–${d.to}`}</text>`);
  });
  parts.push(`<text x="${num((minX + maxX) / 2)}" y="${num(minZ - unit * 2.2)}" font-size="${num(font * 0.9)}" text-anchor="middle" fill="${P.street}" font-family="system-ui, sans-serif" letter-spacing="${num(unit * 0.3)}">STREET</text>`);
  parts.push(`<g transform="translate(${num(view.x + unit * 5)} ${num(view.z + view.h - unit * 5)})"><line x1="0" y1="0" x2="${num(bar)}" y2="0" stroke="${P.ink}" stroke-width="${num(stroke * 1.5)}"/><line x1="0" y1="${num(-unit)}" x2="0" y2="${num(unit)}" stroke="${P.ink}" stroke-width="${num(stroke * 1.5)}"/><line x1="${num(bar)}" y1="${num(-unit)}" x2="${num(bar)}" y2="${num(unit)}" stroke="${P.ink}" stroke-width="${num(stroke * 1.5)}"/><text x="${num(bar / 2)}" y="${num(-unit * 1.6)}" font-size="${num(font * 0.85)}" text-anchor="middle" fill="${P.ink}" font-family="system-ui, sans-serif">${barLabel}</text></g>`);
  if (northAngle !== null) {
    parts.push(`<g transform="translate(${num(view.x + view.w - unit * 7)} ${num(view.z + unit * 8)}) rotate(${num(northAngle)})"><path d="M0 ${num(-unit * 4.5)} L${num(unit * 2.2)} ${num(unit * 3)} L0 ${num(unit * 1.6)} L${num(-unit * 2.2)} ${num(unit * 3)} Z" fill="${P.ink}"/><text x="0" y="${num(-unit * 5.5)}" font-size="${num(font * 0.9)}" text-anchor="middle" fill="${P.ink}" font-family="system-ui, sans-serif">N</text></g>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}
