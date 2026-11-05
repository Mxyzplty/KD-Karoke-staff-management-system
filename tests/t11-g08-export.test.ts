// SPDX-License-Identifier: AGPL-3.0-only
// T11 integration round: the G-08 export comparison (parity/g08-export.ts, CLI `--golden G-08 --export`, `--ot6-fade`) and the
// export decoder key (apps/web/src/export/pipeline.ts drawKey). Four parts:
//   (a) the pure helpers, with the full refusal text of each (formula oracles; the stored names and the _windows.json schema are
//       undocumented, T00 harness runbook l.50, so every one is a flag);
//   (b) one SYNTHETIC round trip through runG08 + compareExport with its negatives: the stored PNGs are the T00 oracle's own
//       frames (parity/g08-synthetic.ts), so this proves the runner is self-consistent, NOT Xapp parity. The Chromium runs are two:
//       the passing run and one combined failing run (a darkened PNG, a PNG past the end, a wrong ffprobe frame count); every other
//       negative stops before the browser opens;
//   (c) the CLI refusals (stderr text; the arguments are checked before any file is read);
//   (d) drawKey, pure.
// Own tolerances (SSIM floor .98, alpha ±.06, window tolerance 1 frame) are the module's own, provisional; QE2's ±.06 is not Xapp's.
// CI has Chromium and ffmpeg (as tests/t15-g02-frames.test.ts); the round trip needs no fixture store (both media come from --media).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALPHA_TOLERANCE, CLUSTER_GAP, MIN_SSIM, alphaFit, checkFrame, checkWindows, clusters, matchExportFrames, parseWindowSpec, rangeOf, ssim, storedWindows,
  windowAt, withPlaceholders, compareExport, type OurWindow, type StoredWindow, type WindowSpec } from '../parity/g08-export';
import { runG08 } from '../parity/g08';
import { writeSyntheticExportFrames, writeSyntheticG08 } from '../parity/g08-synthetic';
import { drawKey } from '../apps/web/src/export/pipeline';
import { exportPlan } from '../apps/web/src/render/model';
import type { Draw } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const refuses = (fn: () => unknown, message: string) => expect(fn).toThrow(new Error(message));

describe('(a) parseWindowSpec: the names and the unit of _windows.json are flags, never defaults (T00 harness runbook l.50)', () => {
  it('reads start, length, label and unit, and an optional list', () => {
    expect(parseWindowSpec('start=startS,length=lengthS,label=label,unit=s')).toStrictEqual({ start: 'startS', length: 'lengthS', label: 'label', unit: 's' });
    expect(parseWindowSpec(' start=a , length=b,label=c,unit=frame,list=windows')).toStrictEqual({ start: 'a', length: 'b', label: 'c', unit: 'frame', list: 'windows' });
  });
  it('names every missing key', () => {
    refuses(() => parseWindowSpec('start=a,unit=s'), '--windows needs length, label: the field names and the unit of frames/export/_windows.json are not documented (T00 harness runbook l.50)');
    refuses(() => parseWindowSpec('list=x'), '--windows needs start, length, label, unit: the field names and the unit of frames/export/_windows.json are not documented (T00 harness runbook l.50)');
  });
  it('a unit that is not ms, s or frame is refused', () => {
    refuses(() => parseWindowSpec('start=a,length=b,label=c,unit=min'), '--windows unit must be ms, s or frame');
  });
  it('an unknown part, a part without a value and a duplicate key are refused with the part named', () => {
    const tail = ' is not one of start=<field>, length=<field>, label=<field>, unit=ms|s|frame, list=<key> (each once)';
    refuses(() => parseWindowSpec('start=a,length=b,label=c,unit=s,foo=d'), `--windows: 'foo=d'${tail}`);
    refuses(() => parseWindowSpec('start=a,length=b,label=c,unit=s,list='), `--windows: 'list='${tail}`);
    refuses(() => parseWindowSpec('start=a,start=b,length=b,label=c,unit=s'), `--windows: 'start=b'${tail}`);
  });
});

describe('(a) storedWindows: _windows.json to milliseconds (unit conversion is arithmetic: s x 1000, frame x 1000 / fps)', () => {
  const spec = (unit: WindowSpec['unit'], list?: string): WindowSpec => ({ start: 'st', length: 'len', label: 'name', unit, ...(list === undefined ? {} : { list }) });
  it('a bare array, in s, ms and frame (30 fps)', () => {
    const row = { st: 9.5, len: 1, name: 'A-B' };
    expect(storedWindows([row], spec('s'), 30)).toStrictEqual([{ label: 'A-B', startMs: 9500, lengthMs: 1000 }]);
    expect(storedWindows([{ st: 9500, len: 1000, name: 'A-B' }], spec('ms'), 30)).toStrictEqual([{ label: 'A-B', startMs: 9500, lengthMs: 1000 }]);
    expect(storedWindows([{ st: 285, len: 30, name: 'A-B' }], spec('frame'), 30)).toStrictEqual([{ label: 'A-B', startMs: 9500, lengthMs: 1000 }]);
  });
  it('list=<key> reads the array under that key; the label is kept as text; numeric strings are numbers', () => {
    const json = { windows: [{ st: '9.5', len: '1', name: 7 }], other: 1 };
    expect(storedWindows(json, spec('s', 'windows'), 30)).toStrictEqual([{ label: '7', startMs: 9500, lengthMs: 1000 }]);
  });
  it('an object without list= is refused with the top-level keys named', () => {
    refuses(() => storedWindows({ windows: [], extra: 1 }, spec('s'), 30), '_windows.json is not an array: pass list=<key> in --windows (its top-level keys: windows, extra)');
    refuses(() => storedWindows({}, spec('s'), 30), '_windows.json is not an array: pass list=<key> in --windows (its top-level keys: (none))');
    refuses(() => storedWindows(5, spec('s'), 30), '_windows.json is not an array: pass list=<key> in --windows (its top-level keys: number)');
  });
  it('list=<key> with no such array is refused with the top-level keys named', () => {
    refuses(() => storedWindows({ items: [] }, spec('s', 'windows'), 30), "_windows.json has no array 'windows' (its top-level keys: items)");
    refuses(() => storedWindows({ windows: 3 }, spec('s', 'windows'), 30), "_windows.json has no array 'windows' (its top-level keys: windows)");
    refuses(() => storedWindows([], spec('s', 'windows'), 30), "_windows.json has no array 'windows' (its top-level keys: (an array))");
  });
  it('an entry with a missing field is refused with the entry index, the missing names and its keys', () => {
    refuses(() => storedWindows([{ st: 1, len: 1, name: 'ok' }, { st: 1 }], spec('s'), 30), "_windows.json entry 1 has no 'len', 'name'; its keys are: st");
    refuses(() => storedWindows([{}], spec('s'), 30), "_windows.json entry 0 has no 'st', 'len', 'name'; its keys are: (none)");
  });
  it('a non-numeric start or length is refused', () => {
    refuses(() => storedWindows([{ st: 'soon', len: 1, name: 'x' }], spec('s'), 30), "_windows.json entry 0: 'st' and 'len' must be numbers");
    refuses(() => storedWindows([{ st: 1, len: null, name: 'x' }], spec('s'), 30), "_windows.json entry 0: 'st' and 'len' must be numbers");
  });
});

