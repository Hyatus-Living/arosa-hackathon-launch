// Contour backdrop: contour lines of a slowly drifting value surface over a faint grid of city lots,
// adapted from the app's welcome screen (app-starter/public/onboarding-shader.js). Here the canvas is
// transparent, so the page background shows through and only the lines are drawn, in the canvas's
// CSS `color`. The lines gather around a focus point (--contour-x, --contour-y on the canvas, in the
// same centered units as the shader) and stay calm elsewhere.
// Returns a controller, or null when WebGL2 is missing or the shader does not compile.

const VERTEX = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 res;
uniform float time;
uniform float reveal;
uniform vec2 focus;
uniform vec3 ink;
uniform float strength;
out vec4 color;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
float isoline(float v, float width) {
  float d = abs(fract(v) - 0.5);
  return 1.0 - smoothstep(0.0, width * fwidth(v), 0.5 - d);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / min(res.x, res.y);
  vec2 drift = vec2(time * 0.018, -time * 0.012);
  float z = fbm(p * 1.35 + drift) + 0.35 * fbm(p * 2.6 - drift * 1.4 + 3.1);

  float levels = z * 16.0;
  float minor = isoline(levels, 1.1);
  float major = isoline(levels / 4.0, 1.4);

  // A street grid of long blocks, skewed like Manhattan's, with lot lines inside each block.
  vec2 q = mat2(0.94, -0.34, 0.34, 0.94) * p;
  vec2 block = abs(fract(q * vec2(3.2, 9.0)) - 0.5);
  float street = 1.0 - smoothstep(0.0, 1.5 * fwidth(q.x * 3.2), 0.5 - max(block.x, 0.0));
  float avenue = 1.0 - smoothstep(0.0, 1.5 * fwidth(q.y * 9.0), 0.5 - block.y);
  float lots = 1.0 - smoothstep(0.0, 1.2 * fwidth(q.x * 19.2), 0.5 - abs(fract(q.x * 19.2) - 0.5));
  float grid = max(max(street, avenue) * 0.55, lots * 0.16);

  // Strongest around the focus point, calm on the far side where the text sits.
  float radius = length(p - focus);
  float weight = smoothstep(1.25, 0.05, radius);
  float shown = smoothstep(reveal * 2.2, reveal * 2.2 - 0.6, radius);

  float lines = (minor * 0.22 + major * 0.55) * (0.25 + 0.75 * weight) + grid * 0.1 * (0.3 + 0.7 * weight);
  float alpha = clamp(lines * shown * strength, 0.0, 1.0);
  color = vec4(ink * alpha, alpha);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function mountContours(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0, 0, 0, 0);
  const at = (name) => gl.getUniformLocation(program, name);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  let frame = 0;
  let running = false;
  let visible = true;
  let clock = 0;
  let last = 0;

  const readStyle = () => {
    const style = getComputedStyle(canvas);
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = style.color;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    gl.uniform3f(at('ink'), r / 255, g / 255, b / 255);
    gl.uniform1f(at('strength'), parseFloat(style.getPropertyValue('--contour-strength')) || 1);
    gl.uniform2f(at('focus'), parseFloat(style.getPropertyValue('--contour-x')) || 0.35, parseFloat(style.getPropertyValue('--contour-y')) || 0.1);
  };
  const draw = (time, shown) => {
    gl.uniform1f(at('time'), time);
    gl.uniform1f(at('reveal'), shown);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const still = () => draw(12 + clock, 1);
  const resize = () => {
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(at('res'), w, h);
    readStyle();
    if (!running) still();
  };
  const tick = (now) => {
    clock += Math.min((now - last) / 1000, 0.25);
    last = now;
    // The lines spread out from the focus point over the first second and a half.
    draw(12 + clock, 1 - Math.pow(1 - Math.min(clock / 1.6, 1), 3));
    frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (running || !visible || reduced.matches || document.hidden) return;
    running = true;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(frame);
  };
  const applyMotion = () => (reduced.matches ? (stop(), still()) : start());
  const onVisibility = () => (document.hidden ? stop() : start());

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    visible ? start() : stop();
  }).observe(canvas);
  reduced.addEventListener('change', applyMotion);
  document.addEventListener('visibilitychange', onVisibility);
  resize();
  applyMotion();

  return {
    // call after the page theme changes
    refreshColors() {
      readStyle();
      if (!running) still();
    },
  };
}
