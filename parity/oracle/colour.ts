// SPDX-License-Identifier: AGPL-3.0-only
// CPU float oracle of the colour effects, findings part 4 §49 (export / WebGL path, y up).
// Missing parameters take the effect parameter inventory defaults. Keyers (color-key,
// luma-key, bg-removal) write premultiplied (RGB·α, A·α) as Xapp does (§48.1 0.4).
import { clamp, mix, smooth, frac, y601, y709, rgbMap, hsv, fromHsv, hsl, fromHsl, sat, wb, colour, oklab, labLinear, srgb, type RGB, type RGBA, type Params } from './math';
import { mapPixels, sample, texel, type Effect, type Image } from './image';
const n = (p: Params, key: string, fallback: number) => typeof p?.[key] === 'number' && Number.isFinite(p[key]) ? p[key] : fallback;
const window = (v: number, lo: number, hi: number, soft: number) => smooth(Math.min(lo, hi) - Math.max(soft, 1e-4), Math.min(lo, hi), v) * (1 - smooth(Math.max(lo, hi), Math.max(lo, hi) + Math.max(soft, 1e-4), v));
const SECONDARY: Record<string, number> = { hueCenter: 0, hueWidth: 35, hueSoftness: 20, satLow: 0, satHigh: 100, satSoftness: 10, lumaLow: 0, lumaHigh: 100, lumaSoftness: 10 };
const SKIN: Record<string, number> = { hueCenter: 20, hueWidth: 28, hueSoftness: 24, satLow: 8, satHigh: 85, satSoftness: 8, lumaLow: 10, lumaHigh: 92, lumaSoftness: 10 };
// §49.7 mask steps 1–4 (no invert, no strength); d = the effect's inventory defaults.
export function qualifier(c: RGB, p: Params = {}, d = SECONDARY): number {
  const q = (key: string) => n(p, key, d[key]), [h, s] = hsv(c), delta = Math.abs(h - frac(q('hueCenter') / 360));
  const w = clamp(q('hueWidth') / 360, 0, .5), f = Math.max(q('hueSoftness') / 360, 1e-4);
  return (1 - smooth(w, w + f, Math.min(delta, 1 - delta))) * window(s, q('satLow') / 100, q('satHigh') / 100, q('satSoftness') / 100) * window(y601(c), q('lumaLow') / 100, q('lumaHigh') / 100, q('lumaSoftness') / 100);
}
function correction(c: RGB, mask: number, p: Params): RGB {
  mask = clamp((p.invertMask ? 1 - mask : mask) * n(p, 'strength', 100) / 100);
  if (p.showMask) return [mask, mask, mask];
  const k = sat(wb(rgbMap(c, v => v * 2 ** n(p, 'exposure', 0)), n(p, 'temperature', 0) / 100, n(p, 'tint', 0) / 100), 1 + n(p, 'saturation', 0) / 100);
  return rgbMap(c, (v, i) => clamp(mix(v, k[i], mask)));
}
// toneCurve: definition default 1 (§49.2 Inputs); instances created by the current build store 2.
export function wheels(input: RGB, p: Params = {}): RGB {
  let c = [...input] as RGB;
  const y0 = y601(c), ms = 1 - smooth(0, .5, y0), mh = smooth(.5, 1, y0), mm = 1 - ms - mh;
  for (const [key, mask] of [['shadowsWheel', ms], ['midtonesWheel', mm], ['highlightsWheel', mh], ['offsetWheel', 1]] as const) {
    const k = clamp(n(p[key], 'distance', 0));
    if (k >= .001) { const t = fromHsv([frac(-n(p[key], 'angle', 0) / 360), 1, 1]); c = rgbMap(c, (v, i) => v * (1 + mask * k * (t[i] - 1))); }
  }
  c = wb(c, n(p, 'temperature', 0) / 100, n(p, 'tint', 0) / 100);
  const pivot = n(p, 'pivot', .5);
  c = rgbMap(c, v => (v * 2 ** n(p, 'exposure', 0) - pivot) * n(p, 'contrast', 1) + pivot);
  if (Math.abs(n(p, 'midDetail', 0)) > .001) { const y = y601(c); c = rgbMap(c, v => mix(v, y + (v - y) * (1 + p.midDetail / 100), mm)); }
  c = rgbMap(c, v => Math.max((v + n(p, 'lift', 0) + n(p, 'offset', 0)) * n(p, 'gain', 1), 0) ** (1 / Math.max(n(p, 'gamma', 1), .05)));
  c = rgbMap(c, v => (v - n(p, 'blackPoint', 0)) / Math.max(n(p, 'whitePoint', 1) - n(p, 'blackPoint', 0), .001));
  const s = n(p, 'shadows', 0) / 100, h = n(p, 'highlights', 0) / 100;
  if (n(p, 'toneCurve', 1) === 2) {
    const y = Math.max(y709(c), 1e-4), t = clamp((y - .45) / .55), r = clamp(y / .55);
    const kh = h < 0 ? 1.8 * -h : -.85 * h, d = h < 0 ? .15 * -h : 0, ks = s > 0 ? 2 * s : .9 * s;
    const next = y - .55 * t * t * (kh * (1 - t) + d) + .55 * ks * r * (1 - r) ** 2;
    let g = Math.min(next / y, 4); if (g > 1) g = Math.min(g, 1 / Math.max(...c, 1e-4)); c = rgbMap(c, v => v * g);
  } else c = rgbMap(c, v => v + s * ms + h * mh);
  c = sat(c, 1 + n(p, 'saturation', 0) / 100);
  const boost = n(p, 'colorBoost', 0) / 100;
  if (Math.abs(boost) > .001) { const y = y601(c), length = Math.hypot(...c.map(v => v - y)); c = rgbMap(c, v => y + (v - y) * (1 + boost * (1 - clamp(length)))); }
  if (Math.abs(n(p, 'hue', 50) - 50) > .001) { const h = hsv(c); h[0] = frac(h[0] + (p.hue - 50) / 100); c = fromHsv(h); }
  return rgbMap(sat(c, clamp(n(p, 'lumMix', 100) / 100)), v => clamp(v));
}
// §49.3 steps 2–3: normalise, then monotone cubic Hermite (Fritsch–Carlson).
export function curve(input: [number, number][], x: number): number {
  const points: [number, number][] = [];
  for (const q of input.map(([x, y]) => [clamp(x), clamp(y)] as [number, number]).sort((a, b) => a[0] - b[0])) if (!points.length || q[0] - points.at(-1)![0] >= .0005) points.push(q);
  if (points[0][0] > .0001) points.unshift([0, points[0][1]]); else points[0][0] = 0;
  if (points.at(-1)![0] < .9999) points.push([1, points.at(-1)![1]]); else points.at(-1)![0] = 1;
  const d = points.slice(1).map((p, i) => (p[1] - points[i][1]) / Math.max(p[0] - points[i][0], 1e-6));
  const m = points.map((_, i) => i === 0 ? d[0] : i === points.length - 1 ? d.at(-1)! : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  d.forEach((v, i) => { if (Math.abs(v) < 1e-6) m[i] = m[i + 1] = 0; else { const q = (m[i] / v) ** 2 + (m[i + 1] / v) ** 2; if (q > 9) { const k = 3 / Math.sqrt(q); m[i] *= k; m[i + 1] *= k; } } });
  if (x <= 0) return points[0][1]; if (x >= 1) return points.at(-1)![1];
  const i = Math.max(0, points.findIndex((p, i) => i < points.length - 1 && x >= p[0] && x <= points[i + 1][0]));
  const w = points[i + 1][0] - points[i][0], t = (x - points[i][0]) / w;
  return clamp((2 * t ** 3 - 3 * t * t + 1) * points[i][1] + (t ** 3 - 2 * t * t + t) * w * m[i] + (-2 * t ** 3 + 3 * t * t) * points[i + 1][1] + (t ** 3 - t * t) * w * m[i + 1]);
}
// §49.3 steps 1 and 4: the 256-entry 8-bit RGB table (each colour curve applied to the master output).
export function curvesTable(p: Params = {}): number[][] {
  const points = (ch: string): [number, number][] => {
    let sx = clamp(n(p, ch + 'ShadowX', .25), .02, .98), hx = clamp(n(p, ch + 'HighlightX', .75), .02, .98);
    if (sx > hx) [sx, hx] = [hx, sx]; if (hx - sx < .04) { const m = clamp((hx + sx) / 2, .04, .96); sx = m - .02; hx = m + .02; }
    const mid: [number, number][] = p[ch + 'MidOn'] === true && hx - sx >= .08 ? [[clamp(n(p, ch + 'MidX', .5), sx + .04, hx - .04), n(p, ch + 'MidY', .5)]] : [];
    return [[0, n(p, ch + 'BlackY', 0)], [sx, n(p, ch + 'ShadowY', .25)], ...mid, [hx, n(p, ch + 'HighlightY', .75)], [1, n(p, ch + 'WhiteY', 1)]];
  };
  const master = points('master'), rgb = ['red', 'green', 'blue'].map(points);
  return Array.from({ length: 256 }, (_, i) => { const m = curve(master, i / 255); return rgb.map(pts => Math.round(255 * curve(pts, m))); });
}
export const curves = (c: RGB, p: Params = {}, table = curvesTable(p)): RGB => rgbMap(c, (v, ch) => { const pos = clamp(v) * 255, i = Math.floor(pos); return mix(table[i][ch], table[Math.min(i + 1, 255)][ch], pos - i) / 255; });
let identity: Uint8Array | undefined;
// §49.4: `lutData` = base64 of the 33³ RGBA8 table; missing or wrong length → near-identity table.
export function lutTable(data?: unknown): Uint8Array {
  if (typeof data === 'string' && data) try { const table = Uint8Array.from(atob(data), ch => ch.charCodeAt(0)); if (table.length === 33 ** 3 * 4) return table; } catch { /* bad payload */ }
  if (!identity) { identity = new Uint8Array(33 ** 3 * 4); for (let b = 0; b < 33; b++) for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) identity.set([Math.round(r * 255 / 32), Math.round(g * 255 / 32), Math.round(b * 255 / 32), 255], ((b * 33 + g) * 33 + r) * 4); }
  return identity;
}
export function lut(c: RGB, table = lutTable(), blend = 100): RGB {
  const p = c.map(v => clamp(v) * 32), lo = p.map(Math.floor), hi = lo.map(v => Math.min(v + 1, 32)), f = p.map((v, i) => v - lo[i]);
  return rgbMap(c, (v, ch) => { const get = (r: number, g: number, b: number) => table[((b * 33 + g) * 33 + r) * 4 + ch] / 255; const slice = (b: number) => mix(mix(get(lo[0], lo[1], b), get(hi[0], lo[1], b), f[0]), mix(get(lo[0], hi[1], b), get(hi[0], hi[1], b), f[0]), f[1]); return mix(v, mix(slice(lo[2]), slice(hi[2]), f[2]), clamp(blend / 100)); });
}
// §49.4 .cube import and resample to the fixed 33³ RGBA8 grid (red fastest, then green, then blue).
export function importCube(text: string): Uint8Array {
  let size = 0, dimension = 0, min = [0, 0, 0], max = [1, 1, 1]; const data: number[][] = [];
  for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    const [key, ...values] = line.split(/\s+/);
    if (key === 'LUT_3D_SIZE' || key === 'LUT_1D_SIZE') { if (size) throw Error('Duplicate LUT size'); dimension = key === 'LUT_3D_SIZE' ? 3 : 1; size = Number(values[0]); if (!Number.isInteger(size) || size < 2 || size > (dimension === 3 ? 129 : 65536)) throw Error('Invalid LUT size'); }
    else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') { const v = values.map(Number); if (v.length !== 3 || !v.every(Number.isFinite)) throw Error('Invalid LUT domain'); if (key === 'DOMAIN_MIN') min = v; else max = v; }
    else if (/^[+\-.\d]/.test(key)) { if (!size) throw Error('LUT data precedes size'); const v = [key, ...values].map(Number); if (v.length < 3 || !v.every(Number.isFinite)) throw Error('Invalid LUT entry'); data.push(v.slice(0, 3).map((v, i) => Math.round(255 * clamp(max[i] === min[i] ? 0 : (v - min[i]) / (max[i] - min[i]))))); }
  }
  if (!size || data.length !== size ** dimension) throw Error('LUT entry count mismatch');
  const out = new Uint8Array(33 ** 3 * 4);
  for (let b = 0; b < 33; b++) for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) {
    const pos = [r, g, b].map(v => v * (size - 1) / 32), lo = pos.map(Math.floor), hi = lo.map(v => Math.min(v + 1, size - 1)), f = pos.map((v, i) => v - lo[i]);
    const rgb = [0, 1, 2].map(ch => {
      if (dimension === 1) return Math.round(mix(data[lo[ch]][ch], data[hi[ch]][ch], f[ch]));
      const at = (x: number, y: number, z: number) => data[(z * size + y) * size + x][ch], alongR = (y: number, z: number) => mix(at(lo[0], y, z), at(hi[0], y, z), f[0]), alongG = (z: number) => mix(alongR(lo[1], z), alongR(hi[1], z), f[1]);
      return Math.round(mix(alongG(lo[2]), alongG(hi[2]), f[2]));
    });
    out.set([...rgb, 255], ((b * 33 + g) * 33 + r) * 4);
  }
  return out;
}
// §49.9, one output pixel (column, row counted up from the bottom) of the 17 × 17 bilateral pass.
export function retouchPixel(image: Image, column: number, row: number, p: Params = {}): RGBA {
  const c = texel(image, column, row), m = qualifier(c.slice(0, 3) as RGB, p, SKIN);
  if (p.showMask) return [m, m, m, c[3]];
  const g = m * n(p, 'strength', 0) / 100; if (g < 1e-4) return c;
  const radius = Math.max(n(p, 'radius', 1.5) / 100 * Math.min(image.width, image.height), 1), sp = radius / 8, ss = Math.max(radius / 2, 1e-4), sr = Math.max(n(p, 'edgeTolerance', 15) / 100, .01);
  const y = y601(c), sum = [0, 0, 0]; let total = 0;
  for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) {
    const tap = sample(image, (column + .5 + i * sp) / image.width, (row + .5 + j * sp) / image.height), w = Math.exp(-((i * sp) ** 2 + (j * sp) ** 2) / (2 * ss * ss) - (y601(tap) - y) ** 2 / (2 * sr * sr));
    total += w; for (let k = 0; k < 3; k++) sum[k] += w * (tap[k] - c[k]);
  }
  const keep = 1 - n(p, 'detail', 60) / 100;
  return [...rgbMap(c, (v, k) => mix(v, v + sum[k] / Math.max(total, 1e-4) * keep, g)), c[3]] as RGBA;
}
const chroma = (c: number[]) => { const y = y601(c); return [.564 * (c[2] - y), .713 * (c[0] - y)]; };
// §49.11 keyColor: rgb()/rgba() (alpha ignored), #rgb or #rrggbb; anything else (#rgba, #rrggbbaa, bare hex) → (0, 177, 64).
const keyColour = (v: unknown): RGB => colour(typeof v === 'string' && (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) || /^rgba?\(/.test(v)) ? v : '#00b140', '#00b140').slice(0, 3) as RGB;
// §49.11 step 2: distance between the pixel's and the key's (Cb, Cr).
export const keyDistance = (c: RGB, key: RGB) => { const a = chroma(c), b = chroma(key); return Math.hypot(a[0] - b[0], a[1] - b[1]); };
// §49.19 element data: palette [{ base, kind }], colors [target per entry]; band keys chromaLo/Hi, glossLo/Hi.
const entries = (p: Params) => (p.palette ?? []).slice(0, 2).map((e: any, i: number) => ({ kind: e.kind, base: colour(e.base).slice(0, 3) as RGB, goal: colour(p.colors?.[i], e.base).slice(0, 3) as RGB }));
// §49.19 trigger: the pass is added only if a target differs from its base after 8-bit rounding.
export const recolorActive = (p: Params) => entries(p).some((e: any) => e.base.some((v: number, k: number) => Math.round(v * 255) !== Math.round(e.goal[k] * 255)));
function weigh(c: RGB, p: Params): [RGB, number[]] {
  const lab = oklab(rgbMap(c, v => clamp(v))), list = entries(p);
  const colored = smooth(p.chromaLo ?? .025, p.chromaHi ?? .07, Math.hypot(lab[1], lab[2])), neutral = (1 - colored) * (1 - smooth(p.glossLo ?? 2, p.glossHi ?? 3, lab[0]));
  const weights = list.map((e: any) => e.kind === 'color' ? colored : neutral);
  if (list.length === 2 && list.every((e: any) => e.kind === 'color')) { const hue = Math.atan2(lab[2], lab[1]), d = list.map((e: any) => { const b = oklab(e.base), dh = hue - Math.atan2(b[2], b[1]); return Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))); }); const share = d[1] ** 2 / Math.max(d[0] ** 2 + d[1] ** 2, 1e-6); weights[0] = colored * share; weights[1] = colored * (1 - share); }
  return [lab, weights];
}
export const recolorWeights = (c: RGB, p: Params) => weigh(c, p)[1];
export function recolor(c: RGB, p: Params): RGB {
  const [lab, weights] = weigh(c, p), result = rgbMap(lab, v => v * (1 - weights.reduce((a, b) => a + b, 0)));
  entries(p).forEach((entry: any, i: number) => { const base = oklab(entry.base), goal = oklab(entry.goal), b = clamp(base[0], .02, .999), g = clamp(goal[0], .035, 1); const moved: RGB = [Math.abs(base[0] - goal[0]) < 1e-6 ? lab[0] : lab[0] <= b ? lab[0] / b * g : g + (lab[0] - b) / (1 - b) * (1 - g), lab[1], lab[2]];
    if (entry.kind !== 'color') { moved[1] += goal[1] - base[1]; moved[2] += goal[2] - base[2]; }
    else { const k = Math.hypot(goal[1], goal[2]) / Math.max(Math.hypot(base[1], base[2]), 1e-4), angle = Math.hypot(goal[1], goal[2]) < 1e-6 ? 0 : Math.atan2(goal[2], goal[1]) - Math.atan2(base[2], base[1]); moved[1] = k * (lab[1] * Math.cos(angle) - lab[2] * Math.sin(angle)); moved[2] = k * (lab[1] * Math.sin(angle) + lab[2] * Math.cos(angle)); }
    for (let k = 0; k < 3; k++) result[k] += moved[k] * weights[i]; });
  result[0] = clamp(result[0]); let rgb = labLinear(result);
  if (rgb.some(v => v < -.0001 || v > 1.0001)) { let lo = 0, hi = 1; for (let i = 0; i < 7; i++) { const k = (lo + hi) / 2, candidate = labLinear([result[0], result[1] * k, result[2] * k]); if (candidate.every(v => v >= -.0001 && v <= 1.0001)) lo = k; else hi = k; } rgb = labLinear([result[0], result[1] * lo, result[2] * lo]); }
  return rgbMap(rgb, v => srgb(clamp(v)));
}
// Per-pixel colour effects. position = [x, y, aspect] in export coordinates (y up), used by power-window only.
export function colourEffect(kind: string, input: RGBA, p: Params = {}, position: RGB = [.5, .5, 1]): RGBA {
  let c = input.slice(0, 3) as RGB, a = input[3];
  switch (kind) {
    case 'color-wheels': c = wheels(c, p); break;
    case 'curves': c = curves(c, p); break;
    case 'lut': c = lut(c, lutTable(p.lutData), n(p, 'blend', 100)); break;
    case 'levels': c = rgbMap(c, v => mix(n(p, 'outputBlack', 0) / 100, n(p, 'outputWhite', 100) / 100, clamp((v - n(p, 'inputBlack', 0) / 100) / Math.max((n(p, 'inputWhite', 100) - n(p, 'inputBlack', 0)) / 100, .0001)) ** (1 / Math.max(n(p, 'gamma', 1), .001)))); break;
    case 'hsl': { const h = hsl(rgbMap(c, v => clamp(v))), centres = [0, 30, 60, 120, 180, 240, 270, 300], names = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']; const shifts = [0, 0, 0]; centres.forEach((v, i) => { const delta = ((h[0] - v + 540) % 360) - 180; const width = delta < 0 ? (i ? v - centres[i - 1] : 60) : (i === 7 ? 60 : centres[i + 1] - v); const w = clamp(1 - Math.abs(delta) / width); shifts[0] += w * n(p, names[i] + 'Hue', 0); shifts[1] += w * n(p, names[i] + 'Saturation', 0); shifts[2] += w * n(p, names[i] + 'Luminance', 0); }); const s = clamp(h[1] * (1 + shifts[1] / 100)), l = clamp(h[2] + shifts[2] / 100 * .5 * h[1] * (1 - Math.abs(2 * h[2] - 1))); c = s < 1e-5 ? [l, l, l] : fromHsl([((h[0] + .3 * shifts[0] * h[1]) % 360 + 360) % 360, s, l]); break; }
    case 'secondary-qualifier': c = correction(c, qualifier(c, p), p); break;
    case 'power-window': { const [x, y, aspect] = position, angle = -n(p, 'rotation', 0) * Math.PI / 180; const dx = (x - n(p, 'centerX', 50) / 100) * aspect, dy = y - n(p, 'centerY', 50) / 100; const qx = (dx * Math.cos(angle) - dy * Math.sin(angle)) / Math.max(n(p, 'sizeX', 50) / 200 * aspect, .0001), qy = (dx * Math.sin(angle) + dy * Math.cos(angle)) / Math.max(n(p, 'sizeY', 50) / 200, .0001); const d = p.shape === 'rectangle' ? Math.max(Math.abs(qx), Math.abs(qy)) : Math.hypot(qx, qy); c = correction(c, 1 - smooth(1 - clamp(n(p, 'feather', 15) / 100, .001, 1), 1, d), p); break; }
    case 'posterize': c = rgbMap(c, v => clamp(Math.floor(v * Math.max(n(p, 'levels', 8), 2) + .5) / Math.max(n(p, 'levels', 8), 2))); break;
    case 'color-key': { const key = keyColour(p.keyColor), s = n(p, 'similarity', 40) / 100 * .4, alpha = smooth(s, s + n(p, 'smoothness', 10) / 100 * .2, keyDistance(c, key)); const dom: number = key[1] > key[0] && key[1] > key[2] ? 1 : key[2] > key[0] && key[2] > key[1] ? 2 : -1; if (dom >= 0) { const other = [0, 1, 2].filter(i => i !== dom), e = Math.max(0, c[dom] - Math.max(c[other[0]], c[other[1]])) * n(p, 'spillReduction', 50) / 100; c[dom] -= e; other.forEach(i => c[i] += e / 2); } c = rgbMap(c, v => v * alpha); a *= alpha; break; }
    case 'luma-key': { const t = n(p, 'threshold', 20) / 100, s = Math.max(n(p, 'softness', 10) / 100, .0001), alpha = p.keyType === 'bright' ? 1 - smooth(t - s, t, y709(c)) : smooth(t, t + s, y709(c)); c = rgbMap(c, v => v * alpha); a *= alpha; break; }
    case 'grayscale': c = sat(c, 1 - n(p, 'amount', 100) / 100); break;
    case 'sepia': { const rows = [[.393, .769, .189], [.349, .686, .168], [.272, .534, .131]], mapped = rows.map(r => r.reduce((v, w, i) => v + w * c[i], 0)); c = rgbMap(c, (v, i) => clamp(mix(v, mapped[i], n(p, 'amount', 100) / 100))); break; }
    case 'invert': c = rgbMap(c, v => mix(v, 1 - v, n(p, 'amount', 100) / 100)); break;
    case 'threshold': { const v = Number(y709(c) > n(p, 'level', 50) / 100); c = [v, v, v]; break; }
    // Retired: no inventory entry; defaults assumed neutral (saturation 100, everything else 0).
    case 'lumetri-color': { const t = n(p, 'temperature', 0) / 100, u = n(p, 'tint', 0) / 100; c = [clamp(c[0] + .1 * t - .05 * u), clamp(c[1] + .1 * u), clamp(c[2] - .1 * t - .05 * u)]; c = rgbMap(c, v => (v * 2 ** n(p, 'exposure', 0) - .5) * (1 + n(p, 'contrast', 0) / 100) + .5); let y = y709(c); const add = smooth(.5, 1, y) * n(p, 'highlights', 0) / 100 * .5 + (1 - smooth(0, .5, y)) * n(p, 'shadows', 0) / 100 * .5 + smooth(.7, 1, y) * n(p, 'whites', 0) / 100 * .3 + (1 - smooth(0, .3, y)) * n(p, 'blacks', 0) / 100 * .3; c = rgbMap(c, v => clamp(v + add)); y = y709(c); const ms = 1 - smooth(0, .4, y), mh = smooth(.6, 1, y); for (const [key, w] of [['shadowsWheel', ms], ['midtonesWheel', Math.max(1 - ms - mh, 0)], ['highlightsWheel', mh]] as const) { const angle = n(p[key], 'angle', 0) * Math.PI / 180, x = n(p[key], 'distance', 0) * Math.cos(angle), z = n(p[key], 'distance', 0) * Math.sin(angle); c = rgbMap(c, (v, i) => v + .5 * w * [x, -(x + z) / 2, z][i]); } c = rgbMap(c, v => clamp(v)); y = y709(c); c = rgbMap(c, v => y + (v - y) * n(p, 'saturation', 100) / 100); const len = Math.hypot(...c.map(v => v - y)); c = rgbMap(c, v => clamp(y + (v - y) * (1 + n(p, 'vibrance', 0) / 100 * (1 - len)))); break; }
    case 'recolor': if (a > 0) c = recolor(c, p); break;
    case 'bg-removal': c = rgbMap(c, v => v * p.mask); a *= p.mask; break;
    default: throw Error(`Colour oracle effect not implemented: ${kind}`);
  }
  return [...c.map(Math.fround), Math.fround(a)] as RGBA;
}
const pixels = (kind: string): Effect => (image, p) => mapPixels(image, (c, x, y) => colourEffect(kind, c, p, [x, y, Math.max(image.width / Math.max(image.height, 1), 1e-4)]));
// WebGL-chain colour effects, keyed by effect id. The chain runs these first, in stack order (§48.1 0.3).
export const effects: Record<string, Effect> = {
  'color-wheels': pixels('color-wheels'),
  curves: (image, p) => { const table = curvesTable(p); return mapPixels(image, c => [...curves(c.slice(0, 3) as RGB, p, table), c[3]] as RGBA); },
  lut: (image, p) => { const table = lutTable(p.lutData), blend = n(p, 'blend', 100); return mapPixels(image, c => [...lut(c.slice(0, 3) as RGB, table, blend), c[3]] as RGBA); },
  levels: pixels('levels'), hsl: pixels('hsl'), 'secondary-qualifier': pixels('secondary-qualifier'), 'power-window': pixels('power-window'),
  retouch: (image, p) => mapPixels(image, (_, x, y) => retouchPixel(image, Math.floor(x * image.width), Math.floor(y * image.height), p)),
  posterize: pixels('posterize'), 'color-key': pixels('color-key'), 'luma-key': pixels('luma-key'), grayscale: pixels('grayscale'), sepia: pixels('sepia'), threshold: pixels('threshold'),
  'lumetri-color': pixels('lumetri-color'),
  // Hidden; params = the item's element data. Put first in the chain by the renderer.
  recolor: (image, p, context) => recolorActive(p) ? pixels('recolor')(image, p, context) : mapPixels(image, c => c),
  // Hidden, legacy; params.mask = the per-frame matte Image, resampled bilinearly (its alpha is used).
  'bg-removal': (image, p) => { const mask = p.mask as Image | undefined; if (!mask) throw Error('bg-removal needs a mask image'); return mapPixels(image, (c, x, y) => colourEffect('bg-removal', c, { mask: sample(mask, x, y)[3] })); },
};
// CSS-chain colour effects: applied after every WebGL effect, whatever their stack position (§48.1 0.3).
export const cssFilters: Record<string, Effect> = { invert: pixels('invert') };
