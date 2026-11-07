// SPDX-License-Identifier: AGPL-3.0-only
// T12 raster decode cache (M10, review correction: part 5 §54.6 5.3 l.768): 64 MiB of decoded frames across every open
// raster, at most 2 decodes running at a time, at most 16 pending, and a 2 s back-off after a decode fails. None of
// RASTER_CACHE/rasterCacheStats exist yet (raster.ts today has only the frame-count cache KEEP=96 and no concurrency
// gate at all), so most of this fails on the missing export itself; that is the expected shape of this regression.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RasterWriter, useRasterStore } from '../apps/web/src/masks/raster';
import * as raster from '../apps/web/src/masks/raster';
import { readyMasks } from '../apps/web/src/masks/render';
import type { RasterRef } from '../apps/web/src/masks/model';

const { rasterPlane, readyRaster } = raster as typeof raster & { RASTER_CACHE?: { bytes: number; decodes: number; pending: number; backoffMs: number }; rasterCacheStats?(): { bytes: number; running: number; pending: number } };

async function makeFile(width: number, height: number, frames: number, fill = 255): Promise<{ blob: Blob; ref: RasterRef }> {
  const w = new RasterWriter(width, height);
  for (let i = 0; i < frames; i++) await w.add(i * 1_000_000, new Uint8Array(width * height).fill(fill));
  return { blob: w.blob(), ref: { file: '', sourceStartUs: 0, sourceEndUs: frames * 1_000_000, frameCount: frames, width, height, space: { kind: 'source', width, height }, version: 1 } };
}

let files: Map<string, Blob>;
let fail: Set<string>;
beforeEach(() => {
  files = new Map(); fail = new Set();
  useRasterStore({ writeMask: async (file, data) => { files.set(file, data); }, readMask: async (file) => { if (fail.has(file)) throw new Error('decode failed'); return files.get(file)!; } });
});
afterEach(() => { useRasterStore(null); });

describe('M10: RASTER_CACHE holds the review\'s own numbers', () => {
  it('bytes/decodes/pending/backoffMs match 64 MiB, 2, 16, 2000ms exactly', () => {
    expect(raster.RASTER_CACHE).toEqual({ bytes: 64 * 2 ** 20, decodes: 2, pending: 16, backoffMs: 2000 });
  });
});

describe('M10: the decode cache stays inside its byte budget across every open raster, not just a frame count', () => {
  it('three 1024x1024 files (1 MiB/frame) decoded past 64 of them together stay at or under 64 MiB total', async () => {
    const a = await makeFile(1024, 1024, 40), b = await makeFile(1024, 1024, 40), c = await makeFile(1024, 1024, 40);
    files.set('a.dmk', a.blob); files.set('b.dmk', b.blob); files.set('c.dmk', c.blob);
    const refs = [{ ...a.ref, file: 'a.dmk' }, { ...b.ref, file: 'b.dmk' }, { ...c.ref, file: 'c.dmk' }];
    for (const ref of refs) for (let t = 0; t < 40; t++) { await readyRaster(ref, t * 1_000_000); }
    const stats = raster.rasterCacheStats!();
    expect(stats.bytes).toBeLessThanOrEqual(raster.RASTER_CACHE!.bytes); // fixed: a global byte budget evicts across files, not per-file frame counts
  });
});

describe('M10: at most 2 decodes run at once and at most 16 wait, across every open raster', () => {
  it('seeking many frames across two files at once never exceeds the running/pending caps, even right after triggering them', async () => {
    const a = await makeFile(64, 64, 30), b = await makeFile(64, 64, 30);
    files.set('a.dmk', a.blob); files.set('b.dmk', b.blob);
    const refA = { ...a.ref, file: 'a.dmk' }, refB = { ...b.ref, file: 'b.dmk' };
    await readyRaster(refA, 0); await readyRaster(refB, 0); // index both files first
    for (let t = 5; t < 25; t++) { rasterPlane(refA, t * 1_000_000); rasterPlane(refB, t * 1_000_000); }
    const stats = raster.rasterCacheStats!();
    expect(stats.running).toBeLessThanOrEqual(raster.RASTER_CACHE!.decodes);
    expect(stats.pending).toBeLessThanOrEqual(raster.RASTER_CACHE!.pending);
  });
});

