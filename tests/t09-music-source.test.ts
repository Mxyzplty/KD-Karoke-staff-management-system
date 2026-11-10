// SPDX-License-Identifier: AGPL-3.0-only
// T09 CAP-P04(b) production chain: the classifier's `isMusic` flag flows classifier → engine.transcribe → transcriptionStep
// row → sourceData → Music lyrics captions. t09-tools.test.ts already proves the consumption side from a seeded row (the (b)
// cases at ~341, the Executor read at ~442) and that the flag never reaches an agent tool result (required case 4). This file
// closes the gap the coordinator named: the flag is PRODUCED by the classifier inside engine.transcribe and survives into the
// stored TranscriptRow, so the Music button is driven by the real analysis path, not only by a hand-written row.
//
// Stays Author-run (real models/ + ffmpeg + worker, in CI): the audio classifier, the VAD, the Whisper decode, the CTC
// aligner, the diarizer and the worker's PCM extraction. This unit test stubs exactly those model methods and the worker and
// runs the real control flow of engine.transcribe, the real transcriptionStep row builder, and the real
// sourceData/captionData/addCaptionsIn generation — so the flag-propagation logic is proven here while the inference itself
// is exercised by the parity/export gates Author runs.
// transcriptionStep first reads the provider settings for T21's hosted speech: the real ProjectStore runs on fake-indexeddb
// with no settings row, so the step takes the local path (as in t19-c2-voiceover and t19-c12-unavailable).
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisEngine } from '../apps/web/src/analysis/engine';
import type { ModelOptions } from '../apps/web/src/analysis/models';
import type { Pcm, Transcript, TranscriptionResult } from '../apps/web/src/analysis/types';
import { transcriptionStep } from '../apps/web/src/analysis/steps';
import { analysisService } from '../apps/web/src/analysis/service';
import type { TranscriptRow } from '../apps/web/src/analysis/service';
import type { StepOutcome } from '../apps/web/src/media/prepare';
import type { AnalysisArgs } from '../apps/web/src/media/prepare';
import { captionData } from '../apps/web/src/captions/agent';
import { addCaptionsIn } from '../apps/web/src/captions/tools';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { build, mkItem, mkTrack } from './t03-fixtures';

// The caption generator loads faces; this file never reaches the font loader (it calls addCaptionsIn directly, not the agent
// wrapper), so no fonts mock is needed. The worker is browser-only — the PCM extraction the step runs is stubbed.
vi.mock('../apps/web/src/media/worker-client', () => ({ runWorker: vi.fn(async () => new Float32Array(16000)), browserSteps: vi.fn() }));

type Classification = { isMusic: boolean; hasVocals: boolean };
// A fake LocalModels: only the methods engine.transcribe reaches on the speech/singing path. speechRegions returns one voiced
// window and transcribe returns two words inside it, so the complete path yields a real (non-empty) Transcript. realign is
// spied off per engine so the CTC aligner (ctcLogProbs) is never needed. An English music file also runs Qwen3-ASR (T19q T8);
// qwenTranscribe returns whisper's words, so arbitrate keeps whisper's without reaching the aligner either.
const fakeModels = (c: Classification) => ({
  classify: async () => c,
  speechRegions: async () => [[0.3, 0.9]] as [number, number][],
  detectLanguage: async () => 'en',
  transcribe: async () => ({ chunks: [{ text: ' la', timestamp: [0.2, 0.4] }, { text: ' la', timestamp: [0.5, 0.7] }] }),
  qwenTranscribe: async () => ({ chunks: [{ text: ' la', timestamp: [0.2, 0.4] }, { text: ' la', timestamp: [0.5, 0.7] }] }),
  diarize: async () => {},
});
function engineWith(c: Classification): AnalysisEngine {
  const e = new AnalysisEngine({ modelRoot: '/models/' } as ModelOptions);           // cheap in Node: the model-root setup is guarded by `typeof location`
  (e as unknown as { models: unknown }).models = fakeModels(c);
  vi.spyOn(e as unknown as { realign: (a: Float32Array, t: Transcript) => Promise<void> }, 'realign').mockResolvedValue(undefined);
  return e;
}
const pcm = (): Pcm => ({ sampleRate: 16000, channels: 1, data: [new Float32Array(16000).fill(0.1)] });

