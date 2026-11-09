// SPDX-License-Identifier: AGPL-3.0-only
// Motion-graphic repair (findings part 2 §33, part 3 §43.17; ticket T08 Repair, F27). The user starts it from the error panel
// of a broken graphic (never automatic). The user's own model gets {code, error, itemWidth, itemHeight} and returns {code} or
// {error}; at most 2 attempts, each result compiled and rendered by the renderer; the second attempt sends the first
// attempt's code and its renderer error. A result is saved (one undo step) only if the item did not change meanwhile.
// The user's model is connected through setRepairModel (settings/providers.ts); without one repair is disabled.
import { create } from 'zustand';
import type { RecordData } from '../store/model';

export type RepairRequest = { code: string; error: string; itemWidth: number; itemHeight: number };
export type RepairModel = (request: RepairRequest) => Promise<{ code: string } | { error: string }>;
export const useRepairModel = create<{ model: RepairModel | null }>(() => ({ model: null }));
export const setRepairModel = (model: RepairModel | null) => useRepairModel.setState({ model });

export type RepairDeps = {
  model: RepairModel | null;
  /** The renderer's error for a candidate, or null when it compiles and renders. */
  validate: (code: string) => Promise<string | null>;
  /** The item as it is now (undefined: deleted). */
  current: () => RecordData | undefined;
  /** Saves the code as one undo step: an error text, or null. */
  save: (code: string) => string | null;
};
export type RepairResult = { ok: true; attempts: number } | { ok: false; attempts: number; reason: 'no-code' | 'no-model' | 'changed' | 'failed'; message: string };
export const MAX_ATTEMPTS = 2;
export const NOTHING_TO_REPAIR = 'This motion graphic has no source code, so there is nothing to repair.';
export const CONNECT_A_MODEL = 'Connect a model to repair motion graphics.';
export const CHANGED = 'The motion graphic changed during the repair, so the result was not applied.';
export const REPAIR_FAILED = 'Could not repair this motion graphic';

/** The instructions the model gets with every repair request (Cutframe's own wording). */
export const systemPrompt = (apiNames: readonly string[]) => [
  'You repair motion-graphic code for the Cutframe video editor. Reply with the complete fixed code only: no explanation, no code fence.',
  'The code is one React component in Remotion style. It may use only these names, which are already in scope (no imports): ' + apiNames.join(', ') + '.',
  'The last statement must be `export const Name = () => { … };`; put every helper above it and export nothing else.',
  'Do not use native <img>, <video> or <audio> elements; use Img or OffthreadVideo with getAssetUrl("<asset id>").',
  'The graphic is drawn in its item box: lay it out with itemWidth and itemHeight, not with the width and height of useVideoConfig().',
  "editable(name, defaultValue, { type }) field types are text, string, number, color, boolean, text[], font and select.",
  'Keep the design and the animation; change only what the error needs.',
].join('\n');
export const userMessage = (r: RepairRequest) => `Error: ${r.error}\nItem size: ${r.itemWidth} × ${r.itemHeight}\nCode:\n${r.code}`;
/** The code in a reply: the reply itself, or the inside of its first code fence. */
export const replyCode = (text: string) => (/```[a-zA-Z]*\n([\s\S]*?)```/.exec(text)?.[1] ?? text).trim();

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);
export async function repairGraphic(item: RecordData, error: string, size: { width: number; height: number }, deps: RepairDeps): Promise<RepairResult> {
  const original = item.details?.code;
  if (typeof original !== 'string' || !original) return { ok: false, attempts: 0, reason: 'no-code', message: NOTHING_TO_REPAIR };
  if (!deps.model) return { ok: false, attempts: 0, reason: 'no-model', message: CONNECT_A_MODEL };
  const before = JSON.stringify(item);
  let code = original, last = error, failure = error;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let fixed: string | null = null;
    try {
      const r = await deps.model({ code, error: last, itemWidth: size.width, itemHeight: size.height });
      if ('code' in r && typeof r.code === 'string' && r.code.trim()) fixed = r.code; else failure = 'error' in r ? String(r.error) : 'The model returned no code.';
    } catch (e) { failure = messageOf(e); }
    if (fixed === null) continue;
    const problem = await deps.validate(fixed);
    if (problem) { code = fixed; last = failure = problem; continue; }
    if (JSON.stringify(deps.current()) !== before) return { ok: false, attempts: attempt, reason: 'changed', message: CHANGED };
    const saved = deps.save(fixed);
    return saved ? { ok: false, attempts: attempt, reason: 'failed', message: `${REPAIR_FAILED}: ${saved}` } : { ok: true, attempts: attempt };
  }
  return { ok: false, attempts: MAX_ATTEMPTS, reason: 'failed', message: `${REPAIR_FAILED}: ${failure}` };
}
