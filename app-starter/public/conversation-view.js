import { sourceInfo } from "./source-view.js";
import { skel } from "./skeleton.js";

const $ = (selector) => document.querySelector(selector);
export const icon = (name) =>
  `<svg aria-hidden="true"><use href="#${name}"/></svg>`;

export function sourceList(sources, messageIndex) {
  const details = document.createElement("details");
  details.className = "answer-sources";
  const summary = document.createElement("summary");
  summary.innerHTML = icon("file");
  summary.append(
    document.createTextNode(
      `${sources.length} source${sources.length === 1 ? "" : "s"}`,
    ),
  );
  const list = document.createElement("div");
  list.className = "source-list";
  for (const source of sources) {
    const info = sourceInfo(source);
    const button = document.createElement("button");
    button.className = "source-card";
    button.dataset.message = messageIndex;
    button.dataset.source = source.id;
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = info.title;
    const domain = document.createElement("small");
    domain.textContent = info.hostname || "Source link unavailable";
    text.append(title, domain);
    button.innerHTML = icon("file");
    button.append(text);
    list.append(button);
  }
  details.append(summary, list);
  // Opened, the list takes the answer's width and scrolls into view above the composer.
  details.addEventListener("toggle", () => {
    if (details.open) list.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  });
  return details;
}

export function initials(name) {
  const parts = String(name || "A teammate").trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join("") || "A").toUpperCase();
}

export function isSharedItem(conversation, meAccount) {
  return Boolean(
    (conversation.access && conversation.access !== "owner") ||
      conversation.memberCount > 0 ||
      (meAccount && conversation.owner?.account && conversation.owner.account !== meAccount),
  );
}

export function upsertConversationItem(conversations = [], item, me = null) {
  if (!item?.id) return conversations;
  const existing = conversations.find((c) => c.id === item.id) || null;
  const firstUserMsg = Array.isArray(item.messages)
    ? item.messages.find((m) => m.role === "user" && m.text)?.text?.slice(0, 100)
    : null;
  const lastUserMsg = Array.isArray(item.messages)
    ? item.messages.filter((m) => m.role === "user" && m.author).at(-1)
    : null;
  const title =
    (item.title && item.title !== "New conversation" ? item.title : null) ||
    firstUserMsg ||
    (existing?.title && existing.title !== "New conversation" ? existing.title : null) ||
    item.title ||
    existing?.title ||
    "New conversation";
  const entry = {
    ...existing,
    ...(item.projectId ? {projectId:item.projectId} : {}),
    ...(item.site ? {site:item.site} : {}),
    ...(item.workflow ? {workflow:item.workflow} : {}),
    id: item.id,
    title,
    created: item.created ?? existing?.created ?? Date.now(),
    updated: item.updated ?? Date.now(),
    access: item.access ?? existing?.access ?? "owner",
    owner:
      item.owner ??
      existing?.owner ??
      (me?.account ? { account: me.account, name: me.name || null } : null),
    memberCount:
      typeof item.memberCount === "number"
        ? item.memberCount
        : Array.isArray(item.members)
          ? Math.max(0, item.members.length - 1)
          : existing?.memberCount ?? 0,
    lastAuthor:
      item.lastAuthor ??
      (lastUserMsg ? { account: lastUserMsg.author, name: lastUserMsg.authorName } : null) ??
      existing?.lastAuthor ??
      null,
  };
  return [entry, ...conversations.filter((c) => c.id !== item.id)];
}

