// SPDX-License-Identifier: AGPL-3.0-only
// T04 property sheets (part 3 §46.6, §46.10, §46.11): the Basic / Speed & Time Remap / Transform / Appearance / Shadow /
// Volume section bodies of video, image, audio and motion-graphic items. Every row edits through the command bus: a slider
// on a keyframe at the playhead edits that keyframe, otherwise the property's value ("Edit items"); Speed is "Change
// speed". The keyframe diamond adds a keyframe at the playhead; the eye only shows or hides the clip's diamonds
// (W3-ED-11: view state, no stored change). No per-slider reset (§46.6).
import { useState } from 'react';
import type { ProjectDocument, RecordData } from '../store/model';
import { usesProxy } from '../media/resolver';
import { BLEND_MODES } from '../timeline/edits';
import { span } from '../timeline/model';
import { prop, RATE, specOf, staticValue, toTimelineMs, valueAt } from '../timeline/properties';
import type { Keyframe } from '../timeline/properties';
import { activeRuntime } from '../timeline/runtime';
import { dispatch } from './commands';
import { ColourPicker, Slider } from './controls';
import type { Range } from './slider';
import { useRemapCache } from './remap-cache';
import { toggleKeyframesShown, useView, view } from './view';

/** A property row in display units: stored = display ÷ factor (opacity 1 shows 100 %). */
export type RowSpec = { key: string; label: string; range: Range; unit: string; factor: number };
const sourceLength = (item: RecordData) => typeof item.sourceDuration === 'number' && item.sourceDuration > 0 ? item.sourceDuration : item.trim?.to ?? span(item);
/** Labels and display ranges (§46.6). Registry bounds where they exist; Scale 0–500 % and X / Y ±canvas are provisional
 *  choices, not Xapp parity (Author question in the T04 notes). */
export function rowSpec(doc: ProjectDocument, item: RecordData, key: string): RowSpec {
  const row = (label: string, min: number, max: number, unit: string, factor = 1, step = 1) => ({ key, label, range: { min, max, step }, unit, factor });
  switch (key) {
    case 'opacity': return row('Opacity', 0, 100, '%', 100);
    case 'volume': return row('Volume', 0, 300, '%', 100);
    case 'brightness': return row('Bright', 0, 200, '%', 100);
    case 'scale': return row('Scale', 0, 500, '%', 100);
    case 'rotation': return row('Rotation', -360, 360, '°');
    case 'positionX': return row('X', -doc.size.width, doc.size.width, 'px');
    case 'positionY': return row('Y', -doc.size.height, doc.size.height, 'px');
    case 'borderRadius': return row('Radius', 0, 500, 'px');
    case 'borderWidth': return row(item.type === 'text' ? 'Size' : 'Outline Size', 0, 20, 'px'); // T05: Font Stroke Size (§46.6 Text row)
    case 'timeRemap': return row('Time Remap', 0, Math.round(sourceLength(item)) / 1000, 's', 0.001, 0.01);
    // T06 shape rows (§46.6 Shape row): Fill % = fill opacity; stroke Width 0–50 px (W3-ED-08).
    case 'fillOpacity': return row('Fill', 0, 100, '%', 100);
    case 'strokeWidth': return row('Width', 0, 50, 'px');
    default: { const s = specOf(item.type, key); return row(key, s?.min ?? 0, s?.max ?? 1000, s?.unit === '%' ? '%' : s?.unit ?? '', s?.unit === '%' ? 100 : 1); }
  }
}
/** The property's keyframe under the playhead (within half a project frame), if any. */
export function keyframeAt(item: RecordData, key: string, playheadMs: number, fps: number): Keyframe | undefined {
  return (prop(item, key)?.keyframes ?? []).find(k => Math.abs(toTimelineMs(item, k.time) - playheadMs) <= 500 / fps);
}
/** Parity mode (bus option sliderEntries 'step'): a drag commits every step. */
const perStep = () => activeRuntime?.bus.options.sliderEntries === 'step';
const edit = (item: RecordData, label: string, key: string, value: unknown) => dispatch({ type: 'editProperty', itemIds: [item.id], owner: 'T04', label, key, value });
const clean = (n: number) => Number(n.toFixed(6));

