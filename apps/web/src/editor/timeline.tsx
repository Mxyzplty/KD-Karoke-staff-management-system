// SPDX-License-Identifier: AGPL-3.0-only
// Timeline view (inventory §2, §15; findings §15, §23; part 2 §29, §37; part 3 §45.4, §46.12, §46.14): toolbar, ruler,
// marker lane, track headers and group rows, lanes with clips, trim handles, context menus and the track-grouping
// selection mode. View changes (playhead, zoom, scroll, selection, tool mode, toggles) are applied here; every edit is
// dispatched as an intent to its owner (T03), which refuses visibly until it exists.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectDocument, RecordData, Asset } from '../store/model';
import { Dialog, InlineName, notify } from '../ui';
import { dispatch, history } from './commands';
import { copySelection, deleteSelection, duplicateSelection, handleKey, splitSelection, zoomBy } from './actions';
import { carriesPayload, readPayload } from './dnd';
import { clipColour, clipMenu, contentWidth, displayRows, frameAt, hiddenTrackIds, MARKER_LANE_PX, nextGroupName, reconcileZoom, resizedHeight, RULER_PX, showTrimHandles, snap, snapTargets, tickInterval, tickLabel, ticks, timecode, toggleGroupCheck, trackGroups, trackHeight, trimHalo, WAVEFORM_LANE_PX, zoomToFit } from './geometry';
import type { Row } from './geometry';
import { Menu, MenuButton } from './controls';
import type { MenuItem } from './controls';
import { select, setUi, setView, toggleToolMode, useView, view } from './view';
import { span } from '../timeline/model';
import { KEYFRAME_PROPERTIES, prop, remapKeyframes, toTimelineMs } from '../timeline/properties';
import { effectStack, paramProp } from '../timeline/effects';
import { usePlayback } from '../render/playback';
import { cutsByTrack, TransitionMarks } from './transition-ui';
import { Waveform } from './waveform';

export const HEADER_PX = 200;
type Ctx = { doc: ProjectDocument; assets: Map<string, Asset> };
// T06: a shape's label is its stored name ("Shape heart"; findings §20).
const itemName = (item: RecordData, assets: Map<string, Asset>) => item.details?.name ?? (item.type === 'shape' && typeof item.name === 'string' ? item.name : undefined) ?? assets.get(item.metadata?.assetId)?.name ?? item.details?.text ?? item.type;
const hasSound = (item: RecordData, assets: Map<string, Asset>) => item.type === 'video' && !!assets.get(item.metadata?.assetId)?.media?.audio;
const xOf = (ms: number) => ms * view().zoom;
/** T04 (W3-ED-11): each keyframed property's diamonds on its clip unless its eye hides them. Time Remap's diamonds follow
 *  the remap eye; with that eye off a yellow "1" badge sits at the clip's end (seen in Xapp, meaning unproven — the
 *  remap diamonds and the badge are provisional, not Xapp parity). */
function clipKeyframes(item: RecordData, width: number) {
  const hidden = view().keyframesHidden, local = (ms: number) => ms >= -0.5 && ms <= span(item) + 0.5;
  const marks: { key: string; id: string; ms: number }[] = [];
  for (const key of KEYFRAME_PROPERTIES) if (!hidden.includes(`${item.id}:${key}`))
    for (const k of prop(item, key)?.keyframes ?? []) marks.push({ key, id: k.id, ms: toTimelineMs(item, k.time) - item.display.from });
  // T10: effect parameter keyframes too, each behind its own eye (`<instance id>.<key>`).
  for (const e of effectStack(item)) for (const key of Object.keys(e.parameters ?? {})) if (!hidden.includes(`${item.id}:${e.id}.${key}`))
    for (const k of paramProp(e, key)?.keyframes ?? []) marks.push({ key: `${e.id}.${key}`, id: k.id, ms: toTimelineMs(item, k.time) - item.display.from });
  const remap = remapKeyframes(item), remapHidden = hidden.includes(`${item.id}:timeRemap`);
  if (item.timeRemap && !remapHidden) for (const k of remap) marks.push({ key: 'timeRemap', id: k.id, ms: k.time });
  return <>{marks.filter(m => local(m.ms)).map(m => <span key={`${m.key}:${m.id}`} className="clip-kf" data-kf-key={m.key} aria-hidden="true" style={{ left: xOf(m.ms) }} />)}
    {item.timeRemap && remapHidden && <span className="clip-kf-badge" aria-hidden="true" style={{ left: Math.max(0, width - 14) }}>1</span>}</>;
}
const msAt = (clientX: number, lanes: HTMLElement) => Math.max(0, (clientX - lanes.getBoundingClientRect().left) / view().zoom);

