// Underwrite a site: the app's own site page, filled step by step from an example run. A listing
// chosen in the Find a deal embed arrives as a message from the landing page.
import { tell, listen, ready } from "/demo/shell.js";
import { renderParcel } from "/app/core-view.js";
import { readAssumptions } from "/app/core-model.js";
import { decide } from "/demo/numbers.js";
import { loadSite, playRun } from "/demo/site-run.js";
import { massingView } from "/demo/massing-view.js";

const root = document.getElementById("site");
let full = null, state = null, run = null, token = 0, selectedConceptId = null, started = false, assumptionStatus = "";

function render() {
  const open = new Set([...root.querySelectorAll("details[data-disclosure][open]")].map((d) => d.dataset.disclosure));
  const page = renderParcel(state, { run, canSend: true, canEdit: !run, assumptionStatus, selectedConceptId, conceptViewer: (concept) => massingView(concept, { height: 260 }) });
  for (const d of page.querySelectorAll("details[data-disclosure]")) if (open.has(d.dataset.disclosure)) d.open = true;
  root.replaceChildren(page);
}

async function open(id, { start = false } = {}) {
  const mine = ++token;
  full = await loadSite(id);
  if (mine !== token) return;
  state = { ...full, fields: {} };
  run = null;
  selectedConceptId = null;
  assumptionStatus = "";
  render();
  if (start) void underwrite();
}

// From the start, or only the steps a change of numbers put out of date.
async function underwrite() {
  const mine = ++token;
  started = true;
  const update = Object.values(state.fields).some((f) => f.stale);
  assumptionStatus = "";
  state = await playRun(full, update ? state : { ...state, fields: {} }, (next, current) => {
    state = next;
    run = current;
    render();
  }, () => mine === token);
}

root.addEventListener("click", (e) => {
  const target = e.target.closest("button, a");
  if (!target) return;
  if (target.matches("a[data-route]")) { e.preventDefault(); return; }
  if (target.dataset.followAction) { void underwrite(); return; }
  if (target.dataset.concept) { selectedConceptId = target.dataset.concept; render(); return; }
  if (target.hasAttribute("data-open-chat")) tell("ask", { id: state.id, address: state.title });
});

// Your numbers: saved to the site, which puts steps 3 and 4 out of date; the update re-runs them
// with the research service's own pro forma and decision code.
root.addEventListener("submit", async (e) => {
  if (e.target.id !== "core-assumptions-form") return;
  e.preventDefault();
  const form = e.target;
  const entries = Object.fromEntries([...form.elements].filter((i) => i.name).map((i) => [i.name, i.value]));
  let value;
  try { value = readAssumptions(entries); } catch (error) { form.querySelector(".core-form-status").textContent = error.message; return; }
  const before = full.inputs.shared;
  const shared = { ...before, ...value, financing: { ...before.financing, ...value.financing }, operating: { ...before.operating, ...value.operating } };
  const next = decide(await import("/demo/calc.js"), { ...full.inputs, shared }, Date.now());
  const { market: _market, targetReturnOnCost: _target, program: _program, ...numbers } = shared;
  const now = Date.now();
  const saved = { value: numbers, provenance: { tool: "user", sources: [] }, stale: null, updated: now };
  full = { ...full, inputs: { ...full.inputs, shared }, fields: { ...full.fields, assumptions: saved,
    program: { ...full.fields.program, value: next.program }, proFormas: { ...full.fields.proFormas, value: [next.proForma] }, comparisons: { ...full.fields.comparisons, value: [next.comparison] } } };
  state = { ...state, fields: { ...state.fields, assumptions: saved,
    proFormas: { ...state.fields.proFormas, stale: "assumptions" }, comparisons: { ...state.fields.comparisons, stale: "proFormas" } } };
  assumptionStatus = "Saved. Update the underwriting to apply your numbers.";
  render();
});

listen("site", ({ id, start }) => void open(id, { start }));
// The first time the window comes into view, the example underwrites itself.
listen("visible", () => { if (!started && state && !run) void underwrite(); });

await ready;
await open("ex-fulton");
tell("ready");
