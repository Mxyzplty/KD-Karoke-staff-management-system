// SPDX-License-Identifier: AGPL-3.0-only
// T19a audit F1 (lane A, 11:31): the heavy UI specs refuse an ingested asset that is 'ready' with a step not 'complete' or an
// error code (tests/ui/ingest-check.ts, its contract in the header). The rule is every step 'complete', as lane A ruled:
// 'skipped' and 'unavailable' do not pass. Assets are written as media/prepare.ts records them (step keys, codes from
// media/codes.ts).
import { expect, it } from 'vitest';
import type { ProcessingStep } from '../apps/web/src/store/model';
import { STEP_KEYS, preparationProblems } from './ui/ingest-check';

/** Every step 'complete', then the given states. */
const steps = (over: Partial<Record<(typeof STEP_KEYS)[number], ProcessingStep>> = {}): Record<string, ProcessingStep> =>
  ({ ...Object.fromEntries(STEP_KEYS.map(k => [k, 'complete' as ProcessingStep])), ...over });

it('a: ready, every step complete, no code: no problem', () => {
  expect(preparationProblems({ processing_status: 'ready', processing_steps: steps(), last_error_code: null })).toEqual([]);
});

it('b: ready with analysis failed (GEMINI_FAILED, prepare.ts T19 steps): names the step and the code', () => {
  expect(preparationProblems({ processing_status: 'ready', processing_steps: steps({ analysis: 'failed' }), last_error_code: 'GEMINI_FAILED' }))
    .toEqual(['step analysis: failed', 'code: GEMINI_FAILED']);
});

it('c: ready with both search-index steps failed (EMBEDDING_FAILED): names both, in key order, and the code', () => {
  expect(preparationProblems({ processing_status: 'ready', processing_steps: steps({ embeddings_transcript: 'failed', embeddings_description: 'failed' }), last_error_code: 'EMBEDDING_FAILED' }))
    .toEqual(['step embeddings_description: failed', 'step embeddings_transcript: failed', 'code: EMBEDDING_FAILED']);
});

it('d: ready with a step still processing, no code: names the step', () => {
  expect(preparationProblems({ processing_status: 'ready', processing_steps: steps({ transcription: 'processing' }), last_error_code: null }))
    .toEqual(['step transcription: processing']);
});

it('e: ready, every step complete, a code kept (ENCODE_FAILED, codes.ts:31; prepare.ts:43, :224-226): names the code', () => {
  // A steps-only check passes this asset.
  expect(preparationProblems({ processing_status: 'ready', processing_steps: steps(), last_error_code: 'ENCODE_FAILED' }))
    .toEqual(['code: ENCODE_FAILED']);
});

it('f: failed as prepare.ts failed() writes it (a step processing turned failed, later ones pending): status, steps, code', () => {
  expect(preparationProblems({ processing_status: 'failed', processing_steps: steps({ probe: 'failed', thumbnails: 'pending', waveform: 'pending', proxy: 'pending', analysis: 'pending', transcription: 'pending', embeddings_description: 'pending', embeddings_transcript: 'pending' }), last_error_code: 'DECODE_ERROR' }))
    .toEqual(['status: failed', 'step probe: failed', 'step thumbnails: pending', 'step waveform: pending', 'step proxy: pending', 'step analysis: pending',
      'step transcription: pending', 'step embeddings_description: pending', 'step embeddings_transcript: pending', 'code: DECODE_ERROR']);
});

// Review F1 (t19a-f1-bound-review, lane A 11:58): steps() builds all nine keys, so a-f pass a deny-list check and one that walks
// processing_steps instead of STEP_KEYS; g-i do not.
it('g: ready with analysis unavailable and embeddings_transcript skipped: both are problems', () => {
  expect(preparationProblems({ processing_status: 'ready', processing_steps: steps({ analysis: 'unavailable', embeddings_transcript: 'skipped' }), last_error_code: null }))
    .toEqual(['step analysis: unavailable', 'step embeddings_transcript: skipped']);
});

it('h: ready with the proxy key absent and a key outside STEP_KEYS: names proxy as missing, ignores the other key', () => {
  const s = { ...steps(), foo: 'failed' as ProcessingStep };
  delete s.proxy; // absent, not undefined
  expect(preparationProblems({ processing_status: 'ready', processing_steps: s, last_error_code: null })).toEqual(['step proxy: missing']);
});

it('i: the empty asset: status and every step missing, in key order, no code', () => {
  expect(preparationProblems({})).toEqual(['status: missing', ...STEP_KEYS.map(k => `step ${k}: missing`)]);
});
