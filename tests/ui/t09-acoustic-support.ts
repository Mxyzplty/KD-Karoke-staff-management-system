// SPDX-License-Identifier: AGPL-3.0-only
// CT-11 ground truth, independent of captions: PCM RMS windows identify isolated spoken-word bounds before export.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TTS } from './t09-acoustic-source';
export const RATE = 48000, FPS = 30, LENGTH = 120;
export type Bound = { sample: number; uncertaintySamples: number; low: number; high: number };
export function measuredWords() {
  return TTS.words.map(w => {
    const bytes = inflateSync(Buffer.from(w.zlibBase64, 'base64'));
    if (createHash('sha256').update(bytes).digest('hex') !== w.sha256 || bytes.length !== w.samples * 2) throw new Error('CT-11 source PCM hash mismatch');
    const pcm = Float32Array.from({ length: w.samples }, (_, n) => bytes.readInt16LE(2 * n) / 32768);
    const rms = Array.from({ length: Math.ceil(pcm.length / 48) }, (_, n) => { let v = 0; for (let j = n * 48; j < Math.min(pcm.length, (n + 1) * 48); j++) v += pcm[j] ** 2; return Math.sqrt(v / 48); });
    const bounds = [3, 6, 12].map(level => { const voiced = rms.flatMap((v, n) => v >= level / 32768 ? [n] : []); if (!voiced.length) throw new Error('No measurable speech'); return { start: voiced[0] * 48, end: (voiced.at(-1)! + 1) * 48 }; });
    const bound = (key: 'start' | 'end'): Bound => { const low = Math.min(...bounds.map(b => b[key])) - 48, high = Math.max(...bounds.map(b => b[key])) + 48; return { sample: (low + high) / 2, uncertaintySamples: (high - low) / 2, low, high }; };
    return { text: w.text, pcm, sha256: w.sha256, onset: bound('start'), end: bound('end'), thresholds: bounds };
  });
}
export function acousticFixture() {
  const measured = measuredWords(), pcm = new Float32Array(RATE * LENGTH), words: { text: string; start: number; end: number; onsetUncertaintyMs: number; endUncertaintyMs: number }[] = [], claps: number[] = [];
  for (let cycle = 0; cycle < 12; cycle++) {
    for (const [n, w] of [measured[0], measured[1], measured[0]].entries()) {
      // Fixture scheduling occurs before the export. Put both independently measured bounds away from a frame edge,
      // so the measurement uncertainty fits inside the one-frame bound; no output-derived delay adjustment is used.
      let offset = -1;
      const target = Math.round((cycle * 10 + [.5, 4.8, 9.2][n]) * RATE);
      for (let phase = 0; phase < RATE / FPS; phase++) {
        const at = target + phase - w.onset.sample;
        const error = (b: Bound) => Math.ceil((at + b.sample) / (RATE / FPS)) * (RATE / FPS) - (at + b.sample) + b.uncertaintySamples;
        if (error(w.onset) <= RATE / FPS && error(w.end) <= RATE / FPS && w.onset.uncertaintySamples < RATE / FPS && w.end.uncertaintySamples < RATE / FPS) { offset = Math.round(at); break; }
      }
      if (offset < 0) throw new Error(`${w.text}: acoustic uncertainty cannot fit the one-frame bound`);
      for (let j = 0; j < w.pcm.length && offset + j < pcm.length; j++) pcm[offset + j] += w.pcm[j];
      words.push({ text: w.text, start: (offset + w.onset.sample) / RATE, end: (offset + w.end.sample) / RATE, onsetUncertaintyMs: w.onset.uncertaintySamples / RATE * 1000, endUncertaintyMs: w.end.uncertaintySamples / RATE * 1000 });
    }
    const at = Math.round((cycle * 10 + .25) * RATE); claps.push(at / RATE);
    // A 5 ms controlled broadband impulse; source samples are known, separate from the spoken-word measurement.
    for (let j = 0; j < 240; j++) pcm[at + j] = ((j * 73 % 127) > 63 ? 1 : -1) * .9 * (1 - j / 240);
  }
  claps.push(119.85);
  for (let j = 0; j < 240; j++) pcm[Math.round(119.85 * RATE) + j] = ((j * 73 % 127) > 63 ? 1 : -1) * .9 * (1 - j / 240);
  const data = Buffer.alloc(pcm.length * 2); pcm.forEach((v, n) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), n * 2));
  const wav = Buffer.alloc(44 + data.length); wav.write('RIFF'); wav.writeUInt32LE(36 + data.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(data.length, 40); data.copy(wav, 44);
  const dir = path.join(tmpdir(), 'cutframe-t09-acoustic'); mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'controlled-speech-claps-120s.wav'); writeFileSync(file, wav);
  return { file, pcmSha256: createHash('sha256').update(data).digest('hex'), words, claps, measured: measured.map(({ pcm: _p, ...w }) => w), voice: TTS.voice, sampleRate: RATE };
}
