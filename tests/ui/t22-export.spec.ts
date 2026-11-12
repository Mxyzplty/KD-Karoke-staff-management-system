// SPDX-License-Identifier: AGPL-3.0-only
// T22 E1–E4: the same stored project/frame captured by framePlan + composite on black, then D34 output, versus decoded MP4.
// Motion-graphic sources alone receive the independent D35 input table before compositing. Every scored frame needs SSIM >= .98.
// Real Executor, preset/element imports and template binding. No pipeline edit, source seam, reporter or author-run command.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { compare } from './t10a-support';
import { completed, decodeRgba, runExport, setup } from './t16a-support';
import { inputCode, outputCode, transferBytes } from '../../parity/oracle/transfer';

test.skip(!ffmpegAvailable(), 'ffmpeg decodes the exported file for the capture comparison');
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => {
  await skipTour(page); await page.route(/fonts\.googleapis\.com/, route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'blocked' }));
});

type Rec = Record<string, any>;
const SIZE = { width: 320, height: 180 }, W = SIZE.width, H = SIZE.height, FPS = 30, MS = 200;
// D47: the software H.264 encoder can round its first three frames. Score frame 4, still inside this six-frame fixture.
const FRAME = 4, T_MS = FRAME * 1000 / FPS;
const GRAPHIC_INPUT = Array.from({ length: 256 }, (_, code) => inputCode(code));
const track = (id: string, kind: string) => ({ id, name: id, kind, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
function emptyDoc() {
  const tracks = [track('V1', 'video'), track('O1', 'overlay')];
  return { schemaVersion: 4, rev: 0, groups: {}, duration: MS, fps: FPS, size: SIZE, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), items: [] as Rec[] };
}
async function agentCall(page: Page, toolName: string, input: Rec): Promise<Rec> {
  return page.evaluate(async ({ toolName, input }) => {
    const rp = '/src/timeline/runtime.ts', ep = '/src/agent/executor.ts', rt = (await import(rp)).activeRuntime, win = window as any;
    if (!win.__t22ExportAgent) {
      const data = new Map<string, string>(), Executor = (await import(ep)).Executor;
      win.__t22ExportAgent = { seq: 0, executor: new Executor({ current: () => rt, storage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } } }) };
    }
    const state = win.__t22ExportAgent;
    const call = (name: string, args: Rec) => state.executor.execute({ type: 'call', callId: `t22-export-${++state.seq}`, executionKey: `t22-export-${state.seq}`, session: 't22-export', toolName: name, input: args });
    await call('context', {}); return call(toolName, input);
  }, { toolName, input });
}
async function saved(page: Page) {
  const state = await page.evaluate(async () => { const p = '/src/editor.tsx', session = (await import(p)).activeSession; await session.flush(); return session.state; });
  expect(state).toBe('saved'); await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 15000 });
}
const stored = (page: Page, id: string): Promise<Rec> => page.evaluate(async id => {
  const p = '/src/store/database.ts'; return JSON.parse(JSON.stringify(await (await import(p)).projectStore.read(id)));
}, id);
async function shortPreset(page: Page, id: string, presetId: string) {
  const applied = await agentCall(page, 'applyPreset', { presetId }); expect(applied.success, JSON.stringify(applied)).toBe(true); await saved(page);
  const before = await stored(page, id); expect(applied.data.itemIds).toHaveLength(1); const itemId = applied.data.itemIds[0] as string, item = before.document.items.find((i: Rec) => i.id === itemId);
  expect(item.display.from).toBe(0);
  // Shorten through the real trim tool, retaining the preset's authored code, style and entrance keyframes.
  const trimmed = await agentCall(page, 'trimItem', { itemId, handle: 'end', deltaSeconds: (MS - item.display.to) / 1000 }); expect(trimmed.success, JSON.stringify(trimmed)).toBe(true); await saved(page);
  const after = await stored(page, id); expect(after.document.duration).toBe(MS); expect(after.document.items[0].display).toEqual({ from: 0, to: MS }); return after.document.items[0] as Rec;
}