describe('(a) checkWindows: stored windows against ours, within 1 frame (own, provisional)', () => {
  const ours = (id: string, start: number, end: number, extra: Partial<OurWindow> = {}): OurWindow =>
    ({ id, kind: 'wipe', fromId: 'a', toId: 'b', cut: (start + end) / 2, pre: (end - start) / 2, post: (end - start) / 2, start, end, ...extra });
  const stored = (label: string, startMs: number, lengthMs: number): StoredWindow => ({ label, startMs, lengthMs });
  it('a window whose start and length are within 1 frame (33.33 ms at 30 fps) matches, with no diff', () => {
    const r = checkWindows([stored('L', 9500, 1000)], [ours('w1', 9520, 10510, { direction: 'from-left' })], 30);
    expect(r.diffs).toStrictEqual([]);
    expect(r.rows).toStrictEqual([{ label: 'L', startMs: 9500, lengthMs: 1000, ours: { id: 'w1', kind: 'wipe', direction: 'from-left', startMs: 9520, lengthMs: 990 } }]);
  });
  it('the length boundary: 33 ms over passes, 34 ms over is a diff', () => {
    expect(checkWindows([stored('L', 0, 1000)], [ours('w1', 0, 1033)], 30).diffs).toStrictEqual([]);
    expect(checkWindows([stored('L', 0, 1000)], [ours('w1', 0, 1034)], 30).diffs).toStrictEqual([
      { part: 'frame', path: '_windows.json[L].length', expected: 1000, actual: 1034, note: 'Cutframe window w1 (wipe) differs by more than 1 frame' }]);
  });
  it('a start off by more than 1 frame is a diff on both sides: the stored window has no partner, ours has no stored window', () => {
    const r = checkWindows([stored('L', 9500, 1000)], [ours('w1', 9540, 10540)], 30);
    expect(r.diffs).toStrictEqual([
      { part: 'frame', path: '_windows.json[L].start', expected: 9500, actual: 9540, note: 'no Cutframe transition window starts within 1 frame of this stored window' },
      { part: 'frame', path: 'window w1', expected: null, actual: { kind: 'wipe', startMs: 9540, lengthMs: 1000 }, note: 'a Cutframe transition window with no window in _windows.json' }]);
    expect(r.rows).toStrictEqual([{ label: 'L', startMs: 9500, lengthMs: 1000, ours: null }]);
  });
  it('a stored window with none of ours, and one of ours with no stored window', () => {
    expect(checkWindows([stored('L', 9500, 1000)], [], 30).diffs).toStrictEqual([
      { part: 'frame', path: '_windows.json[L].start', expected: 9500, actual: null, note: 'no Cutframe transition window starts within 1 frame of this stored window' }]);
    expect(checkWindows([], [ours('w9', 100, 200)], 30).diffs).toStrictEqual([
      { part: 'frame', path: 'window w9', expected: null, actual: { kind: 'wipe', startMs: 100, lengthMs: 100 }, note: 'a Cutframe transition window with no window in _windows.json' }]);
  });
  it('each stored window takes its own nearest window; none is used twice', () => {
    const r = checkWindows([stored('A', 1000, 500), stored('B', 2000, 500)], [ours('wB', 2010, 2510), ours('wA', 1010, 1510)], 30);
    expect(r.diffs).toStrictEqual([]);
    expect(r.rows.map(x => (x as { ours: { id: string } }).ours.id)).toStrictEqual(['wA', 'wB']);
    // two stored windows at one place, one of ours: the second finds nothing
    expect(checkWindows([stored('A', 1000, 500), stored('B', 1000, 500)], [ours('w1', 1000, 1500)], 30).diffs.map(d => d.path)).toStrictEqual(['_windows.json[B].start']);
  });
});

describe('(a) windowAt: the window a timeline time falls in, [start, end) with p, and the end point with p null', () => {
  const w = { id: 'w1', kind: 'wipe', fromId: 'a', toId: 'b', cut: 10000, pre: 500, post: 500, start: 9500, end: 10500 } as OurWindow;
  it('inside: p = (t - start) / (end - start)', () => {
    expect(windowAt([w], 9500)).toStrictEqual({ w, p: 0 });
    expect(windowAt([w], 10000)).toStrictEqual({ w, p: 0.5 });
    expect(windowAt([w], 10250)).toStrictEqual({ w, p: 0.75 });
  });
  it('the end point (p = 100 %) belongs to the window with p null', () => {
    expect(windowAt([w], 10500)).toStrictEqual({ w, p: null });
  });
  it('outside: undefined', () => {
    expect(windowAt([w], 9499)).toBeUndefined();
    expect(windowAt([w], 10501)).toBeUndefined();
    expect(windowAt([], 10000)).toBeUndefined();
  });
});