describe('M10: a failed decode backs off for 2 s before the same frame is tried again', () => {
  /** Three 64 × 64 frames with the last one's compressed bytes spoiled: no read-ahead, so `running` counts that frame alone. */
  async function spoilt() {
    const w = new RasterWriter(64, 64);
    for (let i = 0; i < 3; i++) await w.add(i * 1_000_000, new Uint8Array(64 * 64).fill(255));
    const buf = new Uint8Array(await w.blob().arrayBuffer()), n = new DataView(buf.buffer, 0, 8).getUint32(4, true);
    const table = new Float64Array(buf.buffer.slice(8, 8 + (2 * n + 1) * 8)), body = 8 + (2 * n + 1) * 8;
    buf.fill(0xff, body + table[n + 2], body + table[n + 3]);
    files.set('spoilt.dmk', new Blob([buf]));
    const ref: RasterRef = { file: 'spoilt.dmk', sourceStartUs: 0, sourceEndUs: 3_000_000, frameCount: 3, width: 64, height: 64, space: { kind: 'source', width: 64, height: 64 }, version: 1 };
    return ref;
  }
  const LAST = 2_000_000;
  it('inside the back-off nothing is decoded and readyRaster fails at once; after it the frame is tried again', async () => {
    const ref = await spoilt();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(readyRaster(ref, LAST)).rejects.toThrow();
    now += raster.RASTER_CACHE!.backoffMs - 1;
    rasterPlane(ref, LAST);
    expect(raster.rasterCacheStats!().running).toBe(0);
    await expect(readyRaster(ref, LAST)).rejects.toThrow();
    now += 1;
    rasterPlane(ref, LAST);
    expect(raster.rasterCacheStats!().running).toBe(1);
    await expect(readyRaster(ref, LAST)).rejects.toThrow();
    clock.mockRestore();
  });
});

describe('M10: export and capture do not depend on what the queue does', () => {
  it('readyRaster gets the exact frame with the queue full of read-ahead, and answers from the plane it decoded', async () => {
    const w = new RasterWriter(64, 64);
    for (let i = 0; i < 40; i++) await w.add(i * 1_000_000, new Uint8Array(64 * 64).fill(i));
    files.set('long.dmk', w.blob());
    const ref: RasterRef = { file: 'long.dmk', sourceStartUs: 0, sourceEndUs: 40_000_000, frameCount: 40, width: 64, height: 64, space: { kind: 'source', width: 64, height: 64 }, version: 1 };
    await readyRaster(ref, 0);
    for (let t = 1; t < 30; t += 3) rasterPlane(ref, t * 1_000_000);
    expect(raster.rasterCacheStats!().running + raster.rasterCacheStats!().pending).toBe(raster.RASTER_CACHE!.pending);
    const plane = await readyRaster(ref, 39_000_000);
    expect(plane[0]).toBe(39);
  });
  it('a new project starts with an empty cache', async () => {
    const a = await makeFile(64, 64, 2); files.set('a.dmk', a.blob);
    const ref = { ...a.ref, file: 'a.dmk' };
    await readyRaster(ref, 0);
    expect(raster.rasterCacheStats!().bytes).toBeGreaterThan(0);
    useRasterStore({ writeMask: async (file, data) => { files.set(file, data); }, readMask: async file => files.get(file)! });
    expect(raster.rasterCacheStats!()).toEqual({ bytes: 0, running: 0, pending: 0 });
  });
});

describe('M10: a frame readyRaster just returned stays cached for rasterPlane right after, even with the queue full', () => {
  it('a small raster\'s frame, and a 4096x4096 (16 MiB) frame in a second file, both answer from rasterPlane afterwards, with the budget still respected', async () => {
    const a = await makeFile(64, 64, 4), big = await makeFile(4096, 4096, 2);
    files.set('a.dmk', a.blob); files.set('big.dmk', big.blob);
    const refA = { ...a.ref, file: 'a.dmk' }, refBig = { ...big.ref, file: 'big.dmk' };
    await readyRaster(refA, 0);
    await readyRaster(refBig, 0);
    // Flood the queue past its pending cap with other, unrelated requests before reading back.
    const flood = await makeFile(64, 64, 20); files.set('flood.dmk', flood.blob);
    const refFlood = { ...flood.ref, file: 'flood.dmk' };
    await readyRaster(refFlood, 0);
    for (let t = 1; t < 20; t++) rasterPlane(refFlood, t * 1_000_000);
    expect(rasterPlane(refA, 0)).not.toBeNull();
    expect(rasterPlane(refBig, 0)).not.toBeNull();
    expect(raster.rasterCacheStats!().bytes).toBeLessThanOrEqual(raster.RASTER_CACHE!.bytes);
  });
});

