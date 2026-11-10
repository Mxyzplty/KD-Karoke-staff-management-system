// SPDX-License-Identifier: AGPL-3.0-only
// The tab-side dispatcher for helper calls (agent tool results A0.2, MCP path): execution-key ledger → open project →
// stale-read gate (timeline scope, then the per-item keyframes, effects and masks scopes) → the T03 / T04 / T10 / T12 handler (`activeRuntime.call`, which
// adds `timelineChanges`) or `context` → the MCP additions to `context`. Resource reads return the light `context` with no
// additions and do not count as a read. viewItemDetails and syncAndSwap (T19) run async in analysis/details, analysis/multicam.
import { viewItemDetails } from '../analysis/details';
import type { DetailsContext } from '../analysis/details';
import { syncAndSwap } from '../analysis/multicam';
import type { SwapContext } from '../analysis/multicam';
import { resolveTranscriptRanges, usesTranscriptRange } from '../analysis/ranges';
import { view } from '../editor/view';
import type { ProjectDocument, RecordData } from '../store/model';
import { masksBlock } from '../masks/tools';
import { masksOf } from '../masks/model';
import { callSmartTool, SMART_TOOLS } from '../masks/smart-tools';
import { callMotionGraphicTool, MOTION_GRAPHIC_TOOLS } from '../mg/tools';
import type { DryRun } from '../mg/tools';
import { callTextTool, needsFontLoad } from '../text/agent';
import { callCaptionStyleTool, callCaptionTool, needsCaptionFontLoad, needsCaptionPrep } from '../captions/agent';
import { effectsBlock, paramProp, resolveAgentId } from '../timeline/effects';
import { item } from '../timeline/model';
import { keyframesBlock } from '../timeline/properties';
import type { Runtime } from '../timeline/runtime';
import { readContext } from './context';
import { Ledger } from './ledger';
import { HELP_TOOLS, READ_ONLY, TIMELINE_GATED } from './protocol';
import type { HelperMessage, ToolResult } from './protocol';
import { Watcher } from './watch';
import type { Change } from './watch';

export type Call = Extract<HelperMessage, { type: 'call' }>;
export const NO_PROJECT: ToolResult = { success: false, code: 'PROJECT_UNAVAILABLE', error: 'No project is open in the connected editor tab. Open a project, then retry.' };
export const STALE_ERROR = 'Stale read — refreshed and not applied';
// The two message forms (A0.2 item 3); Xapp's wording is ours. Item scopes name the item.
const subject = (scope: string, id?: string) => scope === 'timeline' ? ['the timeline', 'the timeline now counts'] : [`the ${scope} of item '${id}'`, 'they now count'];
export const neverRead = (scope = 'timeline', id?: string) => {
  const [what, fresh] = subject(scope, id);
  return `You haven't read ${what} in this session. The current state is attached and ${fresh} as fresh; retry the call.`;
};
export const modifiedAt = (iso: string, scope = 'timeline', id?: string) => {
  const [what, fresh] = subject(scope, id);
  return `The user modified ${what} at ${iso} after your last read. The current state is attached and ${fresh} as fresh; retry the call.`;
};
export const NEVER_READ = neverRead();
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const scopeKey = (scope: string, id?: string) => id === undefined ? scope : `${scope}:${id}`;

/** Read state per scope and MCP session (A0.2 item 3): the timeline, or one item's keyframes. A refusal marks the scope
 *  fresh, as Xapp does. */
export class Gate {
  private reads = new Map<string, Map<string, number>>();
  private user = new Map<string, { seq: number; at: number }>();
  private seq = 0;
  userChanged(at: number, scope = 'timeline', id?: string) { this.user.set(scopeKey(scope, id), { seq: ++this.seq, at }); }
  markRead(session: string, scope = 'timeline', id?: string) {
    const key = scopeKey(scope, id);
    this.reads.set(key, (this.reads.get(key) ?? new Map()).set(session, ++this.seq));
  }
  /** The refusal message, or null when the session's read is current. */
  check(session: string, scope = 'timeline', id?: string): string | null {
    const key = scopeKey(scope, id), read = this.reads.get(key)?.get(session), user = this.user.get(key);
    if (read !== undefined && !(user && user.seq > read)) return null;
    const message = read === undefined ? neverRead(scope, id) : modifiedAt(new Date(user!.at).toISOString(), scope, id);
    this.markRead(session, scope, id);
    return message;
  }
  /** Items whose keyframes (or effects) some session has read: only their user changes can make a read stale. */
  keyframeItems(scope = 'keyframes'): string[] { const p = `${scope}:`; return [...this.reads.keys()].filter(k => k.startsWith(p)).map(k => k.slice(p.length)); }
}

