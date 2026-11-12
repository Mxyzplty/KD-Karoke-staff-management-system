// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 3 async catalogue boundary. Oracle: T22 notes 01:33/01:38, superseded by lane A F-1 (02:05):
// byte-hashed upload names, persisted catalogue sound duration, and no timeline changes after a partial import failure.
// Real ProjectStore/uploadToProject and local file bytes; only browser-only background prepareAsset is stubbed.
// Expected ids/order/refusal codes are written from the contract, never obtained by running a second production oracle.
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogueIds, callCatalogueTool, ensureCatalogueAsset, usesCatalogue } from '../apps/web/src/catalogue/assets';
import { findSound } from '../apps/web/src/catalogue/sounds';
import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext } from '../apps/web/src/timeline/tools';
import { createEditor } from '../apps/web/src/timeline/harness';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { assets, build, mkTrack, resetIds, useIds, video } from './t03-fixtures';

vi.mock('../apps/web/src/media/prepare', async original => ({ ...await original<typeof import('../apps/web/src/media/prepare')>(),
  prepareAsset: vi.fn(async () => 'prepared' as const) }));
beforeEach(() => useIds());
const opened: ProjectStore[] = [];
afterEach(async () => { resetIds(); vi.restoreAllMocks(); for (const store of opened.splice(0)) await store.close(); });
const json = (value: unknown) => JSON.stringify(value);
const doc = () => build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('A1', 'audio')] });
function assetFor(id: string): Asset {
  const sound = id.startsWith('sound:') ? findSound(id.slice(6)) : undefined;
  return { ...assets()[sound ? 3 : 2], id: `stored-${id}`, name: id, type: sound ? 'audio' : 'image', durationMs: sound?.durationMs ?? null } as Asset;
}
function context(overlap = false) {
  let current = doc();
  if (overlap) { current.items.push(video('occupied', 'V1', 0, 3000)); current.duration = 3000; }
  const bus = new CommandBus({ get: () => current, set: next => { current = next; } });
  const index = new Map(assets().map(a => [a.id, a]));
  const ctx: ToolContext = { bus, asset: id => index.get(id) };
  return { ctx, bus, index, get doc() { return current; } };
}
function storeSetup() {
  const files = new Map<string, Blob>(); let tick = Date.parse('2026-11-11T00:00:00Z');
  const media: MediaStore = { write: vi.fn(async (id, blob) => { files.set(id, blob); }),
    read: vi.fn(async id => { const blob = files.get(id); if (!blob) throw new Error(`Missing test bytes ${id}`); return blob; }),
    remove: vi.fn(async (_kind, id) => { files.delete(id); }), list: vi.fn(async () => [...files.keys()]) };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store);
  return { store, files, media };
}

describe('usesCatalogue / catalogueIds: detection and distinct known ids in input order', () => {
  it.each([
    { input: { assetId: 'element:sticker-star' }, ids: ['element:sticker-star'] },
    { input: { assetId: 'sound:mouse-click' }, ids: ['sound:mouse-click'] },
    { input: { assetId: 'element:missing' }, ids: [] },
    { input: { assetId: 'sound:missing' }, ids: [] },
  ])('single form $input', ({ input, ids }) => {
    expect(usesCatalogue('addMedia', input)).toBe(true); expect(catalogueIds(input)).toEqual(ids);
    expect(usesCatalogue('editProperties', input)).toBe(false);
  });
  it('mixed items[] detects unknown prefixes but returns only known ids, de-duplicated in first-seen order', () => {
    const input = { items: [{ assetId: 'asset-vid1' }, { assetId: 'sound:mouse-click' }, { assetId: 'element:missing' },
      { assetId: 'element:label-tag' }, { assetId: 'sound:mouse-click' }, { assetId: 'element:sticker-star' }, { assetId: 'element:label-tag' }] };
    expect(usesCatalogue('addMedia', input)).toBe(true);
    expect(catalogueIds(input)).toEqual(['sound:mouse-click', 'element:label-tag', 'element:sticker-star']);
  });
  it.each([undefined, {}, { assetId: 'asset-vid1' }, { items: [] }, { items: [{ assetId: 'asset-vid1' }] }])('non-catalogue %j', input => {
    expect(usesCatalogue('addMedia', input)).toBe(false); expect(catalogueIds(input)).toEqual([]);
  });
});

