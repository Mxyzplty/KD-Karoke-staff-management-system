// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { readBeats, subdivisions, snapCuts, planSilenceRemoval } from '../apps/web/src/analysis/helpers';
import { syncOffset } from '../apps/web/src/analysis/sync';
import { detectBeats } from '../apps/web/src/analysis/beats';
import { makeTranscript } from '../apps/web/src/analysis/transcript';
import { FootageIndex } from '../apps/web/src/analysis/search';
import { beatScore } from '../apps/web/src/analysis/tools/metrics';
import type { Rhythm, Transcript, SearchRequest } from '../apps/web/src/analysis/types';

/** Deterministic LCG so the hi-hat noise burst (and its jitter) is fixed across runs. */
function seededRandom(seed: number) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
}

/** Kick on every quarter note (the true beats) plus a hi-hat on every eighth, so the median onset
 * interval (~0.234s) falls below the 0.28s sparse/dense-grid switch in detectBeats. */
function denseMusic(rate: number, seconds: number, bpm: number) {
  const samples = new Float32Array(Math.round(rate * seconds));
  const beatInterval = 60 / bpm, eighthInterval = beatInterval / 2, rnd = seededRandom(7);
  const kickLen = Math.round(0.08 * rate), kickTau = 0.015 * rate, hatLen = Math.round(0.015 * rate), hatTau = 0.004 * rate;
  const trueBeats: number[] = [];
  for (let t = 0; t < seconds; t += beatInterval) {
    trueBeats.push(t);
    const at = Math.round(t * rate);
    for (let j = 0; j < kickLen && at + j < samples.length; j++) samples[at + j] += 0.8 * Math.sin(2 * Math.PI * 60 * j / rate) * Math.exp(-j / kickTau);
  }
  for (let t = 0; t < seconds; t += eighthInterval) {
    const at = Math.round((t + (rnd() - 0.5) * 0.01) * rate);
    for (let j = 0; j < hatLen && at + j >= 0 && at + j < samples.length; j++) samples[at + j] += 0.3 * (rnd() * 2 - 1) * Math.exp(-j / hatTau);
  }
  return { samples, trueBeats };
}

const rhythm: Rhythm = { bpm: 120, averageBpm: 120, beats: [[0, 1], [0.5, 0.4], [1, 0.8], [2, 1]], downbeats: [[0, 1], [2, 1]], silences: [[1.1, 1.9]] };
const transcript = (words: string[], offset = 0): Transcript => ({ language: 'en', languages: ['en'], total_duration: 10, segments: [{ id: 0, start: offset, end: offset + words.length, text: words.join(' '), speaker: 0, words: words.map((word, i) => ({ word, start: offset + i * 0.5, end: offset + i * 0.5 + 0.3 })) }] });

describe('beat and silence helpers', () => {
  it('returns distinct bounded and unbounded shapes and honors inclusive strength and exclusive end', () => {
    expect(readBeats(rhythm)).toEqual({ bpm: 120, firstDownbeat: 0 });
    expect(readBeats(rhythm, { from: 0.5, to: 2, minStrength: 0.4, divisionsPerBeat: 2 })).toEqual({ bpm: 120, firstDownbeat: 0, beats: [[0.5, 0.4], [1, 0.8]], downbeats: [], subdivisions: { divisionsPerBeat: 2, method: 'interpolated', timestamps: [0.75] } });
    expect(() => readBeats(rhythm, { from: 0 })).toThrow();
    expect(() => readBeats(rhythm, { from: 0, to: 1, minStrength: 1.1 })).toThrow();
  });
  it('interpolates only between beats outside silence and snaps at tolerance', () => {
    expect(subdivisions(rhythm, 4).timestamps).toEqual([0.125, 0.25, 0.375, 0.625, 0.75, 0.875]);
    expect(snapCuts([0.24, 1.5, 2.1], rhythm, 0.02, 4)).toEqual([{ index: 0, from: 0.24, to: 0.25, delta: 0.25 - 0.24 }]);
    expect(snapCuts([0.25], rhythm, 0)).toEqual([]);
  });
  it('unions overlapping selected ranges, preserves speech and retains the requested pause', () => {
    const words = [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 3, end: 3.5 }, { word: 'c', start: 4, end: 5 }];
    expect(planSilenceRemoval(words, [[1, 2.5], [2, 3]])).toEqual([[1.175, 2.825]]);
    expect(planSilenceRemoval(words, [[1, 1.75]])).toEqual([]);
    expect(() => planSilenceRemoval(words, [[1, 3]], 0.5, 0.6)).toThrow();
  });
});