function Toolbar({ doc }: Ctx) {
  const v = useView(), selected = v.selection.length > 0, ripple = v.toolMode === 'ripple', playing = usePlayback(p => p.playing);
  if (v.groupSelection) {
    const n = v.groupSelection.checked.length;
    return <div className="timeline-toolbar" role="toolbar" aria-label="Group tracks">
      <span>Choose adjacent tracks to group.</span>
      <button onClick={() => setView({ groupSelection: null })}>Cancel</button>
      <button className="primary" disabled={n < 2} onClick={() => setView({ drawer: 'name-group' })}>Group ({n})</button>
    </div>;
  }
  return <div className="timeline-toolbar" role="toolbar" aria-label="Timeline">
    <button aria-label={ripple ? 'Ripple Delete' : 'Delete'} disabled={!selected} onClick={deleteSelection}>{ripple ? '⌫⇤' : '⌫'}</button>
    <button aria-label="Split" disabled={!selected} onClick={splitSelection}>✂</button>
    <button aria-label="Clone" disabled={!selected} onClick={duplicateSelection}>⧉</button>
    <button aria-label="Slip" aria-pressed={v.toolMode === 'slip'} onClick={() => toggleToolMode('slip')}>⇔</button>
    <button aria-label="Ripple" aria-pressed={ripple} onClick={() => toggleToolMode('ripple')}>⇤</button>
    <span className="divider" />
    <button aria-label="Undo" disabled={!history.canUndo()} onClick={() => dispatch({ type: 'undo' })}>↶</button>
    <button aria-label="Redo" disabled={!history.canRedo()} onClick={() => dispatch({ type: 'redo' })}>↷</button>
    <button aria-label={playing ? 'Pause' : 'Play'} onClick={() => dispatch({ type: 'togglePlayback' })}>{playing ? '⏸' : '▶'}</button>
    <span className="timecode" aria-label="Timecode">{timecode(v.playheadMs)} | {timecode(doc.duration)}</span>
    <span className="divider" />
    <button aria-label="Snapping" aria-pressed={v.ui.snapping} onClick={() => setUi({ snapping: !v.ui.snapping })}>⊐</button>
    <button aria-label="Markers" aria-pressed={v.ui.markersVisible} onClick={() => setUi({ markersVisible: !v.ui.markersVisible })}>⚑</button>
    <button aria-label="Waveform lanes" aria-pressed={v.ui.waveforms} onClick={() => setUi({ waveforms: !v.ui.waveforms })}>∿</button>
    <span className="divider" />
    <button aria-label="Zoom out" onClick={() => zoomBy('out', doc)}>−</button>
    <button aria-label="Zoom in" onClick={() => zoomBy('in', doc)}>+</button>
    <button aria-label="Zoom to fit" onClick={() => setView(zoomToFit(v.laneWidth, doc.duration))}>⤢</button>
  </div>;
}

