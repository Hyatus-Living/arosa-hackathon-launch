// Ask Arosa: the app's chat on example questions about one site. Each answer plays as the app shows a
// run (research steps, then the answer written in), and its figures come from the same example state
// as the site page embeds, so the chat and the site page agree.
import { ready, wait, reduced, listen, tell } from "/demo/shell.js";
import { marked } from "/app/vendor/marked.esm.js";
import DOMPurify from "/app/vendor/purify.es.mjs";
import { createActivityView, describeStep, formatWorkedDuration, patchMarkup } from "/app/activity-view.js";
import { sourceList, decorateAnswerHeader } from "/app/conversation-view.js";
import { fillSourceDialog } from "/app/source-view.js";
import { fmtMoney, fmtSqft, fmtRate, fmtFar, fmtNumber } from "/app/core-model.js";
import { loadSite } from "/demo/site-run.js";

const LOGO = '<svg class="assistant-logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><path d="M8 24h4v-5h8v5h4V14h-4v-4h-4V6h-4v4H8z" fill="var(--bg)"/></svg>';
const ZR = (section, path) => ({ title: `NYC Zoning Resolution ${section}`, url: `https://zr.planning.nyc.gov/${path}#${section}`, kind: "zoning", retrievedAt: "2026-10-19T13:58:00Z" });
const PLUTO = { title: "NYC MapPLUTO 25v2", url: "https://www.nyc.gov/content/planning/pages/resources/datasets/mappluto-pluto-change", kind: "property", retrievedAt: "2026-10-19T13:58:00Z" };
const DOB = { title: "NYC Department of Buildings, BIS", url: "https://a810-bisweb.nyc.gov/bisweb/bispi00.jsp", kind: "property", retrievedAt: "2026-10-19T13:58:00Z" };
const HCR = { title: "NYS Homes and Community Renewal, rent registration", url: "https://hcr.ny.gov/building-search", kind: "property", retrievedAt: "2026-10-19T13:58:00Z" };

