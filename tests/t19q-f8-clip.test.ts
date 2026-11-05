// SPDX-License-Identifier: AGPL-3.0-only
// T19q round F8: the CLIP visual search channel. Model-free: every embedder is a stub, no model is loaded.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_MODELS, modelAvailability } from '../apps/web/src/analysis/availability';
import { AnalysisEngine } from '../apps/web/src/analysis/engine';
import { FootageIndex, SEARCH_THRESHOLDS, VISUAL_THRESHOLD, visualCalibration } from '../apps/web/src/analysis/search';
import type { AssetInput, Frame, SearchRequest, Transcript, VisualAnalysis } from '../apps/web/src/analysis/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Dyadic thresholds make "a row at exactly the threshold" exact in floating point: 0.25 + 0.5 - 0.5 === 0.25.
const THRESHOLDS = { low: 0.125, medium: 0.25, high: 0.5 };
const VISUAL_MEDIUM = 0.5;
const asset = (id: string): AssetInput => ({ id, filename: `${id}.mp4`, type: 'video', duration: 10 });
const search = (index: FootageIndex, threshold: SearchRequest['options']['threshold'], query = 'dog') => index.search({ query, mode: 'general', options: { threshold, limit: 50 } });

/** Text space is 3-D: the query is [1,0,0]; a chunk text is looked up, anything else is orthogonal to the query. */
const textVector = (cos: number) => [cos, Math.sqrt(1 - cos ** 2), 0];
function textEmbedder(table: Record<string, number[]>) {
  return vi.fn(async (texts: string[]) => texts.map(t => (t === 'dog' ? [1, 0, 0] : table[t] ?? [0, 0, 1])));
}
/** CLIP space is 4-D: the query's image-text vector is [1,0,0,0]; an image vector has the given cosine with it. */
const imageVector = (cos: number) => [cos, Math.sqrt(1 - cos ** 2), 0, 0];
function visualChannel(medium = VISUAL_MEDIUM) {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0, 0]));
  return { embed, medium };
}
const analysis = (segments: VisualAnalysis['segments'], extra: Partial<VisualAnalysis> = {}): VisualAnalysis => ({ width: 4, height: 4, aspectRatio: 1, tags: [], summary: '', segments, ...extra });
const described = (description: string, vector?: number[], start = 0, end = 2) => ({ start, end, description, ...(vector ? { vector } : {}) });
const sims = (response: Awaited<ReturnType<typeof search>>) => response.results.map(r => r.similarity);

describe('T19q F8 merged score (text cosine vs text medium + visual cosine - visual medium)', () => {
  it('the text score wins when it is higher; the visual score wins when it is higher', async () => {
    const embed = textEmbedder({ 'text wins': textVector(0.8), 'visual wins': textVector(0.3) });
    const index = new FootageIndex(embed, THRESHOLDS, visualChannel());
    await index.add(asset('a1'), analysis([described('text wins', imageVector(0.5), 0, 2), described('visual wins', imageVector(0.9), 4, 6)]), null);
    const { results } = await search(index, 'low');
    const byText = Object.fromEntries(results.map(r => [r.chunkText, r.similarity]));
    expect(byText['text wins']).toBeCloseTo(0.8, 12);
    // 0.25 (text medium) + 0.9 (visual cosine) - 0.5 (visual medium)
    expect(byText['visual wins']).toBeCloseTo(0.65, 12);
    expect(results).toHaveLength(2);
  });

  it('at the visual medium the frame scores exactly the text medium', async () => {
    const index = new FootageIndex(textEmbedder({}), THRESHOLDS, visualChannel());
    await index.add(asset('a1'), analysis([described('frame', [1, 1, 1, 1])]), null); // cosine with [1,0,0,0] is exactly 0.5
    expect(sims(await search(index, 'medium'))).toEqual([0.25]);
  });
});