type Drag = { kind: 'move' | 'trim-start' | 'trim-end' | 'slip'; itemId: string; x: number; dx: number; px: number; snapMs: number | null; moved: boolean; trackId: string | null; below: boolean };
export function Timeline({ doc, assets }: Ctx) {
  const v = useView(), scroller = useRef<HTMLDivElement>(null), lanes = useRef<HTMLDivElement>(null);
  const rows = displayRows(doc, new Set(v.collapsedGroups)), parents = trackGroups(doc), laneCuts = cutsByTrack(doc);
  const [menu, setMenu] = useState<{ x: number; y: number; label: string; items: MenuItem[] }>(), [drag, setDrag] = useState<Drag>(), [rename, setRename] = useState<string>();
  const [resize, setResize] = useState<{ trackId: string; start: number; y: number; height: number }>(), [reorder, setReorder] = useState<string>();
  const width = Math.max(v.laneWidth, contentWidth(v.zoom, doc.duration));
  const locked = (trackId: string) => !!doc.tracks.find(t => t.id === trackId)?.locked || !!(parents.get(trackId) && doc.groups[parents.get(trackId)!]?.locked);
  // Lane width from the viewport; the fit floor and the scroll clamp follow every size or duration change (W3-RT-11).
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const measure = () => { const laneWidth = Math.max(1, el.clientWidth - HEADER_PX), s = view(); setView({ laneWidth, ...reconcileZoom(s, laneWidth, doc.duration) }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
  }, [doc.duration]);
  useEffect(() => { const el = scroller.current; if (el && Math.abs(el.scrollLeft - v.scroll) > 0.5) el.scrollLeft = v.scroll; }, [v.scroll, v.zoom]);
  const openClipMenu = (e: React.MouseEvent, item: RecordData) => {
    e.preventDefault(); e.stopPropagation();
    if (!view().selection.includes(item.id)) select([item.id]);
    const s = view(), state = clipMenu(item, { playheadMs: s.playheadMs, locked: locked(item.trackId), grouped: parents.has(item.trackId), clipboard: s.clipboard.length, slipping: s.toolMode === 'slip' });
    const ids = view().selection, items: MenuItem[] = [];
    if (state.moveOutOfGroup !== null) items.push({ label: 'Move out of group', disabled: !state.moveOutOfGroup, onSelect: () => dispatch({ type: 'moveItemOutOfGroup', itemId: item.id }) });
    items.push({ label: 'Split at playhead', disabled: !state.split, onSelect: () => dispatch({ type: 'splitItems', itemIds: [item.id], atMs: view().playheadMs }) },
      { label: 'Duplicate', disabled: !state.duplicate, onSelect: () => dispatch({ type: 'duplicateItems', itemIds: ids }) },
      { label: state.slipLabel, disabled: !state.slip, onSelect: () => toggleToolMode('slip') },
      { label: 'Copy', disabled: !state.copy, onSelect: () => copySelection(doc) },
      { label: 'Paste at playhead', disabled: !state.paste, onSelect: () => dispatch({ type: 'pasteItems', items: view().clipboard, atMs: view().playheadMs }) },
      { label: 'Delete', danger: true, disabled: !state.delete, onSelect: () => dispatch({ type: 'deleteItems', itemIds: ids, ripple: view().toolMode === 'ripple' }) });
    setMenu({ x: e.clientX, y: e.clientY, label: 'Clip actions', items });
  };
  const openTrackMenu = (e: React.MouseEvent, track: RecordData) => {
    e.preventDefault(); e.stopPropagation();
    const grouped = parents.has(track.id), items: MenuItem[] = [
      grouped ? { label: 'Move track out of group', onSelect: () => dispatch({ type: 'moveTrackOutOfGroup', trackId: track.id }) }
        : { label: 'Group tracks…', onSelect: () => { if (view().modes.timelineLocked || drag) notify('Tracks can’t be grouped while the timeline is locked or a drag is in progress.'); else setView({ groupSelection: { origin: track.id, checked: toggleGroupCheck(rows, [], track.id) } }); } },
      { label: 'Delete track', danger: true, onSelect: () => dispatch({ type: 'deleteTrack', trackId: track.id }) }];
    setMenu({ x: e.clientX, y: e.clientY, label: `Track ${track.name}`, items });
  };
  // Pointer drags of clips, trim handles and slips: geometry and snapping live here; the edit is T03's, on release.
  const startDrag = (e: React.PointerEvent, item: RecordData, kind: Drag['kind']) => {
    if (e.button !== 0) return;
    e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: view().toolMode === 'slip' && kind === 'move' ? 'slip' : kind, itemId: item.id, x: e.clientX, dx: 0, px: e.clientX, snapMs: null, moved: false, trackId: null, below: false });
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, moved = drag.moved || Math.abs(dx) >= 3; if (!moved) return;
    const item = doc.items.find(i => i.id === drag.itemId)!, s = view(), deltaMs = dx / s.zoom;
    let snapped = deltaMs, snapMs: number | null = null;
    if (s.ui.snapping && drag.kind !== 'slip') {
      const exclude = new Set(drag.kind === 'move' ? s.selection.concat(item.id) : [item.id]), hidden = hiddenTrackIds(doc);
      const targets = snapTargets(doc, { zoom: s.zoom, playheadMs: s.playheadMs, exclude, hiddenTracks: hidden, rangeMs: [s.scroll / s.zoom, (s.scroll + s.laneWidth) / s.zoom] });
      const from = item.display.from, length = item.display.to - from;
      const r = drag.kind === 'move' ? snap(from + deltaMs, length, targets, s.zoom) : snap((drag.kind === 'trim-start' ? from : item.display.to) + deltaMs, 0, targets, s.zoom);
      if (r.target !== null) { snapMs = r.target; snapped = drag.kind === 'move' ? r.startMs - from : r.startMs - (drag.kind === 'trim-start' ? from : item.display.to); }
    }
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null, over = under?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId ?? null;
    setDrag({ ...drag, dx: snapped * s.zoom, px: e.clientX, snapMs, moved: true, trackId: over && over !== item.trackId ? over : null, below: !!under?.closest('.drop-below') });
  };
  const endDrag = () => {
    if (!drag) return; setDrag(undefined); if (!drag.moved) return;
    const deltaMs = drag.dx / view().zoom, ripple = view().toolMode === 'ripple';
    // Ripple reorder picks its slot by the pointer, not by where the clip lands (part 3 §45.1, W3-RT-13).
    const pointer = ripple && lanes.current ? { pointer: { ms: msAt(drag.px, lanes.current), windowMs: 12 / view().zoom } } : {};
    if (drag.kind === 'move') dispatch({ type: 'moveItems', itemIds: view().selection.includes(drag.itemId) ? view().selection : [drag.itemId], deltaMs, trackId: drag.trackId, newTrack: drag.below, ripple, ...pointer });
    else if (drag.kind === 'slip') dispatch({ type: 'slipItem', itemId: drag.itemId, deltaMs });
    else dispatch({ type: 'trimItem', itemId: drag.itemId, edge: drag.kind === 'trim-start' ? 'start' : 'end', deltaMs, ripple });
  };
  const seek = (e: React.PointerEvent<HTMLElement>) => { if (lanes.current) setView({ playheadMs: Math.min(doc.duration, frameAt(msAt(e.clientX, lanes.current), doc.fps)) }); };
  const drop = (e: React.DragEvent, trackId: string | null, below: boolean) => {
    if (!lanes.current) return;
    const payload = carriesPayload(e.dataTransfer) ? readPayload(e.dataTransfer) : null; e.preventDefault(); e.stopPropagation();
    if (payload) dispatch({ type: 'drop', payload, trackId, timeMs: msAt(e.clientX, lanes.current), below });
  };
  const allowDrop = (e: React.DragEvent) => { if (carriesPayload(e.dataTransfer)) e.preventDefault(); };
  const trackRow = (row: Extract<Row, { kind: 'track' }>) => {
    const t = row.track, items = doc.items.filter(i => i.trackId === t.id), height = resize && resize.trackId === t.id ? resize.height : trackHeight(t);
    const waveform = v.ui.waveforms && t.kind === 'video' && items.some(i => hasSound(i, assets)), checked = v.groupSelection?.checked.includes(t.id) ?? false;
    const eligible = v.groupSelection ? toggleGroupCheck(rows, v.groupSelection.checked, t.id) !== v.groupSelection.checked : false;
    return <div key={t.id} className={`track-row ${t.hidden ? 'hidden-track' : ''}`} style={{ height: height + (waveform ? WAVEFORM_LANE_PX : 0) }}>
      <div className={`track-header ${reorder && reorder !== t.id ? 'reorder-target' : ''}`} style={{ paddingLeft: 6 + row.depth * 12 }} onContextMenu={e => openTrackMenu(e, t)}
        onPointerUp={() => { if (reorder && reorder !== t.id) dispatch({ type: 'moveTrackLayer', trackId: reorder, beforeTrackId: t.id }); setReorder(undefined); }}>
        {v.groupSelection && <input type="checkbox" aria-label={`Select ${t.name} for the group`} checked={checked} disabled={!checked && !eligible} onChange={() => setView(s => ({ groupSelection: s.groupSelection && { ...s.groupSelection, checked: toggleGroupCheck(rows, s.groupSelection.checked, t.id) } }))} />}
        <span className="drag-handle" role="button" tabIndex={-1} aria-label={`Reorder ${t.name}`} onPointerDown={e => { if (e.button === 0) { e.preventDefault(); setReorder(t.id); } }}>⋮⋮</span>
        <div className="track-title">
          {rename === t.id ? <InlineName initial={t.name} label="Track name" cancel={() => setRename(undefined)} commit={name => { setRename(undefined); dispatch({ type: 'renameTrack', trackId: t.id, name }); }} />
            : <span className="track-name" onDoubleClick={() => setRename(t.id)}>{t.name}</span>}
          <small className="item-count">{items.length}</small>
        </div>
        <div className="track-icons" role="group" aria-label={`${t.name} controls`}>
          {(['hidden', 'muted', 'solo', 'locked'] as const).map(flag => <button key={flag} aria-label={`${({ hidden: 'Hide', muted: 'Mute', solo: 'Solo', locked: 'Lock' })[flag]} ${t.name}`} aria-pressed={!!t[flag]} onClick={() => dispatch({ type: 'setTrackFlag', trackId: t.id, flag, value: !t[flag] })}>{({ hidden: '◉', muted: '♪', solo: 'S', locked: '🔒︎' })[flag]}</button>)}
          <input type="range" aria-label={`${t.name} volume`} min={0} max={100} step={1} defaultValue={Math.round((t.volume ?? 1) * 100)} key={`${t.id}:${t.volume ?? 1}`}
            onPointerUp={e => { const volume = Number(e.currentTarget.value) / 100; if (volume !== (t.volume ?? 1)) dispatch({ type: 'setTrackVolume', trackId: t.id, volume }); e.currentTarget.value = String(Math.round((t.volume ?? 1) * 100)); }}
            onKeyUp={e => { if (e.key.startsWith('Arrow')) { const volume = Number(e.currentTarget.value) / 100; if (volume !== (t.volume ?? 1)) dispatch({ type: 'setTrackVolume', trackId: t.id, volume }); e.currentTarget.value = String(Math.round((t.volume ?? 1) * 100)); } }} />
        </div>
        <span className="resize-handle" aria-hidden="true" onPointerDown={e => { if (e.button !== 0) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setResize({ trackId: t.id, start: trackHeight(t), y: e.clientY, height: trackHeight(t) }); }}
          onPointerMove={e => { if (resize && resize.trackId === t.id) setResize({ ...resize, height: resizedHeight(resize.start, e.clientY - resize.y) }); }}
          onPointerUp={() => { if (resize && resize.trackId === t.id) { setResize(undefined); if (resize.height !== resize.start) dispatch({ type: 'resizeTrack', trackId: t.id, height: resize.height }); } }} />
      </div>
      <div className={`lane kind-${t.kind}`} data-track-id={t.id} role="listbox" aria-label={`${t.name} clips`} aria-multiselectable="true" style={{ width }}
        onPointerDown={e => { if (e.target === e.currentTarget && e.button === 0) select([]); }} onDragOver={allowDrop} onDrop={e => drop(e, t.id, false)}>
        {items.map(item => clip(item, height))}
        <TransitionMarks doc={doc} trackId={t.id} laneCuts={laneCuts.get(t.id) ?? []} zoom={v.zoom} height={height} clipMenu={openClipMenu} />
        {waveform && <div className="waveform-lane" style={{ top: height }}>{items.filter(i => hasSound(i, assets)).map(i => <div key={i.id} className="waveform-clip" style={{ left: xOf(i.display.from), width: xOf(i.display.to - i.display.from) }} onContextMenu={e => openClipMenu(e, i)}>
          <Waveform item={i} left={xOf(i.display.from)} width={xOf(i.display.to - i.display.from)} height={WAVEFORM_LANE_PX - 6} zoom={v.zoom} scroll={v.scroll} view={v.laneWidth} /><span>Audio</span></div>)}</div>}
      </div>
    </div>;
  };
  const clip = (item: RecordData, height: number) => {
    const left = xOf(item.display.from), w = xOf(item.display.to - item.display.from), selected = v.selection.includes(item.id), dragging = !!drag && drag.itemId === item.id && drag.moved;
    const offset = dragging && drag!.kind === 'move' ? drag!.dx : 0, trimStart = dragging && drag!.kind === 'trim-start' ? drag!.dx : 0, trimEnd = dragging && drag!.kind === 'trim-end' ? drag!.dx : 0;
    // Keyboard path (review R3): clips are in the Tab order; Enter selects the focused clip (Shift/Ctrl/Cmd+Enter adds or
    // removes it). Enter is not in the written key table, and a focused clip stays in the timeline zone, so the editor keys
    // (Space, ←/→, nudges, Delete) keep working from it.
    return <div key={item.id} role="option" tabIndex={0} aria-selected={selected} aria-label={`${itemName(item, assets)}, ${item.type}, ${timecode(item.display.from)} to ${timecode(item.display.to)}`} data-item-id={item.id}
      className={`clip clip-${clipColour(item.type)} ${selected ? 'selected' : ''}`} style={{ left: left + offset + trimStart, width: Math.max(1, w - trimStart + trimEnd), height: height - 6 }}
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); if (e.ctrlKey || e.metaKey || e.shiftKey) select(selected ? v.selection.filter(id => id !== item.id) : [...v.selection, item.id]); else if (!selected) select([item.id]); startDrag(e, item, 'move'); }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); e.stopPropagation(); if (e.ctrlKey || e.metaKey || e.shiftKey) select(selected ? v.selection.filter(id => id !== item.id) : [...v.selection, item.id]); else select([item.id]); } }}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(undefined)} onContextMenu={e => openClipMenu(e, item)}>
      {item.type === 'audio' && v.ui.waveforms && <Waveform item={item} left={left} width={w} height={height - 6} zoom={v.zoom} scroll={v.scroll} view={v.laneWidth} />}
      <span className="clip-label">{itemName(item, assets)}</span>
      {clipKeyframes(item, w)}
      {showTrimHandles(w) && (['start', 'end'] as const).map(edge => <span key={edge} className={`trim-handle trim-${edge} halo-${trimHalo(item, edge)}`} data-halo={trimHalo(item, edge)} aria-hidden="true"
        onPointerDown={e => { if (e.button === 0) { e.stopPropagation(); if (!selected) select([item.id]); startDrag(e, item, edge === 'start' ? 'trim-start' : 'trim-end'); } }} />)}
    </div>;
  };
  const groupRow = (row: Extract<Row, { kind: 'group' }>) => {
    const g = row.group, collapsed = v.collapsedGroups.includes(g.id);
    const flag = (f: 'hidden' | 'locked') => dispatch({ type: 'setGroupFlag', groupId: g.id, flag: f, value: !g[f] });
    return <div key={`g:${g.id}`} className="track-row group-row">
      <div className="track-header group-header" style={{ paddingLeft: 6 + row.depth * 12 }} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}>
        <button aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${g.name}`} aria-expanded={!collapsed} onClick={() => setView(s => ({ collapsedGroups: collapsed ? s.collapsedGroups.filter(id => id !== g.id) : [...s.collapsedGroups, g.id] }))}>{collapsed ? '▸' : '▾'}</button>
        <button aria-label={`Hide ${g.name}`} aria-pressed={!!g.hidden} onClick={() => flag('hidden')}>◉</button>
        <span className="track-name">{g.name}</span><small className="item-count">{row.members.length}</small>
        <button aria-label={`Move ${g.name} up`} onClick={() => dispatch({ type: 'reorderGroup', groupId: g.id, direction: 'up' })}>↑</button>
        <button aria-label={`Move ${g.name} down`} onClick={() => dispatch({ type: 'reorderGroup', groupId: g.id, direction: 'down' })}>↓</button>
        <button aria-label={`Ungroup ${g.name}`} onClick={() => dispatch({ type: 'ungroupTracks', groupId: g.id })}>⊟</button>
        <MenuButton label={`${g.name} actions`} items={[{ label: 'Hide group', onSelect: () => flag('hidden') }, { label: 'Lock group', onSelect: () => flag('locked') },
          { label: 'Ungroup', onSelect: () => dispatch({ type: 'ungroupTracks', groupId: g.id }) }, { label: 'Delete group and contents', danger: true, onSelect: () => dispatch({ type: 'deleteGroup', groupId: g.id }) }]}>…</MenuButton>
      </div>
      <div className="lane group-lane" style={{ width }} />
    </div>;
  };
  const interval = tickInterval(v.zoom), markers = v.ui.markersVisible ? doc.markers : [];
  return <section className="timeline" aria-label="Timeline" data-tour="timeline">
    <Toolbar doc={doc} assets={assets} />
    <div ref={scroller} className="timeline-scroll" data-zone="timeline" tabIndex={0} onScroll={e => setView({ scroll: e.currentTarget.scrollLeft })}
      onKeyDown={e => { handleKey(e.nativeEvent, 'timeline', doc); }} onPointerUp={() => setReorder(undefined)}>
      <div className="timeline-content" style={{ width: HEADER_PX + width }}>
        <div className="ruler-row" style={{ height: RULER_PX + (v.ui.markersVisible ? MARKER_LANE_PX : 0) }}>
          <div className="track-header corner" />
          <div ref={lanes} className="ruler-lanes" style={{ width }}>
            <div className="ruler" style={{ height: RULER_PX }} aria-label="Ruler" onPointerDown={e => { if (e.button === 0) { e.currentTarget.setPointerCapture(e.pointerId); seek(e); } }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e); }}
              onContextMenu={e => { e.preventDefault(); const at = frameAt(msAt(e.clientX, lanes.current!), doc.fps); setMenu({ x: e.clientX, y: e.clientY, label: 'Ruler', items: [{ label: 'Add Marker (M)', onSelect: () => dispatch({ type: 'addMarker', timeMs: Math.min(doc.duration, at) }) }] }); }}>
              {ticks(v.zoom, v.scroll, v.laneWidth).map(t => <span key={t} className="tick" style={{ left: xOf(t) }}>{tickLabel(t, interval)}</span>)}
            </div>
            {v.ui.markersVisible && <div className="marker-lane" role="listbox" aria-label="Markers" style={{ height: MARKER_LANE_PX }} onContextMenu={e => e.preventDefault()}>
              {markers.map(m => <span key={m.id} className={`marker ${v.markerId === m.id ? 'selected' : ''}`} role="option" tabIndex={-1} aria-selected={v.markerId === m.id} aria-label={`Marker at ${timecode(m.timeMs)}${m.label ? `: ${m.label}` : ''}`} style={{ left: xOf(m.timeMs) }}
                onPointerDown={e => { if (e.button === 0) { e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); } }} onClick={() => setView({ markerId: m.id, selection: [] })} />)}
            </div>}
          </div>
        </div>
        {rows.map(row => row.kind === 'group' ? groupRow(row) : trackRow(row))}
        <div className="track-row below-tracks"><div className="track-header corner" /><div className="lane drop-below" style={{ width }} onPointerDown={e => { if (e.button === 0) select([]); }} onDragOver={allowDrop} onDrop={e => drop(e, null, true)}>{!rows.length && <p>Add footage to start. Drop media here or click a thumbnail in Footage.</p>}</div></div>
        <div className="playhead" style={{ left: HEADER_PX + xOf(v.playheadMs) }} aria-hidden="true" />
        {drag?.snapMs != null && <div className="snap-line" data-snap-ms={drag.snapMs} style={{ left: HEADER_PX + xOf(drag.snapMs) }} aria-hidden="true" />}
      </div>
    </div>
    {menu && <Menu label={menu.label} x={menu.x} y={menu.y} items={menu.items} close={() => setMenu(undefined)} />}
    {v.drawer === 'name-group' && v.groupSelection && <NameGroup doc={doc} close={() => setView({ drawer: null })} />}
  </section>;
}
/** "Name group": the name is optional; blank = the next free "Group n". Create dispatches T03's "Group tracks". */
function NameGroup({ doc, close }: { doc: ProjectDocument; close: () => void }) {
  const [name, setName] = useState(''), placeholder = nextGroupName(doc.groups);
  const create = () => { const checked = view().groupSelection?.checked ?? []; close(); setView({ groupSelection: null }); dispatch({ type: 'groupTracks', trackIds: [...checked].reverse(), name: name.trim() || placeholder }); };
  return <Dialog title="Name group" close={close}>
    <form onSubmit={e => { e.preventDefault(); create(); }}><label>Group name<input autoFocus aria-label="Group name" placeholder={placeholder} value={name} onChange={e => setName(e.target.value)} /></label>
      <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary">Create</button></div></form>
  </Dialog>;
}
