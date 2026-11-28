// SPDX-License-Identifier: AGPL-3.0-only
// T05 text: preset gallery, W3 fixtures 1-2 (stored animation), gradient colour, Transform alignment, Add text (W3-ED-22),
// text property checks, looks, font registry. Written against the acceptance list in "T05 text and text animations notes (C).md" §7 and
// findings §14 (wave 3) / part 3 §46; the implementation was read for names only. Tests marked "formula oracle" check the stored
// formulas (no raw pack frames are used anywhere).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDocument } from '../apps/web/src/store/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { CommandError } from '../apps/web/src/timeline/model';
import { valueAt } from '../apps/web/src/timeline/properties';
import { NO_PRESET, STROKE_SIZE, TEXT_PRESETS, presetProperties } from '../apps/web/src/text/presets';
import { ADD_TEXT, addTextPreset } from '../apps/web/src/text/tools';
import { alignedPosition } from '../apps/web/src/text/ui';
import { parseGradient, textFill } from '../apps/web/src/text/style';
import { checkTextProperty, fontNotFoundText } from '../apps/web/src/text/properties';
import { CLEARED_SHADOW, LOOK_EFFECTS, LOOK_STYLES, checkLook, lookFallbacks, lookPasses, readLook } from '../apps/web/src/text/looks';
import { FONT_REGISTRY, FontError, findFont, fontFamilies, pickVariant, resolveFont, weightNumber } from '../apps/web/src/text/font-registry';
import { PARITY } from '../apps/web/src/text/parity-switches';
import { build, itemOf, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeEach(() => { useIds(); });
afterEach(() => { resetIds(); PARITY.looks = 'catalogue'; PARITY.gradientText = 'render'; PARITY.weightFace = 'switch'; });
type Editor = ReturnType<typeof createEditor>;
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof CommandError) return e.code; throw e; } return 'NO ERROR'; };
const prop = (e: Editor, id: string, k: string) => valueAt(itemOf(e.doc, id), k, 0);
/** Project 1080 x 1920 with an overlay track O1 and one text item `txt` (Hello). */
const base = (): ProjectDocument => build({
  tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')],
  items: [mkItem('txt', 'O1', 0, 4000, { type: 'text', details: { text: 'Hello' } })],
});
const edit = (e: Editor, properties: Record<string, unknown>, id = 'txt') => e.intent({ type: 'editTextProperties', itemIds: [id], properties });
const anim = (e: Editor, id = 'txt') => itemOf(e.doc, id).details.textAnimation;

