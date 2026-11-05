// SPDX-License-Identifier: AGPL-3.0-only
// T07 layouts UI (findings part 3 §46.3 Layouts row and the §46.6 Layout row; findings §20; W3-ED-12/15, W3-RT-09): the
// Layouts panel (11 cards; a click adds a 10 s layout at 0 s on a new overlay track), the layout inspector bodies (Cells (n)
// with the empty-row footage picker, the filled row and the cell editor; Style Gap / Radius; Transform's 4 buttons) and the
// preview drop of a Footage thumbnail onto a cell's area. A tile is one "Add items" entry; every cell or style edit and a
// cell drop is one "Edit items" entry (timeline/layouts editLayoutCell).
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { AssetPoster } from '../media-ui';
import { notify } from '../ui';
import { cellRect, framePlan } from '../render/model';
import type { Draw } from '../render/model';
import { cellsOf, LAYOUT_PRESETS, LAYOUT_TYPES, LIMITS } from '../timeline/layouts';
import type { Bounds, LayoutOp } from '../timeline/layouts';
import { invert } from '../timeline/shapes';
import { dispatch } from './commands';
import { Slider } from './controls';
import { carriesPayload, readPayload } from './dnd';
import { useView, view } from './view';

/** The project's linked assets (the shell provides them): cell names and the empty-row picker. */
export const ProjectFootage = createContext<Asset[]>([]);
const edit = (itemId: string, op: LayoutOp) => dispatch({ type: 'layoutEdit', itemId, op });

/** A card's thumbnail: the preset's cells as outlined rectangles in a 16:9 frame. */
function PresetIcon({ cells }: { cells: Bounds[] }) {
  return <svg viewBox="0 0 160 90" width={80} height={45} aria-hidden="true">
    <rect x={0.5} y={0.5} width={159} height={89} fill="none" stroke="currentColor" strokeOpacity={0.3} />
    {cells.map((c, k) => <rect key={k} x={c.x * 160 + 2} y={c.y * 90 + 2} width={c.width * 160 - 4} height={c.height * 90 - 4} rx={3} fill="currentColor" fillOpacity={0.15} stroke="currentColor" />)}
  </svg>;
}
/** §46.3: 11 cards in the §20 order; a click adds the layout (selection unchanged). */
export function LayoutsPanel() {
  return <section aria-label="Layouts" className="tool-panel"><h3>Layouts</h3>
    <ul className="layout-cards" aria-label="Layout presets" style={{ listStyle: 'none', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '.5rem' }}>
      {LAYOUT_TYPES.map(t => <li key={t}><button type="button" className="card" style={{ flexDirection: 'column', width: '100%' }} onClick={() => dispatch({ type: 'addLayout', layoutType: t })}>
        <PresetIcon cells={LAYOUT_PRESETS[t].cells} /><span>{LAYOUT_PRESETS[t].label}</span></button></li>)}
    </ul>
  </section>;
}

// ---- Inspector bodies (part 3 §46.6 Layout row).
type Body = { doc: ProjectDocument; item: RecordData };
/** Media types a cell takes (an audio asset is not offered). */
const cellMedia = (a: Asset) => a.type === 'video' || a.type === 'image';
/** Cells (n): one row per cell. An empty row selects on click and shows the drop-or-pick hint with the project's footage; a
 *  filled row shows the camera icon, the asset name, Remove media (×) and Delete cell (trash); the selected filled cell
 *  shows its editor (Fill Mode, Volume, Opacity, Speed). No pan, zoom or trim control. */
