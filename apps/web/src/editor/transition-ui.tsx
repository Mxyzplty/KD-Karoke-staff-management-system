// SPDX-License-Identifier: AGPL-3.0-only
// T11 timeline transition controls (findings part 3 §46.8; W3-ED-18, W3-RT-04): the "Add transition" diamond on a cut of two
// meeting clips of one track, the marker over the window (8 px edge zones resize it, the part between them opens the
// popover) and the popover (kind groups, direction arrows for Push and Wipe, Align End / Center / Start, the length readout,
// the trash). The diamond is one "Add transition" entry, each popover pick and each edge drag one "Edit transition" entry
// (the popover stays open), the trash one "Remove transition". A right-click on the marker opens the clip's menu (§46.14).
// Provisional, not Xapp parity (T11 notes): the marker's look and 16 px minimum width, the diamond only on video / image
// pairs, the arrow names, a click on a marker too narrow to open selecting the clip under the pointer, and the dip colour
// and wipe softness controls (a documented improvement, §46.8: Xapp has no UI for them).
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectDocument, RecordData } from '../store/model';
import { dispatch } from './commands';
import { Popover, Slider } from './controls';
import { select } from './view';
import { dipColour, wipeSoftness } from '../render/transitions';
import { alignmentOf, alignmentWord, ALIGNMENTS, cuts, durationOf, hasDirection, isVisual, KIND_GROUPS, KIND_LABELS, maxMs, MIN_MS, pairOf, transitionAt, windowOf, windowParts } from '../timeline/transitions';
import type { Direction, Kind } from '../timeline/transitions';

const EDGE_PX = 8, MIN_PX = 2 * EDGE_PX;
/** The picker's tooltips (paraphrased in §46.8). */
const TIPS: Record<Kind, string> = { fade: 'Dip through black', dissolve: 'Smooth opacity blend', additiveDissolve: 'Bright additive blend', dipToColorDissolve: 'Dissolve through a solid colour', slide: 'Push from a direction', wipe: 'Directional reveal with a feathered edge' };
const ARROWS: [Direction, string, string][] = [['from-left', '←', 'From left'], ['from-right', '→', 'From right'], ['from-top', '↑', 'From top'], ['from-bottom', '↓', 'From bottom']];
const ALIGN: [keyof typeof ALIGNMENTS, string, string][] = [['end', 'End', 'Ends at the cut'], ['center', 'Center', 'Centred on the cut'], ['start', 'Start', 'Starts at the cut']];
const hex = (c: unknown) => `#${dipColour(c).map(v => v.toString(16).padStart(2, '0')).join('')}`;
const unhex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

/** The length after moving one marker edge by dms: it changes by the drag distance (§46.8: a +1 s drag on a 1 s transition
 *  gave 1,995 ms) and the window keeps its alignment on the cut, so with Center both edges move symmetrically. Own (not
 *  measured): the same rule for End / Start, whose window stays anchored at the cut. Held between 100 ms and the larger of
 *  the stored length and the pair's maximum while dragging (§55.1); the release goes through the update step, which clamps. */
export function draggedMs(d0: number, edge: 'start' | 'end', dms: number, hi: number): number {
  return Math.min(hi, Math.max(MIN_MS, d0 + (edge === 'end' ? dms : -dms)));
}

type Edit = { kind?: Kind; durationMs?: number; alignment?: number; direction?: Direction; params?: unknown };
const edit = (r: RecordData, patch: Edit) => dispatch({ type: 'editTransition', transitionId: String(r.id), patch });

/** Native colour input committing on `change` (one entry per pick, not one per pointer move). */
function DipColour({ r }: { r: RecordData }) {
  const ref = useRef<HTMLInputElement>(null), value = hex(r.params?.color);
  useEffect(() => {
    const el = ref.current!, on = () => { if (el.value !== value) edit(r, { params: { ...r.params, color: unhex(el.value) } }); };
    el.addEventListener('change', on); return () => el.removeEventListener('change', on);
  }, [r, value]);
  return <label className="transition-colour">Colour <input ref={ref} key={value} type="color" aria-label="Dip colour" defaultValue={value} /></label>;
}
function TransitionPopover({ r, at, close }: { r: RecordData; at: CSSProperties; close: () => void }) {
  const a = alignmentOf(r), word = alignmentWord(a);
  return <div className="transition-popover-anchor" style={at}>
    <Popover label="Transition" close={close} className="transition-popover">
      <h4 className="transition-title">{KIND_LABELS[r.kind as Kind] ?? String(r.kind)}</h4>
      {KIND_GROUPS.map(([group, kinds]) => <div key={group} className="transition-group" role="group" aria-label={group}>
        <small>{group}</small>
        {kinds.map(k => <button key={k} aria-pressed={r.kind === k} title={TIPS[k]} onClick={() => edit(r, { kind: k })}>{KIND_LABELS[k]}</button>)}
      </div>)}
      {hasDirection(r.kind) && <div className="transition-group" role="group" aria-label="Direction">
        <small>Direction</small>
        {ARROWS.map(([d, arrow, name]) => <button key={d} aria-label={name} title={name} aria-pressed={r.direction === d} onClick={() => edit(r, { direction: d })}>{arrow}</button>)}
      </div>}
      <div className="transition-group" role="group" aria-label="Align">
        <small>Align</small>
        {ALIGN.map(([w, label, tip]) => <button key={w} title={tip} aria-pressed={word === w && (w !== 'center' || a === 0.5)} onClick={() => edit(r, { alignment: ALIGNMENTS[w] })}>{label}</button>)}
      </div>
      <p className="transition-duration"><output aria-label="Transition length">{(durationOf(r) / 1000).toFixed(2)}s</output> <small>drag edges to resize</small></p>
      {r.kind === 'dipToColorDissolve' && <DipColour r={r} />}
      {r.kind === 'wipe' && <Slider label="Softness" value={Math.round(wipeSoftness(r.params) * 100)} range={{ min: 0, max: 100, step: 1 }} unit="%" onCommit={v => edit(r, { params: { ...r.params, softness: v } })} />}
      <button className="danger" aria-label="Remove transition" title="Remove transition" onClick={() => { close(); dispatch({ type: 'removeTransition', transitionId: String(r.id) }); }}>🗑</button>
    </Popover>
  </div>;
}

