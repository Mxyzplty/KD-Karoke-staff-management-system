// SPDX-License-Identifier: AGPL-3.0-only
// T19 C8: analysis/footage.ts: the search request shape, searchFootage over an injected service, isRange, clipName, clipRange
// with an injected cut. media/work.ts cutRange (WebCodecs) is covered by the C7 UI spec. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { SEARCH_LIMIT, clipName, clipRange, isRange, searchFootage, searchRequest } from '../apps/web/src/analysis/footage';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { SearchResponse, SearchRow } from '../apps/web/src/analysis/types';
import type { Asset } from '../apps/web/src/store/model';

describe('T19 C8 searchRequest', () => {
  it('defaults: general mode, medium threshold, limit 30, no projectId / assetType keys', () => {
    const r = searchRequest('beach at dusk');
    expect(r).toEqual({ query: 'beach at dusk', mode: 'general', options: { threshold: 'medium', limit: 30 } });
    expect(SEARCH_LIMIT).toBe(30);
    expect(r).not.toHaveProperty('projectId'); expect(r.options).not.toHaveProperty('assetType');
    expect(Object.keys(searchRequest('q', {}))).toEqual(Object.keys(r));
  });
  it('given options are placed: projectId at the top, threshold / assetType / limit under options', () => {
    expect(searchRequest('q', { projectId: 'p1', threshold: 'high', assetType: 'video', limit: 5 }))
      .toEqual({ query: 'q', projectId: 'p1', mode: 'general', options: { threshold: 'high', assetType: 'video', limit: 5 } });
  });
  it('each option alone changes only its own field', () => {
    expect(searchRequest('q', { limit: 7 }).options).toEqual({ threshold: 'medium', limit: 7 });
    expect(searchRequest('q', { threshold: 'low' }).options).toEqual({ threshold: 'low', limit: 30 });
    expect(searchRequest('q', { assetType: 'audio' }).options).toEqual({ threshold: 'medium', limit: 30, assetType: 'audio' });
    expect(searchRequest('q', { projectId: 'p2' })).toMatchObject({ projectId: 'p2' });
  });
});

describe('T19 C8 searchFootage', () => {
  const response = { results: [], metadata: {} } as unknown as SearchResponse;
  it('calls service.search(store, searchRequest(q, opts), signal) once with the same store and signal and returns the result unchanged', async () => {
    const store = { tag: 'store' } as never, signal = new AbortController().signal, search = vi.fn(async (..._a: unknown[]) => response);
    const out = await searchFootage('waves', { projectId: 'p1', limit: 3 }, signal, { store, service: { search } });
    expect(out).toBe(response); expect(search).toHaveBeenCalledTimes(1);
    const [s, request, sig] = search.mock.calls[0];
    expect(s).toBe(store); expect(sig).toBe(signal); expect(request).toEqual(searchRequest('waves', { projectId: 'p1', limit: 3 }));
  });
  it('without options or signal: the default request and an undefined signal', async () => {
    const search = vi.fn(async (..._a: unknown[]) => response);
    await searchFootage('waves', undefined, undefined, { store: {} as never, service: { search } });
    expect(search.mock.calls[0][1]).toEqual(searchRequest('waves')); expect(search.mock.calls[0][2]).toBeUndefined();
  });
  it('a rejected search propagates (ANALYSIS_UNAVAILABLE keeps its code)', async () => {
    const search = vi.fn(async (..._a: unknown[]): Promise<SearchResponse> => { throw new AnalysisError('ANALYSIS_UNAVAILABLE', 'models missing'); });
    const err = await searchFootage('q', {}, undefined, { store: {} as never, service: { search } }).catch(e => e);
    expect(err).toBeInstanceOf(AnalysisError); expect(err).toMatchObject({ code: 'ANALYSIS_UNAVAILABLE', message: 'models missing' });
  });
});

describe('T19 C8 isRange', () => {
  const row = (extra: Record<string, unknown>) => ({ assetId: 'a', ...extra }) as unknown as SearchRow;
  it('true only when startTime and endTime are both numbers (0 counts)', () => {
    expect(isRange(row({ startTime: 0, endTime: 6 }))).toBe(true);
    expect(isRange(row({ startTime: 2.5, endTime: 0 }))).toBe(true);
    expect(isRange(row({ startTime: 0, endTime: 0 }))).toBe(true);
  });
  it('false for a whole-asset row and for a half range', () => {
    expect(isRange(row({}))).toBe(false);
    expect(isRange(row({ startTime: 1 }))).toBe(false);
    expect(isRange(row({ endTime: 4 }))).toBe(false);
    expect(isRange(row({ startTime: null, endTime: null }))).toBe(false);
    expect(isRange(row({ startTime: '1', endTime: '2' }))).toBe(false);
  });
});

