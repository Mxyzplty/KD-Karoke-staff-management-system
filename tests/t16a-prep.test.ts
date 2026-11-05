// SPDX-License-Identifier: AGPL-3.0-only
// T16a export prep (apps/web/src/export/prep.ts, pipeline.ts exportFilename). Each test names its oracle:
//   "written-spec oracle" = a rule stated in findings §7 / error codes §12 / part 5 §53.8 (tolerance 0.01 ms, five issue codes,
//                           the long-edge sizes, the leading-gap trim, the range frames), quoted in the title
//   "formula oracle"      = a number computed here from the stated formula, not read back from the code
//   "provisional"         = a T16a choice (notes Q-A), not Xapp parity
import { describe, it, expect, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { exportedItems, exportedMedia, outputSize, prepare, repairTiming, timingIssues } from '../apps/web/src/export/prep';
import { audioFailure, drawSource, exportFilename } from '../apps/web/src/export/pipeline';
import { classifyExportError, ExportError } from '../apps/web/src/export/errors';
import { mediaError } from '../apps/web/src/media/codes';

type Tr = { id: string; kind: string; hidden?: boolean };
const track = (t: Tr) => ({ name: t.id, muted: false, solo: false, locked: false, hidden: false, volume: 1, ...t });
const clip = (id: string, trackId: string, o: { from?: number; to?: number; trim?: { from: number; to: number }; sd?: number; type?: string } = {}) => ({
  id, type: o.type ?? 'video', trackId, display: { from: o.from ?? 0, to: o.to ?? 5000 }, trim: o.trim ?? { from: 0, to: (o.to ?? 5000) - (o.from ?? 0) },
  sourceDuration: o.sd ?? 5000, details: { name: id }, metadata: { assetId: `a_${id}` },
});
const doc = (items: any[], o: { tracks?: Tr[]; groups?: Record<string, any>; layerOrder?: any[]; duration?: number; fps?: number; size?: { width: number; height: number } } = {}) => {
  const tracks = o.tracks ?? [{ id: 'v1', kind: 'video' }];
  return {
    schemaVersion: 4, rev: 0, groups: o.groups ?? {}, duration: o.duration ?? 5000, fps: o.fps ?? 30, size: o.size ?? { width: 640, height: 360 }, background: { type: 'color', value: 'transparent' },
    transitions: [], markers: [], tracks: tracks.map(track), layerOrder: o.layerOrder ?? tracks.map(t => ({ type: 'track', id: t.id })), items,
  } as unknown as ProjectDocument;
};
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return undefined; };

describe('T16a repairTiming (provisional, notes Q-A: only clamps trims into [0, sourceDuration])', () => {
  it('clamps trim.from below 0 to 0 and trim.to above the source to the source, and returns the item ids it changed', () => {
    const d = doc([clip('a', 'v1', { trim: { from: -50, to: 3000 }, sd: 5000 }), clip('b', 'v1', { trim: { from: 0, to: 6000 }, sd: 5000 }), clip('c', 'v1', { trim: { from: 100, to: 2000 } })]);
    expect(repairTiming(d)).toEqual(['a', 'b']);
    expect(d.items[0].trim).toEqual({ from: 0, to: 3000 });
    expect(d.items[1].trim).toEqual({ from: 0, to: 5000 });
    expect(d.items[2].trim).toEqual({ from: 100, to: 2000 });
  });
  it('leaves values inside the 0.01 ms tolerance alone (written-spec oracle: tolerance 0.01 ms)', () => {
    const d = doc([clip('a', 'v1', { trim: { from: -0.005, to: 5000.005 }, sd: 5000 })]);
    expect(repairTiming(d)).toEqual([]);
    expect(d.items[0].trim).toEqual({ from: -0.005, to: 5000.005 });
  });
  it('does not touch non-finite or inverted trims (they stay as INVALID_MEDIA_TIMING issues) or items that are not video / audio', () => {
    const d = doc([clip('a', 'v1', { trim: { from: Number.NaN, to: 100 } }), clip('b', 'v1', { trim: { from: 900, to: 100 } }), clip('i', 'v1', { type: 'image', trim: { from: -5, to: 99999 } })]);
    expect(repairTiming(d)).toEqual([]);
    expect(d.items[1].trim).toEqual({ from: 900, to: 100 });
    expect(d.items[2].trim).toEqual({ from: -5, to: 99999 });
  });
});

