// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption UI (findings part 3 §44, §46.5; W3-RF): the Captions rail panel (source, split by speaker, an AI-template
// gallery, the chunk settings, Generate) and the three caption-only inspector bodies. Text animation, Text, Basic, Font
// Stroke and Font Shadow reuse the T05 / T04 bodies directly (a caption stores its look as text does), so only Word
// behavior (render mode), Caption Text (the transcript correction) and Transform (caption-only geometry) are new here.
// Generate resolves each source's transcript on the panel (captionData is async; the bus op is sync), loads the base
// family's face so the stored boxes measure right, then dispatches one 'generateCaptions' carrying the resolved data.
import { useState, type CSSProperties } from 'react';
import type { ProjectDocument, RecordData } from '../store/model';
import { projectStore } from '../store/database';
import { activeRuntime } from '../timeline/runtime';
import { dispatch } from '../editor/commands';
import { ColourPicker, Popover, Slider } from '../editor/controls';
import { Switch } from '../editor/inspector';
import type { Range } from '../editor/slider';
import { staticValue } from '../timeline/properties';
import { findFont, fontFamilies, loadFont, resolveFont } from '../text/fonts';
import { captionData } from './agent';
import type { SourceButton, SourceData } from './generation';
import { audibleSource, sourcesFor } from './generation';
import { CHUNK_DEFAULTS, LIMITS } from './chunker';
import { findTemplate, PANEL_STYLE, templateOptions, templateStyle, TEMPLATES } from './templates';
import type { StyleSpec, Template } from './templates';
import { RENDER_MODES } from './properties';

type Body = { doc: ProjectDocument; item: RecordData };
const perStep = () => activeRuntime?.bus.options.sliderEntries === 'step';

// ---- Captions rail panel.
/** TC-4: the panel's own source buttons. Speech / Video only / Everything caption everything audible except voice-overs
 *  (the `speech` and `video` filters); only Voiceover captions them; Music lyrics is the music pick. The panel never uses
 *  the agent's `all` (which includes voice-overs). Everything therefore maps to `speech` like Speech — provisional (notes). */
const SOURCES: { button: SourceButton; label: string }[] = [
  { button: 'speech', label: 'Speech' },
  { button: 'video', label: 'Video only' },
  { button: 'voiceover', label: 'Voiceover' },
  { button: 'lyrics', label: 'Music lyrics' },
  { button: 'speech', label: 'Everything' },
];
const accents = (t: Template) => t.accentColors.length ? t.accentColors : [t.style.color ?? '#FFFFFF'];
/** The live preview of a style (the AI-template three-word sample): family / weight / style / colour / spacing / transform.
 *  Size and stroke are left to CSS so a 160 px template still fits the rail; the preview shows the look, not the pixel size. */