describe('preset gallery (acceptance (a))', () => {
  it('has the 14 tiles in gallery order and a separate None', () => {
    expect(TEXT_PRESETS).toHaveLength(14);
    expect(TEXT_PRESETS.map(p => p.name)).toEqual(['Dark box', 'Light box', 'Outline', 'Dark outline', 'Coral pill', 'Lemon pill', 'Teal pill', 'Soft shadow', 'Cyan glow', 'Pink neon', 'Comic', 'Retro drop', 'Ice outline', 'Mint on black']);
    expect(new Set(TEXT_PRESETS.map(p => p.name)).size).toBe(14);
    expect(NO_PRESET).toMatchObject({ name: 'None', color: '#ffffff', fill: 'transparent' });
    expect(NO_PRESET.stroke).toBeUndefined();
    expect(NO_PRESET.shadow).toBeUndefined();
  });

  it.each(TEXT_PRESETS.map(p => [p.name, p] as const))('"%s" writes exactly colour, fill, stroke colour+size and shadow', (_n, p) => {
    const w = presetProperties(p);
    expect(Object.keys(w).sort()).toEqual(['backgroundColor', 'borderColor', 'borderWidth', 'boxShadow', 'color']);
    expect(w.color).toBe(p.color);
    expect(w.backgroundColor).toBe(p.fill);
    expect(w.borderWidth).toBe(p.stroke ? STROKE_SIZE : 0);
    expect(w.borderColor).toBe(p.stroke ?? 'transparent');
    expect(w.boxShadow).toEqual(p.shadow ?? CLEARED_SHADOW);
  });

  it('a stroke tile uses stroke size 12; a tile without stroke writes width 0', () => {
    expect(STROKE_SIZE).toBe(12);
    expect(TEXT_PRESETS.filter(p => p.stroke).length).toBeGreaterThan(0);
    expect(TEXT_PRESETS.filter(p => !p.stroke).every(p => presetProperties(p).borderWidth === 0)).toBe(true);
  });

  it.each(TEXT_PRESETS.map((p, i) => [p.name, i] as const))('tile "%s": changes only the five style fields, is 1 "Edit items", and 1 Undo restores', (_n, i) => {
    const e = createEditor(base());
    // Give the item some distinguishing state first so that "unchanged" is a real check.
    edit(e, { fontSize: 77, textAlign: 'left' });
    e.bus.undoStack.length = 0;
    const before = structuredClone(itemOf(e.doc, 'txt'));
    const r = edit(e, presetProperties(TEXT_PRESETS[i]));
    expect(r).toMatchObject({ ok: true });
    expect(e.labels().filter(l => l === 'Edit items')).toHaveLength(1);
    expect(e.bus.undoStack).toHaveLength(1);
    const after = itemOf(e.doc, 'txt');
    const changed = Object.keys({ ...before.properties, ...after.properties }).filter(k => JSON.stringify(before.properties[k]) !== JSON.stringify(after.properties[k]));
    for (const k of changed) expect(['color', 'backgroundColor', 'borderColor', 'borderWidth', 'boxShadow']).toContain(k);
    expect(after.details).toEqual(before.details);                 // text, font, animation untouched
    expect(valueAt(after, 'fontSize', 0)).toBe(77);
    expect(valueAt(after, 'textAlign', 0)).toBe('left');
    expect(prop(e, 'txt', 'color')).toBe(TEXT_PRESETS[i].color);
    e.intent({ type: 'undo' });
    expect(itemOf(e.doc, 'txt')).toEqual(before);                   // one Undo restores the whole item
  });

  it('the Preset field keeps reading None (a tile is an action, nothing preset-named is stored)', () => {
    const e = createEditor(base());
    edit(e, presetProperties(TEXT_PRESETS[9]));
    const stored = JSON.stringify(itemOf(e.doc, 'txt'));
    expect(stored).not.toMatch(/Pink neon/i);
    expect(itemOf(e.doc, 'txt').details.preset).toBeUndefined();
    expect(itemOf(e.doc, 'txt').details.textPreset).toBeUndefined();
  });

  it('a tile after another tile looks the same as on a fresh item (all five fields rewritten)', () => {
    const a = createEditor(base()), b = createEditor(base());
    edit(a, presetProperties(TEXT_PRESETS[9]));   // Pink neon (stroke + shadow) first
    edit(a, presetProperties(TEXT_PRESETS[0]));   // then Dark box
    edit(b, presetProperties(TEXT_PRESETS[0]));
    for (const k of ['color', 'backgroundColor', 'borderColor', 'borderWidth', 'boxShadow']) expect(prop(a, 'txt', k)).toEqual(prop(b, 'txt', k));
  });

  it('None restores the inspector defaults after a tile', () => {
    const e = createEditor(base());
    edit(e, presetProperties(TEXT_PRESETS[10]));
    edit(e, presetProperties(NO_PRESET));
    expect(prop(e, 'txt', 'color')).toBe('#ffffff');
    expect(prop(e, 'txt', 'backgroundColor')).toBe('transparent');
    expect(prop(e, 'txt', 'borderWidth')).toBe(0);
    expect(prop(e, 'txt', 'boxShadow')).toEqual(CLEARED_SHADOW);
  });
});

describe('W3 fixtures 1-2: the stored animation config', () => {
  it('fixture 1: Pop stores {version 1, preset pop} (no speed) as 1 "Edit items"; Typewriter next stores typewriter', () => {
    const e = createEditor(base());
    expect(edit(e, { textAnimation: { version: 1, preset: 'pop' } })).toMatchObject({ ok: true });
    expect(anim(e)).toEqual({ version: 1, preset: 'pop' });
    expect('speed' in anim(e)).toBe(false);
    expect(e.labels()).toEqual(['Edit items']);
    edit(e, { textAnimation: { version: 1, preset: 'typewriter' } });
    expect(anim(e)).toEqual({ version: 1, preset: 'typewriter' });
    expect(e.labels()).toEqual(['Edit items', 'Edit items']);
  });

  it('fixture 1 (agent short form): {preset} alone stores the same config', () => {
    const e = createEditor(base());
    edit(e, { textAnimation: { preset: 'pop' } });
    expect(anim(e)).toEqual({ version: 1, preset: 'pop' });
  });

  it('fixture 2: speed 1 is stored as absent; 1.25, 1.5, 1.75 and 2 store the speed; None stores a none config', () => {
    const e = createEditor(base());
    edit(e, { textAnimation: { version: 1, preset: 'pop', speed: 1 } });
    expect('speed' in anim(e)).toBe(false);
    for (const s of [1.25, 1.5, 1.75, 2]) { edit(e, { textAnimation: { version: 1, preset: 'pop', speed: s } }); expect(anim(e)).toEqual({ version: 1, preset: 'pop', speed: s }); }
    edit(e, { textAnimation: { version: 1, preset: 'none' } });
    expect(anim(e).preset).toBe('none');
  });

  it('fixture 2: the four step commits of a 1x to 2x drag are four "Edit items" entries, the last storing speed 2 (the drag itself is in ui/t05-text.spec.ts)', () => {
    const e = createEditor(base());
    expect(e.bus.undoStack).toHaveLength(0);
    for (const s of [1.25, 1.5, 1.75, 2]) edit(e, { textAnimation: { version: 1, preset: 'pop', speed: s } });
    expect(e.labels()).toEqual(['Edit items', 'Edit items', 'Edit items', 'Edit items']);
    expect(anim(e).speed).toBe(2);
  });

  it('the same speed again is not a new undo entry content-wise (a no-op write keeps the config identical)', () => {
    const e = createEditor(base());
    edit(e, { textAnimation: { version: 1, preset: 'pop', speed: 2 } });
    const a = JSON.stringify(anim(e));
    edit(e, { textAnimation: { version: 1, preset: 'pop', speed: 2 } });
    expect(JSON.stringify(anim(e))).toBe(a);
  });
});

