// Plays an example site's underwriting the way the app shows a run: the research tools in order, each
// step marked as working and then filled with its saved result. The state comes from sites/<id>.json.
import { wait } from "/demo/shell.js";

export const PHASES = [
  { tool: "acres_set_subject", label: "Reading the parcel record", fields: ["property"], ms: 1300 },
  { tool: "acres_zoning_envelope", label: "Sizing the zoning envelope", fields: ["envelope"], ms: 1600 },
  { tool: "acres_entitlement_scenarios", label: "Testing ways to add floor area", fields: ["entitlements"], ms: 1200 },
  { tool: "acres_model_concept", label: "Modeling the massing", fields: ["concepts"], ms: 1400 },
  { tool: "acres_market_inputs", label: "Recording market rents", fields: ["market"], ms: 1200 },
  { tool: "acres_unit_mix", label: "Sizing the unit mix", fields: ["program"], ms: 1100 },
  { tool: "acres_pro_forma", label: "Running the pro forma", fields: ["proFormas", "assumptions", "program"], ms: 1500 },
  { tool: "acres_compare_programs", label: "Testing the land price", fields: ["comparisons"], ms: 1500 },
];

export const loadSite = (id) => fetch(`/demo/sites/${encodeURIComponent(id)}.json`).then((r) => r.json());

// Runs the phases whose results are missing or out of date; show(state, run) draws each moment.
export async function playRun(full, state, show, isCurrent) {
  const tools = [];
  for (const phase of PHASES) {
    if (phase.fields.every((k) => state.fields[k] && !state.fields[k].stale)) continue;
    tools.push(phase.tool);
    show(state, { label: phase.label, tools: [...tools] });
    await wait(phase.ms);
    if (!isCurrent()) return state;
    state = { ...state, fields: { ...state.fields, ...Object.fromEntries(phase.fields.map((k) => [k, { ...full.fields[k], updated: Date.now() }])) } };
  }
  show(state, null);
  return state;
}
