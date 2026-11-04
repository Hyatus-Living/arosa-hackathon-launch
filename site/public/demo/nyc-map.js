// A light stand-in for the app's listings map: the five boroughs drawn from the app's own outlines and
// projection, one pin per listing in the app's tier colors, drag to pan and buttons to zoom. It keeps the
// interface the Explore view expects from createListingsMap, so the view itself runs unchanged.
import { projectNyc, MAP_FRAME } from "/app/deal-map.js";
import { NYC_EXTENT } from "/app/core-model.js";
import { NYC_BOROUGHS } from "/app/nyc-boroughs.js";

const SVG = "http://www.w3.org/2000/svg";
const PALETTE = {
  dark: { great: "#4cc27a", goodFill: "#2b5a3d", good: "#4cc27a", fair: "#adadad", hollow: "#1c1c1c", full: "#999999", unpriced: "#6aa2e6", halo: "#121212", ink: "#f3f3f3" },
  light: { great: "#1d7a45", goodFill: "#cfe9d9", good: "#1d7a45", fair: "#6b6b6b", hollow: "#ffffff", full: "#6b6b6b", unpriced: "#2d63a6", halo: "#ffffff", ink: "#1b1b1b" },
};
const a = projectNyc(NYC_EXTENT.north, NYC_EXTENT.west), b = projectNyc(NYC_EXTENT.south, NYC_EXTENT.east);
const toLatLon = (x, y) => ({
  lat: NYC_EXTENT.north + ((y - a.y) / (b.y - a.y)) * (NYC_EXTENT.south - NYC_EXTENT.north),
  lon: NYC_EXTENT.west + ((x - a.x) / (b.x - a.x)) * (NYC_EXTENT.east - NYC_EXTENT.west),
});
const node = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

