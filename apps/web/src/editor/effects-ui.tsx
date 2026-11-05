// SPDX-License-Identifier: AGPL-3.0-only
// T10 Effects UI (findings part 3 §46.9; part 2 §39; part 4 §49.1): the rail's Effects panel (39 effects in Xapp's order;
// a click applies one to the selection, a drag drops it on the Effects tab), the inspector's Effects tab (the Color card,
// then one card per stored instance in stack order) and the "+ Add Effect" picker (36 rows with category tags). Every
// edit is a T10 intent through the command bus, one "Edit items" entry each. Labels and groups that differ from the
// registry keys follow Xapp's cards (§46.9).
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ProjectDocument, RecordData } from '../store/model';
import { ADVANCED_GROUPS, BASIC_SLIDERS, COLOUR_BLOCK_EFFECTS, NEUTRAL_WHEEL, puckHue, puckOffset, wheelFromPointer } from '../effects/colour-block';
import type { ColourBlockEffect } from '../effects/colour-block';
import { cubeTitle } from '../effects/lut';
import { EFFECT_ITEM_TYPES } from '../effects/queries';
import { effectById } from '../effects/registry';
import type { Category, EffectDefinition, ItemType, NumberParam, ParamDef, Wheel } from '../effects/schema';
import { newInstanceParams } from '../effects/validate';
import { effectStack, isInternal, paramProp, paramValue } from '../timeline/effects';
import { span } from '../timeline/model';
import { evaluate, propertyTime, toTimelineMs } from '../timeline/properties';
import { activeRuntime } from '../timeline/runtime';
import { formatColour } from './colour';
import { dispatch } from './commands';
import { ColourPicker, Popover, Slider } from './controls';
import { Switch } from './inspector';
import { toggleKeyframesShown, useView } from './view';

/** The rail's 39 effects in Xapp's order (§46.9); the picker lists them without the Color card's three. */
export const RAIL_EFFECTS = ['color-wheels', 'levels', 'curves', 'hsl', 'lut', 'secondary-qualifier', 'power-window', 'retouch', 'posterize',
  'color-key', 'luma-key', 'grayscale', 'sepia', 'vignette', 'sharpen', 'glow', 'glitch', 'vhs', 'pixelate', 'ascii', 'edge-detection', 'invert',
  'box-blur', 'motion-blur', 'radial-blur', 'zoom-blur', 'scanlines', 'threshold', 'dither', 'halftone', 'chromatic-aberration', 'lens-distortion',
  'twirl', 'wave', 'kaleidoscope', 'mirror', 'film-grain', 'gaussian-blur', 'drop-shadow'];
