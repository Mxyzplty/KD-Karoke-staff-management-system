// SPDX-License-Identifier: AGPL-3.0-only
// T08 agent tools on the T03 command path (agent tool results §2 addMotionGraphic / editMotionGraphic; texts: reference
// compares §1.4, error codes §9). Each handler is one synchronous bus command tagged `agent`: the static checks and the host
// compile run inside it, so a refusal changes nothing. The item keeps its code in details.code, its summary in
// metadata.summary and its designed length as sourceDuration (ms), so T03's trim and split treat it as timed media
// (findings §16, MG clock). The sandbox dry run needs the browser and is async: callMotionGraphicTool runs it after the
// checks that come before it and before the command itself.
import type { ProjectDocument, RecordData } from '../store/model';
import { canInsertAfter, insertAfter } from '../timeline/items';
import { blockers, CommandError, fail, fmt, freeTracks, item, newId, nextFree, toMs, track, trackLocked } from '../timeline/model';
import { storedProperties } from '../timeline/properties';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { assetIdRefusal, fontWarnings, nativeMediaRefusal } from './agent-checks';
import { patchCode, validateSummary } from './edits';
import { MotionGraphicError } from './errors';
import { PARITY } from './parity-switches';

// The host compiler (Babel) stays out of the editor's first load: callMotionGraphicTool loads it before a handler compiles.
let compiler: typeof import('./compiler') | undefined;
export async function loadCompiler(): Promise<void> { compiler ??= await import('./compiler'); }

type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
const s3 = (ms: number) => Math.round(ms) / 1000;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const DEFAULT_MS = 5000;

// Set while callMotionGraphicTool asks a handler how far its checks get: a handler that passes them throws Ready.
let preflight = false;
class Ready { constructor(readonly code: string) {} }

/** The helper's schema rule (schemas.ts:171) for callers that skip the helper, in its exact INVALID_TOOL_INPUT shape:
 *  `details` at the top level (research §1.8.3 item 3). Returned, not thrown: callTool copies only `message`, `data` and
 *  `failures` out of a CommandError, so a thrown top-level `details` would be dropped. */
function numbers(tool: string, args: RecordData, required: string[], optional: string[]): ToolResult | undefined {
  const errors = [...required.filter(k => args[k] === undefined).map(k => ({ path: `$.${k}`, code: 'REQUIRED', message: `must have required property '${k}'` })),
    ...[...required, ...optional].filter(k => args[k] !== undefined && !num(args[k])).map(k => ({ path: `$.${k}`, code: 'TYPE', message: 'must be number' }))];
  if (!errors.length) return;
  return { success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors } };
}
/** Q4 (parity-switches): an invalid summary is refused with PARITY.summaryCode on add and edit; error = message. */
function summaryOf(input: unknown): string {
  const r = validateSummary(input);
  if (!r.valid) fail(PARITY.summaryCode, r.message!, { message: r.message });
  return r.summary;
}
/** Agent-path order: native media tags, getAssetUrl ids, then the host compile. error = message. */
function checkCode(ctx: ToolContext, code: string) {
  const refusal = nativeMediaRefusal(code) ?? assetIdRefusal(code, ctx.assetLinks?.() ?? []);
  if (refusal) fail('VALIDATION_ERROR', refusal, { message: refusal });
  if (!compiler) throw Error('The motion-graphic compiler is not loaded: call through callMotionGraphicTool, or await loadCompiler().');
  try { compiler.compileMotionGraphic(code); } catch (e) {
    if (!(e instanceof MotionGraphicError)) throw e;
    fail(e.code, e.message, { message: e.message });
  }
  if (preflight) throw new Ready(code);
}
const fonts = (code: string) => {
  const warnings = fontWarnings(code);
  return { suffix: warnings.length ? ` — FONT WARNING: ${warnings.join(' ')}` : '', data: warnings.length ? { fontWarnings: warnings } : {} };
};
/** Xapp's TRACK_OVERLAP text (reference compares §1.4, stored 16b): error only, no message. */
export function overlap(doc: ProjectDocument, trackId: string, range: { from: number; to: number }, hit: RecordData): never {
  const next = nextFree(doc, trackId, range.from, range.to - range.from), free = freeTracks(doc, 'overlay', range, undefined, trackId);
  const tail = !free.length ? '.' : free.length === 1 ? `; for the same time, track ${free[0]} is free.` : `; for the same time, tracks ${free.join(', ')} are free.`;
  fail('TRACK_OVERLAP', `Requested range overlaps item '${hit.id}' (${fmt(hit.display.from)}s–${fmt(hit.display.to)}s) on track '${trackId}'. That track has room for this length from ${fmt(next)}s${tail}`);
}

