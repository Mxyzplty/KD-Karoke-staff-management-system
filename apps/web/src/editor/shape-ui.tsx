// SPDX-License-Identifier: AGPL-3.0-only
// T06 shapes UI (findings part 3 §46.4 and the §46.6 Shape row; findings §20; W3-ED-08, W3-RT-08): the Shapes panel (fill,
// stroke, Draw with Rectangle / Ellipse / Polygon / Star, Pen Tool), the stage overlay that draws shapes and edits their
// paths (anchors, mirrored handles, close by clicking the first point, delete refused below the minimum), and the shape
// inspector bodies (Fill, Stroke, Transform's 2 centre buttons, Shape Path). Every write is one bus command through an
// intent: a new shape is "Add items", a path or property edit "Edit items". Drawing and dragging write nothing until release.
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';
import type { ProjectDocument, RecordData } from '../store/model';
import { boxMatrix, itemBox, projectSize } from '../render/model';
import { span } from '../timeline/model';
import { staticValue, toPropertyTime } from '../timeline/properties';
import { activeRuntime } from '../timeline/runtime';
import { invert, mapPoints, pathAt, pathKeyframes, pathString, presetPoints, r2, shifted } from '../timeline/shapes';
import type { PathPoint, Pt, ShapePath } from '../timeline/shapes';
import { dispatch } from './commands';
import { ColourPicker, Slider } from './controls';
import { PropRow, Switch, TransformBody } from './inspector';
import { select, useView, view } from './view';

/** The panel's 4 UI types (W3-ED-08); Polygon is a free point path stored as `polygon`, the others the agent's presets. */
export type UiShape = 'rectangle' | 'ellipse' | 'polygon' | 'star';
const UI_TYPES: [UiShape, string][] = [['rectangle', 'Rectangle'], ['ellipse', 'Ellipse'], ['polygon', 'Polygon'], ['star', 'Star']];
type Mode = { kind: 'draw'; type: UiShape } | { kind: 'pen' };
type ShapeUi = { fillColor: string; fillOpacity: number; transparent: boolean; strokeColor: string; strokeWidth: number; type: UiShape; mode: Mode | null; editing: string | null };
/** Panel settings for the next shape (§46.4 defaults), the drawing mode and the shape whose path is being edited (view state). */
export const useShapeUi = create<ShapeUi>(() => ({ fillColor: '#3b82f6', fillOpacity: 100, transparent: false, strokeColor: '#000000', strokeWidth: 0, type: 'rectangle', mode: null, editing: null }));
const setShapeUi = (patch: Partial<ShapeUi>) => useShapeUi.setState(patch);
/** The next shape's style: Transparent → fillOpacity 0 with the colour kept (Q6); stroke "none" while the width is 0 (W3-RT-08). */
export function panelStyle(s: ShapeUi = useShapeUi.getState()) {
  return { fillColor: s.fillColor, fillOpacity: s.transparent ? 0 : s.fillOpacity / 100, strokeColor: s.strokeWidth > 0 ? s.strokeColor : 'none', strokeWidth: s.strokeWidth, strokeOpacity: 1 };
}