export const PICKER_EFFECTS = RAIL_EFFECTS.filter(id => !(COLOUR_BLOCK_EFFECTS as readonly string[]).includes(id));
const RAIL_NAMES: Record<string, string> = { lut: 'LUT (.cube)', 'secondary-qualifier': 'Secondary (HSL Qualifier)' };
const effectName = (id: string) => RAIL_NAMES[id] ?? effectById(id)?.name ?? id;
const CATEGORY_NAMES: Record<Category, string> = { color: 'Color', stylize: 'Stylize', distort: 'Distort', generate: 'Generate' };
/** Drag data: a rail effect (copy) and a card being reordered (move). */
export const EFFECT_DATA_TYPE = 'application/x-cutframe-effect';
const MOVE_DATA_TYPE = 'application/x-cutframe-effect-move';
const carries = (data: DataTransfer, type: string) => Array.from(data.types).includes(type);
const matches = (id: string, q: string) => !q || effectName(id).toLowerCase().includes(q) || !!effectById(id)?.tags.some(t => t.includes(q));
/** Parity mode (bus option sliderEntries 'step'): a drag commits every step. */
const perStep = () => activeRuntime?.bus.options.sliderEntries === 'step';
const clean = (n: number) => Number(n.toFixed(6));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- Card labels, groups and display digits (§46.9, §49.1).
const LABELS: Record<string, Record<string, string>> = {
  'power-window': { sizeX: 'Width', sizeY: 'Height' }, 'lens-distortion': { mirrorEdges: 'Extend Edges' }, scanlines: { speed: 'Scroll Speed' },
  wave: { amplitudeX: 'Horizontal Amp', amplitudeY: 'Vertical Amp', frequencyX: 'Horizontal Freq', frequencyY: 'Vertical Freq' },
  'drop-shadow': { x: 'Offset X', y: 'Offset Y' }, ascii: { monoColor: 'Mono Color', bgColor: 'Background' },
  halftone: { colorFront: 'Front Color', colorBack: 'Back Color' }, 'luma-key': { keyType: 'Key Out' }, 'color-wheels': { hue: 'Hue Shift', colorBoost: 'Vibrance' },
};
const WHEEL_LABELS: Record<string, string> = { shadowsWheel: 'Shadows', midtonesWheel: 'Midtones', highlightsWheel: 'Highlights', offsetWheel: 'Offset' };
function labelOf(effectId: string, p: ParamDef): string {
  const own = LABELS[effectId]?.[p.key];
  if (own) return own;
  if (p.type === 'colorWheel') return WHEEL_LABELS[p.key] ?? p.label;
  if (effectId === 'curves' || effectId === 'hsl') return p.label.replace(/^\S+ /, ''); // 'Master Shadow X' → 'Shadow X', 'Red Hue' → 'Hue'
  return p.label;
}
/** Shown decimals where they differ from the step's: Curves points 0.00 (step 0.001), Black / White Point and Offset 0.00. */
const digitsOf = (effectId: string, key: string) => effectId === 'curves' ? 2 : effectId === 'color-wheels' && ['blackPoint', 'whitePoint', 'offset'].includes(key) ? 2 : undefined;
const CORRECTION = ['exposure', 'saturation', 'temperature', 'tint', 'strength'];
/** Headed groups inside a card. */
function sectionOf(effectId: string, key: string): string | undefined {
  if (effectId === 'power-window') return CORRECTION.includes(key) ? 'CORRECTION' : 'WINDOW';
  if (effectId === 'secondary-qualifier') return CORRECTION.includes(key) ? 'CORRECTION' : 'SELECTION';
  if (effectId === 'retouch') return ['strength', 'radius', 'detail', 'edgeTolerance'].includes(key) ? 'SMOOTHING' : 'SKIN RANGE';
  return undefined;
}
const CHANNELS = ['master', 'red', 'green', 'blue'];
const curveKeys = (ch: string) => ['ShadowX', 'ShadowY', 'HighlightX', 'HighlightY'].map(k => `${ch}${k}`);
/** A card's rows: hidden keys, the baked LUT table, the name (shown by the loader) and the Curves keys without UI left out;
 *  ASCII shows its swatches first. */
function cardParams(d: EffectDefinition): ParamDef[] {
  const curves = new Set(CHANNELS.flatMap(curveKeys));
  const list = d.params.filter(p => !p.hidden && p.key !== 'lutData' && p.key !== 'lutName' && (d.id !== 'curves' || curves.has(p.key)));
  return d.id === 'ascii' ? [...list.filter(p => p.type === 'color'), ...list.filter(p => p.type !== 'color')] : list;
}
const numberParam = (effectId: string, key: string) => effectById(effectId)!.params.find(p => p.key === key) as NumberParam;
const wheelOf = (v: unknown): Wheel => { const w = v as Partial<Wheel> | undefined; return { angle: Number(w?.angle) || 0, distance: Number(w?.distance) || 0 }; };
/** Registry colour defaults are rgba(); the picker reads hex. */
function hexOf(c: string) {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  return m ? formatColour({ r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }) : c;
}
/** The reset arrow shows once any parameter differs from its new-instance value or is keyframed. */
function isFresh(e: RecordData, d: EffectDefinition) {
  const fresh = newInstanceParams(d.id);
  return Object.keys(e.parameters ?? {}).every(k => k in fresh) && Object.entries(fresh).every(([k, v]) => { const p = paramProp(e, k); return !p || (!p.keyframes.length && same(p.defaultValue, v)); });
}

