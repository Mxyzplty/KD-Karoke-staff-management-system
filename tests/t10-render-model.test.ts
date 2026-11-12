// SPDX-License-Identifier: AGPL-3.0-only
// T10 render model: framePlan carries each item's effects. Oracle: part 4 §48 0.3 / §51.5 / §51.6 (CSS effects, stack order), §53.4.1 (path and
// filter), §53.9 row 20 (cssScale); the property clock is the trim axis (§38). The WebGL pixels are checked in tests/ui/t10-render.spec.ts.
import { describe, expect, it } from 'vitest';
import { framePlan, itemEffects, isStackedAlpha, projectSize } from '../apps/web/src/render/model';
import type { Draw } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { effectStack } from '../apps/web/src/timeline/effects';
import { build, itemOf, mkItem, mkTrack, video } from './t03-fixtures';

const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
/** v1 at 0–4000 (trim 0), v2 at 4000–8000 trimmed from 1000 ms; t1 is a text item. */
const make = () => {
  const doc: ProjectDocument = build({
    tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')],
    items: [video('v1', 'V1', 0, 4000), video('v2', 'V1', 4000, 8000, 1000), mkItem('t1', 'O1', 0, 2000, { type: 'text', details: { text: 'Hi' } })],
  });
  return createEditor(doc);
};
type Editor = ReturnType<typeof make>;
const fx = (e: Editor, itemId: string, ...adds: (string | { effectId: string; initialParameters?: Record<string, unknown> })[]) =>
  expect(e.call('writeEffects', { itemId, add: adds.map(a => typeof a === 'string' ? { effectId: a } : a) })).toMatchObject({ success: true });
const draws = (e: Editor, t: number, opts = {}) => framePlan(e.doc, t, undefined, undefined, opts).draws as Draw[];
const drawOf = (e: Editor, id: string, t: number, opts = {}) => { const d = draws(e, t, opts).find(x => x.item.id === id); expect(d, `${id} at ${t}`).toBeDefined(); return d!; };
const gpuIds = (d: Draw) => d.effects.map(x => x.effectId);

describe('T10 framePlan: effects are no longer pending', () => {
  it('a video with effects is drawn (pending stays empty) and carries them; the CSS-only ones add a filter, the WebGL ones the list', () => {
    const e = make(); fx(e, 'v1', 'grayscale', 'invert');
    const plan = framePlan(e.doc, 100, undefined, ['V1']);
    expect(plan.pending).toEqual([]); expect(plan.draws.map(d => d.item.id)).toEqual(['v1']);
    expect(gpuIds(plan.draws[0])).toEqual(['grayscale']); expect(plan.draws[0].filter).toBe('invert(100%)'); expect(plan.draws[0].path).toBe('css');
  });
  it('an item without effects keeps the direct path and an empty list', () => {
    const d = drawOf(make(), 'v1', 100);
    expect(d.effects).toEqual([]); expect(d.filter).toBe(''); expect(d.path).toBe('direct');
  });
  it('a WebGL effect alone takes the css path (the item canvas), with no filter string', () => {
    const e = make(); fx(e, 'v1', 'sepia'); const d = drawOf(e, 'v1', 100);
    expect(d.path).toBe('css'); expect(d.filter).toBe(''); expect(gpuIds(d)).toEqual(['sepia']);
  });
  // T05 (assertion edit): was "a text item stays pending on T05". A text is a draw now and takes the generic CSS effect stack.
  it('a text item is drawn (T05) and carries its CSS effects: nothing is pending', () => {
    const e = make(); fx(e, 't1', 'invert');
    const plan = framePlan(e.doc, 100);
    expect(plan.draws.map(d => d.item.id)).toEqual(['v1', 't1']);
    expect(plan.pending).toEqual([]);
    expect(plan.draws[1]).toMatchObject({ kind: 'text', filter: 'invert(100%)', path: 'css' });
    expect(plan.draws[1].text).toBeDefined();
  });
});

