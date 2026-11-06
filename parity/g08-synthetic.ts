// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic G-08 stored-reference folder for testing the replay support (parity/g08.ts) without Xapp captures.
// It is NOT the G-08 reference and says nothing about Xapp parity. It is a written-spec oracle: every stored result below is
// written by hand from agent tool results §2 (applyTransition: message forms, data.transition, the stored example's
// timelineChanges entry) and §11 (G-08: defaults, replace in place, update merges, a dissolve's direction dropped, the
// refusals and schema errors, no transition in the reads), not produced by the Cutframe code.
// Where the spec gives no text, the stored result leaves the field out, so it is not compared: the clamp sentence's tail, the
// nothing-removed sentence's cut, the refusal messages, the schema refusals' details, and `timelineChanges` of a replace or
// update (A0.3's `updated` entry is not shown in §2).
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from './normalise';
import type { G01Step } from './g01';
import { SYNTHETIC_FIELDS } from './g01-synthetic';
import { fixtureSource, oracleDeps } from './oracle/frame';
import { quantise8 } from './oracle/image';
import { addMedia, type Project } from './oracle/item';
import { renderFrame } from './oracle/render';

type Rec = { [key: string]: Json };
const TRACK = 'track_v1', A = 'clip-a', B = 'clip-b', C = 'clip-c', T1 = 'transition-1', T2 = 'transition-2';
const changes = (k: 'created' | 'deleted', entry: Rec) => ({ basis: 'observed_net_changes_during_call', transitions: { created: k === 'created' ? [entry] : [], updated: [], deleted: k === 'deleted' ? [entry] : [] } });
const entry = (id: string, fromId: string, toId: string, kind: string, duration: number, alignment: number): Rec => ({ id, trackId: TRACK, fromId, toId, kind, duration, alignment });
const refused = (error: string, code: string) => ({ success: false, error, code });
const schema = () => ({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for applyTransition' });

/** Writes `<dir>/results/*`, `<dir>/calls.json` and `<dir>/assets.json` (S1 as `video_1`, S2c as `video_2`). The timeline is
 *  A (S1) 0–10 s, B (S2c) 10–20 s, C (S1) 20–30 s on one video track; the replay learns every id from the stored results. */
export async function writeSyntheticG08(dir: string, o: { blockBase?: 0 | 1 } = {}) {
  const base = o.blockBase ?? 1, assets = { video_1: 'S1', video_2: 'S2c' };
  const files = new Map<string, Rec>(), steps: G01Step[] = [];
  const text = (blocks: string[]) => blocks.join('\n<<<BLOCK>>>\n');
  const store = (id: string, tool: string, input: Rec, result: Rec, form: 'text' | 'blocks' = 'text') => {
    const blocks = [`${tool} result`, JSON.stringify(result, null, 2)];
    files.set(id, { tool_name: tool, tool_input: input, ...(form === 'text' ? { result_text: text(blocks) } : { result_blocks: blocks }), notes: '' });
    steps.push(id);
  };
  const apply = (id: string, input: Rec, result: Rec, form: 'text' | 'blocks' = 'text') => store(id, 'applyTransition', input, result, form);
  const read = { success: true, data: { tracks: { [TRACK]: { kind: 'video', items: [{ id: A, start: 0, end: 10 }, { id: B, start: 10, end: 20 }, { id: C, start: 20, end: 30 }] } } } };

  store('S00', 'manageTrack', { action: 'create', kind: 'video' }, { success: true, data: { track: { id: TRACK, kind: 'video' } } });
  store('S01', 'addMedia', { trackId: TRACK, items: [{ assetId: 'video_1' }, { assetId: 'video_2' }, { assetId: 'video_1' }] }, { success: true, data: { addedItemIds: [A, B, C] } });

  // §11 defaults: fade, 1 s, centre. The §2 example: a 0.6 s dissolve, betweenItems in either order.
  apply('t01', { action: 'add', betweenItems: [A, B] }, { success: true, message: `Added fade transition (1.00s, center on the cut) on ${A} → ${B} at 10.00s.`,
    data: { transition: { kind: 'fade', durationSeconds: 1, alignment: 'center' } }, timelineChanges: changes('created', entry(T1, A, B, 'fade', 1, 0.5)) });
  apply('t02', { action: 'add', betweenItems: [C, B], kind: 'dissolve', durationSeconds: 0.6 }, { success: true, message: `Added dissolve transition (0.60s, center on the cut) on ${B} → ${C} at 20.00s.`,
    data: { transition: { kind: 'dissolve', durationSeconds: 0.6, alignment: 'center' } }, timelineChanges: changes('created', entry(T2, B, C, 'dissolve', 0.6, 0.5)) }, 'blocks');
  // §11: no transition is visible to the reads.
  store('R00', 'context', {}, read);
  // §11: re-adding replaces in place (keeps its id); update merges only the given fields; add and update clamp (3000 ms cap).
  apply('t03', { action: 'add', betweenItems: [A, B], kind: 'slide', durationSeconds: 2, alignment: 'end', direction: 'from-top' }, { success: true,
    message: `Replaced slide transition (2.00s, end on the cut) on ${A} → ${B} at 10.00s.`, data: { transition: { kind: 'slide', durationSeconds: 2, alignment: 'end', direction: 'from-top' } } });
  apply('t04', { action: 'update', betweenItems: [A, B], durationSeconds: 5 }, { success: true, data: { transition: { kind: 'slide', durationSeconds: 3, alignment: 'end', direction: 'from-top' } } });
  // atSeconds within 0.5 s of the cut; a wipe without a direction defaults to from-left; softness only in params (§11).
  apply('t05', { action: 'add', atSeconds: 10.3, kind: 'wipe', params: { softness: 20 } }, { success: true, message: `Replaced wipe transition (1.00s, center on the cut) on ${A} → ${B} at 10.00s.`,
    data: { transition: { kind: 'wipe', durationSeconds: 1, alignment: 'center', direction: 'from-left', params: { softness: 20 } } } });
  // A direction on a dissolve is accepted and dropped (§11).
  apply('p01', { action: 'add', betweenItems: [B, C], kind: 'dissolve', direction: 'from-right' }, { success: true, message: `Replaced dissolve transition (1.00s, center on the cut) on ${B} → ${C} at 20.00s.`,
    data: { transition: { kind: 'dissolve', durationSeconds: 1, alignment: 'center' } } });
  // remove: the deleted record in timelineChanges (§11); a second remove still succeeds (§2).
  apply('t06', { action: 'remove', betweenItems: [B, C] }, { success: true, message: `Removed the dissolve transition on ${B} → ${C} at 20.00s.`, timelineChanges: changes('deleted', entry(T2, B, C, 'dissolve', 1, 0.5)) });
  apply('t07', { action: 'remove', betweenItems: [B, C] }, { success: true });
  store('R01', 'context', {}, read, 'blocks');
  // Refusals (§2 failures, §11).
  apply('e01', { action: 'update', betweenItems: [B, C], kind: 'fade' }, refused('No transition', 'TRANSITION_NOT_FOUND'));
  apply('e02', { action: 'add', betweenItems: [A, C] }, refused('Cut not resolved', 'INVALID_PAIR'));
  apply('e03', { action: 'add', atSeconds: 15 }, refused('Cut not resolved', 'CUT_NOT_FOUND'));
  // Schema errors before anything changes (§11): both address forms, neither, durationSeconds 0, an unknown kind or direction.
  apply('e04', { action: 'add', betweenItems: [B, C], atSeconds: 20 }, schema());
  apply('e05', { action: 'add' }, schema());
  apply('e06', { action: 'add', betweenItems: [B, C], durationSeconds: 0 }, schema());
  apply('e07', { action: 'add', betweenItems: [B, C], kind: 'zoom' }, schema());
  apply('e08', { action: 'add', betweenItems: [B, C], kind: 'slide', direction: 'diagonal' }, schema());
  // Not compared by this replay: the preview capture (T11 notes). The export is compared with --export (writeSyntheticExportFrames).
  store('C00', 'captureFrame', { timestamps: [10] }, { success: true, data: { frames: 1 } });
  store('X00', 'exportProject', {}, { success: true });

  const calls = [steps];
  await mkdir(path.join(dir, 'results'), { recursive: true });
  for (const [id, record] of files) await writeFile(path.join(dir, 'results', `${id}.json`), JSON.stringify(record, null, 2));
  await writeFile(path.join(dir, 'calls.json'), JSON.stringify(calls, null, 2));
  await writeFile(path.join(dir, 'assets.json'), JSON.stringify(assets, null, 2));
  return { calls, assets, ...SYNTHETIC_FIELDS, blockBase: base };
}

// ---- frames/export/ for `--export` (parity/g08-export.ts), in the stored layout of results §11: PNGs at 0 / 25 / 50 / 75 /
// 100 % of every window, frame index round(t × 30), and _windows.json. The state is the one writeSyntheticG08 leaves at X00,
// written here by hand: A (S1) 0–10 s, B (S2c) 10–20 s, C (S1) 20–30 s, each a 1080 × 1920 clip (the replay's asset size,
// parity/g08.ts MEDIA) placed by the contain fit of §53.1.3 (oracle addMedia), and one wipe A → B, 1 s centred on 10 s,
// from-left, softness 20 (t05; B → C removed by t06). `size` is the canvas, 1080 × 1920 unless the replay was given another
// (G08Options.canvas); the PNGs are written at that size. The pixels come from the T00 oracle (parity/oracle renderFrame), not
// from Cutframe. The names and the _windows.json schema are this file's own (the stored ones are not documented, T00 runbook
// l.50); the flags that read them are returned.
const clip = (id: string, file: string, from: number, size: { width: number; height: number }): Json => ({ id, type: 'video', trackId: TRACK, display: { from, to: from + 10000 }, trim: { from: 0, to: 10000 }, sourceDuration: 10000,
  details: { src: `fixture://${file}` }, properties: Object.fromEntries(Object.entries({ ...addMedia(1080, 1920, size.width, size.height), width: 1080, height: 1920 }).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }])) });
