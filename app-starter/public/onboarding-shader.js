// The welcome backdrop: contour lines of a slowly drifting value surface over a faint grid of lots,
// drawn in the theme's ink on its background. Returns a stop function, or null when WebGL2 is missing
// or the shader does not compile, so the page keeps its plain gradient.

const VERTEX = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 res;
uniform float time;
uniform float reveal;
uniform vec3 bg;
uniform vec3 ink;
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

  // A street grid of long blocks, skewed like the city's, with lot lines inside each block.
  vec2 q = mat2(0.94, -0.34, 0.34, 0.94) * p;
  vec2 block = abs(fract(q * vec2(3.2, 9.0)) - 0.5);
  float street = 1.0 - smoothstep(0.0, 1.5 * fwidth(q.x * 3.2), 0.5 - max(block.x, 0.0));
  float avenue = 1.0 - smoothstep(0.0, 1.5 * fwidth(q.y * 9.0), 0.5 - block.y);
  float lots = 1.0 - smoothstep(0.0, 1.2 * fwidth(q.x * 19.2), 0.5 - abs(fract(q.x * 19.2) - 0.5));
  float grid = max(max(street, avenue) * 0.55, lots * 0.16);

  // The surface rises toward the upper right, where the lines are strongest; the text side stays calm.
  float weight = smoothstep(-0.9, 0.9, p.x * 0.8 + p.y * 0.35 + 0.15);
  float radius = length(p - vec2(0.35, 0.1));
  float shown = smoothstep(reveal * 2.2, reveal * 2.2 - 0.6, radius);

  float lines = (minor * 0.22 + major * 0.55) * (0.35 + 0.65 * weight) + grid * 0.07 * weight;
  float glow = smoothstep(0.75, 0.0, radius) * 0.05;
  vec3 c = mix(bg, ink, clamp(lines * shown + glow * reveal, 0.0, 1.0));
  color = vec4(c, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function mountShader(canvas, { dark, still }) {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX), fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const at = name => gl.getUniformLocation(program, name);
  // The app's night and day backgrounds and inks, in linear-ish sRGB.
  gl.uniform3fv(at("bg"), dark ? [0.039, 0.039, 0.039] : [0.976, 0.976, 0.976]);
  gl.uniform3fv(at("ink"), dark ? [0.93, 0.93, 0.93] : [0.09, 0.09, 0.09]);

  const resize = () => {
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(canvas.clientWidth * scale);
    canvas.height = Math.round(canvas.clientHeight * scale);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(at("res"), canvas.width, canvas.height);
  };
  const draw = (time, reveal) => {
    gl.uniform1f(at("time"), time);
    gl.uniform1f(at("reveal"), reveal);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  resize();
  addEventListener("resize", resize);
  if (still) {
    draw(12, 1);
    return () => removeEventListener("resize", resize);
  }
  const start = performance.now();
  let frame = 0;
  const tick = now => {
    const seconds = (now - start) / 1000;
    // The lines spread out from the surface's high point over the first second and a half.
    const reveal = 1 - Math.pow(1 - Math.min(seconds / 1.6, 1), 3);
    draw(12 + seconds, reveal);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    removeEventListener("resize", resize);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
