import { FIELDS, STEPS, WELCOME, HARD_COST_KEYS, initialValues, fieldError, stepErrors, costStack, toDealSettings } from "./onboarding-model.js";
import { mountShader } from "./onboarding-shader.js";
import { budgetSplitsFields } from "./budget-splits-form.js";

const SETTINGS_URL = "/api/market-store/user-settings";
const BRAND = '<svg class="onboard-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="currentColor"/><path d="M8 24h4v-5h8v5h4V14h-4v-4h-4V6h-4v4H8z" fill="var(--bg)"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const money = n => `$${Math.round(n).toLocaleString("en-US")}`;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Dollar figures count from what they showed to their new value.
const shownAmounts = new WeakMap();
function countTo(node, amount) {
  const from = shownAmounts.get(node) ?? 0;
  shownAmounts.set(node, amount);
  cancelAnimationFrame(node.countFrame);
  if (reducedMotion() || from === amount) { node.textContent = money(amount); return; }
  const start = performance.now();
  const step = now => {
    const t = Math.min((now - start) / 420, 1);
    node.textContent = money(from + (amount - from) * (1 - Math.pow(1 - t, 3)));
    if (t < 1) node.countFrame = requestAnimationFrame(step);
  };
  node.countFrame = requestAnimationFrame(step);
}
const parse = raw => (String(raw).trim() === "" ? null : Number(String(raw).replace(/[$,%\s]/g, "")));

// The settings request starts beside the session request, before the app knows who is signed in.
export const requestDeveloperCosts = () => fetch(SETTINGS_URL, { cache: "no-store" });

// Accounts that have never entered their own costs go through the steps before the app opens.
// Settings that needed no steps are returned, so the listings price their first pins without asking again.
export async function ensureDeveloperCosts(response,modelingAvailable) {
  const settings = await response.json();
  if (settings.costsConfirmed) return settings;
  await runOnboarding(settings.baselineSettings, settings.budgetSplitOptions,modelingAvailable);
  return null;
}

