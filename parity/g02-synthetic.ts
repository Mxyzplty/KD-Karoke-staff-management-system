// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic G-02 stored-reference folder for testing the replay support (parity/g02.ts) without Xapp captures.
// It is NOT the G-02 reference and says nothing about Xapp parity. Unlike g01-synthetic.ts it is a written-spec oracle:
// every stored result and keyframes object below is written by hand from agent tool results §6 (G-02), the setTimeRemap
// block of §2, error codes l.163–166 and tickets T04 (G-02 boundary outcomes), not produced by the Cutframe code.
// Provisional choices, not Xapp parity (the spec gives no value): the `source` labels of resolvedKeyframes
// (value / delta / factor / hold); the `error` strings of INVALID_BEZIER_HANDLE and TIME_OUT_OF_BOUNDS; a bezier easing
// read back as the input object; the reason text of the schema refusals (only their path and code are compared, and
// only on the emulated TYPE case; the others are deferred to T18).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from './normalise';
import type { G01Step } from './g01';
import { SYNTHETIC_FIELDS } from './g01-synthetic';

type Rec = { [key: string]: Json };
const kf = (timelineSeconds: number, value: number, easing: Json = 'linear', extra: Rec = {}): Rec => ({ timelineSeconds, value, easing, ...extra });
const curve = (defaultValue: number, ...keyframes: Rec[]): Rec => ({ defaultValue, keyframeCount: keyframes.length, keyframes });
const ITEM = 'clip-1', TRACK = 'track_a2f3';
const BEZIER = { type: 'bezier', points: [0.25, 0.1, 0.25, 1] };
const SCHEMA = (tool: string, at: string, code: string, reason: string) => ({ success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: `${at}: ${reason}`, details: { errors: [{ path: at, code, message: reason }] } });
const remapMessage = (n: number, mode: 'replaced' | 'merged', min: string, max: string) => `Set ${n} time remap keyframes on '${ITEM}' (${mode}). Speed range: ${min}x – ${max}x.`;

/** Writes `<dir>/results/*`, `<dir>/calls.json` and `<dir>/assets.json`. `setup: 'item'` (default) leaves S1's placement to
 *  `--item clip-1`; `'calls'` stores a manageTrack + addMedia pair first, so the replay learns the ids from the results.
 *  `frames: true` also stores C00, a high-quality captureFrame before the time remap (state F1), for the frames runner;
 *  the folder's frames/ is the caller's (parity/g02-frames.ts renderCaptures). */
