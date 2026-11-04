// Pending jobs: the user's research on sites still queued or running, kept in the rail wherever they
// go, and a quiet notice when one ends. It polls every few seconds while jobs run, now and then
// otherwise, and at once when the app starts a run.
import { displayAddress } from "./core-model.js";

const ACTIVE_MS = 8000;
const IDLE_MS = 60000;
// An ended job stays in the rail, as a link to its result, until it is opened or this long passes.
// The server lists jobs that ended in the last half hour, so one that finished while the person was
// away still shows; opening it dismisses it on this browser.
const ENDED_MS = 30 * 60000;
const DISMISSED_KEY = "acres:dismissed-jobs";
function readDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]")); } catch { return new Set(); }
}
function dismiss(id) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...readDismissed(), id].slice(-50))); } catch { /* the in-memory list still drops it */ }
}
const WATCH_MS = 2 * 60000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export const jobTitle = (job) => displayAddress(String(job.title || "").replace(/^underwrite\s+/i, "").split(/ \(| in [A-Z0-9]/)[0].trim()) || (job.bbl ? `BBL ${job.bbl}` : "Untitled site");

export function elapsed(since, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return "under a minute";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// "Step 2 of 4 · 3 min" while it runs, or "Step 2 of 4 · about 4 min left" once recent runs of the
// same request say how long it usually takes; a run on a site whose steps are all done is a
// question about it.
export function jobLine(job, now = Date.now()) {
  if (job.outcome) return job.outcome === "completed" ? "Finished · Open" : "Did not finish · Open";
  // A queued job waits for the person's earlier request on the site or for a free research slot.
  const waiting = job.waitingFor === "run" ? "After your earlier request" : job.queueAhead ? `Waiting for a slot, ${job.queueAhead} ahead` : "Waiting for a slot";
  const step = job.status === "queued" ? waiting : job.workflow === 'modeling' ? 'Modeling' : job.step ? `Step ${job.step} of 4` : "Researching";
  const left = job.status === "running" && job.startedAt && job.typicalMs ? job.typicalMs - (now - job.startedAt) : null;
  if (left !== null && left > -120000) return `${step} · ${left > 60000 ? `about ${Math.round(left / 60000)} min left` : "finishing up"}`;
  return `${step} · ${elapsed(job.created, now)}`;
}

export function createJobs({ root, load, status, open, notify = () => {}, onChange = () => {} }) {
  const list = root.querySelector(".rail-jobs-list");
  let jobs = [],
    ended = [],
    timer = null,
    loading = null,
    stopped = false,
    watchUntil = 0;

  function render() {
    const now = Date.now();
    ended = ended.filter((job) => now - job.endedAt < ENDED_MS);
    root.hidden = !jobs.length && !ended.length;
    list.replaceChildren(...[...jobs, ...ended].map((job) => {
      const row = el("button", `nav-item rail-job${job.outcome ? ` is-${job.outcome === "completed" ? "done" : "failed"}` : " is-running"}`);
      row.type = "button";
      row.title = `${jobTitle(job)}: ${jobLine(job, now)}`;
      const icon = el("span", "rail-job-mark");
      icon.setAttribute("aria-hidden", "true");
      const text = el("span", "rail-label rail-job-text");
      text.append(el("strong", "", jobTitle(job)), el("small", "", jobLine(job, now)));
      row.append(icon, text);
      row.addEventListener("click", () => {
        if (job.outcome) dismiss(job.id);
        ended = ended.filter((e) => e.id !== job.id);
        render();
        open(job);
      });
      return row;
    }));
  }

  async function settle(job) {
    const run = await status(job.id);
    const outcome = run.status === "completed" ? "completed" : "failed";
    ended = [{ ...job, outcome, endedAt: Date.now() }, ...ended.filter((e) => e.id !== job.id)];
    notify(outcome === "completed" ? `Research finished for ${jobTitle(job)}.` : `Research did not finish for ${jobTitle(job)}.`, job);
  }

  async function refresh() {
    if (loading) return loading;
    clearTimeout(timer);
    loading = (async () => {
      const listed = await load();
      const next = listed.filter((job) => job.status === "queued" || job.status === "running");
      const dismissed = readDismissed();
      const finished = listed
        .filter((job) => job.status !== "queued" && job.status !== "running" && !dismissed.has(job.id))
        .map((job) => ({ ...job, outcome: job.status === "completed" ? "completed" : "failed", endedAt: job.endedAt || Date.now() }));
      const gone = jobs.filter((job) => !next.some((n) => n.id === job.id));
      // A job that started, ended or moved to another step changes what listings and sites show.
      const changed = gone.length || next.some((n) => jobs.find((job) => job.id === n.id)?.step !== n.step || !jobs.some((job) => job.id === n.id));
      jobs = next;
      // A job seen running here that the server lists as ended says so at once; one that ended
      // while the page was closed simply appears as ended.
      for (const job of gone) {
        const done = finished.find((f) => f.id === job.id);
        if (done) notify(done.outcome === "completed" ? `Research finished for ${jobTitle(done)}.` : `Research did not finish for ${jobTitle(done)}.`, done);
      }
      await Promise.all(gone.filter((job) => !finished.some((f) => f.id === job.id)).map(settle));
      ended = [...finished, ...ended.filter((e) => !finished.some((f) => f.id === e.id) && !dismissed.has(e.id))];
      render();
      if (changed) onChange();
    })().finally(() => {
      loading = null;
      const busy = jobs.length || Date.now() < watchUntil;
      if (!stopped) timer = setTimeout(() => void refresh().catch(() => {}), busy ? ACTIVE_MS : IDLE_MS);
    });
    return loading;
  }

  return {
    refresh,
    // The app started a run: watch closely for a while, since a new site's job appears once it exists.
    started() {
      watchUntil = Date.now() + WATCH_MS;
      return refresh();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    // The running job for a site, so its page follows that run.
    forProject: (projectId) => jobs.find((job) => job.projectId === projectId) || null,
  };
}