describe('T19 C8 clipName', () => {
  it('<name>_<m>m<ss>s-<m>m<ss>s.<ext>, seconds floored', () => {
    expect(clipName('beach.mov', 0, 6.4, 'mp4')).toBe('beach_0m00s-0m06s.mp4');
    expect(clipName('a.b.mp4', 65, 125, 'webm')).toBe('a.b_1m05s-2m05s.webm');
    expect(clipName('x.mp4', 59.9, 3600, 'mp4')).toBe('x_0m59s-60m00s.mp4');
  });
  it('only the last extension is dropped; none → the whole name', () => {
    expect(clipName('clip', 0, 1, 'mp4')).toBe('clip_0m00s-0m01s.mp4');
    expect(clipName('my.clip.final.mov', 1, 2, 'mp4')).toBe('my.clip.final_0m01s-0m02s.mp4');
  });
});

describe('T19 C8 clipRange', () => {
  const blob = new Blob(['source']), cutBlob = new Blob(['cut']);
  const asset = (extra: Record<string, unknown> = {}) => ({ id: 'asset-1', name: 'beach.mov', type: 'video', durationMs: 10_000, media: { container: 'mov' }, ...extra }) as unknown as Asset;
  const rig = (read: () => Promise<Blob> = async () => blob, cutImpl?: (...a: unknown[]) => Promise<unknown>) => {
    const store = { media: { read: vi.fn(read) } }, cut = vi.fn(cutImpl ?? (async () => ({ blob: cutBlob, extension: 'mp4' as const })));
    return { store: store as never, read: store.media.read, cut: cut as never, cutMock: cut };
  };
  it('reads the source, calls cut(blob, asset.media, [from, to], signal) once and returns the cut blob with the clip filename', async () => {
    const a = asset(), signal = new AbortController().signal, { store, read, cut, cutMock } = rig();
    const out = await clipRange(store, a, 0, 6.4, signal, cut);
    expect(read).toHaveBeenCalledWith('asset-1'); expect(cutMock).toHaveBeenCalledTimes(1);
    expect(cutMock.mock.calls[0]).toEqual([blob, a.media, [0, 6.4], signal]); expect(cutMock.mock.calls[0][0]).toBe(blob); expect(cutMock.mock.calls[0][3]).toBe(signal);
    expect(out).toEqual({ blob: cutBlob, filename: clipName('beach.mov', 0, 6.4, 'mp4') }); expect(out.blob).toBe(cutBlob); expect(out.filename).toBe('beach_0m00s-0m06s.mp4');
  });
  it("the cut's extension names the file (webm)", async () => {
    const { store, cut } = rig(undefined, async () => ({ blob: cutBlob, extension: 'webm' }));
    expect((await clipRange(store, asset({ durationMs: 200_000 }), 65, 125, undefined, cut)).filename).toBe('beach_1m05s-2m05s.webm');
  });
  it('start below 0 → 0; end beyond the asset duration → the duration; no duration → end kept', async () => {
    let r = rig(); await clipRange(r.store, asset(), -5, 4, undefined, r.cut); expect(r.cutMock.mock.calls[0][2]).toEqual([0, 4]);
    r = rig(); await clipRange(r.store, asset(), 2, 99, undefined, r.cut); expect(r.cutMock.mock.calls[0][2]).toEqual([2, 10]);
    r = rig(); const out = await clipRange(r.store, asset(), -1, 99, undefined, r.cut); expect(r.cutMock.mock.calls[0][2]).toEqual([0, 10]); expect(out.filename).toBe('beach_0m00s-0m10s.mp4');
    r = rig(); await clipRange(r.store, asset({ durationMs: undefined }), 3, 500, undefined, r.cut); expect(r.cutMock.mock.calls[0][2]).toEqual([3, 500]);
  });
  it('an invalid range → INVALID_ANALYSIS_INPUT with the message; neither media.read nor cut is called', async () => {
    const message = 'The clip range must be finite and increasing inside the asset.';
    const ranges: [number, number][] = [[5, 5], [6, 5], [NaN, 3], [1, NaN], [10, 20], [12, 20], [-3, -1]];
    for (const [start, end] of ranges) {
      const r = rig();
      const err = await clipRange(r.store, asset(), start, end, undefined, r.cut).catch(e => e);
      expect(err, `${start}-${end}`).toBeInstanceOf(AnalysisError); expect(err).toMatchObject({ code: 'INVALID_ANALYSIS_INPUT', message });
      expect(r.read, `${start}-${end}`).not.toHaveBeenCalled(); expect(r.cutMock, `${start}-${end}`).not.toHaveBeenCalled();
    }
  });
  it('a media.read rejection (WORKSPACE_FILE_MISSING) propagates and cut is not called', async () => {
    const r = rig(async () => { throw new AnalysisError('WORKSPACE_FILE_MISSING', 'gone'); });
    expect(await clipRange(r.store, asset(), 0, 2, undefined, r.cut).catch(e => e)).toMatchObject({ code: 'WORKSPACE_FILE_MISSING', message: 'gone' });
    expect(r.cutMock).not.toHaveBeenCalled();
  });
  it('a cut rejection propagates', async () => {
    const r = rig(undefined, async () => { throw new AnalysisError('CLIP_FAILED', 'encode'); });
    expect(await clipRange(r.store, asset(), 0, 2, undefined, r.cut).catch(e => e)).toMatchObject({ code: 'CLIP_FAILED', message: 'encode' });
    expect(r.read).toHaveBeenCalledTimes(1);
  });
});
