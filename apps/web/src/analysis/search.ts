// SPDX-License-Identifier: AGPL-3.0-only
import { cosine } from './audio';
import { normalWord } from './sync';
import { AnalysisError, type AssetInput, type Chunk, type Context, type SearchRequest, type SearchResponse, type SearchRow, type Transcript, type VisualAnalysis, type Word } from './types';

export type Embedder = (texts: string[]) => Promise<number[][]>;
/** `image` (T19q round F8) is a description chunk's frame vector, kept with the entry; it never reaches a row. */
export type IndexEntry = { asset: AssetInput; chunks: (Chunk & { image?: number[] })[]; transcript: Transcript | null };
/** Minimum cosine similarity per named threshold; a row at exactly the value is kept. */
export const SEARCH_THRESHOLDS = { low: 0.2, medium: 0.35, high: 0.5 };
/** T19q round F8 (T19's F2): the CLIP similarity that counts as the text channel's medium threshold. */
export const VISUAL_THRESHOLD = 0.25;
/** V-FS visual calibration (score.ts): the smallest value on 0.15, 0.16, ..., 0.40 above the best no-match frame similarity. */
export const visualCalibration = (best: number) => Array.from({ length: 26 }, (_, i) => Math.round((0.15 + 0.01 * i) * 100) / 100).find(g => g > best) ?? null;
/** Image-text embedder for the visual channel; `medium` is its similarity at the text medium threshold. */
export type VisualChannel = { embed: (texts: string[]) => Promise<number[][]>; medium: number };
/** EMBEDDING_FAILED has one message everywhere: the same text as the asset row (`MEDIA_CODES` in media/codes.ts). */
export const EMBEDDING_FAILED_MESSAGE = 'Search indexing failed — retry to try again.';
export class FootageIndex {
  private assets = new Map<string, IndexEntry>();
  constructor(private embed: Embedder, private thresholds = SEARCH_THRESHOLDS, private visual?: VisualChannel) {}
  async add(asset: AssetInput, analysis: VisualAnalysis | null, transcript: Transcript | null) {
    const contexts: Context[] = [
      ...(analysis?.segments.map(s => ({ type: 'description' as const, text: s.description, startTime: s.start, endTime: s.end })) ?? []),
      ...(transcript?.segments.map(s => ({ type: 'transcript' as const, text: s.text, startTime: s.start, endTime: s.end })) ?? [])
    ];
    const chunks: (Omit<Chunk, 'vector'> & { image?: number[] })[] = [];
    const push = (embeddingType: Chunk['embeddingType'], chunkText: string, startTime?: number, endTime?: number, image?: number[]) => {
      if (!chunkText.trim()) return;
      const surroundingContext = contexts.filter(c => startTime === undefined || (c.endTime >= startTime - 2 && c.startTime <= endTime! + 2));
      chunks.push({ assetId: asset.id, embeddingType, chunkText, ...(startTime === undefined ? {} : { startTime, endTime }), surroundingContext, ...(image ? { image } : {}) });
    };
    push('tags', asset.filename.replace(/[^\p{L}\p{N}]+/gu, ' '));
    if (analysis) { push('tags', analysis.tags.join(', ')); push('summary', analysis.summary); }
    // D24 (Q11): spoken text is its own channel; visual description segments keep theirs. Both row
    // shapes are unchanged and both carry their neighbouring context.
    // Description contexts come first, one per analysis segment, so index i is that segment's frame vector.
    contexts.forEach((context, i) => push(context.type, context.text, context.startTime, context.endTime, context.type === 'description' ? analysis!.segments[i].vector : undefined));
    const vectors = await this.embed(chunks.map(c => c.chunkText));
    if (vectors.length !== chunks.length) throw new AnalysisError('EMBEDDING_FAILED', EMBEDDING_FAILED_MESSAGE);
    const indexed = chunks.map((c, i) => { cosine(vectors[i], vectors[i]); return { ...c, vector: vectors[i] }; });
    this.assets.set(asset.id, { asset: { ...asset, projectIds: asset.projectIds?.slice() }, chunks: indexed, transcript: transcript ? structuredClone(transcript) : null });
  }
  remove(assetId: string) { this.assets.delete(assetId); }
  /** One asset's indexed form, vectors included, for a persistent index; `restore` puts it back unchanged. */
  entry(assetId: string): IndexEntry | undefined { const entry = this.assets.get(assetId); return entry && structuredClone(entry); }
  restore(entry: IndexEntry) { this.assets.set(entry.asset.id, structuredClone(entry)); }
  async search(request: SearchRequest): Promise<SearchResponse> {
    const query = request.query.trim(), thresholds = this.thresholds;
    if (request.mode !== 'general' || !Object.hasOwn(thresholds, request.options.threshold) || !Number.isInteger(request.options.limit) || request.options.limit < 1) throw new AnalysisError('INVALID_SEARCH_REQUEST', 'Expected general search, a known threshold and a positive integer limit.');
    if (!query) return { query: request.query, results: [], metadata: { totalResults: 0, sources: { embedding: 0, filename: 0 } } };
    const [vector] = await this.embed([query]), filename: SearchRow[] = [], embedding: SearchRow[] = [], spans: { asset: AssetInput; span: Word[]; segment: Transcript['segments'][number] }[] = [];
    // The query's CLIP vector is made on the first chunk that carries a frame vector, so a search over assets
    // without one never loads CLIP.
    let visualVector: number[] | undefined;
    for (const { asset, chunks, transcript } of this.assets.values()) {
      if (request.projectId && !asset.projectIds?.includes(request.projectId)) continue;
      if (request.options.assetType && request.options.assetType !== asset.type) continue;
      if (asset.filename.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US'))) filename.push({ assetId: asset.id, filename: asset.filename, embeddingType: 'tags', chunkText: asset.filename, surroundingContext: [], similarity: 1, source: 'filename' });
      for (const { vector: chunkVector, image, ...chunk } of chunks) {
        let similarity = cosine(vector, chunkVector);
        // T19q round F8 (T19's F2): a frame match scores its description row on the text scale (text medium +
        // visual margin); a segment matched by both channels keeps one row with the higher score.
        if (image && this.visual) {
          visualVector ??= (await this.visual.embed([`a photo of ${query}.`]))[0];
          similarity = Math.max(similarity, thresholds.medium + cosine(visualVector, image) - this.visual.medium);
        }
        if (similarity >= thresholds[request.options.threshold]) embedding.push({ ...chunk, filename: asset.filename, similarity, source: 'embedding' });
      }
      // Refine exact spoken phrases to their actual word span, then score those
      // candidates with the same embedder. No oracle text or relevance key enters the index.
      const tokens = query.split(/\s+/).map(normalWord).filter(Boolean);
      for (const segment of transcript?.segments ?? []) for (let i = 0; tokens.length && i + tokens.length <= segment.words.length; i++) {
        const span = segment.words.slice(i, i + tokens.length);
        if (span.every((word, k) => normalWord(word.word) === tokens[k])) spans.push({ asset, span, segment });
      }
    }
    // All matched spans are embedded in one batch.
    const spanVectors = spans.length ? await this.embed(spans.map(({ span }) => span.map(w => w.word).join(' '))) : [];
    if (spanVectors.length !== spans.length) throw new AnalysisError('EMBEDDING_FAILED', EMBEDDING_FAILED_MESSAGE);
    spans.forEach(({ asset, span, segment }, k) => {
      const similarity = cosine(vector, spanVectors[k]);
      if (similarity >= thresholds[request.options.threshold]) embedding.push({ assetId: asset.id, filename: asset.filename, embeddingType: 'transcript', chunkText: span.map(w => w.word).join(' '), startTime: span[0].start, endTime: span.at(-1)!.end, surroundingContext: [{ type: 'transcript', text: segment.text, startTime: segment.start, endTime: segment.end }], similarity, source: 'embedding' });
    });
    embedding.sort((a, b) => b.similarity - a.similarity || a.assetId.localeCompare(b.assetId) || (a.startTime ?? -1) - (b.startTime ?? -1));
    const results = [...filename, ...embedding].slice(0, request.options.limit);
    return { query: request.query, results, metadata: { totalResults: filename.length + embedding.length, sources: { filename: filename.length, embedding: embedding.length } } };
  }
}
