// SPDX-License-Identifier: AGPL-3.0-only
// T16a codec negotiation, remux eligibility and the I420 conversion (apps/web/src/export/{probe,remux,i420}.ts). Oracles:
//   "written-spec oracle" = findings §7 (High → Main → Baseline, a message per fallback, real W/H/bitrate, l.101 remux conditions)
//                           and H.264 Table A-1 (levels), quoted in the title
//   "formula oracle"      = a float BT.709 limited-range reference written here from the formula in i420.ts's header, rounded
//                           with Math.round (the code uses integer truncation of v + 0.5)
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, ProjectDocument } from '../apps/web/src/store/model';
import { exportPlan } from '../apps/web/src/render/model';
import { AUDIO, audioSupported, avcCodec, avcLevel, negotiateAudio, negotiateVideo, OPUS, OPUS_MESSAGE, PROFILES } from '../apps/web/src/export/probe';
import { remuxCandidate } from '../apps/web/src/export/remux';
import { rgbaToI420 } from '../apps/web/src/export/i420';

describe('T16a avcLevel (written-spec oracle: H.264 Table A-1)', () => {
  it('picks the lowest level that holds the frame size, the macroblock rate and the bitrate', () => {
    expect(avcLevel(1920, 1080, 30, 20_000_000)).toBe(40);           // 8160 MB, 244 800 MB/s ≤ level 4.0
    expect(avcLevel(1080, 1920, 30, 20_000_000)).toBe(40);           // portrait: 68 × 120 = 8160 MB, the same as 1920 × 1080
    expect(avcLevel(3840, 2160, 30, 20_000_000)).toBe(51);           // 32 400 MB > 22 080 (level 5.0), 972 000 MB/s ≤ 983 040
    expect(avcLevel(640, 360, 30, 5_000_000)).toBe(30);              // 920 MB, 27 600 MB/s, 5 Mb/s
    expect(avcLevel(640, 360, 30, 20_000_000)).toBe(32);             // the bitrate lifts it past 3.0 / 3.1
    expect(avcLevel(320, 180, 10, 1_000_000)).toBe(20);              // 220 MB, 2 200 MB/s, 1 Mb/s
  });
  it('a higher frame rate or a higher bitrate never lowers the level', () => {
    for (const [w, h] of [[640, 360], [1280, 720], [1920, 1080]]) {
      let last = 0;
      for (const fps of [10, 24, 30, 60]) { const l = avcLevel(w, h, fps, 8_000_000); expect(l).toBeGreaterThanOrEqual(last); last = l; }
      last = 0;
      for (const br of [1e6, 4e6, 10e6, 40e6]) { const l = avcLevel(w, h, 30, br); expect(l).toBeGreaterThanOrEqual(last); last = l; }
    }
  });
  it('avcCodec writes avc1.<profile_idc><constraints><level_idc> in hex', () => {
    expect(avcCodec(PROFILES[0], 40)).toBe('avc1.640028');
    expect(avcCodec(PROFILES[1], 40)).toBe('avc1.4d4028');
    expect(avcCodec(PROFILES[2], 31)).toBe('avc1.42e01f');
  });
});