describe('sync', () => {
  it('uses source minus target and normalizes case and punctuation', () => {
    const result = syncOffset(transcript(['Hello,', 'brave', 'world!', 'again'], 2), transcript(['hello', 'BRAVE', 'world', 'again'], 0.5));
    expect(result.offset).toBeCloseTo(1.5); expect(result.confidence).toBeGreaterThanOrEqual(0.5); expect(result.matches).toHaveLength(4);
  });
  it('refuses fewer than three consecutive matching words with typed confidence', () => {
    expect(() => syncOffset(transcript(['hello', 'world']), transcript(['hello', 'world']))).toThrowError(expect.objectContaining({ code: 'SYNC_LOW_CONFIDENCE', message: 'Low sync confidence (0%). Transcripts may not overlap enough.', details: { confidence: 0 } }));
  });
});

describe('synthetic audio', () => {
  it('gates asset kind before music and returns deterministic beat shapes on clicks', () => {
    const rate = 8000, samples = new Float32Array(rate * 6);
    for (let t = 0.5; t < 6; t += 0.5) for (let j = 0; j < 80; j++) samples[Math.round(t * rate) + j] = 0.8 * Math.exp(-j / 20);
    const pcm = { sampleRate: rate, channels: 1, data: [samples] };
    expect(() => detectBeats(pcm, 'video', true, 'clip')).toThrowError(expect.objectContaining({ code: 'BEATS_NOT_AUDIO' }));
    expect(() => detectBeats(pcm, 'audio', false, 'clip')).toThrowError(expect.objectContaining({ code: 'BEATS_NOT_MUSIC' }));
    const result = detectBeats(pcm, 'audio', true);
    expect(detectBeats(pcm, 'audio', true)).toEqual(result);
    expect(result.stored.bpm).toBeCloseTo(120, 0); expect(result.stored.beats.length).toBeGreaterThanOrEqual(10);
    const truth = Array.from({ length: 11 }, (_, i) => 0.5 + i * 0.5);
    for (const [tolerance, minimum] of [[0.07, 0.95], [0.02, 0.85]]) {
      const actual = result.stored.beats.map(([time]) => time), used = new Set<number>();
      let matches = 0;
      for (const time of truth) {
        const i = actual.findIndex((value, index) => !used.has(index) && Math.abs(value - time) <= tolerance);
        if (i >= 0) { used.add(i); matches++; }
      }
      expect(2 * matches / (truth.length + actual.length)).toBeGreaterThanOrEqual(minimum);
    }
    expect(result.tab.beats).toEqual(result.stored.beats);
    expect(result.stored.beats.every(([t, s]) => t >= 0 && t <= 6 && s >= 0 && s <= 1)).toBe(true);
  });
  it('switches to the dense-music grid tracker on a 128 BPM kick+hat pattern', () => {
    const rate = 16000, bpm = 128, seconds = 20;
    const { samples, trueBeats } = denseMusic(rate, seconds, bpm);
    const pcm = { sampleRate: rate, channels: 1, data: [samples] };
    const result = detectBeats(pcm, 'audio', true);
    expect(detectBeats(pcm, 'audio', true)).toEqual(result);
    expect(result.stored.bpm).not.toBeNull();
    expect(Math.abs(result.stored.bpm! - bpm) / bpm).toBeLessThanOrEqual(0.01);
    expect(result.stored.beats.every(([t, s]) => t > 0 && s > 0 && s <= 1)).toBe(true);
    const times = result.stored.beats.map(([t]) => t);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    const score = beatScore(trueBeats, times, 0.07);
    expect(score.f).toBeGreaterThanOrEqual(0.95);
  });
  it('keeps the sparse onset-interval tracker unchanged on isolated 90 BPM clicks', () => {
    const rate = 8000, bpm = 90, interval = 60 / bpm, seconds = 8;
    const samples = new Float32Array(rate * seconds), trueBeats: number[] = [];
    for (let t = 0.5; t < seconds; t += interval) {
      trueBeats.push(t);
      const at = Math.round(t * rate);
      for (let j = 0; j < 80 && at + j < samples.length; j++) samples[at + j] = 0.8 * Math.exp(-j / 20);
    }
    const pcm = { sampleRate: rate, channels: 1, data: [samples] };
    const result = detectBeats(pcm, 'audio', true);
    expect(Math.abs(result.stored.bpm! - bpm) / bpm).toBeLessThanOrEqual(0.01);
    const score = beatScore(trueBeats, result.stored.beats.map(([t]) => t), 0.07);
    expect(score.f).toBe(1);
  });
  it('retains word punctuation and speaker-per-segment on a 20ms grid', () => {
    const result = makeTranscript([{ text: ' Hello,', timestamp: [0.011, 0.209] }, { text: ' world!', timestamp: [0.21, 0.49] }, { text: ' Again.', timestamp: [0.72, 0.99] }], new Float32Array(16000), 1, 'en');
    expect(result.language).toBe('en'); expect(result.languages).toEqual(['en']);
    expect(result.segments.map(s => s.text)).toEqual(['Hello, world!', 'Again.']);
    expect(result.segments[0].words).toEqual([{ word: 'Hello,', start: 0.02, end: 0.2 }, { word: 'world!', start: 0.22, end: 0.5 }]);
    expect(result.segments.every(s => Number.isInteger(s.speaker))).toBe(true);
    expect(() => makeTranscript([{ text: 'bad', timestamp: [null, 1] }], new Float32Array(16000), 1, 'en')).toThrowError(expect.objectContaining({ code: 'TRANSCRIPTION_FAILED' }));
  });
  it('drops a hallucinated zero-duration sentence but keeps a normal one beside it', () => {
    const result = makeTranscript([
      { text: ' a', timestamp: [0.5, 0.5] }, { text: ' b', timestamp: [0.52, 0.52] },
      { text: ' c', timestamp: [0.54, 0.54] }, { text: ' d', timestamp: [0.56, 0.56] },
      { text: ' Hello', timestamp: [1.1, 1.3] }, { text: ' world', timestamp: [1.34, 1.54] },
    ], new Float32Array(16000 * 3), 3, 'en');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe('Hello world');
    expect(result.segments[0].words).toEqual([{ word: 'Hello', start: 1.1, end: 1.3 }, { word: 'world', start: 1.34, end: 1.54 }]);
    expect(Number.isInteger(result.segments[0].speaker)).toBe(true);
  });
});