// budgetOptions lists the budget lines and their default shares; the soft cost step offers them,
// closed, for anyone who splits their budget differently.
export function runOnboarding(baseline, budgetOptions,modelingAvailable) {
  return new Promise(resolve => {
    const values = initialValues(baseline);
    const house = initialValues(baseline);
    let index = 0, saving = false, saveError = null, shownErrors = {};
    // The budget shares to save (null follows Arosa's), and whether every group adds up to 100%.
    let budgetSplits = null, budgetValid = true, budgetOpen = false;

    const root = el("div", "onboard is-welcome");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "onboard-welcome-title");

    const top = el("header", "onboard-top");
    const brand = el("div", "onboard-brand");
    brand.innerHTML = BRAND;
    brand.append(el("span", "", "Arosa"));
    const progress = el("ol", "onboard-progress");
    progress.setAttribute("aria-label", "Setup steps");
    const counter = el("p", "onboard-counter");
    counter.setAttribute("aria-live", "polite");
    top.append(brand, progress, counter);

    const body = el("div", "onboard-body");
    const main = el("form", "onboard-step");
    main.noValidate = true;
    const aside = el("aside", "onboard-stack");
    aside.setAttribute("aria-label", "Your build cost");
    body.append(main, aside);

    const welcome = el("section", "onboard-welcome");
    const canvas = el("canvas", "onboard-shader");
    canvas.setAttribute("aria-hidden", "true");
    const welcomeCopy = el("div", "onboard-welcome-copy");
    const welcomeBrand = el("div", "onboard-brand");
    welcomeBrand.innerHTML = BRAND;
    welcomeBrand.append(el("span", "", "Arosa"));
    const welcomeTitle = el("h1", "onboard-welcome-title", WELCOME.title);
    welcomeTitle.id = "onboard-welcome-title";
    const startButton = el("button", "onboard-next onboard-start", WELCOME.action);
    startButton.type = "button";
    const preview = el("ol", "onboard-welcome-steps");
    preview.setAttribute("aria-label", "What you will set");
    preview.append(...STEPS.slice(0, -1).map(step => el("li", "", step.short)));
    welcomeCopy.append(welcomeBrand, welcomeTitle, ...WELCOME.lines.map((line, i) => el("p", `onboard-welcome-line${i ? " is-quiet" : ""}`, line)), startButton, preview);
    if(modelingAvailable) {
      const modeling=el('a','onboard-back onboard-modeling-link','Open Modeling');
      modeling.href='/modeling';welcomeCopy.append(modeling);
    }
    welcome.append(canvas, welcomeCopy);
    root.append(welcome, top, body);

    function renderProgress() {
      progress.replaceChildren(...STEPS.map((step, i) => {
        const item = el("li", i < index ? "is-done" : i === index ? "is-current" : "");
        item.append(el("span", "sr-only", `${step.title}${i < index ? ", done" : i === index ? ", current" : ""}`));
        return item;
      }));
      counter.textContent = `Step ${index + 1} of ${STEPS.length}`;
    }

    function fieldRow(key) {
      const field = FIELDS[key];
      const row = el("div", "onboard-field");
      const id = `onboard-${key}`;
      const label = el("label", "onboard-label", field.label);
      label.htmlFor = id;
      const box = el("div", "onboard-input");
      const isMoney = HARD_COST_KEYS.includes(key);
      if (isMoney) box.append(el("span", "onboard-affix", "$"));
      const input = el("input");
      input.id = id;
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.value = values[key] ?? "";
      if (isMoney) input.placeholder = "400";
      box.append(input, el("span", "onboard-affix onboard-unit", isMoney ? "/ gross sf" : "%"));
      const hint = el("p", "onboard-hint");
      hint.id = `${id}-hint`;
      const error = el("p", "onboard-error");
      error.id = `${id}-error`;
      input.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
      const syncHint = () => {
        hint.replaceChildren(field.hint || field.unit);
        if (!isMoney && Number(values[key]) !== house[key]) {
          const reset = el("button", "onboard-link", `Use Arosa default, ${field.format(house[key])}`);
          reset.type = "button";
          reset.addEventListener("click", () => { values[key] = house[key]; input.value = house[key]; delete shownErrors[key]; syncError(); syncHint(); renderStack(); input.focus(); });
          hint.append(" · ", reset);
        } else if (!isMoney) {
          hint.append(" · Arosa default");
        }
      };
      const syncError = () => {
        const message = shownErrors[key] || "";
        error.textContent = message;
        input.setAttribute("aria-invalid", message ? "true" : "false");
        row.classList.toggle("has-error", Boolean(message));
      };
      input.addEventListener("input", () => {
        values[key] = parse(input.value);
        if (shownErrors[key]) { shownErrors[key] = fieldError(key, values[key]); syncError(); }
        syncHint();
        renderStack();
      });
      syncHint();
      syncError();
      row.append(label, box, hint, error);
      return row;
    }

    function reviewList() {
      const list = el("dl", "onboard-review");
      STEPS.slice(0, -1).forEach((step, stepIndex) => {
        for (const key of step.fields) {
          const row = el("div", "onboard-review-row");
          const edit = el("button", "onboard-link", "Edit");
          edit.type = "button";
          edit.setAttribute("aria-label", `Edit ${FIELDS[key].label.toLowerCase()}`);
          edit.addEventListener("click", () => go(stepIndex));
          const value = el("dd", "", FIELDS[key].format(values[key]));
          if (HARD_COST_KEYS.includes(key)) value.textContent += " / gross sf";
          row.append(el("dt", "", FIELDS[key].label), value, edit);
          list.append(row);
        }
        if (step.id === "soft" && budgetOptions) {
          const row = el("div", "onboard-review-row");
          const edit = el("button", "onboard-link", "Edit");
          edit.type = "button";
          edit.setAttribute("aria-label", "Edit budget breakdown");
          edit.addEventListener("click", () => { budgetOpen = true; go(stepIndex); });
          row.append(el("dt", "", "Budget breakdown"), el("dd", "", budgetSplits ? "Your shares" : "Arosa defaults"), edit);
          list.append(row);
        }
      });
      return list;
    }

    function budgetSection() {
      const section = el("details", "budget-breakdown onboard-budget");
      // Drawn from the last shares that added up, so they are valid again.
      budgetValid = true;
      section.open = budgetOpen;
      section.addEventListener("toggle", () => { budgetOpen = section.open; });
      section.append(el("summary", "", "Budget breakdown"), el("p", "budget-breakdown-line", "How your hard and soft costs split into budget lines on each site. Arosa's shares suit a typical mid-rise; your totals stay the same."));
      const form = budgetSplitsFields({ options: budgetOptions, value: budgetSplits, idPrefix: "onboard-budget", onChange: next => { budgetValid = next !== undefined; if (budgetValid) budgetSplits = next; } });
      section.append(form.node);
      return section;
    }

    function renderStep() {
      const step = STEPS[index];
      const last = index === STEPS.length - 1;
      main.classList.remove("is-entering");
      void main.offsetWidth;
      main.classList.add("is-entering");
      const title = el("h1", "onboard-title", step.title);
      title.id = "onboard-title";
      title.tabIndex = -1;
      const fields = el("div", "onboard-fields");
      fields.append(...(last ? [reviewList()] : step.fields.map(fieldRow)));
      if (step.id === "soft" && budgetOptions) fields.append(budgetSection());
      const actions = el("div", "onboard-actions");
      if (index > 0) {
        const back = el("button", "onboard-back", "Back");
        back.type = "button";
        back.addEventListener("click", () => go(index - 1));
        actions.append(back);
      }
      const next = el("button", "onboard-next", last ? (saving ? "Saving…" : "Save and start") : "Continue");
      next.type = "submit";
      next.disabled = saving;
      const status = el("p", "onboard-error onboard-save-error", saveError || "");
      status.setAttribute("role", "status");
      actions.append(next);
      main.replaceChildren(title, el("p", "onboard-line", step.line), fields, status, actions);
      renderProgress();
      renderStack();
      const first = main.querySelector("input");
      (first || title).focus({ preventScroll: true });
    }

    // Built once so the bar segments and figures move as the numbers change.
    const stackParts = [
      { key: "hard", label: "Hard cost" },
      { key: "soft", label: "Soft costs" },
      { key: "carry", label: "Financing and carry" },
    ].map(part => {
      const seg = el("span", `onboard-seg onboard-seg-${part.key}`);
      const row = el("div", `onboard-legend-row onboard-legend-${part.key}`);
      const value = el("dd");
      row.append(el("dt", "", part.label), value);
      return { ...part, seg, row, value };
    });
    const stackTotal = el("p", "onboard-stack-total");
    const bar = el("div", "onboard-bar");
    bar.setAttribute("aria-hidden", "true");
    bar.append(...stackParts.map(part => part.seg));
    const legend = el("dl", "onboard-legend");
    legend.append(...stackParts.map(part => part.row));
    const stackNote = el("p", "onboard-stack-note");
    const extra = el("dl", "onboard-legend onboard-extra");
    aside.append(el("p", "onboard-stack-label", "All-in cost per buildable sf"), stackTotal, bar, legend, stackNote, extra);

    function renderStack() {
      const stack = costStack(values);
      countTo(stackTotal, stack ? stack.total : 0);
      stackTotal.classList.toggle("is-empty", !stack);
      for (const part of stackParts) {
        part.seg.style.flexGrow = stack ? String(stack[part.key]) : "0";
        if (stack) countTo(part.value, stack[part.key]);
        else { shownAmounts.delete(part.value); part.value.textContent = "–"; }
      }
      stackNote.textContent = stack ? `Rental, before adjustments for building height and narrow lots.${stack.condo.total !== stack.total ? ` A condo buildable foot is ${money(stack.condo.total)}.` : ""}` : "Enter your hard costs to see what a buildable foot costs you.";
      const shown = n => Number.isFinite(n) && n !== null;
      const net = values.zfaToNetEfficiency, cap = values.goodDealCapRate, margin = values.goodDealCondoMargin;
      const rows = [];
      if (index >= 2) rows.push(["Sellable per 100 sf built", shown(net) ? `${Math.round(net)} sf` : "–"]);
      if (index >= 3) rows.push(["Good deal, rental", shown(cap) ? `${cap}% yield` : "–"], ["Good deal, condo", shown(margin) ? `${margin}% margin` : "–"]);
      extra.replaceChildren(...rows.map(([label, value]) => { const row = el("div", "onboard-legend-row"); row.append(el("dt", "", label), el("dd", "", value)); return row; }));
      extra.hidden = !rows.length;
    }

    function go(next) {
      main.dataset.direction = next < index ? "back" : "forward";
      index = next;
      saveError = null;
      shownErrors = {};
      renderStep();
    }

    async function save() {
      saving = true;
      saveError = null;
      renderStep();
      const response = await fetch(SETTINGS_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dealSettings: toDealSettings(values, baseline), ...(budgetOptions ? { budgetSplits } : {}) }),
      }).catch(() => null);
      saving = false;
      if (!response?.ok) {
        saveError = "Your numbers were not saved. Check your connection and try again.";
        renderStep();
        return;
      }
      root.classList.add("is-leaving");
      setTimeout(() => { root.remove(); resolve(); }, reducedMotion() ? 0 : 220);
    }

    main.addEventListener("submit", event => {
      event.preventDefault();
      if (saving) return;
      const step = STEPS[index];
      const errors = stepErrors(step, values);
      if (step.id === "soft" && !budgetValid) {
        main.querySelector(".budget-splits-total.is-error")?.parentElement.querySelector("input")?.focus();
        return;
      }
      if (Object.keys(errors).length) {
        shownErrors = errors;
        renderStep();
        main.querySelector("[aria-invalid='true']")?.focus();
        return;
      }
      if (index === STEPS.length - 1) void save();
      else go(index + 1);
    });

    // The welcome hands over to the first question: its copy lifts away, the lines fade, the step rises.
    let stopShader = null;
    startButton.addEventListener("click", () => {
      if (root.classList.contains("is-starting")) return;
      root.classList.add("is-starting");
      setTimeout(() => {
        stopShader?.();
        welcome.remove();
        root.classList.remove("is-welcome", "is-starting");
        root.setAttribute("aria-labelledby", "onboard-title");
        main.dataset.direction = "forward";
        renderStep();
      }, reducedMotion() ? 0 : 520);
    });

    document.body.append(root);
    stopShader = mountShader(canvas, { dark: document.documentElement.classList.contains("dark"), still: reducedMotion() });
    if (!stopShader) welcome.classList.add("is-flat");
    renderStack();
    startButton.focus({ preventScroll: true });
  });
}
