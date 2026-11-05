// SPDX-License-Identifier: AGPL-3.0-only
// The media worker: thumbnails, waveforms, proxies and the WASM probe run off the main thread; T19 adds the analysis
// inputs (display frames, 16 kHz PCM, native-rate mono PCM for beats) and clip ranges.
import { analysisAudio, analysisFrames, analysisPcm, cutRange, makeProxy, makeThumbnails, makeWaveform } from './work';
import type { MediaInfo } from './probe';

export type WorkerRequest = { op: 'thumbnails' | 'waveform' | 'proxy' | 'frames' | 'pcm' | 'audio' | 'clip'; blob: Blob; info: MediaInfo; forceWasm?: boolean; times?: number[]; box?: number; range?: [number, number] };
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { op, blob, info, forceWasm, times, box, range } = event.data;
  try {
    const result = op === 'thumbnails' ? await makeThumbnails(blob, info, { forceWasm }) : op === 'waveform' ? await makeWaveform(blob, { forceWasm })
      : op === 'frames' ? await analysisFrames(blob, info, times ?? [], box ?? 768, { forceWasm }) : op === 'pcm' ? await analysisPcm(blob, { forceWasm })
      : op === 'audio' ? await analysisAudio(blob, { forceWasm }) : op === 'clip' ? await cutRange(blob, range![0], range![1]) : await makeProxy(blob, info, { forceWasm });
    const transfer = op === 'waveform' ? [(result as { peaks: Float32Array }).peaks.buffer] : op === 'frames' ? (result as { data: Uint8ClampedArray }[]).map(f => f.data.buffer)
      : op === 'pcm' ? [(result as Float32Array).buffer] : op === 'audio' ? [(result as { data: Float32Array[] }).data[0].buffer] : [];
    (self as unknown as Worker).postMessage({ ok: true, result }, transfer as Transferable[]);
  } catch (e) {
    const error = e as { code?: string; message?: string; category?: string; recovery?: string };
    (self as unknown as Worker).postMessage({ ok: false, error: { code: error?.code, message: error?.message ?? String(e), category: error?.category, recovery: error?.recovery } });
  }
};
