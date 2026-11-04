import { SIGN_IN_EXPIRED } from "./access-fetch.js";
import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";
import { publicErrorMessage, chatRequest, postChat, patchChat, deleteChat, streamRun } from "./chat-api.js";
import { showListingInvestigation } from './listing-investigation.js';
import { fillSourceDialog } from "./source-view.js";
import { listingSearchesView, listingSearchesText } from "./listing-search-view.js";
import {
  createActivityView,
  savedActivity,
  patchMarkup,
  describeStep,
} from "./activity-view.js";
import { skel } from "./skeleton.js";
import { bindFilterPopover } from "./filter-popover.js";
import {
  icon,
  sourceList,
  conceptList,
  renderRecentRail,
  refreshRecentTimes,
  fitRecentRail,
  createScrollManager,
  initials,
  isSharedItem,
  upsertConversationItem,
  sidebarConversationList,
  decorateAnswerHeader,
  renderProjectUpdateNotice,
  parcelRows,
  PARCEL_ABSENT,
  createHistoryView,
  shortcutLetter,
} from "./conversation-view.js";
import {
  SIGN_OUT_URL,
  SIGNED_OUT_URL,
  accountDisplay,
  clearSavedDraft,
  endAccessSession,
  markSigningOut,
} from "./sign-out.js";
import { createGeneratedUiLoader } from "./generated-ui-loader.js";
import { mergeTeamDetail, personDisplay, renderTeamManagerList, resolveFocusedTeamId, teamAvatar, teamFacts } from "./team-view.js";
import { parseRoute, routePath, resolveRoute, bodyModes, linkOrigin, needsUnderwritingSetup } from "./core-route.js";
import { planEntryState, mountPlanEditor } from "./plan-editor-loader.js";
import { addPlanNote, planNotesLine, withPlanNotes } from "./plan-notes.js";
import { readPlanText, planTextMessage } from "./plan-text-attachment.js";
import { followUpMessage, displayAddress } from "./core-model.js";
import { createCorePage } from "./core.js";
import { createModeling } from "./modeling.js";
import { createReportPage } from "./report-view.js";
import { createWhatsNewPage } from "./whats-new.js";
import { createHome, pendingOutcome } from "./home.js";
import { createListings } from "./listings.js";
import { createListingsMap } from "./listings-map.js";
import { withListingsContext, splitListingsContext } from "./listings-model.js";
import { listingPageView } from "./listing-page-context.js";
import { createJobs } from "./jobs.js";
import { clockTime, stepFinding, stepSources, thoughtHeadline } from "./run-trail.js";
import { ensureDeveloperCosts, requestDeveloperCosts } from "./onboarding.js";
import { dealsAvailable } from "./deals.js";
import { setFeedbackContext } from "./beta-feedback.js";
const $ = (s) => document.querySelector(s);
// History, the chat's conversation search. It is made first because every path the reader takes to
// the thread closes it; its other parts are reached only once the page is running.
const historyView = createHistoryView({
  load: async (query) => (await chatRequest("/conversations?q=" + encodeURIComponent(query))).conversations,
  account: () => me?.account,
  setDock: (open) => setChatDock(open, { focus: false }),
  focusThread,
  // On a phone the opener can sit in the closed menu, so focus returns to the menu button instead.
  fallbackFocus: () => $(".mobile-menu").focus(),
  onOpen: () => {
    closeNav();
    toggleContext(false);
  },
});
// The composer when the reader can write; otherwise, as for a thread shared to view only, the
// thread's title, so the next Escape still finds focus in the chat.
function focusThread() {
  if (!$(".context-panel").hidden) toggleContext(false);
  const prompt = $("#prompt");
  prompt.focus({ preventScroll: true });
  if (document.activeElement !== prompt) $("#chat-context-title").focus({ preventScroll: true });
}
const scrollState = createScrollManager();
const animateMessages = new Set();
let contextVersion;
// The deal store's status and the account's settings do not depend on the session's answer, so
// both start beside it.
void dealsAvailable();
const settingsRequest = requestDeveloperCosts();
settingsRequest.catch(() => {});
const sessionResponse = await fetch("/api/session", {
  cache: "no-store",
  signal: AbortSignal.timeout(10000),
}).catch(() => null);
const session =
  sessionResponse?.ok &&
  sessionResponse.headers.get("content-type")?.includes("application/json")
    ? await sessionResponse.json()
    : null;
// Modeling starts without financial setup. Underwriting checks its own cost profile.
$('#modeling-nav').hidden = session?.architectureEnabled !== true;
const underwritingBoot = needsUnderwritingSetup(parseRoute(window.location.pathname),session);
const modelingBoot = Boolean(session) && !underwritingBoot;
const bootSettings = underwritingBoot ? await ensureDeveloperCosts(await settingsRequest,session.architectureEnabled===true) : null;
const storeKey = session ? "acres-nyc-chat-v3-" + session.namespace : null;
let storageUnavailable = false;
function readSaved(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch (error) {
    if (
      !["SyntaxError", "SecurityError", "QuotaExceededError"].includes(
        error.name,
      )
    )
      throw error;
    storageUnavailable = true;
    return fallback;
  }
}
const cached = session ? readSaved(storeKey, {}) : {};
// A conversation remembered from the last visit is only an id until it loads.
let state = {
  id: cached.id || null,
  unloaded: Boolean(cached.id),
  messages: [],
  property: null,
  draft: cached.draft || "",
  runs: [],
  access: null,
  members: [],
  owner: null,
};
// Unsent text belongs to its conversation (a blank chat is the null key), so opening another
// thread never discards what was typed in this one. Capped so saved drafts stay small.
const drafts = new Map(Object.entries(cached.drafts || {}).map(([k, v]) => [k || null, v]));
function stashDraft() {
  if (state.draft) drafts.set(state.id, state.draft);
  else drafts.delete(state.id);
  while (drafts.size > 20) drafts.delete(drafts.keys().next().value);
}
function takeDraft(id) {
  const text = drafts.get(id) || "";
  drafts.delete(id);
  return text;
}
setFeedbackContext(() => state.id);
let me = session ? { account: session.namespace, email: session.email || null, name: null } : null;
let accountPending = Boolean(session);
function renderAccount() {
  const display = accountDisplay(me);
  const card = $(".workspace-card");
  if (card) card.setAttribute("aria-busy", String(accountPending));
  const initialsEl = $("#account-initials");
  if (initialsEl) initialsEl.textContent = display.initials;
  const nameEl = $("#account-name");
  if (nameEl) {
    nameEl.textContent = display.primary;
    nameEl.title = display.email || display.primary;
  }
  const emailEl = $("#account-email");
  if (emailEl) {
    // While the account loads, its second line holds its place as a quiet bar.
    if (accountPending && !display.email) {
      emailEl.replaceChildren(skel("skel-text", { width: "120px", height: "11px", marginTop: "3px" }));
      emailEl.title = "";
    } else {
      emailEl.textContent = display.secondary;
      emailEl.title = display.secondary;
    }
  }
  const signOut = $("#sign-out");
  if (signOut) {
    signOut.href = SIGN_OUT_URL;
    const label = display.email ? `Sign out (${display.email})` : "Sign out";
    signOut.setAttribute("aria-label", label);
    signOut.title = label;
  }
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("a.sign-out")) return;
  e.preventDefault();
  if (!markSigningOut(document.querySelectorAll("a.sign-out"))) return;
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  clearSavedDraft(storage, storeKey);
  stopSharedPolling();
  eventStream?.close();
  void endAccessSession().then((ended) => {
    window.location.assign(ended ? SIGNED_OUT_URL : SIGN_OUT_URL);
  });
});
renderAccount();
let myTeams = [],
  shareGrants = [],
  shareLinks = [],
  shareTeamSelection = null,
  selectedTeam = null,
  focusedTeamId = readFocusedTeamId(),
  teamDialogMode = "detail",
  teamDetailTab = "people",
  teamsLoading = Boolean(session),
  teamsError = null,
  teamsLoadPromise = null,
  teamSearchQuery = "",
  teamReturnToShare = false,
  sharedPollTimer = null;
let archive = [],
  busy = false,
  pendingSiteReceipt = null,
  connectionInterrupted = false,
  toastTimer,
  activeRun = null,
  eventStream = null,
  activity = [],
  liveMessages = new Map(),
  liveUi = [],
  // The live turn's status line, also shown in the open site page's running step.
  liveLabel = null,
  // When the watched run started working (its run.started event), for the site page's time line.
  runStartedAt = null,
  // When this page began watching the run, for timing one the conversation has not listed yet.
  runSince = null,
  // A run that ended while the drawer was closed, with its conversation; the ask handle says so
  // while that conversation is open, until the drawer opens.
  unseenEnd = null,
  handleClock = null,
  generation = 0,
  planAttachmentPending = false,
  conversationLoad = 0,
  pendingSubmission = null;
const widgets = new Map();
function generatedWidget(content, key) {
  let widget = widgets.get(key);
  if (!widget) {
    widget = document.createElement("div");
    widget.className = "generated-view";
    widgets.set(key, widget);
    queueMicrotask(() => mountGeneratedUi(widget, content));
  }
  return widget;
}
let conceptReady;
async function mountConceptView(container, concept, places, {modelingProjectId = null} = {}) {
  // A failed import is forgotten so Retry can load the bundle again.
  if (!conceptReady) conceptReady = import("/genui/concept-view.js").catch((error) => { conceptReady = null; throw error; });
  await conceptReady;
  if (!container.isConnected) return;
  window.acresConceptView.render(container, concept, { places, tilesKey: session?.maps?.tilesKey || null, threadId: state.id || null, modelingProjectId });
}
let architectureReady;
async function mountArchitectureView(container, props) {
  // A failed import is forgotten so Retry can load the bundle again.
  if (!architectureReady) architectureReady = import("/genui/architecture-view.js").catch((error) => { architectureReady = null; throw error; });
  await architectureReady;
  if (!container.isConnected) return;
  window.acresArchitectureView.render(container, props);
}
let planNotes = { projectId: null, notes: [] };
let submitPending = false,
  renderScheduled = false,
  liveTurn = null;
// Routing: "/" is home, "/sites" lists listings and sites, "/sites/:projectId" underwrites one site and
// "/sites/:projectId/plan" edits its floor plan, both with the attached conversation as a sidebar.
// Old "/core" links are rewritten to these.
let route = resolveRoute(window.location, history, session);
// The open site's name, from its page, for the top bar and the main menu.
let siteTitle = null;
// The site page's conversation attaching, so a Regenerate from a listing sends into it.
let siteAttach = Promise.resolve();
// The Recent list shows whole rows in the room the rail has; it refits when that room changes.
let recentFrame = 0;
function refitRecent() {
  cancelAnimationFrame(recentFrame);
  recentFrame = requestAnimationFrame(() => fitRecentRail($(".rail-recent")));
}
const recentRoom = new ResizeObserver(refitRecent);
for (const el of [$("#navigation"), $(".rail-recent-list"), $(".rail-spacer")]) recentRoom.observe(el);
// Each site's own conversation as its pages last showed it. The site page acts in that conversation
// whatever the dock shows: one opened from Recent over the site is only read there, and neither
// receives the page's requests nor sets who may make them.
const siteChats = new Map();
function dockOnSite() {
  return !route.projectId || !state.id || state.projectId === route.projectId;
}
function siteCanSend() {
  return dockOnSite() ? canSend() : Boolean(session) && siteChats.get(route.projectId)?.access !== "viewer";
}
// Brings the site's own conversation back into the dock when another one is open over the site.
function reattachSite() {
  if (!dockOnSite()) siteAttach = attachProjectConversation(route.projectId).catch((e) => toast(e.message));
  return siteAttach;
}
// On a site page the rail counts the site's own sources, as its "Sources (N)" footer does; elsewhere
// the latest answer's sources.
function updateSourcesCount() {
  const site = route.view === "site" ? core.sourceCount() : null;
  $(".nav-item[data-view=sources] .count").textContent = String(site ?? state.messages.findLast((m) => m.sources?.length)?.sources.length ?? 0);
}
function setSiteTitle(projectId, title) {
  if (projectId !== (route.projectId ?? null)) return;
  updateSourcesCount();
  siteTitle = title;
  if (siteChats.has(projectId)) siteChats.get(projectId).title = title;
  $("#site-nav-title").textContent = siteTitle || displayAddress(state.property?.address) || "Site research";
  if (route.view === "site" || route.view === "starting") $("#conversation-title").textContent = siteTitle || "Site";
  renderChatHead();
}
// The underwriting report reads the site's conversation once the docked chat has attached it.
const report = createReportPage({
  root: $("#report-page"),
  navigate,
  conversationFor: (projectId) => siteAttach.then(() => (state.projectId === projectId ? state.id : null)),
  architectureEnabled: () => session?.architectureEnabled === true,
  mountCard: (content, key) => generatedWidget(content, key),
});
const whatsNew = createWhatsNewPage({ root: $("#whats-new-page") });
let pendingSite = null,
  pendingSiteCheck = null,
  pendingSiteTimer = null,
  coreCanSend = null;
const projectChatsKey = session ? "acres-core-chats-" + session.namespace : null;
const core = createCorePage({
  root: $("#core-page"),
  navigate,
  underwrite: underwriteSite,
  pendingBox: () => home.pendingBox(),
  conversationId: () => (dockOnSite() ? state.id : siteChats.get(route.projectId)?.id ?? null),
  canSend: () => siteCanSend(),
  mountConcept: mountConceptView,
  mountArchitecture: mountArchitectureView,
  mountPlan: mountPlanEditor,
  architectureEnabled: () => session?.architectureEnabled === true,
  setChatOpen: (open, options) => setChatDock(open, { focus: false, ...options }),
  onSiteTitle: setSiteTitle,
});
const modeling = createModeling({ root: $('#core-page'), navigate, canStart: () => Boolean(session?.architectureEnabled) && canSend() });
const home = createHome({
  addressRoot: $("#home-address"),
  sitesRoot: $("#home-sites"),
  canStart: () => canSend() && !pendingSite,
  listProjects: async () => (await chatRequest("/projects?sitesOnly=true")).projects,
  underwrite: underwriteSite,
  openPending: openPendingSite,
});
// Home's NYC listings, for accounts that can read the deal store (set once the store answers).
// The chat drawer docks beside every page: one open state for all pages, remembered per viewer. It
// starts closed until the viewer opens it, and narrow screens, where it covers the page, always
// start closed. An old /chat link opens it.
const CHAT_DOCK_KEY = "acres-chat-dock-open";
function savedDockOpen() {
  return window.innerWidth > 850 && readSaved(CHAT_DOCK_KEY, false) === true;
}
let chatDockOpen = Boolean(route.chat) || savedDockOpen();
let dockHistoryActive = history.state?.arosaChatDock === true;
let dockPendingFocus = null;
// Where focus was when the keyboard shortcut opened the drawer, until the drawer next closes.
let dockReturnFocus = null;
// Saved sites by parcel, so listing cards show their underwriting. The list reloads at most every
// 30 seconds while listings show, and on the next render after a site starts or resolves.
let listingSites = new Map(),
  listingSitesAt = 0,
  listingSitesLoad = null;
