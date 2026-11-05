// SPDX-License-Identifier: AGPL-3.0-only
// T19 C1: Background Jobs rows count the T19 steps toward progress (preparationJobs).
import { describe, expect, it } from 'vitest';
import type { Asset, ProcessingStep } from '../apps/web/src/store/model';
import { preparationJobs } from '../apps/web/src/editor/overlays';

const asset = (steps: Record<string, ProcessingStep>, over: Partial<Asset> = {}): Asset => ({ id: 'a', name: 'clip.mp4', type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId: null, created_at: '2026-11-02T00:00:00.000Z', recorded_at: null, location: null, durationMs: 1000,
  processing_status: 'processing', processing_steps: steps, last_error_code: null, last_error_message: null, ...over });
const T14 = { upload: 'complete', probe: 'complete', thumbnails: 'complete', waveform: 'complete', proxy: 'complete' } as Record<string, ProcessingStep>;
const t19 = (analysis: ProcessingStep, transcription: ProcessingStep, d: ProcessingStep, t: ProcessingStep) => ({ analysis, transcription, embeddings_description: d, embeddings_transcript: t });
const job = (steps: Record<string, ProcessingStep>, over: Partial<Asset> = {}) => preparationJobs([asset(steps, over)], () => false)[0];

describe('T19 C1 preparationJobs', () => {
  it('T19 steps count toward progress: nine known steps, five done → 5/9', () => {
    expect(job({ ...T14, ...t19('processing', 'pending', 'pending', 'pending') }).progress).toBeCloseTo(5 / 9);
    expect(job({ ...T14, ...t19('complete', 'processing', 'pending', 'pending') }).progress).toBeCloseTo(6 / 9);
  });
  it('complete, skipped, unavailable and failed T19 steps all count as done', () => {
    for (const state of ['complete', 'skipped', 'unavailable', 'failed'] as ProcessingStep[]) expect(job({ ...T14, ...t19(state, state, state, state), proxy: 'processing' }).progress).toBeCloseTo(8 / 9);
    expect(job({ ...T14, ...t19('complete', 'skipped', 'unavailable', 'failed'), proxy: 'processing' }).progress).toBeCloseTo(8 / 9);
    expect(job({ ...T14, ...t19('complete', 'skipped', 'unavailable', 'failed') }).progress).toBe(1);
  });
  it('a pending T19 step is not done; a failed T14 step still is not', () => {
    expect(job({ ...T14, ...t19('complete', 'complete', 'complete', 'pending') }).progress).toBeCloseTo(8 / 9);
    expect(job({ ...T14, thumbnails: 'failed', ...t19('complete', 'complete', 'complete', 'complete') }).progress).toBeCloseTo(8 / 9);
  });
  it('an asset without T19 steps (recorded before T19) keeps T14 progress over five steps', () => {
    expect(job({ ...T14, proxy: 'processing' }).progress).toBeCloseTo(4 / 5);
    expect(job({ upload: 'complete' }).progress).toBe(1);
  });
  it('the detail reads "Analysis, transcription and search index" while a T19 step is processing', () => {
    for (const [i, name] of ['analysis', 'transcription', 'embeddings_description', 'embeddings_transcript'].entries()) {
      const steps = { ...T14, ...t19('complete', 'complete', 'complete', 'complete'), [name]: 'processing' as ProcessingStep };
      expect(job(steps).detail, `${i}`).toBe('Analysis, transcription and search index');
    }
    expect(job({ ...T14, ...t19('pending', 'pending', 'pending', 'pending') }).detail).toBe('Thumbnails, waveform and proxy');
    expect(job({ ...T14, proxy: 'processing' }).detail).toBe('Thumbnails, waveform and proxy');
  });
  it('the job stays running with a Cancel only when this tab runs it', () => {
    const steps = { ...T14, ...t19('processing', 'pending', 'pending', 'pending') };
    expect(preparationJobs([asset(steps)], () => true)[0]).toMatchObject({ state: 'running', label: 'Preparing clip.mp4', cancel: expect.any(Function) });
    expect(preparationJobs([asset(steps)], () => false)[0]).toMatchObject({ state: 'running', cancel: undefined });
  });
  it('a ready asset (even with a T19 failure code) has no job row; a failed asset shows its code', () => {
    expect(preparationJobs([asset({ ...T14, ...t19('failed', 'complete', 'complete', 'complete') }, { processing_status: 'ready', last_error_code: 'GEMINI_FAILED' })], () => false)).toEqual([]);
    expect(job({ ...T14, ...t19('complete', 'processing', 'pending', 'pending') }, { processing_status: 'failed', last_error_code: 'CLIENT_PREPARATION_TIMEOUT' })).toMatchObject({ state: 'failed', detail: 'CLIENT_PREPARATION_TIMEOUT' });
  });
});
