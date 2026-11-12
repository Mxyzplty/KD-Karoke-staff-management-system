// SPDX-License-Identifier: AGPL-3.0-only
// T03 runtime: one command bus per open project. The UI path (T02's intents, tagged `user`) and the agent path (tool
// calls, tagged `agent`) run the same ops on the same bus, so both share one undo history and one journal.
// createRuntime is host-agnostic (the harness gives it an in-memory host); installRuntime binds it to the editor's
// autosave session, installs the intent handler and the history seam, and persists history and journal.
import type { Asset, AssetLink, ProjectDocument, RecordData } from '../store/model';
import type { ProjectStore } from '../store/database';
import type { AutosaveSession } from '../store/autosave';
import type { StockItem } from '../media/stock';
import { history, installIntentHandler } from '../editor/commands';
import type { Intent, Outcome } from '../editor/commands';
import { notify } from '../ui';
import { CommandBus, snapshot } from './bus';
import type { BusOptions, HistoryEntry, Host, Label, Tx } from './bus';
import { EditJournal } from './journal';
import type { JournalRecord } from './journal';
import { duplicate, mediaItem, moveOutOfGroup, nudge, paste, remove, reorder, slip, specProblem, split, trim, UI_IMAGE_MS, applyMoves } from './items';
import { CommandError, EPS, fail, insertTrack, item, itemKind, itemsOn, newTrack, span, stack, track, trackLocked } from './model';
import type { TrackKind } from './model';
import { addMarker, createGroup, deleteGroup, deleteTrack, manageTrack, manageTrackGroup, moveTrackLayer, moveTrackOutOfGroup, removeMarker, reorderGroupStep, resizeCanvas, setSettings, ungroup } from './tracks';
import { addKeyframe, changeSpeed, checkProperty, deleteKeyframe, editKeyframe, editProperties, remapOff, remapOn, setUseProxy } from './edits';
import { addEffect, bypassGrade, editColourBlock, editEffectParams, moveEffect, removeEffect, resetEffect, resetGrade, toggleEffect } from './effects';
import { addPathKeyframe, drawShape, editShapePath, removeShapePoint } from './shape-tools';
import { startRemoval } from '../masks/jobs';
import { editMask } from '../masks/tools';
import { addLayoutTile, editLayoutCell } from './layouts';
import { addAtCut, editTransition, removeTransition } from './transitions';
import { addFade, setKeepPitch } from '../audio/edits';
import { callTool } from './tools';
import type { ToolContext, ToolResult } from './tools';
import { addCaptionsPanel, NO_CAPTION_DATA } from '../captions/tools';
import { editCaptionTransform } from '../captions/properties';
import { graphicAssets } from '../mg/frames';
import { addBlankGraphic } from '../mg/presets';
import { applyStylePreset } from '../presets/apply';
import { missingFor } from '../presets/user';
import { addTextPreset } from '../text/tools';

type Op = (doc: ProjectDocument, tx: Tx) => unknown;
export type RuntimeOptions = BusOptions & {
  /** Reloads the asset index (the UI places assets added after the editor opened, e.g. a stock download). */
  loadAssets?: () => Promise<{ assets: Asset[]; links: AssetLink[] }>;
  /** Called once with the runtime's tools when the project's assets are in (T12: legacy effects become mask layers). */
  onAssets?: (tools: { bus: CommandBus; asset(id: string): Asset | undefined }) => void;
  /** Downloads a stock item into the project (T14) and resolves to its asset. */
  addStock?: (item: StockItem) => Promise<Asset>;
  /** T22: imports a built-in element or sound (`element:<id>` / `sound:<slug>`) into the project and resolves to its asset. */
  addCatalogue?: (id: string) => Promise<Asset>;
};
const FLAG_ACTION = { hidden: 'hide', muted: 'mute', solo: 'solo', locked: 'lock' } as const;

// ---- UI placement (findings part 3 §45.4, W3-RT-01 / W3-ED-20 / W3-ED-22).
/** Click target of one kind: the lowest unlocked track of the kind that holds clips (append after its last clip);
 *  else the lowest unlocked empty one at 0; else a new track (kind rule). Provisional reading of W3-RT-01 + W3-ED-20. */