const previewCss = (s: StyleSpec): CSSProperties => ({
  fontFamily: s.family, fontWeight: s.fontWeight as CSSProperties['fontWeight'], fontStyle: s.fontStyle, color: s.color,
  letterSpacing: s.letterSpacing === 'normal' ? undefined : s.letterSpacing, textTransform: s.textTransform as CSSProperties['textTransform'],
  background: s.backgroundColor === 'transparent' ? undefined : s.backgroundColor,
});
export function CaptionsPanel({ projectId }: { projectId: string | null }) {
  const [sourceIx, setSourceIx] = useState(0), [split, setSplit] = useState(false);
  // templateId is the APPLIED template that Generate uses; pendingId is what the preview / name / gallery show until Apply
  // commits it (AI Templates: Change browses, Apply commits). None is the initial state and Apply with None restores manual.
  const [templateId, setTemplateId] = useState<string | undefined>(undefined), [pendingId, setPendingId] = useState<string | undefined>(undefined);
  const [galleryOpen, setGalleryOpen] = useState(false), [search, setSearch] = useState('');
  const [maxWords, setMaxWords] = useState(CHUNK_DEFAULTS.maxWords), [maxCharacters, setMaxCharacters] = useState(CHUNK_DEFAULTS.maxCharacters);
  const [fontSize, setFontSize] = useState(PANEL_STYLE.fontSize), [stroke, setStroke] = useState(PANEL_STYLE.borderWidth);
  const [look, setLook] = useState<StyleSpec>({ ...PANEL_STYLE, textDecoration: 'none' }), [error, setError] = useState('');
  const [breakPunct, setBreakPunct] = useState(true), [breakConj, setBreakConj] = useState(true);
  // Start / End are shared between the AI Templates block and Generation Settings (same state, both labels edit it); empty
  // Start = from the beginning, empty End = to the clip end, both empty = the whole clip (no range).
  const [startS, setStartS] = useState(''), [endS, setEndS] = useState('');
  const [busy, setBusy] = useState(false);
  const size = activeRuntime?.bus.doc.size ?? { width: 1080, height: 1920 };
  const pending = findTemplate(pendingId);
  const filtered = TEMPLATES.filter(t => t.name.toLowerCase().includes(search.trim().toLowerCase()));
  // Apply commits the pending template: its own chunk limits and Size / Stroke seed the sliders so a Generate that touches
  // nothing keeps the template's look (the generator re-derives them, but the controls must agree); None restores PANEL_STYLE.
  const apply = () => {
    setTemplateId(pendingId); setGalleryOpen(false);
    const o = pending ? templateOptions(pending, size) : CHUNK_DEFAULTS; setMaxWords(o.maxWords); setMaxCharacters(o.maxCharacters);
    const s = pending ? templateStyle(pending, size) : PANEL_STYLE; setFontSize(s.fontSize); setStroke(s.borderWidth); setLook({ ...s, textDecoration: s.textDecoration ?? 'none' });
  };
  const bounds = () => {
    if (startS.trim() === '' && endS.trim() === '') return null;
    const doc = activeRuntime?.bus.doc;
    return { startMs: Math.max(0, Number(startS) || 0) * 1000, endMs: endS.trim() === '' ? (doc?.duration ?? 0) : Math.max(0, Number(endS) || 0) * 1000 };
  };
  const generate = async () => {
    const rt = activeRuntime; if (!rt || !projectId) return;
    setBusy(true); setError('');
    try {
      const doc = rt.bus.doc, face = resolveFont(look.family, look.fontWeight, look.fontStyle);
      const resolve = await captionData(projectStore, doc, rt.tools.asset);
      const ids = [...new Set(doc.items.filter(i => i.type === 'video' || i.type === 'audio').map(i => i.metadata?.assetId as string).filter(Boolean))];
      const data: Record<string, SourceData> = {};
      for (const id of ids) data[id] = resolve(id);
      const chosen = sourcesFor(doc, { button: SOURCES[sourceIx].button }, resolve);
      if (chosen.some(i => audibleSource(doc, i) && resolve(i.metadata?.assetId).transcript?.segments.some(s => s.words.length))) {
        if (face) await loadFont(face); // the chosen family/weight must be delivered before measuring the generated boxes
      }
      if (activeRuntime !== rt || rt.bus.doc !== doc) { setError('The document changed while caption fonts loaded. Generate again.'); return; }
      dispatch({ type: 'generateCaptions', button: SOURCES[sourceIx].button, range: bounds(), split, templateId, maxWords, maxCharacters, fontSize, borderWidth: stroke,
        fontFamily: look.family, fontWeight: look.fontWeight, fontStyle: look.fontStyle, color: look.color, backgroundColor: look.backgroundColor, textDecoration: look.textDecoration, borderColor: look.borderColor, boxShadow: look.boxShadow,
        breakOnPunctuation: breakPunct, breakOnConjunctions: breakConj, reset: false, data });
    } catch (e) { setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const variants = findFont(look.family)?.entry.variants ?? [], currentFace = resolveFont(look.family, look.fontWeight, look.fontStyle)?.variant.face;
  const decoration = (kind: string) => {
    const next = new Set((look.textDecoration ?? '').split(' ').filter(v => v !== 'none'));
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    setLook({ ...look, textDecoration: [...next].join(' ') || 'none' });
  };
  // Start / End inputs, rendered in both blocks on the one shared state; labelPrefix keeps the two pairs addressable.
  const rangeFields = (labelPrefix: string) => <div className="caption-range" role="group" aria-label={`${labelPrefix} time range`}>
    <label>Start<input aria-label={`${labelPrefix} start (seconds)`} inputMode="decimal" placeholder="start" value={startS} onChange={e => setStartS(e.target.value)} />s</label>
    <label>End<input aria-label={`${labelPrefix} end (seconds)`} inputMode="decimal" placeholder="end" value={endS} onChange={e => setEndS(e.target.value)} />s</label>
  </div>;
  return <section aria-label="Captions" className="tool-panel captions-panel"><h3>Captions</h3>
    <div className="row" role="radiogroup" aria-label="Caption source">{SOURCES.map((s, i) => <button key={s.label} role="radio" aria-checked={sourceIx === i} onClick={() => setSourceIx(i)}>{s.label}</button>)}</div>
    <div className="row"><span>Split by speaker</span><Switch label="Split by speaker" on={split} onClick={() => setSplit(!split)} /></div>
    <section className="caption-ai-templates" aria-label="AI Templates"><h4>AI Templates</h4>
      <div className="caption-template-preview" aria-label="Template preview" style={previewCss(pending ? templateStyle(pending, size) : PANEL_STYLE)}>Add your captions</div>
      <div className="row"><span className="caption-template-name" aria-label="Selected template">{pending?.name ?? 'None'}</span>
        <button aria-label="Change template" aria-expanded={galleryOpen} onClick={() => { setPendingId(templateId); setSearch(''); setGalleryOpen(true); }}>Change</button>
        <button className="caption-template-apply" disabled={pendingId === templateId} onClick={apply}>Apply</button>
      </div>
      {galleryOpen && <Popover label="Caption templates" className="caption-template-gallery" close={() => setGalleryOpen(false)}>
        <input className="caption-template-search" aria-label="Search templates" placeholder="Search templates" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="caption-template-grid" role="listbox" aria-label="Caption templates">
          {filtered.map(t => <button key={t.id} role="option" aria-selected={pendingId === t.id} className="caption-template-tile" onClick={() => setPendingId(t.id)}>
            <span className="caption-template-tile-preview" aria-hidden="true" style={previewCss(templateStyle(t, size))}>Aa</span>
            <strong>{t.name}</strong><small>{t.description}</small>
            <span className="caption-template-accents" aria-hidden="true">{accents(t).map((c, i) => <span key={i} style={{ background: c }} />)}</span>
          </button>)}
        </div>
        <footer className="caption-template-footer"><span className="caption-template-count" aria-live="polite">{filtered.length} {filtered.length === 1 ? 'template' : 'templates'}</span>
          <button onClick={() => setGalleryOpen(false)}>Close</button></footer>
      </Popover>}
      {rangeFields('Template range')}
    </section>
    <section className="caption-manual" aria-label="Manual captions"><h4>Manual Captions</h4>
      <section aria-label="Style"><h5>Style</h5>
        <label className="row">Font<select aria-label="Caption font" value={look.family} onChange={e => setLook({ ...look, family: e.target.value, fontWeight: '400', fontStyle: 'normal' })}>{fontFamilies().map(f => <option key={f.family} value={f.family}>{f.family}</option>)}</select></label>
        <label className="row">Weight<select aria-label="Caption weight" value={currentFace} onChange={e => { const v = variants.find(v => v.face === e.target.value); if (v) setLook({ ...look, fontWeight: String(v.weight), fontStyle: v.italic ? 'italic' : 'normal' }); }}>{variants.map(v => <option key={v.face} value={v.face}>{v.label}</option>)}</select></label>
        <Slider label="Size" value={fontSize} range={{ min: 8, max: 200, step: 1 }} unit="px" perStep={perStep} onCommit={setFontSize} />
        <label className="row">Color<ColourPicker label="Caption text colour" value={look.color} onChange={color => setLook({ ...look, color })} /></label>
        <label className="row">Fill<ColourPicker label="Caption fill colour" value={look.backgroundColor} onChange={backgroundColor => setLook({ ...look, backgroundColor })} /></label>
        <div className="row" role="group" aria-label="Decoration">{[['underline', 'Underline'], ['line-through', 'Strikethrough'], ['overline', 'Overline']].map(([v, label]) => <button key={v} aria-pressed={look.textDecoration?.split(' ').includes(v) ?? false} onClick={() => decoration(v)}>{label}</button>)}</div>
      </section>
      <section aria-label="Font Stroke"><h5>Font Stroke</h5>
        <label className="row">Color<ColourPicker label="Caption stroke colour" value={look.borderColor} onChange={borderColor => setLook({ ...look, borderColor })} /></label>
        <Slider label="Stroke" value={stroke} range={{ min: 0, max: 20, step: 1 }} unit="px" perStep={perStep} onCommit={setStroke} />
      </section>
      <details><summary>Font Shadow</summary>
        <label className="row">Color<ColourPicker label="Caption shadow colour" value={look.boxShadow.color} onChange={color => setLook({ ...look, boxShadow: { ...look.boxShadow, color } })} /></label>
        {(['x', 'y', 'blur'] as const).map(k => <Slider key={k} label={`Shadow ${k === 'blur' ? 'Blur' : k.toUpperCase()}`} value={look.boxShadow[k]} range={{ min: k === 'blur' ? 0 : -100, max: 100, step: 1 }} unit="px" perStep={perStep} onCommit={v => setLook({ ...look, boxShadow: { ...look.boxShadow, [k]: v } })} />)}
      </details>
    </section>
    <div className="caption-settings" aria-label="Generation settings"><h4>Generation Settings</h4>
      <Slider label="Words" value={maxWords} range={{ min: LIMITS.maxWords[0], max: LIMITS.maxWords[1], step: 1 }} perStep={perStep} onCommit={v => setMaxWords(v)} />
      <Slider label="Characters" value={maxCharacters} range={{ min: LIMITS.maxCharacters[0], max: LIMITS.maxCharacters[1], step: 1 }} perStep={perStep} onCommit={v => setMaxCharacters(v)} />
      <div className="row"><span>Break on punctuation</span><Switch label="Break on punctuation" on={breakPunct} onClick={() => setBreakPunct(!breakPunct)} /></div>
      <div className="row"><span>Break on conjunctions</span><Switch label="Break on conjunctions" on={breakConj} onClick={() => setBreakConj(!breakConj)} /></div>
      {rangeFields('Range')}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {projectId ? <button className="caption-generate" disabled={busy} onClick={() => void generate()}>Generate Captions</button> : <p>Open a project to add captions.</p>}
  </section>;
}

// ---- Caption inspector bodies.
const MODE_LABELS: Record<string, string> = { default: 'Default', highlight: 'Highlight', 'word-by-word': 'Word by word', 'slide-up': 'Slide up', 'slide-left': 'Slide left' };
/** Word behavior (§44.3 render modes): the five render modes; Highlight exposes its active-word colour. A render-mode or
 *  highlight-colour change is a caption style edit (editTextProperties → the caption path of editProperties). */
export function WordBehaviorBody({ item }: Body) {
  const mode = typeof item.details?.renderMode === 'string' ? item.details.renderMode : 'default';
  const highlight = String(item.details?.renderConfig?.highlightColor ?? '#FFE600');
  const set = (props: RecordData) => dispatch({ type: 'editTextProperties', itemIds: [item.id], properties: props });
  return <div className="caption-word-behavior" key={item.id}>
    <div className="animation-grid" role="radiogroup" aria-label="Word behavior">{RENDER_MODES.map(m => <button key={m} role="radio" aria-checked={mode === m} onClick={() => set({ renderMode: m })}>{MODE_LABELS[m] ?? m}</button>)}</div>
    {mode === 'highlight' && <label className="row">Highlight<ColourPicker key={item.id} label="Highlight colour" value={highlight} onChange={c => set({ highlightColor: c })} /></label>}
  </div>;
}

type Word = { text: string; startMs: number; endMs: number };
/** Caption Text (contract §4): the caption's words as a correction — a linked caption keeps its binding and re-times, a
 *  detached one re-spreads. The words list below is the stored timing (read-only); the textarea commits the whole text on
 *  blur (Esc reverts, Ctrl/Cmd+Enter commits), so a mid-edit keystroke is not a bus command. */
export function CaptionTextBody({ item }: Body) {
  const text = typeof item.details?.text === 'string' ? item.details.text : '';
  const [draft, setDraft] = useState(text);
  const words = (Array.isArray(item.details?.words) ? item.details!.words : []) as Word[];
  const commit = () => { if (draft !== text) dispatch({ type: 'editTextProperties', itemIds: [item.id], properties: { text: draft } }); };
  return <div className="caption-text" key={item.id}>
    <label className="row caption-correction">Caption Text
      <textarea aria-label="Caption text" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.blur(); } else if (e.key === 'Escape') setDraft(text); }} />
    </label>
    {words.length > 0 && <ol className="caption-words" aria-label="Words">{words.map((w, i) => <li key={i}><span className="word-time">{(w.startMs / 1000).toFixed(2)}s</span> {w.text}</li>)}</ol>}
  </div>;
}

