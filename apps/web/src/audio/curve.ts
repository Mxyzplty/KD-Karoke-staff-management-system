// SPDX-License-Identifier: AGPL-3.0-only
// A keyframe list compiled once for per-sample reads: the values of timeline/properties.ts evaluate (hold before the first
// and after the last keyframe, A's easing or the handles' bezier on each segment), with the sort and the curve set-up done
// once instead of on every call. A non-number value reads as `fallback`; a segment with one holds its first keyframe.
import { controlPoints, cubicBezier, easingCurve, sorted } from '../timeline/properties';
import type { Keyframe } from '../timeline/properties';

export function compileCurve(keyframes: Keyframe[] | undefined, fallback: number): (t: number) => number {
  if (!keyframes?.length) return () => fallback;
  const k = sorted(keyframes), n = k.length, times = k.map(f => f.time);
  const numeric = k.map(f => typeof f.value === 'number' && Number.isFinite(f.value)), values = k.map((f, i) => numeric[i] ? f.value as number : fallback);
  const ease = k.slice(0, -1).map((a, i) => {
    const b = k[i + 1];
    if (!a.outHandle && !b.inHandle) return easingCurve(a.easing);
    const d = controlPoints(a.easing), o = a.outHandle ?? [d[0], d[1]], h = b.inHandle ?? [d[2], d[3]];
    return cubicBezier(o[0], o[1], h[0], h[1]);
  });
  let i = 0; // segment cursor: reads are mostly in time order
  return t => {
    if (t <= times[0]) return values[0];
    if (t >= times[n - 1]) return values[n - 1];
    if (!(times[i] <= t && t < times[i + 1])) {
      // The last keyframe at or before t (evaluate's findIndex(time > t) − 1).
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
      i = lo;
    }
    if (t === times[i] || !numeric[i] || !numeric[i + 1]) return values[i];
    return values[i] + (values[i + 1] - values[i]) * ease[i]((t - times[i]) / (times[i + 1] - times[i]));
  };
}
