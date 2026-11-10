// SPDX-License-Identifier: AGPL-3.0-only
// Caption R1/R1d tool boundaries (results l.618/l.757). Unexpected throws are injected in tests, after a draft write;
// no production failure site is invented. The real bus must discard the whole draft and add no undo entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as captions from '../apps/web/src/captions/properties';
import { createEditor } from '../apps/web/src/timeline/harness';
import { CommandError } from '../apps/web/src/timeline/model';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext } from '../apps/web/src/timeline/tools';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { build, mkItem, mkTrack } from './t03-fixtures';

afterEach(() => vi.restoreAllMocks());
function rig() {
  const doc = build({ tracks: [mkTrack('C1', 'caption')], items: ['a', 'b'].map((id, n) => mkItem(id, 'C1', n * 2000, n * 2000 + 1000,
    { type: 'caption', metadata: { captionMode: 'detached' }, details: { text: id, words: [{ text: id, startMs: 0, endMs: 1000, sourceStartMs: 0, sourceEndMs: 1000 }] } })) });
  const e = createEditor(doc), ctx: ToolContext = { bus: e.bus, asset: () => undefined };
  return { e, call: (tool: string, args: Record<string, unknown>) => callTool(ctx, tool, args) };
}
const partialWrite = (doc: ProjectDocument) => { doc.items[0].details.text = 'partial'; doc.duration += 999; };

describe('T09 unexpected caption failures: exact envelopes and atomic rollback', () => {
  for (const thrown of [new Error('injected failure'), 'injected failure']) {
    it(`editAllCaptionStyles catches ${typeof thrown === 'string' ? 'non-Error' : 'Error'} after a partial draft write as R1 BATCH_UPDATE_FAILED`, () => {
      const r = rig(), before = structuredClone(r.e.doc);
      vi.spyOn(captions, 'editAllCaptionStyles').mockImplementation(doc => { partialWrite(doc); throw thrown; });
      expect(r.call('editAllCaptionStyles', { trackId: 'C1', color: '#FF0000' })).toEqual({ success: false,
        code: 'BATCH_UPDATE_FAILED', error: 'Batch caption update failed', message: 'Failed to update caption styles: injected failure' });
      expect(r.e.doc).toEqual(before); expect(r.e.labels()).toEqual([]);
    });
  }
  for (const [label, ids] of [['single', ['a']], ['batch (first requested id)', ['b', 'a']]] as const) {
    it(`editProperties ${label}: PROPERTY_UPDATE_FAILED throws out of the bus draft and forwards exact top-level details`, () => {
      const r = rig(), before = structuredClone(r.e.doc);
      vi.spyOn(captions, 'editCaptionProperties').mockImplementation(doc => { partialWrite(doc); throw new Error('injected failure'); });
      const args = ids.length === 1 ? { itemId: ids[0], properties: { text: 'changed' } } : { itemIds: [...ids], properties: { text: 'changed' } };
      expect(r.call('editProperties', args)).toEqual({ success: false, code: 'PROPERTY_UPDATE_FAILED', error: 'Property update failed',
        message: 'Failed to update caption: injected failure', details: { agentId: ids[0], error_message: 'injected failure' } });
      expect(r.e.doc).toEqual(before); expect(r.e.labels()).toEqual([]);
    });
  }
  for (const [tool, fn, args] of [
    ['editAllCaptionStyles', 'editAllCaptionStyles', { trackId: 'C1', color: '#FF0000' }],
    ['editProperties', 'editCaptionProperties', { itemId: 'a', properties: { text: 'changed' } }],
  ] as const) {
    it(`${tool}: a typed refusal retains its own code/error/message/details and rolls back`, () => {
      const r = rig(), before = structuredClone(r.e.doc);
      vi.spyOn(captions, fn).mockImplementation((doc: ProjectDocument) => { partialWrite(doc); throw new CommandError('TRACK_LOCKED', 'Track C1 is locked', { message: 'typed refusal', details: { trackId: 'C1' } }); });
      expect(r.call(tool, args)).toEqual({ success: false, code: 'TRACK_LOCKED', error: 'Track C1 is locked', message: 'typed refusal', details: { trackId: 'C1' } });
      expect(r.e.doc).toEqual(before); expect(r.e.labels()).toEqual([]);
    });
  }
});