/** Transform (caption-only geometry): Scale / Rotation / X / Y on the caption-only 'editCaptionTransform' command. The shared
 *  caption property whitelist (editCaptionProperties) stays style + text, so these do NOT go through PropRow / editProperties;
 *  the ranges match T04's Transform rows (scale 0–500 %, X / Y ± canvas). Not keyframed (parity of the geometry is unmeasured). */
export function CaptionTransformBody({ doc, item }: Body) {
  const rows: { key: string; label: string; range: Range; unit: string; factor: number; base: number }[] = [
    { key: 'scale', label: 'Scale', range: { min: 0, max: 500, step: 1 }, unit: '%', factor: 100, base: 1 },
    { key: 'rotation', label: 'Rotation', range: { min: -360, max: 360, step: 1 }, unit: '°', factor: 1, base: 0 },
    { key: 'positionX', label: 'X', range: { min: -doc.size.width, max: doc.size.width, step: 1 }, unit: 'px', factor: 1, base: 0 },
    { key: 'positionY', label: 'Y', range: { min: -doc.size.height, max: doc.size.height, step: 1 }, unit: 'px', factor: 1, base: 0 },
  ];
  const clean = (n: number) => Number(n.toFixed(6));
  return <>{rows.map(r => {
    const stored = staticValue(item, r.key), value = clean((typeof stored === 'number' ? stored : r.base) * r.factor);
    return <Slider key={r.key} label={r.label} value={value} range={r.range} unit={r.unit} perStep={perStep} onCommit={v => dispatch({ type: 'editCaptionTransform', itemIds: [item.id], properties: { [r.key]: clean(v / r.factor) } })} />;
  })}</>;
}
