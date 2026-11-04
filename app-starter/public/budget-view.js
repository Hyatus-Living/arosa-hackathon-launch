// One scheme's development budget: land, hard, soft and financing at a glance, every line on request.
// budget is scheme.budget ({lines, groups, total, grossSqft, basis}); its lines add up to the total
// cost of the deal model at the account's costs.

import { fmtMoney as compact } from "./core-model.js";

const dollars = n => `$${Math.round(n).toLocaleString("en-US")}`;
const perSf = n => `$${Math.round(n).toLocaleString("en-US")}`;
const share = n => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(cells, className = "") {
  const tr = el("tr", className);
  cells.forEach(([text, cls], i) => tr.append(el(i ? "td" : "th", cls || "", text)));
  if (tr.firstChild) tr.firstChild.scope = "row";
  return tr;
}

function head(labels) {
  const thead = el("thead");
  const tr = el("tr");
  labels.forEach((label, i) => { const th = el("th", i ? "is-num" : "", label); th.scope = "col"; tr.append(th); });
  thead.append(tr);
  return thead;
}

export function renderSchemeBudget(container, budget) {
  const root = el("section", "scheme-budget");
  root.setAttribute("aria-label", "Development budget");
  const summary = el("table", "scheme-budget-table");
  summary.append(el("caption", "sr-only", "Development budget by group"), head(["", "Cost", "Per gsf", "Share"]));
  const body = el("tbody");
  for (const g of budget.groups.filter(g => g.amount)) body.append(row([[g.label], [compact(g.amount), "is-num"], [perSf(g.perGsf), "is-num"], [share(g.pct), "is-num"]]));
  body.append(row([["Total cost"], [compact(budget.total), "is-num"], [perSf(budget.total / budget.grossSqft), "is-num"], ["100%", "is-num"]], "is-total"));
  summary.append(body);

  const more = el("details", "scheme-budget-detail");
  more.append(el("summary", "", "Every line"));
  const detail = el("table", "scheme-budget-table scheme-budget-lines");
  detail.append(el("caption", "sr-only", "Development budget by line"), head(["", "Cost", "Per gsf"]));
  for (const g of budget.groups.filter(g => g.amount)) {
    const group = el("tbody");
    group.append(row([[g.label], [dollars(g.amount), "is-num"], [perSf(g.perGsf), "is-num"]], "is-group"));
    for (const line of budget.lines.filter(l => l.group === g.key)) {
      const tr = row([[line.label], [dollars(line.amount), "is-num"], [perSf(line.perGsf), "is-num"]]);
      tr.firstChild.append(el("span", "scheme-budget-basis", line.basis));
      group.append(tr);
    }
    detail.append(group);
  }
  const foot = el("tfoot");
  foot.append(row([["Total cost"], [dollars(budget.total), "is-num"], [perSf(budget.total / budget.grossSqft), "is-num"]], "is-total"));
  detail.append(foot);
  const hard = budget.basis.hardCostPerGrossSqft ? `Hard cost at ${perSf(budget.basis.hardCostPerGrossSqft)} a gross sf${budget.basis.hardCostBasis ? ` (${budget.basis.hardCostBasis})` : ""} over ${Math.round(budget.grossSqft).toLocaleString("en-US")} gross sf` : `${Math.round(budget.grossSqft).toLocaleString("en-US")} gross sf`;
  const note = el("p", "scheme-budget-note", `${hard}, split by ${budget.basis.splits === "custom" ? "your budget shares" : "Arosa's default budget shares"}. Totals are the deal model's costs at your numbers.`);
  more.append(detail, note);

  root.append(summary, more);
  container.replaceChildren(root);
  return root;
}
