// SPDX-License-Identifier: AGPL-3.0-only
/** Representative real inference parity checks, deliberately using T14's decoders. */
import { AnalysisEngine, syncOffset, type Pcm, type Transcript } from '../engine';
import { AnalysisWorker } from '../worker-client';
import { decodeAudio, frameToRgba, videoFrames } from '../../media/decode';
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';

export async function runWorkerCheck(task: 'transcription' | 'beats' | 'footage' | 'sync', modelRoot = '/t19a-models/', mediaRoot = '/t19a-media/') {
  const engine = new AnalysisEngine({ modelRoot, device: 'wasm', wasm: { mjs: new URL(wasmModule, location.href).href, wasm: new URL(wasmBinary, location.href).href } });
  const worker = new AnalysisWorker();
  const file = task === 'beats' ? 'prerequisites/OT-5-drum-120.wav' : 'corpus/tos-speech-45s.mp4';
  const blob = await (await fetch(mediaRoot + file)).blob(), decoded = await decodeAudio(blob);
  const pcm: Pcm = { sampleRate: decoded.sampleRate, channels: decoded.channels, data: decoded.data.map(c => c.slice(0, decoded.sampleRate * 6)) };
  let direct: unknown, workerValue: unknown, again: unknown, elapsedMs = 0, backends: Record<string, string> = {};
  try {
    if (task === 'transcription') {
      direct = await engine.transcribe(pcm, 'en'); await engine.models.dispose();
      await worker.init({ modelRoot, device: 'wasm' });
      const reply = await worker.run({ task: 'transcribe', pcm, language: 'en' });
      workerValue = reply.value; elapsedMs = reply.elapsedMs; backends = reply.backends;
      again = (await worker.run({ task: 'transcribe', pcm, language: 'en' })).value;
    } else if (task === 'beats') {
      const asset = { type: 'audio' as const, filename: 'drums.wav' };
      direct = await engine.beats(pcm, asset); await engine.models.dispose();
      await worker.init({ modelRoot, device: 'wasm' });
      const reply = await worker.run({ task: 'beats', pcm, asset });
      workerValue = reply.value; elapsedMs = reply.elapsedMs; backends = reply.backends;
      again = (await worker.run({ task: 'beats', pcm, asset })).value;
    } else if (task === 'footage') {
      let frame;
      for await (const raw of videoFrames(blob, { startS: 2 })) { frame = { ...frameToRgba(raw), timestamp: raw.timestamp }; break; }
      if (!frame) throw Error('T14 produced no video frame');
      const asset = { id: 'short', filename: 'short-speech.mp4', type: 'video' as const, duration: 6, projectIds: ['short-project'] };
      const analysis = await engine.describe([frame], 6);
      await engine.footage.add(asset, analysis, null);
      const request = { query: analysis.segments[0].description, projectId: 'short-project', mode: 'general' as const, options: { threshold: 'medium' as const, limit: 30 } };
      direct = { analysis, search: await engine.footage.search(request) }; await engine.models.dispose();
      await worker.init({ modelRoot, device: 'wasm' });
      const describe = await worker.run({ task: 'describe', frames: [frame], duration: 6 });
      await worker.run({ task: 'index', asset, analysis: describe.value as typeof analysis, transcript: null });
      const search = await worker.run({ task: 'search', request });
      workerValue = { analysis: describe.value, search: search.value }; elapsedMs = describe.elapsedMs + search.elapsedMs; backends = search.backends;
      const second = await worker.run({ task: 'describe', frames: [frame], duration: 6 });
      again = { analysis: second.value, search: (await worker.run({ task: 'search', request })).value };
    } else {
      const original = await engine.transcribe(pcm, 'en');
      const recut = await engine.transcribe({ ...pcm, data: pcm.data.map(c => c.slice(Math.round(1.234 * pcm.sampleRate))) }, 'en');
      if (original.status !== 'complete' || recut.status !== 'complete') throw Error('Speech unexpectedly skipped');
      const source: Transcript = recut.transcript, target: Transcript = original.transcript;
      direct = syncOffset(source, target); await engine.models.dispose();
      const reply = await worker.run({ task: 'sync', source, target });
      workerValue = reply.value; elapsedMs = reply.elapsedMs; backends = reply.backends;
      again = (await worker.run({ task: 'sync', source, target })).value;
    }
    return { direct, worker: workerValue, again, elapsedMs, backends };
  } finally { await engine.models.dispose(); worker.close(); }
}
