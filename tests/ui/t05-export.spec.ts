// SPDX-License-Identifier: AGPL-3.0-only
// T05 text in the export (notes §7 acceptance (b) and the Q5 / R2 font-load rulings; pipeline.ts loadTextFonts). Oracle = the
// in-page "preview capture" (render/model.framePlan + render/compositor.composite — the one path the paused preview, the playing
// preview, captureFrame and the export all draw through), decoded back from the exported MP4 by ffmpeg. The text oracle is this
// capture, not parity/oracle/renderFrame: a float CPU reference cannot rasterise glyphs, so drawText is checked against the same
// composite() that produced the preview, per-frame SSIM >= 0.98 (Rec. 709 luma, 8x8 windows, t10a-support.ssim). The only gap
// between the two is the 8-bit YUV420 H.264 encode (grayscale text / a black->white gradient carry no chroma, so BT.709/601 does
// not enter); drawText itself is byte-identical because it is the identical code path.
//   (a) a Roboto 700 white text on black: glyph pixels inside the text box, none 8 px clear of it, and the exported frame ==
//       the preview capture (SSIM >= 0.98).
//   (b) the acceptance gradient (linear 180deg #000 -> #fff on the glyphs) renders in the export: the box fill is mid-gray, the
//       glyph pixels run dark at the top to light at the bottom, and the frame == the preview capture.
//   (c) a CJK font that cannot load is a message only: CJK_NOTICE is in result.messages and the export still completes.
//   (d) an item font that cannot load stops the export with its FONT_* code (never a silent fallback).
// fonts.googleapis.com is routed to 404 throughout: it proves the bundled Roboto path needs no network, and it is what makes the
// CJK chain font (c) and the Google item font (d) fail.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { compare, ssim } from './t10a-support';
import { completed, decodeRgba, runExport, setup, type Run } from './t16a-support';
// fonts.ts cannot be imported into the Node test process (its `?url` font imports need Vite); CJK_NOTICE is read from the page.

test.skip(!ffmpegAvailable(), 'ffmpeg decodes the exported file for the capture comparison');
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => {
  await skipTour(page);
  // No network for fonts: the bundled Roboto must still load; a Google family (item font or the CJK chain font) must fail.
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 404, contentType: 'text/plain', body: 'blocked' }));
});

const SIZE = { width: 320, height: 180 };
const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const track = (id: string, name: string, kind: string) => ({ id, name, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
/** A 320x180 doc, one overlay text item `txt` on track O1, 0-0.2 s (static — every frame is the full text). */
function textDoc(details: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const tracks = [track('o1', 'O1', 'overlay')];
  return {
    schemaVersion: 4, rev: 0, groups: {}, duration: 200, fps: 30, size: SIZE, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })),
    items: [{
      id: 'txt', type: 'text', trackId: 'o1', display: { from: 0, to: 200 }, trim: { from: 0, to: 200 }, playbackRate: 1, masks: [], effects: [],
      details: { text: 'Hi', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto', ...details },
      properties: {
        opacity: p(1), scale: p(1), rotation: p(0), fontSize: p(90), fontWeight: p(700), color: p('#ffffff'), backgroundColor: p('transparent'),
        textAlign: p('center'), wordWrap: p('break-word'), borderWidth: p(0), borderColor: p('#000000'),
        positionX: p(40), positionY: p(30), width: p(240), height: p(120), ...props,
      },
    }],
  };
}

/** The preview capture of frame `tMs` of the stored project `id`, at `width` x `height`, as RGBA — the export's own per-frame
 *  path (framePlan + composite on an opaque black canvas), with the same fonts preloaded. */
