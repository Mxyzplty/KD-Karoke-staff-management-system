// SPDX-License-Identifier: AGPL-3.0-only
// Remux fast path (findings §7): when the timeline is effectively one unedited clip, the source packets are copied into
// the MP4 instead of decoding and encoding. Conditions: no watermark (Cutframe has none), no range, output size = canvas,
// source fps = timeline fps (constant rate), one exported item and no transitions, a video drawn 1:1 over the whole canvas
// from its first frame to its end (no trim, speed, remap, keyframes, effects, masks, opacity, blend, radius or border),
// at full volume on a track whose gain is 1 (not muted, not soloed out, track volume 1: T13's gain law, audio/gain.ts),
// H.264 video with AAC audio, audio starting at 0 and matching the video duration within 1 frame. The copied audio
// does not go through the output limiter (packets are copied, findings §7).
import { ALL_FORMATS, BlobSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource, Input } from 'mediabunny';
import type { EncodedPacket } from 'mediabunny';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { framePlan, IDENTITY, isPending, planTime, projectSize } from '../render/model';
import type { Plan, Size } from '../render/model';
import { audibleTrackGain } from '../audio/gain';
import { storedVolume } from './audio';
import { exportedItems } from './prep';

const NEAR_MS = 1;
const keyframed = (item: RecordData) => Object.values(item.properties ?? {}).some(p => ((p as { keyframes?: unknown[] })?.keyframes?.length ?? 0) > 0);
/** The one item the fast path would copy, or the reason it does not apply. */
export function remuxCandidate(doc: ProjectDocument, plan: Plan, size: Size, asset: (id: string) => Asset | undefined, ranged: boolean): { item: RecordData } | { reason: string } {
  if (ranged) return { reason: 'a frame range is set' };
  const p = projectSize(doc);
  if (size.width !== p.width || size.height !== p.height) return { reason: 'the output size is not the canvas size' };
  const items = exportedItems(doc);
  if (items.length !== 1 || doc.transitions?.length) return { reason: 'the timeline is not one clip' };
  const item = items[0], a = asset(String(item.metadata?.assetId)), v = a?.media?.video, au = a?.media?.audio, frame = 1000 / plan.fps;
  if (item.type !== 'video' || !a || !v || !au) return { reason: 'the clip is not a video with audio' };
  if (v.codec !== 'avc' || au.codec !== 'aac') return { reason: 'the clip is not H.264 / AAC' };
  if (v.vfr || Math.abs(v.fps - plan.fps) > 0.01) return { reason: 'the clip frame rate is not the timeline frame rate' };
  if (v.rotation !== 0 || v.displayWidth !== p.width || v.displayHeight !== p.height) return { reason: 'the clip size is not the canvas size' };
  const from = item.display.from - plan.shiftMs, src = item.sourceDuration ?? a.durationMs ?? 0;
  if (Math.abs(from) > NEAR_MS || Math.abs(item.trim?.from ?? 0) > NEAR_MS || Math.abs((item.trim?.to ?? src) - src) > frame || Math.abs(item.display.to - item.display.from - src) > frame) return { reason: 'the clip is trimmed or moved' };
  if (Math.abs(plan.count / plan.fps * 1000 - src) > frame) return { reason: 'the clip does not span the whole export' };
  if ((item.playbackRate ?? 1) !== 1 || item.timeRemap || keyframed(item) || item.effects?.length || item.masks?.length || storedVolume(item) !== 1 || audibleTrackGain(doc, item.trackId) !== 1) return { reason: 'the clip is edited' };
  const plan0 = framePlan(doc, planTime(plan, 0), size);
  if (plan0.pending.length || plan0.draws.length !== 1) return { reason: 'the frame is not one plain draw' };
  const d = plan0.draws[0];
  if (isPending(d) || d.alpha !== 1 || d.blend !== 'source-over' || d.radius !== 0 || d.border || d.path !== 'direct' || d.stackedAlpha
    || d.matrix.some((m, i) => Math.abs(m - IDENTITY[i]) > 1e-9) || Math.abs(d.box.W - p.width) > 1e-6 || Math.abs(d.box.H - p.height) > 1e-6) {
    return { reason: 'the clip is transformed or styled' };
  }
  return { item };
}

/** Remux inputs opened and not disposed yet (read by the clean-up tests). */
export const remuxInputs = { open: 0 };
/** The clip's tracks as packet sources and their copy, or null when the real tracks break a condition (codecs, a first
 *  video timestamp other than 0, audio starting later or differing in length by more than 1 frame). The caller disposes
 *  the input (dispose, also done by copy) whatever happens after this returns. */
export async function remuxTracks(blob: Blob, fps: number) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  remuxInputs.open++;
  let open = true;
  const dispose = () => { if (open) { open = false; remuxInputs.open--; input.dispose(); } };
  try {
    const vt = await input.getPrimaryVideoTrack(), at = await input.getPrimaryAudioTrack();
    if (!vt || !at || vt.codec !== 'avc' || at.codec !== 'aac') { dispose(); return null; }
    const [v0, a0, vd, ad] = await Promise.all([vt.getFirstTimestamp(), at.getFirstTimestamp(), vt.computeDuration(), at.computeDuration()]);
    if (Math.abs(v0) > 1e-3 || Math.abs(a0) > 1 / fps || Math.abs(ad - vd) > 1 / fps) { dispose(); return null; }
    const [vc, ac] = await Promise.all([vt.getDecoderConfig(), at.getDecoderConfig()]);
    if (!vc || !ac) { dispose(); return null; }
    const video = new EncodedVideoPacketSource('avc'), audio = new EncodedAudioPacketSource('aac');
    return {
      video, audio, dispose,
      /** Copies both tracks, interleaved by timestamp; onPacket gets the video packet count. */
      async copy(onPacket: (videoPackets: number) => void, signal?: AbortSignal) {
        try {
          const vi = new EncodedPacketSink(vt).packets()[Symbol.asyncIterator](), ai = new EncodedPacketSink(at).packets()[Symbol.asyncIterator]();
          let v = await vi.next(), a = await ai.next(), n = 0, firstV = true, firstA = true;
          while (!v.done || !a.done) {
            signal?.throwIfAborted();
            if (!v.done && (a.done || (v.value as EncodedPacket).timestamp <= (a.value as EncodedPacket).timestamp)) {
              await video.add(v.value, firstV ? { decoderConfig: vc } : undefined); firstV = false; onPacket(++n); v = await vi.next();
            } else {
              await audio.add(a.value as EncodedPacket, firstA ? { decoderConfig: ac } : undefined); firstA = false; a = await ai.next();
            }
          }
          video.close(); audio.close();
          return n;
        } finally { dispose(); }
      },
    };
  } catch (e) { dispose(); throw e; }
}