// transcriptionStep input: an audio asset with a probed duration. runWorker (PCM) and analysisService are stubbed; the step's
// own row builder runs for real. `result` is whatever engine.transcribe produced, so the row's music/reason comes from the
// classifier through the real step.
async function runStep(result: TranscriptionResult): Promise<StepOutcome> {
  vi.spyOn(analysisService, 'available').mockResolvedValue({ analysis: true, transcription: true, embeddings: true } as never);
  vi.spyOn(analysisService, 'request').mockResolvedValue(result as never);
  const args = { blob: new Blob(), asset: { id: 'asset-vid1', type: 'audio' }, info: { audio: { codec: 'aac' }, durationMs: 1000 }, results: {} } as unknown as AnalysisArgs;
  return transcriptionStep(args);
}
const rowOf = (out: StepOutcome) => (out as { puts: { value: TranscriptRow }[] }).puts[0].value;

// source item at display 0–1000 ms with trim.from 0, so the engine's words at ~0.25–0.75 s land inside its occurrence.
const clip = () => mkItem('v1', 'V1', 0, 1000, { trim: { from: 0, to: 1000 }, sourceDuration: 1000, metadata: { assetId: 'asset-vid1' } });
const doc = (): ProjectDocument => build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption')], items: [clip()] });
// a store whose transcripts row is exactly the step's output; no rhythm row.
const store = (row: TranscriptRow) => ({ row: async (table: string) => (table === 'transcripts' ? row : undefined) } as never);
const captions = (d: ProjectDocument) => d.items.filter(i => i.type === 'caption');

describe('T09 CAP-P04(b): the classifier flag flows classifier → engine.transcribe → row → Music lyrics captions', () => {
  it('engine.transcribe carries classification.isMusic into the result (and the no-vocals skip)', async () => {
    const music = await engineWith({ isMusic: true, hasVocals: true }).transcribe(pcm());
    if (music.status !== 'complete') throw new Error('expected a complete result for a music clip with vocals');
    expect(music.music).toBe(true);
    expect((music.transcript as Transcript).segments.flatMap(s => s.words).length).toBeGreaterThan(0);

    const speech = await engineWith({ isMusic: false, hasVocals: true }).transcribe(pcm());
    if (speech.status !== 'complete') throw new Error('expected a complete result for a speech clip');
    expect(speech.music).toBe(false);

    const skipped = await engineWith({ isMusic: true, hasVocals: false }).transcribe(pcm());
    expect(skipped).toMatchObject({ status: 'skipped', transcript: null, reason: 'MUSIC_WITHOUT_VOCALS' });
  });

  it('transcriptionStep copies result.music into the stored TranscriptRow (and the reason on a skip)', async () => {
    const yes = rowOf(await runStep(await engineWith({ isMusic: true, hasVocals: true }).transcribe(pcm())));
    expect(yes).toMatchObject({ status: 'complete', music: true });

    const no = rowOf(await runStep(await engineWith({ isMusic: false, hasVocals: true }).transcribe(pcm())));
    expect(no).toMatchObject({ status: 'complete', music: false });

    const skip = rowOf(await runStep(await engineWith({ isMusic: true, hasVocals: false }).transcribe(pcm())));
    expect(skip).toMatchObject({ status: 'skipped', reason: 'MUSIC_WITHOUT_VOCALS' });
    expect('music' in (skip as object)).toBe(false);                                 // a skip carries the reason, not the flag
  });

  it('the produced row drives the Music button: a music clip gets lyrics captions, a non-music clip gets none', async () => {
    const musicRow = rowOf(await runStep(await engineWith({ isMusic: true, hasVocals: true }).transcribe(pcm())));
    const md = doc(), data = await captionData(store(musicRow), md, () => undefined);
    const res = addCaptionsIn(md, { trackId: 'C1', source: 'music' }, data) as { success: boolean };
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(captions(md).length).toBeGreaterThan(0);

    const speechRow = rowOf(await runStep(await engineWith({ isMusic: false, hasVocals: true }).transcribe(pcm())));
    const sd = doc(), sData = await captionData(store(speechRow), sd, () => undefined);
    const sRes = addCaptionsIn(sd, { trackId: 'C1', source: 'music' }, sData) as { success: boolean; data: RecordData };
    expect(sRes.success).toBe(true);
    expect(captions(sd)).toHaveLength(0);                                             // same transcript, flag false → the Music button adds nothing
  });
});
