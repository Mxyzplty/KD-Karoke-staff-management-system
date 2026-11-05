// SPDX-License-Identifier: AGPL-3.0-only
// Stylize kernels (part 4 §50), WGSL subset of dsl.ts, mirroring parity/oracle/stylize.ts operation for operation.
// $T is the item time in seconds, $SEED the per-render seed in [0, 1000). Per-frame setup that the oracle computes once
// (dither palette, halftone grid, the scanlines time offset reduced mod one line period) arrives CPU-precomputed in $x; see uniforms.ts.

const VIGNETTE = `
fn fx(x: f32, y: f32) -> vec4f {
  let a: f32 = $amount / 100.0;
  let m: f32 = $midpoint / 100.0;
  let f: f32 = max($feather / 100.0, 0.01);
  let dx: f32 = x - 0.5;
  let dy: f32 = y - 0.5;
  let d: f32 = mx(2.0 * max(abs(dx), abs(dy)), 2.0 * hyp(dx, dy), $roundness / 100.0);
  let s: vec4f = samp(x, y);
  return vec4f(s.xyz * (1.0 - a * smoothq(m, m + f, d)), s.w);
}
`;

const SHARPEN = `
fn fx(x: f32, y: f32) -> vec4f {
  let k: f32 = $amount / 100.0;
  let r: f32 = $radius;
  let s: f32 = 0.5 * r + 0.5;
  let c: vec4f = samp(x, y);
  var acc: vec4f = vec4f(0.0);
  var total: f32 = 0.0;
  for (var j: i32 = -3; j <= 3; j = j + 1) {
    for (var i: i32 = -3; i <= 3; i = i + 1) {
      let fi: f32 = f32(i);
      let fj: f32 = f32(j);
      let w: f32 = exp(-(fi * fi + fj * fj) / (2.0 * s * s));
      acc = acc + w * samp(x + fi * r / $W, y + fj * r / $H);
      total = total + w;
    }
  }
  return vec4f(c013(c.xyz + (c.xyz - acc.xyz / total) * k), c.w);
}
`;

const GLOW = `
fn fx(x: f32, y: f32) -> vec4f {
  let th: f32 = $threshold / 100.0;
  let g: f32 = 4.0 * $intensity / 100.0;
  let rr: f32 = $radius;
  let s: f32 = $softness / 100.0 + 0.3;
  let nr: i32 = i32(clamp(trunc($rings), 1.0, 32.0));
  let ns: i32 = i32(clamp(trunc($samplesPerRing), 4.0, 64.0));
  let c: vec4f = samp(x, y);
  var acc: vec3f = vec3f(0.0);
  var total: f32 = 0.0;
  for (var k: i32 = 1; k <= nr; k = k + 1) {
    let fk: f32 = f32(k);
    let q: f32 = fk / f32(nr);
    let w: f32 = exp(-(q * q) / (2.0 * s * s));
    for (var i: i32 = 0; i < ns; i = i + 1) {
      let a: f32 = 2.0 * 3.141592653589793 * f32(i) / f32(ns) + 0.5 * fk;
      let cs: vec2f = sc(a);
      let t: vec4f = samp(x + cs.y * fk * rr / $W, y + cs.x * fk * rr / $W);
      acc = acc + t.xyz * (smoothq(th - 0.1, th + 0.1, y709(t.xyz)) * w);
      total = total + w;
    }
  }
  acc = acc + c.xyz * (smoothq(th - 0.1, th + 0.1, y709(c.xyz)) * 2.0);
  total = total + 2.0;
  return vec4f(c013(c.xyz + g * acc / total), c.w);
}
`;

const GLITCH = `
fn fx(x: f32, y: f32) -> vec4f {
  let k: f32 = $intensity / 100.0;
  let rows: f32 = 20.0 / max($blockSize / 100.0, 0.1);
  let sp: f32 = $rgbSplit / $W;
  let r: f32 = floor(y * rows);
  let line: f32 = floor(y * $H);
  var u: f32 = x;
  if (h1(r + 137.0 * $SEED) >= 1.0 - 0.5 * k) { u = u + (2.0 * h1(r + 53.0 * $SEED) - 1.0) * 0.1 * k; }
  if (h1(line + 7.0 * $SEED) >= 1.0 - 0.15 * k) { u = u + 0.015 * k; }
  let c: vec4f = samp(u, y);
  return vec4f(samp(u + sp, y).x, c.y, samp(u - sp, y).z, c.w);
}
`;

