// SPDX-License-Identifier: AGPL-3.0-only
// Preview decoder worker (findings §5 "decoder-prewarm"): frames through T14's decode seam (media/decode.ts: WebCodecs
// first, WASM second, the shared tone map in frameToRgba). One open stream per source, so forward requests continue
// decoding instead of seeking again. The frame for a request is the export pick (§53.3.1): the last frame whose timestamp
// ≤ request + 0.1 ms, the first frame before it. The reply carries the next frame's timestamp, which bounds the interval
// the frame stays valid for (the pool caches by interval).
import { frameToRgba, videoFrames } from '../media/decode';
import type { RawVideoFrame } from '../media/decode';
import type { MediaCode } from '../media/codes';
import { applyExportInputTransfer } from '../export/colour';

export type DecodeRequest = { id: number; key: string; blob: Blob; timeS: number; rotation: 0 | 90 | 180 | 270; forceWasm: boolean; raw: boolean; exportColour?: boolean };
export type DecodeReply =
  | { id: number; ok: true; ts: number; nextTs: number | null; first: boolean; width: number; height: number; bitmap?: ImageBitmap; data?: ArrayBuffer }
  | { id: number; ok: false; message: string; code?: MediaCode };
/** cur = the frame last shown, ahead = the next frame already pulled, first = cur is the source's first frame. */
type Stream = { iter: AsyncGenerator<RawVideoFrame>; startS: number; pulled: number; cur?: RawVideoFrame; ahead?: RawVideoFrame; first: boolean; done: boolean };
const EPS = 0.0001, streams = new Map<string, Stream>();
const post = (m: DecodeReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function open(key: string, blob: Blob, forceWasm: boolean, startS: number): Stream {
  void streams.get(key)?.iter.return(undefined);
  const s: Stream = { iter: videoFrames(blob, { forceWasm, startS }), startS, pulled: 0, first: false, done: false };
  streams.set(key, s);
  return s;
}
async function frameAt(key: string, blob: Blob, t: number, forceWasm: boolean): Promise<Stream & { cur: RawVideoFrame }> {
  let s = streams.get(key);
  const pos = s?.cur?.timestamp;
  // Seek again when the request is behind the shown frame (unless that is the source's first frame) or over 2 s ahead.
  if (!s || pos !== undefined && (t + EPS < pos && !s.first || t - pos > 2)) s = open(key, blob, forceWasm, Math.max(0, t - 1));
  for (;;) {
    if (!s.ahead) {
      if (s.done) break;
      const r = await s.iter.next();
      if (r.done) { s.done = true; break; }
      s.ahead = r.value; s.pulled++;
    }
    const firstPull = s.startS === 0 && s.pulled === 1;
    if (s.ahead.timestamp > t + EPS) {
      if (s.cur) break;
      // Nothing at or before t: a start inside a long frame gap seeks from 0; from 0, the first frame is shown.
      if (s.startS > 0) { s = open(key, blob, forceWasm, 0); continue; }
    }
    s.cur = s.ahead; s.ahead = undefined; s.first = firstPull;
  }
  if (!s.cur) throw new Error('The source has no video frames.');
  return s as Stream & { cur: RawVideoFrame };
}

// One source's requests run in arrival order: they share its stream, and an interleaved request would move it mid-answer.
const queues = new Map<string, Promise<void>>();
self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const key = event.data.key, run = (queues.get(key) ?? Promise.resolve()).then(() => answer(event.data));
  queues.set(key, run);
  void run.then(() => { if (queues.get(key) === run) queues.delete(key); });
};
async function answer({ id, key, blob, timeS, rotation, forceWasm, raw, exportColour }: DecodeRequest) {
  try {
    const s = await frameAt(key, blob, timeS, forceWasm), rgba = frameToRgba(s.cur, rotation);
    if (exportColour) applyExportInputTransfer(rgba.data, rgba.width, rgba.height, s.cur.colour.transfer, raw);
    const meta = { id, ok: true as const, ts: s.cur.timestamp, nextTs: s.ahead?.timestamp ?? null, first: s.first, width: rgba.width, height: rgba.height };
    if (raw) { const data = rgba.data.slice().buffer; return post({ ...meta, data }, [data]); }
    const bitmap = await createImageBitmap(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height));
    post({ ...meta, bitmap }, [bitmap]);
  } catch (e) {
    void streams.get(key)?.iter.return(undefined); streams.delete(key);
    post({ id, ok: false, message: (e as Error).message, code: (e as { code?: MediaCode }).code });
  }
}
