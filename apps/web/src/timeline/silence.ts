// SPDX-License-Identifier: AGPL-3.0-only
// T19 C6 (CUT-P01): silence removal on the T03 commands. Xapp has no tool for it: its agent reads the word times, splits
// from the latest pause to the earliest and ripple-deletes (part 3 §44.9). The Cutframe helper does the same in one
// command (one undo step): pauses longer than `pause` inside the chosen source ranges shrink to `keptGap`
// (analysis/helpers planSilenceRemoval), each cut is split out and ripple-deleted, later items close up. Captions
// following the cut are T09's.
import { planSilenceRemoval } from '../analysis/helpers';
import type { Pair, Word } from '../analysis/types';
import type { CommandBus, Source } from './bus';
import { EPS, fail, item, rate } from './model';
import { remapKeyframes } from './properties';
import { remove, split } from './items';

/** `ranges`: source seconds the cuts may touch (default: the item's visible source part); `pause` / `keptGap` in s
 *  (defaults 0.75 / 0.35). */
export type SilenceOptions = { ranges?: Pair[]; pause?: number; keptGap?: number; source?: Source };
/** `cuts`: the removed spans in timeline s as they were before the edit, earliest first; `removed`: their total in s. */
export type SilenceResult = { cuts: { from: number; to: number }[]; removed: number };

/** Removes the long pauses of a video or audio item, given its source's words (source seconds). */
export function removeSilences(bus: CommandBus, itemId: string, words: Word[], options: SilenceOptions = {}): SilenceResult {
  return bus.run('Ripple delete', options.source ?? 'user', (doc, tx) => {
    const target = item(doc, itemId);
    if (!target) fail('ITEM_NOT_FOUND', `Item '${itemId}' not found`);
    if (target.type !== 'video' && target.type !== 'audio') fail('INVALID_ANALYSIS_INPUT', 'Silence removal needs a video or audio item.');
    if (remapKeyframes(target).length) fail('INVALID_ANALYSIS_INPUT', 'Silence removal does not support time-remapped items.');
    const r = rate(target), trimFrom = target.trim?.from ?? 0, visible: Pair = [trimFrom / 1000, (trimFrom + (target.display.to - target.display.from) * r) / 1000];
    const ranges = (options.ranges ?? [visible]).map(([a, b]): Pair => [Math.max(a, visible[0]), Math.min(b, visible[1])]).filter(([a, b]) => a < b);
    const at = (s: number) => Math.round(target.display.from + (s * 1000 - trimFrom) / r);
    const cuts = planSilenceRemoval(words, ranges, options.pause, options.keptGap).map(([a, b]) => ({ from: at(a), to: at(b) })).filter(c => c.to - c.from > EPS);
    // Latest first: the original id keeps the part before each cut, so earlier cuts still split it.
    const pieces: string[] = [];
    for (const cut of cuts.slice().reverse()) {
      const left = item(doc, itemId)!;
      if (cut.to < left.display.to - EPS) split(doc, itemId, cut.to);
      pieces.push(cut.from > left.display.from + EPS ? split(doc, itemId, cut.from).right : itemId);
    }
    for (const id of pieces) tx.label = remove(doc, [id], { ripple: true, path: 'tool' }).label;
    return { cuts: cuts.map(c => ({ from: c.from / 1000, to: c.to / 1000 })), removed: cuts.reduce((s, c) => s + c.to - c.from, 0) / 1000 };
  });
}
