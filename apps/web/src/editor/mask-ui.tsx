// SPDX-License-Identifier: AGPL-3.0-only
// T12 mask UI (part 3 §46.13, part 2 §36; wave-3 fixtures in the T12 ticket): the Mask section of the inspector (Add Mask, Mask
// Layers, the layer cards) and the "Editing path" stage overlay (Shape list, Pen Tool, AI Smart Mask, Clear, Cancel, Apply mask; keys
// A, I, Esc, Enter, Delete). Every write is one "Edit items" through the `maskEdit` intent; drawing and dragging write nothing until
// release, and Add Mask, Cancel and Apply write nothing at all.
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { notify } from '../ui';
import { activeRemoval, useMaskJobs } from '../masks/jobs';
import { MASK_MODES, MASK_RANGE, masksOf } from '../masks/model';
import type { MaskKey, MaskMode, StoredMask } from '../masks/model';
import type { MaskOp } from '../masks/tools';
import { boxMatrix, itemBox, projectSize } from '../render/model';
import type { ProjectDocument, RecordData } from '../store/model';
import { span } from '../timeline/model';
import { evaluate, propertyTime, toTimelineMs } from '../timeline/properties';
import { activeRuntime } from '../timeline/runtime';
import { invert, mapPoints, pathAt, pathKeyframes, pathString, presetPoints, r2, SHAPE_TYPES, shifted } from '../timeline/shapes';
import type { PathPoint, Pt, ShapeType } from '../timeline/shapes';
import { dispatch } from './commands';
import { Slider } from './controls';
import { Switch } from './inspector';
import { enterMaskEdit, leaveMaskEdit, maskDeleted, openMaskEditor, setMaskTool, useMaskUi } from './mask-state';
import { near, neg, overlay, pillButton, typing } from './shape-ui';
import { clearSelection, SmartBrush, trackSelection } from './smart-mask-ui';
import { useView, view } from './view';

const send = (itemId: string, op: MaskOp) => dispatch({ type: 'maskEdit', itemId, op });
const holder = (m: StoredMask) => m as unknown as RecordData;
const title = (s: string) => s[0].toUpperCase() + s.slice(1);
const localAt = (item: RecordData, playheadMs: number) => Math.min(Math.max(playheadMs - item.display.from, 0), span(item));
/** Part 3 §46.13 records blue and orange; the rest of the cycle is Cutframe's. */
const DOTS = ['#3b82f6', '#f97316', '#22c55e', '#a855f7', '#ef4444', '#eab308'];
const ROWS: [MaskKey, string, string][] = [['feather', 'Feather', 'px'], ['expansion', 'Expansion', 'px'], ['opacity', 'Opacity', '%']];
const perStep = () => activeRuntime?.bus.options.sliderEntries === 'step';