function loadListingSites() {
  if (!session || listingSitesLoad || Date.now() - listingSitesAt < 30000) return;
  listingSitesLoad = chatRequest("/projects?sitesOnly=true")
    .then(({ projects }) => {
      listingSites = new Map();
      for (const p of projects) if (p.bbl && !listingSites.has(String(p.bbl))) listingSites.set(String(p.bbl), p);
      listingSitesAt = Date.now();
      listings.syncSites();
    })
    .catch((e) => toast(e.message))
    .finally(() => {
      listingSitesLoad = null;
    });
}
// The visible site for a parcel, including one whose first run is still identifying it.
async function findSite(bbl) {
  const { projects = [] } = await chatRequest("/projects?sitesOnly=true&q=" + encodeURIComponent(bbl));
  return projects.find((p) => String(p.bbl) === bbl) || null;
}
// A site with a job running carries the step that job is on, which saved fields show only at its end.
function withJob(site) {
  const job = site && jobs.forProject(site.id);
  return job ? { ...site, running: site.running ?? job.created, step: job.step } : site;
}
function openListingSite(site) {
  navigate(sitePath(site.id), route.listingId ? { fromListing: window.location.pathname + window.location.search } : null);
}
// Regenerate opens the site and starts the fresh run in the site's own conversation.
async function regenerateListingSite(site) {
  openListingSite(site);
  await siteAttach;
  if (route.projectId === site.id) core.regenerate(site.id);
}
// Research still running on any site stays in the rail, wherever the user goes; ending changes what
// listings and Your sites show, so both reload.
const jobs = createJobs({
  root: $(".rail-jobs"),
  load: async () => (await chatRequest("/runs")).runs,
  status: (id) => chatRequest("/runs/" + id + "/status"),
  open: (job) => navigate(sitePath(job.projectId, job.workflow === 'modeling' ? 'architecture' : null)),
  notify: (text) => toast(text),
  onChange: () => {
    listingSitesAt = 0;
    home.invalidateSites();
    if (listingsMode() && route.listingId) void listings.refreshSelectedSite().catch((e) => toast(e.message));
    render();
  },
});
if (session) void jobs.refresh().catch((e) => toast(e.message));
const listings = createListings({
  root: $("#home-listings"),
  canStart: () => canSend() && !pendingSite,
  onUnderwrite: (deal, prompt) => void underwriteSite(deal.address || `BBL ${deal.bbl}`, prompt, deal.bbl ? String(deal.bbl) : null, null, { open: true }),
  onAsk: (deal) => askAboutListing(deal),
  onInvestigate: (deal) => showListingInvestigation(deal),
  // Floor plan & 3D shows on listings only for accounts with the architecture tools.
  onPlan: () => (session?.architectureEnabled === true ? planListing : null),
  loadMap: createListingsMap,
  settings: bootSettings,
  onInspect: followListing,
  sites: { get: (bbl) => withJob(listingSites.get(bbl) || null), find: async (bbl) => withJob(await findSite(bbl)), open: openListingSite, regenerate: (site) => void regenerateListingSite(site) },
  // A shared search opens home; other pages never carry one.
  searchUrl: route.view === "home" ? window.location.href : null,
});
// Expand widens the drawer up to a reading column for the page; the button then offers to narrow it.
// The width is remembered per viewer, like the drawer's open state, and applied before the first
// paint so a restored wide drawer never opens narrow first. The value is a plain flag read on its
// own, so a stray value cannot affect saved chats.
const CHAT_DOCK_WIDE_KEY = "acres-chat-dock-wide";
function savedDockWide() {
  try {
    return localStorage.getItem(CHAT_DOCK_WIDE_KEY) === "true";
  } catch {
    return false;
  }
}
function setDockWide(wide) {
  document.body.classList.toggle("chat-dock-wide", wide);
  const button = $(".chat-expand");
  const label = wide ? "Narrow chat" : "Expand chat";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.querySelector("use").setAttribute("href", wide ? "#collapse" : "#expand");
}
setDockWide(savedDockWide());
$(".chat-expand").addEventListener("click", () => {
  const wide = !document.body.classList.contains("chat-dock-wide");
  setDockWide(wide);
  requestAnimationFrame(() => listings.resize());
  try {
    localStorage.setItem(CHAT_DOCK_WIDE_KEY, JSON.stringify(wide));
  } catch {
    /* A per-viewer convenience only. */
  }
});
// Whether home shows the deal store. The account's last answer is remembered so the first paint is
// already the listings layout; the status request then confirms it or moves the page back.
const DEALS_ON_HOME_KEY = session ? "acres-deals-on-home-" + session.namespace : null;
const dealsOnHomeKnown = Boolean(DEALS_ON_HOME_KEY) && readSaved(DEALS_ON_HOME_KEY, null) !== null;
let dealsOnHome = dealsOnHomeKnown && readSaved(DEALS_ON_HOME_KEY, null) === true;
const homeMounts = Object.fromEntries(["#home-address", "#home-sites"].map((id) => [id, { parent: $(id).parentElement, next: $(id).nextSibling }]));
// Home's address entry lives in the listings header and recent sites under the ranked deals, so
// the map keeps the page's full height; without listings both sit in the welcome.
function placeHomeSections(listingsOn) {
  const into = { "#home-address": listings.addressMount, "#home-sites": $("#home-listings .listings-results") || listings.sitesMount };
  for (const id of ["#home-address", "#home-sites"]) {
    if (listingsOn) into[id].append($(id));
    else homeMounts[id].parent.insertBefore($(id), homeMounts[id].next);
  }
}
function settleDealsOnHome(ok) {
  if (DEALS_ON_HOME_KEY) {
    try {
      localStorage.setItem(DEALS_ON_HOME_KEY, JSON.stringify(ok));
    } catch {
      /* A per-viewer convenience only. */
    }
  }
  if (ok === dealsOnHome) return;
  dealsOnHome = ok;
  if (!session) return;
  placeHomeSections(ok);
  setBodyMode();
  render();
}
if (dealsOnHome && session) placeHomeSections(true);
// Runs sent from the listings page, whose deal store searches become the page's filters, and the
// answers already applied.
const listingRuns = new Set();
const appliedSearches = new Set();
let listingsConversation = state.id || null;
const listingsMode = () => Boolean(session) && dealsOnHome && route.view === "home";
function setChatDock(open, { focus = true, remember = true, fromHistory = false, returnFocus = null } = {}) {
  if (!fromHistory && !open && dockHistoryActive && history.state?.arosaChatDock) {
    dockPendingFocus = returnFocus;
    history.back();
    return;
  }
  if (!fromHistory && open && !chatDockOpen && remember && window.innerWidth <= 850) {
    history.pushState({ ...history.state, arosaChatDock: true }, "", window.location.href);
    dockHistoryActive = true;
  }
  if (!open) {
    historyView.close();
    dockReturnFocus = null;
  }
  chatDockOpen = open;
  if (remember) {
    dockAutoOpened = false;
    try {
      localStorage.setItem(CHAT_DOCK_KEY, JSON.stringify(open));
    } catch {
      /* A per-viewer convenience only. */
    }
  }
  setBodyMode();
  requestAnimationFrame(() => listings.resize());
  if (open && focus) focusThread();
}
function onChatDockPopstate() {
  const open = history.state?.arosaChatDock === true;
  if (!dockHistoryActive && !open) return;
  dockHistoryActive = open;
  const target = dockPendingFocus;
  dockPendingFocus = null;
  setChatDock(open, { fromHistory: true });
  if (!open) {
    if (target?.isConnected && target !== document.body) target.focus({ preventScroll: true });
    if (!target || document.activeElement !== target) focusAskHandle();
  }
}
// The last conversation, restored on home without listings, opens in the drawer, since nothing else
// would show it on a phone. The reader did not choose that open, so it gives way when they leave home.
function showRestoredConversation() {
  if (listingsMode() || !state.messages.length || chatDockOpen) return;
  setChatDock(true, { focus: false, remember: false });
  dockAutoOpened = true;
}
// A conversation opened from a shared or #thread link shows in the drawer at any width, without
// changing the reader's saved choice, and stays open if listings then take the page.
function showLinkedConversation(id) {
  if (state.id !== id || !state.messages.length) return;
  setChatDock(true, { focus: false, remember: false });
  dockAutoOpened = false;
}
// The ask handle is the one way into the chat wherever the drawer is closed, on every page; the
// drawer's own composer takes over once it is open. While the drawer is closed the handle carries the
// open conversation's run: the step and its time, then how the run ended once it ends unseen.
function askBarVisible() {
  return Boolean(session) && !chatDockOpen;
}
function focusAskHandle() {
  const input = $("#ask-input");
  (input && !input.hidden ? input : $("#ask-handle")).focus({ preventScroll: true });
}
function openFromHandle() {
  historyView.close();
  setChatDock(true);
  // Land on the latest message, not wherever the thread was last scrolled to.
  if (typeof scrollState !== "undefined") requestAnimationFrame(() => scrollState.jumpToLatest());
}
function noteRunEnded(event, conversationId) {
  if (!chatDockOpen) unseenEnd = { conversationId, answered: event === "run.completed" };
}
function renderAskHandle() {
  if (chatDockOpen) unseenEnd = null;
  const handle = $("#ask-handle");
  handle.querySelector(".send-button").setAttribute("aria-expanded", String(chatDockOpen));
  const running = !chatDockOpen && Boolean(liveLabel);
  const since = running && (runStartedAt || runRecord(activeRun)?.created || runSince);
  // An ended run belongs to its conversation, so another conversation's page does not claim it.
  const ended = !chatDockOpen && unseenEnd && unseenEnd.conversationId === state.id ? unseenEnd : null;
  const text = running ? liveLabel + (since ? ` · ${clockTime(Date.now() - since)}` : "") : ended ? (ended.answered ? "New answer" : "Research stopped") : null;
  const status = $("#ask-bar-status");
  const input = handle.querySelector(".ask-bar-input");
  // A run starting or ending never hides the field under text the reader is typing.
  const showStatus = Boolean(text) && !input.value.trim();
  status.hidden = !showStatus;
  status.querySelector("span").textContent = text || "";
  input.hidden = showStatus;
  handle.classList.toggle("is-running", running);
  handle.classList.toggle("has-answer", !running && Boolean(ended?.answered));
  // The time ticks only while the handle shows a run.
  if (running && !handleClock) handleClock = setInterval(renderAskHandle, 1000);
  else if (!running && handleClock) {
    clearInterval(handleClock);
    handleClock = null;
  }
}
// Cmd+J or Ctrl+J opens the drawer at its composer from anywhere and closes it again, putting focus
// back where the reader was; Escape in an empty composer, or on the title of a conversation the reader
// can only view, closes it too. Neither reaches past a modal dialog or the open phone menu, and signed
// out there is no drawer to open. Holding the keys toggles once.
function onDockShortcut(e) {
  if (!session || document.querySelector("dialog[open], [aria-modal='true'], .sidebar.open")) return false;
  const toggle = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && shortcutLetter(e, "j");
  const prompt = $("#prompt");
  const leave = e.key === "Escape" && !e.isComposing && chatDockOpen &&
    ((e.target === prompt && !prompt.value.trim()) || e.target === $("#chat-context-title"));
  if (!toggle && !leave) return false;
  e.preventDefault();
  if (e.repeat) return true;
  if (chatDockOpen) {
    const target = dockReturnFocus;
    setChatDock(false, { returnFocus: target });
    if (chatDockOpen) return true;
    if (target?.isConnected && target !== document.body) target.focus({ preventScroll: true });
    if (!target || document.activeElement !== target) focusAskHandle();
  } else {
    const from = document.activeElement;
    historyView.close();
    setChatDock(true);
    // Text typed in the pill follows into the composer, as pressing Enter there carries it.
    const ask = $("#ask-input");
    if (from === ask && ask.value.trim()) {
      const text = ask.value;
      ask.value = "";
      prompt.value = prompt.value.trim() && prompt.value.trim() !== text.trim() ? prompt.value.replace(/\s+$/, "") + "\n" + text : text;
      state.draft = prompt.value;
      updateInput();
      save();
      prompt.focus({ preventScroll: true });
    }
    if (typeof scrollState !== "undefined") requestAnimationFrame(() => scrollState.jumpToLatest());
    dockReturnFocus = from;
  }
  return true;
}
// Start a separate modeling project for the listing, with its own design conversation.
async function planListing(deal, prompt) {
  try {
    const model = await postChat('/projects', { workflow: 'modeling', address:deal.address, title:deal.address });
    navigate(routePath({ view: 'plan', projectId: model.id }));
    await siteAttach;
    if (route.projectId === model.id) await send(prompt, { keepDraft: false, fromListings: false });
  } catch (error) { toast(error.message); }
}
// The architecture section is the floor plan page; other sections are anchors on the site page.
const sitePath = (projectId, section = null) => section === "architecture"
  ? routePath({ view: "plan", projectId })
  : routePath({ view: "site", projectId }) + (section ? "#core-" + section : "");
// Ask about this listing opens the chat beside it with a short question to edit or send; the open
// listing rides along as context.
function askAboutListing(deal) {
  historyView.close();
  setChatDock(true);
  if (!$("#prompt").value.trim()) {
    state.draft = `Is ${deal.address || "this listing"} worth pursuing at this ask, and what could be built there?`;
    $("#prompt").value = state.draft;
    save();
    updateInput();
  }
  $("#prompt").focus();
}
// Opening a listing gives it an address of its own, so back, forward and a copied link reach it.
// Closing one opened from the results steps back to them rather than stacking another entry.
function followListing(listingId) {
  const next = listingId ? { view: "home", listingId } : { view: "home" };
  const path = routePath(next);
  if (route.view !== "home" || path === window.location.pathname) return;
  const fromResults = history.state?.listingFromResults === true;
  if (listingId) history.pushState({ listingFromResults: !route.listingId }, "", path + window.location.search);
  else if (fromResults) history.back();
  else history.replaceState(null, "", path + window.location.search);
  route = next;
}
// A site opened from a listing remembers the listing in its history entry, so its pages can lead
// back there; the entry is replaced, not stacked, while a resolving site moves to its address.
let pendingPageFocus = false;
let focusedPageHeading = null;
document.addEventListener('focusin',e=>{focusedPageHeading=e.target.matches('#core-page h1,#report-page h1,#home-listings h1')?e.target:null;});
const chatUpdatedSections = new Set();
let sectionObserver = null;
function syncPageNavigation() {
  const surface = route.view === 'report' ? $('#report-page') : ['site','plan','models','sites'].includes(route.view) ? $('#core-page') : $('#home-listings');
  const heading = surface?.querySelector('h1');
  if (heading && (pendingPageFocus || (focusedPageHeading && !focusedPageHeading.isConnected))) {
    pendingPageFocus = false;
    $('.route-announcement').textContent = heading.textContent.trim() + ' page';
    if (innerWidth > 850 || !chatDockOpen) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
  }
  const menu = $('.page-more'), actions = $('.page-more-actions');
  actions.replaceChildren();
  for (const action of surface?.querySelectorAll('.uw-share button, .uw-share a, .report-actions button') || []) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = action.textContent; button.disabled = action.disabled;
    button.addEventListener('click', () => { menu.open = false; action.click(); }); actions.append(button);
  }
  menu.hidden = !actions.children.length;
  sectionObserver?.disconnect();
  const sections = $('.rail-sections'); sections.replaceChildren();
  const visibleSections=new Map();
  sectionObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting)visibleSections.set(entry.target.id,entry.boundingClientRect.top);else visibleSections.delete(entry.target.id);}const active=[...visibleSections].sort((a,b)=>a[1]-b[1])[0]?.[0];for(const item of sections.querySelectorAll('button')){if(item.dataset.section===active)item.setAttribute('aria-current','location');else item.removeAttribute('aria-current');}},{root:surface,threshold:0.15});
  for (const section of route.view === 'site' ? surface.querySelectorAll('.uw-step[id], #core-architecture, #core-schemes') : []) {
    const title = section.querySelector('h2,h3'); if (!title) continue;
    if (chatUpdatedSections.has(section.id) && !section.querySelector('.chat-updated-chip')) {const chip=document.createElement('span');chip.className='chat-updated-chip';chip.textContent='Updated from the chat';title.after(chip);}
    const button = document.createElement('button'); button.type = 'button'; button.dataset.section = section.id;
    const name = document.createElement('span'); name.textContent = title.textContent;
    button.append(name);
    const status = section.querySelector('.uw-status'); if (status) { const badge = document.createElement('span'); badge.className='rail-section-status'; badge.textContent=status.textContent.split(' · ')[0]; button.append(badge); }
    button.addEventListener('click', () => { section.scrollIntoView({block:'start'}); title.tabIndex=-1; title.focus({preventScroll:true}); closeNav(); });
    sections.append(button);sectionObserver.observe(section);
  }
}
function navigate(path, state = null, { replace = false } = {}) {
  if(modelingBoot && needsUnderwritingSetup(parseRoute(path),session)) {
    window.location[replace?'replace':'assign'](path);
    return;
  }
  const fromListing = history.state?.fromListing;
  if (state === null && fromListing && parseRoute(path).projectId && parseRoute(path).projectId === route.projectId) state = { fromListing };
  if (path !== window.location.pathname) {
    dockHistoryActive = false;
    if (state?.arosaChatDock) { const { arosaChatDock, ...pageState } = state; state = pageState; }
  }
  if (replace) history.replaceState(state, "", path);
  else if (path !== window.location.pathname) history.pushState(state, "", path);
  // A page replacing itself, as a resolving site does when it lands, leaves History as the reader left it.
  const keepHistory = replace && historyView.isOpen();
  // On a phone the docked chat covers the page, so a new page opens without it.
  if (window.innerWidth <= 850 && !keepHistory) chatDockOpen = false;
  applyRoute({ keepHistory });
}
function applyRoute({ keepHistory = false } = {}) {
  // A new page shows the thread again, unless History holds while it opens a conversation.
  if (!keepHistory) historyView.close();
  const previousProject = route.projectId, previousView = route.view;
  route = resolveRoute(window.location, history, session);
  // The resolving-site page exists only while a site is pending; otherwise it is the sites list.
  if (route.view === "starting" && !home.pending) {
    history.replaceState(null, "", "/sites");
    route = { view: "sites" };
  }
  if (route.projectId !== previousProject) siteTitle = null;
  if (route.projectId !== previousProject || route.view !== previousView) {chatUpdatedSections.clear();pendingSiteReceipt=null;$('#site-update-receipt')?.remove();}
  setBodyMode();
  $("#core-page").hidden = !document.body.classList.contains("core-mode");
  $('#core-page').setAttribute('aria-label', ['models','plan'].includes(route.view) ? 'Modeling' : 'Underwriting');
  $("#plan-button").hidden = !planEntryState(session, window.location.pathname).visible;
  if (route.view === "plan") $("#plan-button").setAttribute("aria-current", "page");
  else $("#plan-button").removeAttribute("aria-current");
  if (route.view !== "report") report.leave();
  if (route.view !== "whats-new") whatsNew.leave();
  if (route.view !== 'models') modeling.leave();
  if (route.view === 'models') { core.leave(); modeling.show(); }
  else if (route.view === "sites") core.showScreen();
  else if (route.view === "starting") core.showStarting(home.pending);
  else if (route.view === "report") {
    core.leave();
    siteAttach = attachProjectConversation(route.projectId).catch((e) => toast(e.message));
    report.show(route.projectId);
  } else if (route.view === "whats-new") {
    core.leave();
    whatsNew.show();
  } else if (route.view === "site" || route.view === "plan") {
    if (home.pending?.projectId === route.projectId) home.setPending(null);
    if (route.view === "plan") core.showPlan(route.projectId, { listingPath: typeof history.state?.fromListing === "string" ? history.state.fromListing : null });
    else core.showParcel(route.projectId);
    siteAttach = attachProjectConversation(route.projectId).catch((e) => toast(e.message));
  } else {
    core.leave();
    document.title = listingsMode() ? "Explore NYC · Arosa" : "Arosa · Zoning intelligence";
  }
  coreCanSend = null;
  render();
  pendingPageFocus = !keepHistory;
  syncPageNavigation();
  if (listingsMode()) listings.inspect(route.listingId || null);
}
// Home without listings opens the chat drawer beside its address entry and recent sites each time
// the page becomes that empty state, and the reader can still close it. On a phone the drawer would
// cover the page, so it waits there. An open the reader did not choose holds only there: once
// listings take the page or the reader moves to another page, the drawer returns to their saved choice.
let homeWasEmpty = false,
  dockAutoOpened = false;
