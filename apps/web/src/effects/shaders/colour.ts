// SPDX-License-Identifier: AGPL-3.0-only
// Colour kernels (part 4 §49.1-§49.20), WGSL subset of dsl.ts. Each mirrors parity/oracle/colour.ts operation for
// operation. Aux textures: curves = 256 × 1 RGBA8 table; lut = 1089 × 33 (column g·33 + r, row b); bg-removal = the
// matte, top row first. Recolor setup (OKLab of base and target, rotation, scale) arrives CPU-precomputed in $x.

/** §49.7 steps 1-4: the hue/saturation/luma key (secondary-qualifier and retouch share the keys). */
const QUALIFY = `
fn bandw(v: f32, lo: f32, hi: f32, soft: f32) -> f32 {
  let a: f32 = min(lo, hi);
  let b: f32 = max(lo, hi);
  let f: f32 = max(soft, 1e-4);
  return smoothq(a - f, a, v) * (1.0 - smoothq(b, b + f, v));
}
fn qualify(c: vec3f) -> f32 {
  let q: vec3f = hsv(c);
  let delta: f32 = abs(q.x - fract($hueCenter / 360.0));
  let w: f32 = clamp($hueWidth / 360.0, 0.0, 0.5);
  let f: f32 = max($hueSoftness / 360.0, 1e-4);
  return (1.0 - smoothq(w, w + f, min(delta, 1.0 - delta))) * bandw(q.y, $satLow / 100.0, $satHigh / 100.0, $satSoftness / 100.0)
    * bandw(y601(c), $lumaLow / 100.0, $lumaHigh / 100.0, $lumaSoftness / 100.0);
}
`;

/** §49.7 step 5: the masked correction (secondary-qualifier and power-window). */
const CORRECT = `
fn correct(c: vec3f, m0: f32) -> vec3f {
  var m: f32 = m0;
  if ($?invertMask) { m = 1.0 - m0; }
  m = c01(m * $strength / 100.0);
  if ($?showMask) { return vec3f(m); }
  let k: vec3f = sat601(wb(c * exp2($exposure), $temperature / 100.0, $tint / 100.0), 1.0 + $saturation / 100.0);
  return c013(mx3(c, k, m));
}
`;

const POWZ3 = `
fn powz3(b: vec3f, e: f32) -> vec3f { return vec3f(powz(b.x, e), powz(b.y, e), powz(b.z, e)); }
`;

const COLOR_WHEELS = POWZ3 + `
fn wheelTint(c: vec3f, w: vec2f, m: f32) -> vec3f {
  let k: f32 = c01(w.y);
  if (k < 0.001) { return c; }
  let t: vec3f = fromHsv(vec3f(fract(-w.x / 360.0), 1.0, 1.0));
  return c * (1.0 + m * k * (t - 1.0));
}
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  var c: vec3f = src.xyz;
  let y0: f32 = y601(c);
  let ms: f32 = 1.0 - smoothq(0.0, 0.5, y0);
  let mh: f32 = smoothq(0.5, 1.0, y0);
  let mm: f32 = 1.0 - ms - mh;
  c = wheelTint(c, $shadowsWheel, ms);
  c = wheelTint(c, $midtonesWheel, mm);
  c = wheelTint(c, $highlightsWheel, mh);
  c = wheelTint(c, $offsetWheel, 1.0);
  c = wb(c, $temperature / 100.0, $tint / 100.0);
  c = (c * exp2($exposure) - $pivot) * $contrast + $pivot;
  if (abs($midDetail) > 0.001) {
    let l: f32 = y601(c);
    c = mx3(c, l + (c - l) * (1.0 + $midDetail / 100.0), mm);
  }
  c = powz3(max((c + $lift + $offset) * $gain, vec3f(0.0)), 1.0 / max($gamma, 0.05));
  c = (c - $blackPoint) / max($whitePoint - $blackPoint, 0.001);
  let s: f32 = $shadows / 100.0;
  let h: f32 = $highlights / 100.0;
  if ($toneCurve == 2.0) {
    let l: f32 = max(y709(c), 1e-4);
    let t: f32 = c01((l - 0.45) / 0.55);
    let r: f32 = c01(l / 0.55);
    var kh: f32 = -0.85 * h;
    var d: f32 = 0.0;
    if (h < 0.0) { kh = -1.8 * h; d = -0.15 * h; }
    var ks: f32 = 0.9 * s;
    if (s > 0.0) { ks = 2.0 * s; }
    let nx: f32 = l - 0.55 * t * t * (kh * (1.0 - t) + d) + 0.55 * ks * r * (1.0 - r) * (1.0 - r);
    var g: f32 = min(nx / l, 4.0);
    if (g > 1.0) { g = min(g, 1.0 / max(max(max(c.x, c.y), c.z), 1e-4)); }
    c = c * g;
  } else {
    c = c + s * ms + h * mh;
  }
  c = sat601(c, 1.0 + $saturation / 100.0);
  let boost: f32 = $colorBoost / 100.0;
  if (abs(boost) > 0.001) {
    let l: f32 = y601(c);
    let len: f32 = length(c - l);
    c = l + (c - l) * (1.0 + boost * (1.0 - c01(len)));
  }
  if (abs($hue - 50.0) > 0.001) {
    var q: vec3f = hsv(c);
    q.x = fract(q.x + ($hue - 50.0) / 100.0);
    c = fromHsv(q);
  }
  return vec4f(c013(sat601(c, c01($lumMix / 100.0))), src.w);
}
`;

