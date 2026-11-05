// SPDX-License-Identifier: AGPL-3.0-only
// Gain law (findings §40, part 2 §29): gain = track gain × volume², track gain = 0 when muted or another track is soloed,
// else the track volume clamped to 0…1; a hidden track (or one in a hidden group) is silent in preview and export.
// Default mode: volume keyframes with their easing at property time (trim.from + local × rate), on every clip including
// time-remapped ones (documented improvement). Parity mode (the side-by-side test only, findings §7): Xapp's export
// events — the gain starts at the first keyframe's value² at the clip start (or the range start), then one linear ramp to
// track gain × value² per keyframe whose timeline time is inside the mixed range (easing and handles ignored); a
// time-remapped clip plays its static volume² (Xapp ignores its keyframes).
import type { ProjectDocument, RecordData } from '../store/model';
import { ancestors, track, trackGain } from '../timeline/model';
import { prop, rateOf, remapKeyframes, sorted, toTimelineMs } from '../timeline/properties';
import { compileCurve } from './curve';

export type GainMode = 'default' | 'parity';
export const isHidden = (doc: ProjectDocument, trackId: string) => !!track(doc, trackId)?.hidden || ancestors(doc, trackId).some(g => doc.groups[g]?.hidden);
/** The track's share of the gain law: 0 for a hidden track, else §29's rule. */
export const audibleTrackGain = (doc: ProjectDocument, trackId: string) => isHidden(doc, trackId) ? 0 : trackGain(doc, trackId);
const square = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v * v : 1;

/** The gain of one clip as a function of timeline ms, for a mix of [fromMs, toMs). */
export function clipGain(doc: ProjectDocument, item: RecordData, mode: GainMode, fromMs: number, toMs: number): (ms: number) => number {
  const tg = audibleTrackGain(doc, item.trackId), p = prop(item, 'volume'), base = p ? p.defaultValue : 1;
  if (tg === 0) return () => 0;
  if (!p?.keyframes.length || (mode === 'parity' && remapKeyframes(item).length)) { const g = tg * square(base); return () => g; }
  const rate = rateOf(item), trim = item.trim?.from ?? 0;
  if (mode === 'default') {
    const v = compileCurve(p.keyframes, typeof base === 'number' ? base : 1);
    return ms => { const x = v(trim + (ms - item.display.from) * rate); return tg * x * x; };
  }
  // Parity: setValueAtTime then linearRampToValueAtTime events, read as Web Audio reads them.
  const k = sorted(p.keyframes), first = square(k[0].value);
  const times = [Math.max(fromMs, item.display.from)], values = [tg * first];
  for (const f of k) {
    const at = toTimelineMs(item, f.time);
    if (at >= fromMs && at <= toMs) { times.push(Math.max(at, times[0])); values.push(tg * square(f.value)); }
  }
  let i = 0;
  return ms => {
    if (ms >= times[times.length - 1]) return values[values.length - 1];
    if (ms <= times[0]) return values[0];
    while (i > 0 && times[i] > ms) i--;
    while (times[i + 1] <= ms) i++;
    const t0 = times[i], t1 = times[i + 1];
    return t1 === t0 ? values[i + 1] : values[i] + (values[i + 1] - values[i]) * (ms - t0) / (t1 - t0);
  };
}
