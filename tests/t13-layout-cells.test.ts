// SPDX-License-Identifier: AGPL-3.0-only
// T13 mix with T07's layout cells: a filled video cell sounds in the mix that preview and export share. Oracles: T07's cell item
// (timeline/layouts cellItem: the layout's track and time, trim start, cell Speed as playbackRate, cell Volume / 100 as the
// volume property) and the cell gain law (findings §7b.3 l.159: "Layout cells … gain = track gain × (cell volume % / 100)². No
// keyframes, no remap."; mute / solo / hidden → 0).
import { describe, it, expect } from 'vitest';
import { mixFrames } from '../apps/web/src/audio/mix';
import { cellsOf, layoutRecord } from '../apps/web/src/timeline/layouts';
import type { RecordData } from '../apps/web/src/store/model';
import { FS, mkClip, mkDoc, mkTrack, synthSource } from './t13-support';

const impulse = (at: number, amp: number) => (n: number) => (n === at ? amp : 0);
const nonzero = (x: Float32Array) => { const out: number[] = []; x.forEach((v, i) => { if (Math.abs(v) > 1e-9) out.push(i); }); return out; };
/** A split-horizontal layout on O1 at 1–3 s: cell 0 a video (asset-v) at `cell`'s Volume / Speed, cell 1 an image. */
function layout(cell: { volume?: number; playbackRate?: number } = {}): { rec: RecordData; cellId: string } {
  const rec = layoutRecord({ id: 'L1', trackId: 'O1', display: { from: 1000, to: 3000 }, layoutType: 'split-horizontal', width: 1280, height: 720 });
  const [a, b] = cellsOf(rec);
  Object.assign(a, { source: { assetId: 'asset-v', type: 'video', url: 'asset:asset-v' }, volume: 100, playbackRate: 1, ...cell });
  b.source = { assetId: 'asset-i', type: 'image', url: 'asset:asset-i' };
  return { rec, cellId: `L1/${a.id}` };
}

describe('T07 layout cells in the T13 mix', () => {
  it('a filled video cell sounds at the layout\'s place with its Volume through the gain law (150 % → 1.5² = 2.25); the image cell adds nothing', async () => {
    const { rec, cellId } = layout({ volume: 150 }), calls: { id: string; startS: number; endS: number }[] = [];
    const [L, R] = await mixFrames(mkDoc([mkTrack('O1', { kind: 'overlay' })], [rec]), 0, 4 * FS, { source: synthSource({ [cellId]: impulse(1000, 0.1) }, 4, calls) });
    expect(nonzero(L)).toEqual([FS + 1000]); expect(L[FS + 1000]).toBeCloseTo(0.225, 6); expect(R[FS + 1000]).toBeCloseTo(0.225, 6);
    expect(calls.map(c => c.id)).toEqual([cellId]);
  });

  it('cell Speed is the cell clip\'s rate: at 2× source frame 2000 sounds 1000 frames into the layout', async () => {
    const { rec, cellId } = layout({ playbackRate: 2 });
    const [L] = await mixFrames(mkDoc([mkTrack('O1', { kind: 'overlay' })], [rec]), 0, 4 * FS, { source: synthSource({ [cellId]: impulse(2000, 0.5) }, 8) });
    expect(nonzero(L)).toEqual([FS + 1000]); expect(L[FS + 1000]).toBeCloseTo(0.5, 6);
  });

  it('the layout\'s track rules its cells: muted, hidden, or another track soloed → silent and the cell source is not read', async () => {
    for (const [o1, other] of [[{ muted: true }, {}], [{ hidden: true }, {}], [{}, { solo: true }]] as const) {
      const { rec, cellId } = layout(), calls: { id: string; startS: number; endS: number }[] = [];
      const doc = mkDoc([mkTrack('O1', { kind: 'overlay', ...o1 }), mkTrack('a', other)], [rec, mkClip('c', 'a', 0, 500)]);
      const [L] = await mixFrames(doc, 0, 4 * FS, { source: synthSource({ [cellId]: impulse(1000, 0.5) }, 4, calls) });
      expect(nonzero(L), JSON.stringify(o1)).toEqual([]); expect(calls.map(c => c.id)).not.toContain(cellId);
    }
  });
});
