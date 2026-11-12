// SPDX-License-Identifier: AGPL-3.0-only
// T05 canvas text editing (findings §14 wave-3 fixture 5): a double-click on a text in the preview enters editing (no
// entry); Escape or a click elsewhere ends it and writes the new text as 1 "Edit items" (Escape keeps the new text); an
// unchanged text writes nothing (no entry, no save); idle time in edit mode does nothing. The layer sits over the stage
// in project px: one hit box per text drawn at the playhead, at its box (position, scale, rotation; not the animation).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectDocument, RecordData } from '../store/model';
import { boxMatrix, fpsOf, framePlan, itemBox, projectSize, snapTime } from '../render/model';
import type { Mat } from '../render/model';
import { usePlayback } from '../render/playback';
import { dispatch } from '../editor/commands';
import { select, useView } from '../editor/view';
import { canvasSpacing, parseGradient, textStyle } from './style';
import { measureText } from './tools';
import { textSlot } from '../catalogue/graphic';

const css = (m: Mat) => `matrix(${m.join(', ')})`;
type Target = { item: RecordData; local: number };

export function TextEditOverlay({ doc }: { doc: ProjectDocument }) {
  const v = useView(), host = useRef<HTMLDivElement>(null), size = projectSize(doc), [k, setK] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const t = snapTime(v.playheadMs, fpsOf(doc));
  // No per-frame framePlan while playing (the overlay is for the paused stage), and none when the doc has no text item.
  const playing = usePlayback(p => p.playing), hasText = doc.items.some(i => i.type === 'text');
  const targets = useMemo<Target[]>(() => playing || !hasText ? [] : framePlan(doc, t).draws.filter(d => d.kind === 'text').map(d => ({ item: d.item, local: d.local })), [doc, t, playing, hasText]);
  // Stage px per project px (the stage's layout width; its zoom transform scales this layer with it).
  useEffect(() => {
    const el = host.current; if (!el) return;
    const measure = () => { if (el.clientWidth > 0) setK(el.clientWidth / size.width); };
    measure(); const o = new ResizeObserver(measure); o.observe(el); return () => o.disconnect();
  }, [size.width]);
  const target = editing ? targets.find(x => x.item.id === editing) ?? null : null;
  useEffect(() => { if (editing && !doc.items.some(i => i.id === editing)) setEditing(null); }, [doc, editing]);
  return <div ref={host} className="text-overlay" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', left: 0, top: 0, width: size.width, height: size.height, transform: `scale(${k})`, transformOrigin: '0 0' }}>
      {!editing && targets.map(({ item, local }) => { const b = itemBox(doc, item, local); return <div key={item.id} className="text-hit" data-item={item.id} title="Double-click to edit the text"
        style={{ position: 'absolute', left: 0, top: 0, width: b.W, height: b.H, transform: css(boxMatrix(b)), transformOrigin: '0 0', pointerEvents: 'auto', cursor: 'text' }}
        onDoubleClick={e => { e.stopPropagation(); select([item.id]); setEditing(item.id); }} />; })}
      {target && <Editor key={target.item.id} doc={doc} target={target} done={() => setEditing(null)} />}
    </div>
  </div>;
}

function Editor({ doc, target, done }: { doc: ProjectDocument; target: Target; done: () => void }) {
  const { item, local } = target, original = typeof item.details?.text === 'string' ? item.details.text : '';
  const [text, setText] = useState(original), ended = useRef(false), area = useRef<HTMLTextAreaElement>(null), latest = useRef(text);
  latest.current = text;
  const b = itemBox(doc, item, local), s = textStyle(item, local);
  // T22: a text-slot element is edited in its slot, the text centred vertically as it is drawn (recomputed as it wraps).
  const slot = textSlot(item, b.W, b.H), r = slot ?? { x: 0, y: 0, W: b.W, H: b.H };
  const lift = slot ? Math.max(0, (slot.H - measureText({ ...item, details: { ...item.details, text } }, slot.W).height) / 2) : 0;
  const finish = () => {
    if (ended.current) return;
    ended.current = true; done();
    if (latest.current !== original) dispatch({ type: 'editTextProperties', itemIds: [item.id], properties: { text: latest.current }, refit: true });
  };
  useEffect(() => { const el = area.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, []);
  // A click anywhere outside the editor ends it (blur alone misses a press on a non-focusable area).
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (area.current && !area.current.contains(e.target as Node)) finish(); };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, []);
  return <textarea ref={area} className="text-editor" aria-label="Edit text" value={text} spellCheck={false}
    onChange={e => setText(e.target.value)} onBlur={finish}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); finish(); } }}
    style={{
      position: 'absolute', left: r.x, top: r.y, width: r.W, height: r.H, transform: css(boxMatrix(b)), transformOrigin: `${-r.x}px ${-r.y}px`, pointerEvents: 'auto',
      boxSizing: 'border-box', margin: 0, padding: 0, paddingTop: lift, border: 0, outline: '2px solid #38bdf8', resize: 'none', overflow: 'hidden',
      background: 'rgb(0 0 0 / .55)', color: parseGradient(s.color) ? '#ffffff' : s.color, font: s.font, lineHeight: `${s.pitch}px`,
      textAlign: s.align as 'left', textTransform: s.transform as 'none', letterSpacing: canvasSpacing(s.letterSpacing), wordSpacing: canvasSpacing(s.wordSpacing),
      whiteSpace: 'pre-wrap', overflowWrap: s.wrap === 'normal' ? 'normal' : 'break-word', wordBreak: s.wrap === 'break-all' ? 'break-all' : 'normal',
    }} />;
}
