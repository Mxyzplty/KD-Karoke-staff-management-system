// SPDX-License-Identifier: AGPL-3.0-only
// D34: independent transfer-function and worker-boundary regression tests.
import { afterEach, describe, expect, it } from 'vitest';
import { BT709_TO_SRGB, SRGB_TO_BT709, applyExportInputTransfer } from '../apps/web/src/export/colour';
import { rgbaToI420 } from '../apps/web/src/export/i420';
import { ExportDecoders } from '../apps/web/src/export/decoders';
import { closeDecoderPool, decodeFrame } from '../apps/web/src/render/decoder-pool';

const byte = (v: number) => Math.round(255 * v);
const btDecode = (v: number) => v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45);
const btEncode = (v: number) => v < 0.018 ? 4.5 * v : 1.099 * v ** 0.45 - 0.099;
const srgbDecode = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgbEncode = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
const input = (v: number) => byte(srgbEncode(btDecode(v / 255)));
const output = (v: number) => byte(btEncode(srgbDecode(v / 255)));

describe('D34 export transfer tables', () => {
  it('both tables match independently calculated values for every byte and are monotonic', () => {
    expect(BT709_TO_SRGB).toBeInstanceOf(Uint8Array);
    expect(SRGB_TO_BT709).toBeInstanceOf(Uint8Array);
    expect(BT709_TO_SRGB).toHaveLength(256);
    expect(SRGB_TO_BT709).toHaveLength(256);
    for (let i = 0; i < 256; i++) {
      expect(BT709_TO_SRGB[i], `input ${i}`).toBe(input(i));
      expect(SRGB_TO_BT709[i], `output ${i}`).toBe(output(i));
      if (i) {
        expect(BT709_TO_SRGB[i]).toBeGreaterThanOrEqual(BT709_TO_SRGB[i - 1]);
        expect(SRGB_TO_BT709[i]).toBeGreaterThanOrEqual(SRGB_TO_BT709[i - 1]);
      }
    }
    expect([BT709_TO_SRGB[0], BT709_TO_SRGB[255], SRGB_TO_BT709[0], SRGB_TO_BT709[255]]).toEqual([0, 255, 0, 255]);
    expect([BT709_TO_SRGB[64], BT709_TO_SRGB[128], SRGB_TO_BT709[64], SRGB_TO_BT709[128]]).toEqual([79, 140, 48, 115]);
  });

  it('measures the exact worst byte roundtrip across all 256 inputs', () => {
    const errors = Array.from({ length: 256 }, (_, i) => Math.abs(output(input(i)) - i));
    expect(Math.max(...errors)).toBe(1);
    for (let i = 0; i < 256; i++) expect(Math.abs(SRGB_TO_BT709[BT709_TO_SRGB[i]] - i)).toBe(errors[i]);
  });

  it('tables RGB in the colour half only; preserves both halves’ alpha bytes and every alpha-half byte', () => {
    const rgba = new Uint8Array([64, 128, 200, 7, 20, 40, 60, 8, 17, 39, 99, 101, 255, 0, 100, 55,
      90, 110, 130, 9, 150, 170, 190, 10, 21, 22, 23, 24, 201, 202, 203, 204]);
    const before = rgba.slice();
    applyExportInputTransfer(rgba, 4, 2, 'bt709', true);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 4; c++) {
      const i = (y * 4 + x) * 4 + c;
      expect(rgba[i], `pixel ${x},${y} channel ${c}`).toBe(x < 2 && c < 3 ? input(before[i]) : before[i]);
    }
  });

  it.each(['', 'bt709', 'smpte170m', 'smpte240m', 'bt2020-10', 'bt2020-12', 'pq', 'hlg'])('%s decoded video uses the input table', transfer => {
    const pixels = new Uint8Array([64, 128, 200, 19]);
    applyExportInputTransfer(pixels, 1, 1, transfer);
    expect([...pixels]).toEqual([input(64), input(128), input(200), 19]);
  });

  it.each(['iec61966-2-1', 'linear'])('%s decoded video bypasses the input table', transfer => {
    const pixels = new Uint8Array([64, 128, 200, 19]);
    applyExportInputTransfer(pixels, 1, 1, transfer);
    expect([...pixels]).toEqual([64, 128, 200, 19]);
  });

  it('an image grey reaches I420 through the output table only', () => {
    const grey = 128;
    const pixels = new Uint8ClampedArray(Array.from({ length: 4 }, () => [grey, grey, grey, 255]).flat());
    const before = pixels.slice();
    const yuv = rgbaToI420(pixels, 2, 2, new Uint8Array(6));
    expect([...yuv]).toEqual([Math.round(16 + 219 * output(grey) / 255), Math.round(16 + 219 * output(grey) / 255), Math.round(16 + 219 * output(grey) / 255), Math.round(16 + 219 * output(grey) / 255), 128, 128]);
    expect(pixels).toEqual(before);
  });
});

type Request = { id: number; forceWasm: boolean; exportColour?: boolean };
class WorkerStub {
  static messages: Request[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown;
  postMessage(request: Request) {
    WorkerStub.messages.push(request);
    queueMicrotask(() => this.onmessage?.({ data: { id: request.id, ok: true, ts: 0, nextTs: null, first: true, width: 2, height: 2, bitmap: { close() {} } } }));
  }
  terminate() {}
}
const originalWorker = globalThis.Worker;
afterEach(() => { closeDecoderPool(); globalThis.Worker = originalWorker; });

describe('D34 decoder request boundary', () => {
  it.each([false, true])('export sets the flag with forceWasm=%s while preview never sets it', async forceWasm => {
    WorkerStub.messages = [];
    globalThis.Worker = WorkerStub as unknown as typeof Worker;
    const ref = { key: `d34-${forceWasm}`, blob: new Blob(['x']), rotation: 0 as const };
    const decoders = new ExportDecoders(forceWasm);
    try {
      await decoders.frame(ref, 0);
      expect(WorkerStub.messages.at(-1)).toMatchObject({ forceWasm, exportColour: true });
      await decodeFrame(ref, 0);
      expect(WorkerStub.messages.at(-1)?.exportColour).toBeUndefined();
    } finally { decoders.closeAll(); }
  });
});