function clickTarget(doc: ProjectDocument, kind: TrackKind): { trackId: string; from: number } {
  const usable = stack(doc).filter(id => track(doc, id)!.kind === kind && !trackLocked(doc, id));
  const filled = usable.find(id => itemsOn(doc, id).length), id = filled ?? usable[0] ?? insertTrack(doc, newTrack(doc, kind)).id;
  return { trackId: id, from: Math.max(0, ...itemsOn(doc, id).map(i => i.display.to)) };
}
type Target = { trackId: string | null; timeMs: number; below: boolean } | null;
/** One "Add items" placement of assets: click / preview drop (target null or no lane), lane drop (append at that lane's
 *  end, W3-RT-01), below-the-tracks drop (a new track at the bottom of the stack, clip at the drop time; §45.4). */
function place(doc: ProjectDocument, assets: Asset[], target: Target): RecordData[] {
  if (!assets.length) fail('NO_ITEMS', 'No items provided');
  return assets.map(a => {
    const problem = specProblem({ assetId: a.id }, a, 0);
    if (problem) fail(problem[0], problem[1]);
    const kind: TrackKind = a.type === 'audio' ? 'audio' : 'video', record = mediaItem(doc, { assetId: a.id, asset: a }, '', 0, UI_IMAGE_MS), len = span(record);
    let at: { trackId: string; from: number };
    const lane = target?.trackId ? track(doc, target.trackId) : undefined;
    if (target?.below) at = { trackId: insertTrack(doc, newTrack(doc, kind), { list: doc.layerOrder, index: 0 }).id, from: Math.max(0, target.timeMs) };
    else if (lane && lane.kind === kind) {
      if (trackLocked(doc, lane.id)) fail('TRACK_LOCKED', `Track ${lane.id} is locked`);
      at = { trackId: lane.id, from: Math.max(0, ...itemsOn(doc, lane.id).map(i => i.display.to)) };
    } else at = clickTarget(doc, kind);
    record.trackId = at.trackId; record.display = { from: at.from, to: at.from + len };
    doc.items.push(record);
    if (target?.below) target = { ...target, below: false, trackId: at.trackId };
    return record;
  });
}
/** A voice-over take (T13, findings §30): at the recorded start, length the recorded duration (at least 100 ms), marked as a
 *  voice-over. Track: the lowest unlocked audio track free over the take, else a new audio track (A1 when the project has
 *  none, as measured; the choice among existing tracks is provisional). */
function placeVoiceover(doc: ProjectDocument, a: Asset, take: { agentId: string; name: string; atMs: number; durationMs: number }) {
  const from = Math.max(0, take.atMs), len = Math.max(100, take.durationMs), to = from + len;
  const free = stack(doc).find(id => track(doc, id)!.kind === 'audio' && !trackLocked(doc, id) && itemsOn(doc, id).every(i => i.display.to <= from + EPS || i.display.from >= to - EPS));
  const record = mediaItem(doc, { assetId: a.id, asset: a, duration: len }, free ?? insertTrack(doc, newTrack(doc, 'audio')).id, from, UI_IMAGE_MS);
  record.details = { ...record.details, name: take.name };
  record.metadata = { assetId: a.id, agentId: take.agentId, isVoiceover: true, isProxy: false };
  doc.items.push(record);
}
/** Ripple-mode drag (§45.1 Ripple row, W3-RT-13): on release the pointer must be within 12 screen px of the start or end
 *  cut of another clip on the same track; the nearest such cut is the slot (start → before that clip, end → after it).
 *  Any other release snaps back: null, no change, no entry. An intent without pointer geometry (a direct dispatch, not a
 *  drag) uses the provisional anchor rule: before the first other clip whose midpoint lies after the new start. */
function rippleAnchor(doc: ProjectDocument, ids: string[], deltaMs: number, pointer?: { ms: number; windowMs: number }): [string, 'before' | 'after'] | null {
  const first = item(doc, ids[0]); if (!first) return null;
  const p = first.display.from + deltaMs, others = itemsOn(doc, first.trackId).filter(i => !ids.includes(i.id));
  if (!others.length) return null;
  if (pointer) {
    const cuts = others.flatMap(i => [[i.id, 'before', i.display.from], [i.id, 'after', i.display.to]] as const).filter(c => Math.abs(c[2] - pointer.ms) <= pointer.windowMs + EPS);
    const near = cuts.sort((a, b) => Math.abs(a[2] - pointer.ms) - Math.abs(b[2] - pointer.ms))[0];
    return near ? [near[0], near[1]] : null;
  }
  const next = others.find(i => (i.display.from + i.display.to) / 2 > p + EPS);
  return next ? [next.id, 'before'] : [others[others.length - 1].id, 'after'];
}

