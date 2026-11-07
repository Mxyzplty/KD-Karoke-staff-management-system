// SPDX-License-Identifier: AGPL-3.0-only
// T12 mask worker protocol. Source frames stay in the worker; a request names the source and a range in source µs.
import type { Sam2Backend } from './sam2';
import type { Raster, Stroke } from './engine';

export type Rotation = 0 | 90 | 180 | 270;
export type MaskSource = { blob: Blob; rotation: Rotation };
export type MaskInit = { root: string; wasm: { mjs: string; wasm: string } };
export type MaskRequest =
  | { task: 'frame'; source: MaskSource; atUs: number }
  | { task: 'preview'; source: MaskSource; atUs: number; strokes: Stroke[] }
  | { task: 'auto'; source: MaskSource; startUs: number; endUs: number; total: number }
  | { task: 'track'; source: MaskSource; atUs: number; startUs: number; endUs: number; total: number; strokes: Stroke[] }
  | { task: 'text'; source: MaskSource; atUs: number; startUs: number; endUs: number; total: number; prompt: string };
/** A source frame's image; `timeUs` is the frame's own time. */
export type MaskFrame = { timeUs: number; width: number; height: number; jpeg: Blob };
export type MaskPreview = { timeUs: number; width: number; height: number; png: Blob; area: number };
export type AutoResult = { raster: Raster | null; segments: number };
export type MaskResult = MaskFrame | MaskPreview | AutoResult | Raster;
export type MaskReply =
  | { id: number; kind: 'progress'; done: number; total: number; backend: Sam2Backend }
  | { id: number; kind: 'done'; value: MaskResult }
  | { id: number; kind: 'failed'; code: string; message: string };
/** Worker failures the job list and the tools tell apart. */
export const MASK_CODES = { unavailable: 'MASK_MODEL_UNAVAILABLE', cancelled: 'MASK_CANCELLED', failed: 'MASK_FAILED', sourceChanged: 'MASK_SOURCE_CHANGED' } as const;
export class MaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