async function previewRgba(page: Page, id: string, width: number, height: number, tMs = 0): Promise<Uint8Array> {
  const b64 = await page.evaluate(async ({ id, width, height, tMs }) => {
    // Vite-served runtime URLs, not resolvable module specifiers (t08-fonts.spec.ts:14 pattern): path vars + @vite-ignore.
    const modelPath = '/src/render/model.ts', compPath = '/src/render/compositor.ts', fontsPath = '/src/text/fonts.ts', dbPath = '/src/store/database.ts';
    const m = await import(/* @vite-ignore */ modelPath), comp = await import(/* @vite-ignore */ compPath);
    const fonts = await import(/* @vite-ignore */ fontsPath), { projectStore } = await import(/* @vite-ignore */ dbPath);
    const { document: doc } = await projectStore.read(id);
    await fonts.loadTextFonts(doc);                                             // the export loads these before the first frame; match it
    const size = { width, height }, plan = m.framePlan(doc, tMs, size);
    const ctx = new OffscreenCanvas(width, height).getContext('2d')!;
    comp.composite(ctx, plan.draws, plan.draws.map(() => null), size, 'black'); // same backdrop as pipeline.ts
    const data = ctx.getImageData(0, 0, width, height).data;
    let bin = ''; for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(bin);
  }, { id, width, height, tMs });
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

const W = SIZE.width, H = SIZE.height;
const luma = (d: Uint8Array, i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const lumaAt = (d: Uint8Array, x: number, y: number) => luma(d, (y * W + x) * 4);
/** Pixels with any channel > 24 among those where `keep(x, y)` holds. */
const litWhere = (d: Uint8Array, keep: (x: number, y: number) => boolean) => {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (keep(x, y) && (d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24)) n++; }
  return n;
};
const inBox = (x: number, y: number) => x >= 40 && x < 280 && y >= 30 && y < 150;           // the text box (positionX/Y, width/height)
const farOutside = (x: number, y: number) => x < 32 || x >= 288 || y < 22 || y >= 158;     // 8 px (one H.264 block) clear of the box
const exportFrame = async (page: Page, id: string): Promise<{ run: Run; frame: Uint8Array }> => {
  const run = await runExport(page, id, {}, undefined, true);
  completed(run);
  return { run, frame: new Uint8Array(decodeRgba(run.file!, W, H)[0]) };
};

test.describe('T05 text export (drawText == the preview capture)', () => {
  test('(a) a Roboto 700 white text on black: glyphs in the box, blank outside, and the frame matches the preview capture', async ({ page }) => {
    const { id } = await setup(page, textDoc(), {});
    const { frame } = await exportFrame(page, id);
    const preview = await previewRgba(page, id, W, H);
    const diff = compare(frame, preview, W, H);
    expect(litWhere(frame, inBox), 'glyph pixels inside the text box').toBeGreaterThan(300);
    expect(litWhere(frame, farOutside), 'a blank area outside the text box').toBe(0);
    expect(diff.ssim, `SSIM ${diff.ssim} (meanErr ${diff.meanErr})`).toBeGreaterThanOrEqual(0.98); // only the YUV420 encode differs
  });

  test('(b) the acceptance gradient (linear 180deg #000 -> #fff) renders in the export', async ({ page }) => {
    const grad = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)';
    const { id } = await setup(page, textDoc({}, { color: p(grad), backgroundColor: p('#808080') }), {});
    const { frame } = await exportFrame(page, id);
    const preview = await previewRgba(page, id, W, H);
    // the solid box fill (a corner clear of the glyphs) reads mid-gray: the text item drew in the export
    expect(lumaAt(frame, 44, 34)).toBeGreaterThan(112); expect(lumaAt(frame, 44, 34)).toBeLessThan(144);
    // a black -> white gradient on the glyphs: among the glyph pixels (far from the 128 box), the top half is darker than the bottom
    const glyphMean = (y0: number, y1: number) => {
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = 40; x < 280; x++) { const l = lumaAt(frame, x, y); if (Math.abs(l - 128) > 40) { sum += l; n++; } }
      return { mean: n ? sum / n : 128, n };
    };
    const top = glyphMean(30, 90), bottom = glyphMean(90, 150);
    expect(top.n, 'glyph pixels in the top half').toBeGreaterThan(50);
    expect(bottom.n, 'glyph pixels in the bottom half').toBeGreaterThan(50);
    expect(bottom.mean - top.mean, `top glyph luma ${top.mean} vs bottom ${bottom.mean}`).toBeGreaterThan(40);
    expect(ssim(frame, preview, W, H)).toBeGreaterThanOrEqual(0.98); // matches the known-good preview gradient render
  });

  test('(c) a CJK font that cannot load is a message only: CJK_NOTICE in result.messages, export completes', async ({ page }) => {
    const { id } = await setup(page, textDoc({ text: '你好世界' }), {}); // Roboto draws the (absent) glyphs; the CJK chain font is fetched from Google
    const cjkNotice = await page.evaluate(async () => { const fontsPath = '/src/text/fonts.ts'; return (await import(/* @vite-ignore */ fontsPath)).CJK_NOTICE; });
    const run = await runExport(page, id, {}, undefined, false);
    const result = completed(run);
    expect(result.messages).toContain(cjkNotice);
  });

  test('(d) an item font that cannot load stops the export with its FONT_* code', async ({ page }) => {
    const { id } = await setup(page, textDoc({ fontFamily: 'OpenSans-Regular', fontFamilyDisplay: 'Open Sans' }), {});
    const run = await runExport(page, id, {}, undefined, false);
    expect(run.status).toBe('failed');
    expect(run.error?.code, JSON.stringify(run.error)).toMatch(/^FONT_/);
  });
});
