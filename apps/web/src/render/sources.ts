// SPDX-License-Identifier: AGPL-3.0-only
// Item pictures for the preview canvas and frame capture (§53.3). T14's resolver picks the source (Use Proxy for preview);
// the fit size is always the original's display size, so a proxy and its original give the same geometry. Paused, seek and
// capture frames come from the decoder pool (frame-exact, T14's decode and tone map); images are decoded once per asset.
import type { ProjectStore } from '../store/database';
import type { Asset, RecordData } from '../store/model';
import { resolveSource, usesProxy } from '../media/resolver';
import { clearGraphics, graphicPicture } from '../mg/frames';
import { decodeFrame, transientDecodeError } from './decoder-pool';
import type { SourceRef } from './decoder-pool';
import type { Source } from './compositor';
import { isStackedAlpha } from './model';
import type { Draw, Size } from './model';

/** One video item's source. fit: the size cover fits (null: unknown, the decoded frame's size is used). hdr: an HDR
 *  original, which only the decoder pool's tone map shows correctly. type: the MIME type a media element would play. */
export type ItemMedia = { ref: SourceRef; kind: 'proxy' | 'original'; fit: Size | null; hdr: boolean; type: string; url: () => string };
const media = new Map<string, Promise<ItemMedia>>(), images = new Map<string, Promise<ImageBitmap | 'failed'>>(), urls = new Map<string, string>();
/** Settled media and images, for the synchronous draw while playing. */
const ready = new Map<string, ItemMedia>(), readyImages = new Map<string, ImageBitmap | 'failed'>();

/** The identity of the picture source: asset, proxy or original, and whether the frames are stacked-alpha merged. */
export const mediaKey = (item: RecordData, asset: Asset | undefined) =>
  `${item.metadata?.assetId}:${usesProxy(item) && asset?.proxy ? 'proxy' : 'original'}${isStackedAlpha(item) ? ':stacked' : ''}`;
export function itemMedia(store: ProjectStore, item: RecordData, asset: Asset | undefined): Promise<ItemMedia> {
  const key = mediaKey(item, asset);
  let m = media.get(key);
  if (!m) {
    m = (async () => {
      const s = await resolveSource(store, item, 'preview'), v = asset?.media?.video, original = s.kind === 'original', stacked = isStackedAlpha(item);
      const w = v?.displayWidth ?? s.width, h = v?.displayHeight ?? s.height;
      const result: ItemMedia = {
        ref: { key, blob: s.blob, rotation: original ? v?.rotation ?? 0 : 0, stackedAlpha: stacked },
        kind: s.kind, fit: w && h ? { width: stacked ? w >> 1 : w, height: h } : null, hdr: original && !!v?.hdr,
        type: original ? asset?.mimeType ?? s.blob.type : asset?.proxy ? `video/${asset.proxy.container}` : s.blob.type,
        url: () => { let u = urls.get(key); if (!u) urls.set(key, u = URL.createObjectURL(s.blob)); return u; },
      };
      ready.set(key, result);
      return result;
    })();
    media.set(key, m);
    m.catch(() => media.delete(key)); // a failure is retried on the next request
  }
  return m;
}
export const readyMedia = (item: RecordData, asset: Asset | undefined) => ready.get(mediaKey(item, asset));

/** An image item's bitmap (fetched and decoded once per asset); 'failed' fills grey. */
export function imageBitmap(store: ProjectStore, item: RecordData): Promise<ImageBitmap | 'failed'> {
  const id = String(item.metadata?.assetId);
  let p = images.get(id);
  if (!p) {
    p = store.media.read(id).then(blob => createImageBitmap(blob)).catch(() => 'failed' as const).then(b => { readyImages.set(id, b); return b; });
    images.set(id, p);
  }
  return p;
}
export const readyImage = (item: RecordData) => readyImages.get(String(item.metadata?.assetId));

/** The exact picture of one draw (paused preview, seek, capture). A decode or fetch error is 'failed' (grey); a timeout or
 *  worker restart is asked once more first (provisional, the coordinator's rule of 1 Nov 2026, not Xapp parity). purpose:
 *  a motion graphic's retry rule (mg/frames.ts graphicPicture). assetOf: a layout's cell assets by stored id (T07). */
export async function picture(store: ProjectStore, d: Draw, asset: Asset | undefined, purpose: 'preview' | 'capture' = 'preview', assetOf?: (id: string) => Asset | undefined): Promise<Source> {
  if (d.kind === 'motionGraphic') return graphicPicture(store, d, purpose);
  if (d.kind === 'shape' || d.kind === 'text') return null; // T06 / T05: drawn by the compositor, no source
  if (d.kind === 'layout') return { cells: await Promise.all((d.layout?.cells ?? []).map(c => c.media ? picture(store, c.media.draw, assetOf?.(String(c.media.draw.item.metadata?.assetId)), purpose) : null)) };
  try {
    if (d.kind === 'image') { const b = await imageBitmap(store, d.item); return b === 'failed' ? b : { image: b, width: b.width, height: b.height }; }
    const m = await itemMedia(store, d.item, asset);
    const f = await decodeFrame(m.ref, d.sourceMs).catch(e => { if (transientDecodeError(e)) return decodeFrame(m.ref, d.sourceMs); throw e; });
    return { image: f.bitmap, width: m.fit?.width ?? f.width, height: m.fit?.height ?? f.height };
  } catch { return 'failed'; }
}
/** Forgets every source (project close). */
export function clearSources() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  for (const b of readyImages.values()) if (b !== 'failed') b.close();
  media.clear(); images.clear(); urls.clear(); ready.clear(); readyImages.clear();
  clearGraphics();
}