describe('local footage index', () => {
  it('retains the threshold boundary, orders filename first, filters and removes', async () => {
    const vectors: Record<string, number[]> = { query: [1, 0], boundary: [0.35, Math.sqrt(1 - 0.35 ** 2)], below: [0.349, Math.sqrt(1 - 0.349 ** 2)], strong: [0.8, 0.6] };
    const index = new FootageIndex(async texts => texts.map(t => vectors[t] ?? [0, 1]));
    await index.add({ id: 'a', filename: 'QUERY.mp4', type: 'video', duration: 10, projectIds: ['p'] }, { width: 1, height: 1, aspectRatio: 1, tags: [], summary: '', segments: [{ start: 0, end: 1, description: 'boundary' }, { start: 5, end: 6, description: 'below' }] }, transcript(['strong']));
    await index.add({ id: 'b', filename: 'other.wav', type: 'audio', duration: 10, projectIds: ['q'] }, { width: 1, height: 1, aspectRatio: 1, tags: [], summary: 'strong', segments: [] }, null);
    const request: SearchRequest = { query: 'query', projectId: 'p', mode: 'general', options: { threshold: 'medium', limit: 20, assetType: 'video' } };
    const medium = await index.search(request);
    expect(medium.results[0]).toMatchObject({ assetId: 'a', source: 'filename' });
    expect(medium.results.some(r => r.chunkText === 'boundary')).toBe(true);
    expect(medium.results.some(r => r.chunkText === 'below')).toBe(false);
    expect(medium.results.find(r => r.chunkText === 'strong')?.surroundingContext).toContainEqual(expect.objectContaining({ type: 'transcript', text: 'strong' }));
    const low = await index.search({ ...request, options: { ...request.options, threshold: 'low' } });
    const high = await index.search({ ...request, options: { ...request.options, threshold: 'high' } });
    expect(low.metadata.totalResults).toBeGreaterThanOrEqual(medium.metadata.totalResults); expect(medium.metadata.totalResults).toBeGreaterThanOrEqual(high.metadata.totalResults);
    index.remove('a'); expect((await index.search(request)).results).toEqual([]);
  });
});