describe('T19q F8 one row per segment', () => {
  it('a segment that passes on text and on visual gives one row with the higher score and no image / vector keys', async () => {
    const index = new FootageIndex(textEmbedder({ both: textVector(0.6) }), THRESHOLDS, visualChannel());
    await index.add(asset('a1'), analysis([described('both', imageVector(0.9))]), null);
    const response = await search(index, 'low');
    const rows = response.results.filter(r => r.embeddingType === 'description');
    expect(rows).toHaveLength(1);
    expect(response.results).toHaveLength(1);
    expect(response.metadata).toEqual({ totalResults: 1, sources: { filename: 0, embedding: 1 } });
    expect(rows[0].similarity).toBeCloseTo(0.65, 12);
    expect(rows[0]).not.toHaveProperty('image');
    expect(rows[0]).not.toHaveProperty('vector');
    expect(rows[0]).toMatchObject({ assetId: 'a1', chunkText: 'both', startTime: 0, endTime: 2, source: 'embedding' });
  });

  it('a segment that passes on text alone keeps its text score, and rows from a segment without a vector carry no image key', async () => {
    const index = new FootageIndex(textEmbedder({ plain: textVector(0.7) }), THRESHOLDS, visualChannel());
    await index.add(asset('a1'), analysis([described('plain')]), null);
    const { results } = await search(index, 'low');
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBeCloseTo(0.7, 12);
    expect(Object.keys(results[0])).not.toEqual(expect.arrayContaining(['image']));
    expect(results[0]).not.toHaveProperty('vector');
  });
});

describe('T19q F8 visual threshold gating', () => {
  const index = async (vector: number[], thresholds = THRESHOLDS, channel = visualChannel()) => {
    const footage = new FootageIndex(textEmbedder({}), thresholds, channel);
    await footage.add(asset('a1'), analysis([described('frame', vector)]), null);
    return footage;
  };

  it('at medium: a visual cosine just below the visual medium does not pass; exactly at it does (the row is kept)', async () => {
    expect((await search(await index([1, 1, 1, 1.001]), 'medium')).results).toEqual([]); // cosine 0.49994 < 0.5
    const at = await search(await index([1, 1, 1, 1]), 'medium'); // cosine exactly 0.5
    expect(at.results).toHaveLength(1);
    expect(at.results[0].similarity).toBe(THRESHOLDS.medium);
  });

  it.each([
    ['low', 0.375, 0.39, 0.36],
    ['medium', 0.5, 0.51, 0.49],
    ['high', 0.75, 0.76, 0.74],
  ] as const)('%s shifts the visual cutoff by the same offset (visual cosine %d)', async (threshold, _cutoff, above, below) => {
    expect((await search(await index(imageVector(above)), threshold)).results).toHaveLength(1);
    expect((await search(await index(imageVector(below)), threshold)).results).toEqual([]);
  });

  it('with the real constants: SEARCH_THRESHOLDS.medium and VISUAL_THRESHOLD put the cutoff at visual cosine .25', async () => {
    expect(VISUAL_THRESHOLD).toBe(0.25);
    const channel = { ...visualChannel(), medium: VISUAL_THRESHOLD };
    expect((await search(await index(imageVector(0.26), SEARCH_THRESHOLDS, channel), 'medium')).results).toHaveLength(1);
    expect((await search(await index(imageVector(0.24), SEARCH_THRESHOLDS, channel), 'medium')).results).toEqual([]);
  });
});

