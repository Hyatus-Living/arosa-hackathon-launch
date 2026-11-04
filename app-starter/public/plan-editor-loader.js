// The floor plan page: its entry shows on a site page when the session enables architecture,
// and the editor bundle and stylesheet load only when the plan page is shown.
import { parseRoute } from "./core-route.js";

export function planEntryState(session, pathname) {
  const route = parseRoute(pathname);
  // The rail keeps the floor plan item on the plan page itself, where it marks the current page.
  const visible = session?.architectureEnabled === true && route.view === "plan";
  return { visible, projectId: visible ? route.projectId : null };
}

// A failed load is not kept, so Retry on the plan page loads the bundle again.
let ready;
export async function mountPlanEditor(container, props) {
  ready ??= Promise.all([
    import("/genui/plan-editor.js"),
    new Promise((resolve) => {
      if (document.querySelector("link[data-plan-editor-css]")) return resolve();
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/genui/plan-editor.css", onload: resolve, onerror: resolve });
      link.dataset.planEditorCss = "";
      document.head.append(link);
    }),
  ]).catch((error) => {
    ready = undefined;
    throw error;
  });
  await ready;
  if (!container.isConnected) return;
  // The editor replaces the loading placeholder.
  container.replaceChildren();
  window.acresPlanEditor.mount(container, props);
}