describe('T10 framePlan: the GPU list and its order', () => {
  it('lists the enabled WebGL effects in stack order with order = their index in the list and their parameters', () => {
    const e = make(); fx(e, 'v1', { effectId: 'grayscale', initialParameters: { amount: 40 } }, 'invert', 'levels', 'vignette');
    const d = drawOf(e, 'v1', 100);
    expect(gpuIds(d)).toEqual(['grayscale', 'levels', 'vignette']); expect(d.effects.map(x => x.order)).toEqual([0, 1, 2]); expect(d.effects.every(x => x.enabled)).toBe(true);
    expect(d.effects[0].params).toEqual({ amount: 40 });
    expect(d.effects[1].params).toEqual({ inputBlack: 0, inputWhite: 100, gamma: 1, outputBlack: 0, outputWhite: 100 });
  });
  it('follows a reorder', () => {
    const e = make(); fx(e, 'v1', 'grayscale', 'sepia', 'vignette');
    const sepia = effectStack(itemOf(e.doc, 'v1'))[1].id;
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: sepia, to: 0 });
    expect(gpuIds(drawOf(e, 'v1', 100))).toEqual(['sepia', 'grayscale', 'vignette']);
  });
  it('a disabled effect is skipped (and its order slot is not used); turning it back on restores it', () => {
    const e = make(); fx(e, 'v1', 'grayscale', 'sepia', 'vignette');
    const ids = effectStack(itemOf(e.doc, 'v1')).map(x => x.id);
    e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: ids[1], enabled: false });
    const d = drawOf(e, 'v1', 100);
    expect(gpuIds(d)).toEqual(['grayscale', 'vignette']); expect(d.effects.map(x => x.order)).toEqual([0, 1]);
    e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: ids[1], enabled: true }); expect(gpuIds(drawOf(e, 'v1', 100))).toEqual(['grayscale', 'sepia', 'vignette']);
  });
  it('a disabled CSS effect adds nothing to the filter', () => {
    const e = make(); fx(e, 'v1', 'invert'); e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: effectStack(itemOf(e.doc, 'v1'))[0].id, enabled: false });
    const d = drawOf(e, 'v1', 100); expect(d.filter).toBe(''); expect(d.path).toBe('direct');
  });
  it('an internal transport stage is skipped from the list but still marks a stacked-alpha video', () => {
    const e = make(); const v = itemOf(e.doc, 'v1');
    (v.effects as unknown[]).push({ id: 'effect_1_aaaaaaaaa', effectId: 'stacked-alpha', enabled: true, order: 0, parameters: {} });
    fx(e, 'v1', 'sepia', 'invert', 'vignette');
    const d = drawOf(e, 'v1', 100);
    expect(isStackedAlpha(v)).toBe(true); expect(d.stackedAlpha).toBe(true);
    expect(gpuIds(d)).toEqual(['sepia', 'vignette']); expect(d.effects.map(x => x.order)).toEqual([0, 1]); expect(d.filter).toBe('invert(100%)');
  });
  it('the retired Lumetri still renders from a stored instance; a disabled unknown id is ignored', () => {
    const e = make(); fx(e, 'v1', 'sepia');
    const v = itemOf(e.doc, 'v1');
    (v.effects as any[])[0].order = 2; // the stack is read in `order`
    (v.effects as any[]).splice(0, 0,{ id: 'effect_2_bbbbbbbbb', effectId: 'not-an-effect', enabled: false, order: 0, parameters: { x: prop(1) } },
      { id: 'effect_3_ccccccccc', effectId: 'lumetri-color', enabled: true, order: 1, parameters: { exposure: prop(1) } });
    const d = drawOf(e, 'v1', 100);
    expect(gpuIds(d)).toEqual(['lumetri-color', 'sepia']); expect(d.effects[0].params).toEqual({ exposure: 1 });
  });
  it('itemEffects: gpu and css lists for one item at item-local ms', () => {
    const e = make(); fx(e, 'v1', 'invert', 'grayscale', { effectId: 'gaussian-blur', initialParameters: { radius: 2 } });
    const r = itemEffects(itemOf(e.doc, 'v1'), 0);
    expect(r.gpu.map(x => x.effectId)).toEqual(['grayscale']); expect(r.css).toEqual(['invert(100%)', 'blur(2px)']);
  });
});

