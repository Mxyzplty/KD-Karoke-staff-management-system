// SPDX-License-Identifier: AGPL-3.0-only
// T14 store-level acceptance: upload reuse/rename (part 2 §25), wizard footage (§26), interrupted uploads, preparation
// records and the §13 error codes, relink, the scripted §27 Library session and the 5-asset sort fixture (ground truth:
// expected values come from the written rules; no stored Xapp reference exists), the geocoder and the hash.
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore, uploadLock } from '../apps/web/src/store/database';
import { queryAssets } from '../apps/web/src/store/model';
import type { Asset, ProjectRecord } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { classifyPreparation, MEDIA_CODES, mediaError } from '../apps/web/src/media/codes';
import { checkUploadable, parseAllowedPath, renamedName } from '../apps/web/src/media/files';
import { createProjectWithFootage, findDuplicates, relinkOriginal, scanMissing, uploadToLibrary, uploadToProject } from '../apps/web/src/media/ingest';
import { prepareAsset, preparationBudgetMs, prepareLock, resumePreparations, RETRY_BUDGET, scanInterrupted } from '../apps/web/src/media/prepare';
import type { PreparationRecord, Steps } from '../apps/web/src/media/prepare';
import { withLock } from '../apps/web/src/media/locks';
import { probeMedia } from '../apps/web/src/media/probe';
import { awaitProxy, resolveSource } from '../apps/web/src/media/resolver';
import { placeName } from '../apps/web/src/media/geocode';
import { Sha256 } from '../apps/web/src/media/sha256';
import { bytes, ffmpegAvailable, hasStore, media, STORE } from './media-fixtures';

const opened: ProjectStore[] = [];
// Strictly increasing clock: project links are ordered by added_at (two links in one millisecond would tie).
let tick = Date.parse('2026-10-28T00:00:00Z');
function setup(clock = () => tick++) {
  const files = new Map<string, Blob>(), proxies = new Map<string, Blob>();
  const store_: MediaStore = {
    write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => { const b = files.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; }),
    remove: vi.fn(async (kind, id) => { if (kind === 'asset') { files.delete(id); proxies.delete(id); } }), list: vi.fn(async () => [...files.keys()]),
    writeProxy: vi.fn(async (id, blob) => { proxies.set(id, blob); }), readProxy: vi.fn(async id => { const b = proxies.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; }),
  };
  const store = new ProjectStore(crypto.randomUUID(), clock, store_); opened.push(store); return { store, files, proxies, media: store_ };
}
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
const file = (name: string, content = 'synthetic bytes', type = '') => new File([content], name, { type });
/** Fast steps: a fixed probe result, no decode (decoding is covered in Chromium). */
const fake = (extra: Partial<Steps> = {}): Partial<Steps> => ({ probe: async () => ({ container: 'mp4', mimeType: 'video/mp4', durationMs: 3000, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null }), ...extra });
const asset = (store: ProjectStore, id: string) => store.row<Asset>('assets', id);
/** Hand-driven timers (fake-indexeddb itself relies on real timers, so vi fake timers would stall storage). */
function manualTimers() {
  const timeouts = new Map<number, { at: number; run: () => void }>(), intervals = new Map<number, () => void>(); let id = 0, now = 0;
  const timers = {
    setTimeout: ((run: () => void, ms: number) => { timeouts.set(++id, { at: now + ms, run }); return id; }) as unknown as typeof setTimeout,
    clearTimeout: ((t: number) => { timeouts.delete(t); }) as typeof clearTimeout,
    setInterval: ((run: () => void) => { intervals.set(++id, run); return id; }) as unknown as typeof setInterval,
    clearInterval: ((t: number) => { intervals.delete(t); }) as typeof clearInterval,
  };
  return { timers, heartbeat: () => { for (const run of intervals.values()) run(); }, advance: (ms: number) => { now += ms; for (const [k, t] of [...timeouts]) if (t.at <= now) { timeouts.delete(k); t.run(); } } };
}