describe('T16a timingIssues (written-spec oracle: error codes §12, five issue codes, tolerance 0.01 ms)', () => {
  const one = (trim: { from: number; to: number }, sd = 5000) => timingIssues(doc([clip('a', 'v1', { trim, sd })]));
  it('TRIM_FROM_INVALID: trim.from is not a finite number', () => {
    expect(one({ from: Number.NaN, to: 100 }).map(i => i.code)).toEqual(['TRIM_FROM_INVALID']);
    expect(one({ from: -Infinity, to: 100 }).map(i => i.code)).toEqual(['TRIM_FROM_INVALID']);
  });
  it('TRIM_TO_INVALID: trim.to is not a finite number', () => {
    expect(one({ from: 0, to: Number.NaN }).map(i => i.code)).toEqual(['TRIM_TO_INVALID']);
    expect(one({ from: 0, to: Infinity }).map(i => i.code)).toEqual(['TRIM_TO_INVALID']);
  });
  it('TRIM_BEFORE_SOURCE: trim.from below -0.01 ms; -0.005 ms passes', () => {
    expect(one({ from: -0.02, to: 100 }).map(i => i.code)).toEqual(['TRIM_BEFORE_SOURCE']);
    expect(one({ from: -0.005, to: 100 })).toEqual([]);
  });
  it('TRIM_INVERTED: trim.to more than 0.01 ms before trim.from; 0.005 ms before passes', () => {
    expect(one({ from: 1000, to: 999.98 }).map(i => i.code)).toEqual(['TRIM_INVERTED']);
    expect(one({ from: 1000, to: 999.995 })).toEqual([]);
  });
  it('TRIM_AFTER_SOURCE: trim.to more than 0.01 ms past the source duration; 0.005 ms past passes', () => {
    expect(one({ from: 0, to: 5000.02 }).map(i => i.code)).toEqual(['TRIM_AFTER_SOURCE']);
    expect(one({ from: 0, to: 5000.005 })).toEqual([]);
  });
  it('reports the first failing rule per item and one record per failing item, with the item id in the message', () => {
    const d = doc([clip('x', 'v1', { trim: { from: -5, to: -9 } }), clip('y', 'v1', { trim: { from: 0, to: 6000 } })]);
    const issues = timingIssues(d);
    expect(issues.map(i => [i.itemId, i.code])).toEqual([['x', 'TRIM_BEFORE_SOURCE'], ['y', 'TRIM_AFTER_SOURCE']]);
    expect(issues[0].message).toContain('x');
  });
  it('a source duration of 0 or missing does not raise TRIM_AFTER_SOURCE', () => {
    expect(one({ from: 0, to: 99999 }, 0)).toEqual([]);
  });
});

describe('T16a prepare', () => {
  it('copies the document: the input is never changed, even when the repair clamps a trim', () => {
    const input = doc([clip('a', 'v1', { trim: { from: -50, to: 6000 }, sd: 5000 })]), before = structuredClone(input);
    const r = prepare(input);
    expect(input).toEqual(before);
    expect(r.doc).not.toBe(input);
    expect(r.doc.items[0].trim).toEqual({ from: 0, to: 5000 });
    expect(r.repaired).toEqual(['a']);
  });
  it('throws INVALID_MEDIA_TIMING for an inverted trim left after the repair, with the issues in the error data (written-spec oracle: §12)', () => {
    const e = (() => { try { prepare(doc([clip('a', 'v1', { trim: { from: 900, to: 100 } })])); } catch (x) { return x as any; } })();
    expect(e.code).toBe('INVALID_MEDIA_TIMING');
    expect(e.data.issues.map((i: any) => i.code)).toEqual(['TRIM_INVERTED']);
    expect(e.detail).toContain('Invalid media timing');
  });
  it('a document that fails validation is rejected (not exported as is)', () => {
    expect(() => prepare({ ...doc([clip('a', 'v1')]), fps: 0 } as any)).toThrow();
    expect(() => prepare(null as any)).toThrow();
  });
  it('no range: frames = ceil(duration / 1000 × fps) from 0 (formula oracle: part 5 §53.8.4)', () => {
    expect(prepare(doc([clip('a', 'v1', { to: 10010 })], { duration: 10010 })).plan).toMatchObject({ first: 0, count: 301, shiftMs: 0, fps: 30 });
    expect(prepare(doc([clip('a', 'v1', { to: 10000 })], { duration: 10000 })).plan).toMatchObject({ first: 0, count: 300, shiftMs: 0 });
    expect(prepare(doc([clip('a', 'v1', { to: 10000 })], { duration: 10000, fps: 29.97 })).plan.count).toBe(Math.ceil(10 * 29.97));
  });
  it('trims a leading gap longer than 1 ms and shortens the export by it (written-spec oracle: findings §7 step 4)', () => {
    const p = prepare(doc([clip('a', 'v1', { from: 2000, to: 5000, trim: { from: 0, to: 3000 } })])).plan;
    expect(p.shiftMs).toBe(2000);
    expect(p.count).toBe(Math.ceil((5000 - 2000) / 1000 * 30));
  });
  it('does not trim a gap of 1 ms or less', () => {
    expect(prepare(doc([clip('a', 'v1', { from: 1, to: 5000, trim: { from: 0, to: 4999 } })])).plan.shiftMs).toBe(0);
  });
  it('a hidden track does not hold the start: the earliest item counts over visible tracks only', () => {
    const d = doc([clip('h', 'vh', { from: 0 }), clip('a', 'v1', { from: 2000, to: 5000, trim: { from: 0, to: 3000 } })], { tracks: [{ id: 'vh', kind: 'video', hidden: true }, { id: 'v1', kind: 'video' }] });
    expect(prepare(d).plan.shiftMs).toBe(2000);
  });
  it('no leading-gap shift when a range is set; the range gives floor(start × fps) … ceil(end × fps) − 1 (formula oracle: §53.8.4, range 1.0–2.0 s → frames 30…59)', () => {
    const d = doc([clip('a', 'v1', { from: 2000, to: 5000, trim: { from: 0, to: 3000 } })]);
    expect(prepare(d, { startS: 1, endS: 2 }).plan).toMatchObject({ first: 30, count: 30, shiftMs: 0 });
    expect(prepare(d, { startS: 0.5, endS: 1.51 }).plan).toMatchObject({ first: 15, count: Math.ceil(1.51 * 30) - 15, shiftMs: 0 });
  });
  it('a range outside the composition is CLIENT_BUG: negative start, end before start, end past the duration', () => {
    const d = doc([clip('a', 'v1')]);
    expect(code(() => prepare(d, { startS: -1, endS: 2 }))).toBe('CLIENT_BUG');
    expect(code(() => prepare(d, { startS: 2, endS: 2 }))).toBe('CLIENT_BUG');
    expect(code(() => prepare(d, { startS: 1, endS: 5.5 }))).toBe('CLIENT_BUG');
    expect(code(() => prepare(d, { startS: 0, endS: 5 }))).toBeUndefined();
  });
});

