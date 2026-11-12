// SPDX-License-Identifier: AGPL-3.0-only
// T05 text UI (findings part 3 §46.6 Text row, §46.7; part 2 §40; W3-ED-13 / -14 / -15 / -22): the Text panel (Add text,
// draggable onto the timeline), and the text inspector bodies: Preset gallery, Text (font, weight, size, colour / gradient,
// fill, align, decoration, case), Animation (14 tiles + Speed), Basic, Transform (4 alignment buttons, no flip), Font
// Stroke and Font Shadow. Every write is one bus command through an intent ("Add items" / "Edit items"). A font change
// loads the face first, so the stored text is measured and drawn with the face it names; a face that cannot load changes
// nothing and says why.
import { useEffect, useRef, useState } from 'react';
import type { ProjectDocument, RecordData } from '../store/model';
import { itemBox, projectSize } from '../render/model';
import { span } from '../timeline/model';
import { staticValue } from '../timeline/properties';
import { activeRuntime } from '../timeline/runtime';
import { dispatch } from '../editor/commands';
import { ColourPicker, Popover, Slider } from '../editor/controls';
import { setDragPayload } from '../editor/dnd';
import { BlendMode, PropRow, ShadowBody } from '../editor/inspector';
import { select, view } from '../editor/view';
import { PRESET_LABELS, PRESETS, readAnimation, SPEED, storedAnimation } from './animation';
import type { Preset } from './animation';
import { addUserFont, FontError, fontNotices, findFont, loadFont, onFontChange, pickVariant, resolveFont, weightNumber } from './fonts';
import type { FontFamilyEntry, FontVariant } from './fonts';
import { fontPickerOrder } from '../catalogue/fonts';
import { NO_PRESET, presetProperties, TEXT_PRESETS } from './presets';
import type { TextPreset } from './presets';
import { currentFamily } from './properties';
import { textStyle } from './style';
import { ADD_TEXT } from './tools';

type Body = { doc: ProjectDocument; item: RecordData };
const editText = (item: RecordData, properties: RecordData) => dispatch({ type: 'editTextProperties', itemIds: [item.id], properties });
/** Parity mode (bus option sliderEntries 'step'): a drag commits every step (W3-RT-02: 1× → 2× = 4 entries). */
const perStep = () => activeRuntime?.bus.options.sliderEntries === 'step';
const local = (item: RecordData) => Math.min(Math.max(view().playheadMs - item.display.from, 0), span(item));
/** Re-renders when a face, the emoji or the CJK font loads or fails, or the uploads change. */
function useFonts() {
  const [, setN] = useState(0);
  useEffect(() => onFontChange(() => setN(n => n + 1)), []);
}
const failText = (e: unknown, what: 'added' | 'changed') => e instanceof FontError ? `${e.code}: The selected font could not be loaded. No items were ${what}.` : `The selected font could not be loaded. No items were ${what}.`;

/** Chain-font notices (the CJK or emoji font could not load; Q4 default: sans-serif + this notice). */
export function FontNotices() {
  useFonts();
  const list = fontNotices();
  return list.length ? <>{list.map(n => <p key={n} className="notice" role="status">{n}</p>)}</> : null;
}

// ---- Text panel (rail tool "Text"; compact tab "Texts").
/** Add text (part 2 §40): "Heading", Roboto Bold 150 px, white, centred, 5 s from 0 s, on an empty overlay track or a new
 *  top one. Roboto Bold is loaded first so the stored box is measured with it. The button also drags onto the timeline. */