function renderChatCloseLabel() {
  const pageName = route.view === "plan" ? "Modeling" : route.view === "report" ? "Underwriting report" : route.projectId ? $("#site-nav-title").textContent : ({ home: listingsMode() ? "Explore NYC" : "Home", sites: "Underwriting", models: "Modeling", "whats-new": "What's new", starting: "New site", shared: "the page" })[route.view];
  const label = window.innerWidth <= 850 ? `Back to ${pageName}` : "Close chat";
  $(".core-chat-close").setAttribute("aria-label", label);
  $(".core-chat-close").title = label;
}
window.addEventListener("resize", renderChatCloseLabel);
function setBodyMode() {
  for (const [cls, on] of Object.entries(bodyModes(route))) document.body.classList.toggle(cls, on);
  // An old /chat link opens the drawer once; after that it is the reader's to close.
  if (route.chat) {
    chatDockOpen = true;
    delete route.chat;
  }
  const listingsOn = listingsMode(), homeEmpty = Boolean(session) && route.view === "home" && !listingsOn;
  renderChatCloseLabel();
  if (homeEmpty && !homeWasEmpty && window.innerWidth > 850 && !chatDockOpen) {
    chatDockOpen = true;
    dockAutoOpened = true;
  }
  if (dockAutoOpened && (listingsOn || route.view !== "home")) {
    chatDockOpen = savedDockOpen();
    dockAutoOpened = false;
  }
  homeWasEmpty = homeEmpty;
  // Signed out there is no conversation to run, so the drawer stays closed beside the sign-in notice.
  if (!session) chatDockOpen = false;
  document.body.classList.toggle("listings-mode", listingsOn);
  document.body.classList.add("chat-docked");
  document.body.classList.toggle("chat-dock-open", chatDockOpen);
  foldRailForHome();
  $("#home-listings").hidden = !listingsOn;
  $("#welcome").hidden = route.view !== "home" || listingsOn;
  const askBar = askBarVisible();
  $("#ask-bar").hidden = !askBar;
  document.body.classList.toggle("ask-bar-open", askBar);
  renderAskHandle();
  for (const link of document.querySelectorAll(".app-nav [data-route]")) {
    const target = link.dataset.route;
    const active = target === "/" ? route.view === "home" : target === "/whats-new" ? route.view === "whats-new" : target === '/modeling' ? ['models','plan'].includes(route.view) : ["sites", "site", "report"].includes(route.view);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}
function readProjectChats() {
  return projectChatsKey ? readSaved(projectChatsKey, {}) : {};
}
function rememberProjectChat(projectId, conversationId) {
  if (!projectChatsKey || storageUnavailable) return;
  try {
    localStorage.setItem(projectChatsKey, JSON.stringify({ ...readProjectChats(), [projectId]: conversationId }));
  } catch (e) {
    if (!["SecurityError", "QuotaExceededError"].includes(e.name)) throw e;
    storageUnavailable = true;
  }
}
// The sidebar shows the conversation attached to this project; the first message creates one.
async function attachProjectConversation(projectId) {
  if (!session || (state.id && state.projectId === projectId)) return;
  // On a direct load the archive is still arriving; a missing conversation is only known once it has.
  if (historyLoading) await historyReady;
  if (route.projectId !== projectId || (state.id && state.projectId === projectId)) return;
  // A run still underwriting the site comes first, so its page shows that run's progress.
  const candidates = new Set([jobs.forProject(projectId)?.conversationId, readProjectChats()[projectId], archive.find((c) => c.projectId === projectId)?.id].filter(Boolean));
  for (const id of candidates) {
    try {
      await openConversation(id);
    } catch (e) {
      if (e.status === 404 || e.status === 403) continue;
      throw e;
    }
    if (route.projectId !== projectId || state.projectId === projectId) return;
  }
  if (route.projectId === projectId) startBlankChat();
}
// Selecting a listing or an address: open an existing site for the BBL, otherwise start a
// conversation whose first prompt sets the subject and open the site once it has a project.
async function startSite(site, prompt, bbl) {
  if (bbl) {
    const match = await findSite(bbl);
    if (match) {
      if (pendingSite === site) pendingSite = null;
      navigate(sitePath(match.id, site.section), history.state, { replace: route.view === "starting" });
      return null;
    }
  }
  startBlankChat();
  // The research prompt is not the user's draft, so a failed start leaves the composer empty.
  const { conversationId, started } = await send(prompt, { keepDraft: false, fromListings: site.fromListings, bbl });
  listingSitesAt = 0;
  if (!started) {
    // The start was not acknowledged. The server discards it only if it is still empty.
    if (pendingSite === site) pendingSite = null;
    if (conversationId) void discardEmptyConversation(conversationId);
    return null;
  }
  if (pendingSite !== site) return null;
  site.conversationId = conversationId;
  return { label: site.label, conversationId, section: site.section };
}
async function discardEmptyConversation(id) {
  try {
    await deleteChat("/conversations/" + id + "?empty=1");
  } catch (error) {
    toast(error.message);
    if (error.status === 409) {
      void refreshHistory().catch((e) => toast(e.message));
      if (state.id === id) void openConversation(id).catch((e) => toast(e.message));
    }
    return false;
  }
  if (state.id === id) startBlankChat();
  archive = archive.filter((c) => c.id !== id);
  renderHistory();
  return true;
}
// The address entry on home and a listing both start a site. Both surfaces show the same pending
// box, which follows the run even after the user leaves its conversation. A listing opens the
// site's page at once (open: true): it lays out as the site will and says that Arosa is resolving
// it, then becomes the site once the parcel is identified; the chat stays beside it.
// Returns true once the site has started or an existing site was opened.
async function underwriteSite(label, prompt, bbl, section = null, { open = false } = {}) {
  // One site resolves at a time, so its outcome is always shown before the next one starts.
  if (pendingSite) {
    toast(`Arosa is still resolving ${pendingSite.label}. Start the next site once it is identified.`);
    return false;
  }
  const site = { label, conversationId: null, section, fromListings: listingsMode() };
  pendingSite = site;
  home.setPending({ label, section });
  if (open) navigate(routePath({ view: "starting" }), route.listingId ? { fromListing: window.location.pathname + window.location.search } : null);
  let started;
  try {
    started = await startSite(site, prompt, bbl);
  } catch (e) {
    pendingSite = null;
    home.setPending(null);
    syncStartingPage();
    toast(e.message);
    return false;
  }
  // A start that found an existing site navigated there; a failed start already showed its error.
  if (started) home.setPending(started);
  else if (home.pending && !home.pending.projectId) home.setPending(null);
  syncStartingPage();
  watchPendingSite();
  return Boolean(started) || route.view === "site" || route.view === "plan";
}
// The resolving-site page follows the pending site: it becomes the site once one is identified
// and returns to the sites list when nothing is pending any more.
function syncStartingPage() {
  if (route.view !== "starting") return;
  const pending = home.pending;
  if (pending?.projectId) {
    home.setPending(null);
    navigate(sitePath(pending.projectId, pending.section), history.state, { replace: true });
  } else if (!pending) navigate("/sites", null, { replace: true });
  else core.showStarting(pending);
}
function openPendingSite(pending) {
  historyView.close();
  if (pending.projectId) {
    home.setPending(null);
    navigate(sitePath(pending.projectId, pending.section));
    return;
  }
  if (pending.failed) home.setPending(null);
  if (route.view !== "home") navigate("/");
  if (pending.conversationId && state.id !== pending.conversationId) void openConversation(pending.conversationId).catch((e) => toast(e.message));
}
// The run's own event stream covers the open conversation; otherwise the pending site is polled.
function watchPendingSite() {
  clearInterval(pendingSiteTimer);
  pendingSiteTimer = pendingSite?.conversationId
    ? setInterval(() => {
        if (document.hidden || (state.id === pendingSite?.conversationId && activeRun)) return;
        pollPendingSite();
      }, 5000)
    : null;
}
function checkPendingSite(conversation) {
  if (!pendingSite?.conversationId || pendingSite.conversationId !== conversation.id || !conversation.projectId) return;
  const { label, section } = pendingSite;
  pendingSite = null;
  watchPendingSite();
  home.invalidateSites();
  listingSitesAt = 0;
  rememberProjectChat(conversation.projectId, conversation.id);
  if (state.id === conversation.id) state.projectId = conversation.projectId;
  if (route.view === "sites" || route.view === "starting" || (route.view === "home" && state.id === conversation.id)) {
    home.setPending(null);
    navigate(sitePath(conversation.projectId, section), history.state, { replace: route.view === "starting" });
  } else {
    home.setPending({ label, conversationId: conversation.id, projectId: conversation.projectId, section });
    if (route.view === "home") render();
  }
}
function settlePendingSite(conversation) {
  if (!pendingSite || pendingSite.conversationId !== conversation.id) return;
  const outcome = pendingOutcome(conversation);
  if (outcome === "ready") return checkPendingSite(conversation);
  if (outcome === "waiting") return;
  const { label, section } = pendingSite;
  pendingSite = null;
  watchPendingSite();
  home.setPending(outcome === "failed" ? { label, section, conversationId: conversation.id, failed: true } : null);
  syncStartingPage();
}
function pollPendingSite() {
  if (!pendingSite?.conversationId || pendingSiteCheck) return;
  pendingSiteCheck = chatRequest("/conversations/" + pendingSite.conversationId)
    .then(settlePendingSite)
    .catch(() => {})
    .finally(() => (pendingSiteCheck = null));
}
function afterRunFinished(conversationId) {
  core.refresh();
  home.invalidateSites();
  if (state.id === conversationId) settlePendingSite(state);
}
// One browser draft identity per unsent sitting, shared by every tab through localStorage: the
// server opens at most one conversation per draft, so two tabs sending a first message land in
// one thread. Starting a blank chat on purpose rotates it.
const DRAFT_ID_KEY = storeKey ? storeKey + "-draft-id" : null;
function draftConversationId() {
  if (!DRAFT_ID_KEY) return crypto.randomUUID();
  try {
    let id = localStorage.getItem(DRAFT_ID_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(DRAFT_ID_KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
function rotateDraftConversationId() {
  if (!DRAFT_ID_KEY) return;
  try { localStorage.setItem(DRAFT_ID_KEY, crypto.randomUUID()); } catch { /* storage unavailable: each tab falls back to its own create */ }
}
function startBlankChat() {
  rotateDraftConversationId();
  scrollState.reset();
  ++generation;
  submitPending = false;
  planAttachmentPending = false;
  pendingSubmission = null;
  clearActiveRun();
  stopSharedPolling();
  stashDraft();
  state = { id: null, messages: [], property: null, draft: takeDraft(null), runs: [], access: null, members: [], owner: null };
  save();
  render();
}
// An example question is a question of its own: it starts a new conversation in the chat drawer,
// which opens first so the answer is in view, rather than joining a conversation already there.
function runExample(text) {
  if (state.id || state.messages.length) startBlankChat();
  setChatDock(true, { focus: false });
  send(text);
}
const loadGeneratedUi = createGeneratedUiLoader({
  loadModule: () => import("/genui/generated-ui.js"),
  loadStylesheet: () => {
    if (document.querySelector("link[data-generated-ui-css]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/genui/generated-ui.css";
    link.dataset.generatedUiCss = "";
    document.head.append(link);
  },
});
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    updateLiveTurn();
  });
}
// The open site page shows its conversation's run in the step it is working on.
function updateLiveTurn() {
  renderLiveTurn();
  renderAskHandle();
  const onSite = ((route.view === "site" || route.view === "plan") && state.projectId && state.projectId === route.projectId)
    || (route.view === "starting" && state.id && state.id === pendingSite?.conversationId);
  // When the site's last run failed, the page says so where the run's progress was showing.
  const last = state.messages?.at(-1);
  const failure = onSite && !liveLabel && last?.role === "assistant" && last.error ? { message: last.text, at: last.completedAt || null } : null;
  // A specialist tool runs through the capability gateway; its step is the capability's.
  const tools = activity.filter((item) => item.tool).map((item) => (item.tool === "acres_execute_capability" ? item.arguments?.name || item.tool : item.tool));
  const typicalMs = jobs.forProject(route.projectId)?.typicalMs ?? null;
  const queued = Boolean(activeRun && !runStartedAt && runRecord(activeRun)?.status === "queued");
  core.setRun(onSite && liveLabel ? { label: liveLabel, tools, trail: activity, startedAt: runStartedAt, typicalMs, queued } : null, failure);
}
async function mountGeneratedUi(container, content) {
  // The card's frame holds its place while the viewer code loads.
  const placeholder = document.createElement("div");
  placeholder.className = "generated-skeleton";
  placeholder.style.height = Math.max(100, Number(content?.initialHeight) || 200) + "px";
  placeholder.append(skel("skel-text", { width: "38%", height: "16px" }), skel("skel-text", { width: "62%" }), skel("skel-block", { flex: "1", minHeight: "40px" }));
  placeholder.setAttribute("aria-hidden", "true");
  container.append(placeholder);
  try {
    await loadGeneratedUi();
    placeholder.remove();
    if (container.isConnected)
      window.acresGeneratedUi.render(container, content);
  } catch {
    placeholder.remove();
    container.textContent =
      "This interactive view could not load. The answer and sources are still available.";
  }
}
let historyGeneration = 0;
let historyLoading = Boolean(session);
// The unfiltered history load in flight, so a page that needs the archive can wait for it.
let historyReady = Promise.resolve();
async function refreshHistory(query = "") {
  const load = loadHistory(query);
  if (!query) historyReady = load.catch(() => {});
  return load;
}
async function loadHistory(query) {
  const token = ++historyGeneration;
  historyLoading = true;
  renderHistory();
  try {
    const result = (
      await chatRequest(
        "/conversations" + (query ? "?q=" + encodeURIComponent(query) : ""),
      )
    ).conversations;
    if (token !== historyGeneration) return;
    let merged = result;
    if (!query && state.id && !merged.some((c) => c.id === state.id) && (state.messages.length || busy || submitPending || (state.title && state.title !== "New conversation"))) {
      merged = upsertConversationItem(merged, state, me);
    }
    archive = merged;
    if (!query) {
      historyView.refresh();
      renderChatHead();
    }
  } finally {
    if (token === historyGeneration) {
      historyLoading = false;
      renderHistory();
    }
  }
}
let conversationOpening = false;
function setConversationOpening(id, opening) {
  conversationOpening = opening;
  renderContext();
  for (const row of document.querySelectorAll("[data-conversation]")) {
    if (row.dataset.conversation !== id) continue;
    row.classList.toggle("is-opening", opening);
    if (opening) row.setAttribute("aria-busy", "true");
    else row.removeAttribute("aria-busy");
  }
  const main = $("#main");
  if (main) {
    if (opening) main.setAttribute("aria-busy", "true");
    else main.removeAttribute("aria-busy");
  }
}
// Refreshes reopen the current conversation too, so this leaves History alone; the paths the reader
// takes to a conversation close it themselves.
async function openConversation(id, { preserveScroll = false } = {}) {
  if (!preserveScroll) {
    scrollState.reset();
    ++generation;
    submitPending = false;
    planAttachmentPending = false;
    pendingSubmission = null;
    clearActiveRun();
  }
  const token = generation;
  const load = ++conversationLoad;
  if (!preserveScroll) setConversationOpening(id, true);
  try {
    const result = await chatRequest("/conversations/" + id);
    if (token !== generation || load !== conversationLoad) return;
    applyConversation(result);
  } finally {
    if (!preserveScroll && load === conversationLoad)
      setConversationOpening(id, false);
  }
}
function clearActiveRun() {
  eventStream?.close();
  eventStream = null;
  activeRun = null;
  busy = false;
  activity = [];
  liveMessages = new Map();
  liveUi = [];
}
function isOwner() {
  return !state.access || state.access === "owner";
}
function isViewer() {
  return state.access === "viewer";
}
function canSend() {
  return Boolean(session) && !isViewer();
}
function memberName(account) {
  return (state.members || []).find((m) => m.account === account)?.name || null;
}
function authorDisplay(message) {
  return message.authorName || (message.author && memberName(message.author)) || (message.author === me?.account ? me?.name : null) || "A teammate";
}
function isMultiParticipant() {
  if ((state.members || []).length > 1) return true;
  const authors = new Set((state.messages || []).filter((m) => m.role === "user").map((m) => m.author || m.authorName).filter(Boolean));
  return authors.size > 1;
}
function isSharedThread() {
  if (!state.id) return false;
  if ((state.members || []).length > 1) return true;
  if (state.access && state.access !== "owner") return true;
  const item = archive.find((c) => c.id === state.id);
  return item ? isSharedItem(item, me?.account) : false;
}
function runRecord(id) {
  return (state.runs || []).find((r) => r.id === id) || null;
}
function runAuthorName(run) {
  if (!run) return null;
  return run.authorName || (run.owner && memberName(run.owner)) || (run.owner === me?.account ? me?.name || "You" : null) || "A teammate";
}
function canControlRun(id) {
  const run = runRecord(id);
  if (!run || !run.owner) return isOwner();
  return run.owner === me?.account || state.access === "owner";
}
function handleAccessRemoved(id) {
  archive = archive.filter((c) => c.id !== id);
  if (state.id === id) {
    clearActiveRun();
    stopSharedPolling();
    rotateDraftConversationId();
    state = { id: null, messages: [], property: null, draft: "", runs: [], access: null, members: [], owner: null };
    save();
    render();
    const note = $("#access-note");
    if (note) { note.textContent = "You no longer have access to that conversation."; note.hidden = false; }
  }
  renderHistory();
}
function stopSharedPolling() {
  if (sharedPollTimer) clearInterval(sharedPollTimer);
  sharedPollTimer = null;
}
async function pollSharedThread() {
  if (!state.id || document.hidden || submitPending) return;
  const id = state.id, token = generation;
  try {
    await openConversation(id, { preserveScroll: true });
    if (token !== generation || state.id !== id) return;
    await refreshHistory();
  } catch (e) {
    if (token !== generation) return;
    if (e.status === 404 || e.status === 403) handleAccessRemoved(id);
  }
}
function updateSharedPolling() {
  stopSharedPolling();
  if (isSharedThread() && !document.hidden) sharedPollTimer = setInterval(() => void pollSharedThread(), 5000);
}
function applyConversation(result) {
  const running =
    result.runs.find((r) => r.status === "running") ||
    result.runs.find((r) => r.status === "queued");
  // A queued run is persisted before begin() adds its user message.
  const messages = running && !result.messages.some((m) => m.role === "user" && m.runId === running.id)
    ? [...result.messages, acceptedRunMessage(running)]
    : result.messages;
  if (state.id !== result.id) stashDraft();
  state = { ...result, messages, draft: state.id === result.id ? state.draft : takeDraft(result.id) };
  archive = upsertConversationItem(archive, result, me);
  save();
  if (result.projectId) rememberProjectChat(result.projectId, result.id);
  checkPendingSite(result);
  if (running && running.id !== activeRun) watchRun(running.id);
  else {
    if (!running) clearActiveRun();
    render();
  }
}
function acceptedRunMessage(run) {
  return { id: "accepted-" + run.id, role: "user", text: run.input, runId: run.id, author: run.owner, created: run.created };
}
function watchRun(id) {
  eventStream?.close();
  connectionInterrupted = false;
  activeRun = id;
  busy = true;
  activity = [];
  runStartedAt = null;
  runSince = Date.now();
  liveMessages = new Map();
  liveUi = [];
  const token = generation;
  eventStream = streamRun(
    id,
    (event) => {
      if (token !== generation || activeRun !== id) return;
      connectionInterrupted = false;
      // A restart cut the run off; it starts over, so the partial answer it streamed is dropped.
      if (event.event === "run.requeued") {
        activity = [{ text: event.status }];
        liveMessages = new Map();
        liveUi = [];
      }
      if (event.event === "run.started") runStartedAt = event.time || Date.now();
      if (event.event === "status") activity.push({ text: event.status });
      // The model's reasoning headlines read as notes between the steps.
      if (event.event === "agent.phaseSummary") {
        const thought = thoughtHeadline(event.summary);
        if (thought && activity.at(-1)?.text !== thought) activity.push({ text: thought, thought: true });
      }
      if (event.event === "tool.started")
        activity.push({
          text: toolName(event.tool, event.arguments),
          status: "running",
          tool: event.tool,
          arguments: event.arguments,
        });
      if (event.event === "tool.completed") {
        const item = activity.findLast(
          (x) => x.tool === event.tool && x.status === "running",
        );
        if (item) {
          item.status = event.success ? "complete" : "failed";
          item.detail = event.success ? "" : event.result?.error;
          item.finding = stepFinding(event);
          item.sources = stepSources(event);
        }
      }
      if (event.event === "message.started")
        liveMessages.set(event.id, { phase: event.phase, text: "" });
      if (event.event === "message.delta") {
        const message = liveMessages.get(event.id) || {
          phase: event.phase,
          text: "",
        };
        message.text += event.delta;
        liveMessages.set(event.id, message);
      }
      if (event.event === "message.completed")
        liveMessages.set(event.id, { phase: event.phase, text: event.text });
      if (event.event === "ui.generated") liveUi.push(event.content);
      if (event.event === "concept.created")
        activity.push({ text: "Modeled " + event.name });
      if (event.event === "run.steered")
        activity.push({ text: "Direction updated" });
      if (event.event === "tool.completed") pollPendingSite();
      if (/^run\.(completed|failed|interrupted)$/.test(event.event)) {
        noteRunEnded(event.event, state.id);
        if (event.result?.projectUpdate) {
          updateLiveTurn();
          if (liveTurn?.key === id) renderProjectUpdateNotice(liveTurn.root, event.result.projectUpdate);
        }
        window.dispatchEvent(new Event("acres:wallet-refresh"));
        eventStream?.close();
        const finished = state.id;
        void reopenAfterRun(finished, token)
          .then(() => afterRunFinished(finished))
          .then(() => refreshHistory())
          .catch((e) => toast(e.message));
      } else scheduleRender();
    },
    ({ final }) => {
      if (token !== generation || activeRun !== id) return;
      const giveUp = (message) => {
        eventStream?.close();
        busy = false;
        toast(message);
        render();
      };
      if (final)
        return giveUp(
          "The research connection was interrupted. Reload to reconnect to your saved request.",
        );
      if (!connectionInterrupted)
        activity.push({
          text: "Connection interrupted. Reconnecting to your saved request…",
        });
      connectionInterrupted = true;
      render();
      void chatRequest("/runs/" + id + "/status")
        .then((run) => {
          if (token !== generation || activeRun !== id) return;
          if (!["queued", "running"].includes(run.status))
            return reopenAfterRun(state.id, token);
        })
        .catch((e) => {
          // A 5xx means the research service is restarting; the stream keeps reconnecting.
          if (
            token !== generation ||
            activeRun !== id ||
            e instanceof TypeError ||
            e.status >= 500
          )
            return;
          giveUp(e.message);
        });
    },
  );
  render();
}
// Reloading a finished run's conversation can land in the seconds a deploy drain restarts research,
// when the API answers 5xx; keep retrying, as streamRun does, unless the user has moved on.
async function reopenAfterRun(id, token) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await openConversation(id, { preserveScroll: true });
    } catch (e) {
      if (token !== generation) return;
      if (!(e.status >= 500) || attempt >= 40) throw e;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
// The live activity names each step in plain words; activity-view.js owns the wording.
function toolName(name, args = {}) {
  return describeStep(name, args, "running");
}
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function toast(t) {
  const notice = $(".toast");
  notice.querySelector(".toast-message").textContent = publicErrorMessage({message:String(t),userFacing:true});
  notice.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (notice.hidden = true), 4000);
}
$(".toast-dismiss").addEventListener("click", () => {
  clearTimeout(toastTimer);
  $(".toast").hidden = true;
});
let contextTrigger;
let contextSiteId = null, contextSite = null, contextLoadingFor = null;
async function readContextSite(id) {
  contextLoadingFor=id;contextVersion=null;renderContext();
  try {const site=await chatRequest('/projects/'+encodeURIComponent(id)+'/state');if(route.projectId!==id)return;contextSiteId=id;contextSite=site;}
  finally {if(contextLoadingFor===id){contextLoadingFor=null;contextVersion=null;renderContext();}}
}
function toggleContext(open) {
  const panel = $(".context-panel");
  const show = open === undefined ? panel.hidden : open;
  if (show) {
    contextTrigger = document.activeElement; historyView.close(); setChatDock(true, {focus:false});
    if (route.projectId && contextSiteId !== route.projectId && contextLoadingFor !== route.projectId) void readContextSite(route.projectId).catch(error=>toast(error.message));
  }
  panel.hidden = !show;
  $("#chat-panel").classList.toggle("drawer-context-open", show);
  $("#drawer-conversation-tab").setAttribute("aria-selected", String(!show));
  $("#drawer-context-tab").setAttribute("aria-selected", String(show));
  $("#drawer-conversation-tab").tabIndex = show ? -1 : 0;
  $("#drawer-context-tab").tabIndex = show ? 0 : -1;
  for (const toggle of document.querySelectorAll(".context-toggle")) toggle.setAttribute("aria-expanded", String(show));
  $(".context-scrim").hidden = true;
  if (!show && contextTrigger?.isConnected && contextTrigger.getClientRects().length) contextTrigger.focus({preventScroll:true});
}
$(".chat-panel-head").after($(".drawer-tabs"));
$("#main").append($(".context-panel"));
$(".context-panel").classList.add("drawer-context");
$("#conversation").setAttribute("role", "tabpanel");
$("#conversation").setAttribute("aria-labelledby", "drawer-conversation-tab");
$("#property-context").setAttribute("role", "tabpanel");
$("#property-context").setAttribute("aria-labelledby", "drawer-context-tab");
$("#drawer-conversation-tab").addEventListener("click", () => toggleContext(false));
$("#drawer-context-tab").addEventListener("click", () => toggleContext(true));
$(".drawer-tabs").addEventListener("keydown", e => {
  if (!["ArrowLeft","ArrowRight","Home","End"].includes(e.key)) return;
  e.preventDefault();
  const context = e.key === "End" || (e.key !== "Home" && e.target.id === "drawer-conversation-tab");
  toggleContext(context);
  $(context ? "#drawer-context-tab" : "#drawer-conversation-tab").focus();
});
$(".context-scrim").addEventListener("click", () => toggleContext(false));
document.addEventListener("keydown", (e) => {
  if (!$(".context-panel").hidden && !$("#source-dialog").open) {
    if (e.key === "Escape" && !e.isComposing) {
      e.preventDefault();
      toggleContext(false);
    }
  }
});
matchMedia("(max-width:1150px)").addEventListener("change", () =>
  toggleContext(false),
);
matchMedia("(max-width:850px)").addEventListener("change", () =>
  toggleNav(window.innerWidth > 850),
);
// The drawer header: the conversation's title, then the site it belongs to and whether it is saved.
// A blank chat on a site page belongs to that site; a site chat opened elsewhere names its site, from
// History's list until the conversation itself loads. A title that already is the site name is not
// repeated, and a conversation still loading claims no save.
function renderChatHead() {
  const item = state.id ? archive.find((c) => c.id === state.id) : null;
  const title = state.title || item?.title;
  $("#chat-context-title").textContent = title && title !== "New conversation" ? title : "New conversation";
  const siteId = state.projectId || item?.site?.id || (!state.id && route.projectId) || null;
  const site = siteId && ((siteId === route.projectId && siteTitle) || item?.site?.title || displayAddress(state.property?.address) || "Saved site");
  $(".chat-attached").textContent = !site ? "Not attached to a site" : site.trim().toLowerCase() === (title || "").trim().toLowerCase() ? "Site conversation" : site;
  const saved = $(".saved-label");
  const status = !session ? "Sign in to save" : submitPending ? "Saving…" : state.id && !state.unloaded ? "Saved" : "";
  if (saved.textContent !== status) saved.textContent = status;
  saved.hidden = !status;
  // Property & sources opens from the rail on a site's pages; elsewhere the thread offers it once
  // the conversation has a property or a cited source.
  $(".chat-sources").hidden = !(state.property || state.messages.some((m) => m.sources?.length));
}
function save() {
  if (!session || storageUnavailable) return;
  try {
    localStorage.setItem(
      storeKey,
      JSON.stringify({ id: state.id, draft: state.draft || "", drafts: Object.fromEntries([...drafts].map(([k, v]) => [k ?? "", v])) }),
    );
  } catch (e) {
    if (!["SecurityError", "QuotaExceededError"].includes(e.name)) throw e;
    storageUnavailable = true;
  }
}
function renderHistory() {
  const { items, activeId } = sidebarConversationList(archive, {
    state,
    pendingSubmission,
    submitPending,
    busy,
    me,
  });
  // A conversation started or opened on a site's pages belongs to that site before the list says so.
  const sites = new Map([...siteChats].map(([projectId, chat]) => [chat.id, { id: projectId, title: chat.title, workflow:chat.workflow }]));
  renderRecentRail($(".rail-recent"), items.map((c) => (c.site === undefined && sites.has(c.id) ? { ...c, site: sites.get(c.id) } : c)), activeId);
  refitRecent();
}
setInterval(() => refreshRecentTimes($(".rail-recent")), 60000);
function answerHtml(m, index) {
  let html = DOMPurify.sanitize(marked.parse(m.text), {
    ALLOWED_TAGS: [
      "p",
      "strong",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      "code",
      "pre",
      "br",
      "hr",
    ],
    ALLOWED_ATTR: [],
  });
  html = html.replace(/\[(\d+)\]/g, (match, n) =>
    m.sources?.some((s) => s.id === Number(n))
      ? `<button class="citation" data-message="${index}" data-source="${n}" aria-label="Read source ${n}">${n}</button>`
      : match,
  );
  return html;
}
function showSource(index, id) {
  const m = state.messages[index],
    s = m?.sources?.find((s) => s.id === Number(id));
  if (!s) return;
  fillSourceDialog(s);
  $("#source-dialog").showModal();
}
function showConcept(index, id) {
  const m = state.messages[index],
    concept = m?.concepts?.find((c) => c.id === id);
  if (!concept) return;
  $("#concept-title").textContent = concept.name;
  $("#concept-summary").textContent = concept.summary || "";
  const body = $("#concept-body");
  window.acresConceptView?.unmount(body);
  body.replaceChildren();
  // The model's frame holds its place while the viewer loads; the viewer replaces it.
  const loading = document.createElement("div");
  loading.className = "concept-fallback concept-skeleton";
  loading.setAttribute("role", "status");
  const hint = document.createElement("span");
  hint.className = "sr-only";
  hint.textContent = "Loading the 3D model";
  loading.append(hint, skel("skel-block", { height: "min(56vh, 520px)" }));
  body.append(loading);
  $("#concept-dialog").showModal();
  mountConceptView(body, concept, m.places || []).catch(() => {
    loading.replaceChildren();
    loading.removeAttribute("role");
    loading.className = "concept-fallback";
    loading.textContent = "The 3D model could not load in this browser.";
  });
}
function renderContext() {
  const version = JSON.stringify([
    conversationOpening,
    contextLoadingFor,
    state.property,
    contextSiteId === route.projectId ? contextSite?.version : null,
    state.messages.findLast((m) => m.sources?.length)?.id,
  ]);
  if (version === contextVersion) return;
  contextVersion = version;
  const p = (contextSiteId === route.projectId ? contextSite?.fields?.property?.value : null) ?? state.property;
  const box = $(".context-content");
  box.replaceChildren();
  box.removeAttribute("aria-busy");
  // While a conversation opens, the panel holds the property's shape: label, address, facts, sources.
  if (conversationOpening || (contextLoadingFor && contextLoadingFor === route.projectId)) {
    box.setAttribute("aria-busy", "true");
    const loading = document.createElement("div");
    loading.className = "context-skeleton";
    loading.setAttribute("role", "status");
    const hint = document.createElement("span");
    hint.className = "sr-only";
    hint.textContent = "Loading the property";
    const facts = document.createElement("div");
    facts.className = "context-skeleton-facts";
    for (let i = 0; i < 4; i++) facts.append(skel("skel-text", { width: "28%" }), skel("skel-text", { width: `${44 + (i % 2) * 18}%` }));
    loading.append(hint, skel("skel-text", { width: "42%", height: "10px" }), skel("skel-title", { width: "78%", marginTop: "10px" }), skel("skel-text", { width: "36%", marginTop: "10px" }), facts, skel("skel-block", { height: "56px" }), skel("skel-block", { height: "56px", marginTop: "8px" }));
    box.append(loading);
    return;
  }
  const label = document.createElement("span");
  label.className = "section-kicker";
  label.textContent = p?.bbl ? "NEW YORK CITY · PARCEL RECORD" : "PROPERTY";
  box.append(label);
  const title = document.createElement("h2");
  title.textContent = p ? p.address : "No property yet";
  box.append(title);
  const sub = document.createElement("p");
  sub.className = "muted";
  sub.textContent = p
    ? [p.bbl ? `BBL ${p.bbl}` : "", p.version ? `PLUTO ${p.version}` : ""].filter(Boolean).join(" · ")
    : "Ask about an address, with its city and state.";
  if (sub.textContent) box.append(sub);
  const rows = p ? parcelRows(p) : [];
  if (rows.length) {
    const dl = document.createElement("dl");
    for (const [name, value] of rows) {
      const row = document.createElement("div"),
        dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = name;
      dd.textContent = value;
      if (value === PARCEL_ABSENT) dd.className = "muted";
      row.append(dt, dd);
      dl.append(row);
    }
    box.append(dl);
  }
  const last = state.messages.findLast(
    (m) => m.role === "assistant" && m.sources?.length,
  );
  if (last) {
    const heading = document.createElement("h3");
    heading.textContent = "Sources";
    box.append(heading);
    for (const s of last.sources) {
      const b = document.createElement("button");
      b.className = "source-card";
      b.dataset.message = state.messages.indexOf(last);
      b.dataset.source = s.id;
      b.innerHTML = `<div><strong>${escape(s.title)}</strong><small>${escape(new URL(s.url).hostname)}</small></div>`;
      box.append(b);
    }
  }
  if (p || last) {
    const note = document.createElement("p");
    note.className = "sample-note";
    note.textContent = "Reported zoning and floor area do not establish a legal development entitlement.";
    box.append(note);
  }
}

function renderLiveTurn() {
  if (!busy && !submitPending) {
    liveTurn?.root.remove();
    liveTurn = null;
    liveLabel = null;
    return;
  }
  const runKey = activeRun || "starting";
  const main = $("#main");
  const follow = scrollState.isFollowing();
  if (!liveTurn || liveTurn.key !== runKey || !liveTurn.root.isConnected) {
    liveTurn?.root.remove();
    const root = document.createElement("article");
    root.id = "live-turn";
    root.className = "message assistant live-answer";
    const askingName = activeRun ? runAuthorName(runRecord(activeRun)) : null;
    const asking = isMultiParticipant() && askingName ? `<span class="run-asking">${escape(askingName)} is asking…</span>` : "";
    root.innerHTML =
      `<div class="assistant-label"><svg class="assistant-logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><path d="M8 24h4v-5h8v5h4V14h-4v-4h-4V6h-4v4H8z" fill="var(--bg)"/></svg>Arosa${asking}</div>`;
    const view = createActivityView();
    root.append(view.root);
    liveTurn = { key: runKey, root, view, answers: new Map() };
    $("#messages").append(root);
  }
  const commentary = [...liveMessages.values()]
    .filter((m) => m.phase === "commentary" && m.text)
    .map((m) => ({ text: m.text }));
  const writing = [...liveMessages.values()].some(
    (m) => m.phase !== "commentary" && m.text,
  );
  const tool = activity.findLast((item) => item.status === "running");
  // A run waits in the queue until a research slot frees up; it starts on its own.
  const queued = activeRun && !runStartedAt && runRecord(activeRun)?.status === "queued";
  const label = !navigator.onLine
    ? "You're offline. Your request is saved."
    : connectionInterrupted
      ? "Reconnecting to your saved request…"
      : writing
        ? (latestFinalAnswer(liveMessages)?.revision > 1 ? "Revising the answer" : "Writing answer")
        : queued
          ? "Waiting for a free research slot"
          : tool?.text || "Researching";
  liveTurn.view.update(
    [...activity, ...commentary],
    submitPending && !busy ? "Starting research" : label,
    true,
  );
  liveLabel = submitPending && !busy ? "Starting research" : label;
  // The harness may rewrite its answer (citation repair, deliverable fill); only the newest draft
  // shows, in place of the one before it.
  const latest = latestFinalAnswer(liveMessages);
  for (const [id, rendered] of liveTurn.answers) if (!latest || id !== latest.id) { rendered.element.remove(); liveTurn.answers.delete(id); }
  if (latest) {
    let rendered = liveTurn.answers.get(latest.id);
    if (!rendered) {
      const answer = document.createElement("div");
      answer.className = "answer";
      rendered = { element: answer, text: null };
      liveTurn.answers.set(latest.id, rendered);
      liveTurn.root.append(answer);
    }
    if (rendered.text !== latest.text) {
      patchMarkup(rendered.element, DOMPurify.sanitize(marked.parse(latest.text)));
      decorateAnswerHeader(rendered.element, { completedAt: Date.now(), hasSources: true });
      rendered.text = latest.text;
    }
  }
  if (follow) scrollState.follow();
}
// The newest non-commentary message of the live turn, numbered so a rewrite reads as a revision.
function latestFinalAnswer(liveMessages) {
  let latest = null, revision = 0;
  for (const [id, message] of liveMessages) {
    if (message.phase === "commentary" || !message.text) continue;
    revision++;
    latest = { id, text: message.text, revision };
  }
  return latest;
}

// Messages keep their order under the live research turn, which stays last while a run is busy.
function placeMessageNode(node) {
  const messages = $("#messages");
  const live = messages.querySelector("#live-turn");
  if (live) messages.insertBefore(node, live);
  else messages.append(node);
}
function render() {
  if (!busy && pendingSiteReceipt) {const detail=pendingSiteReceipt;pendingSiteReceipt=null;renderSiteReceipt(detail);}
  if (route.view === 'home' && !route.listingId) document.title=listingsMode()?'Explore NYC · Arosa':'Arosa · Zoning intelligence';
  $("#site-nav-title").textContent = siteTitle || displayAddress(state.property?.address) || "Site research";
  const composerFocus = $("#composer").contains(document.activeElement)
    ? document.activeElement
    : null;
  const follow = scrollState.isFollowing();
  renderChatHead();
  if ($("#prompt").value !== (state.draft || ""))
    $("#prompt").value = state.draft || "";
  const acknowledged =
    pendingSubmission &&
    state.messages.find(
      (m) => m.role === "user" && m.runId === pendingSubmission.id,
    );
  const pendingId = pendingSubmission && "pending-" + pendingSubmission.id;
  if (acknowledged) {
    const pendingNode = [...$("#messages").children].find(
      (node) => node.dataset.messageId === pendingId,
    );
    if (pendingNode) pendingNode.dataset.messageId = acknowledged.id;
  }
  const messages =
    pendingSubmission && !pendingSubmission.queued && !acknowledged
      ? [
          ...state.messages,
          { id: pendingId, role: "user", text: pendingSubmission.text },
        ]
      : state.messages;
  const messageIds = new Set(messages.map((m) => m.id));
  for (const node of [...$("#messages").children])
    if (node.id !== "live-turn" && !messageIds.has(node.dataset.messageId))
      node.remove();
  messages.forEach((m, i) => {
    if (
      [...$("#messages").children].some((el) => el.dataset.messageId === m.id)
    )
      return;
    const el = document.createElement("article");
    el.dataset.messageId = m.id;
    el.className = "message " + m.role + (m.error ? " error" : "");
    if (animateMessages.delete(m.id)) {
      el.classList.add("new-message");
      el.addEventListener(
        "animationend",
        () => el.classList.remove("new-message"),
        { once: true },
      );
    }
    if (m.error) el.setAttribute("role", "alert");
    if (m.role === "user") {
      if (isMultiParticipant()) {
        const name = authorDisplay(m);
        const turn = document.createElement("div");
        turn.className = "user-turn";
        const label = document.createElement("span");
        label.className = "author-label";
        const avatar = document.createElement("span");
        avatar.className = "author-avatar";
        avatar.textContent = initials(name);
        const nameEl = document.createElement("span");
        nameEl.className = "author-name";
        nameEl.textContent = name;
        label.append(avatar, nameEl);
        const bubble = document.createElement("div");
        bubble.className = "user-bubble";
        bubble.textContent = splitListingsContext(m.text).text;
        turn.append(label, bubble);
        el.append(turn);
      } else {
        const b = document.createElement("div");
        b.textContent = splitListingsContext(m.text).text;
        el.append(b);
      }
      const { context } = splitListingsContext(m.text);
      if (m.listingPage) el.append(listingPageView(m.listingPage));
      else if (context) {
        const note = document.createElement("small");
        note.className = "listings-context-note";
        note.textContent = "Asked from the deals page";
        note.title = context;
        el.append(note);
      }
    } else {
      const run = runRecord(m.runId || m.traceId);
      el.innerHTML =
        '<div class="assistant-label"><svg class="assistant-logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><path d="M8 24h4v-5h8v5h4V14h-4v-4h-4V6h-4v4H8z" fill="var(--bg)"/></svg>Arosa</div><div class="answer">' +
        answerHtml(m, i) +
        "</div>";
      decorateAnswerHeader(el.querySelector(".answer"), {
        completedAt: m.completedAt || run?.updated || m.created,
        created: m.created,
        hasSources: Boolean(m.sources?.length),
      });
      if (m.projectUpdate) renderProjectUpdateNotice(el, m.projectUpdate);
      const searchContext = listingSearchesView(m.dealSearches, i, { reuse: dealsOnHome });
      if (searchContext) el.append(searchContext);
      if (m.sources?.length) el.append(sourceList(m.sources, i));
      if (m.concepts?.length) el.append(conceptList(m.concepts, i));
    }
    if (m.role === "assistant" && !m.error) {
      const actions = document.createElement("div");
      actions.className = "answer-actions";
      const copy = document.createElement("button");
      copy.className = "copy-answer";
      copy.innerHTML = icon("copy");
      copy.setAttribute("aria-label", "Copy answer");
      copy.title = "Copy answer";
      copy.addEventListener("click", async () => {
        const text =
          m.text +
          (m.dealSearches?.length ? "\n\nListing searches\n" + listingSearchesText(m.dealSearches) : "") +
          (m.sources?.length
            ? "\n\nSources\n" +
              m.sources
                .map((s) => s.id + ". " + s.title + "\n" + s.url)
                .join("\n\n")
            : "");
        try {
          await navigator.clipboard.writeText(text);
          copy.innerHTML = icon("check");
          copy.title = "Copied";
          setTimeout(() => {
            copy.innerHTML = icon("copy");
            copy.title = "Copy answer";
          }, 1800);
          toast("Answer and sources copied.");
        } catch {
          toast("Copy could not finish. Select the answer text to copy it.");
        }
      });
      // Reuse needs the listings page; without deal-store access there is nothing to apply it to.
      if (m.filterUpdate && dealsOnHome) {
        const reuse = document.createElement("button");
        reuse.type = "button";
        reuse.className = "use-saved-filters";
        reuse.textContent = "Use these filters";
        reuse.title = "Apply the saved criteria and recorded cost assumptions. Undo returns to your current filters.";
        reuse.addEventListener("click", () => {
          navigate("/");
          setChatDock(window.innerWidth > 850, { focus: false });
          listings.applySavedFilterUpdate(m.filterUpdate);
        });
        actions.append(reuse);
      }
      // An answer that built the underwriting deck opens it, in any conversation, with or without a site page.
      if (m.deck && state.id) {
        const deck = document.createElement("button");
        deck.type = "button";
        deck.className = "open-deck";
        deck.textContent = "Open deck";
        deck.title = "Open the underwriting deck to print or save as PDF";
        deck.addEventListener("click", () => window.open(`/api/conversations/${encodeURIComponent(state.id)}/deck?format=html`, "_blank", "noopener"));
        actions.append(deck);
      }
      actions.append(copy);
      el.append(actions);
    }
    if ((m.error || m.interrupted) && i === state.messages.length - 1) {
      const retry = document.createElement("button");
      retry.className = "retry-button";
      retry.textContent = "Edit and retry";
      retry.addEventListener("click", () => {
        $("#prompt").value = splitListingsContext(m.retryText).text;
        state.draft = splitListingsContext(m.retryText).text;
        save();
        updateInput();
        $("#prompt").focus();
      });
      el.append(retry);
    }
    if (m.ui?.length)
      m.ui.forEach((content, j) =>
        el.append(generatedWidget(content, m.id + ":" + j)),
      );
    if (m.traceId && m.role === "assistant") {
      const run = runRecord(m.runId || m.traceId);
      const durationMs =
        m.durationMs ??
        (run?.created && run?.updated && run.updated >= run.created
          ? run.updated - run.created
          : null);
      el.insertBefore(
        savedActivity(
          m.traceId,
          (id) => chatRequest("/runs/" + id),
          toolName,
          m.error || m.interrupted,
          durationMs,
        ),
        el.querySelector(".answer"),
      );
    }
    placeMessageNode(el);
  });
  updateLiveTurn();
  let controls = $("#run-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.id = "run-controls";
    controls.className = "run-controls";
    $(".composer-right").prepend(controls);
  }
  controls.replaceChildren();
  if (busy && canControlRun(activeRun)) {
    const steer = document.createElement("button");
    steer.type = "button";
    steer.innerHTML = icon("steer") + "Steer";
    steer.title = "Send this direction to the running answer";
    steer.disabled = planAttachmentPending || !$("#prompt").value.trim();
    steer.addEventListener("click", () => steerRun());
    controls.append(steer);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "stop-button";
    stop.innerHTML = icon("stop");
    stop.setAttribute("aria-label", "Stop");
    stop.title = "Stop research";
    stop.addEventListener("click", () => interruptRun(activeRun));
    controls.append(stop);
  } else if (busy) {
    const asking = document.createElement("span");
    asking.className = "run-asking";
    asking.textContent = `${runAuthorName(runRecord(activeRun))} is asking…`;
    controls.append(asking);
  }
  const queued = (state.runs || []).filter(
    (r) => r.status === "queued" && r.id !== activeRun,
  );
  if (
    pendingSubmission?.queued &&
    !state.runs.some((r) => r.id === pendingSubmission.id)
  )
    queued.push({
      id: pendingSubmission.id,
      input: pendingSubmission.text,
      pending: true,
    });
  let queue = $("#message-queue");
  if (!queue) {
    queue = document.createElement("div");
    queue.id = "message-queue";
    queue.className = "message-queue";
    $("#composer-dock").prepend(queue);
  }
  queue.replaceChildren();
  if (queued.length) {
    const label = document.createElement("strong");
    label.textContent = "Queued next";
    queue.append(label);
  }
  for (const run of queued) {
    const row = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = run.input;
    row.append(text);
    if (run.pending) {
      const status = document.createElement("small");
      status.textContent = "Sending…";
      status.setAttribute("role", "status");
      row.append(status);
      queue.append(row);
      continue;
    }
    if (isMultiParticipant() && runAuthorName(run)) {
      const who = document.createElement("small");
      who.className = "run-asking";
      who.textContent = runAuthorName(run);
      row.append(who);
    }
    if (canControlRun(run.id)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.innerHTML = icon("close");
      remove.setAttribute("aria-label", "Remove queued message");
      remove.addEventListener("click", () => interruptRun(run.id));
      row.append(remove);
    }
    queue.append(row);
  }
  $(".send-button").disabled =
    !canSend() || submitPending || !$("#prompt").value.trim();
  $(".send-button").setAttribute(
    "aria-label",
    busy ? "Queue message" : "Send message",
  );
  $("#prompt").disabled = !canSend();
  const viewerNotice = $("#viewer-notice");
  if (viewerNotice) {
    viewerNotice.hidden = !(isViewer() && Boolean(state.id));
    $("#composer").hidden = isViewer() && Boolean(state.id);
  }
  renderAccount();
  const shareButton = $("#share-button");
  if (shareButton) {
    shareButton.disabled = !session || !state.id;
    const count = (state.members || []).length;
    shareButton.setAttribute("aria-label", count > 1 ? `Share, ${count} people` : "Share");
    shareButton.title = !state.id ? "Open a conversation to share it" : count > 1 ? `Shared with ${count} people` : "Share this conversation";
  }
  // A running request shows in the header beside the title, wherever the chat is open.
  const runStatus = $(".chat-run-status");
  runStatus.hidden = !(busy || submitPending);
  runStatus.querySelector("span").textContent = submitPending && !busy ? "Starting" : "Researching";
  $(".new-chat").disabled = !session;
  document
    .querySelectorAll("[data-prompt]")
    .forEach((b) => (b.disabled = !session));
  for (const [key, widget] of widgets) {
    if (!widget.isConnected) {
      window.acresGeneratedUi?.unmount(widget);
      widgets.delete(key);
    }
  }
  renderContext();
  $(".nav-item[data-view=properties] .count").textContent = state.property
    ? "1"
    : "0";
  updateSourcesCount();
  const titled = state.title && state.title !== "New conversation" ? state.title : null;
  $("#conversation-title").textContent = {
    home: "Arosa",
    sites: "Underwriting",
    models: "Modeling",
    site: siteTitle || state.property?.address || "Site",
    starting: siteTitle || "New site",
    plan: "Modeling",
    report: "Underwriting report",
  }[route.view] || "Arosa";
  renderPlanNotes();
  const chatEmpty = $(".core-chat-empty");
  chatEmpty.hidden = Boolean(state.messages.length || busy || submitPending);
  $(".listings-suggestions").hidden = chatEmpty.hidden || !listingsMode();
  // A site's chat offers its floor plan and walkthrough to accounts with the architecture tools.
  $(".site-suggestions").hidden = chatEmpty.hidden || route.view !== "site" || session?.architectureEnabled !== true;
  chatEmpty.textContent = listingsMode()
    ? "Ask about these listings, or describe the filters you want."
    : route.view === "sites"
      ? "Ask about your saved sites, or name an address to research a new one."
      : ["site", "plan", "report", "starting"].includes(route.view)
        ? "Ask Arosa about this site. Its answers update this page."
        : "Ask about any address or idea: what zoning allows, what you could build and what the land is worth.";
  // A conversation opened from history while the listings show opens the chat beside them.
  if (listingsMode() && state.id !== listingsConversation) {
    listingsConversation = state.id;
    if (state.id && state.messages.length && !chatDockOpen) setChatDock(true, { focus: false, remember: false });
  }
  for (const m of state.messages) {
    if (m.role !== "assistant" || (!m.dealSearch && !m.filterUpdate) || !listingRuns.has(m.runId) || appliedSearches.has(m.id)) continue;
    if (listingsMode()) {
      appliedSearches.add(m.id);
      if (m.filterUpdate) listings.applyFilterUpdate(m.filterUpdate);
      else if (!m.filterContext) listings.applySearch(m.dealSearch);
    }
  }
  if (route.view === "site" && coreCanSend !== siteCanSend()) {
    coreCanSend = siteCanSend();
    core.rerender();
  }
  if (["site", "plan", "report"].includes(route.view) && state.id && state.projectId === route.projectId) siteChats.set(route.projectId, { id: state.id, access: state.access, title: siteTitle, workflow:route.view === 'plan' ? 'modeling' : 'underwriting' });
  renderHistory();
  updateInput();
  home.syncAccess();
  listings.syncAccess();
  if (route.view === "home") home.showSites();
  if (listingsMode()) {
    listings.show();
    loadListingSites();
  }
  if (follow) scrollState.follow();
  else scrollState.update();
  if (composerFocus?.isConnected && composerFocus !== document.activeElement)
    composerFocus.focus({ preventScroll: true });
  updateSharedPolling();
}
// Resolves to the target conversation id (null when none was created) and whether its run started.
// fromListings says whether the message carries the listings page as context; a site started from
// a listing keeps that context after its page has opened.
// bbl names the parcel of a new site, so the site is found by it before its first run identifies it.
async function send(text, { keepDraft = true, fromListings = listingsMode(), bbl = null } = {}) {
  text = text.trim();
  const notSent = { conversationId: null, started: false };
  if (!text || !session || submitPending || planAttachmentPending) return notSent;
  if (isViewer() && state.id) { toast("You can view this thread. Ask the owner for access to take part."); return notSent; }
  if (text.length > 3000) {
    toast("Keep your question under 3,000 characters.");
    return notSent;
  }
  // The question and its answer land in the thread, so History gives way to it.
  historyView.close();
  // Plan notes for this conversation's project ride in front of the message; the draft keeps only the user's text.
  const notesProject = state.id ? state.projectId : route.projectId;
  const notes = notesProject && planNotes.projectId === notesProject ? planNotes.notes : [];
  const listingFilters = fromListings ? {prompt: text, snapshot: listings.filterSnapshot(), page: listings.pageSnapshot()} : null;
  const runMessage = fromListings ? withListingsContext(withPlanNotes(text, notes), listings.context()) : withPlanNotes(text, notes);
  // The chat opens beside the listings to show the answer; a resolving site's page shows it itself.
  if (fromListings && !chatDockOpen && route.view !== "starting") setChatDock(true, { focus: false });
  submitPending = true;
  pendingSubmission = { id: crypto.randomUUID(), text: runMessage, queued: busy };
  const submission = pendingSubmission;
  if (fromListings) listingRuns.add(submission.id);
  if (!busy) animateMessages.add("pending-" + submission.id);
  state.draft = "";
  drafts.delete(state.id);
  $("#prompt").value = "";
  save();
  scrollState.reset();
  render();
  $("#prompt").focus({ preventScroll: true });
  const token = generation;
  let targetConversationId = state.id;
  let started = false;
  try {
    if (!targetConversationId) {
      const projectId = ["site", "plan", "report"].includes(route.view) ? route.projectId : null;
      const conversation = await postChat("/conversations", { ...(projectId ? { projectId } : bbl ? { bbl } : {}), clientDraftId: draftConversationId() });
      targetConversationId = conversation.id;
      if (projectId) rememberProjectChat(projectId, conversation.id);
      archive = upsertConversationItem(
        archive,
        { ...conversation, title: text.slice(0, 100), updated: Date.now() },
        me,
      );
      if (token === generation) {
        state = { ...conversation, ...(projectId ? { projectId } : {}), title: text.slice(0, 100), draft: state.draft };
        save();
      }
      renderHistory();
    }
    const run = await postChat("/conversations/" + targetConversationId + "/runs", {
      message: runMessage,
      id: submission.id,
      ...(listingFilters ? {listingFilters} : {}),
    });
    started = true;
    void jobs.started().catch(() => {});
    window.dispatchEvent(new Event("acres:wallet-refresh"));
    if (token === generation) {
      state.runs = [...state.runs.filter((r) => r.id !== run.id), run];
      if (!busy) {
        if (!state.messages.some((m) => m.role === "user" && m.runId === run.id)) state.messages.push(acceptedRunMessage(run));
        watchRun(run.id);
      }
    }
    if (runMessage !== text) {
      planNotes = { ...planNotes, notes: planNotes.notes.filter((n) => !notes.includes(n)) };
      renderPlanNotes();
    }
    archive = upsertConversationItem(
      archive,
      { id: targetConversationId, title: text.slice(0, 100), updated: Date.now() },
      me,
    );
    renderHistory();
    void refreshHistory().catch(() => {});
    if (token !== generation) return { conversationId: targetConversationId, started };
    const load = ++conversationLoad;
    const conversation = await chatRequest("/conversations/" + targetConversationId);
    if (token !== generation || load !== conversationLoad) return { conversationId: targetConversationId, started };
    for (const m of conversation.messages) {
      if (
        m.role === "user" &&
        (submission.queued || m.runId !== submission.id) &&
        !state.messages.some((old) => old.id === m.id)
      )
        animateMessages.add(m.id);
    }
    applyConversation(conversation);
  } catch (e) {
    if (token !== generation) return { conversationId: targetConversationId, started };
    if (started && (e.status === 403 || e.status === 404)) {
      handleAccessRemoved(targetConversationId);
      return { conversationId: targetConversationId, started };
    }
    if (!started && keepDraft && !state.draft) state.draft = text;
    save();
    if (e.code === "free_limit_reached") window.dispatchEvent(new CustomEvent("acres:plan-limit", { detail: { message: e.message } }));
    else toast(started ? `Your request was saved. Reopen this conversation to check its progress. ${e.message}` : e.message);
  } finally {
    if (token === generation) {
      submitPending = false;
      pendingSubmission = null;
      render();
    }
  }
  return { conversationId: targetConversationId, started };
}
async function steerRun() {
  const text = $("#prompt").value.trim();
  if (!text || !activeRun || planAttachmentPending) return;
  const token = generation;
  state.draft = "";
  drafts.delete(state.id);
  $("#prompt").value = "";
  save();
  updateInput();
  $("#prompt").focus({ preventScroll: true });
  try {
    await postChat("/runs/" + activeRun + "/steer", { message: text });
    if (token !== generation) return;
    toast("Direction updated.");
  } catch (e) {
    if (token !== generation) return;
    if (!state.draft) state.draft = text;
    save();
    toast(e.message);
  }
  render();
}
async function interruptRun(id) {
  const token = generation,
    conversationId = state.id,
    wasActive = id === activeRun;
  $("#prompt").focus({ preventScroll: true });
  try {
    await postChat("/runs/" + id + "/interrupt", {});
    if (token !== generation) return;
    const conversation = await chatRequest("/conversations/" + conversationId);
    if (token !== generation) return;
    toast(wasActive ? "Stopping research…" : "Queued message removed.");
    state.runs = conversation.runs;
    render();
  } catch (e) {
    if (token !== generation) return;
    toast(e.message);
  }
}
// Generated views send text; Core page controls send a state reference {conversation, field, action}.
// Plan notes (a saved revision, an attached drawing) wait for the user's next message in that project's
// conversation and never start a run themselves; a line above the composer shows what Arosa will see.
function queuePlanNote({ projectId, planNote }) {
  // A conversation opened from Recent over the site does not drop the note; it waits for the site's own.
  if (route.projectId !== projectId) return;
  planNotes = { projectId, notes: addPlanNote(planNotes.projectId === projectId ? planNotes.notes : [], planNote) };
  renderPlanNotes();
}
function renderPlanNotes() {
  const line = $("#plan-notes");
  line.hidden = !(planNotes.notes.length && route.projectId === planNotes.projectId && dockOnSite());
  line.textContent = line.hidden ? "" : planNotesLine(planNotes.notes);
}
document.addEventListener("acres-follow-up", (e) => {
  if (e.detail.planNote) return queuePlanNote(e.detail);
  const text = e.detail.ref ? followUpMessage(e.detail.ref) : e.detail.text;
  if (dockOnSite()) return void send(text);
  // The page's request is for the site's own conversation, which comes back into the dock first.
  const projectId = route.projectId;
  void reattachSite().then(() => {
    if (route.projectId === projectId && dockOnSite()) void send(text);
  });
});
$("#plan-button").addEventListener("click", () => {
  closeNav();
  navigate(routePath({ view: "plan", projectId: route.projectId }));
});
// The site's conversation opens in the dock without sending anything.
$("#site-chat-button").addEventListener("click", () => {
  closeNav();
  historyView.close();
  setChatDock(true);
  void reattachSite();
});
window.addEventListener("offline", scheduleRender);
window.addEventListener("online", scheduleRender);
document.addEventListener("click", (e) => {
  const routeLink = e.target.closest("[data-route]");
  if (routeLink) {
    e.preventDefault();
    closeNav();
    navigate(routeLink.dataset.route);
    return;
  }
  const teamRetry = e.target.closest("[data-team-retry]");
  if (teamRetry) {
    void ($("#team-dialog").open ? loadTeams(selectedTeam?.id || focusedTeamId) : loadTeamsCache()).catch(() => {});
    return;
  }
  const teamSelect = e.target.closest("[data-team-select]");
  if (teamSelect) {
    void selectTeamForManagement(teamSelect.dataset.teamSelect).catch(() => {});
    return;
  }
  const recent = e.target.closest("[data-recent]");
  if (recent) {
    // A rail row on a site opens that site on this conversation; any other opens in the drawer over
    // the current page.
    const id = recent.dataset.recent, site = recent.dataset.site;
    closeNav();
    historyView.close();
    const open = async () => {
      if (site && route.projectId !== site) {
        // A conversation on a parcel's other project opens beside the site the saved sites list shows.
        if (archive.find((c) => c.id === id)?.projectId === site) rememberProjectChat(site, id);
        navigate(sitePath(site, recent.dataset.workflow === 'modeling' ? 'architecture' : null));
        // A new page closes the drawer on a phone, so it opens once the site is there.
        setChatDock(true, { focus: false });
        // The site attaches its own conversation first; this one follows if that was another.
        await siteAttach;
        if (route.projectId !== site || state.id === id) return;
      } else {
        setChatDock(true, { focus: false });
        // A site page loaded just now attaches its own conversation first, so it never replaces this one.
        await siteAttach;
      }
      await openConversation(id);
    };
    void open().catch((e) => {
      if (e.status === 404 || e.status === 403) handleAccessRemoved(id);
      else toast(e.message);
    });
    return;
  }
  const conversation = e.target.closest("[data-conversation]");
  if (conversation) {
    // A conversation opens in the chat drawer over the page. A site's pages keep the site's own
    // conversation, so one picked there opens over home. From History, the view stays until it has
    // opened, so a conversation the reader can no longer see is explained where they chose it.
    const id = conversation.dataset.conversation, fromHistory = historyView.isOpen();
    const model = archive.find(c => c.id === id)?.site;
    toggleContext(false);
    closeNav();
    const showDrawer = () => {
      if (model?.workflow === 'modeling') { rememberProjectChat(model.id,id); navigate(sitePath(model.id,'architecture')); }
      else if (["site", "plan", "report"].includes(route.view)) navigate("/");
      setChatDock(true, { focus: false });
    };
    if (String(id).startsWith("pending-")) {
      showDrawer();
      historyView.close();
      return;
    }
    if (fromHistory) conversation.setAttribute("aria-busy", "true");
    // History holds through the move and the open; it closes once the thread is there.
    void historyView.hold(async () => {
      showDrawer();
      if (model?.workflow === 'modeling') await siteAttach;
      return openConversation(id);
    })
      .then(() => historyView.close())
      .catch((e) => {
        if (e.status !== 404 && e.status !== 403) return toast(e.message);
        handleAccessRemoved(id);
        if (fromHistory) void historyView.accessRemoved();
      })
      .finally(() => conversation.removeAttribute("aria-busy"));
    return;
  }
  const draft = e.target.closest("[data-compose]");
  if (draft) {
    $("#prompt").value = draft.dataset.compose;
    state.draft = draft.dataset.compose;
    save();
    updateInput();
    $("#prompt").focus();
    return;
  }
  const p = e.target.closest("[data-prompt]");
  if (p) runExample(p.dataset.prompt);
  // A listing search kept with an answer becomes the listings page's search again.
  const reuseSearch = e.target.closest("[data-listing-search]");
  if (reuseSearch) {
    navigate("/");
    setChatDock(window.innerWidth > 850, { focus: false });
    listings.applyListingSearch(state.messages[Number(reuseSearch.dataset.message)].dealSearches[Number(reuseSearch.dataset.listingSearch)]);
    return;
  }
  const s = e.target.closest("[data-source]");
  if (s) showSource(Number(s.dataset.message), s.dataset.source);
  const c = e.target.closest("[data-concept]");
  if (c) showConcept(Number(c.dataset.message), c.dataset.concept);
});
function updateInput() {
  const prompt = $("#prompt");
  prompt.style.height = "auto";
  prompt.style.height = Math.min(prompt.scrollHeight, 160) + "px";
  prompt.style.overflowY = prompt.scrollHeight > 160 ? "auto" : "hidden";
  const n = prompt.value.length;
  $("#prompt-count").textContent = n.toLocaleString() + " / 3,000";
  $("#prompt-count").hidden = n < 2500;
  $(".send-button").disabled =
    !canSend() || submitPending || planAttachmentPending || !$("#prompt").value.trim();
  $("#attach-plan-button").setAttribute("aria-busy", String(planAttachmentPending));
  $("#attach-plan-button span").textContent = planAttachmentPending ? "Reading text…" : "Add plan text";
  const steer = $("#run-controls button");
  if (steer && busy) steer.disabled = planAttachmentPending || !$("#prompt").value.trim();
}
$("#prompt").addEventListener("input", () => {
  state.draft = $("#prompt").value;
  save();
  updateInput();
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("#prompt").value);
});
// The pill is a real field: pressing Enter sends the question and opens the drawer on the
// answer. With a different draft already waiting in the drawer the text joins it for review
// instead of sending either piece on its own; submitting empty just opens the chat. Enter only
// confirms an IME composition, it never sends half-composed text.
let askComposing = false;
$("#ask-input").addEventListener("compositionstart", () => { askComposing = true; });
$("#ask-input").addEventListener("compositionend", () => { askComposing = false; });
$("#ask-input").addEventListener("input", (e) => {
  $("#ask-handle .send-button").setAttribute("aria-label", e.target.value.trim() ? "Send message" : "Open chat");
});
// A paste longer than the field holds is cut by the browser without a word; say so instead of
// silently dropping the tail of the question.
function notePasteCut(e) {
  const pasted = e.clipboardData?.getData("text") || "";
  const el = e.target;
  const kept = el.value.length - (el.selectionEnd - el.selectionStart);
  if (pasted && kept + pasted.length > el.maxLength) toast("Pasted text was cut to fit 3,000 characters.");
}
$("#prompt").addEventListener("paste", notePasteCut);
$("#ask-input").addEventListener("paste", notePasteCut);
$("#ask-handle").addEventListener("submit", (e) => {
  e.preventDefault();
  if (askComposing) return;
  const input = $("#ask-input");
  const text = input.value;
  openFromHandle();
  if (!text.trim()) return;
  input.value = "";
  $("#ask-handle .send-button").setAttribute("aria-label", "Open chat");
  const prompt = $("#prompt");
  if (prompt.value.trim() && prompt.value.trim() !== text.trim()) {
    prompt.value = prompt.value.replace(/\s+$/, "") + "\n" + text;
    state.draft = prompt.value;
    updateInput();
    save();
    prompt.focus({ preventScroll: true });
    return;
  }
  send(text);
});
// The whole pill is the field: a click on its padding puts the caret in the input, and while it
// shows a run instead of the field, a click opens the drawer.
$("#ask-handle").addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  const input = $("#ask-input");
  if (input.hidden) openFromHandle();
  else if (e.target !== input) input.focus({ preventScroll: true });
});
bindFilterPopover($(".share-more"), $(".share-menu"));
$(".share-menu").setAttribute("aria-label", "More sharing settings");
$("#attach-plan-button")?.addEventListener("click", () => {
  $("#plan-file-input")?.click();
});
let planAttachmentGeneration = 0;
async function attachPlanFile(file) {
  const selection = ++planAttachmentGeneration;
  const pageGeneration = generation;
  planAttachmentPending = true;
  updateInput();
  try {
    const text = await readPlanText(file);
    if (selection !== planAttachmentGeneration) return;
    if (pageGeneration !== generation) { toast("The file text was not added because the conversation changed."); return; }
    const promptEl = $("#prompt");
    promptEl.value = planTextMessage(promptEl.value, file.name, text);
    state.draft = promptEl.value;
    save();
    updateInput();
    toast(`Added complete text from ${file.name}.`);
    promptEl.focus();
  } catch (error) {
    if (selection === planAttachmentGeneration && pageGeneration === generation) toast(error.message);
  } finally {
    if (selection === planAttachmentGeneration) {
      planAttachmentPending = false;
      updateInput();
    }
  }
}
$("#plan-file-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await attachPlanFile(file);
  e.target.value = "";
});
// A file dropped on the page would otherwise replace it in the browser, conversation and all.
// It attaches as plan text instead, opening the chat first when it is closed. A text drag still
// drops into the field it was aimed at.
const fileDrag = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragover", (e) => { if (fileDrag(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file || !canSend()) return;
  historyView.close();
  setChatDock(true);
  void attachPlanFile(file);
});
// A window or drawer width change rewraps the draft; refit its field instead of leaving the
// height fitted to the old width.
window.addEventListener("resize", () => { if ($("#prompt").value) updateInput(); });
// Enter sends where a keyboard offers Shift+Enter for a new line. On a touch screen Enter is
// the new line and the send button sends.
$("#prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
    e.preventDefault();
    send(e.target.value);
  }
});
for (const button of document.querySelectorAll(".new-chat")) button.addEventListener("click", () => {
  historyView.close();
  $("#source-dialog").close();
  $("#concept-dialog").close();
  $("#share-dialog")?.close();
  $("#team-dialog")?.close();
  // A site's chat belongs to that site, so a new chat from a site page opens over home.
  if (route.view === "site" || route.view === "plan") navigate("/");
  startBlankChat();
  setChatDock(true);
  toggleContext(false);
  closeNav();
  $("#prompt").focus();
});
$(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  navigate("/");
});
document
  .querySelectorAll(".context-toggle,.context-chip")
  .forEach((el) => el.addEventListener("click", () => toggleContext()));
