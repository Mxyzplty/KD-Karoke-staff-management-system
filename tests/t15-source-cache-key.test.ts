// SPDX-License-Identifier: AGPL-3.0-only
// T15 F10 product defect (red-first, D115; heavy 5m: t15-proxy-noop l.82 resolved "proxy" after useProxy false). render/sources.ts itemMedia keys its
// cache on the asset the caller passes (mediaKey, :27-28), but the cached value comes from media/resolver.ts resolveSource (:34), which re-reads the
// asset from the store (resolver.ts:12-14). A caller asset without its proxy yet (the stage's asset map lags the store) and useProxy true caches the
// proxy under '<id>:original'; after useProxy false, '<id>:original' returns that proxy entry.
// Written-spec oracle (findings §2, resolver.ts header): Use Proxy off picks the original for the preview; on, with a proxy, picks the proxy.
// No DOM: the real resolver runs on a fake store (row, media.read, media.readProxy). Stubbed, as in tests/t25-svg-sources.test.ts: mg/frames and
// render/decoder-pool (not reached by itemMedia; mocked so no worker module loads) and render/model (isStackedAlpha only).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStore } from '../apps/web/src/store/database';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import { clearSources, itemMedia, readyMedia } from '../apps/web/src/render/sources';

vi.mock('../apps/web/src/mg/frames', () => ({ clearGraphics: vi.fn(), graphicPicture: vi.fn() }));
vi.mock('../apps/web/src/render/decoder-pool', () => ({ decodeFrame: vi.fn(), transientDecodeError: () => false }));
vi.mock('../apps/web/src/render/model', () => ({ isStackedAlpha: () => false }));

const ORIGINAL = new Blob(['original bytes'], { type: 'video/mp4' }), PROXY = new Blob(['proxy bytes'], { type: 'video/mp4' });
const stale = (): Asset => ({ id: 'a1', type: 'video', name: 'clip.mp4', mimeType: 'video/mp4', media: { video: { displayWidth: 320, displayHeight: 180, rotation: 0 } } } as Asset);
const fresh = (): Asset => ({ ...stale(), proxy: { objectKey: 'a1~p', codec: 'avc', container: 'mp4', width: 320, height: 180, sizeBytes: PROXY.size, created_at: '2026-11-19T00:00:00.000Z' } } as Asset);
const item = (useProxy: boolean): RecordData => ({ id: 'vid', type: 'video', details: { name: 'clip', useProxy }, metadata: { assetId: 'a1' } });
/** The store already holds the asset with its proxy. */
const store = () => ({
  row: vi.fn(async (table: string, id: string) => table === 'assets' && id === 'a1' ? fresh() : undefined),
  media: { read: vi.fn(async () => ORIGINAL), readProxy: vi.fn(async () => PROXY) },
}) as unknown as ProjectStore;

afterEach(() => clearSources());

describe('T15 F10: the preview source cache follows Use Proxy, whatever asset row the caller holds', () => {
  it('useProxy true with a stale caller asset (no proxy yet), then useProxy false with the fresh asset: the original is resolved', async () => {
    const s = store();
    await itemMedia(s, item(true), stale());
    const off = await itemMedia(s, item(false), fresh());
    expect(off.kind, 'Use Proxy off resolves the original').toBe('original');
    expect(off.ref.blob, 'the original bytes').toBe(ORIGINAL);
  });

  // Row 3 (delta review 3 finding 1): readyMedia, the synchronous lookup playback uses (render/playback.ts, with the asset row it holds), must
  // return the same source as itemMedia after the row 1 sequence.
  it('after the row 1 sequence, readyMedia for the useProxy false item returns the original', async () => {
    const s = store(), off = item(false);
    await itemMedia(s, item(true), stale());
    await itemMedia(s, off, fresh());
    expect(readyMedia(off, fresh())?.kind, 'readyMedia with Use Proxy off').toBe('original');
  });

  it('guard: useProxy true with the fresh asset resolves the proxy', async () => {
    const on = await itemMedia(store(), item(true), fresh());
    expect(on.kind).toBe('proxy');
    expect(on.ref.blob).toBe(PROXY);
  });
});
