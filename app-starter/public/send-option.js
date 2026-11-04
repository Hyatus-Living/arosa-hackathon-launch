// "Send to an architect or GC" on an option card: makes a link to a copy of the option as it stands
// (POST /api/projects/:id/schemes/:schemeId/send), which opens at /api/public/options/:token, then offers
// a note to copy or to open in the user's own mail app. Arosa sends no email itself. withdrawLinks stops
// every link to the option (DELETE on the same path).
import { postChat, deleteChat } from "./chat-api.js";
import { linkOrigin } from "./core-route.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// "the floor plan, drawing set, building model, rendering and budget", from what the option had drawn when it was sent.
function contents(option) {
  const files = option.plan?.files ?? {};
  const parts = [option.plan && "floor plan", files["drawings-pdf"] && "drawing set", files.ifc && "building model", option.renders.length && "rendering", option.scheme.budget && "budget"].filter(Boolean);
  if (!parts.length) return "The figures are";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `The ${list} ${parts.length === 1 ? "is" : "are"}`;
}

export function sendNote(option, url) {
  const summary = option.scheme.summary.charAt(0).toLowerCase() + option.scheme.summary.slice(1);
  return `Here is the option we are considering for ${option.site.address}: ${summary}. ${contents(option)} at ${url}`;
}

export function mailtoHref(option, note) {
  const subject = `${option.scheme.label} option for ${option.site.address}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(note)}`;
}

async function copy(text, status, done) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = done;
  } catch {
    status.textContent = "Copy did not work here. Select the text and copy it.";
  }
}

// Opens the sheet and makes the link. onSent(link) runs once the link exists.
export function openSendOption({ projectId, scheme, onSent = () => {} }) {
  const dialog = el("dialog", "send-option");
  dialog.setAttribute("aria-labelledby", "send-option-title");
  const head = el("div", "dialog-header");
  const title = el("h2", "", "Send to an architect or GC");
  title.id = "send-option-title";
  const close = el("button", "icon-button");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = '<svg aria-hidden="true"><use href="#close" /></svg>';
  close.addEventListener("click", () => dialog.close());
  head.append(title, close);
  const body = el("div", "send-option-body");
  const status = el("p", "send-option-status", "Making the link…");
  status.setAttribute("role", "status");
  body.append(status);
  dialog.append(head, body);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();

  postChat(`/projects/${encodeURIComponent(projectId)}/schemes/${encodeURIComponent(scheme.id)}/send`, {})
    .then((link) => {
      const url = `${linkOrigin()}${link.path}`;
      const lede = el("p", "send-option-lede");
      lede.append(el("strong", "", `${scheme.label}.`), " Anyone with this link can see this option, its drawings and its budget at your costs. Nothing else about the site is shared.");

      const linkLabel = el("label", "send-option-label", "Link");
      linkLabel.htmlFor = "send-option-link";
      const linkRow = el("div", "send-option-link");
      const linkInput = el("input");
      linkInput.id = "send-option-link";
      linkInput.readOnly = true;
      linkInput.value = url;
      linkInput.addEventListener("focus", () => linkInput.select());
      const copyLink = el("button", "send-option-quiet", "Copy link");
      copyLink.type = "button";
      linkRow.append(linkInput, copyLink);

      const noteLabel = el("label", "send-option-label", "Note");
      noteLabel.htmlFor = "send-option-note";
      const note = el("textarea");
      note.id = "send-option-note";
      note.rows = 5;
      note.value = sendNote(link.option, url);

      const actions = el("div", "send-option-actions");
      const mail = el("a", "send-option-primary", "Open in email");
      mail.href = mailtoHref(link.option, note.value);
      const copyNote = el("button", "send-option-quiet", "Copy note");
      copyNote.type = "button";
      actions.append(status, copyNote, mail);
      note.addEventListener("input", () => { mail.href = mailtoHref(link.option, note.value); });
      copyLink.addEventListener("click", () => copy(url, status, "Link copied."));
      copyNote.addEventListener("click", () => copy(note.value, status, "Note copied."));

      status.textContent = "";
      body.replaceChildren(lede, linkLabel, linkRow, noteLabel, note, actions);
      onSent(link);
    })
    .catch((error) => {
      status.textContent = `The link could not be made. ${error.message}`;
      status.classList.add("is-error");
    });
  return dialog;
}

// The card's way to stop the links to an option, after one inline confirmation; onWithdrawn runs once
// they no longer open.
export function withdrawLinks({ projectId, scheme, onWithdrawn }) {
  const box = el("span", "send-option-withdraw");
  const ask = el("button", "send-option-text", "Withdraw");
  ask.type = "button";
  ask.addEventListener("click", () => {
    const question = el("span", "", "Stop every link to this option from opening?");
    const yes = el("button", "send-option-text is-danger", "Withdraw links");
    const no = el("button", "send-option-text", "Keep");
    yes.type = no.type = "button";
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        await deleteChat(`/projects/${encodeURIComponent(projectId)}/schemes/${encodeURIComponent(scheme.id)}/send`);
        onWithdrawn();
      } catch (error) {
        question.textContent = `The links were not withdrawn. ${error.message}`;
        yes.disabled = false;
      }
    });
    no.addEventListener("click", () => { box.replaceChildren(ask); ask.focus(); });
    box.replaceChildren(question, yes, no);
    no.focus();
  });
  box.append(ask);
  return box;
}
