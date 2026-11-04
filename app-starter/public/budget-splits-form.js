// "Budget breakdown": how an account splits its hard and soft cost into budget lines. The totals stay
// the account's own costs; only the shares move, and each group must add up to 100%. options is the
// settings response's budgetSplitOptions (lines and Arosa's default shares); value the saved shares or
// null for the defaults.

import { skel } from "./skeleton.js";

export const GROUPS = [["hard", "Hard cost"], ["soft", "Soft cost"]];

const round = (n, d) => Number(Number(n).toFixed(d));
const toView = shares => Object.fromEntries(GROUPS.map(([g]) => [g, Object.fromEntries(Object.entries(shares[g]).map(([k, v]) => [k, round(v * 100, 2)]))]));
const parse = raw => (String(raw).trim() === "" ? null : Number(String(raw).replace(/[%,\s]/g, "")));

// The percent a group adds up to, or null when a field is not a number from 0 to 100.
export function groupTotal(values) {
  const list = Object.values(values);
  if (list.some(v => v === null || !Number.isFinite(v) || v < 0 || v > 100)) return null;
  return round(list.reduce((a, b) => a + b, 0), 2);
}

// What a group's total line says, and whether the shares can be saved.
export function groupStatus(values) {
  const total = groupTotal(values);
  if (total === null) return { ok: false, text: "Use a share from 0 to 100% on every line." };
  if (Math.abs(total - 100) < 0.05) return { ok: true, text: "Adds up to 100%" };
  return { ok: false, text: `Adds up to ${total}%; ${total < 100 ? `${round(100 - total, 2)}% left to place` : `${round(total - 100, 2)}% too much`}.` };
}

// Shares to save, as fractions; null when they match the defaults, so the account follows Arosa's.
export function toStore(view, defaults) {
  const shares = Object.fromEntries(GROUPS.map(([g]) => [g, Object.fromEntries(Object.entries(view[g]).map(([k, v]) => [k, round(v / 100, 4)]))]));
  const same = GROUPS.every(([g]) => Object.entries(shares[g]).every(([k, v]) => Math.abs(v - defaults[g][k]) < 0.00005));
  return same ? null : shares;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The form's fields. onChange hears the shares to store (or null for the defaults) whenever every
// group adds up to 100%, and undefined while one does not. Returns {node, reset(), valid()}.
export function budgetSplitsFields({ options, value, idPrefix, onChange = () => {} }) {
  const defaults = toView(options.defaults);
  let view = toView(value || options.defaults);
  const node = el("div", "budget-splits");
  const inputs = {};
  const statuses = {};
  const emit = () => onChange(GROUPS.every(([g]) => groupStatus(view[g]).ok) ? toStore(view, options.defaults) : undefined);
  const sync = () => {
    for (const [g] of GROUPS) {
      const status = groupStatus(view[g]);
      statuses[g].textContent = status.text;
      statuses[g].classList.toggle("is-error", !status.ok);
    }
  };
  for (const [g, name] of GROUPS) {
    const set = el("fieldset", "budget-splits-group");
    set.append(el("legend", "", `${name} lines`));
    inputs[g] = {};
    for (const line of options.lines[g]) {
      const row = el("label", "budget-splits-row");
      row.htmlFor = `${idPrefix}-${g}-${line.key}`;
      const name = el("span", "budget-splits-label", line.label);
      if (line.elevatorOnly) name.title = "Walk-up buildings have no elevator; this share then goes to the other lines.";
      const box = el("span", "budget-splits-input");
      const input = el("input");
      input.id = row.htmlFor;
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.value = String(view[g][line.key]);
      input.setAttribute("aria-describedby", `${idPrefix}-${g}-total`);
      input.addEventListener("input", () => {
        view = { ...view, [g]: { ...view[g], [line.key]: parse(input.value) } };
        input.setAttribute("aria-invalid", String(!(Number.isFinite(view[g][line.key]) && view[g][line.key] >= 0 && view[g][line.key] <= 100)));
        sync();
        emit();
      });
      inputs[g][line.key] = input;
      box.append(input, el("span", "budget-splits-unit", "%"));
      row.append(name, box);
      set.append(row);
    }
    statuses[g] = el("p", "budget-splits-total");
    statuses[g].id = `${idPrefix}-${g}-total`;
    statuses[g].setAttribute("role", "status");
    set.append(statuses[g]);
    node.append(set);
  }
  sync();
  return {
    node,
    valid: () => GROUPS.every(([g]) => groupStatus(view[g]).ok),
    // Back to Arosa's shares.
    reset() {
      view = toView(options.defaults);
      for (const [g] of GROUPS) for (const [key, input] of Object.entries(inputs[g])) { input.value = String(defaults[g][key]); input.removeAttribute("aria-invalid"); }
      sync();
      emit();
    },
  };
}

// The costs panel's "Budget breakdown": closed at first, it reads the saved shares when opened and
// saves them on their own, leaving the costs as they are. request is the app's JSON API helper.
export function budgetBreakdownSection({ request, idPrefix = "budget-splits" }) {
  const section = el("details", "budget-breakdown");
  section.append(el("summary", "", "Budget breakdown"));
  const intro = el("p", "budget-breakdown-line", "How your hard and soft costs split into budget lines on each site. Your totals stay the same.");
  const content = el("div", "budget-breakdown-body");
  content.append(skel("budget-breakdown-skel"), skel("budget-breakdown-skel"), skel("budget-breakdown-skel"));
  section.append(intro, content);
  let loaded = false;
  section.addEventListener("toggle", async () => {
    if (!section.open || loaded) return;
    loaded = true;
    let settings;
    try { settings = await request("/market-store/user-settings"); }
    catch (err) { loaded = false; content.replaceChildren(el("p", "budget-splits-total is-error", `The budget shares could not be loaded. ${err.message}`)); return; }
    let pending;
    let saved = settings.budgetSplits;
    const note = el("p", "budget-splits-total");
    note.setAttribute("role", "status");
    const save = el("button", "home-follow", "Save breakdown");
    save.type = "button";
    const reset = el("button", "listings-costs-reset", "Use Arosa defaults");
    reset.type = "button";
    const sync = message => {
      save.disabled = pending === undefined || JSON.stringify(pending) === JSON.stringify(saved);
      reset.hidden = saved === null && pending === null;
      note.textContent = message ?? (saved ? "Your shares." : "Arosa defaults, planning shares for a New York mid-rise building.");
    };
    const fields = budgetSplitsFields({ options: settings.budgetSplitOptions, value: saved, idPrefix, onChange: next => { pending = next; sync(""); } });
    pending = saved;
    save.addEventListener("click", async () => {
      save.disabled = true;
      note.textContent = "Saving…";
      try {
        saved = (await request("/market-store/user-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ budgetSplits: pending }) })).budgetSplits;
        sync("Saved. Budgets on your sites use these shares.");
      } catch (err) { sync(`Not saved. ${err.message}`); }
    });
    reset.addEventListener("click", () => fields.reset());
    const actions = el("div", "listings-costs-actions");
    actions.append(save, reset);
    content.replaceChildren(fields.node, note, actions);
    sync();
  });
  return section;
}
