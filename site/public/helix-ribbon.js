// Helix ribbon: a bundle of thin strands that coil around a swaying centerline, drawn on a 2D canvas.
// Each strand sits on the surface of an imaginary tube; projecting the tube flat makes the strands
// cross like a twisted ribbon. Colors come from CSS custom properties on the canvas:
//   --ribbon-from, --ribbon-to   first and last strand color
//   --ribbon-spark               comma-separated colors for the streaks that travel along strands

const DEFAULTS = {
  width: 1720, // virtual drawing space, fitted to the canvas with "cover"
  height: 1080,
  strands: 24,
  samples: 80,
  gap: 4.9, // resting distance between neighboring strands
  sway: 82, // centerline wave height
  swayCycles: 0.75,
  swaySpread: 3.2, // radians the wave is offset from the first strand to the last, which fans the bundle
  coil: 34, // tube radius the strands wrap around
  coilCycles: 0.375,
  coilSpread: 6.4, // radians of the tube the strands cover
  wobble: 0.5, // slow irregular drift layered on top
  bulge: 0.66, // ribbon is this much fuller in the middle than at the ends
  tilt: -28, // degrees
  spin: 0.46, // coil turn rate, radians per second
  fade: 0.25, // share of each strand that fades in from either end
  depth: 0.2, // how much strands on the far side of the tube dim
  lineWidth: 1,
  sparks: 8,
  sparkLength: 90,
  sparkWidth: 2.6,
  sparkTrip: 4.2, // seconds to travel the strand
  sparkRest: 2.6, // seconds between trips
  reveal: 1.5, // seconds for the opening draw-in, 0 to skip
  settle: 0.8, // the draw-in waits at most this many seconds for steady frames after load
  maxStep: 0.05, // longest step one frame may advance the motion, in seconds
  maxDpr: 2,
  maxPixels: 3600000, // backing-store budget: a very large canvas trades a little sharpness for steady frames
};

const easeOutExpo = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));

