// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance D2–D7, D9 (pure view rules). Oracle: our written tables (findings §15, §23, part 2 §29/§37, part 3 §45.4,
// §46.12). Golden capture G-15 was never stored, so tests whose name contains "ground truth" check hand-written expected values,
// never "same as Xapp".
import { describe, expect, it } from 'vitest';
import {
  clampScroll, clampZoom, clipColour, clipMenu, contentWidth, DEFAULT_ZOOM, displayRows, fitZoom, frameAt, groupEligible, hasSourceHandles, layerEntries, maxScroll,
  nextGroupName, reconcileZoom, resizedHeight, showTrimHandles, snap, snapDistanceMs, snapTargets, stepFrame, tickInterval, tickLabel, ticks, timecode,
  toggleGroupCheck, trackGroups, trackHeight, trimHalo, zoomAround, zoomToFit,
} from '../apps/web/src/editor/geometry';
import type { Row } from '../apps/web/src/editor/geometry';

const track = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1, ...extra });
const ids = (rows: Row[]) => rows.map(r => r.kind === 'group' ? `g:${r.group.id}` : r.track.id);

describe('D2 zoom, fit and scroll', () => {
  it('ground truth: defaults and limits (zoom 0.05 px/ms, max 1, step ×1.25, 2 s padding)', () => {
    expect(DEFAULT_ZOOM).toBe(0.05);
    expect(clampZoom(5, 0.01)).toBe(1); expect(clampZoom(0.0001, 0.01)).toBe(0.01); expect(clampZoom(0.3, 0.01)).toBe(0.3);
    expect(fitZoom(1032, 28000)).toBeCloseTo(1000 / 30000, 12); // (width − 32) ÷ (duration + 2000)
    expect(fitZoom(10, 1e9)).toBe(0.001); // floor when the quotient is negative/tiny
    expect(fitZoom(4096, 1000)).toBe(1); expect(zoomToFit(4096, 1000).zoom).toBe(1);
    expect(zoomAround(zoomToFit(4096, 1000), 'in', 0, 4096, 1000).zoom).toBe(1);
    expect(contentWidth(0.05, 18000)).toBe(1000);
  });
  it('ground truth: W3-RT-11 numbers — 45 s clip fits at 38.02 px/s, ×1.25³ = 74.26 px/s, content 3,491 → 3,119 px, scroll 1,672 → 1,300 px', () => {
    const lane = 1819, fit = fitZoom(lane, 45000);
    expect(fit * 1000).toBeCloseTo(38.02, 2);
    let view = zoomToFit(lane, 45000);
    expect(view).toEqual({ zoom: fit, scroll: 0 });
    for (let n = 0; n < 3; n++) view = zoomAround(view, 'in', 0, lane, 45000);
    expect(view.zoom * 1000).toBeCloseTo(74.26, 2);
    expect(view.zoom / fit).toBeCloseTo(1.25 ** 3, 12);
    expect(Math.abs(contentWidth(view.zoom, 45000) - 3491)).toBeLessThan(1.5);
    expect(Math.abs(maxScroll(view.zoom, 45000, lane) - 1672)).toBeLessThan(1.5);
    // Trim the clip's end by 5 s: duration 40 s. Zoom unchanged (±0.01 px/s), content 371 px shorter, scroll clamped to the new end.
    const after = reconcileZoom({ zoom: view.zoom, scroll: 1672 }, lane, 40000);
    expect(Math.abs(after.zoom * 1000 - view.zoom * 1000)).toBeLessThan(0.01);
    expect(Math.abs(contentWidth(view.zoom, 45000) - contentWidth(after.zoom, 40000) - 371)).toBeLessThan(1);
    expect(Math.abs(contentWidth(after.zoom, 40000) - 3119)).toBeLessThan(1.5);
    expect(Math.abs(after.scroll - 1300)).toBeLessThan(1);
    expect(fitZoom(lane, 40000) * 1000).toBeCloseTo(42.55, 1); // new fit (~43 px/s) is below the zoom, so nothing re-fits
  });
  it('a shortening edit raises the zoom to the new fit; a longer timeline leaves it unchanged; scroll only clamps', () => {
    const lane = 1819;
    const raised = reconcileZoom({ zoom: 0.05, scroll: 0 }, lane, 5000);
    expect(raised.zoom).toBeCloseTo(1787 / 7000, 12); expect(raised.zoom).toBeGreaterThan(0.05);
    const kept = reconcileZoom({ zoom: raised.zoom, scroll: 0 }, lane, 45000);
    expect(kept.zoom).toBe(raised.zoom);
    expect(reconcileZoom({ zoom: 0.2, scroll: 99999 }, lane, 20000).scroll).toBeCloseTo(contentWidth(0.2, 20000) - lane, 9);
    expect(reconcileZoom({ zoom: 0.2, scroll: -50 }, lane, 20000).scroll).toBe(0);
    expect(clampScroll(10, 0.05, 1000, 5000)).toBe(0); // content narrower than the lanes: no scroll
  });
  it('zoom in/out multiply by 1.25 and divide by 1.25 anchored on the playhead (screen x stays put)', () => {
    const start = { zoom: 0.05, scroll: 100 }, lane = 1000, duration = 60000, anchor = 4000; // playhead on screen at 4000 × 0.05 − 100 = 100
    const zin = zoomAround(start, 'in', anchor, lane, duration);
    expect(zin.zoom).toBeCloseTo(0.0625, 12); expect(anchor * zin.zoom - zin.scroll).toBeCloseTo(100, 9);
    const zout = zoomAround({ zoom: 0.0625, scroll: 150 }, 'out', anchor, lane, duration);
    expect(zout.zoom).toBeCloseTo(0.05, 12); expect(anchor * zout.zoom - zout.scroll).toBeCloseTo(100, 9);
    // Off screen → centred (laneWidth / 2).
    const off = zoomAround({ zoom: 0.05, scroll: 0 }, 'in', 40000, lane, duration);
    expect(40000 * off.zoom - off.scroll).toBeCloseTo(500, 9);
    // Zoom out never goes below the fit; zoom in never above 1.
    const fit = fitZoom(lane, duration);
    expect(zoomAround({ zoom: fit, scroll: 0 }, 'out', 0, lane, duration).zoom).toBe(fit);
    expect(zoomAround({ zoom: 0.9, scroll: 0 }, 'in', 0, lane, duration).zoom).toBe(1);
  });
  it('zoom to fit sets zoom = fit and resets the scroll', () => { expect(zoomToFit(932, 18000)).toEqual({ zoom: 900 / 20000, scroll: 0 }); });
});

