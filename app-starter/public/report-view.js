// Underwriting report at /sites/:projectId/report: the site's full underwriting as one investment
// memo to read, share and print. Figures come from the project state, each with the record that
// produced it and its assumption labels; the narrative comes from the site conversation's latest
// answer, filed under the chapter its heading belongs to. Nothing here computes a new number.
import { chatRequest } from "./chat-api.js";
import { linkOrigin } from "./core-route.js";
import { marked } from "./vendor/marked.esm.js";
import { skel } from "./skeleton.js";
import { newsList } from "./news-view.js";
import { nearbyPipelineQuery, nearbySummary, stageLine, tenureLine, zipLine, asOf, area, STAGES, TENURE } from "./nearby-pipeline.js";
import { schemesReportBlock } from "./schemes-view.js";
import { helpLink } from "./help-links.js";
import { leadingScheme, snapshot, landAnswer, decisionDiffers, tierBasisPhrase } from "./core-model.js";

// ---------- Formatting ----------
const finite = (n) => n !== null && n !== undefined && n !== "" && Number.isFinite(Number(n));
const MINUS = "\u2212";
const signed = (n, text) => (Number(n) < 0 ? MINUS + text : text);
export const usd = (n) => (finite(n) ? signed(n, "$" + Math.abs(Math.round(Number(n))).toLocaleString("en-US")) : null);
const count = (n, digits = 0) => (finite(n) ? Number(n).toLocaleString("en-US", { maximumFractionDigits: digits }) : null);
export const sqft = (n) => (finite(n) ? `${count(n)} sq ft` : null);
const far = (n) => (finite(n) ? Number(n).toFixed(2) : null);
const pct = (n, digits = 1) => (finite(n) ? signed(n, `${Math.abs(Number(n) * 100).toFixed(digits)}%`) : null);
const feet = (n) => (finite(n) ? `${count(n, 1)} ft` : null);
const rentSf = (n) => (finite(n) ? `$${Number(n).toFixed(2)}` : null);
const months = (range) => (Array.isArray(range) && range.length === 2 && finite(range[0]) && finite(range[1])
  ? (Number(range[1]) === 0 ? "None" : Number(range[0]) === Number(range[1]) ? `${range[0]} months` : `${range[0]} to ${range[1]} months`)
  : null);
const day = (at, style = "long") => {
  const d = new Date(typeof at === "number" ? at : String(at ?? ""));
  return Number.isNaN(d.getTime()) || !at ? null : d.toLocaleDateString("en-US", { month: style, day: "numeric", year: "numeric" });
};
// Record copy keeps its words; the report never prints an em dash.
const dashless = (s) => String(s ?? "").replace(/\s*\u2014\s*/g, ", ");
export const plain = (s) => dashless(s).trim();
const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const displayAddress = (text) => (text && text === text.toUpperCase() ? text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : text);
const BOROUGHS = { MN: "Manhattan", BX: "Bronx", BK: "Brooklyn", QN: "Queens", SI: "Staten Island" };
const BEDROOMS = (n) => (Number(n) === 0 ? "Studio" : `${n} bedroom`);

// ---------- Sources ----------
const FIELD_LABELS = {
  property: "Parcel record", publicRecords: "Public records", envelope: "Zoning envelope", entitlements: "Entitlement scenarios",
  assembly: "Site assembly", concepts: "Massing concepts", plans: "Floor plans", floorplanAudits: "Floor plan audits",
  market: "Market inputs", program: "Unit mix", proFormas: "Pro forma model", comparisons: "Program comparison", assumptions: "Your assumptions",
  keep: "Keep-the-building analysis",
};
const httpUrl = (url) => {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
};
// A title that is only the address reads as its domain and path.
function sourceTitle(source) {
  const url = httpUrl(source.url);
  const title = plain(source.title).replace(/\s*\(offset \d+\)$/, "");
  if (title && !/^https?:\/\//.test(title)) return title;
  if (!url) return title || "Untitled source";
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch {}
  return `${url.hostname.replace(/^www\./, "")}${path}`.replace(/\/$/, "");
}

// Every source the report cites, numbered once: the answer's own numbering first, then any
// record source the state names that the answer did not.
export function reportSources(answer, fields) {
  const list = [];
  const byUrl = new Map(), byTitle = new Map();
  // The answer cites by its own numbers, so each of its sources keeps an entry even when two share an address.
  const add = (s, id) => {
    const url = httpUrl(s.url)?.href || null;
    const key = url || `title:${plain(s.title)}`;
    const entry = { id, title: sourceTitle(s), url, domain: url ? new URL(url).hostname.replace(/^www\./, "") : null, kind: s.kind || null, retrieved: s.fetchedAt || s.retrievedAt || null };
    list.push(entry);
    if (!byUrl.has(key)) byUrl.set(key, entry);
    if (s.title && !byTitle.has(plain(s.title))) byTitle.set(plain(s.title), entry);
  };
  for (const s of answer?.sources || []) if (finite(s.id)) add(s, Number(s.id));
  let next = Math.max(0, ...list.map((s) => s.id)) + 1;
  for (const field of Object.values(fields)) {
    for (const s of field?.provenance?.sources || []) {
      if (!s.url && !s.title) continue;
      const url = httpUrl(s.url)?.href;
      if ((url && byUrl.has(url)) || (!url && byTitle.has(plain(s.title)))) continue;
      add(s, next++);
    }
  }
  const find = (s) => byUrl.get(httpUrl(s?.url)?.href) || (s?.title && byTitle.get(plain(s.title))) || null;
  return { list: list.sort((a, b) => a.id - b.id), find, has: (id) => list.some((s) => s.id === Number(id)) };
}

// ---------- Narrative ----------
// The answer's top-level sections go to the chapter their heading names; the first match wins,
// so the order runs from the most specific subject to the broadest.
const CHAPTER_RULES = [
  ["decision", /acquisition|decision|recommend|verdict|bottom line|conclusion/i],
  ["risks", /risk|tenan|occupan|diligence|environment|violation|litigation/i],
  ["entitlements", /entitle|approval|uap|mechanism|variance|rezon|ulurp|bonus/i],
  ["proforma", /pro ?forma|budget|residual|sensitiv|valuation|return|financ|capital|tax|485|abatement|exemption/i],
  ["program", /program|unit mix|apartment/i],
  ["site", /public record|parcel|record|deed|title|site/i],
  ["market", /market|comp|revenue|rent|sale|pricing|assumption|cost/i],
  ["build", /capacity|envelope|massing|build|floor area|physical|height|bulk|zoning|feasib/i],
];
const DECISION_LEAD = /^(acquisition position|recommendation|decision|bottom line|conclusion)\b/i;
const chapterOf = (title) => CHAPTER_RULES.find(([, re]) => re.test(title))?.[0] || null;
const leadText = (token) => (token.type === "paragraph" && token.tokens?.[0]?.type === "strong" ? token.tokens[0].text : "");

export function narrative(text) {
  const out = { lead: [], decision: [], chapters: {} };
  if (!text) return out;
  let current = null, chapter = "lead";
  for (const token of marked.lexer(text)) {
    if (token.type === "space" || token.type === "hr" || token.type === "html") continue;
    if (token.type === "heading" && token.depth === 1) continue;
    if (token.type === "paragraph" && /^as of\b/i.test(token.text) && chapter === "lead") continue;
    if (token.type === "heading" && token.depth === 2) {
      chapter = chapterOf(token.text) || (chapter === "lead" ? "build" : chapter);
      current = { title: plain(token.text), tokens: [] };
      if (chapter === "decision") out.decision.push(token);
      else (out.chapters[chapter] ||= []).push(current);
      continue;
    }
    if (DECISION_LEAD.test(leadText(token)) || chapter === "decision") out.decision.push(token);
    else if (chapter === "lead") out.lead.push(token);
    else current.tokens.push(token);
  }
  return out;
}

// ---------- Model ----------
const value = (fields, key) => fields[key]?.value ?? null;
const latestByName = (items) => {
  const out = new Map();
  for (const item of [...(items || [])].sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))) out.set(item.name || item.label, item);
  return [...out.values()];
};

// The site conversation's underwriting: its newest finished answer.
export function latestAnswer(conversation) {
  return [...(conversation?.messages || [])].reverse()
    .find((m) => m.role === "assistant" && !m.error && !m.interrupted && !m.projectUpdate && String(m.text || "").trim()) || null;
}

