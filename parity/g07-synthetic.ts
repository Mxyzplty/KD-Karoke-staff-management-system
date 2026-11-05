// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic G-07 stored-reference folder for testing the replay support (parity/g07.ts) without Xapp captures.
// It is NOT the G-07 reference and says nothing about Xapp parity. It is a written-spec oracle: every stored result and
// effects block below is written by hand from agent tool results §9 (G-07) and l.1350 (the effects block), contracts #29
// (writeEffects) and error codes §7, not produced by the Cutframe code.
// Provisional choices, not Xapp parity (the spec gives no value): the writeEffects success envelope
// `data.items[{itemId, added, effects, effectsNote}]`; Xapp's block for a lut that received `.cube` text through the agent
// (no parameters listed: lutData treated as internal, no lutName derived, since Xapp stores the text verbatim); the `error`
// string of EFFECT_NOT_FOUND; the schema refusal's reason text (only its path and code are compared, and it is deferred to T18).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from './normalise';
import type { G01Step } from './g01';
import { SYNTHETIC_FIELDS } from './g01-synthetic';

type Rec = { [key: string]: Json };
const ITEM = 'clip-1', TRACK = 'track_a2f3', NOTE = 'Only non-default parameters shown. Use getEffectDetails() for full schemas.';
/** A 2³ `.cube` (TITLE "Synthetic warm"), sent as text: Cutframe bakes it (results §9 decision 1). */
export const SYNTHETIC_CUBE = ['TITLE "Synthetic warm"', 'LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n');
const fx = (type: string, name: string, n: number, parameters: Rec = {}, enabled = true): Rec =>
  ({ effectId: `${type}_${n + 1}`, effectType: type, name, enabled, order: n, ...(Object.keys(parameters).length ? { parameters } : {}) });

/** Writes `<dir>/results/*`, `<dir>/calls.json` and `<dir>/assets.json` (S3a as `image_1`); the replay learns the item and
 *  track ids from the stored manageTrack / addMedia results. */
