// SPDX-License-Identifier: AGPL-3.0-only
// CPU float reference of the stylize effects, findings part 4 §50 (export convention: y up from the bottom edge).
import { clamp, mix, smooth, frac, y601, y709, h1, h2, hw, colour, type RGBA, type Params } from './math';
import { mapPixels, sample, type Image, type Effect, type EffectContext } from './image';

// Per-frame setup, then one evaluation at any normalised export position (pixel centres or not).
export type Kernel = (src: Image, p: Params, context: EffectContext) => (x: number, y: number) => RGBA;
const num = (p: Params, key: string, fallback: number): number => p[key] ?? fallback;
const pick = (p: Params, key: string, options: string[], fallback: string) => { const i = options.indexOf(p[key] ?? fallback); return i < 0 ? options.indexOf(fallback) : i; };
const seedOf = (context: EffectContext) => { if (context.seed === undefined) throw Error('glitch and vhs need context.seed'); return context.seed; };
const scale = (c: RGBA, k: number): RGBA => [c[0] * k, c[1] * k, c[2] * k, c[3]];

// ASCII character glyphs, ink by level at cell-local (a, b) = (u − 0.5, v − 0.5).
const disc = (a: number, b: number, r: number, x = 0, y = 0) => Math.hypot(a - x, b - y) <= r;
const dash = (a: number, b: number) => Math.abs(b) <= .09 && Math.abs(a) <= .35, bar = (a: number, b: number) => dash(b, a);
const cross = (a: number, b: number) => Math.abs(a - b) <= .09 || Math.abs(a + b) <= .09, plus = (a: number, b: number) => dash(a, b) || bar(a, b);
const glyphs: ((a: number, b: number) => number)[] = [
  () => 0, (a, b) => +disc(a, b, .08), (a, b) => +dash(a, b), (a, b) => +bar(a, b), (a, b) => +plus(a, b), (a, b) => +cross(a, b),
  (a, b) => +(plus(a, b) || cross(a, b)), (a, b) => +[a - .15, a + .15, b - .15, b + .15].some(v => Math.abs(v) <= .072),
  (a, b) => +(disc(a, b, .13, -.2, .22) || disc(a, b, .13, .2, -.22) || Math.abs(a + b) <= .09),
  (a, b) => { const d = Math.hypot(a, b); return d <= .1 ? .5 : d <= .42 ? 1 : 0; },
];

// Dither thresholds τ per cell and palettes (stored as 4-decimal fractions of the 8-bit codes).
const M4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const palettes = [['000000', 'ffffff'], ['0f380f', '306230', '8bac0f', '9bbc0f'], ['000000', '55ffff', 'ff55ff', 'ffffff'], ['2b1d0e', '6b4226', 'c4956a', 'f5e6c8']]
  .map(p => p.map(hex => [0, 2, 4].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) / 255 * 1e4) / 1e4)));
function threshold(pattern: number, i: number, j: number, C: number): number {
  if (pattern === 0) return ([[0, 2], [3, 1]][j % 2][i % 2] + .5) / 4;
  if (pattern === 1) return (M4[j % 4][i % 4] + .5) / 16;
  if (pattern === 2) return (4 * M4[j % 4][i % 4] + (i % 8 >= 4 ? 2 : j % 8 >= 4 ? 3 : 0) + .5) / 64;
  const P = Math.max(2, Math.floor(C / 2)), nx = frac(i / P), ny = frac(j / P), ax = Math.abs(nx - .5), ay = Math.abs(ny - .5);
  if (pattern === 4) return ny;
  if (pattern === 5) return 2 * Math.min(ax, ay);
  if (pattern === 7) return 2 * Math.max(ax, ay);
  if (pattern === 8) { const a = frac(2 * nx) - .5, b = frac(2 * ny) - .5; return Math.sqrt(2 * (a * a + b * b)); } // √2·hypot, exactly 1 at a corner
  return Math.sqrt(2 * ((nx - .5) ** 2 + (ny - .5) ** 2)); // halftone (3) and dots (6) are identical
}

