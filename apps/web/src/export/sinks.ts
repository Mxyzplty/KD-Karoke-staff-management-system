// SPDX-License-Identifier: AGPL-3.0-only
// Output sinks in findings §7 order: a file handle (written in 16 MiB chunks) → OPFS `cutframe/exports/export-<ts>.mp4`
// when free space ≥ 2.5 × the estimate (stale export files older than 2 min deleted first) → memory. Stream sinks write
// without fast start, so a long export is never held in memory; the memory sink moves the index to the front.
import { BufferTarget, StreamTarget } from 'mediabunny';
import type { StreamTargetChunk, Target } from 'mediabunny';
import { ExportError } from './errors';

export const CHUNK_BYTES = 16 * 2 ** 20, ROOM_FACTOR = 2.5, STALE_MS = 2 * 60_000;
/** Findings §7: (video bitrate + 192 kb/s) / 8 × duration × 1.1, in bytes. */
export const estimateBytes = (bitrate: number, durationS: number) => (bitrate + 192_000) / 8 * durationS * 1.1;

export type SinkKind = 'handle' | 'opfs' | 'memory';
/** Anything with createWritable (a FileSystemFileHandle from the picker, or a test double). */
export type WritableHandle = { name?: string; createWritable(): Promise<WritableStream<StreamTargetChunk>>; getFile?(): Promise<File> };
export type SinkResult = { kind: SinkKind; blob: Blob; name?: string };
export type Sink = { kind: SinkKind; target: Target; fastStart: false | 'in-memory'; message: string; finish(): Promise<SinkResult>; abort(): Promise<void> };
export type SinkOptions = { handle?: WritableHandle | null; estimate: number; now?: number; storage?: () => Promise<{ quota?: number; usage?: number }> };

async function exportsDir() {
  const root = await navigator.storage.getDirectory(), app = await root.getDirectoryHandle('cutframe', { create: true });
  return app.getDirectoryHandle('exports', { create: true });
}
/** Deletes `export-*.mp4` files in OPFS exports older than 2 min, with the `.crswap` swap file Chromium leaves when a
 *  write fails (it holds the partial data); returns the names it removed (a file still locked by a writer stays). */
export async function cleanStaleExports(now = Date.now()): Promise<string[]> {
  const dir = await exportsDir(), removed: string[] = [];
  for await (const [name, entry] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (entry.kind !== 'file' || !/^export-.*\.mp4(\.crswap)?$/.test(name)) continue;
    const file = await (entry as FileSystemFileHandle).getFile().catch(() => null);
    if (file && now - file.lastModified > STALE_MS && await dir.removeEntry(name).then(() => true, () => false)) removed.push(name);
  }
  return removed;
}
/** A write that fails is STORAGE_QUOTA when the disk is full, WORKSPACE_FILE_MISSING when the file is gone (a NotFoundError),
 *  else OUTPUT_STREAM_FAILED (§12). */
function writeFailure(e: unknown) {
  const name = (e as { name?: string })?.name ?? '', text = (e as { message?: string })?.message ?? String(e);
  return name === 'QuotaExceededError' || /quota/i.test(text) ? new ExportError('STORAGE_QUOTA', `The disk is full: ${text}`)
    : new ExportError(name === 'NotFoundError' ? 'WORKSPACE_FILE_MISSING' : 'OUTPUT_STREAM_FAILED', `Writing the export failed (errored writable stream): ${text}`);
}
/** The destination writable behind one that maps its write and close failures to the §12 classes. */
function guarded(inner: WritableStream<StreamTargetChunk>): WritableStream<StreamTargetChunk> {
  const w = inner.getWriter();
  return new WritableStream<StreamTargetChunk>({
    write: async c => { try { await w.write(c); } catch (e) { throw writeFailure(e); } },
    close: async () => { try { await w.close(); } catch (e) { throw writeFailure(e); } },
    abort: async r => { await w.abort(r).catch(() => undefined); },
  });
}
const streamSink = (kind: SinkKind, inner: WritableStream<StreamTargetChunk>, message: string, done: () => Promise<SinkResult>): Sink => {
  const writable = guarded(inner);
  return {
    kind, message, fastStart: false, target: new StreamTarget(writable, { chunked: true, chunkSize: CHUNK_BYTES }),
    finish: done, abort: async () => { await writable.abort().catch(() => undefined); },
  };
};

/** The first sink that can take the export, in §7 order. */
export async function openSink(o: SinkOptions): Promise<Sink> {
  if (o.handle) {
    const handle = o.handle, writable = await handle.createWritable();
    return streamSink('handle', writable, `Writing to ${handle.name ?? 'the chosen file'}.`, async () => ({ kind: 'handle', name: handle.name, blob: handle.getFile ? await handle.getFile() : new Blob([]) }));
  }
  const storage = o.storage ?? (() => navigator.storage?.estimate?.() ?? Promise.resolve({}));
  let free = 0;
  try { const e = await storage(); free = Math.max(0, (e.quota ?? 0) - (e.usage ?? 0)); } catch { free = 0; }
  if (typeof navigator.storage?.getDirectory === 'function' && free >= ROOM_FACTOR * o.estimate) {
    try {
      const now = o.now ?? Date.now(); await cleanStaleExports(now);
      const dir = await exportsDir(), name = `export-${now}.mp4`, fh = await dir.getFileHandle(name, { create: true });
      const writable = await fh.createWritable() as unknown as WritableStream<StreamTargetChunk>;
      return streamSink('opfs', writable, `Writing to browser storage (${name}).`, async () => ({ kind: 'opfs', name, blob: await fh.getFile() }));
    } catch { /* OPFS refused: memory below */ }
  }
  const target = new BufferTarget();
  return {
    kind: 'memory', target, fastStart: 'in-memory',
    message: free < ROOM_FACTOR * o.estimate ? `Browser storage has ${Math.floor(free / 2 ** 20)} MiB free, under 2.5 × the ${Math.ceil(o.estimate / 2 ** 20)} MiB estimate: building the file in memory.` : 'Building the file in memory.',
    finish: async () => ({ kind: 'memory', blob: new Blob([target.buffer ?? new ArrayBuffer(0)], { type: 'video/mp4' }) }), abort: async () => undefined,
  };
}