describe('T19q F8 query text and when the visual embedder runs', () => {
  it('is called once per search with exactly the trimmed query in the photo template, however many chunks carry an image', async () => {
    const channel = visualChannel();
    const index = new FootageIndex(textEmbedder({}), THRESHOLDS, channel);
    await index.add(asset('a1'), analysis([described('one', imageVector(0.9), 0, 2), described('two', imageVector(0.9), 4, 6)]), null);
    await index.add(asset('a2'), analysis([described('three', imageVector(0.9))]), null);
    expect(channel.embed).not.toHaveBeenCalled(); // indexing never touches CLIP text
    await index.search({ query: '  dog  ', mode: 'general', options: { threshold: 'low', limit: 10 } });
    expect(channel.embed).toHaveBeenCalledTimes(1);
    expect(channel.embed).toHaveBeenCalledWith(['a photo of dog.']);
    await search(index, 'low');
    expect(channel.embed).toHaveBeenCalledTimes(2);
  });

  it('is not called when no indexed chunk has an image (no vector, or no analysis at all)', async () => {
    const channel = visualChannel();
    const index = new FootageIndex(textEmbedder({ plain: textVector(0.7) }), THRESHOLDS, channel);
    await index.add(asset('a1'), analysis([described('plain')]), null);
    await index.add(asset('a2'), null, null);
    expect(sims(await search(index, 'low'))).toHaveLength(1);
    expect(channel.embed).not.toHaveBeenCalled();
  });

  it('is not called when the index has no visual channel; the text-only score stands', async () => {
    const index = new FootageIndex(textEmbedder({ plain: textVector(0.3) }), THRESHOLDS);
    await index.add(asset('a1'), analysis([described('plain', imageVector(0.99))]), null);
    const { results } = await search(index, 'low');
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBeCloseTo(0.3, 12);
  });

  it('tags, summary and transcript chunks never get a visual score', async () => {
    const channel = visualChannel();
    const transcript: Transcript = { language: 'en', languages: ['en'], total_duration: 10, segments: [{ id: 0, start: 0, end: 2, text: 'spoken line', speaker: 0, words: [{ word: 'spoken', start: 0, end: 1 }, { word: 'line', start: 1, end: 2 }] }] };
    // Every non-description text is orthogonal to the query; a visual score would be 0.25 + 1 - 0.5 = 0.75 there.
    const index = new FootageIndex(textEmbedder({}), THRESHOLDS, channel);
    await index.add(asset('a1'), analysis([described('frame', imageVector(0.4))], { tags: ['beach', 'sun'], summary: 'a sunny beach' }), transcript);
    const { results } = await search(index, 'low');
    // frame: 0.25 + 0.4 - 0.5 = 0.15 >= low 0.125; nothing else passes.
    expect(results.map(r => r.embeddingType)).toEqual(['description']);
    expect(results[0].similarity).toBeCloseTo(0.15, 12);
    expect(channel.embed).toHaveBeenCalledTimes(1);
  });
});

describe('T19q F8 visualCalibration grid', () => {
  it('returns the first of .15, .16, ..., .40 strictly above the input, or null past the end', () => {
    expect(visualCalibration(0.248)).toBe(0.25);
    expect(visualCalibration(0.25)).toBe(0.26);
    expect(visualCalibration(0.1)).toBe(0.15);
    expect(visualCalibration(0.15)).toBe(0.16);
    expect(visualCalibration(0.399)).toBe(0.4);
    expect(visualCalibration(0.4)).toBeNull();
    expect(visualCalibration(0.5)).toBeNull();
    expect(visualCalibration(-1)).toBe(0.15);
  });

  it('every grid value is an exact 2-decimal number, and walking the grid visits all 26 values in order', () => {
    const seen: number[] = [];
    for (let g = visualCalibration(-1); g !== null; g = visualCalibration(g)) seen.push(g);
    expect(seen).toHaveLength(26);
    seen.forEach((g, i) => { expect(g).toBe(Number(g.toFixed(2))); expect(g).toBe(Number(((15 + i) / 100).toFixed(2))); });
    expect(seen[0]).toBe(0.15); expect(seen.at(-1)).toBe(0.4);
  });
});

describe('T19q F8 availability: analysis needs CLIP', () => {
  const ids = { vision: 'vis', clip: 'clp', sound: 'snd', vad: 'vad', whisper: 'wsp', aligner: 'ali', speaker: 'spk', embedding: 'emb' };
  const json = () => new Response(JSON.stringify({ model_type: 'x' }), { headers: { 'content-type': 'application/json' } });
  const none = () => new Response('Not found', { status: 404 });
  function probe(responses: Record<string, () => Response> = {}) {
    vi.stubGlobal('location', new URL('http://localhost:4173/app'));
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => { const url = String(input); calls.push(url); return (responses[url.split('/').at(-2)!] ?? json)(); }) as unknown as typeof fetch;
    return { calls, fetcher };
  }

  it('analysis is declared as vision + clip', () => { expect(CAPABILITY_MODELS.analysis).toEqual(['vision', 'clip']); });

  it('both vision and clip present → analysis true, and clip is probed at its config.json', async () => {
    const { calls, fetcher } = probe();
    expect((await modelAvailability('/models/', ids, fetcher)).analysis).toBe(true);
    expect(calls).toContain('http://localhost:4173/models/clp/config.json');
  });

  it('a missing clip makes only analysis false', async () => {
    const result = await modelAvailability('/models/', ids, probe({ clp: none }).fetcher);
    expect(result).toEqual({ analysis: false, transcription: true, embeddings: true, beats: true });
  });

  it('a missing vision with clip present is still false', async () => {
    expect((await modelAvailability('/models/', ids, probe({ vis: none }).fetcher)).analysis).toBe(false);
  });

  it('ids without a clip key keep the old behaviour: analysis follows vision only', async () => {
    const { clip: _clip, ...withoutClip } = ids;
    const { calls, fetcher } = probe();
    expect((await modelAvailability('/models/', withoutClip, fetcher)).analysis).toBe(true);
    expect(calls.some(u => u.includes('/clp/'))).toBe(false);
    expect((await modelAvailability('/models/', withoutClip, probe({ vis: none }).fetcher)).analysis).toBe(false);
    expect((await modelAvailability('/models/', { vision: 'vis' }, probe().fetcher)).analysis).toBe(true);
  });
});