/** Item properties a call writes, per target item (A0.2 keyframes scope). writeKeyframes on an effect is gated in the
 *  effects scope (effectWrites); on a mask in the masks scope (maskWrites). */
export function keyframeWrites(tool: string, input: Record<string, unknown>): [string, string[]][] {
  const given = (k: string) => input[k] !== undefined && input[k] !== false;
  const keys = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
  if (tool === 'editProperties') {
    const ids = Array.isArray(input.itemIds) ? input.itemIds : input.itemId !== undefined ? [input.itemId] : [];
    return [...new Set(ids.map(String))].map(id => [id, keys(input.properties)]);
  }
  if (tool === 'writeKeyframes') return given('effectId') || given('maskIndex') ? [] : [[String(input.itemId), keys(input.payload)]];
  if (tool !== 'transformItem') return [];
  // What transform() writes (timeline/items.ts): fit / fill set scale and position; scaleBy re-centres an axis not given.
  const fit = given('fitToCanvas') || given('fillCanvas'), across = given('center') || given('alignTop') || given('alignBottom');
  const writes = { positionX: fit || given('x') || given('centerX') || across || (given('scaleBy') && input.x === undefined),
    positionY: fit || given('y') || given('centerY') || across || (given('scaleBy') && input.y === undefined),
    scale: fit || given('scale') || given('scaleBy'), rotation: given('rotation') };
  return [[String(input.itemId), Object.keys(writes).filter(k => writes[k as keyof typeof writes])]];
}
/** Items a call edits in the effects scope (A0.2 item 3, T10): every writeEffects target when `effects` has an entry;
 *  writeKeyframes on an effect when a written parameter already has keyframes. An id the handler will refuse is not gated. */
export function effectWrites(doc: ProjectDocument, tool: string, input: Record<string, unknown>): string[] {
  const keys = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
  if (tool === 'writeEffects') {
    if (!keys(input.effects).length) return [];
    const ids = Array.isArray(input.itemIds) ? input.itemIds : input.itemId !== undefined ? [input.itemId] : [];
    return [...new Set(ids.map(String))];
  }
  if (tool !== 'writeKeyframes' || input.effectId === undefined || input.maskIndex !== undefined) return [];
  const i = item(doc, String(input.itemId));
  let e: RecordData;
  try { if (!i) return []; e = resolveAgentId(i, input.effectId); } catch { return []; }
  return keys(input.payload).some(p => paramProp(e, p)?.keyframes?.length) ? [String(input.itemId)] : [];
}
/** The item a call edits in the masks scope (A0.2 item 3, T12): editMaskProperties and writeMaskPoints always; writeKeyframes on a
 *  mask when a written property already has keyframes. An id or index the handler will refuse is not gated. */
export function maskWrites(doc: ProjectDocument, tool: string, input: Record<string, unknown>): string | null {
  if (tool !== 'editMaskProperties' && tool !== 'writeMaskPoints' && !(tool === 'writeKeyframes' && input.maskIndex !== undefined && input.effectId === undefined)) return null;
  const i = item(doc, String(input.itemId)), m = i && masksOf(i)[input.maskIndex as number];
  if (!m) return null;
  if (tool !== 'writeKeyframes') return i!.id;
  const written = input.payload && typeof input.payload === 'object' ? Object.keys(input.payload) : [];
  return written.some(p => (m.keyframes as RecordData | undefined)?.[p]?.keyframes?.length) ? i!.id : null;
}
const block = (doc: ProjectDocument, id: string) => { const i = item(doc, id); return i ? keyframesBlock(i) : null; };
const fxBlock = (doc: ProjectDocument, id: string) => { const i = item(doc, id); return i ? effectsBlock(i) : null; };
const maskBlock = (doc: ProjectDocument, id: string) => { const i = item(doc, id); return i ? masksBlock(doc, i) : null; };