export async function writeSyntheticG02(dir: string, o: { blockBase?: 0 | 1; setup?: 'item' | 'calls'; frames?: boolean } = {}) {
  const base = o.blockBase ?? 1, setup = o.setup ?? 'item', assets = { video_1: 'S1' };
  const files = new Map<string, Rec>(), steps: G01Step[] = [];
  const text = (blocks: string[]) => blocks.join('\n<<<BLOCK>>>\n');
  const store = (id: string, tool: string, input: Rec, result: Rec, form: 'text' | 'blocks' = 'text', stringInput = false) => {
    const blocks = [`${tool} result`, JSON.stringify(result, null, 2)];
    files.set(id, { tool_name: tool, tool_input: stringInput ? JSON.stringify(input) : input, ...(form === 'text' ? { result_text: text(blocks) } : { result_blocks: blocks }), notes: '' });
    steps.push(id);
  };
  // The item's whole keyframes object after each step, kept by hand.
  const kfs: Rec = {};
  const details = () => ({ success: true, data: { results: [{ id: ITEM, type: 'video', startTime: 0, endTime: 10, ...(Object.keys(kfs).length ? { keyframes: structuredClone(kfs) } : { keyframes: null, keyframesNote: 'No keyframes on this item' }) }] } });
  const vid = (id: string) => files.set(`${id}.vid`, { result_text: text([`viewItemDetails after ${id}`, JSON.stringify(details())]), notes: '' });
  const write = (id: string, payload: Rec, result: Rec = { success: true, data: { itemId: ITEM } }, form: 'text' | 'blocks' = 'text') => store(id, 'writeKeyframes', { itemId: ITEM, payload }, result, form);
  const remove = (t: number) => ({ success: false, code: 'REMOVE_TIME_NOT_FOUND', error: 'No keyframes at remove times', message: `For 'borderWidth', no keyframes found at ${t}s (100ms tolerance). Available: 1.000s, 3.000s, 6.000s.` });

  if (setup === 'calls') {
    store('S00', 'manageTrack', { action: 'create', kind: 'video' }, { success: true, data: { track: { id: TRACK, kind: 'video' } } });
    store('S01', 'addMedia', { trackId: TRACK, items: [{ assetId: 'video_1' }] }, { success: true, data: { addedItemIds: [ITEM] } });
  }
  store('R00', 'viewItemDetails', { itemIds: [ITEM] }, details());

  // Value modes on positionY (§6: 0 → 400 over 0–8 s, linear). Add appends, so K05's stored order is not sorted.
  write('K01', { positionY: { replace: [{ time: 0, value: 0 }, { time: 8, value: 400 }] } });
  kfs.positionY = curve(0, kf(0, 0), kf(8, 400)); vid('K01');
  write('K02', { positionY: { add: [{ time: 1, value: 100 }] } }, { success: true, data: { itemId: ITEM, resolvedKeyframes: { positionY: [{ time: 1, value: 100, source: 'value' }] } } });
  write('K03', { positionY: { add: [{ time: 3, delta: 50 }] } }, { success: true, data: { itemId: ITEM, resolvedKeyframes: { positionY: [{ time: 3, value: 235.71428571428572, source: 'delta' }] } } }, 'blocks');
  write('K04', { positionY: { add: [{ time: 5, factor: 0.5 }] } }, { success: true, data: { itemId: ITEM, resolvedKeyframes: { positionY: [{ time: 5, value: 150.71428571428572, source: 'factor' }] } } });
  write('K05', { positionY: { add: [{ time: 7 }] } }, { success: true, data: { itemId: ITEM, resolvedKeyframes: { positionY: [{ time: 7, value: 316.9047619047619, source: 'hold' }] } } });
  kfs.positionY = curve(0, kf(0, 0), kf(8, 400), kf(1, 100), kf(3, 235.71428571428572), kf(5, 150.71428571428572), kf(7, 316.9047619047619)); vid('K05');

  // Tickets T04 boundary outcomes, after whole-ms rounding (§6 corrections table).
  write('K10', { opacity: { replace: [{ time: 1, value: 1 }, { time: 3, value: 0.5 }, { time: 6, value: 0 }] } });
  kfs.opacity = curve(1, kf(1, 1), kf(3, 0.5), kf(6, 0)); vid('K10');
  write('K11', { opacity: { add: [{ time: 1.003999, value: 0.9 }, { time: 3.004, value: 0.4 }, { time: 6.004001, value: 0.1 }] } },
    { success: true, data: { itemId: ITEM, resolvedKeyframes: { opacity: [{ time: 1.003999, value: 0.9, source: 'value' }, { time: 3.004, value: 0.4, source: 'value' }, { time: 6.004001, value: 0.1, source: 'value' }] } } });
  kfs.opacity = curve(1, kf(1, 1), kf(3, 0.5), kf(6, 0), kf(1.004, 0.9), kf(3.004, 0.4), kf(6.004, 0.1)); vid('K11');
  write('K20', { positionX: { replace: [{ time: 1, value: 10 }, { time: 3, value: 20 }, { time: 6, value: 30 }] } });
  kfs.positionX = curve(0, kf(1, 10), kf(3, 20), kf(6, 30)); vid('K20');
  write('K21', { positionX: { update: [{ time: 1.099999, value: 11 }, { time: 3.1, value: 21 }, { time: 6.100001, value: 31 }] } });
  kfs.positionX = curve(0, kf(1, 10), kf(3, 20), kf(6, 30), kf(1.1, 11), kf(3.1, 21), kf(6.1, 31)); vid('K21');
  write('K30', { scale: { replace: [{ time: 1, value: 1 }, { time: 7.125, value: 1.5 }] } });
  kfs.scale = curve(1, kf(1, 1), kf(7.125, 1.5)); vid('K30');
  write('K31', { scale: { update: [{ time: 7.0625, value: 2 }] } });
  kfs.scale = curve(1, kf(1, 1), kf(7.125, 2)); vid('K31');
  write('K40', { rotation: { replace: [{ time: 1, value: 0 }, { time: 3, value: 10 }, { time: 6, value: 20 }] } });
  kfs.rotation = curve(0, kf(1, 0), kf(3, 10), kf(6, 20)); vid('K40');
  write('K41', { rotation: { add: [{ time: 9, value: 30 }], update: [{ time: 9.05, value: 40 }] } });
  kfs.rotation = curve(0, kf(1, 0), kf(3, 10), kf(6, 20), kf(9, 30), kf(9.05, 40)); vid('K41');
  write('K50', { borderWidth: { replace: [{ time: 1, value: 1 }, { time: 3, value: 2 }, { time: 6, value: 3 }] } });
  kfs.borderWidth = curve(0, kf(1, 1), kf(3, 2), kf(6, 3)); vid('K50');
  write('K51', { borderWidth: { remove: [3.1] } }, remove(3.1)); vid('K51');
  write('K52', { borderWidth: { remove: [1.099999] } }, remove(1.099999)); vid('K52');
  write('K53', { borderWidth: { remove: [6.100001] } }, remove(6.100001)); vid('K53');

  // Bezier handles (§6 storage) and the handler refusals G-02 returned as predicted.
  write('K60', { blur: { replace: [{ time: 0, value: 0, outHandle: [0.25, 0.1] }, { time: 4, value: 10, inHandle: [0.25, 1] }] } });
  kfs.blur = curve(0, kf(0, 0, 'linear', { outHandle: [0.25, 0.1] }), kf(4, 10, 'linear', { inHandle: [0.25, 1] })); vid('K60');
  write('K61', { blur: { add: [{ time: 2, value: 5, outHandle: [1.5, 0] }] } }, { success: false, code: 'INVALID_BEZIER_HANDLE', error: 'Invalid bezier handle', message: '[blur.add[0]] outHandle must be [x, y] with x from 0 to 1 and y from -100 to 100.' }); vid('K61');
  write('K62', { blur: { add: [{ time: 12, value: 5 }] } }, { success: false, code: 'TIME_OUT_OF_BOUNDS', error: 'Keyframe time out of bounds', message: '[blur.add[0]] keyframe at 12s outside item bounds (0s - 10s).' }); vid('K62');
  // A schema refusal (§6: an empty operation object is MINPROPERTIES): deferred to T18; the next read proves nothing changed.
  write('K70', { positionY: {} }, SCHEMA('writeKeyframes', '$.payload.positionY', 'MINPROPERTIES', 'must NOT have fewer than 1 properties'));
  store('R01', 'viewItemDetails', { itemIds: [ITEM] }, details(), 'blocks');
  // The one schema refusal the handler emulates (a non-array operation, TYPE): compared in full.
  write('K72', { positionY: { add: 'x' } }, SCHEMA('writeKeyframes', '$.payload.positionY.add', 'TYPE', 'must be array')); vid('K72');
  if (o.frames) store('C00', 'captureFrame', { timestamps: [0, 0.5], quality: 'high' }, { success: true, data: { frames: 2 } });

  // setTimeRemap (§6; §2 setTimeRemap message).
  const remap = (id: string, input: Rec, result: Rec, stringInput = false) => store(id, 'setTimeRemap', { itemId: ITEM, ...input }, result, 'text', stringInput);
  const remapData = (mode: 'replace' | 'merge', set: number, total: number, min: number, max: number, warnings?: string[]) =>
    ({ itemId: ITEM, mode, keyframesSet: set, totalKeyframesInTrack: total, clipDuration: 10, sourceDuration: 10, speedRange: { min, max }, ...(warnings ? { warnings } : {}) });
  const clamp = 'Keyframe at 10s maps to source 12000ms but source duration is only 10000ms. The value will be clamped during playback.';
  remap('T01', { keyframes: [{ time: 0, value: 0 }, { time: 10, value: 12000 }] }, { success: true, message: `${remapMessage(2, 'replaced', '0.000', '1.200')} Warnings: ${clamp}`, data: remapData('replace', 2, 2, 0, 1.2, [clamp]) });
  kfs.timeRemap = curve(0, kf(0, 0), kf(10, 12000)); vid('T01');
  const shaped: Json = [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 5, value: 8000, easing: BEZIER }, { time: 10, value: 2000 }];
  remap('T02', { keyframes: shaped }, { success: true, message: remapMessage(3, 'replaced', '0.000', '2.759'), data: remapData('replace', 3, 3, 0, 2.759) }, true);
  kfs.timeRemap = curve(0, kf(0, 0, 'easeInOut'), kf(5, 8000, BEZIER), kf(10, 2000)); vid('T02');
  remap('T03', { keyframes: [{ time: 5.05, value: 8500 }], replace: false }, { success: true, message: remapMessage(1, 'merged', '0.001', '2.931'), data: remapData('merge', 1, 3, 0.001, 2.931) });
  kfs.timeRemap = curve(0, kf(0, 0, 'easeInOut'), kf(5, 8500), kf(10, 2000)); vid('T03');
  remap('T04', { keyframes: shaped }, { success: true, message: remapMessage(3, 'replaced', '0.000', '2.759'), data: remapData('replace', 3, 3, 0, 2.759) });
  kfs.timeRemap = curve(0, kf(0, 0, 'easeInOut'), kf(5, 8000, BEZIER), kf(10, 2000)); vid('T04');
  remap('T05', { keyframes: [{ time: 15, value: 5000 }] }, { success: false, code: 'TIME_OUT_OF_BOUNDS', error: 'Keyframe time out of bounds', message: '[keyframes[0]] keyframe at 15s outside clip bounds (0.000s – 10.000s).' }); vid('T05');
  remap('T06', { keyframes: [] }, SCHEMA('setTimeRemap', '$.keyframes', 'MINITEMS', 'must NOT have fewer than 1 items'));
  // R02: the read after T06, stored as @@SAME references to T04.vid's blocks (nothing changed since T04).
  files.set('R02', { tool_name: 'viewItemDetails', tool_input: { itemIds: [ITEM] }, result_text: text([`@@SAME:T04.vid#${base}`, `@@SAME:T04.vid.json#${base + 1}`]), notes: '' }); steps.push('R02');
  // Frames and the export: T15 / T16 compare them.
  store('C01', 'captureFrame', { timestamps: [0.516667, 0.75] }, { success: true, data: { frames: 2 } });
  store('E01', 'exportProject', { format: 'mp4' }, { success: true, data: { status: 'queued' } });

  const calls = [steps];
  await mkdir(path.join(dir, 'results'), { recursive: true });
  for (const [id, record] of files) await writeFile(path.join(dir, 'results', `${id}.json`), JSON.stringify(record, null, 2));
  await writeFile(path.join(dir, 'calls.json'), JSON.stringify(calls, null, 2));
  await writeFile(path.join(dir, 'assets.json'), JSON.stringify(assets, null, 2));
  return { calls, assets, ...SYNTHETIC_FIELDS, ...(setup === 'item' ? { item: ITEM } : {}), blockBase: base };
}
