// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger row 5: the execution-key ledger (agent tool results A0.2 item 1). Strings are the spec's, written out here.
import { describe, expect, it } from 'vitest';
import { fingerprint, Ledger } from '../apps/web/src/agent/ledger';

const LEDGER_STORAGE_KEY = 'cutframe:tool-execution-ledger:v1';
const COLLISION = { success: false, code: 'TOOL_EXECUTION_KEY_COLLISION', error: 'This tool execution key was already used for different input, so the operation was not run.' };
const UNKNOWN = { success: false, code: 'TOOL_EXECUTION_STATE_UNKNOWN', error: 'This operation started previously but its result was not recorded. It was not repeated to avoid a duplicate edit.' };

/** sessionStorage stand-in. */
function fakeStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe('t18a ledger (row 5)', () => {
  it('row 5: same key and same input runs once; the second call returns the stored result', async () => {
    const ledger = new Ledger(fakeStorage());
    let runs = 0;
    const exec = () => ({ success: true, data: { n: ++runs } });
    const first = await ledger.run('mcp:c1:call1', 'moveItem', { itemId: 'v1', by: 1 }, exec);
    const second = await ledger.run('mcp:c1:call1', 'moveItem', { itemId: 'v1', by: 1 }, exec);
    expect(runs).toBe(1);
    expect(first).toEqual({ success: true, data: { n: 1 } });
    expect(second).toEqual({ success: true, data: { n: 1 } });
  });

  it('row 5: concurrent duplicates share one execution', async () => {
    const ledger = new Ledger(fakeStorage());
    const gate = deferred<{ success: boolean; data: number }>();
    let runs = 0;
    const exec = () => { runs++; return gate.promise; };
    const a = ledger.run('k', 'splitItem', { itemId: 'v1', timestampS: 1 }, exec);
    const b = ledger.run('k', 'splitItem', { itemId: 'v1', timestampS: 1 }, exec);
    gate.resolve({ success: true, data: 7 });
    expect(await a).toEqual({ success: true, data: 7 });
    expect(await b).toEqual({ success: true, data: 7 });
    expect(runs).toBe(1);
  });

  it('row 5: same key with different input → TOOL_EXECUTION_KEY_COLLISION, exec not run', async () => {
    const ledger = new Ledger(fakeStorage());
    let runs = 0;
    const exec = () => ({ success: true, n: ++runs });
    await ledger.run('k', 'moveItem', { itemId: 'v1', by: 1 }, exec);
    expect(await ledger.run('k', 'moveItem', { itemId: 'v1', by: 2 }, exec)).toEqual(COLLISION);
    expect(runs).toBe(1);
  });

  it('row 5: same key with a different tool → TOOL_EXECUTION_KEY_COLLISION', async () => {
    const ledger = new Ledger(fakeStorage());
    let runs = 0;
    const exec = () => ({ success: true, n: ++runs });
    await ledger.run('k', 'moveItem', { itemId: 'v1' }, exec);
    expect(await ledger.run('k', 'trimItem', { itemId: 'v1' }, exec)).toEqual(COLLISION);
    expect(runs).toBe(1);
  });

  it('row 5: a collision is also reported while the first call is still running', async () => {
    const ledger = new Ledger(fakeStorage());
    const gate = deferred<{ success: boolean }>();
    const first = ledger.run('k', 'moveItem', { itemId: 'v1' }, () => gate.promise);
    expect(await ledger.run('k', 'moveItem', { itemId: 'v2' }, () => ({ success: true }))).toEqual(COLLISION);
    gate.resolve({ success: true });
    await first;
  });

  it('row 5: a persisted entry without a result (reload mid-call) → TOOL_EXECUTION_STATE_UNKNOWN, exec not run', async () => {
    const storage = fakeStorage();
    const before = new Ledger(storage);
    void before.run('mcp:c1:call9', 'deleteItems', { itemIds: ['v1'] }, () => new Promise(() => {})); // never answers: the tab "reloads"
    const entries = JSON.parse(storage.data.get(LEDGER_STORAGE_KEY)!);
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBeUndefined();

    const after = new Ledger(storage); // a new page over the same session storage
    let runs = 0;
    const result = await after.run('mcp:c1:call9', 'deleteItems', { itemIds: ['v1'] }, () => { runs++; return { success: true }; });
    expect(result).toEqual(UNKNOWN);
    expect(runs).toBe(0);
  });

  it('row 5: a completed entry survives a reload and is returned without running', async () => {
    const storage = fakeStorage();
    await new Ledger(storage).run('k', 'moveItem', { itemId: 'v1' }, () => ({ success: true, data: { moved: true } }));
    let runs = 0;
    const result = await new Ledger(storage).run('k', 'moveItem', { itemId: 'v1' }, () => { runs++; return { success: true }; });
    expect(result).toEqual({ success: true, data: { moved: true } });
    expect(runs).toBe(0);
  });

  it('row 5: the input fingerprint ignores object key order at every level', async () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: [{ y: 1, x: 2 }] } })).toBe(fingerprint({ b: { d: [{ x: 2, y: 1 }], c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1])); // array order still matters
    const ledger = new Ledger(fakeStorage());
    let runs = 0;
    const exec = () => ({ success: true, n: ++runs });
    await ledger.run('k', 'manageTrack', { action: 'create', kind: 'video' }, exec);
    expect(await ledger.run('k', 'manageTrack', { kind: 'video', action: 'create' }, exec)).toEqual({ success: true, n: 1 });
    expect(runs).toBe(1);
  });

  it('row 5: only the last 250 are kept in session storage (the 251st evicts the first)', async () => {
    const storage = fakeStorage();
    const ledger = new Ledger(storage);
    for (let n = 0; n < 250; n++) await ledger.run(`key-${n}`, 'moveItem', { n }, () => ({ success: true, n }));
    let stored = JSON.parse(storage.data.get(LEDGER_STORAGE_KEY)!) as { key: string }[];
    expect(stored).toHaveLength(250);
    expect(stored[0].key).toBe('key-0');

    await ledger.run('key-250', 'moveItem', { n: 250 }, () => ({ success: true, n: 250 }));
    stored = JSON.parse(storage.data.get(LEDGER_STORAGE_KEY)!);
    expect(stored).toHaveLength(250);
    expect(stored[0].key).toBe('key-1');
    expect(stored[249].key).toBe('key-250');
    expect(stored.map(e => e.key)).not.toContain('key-0');

    // The evicted key is forgotten: it runs again instead of returning a stored result.
    let runs = 0;
    await ledger.run('key-0', 'moveItem', { n: 0 }, () => { runs++; return { success: true }; });
    expect(runs).toBe(1);
    // A kept key still answers from the ledger.
    await ledger.run('key-100', 'moveItem', { n: 100 }, () => { runs++; return { success: true }; });
    expect(runs).toBe(1);
  });

  it('row 5: the ledger is stored under cutframe:tool-execution-ledger:v1 with tool, fingerprint and result', async () => {
    const storage = fakeStorage();
    await new Ledger(storage).run('mcp:c:1', 'splitItem', { timestampS: 1, itemId: 'v1' }, () => ({ success: true, data: { leftItemId: 'a' } }));
    expect([...storage.data.keys()]).toEqual([LEDGER_STORAGE_KEY]);
    expect(JSON.parse(storage.data.get(LEDGER_STORAGE_KEY)!)).toEqual([
      { key: 'mcp:c:1', tool: 'splitItem', fingerprint: '{"itemId":"v1","timestampS":1}', result: { success: true, data: { leftItemId: 'a' } } },
    ]);
  });
});
