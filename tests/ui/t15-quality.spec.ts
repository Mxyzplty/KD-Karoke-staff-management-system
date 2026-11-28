// SPDX-License-Identifier: AGPL-3.0-only
// T15 preview quality (part 3 §46.2 global setting; §53.8.3 canvas size). Needs ffmpeg for a small H.264 clip.
// Formula oracle (model formula, display measured in the page, never hard-coded): playing canvas =
//   max(2, round(Wp x q)) x max(2, round(Hp x q)), q = max(0.1, min(1, factor, display)), factor full 1 / half 0.5 / quarter 0.25,
//   display = max(onscreen W x dpr / Wp, onscreen H x dpr / Hp). Paused and seeked frames are always at the project size (written-spec oracle).
// Written-spec oracle: the setting is global (not per project), survives reload, and Use Proxy does not change the canvas size.
// No two-path (UI vs tool) test here: preview quality is a view setting, there is no quality tool (setQuality in editor/view.ts is the only writer).
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { createProject, skipTour } from './t02-support';
import { runtimeCall } from './t04-support';
import { canvasHash, canvasSizeOf, expectedPlayingSize, makeClip, openWithVideos, seekMs, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the H.264 clip the stage plays');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const open = (page: Page, seconds = 6) => openWithVideos(page, videoDoc([{ id: 'vid', to: seconds * 1000, sourceDuration: seconds * 1000 }], { duration: seconds * 1000 }), { vid: { path: makeClip(seconds) } }, 'T15 quality');
const setQuality = (page: Page, q: 'full' | 'half' | 'quarter') => page.evaluate(async q => { const p = '/src/editor/view.ts'; (await import(p)).setQuality(q); }, q);
const play = async (page: Page) => { await page.getByRole('button', { name: 'Play', exact: true }).click(); await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible(); };
const pause = async (page: Page) => { await page.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible(); };
/** The playing canvas size settles on the formula value for the display measured now (the stage re-reads the display every 500 ms). */
async function playingSize(page: Page) {
  const pair = async () => ({ expected: await expectedPlayingSize(page), actual: await canvasSizeOf(page) });
  await expect.poll(async () => { const { expected, actual } = await pair(); return JSON.stringify(actual) === JSON.stringify(expected) ? 'match' : `canvas ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`; }, { timeout: 10000, intervals: [250] }).toBe('match');
  return canvasSizeOf(page);
}

test.describe('large display (1600 x 2400 css px, dpr 2: display >= 1)', () => {
  test.use({ viewport: { width: 1600, height: 2400 }, deviceScaleFactor: 2 });
  test('playing canvas is the project size at Full, 540 x 960 at 1/2 and 270 x 480 at 1/4 (and equals the formula)', async ({ page }) => {
    await open(page);
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const q of ['full', 'half', 'quarter'] as const) {
      await setQuality(page, q); await play(page);
      sizes[q] = await playingSize(page);
      await pause(page);
    }
    expect(sizes).toEqual({ full: { width: 1080, height: 1920 }, half: { width: 540, height: 960 }, quarter: { width: 270, height: 480 } });
  });
  // Ledger l.41 / W3-ED-05 "fps unchanged +-2" (written-spec oracle), read as relative to Full (the reviewer's B1). It lives in the large-display describe so the three
  // qualities really render three canvas sizes (display >= 1: 1080 x 1920, 540 x 960, 270 x 480; at the default viewport Full and 1/2 are the same canvas, F6-B1).
  // The frame rate is painted / seconds over a 3 s window of in-page wall time (performance.now around a setTimeout) that starts after the size has settled and the clock
  // runs (playhead > 0), so the start wait is not in it; playbackStats is reset at the start of the window; the canvas size is read inside the window, at its end, and asserted.
  // The measured size, fps and skipped per quality are logged and put in the annotation.
  test('playing at Full, 1/2 and 1/4: each renders its own canvas size, the frame rate is within +-2 of Full and no frame is skipped', async ({ page }) => {
    await open(page, 6);
    const want = { full: { width: 1080, height: 1920 }, half: { width: 540, height: 960 }, quarter: { width: 270, height: 480 } };
    const fps: Record<string, number> = {}, skipped: Record<string, number> = {}, size: Record<string, { width: number; height: number }> = {};
    for (const q of ['full', 'half', 'quarter'] as const) {
      await setQuality(page, q); await seekMs(page, 0); await play(page);
      await playingSize(page);
      await expect.poll(() => page.evaluate(async () => { const p = '/src/editor/view.ts'; return (await import(p)).view().playheadMs as number; }), { timeout: 10000 }).toBeGreaterThan(0);
      const r = await page.evaluate(async () => {
        const p = '/src/render/playback.ts', { playbackStats, resetPlaybackStats } = await import(p);
        resetPlaybackStats(); const t0 = performance.now();
        await new Promise(done => setTimeout(done, 3000));
        const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement;
        return { painted: playbackStats.painted as number, skipped: playbackStats.skipped as number, seconds: (performance.now() - t0) / 1000, width: c.width, height: c.height };
      });
      await pause(page);
      fps[q] = r.painted / r.seconds; skipped[q] = r.skipped; size[q] = { width: r.width, height: r.height };
    }
    console.log(`T15 quality fps ${JSON.stringify(fps)} skipped ${JSON.stringify(skipped)} canvas ${JSON.stringify(size)}`);
    test.info().annotations.push({ type: 'measured', description: `fps ${JSON.stringify(fps)}; skipped ${JSON.stringify(skipped)}; canvas ${JSON.stringify(size)}` });
    expect(size, 'the canvas size measured inside each 3 s window').toEqual(want);
    expect(fps.full, 'Full plays at the project rate (30 fps +-2), so a relative check cannot pass on zero paints').toBeGreaterThanOrEqual(28);
    for (const q of ['half', 'quarter'] as const) expect(Math.abs(fps[q] - fps.full), `fps at ${q} (${fps[q].toFixed(2)}) vs Full (${fps.full.toFixed(2)})`).toBeLessThanOrEqual(2);
    for (const q of ['full', 'half', 'quarter'] as const) expect(skipped[q], `skipped at ${q}`).toBe(0);
  });
});