const LEVELS = `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let span: f32 = max(($inputWhite - $inputBlack) / 100.0, 0.0001);
  let e: f32 = 1.0 / max($gamma, 0.001);
  let t: vec3f = c013((src.xyz - $inputBlack / 100.0) / span);
  let p: vec3f = vec3f(powz(t.x, e), powz(t.y, e), powz(t.z, e));
  return vec4f($outputBlack / 100.0 + ($outputWhite / 100.0 - $outputBlack / 100.0) * p, src.w);
}
`;

const CURVES = `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let pos: vec3f = c013(src.xyz) * 255.0;
  let i: vec3f = floor(pos);
  let f: vec3f = pos - i;
  let j: vec3f = min(i + 1.0, vec3f(255.0));
  let r: f32 = mx(tab(i.x, 0.0).x, tab(j.x, 0.0).x, f.x);
  let g: f32 = mx(tab(i.y, 0.0).y, tab(j.y, 0.0).y, f.y);
  let b: f32 = mx(tab(i.z, 0.0).z, tab(j.z, 0.0).z, f.z);
  return vec4f(r, g, b, src.w);
}
`;

const LUT = `
fn lget(r: f32, g: f32, b: f32) -> vec3f { return tab(g * 33.0 + r, b).xyz; }
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let p: vec3f = c013(src.xyz) * 32.0;
  let lo: vec3f = floor(p);
  let hi: vec3f = min(lo + 1.0, vec3f(32.0));
  let f: vec3f = p - lo;
  let s0: vec3f = mx3(mx3(lget(lo.x, lo.y, lo.z), lget(hi.x, lo.y, lo.z), f.x), mx3(lget(lo.x, hi.y, lo.z), lget(hi.x, hi.y, lo.z), f.x), f.y);
  let s1: vec3f = mx3(mx3(lget(lo.x, lo.y, hi.z), lget(hi.x, lo.y, hi.z), f.x), mx3(lget(lo.x, hi.y, hi.z), lget(hi.x, hi.y, hi.z), f.x), f.y);
  return vec4f(mx3(src.xyz, mx3(s0, s1, f.z), c01($blend / 100.0)), src.w);
}
`;

const hslBand = (name: string, centre: number, left: number, right: number) =>
  `  sh = sh + hslw(q.x, ${centre}.0, ${left}.0, ${right}.0) * vec3f($${name}Hue, $${name}Saturation, $${name}Luminance);\n`;

