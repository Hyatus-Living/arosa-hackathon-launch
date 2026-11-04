import { skel } from "./skeleton.js";
import { stepFinding, stepSources, thoughtHeadline } from "./run-trail.js";

// Keep streaming content mounted so selection, focus and animations survive deltas.
export function patchMarkup(target, html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  function sync(parent, source) {
    [...source.childNodes].forEach((next, i) => {
      const current = parent.childNodes[i];
      if (!current) {
        parent.append(next.cloneNode(true));
        return;
      }
      if (
        current.nodeType !== next.nodeType ||
        current.nodeName !== next.nodeName
      ) {
        current.replaceWith(next.cloneNode(true));
        return;
      }
      if (next.nodeType === Node.TEXT_NODE) {
        if (current.data !== next.data) current.data = next.data;
      } else if (next.nodeType === Node.ELEMENT_NODE) {
        for (const attr of [...current.attributes])
          if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of [...next.attributes])
          if (current.getAttribute(attr.name) !== attr.value)
            current.setAttribute(attr.name, attr.value);
        sync(current, next);
      }
    });
    while (parent.childNodes.length > source.childNodes.length)
      parent.lastChild.remove();
  }
  sync(target, template.content);
}

// Each research step reads as what was done, in plain words, from the tool and its arguments:
// "Read ZR 33-12", "Looked up 120 Broadway's parcel", "Searched the web for City of Yes". A step that
// is still running reads in the present ("Reading ZR 33-12"). Tool names never reach the page.
const VERBS = {
  look: ["Looking up", "Looked up"],
  search: ["Searching", "Searched"],
  read: ["Reading", "Read"],
  check: ["Checking", "Checked"],
  compute: ["Computing", "Computed"],
  compare: ["Comparing", "Compared"],
  model: ["Modeling", "Modeled"],
  size: ["Sizing", "Sized"],
  find: ["Finding", "Found"],
  pull: ["Pulling", "Pulled"],
  record: ["Recording", "Recorded"],
  run: ["Running", "Ran"],
  build: ["Building", "Built"],
  lay: ["Laying out", "Laid out"],
  save: ["Saving", "Saved"],
  render: ["Rendering", "Rendered"],
  attach: ["Attaching", "Attached"],
  select: ["Selecting", "Selected"],
  queue: ["Queuing", "Queued"],
  combine: ["Combining", "Combined"],
  update: ["Updating", "Updated"],
  audit: ["Auditing", "Audited"],
  load: ["Reviewing", "Reviewed"],
  research: ["Researching", "Researched"],
  import: ["Importing", "Imported"],
};
const clip = (value, max = 60) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
};
const words = (value) => clip(String(value ?? "").replace(/[_-]+/g, " ").toLowerCase());
const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\d*\./, ""); } catch { return ""; }
};
// A Zoning Resolution page reads as its section ("ZR 33-12"); other pages as their site.
function pageName(url, find) {
  const host = hostOf(url);
  const section = String(url || "").match(/zr\.planning\.nyc\.gov\/.*?\/(\d+-\d+[a-z]?)\/?(?:[?#].*)?$/i);
  if (find && /^\d+-\d+/.test(String(find).trim())) return "ZR " + clip(find, 24);
  if (section) return "ZR " + section[1];
  if (find) return `${clip(find, 40)} on ${host || "a page"}`;
  return host || "a page";
}
const possessive = (name) => (/s$/i.test(name) ? name + "'" : name + "'s");
const STEPS = {
  acres_find_property: (a) => a.address ? ["look", `${possessive(clip(a.address, 48))} parcel`] : a.bbl ? ["look", `parcel BBL ${a.bbl}`] : ["look", "the parcel"],
  acres_set_subject: () => ["select", "the subject property"],
  acres_nearby_properties: () => ["compare", "nearby parcels"],
  acres_search_knowledge: (a) => ["search", a.query ? `saved sources for ${clip(a.query)}` : "saved sources"],
  acres_get_knowledge_source: () => ["read", "a saved source"],
  acres_refresh_knowledge: () => ["queue", "a source refresh"],
  acres_search_source_registry: (a) => ["search", a.query ? `official datasets for ${clip(a.query)}` : "official datasets"],
  acres_search_zoning_facts: (a) => ["check", a.query ? `zoning rules on ${clip(a.query)}` : "zoning rules"],
  acres_fanout_search: (a) => ["search", a.query ? `the web for ${clip(a.query)}` : "the web"],
  web_search: (a) => ["search", a.query ? `the web for ${clip(a.query)}` : "the web"],
  acres_fetch_url: (a) => ["read", pageName(a.url, a.find)],
  acres_discover_tools: () => ["search", "for more research sources"],
  acres_execute_tool: (a) => {
    const inner = a.arguments || {};
    const query = inner.query || inner.q;
    return query ? ["search", `the web for ${clip(query)}`] : ["check", "an outside source"];
  },
  acres_search_capabilities: () => ["find", "the right research method"],
  acres_load_skill: (a) => ["load", a.name ? `the ${words(a.name)} method` : "a research method"],
  acres_spawn_lanes: (a) => ["research", Array.isArray(a.lanes) && a.lanes.length > 1 ? `${a.lanes.length} angles in parallel` : "in parallel"],
  acres_zoning_envelope: (a) => ["compute", a.district ? `the ${clip(a.district, 20)} zoning envelope` : "the zoning envelope"],
  acres_entitlement_scenarios: () => ["size", "ways to build more"],
  acres_model_concept: (a) => ["model", a.name ? clip(a.name) : "a massing concept"],
  acres_plan_concept: () => ["lay", "test-fit floor plans"],
  acres_audit_floorplan: () => ["audit", "the floor plan"],
  acres_nyc_public_records: (a) => ["check", a.bbl ? `building filings for BBL ${a.bbl}` : "building filings and records"],
  acres_development_ledger: () => ["check", "land sales and filings on the block"],
  acres_far_precedents: (a) => ["find", a.zoningDistrict ? `floor-area precedents in ${clip(a.zoningDistrict, 20)}` : "floor-area precedents nearby"],
  acres_municipal_parcel_records: (a) => ["look", a.address ? `${possessive(clip(a.address, 48))} city parcel record` : "the city parcel record"],
  acres_assemble_site: () => ["combine", "lots into one site"],
  acres_nearby_places: () => ["check", "transit, shops and parks nearby"],
  acres_market_comps: (a) => ["pull", a.location || a.zipCode ? `market comparables for ${clip(a.location || a.zipCode, 40)}` : "market comparables"],
  acres_search_deal_store: () => ["search", "listings on the market"],
  acres_market_inputs: () => ["record", "market figures"],
  acres_unit_mix: () => ["compute", "a unit mix"],
  acres_pro_forma: () => ["run", "a pro forma"],
  acres_compare_programs: () => ["compare", "development programs"],
  acres_generate_deck: () => ["build", "the underwriting deck"],
  acres_manage_alerts: () => ["update", "your email alerts"],
  acres_find_floor_plan: (a) => ["search", a.query ? `for floor plans of ${clip(a.query, 48)}` : "for published floor plans"],
  acres_attach_drawing: () => ["attach", "a plan drawing"],
  acres_view_drawing: () => ["read", "a plan drawing"],
  acres_read_plan: () => ["read", "the floor plan"],
  acres_save_plan: () => ["save", "a floor plan revision"],
  acres_render_plan: () => ["render", "the 3D walkthrough"],
  acres_import_pascal_scene: () => ["import", "the edited plan"],
  generateSandboxedUi: () => ["build", "an interactive view"],
};
// A tool this page does not know yet still reads as an action, from its most telling argument.
function fallbackStep(a) {
  if (a.query) return ["search", `for ${clip(a.query)}`];
  if (a.url) return ["read", pageName(a.url)];
  if (a.address) return ["look", clip(a.address, 48)];
  return ["check", "a research source"];
}
export function describeStep(tool, args = {}, status = "running") {
  const name = String(tool || "");
  const a = args && typeof args === "object" ? args : {};
  if (name === "acres_execute_capability") return describeStep(a.name, a.arguments || {}, status);
  const [verb, object] = (STEPS[name] || fallbackStep)(a);
  const forms = VERBS[verb];
  // Names the model chose (concepts, pro formas) may carry em dashes; page copy never does.
  return `${status === "running" ? forms[0] : forms[1]} ${object}`.replace(/\s*\u2014\s*/g, ", ");
}

export function createActivityView() {
  const root = document.createElement("details");
  root.className = "research-activity";
  const summary = document.createElement("summary");
  summary.innerHTML =
    '<span class="research-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="research-status" role="status"></span><svg class="activity-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  const list = document.createElement("ol");
  list.className = "activity-steps";
  root.append(summary, list);
  const rows = [];
  const setStatus = (text, running) => {
    const label = summary.querySelector(".research-status");
    if (label.textContent !== text) label.textContent = text;
    root.classList.toggle("is-running", running);
  };
  function update(items, label, running) {
    setStatus(label, running);
    items.forEach((item, i) => {
      let row = rows[i];
      if (!row) {
        const li = document.createElement("li");
        const note = document.createElement("span");
        const details = document.createElement("details");
        const title = document.createElement("summary");
        const content = document.createElement("pre");
        details.append(title, content);
        li.append(note, details);
        list.append(li);
        row = { li, note, details, title, content };
        rows.push(row);
      }
      // A finished step that found figures says them after what it did.
      const step = item.tool ? describeStep(item.tool, item.arguments, item.status) : item.text || "Research";
      const title = item.finding ? `${step}: ${item.finding}` : step;
      if (row.title.textContent !== title) row.title.textContent = title;
      if (row.note.textContent !== title) row.note.textContent = title;
      row.li.dataset.status = item.status || "note";
      row.li.classList.toggle("is-thought", Boolean(item.thought));
      // The step's own words already say what it did; only a failure carries more to read.
      const detail = item.detail || "";
      if (row.content.textContent !== detail) row.content.textContent = detail;
      row.note.hidden = Boolean(detail);
      row.details.hidden = !detail;
      row.details.classList.toggle("has-detail", Boolean(detail));
      row.content.hidden = !detail;
    });
    while (rows.length > items.length) rows.pop().li.remove();
  }
  return { root, update, setStatus };
}

export function formatWorkedDuration(durationMs, failed = false) {
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
    const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
    let formatted;
    if (totalSeconds < 60) {
      formatted = `${totalSeconds}s`;
    } else if (totalSeconds < 3600) {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      formatted = seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    } else {
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      formatted = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    return failed ? `Worked for ${formatted} · Interrupted` : `Worked for ${formatted}`;
  }
  return failed ? "Research interrupted" : "Research complete";
}

export function savedActivity(runId, load, describe, failed = false, durationMs = null) {
  const view = createActivityView();
  let resolvedDurationMs = durationMs;
  view.setStatus(formatWorkedDuration(resolvedDurationMs, failed), false);
  let loaded = false;
  view.root.addEventListener("toggle", async () => {
    if (!view.root.open || loaded) return;
    loaded = true;
    // The steps hold their place as quiet bars while they load; the summary keeps its duration.
    const placeholder = document.createElement("div");
    placeholder.className = "activity-skeleton";
    placeholder.setAttribute("role", "status");
    const hint = document.createElement("span");
    hint.className = "sr-only";
    hint.textContent = "Loading the research steps";
    placeholder.append(hint, skel("skel-text", { width: "46%" }), skel("skel-text", { width: "62%" }), skel("skel-text", { width: "38%" }));
    view.root.append(placeholder);
    view.root.setAttribute("aria-busy", "true");
    try {
      const run = await load(runId);
      if (!(typeof resolvedDurationMs === "number" && Number.isFinite(resolvedDurationMs) && resolvedDurationMs > 0)) {
        if (run?.created && run?.updated && run.updated >= run.created) {
          resolvedDurationMs = run.updated - run.created;
        } else if (Array.isArray(run?.events) && run.events.length >= 2) {
          const first = run.events[0]?.time;
          const last = run.events.at(-1)?.time;
          if (first && last && last >= first) resolvedDurationMs = last - first;
        }
      }
      const items = [];
      for (const e of run.events) {
        if (e.event === "tool.started")
          items.push({
            tool: e.tool,
            text: describe(e.tool, e.arguments),
            arguments: e.arguments,
            status: "running",
          });
        if (e.event === "tool.completed") {
          const item = items.findLast(
            (x) => x.tool === e.tool && x.status === "running",
          );
          if (item) {
            item.status = e.success ? "complete" : "failed";
            item.detail = e.success ? "" : e.result?.error;
            item.finding = stepFinding(e);
            item.sources = stepSources(e);
          }
        }
        if (e.event === "agent.phaseSummary") {
          const thought = thoughtHeadline(e.summary);
          if (thought && items.at(-1)?.text !== thought) items.push({ text: thought, thought: true });
        }
        if (e.event === "message.completed" && e.phase === "commentary")
          items.push({ text: e.text });
        if (e.event === "run.failed")
          items.push({ text: e.error || "Research failed", status: "failed" });
      }
      // The run is over: a step with no recorded end still reads as done, not in progress.
      for (const item of items) if (item.status === "running") item.status = "ended";
      view.update(
        items,
        formatWorkedDuration(resolvedDurationMs, failed),
        false,
      );
    } catch (error) {
      loaded = false;
      view.update(
        [{ text: error.message, status: "failed" }],
        "Activity could not load",
        false,
      );
    } finally {
      placeholder.remove();
      view.root.removeAttribute("aria-busy");
    }
  });
  return view.root;
}