describe('(a) matchExportFrames: stored frame names to frame indices (frame = round(t x fps); half rounds up)', () => {
  const E = '^E-(\\d+)\\.png$';
  it('ms: 9500 / 9750 / 10000 give 285 / 293 / 300 (9750 ms is 292.5 and rounds up); sorted by frame; _windows.json is ignored', () => {
    expect(matchExportFrames(['E-9750.png', 'E-10000.png', '_windows.json', 'E-9500.png'], E, 'ms', 30)).toStrictEqual([
      { file: 'E-9500.png', frame: 285 }, { file: 'E-9750.png', frame: 293 }, { file: 'E-10000.png', frame: 300 }]);
  });
  it('s and frame', () => {
    const S = '^F-(\\d+(?:\\.\\d+)?)\\.png$';
    expect(matchExportFrames(['F-9.5.png', 'F-9.75.png', 'F-10.png'], S, 's', 30).map(x => x.frame)).toStrictEqual([285, 293, 300]);
    expect(matchExportFrames(['f-285.png', 'f-3.png'], '^f-(\\d+)\\.png$', 'frame', 30)).toStrictEqual([{ file: 'f-3.png', frame: 3 }, { file: 'f-285.png', frame: 285 }]);
  });
  it('a name the pattern does not match, and a time that is not a number of the unit, are refused with the file named', () => {
    refuses(() => matchExportFrames(['E-9500.png', 'other.png'], E, 'ms', 30), 'frames/export/other.png: --frame-name gives no time in ms (group 1: no match)');
    refuses(() => matchExportFrames(['f-1.5.png'], '^f-(.+)\\.png$', 'frame', 30), 'frames/export/f-1.5.png: --frame-name gives no time in whole frames (group 1: 1.5)');
    refuses(() => matchExportFrames(['f-x.png'], '^f-(.+)\\.png$', 's', 30), 'frames/export/f-x.png: --frame-name gives no time in s (group 1: x)');
  });
  it('a pattern without a capture group, one that is not a regular expression, and a bad unit are refused (unit first)', () => {
    refuses(() => matchExportFrames(['E-9500.png'], '^E-\\d+\\.png$', 'ms', 30), '--frame-name needs a capture group: group 1 is the frame time');
    expect(() => matchExportFrames(['E-9500.png'], '(', 'ms', 30)).toThrow(/^--frame-name is not a regular expression: /);
    refuses(() => matchExportFrames(['E-9500.png'], '(', 'min' as never, 30), '--frame-time-unit must be ms, s or frame');
  });
  it('two files naming one frame are refused with both named', () => {
    refuses(() => matchExportFrames(['E-9510.png', 'E-9500.png'], E, 'ms', 30), 'frames/export/E-9500.png and frames/export/E-9510.png both name frame 285');
  });
  it('an empty folder, or one holding only _windows.json, is refused', () => {
    refuses(() => matchExportFrames([], E, 'ms', 30), 'frames/export/ holds no stored frame');
    refuses(() => matchExportFrames(['_windows.json'], E, 'ms', 30), 'frames/export/ holds no stored frame');
  });
});

describe(`(a) clusters: stored frames within ${CLUSTER_GAP} frames of each other share one export range`, () => {
  it('the synthetic frames 285 / 293 / 300 / 308 / 315 are one range', () => { expect(clusters([285, 293, 300, 308, 315])).toStrictEqual([[285, 315]]); });
  it('a gap of 15 joins, a gap of 16 splits', () => {
    expect(clusters([0, 15])).toStrictEqual([[0, 15]]);
    expect(clusters([0, 16, 40])).toStrictEqual([[0, 0], [16, 16], [40, 40]]);
  });
  it('unsorted and repeated input; a given gap; no frames', () => {
    expect(clusters([31, 0, 0, 15])).toStrictEqual([[0, 15], [31, 31]]);
    expect(clusters([0, 3, 10], 5)).toStrictEqual([[0, 3], [10, 10]]);
    expect(clusters([])).toStrictEqual([]);
  });
});

describe('(a) rangeOf: frames a…b as an export range (written spec: exportPlan first = floor(startS x fps), count = ceil(endS x fps) - first)', () => {
  const doc = { fps: 30 } as ProjectDocument;
  for (const [a, b] of [[0, 0], [165, 194], [285, 315], [0, 899]] as [number, number][]) {
    it(`frames ${a}…${b}: the plan has first ${a} and count ${b - a + 1}`, () => {
      const plan = exportPlan(doc, rangeOf([a, b], 30, 30000));
      expect([plan.first, plan.count, plan.shiftMs]).toStrictEqual([a, b - a + 1, 0]);
    });
  }
  it('endS is clamped to the duration', () => {
    expect(rangeOf([0, 899], 30, 29000).endS).toBe(29);
    expect(rangeOf([0, 899], 30, 30000).endS).toBeCloseTo(899.5 / 30, 12);
  });
});