export async function createNycMap(container, { onPick, onHover, onMove, describe }) {
  const svg = node("svg", { class: "nyc-map", role: "img", "aria-label": "Map of New York City with the listings" });
  const land = node("g", { class: "nyc-map-land" });
  for (const borough of NYC_BOROUGHS) {
    const d = borough.rings.map((ring) => "M" + ring.map(([lon, lat]) => { const p = projectNyc(lat, lon); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join("L") + "Z").join("");
    land.append(node("path", { d }));
  }
  const layer = node("g", { class: "nyc-map-pins" });
  svg.append(land, layer);
  const tip = document.createElement("div");
  tip.className = "nyc-map-tip";
  tip.hidden = true;
  const zoom = document.createElement("div");
  zoom.className = "nyc-map-zoom";
  zoom.innerHTML = '<button type="button" aria-label="Zoom in">+</button><button type="button" aria-label="Zoom out">−</button>';
  container.append(svg, tip, zoom);

  // moved: the visitor has panned or zoomed, so a resize keeps their view instead of refitting the pins.
  let pins = [], active = null, selected = null, moved = false;
  let view = { x: 0, y: 0, w: MAP_FRAME.width, h: MAP_FRAME.height };
  const theme = () => PALETTE[document.documentElement.classList.contains("dark") ? "dark" : "light"];
  const pxToUnits = () => view.w / Math.max(1, container.clientWidth);

  // The view keeps the container's shape around a center, never wider than the whole city.
  function frame(cx, cy, w) {
    const aspect = container.clientHeight / Math.max(1, container.clientWidth) || MAP_FRAME.height / MAP_FRAME.width;
    const width = Math.min(Math.max(w, 18), MAP_FRAME.width * 1.4);
    view = { x: cx - width / 2, y: cy - (width * aspect) / 2, w: width, h: width * aspect };
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    draw();
  }
  function draw() {
    const c = theme(), u = pxToUnits();
    layer.replaceChildren();
    const order = [...pins].sort((p, q) => (p.id === selected) - (q.id === selected) || (p.id === active) - (q.id === active));
    for (const p of order) {
      const at = projectNyc(p.latitude, p.longitude);
      const tier = (p.dealVerdict || "").split("_")[0];
      const big = p.id === selected || p.id === active;
      const r = (big ? 8 : 6) * u;
      const style = {
        great: { fill: c.great, stroke: c.halo, sw: 1.5 },
        good: { fill: c.goodFill, stroke: c.good, sw: 2 },
        fair: { fill: c.fair, stroke: c.halo, sw: 1.5 },
        full: { fill: c.hollow, stroke: c.full, sw: 2 },
        unpriced: { fill: c.unpriced, stroke: c.halo, sw: 1.5 },
      }[tier] || { fill: c.fair, stroke: c.halo, sw: 1.5 };
      const g = node("g", { class: "nyc-map-pin", tabindex: "-1", "data-id": p.id });
      // Paint goes in style: the app's stylesheets outline bare circles.
      const dot = (radius, fill, stroke, width) => node("circle", { cx: at.x, cy: at.y, r: radius, style: `fill:${fill};stroke:${stroke};stroke-width:${width}` });
      if (p.id === selected) g.append(dot(r + 3.5 * u, "none", c.ink, 2 * u));
      g.append(dot(r, style.fill, style.stroke, style.sw * u));
      g.append(dot(14 * u, "transparent", "none", 0));
      g.addEventListener("pointerenter", () => { onHover(p.id); setActive(p.id); showTip(p, at); });
      g.addEventListener("pointerleave", () => { onHover(null); setActive(null); tip.hidden = true; });
      g.addEventListener("click", (e) => { e.stopPropagation(); onPick(p.id); });
      layer.append(g);
    }
  }
  function showTip(p, at) {
    tip.textContent = describe(p);
    tip.hidden = false;
    tip.style.left = `${((at.x - view.x) / view.w) * 100}%`;
    tip.style.top = `${((at.y - view.y) / view.h) * 100}%`;
  }
  function fitPins() {
    if (!pins.length) return frame(MAP_FRAME.width / 2, MAP_FRAME.height / 2, MAP_FRAME.width);
    const pts = pins.map((p) => projectNyc(p.latitude, p.longitude));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const aspect = container.clientHeight / Math.max(1, container.clientWidth) || 1;
    const w = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) / aspect) * 1.5;
    frame((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, w);
  }
  function setActive(id) { if (active !== id) { active = id; draw(); } }
  function bounds() {
    const nw = toLatLon(view.x, view.y), se = toLatLon(view.x + view.w, view.y + view.h);
    return { south: se.lat, west: nw.lon, north: nw.lat, east: se.lon };
  }
  function setBounds(box) {
    const nw = projectNyc(box.north, box.west), se = projectNyc(box.south, box.east);
    frame((nw.x + se.x) / 2, (nw.y + se.y) / 2, se.x - nw.x);
  }
  const zoomBy = (k) => { moved = true; frame(view.x + view.w / 2, view.y + view.h / 2, view.w * k); onMove(bounds()); };
  zoom.children[0].addEventListener("click", () => zoomBy(0.6));
  zoom.children[1].addEventListener("click", () => zoomBy(1 / 0.6));

  // Drag to pan; the search follows when the drag ends.
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, view: { ...view }, moved: false };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    tip.hidden = true;
    const u = drag.view.w / container.clientWidth;
    view = { ...drag.view, x: drag.view.x - dx * u, y: drag.view.y - dy * u };
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  });
  svg.addEventListener("pointerup", () => {
    if (drag?.moved) { moved = true; onMove(bounds()); }
    drag = null;
  });
  function resize() {
    if (!container.clientWidth) return;
    if (moved) frame(view.x + view.w / 2, view.y + view.h / 2, view.w);
    else fitPins();
  }
  new ResizeObserver(resize).observe(container);
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  frame(MAP_FRAME.width / 2, MAP_FRAME.height / 2, MAP_FRAME.width);

  return {
    setPins(next, { fit = true } = {}) { pins = next.filter((p) => Number.isFinite(p.latitude)); if (fit) fitPins(); else draw(); },
    setActive,
    setSelected(id) { selected = id; draw(); },
    bounds,
    setBounds,
    resize,
    destroy() { container.replaceChildren(); },
  };
}