export async function writeSyntheticG07(dir: string, o: { blockBase?: 0 | 1 } = {}) {
  const base = o.blockBase ?? 1, assets = { image_1: 'S3a' };
  const files = new Map<string, Rec>(), steps: G01Step[] = [];
  const text = (blocks: string[]) => blocks.join('\n<<<BLOCK>>>\n');
  const store = (id: string, tool: string, input: Rec, result: Rec, form: 'text' | 'blocks' = 'text') => {
    const blocks = [`${tool} result`, JSON.stringify(result, null, 2)];
    files.set(id, { tool_name: tool, tool_input: input, ...(form === 'text' ? { result_text: text(blocks) } : { result_blocks: blocks }), notes: '' });
    steps.push(id);
  };
  // The item's agent-facing effects block after each step, kept by hand (l.1350: agent ids by 1-based stack position).
  let stack: Rec[] = [];
  const block = () => stack.length ? { effects: structuredClone(stack), effectsNote: NOTE } : { effects: null, effectsNote: 'No effects on this item' };
  const details = () => ({ success: true, data: { results: [{ id: ITEM, type: 'image', startTime: 0, endTime: 3, ...block() }] } });
  const vid = (id: string) => files.set(`${id}.vid`, { result_text: text([`viewItemDetails after ${id}`, JSON.stringify(details())]), notes: '' });
  const ok = (added: string[]) => ({ success: true, data: { itemIds: [ITEM], items: [{ itemId: ITEM, added, ...block() }] } });
  const write = (id: string, input: Rec, result: () => Rec, form: 'text' | 'blocks' = 'text') => store(id, 'writeEffects', { itemId: ITEM, ...input }, result(), form);

  store('S00', 'manageTrack', { action: 'create', kind: 'video' }, { success: true, data: { track: { id: TRACK, kind: 'video' } } });
  store('S01', 'addMedia', { trackId: TRACK, items: [{ assetId: 'image_1' }] }, { success: true, data: { addedItemIds: [ITEM] } });
  store('R00', 'viewItemDetails', { itemIds: [ITEM], include: ['effects'] }, details());

  // Agent ids and the re-added curves effect (§9: it became curves_2).
  stack = [fx('grayscale', 'Grayscale', 0, { amount: { value: 80 } })];
  write('E01', { add: [{ effectId: 'grayscale', initialParameters: { amount: 80 } }] }, () => ok(['grayscale_1'])); vid('E01');
  stack.push(fx('curves', 'Curves', 1));
  write('E02', { add: [{ effectId: 'curves' }] }, () => ok(['curves_2'])); vid('E02');
  stack.pop();
  write('E03', { effects: { curves_2: { remove: true } } }, () => ok([])); vid('E03');
  stack.push(fx('curves', 'Curves', 1));
  write('E04', { add: [{ effectId: 'curves' }] }, () => ok(['curves_2']), 'blocks'); vid('E04');
  // Enum strings and the polar wheel value (§9: accepted).
  stack.push(fx('power-window', 'Power Window', 2, { shape: { value: 'rectangle' } }), fx('luma-key', 'Luma Key', 3, { keyType: { value: 'bright' } }));
  write('E05', { add: [{ effectId: 'power-window', initialParameters: { shape: 'rectangle' } }, { effectId: 'luma-key', initialParameters: { keyType: 'bright' } }] }, () => ok(['power-window_3', 'luma-key_4'])); vid('E05');
  stack.push(fx('color-wheels', 'Color Wheels', 4, { shadowsWheel: { value: { angle: 120, distance: 0.5 } } }));
  write('E06', { add: [{ effectId: 'color-wheels', initialParameters: { shadowsWheel: { angle: 120, distance: 0.5 } } }] }, () => ok(['color-wheels_5'])); vid('E06');
  // Colour parameters: rgba() refused (§9 corrections table; error codes §7 error text), 8-digit hex accepted.
  write('E07', { add: [{ effectId: 'color-key', initialParameters: { keyColor: 'rgba(0, 255, 0, 1)' } }] }, () => ({ success: false, code: 'INVALID_PARAM_VALUE', error: 'Invalid parameter value' })); vid('E07');
  stack.push(fx('drop-shadow', 'Drop Shadow', 5, { color: { value: '#00000080' } }));
  write('E08', { add: [{ effectId: 'drop-shadow', initialParameters: { color: '#00000080' } }] }, () => ok(['drop-shadow_6'])); vid('E08');
  // `.cube` text through the agent: Xapp stores it verbatim (§9); Cutframe bakes it and names the LUT from its TITLE.
  stack.push(fx('lut', 'LUT', 6));
  write('E09', { add: [{ effectId: 'lut', initialParameters: { lutData: SYNTHETIC_CUBE } }] }, () => ok(['lut_7'])); vid('E09');
  // EFFECT_NOT_FOUND with the available ids (error codes §7 message).
  write('E10', { effects: { vignette_1: { enabled: false } } }, () => ({ success: false, code: 'EFFECT_NOT_FOUND', error: 'Effect not found',
    message: "Effect 'vignette_1' not on this item. Available: grayscale_1, curves_2, power-window_3, luma-key_4, color-wheels_5, drop-shadow_6, lut_7" })); vid('E10');
  // Toggle and edit in one entry (contracts #29).
  stack[0] = fx('grayscale', 'Grayscale', 0, { amount: { value: 20 } }, false);
  write('E11', { effects: { grayscale_1: { enabled: false, params: { amount: 20 } } } }, () => ok([])); vid('E11');
  // A schema refusal: deferred to T18; the read after it proves nothing changed.
  write('E12', { add: 'x' }, () => ({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for writeEffects', message: '$.add: must be array', details: { errors: [{ path: '$.add', code: 'TYPE', message: 'must be array' }] } }));
  // R01: the read after E12, stored as @@SAME references to E11.vid's blocks (nothing changed since E11).
  files.set('R01', { tool_name: 'viewItemDetails', tool_input: { itemIds: [ITEM], include: ['effects'] }, result_text: text([`@@SAME:E11.vid#${base}`, `@@SAME:E11.vid.json#${base + 1}`]), notes: '' }); steps.push('R01');
  // Registry reads (T18) and frames (not compared by this replay).
  store('G00', 'getEffectDetails', { effectId: 'grayscale' }, { success: true, data: { id: 'grayscale', name: 'Grayscale' } });
  store('C00', 'captureFrame', { timestamps: [1.0167], quality: 'high' }, { success: true, data: { frames: 1 } });

  const calls = [steps];
  await mkdir(path.join(dir, 'results'), { recursive: true });
  for (const [id, record] of files) await writeFile(path.join(dir, 'results', `${id}.json`), JSON.stringify(record, null, 2));
  await writeFile(path.join(dir, 'calls.json'), JSON.stringify(calls, null, 2));
  await writeFile(path.join(dir, 'assets.json'), JSON.stringify(assets, null, 2));
  return { calls, assets, ...SYNTHETIC_FIELDS, blockBase: base };
}