// Fix round 1 B1. T15's rule (preview-stage.tsx, model.ts Pending): what is not rendered is listed on the stage and in captureFrame (both read
// plan.pending), never drawn wrong. Ticket T10 Build: legacy bg-removal renders for imported projects, owned by T12; recolor is T22.
describe('T10 framePlan: enabled entries the effect path does not draw make the item pending', () => {
  const stored = (e: Editor, effectId: string, enabled: boolean) =>
    (itemOf(e.doc, 'v1').effects as any[]).push({ id: 'effect_9_zzzzzzzzz', effectId, enabled, order: 9, parameters: {} });
  it.each([
    ['bg-removal', 'T12', 'Background removal rendering'],
    // T22 (C8 assertion-only edit): the recolor row is gone. Recolour now renders from the item's element data (render/model.ts Draw.element); tests/t22-render.test.ts covers it.
    ['not-an-effect', '?', "Unknown effect 'not-an-effect'"],
  ])('an enabled stored %s entry → pending %s "%s", not drawn; disabled → drawn with the rest', (effectId, owner, what) => {
    const e = make(); fx(e, 'v1', 'sepia'); stored(e, effectId, true);
    const plan = framePlan(e.doc, 100, undefined, ['V1']);
    expect(plan.draws).toEqual([]); expect(plan.pending).toEqual([{ itemId: 'v1', owner, what }]);
    (itemOf(e.doc, 'v1').effects as any[]).at(-1).enabled = false;
    const again = framePlan(e.doc, 100, undefined, ['V1']);
    expect(again.pending).toEqual([]); expect(again.draws.map(d => gpuIds(d))).toEqual([['sepia']]);
  });
});

// Rebase onto c26dd28: T08 puts motion graphics on the render model, and error codes §7 lists motionGraphic as an effect target. An enabled effect
// on a graphic renders on its frame through the same effect path (pixels: tests/ui/t10-render.spec.ts); what the path cannot draw is pending.
describe('T10 framePlan: effects on a motion graphic (T08 frame)', () => {
  const mgDoc = (code: unknown = 'export const G = () => <AbsoluteFill />;') => createEditor(build({
    tracks: [mkTrack('O1', 'overlay')], items: [mkItem('g', 'O1', 0, 2000, { type: 'motionGraphic', details: { name: 'Graphic', code } })] }));
  it('a graphic with effects is drawn on the effect path with its graphic frame and the CSS filter; nothing is pending', () => {
    const e = mgDoc(); fx(e, 'g', 'invert', { effectId: 'gaussian-blur', initialParameters: { radius: 2 } });
    const plan = framePlan(e.doc, 100);
    expect(plan.pending).toEqual([]); expect(plan.draws.map(d => [d.item.id, d.kind])).toEqual([['g', 'motionGraphic']]);
    const d = plan.draws[0];
    expect(d.graphic?.code).toBe('export const G = () => <AbsoluteFill />;'); expect(d.path).toBe('css');
    expect(gpuIds(d)).toEqual([]); expect(d.filter).toBe('invert(100%) blur(2px)');
  });
  it('the registry gives a graphic the three all-type effects only: a WebGL add is refused EFFECT_NOT_SUPPORTED with that list', () => {
    expect(mgDoc().call('writeEffects', { itemId: 'g', add: [{ effectId: 'grayscale' }] })).toMatchObject({ success: false, code: 'EFFECT_NOT_SUPPORTED',
      message: "'motionGraphic' doesn't support 'grayscale'. Supported: invert, gaussian-blur, drop-shadow." });
  });
  it('a stored WebGL instance on a graphic (an older or imported project) still renders on its frame', () => {
    const e = mgDoc(); fx(e, 'g', 'invert');
    (itemOf(e.doc, 'g').effects as any[]).push({ id: 'effect_8_yyyyyyyyy', effectId: 'grayscale', enabled: true, order: 8, parameters: {} });
    const d = drawOf(e, 'g', 100);
    expect(gpuIds(d)).toEqual(['grayscale']); expect(d.filter).toBe('invert(100%)'); expect(d.path).toBe('css');
  });
  it.each([
    ['bg-removal', 'T12', 'Background removal rendering'],
    // T22 (C8 assertion-only edit): the recolor row is gone. Recolour now renders from the item's element data (render/model.ts Draw.element); tests/t22-render.test.ts covers it.
    ['not-an-effect', '?', "Unknown effect 'not-an-effect'"],
  ])('an enabled stored %s entry on a graphic → pending %s "%s", not drawn', (effectId, owner, what) => {
    const e = mgDoc(); fx(e, 'g', 'invert');
    (itemOf(e.doc, 'g').effects as any[]).push({ id: 'effect_9_zzzzzzzzz', effectId, enabled: true, order: 9, parameters: {} });
    const plan = framePlan(e.doc, 100);
    expect(plan.draws).toEqual([]); expect(plan.pending).toEqual([{ itemId: 'g', owner, what }]);
  });
  it('a graphic without code stays an empty graphic with effects too (T08 rule: nothing drawn, nothing pending)', () => {
    const e = mgDoc(''); fx(e, 'g', 'invert');
    expect(framePlan(e.doc, 100)).toEqual({ draws: [], pending: [] });
  });
});