export function CellsBody({ item }: Body) {
  const footage = useContext(ProjectFootage), cells = cellsOf(item), [picked, setPicked] = useState<number | null>(null);
  useEffect(() => { if (picked !== null && picked >= cells.length) setPicked(null); }, [cells.length, picked]);
  const name = (id: string) => footage.find(a => a.id === id)?.name ?? id;
  return <ol className="layout-cells" aria-label="Cells" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
    {cells.map((c, k) => {
      const n = k + 1, on = picked === k;
      return <li key={c.id} data-cell={k}>
        <div className="row">
          <button type="button" aria-pressed={on} onClick={() => setPicked(on ? null : k)} style={{ flex: 1, textAlign: 'left' }}>
            {c.source ? <><span aria-hidden="true">📷 </span>{n} {name(c.source.assetId)}</> : `${n} Empty`}</button>
          {c.source && <button type="button" aria-label={`Remove media from cell ${n}`} title="Remove media" onClick={() => edit(item.id, { op: 'clear', index: k })}>×</button>}
          <button type="button" aria-label={`Delete cell ${n}`} title="Delete cell" onClick={() => { edit(item.id, { op: 'deleteCell', index: k }); setPicked(null); }}>🗑</button>
        </div>
        {on && !c.source && <div className="cell-picker">
          <p className="hint">Drop footage on this cell in the preview, or pick one below.</p>
          {footage.some(cellMedia) ? <ul className="footage" aria-label={`Footage for cell ${n}`}>{footage.filter(cellMedia).map(a => <li key={a.id}>
            <button type="button" className="thumb" aria-label={`Fill cell ${n} with ${a.name}`} onClick={() => edit(item.id, { op: 'fill', index: k, assetId: a.id })}><AssetPoster asset={a} /></button>
            <span>{a.name}</span></li>)}</ul> : <p>No video or image footage in this project yet.</p>}
        </div>}
        {on && c.source && <CellEditor itemId={item.id} index={k} cell={c} />}
      </li>;
    })}
  </ol>;
}
function CellEditor({ itemId, index, cell }: { itemId: string; index: number; cell: ReturnType<typeof cellsOf>[number] }) {
  const set = (key: 'fillMode' | 'volume' | 'opacity' | 'playbackRate', value: number | string) => edit(itemId, { op: 'cell', index, key, value });
  const r = (k: keyof typeof LIMITS, step: number) => ({ min: LIMITS[k][0], max: LIMITS[k][1], step });
  return <div className="cell-editor" role="group" aria-label={`Cell ${index + 1}`}>
    <div className="row" role="radiogroup" aria-label="Fill Mode"><span>Fill Mode</span>
      {(['fill', 'fit'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={(cell.fillMode === 'fit' ? 'fit' : 'fill') === m} onClick={() => set('fillMode', m)}>{m === 'fill' ? 'Fill' : 'Fit'}</button>)}</div>
    <Slider label="Volume" value={cell.volume ?? 100} range={r('volume', 1)} unit="%" onCommit={v => set('volume', v)} />
    <Slider label="Opacity" value={cell.opacity ?? 100} range={r('opacity', 1)} unit="%" onCommit={v => set('opacity', v)} />
    <Slider label="Speed" value={cell.playbackRate ?? 1} range={r('playbackRate', 0.1)} unit="×" onCommit={v => set('playbackRate', v)} />
  </div>;
}
/** Style: Gap and Radius, 0–40 px (0 when not stored). */
export function LayoutStyleBody({ item }: Body) {
  const v = (k: 'gap' | 'borderRadius') => typeof item.details?.[k] === 'number' ? item.details[k] as number : 0;
  return <>{(['gap', 'borderRadius'] as const).map(k => <Slider key={k} label={k === 'gap' ? 'Gap' : 'Radius'} value={v(k)} range={{ min: LIMITS[k][0], max: LIMITS[k][1], step: 1 }} unit=" px"
    onCommit={n => edit(item.id, { op: 'style', key: k, value: n })} />)}</>;
}
/** Transform: 4 buttons on the whole layout; 1 and 2 reset it to the full canvas (no difference was seen), 3 centres it
 *  horizontally, 4 vertically. No position, scale, opacity or blend fields. */
export function LayoutTransformBody({ item }: Body) {
  const b = (button: 1 | 2 | 3 | 4, label: string, icon: string) => <button type="button" aria-label={label} title={label} onClick={() => edit(item.id, { op: 'transform', button })}>{icon}</button>;
  return <div className="row" role="group" aria-label="Layout transform">
    {b(1, 'Reset to full canvas', '⛶')}{b(2, 'Reset to full canvas (2)', '⤢')}{b(3, 'Centre horizontally', '⇹')}{b(4, 'Centre vertically', '⤒')}
  </div>;
}

// ---- Preview drop: a Footage thumbnail (video or image) dropped on a cell's area fills that cell, topmost layout first.
type Hit = { itemId: string; index: number; corners: string };
/** The layout cell under a canvas point at time t (stored cell index), with its outline in canvas px. */
export function cellAtPoint(doc: ProjectDocument, t: number, x: number, y: number): Hit | null {
  const draws = framePlan(doc, t).draws.filter((d): d is Draw => d.kind === 'layout').reverse();
  for (const d of draws) {
    const inv = invert(d.matrix); if (!inv) continue;
    const u = inv[0] * x + inv[2] * y + inv[4], w = inv[1] * x + inv[3] * y + inv[5], gap = Math.max(0, Number(d.item.details?.gap) || 0);
    const cells = cellsOf(d.item);
    for (let k = cells.length - 1; k >= 0; k--) { // a later cell is drawn above an earlier one (PiP inset over the full cell)
      const r = cellRect(cells[k].bounds, d.box.W, d.box.H, gap);
      if (!(r.w > 0 && r.h > 0) || u < r.x || u > r.x + r.w || w < r.y || w > r.y + r.h) continue;
      const m = d.matrix, at = (p: number, q: number) => `${m[0] * p + m[2] * q + m[4]},${m[1] * p + m[3] * q + m[5]}`;
      return { itemId: d.item.id, index: k, corners: [at(r.x, r.y), at(r.x + r.w, r.y), at(r.x + r.w, r.y + r.h), at(r.x, r.y + r.h)].join(' ') };
    }
  }
  return null;
}
/** Listens on the stage (capture phase) so a drop on a cell does not also reach the preview's timeline drop. */
export function LayoutDropOverlay({ doc }: { doc: ProjectDocument }) {
  const root = useRef<HTMLDivElement>(null), docRef = useRef(doc), [hit, setHit] = useState<Hit | null>(null), w = doc.size?.width || 1080, h = doc.size?.height || 1920;
  docRef.current = doc;
  useView(); // re-render on playhead moves so a stale outline is not kept
  useEffect(() => {
    const stage = root.current?.parentElement; if (!stage) return;
    const point = (e: DragEvent) => { const r = stage.getBoundingClientRect(), d = docRef.current, W = d.size?.width || 1080, H = d.size?.height || 1920; return r.width > 0 && r.height > 0 ? cellAtPoint(d, view().playheadMs, (e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height) : null; };
    const over = (e: DragEvent) => { if (!e.dataTransfer || !carriesPayload(e.dataTransfer)) return; const p = point(e); setHit(p); if (p) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
    const drop = (e: DragEvent) => {
      setHit(null);
      if (!e.dataTransfer || !carriesPayload(e.dataTransfer)) return;
      const payload = readPayload(e.dataTransfer), media = payload?.kind === 'assets' ? payload.items.find(a => a.type === 'video' || a.type === 'image') : undefined, p = media && point(e);
      if (!media || !p) return; // not footage, or not over a cell: the preview's own drop handles it
      e.preventDefault(); e.stopPropagation();
      if (edit(p.itemId, { op: 'fill', index: p.index, assetId: media.assetId }).ok) notify(`Added ${media.name} to cell ${p.index + 1}`);
    };
    const leave = (e: DragEvent) => { if (!stage.contains(e.relatedTarget as Node | null)) setHit(null); };
    stage.addEventListener('dragover', over, true); stage.addEventListener('drop', drop, true); stage.addEventListener('dragleave', leave, true);
    return () => { stage.removeEventListener('dragover', over, true); stage.removeEventListener('drop', drop, true); stage.removeEventListener('dragleave', leave, true); };
  }, []);
  return <div ref={root} className="layout-drop" aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    {hit && <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <polygon data-testid="layout-drop-cell" points={hit.corners} fill="rgb(56 189 248 / .15)" stroke="#38bdf8" strokeWidth={2} vectorEffect="non-scaling-stroke" /></svg>}
  </div>;
}
