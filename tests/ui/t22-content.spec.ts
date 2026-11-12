// SPDX-License-Identifier: AGPL-3.0-only
// T22 A2 and the sound catalogue in real Chromium: every built-in motion-graphic preset renders a frame through
// renderMotionGraphic on both reference canvases, and every catalogue sound is fetched as the app bundles it and decoded.
// Oracle: plan A2, §31 placement (mg_code_h on a landscape canvas that has one) and the catalogue's written durationMs.
// Sound length tolerance: ±34 ms, one frame at 30 fps (a Cutframe test choice). No fixture store, pixel hash or network.
import { test, expect, type Page } from '@playwright/test';
import { SOUNDS } from '../../apps/web/src/catalogue/sounds';
import { STYLE_PRESETS } from '../../apps/web/src/presets/content';
import { BUILT_IN_MG_PRESETS } from '../../apps/web/src/presets/mg-content';
import { skipTour } from './t02-support';

test.setTimeout(90_000);
type Rec = Record<string, any>;
type Library = 'mg' | 'style';
const leaks = new WeakMap<Page, string[]>();
// The sandbox is an about:srcdoc frame; it, data: and blob: are not network. Everything else must be this machine.
const local = (href: string) => { const url = new URL(href); return ['localhost', '127.0.0.1'].includes(url.hostname) || ['blob:', 'data:', 'about:'].includes(url.protocol); };
test.beforeEach(async ({ page }) => {
  await skipTour(page); const seen: string[] = []; leaks.set(page, seen);
  page.on('request', request => { if (!local(request.url())) seen.push(request.url()); });
  await page.route('**/*', route => local(route.request().url()) ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'no off-localhost requests, even failed ones').toEqual([]); });

const FPS = 30, CANVASES = [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }];
// Test titles come from the real lists in Node; the page's own lists are what is rendered and are checked to be the same.
const GRAPHIC_STYLE_IDS = STYLE_PRESETS.filter(p => !Array.isArray((p as Rec).items)).map(p => p.id), MG_IDS = BUILT_IN_MG_PRESETS.map(p => p.id);
const pageIds = (page: Page): Promise<{ mg: string[]; style: string[] }> => page.evaluate(async () => {
  const cp = '/src/presets/content.ts', gp = '/src/presets/mg-content.ts', mp = '/src/presets/model.ts', model = await import(mp);
  return { mg: (await import(gp)).BUILT_IN_MG_PRESETS.map((p: Rec) => p.id), style: (await import(cp)).STYLE_PRESETS.filter((p: Rec) => model.presetType(p) === 'motion-graphic').map((p: Rec) => p.id) };
});
/** One preset from the page's own built-in list, through the T08 loader, placed by §31 and rendered at its middle frame. */
async function renderPreset(page: Page, library: Library, id: string): Promise<Rec> {
  return page.evaluate(async ({ library, id, canvases, fps }) => {
    const lp = library === 'mg' ? '/src/presets/mg-content.ts' : '/src/presets/content.ts', pp = '/src/mg/presets.ts', mp = '/src/mg/index.ts';
    const lib = await import(lp), presets = await import(pp), mg = await import(mp);
    const source = (library === 'mg' ? lib.BUILT_IN_MG_PRESETS : lib.STYLE_PRESETS).filter((p: Rec) => p.id === id), loaded = presets.loadGraphicPresets(source);
    if (loaded.presets.length !== 1) return { found: source.length, skipped: loaded.skipped, frames: [] };
    const p = loaded.presets[0], total = Math.round(p.duration_ms * fps / 1000), frame = Math.floor(total / 2), frames: Rec[] = [];
    for (const canvas of canvases) {
      const { code, box } = presets.placeGraphicPreset(p, canvas);
      const out: Rec = { canvas, frame, total, box, hasH: typeof p.mg_code_h === 'string', isPortraitCode: code === p.mg_code, isLandscapeCode: code === p.mg_code_h };
      try {
        // As the stage asks (mg/frames.ts): canvas size for useVideoConfig, the item's box as the layout size.
        const result = await mg.renderMotionGraphic({ code, frame, width: canvas.width, height: canvas.height, fps, durationInFrames: total, designedLengthMs: p.duration_ms, itemSize: { width: box.width, height: box.height } });
        const image = new Image(); image.src = result.image; await image.decode();
        const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
        const g = c.getContext('2d')!; g.drawImage(image, 0, 0);
        const data = g.getImageData(0, 0, c.width, c.height).data; let painted = 0;
        for (let k = 3; k < data.length; k += 4) if (data[k] > 0) painted++;
        Object.assign(out, { decoded: { width: c.width, height: c.height }, painted });
      } catch (error) { out.error = { name: (error as Rec)?.name, code: (error as Rec)?.code, message: String((error as Rec)?.message ?? error) }; }
      frames.push(out);
    }
    return { found: source.length, skipped: loaded.skipped, durationMs: p.duration_ms, frames };
  }, { library, id, canvases: CANVASES, fps: FPS });
}