describe('T16a negotiateVideo (written-spec oracle: findings §7 High → Main → Constrained Baseline, a message per fallback, probed at the real settings)', () => {
  const target = { width: 1920, height: 1080, fps: 30, bitrate: 20_000_000 };
  const stub = (ok: (config: VideoEncoderConfig, call: number) => boolean | Promise<boolean>) => {
    const calls: VideoEncoderConfig[] = [];
    return { calls, supported: async (c: VideoEncoderConfig) => { calls.push(c); return ok(c, calls.length); } };
  };
  it('takes High when it is supported: one probe, no message', async () => {
    const s = stub(() => true), n = await negotiateVideo(target, s.supported);
    expect(n.profile).toBe('High');
    expect(n.messages).toEqual([]);
    expect(s.calls).toHaveLength(1);
    expect(n.config.codec).toBe('avc1.640028');
  });
  it('falls back High → Main with one message that names the profile, size, frame rate and bitrate', async () => {
    const s = stub(c => !c.codec.startsWith('avc1.64')), n = await negotiateVideo(target, s.supported);
    expect(n.profile).toBe('Main');
    expect(n.messages).toHaveLength(1);
    expect(n.messages[0]).toContain('High');
    expect(n.messages[0]).toMatch(/1920×1080/);
    expect(n.messages[0]).toMatch(/30 fps/);
    expect(n.messages[0]).toMatch(/20 Mb\/s/);
    expect(n.config.codec).toBe('avc1.4d4028');
    expect(s.calls.map(c => c.codec.slice(0, 9))).toEqual(['avc1.6400', 'avc1.4d40']);
  });
  it('falls back High → Main → Constrained Baseline with two messages; the last fallback stays H.264', async () => {
    const s = stub(c => c.codec.startsWith('avc1.42')), n = await negotiateVideo(target, s.supported);
    expect(n.profile).toBe('Constrained Baseline');
    expect(n.messages).toHaveLength(2);
    expect(n.messages[0]).toContain('High');
    expect(n.messages[1]).toContain('Main');
    expect(n.config.codec).toBe('avc1.42e028');
  });
  it('a probe that rejects counts as unsupported', async () => {
    const n = await negotiateVideo(target, async c => { if (!c.codec.startsWith('avc1.42')) throw new Error('boom'); return true; });
    expect(n.profile).toBe('Constrained Baseline');
  });
  it('throws when no profile is supported, after three probes', async () => {
    const s = stub(() => false);
    await expect(negotiateVideo(target, s.supported)).rejects.toThrow(/H\.264 cannot be encoded at 1920×1080/);
    expect(s.calls).toHaveLength(3);
  });
  it('the config carries the real width, height, frame rate and bitrate, variable bitrate, quality latency and avc format', async () => {
    const n = await negotiateVideo({ width: 640, height: 360, fps: 24, bitrate: 3_500_000 }, async () => true);
    expect(n.config).toMatchObject({ width: 640, height: 360, framerate: 24, bitrate: 3_500_000, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } });
    expect(n.config.codec).toBe(`avc1.6400${avcLevel(640, 360, 24, 3_500_000, 1.25).toString(16).padStart(2, '0')}`);
  });
  it('each profile is probed at its own level (Main and Baseline use bitrate factor 1, High 1.25)', async () => {
    const t = { width: 1280, height: 720, fps: 30, bitrate: 15_000_000 }, s = stub(() => false);
    await negotiateVideo(t, s.supported).catch(() => undefined);
    const level = (c: VideoEncoderConfig) => parseInt(c.codec.slice(-2), 16);
    expect(s.calls.map(level)).toEqual([avcLevel(1280, 720, 30, 15e6, 1.25), avcLevel(1280, 720, 30, 15e6, 1), avcLevel(1280, 720, 30, 15e6, 1)]);
  });
});

describe('T16a audioSupported (AAC-LC 48 kHz stereo 192 kb/s, findings §44.8)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('probes mp4a.40.2, 48 000 Hz, 2 channels, 192 000 b/s and returns what the browser says', async () => {
    const seen: unknown[] = [];
    vi.stubGlobal('AudioEncoder', { isConfigSupported: async (c: unknown) => { seen.push(c); return { supported: true, config: c }; } });
    expect(await audioSupported()).toBe(true);
    expect(seen).toEqual([{ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }]);
    expect(AUDIO).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 });
    vi.stubGlobal('AudioEncoder', { isConfigSupported: async () => ({ supported: false }) });
    expect(await audioSupported()).toBe(false);
  });
  it('is false when the probe throws or AudioEncoder does not exist', async () => {
    vi.stubGlobal('AudioEncoder', { isConfigSupported: async () => { throw new Error('no'); } });
    expect(await audioSupported()).toBe(false);
    vi.stubGlobal('AudioEncoder', undefined);
    expect(await audioSupported()).toBe(false);
  });
});

