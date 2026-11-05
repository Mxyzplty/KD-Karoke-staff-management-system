// SPDX-License-Identifier: AGPL-3.0-only
// T04 keyframe graph editor (part 3 §46.10, §46.11; editing rules §45.5): a modal opened by the inspector header's graph
// button. "Keyframe Graph" with an empty-state note, else "<property> Graph Editor": undo / redo, the PROPERTIES list
// with keyframe counts, the curve with keyframe diamonds against the clip's time, Easing Preset (7) / Add Bezier / Delete
// for the selected keyframe, bezier handles, Fit and time zoom. With Time Remap on it is the "Time Remap Graph Editor"
// (one Time Remap property; the time axis is wider than the clip, the outside shaded). Click selects (no undo entry);
// a drag commits on release; a double-click on the curve adds a linear keyframe; each change is one "Edit items" step.
// Global keys are off while it is open (keymap.ts); Delete here removes the selected keyframe; Escape closes.
import { useEffect, useRef, useState } from 'react';
import type { ProjectDocument, RecordData } from '../store/model';
import { span } from '../timeline/model';
import { controlPoints, evaluate, KEYFRAME_PROPERTIES, prop, remapKeyframes, sorted, specOf, toPropertyTime, toTimelineMs, valueAt } from '../timeline/properties';
import type { Easing, Keyframe, KeyframePatch } from '../timeline/properties';
import { activeRuntime } from '../timeline/runtime';
import { Dialog } from '../ui';
import { dispatch, history } from './commands';
import { MenuButton } from './controls';
import { rowSpec } from './inspector';
import { closeGraph, openGraph, selectKeyframe, useView, view } from './view';

const REMAP = 'timeRemap';
/** The 7 Easing Preset entries in Xapp's order (W3-CC-02); the other 8 easings are agent-only. */
export const EASING_PRESETS: [string, string][] = [['Linear', 'linear'], ['Ease In', 'easeIn'], ['Ease Out', 'easeOut'], ['Ease In/Out', 'easeInOut'], ['Cubic In', 'easeInCubic'], ['Cubic Out', 'easeOutCubic'], ['Cubic In/Out', 'easeInOutCubic']];
const ADD_BEZIER: Easing = { type: 'bezier', points: [0.42, 0, 0.58, 1] };
const W = 600, H = 260, L = 48, R = 12, T = 12, B = 26;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The curves the editor lists: the Time Remap curve alone in the remap editor, else every keyframed property. */
function curvesOf(item: RecordData, remap: boolean): { key: string; keyframes: Keyframe[] }[] {
  if (remap) return remapKeyframes(item).length ? [{ key: REMAP, keyframes: remapKeyframes(item) }] : [];
  return KEYFRAME_PROPERTIES.filter(k => specOf(item.type, k)?.anim).map(key => ({ key, keyframes: prop(item, key)?.keyframes ?? [] })).filter(c => c.keyframes.length);
}
type Drag = { kind: 'key' | 'in' | 'out'; id: string; t: number; v: number; moved: boolean };

export function GraphEditor({ doc }: { doc: ProjectDocument }) {
  const v = useView(), g = v.graph, item = g && doc.items.find(i => i.id === g.itemId);
  useEffect(() => { if (g && !item) closeGraph(); }, [g, item]);
  if (!g || !item) return null;
  const curves = curvesOf(item, g.key === REMAP), key = curves.find(c => c.key === g.key)?.key ?? curves[0]?.key ?? null;
  const spec = key ? rowSpec(doc, item, key) : null;
  return <Dialog title={spec ? `${spec.label} Graph Editor` : 'Keyframe Graph'} close={closeGraph}>
    <div className="graph-editor">
      <div className="graph-toolbar">
        <button aria-label="Undo" disabled={!history.canUndo()} onClick={() => dispatch({ type: 'undo' })}>↶</button>
        <button aria-label="Redo" disabled={!history.canRedo()} onClick={() => dispatch({ type: 'redo' })}>↷</button>
      </div>
      {key && spec ? <Graph doc={doc} item={item} curveKey={key} curves={curves} /> : <p className="graph-empty">No keyframes yet. Add keyframes to a property, mask or effect.</p>}
    </div>
  </Dialog>;
}

