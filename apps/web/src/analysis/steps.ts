// SPDX-License-Identifier: AGPL-3.0-only
// T19 C1: the browser's analysis preparation steps (Xapp part 3 §44.5: `gemini` → `analysis`, `transcription`,
// `embeddings_description` / `embeddings_transcript`). A step that does not apply is "skipped"; a capability without its
// local models is "unavailable" (C12).
import { runWorker } from '../media/worker-client';
import { preparationBudgetMs } from '../media/prepare';
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
/** T37 (D120 item 4): the analysis model deadline, (MODEL_LOAD_VISION + frames × PER_FRAME) × MARGIN, armed at `started`.
 *  Lane A, 26 Nov about 04:40, from the F1 diagnostic dddecf1, CLIP2 alone on WASM. The vision load. The mean of the 8
 *  finished frames, with the load taken out of frame 0 (sd 4 162 ms, longest 41 068 ms). MARGIN = longest / mean (1.2515)
 *  / 0.75 (T37 notes l.14-18). */
export const MODEL_LOAD_VISION = 4_577, PER_FRAME = 32_814, MARGIN = 1.2515 / 0.75;
export const analysisDeadlineMs = (frames: number, k = { MODEL_LOAD_VISION, PER_FRAME, MARGIN }) => Math.ceil((k.MODEL_LOAD_VISION + frames * k.PER_FRAME) * k.MARGIN);
/** T37: the transcription model deadline, (MODEL_LOAD_ASR + audio seconds × PER_AUDIO_SECOND) × MARGIN_ASR, armed at
 *  `started`. Lane A, 27 Nov 11:58, from H1 (S/t37-h1/summary.txt c0af2904…) and F1 (build plan §3 l.172). The six
 *  sub-model loads of H1 clip a. The mean of the slowest run per distinct clip, load taken out: F1's CLIP2 7 342.97 ms/s,
 *  H1's c 1 293.3. MARGIN_ASR = max(1.2515, their spread 1.7005) / 0.75 (T37 notes, Constants). */
export const MODEL_LOAD_ASR = 11_333, PER_AUDIO_SECOND = 4_318.13;
export const MARGIN_ASR = 1.7005 / 0.75;
export const transcriptionDeadlineMs = (audioSeconds: number, k = { MODEL_LOAD_ASR, PER_AUDIO_SECOND, MARGIN_ASR }) => Math.ceil((k.MODEL_LOAD_ASR + audioSeconds * k.PER_AUDIO_SECOND) * k.MARGIN_ASR);
/** T37: the embeddings model deadline (index, then entry), (MODEL_LOAD_EMBED + segments × PER_SEGMENT) × MARGIN, armed at
 *  `started`. Lane A, 27 Nov 11:58, from H1 (S/t37-h1/summary.txt c0af2904…; F1, build plan §3 l.172, has no embeddings
 *  point). The higher load of H1 and report 0005. The mean of the no-load points b and c, per description + transcript
 *  segment, the unit H1 logged (lane A 21:42). The step takes the higher of this and preparationBudgetMs (Author 27 Nov
 *  20:31 item 7: 5 min for these clips; of two defensible values the higher wins). */
export const MODEL_LOAD_EMBED = 251, PER_SEGMENT = 315.25;
export const embeddingsDeadlineMs = (segments: number, k = { MODEL_LOAD_EMBED, PER_SEGMENT, MARGIN }) => Math.ceil((k.MODEL_LOAD_EMBED + segments * k.PER_SEGMENT) * k.MARGIN);
const now = () => new Date().toISOString();
export async function analysisStep({ blob, asset, info, signal, model }: AnalysisArgs): Promise<StepOutcome> {
  if (asset.type === 'audio' || (!info.video && !info.image)) return { state: 'skipped' };
  if (!(await analysisService.available()).analysis) return { state: 'unavailable' };
  // A video without a probed duration is described like a still (review R6b).
  const still = !!info.image || !info.durationMs, duration = still ? 1 : info.durationMs! / 1000;
  const frames = info.container === 'svg+xml' ? [await svgFrame(blob)] : await runWorker<Frame[]>({ op: 'frames', blob, info, times: still ? [0] : frameTimes(duration), box: FRAME_BOX }, signal);
  const described = await analysisService.request<VisualAnalysis>({ task: 'describe', frames, duration }, frames.map(f => f.data.buffer), signal, false, model?.(analysisDeadlineMs(frames.length)));
  // The frames were downscaled for the model: the record keeps the source's display size.
  const { width, height } = info.image ?? { width: info.video!.displayWidth, height: info.video!.displayHeight };
  const analysis: VisualAnalysis = { ...described, width, height, aspectRatio: width / height };
  const row: AnalysisRow = { id: asset.id, analysis, created_at: now() };
  return { state: 'complete', value: analysis, puts: [{ store: 'analyses', value: row }] };
}
export async function transcriptionStep({ blob, asset, info, signal, model }: AnalysisArgs): Promise<StepOutcome> {
  if (asset.type === 'image' || !info.audio) return { state: 'skipped' };
  // T21 (D23): a hosted key the user chose replaces this one job; otherwise the local models do it.
  const hosted = await hostedSpeech(projectStore);
  if (!hosted && !(await analysisService.available()).transcription) return { state: 'unavailable' };
  try {
    const samples = await runWorker<Float32Array>({ op: 'pcm', blob, info }, signal);
    // T37: the local model deadline, armed at `started`, is sized from the audio the model gets (16 kHz mono), not the probe.
    const result = hosted ? { status: 'complete' as const, transcript: await hosted(samples, signal) } : await analysisService.request<TranscriptionResult>({ task: 'transcribe', pcm: { sampleRate: 16000, channels: 1, data: [samples] } }, [samples.buffer], signal, false, model?.(transcriptionDeadlineMs(samples.length / 16000)));
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
export async function embeddingsStep({ asset, info, results, signal, model }: AnalysisArgs): Promise<StepOutcome> {
  const analysis = results.analysis as VisualAnalysis | null, transcript = results.transcription as Transcript | null;
  if (!(await analysisService.available()).embeddings) return { states: { embeddings_description: 'unavailable', embeddings_transcript: 'unavailable' } };
  // T37: the model deadline (index, then entry), armed at `started`: the sized value or preparationBudgetMs, the higher.
  const segments = (analysis?.segments.length ?? 0) + (transcript?.segments.length ?? 0);
  const row: IndexRow = await analysisService.index(assetInput(asset), analysis, transcript, signal, model?.(Math.max(embeddingsDeadlineMs(segments), preparationBudgetMs(info.durationMs))));
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