const HSL = `
fn hslw(h0: f32, v: f32, wl: f32, wr: f32) -> f32 {
  let delta: f32 = tmodf(h0 - v + 540.0, 360.0) - 180.0;
  var width: f32 = wr;
  if (delta < 0.0) { width = wl; }
  return c01(1.0 - abs(delta) / width);
}
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let q: vec3f = hsl(c013(src.xyz));
  var sh: vec3f = vec3f(0.0);
` + hslBand('red', 0, 60, 30) + hslBand('orange', 30, 30, 30) + hslBand('yellow', 60, 30, 60) + hslBand('green', 120, 60, 60)
  + hslBand('aqua', 180, 60, 60) + hslBand('blue', 240, 60, 30) + hslBand('purple', 270, 30, 30) + hslBand('magenta', 300, 30, 60) + `
  let s: f32 = c01(q.y * (1.0 + sh.y / 100.0));
  let l: f32 = c01(q.z + sh.z / 100.0 * 0.5 * q.y * (1.0 - abs(2.0 * q.z - 1.0)));
  if (s < 1e-5) { return vec4f(l, l, l, src.w); }
  let hh: f32 = tmodf(tmodf(q.x + 0.3 * sh.x * q.y, 360.0) + 360.0, 360.0);
  return vec4f(fromHsl(vec3f(hh, s, l)), src.w);
}
`;

const SECONDARY_QUALIFIER = QUALIFY + CORRECT + `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  return vec4f(correct(src.xyz, qualify(src.xyz)), src.w);
}
`;

const POWER_WINDOW = CORRECT + `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let aspect: f32 = max($W / max($H, 1.0), 1e-4);
  let ang: f32 = deg(-$rotation);
  let dx: f32 = (x - $centerX / 100.0) * aspect;
  let dy: f32 = y - $centerY / 100.0;
  let qx: f32 = (dx * pcos(ang) - dy * psin(ang)) / max($sizeX / 200.0 * aspect, 0.0001);
  let qy: f32 = (dx * psin(ang) + dy * pcos(ang)) / max($sizeY / 200.0, 0.0001);
  var d: f32 = hyp(qx, qy);
  if ($shape == 'rectangle') { d = max(abs(qx), abs(qy)); }
  return vec4f(correct(src.xyz, 1.0 - smoothq(1.0 - clamp($feather / 100.0, 0.001, 1.0), 1.0, d)), src.w);
}
`;

/** §49.9: 17 × 17 bilateral pass inside the skin key. */
const RETOUCH = QUALIFY + `
fn fx(x: f32, y: f32) -> vec4f {
  let col: f32 = floor(x * $W);
  let rfb: f32 = floor(y * $H);
  let c: vec4f = texel(col, rfb);
  let m: f32 = qualify(c.xyz);
  if ($?showMask) { return vec4f(m, m, m, c.w); }
  let g: f32 = m * $strength / 100.0;
  if (g < 1e-4) { return c; }
  let radius: f32 = max($radius / 100.0 * min($W, $H), 1.0);
  let sp: f32 = radius / 8.0;
  let ss: f32 = max(radius / 2.0, 1e-4);
  let sr: f32 = max($edgeTolerance / 100.0, 0.01);
  let l: f32 = y601(c.xyz);
  var sum: vec3f = vec3f(0.0);
  var total: f32 = 0.0;
  for (var j: i32 = -8; j <= 8; j = j + 1) {
    for (var i: i32 = -8; i <= 8; i = i + 1) {
      let ox: f32 = f32(i) * sp;
      let oy: f32 = f32(j) * sp;
      let tap: vec4f = samp((col + 0.5 + ox) / $W, (rfb + 0.5 + oy) / $H);
      let dl: f32 = y601(tap.xyz) - l;
      let w: f32 = exp(-(ox * ox + oy * oy) / (2.0 * ss * ss) - dl * dl / (2.0 * sr * sr));
      total = total + w;
      sum = sum + w * (tap.xyz - c.xyz);
    }
  }
  let keep: f32 = 1.0 - $detail / 100.0;
  return vec4f(mx3(c.xyz, c.xyz + sum / max(total, 1e-4) * keep, g), c.w);
}
`;

const POSTERIZE = `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let lv: f32 = max($levels, 2.0);
  return vec4f(c013(floor(src.xyz * lv + 0.5) / lv), src.w);
}
`;

