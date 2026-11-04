// What's new (/whats-new): shipped changes, newest first, from the checked-in entry list.
// Signed-in only: without a session resolveRoute lays every address out as home, so this
// page never renders for a signed-out visitor.
import { WHATS_NEW } from "./whats-new-data.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const fmtDate = (iso) => {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};

export function renderWhatsNew(entries = WHATS_NEW) {
  const root = el("article", "whats-new");
  root.append(el("h1", "whats-new-title", "What's new"));
  root.append(el("p", "whats-new-note", "Changes that have shipped, newest first."));
  const list = el("ol", "whats-new-list");
  list.setAttribute("aria-label", "Shipped changes");
  for (const entry of entries) {
    const item = el("li", "whats-new-entry");
    const time = el("time", "whats-new-date", fmtDate(entry.date));
    time.dateTime = entry.date;
    item.append(time, el("p", "whats-new-entry-title", entry.title));
    list.append(item);
  }
  root.append(list);
  return root;
}

export function createWhatsNewPage({ root }) {
  return {
    show() {
      root.hidden = false;
      root.replaceChildren(renderWhatsNew());
      root.scrollTop = 0;
      document.title = "What's new · Arosa";
    },
    leave() {
      root.hidden = true;
    },
  };
}
