// SPDX-License-Identifier: AGPL-3.0-only
// T21 First Edit demo script (§28b.3): three scripted steps over normal tool calls, and runOps with its timeout rule (W9).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createScript, FINAL_HEADLINE, OP_TIMEOUT_MS, OPENING, runOps } from '../apps/web/src/settings/first-edit/script';
import type { ChipState, Op, ScriptHost } from '../apps/web/src/settings/first-edit/script';
import type { DemoAsset } from '../apps/web/src/settings/first-edit/plan';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const beats = Array.from({ length: 41 }, (_, n) => n * 0.5);
const assets: DemoAsset[] = [
  { id: 'song', type: 'audio', name: 'Night Fever.mp3', durationMs: 30_000, rhythm_data: { beats }, segments: [{ start_time: 8, label: 'Drop' }] },
  ...['Mountain top', 'hiking', 'skate', 'bike'].map(n => ({ id: n, type: 'video', name: `${n}.webm`, durationMs: 12_000 })),
];
type Call = { tool: string; args: Record<string, any> };
/** A host that records calls and answers the way the editor does; `refuse` makes a tool fail. */
function host(refuse: (call: Call) => boolean = () => false) {
  const calls: Call[] = [];
  let track = 0;
  const h: ScriptHost = {
    assets, wait: async () => {},
    call: (tool, args) => {
      const call = { tool, args };
      calls.push(call);
      if (refuse(call)) return { success: false, code: 'REFUSED', error: 'no' };
      if (tool === 'manageTrack') return { success: true, data: { track: { id: `track_${++track}` } } };
      if (tool === 'addMedia') return { success: true, data: { results: (args.items as unknown[]).map((_, n) => ({ itemId: `${args.trackId}_item_${n}` })) } };
      return { success: true, data: {} };
    },
  };
  return { h, calls };
}
const runAll = async (script: ReturnType<typeof createScript>) => { for (const step of script.steps) for (const op of step.ops) await op.run(); };

describe('constants', () => {
  test('text and timeout', () => {
    expect(FINAL_HEADLINE).toBe('Your montage is ready. Press play.');
    expect(OPENING).toMatch(/^Your timeline is empty/);
    expect(OP_TIMEOUT_MS).toBe(20_000);
  });
});

describe('createScript', () => {
  test('three steps with ids music, montage, style, each with a headline, a user message and operations', () => {
    const { steps } = createScript(host().h);
    expect(steps.map(s => s.id)).toEqual(['music', 'montage', 'style']);
    for (const s of steps) { expect(s.headline).not.toBe(''); expect(s.message).not.toBe(''); expect(s.ops.length).toBeGreaterThan(0); }
    expect(steps.map(s => s.ops.map(o => o.tool))).toEqual([['searchProjectAssets', 'addMedia'], ['loadSkill', 'addMedia'], ['writeEffects']]);
  });
  test('a full run puts the song on an audio track, the cuts on a video track, and the ASCII effect on every cut with one call', async () => {
    const { h, calls } = host(), script = createScript(h);
    await runAll(script);
    expect(calls.map(c => c.tool)).toEqual(['manageTrack', 'addMedia', 'manageTrack', 'addMedia', 'writeEffects']);
    expect(calls[0].args).toEqual({ action: 'create', kind: 'audio' });
    expect(calls[1].args).toMatchObject({ trackId: 'track_1', timelineStart: 0, items: [{ assetId: 'song', trimStart: 0 }] });
    expect(calls[2].args).toEqual({ action: 'create', kind: 'video' });
    const cuts = calls[3].args.items as { trimStart: number; trimEnd: number }[];
    expect(cuts.length).toBe(script.plan().cuts.length);
    expect(cuts.length).toBeGreaterThan(10);
    expect(calls[4].args.add).toEqual([{ effectId: 'ascii' }]);
    expect(calls[4].args.itemIds).toHaveLength(cuts.length);
    const answers = script.steps.map(s => s.answer());
    expect(answers[0]).toMatch(/^“Night Fever” is on the timeline at 120 BPM, and the drop lands at 0:08\.$/);
    expect(answers[1]).toContain(`${cuts.length} cuts. Every one is on the beat.`);
    expect(answers[2]).toMatch(/^One request changed the look of every clip\./);
  });
  test('the plan is computed once and shared', () => {
    const script = createScript(host().h);
    expect(script.plan()).toBe(script.plan());
  });
  test('before anything ran the answers admit failure instead of claiming success', () => {
    const { steps } = createScript(host().h);
    expect(steps[0].answer()).toMatch(/^Sorry, that song would not go on/);
    expect(steps[1].answer()).toMatch(/^The montage didn’t work/);
    expect(steps[2].answer()).toMatch(/^That’s the loop/);
  });
  test('a refused song does not stop the montage (the op throws, the answer says so)', async () => {
    const { h } = host(c => c.tool === 'addMedia' && c.args.items[0].assetId === 'song'), script = createScript(h);
    await expect(script.steps[0].ops[1].run()).rejects.toThrow('REFUSED: no');
    expect(script.steps[0].answer()).toMatch(/^Sorry, that song/);
    await script.steps[1].ops[1].run();
    expect(script.steps[1].answer()).toMatch(/cuts\./);
  });
  test('if the all-clips effect call is refused each clip is tried alone and the answer counts those that took it', async () => {
    const { h, calls } = host(c => c.tool === 'writeEffects' && (!!c.args.itemIds || c.args.itemId.endsWith('_item_0')));
    const script = createScript(h);
    await runAll(script);
    const alone = calls.filter(c => c.tool === 'writeEffects' && c.args.itemId);
    const total = script.plan().cuts.length;
    expect(calls.filter(c => c.tool === 'writeEffects' && c.args.itemIds)).toHaveLength(1);
    expect(alone).toHaveLength(total);
    expect(script.steps[2].answer()).toMatch(new RegExp(`^${total - 1} of ${total} clips took the new look\\.`));
  });
  test('a skipped segment is reported as moved up onto the beat, never as off the beat (findings part 2 line 399)', async () => {
    const short = assets.map(a => a.type === 'video' ? { ...a, durationMs: 1_000 } : a), { h } = host(), script = createScript({ ...h, assets: short });
    await runAll(script);
    const { skipped, cuts } = script.plan();
    expect(skipped).toBeGreaterThan(0);
    expect(script.steps[1].answer()).toContain(`${cuts.length} cuts. ${skipped} ${skipped === 1 ? 'segment' : 'segments'} had no clip long enough, so the rest were moved up onto the beat.`);
    expect(script.steps[1].answer()).not.toMatch(/off the beat/);
  });
  test('with no video assets there is no montage and the style step says the timeline is the user’s', async () => {
    const { h, calls } = host(), script = createScript({ ...h, assets: assets.filter(a => a.type === 'audio') });
    await runAll(script);
    expect(calls.filter(c => c.tool === 'writeEffects')).toEqual([]);
    expect(script.steps[1].answer()).toMatch(/didn’t work/);
    expect(script.steps[2].answer()).toBe('That’s the loop: ask, watch it appear, adjust. The timeline is yours from here.');
  });
});

