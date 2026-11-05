// SPDX-License-Identifier: AGPL-3.0-only
// Blur and distort kernels (part 4 §51.1-§51.4, §51.7-§51.12), WGSL subset of dsl.ts, mirroring
// parity/oracle/distort.ts. Blurs are weighted means of bilinear taps over all four straight-alpha channels.

const BOX_BLUR = `
fn fx(x: f32, y: f32) -> vec4f {
  let r: f32 = $radius;
  if (r < 0.5) { return samp(x, y); }
  let n: i32 = i32(min(trunc(r), 20.0));
  var acc: vec4f = vec4f(0.0);
  var total: f32 = 0.0;
  for (var b: i32 = -n; b <= n; b = b + 1) {
    for (var a: i32 = -n; a <= n; a = a + 1) {
      acc = acc + samp(x + f32(a) / $W, y + f32(b) / $H);
      total = total + 1.0;
    }
  }
  return acc / total;
}
`;

const MOTION_BLUR = `
fn fx(x: f32, y: f32) -> vec4f {
  let l: f32 = $amount / 100.0 * 0.3;
  if (l < 0.001) { return samp(x, y); }
  let phi: f32 = deg($angle);
  let n: i32 = i32(trunc(clamp($samples, 4.0, 128.0)));
  let cs: vec2f = sc(phi);
  var acc: vec4f = vec4f(0.0);
  var total: f32 = 0.0;
  for (var i: i32 = 0; i < n; i = i + 1) {
    let t: f32 = 2.0 * f32(i) / f32(n - 1) - 1.0;
    let w: f32 = exp(-2.0 * t * t);
    acc = acc + w * samp(x + t * l * cs.y, y + t * l * cs.x);
    total = total + w;
  }
  return acc / total;
}
`;

const RADIAL_BLUR = `
fn fx(x: f32, y: f32) -> vec4f {
  if ($amount / 50.0 < 0.01) { return samp(x, y); }
  let k: f32 = $amount / 250.0;
  let cx: f32 = $centerX / 100.0;
  let cy: f32 = $centerY / 100.0;
  let n: i32 = i32(trunc(clamp($samples, 4.0, 256.0)));
  let dx: f32 = x - cx;
  let dy: f32 = y - cy;
  let d: f32 = hyp(dx, dy);
  var acc: vec4f = vec4f(0.0);
  var total: f32 = 0.0;
  for (var i: i32 = 0; i < n; i = i + 1) {
    let t: f32 = f32(i) / f32(n - 1);
    let s: f32 = 1.0 - k * t * d;
    let w: f32 = 1.0 - 0.5 * t;
    acc = acc + w * samp(cx + s * dx, cy + s * dy);
    total = total + w;
  }
  return acc / total;
}
`;

const ZOOM_BLUR = `
fn fx(x: f32, y: f32) -> vec4f {
  let k: f32 = $amount / 200.0;
  let cx: f32 = $centerX / 100.0;
  let cy: f32 = $centerY / 100.0;
  let n: i32 = i32(trunc(clamp($samples, 4.0, 256.0)));
  let dx: f32 = x - cx;
  let dy: f32 = y - cy;
  var acc: vec4f = vec4f(0.0);
  for (var i: i32 = 0; i < n; i = i + 1) {
    let s: f32 = 1.0 + k * f32(i) / f32(n - 1);
    acc = acc + samp(cx + s * dx, cy + s * dy);
  }
  return acc / f32(n);
}
`;

const CHROMATIC_ABERRATION = `
fn fx(x: f32, y: f32) -> vec4f {
  let phi: f32 = deg($angle);
  let ox: f32 = $amount * pcos(phi) / $W;
  let oy: f32 = $amount * psin(phi) / $H;
  let c: vec4f = samp(x, y);
  return vec4f(samp(x + ox, y + oy).x, c.y, samp(x - ox, y - oy).z, c.w);
}
`;

/** §51.8 fold: identity on 0…1, triangle-wave reflection beyond. */
const LENS_DISTORTION = `
fn fold(v: f32) -> f32 { return 1.0 - abs(v - 2.0 * floor(v / 2.0) - 1.0); }
fn fx(x: f32, y: f32) -> vec4f {
  let k: f32 = $distortion / 100.0;
  let qx: f32 = 2.0 * x - 1.0;
  let qy: f32 = 2.0 * y - 1.0;
  let f: f32 = 1.0 + k * (qx * qx + qy * qy);
  let u: f32 = (f * qx + 1.0) / 2.0;
  let v: f32 = (f * qy + 1.0) / 2.0;
  if ($?mirrorEdges) { return samp(fold(u), fold(v)); }
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return vec4f(0.0); }
  return samp(u, v);
}
`;

const TWIRL = `
fn fx(x: f32, y: f32) -> vec4f {
  let r: f32 = $radius / 100.0;
  let cx: f32 = $centerX / 100.0;
  let cy: f32 = $centerY / 100.0;
  let dx: f32 = x - cx;
  let dy: f32 = y - cy;
  let d: f32 = hyp(dx, dy);
  if (d >= r) { return samp(x, y); }
  let q: f32 = 1.0 - d / r;
  let a: f32 = $amount / 10.0 * q * q;
  return samp(cx + dx * pcos(a) - dy * psin(a), cy + dx * psin(a) + dy * pcos(a));
}
`;

const WAVE = `
fn fx(x: f32, y: f32) -> vec4f {
  let v: f32 = y + $amplitudeX / 1000.0 * psin(2.0 * 3.141592653589793 * $frequencyX * x);
  return samp(x + $amplitudeY / 1000.0 * psin(2.0 * 3.141592653589793 * $frequencyY * v), v);
}
`;

const KALEIDOSCOPE = `
fn fx(x: f32, y: f32) -> vec4f {
  let w: f32 = 2.0 * 3.141592653589793 / max($segments, 2.0);
  let qx: f32 = x - 0.5;
  let qy: f32 = y - 0.5;
  let phi: f32 = atan2s(qy, qx) + deg($rotation);
  let d: f32 = hyp(qx, qy);
  var a: f32 = w * (phi / w - floor(phi / w));
  if (a > w / 2.0) { a = w - a; }
  return samp(0.5 + d * pcos(a), 0.5 + d * psin(a));
}
`;

const MIRROR = `
fn fx(x: f32, y: f32) -> vec4f {
  var u: f32 = x;
  var v: f32 = y;
  if ($?horizontal && x > 0.5) { u = 1.0 - x; }
  if ($?vertical && y > 0.5) { v = 1.0 - y; }
  return samp(u, v);
}
`;

export const DISTORT_KERNELS: Record<string, string> = {
  'box-blur': BOX_BLUR, 'motion-blur': MOTION_BLUR, 'radial-blur': RADIAL_BLUR, 'zoom-blur': ZOOM_BLUR,
  'chromatic-aberration': CHROMATIC_ABERRATION, 'lens-distortion': LENS_DISTORTION, twirl: TWIRL, wave: WAVE,
  kaleidoscope: KALEIDOSCOPE, mirror: MIRROR,
};
