// SPDX-License-Identifier: AGPL-3.0-only
// captureFrame (agent tool contracts captureFrame; results §1 rule 6, G-02 and G-03 rows): composed preview frames as JPEG
// image blocks for the agent. Read-only: no bus command, no ledger. Each timestamp snaps to the nearest frame, halves up,
// which is the frame the paused preview shows (G-02, G-06: round(t × fps)); transitions are drawn (T11; results §11, G-08:
// Xapp's capture hard-cuts, Cutframe renders them through the compositor, as the export does).
// The size is the stored one (standard 378 × 672, high 810 × 1440 for 1080 × 1920).
// Provisional, not Xapp parity: the text block's shape, the refusal codes and texts (Xapp's out-of-range failure has no
// code and its text is not stored), the black backdrop (the export's; the stage's CSS background is not captured), the
// JPEG quality, and the size on other canvases (the stored factors 0.35 / 0.75 on both sides, rounded).
// T10 fix round 2: an item the effect stage could not draw is listed in notRendered and its code in errors (B3); a frame that
// cannot be read back (a tainted canvas) refuses the call with CANVAS_TAINTED; a frame read back while a WebGPU device loss
// was reported is drawn once more (N5).
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { fmt } from '../timeline/model';
import { composite } from './compositor';
import { EFFECT_FAILURES, effectsDeviceLosses, isTaint } from './effects';
import { fpsOf, framePlan, frameTime, previewFrame, projectSize } from './model';
import type { Pending } from './model';
import { picture } from './sources';

export const MAX_CAPTURES = 5;
export const CAPTURE_SCALE = { standard: 0.35, high: 0.75 } as const;
const JPEG_QUALITY = 0.92;
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: 'image/jpeg'; base64: string };
export type CaptureEnv = { store: ProjectStore; doc: ProjectDocument; asset: (id: string) => Asset | undefined; playheadMs: number };

const schema = (path: string, code: string, message: string) =>
  ({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for captureFrame', message: `${path}: ${message}`, data: { details: { errors: [{ path, code, message }] } } });
async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The refusal object, or `{success: true, content}`: one text block (the frames' JSON), then one image block per frame. */
export async function captureFrame(env: CaptureEnv, args: RecordData = {}): Promise<RecordData & { success: boolean }> {
  const { doc } = env, fps = fpsOf(doc), end = doc.duration ?? 0, quality: unknown = args.quality ?? 'standard';
  if (quality !== 'standard' && quality !== 'high') return schema('$.quality', 'ENUM', 'must be one of standard, high');
  const times: unknown[] = args.timestamps === undefined ? [env.playheadMs / 1000] : args.timestamps;
  if (!Array.isArray(times)) return schema('$.timestamps', 'TYPE', 'must be array');
  if (times.length > MAX_CAPTURES) return schema('$.timestamps', 'MAXITEMS', `must have at most ${MAX_CAPTURES} items`);
  const bad = times.findIndex(t => typeof t !== 'number' || !Number.isFinite(t));
  if (bad >= 0) return schema(`$.timestamps[${bad}]`, 'TYPE', 'must be number');
  const out = times as number[], outside = out.find(t => t < 0 || t * 1000 > end);
  if (outside !== undefined) return { success: false, code: 'TIME_OUT_OF_RANGE', error: `Time ${outside}s is outside the composition (0s - ${fmt(end)}s).` };
  const p = projectSize(doc), k = CAPTURE_SCALE[quality], size = { width: Math.round(p.width * k), height: Math.round(p.height * k) };
  const frames: RecordData[] = [], images: ContentBlock[] = [];
  for (const t of out) {
    const frame = previewFrame(t * 1000, fps), tMs = frameTime(frame, fps), plan = framePlan(doc, tMs, size);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const sources = await Promise.all(plan.draws.map(d => picture(env.store, d, env.asset(String(d.item.metadata?.assetId)), 'capture', env.asset)));
    let failed: Pending[] = [], blob: Blob;
    try {
      for (let again = false; ; again = true) {
        const losses = effectsDeviceLosses();
        failed = composite(canvas.getContext('2d')!, plan.draws, sources, size, 'black');
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
        if (again || effectsDeviceLosses() === losses) break;
      }
    } catch (e) {
      if (!isTaint(e)) throw e;
      return { success: false, code: 'CANVAS_TAINTED', category: 'system_error', recovery: 'our_bug', error: 'Frames could not be read back', message: EFFECT_FAILURES.CANVAS_TAINTED.message };
    }
    images.push({ type: 'image', mimeType: 'image/jpeg', base64: await base64(blob) });
    // A motion graphic that could not be rendered (T08) is listed by its error, which names it.
    const failures = sources.flatMap(s => s !== null && s !== 'failed' && 'error' in s ? [s.error] : []);
    const notRendered = [...new Set([...[...plan.pending, ...failed].map(x => `${x.what} (${x.owner})`), ...failures])];
    const errors = [...new Map(failed.map(f => [f.code, { code: f.code, category: f.category, recovery: f.recovery, message: f.message }])).values()];
    frames.push({ timestamp: t, frame, time: tMs / 1000, ...size, ...notRendered.length ? { notRendered } : {}, ...errors.length ? { errors } : {} });
  }
  return { success: true, content: [{ type: 'text', text: JSON.stringify({ success: true, quality, frames }) }, ...images] };
}
