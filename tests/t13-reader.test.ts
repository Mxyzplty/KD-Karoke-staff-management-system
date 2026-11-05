// SPDX-License-Identifier: AGPL-3.0-only
// T13 source readers (audio/reader.ts, review M1): which files take Mediabunny's block reader, which take the whole-file WASM decode (T14's
// decodeAudio, stubbed here: it needs the browser's libav worker), and which have no sound. Inputs are made by ffmpeg: an AVI and raw AC-3 /
// E-AC-3 (containers Mediabunny cannot open; the base preview decoded them whole), a WAV (Mediabunny reads it), a video-only MP4 (a
// recognised container with no audio track). Oracle: the base's rule (findings §1b decode order) and the review's fix list, not the code.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { RawAudio } from '../apps/web/src/media/decode';
import { cachedReader, openReader } from '../apps/web/src/audio/reader';
import type { Reader } from '../apps/web/src/audio/reader';
import { haveFfmpeg } from './t13-support';

const dir = path.join(tmpdir(), 'cutframe-t13-reader');
/** ffmpeg output `name` from the arguments between the inputs and the output; made once per run. */
function make(name: string, args: string[]): Blob {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name), r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, out]);
  if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr?.toString().slice(-300)}`);
  return new Blob([readFileSync(out)]);
}
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2'];
const picture = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2'];
/** A stand-in for the WASM whole-file decode: records its calls, returns a known stereo signal or rejects. */
function stubWhole(fail?: Error) {
  const calls: Blob[] = [];
  const whole = async (blob: Blob): Promise<RawAudio> => {
    calls.push(blob);
    if (fail) throw fail;
    return { sampleRate: 44100, channels: 2, data: [new Float32Array(44100).fill(0.25), new Float32Array(44100).fill(-0.25)], source: 'wasm' };
  };
  return { calls, whole };
}

describe.skipIf(!haveFfmpeg())('which reader a file takes', () => {
  for (const [name, args] of [
    ['AVI (mpeg4 + mp3)', [...picture, ...tone, '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', '-f', 'avi']],
    ['raw AC-3', [...tone, '-c:a', 'ac3', '-ac', '2', '-f', 'ac3']],
    ['raw E-AC-3', [...tone, '-c:a', 'eac3', '-ac', '2', '-f', 'eac3']],
  ] as const) it(`${name}: Mediabunny cannot open it, so the whole-file WASM decode plays it (not silence)`, async () => {
    const file = make(`${name.replace(/\W+/g, '-')}.bin`, [...args]), { calls, whole } = stubWhole();
    const reader = await openReader(file, false, whole);
    expect(reader, 'a reader, not "no sound"').not.toBeNull();
    expect(calls).toHaveLength(1);
    const native = await reader!.block(0);
    expect(native).toMatchObject({ rate: 44100, first: 0 });
    expect(native!.data[0][100]).toBe(0.25); expect(native!.data[1][100]).toBe(-0.25);
    expect(await reader!.block(3), 'every block reads the one whole decode').toBe(native);
    expect(calls).toHaveLength(1);
  });
  it('WAV: Mediabunny reads it in blocks; the whole decode is not used', async () => {
    const file = make('tone.wav', [...tone, '-c:a', 'pcm_s16le', '-ac', '2']), { calls, whole } = stubWhole();
    const reader = await openReader(file, false, whole);
    expect(reader).not.toBeNull();
    const native = (await reader!.block(0))!;
    expect(calls).toHaveLength(0);
    expect(native.rate).toBe(48000); expect(native.data).toHaveLength(2);
    let peak = 0; for (const x of native.data[0].subarray(0, 48000)) peak = Math.max(peak, Math.abs(x));
    expect(peak, 'the tone is there (ffmpeg sine: amplitude 1/8, −3 dB per side after the stereo up-mix)').toBeGreaterThan(0.05);
    reader!.dispose();
  });
  it('the forced WASM switch takes the whole decode even for a file Mediabunny reads', async () => {
    const file = make('tone.wav', [...tone, '-c:a', 'pcm_s16le', '-ac', '2']), { calls, whole } = stubWhole();
    expect(await openReader(file, true, whole)).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
  it('a recognised container with no audio track has no sound (null), without a decode', async () => {
    const file = make('picture-only.mp4', [...picture, '-c:v', 'mpeg4', '-an']), { calls, whole } = stubWhole();
    expect(await openReader(file, false, whole)).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it('a failed whole decode rejects (the export reports it), it is not silence', async () => {
    const file = make('raw.ac3', [...tone, '-c:a', 'ac3', '-ac', '2', '-f', 'ac3']), { whole } = stubWhole(new Error('DECODE_ERROR: The audio could not be decoded'));
    await expect(openReader(file, false, whole)).rejects.toThrow('could not be decoded');
  });
});

describe('the reader cache', () => {
  const reader: Reader = { block: async () => null, dispose() {} };
  it('a rejected open is not kept: a transient error, then a retry that opens', async () => {
    const cache = new Map<string, Promise<Reader | null>>();
    let opens = 0;
    const open = async () => { opens++; if (opens === 1) throw new Error('NotReadableError: the file could not be read'); return reader; };
    await expect(cachedReader(cache, 'asset-1', open)).rejects.toThrow('could not be read');
    await Promise.resolve();
    expect(cache.has('asset-1'), 'the failed open is dropped').toBe(false);
    expect(await cachedReader(cache, 'asset-1', open)).toBe(reader);
    expect(await cachedReader(cache, 'asset-1', open), 'then kept').toBe(reader);
    expect(opens).toBe(2);
  });
  it('a file with no sound is kept as no sound (null is an answer, not a failure)', async () => {
    const cache = new Map<string, Promise<Reader | null>>();
    let opens = 0;
    const open = async () => { opens++; return null; };
    expect(await cachedReader(cache, 'asset-2', open)).toBeNull();
    expect(await cachedReader(cache, 'asset-2', open)).toBeNull();
    expect(opens).toBe(1);
  });
});