function rand(seed) {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function splitColors(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') depth--;
    if (value[i] === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

export function mountHelixRibbon(canvas, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const ctx = canvas.getContext('2d');
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // Strand geometry is rewritten in place every frame, so the loop allocates nothing.
  const paths = Array.from({ length: o.strands }, () => new Float32Array((o.samples + 1) * 3));
  const lengths = new Float32Array(o.strands);
  const dash = [0, 0];
  const point = [0, 0];
  const SPARK_STEPS = 5;
  let strandFades = [];
  let sparkColors = [];
  let sparkPlan = [];

  // One clock for the ribbon's whole life. It holds at zero until the page has settled into steady
  // frames, then only moves forward: resizes, theme changes and scrolling out of view never reset it.
  let clock = 0;
  let started = false;
  let steady = 0;
  let waited = 0;
  let raf = 0;
  let running = false;
  let visible = true;
  let last = 0;
  let pending = null; // a new canvas size, applied at the start of the next frame

  const toRgb = (css) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    return Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
  };
  const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

  function readColors() {
    const style = getComputedStyle(canvas);
    const from = toRgb(style.getPropertyValue('--ribbon-from'));
    const to = toRgb(style.getPropertyValue('--ribbon-to'));
    sparkColors = splitColors(style.getPropertyValue('--ribbon-spark')).map((c) => rgba(toRgb(c), 1));
    // The strands are drawn in the tilted, unscaled frame, so one horizontal gradient per strand
    // serves every frame.
    strandFades = Array.from({ length: o.strands }, (_, i) => {
      const k = o.strands === 1 ? 0 : i / (o.strands - 1);
      const c = from.map((v, j) => Math.round(v + (to[j] - v) * k));
      const g = ctx.createLinearGradient(0, 0, o.width, 0);
      g.addColorStop(0, rgba(c, 0));
      if (o.fade > 0) {
        g.addColorStop(o.fade, rgba(c, 1));
        g.addColorStop(1 - o.fade, rgba(c, 1));
      }
      g.addColorStop(1, rgba(c, 0));
      return g;
    });
  }

  function planSparks() {
    sparkPlan = Array.from({ length: o.sparks }, (_, n) => ({
      strand: Math.floor(rand(n * 7 + 1) * o.strands),
      offset: rand(n * 7 + 2) * (o.sparkTrip + o.sparkRest),
      color: Math.floor(rand(n * 7 + 3) * 997),
    }));
  }

  function buildPaths(t) {
    const { width, height, strands, samples } = o;
    const mid = (strands - 1) / 2;
    const spinPhase = t * o.spin;
    for (let i = 0; i < strands; i++) {
      const u = (i - mid) / Math.max(mid, 1); // -1 .. 1 across the bundle
      const around = -u * o.coilSpread * 0.5;
      const pts = paths[i];
      let len = 0;
      for (let s = 0; s <= samples; s++) {
        const x = s / samples;
        const envelope = 1 + o.bulge * Math.sin(Math.PI * x);
        const angle = Math.PI * 2 * o.coilCycles * x + spinPhase + around;
        const center = o.sway * Math.sin(Math.PI * 2 * o.swayCycles * x + u * o.swaySpread * 0.5);
        const drift = o.wobble * o.sway * Math.sin(3.3 * x + 0.21 * i + t * 0.23) * Math.cos(1.9 * x - 0.15 * i - t * 0.17);
        const y = height / 2 + u * mid * o.gap + envelope * (center + drift + o.coil * Math.cos(angle));
        const px = x * width;
        pts[s * 3] = px;
        pts[s * 3 + 1] = y;
        pts[s * 3 + 2] = Math.sin(angle); // >0 is the near side of the tube
        if (s) len += Math.hypot(px - pts[s * 3 - 3], y - pts[s * 3 - 2]);
      }
      lengths[i] = len;
    }
  }

  function trace(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let s = 1; s < o.samples; s++) {
      const mx = (pts[s * 3] + pts[s * 3 + 3]) / 2;
      const my = (pts[s * 3 + 1] + pts[s * 3 + 4]) / 2;
      ctx.quadraticCurveTo(pts[s * 3], pts[s * 3 + 1], mx, my);
    }
    ctx.lineTo(pts[o.samples * 3], pts[o.samples * 3 + 1]);
  }

  function pointAt(pts, x) {
    const f = Math.min(Math.max(x, 0), 1) * o.samples;
    const s = Math.min(Math.floor(f), o.samples - 1);
    const k = f - s;
    point[0] = pts[s * 3] + (pts[s * 3 + 3] - pts[s * 3]) * k;
    point[1] = pts[s * 3 + 1] + (pts[s * 3 + 4] - pts[s * 3 + 1]) * k;
    return point;
  }

  // t: seconds of motion; progress: 0..1 through the opening draw-in.
  function draw(t, progress) {
    const dpr = canvas.width / canvas.clientWidth || 1;
    const scale = Math.max(canvas.width / o.width, canvas.height / o.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (progress <= 0) return;
    // cover-fit, then tilt about the center of the virtual space
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(scale, scale);
    ctx.rotate((o.tilt * Math.PI) / 180);
    ctx.translate(-o.width / 2, -o.height / 2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (o.lineWidth * dpr) / scale;

    buildPaths(t);
    for (let i = 0; i < o.strands; i++) {
      const pts = paths[i];
      if (progress < 1) {
        const delay = rand(i + 101) * 0.4;
        const shown = easeOutExpo(Math.max(0, (progress - delay) / 0.6));
        if (shown <= 0) continue;
        dash[0] = lengths[i] * shown;
        dash[1] = lengths[i];
        ctx.setLineDash(dash);
      }
      // average tube side decides how bright the strand reads this frame
      let side = 0;
      for (let s = 0; s <= o.samples; s += 8) side += pts[s * 3 + 2];
      side /= Math.floor(o.samples / 8) + 1;
      ctx.globalAlpha = 1 - o.depth * (0.5 - side * 0.5);
      ctx.strokeStyle = strandFades[i];
      trace(pts);
      ctx.stroke();
    }
    if (progress < 1) ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // sparks join once the strands are fully drawn, fading in rather than appearing mid-trip
    if (progress >= 1 && sparkColors.length) drawSparks(t, scale, dpr);
  }

  // Each streak is a few segments of rising opacity, so no gradient is created per frame.
  function drawSparks(t, scale, dpr) {
    const cycle = o.sparkTrip + o.sparkRest;
    const span = o.sparkLength / o.width;
    ctx.lineWidth = (o.sparkWidth * dpr) / scale;
    for (const spark of sparkPlan) {
      const phase = (t + spark.offset) % cycle;
      if (phase > o.sparkTrip) continue;
      const p = phase / o.sparkTrip;
      const pts = paths[spark.strand];
      const head = p * (1 + o.fade) - o.fade * 0.5;
      const strength = Math.min(p / 0.15, 1) * Math.min((1 - p) / 0.3, 1);
      ctx.strokeStyle = sparkColors[spark.color % sparkColors.length];
      for (let k = 0; k < SPARK_STEPS; k++) {
        const a = head - span + (span * k) / SPARK_STEPS;
        const b = head - span + (span * (k + 1)) / SPARK_STEPS;
        if (b <= 0 || a >= 1) continue;
        ctx.globalAlpha = (strength * (k + 1)) / SPARK_STEPS;
        ctx.beginPath();
        pointAt(pts, a);
        ctx.moveTo(point[0], point[1]);
        for (let s = Math.max(1, Math.ceil(Math.max(a, 0) * o.samples)); s < Math.min(b, 1) * o.samples; s++) ctx.lineTo(pts[s * 3], pts[s * 3 + 1]);
        pointAt(pts, b);
        ctx.lineTo(point[0], point[1]);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  const progress = () => (o.reveal > 0 ? Math.min(clock / o.reveal, 1) : 1);

  function applySize() {
    if (!pending) return;
    canvas.width = pending[0];
    canvas.height = pending[1];
    pending = null;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const step = Math.max(0, (now - last) / 1000);
    last = now;
    applySize();
    if (!started) {
      // Hold the draw-in until frames arrive steadily (fonts, layout and other scripts done), so it
      // plays smoothly once instead of stuttering through the page's busiest moment.
      waited += step;
      steady = step > 0 && step < 0.034 ? steady + 1 : 0;
      if (steady < 3 && waited < o.settle) return;
      started = true;
      return;
    }
    clock += Math.min(step, o.maxStep);
    draw(clock, progress());
  }

  function start() {
    if (running || !visible || reduced.matches) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  // Draw the current moment when no loop is running to do it.
  const still = () => {
    applySize();
    draw(clock, reduced.matches ? 1 : progress());
  };

  function measure() {
    const small = Math.min(innerWidth, innerHeight) < 640;
    const area = Math.max(canvas.clientWidth * canvas.clientHeight, 1);
    const dpr = Math.min(devicePixelRatio || 1, small ? Math.min(o.maxDpr, 1.5) : o.maxDpr, Math.sqrt(o.maxPixels / area));
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const target = pending || [canvas.width, canvas.height];
    if (w === target[0] && h === target[1]) return;
    // Resizing clears the canvas, so the new size is applied inside a frame, right before the
    // redraw; several resizes within one frame collapse into one.
    pending = [w, h];
    if (!running) still();
  }

  function applyMotionPreference() {
    if (reduced.matches) {
      stop();
      still();
    } else start();
  }

  readColors();
  planSparks();
  const sizeWatch = new ResizeObserver(measure);
  sizeWatch.observe(canvas);
  const viewWatch = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      visible ? start() : stop();
    },
    { rootMargin: '10% 0px' },
  );
  viewWatch.observe(canvas);
  reduced.addEventListener('change', applyMotionPreference);
  measure();
  applyMotionPreference();

  return {
    // call after the page theme or the --ribbon-* properties change
    refreshColors() {
      readColors();
      if (!running) still();
    },
    // draw the ribbon as it looks t seconds into its motion, e.g. for a poster frame
    renderAt(t) {
      stop();
      clock = t;
      started = true;
      applySize();
      draw(t, 1);
    },
    replay() {
      clock = 0;
      started = true;
      if (!running) still();
    },
    destroy() {
      stop();
      sizeWatch.disconnect();
      viewWatch.disconnect();
      reduced.removeEventListener('change', applyMotionPreference);
    },
  };
}
