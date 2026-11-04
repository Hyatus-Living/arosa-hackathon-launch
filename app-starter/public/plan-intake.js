// Drawing intake for the architecture plan v1 document: upload checks, SVG sanitizing,
// vector primitive extraction, calibration, room detection, validation, edits and saving.
// Geometry is in metres with x east and y north; drawing coordinates are pixels with y down.

export const PLAN_SCHEMA = "acres.architecture.plan/1";
export const DEFAULTS = {
  thickness: 0.18,
  height: 2.8,
  door: { width: 0.9, height: 2.1, sill: 0 },
  window: { width: 1.2, height: 1.3, sill: 0.9 },
};
const RASTER_BYTES = 15 * 1024 * 1024;
// pascal-scene is an edited 3D scene (.pascal.json) returning from the hand-off: stored for Arosa to import.
export const LIMITS = { ifcBytes: 25 * 1024 * 1024, svgBytes: 2 * 1024 * 1024, pngBytes: RASTER_BYTES, jpegBytes: RASTER_BYTES, webpBytes: RASTER_BYTES, pdfBytes: 25 * 1024 * 1024, "pascal-sceneBytes": 10 * 1024 * 1024 };
export const CONTENT_TYPES = { ifc: "application/x-step", svg: "image/svg+xml", pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg", webp: "image/webp", "pascal-scene": "application/json" };
const KINDS = Object.fromEntries(Object.entries(CONTENT_TYPES).map(([kind, type]) => [type, kind]));
const EXTENSIONS = { ifc: "ifc", svg: "svg", pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp", json: "pascal-scene" };
const TOL = 0.005; // metres: joints, collinearity and boundary coverage
const EDGE_TOL = 0.001; // metres: opening extents
const LEVEL = { id: "level-1", name: "Level 1", elevation: 0 };
const UNIT_FACTORS = { m: 1, metre: 1, metres: 1, meter: 1, meters: 1, ft: 0.3048, foot: 0.3048, feet: 0.3048 };

const round6 = (v) => Math.round(v * 1e6) / 1e6 + 0;
const pt6 = (p) => [round6(p[0]), round6(p[1])];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const fmt = (v) => v.toFixed(2);
const fmtPt = (p) => `(${fmt(p[0])}, ${fmt(p[1])})`;

export const wallLength = (w) => dist(w.start, w.end);
// Distance along a→b of p's projection, and p's distance from the infinite line.
function project(a, b, p) {
  const d = sub(b, a), len = Math.hypot(d[0], d[1]);
  const u = [d[0] / len, d[1] / len], v = sub(p, a);
  return { along: dot(v, u), off: Math.abs(cross(u, v)), len };
}
function distToSegment(p, a, b) {
  const { along, off, len } = project(a, b, p);
  if (along < 0) return dist(p, a);
  if (along > len) return dist(p, b);
  return off;
}
function collinearOverlap(a, b, c, d, tol) {
  const p1 = project(a, b, c), p2 = project(a, b, d);
  if (p1.off > tol || p2.off > tol) return 0;
  const lo = Math.max(0, Math.min(p1.along, p2.along)), hi = Math.min(p1.len, Math.max(p1.along, p2.along));
  return hi - lo;
}
function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += cross(poly[i], poly[(i + 1) % poly.length]);
  return s / 2;
}
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// What a room's label says at a zoom of ppu pixels a metre, so the labels of a floor drawn with every room
// never run over each other: the name and area where both fit inside the room, the name alone where only it
// fits, "Unit N" on a unit's living room where its full name does not, else nothing (the room still names
// itself when selected or hovered). A character is taken as 0.6 of the 13 px font size wide.
export function roomLabel(room, ppu) {
  const xs = room.polygon.map((p) => p[0]), ys = room.polygon.map((p) => p[1]);
  const width = (Math.max(...xs) - Math.min(...xs)) * ppu * 0.9, height = (Math.max(...ys) - Math.min(...ys)) * ppu * 0.9;
  const fits = (text) => text.length * 13 * 0.6 <= width && height >= 16;
  if (fits(room.name)) return { name: room.name, area: height >= 32 };
  const unit = /^Unit (\d+)\b/.exec(room.name);
  if (unit && (room.kind === "living" || /living/i.test(room.name)) && fits(unit[0])) return { name: unit[0], area: false };
  return null;
}
export function interiorPoint(poly) {
  const a = signedArea(poly);
  let cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], k = cross(p, q);
    cx += (p[0] + q[0]) * k;
    cy += (p[1] + q[1]) * k;
  }
  const c = [cx / (6 * a), cy / (6 * a)];
  if (pointInPolygon(c, poly)) return c;
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (p[1] > c[1] !== q[1] > c[1]) xs.push(p[0] + ((c[1] - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
  }
  xs.sort((x, y) => x - y);
  return [(xs[0] + xs[1]) / 2, c[1]];
}
export const roomArea = (room) => Math.abs(signedArea(room.polygon));

// ---- Uploads and SVG sanitizing ----

export function checkUpload(file) {
  const kind = KINDS[file.type] || EXTENSIONS[file.name.toLowerCase().split(".").pop()];
  if (!kind) throw new Error("Upload an SVG, PDF, PNG, JPEG or WebP drawing, or an edited .pascal.json scene.");
  const limit = LIMITS[`${kind}Bytes`];
  if (file.size > limit) throw new Error(`${file.name} is too large; the limit is ${limit / 1024 / 1024} MB.`);
  return { kind, contentType: CONTENT_TYPES[kind] };
}

// An edited Pascal scene is a JSON object with its nodes at the top level; anything else is refused
// before upload. Returns how many nodes it holds.
export async function readPascalScene(file) {
  let scene;
  try { scene = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not valid JSON.`); }
  if (!scene || typeof scene !== "object" || Array.isArray(scene) || !scene.nodes || typeof scene.nodes !== "object") {
    throw new Error(`${file.name} is not a Pascal scene. To open a plan saved as JSON, use Load plan JSON.`);
  }
  return { nodes: Object.keys(scene.nodes).length };
}

const SVG_ELEMENTS = new Set(["svg", "g", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "text", "tspan", "title", "desc"]);
const PRESENTATION = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "vector-effect", "display", "visibility"];
const SVG_ATTRIBUTES = new Set(["xmlns", "id", "class", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "viewBox", "transform", "role", "aria-label", "aria-labelledby", "preserveAspectRatio", ...PRESENTATION]);
const UNSAFE_VALUE = /url\s*\(|javascript:|expression\s*\(|data:/i;

export function sanitizeSvg(text, { DOMParser }) {
  if (text.length > LIMITS.svgBytes) throw new Error(`The SVG is too large; the limit is ${LIMITS.svgBytes / 1024 / 1024} MB.`);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("SVG files with a DOCTYPE or entity declarations are not accepted.");
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("The file is not an SVG drawing.");
  const removed = [];
  const clean = (el) => {
    const inlineStyle = el.getAttribute("style") || "";
    el.removeAttribute("style");
    for (const attr of [...el.attributes]) {
      const name = attr.name, value = attr.value;
      if (!SVG_ATTRIBUTES.has(name)) {
        el.removeAttribute(name);
        removed.push(`${name} attribute`);
      } else if (UNSAFE_VALUE.test(value)) {
        el.removeAttribute(name);
        removed.push(`${name} reference`);
      }
    }
    const declarations = new Map();
    for (const rule of inlineStyle.split(";")) {
      const [prop, ...rest] = rule.split(":"), key = prop.trim().toLowerCase();
      if (!key) continue;
      const raw = rest.join(":").trim(), important = /!\s*important\s*$/i.test(raw);
      const value = raw.replace(/!\s*important\s*$/i, "").trim();
      if (!value || !PRESENTATION.includes(key) || UNSAFE_VALUE.test(value)) { removed.push(`style ${key}`); continue; }
      if (!declarations.get(key)?.important || important) declarations.set(key, {value, important});
    }
    for (const [key, {value}] of declarations) el.setAttribute(key, value);
    for (const child of [...el.children]) {
      if (SVG_ELEMENTS.has(child.localName)) clean(child);
      else {
        removed.push(child.localName);
        child.remove();
      }
    }
  };
  clean(root);
  return { svg: root.outerHTML, removed, viewBox: readViewBox(root) };
}

function readViewBox(root) {
  const vb = root.getAttribute("viewBox");
  if (vb) return vb.trim().split(/[\s,]+/).map(Number);
  const w = parseFloat(root.getAttribute("width")), h = parseFloat(root.getAttribute("height"));
  if (!(w > 0 && h > 0)) throw new Error("The SVG needs a viewBox or a width and height.");
  return [0, 0, w, h];
}

// ---- Vector primitives ----

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
function parseTransform(text) {
  let m = IDENTITY;
  for (const [, op, args] of (text || "").matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = args.trim().split(/[\s,]+/).map(Number);
    const rad = (v[0] * Math.PI) / 180;
    let t;
    if (op === "matrix") t = v;
    else if (op === "translate") t = [1, 0, 0, 1, v[0], v[1] || 0];
    else if (op === "scale") t = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (op === "rotate") {
      const r = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
      const [cx, cy] = [v[1] || 0, v[2] || 0];
      t = mul(mul([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
    } else if (op === "skewX") t = [1, 0, Math.tan(rad), 1, 0, 0];
    else t = [1, Math.tan(rad), 0, 1, 0, 0];
    m = mul(m, t);
  }
  return m;
}
// Straight-line path commands only; any curve or arc makes the path unreliable as a wall trace.
function parsePath(d) {
  const invalid = () => new Error("The SVG contains invalid path data. Re-export the drawing and try again.");
  const whitespace = /^[ \t\r\n\f]*$/;
  const isCommand = token => /^[a-zA-Z]$/.test(token);
  if (/^[ \t\r\n\f]*none[ \t\r\n\f]*$/.test(d)) return [];
  const tokens = [];
  let end = 0;
  for (const match of d.matchAll(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)) {
    const gap = d.slice(end, match.index);
    const betweenNumbers = tokens.length > 0 && !isCommand(tokens[tokens.length - 1]) && !isCommand(match[0]);
    if (!whitespace.test(gap) && !(betweenNumbers && /^[ \t\r\n\f]*,[ \t\r\n\f]*$/.test(gap))) throw invalid();
    tokens.push(match[0]);
    end = match.index + match[0].length;
  }
  if (!whitespace.test(d.slice(end))) throw invalid();
  const segments = [];
  let i = 0, cmd = null, cur = [0, 0], start = [0, 0], moved = false;
  while (i < tokens.length) {
    if (isCommand(tokens[i])) cmd = tokens[i++];
    if (!moved && !/^[Mm]$/.test(cmd)) throw invalid();
    if (/^[CcSsQqTtAa]$/.test(cmd)) return null;
    if (!/^[MmLlHhVvZz]$/.test(cmd)) throw invalid();
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : [0, 0];
    if (cmd === "Z" || cmd === "z") {
      if (dist(cur, start) > 0) segments.push([cur, start]);
      cur = start;
      cmd = null; // Close has no operands and cannot be repeated implicitly.
      continue;
    }
    const arity = /^[HhVv]$/.test(cmd) ? 1 : 2;
    const values = tokens.slice(i, i + arity).map(Number);
    if (values.length !== arity || !values.every(Number.isFinite)) throw invalid();
    i += arity;
    let next;
    if (cmd === "H" || cmd === "h") next = [values[0] + (rel ? cur[0] : 0), cur[1]];
    else if (cmd === "V" || cmd === "v") next = [cur[0], values[0] + (rel ? cur[1] : 0)];
    else next = [values[0] + base[0], values[1] + base[1]];
    if (!next.every(Number.isFinite)) throw invalid();
    if (cmd === "M" || cmd === "m") {
      moved = true;
      start = next;
      cmd = rel ? "l" : "L";
    } else segments.push([cur, next]);
    cur = next;
  }
  return segments;
}

const zeroOpacity = value => Number.isFinite(parseFloat(value)) && parseFloat(value) <= 0;
const DEFAULT_SVG_PAINT = {stroke: null, width: null, fill: null, visibility: "visible", strokeOpacity: "1", fillOpacity: "1", hidden: false};
function svgPaint(el, parent) {
  const inherit = (attribute, key, initial) => {
    const value = el.getAttribute(attribute)?.trim().toLowerCase();
    return value === undefined || value === "inherit" || value === "unset" ? parent[key] : value === "initial" ? initial : value;
  };
  return {
    stroke: inherit("stroke", "stroke", "none"), width: inherit("stroke-width", "width", "1"), fill: inherit("fill", "fill", "black"),
    visibility: inherit("visibility", "visibility", "visible"),
    strokeOpacity: inherit("stroke-opacity", "strokeOpacity", "1"), fillOpacity: inherit("fill-opacity", "fillOpacity", "1"),
    hidden: parent.hidden || el.getAttribute("display")?.trim().toLowerCase() === "none" || zeroOpacity(el.getAttribute("opacity")),
  };
}
const visiblePaint = style => style.visibility !== "hidden" && style.visibility !== "collapse";
const strokePainted = style => style.stroke && style.stroke !== "none" && style.stroke !== "transparent" && !zeroOpacity(style.strokeOpacity) && parseFloat(style.width ?? "1") > 0;
const fillPainted = style => style.fill !== "none" && style.fill !== "transparent" && !zeroOpacity(style.fillOpacity);
function visibleSvgText(node, parent) {
  if (node.nodeType === 3 || node.nodeType === 4) return visiblePaint(parent) && (fillPainted(parent) || strokePainted(parent)) ? node.textContent : "";
  if (node.nodeType !== 1 || node.localName === "title" || node.localName === "desc") return "";
  const style = svgPaint(node, parent);
  return style.hidden ? "" : [...node.childNodes].map(child => visibleSvgText(child, style)).join("");
}

export function extractPrimitives(svgText, { DOMParser }) {
  const root = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
  const viewBox = readViewBox(root);
  const segments = [], labels = [];
  let skipped = 0, background = null;
  const walk = (el, parent, inherited) => {
    const style = svgPaint(el, inherited);
    if (style.hidden) return;
    const m = mul(parent, parseTransform(el.getAttribute("transform")));
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const stroke = style.stroke && style.stroke !== "none" ? style.stroke.trim().toLowerCase() : null;
    const width = parseFloat(style.width ?? "1") * scale;
    const add = (pairs) => {
      if (!visiblePaint(style) || !strokePainted(style) || !stroke || !(width > 0)) return;
      for (const [a, b] of pairs) {
        const pa = apply(m, a), pb = apply(m, b);
        if (dist(pa, pb) > 0) segments.push({ a: pa, b: pb, stroke, width });
      }
    };
    const n = (name) => parseFloat(el.getAttribute(name) || "0");
    const name = el.localName;
    if (name === "line") add([[[n("x1"), n("y1")], [n("x2"), n("y2")]]]);
    else if (name === "polyline" || name === "polygon") {
      const v = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number), pts = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
      if (name === "polygon") pts.push(pts[0]);
      add(pts.slice(1).map((p, k) => [pts[k], p]));
    } else if (name === "path") {
      const parsed = parsePath(el.getAttribute("d") || "");
      if (parsed) add(parsed);
      else skipped++;
    } else if (name === "rect") {
      const x = n("x"), y = n("y"), w = n("width"), h = n("height");
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      add(corners.map((p, k) => [p, corners[(k + 1) % 4]]));
      if (!background && visiblePaint(style) && style.fill && fillPainted(style) && w * scale * h * scale >= 0.9 * viewBox[2] * viewBox[3]) background = style.fill;
    } else if (name === "text") {
      const text = visibleSvgText(el, inherited).trim();
      if (text) labels.push({ text, at: apply(m, [n("x"), n("y")]) });
    }
    if (name === "svg" || name === "g") for (const child of el.children) walk(child, m, style);
  };
  walk(root, IDENTITY, DEFAULT_SVG_PAINT);
  return { segments, labels, background, skipped, viewBox };
}

// The heaviest stroke group (by total length) is proposed as walls; shorter marks lying along a
// wall are proposed as openings: gaps painted in the background colour as doors, others as windows.
// skipped (curved paths) and ignored (marks that are neither) say what the reading left out.
export function proposeFromPrimitives({ segments, labels, background, viewBox, skipped = 0 }) {
  const groups = new Map();
  for (const s of segments) {
    const key = `${s.stroke}|${s.width.toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, { stroke: s.stroke, width: s.width, total: 0, segments: [] });
    const g = groups.get(key);
    g.total += dist(s.a, s.b);
    g.segments.push(s);
  }
  const candidates = [...groups.values()].filter((g) => g.stroke !== background).sort((a, b) => b.total - a.total);
  const wallGroup = candidates[0];
  if (!wallGroup) return { walls: [], openings: [], labels, ignored: segments.length, skipped, viewBox, wallWidth: 0 };
  const tol = wallGroup.width;
  const walls = [];
  for (const s of wallGroup.segments) {
    const twin = walls.find((w) => collinearOverlap(w.a, w.b, s.a, s.b, tol / 2) > tol);
    if (!twin) {
      walls.push({ a: s.a, b: s.b });
      continue;
    }
    const pa = project(twin.a, twin.b, s.a).along, pb = project(twin.a, twin.b, s.b).along, len = dist(twin.a, twin.b);
    const lo = Math.min(0, pa, pb), hi = Math.max(len, pa, pb), start = twin.a, end = twin.b;
    twin.a = lerp(start, end, lo / len);
    twin.b = lerp(start, end, hi / len);
  }
  const ends = [];
  const snap = (p) => ends.find((q) => dist(p, q) <= tol) || (ends.push(p), p);
  for (const w of walls) {
    w.a = snap(w.a);
    w.b = snap(w.b);
  }
  const openings = [];
  let ignored = 0;
  for (const s of segments) {
    if (wallGroup.segments.includes(s)) continue;
    const host = walls.findIndex((w) => {
      const pa = project(w.a, w.b, s.a), pb = project(w.a, w.b, s.b);
      return pa.off <= tol && pb.off <= tol && Math.min(pa.along, pb.along) >= -tol && Math.max(pa.along, pb.along) <= pa.len + tol && dist(s.a, s.b) < pa.len;
    });
    if (host < 0) {
      ignored++;
      continue;
    }
    const w = walls[host], len = dist(w.a, w.b);
    const t1 = Math.max(0, project(w.a, w.b, s.a).along), t2 = Math.min(len, project(w.a, w.b, s.b).along);
    openings.push({ wall: host, from: Math.min(t1, t2), to: Math.max(t1, t2), kind: s.stroke === background ? "door" : "window" });
  }
  return { walls, openings, labels, ignored, skipped, viewBox, wallWidth: wallGroup.width };
}

// The parts of a drawing the reading could not use, said beside what it found, or "" when none.
export function readingLosses({ skipped = 0, ignored = 0 }) {
  const parts = [];
  if (skipped) parts.push(`${skipped} curved path${skipped === 1 ? "" : "s"} could not be read as walls`);
  if (ignored) parts.push(`${ignored} mark${ignored === 1 ? "" : "s"} could not be read as a wall or opening`);
  return parts.length ? `${parts.join("; ")}. Compare the plan with the drawing and add what is missing.` : "";
}

// ---- Calibration ----

export function calibrate(pointA, pointB, distanceMetres) {
  if (dist(pointA, pointB) < 1e-9) throw new Error("Pick two different points on the drawing.");
  if (!(Number.isFinite(distanceMetres) && distanceMetres > 0)) throw new Error("Type the known distance in metres; it must be greater than zero.");
  return { pointA: [...pointA], pointB: [...pointB], distanceMetres, metresPerPixel: distanceMetres / dist(pointA, pointB) };
}
export const metresPerPixel = (cal) => cal.distanceMetres / dist(cal.pointA, cal.pointB);
// Point A is the plan origin; drawing y grows down, plan y grows north.
export function toMetres(p, cal) {
  const k = metresPerPixel(cal);
  return [(p[0] - cal.pointA[0]) * k, (cal.pointA[1] - p[1]) * k];
}
export function toPixels(p, cal) {
  const k = metresPerPixel(cal);
  return [cal.pointA[0] + p[0] / k, cal.pointA[1] - p[1] / k];
}
const calibrationRecord = (cal) => ({ pointA: [...cal.pointA], pointB: [...cal.pointB], distanceMetres: cal.distanceMetres });

const drawingPage = ({ref}, kind) => kind === 'pdf' ? (ref.match(/#page=(\d+)$/)?.[1] ?? '1') : null;
// Stored IDs distinguish same-named site drawings; legacy plans may refer to the name or ID.
export function drawingSource(plan, drawing) {
  const candidates = (plan?.sources ?? []).filter((s) => typeof s.ref === 'string'
    && (s.kind == null || s.kind === drawing.kind) && drawingPage(s, drawing.kind) === drawingPage(drawing, drawing.kind));
  const base = (ref) => ref.split('#')[0];
  return candidates.find((s) => drawing.drawingId != null && s.drawingId === drawing.drawingId)
    ?? candidates.find((s) => s.drawingId == null && [base(drawing.ref), drawing.drawingId].includes(base(s.ref)));
}
// Upload completion supplies the saved identity; keep each page's calibration and geometry.
export function linkDrawingSources(plan, previousName, drawing) {
  if (!plan) return plan;
  let changed = false;
  const sources = plan.sources.map((source) => {
    if (source.drawingId != null || (source.kind != null && source.kind !== drawing.kind)
      || typeof source.ref !== 'string' || source.ref.split('#')[0] !== previousName) return source;
    changed = true;
    return {...source, ref: drawing.name + source.ref.slice(previousName.length), drawingId: drawing.id};
  });
  return changed ? {...plan, sources} : plan;
}
function recordCalibration(plan, calibration, drawing) {
  const current = drawingSource(plan, drawing);
  const source = {...current, kind: drawing.kind, ref: drawing.ref,
    ...(drawing.drawingId != null ? {drawingId: drawing.drawingId} : {}), calibration: calibrationRecord(calibration)};
  return {...plan, sources: current ? plan.sources.map((s) => s === current ? source : s) : [...plan.sources, source]};
}

// ---- Plan construction ----

function basePlan(name, height, sources) {
  return {
    schema: PLAN_SCHEMA, id: null, revision: null, parentRevision: null, name, units: "m",
    levels: [{ ...LEVEL, height }], walls: [], openings: [], rooms: [], objects: [], sources,
  };
}

// A plan drawn from nothing: one empty level at the default height, ready for its first wall.
export function blankPlan(name = "Floor plan") {
  return basePlan(name, DEFAULTS.height, []);
}
const makeWall = (id, levelId, start, end, thickness = DEFAULTS.thickness, height = DEFAULTS.height) => ({
  id, levelId, start: pt6(start), end: pt6(end), thickness, height, material: "generic", roomIds: [],
});

export function planFromDrawing({ proposal, calibration, source }) {
  if (!calibration) throw new Error("Calibrate the drawing first: pick two points and type the known distance.");
  const k = metresPerPixel(calibration);
  const plan = basePlan(source.ref.replace(/\.[^.]+$/, ""), DEFAULTS.height, [{ ...source, calibration: calibrationRecord(calibration) }]);
  plan.walls = proposal.walls.map((w, i) => makeWall(`wall-${i + 1}`, LEVEL.id, toMetres(w.a, calibration), toMetres(w.b, calibration)));
  plan.openings = proposal.openings.map((o, i) => ({
    id: `opening-${i + 1}`, wallId: plan.walls[o.wall].id, kind: o.kind,
    offset: round6(o.from * k), width: round6((o.to - o.from) * k),
    sill: DEFAULTS[o.kind].sill, height: DEFAULTS[o.kind].height, swing: null,
  }));
  plan.rooms = detectRooms(plan, { labels: proposal.labels.map((l) => ({ text: l.text, at: toMetres(l.at, calibration) })) });
  return plan;
}

export function planFromFixture(json, { ref }) {
  const f = UNIT_FACTORS[String(json.units).toLowerCase()];
  if (!f) throw new Error(`Unknown units "${json.units}"; use metres or feet.`);
  const s = (v) => round6(v * f), sp = (p) => [s(p[0]), s(p[1])];
  const height = s(json.height), thickness = s(json.wall_thickness);
  const plan = basePlan(json.name, height, [{ kind: "json", ref, calibration: null }]);
  plan.walls = json.walls.map((w) => makeWall(w.id, LEVEL.id, sp(w.start), sp(w.end), thickness, height));
  plan.openings = json.openings.map((o) => ({
    id: o.id, wallId: o.wall, kind: o.kind, offset: s(o.offset), width: s(o.width), sill: s(o.sill), height: s(o.height), swing: o.swing ?? null,
  }));
  plan.rooms = json.rooms.map((r) => {
    const [x0, y0, x1, y1] = r.bounds.map(s);
    return { id: r.id, levelId: LEVEL.id, name: r.name, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], netAreaMethod: "centerline" };
  });
  return plan;
}

// Import shape checks protect editor operations; geometry issues remain editable in validatePlan.
export function planFromJson(json, { ref }) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const point = (value, path) => require(Array.isArray(value) && value.length === 2 && value.every(Number.isFinite), `${path} must be a two-number coordinate.`);
  const numbers = (item, keys, path) => keys.forEach((key) => require(Number.isFinite(item[key]), `${path}.${key} must be a finite number.`));
  require(object(json), "The plan JSON must be an object.");
  require(json.schema === undefined || json.schema === PLAN_SCHEMA, `Unsupported plan schema. Use ${PLAN_SCHEMA}.`);
  const plan = json.schema === PLAN_SCHEMA ? json : planFromFixture(json, { ref });
  require(plan.units === "m", "The v1 plan units must be m (metres).");
  require(typeof plan.name === "string" && plan.name.trim().length > 0 && plan.name.length <= 200, "The plan name must be 1 to 200 characters.");
  const limits = { levels: 200, walls: 20000, openings: 20000, rooms: 5000, objects: 20000, sources: 500 };
  const ids = {};
  for (const [key, limit] of Object.entries(limits)) {
    const list = plan[key];
    require(Array.isArray(list) && list.length <= limit, `The plan ${key} must be a list of at most ${limit} entries.`);
    ids[key] = new Set();
    list.forEach((item, i) => {
      require(object(item), `${key}[${i}] must be an object.`);
      if (key === "objects" || key === "sources") return;
      require(typeof item.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(item.id), `${key}[${i}].id must be 1 to 100 letters, digits or . _ : -`);
      require(!ids[key].has(item.id), `${key}[${i}].id duplicates ${item.id}.`);
      ids[key].add(item.id);
    });
  }
  require(plan.levels.length > 0, "The plan needs at least one level.");
  plan.levels.forEach((level, i) => numbers(level, ["elevation", "height"], `levels[${i}]`));
  for (const key of ["walls", "rooms", "objects"]) plan[key].forEach((item, i) => {
    if (key !== "objects" || item.levelId !== undefined) require(ids.levels.has(item.levelId), `${key}[${i}].levelId must name a level in this plan.`);
  });
  plan.walls.forEach((wall, i) => {
    point(wall.start, `walls[${i}].start`); point(wall.end, `walls[${i}].end`);
    numbers(wall, ["thickness", "height"], `walls[${i}]`);
    if (wall.roomIds !== undefined) require(Array.isArray(wall.roomIds) && wall.roomIds.every((id) => ids.rooms.has(id)), `walls[${i}].roomIds must name rooms in this plan.`);
  });
  plan.openings.forEach((opening, i) => {
    require(ids.walls.has(opening.wallId), `openings[${i}].wallId must name a wall in this plan.`);
    require(opening.kind === "door" || opening.kind === "window", `openings[${i}].kind must be door or window.`);
    numbers(opening, ["offset", "width", "height", "sill"], `openings[${i}]`);
  });
  plan.rooms.forEach((room, i) => {
    require(Array.isArray(room.polygon) && room.polygon.length >= 3, `rooms[${i}].polygon needs at least three coordinates.`);
    room.polygon.forEach((p, j) => point(p, `rooms[${i}].polygon[${j}]`));
  });
  plan.sources.forEach((source, i) => {
    if (source.ref !== undefined) require(typeof source.ref === "string", `sources[${i}].ref must be text.`);
    if (source.calibration == null) return;
    require(object(source.calibration), `sources[${i}].calibration must be an object.`);
    point(source.calibration.pointA, `sources[${i}].calibration.pointA`);
    point(source.calibration.pointB, `sources[${i}].calibration.pointB`);
    calibrate(source.calibration.pointA, source.calibration.pointB, source.calibration.distanceMetres);
  });
  return plan;
}

// ---- Room detection: faces of the planar wall graph ----

const DIMENSION_LABEL = /^[\d\s.,'"×x-]+(mm|cm|m|ft|in|m²|sq ?ft)?$/i;

function wallFaces(walls) {
  const nodes = [];
  const node = (p) => {
    let i = nodes.findIndex((q) => dist(p, q) <= TOL);
    if (i < 0) i = nodes.push(p) - 1;
    return i;
  };
  const edges = new Set();
  for (const w of walls) {
    const len = wallLength(w), cuts = [0, len];
    for (const o of walls) {
      if (o === w) continue;
      for (const p of [o.start, o.end]) if (distToSegment(p, w.start, w.end) <= TOL) cuts.push(project(w.start, w.end, p).along);
      const r = sub(w.end, w.start), s = sub(o.end, o.start), den = cross(r, s);
      if (Math.abs(den) > 1e-12) {
        const qp = sub(o.start, w.start), t = cross(qp, s) / den, u = cross(qp, r) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t * len);
      }
    }
    const ids = [...new Set(cuts.map((c) => Math.min(len, Math.max(0, c))).sort((a, b) => a - b).map((c) => node(lerp(w.start, w.end, c / len))))];
    for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[i - 1]) edges.add(ids[i] < ids[i - 1] ? `${ids[i]}:${ids[i - 1]}` : `${ids[i - 1]}:${ids[i]}`);
  }
  const adj = nodes.map(() => []);
  for (const e of edges) {
    const [a, b] = e.split(":").map(Number);
    adj[a].push(b);
    adj[b].push(a);
  }
  const angle = (from, to) => Math.atan2(nodes[to][1] - nodes[from][1], nodes[to][0] - nodes[from][0]);
  adj.forEach((list, i) => list.sort((a, b) => angle(i, a) - angle(i, b)));
  const seen = new Set(), faces = [];
  for (let u = 0; u < nodes.length; u++) {
    for (const v of adj[u]) {
      if (seen.has(`${u}>${v}`)) continue;
      const loop = [];
      let a = u, b = v;
      while (!seen.has(`${a}>${b}`)) {
        seen.add(`${a}>${b}`);
        loop.push(nodes[a]);
        const list = adj[b], i = list.indexOf(a);
        const next = list[(i - 1 + list.length) % list.length];
        a = b;
        b = next;
      }
      const poly = simplify(loop);
      if (poly.length >= 3 && signedArea(poly) > TOL * TOL) faces.push(poly);
    }
  }
  return faces;
}
// Drop repeated points, dead-end spikes and collinear vertices; start at the south-west corner.
function simplify(loop) {
  let poly = loop.map((p) => pt6(p));
  for (let changed = true; changed && poly.length >= 3; ) {
    changed = false;
    for (let i = 0; i < poly.length && poly.length >= 3; i++) {
      const prev = poly[(i - 1 + poly.length) % poly.length], cur = poly[i], next = poly[(i + 1) % poly.length];
      if (dist(prev, cur) <= TOL || Math.abs(cross(sub(cur, prev), sub(next, cur))) <= TOL * Math.max(dist(prev, cur), dist(cur, next))) {
        poly.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  const start = poly.reduce((best, p, i) => (p[1] < poly[best][1] - TOL || (Math.abs(p[1] - poly[best][1]) <= TOL && p[0] < poly[best][0]) ? i : best), 0);
  return [...poly.slice(start), ...poly.slice(0, start)];
}

export function detectRooms(plan, { labels }) {
  const out = [];
  const used = new Set(plan.rooms.map((r) => r.name));
  for (const level of plan.levels) {
    const faces = wallFaces(plan.walls.filter((w) => w.levelId === level.id));
    const existing = plan.rooms.filter((r) => r.levelId === level.id);
    const matched = faces.map((poly) => {
      const inner = interiorPoint(poly);
      const prior = existing.find((r) => pointInPolygon(interiorPoint(r.polygon), poly) && pointInPolygon(inner, r.polygon));
      const label = labels.find((l) => !DIMENSION_LABEL.test(l.text) && pointInPolygon(l.at, poly));
      return { poly, inner, prior, label };
    });
    const order = (m) => (m.prior ? existing.indexOf(m.prior) : existing.length);
    matched.sort((a, b) => order(a) - order(b) || b.inner[1] - a.inner[1] || a.inner[0] - b.inner[0]);
    for (const m of matched) {
      let name = m.prior?.name ?? m.label?.text;
      if (!name) {
        let n = 1;
        while (used.has(`Room ${n}`)) n++;
        name = `Room ${n}`;
      }
      used.add(name);
      const id = m.prior?.id ?? nextId({ ...plan, rooms: [...plan.rooms, ...out] }, "room");
      out.push({ id, levelId: level.id, name, polygon: m.poly, netAreaMethod: m.prior?.netAreaMethod ?? "centerline" });
    }
  }
  return out;
}

// ---- Validation ----

function wallCoverageGaps(edgeA, edgeB, walls) {
  const len = dist(edgeA, edgeB), spans = [];
  for (const w of walls) {
    const p = project(edgeA, edgeB, w.start), q = project(edgeA, edgeB, w.end);
    const lo = Math.min(p.along, q.along), hi = Math.max(p.along, q.along);
    // Collinear walls that end before the edge starts or start after it ends cover none of it.
    if (p.off > TOL || q.off > TOL || hi <= TOL || lo >= len - TOL) continue;
    spans.push([lo, hi]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let reach = 0;
  for (const [lo, hi] of spans) {
    if (lo > reach + TOL) return true;
    reach = Math.max(reach, hi);
  }
  return reach < len - TOL;
}
function segmentsCross(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s);
  if (Math.abs(den) < 1e-12) return false;
  const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

export function validatePlan(plan) {
  const issues = [];
  const add = (severity, code, kind, id, message) => issues.push({ severity, code, ref: { kind, id }, message });
  // Ids are unique within each collection; the fixture names a wall and a room "kitchen".
  for (const [kind, items] of [["level", plan.levels], ["wall", plan.walls], ["opening", plan.openings], ["room", plan.rooms], ["object", plan.objects]]) {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.id)) add("error", "duplicate-id", kind, item.id, `The id "${item.id}" is used more than once.`);
      seen.add(item.id);
    }
  }
  const levels = new Set(plan.levels.map((l) => l.id));
  const walls = new Map(plan.walls.map((w) => [w.id, w]));
  plan.walls.forEach((w, i) => {
    if (!levels.has(w.levelId)) add("error", "wall-level-missing", "wall", w.id, `Wall ${w.id} is on an unknown level.`);
    if (wallLength(w) < 0.05) add("error", "wall-too-short", "wall", w.id, `Wall ${w.id} is shorter than 5 cm.`);
    if (!(w.thickness > 0 && w.height > 0)) add("error", "wall-size", "wall", w.id, `Wall ${w.id} needs a thickness and height above zero.`);
    for (const prior of plan.walls.slice(0, i)) {
      if (prior.levelId === w.levelId && collinearOverlap(prior.start, prior.end, w.start, w.end, TOL) > TOL)
        add("error", "wall-duplicate", "wall", w.id, `Wall ${w.id} overlaps wall ${prior.id}; draw a shared wall once.`);
    }
    for (const end of [w.start, w.end]) {
      const joined = plan.walls.some((o) => o !== w && o.levelId === w.levelId && distToSegment(end, o.start, o.end) <= TOL);
      if (!joined) add("warning", "wall-open-end", "wall", w.id, `Wall ${w.id} has a free end at ${fmtPt(end)}.`);
    }
  });
  plan.openings.forEach((o) => {
    const w = walls.get(o.wallId);
    if (!w) return add("error", "opening-wall-missing", "opening", o.id, `Opening ${o.id} is not on a known wall.`);
    if (o.kind !== "door" && o.kind !== "window") add("error", "opening-kind", "opening", o.id, `Opening ${o.id} must be a door or a window.`);
    if (!(o.width > 0 && o.height > 0)) return add("error", "opening-size", "opening", o.id, `Opening ${o.id} needs a width and height above zero.`);
    const len = wallLength(w);
    if (o.offset < -EDGE_TOL || o.offset + o.width > len + EDGE_TOL)
      add("error", "opening-outside-wall", "opening", o.id, `Opening ${o.id} runs past wall ${w.id}, which is ${fmt(len)} m long.`);
    if (o.sill < -EDGE_TOL || o.sill + o.height > w.height + EDGE_TOL)
      add("error", "opening-too-tall", "opening", o.id, `Opening ${o.id} rises above wall ${w.id} (${fmt(w.height)} m).`);
    for (const other of plan.openings) {
      if (other === o || other.wallId !== o.wallId) continue;
      if (Math.min(o.offset + o.width, other.offset + other.width) - Math.max(o.offset, other.offset) > EDGE_TOL)
        add("error", "opening-overlap", "opening", o.id, `Opening ${o.id} overlaps opening ${other.id}.`);
    }
  });
  for (const r of plan.rooms) {
    if (!levels.has(r.levelId)) add("error", "room-level-missing", "room", r.id, `Room ${r.name} is on an unknown level.`);
    const poly = r.polygon, n = poly.length;
    let simple = n >= 3 && Math.abs(signedArea(poly)) > TOL * TOL;
    for (let i = 0; simple && i < n; i++)
      for (let j = i + 2; j < n; j++) if (!(i === 0 && j === n - 1) && segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) simple = false;
    if (!simple) {
      add("error", "room-shape", "room", r.id, `Room ${r.name} needs a simple boundary with at least three corners.`);
      continue;
    }
    const levelWalls = plan.walls.filter((w) => w.levelId === r.levelId);
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if (wallCoverageGaps(a, b, levelWalls)) {
        add("error", "room-open-boundary", "room", r.id, `Room ${r.name} is not closed: no wall runs from ${fmtPt(a)} to ${fmtPt(b)}.`);
        break;
      }
    }
  }
  return issues;
}

// ---- Export ----

export function exportPlan(plan) {
  const roomIdsFor = (w) => plan.rooms.filter((r) => r.levelId === w.levelId && r.polygon.some((a, i) => {
    const b = r.polygon[(i + 1) % r.polygon.length];
    return collinearOverlap(a, b, w.start, w.end, TOL) > TOL;
  })).map((r) => r.id);
  return {
    schema: PLAN_SCHEMA, id: plan.id, revision: plan.revision, parentRevision: plan.parentRevision, name: plan.name, units: "m",
    levels: plan.levels.map((l) => ({ ...l })),
    walls: plan.walls.map((w) => ({ ...w, start: [...w.start], end: [...w.end], roomIds: roomIdsFor(w) })),
    openings: plan.openings.map((o) => ({ ...o })),
    rooms: plan.rooms.map((r) => ({ ...r, polygon: r.polygon.map((p) => [...p]) })),
    objects: plan.objects.map((o) => ({ ...o })),
    sources: plan.sources.map((s) => ({ ...s, calibration: s.calibration && calibrationRecord(s.calibration) })),
  };
}

// ---- Edits (pure: each returns a new plan) ----

export function nextId(plan, prefix) {
  const ids = new Set([...plan.levels, ...plan.walls, ...plan.openings, ...plan.rooms, ...plan.objects].map((x) => x.id));
  let n = 1;
  while (ids.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}
export function addWall(plan, { start, end, levelId = plan.levels[0].id }) {
  const level = plan.levels.find((l) => l.id === levelId);
  if (!level) throw new Error('Choose a level in this plan before adding a wall.');
  return { ...plan, walls: [...plan.walls, makeWall(nextId(plan, "wall"), level.id, start, end, DEFAULTS.thickness, level.height)] };
}
export function moveWall(plan, id, { start, end }) {
  return { ...plan, walls: plan.walls.map((w) => (w.id === id ? { ...w, start: pt6(start), end: pt6(end) } : w)) };
}
// Every wall end at `from` on the chosen level moves to `to`, so corners stay joined.
export function moveJoint(plan, from, to, levelId) {
  const p = pt6(to), at = (q) => dist(q, from) <= TOL;
  return { ...plan, walls: plan.walls.map((w) => (w.levelId === levelId && (at(w.start) || at(w.end)) ? { ...w, start: at(w.start) ? p : w.start, end: at(w.end) ? p : w.end } : w)) };
}
export function translateWall(plan, id, delta) {
  const w = plan.walls.find((x) => x.id === id);
  const [a, b] = [w.start, w.end];
  // Match the original joints once, so a moved end cannot be picked up by the other end.
  const shift = (p) => dist(p, a) <= TOL || dist(p, b) <= TOL ? pt6([p[0] + delta[0], p[1] + delta[1]]) : p;
  return { ...plan, walls: plan.walls.map((wall) => wall.levelId === w.levelId ? { ...wall, start: shift(wall.start), end: shift(wall.end) } : wall) };
}
export function translateOpening(plan, id, delta) {
  const opening = plan.openings.find((item) => item.id === id), wall = plan.walls.find((item) => item.id === opening.wallId), len = wallLength(wall);
  if (len === 0) return plan;
  const along = ((wall.end[0] - wall.start[0]) * delta[0] + (wall.end[1] - wall.start[1]) * delta[1]) / len;
  const offset = round6(Math.max(0, Math.min(len - opening.width, opening.offset + along)));
  return offset === opening.offset ? plan : updateItem(plan, 'openings', id, {offset});
}
// Snap a pointer to a wall end, then onto a wall, then to the 1 cm grid.
export function snapPoint(plan, p, radius) {
  let best = null;
  for (const w of plan.walls) for (const q of [w.start, w.end]) if (dist(p, q) <= radius && (!best || dist(p, q) < dist(p, best))) best = q;
  if (best) return { point: [...best], kind: "joint" };
  for (const w of plan.walls) {
    if (distToSegment(p, w.start, w.end) > radius) continue;
    const { along, len } = project(w.start, w.end, p);
    return { point: pt6(lerp(w.start, w.end, along / len)), kind: "wall" };
  }
  return { point: [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100], kind: "grid" };
}
export function nearestWall(plan, p, radius) {
  let best = null, bestD = radius;
  for (const w of plan.walls) {
    const d = distToSegment(p, w.start, w.end);
    if (d <= bestD) [best, bestD] = [w, d];
  }
  return best;
}
export function updateItem(plan, collection, id, patch) {
  return { ...plan, [collection]: plan[collection].map((x) => (x.id === id ? { ...x, ...patch } : x)) };
}
export function deleteWall(plan, id) {
  return { ...plan, walls: plan.walls.filter((w) => w.id !== id), openings: plan.openings.filter((o) => o.wallId !== id) };
}
export function deleteItem(plan, collection, id) {
  return collection === "walls" ? deleteWall(plan, id) : { ...plan, [collection]: plan[collection].filter((x) => x.id !== id) };
}
export function splitWall(plan, id, point) {
  const w = plan.walls.find((x) => x.id === id), len = wallLength(w);
  const at = Math.min(len, Math.max(0, project(w.start, w.end, point).along));
  if (at < TOL * 4 || at > len - TOL * 4) throw new Error("Pick a split point inside the wall, away from its ends.");
  if (plan.openings.some((o) => o.wallId === id && o.offset < at && o.offset + o.width > at)) throw new Error("That point is inside an opening; move the opening before splitting.");
  const p = pt6(lerp(w.start, w.end, at / len)), newId = nextId(plan, "wall");
  const walls = plan.walls.flatMap((x) => (x.id === id ? [{ ...x, end: p }, { ...x, id: newId, start: p, roomIds: [] }] : [x]));
  const openings = plan.openings.map((o) => (o.wallId === id && o.offset >= at ? { ...o, wallId: newId, offset: round6(o.offset - at) } : o));
  return { ...plan, walls, openings };
}
export function placeOpening(plan, { wallId, kind, at }) {
  const w = plan.walls.find((x) => x.id === wallId), len = wallLength(w), d = DEFAULTS[kind];
  const width = Math.min(d.width, len);
  const offset = round6(Math.min(len - width, Math.max(0, project(w.start, w.end, at).along - width / 2)));
  const opening = { id: nextId(plan, "opening"), wallId, kind, offset, width, sill: d.sill, height: d.height, swing: null };
  return { ...plan, openings: [...plan.openings, opening] };
}
// A redone calibration moves the geometry traced from that drawing, on its own level, with the drawing;
// other levels, heights and thicknesses are kept.
export function reprojectPlan(plan, oldCal, newCal, drawing = plan.sources[0], levelId = plan.levels[0].id) {
  const calibrated = recordCalibration(plan, newCal, drawing);
  if (!oldCal) return calibrated;
  const map = (p) => pt6(toMetres(toPixels(p, oldCal), newCal));
  const k = metresPerPixel(newCal) / metresPerPixel(oldCal);
  const moved = new Set(plan.walls.filter((w) => w.levelId === levelId).map((w) => w.id));
  return {
    ...calibrated,
    walls: plan.walls.map((w) => (moved.has(w.id) ? { ...w, start: map(w.start), end: map(w.end) } : w)),
    openings: plan.openings.map((o) => (moved.has(o.wallId) ? { ...o, offset: round6(o.offset * k), width: round6(o.width * k) } : o)),
    rooms: plan.rooms.map((r) => (r.levelId === levelId ? { ...r, polygon: r.polygon.map(map) } : r)),
  };
}

// ---- Saving and drafts ----

// A site has one plan per scheme (As of right, Most floor area, Alternative); revisions are numbered per plan.
export const SCHEMES = [
  { id: "as_of_right", label: "As of right" },
  { id: "max_bonus", label: "Most floor area" },
  { id: "alternative", label: "Alternative" },
];
export const DEFAULT_SCHEME = "as_of_right";
const planUrl = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/architecture`;
// Requests name a scheme other than the as-of-right plan, which is the service's default.
export const schemeQuery = (scheme) => (scheme === DEFAULT_SCHEME ? "" : `?scheme=${encodeURIComponent(scheme)}`);
const schemeField = (scheme) => (scheme === DEFAULT_SCHEME ? {} : { scheme });

export async function savePlan({ fetch, projectId, plan, scheme = DEFAULT_SCHEME }) {
  const parentRevision = plan.revision;
  const response = await fetch(`${planUrl(projectId)}/plan`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentRevision, ...schemeField(scheme), plan: { ...exportPlan(plan), parentRevision } }),
  });
  const body = await response.json();
  if (response.status === 409) return { status: "conflict", revision: body.revision, message: body.error };
  if (!response.ok) throw new Error(body.error);
  return { status: "saved", plan: { ...body.plan, id: body.planId, revision: body.revision, parentRevision: body.parentRevision } };
}
// An earlier revision comes back as the next one: its document is saved again on top of the
// current revision, so the history keeps every revision in between.
export async function restoreRevision({ fetch, projectId, revision, current, scheme = DEFAULT_SCHEME }) {
  const response = await fetch(`${planUrl(projectId)}/revisions/${revision}${schemeQuery(scheme)}`, { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return savePlan({ fetch, projectId, scheme, plan: { ...body.plan, revision: current } });
}
export async function loadPlan({ fetch, projectId, scheme = DEFAULT_SCHEME }) {
  const response = await fetch(`${planUrl(projectId)}${schemeQuery(scheme)}`, { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body.current ? { ...body.current.plan, revision: body.current.revision } : null;
}
// The as-of-right plan keeps the key unsaved edits had before schemes.
export const draftKey = (projectId, scheme = DEFAULT_SCHEME) => `arosa-plan-draft-${projectId}${scheme === DEFAULT_SCHEME ? "" : `-${scheme}`}`;
export function writeDraft(storage, projectId, plan, scheme) {
  storage.setItem(draftKey(projectId, scheme), JSON.stringify(plan));
}
export function readDraft(storage, projectId, scheme) {
  let draft;
  try {
    const raw = storage.getItem(draftKey(projectId, scheme));
    draft = raw ? JSON.parse(raw) : null;
  } catch { return null; }
  return draft?.schema === PLAN_SCHEMA && draft.units === 'm'
    && ['levels', 'walls', 'openings', 'rooms', 'objects', 'sources'].every((key) => Array.isArray(draft[key]))
    ? draft : null;
}
export function clearDraft(storage, projectId, scheme) {
  storage.removeItem(draftKey(projectId, scheme));
}

// ---- Project drawings and live updates ----

const drawingsUrl = (projectId) => `${planUrl(projectId)}/drawings`;
export const drawingUrl = (projectId, drawingId) => `${drawingsUrl(projectId)}/${encodeURIComponent(drawingId)}`;

export async function listDrawings({ fetch, projectId }) {
  const response = await fetch(drawingsUrl(projectId), { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body.drawings;
}
export async function uploadDrawing({ fetch, projectId, file }) {
  const { kind, contentType } = checkUpload(file);
  // A JSON body would be read as an attach-by-URL request; the scene goes as bytes and is typed by them.
  const response = await fetch(drawingsUrl(projectId), {
    method: "POST",
    headers: { "content-type": kind === "pascal-scene" ? "application/octet-stream" : contentType, "x-drawing-name": encodeURIComponent(file.name) },
    body: file,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}
export async function fetchDrawing({ fetch, projectId, drawing }) {
  const response = await fetch(drawingUrl(projectId, drawing.id));
  if (!response.ok) throw new Error(`${drawing.name} could not be downloaded.`);
  return new File([await response.blob()], drawing.name, { type: drawing.contentType });
}

// What the open editor does with project events: one live event, or all those held while the first
// load or a save was in flight. The stream replays the project's history on connect, so revisions up
// to the loaded or saved one and drawings already listed are dropped. Several revisions collapse to the
// newest, loaded in place or offered when there are unsaved edits; Arosa's newest drawing fills an empty canvas.
// Only the open scheme's revisions count; revisions from before schemes are the as-of-right plan's.
export function planEventActions(events, { projectId, scheme = DEFAULT_SCHEME, revision, own, dirty, empty, drawingIds }) {
  let latest = null, refreshDrawings = false, showDrawing = null;
  for (const e of events) {
    if (e?.projectId !== projectId) continue;
    if (e.event === "architecture.revision" && (e.scheme ?? DEFAULT_SCHEME) === scheme && !own.has(e.revision) && e.revision > Math.max(revision ?? 0, latest?.revision ?? 0)) latest = e;
    if (e.event === "architecture.drawing" && !drawingIds.has(e.drawingId)) {
      refreshDrawings = true;
      if (e.by === "agent" && empty) showDrawing = e.drawingId;
    }
  }
  return { revision: latest && { action: dirty ? "offer" : "load", revision: latest.revision, by: latest.by }, refreshDrawings, showDrawing };
}