describe('D3 ruler ladder and labels', () => {
  it('ground truth: first interval of the ladder whose width is at least 72 px', () => {
    expect(tickInterval(0.05)).toBe(2000); // 1000 ms = 50 px < 72, 2000 ms = 100 px
    expect(tickInterval(1)).toBe(100);
    expect(tickInterval(0.0721)).toBe(1000); expect(tickInterval(0.0719)).toBe(2000);
    expect(tickInterval(0.2)).toBe(500); // 250 ms = 50 px < 72, 500 ms = 100 px
    expect(tickInterval(0.001)).toBe(120000); // 60 s = 60 px < 72 → 120 s
    expect(tickInterval(0.00001)).toBe(1800000); // beyond the ladder: the last step
  });
  it('labels read m:ss, and m:ss.s below 1 s intervals', () => {
    expect(tickLabel(0, 2000)).toBe('0:00'); expect(tickLabel(65000, 1000)).toBe('1:05'); expect(tickLabel(125000, 5000)).toBe('2:05');
    expect(tickLabel(500, 100)).toBe('0:00.5'); expect(tickLabel(61500, 500)).toBe('1:01.5'); expect(tickLabel(1500, 500)).toBe('0:01.5');
  });
  it('ticks cover the visible pixel range', () => {
    expect(ticks(0.05, 0, 300)).toEqual([0, 2000, 4000, 6000]);
    expect(ticks(0.05, 150, 300)).toEqual([2000, 4000, 6000, 8000]); // starts at the tick before the left edge
  });
});

describe('time display', () => {
  it('timecode is mm:ss.cc and clamps negatives', () => {
    expect(timecode(0)).toBe('00:00.00'); expect(timecode(1000)).toBe('00:01.00'); expect(timecode(61230)).toBe('01:01.23'); expect(timecode(999)).toBe('00:00.99'); expect(timecode(-5)).toBe('00:00.00');
    expect(timecode(20000)).toBe('00:20.00');
  });
  it('stepFrame moves exactly one frame at the project fps, clamped to 0…duration', () => {
    expect(stepFrame(0, 1, 30, 10000)).toBeCloseTo(1000 / 30, 9);
    expect(stepFrame(1000 / 30, 1, 30, 10000)).toBeCloseTo(2000 / 30, 9);
    expect(stepFrame(40, 1, 30, 10000)).toBeCloseTo(2000 / 30, 9); // off-grid playhead rounds to the frame, then steps
    expect(stepFrame(0, 1, 24, 10000)).toBeCloseTo(1000 / 24, 9);
    expect(stepFrame(0, -1, 30, 10000)).toBe(0); expect(stepFrame(1000, 1, 30, 1000)).toBe(1000);
    expect(frameAt(1010, 30)).toBeCloseTo(1000, 9); expect(frameAt(40, 30)).toBeCloseTo(1000 / 30, 9); expect(frameAt(52, 30)).toBeCloseTo(2000 / 30, 9);
  });
});

