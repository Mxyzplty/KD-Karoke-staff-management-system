// SPDX-License-Identifier: AGPL-3.0-only
// T13 audit F2 (OQ2 in the T13 audio notes): block 0 of an MP4 / AAC source must start with the sound at source t = 0, not a cold decoder.
// audio/reader.ts reads block 0 from 0 and skips the AAC priming packet (before 0), so about 11 ms are near-silent. A browser check, because
// the defect is on the WebCodecs path: in Node there is no AudioDecoder, so Mediabunny's canDecode() is false and the reader takes the
// whole-file decode instead. The input is a 400 Hz tone at 0.2 from source 0, made by ffmpeg; the expected samples are ffmpeg's own decode of
// that file from frame 0, never the reader's. Skips with a visible reason without ffmpeg.
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareAudio } from '../../apps/web/src/audio/oracle';
import { ffmpegAvailable } from '../media-fixtures';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the MP4 / AAC tone and the reference decode');

const dir = path.join(tmpdir(), 'cutframe-t13-reader-aac');
const HEAD = 24000; // the first 0.5 s
/** A 2 s mono MP4 / AAC: 400 Hz at amplitude 0.2, starting at source 0. */
function makeTone(): string {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'tone-400-aac.mp4');
  if (!existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*400*t):s=48000:d=2', '-ac', '1', '-c:a', 'aac', '-b:a', '192k', out]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  return out;
}
/** ffmpeg's decode of the same file, 48 kHz mono float from frame 0 (its decoder drops the priming by the file's edit list). */
function referenceDecode(file: string): Float32Array {
  const raw = path.join(dir, 'tone-400-aac-48k.f32');
  if (!existsSync(raw)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ar', '48000', '-ac', '1', '-f', 'f32le', raw]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  const b = readFileSync(raw); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}
const firstAbove = (s: ArrayLike<number>, level: number) => { for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > level) return i; return -1; };

test('F2: block 0 of an MP4 / AAC source equals ffmpeg\'s decode from frame 0, its first 20 ms included', async ({ page }) => {
  const file = makeTone(), ref = referenceDecode(file);
  expect(firstAbove(ref, 0.05), 'the reference holds the tone from its start').toBeGreaterThanOrEqual(0);
  await page.goto('/');
  const got = await page.evaluate(async ({ b64, head }) => {
    const r = '/src/audio/reader.ts'; const { openReader } = await import(r);
    const bin = atob(b64), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    let whole = 0;
    const reader = await openReader(new Blob([data], { type: 'audio/mp4' }), false, async () => { whole++; throw new Error('whole decode used'); });
    if (!reader) return { error: 'no reader (no sound)' } as const;
    const block = await reader.block(0); reader.dispose();
    if (!block) return { error: 'block 0 is null' } as const;
    return { whole, rate: block.rate as number, first: block.first as number, channels: block.data.length as number, head: Array.from((block.data[0] as Float32Array).subarray(0, head)) };
  }, { b64: readFileSync(file).toString('base64'), head: HEAD });
  if ('error' in got) throw new Error(got.error);
  // the precondition: Mediabunny's WebCodecs path took the AAC track (the whole-file decode keeps the pre-roll and would pass for the wrong reason)
  expect(got.whole, 'the whole-file decode was not used: Mediabunny decodes the AAC track').toBe(0);
  expect(got.rate).toBe(48000); expect(got.first).toBe(0); expect(got.channels).toBe(1);
  const test0 = Float32Array.from(got.head), ref0 = ref.subarray(0, HEAD);
  const at = firstAbove(test0, 0.05), refAt = firstAbove(ref0, 0.05);
  console.log(`T13 F2 AAC block 0: first sample above 0.05 at frame ${at}, ffmpeg ${refAt}`);
  expect(Math.abs(at - refAt), `first sample above 0.05: block 0 frame ${at}, ffmpeg frame ${refAt} (within 1 ms = 48 frames)`).toBeLessThanOrEqual(48);
  // the master plan's audio oracle over the first 0.5 s with nothing left out: lag, level, peak and residual
  const cmp = compareAudio([ref0, ref0], [test0, test0], { maxLagMs: 2 });
  console.log(`T13 F2 AAC block 0 vs ffmpeg: ${JSON.stringify(cmp)}`);
  expect(Math.abs(cmp.lagMs), 'lag ms').toBeLessThanOrEqual(0.02);
  expect(Math.abs(cmp.gainDb), 'gain dB').toBeLessThanOrEqual(0.1);
  expect(Math.abs(cmp.peakDb), 'peak dB').toBeLessThanOrEqual(0.1);
  expect(cmp.residualDb, 'residual dBFS over the first 0.5 s, the first 20 ms included').toBeLessThanOrEqual(-50);
});
