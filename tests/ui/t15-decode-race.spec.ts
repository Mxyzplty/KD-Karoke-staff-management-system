// SPDX-License-Identifier: AGPL-3.0-only
// T15 regression: concurrent decodeFrame calls for ONE source used to interleave inside decoder.worker.ts and return frames for the
// wrong time. Before the fix this spec failed forward 3/5, backward 3/4, scrub40 35/40 (implementer's run, 1 Nov).
// Formula oracle (the frame pick of findings part 5 §53.3.1): a 30 fps constant-rate clip from t = 0 has frame n at n/30 s, so the
// frame for source time ms is n = floor(ms x 30 / 1000 + 1e-6) (the 1e-6 absorbs float noise), and the frame a request returns must have
// a timestamp ts with round(ts x 30) = n. Repro: the implementer's scratch/t15-scrub-race.mjs in the epic scratch dir.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { makeClip } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the 10 s, 30 fps clip the decoder pool decodes');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); await page.goto('/'); });

const want = (ms: number) => Math.floor(ms * 30 / 1000 + 1e-6);
const scenarios: Record<string, number[]> = {
  forward: [1000, 1200, 1400, 1600, 1800],
  backward: [9000, 8000, 3000, 1000],
  scrub40: Array.from({ length: 40 }, (_, k) => ((k * 7919) % 9967) + 0.5),
};

for (const [name, times] of Object.entries(scenarios)) {
  test(`${name}: ${times.length} decodeFrame calls started together on one source each return the frame for their own time`, async ({ page }) => {
    const b64 = readFileSync(makeClip(10)).toString('base64');
    const got = await page.evaluate(async ({ b64, times }) => {
      const p = '/src/render/decoder-pool.ts', pool = await import(p);
      const bin = atob(b64), data = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const ref = { key: 'race', blob: new Blob([data], { type: 'video/mp4' }), rotation: 0 as const, stackedAlpha: false };
      pool.closeDecoderPool(); pool.dropFrames('race');
      const frames = await Promise.all(times.map(ms => pool.decodeFrame(ref, ms)));
      const out = frames.map((f: { ts: number }) => Math.round(f.ts * 30));
      pool.closeDecoderPool(); return out;
    }, { b64, times });
    const wrong = times.map((ms, k) => ({ ms, want: want(ms), got: got[k] })).filter(r => r.want !== r.got);
    expect(wrong, `${wrong.length} of ${times.length} requests returned the wrong frame`).toEqual([]);
  });
}