export function ShapesPanel() {
  const s = useShapeUi(), draw = (type: UiShape) => setShapeUi({ type, mode: { kind: 'draw', type }, editing: null });
  return <section aria-label="Shapes" className="tool-panel"><h3>Shapes</h3>
    <fieldset aria-label="Fill color"><legend>Fill color</legend>
      <label className="row"><input type="checkbox" checked={s.transparent} onChange={e => setShapeUi({ transparent: e.target.checked })} /> Transparent</label>
      <label className="row">Color<ColourPicker label="Fill colour" value={s.fillColor} onChange={c => setShapeUi({ fillColor: c })} /></label>
      {!s.transparent && <Slider label="Opacity" value={s.fillOpacity} range={{ min: 0, max: 100, step: 1 }} onCommit={n => setShapeUi({ fillOpacity: n })} />}
    </fieldset>
    <fieldset aria-label="Stroke"><legend>Stroke</legend>
      <label className="row">Color<ColourPicker label="Stroke colour" value={s.strokeColor} onChange={c => setShapeUi({ strokeColor: c })} /></label>
      <label className="row">Width<input type="number" aria-label="Stroke width" min={0} max={50} step={1} value={s.strokeWidth}
        onChange={e => { const n = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(n)) setShapeUi({ strokeWidth: Math.min(50, Math.max(0, n)) }); }} /></label>
    </fieldset>
    <fieldset aria-label="Draw shape"><legend>Draw shape</legend>
      <select aria-label="Shape type" value={s.type} onChange={e => { const type = e.target.value as UiShape; if (s.mode?.kind === 'draw') draw(type); else setShapeUi({ type }); }}>
        {UI_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <button aria-pressed={s.mode?.kind === 'draw'} onClick={() => draw(s.type)}>Draw</button>
    </fieldset>
    <fieldset aria-label="Freeform"><legend>Freeform</legend>
      <button aria-pressed={s.mode?.kind === 'pen'} onClick={() => setShapeUi({ mode: { kind: 'pen' }, editing: null })}>Pen Tool</button>
      <p className="hint">Click to add points; drag to pull bezier handles; click the first point to close.</p>
    </fieldset>
  </section>;
}

// ---- The stage overlay. Its SVG viewBox is the project canvas, so one unit is one canvas px: a drag converts to canvas px
// by canvas width ÷ artboard width (W3-RT-08 fixture 2).
type EditDrag = { k: number; part: 'anchor' | 'handleIn' | 'handleOut'; from: Pt; start: PathPoint[]; moved: boolean; free: boolean };
const near = (a: Pt, b: Pt, d: number) => Math.hypot(a.x - b.x, a.y - b.y) <= d;
const neg = (p: Pt): Pt => ({ x: -p.x + 0, y: -p.y + 0 });
const pillButton = { background: 'transparent', color: '#fff', border: '1px solid rgb(255 255 255 / .4)', borderRadius: 999, padding: '0 8px', minHeight: 0 };
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
const overlay = (t: EventTarget | null) => t instanceof Element && !!t.closest('dialog, [role="dialog"], [role="menu"]');
/** A new shape at the playhead (one "Add items"); the drawing mode ends and the shape is selected; a Polygon or pen path
 *  then shows its points for editing. With no item on the timeline nothing is created (W3-RT-08 fixture 1). */
function place(doc: ProjectDocument, shapeType: string, path: ShapePath, edit: boolean) {
  setShapeUi({ mode: null });
  if (!doc.items.length) return;
  if (!dispatch({ type: 'drawShape', shapeType, path, playheadMs: view().playheadMs, style: panelStyle() }).ok) return;
  const made = activeRuntime?.bus.doc.items.at(-1);
  if (made?.type === 'shape') { select([made.id]); if (edit) setShapeUi({ editing: made.id }); }
}

