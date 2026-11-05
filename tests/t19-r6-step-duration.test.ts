// SPDX-License-Identifier: AGPL-3.0-only
// T19 review fix R6b: analysisStep on a video whose probe gave no duration (null or 0) is treated like a still: one frame
// at t = 0, a describe request with duration 1, the step ends 'complete' (it must not throw INVALID_ANALYSIS_INPUT, which
// prepareAsset would turn into GEMINI_FAILED). Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/media/worker-client', () => ({ runWorker: vi.fn(), browserSteps: vi.fn() }));

import { analysisService } from '../apps/web/src/analysis/service';
import { analysisStep, frameTimes } from '../apps/web/src/analysis/steps';
import { runWorker } from '../apps/web/src/media/worker-client';
import type { AnalysisArgs } from '../apps/web/src/media/prepare';
import type { Asset } from '../apps/web/src/store/model';

afterEach(() => { vi.restoreAllMocks(); vi.mocked(runWorker).mockReset(); });

const video = (durationMs: number | null) => ({ container: 'mp4', mimeType: 'video/mp4', durationMs, video: { displayWidth: 640, displayHeight: 360 }, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null });
const args = (info: Record<string, unknown>): AnalysisArgs => ({ blob: new Blob(['synthetic']), asset: { id: 'x', name: 'x', type: 'video' } as Asset, info: info as never, signal: new AbortController().signal, results: {} });
function rig() {
  vi.spyOn(analysisService, 'available').mockResolvedValue({ analysis: true, transcription: true, embeddings: true, beats: true });
  const frame = { timestamp: 0, width: 4, height: 4, data: new Uint8ClampedArray(64) };
  vi.mocked(runWorker).mockResolvedValue([frame] as never);
  // Like the real service: a describe request with a duration below the model's minimum is refused.
  const request = vi.spyOn(analysisService, 'request').mockImplementation(async (req: any) => {
    if (req.task === 'describe' && !(req.duration > 0)) throw Object.assign(new Error('Invalid analysis input.'), { code: 'INVALID_ANALYSIS_INPUT' });
    return { summary: 'a test picture' } as never;
  });
  return { request, frame };
}

describe('T19 R6b analysisStep: a video without a usable duration is treated like a still', () => {
  it.each([null, 0])('durationMs %s: frames at [0], describe duration 1, step complete', async durationMs => {
    const { request } = rig();
    const outcome = await analysisStep(args(video(durationMs)));
    expect(outcome).toMatchObject({ state: 'complete', puts: [{ store: 'analyses', value: { id: 'x', analysis: { summary: 'a test picture', width: 640, height: 360 } } }] });
    expect(vi.mocked(runWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runWorker).mock.calls[0][0]).toMatchObject({ op: 'frames', times: [0] });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ task: 'describe', duration: 1 });
  });
  it('control: a video with a duration still uses the frame schedule and the real duration', async () => {
    const { request } = rig();
    expect(await analysisStep(args(video(6000)))).toMatchObject({ state: 'complete' });
    expect(vi.mocked(runWorker).mock.calls[0][0]).toMatchObject({ op: 'frames', times: frameTimes(6) });
    expect(request.mock.calls[0][0]).toMatchObject({ task: 'describe', duration: 6 });
  });
});