$("#close-dialog").addEventListener("click", () => $("#source-dialog").close());
$("#close-concept").addEventListener("click", () => $("#concept-dialog").close());
$("#concept-dialog").addEventListener("close", () =>
  window.acresConceptView?.unmount($("#concept-body")),
);
function dismissDialogBackdrop(e) {
  const r = e.currentTarget.getBoundingClientRect();
  if (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  )
    e.currentTarget.close();
}
$("#source-dialog").addEventListener("click", dismissDialogBackdrop);
$("#concept-dialog").addEventListener("click", dismissDialogBackdrop);
function closeNav() {
  if (window.innerWidth <= 850) toggleNav(false);
}
// The main menu: a drawer on narrow screens, a rail on wider ones that collapses to its icons.
function toggleNav(open) {
  const mobile = window.innerWidth <= 850;
  const show = mobile && open;
  const sidebar = $(".sidebar");
  sidebar.classList.toggle("open", show);
  if (show) { sidebar.setAttribute("role", "dialog"); sidebar.setAttribute("aria-modal", "true"); }
  else { sidebar.removeAttribute("role"); sidebar.removeAttribute("aria-modal"); }
  $(".nav-scrim").hidden = !show;
  $(".shell").inert = show;
  $(".context-panel").inert = show;
  $(".mobile-menu").setAttribute("aria-expanded", String(show));
  $(".mobile-menu").setAttribute("aria-label", show ? "Close menu" : "Open menu");
  if (show) $(".app-nav a").focus();
  else if (mobile) $(".mobile-menu").focus();
}
$(".mobile-menu").addEventListener("click", () => toggleNav(!$(".sidebar").classList.contains("open")));
const RAIL_COLLAPSED_KEY = "acres-rail-collapsed";
function setRailCollapsed(collapsed, { remember = true } = {}) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  $(".rail-collapse").setAttribute("aria-expanded", String(!collapsed));
  $(".rail-collapse").setAttribute("aria-label", collapsed ? "Expand menu" : "Collapse menu");
  if (remember) {
    try {
      localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* A per-viewer convenience only. */
    }
  }
}
$(".rail-collapse").addEventListener("click", () => setRailCollapsed(!document.body.classList.contains("sidebar-collapsed")));
function savedRailCollapsed() {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
setRailCollapsed(savedRailCollapsed(), { remember: false });
// Home needs the width for its list and map: where both fit beside the chat only with the menu as
// icons, the menu folds while the chat is open there and returns to the reader's choice after.
// Narrower, the list and map switch instead; wider, both fit beside the full menu.
const homeRailFold = matchMedia("(min-width: 1280px) and (max-width: 1599px)");
let railFoldedForHome = false;
function foldRailForHome() {
  const fold = listingsMode() && chatDockOpen && homeRailFold.matches;
  if (fold === railFoldedForHome) return;
  railFoldedForHome = fold;
  setRailCollapsed(fold || savedRailCollapsed(), { remember: false });
}
homeRailFold.addEventListener("change", foldRailForHome);
$("#rail-teams").addEventListener("click", () => {
  closeNav();
  openTeams();
});
$(".nav-scrim").addEventListener("click", () => toggleNav(false));
$(".sidebar-close").addEventListener("click", () => toggleNav(false));
function trapFocus(e, root) {
  const controls = [...root.querySelectorAll("a,button,input,textarea")].filter(
    (el) => !el.disabled && el.getClientRects().length,
  );
  const first = controls[0],
    last = controls.at(-1);
  if (
    e.key === "Tab" &&
    ((e.shiftKey && document.activeElement === first) ||
      (!e.shiftKey && document.activeElement === last))
  ) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}
document.addEventListener("keydown", (e) => {
  if ($(".sidebar").classList.contains("open")) {
    if (e.key === "Escape" && !e.isComposing) {
      e.preventDefault();
      toggleNav(false);
    } else trapFocus(e, $(".sidebar"));
  }
});
// The rail's site items only: the listings section carries a data-view of its own.
document.querySelectorAll("#navigation [data-view]").forEach((el) =>
  el.addEventListener("click", () => {
    closeNav();
    if (el.dataset.view === "home") {
      toggleContext(false);
      $("#prompt").focus();
    } else {
      toggleContext(true);
      if (el.dataset.view === "sources")
        $(".context-content h3")?.scrollIntoView({ block: "start" });
    }
  }),
);
for (const button of document.querySelectorAll("[data-history-open]"))
  button.addEventListener("click", () => { toggleContext(false); void historyView.open(button); });
// Sharing dialog
function memberRowElement({ name, email, roleText, account }) {
  const row = document.createElement("div");
  row.className = "member-row";
  const avatar = document.createElement("span");
  avatar.className = "author-avatar";
  avatar.textContent = initials(name || email || "A teammate");
  const label = document.createElement("span");
  label.className = "member-name";
  const strong = document.createElement("strong");
  strong.textContent = name || "A teammate";
  label.append(strong);
  if (email) { const small = document.createElement("small"); small.textContent = email; label.append(small); }
  row.append(avatar, label);
  if (roleText) { const role = document.createElement("span"); role.className = "member-role"; role.textContent = roleText; row.append(role); }
  if (account) row.dataset.account = account;
  return row;
}
function renderEffectiveMembers() {
  const box = $("#share-members");
  box.replaceChildren();
  const members = state.members || [];
  if (!members.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Only you can see this conversation.";
    box.append(p);
    return;
  }
  for (const m of members) {
    const roleText = m.via === "owner" ? "Owner" : m.via === "team" ? `${m.role} · via team` : m.role;
    box.append(memberRowElement({ name: m.name, email: m.email, roleText, account: m.account }));
  }
}
function renderShareGrants() {
  const box = $("#share-members");
  box.replaceChildren();
  const ownerMember = (state.members || []).find((m) => m.via === "owner");
  if (ownerMember) box.append(memberRowElement({ name: ownerMember.name, email: ownerMember.email, roleText: "Owner", account: ownerMember.account }));
  for (const grant of shareGrants) {
    const label = grant.principalType === "team" ? `${grant.name || "Team"} (team)` : grant.name || grant.email || "A teammate";
    const row = memberRowElement({ name: label, email: grant.principalType === "account" ? grant.email : null, account: grant.principal });
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Role for ${label}`);
    for (const role of ["viewer", "participant"]) {
      const option = document.createElement("option");
      option.value = role; option.textContent = role[0].toUpperCase() + role.slice(1);
      if (grant.role === role) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await patchChat(`/conversations/${state.id}/members/${grant.principalType}/${encodeURIComponent(grant.principal)}`, { role: select.value });
        toast("Access updated.");
        await refreshAfterShareChange();
      } catch (e) { toast(e.message); void loadShare(); }
      finally { select.disabled = false; }
    });
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      setControlBusy(remove, true, "Removing…");
      try {
        await deleteChat(`/conversations/${state.id}/members/${grant.principalType}/${encodeURIComponent(grant.principal)}`);
        toast("Access removed.");
        await refreshAfterShareChange();
      } catch (e) { toast(e.message); }
      finally { setControlBusy(remove, false); }
    });
    row.append(select, remove);
    box.append(row);
  }
  if (!shareGrants.length && !ownerMember) renderEffectiveMembers();
  else if (!shareGrants.length) {
    const p = document.createElement("p"); p.className = "muted"; p.textContent = "Not shared with anyone yet."; box.append(p);
  }
}
function shareLinkUrl(link) {
  const path = link.path || (link.token ? `/shared/${link.token}` : "");
  return path ? new URL(path, linkOrigin()).href : "";
}
function renderShareLinks() {
  const box = $("#share-links");
  box.replaceChildren();
  const live = shareLinks.filter((l) => !l.revokedAt);
  if (!live.length) {
    const none = document.createElement("p");
    none.className = "share-menu-empty";
    none.textContent = "No view link yet.";
    box.append(none);
  }
  for (const link of live) {
    const row = document.createElement("div");
    row.className = "share-link-setting";
    const label = document.createElement("span");
    label.className = "share-link-state";
    label.textContent = link.expiresAt ? `On · expires ${new Date(link.expiresAt).toLocaleDateString()}` : "On for anyone signed in";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "share-danger";
    revoke.textContent = "Revoke link";
    // Revoking cuts off everyone who has the link, so it asks first, in place.
    revoke.addEventListener("click", () => {
      const confirm = document.createElement("div");
      confirm.className = "share-confirm";
      confirm.setAttribute("role", "group");
      confirm.setAttribute("aria-label", "Revoke the view link");
      const question = document.createElement("span");
      question.textContent = "People who have it lose access.";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "share-danger";
      yes.textContent = "Revoke";
      const no = document.createElement("button");
      no.type = "button";
      no.className = "share-quiet";
      no.textContent = "Keep";
      no.addEventListener("click", () => { confirm.replaceWith(revoke); revoke.focus(); });
      yes.addEventListener("click", async () => {
        const token = link.token;
        if (!token) return;
        setControlBusy(yes, true, "Revoking…");
        no.disabled = true;
        try { await deleteChat(`/conversations/${state.id}/links/${encodeURIComponent(token)}`); toast("Link revoked."); await loadShare(); } catch (e) { toast(e.message); }
        finally { setControlBusy(yes, false); no.disabled = false; }
      });
      confirm.append(question, yes, no);
      revoke.replaceWith(confirm);
      no.focus();
    });
    row.append(label, revoke);
    box.append(row);
  }
}

function renderShareTeamOptions() {
  const select = $("#share-team-select");
  if (!select) return;
  const current = shareTeamSelection;
  select.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = myTeams.length ? "Choose a team…" : "No teams yet"; select.append(placeholder);
  for (const team of myTeams) { const o = document.createElement("option"); o.value = team.id; o.textContent = team.name; select.append(o); }
  const next = myTeams.some((team) => team.id === current) ? current : focusedTeamId || "";
  select.value = next;
  select.disabled = !myTeams.length;
  const add = $("#share-add-team");
  if (add) add.disabled = !next;
  const row = $("#share-team-row");
  if (row) row.hidden = !myTeams.length;
  const empty = $("#share-team-empty");
  if (empty) empty.hidden = Boolean(myTeams.length);
  const note = $("#share-team-focus-note");
  if (note) {
    const team = myTeams.find((item) => item.id === next);
    note.textContent = team && team.id === focusedTeamId ? "Your sharing default" : "";
  }
}
async function loadTeamsCache() {
  if (!session) {
    renderTeamChrome();
    return myTeams;
  }
  if (teamsLoadPromise) return teamsLoadPromise;
  teamsLoading = true;
  renderTeamChrome();
  teamsLoadPromise = (async () => {
    try {
      const result = await chatRequest("/teams");
      myTeams = result.teams || [];
      teamsError = null;
      syncFocusedTeam();
    } catch (e) {
      teamsError = e;
    } finally {
      teamsLoading = false;
      teamsLoadPromise = null;
      renderTeamChrome();
      renderShareTeamOptions();
    }
    return myTeams;
  })();
  return teamsLoadPromise;
}
async function refreshAfterShareChange() {
  await openConversation(state.id, { preserveScroll: true }).catch((e) => { if (e.status === 404 || e.status === 403) handleAccessRemoved(state.id); });
  await refreshHistory().catch(() => {});
  if ($("#share-dialog").open) await loadShare();
}
let shareLoadGeneration = 0;
async function loadShare() {
  const token = ++shareLoadGeneration;
  const conversationId = state.id;
  shareTeamSelection = null;
  const notice = $("#share-notice");
  const dialog = $("#share-dialog");
  const current = () => token === shareLoadGeneration && conversationId === state.id && dialog.open;
  notice.textContent = "";
  dialog.setAttribute("aria-busy", "true");
  $("#share-manage").hidden = true;
  shareGrants = [];
  shareLinks = [];
  $("#share-link-url").value = "";
  $("#share-link-url").hidden = true;
  renderEffectiveMembers();
  try {
    if (!isOwner()) return;
    const [grants, links] = await Promise.allSettled([
      chatRequest(`/conversations/${conversationId}/members`),
      chatRequest(`/conversations/${conversationId}/links`),
    ]);
    if (!current() || !isOwner()) return;
    shareGrants = grants.status === "fulfilled" ? grants.value.members || [] : [];
    notice.textContent = grants.status === "rejected" ? grants.reason.message : "";
    shareLinks = links.status === "fulfilled" ? links.value.links || [] : [];
    await loadTeamsCache();
    if (!current() || !isOwner()) return;
    renderShareTeamOptions();
    renderShareGrants();
    renderShareLinks();
    $("#share-manage").hidden = false;
  } finally {
    if (current()) {
      dialog.removeAttribute("aria-busy");
    }
  }
}
function openShare() {
  if (!state.id) { toast("Open a conversation to share it."); return; }
  $("#share-dialog").showModal();
  void loadShare().catch((e) => toast(e.message));
}
$("#share-button").addEventListener("click", openShare);
$("#close-share").addEventListener("click", () => $("#share-dialog").close());
$("#share-dialog").addEventListener("close", () => { shareTeamSelection = null; });
$("#share-dialog").addEventListener("click", dismissDialogBackdrop);
$("#share-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#share-email").value.trim().toLowerCase();
  const role = $("#share-role").value;
  if (!email) { toast("Enter an email address to share with."); $("#share-email").focus(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("That does not look like a complete email address."); $("#share-email").focus(); return; }
  const submit = e.target.querySelector('button[type="submit"]');
  setControlBusy(submit, true, "Adding…");
  try { await postChat(`/conversations/${state.id}/members`, { email, role }); $("#share-email").value = ""; toast(`Shared with ${email}.`); await refreshAfterShareChange(); }
  catch (error) { toast(error.message); }
  finally { setControlBusy(submit, false); }
});
$("#share-add-team").addEventListener("click", async (e) => {
  const teamId = $("#share-team-select").value;
  if (!teamId) { toast("Choose a team first."); return; }
  setControlBusy(e.currentTarget, true, "Adding…");
  try { await postChat(`/conversations/${state.id}/members`, { teamId, role: $("#share-team-role").value }); toast("Shared with the team."); await refreshAfterShareChange(); }
  catch (error) { toast(error.message); }
  finally { setControlBusy(e.currentTarget, false); renderShareTeamOptions(); }
});
$("#share-copy-link").addEventListener("click", async (e) => {
  setControlBusy(e.currentTarget, true, "Working…");
  try {
    let link = shareLinks.find((l) => !l.revokedAt && (!l.expiresAt || l.expiresAt > Date.now()));
    if (!link) { link = await postChat(`/conversations/${state.id}/links`, {}); shareLinks = [link, ...shareLinks]; renderShareLinks(); }
    const url = shareLinkUrl(link);
    const input = $("#share-link-url"); input.value = url; input.hidden = false;
    await navigator.clipboard.writeText(url);
    toast("View link copied.");
  } catch (error) { toast(error.message); }
  finally { setControlBusy(e.currentTarget, false); }
});
attachPeopleSuggestions($("#share-email"), $("#people-suggestions"));
// Teams: reusable sharing groups, with a focused team used as the Share default.
function readFocusedTeamId() {
  if (!storeKey) return null;
  try {
    const value = JSON.parse(localStorage.getItem(`${storeKey}-focused-team`) || "null");
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}
function persistFocusedTeamId() {
  if (!storeKey) return;
  try {
    if (focusedTeamId) localStorage.setItem(`${storeKey}-focused-team`, JSON.stringify(focusedTeamId));
    else localStorage.removeItem(`${storeKey}-focused-team`);
  } catch { /* A remembered focus is a convenience, not product data. */ }
}
function syncFocusedTeam() {
  const resolved = resolveFocusedTeamId(myTeams, focusedTeamId);
  if (resolved !== focusedTeamId) {
    focusedTeamId = resolved;
    persistFocusedTeamId();
  }
  return focusedTeamId;
}
function focusedTeamSummary() {
  return myTeams.find((team) => team.id === focusedTeamId) || null;
}
function setTeamNotice(message = "", tone = "info") {
  const notice = $("#team-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.setAttribute("role", tone === "error" ? "alert" : "status");
}
function renderTeamChrome() {
  if (myTeams.length) focusedTeamId = resolveFocusedTeamId(myTeams, focusedTeamId);
  renderTeamManagerList({
    teams: myTeams,
    selectedTeamId: teamDialogMode === "create" ? null : selectedTeam?.id || focusedTeamId,
    focusedTeamId,
    loading: teamsLoading,
    error: teamsError,
    query: teamSearchQuery,
  });
}
function setFocusedTeam(id, { renderDetail = false } = {}) {
  if (!myTeams.some((team) => team.id === id)) return;
  focusedTeamId = id;
  persistFocusedTeamId();
  renderTeamChrome();
  renderShareTeamOptions();
  if (renderDetail && selectedTeam) renderTeamDetail();
}
function setControlBusy(control, busy, busyLabel) {
  if (!control) return;
  if (busy) {
    control.dataset.originalLabel = control.textContent;
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    control.setAttribute("aria-busy", "true");
    control.classList.add("is-busy");
    if (busyLabel) control.textContent = busyLabel;
  } else {
    control.disabled = false;
    control.removeAttribute("aria-disabled");
    control.removeAttribute("aria-busy");
    control.classList.remove("is-busy");
    if (control.dataset.originalLabel) control.textContent = control.dataset.originalLabel;
    delete control.dataset.originalLabel;
  }
}
function attachPeopleSuggestions(input, list) {
  if (!input || !list || input.dataset.peopleSuggestionsBound) return;
  input.dataset.peopleSuggestionsBound = "true";
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const result = await chatRequest("/people?q=" + encodeURIComponent(query));
        list.replaceChildren();
        for (const person of result.people || []) {
          const option = document.createElement("option");
          option.value = person.email;
          option.label = person.name;
          list.append(option);
        }
      } catch { /* Directory search is a hint only; adding by email still works. */ }
    }, 250);
  });
}
function teamElement(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}
function confirmActionControl({ label, confirmLabel, className = "", onConfirm }) {
  const wrap = teamElement("span", "team-confirm-actions");
  const initial = teamElement("button", className, label);
  initial.type = "button";
  const reset = () => wrap.replaceChildren(initial);
  initial.addEventListener("click", () => {
    const confirm = teamElement("button", `team-button danger ${className}`, confirmLabel);
    confirm.type = "button";
    const cancel = teamElement("button", "team-button ghost", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", reset);
    confirm.addEventListener("click", async () => {
      setControlBusy(confirm, true, "Working…");
      cancel.disabled = true;
      try { await onConfirm(); }
      finally { if (wrap.isConnected) reset(); }
    });
    wrap.replaceChildren(confirm, cancel);
    confirm.focus();
  });
  wrap.append(initial);
  return wrap;
}
function renderTeamCreate({ focusInput = false } = {}) {
  teamDialogMode = "create";
  renderTeamChrome();
  const box = $("#team-detail");
  box.replaceChildren();
  const wrap = teamElement("div", "team-create-panel");
  const heading = teamElement("h3", null, "New team");
  heading.tabIndex = -1;
  const form = document.createElement("form");
  form.id = "team-create-form";
  form.className = "team-form";
  form.noValidate = true;
  const label = teamElement("label", "team-field-label", "Team name");
  label.htmlFor = "team-name";
  const input = document.createElement("input");
  input.id = "team-name";
  input.type = "text";
  input.placeholder = "e.g. Development partners";
  input.maxLength = 80;
  input.required = true;
  input.autocomplete = "off";
  input.setAttribute("aria-describedby", "team-name-help team-name-error");
  const meta = teamElement("div", "team-field-meta");
  const help = teamElement("span");
  help.id = "team-name-help";
  const count = teamElement("span", "team-char-count", "0 / 80");
  meta.append(help, count);
  const error = teamElement("p", "team-field-error");
  error.id = "team-name-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = teamElement("div", "team-form-actions");
  const cancel = teamElement("button", "team-button ghost", myTeams.length ? "Cancel" : "Close");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    if (myTeams.length) void loadTeams(selectedTeam?.id || focusedTeamId, { mode: "detail", focusDetail: true }).catch((e) => setTeamNotice(e.message, "error"));
    else $("#team-dialog").close();
  });
  const submit = teamElement("button", "team-button primary", "Create team");
  submit.type = "submit";
  submit.disabled = true;
  actions.append(cancel, submit);
  input.addEventListener("input", () => {
    count.textContent = `${input.value.length} / 80`;
    submit.disabled = !input.value.trim();
    if (input.value.trim()) {
      input.removeAttribute("aria-invalid");
      error.hidden = true;
    }
  });
  form.append(label, input, meta, error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = "Give the team a name to continue.";
      error.hidden = false;
      input.focus();
      return;
    }
    setControlBusy(submit, true, "Creating…");
    input.disabled = true;
    cancel.disabled = true;
    try {
      const created = await postChat("/teams", { name });
      const team = created.team || created;
      setTeamNotice(`${team.name} created. Add people to finish setting it up.`, "success");
      await loadTeams(team.id, { mode: "detail", tab: "people", preserveNotice: true });
      setFocusedTeam(team.id, { renderDetail: true });
      $("#team-member-email")?.focus();
    } catch (e) {
      input.disabled = false;
      cancel.disabled = false;
      setControlBusy(submit, false);
      error.textContent = e.message;
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
  });
  wrap.append(heading, form);
  box.append(wrap);
  if (focusInput) input.focus();
}
function renderTeamDetailLoading(summary) {
  const box = $("#team-detail");
  box.replaceChildren();
  const wrap = teamElement("div", "team-detail-loading");
  wrap.setAttribute("role", "status");
  wrap.append(teamElement("span", "sr-only", "Loading the team"));
  if (summary?.name) wrap.append(teamElement("h3", null, summary.name));
  else wrap.append(skel("skel-title", { width: "40%", margin: "4px 0 10px" }));
  wrap.append(skel("skel-text", { width: "56%", marginBottom: "14px" }));
  for (let i = 0; i < 3; i++) {
    const row = teamElement("span", "team-skeleton-row detail");
    row.setAttribute("aria-hidden", "true");
    wrap.append(row);
  }
  box.append(wrap);
}
function renderTeamDetail() {
  const box = $("#team-detail");
  if (!selectedTeam) {
    box.replaceChildren();
    return;
  }
  const team = selectedTeam;
  const teamId = team.id;
  const facts = teamFacts(team, me?.account);
  const owned = facts.owned;
  const members = team.members || [];
  const focused = teamId === focusedTeamId;
  box.replaceChildren();

  const header = teamElement("header", "team-detail-header");
  const identity = teamElement("div", "team-detail-identity");
  const copy = teamElement("div", "team-detail-copy");
  const heading = teamElement("h3", null, team.name);
  heading.tabIndex = -1;
  heading.id = "team-detail-heading";
  const meta = teamElement("p", "team-detail-meta", facts.meta);
  copy.append(heading, meta);
  identity.append(teamAvatar(team.name, "team-avatar large is-selected"), copy);
  const focusControl = focused
    ? teamElement("span", "team-default-chip", "Sharing default")
    : (() => {
        const button = teamElement("button", "team-button ghost compact", "Use for sharing");
        button.type = "button";
        button.addEventListener("click", () => {
          setFocusedTeam(teamId, { renderDetail: true });
          setTeamNotice(`${team.name} will be preselected when you share a conversation.`, "success");
        });
        return button;
      })();
  header.append(identity, focusControl);
  box.append(header);

  const tabs = teamElement("div", "team-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", `${team.name} management`);
  for (const [id, label] of [["people", `People · ${facts.count}`], ["settings", "Settings"]]) {
    const tab = teamElement("button", "team-tab", label);
    tab.type = "button";
    tab.id = `team-tab-${id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(teamDetailTab === id));
    tab.setAttribute("aria-controls", `team-panel-${id}`);
    tab.tabIndex = teamDetailTab === id ? 0 : -1;
    tab.addEventListener("click", () => {
      teamDetailTab = id;
      renderTeamDetail();
      $(`#team-tab-${id}`)?.focus();
    });
    tab.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      teamDetailTab = teamDetailTab === "people" ? "settings" : "people";
      renderTeamDetail();
      $(`#team-tab-${teamDetailTab}`)?.focus();
    });
    tabs.append(tab);
  }
  box.append(tabs);

  const panel = teamElement("section", "team-panel");
  panel.id = `team-panel-${teamDetailTab}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `team-tab-${teamDetailTab}`);
  box.append(panel);

  if (teamDetailTab === "settings") {
    renderTeamSettings(panel, team, owned);
    return;
  }

  if (owned) {
    const addCard = teamElement("section", "team-add-card");
    addCard.append(teamElement("h4", null, "Add people"));
    const form = document.createElement("form");
    form.className = "team-form inline";
    form.noValidate = true;
    const label = teamElement("label", "team-field-label", "Email address");
    label.htmlFor = "team-member-email";
    const fieldWrap = teamElement("div", "team-inline-field");
    const emailInput = document.createElement("input");
    emailInput.id = "team-member-email";
    emailInput.type = "email";
    emailInput.placeholder = "teammate@witharosa.ai";
    emailInput.required = true;
    emailInput.autocomplete = "off";
    emailInput.setAttribute("list", "team-people-suggestions");
    emailInput.setAttribute("aria-describedby", "team-member-error");
    const suggestions = document.createElement("datalist");
    suggestions.id = "team-people-suggestions";
    const addButton = teamElement("button", "team-button primary", "Add member");
    addButton.type = "submit";
    fieldWrap.append(emailInput, suggestions, addButton);
    const error = teamElement("p", "team-field-error");
    error.id = "team-member-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.append(label, fieldWrap, error);
    attachPeopleSuggestions(emailInput, suggestions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = emailInput.value.trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        error.textContent = email ? "That does not look like a complete email address." : "Enter an email address to add someone.";
        error.hidden = false;
        emailInput.setAttribute("aria-invalid", "true");
        emailInput.focus();
        return;
      }
      setControlBusy(addButton, true, "Adding…");
      emailInput.disabled = true;
      try {
        await postChat(`/teams/${encodeURIComponent(teamId)}/members`, { email });
        setTeamNotice(`${email} was added to ${team.name}.`, "success");
        await loadTeams(teamId, { tab: "people", preserveNotice: true });
        $("#team-member-email")?.focus();
      } catch (e) {
        emailInput.disabled = false;
        setControlBusy(addButton, false);
        error.textContent = e.message;
        error.hidden = false;
        emailInput.setAttribute("aria-invalid", "true");
        emailInput.focus();
      }
    });
    addCard.append(form);
    panel.append(addCard);
  } else {
    panel.append(teamElement("p", "team-readonly-note", `Only ${facts.ownerName} can add or remove people.`));
  }

  const listHeading = teamElement("div", "team-section-heading");
  listHeading.append(teamElement("h4", null, "Members"));
  panel.append(listHeading);
  const list = teamElement("div", "team-member-list");
  for (const member of members) {
    const isMe = member.account === me?.account;
    const person = personDisplay(member);
    const row = memberRowElement({
      name: person.primary,
      email: person.secondary,
      roleText: member.role === "owner" ? "Owner" : "Member",
      account: member.account,
    });
    if (isMe) row.querySelector(".member-name strong").textContent += " (you)";
    if (owned && member.role !== "owner" && member.account !== team.owner?.account) {
      row.append(confirmActionControl({
        label: "Remove",
        confirmLabel: "Confirm remove",
        onConfirm: async () => {
          try {
            await deleteChat(`/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(member.account)}`);
            setTeamNotice(`${person.primary} was removed from ${team.name}.`, "success");
            await loadTeams(teamId, { tab: "people", preserveNotice: true });
          } catch (e) {
            setTeamNotice(e.message, "error");
          }
        },
      }));
    }
    list.append(row);
  }
  panel.append(list);
}
function renderTeamSettings(panel, team, owned) {
  const teamId = team.id;
  const facts = teamFacts(team, me?.account);
  if (owned) {
    const form = document.createElement("form");
    form.className = "team-form settings";
    form.noValidate = true;
    const label = teamElement("label", "team-field-label", "Team name");
    label.htmlFor = "team-rename-name";
    const fieldWrap = teamElement("div", "team-inline-field");
    const input = document.createElement("input");
    input.id = "team-rename-name";
    input.type = "text";
    input.value = team.name;
    input.maxLength = 80;
    input.required = true;
    input.setAttribute("aria-describedby", "team-rename-error");
    const save = teamElement("button", "team-button primary", "Save name");
    save.type = "submit";
    save.disabled = true;
    fieldWrap.append(input, save);
    const error = teamElement("p", "team-field-error");
    error.id = "team-rename-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    input.addEventListener("input", () => {
      save.disabled = !input.value.trim() || input.value.trim() === team.name;
      if (input.value.trim()) {
        input.removeAttribute("aria-invalid");
        error.hidden = true;
      }
    });
    form.append(label, fieldWrap, error);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name || name === team.name) return;
      setControlBusy(save, true, "Saving…");
      input.disabled = true;
      try {
        await patchChat("/teams/" + encodeURIComponent(teamId), { name });
        setTeamNotice("Team renamed.", "success");
        await loadTeams(teamId, { tab: "settings", preserveNotice: true });
      } catch (e) {
        input.disabled = false;
        setControlBusy(save, false);
        error.textContent = e.message;
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    });
    panel.append(form);
  }

  const factList = teamElement("dl", "team-facts");
  const created = team.created ? new Date(team.created).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;
  for (const [term, value] of [
    ["Owner", facts.ownerName],
    ["Your role", facts.role],
    ...(created ? [["Created", created]] : []),
  ]) {
    const row = teamElement("div");
    row.append(teamElement("dt", null, term), teamElement("dd", null, value));
    factList.append(row);
  }
  panel.append(factList);

  if (!owned) {
    panel.append(teamElement("p", "team-readonly-note", `Only ${facts.ownerName} can change settings.`));
    return;
  }

  const danger = teamElement("section", "team-danger-zone");
  danger.setAttribute("aria-labelledby", "team-archive-title");
  const dangerTitle = teamElement("h4", null, "Archive team");
  dangerTitle.id = "team-archive-title";
  danger.append(
    dangerTitle,
    teamElement("p", null, "Removes access given through this team. Conversations and direct shares stay."),
    confirmActionControl({
      label: "Archive team",
      confirmLabel: "Yes, archive team",
      className: "danger-outline",
      onConfirm: async () => {
        try {
          await deleteChat("/teams/" + encodeURIComponent(teamId));
          selectedTeam = null;
          setTeamNotice(`${team.name} was archived.`, "success");
          await loadTeams(null, { preserveNotice: true, focusDetail: true });
          await refreshHistory().catch(() => {});
        } catch (e) {
          setTeamNotice(e.message, "error");
        }
      },
    }),
  );
  panel.append(danger);
}
async function loadTeamDetail(id, { tab = "people", focusHeading = false } = {}) {
  teamDialogMode = "detail";
  teamDetailTab = tab;
  const summary = myTeams.find((team) => team.id === id) || null;
  selectedTeam = summary;
  renderTeamChrome();
  renderTeamDetailLoading(summary);
  try {
    const detail = await chatRequest("/teams/" + encodeURIComponent(id));
    selectedTeam = mergeTeamDetail(summary, detail);
    renderTeamChrome();
    renderTeamDetail();
    if (focusHeading) $("#team-detail-heading")?.focus({ preventScroll: true });
    return selectedTeam;
  } catch (e) {
    const box = $("#team-detail");
    box.replaceChildren();
    const wrap = teamElement("div", "team-manager-message is-error detail");
    wrap.append(teamElement("strong", null, "This team couldn’t open."));
    const retry = teamElement("button", "team-button", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => void loadTeamDetail(id, { tab, focusHeading: true }));
    wrap.append(retry);
    box.append(wrap);
    throw e;
  }
}
async function selectTeamForManagement(id) {
  if (!$("#team-dialog").open) {
    openTeams({ teamId: id });
    return;
  }
  teamDetailTab = "people";
  setTeamNotice("");
  await loadTeamDetail(id, { tab: "people", focusHeading: true });
}
async function loadTeams(selectedId = focusedTeamId, { mode = teamDialogMode, tab = teamDetailTab, preserveNotice = false, focusDetail = false } = {}) {
  if (!preserveNotice) setTeamNotice("");
  teamDialogMode = mode;
  await loadTeamsCache();
  renderTeamChrome();
  if (teamsError && !myTeams.length) {
    if (mode === "create") renderTeamCreate();
    else {
      selectedTeam = null;
      const box = $("#team-detail");
      box.replaceChildren();
      const wrap = teamElement("div", "team-manager-message is-error detail");
      wrap.append(teamElement("strong", null, "Teams couldn’t load."));
      const retry = teamElement("button", "team-button", "Retry");
      retry.type = "button";
      retry.dataset.teamRetry = "";
      wrap.append(retry);
      box.append(wrap);
    }
    return;
  }
  if (mode === "create" || !myTeams.length) {
    renderTeamCreate();
    return;
  }
  const target = myTeams.some((team) => team.id === selectedId) ? selectedId : focusedTeamId || myTeams[0]?.id;
  if (target) await loadTeamDetail(target, { tab, focusHeading: focusDetail });
}
function openTeams({ teamId = focusedTeamId, mode = "detail", tab = "people" } = {}) {
  closeNav();
  const dialog = $("#team-dialog");
  teamDialogMode = mode;
  teamDetailTab = tab;
  if (!dialog.open) dialog.showModal();
  if (mode === "create") {
    renderTeamChrome();
    renderTeamCreate({ focusInput: true });
    if (!myTeams.length && !teamsLoading) void loadTeams(teamId, { mode: "create" }).catch((e) => setTeamNotice(e.message, "error"));
    return;
  }
  void loadTeams(teamId, { mode: "detail", tab, focusDetail: true }).catch(() => {});
}
$("#close-teams").addEventListener("click", () => $("#team-dialog").close());
$("#team-dialog").addEventListener("click", dismissDialogBackdrop);
$("#team-create-open").addEventListener("click", () => {
  teamDialogMode = "create";
  setTeamNotice("");
  renderTeamChrome();
  renderTeamCreate({ focusInput: true });
});
$("#team-search").addEventListener("input", (event) => {
  teamSearchQuery = event.target.value;
  renderTeamChrome();
  const input = $("#team-search");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});
$("#share-create-team")?.addEventListener("click", () => {
  teamReturnToShare = true;
  $("#share-dialog")?.close();
  openTeams({ mode: "create" });
});
$("#team-dialog").addEventListener("close", () => {
  if (!teamReturnToShare) return;
  teamReturnToShare = false;
  if (state.id) void openShare();
});
$("#share-team-select")?.addEventListener("change", (event) => {
  shareTeamSelection = event.target.value || null;
  renderShareTeamOptions();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopSharedPolling();
  else { updateSharedPolling(); if (isSharedThread()) void pollSharedThread(); }
});
window.addEventListener("focus", () => { if (isSharedThread()) void pollSharedThread(); });

document.addEventListener("keydown", (e) => {
  if (historyView.onKeydown(e)) return;
  if (onDockShortcut(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && shortcutLetter(e, "o")) {
    e.preventDefault();
    if (!e.repeat) $(".new-chat").click();
  }
});
$(".mobile-menu").setAttribute("aria-expanded", "false");
$(".mobile-menu").setAttribute("aria-label", "Open menu");
render();
renderTeamChrome();
if (storageUnavailable)
  toast(
    "Saved chats could not be read. Copy important answers before reloading.",
  );

// On boot the notice tops home's welcome, the page every signed-out route shows; later it floats
// over whatever view is open.
function showSessionNotice(expired, floating = false) {
  if ($(".session-notice")) return;
  const notice = document.createElement("div");
  notice.className = floating ? "session-notice floating" : "session-notice";
  notice.setAttribute("role", "alert");
  notice.textContent = expired
    ? "Your sign-in has expired. "
    : "Arosa could not connect. ";
  const a = document.createElement("a");
  a.href = "/";
  a.textContent = expired ? "Sign in again" : "Try again";
  notice.append(a);
  if (expired) {
    notice.append(document.createTextNode(" or "));
    const out = document.createElement("a");
    out.className = "sign-out";
    out.href = SIGN_OUT_URL;
    out.textContent = "sign out to switch accounts";
    notice.append(out, document.createTextNode("."));
  }
  if (floating) document.body.append(notice);
  else $("#welcome").prepend(notice);
}
if (!session) showSessionNotice(Boolean(sessionResponse));
// A sign-in that expires while the page is open shows the same notice.
addEventListener(SIGN_IN_EXPIRED, () => showSessionNotice(true, true));

if (session) {
  // Who-am-I only enriches the account card; it must not hold up first paint
  // or the rest of boot. The card shows its loading state until it lands.
  void (async () => {
    try {
      const identity = await postChat("/people/me", {});
      me = { account: identity.account || session.namespace, email: identity.email || session.email || null, name: identity.name || null };
    } catch { /* Who-am-I is additive; the session still works without it. */ }
    accountPending = false;
    renderAccount();
  })();
  void loadTeamsCache();
  void refreshHistory().catch((e) => toast(e.message));
  let openedShared = false;
  if (route.view === "shared") {
    const token = route.token;
    history.replaceState(null, "", "/" + window.location.hash);
    route = parseRoute(window.location.pathname);
    setBodyMode();
    try {
      const claim = await chatRequest("/shared/" + encodeURIComponent(token));
      if (claim.conversationId) {
        await openConversation(claim.conversationId);
        openedShared = true;
        showLinkedConversation(claim.conversationId);
        await refreshHistory().catch(() => {});
      }
    } catch (e) { toast(e.message); }
  }
  const deepLink = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const deepThread = deepLink.get("thread"), deepConcept = deepLink.get("concept");
  const initialId = deepThread || state.id;
  if (!openedShared && initialId && route.view === "home") {
    const token = generation + 1;
    const restore = openConversation(initialId).catch((e) => {
      if (e.status === 404 || e.status === 403) handleAccessRemoved(initialId);
      else if (token === generation) {
        state = {
          id: null,
          messages: [],
          property: null,
          draft: state.draft || "",
          runs: [],
          access: null,
          members: [],
          owner: null,
        };
        render();
        toast(e.message);
      }
    });
    // Listings home docks the chat beside the page, so it opens without waiting for the last
    // conversation; the dock fills in when it arrives.
    if (!listingsMode() || deepConcept) await restore;
    // A linked conversation opens in the drawer at any width; so does the last one on home without listings.
    if (deepThread) void restore.then(() => showLinkedConversation(deepThread));
    else showRestoredConversation();
  }
  if (deepConcept && state.id) {
    const index = state.messages.findIndex((m) => (m.concepts || []).some((c) => c.id === deepConcept));
    if (index >= 0) showConcept(index, deepConcept);
  }
}
const railTooltip=document.createElement('div');railTooltip.id='rail-tooltip';railTooltip.className='rail-tooltip';railTooltip.setAttribute('role','tooltip');railTooltip.hidden=true;document.body.append(railTooltip);
let tooltipTarget=null;
function hideRailTooltip(){if(tooltipTarget){const ids=(tooltipTarget.getAttribute('aria-describedby')||'').split(' ').filter(id=>id&&id!=='rail-tooltip');if(ids.length)tooltipTarget.setAttribute('aria-describedby',ids.join(' '));else tooltipTarget.removeAttribute('aria-describedby');}tooltipTarget=null;railTooltip.hidden=true;}
function showRailTooltip(event){const item=event.target.closest('button,a,summary');if(!item||item.closest('.account-actions')||!document.body.classList.contains('sidebar-collapsed')||innerWidth<=850)return;const text=item.title||item.getAttribute('aria-label');if(!text)return;hideRailTooltip();tooltipTarget=item;railTooltip.textContent=text;const box=item.getBoundingClientRect();railTooltip.style.left=$('#navigation').getBoundingClientRect().right+8+'px';railTooltip.style.top=Math.max(8,Math.min(innerHeight-44,box.top))+'px';railTooltip.hidden=false;item.setAttribute('aria-describedby',((item.getAttribute('aria-describedby')||'')+' rail-tooltip').trim());}
$('#navigation').addEventListener('mouseover',showRailTooltip);$('#navigation').addEventListener('focusin',showRailTooltip);$('#navigation').addEventListener('mouseleave',hideRailTooltip);$('#navigation').addEventListener('mouseout',e=>{if(tooltipTarget&&!tooltipTarget.contains(e.relatedTarget)&&document.activeElement!==tooltipTarget)hideRailTooltip();});$('#navigation').addEventListener('focusout',hideRailTooltip);window.addEventListener('resize',hideRailTooltip);
$('.rail-all-conversations').title='History';
const pageObserver = new MutationObserver(syncPageNavigation);
for (const page of [$('#core-page'),$('#report-page'),$('#home-listings')]) pageObserver.observe(page,{childList:true,subtree:true});
const accountMenu=$('.account-menu'), accountTrigger=accountMenu.querySelector('summary'), accountActions=$('.account-actions');
$('#account-appearance').remove();
accountActions.id='account-actions';accountActions.setAttribute('role','menu');accountActions.setAttribute('aria-label','Account');
accountTrigger.setAttribute('aria-haspopup','menu');accountTrigger.setAttribute('aria-controls','account-actions');accountTrigger.setAttribute('aria-expanded','false');
for (const item of [$('#wallet-button'),$('#theme'),document.querySelector('.app-nav a[href="/whats-new"]'),$('#beta-feedback-button'),$('#admin-button'),$('#sign-out')]) {
  item.setAttribute('role','menuitem');item.tabIndex=-1;accountActions.append(item);
}
$('#sign-out .sr-only').className='';
$('#beta-feedback-button').hidden=$('#beta-bar').hidden;
window.addEventListener('acres:plan',e=>{$('#beta-feedback-button').hidden=!e.detail?.beta;});
const accountItems=()=>[...accountActions.querySelectorAll('[role=menuitem]')].filter(item=>!item.hidden);
accountMenu.addEventListener('toggle',()=>{accountTrigger.setAttribute('aria-expanded',String(accountMenu.open));if(accountMenu.open)accountItems()[0]?.focus();});
accountTrigger.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();accountMenu.open=true;const items=accountItems();(e.key==='ArrowUp'?items.at(-1):items[0])?.focus();}});
accountActions.addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const items=accountItems(),at=items.indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?items.length-1:(at+(e.key==='ArrowDown'?1:items.length-1))%items.length;items[next]?.focus();});
accountActions.addEventListener('click',e=>{if(e.target.closest('[role=menuitem]'))accountMenu.open=false;});
accountMenu.addEventListener('focusout',e=>{if(e.relatedTarget&&!accountMenu.contains(e.relatedTarget))accountMenu.open=false;});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.isComposing) return;
  for (const menu of document.querySelectorAll('.account-menu[open], .page-more[open]')) { menu.open=false; menu.querySelector('summary').focus(); }
});
document.addEventListener('click', e => { for (const menu of document.querySelectorAll('.account-menu[open], .page-more[open]')) if (!menu.contains(e.target)) menu.open=false; });
function renderSiteReceipt(detail) {
  if (detail.id !== route.projectId || !detail.sections.length) return;
  let receipt = $('#site-update-receipt');
  if (!receipt) { receipt=document.createElement('div');receipt.id='site-update-receipt';receipt.className='site-update-receipt';receipt.setAttribute('role','status');$('#conversation').append(receipt); }
  receipt.replaceChildren('Updated on this page: ');
  for (const section of detail.sections) chatUpdatedSections.add(section.id);
  syncPageNavigation();
  const show=document.createElement('button');show.type='button';show.textContent='Show on page';show.addEventListener('click',()=>{const first=detail.sections[0];navigate(sitePath(detail.id)+'#'+first.id);setChatDock(false,{focus:false});const heading=document.querySelector('#'+first.id+' h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}});receipt.append(show);
  for (const section of detail.sections) { const link=document.createElement('a');link.href=sitePath(detail.id)+'#'+section.id;link.textContent=section.label;link.addEventListener('click',event=>{event.preventDefault();navigate(sitePath(detail.id)+'#'+section.id);setChatDock(false);});receipt.append(link); }
}
document.addEventListener('acres-site-updated', e => {
  const detail=e.detail;if(detail.id!==route.projectId)return;
  contextSiteId=null;contextSite=null;contextVersion=null;
  if(!$('.context-panel').hidden)void readContextSite(detail.id).catch(error=>toast(error.message));
  const sections=[...new Map([...(pendingSiteReceipt?.sections||[]),...detail.sections].map(section=>[section.id,section])).values()];
  if(busy)pendingSiteReceipt={id:detail.id,sections};else renderSiteReceipt({id:detail.id,sections});
});
window.addEventListener("popstate", () => {
  onChatDockPopstate();
  if (session && routePath(parseRoute(window.location.pathname)) !== routePath(route)) applyRoute();
  else if (route.view === "plan") core.syncPlanView();
});
void core.listingsAvailable.then((ok) => {
  settleDealsOnHome(ok);
  if (listingsMode() && route.listingId) listings.inspect(route.listingId);
});
$(".core-chat-close").addEventListener("click", () => {
  setChatDock(false);
  focusAskHandle();
});
// A first visit has no remembered answer: hold the loading view briefly rather than paint home
// without listings and rebuild it into listings a moment later.
if (session && route.view === "home" && !dealsOnHomeKnown) {
  const early = await Promise.race([core.listingsAvailable, new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (early === true) settleDealsOnHome(true);
}
setBodyMode();
if (session) {
  home.render();
  if (route.view === "home") home.showSites();
}
if (route.view !== "home") applyRoute();
else if (listingsMode() && route.listingId) listings.inspect(route.listingId);
document.body.classList.remove("booting");
document.body.removeAttribute("aria-busy");
$("#workspace-loading").remove();