describe('T16a negotiateAudio (written-spec oracle: coordinator ruling Q-F, AAC-LC, else Opus 48 kHz stereo with a message, else none)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubEncoder = (supported: (c: any) => boolean) => { const seen: any[] = []; vi.stubGlobal('AudioEncoder', { isConfigSupported: async (c: any) => { seen.push(c); return { supported: supported(c), config: c }; } }); return seen; };
  it('AAC probe true: aac, no message, and Opus is not probed', async () => {
    const seen = stubEncoder(() => true);
    expect(await negotiateAudio(async () => true)).toEqual({ codec: 'aac', message: null });
    expect(seen).toEqual([]);
  });
  it('AAC probe false and Opus supported: opus with OPUS_MESSAGE, probed with exactly the OPUS config', async () => {
    const seen = stubEncoder(c => c.codec === 'opus');
    expect(await negotiateAudio(async () => false)).toEqual({ codec: 'opus', message: OPUS_MESSAGE });
    expect(seen).toEqual([{ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }]);
    expect(OPUS).toEqual({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 });
    expect(OPUS_MESSAGE).toBe('AAC-LC 48 kHz stereo is not supported by this browser, so the audio is Opus 48 kHz stereo in the MP4.');
  });
  it('neither codec encodes: null', async () => {
    stubEncoder(() => false);
    expect(await negotiateAudio(async () => false)).toBeNull();
  });
  it('AudioEncoder undefined: null', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    expect(await negotiateAudio(async () => false)).toBeNull();
  });
  it('the Opus probe throws: null', async () => {
    vi.stubGlobal('AudioEncoder', { isConfigSupported: async () => { throw new Error('no'); } });
    expect(await negotiateAudio(async () => false)).toBeNull();
  });
  it('the default AAC probe is audioSupported: the mp4a.40.2 config is probed first, then Opus when it says no', async () => {
    const seen = stubEncoder(c => c.codec === 'opus');
    expect(await negotiateAudio()).toEqual({ codec: 'opus', message: OPUS_MESSAGE });
    expect(seen.map(c => c.codec)).toEqual(['mp4a.40.2', 'opus']);
  });
});