export const SYNTHETIC_EXPORT = { frameName: '^E-(\\d+)\\.png$', frameUnit: 'ms' as const, windows: 'start=startS,length=lengthS,label=label,unit=s,list=windows' };
/** Writes <dir>/frames/export/E-<ms>.png and _windows.json; `media` holds the S1 and S2c files (10 s, 9:16, 30 fps). */
export async function writeSyntheticExportFrames(dir: string, media: { dir: string; S1: string; S2c: string }, size = { width: 1080, height: 1920 }) {
  const project = { fps: 30, size: { ...size }, duration: 30000, background: { type: 'color', value: 'transparent' }, tracks: [{ id: TRACK, kind: 'video' }], layerOrder: [{ type: 'track', id: TRACK }],
    items: [clip(A, media.S1, 0, size), clip(B, media.S2c, 10000, size), clip(C, media.S1, 20000, size)],
    transitions: [{ id: T1, trackId: TRACK, fromId: A, toId: B, kind: 'wipe', durationMs: 1000, alignment: 0.5, direction: 'from-left', params: { softness: 20 } }] } as unknown as Project;
  const folder = path.join(dir, 'frames', 'export'), deps = oracleDeps(fixtureSource(media.dir), { exportColour: true }), start = 9500, length = 1000, written: string[] = [];
  await mkdir(folder, { recursive: true });
  for (const at of [0, 0.25, 0.5, 0.75, 1]) {
    const ms = start + at * length, frame = Math.round(ms * 30 / 1000), name = `E-${ms}.png`;
    const rgba = quantise8(renderFrame(project, frame * 1000 / 30, deps));
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${size.height}`, '-i', '-', path.join(folder, name)], { input: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) });
    if (r.status !== 0) throw Error(`ffmpeg ${name}: ${String(r.stderr ?? r.error)}`);
    written.push(name);
  }
  await writeFile(path.join(folder, '_windows.json'), JSON.stringify({ windows: [{ label: 'A-B wipe', startS: start / 1000, lengthS: length / 1000 }] }, null, 2));
  return { ...SYNTHETIC_EXPORT, frames: written };
}
