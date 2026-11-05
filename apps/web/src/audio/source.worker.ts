// SPDX-License-Identifier: AGPL-3.0-only
// The audio source worker (source.ts is its client): decodes BLOCK_S blocks of a clip's original, each PADDING_S either
// side (reader.ts), and converts them to 48 kHz on the absolute source grid, off the main thread (a 44.1 kHz block's sinc
// conversion is tens of ms of CPU).
import { decodeAudio, ensureAc3 } from '../media/decode';
import { BLOCK_S, MIX_RATE } from './mix';
import { cachedReader, openReader } from './reader';
import type { Reader } from './reader';
import { resamplePlanar } from './resample';

export type SourceRequest = { op: 'block'; id: number; key: string; blob: Blob; k: number; forceWasm: boolean } | { op: 'clear' } | { op: 'release'; keep: string[] };
export type SourceReply = { id: number; ok: true; data: Float32Array[] | null } | { id: number; ok: false; message: string };
const readers = new Map<string, Promise<Reader | null>>();

/** 48 kHz frames [k·B, (k+1)·B) of the source: output frame j at native position (k·B + j / 48 000) × rate − first. */
async function block(key: string, blob: Blob, k: number, forceWasm: boolean): Promise<Float32Array[] | null> {
  ensureAc3();
  const reader = await cachedReader(readers, key, () => openReader(blob, forceWasm, b => decodeAudio(b, { forceWasm: true })));
  const native = await reader?.block(k);
  return native ? resamplePlanar(native.data, native.rate, MIX_RATE, k * BLOCK_S * native.rate - native.first, BLOCK_S * MIX_RATE) : null;
}
self.onmessage = async (event: MessageEvent<SourceRequest>) => {
  const req = event.data;
  if (req.op === 'clear' || req.op === 'release') {
    for (const [key, r] of [...readers]) if (req.op === 'clear' || !req.keep.includes(key)) { void r.then(x => x?.dispose(), () => {}); readers.delete(key); }
    return;
  }
  try {
    const data = await block(req.key, req.blob, req.k, req.forceWasm);
    (self as unknown as Worker).postMessage({ id: req.id, ok: true, data } satisfies SourceReply, data ? data.map(x => x.buffer) : []);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, message: (e as Error)?.message ?? String(e) } satisfies SourceReply);
  }
};