export function sidebarConversationList(
  conversations = [],
  { state = null, pendingSubmission = null, submitPending = false, busy = false, me = null } = {},
) {
  let items = conversations;
  let activeId = state?.id || null;
  if (state?.id) {
    const hasActive = items.some((c) => c.id === state.id);
    const shouldInclude =
      hasActive ||
      busy ||
      submitPending ||
      (state.messages && state.messages.length > 0) ||
      (state.title && state.title !== "New conversation");
    if (shouldInclude && !hasActive) {
      const promptTitle = pendingSubmission?.text?.slice(0, 100) || null;
      items = upsertConversationItem(
        items,
        {
          ...state,
          title:
            state.title && state.title !== "New conversation"
              ? state.title
              : promptTitle || state.title || "New conversation",
          updated: Date.now(),
        },
        me,
      );
    } else if (hasActive && pendingSubmission?.text) {
      const current = items.find((c) => c.id === state.id);
      if (current && (!current.title || current.title === "New conversation")) {
        items = upsertConversationItem(
          items,
          { ...current, title: pendingSubmission.text.slice(0, 100), updated: Date.now() },
          me,
        );
      }
    }
  } else if (submitPending && pendingSubmission?.text) {
    const pendingId = "pending-" + pendingSubmission.id;
    activeId = pendingId;
    items = [
      {
        id: pendingId,
        title: pendingSubmission.text.slice(0, 100) || "New conversation",
        created: Date.now(),
        updated: Date.now(),
        access: "owner",
        owner: me?.account ? { account: me.account, name: me.name || null } : null,
        memberCount: 0,
        lastAuthor: null,
      },
      ...items.filter((c) => c.id !== pendingId),
    ];
  }
  return { items, activeId };
}

export function formatAsOfDate(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return "";
  try {
    return (
      "As of " +
      new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(new Date(timestamp))
    );
  } catch {
    return "";
  }
}

export function decorateAnswerHeader(
  answerEl,
  { completedAt = null, created = null, hasSources = false } = {},
) {
  if (!answerEl || !answerEl.firstElementChild) return;
  const first = answerEl.firstElementChild;
  if (first.tagName !== "H1" && first.tagName !== "H2") return;
  first.classList.add("answer-lead-title");
  const next = first.nextElementSibling;
  if (next?.classList?.contains("answer-dateline")) return;
  const nextText = (next?.textContent || "").trim();
  const isStandaloneAsOf =
    next?.tagName === "P" &&
    nextText.length <= 96 &&
    /^As of\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}(?:\s*[·•––-].*)?\.?$/i.test(nextText);
  if (isStandaloneAsOf) {
    next.classList.add("answer-dateline");
    return;
  }
  const inlineMatch = nextText.match(/^As of\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})\b/i);
  const datelineText = inlineMatch
    ? `As of ${inlineMatch[1]}`
    : hasSources
      ? formatAsOfDate(completedAt || created)
      : "";
  if (datelineText) {
    const dateline = answerEl.ownerDocument.createElement("p");
    dateline.className = "answer-dateline";
    dateline.textContent = datelineText;
    first.insertAdjacentElement("afterend", dateline);
  }
}

export function renderProjectUpdateNotice(container, update) {
  for (const child of [...container.children]) if (child.classList.contains("project-update-notice")) child.remove();
  if (!update || !["partial", "not_applied"].includes(update.status)) return;
  const note = container.ownerDocument.createElement("p");
  note.className = "session-notice project-update-notice";
  note.setAttribute("role", "note");
  note.setAttribute("aria-label", "Site update");
  note.textContent = update.status === "partial"
    ? "Some results could not update the site because it changed while research was running. Your newer work is preserved. Rerun the research to refresh those results."
    : "The site changed while research was running. This answer is saved here; its site updates were not applied. Rerun the research to update the site.";
  const answer = [...container.children].find(child => child.classList.contains("answer"));
  container.insertBefore(note, answer || null);
}