export type ExecutorOptions = {
  /** Snapshot parts that changed (agent or user): the link turns them into `stateChanged` events. */
  onState?: (parts: string[]) => void;
  storage?: ConstructorParameters<typeof Ledger>[0];
  current?: () => Runtime | undefined;
  ui?: () => { selection: string[]; playheadMs: number };
  /** The motion-graphic sandbox dry run (T08); default: the browser renderer's compile. */
  dryRun?: DryRun;
  /** viewItemDetails' and syncAndSwap's store and analysis service (T19); loaded on first use by default. */
  analysis?: () => Promise<AnalysisDeps>;
};
/** T08: one sandbox run at frame 0, loaded on first use. */
const sandboxDryRun: DryRun = async (code, assetMap) => {
  const { createMotionGraphicRenderer } = await import('../mg/index');
  const renderer = createMotionGraphicRenderer();
  try { return await renderer.compile(code, assetMap); } finally { renderer.dispose(); }
};
const unavailable = (e: unknown): ToolResult => {
  const err = e as { code?: unknown; message?: unknown };
  return { success: false, code: typeof err?.code === 'string' && err.code ? err.code : 'PROJECT_UNAVAILABLE', error: typeof err?.message === 'string' && err.message ? err.message : 'Unable to verify the open project.', operationMayHaveRun: true };
};
type AnalysisDeps = Pick<DetailsContext, 'store' | 'service'> & Pick<SwapContext, 'store' | 'service'>;
const analysisDeps = async (): Promise<AnalysisDeps> => {
  const [{ projectStore }, { analysisService }] = await Promise.all([import('../store/database'), import('../analysis/service')]);
  return { store: projectStore, service: analysisService };
};