/** One keyframeable slider row: hover-revealed diamond, eye, and the "0.00s · Delete" sub-row on a keyframe. */
export function PropRow({ doc, item, k }: { doc: ProjectDocument; item: RecordData; k: string }) {
  const v = useView(), s = rowSpec(doc, item, k), kfs = prop(item, k)?.keyframes ?? [], local = v.playheadMs - item.display.from;
  const inside = local >= 0 && local <= span(item), at = keyframeAt(item, k, v.playheadMs, doc.fps), shown = !v.keyframesHidden.includes(`${item.id}:${k}`);
  const value = clean(Number(valueAt(item, k, Math.min(Math.max(local, 0), span(item)))) * s.factor);
  const target = at && { itemId: item.id, key: k, keyframeId: at.id };
  const commit = (display: number) => target ? dispatch({ type: 'editKeyframe', target, patch: { value: clean(display / s.factor) } }) : edit(item, s.label, k, clean(display / s.factor));
  return <div className={`prop-row${at ? ' on-keyframe' : ''}`}>
    <Slider label={s.label} value={value} range={s.range} unit={s.unit} perStep={perStep} onCommit={commit} />
    <span className="kf-tools">
      <button className={`kf-diamond${at ? ' filled' : ''}`} aria-label={at ? `${s.label} keyframe at playhead` : `Add ${s.label} keyframe`} aria-pressed={!!at} disabled={!inside}
        title={inside ? undefined : 'Move the playhead over this clip to add a keyframe'} onClick={() => { if (!at) dispatch({ type: 'addKeyframe', itemId: item.id, key: k, atMs: v.playheadMs }); }}>◆</button>
      <button className="kf-eye" aria-label={`Show ${s.label} keyframes on the timeline`} aria-pressed={shown} disabled={!kfs.length} onClick={() => toggleKeyframesShown(item.id, k)}>{shown ? '👁' : '⊘'}</button>
    </span>
    {at && target && <div className="kf-time"><span>{((toTimelineMs(item, at.time) - item.display.from) / 1000).toFixed(2)}s</span>
      <button className="link" aria-label={`Delete ${s.label} keyframe`} onClick={() => dispatch({ type: 'deleteKeyframe', target })}>Delete</button></div>}
  </div>;
}
/** A plain slider row in display units (Shadow X / Y / Blur: boxShadow fields, not keyframeable). */
function ShadowSlider({ item, field, label, range }: { item: RecordData; field: 'x' | 'y' | 'blur'; label: string; range: Range }) {
  const shadow = staticValue(item, 'boxShadow') as RecordData | undefined;
  return <Slider label={label} value={Number(shadow?.[field] ?? 0)} range={range} unit="px" perStep={perStep} onCommit={n => edit(item, `Shadow ${label}`, 'boxShadow', { [field]: n })} />;
}
/** Lock Ratio (§46.6): Yes by default; it changes nothing visible in Xapp either, so it is view state here. */
function LockRatio() {
  const [locked, setLocked] = useState(true);
  return <div className="row" role="group" aria-label="Lock Ratio"><span>Lock Ratio</span>
    <button aria-pressed={locked} onClick={() => setLocked(true)}>Yes</button><button aria-pressed={!locked} onClick={() => setLocked(false)}>No</button></div>;
}
const modeLabel = (m: string) => m.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
export function BlendMode({ item }: { item: RecordData }) {
  return <label className="row">Blend Mode<select aria-label="Blend Mode" value={String(staticValue(item, 'blendMode') ?? 'normal')} onChange={e => edit(item, 'Blend Mode', 'blendMode', e.target.value)}>
    {BLEND_MODES.map(m => <option key={m} value={m}>{modeLabel(m)}</option>)}</select></label>;
}
export const Switch = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) =>
  <button role="switch" className="switch" aria-label={label} aria-checked={on} onClick={onClick}><span /></button>;
/** T13: the fade shortcut, two volume keyframes per press (audio/edits.ts). */
const Fades = ({ item }: { item: RecordData }) => <div className="row" role="group" aria-label="Fades"><span>Fade</span>
  <button onClick={() => dispatch({ type: 'addFade', itemId: item.id, edge: 'in' })}>Fade in</button>
  <button onClick={() => dispatch({ type: 'addFade', itemId: item.id, edge: 'out' })}>Fade out</button></div>;

