// SPDX-License-Identifier: AGPL-3.0-only
// T25: the accepted stored-size table, branch boundaries and image-source contract. DOM decoding is mocked here;
// t25-svg-sources.spec.ts separately uses Chromium's real Image, canvas and ImageBitmap implementations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStore } from '../apps/web/src/store/database';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import { clearSources, imageBitmap, readyImage } from '../apps/web/src/render/sources';

vi.mock('../apps/web/src/media/resolver', () => ({ resolveSource: vi.fn(), usesProxy: () => false }));
vi.mock('../apps/web/src/mg/frames', () => ({ clearGraphics: vi.fn(), graphicPicture: vi.fn() }));
vi.mock('../apps/web/src/render/decoder-pool', () => ({ decodeFrame: vi.fn(), transientDecodeError: () => false }));
vi.mock('../apps/web/src/render/model', () => ({ isStackedAlpha: () => false }));

type MockCanvas = { width: number; height: number; getContext: ReturnType<typeof vi.fn> };
const item = (assetId = 'asset-one'): RecordData => ({ id: 'image-one', type: 'image', metadata: { assetId } });
const row = (width = 512, height = 512): Asset => ({ id: 'asset-one', type: 'image', name: 'picture.svg', mimeType: 'image/svg+xml',
  media: { container: 'svg+xml', image: { width, height, orientation: 1 } } } as Asset);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

let stored: Blob, read: ReturnType<typeof vi.fn>, readRow: ReturnType<typeof vi.fn>, store: ProjectStore;
let decode: ReturnType<typeof vi.fn>, drawImage: ReturnType<typeof vi.fn>, createElement: ReturnType<typeof vi.fn>;
let createBitmap: ReturnType<typeof vi.fn>, createUrl: ReturnType<typeof vi.fn>, revokeUrl: ReturnType<typeof vi.fn>;
let canvases: MockCanvas[], madeImages: { src: string; decode: ReturnType<typeof vi.fn> }[], madeBitmaps: ImageBitmap[];

