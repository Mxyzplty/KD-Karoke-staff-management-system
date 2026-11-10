// SPDX-License-Identifier: AGPL-3.0-only
// T05 the executor seam of the agent font path (coordinator ruling Q5, R2 M3): agent/executor.ts wires callTextTool into the
// dispatcher, so the parts callTextTool's own unit tests (t05-agent) cannot reach are tested here against the executor —
//   - a tab/runtime swap while the font loads: executor.ts re-handles the call on the project that is open now, not the one it
//     checked first (the async load is the window in which the user can switch project);
//   - the stale-read gate refuses addText before any font is loaded (a refused call loads nothing);
//   - a non-FontError thrown by the load becomes an `unavailable` result (operationMayHaveRun), not a crash;
//   - a font-loading call runs once through the execution-key ledger (a retransmit returns the stored result, no reload);
//   - a FontError passes through as its FONT_* code with the document and undo stack untouched.
// Oracle: the written contract (notes §7 and the R2 findings) and executor.ts's gate / ledger rules, not the code output.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '../apps/web/src/agent/executor';
import { Executor, NEVER_READ } from '../apps/web/src/agent/executor';
import { createEditor } from '../apps/web/src/timeline/harness';
import type { Runtime } from '../apps/web/src/timeline/runtime';
import { build, mkTrack, resetIds } from './t03-fixtures';

// The fonts module is browser-only (it imports font files); mock the three loaders, keep the real FontError / itemFonts so
// the executor and callTextTool resolve the same faces they would in the app (the t05-agent pattern).
const fonts = vi.hoisted(() => ({ loadFont: vi.fn(), loadChainFonts: vi.fn(), loadUserFonts: vi.fn() }));
vi.mock('../apps/web/src/text/fonts', async orig => ({ ...await orig<typeof import('../apps/web/src/text/fonts')>(), ...fonts }));
import { FontError } from '../apps/web/src/text/font-registry';

beforeEach(() => {
  fonts.loadFont.mockReset().mockResolvedValue(undefined);
  fonts.loadChainFonts.mockReset().mockResolvedValue([]);
  fonts.loadUserFonts.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { resetIds(); });

const textDoc = () => build({ tracks: [mkTrack('O1', 'overlay')] });
const mk = (current: () => Runtime | undefined) => {
  const store = new Map<string, string>();
  return new Executor({ storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } }, current, ui: () => ({ selection: [], playheadMs: 0 }) });
};
let n = 0;
const call = (toolName: string, input: Record<string, unknown>, session = 's1', executionKey = `k${++n}`): Call =>
  ({ type: 'call', callId: `c${n}`, executionKey, toolName, input, session });
const open = async (ex: Executor, session = 's1') => { expect(((await ex.execute(call('context', {}, session))) as { success: boolean }).success).toBe(true); };
const addArgs = { textContent: 'Hi', trackId: 'O1', font: 'Roboto' };
const texts = (e: ReturnType<typeof createEditor>) => e.doc.items.filter(i => (i as { type?: string }).type === 'text');