export function createScrollManager() {
  const main = $("#main"),
    latest = $("#jump-latest");
  let following = true;
  function update() {
    following = main.scrollHeight - main.clientHeight - main.scrollTop < 100;
    latest.hidden = following;
  }
  main.addEventListener("scroll", update, { passive: true });
  latest.addEventListener("click", () => {
    main.scrollTo({
      top: main.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    following = true;
    latest.hidden = true;
  });
  return {
    isFollowing: () => following,
    follow() {
      if (following) main.scrollTop = main.scrollHeight;
      update();
    },
    // Opening the chat lands on the latest message, wherever the reader last left the thread.
    jumpToLatest() {
      following = true;
      main.scrollTop = main.scrollHeight;
      latest.hidden = true;
    },
    reset() {
      following = true;
      latest.hidden = true;
    },
    update,
  };
}

export function conceptList(concepts, messageIndex) {
  const section = document.createElement("section");
  section.className = "concept-list";
  section.setAttribute("aria-label", "Development concepts");
  for (const concept of concepts) {
    const card = document.createElement("article");
    card.className = "concept-card";
    const title = document.createElement("strong");
    title.textContent = concept.name;
    const m = concept.metrics;
    const facts = document.createElement("small");
    facts.textContent = [
      ...(concept.revision?.version ? [`v${concept.revision.version}`] : []),
      `${m.storeys} ${m.storeys === 1 ? "storey" : "storeys"}`,
      `${m.grossFloorAreaSqft.toLocaleString()} sq ft`,
      `FAR ${m.far}${m.maxFar ? " of " + m.maxFar : ""}`,
      `${m.heightFeet} ft${m.maxHeightFeet ? " of " + m.maxHeightFeet : ""}`,
    ].join(" · ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "concept-open";
    button.dataset.message = messageIndex;
    button.dataset.concept = concept.id;
    button.textContent = "View model";
    card.append(title, facts);
    if (concept.summary) {
      const summary = document.createElement("p");
      summary.textContent = concept.summary;
      card.append(summary);
    }
    card.append(button);
    section.append(card);
  }
  if (concepts.length > 1) section.append(conceptComparison(concepts));
  return section;
}

// Side by side: one column per concept, the modeled numbers as rows.
export function conceptComparison(concepts) {
  const make = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const table = make("table");
  table.className = "concept-compare";
  table.append(make("caption", "Side by side"));
  const thead = make("thead"), head = make("tr");
  thead.append(head);
  head.append(make("th"));
  for (const concept of concepts) {
    const th = make("th", concept.name);
    th.scope = "col";
    head.append(th);
  }
  table.append(thead);
  const sqft = (n) => (n == null ? "–" : n.toLocaleString() + " sq ft");
  const rows = [
    ["Storeys", (m) => m.storeys],
    ["Gross floor area", (m) => sqft(m.grossFloorAreaSqft)],
    ["FAR", (m) => m.far + (m.maxFar ? " of " + m.maxFar : "")],
    ["Height", (m) => m.heightFeet + " ft" + (m.maxHeightFeet ? " of " + m.maxHeightFeet : "")],
    ["Remaining floor area", (m) => (m.remainingFloorAreaSqft == null ? null : sqft(m.remainingFloorAreaSqft))],
    ["Units", (m) => (m.units == null ? null : m.units + (m.grossSqftPerUnit ? " · " + m.grossSqftPerUnit.toLocaleString() + " sq ft each" : ""))],
  ];
  const body = make("tbody");
  for (const [label, value] of rows) {
    const values = concepts.map((c) => value(c.metrics || {}));
    if (values.every((v) => v == null)) continue;
    const tr = make("tr");
    const th = make("th", label);
    th.scope = "row";
    tr.append(th);
    for (const v of values) tr.append(make("td", v == null ? "–" : String(v)));
    body.append(tr);
  }
  table.append(body);
  return table;
}

export const PARCEL_ABSENT = "Not in the parcel record";
// PLUTO fields the panel can show. A record that came with the conversation carries them; a bare
// address and BBL does not, so the panel never reports a field as missing from a record it lacks.
// Listing records name the same facts in camelCase (zoningDistrict, lotAreaSqft).
const PARCEL_FIELDS = ["zonedist1", "lotarea", "version", "landmark", "spdist1", "overlay1", "histdist", "zoningDistrict", "lotAreaSqft"];
export function parcelRows(p) {
  const text = (v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));
  const join = (keys) => keys.map((k) => text(p[k])).filter(Boolean).join(", ");
  const hasRecord = PARCEL_FIELDS.some((k) => k in p);
  if (!hasRecord) return [];
  const lotValue = text(p.lotarea) || text(p.lotAreaSqft);
  const lot = Number(lotValue);
  return [
    // Zoning and lot area belong to every parcel: a loaded record without them says so.
    ["Zoning", join(["zonedist1", "zonedist2", "zonedist3", "zonedist4"]) || text(p.zoningDistrict) || PARCEL_ABSENT],
    ["Overlay", join(["overlay1", "overlay2"])],
    ["Special district", join(["spdist1", "spdist2", "spdist3"])],
    ["Lot area", lotValue && Number.isFinite(lot) ? `${lot.toLocaleString()} sq ft` : PARCEL_ABSENT],
    ["Landmark", text(p.landmark)],
    ["Historic district", text(p.histdist)],
  ].filter(([, value]) => value);
}

// How long ago a conversation last changed, in a few words.
export function relativeTime(at, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(at);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
}

// The rail's Recent list: the latest conversations on every page. A row on a site carries the site,
// which it opens with the conversation beside it; the others open in the drawer where the reader is.
const RECENT_ROWS = 8;
export function renderRecentRail(root, conversations, activeId, now = Date.now()) {
  const doc = root.ownerDocument;
  const rows = conversations
    .filter((c) => !String(c.id).startsWith("pending-"))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, RECENT_ROWS);
  root.hidden = !rows.length;
  // A redraw keeps keyboard focus on the row it was on, since shared threads refresh the list often.
  const list = root.querySelector(".rail-recent-list"),
    focused = list.contains(doc.activeElement) ? doc.activeElement.closest("[data-recent]")?.dataset.recent : null;
  list.replaceChildren(...rows.map((c) => {
    const title = c.title || "New conversation";
    // A site conversation is usually named for its site; the row then says it is a saved site.
    const siteName = c.site?.title && c.site.title !== title ? c.site.title : null;
    const row = doc.createElement("button");
    row.type = "button";
    row.className = "nav-item rail-recent-item";
    row.dataset.recent = c.id;
    if (c.site) row.dataset.site = c.site.id;
    if (c.site?.workflow === 'modeling') row.dataset.workflow = 'modeling';
    if (c.id === activeId) row.setAttribute("aria-current", "true");
    const mark = doc.createElement("span");
    mark.innerHTML = icon(c.site?.workflow === 'modeling' ? 'file' : c.site ? "pin" : "chat");
    const text = doc.createElement("span");
    text.className = "rail-label rail-recent-text";
    const name = doc.createElement("strong");
    name.textContent = title;
    const meta = doc.createElement("small");
    const time = doc.createElement("time");
    time.setAttribute("datetime", new Date(c.updated).toISOString());
    time.dataset.at = String(c.updated);
    time.textContent = relativeTime(c.updated, now);
    if (c.site) meta.append(`${c.site.workflow === 'modeling' ? 'Modeling' : siteName || "Saved site"} · `);
    meta.append(time);
    text.append(name, meta);
    row.append(mark.firstElementChild, text);
    row.title = siteName ? `${title}, ${siteName}` : title;
    return row;
  }));
  if (focused) [...list.children].find((row) => row.dataset.recent === focused)?.focus({ preventScroll: true });
}
// Rail times move on while the page stays open.
export function refreshRecentTimes(root, now = Date.now()) {
  for (const time of root.querySelectorAll("time[data-at]")) time.textContent = relativeTime(Number(time.dataset.at), now);
}
// The list keeps whole rows. When the rail is short it shows as many full rows as fit, never a cut one,
// down to none, since All conversations below it still reaches every one; it fades its lower edge
// while more rows wait below, so the reader sees that it scrolls.
export function fitRecentRail(root) {
  const list = root.querySelector(".rail-recent-list");
  list.style.maxHeight = "";
  const room = list.clientHeight, row = list.firstElementChild;
  if (row && room && list.scrollHeight > room) {
    const gap = parseFloat(root.ownerDocument.defaultView.getComputedStyle(list).rowGap) || 0;
    const step = row.offsetHeight + gap;
    list.style.maxHeight = `${Math.max(0, Math.floor((room + gap) / step) * step - gap)}px`;
  }
  const more = () => list.classList.toggle("has-more", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  list.onscroll = more;
  more();
}

export const HISTORY_EMPTY = "Your research conversations will appear here.";
// One conversation row in History, with who shared it when it is not the reader's own.
function historyRow(doc, conversation, meAccount) {
  const row = doc.createElement("button");
  row.className = "history-item";
  row.dataset.conversation = conversation.id;
  const title = doc.createElement("span");
  title.className = "history-title";
  title.textContent = conversation.title || "New conversation";
  row.append(title);
  if (isSharedItem(conversation, meAccount)) {
    const meta = doc.createElement("span");
    meta.className = "history-meta";
    const owner = conversation.owner?.name;
    if (owner) {
      const avatar = doc.createElement("span");
      avatar.className = "owner-initials author-avatar small";
      avatar.textContent = initials(owner);
      meta.append(avatar);
    }
    const label = doc.createElement("span");
    label.className = "shared-label";
    label.textContent = "Shared";
    meta.append(label);
    if (owner) {
      const name = doc.createElement("span");
      name.textContent = owner;
      meta.append(name);
    }
    row.append(meta);
  }
  return row;
}
// History's results: rows holding their place while a search runs, the matches, a way to try again
// when the search fails, and a note when a conversation the reader opened is no longer theirs to see.
export function renderHistoryResults(box, view, meAccount) {
  const doc = box.ownerDocument;
  box.replaceChildren();
  if (view.status === "loading") {
    const searching = doc.createElement("div");
    searching.className = "search-skeleton";
    searching.setAttribute("role", "status");
    const hint = doc.createElement("span");
    hint.className = "sr-only";
    hint.textContent = "Searching";
    searching.append(hint, ...["64%", "48%", "56%"].map((width) => skel("skel-text", { width, height: "15px" })));
    box.append(searching);
    return;
  }
  if (view.status === "failed") {
    const failed = doc.createElement("div");
    failed.className = "search-failed";
    failed.setAttribute("role", "alert");
    const text = doc.createElement("p");
    text.textContent = "Your conversations did not load.";
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", view.retry);
    failed.append(text, retry);
    box.append(failed);
    return;
  }
  if (view.removed) {
    const notice = doc.createElement("p");
    notice.className = "search-notice";
    notice.setAttribute("role", "status");
    notice.textContent = "You no longer have access to that conversation.";
    box.append(notice);
  }
  box.append(...view.matches.map((c) => historyRow(doc, c, meAccount)));
  if (!view.matches.length) {
    const empty = doc.createElement("p");
    empty.className = "search-empty";
    empty.textContent = view.query ? "No conversations match your search." : HISTORY_EMPTY;
    box.append(empty);
  }
}
// A letter shortcut matches the key's letter, or on a non-Latin layout, where the key types another
// script, the physical key that letter sits on.
export function shortcutLetter(e, letter) {
  const key = e.key.toLowerCase();
  return key === letter || (/^\p{L}$/u.test(key) && !/[a-z]/.test(key) && e.code === `Key${letter.toUpperCase()}`);
}
// History: conversation search inside the chat, in the thread's place, so a page stays live beside the
// docked chat. Cmd+K or Ctrl+K opens it with the search field focused; Escape steps back to the thread,
// and a second Escape, pressed next, closes the drawer and returns focus to whatever opened History,
// or to `fallbackFocus` when that is out of sight. Every path the reader takes to the thread closes
// History first, while background refreshes leave it open; opening a conversation picked in History
// holds it open until the conversation has loaded. Cmd+K waits while a dialog is open over the page.
export function createHistoryView({ doc = document, load, account, setDock, focusThread, fallbackFocus = () => {}, onOpen = () => {} }) {
  const view = doc.querySelector("#chat-history-view"),
    main = doc.querySelector("#main"),
    input = doc.querySelector("#conversation-search"),
    box = doc.querySelector("#search-results");
  let opener = null,
    returnTo = null,
    removed = false,
    held = 0,
    generation = 0;
  const isOpen = () => !view.hidden;
  function show(open) {
    view.hidden = !open;
    main.hidden = open;
    doc.body.classList.toggle("history-view-open", open);
  }
  async function search() {
    const token = ++generation,
      query = input.value.trim();
    box.setAttribute("aria-busy", "true");
    // While the reader types, the last results stay until the next arrive.
    if (!box.querySelector(".history-item, .search-empty")) renderHistoryResults(box, { status: "loading" });
    try {
      const matches = await load(query);
      if (token !== generation) return;
      renderHistoryResults(box, { status: "ready", query, matches, removed }, account());
      removed = false;
    } catch {
      if (token === generation) renderHistoryResults(box, { status: "failed", retry: () => void search() });
    } finally {
      if (token === generation) box.removeAttribute("aria-busy");
    }
  }
  function open(from = doc.activeElement) {
    // Opening again while History shows keeps the first opener, so Escape still leads back to it.
    if (!isOpen()) opener = from;
    returnTo = null;
    onOpen();
    setDock(true);
    show(true);
    input.focus();
    return search();
  }
  function close() {
    if (held) return;
    returnTo = null;
    if (isOpen()) show(false);
  }
  // Runs `fn` with History kept open, for the steps that open a conversation picked in it.
  function hold(fn) {
    held++;
    try {
      return fn();
    } finally {
      held--;
    }
  }
  // New results when the conversations change while History shows.
  function refresh() {
    if (isOpen()) void search();
  }
  function back() {
    show(false);
    returnTo = opener;
    focusThread();
  }
  // A list redrawn while History was open, as the Recent rail is on every refresh, holds a new
  // element for the same row; it is found by the id or data attributes the opener carried.
  function current(el) {
    if (el.isConnected) return el;
    if (el.id) return doc.getElementById(el.id);
    const data = [...el.attributes].filter((a) => a.name.startsWith("data-"));
    if (!data.length) return null;
    return doc.querySelector(el.localName + data.map((a) => `[${a.name}="${a.value.replace(/["\\]/g, "\\$&")}"]`).join(""));
  }
  function accessRemoved() {
    removed = true;
    return search();
  }
  function onKeydown(e) {
    const dialogOpen = Boolean(doc.querySelector("dialog[open]"));
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && shortcutLetter(e, "k")) {
      if (dialogOpen) return false;
      e.preventDefault();
      if (!e.repeat) void open(doc.activeElement);
      return true;
    }
    if (e.key !== "Escape") {
      // Only an Escape pressed straight after the first one closes the drawer.
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) returnTo = null;
      return false;
    }
    if (e.isComposing) return false;
    if (dialogOpen) return false;
    if (isOpen()) {
      e.preventDefault();
      back();
      return true;
    }
    const active = doc.activeElement;
    if (returnTo && (active === doc.body || view.parentElement.contains(active))) {
      e.preventDefault();
      const target = returnTo;
      returnTo = null;
      setDock(false);
      const now = current(target);
      now?.focus();
      if (!now || doc.activeElement !== now) fallbackFocus();
      return true;
    }
    return false;
  }
  input.addEventListener("input", () => void search());
  doc.addEventListener("pointerdown", () => { returnTo = null; }, true);
  view.querySelector(".history-view-back").addEventListener("click", back);
  return { open, close, hold, refresh, isOpen, search, accessRemoved, onKeydown };
}
