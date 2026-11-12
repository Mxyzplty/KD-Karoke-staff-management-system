// SPDX-License-Identifier: AGPL-3.0-only
// T05 text items on the T03 command path: the agent tool addText (contracts addText; results §2 addText, failures in that
// order; error codes §4–§5) and the UI's Add text preset (findings part 2 §40; W3-ED-22), both measured on a canvas. The
// font load the agent path awaits first is in text/agent.ts; this module stays free of font files so the timeline tools
// and the Node scripts can import it.
import type { ProjectDocument, RecordData } from '../store/model';
import { fpsOf, projectSize } from '../render/model';
import { fontSizePx } from '../render/text-layout';
import { overlap } from '../mg/tools';
import { canInsertAfter, insertAfter } from '../timeline/items';
import { blockers, CommandError, fail, fmt, insertTrack, item, itemsOn, newId, newTrack, stack, toMs, track, trackLocked } from '../timeline/model';
import { storedProperties } from '../timeline/properties';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { checkAnimation } from './animation';
import { findFont, resolveFont } from './font-registry';
import { defaultFont } from '../templates/model';
import { checkLook, lookFallbacks } from './looks';
import { measureContext, measuredSize } from './measure';
import { checkTextProperty, fontNotFoundText, writeFont } from './properties';
import { textStyle } from './style';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
const s3 = (ms: number) => Math.round(ms) / 1000;
/** Agent defaults (contracts addText; tickets T05): 100 px, wrap width 60 % of the canvas, 3 s when duration is missing. */
export const AGENT_TEXT = { fontSize: 100, widthShare: 0.6, durationMs: 3000, maxDurationMs: 300_000 };
/** The UI's Add text preset (findings part 2 §40; W3-ED-22): stored values. The inspector shows the stroke colour as
 *  transparent while the stroke width is 0 (part 3 §46.6 wave-3 reading). */
export const ADD_TEXT = { text: 'Heading', family: 'Roboto', weight: 700, fontSize: 150, color: '#ffffff', textAlign: 'center', wordWrap: 'break-word', durationMs: 5000 };

// ---- The stored item and its measured box.
/** A text item: text and font in details, every style key and the box as stored properties. */
export function textRecord(o: { text: string; trackId: string; display: { from: number; to: number }; properties: Record<string, unknown>; details?: RecordData }): RecordData {
  return { id: newId('item'), type: 'text', trackId: o.trackId, display: o.display, details: { text: o.text, ...o.details },
    properties: storedProperties({ opacity: 1, scale: 1, rotation: 0, ...o.properties }) };
}
/** Font details for a resolved face (fontFamily = the face Xapp stores, fontFamilyDisplay = the family, fontUrl). */
export const fontDetails = (name: string, weight?: unknown, style?: unknown): RecordData => {
  const r = resolveFont(name, weight, style);
  return r ? { fontFamily: r.variant.face, fontFamilyDisplay: r.entry.family, fontUrl: r.url } : {};
};
/** The measured size of a record's text at wrap width W (item-local 0 ms). */
export const measureText = (record: RecordData, W: number) => measuredSize(measureContext(), textStyle(record, 0), W);

/** T22: the bound template's titles font when this browser has it, else undefined (today's default applies). */
const templateTitlesFont = (doc: ProjectDocument): string | undefined => { const f = defaultFont(doc, 'titlesFont'); return f && findFont(f) ? f : undefined; };

// ---- The UI's Add text (W3-ED-22): an empty overlay track (the lowest unlocked one), else a new overlay track on top; 0 s.
export function presetTrack(doc: ProjectDocument): string {
  const empty = stack(doc).filter(id => track(doc, id)!.kind === 'overlay' && !trackLocked(doc, id) && !itemsOn(doc, id).length);
  return empty.length ? empty[0] : insertTrack(doc, newTrack(doc, 'overlay')).id;
}
/** Adds the preset (or `text` in the preset style: a text dragged from the panel) and returns its id. Without `at`, at 0 s on
 *  the track rule above; with `at` (a drop), at the drop time on the drop track when it is an overlay track with room, else
 *  by the track rule at the drop time. Centred on the canvas, box = the measured text. */
