// What a running underwriting has done so far, in plain words, for the trail on the site page: the
// figures each finished step found, the sources it read, the model's own headline for what it is
// thinking about, and how long the run usually takes. Tool names never reach the page.
import { displayAddress, fmtMoney, fmtNumber, fmtSqft } from "./core-model.js";

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const has = (v) => Number.isFinite(num(v));
const clip = (text, max) => {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};
// Page copy never carries em dashes; titles from the web often do.
const plain = (text) => String(text ?? "").replace(/\s*—\s*/g, ", ");

const CALLS = {
  supports_price: "The asking price works at the target return",
  below_price: "The land is worth less than the asking price",
  no_land_value: "The program leaves no land value at the target return",
};

// One line of figures from a finished step's result, or null when the result has none to show.
const FINDINGS = {
  acres_find_property: (r) => parcelLine(r?.rows?.[0]),
  acres_set_subject: (r) => parcelLine(r?.property),
  acres_zoning_envelope: (r) => {
    const sqft = r?.headlineReconciliation?.operativeFigure?.valueSqft;
    const district = r?.envelope?.district || r?.parcel?.districts?.[0];
    return has(sqft) ? `Up to ${fmtSqft(sqft)} of zoning floor area${district ? ` in ${district}` : ""}` : null;
  },
  acres_entitlement_scenarios: (r) => {
    const paths = Array.isArray(r?.scenarios) ? r.scenarios : [];
    const most = Math.max(0, ...paths.map((s) => num(s.addedFloorAreaSqft)).filter(Number.isFinite));
    if (!paths.length) return null;
    return `${paths.length} ${paths.length === 1 ? "way" : "ways"} to build more${most > 0 ? `, the largest adds ${fmtSqft(most)}` : ""}`;
  },
  acres_model_concept: (r) => (has(r?.metrics?.grossFloorAreaSqft) ? `${has(r.metrics.storeys) ? `${r.metrics.storeys} storeys, ` : ""}${fmtSqft(r.metrics.grossFloorAreaSqft)} massing` : null),
  acres_nyc_public_records: (r) => {
    const filings = (r?.dobBisFilings?.length || 0) + (r?.dobNowFilings?.length || 0);
    const deeds = r?.acrisDocuments?.length || 0;
    return r && (filings || deeds) ? `${filings} building ${filings === 1 ? "filing" : "filings"} and ${deeds} property ${deeds === 1 ? "record" : "records"}` : null;
  },
  acres_market_comps: (r, a) => {
    const where = a?.zipCode || a?.location;
    return has(r?.totalComps) ? `${fmtNumber(r.totalComps)} comparable listings and sales${where ? ` near ${clip(where, 40)}` : ""}` : null;
  },
  acres_unit_mix: (r) => (has(r?.units) ? `${r.units} units averaging ${fmtSqft(r.averageUnitSqft)}` : null),
  acres_pro_forma: (r) => {
    const ret = r?.returns;
    if (!has(ret?.value)) return null;
    return `${r.name ? clip(plain(r.name), 48) + ": " : ""}worth ${fmtMoney(ret.value)} built, ${has(ret.profit) ? `${num(ret.profit) < 0 ? "a loss of " + fmtMoney(-num(ret.profit)) : "profit " + fmtMoney(ret.profit)}` : ""}`.replace(/, $/, "");
  },
  acres_compare_programs: (r) => {
    const d = r?.decision;
    if (!d || !CALLS[d.call]) return null;
    return has(d.maxLandPrice) && num(d.maxLandPrice) > 0 ? `${CALLS[d.call]}; land is worth up to ${fmtMoney(d.maxLandPrice)}` : CALLS[d.call];
  },
};

function parcelLine(p) {
  if (!p) return null;
  const parts = [p.address ? displayAddress(p.address) : null, p.zonedist1 || null, has(p.lotarea) ? `${fmtSqft(p.lotarea)} lot` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

const toolOf = (event) => (event.tool === "acres_execute_capability" ? event.arguments?.name : event.tool);
const argsOf = (event) => (event.tool === "acres_execute_capability" ? event.arguments?.arguments || {} : event.arguments || {});

// The figures a finished step found.
export function stepFinding(event) {
  if (!event?.success) return null;
  const finding = FINDINGS[toolOf(event)]?.(event.result, argsOf(event));
  return finding ? plain(finding) : null;
}

// A page without a title reads as its site rather than its address.
const sourceTitle = (title, url) => {
  const text = String(title || "").trim();
  if (text && !/^https?:\/\//i.test(text)) return clip(plain(text), 80);
  try { return new URL(url || text).hostname.replace(/^www\./, ""); } catch { return null; }
};

// The sources a finished step read: pages it opened and saved sources it matched.
export function stepSources(event) {
  if (!event?.success) return [];
  const r = event.result || {};
  const tool = toolOf(event);
  if (tool === "acres_fetch_url" && sourceTitle(r.title, r.url)) return [{ title: sourceTitle(r.title, r.url), url: r.url || null }];
  if (tool === "acres_get_knowledge_source" && r.title) return [{ title: clip(plain(r.title), 80), url: r.url || null }];
  if (tool === "acres_search_knowledge" && Array.isArray(r.results)) return r.results.slice(0, 3).filter((x) => x.title).map((x) => ({ title: clip(plain(x.title), 80), url: x.url || null }));
  if (tool === "acres_nyc_public_records" && r.bbl) return [{ title: "NYC building, deed and violation records", url: null }];
  if (tool === "acres_market_comps" && has(r.totalComps)) return [{ title: "Recent listings and sales nearby", url: null }];
  return [];
}

// The model's reasoning summaries arrive as short markdown headlines ("**Checking the zoning lot**");
// the trail shows the latest one as plain text.
export function thoughtHeadline(summary) {
  const parts = (Array.isArray(summary) ? summary : [summary]).map((s) => String(s?.text ?? s ?? "")).filter((s) => s.trim());
  const last = parts.at(-1);
  if (!last) return null;
  const bold = last.match(/\*\*(.+?)\*\*/)?.[1];
  const line = (bold || last.split("\n").find((l) => l.trim()) || "").replace(/[*_`#]/g, "").trim();
  return line ? clip(plain(line), 90) : null;
}

// Unique sources in the order the run found them.
export function sourcesFound(items) {
  const seen = new Map();
  for (const item of items) for (const s of item.sources || []) if (!seen.has(s.title)) seen.set(s.title, s);
  return [...seen.values()];
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));

// A running clock, minutes and seconds: 0:09, 1:05, 62:03.
export function clockTime(elapsedMs) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// How long the run has gone and how long runs of its kind usually take, measured from recent runs.
// typicalMs is null when there are too few to say.
export function timeLine(elapsedMs, typicalMs = null) {
  const so = elapsedMs < 60000 ? "under a minute so far" : `${minutes(elapsedMs)} min so far`;
  if (!has(typicalMs) || typicalMs <= 0) return so.charAt(0).toUpperCase() + so.slice(1);
  const left = typicalMs - elapsedMs;
  if (left < -120000) return `Taking longer than usual, ${so}; these usually take about ${minutes(typicalMs)} min`;
  if (left <= 60000) return `Finishing up, ${so}`;
  return `About ${minutes(left)} min left, ${so}`;
}