const VHS = `
fn fx(x: f32, y: f32) -> vec4f {
  let ls: f32 = $scanlines / 100.0;
  let cb: f32 = $colorBleed / 100.0;
  let nz: f32 = $noise / 100.0;
  let dd: f32 = $distortion / 100.0;
  let xw: f32 = x + psin(50.0 * y + 10.0 * $SEED) * dd * 0.005;
  let s: f32 = 0.5 + 0.5 * psin(3.141592653589793 * y * $H);
  let n: f32 = 2.0 * hw(xw * $W + $SEED, y * $H + $SEED) - 1.0;
  let raw: vec3f = vec3f(samp(xw + 3.0 * cb / $W, y).x, samp(xw, y).y, samp(xw - 1.5 * cb / $W, y).z);
  let rgb: vec3f = raw * (1.0 - 0.3 * ls * s) + n * 0.15 * nz;
  let l: f32 = y709(rgb);
  return vec4f(c013(mx3(rgb, vec3f(l), 0.3 * cb)), samp(x, y).w);
}
`;

const PIXELATE = `
fn fx(x: f32, y: f32) -> vec4f {
  let b: f32 = max($blockSize, 1.0);
  return samp((floor(x * $W / b) + 0.5) * b / $W, (floor(y * $H / b) + 0.5) * b / $H);
}
`;

/** ASCII glyph ink by level at cell-local (a, b) = (u − 0.5, v − 0.5): the oracle's ten character shapes. */
const ASCII = `
fn gdisc(a: f32, b: f32, r: f32, px: f32, py: f32) -> bool { return hyp(a - px, b - py) <= r; }
fn gdash(a: f32, b: f32) -> bool { return abs(b) <= 0.09 && abs(a) <= 0.35; }
fn gplus(a: f32, b: f32) -> bool { return gdash(a, b) || gdash(b, a); }
fn gcross(a: f32, b: f32) -> bool { return abs(a - b) <= 0.09 || abs(a + b) <= 0.09; }
fn ink(b0: bool) -> f32 {
  if (b0) { return 1.0; }
  return 0.0;
}
fn glyph(l: f32, a: f32, b: f32) -> f32 {
  if (l < 0.5) { return 0.0; }
  if (l < 1.5) { return ink(gdisc(a, b, 0.08, 0.0, 0.0)); }
  if (l < 2.5) { return ink(gdash(a, b)); }
  if (l < 3.5) { return ink(gdash(b, a)); }
  if (l < 4.5) { return ink(gplus(a, b)); }
  if (l < 5.5) { return ink(gcross(a, b)); }
  if (l < 6.5) { return ink(gplus(a, b) || gcross(a, b)); }
  if (l < 7.5) { return ink(abs(a - 0.15) <= 0.072 || abs(a + 0.15) <= 0.072 || abs(b - 0.15) <= 0.072 || abs(b + 0.15) <= 0.072); }
  if (l < 8.5) { return ink(gdisc(a, b, 0.13, -0.2, 0.22) || gdisc(a, b, 0.13, 0.2, -0.22) || abs(a + b) <= 0.09); }
  let d: f32 = hyp(a, b);
  if (d <= 0.1) { return 0.5; }
  if (d <= 0.42) { return 1.0; }
  return 0.0;
}
fn fx(x: f32, y: f32) -> vec4f {
  let cs: f32 = max($cellSize, 2.0);
  let kc: f32 = max($contrast / 100.0, 0.01);
  var n: f32 = 5.0;
  if ($ramp == 'characters') { n = 10.0; }
  let i: f32 = floor(x * $W / cs);
  let j: f32 = floor(y * $H / cs);
  let s: vec4f = samp((i + 0.5) * cs / $W, (j + 0.5) * cs / $H);
  let u: f32 = x * $W / cs - i;
  let v: f32 = y * $H / cs - j;
  let l: f32 = min(floor(c01((y601(s.xyz) - 0.5) * kc + 0.5) * n), n - 1.0);
  let a: f32 = u - 0.5;
  let b: f32 = v - 0.5;
  var k: f32 = 0.0;
  if ($ramp == 'characters') {
    k = glyph(l, a, b);
  } else if ($ramp == 'blocks') {
    k = ink(v >= 1.0 - l / 4.0);
  } else {
    k = ink(l >= 1.0 && hyp(a, b) <= 0.18 + 0.13 * (l - 1.0));
  }
  var fg: vec4f = $monoColor;
  if ($colorMode == 'source') { fg = vec4f(s.xyz, 1.0); }
  var o: vec4f = mx4($bgColor, fg, k);
  o.w = o.w * s.w;
  return o;
}
`;