// ---- remuxCandidate: one case per findings §7 l.101 condition, each a negative that takes the encode path.
describe('T16a remuxCandidate (written-spec oracle: findings §7 l.101, conditions quoted in each title)', () => {
  const W = 640, H = 360, FPS = 30, MS = 3000;
  const media = (o: { video?: Record<string, unknown> | null; audio?: Record<string, unknown> | null } = {}): Asset['media'] => ({
    video: o.video === null ? null : { codec: 'avc', codecString: 'avc1.64001f', fps: FPS, vfr: false, rotation: 0, displayWidth: W, displayHeight: H, ...o.video },
    audio: o.audio === null ? null : { codec: 'aac', ...o.audio },
  }) as unknown as Asset['media'];
  const asset = (m: Asset['media'] = media()): Asset => ({ id: 'a1', name: 'clip.mp4', durationMs: MS, processing_status: 'ready', media: m }) as unknown as Asset;
  const item = (o: Record<string, unknown> = {}) => ({
    id: 'c1', type: 'video', trackId: 'v1', display: { from: 0, to: MS }, trim: { from: 0, to: MS }, sourceDuration: MS, details: { name: 'c1' }, metadata: { assetId: 'a1' }, ...o,
  });
  const doc = (items: any[] = [item()], extra: Record<string, unknown> = {}) => ({
    schemaVersion: 4, rev: 0, groups: {}, duration: MS, fps: FPS, size: { width: W, height: H }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks: [{ id: 'v1', name: 'V1', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1 }, { id: 'v2', name: 'V2', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1 }],
    layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }], items, ...extra,
  }) as unknown as ProjectDocument;
  const size = { width: W, height: H };
  const run = (d: ProjectDocument, o: { a?: Asset; size?: { width: number; height: number }; ranged?: boolean } = {}) => remuxCandidate(d, exportPlan(d), o.size ?? size, id => (id === 'a1' ? (o.a ?? asset()) : undefined), !!o.ranged);
  const reason = (r: ReturnType<typeof run>) => ('reason' in r ? r.reason : null);
  const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });

  it('the unedited one-clip timeline takes the remux path', () => {
    const r = run(doc());
    expect('item' in r && r.item.id).toBe('c1');
  });
  it('no range: a frame range set → encode path', () => expect(reason(run(doc(), { ranged: true }))).toMatch(/range/));
  it('output size = canvas: any other size → encode path', () => {
    expect(reason(run(doc(), { size: { width: 320, height: 180 } }))).toMatch(/output size/);
    expect(reason(run(doc(), { size: { width: W + 2, height: H } }))).toMatch(/output size/);
  });
  it('one exported item: two items, or a transition → encode path', () => {
    expect(reason(run(doc([item(), item({ id: 'c2', trackId: 'v2' })])))).toMatch(/not one clip/);
    expect(reason(run(doc([item()], { transitions: [{ id: 't1', trackId: 'v1', type: 'fade' }] })))).toMatch(/not one clip/);
  });
  it('one exported item: a hidden second track does not count', () => {
    const d = doc([item(), item({ id: 'c2', trackId: 'v2' })]);
    (d.tracks[1] as any).hidden = true;
    expect('item' in run(d)).toBe(true);
  });
  it('a video with audio: an image / audio item, an asset without audio, or an unknown asset → encode path', () => {
    expect(reason(run(doc([item({ type: 'image' })])))).toMatch(/video with audio/);
    expect(reason(run(doc(), { a: asset(media({ audio: null })) }))).toMatch(/video with audio/);
    expect(reason(run(doc([item({ metadata: { assetId: 'missing' } })])))).toMatch(/video with audio/);
  });
  it('H.264 video and AAC audio: HEVC video or Opus audio → encode path', () => {
    expect(reason(run(doc(), { a: asset(media({ video: { codec: 'hevc' } })) }))).toMatch(/H\.264/);
    expect(reason(run(doc(), { a: asset(media({ audio: { codec: 'opus' } })) }))).toMatch(/H\.264/);
  });
  it('constant frame rate equal to the timeline: variable rate, or 25 fps in a 30 fps timeline → encode path; within 0.01 passes', () => {
    expect(reason(run(doc(), { a: asset(media({ video: { vfr: true } })) }))).toMatch(/frame rate/);
    expect(reason(run(doc(), { a: asset(media({ video: { fps: 25 } })) }))).toMatch(/frame rate/);
    expect('item' in run(doc(), { a: asset(media({ video: { fps: 30.005 } })) })).toBe(true);
  });
  it('the clip is the canvas size, unrotated: another size or a 90° rotation → encode path', () => {
    expect(reason(run(doc(), { a: asset(media({ video: { displayWidth: 320, displayHeight: 180 } })) }))).toMatch(/clip size/);
    expect(reason(run(doc(), { a: asset(media({ video: { rotation: 90 } })) }))).toMatch(/clip size/);
  });
  it('from its first frame to its end: a trim of the start, a trim of the end, a different length → encode path', () => {
    expect(reason(run(doc([item({ trim: { from: 500, to: MS } })])))).toMatch(/trimmed/);
    expect(reason(run(doc([item({ trim: { from: 0, to: MS - 500 }, display: { from: 0, to: MS - 500 } })], { duration: MS - 500 })))).toMatch(/trimmed|span/);
    expect(reason(run(doc([item({ display: { from: 0, to: MS - 500 } })], { duration: MS - 500 })))).toMatch(/trimmed|span/);
  });
  it('a timeline longer than the clip (the clip does not span the whole export) → encode path', () => {
    expect(reason(run(doc([item()], { duration: MS + 2000 })))).toMatch(/span|trimmed/);
  });
  it('unedited: speed, keyframes, effects, masks, a stored volume other than 1 → encode path', () => {
    expect(reason(run(doc([item({ playbackRate: 2 })])))).toMatch(/edited|trimmed|span/);
    expect(reason(run(doc([item({ properties: { opacity: { defaultValue: 1, keyframes: [{ time: 0, value: 0.5 }] } } })])))).toMatch(/edited/);
    expect(reason(run(doc([item({ effects: [{ id: 'e1', type: 'blur' }] })])))).toMatch(/edited/);
    expect(reason(run(doc([item({ masks: [{ id: 'm1' }] })])))).toMatch(/edited/);
    expect(reason(run(doc([item({ properties: { volume: prop(0.5) } })])))).toMatch(/edited/);
    expect(reason(run(doc([item({ details: { name: 'c1', volume: 0.5 } })])))).toMatch(/edited/);
  });
  it('drawn 1:1 over the whole canvas: an offset, a scale, an opacity below 1, a blend mode, a radius → encode path', () => {
    for (const properties of [{ positionX: prop(10) }, { scale: prop(0.5) }, { opacity: prop(0.5) }, { blendMode: prop('multiply') }, { borderRadius: prop(20) }, { width: prop(W / 2) }]) {
      const r = run(doc([item({ properties })]));
      expect(reason(r), JSON.stringify(properties)).not.toBeNull();
    }
  });
});

