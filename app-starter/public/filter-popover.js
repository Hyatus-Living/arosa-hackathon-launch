// Keep a filter's top-layer panel inside the viewport, including short or zoomed windows.
export function filterPopoverPosition(anchor, panel, viewport) {
  const edge = 12;
  return {
    left: Math.max(edge, Math.min(anchor.left, viewport.width - panel.width - edge)),
    top: Math.max(edge, Math.min(anchor.bottom + 8, viewport.height - panel.height - edge)),
  };
}

export function bindFilterPopover(details, panel) {
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "group");
  const summary = details.querySelector("summary");
  panel.setAttribute("aria-label", summary.textContent + " filters");
  function position() {
    if (!details.open || !panel.matches(":popover-open")) return;
    const point = filterPopoverPosition(summary.getBoundingClientRect(), panel.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    panel.style.left = point.left + "px";
    panel.style.top = point.top + "px";
  }
  details.addEventListener("toggle", () => {
    if (details.open) {
      panel.showPopover();
      position();
    } else if (panel.matches(":popover-open")) panel.hidePopover();
  });
  panel.addEventListener("toggle", (event) => {
    if (event.newState === "closed") details.open = false;
  });
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  // Saving and validation notices can change panel height without a viewport resize.
  new window.MutationObserver(position).observe(panel, {childList: true, characterData: true, subtree: true});
}
