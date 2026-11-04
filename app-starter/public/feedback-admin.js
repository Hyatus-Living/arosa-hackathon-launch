// Feedback tab of the admin window: beta testers' feedback conversations, newest first. Each row
// shows who sent it, from which page, its category and summary, and opens the full transcript.
import {skel} from './skeleton.js';

export const CATEGORY_LABELS = {
  bug: 'Bug', confusing: 'Confusing', missing_feature: 'Missing feature', data_issue: 'Data issue', praise: 'Praise', other: 'Other',
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

const CONTEXT_LABELS = {view: 'View', projectId: 'Site', listingId: 'Listing', conversationId: 'Conversation'};
const when = (at) => new Date(at).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

// What a row says before it opens: an unfinished conversation has no summary yet.
export function feedbackHeadline(session) {
  return {
    category: session.status === 'done' ? CATEGORY_LABELS[session.category] || 'Other' : 'In progress',
    summary: session.summary || (session.status === 'done' ? 'No summary.' : 'Not summarized yet.'),
  };
}

function renderSession(session, {request}) {
  const item = el('details', undefined, 'crm-row feedback-row');
  const head = el('summary', undefined, 'crm-row-head');
  const who = el('span', undefined, 'crm-who');
  const headline = feedbackHeadline(session);
  who.append(el('strong', session.email || 'Unknown person'), el('small', [session.page, when(session.created)].filter(Boolean).join(' · ')));
  head.append(who, el('small', `${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`, 'crm-last'),
    el('span', headline.category, `crm-status feedback-category-${session.status === 'done' ? session.category : 'open'}`));
  const body = el('div', undefined, 'crm-body');
  body.append(el('p', headline.summary, 'feedback-summary'));
  const transcript = el('ol', undefined, 'feedback-thread feedback-transcript');
  body.append(transcript);
  let loaded = false;
  item.addEventListener('toggle', async () => {
    if (!item.open || loaded) return;
    loaded = true;
    transcript.replaceChildren(skel('skel-block', {height: '60px'}));
    try {
      const full = await request(`/admin/feedback/${session.id}`);
      const context = Object.entries(full.context || {}).map(([key, value]) => `${CONTEXT_LABELS[key] || key} ${value}`).join(' · ');
      if (context) body.insertBefore(el('small', context, 'feedback-context'), transcript);
      transcript.replaceChildren(...full.messages.map((m) => el('li', m.text, `feedback-message feedback-${m.role}`)));
    } catch (err) {
      loaded = false;
      transcript.replaceChildren(el('li', err.message, 'crm-empty'));
    }
  });
  item.append(head, body);
  return item;
}

export function renderFeedbackSkeleton(content) {
  content.setAttribute('aria-busy', 'true');
  const status = el('span', 'Loading feedback', 'sr-only');
  status.setAttribute('role', 'status');
  const rows = el('div', undefined, 'crm-list');
  for (let i = 0; i < 5; i++) rows.append(skel('skel-block', {height: '54px'}));
  content.replaceChildren(status, rows);
}

export function renderFeedback(content, data, {request}) {
  content.removeAttribute('aria-busy');
  const list = el('div', undefined, 'crm-list');
  list.append(...(data.sessions.length ? data.sessions.map((session) => renderSession(session, {request}))
    : [el('p', 'No feedback yet. Beta testers send it from the bar at the top of the app.', 'crm-empty')]));
  content.replaceChildren(list);
}
