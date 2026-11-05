// SPDX-License-Identifier: AGPL-3.0-only
// Time-remap frame cache worker (part 3 §45.5): decodes the item's preview source through T14's decode seam
// (media/decode.ts: WebCodecs first, WASM second, shared tone map) and encodes the frame shown at each requested source
// time as WebP quality 0.9, PNG where the browser cannot encode WebP. Terminating the worker aborts the build.
import { frameToRgba, videoFrames } from '../media/decode';
import type { RawVideoFrame } from '../media/decode';

export type RemapCacheRequest = { blob: Blob; times: number[]; rotation: 0 | 90 | 180 | 270; width: number | null; height: number | null; forceWasm: boolean };
export type RemapCacheMessage = { kind: 'frame'; index: number; blob: Blob } | { kind: 'done' } | { kind: 'error'; message: string };
const post = (m: RemapCacheMessage) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (event: MessageEvent<RemapCacheRequest>) => {
  const { blob, times, rotation, width, height, forceWasm } = event.data;
  let last: { frame: RawVideoFrame; blob: Blob } | undefined;
  const encode = async (frame: RawVideoFrame) => {
    if (last?.frame === frame) return last.blob;
    const rgba = frameToRgba(frame, rotation), scratch = new OffscreenCanvas(rgba.width, rgba.height);
    scratch.getContext('2d')!.putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height), 0, 0);
    const out = new OffscreenCanvas(width ?? rgba.width, height ?? rgba.height);
    out.getContext('2d')!.drawImage(scratch, 0, 0, out.width, out.height);
    const webp = await out.convertToBlob({ type: 'image/webp', quality: 0.9 });
    last = { frame, blob: webp.type === 'image/webp' ? webp : await out.convertToBlob({ type: 'image/png' }) };
    return last.blob;
  };
  try {
    // Each time takes the frame on screen then: the last frame at or before it (the first frame for times before it).
    let i = 0, prev: RawVideoFrame | undefined;
    for await (const frame of videoFrames(blob, { forceWasm, startS: Math.max(0, (times[0] ?? 0) - 1) })) {
      while (i < times.length && frame.timestamp > times[i] + 1e-6) post({ kind: 'frame', index: i++, blob: await encode(prev ?? frame) });
      if (i >= times.length) break;
      prev = frame;
    }
    if (i < times.length && !prev) throw new Error('The source has no video frames.');
    while (i < times.length) post({ kind: 'frame', index: i++, blob: await encode(prev!) });
    post({ kind: 'done' });
  } catch (e) { post({ kind: 'error', message: (e as Error).message }); }
};