// The example questions and their answers, written from the site's saved state.
function questions(site) {
  const v = (k) => site.fields[k].value;
  const p = v("property"), env = v("envelope"), pf = v("proFormas")[0], cmp = v("comparisons")[0];
  const [base, uap] = v("concepts");
  const name = site.title;
  const asOfRight = p.lotarea * p.residfar;
  const rows = cmp.variants.map((x) => `| ${x.label} | ${fmtMoney(x.value)} | ${fmtMoney(x.totalDevelopmentCost)} | ${fmtMoney(x.profit)} | ${fmtRate(x.unleveredReturnOnCost)} | ${fmtMoney(x.maxLandPrice)} |`).join("\n");
  return [
    {
      label: "What could I build here?",
      prompt: `What could I build at ${name} in Brooklyn?`,
      steps: [["acres_zoning_envelope", { district: p.zonedist1 }], ["acres_entitlement_scenarios", {}], ["acres_model_concept", { name: uap.name }]],
      sources: [ZR("23-22", "article-ii/chapter-3"), ZR("23-432", "article-ii/chapter-3"), PLUTO],
      text: `## ${name}, Brooklyn: what you can build

**New York City, deep coverage.** The lot is **${fmtSqft(p.lotarea)}** in an **${p.zonedist1}** district, with a ${fmtSqft(p.bldgarea)} building on it today (built FAR ${fmtFar(p.builtfar)}) [3].

| Scenario | FAR | Floor area | Height limit |
|---|---|---|---|
| As of right | ${fmtFar(p.residfar)} | ${fmtSqft(asOfRight)} | ${base.massing.maxHeightFeet} ft |
| Universal Affordability Preference | ${fmtFar(env.floorArea.maxFar)} | ${fmtSqft(env.floorArea.maxFloorAreaSqft)} | ${uap.massing.maxHeightFeet} ft |

The **Universal Affordability Preference** adds ${fmtSqft(env.floorArea.maxFloorAreaSqft - asOfRight)} as of right when that floor area is kept permanently affordable [1]. On a wide street the street wall rises ${env.summary.baseHeightMinFeet} to ${env.summary.baseHeightMaxFeet} ft before a setback [2].

Modeled on this lot, the UAP building is about **${uap.metrics.storeys} storeys and ${fmtNumber(uap.metrics.heightFeet)} ft**, so floor area runs out well before the height limit. Treat these as starting points to verify against the current text and a survey.`,
    },
    {
      label: `Does ${fmtMoney(v("assumptions").landPrice)} work?`,
      prompt: `Does ${fmtMoney(v("assumptions").landPrice)} work for a rental at ${name}?`,
      steps: [["acres_market_inputs", {}], ["acres_unit_mix", {}], ["acres_pro_forma", {}], ["acres_compare_programs", {}]],
      sources: [ZR("23-22", "article-ii/chapter-3")],
      text: `## Does ${fmtMoney(v("assumptions").landPrice)} work?

**${{ supports_price: "Yes, with little room.", below_price: "Not at this price.", no_land_value: "No." }[cmp.decision.call]}** ${cmp.decision.verdict}

| Program | Value | Total cost | Profit | Return on cost | Highest land price at 12% |
|---|---|---|---|---|---|
${rows}

The UAP scheme builds more, but keeping 20 percent of the homes affordable lowers its rent roll more than the extra floor area adds [1]. The as-of-right building yields ${fmtRate(pf.operations.yieldOnCost)} on cost against a ${fmtRate(pf.operations.capRate)} exit cap rate.

Costs assume $450 per gross sq ft hard and $99 soft, 65 percent loan to cost at 7.25 percent. Change any of them and the numbers re-run.`,
    },
    {
      label: "What should I check before an offer?",
      prompt: `What should I check at ${name} before making an offer?`,
      steps: [["acres_nyc_public_records", {}], ["acres_development_ledger", {}], ["acres_zoning_envelope", { district: p.zonedist1 }]],
      sources: [ZR("12-10", "article-i/chapter-2"), DOB, HCR, PLUTO],
      text: `## Before an offer on ${name}

1. **The street width.** The envelope treats Fulton Street as a wide street, 75 ft or more, which sets the setback and the heights [1]. Confirm it on the City Map.
2. **Filings and violations.** Pull the building's DOB record for open permits, violations and any stop work order [2].
3. **Tenants.** The building dates from ${p.yearbuilt}. Check for rent-registered units and anyone in place, which change the timeline and the cost of delivery [3].
4. **The lot itself.** Lot size and frontage come from MapPLUTO [4]; a survey settles them before the price does.

Nothing in the parcel record flags a landmark, historic district, flood zone or E-designation here.`,
    },
  ];
}

const messages = document.getElementById("messages");
const scroller = document.getElementById("main");
const suggestions = document.getElementById("suggestions");
const composer = document.getElementById("composer");
const prompt = document.getElementById("prompt");
const dialog = document.getElementById("source-dialog");
let asked = [], busy = false, list = [], answered = 0;

const follow = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduced() ? "auto" : "smooth" });

function chips() {
  suggestions.hidden = busy;
  suggestions.replaceChildren(...list.filter((q) => !asked.includes(q)).map((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q.label;
    b.addEventListener("click", () => void ask(q));
    return b;
  }));
}

function userTurn(text) {
  const el = document.createElement("article");
  el.className = "message user new-message";
  const b = document.createElement("div");
  b.textContent = text;
  el.append(b);
  messages.append(el);
}

const answerHtml = (text, index, sources) => DOMPurify.sanitize(marked.parse(text)).replace(/\[(\d+)\]/g, (match, n) =>
  sources[n - 1] ? `<button class="citation" data-message="${index}" data-source="${n}" aria-label="Read source ${n}">${n}</button>` : match);

