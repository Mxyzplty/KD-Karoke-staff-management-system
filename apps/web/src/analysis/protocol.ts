// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelOptions } from './models';
import type { IndexEntry } from './search';
import type { AssetInput, Frame, Pair, Pcm, Rhythm, SearchRequest, Transcript, VisualAnalysis, Word } from './types';
/** T19 (additive): `available` probes the model root without loading a model; `entry` / `restore` persist the footage index. */
export type AnalysisRequest =
  | { task: 'available'; modelRoot: string }
  | { task: 'entry'; assetId: string }
  | { task: 'restore'; entry: IndexEntry; embedder: string }
  | { task: 'init'; options: ModelOptions }
  | { task: 'transcribe'; pcm: Pcm; language?: string }
  | { task: 'beats'; pcm: Pcm; asset: Pick<AssetInput, 'filename' | 'type'> }
  | { task: 'describe'; frames: Frame[]; duration: number }
  | { task: 'index'; asset: AssetInput; analysis: VisualAnalysis | null; transcript: Transcript | null }
  | { task: 'remove'; assetId: string }
  | { task: 'search'; request: SearchRequest }
  | { task: 'embed'; texts: string[] }
  | { task: 'sync'; source: Transcript; target: Transcript }
  | { task: 'snap'; cuts: number[]; rhythm: Rhythm; tolerance: number; divisionsPerBeat?: 2 | 3 | 4 }
  | { task: 'silence'; words: Word[]; ranges: Pair[]; pause?: number; keptGap?: number };
export type AnalysisReply = { id: number; ok: true; value: unknown; elapsedMs: number; backends: Record<string, string> } | { id: number; ok: false; error: { code: string; message: string; confidence?: number } };