describe('T16a outputSize (written-spec oracle: findings §7 l.118: original = the canvas, otherwise the long edge with the other side scaled, both even)', () => {
  const size = (w: number, h: number, r?: any) => outputSize({ size: { width: w, height: h } }, r);
  it('original keeps the canvas, rounded to even, never below 2', () => {
    expect(size(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(size(1001, 555)).toEqual({ width: 1002, height: 556 });
    expect(size(1, 1)).toEqual({ width: 2, height: 2 });
  });
  it('a landscape canvas takes the preset as its width, a portrait one as its height (long edges 854, 1280, 1920, 2560, 3840)', () => {
    expect(size(1920, 1080, '720p')).toEqual({ width: 1280, height: 720 });
    expect(size(1920, 1080, '480p')).toEqual({ width: 854, height: 480 });
    expect(size(1080, 1920, '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(size(1080, 1920, '720p')).toEqual({ width: 720, height: 1280 });
    expect(size(1080, 1920, '480p')).toEqual({ width: 480, height: 854 });
    expect(size(1920, 1080, '1440p')).toEqual({ width: 2560, height: 1440 });
    expect(size(1920, 1080, '4k')).toEqual({ width: 3840, height: 2160 });
  });
  it('a square canvas takes the preset on both sides; both sides come out even for an odd ratio', () => {
    expect(size(1000, 1000, '4k')).toEqual({ width: 3840, height: 3840 });
    const s = size(1000, 333, '720p');
    expect(s.width).toBe(1280);
    expect(s.height % 2).toBe(0);
    expect(s.height).toBe(Math.round(1280 * 333 / 1000 / 2) * 2);
  });
});

describe('T16a exportedItems / exportedMedia (written-spec oracle: findings §7 prechecks, hidden tracks and groups are not exported)', () => {
  const tracks: Tr[] = [{ id: 'v1', kind: 'video' }, { id: 'vh', kind: 'video', hidden: true }, { id: 'v2', kind: 'video' }, { id: 'v3', kind: 'video' }, { id: 'a1', kind: 'audio' }];
  const items = [clip('on', 'v1'), clip('hiddenTrack', 'vh'), clip('inHiddenGroup', 'v2'), clip('inNested', 'v3'), clip('aud', 'a1', { type: 'audio' }), clip('img', 'v1', { type: 'image' }), clip('txt', 'v1', { type: 'text' })];
  const groups = {
    g1: { id: 'g1', name: 'g1', hidden: true, locked: false, children: [{ type: 'track', id: 'v2' }] },
    g2: { id: 'g2', name: 'g2', hidden: false, locked: false, children: [{ type: 'group', id: 'g3' }] },
    g3: { id: 'g3', name: 'g3', hidden: true, locked: false, children: [{ type: 'track', id: 'v3' }] },
  };
  const layerOrder = [{ type: 'track', id: 'a1' }, { type: 'track', id: 'v1' }, { type: 'track', id: 'vh' }, { type: 'group', id: 'g1' }, { type: 'group', id: 'g2' }];
  const d = doc(items, { tracks, groups, layerOrder });
  it('skips items on a hidden track, in a hidden group and in a group nested in a hidden group', () => {
    expect(exportedItems(d).map(i => i.id).sort()).toEqual(['aud', 'img', 'on', 'txt']);
  });
  it('exportedMedia keeps video, image and audio items only', () => {
    expect(exportedMedia(d).map(i => i.id).sort()).toEqual(['aud', 'img', 'on']);
  });
  it('a group that is not hidden exports its tracks', () => {
    const open = doc([clip('x', 'v2')], { tracks: [{ id: 'v2', kind: 'video' }], groups: { g1: { id: 'g1', name: 'g1', hidden: false, locked: false, children: [{ type: 'track', id: 'v2' }] } }, layerOrder: [{ type: 'group', id: 'g1' }] });
    expect(exportedItems(open).map(i => i.id)).toEqual(['x']);
  });
});

describe('T16a exportFilename (written-spec oracle: findings §7: the given name or the project title, never empty, with .mp4)', () => {
  it('the given name wins over the title; .mp4 is added once, in any case', () => {
    expect(exportFilename('Final cut', 'Project')).toBe('Final cut.mp4');
    expect(exportFilename('Final.MP4', undefined)).toBe('Final.mp4');
    expect(exportFilename(undefined, 'My project')).toBe('My project.mp4');
  });
  it('replaces path and reserved characters and control characters with "-"', () => {
    expect(exportFilename('a/b\\c:d*e?f"g<h>i|j', undefined)).toBe('a-b-c-d-e-f-g-h-i-j.mp4');
    expect(exportFilename('x\u0001y\u001fz', undefined)).toBe('x-y-z.mp4');
  });
  it('nothing usable falls back to "Untitled"', () => {
    expect(exportFilename(undefined, undefined)).toBe('Untitled.mp4');
    expect(exportFilename('', 'Title')).toBe('Title.mp4');
    expect(exportFilename('  ', 'Title')).toBe('Title.mp4');
    expect(exportFilename('', '')).toBe('Untitled.mp4');
    expect(exportFilename('   ', '   ')).toBe('Untitled.mp4');
    expect(exportFilename('.mp4', undefined)).toBe('Untitled.mp4');
  });
});

describe('T16a drawSource (freeze 6, S3: T06 shapes; coordinator rule: a draw kind the export does not know fails with a named error, never a silent video-path decode)', () => {
  const run = (d: unknown) => {
    const refOf = vi.fn(), frame = vi.fn();
    const p = drawSource({} as never, d as never, refOf as never, { frame } as never, new Set(), undefined);
    return { p, refOf, frame };
  };
  it('U1: an unknown draw kind (hologram: T05 made text a known kind) rejects with CLIENT_BUG naming the item and the kind; refOf and the decoders are never called', async () => {
    const { p, refOf, frame } = run({ kind: 'hologram', item: { id: 't1' }, sourceMs: 0 });
    await expect(p).rejects.toMatchObject({ code: 'CLIENT_BUG', message: expect.stringMatching(/t1.*'hologram'/) });
    expect(refOf).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });
  it('U2: a shape draw has no source (render/sources.ts picture: drawn as vectors by the compositor): resolves null; refOf and the decoders are never called', async () => {
    const { p, refOf, frame } = run({ kind: 'shape', item: { id: 's1' } });
    await expect(p).resolves.toBeNull();
    expect(refOf).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });
});

describe('T16a audioFailure (freeze 7 round 2: the audio stage reports a video item\'s demux error as UNSUPPORTED_INPUT and audioFailure keeps that code; any other audio error is AUDIO_FAILED)', () => {
  it('a plain audio decode error is AUDIO_FAILED, with the message in the detail (freeze 6 made it UNSUPPORTED_INPUT)', () => {
    const msg = 'The audio could not be decoded: Invalid data found when processing input', f = audioFailure(new Error(msg));
    expect(f).toMatchObject({ code: 'AUDIO_FAILED', detail: `Audio mix failed: ${msg}` });
    expect(classifyExportError(f).code).toBe('AUDIO_FAILED');
  });
  it('a coded UNSUPPORTED_INPUT from the audio stage stays UNSUPPORTED_INPUT', () => {
    const f = audioFailure(mediaError('UNSUPPORTED_INPUT', 'This file could not be opened: Could not open source file'));
    expect(f).toMatchObject({ code: 'UNSUPPORTED_INPUT', detail: 'This file could not be opened: Could not open source file' });
    expect(classifyExportError(f).code).toBe('UNSUPPORTED_INPUT');
  });
  it('USER_CANCELLED passes through as the same object', () => {
    const e = new ExportError('USER_CANCELLED', 'Export cancelled by user');
    expect(audioFailure(e)).toBe(e);
  });
});
