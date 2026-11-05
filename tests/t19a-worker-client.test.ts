// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisWorker } from '../apps/web/src/analysis/worker-client';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { AnalysisReply } from '../apps/web/src/analysis/protocol';

afterEach(() => vi.unstubAllGlobals());

it('codes a postMessage clone failure and accepts the next request', async () => {
  class StubWorker {
    onmessage?: (event: MessageEvent<AnalysisReply>) => void;
    postMessage = vi.fn().mockImplementationOnce(() => { throw new DOMException('The request could not be cloned.', 'DataCloneError'); });
    terminate = vi.fn();
  }
  const native = new StubWorker();
  vi.stubGlobal('Worker', class { constructor() { return native; } });
  const worker = new AnalysisWorker();
  const error = await worker.run({ task: 'remove', assetId: 'first' }).catch(error => error);
  expect(error).toBeInstanceOf(AnalysisError);
  expect(error).toMatchObject({ code: 'ANALYSIS_FAILED', message: 'The request could not be cloned.' });

  const next = worker.run({ task: 'remove', assetId: 'second' });
  expect(native.postMessage.mock.calls[1][0]).toMatchObject({ id: 2, request: { task: 'remove', assetId: 'second' } });
  const reply: AnalysisReply = { id: 2, ok: true, value: null, elapsedMs: 0, backends: {} };
  native.onmessage!({ data: reply } as MessageEvent<AnalysisReply>);
  await expect(next).resolves.toEqual(reply);
  worker.close();
  expect(native.terminate).toHaveBeenCalledOnce();
});
