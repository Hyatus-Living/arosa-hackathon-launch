// Beta testers see a slim bar in the top bar with one action, Give feedback. It opens a small
// panel where they type anything; Arosa asks a few follow-up questions, then thanks them. The page
// they were on and the open site, listing or conversation travel with the first message.
const bar = document.querySelector('#beta-bar');
const openButton = document.querySelector('#beta-feedback-button');
const dialog = document.querySelector('#feedback-dialog');
const thread = document.querySelector('#feedback-thread');
const form = document.querySelector('#feedback-form');
const field = document.querySelector('#feedback-text');
const send = document.querySelector('#feedback-send');
const finish = document.querySelector('#feedback-finish');
const notice = document.querySelector('#feedback-notice');

let conversationId = () => null;
let session = null, pending = false;

// The app passes the open conversation; everything else comes from the address.
export function setFeedbackContext(getConversationId) {conversationId = getConversationId;}

export function feedbackContext(pathname, openConversation = null) {
  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const context = {view: parts[0] || 'home'};
  if ((parts[0] === 'sites' || parts[0] === 'core') && parts[1]) context.projectId = parts[1];
  if (parts[0] === 'listings' && parts[1]) context.listingId = parts[1];
  if (openConversation) context.conversationId = openConversation;
  return context;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function post(path, body) {
  const response = await fetch('/api' + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(120000)});
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(data.error || 'Your feedback could not be sent. Try again.');
  return data;
}

function paint(extraUserText = null) {
  const messages = [...(session?.messages || []), ...(extraUserText ? [{role: 'user', text: extraUserText}] : [])];
  const items = messages.map((m) => el('li', m.text, `feedback-message feedback-${m.role}`));
  if (!items.length) items.push(el('li', 'Tell us anything: what broke, what confused you, or what you wish Arosa did.', 'feedback-intro'));
  if (pending) {
    const working = el('li', undefined, 'feedback-message feedback-agent feedback-working');
    working.setAttribute('aria-label', 'Arosa is replying');
    working.append(el('span'), el('span'), el('span'));
    items.push(working);
  }
  thread.replaceChildren(...items);
  const done = session?.status === 'done';
  form.hidden = done;
  if (done) thread.append(el('li', 'Sent to the Arosa team. Thank you.', 'feedback-intro'));
  send.disabled = pending;
  finish.hidden = done || !session?.messages.some((m) => m.role === 'agent');
  finish.disabled = pending;
  thread.scrollTop = thread.scrollHeight;
}

async function submit(path, body, typed = null) {
  pending = true;
  notice.textContent = '';
  paint(typed);
  try {
    session = await post(path, body);
    if (typed) field.value = '';
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    pending = false;
    paint();
    if (!form.hidden) field.focus();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = field.value.trim();
  if (!text || pending) return;
  if (!session) void submit('/feedback', {text, page: window.location.pathname, context: feedbackContext(window.location.pathname, conversationId())}, text);
  else void submit(`/feedback/${session.id}/messages`, {text}, text);
});
field.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {event.preventDefault(); form.requestSubmit();}
});
finish.addEventListener('click', () => {if (session && !pending) void submit(`/feedback/${session.id}/finish`, {});});
openButton.addEventListener('click', () => {
  notice.textContent = '';
  paint();
  dialog.showModal();
  field.focus();
});
document.querySelector('#close-feedback').addEventListener('click', () => dialog.close());
// A finished conversation stays readable until the panel closes; the next open starts fresh.
dialog.addEventListener('close', () => {if (session?.status === 'done') session = null;});
window.addEventListener('acres:plan', (event) => {bar.hidden = !event.detail?.beta;});