// ---- The Mask section.
type Row = { doc: ProjectDocument; item: RecordData; mask: StoredMask; index: number };
function MaskValue({ doc, item, mask, index, k, label, unit }: Row & { k: MaskKey; label: string; unit: string }) {
  const v = useView(), kfs = mask.keyframes?.[k]?.keyframes ?? [], local = localAt(item, v.playheadMs), inside = v.playheadMs >= item.display.from && v.playheadMs <= item.display.to;
  const value = Number(evaluate(kfs, mask[k], propertyTime(item, local))), at = kfs.find(f => Math.abs(toTimelineMs(item, f.time) - v.playheadMs) <= 500 / doc.fps);
  return <div className={`prop-row${at ? ' on-keyframe' : ''}`}>
    <Slider label={label} value={value} range={{ ...MASK_RANGE[k], step: 1 }} unit={unit} perStep={perStep} onCommit={n => send(item.id, { op: 'value', index, key: k, value: n, atMs: v.playheadMs })} />
    <span className="kf-tools"><button className={`kf-diamond${at ? ' filled' : ''}`} aria-label={at ? `${label} keyframe at playhead` : `Add ${label} keyframe`} aria-pressed={!!at} disabled={!inside}
      title={inside ? undefined : 'Move the playhead over this clip to add a keyframe'} onClick={() => send(item.id, { op: 'keyframe', index, key: k, atMs: v.playheadMs })}>◆</button></span>
  </div>;
}
function MaskPath({ doc, item, mask, index }: Row) {
  const v = useView(), kfs = pathKeyframes(holder(mask)), inside = v.playheadMs >= item.display.from && v.playheadMs <= item.display.to, at = kfs.find(f => Math.abs(toTimelineMs(item, f.time) - v.playheadMs) < 1000 / doc.fps);
  return <div className={`prop-row${at ? ' on-keyframe' : ''}`}><span>Path</span>
    <span className="kf-tools"><button className={`kf-diamond${at ? ' filled' : ''}`} aria-label={at ? 'Path keyframe at playhead' : 'Add Path keyframe'} aria-pressed={!!at} disabled={!inside}
      title={inside ? undefined : 'Move the playhead over this clip to add a keyframe'} onClick={() => send(item.id, { op: 'keyframe', index, key: 'path', atMs: v.playheadMs })}>◆</button></span>
  </div>;
}
function MaskCard({ doc, item, mask, index, rank, count }: Row & { rank: number; count: number }) {
  const smart = mask.source === 'smart', patch = (p: Partial<StoredMask>) => send(item.id, { op: 'patch', index, patch: p }), r = mask.raster;
  const remove = () => { if (send(item.id, { op: 'delete', index }).ok) maskDeleted(index); };
  return <div className={`effect-card${mask.enabled ? '' : ' off'}`} role="group" aria-label={mask.name}>
    <div className="card-heading">
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: DOTS[(mask.colorIndex ?? 0) % DOTS.length] }} />
      <h4 onClick={() => { if (!smart) openMaskEditor(item.id, index); }}>{mask.name}</h4><span className="chip">{smart ? 'Smart' : 'Manual'}</span>
      <span className="card-tools">
        <button aria-label={mask.enabled ? `Hide ${mask.name}` : `Show ${mask.name}`} aria-pressed={!mask.enabled} onClick={() => patch({ enabled: !mask.enabled })}>{mask.enabled ? '👁' : '⊘'}</button>
        <button aria-label={`Delete ${mask.name}`} onClick={remove}>🗑</button>
        <button aria-label={`Move ${mask.name} up`} disabled={rank === 0} onClick={() => send(item.id, { op: 'move', index, by: -1 })}>↑</button>
        <button aria-label={`Move ${mask.name} down`} disabled={rank === count - 1} onClick={() => send(item.id, { op: 'move', index, by: 1 })}>↓</button>
      </span>
    </div>
    <label className="row">Mode<select aria-label="Mask mode" value={mask.mode} onChange={e => patch({ mode: e.target.value as MaskMode })}>{MASK_MODES.map(m => <option key={m} value={m}>{title(m)}</option>)}</select></label>
    <div className="row"><span>Invert</span><Switch label="Invert" on={mask.inverted} onClick={() => patch({ inverted: !mask.inverted })} /></div>
    {ROWS.map(([k, label, unit]) => <MaskValue key={k} doc={doc} item={item} mask={mask} index={index} k={k} label={label} unit={unit} />)}
    {smart ? r && <p className="hint">Tracked {(r.sourceStartUs / 1e6).toFixed(2)}–{(r.sourceEndUs / 1e6).toFixed(2)}s in original video</p> : <MaskPath doc={doc} item={item} mask={mask} index={index} />}
  </div>;
}
/** The inspector's card and the Mask section's button start the same job; while it runs both show it, then the row returns to Apply. */
export function RemoveBackground({ item, label }: { item: RecordData; label: string }) {
  const job = useMaskJobs(s => activeRemoval(s.jobs, item.id));
  if (!job) return <button onClick={() => dispatch({ type: 'removeBackground', itemId: item.id })}>{label}</button>;
  return job.state === 'waiting' ? <span role="status">Waiting for a worker</span> : <span role="status">Processing mask {job.percent} %<progress max={100} value={job.percent} aria-label="Processing mask" /></span>;
}
/** Add Mask and "+" open the editor with no mask (no entry). */
export function MaskBody({ doc, item }: { doc: ProjectDocument; item: RecordData }) {
  const list = masksOf(item), cards = list.map((mask, index) => ({ mask, index })).sort((a, b) => a.mask.order - b.mask.order || a.index - b.index), add = () => openMaskEditor(item.id, null);
  return <><div className="row"><button onClick={add}>Add Mask</button>
    {item.type === 'video' && <RemoveBackground item={item} label="Remove Background" />}</div>
    {list.length > 0 && <div className="card-heading"><h4>Mask Layers</h4><button aria-label="Add mask layer" onClick={add}>+</button></div>}
    {cards.map(({ mask, index }, rank) => <MaskCard key={mask.id} doc={doc} item={item} mask={mask} index={index} rank={rank} count={cards.length} />)}</>;
}
/** The Mask header re-enters the path editor while a mask exists (§46.13). */
export const maskHeader = (doc: ProjectDocument, item: RecordData) => { if (masksOf(item).length) enterMaskEdit(doc, item.id); };

