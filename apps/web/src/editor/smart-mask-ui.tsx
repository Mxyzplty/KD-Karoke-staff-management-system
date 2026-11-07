// SPDX-License-Identifier: AGPL-3.0-only
// T12 AI Smart Mask on the stage (findings §19, §20, part 3 §44.7, part 2 §36, §42): Include / Exclude brush, 24 px by default, Alt held
// = exclude; a source range in seconds; a one-frame preview after every stroke (white = kept); the tracking job, or a description that
// runs as its own job over at most 30 s. A selection belongs to the frame under the playhead: moving the playhead drops it. Strokes
// are stored as fractions of the source frame, whatever the item's box does on the canvas.
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';
import { maskPreview, startTextMask, startTracking, trackRangeOk, trackWindow } from '../masks/jobs';
import type { MaskContext } from '../masks/jobs';
import { placement } from '../masks/model';
import { brushRadius, drawnStroke, strokeProblem, STROKE_LIMITS } from '../masks/strokes';
import type { Stroke } from '../masks/strokes';
import { boxMatrix, itemBox, projectSize } from '../render/model';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { CommandError, span } from '../timeline/model';
import { sourceTime } from '../timeline/properties';
import { activeRuntime } from '../timeline/runtime';
import { invert, mapPoints } from '../timeline/shapes';
import type { Pt } from '../timeline/shapes';
import { notify } from '../ui';
import { leaveMaskEdit } from './mask-state';
import { pillButton } from './shape-ui';
import { useView } from './view';

const BRUSH = 24, COLOURS = ['#ef4444', '#22c55e'], RANGE_TEXT = 'Use a source-time range up to 60 seconds, inside the video and containing the inspected frame.';
type Selection = { strokes: Stroke[]; preview: string | null; atUs: number; startS: number; endS: number };
export const useSmartSelection = create<Selection>(() => ({ strokes: [], preview: null, atUs: 0, startS: 0, endS: 0 }));
function showPreview(preview: string | null) {
  const old = useSmartSelection.getState().preview;
  if (old) URL.revokeObjectURL(old);
  useSmartSelection.setState({ preview });
}
let shown = 0;
export function clearSelection() { shown++; showPreview(null); useSmartSelection.setState({ strokes: [] }); }
const context = (): MaskContext | null => activeRuntime ? { ...activeRuntime.tools, origin: 'user' } : null;
const assetOf = (item: RecordData): Asset | undefined => activeRuntime?.tools.asset(String(item.metadata?.assetId));
const range = () => { const { startS, endS } = useSmartSelection.getState(); return { startUs: Math.round(startS * 1e6), endUs: Math.round(endS * 1e6) }; };
/** Starts a job and leaves the editor: from here on the job is in Background Jobs. A refusal stays in the editor. */
function launch(start: (ctx: MaskContext, asset: Asset) => { done: Promise<unknown> }, item: RecordData) {
  const ctx = context(), asset = assetOf(item);
  if (!ctx || !asset) return;
  try { void start(ctx, asset).done.catch(() => undefined); leaveMaskEdit(); } catch (e) {
    if (!(e instanceof CommandError)) throw e;
    notify(`${e.code}: ${e.error}`);
  }
}
/** Track, and Enter: the strokes over the range. Nothing happens without an include stroke. */
export function trackSelection(item: RecordData) {
  const { strokes, atUs } = useSmartSelection.getState(), asset = assetOf(item), r = range();
  if (!asset || !strokes.some(s => s.label === 1)) return false;
  const problem = strokeProblem(strokes);
  if (problem) { notify(problem); return false; }
  if (!trackRangeOk(asset, atUs, r)) { notify(RANGE_TEXT); return false; }
  launch((ctx, a) => startTracking(ctx, item.id, a, atUs, r, strokes), item);
  return true;
}