describe(`(a) ssim: mean over 8 x 8 windows of Rec.709 luma (Wang 2004, C1 = (.01 x 255)^2, C2 = (.03 x 255)^2; floor ${MIN_SSIM}, own, provisional)`, () => {
  const img = (w: number, h: number, f: (x: number, y: number, c: number) => number) => {
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) d[(y * w + x) * 4 + c] = c === 3 ? 255 : f(x, y, c);
    return d;
  };
  const C1 = (0.01 * 255) ** 2;
  it('identical images score 1, flat and textured, and an image smaller than the window', () => {
    const t = img(16, 16, (x, y, c) => (x * 13 + y * 7 + c * 29) % 256);
    expect(ssim(t, t, 16, 16)).toBeCloseTo(1, 12);
    const z = img(16, 16, () => 0);
    expect(ssim(z, z, 16, 16)).toBeCloseTo(1, 12);
    const s = img(4, 4, (x, y) => x * 40 + y);
    expect(ssim(s, s.slice(), 4, 4)).toBeCloseTo(1, 12);
  });
  it('two flat grays: the luminance term (2 m1 m2 + C1) / (m1^2 + m2^2 + C1)', () => {
    const a = img(16, 16, () => 100), b = img(16, 16, () => 200);
    expect(ssim(a, b, 16, 16)).toBeCloseTo((2 * 100 * 200 + C1) / (100 ** 2 + 200 ** 2 + C1), 10);
  });
  it('a changed image scores lower than the floor: darkened to 0.8, a shifted texture, an inverted one', () => {
    const t = img(32, 32, (x, y, c) => (x * 13 + y * 7 + c * 29) % 256);
    const darker = t.map((v, i) => i % 4 === 3 ? v : Math.round(v * 0.8));
    const inverted = t.map((v, i) => i % 4 === 3 ? v : 255 - v);
    expect(ssim(t, darker, 32, 32)).toBeLessThan(1);
    expect(ssim(t, inverted, 32, 32)).toBeLessThan(MIN_SSIM);
    expect(ssim(t, img(32, 32, (x, y, c) => (x * 5 + y * 11 + c * 3) % 256), 32, 32)).toBeLessThan(MIN_SSIM);
  });
});

describe(`(a) alphaFit: the least-squares alpha of their frame against ours (±${ALPHA_TOLERANCE}, the ticket's tolerance for Xapp's frames, implementation tickets l.154; QE2)`, () => {
  it('the tolerances are pinned: alpha ±0.06 (the ticket\'s, l.154; not the ±0.02 of the formula-oracle checks in tests/ui/t11-export.spec.ts), SSIM floor .98', () => {
    expect(ALPHA_TOLERANCE).toBe(0.06);
    expect(MIN_SSIM).toBe(0.98);
  });
  // ours: even values, so half of them is exact; none equal to the dip colour (255, 0, 0) on every channel
  const ours = (() => { const d = new Uint8Array(8 * 8 * 4); for (let i = 0; i < d.length; i++) d[i] = i % 4 === 3 ? 255 : 40 + (i * 7 % 100) * 2; return d; })();
  const scaled = (k: number, c = [0, 0, 0]) => ours.map((v, i) => i % 4 === 3 ? v : Math.round(c[i % 4] + k * (v - c[i % 4])));
  it('fade: their frame = k x ours gives fitted = alpha x k, alpha = cos(pi p) below the cut and -cos(pi p) above it', () => {
    const a25 = Math.cos(Math.PI * 0.25), a75 = -Math.cos(Math.PI * 0.75);
    expect(alphaFit('fade', 0.25, undefined, ours, ours)).toStrictEqual({ alpha: a25, fitted: expect.closeTo(a25, 12) });
    expect(alphaFit('fade', 0.25, undefined, scaled(0.5), ours)!.fitted).toBeCloseTo(a25 * 0.5, 12);
    expect(alphaFit('fade', 0.75, undefined, ours, ours)!.alpha).toBeCloseTo(a75, 12);
    expect(alphaFit('fade', 0.75, undefined, scaled(0), ours)!.fitted).toBe(0);
  });
  it('fade: null where the fade leaves too little picture (alpha < .1), at p .5 and p .48', () => {
    expect(alphaFit('fade', 0.5, undefined, ours, ours)).toBeNull();
    expect(alphaFit('fade', 0.48, undefined, ours, ours)).toBeNull();
    expect(alphaFit('fade', 0.45, undefined, ours, ours)).not.toBeNull();
  });
  it('dip: overlay alpha .5 at p .25 and p .75 (smooth step of .5); fitted = 1 - (1 - alpha) k with the colour params.color [1, 0, 0] = (255, 0, 0)', () => {
    const params = { color: [1, 0, 0] };
    for (const p of [0.25, 0.75]) {
      expect(alphaFit('dipToColorDissolve', p, params, ours, ours)!.alpha).toBeCloseTo(0.5, 12);
      expect(alphaFit('dipToColorDissolve', p, params, ours, ours)!.fitted).toBeCloseTo(0.5, 12);
    }
    // their frame is the colour itself: nothing of ours is left, k = 0, fitted = 1
    const red = ours.map((v, i) => i % 4 === 3 ? v : [255, 0, 0][i % 4]);
    expect(alphaFit('dipToColorDissolve', 0.25, params, red, ours)!.fitted).toBeCloseTo(1, 12);
  });
  it('dip: with no colour the fit is against black, so it equals the fade fit of the same pixels at overlay alpha', () => {
    expect(alphaFit('dipToColorDissolve', 0.25, undefined, ours, ours)!.fitted).toBeCloseTo(0.5, 12);
    expect(alphaFit('dipToColorDissolve', 0.25, undefined, scaled(0.5), ours)!.fitted).toBeCloseTo(1 - 0.5 * 0.5, 12);
  });
  it('dip: null where the overlay covers the picture (alpha > .9, p .5)', () => {
    expect(alphaFit('dipToColorDissolve', 0.5, { color: [1, 0, 0] }, ours, ours)).toBeNull();
  });
  it('another kind is null; so is a frame with nothing to fit against (ours all black for a fade)', () => {
    for (const kind of ['wipe', 'slide', 'dissolve', 'additiveDissolve']) expect(alphaFit(kind, 0.25, undefined, ours, ours), kind).toBeNull();
    expect(alphaFit('fade', 0.25, undefined, ours, new Uint8Array(ours.length))).toBeNull();
  });
});

