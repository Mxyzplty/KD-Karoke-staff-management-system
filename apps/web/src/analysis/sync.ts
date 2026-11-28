// SPDX-License-Identifier: AGPL-3.0-only
import { median } from './audio';
import { AnalysisError, wordsOf, type Transcript } from './types';

export const normalWord = (word: string) => word.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']/gu, '').replace(/^'+|'+$/g, '');
export type SyncResult = { offset: number; confidence: number; matches: { sourceIndex: number; targetIndex: number; sourceTime: number; targetTime: number }[] };
/** offset = source time - target time. Add offset to a target source-time trim to address source. */
export function syncOffset(source: Transcript, target: Transcript): SyncResult {
  const a = wordsOf(source).filter(w => normalWord(w.word)), b = wordsOf(target).filter(w => normalWord(w.word));
  const candidates: { i: number; j: number; offset: number }[] = [];
  // Three-word anchors reject isolated function words and preserve sequence order.
  for (let i = 0; i + 2 < a.length; i++) for (let j = 0; j + 2 < b.length; j++) {
    if ([0, 1, 2].every(k => normalWord(a[i + k].word) === normalWord(b[j + k].word))) candidates.push({ i, j, offset: median([0, 1, 2].map(k => a[i + k].start - b[j + k].start)) });
  }
  let best: SyncResult = { offset: 0, confidence: 0, matches: [] };
  for (const candidate of candidates) {
    const matches: SyncResult['matches'] = [];
    let nextTarget = 0;
    for (let i = 0; i < a.length; i++) {
      let bestJ = -1, distance = 0.2;
      for (let j = nextTarget; j < b.length; j++) {
        const d = Math.abs(a[i].start - b[j].start - candidate.offset);
        if (normalWord(a[i].word) === normalWord(b[j].word) && d < distance) { bestJ = j; distance = d; }
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
