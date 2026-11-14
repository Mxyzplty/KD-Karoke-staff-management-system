// SPDX-License-Identifier: AGPL-3.0-only
// T26 preview selection box (research 7.1; D90): one overlay draws the box, the 5 handles, the centre guides and the marquee, and
// holds all press handling. Presses are read from the stage (native listeners), and every hit test is geometry in canvas px
// (selection-box.ts), so a press on a text hit box above it in the DOM still reaches it. A drag shows a draft document on the
// preview (PreviewFrames reads useSelectionDraft) and commits one "Edit items" on release (lane A's Q3, kept by Author).
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { ProjectDocument } from '../store/model';
import { apply, boxMatrix, fpsOf, itemBox, projectSize, snapTime } from '../render/model';
import { frameMasks } from '../masks/model';
import { rasterPlane } from '../masks/raster';
import { maskCanvas } from '../masks/render';
import { item as itemOf } from '../timeline/model';
import { invert, segments } from '../timeline/shapes';
import type { Pt } from '../timeline/shapes';
import { dispatch } from './commands';
import { useMaskUi } from './mask-state';
import { useShapeUi } from './shape-ui';
import { select, useView, view } from './view';
import { atPlayhead, boundsOf, cornerDrag, corners, frameOf, handleAt, handles, HANDLE_PX, itemLocal, LINE_PX, MARQUEE_MIN, marqueeHits, moveDrag, pickAt, rotationDrag, screenPx, shownItems, writeEdits } from './selection-box';
import type { AlphaAt, Corner, InsidePath, MaskReads, PreviewEdit } from './selection-box';

/** The live drag's draft document, the only place it is kept: the preview draws it, the box follows it, release drops it. */
export const useSelectionDraft = create<{ doc: ProjectDocument | null }>(() => ({ doc: null }));
type Drag = { kind: 'move' | 'corner' | 'rotate' | 'marquee'; corner?: Corner; ids: string[]; from: Pt; to?: Pt; base: ProjectDocument; t: number; zoom: number; edits?: PreviewEdit[]; prior?: string[] };

/** The raster branch's read: the item's combined mask alpha at p (Author's ruling e; background removal is a mask). No mask left at the playhead: 255.
 *  A raster mask with no frame yet: null (combinedPlane would count it as covering nothing). Same W × H as the compositor, so its cache is shared. */
const maskAlpha = (doc: ProjectDocument, t: number): AlphaAt => (item, p) => {
  const local = itemLocal(item, t), masks = frameMasks(item, local, fpsOf(doc));
  if (!masks.length) return 255;
  if (masks.some(m => m.raster && !rasterPlane(m.raster.ref, m.raster.timeUs))) return null;
  const b = itemBox(doc, item, local), W = Math.max(1, Math.trunc(b.W)), H = Math.max(1, Math.trunc(b.H)), inv = invert(boxMatrix(b));
  if (!inv) return null;
  const [u, v] = apply(inv, p.x, p.y), x = Math.min(W - 1, Math.max(0, Math.floor(u))), y = Math.min(H - 1, Math.max(0, Math.floor(v)));
  return maskCanvas(item.id, masks, W, H).getContext('2d')!.getImageData(x, y, 1, 1).data[3];
};
/** The vector branch's read: inside the bare path by the non-zero rule. The path is a copy of masks/render.ts `trace` (0 points empty,
 *  1 point a circle of radius 3, coordinates rounded to 0.01 px), which is not exported; the follow-up ticket exports it and imports it here. */
let probe: OffscreenCanvasRenderingContext2D | null = null;
const insidePath: InsidePath = (path, p) => {
  const { points } = path, r = (v: number) => Math.round(v * 100) / 100, q = new Path2D();
  if (!points.length) return false;
  if (points.length === 1) q.arc(r(points[0].anchor.x), r(points[0].anchor.y), 3, 0, 2 * Math.PI);
  else {
    q.moveTo(r(points[0].anchor.x), r(points[0].anchor.y));
    for (const g of segments(path)) if (g.c1 && g.c2) q.bezierCurveTo(r(g.c1.x), r(g.c1.y), r(g.c2.x), r(g.c2.y), r(g.to.x), r(g.to.y)); else q.lineTo(r(g.to.x), r(g.to.y));
    if (path.closed && points.length >= 3) q.closePath();
  }
  return (probe ??= new OffscreenCanvas(1, 1).getContext('2d')!).isPointInPath(q, p.x, p.y, 'nonzero');
};
const reads = (doc: ProjectDocument, t: number): MaskReads => ({ alpha: maskAlpha(doc, t), inside: insidePath });

