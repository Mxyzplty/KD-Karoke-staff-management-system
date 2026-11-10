// SPDX-License-Identifier: AGPL-3.0-only
// M11: model-free font-delivery and stale-document checks through the real Executor.
import { beforeEach, expect, it, vi } from 'vitest';
import { Executor, type Call } from '../apps/web/src/agent/executor';
import { FontError } from '../apps/web/src/text/font-registry';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, mkTrack } from './t03-fixtures';
const fonts = vi.hoisted(() => ({ loadFont: vi.fn(), loadChainFonts: vi.fn(), loadUserFonts: vi.fn() }));
vi.mock('../apps/web/src/text/fonts', async orig => ({ ...await orig<typeof import('../apps/web/src/text/fonts')>(), ...fonts }));
beforeEach(() => { fonts.loadFont.mockReset().mockResolvedValue(undefined); fonts.loadChainFonts.mockReset().mockResolvedValue([]); fonts.loadUserFonts.mockReset().mockResolvedValue(undefined); });
let n = 0;
const call = (toolName: string, input: Record<string, unknown>): Call => ({ type: 'call', callId: `c${++n}`, executionKey: `k${n}`, toolName, input, session: 's' });
function rig() {
  const p = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
  const e = createEditor(build({ tracks: [mkTrack('C1', 'caption')], items: ['cap1', 'cap2'].map((id, n) => ({ id, type: 'caption', trackId: 'C1', display: { from: n * 2000, to: n * 2000 + 1500 }, effects: [], masks: [], metadata: { captionMode: 'detached' },
    details: { text: 'hello', words: [{ text: 'hello', startMs: 0, endMs: 1000 }], fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' }, properties: { fontSize: p(65), fontWeight: p('700'), width: p(400), height: p(120) } })) }));
  const storage = new Map<string, string>();
  const ex = new Executor({ storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } }, current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
  return { e, ex };
}
for (const tool of ['editProperties', 'editAllCaptionStyles']) {
  const args = tool === 'editProperties' ? { itemId: 'cap1', properties: { fontFamily: 'Open Sans' }, applyToAll: true } : { trackId: 'C1', fontFamily: 'Open Sans' };
  it(`M11 ${tool}: refused FONT_* leaves complete document/history unchanged`, async () => {
    const { e, ex } = rig(); await ex.execute(call('context', {})); const before = structuredClone(e.doc);
    fonts.loadFont.mockRejectedValue(new FontError('FONT_LOAD_FAILED', 'blocked'));
    expect(await ex.execute(call(tool, args))).toMatchObject({ success: false, code: 'FONT_LOAD_FAILED' });
    expect(fonts.loadFont).toHaveBeenCalled(); expect(e.doc).toEqual(before); expect(e.labels()).toEqual([]);
  });
  it(`M11 ${tool}: successful delivery covers both affected captions before one undoable edit`, async () => {
    const { e, ex } = rig(); await ex.execute(call('context', {})); const before = structuredClone(e.doc);
    expect(await ex.execute(call(tool, args))).toMatchObject({ success: true });
    expect(fonts.loadFont).toHaveBeenCalledTimes(2);
    expect(e.doc.items.every(i => i.details.fontFamilyDisplay === 'Open Sans')).toBe(true);
    expect(e.labels()).toEqual(['Edit items']); e.bus.undo(); expect(e.doc).toEqual(before);
  });
  it(`M11 ${tool}: user changes during delivery prevent a stale font draft from committing`, async () => {
    const { e, ex } = rig(); await ex.execute(call('context', {}));
    fonts.loadFont.mockImplementationOnce(async () => { e.bus.run('Edit items', 'user', d => { d.items[0].details.text = 'user correction'; }); });
    expect(await ex.execute(call(tool, args))).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED' });
    expect(e.doc.items[0].details.text).toBe('user correction');
    expect(e.doc.items.every(i => i.details.fontFamilyDisplay === 'Roboto')).toBe(true);
    expect(e.labels()).toEqual(['Edit items']);
  });
}