export type Runtime = ReturnType<typeof createRuntime>;
export function createRuntime(host: Host, options: RuntimeOptions = {}) {
  const bus = new CommandBus(host, options), assets = new Map<string, Asset>();
  let pending: Promise<void> = Promise.resolve(), live: { agentId: string; id: string }[] = [];
  /** Indexes assets by stored id and, for this project's links, by agent id (`video_1`). */
  const setAssets = (list: Asset[], links: AssetLink[] = []) => {
    assets.clear(); live = [];
    for (const a of list) assets.set(a.id, a);
    for (const l of links) { const a = assets.get(l.assetId); if (a && l.deleted_at === null) { assets.set(l.agent_id, a); live.push({ agentId: l.agent_id, id: a.id }); } }
    graphicAssets(live);
  };
  const refusal = (attempt: () => unknown): Outcome => {
    try { attempt(); return { ok: true }; } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      return { ok: false, code: e.code || 'COMMAND_FAILED', message: e.extra.message ? `${e.error} ${e.extra.message}` : e.error };
    }
  };
  const run = (label: Label, op: Op): Outcome => refusal(() => bus.run(label, 'user', op));
  const report = (o: Outcome) => { if (!o.ok) notify(`${o.code}: ${o.message}`); };
  /** Places assets now when they are indexed, else after reloading the index; a late failure is notified. `put` replaces
   *  the placement rule (T13's voice-over); `done` runs after a placement that succeeded. */
  const placeLater = (ids: string[], target: Target, put: (doc: ProjectDocument) => unknown = doc => place(doc, ids.map(id => assets.get(id)!).filter(Boolean), target), done?: () => void): Outcome => {
    const now = () => { const o = run('Add items', put); if (o.ok) done?.(); return o; };
    if (ids.every(id => assets.has(id)) || !options.loadAssets) return ids.every(id => assets.has(id)) ? now() : { ok: false, code: 'MEDIA_NOT_FOUND', message: 'Media asset not found' };
    pending = options.loadAssets().then(r => { setAssets(r.assets, r.links); report(ids.every(id => assets.has(id)) ? now() : { ok: false, code: 'MEDIA_NOT_FOUND', message: 'Media asset not found' }); }).catch(e => notify(`MEDIA_NOT_FOUND: ${(e as Error).message}`));
    return { ok: true };
  };
  const handle = (intent: Intent): Outcome | undefined => {
    switch (intent.type) {
      case 'undo': bus.undo('user'); return { ok: true };
      case 'redo': bus.redo('user'); return { ok: true };
      case 'deleteItems': return run('Delete items', (doc, tx) => { tx.label = remove(doc, intent.itemIds, { ripple: intent.ripple, path: 'ui' }).label; });
      case 'splitItems': return run('Split items', doc => {
        const hits = intent.itemIds.filter(id => { const i = item(doc, id); return i && i.display.from + EPS < intent.atMs && intent.atMs < i.display.to - EPS; });
        if (!hits.length) fail('INVALID_SPLIT_POINT', 'Split point is invalid or item was not found');
        for (const id of hits) split(doc, id, intent.atMs);
      });
      case 'duplicateItems': return run('Duplicate items', doc => { duplicate(doc, intent.itemIds); });
      case 'nudgeItems': return run('Edit items', doc => nudge(doc, intent.itemIds, intent.dx, intent.dy));
      case 'pasteItems': return run('Add items', doc => { paste(doc, intent.items, intent.atMs); });
      case 'moveItems': {
        const { itemIds: ids, deltaMs } = intent;
        if (intent.newTrack) return run('Move to new track', doc => {
          const first = item(doc, ids[0]); if (!first) fail('ITEM_NOT_FOUND', `Item '${ids[0]}' not found`);
          const t = insertTrack(doc, newTrack(doc, itemKind(first)), { list: doc.layerOrder, index: 0 });
          applyMoves(doc, ids.map(id => ({ id, trackId: t.id, from: (item(doc, id)?.display.from ?? 0) + deltaMs })), 'Move failed');
        });
        if (intent.ripple && !intent.trackId) return run('Ripple reorder', doc => { const a = rippleAnchor(doc, ids, deltaMs, intent.pointer); if (a) reorder(doc, ids, a[0], a[1]); });
        return run(ids.length > 1 ? 'Move items' : 'Move item', doc => {
          for (const id of ids) if (!item(doc, id)) fail('ITEM_NOT_FOUND', `Item '${id}' not found`);
          applyMoves(doc, ids.map(id => { const i = item(doc, id)!; return { id, trackId: intent.trackId ?? i.trackId, from: i.display.from + deltaMs }; }), 'Move failed');
        });
      }
      case 'trimItem': return run('Edit items', (doc, tx) => { tx.label = trim(doc, intent.itemId, intent.edge, intent.deltaMs, { ripple: intent.ripple, path: 'ui' }).label; });
      // The slip tool drags the footage: content follows the pointer, so the source window moves the other way (provisional sign).
      case 'slipItem': return run('Slip item', doc => { slip(doc, intent.itemId, -intent.deltaMs); });
      case 'moveItemOutOfGroup': return run('Move item out of group', doc => { moveOutOfGroup(doc, intent.itemId); });
      case 'placeAssets': return placeLater(intent.assetIds, null);
      case 'addVoiceover': return placeLater([intent.assetId], null, doc => placeVoiceover(doc, assets.get(intent.assetId)!, intent), () => notify(`Added ${intent.agentId} to the timeline`));
      case 'drop': {
        const p = intent.payload, target: Target = { trackId: intent.trackId, timeMs: intent.timeMs, below: intent.below };
        // T05: a text dragged from the Text panel is the Add text preset with that text, at the drop (W3-ED-22).
        if (p.kind === 'text') return run('Add items', doc => { addTextPreset(doc, p.text, { trackId: intent.below ? null : intent.trackId, timeMs: intent.timeMs }); });
        if (p.kind === 'assets') return placeLater(p.items.map(i => i.assetId), target);
        if (!options.addStock) return { ok: false, code: 'STOCK_UNAVAILABLE', message: 'Stock media cannot be added here.' };
        pending = options.addStock(p.item).then(a => { assets.set(a.id, a); report(run('Add items', doc => place(doc, [a], target))); }).catch(e => notify(`${(e as RecordData).code ?? 'STOCK_FAILED'}: ${(e as Error).message}`));
        return { ok: true };
      }
      case 'addMarker': return run('Add marker', doc => { addMarker(doc, intent.timeMs); });
      case 'removeMarker': return run('Remove marker', doc => removeMarker(doc, intent.markerId));
      case 'clearMarkers': return run('Clear markers', doc => { doc.markers = []; });
      case 'deleteTrack': return run('Delete track', doc => deleteTrack(doc, intent.trackId));
      case 'renameTrack': return run('Rename track', doc => manageTrack(doc, { action: 'rename', trackId: intent.trackId, name: intent.name }));
      case 'setTrackFlag': return run('Set track flag', doc => manageTrack(doc, { action: FLAG_ACTION[intent.flag], trackId: intent.trackId, value: intent.value }));
      case 'setTrackVolume': return run('Set track volume', doc => manageTrack(doc, { action: 'volume', trackId: intent.trackId, volume: intent.volume }));
      case 'resizeTrack': return run('Resize track', doc => {
        const t = track(doc, intent.trackId); if (!t) fail('TRACK_NOT_FOUND', `Track '${intent.trackId}' not found.`);
        t.height = Math.min(120, Math.max(36, Math.round(intent.height))); // W3-CC-03: clamped to 36–120 px
      });
      case 'moveTrackLayer': return run('Move track layer', doc => moveTrackLayer(doc, intent.trackId, intent.beforeTrackId));
      // Xapp has no "Move track out of group" undo label; the layer move is recorded as "Move track layer" (provisional).
      case 'moveTrackOutOfGroup': return run('Move track layer', doc => moveTrackOutOfGroup(doc, intent.trackId));
      case 'groupTracks': return run('Group tracks', doc => { createGroup(doc, intent.trackIds, intent.name); });
      case 'setGroupFlag': return run('Set group flag', doc => manageTrackGroup(doc, { action: intent.flag === 'hidden' ? 'hide' : 'lock', groupId: intent.groupId, value: intent.value }));
      case 'reorderGroup': return run('Reorder group', doc => reorderGroupStep(doc, intent.groupId, intent.direction));
      case 'ungroupTracks': return run('Ungroup tracks', doc => ungroup(doc, intent.groupId));
      case 'deleteGroup': return run('Delete group', doc => deleteGroup(doc, intent.groupId));
      case 'resizeCanvas': return run('Resize canvas', doc => { resizeCanvas(doc, intent.aspectRatio); });
      // T04 (part 3 §45.1 labels): speed is "Change speed"; property values, keyframes and the remap switch are "Edit items".
      case 'changeSpeed': return run('Change speed', doc => {
        const i = item(doc, intent.itemId); if (i) checkProperty(i, 'playbackRate', intent.rate);
        changeSpeed(doc, intent.itemId, intent.rate, intent.ripple);
      });
      case 'toggleTimeRemap': return run('Edit items', doc => intent.on ? remapOn(doc, intent.itemId) : remapOff(doc, intent.itemId));
      case 'setUseProxy': return run('Edit items', doc => { setUseProxy(doc, { itemId: intent.itemId, useProxy: intent.on }); });
      case 'addKeyframe': return run('Edit items', doc => addKeyframe(doc, intent.itemId, intent.key, intent.atMs, intent.effect));
      case 'addFade': return run('Edit items', doc => addFade(doc, intent.itemId, intent.edge));
      case 'setKeepPitch': return run('Edit items', doc => setKeepPitch(doc, intent.itemId, intent.on));
      case 'editKeyframe': return run('Edit items', doc => editKeyframe(doc, intent.target, intent.patch));
      // No target: the keymap's keyframe branch with no keyframe selected in the graph editor; nothing to delete.
      case 'deleteKeyframe': { const target = intent.target; return target ? run('Edit items', doc => deleteKeyframe(doc, target)) : { ok: true }; }
      case 'editProperty': if (intent.owner !== 'T04' && intent.owner !== 'T05' && intent.owner !== 'T06') return undefined; // T09 / T22 keep their visible stubs.
        return run('Edit items', (doc, tx) => {
          editProperties(doc, { itemIds: intent.itemIds, properties: { [intent.key]: intent.value } });
          if (intent.key === 'playbackRate') tx.label = 'Change speed';
        });
      // T05: the Text panel's Add text (W3-ED-22: one "Add items"); several text keys in one "Edit items" (preset tiles, gradient).
      case 'addTextPreset': return run('Add items', doc => { addTextPreset(doc); });
      case 'editTextProperties': return run('Edit items', doc => { editProperties(doc, { itemIds: intent.itemIds, properties: intent.properties }, undefined, intent.refit === true); });
      case 'addBlankMotionGraphic': return run('Add items', doc => { addBlankGraphic(doc, intent.startMs, intent.endMs); });
      // T22: My Presets (T08's intent) and the preset library share one path; a saved preset's missing fonts and assets are named.
      case 'addGraphicPreset': case 'applyStylePreset': {
        const outcome = run('Add items', doc => { applyStylePreset(doc, intent.preset); });
        if (outcome.ok) for (const m of missingFor(intent.preset, live.map(l => l.agentId))) notify(m);
        return outcome;
      }
      case 'repairMotionGraphic': return run('Edit items', doc => {
        const i = item(doc, intent.itemId);
        if (!i || i.type !== 'motionGraphic') fail('ITEM_NOT_FOUND', 'Item not found');
        i.details = { ...i.details, code: intent.code };
      });
      case 'editGraphicField': return run('Edit items', doc => {
        const i = item(doc, intent.itemId);
        if (!i || i.type !== 'motionGraphic') fail('ITEM_NOT_FOUND', 'Item not found');
        const values = i.details?.fieldValues;
        i.details = { ...i.details, fieldValues: { ...values && typeof values === 'object' && !Array.isArray(values) ? values : {}, [intent.name]: intent.value } };
      });
      // T06 (W3-RT-08: a drawn shape is one "Add items" entry; pen edits and Add path keyframe are "Edit items").
      case 'drawShape': return run('Add items', doc => { drawShape(doc, intent); });
      case 'editShapePath': return run('Edit items', doc => editShapePath(doc, intent.itemId, intent.points, intent.playheadMs));
      case 'removeShapePoint': return run('Edit items', doc => removeShapePoint(doc, intent.itemId, intent.index, intent.playheadMs));
      case 'addPathKeyframe': return run('Edit items', doc => addPathKeyframe(doc, intent.itemId, intent.playheadMs));
      // T07 (W3-RT-09: a layout tile is one "Add items" entry; a footage drop on a cell and every cell edit "Edit items").
      case 'addLayout': return run('Add items', doc => { addLayoutTile(doc, intent.layoutType); });
      case 'layoutEdit': return run('Edit items', doc => editLayoutCell(doc, intent.itemId, intent.op, id => assets.get(id)));
      case 'maskEdit': return run('Edit items', doc => editMask(doc, intent.itemId, intent.op));
      case 'removeBackground': return refusal(() => { startRemoval({ ...tools, origin: 'user' }, intent.itemId).done.catch(() => undefined); });
      // T11 (part 3 §46.8): the diamond, each popover pick or edge drag, the trash.
      case 'addTransition': return run('Add transition', doc => { addAtCut(doc, intent.fromId, intent.toId); });
      case 'editTransition': return run('Edit transition', doc => { editTransition(doc, intent.transitionId, intent.patch); });
      case 'removeTransition': return run('Remove transition', doc => removeTransition(doc, intent.transitionId));
      // T10 (contracts #29: a UI add from the Effects tab is one "Edit items" entry; every stack edit uses the same label).
      case 'addEffect': return run('Edit items', doc => addEffect(doc, intent.itemIds, intent.effectId));
      case 'toggleEffect': return run('Edit items', doc => toggleEffect(doc, intent.itemId, intent.instanceId, intent.enabled));
      case 'removeEffect': return run('Edit items', doc => removeEffect(doc, intent.itemId, intent.instanceId));
      case 'moveEffect': return run('Edit items', doc => moveEffect(doc, intent.itemId, intent.instanceId, intent.to));
      case 'effectParams': return run('Edit items', doc => editEffectParams(doc, intent.itemId, intent.instanceId, intent.values));
      case 'resetEffect': return run('Edit items', doc => resetEffect(doc, intent.itemId, intent.instanceId));
      case 'colourBlock': return run('Edit items', doc => editColourBlock(doc, intent.itemIds, intent.effectId, intent.values));
      case 'bypassGrade': return run('Edit items', doc => bypassGrade(doc, intent.itemIds, intent.enabled));
      case 'resetGrade': return run('Edit items', doc => resetGrade(doc, intent.itemIds));
      // T09: the Captions panel generates on the bus (resolved transcripts travel with the intent, auto-created tracks + panel style);
      // the inspector's Transform is a caption-only "Edit items" (the shared caption property whitelist stays style + text).
      case 'generateCaptions': {
        let generated: RecordData = {};
        const outcome = run(intent.reset ? 'Regenerate captions' : 'Add captions', doc => {
        // addCaptionsIn's startTime / endTime are the agent's seconds (toMs ×1000); the panel's range is editor milliseconds.
        const result = addCaptionsPanel(doc, { source: intent.button, sourceItems: intent.sourceItems, startTime: intent.range ? intent.range.startMs / 1000 : undefined, endTime: intent.range ? intent.range.endMs / 1000 : undefined,
          splitBySpeaker: intent.split, templateId: intent.templateId, maxWords: intent.maxWords, maxCharacters: intent.maxCharacters, fontSize: intent.fontSize, borderWidth: intent.borderWidth,
          fontFamily: intent.fontFamily, fontWeight: intent.fontWeight, fontStyle: intent.fontStyle, color: intent.color, backgroundColor: intent.backgroundColor, textDecoration: intent.textDecoration, borderColor: intent.borderColor, boxShadow: intent.boxShadow,
          breakOnPunctuation: intent.breakOnPunctuation, breakOnConjunctions: intent.breakOnConjunctions, reset: intent.reset },
          id => intent.data[id] ?? NO_CAPTION_DATA);
        if (result.success) generated = result.data ?? {};
        });
        if (outcome.ok && generated.captionCount === 0) notify(`No words found. ${generated.replacedCount ?? 0} captions removed.`);
        return outcome;
      }
      case 'editCaptionTransform': return run('Edit items', doc => { editCaptionTransform(doc, intent.itemIds, intent.properties); });
      default: return undefined; // T15 / later owners keep their visible stubs.
    }
  };
  const tools: ToolContext = { bus, asset: id => assets.get(id), assetLinks: () => live };
  const call = (name: string, args: RecordData = {}): ToolResult => callTool(tools, name, args);
  /** Set duration / Set fps / Set background, one undo step each (no UI control or agent tool reaches them yet). */
  const setSetting = (label: 'Set duration' | 'Set fps' | 'Set background', change: Parameters<typeof setSettings>[1]) => run(label, doc => setSettings(doc, change));
  /** T22 (agent addMedia): the built-in's project asset, indexed under its stored id and under the catalogue id. */
  const addCatalogue = async (id: string) => {
    if (!options.addCatalogue) throw new CommandError('UPLOAD_FAILED', 'Built-in elements and sounds cannot be added here.');
    const a = await options.addCatalogue(id);
    assets.set(a.id, a); assets.set(id, a);
    return a;
  };
  return { bus, assets, setAssets, handle, call, tools, setSetting, addCatalogue, idle: () => pending };
}