export function SelectionOverlay({ doc }: { doc: ProjectDocument }) {
  const v = useView(), draft = useSelectionDraft(s => s.doc), mask = useMaskUi(s => s.itemId), shape = useShapeUi(s => !!s.mode || !!s.editing);
  const root = useRef<SVGSVGElement>(null), drag = useRef<Drag | null>(null), [zoom, setZoom] = useState(1);
  const [guides, setGuides] = useState({ x: false, y: false }), [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const size = projectSize(doc), t = snapTime(v.playheadMs, fpsOf(doc)), off = !!mask || shape;
  const live = useRef({ doc, t, off }); live.current = { doc, t, off };
  useEffect(() => {
    const stage = root.current?.parentElement; if (!stage) return;
    // Zoom = screen px per canvas px: the stage's drawn width (its CSS scale included) over the canvas width.
    const zoomNow = () => stage.getBoundingClientRect().width / projectSize(live.current.doc).width;
    const measure = () => { const z = zoomNow(); if (z > 0) setZoom(z); };
    measure();
    const resize = new ResizeObserver(measure), scale = new MutationObserver(measure);
    resize.observe(stage); scale.observe(stage, { attributes: true, attributeFilter: ['data-scale'] });
    const at = (e: MouseEvent): Pt => { const r = stage.getBoundingClientRect(), s = projectSize(live.current.doc); return { x: (e.clientX - r.left) * s.width / r.width, y: (e.clientY - r.top) * s.height / r.height }; };
    // The stage's own surface: the frames, the text hit boxes and this overlay; buttons, notes and the inline editor keep their presses.
    const ours = (target: EventTarget | null) => target === stage || (target instanceof Element && !!target.closest('.run, .text-hit, .selection-overlay'));
    const move = (e: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const p = at(e);
      if (d.kind === 'marquee') { d.to = p; setMarquee({ a: d.from, b: p }); return; }
      let edits: PreviewEdit[];
      if (d.kind === 'move') { const r = moveDrag(d.base, d.ids, d.t, { x: p.x - d.from.x, y: p.y - d.from.y }, d.zoom); edits = r.edits; setGuides(r.snap); }
      else { const i = itemOf(d.base, d.ids[0])!; edits = [{ itemId: i.id, values: d.kind === 'corner' ? cornerDrag(d.base, i, d.t, d.corner!, p) : rotationDrag(d.base, i, d.t, d.from, p) }]; }
      d.edits = edits;
      const next = { ...d.base, items: d.base.items.map(i => edits.some(x => x.itemId === i.id) ? structuredClone(i) : i) };
      writeEdits(next, edits, d.t);
      useSelectionDraft.setState({ doc: next });
    };
    // Release and pointer cancel both commit (7.1 point 5); Escape does not cancel a drag. Window blur commits too: not from Xapp,
    // needed because the drag uses window listeners, not pointer capture (relay R9, confirmed by Author).
    const end = () => {
      const d = drag.current; if (!d) return;
      drag.current = null; listen(false);
      if (d.kind === 'marquee') {
        setMarquee(null);
        if (d.to && Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) > MARQUEE_MIN) select([...new Set([...d.prior!, ...marqueeHits(d.base, d.t, d.from, d.to)])]);
        return;
      }
      if (d.edits) dispatch({ type: 'transformOnPreview', edits: d.edits, atMs: d.t });
      useSelectionDraft.setState({ doc: null }); setGuides({ x: false, y: false });
    };
    // Window listeners, not pointer capture: a captured press would retarget the click and double-click to the stage, and the
    // text hit box would never see its double-click.
    const listen = (on: boolean) => { for (const [type, f] of [['pointermove', move], ['pointerup', end], ['pointercancel', end], ['blur', end]] as const) window[on ? 'addEventListener' : 'removeEventListener'](type, f as EventListener); };
    const start = (d: Drag) => { drag.current = d; listen(true); if (d.kind === 'marquee') setMarquee({ a: d.from, b: d.from }); };
    const down = (e: PointerEvent) => {
      const { doc: base, t: now, off: hidden } = live.current;
      if (e.button !== 0 || hidden || drag.current || !ours(e.target)) return;
      const p = at(e), z = zoomNow(), sel = view().selection, shown = shownItems(base, sel, now), common = { from: p, base, t: now, zoom: z };
      // The handles answer only when exactly 1 item is selected (7.1 point 4; lane A's A1).
      if (sel.length === 1 && shown.length === 1) {
        const h = handleAt(frameOf(base, shown[0], now), z, p);
        if (h) { start({ ...common, kind: h === 'rotate' ? 'rotate' : 'corner', corner: h === 'rotate' ? undefined : h, ids: [shown[0].id] }); return; }
      }
      const hit = pickAt(base, now, p, reads(base, now));
      if (hit) {
        // A Shift press that takes the item out does not select it, so it starts no move.
        if (e.shiftKey && sel.includes(hit.id)) { select(sel.filter(id => id !== hit.id)); return; }
        if (e.shiftKey) select([...sel, hit.id]); else if (!sel.includes(hit.id)) select([hit.id]);
        start({ ...common, kind: 'move', ids: view().selection });
        return;
      }
      if (!e.shiftKey) select([]);
      start({ ...common, kind: 'marquee', ids: [], prior: e.shiftKey ? sel : [] });
    };
    // Double-click (7.1 point 9), after its two presses have set the selection: exactly 1 shape selected at the playhead enters
    // path editing (the "Edit path" button's patch); else a text pick goes on to text/edit.tsx's hit box and any other is stopped.
    const dbl = (e: MouseEvent) => {
      const { doc: base, t: now, off: hidden } = live.current;
      if (hidden || !ours(e.target)) return;
      const sel = view().selection, only = sel.length === 1 ? itemOf(base, sel[0]) : undefined;
      if (only?.type === 'shape' && atPlayhead(only, now)) { e.stopPropagation(); useShapeUi.setState({ editing: only.id, mode: null }); return; }
      if (pickAt(base, now, at(e), reads(base, now))?.type !== 'text') e.stopPropagation();
    };
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('dblclick', dbl, true);
    return () => {
      resize.disconnect(); scale.disconnect(); listen(false); drag.current = null; useSelectionDraft.setState({ doc: null });
      stage.removeEventListener('pointerdown', down); stage.removeEventListener('dblclick', dbl, true);
    };
  }, []);

  const shownDoc = draft ?? doc, shown = off ? [] : shownItems(shownDoc, v.selection, t), k = screenPx(1, zoom), line = LINE_PX * k;
  const one = shown.length === 1 ? frameOf(shownDoc, shown[0], t) : null, many = shown.length > 1 ? boundsOf(shown.map(i => frameOf(shownDoc, i, t))) : null;
  const box = one && corners(one), knobs = one && handles(one, zoom), top = box && { x: (box.nw.x + box.ne.x) / 2, y: (box.nw.y + box.ne.y) / 2 };
  return <svg ref={root} className="selection-overlay" aria-hidden="true" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" data-zoom={zoom}>
    {box && knobs && top && <g data-testid="selection-box" data-item={shown[0].id}>
      <polygon className="selection-line" points={[box.nw, box.ne, box.se, box.sw].map(q => `${q.x},${q.y}`).join(' ')} strokeWidth={line} />
      <line className="selection-line" x1={top.x} y1={top.y} x2={knobs.rotate.x} y2={knobs.rotate.y} strokeWidth={line} />
      {(['nw', 'ne', 'se', 'sw', 'rotate'] as const).map(h => <circle key={h} className={`selection-handle ${h}`} data-handle={h} cx={knobs[h].x} cy={knobs[h].y} r={Math.max(0, HANDLE_PX * k / 2 - 0.5)} strokeWidth={1} />)}
    </g>}
    {many && <rect className="selection-line" data-testid="selection-group" x={many.x} y={many.y} width={many.w} height={many.h} strokeWidth={line} />}
    {guides.x && !off && <line className="selection-line" data-testid="selection-guide-x" x1={size.width / 2} y1={0} x2={size.width / 2} y2={size.height} strokeWidth={line} />}
    {guides.y && !off && <line className="selection-line" data-testid="selection-guide-y" x1={0} y1={size.height / 2} x2={size.width} y2={size.height / 2} strokeWidth={line} />}
    {marquee && !off && <rect className="selection-marquee" data-testid="selection-marquee" x={Math.min(marquee.a.x, marquee.b.x)} y={Math.min(marquee.a.y, marquee.b.y)} width={Math.abs(marquee.b.x - marquee.a.x)} height={Math.abs(marquee.b.y - marquee.a.y)} strokeWidth={1} />}
  </svg>;
}