// ---- I420: test of record for the CPU conversion (BT.709 limited range). Bound stated in the test.
describe('T16a rgbaToI420 (formula oracle: float BT.709 limited-range reference)', () => {
  const KR = 0.2126, KG = 0.7152, KB = 0.0722;
  /** The float reference: Y from each pixel, Cb / Cr from the mean of the 2 × 2 block, Math.round. */
  function reference(rgba: Uint8ClampedArray, w: number, h: number) {
    const out = new Float64Array(w * h * 3 / 2), cw = w >> 1, uOff = w * h, vOff = uOff + cw * (h >> 1);
    for (let i = 0; i < w * h; i++) out[i] = 16 + 219 * (KR * rgba[i * 4] + KG * rgba[i * 4 + 1] + KB * rgba[i * 4 + 2]) / 255;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const p = ((y + dy) * w + x + dx) * 4; r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; }
      r /= 4 * 255; g /= 4 * 255; b /= 4 * 255;
      const Y = KR * r + KG * g + KB * b, c = (y >> 1) * cw + (x >> 1);
      out[uOff + c] = 128 + 224 * (b - Y) / 1.8556;
      out[vOff + c] = 128 + 224 * (r - Y) / 1.5748;
    }
    return out;
  }
  const solid = (r: number, g: number, b: number) => new Uint8ClampedArray([...Array(4)].flatMap(() => [r, g, b, 255]));
  const planes = (rgba: Uint8ClampedArray) => { const o = rgbaToI420(rgba, 2, 2, new Uint8Array(6)); return [o[0], o[4], o[5]]; };

  it('the five extremes are exact: black 16/128/128, white 235/128/128, red 63/102/240, green 173/42/26, blue 32/240/118', () => {
    expect(planes(solid(0, 0, 0))).toEqual([16, 128, 128]);
    expect(planes(solid(255, 255, 255))).toEqual([235, 128, 128]);
    expect(planes(solid(255, 0, 0))).toEqual([63, 102, 240]);
    expect(planes(solid(0, 255, 0))).toEqual([173, 42, 26]);
    expect(planes(solid(0, 0, 255))).toEqual([32, 240, 118]);
  });
  it('1920 × 1080 random RGBA: every value within ±1 of the float reference and at most 10 of 3 110 400 values differ (measured: 2)', () => {
    const w = 1920, h = 1080, rgba = new Uint8ClampedArray(w * h * 4);
    let s = 0x2545f491; // xorshift32, fixed seed
    for (let i = 0; i < rgba.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; rgba[i] = i % 4 === 3 ? 255 : s & 255; }
    const got = rgbaToI420(rgba, w, h, new Uint8Array(w * h * 3 / 2)), want = reference(rgba, w, h);
    let differ = 0, worst = 0;
    for (let i = 0; i < got.length; i++) {
      const d = Math.abs(got[i] - Math.round(want[i]));
      if (d) differ++;
      worst = Math.max(worst, d);
    }
    expect(got.length).toBe(3_110_400);
    expect(worst).toBeLessThanOrEqual(1);
    expect(differ).toBeLessThanOrEqual(10);
  });
  it('limited range: Y stays in 16…235 and Cb / Cr in 16…240 for any input', () => {
    const w = 64, h = 64, rgba = new Uint8ClampedArray(w * h * 4);
    let s = 12345;
    for (let i = 0; i < rgba.length; i++) { s = (s * 1103515245 + 12345) >>> 0; rgba[i] = i % 4 === 3 ? 255 : (s >>> 16) & 255; }
    const o = rgbaToI420(rgba, w, h, new Uint8Array(w * h * 3 / 2));
    for (let i = 0; i < w * h; i++) { expect(o[i]).toBeGreaterThanOrEqual(16); expect(o[i]).toBeLessThanOrEqual(235); }
    for (let i = w * h; i < o.length; i++) { expect(o[i]).toBeGreaterThanOrEqual(16); expect(o[i]).toBeLessThanOrEqual(240); }
  });
  it('the plane layout is Y (w × h), U (w/2 × h/2), V (w/2 × h/2): a left/right split lands in the right columns', () => {
    const w = 4, h = 2, rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
    const o = rgbaToI420(rgba, w, h, new Uint8Array(12));
    expect([...o.subarray(0, 8)]).toEqual([63, 63, 32, 32, 63, 63, 32, 32]);
    expect([...o.subarray(8, 10)]).toEqual([102, 240]);   // U: red, blue
    expect([...o.subarray(10, 12)]).toEqual([240, 118]);  // V: red, blue
  });
});