describe('T05 executor font path (R2 M3, Q5 branch of agent/executor.ts)', () => {
  it('a tab/runtime swap while the font loads re-handles the call on the project open now, not the one checked first', async () => {
    const base = textDoc();
    const a = createEditor(base), b = createEditor(base);            // identical clones: the swap is not a user change, so the gate stays open
    let current: Runtime = a.runtime;
    const ex = mk(() => current);
    await open(ex);                                                  // gate open (on a)
    fonts.loadFont.mockImplementation(async () => { current = b.runtime; }); // the first awaited load switches the open project
    const r = await ex.execute(call('addText', addArgs)) as { success: boolean };
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(texts(a)).toHaveLength(0); expect(a.labels()).toEqual([]);           // nothing landed on the project checked first
    expect(texts(b)).toHaveLength(1); expect(b.labels()).toEqual(['Add items']); // the re-handle ran on the current project
  });

  it('a user edit during the font load fails the in-run re-check: STALE_READ_REFRESHED, nothing added (D34 Minor 1)', async () => {
    const e = createEditor(textDoc());
    const ex = mk(() => e.runtime);                                 // same runtime throughout: no swap, so the re-check runs, not a re-handle
    await open(ex);                                                 // gate open (timeline scope)
    // A real user edit lands during the awaited load, closing the gate the call was checked against before it ran.
    fonts.loadFont.mockImplementation(async () => { e.bus.run('Add track', 'user', doc => { doc.tracks.push(mkTrack('O2', 'overlay')); }); });
    const r = await ex.execute(call('addText', addArgs)) as { success: boolean; code: string; scope: string };
    expect([r.success, r.code]).toEqual([false, 'STALE_READ_REFRESHED']);  // removing the in-run `this.gated(…) ??` re-check makes this the agent's text instead
    expect(r.scope).toBe('timeline');
    expect(texts(e)).toHaveLength(0);                               // the agent landed nothing
    expect(e.labels()).toEqual(['Add track']);                      // only the user's edit is on the stack
  });

  it('the stale-read gate refuses addText before any font is loaded (a refused call loads nothing)', async () => {
    const e = createEditor(textDoc());
    const ex = mk(() => e.runtime);                                  // no context read: the gate is closed
    const r = await ex.execute(call('addText', addArgs)) as { success: boolean; code: string; message: string };
    expect([r.success, r.code]).toEqual([false, 'STALE_READ_REFRESHED']);
    expect(r.message).toBe(NEVER_READ);
    expect(fonts.loadUserFonts).not.toHaveBeenCalled();
    expect(fonts.loadFont).not.toHaveBeenCalled();
    expect(fonts.loadChainFonts).not.toHaveBeenCalled();
    expect(texts(e)).toHaveLength(0); expect(e.labels()).toEqual([]);
  });

  it('a non-FontError thrown by the font load surfaces as an unavailable result (operationMayHaveRun), not a crash', async () => {
    const e = createEditor(textDoc());
    const ex = mk(() => e.runtime);
    await open(ex);
    fonts.loadUserFonts.mockRejectedValueOnce(new Error('boom'));
    const r = await ex.execute(call('addText', addArgs)) as { success: boolean; code: string; error: string; operationMayHaveRun: boolean };
    expect(r.success).toBe(false); expect(r.operationMayHaveRun).toBe(true);
    expect(r.code).toBe('PROJECT_UNAVAILABLE'); expect(r.error).toBe('boom');
    expect(texts(e)).toHaveLength(0); expect(e.labels()).toEqual([]);
  });

  it('a font-loading call runs once through the ledger: a retransmit with the same key returns the stored result, no reload or second item', async () => {
    const e = createEditor(textDoc());
    const ex = mk(() => e.runtime);
    await open(ex);
    const msg = call('addText', addArgs, 's1', 'ek-1');
    const first = await ex.execute(msg) as { success: boolean };
    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(texts(e)).toHaveLength(1);                                // exactly the one real item: the discovery draft left nothing
    expect(e.labels()).toEqual(['Add items']);                       // one undo entry
    const loads = fonts.loadFont.mock.calls.length, users = fonts.loadUserFonts.mock.calls.length;
    const again = await ex.execute({ ...msg, callId: 'c-dup' }) as { success: boolean }; // same executionKey + input
    expect(again).toEqual(first);                                    // the ledger's stored result
    expect(fonts.loadFont.mock.calls.length).toBe(loads);            // the font path did not run again
    expect(fonts.loadUserFonts.mock.calls.length).toBe(users);
    expect(texts(e)).toHaveLength(1); expect(e.labels()).toEqual(['Add items']); // not added twice
  });

  it('a face that cannot load returns FONT_LOAD_FAILED through the executor with the document and undo stack untouched', async () => {
    const e = createEditor(textDoc());
    const ex = mk(() => e.runtime);
    await open(ex);
    fonts.loadFont.mockRejectedValue(new FontError('FONT_LOAD_FAILED', 'blocked'));
    const r = await ex.execute(call('addText', addArgs)) as { success: boolean; code: string; operationMayHaveRun?: boolean };
    expect([r.success, r.code]).toEqual([false, 'FONT_LOAD_FAILED']);
    expect(r.operationMayHaveRun).toBeUndefined();                   // a clean refusal, not an unavailable
    expect(texts(e)).toHaveLength(0); expect(e.labels()).toEqual([]);
  });

  it("a loader FONT_* code passes through unchanged (FONT_DELIVERY_FAILED)", async () => {
    const e = createEditor(textDoc());
    const ex = mk(() => e.runtime);
    await open(ex);
    fonts.loadFont.mockRejectedValue(new FontError('FONT_DELIVERY_FAILED', 'blocked'));
    expect(((await ex.execute(call('addText', addArgs))) as { success: boolean; code: string }).code).toBe('FONT_DELIVERY_FAILED');
  });
});
