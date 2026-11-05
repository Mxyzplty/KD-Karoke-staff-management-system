// SPDX-License-Identifier: AGPL-3.0-only
// T11 transitions in the PLAYING preview (render/playback.ts, the extended-side path). Needs ffmpeg for two 4 s solid-colour H.264 clips.
// Oracle: findings part 5 §55.3 (inside the window both clips are drawn at t, A past its end and B before its start, frozen first / last frame
// when the source has no more) and §55.4 / §55.5 (wipe from-left: B enters from the left edge, A stays on the right) with results §11 decision 1
// (Cutframe renders transitions in the playing preview too). Timeline: A (red) on V1 0–4 s, B (blue) on V1 4–8 s, a wipe from-left, 3000 ms,
// Center: the window is [2500, 5500) ms and p = (t − 2500) / 3000. Both extensions run past a clip's 4 s source (A past 4000, B before 0).
// Tolerance: ±40 per channel (H.264 / yuv420p colour); "not black" is asserted too. skipped / notReady counts are load-sensitive on CI and not asserted.
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { openWithVideos, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the two solid-colour 4 s H.264 clips');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

/** A 160×90, 30 fps, 4 s solid-colour H.264 clip (cached per machine run, as t15-support makeClip). */
function solidClip(colour: 'red' | 'blue'): string {
  const dir = path.join(tmpdir(), 'cutframe-t11-media'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${colour}-160x90-4s.mp4`);
  if (!existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=160x90:r=30:d=4`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', out]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  return out;
}

const RED = [255, 0, 0], BLUE = [0, 0, 255], TOL = 40;
const close = (got: number[], want: number[]) => want.every((v, k) => Math.abs(got[k] - v) <= TOL) && got.some(v => v > 60);   // within tolerance and not black

test('a wipe from-left over two clamped clips plays: B at the stage\'s left edge, A at its right edge in a recorded frame with p = .3–.7; then Pause, failed == 0', async ({ page }) => {
  const doc = videoDoc([{ id: 'a', from: 0, to: 4000, sourceDuration: 4000 }, { id: 'b', from: 4000, to: 8000, sourceDuration: 4000 }],
    { duration: 8000, size: { width: 160, height: 90 }, transitions: [{ id: 'transition_abcdefghij', trackId: 'v1', fromId: 'a', toId: 'b', kind: 'wipe', direction: 'from-left', durationMs: 3000, alignment: 0.5 }] });
  await openWithVideos(page, doc, { a: { path: solidClip('red') }, b: { path: solidClip('blue') } }, 'T11 playback');
  await page.evaluate(async () => { const p = '/src/editor/view.ts'; (await import(p)).setView({ playheadMs: 2000 }); });
  await page.evaluate(async () => { const p = '/src/render/playback.ts'; const { playbackStats } = await import(p); playbackStats.failed = 0; });
  // An in-page requestAnimationFrame recorder (no CDP round trips while playing): each painted tick records the playhead, its p and the two strips of the stage
  // (x = 2 and x = width − 6, middle row). The assertions run on the recording after Pause.
  type Rec = { t: number; p: number; left: number[]; right: number[] };
  await page.evaluate(async () => {
    const v = '/src/editor/view.ts', { view } = await import(v), w = window as any, rec: unknown[] = [];
    w.__rec = rec; w.__recOn = true;
    const tick = () => {
      if (!w.__recOn) return;
      const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement | null;
      if (c) {
        const t = view().playheadMs as number, d = c.getContext('2d')!, y = Math.floor(c.height / 2);
        const avg = (x: number) => { const px = d.getImageData(x, y - 1, 4, 3).data, m = [0, 0, 0]; for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) m[k] += px[i + k] / (px.length / 4); return m; };
        rec.push({ t, p: (t - 2500) / 3000, left: avg(2), right: avg(c.width - 6) });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('section.preview').click({ position: { x: 5, y: 5 } });   // focus the preview, not a button
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(async () => { const v = '/src/editor/view.ts'; return (await import(v)).view().playheadMs as number; }), { timeout: 15000, intervals: [100], message: 'the playhead passes p = .7 (t = 4600 ms)' }).toBeGreaterThan(4600);
  const recorded = await page.evaluate(() => { const w = window as any; w.__recOn = false; return w.__rec as unknown[]; }) as Rec[];

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const inWindow = recorded.filter(r => r.p >= 0.3 && r.p <= 0.7);
  const fmt = (r: Rec) => `t=${Math.round(r.t)} p=${r.p.toFixed(3)} left=${r.left.map(Math.round)} right=${r.right.map(Math.round)}`;
  expect(inWindow.some(r => close(r.left, BLUE) && close(r.right, RED)),
    [`${recorded.length} frames recorded in total; ${inWindow.length} with p in .3–.7 (want one with left ≈ BLUE, right ≈ RED):`, ...inWindow.map(fmt)].join('\n')).toBe(true);
  const failed = await page.evaluate(async () => { const p = '/src/render/playback.ts'; return (await import(p)).playbackStats.failed as number; });
  expect(failed, 'no draw showed the failed picture').toBe(0);
});