export class Executor {
  readonly gate = new Gate();
  readonly ledger: Ledger;
  readonly watcher: Watcher;
  private ui: () => { selection: string[]; playheadMs: number };
  private dryRun: DryRun;
  private analysis: () => Promise<AnalysisDeps>;
  constructor(options: ExecutorOptions = {}) {
    this.ledger = new Ledger(options.storage);
    this.ui = options.ui ?? view;
    this.dryRun = options.dryRun ?? sandboxDryRun;
    this.analysis = options.analysis ?? analysisDeps;
    this.watcher = new Watcher((c: Change, before, after) => {
      if (c.user) {
        this.gate.userChanged(c.at);
        if (c.parts.includes('items')) {
          for (const id of this.gate.keyframeItems())
            if (JSON.stringify(block(before, id)) !== JSON.stringify(block(after, id))) this.gate.userChanged(c.at, 'keyframes', id);
          for (const id of this.gate.keyframeItems('effects'))
            if (JSON.stringify(fxBlock(before, id)) !== JSON.stringify(fxBlock(after, id))) this.gate.userChanged(c.at, 'effects', id);
          for (const id of this.gate.keyframeItems('masks'))
            if (JSON.stringify(item(before, id)?.masks) !== JSON.stringify(item(after, id)?.masks)) this.gate.userChanged(c.at, 'masks', id);
        }
      }
      options.onState?.(c.parts);
    }, options.current);
  }
  execute(call: Call): Promise<ToolResult> {
    const session = call.session ?? 'default', input = call.input ?? {};
    if (call.resource) return Promise.resolve(this.light(true) as ToolResult);
    if (HELP_TOOLS.has(call.toolName)) return import('../settings/help').then(help => help.helpTool(call.toolName, input));
    if (call.toolName === 'viewItemDetails') return this.details(input, session);
    if (call.toolName === 'syncAndSwap') return this.ledger.run(call.executionKey, call.toolName, input, () => this.swap(input));
    if (call.toolName === 'addMedia' && usesTranscriptRange(input)) return this.ledger.run(call.executionKey, call.toolName, input, () => this.addByWords(input, session));
    if (SMART_TOOLS.has(call.toolName)) return READ_ONLY.has(call.toolName) ? this.smart(call.toolName, input) : this.ledger.run(call.executionKey, call.toolName, input, () => this.smart(call.toolName, input));
    if (READ_ONLY.has(call.toolName)) return Promise.resolve(this.handle(call.toolName, input, session));
    return this.ledger.run(call.executionKey, call.toolName, input, () => this.handle(call.toolName, input, session));
  }
  /** The light `context` read (the gate's `currentState`, the resource read). */
  private light(resource = false): ToolResult | Record<string, unknown> {
    const runtime = this.watcher.sync();
    if (!runtime) return resource ? NO_PROJECT : { error: 'Could not fetch current state', cause: NO_PROJECT.error };
    try { return readContext(runtime.bus.doc); } catch (e) {
      return resource ? { success: false, code: 'PROJECT_UNAVAILABLE', error: (e as Error)?.message || 'Unable to read the project.' } : { error: 'Could not fetch current state', cause: (e as Error)?.message ?? String(e) };
    }
  }
  private handle(tool: string, input: Record<string, unknown>, session: string): ToolResult | Promise<ToolResult> {
    const runtime = this.watcher.sync();
    if (!runtime) return NO_PROJECT;
    const refusal = this.gated(runtime, tool, input, session);
    if (refusal) return refusal;
    // T08: the sandbox dry run is async, so the user can edit or switch project before the call runs. The call then runs as
    // the agent (the watcher attributes its change) only on the runtime it was checked on, after the gates pass again; on
    // another runtime, or none, it is handled again from the start.
    if (MOTION_GRAPHIC_TOOLS.has(tool))
      return callMotionGraphicTool(runtime.tools, tool, input, { dryRun: this.dryRun, run: () => this.watcher.sync() !== runtime ? this.handle(tool, input, session)
        : this.gated(runtime, tool, input, session) ?? this.watcher.asAgent(() => runtime.call(tool, input)) }).catch(unavailable);
    // Caption style drafts load all affected faces, including applyToAll, before the real edit commits.
    if (needsCaptionFontLoad(runtime.bus.doc, tool, input))
      return callCaptionStyleTool(runtime.tools, tool, input, { run: () => this.watcher.sync() !== runtime ? this.handle(tool, input, session)
        : this.gated(runtime, tool, input, session) ?? this.watcher.asAgent(() => runtime.call(tool, input)) }).catch(unavailable);
    // T05 (coordinator ruling Q5): the same for a call that loads a font face first (addText, a font key in editProperties).
    if (needsFontLoad(tool, input))
      return callTextTool(runtime.tools, tool, input, { run: () => this.watcher.sync() !== runtime ? this.handle(tool, input, session)
        : this.gated(runtime, tool, input, session) ?? this.watcher.asAgent(() => runtime.call(tool, input)) }).catch(unavailable);
    // T09: addCaptions reads the sources' transcripts (async) and loads the caption faces before the synchronous add.
    if (needsCaptionPrep(tool)) return this.captions(runtime, tool, input, session);
    let result: ToolResult;
    try { result = tool === 'context' ? readContext(runtime.bus.doc, input) : this.watcher.asAgent(() => runtime.call(tool, input)); } catch (e) { return unavailable(e); }
    if (tool === 'context' && result.success) {
      this.gate.markRead(session);
      const ui = this.ui();
      Object.assign(result.data as Record<string, unknown>, { selectedItems: [...(ui.selection ?? [])], ...(typeof ui.playheadMs === 'number' ? { playheadSeconds: r3(ui.playheadMs / 1000) } : {}) });
    }
    if ((tool === 'createMask' || tool === 'removeMask') && result.success) this.gate.markRead(session, 'masks', String(input.itemId)); // results §2: both mark the scope read
    return result;
  }
  /** T09 addCaptions: load the stored transcripts and the caption faces (async), then run the synchronous add as the agent
   *  (after the gates pass again on the runtime it was prepared on; on another runtime, or none, it is handled afresh). */
  private captions(runtime: Runtime, tool: string, input: Record<string, unknown>, session: string): Promise<ToolResult> {
    return this.analysis().then(({ store }) => callCaptionTool(runtime.tools, input, { store, asset: id => runtime.assets.get(id),
      run: () => this.watcher.sync() !== runtime ? this.handle(tool, input, session)
        : this.gated(runtime, tool, input, session) ?? this.watcher.asAgent(() => runtime.call(tool, input)) })).catch(unavailable);
  }
  /** The stale-read gate's refusal (timeline scope, then the per-item keyframes, effects and masks scopes), or null. */
  private gated(runtime: Runtime, tool: string, input: Record<string, unknown>, session: string): ToolResult | null {
    if (TIMELINE_GATED.has(tool)) { const stale = this.stale(session); if (stale) return stale; }
    // Keyframes scope: only targets where a written property is already keyframed; the first stale one refuses the call.
    for (const [id, writes] of keyframeWrites(tool, input)) {
      const current = block(runtime.bus.doc, id);
      if (!writes.some(p => current?.keyframes?.[p])) continue;
      const message = this.gate.check(session, 'keyframes', id);
      if (message) return { success: false, code: 'STALE_READ_REFRESHED', error: STALE_ERROR, message, scope: 'keyframes', agentId: id, currentState: current };
    }
    for (const id of effectWrites(runtime.bus.doc, tool, input)) {
      const message = this.gate.check(session, 'effects', id);
      if (message) return { success: false, code: 'STALE_READ_REFRESHED', error: STALE_ERROR, message, scope: 'effects', agentId: id, currentState: fxBlock(runtime.bus.doc, id) };
    }
    const masked = maskWrites(runtime.bus.doc, tool, input);
    if (masked) {
      const message = this.gate.check(session, 'masks', masked);
      if (message) return { success: false, code: 'STALE_READ_REFRESHED', error: STALE_ERROR, message, scope: 'masks', agentId: masked, currentState: maskBlock(runtime.bus.doc, masked) };
    }
    return null;
  }
  /** The timeline-scope refusal, or null when the session's read is current. */
  private stale(session: string): ToolResult | null {
    const message = this.gate.check(session);
    return message ? { success: false, code: 'STALE_READ_REFRESHED', error: STALE_ERROR, message, scope: 'timeline', currentState: this.light() } : null;
  }
  /** addMedia with `transcriptRange` (T19 D): gate first, then the ranges are read from the stored transcripts (async) and
   *  turned into trims; the add itself is the normal synchronous handler (which checks the gate again). */
  private async addByWords(input: Record<string, unknown>, session: string): Promise<ToolResult> {
    const runtime = this.watcher.sync();
    if (!runtime) return NO_PROJECT;
    const stale = this.stale(session);
    if (stale) return stale;
    let ranges: Awaited<ReturnType<typeof resolveTranscriptRanges>>;
    try { ranges = await resolveTranscriptRanges(input, id => runtime.assets.get(id), (await this.analysis()).store); } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      return { success: false, code: typeof err?.code === 'string' && err.code ? err.code : 'PROJECT_UNAVAILABLE', error: typeof err?.message === 'string' && err.message ? err.message : 'Unable to verify the open project.' };
    }
    if ('success' in ranges) return ranges as ToolResult;
    if (this.watcher.sync() !== runtime) return NO_PROJECT;
    const result = await this.handle('addMedia', ranges.args, session), data = result.data as { results?: Record<string, unknown>[] } | undefined;
    if (!result.success || !data?.results) return result;
    ranges.resolved.forEach((r, n) => { if (r && data.results![n]) data.results![n].resolvedTranscriptRange = r; });
    return { ...result, data: { ...data, resolvedTranscriptRanges: ranges.resolved.filter(Boolean) } };
  }
  /** viewItemDetails (T19 C4): read-only and async (beats are computed on first read). Success marks the timeline read,
   *  and the keyframes / masks scope of each returned item whose keyframes / masks were included (results §2 viewItemDetails). */
  private async details(input: Record<string, unknown>, session: string): Promise<ToolResult> {
    const runtime = this.watcher.sync();
    if (!runtime) return NO_PROJECT;
    const agentIds = new Map<string, string>();
    for (const [key, asset] of runtime.assets) if (key !== asset.id) agentIds.set(asset.id, key);
    try {
      const deps = await this.analysis();
      const result = await viewItemDetails({ doc: runtime.bus.doc, asset: id => runtime.assets.get(id), agentId: id => agentIds.get(id), ...deps }, input,
        id => this.gate.markRead(session, 'keyframes', id), id => this.gate.markRead(session, 'masks', id));
      if (result.success) this.gate.markRead(session);
      return result;
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      return { success: false, code: typeof err?.code === 'string' && err.code ? err.code : 'PROJECT_UNAVAILABLE', error: typeof err?.message === 'string' && err.message ? err.message : 'Unable to verify the open project.' };
    }
  }
  /** T12's smart-mask tools: not gated (results §2), and asynchronous. A job's document write runs as the agent, on the runtime it
   *  started on; closing that project ends the job (masks/jobs.ts). */
  private async smart(tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    const runtime = this.watcher.sync();
    if (!runtime) return NO_PROJECT;
    try { return await callSmartTool({ ...runtime.tools, origin: 'agent', scoped: run => this.watcher.asAgent(run) }, tool, input); } catch (e) { return unavailable(e); }
  }
  /** syncAndSwap (T19 C10): not gated (results §2 syncAndSwap). The offset is computed async; the placement is one
   *  synchronous agent command, refused if another project was opened meanwhile. */
  private async swap(input: Record<string, unknown>): Promise<ToolResult> {
    const runtime = this.watcher.sync();
    if (!runtime) return NO_PROJECT;
    try {
      const deps = await this.analysis();
      return await syncAndSwap({ doc: () => runtime.bus.doc, asset: id => runtime.assets.get(id), ...deps,
        place: args => this.watcher.sync() === runtime ? this.watcher.asAgent(() => runtime.call('addMedia', args)) : NO_PROJECT }, input);
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      return { success: false, code: typeof err?.code === 'string' && err.code ? err.code : 'PROJECT_UNAVAILABLE', error: typeof err?.message === 'string' && err.message ? err.message : 'syncAndSwap failed.' };
    }
  }
}