describe('gradient text colour (acceptance (b))', () => {
  it('parses the default linear gradient: 180 degrees, black 0 % to white 100 %', () => {
    expect(parseGradient('linear-gradient(180deg, #000000 0%, #ffffff 100%)')).toEqual({ kind: 'linear', angle: 180, stops: [{ color: '#000000', at: 0 }, { color: '#ffffff', at: 1 }] });
  });
  it('a linear gradient without an angle defaults to 180 degrees; "to right" is 90', () => {
    expect(parseGradient('linear-gradient(red, blue)')).toMatchObject({ kind: 'linear', angle: 180 });
    expect(parseGradient('linear-gradient(to right, red, blue)')).toMatchObject({ kind: 'linear', angle: 90 });
    expect(parseGradient('linear-gradient(red, blue)')!.stops.map(s => s.at)).toEqual([0, 1]);
  });
  it('parses a radial gradient with a centre and a stop added by a click (three stops)', () => {
    const g = parseGradient('radial-gradient(circle at 50% 50%, #000000 0%, #ff0000 40%, #ffffff 100%)');
    expect(g).toMatchObject({ kind: 'radial', cx: 50, cy: 50 });
    expect(g!.stops).toEqual([{ color: '#000000', at: 0 }, { color: '#ff0000', at: 0.4 }, { color: '#ffffff', at: 1 }]);
  });
  it('splits stops on top-level commas only (rgba() stays whole)', () => {
    expect(parseGradient('linear-gradient(90deg, rgba(0, 0, 0, 0.5) 0%, #fff 100%)')!.stops[0]).toEqual({ color: 'rgba(0, 0, 0, 0.5)', at: 0 });
  });
  it.each(['#ffffff', 'red', 'linear-gradient()', 'conic-gradient(red, blue)', 42, null, undefined])('%s is not a gradient', v => { expect(parseGradient(v)).toBeNull(); });

  it('a valid CSS gradient is accepted as the stored text colour; a malformed one is INVALID_PROPERTY_VALUE', () => {
    const e = createEditor(base());
    const g = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)';
    expect(edit(e, { color: g })).toMatchObject({ ok: true });
    expect(prop(e, 'txt', 'color')).toBe(g);
    expect(code(() => checkTextProperty({ type: 'text' }, 'color', 'linear-gradient(nonsense'))).toBe('INVALID_PROPERTY_VALUE');
  });

  const fakeCtx = () => {
    const calls: unknown[][] = [];
    const grad = () => ({ stops: [] as unknown[][], addColorStop(this: any, o: number, c: string) { this.stops.push([o, c]); } });
    return { calls, ctx: {
      createLinearGradient: (...a: number[]) => { calls.push(['linear', ...a]); return Object.assign(grad(), { kind: 'linear' }); },
      createRadialGradient: (...a: number[]) => { calls.push(['radial', ...a]); return Object.assign(grad(), { kind: 'radial' }); },
    } as any };
  };
  it('formula oracle: textFill for 180 degrees runs top to bottom across the box (CSS gradient line)', () => {
    const { calls, ctx } = fakeCtx();
    const f: any = textFill(ctx, 'linear-gradient(180deg, #000000 0%, #ffffff 100%)', 200, 100);
    expect(calls[0][0]).toBe('linear');
    const [, x0, y0, x1, y1] = calls[0] as number[];
    expect(x0).toBeCloseTo(100, 6); expect(x1).toBeCloseTo(100, 6);
    expect(y0).toBeCloseTo(0, 6); expect(y1).toBeCloseTo(100, 6);
    expect(f.stops).toEqual([[0, '#000000'], [1, '#ffffff']]);
  });
  it('formula oracle: 90 degrees runs left to right over the full width', () => {
    const { calls, ctx } = fakeCtx();
    textFill(ctx, 'linear-gradient(90deg, red, blue)', 200, 100);
    const [, x0, y0, x1, y1] = calls[0] as number[];
    expect([x0, y0, x1, y1].map(n => Math.round(n * 1e6) / 1e6)).toEqual([0, 50, 200, 50]);
  });
  it('formula oracle: a radial gradient is centred at its stated point and reaches the farthest corner', () => {
    const { calls, ctx } = fakeCtx();
    textFill(ctx, 'radial-gradient(circle at 50% 50%, red, blue)', 200, 100);
    const [kind, x0, y0, r0, x1, y1, r1] = calls[0] as number[];
    expect(kind).toBe('radial'); expect([x0, y0, r0, x1, y1]).toEqual([100, 50, 0, 100, 50]);
    expect(r1).toBeCloseTo(Math.hypot(100, 50), 6);
  });
  it('a plain colour is returned as is', () => { expect(textFill({} as any, '#123456', 10, 10)).toBe('#123456'); });
  it('gradientText "xapp" keeps the previous fill (textFill answers null)', () => {
    PARITY.gradientText = 'xapp';
    expect(textFill(fakeCtx().ctx, 'linear-gradient(red, blue)', 10, 10)).toBeNull();
  });
});