// ---- Persistence (settings rows of the T01 store).
type HistoryRow = { id: string; at: string; undo: HistoryEntry[]; redo: HistoryEntry[] };
/** FNV-1a of the snapshot JSON: identifies the document state a saved history ends at. */
export function fingerprint(doc: ProjectDocument): string {
  const s = JSON.stringify(snapshot(doc));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}.${h.toString(36)}`;
}
export const historyKey = (projectId: string) => `history:${projectId}`;
export const journalKey = (r: JournalRecord) => `journal:${r.project_id}:${r.session_id}:${r.seq}`;
type Store = Pick<ProjectStore, 'row' | 'putRow' | 'library'>;

/** The runtime bound to the open editor (the agent tools of later tickets call `activeRuntime.call`). */
export let activeRuntime: Runtime | undefined;
/** Binds a runtime to the editor session: intent handler, history seam, persisted history (restored when the stored
 *  document is the state it ends at), journal rows. Returns the uninstall function. */
export function installRuntime(session: AutosaveSession, store: Store, projectId: string, options: RuntimeOptions = {}): () => void {
  const journal = new EditJournal(projectId, records => Promise.all(records.map(r => store.putRow('settings', { id: journalKey(r), ...r }))).then(() => undefined), undefined, undefined, () => notify('The edit journal could not be saved. Editing continues.'));
  const loadAssets = async () => { const lib = await store.library(); return { assets: lib.assets, links: lib.links.filter(l => l.projectId === projectId) }; };
  // History: restored only onto the exact state it ends at; a reload / keep-mine that replaces the document clears it.
  let known = session.document, knownAt = fingerprint(known), timer: ReturnType<typeof setTimeout> | undefined, alive = true, setting = false;
  const host: Host = { get: () => session.document, set: d => { setting = true; try { session.update(d); } finally { setting = false; } known = session.document; knownAt = fingerprint(known); } };
  const runtime = createRuntime(host, { ...options, journal: r => journal.record(r), loadAssets });
  activeRuntime = runtime;
  void loadAssets().then(r => { runtime.setAssets(r.assets, r.links); if (alive) options.onAssets?.(runtime.tools); }).catch(() => {});
  const save = () => { clearTimeout(timer); timer = undefined; const row: HistoryRow = { id: historyKey(projectId), at: fingerprint(session.document), undo: runtime.bus.undoStack, redo: runtime.bus.redoStack }; return store.putRow('settings', row).catch(() => {}); };
  void store.row<HistoryRow>('settings', historyKey(projectId)).then(row => {
    if (alive && row && row.at === fingerprint(session.document) && !runtime.bus.undoStack.length && !runtime.bus.redoStack.length) runtime.bus.restore(row.undo, row.redo);
  }).catch(() => {});
  const offBus = runtime.bus.subscribe(() => { clearTimeout(timer); timer = setTimeout(() => void save(), 500); });
  const offSession = session.subscribe(() => {
    if (setting || session.document === known) return;
    const at = fingerprint(session.document); known = session.document;
    if (at !== knownAt) { knownAt = at; runtime.bus.clear(); }
  });
  const uninstallHandler = installIntentHandler(runtime.handle);
  const seam = { canUndo: history.canUndo, canRedo: history.canRedo };
  history.canUndo = () => runtime.bus.canUndo(); history.canRedo = () => runtime.bus.canRedo();
  const unbindJournal = journal.bindLifecycle();
  const hide = () => { if (document.visibilityState === 'hidden' && timer !== undefined) void save(); };
  document.addEventListener('visibilitychange', hide);
  return () => {
    alive = false; uninstallHandler(); offBus(); offSession(); unbindJournal(); document.removeEventListener('visibilitychange', hide);
    history.canUndo = seam.canUndo; history.canRedo = seam.canRedo;
    if (timer !== undefined) void save();
    void journal.flush();
    if (activeRuntime === runtime) activeRuntime = undefined;
  };
}