const EDGE_DETECTION = `
fn edl(x: f32, y: f32, i: f32, j: f32) -> f32 { return y709(samp(x + i * (1.0 / $W), y + j * (1.0 / $H)).xyz); }
fn fx(x: f32, y: f32) -> vec4f {
  let t: f32 = $threshold / 100.0;
  let mu: f32 = $mix / 100.0;
  let c: vec4f = samp(x, y);
  let gx: f32 = edl(x, y, 1.0, 1.0) + 2.0 * edl(x, y, 1.0, 0.0) + edl(x, y, 1.0, -1.0) - edl(x, y, -1.0, 1.0) - 2.0 * edl(x, y, -1.0, 0.0) - edl(x, y, -1.0, -1.0);
  let gy: f32 = edl(x, y, -1.0, -1.0) + 2.0 * edl(x, y, 0.0, -1.0) + edl(x, y, 1.0, -1.0) - edl(x, y, -1.0, 1.0) - 2.0 * edl(x, y, 0.0, 1.0) - edl(x, y, 1.0, 1.0);
  let e: f32 = c01(smoothq(t, t + 0.05, hyp(gx, gy) * $strength / 100.0));
  return vec4f(mx3(c.xyz, vec3f(e), mu), c.w);
}
`;

const SCANLINES = `
fn fx(x: f32, y: f32) -> vec4f {
  let s: vec4f = samp(x, y);
  return vec4f(s.xyz * (1.0 - $opacity / 100.0 * (1.0 - (0.5 + 0.5 * psin(100.0 * $density * (y + $x0))))), s.w);
}
`;

const FILM_GRAIN = `
fn fx(x: f32, y: f32) -> vec4f {
  let a: f32 = $amount / 100.0;
  let g: f32 = 100.0 / max(0.003 * $size, 0.001);
  let t: f32 = $T * $speed / 100.0;
  let c: vec4f = samp(x, y);
  let n: f32 = (2.0 * h2(x * g + t * 0.1, y * g + t * 0.07) - 1.0) * a * (1.0 - 0.5 * y709(c.xyz));
  return vec4f(c013(c.xyz + n), c.w);
}
`;

/**
 * §50.11. Extras: x0 palette size (2 or 4), palette colour k at x(1 + 3k)..x(3 + 3k) (4-decimal fractions).
 * Bayer matrices without arrays: M2(a, b) = 2·|a − b| + b, M4(i, j) = 4·M2(i mod 2, j mod 2) + M2(⌊i/2⌋ mod 2, ⌊j/2⌋ mod 2).
 * √2·hypot(a, b) is evaluated as sqrt(2(a² + b²)), so the spec constant τ = √2·hypot(.5, .5) is exactly 1 (f32 √2·length
 * gives 0.99999994).
 */