describe('D4 track heights and colours', () => {
  it('ground truth: 56 px media, 48 px caption/overlay, stored height wins, resize clamps to 36–120', () => {
    expect(trackHeight(track('v1', 'video'))).toBe(56); expect(trackHeight(track('a1', 'audio'))).toBe(56);
    expect(trackHeight(track('c1', 'caption'))).toBe(48); expect(trackHeight(track('o1', 'overlay'))).toBe(48);
    expect(trackHeight(track('v1', 'video', { height: 90 }))).toBe(90); expect(trackHeight(track('o1', 'overlay', { height: 40 }))).toBe(40);
    expect(resizedHeight(56, 80)).toBe(120); // W3-CC-03: +80 px from 56 stores 120
    expect(resizedHeight(56, -80)).toBe(36); expect(resizedHeight(56, 10.4)).toBe(66); expect(resizedHeight(56, 10.6)).toBe(67); expect(resizedHeight(56, 0)).toBe(56);
  });
  it('ground truth: clip colours by type', () => {
    expect(['video', 'audio', 'image', 'text'].map(clipColour)).toEqual(['blue', 'blue', 'blue', 'blue']);
    expect(clipColour('shape')).toBe('rose'); expect(clipColour('motionGraphic')).toBe('cyan'); expect(clipColour('layout')).toBe('amber'); expect(clipColour('caption')).toBe('teal');
  });
});

describe('D5 layer order and display rows', () => {
  const base = { tracks: [track('a1', 'audio'), track('v1', 'video'), track('v2', 'video'), track('c1', 'caption')], groups: {} };
  it('stored bottom-first order is shown top-first', () => {
    expect(ids(displayRows({ ...base, layerOrder: [{ type: 'track', id: 'a1' }, { type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }, { type: 'track', id: 'c1' }] }))).toEqual(['c1', 'v2', 'v1', 'a1']);
  });
  it('a group row sits above its members; collapsing hides the members; members keep their order', () => {
    const doc = { ...base, groups: { g1: { name: 'Group 1', children: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }] } }, layerOrder: [{ type: 'track' as const, id: 'a1' }, { type: 'group' as const, id: 'g1' }, { type: 'track' as const, id: 'c1' }] };
    const rows = displayRows(doc);
    expect(ids(rows)).toEqual(['c1', 'g:g1', 'v2', 'v1', 'a1']);
    expect(rows.map(r => r.depth)).toEqual([0, 0, 1, 1, 0]);
    const group = rows[1]; expect(group.kind === 'group' && group.members).toEqual(['v1', 'v2']);
    expect(ids(displayRows(doc, new Set(['g1'])))).toEqual(['c1', 'g:g1', 'a1']);
    expect(trackGroups(doc)).toEqual(new Map([['v1', 'g1'], ['v2', 'g1']]));
    expect(rows.filter(r => r.kind === 'track').map(r => r.kind === 'track' && r.groupId)).toEqual([null, 'g1', 'g1', null]);
  });
  it('§53.5 repair: tracks missing from the stored order — audio bottom, caption top, others just below the first caption', () => {
    const doc = { tracks: [track('v1', 'video'), track('c1', 'caption'), track('a1', 'audio'), track('v2', 'video')], groups: {}, layerOrder: [{ type: 'track' as const, id: 'v1' }] };
    expect(layerEntries(doc).map(e => e.id)).toEqual(['a1', 'v1', 'v2', 'c1']);
    expect(ids(displayRows(doc))).toEqual(['c1', 'v2', 'v1', 'a1']);
    // Without any caption a missing video track goes on top; a caption inside a group counts as the first caption.
    expect(layerEntries({ tracks: [track('v1', 'video'), track('v2', 'video')], groups: {}, layerOrder: [{ type: 'track', id: 'v1' }] }).map(e => e.id)).toEqual(['v1', 'v2']);
    const grouped = { tracks: [track('v1', 'video'), track('c1', 'caption'), track('v2', 'video')], groups: { g: { name: 'G', children: [{ type: 'track', id: 'c1' }] } }, layerOrder: [{ type: 'track' as const, id: 'v1' }, { type: 'group' as const, id: 'g' }] };
    expect(layerEntries(grouped).map(e => e.id)).toEqual(['v1', 'v2', 'g']);
  });
  it('unknown ids are skipped, not rendered', () => {
    expect(ids(displayRows({ tracks: [track('v1', 'video')], groups: {}, layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'ghost' }, { type: 'group', id: 'nogroup' }] }))).toEqual(['v1']);
  });
});