type Drag = { edge: 'start' | 'end'; x: number; d0: number; hi: number; d: number; moved: boolean };
function Marker({ doc, r, zoom, height, clipMenu }: { doc: ProjectDocument; r: RecordData; zoom: number; height: number; clipMenu: (e: React.MouseEvent, item: RecordData) => void }) {
  const [drag, setDrag] = useState<Drag>(), [open, setOpen] = useState<CSSProperties>(), box = useRef<HTMLDivElement>(null);
  const pair = pairOf(doc, r), w = windowOf(doc, r);
  if (!pair || !w) return null;
  const a = alignmentOf(r), parts = drag ? windowParts(drag.d, a) : w, width = (parts.pre + parts.post) * zoom, shown = Math.max(MIN_PX, width);
  const left = (w.cut - parts.pre) * zoom - (shown - width) / 2, zones = shown > MIN_PX;
  const label = `${KIND_LABELS[r.kind as Kind] ?? String(r.kind)} transition, ${((drag?.d ?? durationOf(r)) / 1000).toFixed(2)}s`;
  /** The clip under the pointer: the outgoing one left of the cut, the incoming one from it. */
  const side = (e: React.MouseEvent) => { const lane = box.current!.parentElement!.getBoundingClientRect(); return (e.clientX - lane.left) / zoom < w.cut ? pair.from : pair.to; };
  const start = (e: React.PointerEvent, edge: Drag['edge']) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    const d0 = durationOf(r);
    setDrag({ edge, x: e.clientX, d0, hi: Math.max(d0, maxMs(pair.from, pair.to)), d: d0, moved: false });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, moved = drag.moved || Math.abs(dx) >= 3;
    if (moved) setDrag({ ...drag, moved, d: draggedMs(drag.d0, drag.edge, dx / zoom, drag.hi) });
  };
  const end = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag(undefined);
    if (!drag.moved) { if (!zones) select([side(e).id]); return; }
    const d = Math.round(drag.d);
    if (d !== drag.d0) edit(r, { durationMs: d });
  };
  const edgeZone = (edge: Drag['edge']) => <span className={`transition-edge transition-edge-${edge}`} aria-hidden="true"
    onPointerDown={e => start(e, edge)} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(undefined)} />;
  return <div ref={box} className={`transition-marker ${open ? 'open' : ''}`} data-transition-id={r.id} data-kind={r.kind} style={{ left, width: shown, top: 3, height: height - 6 }}
    onPointerDown={e => e.stopPropagation()} onContextMenu={e => clipMenu(e, side(e))}>
    {edgeZone('start')}
    {zones && <button className="transition-open" aria-label={label} aria-haspopup="dialog" aria-expanded={!!open} style={{ left: EDGE_PX, right: EDGE_PX }}
      onClick={() => { const b = box.current!.getBoundingClientRect(); setOpen({ left: b.left, top: b.top }); }} />}
    {!zones && <span className="transition-label" aria-label={label} />}
    {edgeZone('end')}
    {open && createPortal(<TransitionPopover r={r} at={open} close={() => setOpen(undefined)} />, document.body)}
  </div>;
}

type Cut = ReturnType<typeof cuts>[number];
/** The document's cuts grouped by track: one scan per timeline render, each lane gets its own list. */
export function cutsByTrack(doc: ProjectDocument): Map<string, Cut[]> {
  const out = new Map<string, Cut[]>();
  for (const c of cuts(doc)) { const list = out.get(c.from.trackId); if (list) list.push(c); else out.set(c.from.trackId, [c]); }
  return out;
}
/** One lane's transition controls: a diamond on each free cut of two video / image clips, a marker on each live record. */
export function TransitionMarks({ doc, trackId, laneCuts, zoom, height, clipMenu }: { doc: ProjectDocument; trackId: string; laneCuts: Cut[]; zoom: number; height: number; clipMenu: (e: React.MouseEvent, item: RecordData) => void }) {
  const free = laneCuts.filter(c => isVisual(c.from) && isVisual(c.to) && !transitionAt(doc, c.from.id, c.to.id));
  const records = (doc.transitions ?? []).filter(r => pairOf(doc, r)?.from.trackId === trackId);
  return <>
    {free.map(c => <button key={`${c.from.id}:${c.to.id}`} className="cut-diamond" aria-label="Add transition" title="Add transition" data-cut={`${c.from.id}:${c.to.id}`} style={{ left: c.to.display.from * zoom }}
      onPointerDown={e => e.stopPropagation()} onClick={() => dispatch({ type: 'addTransition', fromId: c.from.id, toId: c.to.id })}>◆</button>)}
    {records.map(r => <Marker key={r.id} doc={doc} r={r} zoom={zoom} height={height} clipMenu={clipMenu} />)}
  </>;
}