const DITHER = `
fn rt2h(a: f32, b: f32) -> f32 { return sqrt(2.0 * (a * a + b * b)); }
fn m2(a: f32, b: f32) -> f32 { return 2.0 * abs(a - b) + b; }
fn m4(i: f32, j: f32) -> f32 { return 4.0 * m2(fmodf(i, 2.0), fmodf(j, 2.0)) + m2(fmodf(floor(i / 2.0), 2.0), fmodf(floor(j / 2.0), 2.0)); }
fn dthr(i: f32, j: f32, cs: f32) -> f32 {
  if ($pattern == 'bayer2') { return (m2(fmodf(i, 2.0), fmodf(j, 2.0)) + 0.5) / 4.0; }
  if ($pattern == 'bayer4') { return (m4(i, j) + 0.5) / 16.0; }
  if ($pattern == 'bayer8') {
    var e: f32 = 0.0;
    if (fmodf(i, 8.0) >= 4.0) { e = 2.0; } else if (fmodf(j, 8.0) >= 4.0) { e = 3.0; }
    return (4.0 * m4(i, j) + e + 0.5) / 64.0;
  }
  let pp: f32 = max(2.0, floor(cs / 2.0));
  let nx: f32 = fract(i / pp);
  let ny: f32 = fract(j / pp);
  let ax: f32 = abs(nx - 0.5);
  let ay: f32 = abs(ny - 0.5);
  if ($pattern == 'lines') { return ny; }
  if ($pattern == 'crosses') { return 2.0 * min(ax, ay); }
  if ($pattern == 'grid') { return 2.0 * max(ax, ay); }
  if ($pattern == 'scales') { return rt2h(fract(2.0 * nx) - 0.5, fract(2.0 * ny) - 0.5); }
  return rt2h(nx - 0.5, ny - 0.5);
}
fn dpal(k: f32) -> vec3f {
  if (k < 0.5) { return vec3f($x1, $x2, $x3); }
  if (k < 1.5) { return vec3f($x4, $x5, $x6); }
  if (k < 2.5) { return vec3f($x7, $x8, $x9); }
  return vec3f($x10, $x11, $x12);
}
fn fx(x: f32, y: f32) -> vec4f {
  let c: vec4f = samp(x, y);
  if (c.w <= 1e-4) { return vec4f(0.0); }
  let cs: f32 = max($cellSize, 1.0);
  let th: f32 = deg($angle);
  let gx: f32 = max(1.0, ceil($W / cs));
  let gy: f32 = max(1.0, ceil($H / cs));
  let aa: f32 = max(1.0 / cs, 0.003);
  let cx: f32 = x * $W / cs;
  let cy: f32 = y * $H / cs;
  let i: f32 = floor(cx);
  let j: f32 = floor(cy);
  let u: f32 = cx - i;
  let v: f32 = cy - j;
  var sy: f32 = 0.0;
  var sa: f32 = 0.0;
  for (var q: i32 = 0; q < 4; q = q + 1) {
    var du: f32 = 0.25;
    var dv: f32 = 0.25;
    if (q == 1 || q == 3) { du = 0.75; }
    if (q >= 2) { dv = 0.75; }
    let t: vec4f = samp(clamp((i + du) * cs / $W, 0.5 / $W, 1.0 - 0.5 / $W), clamp((j + dv) * cs / $H, 0.5 / $H, 1.0 - 0.5 / $H));
    sy = sy + y601(t.xyz) * t.w;
    sa = sa + t.w;
  }
  var b: f32 = 0.0;
  if (sa > 1e-4) { b = sy / sa; }
  if ($mode == 'linear') { b = c01(0.7 * b + 0.3 * (i / gx * pcos(th) + j / gy * psin(th))); }
  if ($mode == 'radial') { b = c01(0.7 * b + 0.3 * hyp(i / gx - 0.5 - $offsetX / 100.0, j / gy - 0.5 - $offsetY / 100.0) * ($scale / 100.0) * 2.0); }
  var qv: f32 = c01(b + (dthr(i, j, cs) - 0.5) * 0.5);
  var r: f32 = 1.0;
  if ($style == 'scaled') {
    qv = b;
    r = c01(1.0 - b);
  }
  var idx: f32 = 3.0;
  if ($x0 < 2.5) {
    idx = 0.0;
    if (qv > 0.5) { idx = 1.0; }
  } else if (qv <= 0.25) { idx = 0.0; } else if (qv <= 0.5) { idx = 1.0; } else if (qv <= 0.75) { idx = 2.0; }
  let fg: vec3f = dpal(idx);
  let bg: vec3f = dpal($x0 - 1.0);
  let qx: f32 = 2.0 * abs(u - 0.5);
  let qy: f32 = 2.0 * abs(v - 0.5);
  var dist: f32 = qx + qy;
  if ($shape == 'circle') { dist = hyp(qx, qy); } else if ($shape == 'square') { dist = max(qx, qy); }
  return vec4f(mx3(bg, fg, 1.0 - smoothq(r, r + aa, dist)), c.w);
}
`;