export function addTextPreset(doc: ProjectDocument, text = ADD_TEXT.text, at?: { trackId: string | null; timeMs: number }): string {
  const from = at ? Math.max(0, Math.round(at.timeMs)) : 0, display = { from, to: from + ADD_TEXT.durationMs };
  const record = textRecord({ text, trackId: '', display, details: fontDetails(ADD_TEXT.family, ADD_TEXT.weight),
    properties: { fontSize: ADD_TEXT.fontSize, fontWeight: ADD_TEXT.weight, color: ADD_TEXT.color, textAlign: ADD_TEXT.textAlign, wordWrap: ADD_TEXT.wordWrap, borderWidth: 0, borderColor: '#000000' } });
  // T22 (plan P4): in a project bound to a template, a new title takes the template's titles font.
  const titles = templateTitlesFont(doc);
  if (titles) writeFont(record, { fontFamily: titles });
  const size = projectSize(doc), m = measureText(record, Infinity), width = Math.ceil(m.width), height = Math.round(m.height);
  Object.assign(record.properties, storedProperties({ positionX: Math.round((size.width - width) / 2), positionY: Math.round((size.height - height) / 2), width, height }));
  const dropTrack = at?.trackId ? track(doc, at.trackId) : undefined;
  record.trackId = dropTrack && dropTrack.kind === 'overlay' && !trackLocked(doc, dropTrack.id) && !blockers(doc, dropTrack.id, display).length ? dropTrack.id
    : at ? (stack(doc).find(id => track(doc, id)!.kind === 'overlay' && !trackLocked(doc, id) && !blockers(doc, id, display).length) ?? insertTrack(doc, newTrack(doc, 'overlay')).id)
    : presetTrack(doc);
  doc.items.push(record);
  return record.id;
}

// ---- addText (results §2: failures in this order; R1d refusals return their top-level `details`, so they are returned, not
// thrown: callTool copies only message / data / failures out of a CommandError).
type Refusal = { success: false; code: string; error: string; message: string; details: RecordData };
class Returned extends Error { constructor(readonly result: Refusal) { super(result.error); } }
const refuseWith = (code: string, error: string, message: string, details: RecordData): never => { throw new Returned({ success: false, code, error, message, details }); };