function Graph({ doc, item, curveKey, curves }: { doc: ProjectDocument; item: RecordData; curveKey: string; curves: { key: string; keyframes: Keyframe[] }[] }) {
  const v = useView(), [zoom, setZoom] = useState(1), [fit, setFit] = useState(false), [drag, setDrag] = useState<Drag | null>(null), svg = useRef<SVGSVGElement>(null);
  const remap = curveKey === REMAP, s = rowSpec(doc, item, curveKey), length = span(item);
  const list = sorted(curves.find(c => c.key === curveKey)!.keyframes);
  // Display coordinates: t = item-local ms, value in the row's display units.
  const tOfKf = (k: Keyframe) => remap ? k.time : toTimelineMs(item, k.time) - item.display.from;
  const pts = list.map(k => ({ k, t: tOfKf(k), v: Number(k.value) * s.factor }));
  const sel = v.keyframe, selected = sel && sel.itemId === item.id && sel.key === curveKey ? pts.find(p => p.k.id === sel.keyframeId) : undefined;
  const [t0, t1] = remap ? [-0.1 * length, 1.1 * length] : [0, length];
  const data = pts.map(p => p.v), pad = (Math.max(...data) - Math.min(...data)) * 0.1 || 1;
  const [v0, v1] = fit && data.length ? [Math.min(...data) - pad, Math.max(...data) + pad] : [s.range.min, s.range.max];
  const width = W * zoom, x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (width - L - R), y = (n: number) => T + (1 - (n - v0) / (v1 - v0 || 1)) * (H - T - B);
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const b = svg.current!.getBoundingClientRect(), px = (e.clientX - b.left) * (width / b.width), py = (e.clientY - b.top) * (H / b.height);
    return { t: t0 + ((px - L) / (width - L - R)) * (t1 - t0), v: v0 + (1 - (py - T) / (H - T - B)) * (v1 - v0) };
  };
  const curveValue = (t: number) => remap ? Number(evaluate(remapKeyframes(item), 0, t)) * s.factor : Number(valueAt(item, curveKey, t)) * s.factor;
  const path = Array.from({ length: 241 }, (_, n) => { const t = t0 + ((t1 - t0) * n) / 240; return `${n ? 'L' : 'M'}${x(t).toFixed(1)},${y(curveValue(t)).toFixed(1)}`; }).join(' ');
  const ref = (k: Keyframe) => ({ itemId: item.id, key: curveKey, keyframeId: k.id });
  const edit = (k: Keyframe, patch: KeyframePatch) => dispatch({ type: 'editKeyframe', target: ref(k), patch });
  const storedTime = (t: number) => remap ? clamp(t, 0, length) : toPropertyTime(item, item.display.from + clamp(t, 0, length));
  const storedValue = (n: number) => { const spec = remap ? { min: 0, max: undefined } : specOf(item.type, curveKey); return Number(clamp(n / s.factor, spec?.min ?? -Infinity, spec?.max ?? Infinity).toFixed(6)); };

  // Bezier handles of the selected keyframe: out = its own segment's start, in = the previous segment's end (§38).
  const n = selected ? pts.indexOf(selected) : -1, next = pts[n + 1], prev = pts[n - 1];
  const handle = (a: typeof pts[number], b: typeof pts[number], h: [number, number]) => ({ t: a.t + h[0] * (b.t - a.t), v: a.v + h[1] * (b.v - a.v) });
  const outAt = selected && next ? handle(selected, next, selected.k.outHandle ?? controlPoints(selected.k.easing).slice(0, 2) as [number, number]) : null;
  const inAt = selected && prev ? handle(prev, selected, selected.k.inHandle ?? controlPoints(prev.k.easing).slice(2) as [number, number]) : null;
  const toHandle = (a: typeof pts[number], b: typeof pts[number], p: { t: number; v: number }): [number, number] =>
    [r3(clamp((p.t - a.t) / (b.t - a.t || 1), 0, 1)), r3(clamp((p.v - a.v) / (b.v - a.v || v1 - v0 || 1), -1, 2))];

  useEffect(() => {
    // Global keys are off while the modal is open; Delete / Backspace removes the selected keyframe (§45.5).
    const key = (e: KeyboardEvent) => {
      const k = view().keyframe, tag = (e.target as HTMLElement | null)?.tagName;
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || !k || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault(); dispatch({ type: 'deleteKeyframe', target: k }); selectKeyframe(null);
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const start = (e: React.PointerEvent, kind: Drag['kind'], k: Keyframe, p: { t: number; v: number }) => {
    e.stopPropagation(); if (e.button !== 0) return;
    if (kind === 'key') selectKeyframe(ref(k));
    svg.current?.setPointerCapture(e.pointerId); setDrag({ kind, id: k.id, ...p, moved: false });
  };
  const release = () => {
    const d = drag; setDrag(null);
    if (!d?.moved || !selected) return;
    if (d.kind === 'key') return edit(selected.k, { time: storedTime(d.t), value: storedValue(d.v) });
    if (d.kind === 'out' && next) return edit(selected.k, { outHandle: toHandle(selected, next, d), ...(typeof selected.k.easing === 'string' ? { easing: { type: 'bezier', points: controlPoints(selected.k.easing) } } : {}) });
    if (d.kind === 'in' && prev) edit(selected.k, { inHandle: toHandle(prev, selected, d) });
  };
  const addAt = (e: React.MouseEvent) => {
    const t = clamp(at(e).t, 0, length), before = new Set(list.map(k => k.id));
    if (!dispatch({ type: 'addKeyframe', itemId: item.id, key: curveKey, atMs: item.display.from + t }).ok) return;
    const now = activeRuntime?.bus.doc.items.find(i => i.id === item.id), added = now && curvesOf(now, remap).find(c => c.key === curveKey)?.keyframes.find(k => !before.has(k.id));
    if (added) selectKeyframe(ref(added));
  };
  const shown = (p: typeof pts[number]) => drag?.kind === 'key' && drag.id === p.k.id ? drag : p;
  const label = (p: { t: number }) => `${s.label} keyframe at ${(p.t / 1000).toFixed(2)}s`;
  const bezier = !!selected && typeof selected.k.easing === 'object';

  return <>
    <div className="graph-properties" role="group" aria-label="PROPERTIES"><span>PROPERTIES</span>
      {curves.map(c => { const name = rowSpec(doc, item, c.key).label; return <button key={c.key} aria-pressed={c.key === curveKey} aria-label={`${name} ${c.keyframes.length}`} onClick={() => openGraph(item.id, c.key)}>{name} <span className="count">{c.keyframes.length}</span></button>; })}
    </div>
    <div className="graph-canvas">
      <svg ref={svg} role="group" aria-label={`${s.label} curve`} viewBox={`0 0 ${width} ${H}`} style={{ width: `${zoom * 100}%` }}
        onPointerMove={e => { if (drag) { const p = at(e); setDrag({ ...drag, ...p, moved: true }); } }} onPointerUp={release} onPointerCancel={() => setDrag(null)}>
        {remap && <><rect className="graph-outside" x={x(t0)} y={T} width={x(0) - x(t0)} height={H - T - B} /><rect className="graph-outside" x={x(length)} y={T} width={x(t1) - x(length)} height={H - T - B} /></>}
        <line className="graph-axis" x1={L} y1={H - B} x2={width - R} y2={H - B} /><line className="graph-axis" x1={L} y1={T} x2={L} y2={H - B} />
        <text className="graph-tick" x={L - 4} y={T + 8} textAnchor="end">{r3(v1)}{s.unit}</text><text className="graph-tick" x={L - 4} y={H - B} textAnchor="end">{r3(v0)}{s.unit}</text>
        <text className="graph-tick" x={L} y={H - 8}>{(t0 / 1000).toFixed(2)}s</text><text className="graph-tick" x={width - R} y={H - 8} textAnchor="end">{(t1 / 1000).toFixed(2)}s</text>
        <path className="graph-curve" d={path} />
        <path className="graph-curve-hit" d={path} aria-label="Curve" onDoubleClick={addAt} />
        {selected && [['in', inAt, prev] as const, ['out', outAt, next] as const].map(([kind, h]) => {
          if (!h) return null;
          const p = drag?.kind === kind ? drag : h;
          return <g key={kind}><line className="graph-handle-line" x1={x(selected.t)} y1={y(selected.v)} x2={x(p.t)} y2={y(p.v)} />
            <circle className="graph-handle" role="button" aria-label={kind === 'in' ? 'In handle' : 'Out handle'} cx={x(p.t)} cy={y(p.v)} r={5} onPointerDown={e => start(e, kind, selected.k, h)} /></g>;
        })}
        {pts.map(p => { const q = shown(p); return <rect key={p.k.id} className={`graph-key${selected?.k.id === p.k.id ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={label(p)} aria-pressed={selected?.k.id === p.k.id}
          x={x(q.t) - 6} y={y(q.v) - 6} width={12} height={12} transform={`rotate(45 ${x(q.t)} ${y(q.v)})`}
          onPointerDown={e => start(e, 'key', p.k, p)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectKeyframe(ref(p.k)); } }} />; })}
      </svg>
    </div>
    <div className="graph-controls">
      <MenuButton label="Easing Preset" disabled={!selected} items={EASING_PRESETS.map(([name, easing]) => ({ label: name, checked: selected?.k.easing === easing, onSelect: () => { if (selected) edit(selected.k, { easing, outHandle: null }); } }))}>Easing Preset</MenuButton>
      <button disabled={!selected || bezier} onClick={() => { if (selected) edit(selected.k, { easing: ADD_BEZIER }); }}>{bezier ? 'Bezier' : 'Add Bezier'}</button>
      <button disabled={!selected} onClick={() => { if (selected) { dispatch({ type: 'deleteKeyframe', target: ref(selected.k) }); selectKeyframe(null); } }}>Delete</button>
      <button aria-pressed={fit} onClick={() => { setFit(!fit); setZoom(1); }}>Fit</button>
      <label className="graph-zoom">Time zoom<input type="range" aria-label="Time zoom" min={1} max={8} step={0.5} value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
    </div>
  </>;
}