test.describe('A2: every built-in motion-graphic preset renders a frame in the browser', () => {
  test('the page lists the same built-in presets as the cases below, and at least 10 in the MG library', async ({ page }) => {
    await page.goto('/'); const ids = await pageIds(page);
    expect(ids.mg.length, 'ticket minimum for the MG preset library').toBeGreaterThanOrEqual(10); expect(new Set(ids.mg).size).toBe(ids.mg.length);
    expect(ids.mg).toEqual(MG_IDS); expect(ids.style).toEqual(GRAPHIC_STYLE_IDS); expect(ids.style.length, 'motion-graphic style presets').toBeGreaterThan(0);
  });
  for (const [library, ids] of [['mg', MG_IDS], ['style', GRAPHIC_STYLE_IDS]] as [Library, string[]][]) for (const id of ids) test(`${library === 'mg' ? 'MG library' : 'style preset'} ${id}: 1080×1920 and 1920×1080`, async ({ page }) => {
    await page.goto('/'); const result = await renderPreset(page, library, id);
    expect(result.found, 'one built-in preset with this id').toBe(1); expect(result.skipped, 'the loader accepts it').toEqual([]);
    expect(result.durationMs).toBeGreaterThan(0); expect(result.frames).toHaveLength(CANVASES.length);
    for (const [k, f] of (result.frames as Rec[]).entries()) {
      const label = `${id} on ${CANVASES[k].width}×${CANVASES[k].height}, frame ${f.frame} of ${f.total}`;
      expect(f.canvas).toEqual(CANVASES[k]); expect(f.frame, `${label}: inside the preset's length`).toBeGreaterThanOrEqual(0); expect(f.frame, label).toBeLessThan(f.total);
      // §31: the landscape code only on a landscape canvas, and only when the preset has one.
      const landscape = CANVASES[k].width > CANVASES[k].height && f.hasH;
      expect(landscape ? f.isLandscapeCode : f.isPortraitCode, `${label}: ${landscape ? 'mg_code_h' : 'mg_code'} is placed`).toBe(true);
      expect(f.box.width, label).toBeGreaterThan(0); expect(f.box.height, label).toBeGreaterThan(0);
      expect(f.error, `${label}: renders with no fault: ${JSON.stringify(f.error)}`).toBeUndefined();
      expect(f.decoded.width, `${label}: the PNG decodes`).toBeGreaterThan(0); expect(f.decoded.height, `${label}: the PNG decodes`).toBeGreaterThan(0);
      expect(f.painted, `${label}: some non-transparent pixels`).toBeGreaterThan(0);
    }
  });
});

test.describe('Sounds: each catalogue sound is fetched as bundled, decodes, has its catalogue length and is not silent', () => {
  test('the catalogue has 11 sounds with unique slugs, the same in the page', async ({ page }) => {
    expect(SOUNDS).toHaveLength(11); expect(new Set(SOUNDS.map(s => s.slug)).size).toBe(11);
    await page.goto('/');
    const inPage = await page.evaluate(async () => { const sp = '/src/catalogue/sounds.ts'; return (await import(sp)).SOUNDS.map((s: Rec) => ({ slug: s.slug, file: s.file, durationMs: s.durationMs })); });
    expect(inPage).toEqual(SOUNDS.map(s => ({ slug: s.slug, file: s.file, durationMs: s.durationMs })));
  });
  for (const sound of SOUNDS) test(`${sound.slug} (${sound.file.split('.').pop()}, ${sound.durationMs} ms)`, async ({ page }) => {
    await page.goto('/');
    const decoded = await page.evaluate(async file => {
      const ap = '/src/catalogue/assets.ts', blob: Blob = await (await import(ap)).bundledFile(file), bytes = await blob.arrayBuffer();
      try {
        const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes); let peak = 0;
        for (let ch = 0; ch < audio.numberOfChannels; ch++) { const data = audio.getChannelData(ch); for (let k = 0; k < data.length; k++) { const v = Math.abs(data[k]); if (v > peak) peak = v; } }
        return { bytes: blob.size, durationMs: audio.duration * 1000, frames: audio.length, channels: audio.numberOfChannels, peak };
      } catch (error) { return { bytes: blob.size, error: String((error as Rec)?.message ?? error) }; }
    }, sound.file) as Rec;
    expect(decoded.bytes, 'the bundled file has bytes').toBeGreaterThan(0); expect(decoded.error, `decodeAudioData: ${decoded.error}`).toBeUndefined();
    expect(decoded.frames).toBeGreaterThan(0); expect(decoded.channels).toBeGreaterThan(0);
    expect(Math.abs(decoded.durationMs - sound.durationMs), `decoded ${decoded.durationMs} ms vs catalogue ${sound.durationMs} ms, ±34 ms`).toBeLessThanOrEqual(34);
    expect(decoded.peak, 'not silent: some |sample| > 0.001').toBeGreaterThan(0.001);
  });
});