// ---- addMotionGraphic (failures in the results §2 order).
export const addMotionGraphic: Handler = (ctx, args) => numbers('addMotionGraphic', args, ['width', 'height', 'x', 'y'], ['timelineStart', 'duration', 'animationDuration'])
  ?? ctx.bus.run(args.insertAfterItemId !== undefined ? 'Insert items' : 'Add items', 'agent', doc => {
  const ref: string | undefined = args.insertAfterItemId;
  if (ref !== undefined && (args.trackId !== undefined || args.timelineStart !== undefined))
    fail('INVALID_COMBINATION', `insertAfter cannot be used with ${['trackId', 'timelineStart'].filter(k => args[k] !== undefined).join(', ')}. Use insertAfterItemId alone, or trackId with timelineStart.`);
  if (ref !== undefined) {
    const r = item(doc, ref);
    if (!r) fail('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', { message: `Item '${ref}' not found on the timeline. Read context for current item ids.` });
    if (!track(doc, r.trackId)) fail('INSERT_AFTER_NO_TRACK', 'insertAfter item not on any track');
    if (!canInsertAfter('motionGraphic', r)) fail('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', { message: `Cannot insert motionGraphic after ${r.type} item '${ref}'. The new item requires a compatible track kind.` });
  }
  const code = args.code;
  if (typeof code !== 'string' || !code.trim()) fail('MISSING_PARAM', 'Missing code', { message: 'addMotionGraphic requires a code parameter with React/Remotion component code' });
  const summary = summaryOf(args.summary);
  checkCode(ctx, code);
  // Designed length: animationDuration when > 0, else the requested duration (default animationDuration, else 5 s); a longer
  // request is capped to it (contracts addMotionGraphic, QsU8LrHl).
  const designedMs = num(args.animationDuration) && args.animationDuration > 0 ? toMs(args.animationDuration) : undefined;
  const asked = args.duration !== undefined ? toMs(args.duration) : designedMs ?? DEFAULT_MS;
  if (!(asked > 0)) fail('INVALID_DURATION', `duration must be positive. Received: ${args.duration}s.`);
  const designed = designedMs ?? asked, length = Math.min(asked, designed), capped = asked > designed;
  const record: RecordData = { id: newId('item'), type: 'motionGraphic', trackId: '', display: { from: 0, to: length }, playbackRate: 1, trim: { from: 0, to: length }, sourceDuration: designed,
    details: { name: 'Motion graphic', code }, metadata: { summary }, properties: storedProperties({ positionX: args.x, positionY: args.y, width: args.width, height: args.height, scale: 1 }), masks: [], effects: [] };
  if (ref !== undefined) insertAfter(doc, ref, [record]);
  else {
    if (!args.trackId) fail('MISSING_TRACK_ID', 'trackId is required');
    const t = track(doc, args.trackId);
    if (!t || t.kind !== 'overlay') fail('INVALID_TRACK', `Overlay track '${args.trackId}' not found`);
    if (trackLocked(doc, t.id)) fail('TRACK_LOCKED', `Track '${t.id}' is locked`);
    const from = toMs(args.timelineStart ?? 0);
    if (from < 0) fail('INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${fmt(from)}s.`);
    record.trackId = t.id; record.display = { from, to: from + length };
    const hit = blockers(doc, t.id, record.display)[0];
    if (hit) overlap(doc, t.id, record.display, hit);
    doc.items.push(record);
  }
  const f = fonts(code), start = ref !== undefined ? s3(record.display.from) : args.timelineStart ?? 0;
  const cap = capped ? `, ${fmt(length)}s: its designed length (${fmt(asked)}s asked). A longer graphic is a new revision with a longer durationSeconds.` : '';
  return { success: true, message: `Motion graphic '${record.id}' added to track '${record.trackId}' at ${fmt(toMs(start))}s${cap}${f.suffix}`,
    data: { itemId: record.id, trackId: record.trackId, duration: s3(length), ...(capped ? { cappedToDesignedLength: true } : {}), timelineStart: start, summary, ...f.data } };
}) as ToolResult;

// ---- editMotionGraphic.
function graphic(doc: ProjectDocument, id: unknown): RecordData {
  const i = typeof id === 'string' && id ? item(doc, id) : undefined;
  if (!i) fail('NOT_FOUND', 'Motion graphic not found', { message: `No motion graphic found with ID '${id ?? ''}'` });
  if (i.type !== 'motionGraphic') fail('WRONG_TYPE', 'Not a motion graphic', { message: `Item '${id}' is not a motion graphic (type: ${i.type})` });
  if (typeof i.details?.code !== 'string') fail('NO_CODE', 'Not a code-mode MG', { message: `Motion graphic '${id}' has no code. It may be a legacy MG.` });
  return i;
}
const isPatch = (p: unknown) => !!p && typeof (p as RecordData).old_string === 'string' && typeof (p as RecordData).new_string === 'string';
export const editMotionGraphic: Handler = (ctx, args) => {
  const action = args.action ?? 'view';
  if (action === 'view') {
    const i = graphic(ctx.bus.doc, args.itemId);
    return { success: true, message: 'Motion graphic code retrieved', data: { agentId: args.itemId, code: i.details.code, summary: i.metadata?.summary } };
  }
  return ctx.bus.run('Edit items', 'agent', doc => {
    const i = graphic(doc, args.itemId);
    if (action !== 'patchCode' && action !== 'updateCode') fail('INVALID_ACTION', 'Invalid action', { message: `Unknown action '${action}'` });
    const given = args.summary !== undefined ? summaryOf(args.summary) : undefined, stored: string | undefined = i.metadata?.summary;
    if (given === undefined && !stored) fail('MISSING_PARAM', 'Missing summary', { message: validateSummary('').message });
    let code: string, patches: string[] | undefined;
    if (action === 'updateCode') {
      if (typeof args.code !== 'string' || !args.code.trim()) fail('MISSING_PARAM', 'Missing code', { message: "updateCode requires the 'code' parameter" });
      code = args.code;
    } else {
      if (!Array.isArray(args.patches) || !args.patches.length || !args.patches.every(isPatch)) fail('MISSING_PARAM', 'Missing patches', { message: "patchCode requires the 'patches' array" });
      // Cutframe improvement (results §4 (4)): a patch that is not found fails the whole call; data.patches has every status.
      try { ({ code, patches } = patchCode(i.details.code, args.patches)); } catch (e) {
        if (!(e instanceof MotionGraphicError)) throw e;
        fail(e.code, e.message, { message: e.message, data: e.details as RecordData });
      }
    }
    checkCode(ctx, code);
    i.details = { ...i.details, code };
    if (given !== undefined) i.metadata = { ...i.metadata, summary: given };
    const f = fonts(code);
    return { success: true, message: `Motion graphic code ${action === 'updateCode' ? 'updated' : 'patched'}${f.suffix}`,
      data: { agentId: args.itemId, ...(patches ? { patches } : {}), codeLength: code.length, summary: given ?? stored, ...f.data } };
  }) as ToolResult;
};

// ---- The async path (executor, parity adapter).
export const MOTION_GRAPHIC_TOOLS: ReadonlySet<string> = new Set(['addMotionGraphic', 'editMotionGraphic']);
const HANDLERS: Record<string, Handler> = { addMotionGraphic, editMotionGraphic };
/** Resolves when the code survives one sandbox run at frame 0 (index.ts `compile`); rejects with a MotionGraphicError. */
export type DryRun = (code: string, assetMap: Record<string, string>) => Promise<unknown>;
/** The code a call would write once every check before the dry run passes, else null (a view, or a refusal `run` reports). */
function readyCode(ctx: ToolContext, name: string, args: RecordData): string | null {
  preflight = true;
  try { HANDLERS[name]?.(ctx, args); return null; } catch (e) {
    if (e instanceof Ready) return e.code;
    if (e instanceof CommandError) return null;
    throw e;
  } finally { preflight = false; }
}
/** Checks, then the sandbox dry run (an error thrown while the graphic first renders is a COMPILATION_ERROR, results §4
 *  R4), then `run` (the real call: callTool through the caller's agent wrapper), which repeats the checks on the current
 *  document. A dry-run refusal changes nothing. */
export async function callMotionGraphicTool(ctx: ToolContext, name: string, args: RecordData, options: { dryRun: DryRun; run: () => ToolResult | Promise<ToolResult> }): Promise<ToolResult> {
  await loadCompiler();
  const code = readyCode(ctx, name, args ?? {});
  if (code !== null) {
    const assetMap = Object.fromEntries((ctx.assetLinks?.() ?? []).map(l => [l.agentId, '']));
    try { await options.dryRun(code, assetMap); } catch (e) {
      if (!(e instanceof MotionGraphicError)) throw e;
      return { success: false, code: e.code, error: e.message, message: e.message };
    }
  }
  return options.run();
}