export function TextPanel() {
  const [busy, setBusy] = useState(false), face = resolveFont(ADD_TEXT.family, ADD_TEXT.weight);
  useEffect(() => { if (face) loadFont(face, ADD_TEXT.text).catch(() => undefined); }, []);
  const add = async () => {
    setBusy(true);
    try { if (face) await loadFont(face, ADD_TEXT.text).catch(() => undefined); } finally { setBusy(false); }
    if (!dispatch({ type: 'addTextPreset' }).ok) return;
    const made = activeRuntime?.bus.doc.items.at(-1);
    if (made?.type === 'text') select([made.id]);
  };
  return <section aria-label="Text" className="tool-panel"><h3>Text</h3>
    <button className="add-text" draggable disabled={busy} onDragStart={e => setDragPayload(e.dataTransfer, { kind: 'text', text: ADD_TEXT.text })} onClick={() => void add()}>Add text</button>
    <p className="hint">Adds a heading at 0 s. Drag the button onto the timeline to place it on a track.</p>
    <FontNotices />
  </section>;
}

// ---- Preset gallery: a floating 3 × 5 panel (None + 14); it stays open after a tile click; the field keeps showing None.
function swatch(p: TextPreset) {
  const s = p.shadow, stroke = p.stroke ? `-1px -1px 0 ${p.stroke}, 1px -1px 0 ${p.stroke}, -1px 1px 0 ${p.stroke}, 1px 1px 0 ${p.stroke}` : '';
  return { color: p.color, background: p.fill, textShadow: [stroke, s ? `${s.x / 4}px ${s.y / 4}px ${s.blur / 4}px ${s.color}` : ''].filter(Boolean).join(', ') || undefined };
}
export function PresetBody({ item }: Body) {
  const [open, setOpen] = useState(false);
  const tile = (p: TextPreset, i: number) => <button key={p.name} className="preset-tile" aria-label={i ? `Preset ${i}: ${p.name}` : 'Preset none'} style={swatch(p)}
    onClick={() => editText(item, presetProperties(p))}>{i ? 'Aa' : '⊘'}</button>;
  return <div className="row"><span>Preset</span><div className="preset-field">
    <button aria-label="Preset: None" aria-expanded={open} onClick={() => setOpen(!open)}>None</button>
    {open && <Popover label="Text presets" className="preset-gallery" close={() => setOpen(false)}>
      <div className="preset-grid">{[NO_PRESET, ...TEXT_PRESETS].map(tile)}</div>
    </Popover>}
  </div></div>;
}

