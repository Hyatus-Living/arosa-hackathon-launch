// One scheme's presentation rendering: the building among its neighbours, from the street and from
// above. render is scheme.render ({artifactId, status, url, jobId, reason, views, renderSeconds, at})
// or null when the option has not been drawn. The container names the site and the option in
// data-project-id and data-scheme-id (or pass them in options). While a rendering runs the view
// follows its job and calls onChange(render) with each new state. A failed job's reason is for
// support, not the page; a refused request (no massing yet, say) shows its message.
import { chatRequest, postChat } from "./chat-api.js";
import { skel } from "./skeleton.js";

const POLL_MS = 4000;
const VIEW_LABELS = { street: "Street", aerial: "Aerial" };
const RUNNING = ["queued", "running"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The render part for a job, as the research service builds it (scheme-renders.mjs renderPart).
function partOf(projectId, job) {
  const views = ["street", "aerial"].flatMap(view => {
    const artifact = job.artifacts.find(a => a.kind === `render-${view}`);
    return artifact ? [{ view, artifactId: artifact.id, url: `/api/projects/${projectId}/architecture/artifacts/${artifact.id}` }] : [];
  });
  return {
    artifactId: views[0]?.artifactId ?? null, status: job.status, url: views[0]?.url ?? null, jobId: job.id, reason: job.reason ?? null, views,
    renderSeconds: job.status === "succeeded" && job.startedAt ? Math.round((job.finishedAt - job.startedAt) / 100) / 10 : null,
    at: job.finishedAt ?? job.createdAt,
  };
}

function button(text, primary = false) {
  const b = el("button", `core-follow${primary ? " primary" : ""}`, text);
  b.type = "button";
  return b;
}

export function renderSchemeRender(container, render, options = {}) {
  const projectId = options.projectId ?? container.dataset.projectId;
  const schemeId = options.schemeId ?? container.dataset.schemeId;
  const canRender = options.canRender ?? true;
  clearTimeout(container._renderPoll);
  const show = next => { options.onChange?.(next); renderSchemeRender(container, next, options); };
  const start = async b => {
    b.disabled = true;
    try { show(await postChat(`/projects/${encodeURIComponent(projectId)}/schemes/${encodeURIComponent(schemeId)}/render`, {})); }
    catch (error) { show({ status: "failed", message: error.message, views: [] }); }
  };

  const root = el("section", "scheme-render");
  root.setAttribute("aria-label", "Rendering");
  if (!render) {
    const empty = el("div", "scheme-render-empty");
    empty.append(el("p", "scheme-render-note", "Not drawn yet."));
    if (canRender) {
      const b = button("Render this option");
      b.addEventListener("click", () => start(b));
      empty.append(b);
    }
    root.append(empty);
  } else if (RUNNING.includes(render.status)) {
    const frame = el("div", "scheme-render-frame");
    frame.append(skel("scheme-render-skel"));
    const status = el("p", "scheme-render-note", render.status === "queued" ? "Waiting to render, about two minutes once it starts." : "Rendering, about two minutes.");
    status.setAttribute("role", "status");
    root.append(frame, status);
    if (render.jobId) {
      container._renderPoll = setTimeout(async () => {
        if (!container.isConnected) return;
        try {
          const job = await chatRequest(`/projects/${encodeURIComponent(projectId)}/architecture/jobs/${encodeURIComponent(render.jobId)}`);
          if (job.status !== render.status) show(partOf(projectId, job));
          else renderSchemeRender(container, render, options);
        } catch { renderSchemeRender(container, render, options); }
      }, POLL_MS);
    }
  } else if (render.status === "succeeded" && render.views?.length) {
    let current = render.views[0];
    const figure = el("figure", "scheme-render-figure");
    const img = el("img", "scheme-render-image");
    img.width = 1280;
    img.height = 800;
    img.loading = "lazy";
    img.decoding = "async";
    const tabs = el("div", "scheme-render-views");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "View");
    const select = view => {
      current = view;
      img.src = view.url;
      img.alt = `${VIEW_LABELS[view.view]} view of this option among its neighbours`;
      for (const tab of tabs.children) tab.setAttribute("aria-pressed", String(tab.dataset.view === view.view));
    };
    for (const view of render.views) {
      const tab = el("button", "scheme-render-view", VIEW_LABELS[view.view]);
      tab.type = "button";
      tab.dataset.view = view.view;
      tab.addEventListener("click", () => select(view));
      tabs.append(tab);
    }
    select(current);
    const caption = el("figcaption", "scheme-render-note", "Simplified materials in afternoon sun. Neighboring buildings are shown in gray.");
    figure.append(img, caption);
    root.append(tabs, figure);
  } else {
    const fail = el("div", "core-fail");
    fail.append(el("span", "core-fail-text", render.message || "The rendering did not finish."));
    if (canRender) {
      const b = button("Try again");
      b.addEventListener("click", () => start(b));
      fail.append(b);
    }
    root.append(fail);
  }
  container.replaceChildren(root);
}