export function ShapeOverlay({ doc }: { doc: ProjectDocument }) {
  const ui = useShapeUi(), v = useView(), svg = useRef<SVGSVGElement>(null), size = projectSize(doc), [px, setPx] = useState(1);
  const [rubber, setRubber] = useState<{ a: Pt; b: Pt } | null>(null), [pts, setPts] = useState<PathPoint[]>([]), pull = useRef<number | null>(null);
  const [draft, setDraft] = useState<PathPoint[] | null>(null), [picked, setPicked] = useState<number | null>(null), drag = useRef<EditDrag | null>(null);
  const mode = ui.mode, shape = ui.editing && v.selection[0] === ui.editing ? doc.items.find(i => i.id === ui.editing && i.type === 'shape') : undefined;
  const local = shape ? Math.min(Math.max(v.playheadMs - shape.display.from, 0), span(shape)) : 0, m = shape ? boxMatrix(itemBox(doc, shape, local)) : null;
  const path = shape ? pathAt(shape.details, toPropertyTime(shape, shape.display.from + local)) : null, shown = draft ?? (path && m ? mapPoints(m, path.points) : []);
  // Canvas px per screen px (marker sizes and hit distances are screen px).
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width > 0) setPx(size.width / r.width); };
    measure(); const o = new ResizeObserver(measure); o.observe(el); return () => o.disconnect();
  }, [size.width, !!mode || !!shape]);
  // Leaving a mode drops its unfinished points; another selection ends path editing.
  useEffect(() => { setPts([]); setRubber(null); pull.current = null; }, [mode]);
  useEffect(() => { if (ui.editing && v.selection[0] !== ui.editing) setShapeUi({ editing: null }); setPicked(null); }, [ui.editing, v.selection]);
  useEffect(() => () => setShapeUi({ mode: null, editing: null }), []);
  const finishPen = (closed: boolean) => { if (pts.length >= (closed ? 3 : 2)) place(doc, 'custom', { points: pts, closed }, true); };
  const finishPolygon = () => { if (pts.length >= 3) place(doc, 'polygon', { points: pts, closed: true }, true); };
  const confirm = () => mode?.kind === 'pen' ? (pts.length >= 2 ? finishPen(false) : setShapeUi({ mode: null })) : mode?.type === 'polygon' && pts.length >= 3 ? finishPolygon() : setShapeUi({ mode: null });
  // Escape cancels the drawing or ends path editing; Enter confirms; Delete / Backspace removes the picked point (not the item).
  // Keys inside a dialog or menu are theirs, and an open popover or menu takes Escape first (it closes, editing stays).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = e => {
    if (typing(e.target) || overlay(e.target) || (!mode && !shape)) return;
    if (e.key === 'Escape' && document.querySelector('.popover, [role="menu"]')) return;
    if (e.key === 'Escape') { if (mode) setShapeUi({ mode: null }); else setShapeUi({ editing: null }); }
    else if (e.key === 'Enter' && mode) confirm();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && shape && picked !== null) { dispatch({ type: 'removeShapePoint', itemId: shape.id, index: picked, playheadMs: view().playheadMs }); setPicked(null); }
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  useEffect(() => { const on = (e: KeyboardEvent) => keys.current(e); window.addEventListener('keydown', on, true); return () => window.removeEventListener('keydown', on, true); }, []);
  if (!mode && !shape) return null;

  const at = (e: { clientX: number; clientY: number }): Pt => { const r = svg.current!.getBoundingClientRect(); return { x: (e.clientX - r.left) * size.width / r.width, y: (e.clientY - r.top) * size.height / r.height }; };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = at(e), target = (e.target as Element).closest('[data-k]') as SVGElement | null;
    if (mode?.kind === 'draw' && mode.type !== 'polygon') { e.currentTarget.setPointerCapture(e.pointerId); setRubber({ a: p, b: p }); return; }
    if (mode?.kind === 'draw') { // Polygon: one anchor per click; a click on the first point closes it; a repeat click is not a point.
      if (pts.length >= 3 && near(p, pts[0].anchor, 8 * px)) finishPolygon();
      else if (!pts.length || !near(p, pts[pts.length - 1].anchor, 3 * px)) setPts([...pts, { anchor: p }]);
      return;
    }
    if (mode?.kind === 'pen') {
      if (pts.length >= 3 && near(p, pts[0].anchor, 8 * px)) { finishPen(true); return; }
      e.currentTarget.setPointerCapture(e.pointerId); pull.current = pts.length; setPts([...pts, { anchor: p }]); return;
    }
    if (!shape || !target) { setPicked(null); return; }
    const k = Number(target.dataset.k), part = target.dataset.part as EditDrag['part'];
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
  const up = () => {
    if (rubber) {
      const { a, b } = rubber, x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      setRubber(null);
      if (mode?.kind === 'draw' && r2(w) > 0 && r2(h) > 0) place(doc, mode.type, { points: shifted(presetPoints(mode.type as Exclude<UiShape, 'polygon'>, w, h), x, y), closed: true }, false);
      return;
    }
    pull.current = null;
    const d = drag.current; drag.current = null;
    if (d?.moved && draft && shape && m) {
      const inv = invert(m);
      if (inv) dispatch({ type: 'editShapePath', itemId: shape.id, points: mapPoints(inv, draft), playheadMs: view().playheadMs });
    }
    setDraft(null);
  };

  const marker = 5 * px, line = { vectorEffect: 'non-scaling-stroke' as const, stroke: '#38bdf8', strokeWidth: 1.5, fill: 'none' };
  const handles = (list: PathPoint[], editable: boolean) => list.flatMap((q, k) => (['handleIn', 'handleOut'] as const).filter(h => q[h]).map(h => {
    const c = { x: q.anchor.x + q[h]!.x, y: q.anchor.y + q[h]!.y };
    return <g key={`${k}${h}`}><line x1={q.anchor.x} y1={q.anchor.y} x2={c.x} y2={c.y} {...line} strokeWidth={1} />
      <circle cx={c.x} cy={c.y} r={marker * 0.8} fill="#0f172a" stroke="#38bdf8" vectorEffect="non-scaling-stroke" {...editable ? { 'data-k': k, 'data-part': h, 'aria-label': `Point ${k + 1} ${h === 'handleIn' ? 'in' : 'out'} handle`, role: 'button' } : {}} /></g>;
  }));
  const anchors = (list: PathPoint[], editable: boolean) => list.map((q, k) => <rect key={k} x={q.anchor.x - marker} y={q.anchor.y - marker} width={2 * marker} height={2 * marker}
    fill={editable && picked === k ? '#38bdf8' : '#fff'} stroke="#0284c7" vectorEffect="non-scaling-stroke" {...editable ? { 'data-k': k, 'data-part': 'anchor', 'aria-label': `Point ${k + 1}`, role: 'button', 'aria-pressed': picked === k } : {}} />);
  const preview = rubber && mode?.kind === 'draw' && mode.type !== 'polygon' ? (() => {
    const { a, b } = rubber, w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    return w > 0 && h > 0 ? pathString({ points: shifted(presetPoints(mode.type, w, h), Math.min(a.x, b.x), Math.min(a.y, b.y)), closed: true }) : '';
  })() : '';
  const drawing = mode ? pts : shown, closed = !mode && !!path?.closed;
  const label = mode?.kind === 'pen' ? 'Pen Tool' : mode ? 'Drawing Shape' : 'Editing path';
  return <div className="shape-overlay" style={{ position: 'absolute', inset: 0 }}>
    <svg ref={svg} role="application" aria-label={mode ? 'Shape drawing area' : 'Shape path editor'} viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: mode ? 'crosshair' : 'default', touchAction: 'none' }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setRubber(null); pull.current = null; drag.current = null; setDraft(null); }}
      onDoubleClick={() => { if (mode?.kind === 'draw' && mode.type === 'polygon') finishPolygon(); }}>
      {preview && <path d={preview} {...line} />}
      {drawing.length > 0 && <path data-testid="shape-outline" d={pathString({ points: drawing, closed })} {...line} />}
      {handles(drawing, !mode)}{anchors(drawing, !mode)}
    </svg>
    <div className="shape-pill" role="toolbar" aria-label={label} style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6, alignItems: 'center', padding: '2px 8px', borderRadius: 999, background: 'rgb(0 0 0 / .7)', color: '#fff', fontSize: '.8rem' }}>
      <span>{label}</span>
      {mode ? <><button aria-label="Cancel drawing" style={pillButton} onClick={() => setShapeUi({ mode: null })}>✕</button><button aria-label="Confirm drawing" style={pillButton} onClick={confirm}>✓</button></>
        : <button style={pillButton} onClick={() => setShapeUi({ editing: null })}>Done</button>}
    </div>
  </div>;
}