describe('T10 framePlan: values at the frame time (the property clock, trim axis)', () => {
  /** A sweep 0 → 100 over the clip, written through the agent tool in timeline seconds (stored on the trim axis). */
  const sweep = (e: Editor, id: string, from: number, to: number) => {
    fx(e, id, 'grayscale');
    expect(e.call('writeKeyframes', { itemId: id, effectId: 'grayscale_1', payload: { amount: { replace: [{ time: from, value: 0, easing: 'linear' }, { time: to, value: 100, easing: 'linear' }] } } })).toMatchObject({ success: true });
  };
  it('a keyframed parameter is evaluated at the frame time: 0, 25, 50, 100 over a clip that starts at 0', () => {
    const e = make(); sweep(e, 'v1', 0, 4);
    for (const [t, want] of [[0, 0], [1000, 25], [2000, 50], [3999, 99.975]] as const) expect(drawOf(e, 'v1', t).effects[0].params!.amount, `t ${t}`).toBeCloseTo(want, 3);
  });
  it('a clip that starts later and is trimmed (v2: display 4000–8000, trim from 1000) evaluates on the trim axis, not on the timeline', () => {
    const e = make(); sweep(e, 'v2', 4, 8);
    const k = (effectStack(itemOf(e.doc, 'v2'))[0].parameters.amount.keyframes as any[]).map(x => x.time);
    expect(k).toEqual([1000, 5000]); // stored property time = trim.from + local
    for (const [t, want] of [[4000, 0], [5000, 25], [6000, 50], [7999, 99.975]] as const) expect(drawOf(e, 'v2', t).effects[0].params!.amount, `t ${t}`).toBeCloseTo(want, 3);
  });
  it('a playback rate scales the property clock', () => {
    const e = make(); sweep(e, 'v2', 4, 8); (itemOf(e.doc, 'v2') as any).playbackRate = 2;
    // property time = 1000 + local × 2: at local 1000 ms it is 3000 → halfway through the 1000–5000 sweep
    expect(drawOf(e, 'v2', 5000).effects[0].params!.amount).toBeCloseTo(50, 3);
  });
  it('a static parameter is the stored value at every frame; a keyframed CSS length is evaluated too', () => {
    const e = make(); fx(e, 'v1', { effectId: 'gaussian-blur', initialParameters: { radius: 10 } });
    e.call('writeKeyframes', { itemId: 'v1', effectId: 'gaussian-blur_1', payload: { radius: { replace: [{ time: 0, value: 0, easing: 'linear' }, { time: 4, value: 40, easing: 'linear' }] } } });
    expect(drawOf(e, 'v1', 0).filter).toBe(''); // radius 0 adds no blur
    expect(drawOf(e, 'v1', 1000).filter).toBe('blur(10px)'); expect(drawOf(e, 'v1', 2000).filter).toBe('blur(20px)');
  });
  it('the same document at the same time gives the same plan (no hidden clock)', () => {
    const e = make(); sweep(e, 'v1', 0, 4);
    expect(JSON.stringify(draws(e, 1500).map(d => d.effects))).toBe(JSON.stringify(draws(e, 1500).map(d => d.effects)));
  });
});