export function reportModel({ project, conversation = null, architecture = null, news = [], nearby = null, schemes = null }) {
  const fields = project.fields || {};
  const answer = latestAnswer(conversation);
  const property = value(fields, "property");
  const envelope = value(fields, "envelope");
  const comparison = (value(fields, "comparisons") || []).at(-1) || null;
  const decision = comparison?.decision || null;
  const recommended = comparison?.variants?.find((v) => v.label === (decision?.label || comparison?.recommendation?.label)) || null;
  // Schemes in the comparison's order, each with its latest pro forma.
  const proFormas = latestByName(value(fields, "proFormas"));
  const order = (comparison?.variants || []).map((v) => v.label);
  proFormas.sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99));
  const address = displayAddress(property?.address) || plain(project.title) || "Untitled site";
  const borough = BOROUGHS[property?.borough] || property?.borough || null;
  const updated = Math.max(0, ...Object.values(fields).map((f) => Number(f?.updated) || 0));
  // Once the options are priced, the cover gives the site page's answer: the leading option at today's
  // figures. The run's pro forma and decision stay as the records of the run that made them.
  const read = schemes?.schemes ? schemes : null;
  const lead = leadingScheme(read);
  const runAt = Math.max(0, ...["proFormas", "comparisons"].map((k) => Number(fields[k]?.updated) || 0)) || null;
  const stale = Object.entries(fields).filter(([key, f]) => FIELD_LABELS[key] && f?.stale)
    .map(([key, f]) => `${FIELD_LABELS[key]} needs a refresh after ${(FIELD_LABELS[f.stale] || "its inputs").toLowerCase()} changed.`);
  return {
    news,
    projectId: project.id,
    address,
    place: [borough, property?.zipcode].filter(Boolean).join(" "),
    bbl: property?.bbl || project.bbl || null,
    zoning: [property?.zonedist1, property?.zonedist2, property?.overlay1, property?.spdist1].filter(Boolean).join(", ") || envelope?.district || null,
    lotArea: property?.lotarea ?? envelope?.lot?.areaSqft ?? null,
    date: answer?.completedAt || answer?.created || updated || null,
    fields,
    property,
    envelope,
    comparison,
    decision,
    recommended,
    proFormas,
    answer,
    story: narrative(answer?.text),
    cards: (answer?.ui || []).filter((card) => card && !card.generating),
    sources: reportSources(answer, fields),
    architecture: architecture?.current ? architecture : null,
    nearby: nearby?.available ? nearby : null,
    schemes: read,
    lead,
    priced: lead ? snapshot(project, read) : null,
    differs: lead ? decisionDiffers(project, read) : null,
    runAt,
    stale,
  };
}

// ---------- DOM ----------
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}
const svgNode = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
const icon = (id) => {
  const svg = svgNode("svg", { "aria-hidden": "true" });
  svg.append(svgNode("use", { href: `#${id}` }));
  return svg;
};

// A citation is a numbered link to its entry in Sources.
function cite(sources, id) {
  if (!sources.has(id)) return null;
  return h("a", { class: "report-cite", href: `#report-source-${id}`, "data-report-anchor": `report-source-${id}`, "aria-label": `Source ${id}` }, String(id));
}
function citedText(text, sources) {
  const out = [];
  let last = 0;
  const value = dashless(text);
  for (const m of value.matchAll(/\[(\d{1,3})\]/g)) {
    const link = cite(sources, m[1]);
    if (!link) continue;
    out.push(value.slice(last, m.index).replace(/\s+$/, "\u2009"), link);
    last = m.index + m[0].length;
  }
  out.push(value.slice(last));
  return out.filter((part) => part !== "");
}

// Markdown tokens become native document content; no answer HTML reaches the page.
function inline(tokens = [], sources) {
  return tokens.flatMap((t) => {
    if (t.type === "strong") return [h("strong", {}, inline(t.tokens, sources))];
    if (t.type === "em") return [h("em", {}, inline(t.tokens, sources))];
    if (t.type === "del") return [h("s", {}, inline(t.tokens, sources))];
    if (t.type === "codespan") return [h("code", { text: t.text })];
    if (t.type === "br") return [h("br")];
    if (t.type === "link") {
      const url = httpUrl(t.href);
      return url ? [h("a", { href: url.href, target: "_blank", rel: "noopener" }, inline(t.tokens, sources))] : inline(t.tokens, sources);
    }
    if (t.type === "text" && t.tokens) return inline(t.tokens, sources);
    if (t.type === "html") return [];
    return citedText(t.type === "escape" ? t.text : t.text ?? t.raw ?? "", sources);
  });
}
const NUMERIC = /^[\s$()\u2212+\-~\u2248]*[\d.,]+\s*(%|[MKB]|x|\u00d7|SF|sq ft|ft|bps)?[\s)*]*$/i;
function block(token, sources, depth = 3) {
  if (token.type === "heading") return h(`h${Math.min(6, depth + token.depth - 2)}`, { class: "report-prose-head" }, inline(token.tokens, sources));
  if (token.type === "paragraph") return h("p", {}, inline(token.tokens, sources));
  if (token.type === "blockquote") return h("blockquote", {}, token.tokens.map((t) => block(t, sources, depth)));
  if (token.type === "code") return h("pre", {}, h("code", { text: token.text }));
  if (token.type === "list") {
    return h(token.ordered ? "ol" : "ul", {}, token.items.map((item) => h("li", {}, item.tokens.flatMap((t) => (t.type === "text" ? inline(t.tokens || [t], sources) : [block(t, sources, depth)])))));
  }
  if (token.type === "table") {
    const align = (i, cell) => token.align[i] === "right" || (token.align[i] !== "left" && i > 0 && NUMERIC.test(cell.text.replace(/\*\*/g, "")));
    const total = (row) => row[0] && /^\*\*/.test(row[0].text);
    return h("figure", { class: "report-table" },
      h("div", { class: "report-table-scroll" },
        h("table", {},
          h("thead", {}, h("tr", {}, token.header.map((c, i) => h("th", { class: align(i, c) ? "num" : null, scope: "col" }, inline(c.tokens, sources))))),
          h("tbody", {}, token.rows.map((row) => h("tr", { class: total(row) ? "is-total" : null }, row.map((c, i) => h(i === 0 ? "th" : "td", { class: align(i, c) ? "num" : null, scope: i === 0 ? "row" : null }, inline(c.tokens, sources)))))))));
  }
  return h("p", {}, citedText(token.text || "", sources));
}
const prose = (tokens, sources) => h("div", { class: "report-prose" }, tokens.map((t) => block(t, sources)));

// The record a figure came from: its producer, when it ran, its sources, and whether it is stale.
function sourceLine(model, key, extra = []) {
  const field = model.fields[key];
  if (!field || field.value === null || field.value === undefined) return null;
  const cites = (field.provenance?.sources || []).map((s) => model.sources.find(s)?.id).filter((id, i, all) => id && all.indexOf(id) === i);
  const parts = [h("span", {}, [FIELD_LABELS[key] || key, day(field.updated, "short")].filter(Boolean).join(", "))];
  for (const text of extra.filter(Boolean)) parts.push(h("span", { text: plain(text) }));
  const line = h("p", { class: "report-source-line" }, parts, cites.length ? h("span", { class: "report-cites" }, cites.map((id) => cite(model.sources, id))) : null);
  if (field.stale) line.append(h("span", { class: "report-stale", text: `Needs a refresh after ${(FIELD_LABELS[field.stale] || "its inputs").toLowerCase()} changed` }));
  return line;
}

// Adds the "How is this calculated?" link to a figure's source line; a missing line stays missing.
const withHelp = (line, slug) => (line ? (line.append(helpLink(slug)), line) : null);

// A financial or fact table: columns [{label, num}], rows [{cells, total, group, tone}].
function table({ columns, rows, caption = null, label = null }) {
  const body = rows.map((row) => {
    if (row.group) return h("tr", { class: "is-group" }, h("th", { colspan: String(columns.length), scope: "colgroup", text: row.group }));
    return h("tr", { class: row.total ? "is-total" : null }, row.cells.map((cell, i) => {
      const content = cell === null || cell === undefined || cell === "" ? "\u2013" : cell;
      const neg = !row.neutral && typeof content === "string" && content.startsWith(MINUS);
      return h(i === 0 ? "th" : "td", { class: [columns[i]?.num ? "num" : null, neg ? "is-neg" : null].filter(Boolean).join(" ") || null, scope: i === 0 ? "row" : null }, content);
    }));
  });
  return h("figure", { class: "report-table" },
    h("div", { class: "report-table-scroll" },
      h("table", { "aria-label": label },
        h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : null, scope: "col", text: c.label })))),
        h("tbody", {}, body))),
    caption);
}
// Label and value pairs with no empty entries.
function facts(pairs, className = "report-facts") {
  const shown = pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
  const figure = (v) => typeof v === "string" && /^[\u2212$\d]/.test(v);
  return shown.length ? h("dl", { class: className }, shown.map(([k, v, help]) => h("div", {}, h("dt", { text: k }, help ? helpLink(help, { icon: true }) : null), h("dd", { class: figure(v) ? "is-figure" : null }, v)))) : null;
}