describe('Transform alignment (acceptance (d))', () => {
  const canvas = { width: 1080, height: 1920 }, box = { x: 100, y: 300, w: 674, h: 198 };
  it('1080 x 1920, box 674 x 198 at X 100 / Y 300: the four buttons give the stated positions', () => {
    expect(alignedPosition(canvas, box, 'x')).toEqual({ positionX: 203 });
    expect(alignedPosition(canvas, box, 'y')).toEqual({ positionY: 861 });
    expect(alignedPosition(canvas, box, 'top')).toEqual({ positionX: 203, positionY: 378 });
    expect(alignedPosition(canvas, box, 'bottom')).toEqual({ positionX: 203, positionY: 1344 });
  });
  it('rounds the centre to 2 decimals, "top" keeps the bottom edge at 30 % and never goes negative', () => {
    expect(alignedPosition({ width: 1081, height: 1921 }, { x: 0, y: 0, w: 100, h: 99 }, 'x')).toEqual({ positionX: 490.5 });
    expect(alignedPosition({ width: 1081, height: 1921 }, { x: 0, y: 0, w: 100, h: 99 }, 'y')).toEqual({ positionY: 911 });
    expect(alignedPosition({ width: 1000, height: 1000 }, { x: 0, y: 0, w: 10, h: 900 }, 'top').positionY).toBe(0);
    expect(alignedPosition({ width: 1000, height: 1000 }, { x: 0, y: 0, w: 10, h: 100 }, 'top').positionY).toBe(200);
    expect(alignedPosition({ width: 1000, height: 1000 }, { x: 0, y: 0, w: 10, h: 100 }, 'bottom').positionY).toBe(700);
  });
});

