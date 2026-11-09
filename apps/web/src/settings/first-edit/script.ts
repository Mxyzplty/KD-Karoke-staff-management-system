// SPDX-License-Identifier: AGPL-3.0-only
// T21 First Edit steps (§28b.3): three chat-shaped turns with no model behind them. Every edit is a normal tool call on the
// editor's runtime, so the document and undo history are what an agent or the UI would leave (promise 2). Our answers are
// chosen from the real results, so a clip that did not take the effect is never claimed as restyled (W8, an improvement).
import { buildPlan, clock } from './plan';
import type { DemoAsset, Plan } from './plan';

export const OP_TIMEOUT_MS = 20_000;
type Result = { success: boolean; data?: Record<string, unknown>; code?: string; error?: string };
export type ScriptHost = { assets: DemoAsset[]; call: (tool: string, args: Record<string, unknown>) => Result | Promise<Result>; wait: (ms: number) => Promise<void> };
export type Op = { tool: string; run: () => Promise<unknown> };
export type Step = { id: 'music' | 'montage' | 'style'; headline: string; message: string; ops: Op[]; answer: () => string };
export type ChipState = 'pending' | 'running' | 'done';
export const FINAL_HEADLINE = 'Your montage is ready. Press play.';
export const OPENING = 'Your timeline is empty, and your clips and a song are on the right. Let’s turn them into a montage.';
const seconds = (ms: number) => Math.round(ms) / 1000;
const report = (...why: unknown[]) => console.warn('[FirstEdit]', ...why);
const bare = (name: string) => name.replace(/\.[^.]+$/, '');
function checked(result: Result) { if (!result.success) throw new Error(`${result.code ?? 'FAILED'}: ${result.error ?? 'command refused'}`); return result.data ?? {}; }

export function createScript(host: ScriptHost) {
  let plan: Plan | undefined, musicItem: string | undefined, montage: string[] = [], styled = 0;
  const planned = () => plan ??= buildPlan(host.assets);
  const newTrack = async (kind: 'audio' | 'video') => (checked(await host.call('manageTrack', { action: 'create', kind })).track as { id: string }).id;
  const place = async (trackId: string, items: Record<string, unknown>[]) => (checked(await host.call('addMedia', { trackId, timelineStart: 0, items })).results as { itemId: string }[]).map(r => r.itemId);
  async function addMusic() {
    const { music, sourceEnd } = planned();
    if (!music) return report('no audio asset');
    [musicItem] = await place(await newTrack('audio'), [{ assetId: music.id, trimStart: 0, trimEnd: seconds(Math.min(sourceEnd, music.durationMs)) }]);
  }
  async function addMontage() {
    const { cuts } = planned();
    if (!cuts.length) return report('no plan for the montage');
    montage = await place(await newTrack('video'), cuts.map(c => ({ assetId: c.assetId, trimStart: seconds(c.trimStart), trimEnd: seconds(c.trimEnd) })));
  }
  /** One command for the whole montage; a refusal is all-or-nothing, so each item is then tried alone and failures skipped. */
  async function addLook() {
    const add = [{ effectId: 'ascii' }];
    if (!montage.length) return;
    const all = await host.call('writeEffects', { itemIds: montage, add });
    if (all.success) { styled = montage.length; return; }
    report(all.code, all.error);
    for (const itemId of montage) { const one = await host.call('writeEffects', { itemId, add }); if (one.success) styled++; else report(itemId, one.code, one.error); }
  }
  const musicAnswer = () => {
    const { music, analysis } = planned();
    if (!musicItem || !music) return 'Sorry, that song would not go on this time. The montage will still work.';
    return `“${bare(music.name)}” is on the timeline${analysis.bpm ? ` at ${Math.round(analysis.bpm)} BPM` : ''}, and the drop lands at ${clock(analysis.drop)}.`;
  };
  const montageAnswer = () => {
    if (!montage.length) return 'The montage didn’t work this time. Your timeline is still here, and you can build it with an assistant later.';
    const { skipped } = planned(), beat = skipped ? `${skipped} ${skipped === 1 ? 'segment' : 'segments'} had no clip long enough, so the rest were moved up onto the beat.` : 'Every one is on the beat.';
    return `${montage.length} cuts. ${beat} They speed up into the drop, then alternate short and longer hits.`;
  };
  const loop = 'That’s the loop: ask, watch it appear, adjust.';
  const styleAnswer = () => {
    if (!montage.length) return `${loop} The timeline is yours from here.`;
    return styled === montage.length ? `One request changed the look of every clip. ${loop}` : `${styled} of ${montage.length} clips took the new look. ${loop}`;
  };
  const steps: Step[] = [
    { id: 'music', headline: 'The music goes in first.', message: 'Put the fever track on the timeline.', answer: musicAnswer, ops: [{ tool: 'searchProjectAssets', run: () => host.wait(800) }, { tool: 'addMedia', run: addMusic }] },
    { id: 'montage', headline: 'Now a montage, cut to the beat.', message: 'Cut a montage to the beat of this song.', answer: montageAnswer, ops: [{ tool: 'loadSkill', run: () => host.wait(700) }, { tool: 'addMedia', run: addMontage }] },
    { id: 'style', headline: 'One new look for every clip.', message: 'Give every clip an ASCII look.', answer: styleAnswer, ops: [{ tool: 'writeEffects', run: async () => { await addLook(); await host.wait(600); } }] },
  ];
  return { steps, plan: planned };
}
/** Runs a step's operations in order. A timeout or failure is logged, its chip still turns done and the step goes on (W9). */
export async function runOps(ops: Op[], wait: ScriptHost['wait'], chip: (index: number, state: ChipState) => void, timeoutMs = OP_TIMEOUT_MS) {
  for (const [index, op] of ops.entries()) {
    chip(index, 'running');
    await Promise.race([op.run(), wait(timeoutMs).then(() => report(`${op.tool} timed out`))]).catch(e => report(op.tool, e));
    chip(index, 'done');
  }
}
