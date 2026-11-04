// See the building: step 2 of the app's site page on its own, with the concept versions, the 3D
// massing and the envelope controls open beside it.
import { tell, listen, ready } from "/demo/shell.js";
import { renderParcel } from "/app/core-view.js";
import { loadSite } from "/demo/site-run.js";
import { massingView } from "/demo/massing-view.js";

const root = document.getElementById("build");
let state = null, selectedConceptId = null, token = 0;

function render() {
  const open = new Set([...root.querySelectorAll("details[data-disclosure][open]")].map((d) => d.dataset.disclosure));
  const page = renderParcel(state, { canSend: true, canEdit: false, selectedConceptId, conceptViewer: (concept) => massingView(concept, { height: innerWidth < 600 ? 300 : 440 }) });
  const step = page.querySelector("#core-step-build");
  step.querySelector(".uw-marker").textContent = "";
  for (const d of step.querySelectorAll("details[data-disclosure]")) d.open = open.has(d.dataset.disclosure);
  const list = document.createElement("ol");
  list.className = "uw-steps";
  list.append(step);
  const article = document.createElement("article");
  article.className = "core-parcel uw";
  const where = page.querySelector(".uw-header");
  article.append(where, list);
  root.replaceChildren(article);
}

async function open(id) {
  const mine = ++token;
  const next = await loadSite(id);
  if (mine !== token) return;
  state = next;
  selectedConceptId = null;
  render();
}

root.addEventListener("click", (e) => {
  const target = e.target.closest("button, a");
  if (!target) return;
  if (target.matches("a[data-route]")) { e.preventDefault(); return; }
  if (target.dataset.concept) { selectedConceptId = target.dataset.concept; render(); return; }
  if (target.dataset.followAction || target.hasAttribute("data-open-chat")) tell("ask", { id: state.id, address: state.title });
});

listen("site", ({ id }) => void open(id));
await ready;
await open("ex-fulton");
tell("ready");
