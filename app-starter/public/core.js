// Core page controller: screen mode lists the user's sites;
// parcel mode renders one project's state, saves assumptions and follows live updates;
// plan mode hosts the floor plan editor for one project beside the chat.
import { chatRequest, patchChat, postChat } from "./chat-api.js";
import { renderParcel, renderArchitecture, massingBlock, fmtDate, siteSkeleton, failLine, retryButton, loadingStatus } from "./core-view.js";
import { underwritingChecklist } from "./core-model.js";
import { timeLine } from "./run-trail.js";
import { saveProjectFields, shouldRefetch, readAssumptions, collectSources, architectureView, architectureEventAffects, siteName, displayAddress, siteProgress, fmtMoney, stateField } from "./core-model.js";
import { nearbyPipelineQuery } from "./nearby-pipeline.js";
import { bindFilterPopover } from "./filter-popover.js";
import { skel } from "./skeleton.js";
import { underwritePrompt } from "./home.js";
import { fillSourceDialog } from "./source-view.js";
import { mountDealsScreen, dealsAvailable } from "./deals.js";
import { routePath, linkOrigin } from "./core-route.js";
import { restoreRevision, DEFAULT_SCHEME, schemeQuery } from "./plan-intake.js";
import { schemeFromSearch, renderSchemeSwitcher } from "./plan-schemes.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const HOUSING_GOALS = [
  {id: 'capacity', label: 'Explore the site’s housing potential', request: 'Create a preliminary 3D building shape that makes the most of the available capacity.'},
  {id: 'another-home', label: 'Make room for one more home', request: 'Explore whether an accessory dwelling or another small home could fit while keeping the existing building. Check the applicable dwelling, access and setback rules before proposing a location; do not assume an ADU is allowed.'},
  {id: 'addition', label: 'Add space to an existing home', request: 'Explore an addition to the existing home. Establish what is known about the existing footprint and height, then identify where additional space might fit. Do not assume the existing structure can support an extra storey.'},
  {id: 'infill', label: 'Explore a small infill housing project', request: 'Explore a small housing project suited to this site, with practical access and open space. Compare a modest housing option with the allowed capacity rather than assuming the largest building is the best fit.'},
];