describe(`(a) checkFrame: the per-frame checks of --export (the ticket's ±${ALPHA_TOLERANCE}, l.154; QE2)`, () => {
  // Uniform 8 x 8 frames, so every fit is exact. Fade at p 1/3: alpha = cos(pi / 3) = .5, fitted = .5 x theirs / mine with mine 200.
  // Dip at p .25: overlay alpha .5, colour [1, 0, 0] = (255, 0, 0); mine (155, 100, 100) = c + (-100, 100, 100), theirs = c + k (mine - c), fitted = 1 - .5 k.
  const frame = (rgb: number[]) => { const d = new Uint8Array(8 * 8 * 4); for (let i = 0; i < d.length; i++) d[i] = i % 4 === 3 ? 255 : rgb[i % 4]; return d; };
  const win = (kind: string, params?: Record<string, unknown>) => ({ id: 'w1', kind, fromId: 'a', toId: 'b', cut: 10000, pre: 500, post: 500, start: 9500, end: 10500, ...(params ? { params } : {}) }) as OurWindow;
  const fade = { w: win('fade'), p: 1 / 3 }, dip = { w: win('dipToColorDissolve', { color: [1, 0, 0] }), p: 0.25 };
  const alphaDiffs = (r: ReturnType<typeof checkFrame>) => r.diffs.filter(d => d.path.endsWith('.alpha'));
  const NOTE = (kind: string) => `least-squares ${kind} alpha off the formula by more than 0.06 (QE2)`;
  it('fade 0.05 off either way: alpha and fittedAlpha are reported, no .alpha diff', () => {
    for (const [v, fitted] of [[220, 0.55], [180, 0.45]]) {
      const r = checkFrame('frames/export/E.png', fade, frame([v, v, v]), frame([200, 200, 200]), 8, 8);
      expect(r.fields).toStrictEqual({ ssim: expect.any(Number), alpha: expect.closeTo(0.5, 12), fittedAlpha: expect.closeTo(fitted, 12) });
      expect(alphaDiffs(r)).toStrictEqual([]);
    }
  });
  it('fade 0.07 off either way: exactly one .alpha diff, expected the formula alpha and actual the fitted one', () => {
    for (const [v, fitted] of [[228, 0.57], [172, 0.43]]) {
      const r = checkFrame('frames/export/E.png', fade, frame([v, v, v]), frame([200, 200, 200]), 8, 8);
      expect(alphaDiffs(r)).toStrictEqual([{ part: 'frame', path: 'frames/export/E.png.alpha', expected: expect.closeTo(0.5, 12), actual: expect.closeTo(fitted, 12), note: NOTE('fade') }]);
    }
  });
  it('dip (colour [1, 0, 0]) 0.07 off: its .alpha diff; 0.05 off: none', () => {
    const mine = frame([155, 100, 100]);
    const off7 = checkFrame('frames/export/D.png', dip, frame([169, 86, 86]), mine, 8, 8);   // k .86, fitted .57
    expect(alphaDiffs(off7)).toStrictEqual([{ part: 'frame', path: 'frames/export/D.png.alpha', expected: expect.closeTo(0.5, 12), actual: expect.closeTo(0.57, 12), note: NOTE('dipToColorDissolve') }]);
    const off5 = checkFrame('frames/export/D.png', dip, frame([165, 90, 90]), mine, 8, 8);   // k .9, fitted .55
    expect(off5.fields).toStrictEqual({ ssim: expect.any(Number), alpha: expect.closeTo(0.5, 12), fittedAlpha: expect.closeTo(0.55, 12) });
    expect(alphaDiffs(off5)).toStrictEqual([]);
  });
  it('no window (hit undefined), the end point (p null) and another kind: ssim only, no alpha fit, no .alpha diff', () => {
    for (const hit of [undefined, { w: win('fade'), p: null }, { w: win('wipe'), p: 1 / 3 }]) {
      const r = checkFrame('frames/export/E.png', hit, frame([60, 60, 60]), frame([200, 200, 200]), 8, 8);
      expect(r.fields, JSON.stringify(hit)).toStrictEqual({ ssim: expect.any(Number) });
      expect(alphaDiffs(r)).toStrictEqual([]);
    }
  });
  it('an SSIM below the floor is its own diff before any alpha diff', () => {
    const r = checkFrame('frames/export/E.png', fade, frame([228, 228, 228]).map((v, i) => i % 4 === 3 ? v : (i * 37) % 256), frame([200, 200, 200]), 8, 8);
    expect(r.diffs[0]).toStrictEqual({ part: 'frame', path: 'frames/export/E.png.ssim', expected: '>= 0.98', actual: expect.any(Number), note: 'fade w1 at p 0.3333333333333333' });
    expect(r.diffs[0].actual as number).toBeLessThan(0.98);
  });
});

describe('(a) withPlaceholders: the replay\'s asset ids g08-S1-<n> / g08-S2c-<n> become @S1 / @S2c', () => {
  const doc = (...ids: (string | undefined)[]) => ({ items: ids.map((id, n) => ({ id: `i${n}`, ...(id === undefined ? {} : { metadata: { assetId: id, keep: true } }) })) }) as unknown as ProjectDocument;
  it('rewrites the ids, lists the fixtures used, leaves items without an asset alone and the input untouched', () => {
    const input = doc('g08-S1-1', 'g08-S2c-4', undefined, 'g08-S1-9');
    const r = withPlaceholders(input);
    expect(r.used).toStrictEqual(['S1', 'S2c']);
    expect(r.doc.items.map(i => i.metadata)).toStrictEqual([{ assetId: '@S1', keep: true }, { assetId: '@S2c', keep: true }, undefined, { assetId: '@S1', keep: true }]);
    expect(input.items[0].metadata!.assetId).toBe('g08-S1-1');
    expect(withPlaceholders(doc('g08-S1-1')).used).toStrictEqual(['S1']);
  });
  it('an asset that is neither S1 nor S2c is refused with the item and the id named', () => {
    refuses(() => withPlaceholders(doc('video_9')), 'Item i0 shows asset video_9; the G-08 export runs S1 and S2c only');
    refuses(() => withPlaceholders(doc('g08-S1-1', 'g08-S3-1')), 'Item i1 shows asset g08-S3-1; the G-08 export runs S1 and S2c only');
  });
});

