// SPDX-License-Identifier: AGPL-3.0-only
// T23 wiring (T23 notes "Boundaries", option (a) agreed with lane G): the 3 tools are served, reach the executor before the
// project check, and the helper refuses bad input with INVALID_TOOL_INPUT; T21's Delete local data wipes memory.
// Oracles: the notes' literal wiring rules and the stored INVALID_TOOL_INPUT envelope. Native executor with no open project.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOLS, validate } from '../apps/helper/src/schemas';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { GUIDE_TOOL_LIST } from '../apps/web/src/agent/guides/schemas';
import { HELP_TOOLS, READ_ONLY, SERVED_TOOLS } from '../apps/web/src/agent/protocol';
import { listMemory, memoryEnabled, setMemoryEnabled, writeMemory } from '../apps/web/src/agent/workspace/memory';
import { ProjectStore, projectStore } from '../apps/web/src/store/database';
import type { GuideContext } from '../apps/web/src/agent/guides/tools';

// R7f: the executor reads the open project from the editor's globals. To get a successful write through the real executor
// and ledger, guideTool alone is wrapped to use this context while it is set; everything below it is the real code.
const bound = vi.hoisted(() => ({ ctx: undefined as unknown }));
vi.mock('../apps/web/src/agent/guides/tools', async importOriginal => {
  const real = await importOriginal<typeof import('../apps/web/src/agent/guides/tools')>();
  return { ...real, guideTool: (tool: string, input: Record<string, unknown>, ctx?: GuideContext) => real.guideTool(tool, input, ctx ?? bound.ctx as GuideContext | undefined) };
});

type Rec = Record<string, any>;
const NAMES = ['getAgentOverview', 'loadSkill', 'workspace'];
const fakeStorage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
let seq = 0;
const call = (toolName: string, input: Rec = {}, key = `mcp:conn:t23-${++seq}`): Call => ({ type: 'call', callId: `c${++seq}`, executionKey: key, toolName, input });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('T23 wiring: served tools', () => {
  it('the 3 names are served; getAgentOverview and loadSkill are read-only help tools, workspace is not', () => {
    for (const n of NAMES) expect(SERVED_TOOLS, n).toContain(n);
    for (const n of ['getAgentOverview', 'loadSkill']) { expect(READ_ONLY.has(n), n).toBe(true); expect(HELP_TOOLS.has(n), n).toBe(true); }
    expect(READ_ONLY.has('workspace')).toBe(false); expect(HELP_TOOLS.has('workspace')).toBe(false);
  });
  it('the helper lists T23\'s 3 schemas unchanged', () => {
    expect(GUIDE_TOOL_LIST.map(t => t.name)).toEqual(NAMES);
    for (const t of GUIDE_TOOL_LIST) expect(TOOLS.find(s => s.name === t.name)).toEqual(t);
  });
});

describe('T23 wiring: the executor answers before the project check', () => {
  const ex = () => new Executor({ storage: fakeStorage(), current: () => undefined });
  it('loadSkill answers and getAgentOverview is PROJECT_FORBIDDEN with no project open', async () => {
    expect(await ex().execute(call('loadSkill', { skillName: 'transitions' }))).toMatchObject({ success: true, content: expect.any(Array) });
    expect(await ex().execute(call('getAgentOverview', {}))).toEqual({ success: false, code: 'PROJECT_FORBIDDEN', error: 'Open a project owned by your signed-in account.' });
    expect(await ex().execute(call('loadSkill', { skillName: 'nope' }))).toMatchObject({ success: false, code: 'CREATIVE_SKILL_NOT_REGISTERED' });
  });
  it('workspace answers with its own code, not PROJECT_UNAVAILABLE, and goes through the ledger', async () => {
    const e = ex(), key = 'mcp:conn:t23-ws';
    const first = await e.execute(call('workspace', { command: 'ls' }, key));
    expect(first).toMatchObject({ success: false, code: 'WORKSPACE_UNAVAILABLE' });
    expect(await e.execute(call('workspace', { command: 'ls' }, key))).toEqual(first);
  });
  it('R7f: replaying one executionKey after a successful write returns the stored result and the version stays', async () => {
    const store = new ProjectStore(crypto.randomUUID(), () => Date.now(), { write: async () => {}, read: async () => { throw new Error('unused'); }, remove: async () => {} });
    const p = await store.create('Ledger');
    await setMemoryEnabled(true, store);
    bound.ctx = { store, projectId: p.id, channel: 'mcp' } satisfies GuideContext;
    try {
      const e = ex(), key = 'mcp:conn:t23-ledger';
      const first = await e.execute(call('workspace', { command: 'write', path: 'memory/a.md', text: 'one' }, key)) as Rec;
      expect(first.success).toBe(true);
      const v = (await listMemory(store))[0].version;
      expect(await e.execute(call('workspace', { command: 'write', path: 'memory/a.md', text: 'one' }, key))).toEqual(first);
      expect((await listMemory(store))[0].version).toBe(v);
      await e.execute(call('workspace', { command: 'write', path: 'memory/a.md', text: 'two' }));
      expect((await listMemory(store))[0].version).toBe(v + 1);
    } finally { bound.ctx = undefined; await store.close(); }
  });
});

describe('T23 wiring: the helper refuses bad input', () => {
  const bad: [string, unknown][] = [
    ['loadSkill', {}], ['loadSkill', { skillName: 3 }], ['loadSkill', { skillName: 'x', extra: true }],
    ['getAgentOverview', { refresh: 'yes' }], ['getAgentOverview', { other: 1 }],
    ['workspace', {}], ['workspace', { command: 'rm' }], ['workspace', { command: 'ls', limit: -1 }], ['workspace', { command: 'cat', maxChars: 1.5 }], ['workspace', { command: 'ls', recursive: true }],
    // R7a: the minimum of limit and maxChars is 1.
    ['workspace', { command: 'ls', limit: 0 }], ['workspace', { command: 'grep', pattern: 'x', limit: 0 }], ['workspace', { command: 'cat', path: 'memory/a.md', maxChars: 0 }],
  ];
  for (const [tool, input] of bad) it(`${tool} ${JSON.stringify(input)} → INVALID_TOOL_INPUT`, () => {
    const r = validate(tool, input) as Rec;
    expect(r).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}` });
    expect(r.details.errors.length).toBeGreaterThan(0);
  });
  it('good input passes', () => {
    for (const [tool, input] of [['loadSkill', { skillName: 'vlog' }], ['getAgentOverview', {}], ['getAgentOverview', { refresh: true }], ['workspace', { command: 'grep', pattern: 'x', limit: 5 }]] as const)
      expect(validate(tool, input), tool).toBeNull();
  });
});

describe('T23 memory: T21\'s Delete local data wipes it', () => {
  it('the switch and the files are gone afterwards', async () => {
    const storage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } }; };
    vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('navigator', { ...globalThis.navigator, storage: { getDirectory: async () => ({ removeEntry: async () => {} }) } });
    await setMemoryEnabled(true); await writeMemory('overview.md', 'Private note.');
    expect(await memoryEnabled()).toBe(true); expect(await listMemory()).toHaveLength(1);
    const { deleteLocalData } = await import('../apps/web/src/settings/local');
    await deleteLocalData();
    expect(await memoryEnabled()).toBe(false); expect(await listMemory()).toEqual([]);
    await projectStore.close();
  });
});