describe('T10 framePlan: the CSS filter string (item blur, brightness, then the CSS effects in stack order)', () => {
  it('blur(item px) brightness(item %) then invert, gaussian-blur and drop-shadow in the order they were stacked', () => {
    const e = make(); const v = itemOf(e.doc, 'v1') as any;
    v.properties = { blur: prop(4), brightness: prop(1.5) };
    fx(e, 'v1', { effectId: 'invert', initialParameters: { amount: 50 } }, { effectId: 'gaussian-blur', initialParameters: { radius: 3 } },
      { effectId: 'drop-shadow', initialParameters: { x: 5, y: 6, blur: 7, color: '#ff0000' } });
    expect(drawOf(e, 'v1', 100).filter).toBe('blur(4px) brightness(150%) invert(50%) blur(3px) drop-shadow(5px 6px 7px rgba(255, 0, 0, 1))');
  });
  it('stack order wins over the registry order: drop-shadow, then invert, then gaussian-blur', () => {
    const e = make();
    fx(e, 'v1', { effectId: 'drop-shadow', initialParameters: { x: 1, y: 2, blur: 3, color: '#000000' } }, 'invert', { effectId: 'gaussian-blur', initialParameters: { radius: 2 } });
    expect(drawOf(e, 'v1', 100).filter).toBe('drop-shadow(1px 2px 3px rgba(0, 0, 0, 1)) invert(100%) blur(2px)');
    const ids = effectStack(itemOf(e.doc, 'v1')).map(x => x.id);
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: ids[2], to: 0 });
    expect(drawOf(e, 'v1', 100).filter).toBe('blur(2px) drop-shadow(1px 2px 3px rgba(0, 0, 0, 1)) invert(100%)');
  });
  it('WebGL effects between CSS effects do not appear in the string and do not change the CSS order', () => {
    const e = make(); fx(e, 'v1', 'invert', 'grayscale', { effectId: 'gaussian-blur', initialParameters: { radius: 1 } });
    const d = drawOf(e, 'v1', 100);
    expect(d.filter).toBe('invert(100%) blur(1px)'); expect(gpuIds(d)).toEqual(['grayscale']);
  });
  it('a CSS effect that adds nothing (invert 0 %, blur 0) leaves the filter empty and the path direct', () => {
    const e = make(); fx(e, 'v1', { effectId: 'invert', initialParameters: { amount: 0 } }, { effectId: 'gaussian-blur', initialParameters: { radius: 0 } });
    const d = drawOf(e, 'v1', 100); expect(d.filter).toBe(''); expect(d.path).toBe('direct');
  });
  it('drop-shadow is always added, even at 0 / 0 / 0, and keeps the colour alpha', () => {
    const e = make(); fx(e, 'v1', { effectId: 'drop-shadow', initialParameters: { x: 0, y: 0, blur: 0, color: '#00000080' } });
    expect(drawOf(e, 'v1', 100).filter).toMatch(/^drop-shadow\(0px 0px 0px rgba\(0, 0, 0, 0\.50196\d?\)\)$/);
  });
  it('a new drop-shadow keeps its registry default colour (rgba(0,0,0,0.5)) in the string', () => {
    const e = make(); fx(e, 'v1', 'drop-shadow');
    expect(drawOf(e, 'v1', 100).filter).toMatch(/^drop-shadow\(-?\d+(\.\d+)?px -?\d+(\.\d+)?px \d+(\.\d+)?px rgba\(0, 0, 0, 0\.5\)\)$/);
  });
});

describe('T10 framePlan: cssScale (preview quality, §53.9 row 20)', () => {
  const setup = () => {
    const e = make(); (itemOf(e.doc, 'v1') as any).properties = { blur: prop(4), brightness: prop(1.5) };
    fx(e, 'v1', { effectId: 'invert', initialParameters: { amount: 50 } }, { effectId: 'gaussian-blur', initialParameters: { radius: 3 } },
      { effectId: 'drop-shadow', initialParameters: { x: 5, y: 6, blur: 7, color: '#ff0000' } }, { effectId: 'grayscale', initialParameters: { amount: 70 } });
    return e;
  };
  it('scales the px lengths (item blur, gaussian-blur radius, drop-shadow x / y / blur) and nothing else', () => {
    const d = drawOf(setup(), 'v1', 100, { cssScale: 0.5 });
    expect(d.filter).toBe('blur(2px) brightness(150%) invert(50%) blur(1.5px) drop-shadow(2.5px 3px 3.5px rgba(255, 0, 0, 1))');
    expect(d.effects[0].params).toEqual({ amount: 70 }); // WebGL parameters are not lengths in CSS px
  });
  it('a quarter-size canvas', () => {
    expect(drawOf(setup(), 'v1', 100, { cssScale: 0.25 }).filter).toBe('blur(1px) brightness(150%) invert(50%) blur(0.75px) drop-shadow(1.25px 1.5px 1.75px rgba(255, 0, 0, 1))');
  });
  it('defaults to 1 (the export and the capture keep fixed output pixels)', () => {
    const e = setup();
    expect(drawOf(e, 'v1', 100).filter).toBe(drawOf(e, 'v1', 100, { cssScale: 1 }).filter);
    expect(framePlan(e.doc, 100, projectSize(e.doc), undefined, {}).draws[0].filter).toBe(drawOf(e, 'v1', 100).filter);
  });
});