// ---- (d) drawKey (apps/web/src/export/pipeline.ts): the incoming side of a transition pair whose outgoing side reads the same
// source gets its own decoder, key + ':to' (T11 performance fix), so one worker does not seek between two source times per frame.
describe('(d) drawKey: decoder key of a draw (written spec: <assetId>:original[:stacked][:to]; ":to" only for the incoming side whose partner reads the same source)', () => {
  const STACKED = { id: 'e1', effectId: 'stacked-alpha', enabled: true, order: 0, parameters: {} };
  const draw = (asset: string, tag?: { id: string; role: 'from' | 'to' }, effects: unknown[] = []) =>
    ({ item: { id: `${tag?.role ?? 'x'}-${asset}`, type: 'video', metadata: { assetId: asset }, effects }, kind: 'video', ...(tag ? { transition: { kind: 'fade', p: 0.5, ...tag } } : {}) }) as unknown as Draw;
  it('the same asset on both sides: the incoming draw gets ":to", the outgoing one does not', () => {
    const from = draw('a1', { id: 't1', role: 'from' }), to = draw('a1', { id: 't1', role: 'to' }), draws = [from, to];
    expect(drawKey(from, draws)).toBe('a1:original');
    expect(drawKey(to, draws)).toBe('a1:original:to');
  });
  it('different assets: plain keys on both sides', () => {
    const from = draw('a1', { id: 't1', role: 'from' }), to = draw('a2', { id: 't1', role: 'to' }), draws = [from, to];
    expect([drawKey(from, draws), drawKey(to, draws)]).toStrictEqual(['a1:original', 'a2:original']);
  });
  it('an incoming draw whose partner is missing, or belongs to another transition, is plain', () => {
    const to = draw('a1', { id: 't1', role: 'to' });
    expect(drawKey(to, [to])).toBe('a1:original');
    expect(drawKey(to, [to, draw('a1', { id: 't2', role: 'from' })])).toBe('a1:original');
    expect(drawKey(to, [to, draw('a1', { id: 't1', role: 'to' })])).toBe('a1:original');
  });
  it('stacked alpha keeps ":stacked" before ":to"; a stacked and a plain read of one asset are different sources', () => {
    const from = draw('a1', { id: 't1', role: 'from' }, [STACKED]), to = draw('a1', { id: 't1', role: 'to' }, [STACKED]);
    expect([drawKey(from, [from, to]), drawKey(to, [from, to])]).toStrictEqual(['a1:original:stacked', 'a1:original:stacked:to']);
    const plain = draw('a1', { id: 't1', role: 'to' });
    expect(drawKey(plain, [from, plain])).toBe('a1:original');
  });
  it('no transition: the plain key, even when another draw reads the same asset', () => {
    const a = draw('a1'), b = draw('a1', { id: 't1', role: 'from' });
    expect(drawKey(a, [a, b])).toBe('a1:original');
    expect(drawKey(b, [a, b])).toBe('a1:original');
  });
});

// ---- (c) CLI refusals: stderr of `tsx parity/cli.ts`, checked before any file is read.
describe('(c) CLI refusals (the arguments are checked before any file is read; stderr text is the runner\'s)', () => {
  const g08 = ['--golden', 'G-08', '--xapp-ref', 'nowhere', '--calls', 'nowhere.json', '--assets', 'nowhere.json', '--tool-field', 'tool', '--input-field', 'input'];
  const cli = (extra: string[], base = g08) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', ...base, ...extra], { encoding: 'utf8', timeout: 180_000 });
  const refused = (extra: string[], message: RegExp, base = g08) => { const r = cli(extra, base); expect(r.status, r.stdout).not.toBe(0); expect(r.stderr).toMatch(message); };
  const full = ['--export', '--frame-name', '^E-(\\d+)\\.png$', '--frame-time-unit', 'ms', '--windows', 'start=a,length=b,label=c,unit=s'];
  const NEEDS = /--export needs --frame-name <regex> \(group 1 = the frame time\), --frame-time-unit ms\|s\|frame and --windows start=<field>,length=<field>,label=<field>,unit=ms\|s\|frame\[,list=<key>\]: .*\(T00 harness runbook l\.50\)/;

  it('--export on G-01: the export options are G-08 options', () => {
    refused(['--export'], /--export, --frame-name, --windows, --media and --export-ffprobe are G-08 options/, ['--golden', 'G-01', ...g08.slice(2)]);
  });
  it('--frame-name without --export on G-08: only used with --export', () => {
    refused(['--frame-name', '^E-(\\d+)\\.png$'], /--frame-name, --frame-time-unit, --windows, --media and --export-ffprobe are only used with --export/);
    refused(['--frame-time-unit', 'ms'], /--frame-name, --frame-time-unit, --windows, --media and --export-ffprobe are only used with --export/);
  });
  it('--export without --windows (or --frame-name, or --frame-time-unit) names all three', () => {
    refused(['--export', '--frame-name', '^E-(\\d+)\\.png$', '--frame-time-unit', 'ms'], NEEDS);
    refused(['--export', '--frame-time-unit', 'ms', '--windows', 'start=a,length=b,label=c,unit=s'], NEEDS);
    refused(['--export', '--frame-name', '^E-(\\d+)\\.png$', '--windows', 'start=a,length=b,label=c,unit=s'], NEEDS);
  });
  it('--media X=f is refused: S1=<file> or S2c=<file> only', () => {
    refused([...full, '--media', 'X=f'], /--media takes S1=<file> or S2c=<file>/);
    refused([...full, '--media', 'S1'], /--media takes S1=<file> or S2c=<file>/);
  });
  it('--media S1= twice is refused', () => {
    refused([...full, '--media', 'S1=a.mp4', '--media', 'S1=b.mp4'], /--media S1 is given twice/);
  });
  it('--ot6-fade with --golden is refused', () => {
    refused(['--ot6-fade', 'export.mp4'], /Use --ot6-fade <export file> \[--output <dir>\] on its own/);
  });
  it('the G-01 / G-02 frame-unit messages are unchanged', () => {
    const g02 = ['--golden', 'G-02', ...g08.slice(2), '--item', 'clip-1'];
    refused(['--frames'], /--frames needs --frame-time-unit ms\|s\|frame: .*\(T00 harness runbook l\.50\)/, g02);
    refused(['--frame-time-unit', 's'], /--frame-time-unit is only used with --frames/, g02);
    refused(['--frames', '--frame-time-unit', 's'], /--item, --frames and --frame-time-unit are G-02 options/, ['--golden', 'G-01', ...g08.slice(2)]);
  });
});