type Capture = { preview: Uint8Array; beforeOutput: Uint8Array; graphics: number };
async function previewRgba(page: Page, id: string): Promise<Capture> {
  const result = await page.evaluate(async ({ id, size, tMs, inputTable }) => {
    const mp = '/src/render/model.ts', cp = '/src/render/compositor.ts', fp = '/src/text/fonts.ts', sp = '/src/render/sources.ts', db = '/src/store/database.ts';
    const model = await import(mp), comp = await import(cp), fonts = await import(fp), pictures = await import(sp), { projectStore } = await import(db);
    const { document: doc } = await projectStore.read(id); await fonts.loadTextFonts(doc);
    const assets = new Map<string, Rec>((await projectStore.library()).assets.map((a: Rec) => [a.id, a])), plan = model.framePlan(doc, tMs, size);
    if (plan.pending.length) throw new Error(`Preview capture has pending draws: ${JSON.stringify(plan.pending)}`);
    // The paused stage's public picture() path supplies images, MGs and layout children; text needs no external source.
    const sources = await Promise.all(plan.draws.map((draw: Rec) => pictures.picture(projectStore, draw, assets.get(String(draw.item.metadata?.assetId)), 'preview', (key: string) => assets.get(key))));
    const owned = sources.flatMap((source: any, index: number) => plan.draws[index].kind === 'motionGraphic' && comp.isPicture(source) ? [source.image as ImageBitmap] : []);
    const encode = (bytes: Uint8ClampedArray) => { let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); };
    try {
      sources.forEach((source: any, index: number) => { if (plan.draws[index].kind !== 'text' && !comp.complete(source, plan.draws[index])) throw new Error(`Preview source unavailable for ${plan.draws[index].item.id}`); });
      const canvas = new OffscreenCanvas(size.width, size.height), ctx = canvas.getContext('2d')!;
      const failures = comp.composite(ctx, plan.draws, sources, size, 'black'); if (failures.length) throw new Error(`Preview effects failed: ${JSON.stringify(failures)}`);
      const preview = ctx.getImageData(0, 0, size.width, size.height).data;
      if (!owned.length) return { preview: encode(preview), beforeOutput: encode(preview), graphics: 0 };
      // Independent D35: table the graphic's pixels BEFORE its box/alpha compositing, never the final preview as a whole.
      // Grid Reveal's full-frame opaque background means canvas readback preserves its straight RGB (no partial-alpha loss).
      const adjusted = sources.map((source: any, index: number) => {
        if (plan.draws[index].kind !== 'motionGraphic') return source;
        const c = new OffscreenCanvas(source.width, source.height), g = c.getContext('2d')!; g.drawImage(source.image, 0, 0);
        const image = g.getImageData(0, 0, c.width, c.height);
        for (let p = 0; p < image.data.length; p += 4) {
          if (image.data[p + 3] !== 255) throw new Error('The selected MG fixture must be opaque for the straight-colour input oracle.');
          for (let k = 0; k < 3; k++) image.data[p + k] = inputTable[image.data[p + k]];
        }
        g.putImageData(image, 0, 0); return { image: c, width: source.width, height: source.height };
      });
      const corrected = comp.composite(ctx, plan.draws, adjusted, size, 'black'); if (corrected.length) throw new Error(`D35 capture failed: ${JSON.stringify(corrected)}`);
      return { preview: encode(preview), beforeOutput: encode(ctx.getImageData(0, 0, size.width, size.height).data), graphics: owned.length };
    } finally { for (const bitmap of owned) bitmap.close(); } // cached image sources belong to the preview, not this capture
  }, { id, size: SIZE, tMs: T_MS, inputTable: GRAPHIC_INPUT });
  return { preview: new Uint8Array(Buffer.from(result.preview, 'base64')), beforeOutput: new Uint8Array(Buffer.from(result.beforeOutput, 'base64')), graphics: result.graphics };
}
async function exportFrame(page: Page, id: string) {
  await saved(page); const capture = await previewRgba(page, id), run = await runExport(page, id, {}, undefined, true), result = completed(run);
  expect(result.size).toEqual(SIZE); expect(result.fps).toBe(FPS); expect(result.frames).toBe(6); expect(result.notRendered).toEqual([]);
  const frames = decodeRgba(run.file!, W, H); expect(frames.length).toBe(6); const frame = new Uint8Array(frames[FRAME]), expected = transferBytes(capture.beforeOutput, 'output'), diff = compare(frame, expected, W, H);
  expect(diff.ssim, `frame ${FRAME}: SSIM ${diff.ssim}, meanErr ${diff.meanErr}`).toBeGreaterThanOrEqual(0.98); return { frame, capture };
}
const rgbAt = (rgba: Uint8Array, x: number, y: number) => Array.from(rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
const near = (actual: number[], expected: number[], tolerance: number, label: string) => actual.forEach((v, k) => expect(Math.abs(v - expected[k]), `${label}, channel ${k}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
function litPixels(rgba: Uint8Array) { let lit = 0; for (let i = 0; i < rgba.length; i += 4) if (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) > 24) lit++; return lit; }
async function bindDaylight(page: Page) {
  await page.getByRole('button', { name: 'Template: No template', exact: true }).click();
  await page.getByRole('menu', { name: /^Template: / }).getByRole('menuitem', { name: 'Change template', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a Template', exact: true }); await picker.getByRole('tab', { name: 'Built-in templates', exact: true }).click();
  await picker.getByRole('list', { name: 'Built-in templates', exact: true }).getByRole('button', { name: /^Daylight/ }).click(); await picker.getByRole('button', { name: 'Use Daylight', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Template: Daylight', exact: true })).toBeVisible(); await saved(page);
}
// The unicode-range of the bundled Latin files (the pinned block of tests/t22-bundled-fonts.test.ts). A FontFace does not show
// its file, so the bundled face is known by its family, its weight and this range; the browser may print the range in a
// shorter form, so both sides are compared as number pairs.
const BUNDLED_LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const bundledSoraFaces = (page: Page, id: string): Promise<Rec[]> => page.evaluate(async ({ id, latin }) => {
  const fp = '/src/text/fonts.ts', db = '/src/store/database.ts', fonts = await import(fp), { projectStore } = await import(db);
  await fonts.loadTextFonts((await projectStore.read(id)).document);
  const pairs = (range: string) => range.split(',').map(token => token.trim().replace(/^U\+/i, '').split('-').map(hex => parseInt(hex, 16))).map(p => `${p[0]}-${p[1] ?? p[0]}`).sort().join(',');
  return Array.from(document.fonts).filter(face => face.family.replace(/^['"]|['"]$/g, '') === 'Sora' && face.weight === '800' && pairs(face.unicodeRange) === pairs(latin))
    .map(face => ({ style: face.style, status: face.status }));
}, { id, latin: BUNDLED_LATIN });

test('(a) E1: the real text style preset exports glyphs and matches the same-frame preview capture', async ({ page }) => {
  const { id } = await setup(page, emptyDoc(), {}, 'T22 E1 text export');
  // Built-in direct preset text/big-headline has one text item, Latin text, Sora 800 and its authored fade/rise.
  const item = await shortPreset(page, id, 'text/big-headline'); expect(item.type).toBe('text'); expect(item.metadata.presetId).toBe('text/big-headline');
  const { frame, capture } = await exportFrame(page, id); expect(capture.graphics).toBe(0);
  // The portrait-authored preset is fit-scaled into 320x180 and is still entering at frame 4: use a small nonblank glyph bound.
  expect(litPixels(capture.preview), 'preview glyph pixels').toBeGreaterThan(30); expect(litPixels(frame), 'exported glyph pixels').toBeGreaterThan(30);
});

test('(b) E2: the real motion-graphic style preset matches D35-input then D34-output preview pixels', async ({ page }) => {
  const { id } = await setup(page, emptyDoc(), {}, 'T22 E2 graphic export');
  // Built-in collages/grid-reveal fills the frame. At frame 4 only the first (left) tile has begun entering;
  // (310,10) is flat #0e0f12 in the still-unentered upper-right opening, clear of text, edges and antialiasing.
  const item = await shortPreset(page, id, 'collages/grid-reveal'); expect(item.type).toBe('motionGraphic'); expect(item.metadata.presetId).toBe('collages/grid-reveal');
  const { frame, capture } = await exportFrame(page, id); expect(capture.graphics).toBe(1);
  near(rgbAt(capture.preview, 310, 10), [14, 15, 18], 0, 'authored flat graphic background in the unmodified preview');
  near(rgbAt(frame, 310, 10), [14, 15, 18].map(v => outputCode(inputCode(v))), 1, 'D35 then D34 point check, as t11-d35-colour');
});

test('(c) E3: a two-slot sticker recolour survives export, matches the preview and differs from its unedited palette', async ({ page }) => {
  const { id } = await setup(page, emptyDoc(), {}, 'T22 E3 element export');
  // sticker-star: #FFC83D fill and #1B1B1F outline; centre samples are well inside its flat fill, not the 20px SVG stroke.
  const added = await agentCall(page, 'addMedia', { assetId: 'element:sticker-star', trackId: 'V1', duration: 0.2, bounds: { x: 96, y: 26, width: 128, height: 128 } });
  expect(added.success, JSON.stringify(added)).toBe(true); await saved(page); const itemId = added.data.addedItemIds[0] as string, before = await stored(page, id);
  expect(before.document.items[0].details.element.palette.map((slot: Rec) => slot.base)).toEqual(['#FFC83D', '#1B1B1F']); expect(before.document.items[0].details.element).not.toHaveProperty('colors');
  const baseline = await exportFrame(page, id), colors = ['#00FF00', '#2F6BFF'];
  const edited = await agentCall(page, 'editProperties', { itemId, properties: { colors } }); expect(edited.success, JSON.stringify(edited)).toBe(true); await saved(page);
  expect((await stored(page, id)).document.items[0].details.element.colors).toEqual(colors); const recoloured = await exportFrame(page, id);
  const original = [255, 200, 61].map(outputCode), asked = [0, 255, 0].map(outputCode), samples = [[156, 86], [164, 86], [156, 94], [164, 94]];
  for (const [x, y] of samples) {
    const oldPixel = rgbAt(baseline.frame, x, y), newPixel = rgbAt(recoloured.frame, x, y);
    near(oldPixel, original, 16, `original palette at ${x},${y}`); near(newPixel, asked, 16, `asked colour after D34 at ${x},${y}`);
    expect(Math.max(...oldPixel.map((v, k) => Math.abs(v - asked[k]))), 'baseline is clearly not the asked colour').toBeGreaterThan(80);
    expect(Math.max(...newPixel.map((v, k) => Math.abs(v - oldPixel[k]))), 'the same exported pixels visibly changed').toBeGreaterThan(80);
  }
});

test('(d) E4: real Daylight binding supplies bundled Sora-ExtraBold to agent addText and exports Latin glyphs with Google fonts blocked', async ({ page }) => {
  const { id } = await setup(page, emptyDoc(), {}, 'T22 E4 bound font export'); await bindDaylight(page);
  const bound = await stored(page, id); expect(bound.record).toMatchObject({ template_id: 'daylight', template_epoch: 1 }); expect(bound.document.templateDefaults).toMatchObject({ templateId: 'daylight', epoch: 1, titlesFont: 'Sora-ExtraBold' });
  const added = await agentCall(page, 'addText', { textContent: 'Sora Hi', trackId: 'O1', duration: 0.2, fontSize: 48, color: '#ffffff', bounds: { x: 40, y: 50, width: 240 } }); // deliberately no font
  expect(added.success, JSON.stringify(added)).toBe(true); await saved(page); const title = (await stored(page, id)).document.items.find((i: Rec) => i.id === added.data.itemId);
  expect(title.details.fontFamily).toBe('Sora-ExtraBold'); expect(title.details.fontFamilyDisplay).toBe('Sora');
  // Lit pixels alone would also pass with a fallback face. After the export's own font preload (loadTextFonts on the stored
  // document), document.fonts holds one Sora 800 face with the bundled file's Latin range, and that face is loaded.
  expect(await bundledSoraFaces(page, id), 'the bundled Sora-ExtraBold face in document.fonts').toEqual([{ style: 'normal', status: 'loaded' }]);
  const { frame, capture } = await exportFrame(page, id); expect(capture.graphics).toBe(0); expect(litPixels(capture.preview), 'bundled Sora preview glyphs').toBeGreaterThan(300); expect(litPixels(frame), 'bundled Sora exported glyphs').toBeGreaterThan(300);
});
