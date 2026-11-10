// SPDX-License-Identifier: AGPL-3.0-only
// Real T16a startExport/awaitExport -> MP4 -> ffmpeg decode. Geometry/state oracle: findings part 5 §57,
// parity/oracle/captions (independent formulas). Canvas supplies glyph coverage only; no product draw/composite is used
// for expected pixels. Fully transparent words have no observable x; their absence is asserted instead.
// D39 (Author, 9 Nov, set after the result was seen): word alpha ±0.01 is measured on the actual production pre-encode frame
// with the frozen D39 interval method (t09-alpha-capture, t09-alpha-measurement). Decoded brightness stays as the named
// legacy diagnostic; decoded x ±1 px, highlight colour, blank frames, stroke and decorations stay decoded gates.
import { appendFileSync } from 'node:fs';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { captionSettings, layoutCaption, wordState } from '../../parity/oracle/captions';
import { textChannels } from '../../parity/oracle/text';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { liveDoc } from './t03-support';
import { runtimeCall } from './t04-support';
import { completed, decodeRgba, mkDoc, runExport, setup, genMedia } from './t16a-support';
import { backgroundRows, captionBox, captureExport, FONT_SHA256, geometry, installPipelineOverlay, offsetsFor, sealReference, supportHash, visibleCaptions, WIRING_RED, type Box, type Captured, type Draw } from './t09-alpha-capture';
import { assertD39, evidence, measure, selectChannel, xPredicate, type Rgb } from './t09-alpha-measurement';