// ---- (b) the synthetic round trip. A (S1) 0-10 s, B (S2c) 10-20 s, C (S1) 20-30 s, one wipe A -> B, 1 s centred on 10 s, from-left,
// softness 20, so the window is [9500, 10500) and the doc has 30 s x 30 fps = 900 frames. The stored PNGs sit at 9500 / 9750 / 10000
// / 10250 / 10500 ms, frames round(ms x 30 / 1000) = 285 / 293 / 300 / 308 / 315: frames 293 and 308 are t = 9766.667 / 10266.667 ms,
// so p = .26667 / .76667 (not .25 / .75), and 315 is the window's end point (p null, the 100 % frame).
describe('(b) synthetic G-08 export round trip (self-consistency of the runner and of our export, NOT Xapp parity)', () => {
  const T = 600_000, PLAN_FRAMES = 900;
  let root: string, ref: string, media: { S1: string; S2c: string }, w: Awaited<ReturnType<typeof writeSyntheticG08>>, x: Awaited<ReturnType<typeof writeSyntheticExportFrames>>;
  let good: Awaited<ReturnType<typeof runG08>> & { export?: any };
  const replay = (dir: string, out: string, o: { media?: Record<string, string>; assets?: Record<string, string>; probe?: string } = {}) =>
    runG08(dir, { calls: w.calls, assets: o.assets ?? w.assets, toolField: w.toolField, inputField: w.inputField, blockBase: w.blockBase, output: path.join(root, out), canvas: { width: 270, height: 480 },
      export: compareExport(dir, { frameName: x.frameName, frameUnit: x.frameUnit, windows: parseWindowSpec(x.windows), media: o.media ?? media, ...(o.probe === undefined ? {} : { exportProbe: o.probe }) }) }) as Promise<any>;
  const probe = (nb: number) => JSON.stringify({ streams: [{ codec_type: 'video', nb_frames: String(nb) }] });
  const copyOf = async (name: string) => { const dir = path.join(root, name); await cp(ref, dir, { recursive: true }); return dir; };
  const ffmpeg = (args: string[]) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw Error(`ffmpeg: ${r.stderr}`); };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'g08-t11-'));
    ref = path.join(root, 'ref');
    const dir = path.join(root, 'media'), tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
    const clip = ['-f', 'lavfi', '-i', 'testsrc2=size=270x480:rate=30:duration=10'], enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-bf', '0', '-pix_fmt', 'yuv420p', ...tags];
    await mkdir(dir, { recursive: true });
    media = { S1: path.join(dir, 'S1.mp4'), S2c: path.join(dir, 'S2c.mp4') };
    ffmpeg([...clip, ...enc, media.S1]);
    ffmpeg([...clip, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-vf', 'hue=h=120', ...enc, '-c:a', 'aac', '-shortest', media.S2c]);
    w = await writeSyntheticG08(ref);
    x = await writeSyntheticExportFrames(ref, { dir, S1: 'S1.mp4', S2c: 'S2c.mp4' }, { width: 270, height: 480 });
    await writeFile(path.join(ref, 'ffprobe.json'), probe(PLAN_FRAMES));
    good = await replay(ref, 'out-good', { probe: 'ffprobe.json' });
  }, T);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('1. the stored wipe frames pass: report passed, no diffs, the exact report.export shape, SSIM >= the floor on all 5 rows', () => {
    expect(good.status).toBe('uncompared'); // no step failed; C00 (captureFrame, the preview) is not compared by this replay (g08-synthetic.ts)
    expect(good.summary).toMatch(/; export at step X00 \(exportProject\): passed$/);
    const ex = good.export;
    expect(ex.diffs).toStrictEqual([]);
    const row = (file: string, frame: number, timeMs: number, p: number | null) =>
      ({ file, frame, timeMs, window: expect.any(String), kind: 'wipe', p: p === null ? null : expect.closeTo(p, 5), direction: 'from-left', size: [270, 480], ssim: expect.any(Number) });
    expect(ex).toStrictEqual({
      at: 'step X00 (exportProject)', status: 'passed', diffs: [],
      fps: 30, minSsim: 0.98, alphaTolerance: 0.06, windowTolerance: '1 frame (own, provisional)', frameName: x.frameName, frameUnit: 'ms',
      windows: { stored: 1, ours: 1, rows: [{ label: 'A-B wipe', startMs: 9500, lengthMs: 1000, ours: { id: expect.any(String), kind: 'wipe', direction: 'from-left', startMs: 9500, lengthMs: 1000 } }] },
      frameCount: { ours: PLAN_FRAMES, stored: PLAN_FRAMES },
      media: [{ name: 'S1', file: media.S1, bytes: expect.any(Number), sha256: expect.any(String), check: 'recorded, not checked (--media)' },
        { name: 'S2c', file: media.S2c, bytes: expect.any(Number), sha256: expect.any(String), check: 'recorded, not checked (--media)' }],
      frames: 5, byKind: { wipe: { frames: 5, minSsim: expect.any(Number), failed: 0 } },
      ranges: [{ range: [285, 315], file: expect.stringMatching(/frames-285-315\.mp4$/), error: null }],
      rows: [row('E-9500.png', 285, 9500, 0), row('E-9750.png', 293, 9766.667, 0.266667), row('E-10000.png', 300, 10000, 0.5), row('E-10250.png', 308, 10266.667, 0.766667), row('E-10500.png', 315, 10500, null)],
    });
    for (const r of ex.rows) expect(r.ssim, r.file).toBeGreaterThanOrEqual(MIN_SSIM);
  });

  it('2. one combined failing run: E-10000.png darkened to 0.8 (SSIM), E-31000.png past the end (frame 930 of 900), ffprobe says 899 frames: exactly those three diffs, report failed', async () => {
    const bad = await copyOf('ref-bad'), folder = path.join(bad, 'frames', 'export'), tmp = path.join(folder, 'dark.png');
    await cp(path.join(folder, 'E-10000.png'), path.join(folder, 'E-31000.png'));
    ffmpeg(['-i', path.join(folder, 'E-10000.png'), '-vf', 'colorchannelmixer=rr=.8:gg=.8:bb=.8', tmp]);
    await rename(tmp, path.join(folder, 'E-10000.png'));
    await writeFile(path.join(bad, 'ffprobe.json'), probe(PLAN_FRAMES - 1));
    const r = await replay(bad, 'out-bad', { probe: 'ffprobe.json' });
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/; export at step X00 \(exportProject\): 3 difference\(s\)$/);
    expect(r.export.status).toBe('failed');
    expect(r.export.diffs).toStrictEqual([
      { part: 'frame', path: 'exports.frameCount', expected: PLAN_FRAMES - 1, actual: PLAN_FRAMES, note: expect.stringContaining('ffprobe') },
      { part: 'frame', path: 'frames/export/E-31000.png', expected: 'frame 930', actual: null, note: `past the end of Cutframe's export (${PLAN_FRAMES} frames)` },
      { part: 'frame', path: 'frames/export/E-10000.png.ssim', expected: `>= ${MIN_SSIM}`, actual: expect.any(Number), note: expect.stringMatching(/^wipe .+ at p 0\.5$/) }]);
    expect(r.export.diffs[2].actual).toBeLessThan(MIN_SSIM);
    expect(r.export.frameCount).toStrictEqual({ ours: PLAN_FRAMES, stored: PLAN_FRAMES - 1 });
    expect(r.export.byKind.wipe).toStrictEqual({ frames: 5, minSsim: expect.any(Number), failed: 1 });
    expect(r.export.rows.map((q: { file: string }) => q.file)).not.toContain('E-31000.png');
  }, T);

  // The rest stop before the browser opens.
  it('3. no _windows.json: its error', async () => {
    const dir = await copyOf('ref-nowin');
    await rm(path.join(dir, 'frames', 'export', '_windows.json'));
    await expect(replay(dir, 'out-nowin')).rejects.toThrow(new Error('No frames/export/_windows.json'));
  }, T);
  it('4. S2c not given: the QE4 error (S2c is not in our fixture store)', async () => {
    await expect(replay(ref, 'out-nos2c', { media: { S1: media.S1 } })).rejects.toThrow(
      new Error('--media S2c=<file> is needed: S2c, the centre 9:16 crop of S2, is not in our fixture store (coordinator decision QE4)'));
  }, T);
  it('5. an unused --media: its error (the exported state has no clip of S2c when both assets are S1)', async () => {
    await expect(replay(ref, 'out-unused', { assets: { video_1: 'S1', video_2: 'S1' } })).rejects.toThrow(new Error('--media S2c: the exported state has no clip of S2c'));
  }, T);
  it('6. --export-ffprobe: a missing file, a file without a video stream, and a stream without a frame count are refused', async () => {
    const dir = await copyOf('ref-probe');
    await writeFile(path.join(dir, 'novideo.json'), JSON.stringify({ format: {}, streams: [{ codec_type: 'audio' }] }));
    await writeFile(path.join(dir, 'nocount.json'), JSON.stringify({ streams: [{ codec_type: 'video' }] }));
    await expect(replay(dir, 'out-p1', { probe: 'nope.json' })).rejects.toThrow(new Error(`--export-ffprobe: no file nope.json in ${dir}`));
    await expect(replay(dir, 'out-p2', { probe: 'novideo.json' })).rejects.toThrow(new Error('--export-ffprobe novideo.json has no video stream (its top-level keys: format, streams)'));
    await expect(replay(dir, 'out-p3', { probe: 'nocount.json' })).rejects.toThrow(new Error('--export-ffprobe nocount.json: the video stream has no nb_frames or nb_read_frames (its keys: codec_type)'));
  }, T);
  it('7. the ffprobe file is read from the reference directory only', async () => {
    await writeFile(path.join(root, 'outside.json'), probe(PLAN_FRAMES));
    await expect(replay(ref, 'out-esc', { probe: '../outside.json' })).rejects.toThrow(new Error('--export-ffprobe escapes the reference directory'));
    expect(await readFile(path.join(root, 'outside.json'), 'utf8')).toBe(probe(PLAN_FRAMES));
  }, T);
});