describe('D6 trim handles and halo', () => {
  const video = (display: [number, number], trim: { from: number; to: number } | undefined, extra: Record<string, unknown> = {}) => ({ id: 'i', type: 'video', trackId: 'v1', display: { from: display[0], to: display[1] }, trim, sourceDuration: 10000, ...extra });
  it('ground truth: handles are 8 px and hidden when the clip is narrower than 16 px', () => {
    expect(showTrimHandles(16)).toBe(true); expect(showTrimHandles(15.99)).toBe(false); expect(showTrimHandles(200)).toBe(true);
  });
  it('ground truth: red where the edge is constrained by the source limit, green otherwise', () => {
    expect(trimHalo(video([0, 8000], { from: 0, to: 8000 }), 'start')).toBe('red'); expect(trimHalo(video([0, 8000], { from: 0, to: 8000 }), 'end')).toBe('green');
    expect(trimHalo(video([0, 8000], { from: 2000, to: 10000 }), 'start')).toBe('green'); expect(trimHalo(video([0, 8000], { from: 2000, to: 10000 }), 'end')).toBe('red');
    expect(trimHalo(video([0, 4000], { from: 1000, to: 5000 }), 'start')).toBe('green'); expect(trimHalo(video([0, 4000], { from: 1000, to: 5000 }), 'end')).toBe('green');
    expect(trimHalo({ id: 'a', type: 'audio', trackId: 'a1', display: { from: 0, to: 1000 }, trim: { from: 0, to: 1000 }, sourceDuration: 1000 }, 'end')).toBe('red');
    // No trim: the end comes from the display length × playback rate.
    expect(trimHalo(video([0, 4000], undefined, { playbackRate: 2, sourceDuration: 8000 }), 'end')).toBe('red');
    expect(trimHalo(video([0, 4000], undefined, { playbackRate: 1, sourceDuration: 8000 }), 'end')).toBe('green');
  });
  it('items with no source (text, image, shape) are green on both edges and have no source handles', () => {
    for (const type of ['text', 'image', 'shape']) {
      const item = { id: 'x', type, trackId: 'o1', display: { from: 0, to: 1000 }, sourceDuration: 1000, trim: { from: 0, to: 1000 } };
      expect(trimHalo(item, 'start')).toBe('green'); expect(trimHalo(item, 'end')).toBe('green'); expect(hasSourceHandles(item)).toBe(false);
    }
    expect(hasSourceHandles(video([0, 10000], { from: 0, to: 10000 }))).toBe(false); expect(hasSourceHandles(video([0, 8000], { from: 0, to: 8000 }))).toBe(true);
  });
});

describe('D8 clip menu enable rules', () => {
  const clip = { id: 'c', type: 'video', trackId: 'v1', display: { from: 1000, to: 5000 }, trim: { from: 0, to: 4000 }, sourceDuration: 10000 };
  const opts = { playheadMs: 3000, locked: false, grouped: false, clipboard: 0, slipping: false };
  it('ground truth: split only strictly inside the clip; paste only with a clipboard; slip needs hidden source; all off when locked', () => {
    expect(clipMenu(clip, opts)).toEqual({ moveOutOfGroup: null, split: true, duplicate: true, slip: true, slipLabel: 'Slip', copy: true, paste: false, delete: true });
    expect(clipMenu(clip, { ...opts, playheadMs: 1000 }).split).toBe(false); expect(clipMenu(clip, { ...opts, playheadMs: 5000 }).split).toBe(false); expect(clipMenu(clip, { ...opts, playheadMs: 0 }).split).toBe(false);
    expect(clipMenu(clip, { ...opts, clipboard: 2 }).paste).toBe(true);
    expect(clipMenu({ ...clip, trim: { from: 0, to: 10000 } }, opts).slip).toBe(false); // nothing hidden to slip through
    const slipping = clipMenu({ ...clip, trim: { from: 0, to: 10000 } }, { ...opts, slipping: true }); expect(slipping.slip).toBe(true); expect(slipping.slipLabel).toBe('Exit slip mode');
    expect(Object.values(clipMenu(clip, { ...opts, locked: true, clipboard: 3 }))).toEqual([null, false, false, false, 'Slip', false, false, false]);
  });
  it('grouped clips get a Move out of group entry (disabled when locked); slip is always off for image, layout and caption', () => {
    expect(clipMenu(clip, { ...opts, grouped: true }).moveOutOfGroup).toBe(true); expect(clipMenu(clip, { ...opts, grouped: true, locked: true }).moveOutOfGroup).toBe(false);
    for (const type of ['image', 'layout', 'caption']) expect(clipMenu({ ...clip, type }, { ...opts, slipping: true }).slip).toBe(false);
  });
});