// ---- The stage overlay. As in ShapeOverlay its SVG viewBox is the project canvas; masks are stored item-local (part 5 §54.2).
type Drag = { k: number; part: 'anchor' | 'handleIn' | 'handleOut'; from: Pt; start: PathPoint[]; moved: boolean; free: boolean };
export function MaskOverlay({ doc }: { doc: ProjectDocument }) {
  const ui = useMaskUi(), v = useView(), svg = useRef<SVGSVGElement>(null), size = projectSize(doc), [px, setPx] = useState(1);
  const [rubber, setRubber] = useState<{ a: Pt; b: Pt } | null>(null), [pts, setPts] = useState<PathPoint[]>([]), pull = useRef<number | null>(null);
  const [draft, setDraft] = useState<PathPoint[] | null>(null), [picked, setPicked] = useState<number | null>(null), drag = useRef<Drag | null>(null);
  const item = ui.itemId ? doc.items.find(i => i.id === ui.itemId) : undefined, editing = item && ui.index !== null ? masksOf(item)[ui.index] : undefined, mask = editing?.source === 'smart' ? undefined : editing;
  const local = item ? localAt(item, v.playheadMs) : 0, m = item ? boxMatrix(itemBox(doc, item, local)) : null, inv = m && invert(m);
  const path = item && mask ? pathAt(holder(mask), propertyTime(item, local)) : null, shown = draft ?? (path && m ? mapPoints(m, path.points) : []);
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width > 0) setPx(size.width / r.width); };
    measure(); const o = new ResizeObserver(measure); o.observe(el); return () => o.disconnect();
  }, [size.width, !!item]);
  // Another selection, or the item going away, ends the editor; another tool or mask drops what is unfinished.
  useEffect(() => { if (ui.itemId && (v.selection[0] !== ui.itemId || !item)) leaveMaskEdit(); }, [ui.itemId, v.selection, !!item]);
  useEffect(() => { setPts([]); setRubber(null); pull.current = null; setPicked(null); clearSelection(); }, [ui.tool, ui.index, ui.itemId]);
  useEffect(() => () => leaveMaskEdit(), []);
  const added = () => { const list = activeRuntime?.bus.doc.items.find(i => i.id === ui.itemId); if (list) { useMaskUi.setState({ index: masksOf(list).length - 1 }); setMaskTool('path'); } };
  const draw = (canvas: PathPoint[]) => { if (item && inv && send(item.id, { op: 'draw', path: { points: mapPoints(inv, canvas), closed: true } }).ok) added(); };
  const clear = () => { setPts([]); setRubber(null); pull.current = null; clearSelection(); };
  const apply = () => { if (ui.tool === 'smart' && item) { trackSelection(item); return; } if (ui.tool === 'pen' && pts.length >= 3) draw(pts); leaveMaskEdit(); };
  const smartTool = () => { if (item?.type === 'video') setMaskTool(ui.tool === 'smart' ? 'path' : 'smart'); else notify('Smart masks only work on videos.'); };
  // Keys inside a dialog or menu are theirs, and an open popover or menu takes Escape first. In the smart tool Delete is the keymap's swallow.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = e => {
    if (!item || typing(e.target) || overlay(e.target) || e.ctrlKey || e.metaKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'Escape' && document.querySelector('.popover, [role="menu"]')) return;
    if (key === 'Escape') leaveMaskEdit();
    else if (key === 'Enter') apply();
    else if (key === 'a' && !e.altKey) smartTool();
    else if (key === 'i' && !e.altKey && editing) send(item.id, { op: 'patch', index: ui.index!, patch: { inverted: !editing.inverted } });
    else if ((key === 'Delete' || key === 'Backspace') && ui.tool !== 'smart' && ui.index !== null) {
      if (picked !== null) { send(item.id, { op: 'removePoint', index: ui.index, point: picked }); setPicked(null); }
      else if (send(item.id, { op: 'delete', index: ui.index }).ok) maskDeleted(ui.index);
    } else return;
    e.preventDefault(); e.stopPropagation();
  };
  useEffect(() => { const on = (e: KeyboardEvent) => keys.current(e); window.addEventListener('keydown', on, true); return () => window.removeEventListener('keydown', on, true); }, []);
  if (!item) return null;

  const at = (e: { clientX: number; clientY: number }): Pt => { const r = svg.current!.getBoundingClientRect(); return { x: (e.clientX - r.left) * size.width / r.width, y: (e.clientY - r.top) * size.height / r.height }; };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = at(e), target = (e.target as Element).closest('[data-k]') as SVGElement | null;
    if (ui.tool === 'shape') { e.currentTarget.setPointerCapture(e.pointerId); setRubber({ a: p, b: p }); return; }
    if (ui.tool === 'pen') {
      if (pts.length >= 3 && near(p, pts[0].anchor, 8 * px)) { draw(pts); return; }
      e.currentTarget.setPointerCapture(e.pointerId); pull.current = pts.length; setPts([...pts, { anchor: p }]); return;
    }
    if (ui.tool !== 'path' || !mask || !target) { setPicked(null); return; }
    const k = Number(target.dataset.k), part = target.dataset.part as Drag['part'];
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { k, part, from: p, start: shown, moved: false, free: e.altKey };
    if (part === 'anchor') setPicked(k);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = at(e);
    if (rubber) { setRubber({ ...rubber, b: p }); return; }
    if (pull.current !== null) { // Pen: dragging from a new anchor pulls mirrored handles.
      const k = pull.current, a = pts[k]?.anchor; if (!a) return;
      const out = { x: p.x - a.x, y: p.y - a.y };
      setPts(pts.map((q, n) => n !== k ? q : near(p, a, 2 * px) ? { anchor: a } : { anchor: a, handleIn: neg(out), handleOut: out }));
      return;
    }
    const d = drag.current; if (!d) return;
    const dx = p.x - d.from.x, dy = p.y - d.from.y;
    if (!d.moved && Math.hypot(dx, dy) < px) return;
    d.moved = true;
    setDraft(d.start.map((q, n) => {
      if (n !== d.k) return q;
      if (d.part === 'anchor') return { ...q, anchor: { x: q.anchor.x + dx, y: q.anchor.y + dy } };
      const h = { x: p.x - q.anchor.x, y: p.y - q.anchor.y }, other = d.part === 'handleIn' ? 'handleOut' : 'handleIn';
      return { ...q, [d.part]: h, ...d.free ? {} : { [other]: neg(h) } }; // handles mirror unless Alt was held at press
    }));
  };
  const box = (a: Pt, b: Pt) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
  const up = () => {
    if (rubber) {
      const { x, y, w, h } = box(rubber.a, rubber.b);
      setRubber(null);
      if (r2(w) > 0 && r2(h) > 0) draw(shifted(presetPoints(ui.shape, w, h), x, y));
      return;
    }
    pull.current = null;
    const d = drag.current; drag.current = null;
    if (d?.moved && draft && inv && item && ui.index !== null) send(item.id, { op: 'path', index: ui.index, points: mapPoints(inv, draft), atMs: view().playheadMs });
    setDraft(null);
  };

  const marker = 5 * px, line = { vectorEffect: 'non-scaling-stroke' as const, stroke: '#38bdf8', strokeWidth: 1.5, fill: 'none' };
  const drawing = ui.tool === 'pen' ? pts : ui.tool === 'path' ? shown : [], editable = ui.tool === 'path';
  const rubberBox = rubber && box(rubber.a, rubber.b), preview = rubberBox && rubberBox.w > 0 && rubberBox.h > 0 ? pathString({ points: shifted(presetPoints(ui.shape, rubberBox.w, rubberBox.h), rubberBox.x, rubberBox.y), closed: true }) : '';
  return <div className="mask-overlay" style={{ position: 'absolute', inset: 0 }}>
    <svg ref={svg} role="application" aria-label="Mask editor" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: editable ? 'default' : 'crosshair', touchAction: 'none' }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setRubber(null); pull.current = null; drag.current = null; setDraft(null); }}>
      {preview && <path d={preview} {...line} />}
      {drawing.length > 0 && <path data-testid="mask-outline" d={pathString({ points: drawing, closed: editable && !!path?.closed })} {...line} />}
      {drawing.flatMap((q, k) => (['handleIn', 'handleOut'] as const).filter(h => q[h]).map(h => {
        const c = { x: q.anchor.x + q[h]!.x, y: q.anchor.y + q[h]!.y };
        return <g key={`${k}${h}`}><line x1={q.anchor.x} y1={q.anchor.y} x2={c.x} y2={c.y} {...line} strokeWidth={1} />
          <circle cx={c.x} cy={c.y} r={marker * 0.8} fill="#0f172a" stroke="#38bdf8" vectorEffect="non-scaling-stroke" {...editable ? { 'data-k': k, 'data-part': h, 'aria-label': `Point ${k + 1} ${h === 'handleIn' ? 'in' : 'out'} handle`, role: 'button' } : {}} /></g>;
      }))}
      {drawing.map((q, k) => <rect key={k} x={q.anchor.x - marker} y={q.anchor.y - marker} width={2 * marker} height={2 * marker} fill={editable && picked === k ? '#38bdf8' : '#fff'} stroke="#0284c7" vectorEffect="non-scaling-stroke"
        {...editable ? { 'data-k': k, 'data-part': 'anchor', 'aria-label': `Point ${k + 1}`, role: 'button', 'aria-pressed': picked === k } : {}} />)}
    </svg>
    {ui.tool === 'smart' && <SmartBrush doc={doc} item={item} />}
    <div className="mask-pill" role="toolbar" aria-label="Editing path" style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6, alignItems: 'center', padding: '2px 8px', borderRadius: 999, background: 'rgb(0 0 0 / .7)', color: '#fff', fontSize: '.8rem', whiteSpace: 'nowrap' }}>
      <span>Editing path</span>
      <button style={pillButton} aria-pressed={ui.tool === 'shape'} onClick={() => setMaskTool(ui.tool === 'shape' ? 'path' : 'shape')}>Shape</button>
      {ui.tool === 'shape' && <select aria-label="Mask shape" value={ui.shape} onChange={e => useMaskUi.setState({ shape: e.target.value as ShapeType })}>{SHAPE_LIST.map(s => <option key={s} value={s}>{title(s)}</option>)}</select>}
      <button style={pillButton} aria-pressed={ui.tool === 'pen'} onClick={() => setMaskTool(ui.tool === 'pen' ? 'path' : 'pen')}>Pen Tool</button>
      <button style={pillButton} aria-pressed={ui.tool === 'smart'} disabled={item.type !== 'video'} onClick={smartTool}>AI Smart Mask</button>
      <button style={pillButton} onClick={clear}>Clear</button>
      <button style={pillButton} onClick={leaveMaskEdit}>Cancel (Esc)</button>
      <button style={pillButton} onClick={apply}>Apply mask (Enter)</button>
    </div>
  </div>;
}
/** §46.13's order; SHAPE_TYPES is the agent list. */
const SHAPE_LIST: ShapeType[] = ['ellipse', ...SHAPE_TYPES.filter(s => s !== 'ellipse')];
