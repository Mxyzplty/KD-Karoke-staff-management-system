// SPDX-License-Identifier: AGPL-3.0-only
// T19 C1: the browser's analysis preparation steps (Xapp part 3 §44.5: `gemini` → `analysis`, `transcription`,
// `embeddings_description` / `embeddings_transcript`). A step that does not apply is "skipped"; a capability without its
// local models is "unavailable" (C12).
import { runWorker } from '../media/worker-client';
import type { AnalysisArgs, StepOutcome } from '../media/prepare';
import { hostedSpeech } from '../settings/elevenlabs';
import { projectStore } from '../store/database';
import { analysisService, assetInput } from './service';
import type { AnalysisRow, IndexRow, TranscriptRow } from './service';
import type { Frame, Transcript, TranscriptionResult, VisualAnalysis } from './types';

/** Frames for the vision model: every 2 s from 0.5 s (the T19a scorer's rule), at most MAX_FRAMES (a longer clip spreads
 *  them evenly), fitted into FRAME_BOX (Florence-2's input size). */
export const FRAME_STEP_S = 2, FRAME_BOX = 768, MAX_FRAMES = 90;
export function frameTimes(duration: number): number[] {
  if (duration <= 0.5) return [duration / 2];
  const n = Math.ceil((duration - 0.5) / FRAME_STEP_S);
  return n <= MAX_FRAMES ? Array.from({ length: n }, (_, i) => 0.5 + i * FRAME_STEP_S) : Array.from({ length: MAX_FRAMES }, (_, i) => (i + 0.5) * duration / MAX_FRAMES);
}
const now = () => new Date().toISOString();
export async function analysisStep({ blob, asset, info, signal }: AnalysisArgs): Promise<StepOutcome> {
  if (asset.type === 'audio' || (!info.video && !info.image)) return { state: 'skipped' };
  if (!(await analysisService.available()).analysis) return { state: 'unavailable' };
  // A video without a probed duration is described like a still (review R6b).
  const still = !!info.image || !info.durationMs, duration = still ? 1 : info.durationMs! / 1000;
  const frames = info.container === 'svg+xml' ? [await svgFrame(blob)] : await runWorker<Frame[]>({ op: 'frames', blob, info, times: still ? [0] : frameTimes(duration), box: FRAME_BOX }, signal);
  const described = await analysisService.request<VisualAnalysis>({ task: 'describe', frames, duration }, frames.map(f => f.data.buffer), signal);
  // The frames were downscaled for the model: the record keeps the source's display size.
  const { width, height } = info.image ?? { width: info.video!.displayWidth, height: info.video!.displayHeight };
  const analysis: VisualAnalysis = { ...described, width, height, aspectRatio: width / height };
  const row: AnalysisRow = { id: asset.id, analysis, created_at: now() };
  return { state: 'complete', value: analysis, puts: [{ store: 'analyses', value: row }] };
}
export async function transcriptionStep({ blob, asset, info, signal }: AnalysisArgs): Promise<StepOutcome> {
  if (asset.type === 'image' || !info.audio) return { state: 'skipped' };
  // T21 (D23): a hosted key the user chose replaces this one job; otherwise the local models do it.
  const hosted = await hostedSpeech(projectStore);
  if (!hosted && !(await analysisService.available()).transcription) return { state: 'unavailable' };
  try {
    const samples = await runWorker<Float32Array>({ op: 'pcm', blob, info }, signal);
    const result = hosted ? { status: 'complete' as const, transcript: await hosted(samples, signal) } : await analysisService.request<TranscriptionResult>({ task: 'transcribe', pcm: { sampleRate: 16000, channels: 1, data: [samples] } }, [samples.buffer], signal);
    // A hosted transcript (T21) has no sound classifier, so its row carries no `music` flag (T09 then reads music from a beat row only).
    const row: TranscriptRow = { id: asset.id, status: result.status, transcript: result.transcript, ...(result.status === 'skipped' ? { reason: result.reason } : 'music' in result ? { music: result.music } : {}), created_at: now() };
    return { state: result.status, value: result.transcript, puts: [{ store: 'transcripts', value: row }] };
  } catch (e) {
    // C2 (part 2 §25, a voice-over or any other asset): the asset stays ready and its transcript row says why,
    // `{status: "failed", error}`. prepareAsset publishes `puts` with the failed step (an abort is rethrown there first).
    const error = e instanceof Error ? e : new Error(String(e));
    const row: TranscriptRow = { id: asset.id, status: 'failed', transcript: null, error: error.message || 'Transcription failed.', created_at: now() };
    throw Object.assign(error, { puts: [{ store: 'transcripts', value: row }] });
  }
}
export async function embeddingsStep({ asset, results, signal }: AnalysisArgs): Promise<StepOutcome> {
  const analysis = results.analysis as VisualAnalysis | null, transcript = results.transcription as Transcript | null;
  if (!(await analysisService.available()).embeddings) return { states: { embeddings_description: 'unavailable', embeddings_transcript: 'unavailable' } };
  const row: IndexRow = await analysisService.index(assetInput(asset), analysis, transcript, signal);
  return { states: { embeddings_description: analysis ? 'complete' : 'skipped', embeddings_transcript: transcript?.segments.length ? 'complete' : 'skipped' }, puts: [{ store: 'search_index', value: row }] };
}
/** SVG draws only through an <img> on the main thread (workers have no SVG decoder); <img> runs no SVG script. */
/** The stored SVG bytes as a data URL: an object URL taints the canvas when the SVG has a foreignObject (D97). */
async function svgDataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(s)}`;
}
async function svgFrame(blob: Blob): Promise<Frame> {
  const img = new Image(); img.src = await svgDataUrl(blob); await img.decode();
  const scale = Math.min(1, FRAME_BOX / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const width = Math.max(1, Math.round(img.naturalWidth * scale)), height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
  canvas.width = width; canvas.height = height; context.drawImage(img, 0, 0, width, height);
  return { timestamp: 0, width, height, data: context.getImageData(0, 0, width, height).data };
}