async function ask(q) {
  if (busy) return;
  busy = true;
  asked.push(q);
  document.getElementById("welcome").hidden = true;
  chips();
  userTurn(q.prompt);
  const index = answered++;
  const live = document.createElement("article");
  live.className = "message assistant live-answer";
  live.innerHTML = `<div class="assistant-label">${LOGO}Arosa</div>`;
  const view = createActivityView();
  live.append(view.root);
  messages.append(live);
  follow();
  const started = performance.now();
  const items = [];
  view.update(items, "Starting research", true);
  await wait(700);
  for (const [tool, args] of q.steps) {
    items.push({ tool, arguments: args, status: "running" });
    view.update(items, describeStep(tool, args), true);
    follow();
    await wait(900 + Math.random() * 500);
    items.at(-1).status = "complete";
    view.update(items, "Researching", true);
  }
  // The answer is written in, a few words at a time.
  const answer = document.createElement("div");
  answer.className = "answer";
  live.append(answer);
  const words = q.text.split(/(\s+)/);
  const step = reduced() ? words.length : 6;
  for (let i = step; i < words.length + step; i += step) {
    view.update(items, "Writing answer", true);
    patchMarkup(answer, DOMPurify.sanitize(marked.parse(words.slice(0, i).join(""))));
    if (i % 60 === 0) follow();
    await wait(28);
  }
  // Settled: the saved answer with its citations, its sources and the time it took.
  const sources = q.sources.map((s, i) => ({ id: i + 1, ...s }));
  const done = document.createElement("article");
  done.className = "message assistant";
  done.innerHTML = `<div class="assistant-label">${LOGO}Arosa</div>`;
  const saved = createActivityView();
  saved.update(items, formatWorkedDuration(Math.round((performance.now() - started) * 11)), false);
  const body = document.createElement("div");
  body.className = "answer";
  body.innerHTML = answerHtml(q.text, index, sources);
  decorateAnswerHeader(body, { completedAt: Date.now(), hasSources: true });
  done.append(saved.root, body, sourceList(sources, index));
  done.sources = sources;
  live.replaceWith(done);
  busy = false;
  chips();
  follow();
}

// A question of the visitor's own gets an honest reply: this preview answers the examples.
async function askOwn(text) {
  if (busy) return;
  busy = true;
  chips();
  document.getElementById("welcome").hidden = true;
  userTurn(text);
  await wait(500);
  const el = document.createElement("article");
  el.className = "message assistant";
  el.innerHTML = `<div class="assistant-label">${LOGO}Arosa</div><div class="answer"><p>This preview answers the example questions about 1234 Fulton St. Open Arosa to ask about any US address.</p></div>`;
  const link = document.createElement("a");
  link.className = "home-follow primary demo-open";
  link.href = "https://build.witharosa.ai";
  link.target = "_top";
  link.textContent = "Open Arosa";
  el.append(link);
  messages.append(el);
  busy = false;
  chips();
  follow();
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = prompt.value.trim();
  if (!text || busy) return;
  prompt.value = "";
  const match = list.find((q) => q.prompt.toLowerCase() === text.toLowerCase());
  void (match ? ask(match) : askOwn(text));
});
prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); composer.requestSubmit(); }
});
messages.addEventListener("click", (e) => {
  const b = e.target.closest("[data-source]");
  if (!b) return;
  const message = b.closest(".message");
  const source = message?.sources?.find((s) => s.id === Number(b.dataset.source));
  if (!source) return;
  fillSourceDialog(source);
  dialog.showModal();
});
document.getElementById("close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

// From another embed: asking about the example site starts its first question.
listen("ask", ({ id }) => { if ((!id || id === "ex-fulton") && !asked.length) void ask(list[0]); });
listen("visible", () => { if (!asked.length) void ask(list[0]); });

await ready;
list = questions(await loadSite("ex-fulton"));
chips();
tell("ready");