// Halftone value noise V, three-layer mean L3 and weighted sum O.
function V(x: number, y: number) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, wx = fx * fx * (3 - 2 * fx), wy = fy * fy * (3 - 2 * fy);
  const Q = (a: number, b: number) => h2(127.1 * a + 311.7 * b, 269.5 * a + 183.3 * b);
  return mix(mix(Q(i, j), Q(i + 1, j), wx), mix(Q(i, j + 1), Q(i + 1, j + 1), wx), wy);
}
const L3 = (x: number, y: number) => (V(x, y) + V(1.31 * x + .74 * y + 11.7, -.68 * x + 1.27 * y + 3.9) + V(-.57 * x + 1.43 * y - 7.4, 1.19 * x + .53 * y + 13.1)) / 3;
const O = (x: number, y: number) => .45 * L3(.73 * x + 5.31, .73 * y - 8.17) + .35 * L3(1.41 * x - .52 * y - 11.4, .67 * x + 1.28 * y + 4.6) + .2 * L3(-.88 * x + 1.19 * y + 8.2, -1.07 * x - .79 * y + 10.7);

// Halftone per-frame grid setup (§50.12 grid steps 1–6) for a W × H item.
export function halftoneSetup(W: number, H: number, p: Params) {
  const s = num(p, 'size', 50) / 100, R = clamp(num(p, 'radius', 125) / 100, 0, 2), kp = num(p, 'contrast', 40) / 100, original = !!p.originalColors;
  const hex = pick(p, 'grid', ['square', 'hex'], 'hex') === 1, type = pick(p, 'type', ['classic', 'gooey', 'holes', 'soft'], 'gooey');
  const N = [2, 6, 1, 6][type], n0 = mix(300, 7, s ** .7), g = type === 1 && hex ? .7 : 1, h = N / n0 * g, w = N / n0 * H / W * g;
  const odd = (k: number) => k % 2 ? k : k + 1, cols = odd(Math.max(1, Math.floor(1 / w + .5))), rows = odd(Math.max(1, Math.floor(1 / h + .5)));
  return { N, hex, type, cols, rows, w: 1 / cols, h: 1 / rows, kappa: original ? mix(.1, 4, kp * kp) : 15 * kp ** 1.5, b: original ? 2 * (R / 2) ** .3 : R, original };
}

