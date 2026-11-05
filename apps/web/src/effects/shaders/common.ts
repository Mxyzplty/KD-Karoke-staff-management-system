// SPDX-License-Identifier: AGPL-3.0-only
// Shared shader text: per-language preludes (uniforms, textures, texel access), the vertex stage, the fragment entry
// and the helper library every kernel can call. Helpers are written in the WGSL subset of dsl.ts and mirror the
// formula oracle (parity/oracle/math.ts, image.ts) operation for operation, so GPU and CPU differ only by float32.
//
// Coordinates follow the oracle: x right, y UP from the bottom edge, pixel centres at (k + 0.5) / size.
// texel(col, rfb) reads column `col`, row `rfb` counted up from the bottom, clamped to the edge. Both backends keep
// that contract: WebGL2 stores the source bottom row first, WebGPU top row first (the WGSL texel flips).
// tab(col, row) reads the aux texture raw (no flip, clamped): lookup tables, or a mask uploaded top row first.
import { expand, toGlsl, type Lang } from '../dsl';
import type { EffectDefinition } from '../schema';

const GLSL_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 fxP[64];
uniform sampler2D fxSrc;
uniform sampler2D fxAux;
out vec4 fxOut;
vec4 texel(float col, float rfb) {
  vec2 d = vec2(textureSize(fxSrc, 0));
  return texelFetch(fxSrc, ivec2(int(clamp(col, 0.0, d.x - 1.0)), int(clamp(rfb, 0.0, d.y - 1.0))), 0);
}
vec4 tab(float col, float row) {
  vec2 d = vec2(textureSize(fxAux, 0));
  return texelFetch(fxAux, ivec2(int(clamp(col, 0.0, d.x - 1.0)), int(clamp(row, 0.0, d.y - 1.0))), 0);
}
`;

const GLSL_ENTRY = `
void main() {
  vec4 c = fx(gl_FragCoord.x / fxP[0].x, gl_FragCoord.y / fxP[0].y);
  if (fxP[1].z > 0.5) { c = floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 255.0; }
  fxOut = c;
}
`;

/** WebGL2 vertex stage: one oversized triangle from gl_VertexID (draw 3 vertices with an empty VAO). */
export const GLSL_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const WGSL_PRELUDE = `struct FxU { p: array<vec4f, 64> }
@group(0) @binding(0) var<uniform> fxu: FxU;
@group(0) @binding(1) var fxSrc: texture_2d<f32>;
@group(0) @binding(2) var fxAux: texture_2d<f32>;
fn texel(col: f32, rfb: f32) -> vec4f {
  let d: vec2f = vec2f(textureDimensions(fxSrc, 0));
  let c: f32 = clamp(col, 0.0, d.x - 1.0);
  let r: f32 = d.y - 1.0 - clamp(rfb, 0.0, d.y - 1.0);
  return textureLoad(fxSrc, vec2i(i32(c), i32(r)), 0);
}
fn tab(col: f32, row: f32) -> vec4f {
  let d: vec2f = vec2f(textureDimensions(fxAux, 0));
  return textureLoad(fxAux, vec2i(i32(clamp(col, 0.0, d.x - 1.0)), i32(clamp(row, 0.0, d.y - 1.0))), 0);
}
@vertex fn vsMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p: vec2f = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const WGSL_ENTRY = `
@fragment fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var c: vec4f = fx(pos.x / fxu.p[0].x, 1.0 - pos.y / fxu.p[0].y);
  if (fxu.p[1].z > 0.5) { c = floor(clamp(c, vec4f(0.0), vec4f(1.0)) * 255.0 + 0.5) / 255.0; }
  return c;
}
`;

/**
 * Helper library (WGSL subset). Frame references only ($W $H $AW $AH), so it expands without an effect.
 * h1 and h2 reduce their sine argument mod 2π first (rsin, equal in exact arithmetic): GPU sin of arguments ≫ 2π (glitch
 * seeds, film grain, value noise) skews the hash distribution. rsin subtracts k·2π as the power-of-two terms of 2π down to
 * 2^-28: every product is exact and the differences are near-exact (error ≲ 1e-6 rad), so the residue keeps n's full f32
 * spacing; a single f32 k·2π would round to n's own spacing and collapse the residue onto a few values.
 * Kernels never call the builtin sin, cos or atan2: WGSL and Vulkan allow them 2^-11 absolute error, which software
 * rasterisers (SwiftShader on GPU-less CI) use, and that moves sample positions and hash values by far more than f32.
 * sc(a) = (sin a, cos a): a − q·π/2 in three parts (Cody-Waite; q·1.5703125 is exact), then the Cephes sinf/cosf
 * polynomials on [−π/4, π/4]. atan2s: Cephes atanf after folding to [0, 1] and, above tan(π/8), (t − 1)/(t + 1).
 * atan2s ignores signed zeros ((−0, u < 0) → +π, (±0, −0) → 0, unlike Math.atan2); kaleidoscope folds mod 2π/n, recolor takes abs.
 * Both equal the oracle's Math functions in exact arithmetic and stay within a few f32 ulps on every backend.
 */