/** addText's checks and placement on a draft (text/agent.ts runs it on a discarded draft to learn the faces to load). */
export function addTextIn(doc: ProjectDocument, args: RecordData): ToolResult {
  const ref: string | undefined = args.insertAfterItemId;
  if (ref !== undefined && (args.trackId !== undefined || args.timelineStart !== undefined))
    fail('INVALID_COMBINATION', `insertAfter cannot be used with ${['trackId', 'timelineStart'].filter(k => args[k] !== undefined).join(', ')}. Use insertAfterItemId alone, or trackId with timelineStart.`);
  if (ref !== undefined) {
    const r = item(doc, ref);
    if (!r) fail('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', { message: `Item '${ref}' not found on the timeline. Read context for current item ids.` });
    if (!track(doc, r.trackId)) fail('INSERT_AFTER_NO_TRACK', 'insertAfter item not on any track');
    if (!canInsertAfter('text', r)) fail('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', { message: `Cannot insert text after ${r.type} item '${ref}'. The new item requires a compatible track kind.` });
  }
  const look = 'look' in args ? checkLook(args.look, undefined) : null;
  const text = args.textContent;
  if (typeof text !== 'string' || !text.trim()) fail('MISSING_CONTENT', 'Text content is required', { message: 'Text content is required' });
  const size = projectSize(doc), b = args.bounds;
  if (b !== undefined && (!isObj(b) || !finite(b.x) || !finite(b.y) || !finite(b.width) || !(b.width > 0)))
    fail('INVALID_BOUNDS', 'Invalid bounds', { message: 'bounds requires finite x/y coordinates and a positive width.' });
  if (b !== undefined && args.maxWidth !== undefined && args.maxWidth !== b.width) fail('INVALID_COMBINATION', 'bounds and maxWidth disagree', { message: 'bounds.width is the wrap width; omit maxWidth when bounds is given.' });
  if (args.maxWidth !== undefined && !(finite(args.maxWidth) && args.maxWidth > 0)) fail('INVALID_PROPERTY_VALUE', `maxWidth must be a positive number of px. Received: ${show(args.maxWidth)}`);
  const from = args.timelineStart === undefined ? 0 : finite(args.timelineStart) ? toMs(args.timelineStart) : NaN;
  if (ref === undefined && !(from >= 0)) refuseWith('INVALID_TIMELINE_START', 'Invalid timelineStart', `timelineStart must be >= 0. Received: ${show(args.timelineStart)}s.`,
    { received: args.timelineStart, minimum: 0, example: 0 });
  const frame = 1000 / fpsOf(doc), length = args.duration === undefined ? AGENT_TEXT.durationMs : finite(args.duration) ? toMs(args.duration) : NaN;
  if (!(length >= Math.round(frame) && length <= AGENT_TEXT.maxDurationMs)) refuseWith('INVALID_DURATION', 'Invalid duration',
    `duration must be between one frame (${s3(frame)}s) and 300 seconds. Received: ${show(args.duration)}s.`, { received: args.duration, minimum: s3(frame), maximum: 300, example: AGENT_TEXT.durationMs / 1000 });
  if (args.font !== undefined && (typeof args.font !== 'string' || !findFont(args.font))) refuseWith('FONT_NOT_FOUND', 'Font not found',
    `Font '${show(args.font)}' is not available. Call the fonts tool for the fonts you can use, or omit font for the default.`, { requestedFont: args.font, suggestion: fontNotFoundText(show(args.font)) });
  const animation = args.textAnimation === undefined ? undefined : checkAnimation(args.textAnimation);
  const fontSize = args.fontSize ?? AGENT_TEXT.fontSize, style: Record<string, unknown> = { fontSize };
  for (const k of ['fontSize', 'color', 'backgroundColor']) if (args[k] !== undefined) { checkTextProperty({ type: 'text' }, k, args[k]); style[k] = args[k]; }
  // A look's plain fallbacks first; explicit fields of the call win (§34).
  const fb = look ? lookFallbacks(look, fontSizePx(fontSize)) : null;
  const font = args.font ?? fb?.details.fontFamily ?? templateTitlesFont(doc);
  const W = b ? b.width : args.maxWidth ?? Math.round(size.width * AGENT_TEXT.widthShare);
  const record = textRecord({ text, trackId: '', display: { from: 0, to: length }, properties: { ...fb?.properties, ...style, width: W },
    details: { ...look ? { look } : {}, ...animation ? { textAnimation: animation } : {} } });
  // A face name (e.g. 'Roboto-Bold') sets the fontWeight / fontStyle properties exactly as editProperties does — reuse
  // writeFont so the two paths cannot drift (R2 M2); measure after, so the box uses the resolved face.
  if (typeof font === 'string') writeFont(record, { fontFamily: font });
  const height = Math.round(measureText(record, W).height);
  Object.assign(record.properties, storedProperties({ positionX: b ? b.x : Math.round((size.width - W) / 2), positionY: b ? b.y : Math.round((size.height - height) / 2), height }));
  if (ref !== undefined) insertAfter(doc, ref, [record]);
  else {
    if (!args.trackId) fail('MISSING_TRACK_ID', 'trackId is required');
    const t = track(doc, args.trackId);
    if (!t || t.kind !== 'overlay') fail('INVALID_TRACK', `Overlay track '${args.trackId}' not found`);
    if (trackLocked(doc, t.id)) fail('TRACK_LOCKED', `Track '${t.id}' is locked`);
    record.trackId = t.id; record.display = { from, to: from + length };
    const hit = blockers(doc, t.id, record.display)[0];
    if (hit) overlap(doc, t.id, record.display, hit);
    doc.items.push(record);
  }
  return { success: true, message: `Added text item '${record.id}' to track '${record.trackId}' at ${fmt(record.display.from)}s`,
    data: { itemId: record.id, assetId: null, type: 'text', trackId: record.trackId, timelinePosition: { start: s3(record.display.from), end: s3(record.display.to) },
      ...b ? { resolvedBounds: { x: b.x, y: b.y, width: b.width, height } } : {} } };
}
type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
export const addText: Handler = (ctx, args) => {
  try { return ctx.bus.run(args.insertAfterItemId !== undefined ? 'Insert items' : 'Add items', 'agent', doc => addTextIn(doc, args ?? {})); } catch (e) {
    if (e instanceof Returned) return e.result;
    if (e instanceof CommandError) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    return { success: false, code: 'UNEXPECTED_ERROR', error: 'Text addition failed', message: `Failed to add text to timeline: ${reason}`, details: { originalError: reason } };
  }
};