describe('T14 upload rules (part 2 §25, §26)', () => {
  it('Library page: "a.mp4" twice offers a_1.mp4; Skip Duplicates and Upload & Rename both work', async () => {
    const { store } = setup();
    await uploadToLibrary(store, [file('a.mp4')], async () => { throw new Error('no dialog expected'); }, { prepare: false });
    const offered: string[][] = [];
    const skipped = await uploadToLibrary(store, [file('a.mp4')], async d => { offered.push(d.map(x => `${x.original} → ${x.renamed}`)); return 'skip'; }, { prepare: false });
    expect(offered).toEqual([['a.mp4 → a_1.mp4']]); expect(skipped.skipped).toHaveLength(1); expect((await store.library()).assets.map(a => a.name)).toEqual(['a.mp4']);
    const renamed = await uploadToLibrary(store, [file('a.mp4')], async () => 'rename', { prepare: false });
    expect(renamed.assets.map(a => [a.name, a.originalName])).toEqual([['a_1.mp4', 'a.mp4']]);
    expect(findDuplicates([file('a.mp4'), file('a.mp4')], (await store.library()).assets).map(d => d.renamed)).toEqual(['a_2.mp4', 'a_3.mp4']);
    expect(renamedName('clip.final.mov', new Set(['clip.final_1.mov']))).toBe('clip.final_2.mov'); expect(renamedName('noext', new Set())).toBe('noext_1');
  });
  it('inside a project, same original name + exact size links the existing asset; no second asset; a different size uploads', async () => {
    const { store } = setup(), p = await store.create();
    const first = await uploadToLibrary(store, [file('a.mp4', '12345')], async () => 'rename', { prepare: false });
    const r = await uploadToProject(store, p.id, [file('a.mp4', '12345'), file('a.mp4', '123456')], { prepare: false });
    expect(r.reused).toEqual([first.assets[0].id]); expect(r.uploaded).toHaveLength(1);
    expect((await store.library()).assets).toHaveLength(2);
    expect((await store.projectAssets(p.id)).map(l => [l.assetId, l.agent_id])).toEqual([[first.assets[0].id, 'video_1'], [r.uploaded[0], 'video_2']]);
  });
  it('wizard: 3 files, 1 a name+size duplicate → 2 new uploads + 1 reused, no dialog, all 3 linked as footage; project uploading → ready', async () => {
    const { store } = setup();
    const lib = await uploadToLibrary(store, [file('dup.mp4', 'same')], async () => 'rename', { prepare: false });
    const statuses: string[] = []; const swap = store.swapRow.bind(store);
    vi.spyOn(store, 'swapRow').mockImplementation(async (s, k, change) => { const r = await swap(s, k, change as never); if (s === 'projects' && r) statuses.push((r as unknown as ProjectRecord).processing_status); return r; });
    const { project, result } = await createProjectWithFootage(store, [file('one.mp4'), file('dup.mp4', 'same'), file('two.png', 'png')], [], { prepare: false });
    expect(statuses).toEqual(['uploading', 'ready']);
    expect(result.uploaded).toHaveLength(2); expect(result.reused).toEqual([lib.assets[0].id]); expect(result.failed).toEqual([]);
    expect((await store.projectAssets(project.id)).map(l => l.agent_id)).toEqual(['video_1', 'video_2', 'image_1']);
    expect((await store.library()).assets).toHaveLength(3);
    expect((await store.read(project.id))?.document.items).toEqual([]); // placement on the timeline is T03's
  });
  it('allowed extensions, RAW, empty and unreadable files are refused with their §13 codes', async () => {
    await expect(checkUploadable(file('x.cr2', 'raw'))).rejects.toMatchObject({ code: 'UNSUPPORTED_RAW', category: 'user_error' });
    await expect(checkUploadable(file('x.exe', 'mz'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(checkUploadable(file('x.mp4', ''))).rejects.toMatchObject({ code: 'EMPTY_OBJECT' });
    const gone = file('gone.mov', 'bytes'); vi.spyOn(gone, 'slice').mockReturnValue({ arrayBuffer: () => Promise.reject(new DOMException('moved', 'NotReadableError')) } as never);
    await expect(checkUploadable(gone)).rejects.toMatchObject({ code: 'SOURCE_FILE_UNREADABLE', message: 'A file could no longer be read. Pick it again.' });
    for (const name of ['a.mkv', 'a.m4v', 'a.heic', 'a.tiff', 'a.mp3', 'a.flac']) await expect(checkUploadable(file(name))).resolves.toBeTruthy();
  });
  it('a target project deleted mid-queue: PROJECT_NOT_FOUND for that file, UPLOAD_CANCELLED for the rest; cancel-all also cancels', async () => {
    const { store } = setup(), p = await store.create(); const attach = store.attach.bind(store); let n = 0;
    vi.spyOn(store, 'attach').mockImplementation(async (projectId, id) => { if (++n === 2) await store.deleteProject(projectId); return attach(projectId, id); });
    const r = await uploadToProject(store, p.id, [file('1.mp4'), file('2.mp4'), file('3.mp4')], { prepare: false });
    expect(r.failed.map(f => (f.error as unknown as { code: string }).code)).toEqual(['PROJECT_NOT_FOUND', 'UPLOAD_CANCELLED']);
    expect(r.failed[1].error.message).toBe('The project for this upload was deleted');
    const q = await store.create(), controller = new AbortController(); controller.abort();
    expect((await uploadToProject(store, q.id, [file('4.mp4')], { prepare: false, signal: controller.signal })).failed[0].error).toMatchObject({ code: 'UPLOAD_CANCELLED', message: 'Upload cancelled', category: 'user_error' });
  });
  it('a write failure that is not a quota error is UPLOAD_FAILED and leaves no record', async () => {
    const { store, media: m } = setup(); vi.mocked(m.write).mockRejectedValueOnce(new Error('disk detached'));
    const r = await uploadToLibrary(store, [file('x.mp4')], async () => 'rename', { prepare: false });
    expect(r.failed[0].error).toMatchObject({ code: 'UPLOAD_FAILED', category: 'system_error' }); expect((await store.library()).assets).toEqual([]);
  });
  it('a stored object shorter than the picked file is EMPTY_OBJECT (cut off)', async () => {
    const { store, media: m, files } = setup(); vi.mocked(m.write).mockImplementationOnce(async (id, b) => { files.set(id, b.slice(0, 3)); });
    const r = await uploadToLibrary(store, [file('cut.mp4', 'abcdefgh')], async () => 'rename', { prepare: false });
    expect(r.failed[0].error).toMatchObject({ code: 'EMPTY_OBJECT', message: 'File is empty or was cut off during upload.' });
  });
});
describe('T14 interrupted uploads, preparation records and §13 codes', () => {
  it('a record whose bytes never landed → UPLOAD_INTERRUPTED on next load; partial and orphan bytes are removed; live uploads are left alone', async () => {
    const { store, files } = setup(), now = new Date().toISOString();
    const base: Asset = { id: 'lost', name: 'lost.mp4', type: 'video', sizeBytes: 10, mimeType: 'video/mp4', folderId: null, created_at: now, recorded_at: null, location: null, durationMs: null, processing_status: 'uploading', processing_steps: { upload: 'processing' } };
    await store.putRow('assets', base); files.set('lost', new Blob(['par'])); files.set('orphan', new Blob(['x']));
    await store.putRow('assets', { ...base, id: 'live' });
    let release!: () => void; const hold = withLock(uploadLock('live'), () => new Promise<void>(r => { release = r; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const r = await store.recoverInterrupted(); release(); await hold;
    expect(r).toEqual({ interrupted: ['lost'], orphans: ['orphan'], proxies: [] });
    expect(await asset(store, 'lost')).toMatchObject({ processing_status: 'failed', last_error_code: 'UPLOAD_INTERRUPTED', last_error_message: 'Upload was interrupted before it finished. Re-upload this file.' });
    expect(files.has('lost')).toBe(false); expect(files.has('orphan')).toBe(false); expect((await asset(store, 'live'))?.processing_status).toBe('uploading');
  });
  it('a successful preparation records metadata, steps, sha256 and ready; analysis/transcription stay "unavailable" (no provider)', async () => {
    const { store } = setup(); const a = (await uploadToLibrary(store, [file('a.mp4', 'abc')], async () => 'rename', { prepare: false })).assets[0];
    expect(a.sha256).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(await prepareAsset(store, a.id, { steps: fake() })).toBe('prepared');
    expect(await asset(store, a.id)).toMatchObject({ processing_status: 'ready', durationMs: 3000, last_error_code: null, processing_steps: { upload: 'complete', probe: 'complete', analysis: 'unavailable', transcription: 'unavailable' } });
  });
  it('budget: 4 × duration + 2 min clamped to 5–30 min; over budget → CLIENT_PREPARATION_TIMEOUT (injected clock)', async () => {
    expect([0, 30_000, 60_000, 600_000, 3_600_000].map(preparationBudgetMs)).toEqual([300_000, 300_000, 360_000, 1_800_000, 1_800_000]);
    const { store } = setup(), clock = manualTimers(); const a = (await uploadToLibrary(store, [file('slow.mp4')], async () => 'rename', { prepare: false })).assets[0];
    const run = prepareAsset(store, a.id, { steps: fake({ probe: () => new Promise(() => {}) }), timers: clock.timers });
    await vi.waitFor(async () => expect((await store.row<PreparationRecord>('preparations', a.id))?.phase).toBe('running'));
    clock.advance(299_999); await new Promise(r => setTimeout(r, 20)); expect((await asset(store, a.id))?.last_error_code).toBeNull();
    clock.advance(1);
    expect(await run).toBe('failed');
    expect(await asset(store, a.id)).toMatchObject({ last_error_code: 'CLIENT_PREPARATION_TIMEOUT', last_error_message: 'Video preparation took too long. Retry this file to continue.' });
  });
  it('cancel → CLIENT_PREPARATION_CANCELLED; another attempt taking over → ATTEMPT_CHANGED; a closed attempt → ATTEMPT_FINISHED', async () => {
    const { store } = setup(); const [a, b, c] = (await uploadToLibrary(store, [file('a.mp4'), file('b.mp4'), file('c.mp4')], async () => 'rename', { prepare: false })).assets;
    const controller = new AbortController();
    const cancelled = prepareAsset(store, a.id, { signal: controller.signal, steps: fake({ probe: () => new Promise(() => {}) }) });
    await vi.waitFor(async () => expect((await store.row<PreparationRecord>('preparations', a.id))?.phase).toBe('running'));
    controller.abort(); expect(await cancelled).toBe('failed');
    expect(await asset(store, a.id)).toMatchObject({ last_error_code: 'CLIENT_PREPARATION_CANCELLED' });
    expect((await store.row<PreparationRecord>('preparations', a.id))?.phase).toBe('cancelled');
    // Takeover between probe and publish: the record now names another attempt; this one aborts and does not write.
    const took = prepareAsset(store, b.id, { steps: fake({ probe: async () => { await store.swapRow<PreparationRecord>('preparations', b.id, r => ({ ...r!, attemptId: 'other-tab' })); return (await fake().probe!(new Blob(), {} as Asset)); } }) });
    expect(await took).toBe('failed'); expect((await asset(store, b.id))?.last_error_code).toBeNull();
    const finished = prepareAsset(store, c.id, { steps: fake({ probe: async () => { await store.swapRow<PreparationRecord>('preparations', c.id, r => ({ ...r!, phase: 'finished' })); return (await fake().probe!(new Blob(), {} as Asset)); } }) });
    expect(await finished).toBe('failed');
    expect(classifyPreparation(mediaError('LOCAL_PREPARATION_ATTEMPT_CHANGED'))).toBe('LOCAL_PREPARATION_ATTEMPT_CHANGED');
  });
  it('heartbeat: ATTEMPT_CHANGED from the 30 s heartbeat; a failed heartbeat write → CONTROL_FAILED', async () => {
    const { store } = setup(); const [a, b, c] = (await uploadToLibrary(store, [file('a.mp4'), file('b.mp4'), file('c.mp4')], async () => 'rename', { prepare: false })).assets;
    const hang = fake({ probe: () => new Promise(() => {}) });
    const t1 = manualTimers(), first = prepareAsset(store, a.id, { steps: hang, timers: t1.timers });
    await vi.waitFor(async () => expect((await store.row<PreparationRecord>('preparations', a.id))?.phase).toBe('running'));
    await store.swapRow<PreparationRecord>('preparations', a.id, r => ({ ...r!, attemptId: 'other-tab' }));
    t1.heartbeat(); expect(await first).toBe('failed'); expect((await asset(store, a.id))?.last_error_code).toBeNull();
    const t2 = manualTimers(), second = prepareAsset(store, b.id, { steps: hang, timers: t2.timers });
    await vi.waitFor(async () => expect((await store.row<PreparationRecord>('preparations', b.id))?.phase).toBe('running'));
    // The next preparations write (the heartbeat) fails; later writes work again.
    const swap = store.swapRow.bind(store); let failNext = true;
    vi.spyOn(store, 'swapRow').mockImplementation(async (s, k, f) => { if (s === 'preparations' && failNext) { failNext = false; throw new DOMException('closing', 'InvalidStateError'); } return swap(s, k, f as never); });
    t2.heartbeat(); expect(await second).toBe('failed');
    expect(await asset(store, b.id)).toMatchObject({ last_error_code: 'LOCAL_PREPARATION_CONTROL_FAILED' });
    vi.restoreAllMocks();
    // A heartbeat write that does not answer within 20 s is CONTROL_FAILED too.
    const t3 = manualTimers(), third = prepareAsset(store, c.id, { steps: hang, timers: t3.timers });
    await vi.waitFor(async () => expect((await store.row<PreparationRecord>('preparations', c.id))?.phase).toBe('running'));
    let hangNext = true;
    vi.spyOn(store, 'swapRow').mockImplementation(async (s, k, f) => { if (s === 'preparations' && hangNext) { hangNext = false; return new Promise(() => {}); } return swap(s, k, f as never); });
    t3.heartbeat(); await new Promise(r => setTimeout(r, 10)); t3.advance(20_000); expect(await third).toBe('failed');
    vi.restoreAllMocks();
    expect(await asset(store, c.id)).toMatchObject({ last_error_code: 'LOCAL_PREPARATION_CONTROL_FAILED' });
  });
  it('a live preparation elsewhere → ALREADY_ACTIVE, which a re-prepare treats as success', async () => {
    const { store } = setup(); const a = (await uploadToLibrary(store, [file('a.mp4')], async () => 'rename', { prepare: false })).assets[0];
    let release!: () => void;
    const other = withLock(prepareLock(a.id), async () => { await store.putRow<PreparationRecord>('preparations', { id: a.id, attemptId: 'tab-2', phase: 'running', startedAt: Date.now(), updatedAt: Date.now(), sourceRevision: a.sha256 ?? null, budgetMs: 300_000 }); await new Promise<void>(r => { release = r; }); });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await prepareAsset(store, a.id, { steps: fake() })).toBe('already-active');
    expect((await asset(store, a.id))?.last_error_code).toBeNull(); release(); await other;
  });
  it('original changed in another session before publish → SOURCE_CHANGED; publishing write fails → PUBLICATION_FAILED', async () => {
    const { store } = setup(); const [a, b] = (await uploadToLibrary(store, [file('a.mp4'), file('b.mp4')], async () => 'rename', { prepare: false })).assets;
    const changed = fake({ probe: async () => { await store.updateAsset(a.id, x => ({ ...x, sha256: 'different' })); return fake().probe!(new Blob(), {} as Asset); } });
    expect(await prepareAsset(store, a.id, { steps: changed })).toBe('failed');
    expect(await asset(store, a.id)).toMatchObject({ last_error_code: 'LOCAL_PREPARATION_SOURCE_CHANGED', last_error_message: 'This original changed in another session. Preparation was stopped; retry the current original.' });
    // The probe-metadata publication (the first owner-checked write that requires the source revision) fails once.
    const write = store.ownerWrite.bind(store); let calls = 0;
    vi.spyOn(store, 'ownerWrite').mockImplementation(async (id, attempt, w) => { if (id === b.id && w.sourceRevision !== undefined && !calls++) throw new DOMException('full', 'UnknownError'); return write(id, attempt, w); });
    expect(await prepareAsset(store, b.id, { steps: fake() })).toBe('failed');
    expect((await asset(store, b.id))?.last_error_code).toBe('LOCAL_PREPARATION_PUBLICATION_FAILED');
  });
  it('a running record whose tab is gone, or silent for 10 min, → CLIENT_PREPARATION_INTERRUPTED on load', async () => {
    const { store } = setup(), now = Date.now(); const [a, b] = (await uploadToLibrary(store, [file('a.mp4'), file('b.mp4')], async () => 'rename', { prepare: false })).assets;
    await store.putRow<PreparationRecord>('preparations', { id: a.id, attemptId: 'closed-tab', phase: 'running', startedAt: now, updatedAt: now, sourceRevision: null, budgetMs: 300_000 });
    let release!: () => void;
    const hung = withLock(`cutframe-prepare-attempt:${b.id}:hung`, async () => { await store.putRow<PreparationRecord>('preparations', { id: b.id, attemptId: 'hung', phase: 'running', startedAt: now, updatedAt: now - 600_001, sourceRevision: null, budgetMs: 300_000 }); await new Promise<void>(r => { release = r; }); });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await scanInterrupted(store, () => now)).sort()).toEqual([a.id, b.id].sort()); release(); await hung;
    expect(await asset(store, a.id)).toMatchObject({ last_error_code: 'CLIENT_PREPARATION_INTERRUPTED', last_error_message: 'Preparation stopped on your device. Retry using the original file.' });
  });
  it('failure classes: probe refusal → DEMUX_UNSUPPORTED, decode → DECODE_UNSUPPORTED, proxy encode → ENCODE_FAILED (original still usable), other → EXTRACTION_FAILED', async () => {
    const { store } = setup(); const [a, b, c, d] = (await uploadToLibrary(store, ['a', 'b', 'c', 'd'].map(n => file(`${n}.mp4`)), async () => 'rename', { prepare: false })).assets;
    await prepareAsset(store, a.id, { steps: { probe: () => Promise.reject(mediaError('UNSUPPORTED_INPUT')) } });
    await prepareAsset(store, b.id, { steps: fake({ thumbnails: () => Promise.reject(mediaError('DECODE_ERROR')) }) });
    const video = { ...await fake().probe!(new Blob(), {} as Asset), video: { codec: 'avc' } as never };
    await prepareAsset(store, c.id, { steps: { probe: async () => video, proxy: () => Promise.reject(new Error('VideoEncoder error: encoding failed')) } });
    await prepareAsset(store, d.id, { steps: { probe: async () => video, proxy: () => Promise.reject(new Error('weird')) } });
    expect((await asset(store, a.id))).toMatchObject({ processing_status: 'failed', last_error_code: 'DEMUX_UNSUPPORTED' });
    expect((await asset(store, b.id))).toMatchObject({ processing_status: 'failed', last_error_code: 'DECODE_UNSUPPORTED' });
    expect((await asset(store, c.id))).toMatchObject({ processing_status: 'ready', last_error_code: 'ENCODE_FAILED', processing_steps: { proxy: 'failed' } });
    expect((await asset(store, d.id))).toMatchObject({ processing_status: 'ready', last_error_code: 'EXTRACTION_FAILED' });
  });
  it('failing analysis / transcription steps record GEMINI_FAILED / TRANSCRIPTION_FAILED in processing_steps and last_error_code (real triggers: T19)', async () => {
    const { store } = setup(); const [a, b] = (await uploadToLibrary(store, [file('a.mp4'), file('b.mp4')], async () => 'rename', { prepare: false })).assets;
    await prepareAsset(store, a.id, { steps: fake({ analysis: () => Promise.reject(new Error('model failed')) }) });
    await prepareAsset(store, b.id, { steps: fake({ analysis: async () => {}, transcription: () => Promise.reject(new Error('asr failed')) }) });
    expect(await asset(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED', processing_steps: { analysis: 'failed' } });
    expect(await asset(store, b.id)).toMatchObject({ last_error_code: 'TRANSCRIPTION_FAILED', last_error_message: 'Transcription failed — retry to try again.', processing_steps: { analysis: 'complete', transcription: 'failed' } });
  });
  it('stored original gone → OBJECT_MISSING; unfinished upload → SOURCE_MISSING; automatic retries stop at RETRY_LIMIT_EXCEEDED', async () => {
    const { store, files } = setup(); const [a, b, c] = (await uploadToLibrary(store, ['a', 'b', 'c'].map(n => file(`${n}.mp4`)), async () => 'rename', { prepare: false })).assets;
    files.delete(a.id); await prepareAsset(store, a.id, { steps: fake() });
    expect(await asset(store, a.id)).toMatchObject({ last_error_code: 'OBJECT_MISSING', last_error_message: 'Original file is missing from storage.' });
    await store.updateAsset(b.id, x => ({ ...x, processing_steps: { upload: 'processing' } }));
    await prepareAsset(store, b.id, { steps: fake() }); expect((await asset(store, b.id))?.last_error_code).toBe('SOURCE_MISSING');
    const failing = { probe: () => Promise.reject(new Error('flaky')) };
    for (let n = 0; n < RETRY_BUDGET + 1; n++) await resumePreparations(store, { steps: failing });
    expect(await asset(store, c.id)).toMatchObject({ preparationAttempts: RETRY_BUDGET, last_error_code: 'RETRY_LIMIT_EXCEEDED', last_error_message: 'Processing failed after several attempts.' });
  });
  it('resolver: per-item Use Proxy → proxy, off → original, export → original; missing original → WORKSPACE_FILE_MISSING; PROXY_TIMEOUT', async () => {
    const { store, files } = setup(); const a = (await uploadToLibrary(store, [file('a.mp4', 'original')], async () => 'rename', { prepare: false })).assets[0];
    const video = { ...await fake().probe!(new Blob(), {} as Asset), video: { codec: 'avc', displayWidth: 64, displayHeight: 36 } as never };
    await prepareAsset(store, a.id, { steps: { probe: async () => video, proxy: async () => ({ blob: new Blob(['proxy']), codec: 'avc', container: 'mp4', width: 32, height: 18 }) } });
    const item = { metadata: { assetId: a.id }, details: {} };
    expect(await (await resolveSource(store, item)).blob.text()).toBe('proxy');
    expect((await resolveSource(store, { ...item, details: { useProxy: false } })).kind).toBe('original');
    expect((await resolveSource(store, item, 'export')).kind).toBe('original');
    expect((await awaitProxy(store, a.id, 1000)).width).toBe(32);
    const b = (await uploadToLibrary(store, [file('b.mp4')], async () => 'rename', { prepare: false })).assets[0]; let t = 0;
    await expect(awaitProxy(store, b.id, 5000, () => (t += 3000), async () => {})).rejects.toMatchObject({ code: 'PROXY_TIMEOUT', category: 'timeout' });
    files.delete(b.id);
    await expect(resolveSource(store, { metadata: { assetId: b.id }, details: { useProxy: false } })).rejects.toMatchObject({ code: 'WORKSPACE_FILE_MISSING', category: 'system_error' });
  });
  it('relink: missing original shows OBJECT_MISSING; same bytes → restored; different bytes → WORKSPACE_ORIGINAL_MISMATCH (size first, then SHA-256)', async () => {
    const { store, files } = setup(); const a = (await uploadToLibrary(store, [file('a.mp4', 'original!')], async () => 'rename', { prepare: false })).assets[0];
    files.delete(a.id); expect(await scanMissing(store)).toEqual([a.id]); expect((await asset(store, a.id))?.last_error_code).toBe('OBJECT_MISSING');
    await expect(relinkOriginal(store, a.id, file('a.mp4', 'short'))).rejects.toMatchObject({ code: 'WORKSPACE_ORIGINAL_MISMATCH', category: 'user_error' });
    await expect(relinkOriginal(store, a.id, file('a.mp4', 'Original!'))).rejects.toMatchObject({ code: 'WORKSPACE_ORIGINAL_MISMATCH', message: 'This file has different contents from the original. Select the original file, or import it as a new asset.' });
    expect((await relinkOriginal(store, a.id, file('renamed-elsewhere.mp4', 'original!'))).last_error_code).toBeNull();
    expect(await files.get(a.id)!.text()).toBe('original!'); expect(await scanMissing(store)).toEqual([]);
  });
  it('every T14 code in the table has a category and a message', () => {
    for (const [code, row] of Object.entries(MEDIA_CODES)) { expect(['precondition', 'user_error', 'system_error', 'timeout']).toContain(row.category); expect(row.message.length, code).toBeGreaterThan(5); }
  });
});
describe('T14 Library: scripted §27 session and the 5-asset sort fixture (ground truth from the written rules)', () => {
  it('2 nested folders, move 5 assets, delete-folder-only, attach/remove/re-attach, delete-everything', async () => {
    const { store } = setup(), p = await store.create();
    const outer = await store.createFolder('Outer'), inner = await store.createFolder('Inner', outer.id);
    const [a, b, c, d, e] = (await uploadToLibrary(store, ['a.mp4', 'b.mp4', 'c.png', 'd.mp3', 'e.mp4'].map(n => file(n)), async () => 'rename', { prepare: false })).assets;
    await store.moveAssets([a.id, b.id, c.id], inner.id); await store.moveAssets([d.id, e.id], outer.id);
    const where = async () => Object.fromEntries((await store.library()).assets.map(x => [x.name, x.folderId === inner.id ? 'Outer/Inner' : x.folderId === outer.id ? 'Outer' : x.folderId ?? 'root']));
    expect(await where()).toEqual({ 'a.mp4': 'Outer/Inner', 'b.mp4': 'Outer/Inner', 'c.png': 'Outer/Inner', 'd.mp3': 'Outer', 'e.mp4': 'Outer' });
    const ids = async () => (await store.projectAssets(p.id)).map(l => l.agent_id);
    for (const x of [a, c, d, e]) await store.attach(p.id, x.id);
    expect(await ids()).toEqual(['video_1', 'image_1', 'audio_1', 'video_2']);
    // Delete folder only: Inner's assets move up to its parent (Outer); the tree loses Inner.
    await store.deleteFolder(inner.id, false);
    expect(await where()).toEqual({ 'a.mp4': 'Outer', 'b.mp4': 'Outer', 'c.png': 'Outer', 'd.mp3': 'Outer', 'e.mp4': 'Outer' });
    expect((await store.library()).folders.map(f => [f.name, f.parentId])).toEqual([['Outer', null]]);
    // Remove and re-attach restores the old agent_id; a new asset of the same type takes the next number.
    await store.detach(p.id, a.id); expect(await ids()).toEqual(['image_1', 'audio_1', 'video_2']);
    await store.attach(p.id, a.id); expect(await ids()).toEqual(['video_1', 'image_1', 'audio_1', 'video_2']);
    await store.attach(p.id, b.id); expect((await store.projectAssets(p.id)).at(-1)?.agent_id).toBe('video_3');
    // Delete everything: every asset of the tree goes, then the folder; ids are never recycled.
    await store.deleteFolder(outer.id, true);
    expect((await store.library()).assets).toEqual([]); expect((await store.library()).folders).toEqual([]); expect(await ids()).toEqual([]);
    const f = (await uploadToLibrary(store, [file('f.mp4')], async () => 'rename', { prepare: false })).assets[0];
    expect((await store.attach(p.id, f.id)).agent_id).toBe('video_4');
  });
  it.skipIf(!ffmpegAvailable())('5 assets with measured capture dates (two undated): Uploaded/Recorded × DESC/ASC; undated last, ties newest upload first', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z'); const { store } = setup(() => now);
    const names = ['dated-2025-05-01T10_00_00Z.mp4', 'undated.mp4', 'dated-2024-01-01T00_00_00Z.mp4', 'dated-2025-05-01T10_00_00Z-copy.mp4', 'still.png'];
    const make = (n: string) => n === 'still.png' ? new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0])], n) : new File([bytes(media(n.replace('-copy', '')))], n);
    const ids: string[] = [];
    for (const n of names) { now += 3_600_000; const a = (await uploadToLibrary(store, [make(n)], async () => 'rename', { prepare: false })).assets[0]; ids.push(a.id); await prepareAsset(store, a.id, { steps: { probe: (blob, x) => probeMedia(blob, x.name, x.type) } }); }
    const assets = (await store.library()).assets, order = (sort: 'uploaded' | 'recorded', direction: 'ASC' | 'DESC') => queryAssets(assets, { folderId: null, sort, direction }).map(a => names[ids.indexOf(a.id)]);
    expect(assets.map(a => [a.name, a.recorded_at]).sort()).toEqual([['dated-2024-01-01T00_00_00Z.mp4', '2024-01-01T00:00:00.000Z'], ['dated-2025-05-01T10_00_00Z-copy.mp4', '2025-05-01T10:00:00.000Z'], ['dated-2025-05-01T10_00_00Z.mp4', '2025-05-01T10:00:00.000Z'], ['still.png', null], ['undated.mp4', null]]);
    expect(order('uploaded', 'DESC')).toEqual([...names].reverse()); expect(order('uploaded', 'ASC')).toEqual(names);
    expect(order('recorded', 'DESC')).toEqual(['dated-2025-05-01T10_00_00Z-copy.mp4', 'dated-2025-05-01T10_00_00Z.mp4', 'dated-2024-01-01T00_00_00Z.mp4', 'still.png', 'undated.mp4']);
    expect(order('recorded', 'ASC')).toEqual(['dated-2024-01-01T00_00_00Z.mp4', 'dated-2025-05-01T10_00_00Z-copy.mp4', 'dated-2025-05-01T10_00_00Z.mp4', 'still.png', 'undated.mp4']);
  });
  it.skipIf(!ffmpegAvailable())('location filter: GPS → local geocoder place; "amsterdam" matches, "new york" does not (CI: MP4 loci)', async () => {
    const { store } = setup(); const a = (await uploadToLibrary(store, [new File([bytes(media('h264-aac.mp4'))], 'boat.mp4')], async () => 'rename', { prepare: false })).assets[0];
    await prepareAsset(store, a.id, { steps: { probe: (blob, x) => probeMedia(blob, x.name, x.type) } });
    const stored = (await asset(store, a.id))!; expect(stored.location).toBe('Amsterdam, The Netherlands');
    expect(queryAssets([stored], { folderId: null, location: 'amsterdam' })).toHaveLength(1); expect(queryAssets([stored], { folderId: null, location: 'new york' })).toHaveLength(0);
  });
  it.skipIf(!hasStore)('the amsterdam jpg (store, EXIF 52.369630 N 4.899883 E) is placed in Amsterdam', async () => {
    const { store } = setup(); const jpg = new File([bytes(`${STORE}/corpus/amsterdam-houseboat-exif.jpg`)], 'amsterdam-houseboat-exif.jpg', { type: 'image/jpeg' });
    const a = (await uploadToLibrary(store, [jpg], async () => 'rename', { prepare: false })).assets[0];
    await prepareAsset(store, a.id, { steps: { probe: (blob, x) => probeMedia(blob, x.name, x.type) } });
    const stored = (await asset(store, a.id))!;
    expect(stored).toMatchObject({ recorded_at: '2017-06-23T16:19:32.000Z', location: 'Amsterdam, The Netherlands' });
    expect(queryAssets([stored], { folderId: null, location: 'AMSTERDAM' })).toHaveLength(1); expect(queryAssets([stored], { folderId: null, location: 'new york' })).toHaveLength(0);
  });
  it('geocoder: nearest place within 100 km; open sea is null', async () => {
    expect(await placeName(40.7128, -74.006)).toBe('New York City, United States');
    expect(await placeName(1.29, 103.85)).toMatch(/Singapore$/);
    expect(await placeName(0, -30)).toBeNull(); expect(await placeName(null, 4)).toBeNull();
  });
});
describe('T14 helpers', () => {
  it('SHA-256 matches node:crypto at block boundaries', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255), h = new Sha256();
      h.update(data.subarray(0, n >> 1)); h.update(data.subarray(n >> 1));
      expect(h.digest()).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
  it('allowed-folder path validator: `<folder-name>/<sub/path>`, no `..`, `.`, absolute paths or backslashes', () => {
    expect(parseAllowedPath('Clips/day 1/a.mp4')).toEqual({ folder: 'Clips', segments: ['day 1', 'a.mp4'] });
    expect(parseAllowedPath('Clips')).toEqual({ folder: 'Clips', segments: [] });
    for (const bad of ['../etc/passwd', 'Clips/../x', 'Clips/./x', '/abs/x', 'C:/x', 'C:\\x', 'Clips\\x', 'file:///x'])
      expect(parseAllowedPath(bad)).toMatchObject({ error: 'path_traversal_blocked' });
  });
});