/**
 * §50.12, output PREMULTIPLIED. Extras (oracle halftoneSetup): x0 N, x1 hex grid, x2 type (0 classic, 1 gooey,
 * 2 holes, 3 soft), x3 cell w, x4 cell h, x5 kappa, x6 b, x7 original colours. Value noise V/L3/O = vnoise/l3noise/onoise.
 * px/py start from the pixel index so x − 0.5 is exactly 0 at an odd size's centre pixel: WebGL2's x there can be off by
 * an ulp, which moved hex cell borders that fall exactly on that column.
 */
const HALFTONE = `
fn fx(x: f32, y: f32) -> vec4f {
  let a0: f32 = samp(x, y).w;
  if (a0 <= 1e-4) { return vec4f(0.0); }
  let nn: f32 = $x0;
  let hexg: bool = $x1 > 0.5;
  let kind: f32 = $x2;
  let cw: f32 = $x3;
  let ch: f32 = $x4;
  let kappa: f32 = $x5;
  let bb: f32 = $x6;
  let original: bool = $x7 > 0.5;
  let gm: f32 = $grainMixer / 100.0;
  let go: f32 = $grainOverlay / 100.0;
  let gam: f32 = powz($grainSize / 100.0, 0.72);
  let kg: f32 = mx(3200.0, 42.0, gam);
  let front: vec4f = $colorFront;
  let back: vec4f = $colorBack;
  let px: f32 = (floor(x * $W) + 0.5 - 0.5 * $W) / $W / cw;
  let py: f32 = (floor(y * $H) + 0.5 - 0.5 * $H) / $H / ch;
  var acc: vec3f = vec3f(0.0);
  var sm: f32 = 0.0;
  let ni: i32 = i32(nn + 0.5);
  for (var j: i32 = 0; j < ni; j = j + 1) {
    for (var i: i32 = 0; i < ni; i = i + 1) {
      var ox: f32 = f32(i) / nn - 0.5;
      let oy: f32 = f32(j) / nn - 0.5;
      if (hexg) {
        var rho: f32 = f32(j);
        if (ni == 1) { rho = floor(py + 0.5); }
        if (kind > 0.5 && kind < 1.5) {
          if (tmodf(rho + f32(i), 2.0) != 0.0) { continue; }
        } else if (abs(tmodf(rho, 2.0)) == 1.0) {
          ox = ox + 0.5 / nn;
        }
      }
      let qx: f32 = floor(px + ox);
      let qy: f32 = floor(py + oy);
      let fu: f32 = px + ox - qx;
      let fv: f32 = py + oy - qy;
      let ux: f32 = clamp((qx + 0.5 - ox) * cw + 0.5, 0.5 / $W, 1.0 - 0.5 / $W);
      let uy: f32 = clamp((qy + 0.5 - oy) * ch + 0.5, 0.5 / $H, 1.0 - 0.5 / $H);
      let s: vec4f = samp(ux, uy);
      var l: f32 = 0.0;
      if (s.w <= 1e-4) {
        if ($?inverted) { l = 1.0; }
      } else {
        l = y709(1.0 / (1.0 + exp(-kappa * (s.xyz - 0.5))));
        if ($?inverted) { l = 1.0 - l; }
      }
      if (gm > 0.001) {
        let k: f32 = mx(2600.0, 55.0, gam);
        let dx: f32 = ux * k + 37.0 * ox + 21.0;
        let dy: f32 = uy * k + 37.0 * oy - 14.0;
        let k1: f32 = mx(1.15, 0.2, gam);
        let k2: f32 = mx(2.1, 0.38, gam);
        let k3: f32 = mx(14.0, 4.0, gam);
        let p1: f32 = onoise(dx * k1, dy * k1);
        let p2: f32 = l3noise(dx * k2 + fu * k3, dy * k2 + fv * k3);
        let ew: f32 = 1.0 - abs(2.0 * l - 1.0);
        l = c01(l + (2.0 * p2 - 1.0) * (0.08 + 0.32 * gm) * (0.3 + 0.7 * ew) - smoothq(0.45, 0.85 - 0.2 * gm, p1) * gm * (0.1 + 0.8 * ew));
      }
      let d: f32 = hyp(fu - 0.5, fv - 0.5);
      var shp: f32 = 0.0;
      if (kind < 0.5) {
        let rr: f32 = 0.25 * bb * (1.0 - l);
        shp = 1.0 - smoothq(rr - 0.02, rr + 0.02, d);
      } else if (kind < 1.5) {
        var gk: f32 = 0.3;
        if (hexg) { gk = 0.42; }
        shp = powz(1.0 - smoothq(0.0, gk * bb * (1.0 - l), d), 2.0 + bb);
      } else if (kind < 2.5) {
        let rh: f32 = 0.75 * bb * (1.0 - l);
        let rm: f32 = rh - 0.5 * floor(rh / 0.5);
        let dsc: f32 = 1.0 - smoothq(rm - 0.02, rm + 0.02, d);
        shp = dsc;
        if (rh >= 0.5) { shp = 1.0 - dsc; }
      } else {
        shp = powz(1.0 - c01(d / (0.5 * c01(bb) * (1.0 - l))), 4.0 + 3.0 * (1.0 - c01(bb / 2.0)));
      }
      let m: f32 = shp * s.w;
      sm = sm + m;
      acc = acc + m * s.xyz * s.w;
    }
  }
  var ff: f32 = min(1.0, sm);
  if (kind > 0.5 && kind < 1.5) { ff = smoothq(0.42, 0.58, sm); } else if (kind > 2.5) { ff = sm; }
  let gx: f32 = x * kg + 13.1;
  let gy: f32 = y * kg * $H / $W - 9.7;
  let e: f32 = powz(c01(1.0 - abs(2.0 * ff - 1.0)), 0.55);
  let kf: f32 = mx(0.95, 0.16, gam);
  let kd: f32 = mx(1.9, 0.28, gam);
  let ko: f32 = mx(0.9, 0.14, gam);
  ff = c01(ff + (2.0 * l3noise(gx * kd - 17.3, gy * kd + 6.4) - 1.0) * e * gm * 0.24 - e * smoothq(0.42, 0.9, onoise(gx * kf, gy * kf)) * gm * (0.35 + 1.75 * gm));
  var aa: f32 = front.w * ff;
  var fc: vec3f = front.xyz * front.w;
  if (original) {
    aa = sm / max(sm, 1e-4) * ff;
    fc = acc / max(sm, 1e-4);
  }
  let cc: vec3f = fc * ff + back.xyz * back.w * (1.0 - aa);
  aa = aa + back.w * (1.0 - aa);
  let y2: f32 = 2.0 * powz(onoise(gx * ko, gy * ko), 1.3) - 1.0;
  let gv: f32 = powz(go * abs(y2), 0.8);
  var tgt: f32 = 0.0;
  if (y2 >= 0.0) { tgt = 1.0; }
  return vec4f(c013(mx3(cc, vec3f(tgt), gv / 2.0)) * a0, c01(aa + gv / 2.0) * a0);
}
`;

export const STYLIZE_KERNELS: Record<string, string> = {
  vignette: VIGNETTE, sharpen: SHARPEN, glow: GLOW, glitch: GLITCH, vhs: VHS, pixelate: PIXELATE, ascii: ASCII,
  'edge-detection': EDGE_DETECTION, scanlines: SCANLINES, 'film-grain': FILM_GRAIN, dither: DITHER, halftone: HALFTONE,
};
