// SPDX-License-Identifier: AGPL-3.0-only
// T19 C11: AnalysisService.rhythm(store, asset, decode): stored row first, then require('beats') → decode → worker 'beats' request,
// BEATS_NOT_MUSIC kept as a null row, in-flight dedupe, no persist for a deleted asset. Fake worker, fake store. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { AnalysisService } from '../apps/web/src/analysis/service';
import type { RhythmRow } from '../apps/web/src/analysis/service';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { BeatAnalysis, Pcm } from '../apps/web/src/analysis/types';
import type { AnalysisRequest } from '../apps/web/src/analysis/protocol';
import type { Asset } from '../apps/web/src/store/model';

type Handler = (request: AnalysisRequest) => unknown;
class FakeWorker {
  requests: AnalysisRequest[] = []; transfers: Transferable[][] = [];
  constructor(private handler: Handler) {}
  init() { return Promise.resolve({ value: undefined }); }
  run(request: AnalysisRequest, transfer: Transferable[] = []) {
    this.requests.push(request); this.transfers.push(transfer);
    return Promise.resolve().then(() => this.handler(request)).then(value => ({ ok: true as const, value }));
  }
  close() {}
}
const ALL = { analysis: true, transcription: true, embeddings: true, beats: true };
const BEATS = { stored: { bpm: 120, beats: [[0.5, 0.9]], downbeats: [[0.5, 0.9]], silences: [] }, tab: { bpm: 120, beats: [[0.5, 0.9]], onsets: [], silences: [], firstBeat: 0.5, tempoType: 'constant' } } as unknown as BeatAnalysis;
function setup(handler: Handler = r => (r.task === 'available' ? ALL : BEATS)) {
  const workers: FakeWorker[] = [];
  const svc = new AnalysisService('/models/', (() => { const w = new FakeWorker(handler); workers.push(w); return w; }) as never);
  return { svc, workers, beatRequests: () => workers.flatMap(w => w.requests).filter(r => r.task === 'beats') };
}
const asset = { id: 'asset-1', name: 'song.mp3', type: 'audio', durationMs: 1000, media: { container: 'mp3' } } as unknown as Asset;
function store(rows: Record<string, Record<string, unknown>> = {}, assets: string[] = [asset.id]) {
  const data: Record<string, Map<string, unknown>> = { rhythms: new Map(), assets: new Map(assets.map(id => [id, { id }])) };
  for (const [name, byId] of Object.entries(rows)) data[name] = new Map(Object.entries(byId));
  const blob = new Blob(['x']);
  const s = { row: vi.fn(async (name: string, id: string) => data[name]?.get(id)), putRow: vi.fn(async (name: string, row: { id: string }) => { data[name].set(row.id, row); }),
    media: { read: vi.fn(async () => blob) }, data, blob };
  return s as typeof s & Parameters<AnalysisService['rhythm']>[0];
}
const pcm = (): Pcm => ({ sampleRate: 44100, channels: 1, data: [new Float32Array(8)] } as unknown as Pcm);
const code = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code);