describe('D7 snapping', () => {
  it('ground truth: snap distance = 8 px ÷ √(zoom ÷ 0.05) ÷ zoom, at least 1 ms', () => {
    expect(snapDistanceMs(0.0125)).toBeCloseTo(1280, 9); expect(snapDistanceMs(0.05)).toBeCloseTo(160, 9); expect(snapDistanceMs(0.2)).toBeCloseTo(20, 9);
    expect(snapDistanceMs(1)).toBeCloseTo(8 / Math.sqrt(20), 9); expect(snapDistanceMs(1000)).toBe(1);
  });
  it('a dragged span tests its start and its end; the closer match wins', () => {
    expect(snap(1100, 500, [1000], 0.05)).toEqual({ startMs: 1000, target: 1000 }); // by the start
    expect(snap(400, 500, [1000], 0.05)).toEqual({ startMs: 500, target: 1000 }); // by the end: start = target − length
    expect(snap(1100, 250, [1000, 1300], 0.05)).toEqual({ startMs: 1050, target: 1300 }); // end 1350 is 50 from 1300; start 1100 is 100 from 1000
    expect(snap(700, 500, [1000], 0.05)).toEqual({ startMs: 700, target: null }); // 300 and 200 are both outside 160
    expect(snap(1030, 500, [1000], 0.2)).toEqual({ startMs: 1030, target: null }); // limit shrinks to 20 ms at 0.2
    expect(snap(1030, 500, [1000], 0.05)).toEqual({ startMs: 1000, target: 1000 });
    expect(snap(500, 0, [], 0.05)).toEqual({ startMs: 500, target: null });
  });
  it('ground truth: 21 scripted drags at three zoom levels (targets 1000 and 5000; span length 800)', () => {
    // Hand-computed from the written rule: limit 1280 / 160 / 20 ms; each target is matched by the span start or its end
    // (end match → start = target − 800); the smallest distance wins. Rows are [zoom, raw start, snapped start, target].
    const table: [number, number, number, number | null][] = [
      [0.0125, 0, 200, 1000], [0.0125, 2000, 1000, 1000], [0.0125, 2400, 2400, null], [0.0125, 3000, 4200, 5000], [0.0125, 3500, 4200, 5000], [0.0125, 5900, 5000, 5000], [0.0125, 9000, 9000, null],
      [0.05, 900, 1000, 1000], [0.05, 1150, 1000, 1000], [0.05, 1170, 1170, null], [0.05, 200, 200, 1000], [0.05, 4300, 4200, 5000], [0.05, 4900, 5000, 5000], [0.05, 3000, 3000, null],
      [0.2, 1015, 1000, 1000], [0.2, 1025, 1025, null], [0.2, 990, 1000, 1000], [0.2, 4215, 4200, 5000], [0.2, 4970, 4970, null], [0.2, 5015, 5000, 5000], [0.2, 3000, 3000, null],
    ];
    expect(table).toHaveLength(21);
    for (const [zoom, start, snapped, target] of table) expect(snap(start, 800, [1000, 5000], zoom), `zoom ${zoom} start ${start}`).toEqual({ startMs: snapped, target });
  });
  it('targets: grid, edges of other items on visible tracks (dragged and hidden excluded), markers, playhead', () => {
    const doc = {
      tracks: [track('v1', 'video'), track('v2', 'video', { hidden: true })],
      items: [
        { id: 'i1', type: 'video', trackId: 'v1', display: { from: 100, to: 1100 } },
        { id: 'i2', type: 'video', trackId: 'v2', display: { from: 5000, to: 6500 } }, // hidden track
        { id: 'i3', type: 'video', trackId: 'v1', display: { from: 7000, to: 8000 } }, // being dragged
      ],
      markers: [{ id: 'm', timeMs: 1500 }],
    };
    const t = snapTargets(doc, { zoom: 0.05, playheadMs: 777, exclude: new Set(['i3']), hiddenTracks: new Set(['v2']), rangeMs: [0, 4000] });
    expect(t.slice().sort((a, b) => a - b)).toEqual([0, 100, 777, 1100, 1500, 2000, 4000]);
    // Grid starts at the tick before the range start.
    const g = snapTargets({ tracks: [], items: [], markers: [] }, { zoom: 0.05, playheadMs: 0, exclude: new Set(), hiddenTracks: new Set(), rangeMs: [3000, 5000] });
    expect(g.filter(x => x !== 0)).toEqual([2000, 4000]);
  });
});