/** §49.11: (Cb, Cr) distance key with spill reduction; output premultiplied. $keyColor is packed by keyColour(). */
const COLOR_KEY = `
fn chroma(c: vec3f) -> vec2f {
  let l: f32 = y601(c);
  return vec2f(0.564 * (c.z - l), 0.713 * (c.x - l));
}
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  var c: vec3f = src.xyz;
  let key: vec3f = $keyColor.xyz;
  let s: f32 = $similarity / 100.0 * 0.4;
  let alpha: f32 = smoothq(s, s + $smoothness / 100.0 * 0.2, length(chroma(c) - chroma(key)));
  let k: f32 = $spillReduction / 100.0;
  if (key.y > key.x && key.y > key.z) {
    let e: f32 = max(0.0, c.y - max(c.x, c.z)) * k;
    c = vec3f(c.x + e / 2.0, c.y - e, c.z + e / 2.0);
  } else if (key.z > key.x && key.z > key.y) {
    let e: f32 = max(0.0, c.z - max(c.x, c.y)) * k;
    c = vec3f(c.x + e / 2.0, c.y + e / 2.0, c.z - e);
  }
  return vec4f(c * alpha, src.w * alpha);
}
`;

const LUMA_KEY = `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let t: f32 = $threshold / 100.0;
  let s: f32 = max($softness / 100.0, 0.0001);
  let l: f32 = y709(src.xyz);
  var alpha: f32 = smoothq(t, t + s, l);
  if ($keyType == 'bright') { alpha = 1.0 - smoothq(t - s, t, l); }
  return vec4f(src.xyz * alpha, src.w * alpha);
}
`;

const GRAYSCALE = `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  return vec4f(sat601(src.xyz, 1.0 - $amount / 100.0), src.w);
}
`;

const SEPIA = `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let c: vec3f = src.xyz;
  let m: vec3f = vec3f(0.393 * c.x + 0.769 * c.y + 0.189 * c.z, 0.349 * c.x + 0.686 * c.y + 0.168 * c.z, 0.272 * c.x + 0.534 * c.y + 0.131 * c.z);
  return vec4f(c013(mx3(c, m, $amount / 100.0)), src.w);
}
`;

const THRESHOLD = `
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  var v: f32 = 0.0;
  if (y709(src.xyz) > $level / 100.0) { v = 1.0; }
  return vec4f(v, v, v, src.w);
}
`;

/** §49.17 retired Lumetri Color (renders existing instances only). */
const LUMETRI_COLOR = `
fn lwheel(c: vec3f, wh: vec2f, w: f32) -> vec3f {
  let a: f32 = deg(wh.x);
  let px: f32 = wh.y * pcos(a);
  let pz: f32 = wh.y * psin(a);
  return c + 0.5 * w * vec3f(px, -(px + pz) / 2.0, pz);
}
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  let t: f32 = $temperature / 100.0;
  let u: f32 = $tint / 100.0;
  var c: vec3f = c013(vec3f(src.x + 0.1 * t - 0.05 * u, src.y + 0.1 * u, src.z - 0.1 * t - 0.05 * u));
  c = (c * exp2($exposure) - 0.5) * (1.0 + $contrast / 100.0) + 0.5;
  var l: f32 = y709(c);
  let add: f32 = smoothq(0.5, 1.0, l) * $highlights / 100.0 * 0.5 + (1.0 - smoothq(0.0, 0.5, l)) * $shadows / 100.0 * 0.5
    + smoothq(0.7, 1.0, l) * $whites / 100.0 * 0.3 + (1.0 - smoothq(0.0, 0.3, l)) * $blacks / 100.0 * 0.3;
  c = c013(c + add);
  l = y709(c);
  let ms: f32 = 1.0 - smoothq(0.0, 0.4, l);
  let mh: f32 = smoothq(0.6, 1.0, l);
  c = lwheel(c, $shadowsWheel, ms);
  c = lwheel(c, $midtonesWheel, max(1.0 - ms - mh, 0.0));
  c = lwheel(c, $highlightsWheel, mh);
  c = c013(c);
  l = y709(c);
  c = l + (c - l) * $saturation / 100.0;
  let len: f32 = length(c - l);
  return vec4f(c013(l + (c - l) * (1.0 + $vibrance / 100.0 * (1.0 - len))), src.w);
}
`;

const recolorEntry = (o: number) =>
  `$x${o}, vec3f($x${o + 1}, $x${o + 2}, $x${o + 3}), vec3f($x${o + 4}, $x${o + 5}, $x${o + 6}), $x${o + 8}, $x${o + 9}, $x${o + 10}, $x${o + 11}, $x${o + 12}`;

/**
 * §49.19 Element Colors. Extras: x0 entry count (≤ 2), x1 active, x2..x5 chromaLo/Hi glossLo/Hi; entry i at x(8 + 16i):
 * kind (1 = color), base OKLab ×3, target OKLab ×3, base hue, chroma scale, rotation, clamped base L, clamped target L, same-L flag.
 */
