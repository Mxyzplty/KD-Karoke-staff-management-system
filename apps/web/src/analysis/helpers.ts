// SPDX-License-Identifier: AGPL-3.0-only
import { AnalysisError, finite, type Pair, type Rhythm, type Word } from './types';

/** Strict interior subdivisions; beat endpoints are carried by the beats array. */
export function subdivisions(rhythm: Rhythm, divisionsPerBeat: 2 | 3 | 4 = 4) {
  if (![2, 3, 4].includes(divisionsPerBeat)) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'subdivisionsPerBeat must be 2, 3, or 4.');
  const timestamps: number[] = [];
  for (let i = 1; i < rhythm.beats.length; i++) {
    const from = rhythm.beats[i - 1][0], to = rhythm.beats[i][0];
    if (rhythm.silences.some(([a, b]) => a < to && b > from)) continue;
    for (let k = 1; k < divisionsPerBeat; k++) timestamps.push(from + (to - from) * k / divisionsPerBeat);
  }
  return { divisionsPerBeat, method: 'interpolated' as const, timestamps };
}
export function readBeats(rhythm: Rhythm, options: { from?: number; to?: number; minStrength?: number; divisionsPerBeat?: 2 | 3 | 4 } = {}) {
  const base = { bpm: rhythm.bpm, firstDownbeat: rhythm.downbeats[0]?.[0] ?? null };
  if (options.from === undefined && options.to === undefined) return base;
  const { from, to, minStrength = 0 } = options;
  if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to) || from >= to || !Number.isFinite(minStrength) || minStrength < 0 || minStrength > 1) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Expected a finite increasing beat range and strength in [0,1].');
  const inRange = (time: number) => time >= from && time < to, sub = subdivisions(rhythm, options.divisionsPerBeat);
  return { ...base, beats: rhythm.beats.filter(([t, s]) => inRange(t) && s >= minStrength), downbeats: rhythm.downbeats.filter(([t, s]) => inRange(t) && s >= minStrength), subdivisions: { ...sub, timestamps: sub.timestamps.filter(inRange) } };
}
/** When several cuts would land on one target, only the nearest moves (ties: the earlier cut); the others stay where they are, so no clip collapses to zero length. */
export function snapCuts(cuts: number[], rhythm: Rhythm, tolerance: number, divisionsPerBeat?: 2 | 3 | 4) {
  finite(tolerance, 'tolerance');
  if (tolerance < 0) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Tolerance must be nonnegative.');
  const targets = [...rhythm.beats.map(b => b[0]), ...(divisionsPerBeat ? subdivisions(rhythm, divisionsPerBeat).timestamps : [])].sort((a, b) => a - b);
  const moves = cuts.flatMap((from, index) => {
    finite(from, 'cut');
    let best: number | undefined;
    for (const time of targets) if (best === undefined || Math.abs(time - from) < Math.abs(best - from)) best = time;
    return best !== undefined && Math.abs(best - from) <= tolerance ? [{ index, from, to: best, delta: best - from }] : [];
  });
  return moves.filter(m => !moves.some(o => o.to === m.to && (Math.abs(o.delta) < Math.abs(m.delta) || (Math.abs(o.delta) === Math.abs(m.delta) && o.index < m.index))));
}
/** Union chosen ranges first. Keep half the requested gap at either side of each pause. */
export function planSilenceRemoval(words: Word[], ranges: Pair[], pause = 0.75, keptGap = 0.35): Pair[] {
  if (![pause, keptGap].every(Number.isFinite) || pause < 0 || keptGap < 0 || keptGap > pause) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Expected 0 <= kept gap <= pause threshold.');
  const merged: Pair[] = [];
  for (const [start, end] of ranges.slice().sort((a, b) => a[0] - b[0])) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Chosen ranges must be finite and increasing.');
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  const sorted = words.slice().sort((a, b) => a.start - b.start), cuts: Pair[] = [];
  let spokenEnd = sorted[0]?.end ?? 0;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    for (const [a, b] of merged) {
      const from = Math.max(spokenEnd, a), to = Math.min(next.start, b);
      if (to - from > pause) cuts.push([from + keptGap / 2, to - keptGap / 2]);
    }
    spokenEnd = Math.max(spokenEnd, next.end);
  }
  return cuts;
}