describe('callCatalogueTool: dry-run refusal means no ensure/import and no real run', () => {
  it.each([
    { label: 'unknown id', args: { assetId: 'element:missing', trackId: 'V1' }, code: 'VALIDATION_FAILED', nested: 'UNKNOWN_ELEMENT' },
    { label: 'known id before an unknown id', args: { trackId: 'V1', items: [{ assetId: 'element:sticker-star' }, { assetId: 'element:missing' }] }, code: 'VALIDATION_FAILED', nested: 'UNKNOWN_ELEMENT' },
    { label: 'unknown sound', args: { assetId: 'sound:missing', trackId: 'A1' }, code: 'VALIDATION_FAILED', nested: 'UNKNOWN_SOUND' },
    { label: 'bad bounds', args: { assetId: 'element:sticker-star', trackId: 'V1', bounds: { x: 0, y: 0, width: 0 } }, code: 'VALIDATION_FAILED', nested: 'INVALID_BOUNDS' },
    { label: 'wrong track', args: { assetId: 'element:label-tag', trackId: 'V1' }, code: 'INVALID_TRACK' },
    { label: 'overlap', args: { assetId: 'element:sticker-star', trackId: 'V1' }, code: 'OVERLAP_DETECTED', overlap: true },
  ])('$label', async spec => {
    const w = context(spec.overlap), before = json(w.doc), ensure = vi.fn(), run = vi.fn();
    const result = await callCatalogueTool(w.ctx, spec.args, { ensure, run });
    expect(result).toMatchObject({ success: false, code: spec.code });
    if (spec.nested) expect(result.data.failures[0].code).toBe(spec.nested);
    expect(ensure).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(json(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); expect(w.bus.redoStack).toHaveLength(0);
  });
  it('a good dry run ensures distinct ids in order, then runs once; the discovery draft never leaks', async () => {
    const w = context(), before = json(w.doc), events: string[] = [];
    const args = { trackId: 'V1', items: [{ assetId: 'element:sticker-heart' }, { assetId: 'element:sticker-star' }, { assetId: 'element:sticker-heart' }] };
    const ensure = vi.fn(async (id: string) => { expect(json(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); events.push(id); });
    const sentinel = { success: true, data: { marker: 'real-run-result' } };
    const run = vi.fn(() => { expect(json(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); events.push('run'); return sentinel; });
    expect(await callCatalogueTool(w.ctx, args, { ensure, run })).toBe(sentinel);
    expect(ensure.mock.calls.map(([id]) => id)).toEqual(['element:sticker-heart', 'element:sticker-star']); expect(run).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['element:sticker-heart', 'element:sticker-star', 'run']); expect(json(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0);
  });
  it('the real run adds exactly the requested items, with one undo (not a second copy from dry run)', async () => {
    const w = context(), before = json(w.doc), args = { trackId: 'V1', items: [{ assetId: 'element:sticker-star' }, { assetId: 'element:sticker-star' }] };
    const ensure = vi.fn(async (id: string) => { w.index.set(id, assetFor(id)); });
    const run = vi.fn(() => { expect(json(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); return callTool(w.ctx, 'addMedia', args); });
    expect((await callCatalogueTool(w.ctx, args, { ensure, run })).success).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1); expect(w.doc.items).toHaveLength(2);
    expect(w.doc.items.map(i => i.display)).toEqual([{ from: 0, to: 3000 }, { from: 3000, to: 6000 }]); expect(w.bus.labels()).toEqual(['Add media']);
  });
  it('dry run preserves pre-existing undo and redo history, not merely an empty stack', async () => {
    const w = context();
    w.bus.run('Add marker', 'user', d => { d.markers.push({ id: 'first', timeMs: 100 }); });
    w.bus.run('Add marker', 'user', d => { d.markers.push({ id: 'second', timeMs: 200 }); });
    w.bus.undo();
    const before = json(w.doc), undo = json(w.bus.undoStack), redo = json(w.bus.redoStack);
    expect(w.bus.undoStack).toHaveLength(1); expect(w.bus.redoStack).toHaveLength(1);
    const ensure = vi.fn(async () => undefined), run = vi.fn(() => ({ success: true }));
    expect(await callCatalogueTool(w.ctx, { assetId: 'element:sticker-star', trackId: 'V1' }, { ensure, run })).toEqual({ success: true });
    expect(json(w.doc)).toBe(before); expect(json(w.bus.undoStack)).toBe(undo); expect(json(w.bus.redoStack)).toBe(redo);
  });
  it.each([{ code: 'WORKSPACE_FILE_MISSING', expected: 'WORKSPACE_FILE_MISSING' }, { code: undefined, expected: 'UPLOAD_FAILED' }])(
    'ensure rejecting with $code returns $expected and operationMayHaveRun false', async ({ code, expected }) => {
      const w = context(), before = json(w.doc), error = Object.assign(new Error('disk failure'), code ? { code } : {});
      const ensure = vi.fn(async () => { throw error; }), run = vi.fn();
      const r = await callCatalogueTool(w.ctx, { assetId: 'element:sticker-star', trackId: 'V1' }, { ensure, run });
      expect(r).toMatchObject({ success: false, code: expected, operationMayHaveRun: false });
      expect(run).not.toHaveBeenCalled(); expect(ensure).toHaveBeenCalledTimes(1); expect(json(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0);
    });
  it('first known id is ensured, second ensure rejects: run is never called and document/undo/redo stay unchanged', async () => {
    const w = context();
    w.bus.run('Add marker', 'user', d => { d.markers.push({ id: 'first', timeMs: 100 }); });
    w.bus.run('Add marker', 'user', d => { d.markers.push({ id: 'second', timeMs: 200 }); });
    w.bus.undo();
    const before = json(w.doc), undo = json(w.bus.undoStack), redo = json(w.bus.redoStack);
    expect(w.bus.undoStack).toHaveLength(1); expect(w.bus.redoStack).toHaveLength(1);
    const first = 'element:sticker-star', second = 'element:sticker-heart';
    const ensure = vi.fn(async (id: string) => {
      if (id === second) throw Object.assign(new Error('second import failed'), { code: 'SECOND_IMPORT_FAILED' });
      const asset = assetFor(id); w.index.set(id, asset); return asset;
    });
    const run = vi.fn(() => ({ success: true }));
    const result = await callCatalogueTool(w.ctx, { trackId: 'V1', items: [{ assetId: first }, { assetId: second }] }, { ensure, run });
    expect(result).toMatchObject({ success: false, code: 'SECOND_IMPORT_FAILED', operationMayHaveRun: false });
    expect(ensure.mock.calls.map(([id]) => id)).toEqual([first, second]); expect(run).not.toHaveBeenCalled();
    expect(w.index.has(first)).toBe(true); expect(w.index.has(second)).toBe(false);
    expect(json(w.doc)).toBe(before); expect(json(w.bus.undoStack)).toBe(undo); expect(json(w.bus.redoStack)).toBe(redo);
  });
});

describe('ensureCatalogueAsset F-1: real store, content-addressed upload names and persistent sound length', () => {
  it.each([
    { id: 'element:sticker-star', file: 'vendor/t22/elements/sticker-star.svg', type: 'image', licence: 'AGPL-3.0-only' },
    { id: 'sound:mouse-click', file: 'vendor/t22/sounds/mouse-click.wav', type: 'audio', licence: 'CC0-1.0' },
  ])('$id uploads/links once, reuses in the same project, and links that copy to another project', async spec => {
    const { store, media } = storeSetup(), p = await store.create(), q = await store.create();
    const bytes = readFileSync(new URL(`../${spec.file}`, import.meta.url));
    const load = vi.fn(async (file: string) => { expect(file).toBe(spec.file); return new Blob([bytes], { type: spec.type === 'image' ? 'image/svg+xml' : 'audio/wav' }); });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed in this test'));
    const first = await ensureCatalogueAsset(store, p.id, spec.id, load);
    const sha8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8), ext = spec.file.split('.').pop();
    const name = `cutframe-${spec.id.replace(':', '-')}-${sha8}.${ext}`;
    expect(first).toMatchObject({ name, type: spec.type, sizeBytes: bytes.byteLength,
      source: { kind: 'stock', provider: 'cutframe', providerId: spec.id, licence: spec.licence } });
    expect((await store.library()).assets).toHaveLength(1); expect((await store.projectAssets(p.id)).map(link => link.assetId)).toEqual([first.id]);
    const again = await ensureCatalogueAsset(store, p.id, spec.id, load), other = await ensureCatalogueAsset(store, q.id, spec.id, load);
    expect(again.id).toBe(first.id); expect(other.id).toBe(first.id);
    expect((await store.library()).assets).toHaveLength(1); expect((await store.projectAssets(p.id)).map(link => link.assetId)).toEqual([first.id]);
    expect((await store.projectAssets(q.id)).map(link => link.assetId)).toEqual([first.id]); expect(media.write).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await (await media.read(first.id)).arrayBuffer())).toEqual(new Uint8Array(bytes));
    if (spec.type === 'audio') {
      const expected = findSound('mouse-click')!.durationMs;
      expect(first.durationMs).toBe(expected); expect(again.durationMs).toBe(expected); expect(other.durationMs).toBe(expected);
      expect((await store.row<Asset>('assets', first.id))?.durationMs).toBe(expected);
      expect((await store.library()).assets.find(asset => asset.id === first.id)?.durationMs).toBe(expected);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'element:sticker-star', file: 'vendor/t22/elements/sticker-star.svg' },
    { id: 'sound:mouse-click', file: 'vendor/t22/sounds/mouse-click.wav' },
  ])('F-1 $id: same id and size but different bytes create a new asset; the same bytes again reuse', async spec => {
    const { store, media } = storeSetup(), project = await store.create();
    const original = readFileSync(new URL(`../${spec.file}`, import.meta.url)), changed = Buffer.from(original);
    // One byte only: a valid SVG colour digit, or the WAV's last sample byte. No vendored file is changed.
    const offset = spec.file.endsWith('.svg') ? original.indexOf('#FFC83D') + 1 : original.length - 1;
    expect(offset).toBeGreaterThan(0);
    if (spec.file.endsWith('.svg')) changed[offset] = 0x45; else changed[offset] ^= 1; // SVG F -> E
    expect(changed.byteLength).toBe(original.byteLength);
    expect(changed.filter((byte, k) => byte !== original[k])).toHaveLength(1);
    const originalSha8 = createHash('sha256').update(original).digest('hex').slice(0, 8);
    const changedSha8 = createHash('sha256').update(changed).digest('hex').slice(0, 8);
    expect(changedSha8).not.toBe(originalSha8);
    const ext = spec.file.split('.').pop(), prefix = `cutframe-${spec.id.replace(':', '-')}`;
    const first = await ensureCatalogueAsset(store, project.id, spec.id, async () => new Blob([original]));
    const second = await ensureCatalogueAsset(store, project.id, spec.id, async () => new Blob([changed]));
    expect(first.name).toBe(`${prefix}-${originalSha8}.${ext}`); expect(second.name).toBe(`${prefix}-${changedSha8}.${ext}`);
    expect(second.id).not.toBe(first.id); expect((await store.library()).assets).toHaveLength(2);
    const again = await ensureCatalogueAsset(store, project.id, spec.id, async () => new Blob([changed]));
    const originalAgain = await ensureCatalogueAsset(store, project.id, spec.id, async () => new Blob([original]));
    expect(again.id).toBe(second.id); expect(originalAgain.id).toBe(first.id);
    expect((await store.library()).assets).toHaveLength(2); expect(media.write).toHaveBeenCalledTimes(2);
    expect((await store.projectAssets(project.id)).map(link => link.assetId)).toEqual([first.id, second.id]);
  });
  it.each([false, true])('read-back sound asset, trim beyond true length = %s', async beyond => {
    const { store } = storeSetup(), project = await store.create(), sound = findSound('mouse-click')!;
    const bytes = readFileSync(new URL(`../${sound.file}`, import.meta.url));
    const imported = await ensureCatalogueAsset(store, project.id, 'sound:mouse-click', async () => new Blob([bytes], { type: 'audio/wav' }));
    const readBack = await store.row<Asset>('assets', imported.id);
    expect(readBack?.durationMs).toBe(sound.durationMs);
    const w = context(); w.index.set('sound:mouse-click', readBack!);
    const before = json(w.doc), undo = json(w.bus.undoStack), redo = json(w.bus.redoStack);
    const result = callTool(w.ctx, 'addMedia', { assetId: 'sound:mouse-click', trackId: 'A1', ...(beyond ? { trimEnd: (sound.durationMs + 1000) / 1000 } : {}) });
    if (beyond) {
      expect(result).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
      expect(result.data.failures).toEqual([{ assetId: 'sound:mouse-click', code: 'TRIM_EXCEEDS_SOURCE',
        error: `trimEnd (${(sound.durationMs + 1000) / 1000}s) exceeds source audio duration (${sound.durationMs / 1000}s).` }]);
      expect(json(w.doc)).toBe(before); expect(json(w.bus.undoStack)).toBe(undo); expect(json(w.bus.redoStack)).toBe(redo);
    } else {
      expect(result.success, json(result)).toBe(true); expect(w.doc.items).toHaveLength(1);
      expect(w.doc.items[0]).toMatchObject({ type: 'audio', display: { from: 0, to: sound.durationMs },
        trim: { from: 0, to: sound.durationMs }, sourceDuration: sound.durationMs });
      expect(w.bus.labels()).toEqual(['Add media']);
    }
  });
});

describe('Executor addMedia catalogue seam: runtime.addCatalogue is the only import/indexing boundary', () => {
  let seq = 0;
  const call = (toolName: string, input: RecordData = {}): Call => ({ type: 'call', callId: `t22-${++seq}`, executionKey: `t22-key-${seq}`, toolName, input, session: 't22' });
  function setup() {
    const load = vi.fn(async (id: string) => assetFor(id)), e = createEditor(doc(), { options: { addCatalogue: load } });
    const add = vi.spyOn(e.runtime, 'addCatalogue'), storage = new Map<string, string>();
    const executor = new Executor({ storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } },
      current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    return { e, load, add, executor };
  }
  it('a fresh valid element call imports through runtime.addCatalogue and uses its stored asset id', async () => {
    const { e, load, add, executor } = setup();
    expect(await executor.execute(call('context'))).toMatchObject({ success: true });
    const result = await executor.execute(call('addMedia', { assetId: 'element:sticker-star', trackId: 'V1' }));
    expect(result).toMatchObject({ success: true }); expect(add).toHaveBeenCalledExactlyOnceWith('element:sticker-star'); expect(load).toHaveBeenCalledExactlyOnceWith('element:sticker-star');
    expect(e.doc.items).toHaveLength(1); expect(e.doc.items[0]).toMatchObject({ type: 'image', metadata: { assetId: 'stored-element:sticker-star' } });
    expect(e.labels()).toEqual(['Add media']);
  });
  it.each([
    { assetId: 'element:missing', trackId: 'V1', code: 'VALIDATION_FAILED' },
    { assetId: 'element:label-tag', trackId: 'V1', code: 'INVALID_TRACK' },
  ])('$code refusal never calls runtime.addCatalogue', async ({ code, ...input }) => {
    const { e, load, add, executor } = setup(); await executor.execute(call('context'));
    const before = json(e.doc), result = await executor.execute(call('addMedia', input));
    expect(result).toMatchObject({ success: false, code }); expect(add).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    expect(json(e.doc)).toBe(before); expect(e.labels()).toEqual([]);
  });
  it('the stale-read gate refuses before even the catalogue pre-step can import', async () => {
    const { e, add, executor } = setup(), before = json(e.doc);
    expect(await executor.execute(call('addMedia', { assetId: 'element:sticker-star', trackId: 'V1' }))).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED' });
    expect(add).not.toHaveBeenCalled(); expect(json(e.doc)).toBe(before); expect(e.labels()).toEqual([]);
  });
});
