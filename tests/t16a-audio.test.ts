// SPDX-License-Identifier: AGPL-3.0-only
// T16a's audio stage (apps/web/src/export/audio.ts), filled by T13 (exportMix: T13's mix and limiter over the export's own
// source pool). Oracle: "formula oracle" = the rule written out here, mix(t) = Σ source sample(clip clock(t)) × track gain ×
// volume² over the items audible at t, 48 kHz stereo, linear interpolation between 48 kHz source frames, the limiter idle
// below −1 dBFS. The source worker is replaced by a stub serving synthetic 48 kHz blocks (its contract, source.worker.ts),
// so the arithmetic is exact; the browser export checks are tests/ui/t16a-*.spec.ts and tests/ui/t13-export.spec.ts.
// Changed for T13 (notes "T16a assertions changed by T13"): volume is squared, mute / solo / track volume apply (Q-B),
// rate conversion is the source worker's, errors cross the worker as messages.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, ProjectDocument } from '../apps/web/src/store/model';

type Served = Float32Array[] | null | Error;
const served = new Map<string, Served>(), posted: any[] = [], workers: StubWorker[] = [];
const BLOCK = 8 * 48000;
class StubWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  constructor() { workers.push(this); }
  postMessage(req: any) {
    posted.push(req);
    if (req.op !== 'block') return;
    const s = served.get(req.key);
    queueMicrotask(() => {
      if (s instanceof Error) return this.onmessage?.({ data: { id: req.id, ok: false, message: s.message } });
      const data = s ? s.map(c => { const out = new Float32Array(BLOCK); out.set(c.subarray(req.k * BLOCK, (req.k + 1) * BLOCK)); return out; }) : null;
      this.onmessage?.({ data: { id: req.id, ok: true, data } });
    });
  }
  terminate() { this.terminated = true; }
}
vi.stubGlobal('Worker', StubWorker);
const { CHUNK_S, CHUNKED_ABOVE_S, exportMix, exportSource, hasAudioStream, mixStage, SAMPLE_RATE, storedVolume } = await import('../apps/web/src/export/audio');

const FPS = 30;
const doc = (items: any[], tracks: any[] = [{ id: 'a1', kind: 'audio' }, { id: 'v1', kind: 'video' }]) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 4000, fps: FPS, size: { width: 64, height: 36 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: tracks.map(t => ({ name: t.id, muted: false, solo: false, locked: false, hidden: false, volume: 1, ...t })), layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), items,
}) as unknown as ProjectDocument;
const audioItem = (id: string, assetId: string, o: Record<string, unknown> = {}) => ({
  id, type: 'audio', trackId: 'a1', display: { from: 0, to: 2000 }, trim: { from: 0, to: 2000 }, sourceDuration: 4000, details: { name: id }, metadata: { assetId }, ...o,
});
const asset = (id: string, audio: unknown = { codec: 'aac' }): [string, Asset] => [id, { id, name: id, type: 'audio', sizeBytes: 0, mimeType: 'audio/wav', folderId: null, created_at: '', recorded_at: null, location: null, durationMs: null, media: { video: null, audio } } as unknown as Asset];
const rows = new Map<string, Asset>();
const store = { row: async (_t: string, id: string) => rows.get(id), media: { read: vi.fn(async (id: string) => new Blob([id])) } } as any;
const mix = (assets: [string, Asset][], options?: { forceWasm?: boolean }) => { for (const [id, a] of assets) rows.set(id, a); return exportMix(store, new Map(assets), options); };
const constant = (seconds: number, v: number) => new Float32Array(Math.round(48000 * seconds)).fill(v);
const blocks = (key?: string) => posted.filter(p => p.op === 'block' && (key === undefined || p.key === key)).length;
const second = { startMs: 0, frames: SAMPLE_RATE };

beforeEach(() => { served.clear(); posted.length = 0; workers.length = 0; rows.clear(); store.media.read.mockClear(); });

