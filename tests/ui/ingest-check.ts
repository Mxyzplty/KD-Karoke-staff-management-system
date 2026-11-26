// SPDX-License-Identifier: AGPL-3.0-only
// T19a audit F1 (lane A, 11:31): ingest completeness for the heavy UI specs. openAndIngest (t16a-support.ts) waits for
// processing_status 'ready' or 'failed'; an asset can be 'ready' with a failed step and an error code (media/prepare.ts: a step
// that failed or ran out of time, the proxy's failure kept at 'ready' while the original is still usable). No Playwright import:
// tests/t19a-ingest-complete.test.ts loads this under vitest.
//
// Contract of preparationProblems(asset): one string per problem, in this order, [] when there is none.
//   1. `status: <processing_status>` when processing_status is not 'ready' (absent: `status: missing`).
//   2. For each key of STEP_KEYS, in that order, whose processing_steps value is not 'complete':
//      `step <key>: <value>` (absent: `step <key>: missing`). 'skipped' and 'unavailable' are problems too. Other keys are ignored.
//   3. `code: <last_error_code>` when last_error_code is neither null nor absent.
import type { AssetMedia } from '../../apps/web/src/store/model';

/** The steps media/prepare.ts records, in the order they run. */
export const STEP_KEYS = ['upload', 'probe', 'thumbnails', 'waveform', 'proxy', 'analysis', 'transcription', 'embeddings_description', 'embeddings_transcript'] as const;

export function preparationProblems(_asset: Pick<AssetMedia, 'processing_status' | 'processing_steps' | 'last_error_code'>): string[] {
  return []; // red-first stub (no check): the implementer replaces this body with the contract above
}
