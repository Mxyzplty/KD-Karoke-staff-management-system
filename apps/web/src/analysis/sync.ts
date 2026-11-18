// SPDX-License-Identifier: AGPL-3.0-only
import { median } from './audio';
import { AnalysisError, wordsOf, type Transcript, type Word } from './types';

export const normalWord = (word: string) => word.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']/gu, '').replace(/^'+|'+$/g, '');
export type SyncResult = { offset: number; confidence: number; matches: { sourceIndex: number; targetIndex: number; sourceTime: number; targetTime: number }[] };
/** Words with a non-empty normal form, and those forms: each word is normalised once. */
function normalised(transcript: Transcript) {
  const words: Word[] = [], keys: string[] = [];
  for (const w of wordsOf(transcript)) { const key = normalWord(w.word); if (key) { words.push(w); keys.push(key); } }
  return { words, keys };
}
const push = (map: Map<string, number[]>, key: string, j: number) => { const list = map.get(key); if (list) list.push(j); else map.set(key, [j]); };
/** First index in [lo, hi) of `list` whose position passes `test` (false, then true, along the list). */
function first(list: number[], lo: number, hi: number, test: (j: number) => boolean) {
  while (lo < hi) { const mid = (lo + hi) >> 1; if (test(list[mid])) hi = mid; else lo = mid + 1; }
  return lo;
}
/** offset = source time - target time. Add offset to a target source-time trim to address source.
 *  Audit F1 bound (was ~N^3.7): anchors come from a three-word index, each distinct offset is scored once (a repeat scores
 *  the same and never replaces the best), and each word scans only its same-word target positions in the 0.2 s window.
 *  Results equal a404e27's bit for bit: same expressions, same (i, j) order, and every skipped j has d ≥ 0.2. */
export function syncOffset(source: Transcript, target: Transcript): SyncResult {
  const { words: a, keys: na } = normalised(source), { words: b, keys: nb } = normalised(target);
  // Target positions by word and by three-word anchor, j ascending. Normal words hold no space, so the key is exact.
  const at = new Map<string, number[]>(), anchors = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) { push(at, nb[j], j); if (j + 2 < b.length) push(anchors, `${nb[j]} ${nb[j + 1]} ${nb[j + 2]}`, j); }
  const candidates: { i: number; j: number; offset: number }[] = [], seen = new Set<number>();
  // Three-word anchors reject isolated function words and preserve sequence order.
  for (let i = 0; i + 2 < a.length; i++) for (const j of anchors.get(`${na[i]} ${na[i + 1]} ${na[i + 2]}`) ?? []) {
    const offset = median([0, 1, 2].map(k => a[i + k].start - b[j + k].start));
    if (!seen.has(offset)) { seen.add(offset); candidates.push({ i, j, offset }); }
  }
  // Finite, non-decreasing target times: each word's times rise with j, so its window is found by binary search, widened
  // by `slack` (far above the rounding of d) and then tested exactly. Otherwise the word's positions from nextTarget on.
  let sorted = true, span = 0;
  for (let j = 0; j < b.length; j++) { if (!Number.isFinite(b[j].start) || (j > 0 && !(b[j - 1].start <= b[j].start))) sorted = false; else span = Math.max(span, Math.abs(b[j].start)); }
  let best: SyncResult = { offset: 0, confidence: 0, matches: [] };
  for (const candidate of candidates) {
    const matches: SyncResult['matches'] = [];
    let nextTarget = 0;
    for (let i = 0; i < a.length; i++) {
      let bestJ = -1, distance = 0.2;
      const js = at.get(na[i]) ?? [], t = a[i].start - candidate.offset;
      let p = first(js, 0, js.length, j => j >= nextTarget), end = js.length;
      if (sorted && Number.isFinite(t)) {
        const slack = 1e-9 * (1 + Math.abs(a[i].start) + Math.abs(candidate.offset) + span);
        p = first(js, p, end, j => b[j].start >= t - 0.2 - slack); end = first(js, p, end, j => b[j].start > t + 0.2 + slack);
      }
      for (; p < end; p++) {
        const j = js[p], d = Math.abs(a[i].start - b[j].start - candidate.offset);
        if (d < distance) { bestJ = j; distance = d; }
      }
      if (bestJ >= 0) { matches.push({ sourceIndex: i, targetIndex: bestJ, sourceTime: a[i].start, targetTime: b[bestJ].start }); nextTarget = bestJ + 1; }
    }
    const offset = median(matches.map(m => m.sourceTime - m.targetTime));
    const residual = median(matches.map(m => Math.abs(m.sourceTime - m.targetTime - offset)));
    const confidence = matches.length / Math.max(1, Math.min(a.length, b.length)) * Math.max(0, 1 - residual / 0.2);
    if (confidence > best.confidence || (confidence === best.confidence && matches.length > best.matches.length)) best = { offset, confidence, matches };
  }
  if (best.matches.length < 3 || best.confidence < 0.5) throw new AnalysisError('SYNC_LOW_CONFIDENCE', `Low sync confidence (${Math.round(best.confidence * 100)}%). Transcripts may not overlap enough.`, { confidence: best.confidence });
  return best;
}