describe('T19 C11 AnalysisService.rhythm', () => {
  it('a stored row is returned without require, decode or any worker', async () => {
    const stored: RhythmRow = { id: asset.id, analysis: BEATS, created_at: 'then' };
    const { svc, workers } = setup(), s = store({ rhythms: { [asset.id]: stored } }), decode = vi.fn();
    expect(await svc.rhythm(s, asset, decode)).toBe(stored);
    expect(decode).not.toHaveBeenCalled(); expect(s.media.read).not.toHaveBeenCalled(); expect(workers).toHaveLength(0); expect(s.putRow).not.toHaveBeenCalled();
  });
  it('a stored not-music row is returned as is too', async () => {
    const stored: RhythmRow = { id: asset.id, analysis: null, reason: 'BEATS_NOT_MUSIC', created_at: 'then' };
    const { svc } = setup(), s = store({ rhythms: { [asset.id]: stored } });
    expect(await svc.rhythm(s, asset, vi.fn())).toBe(stored);
  });
  it("otherwise: require('beats'), decode(blob, asset.media), request {task:'beats', pcm, asset:{filename,type}} with the pcm buffer transferred; the row is persisted", async () => {
    const { svc, workers, beatRequests } = setup(), s = store(), p = pcm(), decode = vi.fn(async () => p);
    const row = await svc.rhythm(s, asset, decode);
    expect(decode).toHaveBeenCalledTimes(1); expect(decode).toHaveBeenCalledWith(s.blob, asset.media);
    expect(s.media.read).toHaveBeenCalledWith(asset.id);
    expect(workers[0].requests.map(r => r.task)).toEqual(['available', 'beats']); // the capability probe comes first
    expect(beatRequests()).toEqual([{ task: 'beats', pcm: p, asset: { filename: 'song.mp3', type: 'audio' } }]);
    expect(workers[0].transfers.at(-1)).toHaveLength(1); expect(workers[0].transfers.at(-1)![0]).toBe(p.data[0].buffer);
    expect(row).toMatchObject({ id: asset.id, analysis: BEATS }); expect(typeof row.created_at).toBe('string'); expect(row).not.toHaveProperty('reason');
    expect(s.putRow).toHaveBeenCalledTimes(1); expect(s.putRow).toHaveBeenCalledWith('rhythms', row);
  });
  it('ANALYSIS_UNAVAILABLE when the probe says the beats models are missing: no decode, no persist', async () => {
    const { svc, beatRequests } = setup(r => (r.task === 'available' ? { ...ALL, beats: false } : BEATS)), s = store(), decode = vi.fn(async () => pcm());
    expect(await code(svc.rhythm(s, asset, decode))).toBe('ANALYSIS_UNAVAILABLE');
    expect(decode).not.toHaveBeenCalled(); expect(s.media.read).not.toHaveBeenCalled(); expect(beatRequests()).toHaveLength(0); expect(s.putRow).not.toHaveBeenCalled();
  });
  it('BEATS_NOT_MUSIC → a row { analysis: null, reason } is persisted and returned', async () => {
    const { svc } = setup(r => { if (r.task === 'available') return ALL; throw new AnalysisError('BEATS_NOT_MUSIC', 'speech'); }), s = store();
    const row = await svc.rhythm(s, asset, async () => pcm());
    expect(row).toMatchObject({ id: asset.id, analysis: null, reason: 'BEATS_NOT_MUSIC' }); expect(typeof row.created_at).toBe('string');
    expect(s.putRow).toHaveBeenCalledWith('rhythms', row);
    expect(s.data.rhythms.get(asset.id)).toBe(row);
  });
  it('another error is rethrown and nothing is persisted; the next call tries again', async () => {
    let fail = true;
    const { svc, beatRequests } = setup(r => { if (r.task === 'available') return ALL; if (fail) throw new AnalysisError('BEATS_FAILED', 'boom'); return BEATS; }), s = store(), decode = vi.fn(async () => pcm());
    const err = await svc.rhythm(s, asset, decode).catch(e => e);
    expect(err).toBeInstanceOf(AnalysisError); expect(err).toMatchObject({ code: 'BEATS_FAILED', message: 'boom' }); expect(s.putRow).not.toHaveBeenCalled();
    expect(await code(svc.rhythm(s, asset, decode))).toBe('BEATS_FAILED'); expect(decode).toHaveBeenCalledTimes(2); // no failed row is remembered
    fail = false;
    expect(await svc.rhythm(s, asset, decode)).toMatchObject({ analysis: BEATS }); expect(beatRequests()).toHaveLength(3);
  });
  it('a decode error is rethrown and nothing is persisted', async () => {
    const { svc, beatRequests } = setup(), s = store();
    expect(await code(svc.rhythm(s, asset, async () => { throw new AnalysisError('WORKSPACE_FILE_MISSING', 'gone'); }))).toBe('WORKSPACE_FILE_MISSING');
    expect(beatRequests()).toHaveLength(0); expect(s.putRow).not.toHaveBeenCalled();
  });
  it('the row is not persisted when the asset row is gone (deleted meanwhile), but it is still returned', async () => {
    const { svc } = setup(), s = store({}, []);
    const row = await svc.rhythm(s, asset, async () => pcm());
    expect(row).toMatchObject({ id: asset.id, analysis: BEATS }); expect(s.putRow).not.toHaveBeenCalled(); expect(s.data.rhythms.size).toBe(0);
    expect(s.row).toHaveBeenCalledWith('assets', asset.id);
  });
  it('the same for a not-music row of a deleted asset', async () => {
    const { svc } = setup(r => { if (r.task === 'available') return ALL; throw new AnalysisError('BEATS_NOT_MUSIC', 'speech'); }), s = store({}, []);
    expect(await svc.rhythm(s, asset, async () => pcm())).toMatchObject({ analysis: null, reason: 'BEATS_NOT_MUSIC' }); expect(s.putRow).not.toHaveBeenCalled();
  });
  it('two concurrent calls for one asset share one decode and one request; both get the same row', async () => {
    const { svc, beatRequests } = setup(), s = store();
    let release!: () => void; const hold = new Promise<void>(r => { release = r; });
    const decode = vi.fn(async () => { await hold; return pcm(); });
    const a = svc.rhythm(s, asset, decode), b = svc.rhythm(s, asset, decode);
    expect(b).toBe(a); release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra); expect(decode).toHaveBeenCalledTimes(1); expect(beatRequests()).toHaveLength(1); expect(s.putRow).toHaveBeenCalledTimes(1);
  });
  it('different assets are computed independently', async () => {
    const { svc, beatRequests } = setup(), other = { ...asset, id: 'asset-2', name: 'other.mp3' } as Asset, s = store({}, [asset.id, other.id]);
    await Promise.all([svc.rhythm(s, asset, async () => pcm()), svc.rhythm(s, other, async () => pcm())]);
    expect(beatRequests().map(r => (r as { asset: { filename: string } }).asset.filename).sort()).toEqual(['other.mp3', 'song.mp3']);
  });
  it('after it settles the next call reads the stored row: no new decode or request', async () => {
    const { svc, beatRequests } = setup(), s = store(), decode = vi.fn(async () => pcm());
    const first = await svc.rhythm(s, asset, decode);
    const second = await svc.rhythm(s, asset, decode);
    expect(second).toBe(first); expect(decode).toHaveBeenCalledTimes(1); expect(beatRequests()).toHaveLength(1);
  });
});
