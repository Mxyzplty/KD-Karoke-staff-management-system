// SPDX-License-Identifier: AGPL-3.0-only
// T15 F6 review a8ac32aa finding 1 (red-first, D115): a failed image's error for captureFrame must survive clearSources() and never be another
// decode's. bc0e16d keeps the error in a second map, imageErrors, beside the cached 'failed' (render/sources.ts:88 writes it, :113 reads it, :125
// clears it), so (1) clearSources() between the decode settling and picture('capture') reading the map leaves picture to throw undefined, reported
// as "DECODE_ERROR: undefined"; (2) a decode started before clearSources() and rejecting after it writes its error into the cleared map, where a
// later capture of the fresh decode reads it. Oracle: lane A's ruling of 19 Nov 2026 (an uncoded error is DECODE_ERROR with the error's own
// message; the reported error is that decode's). DOM decoding is mocked as in tests/t25-svg-sources.test.ts; tests/ui/t15-capture-failed.spec.ts
// covers the real browser path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStore } from '../apps/web/src/store/database';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import type { Draw } from '../apps/web/src/render/model';
import type { Source, SourceFailure } from '../apps/web/src/render/compositor';
import { clearSources, imageBitmap, picture, readyImage } from '../apps/web/src/render/sources';

vi.mock('../apps/web/src/media/resolver', () => ({ resolveSource: vi.fn(), usesProxy: () => false }));
vi.mock('../apps/web/src/mg/frames', () => ({ clearGraphics: vi.fn(), graphicPicture: vi.fn() }));
vi.mock('../apps/web/src/render/decoder-pool', () => ({ decodeFrame: vi.fn(), transientDecodeError: () => false }));
vi.mock('../apps/web/src/render/model', () => ({ isStackedAlpha: () => false }));

const item = (): RecordData => ({ id: 'img', type: 'image', details: { name: 'Bad still' }, metadata: { assetId: 'asset-one' } });
const draw = () => ({ kind: 'image', item: item() }) as unknown as Draw;
const row = (): Asset => ({ id: 'asset-one', type: 'image', name: 'bad.png', mimeType: 'image/png', media: { container: 'png', image: { width: 32, height: 24, orientation: 1 } } } as Asset);
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const failedOf = (s: Source) => { expect(s, 'a capture failure').toMatchObject({ failed: expect.any(Object) }); return (s as { failed: SourceFailure }).failed; };

let store: ProjectStore, createBitmap: ReturnType<typeof vi.fn>;
beforeEach(() => {
  store = { media: { read: vi.fn(async () => new Blob(['not an image'])) }, row: vi.fn(async () => row()) } as unknown as ProjectStore;
  createBitmap = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:t15'), revokeObjectURL: vi.fn() });
  vi.stubGlobal('createImageBitmap', createBitmap);
});
afterEach(() => { clearSources(); vi.unstubAllGlobals(); });

describe('T15 F6 review finding 1: a failed image\'s capture error across clearSources()', () => {
  it('clearSources() after the decode rejects and before picture(\'capture\') reads the error: the failure still carries the decode\'s message, never "undefined"', async () => {
    createBitmap.mockRejectedValue(new Error('decode boom'));
    // The same cached promise picture() awaits; this reaction is registered first, so it runs after the rejection settles and before picture resumes.
    void imageBitmap(store, item()).then(() => clearSources());
    const f = failedOf(await picture(store, draw(), undefined, 'capture'));
    expect(f.message, 'the decode\'s own message').toBe('decode boom');
    expect(f.text).not.toContain('undefined');
    expect(f.text).toBe("Image 'Bad still' (img) could not be decoded: DECODE_ERROR: decode boom");
  });

  it('a decode started before clearSources() and rejecting after it does not leave its error for a later capture of the fresh decode', async () => {
    const stale = deferred<ImageBitmap>(), fresh = deferred<ImageBitmap>();
    createBitmap.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    void imageBitmap(store, item());
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(1));
    clearSources();
    const first = picture(store, draw(), undefined, 'capture');
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(2));
    fresh.reject(new Error('fresh decode failed'));
    expect(failedOf(await first).message, 'the fresh decode\'s error').toBe('fresh decode failed');
    stale.reject(new Error('stale decode failed'));
    await new Promise(r => setTimeout(r, 0)); // the stale decode settles
    const later = failedOf(await picture(store, draw(), undefined, 'capture'));
    expect(later.message, 'still the fresh decode\'s error, not the stale one').toBe('fresh decode failed');
    expect(createBitmap, 'the later capture reuses the fresh cached decode').toHaveBeenCalledTimes(2);
  });

  // Row 3 (lane A, 19 Nov 2026; pre-existing, same class): a decode started before clearSources() and settling after the fresh one must not write
  // readyImages (sources.ts:89 writes it for every decode), so readyImage() keeps the fresh decode's value.
  const bitmap = (width: number) => ({ width, height: 24, close: vi.fn() }) as unknown as ImageBitmap;
  it.each([
    ['the stale decode succeeds after the fresh one failed: readyImage stays \'failed\', not the stale bitmap', 'reject', 'resolve'],
    ['the stale decode fails after the fresh one succeeded: readyImage stays the fresh bitmap, not \'failed\'', 'resolve', 'reject'],
  ] as const)('%s', async (_, freshEnd, staleEnd) => {
    const stale = deferred<ImageBitmap>(), fresh = deferred<ImageBitmap>(), staleBitmap = bitmap(1), freshBitmap = bitmap(2);
    createBitmap.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    void imageBitmap(store, item());
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(1));
    clearSources();
    const freshDecode = imageBitmap(store, item());
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(2));
    if (freshEnd === 'resolve') fresh.resolve(freshBitmap); else fresh.reject(new Error('fresh decode failed'));
    const expected = await freshDecode;
    expect(expected, 'the fresh decode settled').toBe(freshEnd === 'resolve' ? freshBitmap : 'failed');
    if (staleEnd === 'resolve') stale.resolve(staleBitmap); else stale.reject(new Error('stale decode failed'));
    await new Promise(r => setTimeout(r, 0)); // the stale decode settles
    expect(readyImage(item()), 'readyImage is the fresh decode\'s value').toBe(expected);
  });
});