describe('D9 track grouping selection', () => {
  const doc = { tracks: [track('v1', 'video'), track('v2', 'video'), track('o1', 'overlay'), track('o2', 'overlay'), track('o3', 'overlay')], groups: {} as Record<string, any>, layerOrder: ['v1', 'v2', 'o1', 'o2', 'o3'].map(id => ({ type: 'track' as const, id })) };
  const rows = () => displayRows(doc); // O3 O2 O1 V2 V1
  it('ground truth: V2 → [V2] (Group (1)); then O3 → O3 O2 O1 V2 (Group (4))', () => {
    expect(ids(rows())).toEqual(['o3', 'o2', 'o1', 'v2', 'v1']);
    const first = toggleGroupCheck(rows(), [], 'v2'); expect(first).toEqual(['v2']);
    const second = toggleGroupCheck(rows(), first, 'o3'); expect(second).toEqual(['o3', 'o2', 'o1', 'v2']); expect(second).toHaveLength(4);
  });
  it('unchecking an end shrinks the run; unchecking an inner track keeps the part above it', () => {
    const run = ['o3', 'o2', 'o1', 'v2'];
    expect(toggleGroupCheck(rows(), run, 'o3')).toEqual(['o2', 'o1', 'v2']); expect(toggleGroupCheck(rows(), run, 'v2')).toEqual(['o3', 'o2', 'o1']);
    expect(toggleGroupCheck(rows(), run, 'o2')).toEqual(['o3']); expect(toggleGroupCheck(rows(), ['v2'], 'v2')).toEqual([]);
  });
  it('locked tracks and tracks already in a group are not eligible; a locked/grouped track blocks auto-fill', () => {
    const locked = { ...doc, tracks: doc.tracks.map(t => t.id === 'o1' ? { ...t, locked: true } : t) };
    const lockedRows = displayRows(locked);
    expect(groupEligible(lockedRows)).toEqual(['o3', 'o2', 'v2', 'v1']);
    expect(toggleGroupCheck(lockedRows, [], 'o1')).toEqual([]); // not eligible
    expect(toggleGroupCheck(lockedRows, ['v2'], 'o3')).toEqual(['v2']); // would cross the locked O1: unchanged
    const grouped = { ...doc, groups: { g: { name: 'Group 1', children: [{ type: 'track', id: 'o1' }, { type: 'track', id: 'o2' }] } }, layerOrder: [{ type: 'track' as const, id: 'v1' }, { type: 'track' as const, id: 'v2' }, { type: 'group' as const, id: 'g' }, { type: 'track' as const, id: 'o3' }] };
    const groupedRows = displayRows(grouped);
    expect(groupEligible(groupedRows)).toEqual(['o3', 'v2', 'v1']);
    expect(toggleGroupCheck(groupedRows, ['v2'], 'o3')).toEqual(['v2']); // the group row sits between: unchanged
    expect(toggleGroupCheck(groupedRows, [], 'o1')).toEqual([]); // grouped member is not eligible
  });
  it('blank name → the next free "Group n" (smallest n, case-insensitive)', () => {
    expect(nextGroupName({})).toBe('Group 1'); expect(nextGroupName({ a: { name: 'Group 1' } })).toBe('Group 2');
    expect(nextGroupName({ a: { name: 'Group 1' }, b: { name: 'Group 3' } })).toBe('Group 2'); expect(nextGroupName({ a: { name: ' group 1 ' } })).toBe('Group 2');
    expect(nextGroupName({ a: { name: 'Intro' } })).toBe('Group 1');
  });
});