// ---- Text → Styles.
/** Loads the face a font edit draws with, then writes it; a face that cannot load writes nothing (the error shows). */
async function changeFont(item: RecordData, face: FontVariant | null, family: string, props: RecordData, report: (m: string) => void) {
  const r = face ? resolveFont(face.face) : resolveFont(family, staticValue(item, 'fontWeight') ?? 'normal', staticValue(item, 'fontStyle') ?? 'normal');
  const text = typeof item.details?.text === 'string' && item.details.text ? item.details.text : ' ';
  try { if (r) await loadFont(r, text); } catch (e) { report(failText(e, 'changed')); return; }
  report('');
  editText(item, props);
}
function FontPicker({ item, report }: { item: RecordData; report: (m: string) => void }) {
  useFonts();
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), file = useRef<HTMLInputElement>(null);
  const family = findFont(currentFamily(item))?.entry.family ?? (currentFamily(item) || 'Default');
  const q = query.trim().toLowerCase(), list = fontPickerOrder().filter(f => !q || f.family.toLowerCase().includes(q) || (f.substituteFor ?? '').toLowerCase().includes(q));
  const choose = (f: FontFamilyEntry) => { setOpen(false); void changeFont(item, null, f.family, { fontFamily: f.family }, report); };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try { const u = await addUserFont(f); choose(findFont(u.postScriptName)?.entry ?? findFont(u.family)!.entry); }
    catch (e) { report(e instanceof FontError ? `${e.code}: ${e.message}` : 'The font file could not be added.'); }
  };
  return <div className="font-field">
    <button aria-label={`Font: ${family}`} aria-expanded={open} onClick={() => setOpen(!open)}>{family}</button>
    {open && <Popover label="Fonts" className="font-picker" close={() => setOpen(false)}>
      <input type="search" aria-label="Search fonts" placeholder="Search fonts" value={query} onChange={e => setQuery(e.target.value)} />
      <button onClick={() => file.current?.click()}>Upload font</button>
      <input ref={file} type="file" hidden accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" aria-label="Upload font file" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      <ul role="listbox" aria-label="Font families">{list.map(f => <li key={`${f.source}:${f.sha256 ?? f.family}`} role="option" aria-selected={f.family === family}>
        <button onClick={() => choose(f)}>{f.family}<small>{f.source === 'user' ? 'Uploaded' : f.category}</small></button></li>)}</ul>
    </Popover>}
  </div>;
}
function WeightField({ item, report }: { item: RecordData; report: (m: string) => void }) {
  const entry = findFont(currentFamily(item))?.entry;
  if (!entry) return <label className="row">Weight<select aria-label="Weight" disabled><option>{String(staticValue(item, 'fontWeight') ?? 'Regular')}</option></select></label>;
  const current = pickVariant(entry, weightNumber(staticValue(item, 'fontWeight') ?? 'normal'), staticValue(item, 'fontStyle') === 'italic');
  return <label className="row">Weight<select aria-label="Weight" value={current.face} onChange={e => {
    const v = entry.variants.find(x => x.face === e.target.value);
    if (v) void changeFont(item, v, entry.family, { fontWeight: v.weight, fontStyle: v.italic ? 'italic' : 'normal' }, report);
  }}>{entry.variants.map(v => <option key={v.face} value={v.face}>{v.label}</option>)}</select></label>;
}
/** Size: commits on Enter and on blur; while typing only empty or a non-negative number is accepted (W3-ED / T05 body). */
function SizeField({ item, value }: { item: RecordData; value: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft); setDraft(null);
    if (draft.trim() !== '' && n > 0 && n !== value) editText(item, { fontSize: n });
  };
  return <label className="row">Size<input aria-label="Font size" inputMode="decimal" value={draft ?? String(value)}
    onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setDraft(e.target.value); }} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') setDraft(null); }} /></label>;
}
const ALIGNS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] as const;
const DECORATIONS = [['underline', 'Underline', 'U'], ['line-through', 'Strikethrough', 'S'], ['overline', 'Overline', 'O']] as const;
const CASES = [['none', 'As typed', 'Aa'], ['uppercase', 'Uppercase', 'AA'], ['lowercase', 'Lowercase', 'aa']] as const;
export function TextBody({ item }: Body) {
  const [error, setError] = useState(''), s = textStyle(item, local(item));
  // Display falls back to a legacy details.color (an older item with no color property); the picker still writes the property.
  const colour = String(staticValue(item, 'color') ?? item.details?.color ?? '#ffffff'), fill = String(staticValue(item, 'backgroundColor') ?? 'transparent');
  const decoration = (d: string) => { const set = new Set(s.decoration); if (set.has(d)) set.delete(d); else set.add(d); editText(item, { textDecoration: set.size ? DECORATIONS.map(x => x[0]).filter(x => set.has(x)).join(' ') : 'none' }); };
  return <div className="text-styles" key={item.id}>
    <FontPicker item={item} report={setError} />
    <WeightField item={item} report={setError} />
    <SizeField key={item.id} item={item} value={s.F} />
    <label className="row">Color<ColourPicker key={item.id} gradient label="Text colour" value={colour} onChange={c => editText(item, { color: c })} /></label>
    <label className="row">Fill<ColourPicker key={item.id} label="Fill colour" value={fill} onChange={c => editText(item, { backgroundColor: c })} /></label>
    <div className="row" role="group" aria-label="Align"><span>Align</span>{ALIGNS.map(([v, label]) => <button key={v} aria-label={`Align ${label}`} aria-pressed={s.align === v} onClick={() => editText(item, { textAlign: v })}>{label}</button>)}</div>
    <div className="row" role="group" aria-label="Decoration"><span>Decoration</span>{DECORATIONS.map(([v, label, short]) => <button key={v} aria-label={label} aria-pressed={s.decoration.includes(v)} onClick={() => decoration(v)}>{short}</button>)}</div>
    <div className="row" role="group" aria-label="Case"><span>Case</span>{CASES.map(([v, label, short]) => <button key={v} aria-label={label} aria-pressed={s.transform === v || v === 'none' && !['uppercase', 'lowercase'].includes(s.transform)} onClick={() => editText(item, { textTransform: v })}>{short}</button>)}</div>
    {error && <p className="error" role="alert">{error}</p>}
    <FontNotices />
  </div>;
}