// ---------- Massing drawing ----------
// Each storey is its footprint extruded from its floor elevation. The drawing is an isometric view
// from the front right corner; faces are painted far to near, storey by storey.
export function massingFloors(envelope, concept = null) {
  const fromStoreys = (envelope?.storeys || []).filter((s) => Array.isArray(s.footprint) && s.footprint.length > 2 && finite(s.heightFeet))
    .map((s) => ({ footprint: s.footprint, z: Number(s.floorElevationFeet) || 0, h: Number(s.heightFeet), label: s.label, area: s.areaSqft }));
  if (fromStoreys.length) return fromStoreys;
  const floors = [];
  let z = 0;
  for (const level of concept?.levels || envelope?.levels || []) {
    if (!Array.isArray(level.footprint) || level.footprint.length < 3 || !finite(level.height)) continue;
    for (let i = 0; i < (Number(level.count) || 1); i++) {
      floors.push({ footprint: level.footprint, z, h: Number(level.height), label: level.label });
      z += Number(level.height);
    }
  }
  return floors;
}

export function massingSvg(floors, lot = null, { limitFeet = null, width = 560 } = {}) {
  const iso = ([x, y], z) => [(x + y) * 0.866, (x - y) * 0.5 - z];
  const top = Math.max(...floors.map((f) => f.z + f.h));
  const limit = finite(limitFeet) && Number(limitFeet) > top && Number(limitFeet) < top * 3 ? Number(limitFeet) : null;
  const ground = lot?.length > 2 ? lot : floors[0].footprint;
  const pts = [...ground.map((p) => iso(p, 0)), ...floors.flatMap((f) => f.footprint.flatMap((p) => [iso(p, f.z), iso(p, f.z + f.h)])), ...(limit ? ground.map((p) => iso(p, limit)) : [])];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = (width - 150) / Math.max(1, maxX - minX, (maxY - minY) * 1.05);
  const P = (p, z) => { const [x, y] = iso(p, z); return [(x - minX) * k + 24, (y - minY) * k + 24]; };
  const path = (points) => "M" + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") + "Z";
  const height = (maxY - minY) * k + 48;
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height.toFixed(0)}`, class: "report-massing", role: "img" });
  svg.append(svgNode("path", { d: path(ground.map((p) => P(p, 0))), class: "m-lot" }));
  const area = (poly) => poly.reduce((s, [x, y], i) => { const [nx, ny] = poly[(i + 1) % poly.length]; return s + x * ny - nx * y; }, 0);
  for (const floor of [...floors].sort((a, b) => a.z - b.z)) {
    const poly = floor.footprint, ccw = area(poly) > 0;
    const faces = poly.map((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const [nx, ny] = ccw ? [q[1] - p[1], p[0] - q[0]] : [p[1] - q[1], q[0] - p[0]];
      return { p, q, nx, ny, depth: (p[0] + q[0]) / 2 - (p[1] + q[1]) / 2 };
    }).filter((f) => f.nx - f.ny > 0).sort((a, b) => a.depth - b.depth);
    for (const f of faces) {
      svg.append(svgNode("path", { d: path([P(f.p, floor.z), P(f.q, floor.z), P(f.q, floor.z + floor.h), P(f.p, floor.z + floor.h)]), class: Math.abs(f.nx) >= Math.abs(f.ny) ? "m-side" : "m-front" }));
    }
    svg.append(svgNode("path", { d: path(poly.map((p) => P(p, floor.z + floor.h))), class: "m-top" }));
  }
  // Height marks at the drawing's right edge: the modeled top and, when given, the height limit.
  const right = Math.max(...ground.map((p) => P(p, 0)[0]));
  const corner = ground.reduce((best, p) => (P(p, 0)[0] >= P(best, 0)[0] ? p : best));
  const mark = (z, text, cls) => {
    const [x, y] = P(corner, z);
    svg.append(svgNode("line", { x1: x + 6, y1: y, x2: right + 18, y2: y, class: `m-mark ${cls}` }));
    const label = svgNode("text", { x: right + 24, y: y + 4, class: `m-label ${cls}` });
    label.textContent = text;
    svg.append(label);
  };
  if (limit) {
    svg.append(svgNode("path", { d: path(ground.map((p) => P(p, limit))), class: "m-limit" }));
    mark(limit, `${count(limit, 1)} ft limit`, "is-limit");
  }
  mark(top, `${count(top, 1)} ft`, "is-top");
  return svg;
}

// ---------- Chapters ----------
const scheme = (name) => plain(name);
const toneOf = (call) => ({ supports_price: "success", below_price: "warning", no_land_value: "danger" }[call] || "info");
const CALLS = { supports_price: "Supports the price", below_price: "Below the asking price", no_land_value: "No land value" };

function chapter(id, title, ...content) {
  const body = content.flat().filter(Boolean);
  if (!body.length) return null;
  return h("section", { class: "report-chapter", id: `report-${id}`, "aria-labelledby": `report-${id}-title` }, h("h2", { id: `report-${id}-title`, text: title }), body);
}
const sub = (title, ...content) => {
  const body = content.flat().filter(Boolean);
  return body.length ? h("div", { class: "report-block" }, h("h3", { text: title }), body) : null;
};
const analysis = (model, key) => (model.story.chapters[key] || []).map((s) => h("div", { class: "report-block report-analysis" }, h("h3", { text: s.title }), prose(s.tokens, model.sources)));

// The cover from the priced options: the call and sentence the site page gives, then the leading option's terms.
function pricedCover(model) {
  const { lead, priced: s, envelope } = model;
  const buildable = envelope?.floorArea?.maxFloorAreaSqft ?? envelope?.capacity?.byUse?.residential?.maxFloorAreaSqft;
  const terms = [
    ["Land price", usd(s.landPrice)],
    [finite(envelope?.floorArea?.maxFar) ? `Buildable area at ${far(envelope.floorArea.maxFar)} FAR` : "Buildable area", sqft(buildable), "buildable-area"],
    // Where nearby development-site sales lead, they are the land value and the residual is what a
    // developer could pay; otherwise the residual is the land value.
    ...(s.nearby ? [["Land value, nearby sales", usd(s.nearby.value), "land-value"],
      ["Nearby sales", `${count(s.nearby.sales)} within ${count(s.nearby.radiusMiles, 1)} miles over ${s.nearby.months} months, adjusted to this lot: ${usd(s.nearby.perBuildableSqft)} per buildable sq ft`]] : []),
    [s.nearby ? "A developer can pay" : "Land value, what a developer can pay", usd(s.landValue), s.nearby ? null : "land-value"],
    ["Leading option", `${lead.label}: ${plain(lead.summary)}`],
    ["Value when built", usd(s.value)],
    ["Profit", usd(s.profit)],
    [s.margin ? sentence(s.margin.label) : "Margin", s.margin ? pct(s.margin.pct / 100) : null],
    ["Headroom to the price", finite(s.landPrice) ? usd(s.landValue - s.landPrice) : null],
    ["Deal tier", s.tier, "deal-tiers"],
    ["How the tier is set", s.tier && s.tierBasis ? sentence(tierBasisPhrase(s.tierBasis).replace(/^set on /, "")) : null],
  ];
  const verdict = h("div", { class: `report-verdict tone-${toneOf(s.call)}` },
    h("span", { class: "report-call" }, h("i", { "aria-hidden": "true" }), CALLS[s.call] || "Land value at your costs"),
    h("p", { class: "report-verdict-text", text: landAnswer(model.schemes) }));
  return { verdict, terms };
}

// Where the report's run records sit beside the priced cover: the run's date, and its own land figure when
// it differs from the options'.
function runNote(model) {
  if (!model.priced || !model.runAt || !(model.decision || model.proFormas.length)) return null;
  const then = model.differs?.maxLandPrice > 0 ? `put the land at up to ${usd(model.differs.maxLandPrice)}` : "found no land value";
  const moved = model.differs ? ` That run's comparison ${then}; regenerate the site to work it again on today's figures.` : "";
  return h("p", { class: "report-source-line report-run-note", text: `Recorded by the underwriting run of ${day(model.runAt)}. The cover and the three options are priced today at your costs.${moved}` });
}

function cover(model) {
  const { decision, recommended, envelope } = model;
  const pf = model.proFormas.find((p) => p.name === recommended?.label) || model.proFormas.at(-1) || null;
  const assumptions = value(model.fields, "assumptions");
  const landPrice = decision?.landPrice ?? assumptions?.landPrice ?? pf?.development?.landPrice;
  const buildable = envelope?.floorArea?.maxFloorAreaSqft ?? envelope?.capacity?.byUse?.residential?.maxFloorAreaSqft;
  const meta = [model.bbl && `BBL ${model.bbl}`, model.zoning, finite(model.lotArea) && `${sqft(model.lotArea)} lot`, model.place].filter(Boolean);
  const terms = [
    [decision ? "Land basis" : "Land price", usd(landPrice)],
    [finite(envelope?.floorArea?.maxFar) ? `Buildable area at ${far(envelope.floorArea.maxFar)} FAR` : "Buildable area", sqft(buildable), "buildable-area"],
    ["Recommended scheme", recommended ? scheme(recommended.label) : pf ? scheme(pf.name) : null],
    ["Stabilized value", usd(recommended?.value ?? pf?.returns?.value)],
    ["Profit", usd(recommended?.profitAfterCarry ?? recommended?.profit ?? pf?.returns?.profit)],
    ["Return on cost", pct(recommended?.unleveredReturnOnCost ?? pf?.returns?.unleveredReturnOnCost)],
    ["Residual land value", usd(decision?.maxLandPrice), "land-value"],
    ["Headroom to residual", usd(decision?.landHeadroom)],
  ];
  const priced = model.priced ? pricedCover(model) : null;
  const verdict = priced ? priced.verdict : decision
    ? h("div", { class: `report-verdict tone-${toneOf(decision.call)}` },
      h("span", { class: "report-call" }, h("i", { "aria-hidden": "true" }), CALLS[decision.call] || sentence(String(decision.call || "").replace(/_/g, " "))),
      h("p", { class: "report-verdict-text", text: plain(decision.verdict) }))
    : h("div", { class: "report-verdict tone-info" }, h("span", { class: "report-call" }, h("i", { "aria-hidden": "true" }), "Underwriting in progress"),
      h("p", { class: "report-verdict-text", text: "The acquisition decision has not run yet. Figures below cover the steps finished so far." }));
  return h("header", { class: "report-cover", id: "report-cover" },
    h("h1", { class: "report-title", id: "report-title", text: model.address }),
    h("p", { class: "report-doc", text: ["Development underwriting", day(model.date)].filter(Boolean).join(", ") }),
    meta.length ? h("p", { class: "report-meta", text: meta.join("  \u00b7  ") }) : null,
    verdict,
    facts(priced ? priced.terms : terms, "report-terms"),
    model.stale.length ? h("ul", { class: "report-stale-list" }, model.stale.map((s) => h("li", { text: s }))) : null,
    model.story.lead.length ? h("div", { class: "report-summary" }, prose(model.story.lead, model.sources)) : null);
}

function siteChapter(model) {
  const p = model.property;
  const r = value(model.fields, "publicRecords");
  const pluto = Boolean(p?.version);
  const none = (v) => (v ? plain(v) : pluto ? "None recorded" : null);
  const siteFacts = p && facts([
    ["Address", [model.address, model.place].filter(Boolean).join(", ")],
    ["BBL", p.bbl ? `${p.bbl}${p.block ? `, block ${p.block}, lot ${p.lot}` : ""}` : null],
    ["Zoning", model.zoning],
    ["Lot area", sqft(p.lotarea)],
    ["Frontage and depth", finite(p.lotfront) && finite(p.lotdepth) ? `${feet(p.lotfront)} by ${feet(p.lotdepth)}` : null],
    ["Existing building", [sqft(p.bldgarea), finite(p.numfloors) && `${count(p.numfloors, 1)} floors`, finite(p.numbldgs) && `${count(p.numbldgs)} ${Number(p.numbldgs) === 1 ? "building" : "buildings"}`].filter(Boolean).join(", ") || null],
    ["Built FAR", far(p.builtfar)],
    ["Residential FAR", far(p.residfar)],
    ["FAR with affordable housing", Number(p.affresfar) > 0 ? far(p.affresfar) : null],
    ["Community facility FAR", Number(p.facilfar) > 0 ? far(p.facilfar) : null],
    ["Commercial FAR", Number(p.commfar) > 0 ? far(p.commfar) : null],
    ["Year built", finite(p.yearbuilt) && Number(p.yearbuilt) > 0 ? String(p.yearbuilt) : null],
    ["Building class", p.bldgclass || null],
    ["Residential units", finite(p.unitsres) ? count(p.unitsres) : null],
    ["Landmark", none(p.landmark)],
    ["Historic district", none(p.histdist)],
    ["Special district", none(p.spdist1)],
    ["E-designation", none(p.edesignum)],
    ["Flood map", p.pfirm15_flag === "1" || p.firm07_flag === "1" ? "Inside a mapped flood zone" : null],
    ["Transit zone", p.transitzone ? plain(p.transitzone) : null],
  ]);
  const len = (a) => (Array.isArray(a) ? a.length : null);
  const ecb = r?.ecbViolationSummary, dob = r?.dobViolationSummary;
  const severity = (by) => Object.entries(by || {}).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ");
  const records = r && facts([
    ["DOB violations", dob?.available ? `${count(dob.openCount)} open of ${count(dob.returnedCount)}` : null],
    ["ECB violations", ecb?.available ? [`${count(ecb.openCount)} open of ${count(ecb.returnedCount)}`, severity(ecb.openBySeverity), finite(ecb.totalBalanceDue) && `${usd(ecb.totalBalanceDue)} due`].filter(Boolean).join(", ") : null],
    ["HPD violations", r.hpdViolationSummary ? `${count(r.hpdViolationSummary.openInSample)} open in sample` : null],
    ["HPD registration", r.hpdRegistration ? (r.hpdRegistration.registeredMultipleDwelling ? "Registered multiple dwelling" : "Not registered") : null],
    ["Rent stabilized units", r.rentStabilizedUnits ? (finite(r.rentStabilizedUnits.units) ? count(r.rentStabilizedUnits.units) : "Not in the counts file") : null],
    ["Certificates of occupancy", len(r.certificatesOfOccupancy) !== null ? count(len(r.certificatesOfOccupancy)) : null],
    ["DOB filings", len(r.dobBisFilings) !== null || len(r.dobNowFilings) !== null ? count((len(r.dobBisFilings) || 0) + (len(r.dobNowFilings) || 0)) : null],
    ["Recorded instruments on the lot", len(r.subjectLotInstruments) !== null ? count(len(r.subjectLotInstruments)) : null],
    ["Air rights or easement instruments on the block", len(r.submittalForensics?.airRightsOrEasementInstruments) !== null ? count(len(r.submittalForensics.airRightsOrEasementInstruments)) : null],
    ["Affordable housing projects", len(r.hpdAffordableProjects) !== null ? count(len(r.hpdAffordableProjects)) : null],
    ["Nearby landmarks", len(r.nearbyLpcLandmarks) !== null ? count(len(r.nearbyLpcLandmarks)) : null],
  ]);
  const open = (ecb?.recentViolations || []).filter((v) => !/resolve|dismiss|close/i.test(`${v.status} ${v.hearingStatus}`));
  const violations = open.length ? table({
    label: "Open violations",
    columns: [{ label: "Violation" }, { label: "Severity" }, { label: "Issued" }, { label: "Balance", num: true }, { label: "Description" }],
    rows: open.map((v) => ({ cells: [v.ecbViolationNumber, v.severity, day(v.issueDate, "short"), usd(v.balanceDue), sentence(String(v.description || "").toLowerCase())] })),
  }) : null;
  return chapter("site", "Site and records",
    sub("Parcel", siteFacts, sourceLine(model, "property")),
    sub("Public records", records, violations, sourceLine(model, "publicRecords")),
    model.news.length ? sub("In the news", newsList(model.news, "report-news")) : null,
    nearbyDevelopment(model),
    analysis(model, "site"));
}

function buildChapter(model) {
  const e = model.envelope;
  const c = e?.controls || {}, s = e?.summary || {};
  const envelopeFacts = e && facts([
    ["District", [e.district, e.form && `${e.form} form`].filter(Boolean).join(", ")],
    ["Maximum FAR", far(e.floorArea?.maxFar)],
    ["Maximum floor area", sqft(e.floorArea?.maxFloorAreaSqft)],
    ["Modeled massing", [finite(e.metrics?.storeys) && `${e.metrics.storeys} storeys`, feet(e.metrics?.heightFeet), sqft(e.metrics?.floorAreaSqft)].filter(Boolean).join(", ") || null],
    ["Limited by", e.metrics?.stoppedBy ? sentence(plain(e.metrics.stoppedBy)) : null],
    ["Lot coverage", finite(c.coverage?.basePercent ?? s.maxLotCoveragePercent) ? `${c.coverage?.basePercent ?? s.maxLotCoveragePercent}%` : null],
    ["Base height", finite(s.baseHeightMinFeet) && finite(s.baseHeightMaxFeet) ? `${feet(s.baseHeightMinFeet)} to ${feet(s.baseHeightMaxFeet)}` : null],
    ["Maximum height", feet(c.heightLimitFeet ?? s.maxBuildingHeightFeet)],
    ["Rear yard", feet(c.yards?.rearYard?.requiredFeet ?? s.rearYardFeet)],
    ["Setback above base", finite(c.setbacks?.depthFeet?.narrow) ? `${feet(c.setbacks.depthFeet.narrow)} on a narrow street, ${feet(c.setbacks.depthFeet.wide)} on a wide street` : finite(s.setbackDepthFeet) ? feet(s.setbackDepthFeet) : null],
    ["Dwelling units", finite(e.density?.maxUnits ?? s.maxDwellingUnits) ? `Up to ${count(e.density?.maxUnits ?? s.maxDwellingUnits)}${finite(e.density?.dwellingUnitFactor) ? ` at a ${e.density.dwellingUnitFactor} sq ft factor` : ""}` : null],
    ["Parking required", finite(e.parking?.required) ? (Number(e.parking.required) === 0 ? "None" : `${e.parking.required} spaces`) : null],
  ]);
  const cap = e?.capacity;
  const uses = cap ? [
    ...Object.entries(cap.byUse || {}).map(([use, u]) => ({ cells: [sentence(use.replace(/([A-Z])/g, " $1").toLowerCase()), far(u.maxFar), sqft(u.maxFloorAreaSqft), sqft(u.remainingFloorAreaSqft)] })),
    ...(cap.qualifyingAffordableOrUap ? [{ cells: ["Residential with qualifying affordable housing", far(cap.qualifyingAffordableOrUap.maxFar), sqft(cap.qualifyingAffordableOrUap.maxFloorAreaSqft), sqft(cap.qualifyingAffordableOrUap.remainingFloorAreaSqft)] }] : []),
  ] : [];
  const capacity = uses.length ? table({ label: "Capacity by use", columns: [{ label: "Use" }, { label: "FAR", num: true }, { label: "Floor area", num: true }, { label: "Remaining", num: true }], rows: uses }) : null;
  const lot = model.property?.lotarea ?? cap?.lotAreaSqft;
  const schemes = model.proFormas.length ? table({
    label: "Schemes underwritten",
    columns: [{ label: "Scheme" }, { label: "Gross area", num: true }, { label: "Gross FAR", num: true }, { label: "Units", num: true }],
    rows: model.proFormas.map((p) => {
      const gross = p.inputs?.program?.grossBuildingSqft;
      const units = p.operations?.unitCount ?? (p.inputs?.program?.units?.length ? p.inputs.program.units.reduce((n, u) => n + (Number(u.count) || 0), 0) : null);
      return { cells: [scheme(p.name), sqft(gross), finite(gross) && finite(lot) ? far(gross / lot) : null, count(units)] };
    }),
  }) : null;
  const concepts = value(model.fields, "concepts") || [];
  const conceptTable = concepts.length ? table({
    label: "Massing concepts",
    columns: [{ label: "Concept" }, { label: "Storeys", num: true }, { label: "Height", num: true }, { label: "Gross area", num: true }, { label: "FAR", num: true }, { label: "Units", num: true }, { label: "Compliance" }],
    rows: concepts.map((k) => ({ cells: [plain(k.name), count(k.metrics?.storeys), feet(k.metrics?.heightFeet), sqft(k.metrics?.grossFloorAreaSqft), far(k.metrics?.far), count(k.metrics?.units),
      k.compliance ? (k.compliance.compliant ? "Complies" : plain(k.compliance.violations?.[0]?.reason || "Does not comply")) : null] })),
  }) : null;
  const floors = massingFloors(e, concepts.at(-1));
  const massing = floors.length ? h("figure", { class: "report-figure" },
    h("div", { class: "report-massing-wrap" }, (() => {
      const svg = massingSvg(floors, e?.lot?.polygon, { limitFeet: c.heightLimitFeet ?? s.maxBuildingHeightFeet });
      svg.setAttribute("aria-label", `Massing of ${floors.length} storeys reaching ${count(Math.max(...floors.map((f) => f.z + f.h)), 1)} feet`);
      return svg;
    })(),
    table({ label: "Floor plates", columns: [{ label: "Level" }, { label: "Plate", num: true }, { label: "Floor", num: true }], rows: floors.map((f) => ({ cells: [plain(f.label), sqft(f.area), feet(f.z)] })) })),
    h("figcaption", { text: "Modeled envelope. Plates are gross footprint areas, not zoning floor area." })) : null;
  return chapter("build", "What you can build",
    sub("Zoning envelope", envelopeFacts, withHelp(sourceLine(model, "envelope"), "buildable-area")),
    massing,
    sub("Capacity by use", capacity),
    sub("Schemes underwritten", schemes, schemes ? sourceLine(model, "proFormas") : null),
    sub("Massing concepts", conceptTable, conceptTable ? sourceLine(model, "concepts") : null),
    floorPlan(model),
    analysis(model, "build"));
}

// The three ways to build the site, as on the site page.
function schemesChapter(model) {
  return chapter("schemes", "Three ways to build it", schemesReportBlock(model.schemes, { projectId: model.projectId, concepts: value(model.fields, "concepts") || [] }));
}

function floorPlan(model) {
  const current = model.architecture?.current;
  if (!current?.plan) return null;
  const url = (a) => `/api/projects/${encodeURIComponent(model.projectId)}/architecture/artifacts/${encodeURIComponent(a.id)}`;
  const job = [...(current.jobs || [])].filter((j) => j.status === "succeeded").sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const preview = job?.artifacts?.find((a) => a.kind === "preview");
  const plan = current.artifacts?.find((a) => a.kind === "svg");
  const images = [plan && h("img", { src: url(plan), alt: `Floor plan, ${plain(current.plan.name)}`, loading: "lazy" }), preview && h("img", { src: url(preview), alt: "Rendered view of the floor plan", loading: "lazy" })].filter(Boolean);
  return sub("Floor plan",
    images.length ? h("div", { class: "report-plan-images" }, images) : null,
    facts([["Plan", plain(current.plan.name)], ["Revision", finite(current.revision) ? String(current.revision) : null], ["Levels", count(current.plan.levels?.length)], ["Rooms", count(current.plan.rooms?.length)]]));
}

function programChapter(model) {
  const program = value(model.fields, "program");
  const mix = program?.byBedrooms?.length ? table({
    label: "Unit mix",
    columns: [{ label: "Unit type" }, { label: "Mix", num: true }, { label: "Units", num: true }, { label: "Size", num: true }, { label: "Rent per sq ft", num: true }, { label: "Monthly rent", num: true }, { label: "Annual rent", num: true }],
    rows: [...program.byBedrooms.map((b) => ({ cells: [plain(b.label) || BEDROOMS(b.bedrooms), finite(b.mixPercent) ? `${b.mixPercent}%` : null, count(b.units), sqft(b.unitSqft), rentSf(b.rentPerSqftPerMonth), usd(b.monthlyRent), usd(b.annualRent)] })),
      { total: true, cells: ["Total", null, count(program.units), sqft(program.netResidentialSqft), rentSf(program.blendedRentPerSqftPerMonth), null, usd(program.annualGrossPotentialRent ?? program.grossSellout)] }],
  }) : null;
  const programFacts = program && facts([
    ["Product", program.productType ? sentence(program.productType) : null],
    ["Residential gross area", sqft(program.residentialGrossSqft)],
    ["Efficiency", pct(program.efficiency, 0)],
    ["Net residential area", sqft(program.netResidentialSqft)],
    ["Average unit", sqft(program.averageUnitSqft)],
  ]);
  const lines = model.proFormas.filter((p) => p.operations?.lines?.length);
  const byScheme = lines.length ? table({
    label: "Unit mix by scheme",
    columns: [{ label: "Unit type" }, { label: "Units", num: true }, { label: "Net area", num: true }, { label: "Rent per sq ft", num: true }, { label: "Annual rent", num: true }, { label: "Basis" }],
    rows: lines.flatMap((p) => [{ group: scheme(p.name) }, ...p.operations.lines.map((l) => ({ cells: [plain(l.line), count(l.units), sqft(l.netSqft), rentSf(l.rentPerSqftPerMonth), usd(l.annualRent), plain(l.source)] }))]),
  }) : null;
  return chapter("program", "Program and unit mix",
    sub("Program", programFacts, mix, program ? sourceLine(model, "program", program.assumptions || []) : null),
    sub("Unit mix by scheme", byScheme, byScheme ? sourceLine(model, "proFormas") : null),
    analysis(model, "program"));
}

// DOB new buildings and major alterations around the site, the largest first.
function nearbyDevelopment(model) {
  const read = model.nearby;
  if (!read) return null;
  const jobLink = (p) => h("a", { href: p.link, target: "_blank", rel: "noopener noreferrer", text: p.jobNumber });
  const projects = read.projects.slice(0, 8);
  return sub("Nearby development",
    [nearbySummary(read), stageLine(read.nearby), tenureLine(read.nearby), zipLine(read)].filter(Boolean).map((text) => h("p", { text })),
    projects.length ? table({
      label: "Nearby development",
      columns: [{ label: "Address" }, { label: "DOB job" }, { label: "Work" }, { label: "Stage" }, { label: "Units", num: true }, { label: "Floor area", num: true }, { label: "Held as" }, { label: "Distance", num: true }],
      rows: projects.map((p) => ({ cells: [p.address || `BBL ${p.bbl}`, jobLink(p), p.newBuilding ? "New building" : "Major alteration", STAGES[p.stage] || p.status, p.units > 0 ? count(p.units) : null, p.floorArea > 0 ? area(p.floorArea) : null, TENURE[p.tenure] || "Not on record", `${p.distanceMiles.toFixed(2)} mi`] })),
    }) : null,
    h("p", { class: "report-source-line", text: `${asOf(read)} Rental or condo shows only where an HPD affordable housing record or an ACRIS condo declaration says so.` }));
}

function marketChapter(model) {
  const market = value(model.fields, "market");
  const citeFor = (row) => { const s = model.sources.find(row); return s ? cite(model.sources, s.id) : plain(row.source) || null; };
  const rents = market?.rents?.length ? table({
    label: "Rents",
    columns: [{ label: "Unit type" }, { label: "Rent per sq ft a month", num: true }, { label: "Basis" }, { label: "Source" }],
    rows: market.rents.map((r) => ({ cells: [BEDROOMS(r.bedrooms), rentSf(r.rentPerSqftPerMonth), plain(r.basis), citeFor(r)] })),
  }) : null;
  const sales = market?.salePrices?.length ? table({
    label: "Sale prices",
    columns: [{ label: "Unit type" }, { label: "Price per sq ft", num: true }, { label: "Basis" }, { label: "Source" }],
    rows: market.salePrices.map((r) => ({ cells: [BEDROOMS(r.bedrooms), usd(r.pricePerSqft), plain(r.basis), citeFor(r)] })),
  }) : null;
  const supply = market && facts([
    ["Submarket", market.submarket ? plain(market.submarket) : null],
    ["Supply", finite(market.supply?.units) ? `${count(market.supply.units)} units` : null],
    ["Vacancy", pct(market.supply?.vacancyRate)],
  ]);
  // The underwriting inputs: your saved assumptions, or the latest pro forma's own inputs.
  const own = value(model.fields, "assumptions");
  const inputs = own || model.proFormas.at(-1)?.inputs || null;
  const f = inputs?.financing || {}, o = inputs?.operating || {};
  const inputFacts = inputs && facts([
    ["Land price", usd(inputs.landPrice)],
    ["Hard cost", finite(inputs.hardCostPerSqft) ? `${usd(inputs.hardCostPerSqft)} per gross sq ft` : null],
    ["Soft cost", finite(inputs.softCostPerSqft) ? `${rentSf(inputs.softCostPerSqft)} per gross sq ft` : null],
    ["Loan to cost", pct(f.loanToCost, 0)],
    ["Interest rate", pct(f.interestRate, 2)],
    ["Construction term", finite(f.termMonths) ? `${f.termMonths} months` : null],
    ["Residential vacancy", pct(o.residentialVacancyRate)],
    ["Operating expenses", finite(o.residentialOpexPerUnitPerYear) ? `${usd(o.residentialOpexPerUnitPerYear)} per unit a year` : null],
    ["Commercial vacancy", Number(o.commercialVacancyRate) > 0 ? pct(o.commercialVacancyRate) : null],
    ["Cap rate", pct(inputs.capRate, 2)],
    ["Selling costs", pct(inputs.sellingCostRate)],
  ]);
  return chapter("market", "Market inputs and comparables",
    sub("Rents", rents),
    sub("Sale prices", sales),
    supply || rents || sales ? sourceLine(model, "market") : null,
    supply,
    sub("Underwriting assumptions", inputFacts, inputFacts ? sourceLine(model, own ? "assumptions" : "proFormas") : null),
    analysis(model, "market"));
}

function proformaChapter(model) {
  const variants = model.comparison?.variants || [];
  const returns = variants.length ? table({
    label: "Returns by scheme",
    columns: [{ label: "" }, ...variants.map((v) => ({ label: scheme(v.label), num: true }))],
    rows: [
      ["Land basis", (v) => usd(v.landPrice)],
      ["Total development cost", (v) => usd(v.totalDevelopmentCostAfterCarry ?? v.totalDevelopmentCost)],
      ["Net operating income", (v) => usd(v.noi)],
      ["Stabilized value", (v) => usd(v.value)],
      ["Profit", (v) => usd(v.profitAfterCarry ?? v.profit), true],
      ["Return on cost", (v) => pct(v.unleveredReturnOnCost)],
      ["Yield on cost", (v) => pct(v.yieldOnCostAfterCarry ?? v.yieldOnCost, 2)],
      ["Levered return on equity", (v) => pct(v.leveredReturnOnEquity)],
      ["Equity multiple", (v) => (finite(v.equityMultiple) ? `${Number(v.equityMultiple).toFixed(2)}x` : null)],
      ["Residual land value", (v) => usd(v.maxLandPrice)],
      ["Headroom to residual", (v) => usd(v.landHeadroom)],
      ["Rent change that reaches the hurdle", (v) => pct(v.requiredRevenueChange), false, true],
      ["Profit with rents 10% lower", (v) => usd(v.downsideRentMinus10Profit)],
    ].filter(([, get]) => variants.some((v) => get(v) !== null)).map(([label, get, total, neutral]) => ({ total, neutral, cells: [label, ...variants.map(get)] })),
  }) : null;
  const pfs = model.proFormas;
  const budget = pfs.length ? table({
    label: "Pro forma by scheme",
    columns: [{ label: "" }, ...pfs.map((p) => ({ label: scheme(p.name), num: true }))],
    rows: [
      { group: "Development budget" },
      ["Land", (p) => usd(p.development?.landPrice)],
      ["Hard cost", (p) => usd(p.development?.hardCost)],
      ["Soft cost", (p) => usd(p.development?.softCost)],
      ["Financing carry", (p) => usd(p.development?.interestCarry)],
      ["Total development cost", (p) => usd(p.development?.totalDevelopmentCost), true],
      ["Cost per gross sq ft", (p) => usd(p.development?.costPerGrossSqft)],
      ["Loan", (p) => usd(p.development?.loan)],
      ["Equity", (p) => usd(p.development?.equity)],
      { group: "Stabilized operations" },
      ["Gross potential rent", (p) => usd(p.operations?.grossPotentialRent)],
      ["Vacancy", (p) => (finite(p.operations?.vacancyLoss) ? usd(-p.operations.vacancyLoss) : null)],
      ["Effective gross income", (p) => usd(p.operations?.effectiveGrossIncome)],
      ["Operating expenses", (p) => (finite(p.operations?.operatingExpenses) ? usd(-p.operations.operatingExpenses) : null)],
      ["Net operating income", (p) => usd(p.operations?.noi), true],
      ["Yield on cost", (p) => pct(p.operations?.yieldOnCost, 2)],
      ["Cap rate", (p) => pct(p.operations?.capRate, 2)],
      { group: "Returns" },
      ["Stabilized value", (p) => usd(p.returns?.value)],
      ["Profit", (p) => usd(p.returns?.profit), true],
      ["Return on cost", (p) => pct(p.returns?.unleveredReturnOnCost)],
      ["Levered return on equity", (p) => pct(p.returns?.leveredReturnOnEquity)],
      ["Debt service coverage", (p) => (finite(p.returns?.debtServiceCoverage) ? `${Number(p.returns.debtServiceCoverage).toFixed(2)}x` : null)],
    ].filter((row) => row.group || pfs.some((p) => row[1](p) !== null)).map((row) => (row.group ? row : { total: row[2], cells: [row[0], ...pfs.map(row[1])] })),
  }) : null;
  // Where the comparison and a scheme's own pro forma disagree on total cost, say which one decides.
  const differs = pfs.filter((p) => {
    const v = variants.find((x) => x.label === p.name);
    return v && finite(v.totalDevelopmentCost) && finite(p.development?.totalDevelopmentCost) && Math.round(v.totalDevelopmentCost) !== Math.round(p.development.totalDevelopmentCost);
  });
  const financing = pfs.at(-1)?.inputs?.financing;
  const terms = [financing && finite(financing.loanToCost) ? `${pct(financing.loanToCost, 0)} loan to cost at ${pct(financing.interestRate, 2)} over ${financing.termMonths} months` : null,
    differs.length ? `Total costs here differ from the program comparison for ${differs.length === 1 ? "one scheme" : `${differs.length} schemes`}; the comparison sets the decision` : null];
  // Sensitivity: profit under each recorded shock, scheme by scheme.
  const scenarios = [];
  for (const p of pfs) for (const [, list] of Object.entries(p.sensitivity || {})) for (const row of list || []) {
    if (!scenarios.includes(row.scenario)) scenarios.push(row.scenario);
  }
  const shock = (p, name) => Object.values(p.sensitivity || {}).flat().find((r) => r?.scenario === name);
  const sens = scenarios.length > 1 ? table({
    label: "Sensitivity",
    columns: [{ label: "Scenario" }, ...pfs.map((p) => ({ label: scheme(p.name), num: true }))],
    rows: ["base", ...scenarios.filter((s) => s !== "base")].filter((s) => scenarios.includes(s)).map((name) => ({
      total: name === "base",
      cells: [name === "base" ? "Base case" : sentence(plain(name)), ...pfs.map((p) => {
        const r = shock(p, name);
        return r ? h("span", { class: `report-sens${Number(r.profit) < 0 ? " is-neg" : ""}` }, usd(r.profit), h("small", { text: pct(r.unleveredReturnOnCost) })) : null;
      })],
    })),
  }) : null;
  const cards = model.cards.length && typeof model.mountCard === "function"
    ? h("div", { class: "report-block report-cards" }, h("h3", { text: "Interactive model" }), model.cards.map((card, i) => model.mountCard(card, `report:${model.answer.id}:${i}`)))
    : null;
  return chapter("proforma", "Pro forma",
    returns || budget ? runNote(model) : null,
    sub("Returns by scheme", returns, returns ? sourceLine(model, "comparisons", [model.comparison?.note]) : null),
    sub("Development budget and operations", budget, budget ? withHelp(sourceLine(model, "proFormas", terms), "budget") : null),
    sub("Sensitivity", sens, sens ? h("p", { class: "report-source-line", text: "Profit, with return on cost beneath, under each shock to the pro forma." }) : null),
    cards,
    analysis(model, "proforma"));
}

function entitlementChapter(model) {
  const ent = value(model.fields, "entitlements");
  const base = ent?.baseline;
  const baseline = base && facts([
    ["Governing FAR", far(base.governingFar)],
    ["Maximum floor area", sqft(base.maxFloorAreaSqft)],
    ["Existing floor area", sqft(base.existingFloorAreaSqft)],
    ["Remaining as of right", sqft(base.remainingFloorAreaSqft)],
    ["Greatest FAR by any path", far(base.greatestFar)],
  ]);
  const scenarios = ent?.scenarios || [];
  const APPROVAL = { "as-of-right": "As of right", elurp: "ELURP", ulurp: "ULURP", variance: "BSA variance", "special-permit": "Special permit", certification: "Certification" };
  const paths = scenarios.length ? table({
    label: "Paths to more floor area",
    columns: [{ label: "Path" }, { label: "Approval" }, { label: "FAR", num: true }, { label: "Floor area", num: true }, { label: "Added", num: true }, { label: "Time" }, { label: "Risk" }],
    rows: scenarios.map((s) => ({ cells: [plain(s.name), APPROVAL[s.approval] || sentence(plain(s.approval)), far(s.resultingFar), sqft(s.totalFloorAreaSqft), sqft(s.addedFloorAreaSqft), months(s.timeMonths), s.risk ? sentence(s.risk) : null] })),
  }) : null;
  const conditions = scenarios.filter((s) => s.conditions?.length).map((s) => h("div", { class: "report-path" },
    h("h4", { text: plain(s.name) }),
    h("ul", {}, s.conditions.map((c) => h("li", { text: plain(c) }))),
    s.citations?.length ? h("p", { class: "report-source-line", text: s.citations.map(plain).join("; ") }) : null));
  return chapter("entitlements", "Entitlement path",
    sub("Baseline", baseline),
    sub("Paths to more floor area", paths, paths ? sourceLine(model, "entitlements", [ent.note]) : null),
    conditions.length ? sub("Conditions by path", conditions) : null,
    analysis(model, "entitlements"));
}

function riskChapter(model) {
  const checks = [...(model.envelope?.checks || []), ...(model.comparison?.unpricedApprovalTiming || []).map((v) => `${plain(v.label || v)}: approval time is not priced.`)];
  return chapter("risks", "Risks and open diligence",
    analysis(model, "risks"),
    checks.length || model.stale.length ? sub("Model checks", h("ul", { class: "report-list" }, [...model.stale, ...checks].map((c) => h("li", { text: plain(c) })))) : null);
}

function decisionChapter(model) {
  const { decision, comparison } = model;
  const changes = comparison?.recommendation?.whatWouldChangeIt || [];
  return chapter("decision", "Decision",
    decision ? runNote(model) : null,
    decision ? h("div", { class: `report-decision tone-${toneOf(decision.call)}` },
      h("span", { class: "report-call" }, h("i", { "aria-hidden": "true" }), CALLS[decision.call] || sentence(String(decision.call || "").replace(/_/g, " "))),
      h("p", { text: plain(decision.verdict) }),
      facts([["Scheme", scheme(decision.label)], ["Land basis", usd(decision.landPrice)], ["Residual land value", usd(decision.maxLandPrice), "land-value"], ["Target return on cost", pct(decision.targetReturnOnCost, 0)]])) : null,
    model.story.decision.length ? prose(model.story.decision, model.sources) : null,
    changes.length ? sub("What would change it", h("ul", { class: "report-list" }, changes.map((c) => h("li", { text: plain(c) })))) : null);
}

// Keeping the building as it stands: the way that pays the most, then each way's figures side by side.
function keepChapter(model) {
  const keep = value(model.fields, "keep");
  if (!keep) return null;
  const ways = (keep.strategies || []).filter((s) => s.priced);
  const row = (label, read) => ({ cells: [label, ...ways.map(read)] });
  const grid = ways.length ? table({
    label: "Ways to keep the building",
    columns: [{ label: "" }, ...ways.map((w) => ({ label: w.label, num: true }))],
    rows: [
      row("Highest price at the target", (w) => usd(w.maxPrice) ?? "None"),
      row("All-in cost", (w) => usd(w.allIn)),
      row("Net operating income", (w) => usd(w.noi)),
      row("Value or sale price", (w) => usd(w.id === "renovate_sell" ? w.salePrice : w.value)),
      row("Value over cost, or profit", (w) => usd(w.id === "renovate_sell" ? w.profit : w.valueCreated)),
      row("Cash flow after debt service", (w) => usd(w.cashFlow)),
      row("Debt coverage", (w) => (finite(w.dscr) ? `${Number(w.dscr).toFixed(2)}x` : null)),
      row("Highest price in the joint downside", (w) => usd(w.downside?.maxPrice) ?? "None"),
    ],
  }) : null;
  const list = (items) => h("ul", { class: "report-list" }, items.map((c) => h("li", { text: plain(c) })));
  return chapter("keep", "Keeping the building",
    keep.decision?.verdict ? h("p", { text: plain(keep.decision.verdict) }) : null,
    grid, sourceLine(model, "keep", [keep.derived ? "repriced with your numbers" : null]),
    (keep.strategies || []).filter((s) => !s.priced).map((s) => h("p", { class: "report-source-line", text: `${s.label}: not priced. ${plain(s.reason)}` })),
    keep.whatWouldChangeIt?.length ? sub("What would change it", list(keep.whatWouldChangeIt)) : null,
    keep.notes?.length ? sub("Assumptions and limits", list(keep.notes)) : null);
}

function sourcesChapter(model) {
  if (!model.sources.list.length) return null;
  const KINDS = { property: "Parcel record", official_record: "Official record", zoning_envelope: "Zoning", zoning_text: "Zoning text", entitlement_scenarios: "Zoning", comp_dataset: "Market data", research: "Research", market: "Market data", zoning: "Zoning" };
  return chapter("sources", "Sources", h("p", { class: "report-source-line" }, helpLink("sources-and-freshness")), h("ol", { class: "report-sources" }, model.sources.list.map((s) => h("li", { id: `report-source-${s.id}` },
    h("span", { class: "report-source-n", text: String(s.id) }),
    h("div", {},
      s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", text: s.title }) : h("span", { text: s.title }),
      h("small", { text: [s.domain, KINDS[s.kind] || (s.kind ? sentence(s.kind.replace(/_/g, " ")) : null), s.retrieved && `retrieved ${day(s.retrieved, "short")}`].filter(Boolean).join(", ") }))))));
}

const CONTENTS = [["site", "Site and records"], ["build", "What you can build"], ["schemes", "Three ways to build it"], ["program", "Program and unit mix"], ["market", "Market inputs and comparables"],
  ["proforma", "Pro forma"], ["entitlements", "Entitlement path"], ["risks", "Risks and open diligence"], ["decision", "Decision"], ["keep", "Keeping the building"], ["sources", "Sources"]];

export function renderReport(model, { onBack = null, onShare = null, mountCard = null } = {}) {
  model.mountCard = mountCard;
  const chapters = [siteChapter(model), buildChapter(model), schemesChapter(model), programChapter(model), marketChapter(model), proformaChapter(model), entitlementChapter(model), riskChapter(model), decisionChapter(model), keepChapter(model), sourcesChapter(model)].filter(Boolean);
  const present = new Set(chapters.map((c) => c.id.replace(/^report-/, "")));
  const toc = h("nav", { class: "report-toc", "aria-label": "Report contents" },
    h("ol", {}, CONTENTS.filter(([id]) => present.has(id)).map(([id, title]) => h("li", {}, h("a", { href: `#report-${id}`, "data-report-anchor": `report-${id}`, text: title })))));
  const back = h("a", { class: "report-back", href: `/sites/${encodeURIComponent(model.projectId)}` }, icon("chevron"), h("span", { text: model.address }));
  if (onBack) back.addEventListener("click", (e) => { e.preventDefault(); onBack(); });
  const status = h("span", { class: "report-action-status", role: "status", "aria-live": "polite" });
  const share = h("button", { class: "report-action", type: "button" }, icon("share"), "Share");
  const pdf = h("button", { class: "report-action primary", type: "button" }, icon("down"), "Download PDF");
  share.addEventListener("click", async () => { status.textContent = onShare ? await onShare() : ""; });
  pdf.addEventListener("click", () => window.print());
  const root = h("article", { class: "report", "aria-labelledby": "report-title" },
    h("div", { class: "report-bar" }, h('nav',{'aria-label':'Breadcrumb',class:'page-breadcrumbs'},h('a',{href:'/sites','data-route':'/sites',text:'Sites'}),' / ',back,' / ',h('span',{'aria-current':'page',text:'Report'})), h("div", { class: "report-actions" }, status, share, pdf)),
    cover(model),
    h("div", { class: "report-body" }, toc, h("div", { class: "report-main" }, chapters)),
    h("footer", { class: "report-foot" }, h("p", { text: "Prepared with Arosa from public records and the stated assumptions. Feasibility estimates, not an appraisal or a legal opinion." })));
  // In-page links scroll the report itself, so the address and the app's history stay put.
  root.addEventListener("click", (e) => {
    const link = e.target.closest?.("[data-report-anchor]");
    if (!link) return;
    e.preventDefault();
    root.querySelector(`#${link.dataset.reportAnchor}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  });
  return root;
}

// The report's shape while it loads: the action bar, the cover with its verdict and terms, then
// the first chapter's opening lines.
export function reportSkeleton() {
  const root = h("div", { class: "report report-skeleton", "aria-hidden": "true" });
  const terms = h("div", { class: "report-terms" });
  for (let i = 0; i < 8; i++) terms.append(h("div", {}, skel("skel-text", { width: "56%", height: "11px" }), skel("skel-text", { width: "72%", height: "18px", marginTop: "8px" })));
  root.append(
    h("div", { class: "report-bar" }, skel("skel-text", { width: "160px" }), skel("skel-button", { width: "220px", height: "36px" })),
    h("div", { class: "report-cover" }, skel("skel-text", { width: "220px", height: "12px" }), skel("skel-title", { width: "min(520px, 80%)", height: "40px", marginTop: "14px" }),
      skel("skel-text", { width: "min(380px, 64%)", marginTop: "14px" }), skel("skel-block", { height: "84px", marginTop: "28px" }), terms),
    h("div", { class: "report-body" }, h("div", {}), h("div", { class: "report-main" }, skel("skel-title", { width: "40%", marginTop: "48px" }), skel("skel-text", { width: "92%", marginTop: "18px" }), skel("skel-text", { width: "86%", marginTop: "10px" }), skel("skel-block", { height: "180px", marginTop: "20px" }))),
  );
  return root;
}

// Page controller. conversationFor(projectId) resolves the site's conversation id, or null.
export function createReportPage({ root, navigate, conversationFor, architectureEnabled = () => false, mountCard = null }) {
  let generation = 0;
  async function load(projectId, gen) {
    const id = encodeURIComponent(projectId);
    const [project, conversationId] = await Promise.all([chatRequest(`/projects/${id}/state`), conversationFor(projectId)]);
    const property = project.fields?.property?.value;
    const nearbyQuery = property ? nearbyPipelineQuery({ latitude: property.latitude, longitude: property.longitude, zip: property.zipcode, bbl: property.bbl }) : null;
    const [conversation, architecture, nearby, schemes] = await Promise.all([
      conversationId ? chatRequest(`/conversations/${encodeURIComponent(conversationId)}`) : null,
      // The floor plan is optional to the report; without it the chapter simply has no plan.
      null,
      // So is nearby development.
      nearbyQuery ? chatRequest(`/nearby-pipeline?${nearbyQuery}`).catch(() => null) : null,
      // And the three ways to build it, which need the parcel.
      property?.bbl ? chatRequest(`/projects/${id}/schemes`).catch(() => null) : null,
    ]);
    // Trade-press stories about the lot and its block; the report reads without them.
    const bbl = project.fields?.property?.value?.bbl;
    const news = bbl ? await chatRequest(`/news/lots/${encodeURIComponent(bbl)}`).catch(() => null) : null;
    if (gen !== generation) return;
    const model = reportModel({ project: { ...project, id: projectId }, conversation, architecture, news: news?.stories || [], nearby, schemes });
    document.title = `${model.address} underwriting report \u00b7 Arosa`;
    const share = async () => {
      const url = `${linkOrigin()}/sites/${id}/report`;
      if (navigator.share) {
        await navigator.share({ title: `${model.address} underwriting report`, url }).catch(() => {});
        return "";
      }
      await navigator.clipboard.writeText(url);
      return "Link copied";
    };
    root.replaceChildren(renderReport(model, { onBack: () => navigate(`/sites/${id}`), onShare: share, mountCard }));
    root.setAttribute("aria-busy", "false");
  }
  return {
    show(projectId) {
      const gen = ++generation;
      root.hidden = false;
      root.setAttribute("aria-busy", "true");
      root.replaceChildren(reportSkeleton());
      root.scrollTop = 0;
      load(projectId, gen).catch((error) => {
        if (gen !== generation) return;
        root.setAttribute("aria-busy", "false");
        const retry = h("button", { class: "report-action", type: "button", text: "Retry" });
        retry.addEventListener("click", () => this.show(projectId));
        root.replaceChildren(h("div", { class: "report report-failed", role: "status" }, h("p", { text: `The report could not load. ${error.message}` }), retry));
      });
    },
    leave() {
      ++generation;
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
