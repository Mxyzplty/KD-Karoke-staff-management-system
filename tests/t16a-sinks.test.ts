// SPDX-License-Identifier: AGPL-3.0-only
// T16a output sinks (apps/web/src/export/sinks.ts), the parts that need no browser: the file-handle sink writes in chunks of
// at most 16 MiB through a fake WritableHandle, the memory sink, the size estimate, the write-failure classes. OPFS, the room
// rule against a real OPFS and the stale-file clean-up are in tests/ui/t16a-budgets.spec.ts. Oracles:
//   "written-spec oracle" = findings §7 (handle written in 16 MiB chunks, estimate = (video bitrate + 192 kb/s) / 8 × duration × 1.1,
//                           room = 2.5 × the estimate, stale = older than 2 min) and error codes §12 (STORAGE_QUOTA / OUTPUT_STREAM_FAILED)
import { describe, expect, it } from 'vitest';
import { EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny';
import { CHUNK_BYTES, ROOM_FACTOR, STALE_MS, estimateBytes, openSink } from '../apps/web/src/export/sinks';
import type { WritableHandle } from '../apps/web/src/export/sinks';

const MiB = 2 ** 20;
// A minimal avcC (profile 4d, level 1f, one SPS and one PPS); the packets below are opaque bytes in avc (length-prefixed) form.
const AVCC = new Uint8Array([1, 0x4d, 0x40, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x4d, 0x40, 0x1f, 1, 0, 2, 0x68, 0xee]);
const decoderConfig = { codec: 'avc1.4d401f', codedWidth: 64, codedHeight: 36, description: AVCC } as VideoDecoderConfig;
const packet = (bytes: number, t: number, type: 'key' | 'delta') => {
  const data = new Uint8Array(bytes); new DataView(data.buffer).setUint32(0, bytes - 4);
  return new EncodedPacket(data, type, t, 1 / 30);
};
/** A fake file handle that records every chunk it is given (position, size) and keeps the bytes. */
function fakeHandle(o: { failWith?: Error } = {}) {
  const chunks: { position: number; size: number }[] = [], parts = new Map<number, Uint8Array>();
  const handle: WritableHandle = {
    name: 'fake-export.mp4',
    createWritable: async () => new WritableStream({
      write(c: { type: string; data: Uint8Array; position: number }) {
        if (o.failWith) throw o.failWith;
        chunks.push({ position: c.position, size: c.data.byteLength }); parts.set(c.position, c.data.slice());
      },
    }),
    getFile: async () => {
      const end = Math.max(0, ...chunks.map(c => c.position + c.size)), all = new Uint8Array(end);
      for (const [p, d] of parts) all.set(d, p);
      return new File([all], 'fake-export.mp4');
    },
  };
  return { handle, chunks };
}
async function writeMp4(sink: Awaited<ReturnType<typeof openSink>>, packets: EncodedPacket[]) {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target }), video = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(video, { frameRate: 30 });
  await output.start();
  for (let i = 0; i < packets.length; i++) await video.add(packets[i], i === 0 ? { decoderConfig } : undefined);
  video.close();
  await output.finalize();
}