export const HELPERS = `
fn c01(v: f32) -> f32 { return clamp(v, 0.0, 1.0); }
fn c013(v: vec3f) -> vec3f { return clamp(v, vec3f(0.0), vec3f(1.0)); }
fn c014(v: vec4f) -> vec4f { return clamp(v, vec4f(0.0), vec4f(1.0)); }
fn mx(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }
fn mx3(a: vec3f, b: vec3f, t: f32) -> vec3f { return a + (b - a) * t; }
fn mx4(a: vec4f, b: vec4f, t: f32) -> vec4f { return a + (b - a) * t; }
fn smoothq(a: f32, b: f32, v: f32) -> f32 {
  var t: f32 = 0.0;
  if (a == b) { t = step(b, v); } else { t = c01((v - a) / (b - a)); }
  return t * t * (3.0 - 2.0 * t);
}
fn fmodf(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }
fn tmodf(a: f32, b: f32) -> f32 { return a - b * trunc(a / b); }
fn sc(a: f32) -> vec2f {
  let q: f32 = floor(a * 0.6366197723675814 + 0.5);
  var r: f32 = a - q * 1.5703125;
  r = r - q * 4.837512969970703125e-4;
  r = r - q * 7.549789954891882e-8;
  let z: f32 = r * r;
  let s: f32 = ((-1.9515295891e-4 * z + 8.3321608736e-3) * z - 1.6666654611e-1) * z * r + r;
  let c: f32 = ((2.443315711809948e-5 * z - 1.388731625493765e-3) * z + 4.166664568298827e-2) * z * z - 0.5 * z + 1.0;
  let n: f32 = q - 4.0 * floor(q * 0.25);
  if (n == 0.0) { return vec2f(s, c); }
  if (n == 1.0) { return vec2f(c, -s); }
  if (n == 2.0) { return vec2f(-s, -c); }
  return vec2f(-c, s);
}
fn psin(a: f32) -> f32 { return sc(a).x; }
fn pcos(a: f32) -> f32 { return sc(a).y; }
fn atan2s(v: f32, u: f32) -> f32 {
  let ax: f32 = abs(u);
  let ay: f32 = abs(v);
  let hi: f32 = max(ax, ay);
  if (hi == 0.0) { return 0.0; }
  var t: f32 = min(ax, ay) / hi;
  var b: f32 = 0.0;
  if (t > 0.41421356237309503) {
    t = (t - 1.0) / (t + 1.0);
    b = 0.7853981633974483;
  }
  let z: f32 = t * t;
  var a: f32 = b + (((8.05374449538e-2 * z - 1.38776856032e-1) * z + 1.99777106478e-1) * z - 3.33329491539e-1) * z * t + t;
  if (ay > ax) { a = 1.5707963267948966 - a; }
  if (u < 0.0) { a = 3.141592653589793 - a; }
  if (v < 0.0) { a = -a; }
  return a;
}
fn powz(b: f32, e: f32) -> f32 {
  if (b <= 0.0) {
    if (e == 0.0) { return 1.0; }
    return 0.0;
  }
  return pow(b, e);
}
fn hyp(a: f32, b: f32) -> f32 { return length(vec2f(a, b)); }
fn deg(a: f32) -> f32 { return a * 3.141592653589793 / 180.0; }

fn here(x: f32, y: f32) -> vec4f { return texel(floor(x * $W), floor(y * $H)); }
fn samp(x: f32, y: f32) -> vec4f {
  let px: f32 = clamp(x * $W - 0.5, -1.0, $W);
  let py: f32 = clamp(y * $H - 0.5, -1.0, $H);
  let x0: f32 = floor(px);
  let y0: f32 = floor(py);
  let tx: f32 = px - x0;
  let ty: f32 = py - y0;
  let a: vec4f = texel(x0, y0);
  let b: vec4f = texel(x0 + 1.0, y0);
  let c: vec4f = texel(x0, y0 + 1.0);
  let d: vec4f = texel(x0 + 1.0, y0 + 1.0);
  return (a * (1.0 - tx) + b * tx) * (1.0 - ty) + (c * (1.0 - tx) + d * tx) * ty;
}
fn auxtexel(col: f32, rfb: f32) -> vec4f { return tab(col, $AH - 1.0 - clamp(rfb, 0.0, $AH - 1.0)); }
fn auxsamp(x: f32, y: f32) -> vec4f {
  let px: f32 = clamp(x * $AW - 0.5, -1.0, $AW);
  let py: f32 = clamp(y * $AH - 0.5, -1.0, $AH);
  let x0: f32 = floor(px);
  let y0: f32 = floor(py);
  let tx: f32 = px - x0;
  let ty: f32 = py - y0;
  let a: vec4f = auxtexel(x0, y0);
  let b: vec4f = auxtexel(x0 + 1.0, y0);
  let c: vec4f = auxtexel(x0, y0 + 1.0);
  let d: vec4f = auxtexel(x0 + 1.0, y0 + 1.0);
  return (a * (1.0 - tx) + b * tx) * (1.0 - ty) + (c * (1.0 - tx) + d * tx) * ty;
}

fn y601(c: vec3f) -> f32 { return c.x * 0.299 + c.y * 0.587 + c.z * 0.114; }
fn y709(c: vec3f) -> f32 { return c.x * 0.2126 + c.y * 0.7152 + c.z * 0.0722; }
fn sat601(c: vec3f, k: f32) -> vec3f {
  let l: f32 = y601(c);
  return l + (c - l) * k;
}
fn wb(c: vec3f, t: f32, u: f32) -> vec3f { return vec3f(c.x + 0.1 * t + 0.05 * u, c.y - 0.1 * u, c.z - 0.1 * t + 0.05 * u); }
fn hsv(c: vec3f) -> vec3f {
  let hi: f32 = max(max(c.x, c.y), c.z);
  let lo: f32 = min(min(c.x, c.y), c.z);
  let d: f32 = hi - lo;
  var h: f32 = 0.0;
  if (d < 1e-10) { h = 0.0; } else if (hi == c.x) { h = (c.y - c.z) / d; } else if (hi == c.y) { h = (c.z - c.x) / d + 2.0; } else { h = (c.x - c.y) / d + 4.0; }
  return vec3f(fract(h / 6.0), d / (hi + 1e-10), hi);
}
fn hsvch(h: f32, s: f32, v: f32, o: f32) -> f32 { return v * mx(1.0, c01(abs(fract(h + o) * 6.0 - 3.0) - 1.0), s); }
fn fromHsv(c: vec3f) -> vec3f { return vec3f(hsvch(c.x, c.y, c.z, 1.0), hsvch(c.x, c.y, c.z, 2.0 / 3.0), hsvch(c.x, c.y, c.z, 1.0 / 3.0)); }
fn hsl(c: vec3f) -> vec3f {
  let h: vec3f = hsv(c);
  let hi: f32 = max(max(c.x, c.y), c.z);
  let lo: f32 = min(min(c.x, c.y), c.z);
  let l: f32 = (hi + lo) / 2.0;
  let d: f32 = hi - lo;
  var s: f32 = 0.0;
  if (d >= 1e-5) { s = d / (1.0 - abs(2.0 * l - 1.0)); }
  return vec3f(h.x * 360.0, s, l);
}
fn fromHsl(q: vec3f) -> vec3f {
  let k: f32 = (1.0 - abs(2.0 * q.z - 1.0)) * q.y;
  let w: f32 = k * (1.0 - abs(tmodf(q.x / 60.0, 2.0) - 1.0));
  let m: f32 = q.z - k / 2.0;
  var p: vec3f = vec3f(k, 0.0, w);
  if (q.x < 60.0) { p = vec3f(k, w, 0.0); } else if (q.x < 120.0) { p = vec3f(w, k, 0.0); } else if (q.x < 180.0) { p = vec3f(0.0, k, w); } else if (q.x < 240.0) { p = vec3f(0.0, w, k); } else if (q.x < 300.0) { p = vec3f(w, 0.0, k); }
  return p + m;
}

fn lin1(v: f32) -> f32 {
  if (v <= 0.04045) { return v / 12.92; }
  return powz((v + 0.055) / 1.055, 2.4);
}
fn srgb1(v: f32) -> f32 {
  if (v <= 0.0031308) { return 12.92 * v; }
  return 1.055 * powz(v, 1.0 / 2.4) - 0.055;
}
fn cbrtf(v: f32) -> f32 {
  if (v == 0.0) { return 0.0; }
  return sign(v) * pow(abs(v), 1.0 / 3.0);
}
fn cube(v: f32) -> f32 { return v * v * v; }
fn oklab(c: vec3f) -> vec3f {
  let r: f32 = lin1(c.x);
  let g: f32 = lin1(c.y);
  let b: f32 = lin1(c.z);
  let l: f32 = cbrtf(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  let m: f32 = cbrtf(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  let s: f32 = cbrtf(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return vec3f(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
fn labLinear(q: vec3f) -> vec3f {
  let a: f32 = cube(q.x + 0.3963377774 * q.y + 0.2158037573 * q.z);
  let b: f32 = cube(q.x - 0.1055613458 * q.y - 0.0638541728 * q.z);
  let c: f32 = cube(q.x - 0.0894841775 * q.y - 1.291485548 * q.z);
  return vec3f(4.0767416621 * a - 3.3077115913 * b + 0.2309699292 * c, -1.2684380046 * a + 2.6097574011 * b - 0.3413193965 * c,
    -0.0041960863 * a - 0.7034186147 * b + 1.707614701 * c);
}

fn rsin(n: f32) -> f32 {
  let k: f32 = floor(n * 0.15915494309189535);
  var r: f32 = n - 4.0 * k;
  r = r - 2.0 * k; r = r - 0.25 * k; r = r - 0.03125 * k; r = r - 0.0009765625 * k; r = r - 0.00048828125 * k;
  r = r - 0.000244140625 * k; r = r - 0.0001220703125 * k; r = r - 0.00006103515625 * k; r = r - 0.000030517578125 * k;
  r = r - 0.00000762939453125 * k; r = r - 0.000003814697265625 * k; r = r - 9.5367431640625e-7 * k;
  r = r - 2.384185791015625e-7 * k; r = r - 5.9604644775390625e-8 * k; r = r - 3.725290298461914e-9 * k;
  return psin(r);
}
fn h1(n: f32) -> f32 { return fract(43758.5453 * rsin(n)); }
fn h2(u: f32, v: f32) -> f32 { return fract(43758.5453 * rsin(12.9898 * u + 78.233 * v)); }
fn hw(u: f32, v: f32) -> f32 {
  let q0: f32 = fract(u * 0.1031);
  let q1: f32 = fract(v * 0.1031);
  let q2: f32 = fract(u * 0.1031);
  let d: f32 = q0 * (q1 + 33.33) + q1 * (q2 + 33.33) + q2 * (q0 + 33.33);
  return fract((q0 + q1 + 2.0 * d) * (q2 + d));
}
fn vq(a: f32, b: f32) -> f32 { return h2(127.1 * a + 311.7 * b, 269.5 * a + 183.3 * b); }
fn vnoise(u: f32, v: f32) -> f32 {
  let i: f32 = floor(u);
  let j: f32 = floor(v);
  let fu: f32 = u - i;
  let fv: f32 = v - j;
  let wu: f32 = fu * fu * (3.0 - 2.0 * fu);
  let wv: f32 = fv * fv * (3.0 - 2.0 * fv);
  return mx(mx(vq(i, j), vq(i + 1.0, j), wu), mx(vq(i, j + 1.0), vq(i + 1.0, j + 1.0), wu), wv);
}
fn l3noise(u: f32, v: f32) -> f32 {
  return (vnoise(u, v) + vnoise(1.31 * u + 0.74 * v + 11.7, -0.68 * u + 1.27 * v + 3.9) + vnoise(-0.57 * u + 1.43 * v - 7.4, 1.19 * u + 0.53 * v + 13.1)) / 3.0;
}
fn onoise(u: f32, v: f32) -> f32 {
  return 0.45 * l3noise(0.73 * u + 5.31, 0.73 * v - 8.17) + 0.35 * l3noise(1.41 * u - 0.52 * v - 11.4, 0.67 * u + 1.28 * v + 4.6)
    + 0.2 * l3noise(-0.88 * u + 1.19 * v + 8.2, -1.07 * u - 0.79 * v + 10.7);
}
`;

/**
 * Full fragment program for one kernel. `kernel` (WGSL subset) defines `fn fx(x: f32, y: f32) -> vec4f` plus any
 * helpers; `effect` resolves its `$param` references (undefined for transport stages and identity).
 * WGSL output is one module holding vsMain and fsMain; GLSL output pairs with GLSL_VERTEX.
 */
export function fragmentSource(kernel: string, effect: EffectDefinition | undefined, lang: Lang): string {
  const body = expand(HELPERS, undefined, lang) + '\n' + expand(kernel, effect, lang);
  return lang === 'wgsl' ? WGSL_PRELUDE + body + WGSL_ENTRY : GLSL_PRELUDE + toGlsl(body) + GLSL_ENTRY;
}
