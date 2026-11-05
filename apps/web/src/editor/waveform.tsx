// SPDX-License-Identifier: AGPL-3.0-only
// Waveforms on the timeline (T13; findings part 3 §45.4: a video with sound shows an "Audio" sub-lane; TIM-14: the drawing
// follows trim, slip and retime). The peaks are the media worker's (T14: mono-mix min/max, 100 buckets/s, store
// 'waveforms'); each screen column draws the min/max of the source span it reads through the clip's clock (mix.ts
// clipClock: trim, speed, time remap; reverse and freeze included). Only the visible part of a clip is drawn.
// Provisional: no gain applied (the source's level is drawn), audio clips draw theirs in the clip body, a missing row is
// asked for again every RETRY_MS (preparation may still be running).
import { useEffect, useRef, useState } from 'react';
import { projectStore } from '../store/database';
import type { RecordData } from '../store/model';
import type { WaveformRow } from '../media/prepare';
import { clipClock } from '../audio/mix';

export const RETRY_MS = 2000;
const rows = new Map<string, Promise<WaveformRow | null>>();
/** The stored peaks of an asset (null while none is stored; not cached then). */
export function waveformRow(assetId: string): Promise<WaveformRow | null> {
  let row = rows.get(assetId);
  if (!row) {
    row = projectStore.row<WaveformRow>('waveforms', assetId).then(r => r ?? null, () => null);
    rows.set(assetId, row);
    void row.then(r => { if (!r) rows.delete(assetId); });
  }
  return row;
}
/** min, max per column for `count` columns from clip-local pixel x0 at `zoom` px/ms (interleaved). */
export function columns(item: RecordData, row: Pick<WaveformRow, 'bucketsPerSecond' | 'peaks'>, x0: number, count: number, zoom: number): Float32Array {
  const clock = clipClock(item), per = row.bucketsPerSecond / 1000, buckets = row.peaks.length / 2, out = new Float32Array(count * 2);
  for (let c = 0; c < count; c++) {
    const a = clock((x0 + c) / zoom) * per, b = clock((x0 + c + 1) / zoom) * per;
    const first = Math.max(0, Math.floor(Math.min(a, b))), last = Math.min(buckets, Math.max(Math.floor(Math.min(a, b)) + 1, Math.ceil(Math.max(a, b))));
    let lo = 0, hi = 0;
    for (let i = first; i < last; i++) { lo = Math.min(lo, row.peaks[2 * i]); hi = Math.max(hi, row.peaks[2 * i + 1]); }
    out[2 * c] = lo; out[2 * c + 1] = hi;
  }
  return out;
}
/** The visible part [x0, x1) of a clip at `left` px, `width` px wide, in a lane scrolled to `scroll` showing `view` px. */
export function visiblePart(left: number, width: number, scroll: number, view: number): [number, number] {
  return [Math.max(0, Math.floor(scroll - left)), Math.max(0, Math.min(Math.ceil(width), Math.ceil(scroll + view - left)))];
}

export function Waveform({ item, left, width, height, zoom, scroll, view }: { item: RecordData; left: number; width: number; height: number; zoom: number; scroll: number; view: number }) {
  const canvas = useRef<HTMLCanvasElement>(null), assetId = item.metadata?.assetId as string | undefined;
  const [row, setRow] = useState<WaveformRow | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void waveformRow(assetId).then(r => { if (!alive) return; setRow(r); if (!r) timer = setTimeout(load, RETRY_MS); });
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [assetId]);
  const [x0, x1] = visiblePart(left, width, scroll, view), count = x1 - x0;
  useEffect(() => {
    const c = canvas.current, g = c?.getContext('2d');
    if (!c || !g || !row || count <= 0) return;
    c.width = count; c.height = height;
    const cols = columns(item, row, x0, count, zoom), mid = height / 2;
    g.clearRect(0, 0, count, height); g.fillStyle = getComputedStyle(c).color;
    for (let x = 0; x < count; x++) { const top = mid - cols[2 * x + 1] * mid, bottom = mid - cols[2 * x] * mid; g.fillRect(x, top, 1, Math.max(1, bottom - top)); }
  }, [row, item, x0, count, height, zoom]);
  if (!row || count <= 0) return null;
  return <canvas ref={canvas} className="waveform" aria-hidden="true" data-asset-id={assetId} style={{ left: x0, width: count, height }} />;
}