describe('T16a audio stage, T13 mix (formula oracle: source samples × track gain × volume², summed; 48 kHz stereo)', () => {
  it('returns 48 kHz planar stereo of exactly the asked number of frames', async () => {
    served.set('s1', [constant(4, 0.4)]);
    const out = await mix([asset('s1')])(doc([audioItem('i1', 's1')]), { startMs: 0, frames: 12345 });
    expect(out.sampleRate).toBe(48000);
    expect(out.channels).toBe(2);
    expect(out.data[0]).toHaveLength(12345);
    expect(out.data[1]).toHaveLength(12345);
  });
  it('one item: samples × volume² inside [from, to), silence outside (T13: 0.4 × 0.5² = 0.1)', async () => {
    served.set('s1', [constant(4, 0.4)]);
    const d = doc([audioItem('i1', 's1', { display: { from: 250, to: 750 }, trim: { from: 0, to: 500 }, properties: { volume: { defaultValue: 0.5, keyframes: [] } } })]);
    const out = await mix([asset('s1')])(d, second);
    const at = (ms: number) => Math.floor(ms / 1000 * SAMPLE_RATE);
    expect(out.data[0][at(100)]).toBe(0);
    expect(out.data[0][at(260)]).toBeCloseTo(0.1, 6);
    expect(out.data[1][at(260)]).toBeCloseTo(0.1, 6);
    expect(out.data[0][at(740)]).toBeCloseTo(0.1, 6);
    expect(out.data[0][at(760)]).toBe(0);
    expect(out.data[0][at(250) - 1]).toBe(0);
    expect(out.data[0][at(250)]).toBeCloseTo(0.1, 6);
    expect(out.data[0][at(750) - 1]).toBeCloseTo(0.1, 6);
    expect(out.data[0][at(750)]).toBe(0);
  });
  it('two items are summed (T13: 0.3 × 1² + 0.2 × 0.5² = 0.35), each with its own volume', async () => {
    served.set('s1', [constant(4, 0.3)]); served.set('s2', [constant(4, 0.2)]);
    const d = doc([audioItem('i1', 's1'), audioItem('i2', 's2', { properties: { volume: { defaultValue: 0.5, keyframes: [] } } })]);
    const out = await mix([asset('s1'), asset('s2')])(d, second);
    expect(out.data[0][1000]).toBeCloseTo(0.35, 6);
    expect(out.data[1][47000]).toBeCloseTo(0.35, 6);
  });
  it('a mono source feeds both channels; a stereo source keeps its channels', async () => {
    served.set('mono', [constant(4, 0.3)]); served.set('st', [constant(4, 0.1), constant(4, -0.2)]);
    const m = mix([asset('mono'), asset('st')]);
    let out = await m(doc([audioItem('i1', 'mono')]), second);
    expect([out.data[0][500], out.data[1][500]].map(v => +v.toFixed(6))).toEqual([0.3, 0.3]);
    out = await m(doc([audioItem('i2', 'st')]), second);
    expect([out.data[0][500], out.data[1][500]].map(v => +v.toFixed(6))).toEqual([0.1, -0.2]);
  });
  it('reads between 48 kHz source frames by linear interpolation (speed 0.5 on a ramp k / 480 000: output frame i → value i / 960 000; T13: rate conversion to 48 kHz is the source worker\'s, t13-chunks-oracle resamplePlanar)', async () => {
    served.set('s1', [Float32Array.from({ length: 4 * 48000 }, (_, k) => k / 480000)]);
    const out = await mix([asset('s1')])(doc([audioItem('i1', 's1', { display: { from: 0, to: 2000 }, trim: { from: 0, to: 1000 }, playbackRate: 0.5 })]), second);
    for (const i of [0, 1, 5, 6, 101, 12345, 47901]) expect(out.data[0][i]).toBeCloseTo(i / 960000, 6);
  });
  it('trim.from moves the read position: the first output sample of the item is the source sample at trim.from', async () => {
    served.set('s1', [Float32Array.from({ length: 4 * 48000 }, (_, k) => k / 48000 / 10)]);
    const out = await mix([asset('s1')])(doc([audioItem('i1', 's1', { display: { from: 0, to: 1000 }, trim: { from: 1500, to: 2500 } })]), second);
    expect(out.data[0][0]).toBeCloseTo(0.15, 5);
    expect(out.data[0][24000]).toBeCloseTo(0.2, 5);
  });
  it('speed 2 reads the source twice as fast (pitch follows speed, findings §7b)', async () => {
    served.set('s1', [Float32Array.from({ length: 4 * 48000 }, (_, k) => k / 48000 / 10)]);
    const out = await mix([asset('s1')])(doc([audioItem('i1', 's1', { display: { from: 0, to: 1000 }, trim: { from: 0, to: 2000 }, playbackRate: 2 })]), second);
    expect(out.data[0][24000]).toBeCloseTo(0.1, 5); // 0.5 s of timeline = 1 s of source = value 0.1
  });
  it('a chunk that starts mid-timeline gives the same samples as the same range of one big chunk (T13: a sine under the −1 dBFS ceiling, bit-exact)', async () => {
    served.set('s1', [Float32Array.from({ length: 4 * 48000 }, (_, k) => 0.5 * Math.sin(k / 37))]);
    const m = mix([asset('s1')]), d = doc([audioItem('i1', 's1', { display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 } })]);
    const whole = await m(d, { startMs: 0, frames: 4 * SAMPLE_RATE }), part = await m(d, { startMs: 2000, frames: SAMPLE_RATE });
    for (const i of [0, 1, 777, 47999]) expect(part.data[0][i]).toBe(whole.data[0][2 * SAMPLE_RATE + i]);
  });
  it('an asset without an audio track is silent and is never decoded', async () => {
    const out = await mix([asset('v', null)])(doc([audioItem('i1', 'v')]), second);
    expect(Math.max(...out.data[0].map(Math.abs))).toBe(0);
    expect(blocks()).toBe(0);
  });
  it('a decoder that says "no audio track" is silent; any other decoder error propagates', async () => {
    served.set('s1', new Error('The file has no audio track.'));
    const out = await mix([asset('s1')])(doc([audioItem('i1', 's1')]), second);
    expect(Math.max(...out.data[0].map(Math.abs))).toBe(0);
    served.set('s2', new Error('corrupt'));
    await expect(mix([asset('s2')])(doc([audioItem('i2', 's2')]), second)).rejects.toThrow('corrupt');
  });
  // Freeze 7 round 2: the audio stage meets a broken video file first; a video item's demux error is UNSUPPORTED_INPUT, an audio item's error is unchanged.
  const DEMUX = 'The audio could not be decoded: Invalid data found when processing input';
  const videoItem = (id: string, assetId: string) => audioItem(id, assetId, { type: 'video', trackId: 'v1' });
  it('a video item whose audio no demuxer opens is UNSUPPORTED_INPUT with the "This file could not be opened" message', async () => {
    served.set('v', new Error(DEMUX));
    await expect(mix([asset('v')])(doc([videoItem('i1', 'v')]), second))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT', message: 'This file could not be opened: Invalid data found when processing input' });
  });
  it('the same error on an audio item propagates unchanged: no code, same message (T13: the same object from the source; across the worker, the same message)', async () => {
    const e = new Error(DEMUX);
    const err = await mixStage(exportSource(async () => { throw e; }))(doc([audioItem('i1', 's1')]), second).catch((x: unknown) => x);
    expect(err).toBe(e);
    expect((err as Error).message).toBe(DEMUX);
    expect((err as { code?: string }).code).toBeUndefined();
    served.set('s1', new Error(DEMUX));
    const crossed = await mix([asset('s1')])(doc([audioItem('i1', 's1')]), second).catch((x: unknown) => x);
    expect((crossed as Error).message).toBe(DEMUX);
    expect((crossed as { code?: string }).code).toBeUndefined();
  });
  it('a video item with a "moov atom not found" text is UNSUPPORTED_INPUT', async () => {
    served.set('v', new Error('The audio could not be decoded: moov atom not found'));
    await expect(mix([asset('v')])(doc([videoItem('i1', 'v')]), second))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT', message: 'This file could not be opened: moov atom not found' });
  });
  it('volume 0 skips the item without decoding it', async () => {
    served.set('s1', [constant(4, 0.4)]);
    const out = await mix([asset('s1')])(doc([audioItem('i1', 's1', { properties: { volume: { defaultValue: 0, keyframes: [] } } })]), second);
    expect(Math.max(...out.data[0].map(Math.abs))).toBe(0);
    expect(blocks()).toBe(0);
  });
  it('decodes each asset once across chunks, and again after release() dropped it (T13: per 8 s block; release also closes the worker\'s readers)', async () => {
    served.set('s1', [constant(4, 0.4)]);
    const m = mix([asset('s1')]), d = doc([audioItem('i1', 's1', { display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 } })]);
    await m(d, second); await m(d, { startMs: 1000, frames: SAMPLE_RATE });
    expect(blocks('s1')).toBe(1);
    m.release(new Set(['s1']));
    await m(d, second);
    expect(blocks('s1')).toBe(1);
    m.release(new Set());
    expect(posted.at(-1)).toEqual({ op: 'release', keep: [] });
    await m(d, second);
    expect(blocks('s1')).toBe(2);
  });
  it('a hidden track is not mixed (exported items only)', async () => {
    served.set('s1', [constant(4, 0.4)]);
    const d = doc([audioItem('i1', 's1')], [{ id: 'a1', kind: 'audio', hidden: true }]);
    const out = await mix([asset('s1')])(d, second);
    expect(Math.max(...out.data[0].map(Math.abs))).toBe(0);
  });
  it('T13 (notes Q-B closed): a muted track is silent and never decoded, a soloed-out track is silent, the track volume scales (0.4 × 0.1)', async () => {
    served.set('s1', [constant(4, 0.4)]);
    let out = await mix([asset('s1')])(doc([audioItem('i1', 's1')], [{ id: 'a1', kind: 'audio', muted: true, volume: 0.1 }]), second);
    expect(Math.max(...out.data[0].map(Math.abs))).toBe(0);
    expect(blocks()).toBe(0);
    out = await mix([asset('s1')])(doc([audioItem('i1', 's1')], [{ id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio', solo: true }]), second);
    expect(Math.max(...out.data[0].map(Math.abs))).toBe(0);
    out = await mix([asset('s1')])(doc([audioItem('i1', 's1')], [{ id: 'a1', kind: 'audio', volume: 0.1 }]), second);
    expect(out.data[0][1000]).toBeCloseTo(0.04, 6);
  });
  it('forceWasm (T16a\'s option) reaches every block request; each export has its own source worker, ended by close()', async () => {
    served.set('s1', [constant(4, 0.4)]);
    const d = doc([audioItem('i1', 's1')]), plain = mix([asset('s1')]), wasm = mix([asset('s1')], { forceWasm: true });
    await plain(d, second); await wasm(d, second);
    expect(posted.filter(p => p.op === 'block').map(p => p.forceWasm)).toEqual([false, true]);
    expect(workers).toHaveLength(2);
    wasm.close();
    expect(workers.map(w => w.terminated)).toEqual([false, true]);
  });
});

describe('T16a storedVolume (the property default, else details.volume, else 1; keyframes are T13\'s)', () => {
  const v = (o: Record<string, unknown>) => storedVolume({ id: 'x', type: 'audio', ...o } as any);
  it('reads the property default first', () => {
    expect(v({ properties: { volume: { defaultValue: 0.25, keyframes: [] } } })).toBe(0.25);
    expect(v({ properties: { volume: 0.75 } })).toBe(0.75);
    expect(v({ properties: { volume: { defaultValue: 0.25, keyframes: [] } }, details: { volume: 0.9 } })).toBe(0.25);
  });
  it('falls back to details.volume, then 1', () => {
    expect(v({ details: { volume: 0.6 } })).toBe(0.6);
    expect(v({})).toBe(1);
  });
  it('clamps negatives to 0 and ignores non-finite values', () => {
    expect(v({ properties: { volume: { defaultValue: -2, keyframes: [] } } })).toBe(0);
    expect(v({ properties: { volume: { defaultValue: Number.NaN, keyframes: [] } } })).toBe(1);
  });
});

describe('T16a hasAudioStream (findings §44.8: any exported video or audio item gets an AAC stream, even when silent)', () => {
  it('true for an exported video or audio item', () => {
    expect(hasAudioStream(doc([{ ...audioItem('i1', 's1'), type: 'video', trackId: 'v1' }]))).toBe(true);
    expect(hasAudioStream(doc([audioItem('i1', 's1')]))).toBe(true);
  });
  it('false for an image-only timeline, an empty one, and for media on a hidden track', () => {
    expect(hasAudioStream(doc([{ ...audioItem('i1', 's1'), type: 'image', trackId: 'v1' }]))).toBe(false);
    expect(hasAudioStream(doc([]))).toBe(false);
    expect(hasAudioStream(doc([audioItem('i1', 's1')], [{ id: 'a1', kind: 'audio', hidden: true }]))).toBe(false);
  });
});

describe('T16a chunk constants (master plan §1b: 120 s chunks above 5 min)', () => {
  it('CHUNK_S = 120, CHUNKED_ABOVE_S = 300, SAMPLE_RATE = 48 000', () => {
    expect([CHUNK_S, CHUNKED_ABOVE_S, SAMPLE_RATE]).toEqual([120, 300, 48000]);
  });
});