describe('T19q F8 AnalysisEngine.attachImageVectors', () => {
  it("gives each segment the vector of the first frame at or after its start, from frames sorted by time", async () => {
    const frame = (timestamp: number): Frame => ({ timestamp, width: 1, height: 1, data: new Uint8ClampedArray(4) });
    const engine = Object.create(AnalysisEngine.prototype) as AnalysisEngine;
    const imageVectorStub = vi.fn(async (f: Frame) => [f.timestamp]);
    (engine as unknown as { models: { imageVector: typeof imageVectorStub } }).models = { imageVector: imageVectorStub };
    const result = await engine.attachImageVectors([frame(4.5), frame(0.5), frame(2.5)], analysis([described('a', undefined, 0, 2), described('b', undefined, 2.5, 4), described('c', undefined, 2.6, 6), described('d', undefined, 1, 2)]));
    expect(result.segments.map(s => s.vector)).toEqual([[0.5], [2.5], [4.5], [2.5]]);
    expect(imageVectorStub).toHaveBeenCalledTimes(4);
  });
});

describe('T19q F8 through a real AnalysisEngine (only the local-model methods are stubbed)', () => {
  // Four frames, two captions: describe() merges them into [0, 3.5) 'sunny beach' and [3.5, 10) 'dark room'.
  const frame = (timestamp: number): Frame => ({ timestamp, width: 1, height: 1, data: new Uint8ClampedArray(4) });
  const captions: Record<number, string> = { 0.5: 'sunny beach', 2.5: 'sunny beach', 4.5: 'dark room', 6.5: 'dark room' };
  // The first frame of the beach segment matches the query's CLIP vector [1,0,0,0] at cosine .9; every other frame is orthogonal to it.
  const frameVectors: Record<number, number[]> = { 0.5: imageVector(0.9), 2.5: [0, 0, 1, 0], 4.5: [0, 0, 0, 1], 6.5: [0, 0, 0, 1] };
  function stubbedEngine() {
    const engine = new AnalysisEngine({ modelRoot: '/models/' });
    vi.spyOn(engine.models, 'caption').mockImplementation(async f => captions[f.timestamp]);
    vi.spyOn(engine.models, 'imageVector').mockImplementation(async f => frameVectors[f.timestamp]);
    vi.spyOn(engine.models, 'embed').mockImplementation(async texts => texts.map(t => (t === 'dog' ? [1, 0, 0] : [0, 0, 1])));
    vi.spyOn(engine.models, 'clipText').mockImplementation(async texts => texts.map(() => [1, 0, 0, 0]));
    return engine;
  }

  it('describe() gives each merged segment its first frame\'s vector, and a CLIP-only hit survives entry() / restore() into a fresh engine', async () => {
    const engine = stubbedEngine();
    const result = await engine.describe([frame(6.5), frame(0.5), frame(4.5), frame(2.5)], 10);
    expect(result.segments.map(s => [s.start, s.end, s.description])).toEqual([[0, 3.5, 'sunny beach'], [3.5, 10, 'dark room']]);
    expect(result.segments.map(s => s.vector)).toEqual([frameVectors[0.5], frameVectors[4.5]]);

    await engine.footage.add(asset('a1'), result, null);
    // Text is orthogonal to 'dog' in every chunk, so only the CLIP channel can produce this row: .35 + .9 - .25.
    const { results } = await search(engine.footage, 'medium');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ assetId: 'a1', chunkText: 'sunny beach', startTime: 0, endTime: 3.5, embeddingType: 'description' });
    expect(results[0].similarity).toBeCloseTo(1, 12);

    const fresh = stubbedEngine();
    fresh.footage.restore(engine.footage.entry('a1')!);
    expect(await search(fresh.footage, 'medium')).toEqual(await search(engine.footage, 'medium'));
  });
});