describe('runOps', () => {
  const noWait = () => new Promise<void>(() => {});
  const log = () => { const events: [number, ChipState][] = []; return { events, chip: (i: number, s: ChipState) => events.push([i, s]) }; };

  test('chips go running → done for each operation, in order, one at a time', async () => {
    const { events, chip } = log(), order: string[] = [];
    const ops: Op[] = ['a', 'b', 'c'].map(name => ({ tool: name, run: async () => { order.push(`start ${name}`); await Promise.resolve(); order.push(`end ${name}`); } }));
    await runOps(ops, noWait, chip);
    expect(events).toEqual([[0, 'running'], [0, 'done'], [1, 'running'], [1, 'done'], [2, 'running'], [2, 'done']]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
  test('an operation still running when the timeout fires is marked done and the next one runs (W9)', async () => {
    const { events, chip } = log(), ran: string[] = [];
    const ops: Op[] = [{ tool: 'slow', run: () => new Promise(() => {}) }, { tool: 'next', run: async () => { ran.push('next'); } }];
    await runOps(ops, ms => new Promise(r => setTimeout(r, ms === 15 ? 15 : 1e6)), chip, 15);
    expect(events).toEqual([[0, 'running'], [0, 'done'], [1, 'running'], [1, 'done']]);
    expect(ran).toEqual(['next']);
    expect(console.warn).toHaveBeenCalledWith('[FirstEdit]', 'slow timed out');
  });
  test('a failing operation is logged, its chip still turns done and the step goes on', async () => {
    const { events, chip } = log(), boom = new Error('boom');
    await runOps([{ tool: 'bad', run: async () => { throw boom; } }, { tool: 'good', run: async () => {} }], noWait, chip);
    expect(events).toEqual([[0, 'running'], [0, 'done'], [1, 'running'], [1, 'done']]);
    expect(console.warn).toHaveBeenCalledWith('[FirstEdit]', 'bad', boom);
  });
  test('the default timeout is OP_TIMEOUT_MS', async () => {
    const waits: number[] = [];
    await runOps([{ tool: 'x', run: async () => {} }], async ms => { waits.push(ms); await new Promise<void>(() => {}); }, () => {});
    expect(waits).toEqual([OP_TIMEOUT_MS]);
  });
});