// ---- Rail panel.
export function EffectsRail() {
  const v = useView(), [query, setQuery] = useState(''), list = RAIL_EFFECTS.filter(id => matches(id, query.trim().toLowerCase()));
  return <section aria-label="Effects" className="tool-panel effects-rail"><h3>Effects</h3>
    <input aria-label="Search effects" placeholder="Search effects" value={query} onChange={e => setQuery(e.target.value)} />
    {!v.selection.length && <p>Select a timeline item first to apply an effect.</p>}
    <ul className="effect-names" aria-label="Effects">{list.map(id => <li key={id} draggable onDragStart={e => { e.dataTransfer.setData(EFFECT_DATA_TYPE, id); e.dataTransfer.effectAllowed = 'copy'; }}>
      <button disabled={!v.selection.length} onClick={() => dispatch({ type: 'addEffect', itemIds: v.selection, effectId: id })}>{effectName(id)}</button></li>)}</ul>
    {!list.length && <p>No effects match.</p>}
  </section>;
}

// ---- Inspector Effects tab.
export function EffectsTab({ doc, item, itemIds }: { doc: ProjectDocument; item: RecordData; itemIds: string[] }) {
  const [picker, setPicker] = useState(false), [over, setOver] = useState(false);
  if (!EFFECT_ITEM_TYPES.includes(item.type)) return <p>Visual effects apply to visual items.</p>;
  const stack = effectStack(item).filter(e => !isInternal(e) && effectById(e.effectId)?.visibility !== 'hidden');
  return <div className={`effects-tab${over ? ' drop' : ''}`}
    onDragOver={e => { if (carries(e.dataTransfer, EFFECT_DATA_TYPE)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
    onDrop={e => { setOver(false); const id = e.dataTransfer.getData(EFFECT_DATA_TYPE); if (id) { e.preventDefault(); dispatch({ type: 'addEffect', itemIds, effectId: id }); } }}>
    {effectById('color-wheels')!.itemTypes.includes(item.type) && <ColourCard item={item} itemIds={itemIds} />}
    {stack.length ? stack.map((e, n) => <EffectCard key={e.id} item={item} entry={e} index={n} count={stack.length} fps={doc.fps} />)
      : <p>No effects applied. Drag an effect from the sidebar or use + Add Effect.</p>}
    <div className="add-effect"><button aria-expanded={picker} onClick={() => setPicker(!picker)}>+ Add Effect</button>
      {picker && <EffectPicker type={item.type} itemIds={itemIds} close={() => setPicker(false)} />}</div>
  </div>;
}
/** "+ Add Effect": the effects this item type takes, a click applies one at once. */
function EffectPicker({ type, itemIds, close }: { type: ItemType; itemIds: string[]; close: () => void }) {
  const [query, setQuery] = useState(''), list = PICKER_EFFECTS.filter(id => effectById(id)!.itemTypes.includes(type) && matches(id, query.trim().toLowerCase()));
  return <Popover label="Add Effect" close={close} className="effect-picker">
    <input aria-label="Search effects to add" placeholder="Search effects" autoFocus value={query} onChange={e => setQuery(e.target.value)} />
    <ul aria-label="Effects to add">{list.map(id => { const c = effectById(id)!.category; return <li key={id}>
      <button aria-label={effectName(id)} onClick={() => { close(); dispatch({ type: 'addEffect', itemIds, effectId: id }); }}>{effectName(id)}<span className={`tag ${c}`}>{CATEGORY_NAMES[c]}</span></button></li>; })}</ul>
    {!list.length && <p>No effects match.</p>}
  </Popover>;
}

/** One stored instance: grip (drag, or ↑ / ↓ when focused), enable switch, name, reset arrow, remove, collapse. */
function EffectCard({ item, entry, index, count, fps }: { item: RecordData; entry: RecordData; index: number; count: number; fps: number }) {
  const d = effectById(entry.effectId), name = d?.name ?? entry.effectId, on = entry.enabled !== false, ids = { itemId: item.id, instanceId: entry.id };
  const [open, setOpen] = useState(true), [over, setOver] = useState(false);
  const move = (to: number) => { if (to >= 0 && to < count && to !== index) dispatch({ type: 'moveEffect', ...ids, to }); };
  return <section className={`effect-card${on ? '' : ' off'}${over ? ' drop' : ''}`} aria-label={name} data-effect={entry.effectId} data-instance={entry.id}
    onDragOver={e => { if (carries(e.dataTransfer, MOVE_DATA_TYPE)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
    onDrop={e => { setOver(false); const id = e.dataTransfer.getData(MOVE_DATA_TYPE); if (!id) return; e.preventDefault(); e.stopPropagation(); if (id !== entry.id) dispatch({ type: 'moveEffect', itemId: item.id, instanceId: id, to: index }); }}>
    <div className="card-heading">
      <button className="grip" draggable aria-label={`Reorder ${name}`} title="Drag, or press ↑ / ↓, to reorder"
        onDragStart={e => { e.dataTransfer.setData(MOVE_DATA_TYPE, entry.id); e.dataTransfer.effectAllowed = 'move'; }}
        onKeyDown={e => { const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0; if (step) { e.preventDefault(); move(index + step); } }}>⠿</button>
      <Switch label={`Enable ${name}`} on={on} onClick={() => dispatch({ type: 'toggleEffect', ...ids, enabled: !on })} />
      <h4>{name}</h4>
      {d && !isFresh(entry, d) && <button className="reset" aria-label={`Reset ${name}`} title={`Reset ${name}`} onClick={() => dispatch({ type: 'resetEffect', ...ids })}>↺</button>}
      <button aria-label={`Remove ${name}`} title="Remove" onClick={() => dispatch({ type: 'removeEffect', ...ids })}>🗑</button>
      <button aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button>
    </div>
    {open && d && <CardBody item={item} entry={entry} d={d} fps={fps} />}
  </section>;
}
function ChannelTabs({ channel, setChannel }: { channel: string; setChannel: (c: string) => void }) {
  return <div role="tablist" aria-label="Curves channel" className="channel-tabs">{CHANNELS.map(c =>
    <button key={c} role="tab" aria-selected={channel === c} onClick={() => setChannel(c)}>{c[0].toUpperCase() + c.slice(1)}</button>)}</div>;
}
function CardBody({ item, entry, d, fps }: { item: RecordData; entry: RecordData; d: EffectDefinition; fps: number }) {
  const [channel, setChannel] = useState('master'), params = cardParams(d);
  const row = (p: ParamDef) => <ParamRow key={p.key} item={item} entry={entry} p={p} fps={fps} />;
  if (d.id === 'curves') return <><ChannelTabs channel={channel} setChannel={setChannel} />{curveKeys(channel).map(k => row(d.params.find(p => p.key === k)!))}</>;
  if (d.id === 'hsl') return <>{[...new Set(params.map(p => p.group!))].map(band => <details key={band} className="band"><summary>{band}</summary>{params.filter(p => p.group === band).map(row)}</details>)}</>;
  const sections = [...new Set(params.map(p => sectionOf(d.id, p.key)))];
  if (sections[0] !== undefined) return <>{sections.map(s => <div key={s} role="group" aria-label={s} className="card-section"><h5>{s}</h5>{params.filter(p => sectionOf(d.id, p.key) === s).map(row)}</div>)}</>;
  return <>{params.map(row)}{d.id === 'lut' && <LutLoader name={String(paramValue(entry, 'lutName') ?? '')} onLoad={values => dispatch({ type: 'effectParams', itemId: item.id, instanceId: entry.id, values })} />}</>;
}
function ParamRow({ item, entry, p, fps }: { item: RecordData; entry: RecordData; p: ParamDef; fps: number }) {
  const label = labelOf(entry.effectId, p), value = paramValue(entry, p.key);
  const set = (v: unknown) => dispatch({ type: 'effectParams', itemId: item.id, instanceId: entry.id, values: { [p.key]: v } });
  switch (p.type) {
    case 'number': return <EffectSlider item={item} entry={entry} p={p} label={label} fps={fps} />;
    case 'boolean': return <div className="row"><span>{label}</span><Switch label={label} on={value === true} onClick={() => set(value !== true)} /></div>;
    case 'select': return <label className="row">{label}<select aria-label={label} value={String(value)} onChange={e => set(e.target.value)}>{p.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
    case 'color': return <div className="row"><span>{label}</span><ColourPicker label={label} value={hexOf(String(value))} onChange={set} /></div>;
    case 'colorWheel': return <WheelControl label={label} value={wheelOf(value)} onCommit={set} />;
    default: return null;
  }
}
/** A number parameter: the value at the playhead; on a keyframe the slider edits that keyframe, otherwise the static value.
 *  The diamond adds a keyframe at the playhead (animatable parameters only); the eye shows or hides the clip's diamonds. */
function EffectSlider({ item, entry, p, label, fps }: { item: RecordData; entry: RecordData; p: NumberParam; label: string; fps: number }) {
  const v = useView(), pr = paramProp(entry, p.key), kfs = pr?.keyframes ?? [], local = v.playheadMs - item.display.from, len = span(item);
  const inside = local >= 0 && local <= len, at = kfs.find(k => Math.abs(toTimelineMs(item, k.time) - v.playheadMs) <= 500 / fps);
  const value = clean(Number(kfs.length ? evaluate(kfs, pr!.defaultValue, propertyTime(item, Math.min(Math.max(local, 0), len))) : paramValue(entry, p.key)));
  const target = at && { itemId: item.id, key: p.key, keyframeId: at.id, effect: entry.id }, eye = `${entry.id}.${p.key}`, shown = !v.keyframesHidden.includes(`${item.id}:${eye}`);
  const commit = (n: number) => target ? dispatch({ type: 'editKeyframe', target, patch: { value: n } }) : dispatch({ type: 'effectParams', itemId: item.id, instanceId: entry.id, values: { [p.key]: n } });
  return <div className={`prop-row${at ? ' on-keyframe' : ''}`}>
    <Slider label={label} value={value} range={p} unit={p.unit} digits={digitsOf(entry.effectId, p.key)} perStep={perStep} onCommit={commit} />
    {p.animatable && <span className="kf-tools">
      <button className={`kf-diamond${at ? ' filled' : ''}`} aria-label={at ? `${label} keyframe at playhead` : `Add ${label} keyframe`} aria-pressed={!!at} disabled={!inside}
        title={inside ? undefined : 'Move the playhead over this clip to add a keyframe'} onClick={() => { if (!at) dispatch({ type: 'addKeyframe', itemId: item.id, key: p.key, atMs: v.playheadMs, effect: entry.id }); }}>◆</button>
      <button className="kf-eye" aria-label={`Show ${label} keyframes on the timeline`} aria-pressed={shown} disabled={!kfs.length} onClick={() => toggleKeyframesShown(item.id, eye)}>{shown ? '👁' : '⊘'}</button>
    </span>}
    {at && target && <div className="kf-time"><span>{((toTimelineMs(item, at.time) - item.display.from) / 1000).toFixed(2)}s</span>
      <button className="link" aria-label={`Delete ${label} keyframe`} onClick={() => dispatch({ type: 'deleteKeyframe', target })}>Delete</button></div>}
  </div>;
}

const WHEEL_PX = 72;
/** A colour wheel (§49.1): drag the puck (committed on release; a plain click changes nothing), double-click for neutral. */
function WheelControl({ label, value, onCommit }: { label: string; value: Wheel; onCommit: (w: Wheel) => void }) {
  const [live, setLive] = useState<Wheel | null>(null), drag = useRef(false), shown = live ?? value, { dx, dyDown } = puckOffset(shown, WHEEL_PX);
  const at = (e: ReactPointerEvent<HTMLDivElement>) => { const b = e.currentTarget.getBoundingClientRect(); return wheelFromPointer(e.clientX - b.left - b.width / 2, e.clientY - b.top - b.height / 2, b.width); };
  return <div className="wheel-field">
    <div className="colour-wheel" role="slider" tabIndex={0} aria-label={`${label} wheel`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown.distance * 100)}
      aria-valuetext={`${shown.angle}°, ${Math.round(shown.distance * 100)}%`} style={{ width: WHEEL_PX, height: WHEEL_PX }}
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = false; }}
      onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; drag.current = true; setLive(at(e)); }}
      onPointerUp={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const w = drag.current ? at(e) : null; drag.current = false; setLive(null); if (w && !same(w, value)) onCommit(w); }}
      onPointerCancel={() => { drag.current = false; setLive(null); }}
      onDoubleClick={() => { if (!same(value, NEUTRAL_WHEEL)) onCommit(NEUTRAL_WHEEL); }}>
      <span className="wheel-puck" style={{ left: WHEEL_PX / 2 + dx, top: WHEEL_PX / 2 + dyDown, background: `hsl(${puckHue(shown)}, 100%, 50%)` }} />
    </div>
    <span>{label}</span>
  </div>;
}
/** "Load .cube LUT": the file's text goes to lutData (baked on write); the name is the cube TITLE, else the file name. */
function LutLoader({ name, onLoad }: { name: string; onLoad: (values: RecordData) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="row lut-row"><span className="lut-name">{name || 'No LUT loaded'}</span>
    <button onClick={() => input.current?.click()}>Load .cube LUT</button>
    <input ref={input} type="file" accept=".cube" hidden aria-label="LUT file" onChange={e => {
      const f = e.target.files?.[0]; e.target.value = '';
      if (f) void f.text().then(text => onLoad({ lutData: text, ...(cubeTitle(text) === undefined ? { lutName: f.name.replace(/\.cube$/i, '') } : {}) }));
    }} />
  </div>;
}

// ---- The Color card (part 2 §39, part 4 §49.1 [C]): a front end over the FIRST color-wheels, curves and lut instances of the
// shown item; an edit applies to every selected item and creates the instance at the end of the stack on first use. Its
// switch bypasses and its reset arrow deletes the three (shown once one exists). Advanced is rendered only while open.
function ColourCard({ item, itemIds }: { item: RecordData; itemIds: string[] }) {
  const stack = effectStack(item), first = (id: ColourBlockEffect) => stack.find(e => e.effectId === id);
  const block = COLOUR_BLOCK_EFFECTS.map(first).filter((e): e is RecordData => !!e), on = block.some(e => e.enabled !== false);
  const [advanced, setAdvanced] = useState(false), [channel, setChannel] = useState('master');
  const commit = (effectId: ColourBlockEffect, values: RecordData) => dispatch({ type: 'colourBlock', itemIds, effectId, values });
  const value = (effectId: ColourBlockEffect, key: string) => { const e = first(effectId); return e ? paramValue(e, key) : effectById(effectId)!.params.find(p => p.key === key)!.default; };
  const slider = (effectId: ColourBlockEffect, key: string, label: string) => { const p = numberParam(effectId, key);
    return <Slider key={key} label={label} value={Number(value(effectId, key))} range={p} unit={p.unit} digits={digitsOf(effectId, key)} perStep={perStep} onCommit={n => commit(effectId, { [key]: n })} />; };
  const wheels = effectById('color-wheels')!;
  return <section className="slider-card colour-card" aria-label="Color">
    <div className="card-heading"><h4>Color</h4>{block.length > 0 && <span className="card-tools">
      <Switch label="Enable Color" on={on} onClick={() => dispatch({ type: 'bypassGrade', itemIds, enabled: !on })} />
      <button className="reset" aria-label="Reset Color" title="Reset Color" onClick={() => dispatch({ type: 'resetGrade', itemIds })}>↺</button></span>}</div>
    {BASIC_SLIDERS.map(s => slider('color-wheels', s.key, s.label))}
    <details className="advanced" open={advanced} onToggle={e => setAdvanced(e.currentTarget.open)}><summary>Advanced</summary>
      {advanced && <>
        <h5>WHEELS</h5><div className="wheels">{ADVANCED_GROUPS.wheels.map(k => <WheelControl key={k} label={WHEEL_LABELS[k]} value={wheelOf(value('color-wheels', k))} onCommit={w => commit('color-wheels', { [k]: w })} />)}</div>
        <h5>PRIMARIES</h5>{ADVANCED_GROUPS.primaries.map(k => slider('color-wheels', k, labelOf('color-wheels', wheels.params.find(p => p.key === k)!)))}
        <h5>TONE</h5>{ADVANCED_GROUPS.tone.map(k => slider('color-wheels', k, labelOf('color-wheels', wheels.params.find(p => p.key === k)!)))}
        <h5>CURVES</h5><ChannelTabs channel={channel} setChannel={setChannel} />{curveKeys(channel).map(k => slider('curves', k, labelOf('curves', numberParam('curves', k))))}
        <h5>LUT</h5><LutLoader name={String(value('lut', 'lutName') ?? '')} onLoad={values => commit('lut', values)} />
      </>}
    </details>
  </section>;
}