test('default display: the playing canvas follows the formula for every quality and is never larger than the project', async ({ page }) => {
  await open(page);
  for (const q of ['full', 'half', 'quarter'] as const) {
    await setQuality(page, q); await play(page);
    const size = await playingSize(page);
    expect(size.width).toBeLessThanOrEqual(1080); expect(size.height).toBeLessThanOrEqual(1920);
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(2);
    await pause(page);
  }
});

test('paused and seeked frames are pixel-identical across qualities and at the project size', async ({ page }) => {
  await open(page);
  const hashes: string[] = [];
  for (const q of ['full', 'half', 'quarter'] as const) {
    await setQuality(page, q);
    await seekMs(page, 1000); await shown(page, 30); // away, then to the frame under test (a fresh render each time)
    await seekMs(page, 2000); await shown(page, 60);
    expect(await canvasSizeOf(page), `quality ${q}`).toEqual({ width: 1080, height: 1920 });
    hashes.push(await canvasHash(page));
  }
  expect(new Set(hashes).size, 'one frame hash for all qualities').toBe(1);
});

test('the quality setting is global: survives a reload and carries to another project', async ({ page }) => {
  const first = await open(page);
  await page.getByRole('button', { name: /^Preview quality: Full$/ }).click();
  await page.getByRole('menuitemradio', { name: /^1\/2/ }).click();
  await expect(page.getByRole('button', { name: 'Preview quality: 1/2' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cutframe:preview-quality'))).toBe('half');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Preview quality: 1/2' })).toBeVisible();
  const second = await createProject(page, videoDoc([{ id: 'vid' }]), 'T15 quality 2');
  expect(second).not.toBe(first);
  await page.goto(`/project/${second}`);
  await expect(page.getByRole('button', { name: 'Preview quality: 1/2' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cutframe:preview-quality'))).toBe('half');
});

test('Use Proxy off does not change the playing canvas size', async ({ page }) => {
  await open(page);
  await setQuality(page, 'half');
  await play(page); const on = await playingSize(page); await pause(page);
  const r = await runtimeCall(page, 'setUseProxy', { itemId: 'vid', useProxy: false }) as { success: boolean };
  expect(r.success).toBe(true);
  await play(page); const off = await playingSize(page); await pause(page);
  expect(off).toEqual(on);
});