describe('Add text (acceptance (e), W3-ED-22)', () => {
  it('the preset item: Heading, Roboto Bold 150, #ffffff, centre, break-word, 5 s, stroke 0 black, centred on the canvas', () => {
    const e = createEditor(emptyDocument());
    expect(e.intent({ type: 'addTextPreset' })).toMatchObject({ ok: true });
    expect(e.labels()).toEqual(['Add items']);
    const t = e.doc.items[0];
    expect(t.type).toBe('text');
    expect(t.details).toMatchObject({ text: 'Heading', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' });
    expect(t.display).toEqual({ from: 0, to: 5000 });
    expect(ADD_TEXT).toMatchObject({ text: 'Heading', family: 'Roboto', weight: 700, fontSize: 150, color: '#ffffff', textAlign: 'center', wordWrap: 'break-word', durationMs: 5000 });
    const p = (k: string) => valueAt(t, k, 0);
    expect([p('fontSize'), p('fontWeight'), p('color'), p('textAlign'), p('wordWrap'), p('borderWidth'), p('borderColor')]).toEqual([150, 700, '#ffffff', 'center', 'break-word', 0, '#000000']);
    const size = ((e.doc as { size?: { width: number; height: number } }).size ?? { width: 1080, height: 1920 }), W = size.width, H = size.height;
    const w = p('width') as number, h = p('height') as number;
    expect(Math.abs((p('positionX') as number) + w / 2 - W / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((p('positionY') as number) + h / 2 - H / 2)).toBeLessThanOrEqual(1);
  });

  it('script: the first Add text creates track O1; with it occupied the second creates O2 on top, the third O3', () => {
    const e = createEditor(emptyDocument());
    for (let n = 0; n < 3; n++) e.intent({ type: 'addTextPreset' });
    const kinds = e.doc.tracks.map(t => [t.name, t.kind]);
    expect(kinds).toEqual([['O1', 'overlay'], ['O2', 'overlay'], ['O3', 'overlay']]);
    expect(e.doc.items.map(i => i.trackId)).toEqual(e.doc.tracks.map(t => t.id));
    expect(e.labels()).toEqual(['Add items', 'Add items', 'Add items']);
  });

  it('script: an emptied overlay track counts as empty and is reused (the lowest unlocked empty one)', () => {
    const e = createEditor(emptyDocument());
    e.intent({ type: 'addTextPreset' }); e.intent({ type: 'addTextPreset' });
    const [o1, o2] = e.doc.tracks.map(t => t.id);
    e.intent({ type: 'deleteItems', itemIds: [e.doc.items.find(i => i.trackId === o1)!.id] } as any);
    expect(e.doc.items.some(i => i.trackId === o1)).toBe(false);
    e.intent({ type: 'addTextPreset' });
    expect(e.doc.tracks).toHaveLength(2);
    expect(e.doc.items.filter(i => i.trackId === o1)).toHaveLength(1);
    expect(e.doc.items.filter(i => i.trackId === o2)).toHaveLength(1);
  });

  it('a locked overlay track is skipped: a new track is created instead', () => {
    const d = build({ tracks: [mkTrack('O1', 'overlay', { locked: true })], items: [] });
    const e = createEditor(d);
    e.intent({ type: 'addTextPreset' });
    expect(e.doc.tracks).toHaveLength(2);
    expect(e.doc.items[0].trackId).not.toBe('O1');
  });

  it('dragging text onto the timeline: the drop track when it is an overlay with room, at the drop time, in the preset style', () => {
    const e = createEditor(base());
    expect(e.intent({ type: 'drop', payload: { kind: 'text', text: 'Dropped' }, trackId: 'O1', timeMs: 6000 } as any)).toMatchObject({ ok: true });
    const t = e.doc.items.find(i => i.details.text === 'Dropped')!;
    expect(t.trackId).toBe('O1');
    expect(t.display).toEqual({ from: 6000, to: 11000 });
    expect(valueAt(t, 'fontSize', 0)).toBe(150);
    expect(e.labels()).toEqual(['Add items']);
  });

  it('dropping onto an occupied span falls back to the track rule at the drop time', () => {
    const e = createEditor(base());
    e.intent({ type: 'drop', payload: { kind: 'text', text: 'Late' }, trackId: 'O1', timeMs: 1000 } as any);
    const t = e.doc.items.find(i => i.details.text === 'Late')!;
    expect(t.trackId).not.toBe('O1');
    expect(t.display.from).toBe(1000);
    expect(e.doc.tracks.find(x => x.id === t.trackId)!.kind).toBe('overlay');
  });

  it('addTextPreset(doc, text) uses the given text in the preset style', () => {
    const d = structuredClone(emptyDocument());
    const id = addTextPreset(d, 'Hi there');
    expect(d.items.find(i => i.id === id)!.details.text).toBe('Hi there');
  });
});

describe('text property checks and writes', () => {
  const T = { type: 'text' };
  it.each([
    ['fontSize', 0], ['fontSize', -4], ['fontSize', 'big'], ['fontWeight', 'heavy'], ['fontWeight', 0], ['fontStyle', 'slanted'], ['textAlign', 'middle'],
    ['textTransform', 'shout'], ['wordWrap', 'wrap'], ['wordBreak', 'all'], ['color', 'not a colour!'], ['backgroundColor', 12], ['borderColor', '#12'],
    ['textDecoration', 'underline underline'], ['lineHeight', -1], ['letterSpacing', 'wide'], ['text', 5], ['fontFamily', 7], ['fontFamily', '  '], ['boxShadow', 'big'],
    ['boxShadow', { blur: Infinity }], ['boxShadow', { color: 'nope!' }],
  ])('%s = %j is INVALID_PROPERTY_VALUE', (k, v) => { expect(code(() => checkTextProperty(T, k, v))).toBe('INVALID_PROPERTY_VALUE'); });
  it.each([
    ['fontSize', 40], ['fontSize', '40px'], ['fontWeight', 'bold'], ['fontWeight', 700], ['fontStyle', 'italic'], ['textAlign', 'justify'], ['textTransform', 'capitalize'],
    ['wordWrap', 'anywhere'], ['wordBreak', 'keep-all'], ['color', '#fff'], ['color', 'rgba(0, 0, 0, .5)'], ['backgroundColor', 'transparent'], ['textDecoration', 'underline line-through'],
    ['textDecoration', 'none'], ['lineHeight', 'normal'], ['lineHeight', '120%'], ['letterSpacing', '0.05em'], ['letterSpacing', -2], ['wordSpacing', 'normal'], ['text', ''],
    ['boxShadow', { color: '#000', x: 1, y: 2, blur: 3 }], ['boxShadow', {}],
  ])('%s = %j is accepted', (k, v) => { expect(code(() => checkTextProperty(T, k, v))).toBe('NO ERROR'); });

  it('an unknown font is FONT_NOT_FOUND with the stored wording', () => {
    expect(code(() => checkTextProperty(T, 'fontFamily', 'Comic Sans Gold'))).toBe('FONT_NOT_FOUND');
    try { checkTextProperty(T, 'fontFamily', 'Comic Sans Gold'); } catch (e) { expect((e as CommandError).error).toBe("Font 'Comic Sans Gold' is unavailable. Choose a font from the fonts tool."); }
    expect(fontNotFoundText('X')).toBe("Font 'X' is unavailable. Choose a font from the fonts tool.");
  });

  it('through the editor: a bad value changes nothing and adds no undo entry', () => {
    const e = createEditor(base());
    const before = structuredClone(e.doc);
    const r: any = e.call('editProperties', { itemIds: ['txt'], properties: { fontSize: -3 } });
    expect(r.success).toBe(false);
    expect(r.code).toBe('INVALID_PROPERTY_VALUE');
    expect(e.doc).toEqual(before);
    expect(e.bus.undoStack).toHaveLength(0);
  });

  it('fontFamily writes the face, display family and url (PARITY.weightFace "switch")', () => {
    const e = createEditor(base());
    edit(e, { fontFamily: 'Anton' });
    expect(itemOf(e.doc, 'txt').details).toMatchObject({ fontFamily: 'Anton-Regular', fontFamilyDisplay: 'Anton' });
    expect(itemOf(e.doc, 'txt').details.fontUrl).toMatch(/family=Anton/);
  });
  it('"switch": a weight change picks the family face for that weight', () => {
    const e = createEditor(base());
    edit(e, { fontFamily: 'Roboto', fontWeight: 400 });
    edit(e, { fontWeight: 700 });
    expect(itemOf(e.doc, 'txt').details.fontFamily).toBe('Roboto-Bold');
    expect(prop(e, 'txt', 'fontWeight')).toBe(700);
  });
  it('"keep" (Xapp): a weight change writes only the weight property, the face stays', () => {
    PARITY.weightFace = 'keep';
    const e = createEditor(base());
    edit(e, { fontFamily: 'Roboto', fontWeight: 400 });
    const face = itemOf(e.doc, 'txt').details.fontFamily;
    edit(e, { fontWeight: 700 });
    expect(itemOf(e.doc, 'txt').details.fontFamily).toBe(face);
    expect(prop(e, 'txt', 'fontWeight')).toBe(700);
  });
  it('a face name alone (Roboto-Italic / Roboto-Bold) sets weight and style from that face', () => {
    const e = createEditor(base());
    edit(e, { fontFamily: 'Roboto-Italic' });
    expect(prop(e, 'txt', 'fontWeight')).toBe(400);
    expect(prop(e, 'txt', 'fontStyle')).toBe('italic');
    edit(e, { fontFamily: 'Roboto-Bold' });
    expect(prop(e, 'txt', 'fontWeight')).toBe(700);
    expect(prop(e, 'txt', 'fontStyle')).toBe('normal');
    expect(itemOf(e.doc, 'txt').details.fontFamily).toBe('Roboto-Bold');
  });
  it('text writes details.text; the same text is no change', () => {
    const e = createEditor(base());
    edit(e, { text: 'Hello' });
    edit(e, { text: 'World' });
    expect(itemOf(e.doc, 'txt').details.text).toBe('World');
  });
  it('boxShadow merges field by field over the stored shadow', () => {
    const e = createEditor(base());
    edit(e, { boxShadow: { color: '#ff0000', x: 3, y: 4, blur: 5 } });
    edit(e, { boxShadow: { blur: 9 } });
    expect(prop(e, 'txt', 'boxShadow')).toEqual({ color: '#ff0000', x: 3, y: 4, blur: 9 });
  });
});

describe('looks (part 2 §34)', () => {
  it('catalogue: 6 styles and 3 effects with the stated ids', () => {
    expect(LOOK_STYLES.map(s => s.id)).toEqual(['classic-outline', 'double-outline', 'neon', 'poster', 'soft-shadow', 'retro']);
    expect(LOOK_EFFECTS.map(s => s.id)).toEqual(['glow', 'drop', 'echo']);
  });
  it('null removes the look; style + effect + colour are stored with the outline fallback', () => {
    expect(checkLook(null, undefined)).toBeNull();
    const l = checkLook({ style: 'neon', effect: 'glow', color: '#FF00AA' }, undefined)!;
    expect(l).toMatchObject({ version: 1, color: '#ff00aa' });
    expect(l.style!.id).toBe('neon'); expect(l.effect!.id).toBe('glow');
    expect(l.outline).toEqual({ width: 0.015, color: '#ffffff' });
    expect(checkLook({ style: 'soft-shadow' }, undefined)!.outline).toBeNull();   // border width 0
  });
  it('an empty object over nothing is no look', () => { expect(checkLook({}, undefined)).toBeNull(); });
  it.each([
    [{ style: 'zigzag' }, 'UNKNOWN_TEXT_STYLE'], [{ effect: 'laser' }, 'UNKNOWN_TEXT_EFFECT'], [{ style: 'neon', color: 'red' }, 'INVALID_PROPERTY_VALUE'],
    [{ color: '#ff0000' }, 'INVALID_PROPERTY_VALUE'], ['neon', 'INVALID_PROPERTY_VALUE'], [[1], 'INVALID_PROPERTY_VALUE'], [{ style: 'neon', glow: 1 }, 'INVALID_PROPERTY_VALUE'],
  ])('%j is %s', (v, c) => { expect(code(() => checkLook(v, undefined))).toBe(c); });
  it('the unknown-style message lists the valid styles', () => {
    try { checkLook({ style: 'zigzag' }, undefined); } catch (e) { expect((e as CommandError).extra.message).toBe("Unknown text style 'zigzag'. Valid styles: classic-outline, double-outline, neon, poster, soft-shadow, retro."); }
  });
  it('keeps the current look for fields the call leaves out; a new style clears the recolour', () => {
    const cur = checkLook({ style: 'neon', color: '#00ffff' }, undefined);
    expect(checkLook({ effect: 'glow' }, cur)).toMatchObject({ color: '#00ffff' });
    expect(checkLook({ style: 'poster' }, cur)!.color).toBeNull();
    expect(checkLook({ effect: null }, checkLook({ effect: 'echo' }, undefined))).toBeNull();
  });
  it('PARITY.looks "unavailable": every look request is TEXT_LOOKS_UNAVAILABLE', () => {
    PARITY.looks = 'unavailable';
    expect(code(() => checkLook({ style: 'neon' }, undefined))).toBe('TEXT_LOOKS_UNAVAILABLE');
    expect(code(() => checkLook(null, undefined))).toBe('TEXT_LOOKS_UNAVAILABLE');
    const e = createEditor(base());
    const r: any = e.call('editProperties', { itemIds: ['txt'], properties: { look: { style: 'neon' } } });
    expect(r.success).toBe(false); expect(r.code).toBe('TEXT_LOOKS_UNAVAILABLE');
    expect(lookPasses({ version: 1, style: LOOK_STYLES[1], effect: null, color: null, outline: null }, 100, '#fff')).toEqual({ outlines: [], shadow: null, copies: [] });
  });
  it('a newly set style writes its plain fallbacks (explicit keys of the call win); an effect clears a visible box shadow', () => {
    const e = createEditor(base());
    edit(e, { boxShadow: { color: '#ff0000', x: 5, y: 5, blur: 5 }, fontSize: 100 });
    edit(e, { look: { style: 'poster', effect: 'drop' }, color: '#123456' });
    expect(prop(e, 'txt', 'color')).toBe('#123456');                    // explicit wins over the key colour
    expect(prop(e, 'txt', 'textTransform')).toBe('uppercase');
    expect(prop(e, 'txt', 'borderWidth')).toBe(7);                      // 0.07 x 100
    expect(prop(e, 'txt', 'borderColor')).toBe('#111111');
    expect(itemOf(e.doc, 'txt').details.fontFamilyDisplay).toBe('Anton');
    expect(prop(e, 'txt', 'boxShadow')).toEqual(CLEARED_SHADOW);
    expect(readLook(itemOf(e.doc, 'txt').details.look)!.effect!.id).toBe('drop');
  });
  it('formula oracle: lookFallbacks scale the border fraction by the font size', () => {
    const l = checkLook({ style: 'classic-outline' }, undefined)!;
    expect(lookFallbacks(l, 200).properties).toMatchObject({ borderWidth: 10, borderColor: '#000000', color: '#ffffff', textTransform: 'none' });
  });
  it('formula oracle: lookPasses at font size 100 (double outline ring, neon shadow in the key colour, echo copies)', () => {
    const dbl = checkLook({ style: 'double-outline' }, undefined)!;
    expect(lookPasses(dbl, 100, '#ffffff').outlines).toEqual([{ width: 2 * (5 + 16), color: '#000000' }]);
    const neon = checkLook({ style: 'neon', color: '#00ff00' }, undefined)!;
    expect(lookPasses(neon, 100, '#ffffff').shadow).toEqual({ color: '#00ff00', x: 0, y: 0, blur: 30 });
    const echo = checkLook({ effect: 'echo' }, undefined)!;
    expect(lookPasses(echo, 100, '#ffffff').copies).toEqual([{ dx: 8, dy: 8, alpha: 0.5 }, { dx: 16, dy: 16, alpha: 0.25 }]);
    expect(lookPasses(undefined, 100, '#fff')).toEqual({ outlines: [], shadow: null, copies: [] });
  });
  it('an effect shadow replaces the style shadow', () => {
    const l = checkLook({ style: 'poster', effect: 'glow' }, undefined)!;
    expect(lookPasses(l, 100, '#fff').shadow!.blur).toBeCloseTo(35, 6);
  });
});

describe('font registry', () => {
  it('has 87 bundled families; Roboto lists the faces as the Xapp picker shows them (findings §46.7): 700 300 500 900 400 and 400 italic', () => {
    expect(FONT_REGISTRY).toHaveLength(87);
    const roboto = findFont('Roboto')!.entry;
    expect(roboto.variants.map(v => `${v.weight}${v.italic ? 'i' : ''}`)).toEqual(['700', '300', '500', '900', '400', '400i']);
    expect(roboto.variants.map(v => v.face)).toEqual(['Roboto-Bold', 'Roboto-Light', 'Roboto-Medium', 'Roboto-Black', 'Roboto-Regular', 'Roboto-Italic']);
  });
  it('Xapp families without an open licence resolve to the substitute: Leckerli One / Lilita One names stay findable', () => {
    expect(findFont('Mister Firley')!.entry.family).toBe('Leckerli One');
    expect(findFont('Audio Nugget')!.entry.family).toBe('Lilita One');
  });
  it('findFont is case-insensitive, accepts a face name and returns its variant; unknown/empty is null', () => {
    expect(findFont('roboto')!.entry.family).toBe('Roboto');
    expect(findFont('Roboto-Bold')!.variant).toMatchObject({ weight: 700, italic: false });
    expect(findFont('No Such Family')).toBeNull();
    expect(findFont('   ')).toBeNull();
  });
  it('weightNumber maps bold/bolder to 700, numerals 1-1000 through, anything else to 400', () => {
    expect([weightNumber('bold'), weightNumber('bolder'), weightNumber(600), weightNumber('300'), weightNumber('nope'), weightNumber(0), weightNumber(1500)]).toEqual([700, 700, 600, 300, 400, 400, 400]);
  });
  it('pickVariant takes the nearest weight (heavier on a tie) and falls back to roman when a family has no italics', () => {
    const roboto = findFont('Roboto')!.entry;
    expect(pickVariant(roboto, 650, false).weight).toBe(700);
    expect(pickVariant(roboto, 700, true)).toMatchObject({ weight: 400, italic: true });   // Roboto has only a 400 italic
    const anton = findFont('Anton')!.entry;
    expect(pickVariant(anton, 700, true)).toMatchObject({ weight: 400, italic: false });
  });
  it('resolveFont builds a Google CSS url with the weight and italic axis', () => {
    expect(resolveFont('Roboto', 700, 'normal')!.url).toBe('https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,700&display=block');
    expect(resolveFont('Roboto', 'bold', 'italic')!.url).toContain('ital,wght@1,400');
    expect(resolveFont('Plus Jakarta Sans', 'bold', 'italic')!.url).toContain('ital,wght@1,700');
    expect(resolveFont('Nope')).toBeNull();
  });
  it('FontError carries a code from the closed set', () => {
    const e = new FontError('FONT_LOAD_FAILED', 'x');
    expect(e).toBeInstanceOf(Error); expect(e.code).toBe('FONT_LOAD_FAILED');
  });
  it('fontFamilies lists every bundled family once', () => {
    const names = fontFamilies().map(f => f.family);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('Roboto');
  });
});
