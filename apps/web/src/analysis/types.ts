// SPDX-License-Identifier: AGPL-3.0-only
import type { RawAudio } from '../media/decode';

/** T14 planar PCM and display RGBA; every public time below is source seconds. */
export type Pcm = Pick<RawAudio, 'sampleRate' | 'channels' | 'data'>;
export type Frame = { timestamp: number; width: number; height: number; data: Uint8ClampedArray };
export type Word = { word: string; start: number; end: number };
export type Transcript = {
  language: string; languages: string[]; total_duration: number;
  segments: { id: number; start: number; end: number; text: string; speaker: number; words: Word[] }[];
};
export type TranscriptionResult = { status: 'complete'; transcript: Transcript; music: boolean } | { status: 'skipped'; transcript: null; reason: 'MUSIC_WITHOUT_VOCALS' };
export type Pair = [number, number];
export type Rhythm = { bpm: number | null; averageBpm: number | null; beats: Pair[]; downbeats: Pair[]; silences: Pair[] };
export type BeatAnalysis = { stored: Rhythm; tab: { bpm: number | null; beats: Pair[]; onsets: Pair[]; silences: Pair[]; firstBeat: number | null; tempoType: 'constant' | 'variable' | 'unknown' } };
/** `vector` (T19q round F8, T19's F2) is the CLIP embedding of the segment's first frame; analyses made before it have none. */
export type VisualAnalysis = { width: number; height: number; aspectRatio: number; tags: string[]; summary: string; segments: { start: number; end: number; description: string; vector?: number[] }[] };
export type AssetInput = { id: string; filename: string; type: 'video' | 'audio' | 'image'; duration: number; projectIds?: string[] };
export type Context = { type: 'description' | 'transcript'; text: string; startTime: number; endTime: number };
/** `transcript` is spoken text, its own searchable channel (D24 Q11); Xapp never matches the transcript. */
export type Chunk = { assetId: string; embeddingType: 'tags' | 'summary' | 'description' | 'transcript'; chunkText: string; startTime?: number; endTime?: number; surroundingContext: Context[]; vector: number[] };
export type SearchRequest = { query: string; projectId?: string; mode: 'general'; options: { threshold: 'low' | 'medium' | 'high'; limit: number; assetType?: AssetInput['type'] } };
export type SearchRow = Omit<Chunk, 'vector'> & { filename: string; similarity: number; source: 'embedding' | 'filename' };
export type SearchResponse = { query: string; results: SearchRow[]; metadata: { totalResults: number; sources: { embedding: number; filename: number } } };
export class AnalysisError extends Error {
  constructor(public code: string, message: string, public details?: { confidence?: number }) { super(message); this.name = 'AnalysisError'; }
}
export function finite(value: number, label: string) { if (!Number.isFinite(value)) throw new AnalysisError('INVALID_ANALYSIS_INPUT', `${label} must be finite.`); return value; }
export const grid = (seconds: number) => Math.round(seconds * 50) / 50;
export const wordsOf = (transcript: Transcript) => transcript.segments.flatMap(segment => segment.words);
