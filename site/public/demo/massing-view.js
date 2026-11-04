// A light 3D view of a concept's massing for the landing page: each storey's footprint extruded to its
// height on the lot, with the zoning height limit drawn as a dashed outline. Drag to turn it; it turns
// slowly on its own until touched, and holds still for reduced motion. Drawn on a 2D canvas, so it costs
// nothing to load next to the app's own views.
import { reduced } from "/demo/shell.js";

const PITCH = 0.42;
const THEMES = {
  dark: { top: "#f2f2f2", left: "#bdbdbd", right: "#8e8e8e", edge: "rgba(18,18,18,0.55)", floor: "rgba(18,18,18,0.28)", lot: "rgba(255,255,255,0.10)", lotEdge: "rgba(255,255,255,0.35)", ghost: "rgba(255,255,255,0.45)", ink: "#d6d6d6", hood: "rgba(255,255,255,0.07)", hoodEdge: "rgba(255,255,255,0.16)" },
  light: { top: "#ffffff", left: "#e4e4e4", right: "#c9c9c9", edge: "rgba(20,20,20,0.6)", floor: "rgba(20,20,20,0.18)", lot: "rgba(0,0,0,0.05)", lotEdge: "rgba(0,0,0,0.3)", ghost: "rgba(0,0,0,0.45)", ink: "#3a3a3a", hood: "rgba(0,0,0,0.05)", hoodEdge: "rgba(0,0,0,0.14)" },
};

// Neighbouring buildings on the adjacent lots, for scale: the same depth, four and five storeys.
function neighbours(lot) {
  const xs = lot.map((p) => p[0]), zs = lot.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
  const box = (x0, x1, h) => ({ footprint: [[x0, 0], [x1, 0], [x1, d * 0.62], [x0, d * 0.62]], base: 0, height: h });
  return [box(-Math.max(25, w * 0.6) - 4, -4, 46), box(w + 4, w + 4 + Math.max(25, w * 0.7), 56)];
}

export function massingView(concept, { height = 300 } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "massing-view";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  const m = concept.massing;
  const top = Math.max(...m.storeys.map((s) => s.base + s.height));
  canvas.setAttribute("aria-label", `${concept.name}: ${m.storeys.length} storeys, about ${Math.round(top)} ft, on a ${concept.metrics.lotAreaSqft.toLocaleString("en-US")} sq ft lot. Drag to turn the model.`);
  const hint = document.createElement("span");
  hint.className = "massing-hint";
  hint.textContent = "Drag to turn";
  wrap.append(canvas, hint);

  const lot = m.lot;
  const cx = (Math.min(...lot.map((p) => p[0])) + Math.max(...lot.map((p) => p[0]))) / 2;
  const cz = (Math.min(...lot.map((p) => p[1])) + Math.max(...lot.map((p) => p[1]))) / 2;
  // Buildings are drawn far to near, and a building's storeys bottom to top.
  const buildings = [...neighbours(lot).map((b) => [{ ...b, hood: true }]), m.storeys];
  const limit = m.maxHeightFeet || top;
  // The scale fits the turning model: every footprint within radius r of the lot's centre, up to the limit.
  const r = Math.max(...buildings.flat().flatMap((b) => b.footprint).map(([x, z]) => Math.hypot(x - cx, z - cz)));
  let yaw = -0.7, spin = !reduced(), frame = 0, last = 0, drag = null;

  const project = (x, y, z, s, w, oy) => {
    const X = (x - cx) * Math.cos(yaw) - (z - cz) * Math.sin(yaw);
    const Z = (x - cx) * Math.sin(yaw) + (z - cz) * Math.cos(yaw);
    return { x: w / 2 + X * s, y: oy - y * Math.cos(PITCH) * s + Z * Math.sin(PITCH) * s, depth: Z * Math.cos(PITCH) + y * Math.sin(PITCH) };
  };

  function draw() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = wrap.clientWidth || 600, h = height;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.height = `${h}px`; }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const c = THEMES[document.documentElement.classList.contains("dark") ? "dark" : "light"];
    const s = Math.min((w - 48) / (2 * r), (h - 40) / (limit * Math.cos(PITCH) + 2 * r * Math.sin(PITCH)));
    const oy = h / 2 + (limit * Math.cos(PITCH) * s) / 2;
    const P = (x, y, z) => project(x, y, z, s, w, oy);
    const poly = (pts, fill, stroke, dash = null) => {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.setLineDash(dash || []); g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); g.setLineDash([]); }
    };
    // The lot on the ground.
    poly(lot.map(([x, z]) => P(x, 0, z)), c.lot, c.lotEdge);
    const centre = (b) => P(b.footprint.reduce((a, p) => a + p[0], 0) / b.footprint.length, 0, b.footprint.reduce((a, p) => a + p[1], 0) / b.footprint.length).depth;
    const order = buildings.map((storeys) => ({ storeys, depth: centre(storeys[0]) })).sort((p, q) => p.depth - q.depth).flatMap((x) => x.storeys);
    for (const b of order) {
      const fp = b.footprint, y0 = b.base, y1 = b.base + b.height;
      const sides = fp.map((p, i) => {
        const q = fp[(i + 1) % fp.length];
        const a = P(p[0], y0, p[1]), bb = P(q[0], y0, q[1]), d = P(q[0], y1, q[1]), e = P(p[0], y1, p[1]);
        return { pts: [a, bb, d, e], depth: (a.depth + bb.depth) / 2, normal: Math.atan2(q[1] - p[1], q[0] - p[0]) };
      }).sort((p, q) => p.depth - q.depth);
      for (const side of sides) {
        const facing = Math.cos(side.normal + yaw);
        poly(side.pts, b.hood ? c.hood : facing > 0 ? c.left : c.right, b.hood ? c.hoodEdge : c.edge);
      }
      poly(fp.map(([x, z]) => P(x, y1, z)), b.hood ? c.hood : c.top, b.hood ? c.hoodEdge : c.edge);
    }
    // The height limit over the lot, dashed.
    const corners = lot.map(([x, z]) => P(x, limit, z));
    poly(corners, null, c.ghost, [4, 4]);
    g.setLineDash([4, 4]);
    g.strokeStyle = c.ghost;
    for (const [x, z] of lot) { const a = P(x, 0, z), b = P(x, limit, z); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    g.setLineDash([]);
    const tag = corners.reduce((a, p) => (p.x > a.x ? p : a));
    g.fillStyle = c.ink;
    g.font = '500 11px "Geist Mono", ui-monospace, monospace';
    g.fillText(`${Math.round(limit)} ft limit`, Math.min(w - 78, tag.x + 8), tag.y + 4);
  }

  function tick(t) {
    if (!wrap.isConnected) return;
    if (spin && last) yaw += (t - last) * 0.00012;
    last = t;
    draw();
    frame = spin ? requestAnimationFrame(tick) : 0;
  }
  canvas.addEventListener("pointerdown", (e) => {
    spin = false;
    hint.hidden = true;
    drag = { x: e.clientX, yaw };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
    draw();
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.tabIndex = 0;
  canvas.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    spin = false;
    yaw += e.key === "ArrowLeft" ? -0.15 : 0.15;
    draw();
  });
  new ResizeObserver(() => draw()).observe(wrap);
  new MutationObserver(() => draw()).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  // Only turn while on screen.
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && spin && !frame) frame = requestAnimationFrame(tick);
    if (!entry.isIntersecting && frame) { cancelAnimationFrame(frame); frame = 0; last = 0; }
  }).observe(wrap);
  requestAnimationFrame(draw);
  return wrap;
}
