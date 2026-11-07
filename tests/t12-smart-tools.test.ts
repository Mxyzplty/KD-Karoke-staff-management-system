// SPDX-License-Identifier: AGPL-3.0-only
// T12 smart-mask agent tools (contracts previewSmartMask l.600-623, trackSmartMask l.770-780, viewMaskFrame l.844-852;
// results trackSmartMask l.1225-1266): callSmartTool's contract paths — expired or unknown frameRef/selectionId,
// the source asset changing underneath a kept frame, a track range refusal, a replay returning the same mask with no
// new raster, and removeBackground returning its own code rather than throwing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, mkTrack, resetIds, video } from './t03-fixtures';
import { installMaskJobs, useMaskEngine, useMaskJobs } from '../apps/web/src/masks/jobs';
import type { MaskContext, MaskEngine } from '../apps/web/src/masks/jobs';
import { callSmartTool } from '../apps/web/src/masks/smart-tools';
import { Executor } from '../apps/web/src/agent/executor';

const asset = (id: string, durationMs: number, sha256 = 'rev-1'): Asset => ({
  id, name: `${id}.mp4`, type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId: null,
  created_at: '2026-10-01T00:00:00Z', recorded_at: null, location: `local://${id}`, durationMs, sha256,
  media: { video: { displayWidth: 1920, displayHeight: 1080, durationMs } },
} as unknown as Asset);
function ctxFor(e: ReturnType<typeof createEditor>, assets: Map<string, Asset>): MaskContext {
  return { bus: e.bus, asset: id => assets.get(id), origin: 'user' };
}
function fakeEngine() {
  const pending: { resolve(v: unknown): void; reject(e: Error): void }[] = [];
  const calls: unknown[] = [];
  const engine: MaskEngine = {
    run: (request: unknown) => { calls.push(request); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    close: (error: Error = new Error('closed')) => { for (const p of pending.splice(0)) p.reject(error); },
  };
  return { engine, calls, resolveNext: (v: unknown) => pending.shift()!.resolve(v) };
}
const flush = () => new Promise(r => setTimeout(r, 0));
/** Starts a callSmartTool call, flushes, resolves the one engine request it makes, then awaits the result. */
async function run(fake: ReturnType<typeof fakeEngine>, ctx: MaskContext, tool: string, args: Record<string, unknown>, response: unknown) {
  const p = callSmartTool(ctx, tool, args);
  await flush();
  fake.resolveNext(response);
  return p;
}

let fake: ReturnType<typeof fakeEngine>;
let uninstall: () => void;
beforeEach(() => {
  fake = fakeEngine();
  useMaskEngine(async () => fake.engine);
  uninstall = installMaskJobs({ read: async () => new Blob(['src']), writeMask: async () => undefined });
});
afterEach(() => { uninstall(); resetIds(); useMaskJobs.setState({ jobs: [] }); });

function doc() {
  return build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 4000, 0, 10_000, { metadata: { assetId: 'a1' } })] });
}