// ---- Animation: 14 tiles in Xapp's order; Speed 0.25–4 (step 0.25, 1×) only for a preset other than None; no duration
// control (durationMs is agent-only). A tile keeps the speed; None stores {version: 1, preset: "none"}.
export function AnimationBody({ item }: Body) {
  const cfg = readAnimation(item.details?.textAnimation);
  const choose = (p: Preset) => editText(item, { textAnimation: storedAnimation(p, p === 'none' ? 1 : cfg.speed) });
  return <>
    <div className="animation-grid" role="radiogroup" aria-label="Text animation">{PRESETS.map(p => <button key={p} role="radio" aria-checked={cfg.preset === p} onClick={() => choose(p)}>{PRESET_LABELS[p]}</button>)}</div>
    {cfg.preset !== 'none' && <Slider key={item.id} label="Speed" value={cfg.speed} range={SPEED} unit="×" perStep={perStep} digits={2}
      onCommit={v => editText(item, { textAnimation: storedAnimation(cfg.preset, v, cfg.durationMs ?? undefined) })} />}
  </>;
}

/** Basic (§46.6 Text row): Opacity and Blend Mode (no Lock Ratio). */
export const TextBasicBody = ({ doc, item }: Body) => <><PropRow doc={doc} item={item} k="opacity" /><BlendMode item={item} /></>;

/** Transform (W3-ED-15): centre horizontally · centre vertically · centre horizontally + top (bottom edge at 30 % of the
 *  height) · centre horizontally + bottom (top edge at 70 %); then Scale, Rotation, X, Y; no flip. */
export function alignedPosition(canvas: { width: number; height: number }, box: { x: number; y: number; w: number; h: number }, mode: 'x' | 'y' | 'top' | 'bottom'): { positionX?: number; positionY?: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100, cx = r2((canvas.width - box.w) / 2);
  if (mode === 'x') return { positionX: cx };
  if (mode === 'y') return { positionY: r2((canvas.height - box.h) / 2) };
  return { positionX: cx, positionY: mode === 'top' ? Math.max(0, Math.round(0.3 * canvas.height) - box.h) : Math.round(0.7 * canvas.height) };
}
export function TextTransformBody({ doc, item }: Body) {
  const align = (mode: 'x' | 'y' | 'top' | 'bottom') => {
    const b = itemBox(doc, item, local(item));
    editText(item, alignedPosition(projectSize(doc), { x: b.x, y: b.y, w: Math.abs(b.W * b.sx), h: Math.abs(b.H * b.sy) }, mode));
  };
  return <><div className="row" role="group" aria-label="Align on canvas">
    <button aria-label="Centre horizontally" onClick={() => align('x')}>⇹</button>
    <button aria-label="Centre vertically" onClick={() => align('y')}>⤒</button>
    <button aria-label="Centre horizontally at the top" onClick={() => align('top')}>⤒⇹</button>
    <button aria-label="Centre horizontally at the bottom" onClick={() => align('bottom')}>⤓⇹</button>
  </div>{['scale', 'rotation', 'positionX', 'positionY'].map(k => <PropRow key={k} doc={doc} item={item} k={k} />)}</>;
}

/** Font Stroke: Color (transparent) and Size (0). */
export function FontStrokeBody({ doc, item }: Body) {
  return <><label className="row">Color<ColourPicker key={item.id} label="Stroke colour" value={String(staticValue(item, 'borderColor') ?? 'transparent')} onChange={c => editText(item, { borderColor: c })} /></label>
    <PropRow doc={doc} item={item} k="borderWidth" /></>;
}
/** Font Shadow: Color transparent, X 0, Y 0, Blur 0 (the T04 shadow rows; boxShadow merges per field). */
export const FontShadowBody = ShadowBody;