describe('T16a file-handle sink (written-spec oracle: findings §7, a file handle is written in 16 MiB chunks)', () => {
  it('writes a 40 MiB export in several chunks, none larger than 16 MiB, and the file ends up complete', async () => {
    const { handle, chunks } = fakeHandle(), sink = await openSink({ handle, estimate: 40 * MiB });
    expect(sink.kind).toBe('handle');
    expect(sink.message).toContain('fake-export.mp4');
    await writeMp4(sink, [packet(20 * MiB, 0, 'key'), packet(20 * MiB, 1 / 30, 'delta')]);
    const result = await sink.finish();
    expect(result.kind).toBe('handle');
    expect(result.name).toBe('fake-export.mp4');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...chunks.map(c => c.size))).toBeLessThanOrEqual(CHUNK_BYTES);
    const written = chunks.reduce((n, c) => n + c.size, 0);
    expect(written).toBeGreaterThanOrEqual(40 * MiB);
    expect(result.blob.size).toBeGreaterThanOrEqual(40 * MiB);
    expect(result.blob.size).toBeLessThanOrEqual(written);
    // The finished file is an MP4: ftyp at the start, moov at the end (no fast start for stream sinks).
    const head = new Uint8Array(await result.blob.slice(0, 12).arrayBuffer());
    expect(String.fromCharCode(...head.subarray(4, 8))).toBe('ftyp');
    expect(sink.fastStart).toBe(false);
  }, 60_000);
  it('a small export is still one valid stream of chunks at or under the limit', async () => {
    const { handle, chunks } = fakeHandle(), sink = await openSink({ handle, estimate: 1 });
    await writeMp4(sink, [packet(1000, 0, 'key'), packet(500, 1 / 30, 'delta')]);
    await sink.finish();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...chunks.map(c => c.size))).toBeLessThanOrEqual(CHUNK_BYTES);
  });
  it('a write that fails with a quota error is STORAGE_QUOTA (written-spec oracle: §12)', async () => {
    const { handle } = fakeHandle({ failWith: Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }) }), sink = await openSink({ handle, estimate: 1 });
    await expect(writeMp4(sink, [packet(1000, 0, 'key')])).rejects.toMatchObject({ code: 'STORAGE_QUOTA' });
  });
  // Freeze 7 round 2: the working file was removed under the export (a NotFoundError from the writable) is WORKSPACE_FILE_MISSING; the name decides.
  it('a write that fails with a NotFoundError is WORKSPACE_FILE_MISSING (written-spec oracle: §12)', async () => {
    const { handle } = fakeHandle({ failWith: Object.assign(new Error('A requested file or directory could not be found at the time an operation was processed.'), { name: 'NotFoundError' }) }), sink = await openSink({ handle, estimate: 1 });
    await expect(writeMp4(sink, [packet(1000, 0, 'key')])).rejects.toMatchObject({ code: 'WORKSPACE_FILE_MISSING' });
  });
  it('a NotFoundError is WORKSPACE_FILE_MISSING whatever its text (the name decides, not the text)', async () => {
    const { handle } = fakeHandle({ failWith: Object.assign(new Error('gone'), { name: 'NotFoundError' }) }), sink = await openSink({ handle, estimate: 1 });
    await expect(writeMp4(sink, [packet(1000, 0, 'key')])).rejects.toMatchObject({ code: 'WORKSPACE_FILE_MISSING' });
  });
  it('a write that fails with anything else is OUTPUT_STREAM_FAILED (written-spec oracle: §12)', async () => {
    const { handle } = fakeHandle({ failWith: new Error('disk exploded') }), sink = await openSink({ handle, estimate: 1 });
    await expect(writeMp4(sink, [packet(1000, 0, 'key')])).rejects.toMatchObject({ code: 'OUTPUT_STREAM_FAILED' });
  });
});

describe('T16a memory sink (written-spec oracle: findings §7, last in the order handle → OPFS → memory)', () => {
  it('without a handle and without OPFS (Node) the export is built in memory, index in front, and finish returns an MP4 blob', async () => {
    const sink = await openSink({ estimate: 1000, storage: async () => ({ quota: 10 ** 12, usage: 0 }) });
    expect(sink.kind).toBe('memory');
    expect(sink.fastStart).toBe('in-memory');
    await writeMp4(sink, [packet(2000, 0, 'key'), packet(800, 1 / 30, 'delta')]);
    const r = await sink.finish();
    expect(r.kind).toBe('memory');
    expect(r.blob.type).toBe('video/mp4');
    expect(r.blob.size).toBeGreaterThan(2800);
    const bytes = new Uint8Array(await r.blob.arrayBuffer()), box = (at: number) => String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const ftypSize = new DataView(bytes.buffer).getUint32(0);
    expect(box(0)).toBe('ftyp');
    expect(box(ftypSize)).toBe('moov'); // fast start: moov right after ftyp, before mdat
  });
  it('with no room (free space under 2.5 × the estimate) the message says so with the numbers', async () => {
    const sink = await openSink({ estimate: 100 * MiB, storage: async () => ({ quota: 200 * MiB, usage: 0 }) });
    expect(sink.kind).toBe('memory');
    expect(sink.message).toContain('200 MiB');
    expect(sink.message).toContain('100 MiB');
    expect(sink.message).toMatch(/2\.5/);
  });
  it('a storage estimate that throws counts as no free space', async () => {
    const sink = await openSink({ estimate: 10 * MiB, storage: async () => { throw new Error('no'); } });
    expect(sink.kind).toBe('memory');
    expect(sink.message).toContain('0 MiB');
  });
});

describe('T16a size estimate and sink constants (written-spec oracle: findings §7)', () => {
  it('estimate = (video bitrate + 192 kb/s) / 8 × duration × 1.1 bytes', () => {
    expect(estimateBytes(20_000_000, 10)).toBeCloseTo((20_000_000 + 192_000) / 8 * 10 * 1.1, 3);
    expect(estimateBytes(20_000_000, 10)).toBeCloseTo(27_764_000, 0);
    expect(estimateBytes(0, 0)).toBe(0);
  });
  it('chunk 16 MiB, room 2.5 ×, stale after 2 min', () => {
    expect([CHUNK_BYTES, ROOM_FACTOR, STALE_MS]).toEqual([16 * MiB, 2.5, 120_000]);
  });
});
