// SPDX-License-Identifier: AGPL-3.0-only
import { AnalysisEngine, AnalysisError, syncOffset, snapCuts, planSilenceRemoval } from './engine';
import { MODEL_IDS } from './models';
import { modelAvailability } from './availability';
import type { AnalysisRequest, AnalysisReply } from './protocol';
let engine: AnalysisEngine | undefined;
let queue = Promise.resolve();
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: number; request: AnalysisRequest }>) => void) | null; postMessage(value: AnalysisReply): void };
scope.onmessage = event => {
  // Inference and index publication are serialized, including rejection paths.
  queue = queue.then(async () => {
    const { id, request } = event.data, start = performance.now();
    try {
      let value: unknown;
      switch (request.task) {
        case 'init':
          if (engine) throw new AnalysisError('ANALYSIS_ALREADY_INITIALIZED', 'Create a new worker to change model configuration.');
          engine = new AnalysisEngine(request.options); value = true; break;
        case 'sync': value = syncOffset(request.source, request.target); break;
        case 'snap': value = snapCuts(request.cuts, request.rhythm, request.tolerance, request.divisionsPerBeat); break;
        case 'silence': value = planSilenceRemoval(request.words, request.ranges, request.pause, request.keptGap); break;
        case 'available': value = await modelAvailability(request.modelRoot); break;
        default:
          if (!engine) throw new AnalysisError('ANALYSIS_NOT_INITIALIZED', 'Initialize the local model cache before inference.');
          switch (request.task) {
            case 'transcribe': value = await engine.transcribe(request.pcm, request.language); break;
            case 'beats': value = await engine.beats(request.pcm, request.asset); break;
            case 'describe': value = await engine.describe(request.frames, request.duration); break;
            case 'index': await engine.footage.add(request.asset, request.analysis, request.transcript); value = true; break;
            case 'search': value = await engine.footage.search(request.request); break;
            case 'embed': value = await engine.models.embed(request.texts); break;
            case 'remove': engine.footage.remove(request.assetId); value = true; break;
            // A stored entry made by another embedder is refused (false): the caller re-indexes it.
            case 'entry': value = { entry: engine.footage.entry(request.assetId) ?? null, embedder: MODEL_IDS.embedding }; break;
            case 'restore': if (request.embedder === MODEL_IDS.embedding) engine.footage.restore(request.entry); value = request.embedder === MODEL_IDS.embedding; break;
          }
      }
      scope.postMessage({ id, ok: true, value, elapsedMs: performance.now() - start, backends: { ...engine?.models.backends } });
    } catch (error) {
      const e = error as AnalysisError;
      scope.postMessage({ id, ok: false, error: { code: e.code ?? 'ANALYSIS_FAILED', message: e.message ?? String(error), ...e.details } });
    }
  });
};