type Body = { doc: ProjectDocument; item: RecordData };
export function BasicBody({ doc, item }: Body) {
  return <><LockRatio key={item.id} />
    {item.type === 'video' && <div className="row"><span>Use Proxy</span><Switch label="Use Proxy" on={usesProxy(item)} onClick={() => dispatch({ type: 'setUseProxy', itemId: item.id, on: !usesProxy(item) })} /></div>}
    {item.type === 'video' && <PropRow doc={doc} item={item} k="volume" />}
    {item.type === 'video' && <Fades item={item} />}
    <PropRow doc={doc} item={item} k="opacity" />
    {item.type === 'motionGraphic' && <PropRow doc={doc} item={item} k="brightness" />}
    <BlendMode item={item} /></>;
}
/** Speed (0.1–4×, step 0.1; greyed while Time Remap is on), T13's Keep pitch switch (off by default) and, on video, the
 *  Time Remap switch with its frame cache. */
export function SpeedBody({ item }: Body) {
  const v = useView(), on = !!item.timeRemap, cache = useRemapCache(item.id), eye = !v.keyframesHidden.includes(`${item.id}:timeRemap`);
  return <>
    <Slider label="Speed" value={typeof item.playbackRate === 'number' ? item.playbackRate : 1} range={{ min: RATE.min, max: RATE.max, step: 0.1 }} unit="×" disabled={on} perStep={perStep}
      onCommit={rate => dispatch({ type: 'changeSpeed', itemId: item.id, rate, ripple: view().toolMode === 'ripple' })} />
    <div className="row"><span>Keep pitch</span><Switch label="Keep pitch" on={item.keepPitch === true} onClick={() => dispatch({ type: 'setKeepPitch', itemId: item.id, on: item.keepPitch !== true })} /></div>
    {item.type === 'video' && <div className="remap">
      <div className="row"><span>Time Remap</span><Switch label="Time Remap" on={on} onClick={() => dispatch({ type: 'toggleTimeRemap', itemId: item.id, on: !on })} />
        <button className="kf-eye" aria-label="Time Remap visibility" aria-pressed={eye} disabled={!on} onClick={() => toggleKeyframesShown(item.id, 'timeRemap')}>{eye ? '👁' : '⊘'}</button></div>
      {on && cache?.status === 'building' && <div className="caching"><span>Caching frames… {cache.progress} %</span><progress aria-label="Caching frames" max={100} value={cache.progress} /></div>}
      {on && cache?.status === 'cached' && <p className="hint">Use the graph button to edit the time remap curve. <span className="cached-mark" role="img" aria-label={`Frames cached: ${cache.frames}`}>✓</span></p>}
      {on && cache?.status === 'failed' && <p className="error" role="alert">{cache.message}</p>}
    </div>}
  </>;
}
export function TransformBody({ doc, item }: Body) {
  return <>{['scale', ...(item.type === 'motionGraphic' ? [] : ['rotation']), 'positionX', 'positionY'].map(k => <PropRow key={k} doc={doc} item={item} k={k} />)}
    <div className="row" role="group" aria-label="Flip"><span>Flip</span>{(['flipX', 'flipY'] as const).map(k => {
      const on = staticValue(item, k) === true, label = k === 'flipX' ? 'Flip X' : 'Flip Y';
      return <button key={k} aria-pressed={on} onClick={() => edit(item, label, k, !on)}>{label}</button>;
    })}</div></>;
}
export function AppearanceBody({ doc, item }: Body) {
  return <><PropRow doc={doc} item={item} k="borderRadius" />
    <label className="row">Outline Color<ColourPicker key={item.id} label="Outline colour" value={String(staticValue(item, 'borderColor') ?? '#000000')} onChange={c => edit(item, 'Outline colour', 'borderColor', c)} /></label>
    <PropRow doc={doc} item={item} k="borderWidth" /></>;
}
/** Shadow (§46.6): Color transparent, X 0, Y 0, Blur 0 — one boxShadow value. X / Y ±100 px and Blur 0–100 px are
 *  provisional ranges, not Xapp parity. */
export function ShadowBody({ item }: Body) {
  const colour = String((staticValue(item, 'boxShadow') as RecordData | undefined)?.color ?? 'transparent');
  return <><label className="row">Color<ColourPicker key={item.id} label="Shadow colour" value={colour} onChange={c => edit(item, 'Shadow colour', 'boxShadow', { color: c })} /></label>
    <ShadowSlider item={item} field="x" label="X" range={{ min: -100, max: 100, step: 1 }} />
    <ShadowSlider item={item} field="y" label="Y" range={{ min: -100, max: 100, step: 1 }} />
    <ShadowSlider item={item} field="blur" label="Blur" range={{ min: 0, max: 100, step: 1 }} /></>;
}
export const VolumeBody = ({ doc, item }: Body) => <><PropRow doc={doc} item={item} k="volume" /><Fades item={item} /></>;