describe('M10, review round 2: a required read waits for a place in the queue, and the limits hold', () => {
  const COUNT = 40, tick = () => new Promise(r => setTimeout(r, 0));
  const REF: RasterRef = { file: 'q.dmk', sourceStartUs: 0, sourceEndUs: COUNT * 1_000_000, frameCount: COUNT, width: 64, height: 64, space: { kind: 'item', width: 64, height: 64 }, version: 1 };
  /** Frame k is filled with k. `decoded` lists the frames in the order their decodes began; `spoil` frames do not decode. */
  async function queueFile(spoil: number[] = []) {
    const w = new RasterWriter(64, 64);
    for (let k = 0; k < COUNT; k++) await w.add(k * 1_000_000, new Uint8Array(64 * 64).fill(k));
    const buf = new Uint8Array(await w.blob().arrayBuffer()), table = new Float64Array(buf.buffer.slice(8, 8 + (2 * COUNT + 1) * 8)), body = 8 + (2 * COUNT + 1) * 8, decoded: number[] = [];
    for (const k of spoil) buf.fill(0xff, body + table[COUNT + k], body + table[COUNT + k + 1]);
    class Spy extends Blob {
      slice(start?: number, end?: number, type?: string) { if (start! >= body) decoded.push(table.subarray(COUNT).indexOf(start! - body)); return super.slice(start, end, type); }
    }
    files.set(REF.file, new Spy([buf]));
    await readyRaster(REF, 0);
    decoded.length = 0;
    return decoded;
  }
  /** The queue's highest values at every macrotask until the work ends. */
  async function peak(work: Promise<unknown>) {
    let running = 0, pending = 0, total = 0, done = false;
    void work.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      const s = raster.rasterCacheStats!();
      running = Math.max(running, s.running); pending = Math.max(pending, s.pending); total = Math.max(total, s.running + s.pending);
      await tick();
    }
    return { running, pending, total };
  }
  const LIMITS = { running: 2, pending: 14, total: 16 };
  const required = () => Array.from({ length: COUNT - 1 }, (_, k) => readyRaster(REF, (k + 1) * 1_000_000));

  it('39 required frames at once: never more than 2 running and 16 queued, none fails, each gets its own plane', async () => {
    await queueFile();
    const all = required(), seen = await peak(Promise.all(all));
    expect(seen).toEqual(LIMITS);
    expect((await Promise.all(all)).map(p => p[0])).toEqual(Array.from({ length: COUNT - 1 }, (_, k) => k + 1));
    expect(raster.rasterCacheStats!()).toMatchObject({ running: 0, pending: 0 });
  });
  it('readyMasks with 39 raster masks stays inside the same limits and holds each draw\'s exact plane', async () => {
    await queueFile();
    const draws = Array.from({ length: COUNT - 1 }, (_, k) => ({ masks: [{ raster: { ref: REF, timeUs: (k + 1) * 1_000_000 } }] })) as unknown as Parameters<typeof readyMasks>[0];
    const seen = await peak(readyMasks(draws));
    expect(seen).toEqual(LIMITS);
    expect(draws.map(d => d.masks![0].raster!.plane![0])).toEqual(Array.from({ length: COUNT - 1 }, (_, k) => k + 1));
  });
  it('required reads keep their priority over read-ahead: they push it out when they arrive, and what the player asks for while they wait never overtakes them', async () => {
    const decoded = await queueFile();
    expect(rasterPlane(REF, 1_000_000)).toEqual(new Uint8Array(64 * 64).fill(0)); // frame 1 and 12 ahead: 13 requests, 2 of them already decoding
    const started = [...decoded], shown = new Set(Array.from({ length: 13 }, (_, k) => k + 1)), all = Array.from({ length: 20 }, (_, k) => readyRaster(REF, (k + 20) * 1_000_000));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    rasterPlane(REF, 15_000_000); // the queue is full of required reads, so this one is refused
    const seen = await peak(Promise.all(all));
    expect(seen.total).toBeLessThanOrEqual(16);
    expect((await Promise.all(all)).map(p => p[0])).toEqual(Array.from({ length: 20 }, (_, k) => k + 20));
    expect(decoded.slice(0, started.length)).toEqual(started);
    expect(decoded.slice(started.length).filter(k => k < 20)).toEqual([]); // no read-ahead and no shown frame ran after the required reads arrived
    expect(started.every(k => shown.has(k))).toBe(true);
  });
  it('the same frame asked twice while it waits decodes once and answers both', async () => {
    const decoded = await queueFile(), all = required(), again = readyRaster(REF, 39_000_000);
    expect((await again)[0]).toBe(39);
    await Promise.all(all);
    expect(decoded.filter(k => k === 39)).toHaveLength(1);
  });
  it('a frame that does not decode fails its own read: the others land and nothing stays waiting', async () => {
    await queueFile([30]);
    const all = required(), out = await Promise.allSettled(all);
    expect(out.map(r => r.status === 'rejected')).toEqual(Array.from({ length: COUNT - 1 }, (_, k) => k + 1 === 30));
    expect(raster.rasterCacheStats!()).toMatchObject({ running: 0, pending: 0 });
  });
  it('a new project ends the wait: no required read hangs on the old store, and the new one starts empty', async () => {
    await queueFile();
    const all = required();
    await tick();
    useRasterStore({ writeMask: async () => undefined, readMask: async file => files.get(file)! });
    const out = await Promise.allSettled(all);
    expect(out.filter(r => r.status === 'rejected').length).toBeGreaterThan(20);
    expect(raster.rasterCacheStats!()).toEqual({ bytes: 0, running: 0, pending: 0 });
  });
});