test.skip(!ffmpegAvailable(), 'ffmpeg is required to decode the real export');
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 404, body: 'offline' }));
});
const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const track = (id: string, kind: string) => ({ id, name: id.toUpperCase(), kind, locked: false, hidden: false, muted: false, solo: false, volume: 1 });
const SIZE = { width: 640, height: 360 }, FPS = 30;
const MODES = ['default', 'highlight', 'word-by-word', 'slide-up', 'slide-left'];
const words = [['hello', 300, 700], ['brave', 835, 1200], ['world', 1400, 1800]].map(([text, startMs, endMs]) => ({ text, startMs, endMs, sourceStartMs: startMs, sourceEndMs: endMs }));
function captionDoc(mode: string) {
  const tracks = [track('c1', 'caption')];
  return { ...mkDoc([], { duration: 2200, size: SIZE }), tracks, layerOrder: [{ type: 'track', id: 'c1' }], items: [{
    id: 'cap', type: 'caption', trackId: 'c1', display: { from: 100, to: 2200 }, trim: { from: 0, to: 2100 }, playbackRate: 1,
    masks: [], effects: [], metadata: { captionMode: 'detached' },
    details: { text: 'hello brave world', words, fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto', renderMode: mode, renderConfig: {} },
    properties: { fontSize: p(60), fontWeight: p('700'), color: p('#FFFFFF'), backgroundColor: p('transparent'), borderWidth: p(0),
      textAlign: p('center'), opacity: p(1), scale: p(1), rotation: p(0), positionX: p(20), positionY: p(120), width: p(600), height: p(120) },
  }] };
}
const value = (i: any, key: string) => i.properties[key]?.defaultValue;
const median = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
type Placement = { text: string; alpha: number; color: string | null; paint: string; channel: 0 | 1 | 2; font: string; F: number; cx: number; cy: number; width: number; scale: number };
/** core: native alpha>250 offsets; M: their transparent native alpha; P: the D39 coverage reference (same white glyph, opacity 1,
 *  opaque black, export canvas settings) in the measured channel; any: alpha>0 ink box; reference: its context and faces. */
type Mask = Placement & Box & { core: number[]; any: Box; M: number[]; P: number[]; reference: { context: unknown; faces: unknown } };
const rgb = (c: string): Rgb => (/^#[0-9a-f]{6}$/i.test(c) ? [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) as unknown as Rgb : [NaN, NaN, NaN]);

/** Independent §57 placements, then native glyph masks at those positions. Return core-pixel indices and ink bounds,
 * not a production preview. Mask threshold 1/2 defines the same observable edge on expected and decoded pixels. */
async function masks(page: Page, doc: any, t: number): Promise<Mask[]> {
  const captions = doc.items.filter((i: any) => i.type === 'caption' && t >= i.display.from && t < i.display.to);
  const metrics = await page.evaluate(async ({ captions, doc }) => {
    const fp = '/src/captions/fonts.ts'; await (await import(fp)).loadCaptionFonts(doc);
    return captions.map((i: any) => {
      const F = i.properties.fontSize.defaultValue, weight = i.properties.fontWeight.defaultValue;
      const font = `normal ${weight} ${F}px 'Roboto', sans-serif`, ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
      ctx.font = font; ctx.textBaseline = 'top';
      return { font, widths: Object.fromEntries(i.details.words.map((w: any) => [w.text, ctx.measureText(w.text).width])) };
    });
  }, { captions, doc });
  const placed: Placement[] = captions.flatMap((i: any, n: number) => {
    const mode = i.details.renderMode ?? 'default', cfg = captionSettings(mode, i.details.renderConfig), tau = t - i.display.from + (i.trim?.from ?? 0);
    const states = i.details.words.map((w: any) => wordState(mode, w, tau, cfg, value(i, 'opacity') ?? 1));
    const F = value(i, 'fontSize'), X = value(i, 'positionX'), Y = value(i, 'positionY');
    return layoutCaption(i.details.words.map((w: any) => w.text), s => metrics[n].widths[s], { fontSize: F, width: value(i, 'width'), height: value(i, 'height'), align: value(i, 'textAlign') }, states.map((s: any) => s.scale))
      .flat().map(w => {
        const paint = states[w.word].color ?? value(i, 'color');
        return { text: w.text, alpha: states[w.word].opacity, color: states[w.word].color, paint, channel: selectChannel(rgb(paint), [0, 0, 0]), font: metrics[n].font, F,
          cx: X + w.centreX + states[w.word].dx, cy: Y + w.centreY + states[w.word].dy, width: w.width, scale: w.scale };
      });
  });
  return page.evaluate(({ placed, size }) => {
    const faces = Array.from(document.fonts).filter(f => f.family.replace(/["']/g, '') === 'Roboto' && f.weight === '700')
      .map(f => ({ family: f.family.replace(/["']/g, ''), weight: f.weight, style: f.style, status: f.status })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    return placed.map(w => {
      const ctx = new OffscreenCanvas(size.width, size.height).getContext('2d')!;
      ctx.font = w.font; ctx.textBaseline = 'top'; ctx.fillStyle = '#FFFFFF';
      ctx.translate(w.cx, w.cy); ctx.scale(w.scale, w.scale); ctx.fillText(w.text, -w.width / 2, -w.F / 2);
      const a = ctx.getImageData(0, 0, size.width, size.height).data;
      // D39 coverage reference P: the same glyph and transform, white at opacity 1 on opaque black, export canvas settings.
      const ref = new OffscreenCanvas(size.width, size.height).getContext('2d', { willReadFrequently: true })!;
      ref.fillStyle = '#000000'; ref.fillRect(0, 0, size.width, size.height);
      ref.font = w.font; ref.textBaseline = 'top'; ref.fillStyle = '#FFFFFF';
      ref.translate(w.cx, w.cy); ref.scale(w.scale, w.scale); ref.fillText(w.text, -w.width / 2, -w.F / 2);
      const b = ref.getImageData(0, 0, size.width, size.height).data;
      const core: number[] = [], any = { x0: size.width, x1: -1, y0: size.height, y1: -1 }; let x0 = size.width, x1 = -1, y0 = size.height, y1 = -1;
      for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        const at = (y * size.width + x) * 4;
        if (a[at + 3] > 250) core.push(at);
        if (a[at + 3] > 127) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        if (a[at + 3] > 0) { any.x0 = Math.min(any.x0, x); any.x1 = Math.max(any.x1, x); any.y0 = Math.min(any.y0, y); any.y1 = Math.max(any.y1, y); }
      }
      return { ...w, core, x0, x1, y0, y1, any, M: core.map(at => a[at + 3]), P: core.map(at => b[at + w.channel]),
        reference: { context: (ref as any).getContextAttributes ? { ...(ref as any).getContextAttributes() } : null, faces } };
    });
  }, { placed, size: doc.size });
}
type Ref = Mask & { factors: Record<string, number>; supportSha256: string };
/** Seals the independent references of every probe before the export (D39 §3): support, M, P, placement and expected factors.
 *  `support` fixes the ink support time where a test keeps one (Fade); `factors` are the named a_expected factors. */
async function seal(page: Page, info: TestInfo, label: string, doc: any, probes: { n: number; t: number; support?: number }[], factors = (w: Mask, _t: number): Record<string, number> => ({ visible: 1, wordState: w.alpha })) {
  const refs = new Map<number, Ref[]>();
  for (const pr of probes) refs.set(pr.n, (await masks(page, doc, pr.support ?? pr.t)).map(w => {
    const f = factors(w, pr.t);
    return { ...w, factors: f, supportSha256: supportHash(w.core.map((at, j) => ({ at, M: w.M[j], P: w.P[j] })), f) };
  }));
  sealReference(info, label, { label, probes, refs: [...refs].map(([n, words]) => ({ n, words })) });
  return refs;
}
/** The J source of one measurement: an actual captured export frame, or (Fade only, supplemental) a preview composite. */
type Source = { kind: 'export' | 'preview'; rgba: Uint8Array; t: number; width: number; height: number; colorSpace: string; faces: unknown; context: unknown; fontSha256: string; draws: Draw[]; doc: any };
type Actual = { info: TestInfo; label: string; n: number; source: Source; black: string[]; omit?: string[] };
const fromCapture = (c: Captured, n: number): Source => {
  const f = c.captures.get(n)!;
  return { kind: 'export', rgba: f.rgba, t: f.t, width: f.width, height: f.height, colorSpace: f.colorSpace, faces: f.faces, context: c.meta.context, fontSha256: c.meta.fontSha256, draws: f.draws, doc: c.meta.doc };
};
const legacy = (frame: ArrayLike<number>, core: number[]) => median(core.map(i => Math.max(frame[i], frame[i + 1], frame[i + 2]))) / 255;
/** Item-level caption alpha: opacity × the whole-caption entrance o. A caption at alpha 0 has no draw (D40 1A). */
const itemAlpha = (i: any, t: number) => (value(i, 'opacity') ?? 1) * (i.details.textAnimation ? textChannels(i.details.textAnimation, t - i.display.from).opacity : 1);
/** D39 method on one word: actual J at the sealed support, against the sealed references and expected factors. */
function measureWord(doc: any, expected: Ref[], w: Ref, t: number, a: Actual, extra: Record<string, unknown> = {}) {
  const s = a.source, size = doc.size, rows = offsetsFor(w.core).map((at, i) => ({ at, J: s.rgba[at + w.channel], P: w.P[i], M: w.M[i] }));
  const boxes = [...visibleCaptions(doc, t).map(captionBox), ...expected.map(e => e.any)];
  const m = measure({ label: `${a.label} ${s.kind} frame ${a.n} ${w.text}`, expected: w.factors, foreground: rgb(w.paint), background: [0, 0, 0], minCount: 50, rows, backgroundRows: backgroundRows(s.rgba, size, boxes),
    identity: {
      reference: { face: w.reference.faces, fontSha256: FONT_SHA256, context: w.reference.context, colorSpace: 'srgb', size: `${size.width}x${size.height}`, geometry: geometry(doc, t, a.omit),
        captionDraws: visibleCaptions(doc, t).filter((i: any) => itemAlpha(i, t) > 0).map((i: any) => i.id).sort(), otherPaint: [], support: w.supportSha256 },
      actual: { face: s.faces, fontSha256: s.fontSha256, context: s.context, colorSpace: s.colorSpace, size: `${s.width}x${s.height}`, geometry: geometry(s.doc, s.t, a.omit),
        captionDraws: s.draws.filter(d => d.kind === 'caption').map(d => d.itemId).sort(), otherPaint: s.draws.filter(d => d.kind !== 'caption' && !a.black.includes(d.type)).map(d => d.itemId), support: supportHash(rows, w.factors) },
    } });
  appendFileSync(a.info.outputPath(`${a.label}-d39-measurements.jsonl`), `${JSON.stringify({ ...evidence(m), source: s.kind, t, sourceT: s.t, ...extra })}\n`);
  return m;
}
/** Decoded ink edges at the 1/2 mask threshold inside the expected box (unchanged detector). */
function edges(frame: ArrayLike<number>, w: Mask, size: { width: number; height: number }) {
  let x0 = size.width, x1 = -1;
  for (let y = Math.max(0, w.y0 - 3); y <= Math.min(size.height - 1, w.y1 + 3); y++)
    for (let x = Math.max(0, w.x0 - 4); x <= Math.min(size.width - 1, w.x1 + 4); x++) {
      const i = (y * size.width + x) * 4;
      if (Math.max(frame[i], frame[i + 1], frame[i + 2]) > w.alpha * 127.5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    }
  return x1 < 0 ? undefined : { x0, x1 };
}
/** Decoded gates on the decoded frame (blank interval, x ±1 px, absence of a transparent word, highlight colour) and the D39
 *  method on the actual pre-encode frame of the same global index. Decoded brightness of visible words is the legacy diagnostic. */
function assertFrame(doc: any, expected: Ref[], frame: Uint8Array, t: number, actual: Actual) {
  if (!expected.length) {
    // All source fixtures in these tests are black. No caption may span a cut/moved-source gap.
    let peak = 0; for (let i = 0; i < frame.length; i += 4) peak = Math.max(peak, frame[i], frame[i + 1], frame[i + 2]);
    expect(peak, `blank frame @${t}`).toBeLessThanOrEqual(3); return;
  }
  for (const w of expected) {
    expect(w.core.length, `${w.text}: a measurable glyph core`).toBeGreaterThan(50);
    const decoded = legacy(frame, w.core);
    assertD39(measureWord(doc, expected, w, t, actual, { legacyDecodedBrightness: { alpha: decoded, oracle: w.alpha, error: Math.abs(decoded - w.alpha) } }));
    // A fully transparent word has no observable x: its absence stays the decoded gate (core median ≤ 0.01).
    if (w.alpha === 0) { expect(decoded, `${w.text} @${t}: decoded absence`).toBeLessThanOrEqual(0.01); continue; }
    const x = xPredicate(edges(frame, w, doc.size), w);
    expect(x.status, `${w.text} @${t}: decoded x ${JSON.stringify(x)}`).toBe('pass');
    if (w.color) {
      expect(median(w.core.map(i => frame[i])), 'highlight red').toBeGreaterThan(235);
      expect(median(w.core.map(i => frame[i + 1])), 'highlight green').toBeGreaterThan(195);
      expect(median(w.core.map(i => frame[i + 2])), 'highlight blue').toBeLessThan(20);
    }
  }
}
async function saved(page: Page, id: string) {
  await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 15000 });
  const doc = await liveDoc(page);
  await expect.poll(() => page.evaluate(async ({ id, want }) => { const sp = '/src/store/database.ts'; const d = (await (await import(sp)).projectStore.read(id)).document; return JSON.stringify(d.items) === want; }, { id, want: JSON.stringify(doc.items) })).toBe(true);
  return doc;
}

for (const mode of MODES) test(`${mode === 'highlight' ? 'CT-11 / ' : ''}§57 decoded export: ${mode}, N-1/N/N+1 at every word start/end (D39 pre-encode alpha ±0.01, decoded x ±1 px)`, async ({ page }, info) => {
  const overlay = await installPipelineOverlay(page, info);
  const doc = captionDoc(mode), { id } = await setup(page, doc, {});
  const ns = [...new Set(words.flatMap(w => [Number(w.startMs), Number(w.endMs)].flatMap(ms => { const n = Math.ceil((ms + 100) * FPS / 1000); return [n - 1, n, n + 1]; })))].sort((a, b) => a - b);
  const refs = await seal(page, info, mode, doc, ns.map(n => ({ n, t: n * 1000 / FPS })));
  const cap = await captureExport(page, info, overlay, id, { bitrate: 20_000_000, range: { startS: 0, endS: 2.2 } }, ns, mode);
  expect(cap.run.result!.stats.path).toBe('encode');
  const frames = decodeRgba(cap.run.file!, SIZE.width, SIZE.height);
  for (const n of ns) assertFrame(doc, refs.get(n)!, frames[n], n * 1000 / FPS, { info, label: mode, n, source: fromCapture(cap, n), black: [] });
  if (mode === 'default') {
    // Old decoded self-checks, kept with their D39 roles: diagnostic sensitivity of the legacy brightness reading (not proof of
    // a changed word coefficient), and the decoded x detector on a 3 px translated image.
    const n = 30, t = n * 1000 / FPS, expected = refs.get(n)!, dark = Uint8Array.from(frames[n], (v, i) => i % 4 === 3 ? v : Math.round(v * 0.95));
    expect(expected.some(w => Math.abs(legacy(dark, w.core) - w.alpha) > 0.01), 'legacy diagnostic self-check: decoded RGB×0.95 is visible to the legacy brightness reading').toBe(true);
    const shifted = new Uint8Array(frames[n].length);
    for (let y = 0; y < SIZE.height; y++) shifted.set(frames[n].subarray(y * SIZE.width * 4, (y * SIZE.width + SIZE.width - 3) * 4), (y * SIZE.width + 3) * 4);
    expect(() => assertFrame(doc, expected, shifted, t, { info, label: `${mode}-self-check-shift`, n, source: fromCapture(cap, n), black: [] }), 'decoded self-check: 3 px translated image').toThrow(/X_PREDICATE_RED/);
  }
});

/** A separate control project (D39 §6): the frozen default fixture with one whitelisted semantic change through the normal edit
 *  path, opacity by the agent editProperties tool and positionX by the inspector's editCaptionTransform intent. Asserts the
 *  whitelist and persisted/live agreement before any export. */
async function controlProject(page: Page, key: 'opacity' | 'positionX', v: number) {
  const { id } = await setup(page, captionDoc('default'), {}), before = await liveDoc(page);
  const ok = key === 'opacity' ? (await runtimeCall(page, 'editProperties', { itemId: 'cap', properties: { opacity: v } })).success
    : await page.evaluate(async v => { const rp = '/src/timeline/runtime.ts'; return !!(await import(rp)).activeRuntime.handle({ type: 'editCaptionTransform', itemIds: ['cap'], properties: { positionX: v } })?.ok; }, v);
  expect(ok, `control edit ${key} = ${v}`).toBe(true);
  const after = await saved(page, id), strip = (d: any) => JSON.stringify(d.items.map((i: any) => ({ ...i, properties: { ...i.properties, [key]: null } })));
  expect(strip(after), `control whitelist: only ${key} changes`).toBe(strip(before));
  expect(value(after.items[0], key), `control ${key}`).toBe(v);
  return id;
}
const CONTROL = { n: 30, t: 1000, range: { startS: 1, endS: 1.034 } };

test('D39 actual 0.05 coefficient control: item opacity 0.95 fails the alpha predicate against the frozen opacity-1 fixture', async ({ page }, info) => {
  const overlay = await installPipelineOverlay(page, info), frozen = captionDoc('default'), { n, t, range } = CONTROL;
  // Wiring red 'undetected-control' exports the unchanged positive fixture in place of the control.
  const id = WIRING_RED === 'undetected-control' ? (await setup(page, frozen, {})).id : await controlProject(page, 'opacity', 0.95);
  const expected = (await seal(page, info, 'control-opacity', frozen, [{ n, t }])).get(n)!, visible = expected.filter(w => w.alpha > 0);
  expect(visible.length, 'control frame has visible words').toBeGreaterThan(0);
  const cap = await captureExport(page, info, overlay, id, { bitrate: 20_000_000, range }, [n], 'control-opacity');
  for (const w of visible) {
    const m = measureWord(frozen, expected, w, t, { info, label: 'control-opacity', n, source: fromCapture(cap, n), black: [], omit: ['opacity'] });
    expect(m.status, `actual 0.05 coefficient control ${m.label}: ${m.reasons.join('; ') || `error ${evidence(m).decimals?.error}`}`).toBe('D39_ALPHA_PREDICATE_RED');
  }
});

test('D39 actual 3 px motion control: positionX +3 fails the decoded ±1 px x predicate against the frozen placement', async ({ page }) => {
  const frozen = captionDoc('default'), { t, range } = CONTROL;
  const id = await controlProject(page, 'positionX', value(frozen.items[0], 'positionX') + 3);
  const visible = (await masks(page, frozen, t)).filter(w => w.alpha > 0);
  expect(visible.length, 'control frame has visible words').toBeGreaterThan(0);
  const run = await runExport(page, id, { bitrate: 20_000_000, range }); completed(run);
  const frame = decodeRgba(run.file!, SIZE.width, SIZE.height)[0];
  for (const w of visible) {
    const x = xPredicate(edges(frame, w, SIZE), w);
    expect(x, `actual 3 px motion control ${w.text}: ink found and displaced`).toMatchObject({ status: 'X_PREDICATE_RED', dx0: expect.any(Number), dx1: expect.any(Number) });
  }
});

test('caption export fails with FONT_* when its item face cannot load; no silent fallback', async ({ page }) => {
  const doc = captionDoc('default'); doc.items[0].details.fontFamily = 'OpenSans-Regular'; doc.items[0].details.fontFamilyDisplay = 'Open Sans';
  const { id } = await setup(page, doc, {}), run = await runExport(page, id);
  expect(run.status).toBe('failed'); expect(run.error?.code).toMatch(/^FONT_/);
});

/** Supplemental Fade source (D39 §7): the production composite of one preview frame, never a substitute for export capture. */
async function previewSource(page: Page, doc: any, t: number): Promise<Source> {
  const r = await page.evaluate(async ({ doc, t }) => {
    const mp = '/src/render/model.ts', cp = '/src/render/compositor.ts', fp = '/src/mg/fonts.ts';
    const face = (await import(fp)).SANDBOX_FONTS.find((f: any) => f.family === 'Roboto' && f.weight === 700);
    const bytes = Uint8Array.from(atob(String(face?.src ?? '').split(',')[1] ?? ''), (v: string) => v.charCodeAt(0));
    const fontSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
    const plan = (await import(mp)).framePlan(doc, t, doc.size), ctx = new OffscreenCanvas(doc.size.width, doc.size.height).getContext('2d', { willReadFrequently: true })!;
    (await import(cp)).composite(ctx, plan.draws, plan.draws.map(() => null), doc.size, 'black');
    const image = ctx.getImageData(0, 0, doc.size.width, doc.size.height);
    const faces = Array.from(document.fonts).filter(f => f.family.replace(/["']/g, '') === 'Roboto' && f.weight === '700')
      .map(f => ({ family: f.family.replace(/["']/g, ''), weight: f.weight, style: f.style, status: f.status })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    return { rgba: Array.from(image.data), width: image.width, height: image.height, colorSpace: image.colorSpace, context: { ...(ctx as any).getContextAttributes() }, fontSha256, faces,
      draws: plan.draws.map((d: any) => ({ itemId: d.item.id, type: d.item.type, kind: d.kind, alpha: d.alpha, blend: d.blend, filter: d.filter, path: d.path })) };
  }, { doc, t });
  return { kind: 'preview', ...r, rgba: Uint8Array.from(r.rgba), t, doc };
}

test('M7 real caption Fade matches independent opacity in actual export frames (D39) and the supplemental preview', async ({ page }, info) => {
  const overlay = await installPipelineOverlay(page, info);
  const doc = captionDoc('default'); Object.assign(doc.items[0].details, { textAnimation: { version: 1, preset: 'fade' } });
  const { id } = await setup(page, doc, {}), ns = [3, 6, 9, 15], fade = (t: number) => textChannels({ version: 1, preset: 'fade' }, t - 100).opacity;
  // Ink support at 500 ms as before; a_expected = 1_visible · wordState · o_whole(Fade at the frame time).
  const refs = await seal(page, info, 'fade', doc, ns.map(n => ({ n, t: n * 1000 / FPS, support: 500 })), (w, t) => ({ visible: 1, wordState: w.alpha, whole: fade(t) }));
  const cap = await captureExport(page, info, overlay, id, { bitrate: 20_000_000, range: { startS: 0, endS: .8 } }, ns, 'fade');
  const frames = decodeRgba(cap.run.file!, SIZE.width, SIZE.height);
  for (const n of ns) {
    const t = n * 1000 / FPS, expected = refs.get(n)!, preview = await previewSource(page, doc, t);
    for (const w of expected) {
      const decoded = legacy(frames[n], w.core), legacyDecodedBrightness = { alpha: decoded, oracle: fade(t), error: Math.abs(decoded - fade(t)) };
      assertD39(measureWord(doc, expected, w, t, { info, label: 'fade', n, source: fromCapture(cap, n), black: [] }, { legacyDecodedBrightness }));
      assertD39(measureWord(doc, expected, w, t, { info, label: 'fade', n, source: preview, black: [] }));
    }
  }
});

test('M8 CAP-P14 each decoration adds its independently located line in preview and decoded export', async ({ page }) => {
  const doc = captionDoc('default'); doc.items[0].details.text = 'hello'; doc.items[0].details.words = [words[0]];
  Object.assign(doc.items[0].properties, { textDecoration: p('none') });
  const { id } = await setup(page, doc, {});
  const plain = await page.evaluate(async doc => {
    const fp = '/src/captions/fonts.ts', mp = '/src/render/model.ts', cp = '/src/render/compositor.ts';
    await (await import(fp)).loadCaptionFonts(doc);
    const plan = (await import(mp)).framePlan(doc, 500, doc.size), ctx = new OffscreenCanvas(doc.size.width, doc.size.height).getContext('2d')!;
    (await import(cp)).composite(ctx, plan.draws, plan.draws.map(() => null), doc.size, 'black');
    return Array.from(ctx.getImageData(0, 0, doc.size.width, doc.size.height).data);
  }, doc);
  const [mask] = await masks(page, doc, 500);
  for (const [kind, dy] of [['underline', .92], ['line-through', .5], ['overline', 0]] as const) {
    expect((await runtimeCall(page, 'editAllCaptionStyles', { trackId: 'c1', textDecoration: kind })).success).toBe(true);
    const styled = await saved(page, id);
    const preview: number[] = await page.evaluate(async doc => {
      const mp = '/src/render/model.ts', cp = '/src/render/compositor.ts';
      const plan = (await import(mp)).framePlan(doc, 500, doc.size), ctx = new OffscreenCanvas(doc.size.width, doc.size.height).getContext('2d')!;
      (await import(cp)).composite(ctx, plan.draws, plan.draws.map(() => null), doc.size, 'black');
      return Array.from(ctx.getImageData(0, 0, doc.size.width, doc.size.height).data);
    }, styled);
    expect(preview.filter((v, n) => v !== plain[n]).length, `${kind} must affect preview pixels`).toBeGreaterThan(0);
    // Independent T05 decoration geometry: top + {0,.5,.92}F; thickness F/16. Test its interior, away from antialiasing.
    const y = Math.floor(mask.cy - mask.F / 2 + dy * mask.F + mask.F / 32), xs = Array.from({ length: Math.floor(mask.width) - 4 }, (_, n) => Math.ceil(mask.cx - mask.width / 2) + 2 + n);
    expect(median(xs.map(x => preview[(y * SIZE.width + x) * 4])) / 255).toBeGreaterThanOrEqual(.99);
    const run = await runExport(page, id, { bitrate: 20_000_000, range: { startS: .5, endS: .534 } }); completed(run);
    const frame = decodeRgba(run.file!, SIZE.width, SIZE.height)[0];
    expect(median(xs.map(x => frame[(y * SIZE.width + x) * 4])) / 255).toBeGreaterThanOrEqual(.99);
  }
});

test('M8 CAP-P14 parity mode suppresses decoration storage, preview and decoded output', async ({ page }) => {
  const doc = captionDoc('default'), { id } = await setup(page, doc, {});
  const render = () => page.evaluate(async () => {
    const rp = '/src/timeline/runtime.ts', mp = '/src/render/model.ts', cp = '/src/render/compositor.ts', fp = '/src/captions/fonts.ts';
    const doc = (await import(rp)).activeRuntime.bus.doc; await (await import(fp)).loadCaptionFonts(doc);
    const plan = (await import(mp)).framePlan(doc, 500, doc.size), ctx = new OffscreenCanvas(doc.size.width, doc.size.height).getContext('2d')!;
    (await import(cp)).composite(ctx, plan.draws, plan.draws.map(() => null), doc.size, 'black'); return Array.from(ctx.getImageData(0, 0, doc.size.width, doc.size.height).data);
  });
  const plain = await render(), normal = await runExport(page, id, { bitrate: 20_000_000, range: { startS: .5, endS: .534 } }); completed(normal);
  await page.evaluate(async () => { const p = '/src/captions/parity-switches.ts'; (await import(p)).CAPTION_PARITY.decorations = 'xapp'; });
  try {
    expect((await runtimeCall(page, 'editAllCaptionStyles', { trackId: 'c1', textDecoration: 'underline line-through overline' })).success).toBe(true);
    expect((await liveDoc(page)).items[0].properties).not.toHaveProperty('textDecoration');
    expect(await render()).toEqual(plain);
    const parity = await runExport(page, id, { bitrate: 20_000_000, range: { startS: .5, endS: .534 } }); completed(parity);
    expect(decodeRgba(parity.file!, SIZE.width, SIZE.height)[0]).toEqual(decodeRgba(normal.file!, SIZE.width, SIZE.height)[0]);
  } finally { await page.evaluate(async () => { const p = '/src/captions/parity-switches.ts'; (await import(p)).CAPTION_PARITY.decorations = 'render'; }); }
});

const blackClip = () => genMedia('t09-black-3s.mp4', ['-f', 'lavfi', '-i', 'color=black:size=160x90:rate=30:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
async function generated(page: Page, size = SIZE) {
  const doc = mkDoc([{ id: 'src', to: 3000, sourceDuration: 3000 }], { size });
  doc.tracks.push(track('c1', 'caption')); doc.layerOrder.push({ type: 'track', id: 'c1' });
  const { id, assets } = await setup(page, doc, { src: blackClip() });
  await page.evaluate(async assetId => {
    const sp = '/src/store/database.ts'; const { projectStore } = await import(sp);
    await projectStore.putRow('transcripts', { id: assetId, status: 'complete', created_at: new Date().toISOString(), transcript: { language: 'en', languages: ['en'], total_duration: 3,
      segments: [{ id: 0, start: 1, end: 2.4, text: 'one two', speaker: 0, words: [{ word: 'one', start: 1, end: 1.4 }, { word: 'two', start: 2, end: 2.4 }] }] } });
  }, assets.src);
  const result = await page.evaluate(async () => {
    const rp = '/src/timeline/runtime.ts', cp = '/src/captions/agent.ts', sp = '/src/store/database.ts';
    const rt = (await import(rp)).activeRuntime, { projectStore } = await import(sp), args = { trackId: 'c1' };
    return (await import(cp)).callCaptionTool(rt.tools, args, { store: projectStore, asset: (id: string) => rt.assets.get(id), run: () => rt.call('addCaptions', args) });
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  return id;
}

test('CAP-P08/P14: generated default position and §57 stroke survive a decoded portrait export', async ({ page }, info) => {
  const overlay = await installPipelineOverlay(page, info);
  const id = await generated(page, { width: 1080, height: 1920 });
  const doc = await saved(page, id), c = doc.items.find((i: any) => i.type === 'caption');
  expect(value(c, 'positionY')).toBe(1344);
  expect(Math.abs(value(c, 'positionX') - (1080 - value(c, 'width')) / 2)).toBeLessThanOrEqual(1);
  expect([value(c, 'fontSize'), value(c, 'fontWeight'), value(c, 'borderWidth'), value(c, 'borderColor')]).toEqual([65, '700', 3, '#000000']);
  const n = 33, t = n * 1000 / FPS, ink = (await seal(page, info, 'cap-p08', doc, [{ n, t }])).get(n)!;
  const captured = await captureExport(page, info, overlay, id, { bitrate: 20_000_000, range: { startS: 1.1, endS: 1.134 } }, [n], 'cap-p08');
  const frame = decodeRgba(captured.run.file!, 1080, 1920)[0];
  assertFrame(doc, ink, frame, t, { info, label: 'cap-p08', n, source: fromCapture(captured, n), black: ['video'] });
  // The independent glyph masks locate the default paragraph inside its §57 vertically centred box.
  expect(Math.min(...ink.map(w => w.y0))).toBeGreaterThanOrEqual(1344);
  expect(Math.abs((Math.min(...ink.map(w => w.x0)) + Math.max(...ink.map(w => w.x1))) / 2 - 540)).toBeLessThanOrEqual(4);
  // Black stroke cannot be measured on a black video. Restyle only the caption box to mid-gray, then compare the
  // 3 px outer band with an independent canvas drawing (strokeText lineWidth 6, round joins, then fillText).
  expect((await runtimeCall(page, 'editAllCaptionStyles', { trackId: 'c1', backgroundColor: '#808080' })).success).toBe(true);
  const styled = await saved(page, id), cap = styled.items.find((i: any) => i.type === 'caption');
  const out = await runExport(page, id, { bitrate: 20_000_000, range: { startS: 1.1, endS: 1.134 } }); completed(out);
  const actual = decodeRgba(out.file!, 1080, 1920)[0], placements = await masks(page, styled, 1100);
  const expected = await page.evaluate(({ placements, cap }) => {
    const ctx = new OffscreenCanvas(1080, 1920).getContext('2d')!;
    ctx.fillStyle = '#808080'; ctx.fillRect(cap.properties.positionX.defaultValue, cap.properties.positionY.defaultValue, cap.properties.width.defaultValue, cap.properties.height.defaultValue);
    ctx.strokeStyle = '#000000'; ctx.lineWidth = 6; ctx.lineJoin = 'round'; ctx.fillStyle = '#FFFFFF';
    for (const w of placements) { ctx.font = w.font; ctx.textBaseline = 'top'; ctx.strokeText(w.text, w.cx - w.width / 2, w.cy - w.F / 2); ctx.fillText(w.text, w.cx - w.width / 2, w.cy - w.F / 2); }
    const a = ctx.getImageData(0, 0, 1080, 1920).data, band: number[] = [], clear: number[] = [];
    for (const w of placements) for (let y = w.y0 - 5; y <= w.y1 + 5; y++) for (let x = w.x0 - 5; x <= w.x1 + 5; x++) {
      const i = (y * 1080 + x) * 4;
      if (a[i] < 8 && a[i + 3] > 250) band.push(i);
      if (a[i] === 128 && a[i + 3] === 255) clear.push(i);
    }
    return { band, clear };
  }, { placements, cap });
  expect(expected.band.length, 'non-empty stroke band').toBeGreaterThan(100);
  expect(expected.band.filter(i => actual[i] < 24).length / expected.band.length, 'decoded black band matches §57 2×stroke raster').toBeGreaterThan(0.98);
  expect(expected.clear.filter(i => actual[i] > 100 && actual[i] < 154).length / expected.clear.length, 'stroke does not spill into the expected gray band').toBeGreaterThan(0.98);
});

for (const corrected of [false, true]) for (const cut of [900, 1200, 1500]) test(`CT-06 decoded cut ${cut} ms (${corrected ? 'corrected' : 'untouched'}), right piece away/back`, async ({ page }, info) => {
  const overlay = await installPipelineOverlay(page, info);
  const id = await generated(page), initial = await liveDoc(page), c = initial.items.find((i: any) => i.type === 'caption');
  if (corrected) expect((await runtimeCall(page, 'editProperties', { itemId: c.id, properties: { text: 'ONE two' } })).success).toBe(true);
  expect((await runtimeCall(page, 'editAllCaptionStyles', { trackId: 'c1', fontSize: 60, borderWidth: 0, renderMode: 'highlight' })).success).toBe(true);
  const split = await runtimeCall(page, 'splitItem', { itemId: 'src', timestampS: cut / 1000 });
  expect(split.success, JSON.stringify(split)).toBe(true);
  const right = split.data.rightItemId;
  const checkState = (doc: any, moved: number) => {
    const caps = doc.items.filter((i: any) => i.type === 'caption').sort((a: any, b: any) => a.display.from - b.display.from);
    const first = corrected ? 'ONE' : 'one';
    expect(caps.map((i: any) => [i.details.text, i.display.from, i.display.to])).toEqual(cut < 1000 ? [[`${first} two`, 1000 + moved, 2900 + moved]] : [[first, 1000, cut], ['two', 2000 + moved, 2900 + moved]]);
    expect(caps.flatMap((i: any) => i.details.words.map((w: any) => [w.text, w.sourceStartMs, w.sourceEndMs]))).toEqual([[first, 1000, 1400], ['two', 2000, 2400]]);
    // The decoded-frame oracle may read local word times only after this independent contract-clock assertion.
    expect(caps.flatMap((i: any) => i.details.words.map((w: any) => [i.display.from - (i.trim?.from ?? 0) + w.startMs, i.display.from - (i.trim?.from ?? 0) + w.endMs])))
      .toEqual([[1000 + (cut < 1000 ? moved : 0), cut < 1000 ? 1400 + moved : Math.min(1400, cut)], [2000 + moved, 2400 + moved]]);
    return caps;
  };
  for (const by of [0.5, -0.5]) {
    expect((await runtimeCall(page, 'moveItem', { itemId: right, by })).success).toBe(true);
    const moved = by > 0 ? 500 : 0, doc = await saved(page, id); checkState(doc, moved);
    const boundaries = [cut, 1000 + (cut < 1000 ? moved : 0), Math.min(1400, cut), 2000 + moved, 2400 + moved];
    const ns = [...new Set(boundaries.flatMap(t => { const n = Math.ceil(t * FPS / 1000); return [n - 1, n, n + 1]; }))].filter(n => n >= 0).sort((a, b) => a - b);
    const label = `ct06-${cut}-${corrected ? 'corrected' : 'untouched'}-${by > 0 ? 'away' : 'back'}`, refs = await seal(page, info, label, doc, ns.map(n => ({ n, t: n * 1000 / FPS })));
    const cap = await captureExport(page, info, overlay, id, { bitrate: 20_000_000, range: { startS: 0, endS: doc.duration / 1000 } }, ns, label);
    const frames = decodeRgba(cap.run.file!, SIZE.width, SIZE.height);
    for (const n of ns) assertFrame(doc, refs.get(n)!, frames[n], n * 1000 / FPS, { info, label, n, source: fromCapture(cap, n), black: ['video'] });
  }
});