export const kernels: Record<string, Kernel> = {
  vignette: (src, p) => {
    const a = num(p, 'amount', 50) / 100, m = num(p, 'midpoint', 50) / 100, r = num(p, 'roundness', 50) / 100, f = Math.max(num(p, 'feather', 50) / 100, .01);
    return (x, y) => { const dx = x - .5, dy = y - .5, d = mix(2 * Math.max(Math.abs(dx), Math.abs(dy)), 2 * Math.hypot(dx, dy), r); return scale(sample(src, x, y), 1 - a * smooth(m, m + f, d)); };
  },
  sharpen: (src, p) => {
    const k = num(p, 'amount', 50) / 100, r = num(p, 'radius', 1), s = .5 * r + .5, W = src.width, H = src.height;
    return (x, y) => {
      const c = sample(src, x, y), B = [0, 0, 0, 0]; let sum = 0;
      for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) { const w = Math.exp(-(i * i + j * j) / (2 * s * s)), t = sample(src, x + i * r / W, y + j * r / H); for (let q = 0; q < 4; q++) B[q] += w * t[q]; sum += w; }
      return [0, 1, 2].map(q => clamp(c[q] + (c[q] - B[q] / sum) * k)).concat(c[3]) as RGBA;
    };
  },
  glow: (src, p) => {
    const T = num(p, 'threshold', 70) / 100, g = 4 * num(p, 'intensity', 50) / 100, R = num(p, 'radius', 10), s = num(p, 'softness', 50) / 100 + .3;
    const nr = clamp(Math.trunc(num(p, 'rings', 4)), 1, 32), ns = clamp(Math.trunc(num(p, 'samplesPerRing', 16)), 4, 64), W = src.width;
    return (x, y) => {
      const c = sample(src, x, y), G = [0, 0, 0]; let sum = 0;
      const add = (t: RGBA, w: number) => { const b = smooth(T - .1, T + .1, y709(t)) * w; for (let q = 0; q < 3; q++) G[q] += t[q] * b; sum += w; };
      for (let k = 1; k <= nr; k++) { const w = Math.exp(-((k / nr) ** 2) / (2 * s * s)); for (let i = 0; i < ns; i++) { const a = 2 * Math.PI * i / ns + .5 * k; add(sample(src, x + Math.cos(a) * k * R / W, y + Math.sin(a) * k * R / W), w); } }
      add(c, 2);
      return [0, 1, 2].map(q => clamp(c[q] + g * G[q] / sum)).concat(c[3]) as RGBA;
    };
  },
  glitch: (src, p, context) => {
    const I = num(p, 'intensity', 30) / 100, rows = 20 / Math.max(num(p, 'blockSize', 50) / 100, .1), sp = num(p, 'rgbSplit', 5) / src.width, seed = seedOf(context), H = src.height;
    return (x, y) => {
      const r = Math.floor(y * rows), k = Math.floor(y * H);
      if (h1(r + 137 * seed) >= 1 - .5 * I) x += (2 * h1(r + 53 * seed) - 1) * .1 * I;
      if (h1(k + 7 * seed) >= 1 - .15 * I) x += .015 * I;
      const c = sample(src, x, y);
      return [sample(src, x + sp, y)[0], c[1], sample(src, x - sp, y)[2], c[3]];
    };
  },
  vhs: (src, p, context) => {
    const Ls = num(p, 'scanlines', 40) / 100, cb = num(p, 'colorBleed', 50) / 100, N = num(p, 'noise', 30) / 100, D = num(p, 'distortion', 20) / 100, seed = seedOf(context), W = src.width, H = src.height;
    return (x, y) => {
      const xw = x + Math.sin(50 * y + 10 * seed) * D * .005, s = .5 + .5 * Math.sin(Math.PI * y * H), n = 2 * hw(xw * W + seed, y * H + seed) - 1;
      const rgb = [sample(src, xw + 3 * cb / W, y)[0], sample(src, xw, y)[1], sample(src, xw - 1.5 * cb / W, y)[2]].map(v => v * (1 - .3 * Ls * s) + n * .15 * N), l = y709(rgb);
      return rgb.map(v => clamp(mix(v, l, .3 * cb))).concat(sample(src, x, y)[3]) as RGBA;
    };
  },
  pixelate: (src, p) => {
    const b = Math.max(num(p, 'blockSize', 8), 1), W = src.width, H = src.height;
    return (x, y) => sample(src, (Math.floor(x * W / b) + .5) * b / W, (Math.floor(y * H / b) + .5) * b / H);
  },
  ascii: (src, p) => {
    const C = Math.max(num(p, 'cellSize', 12), 2), ramp = pick(p, 'ramp', ['characters', 'blocks', 'dots'], 'characters'), source = pick(p, 'colorMode', ['mono', 'source'], 'mono') === 1;
    const F = colour(p.monoColor ?? 'rgba(255,255,255,1)'), Bg = colour(p.bgColor ?? 'rgba(0,0,0,1)'), kc = Math.max(num(p, 'contrast', 100) / 100, .01), n = ramp ? 5 : 10, W = src.width, H = src.height;
    return (x, y) => {
      const i = Math.floor(x * W / C), j = Math.floor(y * H / C), s = sample(src, (i + .5) * C / W, (j + .5) * C / H), u = x * W / C - i, v = y * H / C - j;
      const l = Math.min(Math.floor(clamp((y601(s) - .5) * kc + .5) * n), n - 1), a = u - .5, b = v - .5;
      const k = ramp === 0 ? glyphs[l](a, b) : ramp === 1 ? +(v >= 1 - l / 4) : +(l >= 1 && Math.hypot(a, b) <= .18 + .13 * (l - 1));
      const fg: RGBA = source ? [s[0], s[1], s[2], 1] : F, out = Bg.map((q, m) => mix(q, fg[m], k)) as RGBA;
      out[3] *= s[3]; return out;
    };
  },
  'edge-detection': (src, p) => {
    const ss = num(p, 'strength', 100) / 100, t = num(p, 'threshold', 10) / 100, mu = num(p, 'mix', 100) / 100, dx = 1 / src.width, dy = 1 / src.height;
    return (x, y) => {
      const c = sample(src, x, y), l = (i: number, j: number) => y709(sample(src, x + i * dx, y + j * dy));
      const gx = l(1, 1) + 2 * l(1, 0) + l(1, -1) - l(-1, 1) - 2 * l(-1, 0) - l(-1, -1), gy = l(-1, -1) + 2 * l(0, -1) + l(1, -1) - l(-1, 1) - 2 * l(0, 1) - l(1, 1);
      const e = clamp(smooth(t, t + .05, Math.hypot(gx, gy) * ss));
      return [mix(c[0], e, mu), mix(c[1], e, mu), mix(c[2], e, mu), c[3]];
    };
  },
  scanlines: (src, p, context) => {
    const D = num(p, 'density', 5), O = num(p, 'opacity', 30) / 100, o = context.timeS * num(p, 'speed', 0) / 20 * .1;
    return (x, y) => scale(sample(src, x, y), 1 - O * (1 - (.5 + .5 * Math.sin(100 * D * (y + o)))));
  },
  'film-grain': (src, p, context) => {
    const a = num(p, 'amount', 30) / 100, g = 100 / Math.max(.003 * num(p, 'size', 50), .001), t = context.timeS * num(p, 'speed', 100) / 100;
    return (x, y) => { const c = sample(src, x, y), n = (2 * h2(x * g + t * .1, y * g + t * .07) - 1) * a * (1 - .5 * y709(c)); return [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n), c[3]]; };
  },
  dither: (src, p) => {
    const C = Math.max(num(p, 'cellSize', 8), 1), th = num(p, 'angle', 45) * Math.PI / 180, sc = num(p, 'scale', 100), ox = num(p, 'offsetX', 0), oy = num(p, 'offsetY', 0);
    const pattern = pick(p, 'pattern', ['bayer2', 'bayer4', 'bayer8', 'halftone', 'lines', 'crosses', 'dots', 'grid', 'scales'], 'bayer4'), mode = pick(p, 'mode', ['image', 'linear', 'radial'], 'image');
    const scaled = pick(p, 'style', ['threshold', 'scaled'], 'threshold') === 1, shape = pick(p, 'shape', ['circle', 'square', 'diamond'], 'square'), pal = palettes[pick(p, 'palette', ['bw', 'gameboy', 'cga', 'sepia'], 'gameboy')];
    const W = src.width, H = src.height, Gx = Math.max(1, Math.ceil(W / C)), Gy = Math.max(1, Math.ceil(H / C)), aa = Math.max(1 / C, .003);
    return (x, y) => {
      const c = sample(src, x, y); if (c[3] <= 1e-4) return [0, 0, 0, 0];
      const cx = x * W / C, cy = y * H / C, i = Math.floor(cx), j = Math.floor(cy), u = cx - i, v = cy - j; let sy = 0, sa = 0;
      for (const [du, dv] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) { const t = sample(src, clamp((i + du) * C / W, .5 / W, 1 - .5 / W), clamp((j + dv) * C / H, .5 / H, 1 - .5 / H)); sy += y601(t) * t[3]; sa += t[3]; }
      let b = sa <= 1e-4 ? 0 : sy / sa;
      if (mode === 1) b = clamp(.7 * b + .3 * (i / Gx * Math.cos(th) + j / Gy * Math.sin(th)));
      if (mode === 2) b = clamp(.7 * b + .3 * Math.hypot(i / Gx - .5 - ox / 100, j / Gy - .5 - oy / 100) * (sc / 100) * 2);
      const q = scaled ? b : clamp(b + (threshold(pattern, i, j, C) - .5) * .5), r = clamp(scaled ? 1 - b : 1);
      const fg = pal[pal.length === 2 ? +(q > .5) : q <= .25 ? 0 : q <= .5 ? 1 : q <= .75 ? 2 : 3], bg = pal[pal.length - 1];
      const qx = 2 * Math.abs(u - .5), qy = 2 * Math.abs(v - .5), mask = 1 - smooth(r, r + aa, shape === 0 ? Math.hypot(qx, qy) : shape === 1 ? Math.max(qx, qy) : qx + qy);
      return [mix(bg[0], fg[0], mask), mix(bg[1], fg[1], mask), mix(bg[2], fg[2], mask), c[3]];
    };
  },
  // Output is PREMULTIPLIED RGBA (§50.12 step 8), unlike every other effect here.
  halftone: (src, p) => {
    const W = src.width, H = src.height, { N, hex, type, w, h, kappa, b, original } = halftoneSetup(W, H, p), inverted = !!p.inverted;
    const gm = num(p, 'grainMixer', 20) / 100, go = num(p, 'grainOverlay', 20) / 100, gam = (num(p, 'grainSize', 50) / 100) ** .72, kg = mix(3200, 42, gam);
    const front = colour(p.colorFront ?? '#2b2b2b', '#2b2b2b'), back = colour(p.colorBack ?? '#f2f1e8', '#f2f1e8');
    return (x, y) => {
      const a0 = sample(src, x, y)[3]; if (a0 <= 1e-4) return [0, 0, 0, 0];
      const Px = (x - .5) / w, Py = (y - .5) / h, sum = [0, 0, 0]; let sm = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        let ox = i / N - .5; const oy = j / N - .5;
        if (hex) { const rho = N === 1 ? Math.floor(Py + .5) : j; if (type === 1) { if ((rho + i) % 2) continue; } else if (Math.abs(rho % 2) === 1) ox += .5 / N; }
        const Qx = Math.floor(Px + ox), Qy = Math.floor(Py + oy), fx = Px + ox - Qx, fy = Py + oy - Qy;
        const ux = clamp((Qx + .5 - ox) * w + .5, .5 / W, 1 - .5 / W), uy = clamp((Qy + .5 - oy) * h + .5, .5 / H, 1 - .5 / H), s = sample(src, ux, uy);
        let l = s[3] <= 1e-4 ? +inverted : y709(s.map(v => 1 / (1 + Math.exp(-kappa * (v - .5)))));
        if (s[3] > 1e-4 && inverted) l = 1 - l;
        if (gm > .001) {
          const k = mix(2600, 55, gam), dx = ux * k + 37 * ox + 21, dy = uy * k + 37 * oy - 14, k1 = mix(1.15, .2, gam), k2 = mix(2.1, .38, gam), k3 = mix(14, 4, gam);
          const p1 = O(dx * k1, dy * k1), p2 = L3(dx * k2 + fx * k3, dy * k2 + fy * k3), ew = 1 - Math.abs(2 * l - 1);
          l = clamp(l + (2 * p2 - 1) * (.08 + .32 * gm) * (.3 + .7 * ew) - smooth(.45, .85 - .2 * gm, p1) * gm * (.1 + .8 * ew));
        }
        const d = Math.hypot(fx - .5, fy - .5); let shape: number;
        if (type === 0) { const rr = .25 * b * (1 - l); shape = 1 - smooth(rr - .02, rr + .02, d); }
        else if (type === 1) shape = (1 - smooth(0, (hex ? .42 : .3) * b * (1 - l), d)) ** (2 + b);
        else if (type === 2) { const rh = .75 * b * (1 - l), rm = rh - .5 * Math.floor(rh / .5), disc = 1 - smooth(rm - .02, rm + .02, d); shape = rh < .5 ? disc : 1 - disc; }
        else shape = (1 - clamp(d / (.5 * clamp(b) * (1 - l)))) ** (4 + 3 * (1 - clamp(b / 2)));
        const m = shape * s[3]; sm += m; for (let q = 0; q < 3; q++) sum[q] += m * s[q] * s[3];
      }
      let F = type === 1 ? smooth(.42, .58, sm) : type === 3 ? sm : Math.min(1, sm);
      const Gx = x * kg + 13.1, Gy = y * kg * H / W - 9.7, e = clamp(1 - Math.abs(2 * F - 1)) ** .55, kf = mix(.95, .16, gam), kd = mix(1.9, .28, gam), ko = mix(.9, .14, gam);
      F = clamp(F + (2 * L3(Gx * kd - 17.3, Gy * kd + 6.4) - 1) * e * gm * .24 - e * smooth(.42, .9, O(Gx * kf, Gy * kf)) * gm * (.35 + 1.75 * gm));
      let A = original ? sm / Math.max(sm, 1e-4) * F : front[3] * F;
      const Cc = [0, 1, 2].map(q => (original ? sum[q] / Math.max(sm, 1e-4) : front[q] * front[3]) * F + back[q] * back[3] * (1 - A));
      A += back[3] * (1 - A);
      const y2 = 2 * O(Gx * ko, Gy * ko) ** 1.3 - 1, gv = (go * Math.abs(y2)) ** .8;
      return Cc.map(v => clamp(mix(v, y2 >= 0 ? 1 : 0, gv / 2)) * a0).concat(clamp(A + gv / 2) * a0) as RGBA;
    };
  },
};

export const effects: Record<string, Effect> = Object.fromEntries(Object.entries(kernels).map(([id, kernel]) => [id, (src: Image, p: Params, context: EffectContext) => {
  const at = kernel(src, p, context); return mapPixels(src, (_, x, y) => at(x, y));
}]));