export function SmartBrush({ doc, item }: { doc: ProjectDocument; item: RecordData }) {
  const { playheadMs } = useView(), { strokes, preview, startS, endS } = useSmartSelection(), size = projectSize(doc), svg = useRef<SVGSVGElement>(null);
  const [label, setLabel] = useState<0 | 1>(1), [brush, setBrush] = useState(BRUSH), [prompt, setPrompt] = useState(''), [line, setLine] = useState<{ label: 0 | 1; points: Pt[] } | null>(null);
  const local = Math.min(Math.max(playheadMs - item.display.from, 0), span(item)), atUs = Math.round(sourceTime(item, local) * 1000), asset = assetOf(item), video = asset?.media?.video;
  const width: number = video?.displayWidth || size.width, height: number = video?.displayHeight || size.height, short = Math.min(width, height), brushMost = Math.floor(2 * STROKE_LIMITS.radius * short);
  const box = itemBox(doc, item, local), m = boxMatrix(box), inv = invert(m), fit = placement({ width, height, space: { kind: 'source', width, height } }, box.W, box.H);
  useEffect(() => {
    clearSelection();
    if (!asset) return;
    const r = trackWindow(asset, item, atUs), s = useSmartSelection.getState(), held = s.atUs >= s.startS * 1e6 && atUs >= s.startS * 1e6 && atUs < s.endS * 1e6;
    useSmartSelection.setState(held ? { atUs } : { atUs, startS: r.startUs / 1e6, endS: r.endUs / 1e6 });
  }, [atUs, item.id]);
  useEffect(() => clearSelection, []);
  if (!asset || !inv) return null;

  const at = (e: { clientX: number; clientY: number }): Pt => { const r = svg.current!.getBoundingClientRect(); return { x: (e.clientX - r.left) * size.width / r.width, y: (e.clientY - r.top) * size.height / r.height }; };
  const fraction = (p: Pt): [number, number] => {
    const q = mapPoints(inv, [{ anchor: p }])[0].anchor, part = (v: number) => Math.min(1, Math.max(0, v));
    return [part((q.x - fit.ox) / fit.sx / width), part((q.y - fit.oy) / fit.sy / height)];
  };
  const canvas = ([x, y]: [number, number]): Pt => mapPoints(m, [{ anchor: { x: x * width * fit.sx + fit.ox, y: y * height * fit.sy + fit.oy } }])[0].anchor;
  const look = async (list: Stroke[]) => {
    const mine = ++shown;
    if (!list.some(s => s.label === 1)) return showPreview(null);
    const problem = strokeProblem(list);
    if (problem) { notify(problem); return showPreview(null); }
    try {
      const { png } = await maskPreview(asset, atUs, list);
      if (mine === shown) showPreview(URL.createObjectURL(png));
    } catch (e) { if (mine === shown) notify((e as Error).message); }
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || strokes.length >= STROKE_LIMITS.uiStrokes) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setLine({ label: e.altKey ? 0 : label, points: [at(e)] });
  };
  const up = () => {
    if (!line) return;
    const next = [...strokes, drawnStroke(line.label, line.points.map(fraction), brushRadius(brush, short))];
    setLine(null);
    useSmartSelection.setState({ strokes: next });
    void look(next);
  };
  const dabs = brush * fit.sx * Math.abs(box.sx), trail = (points: Pt[], colour: string, key: number | string) => <polyline key={key} points={points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={colour} strokeOpacity={0.6} strokeWidth={dabs} strokeLinecap="round" strokeLinejoin="round" />;
  const number = (name: string, value: number, set: (v: number) => void, step: number, most?: number) => <input type="number" aria-label={name} step={step} min={most ? 1 : undefined} max={most} value={value} onChange={e => set(Number(e.target.value))} style={{ width: '4.5em', height: '1.5em', padding: 0 }} />;
  return <>
    <svg ref={svg} role="application" aria-label="Smart mask brush" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={down} onPointerMove={e => { if (line) setLine({ ...line, points: [...line.points, at(e)] }); }} onPointerUp={up} onPointerCancel={() => setLine(null)}>
      {preview && <image data-testid="smart-preview" href={preview} x={fit.ox} y={fit.oy} width={width * fit.sx} height={height * fit.sy} preserveAspectRatio="none" transform={`matrix(${m.join(' ')})`} style={{ mixBlendMode: 'screen', opacity: 0.6 }} />}
      {strokes.map((s, k) => trail(s.points.map(canvas), COLOURS[s.label], k))}
      {line && trail(line.points, COLOURS[line.label], 'line')}
    </svg>
    <div className="mask-pill" role="toolbar" aria-label="Smart mask" style={{ position: 'absolute', top: 44, left: '50%', transform: 'translateX(-50%)', width: 'max-content', maxWidth: 560, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'center', padding: '2px 8px', borderRadius: 12, background: 'rgb(0 0 0 / .7)', color: '#fff', fontSize: '.8rem' }}>
      <button style={pillButton} aria-pressed={label === 1} onClick={() => setLabel(1)}>Include</button>
      <button style={pillButton} aria-pressed={label === 0} onClick={() => setLabel(0)}>Exclude</button>
      <label>Brush {number('Brush size', brush, v => setBrush(Math.min(brushMost, Math.max(1, Math.round(v) || 1))), 1, brushMost)} px</label>
      <label>From {number('Track start', startS, v => useSmartSelection.setState({ startS: v }), 0.01)} s</label>
      <label>to {number('Track end', endS, v => useSmartSelection.setState({ endS: v }), 0.01)} s</label>
      <small>up to 60 s of source / 1,800 frames</small>
      <button style={pillButton} disabled={!strokes.some(s => s.label === 1)} onClick={() => trackSelection(item)}>Track</button>
      <input aria-label="Describe the object" placeholder="Or describe it" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.stopPropagation()} style={{ width: '11em', height: '1.5em', padding: '0 4px' }} />
      <button style={pillButton} disabled={!prompt.trim()} onClick={() => launch((ctx, a) => startTextMask(ctx, item.id, a, atUs, range(), prompt.trim()), item)}>Find</button>
      {strokes.length >= STROKE_LIMITS.uiStrokes && <span role="status">This selection has 32 strokes. Clear it to start a new selection.</span>}
    </div>
  </>;
}
