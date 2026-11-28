// SPDX-License-Identifier: AGPL-3.0-only
// T13 F9 review L3: the Linux gate's evidence for M (audio/preview.ts startMargin). M's headroom against the observed overrun
// depends on the runner's baseLatency, and the two readings of t21-r3-clean conflict, so this logs the real context's latency
// and the F9 diagnostics after a short play of one audible clip. t13-preview.spec.ts (b) is frozen (D55), hence a spec of its
// own. Diagnostic only: the one assertion is that a sound mounted (the log then describes a play that sounded); no gate on
// latency, riskyStarts or any timing value.
import { expect, test } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { genMedia, mkDoc, setup } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the tone');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const TONE = () => genMedia('t13-l-tone440.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-af', 'volume=4', '-ac', '2', '-c:a', 'pcm_s16le']);
test('the preview context\'s baseLatency and the F9 diagnostics over a 1 s play (logged; asserts only that a sound mounted)', async ({ page }) => {
  // keeps the AudioContext the preview makes (playback.ts makes one per page, at the first play)
  await page.addInitScript(() => {
    const Original = window.AudioContext, w = window as unknown as { __ctx?: AudioContext };
    class KeptContext extends Original { constructor(options?: AudioContextOptions) { super(options); w.__ctx = this; } }
    window.AudioContext = KeptContext as typeof AudioContext;
  });
  await setup(page, mkDoc([{ id: 'c1', type: 'audio', from: 0, to: 3000, sourceDuration: 3000 }]), { c1: TONE() }, 'T13 preview latency');
  await page.evaluate(async () => { const p = '/src/render/playback.ts'; (await import(p)).resetPlaybackStats(); });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor(); // a wait, not a gate: the one assertion is below
  await page.waitForTimeout(1000);
  const r = await page.evaluate(async () => {
    const p = '/src/render/playback.ts', a = '/src/audio/preview.ts', { playbackStats } = await import(p), { CHUNK_MS, SLACK_QUANTA } = await import(a);
    const ctx = (window as unknown as { __ctx?: AudioContext }).__ctx;
    const margin = ctx ? Math.min(Math.max((Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0) + SLACK_QUANTA * 128 / ctx.sampleRate, 0), CHUNK_MS / 2000) : NaN;
    return { baseLatency: ctx?.baseLatency ?? null, outputLatency: ctx?.outputLatency ?? null, sampleRate: ctx?.sampleRate ?? null, riskyStarts: playbackStats.riskyStarts as number, lateChunks: playbackStats.lateChunks as number, sounds: playbackStats.sounds as number, marginMs: ctx ? margin * 1000 : null };
  });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  console.log(`T13 preview latency: ${JSON.stringify(r)}`);
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(r) });
  expect(r.sounds, 'a clip\'s sound was mixed for the preview (the log describes a play that sounded)').toBeGreaterThanOrEqual(1);
});