beforeEach(() => {
  stored = new Blob(['original stored bytes']);
  read = vi.fn(async () => stored); readRow = vi.fn(async () => row());
  store = { media: { read }, row: readRow } as unknown as ProjectStore;
  canvases = []; madeImages = []; madeBitmaps = [];
  decode = vi.fn(async () => undefined); drawImage = vi.fn();
  createUrl = vi.fn(() => 'blob:svg-test'); revokeUrl = vi.fn();
  createElement = vi.fn((tag: string) => {
    if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`);
    const canvas = { width: 300, height: 150, getContext: vi.fn(() => ({ drawImage })) };
    canvases.push(canvas); return canvas;
  });
  createBitmap = vi.fn(async (source: Blob | MockCanvas) => {
    const bitmap = { width: source instanceof Blob ? 32 : source.width, height: source instanceof Blob ? 24 : source.height, close: vi.fn() } as unknown as ImageBitmap;
    madeBitmaps.push(bitmap); return bitmap;
  });
  vi.stubGlobal('Image', class {
    src = ''; decode = decode;
    constructor() { madeImages.push(this); }
  });
  vi.stubGlobal('document', { createElement });
  vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
  vi.stubGlobal('createImageBitmap', createBitmap);
});
afterEach(() => { clearSources(); vi.unstubAllGlobals(); });

describe('T25 exact-ratio raster sizes (accepted table, not a recomputed clamp oracle)', () => {
  it.each([
    [24, 24, 2048, 2048], [512, 512, 2048, 2048], [720, 240, 2049, 683], [540, 1080, 1024, 2048],
    [3000, 1000, 3000, 1000], [6000, 2000, 4095, 1365], [5000, 3001, 4096, 2458],
  ])('stored %i x %i gives canvas/bitmap %i x %i', async (width, height, W, H) => {
    readRow.mockResolvedValue(row(width, height));
    const result = await imageBitmap(store, item());
    expect(result).toMatchObject({ width: W, height: H });
    expect(canvases).toHaveLength(1); expect([canvases[0].width, canvases[0].height]).toEqual([W, H]);
    expect(createBitmap).toHaveBeenCalledExactlyOnceWith(canvases[0]);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(madeImages[0], 0, 0, W, H);
    expect(createBitmap.mock.calls[0][0]).not.toBe(madeImages[0]);
    expect(createBitmap.mock.calls[0][0]).not.toBe(stored);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:svg-test');
  });

  it.each([[2047, 2048], [2048, 2048], [4096, 4096], [4097, 4096]])('long-side edge %i preserves the stated branch result %i', async (side, expected) => {
    readRow.mockResolvedValue(row(side, side));
    expect(await imageBitmap(store, item())).toMatchObject({ width: expected, height: expected });
  });

  it('a reduced long side of exactly 4096 remains exactly representable under the cap', async () => {
    readRow.mockResolvedValue(row(8192, 2));
    expect(await imageBitmap(store, item())).toMatchObject({ width: 4096, height: 1 });
  });
  it('the unrepresentable portrait branch rounds the other axis, not a fixed width axis', async () => {
    readRow.mockResolvedValue(row(3001, 5000));
    expect(await imageBitmap(store, item())).toMatchObject({ width: 2458, height: 4096 });
  });
  it('an unrepresentable tiny short side is clamped to one positive pixel', async () => {
    readRow.mockResolvedValue(row(10000, 1));
    expect(await imageBitmap(store, item())).toMatchObject({ width: 4096, height: 1 });
  });
});

describe('T25 invalid stored SVG dimensions', () => {
  for (const axis of ['width', 'height'] as const) for (const [label, value] of [
    ['zero', 0], ['negative', -1], ['NaN', Number.NaN], ['positive infinity', Number.POSITIVE_INFINITY], ['negative infinity', Number.NEGATIVE_INFINITY],
  ] as const) it(`${axis}: ${label} settles failed before URL/Image/canvas creation and stays cached`, async () => {
    const asset = row(); asset.media!.image![axis] = value; readRow.mockResolvedValue(asset);
    const pending = imageBitmap(store, item());
    expect(await pending).toBe('failed'); expect(readyImage(item())).toBe('failed');
    expect(imageBitmap(store, item())).toBe(pending);
    expect(read).toHaveBeenCalledTimes(1); expect(readRow).toHaveBeenCalledExactlyOnceWith('assets', 'asset-one');
    expect(createUrl).not.toHaveBeenCalled(); expect(madeImages).toEqual([]);
    expect(createElement).not.toHaveBeenCalled(); expect(createBitmap).not.toHaveBeenCalled();
  });
  it('a stored SVG with no image dimensions is failed rather than silently taking the native path', async () => {
    readRow.mockResolvedValue({ ...row(), media: { container: 'svg+xml' } });
    expect(await imageBitmap(store, item())).toBe('failed');
    expect(createUrl).not.toHaveBeenCalled(); expect(createBitmap).not.toHaveBeenCalled();
  });
});

describe('T25 row lookup and unchanged native path', () => {
  it.each(['image/png', ''])('PNG Blob type %j reaches native decoding by original object identity, with no Image', async type => {
    stored = new Blob(['png sentinel'], { type }); readRow.mockResolvedValue({ ...row(), media: { container: 'png' } });
    const result = await imageBitmap(store, item());
    expect(result).toBe(madeBitmaps[0]); expect(result).toMatchObject({ width: 32, height: 24 });
    expect(createBitmap).toHaveBeenCalledExactlyOnceWith(stored);
    expect(createBitmap.mock.calls[0][0]).toBe(stored); // Object identity, not merely equal Blob bytes/properties.
    expect(madeImages).toEqual([]); expect(decode).not.toHaveBeenCalled(); expect(createElement).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled(); expect(revokeUrl).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'absent media', media: undefined }, { label: 'null media', media: null },
    { label: 'absent container', media: { image: { width: 512, height: 512, orientation: 1 } } },
    { label: 'non-matching container', media: { container: 'svg' } },
  ])('$label on an existing row is the native original-Blob path', async ({ media }) => {
    // The .svg name and SVG MIME deliberately disagree with the stored container: neither identifies the SVG branch.
    stored = new Blob(['not selected by Blob MIME'], { type: 'image/svg+xml' });
    readRow.mockResolvedValue({ ...row(), media });
    await imageBitmap(store, item());
    expect(createBitmap).toHaveBeenCalledExactlyOnceWith(stored); expect(madeImages).toEqual([]); expect(createUrl).not.toHaveBeenCalled();
    expect(createBitmap.mock.calls[0][0]).toBe(stored);
  });

  it.each(['missing', 'rejected'])('%s asset row settles failed once and does not decode or retry', async kind => {
    if (kind === 'missing') readRow.mockResolvedValue(undefined); else readRow.mockRejectedValue(new Error('row read refused'));
    const pending = imageBitmap(store, item());
    expect(await pending).toBe('failed'); expect(readyImage(item())).toBe('failed');
    expect(imageBitmap(store, { ...item(), id: 'another-item' })).toBe(pending);
    expect(read).toHaveBeenCalledTimes(1); expect(readRow).toHaveBeenCalledExactlyOnceWith('assets', 'asset-one');
    expect(createBitmap).not.toHaveBeenCalled(); expect(madeImages).toEqual([]); expect(createUrl).not.toHaveBeenCalled();
  });
  it('a rejected stored-Blob read settles failed without attempting a row lookup', async () => {
    read.mockRejectedValue(new Error('stored bytes missing'));
    const pending = imageBitmap(store, item()); expect(await pending).toBe('failed');
    expect(imageBitmap(store, item())).toBe(pending); expect(readyImage(item())).toBe('failed');
    expect(read).toHaveBeenCalledTimes(1); expect(readRow).not.toHaveBeenCalled(); expect(createBitmap).not.toHaveBeenCalled();
  });
  it('a native bitmap rejection still settles and caches failed, without SVG fallback', async () => {
    readRow.mockResolvedValue({ ...row(), media: { container: 'png' } }); createBitmap.mockRejectedValue(new Error('native decode refused'));
    const pending = imageBitmap(store, item()); expect(await pending).toBe('failed');
    expect(imageBitmap(store, item())).toBe(pending); expect(readyImage(item())).toBe('failed');
    expect(createBitmap).toHaveBeenCalledExactlyOnceWith(stored); expect(madeImages).toEqual([]);
  });
});

describe('T25 SVG MIME restoration, promise identity and URL lifetime', () => {
  it.each(['image/svg+xml', ''])('stored Blob type %j is rewrapped with the same bytes as image/svg+xml', async type => {
    stored = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type });
    const result = await imageBitmap(store, item()), wrapped = createUrl.mock.calls[0][0] as Blob;
    expect(wrapped).not.toBe(stored); expect(wrapped.type).toBe('image/svg+xml'); expect(await wrapped.text()).toBe(await stored.text());
    expect(madeImages[0].src).toBe('blob:svg-test'); expect(decode).toHaveBeenCalledTimes(1);
    expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas'); expect(canvases[0].getContext).toHaveBeenCalledExactlyOnceWith('2d');
    expect(createBitmap).toHaveBeenCalledExactlyOnceWith(canvases[0]); expect(readyImage(item())).toBe(result);
  });

  it('concurrent items for one asset share the exact pending promise; row read is awaited once before decoding', async () => {
    const gate = deferred<Asset>(); readRow.mockReturnValue(gate.promise);
    const a = imageBitmap(store, item()), b = imageBitmap(store, { ...item(), id: 'image-two' });
    expect(b).toBe(a); expect(readyImage(item())).toBeUndefined();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1); expect(readRow).toHaveBeenCalledExactlyOnceWith('assets', 'asset-one');
    expect(createUrl).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    gate.resolve(row()); const result = await a;
    expect(result).toBe(madeBitmaps[0]); expect(await b).toBe(result); expect(imageBitmap(store, item())).toBe(a);
    expect(decode).toHaveBeenCalledTimes(1); expect(readRow).toHaveBeenCalledTimes(1); expect(readyImage(item())).toBe(result);
  });
  it('the object URL remains live until the bitmap-from-canvas promise settles, then is revoked once', async () => {
    const reached = deferred<void>(), gate = deferred<ImageBitmap>();
    createBitmap.mockImplementation(() => { reached.resolve(); return gate.promise; });
    const pending = imageBitmap(store, item()); await reached.promise;
    expect(revokeUrl).not.toHaveBeenCalled(); expect(readyImage(item())).toBeUndefined();
    const bitmap = { width: 2048, height: 2048, close: vi.fn() } as unknown as ImageBitmap;
    gate.resolve(bitmap); expect(await pending).toBe(bitmap);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:svg-test'); expect(readyImage(item())).toBe(bitmap);
  });

  it.each(['Image constructor', 'decode', 'null 2d context', 'drawImage', 'bitmap'])('%s failure revokes the URL and settles the same cached failed promise', async stage => {
    if (stage === 'Image constructor') vi.stubGlobal('Image', class { constructor() { throw new Error('Image unavailable'); } });
    if (stage === 'decode') decode.mockRejectedValue(new Error('malformed SVG'));
    if (stage === 'null 2d context') createElement.mockImplementation(() => ({ width: 0, height: 0, getContext: () => null }));
    if (stage === 'drawImage') drawImage.mockImplementation(() => { throw new Error('draw refused'); });
    if (stage === 'bitmap') createBitmap.mockRejectedValue(new Error('canvas bitmap refused'));
    const pending = imageBitmap(store, item()); expect(await pending).toBe('failed');
    expect(imageBitmap(store, item())).toBe(pending); expect(readyImage(item())).toBe('failed');
    expect(createUrl).toHaveBeenCalledTimes(1); expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:svg-test');
    expect(read).toHaveBeenCalledTimes(1); expect(readRow).toHaveBeenCalledTimes(1);
  });
  it('URL creation failure is cached failed and does not try to revoke an uncreated URL', async () => {
    createUrl.mockImplementation(() => { throw new Error('URL refused'); });
    const pending = imageBitmap(store, item()); expect(await pending).toBe('failed'); expect(imageBitmap(store, item())).toBe(pending);
    expect(revokeUrl).not.toHaveBeenCalled(); expect(madeImages).toEqual([]); expect(readyImage(item())).toBe('failed');
  });
  it('different asset ids do not share row reads, URLs or bitmaps', async () => {
    const [a, b] = await Promise.all([imageBitmap(store, item()), imageBitmap(store, item('asset-two'))]);
    expect(a).not.toBe(b); expect(read.mock.calls).toEqual([['asset-one'], ['asset-two']]);
    expect(readRow.mock.calls).toEqual([['assets', 'asset-one'], ['assets', 'asset-two']]); expect(createBitmap).toHaveBeenCalledTimes(2);
  });
  it('clearSources closes a settled bitmap and is the only reset that allows another read/decode', async () => {
    const first = imageBitmap(store, item()), bitmap = await first;
    clearSources(); expect(bitmap).not.toBe('failed'); expect((bitmap as ImageBitmap).close).toHaveBeenCalledTimes(1); expect(readyImage(item())).toBeUndefined();
    const second = imageBitmap(store, item()); expect(second).not.toBe(first); await second;
    expect(read).toHaveBeenCalledTimes(2); expect(readRow).toHaveBeenCalledTimes(2); expect(decode).toHaveBeenCalledTimes(2);
  });
  it('a cached failure is retried only after clearSources, not after another item asks for it', async () => {
    decode.mockRejectedValueOnce(new Error('first decode refused'));
    const failed = imageBitmap(store, item()); expect(await failed).toBe('failed'); expect(imageBitmap(store, item())).toBe(failed);
    clearSources(); expect(readyImage(item())).toBeUndefined();
    const next = imageBitmap(store, item()); expect(next).not.toBe(failed); expect(await next).toMatchObject({ width: 2048, height: 2048 });
    expect(read).toHaveBeenCalledTimes(2); expect(decode).toHaveBeenCalledTimes(2);
  });
});