// ---- Inspector bodies (part 3 §46.6 Shape row). Property edits use the T04 rows and the same "Edit items" path.
type Body = { doc: ProjectDocument; item: RecordData };
const edit = (item: RecordData, label: string, key: string, value: unknown) => dispatch({ type: 'editProperty', itemIds: [item.id], owner: 'T06', label, key, value });
/** Fill: Enabled (off stores fillColor "none"; on restores #3b82f6), Color (solid only), Fill % (fill opacity). */
export function FillBody({ doc, item }: Body) {
  const colour = String(staticValue(item, 'fillColor') ?? '#3b82f6'), on = colour !== 'none';
  return <><div className="row"><span>Enabled</span><Switch label="Fill Enabled" on={on} onClick={() => edit(item, 'Fill', 'fillColor', on ? 'none' : '#3b82f6')} /></div>
    {on && <><label className="row">Color<ColourPicker key={item.id} label="Fill colour" value={colour} onChange={c => edit(item, 'Fill colour', 'fillColor', c)} /></label>
      <PropRow doc={doc} item={item} k="fillOpacity" /></>}</>;
}
/** Stroke: Enabled ("None" = strokeColor "none"); on: Color #000000 and Width (typed values clamp to 0–50; W3-ED-08). */
export function StrokeBody({ doc, item }: Body) {
  const colour = String(staticValue(item, 'strokeColor') ?? 'none'), on = colour !== 'none';
  return <><div className="row"><span>Enabled</span><Switch label="Stroke Enabled" on={on} onClick={() => edit(item, 'Stroke', 'strokeColor', on ? 'none' : '#000000')} />{!on && <span>None</span>}</div>
    {on && <><label className="row">Color<ColourPicker key={item.id} label="Stroke colour" value={colour} onChange={c => edit(item, 'Stroke colour', 'strokeColor', c)} /></label>
      <PropRow doc={doc} item={item} k="strokeWidth" /></>}</>;
}
/** Transform: centre horizontally / vertically (W3-ED-15: the drawn box centred on the canvas, 0.01 px), then T04's rows. */
export function ShapeTransformBody({ doc, item }: Body) {
  const centre = (axis: 'x' | 'y') => {
    const b = itemBox(doc, item, Math.min(Math.max(view().playheadMs - item.display.from, 0), span(item))), p = projectSize(doc);
    if (axis === 'x') edit(item, 'Centre horizontally', 'positionX', r2((p.width - Math.abs(b.W * b.sx)) / 2));
    else edit(item, 'Centre vertically', 'positionY', r2((p.height - Math.abs(b.H * b.sy)) / 2));
  };
  return <><div className="row" role="group" aria-label="Align"><button aria-label="Centre horizontally" onClick={() => centre('x')}>⇹</button><button aria-label="Centre vertically" onClick={() => centre('y')}>⤒</button></div>
    <TransformBody doc={doc} item={item} /></>;
}
/** Shape Path: "No keyframes" or the count, Add path keyframe at the playhead (for morphing), and Edit path (the stage's
 *  point editor; Cutframe control, Xapp's entry to it is unrecorded). */
export function ShapePathBody({ item }: Body) {
  const v = useView(), editing = useShapeUi(s => s.editing) === item.id, n = pathKeyframes(item.details).length;
  const inside = v.playheadMs >= item.display.from && v.playheadMs <= item.display.to;
  return <><p>{n ? `${n} path keyframe${n === 1 ? '' : 's'}` : 'No keyframes'}</p>
    <button disabled={!inside} title={inside ? undefined : 'Move the playhead over this clip to add a path keyframe'} onClick={() => dispatch({ type: 'addPathKeyframe', itemId: item.id, playheadMs: v.playheadMs })}>Add path keyframe</button>
    <button aria-pressed={editing} onClick={() => setShapeUi({ editing: editing ? null : item.id, mode: null })}>Edit path</button></>;
}