describe('the helper reaches the smart tools through the executor', () => {
  it.each(['viewMaskFrame', 'previewSmartMask', 'trackSmartMask', 'removeBackground'])('%s is dispatched, not an unknown tool', async toolName => {
    const data = new Map<string, string>(), storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const e = createEditor(doc()), ex = new Executor({ storage, current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    const r = await ex.execute({ type: 'call', callId: 'c', executionKey: `mcp:conn:${toolName}`, toolName, input: {} }) as { error?: string };
    expect(r.error ?? '').not.toMatch(/Unknown tool/);
  });
});

describe('callSmartTool contract paths', () => {
  it('an unknown or expired frameRef/selectionId: "This frame selection expired. View a fresh source frame."', async () => {
    const e = createEditor(doc());
    const ctx = ctxFor(e, new Map([['a1', asset('a1', 10_000)]]));
    await expect(callSmartTool(ctx, 'previewSmartMask', { frameRef: 'no-such-frame', strokes: [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }] }))
      .rejects.toThrow('This frame selection expired. View a fresh source frame.');
    await expect(callSmartTool(ctx, 'trackSmartMask', { selectionId: 'no-such-selection', sourceStartSeconds: 0, sourceEndSeconds: 1 }))
      .rejects.toThrow('This frame selection expired. View a fresh source frame.');
  });

  it('the selected video changing since viewMaskFrame: "The selected video changed. View its source frame again."', async () => {
    const e = createEditor(doc());
    const assets = new Map([['a1', asset('a1', 10_000, 'rev-1')]]);
    const ctx = ctxFor(e, assets);
    const frame: any = await run(fake, ctx, 'viewMaskFrame', { itemId: 'vid', timelineSeconds: 1 },
      { timeUs: 1_000_000, width: 100, height: 100, jpeg: new Blob(['x']) });
    assets.set('a1', asset('a1', 10_000, 'rev-2')); // the source asset was re-ingested, a new revision
    await expect(callSmartTool(ctx, 'previewSmartMask', { frameRef: frame.frameRef, strokes: [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }] }))
      .rejects.toThrow('The selected video changed. View its source frame again.');
  });

  it('a track range over 60 seconds is refused: "Use a source-time range up to 60 seconds, inside the video and containing the inspected frame."', async () => {
    const e = createEditor(doc());
    const ctx = ctxFor(e, new Map([['a1', asset('a1', 120_000)]]));
    const frame: any = await run(fake, ctx, 'viewMaskFrame', { itemId: 'vid', timelineSeconds: 1 },
      { timeUs: 1_000_000, width: 100, height: 100, jpeg: new Blob(['x']) });
    const selection: any = await run(fake, ctx, 'previewSmartMask', { frameRef: frame.frameRef, strokes: [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }] },
      { timeUs: frame.sourceTimeUs, width: 100, height: 100, png: new Blob(['p']), area: 0.2 });
    await expect(callSmartTool(ctx, 'trackSmartMask', { selectionId: selection.selectionId, sourceStartSeconds: 0, sourceEndSeconds: 61 }))
      .rejects.toThrow('Use a source-time range up to 60 seconds, inside the video and containing the inspected frame.');
  });

  it('tracking the same selection again returns the same mask, with no message, no raster, and no new engine call or write', async () => {
    const e = createEditor(doc());
    const ctx = ctxFor(e, new Map([['a1', asset('a1', 120_000)]]));
    const frame: any = await run(fake, ctx, 'viewMaskFrame', { itemId: 'vid', timelineSeconds: 1 },
      { timeUs: 1_000_000, width: 100, height: 100, jpeg: new Blob(['x']) });
    const selection: any = await run(fake, ctx, 'previewSmartMask', { frameRef: frame.frameRef, strokes: [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }] },
      { timeUs: frame.sourceTimeUs, width: 100, height: 100, png: new Blob(['p']), area: 0.2 });
    const first: any = await run(fake, ctx, 'trackSmartMask', { selectionId: selection.selectionId, sourceStartSeconds: 0, sourceEndSeconds: 2 },
      { file: new Blob(['x']), frameCount: 1, width: 100, height: 100 });
    expect(first).toMatchObject({ success: true, data: { itemId: 'vid', maskId: first.data.maskId, maskIndex: 0 } });
    expect(e.doc.items.find(i => i.id === 'vid')!.masks).toHaveLength(1);
    expect(fake.calls).toHaveLength(3); // frame + preview + track

    const callsBefore = fake.calls.length, undoBefore = e.bus.undoStack.length;
    const replay = await callSmartTool(ctx, 'trackSmartMask', { selectionId: selection.selectionId, sourceStartSeconds: 0, sourceEndSeconds: 2 });
    expect(replay).toEqual({ success: true, data: { itemId: 'vid', maskId: first.data.maskId } });
    expect(fake.calls).toHaveLength(callsBefore); // no new engine call
    expect(e.bus.undoStack).toHaveLength(undoBefore); // no new write
    expect(e.doc.items.find(i => i.id === 'vid')!.masks).toHaveLength(1); // nothing added
  });

  it('removeBackground returns its own {success:false, code, error} rather than throwing', async () => {
    const e = createEditor(doc());
    const ctx = ctxFor(e, new Map([['a1', asset('a1', 10_000)]]));
    const r = await callSmartTool(ctx, 'removeBackground', { itemId: 'missing' });
    expect(r).toEqual({ success: false, code: 'TIMELINE_ITEM_NOT_FOUND', error: 'Timeline item not found', message: "Timeline item for 'missing' not found." });
  });

  it('removeBackground succeeds as a smart mask, attached and reported like the others', async () => {
    const e = createEditor(doc());
    const ctx = ctxFor(e, new Map([['a1', asset('a1', 10_000)]]));
    const r: any = await run(fake, ctx, 'removeBackground', { itemId: 'vid' },
      { raster: { file: new Blob(['x']), frameCount: 1, width: 100, height: 100 }, segments: 1 });
    expect(r).toMatchObject({ success: true, data: { itemId: 'vid', maskIndex: 0 } });
    expect(e.doc.items.find(i => i.id === 'vid')!.masks[0]).toMatchObject({ selectionMode: 'auto-foreground', purpose: 'background-removal' });
  });

  it('M3: a re-ingest (sha256 change) while trackSmartMask is tracking must stop the attach, not just the caller\'s result', async () => {
    const e = createEditor(doc());
    const assets = new Map([['a1', asset('a1', 120_000, 'rev-1')]]);
    const ctx = ctxFor(e, assets);
    const frame: any = await run(fake, ctx, 'viewMaskFrame', { itemId: 'vid', timelineSeconds: 1 },
      { timeUs: 1_000_000, width: 100, height: 100, jpeg: new Blob(['x']) });
    const selection: any = await run(fake, ctx, 'previewSmartMask', { frameRef: frame.frameRef, strokes: [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }] },
      { timeUs: frame.sourceTimeUs, width: 100, height: 100, png: new Blob(['p']), area: 0.2 });
    const pending = callSmartTool(ctx, 'trackSmartMask', { selectionId: selection.selectionId, sourceStartSeconds: 0, sourceEndSeconds: 2 });
    await flush();
    assets.set('a1', asset('a1', 120_000, 'rev-2')); // re-ingested mid-track
    fake.resolveNext({ file: new Blob(['x']), frameCount: 1, width: 100, height: 100 });
    let error: any;
    try { await pending; } catch (err) { error = err; }
    expect(error?.message).toMatch(/source changed while tracking/); // the throw itself already happens today
    expect(e.doc.items.find(i => i.id === 'vid')!.masks).toHaveLength(0); // but the write must not have happened first
  });
});