const RECOLOR = `
fn rmove(lab: vec3f, kind: f32, base: vec3f, goal: vec3f, k: f32, ang: f32, b: f32, g: f32, same: f32) -> vec3f {
  var l: f32 = g + (lab.x - b) / (1.0 - b) * (1.0 - g);
  if (lab.x <= b) { l = lab.x / b * g; }
  if (same > 0.5) { l = lab.x; }
  if (kind < 0.5) { return vec3f(l, lab.y + (goal.y - base.y), lab.z + (goal.z - base.z)); }
  return vec3f(l, k * (lab.y * pcos(ang) - lab.z * psin(ang)), k * (lab.y * psin(ang) + lab.z * pcos(ang)));
}
fn outg(v: vec3f) -> bool {
  return v.x < -0.0001 || v.y < -0.0001 || v.z < -0.0001 || v.x > 1.0001 || v.y > 1.0001 || v.z > 1.0001;
}
fn fx(x: f32, y: f32) -> vec4f {
  let src: vec4f = here(x, y);
  if ($x1 < 0.5 || src.w <= 0.0) { return src; }
  let lab: vec3f = oklab(c013(src.xyz));
  let colored: f32 = smoothq($x2, $x3, hyp(lab.y, lab.z));
  let neutral: f32 = (1.0 - colored) * (1.0 - smoothq($x4, $x5, lab.x));
  var w0: f32 = 0.0;
  var w1: f32 = 0.0;
  if ($x0 > 0.5) {
    w0 = neutral;
    if ($x8 > 0.5) { w0 = colored; }
  }
  if ($x0 > 1.5) {
    w1 = neutral;
    if ($x24 > 0.5) { w1 = colored; }
    if ($x8 > 0.5 && $x24 > 0.5) {
      let hue: f32 = atan2s(lab.z, lab.y);
      let d0: f32 = abs(atan2s(psin(hue - $x15), pcos(hue - $x15)));
      let d1: f32 = abs(atan2s(psin(hue - $x31), pcos(hue - $x31)));
      let share: f32 = d1 * d1 / max(d0 * d0 + d1 * d1, 1e-6);
      w0 = colored * share;
      w1 = colored * (1.0 - share);
    }
  }
  var res: vec3f = lab * (1.0 - (w0 + w1));
  if ($x0 > 0.5) { res = res + rmove(lab, ${recolorEntry(8)}) * w0; }
  if ($x0 > 1.5) { res = res + rmove(lab, ${recolorEntry(24)}) * w1; }
  res.x = c01(res.x);
  var rgb: vec3f = labLinear(res);
  if (outg(rgb)) {
    var lo: f32 = 0.0;
    var hi: f32 = 1.0;
    for (var i: i32 = 0; i < 7; i = i + 1) {
      let k: f32 = (lo + hi) / 2.0;
      if (outg(labLinear(vec3f(res.x, res.y * k, res.z * k)))) { hi = k; } else { lo = k; }
    }
    rgb = labLinear(vec3f(res.x, res.y * lo, res.z * lo));
  }
  let o: vec3f = c013(rgb);
  return vec4f(srgb1(o.x), srgb1(o.y), srgb1(o.z), src.w);
}
`;

/** §49.20 legacy matte multiply (premultiplied output); the matte is the aux texture, sampled bilinearly. */
const BG_REMOVAL = `
fn fx(x: f32, y: f32) -> vec4f { return here(x, y) * auxsamp(x, y).w; }
`;

export const COLOUR_KERNELS: Record<string, string> = {
  'color-wheels': COLOR_WHEELS, levels: LEVELS, curves: CURVES, lut: LUT, hsl: HSL,
  'secondary-qualifier': SECONDARY_QUALIFIER, 'power-window': POWER_WINDOW, retouch: RETOUCH, posterize: POSTERIZE,
  'color-key': COLOR_KEY, 'luma-key': LUMA_KEY, grayscale: GRAYSCALE, sepia: SEPIA, threshold: THRESHOLD,
  'lumetri-color': LUMETRI_COLOR, recolor: RECOLOR, 'bg-removal': BG_REMOVAL,
};