// The chat beside a site is the app's docked chat; setChatOpen opens or closes it (app.js).
export function createCorePage({ root, navigate, underwrite, pendingBox, conversationId, canSend, mountConcept, mountArchitecture, mountPlan, architectureEnabled, setChatOpen = () => {}, onSiteTitle = () => {} }) {
  const api = { get: (path) => chatRequest(path), patch: (path, body) => patchChat(path, body), post: (path, body) => postChat(path, body) };
  let mode = null;
  let current = null;
  let projectId = null;
  let scrollTarget = null;
  // A new visit owns its requests, including a return to the same project.
  let pageGeneration = 0;
  let events = null;
  let refreshing = null;
  let refreshAgain = false;
  let selectedConceptId = null;
  let housingGoal = 'capacity';
  let housingNotes = '';
  let assumptionStatus = "";
  const viewers = new Map();
  // Architecture section: null when the session does not enable it, else {status, summary, view, starting, runError}.
  let architecture = null;
  // The plan page shows one scheme's plan; the site page shows the as-of-right plan.
  let planScheme = DEFAULT_SCHEME;
  let architectureLoad = null;
  let architectureAgain = false;
  // In the news: {bbl, stories} for the site's lot; stories is null while loading.
  let news = null;
  const walkthroughs = new Map();
  let planMount = null;
  // The plan page's stage: true shows the 3D walkthrough, otherwise the editor.
  let walkthroughOpen = null;
  let massingOpen = false;
  // Starting mode's pending site.
  let starting = null;
  let siteSearchGeneration = 0;
  let siteSearchTimer = null;
  // The site conversation's live run, {label, tools, trail, startedAt, typicalMs}, reported by the
  // app; null when idle.
  let run = null;
  // While a run shows, its time line moves on between the run's own events.
  let clockTimer = null;
  let runFailure = null;
  // A request clicked on this page: {field, action}. The page shows it as starting at once, shows
  // the run in that step once it reports, and drops it when the run ends or fails.
  let pending = null;
  let pendingTimer = null;
  // The full underwriting this page last sent: {since, plan, ended}. Once its run ends or fails, the page
  // shows what each section holds against when it was sent.
  let fullRun = null;
  // A floor plan draft this page asked for ended without a plan: the card offers Retry.
  // What is being built around the site, fetched once per parcel location: {query, read}, read null while loading.
  let nearby = null;
  // The three ways to build the site: {id, version, read}, read null while the first read is under way.
  let schemes = null;
  // Draft all three floor plans from the site page: {drafting, started, error}.
  // Saved sites: each card's progress, fetched as the card scrolls into view, by project version.
  const progress = new Map();
  let siteObserver = null;
  const progressQueue = [];
  let progressInFlight = 0;
  const listingsAvailable = dealsAvailable();

  function setChatCollapsed(collapsed, { remember = true } = {}) {
    setChatOpen(!collapsed, { remember });
  }

  // The 3D viewer is expensive: keep one mounted element per concept version across re-renders.
  function conceptViewer(concept) {
    const key = `${concept.id}:${concept.version ?? ""}:${concept.createdAt ?? ""}`;
    let node = viewers.get(key);
    if (!node) {
      node = el("div", "core-concept-mount");
      viewers.set(key, node);
      loadConcept(node, concept);
    }
    return node;
  }

  function loadConcept(node, concept) {
    node.replaceChildren(loadingStatus("Loading the 3D model"), skel("core-viewer-skel"));
    const places = current?.fields?.places?.value || [];
    const modelingProjectId = mode === 'plan' && current?.workflow === 'modeling' && current.access !== 'viewer' ? projectId : null;
    queueMicrotask(() => mountConcept(node, concept, places, {modelingProjectId}).catch(() => {
      const retry = retryButton("conceptRetry");
      retry.addEventListener("click", () => loadConcept(node, concept));
      node.replaceChildren(failLine("The 3D model did not load.", [retry]));
    }));
  }

  function clearViewers() {
    for (const node of viewers.values()) window.acresConceptView?.unmount(node);
    viewers.clear();
    for (const node of walkthroughs.values()) window.acresArchitectureView?.unmount(node.querySelector(".core-arch-mount"));
    walkthroughs.clear();
  }

  // One mounted walkthrough per succeeded job; the viewer shows the selected room itself.
  function architectureViewer(view) {
    let node = walkthroughs.get(view.viewer.key);
    if (node) return node;
    node = el("div", "core-arch-walkthrough");
    const mount = el("div", "core-arch-mount");
    node.append(mount);
    walkthroughs.set(view.viewer.key, node);
    loadWalkthrough(mount, view);
    return node;
  }

  function loadWalkthrough(mount, view) {
    mount.replaceChildren(loadingStatus("Loading the walkthrough"), skel("core-viewer-skel"));
    const { glbUrl, manifestUrl, pascalSceneUrl } = view.viewer;
    queueMicrotask(async () => {
      try {
        const pascalScene = pascalSceneUrl ? await (await fetch(pascalSceneUrl)).json() : null;
        mount.replaceChildren();
        await mountArchitecture(mount, { plan: view.plan, glbUrl, manifestUrl, pascalScene });
      } catch {
        const retry = retryButton("walkthroughRetry");
        retry.addEventListener("click", () => loadWalkthrough(mount, view));
        mount.replaceChildren(failLine("The 3D walkthrough did not load.", [retry]));
      }
    });
  }

  async function refreshNews(bbl) {
    const generation = pageGeneration;
    news = { bbl, stories: null };
    const result = await api.get(`/news/lots/${encodeURIComponent(bbl)}`).catch(() => ({ stories: [] }));
    if (generation !== pageGeneration || news?.bbl !== bbl) return;
    news = { bbl, stories: result.stories };
    renderState();
  }

  async function refreshArchitecture() {
    if (architectureLoad) { architectureAgain = true; return architectureLoad; }
    const id = projectId, scheme = planScheme;
    const generation = pageGeneration;
    architectureLoad = (async () => {
      try {
        const summary = await api.get(`/projects/${encodeURIComponent(id)}/architecture${schemeQuery(scheme)}`);
        // A load for the scheme the page has switched away from is dropped.
        if (generation !== pageGeneration || scheme !== planScheme) return;
        // An open read-only revision and a restore in progress survive the refresh a new revision causes.
        const { viewing = null, restoring = null, restoreError = null } = architecture || {};
        architecture = { status: "ready", summary, view: architectureView(id, summary), viewing, restoring, restoreError };
      } catch (error) {
        if (generation !== pageGeneration) return;
        architecture = { status: "error", error: error.message };
      } finally {
        if (generation === pageGeneration) architectureLoad = null;
      }
      renderState();
      if (architectureAgain && id === projectId) { architectureAgain = false; void refreshArchitecture(); }
    })();
    return architectureLoad;
  }

  async function runWalkthrough(revision) {
    const id = projectId;
    const generation = pageGeneration;
    architecture = { ...architecture, starting: true, runError: null };
    renderState();
    try {
      await api.post(`/projects/${encodeURIComponent(id)}/architecture/jobs`, { revision, ...(planScheme === DEFAULT_SCHEME ? {} : { scheme: planScheme }) });
      if (generation !== pageGeneration) return;
      architecture = { ...architecture, starting: false };
    } catch (error) {
      if (generation !== pageGeneration) return;
      architecture = { ...architecture, starting: false, runError: error.message };
    }
    await refreshArchitecture();
  }

  // A saved revision opened read only beside the current one.
  async function openRevision(revision) {
    const id = projectId, generation = pageGeneration;
    architecture = { ...architecture, viewing: { revision, status: "loading" } };
    renderState();
    try {
      const body = await api.get(`/projects/${encodeURIComponent(id)}/architecture/revisions/${revision}${schemeQuery(planScheme)}`);
      if (generation !== pageGeneration || architecture.viewing?.revision !== revision) return;
      architecture = { ...architecture, viewing: { revision, status: "ready", view: architectureView(id, { current: body, revisions: architecture.summary.revisions }) } };
    } catch (error) {
      if (generation !== pageGeneration || architecture.viewing?.revision !== revision) return;
      architecture = { ...architecture, viewing: { revision, status: "error", error: error.message } };
    }
    renderState();
  }

  async function restorePlanRevision(revision) {
    const id = projectId, generation = pageGeneration;
    architecture = { ...architecture, restoring: revision, restoreError: null };
    renderState();
    let restoreError = null;
    try {
      const result = await restoreRevision({ fetch, projectId: id, revision, current: architecture.view.revision, scheme: planScheme });
      if (result.status === "conflict") restoreError = "The plan changed since this page loaded; check the newest revision and try again.";
    } catch (error) {
      restoreError = error.message;
    }
    if (generation !== pageGeneration) return;
    architecture = { ...architecture, restoring: null, restoreError, viewing: restoreError ? architecture.viewing : null };
    await refreshArchitecture();
  }

  function renderState() {
    if (mode === "plan") { renderWalkthrough(); renderSchemes(); return; }
    if (mode !== "parcel" || !current) return;
    const form = root.querySelector("#core-assumptions-form");
    const dirty = form ? [...form.elements].filter((i) => i.name && i.value !== i.dataset.initial).map((i) => [i.name, i.value]) : [];
    const unsaved = [...root.querySelectorAll("textarea[data-instructions]")]
      .filter((b) => b.value.trim() !== b.dataset.initial)
      .map((b) => [b.dataset.instructions, b.value]);
    const focused = document.activeElement?.dataset?.instructions;
    // Live updates redraw the page; disclosures the reader opened or closed stay that way.
    const disclosures = new Map([...root.querySelectorAll("details[data-disclosure]")].map((d) => [d.dataset.disclosure, d.open]));
    const scrollTop = root.scrollTop;
    const ctx = {
      canSend: canSend(),
      canEdit: canSend(),
      selectedConceptId,
      assumptionStatus,
      conceptViewer,
      architecture,
      architectureViewer,
      news,
      run,
      runFailure,
      pending,
      checklist: fullRun?.ended ? underwritingChecklist(current, fullRun.since) : null,
      onCopySiteLink: (id) => navigator.clipboard.writeText(`${linkOrigin()}${routePath({ view: "site", projectId: id })}`),
      onExportDeck: conversationId() ? () => window.open(`/api/conversations/${encodeURIComponent(conversationId())}/deck?format=html`, "_blank", "noopener") : null,
      nearbyPipeline: nearbyFor(current),
      schemes: schemesFor(current),
    };
    root.replaceChildren(renderParcel(current, ctx));
    // A hidden panel the reader opened (an empty notes box) stays open and visible.
    for (const d of root.querySelectorAll("details[data-disclosure]")) {
      if (disclosures.has(d.dataset.disclosure)) d.open = disclosures.get(d.dataset.disclosure);
      if (d.open) d.hidden = false;
    }
    // The app's top bar and main menu name the site the page shows.
    onSiteTitle(projectId, root.querySelector(".core-title")?.textContent || null);
    const next = root.querySelector("#core-assumptions-form");
    for (const [name, value] of dirty) if (next?.elements[name]) next.elements[name].value = value;
    for (const [id, value] of unsaved) { const box = root.querySelector(`textarea[data-instructions="${id}"]`); if (box) box.value = value; }
    if (focused) root.querySelector(`textarea[data-instructions="${focused}"]`)?.focus({ preventScroll: true });
    root.scrollTop = scrollTop;
    scrollToTarget();
  }

  // The site's nearby pipeline, or undefined until the parcel is located; a first call starts the load
  // and the page draws again when it lands.
  function nearbyFor(state) {
    const p = stateField(state, "property")?.value;
    const query = p ? nearbyPipelineQuery({ latitude: p.latitude, longitude: p.longitude, zip: p.zipcode, bbl: p.bbl }) : null;
    if (!query) return undefined;
    if (nearby?.query !== query) {
      const load = nearby = { query, read: null };
      api.get(`/nearby-pipeline?${query}`)
        .then((read) => { load.read = read; }, () => { load.read = { available: false }; })
        .then(() => { if (nearby === load) renderState(); });
    }
    return nearby.read;
  }

  // The site's three schemes, undefined until the parcel is identified. They are read again when the
  // site's state moves past the version they were priced at (reading them can itself save them).
  function schemesFor(state) {
    if (!stateField(state, "property")?.value?.bbl) return undefined;
    const known = schemes?.id === state.id ? schemes : null;
    if (!known || (known.read && state.version > known.version)) {
      const load = schemes = { id: state.id, version: state.version, read: known?.read?.error ? null : known?.read ?? null };
      api.get(`/projects/${encodeURIComponent(state.id)}/schemes`)
        .then((read) => { load.read = read; load.version = Math.max(load.version, read.version); }, (error) => { load.read = { error: error.message }; })
        .then(() => { if (schemes === load) renderState(); });
    }
    return schemes.read ?? { loading: true };
  }

  // A link to a section (#core-architecture) scrolls to it once the page has drawn it.
  function scrollToTarget() {
    const target = scrollTarget && root.querySelector("#" + scrollTarget);
    if (!target) return;
    scrollTarget = null;
    target.scrollIntoView({ block: "start" });
  }

  function renderMessage(title, message, retry = false) {
    const box = el("div", "core-message");
    const back = el("a", "core-back", "All sites");
    back.href = "/sites";
    back.dataset.route = "/sites";
    box.append(back, el("h1", "core-title", title));
    box.append(retry ? failLine(message, [retryButton("siteRetry")]) : el("p", "core-note", message));
    root.replaceChildren(box);
  }

  async function refresh() {
    if (mode === 'plan') return refreshModelingState();
    if (refreshing) { refreshAgain = true; return refreshing; }
    const id = projectId;
    const generation = pageGeneration;
    refreshing = (async () => {
      try {
        const next = await api.get(`/projects/${encodeURIComponent(id)}/state`);
        if (generation !== pageGeneration || mode !== "parcel") return;
        if (current && next.version < current.version) return;
        if (current && next.version > current.version) {
          const groups = [['property','core-property','Property'],['envelope','core-step-build','Buildable area'],['market','core-step-worth','Market'],['proFormas','core-step-worth','Financials'],['comparisons','core-step-decide','Decision'],['entitlements','core-step-build','Approval paths']];
          const sections = groups.filter(([field]) => next.fields?.[field]?.provenance?.run && JSON.stringify(current.fields?.[field]?.value) !== JSON.stringify(next.fields?.[field]?.value)).map(([,id,label]) => ({id,label}));
          document.dispatchEvent(new CustomEvent('acres-site-updated',{detail:{id,sections}}));
        }
        current = next;
        document.title = `${siteName(current)} · Arosa`;
        const bbl = current.fields?.property?.value?.bbl;
        if (bbl && news?.bbl !== bbl) void refreshNews(bbl);
        renderState();
        regenerateIfAsked();
      } catch (error) {
        if (generation !== pageGeneration) return;
        if (error.status === 404 || error.status === 403) renderMessage("Site not available", "This site does not exist or is not shared with your account.");
        else if (!current) renderMessage("Site could not load", error.message, true);
      } finally {
        if (generation === pageGeneration) {
          refreshing = null;
          if (refreshAgain) { refreshAgain = false; void refresh(); }
        }
      }
    })();
    return refreshing;
  }

  function subscribe(id) {
    events?.close();
    events = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
    // Named events carry their name as the type; unnamed ones carry it in the data, defaulting to state.updated.
    const onEvent = (e) => {
      const data = { event: e.type && e.type !== "message" ? e.type : "state.updated", ...JSON.parse(e.data) };
      if (architecture && architectureEventAffects(data, id)) void refreshArchitecture();
      // Another conversation's site for this lot merged in: its research and chats are now here.
      if (data.event === "site.merged" || (data.event === "state.updated" && shouldRefetch(data, current))) void refresh();
    };
    events.addEventListener("state.updated", onEvent);
    events.addEventListener("architecture.job", onEvent);
    events.onmessage = onEvent;
  }

  async function saveAssumptions(form) {
    const generation = pageGeneration;
    const entries = Object.fromEntries([...form.elements].filter((i) => i.name).map((i) => [i.name, i.value]));
    let value;
    try { value = readAssumptions(entries); }
    catch (error) { assumptionStatus = error.message; form.querySelector(".core-form-status").textContent = error.message; return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    form.querySelector(".core-form-status").textContent = "Saving…";
    let saved = false;
    try {
      const next = await saveProjectFields(api, projectId, current, { assumptions: value });
      if (generation !== pageGeneration) return;
      if (next.version >= current.version) current = next;
      assumptionStatus = "Saved. Update the underwriting to apply your numbers.";
      saved = true;
      for (const input of form.elements) if (input.name) input.dataset.initial = entries[input.name];
    } catch (error) {
      if (generation !== pageGeneration) return;
      if (error.latest && error.latest.version > current.version) current = error.latest;
      assumptionStatus = error.message;
    }
    renderState();
    const activeForm = root.querySelector("#core-assumptions-form");
    if (saved && [...activeForm.elements].some((input) => input.name && input.value !== input.dataset.initial)) {
      assumptionStatus = "Saved, but you have newer unsaved edits.";
      activeForm.querySelector(".core-form-status").textContent = assumptionStatus;
    }
  }

  // Underwriting runs and plan drafts report progress where they were asked for; explanations,
  // reviews and revisions are read in the chat.
  const ANSWERED_IN_CHAT = new Set(["explain", "review", "revise"]);
  // The click shows as starting in its step and in the status line before the run reports back.
  function markPending(field, action, extra = {}) {
    pending = { field, action, ...extra };
    clearTimeout(pendingTimer);
    // A request that never starts a run (the chat refused or queued it) stops showing as starting.
    pendingTimer = setTimeout(() => { pending = null; rerender(); }, 20000);
    rerender();
  }
  function rerender() {
    if (mode === "parcel") renderState();
    else if (mode === "plan") renderWalkthrough();
  }
  // Regenerate from a listing waits for the site to load, then sends what the page's own Regenerate sends.
  let regenerateWhenLoaded = false;
  function regenerateIfAsked() {
    if (!regenerateWhenLoaded || mode !== "parcel" || !current) return;
    regenerateWhenLoaded = false;
    markPending("all", "regenerate");
    fullRun = { since: Date.now(), ended: false };
    followUp("all", "regenerate", { instructions: current.fields.instructions?.value || {} });
  }
  function followUp(field, action, extra = {}) {
    document.dispatchEvent(new CustomEvent("acres-follow-up", { detail: { ref: { conversation: conversationId(), field, action, ...extra } } }));
    if (ANSWERED_IN_CHAT.has(action)) setChatCollapsed(false, { remember: false });
  }

  function readInstructions() {
    return Object.fromEntries([...root.querySelectorAll("textarea[data-instructions]")].map((box) => [box.dataset.instructions, box.value.trim()]));
  }

  // Saves every section's instructions when any of them changed, so the agent sees them in the project state.
  // Saves run one after another so each sends the version the previous one returned.
  let instructionSave = Promise.resolve();
  function saveInstructions() {
    const generation = pageGeneration;
    instructionSave = instructionSave.catch(() => {}).then(() => {
      if (generation === pageGeneration) return writeInstructions();
    });
    return instructionSave;
  }

  async function writeInstructions() {
    const generation = pageGeneration;
    const value = readInstructions();
    const saved = current?.fields?.instructions?.value || {};
    if (Object.keys(value).every((id) => (saved[id] || "") === value[id])) return;
    const statuses = [...root.querySelectorAll(".core-instructions-status")];
    statuses.forEach((s) => { s.textContent = "Saving…"; });
    try {
      const next = await saveProjectFields(api, projectId, current, { instructions: value });
      if (generation !== pageGeneration) return;
      if (next.version >= current.version) current = next;
      const saved = current.fields?.instructions?.value || {};
      for (const box of root.querySelectorAll("textarea[data-instructions]")) {
        const id = box.dataset.instructions;
        if (box.value.trim() === (value[id] || "")) box.value = saved[id] || "";
        box.dataset.initial = saved[id] || "";
      }
      root.querySelectorAll(".core-instructions-status").forEach((s) => { s.textContent = ""; });
    } catch (error) {
      if (generation !== pageGeneration) return;
      if (error.latest) {
        if (error.latest.version > current.version) current = error.latest;
        renderState();
      }
      root.querySelectorAll(".core-instructions-status").forEach((s) => { s.textContent = error.message; });
      throw error;
    }
  }

  async function doAll(button, action = "all") {
    const generation = pageGeneration;
    button.disabled = true;
    markPending("all", action);
    try {
      await saveInstructions();
      if (generation !== pageGeneration) return;
      fullRun = { since: Date.now(), ended: false };
      followUp("all", action, { instructions: readInstructions() });
    } catch (error) {
      // The notes did not save, so nothing was sent; their status line says why.
      if (generation !== pageGeneration) return;
      pending = null;
      clearTimeout(pendingTimer);
      rerender();
      root.querySelectorAll(".core-instructions-status").forEach((s) => { s.textContent = error.message; });
    } finally {
      button.disabled = false;
    }
  }

  function openSource(source) {
    fillSourceDialog(source);
    document.querySelector("#source-dialog").showModal();
  }

  // A step's More menu binds its popover on first use, so a redrawn page holds no stale bindings.
  root.addEventListener("click", (e) => {
    const summary = e.target.closest(".uw-menu > summary");
    if (!summary || summary.parentElement.dataset.bound) return;
    const menu = summary.parentElement;
    const panel = menu.querySelector(".uw-menu-body");
    bindFilterPopover(menu, panel);
    panel.setAttribute("aria-label", panel.dataset.menuLabel);
    menu.dataset.bound = "true";
  }, true);
  // An emptied notes panel the reader closes goes back behind the More menu.
  root.addEventListener("toggle", (e) => {
    const notes = e.target;
    if (notes.matches?.(".uw-notes") && !notes.open && ![...notes.querySelectorAll("textarea")].some((t) => t.value.trim())) notes.hidden = true;
  }, true);

  function openNotes(stepId) {
    const notes = root.querySelector(`details[data-disclosure="notes-${stepId}"]`);
    notes.hidden = false;
    notes.open = true;
    notes.querySelector("textarea")?.focus();
  }

  // Opens Your numbers at one group of fields (keeping the building sits below the build-new numbers).
  function openNumbers(group) {
    const numbers = root.querySelector('details[data-disclosure="numbers"]');
    if (!numbers) return;
    numbers.open = true;
    const grid = numbers.querySelector(`[data-group="${group}"]`) || numbers;
    grid.scrollIntoView({ block: "center" });
    grid.querySelector("input:not([disabled])")?.focus({ preventScroll: true });
  }

  root.addEventListener("click", (e) => {
    // A choice in a More menu closes the menu.
    const menu = e.target.closest(".uw-menu-body")?.closest("details");
    if (menu && e.target.closest("button")) menu.open = false;
    const follow = e.target.closest("[data-follow-field]");
    if (["all", "regenerate"].includes(follow?.dataset.followAction)) { void doAll(follow, follow.dataset.followAction); return; }
    if (follow) {
      const note = follow.closest(".uw-step, .core-section")?.querySelector("textarea[data-instructions]")?.value || "";
      // The plan editor's own draft button shows its progress on the canvas.
      if (!("planCanvas" in follow.dataset)) markPending(follow.dataset.followField, follow.dataset.followAction);
      followUp(follow.dataset.followField, follow.dataset.followAction, { ...(note.trim() ? { note } : {}), ...(follow.dataset.followDrawing ? { drawing: follow.dataset.followDrawing } : {}) });
      return;
    }
    const notesOpen = e.target.closest("[data-notes-open]");
    if (notesOpen) { openNotes(notesOpen.dataset.notesOpen); return; }
    const numbersOpen = e.target.closest("[data-numbers-open]");
    if (numbersOpen) { openNumbers(numbersOpen.dataset.numbersOpen); return; }
    if (e.target.closest("[data-schemes-retry]")) { schemes = null; renderState(); return; }
    if (e.target.closest("[data-site-retry]")) { root.replaceChildren(siteSkeleton()); void refresh(); return; }
    if (e.target.closest("[data-architecture-retry]")) { architecture = { status: "loading" }; rerender(); void refreshArchitecture(); return; }
    if (e.target.closest("[data-plan-retry]")) { loadPlanEditor(); return; }
    const schemeTab = e.target.closest("[data-plan-scheme]");
    if (schemeTab) { switchScheme(schemeTab.dataset.planScheme); return; }
    const run = e.target.closest("[data-architecture-run]");
    if (run) { void runWalkthrough(Number(run.dataset.architectureRun)); return; }
    const revisionOpen = e.target.closest("[data-revision-open]");
    if (revisionOpen) { void openRevision(Number(revisionOpen.dataset.revisionOpen)); return; }
    const revisionRestore = e.target.closest("[data-revision-restore]");
    if (revisionRestore) { void restorePlanRevision(Number(revisionRestore.dataset.revisionRestore)); return; }
    if (e.target.closest("[data-revision-close]")) { architecture = { ...architecture, viewing: null }; renderState(); return; }
    const planOpen = e.target.closest("[data-plan-open]");
    if (planOpen) { navigate(routePath({ view: "plan", projectId }) + (planOpen.dataset.planOpen ? `#${planOpen.dataset.planOpen}` : "")); return; }
    if (e.target.closest("[data-open-chat]")) { setChatCollapsed(false, { remember: false }); return; }
    const concept = e.target.closest(".core-version[data-concept]");
    if (concept) { selectedConceptId = concept.dataset.concept; renderMassing(); return; }
    const source = e.target.closest("[data-state-source]");
    if (source) { openSource(collectSources(current)[Number(source.dataset.stateSource)]); return; }
    const site = e.target.closest("[data-project]");
    if (site) { navigate(`/sites/${encodeURIComponent(site.dataset.project)}`); }
  });
  root.addEventListener("change", (e) => {
    if (e.target.matches("textarea[data-instructions]")) void saveInstructions().catch(() => {});
  });
  root.addEventListener("submit", (e) => {
    if (e.target.id === "core-assumptions-form") { e.preventDefault(); void saveAssumptions(e.target); }
  });

  // Screen mode
  // Card placeholders shaped like the site cards: a title, a meta line and a progress line.
  function siteCardSkeletons(count = 6) {
    return Array.from({ length: count }, (_, i) => {
      const card = el("div", "core-site core-site-skeleton");
      card.setAttribute("aria-hidden", "true");
      card.append(skel("skel-text", { width: `${58 + (i % 3) * 12}%`, height: "15px" }), skel("skel-text", { width: "42%", height: "12px" }), skel("skel-text", { width: "64%", height: "12px", marginTop: "6px" }));
      return card;
    });
  }

  // A card's state: steps done and any refresh needed on one line, the land price and profit on the next.
  function progressLine(node, p) {
    const steps = el("span", "core-site-row");
    steps.append(el("span", "", p.done === 4 && !p.stale ? "Underwritten" : `${p.done} of 4 steps`));
    if (p.stale) steps.append(el("span", "core-site-stale", "Needs a refresh"));
    const figures = el("span", "core-site-row");
    if (p.landPrice > 0) figures.append(el("span", "", `Land ${fmtMoney(p.landPrice)}`));
    if (p.profit != null) figures.append(el("span", "", `Profit ${fmtMoney(p.profit)}`));
    node.replaceChildren(steps);
    if (figures.childNodes.length) node.append(figures);
  }

  // A card's progress loads when it scrolls into view, a few at a time.
  function pumpProgress() {
    while (progressInFlight < 4 && progressQueue.length) {
      const node = progressQueue.shift();
      if (!node.isConnected) continue;
      progressInFlight++;
      const { projectId: id, progressKey: key } = node.dataset;
      chatRequest(`/projects/${encodeURIComponent(id)}/state`)
        .then((state) => { progress.set(key, siteProgress(state)); if (node.isConnected) progressLine(node, progress.get(key)); })
        .catch(() => node.replaceChildren())
        .finally(() => { progressInFlight--; pumpProgress(); });
    }
  }

  function siteCard(p) {
    const card = el("button", "core-site");
    card.type = "button";
    card.dataset.project = p.id;
    const title = displayAddress(p.title);
    card.append(el("strong", "", title || (p.bbl ? `BBL ${p.bbl}` : "Untitled site")));
    const meta = [title && p.bbl ? `BBL ${p.bbl}` : "", p.updated ? `Updated ${fmtDate(p.updated)}` : ""].filter(Boolean).join(" · ");
    if (meta) card.append(el("small", "", meta));
    const line = el("span", "core-site-progress");
    line.dataset.projectId = p.id;
    line.dataset.progressKey = `${p.id}:${p.version}`;
    // The sites list carries each site's progress; an older server leaves it out and the card loads it.
    if (p.progress) progressLine(line, p.progress);
    else if (progress.has(line.dataset.progressKey)) progressLine(line, progress.get(line.dataset.progressKey));
    else {
      line.append(skel("skel-text", { width: "64%", height: "12px" }));
      siteObserver.observe(line);
    }
    card.append(line);
    return card;
  }

  async function loadSites(list, {more, status}, query = "", cursor = null) {
    const token = ++siteSearchGeneration;
    more.disabled = true;
    more.textContent = "Loading…";
    list.setAttribute("aria-busy", "true");
    status.textContent = cursor ? "Loading more sites…" : "";
    if (!cursor) {
      more.hidden = true;
      more.dataset.cursor = "";
      list.replaceChildren(...siteCardSkeletons());
    }
    const params = ["sitesOnly=true", query && "q=" + encodeURIComponent(query), cursor && "cursor=" + encodeURIComponent(cursor)].filter(Boolean).join("&");
    let page;
    try {
      page = await chatRequest("/projects" + (params ? "?" + params : ""));
    } catch (err) {
      if (token !== siteSearchGeneration) return;
      if (cursor) status.textContent = err.message;
      else list.replaceChildren(el("p", "core-empty", err.message));
      list.setAttribute("aria-busy", "false");
      more.hidden = false;
      more.disabled = false;
      more.textContent = "Retry";
      return;
    }
    if (token !== siteSearchGeneration) return;
    const {projects = []} = page;
    if (!cursor) list.replaceChildren();
    if (!projects.length && !cursor) {
      list.append(el("p", "core-empty", query ? "No sites match that search." : "No saved sites yet."));
    }
    const rows = projects.map(siteCard);
    list.append(...rows);
    list.setAttribute("aria-busy", "false");
    status.textContent = "";
    more.dataset.cursor = page.nextCursor || "";
    more.hidden = !page.nextCursor;
    more.disabled = false;
    more.textContent = "Load more sites";
    if (cursor && rows.length) rows[0].focus();
  }

  // The page's one primary action: start a new site from an address, as home does.
  function newSiteControl() {
    const wrap = el("div", "core-new-site");
    const open = el("button", "core-follow primary", "New site");
    open.type = "button";
    open.setAttribute("aria-expanded", "false");
    open.setAttribute("aria-controls", "core-new-site-form");
    const form = el("form", "core-new-site-form");
    form.id = "core-new-site-form";
    form.hidden = true;
    const input = el("input");
    input.type = "text";
    input.name = "address";
    input.required = true;
    input.autocomplete = "off";
    input.placeholder = "Street, city and state, or NYC BBL";
    input.setAttribute("aria-label", "Address or BBL of the new site");
    const submit = el("button", "core-follow primary", "Underwrite");
    submit.type = "submit";
    const cancel = el("button", "core-follow", "Cancel");
    cancel.type = "button";
    form.append(input, submit, cancel);
    const show = (on) => {
      form.hidden = !on;
      open.hidden = on;
      open.setAttribute("aria-expanded", String(on));
      if (on) input.focus();
      else open.focus();
    };
    open.addEventListener("click", () => show(true));
    cancel.addEventListener("click", () => show(false));
    form.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.isComposing) show(false); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      const { bbl, prompt } = underwritePrompt(value);
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
      submit.textContent = "Starting…";
      void Promise.resolve(underwrite(value, prompt, bbl, null, { open: true })).finally(() => {
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
        submit.textContent = "Underwrite";
      });
    });
    open.disabled = !canSend();
    wrap.append(open, form);
    return wrap;
  }

  function renderScreen() {
    const page = el("div", "core-screen");
    const head = el("header", "core-screen-head");
    head.append(el("h1", "core-title", "Underwriting"), newSiteControl());
    page.append(head);
    // Underwriting an address reports its progress here as well as on home.
    page.append(pendingBox());

    const sites = el("section", "core-sites");
    sites.setAttribute("aria-labelledby", "core-sites-title");
    const sitesHead = el("div", "core-sites-head");
    const sitesTitle = el("h2", "sr-only", "Your sites");
    sitesTitle.id = "core-sites-title";
    const search = el("input");
    search.type = "search";
    search.placeholder = "Search sites";
    search.setAttribute("aria-label", "Search sites");
    sitesHead.append(sitesTitle, search);
    const list = el("div", "core-site-list");
    list.id = "core-saved-sites";
    const more = el("button", "core-follow", "Load more sites");
    more.type = "button";
    more.dataset.loadSites = "";
    more.setAttribute("aria-controls", list.id);
    more.hidden = true;
    const status = el("p", "core-note");
    status.setAttribute("role", "status");
    const paging = {more, status};
    more.addEventListener("click", () => {
      if (!more.disabled) void loadSites(list, paging, search.value.trim(), more.dataset.cursor || null);
    });
    sites.append(sitesHead, list, status, more);
    page.append(sites);
    search.addEventListener("input", () => {
      ++siteSearchGeneration;
      clearTimeout(siteSearchTimer);
      more.hidden = true;
      more.disabled = true;
      more.dataset.cursor = "";
      status.textContent = "";
      siteSearchTimer = setTimeout(() => void loadSites(list, paging, search.value.trim()), 250);
    });
    siteObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        siteObserver.unobserve(entry.target);
        progressQueue.push(entry.target);
      }
      pumpProgress();
    }, { rootMargin: "200px" });
    void loadSites(list, paging);

    root.replaceChildren(page);
  }

  // Starting mode: a site Arosa is still resolving. The page lays out as the site will, with the
  // status where the parcel record appears; the app moves it to the site once it is identified.
  function renderStarting() {
    const state = { id: null, version: 0, title: starting.label, fields: {} };
    const ctx = { canSend: canSend(), canEdit: false, run, starting, pending: null, architecture: architectureEnabled() ? { status: "ready", view: null } : null };
    root.replaceChildren(renderParcel(state, ctx));
  }

  // Plan mode: one workspace that never scrolls as a page. The header leads back to the site (and
  // to the listing the plan was started from), switches the stage between the editor and the 3D
  // walkthrough, and opens the chat; the stage shows one of the two at full size.
  function renderPlan(id, { listingPath = null } = {}) {
    const page = el("div", "core-plan-page");
    const head = el("header", "core-plan-head");
    const crumbs = el("nav", "core-plan-crumbs");
    crumbs.setAttribute("aria-label", "Breadcrumb");
    const models=el('a','core-back','Modeling');models.href=models.dataset.route='/modeling';
    const here=el('span','modeling-project-name','Model');here.setAttribute('aria-current','page');
    crumbs.append(models,document.createTextNode(' / '),here);
    if (listingPath) {
      const listing = el("a", "core-back", "Back to listing");
      listing.href = listing.dataset.route = listingPath;
      crumbs.append(listing);
    }
    const views = el("div", "core-plan-views");
    views.setAttribute("role", "tablist");
    views.setAttribute("aria-label", "Plan view");
    for (const [part, label, controls] of [["editor", "Floor plan", "core-plan-mount"], ["walkthrough", "3D walkthrough", "core-plan-walkthrough"], ["massing", "Building model", "core-plan-massing"]]) {
      const button = el("button", "core-plan-view", label);
      button.type = "button";
      button.dataset.planView = part;
      button.setAttribute("aria-controls", controls);
      button.id = 'plan-tab-'+part;
      button.setAttribute('role','tab');button.setAttribute('aria-selected','false');button.tabIndex=-1;
      button.addEventListener('click', () => {
        const url=new URL(window.location.href);url.searchParams.set('view',part==='walkthrough'?'3d':part==='massing'?'massing':'plan');window.history.pushState(window.history.state,'',url.pathname+url.search+url.hash);walkthroughOpen=part==='walkthrough';massingOpen=part==='massing';renderWalkthrough();
      });
      button.addEventListener('keydown', e => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;e.preventDefault();const tabs=[...views.querySelectorAll('[role=tab]')];const next=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(button)+(e.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length];next.click();next.focus(); });
      views.append(button);
    }
    const identity=el('div','modeling-identity');
    identity.append(el('h1','core-title','Modeling'),el('p','modeling-address'));
    head.append(crumbs, identity, views);
    const schemes = el("div", "core-plan-schemes-slot");
    const stage = el("div", "core-plan-stage");
    const walkthrough = el("div", "core-plan-walkthrough");
    walkthrough.id = "core-plan-walkthrough";walkthrough.setAttribute('role','tabpanel');walkthrough.setAttribute('aria-labelledby','plan-tab-walkthrough');
    walkthrough.hidden = true;
    const massing = el('div','core-plan-massing');
    massing.id='core-plan-massing';massing.setAttribute('role','tabpanel');massing.setAttribute('aria-labelledby','plan-tab-massing');massing.hidden=true;
    const mount = el("div", "core-plan-mount");
    mount.id = "core-plan-mount";mount.setAttribute('role','tabpanel');mount.setAttribute('aria-labelledby','plan-tab-editor');
    planMount = mount;
    stage.append(walkthrough, massing, mount);
    page.append(head, schemes, stage);
    root.replaceChildren(page);
    renderSchemes();
    loadPlanEditor();
  }

  function renderSchemes() {
    const slot = root.querySelector(".core-plan-schemes-slot");
    if (!slot) return;
    const saved = architecture?.summary?.schemes || [];
    slot.hidden = !saved.some(s => s.scheme !== DEFAULT_SCHEME && s.revision);
    slot.replaceChildren(renderSchemeSwitcher({ scheme: planScheme, summary: architecture?.summary, existingOnly: true }));
  }

  // Opens another scheme's plan in place: the address names it, and the editor and walkthrough reload.
  function switchScheme(scheme) {
    if (scheme === planScheme) return;
    planScheme = scheme;
    history.replaceState(history.state, "", `${routePath({ view: "plan", projectId })}?scheme=${scheme}`);
    architectureLoad = null;
    architecture = { status: "loading" };
    renderSchemes();
    renderWalkthrough();
    loadPlanEditor();
    void refreshArchitecture();
  }

  // The editor's shape while its bundle loads: the toolbar row and the canvas.
  function planSkeleton() {
    const box = el("div", "core-plan-skeleton");
    const bar = el("div", "core-plan-skeleton-bar");
    for (const width of [96, 72, 200, 132]) bar.append(skel("skel-button", { width: `${width}px` }));
    box.append(loadingStatus("Loading the floor plan editor"), bar, skel("core-plan-skeleton-canvas"));
    return box;
  }

  function loadPlanEditor() {
    const mount = planMount;
    const id = projectId;
    mount.replaceChildren(planSkeleton());
    // A note from an editor that has since been unmounted (a late upload) is dropped.
    const onAction = (planNote) => {
      if (planMount === mount) document.dispatchEvent(new CustomEvent("acres-follow-up", { detail: { projectId: id, planNote } }));
    };
    mountPlan(mount, { projectId: id, scheme: planScheme, onAction }).catch(() => {
      if (planMount === mount) mount.replaceChildren(failLine("The floor plan editor did not load.", [retryButton("planRetry")]));
    });
  }

  // The plan page's 3D view: the walkthrough fills the stage, and the plan's facts, revisions and
  // actions sit in a column beside it. The editor stays mounted while it is hidden, so unsaved
  // drawing survives a look at the walkthrough. The page opens on the editor unless asked otherwise.
  function renderWalkthrough() {
    const panel = root.querySelector(".core-plan-walkthrough");
    if (!panel || !architecture) return;
    const hasPlan = architecture.view?.kind === "plan";
    const open = walkthroughOpen === true;
    for (const button of root.querySelectorAll("[data-plan-view]")) {
      const selected=button.dataset.planView===(massingOpen?'massing':open?'walkthrough':'editor');button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
    }
    root.querySelector('[data-plan-view="walkthrough"]').title = hasPlan ? `Walk the building made from revision ${architecture.view.revision} of this plan` : "Walk the building made from this plan, once it is saved";
    panel.hidden = !open;
    planMount.hidden = open || massingOpen;
    root.querySelector('#core-plan-massing').hidden = !massingOpen;
    renderMassing();
    const info = renderArchitecture({}, { canSend: canSend(), architecture, architectureViewer, pending, run });
    const view = el("div", "core-plan-3d");
    const media = info.querySelector(".core-arch-view") || info.querySelector(".core-arch-preview");
    if (media) view.append(media);
    else if (architecture.status === "loading") view.append(skel("core-plan-3d-skel"));
    else view.append(el("p", "core-plan-3d-empty", hasPlan ? "The 3D walkthrough appears here once it is rendered." : "Save a floor plan to render its 3D walkthrough."));
    panel.replaceChildren(view, info);
  }

  function renderMassing() {
    const panel=root.querySelector('#core-plan-massing');
    if(!panel||!massingOpen)return;
    if(!current){panel.replaceChildren(loadingStatus('Loading the building model'));return;}
    const model=massingBlock(current,{selectedConceptId,conceptViewer,canSend:canSend()});
    if(model){panel.replaceChildren(model);return;}
    const empty=el('div','modeling-empty');
    const address=current.fields.property?.value?.address?.trim();
    empty.append(el('h2','','What could you build here?'));
    empty.append(el('p','core-note',address
      ? 'Use the address to explore a zoning-based building shape. The result is a starting estimate that needs review.'
      : 'Describe the building’s dimensions and the shape you want to explore.'));
    const actions=el('div','modeling-empty-actions');
    if(address) {
      const label=el('label','modeling-goal','What would you like to explore?');
      const goal=el('select');goal.name='housing-goal';goal.disabled=!canSend()||current.access==='viewer';
      for(const item of HOUSING_GOALS) {
        const option=el('option','',item.label);option.value=item.id;option.selected=item.id===housingGoal;goal.append(option);
      }
      goal.addEventListener('change',()=>{housingGoal=goal.value;});
      label.append(goal);
      const notesLabel=el('label','modeling-goal','Anything to keep or include? (optional)');
      const notes=el('textarea');notes.name='housing-notes';notes.rows=2;notes.maxLength=600;notes.value=housingNotes;
      notes.placeholder='For example: keep the existing home and make space for a parent.';
      notes.disabled=!canSend()||current.access==='viewer';
      notes.addEventListener('input',()=>{housingNotes=notes.value;});notesLabel.append(notes);
      empty.append(label,notesLabel);
      if(pending?.action==='zoning-concept') {
        goal.disabled=true;notes.disabled=true;
        const status=el('p','core-note','Researching the site and your housing idea…');status.setAttribute('role','status');actions.append(status);
      } else {
        const build=el('button','core-follow primary','Explore zoning potential');build.type='button';build.dataset.zoningConcept='';build.disabled=!canSend()||current.access==='viewer';
        build.addEventListener('click',()=>{
          if(!canSend()||current.access==='viewer'||pending?.action==='zoning-concept')return;
          const selected=HOUSING_GOALS.find(item=>item.id===housingGoal);
          const preferences=housingNotes.trim();
          markPending('concepts','zoning-concept');setChatCollapsed(false,{remember:false});
          document.dispatchEvent(new CustomEvent('acres-follow-up',{detail:{text:`Explore the as-of-right zoning potential at ${JSON.stringify(address)}. ${selected.request} Use reliable parcel and zoning information. ${preferences?`My preferences: ${JSON.stringify(preferences)}. `:''}Cite the sources and assumptions, and explain any missing information. Distinguish what the records support from what needs a survey, professional review or approval. If the parcel or zoning is uncertain, tell me what is missing instead of guessing. Create a preliminary 3D building shape only when the site geometry and rules support it. Keep my existing floor plan and skip financial analysis.`}}));
        });
        actions.append(build);
      }
    }
    const ask=el('button','core-follow primary','Describe a building');ask.type='button';ask.addEventListener('click',()=>setChatCollapsed(false,{remember:false}));
    if(address)ask.classList.remove('primary');
    actions.append(ask);empty.append(actions);panel.replaceChildren(empty);
  }

  async function refreshModelingState() {
    const id=projectId,generation=pageGeneration;
    try{
      const next=await api.get(`/projects/${encodeURIComponent(id)}/state`);
      if(generation!==pageGeneration||mode!=='plan'||(current&&next.version<current.version))return;
      current=next;
      const name=next.title||'Model';
      document.title=`${name} · Modeling · Arosa`;
      root.querySelector('.core-plan-head h1').textContent=name;
      const address=root.querySelector('.modeling-address');
      address.textContent=next.fields.property?.value?.address||'';
      address.hidden=!address.textContent||address.textContent===name;
      root.querySelector('.modeling-project-name').textContent=name;
      onSiteTitle(id,name);
      renderMassing();
    }catch(error){
      if(generation!==pageGeneration)return;
      const box=el('div','core-screen');const back=el('a','core-back','All models');back.href=back.dataset.route='/modeling';
      box.append(back,el('h1','core-title','Model not available'),failLine(error.message));root.replaceChildren(box);
    }
  }

  function leaveParcel() {
    ++pageGeneration;
    refreshing = null;
    refreshAgain = false;
    architectureLoad = null;
    architectureAgain = false;
    instructionSave = Promise.resolve();
    regenerateWhenLoaded = false;
    fullRun = null;
    ++siteSearchGeneration;
    clearTimeout(siteSearchTimer);
    siteSearchTimer = null;
    if (planMount) window.acresPlanEditor?.unmount(planMount);
    planMount = null;
    walkthroughOpen = null;
    massingOpen = false;
    starting = null;
    pending = null;
    clearTimeout(pendingTimer);
    siteObserver?.disconnect();
    siteObserver = null;
    progressQueue.length = 0;
    events?.close();
    events = null;
    clearViewers();
    current = null;
    projectId = null;
    architecture = null;
    planScheme = DEFAULT_SCHEME;
    news = null;
    selectedConceptId = null;
    housingGoal = 'capacity';
    housingNotes = '';
    assumptionStatus = "";
  }

  return {
    listingsAvailable,
    showScreen() {
      if (mode === "screen") return;
      leaveParcel();
      mode = "screen";
      document.title = "Underwriting · Arosa";
      renderScreen();
    },
    showParcel(id) {
      const hash = window.location?.hash || "";
      scrollTarget = /^#core-(?:step-)?[a-z]+$/.test(hash) ? hash.slice(1) : null;
      if (mode === "parcel" && projectId === id) { scrollToTarget(); return; }
      leaveParcel();
      mode = "parcel";
      projectId = id;
      root.replaceChildren(siteSkeleton());
      subscribe(id);
      void refresh();
    },
    // A listing's Regenerate: the site page shows the run starting once its state has loaded.
    regenerate(id) {
      if (mode !== "parcel" || projectId !== id) return;
      regenerateWhenLoaded = true;
      regenerateIfAsked();
    },
    syncPlanView() { if (mode !== 'plan') return;const view=new URLSearchParams(window.location.search).get('view');const next=view==='3d'||(!view&&window.location.hash==='#walkthrough'), massing=view==='massing';if (next!==walkthroughOpen||massing!==massingOpen) {walkthroughOpen=next;massingOpen=massing;renderWalkthrough();} },
    showPlan(id, options = {}) {
      const scheme = schemeFromSearch(window.location?.search);
      if (mode === "plan" && projectId === id) { switchScheme(scheme); return; }
      leaveParcel();
      mode = "plan";
      projectId = id;
      planScheme = scheme;
      // The site's card opens the page on the editor or on the walkthrough.
      const part = window.location?.hash;
      const view=new URLSearchParams(window.location.search).get('view');
      walkthroughOpen = view ? view === '3d' : part === "#walkthrough" ? true : part === "#editor" ? false : null;
      massingOpen = view === 'massing';
      document.title = "Floor plan · Arosa";
      renderPlan(id, options);
      architecture = { status: "loading" };
      renderWalkthrough();
      subscribe(id);
      void refreshArchitecture();
      void refreshModelingState();
    },
    // pending is the app's pending site: {label, section?, conversationId?, failed?}.
    showStarting(pending) {
      if (mode !== "starting") leaveParcel();
      mode = "starting";
      starting = pending;
      document.title = `${pending.label} · Arosa`;
      onSiteTitle(null, pending.label);
      renderStarting();
    },
    leave() {
      leaveParcel();
      mode = null;
      root.replaceChildren();
    },
    refresh() {
      if (mode === "parcel") void refresh();
    },
    rerender: renderState,
    // The open site's source count, the same number its Sources footer shows (null off a site).
    sourceCount: () => (mode === "parcel" && current ? collectSources(current).length : null),
    // The app reports the site conversation's run so each step can show its own progress.
    setRun(next, failure = null) {
      const value = next
        ? {
            label: next.label || "",
            tools: [...(next.tools || [])],
            trail: (next.trail || []).map(({ tool, arguments: args, status, text, thought, finding, sources }) => ({ tool, arguments: args, status, text, thought, finding, sources })),
            startedAt: next.startedAt || null,
            typicalMs: next.typicalMs ?? null,
            queued: next.queued === true,
          }
        : null;
      if (JSON.stringify(value) === JSON.stringify(run) && JSON.stringify(failure) === JSON.stringify(runFailure)) return;
      // The request this page started stays as the run's step until the run ends or fails.
      if (pending && value) clearTimeout(pendingTimer);
      if (fullRun && !fullRun.ended && (failure || (run && !value))) fullRun.ended = true;
      if (pending && (failure || (run && !value))) {
        pending = null;
        clearTimeout(pendingTimer);
      }
      run = value;
      runFailure = failure;
      clearInterval(clockTimer);
      clockTimer = run?.startedAt
        ? setInterval(() => {
            for (const node of root.querySelectorAll(".uw-trail-time[data-started-at]"))
              node.textContent = timeLine(Date.now() - Number(node.dataset.startedAt), node.dataset.typicalMs ? Number(node.dataset.typicalMs) : null);
          }, 20000)
        : null;
      if (mode === "parcel") renderState();
      else if (mode === "starting") renderStarting();
      else if (mode === "plan") renderWalkthrough();
    },
  };
}
